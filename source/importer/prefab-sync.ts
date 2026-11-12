import { createHash } from 'crypto';
import type { Rect, SceneNodeSpec } from '../types';
import type { PrefabInstanceAttachment } from '../prefab-instance';
import { normalizeCocosUuid } from '../roundtrip/uuid';

export const PREFAB_SYNC_SCHEMA = 1 as const;
export const PREFAB_SYNC_KIND = 'frame-prefab' as const;

export interface PrefabSyncRecord {
    schema: typeof PREFAB_SYNC_SCHEMA;
    kind: typeof PREFAB_SYNC_KIND;
    sourceHash: string;
    rootFileId: string;
    /** SHA-256(Figma node identity) -> Cocos PrefabInfo.fileId. */
    nodeFileIds: Record<string, string>;
    /** Exact ownership sets used to avoid touching user-authored nodes/components. */
    managedNodeFileIds: string[];
    managedComponentFileIds: string[];
    managedHelperFileIds: string[];
    prefabInstances?: Record<string, PrefabInstanceAttachment>;
}

export interface PrefabSyncCapture {
    nodeFileIds: Record<string, string>;
    managedNodeFileIds: string[];
    managedComponentFileIds: string[];
    managedHelperFileIds: string[];
    prefabInstances?: Record<string, PrefabInstanceAttachment>;
}

export interface PrefabRecoveryTargetPlan {
    targetUuid?: string;
    clearPending: boolean;
    clearBinding: boolean;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9+/_=-]{8,128}$/;

function sha256(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function cleanNodeId(value: string): string {
    return value.trim().replace(/-/g, ':');
}

function cleanFileId(value: unknown, label: string): string {
    if (typeof value !== 'string' || !FILE_ID_PATTERN.test(value)) {
        throw new Error(`${label} 不是有效的 Cocos fileId。`);
    }
    return value;
}

function sortedUniqueFileIds(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} 必须是 fileId 数组。`);
    }
    return [...new Set(value.map((item, index) => cleanFileId(item, `${label}[${index}]`)))].sort();
}

function sortedNodeMap(entries: Iterable<[string, string]>): Record<string, string> {
    return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

function cleanPrefabInstances(value: unknown, managedNodes: string[]): Record<string, PrefabInstanceAttachment> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prefab 实例所有权记录无效。');
    const entries: Array<[string, PrefabInstanceAttachment]> = [];
    const instanceIds = new Set<string>();
    for (const [carrier, raw] of Object.entries(value)) {
        cleanFileId(carrier, 'Prefab carrier fileId');
        if (!managedNodes.includes(carrier) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Prefab 实例不属于受管节点。');
        }
        const item = raw as Record<string, unknown>;
        if (typeof item.assetUuid !== 'string' || !/^[A-Za-z0-9+/_=@.-]{1,256}$/.test(item.assetUuid)) {
            throw new Error('Prefab 实例资源 UUID 无效。');
        }
        const instanceFileId = cleanFileId(item.instanceFileId, 'Prefab instance fileId');
        if (instanceIds.has(instanceFileId)) throw new Error('Prefab 实例 fileId 重复。');
        instanceIds.add(instanceFileId);
        entries.push([carrier, { assetUuid: normalizeCocosUuid(item.assetUuid), instanceFileId }]);
    }
    return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) : undefined;
}

export function figmaFrameSourceHash(fileKey: string, sourceNodeId: string): string {
    const normalizedFileKey = fileKey.trim();
    const normalizedNodeId = cleanNodeId(sourceNodeId);
    if (!normalizedFileKey || !normalizedNodeId) {
        throw new Error('Figma Frame 来源缺少 fileKey 或 nodeId。');
    }
    return sha256(`figma-importer:frame:v1\0${normalizedFileKey}\0${normalizedNodeId}`);
}

export function figmaNodeIdentityKey(sourceHash: string, nodeId: string): string {
    if (!SHA256_PATTERN.test(sourceHash)) {
        throw new Error('Prefab 来源指纹格式无效。');
    }
    const normalizedNodeId = cleanNodeId(nodeId);
    if (!normalizedNodeId || normalizedNodeId === '__root__') {
        throw new Error('Figma 节点 ID 无效。');
    }
    return sha256(`figma-importer:node:v1\0${sourceHash}\0${normalizedNodeId}`);
}

export function collectSceneSpecFigmaIds(specs: SceneNodeSpec[]): string[] {
    const ids: string[] = [];
    const visit = (nodes: SceneNodeSpec[]) => {
        for (const node of nodes) {
            for (const id of [node.figmaId, ...(node.aliasFigmaIds ?? [])]) {
                if (typeof id === 'string' && id.length > 0 && id !== '__root__') {
                    ids.push(cleanNodeId(id));
                }
            }
            if (!node.prefab) visit(node.children);
        }
    };
    visit(specs);
    return [...new Set(ids)];
}

export function resolveExistingNodeFileIds(
    record: PrefabSyncRecord,
    figmaNodeIds: Iterable<string>,
): Record<string, string> {
    const resolved: Array<[string, string]> = [];
    for (const rawId of figmaNodeIds) {
        const nodeId = cleanNodeId(rawId);
        const fileId = record.nodeFileIds[figmaNodeIdentityKey(record.sourceHash, nodeId)];
        if (fileId) {
            resolved.push([nodeId, fileId]);
        }
    }
    return Object.fromEntries(resolved);
}

export function createPrefabSyncRecord(
    sourceHash: string,
    rootFigmaNodeId: string,
    rootFileId: string,
    rootTransformFileId: string,
): PrefabSyncRecord {
    if (!SHA256_PATTERN.test(sourceHash)) {
        throw new Error('Prefab 来源指纹格式无效。');
    }
    const safeRootFileId = cleanFileId(rootFileId, 'rootFileId');
    const safeTransformFileId = cleanFileId(rootTransformFileId, 'rootTransformFileId');
    return {
        schema: PREFAB_SYNC_SCHEMA,
        kind: PREFAB_SYNC_KIND,
        sourceHash,
        rootFileId: safeRootFileId,
        nodeFileIds: {
            [figmaNodeIdentityKey(sourceHash, rootFigmaNodeId)]: safeRootFileId,
        },
        managedNodeFileIds: [safeRootFileId],
        managedComponentFileIds: [safeTransformFileId],
        managedHelperFileIds: [],
    };
}

export function recordPrefabSyncCapture(
    previous: PrefabSyncRecord,
    capture: PrefabSyncCapture,
): PrefabSyncRecord {
    const entries: Array<[string, string]> = [];
    for (const [nodeId, rawFileId] of Object.entries(capture.nodeFileIds)) {
        const fileId = cleanFileId(rawFileId, `nodeFileIds.${nodeId}`);
        entries.push([figmaNodeIdentityKey(previous.sourceHash, nodeId), fileId]);
    }
    const nodeFileIds = sortedNodeMap(entries);
    if (!Object.values(nodeFileIds).includes(previous.rootFileId)) {
        throw new Error('Prefab 同步结果缺少原根节点 fileId，已拒绝提交来源记录。');
    }
    const managedNodeFileIds = sortedUniqueFileIds(capture.managedNodeFileIds, 'managedNodeFileIds');
    const prefabInstances = cleanPrefabInstances(capture.prefabInstances, managedNodeFileIds);
    return {
        schema: PREFAB_SYNC_SCHEMA,
        kind: PREFAB_SYNC_KIND,
        sourceHash: previous.sourceHash,
        rootFileId: previous.rootFileId,
        nodeFileIds,
        managedNodeFileIds,
        managedComponentFileIds: sortedUniqueFileIds(
            capture.managedComponentFileIds,
            'managedComponentFileIds',
        ),
        managedHelperFileIds: sortedUniqueFileIds(capture.managedHelperFileIds, 'managedHelperFileIds'),
        ...(prefabInstances ? { prefabInstances } : {}),
    };
}

export function readPrefabSyncRecord(meta: unknown): PrefabSyncRecord | null {
    if (!meta || typeof meta !== 'object') {
        return null;
    }
    const userData = (meta as { userData?: unknown }).userData;
    if (!userData || typeof userData !== 'object') {
        return null;
    }
    const raw = (userData as Record<string, unknown>).figmaImporter;
    if (raw === undefined) {
        return null;
    }
    if (!raw || typeof raw !== 'object') {
        throw new Error('Prefab 的 figmaImporter 来源记录已损坏。');
    }
    const value = raw as Record<string, unknown>;
    if (value.schema !== PREFAB_SYNC_SCHEMA || value.kind !== PREFAB_SYNC_KIND) {
        throw new Error('Prefab 的 figmaImporter 来源记录版本或类型不受支持。');
    }
    if (typeof value.sourceHash !== 'string' || !SHA256_PATTERN.test(value.sourceHash)) {
        throw new Error('Prefab 的 Figma 来源指纹无效。');
    }
    const rawNodeFileIds = value.nodeFileIds;
    if (!rawNodeFileIds || typeof rawNodeFileIds !== 'object' || Array.isArray(rawNodeFileIds)) {
        throw new Error('Prefab 的节点 fileId 映射无效。');
    }
    const nodeEntries: Array<[string, string]> = [];
    for (const [key, fileId] of Object.entries(rawNodeFileIds as Record<string, unknown>)) {
        if (!SHA256_PATTERN.test(key)) {
            throw new Error('Prefab 的节点来源键无效。');
        }
        nodeEntries.push([key, cleanFileId(fileId, `nodeFileIds.${key}`)]);
    }
    const rootFileId = cleanFileId(value.rootFileId, 'rootFileId');
    const managedNodeFileIds = sortedUniqueFileIds(value.managedNodeFileIds, 'managedNodeFileIds');
    if (!managedNodeFileIds.includes(rootFileId)) {
        throw new Error('Prefab 来源记录未声明根节点所有权。');
    }
    const prefabInstances = cleanPrefabInstances(value.prefabInstances, managedNodeFileIds);
    return {
        schema: PREFAB_SYNC_SCHEMA,
        kind: PREFAB_SYNC_KIND,
        sourceHash: value.sourceHash,
        rootFileId,
        nodeFileIds: sortedNodeMap(nodeEntries),
        managedNodeFileIds,
        managedComponentFileIds: sortedUniqueFileIds(
            value.managedComponentFileIds,
            'managedComponentFileIds',
        ),
        managedHelperFileIds: sortedUniqueFileIds(value.managedHelperFileIds, 'managedHelperFileIds'),
        ...(prefabInstances ? { prefabInstances } : {}),
    };
}

export function mergePrefabSyncRecord(meta: unknown, record: PrefabSyncRecord): Record<string, unknown> {
    const source = meta && typeof meta === 'object'
        ? meta as Record<string, unknown>
        : {};
    const userData = source.userData && typeof source.userData === 'object'
        ? source.userData as Record<string, unknown>
        : {};
    return {
        ...source,
        userData: {
            ...userData,
            figmaImporter: record,
        },
    };
}

export function planPrefabRecoveryTarget(
    pendingPrefabUuid: string | undefined,
    boundPrefabUuid: string | undefined,
    pendingAssetExists: boolean,
): PrefabRecoveryTargetPlan {
    if (!pendingPrefabUuid) {
        return {
            targetUuid: boundPrefabUuid,
            clearPending: false,
            clearBinding: false,
        };
    }
    if (pendingAssetExists) {
        return {
            targetUuid: pendingPrefabUuid,
            clearPending: false,
            clearBinding: false,
        };
    }
    const bindingPointsAtMissingPending = boundPrefabUuid === pendingPrefabUuid;
    return {
        targetUuid: bindingPointsAtMissingPending ? undefined : boundPrefabUuid,
        clearPending: true,
        clearBinding: bindingPointsAtMissingPending,
    };
}

export function prefabJsonContainsSyncRecord(
    contents: string | Buffer,
    record: PrefabSyncRecord,
): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(typeof contents === 'string' ? contents : contents.toString('utf8'));
    } catch {
        return false;
    }
    if (!Array.isArray(parsed)) {
        return false;
    }
    const entries = parsed as Array<Record<string, any>>;
    const resolve = (ref: any): Record<string, any> | undefined => Number.isInteger(ref?.__id__)
        ? entries[ref.__id__] : undefined;
    const rootIndex = entries[0]?.data?.__id__;
    const foreignInfos = new Set<Record<string, any>>();
    for (const item of entries) {
        if (item?.__type__ === 'cc.PrefabInfo' && (typeof item.asset?.__uuid__ === 'string'
            || (Number.isInteger(rootIndex) && Number.isInteger(item.root?.__id__) && item.root.__id__ !== rootIndex))) {
            foreignInfos.add(item);
        }
    }
    for (const item of entries) {
        if (foreignInfos.has(resolve(resolve(item?.node)?._prefab)!)) {
            const componentInfo = resolve(item.__prefab);
            if (componentInfo) foreignInfos.add(componentInfo);
        }
    }
    const nodeFileIds = new Set<string>();
    const componentFileIds = new Set<string>();
    for (const item of parsed) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const value = item as Record<string, unknown>;
        if (foreignInfos.has(value)) continue;
        const fileId = typeof value.fileId === 'string' ? value.fileId : '';
        if (!fileId) {
            continue;
        }
        const target = value.__type__ === 'cc.PrefabInfo'
            ? nodeFileIds
            : value.__type__ === 'cc.CompPrefabInfo'
                ? componentFileIds
                : null;
        if (!target) {
            continue;
        }
        if (target.has(fileId)) {
            return false;
        }
        target.add(fileId);
    }
    const expectedNodes = new Set([
        record.rootFileId,
        ...Object.values(record.nodeFileIds),
        ...record.managedNodeFileIds,
        ...record.managedHelperFileIds,
    ]);
    if (![...expectedNodes].every((fileId) => nodeFileIds.has(fileId))
        || !record.managedComponentFileIds.every((fileId) => componentFileIds.has(fileId))) return false;
    for (const [carrierId, attachment] of Object.entries(record.prefabInstances ?? {})) {
        const carriers = entries.filter((node) => node?.__type__ === 'cc.Node'
            && !foreignInfos.has(resolve(node._prefab)!) && resolve(node._prefab)?.fileId === carrierId);
        if (carriers.length !== 1 || !Array.isArray(carriers[0]._children)) return false;
        const matches = carriers[0]._children.filter((ref: unknown) => {
            const child = resolve(ref);
            const info = resolve(child?._prefab);
            const instance = resolve(info?.instance);
            return info && child && resolve(info.root) === child
                && normalizeCocosUuid(String(info.asset?.__uuid__ ?? '')) === normalizeCocosUuid(attachment.assetUuid)
                && instance?.__type__ === 'cc.PrefabInstance' && instance.fileId === attachment.instanceFileId;
        });
        if (matches.length !== 1) return false;
    }
    return true;
}

function cleanPrefabName(value: string): string {
    return value.replace(/[\u0000-\u001f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96)
        || 'FigmaPrefab';
}

export function createMinimalPrefabJson(
    name: string,
    frame: Rect,
    rootFileId: string,
    rootTransformFileId: string,
): string {
    const safeRootFileId = cleanFileId(rootFileId, 'rootFileId');
    const safeTransformFileId = cleanFileId(rootTransformFileId, 'rootTransformFileId');
    const width = Number.isFinite(frame.width) ? Math.max(0, frame.width) : 0;
    const height = Number.isFinite(frame.height) ? Math.max(0, frame.height) : 0;
    const safeName = cleanPrefabName(name);
    return JSON.stringify([
        {
            __type__: 'cc.Prefab',
            _name: safeName,
            _objFlags: 0,
            __editorExtras__: {},
            _native: '',
            data: { __id__: 1 },
            optimizationPolicy: 0,
            persistent: false,
        },
        {
            __type__: 'cc.Node',
            _name: safeName,
            _objFlags: 0,
            __editorExtras__: {},
            _parent: null,
            _children: [],
            _active: true,
            _components: [{ __id__: 2 }],
            _prefab: { __id__: 4 },
            _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
            _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
            _mobility: 0,
            _layer: 1073741824,
            _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
            _id: '',
        },
        {
            __type__: 'cc.UITransform',
            _name: '',
            _objFlags: 0,
            __editorExtras__: {},
            node: { __id__: 1 },
            _enabled: true,
            __prefab: { __id__: 3 },
            _contentSize: { __type__: 'cc.Size', width, height },
            _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
            _id: '',
        },
        {
            __type__: 'cc.CompPrefabInfo',
            fileId: safeTransformFileId,
        },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            asset: { __id__: 0 },
            fileId: safeRootFileId,
            instance: null,
            targetOverrides: null,
        },
    ], null, 2);
}
