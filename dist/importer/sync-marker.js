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
exports.isSyncMarkerComponentValue = isSyncMarkerComponentValue;
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
/**
 * 判断一个组件实例是否是本插件生成的同步标记。
 * 用于所有权判定：标记永远属于插件，不能算作"手工组件"阻止节点删除。
 * 按字段识别，不依赖脚本 UUID —— 脚本重新导入或 UUID 变化时仍然成立。
 */
function isSyncMarkerComponentValue(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value;
    return record.figmaMarkerSchema === exports.SYNC_MARKER_SCHEMA
        && typeof record.figmaNodeId === 'string'
        && record.figmaNodeId.length > 0
        && typeof record.figmaVisualHash === 'string';
}
/** 从 Cocos 组件读回标记；字段缺失或损坏时返回 null，由调用方 fail-closed。 */ function markerFromComponentValues(values) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBc0RBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFFRCwwQ0FFQztBQUVELHNDQUdDO0FBRUQsb0NBTUM7QUFFRCw0Q0FpQkM7QUFFRCw4Q0FpQkM7QUFHRCxzREFTQztBQUVELDBEQVVDO0FBT0QsZ0VBU0M7QUFFc0QsOERBeUN0RDtBQU1ELDhEQWFDO0FBcUNELGdEQUtDO0FBN1pELGdFQUEwRjtBQUUxRjs7Ozs7Ozs7O0dBU0c7QUFDVSxRQUFBLGtCQUFrQixHQUFHLENBQVUsQ0FBQztBQUNoQyxRQUFBLGlCQUFpQixHQUFHLGVBQWUsQ0FBQztBQUNwQyxRQUFBLGtCQUFrQixHQUFHLHdCQUF3QixDQUFDO0FBQzlDLFFBQUEsZ0JBQWdCLEdBQUcsa0JBQWtCLENBQUM7QUFDdEMsUUFBQSxzQkFBc0IsR0FBRyxlQUFlLDBCQUFrQixJQUFJLHdCQUFnQixFQUFFLENBQUM7QUFDakYsUUFBQSxvQkFBb0IsR0FBRyxnQkFBZ0IsQ0FBQztBQWtDckQsTUFBTSxjQUFjLEdBQUcsdUJBQXVCLENBQUM7QUFFL0MsU0FBZ0IsbUJBQW1CLENBQUMsS0FBYTtJQUM3QyxPQUFPLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzNDLENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxLQUF5QjtJQUMzQyxPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFBLGdDQUFlLEVBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbEcsQ0FBQztBQUVELFNBQVMsWUFB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TSxDQUFDLFFBQVEsQ0FBQyxhQUFhLHlCQUFpQixJQUFJLENBQUM7V0FDbkQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxTQUFTLHlCQUFpQixvQkFBb0IsQ0FBQztXQUMvRCxNQUFNLENBQUMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDL0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFFZmZlY3QsIEZpZ21hTm9kZSwgRmlnbWFQYWludCwgRmlnbWFUZXh0U3R5bGUsIFJlY3QsIFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHsgY2Fub25pY2FsU3RyaW5naWZ5LCBxdWFudGl6ZURlY2ltYWwsIHNoYTI1NiB9IGZyb20gJy4uL3JvdW5kdHJpcC9jYW5vbmljYWwtanNvbic7XG5cbi8qKlxuICog57uE5Lu257qn5Y+M6L655ZCM5q2l77yIQ29tcG9uZW50IFN5bmPvvInnmoTmoIforrDljY/orq7jgIJcbiAqXG4gKiDmoIforrDnu4Tku7YgYEZpZ21hU3luY05vZGVgIOaMguWcqOavj+S4queUseWQjOatpeaooeW8j+eUn+aIkOeahCBDb2NvcyDoioLngrnkuIrvvIxcbiAqIOaXouaPkOS+m+WPr+ingei6q+S7ve+8iEZpZ21hIOiKgueCuSBpZO+8ie+8jOS5n+S/neWtmOS4iuasoeWvvOWFpeaXtueahOinhuiniS/lrZDmoJHmjIfnurnvvIxcbiAqIOS9v+mHjeaWsOWvvOWFpeiDveWcqOS4jeaJk+W8gCBQcmVmYWIg55qE5oOF5Ya15LiL5Yik5patXCLorr7orqHmlLnkuobku4DkuYhcIuOAglxuICpcbiAqIOWuieWFqOi+ueeVjO+8mmZpbGUga2V5IOWPquS7pSBTSEEtMjU2IOW9ouW8j+S/neWtmO+8m25vZGUgaWQg5oyJ6ZyA5rGC5piO5paH5L+d5a2Y77yMXG4gKiDkuI4gUHJvamVjdCBQcm9maWxlIOS4rSBub2RlTWFwcyAvIG5vZGVPdmVycmlkZXMg55qE5pei5pyJ5piO5paH5LiA6Ie044CCXG4gKi9cbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ0hFTUEgPSAxIGFzIGNvbnN0O1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NMQVNTID0gJ0ZpZ21hU3luY05vZGUnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZPTERFUiA9ICdmaWdtYS1pbXBvcnRlci1ydW50aW1lJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GSUxFID0gJ0ZpZ21hU3luY05vZGUudHMnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9VUkwgPSBgZGI6Ly9hc3NldHMvJHtTWU5DX01BUktFUl9GT0xERVJ9LyR7U1lOQ19NQVJLRVJfRklMRX1gO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NBVEVHT1JZID0gJ0ZpZ21hIEltcG9ydGVyJztcblxuLyoqIOagh+iusOe7hOS7tuWcqCBQcmVmYWIg5Lit5L+d5a2Y55qE5a2X5q6144CCICovXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xuICAgIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXI7XG4gICAgZmlnbWFGaWxlSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hTm9kZUlkOiBzdHJpbmc7XG4gICAgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZztcbiAgICBmaWdtYUFsaWFzSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgeyBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VySW5wdXQge1xuICAgIGZpbGVLZXk6IHN0cmluZztcbiAgICBub2RlOiBGaWdtYU5vZGU7XG4gICAgLyoqIOiiq+aKmOWPoOWQuOaUtueahOWtkOWxgiBpZO+8iOS4jeWQqyBub2RlIOiHqui6q++8ieOAgiAqL1xuICAgIGFsaWFzTm9kZUlkcz86IHN0cmluZ1tdO1xuICAgIHNjaGVtYT86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcGFyaXNvbiB7XG4gICAgLyoqIOacrOiKgueCueeahOWHoOS9leOAgeaYvumakOOAgeWkluinguOAgeaWh+Wtl+aIlue7hOS7tuexu+Wei+WPkeeUn+WPmOWMluOAgiAqL1xuICAgIHZpc3VhbENoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIEZpZ21hIOWtkOagkeWGheS7u+aEj+WQjuS7o+WPkeeUn+WPmOWMlu+8iOWQq+aWsOWini/liKDpmaQv5ZCM5ZCN5pu/5o2i77yJ44CCICovXG4gICAgc3VidHJlZUNoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIOaKmOWPoOWtkOWxgumbhuWQiOWPkeeUn+WPmOWMlu+8iOWtkOWxguaWsOWinuOAgeWIoOmZpOaIluiiq+abv+aNou+8ieOAgiAqL1xuICAgIHN0cnVjdHVyZUNoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIOmcgOimgemHjeaWsOeUn+aIkOWbvueJh+i1hOa6kOaJjeiDveWPjeaYoOiuvuiuoeWPmOWMluOAgiAqL1xuICAgIGFzc2V0U3RhbGU6IGJvb2xlYW47XG59XG5cbmNvbnN0IFNIQTI1Nl9QQVRURVJOID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC87XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTeW5jTm9kZUlkKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHJldHVybiB2YWx1ZS50cmltKCkucmVwbGFjZSgvLS9nLCAnOicpO1xufVxuXG5mdW5jdGlvbiBmaW5pdGVPck51bGwodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB8IG51bGwge1xuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBxdWFudGl6ZURlY2ltYWwodmFsdWUsIDQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZnJhbWVQYXlsb2FkKGZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkKTogbnVtYmVyW10gfCBudWxsIHtcbiAgICBpZiAoIWZyYW1lKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gW1xuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueCkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLnkpID8/IDAsXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS53aWR0aCkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLmhlaWdodCkgPz8gMCxcbiAgICBdO1xufVxuXG5mdW5jdGlvbiBwYWludFBheWxvYWQocGFpbnQ6IEZpZ21hUGFpbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogcGFpbnQudHlwZSxcbiAgICAgICAgdmlzaWJsZTogcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UsXG4gICAgICAgIG9wYWNpdHk6IGZpbml0ZU9yTnVsbChwYWludC5vcGFjaXR5ID8/IDEpLFxuICAgICAgICBibGVuZE1vZGU6IHBhaW50LmJsZW5kTW9kZSA/PyBudWxsLFxuICAgICAgICBjb2xvcjogcGFpbnQuY29sb3JcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuZyksXG4gICAgICAgICAgICAgICAgYjogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBpbWFnZVJlZjogcGFpbnQuaW1hZ2VSZWYgPz8gbnVsbCxcbiAgICAgICAgc2NhbGVNb2RlOiBwYWludC5zY2FsZU1vZGUgPz8gbnVsbCxcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChwYWludC5yb3RhdGlvbiksXG4gICAgICAgIHNvdXJjZU5vZGVJZDogcGFpbnQuc291cmNlTm9kZUlkID8/IG51bGwsXG4gICAgICAgIHRpbGVUeXBlOiBwYWludC50aWxlVHlwZSA/PyBudWxsLFxuICAgICAgICBzY2FsaW5nRmFjdG9yOiBmaW5pdGVPck51bGwocGFpbnQuc2NhbGluZ0ZhY3RvciksXG4gICAgICAgIHNwYWNpbmc6IHBhaW50LnNwYWNpbmdcbiAgICAgICAgICAgID8gW2Zpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLngpLCBmaW5pdGVPck51bGwocGFpbnQuc3BhY2luZy55KV1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgaG9yaXpvbnRhbEFsaWdubWVudDogcGFpbnQuaG9yaXpvbnRhbEFsaWdubWVudCA/PyBudWxsLFxuICAgICAgICB2ZXJ0aWNhbEFsaWdubWVudDogcGFpbnQudmVydGljYWxBbGlnbm1lbnQgPz8gbnVsbCxcbiAgICAgICAgZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnM6IEFycmF5LmlzQXJyYXkocGFpbnQuZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnMpXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zLm1hcCgoaGFuZGxlKSA9PiBbZmluaXRlT3JOdWxsKGhhbmRsZS54KSwgZmluaXRlT3JOdWxsKGhhbmRsZS55KV0pXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGdyYWRpZW50U3RvcHM6IEFycmF5LmlzQXJyYXkocGFpbnQuZ3JhZGllbnRTdG9wcylcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRTdG9wcy5tYXAoKHN0b3ApID0+IFtmaW5pdGVPck51bGwoc3RvcC5wb3NpdGlvbiksIHN0b3AuY29sb3JcbiAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuciksXG4gICAgICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmcpLFxuICAgICAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5iKSxcbiAgICAgICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuYSA/PyAxKSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgOiBudWxsXSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgLy8g5Zu+54mH6KOB5YiH55+p6Zi15LiO5ruk6ZWc5ZCM5qC35pS55Y+Y5YOP57Sg77yM5L2G5LiN5Lya5pS55Y+YIGltYWdlUmVm77yb5ryP5o6J5a6D5Lus5Lya6K6pXG4gICAgICAgIC8vIOaVtOWxguiKgueCueWcqOmHjeWvvOWFpeWQjue7p+e7reaYvuekuuaXp+WbvuOAglxuICAgICAgICBpbWFnZVRyYW5zZm9ybTogQXJyYXkuaXNBcnJheShwYWludC5pbWFnZVRyYW5zZm9ybSlcbiAgICAgICAgICAgID8gcGFpbnQuaW1hZ2VUcmFuc2Zvcm0ubWFwKChyb3cpID0+IChBcnJheS5pc0FycmF5KHJvdylcbiAgICAgICAgICAgICAgICA/IHJvdy5tYXAoKHZhbHVlKSA9PiBmaW5pdGVPck51bGwodmFsdWUpKVxuICAgICAgICAgICAgICAgIDogbnVsbCkpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGZpbHRlcnM6IHBhaW50LmZpbHRlcnNcbiAgICAgICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKHBhaW50LmZpbHRlcnMpXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpXG4gICAgICAgICAgICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiBba2V5LCBmaW5pdGVPck51bGwodmFsdWUpXSkpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gZWZmZWN0UGF5bG9hZChlZmZlY3Q6IEZpZ21hRWZmZWN0KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IGVmZmVjdC50eXBlLFxuICAgICAgICB2aXNpYmxlOiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UsXG4gICAgICAgIHJhZGl1czogZmluaXRlT3JOdWxsKGVmZmVjdC5yYWRpdXMpLFxuICAgICAgICBzcHJlYWQ6IGZpbml0ZU9yTnVsbChlZmZlY3Quc3ByZWFkKSxcbiAgICAgICAgb2Zmc2V0WDogZmluaXRlT3JOdWxsKGVmZmVjdC5vZmZzZXQ/LngpLFxuICAgICAgICBvZmZzZXRZOiBmaW5pdGVPck51bGwoZWZmZWN0Lm9mZnNldD8ueSksXG4gICAgICAgIGNvbG9yOiBlZmZlY3QuY29sb3JcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuciksXG4gICAgICAgICAgICAgICAgZzogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5nKSxcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuYSA/PyAxKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiB0ZXh0UGF5bG9hZChzdHlsZTogRmlnbWFUZXh0U3R5bGUgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICAgIGlmICghc3R5bGUpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIGZvbnRGYW1pbHk6IHN0eWxlLmZvbnRGYW1pbHkgPz8gbnVsbCxcbiAgICAgICAgZm9udFBvc3RTY3JpcHROYW1lOiBzdHlsZS5mb250UG9zdFNjcmlwdE5hbWUgPz8gbnVsbCxcbiAgICAgICAgZm9udFdlaWdodDogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRXZWlnaHQpLFxuICAgICAgICBmb250U2l6ZTogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRTaXplKSxcbiAgICAgICAgdGV4dEFsaWduSG9yaXpvbnRhbDogc3R5bGUudGV4dEFsaWduSG9yaXpvbnRhbCA/PyBudWxsLFxuICAgICAgICB0ZXh0QWxpZ25WZXJ0aWNhbDogc3R5bGUudGV4dEFsaWduVmVydGljYWwgPz8gbnVsbCxcbiAgICAgICAgbGV0dGVyU3BhY2luZzogZmluaXRlT3JOdWxsKHN0eWxlLmxldHRlclNwYWNpbmcpLFxuICAgICAgICBsaW5lSGVpZ2h0UHg6IGZpbml0ZU9yTnVsbChzdHlsZS5saW5lSGVpZ2h0UHgpLFxuICAgICAgICB0ZXh0QXV0b1Jlc2l6ZTogc3R5bGUudGV4dEF1dG9SZXNpemUgPz8gbnVsbCxcbiAgICAgICAgdGV4dFRydW5jYXRpb246IHN0eWxlLnRleHRUcnVuY2F0aW9uID8/IG51bGwsXG4gICAgICAgIG1heExpbmVzOiBmaW5pdGVPck51bGwoc3R5bGUubWF4TGluZXMpLFxuICAgIH07XG59XG5cbi8qKlxuICog5pys6IqC54K56Ieq6Lqr55qE6KeG6KeJ6LSh54yu77ya5Yeg5L2V44CB5pi+6ZqQ44CB5aGr5YWFL+aPj+i+uS/nibnmlYjjgIHlnIbop5LjgIHmloflrZfkuI7moLflvI/jgIJcbiAqIOS4jeWMheWQq+WtkOiKgueCue+8jOWboOatpOaKmOWPoOeItuiKgueCueeahOaMh+e6ueS4jeS8muWboOWtkOWxguenu+WKqOiAjOWPmOWMluOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbFBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIGlkOiBub3JtYWxpemVTeW5jTm9kZUlkKG5vZGUuaWQpLFxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXG4gICAgICAgIGZyYW1lOiBmcmFtZVBheWxvYWQobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSxcbiAgICAgICAgcmVuZGVyQm91bmRzOiBmcmFtZVBheWxvYWQobm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcyksXG4gICAgICAgIHNpemU6IG5vZGUuc2l6ZVxuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS53aWR0aCksIGZpbml0ZU9yTnVsbChub2RlLnNpemUuaGVpZ2h0KV1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChub2RlLnJvdGF0aW9uKSxcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgb3BhY2l0eTogZmluaXRlT3JOdWxsKG5vZGUub3BhY2l0eSA/PyAxKSxcbiAgICAgICAgYmxlbmRNb2RlOiBub2RlLmJsZW5kTW9kZSA/PyBudWxsLFxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50ID09PSB0cnVlLFxuICAgICAgICBjb3JuZXJSYWRpdXM6IGZpbml0ZU9yTnVsbChub2RlLmNvcm5lclJhZGl1cyksXG4gICAgICAgIHJlY3RhbmdsZUNvcm5lclJhZGlpOiBBcnJheS5pc0FycmF5KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkpXG4gICAgICAgICAgICA/IG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IGZpbml0ZU9yTnVsbChyYWRpdXMpKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICAvLyDlnIblvKfnmoTotbfmraLop5LkuI7lhoXljYrlvoTlj6rmlLnlg4/ntKDvvIzkuI3mlLnlpJbmoYbvvJvkuI3nurPlhaXmjIfnurnkvJrmvI/mjonmlbTlsYLoioLngrnnmoTmlrDlvaLnirbjgIJcbiAgICAgICAgYXJjRGF0YTogbm9kZS5hcmNEYXRhXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBzdGFydGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLnN0YXJ0aW5nQW5nbGUpLFxuICAgICAgICAgICAgICAgIGVuZGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmVuZGluZ0FuZ2xlKSxcbiAgICAgICAgICAgICAgICBpbm5lclJhZGl1czogZmluaXRlT3JOdWxsKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGZpbGxzOiAobm9kZS5maWxscyA/PyBbXSkubWFwKHBhaW50UGF5bG9hZCksXG4gICAgICAgIHN0cm9rZXM6IChub2RlLnN0cm9rZXMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxuICAgICAgICBzdHJva2VXZWlnaHQ6IGZpbml0ZU9yTnVsbChub2RlLnN0cm9rZVdlaWdodCksXG4gICAgICAgIHN0cm9rZUFsaWduOiBub2RlLnN0cm9rZUFsaWduID8/IG51bGwsXG4gICAgICAgIGVmZmVjdHM6IChub2RlLmVmZmVjdHMgPz8gW10pLm1hcChlZmZlY3RQYXlsb2FkKSxcbiAgICAgICAgY2hhcmFjdGVyczogdHlwZW9mIG5vZGUuY2hhcmFjdGVycyA9PT0gJ3N0cmluZycgPyBub2RlLmNoYXJhY3RlcnMgOiBudWxsLFxuICAgICAgICB0ZXh0U3R5bGU6IHRleHRQYXlsb2FkKG5vZGUuc3R5bGUpLFxuICAgIH07XG59XG5cbi8qKiDlrZDmoJHnu5PmnoTvvJrmnKzoioLngrnmjIfnurkgKyDpgJDlsYLlrZDoioLngrnmjIfnurnvvIznlKjkuo7liKTmlq3muLLmn5PlnovoioLngrnmmK/lkKbpnIDopoHph43mlrDlh7rlm77jgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU3VidHJlZVBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHZpc3VhbDogc3luY1Zpc3VhbFBheWxvYWQobm9kZSksXG4gICAgICAgIGNoaWxkcmVuOiAobm9kZS5jaGlsZHJlbiA/PyBbXSkubWFwKChjaGlsZCkgPT4gc3luY1N1YnRyZWVQYXlsb2FkKGNoaWxkKSksXG4gICAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNWaXN1YWxIYXNoKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1Zpc3VhbFBheWxvYWQobm9kZSkpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlKSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBjb25zdCBpZHMgPSBbLi4ubmV3IFNldChhbGlhc05vZGVJZHMubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpLmZpbHRlcihCb29sZWFuKSldLnNvcnQoKTtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShpZHMpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNGaWxlSGFzaChmaWxlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBmaWxlS2V5LnRyaW0oKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXnvLrlsJEgRmlnbWEgZmlsZSBrZXnjgIInKTtcbiAgICB9XG4gICAgcmV0dXJuIHNoYTI1NihgZmlnbWEtaW1wb3J0ZXI6c3luYy1maWxlOnYxXFwwJHtub3JtYWxpemVkfWApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3luY01hcmtlcihpbnB1dDogU3luY01hcmtlcklucHV0KTogU3luY01hcmtlclNwZWMge1xuICAgIGNvbnN0IG5vZGVJZCA9IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaW5wdXQubm9kZS5pZCk7XG4gICAgaWYgKCFub2RlSWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXoioLngrnnvLrlsJEgRmlnbWEg6IqC54K5IGlk44CCJyk7XG4gICAgfVxuICAgIGNvbnN0IGFsaWFzTm9kZUlkcyA9IFsuLi5uZXcgU2V0KChpbnB1dC5hbGlhc05vZGVJZHMgPz8gW10pXG4gICAgICAgIC5tYXAobm9ybWFsaXplU3luY05vZGVJZClcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IEJvb2xlYW4oaWQpICYmIGlkICE9PSBub2RlSWQpKV0uc29ydCgpO1xuICAgIHJldHVybiB7XG4gICAgICAgIHNjaGVtYTogaW5wdXQuc2NoZW1hID8/IFNZTkNfTUFSS0VSX1NDSEVNQSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogc3luY0ZpbGVIYXNoKGlucHV0LmZpbGVLZXkpLFxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxuICAgICAgICBhbGlhc05vZGVJZHMsXG4gICAgICAgIGFsaWFzSGFzaDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpLFxuICAgICAgICB2aXN1YWxIYXNoOiBzeW5jVmlzdWFsSGFzaChpbnB1dC5ub2RlKSxcbiAgICAgICAgc3VidHJlZUhhc2g6IHN5bmNTdWJ0cmVlSGFzaChpbnB1dC5ub2RlKSxcbiAgICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVN5bmNNYXJrZXIoXG4gICAgcHJldmlvdXM6IFN5bmNNYXJrZXJTcGVjLFxuICAgIG5leHQ6IFN5bmNNYXJrZXJTcGVjLFxuKTogU3luY01hcmtlckNvbXBhcmlzb24ge1xuICAgIGNvbnN0IHZpc3VhbENoYW5nZWQgPSBwcmV2aW91cy52aXN1YWxIYXNoICE9PSBuZXh0LnZpc3VhbEhhc2g7XG4gICAgY29uc3Qgc3VidHJlZUNoYW5nZWQgPSBwcmV2aW91cy5zdWJ0cmVlSGFzaCAhPT0gbmV4dC5zdWJ0cmVlSGFzaDtcbiAgICBjb25zdCBzdHJ1Y3R1cmVDaGFuZ2VkID0gcHJldmlvdXMuYWxpYXNIYXNoICE9PSBuZXh0LmFsaWFzSGFzaFxuICAgICAgICB8fCBwcmV2aW91cy5hbGlhc05vZGVJZHMuam9pbignLCcpICE9PSBuZXh0LmFsaWFzTm9kZUlkcy5qb2luKCcsJyk7XG4gICAgY29uc3Qgc291cmNlQ2hhbmdlZCA9IHByZXZpb3VzLmZpZ21hRmlsZUhhc2ggIT09IG5leHQuZmlnbWFGaWxlSGFzaFxuICAgICAgICB8fCBwcmV2aW91cy5maWdtYU5vZGVJZCAhPT0gbmV4dC5maWdtYU5vZGVJZDtcbiAgICByZXR1cm4ge1xuICAgICAgICB2aXN1YWxDaGFuZ2VkLFxuICAgICAgICBzdWJ0cmVlQ2hhbmdlZCxcbiAgICAgICAgc3RydWN0dXJlQ2hhbmdlZCxcbiAgICAgICAgLy8g5o2i5LqG5p2l5rqQ44CB5Yeg5L2V44CB5a2Q5qCR5oiW5oqY5Y+g6ZuG5ZCI77yM6YO95oSP5ZGz552A6L+Z5byg5Zu+5LiN5YaN5piv5LiK5qyh5a+85Ye655qE6YKj5byg44CCXG4gICAgICAgIGFzc2V0U3RhbGU6IHZpc3VhbENoYW5nZWQgfHwgc3VidHJlZUNoYW5nZWQgfHwgc3RydWN0dXJlQ2hhbmdlZCB8fCBzb3VyY2VDaGFuZ2VkLFxuICAgIH07XG59XG5cbi8qKiDliKTmlq3kuIDkuKrkuI3pgI/mmI7op4bop4noioLngrnvvIjnn6Lph48v5pW05bGCIFBORy/mipjlj6DljIXoo4XvvInmmK/lkKbpnIDopoHph43mlrDnlJ/miJDlm77niYfjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jTmVlZHNBc3NldFJlZnJlc2gob3B0aW9uczoge1xuICAgIGNvbXBhcmlzb246IFN5bmNNYXJrZXJDb21wYXJpc29uO1xuICAgIC8qKiDlvZPliY3oioLngrnmmK/lkKbku6UgUE5HIOW9ouW8j+iQveWcsO+8iOaVtOWxgiByZW5kZXLjgIHnn6Lph4/jgIHmipjlj6AgU3ByaXRlL0xhYmVs77yJ44CCICovXG4gICAgcmFzdGVyaXplZDogYm9vbGVhbjtcbn0pOiBib29sZWFuIHtcbiAgICBpZiAoIW9wdGlvbnMucmFzdGVyaXplZCkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBvcHRpb25zLmNvbXBhcmlzb24uYXNzZXRTdGFsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtlclRvQ29tcG9uZW50VmFsdWVzKG1hcmtlcjogU3luY01hcmtlclNwZWMpOiBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBmaWdtYU1hcmtlclNjaGVtYTogbWFya2VyLnNjaGVtYSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogbWFya2VyLmZpZ21hRmlsZUhhc2gsXG4gICAgICAgIGZpZ21hTm9kZUlkOiBtYXJrZXIuZmlnbWFOb2RlSWQsXG4gICAgICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBtYXJrZXIuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSxcbiAgICAgICAgZmlnbWFBbGlhc0hhc2g6IG1hcmtlci5hbGlhc0hhc2gsXG4gICAgICAgIGZpZ21hVmlzdWFsSGFzaDogbWFya2VyLnZpc3VhbEhhc2gsXG4gICAgICAgIGZpZ21hU3VidHJlZUhhc2g6IG1hcmtlci5zdWJ0cmVlSGFzaCxcbiAgICB9O1xufVxuXG4vKipcbiAqIOWIpOaWreS4gOS4que7hOS7tuWunuS+i+aYr+WQpuaYr+acrOaPkuS7tueUn+aIkOeahOWQjOatpeagh+iusOOAglxuICog55So5LqO5omA5pyJ5p2D5Yik5a6a77ya5qCH6K6w5rC46L+c5bGe5LqO5o+S5Lu277yM5LiN6IO9566X5L2cXCLmiYvlt6Xnu4Tku7ZcIumYu+atouiKgueCueWIoOmZpOOAglxuICog5oyJ5a2X5q616K+G5Yir77yM5LiN5L6d6LWW6ISa5pysIFVVSUQg4oCU4oCUIOiEmuacrOmHjeaWsOWvvOWFpeaIliBVVUlEIOWPmOWMluaXtuS7jeeEtuaIkOeri+OAglxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTeW5jTWFya2VyQ29tcG9uZW50VmFsdWUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCByZWNvcmQgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICByZXR1cm4gcmVjb3JkLmZpZ21hTWFya2VyU2NoZW1hID09PSBTWU5DX01BUktFUl9TQ0hFTUFcbiAgICAgICAgJiYgdHlwZW9mIHJlY29yZC5maWdtYU5vZGVJZCA9PT0gJ3N0cmluZydcbiAgICAgICAgJiYgcmVjb3JkLmZpZ21hTm9kZUlkLmxlbmd0aCA+IDBcbiAgICAgICAgJiYgdHlwZW9mIHJlY29yZC5maWdtYVZpc3VhbEhhc2ggPT09ICdzdHJpbmcnO1xufVxuXG4vKiog5LuOIENvY29zIOe7hOS7tuivu+Wbnuagh+iusO+8m+Wtl+autee8uuWkseaIluaNn+Wdj+aXtui/lOWbniBudWxs77yM55Sx6LCD55So5pa5IGZhaWwtY2xvc2Vk44CCICovZXhwb3J0IGZ1bmN0aW9uIG1hcmtlckZyb21Db21wb25lbnRWYWx1ZXMoXG4gICAgdmFsdWVzOiBQYXJ0aWFsPFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXM+IHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IFN5bmNNYXJrZXJTcGVjIHwgbnVsbCB7XG4gICAgaWYgKCF2YWx1ZXMgfHwgdHlwZW9mIHZhbHVlcyAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHNjaGVtYSA9IHZhbHVlcy5maWdtYU1hcmtlclNjaGVtYTtcbiAgICBpZiAoc2NoZW1hICE9PSBTWU5DX01BUktFUl9TQ0hFTUEpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGZpbGVIYXNoID0gdmFsdWVzLmZpZ21hRmlsZUhhc2g7XG4gICAgY29uc3Qgbm9kZUlkID0gdHlwZW9mIHZhbHVlcy5maWdtYU5vZGVJZCA9PT0gJ3N0cmluZycgPyBub3JtYWxpemVTeW5jTm9kZUlkKHZhbHVlcy5maWdtYU5vZGVJZCkgOiAnJztcbiAgICBjb25zdCB2aXN1YWxIYXNoID0gdmFsdWVzLmZpZ21hVmlzdWFsSGFzaDtcbiAgICBjb25zdCBzdWJ0cmVlSGFzaCA9IHZhbHVlcy5maWdtYVN1YnRyZWVIYXNoO1xuICAgIGlmICh0eXBlb2YgZmlsZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KGZpbGVIYXNoKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFub2RlSWQgfHwgdHlwZW9mIHZpc3VhbEhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHZpc3VhbEhhc2gpKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHN1YnRyZWVIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdChzdWJ0cmVlSGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGFsaWFzTm9kZUlkcyA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc05vZGVJZHMgPT09ICdzdHJpbmcnXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNOb2RlSWRzLnNwbGl0KCcsJylcbiAgICAgICAgICAgIC5tYXAoKGlkKSA9PiBub3JtYWxpemVTeW5jTm9kZUlkKGlkKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgOiBbXTtcbiAgICBjb25zdCBhbGlhc0hhc2ggPSB0eXBlb2YgdmFsdWVzLmZpZ21hQWxpYXNIYXNoID09PSAnc3RyaW5nJyAmJiBTSEEyNTZfUEFUVEVSTi50ZXN0KHZhbHVlcy5maWdtYUFsaWFzSGFzaClcbiAgICAgICAgPyB2YWx1ZXMuZmlnbWFBbGlhc0hhc2hcbiAgICAgICAgOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2NoZW1hLFxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBmaWxlSGFzaCxcbiAgICAgICAgZmlnbWFOb2RlSWQ6IG5vZGVJZCxcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxuICAgICAgICBhbGlhc0hhc2gsXG4gICAgICAgIHZpc3VhbEhhc2gsXG4gICAgICAgIHN1YnRyZWVIYXNoLFxuICAgIH07XG59XG5cbi8qKlxuICog5LiA5LiqIEZpZ21hIOiKgueCueWPquiDveiiq+S4gOS4qiBDb2NvcyDoioLngrnlo7DmmI7vvIjoh6rlt7HmiJbkvZzkuLrliKvlkI3vvInjgIJcbiAqIOaKmOWPoOeItuWtkOWQjOaXtuWjsOaYjuWQjOa6kOiKgueCueS8muiuqVwi5pS55ZOq5Liq6IqC54K5XCLlj5jlvpfkuI3lj6/liKTlrprjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFVuaXF1ZVN5bmNPd25lcnNoaXAobWFya2VyczogcmVhZG9ubHkgU3luY01hcmtlclNwZWNbXSk6IHZvaWQge1xuICAgIGNvbnN0IG93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGVJZCBvZiBbbWFya2VyLmZpZ21hTm9kZUlkLCAuLi5tYXJrZXIuYWxpYXNOb2RlSWRzXSkge1xuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBvd25lcnMuZ2V0KG5vZGVJZCk7XG4gICAgICAgICAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IG1hcmtlci5maWdtYU5vZGVJZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgYEZpZ21hIOiKgueCuSAke25vZGVJZH0g5ZCM5pe26KKrICR7b3duZXJ9IOWSjCAke21hcmtlci5maWdtYU5vZGVJZH0g5aOw5piO77yM5bey5ouS57ud55Sf5oiQ5ZCM5q2l5qCH6K6w44CCYCxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb3duZXJzLnNldChub2RlSWQsIG1hcmtlci5maWdtYU5vZGVJZCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbi8qKiDpnIDopoHlnKjpobnnm64gYXNzZXRzIOS4reeUn+aIkOeahOacgOWwj+agh+iusOe7hOS7tua6kOegge+8iOaXoOS4muWKoemAu+i+ke+8jOWPquS/neWtmOadpea6kOS4juaMh+e6ue+8ieOAgiAqL1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9TT1VSQ0UgPSBgaW1wb3J0IHsgX2RlY29yYXRvciwgQ29tcG9uZW50IH0gZnJvbSAnY2MnO1xuXG5jb25zdCB7IGNjY2xhc3MsIHByb3BlcnR5IH0gPSBfZGVjb3JhdG9yO1xuXG4vKipcbiAqIEZpZ21hIEltcG9ydGVyIOeUn+aIkOeahOWQjOatpeagh+iusOOAguWtl+auteeUseaPkuS7tue7tOaKpO+8jOaJi+W3peS/ruaUueS8muWvvOiHtOS4i+asoeWQjOatpeiiq+aLkue7neOAglxuICog5Yig6Zmk5pys57uE5Lu25Y2z6KGo56S66K+l6IqC54K56YCA5Ye6IEZpZ21hIOWQjOatpe+8muaPkuS7tuS4jeS8muWGjeenu+WKqOOAgee8qeaUvuaIluWIoOmZpOWug+OAglxuICovXG5AY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKVxuZXhwb3J0IGNsYXNzICR7U1lOQ19NQVJLRVJfQ0xBU1N9IGV4dGVuZHMgQ29tcG9uZW50IHtcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5qCH6K6w5Y2P6K6u54mI5pysJyB9KVxuICAgIHB1YmxpYyBmaWdtYU1hcmtlclNjaGVtYTogbnVtYmVyID0gJHtTWU5DX01BUktFUl9TQ0hFTUF9O1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOaWh+S7tiBrZXkg55qEIFNIQS0yNTYnIH0pXG4gICAgcHVibGljIGZpZ21hRmlsZUhhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOiKgueCuSBpZCcgfSlcbiAgICBwdWJsaWMgZmlnbWFOb2RlSWQ6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+iiq+aKmOWPoOWIsOacrOiKgueCueeahCBGaWdtYSDlrZDlsYIgaWTvvIzpgJflj7fliIbpmpQnIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNOb2RlSWRzOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmipjlj6DlrZDlsYLpm4blkIjmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hQWxpYXNIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoToioLngrnop4bop4nmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5a2Q5qCR5oyH57q5JyB9KVxuICAgIHB1YmxpYyBmaWdtYVN1YnRyZWVIYXNoOiBzdHJpbmcgPSAnJztcbn1cbmA7XG5cbi8qKiDpqozor4HnlJ/miJDliLDpobnnm67ph4znmoTohJrmnKzmsqHmnInooqvmiKrmlq3miJbooqvmlLnmiJDliKvnmoTnsbvjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJTY3JpcHQoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdHlwZW9mIHNvdXJjZSA9PT0gJ3N0cmluZydcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBAY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKWApXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnRgKVxuICAgICAgICAmJiBzb3VyY2UuaW5jbHVkZXMoJ2ZpZ21hU3VidHJlZUhhc2gnKTtcbn1cbiJdfQ==