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
 * 只保留影响像素的属性：坐标改为相对本节点原点的偏移，并递归包含整棵子树。
 * - 整个节点在页面里移动：所有相对坐标不变 → 像素指纹不变；
 * - 子层在节点内部移动：相对坐标改变 → 像素指纹改变；
 * - 尺寸、旋转、外观、文字与任何后代变化都计入。
 */
function syncPixelPayload(node, origin) {
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
    return {
        ...visual,
        frame: relative(visual.frame),
        renderBounds: relative(visual.renderBounds),
        children: ((_c = node.children) !== null && _c !== void 0 ? _c : []).map((child) => syncPixelPayload(child, base)),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBeURBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFRRCw0Q0FxQkM7QUFFRCxzQ0FFQztBQUVELDBDQUVDO0FBRUQsc0NBR0M7QUFFRCxvQ0FNQztBQUVELDRDQWtCQztBQUVELDhDQXlCQztBQUdELHNEQVNDO0FBRUQsMERBV0M7QUFPRCxnRUFTQztBQUVzRCw4REE0Q3REO0FBTUQsOERBYUM7QUF3Q0QsZ0RBS0M7QUFqZEQsZ0VBQTBGO0FBRTFGOzs7Ozs7Ozs7R0FTRztBQUNVLFFBQUEsa0JBQWtCLEdBQUcsQ0FBVSxDQUFDO0FBQ2hDLFFBQUEsaUJBQWlCLEdBQUcsZUFBZSxDQUFDO0FBQ3BDLFFBQUEsa0JBQWtCLEdBQUcsd0JBQXdCLENBQUM7QUFDOUMsUUFBQSxnQkFBZ0IsR0FBRyxrQkFBa0IsQ0FBQztBQUN0QyxRQUFBLHNCQUFzQixHQUFHLGVBQWUsMEJBQWtCLElBQUksd0JBQWdCLEVBQUUsQ0FBQztBQUNqRixRQUFBLG9CQUFvQixHQUFHLGdCQUFnQixDQUFDO0FBcUNyRCxNQUFNLGNBQWMsR0FBRyx1QkFBdUIsQ0FBQztBQUUvQyxTQUFnQixtQkFBbUIsQ0FBQyxLQUFhO0lBQzdDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQXlCO0lBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUEsZ0NBQWUsRUFBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztB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QixDQUFDO0lBQ3pDLEtBQUssTUFBTSxNQUFNLElBQUksT0FBTyxFQUFFLENBQUM7UUFDM0IsS0FBSyxNQUFNLE1BQU0sSUFBSSxDQUFDLE1BQU0sQ0FBQyxXQUFXLEVBQUUsR0FBRyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQztZQUNoRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2pDLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ3hDLE1BQU0sSUFBSSxLQUFLLENBQ1gsWUFBWSxNQUFNLFFBQVEsS0FBSyxNQUFNLE1BQU0sQ0FBQyxXQUFXLGdCQUFnQixDQUMxRSxDQUFDO1lBQ04sQ0FBQztZQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUMzQyxDQUFDO0lBQ0wsQ0FBQztBQUNMLENBQUM7QUFFRCxpREFBaUQ7QUFDcEMsUUFBQSx5QkFBeUIsR0FBRzs7Ozs7Ozs7WUFRN0IseUJBQWlCO2VBQ2QseUJBQWlCOzt5Q0FFUywwQkFBa0I7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUIxRCxDQUFDO0FBRUYsK0JBQStCO0FBQy9CLFNBQWdCLGtCQUFrQixDQUFDLE1BQWM7SUFDN0MsT0FBTyxPQUFPLE1BQU0sS0FBSyxRQUFRO1dBQzFCLE1BQU0sQ0FBQyxRQUFRLENBQUMsYUFBYSx5QkFBaUIsSUFBSSxDQUFDO1dBQ25ELE1BQU0sQ0FBQyxRQUFRLENBQUMsU0FBUyx5QkFBaUIsb0JBQW9CLENBQUM7V0FDL0QsTUFBTSxDQUFDLFFBQVEsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQy9DLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEZpZ21hRWZmZWN0LCBGaWdtYU5vZGUsIEZpZ21hUGFpbnQsIEZpZ21hVGV4dFN0eWxlLCBSZWN0LCBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcbmltcG9ydCB7IGNhbm9uaWNhbFN0cmluZ2lmeSwgcXVhbnRpemVEZWNpbWFsLCBzaGEyNTYgfSBmcm9tICcuLi9yb3VuZHRyaXAvY2Fub25pY2FsLWpzb24nO1xuXG4vKipcbiAqIOe7hOS7tue6p+WPjOi+ueWQjOatpe+8iENvbXBvbmVudCBTeW5j77yJ55qE5qCH6K6w5Y2P6K6u44CCXG4gKlxuICog5qCH6K6w57uE5Lu2IGBGaWdtYVN5bmNOb2RlYCDmjILlnKjmr4/kuKrnlLHlkIzmraXmqKHlvI/nlJ/miJDnmoQgQ29jb3Mg6IqC54K55LiK77yMXG4gKiDml6Lmj5Dkvpvlj6/op4Houqvku73vvIhGaWdtYSDoioLngrkgaWTvvInvvIzkuZ/kv53lrZjkuIrmrKHlr7zlhaXml7bnmoTop4bop4kv5a2Q5qCR5oyH57q577yMXG4gKiDkvb/ph43mlrDlr7zlhaXog73lnKjkuI3miZPlvIAgUHJlZmFiIOeahOaDheWGteS4i+WIpOaWrVwi6K6+6K6h5pS55LqG5LuA5LmIXCLjgIJcbiAqXG4gKiDlronlhajovrnnlYzvvJpmaWxlIGtleSDlj6rku6UgU0hBLTI1NiDlvaLlvI/kv53lrZjvvJtub2RlIGlkIOaMiemcgOaxguaYjuaWh+S/neWtmO+8jFxuICog5LiOIFByb2plY3QgUHJvZmlsZSDkuK0gbm9kZU1hcHMgLyBub2RlT3ZlcnJpZGVzIOeahOaXouacieaYjuaWh+S4gOiHtOOAglxuICovXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfU0NIRU1BID0gMSBhcyBjb25zdDtcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DTEFTUyA9ICdGaWdtYVN5bmNOb2RlJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GT0xERVIgPSAnZmlnbWEtaW1wb3J0ZXItcnVudGltZSc7XG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfRklMRSA9ICdGaWdtYVN5bmNOb2RlLnRzJztcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfVVJMID0gYGRiOi8vYXNzZXRzLyR7U1lOQ19NQVJLRVJfRk9MREVSfS8ke1NZTkNfTUFSS0VSX0ZJTEV9YDtcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DQVRFR09SWSA9ICdGaWdtYSBJbXBvcnRlcic7XG5cbi8qKiDmoIforrDnu4Tku7blnKggUHJlZmFiIOS4reS/neWtmOeahOWtl+auteOAgiAqL1xuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcbiAgICBmaWdtYU1hcmtlclNjaGVtYTogbnVtYmVyO1xuICAgIGZpZ21hRmlsZUhhc2g6IHN0cmluZztcbiAgICBmaWdtYU5vZGVJZDogc3RyaW5nO1xuICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBzdHJpbmc7XG4gICAgZmlnbWFBbGlhc0hhc2g6IHN0cmluZztcbiAgICBmaWdtYVZpc3VhbEhhc2g6IHN0cmluZztcbiAgICBmaWdtYVBpeGVsSGFzaDogc3RyaW5nO1xuICAgIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgeyBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VySW5wdXQge1xuICAgIGZpbGVLZXk6IHN0cmluZztcbiAgICBub2RlOiBGaWdtYU5vZGU7XG4gICAgLyoqIOiiq+aKmOWPoOWQuOaUtueahOWtkOWxgiBpZO+8iOS4jeWQqyBub2RlIOiHqui6q++8ieOAgiAqL1xuICAgIGFsaWFzTm9kZUlkcz86IHN0cmluZ1tdO1xuICAgIHNjaGVtYT86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcGFyaXNvbiB7XG4gICAgLyoqIOacrOiKgueCueeahOWHoOS9leOAgeaYvumakOOAgeWkluinguOAgeaWh+Wtl+aIlue7hOS7tuexu+Wei+WPkeeUn+WPmOWMluOAgiAqL1xuICAgIHZpc3VhbENoYW5nZWQ6IGJvb2xlYW47XG4gICAgLyoqIOWDj+e0oOWGheWuueWPmOWMlu+8iOS4jeWQq+mhtemdouWdkOagh++8jOWQq+aVtOajteWtkOagke+8ie+8m+aXp+agh+iusOe8uuWtl+auteaXtuaMieWtkOagkeWPmOWMluaOqOaWreOAgiAqL1xuICAgIHBpeGVsQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiogRmlnbWEg5a2Q5qCR5YaF5Lu75oSP5ZCO5Luj5Y+R55Sf5Y+Y5YyW77yI5ZCr5paw5aKeL+WIoOmZpC/lkIzlkI3mm7/mjaLvvInjgIIgKi9cbiAgICBzdWJ0cmVlQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiog5oqY5Y+g5a2Q5bGC6ZuG5ZCI5Y+R55Sf5Y+Y5YyW77yI5a2Q5bGC5paw5aKe44CB5Yig6Zmk5oiW6KKr5pu/5o2i77yJ44CCICovXG4gICAgc3RydWN0dXJlQ2hhbmdlZDogYm9vbGVhbjtcbiAgICAvKiog6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH6LWE5rqQ5omN6IO95Y+N5pig6K6+6K6h5Y+Y5YyW44CCICovXG4gICAgYXNzZXRTdGFsZTogYm9vbGVhbjtcbn1cblxuY29uc3QgU0hBMjU2X1BBVFRFUk4gPSAvXnNoYTI1NjpbMC05YS1mXXs2NH0kLztcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIHZhbHVlLnRyaW0oKS5yZXBsYWNlKC8tL2csICc6Jyk7XG59XG5cbmZ1bmN0aW9uIGZpbml0ZU9yTnVsbCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHF1YW50aXplRGVjaW1hbCh2YWx1ZSwgNCkgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBmcmFtZVBheWxvYWQoZnJhbWU6IFJlY3QgfCB1bmRlZmluZWQpOiBudW1iZXJbXSB8IG51bGwge1xuICAgIGlmICghZnJhbWUpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiBbXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS54KSA/PyAwLFxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueSkgPz8gMCxcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLndpZHRoKSA/PyAwLFxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUuaGVpZ2h0KSA/PyAwLFxuICAgIF07XG59XG5cbmZ1bmN0aW9uIHBhaW50UGF5bG9hZChwYWludDogRmlnbWFQYWludCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBwYWludC50eXBlLFxuICAgICAgICB2aXNpYmxlOiBwYWludC52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgb3BhY2l0eTogZmluaXRlT3JOdWxsKHBhaW50Lm9wYWNpdHkgPz8gMSksXG4gICAgICAgIGJsZW5kTW9kZTogcGFpbnQuYmxlbmRNb2RlID8/IG51bGwsXG4gICAgICAgIGNvbG9yOiBwYWludC5jb2xvclxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLnIpLFxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5nKSxcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuYiksXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKHBhaW50LmNvbG9yLmEgPz8gMSksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGltYWdlUmVmOiBwYWludC5pbWFnZVJlZiA/PyBudWxsLFxuICAgICAgICBzY2FsZU1vZGU6IHBhaW50LnNjYWxlTW9kZSA/PyBudWxsLFxuICAgICAgICByb3RhdGlvbjogZmluaXRlT3JOdWxsKHBhaW50LnJvdGF0aW9uKSxcbiAgICAgICAgc291cmNlTm9kZUlkOiBwYWludC5zb3VyY2VOb2RlSWQgPz8gbnVsbCxcbiAgICAgICAgdGlsZVR5cGU6IHBhaW50LnRpbGVUeXBlID8/IG51bGwsXG4gICAgICAgIHNjYWxpbmdGYWN0b3I6IGZpbml0ZU9yTnVsbChwYWludC5zY2FsaW5nRmFjdG9yKSxcbiAgICAgICAgc3BhY2luZzogcGFpbnQuc3BhY2luZ1xuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKHBhaW50LnNwYWNpbmcueCksIGZpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLnkpXVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICBob3Jpem9udGFsQWxpZ25tZW50OiBwYWludC5ob3Jpem9udGFsQWxpZ25tZW50ID8/IG51bGwsXG4gICAgICAgIHZlcnRpY2FsQWxpZ25tZW50OiBwYWludC52ZXJ0aWNhbEFsaWdubWVudCA/PyBudWxsLFxuICAgICAgICBncmFkaWVudEhhbmRsZVBvc2l0aW9uczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudEhhbmRsZVBvc2l0aW9ucylcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRIYW5kbGVQb3NpdGlvbnMubWFwKChoYW5kbGUpID0+IFtmaW5pdGVPck51bGwoaGFuZGxlLngpLCBmaW5pdGVPck51bGwoaGFuZGxlLnkpXSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZ3JhZGllbnRTdG9wczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudFN0b3BzKVxuICAgICAgICAgICAgPyBwYWludC5ncmFkaWVudFN0b3BzLm1hcCgoc3RvcCkgPT4gW2Zpbml0ZU9yTnVsbChzdG9wLnBvc2l0aW9uKSwgc3RvcC5jb2xvclxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICAgICAgZzogZmluaXRlT3JOdWxsKHN0b3AuY29sb3IuZyksXG4gICAgICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmIpLFxuICAgICAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICA6IG51bGxdKVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICAvLyDlm77niYfoo4HliIfnn6npmLXkuI7mu6TplZzlkIzmoLfmlLnlj5jlg4/ntKDvvIzkvYbkuI3kvJrmlLnlj5ggaW1hZ2VSZWbvvJvmvI/mjonlroPku6zkvJrorqlcbiAgICAgICAgLy8g5pW05bGC6IqC54K55Zyo6YeN5a+85YWl5ZCO57un57ut5pi+56S65pen5Zu+44CCXG4gICAgICAgIGltYWdlVHJhbnNmb3JtOiBBcnJheS5pc0FycmF5KHBhaW50LmltYWdlVHJhbnNmb3JtKVxuICAgICAgICAgICAgPyBwYWludC5pbWFnZVRyYW5zZm9ybS5tYXAoKHJvdykgPT4gKEFycmF5LmlzQXJyYXkocm93KVxuICAgICAgICAgICAgICAgID8gcm93Lm1hcCgodmFsdWUpID0+IGZpbml0ZU9yTnVsbCh2YWx1ZSkpXG4gICAgICAgICAgICAgICAgOiBudWxsKSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZmlsdGVyczogcGFpbnQuZmlsdGVyc1xuICAgICAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMocGFpbnQuZmlsdGVycylcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChbLCB2YWx1ZV0pID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSlcbiAgICAgICAgICAgICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IFtrZXksIGZpbml0ZU9yTnVsbCh2YWx1ZSldKSlcbiAgICAgICAgICAgIDogbnVsbCxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBlZmZlY3RQYXlsb2FkKGVmZmVjdDogRmlnbWFFZmZlY3QpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogZWZmZWN0LnR5cGUsXG4gICAgICAgIHZpc2libGU6IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSxcbiAgICAgICAgcmFkaXVzOiBmaW5pdGVPck51bGwoZWZmZWN0LnJhZGl1cyksXG4gICAgICAgIHNwcmVhZDogZmluaXRlT3JOdWxsKGVmZmVjdC5zcHJlYWQpLFxuICAgICAgICBvZmZzZXRYOiBmaW5pdGVPck51bGwoZWZmZWN0Lm9mZnNldD8ueCksXG4gICAgICAgIG9mZnNldFk6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py55KSxcbiAgICAgICAgY29sb3I6IGVmZmVjdC5jb2xvclxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5yKSxcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmcpLFxuICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuYiksXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5hID8/IDEpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBudWxsLFxuICAgIH07XG59XG5cbmZ1bmN0aW9uIHRleHRQYXlsb2FkKHN0eWxlOiBGaWdtYVRleHRTdHlsZSB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gICAgaWYgKCFzdHlsZSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZm9udEZhbWlseTogc3R5bGUuZm9udEZhbWlseSA/PyBudWxsLFxuICAgICAgICBmb250UG9zdFNjcmlwdE5hbWU6IHN0eWxlLmZvbnRQb3N0U2NyaXB0TmFtZSA/PyBudWxsLFxuICAgICAgICBmb250V2VpZ2h0OiBmaW5pdGVPck51bGwoc3R5bGUuZm9udFdlaWdodCksXG4gICAgICAgIGZvbnRTaXplOiBmaW5pdGVPck51bGwoc3R5bGUuZm9udFNpemUpLFxuICAgICAgICB0ZXh0QWxpZ25Ib3Jpem9udGFsOiBzdHlsZS50ZXh0QWxpZ25Ib3Jpem9udGFsID8/IG51bGwsXG4gICAgICAgIHRleHRBbGlnblZlcnRpY2FsOiBzdHlsZS50ZXh0QWxpZ25WZXJ0aWNhbCA/PyBudWxsLFxuICAgICAgICBsZXR0ZXJTcGFjaW5nOiBmaW5pdGVPck51bGwoc3R5bGUubGV0dGVyU3BhY2luZyksXG4gICAgICAgIGxpbmVIZWlnaHRQeDogZmluaXRlT3JOdWxsKHN0eWxlLmxpbmVIZWlnaHRQeCksXG4gICAgICAgIHRleHRBdXRvUmVzaXplOiBzdHlsZS50ZXh0QXV0b1Jlc2l6ZSA/PyBudWxsLFxuICAgICAgICB0ZXh0VHJ1bmNhdGlvbjogc3R5bGUudGV4dFRydW5jYXRpb24gPz8gbnVsbCxcbiAgICAgICAgbWF4TGluZXM6IGZpbml0ZU9yTnVsbChzdHlsZS5tYXhMaW5lcyksXG4gICAgfTtcbn1cblxuLyoqXG4gKiDmnKzoioLngrnoh6rouqvnmoTop4bop4notKHnjK7vvJrlh6DkvZXjgIHmmL7pmpDjgIHloavlhYUv5o+P6L65L+eJueaViOOAgeWchuinkuOAgeaWh+Wtl+S4juagt+W8j+OAglxuICog5LiN5YyF5ZCr5a2Q6IqC54K577yM5Zug5q2k5oqY5Y+g54i26IqC54K555qE5oyH57q55LiN5Lya5Zug5a2Q5bGC56e75Yqo6ICM5Y+Y5YyW44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jVmlzdWFsUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgaWQ6IG5vcm1hbGl6ZVN5bmNOb2RlSWQobm9kZS5pZCksXG4gICAgICAgIHR5cGU6IG5vZGUudHlwZSxcbiAgICAgICAgZnJhbWU6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpLFxuICAgICAgICByZW5kZXJCb3VuZHM6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlUmVuZGVyQm91bmRzKSxcbiAgICAgICAgc2l6ZTogbm9kZS5zaXplXG4gICAgICAgICAgICA/IFtmaW5pdGVPck51bGwobm9kZS5zaXplLndpZHRoKSwgZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS5oZWlnaHQpXVxuICAgICAgICAgICAgOiBudWxsLFxuICAgICAgICByb3RhdGlvbjogZmluaXRlT3JOdWxsKG5vZGUucm90YXRpb24pLFxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUgIT09IGZhbHNlLFxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwobm9kZS5vcGFjaXR5ID8/IDEpLFxuICAgICAgICBibGVuZE1vZGU6IG5vZGUuYmxlbmRNb2RlID8/IG51bGwsXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQgPT09IHRydWUsXG4gICAgICAgIGNvcm5lclJhZGl1czogZmluaXRlT3JOdWxsKG5vZGUuY29ybmVyUmFkaXVzKSxcbiAgICAgICAgcmVjdGFuZ2xlQ29ybmVyUmFkaWk6IEFycmF5LmlzQXJyYXkobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSlcbiAgICAgICAgICAgID8gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaS5tYXAoKHJhZGl1cykgPT4gZmluaXRlT3JOdWxsKHJhZGl1cykpXG4gICAgICAgICAgICA6IG51bGwsXG4gICAgICAgIC8vIOWchuW8p+eahOi1t+atouinkuS4juWGheWNiuW+hOWPquaUueWDj+e0oO+8jOS4jeaUueWkluahhu+8m+S4jee6s+WFpeaMh+e6ueS8mua8j+aOieaVtOWxguiKgueCueeahOaWsOW9oueKtuOAglxuICAgICAgICBhcmNEYXRhOiBub2RlLmFyY0RhdGFcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHN0YXJ0aW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSksXG4gICAgICAgICAgICAgICAgZW5kaW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUpLFxuICAgICAgICAgICAgICAgIGlubmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzKSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZmlsbHM6IChub2RlLmZpbGxzID8/IFtdKS5tYXAocGFpbnRQYXlsb2FkKSxcbiAgICAgICAgc3Ryb2tlczogKG5vZGUuc3Ryb2tlcyA/PyBbXSkubWFwKHBhaW50UGF5bG9hZCksXG4gICAgICAgIHN0cm9rZVdlaWdodDogZmluaXRlT3JOdWxsKG5vZGUuc3Ryb2tlV2VpZ2h0KSxcbiAgICAgICAgc3Ryb2tlQWxpZ246IG5vZGUuc3Ryb2tlQWxpZ24gPz8gbnVsbCxcbiAgICAgICAgZWZmZWN0czogKG5vZGUuZWZmZWN0cyA/PyBbXSkubWFwKGVmZmVjdFBheWxvYWQpLFxuICAgICAgICBjaGFyYWN0ZXJzOiB0eXBlb2Ygbm9kZS5jaGFyYWN0ZXJzID09PSAnc3RyaW5nJyA/IG5vZGUuY2hhcmFjdGVycyA6IG51bGwsXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFBheWxvYWQobm9kZS5zdHlsZSksXG4gICAgfTtcbn1cblxuLyoqIOWtkOagkee7k+aehO+8muacrOiKgueCueaMh+e6uSArIOmAkOWxguWtkOiKgueCueaMh+e6ue+8jOeUqOS6juWIpOaWrea4suafk+Wei+iKgueCueaYr+WQpumcgOimgemHjeaWsOWHuuWbvuOAgiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgdmlzdWFsOiBzeW5jVmlzdWFsUGF5bG9hZChub2RlKSxcbiAgICAgICAgY2hpbGRyZW46IChub2RlLmNoaWxkcmVuID8/IFtdKS5tYXAoKGNoaWxkKSA9PiBzeW5jU3VidHJlZVBheWxvYWQoY2hpbGQpKSxcbiAgICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbEhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShzeW5jVmlzdWFsUGF5bG9hZChub2RlKSkpO1xufVxuXG4vKipcbiAqIOWPquS/neeVmeW9seWTjeWDj+e0oOeahOWxnuaAp++8muWdkOagh+aUueS4uuebuOWvueacrOiKgueCueWOn+eCueeahOWBj+enu++8jOW5tumAkuW9kuWMheWQq+aVtOajteWtkOagkeOAglxuICogLSDmlbTkuKroioLngrnlnKjpobXpnaLph4znp7vliqjvvJrmiYDmnInnm7jlr7nlnZDmoIfkuI3lj5gg4oaSIOWDj+e0oOaMh+e6ueS4jeWPmO+8m1xuICogLSDlrZDlsYLlnKjoioLngrnlhoXpg6jnp7vliqjvvJrnm7jlr7nlnZDmoIfmlLnlj5gg4oaSIOWDj+e0oOaMh+e6ueaUueWPmO+8m1xuICogLSDlsLrlr7jjgIHml4vovazjgIHlpJbop4LjgIHmloflrZfkuI7ku7vkvZXlkI7ku6Plj5jljJbpg73orqHlhaXjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNQaXhlbFBheWxvYWQoXG4gICAgbm9kZTogRmlnbWFOb2RlLFxuICAgIG9yaWdpbj86IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSxcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBjb25zdCB2aXN1YWwgPSBzeW5jVmlzdWFsUGF5bG9hZChub2RlKTtcbiAgICBjb25zdCBib3ggPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XG4gICAgY29uc3QgYmFzZSA9IG9yaWdpbiA/PyB7IHg6IGJveD8ueCA/PyAwLCB5OiBib3g/LnkgPz8gMCB9O1xuICAgIGNvbnN0IHJlbGF0aXZlID0gKGZyYW1lOiBudW1iZXJbXSB8IG51bGwpOiBudW1iZXJbXSB8IG51bGwgPT4gKGZyYW1lXG4gICAgICAgID8gW1xuICAgICAgICAgICAgcXVhbnRpemVEZWNpbWFsKGZyYW1lWzBdIC0gYmFzZS54LCA0KSxcbiAgICAgICAgICAgIHF1YW50aXplRGVjaW1hbChmcmFtZVsxXSAtIGJhc2UueSwgNCksXG4gICAgICAgICAgICBmcmFtZVsyXSxcbiAgICAgICAgICAgIGZyYW1lWzNdLFxuICAgICAgICBdXG4gICAgICAgIDogbnVsbCk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgLi4udmlzdWFsLFxuICAgICAgICBmcmFtZTogcmVsYXRpdmUodmlzdWFsLmZyYW1lIGFzIG51bWJlcltdIHwgbnVsbCksXG4gICAgICAgIHJlbmRlckJvdW5kczogcmVsYXRpdmUodmlzdWFsLnJlbmRlckJvdW5kcyBhcyBudW1iZXJbXSB8IG51bGwpLFxuICAgICAgICBjaGlsZHJlbjogKG5vZGUuY2hpbGRyZW4gPz8gW10pLm1hcCgoY2hpbGQpID0+IHN5bmNQaXhlbFBheWxvYWQoY2hpbGQsIGJhc2UpKSxcbiAgICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY1BpeGVsSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNQaXhlbFBheWxvYWQobm9kZSkpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlKSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBjb25zdCBpZHMgPSBbLi4ubmV3IFNldChhbGlhc05vZGVJZHMubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpLmZpbHRlcihCb29sZWFuKSldLnNvcnQoKTtcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShpZHMpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNGaWxlSGFzaChmaWxlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSBmaWxlS2V5LnRyaW0oKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXnvLrlsJEgRmlnbWEgZmlsZSBrZXnjgIInKTtcbiAgICB9XG4gICAgcmV0dXJuIHNoYTI1NihgZmlnbWEtaW1wb3J0ZXI6c3luYy1maWxlOnYxXFwwJHtub3JtYWxpemVkfWApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3luY01hcmtlcihpbnB1dDogU3luY01hcmtlcklucHV0KTogU3luY01hcmtlclNwZWMge1xuICAgIGNvbnN0IG5vZGVJZCA9IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaW5wdXQubm9kZS5pZCk7XG4gICAgaWYgKCFub2RlSWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXoioLngrnnvLrlsJEgRmlnbWEg6IqC54K5IGlk44CCJyk7XG4gICAgfVxuICAgIGNvbnN0IGFsaWFzTm9kZUlkcyA9IFsuLi5uZXcgU2V0KChpbnB1dC5hbGlhc05vZGVJZHMgPz8gW10pXG4gICAgICAgIC5tYXAobm9ybWFsaXplU3luY05vZGVJZClcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IEJvb2xlYW4oaWQpICYmIGlkICE9PSBub2RlSWQpKV0uc29ydCgpO1xuICAgIHJldHVybiB7XG4gICAgICAgIHNjaGVtYTogaW5wdXQuc2NoZW1hID8/IFNZTkNfTUFSS0VSX1NDSEVNQSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogc3luY0ZpbGVIYXNoKGlucHV0LmZpbGVLZXkpLFxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxuICAgICAgICBhbGlhc05vZGVJZHMsXG4gICAgICAgIGFsaWFzSGFzaDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpLFxuICAgICAgICB2aXN1YWxIYXNoOiBzeW5jVmlzdWFsSGFzaChpbnB1dC5ub2RlKSxcbiAgICAgICAgcGl4ZWxIYXNoOiBzeW5jUGl4ZWxIYXNoKGlucHV0Lm5vZGUpLFxuICAgICAgICBzdWJ0cmVlSGFzaDogc3luY1N1YnRyZWVIYXNoKGlucHV0Lm5vZGUpLFxuICAgIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlU3luY01hcmtlcihcbiAgICBwcmV2aW91czogU3luY01hcmtlclNwZWMsXG4gICAgbmV4dDogU3luY01hcmtlclNwZWMsXG4pOiBTeW5jTWFya2VyQ29tcGFyaXNvbiB7XG4gICAgY29uc3QgdmlzdWFsQ2hhbmdlZCA9IHByZXZpb3VzLnZpc3VhbEhhc2ggIT09IG5leHQudmlzdWFsSGFzaDtcbiAgICBjb25zdCBzdWJ0cmVlQ2hhbmdlZCA9IHByZXZpb3VzLnN1YnRyZWVIYXNoICE9PSBuZXh0LnN1YnRyZWVIYXNoO1xuICAgIGNvbnN0IHN0cnVjdHVyZUNoYW5nZWQgPSBwcmV2aW91cy5hbGlhc0hhc2ggIT09IG5leHQuYWxpYXNIYXNoXG4gICAgICAgIHx8IHByZXZpb3VzLmFsaWFzTm9kZUlkcy5qb2luKCcsJykgIT09IG5leHQuYWxpYXNOb2RlSWRzLmpvaW4oJywnKTtcbiAgICBjb25zdCBzb3VyY2VDaGFuZ2VkID0gcHJldmlvdXMuZmlnbWFGaWxlSGFzaCAhPT0gbmV4dC5maWdtYUZpbGVIYXNoXG4gICAgICAgIHx8IHByZXZpb3VzLmZpZ21hTm9kZUlkICE9PSBuZXh0LmZpZ21hTm9kZUlkO1xuICAgIC8vIOWDj+e0oOaYr+WQpuWPmOWMlu+8muS4pOi+uemDveacieWDj+e0oOaMh+e6ueaXtueUqOWug++8iOS4jeWQq+mhtemdouWdkOagh++8ie+8m1xuICAgIC8vIOaXp+agh+iusOayoeacieivpeWtl+auteaXtumAgOWbnuWtkOagkeaMh+e6ue+8jOWugeWPr+WkmuWIpOS4gOasoei/h+acn++8jOS5n+S4jeiDvea8j+aOieecn+WunuaUueWKqOOAglxuICAgIGNvbnN0IHBpeGVsQ29tcGFyYWJsZSA9IHR5cGVvZiBwcmV2aW91cy5waXhlbEhhc2ggPT09ICdzdHJpbmcnXG4gICAgICAgICYmIHR5cGVvZiBuZXh0LnBpeGVsSGFzaCA9PT0gJ3N0cmluZyc7XG4gICAgY29uc3QgcGl4ZWxDaGFuZ2VkID0gcGl4ZWxDb21wYXJhYmxlXG4gICAgICAgID8gcHJldmlvdXMucGl4ZWxIYXNoICE9PSBuZXh0LnBpeGVsSGFzaFxuICAgICAgICA6IHN1YnRyZWVDaGFuZ2VkO1xuICAgIHJldHVybiB7XG4gICAgICAgIHZpc3VhbENoYW5nZWQsXG4gICAgICAgIHBpeGVsQ2hhbmdlZCxcbiAgICAgICAgc3VidHJlZUNoYW5nZWQsXG4gICAgICAgIHN0cnVjdHVyZUNoYW5nZWQsXG4gICAgICAgIC8vIOWPquaUueS9jee9ruS4jeWGjeimgeaxgumHjeaWsOWHuuWbvu+8m+adpea6kOOAgeWDj+e0oOaIluaKmOWPoOe7k+aehOWPmOWMluaJjemcgOimgeOAglxuICAgICAgICBhc3NldFN0YWxlOiBwaXhlbENoYW5nZWQgfHwgc3RydWN0dXJlQ2hhbmdlZCB8fCBzb3VyY2VDaGFuZ2VkLFxuICAgIH07XG59XG5cbi8qKiDliKTmlq3kuIDkuKrkuI3pgI/mmI7op4bop4noioLngrnvvIjnn6Lph48v5pW05bGCIFBORy/mipjlj6DljIXoo4XvvInmmK/lkKbpnIDopoHph43mlrDnlJ/miJDlm77niYfjgIIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jTmVlZHNBc3NldFJlZnJlc2gob3B0aW9uczoge1xuICAgIGNvbXBhcmlzb246IFN5bmNNYXJrZXJDb21wYXJpc29uO1xuICAgIC8qKiDlvZPliY3oioLngrnmmK/lkKbku6UgUE5HIOW9ouW8j+iQveWcsO+8iOaVtOWxgiByZW5kZXLjgIHnn6Lph4/jgIHmipjlj6AgU3ByaXRlL0xhYmVs77yJ44CCICovXG4gICAgcmFzdGVyaXplZDogYm9vbGVhbjtcbn0pOiBib29sZWFuIHtcbiAgICBpZiAoIW9wdGlvbnMucmFzdGVyaXplZCkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBvcHRpb25zLmNvbXBhcmlzb24uYXNzZXRTdGFsZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtlclRvQ29tcG9uZW50VmFsdWVzKG1hcmtlcjogU3luY01hcmtlclNwZWMpOiBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcbiAgICByZXR1cm4ge1xuICAgICAgICBmaWdtYU1hcmtlclNjaGVtYTogbWFya2VyLnNjaGVtYSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogbWFya2VyLmZpZ21hRmlsZUhhc2gsXG4gICAgICAgIGZpZ21hTm9kZUlkOiBtYXJrZXIuZmlnbWFOb2RlSWQsXG4gICAgICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBtYXJrZXIuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSxcbiAgICAgICAgZmlnbWFBbGlhc0hhc2g6IG1hcmtlci5hbGlhc0hhc2gsXG4gICAgICAgIGZpZ21hVmlzdWFsSGFzaDogbWFya2VyLnZpc3VhbEhhc2gsXG4gICAgICAgIGZpZ21hUGl4ZWxIYXNoOiBtYXJrZXIucGl4ZWxIYXNoID8/ICcnLFxuICAgICAgICBmaWdtYVN1YnRyZWVIYXNoOiBtYXJrZXIuc3VidHJlZUhhc2gsXG4gICAgfTtcbn1cblxuLyoqXG4gKiDliKTmlq3kuIDkuKrnu4Tku7blrp7kvovmmK/lkKbmmK/mnKzmj5Lku7bnlJ/miJDnmoTlkIzmraXmoIforrDjgIJcbiAqIOeUqOS6juaJgOacieadg+WIpOWumu+8muagh+iusOawuOi/nOWxnuS6juaPkuS7tu+8jOS4jeiDveeul+S9nFwi5omL5bel57uE5Lu2XCLpmLvmraLoioLngrnliKDpmaTjgIJcbiAqIOaMieWtl+auteivhuWIq++8jOS4jeS+nei1luiEmuacrCBVVUlEIOKAlOKAlCDohJrmnKzph43mlrDlr7zlhaXmiJYgVVVJRCDlj5jljJbml7bku43nhLbmiJDnq4vjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU3luY01hcmtlckNvbXBvbmVudFZhbHVlKHZhbHVlOiB1bmtub3duKTogYm9vbGVhbiB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgcmVjb3JkID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgcmV0dXJuIHJlY29yZC5maWdtYU1hcmtlclNjaGVtYSA9PT0gU1lOQ19NQVJLRVJfU0NIRU1BXG4gICAgICAgICYmIHR5cGVvZiByZWNvcmQuZmlnbWFOb2RlSWQgPT09ICdzdHJpbmcnXG4gICAgICAgICYmIHJlY29yZC5maWdtYU5vZGVJZC5sZW5ndGggPiAwXG4gICAgICAgICYmIHR5cGVvZiByZWNvcmQuZmlnbWFWaXN1YWxIYXNoID09PSAnc3RyaW5nJztcbn1cblxuLyoqIOS7jiBDb2NvcyDnu4Tku7bor7vlm57moIforrDvvJvlrZfmrrXnvLrlpLHmiJbmjZ/lnY/ml7bov5Tlm54gbnVsbO+8jOeUseiwg+eUqOaWuSBmYWlsLWNsb3NlZOOAgiAqL2V4cG9ydCBmdW5jdGlvbiBtYXJrZXJGcm9tQ29tcG9uZW50VmFsdWVzKFxuICAgIHZhbHVlczogUGFydGlhbDxTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzPiB8IG51bGwgfCB1bmRlZmluZWQsXG4pOiBTeW5jTWFya2VyU3BlYyB8IG51bGwge1xuICAgIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBzY2hlbWEgPSB2YWx1ZXMuZmlnbWFNYXJrZXJTY2hlbWE7XG4gICAgaWYgKHNjaGVtYSAhPT0gU1lOQ19NQVJLRVJfU0NIRU1BKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBmaWxlSGFzaCA9IHZhbHVlcy5maWdtYUZpbGVIYXNoO1xuICAgIGNvbnN0IG5vZGVJZCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFOb2RlSWQgPT09ICdzdHJpbmcnID8gbm9ybWFsaXplU3luY05vZGVJZCh2YWx1ZXMuZmlnbWFOb2RlSWQpIDogJyc7XG4gICAgY29uc3QgdmlzdWFsSGFzaCA9IHZhbHVlcy5maWdtYVZpc3VhbEhhc2g7XG4gICAgY29uc3Qgc3VidHJlZUhhc2ggPSB2YWx1ZXMuZmlnbWFTdWJ0cmVlSGFzaDtcbiAgICBpZiAodHlwZW9mIGZpbGVIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdChmaWxlSGFzaCkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGlmICghbm9kZUlkIHx8IHR5cGVvZiB2aXN1YWxIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdCh2aXN1YWxIYXNoKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBzdWJ0cmVlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3Qoc3VidHJlZUhhc2gpKSB7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICBjb25zdCBhbGlhc05vZGVJZHMgPSB0eXBlb2YgdmFsdWVzLmZpZ21hQWxpYXNOb2RlSWRzID09PSAnc3RyaW5nJ1xuICAgICAgICA/IHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcy5zcGxpdCgnLCcpXG4gICAgICAgICAgICAubWFwKChpZCkgPT4gbm9ybWFsaXplU3luY05vZGVJZChpZCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgICAgICAuc29ydCgpXG4gICAgICAgIDogW107XG4gICAgY29uc3QgYWxpYXNIYXNoID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzSGFzaCA9PT0gJ3N0cmluZycgJiYgU0hBMjU2X1BBVFRFUk4udGVzdCh2YWx1ZXMuZmlnbWFBbGlhc0hhc2gpXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNIYXNoXG4gICAgICAgIDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpO1xuICAgIHJldHVybiB7XG4gICAgICAgIHNjaGVtYSxcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogZmlsZUhhc2gsXG4gICAgICAgIGZpZ21hTm9kZUlkOiBub2RlSWQsXG4gICAgICAgIGFsaWFzTm9kZUlkcyxcbiAgICAgICAgYWxpYXNIYXNoLFxuICAgICAgICB2aXN1YWxIYXNoLFxuICAgICAgICBwaXhlbEhhc2g6IHR5cGVvZiB2YWx1ZXMuZmlnbWFQaXhlbEhhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hUGl4ZWxIYXNoKVxuICAgICAgICAgICAgPyB2YWx1ZXMuZmlnbWFQaXhlbEhhc2hcbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICBzdWJ0cmVlSGFzaCxcbiAgICB9O1xufVxuXG4vKipcbiAqIOS4gOS4qiBGaWdtYSDoioLngrnlj6rog73ooqvkuIDkuKogQ29jb3Mg6IqC54K55aOw5piO77yI6Ieq5bex5oiW5L2c5Li65Yir5ZCN77yJ44CCXG4gKiDmipjlj6DniLblrZDlkIzml7blo7DmmI7lkIzmupDoioLngrnkvJrorqlcIuaUueWTquS4quiKgueCuVwi5Y+Y5b6X5LiN5Y+v5Yik5a6a44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwKG1hcmtlcnM6IHJlYWRvbmx5IFN5bmNNYXJrZXJTcGVjW10pOiB2b2lkIHtcbiAgICBjb25zdCBvd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIG1hcmtlcnMpIHtcbiAgICAgICAgZm9yIChjb25zdCBub2RlSWQgb2YgW21hcmtlci5maWdtYU5vZGVJZCwgLi4ubWFya2VyLmFsaWFzTm9kZUlkc10pIHtcbiAgICAgICAgICAgIGNvbnN0IG93bmVyID0gb3duZXJzLmdldChub2RlSWQpO1xuICAgICAgICAgICAgaWYgKG93bmVyICYmIG93bmVyICE9PSBtYXJrZXIuZmlnbWFOb2RlSWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIGBGaWdtYSDoioLngrkgJHtub2RlSWR9IOWQjOaXtuiiqyAke293bmVyfSDlkowgJHttYXJrZXIuZmlnbWFOb2RlSWR9IOWjsOaYju+8jOW3suaLkue7neeUn+aIkOWQjOatpeagh+iusOOAgmAsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG93bmVycy5zZXQobm9kZUlkLCBtYXJrZXIuZmlnbWFOb2RlSWQpO1xuICAgICAgICB9XG4gICAgfVxufVxuXG4vKiog6ZyA6KaB5Zyo6aG555uuIGFzc2V0cyDkuK3nlJ/miJDnmoTmnIDlsI/moIforrDnu4Tku7bmupDnoIHvvIjml6DkuJrliqHpgLvovpHvvIzlj6rkv53lrZjmnaXmupDkuI7mjIfnurnvvInjgIIgKi9cbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfU09VUkNFID0gYGltcG9ydCB7IF9kZWNvcmF0b3IsIENvbXBvbmVudCB9IGZyb20gJ2NjJztcblxuY29uc3QgeyBjY2NsYXNzLCBwcm9wZXJ0eSB9ID0gX2RlY29yYXRvcjtcblxuLyoqXG4gKiBGaWdtYSBJbXBvcnRlciDnlJ/miJDnmoTlkIzmraXmoIforrDjgILlrZfmrrXnlLHmj5Lku7bnu7TmiqTvvIzmiYvlt6Xkv67mlLnkvJrlr7zoh7TkuIvmrKHlkIzmraXooqvmi5Lnu53jgIJcbiAqIOWIoOmZpOacrOe7hOS7tuWNs+ihqOekuuivpeiKgueCuemAgOWHuiBGaWdtYSDlkIzmraXvvJrmj5Lku7bkuI3kvJrlho3np7vliqjjgIHnvKnmlL7miJbliKDpmaTlroPjgIJcbiAqL1xuQGNjY2xhc3MoJyR7U1lOQ19NQVJLRVJfQ0xBU1N9JylcbmV4cG9ydCBjbGFzcyAke1NZTkNfTUFSS0VSX0NMQVNTfSBleHRlbmRzIENvbXBvbmVudCB7XG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+agh+iusOWNj+iurueJiOacrCcgfSlcbiAgICBwdWJsaWMgZmlnbWFNYXJrZXJTY2hlbWE6IG51bWJlciA9ICR7U1lOQ19NQVJLRVJfU0NIRU1BfTtcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICdGaWdtYSDmlofku7Yga2V5IOeahCBTSEEtMjU2JyB9KVxuICAgIHB1YmxpYyBmaWdtYUZpbGVIYXNoOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICdGaWdtYSDoioLngrkgaWQnIH0pXG4gICAgcHVibGljIGZpZ21hTm9kZUlkOiBzdHJpbmcgPSAnJztcblxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfooqvmipjlj6DliLDmnKzoioLngrnnmoQgRmlnbWEg5a2Q5bGCIGlk77yM6YCX5Y+35YiG6ZqUJyB9KVxuICAgIHB1YmxpYyBmaWdtYUFsaWFzTm9kZUlkczogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5oqY5Y+g5a2Q5bGC6ZuG5ZCI5oyH57q5JyB9KVxuICAgIHB1YmxpYyBmaWdtYUFsaWFzSGFzaDogc3RyaW5nID0gJyc7XG5cbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE6IqC54K56KeG6KeJ5oyH57q5JyB9KVxuICAgIHB1YmxpYyBmaWdtYVZpc3VhbEhhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+acrOasoeWvvOWFpeaXtueahOWDj+e0oOaMh+e6ue+8iOS4jeWQq+mhtemdouWdkOagh++8iScgfSlcbiAgICBwdWJsaWMgZmlnbWFQaXhlbEhhc2g6IHN0cmluZyA9ICcnO1xuXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+acrOasoeWvvOWFpeaXtueahOWtkOagkeaMh+e6uScgfSlcbiAgICBwdWJsaWMgZmlnbWFTdWJ0cmVlSGFzaDogc3RyaW5nID0gJyc7XG59XG5gO1xuXG4vKiog6aqM6K+B55Sf5oiQ5Yiw6aG555uu6YeM55qE6ISa5pys5rKh5pyJ6KKr5oiq5pat5oiW6KKr5pS55oiQ5Yir55qE57G744CCICovXG5leHBvcnQgZnVuY3Rpb24gaXNTeW5jTWFya2VyU2NyaXB0KHNvdXJjZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHR5cGVvZiBzb3VyY2UgPT09ICdzdHJpbmcnXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgQGNjY2xhc3MoJyR7U1lOQ19NQVJLRVJfQ0xBU1N9JylgKVxuICAgICAgICAmJiBzb3VyY2UuaW5jbHVkZXMoYGNsYXNzICR7U1lOQ19NQVJLRVJfQ0xBU1N9IGV4dGVuZHMgQ29tcG9uZW50YClcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKCdmaWdtYVN1YnRyZWVIYXNoJyk7XG59XG4iXX0=