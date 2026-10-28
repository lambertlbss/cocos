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

const { ccclass, property } = _decorator;

/**
 * Figma Importer 生成的同步标记。字段由插件维护，手工修改会导致下次同步被拒绝。
 * 删除本组件即表示该节点退出 Figma 同步：插件不会再移动、缩放或删除它。
 */
@ccclass('${exports.SYNC_MARKER_CLASS}')
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBc0RBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFFRCwwQ0FFQztBQUVELHNDQUdDO0FBRUQsb0NBTUM7QUFFRCw0Q0FpQkM7QUFFRCw4Q0FpQkM7QUFHRCxzREFTQztBQUVELDBEQVVDO0FBR0QsOERBeUNDO0FBTUQsOERBYUM7QUFxQ0QsZ0RBS0M7QUE5WUQsZ0VBQTBGO0FBRTFGOzs7Ozs7Ozs7R0FTRztBQUNVLFFBQUEsa0JBQWtCLEdBQUcsQ0FBVSxDQUFDO0FBQ2hDLFFBQUEsaUJBQWlCLEdBQUcsZUFBZSxDQUFDO0FBQ3BDLFFBQUEsa0JBQWtCLEdBQUcsd0JBQXdCLENBQUM7QUFDOUMsUUFBQSxnQkFBZ0IsR0FBRyxrQkFBa0IsQ0FBQztBQUN0QyxRQUFBLHNCQUFzQixHQUFHLGVBQWUsMEJBQWtCLElBQUksd0JBQWdCLEVBQUUsQ0FBQztBQUNqRixRQUFBLG9CQUFvQixHQUFHLGdCQUFnQixDQUFDO0FBa0NyRCxNQUFNLGNBQWMsR0FBRyx1QkFBdUIsQ0FBQztBQUUvQyxTQUFnQixtQkFBbUIsQ0FBQyxLQUFhO0lBQzdDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQXlCO0lBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUEsZ0NBQWUsRUFBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNsRyxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBdUI7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QU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxXQUFXLEVBQUUsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQztZQUNoRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ3hDLE1BQU0sSUFBSSxLQUFLLENBQ1gsWUFBWSxNQUFNLFFBQVEsS0FBSyxNQUFNLE1BQU0sQ0FBQyxXQUFXLGdCQUFnQixDQUMxRSxDQUFDO1lBQ04sQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMzQyxDQUFDO0lBQ0wsQ0FBQztBQUNMLENBQUM7QUFFRCxpREFBaUQ7QUFDcEMsUUFBQSx5QkFBeUIsR0FBRzs7Ozs7Ozs7WUFRN0IseUJBQWlCO2VBQ2QseUJBQWlCOzt5Q0FFUywwQkFBa0I7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0IxRCxDQUFDO0FBRUYsK0JBQStCO0FBQy9CLFNBQWdCLGtCQUFrQixDQUFDLE1BQWM7SUFDN0MsT0FBTyxPQUFPLE1BQU0sS0FBSyxRQUFRO1dBQzFCLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSx5QkFBaUIsSUFBSSxDQUFDO1dBQ25ELE1BQU0sQ0FBQyxRQUFRLENBQUMsU0FBUyx5QkFBaUIsb0JBQW9CLENBQUM7V0FDL0QsTUFBTSxDQUFDLFFBQVEsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQy9DLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEZpZ21hRWZmZWN0LCBGaWdtYU5vZGUsIEZpZ21hUGFpbnQsIEZpZ21hVGV4dFN0eWxlLCBSZWN0LCBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcbmltcG9ydCB7IGNhbm9uaWNhbFN0cmluZ2lmeSwgcXVhbnRpemVEZWNpbWFsLCBzaGEyNTYgfSBmcm9tICcuLi9yb3VuZHRyaXAvY2Fub25pY2FsLWpzb24nO1xuXG4vKipcbiAqIOe7hOS7tue6p+WPjOi+ueWQjOatpe+8iENvbXBvbmVudCBTeW5j77yJ55qE5qCH6K6w5Y2P6K6u44CCXG4gKlxuICog5qCH6K6w57uE5Lu2IGBGaWdtYVN5bmNOb2RlYCDmjILlnKjmr4/kuKrnlLHlkIzmraXmqKHlvI/nlJ/miJDnmoQgQ29jb3Mg6IqC54K55LiK77yMXG4gKiDml6Lmj5Dkvpvlj6/op4Houqvku73vvIhGaWdtYSDoioLngrkgaWTvvInvvIzkuZ/kv53lrZjkuIrmrKHlr7zlhaXml7bnmoTop4bop4kv5a2Q5qCR5oyH57q577yMXG4gKiDkvb/ph43mlrDlr7zlhaXog73lnKjkuI3miZPlvIAgUHJlZmFiIOeahOaDheWGteS4i+WIpOaWrVwi6K6+6K6h5pS55LqG5LuA5LmIXCLjgIJcbiAqXG4gKiDlronlhajovrnnlYzvvJpmaWxlIGtleSDlj6rku6UgU0hBLTI1NiDlvaLlvI/kv53lrZjvvJtub2RlIGlkIOaMiemcgOaxguaYjuaWh+S/neWtmO+8jFxuICog5LiOIFByb2plY3QgUHJvZmlsZSDkuK0gbm9kZU1hcHMgLyBub2RlT3ZlcnJpZGVzIOeahOaXouacieaYjuaWh+S4gOiHtOOAglxuICovXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfU0NIRU1BID0gMSBhcyBjb25zdDtcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DTEFTUyA9ICdGaWdtYVN5bmNOb2RlJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GT0xERVIgPSAnZmlnbWEtaW1wb3J0ZXItcnVudGltZSc7XG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfRklMRSA9ICdGaWdtYVN5bmNOb2RlLnRzJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfVVJMID0gYGRiOi8vYXNzZXRzLyR7U1lOQ19NQVJLRVJfRk9MREVSfS8ke1NZTkNfTUFSS0VSX0ZJTEV9YDtcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DQVRFR09SWSA9ICdGaWdtYSBJbXBvcnRlcic7XG5cbi8qKiDmoIforrDnu4Tku7blnKggUHJlZmFiIOS4reS/neWtmOeahOWtl+auteOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcbiAgICBmaWdtYU1hcmtlclNjaGVtYTogbnVtYmVyO1xuICAgIGZpZ21hRmlsZUhhc2g6IHN0cmluZztcbiAgICBmaWdtYU5vZGVJZDogc3RyaW5nO1xuICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBzdHJpbmc7XG4gICAgZmlnbWFBbGlhc0hhc2g6IHN0cmluZztcbiAgICBmaWdtYVZpc3VhbEhhc2g6IHN0cmluZztcbiAgICBmaWdtYVN1YnRyZWVIYXNoOiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIHsgU3luY01hcmtlclNwZWMgfSBmcm9tICcuLi90eXBlcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY01hcmtlcklucHV0IHtcbiAgICBmaWxlS2V5OiBzdHJpbmc7XG4gICAgbm9kZTogRmlnbWFOb2RlO1xuICAgIC8qKiDooqvmipjlj6DlkLjmlLbnmoTlrZDlsYIgaWTvvIjkuI3lkKsgbm9kZSDoh6rouqvvvInjgIIgKi9cbiAgICBhbGlhc05vZGVJZHM/OiBzdHJpbmdbXTtcbiAgICBzY2hlbWE/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3luY01hcmtlckNvbXBhcmlzb24ge1xuICAgIC8qKiDmnKzoioLngrnnmoTlh6DkvZXjgIHmmL7pmpDjgIHlpJbop4LjgIHmloflrZfmiJbnu4Tku7bnsbvlnovlj5HnlJ/lj5jljJbjgIIgKi9cbiAgICB2aXN1YWxDaGFuZ2VkOiBib29sZWFuO1xuICAgIC8qKiBGaWdtYSDlrZDmoJHlhoXku7vmhI/lkI7ku6Plj5HnlJ/lj5jljJbvvIjlkKvmlrDlop4v5Yig6ZmkL+WQjOWQjeabv+aNou+8ieOAgiAqL1xuICAgIHN1YnRyZWVDaGFuZ2VkOiBib29sZWFuO1xuICAgIC8qKiDmipjlj6DlrZDlsYLpm4blkIjlj5HnlJ/lj5jljJbvvIjlrZDlsYLmlrDlop7jgIHliKDpmaTmiJbooqvmm7/mjaLvvInjgIIgKi9cbiAgICBzdHJ1Y3R1cmVDaGFuZ2VkOiBib29sZWFuO1xuICAgIC8qKiDpnIDopoHph43mlrDnlJ/miJDlm77niYfotYTmupDmiY3og73lj43mmKDorr7orqHlj5jljJbjgIIgKi9cbiAgICBhc3NldFN0YWxlOiBib29sZWFuO1xufVxuXG5jb25zdCBTSEEyNTZfUEFUVEVSTiA9IC9ec2hhMjU2OlswLTlhLWZdezY0fSQvO1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3luY05vZGVJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gdmFsdWUudHJpbSgpLnJlcGxhY2UoLy0vZywgJzonKTtcbn1cblxuZnVuY3Rpb24gZmluaXRlT3JOdWxsKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIgfCBudWxsIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gcXVhbnRpemVEZWNpbWFsKHZhbHVlLCA0KSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGZyYW1lUGF5bG9hZChmcmFtZTogUmVjdCB8IHVuZGVmaW5lZCk6IG51bWJlcltdIHwgbnVsbCB7XG4gICAgaWYgKCFmcmFtZSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIFtcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLngpID8/IDAsXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS55KSA/PyAwLFxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUud2lkdGgpID8/IDAsXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS5oZWlnaHQpID8/IDAsXG4gICAgXTtcbn1cblxuZnVuY3Rpb24gcGFpbnRQYXlsb2FkKHBhaW50OiBGaWdtYVBhaW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IHBhaW50LnR5cGUsXG4gICAgICAgIHZpc2libGU6IHBhaW50LnZpc2libGUgIT09IGZhbHNlLFxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwocGFpbnQub3BhY2l0eSA/PyAxKSxcbiAgICAgICAgYmxlbmRNb2RlOiBwYWludC5ibGVuZE1vZGUgPz8gbnVsbCxcbiAgICAgICAgY29sb3I6IHBhaW50LmNvbG9yXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuciksXG4gICAgICAgICAgICAgICAgZzogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLmcpLFxuICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5iKSxcbiAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuYSA/PyAxKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgaW1hZ2VSZWY6IHBhaW50LmltYWdlUmVmID8/IG51bGwsXG4gICAgICAgIHNjYWxlTW9kZTogcGFpbnQuc2NhbGVNb2RlID8/IG51bGwsXG4gICAgICAgIHJvdGF0aW9uOiBmaW5pdGVPck51bGwocGFpbnQucm90YXRpb24pLFxuICAgICAgICBzb3VyY2VOb2RlSWQ6IHBhaW50LnNvdXJjZU5vZGVJZCA/PyBudWxsLFxuICAgICAgICB0aWxlVHlwZTogcGFpbnQudGlsZVR5cGUgPz8gbnVsbCxcbiAgICAgICAgc2NhbGluZ0ZhY3RvcjogZmluaXRlT3JOdWxsKHBhaW50LnNjYWxpbmdGYWN0b3IpLFxuICAgICAgICBzcGFjaW5nOiBwYWludC5zcGFjaW5nXG4gICAgICAgICAgICA/IFtmaW5pdGVPck51bGwocGFpbnQuc3BhY2luZy54KSwgZmluaXRlT3JOdWxsKHBhaW50LnNwYWNpbmcueSldXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGhvcml6b250YWxBbGlnbm1lbnQ6IHBhaW50Lmhvcml6b250YWxBbGlnbm1lbnQgPz8gbnVsbCxcbiAgICAgICAgdmVydGljYWxBbGlnbm1lbnQ6IHBhaW50LnZlcnRpY2FsQWxpZ25tZW50ID8/IG51bGwsXG4gICAgICAgIGdyYWRpZW50SGFuZGxlUG9zaXRpb25zOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zKVxuICAgICAgICAgICAgPyBwYWludC5ncmFkaWVudEhhbmRsZVBvc2l0aW9ucy5tYXAoKGhhbmRsZSkgPT4gW2Zpbml0ZU9yTnVsbChoYW5kbGUueCksIGZpbml0ZU9yTnVsbChoYW5kbGUueSldKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBncmFkaWVudFN0b3BzOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50U3RvcHMpXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50U3RvcHMubWFwKChzdG9wKSA9PiBbZmluaXRlT3JOdWxsKHN0b3AucG9zaXRpb24pLCBzdG9wLmNvbG9yXG4gICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLnIpLFxuICAgICAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5nKSxcbiAgICAgICAgICAgICAgICAgICAgYjogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuYiksXG4gICAgICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmEgPz8gMSksXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIDogbnVsbF0pXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIC8vIOWbvueJh+ijgeWIh+efqemYteS4jua7pOmVnOWQjOagt+aUueWPmOWDj+e0oO+8jOS9huS4jeS8muaUueWPmCBpbWFnZVJlZu+8m+a8j+aOieWug+S7rOS8muiuqVxuICAgICAgICAvLyDmlbTlsYLoioLngrnlnKjph43lr7zlhaXlkI7nu6fnu63mmL7npLrml6flm77jgIJcbiAgICAgICAgaW1hZ2VUcmFuc2Zvcm06IEFycmF5LmlzQXJyYXkocGFpbnQuaW1hZ2VUcmFuc2Zvcm0pXG4gICAgICAgICAgICA/IHBhaW50LmltYWdlVHJhbnNmb3JtLm1hcCgocm93KSA9PiAoQXJyYXkuaXNBcnJheShyb3cpXG4gICAgICAgICAgICAgICAgPyByb3cubWFwKCh2YWx1ZSkgPT4gZmluaXRlT3JOdWxsKHZhbHVlKSlcbiAgICAgICAgICAgICAgICA6IG51bGwpKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBmaWx0ZXJzOiBwYWludC5maWx0ZXJzXG4gICAgICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhwYWludC5maWx0ZXJzKVxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKVxuICAgICAgICAgICAgICAgIC5tYXAoKFtrZXksIHZhbHVlXSkgPT4gW2tleSwgZmluaXRlT3JOdWxsKHZhbHVlKV0pKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgIH07XG59XG5cbmZ1bmN0aW9uIGVmZmVjdFBheWxvYWQoZWZmZWN0OiBGaWdtYUVmZmVjdCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBlZmZlY3QudHlwZSxcbiAgICAgICAgdmlzaWJsZTogZWZmZWN0LnZpc2libGUgIT09IGZhbHNlLFxuICAgICAgICByYWRpdXM6IGZpbml0ZU9yTnVsbChlZmZlY3QucmFkaXVzKSxcbiAgICAgICAgc3ByZWFkOiBmaW5pdGVPck51bGwoZWZmZWN0LnNwcmVhZCksXG4gICAgICAgIG9mZnNldFg6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py54KSxcbiAgICAgICAgb2Zmc2V0WTogZmluaXRlT3JOdWxsKGVmZmVjdC5vZmZzZXQ/LnkpLFxuICAgICAgICBjb2xvcjogZWZmZWN0LmNvbG9yXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLnIpLFxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuZyksXG4gICAgICAgICAgICAgICAgYjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5iKSxcbiAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmEgPz8gMSksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IG51bGwsXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gdGV4dFBheWxvYWQoc3R5bGU6IEZpZ21hVGV4dFN0eWxlIHwgdW5kZWZpbmVkKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgICBpZiAoIXN0eWxlKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgICBmb250RmFtaWx5OiBzdHlsZS5mb250RmFtaWx5ID8/IG51bGwsXG4gICAgICAgIGZvbnRQb3N0U2NyaXB0TmFtZTogc3R5bGUuZm9udFBvc3RTY3JpcHROYW1lID8/IG51bGwsXG4gICAgICAgIGZvbnRXZWlnaHQ6IGZpbml0ZU9yTnVsbChzdHlsZS5mb250V2VpZ2h0KSxcbiAgICAgICAgZm9udFNpemU6IGZpbml0ZU9yTnVsbChzdHlsZS5mb250U2l6ZSksXG4gICAgICAgIHRleHRBbGlnbkhvcml6b250YWw6IHN0eWxlLnRleHRBbGlnbkhvcml6b250YWwgPz8gbnVsbCxcbiAgICAgICAgdGV4dEFsaWduVmVydGljYWw6IHN0eWxlLnRleHRBbGlnblZlcnRpY2FsID8/IG51bGwsXG4gICAgICAgIGxldHRlclNwYWNpbmc6IGZpbml0ZU9yTnVsbChzdHlsZS5sZXR0ZXJTcGFjaW5nKSxcbiAgICAgICAgbGluZUhlaWdodFB4OiBmaW5pdGVPck51bGwoc3R5bGUubGluZUhlaWdodFB4KSxcbiAgICAgICAgdGV4dEF1dG9SZXNpemU6IHN0eWxlLnRleHRBdXRvUmVzaXplID8/IG51bGwsXG4gICAgICAgIHRleHRUcnVuY2F0aW9uOiBzdHlsZS50ZXh0VHJ1bmNhdGlvbiA/PyBudWxsLFxuICAgICAgICBtYXhMaW5lczogZmluaXRlT3JOdWxsKHN0eWxlLm1heExpbmVzKSxcbiAgICB9O1xufVxuXG4vKipcbiAqIOacrOiKgueCueiHqui6q+eahOinhuiniei0oeeMru+8muWHoOS9leOAgeaYvumakOOAgeWhq+WFhS/mj4/ovrkv54m55pWI44CB5ZyG6KeS44CB5paH5a2X5LiO5qC35byP44CCXG4gKiDkuI3ljIXlkKvlrZDoioLngrnvvIzlm6DmraTmipjlj6DniLboioLngrnnmoTmjIfnurnkuI3kvJrlm6DlrZDlsYLnp7vliqjogIzlj5jljJbjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNWaXN1YWxQYXlsb2FkKG5vZGU6IEZpZ21hTm9kZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICBpZDogbm9ybWFsaXplU3luY05vZGVJZChub2RlLmlkKSxcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxuICAgICAgICBmcmFtZTogZnJhbWVQYXlsb2FkKG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCksXG4gICAgICAgIHJlbmRlckJvdW5kczogZnJhbWVQYXlsb2FkKG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHMpLFxuICAgICAgICBzaXplOiBub2RlLnNpemVcbiAgICAgICAgICAgID8gW2Zpbml0ZU9yTnVsbChub2RlLnNpemUud2lkdGgpLCBmaW5pdGVPck51bGwobm9kZS5zaXplLmhlaWdodCldXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIHJvdGF0aW9uOiBmaW5pdGVPck51bGwobm9kZS5yb3RhdGlvbiksXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSAhPT0gZmFsc2UsXG4gICAgICAgIG9wYWNpdHk6IGZpbml0ZU9yTnVsbChub2RlLm9wYWNpdHkgPz8gMSksXG4gICAgICAgIGJsZW5kTW9kZTogbm9kZS5ibGVuZE1vZGUgPz8gbnVsbCxcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCA9PT0gdHJ1ZSxcbiAgICAgICAgY29ybmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5jb3JuZXJSYWRpdXMpLFxuICAgICAgICByZWN0YW5nbGVDb3JuZXJSYWRpaTogQXJyYXkuaXNBcnJheShub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpKVxuICAgICAgICAgICAgPyBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpLm1hcCgocmFkaXVzKSA9PiBmaW5pdGVPck51bGwocmFkaXVzKSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgLy8g5ZyG5byn55qE6LW35q2i6KeS5LiO5YaF5Y2K5b6E5Y+q5pS55YOP57Sg77yM5LiN5pS55aSW5qGG77yb5LiN57qz5YWl5oyH57q55Lya5ryP5o6J5pW05bGC6IqC54K555qE5paw5b2i54q244CCXG4gICAgICAgIGFyY0RhdGE6IG5vZGUuYXJjRGF0YVxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgc3RhcnRpbmdBbmdsZTogZmluaXRlT3JOdWxsKG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKSxcbiAgICAgICAgICAgICAgICBlbmRpbmdBbmdsZTogZmluaXRlT3JOdWxsKG5vZGUuYXJjRGF0YS5lbmRpbmdBbmdsZSksXG4gICAgICAgICAgICAgICAgaW5uZXJSYWRpdXM6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuaW5uZXJSYWRpdXMpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBmaWxsczogKG5vZGUuZmlsbHMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxuICAgICAgICBzdHJva2VzOiAobm9kZS5zdHJva2VzID8/IFtdKS5tYXAocGFpbnRQYXlsb2FkKSxcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiBmaW5pdGVPck51bGwobm9kZS5zdHJva2VXZWlnaHQpLFxuICAgICAgICBzdHJva2VBbGlnbjogbm9kZS5zdHJva2VBbGlnbiA/PyBudWxsLFxuICAgICAgICBlZmZlY3RzOiAobm9kZS5lZmZlY3RzID8/IFtdKS5tYXAoZWZmZWN0UGF5bG9hZCksXG4gICAgICAgIGNoYXJhY3RlcnM6IHR5cGVvZiBub2RlLmNoYXJhY3RlcnMgPT09ICdzdHJpbmcnID8gbm9kZS5jaGFyYWN0ZXJzIDogbnVsbCxcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0UGF5bG9hZChub2RlLnN0eWxlKSxcbiAgICB9O1xufVxuXG4vKiog5a2Q5qCR57uT5p6E77ya5pys6IqC54K55oyH57q5ICsg6YCQ5bGC5a2Q6IqC54K55oyH57q577yM55So5LqO5Yik5pat5riy5p+T5Z6L6IqC54K55piv5ZCm6ZyA6KaB6YeN5paw5Ye65Zu+44CCICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1N1YnRyZWVQYXlsb2FkKG5vZGU6IEZpZ21hTm9kZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICB2aXN1YWw6IHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpLFxuICAgICAgICBjaGlsZHJlbjogKG5vZGUuY2hpbGRyZW4gPz8gW10pLm1hcCgoY2hpbGQpID0+IHN5bmNTdWJ0cmVlUGF5bG9hZChjaGlsZCkpLFxuICAgIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW5jVmlzdWFsSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU3VidHJlZUhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShzeW5jU3VidHJlZVBheWxvYWQobm9kZSkpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gICAgY29uc3QgaWRzID0gWy4uLm5ldyBTZXQoYWxpYXNOb2RlSWRzLm1hcChub3JtYWxpemVTeW5jTm9kZUlkKS5maWx0ZXIoQm9vbGVhbikpXS5zb3J0KCk7XG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoaWRzKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW5jRmlsZUhhc2goZmlsZUtleTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gZmlsZUtleS50cmltKCk7XG4gICAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign57uE5Lu25ZCM5q2l57y65bCRIEZpZ21hIGZpbGUga2V544CCJyk7XG4gICAgfVxuICAgIHJldHVybiBzaGEyNTYoYGZpZ21hLWltcG9ydGVyOnN5bmMtZmlsZTp2MVxcMCR7bm9ybWFsaXplZH1gKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN5bmNNYXJrZXIoaW5wdXQ6IFN5bmNNYXJrZXJJbnB1dCk6IFN5bmNNYXJrZXJTcGVjIHtcbiAgICBjb25zdCBub2RlSWQgPSBub3JtYWxpemVTeW5jTm9kZUlkKGlucHV0Lm5vZGUuaWQpO1xuICAgIGlmICghbm9kZUlkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign57uE5Lu25ZCM5q2l6IqC54K557y65bCRIEZpZ21hIOiKgueCuSBpZOOAgicpO1xuICAgIH1cbiAgICBjb25zdCBhbGlhc05vZGVJZHMgPSBbLi4ubmV3IFNldCgoaW5wdXQuYWxpYXNOb2RlSWRzID8/IFtdKVxuICAgICAgICAubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpXG4gICAgICAgIC5maWx0ZXIoKGlkKSA9PiBCb29sZWFuKGlkKSAmJiBpZCAhPT0gbm9kZUlkKSldLnNvcnQoKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBzY2hlbWE6IGlucHV0LnNjaGVtYSA/PyBTWU5DX01BUktFUl9TQ0hFTUEsXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IHN5bmNGaWxlSGFzaChpbnB1dC5maWxlS2V5KSxcbiAgICAgICAgZmlnbWFOb2RlSWQ6IG5vZGVJZCxcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxuICAgICAgICBhbGlhc0hhc2g6IHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzKSxcbiAgICAgICAgdmlzdWFsSGFzaDogc3luY1Zpc3VhbEhhc2goaW5wdXQubm9kZSksXG4gICAgICAgIHN1YnRyZWVIYXNoOiBzeW5jU3VidHJlZUhhc2goaW5wdXQubm9kZSksXG4gICAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVTeW5jTWFya2VyKFxuICAgIHByZXZpb3VzOiBTeW5jTWFya2VyU3BlYyxcbiAgICBuZXh0OiBTeW5jTWFya2VyU3BlYyxcbik6IFN5bmNNYXJrZXJDb21wYXJpc29uIHtcbiAgICBjb25zdCB2aXN1YWxDaGFuZ2VkID0gcHJldmlvdXMudmlzdWFsSGFzaCAhPT0gbmV4dC52aXN1YWxIYXNoO1xuICAgIGNvbnN0IHN1YnRyZWVDaGFuZ2VkID0gcHJldmlvdXMuc3VidHJlZUhhc2ggIT09IG5leHQuc3VidHJlZUhhc2g7XG4gICAgY29uc3Qgc3RydWN0dXJlQ2hhbmdlZCA9IHByZXZpb3VzLmFsaWFzSGFzaCAhPT0gbmV4dC5hbGlhc0hhc2hcbiAgICAgICAgfHwgcHJldmlvdXMuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSAhPT0gbmV4dC5hbGlhc05vZGVJZHMuam9pbignLCcpO1xuICAgIGNvbnN0IHNvdXJjZUNoYW5nZWQgPSBwcmV2aW91cy5maWdtYUZpbGVIYXNoICE9PSBuZXh0LmZpZ21hRmlsZUhhc2hcbiAgICAgICAgfHwgcHJldmlvdXMuZmlnbWFOb2RlSWQgIT09IG5leHQuZmlnbWFOb2RlSWQ7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdmlzdWFsQ2hhbmdlZCxcbiAgICAgICAgc3VidHJlZUNoYW5nZWQsXG4gICAgICAgIHN0cnVjdHVyZUNoYW5nZWQsXG4gICAgICAgIC8vIOaNouS6huadpea6kOOAgeWHoOS9leOAgeWtkOagkeaIluaKmOWPoOmbhuWQiO+8jOmDveaEj+WRs+edgOi/meW8oOWbvuS4jeWGjeaYr+S4iuasoeWvvOWHuueahOmCo+W8oOOAglxuICAgICAgICBhc3NldFN0YWxlOiB2aXN1YWxDaGFuZ2VkIHx8IHN1YnRyZWVDaGFuZ2VkIHx8IHN0cnVjdHVyZUNoYW5nZWQgfHwgc291cmNlQ2hhbmdlZCxcbiAgICB9O1xufVxuXG4vKiog5Yik5pat5LiA5Liq5LiN6YCP5piO6KeG6KeJ6IqC54K577yI55+i6YePL+aVtOWxgiBQTkcv5oqY5Y+g5YyF6KOF77yJ5piv5ZCm6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH44CCICovXG5leHBvcnQgZnVuY3Rpb24gc3luY05lZWRzQXNzZXRSZWZyZXNoKG9wdGlvbnM6IHtcbiAgICBjb21wYXJpc29uOiBTeW5jTWFya2VyQ29tcGFyaXNvbjtcbiAgICAvKiog5b2T5YmN6IqC54K55piv5ZCm5LulIFBORyDlvaLlvI/okL3lnLDvvIjmlbTlsYIgcmVuZGVy44CB55+i6YeP44CB5oqY5Y+gIFNwcml0ZS9MYWJlbO+8ieOAgiAqL1xuICAgIHJhc3Rlcml6ZWQ6IGJvb2xlYW47XG59KTogYm9vbGVhbiB7XG4gICAgaWYgKCFvcHRpb25zLnJhc3Rlcml6ZWQpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gb3B0aW9ucy5jb21wYXJpc29uLmFzc2V0U3RhbGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrZXJUb0NvbXBvbmVudFZhbHVlcyhtYXJrZXI6IFN5bmNNYXJrZXJTcGVjKTogU3luY01hcmtlckNvbXBvbmVudFZhbHVlcyB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZmlnbWFNYXJrZXJTY2hlbWE6IG1hcmtlci5zY2hlbWEsXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IG1hcmtlci5maWdtYUZpbGVIYXNoLFxuICAgICAgICBmaWdtYU5vZGVJZDogbWFya2VyLmZpZ21hTm9kZUlkLFxuICAgICAgICBmaWdtYUFsaWFzTm9kZUlkczogbWFya2VyLmFsaWFzTm9kZUlkcy5qb2luKCcsJyksXG4gICAgICAgIGZpZ21hQWxpYXNIYXNoOiBtYXJrZXIuYWxpYXNIYXNoLFxuICAgICAgICBmaWdtYVZpc3VhbEhhc2g6IG1hcmtlci52aXN1YWxIYXNoLFxuICAgICAgICBmaWdtYVN1YnRyZWVIYXNoOiBtYXJrZXIuc3VidHJlZUhhc2gsXG4gICAgfTtcbn1cblxuLyoqIOS7jiBDb2NvcyDnu4Tku7bor7vlm57moIforrDvvJvlrZfmrrXnvLrlpLHmiJbmjZ/lnY/ml7bov5Tlm54gbnVsbO+8jOeUseiwg+eUqOaWuSBmYWlsLWNsb3NlZOOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtlckZyb21Db21wb25lbnRWYWx1ZXMoXG4gICAgdmFsdWVzOiBQYXJ0aWFsPFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXM+IHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IFN5bmNNYXJrZXJTcGVjIHwgbnVsbCB7XG4gICAgaWYgKCF2YWx1ZXMgfHwgdHlwZW9mIHZhbHVlcyAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHNjaGVtYSA9IHZhbHVlcy5maWdtYU1hcmtlclNjaGVtYTtcbiAgICBpZiAoc2NoZW1hICE9PSBTWU5DX01BUktFUl9TQ0hFTUEpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGZpbGVIYXNoID0gdmFsdWVzLmZpZ21hRmlsZUhhc2g7XG4gICAgY29uc3Qgbm9kZUlkID0gdHlwZW9mIHZhbHVlcy5maWdtYU5vZGVJZCA9PT0gJ3N0cmluZycgPyBub3JtYWxpemVTeW5jTm9kZUlkKHZhbHVlcy5maWdtYU5vZGVJZCkgOiAnJztcbiAgICBjb25zdCB2aXN1YWxIYXNoID0gdmFsdWVzLmZpZ21hVmlzdWFsSGFzaDtcbiAgICBjb25zdCBzdWJ0cmVlSGFzaCA9IHZhbHVlcy5maWdtYVN1YnRyZWVIYXNoO1xuICAgIGlmICh0eXBlb2YgZmlsZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KGZpbGVIYXNoKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFub2RlSWQgfHwgdHlwZW9mIHZpc3VhbEhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHZpc3VhbEhhc2gpKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHN1YnRyZWVIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdChzdWJ0cmVlSGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGFsaWFzTm9kZUlkcyA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc05vZGVJZHMgPT09ICdzdHJpbmcnXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNOb2RlSWRzLnNwbGl0KCcsJylcbiAgICAgICAgICAgIC5tYXAoKGlkKSA9PiBub3JtYWxpemVTeW5jTm9kZUlkKGlkKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgOiBbXTtcbiAgICBjb25zdCBhbGlhc0hhc2ggPSB0eXBlb2YgdmFsdWVzLmZpZ21hQWxpYXNIYXNoID09PSAnc3RyaW5nJyAmJiBTSEEyNTZfUEFUVEVSTi50ZXN0KHZhbHVlcy5maWdtYUFsaWFzSGFzaClcbiAgICAgICAgPyB2YWx1ZXMuZmlnbWFBbGlhc0hhc2hcbiAgICAgICAgOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2NoZW1hLFxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBmaWxlSGFzaCxcbiAgICAgICAgZmlnbWFOb2RlSWQ6IG5vZGVJZCxcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxuICAgICAgICBhbGlhc0hhc2gsXG4gICAgICAgIHZpc3VhbEhhc2gsXG4gICAgICAgIHN1YnRyZWVIYXNoLFxuICAgIH07XG59XG5cbi8qKlxuICog5LiA5LiqIEZpZ21hIOiKgueCueWPquiDveiiq+S4gOS4qiBDb2NvcyDoioLngrnlo7DmmI7vvIjoh6rlt7HmiJbkvZzkuLrliKvlkI3vvInjgIJcbiAqIOaKmOWPoOeItuWtkOWQjOaXtuWjsOaYjuWQjOa6kOiKgueCueS8muiuqVwi5pS55ZOq5Liq6IqC54K5XCLlj5jlvpfkuI3lj6/liKTlrprjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFVuaXF1ZVN5bmNPd25lcnNoaXAobWFya2VyczogcmVhZG9ubHkgU3luY01hcmtlclNwZWNbXSk6IHZvaWQge1xuICAgIGNvbnN0IG93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGVJZCBvZiBbbWFya2VyLmZpZ21hTm9kZUlkLCAuLi5tYXJrZXIuYWxpYXNOb2RlSWRzXSkge1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBvd25lcnMuZ2V0KG5vZGVJZCk7XG4gICAgICAgICAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IG1hcmtlci5maWdtYU5vZGVJZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYEZpZ21hIOiKgueCuSAke25vZGVJZH0g5ZCM5pe26KKrICR7b3duZXJ9IOWSjCAke21hcmtlci5maWdtYU5vZGVJZH0g5aOw5piO77yM5bey5ouS57ud55Sf5oiQ5ZCM5q2l5qCH6K6w44CCYCxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb3duZXJzLnNldChub2RlSWQsIG1hcmtlci5maWdtYU5vZGVJZCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKiDpnIDopoHlnKjpobnnm64gYXNzZXRzIOS4reeUn+aIkOeahOacgOWwj+agh+iusOe7hOS7tua6kOegge+8iOaXoOS4muWKoemAu+i+ke+8jOWPquS/neWtmOadpea6kOS4juaMh+e6ue+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9TT1VSQ0UgPSBgaW1wb3J0IHsgX2RlY29yYXRvciwgQ29tcG9uZW50IH0gZnJvbSAnY2MnO1xuXG5jb25zdCB7IGNjY2xhc3MsIHByb3BlcnR5IH0gPSBfZGVjb3JhdG9yO1xuXG4vKipcbiAqIEZpZ21hIEltcG9ydGVyIOeUn+aIkOeahOWQjOatpeagh+iusOOAguWtl+auteeUseaPkuS7tue7tOaKpO+8jOaJi+W3peS/ruaUueS8muWvvOiHtOS4i+asoeWQjOatpeiiq+aLkue7neOAglxuICog5Yig6Zmk5pys57uE5Lu25Y2z6KGo56S66K+l6IqC54K56YCA5Ye6IEZpZ21hIOWQjOatpe+8muaPkuS7tuS4jeS8muWGjeenu+WKqOOAgee8qeaUvuaIluWIoOmZpOWug+OAglxuICovXG5AY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKVxuZXhwb3J0IGNsYXNzICR7U1lOQ19NQVJLRVJfQ0xBU1N9IGV4dGVuZHMgQ29tcG9uZW50IHtcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5qCH6K6w5Y2P6K6u54mI5pysJyB9KVxuICAgIHB1YmxpYyBmaWdtYU1hcmtlclNjaGVtYTogbnVtYmVyID0gJHtTWU5DX01BUktFUl9TQ0hFTUF9O1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOaWh+S7tiBrZXkg55qEIFNIQS0yNTYnIH0pXG4gICAgcHVibGljIGZpZ21hRmlsZUhhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOiKgueCuSBpZCcgfSlcbiAgICBwdWJsaWMgZmlnbWFOb2RlSWQ6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+iiq+aKmOWPoOWIsOacrOiKgueCueeahCBGaWdtYSDlrZDlsYIgaWTvvIzpgJflj7fliIbpmpQnIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNOb2RlSWRzOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmipjlj6DlrZDlsYLpm4blkIjmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoToioLngrnop4bop4nmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5a2Q5qCR5oyH57q5JyB9KVxuICAgIHB1YmxpYyBmaWdtYVN1YnRyZWVIYXNoOiBzdHJpbmcgPSAnJztcbn1cbmA7XG5cbi8qKiDpqozor4HnlJ/miJDliLDpobnnm67ph4znmoTohJrmnKzmsqHmnInooqvmiKrmlq3miJbooqvmlLnmiJDliKvnmoTnsbvjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJTY3JpcHQoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdHlwZW9mIHNvdXJjZSA9PT0gJ3N0cmluZydcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBAY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKWApXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnRgKVxuICAgICAgICAmJiBzb3VyY2UuaW5jbHVkZXMoJ2ZpZ21hU3VidHJlZUhhc2gnKTtcbn1cbiJdfQ==