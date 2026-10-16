import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { diagnosticTask } from '../diagnostics';
import type { SpriteAssetSpec } from '../types';
import { isPng, prepareNewRaster } from './raster-format';

export type RasterImageExtension = 'png' | 'jpg' | 'webp' | 'gif' | 'bmp';

export const RASTER_IMAGE_EXTENSIONS: readonly RasterImageExtension[] = [
    'png',
    'jpg',
    'webp',
    'gif',
    'bmp',
];

interface AssetInfo {
    uuid: string;
    url: string;
    importer: string;
    type: string;
    imported: boolean;
    invalid: boolean;
    subAssets?: Record<string, AssetInfo>;
}

interface AssetMeta {
    uuid: string;
    userData: Record<string, unknown>;
    subMetas: Record<string, {
        importer: string;
        uuid: string;
        userData: Record<string, unknown>;
    }>;
}

export interface AssetResolveOptions {
    /** Include the Figma file ID, node/source ID and rendering variant. Never just a node name. */
    sourceKey: string;
    borders?: { left: number; right: number; top: number; bottom: number };
    tiled?: boolean;
    refresh?: boolean;
}

export interface AssetLookupOptions {
    tiled?: boolean;
    sliced?: boolean;
    borders?: AssetResolveOptions['borders'];
}

export interface AssetResolutionEvent {
    sourceKey?: string;
    url: string;
    action: 'reused' | 'created' | 'updated' | 'fallback';
    reason: string;
}

interface SourceIdentity {
    version: 1;
    contentHash: string;
    inputHash?: string;
    config: string;
    sources: Record<string, number>;
    /** Exclusive source update journal; never a successful reusable mapping. */
    pending?: { sourceKey: string; inputHash: string; contentHash: string; config: string };
}

const assetLocks = new Map<string, Promise<unknown>>();
const assetIndexVersions = new Map<string, number>();
const hash = (input: Buffer | string) => createHash('sha256').update(input).digest('hex');
const normalized = (input: string) => input.normalize('NFKC').toLocaleLowerCase('en-US');

async function locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = assetLocks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(task);
    assetLocks.set(key, pending);
    try { return await pending; }
    finally { if (assetLocks.get(key) === pending) assetLocks.delete(key); }
}

function configKey(borders?: AssetResolveOptions['borders'], tiled = false): string {
    return JSON.stringify(tiled ? ['tiled'] : ['sprite', ...(['left', 'right', 'top', 'bottom'] as const)
        .map((side) => Math.max(0, Math.round(borders?.[side] ?? 0)))]);
}

function storedConfig(meta: AssetMeta | null, tiled = false): string {
    const data = Object.values(meta?.subMetas ?? {}).find((item) => item.importer === 'sprite-frame')?.userData;
    return configKey(data ? { left: Number(data.borderLeft) || 0, right: Number(data.borderRight) || 0,
        top: Number(data.borderTop) || 0, bottom: Number(data.borderBottom) || 0 } : undefined, tiled);
}

function validConfiguration(meta: AssetMeta | null, tiled: boolean): boolean {
    const data = Object.values(meta?.subMetas ?? {}).find((item) => item.importer === 'sprite-frame')?.userData;
    if (!data) return false;
    if (tiled) return data.trimType === 'none' && data.packable === false && !hasSlicedBorders(meta);
    return !hasSlicedBorders(meta) || data.trimType === 'none';
}

function identityFrom(meta: AssetMeta | null): SourceIdentity | undefined {
    const identity = meta?.userData?.figmaImporter as SourceIdentity | undefined;
    return identity?.version === 1 && typeof identity.contentHash === 'string' && /^[0-9a-f]{64}$/.test(identity.contentHash)
        && typeof identity.config === 'string' && identity.sources && typeof identity.sources === 'object'
        && Object.entries(identity.sources).every(([key, value]) => /^[0-9a-f]{64}$/.test(key)
            && typeof value === 'number' && Number.isFinite(value) && value > 0)
        ? identity : undefined;
}

export function hasSlicedBorders(meta: AssetMeta | null | undefined): boolean {
    const spriteMeta = Object.values(meta?.subMetas ?? {})
        .find((item) => item.importer === 'sprite-frame');
    return ['borderLeft', 'borderRight', 'borderTop', 'borderBottom']
        .some((key) => {
            const value = spriteMeta?.userData?.[key];
            return typeof value === 'number' && Number.isFinite(value) && value > 0;
        });
}

function normalizeFolder(input: string): string {
    const value = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!value || value === '.' || value.split('/').some((part) => !part || part === '..')) {
        throw new Error('资源目录无效。');
    }
    if (value.startsWith('assets/')) {
        return value.slice('assets/'.length);
    }
    if (value.startsWith('db://')) {
        throw new Error('资源目录请填写 assets 下的相对路径。');
    }
    return value;
}

export function sanitizeAssetName(input: string): string {
    let value = input
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*#%\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[. ]+|[. ]+$/g, '')
        .slice(0, 72);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        value = `_${value}`;
    }
    return value || 'figma_node';
}

export function detectImageExtension(contents: Buffer): RasterImageExtension {
    if (contents.length >= 8
        && contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (contents.length >= 3
        && contents[0] === 0xff
        && contents[1] === 0xd8
        && contents[2] === 0xff) {
        return 'jpg';
    }
    if (contents.length >= 12
        && contents.subarray(0, 4).toString('ascii') === 'RIFF'
        && contents.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'webp';
    }
    const header = contents.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') {
        return 'gif';
    }
    if (contents.length >= 2 && contents[0] === 0x42 && contents[1] === 0x4d) {
        return 'bmp';
    }
    throw new Error('Figma 原始平铺图片格式无法识别；当前支持 PNG、JPEG、WebP、GIF 和 BMP。');
}

function assetBaseName(name: string): string {
    return sanitizeAssetName(name).replace(/\.(png|jpe?g|webp|gif|bmp|svg)$/i, '');
}

function findSpriteFrame(info: AssetInfo): AssetInfo | null {
    const queue: AssetInfo[] = [info];
    while (queue.length) {
        const item = queue.shift()!;
        if (item.importer === 'sprite-frame' || item.type === 'cc.SpriteFrame') {
            return item;
        }
        queue.push(...Object.values(item.subAssets ?? {}));
    }
    return null;
}

function assetRequest(channel: string, method: string, ...args: any[]): Promise<any> {
    // Log only the target, never image contents or serialized metadata.
    return diagnosticTask(`Cocos 资源 ${method}`, { target: args[0] },
        () => Editor.Message.request(channel, method, ...args));
}

async function queryAsset(value: string): Promise<AssetInfo | null> {
    return await assetRequest(
        'asset-db',
        'query-asset-info',
        value,
        ['subAssets'],
    ) as AssetInfo | null;
}

async function waitForAsset(url: string, requireSpriteFrame = true, knownUuid?: string): Promise<AssetInfo> {
    const started = Date.now();
    let lastInfo: AssetInfo | null = null;
    while (Date.now() - started < 30_000) {
        let info = await queryAsset(url);
        if (!info && knownUuid) info = await queryAsset(knownUuid);
        lastInfo = info;
        if (info?.invalid) {
            throw new Error(`Cocos 资源导入失败：${url}`);
        }
        if (info?.imported) {
            if (!requireSpriteFrame || findSpriteFrame(info)) return info;
            const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
            const frame = Object.values(meta?.subMetas ?? {}).find((item) => item.importer === 'sprite-frame');
            if (frame?.uuid) return { ...info, subAssets: { ...info.subAssets,
                persistedFrame: { ...info, uuid: frame.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (lastInfo?.imported && requireSpriteFrame) {
        throw new Error(`Cocos 已导入图片但未能生成 SpriteFrame：${url}`);
    }
    throw new Error(`等待 Cocos 图片资源导入超时：${url}`);
}

async function ensureSpriteFrame(url: string, info: AssetInfo): Promise<AssetInfo> {
    if (findSpriteFrame(info)) {
        return info;
    }
    const meta = await assetRequest(
        'asset-db',
        'query-asset-meta',
        info.uuid,
    ) as AssetMeta | null;
    if (!meta) {
        throw new Error(`无法读取 Cocos 图片资源 Meta：${url}`);
    }
    const persistedFrame = Object.values(meta.subMetas ?? {}).find((item) => item.importer === 'sprite-frame');
    if (persistedFrame?.uuid) return { ...info, subAssets: { ...info.subAssets,
        persistedFrame: { ...info, uuid: persistedFrame.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
    meta.userData = meta.userData ?? {};
    if (meta.userData.type !== 'sprite-frame') {
        meta.userData.type = 'sprite-frame';
        await assetRequest(
            'asset-db',
            'save-asset-meta',
            info.uuid,
            JSON.stringify(meta, null, 2),
        );
    }
    await assetRequest('asset-db', 'reimport-asset', info.uuid);
    return waitForAsset(url, true, info.uuid);
}

async function ensureFolder(url: string): Promise<void> {
    const existing = await queryAsset(url);
    if (existing) {
        return;
    }
    await assetRequest('asset-db', 'create-asset', url, null);
}

export class AssetWriter {
    readonly folder: string;
    readonly events: AssetResolutionEvent[] = [];
    private readonly writeTargets = new Map<string, string>();
    private indexPromise?: Promise<void>;
    private indexVersion = -1;
    private readonly indexed = new Map<string, AssetMeta>();

    constructor(folder: string, private readonly beforeWrite?: (url: string, existed: boolean) => Promise<void>) {
        this.folder = normalizeFolder(folder);
    }

    private get projectRoot(): string | undefined {
        return typeof Editor !== 'undefined' && Editor.Project?.path ? resolve(Editor.Project.path) : undefined;
    }

    private pathFor(url: string): string | undefined {
        const root = this.projectRoot;
        if (!root) return undefined;
        if (!url.startsWith('db://assets/') || /[\u0000?#]/.test(url)) throw new Error(`资源地址无效：${url}`);
        const path = resolve(root, url.slice('db://'.length));
        const suffix = relative(join(root, 'assets'), path);
        if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error(`资源地址超出项目 assets：${url}`);
        return path;
    }

    private async diskMeta(url: string): Promise<AssetMeta | null> {
        const path = this.pathFor(url);
        if (!path) return null;
        try { return JSON.parse(await readFile(`${path}.meta`, 'utf8')) as AssetMeta; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error(`无法读取已有资源 Meta，不会覆盖：${url}；${String(error)}`);
        }
    }

    private async contentsAt(url: string): Promise<Buffer | null> {
        const path = this.pathFor(url);
        if (!path) return null;
        try { return await readFile(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }

    private async indexAssets(): Promise<void> {
        const root = this.projectRoot;
        if (!root) return;
        const currentVersion = assetIndexVersions.get(root) ?? 0;
        if (this.indexPromise && this.indexVersion === currentVersion) return this.indexPromise;
        this.indexVersion = currentVersion;
        this.indexed.clear();
        const scan = async (folder: string): Promise<void> => {
            const entries = await readdir(folder, { withFileTypes: true });
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const path = join(folder, entry.name);
                // Hidden directories/assets participate exactly like visible ones.
                // Do not follow directory symlinks outside the project.
                if (entry.isDirectory()) await scan(path);
                else if (entry.isFile() && /\.(png|jpe?g|webp|gif|bmp|svg)\.meta$/i.test(entry.name)) {
                    const url = `db://${relative(root, path.slice(0, -5)).replace(/\\/g, '/')}`;
                    const meta = await this.diskMeta(url);
                    if (meta) this.indexed.set(url, meta);
                }
            }
        };
        this.indexPromise = scan(join(root, 'assets')).catch((error) => {
            this.indexPromise = undefined;
            this.indexed.clear();
            throw error;
        });
        return this.indexPromise;
    }

    private async availableInfo(url: string): Promise<AssetInfo | null> {
        let info = await queryAsset(url);
        if (!info) {
            const meta = await this.diskMeta(url);
            if (meta?.uuid) info = await queryAsset(meta.uuid);
            if (!info && (meta || await this.contentsAt(url))) {
                throw new Error(`已有资源尚未被 Cocos 资源数据库识别，请等待导入完成后重试，不会另建副本：${url}`);
            }
        }
        if (info?.invalid) throw new Error(`Cocos 资源无效，不会覆盖其 Meta：${url}`);
        if (info && !info.imported) info = await waitForAsset(info.url || url, false, info.uuid);
        return info;
    }

    async existingForSource(sourceKey: string, options?: AssetLookupOptions): Promise<SpriteAssetSpec | null> {
        return locked(this.projectRoot ?? this.folder, async () => {
            await this.indexAssets();
            const key = hash(sourceKey);
            const candidates = [...this.indexed.entries()].filter(([, meta]) => identityFrom(meta)?.sources[key]);
            candidates.sort((a, b) => (identityFrom(b[1])!.sources[key] - identityFrom(a[1])!.sources[key])
                || a[0].localeCompare(b[0]));
            for (const [url] of candidates) {
                const meta = await this.diskMeta(url) ?? this.indexed.get(url)!;
                const identity = identityFrom(meta);
                const contents = await this.contentsAt(url);
                if (!identity || identity.pending || !contents || hash(contents) !== identity.contentHash) continue;
                const tiled = identity.config === configKey(undefined, true);
                if (options?.tiled !== undefined && options.tiled !== tiled) continue;
                if (options?.sliced !== undefined && options.sliced !== hasSlicedBorders(meta)) continue;
                if (options?.borders && identity.config !== configKey(options.borders, options.tiled)) continue;
                if (identity.config !== storedConfig(meta, tiled) || !validConfiguration(meta, tiled)) continue;
                const asset = await this.existing(url, tiled);
                if (asset) {
                    this.events.push({ sourceKey: key, url: asset.url, action: 'reused', reason: '源标识、内容、SpriteFrame UUID 与切片配置均已验证' });
                    return asset;
                }
            }
            return null;
        });
    }

    async resolve(url: string, contents: Buffer | string, options: AssetResolveOptions): Promise<SpriteAssetSpec> {
        return locked(this.projectRoot ?? this.folder, async () => {
            if (!options.sourceKey.trim()) throw new Error('资源源标识不能为空。');
            await this.indexAssets();
            const sourceKey = hash(options.sourceKey);
            const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
            const inputHash = hash(bytes);
            let jpegHash: string | undefined;
            const config = configKey(options.borders, options.tiled);
            const mapped = [...this.indexed.entries()].filter(([, meta]) => identityFrom(meta)?.sources[sourceKey]);
            mapped.sort((a, b) => identityFrom(b[1])!.sources[sourceKey] - identityFrom(a[1])!.sources[sourceKey]);
            const named = [...this.indexed.keys()].filter((candidate) => normalized(basename(candidate, extname(candidate)))
                === normalized(basename(url, extname(url))));
            const candidates = [...new Set([...mapped.map(([candidate]) => candidate), url,
                ...(/\.png$/i.test(url) ? [url.replace(/\.png$/i, '.jpg'), url.replace(/\.png$/i, '.jpeg')] : []), ...named])];
            let ownUpdate: string | undefined;
            for (const candidate of candidates) {
                const info = await this.availableInfo(candidate);
                if (!info) continue;
                const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
                const identity = identityFrom(meta);
                const stored = await this.contentsAt(candidate);
                const pendingOwned = identity?.pending?.sourceKey === sourceKey
                    && Object.keys(identity.sources).length === 1;
                const verified = stored && (!identity || hash(stored) === identity.contentHash
                    || (pendingOwned && hash(stored) === identity.pending!.contentHash));
                if (verified && /\.jpe?g$/i.test(candidate) && isPng(bytes) && !identity?.inputHash && !jpegHash) {
                    const prepared = prepareNewRaster(bytes);
                    if (prepared.extension === 'jpg') jpegHash = hash(prepared.contents);
                }
                const sameContents = verified && (hash(stored!) === inputHash || identity?.inputHash === inputHash
                    || (jpegHash && hash(stored!) === jpegHash));
                const sameConfig = config === storedConfig(meta, options.tiled)
                    && (!identity || identity.config === config)
                    && validConfiguration(meta, Boolean(options.tiled))
                    && (!options.tiled || identity?.config === config);
                if (sameContents && sameConfig) {
                    const asset = await this.existing(candidate, options.tiled);
                    if (asset) {
                        await this.bindIdentity(candidate, info, meta, sourceKey, inputHash, config, hash(stored!));
                        this.events.push({ sourceKey, url: candidate, action: 'reused', reason: identity?.sources[sourceKey]
                            ? '源映射命中，内容与切片配置一致' : '同名资源内容与切片配置一致，已绑定源标识' });
                        return asset;
                    }
                }
                if (identity?.sources[sourceKey] && Object.keys(identity.sources).length === 1 && verified
                    && (!/\.jpe?g$/i.test(candidate) || !isPng(bytes) || prepareNewRaster(bytes).extension === 'jpg')) {
                    ownUpdate ??= candidate;
                }
            }
            // Only an exclusively owned source may update pixels/metadata in place.
            // A shared or legacy asset always keeps its valid references and bytes.
            let target = ownUpdate ?? url;
            let existed = Boolean(await this.availableInfo(target));
            let isolated = false;
            if (!ownUpdate && !existed && /\.png$/i.test(target) && prepareNewRaster(bytes).extension === 'jpg') {
                target = target.replace(/\.png$/i, '.jpg');
                existed = Boolean(await this.availableInfo(target));
            }
            if (!ownUpdate && existed) {
                isolated = true;
                const extension = extname(target);
                target = `${target.slice(0, -extension.length)}__${hash(`${inputHash}:${config}`).slice(0, 12)}${extension}`;
                existed = Boolean(await this.availableInfo(target));
                if (existed) {
                    const stored = await this.contentsAt(target);
                    const info = await this.availableInfo(target);
                    const meta = info ? await assetRequest('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null : null;
                    if (!stored || (hash(stored) !== inputHash && identityFrom(meta)?.inputHash !== inputHash)
                        || storedConfig(meta, options.tiled) !== config || !validConfiguration(meta, Boolean(options.tiled))) {
                        throw new Error(`资源变体地址被不同内容或切片配置占用，不会覆盖：${target}`);
                    }
                    const asset = await this.existing(target, options.tiled);
                    if (asset && info) {
                        await this.bindIdentity(target, info, meta, sourceKey, inputHash, config, hash(stored));
                        this.events.push({ sourceKey, url: target, action: 'reused', reason: '重试命中已创建的稳定变体，保留原 UUID' });
                        return asset;
                    }
                }
            }
            if (ownUpdate) await this.beginUpdate(ownUpdate, bytes, sourceKey, inputHash, config);
            const writeBorders = ownUpdate && !options.tiled && !options.borders
                ? { left: 0, right: 0, top: 0, bottom: 0 } : options.borders;
            // resolve already selected a verified destination. A legacy write's
            // PNG→JPG alias must not redirect a different source/alpha variant.
            this.writeTargets.delete(target);
            const asset = await this.write(target, bytes, writeBorders, options.tiled);
            const info = await this.availableInfo(asset.url);
            if (!info) throw new Error(`无法确认资源 UUID：${asset.url}`);
            const meta = await assetRequest('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
            const stored = await this.contentsAt(asset.url);
            // A failed inset save still produced this source's image. Bind the
            // actual stored configuration so the sliced writer can restore its
            // full PNG in place, rather than leaving an unowned compact copy.
            // A later sliced lookup must still reject the unverified borders.
            const boundConfig = asset.sliceFallback ? storedConfig(meta, Boolean(options.tiled)) : config;
            await this.bindIdentity(asset.url, info, meta, sourceKey, inputHash, boundConfig, hash(stored ?? bytes));
            this.events.push({ sourceKey, url: asset.url, action: asset.sliceFallback ? 'fallback' : existed ? 'updated' : 'created',
                reason: asset.sliceFallback ?? (ownUpdate ? '同源资源独占，原位更新并保留 UUID 与 Meta'
                    : isolated ? '同名内容或切片配置冲突，创建稳定变体并保留已有资源' : '未找到内容及切片配置相符的已有资源') });
            return asset;
        });
    }

    private async beginUpdate(url: string, bytes: Buffer, sourceKey: string, inputHash: string, config: string): Promise<void> {
        const info = await this.availableInfo(url);
        const meta = info ? await assetRequest('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null : null;
        const identity = identityFrom(meta);
        if (!info || !meta || !identity?.sources[sourceKey] || Object.keys(identity.sources).length !== 1) {
            throw new Error(`资源源映射已发生变化，无法安全原位更新：${url}`);
        }
        const stored = await this.contentsAt(url);
        if (!stored || (hash(stored) !== identity.contentHash && hash(stored) !== identity.pending?.contentHash)) {
            throw new Error(`资源内容已在导入期间变化，无法安全原位更新：${url}`);
        }
        const prepared = /\.jpe?g$/i.test(url) && isPng(bytes) ? prepareNewRaster(bytes).contents : bytes;
        const next = JSON.parse(JSON.stringify(meta)) as AssetMeta;
        const pending = { sourceKey, inputHash, contentHash: hash(prepared), config };
        next.userData.figmaImporter = { ...identity, pending } satisfies SourceIdentity;
        await this.beforeWrite?.(url, true);
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(next, null, 2));
        this.indexed.set(url, next);
    }

    private async bindIdentity(url: string, info: AssetInfo, meta: AssetMeta | null, sourceKey: string,
        inputHash: string, config: string, contentHash: string): Promise<void> {
        if (!meta) throw new Error(`无法持久化资源源标识：${url}`);
        if (meta.uuid && meta.uuid !== info.uuid) throw new Error(`资源 UUID 与 Meta 不一致，不会写入源映射：${url}`);
        const previous = identityFrom(meta);
        if (previous?.sources[sourceKey] && !previous.pending && previous.inputHash === inputHash && previous.config === config
            && previous.contentHash === contentHash) { this.indexed.set(url, meta); return; }
        await this.beforeWrite?.(url, true);
        const next = JSON.parse(JSON.stringify(meta)) as AssetMeta;
        next.userData ??= {};
        const latestRevision = Math.max(0, ...[...this.indexed.values()]
            .map((item) => identityFrom(item)?.sources[sourceKey] ?? 0));
        next.userData.figmaImporter = { version: 1, contentHash, inputHash, config,
            sources: { ...(previous?.sources ?? {}), [sourceKey]: Math.max(Date.now(), latestRevision + 1) } } satisfies SourceIdentity;
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(next, null, 2));
        // Index only after successful persistence. A failed bind can safely retry
        // by comparing the file's content/config without a source record.
        this.indexed.set(url, next);
        if (this.projectRoot) {
            const version = (assetIndexVersions.get(this.projectRoot) ?? 0) + 1;
            assetIndexVersions.set(this.projectRoot, version);
            this.indexVersion = version;
        }
    }

    async initialize(): Promise<void> {
        let current = 'db://assets';
        for (const part of this.folder.split('/')) {
            current += `/${part}`;
            await ensureFolder(current);
        }
    }

    buildUrl(name: string, _id: string, extension: RasterImageExtension, _scale: number): string {
        const fileName = assetBaseName(name);
        return `db://assets/${this.folder}/${fileName}.${extension}`;
    }

    buildTiledUrl(name: string, sourceKey: string, extension: RasterImageExtension): string {
        const sourceHash = createHash('sha256').update(sourceKey).digest('hex').slice(0, 10);
        return `db://assets/${this.folder}/${assetBaseName(name)}__tile_${sourceHash}.${extension}`;
    }

    async existing(url: string, tiled = false): Promise<SpriteAssetSpec | null> {
        let info = await this.availableInfo(url);
        if (!info?.imported || info.invalid) {
            return null;
        }
        let meta = await assetRequest(
            'asset-db',
            'query-asset-meta',
            info.uuid,
        ) as AssetMeta | null;
        // AssetDB can omit subAssets while indexing. A persisted SpriteFrame
        // remains an existing asset; do not infer absence from UI visibility.
        let spriteFrame = findSpriteFrame(info);
        const frameMeta = Object.values(meta?.subMetas ?? {}).find((item) => item.importer === 'sprite-frame');
        if (spriteFrame && frameMeta?.uuid && frameMeta.uuid !== spriteFrame.uuid) {
            throw new Error(`SpriteFrame UUID 与 Meta 不一致，请等待 Cocos 重导入完成：${url}`);
        }
        if (!spriteFrame) {
            if (frameMeta?.uuid) spriteFrame = { ...info, uuid: frameMeta.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' };
        }
        if (!spriteFrame) return null;
        if (tiled && meta && await this.applySpriteMeta(info, meta, undefined, true)) {
            info = await waitForAsset(url, true, info.uuid);
            spriteFrame = findSpriteFrame(info);
            meta = await assetRequest(
                'asset-db',
                'query-asset-meta',
                info.uuid,
            ) as AssetMeta | null;
        }
        if (!spriteFrame) {
            return null;
        }
        return {
            uuid: spriteFrame.uuid,
            url,
            sliced: hasSlicedBorders(meta),
            tiled: tiled || undefined,
        };
    }

    async existingRaster(url: string, tiled = false, nodeName = url): Promise<SpriteAssetSpec | null> {
        if (!/\.(png|jpe?g)$/i.test(url)) return this.existing(url, tiled);
        const named = nodeName.match(/\.(png|jpe?g)$/i)?.[1].toLowerCase();
        const extensions = Array.from(new Set([...(named ? [named] : []), 'png', 'jpg', 'jpeg']));
        for (const extension of extensions) {
            const candidate = url.replace(/\.(png|jpe?g)$/i, `.${extension}`);
            const asset = tiled ? await this.existing(candidate, true) : await this.existing(candidate);
            if (asset) return asset;
        }
        return null;
    }

    async write(
        url: string,
        contents: Buffer | string,
        borders?: { left: number; right: number; top: number; bottom: number },
        tiled = false,
    ): Promise<SpriteAssetSpec> {
        const requestedUrl = url;
        url = this.writeTargets.get(url) ?? url;
        let existing = await this.availableInfo(url);
        let data = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
        if (!existing && /\.png$/i.test(url)) {
            const prepared = prepareNewRaster(data);
            if (prepared.extension === 'jpg') {
                const jpegUrl = url.replace(/\.png$/i, '.jpg');
                // Repeated imports normally reuse this file before reaching write.
                // A forced refresh must update it in place, preserving its UUID.
                existing = await this.availableInfo(jpegUrl);
                url = jpegUrl;
                data = prepared.contents;
            }
        } else if (/\.jpe?g$/i.test(url) && isPng(data)) {
            const prepared = prepareNewRaster(data);
            if (prepared.extension !== 'jpg') throw new Error(`不能将透明 PNG 或转换失败的图片写入 JPG：${url}`);
            data = prepared.contents;
        }
        this.writeTargets.set(requestedUrl, url);
        await this.beforeWrite?.(url, Boolean(existing));
        if (existing) {
            await assetRequest('asset-db', 'save-asset', url, data);
        } else {
            await assetRequest('asset-db', 'create-asset', url, data, { overwrite: false });
        }
        let info = await waitForAsset(url, false, existing?.uuid);
        info = await ensureSpriteFrame(url, info);
        const requestedSliced = !tiled
            && Boolean(borders && Object.values(borders).some((value) => value > 0));
        let meta: AssetMeta | null = null;
        let sliceFallback: string | undefined;
        try {
            meta = await assetRequest(
                'asset-db',
                'query-asset-meta',
                info.uuid,
            ) as AssetMeta | null;
            if (meta && await this.applySpriteMeta(
                info,
                meta,
                borders,
                tiled,
            )) {
                info = await waitForAsset(url, true, info.uuid);
                meta = await assetRequest(
                    'asset-db',
                    'query-asset-meta',
                    info.uuid,
                ) as AssetMeta | null;
            }
        } catch (error) {
            if (!requestedSliced) {
                throw error;
            }
            // The PNG and its SpriteFrame already exist. A border metadata
            // failure must not discard the entire Prefab import; fail closed
            // to a normal SIMPLE Sprite and expose the reason to the panel.
            meta = null;
            sliceFallback = error instanceof Error ? error.message : String(error);
        }
        // Existing SpriteFrames can already carry valid borders even when this
        // write does not request new ones. Preserve that sliced classification.
        const stored = meta?.subMetas && Object.values(meta.subMetas)
            .find((item) => item.importer === 'sprite-frame')?.userData;
        const exactBorders = !requestedSliced || (stored?.trimType === 'none'
            && ['left', 'right', 'top', 'bottom'].every((side) => {
                const key = side as keyof NonNullable<typeof borders>;
                return stored[`border${side[0].toUpperCase()}${side.substring(1)}`]
                    === Math.max(0, Math.round(borders![key]));
            }));
        const sliced = !tiled && hasSlicedBorders(meta) && exactBorders;
        if (requestedSliced && !sliced && !sliceFallback) {
            sliceFallback = `Cocos 未能写入或回读三/九宫 SpriteFrame 边界：${url}`;
        }
        const spriteFrame = findSpriteFrame(info);
        if (!spriteFrame) {
            throw new Error(`资源没有生成 SpriteFrame：${url}`);
        }
        return {
            uuid: spriteFrame.uuid,
            url,
            sliced,
            sliceFallback,
            tiled: tiled || undefined,
        };
    }

    private async applySpriteMeta(
        info: AssetInfo,
        meta: AssetMeta,
        borders: { left: number; right: number; top: number; bottom: number } | undefined,
        tiled: boolean,
    ): Promise<boolean> {
        if (!meta.subMetas) {
            return false;
        }
        const spriteMeta = Object.values(meta.subMetas).find((item) => item.importer === 'sprite-frame');
        if (!spriteMeta) {
            return false;
        }
        const changes: Record<string, unknown> = {};
        if (borders) {
            Object.assign(changes, {
                trimType: 'none',
                borderLeft: Math.max(0, Math.round(borders.left)),
                borderRight: Math.max(0, Math.round(borders.right)),
                borderTop: Math.max(0, Math.round(borders.top)),
                borderBottom: Math.max(0, Math.round(borders.bottom)),
            });
        }
        if (tiled) {
            Object.assign(changes, {
                trimType: 'none',
                packable: false,
                borderLeft: 0,
                borderRight: 0,
                borderTop: 0,
                borderBottom: 0,
            });
        }
        const changed = Object.entries(changes)
            .some(([key, value]) => spriteMeta.userData[key] !== value);
        if (!changed) {
            return false;
        }
        Object.assign(spriteMeta.userData, changes);
        await assetRequest('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(meta, null, 2));
        await assetRequest('asset-db', 'reimport-asset', info.uuid);
        return true;
    }
}

export async function resolveAssetUuid(value: string): Promise<string | undefined> {
    const input = value.trim();
    if (!input) {
        return undefined;
    }
    const info = await queryAsset(input);
    return info?.uuid;
}
