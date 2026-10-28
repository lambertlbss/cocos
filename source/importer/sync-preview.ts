import type { SceneNodeSpec, SyncMarkerSpec } from '../types';

/**
 * 导入前"改动"预检：把当前 Prefab 里已落盘的标记读出来，
 * 与本次从 Figma 重新计算的标记逐节点比对。
 *
 * 只使用 Prefab JSON 与 `SceneNodeSpec`，不访问 Figma、
 * 不下载图片、不打开 Prefab，因此可以在用户点击导入前随时运行。
 */
export interface PrefabSyncMarkerSnapshot {
    nodeId: string;
    name: string;
    active: boolean;
    width: number;
    height: number;
    aliasNodeIds: string[];
    aliasHash: string;
    visualHash: string;
    /** 像素指纹（不含页面坐标，含子树）；旧版标记没有该字段。 */
    pixelHash?: string;
    subtreeHash: string;
}

export type SyncPreviewStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface SyncPreviewItem {
    nodeId: string;
    name: string;
    previousName?: string;
    status: SyncPreviewStatus;
    /** 本次检测到的变化类别，已按固定顺序去重。 */
    fields: string[];
    /** 该节点的图片需要重新生成（整层/折叠/矢量）。 */
    assetStale: boolean;
    width?: number;
    height?: number;
    previousWidth?: number;
    previousHeight?: number;
}

export interface SyncPreviewSummary {
    total: number;
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    assetStaleCount: number;
    /** Prefab 中缺少标记的节点数量；>0 说明这份 Prefab 不是同步导入生成的。 */
    missingMarkers: number;
    items: SyncPreviewItem[];
    /** 列表被截断时给出完整变化节点数。 */
    changedTotal?: number;
}

export interface SyncPreviewResult extends SyncPreviewSummary {
    targetUrl: string;
    exists: boolean;
    prefabUuid?: string;
}

export function emptySyncPreviewSummary(): SyncPreviewSummary {
    return {
        total: 0,
        added: 0,
        removed: 0,
        changed: 0,
        unchanged: 0,
        assetStaleCount: 0,
        missingMarkers: 0,
        items: [],
    };
}

export const SYNC_PREVIEW_ITEM_LIMIT = 200;

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeNodeId(value: string): string {
    return value.trim().replace(/-/g, ':');
}

/**
 * 从 Prefab JSON 中读取标记。组件按字段识别，不依赖脚本 UUID：
 * 脚本被重新导入或 UUID 变化时仍能认出自己的标记。
 */
export function readPrefabSyncMarkers(
    contents: string | Buffer,
): Map<string, PrefabSyncMarkerSnapshot> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(typeof contents === 'string' ? contents : contents.toString('utf8'));
    } catch {
        throw new Error('Prefab 文件不是有效 JSON，无法读取同步标记。');
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Prefab 文件结构无效，无法读取同步标记。');
    }
    const objects = parsed as Array<Record<string, unknown>>;
    const byNodeId = new Map<string, PrefabSyncMarkerSnapshot>();
    for (const item of objects) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const nodeId = typeof item.figmaNodeId === 'string' ? normalizeNodeId(item.figmaNodeId) : '';
        const visualHash = typeof item.figmaVisualHash === 'string' ? item.figmaVisualHash : '';
        if (!nodeId || !visualHash) {
            continue;
        }
        const nodeRef = item.node as { __id__?: number } | undefined;
        const nodeIndex = typeof nodeRef?.__id__ === 'number' ? nodeRef.__id__ : -1;
        const node = nodeIndex >= 0 ? objects[nodeIndex] : undefined;
        if (!node || node.__type__ !== 'cc.Node') {
            continue;
        }
        let width = 0;
        let height = 0;
        for (const componentRef of (node._components as Array<{ __id__?: number }> | undefined) ?? []) {
            const component = typeof componentRef?.__id__ === 'number'
                ? objects[componentRef.__id__]
                : undefined;
            if (component?.__type__ === 'cc.UITransform') {
                const size = component._contentSize as { width?: unknown; height?: unknown } | undefined;
                width = finiteNumber(size?.width);
                height = finiteNumber(size?.height);
                break;
            }
        }
        byNodeId.set(nodeId, {
            nodeId,
            name: typeof node._name === 'string' ? node._name : '',
            active: node._active !== false,
            width,
            height,
            aliasNodeIds: typeof item.figmaAliasNodeIds === 'string'
                ? [...new Set(item.figmaAliasNodeIds.split(',')
                    .map((value) => normalizeNodeId(value))
                    .filter(Boolean))].sort()
                : [],
            aliasHash: typeof item.figmaAliasHash === 'string' ? item.figmaAliasHash : '',
            visualHash,
            pixelHash: typeof item.figmaPixelHash === 'string' && item.figmaPixelHash
                ? item.figmaPixelHash
                : undefined,
            subtreeHash: typeof item.figmaSubtreeHash === 'string' ? item.figmaSubtreeHash : '',
        });
    }
    return byNodeId;
}

function markerFromSnapshot(snapshot: PrefabSyncMarkerSnapshot): SyncMarkerSpec {
    return {
        schema: 1,
        figmaFileHash: '',
        figmaNodeId: snapshot.nodeId,
        aliasNodeIds: snapshot.aliasNodeIds,
        aliasHash: snapshot.aliasHash,
        visualHash: snapshot.visualHash,
        subtreeHash: snapshot.subtreeHash,
    };
}

function collectSpecs(specs: readonly SceneNodeSpec[]): SceneNodeSpec[] {
    const result: SceneNodeSpec[] = [];
    const visit = (nodes: readonly SceneNodeSpec[]) => {
        for (const node of nodes) {
            result.push(node);
            visit(node.children);
        }
    };
    visit(specs);
    return result;
}

/**
 * 逐节点比较"Prefab 里已有标记"与"本次 Figma 计划"。
 * 几何只比较尺寸：位置在 Prefab 中是父级局部坐标，直接与 Figma 页面坐标比较没有意义，
 * 位置变化由指纹（visualHash）覆盖。
 */
export function planSyncPreview(
    previous: ReadonlyMap<string, PrefabSyncMarkerSnapshot>,
    specs: readonly SceneNodeSpec[],
    options: { scale: number },
): SyncPreviewSummary {
    const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
    const planned = collectSpecs(specs);
    const seen = new Set<string>();
    const items: SyncPreviewItem[] = [];
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let assetStaleCount = 0;
    let missingMarkers = 0;

    for (const spec of planned) {
        const nodeId = normalizeNodeId(spec.figmaId);
        if (seen.has(nodeId)) {
            continue;
        }
        seen.add(nodeId);
        const marker = spec.syncMarker;
        if (!marker) {
            missingMarkers += 1;
            continue;
        }
        const width = Math.round(spec.frame.width * scale * 100) / 100;
        const height = Math.round(spec.frame.height * scale * 100) / 100;
        const before = previous.get(nodeId);
        if (!before) {
            added += 1;
            items.push({
                nodeId,
                name: spec.name,
                status: 'added',
                fields: ['新增节点'],
                assetStale: false,
                width,
                height,
            });
            continue;
        }
        const fields: string[] = [];
        if (before.name !== spec.name) {
            fields.push('名称');
        }
        if (before.active !== spec.visible) {
            fields.push('显隐');
        }
        if (Math.abs(before.width - width) > 0.5 || Math.abs(before.height - height) > 0.5) {
            fields.push('尺寸');
        }
        // 像素指纹（不含页面坐标、含子树）优先；旧标记缺该字段时退回原来的三项比较。
        const pixelComparable = typeof before.pixelHash === 'string'
            && typeof marker.pixelHash === 'string';
        const pixelChanged = pixelComparable
            ? before.pixelHash !== marker.pixelHash
            : before.subtreeHash !== marker.subtreeHash || before.visualHash !== marker.visualHash;
        const aliasChanged = before.aliasHash !== marker.aliasHash
            || before.aliasNodeIds.join(',') !== marker.aliasNodeIds.join(',');
        if (aliasChanged) {
            fields.push('折叠结构');
        } else if (before.subtreeHash !== marker.subtreeHash && (pixelChanged || !pixelComparable)) {
            // 子树变了且像素确实受影响：整层/折叠节点内部有改动。
            fields.push('子层内容');
        }
        if (before.visualHash !== marker.visualHash) {
            // 像素没变却几何变了，说明只是整体挪了位置。
            fields.push(pixelChanged ? '几何或外观' : '位置');
        }
        const assetStale = pixelChanged || aliasChanged;
        if (assetStale) {
            assetStaleCount += 1;
        }
        if (fields.length) {
            changed += 1;
            items.push({
                nodeId,
                name: spec.name,
                previousName: before.name,
                status: 'changed',
                fields,
                assetStale,
                width,
                height,
                previousWidth: before.width,
                previousHeight: before.height,
            });
        } else {
            unchanged += 1;
        }
    }

    let removed = 0;
    for (const [nodeId, snapshot] of previous) {
        if (seen.has(nodeId)) {
            continue;
        }
        removed += 1;
        items.push({
            nodeId,
            name: snapshot.name,
            status: 'removed',
            fields: ['删除节点'],
            assetStale: false,
            previousWidth: snapshot.width,
            previousHeight: snapshot.height,
        });
    }

    const changedTotal = added + changed + removed;
    return {
        total: planned.length,
        added,
        removed,
        changed,
        unchanged,
        assetStaleCount,
        missingMarkers,
        items: items.slice(0, SYNC_PREVIEW_ITEM_LIMIT),
        ...(items.length > SYNC_PREVIEW_ITEM_LIMIT ? { changedTotal } : {}),
    };
}
