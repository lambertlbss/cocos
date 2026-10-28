"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNC_MARKER_SCRIPT_SOURCE = exports.SYNC_MARKER_CATEGORY = exports.SYNC_MARKER_SCRIPT_URL = exports.SYNC_MARKER_FILE = exports.SYNC_MARKER_FOLDER = exports.SYNC_MARKER_CLASS = exports.SYNC_MARKER_SCHEMA = void 0;
exports.normalizeSyncNodeId = normalizeSyncNodeId;
exports.syncVisualPayload = syncVisualPayload;
exports.syncSubtreePayload = syncSubtreePayload;
exports.syncVisualHash = syncVisualHash;
exports.syncPixelPayload = syncPixelPayload;
exports.syncPixelHash = syncPixelHash;
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
/**
 * 只保留影响像素的属性：把页面坐标（x/y）从 frame 与 renderBounds 中剔除。
 * 移动节点只改位置，不应被判定为"图片过期"；尺寸、旋转、外观仍然计入。
 */
function syncPixelPayload(node) {
    const visual = syncVisualPayload(node);
    const frame = visual.frame;
    const render = visual.renderBounds;
    return {
        ...visual,
        frame: frame ? [frame[2], frame[3]] : null,
        renderBounds: render ? [render[2], render[3]] : null,
    };
}
function syncPixelHash(node) {
    return (0, canonical_json_1.sha256)((0, canonical_json_1.canonicalStringify)(syncPixelPayload(node)));
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
        pixelHash: syncPixelHash(input.node),
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
    var _a;
    return {
        figmaMarkerSchema: marker.schema,
        figmaFileHash: marker.figmaFileHash,
        figmaNodeId: marker.figmaNodeId,
        figmaAliasNodeIds: marker.aliasNodeIds.join(','),
        figmaAliasHash: marker.aliasHash,
        figmaVisualHash: marker.visualHash,
        figmaPixelHash: (_a = marker.pixelHash) !== null && _a !== void 0 ? _a : '',
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
        pixelHash: typeof values.figmaPixelHash === 'string' && SHA256_PATTERN.test(values.figmaPixelHash)
            ? values.figmaPixelHash
            : undefined,
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

    @property({ tooltip: '本次导入时的像素指纹（不含页面坐标）' })
    public figmaPixelHash: string = '';

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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBdURBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFNRCw0Q0FTQztBQUVELHNDQUVDO0FBRUQsMENBRUM7QUFFRCxzQ0FHQztBQUVELG9DQU1DO0FBRUQsNENBa0JDO0FBRUQsOENBaUJDO0FBR0Qsc0RBU0M7QUFFRCwwREFXQztBQU9ELGdFQVNDO0FBRXNELDhEQTRDdEQ7QUFNRCw4REFhQztBQXdDRCxnREFLQztBQXpiRCxnRUFBMEY7QUFFMUY7Ozs7Ozs7OztHQVNHO0FBQ1UsUUFBQSxrQkFBa0IsR0FBRyxDQUFVLENBQUM7QUFDaEMsUUFBQSxpQkFBaUIsR0FBRyxlQUFlLENBQUM7QUFDcEMsUUFBQSxrQkFBa0IsR0FBRyx3QkFBd0IsQ0FBQztBQUM5QyxRQUFBLGdCQUFnQixHQUFHLGtCQUFrQixDQUFDO0FBQ3RDLFFBQUEsc0JBQXNCLEdBQUcsZUFBZSwwQkFBa0IsSUFBSSx3QkFBZ0IsRUFBRSxDQUFDO0FBQ2pGLFFBQUEsb0JBQW9CLEdBQUcsZ0JBQWdCLENBQUM7QUFtQ3JELE1BQU0sY0FBYyxHQUFHLHVCQUF1QixDQUFDO0FBRS9DLFNBQWdCLG1CQUFtQixDQUFDLEtBQWE7SUFDN0MsT0FBTyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQztBQUMzQyxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBeUI7SUFDM0MsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBQSxnQ0FBZSxFQUFDLEtBQUssRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FB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b0IsQ0FBQztXQUMvRCxNQUFNLENBQUMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDL0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFFZmZlY3QsIEZpZ21hTm9kZSwgRmlnbWFQYWludCwgRmlnbWFUZXh0U3R5bGUsIFJlY3QsIFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuaW1wb3J0IHsgY2Fub25pY2FsU3RyaW5naWZ5LCBxdWFudGl6ZURlY2ltYWwsIHNoYTI1NiB9IGZyb20gJy4uL3JvdW5kdHJpcC9jYW5vbmljYWwtanNvbic7XG5cbi8qKlxuICog57uE5Lu257qn5Y+M6L655ZCM5q2l77yIQ29tcG9uZW50IFN5bmPvvInnmoTmoIforrDljY/orq7jgIJcbiAqXG4gKiDmoIforrDnu4Tku7YgYEZpZ21hU3luY05vZGVgIOaMguWcqOavj+S4queUseWQjOatpeaooeW8j+eUn+aIkOeahCBDb2NvcyDoioLngrnkuIrvvIxcbiAqIOaXouaPkOS+m+WPr+ingei6q+S7ve+8iEZpZ21hIOiKgueCuSBpZO+8ie+8jOS5n+S/neWtmOS4iuasoeWvvOWFpeaXtueahOinhuiniS/lrZDmoJHmjIfnurnvvIxcbiAqIOS9v+mHjeaWsOWvvOWFpeiDveWcqOS4jeaJk+W8gCBQcmVmYWIg55qE5oOF5Ya15LiL5Yik5patXCLorr7orqHmlLnkuobku4DkuYhcIuOAglxuICpcbiAqIOWuieWFqOi+ueeVjO+8mmZpbGUga2V5IOWPquS7pSBTSEEtMjU2IOW9ouW8j+S/neWtmO+8m25vZGUgaWQg5oyJ6ZyA5rGC5piO5paH5L+d5a2Y77yMXG4gKiDkuI4gUHJvamVjdCBQcm9maWxlIOS4rSBub2RlTWFwcyAvIG5vZGVPdmVycmlkZXMg55qE5pei5pyJ5piO5paH5LiA6Ie044CCXG4gKi9cbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ0hFTUEgPSAxIGFzIGNvbnN0O1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NMQVNTID0gJ0ZpZ21hU3luY05vZGUnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZPTERFUiA9ICdmaWdtYS1pbXBvcnRlci1ydW50aW1lJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GSUxFID0gJ0ZpZ21hU3luY05vZGUudHMnO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9VUkwgPSBgZGI6Ly9hc3NldHMvJHtTWU5DX01BUktFUl9GT0xERVJ9LyR7U1lOQ19NQVJLRVJfRklMRX1gO1xuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NBVEVHT1JZID0gJ0ZpZ21hIEltcG9ydGVyJztcblxuLyoqIOagh+iusOe7hOS7tuWcqCBQcmVmYWIg5Lit5L+d5a2Y55qE5a2X5q6144CCICovXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xuICAgIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXI7XG4gICAgZmlnbWFGaWxlSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hTm9kZUlkOiBzdHJpbmc7XG4gICAgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZztcbiAgICBmaWdtYUFsaWFzSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hUGl4ZWxIYXNoOiBzdHJpbmc7XG4gICAgZmlnbWFTdWJ0cmVlSGFzaDogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSB7IFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJJbnB1dCB7XG4gICAgZmlsZUtleTogc3RyaW5nO1xuICAgIG5vZGU6IEZpZ21hTm9kZTtcbiAgICAvKiog6KKr5oqY5Y+g5ZC45pS255qE5a2Q5bGCIGlk77yI5LiN5ZCrIG5vZGUg6Ieq6Lqr77yJ44CCICovXG4gICAgYWxpYXNOb2RlSWRzPzogc3RyaW5nW107XG4gICAgc2NoZW1hPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wYXJpc29uIHtcbiAgICAvKiog5pys6IqC54K555qE5Yeg5L2V44CB5pi+6ZqQ44CB5aSW6KeC44CB5paH5a2X5oiW57uE5Lu257G75Z6L5Y+R55Sf5Y+Y5YyW44CCICovXG4gICAgdmlzdWFsQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiogRmlnbWEg5a2Q5qCR5YaF5Lu75oSP5ZCO5Luj5Y+R55Sf5Y+Y5YyW77yI5ZCr5paw5aKeL+WIoOmZpC/lkIzlkI3mm7/mjaLvvInjgIIgKi9cbiAgICBzdWJ0cmVlQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiog5oqY5Y+g5a2Q5bGC6ZuG5ZCI5Y+R55Sf5Y+Y5YyW77yI5a2Q5bGC5paw5aKe44CB5Yig6Zmk5oiW6KKr5pu/5o2i77yJ44CCICovXG4gICAgc3RydWN0dXJlQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiog6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH6LWE5rqQ5omN6IO95Y+N5pig6K6+6K6h5Y+Y5YyW44CCICovXG4gICAgYXNzZXRTdGFsZTogYm9vbGVhbjtcbn1cblxuY29uc3QgU0hBMjU2X1BBVFRFUk4gPSAvXnNoYTI1NjpbMC05YS1mXXs2NH0kLztcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHZhbHVlLnRyaW0oKS5yZXBsYWNlKC8tL2csICc6Jyk7XG59XG5cbmZ1bmN0aW9uIGZpbml0ZU9yTnVsbCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHF1YW50aXplRGVjaW1hbCh2YWx1ZSwgNCkgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBmcmFtZVBheWxvYWQoZnJhbWU6IFJlY3QgfCB1bmRlZmluZWQpOiBudW1iZXJbXSB8IG51bGwge1xuICAgIGlmICghZnJhbWUpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiBbXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS54KSA/PyAwLFxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueSkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLndpZHRoKSA/PyAwLFxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUuaGVpZ2h0KSA/PyAwLFxuICAgIF07XG59XG5cbmZ1bmN0aW9uIHBhaW50UGF5bG9hZChwYWludDogRmlnbWFQYWludCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBwYWludC50eXBlLFxuICAgICAgICB2aXNpYmxlOiBwYWludC52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgb3BhY2l0eTogZmluaXRlT3JOdWxsKHBhaW50Lm9wYWNpdHkgPz8gMSksXG4gICAgICAgIGJsZW5kTW9kZTogcGFpbnQuYmxlbmRNb2RlID8/IG51bGwsXG4gICAgICAgIGNvbG9yOiBwYWludC5jb2xvclxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLnIpLFxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5nKSxcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuYiksXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLmEgPz8gMSksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGltYWdlUmVmOiBwYWludC5pbWFnZVJlZiA/PyBudWxsLFxuICAgICAgICBzY2FsZU1vZGU6IHBhaW50LnNjYWxlTW9kZSA/PyBudWxsLFxuICAgICAgICByb3RhdGlvbjogZmluaXRlT3JOdWxsKHBhaW50LnJvdGF0aW9uKSxcbiAgICAgICAgc291cmNlTm9kZUlkOiBwYWludC5zb3VyY2VOb2RlSWQgPz8gbnVsbCxcbiAgICAgICAgdGlsZVR5cGU6IHBhaW50LnRpbGVUeXBlID8/IG51bGwsXG4gICAgICAgIHNjYWxpbmdGYWN0b3I6IGZpbml0ZU9yTnVsbChwYWludC5zY2FsaW5nRmFjdG9yKSxcbiAgICAgICAgc3BhY2luZzogcGFpbnQuc3BhY2luZ1xuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKHBhaW50LnNwYWNpbmcueCksIGZpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLnkpXVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBob3Jpem9udGFsQWxpZ25tZW50OiBwYWludC5ob3Jpem9udGFsQWxpZ25tZW50ID8/IG51bGwsXG4gICAgICAgIHZlcnRpY2FsQWxpZ25tZW50OiBwYWludC52ZXJ0aWNhbEFsaWdubWVudCA/PyBudWxsLFxuICAgICAgICBncmFkaWVudEhhbmRsZVBvc2l0aW9uczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudEhhbmRsZVBvc2l0aW9ucylcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnMubWFwKChoYW5kbGUpID0+IFtmaW5pdGVPck51bGwoaGFuZGxlLngpLCBmaW5pdGVPck51bGwoaGFuZGxlLnkpXSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZ3JhZGllbnRTdG9wczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudFN0b3BzKVxuICAgICAgICAgICAgPyBwYWludC5ncmFkaWVudFN0b3BzLm1hcCgoc3RvcCkgPT4gW2Zpbml0ZU9yTnVsbChzdG9wLnBvc2l0aW9uKSwgc3RvcC5jb2xvclxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICAgICAgZzogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuZyksXG4gICAgICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICA6IG51bGxdKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICAvLyDlm77niYfoo4HliIfnn6npmLXkuI7mu6TplZzlkIzmoLfmlLnlj5jlg4/ntKDvvIzkvYbkuI3kvJrmlLnlj5ggaW1hZ2VSZWbvvJvmvI/mjonlroPku6zkvJrorqlcbiAgICAgICAgLy8g5pW05bGC6IqC54K55Zyo6YeN5a+85YWl5ZCO57un57ut5pi+56S65pen5Zu+44CCXG4gICAgICAgIGltYWdlVHJhbnNmb3JtOiBBcnJheS5pc0FycmF5KHBhaW50LmltYWdlVHJhbnNmb3JtKVxuICAgICAgICAgICAgPyBwYWludC5pbWFnZVRyYW5zZm9ybS5tYXAoKHJvdykgPT4gKEFycmF5LmlzQXJyYXkocm93KVxuICAgICAgICAgICAgICAgID8gcm93Lm1hcCgodmFsdWUpID0+IGZpbml0ZU9yTnVsbCh2YWx1ZSkpXG4gICAgICAgICAgICAgICAgOiBudWxsKSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZmlsdGVyczogcGFpbnQuZmlsdGVyc1xuICAgICAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMocGFpbnQuZmlsdGVycylcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChbLCB2YWx1ZV0pID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSlcbiAgICAgICAgICAgICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IFtrZXksIGZpbml0ZU9yTnVsbCh2YWx1ZSldKSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBlZmZlY3RQYXlsb2FkKGVmZmVjdDogRmlnbWFFZmZlY3QpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogZWZmZWN0LnR5cGUsXG4gICAgICAgIHZpc2libGU6IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgcmFkaXVzOiBmaW5pdGVPck51bGwoZWZmZWN0LnJhZGl1cyksXG4gICAgICAgIHNwcmVhZDogZmluaXRlT3JOdWxsKGVmZmVjdC5zcHJlYWQpLFxuICAgICAgICBvZmZzZXRYOiBmaW5pdGVPck51bGwoZWZmZWN0Lm9mZnNldD8ueCksXG4gICAgICAgIG9mZnNldFk6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py55KSxcbiAgICAgICAgY29sb3I6IGVmZmVjdC5jb2xvclxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmcpLFxuICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuYiksXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBudWxsLFxuICAgIH07XG59XG5cbmZ1bmN0aW9uIHRleHRQYXlsb2FkKHN0eWxlOiBGaWdtYVRleHRTdHlsZSB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gICAgaWYgKCFzdHlsZSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZm9udEZhbWlseTogc3R5bGUuZm9udEZhbWlseSA/PyBudWxsLFxuICAgICAgICBmb250UG9zdFNjcmlwdE5hbWU6IHN0eWxlLmZvbnRQb3N0U2NyaXB0TmFtZSA/PyBudWxsLFxuICAgICAgICBmb250V2VpZ2h0OiBmaW5pdGVPck51bGwoc3R5bGUuZm9udFdlaWdodCksXG4gICAgICAgIGZvbnRTaXplOiBmaW5pdGVPck51bGwoc3R5bGUuZm9udFNpemUpLFxuICAgICAgICB0ZXh0QWxpZ25Ib3Jpem9udGFsOiBzdHlsZS50ZXh0QWxpZ25Ib3Jpem9udGFsID8/IG51bGwsXG4gICAgICAgIHRleHRBbGlnblZlcnRpY2FsOiBzdHlsZS50ZXh0QWxpZ25WZXJ0aWNhbCA/PyBudWxsLFxuICAgICAgICBsZXR0ZXJTcGFjaW5nOiBmaW5pdGVPck51bGwoc3R5bGUubGV0dGVyU3BhY2luZyksXG4gICAgICAgIGxpbmVIZWlnaHRQeDogZmluaXRlT3JOdWxsKHN0eWxlLmxpbmVIZWlnaHRQeCksXG4gICAgICAgIHRleHRBdXRvUmVzaXplOiBzdHlsZS50ZXh0QXV0b1Jlc2l6ZSA/PyBudWxsLFxuICAgICAgICB0ZXh0VHJ1bmNhdGlvbjogc3R5bGUudGV4dFRydW5jYXRpb24gPz8gbnVsbCxcbiAgICAgICAgbWF4TGluZXM6IGZpbml0ZU9yTnVsbChzdHlsZS5tYXhMaW5lcyksXG4gICAgfTtcbn1cblxuLyoqXG4gKiDmnKzoioLngrnoh6rouqvnmoTop4bop4notKHnjK7vvJrlh6DkvZXjgIHmmL7pmpDjgIHloavlhYUv5o+P6L65L+eJueaViOOAgeWchuinkuOAgeaWh+Wtl+S4juagt+W8j+OAglxuICog5LiN5YyF5ZCr5a2Q6IqC54K577yM5Zug5q2k5oqY5Y+g54i26IqC54K555qE5oyH57q55LiN5Lya5Zug5a2Q5bGC56e75Yqo6ICM5Y+Y5YyW44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jVmlzdWFsUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgaWQ6IG5vcm1hbGl6ZVN5bmNOb2RlSWQobm9kZS5pZCksXG4gICAgICAgIHR5cGU6IG5vZGUudHlwZSxcbiAgICAgICAgZnJhbWU6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpLFxuICAgICAgICByZW5kZXJCb3VuZHM6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlUmVuZGVyQm91bmRzKSxcbiAgICAgICAgc2l6ZTogbm9kZS5zaXplXG4gICAgICAgICAgICA/IFtmaW5pdGVPck51bGwobm9kZS5zaXplLndpZHRoKSwgZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS5oZWlnaHQpXVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICByb3RhdGlvbjogZmluaXRlT3JOdWxsKG5vZGUucm90YXRpb24pLFxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUgIT09IGZhbHNlLFxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwobm9kZS5vcGFjaXR5ID8/IDEpLFxuICAgICAgICBibGVuZE1vZGU6IG5vZGUuYmxlbmRNb2RlID8/IG51bGwsXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQgPT09IHRydWUsXG4gICAgICAgIGNvcm5lclJhZGl1czogZmluaXRlT3JOdWxsKG5vZGUuY29ybmVyUmFkaXVzKSxcbiAgICAgICAgcmVjdGFuZ2xlQ29ybmVyUmFkaWk6IEFycmF5LmlzQXJyYXkobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSlcbiAgICAgICAgICAgID8gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaS5tYXAoKHJhZGl1cykgPT4gZmluaXRlT3JOdWxsKHJhZGl1cykpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIC8vIOWchuW8p+eahOi1t+atouinkuS4juWGheWNiuW+hOWPquaUueWDj+e0oO+8jOS4jeaUueWkluahhu+8m+S4jee6s+WFpeaMh+e6ueS8mua8j+aOieaVtOWxguiKgueCueeahOaWsOW9oueKtuOAglxuICAgICAgICBhcmNEYXRhOiBub2RlLmFyY0RhdGFcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHN0YXJ0aW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSksXG4gICAgICAgICAgICAgICAgZW5kaW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUpLFxuICAgICAgICAgICAgICAgIGlubmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZmlsbHM6IChub2RlLmZpbGxzID8/IFtdKS5tYXAocGFpbnRQYXlsb2FkKSxcbiAgICAgICAgc3Ryb2tlczogKG5vZGUuc3Ryb2tlcyA/PyBbXSkubWFwKHBhaW50UGF5bG9hZCksXG4gICAgICAgIHN0cm9rZVdlaWdodDogZmluaXRlT3JOdWxsKG5vZGUuc3Ryb2tlV2VpZ2h0KSxcbiAgICAgICAgc3Ryb2tlQWxpZ246IG5vZGUuc3Ryb2tlQWxpZ24gPz8gbnVsbCxcbiAgICAgICAgZWZmZWN0czogKG5vZGUuZWZmZWN0cyA/PyBbXSkubWFwKGVmZmVjdFBheWxvYWQpLFxuICAgICAgICBjaGFyYWN0ZXJzOiB0eXBlb2Ygbm9kZS5jaGFyYWN0ZXJzID09PSAnc3RyaW5nJyA/IG5vZGUuY2hhcmFjdGVycyA6IG51bGwsXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFBheWxvYWQobm9kZS5zdHlsZSksXG4gICAgfTtcbn1cblxuLyoqIOWtkOagkee7k+aehO+8muacrOiKgueCueaMh+e6uSArIOmAkOWxguWtkOiKgueCueaMh+e6ue+8jOeUqOS6juWIpOaWrea4suafk+Wei+iKgueCueaYr+WQpumcgOimgemHjeaWsOWHuuWbvuOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdmlzdWFsOiBzeW5jVmlzdWFsUGF5bG9hZChub2RlKSxcbiAgICAgICAgY2hpbGRyZW46IChub2RlLmNoaWxkcmVuID8/IFtdKS5tYXAoKGNoaWxkKSA9PiBzeW5jU3VidHJlZVBheWxvYWQoY2hpbGQpKSxcbiAgICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbEhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShzeW5jVmlzdWFsUGF5bG9hZChub2RlKSkpO1xufVxuXG4vKipcbiAqIOWPquS/neeVmeW9seWTjeWDj+e0oOeahOWxnuaAp++8muaKiumhtemdouWdkOagh++8iHgvee+8ieS7jiBmcmFtZSDkuI4gcmVuZGVyQm91bmRzIOS4reWJlOmZpOOAglxuICog56e75Yqo6IqC54K55Y+q5pS55L2N572u77yM5LiN5bqU6KKr5Yik5a6a5Li6XCLlm77niYfov4fmnJ9cIu+8m+WwuuWvuOOAgeaXi+i9rOOAgeWkluinguS7jeeEtuiuoeWFpeOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1BpeGVsUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3QgdmlzdWFsID0gc3luY1Zpc3VhbFBheWxvYWQobm9kZSk7XG4gICAgY29uc3QgZnJhbWUgPSB2aXN1YWwuZnJhbWUgYXMgbnVtYmVyW10gfCBudWxsO1xuICAgIGNvbnN0IHJlbmRlciA9IHZpc3VhbC5yZW5kZXJCb3VuZHMgYXMgbnVtYmVyW10gfCBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICAgIC4uLnZpc3VhbCxcbiAgICAgICAgZnJhbWU6IGZyYW1lID8gW2ZyYW1lWzJdLCBmcmFtZVszXV0gOiBudWxsLFxuICAgICAgICByZW5kZXJCb3VuZHM6IHJlbmRlciA/IFtyZW5kZXJbMl0sIHJlbmRlclszXV0gOiBudWxsLFxuICAgIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW5jUGl4ZWxIYXNoKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1BpeGVsUGF5bG9hZChub2RlKSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY1N1YnRyZWVIYXNoKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1N1YnRyZWVQYXlsb2FkKG5vZGUpKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICAgIGNvbnN0IGlkcyA9IFsuLi5uZXcgU2V0KGFsaWFzTm9kZUlkcy5tYXAobm9ybWFsaXplU3luY05vZGVJZCkuZmlsdGVyKEJvb2xlYW4pKV0uc29ydCgpO1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KGlkcykpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY0ZpbGVIYXNoKGZpbGVLZXk6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IGZpbGVLZXkudHJpbSgpO1xuICAgIGlmICghbm9ybWFsaXplZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+e7hOS7tuWQjOatpee8uuWwkSBGaWdtYSBmaWxlIGtleeOAgicpO1xuICAgIH1cbiAgICByZXR1cm4gc2hhMjU2KGBmaWdtYS1pbXBvcnRlcjpzeW5jLWZpbGU6djFcXDAke25vcm1hbGl6ZWR9YCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTeW5jTWFya2VyKGlucHV0OiBTeW5jTWFya2VySW5wdXQpOiBTeW5jTWFya2VyU3BlYyB7XG4gICAgY29uc3Qgbm9kZUlkID0gbm9ybWFsaXplU3luY05vZGVJZChpbnB1dC5ub2RlLmlkKTtcbiAgICBpZiAoIW5vZGVJZCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+e7hOS7tuWQjOatpeiKgueCuee8uuWwkSBGaWdtYSDoioLngrkgaWTjgIInKTtcbiAgICB9XG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gWy4uLm5ldyBTZXQoKGlucHV0LmFsaWFzTm9kZUlkcyA/PyBbXSlcbiAgICAgICAgLm1hcChub3JtYWxpemVTeW5jTm9kZUlkKVxuICAgICAgICAuZmlsdGVyKChpZCkgPT4gQm9vbGVhbihpZCkgJiYgaWQgIT09IG5vZGVJZCkpXS5zb3J0KCk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc2NoZW1hOiBpbnB1dC5zY2hlbWEgPz8gU1lOQ19NQVJLRVJfU0NIRU1BLFxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBzeW5jRmlsZUhhc2goaW5wdXQuZmlsZUtleSksXG4gICAgICAgIGZpZ21hTm9kZUlkOiBub2RlSWQsXG4gICAgICAgIGFsaWFzTm9kZUlkcyxcbiAgICAgICAgYWxpYXNIYXNoOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyksXG4gICAgICAgIHZpc3VhbEhhc2g6IHN5bmNWaXN1YWxIYXNoKGlucHV0Lm5vZGUpLFxuICAgICAgICBwaXhlbEhhc2g6IHN5bmNQaXhlbEhhc2goaW5wdXQubm9kZSksXG4gICAgICAgIHN1YnRyZWVIYXNoOiBzeW5jU3VidHJlZUhhc2goaW5wdXQubm9kZSksXG4gICAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVTeW5jTWFya2VyKFxuICAgIHByZXZpb3VzOiBTeW5jTWFya2VyU3BlYyxcbiAgICBuZXh0OiBTeW5jTWFya2VyU3BlYyxcbik6IFN5bmNNYXJrZXJDb21wYXJpc29uIHtcbiAgICBjb25zdCB2aXN1YWxDaGFuZ2VkID0gcHJldmlvdXMudmlzdWFsSGFzaCAhPT0gbmV4dC52aXN1YWxIYXNoO1xuICAgIGNvbnN0IHN1YnRyZWVDaGFuZ2VkID0gcHJldmlvdXMuc3VidHJlZUhhc2ggIT09IG5leHQuc3VidHJlZUhhc2g7XG4gICAgY29uc3Qgc3RydWN0dXJlQ2hhbmdlZCA9IHByZXZpb3VzLmFsaWFzSGFzaCAhPT0gbmV4dC5hbGlhc0hhc2hcbiAgICAgICAgfHwgcHJldmlvdXMuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSAhPT0gbmV4dC5hbGlhc05vZGVJZHMuam9pbignLCcpO1xuICAgIGNvbnN0IHNvdXJjZUNoYW5nZWQgPSBwcmV2aW91cy5maWdtYUZpbGVIYXNoICE9PSBuZXh0LmZpZ21hRmlsZUhhc2hcbiAgICAgICAgfHwgcHJldmlvdXMuZmlnbWFOb2RlSWQgIT09IG5leHQuZmlnbWFOb2RlSWQ7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdmlzdWFsQ2hhbmdlZCxcbiAgICAgICAgc3VidHJlZUNoYW5nZWQsXG4gICAgICAgIHN0cnVjdHVyZUNoYW5nZWQsXG4gICAgICAgIC8vIOaNouS6huadpea6kOOAgeWHoOS9leOAgeWtkOagkeaIluaKmOWPoOmbhuWQiO+8jOmDveaEj+WRs+edgOi/meW8oOWbvuS4jeWGjeaYr+S4iuasoeWvvOWHuueahOmCo+W8oOOAglxuICAgICAgICBhc3NldFN0YWxlOiB2aXN1YWxDaGFuZ2VkIHx8IHN1YnRyZWVDaGFuZ2VkIHx8IHN0cnVjdHVyZUNoYW5nZWQgfHwgc291cmNlQ2hhbmdlZCxcbiAgICB9O1xufVxuXG4vKiog5Yik5pat5LiA5Liq5LiN6YCP5piO6KeG6KeJ6IqC54K577yI55+i6YePL+aVtOWxgiBQTkcv5oqY5Y+g5YyF6KOF77yJ5piv5ZCm6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH44CCICovXG5leHBvcnQgZnVuY3Rpb24gc3luY05lZWRzQXNzZXRSZWZyZXNoKG9wdGlvbnM6IHtcbiAgICBjb21wYXJpc29uOiBTeW5jTWFya2VyQ29tcGFyaXNvbjtcbiAgICAvKiog5b2T5YmN6IqC54K55piv5ZCm5LulIFBORyDlvaLlvI/okL3lnLDvvIjmlbTlsYIgcmVuZGVy44CB55+i6YeP44CB5oqY5Y+gIFNwcml0ZS9MYWJlbO+8ieOAgiAqL1xuICAgIHJhc3Rlcml6ZWQ6IGJvb2xlYW47XG59KTogYm9vbGVhbiB7XG4gICAgaWYgKCFvcHRpb25zLnJhc3Rlcml6ZWQpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gb3B0aW9ucy5jb21wYXJpc29uLmFzc2V0U3RhbGU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrZXJUb0NvbXBvbmVudFZhbHVlcyhtYXJrZXI6IFN5bmNNYXJrZXJTcGVjKTogU3luY01hcmtlckNvbXBvbmVudFZhbHVlcyB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZmlnbWFNYXJrZXJTY2hlbWE6IG1hcmtlci5zY2hlbWEsXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IG1hcmtlci5maWdtYUZpbGVIYXNoLFxuICAgICAgICBmaWdtYU5vZGVJZDogbWFya2VyLmZpZ21hTm9kZUlkLFxuICAgICAgICBmaWdtYUFsaWFzTm9kZUlkczogbWFya2VyLmFsaWFzTm9kZUlkcy5qb2luKCcsJyksXG4gICAgICAgIGZpZ21hQWxpYXNIYXNoOiBtYXJrZXIuYWxpYXNIYXNoLFxuICAgICAgICBmaWdtYVZpc3VhbEhhc2g6IG1hcmtlci52aXN1YWxIYXNoLFxuICAgICAgICBmaWdtYVBpeGVsSGFzaDogbWFya2VyLnBpeGVsSGFzaCA/PyAnJyxcbiAgICAgICAgZmlnbWFTdWJ0cmVlSGFzaDogbWFya2VyLnN1YnRyZWVIYXNoLFxuICAgIH07XG59XG5cbi8qKlxuICog5Yik5pat5LiA5Liq57uE5Lu25a6e5L6L5piv5ZCm5piv5pys5o+S5Lu255Sf5oiQ55qE5ZCM5q2l5qCH6K6w44CCXG4gKiDnlKjkuo7miYDmnInmnYPliKTlrprvvJrmoIforrDmsLjov5zlsZ7kuo7mj5Lku7bvvIzkuI3og73nrpfkvZxcIuaJi+W3pee7hOS7tlwi6Zi75q2i6IqC54K55Yig6Zmk44CCXG4gKiDmjInlrZfmrrXor4bliKvvvIzkuI3kvp3otZbohJrmnKwgVVVJRCDigJTigJQg6ISa5pys6YeN5paw5a+85YWl5oiWIFVVSUQg5Y+Y5YyW5pe25LuN54S25oiQ56uL44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJDb21wb25lbnRWYWx1ZSh2YWx1ZTogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IHJlY29yZCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIHJldHVybiByZWNvcmQuZmlnbWFNYXJrZXJTY2hlbWEgPT09IFNZTkNfTUFSS0VSX1NDSEVNQVxuICAgICAgICAmJiB0eXBlb2YgcmVjb3JkLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJ1xuICAgICAgICAmJiByZWNvcmQuZmlnbWFOb2RlSWQubGVuZ3RoID4gMFxuICAgICAgICAmJiB0eXBlb2YgcmVjb3JkLmZpZ21hVmlzdWFsSGFzaCA9PT0gJ3N0cmluZyc7XG59XG5cbi8qKiDku44gQ29jb3Mg57uE5Lu26K+75Zue5qCH6K6w77yb5a2X5q6157y65aSx5oiW5o2f5Z2P5pe26L+U5ZueIG51bGzvvIznlLHosIPnlKjmlrkgZmFpbC1jbG9zZWTjgIIgKi9leHBvcnQgZnVuY3Rpb24gbWFya2VyRnJvbUNvbXBvbmVudFZhbHVlcyhcbiAgICB2YWx1ZXM6IFBhcnRpYWw8U3luY01hcmtlckNvbXBvbmVudFZhbHVlcz4gfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogU3luY01hcmtlclNwZWMgfCBudWxsIHtcbiAgICBpZiAoIXZhbHVlcyB8fCB0eXBlb2YgdmFsdWVzICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3Qgc2NoZW1hID0gdmFsdWVzLmZpZ21hTWFya2VyU2NoZW1hO1xuICAgIGlmIChzY2hlbWEgIT09IFNZTkNfTUFSS0VSX1NDSEVNQSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgZmlsZUhhc2ggPSB2YWx1ZXMuZmlnbWFGaWxlSGFzaDtcbiAgICBjb25zdCBub2RlSWQgPSB0eXBlb2YgdmFsdWVzLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJyA/IG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWVzLmZpZ21hTm9kZUlkKSA6ICcnO1xuICAgIGNvbnN0IHZpc3VhbEhhc2ggPSB2YWx1ZXMuZmlnbWFWaXN1YWxIYXNoO1xuICAgIGNvbnN0IHN1YnRyZWVIYXNoID0gdmFsdWVzLmZpZ21hU3VidHJlZUhhc2g7XG4gICAgaWYgKHR5cGVvZiBmaWxlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QoZmlsZUhhc2gpKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBpZiAoIW5vZGVJZCB8fCB0eXBlb2YgdmlzdWFsSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QodmlzdWFsSGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGlmICh0eXBlb2Ygc3VidHJlZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHN1YnRyZWVIYXNoKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcyA9PT0gJ3N0cmluZydcbiAgICAgICAgPyB2YWx1ZXMuZmlnbWFBbGlhc05vZGVJZHMuc3BsaXQoJywnKVxuICAgICAgICAgICAgLm1hcCgoaWQpID0+IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaWQpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLnNvcnQoKVxuICAgICAgICA6IFtdO1xuICAgIGNvbnN0IGFsaWFzSGFzaCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc0hhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hQWxpYXNIYXNoKVxuICAgICAgICA/IHZhbHVlcy5maWdtYUFsaWFzSGFzaFxuICAgICAgICA6IHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBzY2hlbWEsXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IGZpbGVIYXNoLFxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxuICAgICAgICBhbGlhc05vZGVJZHMsXG4gICAgICAgIGFsaWFzSGFzaCxcbiAgICAgICAgdmlzdWFsSGFzaCxcbiAgICAgICAgcGl4ZWxIYXNoOiB0eXBlb2YgdmFsdWVzLmZpZ21hUGl4ZWxIYXNoID09PSAnc3RyaW5nJyAmJiBTSEEyNTZfUEFUVEVSTi50ZXN0KHZhbHVlcy5maWdtYVBpeGVsSGFzaClcbiAgICAgICAgICAgID8gdmFsdWVzLmZpZ21hUGl4ZWxIYXNoXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgc3VidHJlZUhhc2gsXG4gICAgfTtcbn1cblxuLyoqXG4gKiDkuIDkuKogRmlnbWEg6IqC54K55Y+q6IO96KKr5LiA5LiqIENvY29zIOiKgueCueWjsOaYju+8iOiHquW3seaIluS9nOS4uuWIq+WQje+8ieOAglxuICog5oqY5Y+g54i25a2Q5ZCM5pe25aOw5piO5ZCM5rqQ6IqC54K55Lya6K6pXCLmlLnlk6rkuKroioLngrlcIuWPmOW+l+S4jeWPr+WIpOWumuOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0VW5pcXVlU3luY093bmVyc2hpcChtYXJrZXJzOiByZWFkb25seSBTeW5jTWFya2VyU3BlY1tdKTogdm9pZCB7XG4gICAgY29uc3Qgb3duZXJzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIFttYXJrZXIuZmlnbWFOb2RlSWQsIC4uLm1hcmtlci5hbGlhc05vZGVJZHNdKSB7XG4gICAgICAgICAgICBjb25zdCBvd25lciA9IG93bmVycy5nZXQobm9kZUlkKTtcbiAgICAgICAgICAgIGlmIChvd25lciAmJiBvd25lciAhPT0gbWFya2VyLmZpZ21hTm9kZUlkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICBgRmlnbWEg6IqC54K5ICR7bm9kZUlkfSDlkIzml7booqsgJHtvd25lcn0g5ZKMICR7bWFya2VyLmZpZ21hTm9kZUlkfSDlo7DmmI7vvIzlt7Lmi5Lnu53nlJ/miJDlkIzmraXmoIforrDjgIJgLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvd25lcnMuc2V0KG5vZGVJZCwgbWFya2VyLmZpZ21hTm9kZUlkKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuLyoqIOmcgOimgeWcqOmhueebriBhc3NldHMg5Lit55Sf5oiQ55qE5pyA5bCP5qCH6K6w57uE5Lu25rqQ56CB77yI5peg5Lia5Yqh6YC76L6R77yM5Y+q5L+d5a2Y5p2l5rqQ5LiO5oyH57q577yJ44CCICovXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfU0NSSVBUX1NPVVJDRSA9IGBpbXBvcnQgeyBfZGVjb3JhdG9yLCBDb21wb25lbnQgfSBmcm9tICdjYyc7XG5cbmNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHkgfSA9IF9kZWNvcmF0b3I7XG5cbi8qKlxuICogRmlnbWEgSW1wb3J0ZXIg55Sf5oiQ55qE5ZCM5q2l5qCH6K6w44CC5a2X5q6155Sx5o+S5Lu257u05oqk77yM5omL5bel5L+u5pS55Lya5a+86Ie05LiL5qyh5ZCM5q2l6KKr5ouS57ud44CCXG4gKiDliKDpmaTmnKznu4Tku7bljbPooajnpLror6XoioLngrnpgIDlh7ogRmlnbWEg5ZCM5q2l77ya5o+S5Lu25LiN5Lya5YaN56e75Yqo44CB57yp5pS+5oiW5Yig6Zmk5a6D44CCXG4gKi9cbkBjY2NsYXNzKCcke1NZTkNfTUFSS0VSX0NMQVNTfScpXG5leHBvcnQgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnQge1xuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmoIforrDljY/orq7niYjmnKwnIH0pXG4gICAgcHVibGljIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXIgPSAke1NZTkNfTUFSS0VSX1NDSEVNQX07XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAnRmlnbWEg5paH5Lu2IGtleSDnmoQgU0hBLTI1NicgfSlcbiAgICBwdWJsaWMgZmlnbWFGaWxlSGFzaDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAnRmlnbWEg6IqC54K5IGlkJyB9KVxuICAgIHB1YmxpYyBmaWdtYU5vZGVJZDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn6KKr5oqY5Y+g5Yiw5pys6IqC54K555qEIEZpZ21hIOWtkOWxgiBpZO+8jOmAl+WPt+WIhumalCcgfSlcbiAgICBwdWJsaWMgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+aKmOWPoOWtkOWxgumbhuWQiOaMh+e6uScgfSlcbiAgICBwdWJsaWMgZmlnbWFBbGlhc0hhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+acrOasoeWvvOWFpeaXtueahOiKgueCueinhuinieaMh+e6uScgfSlcbiAgICBwdWJsaWMgZmlnbWFWaXN1YWxIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoTlg4/ntKDmjIfnurnvvIjkuI3lkKvpobXpnaLlnZDmoIfvvIknIH0pXG4gICAgcHVibGljIGZpZ21hUGl4ZWxIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoTlrZDmoJHmjIfnurknIH0pXG4gICAgcHVibGljIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZyA9ICcnO1xufVxuYDtcblxuLyoqIOmqjOivgeeUn+aIkOWIsOmhueebrumHjOeahOiEmuacrOayoeacieiiq+aIquaWreaIluiiq+aUueaIkOWIq+eahOexu+OAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3luY01hcmtlclNjcmlwdChzb3VyY2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0eXBlb2Ygc291cmNlID09PSAnc3RyaW5nJ1xuICAgICAgICAmJiBzb3VyY2UuaW5jbHVkZXMoYEBjY2NsYXNzKCcke1NZTkNfTUFSS0VSX0NMQVNTfScpYClcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBjbGFzcyAke1NZTkNfTUFSS0VSX0NMQVNTfSBleHRlbmRzIENvbXBvbmVudGApXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcygnZmlnbWFTdWJ0cmVlSGFzaCcpO1xufVxuIl19