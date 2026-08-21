import { extname, isAbsolute, relative, resolve, sep } from 'path';
import { readFile, realpath } from 'fs/promises';
import { canonicalStringify, sha256, type CanonicalJsonValue } from './canonical-json';
import type { CanonicalNode, ComponentLocator, Sha256, SyncId } from './protocol';
import type { RoundtripNodeState } from './diff3';
import { normalizeCocosUuid } from './uuid';

type Serialized = Record<string, unknown>;

export interface CocosAssetInfo {
    uuid: string;
    url: string;
    importer: string;
    type: string;
    imported: boolean;
    invalid: boolean;
    readonly?: boolean;
    readOnly?: boolean;
}

export interface CocosAssetDb {
    queryAssetInfo(uuid: string): Promise<CocosAssetInfo | null>;
}

export interface CocosPrefabProjection {
    prefabUuid: string;
    nodes: RoundtripNodeState[];
    sourceHash: Sha256;
    metaSourceHash: Sha256;
    preserveProjectionHash: Sha256;
    serialized: Serialized[];
}

export interface ResolvedCocosPrefab extends CocosPrefabProjection {
    assetUrl: string;
    prefabPath: string;
    metaPath: string;
    prefabBytes: Buffer;
    metaBytes: Buffer;
}

export const editorAssetDb: CocosAssetDb = {
    async queryAssetInfo(uuid: string): Promise<CocosAssetInfo | null> {
        return await Editor.Message.request(
            'asset-db',
            'query-asset-info',
            uuid,
            ['subAssets'],
        ) as CocosAssetInfo | null;
    },
};

function isRecord(value: unknown): value is Serialized {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnsafeKeys(value: unknown, path = '$'): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => rejectUnsafeKeys(entry, `${path}[${index}]`));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            throw new Error(`${path} 包含不安全成员 ${key}。`);
        }
        rejectUnsafeKeys(entry, `${path}.${key}`);
    }
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error(`${label} 不是有效 JSON。`);
    }
    rejectUnsafeKeys(value);
    return value;
}

function refId(value: unknown): number | undefined {
    return isRecord(value) && Number.isInteger(value.__id__) && (value.__id__ as number) >= 0
        ? value.__id__ as number
        : undefined;
}

function resolved(entries: Serialized[], value: unknown): Serialized | undefined {
    const id = refId(value);
    return id === undefined ? undefined : entries[id];
}

function typeOf(value: Serialized | undefined): string {
    return typeof value?.__type__ === 'string' ? value.__type__ : '';
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`${label} 缺失或无效。`);
    return value;
}

function finite(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是有限数值。`);
    return value;
}

function nodeFileId(entries: Serialized[], node: Serialized): string {
    const info = resolved(entries, node._prefab);
    if (typeOf(info) !== 'cc.PrefabInfo') throw new Error('节点缺少 cc.PrefabInfo。');
    return requiredString(info?.fileId, 'PrefabInfo.fileId');
}

function componentFileId(entries: Serialized[], component: Serialized): string | undefined {
    const info = resolved(entries, component.__prefab);
    if (typeOf(info) !== 'cc.CompPrefabInfo') return undefined;
    return typeof info?.fileId === 'string' && info.fileId ? info.fileId : undefined;
}

function components(entries: Serialized[], node: Serialized): Serialized[] {
    if (!Array.isArray(node._components)) throw new Error(`节点 ${nodeFileId(entries, node)} 的 _components 无效。`);
    return node._components.map((reference, index) => {
        const component = resolved(entries, reference);
        if (!component || !typeOf(component)) throw new Error(`组件引用 ${index} 无效。`);
        return component;
    });
}

function maskedComponentFingerprint(component: Serialized, componentType: string): Sha256 {
    const masked = JSON.parse(JSON.stringify(component)) as Serialized;
    if (componentType === 'cc.UITransform') masked._contentSize = '__ROUNDTRIP_EDITABLE__';
    if (componentType === 'cc.Sprite') masked._spriteFrame = '__ROUNDTRIP_EDITABLE__';
    return sha256(canonicalStringify(masked));
}

function resolveComponent(
    entries: Serialized[],
    node: Serialized,
    locator: ComponentLocator,
): Serialized {
    const candidates = components(entries, node).filter((component) => typeOf(component) === locator.componentType);
    if (locator.strategy === 'comp-prefab-file-id') {
        const matches = candidates.filter((component) => componentFileId(entries, component) === locator.fileId);
        if (matches.length !== 1) throw new Error(`组件 fileId ${locator.fileId} 未唯一命中。`);
        return matches[0];
    }
    if (candidates.length !== 1) throw new Error(`组件类型 ${locator.componentType} 未唯一命中。`);
    if (maskedComponentFingerprint(candidates[0], locator.componentType) !== locator.baselineFingerprint) {
        throw new Error(`组件 ${locator.componentType} fingerprint 已变化。`);
    }
    return candidates[0];
}

function parentFileId(entries: Serialized[], node: Serialized): string | null {
    if (node._parent === null || node._parent === undefined) return null;
    const parent = resolved(entries, node._parent);
    if (!parent || typeOf(parent) !== 'cc.Node') throw new Error('节点 parent 引用无效。');
    return nodeFileId(entries, parent);
}

function siblingIndex(entries: Serialized[], node: Serialized): number {
    const parent = resolved(entries, node._parent);
    if (!parent) return 0;
    if (!Array.isArray(parent._children)) throw new Error('父节点 children 无效。');
    const nodeIndex = entries.indexOf(node);
    const index = parent._children.findIndex((reference) => refId(reference) === nodeIndex);
    if (index < 0) throw new Error('父节点 children 不包含当前节点。');
    return index;
}

function spriteUuid(component: Serialized): string | null {
    if (component._spriteFrame === null) return null;
    if (!isRecord(component._spriteFrame) || typeof component._spriteFrame.__uuid__ !== 'string') {
        throw new Error('Sprite._spriteFrame 不是有效 UUID 引用。');
    }
    return normalizeCocosUuid(component._spriteFrame.__uuid__);
}

function deepClone(value: Serialized[]): Serialized[] {
    return JSON.parse(JSON.stringify(value)) as Serialized[];
}

function maskWritableProjection(
    entries: Serialized[],
    nodesById: ReadonlyMap<string, Serialized>,
    baseline: readonly CanonicalNode[],
): Sha256 {
    const masked = deepClone(entries);
    const maskedByOriginal = new Map<Serialized, Serialized>();
    entries.forEach((entry, index) => maskedByOriginal.set(entry, masked[index]));
    for (const canonicalNode of baseline) {
        const originalNode = nodesById.get(canonicalNode.locator.nodeFileId)!;
        const node = maskedByOriginal.get(originalNode)!;
        if (canonicalNode.editable.includes('position.xy')) {
            if (!isRecord(node._lpos)) throw new Error('Node._lpos 无效。');
            node._lpos.x = '__ROUNDTRIP_EDITABLE__';
            node._lpos.y = '__ROUNDTRIP_EDITABLE__';
        }
        if (canonicalNode.editable.includes('contentSize.wh')) {
            const original = resolveComponent(entries, originalNode, canonicalNode.componentLocators.uiTransform!);
            const component = maskedByOriginal.get(original)!;
            if (!isRecord(component._contentSize)) throw new Error('UITransform._contentSize 无效。');
            component._contentSize.width = '__ROUNDTRIP_EDITABLE__';
            component._contentSize.height = '__ROUNDTRIP_EDITABLE__';
        }
        if (canonicalNode.editable.includes('spriteFrame.uuid')) {
            const original = resolveComponent(entries, originalNode, canonicalNode.componentLocators.sprite!);
            const component = maskedByOriginal.get(original)!;
            component._spriteFrame = '__ROUNDTRIP_EDITABLE__';
        }
    }
    return sha256(canonicalStringify(masked as unknown as CanonicalJsonValue));
}

export function projectCocosPrefab(
    prefabBytes: Buffer,
    metaBytes: Buffer,
    baseline: readonly CanonicalNode[],
    expectedPrefabUuid: string,
): CocosPrefabProjection {
    const raw = parseJsonBytes(prefabBytes, 'Prefab');
    if (!Array.isArray(raw) || raw.some((entry) => !isRecord(entry))) throw new Error('Prefab 顶层必须是序列化对象数组。');
    const entries = raw as Serialized[];
    const meta = parseJsonBytes(metaBytes, 'Prefab meta');
    if (!isRecord(meta)) throw new Error('Prefab meta 顶层必须是对象。');
    const metaUuid = normalizeCocosUuid(requiredString(meta.uuid, 'Prefab meta.uuid'));
    const expected = normalizeCocosUuid(expectedPrefabUuid);
    if (metaUuid !== expected) throw new Error('Prefab meta UUID 与协议目标不一致。');
    const prefabRecords = entries.filter((entry) => typeOf(entry) === 'cc.Prefab');
    if (prefabRecords.length !== 1) throw new Error('Prefab 序列化记录未唯一命中。');
    if (typeof prefabRecords[0]._uuid === 'string' && normalizeCocosUuid(prefabRecords[0]._uuid) !== expected) {
        throw new Error('Prefab 内容 UUID 与 meta 不一致。');
    }

    const serializedNodes = entries.filter((entry) => typeOf(entry) === 'cc.Node');
    const nodesById = new Map<string, Serialized>();
    for (const node of serializedNodes) {
        const id = nodeFileId(entries, node);
        if (nodesById.has(id)) throw new Error(`Prefab 含重复 node fileId：${id}`);
        nodesById.set(id, node);
    }

    const nodes: RoundtripNodeState[] = [];
    for (const canonicalNode of baseline) {
        if (normalizeCocosUuid(canonicalNode.locator.ownerPrefabUuid) !== expected) {
            throw new Error(`canonical node owner Prefab 不匹配：${canonicalNode.syncId}`);
        }
        if (normalizeCocosUuid(canonicalNode.locator.sourcePrefabUuid) !== expected ||
            canonicalNode.locator.instanceChain.length !== 0) {
            if (canonicalNode.editable.length > 0) throw new Error(`nested/foreign node 不得声明 editable：${canonicalNode.syncId}`);
            nodes.push({
                syncId: canonicalNode.syncId,
                ...(canonicalNode.position ? { position: { ...canonicalNode.position } } : {}),
                ...(canonicalNode.contentSize ? { contentSize: { ...canonicalNode.contentSize } } : {}),
                ...(canonicalNode.spriteFrameUuid !== undefined ? { spriteFrameUuid: canonicalNode.spriteFrameUuid } : {}),
            });
            continue;
        }
        const node = nodesById.get(canonicalNode.locator.nodeFileId);
        if (!node) throw new Error(`node fileId 未命中：${canonicalNode.locator.nodeFileId}`);
        if (parentFileId(entries, node) !== canonicalNode.cocosStructure.parentNodeFileId ||
            siblingIndex(entries, node) !== canonicalNode.cocosStructure.siblingIndex) {
            throw new Error(`Cocos 节点结构已变化：${canonicalNode.syncId}`);
        }
        const state: RoundtripNodeState = { syncId: canonicalNode.syncId };
        if (canonicalNode.position !== undefined) {
            if (!isRecord(node._lpos)) throw new Error(`节点 ${canonicalNode.syncId} 缺少 _lpos。`);
            state.position = { x: finite(node._lpos.x, '_lpos.x'), y: finite(node._lpos.y, '_lpos.y') };
        }
        if (canonicalNode.contentSize !== undefined) {
            if (!canonicalNode.componentLocators.uiTransform) throw new Error(`节点 ${canonicalNode.syncId} 缺少 UITransform locator。`);
            const transform = resolveComponent(entries, node, canonicalNode.componentLocators.uiTransform);
            if (!isRecord(transform._contentSize)) throw new Error('UITransform._contentSize 无效。');
            state.contentSize = {
                width: finite(transform._contentSize.width, '_contentSize.width'),
                height: finite(transform._contentSize.height, '_contentSize.height'),
            };
        }
        if (canonicalNode.spriteFrameUuid !== undefined) {
            if (!canonicalNode.componentLocators.sprite) throw new Error(`节点 ${canonicalNode.syncId} 缺少 Sprite locator。`);
            state.spriteFrameUuid = spriteUuid(resolveComponent(entries, node, canonicalNode.componentLocators.sprite));
        }
        nodes.push(state);
    }
    return {
        prefabUuid: expected,
        nodes,
        sourceHash: sha256(prefabBytes),
        metaSourceHash: sha256(metaBytes),
        preserveProjectionHash: maskWritableProjection(entries, nodesById, baseline),
        serialized: entries,
    };
}

function containedPath(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function readCocosPrefabByUuid(input: {
    assetDb?: CocosAssetDb;
    projectRoot: string;
    prefabUuid: string;
    baseline: readonly CanonicalNode[];
}): Promise<ResolvedCocosPrefab> {
    const normalizedUuid = normalizeCocosUuid(input.prefabUuid);
    const assetDb = input.assetDb ?? editorAssetDb;
    const info = await assetDb.queryAssetInfo(normalizedUuid);
    if (!info) throw new Error(`AssetDB 未找到 Prefab UUID：${normalizedUuid}`);
    if (normalizeCocosUuid(info.uuid) !== normalizedUuid || info.importer !== 'prefab' ||
        info.type !== 'cc.Prefab' || !info.imported || info.invalid || info.readonly || info.readOnly) {
        throw new Error('AssetDB 目标不是可写且已导入的 cc.Prefab。');
    }
    if (!/^db:\/\/assets\/.+\.prefab$/i.test(info.url)) throw new Error('AssetDB URL 不是 assets 下的 Prefab。');
    const assetsRoot = await realpath(resolve(input.projectRoot, 'assets'));
    const lexicalPrefabPath = resolve(input.projectRoot, info.url.slice('db://'.length).replace(/\//g, sep));
    const prefabPath = await realpath(lexicalPrefabPath);
    if (!containedPath(assetsRoot, prefabPath) || extname(prefabPath).toLowerCase() !== '.prefab') {
        throw new Error('Prefab realpath 逃逸出项目 assets。');
    }
    const metaPath = await realpath(`${prefabPath}.meta`);
    if (!containedPath(assetsRoot, metaPath)) throw new Error('Prefab meta realpath 逃逸出项目 assets。');
    const [prefabBytes, metaBytes] = await Promise.all([readFile(prefabPath), readFile(metaPath)]);
    return {
        ...projectCocosPrefab(prefabBytes, metaBytes, input.baseline, normalizedUuid),
        assetUrl: info.url,
        prefabPath,
        metaPath,
        prefabBytes,
        metaBytes,
    };
}
