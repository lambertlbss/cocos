"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNC_MARKER_SCRIPT_SOURCE = exports.SYNC_MARKER_CATEGORY = exports.SYNC_MARKER_SCRIPT_URL = exports.SYNC_MARKER_FILE = exports.SYNC_MARKER_FOLDER = exports.SYNC_MARKER_CLASS = exports.SYNC_MARKER_SCHEMA = void 0;
exports.normalizeSyncNodeId = normalizeSyncNodeId;
exports.syncVisualPayload = syncVisualPayload;
exports.syncSubtreePayload = syncSubtreePayload;
exports.syncVisualHash = syncVisualHash;
exports.syncPixelPayload = syncPixelPayload;
exports.isPlainImageNode = isPlainImageNode;
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
 * 只保留影响像素的属性：坐标改为相对本节点原点的偏移，并递归包含整棵子树。
 * - 整个节点在页面里移动：所有相对坐标不变 → 像素指纹不变；
 * - 子层在节点内部移动：相对坐标改变 → 像素指纹改变；
 * - 尺寸、旋转、外观、文字与任何后代变化都计入。
 */
function syncPixelPayload(node, origin, root = true) {
    var _a, _b, _c;
    const visual = syncVisualPayload(node);
    const box = node.absoluteBoundingBox;
    const base = origin !== null && origin !== void 0 ? origin : { x: (_a = box === null || box === void 0 ? void 0 : box.x) !== null && _a !== void 0 ? _a : 0, y: (_b = box === null || box === void 0 ? void 0 : box.y) !== null && _b !== void 0 ? _b : 0 };
    const relative = (frame) => (frame
        ? [
            (0, canonical_json_1.quantizeDecimal)(frame[0] - base.x, 4),
            (0, canonical_json_1.quantizeDecimal)(frame[1] - base.y, 4),
            frame[2],
            frame[3],
        ]
        : null);
    // 纯图片节点的位图可以被 Sprite 直接拉伸：自身尺寸/旋转不改变像素内容，
    // 因此不参与像素指纹（后代仍然参与，缩放子层会改变整层渲染结果）。
    const stretchable = root && isPlainImageNode(node);
    return {
        ...visual,
        size: stretchable ? null : visual.size,
        rotation: stretchable ? null : visual.rotation,
        frame: stretchable ? null : relative(visual.frame),
        renderBounds: stretchable ? null : relative(visual.renderBounds),
        children: ((_c = node.children) !== null && _c !== void 0 ? _c : []).map((child) => syncPixelPayload(child, base, false)),
    };
}
/**
 * 纯图片节点：单个可见 IMAGE 填充、无描边/特效/圆角/裁剪/圆弧、无子层。
 * 这类节点的位图可以被 Sprite 直接拉伸，改变尺寸或旋转不需要重新出图。
 */
function isPlainImageNode(node) {
    var _a, _b, _c, _d, _e, _f;
    if ((_a = node.children) === null || _a === void 0 ? void 0 : _a.length) {
        return false;
    }
    if (node.clipsContent || node.arcData) {
        return false;
    }
    if (((_b = node.cornerRadius) !== null && _b !== void 0 ? _b : 0) > 0 || ((_c = node.rectangleCornerRadii) !== null && _c !== void 0 ? _c : []).some((radius) => radius > 0)) {
        return false;
    }
    if (((_d = node.strokes) !== null && _d !== void 0 ? _d : []).some((stroke) => stroke.visible !== false)) {
        return false;
    }
    if (((_e = node.effects) !== null && _e !== void 0 ? _e : []).some((effect) => effect.visible !== false)) {
        return false;
    }
    const visibleFills = ((_f = node.fills) !== null && _f !== void 0 ? _f : []).filter((fill) => fill.visible !== false);
    return visibleFills.length === 1
        && visibleFills[0].type === 'IMAGE'
        && Boolean(visibleFills[0].imageRef);
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
    // 像素是否变化：两边都有像素指纹时用它（不含页面坐标）；
    // 旧标记没有该字段时退回子树指纹，宁可多判一次过期，也不能漏掉真实改动。
    const pixelComparable = typeof previous.pixelHash === 'string'
        && typeof next.pixelHash === 'string';
    const pixelChanged = pixelComparable
        ? previous.pixelHash !== next.pixelHash
        : subtreeChanged;
    return {
        visualChanged,
        pixelChanged,
        subtreeChanged,
        structureChanged,
        // 只改位置不再要求重新出图；来源、像素或折叠结构变化才需要。
        assetStale: pixelChanged || structureChanged || sourceChanged,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBeURBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFRRCw0Q0EyQkM7QUFNRCw0Q0FvQkM7QUFFRCxzQ0FFQztBQUVELDBDQUVDO0FBRUQsc0NBR0M7QUFFRCxvQ0FNQztBQUVELDRDQWtCQztBQUVELDhDQXlCQztBQUdELHNEQVNDO0FBRUQsMERBV0M7QUFPRCxnRUFTQztBQUVzRCw4REE0Q3REO0FBTUQsOERBYUM7QUF3Q0QsZ0RBS0M7QUFqZkQsZ0VBQTBGO0FBRTFGOzs7Ozs7Ozs7R0FTRztBQUNVLFFBQUEsa0JBQWtCLEdBQUcsQ0FBVSxDQUFDO0FBQ2hDLFFBQUEsaUJBQWlCLEdBQUcsZUFBZSxDQUFDO0FBQ3BDLFFBQUEsa0JBQWtCLEdBQUcsd0JBQXdCLENBQUM7QUFDOUMsUUFBQSxnQkFBZ0IsR0FBRyxrQkFBa0IsQ0FBQztBQUN0QyxRQUFBLHNCQUFzQixHQUFHLGVBQWUsMEJBQWtCLElBQUksd0JBQWdCLEVBQUUsQ0FBQztBQUNqRixRQUFBLG9CQUFvQixHQUFHLGdCQUFnQixDQUFDO0FBcUNyRCxNQUFNLGNBQWMsR0FBRyx1QkFBdUIsQ0FBQztBQUUvQyxTQUFnQixtQkFBbUIsQ0FBQyxLQUFhO0lBQzdDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQXlCO0lBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUEsZ0NBQWUsRUFBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFD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QUFDO0FBQ0wsQ0FBQztBQUVELGlEQUFpRDtBQUNwQyxRQUFBLHlCQUF5QixHQUFHOzs7Ozs7OztZQVE3Qix5QkFBaUI7ZUFDZCx5QkFBaUI7O3lDQUVTLDBCQUFrQjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QjFELENBQUM7QUFFRiwrQkFBK0I7QUFDL0IsU0FBZ0Isa0JBQWtCLENBQUMsTUFBYztJQUM3QyxPQUFPLE9BQU8sTUFBTSxLQUFLLFFBQVE7V0FDMUIsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLHlCQUFpQixJQUFJLENBQUM7V0FDbkQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxTQUFTLHlCQUFpQixvQkFBb0IsQ0FBQztXQUMvRCxNQUFNLENBQUMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDL0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFFZmZlY3QsIEZpZ21hTm9kZSwgRmlnbWFQYWludCwgRmlnbWFUZXh0U3R5bGUsIFJlY3QsIFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBjYW5vbmljYWxTdHJpbmdpZnksIHF1YW50aXplRGVjaW1hbCwgc2hhMjU2IH0gZnJvbSAnLi4vcm91bmR0cmlwL2Nhbm9uaWNhbC1qc29uJztcclxuXHJcbi8qKlxyXG4gKiDnu4Tku7bnuqflj4zovrnlkIzmraXvvIhDb21wb25lbnQgU3luY++8ieeahOagh+iusOWNj+iuruOAglxyXG4gKlxyXG4gKiDmoIforrDnu4Tku7YgYEZpZ21hU3luY05vZGVgIOaMguWcqOavj+S4queUseWQjOatpeaooeW8j+eUn+aIkOeahCBDb2NvcyDoioLngrnkuIrvvIxcclxuICog5pei5o+Q5L6b5Y+v6KeB6Lqr5Lu977yIRmlnbWEg6IqC54K5IGlk77yJ77yM5Lmf5L+d5a2Y5LiK5qyh5a+85YWl5pe255qE6KeG6KeJL+WtkOagkeaMh+e6ue+8jFxyXG4gKiDkvb/ph43mlrDlr7zlhaXog73lnKjkuI3miZPlvIAgUHJlZmFiIOeahOaDheWGteS4i+WIpOaWrVwi6K6+6K6h5pS55LqG5LuA5LmIXCLjgIJcclxuICpcclxuICog5a6J5YWo6L6555WM77yaZmlsZSBrZXkg5Y+q5LulIFNIQS0yNTYg5b2i5byP5L+d5a2Y77ybbm9kZSBpZCDmjInpnIDmsYLmmI7mlofkv53lrZjvvIxcclxuICog5LiOIFByb2plY3QgUHJvZmlsZSDkuK0gbm9kZU1hcHMgLyBub2RlT3ZlcnJpZGVzIOeahOaXouacieaYjuaWh+S4gOiHtOOAglxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDSEVNQSA9IDEgYXMgY29uc3Q7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DTEFTUyA9ICdGaWdtYVN5bmNOb2RlJztcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZPTERFUiA9ICdmaWdtYS1pbXBvcnRlci1ydW50aW1lJztcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZJTEUgPSAnRmlnbWFTeW5jTm9kZS50cyc7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfVVJMID0gYGRiOi8vYXNzZXRzLyR7U1lOQ19NQVJLRVJfRk9MREVSfS8ke1NZTkNfTUFSS0VSX0ZJTEV9YDtcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NBVEVHT1JZID0gJ0ZpZ21hIEltcG9ydGVyJztcclxuXHJcbi8qKiDmoIforrDnu4Tku7blnKggUHJlZmFiIOS4reS/neWtmOeahOWtl+auteOAgiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xyXG4gICAgZmlnbWFNYXJrZXJTY2hlbWE6IG51bWJlcjtcclxuICAgIGZpZ21hRmlsZUhhc2g6IHN0cmluZztcclxuICAgIGZpZ21hTm9kZUlkOiBzdHJpbmc7XHJcbiAgICBmaWdtYUFsaWFzTm9kZUlkczogc3RyaW5nO1xyXG4gICAgZmlnbWFBbGlhc0hhc2g6IHN0cmluZztcclxuICAgIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nO1xyXG4gICAgZmlnbWFQaXhlbEhhc2g6IHN0cmluZztcclxuICAgIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IHR5cGUgeyBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3luY01hcmtlcklucHV0IHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIC8qKiDooqvmipjlj6DlkLjmlLbnmoTlrZDlsYIgaWTvvIjkuI3lkKsgbm9kZSDoh6rouqvvvInjgIIgKi9cclxuICAgIGFsaWFzTm9kZUlkcz86IHN0cmluZ1tdO1xyXG4gICAgc2NoZW1hPzogbnVtYmVyO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wYXJpc29uIHtcclxuICAgIC8qKiDmnKzoioLngrnnmoTlh6DkvZXjgIHmmL7pmpDjgIHlpJbop4LjgIHmloflrZfmiJbnu4Tku7bnsbvlnovlj5HnlJ/lj5jljJbjgIIgKi9cclxuICAgIHZpc3VhbENoYW5nZWQ6IGJvb2xlYW47XHJcbiAgICAvKiog5YOP57Sg5YaF5a655Y+Y5YyW77yI5LiN5ZCr6aG16Z2i5Z2Q5qCH77yM5ZCr5pW05qO15a2Q5qCR77yJ77yb5pen5qCH6K6w57y65a2X5q615pe25oyJ5a2Q5qCR5Y+Y5YyW5o6o5pat44CCICovXHJcbiAgICBwaXhlbENoYW5nZWQ6IGJvb2xlYW47XHJcbiAgICAvKiogRmlnbWEg5a2Q5qCR5YaF5Lu75oSP5ZCO5Luj5Y+R55Sf5Y+Y5YyW77yI5ZCr5paw5aKeL+WIoOmZpC/lkIzlkI3mm7/mjaLvvInjgIIgKi9cclxuICAgIHN1YnRyZWVDaGFuZ2VkOiBib29sZWFuO1xyXG4gICAgLyoqIOaKmOWPoOWtkOWxgumbhuWQiOWPkeeUn+WPmOWMlu+8iOWtkOWxguaWsOWinuOAgeWIoOmZpOaIluiiq+abv+aNou+8ieOAgiAqL1xyXG4gICAgc3RydWN0dXJlQ2hhbmdlZDogYm9vbGVhbjtcclxuICAgIC8qKiDpnIDopoHph43mlrDnlJ/miJDlm77niYfotYTmupDmiY3og73lj43mmKDorr7orqHlj5jljJbjgIIgKi9cclxuICAgIGFzc2V0U3RhbGU6IGJvb2xlYW47XHJcbn1cclxuXHJcbmNvbnN0IFNIQTI1Nl9QQVRURVJOID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC87XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3luY05vZGVJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiB2YWx1ZS50cmltKCkucmVwbGFjZSgvLS9nLCAnOicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pdGVPck51bGwodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB8IG51bGwge1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHF1YW50aXplRGVjaW1hbCh2YWx1ZSwgNCkgOiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZVBheWxvYWQoZnJhbWU6IFJlY3QgfCB1bmRlZmluZWQpOiBudW1iZXJbXSB8IG51bGwge1xyXG4gICAgaWYgKCFmcmFtZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIFtcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueCkgPz8gMCxcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueSkgPz8gMCxcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUud2lkdGgpID8/IDAsXHJcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLmhlaWdodCkgPz8gMCxcclxuICAgIF07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhaW50UGF5bG9hZChwYWludDogRmlnbWFQYWludCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdHlwZTogcGFpbnQudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBwYWludC52aXNpYmxlICE9PSBmYWxzZSxcclxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwocGFpbnQub3BhY2l0eSA/PyAxKSxcclxuICAgICAgICBibGVuZE1vZGU6IHBhaW50LmJsZW5kTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIGNvbG9yOiBwYWludC5jb2xvclxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5yKSxcclxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5nKSxcclxuICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5iKSxcclxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5hID8/IDEpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBpbWFnZVJlZjogcGFpbnQuaW1hZ2VSZWYgPz8gbnVsbCxcclxuICAgICAgICBzY2FsZU1vZGU6IHBhaW50LnNjYWxlTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIHJvdGF0aW9uOiBmaW5pdGVPck51bGwocGFpbnQucm90YXRpb24pLFxyXG4gICAgICAgIHNvdXJjZU5vZGVJZDogcGFpbnQuc291cmNlTm9kZUlkID8/IG51bGwsXHJcbiAgICAgICAgdGlsZVR5cGU6IHBhaW50LnRpbGVUeXBlID8/IG51bGwsXHJcbiAgICAgICAgc2NhbGluZ0ZhY3RvcjogZmluaXRlT3JOdWxsKHBhaW50LnNjYWxpbmdGYWN0b3IpLFxyXG4gICAgICAgIHNwYWNpbmc6IHBhaW50LnNwYWNpbmdcclxuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKHBhaW50LnNwYWNpbmcueCksIGZpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLnkpXVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgaG9yaXpvbnRhbEFsaWdubWVudDogcGFpbnQuaG9yaXpvbnRhbEFsaWdubWVudCA/PyBudWxsLFxyXG4gICAgICAgIHZlcnRpY2FsQWxpZ25tZW50OiBwYWludC52ZXJ0aWNhbEFsaWdubWVudCA/PyBudWxsLFxyXG4gICAgICAgIGdyYWRpZW50SGFuZGxlUG9zaXRpb25zOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zKVxyXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zLm1hcCgoaGFuZGxlKSA9PiBbZmluaXRlT3JOdWxsKGhhbmRsZS54KSwgZmluaXRlT3JOdWxsKGhhbmRsZS55KV0pXHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBncmFkaWVudFN0b3BzOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50U3RvcHMpXHJcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRTdG9wcy5tYXAoKHN0b3ApID0+IFtmaW5pdGVPck51bGwoc3RvcC5wb3NpdGlvbiksIHN0b3AuY29sb3JcclxuICAgICAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLnIpLFxyXG4gICAgICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmcpLFxyXG4gICAgICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmIpLFxyXG4gICAgICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmEgPz8gMSksXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICA6IG51bGxdKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgLy8g5Zu+54mH6KOB5YiH55+p6Zi15LiO5ruk6ZWc5ZCM5qC35pS55Y+Y5YOP57Sg77yM5L2G5LiN5Lya5pS55Y+YIGltYWdlUmVm77yb5ryP5o6J5a6D5Lus5Lya6K6pXHJcbiAgICAgICAgLy8g5pW05bGC6IqC54K55Zyo6YeN5a+85YWl5ZCO57un57ut5pi+56S65pen5Zu+44CCXHJcbiAgICAgICAgaW1hZ2VUcmFuc2Zvcm06IEFycmF5LmlzQXJyYXkocGFpbnQuaW1hZ2VUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8gcGFpbnQuaW1hZ2VUcmFuc2Zvcm0ubWFwKChyb3cpID0+IChBcnJheS5pc0FycmF5KHJvdylcclxuICAgICAgICAgICAgICAgID8gcm93Lm1hcCgodmFsdWUpID0+IGZpbml0ZU9yTnVsbCh2YWx1ZSkpXHJcbiAgICAgICAgICAgICAgICA6IG51bGwpKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgZmlsdGVyczogcGFpbnQuZmlsdGVyc1xyXG4gICAgICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhwYWludC5maWx0ZXJzKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IFtrZXksIGZpbml0ZU9yTnVsbCh2YWx1ZSldKSlcclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0UGF5bG9hZChlZmZlY3Q6IEZpZ21hRWZmZWN0KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB0eXBlOiBlZmZlY3QudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmFkaXVzOiBmaW5pdGVPck51bGwoZWZmZWN0LnJhZGl1cyksXHJcbiAgICAgICAgc3ByZWFkOiBmaW5pdGVPck51bGwoZWZmZWN0LnNwcmVhZCksXHJcbiAgICAgICAgb2Zmc2V0WDogZmluaXRlT3JOdWxsKGVmZmVjdC5vZmZzZXQ/LngpLFxyXG4gICAgICAgIG9mZnNldFk6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py55KSxcclxuICAgICAgICBjb2xvcjogZWZmZWN0LmNvbG9yXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5yKSxcclxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuZyksXHJcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmIpLFxyXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5hID8/IDEpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRleHRQYXlsb2FkKHN0eWxlOiBGaWdtYVRleHRTdHlsZSB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XHJcbiAgICBpZiAoIXN0eWxlKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbnRGYW1pbHk6IHN0eWxlLmZvbnRGYW1pbHkgPz8gbnVsbCxcclxuICAgICAgICBmb250UG9zdFNjcmlwdE5hbWU6IHN0eWxlLmZvbnRQb3N0U2NyaXB0TmFtZSA/PyBudWxsLFxyXG4gICAgICAgIGZvbnRXZWlnaHQ6IGZpbml0ZU9yTnVsbChzdHlsZS5mb250V2VpZ2h0KSxcclxuICAgICAgICBmb250U2l6ZTogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRTaXplKSxcclxuICAgICAgICB0ZXh0QWxpZ25Ib3Jpem9udGFsOiBzdHlsZS50ZXh0QWxpZ25Ib3Jpem9udGFsID8/IG51bGwsXHJcbiAgICAgICAgdGV4dEFsaWduVmVydGljYWw6IHN0eWxlLnRleHRBbGlnblZlcnRpY2FsID8/IG51bGwsXHJcbiAgICAgICAgbGV0dGVyU3BhY2luZzogZmluaXRlT3JOdWxsKHN0eWxlLmxldHRlclNwYWNpbmcpLFxyXG4gICAgICAgIGxpbmVIZWlnaHRQeDogZmluaXRlT3JOdWxsKHN0eWxlLmxpbmVIZWlnaHRQeCksXHJcbiAgICAgICAgdGV4dEF1dG9SZXNpemU6IHN0eWxlLnRleHRBdXRvUmVzaXplID8/IG51bGwsXHJcbiAgICAgICAgdGV4dFRydW5jYXRpb246IHN0eWxlLnRleHRUcnVuY2F0aW9uID8/IG51bGwsXHJcbiAgICAgICAgbWF4TGluZXM6IGZpbml0ZU9yTnVsbChzdHlsZS5tYXhMaW5lcyksXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKipcclxuICog5pys6IqC54K56Ieq6Lqr55qE6KeG6KeJ6LSh54yu77ya5Yeg5L2V44CB5pi+6ZqQ44CB5aGr5YWFL+aPj+i+uS/nibnmlYjjgIHlnIbop5LjgIHmloflrZfkuI7moLflvI/jgIJcclxuICog5LiN5YyF5ZCr5a2Q6IqC54K577yM5Zug5q2k5oqY5Y+g54i26IqC54K555qE5oyH57q55LiN5Lya5Zug5a2Q5bGC56e75Yqo6ICM5Y+Y5YyW44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbFBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9ybWFsaXplU3luY05vZGVJZChub2RlLmlkKSxcclxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXHJcbiAgICAgICAgZnJhbWU6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpLFxyXG4gICAgICAgIHJlbmRlckJvdW5kczogZnJhbWVQYXlsb2FkKG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHMpLFxyXG4gICAgICAgIHNpemU6IG5vZGUuc2l6ZVxyXG4gICAgICAgICAgICA/IFtmaW5pdGVPck51bGwobm9kZS5zaXplLndpZHRoKSwgZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS5oZWlnaHQpXVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChub2RlLnJvdGF0aW9uKSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUgIT09IGZhbHNlLFxyXG4gICAgICAgIG9wYWNpdHk6IGZpbml0ZU9yTnVsbChub2RlLm9wYWNpdHkgPz8gMSksXHJcbiAgICAgICAgYmxlbmRNb2RlOiBub2RlLmJsZW5kTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQgPT09IHRydWUsXHJcbiAgICAgICAgY29ybmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5jb3JuZXJSYWRpdXMpLFxyXG4gICAgICAgIHJlY3RhbmdsZUNvcm5lclJhZGlpOiBBcnJheS5pc0FycmF5KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkpXHJcbiAgICAgICAgICAgID8gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaS5tYXAoKHJhZGl1cykgPT4gZmluaXRlT3JOdWxsKHJhZGl1cykpXHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICAvLyDlnIblvKfnmoTotbfmraLop5LkuI7lhoXljYrlvoTlj6rmlLnlg4/ntKDvvIzkuI3mlLnlpJbmoYbvvJvkuI3nurPlhaXmjIfnurnkvJrmvI/mjonmlbTlsYLoioLngrnnmoTmlrDlvaLnirbjgIJcclxuICAgICAgICBhcmNEYXRhOiBub2RlLmFyY0RhdGFcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICBzdGFydGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLnN0YXJ0aW5nQW5nbGUpLFxyXG4gICAgICAgICAgICAgICAgZW5kaW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUpLFxyXG4gICAgICAgICAgICAgICAgaW5uZXJSYWRpdXM6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuaW5uZXJSYWRpdXMpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBmaWxsczogKG5vZGUuZmlsbHMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxyXG4gICAgICAgIHN0cm9rZXM6IChub2RlLnN0cm9rZXMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogZmluaXRlT3JOdWxsKG5vZGUuc3Ryb2tlV2VpZ2h0KSxcclxuICAgICAgICBzdHJva2VBbGlnbjogbm9kZS5zdHJva2VBbGlnbiA/PyBudWxsLFxyXG4gICAgICAgIGVmZmVjdHM6IChub2RlLmVmZmVjdHMgPz8gW10pLm1hcChlZmZlY3RQYXlsb2FkKSxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0eXBlb2Ygbm9kZS5jaGFyYWN0ZXJzID09PSAnc3RyaW5nJyA/IG5vZGUuY2hhcmFjdGVycyA6IG51bGwsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0UGF5bG9hZChub2RlLnN0eWxlKSxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKiDlrZDmoJHnu5PmnoTvvJrmnKzoioLngrnmjIfnurkgKyDpgJDlsYLlrZDoioLngrnmjIfnurnvvIznlKjkuo7liKTmlq3muLLmn5PlnovoioLngrnmmK/lkKbpnIDopoHph43mlrDlh7rlm77jgIIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHZpc3VhbDogc3luY1Zpc3VhbFBheWxvYWQobm9kZSksXHJcbiAgICAgICAgY2hpbGRyZW46IChub2RlLmNoaWxkcmVuID8/IFtdKS5tYXAoKGNoaWxkKSA9PiBzeW5jU3VidHJlZVBheWxvYWQoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jVmlzdWFsSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1Zpc3VhbFBheWxvYWQobm9kZSkpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOWPquS/neeVmeW9seWTjeWDj+e0oOeahOWxnuaAp++8muWdkOagh+aUueS4uuebuOWvueacrOiKgueCueWOn+eCueeahOWBj+enu++8jOW5tumAkuW9kuWMheWQq+aVtOajteWtkOagkeOAglxyXG4gKiAtIOaVtOS4quiKgueCueWcqOmhtemdoumHjOenu+WKqO+8muaJgOacieebuOWvueWdkOagh+S4jeWPmCDihpIg5YOP57Sg5oyH57q55LiN5Y+Y77ybXHJcbiAqIC0g5a2Q5bGC5Zyo6IqC54K55YaF6YOo56e75Yqo77ya55u45a+55Z2Q5qCH5pS55Y+YIOKGkiDlg4/ntKDmjIfnurnmlLnlj5jvvJtcclxuICogLSDlsLrlr7jjgIHml4vovazjgIHlpJbop4LjgIHmloflrZfkuI7ku7vkvZXlkI7ku6Plj5jljJbpg73orqHlhaXjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jUGl4ZWxQYXlsb2FkKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgb3JpZ2luPzogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9LFxyXG4gICAgcm9vdCA9IHRydWUsXHJcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIGNvbnN0IHZpc3VhbCA9IHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpO1xyXG4gICAgY29uc3QgYm94ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgYmFzZSA9IG9yaWdpbiA/PyB7IHg6IGJveD8ueCA/PyAwLCB5OiBib3g/LnkgPz8gMCB9O1xyXG4gICAgY29uc3QgcmVsYXRpdmUgPSAoZnJhbWU6IG51bWJlcltdIHwgbnVsbCk6IG51bWJlcltdIHwgbnVsbCA9PiAoZnJhbWVcclxuICAgICAgICA/IFtcclxuICAgICAgICAgICAgcXVhbnRpemVEZWNpbWFsKGZyYW1lWzBdIC0gYmFzZS54LCA0KSxcclxuICAgICAgICAgICAgcXVhbnRpemVEZWNpbWFsKGZyYW1lWzFdIC0gYmFzZS55LCA0KSxcclxuICAgICAgICAgICAgZnJhbWVbMl0sXHJcbiAgICAgICAgICAgIGZyYW1lWzNdLFxyXG4gICAgICAgIF1cclxuICAgICAgICA6IG51bGwpO1xyXG4gICAgLy8g57qv5Zu+54mH6IqC54K555qE5L2N5Zu+5Y+v5Lul6KKrIFNwcml0ZSDnm7TmjqXmi4nkvLjvvJroh6rouqvlsLrlr7gv5peL6L2s5LiN5pS55Y+Y5YOP57Sg5YaF5a6577yMXHJcbiAgICAvLyDlm6DmraTkuI3lj4LkuI7lg4/ntKDmjIfnurnvvIjlkI7ku6Pku43nhLblj4LkuI7vvIznvKnmlL7lrZDlsYLkvJrmlLnlj5jmlbTlsYLmuLLmn5Pnu5PmnpzvvInjgIJcclxuICAgIGNvbnN0IHN0cmV0Y2hhYmxlID0gcm9vdCAmJiBpc1BsYWluSW1hZ2VOb2RlKG5vZGUpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi52aXN1YWwsXHJcbiAgICAgICAgc2l6ZTogc3RyZXRjaGFibGUgPyBudWxsIDogdmlzdWFsLnNpemUsXHJcbiAgICAgICAgcm90YXRpb246IHN0cmV0Y2hhYmxlID8gbnVsbCA6IHZpc3VhbC5yb3RhdGlvbixcclxuICAgICAgICBmcmFtZTogc3RyZXRjaGFibGUgPyBudWxsIDogcmVsYXRpdmUodmlzdWFsLmZyYW1lIGFzIG51bWJlcltdIHwgbnVsbCksXHJcbiAgICAgICAgcmVuZGVyQm91bmRzOiBzdHJldGNoYWJsZSA/IG51bGwgOiByZWxhdGl2ZSh2aXN1YWwucmVuZGVyQm91bmRzIGFzIG51bWJlcltdIHwgbnVsbCksXHJcbiAgICAgICAgY2hpbGRyZW46IChub2RlLmNoaWxkcmVuID8/IFtdKS5tYXAoKGNoaWxkKSA9PiBzeW5jUGl4ZWxQYXlsb2FkKGNoaWxkLCBiYXNlLCBmYWxzZSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOe6r+WbvueJh+iKgueCue+8muWNleS4quWPr+ingSBJTUFHRSDloavlhYXjgIHml6Dmj4/ovrkv54m55pWIL+Wchuinki/oo4Hliaov5ZyG5byn44CB5peg5a2Q5bGC44CCXHJcbiAqIOi/meexu+iKgueCueeahOS9jeWbvuWPr+S7peiiqyBTcHJpdGUg55u05o6l5ouJ5Ly477yM5pS55Y+Y5bC65a+45oiW5peL6L2s5LiN6ZyA6KaB6YeN5paw5Ye65Zu+44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNQbGFpbkltYWdlTm9kZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmIChub2RlLmNoaWxkcmVuPy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5jbGlwc0NvbnRlbnQgfHwgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKChub2RlLmNvcm5lclJhZGl1cyA/PyAwKSA+IDAgfHwgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgPz8gW10pLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMCkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuc3Ryb2tlcyA/PyBbXSkuc29tZSgoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKChub2RlLmVmZmVjdHMgPz8gW10pLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVGaWxscyA9IChub2RlLmZpbGxzID8/IFtdKS5maWx0ZXIoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgcmV0dXJuIHZpc2libGVGaWxscy5sZW5ndGggPT09IDFcclxuICAgICAgICAmJiB2aXNpYmxlRmlsbHNbMF0udHlwZSA9PT0gJ0lNQUdFJ1xyXG4gICAgICAgICYmIEJvb2xlYW4odmlzaWJsZUZpbGxzWzBdLmltYWdlUmVmKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNQaXhlbEhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNQaXhlbFBheWxvYWQobm9kZSkpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1N1YnRyZWVQYXlsb2FkKG5vZGUpKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xyXG4gICAgY29uc3QgaWRzID0gWy4uLm5ldyBTZXQoYWxpYXNOb2RlSWRzLm1hcChub3JtYWxpemVTeW5jTm9kZUlkKS5maWx0ZXIoQm9vbGVhbikpXS5zb3J0KCk7XHJcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShpZHMpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNGaWxlSGFzaChmaWxlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IGZpbGVLZXkudHJpbSgpO1xyXG4gICAgaWYgKCFub3JtYWxpemVkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXnvLrlsJEgRmlnbWEgZmlsZSBrZXnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBzaGEyNTYoYGZpZ21hLWltcG9ydGVyOnN5bmMtZmlsZTp2MVxcMCR7bm9ybWFsaXplZH1gKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN5bmNNYXJrZXIoaW5wdXQ6IFN5bmNNYXJrZXJJbnB1dCk6IFN5bmNNYXJrZXJTcGVjIHtcclxuICAgIGNvbnN0IG5vZGVJZCA9IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaW5wdXQubm9kZS5pZCk7XHJcbiAgICBpZiAoIW5vZGVJZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign57uE5Lu25ZCM5q2l6IqC54K557y65bCRIEZpZ21hIOiKgueCuSBpZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gWy4uLm5ldyBTZXQoKGlucHV0LmFsaWFzTm9kZUlkcyA/PyBbXSlcclxuICAgICAgICAubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpXHJcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IEJvb2xlYW4oaWQpICYmIGlkICE9PSBub2RlSWQpKV0uc29ydCgpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzY2hlbWE6IGlucHV0LnNjaGVtYSA/PyBTWU5DX01BUktFUl9TQ0hFTUEsXHJcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogc3luY0ZpbGVIYXNoKGlucHV0LmZpbGVLZXkpLFxyXG4gICAgICAgIGZpZ21hTm9kZUlkOiBub2RlSWQsXHJcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxyXG4gICAgICAgIGFsaWFzSGFzaDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpLFxyXG4gICAgICAgIHZpc3VhbEhhc2g6IHN5bmNWaXN1YWxIYXNoKGlucHV0Lm5vZGUpLFxyXG4gICAgICAgIHBpeGVsSGFzaDogc3luY1BpeGVsSGFzaChpbnB1dC5ub2RlKSxcclxuICAgICAgICBzdWJ0cmVlSGFzaDogc3luY1N1YnRyZWVIYXNoKGlucHV0Lm5vZGUpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVTeW5jTWFya2VyKFxyXG4gICAgcHJldmlvdXM6IFN5bmNNYXJrZXJTcGVjLFxyXG4gICAgbmV4dDogU3luY01hcmtlclNwZWMsXHJcbik6IFN5bmNNYXJrZXJDb21wYXJpc29uIHtcclxuICAgIGNvbnN0IHZpc3VhbENoYW5nZWQgPSBwcmV2aW91cy52aXN1YWxIYXNoICE9PSBuZXh0LnZpc3VhbEhhc2g7XHJcbiAgICBjb25zdCBzdWJ0cmVlQ2hhbmdlZCA9IHByZXZpb3VzLnN1YnRyZWVIYXNoICE9PSBuZXh0LnN1YnRyZWVIYXNoO1xyXG4gICAgY29uc3Qgc3RydWN0dXJlQ2hhbmdlZCA9IHByZXZpb3VzLmFsaWFzSGFzaCAhPT0gbmV4dC5hbGlhc0hhc2hcclxuICAgICAgICB8fCBwcmV2aW91cy5hbGlhc05vZGVJZHMuam9pbignLCcpICE9PSBuZXh0LmFsaWFzTm9kZUlkcy5qb2luKCcsJyk7XHJcbiAgICBjb25zdCBzb3VyY2VDaGFuZ2VkID0gcHJldmlvdXMuZmlnbWFGaWxlSGFzaCAhPT0gbmV4dC5maWdtYUZpbGVIYXNoXHJcbiAgICAgICAgfHwgcHJldmlvdXMuZmlnbWFOb2RlSWQgIT09IG5leHQuZmlnbWFOb2RlSWQ7XHJcbiAgICAvLyDlg4/ntKDmmK/lkKblj5jljJbvvJrkuKTovrnpg73mnInlg4/ntKDmjIfnurnml7bnlKjlroPvvIjkuI3lkKvpobXpnaLlnZDmoIfvvInvvJtcclxuICAgIC8vIOaXp+agh+iusOayoeacieivpeWtl+auteaXtumAgOWbnuWtkOagkeaMh+e6ue+8jOWugeWPr+WkmuWIpOS4gOasoei/h+acn++8jOS5n+S4jeiDvea8j+aOieecn+WunuaUueWKqOOAglxyXG4gICAgY29uc3QgcGl4ZWxDb21wYXJhYmxlID0gdHlwZW9mIHByZXZpb3VzLnBpeGVsSGFzaCA9PT0gJ3N0cmluZydcclxuICAgICAgICAmJiB0eXBlb2YgbmV4dC5waXhlbEhhc2ggPT09ICdzdHJpbmcnO1xyXG4gICAgY29uc3QgcGl4ZWxDaGFuZ2VkID0gcGl4ZWxDb21wYXJhYmxlXHJcbiAgICAgICAgPyBwcmV2aW91cy5waXhlbEhhc2ggIT09IG5leHQucGl4ZWxIYXNoXHJcbiAgICAgICAgOiBzdWJ0cmVlQ2hhbmdlZDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdmlzdWFsQ2hhbmdlZCxcclxuICAgICAgICBwaXhlbENoYW5nZWQsXHJcbiAgICAgICAgc3VidHJlZUNoYW5nZWQsXHJcbiAgICAgICAgc3RydWN0dXJlQ2hhbmdlZCxcclxuICAgICAgICAvLyDlj6rmlLnkvY3nva7kuI3lho3opoHmsYLph43mlrDlh7rlm77vvJvmnaXmupDjgIHlg4/ntKDmiJbmipjlj6Dnu5PmnoTlj5jljJbmiY3pnIDopoHjgIJcclxuICAgICAgICBhc3NldFN0YWxlOiBwaXhlbENoYW5nZWQgfHwgc3RydWN0dXJlQ2hhbmdlZCB8fCBzb3VyY2VDaGFuZ2VkLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqIOWIpOaWreS4gOS4quS4jemAj+aYjuinhuinieiKgueCue+8iOefoumHjy/mlbTlsYIgUE5HL+aKmOWPoOWMheijhe+8ieaYr+WQpumcgOimgemHjeaWsOeUn+aIkOWbvueJh+OAgiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3luY05lZWRzQXNzZXRSZWZyZXNoKG9wdGlvbnM6IHtcclxuICAgIGNvbXBhcmlzb246IFN5bmNNYXJrZXJDb21wYXJpc29uO1xyXG4gICAgLyoqIOW9k+WJjeiKgueCueaYr+WQpuS7pSBQTkcg5b2i5byP6JC95Zyw77yI5pW05bGCIHJlbmRlcuOAgeefoumHj+OAgeaKmOWPoCBTcHJpdGUvTGFiZWzvvInjgIIgKi9cclxuICAgIHJhc3Rlcml6ZWQ6IGJvb2xlYW47XHJcbn0pOiBib29sZWFuIHtcclxuICAgIGlmICghb3B0aW9ucy5yYXN0ZXJpemVkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG9wdGlvbnMuY29tcGFyaXNvbi5hc3NldFN0YWxlO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFya2VyVG9Db21wb25lbnRWYWx1ZXMobWFya2VyOiBTeW5jTWFya2VyU3BlYyk6IFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYU1hcmtlclNjaGVtYTogbWFya2VyLnNjaGVtYSxcclxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBtYXJrZXIuZmlnbWFGaWxlSGFzaCxcclxuICAgICAgICBmaWdtYU5vZGVJZDogbWFya2VyLmZpZ21hTm9kZUlkLFxyXG4gICAgICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBtYXJrZXIuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSxcclxuICAgICAgICBmaWdtYUFsaWFzSGFzaDogbWFya2VyLmFsaWFzSGFzaCxcclxuICAgICAgICBmaWdtYVZpc3VhbEhhc2g6IG1hcmtlci52aXN1YWxIYXNoLFxyXG4gICAgICAgIGZpZ21hUGl4ZWxIYXNoOiBtYXJrZXIucGl4ZWxIYXNoID8/ICcnLFxyXG4gICAgICAgIGZpZ21hU3VidHJlZUhhc2g6IG1hcmtlci5zdWJ0cmVlSGFzaCxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDliKTmlq3kuIDkuKrnu4Tku7blrp7kvovmmK/lkKbmmK/mnKzmj5Lku7bnlJ/miJDnmoTlkIzmraXmoIforrDjgIJcclxuICog55So5LqO5omA5pyJ5p2D5Yik5a6a77ya5qCH6K6w5rC46L+c5bGe5LqO5o+S5Lu277yM5LiN6IO9566X5L2cXCLmiYvlt6Xnu4Tku7ZcIumYu+atouiKgueCueWIoOmZpOOAglxyXG4gKiDmjInlrZfmrrXor4bliKvvvIzkuI3kvp3otZbohJrmnKwgVVVJRCDigJTigJQg6ISa5pys6YeN5paw5a+85YWl5oiWIFVVSUQg5Y+Y5YyW5pe25LuN54S25oiQ56uL44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTeW5jTWFya2VyQ29tcG9uZW50VmFsdWUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlY29yZCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgcmV0dXJuIHJlY29yZC5maWdtYU1hcmtlclNjaGVtYSA9PT0gU1lOQ19NQVJLRVJfU0NIRU1BXHJcbiAgICAgICAgJiYgdHlwZW9mIHJlY29yZC5maWdtYU5vZGVJZCA9PT0gJ3N0cmluZydcclxuICAgICAgICAmJiByZWNvcmQuZmlnbWFOb2RlSWQubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHR5cGVvZiByZWNvcmQuZmlnbWFWaXN1YWxIYXNoID09PSAnc3RyaW5nJztcclxufVxyXG5cclxuLyoqIOS7jiBDb2NvcyDnu4Tku7bor7vlm57moIforrDvvJvlrZfmrrXnvLrlpLHmiJbmjZ/lnY/ml7bov5Tlm54gbnVsbO+8jOeUseiwg+eUqOaWuSBmYWlsLWNsb3NlZOOAgiAqL2V4cG9ydCBmdW5jdGlvbiBtYXJrZXJGcm9tQ29tcG9uZW50VmFsdWVzKFxyXG4gICAgdmFsdWVzOiBQYXJ0aWFsPFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXM+IHwgbnVsbCB8IHVuZGVmaW5lZCxcclxuKTogU3luY01hcmtlclNwZWMgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY2hlbWEgPSB2YWx1ZXMuZmlnbWFNYXJrZXJTY2hlbWE7XHJcbiAgICBpZiAoc2NoZW1hICE9PSBTWU5DX01BUktFUl9TQ0hFTUEpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVIYXNoID0gdmFsdWVzLmZpZ21hRmlsZUhhc2g7XHJcbiAgICBjb25zdCBub2RlSWQgPSB0eXBlb2YgdmFsdWVzLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJyA/IG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWVzLmZpZ21hTm9kZUlkKSA6ICcnO1xyXG4gICAgY29uc3QgdmlzdWFsSGFzaCA9IHZhbHVlcy5maWdtYVZpc3VhbEhhc2g7XHJcbiAgICBjb25zdCBzdWJ0cmVlSGFzaCA9IHZhbHVlcy5maWdtYVN1YnRyZWVIYXNoO1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QoZmlsZUhhc2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIW5vZGVJZCB8fCB0eXBlb2YgdmlzdWFsSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QodmlzdWFsSGFzaCkpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2Ygc3VidHJlZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHN1YnRyZWVIYXNoKSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcyA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcy5zcGxpdCgnLCcpXHJcbiAgICAgICAgICAgIC5tYXAoKGlkKSA9PiBub3JtYWxpemVTeW5jTm9kZUlkKGlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgICAgICAuc29ydCgpXHJcbiAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGFsaWFzSGFzaCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc0hhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hQWxpYXNIYXNoKVxyXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNIYXNoXHJcbiAgICAgICAgOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjaGVtYSxcclxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBmaWxlSGFzaCxcclxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxyXG4gICAgICAgIGFsaWFzTm9kZUlkcyxcclxuICAgICAgICBhbGlhc0hhc2gsXHJcbiAgICAgICAgdmlzdWFsSGFzaCxcclxuICAgICAgICBwaXhlbEhhc2g6IHR5cGVvZiB2YWx1ZXMuZmlnbWFQaXhlbEhhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hUGl4ZWxIYXNoKVxyXG4gICAgICAgICAgICA/IHZhbHVlcy5maWdtYVBpeGVsSGFzaFxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICBzdWJ0cmVlSGFzaCxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDkuIDkuKogRmlnbWEg6IqC54K55Y+q6IO96KKr5LiA5LiqIENvY29zIOiKgueCueWjsOaYju+8iOiHquW3seaIluS9nOS4uuWIq+WQje+8ieOAglxyXG4gKiDmipjlj6DniLblrZDlkIzml7blo7DmmI7lkIzmupDoioLngrnkvJrorqlcIuaUueWTquS4quiKgueCuVwi5Y+Y5b6X5LiN5Y+v5Yik5a6a44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0VW5pcXVlU3luY093bmVyc2hpcChtYXJrZXJzOiByZWFkb25seSBTeW5jTWFya2VyU3BlY1tdKTogdm9pZCB7XHJcbiAgICBjb25zdCBvd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xyXG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIFttYXJrZXIuZmlnbWFOb2RlSWQsIC4uLm1hcmtlci5hbGlhc05vZGVJZHNdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG93bmVyID0gb3duZXJzLmdldChub2RlSWQpO1xyXG4gICAgICAgICAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IG1hcmtlci5maWdtYU5vZGVJZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGBGaWdtYSDoioLngrkgJHtub2RlSWR9IOWQjOaXtuiiqyAke293bmVyfSDlkowgJHttYXJrZXIuZmlnbWFOb2RlSWR9IOWjsOaYju+8jOW3suaLkue7neeUn+aIkOWQjOatpeagh+iusOOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG93bmVycy5zZXQobm9kZUlkLCBtYXJrZXIuZmlnbWFOb2RlSWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuLyoqIOmcgOimgeWcqOmhueebriBhc3NldHMg5Lit55Sf5oiQ55qE5pyA5bCP5qCH6K6w57uE5Lu25rqQ56CB77yI5peg5Lia5Yqh6YC76L6R77yM5Y+q5L+d5a2Y5p2l5rqQ5LiO5oyH57q577yJ44CCICovXHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfU09VUkNFID0gYGltcG9ydCB7IF9kZWNvcmF0b3IsIENvbXBvbmVudCB9IGZyb20gJ2NjJztcclxuXHJcbmNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHkgfSA9IF9kZWNvcmF0b3I7XHJcblxyXG4vKipcclxuICogRmlnbWEgSW1wb3J0ZXIg55Sf5oiQ55qE5ZCM5q2l5qCH6K6w44CC5a2X5q6155Sx5o+S5Lu257u05oqk77yM5omL5bel5L+u5pS55Lya5a+86Ie05LiL5qyh5ZCM5q2l6KKr5ouS57ud44CCXHJcbiAqIOWIoOmZpOacrOe7hOS7tuWNs+ihqOekuuivpeiKgueCuemAgOWHuiBGaWdtYSDlkIzmraXvvJrmj5Lku7bkuI3kvJrlho3np7vliqjjgIHnvKnmlL7miJbliKDpmaTlroPjgIJcclxuICovXHJcbkBjY2NsYXNzKCcke1NZTkNfTUFSS0VSX0NMQVNTfScpXHJcbmV4cG9ydCBjbGFzcyAke1NZTkNfTUFSS0VSX0NMQVNTfSBleHRlbmRzIENvbXBvbmVudCB7XHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5qCH6K6w5Y2P6K6u54mI5pysJyB9KVxyXG4gICAgcHVibGljIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXIgPSAke1NZTkNfTUFSS0VSX1NDSEVNQX07XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOaWh+S7tiBrZXkg55qEIFNIQS0yNTYnIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFGaWxlSGFzaDogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOiKgueCuSBpZCcgfSlcclxuICAgIHB1YmxpYyBmaWdtYU5vZGVJZDogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+iiq+aKmOWPoOWIsOacrOiKgueCueeahCBGaWdtYSDlrZDlsYIgaWTvvIzpgJflj7fliIbpmpQnIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmipjlj6DlrZDlsYLpm4blkIjmjIfnurknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFBbGlhc0hhc2g6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoToioLngrnop4bop4nmjIfnurknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFWaXN1YWxIYXNoOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5YOP57Sg5oyH57q577yI5LiN5ZCr6aG16Z2i5Z2Q5qCH77yJJyB9KVxyXG4gICAgcHVibGljIGZpZ21hUGl4ZWxIYXNoOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5a2Q5qCR5oyH57q5JyB9KVxyXG4gICAgcHVibGljIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZyA9ICcnO1xyXG59XHJcbmA7XHJcblxyXG4vKiog6aqM6K+B55Sf5oiQ5Yiw6aG555uu6YeM55qE6ISa5pys5rKh5pyJ6KKr5oiq5pat5oiW6KKr5pS55oiQ5Yir55qE57G744CCICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJTY3JpcHQoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIHJldHVybiB0eXBlb2Ygc291cmNlID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgQGNjY2xhc3MoJyR7U1lOQ19NQVJLRVJfQ0xBU1N9JylgKVxyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnRgKVxyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcygnZmlnbWFTdWJ0cmVlSGFzaCcpO1xyXG59XHJcbiJdfQ==