import { createHash, randomBytes } from 'crypto';
import { readFile, realpath, mkdir, writeFile, stat } from 'fs/promises';
import { resolve, relative, isAbsolute, join } from 'path';
import {
    diffReviewNodes, validateRemovalSelection,
    type ImportReview, type ReviewAsset, type ReviewScene,
} from '../import-review-model';
import type { DocumentSession, FigmaNode, SpriteAssetSpec } from '../types';
import { normalizeCocosUuid } from '../roundtrip/uuid';
import { analyzeSliceGrid } from '../figma/slicing';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
type Request = (method: string, ...args: any[]) => Promise<any>;
interface RecordedAsset {
    existed: boolean;
    before?: string;
    hash?: string;
    metaHash?: string;
    imageUuid?: string;
    relatedUuids?: string[];
    path?: string;
}

async function assetPath(url: string): Promise<string> {
    if (!url.startsWith('db://assets/') || /[?#\u0000]/.test(url)) throw new Error('资源地址无效。');
    const root = await realpath(resolve(Editor.Project.path, 'assets'));
    const path = await realpath(resolve(Editor.Project.path, url.slice('db://'.length)));
    const suffix = relative(root, path);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new Error('资源路径超出项目 assets。');
    return path;
}

function thumbnail(data: Buffer): string | undefined {
    try {
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromBuffer(data);
        if (image.isEmpty()) return undefined;
        const size = image.getSize();
        return image.resize({ width: Math.min(480, size.width) }).toDataURL();
    } catch { return undefined; }
}

/** One import's journal. A download/cache hit is not proof that an asset is new. */
export class ImportReviewRecorder {
    private beforePreviewBytes = 0;
    readonly id = randomBytes(18).toString('hex');
    readonly records = new Map<string, RecordedAsset>();
    readonly bindings = new Map<string, { asset: SpriteAssetSpec; node: FigmaNode; source: string }>();

    async beforeWrite(url: string, existedInDatabase: boolean): Promise<void> {
        if (this.records.has(url)) return;
        const record: RecordedAsset = { existed: existedInDatabase };
        try {
            const path = await assetPath(url);
            record.existed = true;
            if (this.beforePreviewBytes < 24 * 1024 * 1024 && (await stat(path)).size <= 16 * 1024 * 1024) {
                record.before = thumbnail(await readFile(path));
                this.beforePreviewBytes += record.before?.length ?? 0;
            }
        } catch (error) {
            // Only a missing file can establish creation; permission/path failures must stop the write.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.records.set(url, record);
    }

    bind(node: FigmaNode, asset: SpriteAssetSpec, source: string): void {
        this.bindings.set(node.id, { node, asset, source });
    }
}

/** Explain only actual sliced imports, not every unmapped/ignored descendant. */
export function buildReviewSourceTree(
    roots: FigmaNode[], recorder: Pick<ImportReviewRecorder, 'bindings'>, after: ReviewScene,
): ImportReview['sourceTree'] {
    const targets = new Map(after.nodes.flatMap((node) => node.figmaIds.map((id) => [id, node] as const)));
    const result: ImportReview['sourceTree'] = [];
    type Merge = NonNullable<ImportReview['sourceTree'][number]['sliceMerge']>;
    const visit = (node: FigmaNode, depth: number, inherited?: Merge) => {
        const target = targets.get(node.id);
        const merge = target ? undefined : inherited;
        result.push({ id: node.id, name: node.name, depth, type: node.type, visible: node.visible !== false,
            ...(merge ? { sliceMerge: merge } : {}) });
        const asset = recorder.bindings.get(node.id)?.asset;
        const renderedAsSlice = target && asset?.sliced && !asset.tiled && !asset.sliceFallback
            && target.components.some((component) => component.type.replace(/^cc\./, '') === 'Sprite'
                && component.properties.type === 1 && typeof component.properties.spriteFrame === 'string'
                && normalizeCocosUuid(component.properties.spriteFrame) === normalizeCocosUuid(asset.uuid));
        const analysis = renderedAsSlice ? analyzeSliceGrid(node) : null;
        const childMerge = analysis && target
            ? { mode: analysis.mode, sourceId: node.id, targetName: target.name } : merge;
        // Direct invisible pieces do not participate in the analyzed grid/export.
        node.children.forEach((child) => visit(child, depth + 1, child.visible !== false ? childMerge : undefined));
    };
    roots.forEach((node) => visit(node, 0));
    return result;
}

export class ImportReviewService {
    private review?: ImportReview;
    private recorder?: ImportReviewRecorder;
    private document?: DocumentSession;
    private previewCache = new Map<string, string>();
    private applying = false;
    constructor(
        private assetRequest: Request = (method, ...args) => Editor.Message.request('asset-db', method, ...args),
        private sceneRequest: Request = (method, ...args) => Editor.Message.request('scene', method, ...args),
    ) {}

    get(): ImportReview | null { return this.review ?? null; }
    invalidate(): void { this.review = undefined; this.recorder = undefined; this.document = undefined; this.previewCache.clear(); }

    async complete(recorder: ImportReviewRecorder, document: DocumentSession,
        before: ReviewScene, after: ReviewScene, targetUrl?: string, warnings: string[] = [], readOnlyReason?: string): Promise<ImportReview> {
        const assets = new Map<string, ReviewAsset>();
        for (const binding of recorder.bindings.values()) {
            const { asset, node, source } = binding;
            let entry = assets.get(asset.url);
            if (!entry) {
                const record = recorder.records.get(asset.url);
                entry = { id: asset.url, uuid: asset.uuid, url: asset.url, name: asset.url.split('/').pop()!,
                    state: record ? (record.existed ? 'updated' : 'new') : 'reused',
                    sources: [], figmaIds: [], nodeNames: [], canRemove: false, hasBefore: Boolean(record?.before) };
                assets.set(asset.url, entry);
                if (readOnlyReason) entry.reason = `本次结果仅供查看：${readOnlyReason}`;
                if (!readOnlyReason && entry.state === 'new' && record) {
                    try {
                        record.path = await assetPath(asset.url);
                        const [data, meta, info] = await Promise.all([readFile(record.path), readFile(`${record.path}.meta`),
                            this.assetRequest('query-asset-info', asset.url)]);
                        if (!info?.uuid) throw new Error('无法核实图片 UUID');
                        record.hash = digest(data);
                        record.metaHash = digest(meta);
                        record.imageUuid = info.uuid;
                        const parsedMeta = JSON.parse(meta.toString('utf8'));
                        record.relatedUuids = [info.uuid, asset.uuid, ...Object.values(parsedMeta.subMetas ?? {})
                            .map((item: any) => item.uuid).filter((uuid): uuid is string => typeof uuid === 'string')];
                        entry.canRemove = Boolean(after.targetUuid);
                        if (!entry.canRemove) entry.reason = '请先保存场景为资源，再重新导入以启用删除。';
                    } catch (error) { entry.reason = `无法核实新建资源：${(error as Error).message}`; }
                }
            }
            if (!entry.sources.includes(source)) entry.sources.push(source);
            entry.figmaIds.push(node.id);
        }
        // Actual consumers, including overflow/tiled helpers and folded source aliases.
        for (const asset of assets.values()) {
            asset.nodeNames = after.nodes.filter((node) => node.components.some((component) =>
                Object.values(component.properties).some((value) => typeof value === 'string'
                    && normalizeCocosUuid(value) === normalizeCocosUuid(asset.uuid)))).map((node) => node.name);
        }
        // Fallback needs no live Scene, database, file reads or slicing analysis.
        const sourceTree: ImportReview['sourceTree'] = [];
        if (readOnlyReason) {
            const visit = (node: FigmaNode, depth: number) => {
                sourceTree.push({ id: node.id, name: node.name, depth, type: node.type, visible: node.visible !== false });
                node.children.forEach((child) => visit(child, depth + 1));
            };
            document.roots.forEach((node) => visit(node, 0));
        } else sourceTree.push(...buildReviewSourceTree(document.roots, recorder, after));
        this.previewCache.clear();
        this.recorder = recorder;
        this.document = document;
        this.review = { id: recorder.id, createdAt: new Date().toISOString(), fileName: document.fileName,
            targetUrl, assets: [...assets.values()].sort((a, b) => Number(b.state === 'new') - Number(a.state === 'new')),
            before, after, sourceTree, changes: diffReviewNodes(before.nodes, after.nodes), warnings, confirmed: false, readOnlyReason };
        return this.review;
    }

    private requireReview(id: string): ImportReview {
        if (!this.review || id !== this.review.id || !this.recorder) throw new Error('检查结果已过期，请重新导入。');
        return this.review;
    }

    source(id: string, assetId: string, nodeId: string): { fileKey: string; node: FigmaNode } {
        const asset = this.requireReview(id).assets.find((item) => item.id === assetId);
        const node = this.document?.nodeById.get(nodeId);
        if (!asset?.figmaIds.includes(nodeId) || !node) throw new Error('Figma 节点不属于本次资源。');
        return { fileKey: this.document!.fileKey, node };
    }

    async preview(id: string, assetId: string): Promise<{ before?: string; after?: string }> {
        const review = this.requireReview(id);
        const asset = review.assets.find((item) => item.id === assetId);
        if (!asset) throw new Error('资源不属于本次导入。');
        let after = this.previewCache.get(assetId);
        if (!after && asset.state !== 'deleted') {
            const path = await assetPath(asset.url);
            if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('图片超过 32 MB，请在资源面板查看。');
            after = thumbnail(await readFile(path));
            if (after) this.previewCache.set(assetId, after);
        }
        return { before: this.recorder!.records.get(asset.url)?.before, after };
    }

    private script(method: string, payload: any): Promise<any> {
        return this.sceneRequest('execute-scene-script', { name: 'figma-importer-cocos', method, args: [payload] });
    }

    private async assertUsers(asset: ReviewAsset, targetUuid?: string): Promise<void> {
        const record = this.recorder!.records.get(asset.url)!;
        for (const uuid of new Set(record.relatedUuids ?? [asset.uuid, record.imageUuid!])) {
            const users = await this.assetRequest('query-asset-users', uuid, 'all');
            if (!Array.isArray(users)) throw new Error(`无法检查资源引用：${asset.name}`);
            for (const user of users) {
                if (targetUuid && normalizeCocosUuid(user) === normalizeCocosUuid(targetUuid)) continue;
                const info = await this.assetRequest('query-asset-info', user);
                if (targetUuid && info?.uuid && normalizeCocosUuid(info.uuid) === normalizeCocosUuid(targetUuid)) continue;
                // Image and SpriteFrame subassets may reference one another.
                if (record.relatedUuids?.some((uuid) => normalizeCocosUuid(uuid) === normalizeCocosUuid(info?.uuid ?? user))) continue;
                throw new Error(`“${asset.name}”被其他资源引用：${info?.url ?? user}。请保留该资源。`);
            }
        }
    }

    async apply(id: string, selectedIds: unknown): Promise<ImportReview> {
        const review = this.requireReview(id);
        if (this.applying) throw new Error('正在执行确认修改，请稍候。');
        const selected = validateRemovalSelection(review, selectedIds);
        if (!selected.length) { review.confirmed = true; return review; }
        this.applying = true;
        let detached = false;
        let saved = false;
        try {
            const payload = { id, uuids: [...new Set(selected.flatMap((asset) =>
                this.recorder!.records.get(asset.url)?.relatedUuids ?? [asset.uuid]))] };
            await this.script('prepareReviewRemoval', payload);
            const target = await this.assetRequest('query-asset-info', review.after.targetUuid);
            if (!target?.url || !/\.(prefab|scene)$/.test(target.url)) throw new Error('目标场景/预制体尚未保存，无法安全删除资源。');
            const backupFolder = join(Editor.Project.path, 'temp', 'figma-importer', 'review-backups', id);
            const staged: Array<{ asset: ReviewAsset; data: Buffer; meta: Buffer }> = [];
            for (const asset of selected) {
                const record = this.recorder!.records.get(asset.url)!;
                const path = await assetPath(asset.url);
                const [data, meta, info] = await Promise.all([readFile(path), readFile(`${path}.meta`),
                    this.assetRequest('query-asset-info', asset.url)]);
                if (path !== record.path || digest(data) !== record.hash || digest(meta) !== record.metaHash
                    || info?.uuid !== record.imageUuid) throw new Error(`“${asset.name}”已被修改或替换，请重新导入后再处理。`);
                await this.assertUsers(asset, review.after.targetUuid);
                staged.push({ asset, data, meta });
            }
            // Persist the complete pre-cleanup scene (including a non-auto-saved import)
            // so the recovery target contains exactly the imported node tree.
            await this.script('prepareReviewRemoval', payload);
            await this.sceneRequest('save-scene');
            if (await this.sceneRequest('query-dirty')) throw new Error('无法保存清理前目标，资源尚未删除。');
            await this.script('prepareReviewRemoval', payload);
            await mkdir(backupFolder, { recursive: true });
            const targetData = await readFile(await assetPath(target.url));
            await writeFile(join(backupFolder, 'target-before.json'), targetData);
            for (let i = 0; i < staged.length; i++) {
                await writeFile(join(backupFolder, `${i}.image`), staged[i].data);
                await writeFile(join(backupFolder, `${i}.meta`), staged[i].meta);
            }
            await writeFile(join(backupFolder, 'manifest.json'), JSON.stringify({ targetUrl: target.url,
                assets: staged.map(({ asset }, i) => ({ url: asset.url, uuid: asset.uuid, image: `${i}.image`, meta: `${i}.meta` })) }, null, 2));
            review.backupFolder = backupFolder;
            await this.sceneRequest('snapshot');
            detached = true;
            await this.script('prepareReviewRemoval', { ...payload, detach: true });
            await this.sceneRequest('snapshot');
            await this.sceneRequest('save-scene');
            if (await this.sceneRequest('query-dirty')) throw new Error('目标保存未完成，已停止删除。');
            // Verify the saved file itself; dependency indexes may lag behind the editor save.
            const deletedUuids = new Set(payload.uuids.map(normalizeCocosUuid));
            const containsReference = (value: any): boolean => {
                if (!value || typeof value !== 'object') return false;
                if (typeof value.__uuid__ === 'string' && deletedUuids.has(normalizeCocosUuid(value.__uuid__))) return true;
                return Object.values(value).some(containsReference);
            };
            const targetPath = await assetPath(target.url);
            let verified = false;
            for (let attempt = 0; attempt < 30; attempt++) {
                if (!containsReference(JSON.parse((await readFile(targetPath)).toString('utf8')))) { verified = true; break; }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            if (!verified) throw new Error('保存后的文件仍引用待删除图片，已停止删除并恢复引用。');
            for (const asset of selected) await this.assertUsers(asset, target.uuid);
            saved = true;
            review.after = await this.script('finishReviewRemoval', { id });
            detached = false;
            for (const asset of selected) asset.nodeNames = [];
            for (const asset of selected) {
                try {
                    await this.script('prepareReviewRemoval', payload);
                    const record = this.recorder!.records.get(asset.url)!;
                    const path = await assetPath(asset.url);
                    if (digest(await readFile(path)) !== record.hash || digest(await readFile(`${path}.meta`)) !== record.metaHash) {
                        throw new Error('文件在确认过程中发生变化');
                    }
                    if (containsReference(JSON.parse((await readFile(targetPath)).toString('utf8')))) throw new Error('目标文件重新引用了待删除资源');
                    await this.assertUsers(asset, target.uuid);
                    await this.assetRequest('delete-asset', asset.url);
                    if (await this.assetRequest('query-asset-info', asset.url)) throw new Error('资源仍存在');
                    asset.state = 'deleted';
                    asset.nodeNames = [];
                    asset.canRemove = false;
                    this.previewCache.delete(asset.id);
                } catch (error) {
                    review.warnings.push(`“${asset.name}”已解除节点引用，但文件删除失败并保留：${(error as Error).message}`);
                }
            }
            review.changes = diffReviewNodes(review.before.nodes, review.after.nodes);
            review.confirmed = true;
            return review;
        } catch (error) {
            if (detached && !saved) {
                try {
                    await this.script('finishReviewRemoval', { id, restore: true });
                    await this.sceneRequest('save-scene');
                } catch (restoreError) {
                    throw new Error(`${(error as Error).message}；引用恢复未完成，请使用备份 ${review.backupFolder}：${(restoreError as Error).message}`);
                }
            }
            throw error;
        } finally { this.applying = false; }
    }
}
