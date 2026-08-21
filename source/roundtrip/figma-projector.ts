import { canonicalStringify, sha256 } from './canonical-json';
import { inverseGeometry, type CanonicalGeometryParent, type FigmaGeometryProjection } from './geometry';
import {
    MAX_SHARED_VALUE_BYTES,
    NODE_META_KEY,
    RESOURCE_BINDING_KEY,
    ROOT_BASELINE_PREFIX,
    ROOT_HEADER_KEY,
    SHARED_NAMESPACE,
    decodeBaseline,
    parseResourceBinding,
    parseRootHeader,
    parseSharedNodeMeta,
    type CanonicalBaseline,
    type ResourceBinding,
    type RootHeader,
    type SharedNodeMeta,
    type SyncId,
    type VisualId,
    type VisualManifestEntry,
} from './protocol';
import {
    managedRootIds,
    sharedValue,
    type FigmaRestNode,
    type IndexedFigmaDocument,
} from './figma-reader';
import type { RoundtripNodeState } from './diff3';

export interface ManagedFigmaNode {
    node: FigmaRestNode;
    meta: SharedNodeMeta;
    resourceBinding?: ResourceBinding;
}

export interface ParsedManagedDocument {
    header: RootHeader;
    baseline: CanonicalBaseline;
    root: FigmaRestNode;
    managedNodes: ReadonlyMap<VisualId, ManagedFigmaNode>;
    resources: ReadonlyMap<SyncId, ResourceBinding>;
    figmaProjection: RoundtripNodeState[];
}

function paintProjection(node: FigmaRestNode): unknown[] {
    if (!Array.isArray(node.fills)) return [];
    return node.fills.map((raw) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`节点 ${node.id} paint 无效。`);
        const paint = raw as Record<string, unknown>;
        if (paint.type === 'IMAGE') {
            if (typeof paint.scaleMode !== 'string') throw new Error(`节点 ${node.id} IMAGE paint 缺少 scaleMode。`);
            return {
                type: 'IMAGE',
                imageHash: typeof paint.imageHash === 'string' ? paint.imageHash : null,
                scaleMode: paint.scaleMode,
                opacity: typeof paint.opacity === 'number' ? paint.opacity : 1,
                visible: typeof paint.visible === 'boolean' ? paint.visible : true,
                ...(paint.imageTransform !== undefined ? { imageTransform: paint.imageTransform } : {}),
            };
        }
        if (paint.type === 'SOLID') {
            if (paint.color === undefined) throw new Error(`节点 ${node.id} SOLID paint 缺少 color。`);
            return {
                type: 'SOLID',
                color: paint.color,
                opacity: typeof paint.opacity === 'number' ? paint.opacity : 1,
                visible: typeof paint.visible === 'boolean' ? paint.visible : true,
                blendMode: typeof paint.blendMode === 'string' ? paint.blendMode : 'NORMAL',
            };
        }
        if (typeof paint.type !== 'string') throw new Error(`节点 ${node.id} paint type 无效。`);
        return {
            type: paint.type,
            opacity: typeof paint.opacity === 'number' ? paint.opacity : 1,
            visible: typeof paint.visible === 'boolean' ? paint.visible : true,
        };
    });
}

export function readonlyVisualFingerprint(node: FigmaRestNode, resourcePaintOwned: boolean): `sha256:${string}` {
    const projection: Record<string, unknown> = {
        type: node.type,
        visible: node.visible ?? true,
        opacity: node.opacity ?? 1,
        ...(resourcePaintOwned ? {} : { fills: paintProjection(node) }),
    };
    if (node.type === 'TEXT') {
        if (typeof node.characters !== 'string' || typeof node.fontSize !== 'number' ||
            typeof node.textAlignHorizontal !== 'string') {
            throw new Error(`TEXT 节点 ${node.id} 缺少只读视觉字段。`);
        }
        projection.characters = node.characters;
        projection.fontSize = node.fontSize;
        projection.textAlignHorizontal = node.textAlignHorizontal;
    }
    return sha256(canonicalStringify(projection));
}

export function roundtripPaintFingerprint(node: FigmaRestNode, visualId: VisualId): `sha256:${string}` {
    return sha256(canonicalStringify({ visualId, paints: paintProjection(node) }));
}

function subtree(root: FigmaRestNode): FigmaRestNode[] {
    const result: FigmaRestNode[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        result.push(node);
        const children = node.children ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return result;
}

function parseHeader(index: IndexedFigmaDocument, root: FigmaRestNode): RootHeader {
    const raw = sharedValue(root, ROOT_HEADER_KEY);
    if (raw === undefined) throw new Error('managed root 缺少 rt.header。');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SHARED_VALUE_BYTES) throw new Error('rt.header 超过共享数据上限。');
    const header = parseRootHeader(raw);
    let sameSurface = 0;
    for (const rootId of managedRootIds(index)) {
        const candidate = sharedValue(index.nodes.get(rootId)!, ROOT_HEADER_KEY);
        if (candidate === undefined) continue;
        try {
            if (parseRootHeader(candidate).surfaceId === header.surfaceId) sameSurface += 1;
        } catch {
            // A damaged unrelated root is reported during enumeration, but cannot
            // impersonate the selected root's valid surfaceId.
        }
    }
    if (sameSurface !== 1) throw new Error(`Figma 文件中 surfaceId ${header.surfaceId} 不唯一。`);
    return header;
}

function decodeEmbeddedBaseline(root: FigmaRestNode, header: RootHeader): CanonicalBaseline {
    const namespace = root.sharedPluginData?.[SHARED_NAMESPACE] ?? {};
    const expected = new Set(header.baseline.chunkKeys);
    for (const key of Object.keys(namespace)) {
        if (key.startsWith(ROOT_BASELINE_PREFIX) && !expected.has(key)) {
            throw new Error(`managed root 含 header 未声明的 baseline chunk：${key}`);
        }
    }
    const chunks = new Map<string, string>();
    for (const key of header.baseline.chunkKeys) {
        const value = sharedValue(root, key);
        if (value === undefined) throw new Error(`managed root 缺少 baseline chunk：${key}`);
        if (Buffer.byteLength(value, 'utf8') > MAX_SHARED_VALUE_BYTES) throw new Error(`${key} 超过共享数据上限。`);
        chunks.set(key, value);
    }
    const baseline = decodeBaseline(header, chunks);
    if (baseline.prefabUuid !== header.prefab.uuid) throw new Error('Header 与 Baseline 的 Prefab UUID 不一致。');
    return baseline;
}

function assertManifestEntry(
    entry: VisualManifestEntry,
    managed: ManagedFigmaNode,
    actualParentVisualId: string | null,
    siblingOrder: number,
): void {
    const meta = managed.meta;
    if (meta.visualId !== entry.visualId || meta.role !== entry.role) throw new Error(`visualManifest identity 不匹配：${entry.visualId}`);
    if (('syncId' in meta ? meta.syncId : undefined) !== entry.syncId) throw new Error(`visualManifest syncId 不匹配：${entry.visualId}`);
    if ((meta.role === 'helper' ? meta.ownerVisualId : undefined) !== entry.ownerVisualId) throw new Error(`visualManifest owner 不匹配：${entry.visualId}`);
    if (actualParentVisualId !== entry.parentVisualId || siblingOrder !== entry.siblingOrder || managed.node.type !== entry.figmaNodeType) {
        throw new Error(`visualManifest structure 已变化：${entry.visualId}`);
    }
    const resourcePaintOwned = meta.role === 'direct' && meta.editable.includes('spriteFrame.uuid');
    if (readonlyVisualFingerprint(managed.node, resourcePaintOwned) !== entry.readonlyVisualFingerprint) {
        throw new Error(`visualManifest readonly fingerprint 已变化：${entry.visualId}`);
    }
}

function geometryProjection(node: FigmaRestNode): FigmaGeometryProjection {
    const transform = node.relativeTransform;
    if (!transform || transform[0][0] !== 1 || transform[0][1] !== 0 ||
        transform[1][0] !== 0 || transform[1][1] !== 1) {
        throw new Error(`节点 ${node.id} 不符合 Geometry v1 的无旋转/无倾斜约束。`);
    }
    const width = node.size?.x ?? node.absoluteBoundingBox?.width;
    const height = node.size?.y ?? node.absoluteBoundingBox?.height;
    if (typeof width !== 'number' || !Number.isFinite(width) || typeof height !== 'number' || !Number.isFinite(height)) {
        throw new Error(`节点 ${node.id} 缺少有限尺寸。`);
    }
    return {
        localRect: { x: transform[0][2], y: transform[1][2], width, height },
        relativeTransform: transform,
    };
}

export function parseManagedDocument(
    index: IndexedFigmaDocument,
    root: FigmaRestNode,
): ParsedManagedDocument {
    const header = parseHeader(index, root);
    const baseline = decodeEmbeddedBaseline(root, header);
    const managedNodes = new Map<VisualId, ManagedFigmaNode>();
    const resources = new Map<SyncId, ResourceBinding>();
    for (const node of subtree(root)) {
        const rawMeta = sharedValue(node, NODE_META_KEY);
        if (rawMeta === undefined) throw new Error(`managed subtree 节点 ${node.id} 缺少 rt.node。`);
        const meta = parseSharedNodeMeta(rawMeta);
        if (managedNodes.has(meta.visualId)) throw new Error(`重复 visualId：${meta.visualId}`);
        const rawResource = sharedValue(node, RESOURCE_BINDING_KEY);
        const resourceBinding = rawResource === undefined ? undefined : parseResourceBinding(rawResource);
        if (resourceBinding) {
            if (meta.role !== 'direct' || !meta.editable.includes('spriteFrame.uuid') ||
                resourceBinding.syncId !== meta.syncId || resourceBinding.paintVisualId !== meta.visualId) {
                throw new Error(`节点 ${node.id} 的 resource binding identity/proof 无效。`);
            }
            const paints = paintProjection(node);
            if (paints.length !== 1 || (paints[0] as { type?: unknown }).type !== 'IMAGE' ||
                roundtripPaintFingerprint(node, meta.visualId) !== resourceBinding.paintFingerprint) {
                throw new Error(`节点 ${node.id} 的 PaintProjection fingerprint 无效。`);
            }
            if (resources.has(resourceBinding.syncId)) throw new Error(`重复 resource binding：${resourceBinding.syncId}`);
            resources.set(resourceBinding.syncId, resourceBinding);
        }
        managedNodes.set(meta.visualId, { node, meta, resourceBinding });
    }
    if (managedNodes.size !== baseline.visualManifest.length) throw new Error('visualManifest 与 managed subtree 数量不一致。');

    const visualByNodeId = new Map<string, VisualManifestEntry['visualId']>();
    for (const [visualId, managed] of managedNodes) visualByNodeId.set(managed.node.id, visualId);
    const manifestByVisual = new Map(baseline.visualManifest.map((entry) => [entry.visualId, entry]));
    for (const [visualId, managed] of managedNodes) {
        const entry = manifestByVisual.get(visualId);
        if (!entry) throw new Error(`managed node 不在 visualManifest：${visualId}`);
        const parentId = index.parentIds.get(managed.node.id);
        const actualParentVisualId = parentId ? visualByNodeId.get(parentId) ?? null : null;
        const siblings = actualParentVisualId && parentId ? index.nodes.get(parentId)?.children ?? [] : [managed.node];
        const siblingOrder = actualParentVisualId
            ? siblings.findIndex((candidate) => candidate.id === managed.node.id)
            : 0;
        assertManifestEntry(entry, managed, actualParentVisualId, siblingOrder < 0 ? 0 : siblingOrder);
    }

    const baselineById = new Map(baseline.nodes.map((node) => [node.syncId, node]));
    const figmaProjection: RoundtripNodeState[] = [];
    for (const managed of managedNodes.values()) {
        if (managed.meta.role !== 'direct' && managed.meta.role !== 'nested-readonly') continue;
        const canonicalNode = baselineById.get(managed.meta.syncId);
        if (!canonicalNode) throw new Error(`direct node 缺少 baseline：${managed.meta.syncId}`);
        if (managed.meta.role === 'direct' && canonicalNode.editable.join('\0') !== managed.meta.editable.join('\0')) {
            throw new Error(`direct node editable 与 baseline 不一致：${managed.meta.syncId}`);
        }
        if (managed.meta.role === 'nested-readonly' && canonicalNode.editable.length > 0) {
            throw new Error(`nested-readonly baseline 不得声明 editable：${managed.meta.syncId}`);
        }
        if (canonicalNode.editable.some((field) => !header.capabilities.editable.includes(field))) {
            throw new Error(`node editable 超出 header capability：${managed.meta.syncId}`);
        }
        const parentNode = canonicalNode.geometry.parentSyncId
            ? baselineById.get(canonicalNode.geometry.parentSyncId)
            : undefined;
        const parent: CanonicalGeometryParent | null = parentNode?.contentSize
            ? { contentSize: parentNode.contentSize, anchor: parentNode.geometry.sourceAnchor }
            : null;
        const currentGeometry = geometryProjection(managed.node);
        const inverted = inverseGeometry(currentGeometry, {
            mappingVersion: 1,
            ...currentGeometry,
            sourceAnchor: canonicalNode.geometry.sourceAnchor,
            sourceScale: canonicalNode.geometry.sourceScale,
            parent,
            parentSyncId: canonicalNode.geometry.parentSyncId,
            dependencySyncIds: canonicalNode.geometry.dependencySyncIds,
            dependencyHash: canonicalNode.geometry.dependencyHash,
        });
        figmaProjection.push({
            syncId: canonicalNode.syncId,
            ...(canonicalNode.position ? { position: inverted.position } : {}),
            ...(canonicalNode.contentSize ? { contentSize: inverted.contentSize } : {}),
            ...(canonicalNode.spriteFrameUuid !== undefined
                ? { spriteFrameUuid: managed.resourceBinding?.boundUuid ?? canonicalNode.spriteFrameUuid }
                : {}),
        });
    }
    if (figmaProjection.length !== baseline.nodes.length) throw new Error('并非所有 baseline node 都有 direct Figma projection。');
    return { header, baseline, root, managedNodes, resources, figmaProjection };
}
