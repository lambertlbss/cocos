"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNC_MARKER_SCRIPT_SOURCE = exports.SYNC_MARKER_CATEGORY = exports.SYNC_MARKER_SCRIPT_URL = exports.SYNC_MARKER_FILE = exports.SYNC_MARKER_FOLDER = exports.SYNC_MARKER_CLASS = exports.SYNC_MARKER_SCHEMA = void 0;
exports.normalizeSyncNodeId = normalizeSyncNodeId;
exports.syncVisualPayload = syncVisualPayload;
exports.syncSubtreePayload = syncSubtreePayload;
exports.syncVisualHash = syncVisualHash;
exports.syncSubtreeHash = syncSubtreeHash;
exports.syncAliasHash = syncAliasHash;
exports.syncFileHash = syncFileHash;
exports.createSyncMarker = createSyncMarker;
exports.compareSyncMarker = compareSyncMarker;
exports.syncNeedsAssetRefresh = syncNeedsAssetRefresh;
exports.markerToComponentValues = markerToComponentValues;
exports.markerFromComponentValues = markerFromComponentValues;
exports.assertUniqueSyncOwnership = assertUniqueSyncOwnership;
exports.isSyncMarkerScript = isSyncMarkerScript;
const canonical_json_1 = require("../roundtrip/canonical-json");
/**
 * 组件级双边同步（Component Sync）的标记协议。
 *
 * 标记组件 `FigmaSyncNode` 挂在每个由同步模式生成的 Cocos 节点上，
 * 既提供可见身份（Figma 节点 id），也保存上次导入时的视觉/子树指纹，
 * 使重新导入能在不打开 Prefab 的情况下判断"设计改了什么"。
 *
 * 安全边界：file key 只以 SHA-256 形式保存；node id 按需求明文保存，
 * 与 Project Profile 中 nodeMaps / nodeOverrides 的既有明文一致。
 */
exports.SYNC_MARKER_SCHEMA = 1;
exports.SYNC_MARKER_CLASS = 'FigmaSyncNode';
exports.SYNC_MARKER_FOLDER = 'figma-importer-runtime';
exports.SYNC_MARKER_FILE = 'FigmaSyncNode.ts';
exports.SYNC_MARKER_SCRIPT_URL = `db://assets/${exports.SYNC_MARKER_FOLDER}/${exports.SYNC_MARKER_FILE}`;
exports.SYNC_MARKER_CATEGORY = 'Figma Importer';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
function normalizeSyncNodeId(value) {
    return value.trim().replace(/-/g, ':');
}
function finiteOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? (0, canonical_json_1.quantizeDecimal)(value, 4) : null;
}
function framePayload(frame) {
    var _a, _b, _c, _d;
    if (!frame) {
        return null;
    }
    return [
        (_a = finiteOrNull(frame.x)) !== null && _a !== void 0 ? _a : 0,
        (_b = finiteOrNull(frame.y)) !== null && _b !== void 0 ? _b : 0,
        (_c = finiteOrNull(frame.width)) !== null && _c !== void 0 ? _c : 0,
        (_d = finiteOrNull(frame.height)) !== null && _d !== void 0 ? _d : 0,
    ];
}
function paintPayload(paint) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    return {
        type: paint.type,
        visible: paint.visible !== false,
        opacity: finiteOrNull((_a = paint.opacity) !== null && _a !== void 0 ? _a : 1),
        blendMode: (_b = paint.blendMode) !== null && _b !== void 0 ? _b : null,
        color: paint.color
            ? {
                r: finiteOrNull(paint.color.r),
                g: finiteOrNull(paint.color.g),
                b: finiteOrNull(paint.color.b),
                a: finiteOrNull((_c = paint.color.a) !== null && _c !== void 0 ? _c : 1),
            }
            : null,
        imageRef: (_d = paint.imageRef) !== null && _d !== void 0 ? _d : null,
        scaleMode: (_e = paint.scaleMode) !== null && _e !== void 0 ? _e : null,
        rotation: finiteOrNull(paint.rotation),
        sourceNodeId: (_f = paint.sourceNodeId) !== null && _f !== void 0 ? _f : null,
        tileType: (_g = paint.tileType) !== null && _g !== void 0 ? _g : null,
        scalingFactor: finiteOrNull(paint.scalingFactor),
        spacing: paint.spacing
            ? [finiteOrNull(paint.spacing.x), finiteOrNull(paint.spacing.y)]
            : null,
        horizontalAlignment: (_h = paint.horizontalAlignment) !== null && _h !== void 0 ? _h : null,
        verticalAlignment: (_j = paint.verticalAlignment) !== null && _j !== void 0 ? _j : null,
        gradientHandlePositions: Array.isArray(paint.gradientHandlePositions)
            ? paint.gradientHandlePositions.map((handle) => [finiteOrNull(handle.x), finiteOrNull(handle.y)])
            : null,
        gradientStops: Array.isArray(paint.gradientStops)
            ? paint.gradientStops.map((stop) => {
                var _a;
                return [finiteOrNull(stop.position), stop.color
                        ? {
                            r: finiteOrNull(stop.color.r),
                            g: finiteOrNull(stop.color.g),
                            b: finiteOrNull(stop.color.b),
                            a: finiteOrNull((_a = stop.color.a) !== null && _a !== void 0 ? _a : 1),
                        }
                        : null];
            })
            : null,
        // 图片裁切矩阵与滤镜同样改变像素，但不会改变 imageRef；漏掉它们会让
        // 整层节点在重导入后继续显示旧图。
        imageTransform: Array.isArray(paint.imageTransform)
            ? paint.imageTransform.map((row) => (Array.isArray(row)
                ? row.map((value) => finiteOrNull(value))
                : null))
            : null,
        filters: paint.filters
            ? Object.fromEntries(Object.entries(paint.filters)
                .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
                .map(([key, value]) => [key, finiteOrNull(value)]))
            : null,
    };
}
function effectPayload(effect) {
    var _a, _b, _c;
    return {
        type: effect.type,
        visible: effect.visible !== false,
        radius: finiteOrNull(effect.radius),
        spread: finiteOrNull(effect.spread),
        offsetX: finiteOrNull((_a = effect.offset) === null || _a === void 0 ? void 0 : _a.x),
        offsetY: finiteOrNull((_b = effect.offset) === null || _b === void 0 ? void 0 : _b.y),
        color: effect.color
            ? {
                r: finiteOrNull(effect.color.r),
                g: finiteOrNull(effect.color.g),
                b: finiteOrNull(effect.color.b),
                a: finiteOrNull((_c = effect.color.a) !== null && _c !== void 0 ? _c : 1),
            }
            : null,
    };
}
function textPayload(style) {
    var _a, _b, _c, _d, _e, _f;
    if (!style) {
        return null;
    }
    return {
        fontFamily: (_a = style.fontFamily) !== null && _a !== void 0 ? _a : null,
        fontPostScriptName: (_b = style.fontPostScriptName) !== null && _b !== void 0 ? _b : null,
        fontWeight: finiteOrNull(style.fontWeight),
        fontSize: finiteOrNull(style.fontSize),
        textAlignHorizontal: (_c = style.textAlignHorizontal) !== null && _c !== void 0 ? _c : null,
        textAlignVertical: (_d = style.textAlignVertical) !== null && _d !== void 0 ? _d : null,
        letterSpacing: finiteOrNull(style.letterSpacing),
        lineHeightPx: finiteOrNull(style.lineHeightPx),
        textAutoResize: (_e = style.textAutoResize) !== null && _e !== void 0 ? _e : null,
        textTruncation: (_f = style.textTruncation) !== null && _f !== void 0 ? _f : null,
        maxLines: finiteOrNull(style.maxLines),
    };
}
/**
 * 本节点自身的视觉贡献：几何、显隐、填充/描边/特效、圆角、文字与样式。
 * 不包含子节点，因此折叠父节点的指纹不会因子层移动而变化。
 */
function syncVisualPayload(node) {
    var _a, _b, _c, _d, _e, _f;
    return {
        id: normalizeSyncNodeId(node.id),
        type: node.type,
        frame: framePayload(node.absoluteBoundingBox),
        renderBounds: framePayload(node.absoluteRenderBounds),
        size: node.size
            ? [finiteOrNull(node.size.width), finiteOrNull(node.size.height)]
            : null,
        rotation: finiteOrNull(node.rotation),
        visible: node.visible !== false,
        opacity: finiteOrNull((_a = node.opacity) !== null && _a !== void 0 ? _a : 1),
        blendMode: (_b = node.blendMode) !== null && _b !== void 0 ? _b : null,
        clipsContent: node.clipsContent === true,
        cornerRadius: finiteOrNull(node.cornerRadius),
        rectangleCornerRadii: Array.isArray(node.rectangleCornerRadii)
            ? node.rectangleCornerRadii.map((radius) => finiteOrNull(radius))
            : null,
        // 圆弧的起止角与内半径只改像素，不改外框；不纳入指纹会漏掉整层节点的新形状。
        arcData: node.arcData
            ? {
                startingAngle: finiteOrNull(node.arcData.startingAngle),
                endingAngle: finiteOrNull(node.arcData.endingAngle),
                innerRadius: finiteOrNull(node.arcData.innerRadius),
            }
            : null,
        fills: ((_c = node.fills) !== null && _c !== void 0 ? _c : []).map(paintPayload),
        strokes: ((_d = node.strokes) !== null && _d !== void 0 ? _d : []).map(paintPayload),
        strokeWeight: finiteOrNull(node.strokeWeight),
        strokeAlign: (_e = node.strokeAlign) !== null && _e !== void 0 ? _e : null,
        effects: ((_f = node.effects) !== null && _f !== void 0 ? _f : []).map(effectPayload),
        characters: typeof node.characters === 'string' ? node.characters : null,
        textStyle: textPayload(node.style),
    };
}
/** 子树结构：本节点指纹 + 逐层子节点指纹，用于判断渲染型节点是否需要重新出图。 */
function syncSubtreePayload(node) {
    var _a;
    return {
        visual: syncVisualPayload(node),
        children: ((_a = node.children) !== null && _a !== void 0 ? _a : []).map((child) => syncSubtreePayload(child)),
    };
}
function syncVisualHash(node) {
    return (0, canonical_json_1.sha256)((0, canonical_json_1.canonicalStringify)(syncVisualPayload(node)));
}
function syncSubtreeHash(node) {
    return (0, canonical_json_1.sha256)((0, canonical_json_1.canonicalStringify)(syncSubtreePayload(node)));
}
function syncAliasHash(aliasNodeIds) {
    const ids = [...new Set(aliasNodeIds.map(normalizeSyncNodeId).filter(Boolean))].sort();
    return (0, canonical_json_1.sha256)((0, canonical_json_1.canonicalStringify)(ids));
}
function syncFileHash(fileKey) {
    const normalized = fileKey.trim();
    if (!normalized) {
        throw new Error('组件同步缺少 Figma file key。');
    }
    return (0, canonical_json_1.sha256)(`figma-importer:sync-file:v1\0${normalized}`);
}
function createSyncMarker(input) {
    var _a, _b;
    const nodeId = normalizeSyncNodeId(input.node.id);
    if (!nodeId) {
        throw new Error('组件同步节点缺少 Figma 节点 id。');
    }
    const aliasNodeIds = [...new Set(((_a = input.aliasNodeIds) !== null && _a !== void 0 ? _a : [])
            .map(normalizeSyncNodeId)
            .filter((id) => Boolean(id) && id !== nodeId))].sort();
    return {
        schema: (_b = input.schema) !== null && _b !== void 0 ? _b : exports.SYNC_MARKER_SCHEMA,
        figmaFileHash: syncFileHash(input.fileKey),
        figmaNodeId: nodeId,
        aliasNodeIds,
        aliasHash: syncAliasHash(aliasNodeIds),
        visualHash: syncVisualHash(input.node),
        subtreeHash: syncSubtreeHash(input.node),
    };
}
function compareSyncMarker(previous, next) {
    const visualChanged = previous.visualHash !== next.visualHash;
    const subtreeChanged = previous.subtreeHash !== next.subtreeHash;
    const structureChanged = previous.aliasHash !== next.aliasHash
        || previous.aliasNodeIds.join(',') !== next.aliasNodeIds.join(',');
    const sourceChanged = previous.figmaFileHash !== next.figmaFileHash
        || previous.figmaNodeId !== next.figmaNodeId;
    return {
        visualChanged,
        subtreeChanged,
        structureChanged,
        // 换了来源、几何、子树或折叠集合，都意味着这张图不再是上次导出的那张。
        assetStale: visualChanged || subtreeChanged || structureChanged || sourceChanged,
    };
}
/** 判断一个不透明视觉节点（矢量/整层 PNG/折叠包装）是否需要重新生成图片。 */
function syncNeedsAssetRefresh(options) {
    if (!options.rasterized) {
        return false;
    }
    return options.comparison.assetStale;
}
function markerToComponentValues(marker) {
    return {
        figmaMarkerSchema: marker.schema,
        figmaFileHash: marker.figmaFileHash,
        figmaNodeId: marker.figmaNodeId,
        figmaAliasNodeIds: marker.aliasNodeIds.join(','),
        figmaAliasHash: marker.aliasHash,
        figmaVisualHash: marker.visualHash,
        figmaSubtreeHash: marker.subtreeHash,
    };
}
/** 从 Cocos 组件读回标记；字段缺失或损坏时返回 null，由调用方 fail-closed。 */
function markerFromComponentValues(values) {
    if (!values || typeof values !== 'object') {
        return null;
    }
    const schema = values.figmaMarkerSchema;
    if (schema !== exports.SYNC_MARKER_SCHEMA) {
        return null;
    }
    const fileHash = values.figmaFileHash;
    const nodeId = typeof values.figmaNodeId === 'string' ? normalizeSyncNodeId(values.figmaNodeId) : '';
    const visualHash = values.figmaVisualHash;
    const subtreeHash = values.figmaSubtreeHash;
    if (typeof fileHash !== 'string' || !SHA256_PATTERN.test(fileHash)) {
        return null;
    }
    if (!nodeId || typeof visualHash !== 'string' || !SHA256_PATTERN.test(visualHash)) {
        return null;
    }
    if (typeof subtreeHash !== 'string' || !SHA256_PATTERN.test(subtreeHash)) {
        return null;
    }
    const aliasNodeIds = typeof values.figmaAliasNodeIds === 'string'
        ? values.figmaAliasNodeIds.split(',')
            .map((id) => normalizeSyncNodeId(id))
            .filter(Boolean)
            .sort()
        : [];
    const aliasHash = typeof values.figmaAliasHash === 'string' && SHA256_PATTERN.test(values.figmaAliasHash)
        ? values.figmaAliasHash
        : syncAliasHash(aliasNodeIds);
    return {
        schema,
        figmaFileHash: fileHash,
        figmaNodeId: nodeId,
        aliasNodeIds,
        aliasHash,
        visualHash,
        subtreeHash,
    };
}
/**
 * 一个 Figma 节点只能被一个 Cocos 节点声明（自己或作为别名）。
 * 折叠父子同时声明同源节点会让"改哪个节点"变得不可判定。
 */
function assertUniqueSyncOwnership(markers) {
    const owners = new Map();
    for (const marker of markers) {
        for (const nodeId of [marker.figmaNodeId, ...marker.aliasNodeIds]) {
            const owner = owners.get(nodeId);
            if (owner && owner !== marker.figmaNodeId) {
                throw new Error(`Figma 节点 ${nodeId} 同时被 ${owner} 和 ${marker.figmaNodeId} 声明，已拒绝生成同步标记。`);
            }
            owners.set(nodeId, marker.figmaNodeId);
        }
    }
}
/** 需要在项目 assets 中生成的最小标记组件源码（无业务逻辑，只保存来源与指纹）。 */
exports.SYNC_MARKER_SCRIPT_SOURCE = `import { _decorator, Component } from 'cc';

const { ccclass, property, menu } = _decorator;

/**
 * Figma Importer 生成的同步标记。字段由插件维护，手工修改会导致下次同步被拒绝。
 * 删除本组件即表示该节点退出 Figma 同步：插件不会再移动、缩放或删除它。
 */
@ccclass('${exports.SYNC_MARKER_CLASS}')
@menu('${exports.SYNC_MARKER_CATEGORY}/${exports.SYNC_MARKER_CLASS}')
export class ${exports.SYNC_MARKER_CLASS} extends Component {
    @property({ tooltip: '标记协议版本' })
    public figmaMarkerSchema: number = ${exports.SYNC_MARKER_SCHEMA};

    @property({ tooltip: 'Figma 文件 key 的 SHA-256' })
    public figmaFileHash: string = '';

    @property({ tooltip: 'Figma 节点 id' })
    public figmaNodeId: string = '';

    @property({ tooltip: '被折叠到本节点的 Figma 子层 id，逗号分隔' })
    public figmaAliasNodeIds: string = '';

    @property({ tooltip: '折叠子层集合指纹' })
    public figmaAliasHash: string = '';

    @property({ tooltip: '本次导入时的节点视觉指纹' })
    public figmaVisualHash: string = '';

    @property({ tooltip: '本次导入时的子树指纹' })
    public figmaSubtreeHash: string = '';
}
`;
/** 验证生成到项目里的脚本没有被截断或被改成别的类。 */
function isSyncMarkerScript(source) {
    return typeof source === 'string'
        && source.includes(`@ccclass('${exports.SYNC_MARKER_CLASS}')`)
        && source.includes(`class ${exports.SYNC_MARKER_CLASS} extends Component`)
        && source.includes('figmaSubtreeHash');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBc0RBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFFRCwwQ0FFQztBQUVELHNDQUdDO0FBRUQsb0NBTUM7QUFFRCw0Q0FpQkM7QUFFRCw4Q0FpQkM7QUFHRCxzREFTQztBQUVELDBEQVVDO0FBR0QsOERBeUNDO0FBTUQsOERBYUM7QUFzQ0QsZ0RBS0M7QUEvWUQsZ0VBQTBGO0FBRTFGOzs7Ozs7Ozs7R0FTRztBQUNVLFFBQUEsa0JBQWtCLEdBQUcsQ0FBVSxDQUFDO0FBQ2hDLFFBQUEsaUJBQWlCLEdBQUcsZUFBZSxDQUFDO0FBQ3BDLFFBQUEsa0JBQWtCLEdBQUcsd0JBQXdCLENBQUM7QUFDOUMsUUFBQSxnQkFBZ0IsR0FBRyxrQkFBa0IsQ0FBQztBQUN0QyxRQUFBLHNCQUFzQixHQUFHLGVBQWUsMEJBQWtCLElBQUksd0JBQWdCLEVBQUUsQ0FBQztBQUNqRixRQUFBLG9CQUFvQixHQUFHLGdCQUFnQixDQUFDO0FBa0NyRCxNQUFNLGNBQWMsR0FBRyx1QkFBdUIsQ0FBQztBQUUvQyxTQUFnQixtQkFBbUIsQ0FBQyxLQUFhO0lBQzdDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQXlCO0lBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUEsZ0NBQWUsRUFBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNsRyxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBdUI7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QU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxXQUFXLEVBQUUsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQztZQUNoRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ3hDLE1BQU0sSUFBSSxLQUFLLENBQ1gsWUFBWSxNQUFNLFFBQVEsS0FBSyxNQUFNLE1BQU0sQ0FBQyxXQUFXLGdCQUFnQixDQUMxRSxDQUFDO1lBQ04sQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMzQyxDQUFDO0lBQ0wsQ0FBQztBQUNMLENBQUM7QUFFRCxpREFBaUQ7QUFDcEMsUUFBQSx5QkFBeUIsR0FBRzs7Ozs7Ozs7WUFRN0IseUJBQWlCO1NBQ3BCLDRCQUFvQixJQUFJLHlCQUFpQjtlQUNuQyx5QkFBaUI7O3lDQUVTLDBCQUFrQjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FvQjFELENBQUM7QUFFRiwrQkFBK0I7QUFDL0IsU0FBZ0Isa0JBQWtCLENBQUMsTUFBYztJQUM3QyxPQUFPLE9BQU8sTUFBTSxLQUFLLFFBQVE7V0FDMUIsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLHlCQUFpQixJQUFJLENBQUM7V0FDbkQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxTQUFTLHlCQUFpQixvQkFBb0IsQ0FBQztXQUMvRCxNQUFNLENBQUMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDL0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFFZmZlY3QsIEZpZ21hTm9kZSwgRmlnbWFQYWludCwgRmlnbWFUZXh0U3R5bGUsIFJlY3QsIFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHsgY2Fub25pY2FsU3RyaW5naWZ5LCBxdWFudGl6ZURlY2ltYWwsIHNoYTI1NiB9IGZyb20gJy4uL3JvdW5kdHJpcC9jYW5vbmljYWwtanNvbic7XG5cbi8qKlxuICog57uE5Lu257qn5Y+M6L655ZCM5q2l77yIQ29tcG9uZW50IFN5bmPvvInnmoTmoIforrDljY/orq7jgIJcbiAqXG4gKiDmoIforrDnu4Tku7YgYEZpZ21hU3luY05vZGVgIOaMguWcqOavj+S4queUseWQjOatpeaooeW8j+eUn+aIkOeahCBDb2NvcyDoioLngrnkuIrvvIxcbiAqIOaXouaPkOS+m+WPr+ingei6q+S7ve+8iEZpZ21hIOiKgueCuSBpZO+8ie+8jOS5n+S/neWtmOS4iuasoeWvvOWFpeaXtueahOinhuiniS/lrZDmoJHmjIfnurnvvIxcbiAqIOS9v+mHjeaWsOWvvOWFpeiDveWcqOS4jeaJk+W8gCBQcmVmYWIg55qE5oOF5Ya15LiL5Yik5patXCLorr7orqHmlLnkuobku4DkuYhcIuOAglxuICpcbiAqIOWuieWFqOi+ueeVjO+8mmZpbGUga2V5IOWPquS7pSBTSEEtMjU2IOW9ouW8j+S/neWtmO+8m25vZGUgaWQg5oyJ6ZyA5rGC5piO5paH5L+d5a2Y77yMXG4gKiDkuI4gUHJvamVjdCBQcm9maWxlIOS4rSBub2RlTWFwcyAvIG5vZGVPdmVycmlkZXMg55qE5pei5pyJ5piO5paH5LiA6Ie044CCXG4gKi9cbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ0hFTUEgPSAxIGFzIGNvbnN0O1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NMQVNTID0gJ0ZpZ21hU3luY05vZGUnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZPTERFUiA9ICdmaWdtYS1pbXBvcnRlci1ydW50aW1lJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GSUxFID0gJ0ZpZ21hU3luY05vZGUudHMnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9VUkwgPSBgZGI6Ly9hc3NldHMvJHtTWU5DX01BUktFUl9GT0xERVJ9LyR7U1lOQ19NQVJLRVJfRklMRX1gO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NBVEVHT1JZID0gJ0ZpZ21hIEltcG9ydGVyJztcblxuLyoqIOagh+iusOe7hOS7tuWcqCBQcmVmYWIg5Lit5L+d5a2Y55qE5a2X5q6144CCICovXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xuICAgIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXI7XG4gICAgZmlnbWFGaWxlSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hTm9kZUlkOiBzdHJpbmc7XG4gICAgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZztcbiAgICBmaWdtYUFsaWFzSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgeyBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VySW5wdXQge1xuICAgIGZpbGVLZXk6IHN0cmluZztcbiAgICBub2RlOiBGaWdtYU5vZGU7XG4gICAgLyoqIOiiq+aKmOWPoOWQuOaUtueahOWtkOWxgiBpZO+8iOS4jeWQqyBub2RlIOiHqui6q++8ieOAgiAqL1xuICAgIGFsaWFzTm9kZUlkcz86IHN0cmluZ1tdO1xuICAgIHNjaGVtYT86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcGFyaXNvbiB7XG4gICAgLyoqIOacrOiKgueCueeahOWHoOS9leOAgeaYvumakOOAgeWkluinguOAgeaWh+Wtl+aIlue7hOS7tuexu+Wei+WPkeeUn+WPmOWMluOAgiAqL1xuICAgIHZpc3VhbENoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIEZpZ21hIOWtkOagkeWGheS7u+aEj+WQjuS7o+WPkeeUn+WPmOWMlu+8iOWQq+aWsOWini/liKDpmaQv5ZCM5ZCN5pu/5o2i77yJ44CCICovXG4gICAgc3VidHJlZUNoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIOaKmOWPoOWtkOWxgumbhuWQiOWPkeeUn+WPmOWMlu+8iOWtkOWxguaWsOWinuOAgeWIoOmZpOaIluiiq+abv+aNou+8ieOAgiAqL1xuICAgIHN0cnVjdHVyZUNoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIOmcgOimgemHjeaWsOeUn+aIkOWbvueJh+i1hOa6kOaJjeiDveWPjeaYoOiuvuiuoeWPmOWMluOAgiAqL1xuICAgIGFzc2V0U3RhbGU6IGJvb2xlYW47XG59XG5cbmNvbnN0IFNIQTI1Nl9QQVRURVJOID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC87XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTeW5jTm9kZUlkKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiB2YWx1ZS50cmltKCkucmVwbGFjZSgvLS9nLCAnOicpO1xufVxuXG5mdW5jdGlvbiBmaW5pdGVPck51bGwodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB8IG51bGwge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBxdWFudGl6ZURlY2ltYWwodmFsdWUsIDQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZnJhbWVQYXlsb2FkKGZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkKTogbnVtYmVyW10gfCBudWxsIHtcbiAgICBpZiAoIWZyYW1lKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gW1xuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueCkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLnkpID8/IDAsXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS53aWR0aCkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLmhlaWdodCkgPz8gMCxcbiAgICBdO1xufVxuXG5mdW5jdGlvbiBwYWludFBheWxvYWQocGFpbnQ6IEZpZ21hUGFpbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogcGFpbnQudHlwZSxcbiAgICAgICAgdmlzaWJsZTogcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UsXG4gICAgICAgIG9wYWNpdHk6IGZpbml0ZU9yTnVsbChwYWludC5vcGFjaXR5ID8/IDEpLFxuICAgICAgICBibGVuZE1vZGU6IHBhaW50LmJsZW5kTW9kZSA/PyBudWxsLFxuICAgICAgICBjb2xvcjogcGFpbnQuY29sb3JcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuZyksXG4gICAgICAgICAgICAgICAgYjogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBpbWFnZVJlZjogcGFpbnQuaW1hZ2VSZWYgPz8gbnVsbCxcbiAgICAgICAgc2NhbGVNb2RlOiBwYWludC5zY2FsZU1vZGUgPz8gbnVsbCxcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChwYWludC5yb3RhdGlvbiksXG4gICAgICAgIHNvdXJjZU5vZGVJZDogcGFpbnQuc291cmNlTm9kZUlkID8/IG51bGwsXG4gICAgICAgIHRpbGVUeXBlOiBwYWludC50aWxlVHlwZSA/PyBudWxsLFxuICAgICAgICBzY2FsaW5nRmFjdG9yOiBmaW5pdGVPck51bGwocGFpbnQuc2NhbGluZ0ZhY3RvciksXG4gICAgICAgIHNwYWNpbmc6IHBhaW50LnNwYWNpbmdcbiAgICAgICAgICAgID8gW2Zpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLngpLCBmaW5pdGVPck51bGwocGFpbnQuc3BhY2luZy55KV1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgaG9yaXpvbnRhbEFsaWdubWVudDogcGFpbnQuaG9yaXpvbnRhbEFsaWdubWVudCA/PyBudWxsLFxuICAgICAgICB2ZXJ0aWNhbEFsaWdubWVudDogcGFpbnQudmVydGljYWxBbGlnbm1lbnQgPz8gbnVsbCxcbiAgICAgICAgZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnM6IEFycmF5LmlzQXJyYXkocGFpbnQuZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnMpXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zLm1hcCgoaGFuZGxlKSA9PiBbZmluaXRlT3JOdWxsKGhhbmRsZS54KSwgZmluaXRlT3JOdWxsKGhhbmRsZS55KV0pXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGdyYWRpZW50U3RvcHM6IEFycmF5LmlzQXJyYXkocGFpbnQuZ3JhZGllbnRTdG9wcylcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRTdG9wcy5tYXAoKHN0b3ApID0+IFtmaW5pdGVPck51bGwoc3RvcC5wb3NpdGlvbiksIHN0b3AuY29sb3JcbiAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuciksXG4gICAgICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmcpLFxuICAgICAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5iKSxcbiAgICAgICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuYSA/PyAxKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiBudWxsXSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgLy8g5Zu+54mH6KOB5YiH55+p6Zi15LiO5ruk6ZWc5ZCM5qC35pS55Y+Y5YOP57Sg77yM5L2G5LiN5Lya5pS55Y+YIGltYWdlUmVm77yb5ryP5o6J5a6D5Lus5Lya6K6pXG4gICAgICAgIC8vIOaVtOWxguiKgueCueWcqOmHjeWvvOWFpeWQjue7p+e7reaYvuekuuaXp+WbvuOAglxuICAgICAgICBpbWFnZVRyYW5zZm9ybTogQXJyYXkuaXNBcnJheShwYWludC5pbWFnZVRyYW5zZm9ybSlcbiAgICAgICAgICAgID8gcGFpbnQuaW1hZ2VUcmFuc2Zvcm0ubWFwKChyb3cpID0+IChBcnJheS5pc0FycmF5KHJvdylcbiAgICAgICAgICAgICAgICA/IHJvdy5tYXAoKHZhbHVlKSA9PiBmaW5pdGVPck51bGwodmFsdWUpKVxuICAgICAgICAgICAgICAgIDogbnVsbCkpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGZpbHRlcnM6IHBhaW50LmZpbHRlcnNcbiAgICAgICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKHBhaW50LmZpbHRlcnMpXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpXG4gICAgICAgICAgICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiBba2V5LCBmaW5pdGVPck51bGwodmFsdWUpXSkpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gZWZmZWN0UGF5bG9hZChlZmZlY3Q6IEZpZ21hRWZmZWN0KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IGVmZmVjdC50eXBlLFxuICAgICAgICB2aXNpYmxlOiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UsXG4gICAgICAgIHJhZGl1czogZmluaXRlT3JOdWxsKGVmZmVjdC5yYWRpdXMpLFxuICAgICAgICBzcHJlYWQ6IGZpbml0ZU9yTnVsbChlZmZlY3Quc3ByZWFkKSxcbiAgICAgICAgb2Zmc2V0WDogZmluaXRlT3JOdWxsKGVmZmVjdC5vZmZzZXQ/LngpLFxuICAgICAgICBvZmZzZXRZOiBmaW5pdGVPck51bGwoZWZmZWN0Lm9mZnNldD8ueSksXG4gICAgICAgIGNvbG9yOiBlZmZlY3QuY29sb3JcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuciksXG4gICAgICAgICAgICAgICAgZzogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5nKSxcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuYSA/PyAxKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiB0ZXh0UGF5bG9hZChzdHlsZTogRmlnbWFUZXh0U3R5bGUgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICAgIGlmICghc3R5bGUpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIGZvbnRGYW1pbHk6IHN0eWxlLmZvbnRGYW1pbHkgPz8gbnVsbCxcbiAgICAgICAgZm9udFBvc3RTY3JpcHROYW1lOiBzdHlsZS5mb250UG9zdFNjcmlwdE5hbWUgPz8gbnVsbCxcbiAgICAgICAgZm9udFdlaWdodDogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRXZWlnaHQpLFxuICAgICAgICBmb250U2l6ZTogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRTaXplKSxcbiAgICAgICAgdGV4dEFsaWduSG9yaXpvbnRhbDogc3R5bGUudGV4dEFsaWduSG9yaXpvbnRhbCA/PyBudWxsLFxuICAgICAgICB0ZXh0QWxpZ25WZXJ0aWNhbDogc3R5bGUudGV4dEFsaWduVmVydGljYWwgPz8gbnVsbCxcbiAgICAgICAgbGV0dGVyU3BhY2luZzogZmluaXRlT3JOdWxsKHN0eWxlLmxldHRlclNwYWNpbmcpLFxuICAgICAgICBsaW5lSGVpZ2h0UHg6IGZpbml0ZU9yTnVsbChzdHlsZS5saW5lSGVpZ2h0UHgpLFxuICAgICAgICB0ZXh0QXV0b1Jlc2l6ZTogc3R5bGUudGV4dEF1dG9SZXNpemUgPz8gbnVsbCxcbiAgICAgICAgdGV4dFRydW5jYXRpb246IHN0eWxlLnRleHRUcnVuY2F0aW9uID8/IG51bGwsXG4gICAgICAgIG1heExpbmVzOiBmaW5pdGVPck51bGwoc3R5bGUubWF4TGluZXMpLFxuICAgIH07XG59XG5cbi8qKlxuICog5pys6IqC54K56Ieq6Lqr55qE6KeG6KeJ6LSh54yu77ya5Yeg5L2V44CB5pi+6ZqQ44CB5aGr5YWFL+aPj+i+uS/nibnmlYjjgIHlnIbop5LjgIHmloflrZfkuI7moLflvI/jgIJcbiAqIOS4jeWMheWQq+WtkOiKgueCue+8jOWboOatpOaKmOWPoOeItuiKgueCueeahOaMh+e6ueS4jeS8muWboOWtkOWxguenu+WKqOiAjOWPmOWMluOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbFBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIGlkOiBub3JtYWxpemVTeW5jTm9kZUlkKG5vZGUuaWQpLFxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXG4gICAgICAgIGZyYW1lOiBmcmFtZVBheWxvYWQobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSxcbiAgICAgICAgcmVuZGVyQm91bmRzOiBmcmFtZVBheWxvYWQobm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcyksXG4gICAgICAgIHNpemU6IG5vZGUuc2l6ZVxuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS53aWR0aCksIGZpbml0ZU9yTnVsbChub2RlLnNpemUuaGVpZ2h0KV1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChub2RlLnJvdGF0aW9uKSxcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgb3BhY2l0eTogZmluaXRlT3JOdWxsKG5vZGUub3BhY2l0eSA/PyAxKSxcbiAgICAgICAgYmxlbmRNb2RlOiBub2RlLmJsZW5kTW9kZSA/PyBudWxsLFxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50ID09PSB0cnVlLFxuICAgICAgICBjb3JuZXJSYWRpdXM6IGZpbml0ZU9yTnVsbChub2RlLmNvcm5lclJhZGl1cyksXG4gICAgICAgIHJlY3RhbmdsZUNvcm5lclJhZGlpOiBBcnJheS5pc0FycmF5KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkpXG4gICAgICAgICAgICA/IG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IGZpbml0ZU9yTnVsbChyYWRpdXMpKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICAvLyDlnIblvKfnmoTotbfmraLop5LkuI7lhoXljYrlvoTlj6rmlLnlg4/ntKDvvIzkuI3mlLnlpJbmoYbvvJvkuI3nurPlhaXmjIfnurnkvJrmvI/mjonmlbTlsYLoioLngrnnmoTmlrDlvaLnirbjgIJcbiAgICAgICAgYXJjRGF0YTogbm9kZS5hcmNEYXRhXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBzdGFydGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLnN0YXJ0aW5nQW5nbGUpLFxuICAgICAgICAgICAgICAgIGVuZGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmVuZGluZ0FuZ2xlKSxcbiAgICAgICAgICAgICAgICBpbm5lclJhZGl1czogZmluaXRlT3JOdWxsKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGZpbGxzOiAobm9kZS5maWxscyA/PyBbXSkubWFwKHBhaW50UGF5bG9hZCksXG4gICAgICAgIHN0cm9rZXM6IChub2RlLnN0cm9rZXMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxuICAgICAgICBzdHJva2VXZWlnaHQ6IGZpbml0ZU9yTnVsbChub2RlLnN0cm9rZVdlaWdodCksXG4gICAgICAgIHN0cm9rZUFsaWduOiBub2RlLnN0cm9rZUFsaWduID8/IG51bGwsXG4gICAgICAgIGVmZmVjdHM6IChub2RlLmVmZmVjdHMgPz8gW10pLm1hcChlZmZlY3RQYXlsb2FkKSxcbiAgICAgICAgY2hhcmFjdGVyczogdHlwZW9mIG5vZGUuY2hhcmFjdGVycyA9PT0gJ3N0cmluZycgPyBub2RlLmNoYXJhY3RlcnMgOiBudWxsLFxuICAgICAgICB0ZXh0U3R5bGU6IHRleHRQYXlsb2FkKG5vZGUuc3R5bGUpLFxuICAgIH07XG59XG5cbi8qKiDlrZDmoJHnu5PmnoTvvJrmnKzoioLngrnmjIfnurkgKyDpgJDlsYLlrZDoioLngrnmjIfnurnvvIznlKjkuo7liKTmlq3muLLmn5PlnovoioLngrnmmK/lkKbpnIDopoHph43mlrDlh7rlm77jgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU3VidHJlZVBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHZpc3VhbDogc3luY1Zpc3VhbFBheWxvYWQobm9kZSksXG4gICAgICAgIGNoaWxkcmVuOiAobm9kZS5jaGlsZHJlbiA/PyBbXSkubWFwKChjaGlsZCkgPT4gc3luY1N1YnRyZWVQYXlsb2FkKGNoaWxkKSksXG4gICAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNWaXN1YWxIYXNoKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1Zpc3VhbFBheWxvYWQobm9kZSkpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlKSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBjb25zdCBpZHMgPSBbLi4ubmV3IFNldChhbGlhc05vZGVJZHMubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpLmZpbHRlcihCb29sZWFuKSldLnNvcnQoKTtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShpZHMpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNGaWxlSGFzaChmaWxlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBmaWxlS2V5LnRyaW0oKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXnvLrlsJEgRmlnbWEgZmlsZSBrZXnjgIInKTtcbiAgICB9XG4gICAgcmV0dXJuIHNoYTI1NihgZmlnbWEtaW1wb3J0ZXI6c3luYy1maWxlOnYxXFwwJHtub3JtYWxpemVkfWApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3luY01hcmtlcihpbnB1dDogU3luY01hcmtlcklucHV0KTogU3luY01hcmtlclNwZWMge1xuICAgIGNvbnN0IG5vZGVJZCA9IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaW5wdXQubm9kZS5pZCk7XG4gICAgaWYgKCFub2RlSWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXoioLngrnnvLrlsJEgRmlnbWEg6IqC54K5IGlk44CCJyk7XG4gICAgfVxuICAgIGNvbnN0IGFsaWFzTm9kZUlkcyA9IFsuLi5uZXcgU2V0KChpbnB1dC5hbGlhc05vZGVJZHMgPz8gW10pXG4gICAgICAgIC5tYXAobm9ybWFsaXplU3luY05vZGVJZClcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IEJvb2xlYW4oaWQpICYmIGlkICE9PSBub2RlSWQpKV0uc29ydCgpO1xuICAgIHJldHVybiB7XG4gICAgICAgIHNjaGVtYTogaW5wdXQuc2NoZW1hID8/IFNZTkNfTUFSS0VSX1NDSEVNQSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogc3luY0ZpbGVIYXNoKGlucHV0LmZpbGVLZXkpLFxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxuICAgICAgICBhbGlhc05vZGVJZHMsXG4gICAgICAgIGFsaWFzSGFzaDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpLFxuICAgICAgICB2aXN1YWxIYXNoOiBzeW5jVmlzdWFsSGFzaChpbnB1dC5ub2RlKSxcbiAgICAgICAgc3VidHJlZUhhc2g6IHN5bmNTdWJ0cmVlSGFzaChpbnB1dC5ub2RlKSxcbiAgICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVN5bmNNYXJrZXIoXG4gICAgcHJldmlvdXM6IFN5bmNNYXJrZXJTcGVjLFxuICAgIG5leHQ6IFN5bmNNYXJrZXJTcGVjLFxuKTogU3luY01hcmtlckNvbXBhcmlzb24ge1xuICAgIGNvbnN0IHZpc3VhbENoYW5nZWQgPSBwcmV2aW91cy52aXN1YWxIYXNoICE9PSBuZXh0LnZpc3VhbEhhc2g7XG4gICAgY29uc3Qgc3VidHJlZUNoYW5nZWQgPSBwcmV2aW91cy5zdWJ0cmVlSGFzaCAhPT0gbmV4dC5zdWJ0cmVlSGFzaDtcbiAgICBjb25zdCBzdHJ1Y3R1cmVDaGFuZ2VkID0gcHJldmlvdXMuYWxpYXNIYXNoICE9PSBuZXh0LmFsaWFzSGFzaFxuICAgICAgICB8fCBwcmV2aW91cy5hbGlhc05vZGVJZHMuam9pbignLCcpICE9PSBuZXh0LmFsaWFzTm9kZUlkcy5qb2luKCcsJyk7XG4gICAgY29uc3Qgc291cmNlQ2hhbmdlZCA9IHByZXZpb3VzLmZpZ21hRmlsZUhhc2ggIT09IG5leHQuZmlnbWFGaWxlSGFzaFxuICAgICAgICB8fCBwcmV2aW91cy5maWdtYU5vZGVJZCAhPT0gbmV4dC5maWdtYU5vZGVJZDtcbiAgICByZXR1cm4ge1xuICAgICAgICB2aXN1YWxDaGFuZ2VkLFxuICAgICAgICBzdWJ0cmVlQ2hhbmdlZCxcbiAgICAgICAgc3RydWN0dXJlQ2hhbmdlZCxcbiAgICAgICAgLy8g5o2i5LqG5p2l5rqQ44CB5Yeg5L2V44CB5a2Q5qCR5oiW5oqY5Y+g6ZuG5ZCI77yM6YO95oSP5ZGz552A6L+Z5byg5Zu+5LiN5YaN5piv5LiK5qyh5a+85Ye655qE6YKj5byg44CCXG4gICAgICAgIGFzc2V0U3RhbGU6IHZpc3VhbENoYW5nZWQgfHwgc3VidHJlZUNoYW5nZWQgfHwgc3RydWN0dXJlQ2hhbmdlZCB8fCBzb3VyY2VDaGFuZ2VkLFxuICAgIH07XG59XG5cbi8qKiDliKTmlq3kuIDkuKrkuI3pgI/mmI7op4bop4noioLngrnvvIjnn6Lph48v5pW05bGCIFBORy/mipjlj6DljIXoo4XvvInmmK/lkKbpnIDopoHph43mlrDnlJ/miJDlm77niYfjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jTmVlZHNBc3NldFJlZnJlc2gob3B0aW9uczoge1xuICAgIGNvbXBhcmlzb246IFN5bmNNYXJrZXJDb21wYXJpc29uO1xuICAgIC8qKiDlvZPliY3oioLngrnmmK/lkKbku6UgUE5HIOW9ouW8j+iQveWcsO+8iOaVtOWxgiByZW5kZXLjgIHnn6Lph4/jgIHmipjlj6AgU3ByaXRlL0xhYmVs77yJ44CCICovXG4gICAgcmFzdGVyaXplZDogYm9vbGVhbjtcbn0pOiBib29sZWFuIHtcbiAgICBpZiAoIW9wdGlvbnMucmFzdGVyaXplZCkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBvcHRpb25zLmNvbXBhcmlzb24uYXNzZXRTdGFsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtlclRvQ29tcG9uZW50VmFsdWVzKG1hcmtlcjogU3luY01hcmtlclNwZWMpOiBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBmaWdtYU1hcmtlclNjaGVtYTogbWFya2VyLnNjaGVtYSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogbWFya2VyLmZpZ21hRmlsZUhhc2gsXG4gICAgICAgIGZpZ21hTm9kZUlkOiBtYXJrZXIuZmlnbWFOb2RlSWQsXG4gICAgICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBtYXJrZXIuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSxcbiAgICAgICAgZmlnbWFBbGlhc0hhc2g6IG1hcmtlci5hbGlhc0hhc2gsXG4gICAgICAgIGZpZ21hVmlzdWFsSGFzaDogbWFya2VyLnZpc3VhbEhhc2gsXG4gICAgICAgIGZpZ21hU3VidHJlZUhhc2g6IG1hcmtlci5zdWJ0cmVlSGFzaCxcbiAgICB9O1xufVxuXG4vKiog5LuOIENvY29zIOe7hOS7tuivu+Wbnuagh+iusO+8m+Wtl+autee8uuWkseaIluaNn+Wdj+aXtui/lOWbniBudWxs77yM55Sx6LCD55So5pa5IGZhaWwtY2xvc2Vk44CCICovXG5leHBvcnQgZnVuY3Rpb24gbWFya2VyRnJvbUNvbXBvbmVudFZhbHVlcyhcbiAgICB2YWx1ZXM6IFBhcnRpYWw8U3luY01hcmtlckNvbXBvbmVudFZhbHVlcz4gfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogU3luY01hcmtlclNwZWMgfCBudWxsIHtcbiAgICBpZiAoIXZhbHVlcyB8fCB0eXBlb2YgdmFsdWVzICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3Qgc2NoZW1hID0gdmFsdWVzLmZpZ21hTWFya2VyU2NoZW1hO1xuICAgIGlmIChzY2hlbWEgIT09IFNZTkNfTUFSS0VSX1NDSEVNQSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgZmlsZUhhc2ggPSB2YWx1ZXMuZmlnbWFGaWxlSGFzaDtcbiAgICBjb25zdCBub2RlSWQgPSB0eXBlb2YgdmFsdWVzLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJyA/IG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWVzLmZpZ21hTm9kZUlkKSA6ICcnO1xuICAgIGNvbnN0IHZpc3VhbEhhc2ggPSB2YWx1ZXMuZmlnbWFWaXN1YWxIYXNoO1xuICAgIGNvbnN0IHN1YnRyZWVIYXNoID0gdmFsdWVzLmZpZ21hU3VidHJlZUhhc2g7XG4gICAgaWYgKHR5cGVvZiBmaWxlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QoZmlsZUhhc2gpKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAoIW5vZGVJZCB8fCB0eXBlb2YgdmlzdWFsSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QodmlzdWFsSGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGlmICh0eXBlb2Ygc3VidHJlZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHN1YnRyZWVIYXNoKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcyA9PT0gJ3N0cmluZydcbiAgICAgICAgPyB2YWx1ZXMuZmlnbWFBbGlhc05vZGVJZHMuc3BsaXQoJywnKVxuICAgICAgICAgICAgLm1hcCgoaWQpID0+IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaWQpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLnNvcnQoKVxuICAgICAgICA6IFtdO1xuICAgIGNvbnN0IGFsaWFzSGFzaCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc0hhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hQWxpYXNIYXNoKVxuICAgICAgICA/IHZhbHVlcy5maWdtYUFsaWFzSGFzaFxuICAgICAgICA6IHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBzY2hlbWEsXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IGZpbGVIYXNoLFxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxuICAgICAgICBhbGlhc05vZGVJZHMsXG4gICAgICAgIGFsaWFzSGFzaCxcbiAgICAgICAgdmlzdWFsSGFzaCxcbiAgICAgICAgc3VidHJlZUhhc2gsXG4gICAgfTtcbn1cblxuLyoqXG4gKiDkuIDkuKogRmlnbWEg6IqC54K55Y+q6IO96KKr5LiA5LiqIENvY29zIOiKgueCueWjsOaYju+8iOiHquW3seaIluS9nOS4uuWIq+WQje+8ieOAglxuICog5oqY5Y+g54i25a2Q5ZCM5pe25aOw5piO5ZCM5rqQ6IqC54K55Lya6K6pXCLmlLnlk6rkuKroioLngrlcIuWPmOW+l+S4jeWPr+WIpOWumuOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0VW5pcXVlU3luY093bmVyc2hpcChtYXJrZXJzOiByZWFkb25seSBTeW5jTWFya2VyU3BlY1tdKTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXJzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIFttYXJrZXIuZmlnbWFOb2RlSWQsIC4uLm1hcmtlci5hbGlhc05vZGVJZHNdKSB7XG4gICAgICAgICAgICBjb25zdCBvd25lciA9IG93bmVycy5nZXQobm9kZUlkKTtcbiAgICAgICAgICAgIGlmIChvd25lciAmJiBvd25lciAhPT0gbWFya2VyLmZpZ21hTm9kZUlkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgRmlnbWEg6IqC54K5ICR7bm9kZUlkfSDlkIzml7booqsgJHtvd25lcn0g5ZKMICR7bWFya2VyLmZpZ21hTm9kZUlkfSDlo7DmmI7vvIzlt7Lmi5Lnu53nlJ/miJDlkIzmraXmoIforrDjgIJgLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvd25lcnMuc2V0KG5vZGVJZCwgbWFya2VyLmZpZ21hTm9kZUlkKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqIOmcgOimgeWcqOmhueebriBhc3NldHMg5Lit55Sf5oiQ55qE5pyA5bCP5qCH6K6w57uE5Lu25rqQ56CB77yI5peg5Lia5Yqh6YC76L6R77yM5Y+q5L+d5a2Y5p2l5rqQ5LiO5oyH57q577yJ44CCICovXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfU0NSSVBUX1NPVVJDRSA9IGBpbXBvcnQgeyBfZGVjb3JhdG9yLCBDb21wb25lbnQgfSBmcm9tICdjYyc7XG5cbmNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHksIG1lbnUgfSA9IF9kZWNvcmF0b3I7XG5cbi8qKlxuICogRmlnbWEgSW1wb3J0ZXIg55Sf5oiQ55qE5ZCM5q2l5qCH6K6w44CC5a2X5q6155Sx5o+S5Lu257u05oqk77yM5omL5bel5L+u5pS55Lya5a+86Ie05LiL5qyh5ZCM5q2l6KKr5ouS57ud44CCXG4gKiDliKDpmaTmnKznu4Tku7bljbPooajnpLror6XoioLngrnpgIDlh7ogRmlnbWEg5ZCM5q2l77ya5o+S5Lu25LiN5Lya5YaN56e75Yqo44CB57yp5pS+5oiW5Yig6Zmk5a6D44CCXG4gKi9cbkBjY2NsYXNzKCcke1NZTkNfTUFSS0VSX0NMQVNTfScpXG5AbWVudSgnJHtTWU5DX01BUktFUl9DQVRFR09SWX0vJHtTWU5DX01BUktFUl9DTEFTU30nKVxuZXhwb3J0IGNsYXNzICR7U1lOQ19NQVJLRVJfQ0xBU1N9IGV4dGVuZHMgQ29tcG9uZW50IHtcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5qCH6K6w5Y2P6K6u54mI5pysJyB9KVxuICAgIHB1YmxpYyBmaWdtYU1hcmtlclNjaGVtYTogbnVtYmVyID0gJHtTWU5DX01BUktFUl9TQ0hFTUF9O1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOaWh+S7tiBrZXkg55qEIFNIQS0yNTYnIH0pXG4gICAgcHVibGljIGZpZ21hRmlsZUhhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOiKgueCuSBpZCcgfSlcbiAgICBwdWJsaWMgZmlnbWFOb2RlSWQ6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+iiq+aKmOWPoOWIsOacrOiKgueCueeahCBGaWdtYSDlrZDlsYIgaWTvvIzpgJflj7fliIbpmpQnIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNOb2RlSWRzOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmipjlj6DlrZDlsYLpm4blkIjmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoToioLngrnop4bop4nmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5a2Q5qCR5oyH57q5JyB9KVxuICAgIHB1YmxpYyBmaWdtYVN1YnRyZWVIYXNoOiBzdHJpbmcgPSAnJztcbn1cbmA7XG5cbi8qKiDpqozor4HnlJ/miJDliLDpobnnm67ph4znmoTohJrmnKzmsqHmnInooqvmiKrmlq3miJbooqvmlLnmiJDliKvnmoTnsbvjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJTY3JpcHQoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdHlwZW9mIHNvdXJjZSA9PT0gJ3N0cmluZydcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBAY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKWApXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnRgKVxuICAgICAgICAmJiBzb3VyY2UuaW5jbHVkZXMoJ2ZpZ21hU3VidHJlZUhhc2gnKTtcbn1cbiJdfQ==