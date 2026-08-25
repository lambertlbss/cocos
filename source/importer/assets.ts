import { createHash } from 'crypto';
import type { SpriteAssetSpec } from '../types';

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
    subMetas: Record<string, {
        importer: string;
        uuid: string;
        userData: Record<string, unknown>;
    }>;
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

async function queryAsset(value: string): Promise<AssetInfo | null> {
    return await Editor.Message.request(
        'asset-db',
        'query-asset-info',
        value,
        ['subAssets'],
    ) as AssetInfo | null;
}

async function waitForAsset(url: string): Promise<AssetInfo> {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
        const info = await queryAsset(url);
        if (info?.invalid) {
            throw new Error(`Cocos 资源导入失败：${url}`);
        }
        if (info?.imported && findSpriteFrame(info)) {
            return info;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`等待 Cocos 资源导入超时：${url}`);
}

async function ensureFolder(url: string): Promise<void> {
    const existing = await queryAsset(url);
    if (existing) {
        return;
    }
    await Editor.Message.request('asset-db', 'create-asset', url, null);
}

export class AssetWriter {
    readonly folder: string;

    constructor(folder: string) {
        this.folder = normalizeFolder(folder);
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
        let info = await queryAsset(url);
        let spriteFrame = info ? findSpriteFrame(info) : null;
        if (!info?.imported || info.invalid || !spriteFrame) {
            return null;
        }
        let meta = await Editor.Message.request(
            'asset-db',
            'query-asset-meta',
            info.uuid,
        ) as AssetMeta | null;
        if (tiled && meta && await this.applySpriteMeta(info, meta, undefined, true)) {
            info = await waitForAsset(url);
            spriteFrame = findSpriteFrame(info);
            meta = await Editor.Message.request(
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

    async write(
        url: string,
        contents: Buffer | string,
        borders?: { left: number; right: number; top: number; bottom: number },
        tiled = false,
    ): Promise<SpriteAssetSpec> {
        const existing = await queryAsset(url);
        const data = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
        if (existing) {
            await Editor.Message.request('asset-db', 'save-asset', url, data);
        } else {
            await Editor.Message.request('asset-db', 'create-asset', url, data, { overwrite: true });
        }
        let info = await waitForAsset(url);
        const sliced = !tiled && Boolean(borders && Object.values(borders).some((value) => value > 0));
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', info.uuid) as AssetMeta | null;
        const spriteBorders = sliced
            ? borders
            : (!tiled && hasSlicedBorders(meta)
                ? { left: 0, right: 0, top: 0, bottom: 0 }
                : undefined);
        if (meta && await this.applySpriteMeta(info, meta, spriteBorders, tiled)) {
            info = await waitForAsset(url);
        }
        const spriteFrame = findSpriteFrame(info);
        if (!spriteFrame) {
            throw new Error(`资源没有生成 SpriteFrame：${url}`);
        }
        return { uuid: spriteFrame.uuid, url, sliced, tiled: tiled || undefined };
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
        await Editor.Message.request('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(meta, null, 2));
        await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
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
