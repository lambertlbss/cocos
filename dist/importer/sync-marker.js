"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYNC_MARKER_SCRIPT_SOURCE = exports.SYNC_MARKER_CATEGORY = exports.SYNC_MARKER_SCRIPT_URL = exports.SYNC_MARKER_FILE = exports.SYNC_MARKER_FOLDER = exports.SYNC_MARKER_CLASS = exports.SYNC_MARKER_SCHEMA = void 0;
exports.normalizeSyncNodeId = normalizeSyncNodeId;
exports.syncVisualPayload = syncVisualPayload;
exports.syncSubtreePayload = syncSubtreePayload;
exports.syncVisualHash = syncVisualHash;
exports.syncPixelPayload = syncPixelPayload;
exports.isStretchableImage = isStretchableImage;
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
function syncPixelPayload(node, origin, root = true, stripGeometry = false) {
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
    // 纯图片节点，或"只包着一张同框图片"的包装层：位图可以被 Sprite 直接拉伸，
    // 尺寸变化不改变像素内容，因此整条链的几何都不参与像素指纹。
    // 其他情况（有圆角/描边/特效、或图片不满框）仍按原规则计算。
    const strip = stripGeometry || (root && isStretchableImage(node));
    return {
        ...visual,
        size: strip ? null : visual.size,
        rotation: strip ? null : visual.rotation,
        frame: strip ? null : relative(visual.frame),
        renderBounds: strip ? null : relative(visual.renderBounds),
        children: ((_c = node.children) !== null && _c !== void 0 ? _c : []).map((child) => syncPixelPayload(child, base, false, strip)),
    };
}
function framesEqual(left, right) {
    if (!left || !right) {
        return false;
    }
    const near = (a, b) => Math.abs(a - b) <= 0.01;
    return near(left.x, right.x) && near(left.y, right.y)
        && near(left.width, right.width) && near(left.height, right.height);
}
function hasOwnVisual(node) {
    var _a, _b, _c, _d, _e;
    if (((_a = node.fills) !== null && _a !== void 0 ? _a : []).some((fill) => fill.visible !== false)) {
        return true;
    }
    if (((_b = node.strokes) !== null && _b !== void 0 ? _b : []).some((stroke) => stroke.visible !== false)) {
        return true;
    }
    if (((_c = node.effects) !== null && _c !== void 0 ? _c : []).some((effect) => effect.visible !== false)) {
        return true;
    }
    if (((_d = node.cornerRadius) !== null && _d !== void 0 ? _d : 0) > 0) {
        return true;
    }
    return ((_e = node.rectangleCornerRadii) !== null && _e !== void 0 ? _e : []).some((radius) => radius > 0);
}
/**
 * 可被 Sprite 直接拉伸的图片结构：
 * - 自身就是纯图片节点；或
 * - 自身没有任何填充/描边/特效/圆角，只包着一层或多层空容器，
 *   最内层是纯图片节点，且与最外层完全同框（这正是单图片折叠的形态）。
 */
function isStretchableImage(node) {
    var _a;
    if (isPlainImageNode(node)) {
        return true;
    }
    const rootBox = node.absoluteBoundingBox;
    if (!rootBox || hasOwnVisual(node)) {
        return false;
    }
    let current = node;
    for (let depth = 0; depth < 8; depth += 1) {
        const children = (_a = current.children) !== null && _a !== void 0 ? _a : [];
        if (!children.length) {
            return false;
        }
        if (children.length > 1) {
            return false;
        }
        const child = children[0];
        if (isPlainImageNode(child)) {
            return framesEqual(rootBox, child.absoluteBoundingBox);
        }
        if (hasOwnVisual(child) || child.arcData || child.clipsContent) {
            return false;
        }
        current = child;
    }
    return false;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBeURBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFRRCw0Q0E2QkM7QUFpQ0QsZ0RBMkJDO0FBTUQsNENBb0JDO0FBRUQsc0NBRUM7QUFFRCwwQ0FFQztBQUVELHNDQUdDO0FBRUQsb0NBTUM7QUFFRCw0Q0FrQkM7QUFFRCw4Q0F5QkM7QUFHRCxzREFTQztBQUVELDBEQVdDO0FBT0QsZ0VBU0M7QUFFc0QsOERBNEN0RDtBQU1ELDhEQWFDO0FBd0NELGdEQUtDO0FBL2lCRCxnRUFBMEY7QUFFMUY7Ozs7Ozs7OztHQVNHO0FBQ1UsUUFBQSxrQkFBa0IsR0FBRyxDQUFVLENBQUM7QUFDaEMsUUFBQSxpQkFBaUIsR0FBRyxlQUFlLENBQUM7QUFDcEMsUUFBQSxrQkFBa0IsR0FBRyx3QkFBd0IsQ0FBQztBQUM5QyxRQUFBLGdCQUFnQixHQUFHLGtCQUFrQixDQUFDO0FBQ3RDLFFBQUEsc0JBQXNCLEdBQUcsZUFBZSwwQkFBa0IsSUFBSSx3QkFBZ0IsRUFBRSxDQUFDO0FBQ2pGLFFBQUEsb0JBQW9CLEdBQUcsZ0JBQWdCLENBQUM7QUFxQ3JELE1BQU0sY0FBYyxHQUFHLHVCQUF1QixDQUFDO0FBRS9DLFNBQWdCLG1CQUFtQixDQUFDLEtBQWE7SUFDN0MsT0FBTyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQztBQUMzQyxDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBeUI7SUFDM0MsT0FBTyxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBQSxnQ0FBZSxFQUFDLEtBQUssRUFBRSxDQUFDLENBQUMs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LE1BQU0sSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUMzQixLQUFLLE1BQU0sTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLFdBQVcsRUFBRSxHQUFHLE1BQU0sQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDO1lBQ2hFLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDakMsSUFBSSxLQUFLLElBQUksS0FBSyxLQUFLLE1BQU0sQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFDeEMsTUFBTSxJQUFJLEtBQUssQ0FDWCxZQUFZLE1BQU0sUUFBUSxLQUFLLE1BQU0sTUFBTSxDQUFDLFdBQVcsZ0JBQWdCLENBQzFFLENBQUM7WUFDTixDQUFDO1lBQ0QsTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzNDLENBQUM7SUFDTCxDQUFDO0FBQ0wsQ0FBQztBQUVELGlEQUFpRDtBQUNwQyxRQUFBLHlCQUF5QixHQUFHOzs7Ozs7OztZQVE3Qix5QkFBaUI7ZUFDZCx5QkFBaUI7O3lDQUVTLDBCQUFrQjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QjFELENBQUM7QUFFRiwrQkFBK0I7QUFDL0IsU0FBZ0Isa0JBQWtCLENBQUMsTUFBYztJQUM3QyxPQUFPLE9BQU8sTUFBTSxLQUFLLFFBQVE7V0FDMUIsTUFBTSxDQUFDLFFBQVEsQ0FBQyxhQUFhLHlCQUFpQixJQUFJLENBQUM7V0FDbkQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxTQUFTLHlCQUFpQixvQkFBb0IsQ0FBQztXQUMvRCxNQUFNLENBQUMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUM7QUFDL0MsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFFZmZlY3QsIEZpZ21hTm9kZSwgRmlnbWFQYWludCwgRmlnbWFUZXh0U3R5bGUsIFJlY3QsIFN5bmNNYXJrZXJTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBjYW5vbmljYWxTdHJpbmdpZnksIHF1YW50aXplRGVjaW1hbCwgc2hhMjU2IH0gZnJvbSAnLi4vcm91bmR0cmlwL2Nhbm9uaWNhbC1qc29uJztcclxuXHJcbi8qKlxyXG4gKiDnu4Tku7bnuqflj4zovrnlkIzmraXvvIhDb21wb25lbnQgU3luY++8ieeahOagh+iusOWNj+iuruOAglxyXG4gKlxyXG4gKiDmoIforrDnu4Tku7YgYEZpZ21hU3luY05vZGVgIOaMguWcqOavj+S4queUseWQjOatpeaooeW8j+eUn+aIkOeahCBDb2NvcyDoioLngrnkuIrvvIxcclxuICog5pei5o+Q5L6b5Y+v6KeB6Lqr5Lu977yIRmlnbWEg6IqC54K5IGlk77yJ77yM5Lmf5L+d5a2Y5LiK5qyh5a+85YWl5pe255qE6KeG6KeJL+WtkOagkeaMh+e6ue+8jFxyXG4gKiDkvb/ph43mlrDlr7zlhaXog73lnKjkuI3miZPlvIAgUHJlZmFiIOeahOaDheWGteS4i+WIpOaWrVwi6K6+6K6h5pS55LqG5LuA5LmIXCLjgIJcclxuICpcclxuICog5a6J5YWo6L6555WM77yaZmlsZSBrZXkg5Y+q5LulIFNIQS0yNTYg5b2i5byP5L+d5a2Y77ybbm9kZSBpZCDmjInpnIDmsYLmmI7mlofkv53lrZjvvIxcclxuICog5LiOIFByb2plY3QgUHJvZmlsZSDkuK0gbm9kZU1hcHMgLyBub2RlT3ZlcnJpZGVzIOeahOaXouacieaYjuaWh+S4gOiHtOOAglxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDSEVNQSA9IDEgYXMgY29uc3Q7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DTEFTUyA9ICdGaWdtYVN5bmNOb2RlJztcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZPTERFUiA9ICdmaWdtYS1pbXBvcnRlci1ydW50aW1lJztcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0ZJTEUgPSAnRmlnbWFTeW5jTm9kZS50cyc7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfVVJMID0gYGRiOi8vYXNzZXRzLyR7U1lOQ19NQVJLRVJfRk9MREVSfS8ke1NZTkNfTUFSS0VSX0ZJTEV9YDtcclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX0NBVEVHT1JZID0gJ0ZpZ21hIEltcG9ydGVyJztcclxuXHJcbi8qKiDmoIforrDnu4Tku7blnKggUHJlZmFiIOS4reS/neWtmOeahOWtl+auteOAgiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xyXG4gICAgZmlnbWFNYXJrZXJTY2hlbWE6IG51bWJlcjtcclxuICAgIGZpZ21hRmlsZUhhc2g6IHN0cmluZztcclxuICAgIGZpZ21hTm9kZUlkOiBzdHJpbmc7XHJcbiAgICBmaWdtYUFsaWFzTm9kZUlkczogc3RyaW5nO1xyXG4gICAgZmlnbWFBbGlhc0hhc2g6IHN0cmluZztcclxuICAgIGZpZ21hVmlzdWFsSGFzaDogc3RyaW5nO1xyXG4gICAgZmlnbWFQaXhlbEhhc2g6IHN0cmluZztcclxuICAgIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IHR5cGUgeyBTeW5jTWFya2VyU3BlYyB9IGZyb20gJy4uL3R5cGVzJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3luY01hcmtlcklucHV0IHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIC8qKiDooqvmipjlj6DlkLjmlLbnmoTlrZDlsYIgaWTvvIjkuI3lkKsgbm9kZSDoh6rouqvvvInjgIIgKi9cclxuICAgIGFsaWFzTm9kZUlkcz86IHN0cmluZ1tdO1xyXG4gICAgc2NoZW1hPzogbnVtYmVyO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJDb21wYXJpc29uIHtcclxuICAgIC8qKiDmnKzoioLngrnnmoTlh6DkvZXjgIHmmL7pmpDjgIHlpJbop4LjgIHmloflrZfmiJbnu4Tku7bnsbvlnovlj5HnlJ/lj5jljJbjgIIgKi9cclxuICAgIHZpc3VhbENoYW5nZWQ6IGJvb2xlYW47XHJcbiAgICAvKiog5YOP57Sg5YaF5a655Y+Y5YyW77yI5LiN5ZCr6aG16Z2i5Z2Q5qCH77yM5ZCr5pW05qO15a2Q5qCR77yJ77yb5pen5qCH6K6w57y65a2X5q615pe25oyJ5a2Q5qCR5Y+Y5YyW5o6o5pat44CCICovXHJcbiAgICBwaXhlbENoYW5nZWQ6IGJvb2xlYW47XHJcbiAgICAvKiogRmlnbWEg5a2Q5qCR5YaF5Lu75oSP5ZCO5Luj5Y+R55Sf5Y+Y5YyW77yI5ZCr5paw5aKeL+WIoOmZpC/lkIzlkI3mm7/mjaLvvInjgIIgKi9cclxuICAgIHN1YnRyZWVDaGFuZ2VkOiBib29sZWFuO1xyXG4gICAgLyoqIOaKmOWPoOWtkOWxgumbhuWQiOWPkeeUn+WPmOWMlu+8iOWtkOWxguaWsOWinuOAgeWIoOmZpOaIluiiq+abv+aNou+8ieOAgiAqL1xyXG4gICAgc3RydWN0dXJlQ2hhbmdlZDogYm9vbGVhbjtcclxuICAgIC8qKiDpnIDopoHph43mlrDnlJ/miJDlm77niYfotYTmupDmiY3og73lj43mmKDorr7orqHlj5jljJbjgIIgKi9cclxuICAgIGFzc2V0U3RhbGU6IGJvb2xlYW47XHJcbn1cclxuXHJcbmNvbnN0IFNIQTI1Nl9QQVRURVJOID0gL15zaGEyNTY6WzAtOWEtZl17NjR9JC87XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3luY05vZGVJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiB2YWx1ZS50cmltKCkucmVwbGFjZSgvLS9nLCAnOicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pdGVPck51bGwodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB8IG51bGwge1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHF1YW50aXplRGVjaW1hbCh2YWx1ZSwgNCkgOiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZVBheWxvYWQoZnJhbWU6IFJlY3QgfCB1bmRlZmluZWQpOiBudW1iZXJbXSB8IG51bGwge1xyXG4gICAgaWYgKCFmcmFtZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIFtcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueCkgPz8gMCxcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUueSkgPz8gMCxcclxuICAgICAgICBmaW5pdGVPck51bGwoZnJhbWUud2lkdGgpID8/IDAsXHJcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLmhlaWdodCkgPz8gMCxcclxuICAgIF07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhaW50UGF5bG9hZChwYWludDogRmlnbWFQYWludCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdHlwZTogcGFpbnQudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBwYWludC52aXNpYmxlICE9PSBmYWxzZSxcclxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwocGFpbnQub3BhY2l0eSA/PyAxKSxcclxuICAgICAgICBibGVuZE1vZGU6IHBhaW50LmJsZW5kTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIGNvbG9yOiBwYWludC5jb2xvclxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5yKSxcclxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5nKSxcclxuICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5iKSxcclxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChwYWludC5jb2xvci5hID8/IDEpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBpbWFnZVJlZjogcGFpbnQuaW1hZ2VSZWYgPz8gbnVsbCxcclxuICAgICAgICBzY2FsZU1vZGU6IHBhaW50LnNjYWxlTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIHJvdGF0aW9uOiBmaW5pdGVPck51bGwocGFpbnQucm90YXRpb24pLFxyXG4gICAgICAgIHNvdXJjZU5vZGVJZDogcGFpbnQuc291cmNlTm9kZUlkID8/IG51bGwsXHJcbiAgICAgICAgdGlsZVR5cGU6IHBhaW50LnRpbGVUeXBlID8/IG51bGwsXHJcbiAgICAgICAgc2NhbGluZ0ZhY3RvcjogZmluaXRlT3JOdWxsKHBhaW50LnNjYWxpbmdGYWN0b3IpLFxyXG4gICAgICAgIHNwYWNpbmc6IHBhaW50LnNwYWNpbmdcclxuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKHBhaW50LnNwYWNpbmcueCksIGZpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLnkpXVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgaG9yaXpvbnRhbEFsaWdubWVudDogcGFpbnQuaG9yaXpvbnRhbEFsaWdubWVudCA/PyBudWxsLFxyXG4gICAgICAgIHZlcnRpY2FsQWxpZ25tZW50OiBwYWludC52ZXJ0aWNhbEFsaWdubWVudCA/PyBudWxsLFxyXG4gICAgICAgIGdyYWRpZW50SGFuZGxlUG9zaXRpb25zOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zKVxyXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50SGFuZGxlUG9zaXRpb25zLm1hcCgoaGFuZGxlKSA9PiBbZmluaXRlT3JOdWxsKGhhbmRsZS54KSwgZmluaXRlT3JOdWxsKGhhbmRsZS55KV0pXHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBncmFkaWVudFN0b3BzOiBBcnJheS5pc0FycmF5KHBhaW50LmdyYWRpZW50U3RvcHMpXHJcbiAgICAgICAgICAgID8gcGFpbnQuZ3JhZGllbnRTdG9wcy5tYXAoKHN0b3ApID0+IFtmaW5pdGVPck51bGwoc3RvcC5wb3NpdGlvbiksIHN0b3AuY29sb3JcclxuICAgICAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLnIpLFxyXG4gICAgICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmcpLFxyXG4gICAgICAgICAgICAgICAgICAgIGI6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmIpLFxyXG4gICAgICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChzdG9wLmNvbG9yLmEgPz8gMSksXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICA6IG51bGxdKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgLy8g5Zu+54mH6KOB5YiH55+p6Zi15LiO5ruk6ZWc5ZCM5qC35pS55Y+Y5YOP57Sg77yM5L2G5LiN5Lya5pS55Y+YIGltYWdlUmVm77yb5ryP5o6J5a6D5Lus5Lya6K6pXHJcbiAgICAgICAgLy8g5pW05bGC6IqC54K55Zyo6YeN5a+85YWl5ZCO57un57ut5pi+56S65pen5Zu+44CCXHJcbiAgICAgICAgaW1hZ2VUcmFuc2Zvcm06IEFycmF5LmlzQXJyYXkocGFpbnQuaW1hZ2VUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8gcGFpbnQuaW1hZ2VUcmFuc2Zvcm0ubWFwKChyb3cpID0+IChBcnJheS5pc0FycmF5KHJvdylcclxuICAgICAgICAgICAgICAgID8gcm93Lm1hcCgodmFsdWUpID0+IGZpbml0ZU9yTnVsbCh2YWx1ZSkpXHJcbiAgICAgICAgICAgICAgICA6IG51bGwpKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgZmlsdGVyczogcGFpbnQuZmlsdGVyc1xyXG4gICAgICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhwYWludC5maWx0ZXJzKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoWywgdmFsdWVdKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChba2V5LCB2YWx1ZV0pID0+IFtrZXksIGZpbml0ZU9yTnVsbCh2YWx1ZSldKSlcclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0UGF5bG9hZChlZmZlY3Q6IEZpZ21hRWZmZWN0KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB0eXBlOiBlZmZlY3QudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmFkaXVzOiBmaW5pdGVPck51bGwoZWZmZWN0LnJhZGl1cyksXHJcbiAgICAgICAgc3ByZWFkOiBmaW5pdGVPck51bGwoZWZmZWN0LnNwcmVhZCksXHJcbiAgICAgICAgb2Zmc2V0WDogZmluaXRlT3JOdWxsKGVmZmVjdC5vZmZzZXQ/LngpLFxyXG4gICAgICAgIG9mZnNldFk6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py55KSxcclxuICAgICAgICBjb2xvcjogZWZmZWN0LmNvbG9yXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgcjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5yKSxcclxuICAgICAgICAgICAgICAgIGc6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuZyksXHJcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmIpLFxyXG4gICAgICAgICAgICAgICAgYTogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5hID8/IDEpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRleHRQYXlsb2FkKHN0eWxlOiBGaWdtYVRleHRTdHlsZSB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XHJcbiAgICBpZiAoIXN0eWxlKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbnRGYW1pbHk6IHN0eWxlLmZvbnRGYW1pbHkgPz8gbnVsbCxcclxuICAgICAgICBmb250UG9zdFNjcmlwdE5hbWU6IHN0eWxlLmZvbnRQb3N0U2NyaXB0TmFtZSA/PyBudWxsLFxyXG4gICAgICAgIGZvbnRXZWlnaHQ6IGZpbml0ZU9yTnVsbChzdHlsZS5mb250V2VpZ2h0KSxcclxuICAgICAgICBmb250U2l6ZTogZmluaXRlT3JOdWxsKHN0eWxlLmZvbnRTaXplKSxcclxuICAgICAgICB0ZXh0QWxpZ25Ib3Jpem9udGFsOiBzdHlsZS50ZXh0QWxpZ25Ib3Jpem9udGFsID8/IG51bGwsXHJcbiAgICAgICAgdGV4dEFsaWduVmVydGljYWw6IHN0eWxlLnRleHRBbGlnblZlcnRpY2FsID8/IG51bGwsXHJcbiAgICAgICAgbGV0dGVyU3BhY2luZzogZmluaXRlT3JOdWxsKHN0eWxlLmxldHRlclNwYWNpbmcpLFxyXG4gICAgICAgIGxpbmVIZWlnaHRQeDogZmluaXRlT3JOdWxsKHN0eWxlLmxpbmVIZWlnaHRQeCksXHJcbiAgICAgICAgdGV4dEF1dG9SZXNpemU6IHN0eWxlLnRleHRBdXRvUmVzaXplID8/IG51bGwsXHJcbiAgICAgICAgdGV4dFRydW5jYXRpb246IHN0eWxlLnRleHRUcnVuY2F0aW9uID8/IG51bGwsXHJcbiAgICAgICAgbWF4TGluZXM6IGZpbml0ZU9yTnVsbChzdHlsZS5tYXhMaW5lcyksXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKipcclxuICog5pys6IqC54K56Ieq6Lqr55qE6KeG6KeJ6LSh54yu77ya5Yeg5L2V44CB5pi+6ZqQ44CB5aGr5YWFL+aPj+i+uS/nibnmlYjjgIHlnIbop5LjgIHmloflrZfkuI7moLflvI/jgIJcclxuICog5LiN5YyF5ZCr5a2Q6IqC54K577yM5Zug5q2k5oqY5Y+g54i26IqC54K555qE5oyH57q55LiN5Lya5Zug5a2Q5bGC56e75Yqo6ICM5Y+Y5YyW44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbFBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9ybWFsaXplU3luY05vZGVJZChub2RlLmlkKSxcclxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXHJcbiAgICAgICAgZnJhbWU6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpLFxyXG4gICAgICAgIHJlbmRlckJvdW5kczogZnJhbWVQYXlsb2FkKG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHMpLFxyXG4gICAgICAgIHNpemU6IG5vZGUuc2l6ZVxyXG4gICAgICAgICAgICA/IFtmaW5pdGVPck51bGwobm9kZS5zaXplLndpZHRoKSwgZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS5oZWlnaHQpXVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgcm90YXRpb246IGZpbml0ZU9yTnVsbChub2RlLnJvdGF0aW9uKSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUgIT09IGZhbHNlLFxyXG4gICAgICAgIG9wYWNpdHk6IGZpbml0ZU9yTnVsbChub2RlLm9wYWNpdHkgPz8gMSksXHJcbiAgICAgICAgYmxlbmRNb2RlOiBub2RlLmJsZW5kTW9kZSA/PyBudWxsLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQgPT09IHRydWUsXHJcbiAgICAgICAgY29ybmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5jb3JuZXJSYWRpdXMpLFxyXG4gICAgICAgIHJlY3RhbmdsZUNvcm5lclJhZGlpOiBBcnJheS5pc0FycmF5KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkpXHJcbiAgICAgICAgICAgID8gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaS5tYXAoKHJhZGl1cykgPT4gZmluaXRlT3JOdWxsKHJhZGl1cykpXHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICAvLyDlnIblvKfnmoTotbfmraLop5LkuI7lhoXljYrlvoTlj6rmlLnlg4/ntKDvvIzkuI3mlLnlpJbmoYbvvJvkuI3nurPlhaXmjIfnurnkvJrmvI/mjonmlbTlsYLoioLngrnnmoTmlrDlvaLnirbjgIJcclxuICAgICAgICBhcmNEYXRhOiBub2RlLmFyY0RhdGFcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICBzdGFydGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLnN0YXJ0aW5nQW5nbGUpLFxyXG4gICAgICAgICAgICAgICAgZW5kaW5nQW5nbGU6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUpLFxyXG4gICAgICAgICAgICAgICAgaW5uZXJSYWRpdXM6IGZpbml0ZU9yTnVsbChub2RlLmFyY0RhdGEuaW5uZXJSYWRpdXMpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICBmaWxsczogKG5vZGUuZmlsbHMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxyXG4gICAgICAgIHN0cm9rZXM6IChub2RlLnN0cm9rZXMgPz8gW10pLm1hcChwYWludFBheWxvYWQpLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogZmluaXRlT3JOdWxsKG5vZGUuc3Ryb2tlV2VpZ2h0KSxcclxuICAgICAgICBzdHJva2VBbGlnbjogbm9kZS5zdHJva2VBbGlnbiA/PyBudWxsLFxyXG4gICAgICAgIGVmZmVjdHM6IChub2RlLmVmZmVjdHMgPz8gW10pLm1hcChlZmZlY3RQYXlsb2FkKSxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0eXBlb2Ygbm9kZS5jaGFyYWN0ZXJzID09PSAnc3RyaW5nJyA/IG5vZGUuY2hhcmFjdGVycyA6IG51bGwsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0UGF5bG9hZChub2RlLnN0eWxlKSxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKiDlrZDmoJHnu5PmnoTvvJrmnKzoioLngrnmjIfnurkgKyDpgJDlsYLlrZDoioLngrnmjIfnurnvvIznlKjkuo7liKTmlq3muLLmn5PlnovoioLngrnmmK/lkKbpnIDopoHph43mlrDlh7rlm77jgIIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlUGF5bG9hZChub2RlOiBGaWdtYU5vZGUpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHZpc3VhbDogc3luY1Zpc3VhbFBheWxvYWQobm9kZSksXHJcbiAgICAgICAgY2hpbGRyZW46IChub2RlLmNoaWxkcmVuID8/IFtdKS5tYXAoKGNoaWxkKSA9PiBzeW5jU3VidHJlZVBheWxvYWQoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jVmlzdWFsSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1Zpc3VhbFBheWxvYWQobm9kZSkpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOWPquS/neeVmeW9seWTjeWDj+e0oOeahOWxnuaAp++8muWdkOagh+aUueS4uuebuOWvueacrOiKgueCueWOn+eCueeahOWBj+enu++8jOW5tumAkuW9kuWMheWQq+aVtOajteWtkOagkeOAglxyXG4gKiAtIOaVtOS4quiKgueCueWcqOmhtemdoumHjOenu+WKqO+8muaJgOacieebuOWvueWdkOagh+S4jeWPmCDihpIg5YOP57Sg5oyH57q55LiN5Y+Y77ybXHJcbiAqIC0g5a2Q5bGC5Zyo6IqC54K55YaF6YOo56e75Yqo77ya55u45a+55Z2Q5qCH5pS55Y+YIOKGkiDlg4/ntKDmjIfnurnmlLnlj5jvvJtcclxuICogLSDlsLrlr7jjgIHml4vovazjgIHlpJbop4LjgIHmloflrZfkuI7ku7vkvZXlkI7ku6Plj5jljJbpg73orqHlhaXjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jUGl4ZWxQYXlsb2FkKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgb3JpZ2luPzogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9LFxyXG4gICAgcm9vdCA9IHRydWUsXHJcbiAgICBzdHJpcEdlb21ldHJ5ID0gZmFsc2UsXHJcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIGNvbnN0IHZpc3VhbCA9IHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpO1xyXG4gICAgY29uc3QgYm94ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgYmFzZSA9IG9yaWdpbiA/PyB7IHg6IGJveD8ueCA/PyAwLCB5OiBib3g/LnkgPz8gMCB9O1xyXG4gICAgY29uc3QgcmVsYXRpdmUgPSAoZnJhbWU6IG51bWJlcltdIHwgbnVsbCk6IG51bWJlcltdIHwgbnVsbCA9PiAoZnJhbWVcclxuICAgICAgICA/IFtcclxuICAgICAgICAgICAgcXVhbnRpemVEZWNpbWFsKGZyYW1lWzBdIC0gYmFzZS54LCA0KSxcclxuICAgICAgICAgICAgcXVhbnRpemVEZWNpbWFsKGZyYW1lWzFdIC0gYmFzZS55LCA0KSxcclxuICAgICAgICAgICAgZnJhbWVbMl0sXHJcbiAgICAgICAgICAgIGZyYW1lWzNdLFxyXG4gICAgICAgIF1cclxuICAgICAgICA6IG51bGwpO1xyXG4gICAgLy8g57qv5Zu+54mH6IqC54K577yM5oiWXCLlj6rljIXnnYDkuIDlvKDlkIzmoYblm77niYdcIueahOWMheijheWxgu+8muS9jeWbvuWPr+S7peiiqyBTcHJpdGUg55u05o6l5ouJ5Ly477yMXHJcbiAgICAvLyDlsLrlr7jlj5jljJbkuI3mlLnlj5jlg4/ntKDlhoXlrrnvvIzlm6DmraTmlbTmnaHpk77nmoTlh6DkvZXpg73kuI3lj4LkuI7lg4/ntKDmjIfnurnjgIJcclxuICAgIC8vIOWFtuS7luaDheWGte+8iOacieWchuinki/mj4/ovrkv54m55pWI44CB5oiW5Zu+54mH5LiN5ruh5qGG77yJ5LuN5oyJ5Y6f6KeE5YiZ6K6h566X44CCXHJcbiAgICBjb25zdCBzdHJpcCA9IHN0cmlwR2VvbWV0cnkgfHwgKHJvb3QgJiYgaXNTdHJldGNoYWJsZUltYWdlKG5vZGUpKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4udmlzdWFsLFxyXG4gICAgICAgIHNpemU6IHN0cmlwID8gbnVsbCA6IHZpc3VhbC5zaXplLFxyXG4gICAgICAgIHJvdGF0aW9uOiBzdHJpcCA/IG51bGwgOiB2aXN1YWwucm90YXRpb24sXHJcbiAgICAgICAgZnJhbWU6IHN0cmlwID8gbnVsbCA6IHJlbGF0aXZlKHZpc3VhbC5mcmFtZSBhcyBudW1iZXJbXSB8IG51bGwpLFxyXG4gICAgICAgIHJlbmRlckJvdW5kczogc3RyaXAgPyBudWxsIDogcmVsYXRpdmUodmlzdWFsLnJlbmRlckJvdW5kcyBhcyBudW1iZXJbXSB8IG51bGwpLFxyXG4gICAgICAgIGNoaWxkcmVuOiAobm9kZS5jaGlsZHJlbiA/PyBbXSkubWFwKChjaGlsZCkgPT4gc3luY1BpeGVsUGF5bG9hZChjaGlsZCwgYmFzZSwgZmFsc2UsIHN0cmlwKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZXNFcXVhbChsZWZ0OiBSZWN0IHwgdW5kZWZpbmVkLCByaWdodDogUmVjdCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFsZWZ0IHx8ICFyaWdodCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IG5lYXIgPSAoYTogbnVtYmVyLCBiOiBudW1iZXIpID0+IE1hdGguYWJzKGEgLSBiKSA8PSAwLjAxO1xyXG4gICAgcmV0dXJuIG5lYXIobGVmdC54LCByaWdodC54KSAmJiBuZWFyKGxlZnQueSwgcmlnaHQueSlcclxuICAgICAgICAmJiBuZWFyKGxlZnQud2lkdGgsIHJpZ2h0LndpZHRoKSAmJiBuZWFyKGxlZnQuaGVpZ2h0LCByaWdodC5oZWlnaHQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNPd25WaXN1YWwobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoKG5vZGUuZmlsbHMgPz8gW10pLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuc3Ryb2tlcyA/PyBbXSkuc29tZSgoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuZWZmZWN0cyA/PyBbXSkuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuY29ybmVyUmFkaXVzID8/IDApID4gMCkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpID8/IFtdKS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDApO1xyXG59XHJcblxyXG4vKipcclxuICog5Y+v6KKrIFNwcml0ZSDnm7TmjqXmi4nkvLjnmoTlm77niYfnu5PmnoTvvJpcclxuICogLSDoh6rouqvlsLHmmK/nuq/lm77niYfoioLngrnvvJvmiJZcclxuICogLSDoh6rouqvmsqHmnInku7vkvZXloavlhYUv5o+P6L65L+eJueaViC/lnIbop5LvvIzlj6rljIXnnYDkuIDlsYLmiJblpJrlsYLnqbrlrrnlmajvvIxcclxuICogICDmnIDlhoXlsYLmmK/nuq/lm77niYfoioLngrnvvIzkuJTkuI7mnIDlpJblsYLlrozlhajlkIzmoYbvvIjov5nmraPmmK/ljZXlm77niYfmipjlj6DnmoTlvaLmgIHvvInjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cmV0Y2hhYmxlSW1hZ2Uobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoaXNQbGFpbkltYWdlTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm9vdEJveCA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGlmICghcm9vdEJveCB8fCBoYXNPd25WaXN1YWwobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBsZXQgY3VycmVudDogRmlnbWFOb2RlID0gbm9kZTtcclxuICAgIGZvciAobGV0IGRlcHRoID0gMDsgZGVwdGggPCA4OyBkZXB0aCArPSAxKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSBjdXJyZW50LmNoaWxkcmVuID8/IFtdO1xyXG4gICAgICAgIGlmICghY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZCA9IGNoaWxkcmVuWzBdO1xyXG4gICAgICAgIGlmIChpc1BsYWluSW1hZ2VOb2RlKGNoaWxkKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZnJhbWVzRXF1YWwocm9vdEJveCwgY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChoYXNPd25WaXN1YWwoY2hpbGQpIHx8IGNoaWxkLmFyY0RhdGEgfHwgY2hpbGQuY2xpcHNDb250ZW50KSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY3VycmVudCA9IGNoaWxkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG59XHJcblxyXG4vKipcclxuICog57qv5Zu+54mH6IqC54K577ya5Y2V5Liq5Y+v6KeBIElNQUdFIOWhq+WFheOAgeaXoOaPj+i+uS/nibnmlYgv5ZyG6KeSL+ijgeWJqi/lnIblvKfjgIHml6DlrZDlsYLjgIJcclxuICog6L+Z57G76IqC54K555qE5L2N5Zu+5Y+v5Lul6KKrIFNwcml0ZSDnm7TmjqXmi4nkvLjvvIzmlLnlj5jlsLrlr7jmiJbml4vovazkuI3pnIDopoHph43mlrDlh7rlm77jgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1BsYWluSW1hZ2VOb2RlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmNsaXBzQ29udGVudCB8fCBub2RlLmFyY0RhdGEpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuY29ybmVyUmFkaXVzID8/IDApID4gMCB8fCAobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSA/PyBbXSkuc29tZSgocmFkaXVzKSA9PiByYWRpdXMgPiAwKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmICgobm9kZS5zdHJva2VzID8/IFtdKS5zb21lKChzdHJva2UpID0+IHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuZWZmZWN0cyA/PyBbXSkuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gKG5vZGUuZmlsbHMgPz8gW10pLmZpbHRlcigoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICByZXR1cm4gdmlzaWJsZUZpbGxzLmxlbmd0aCA9PT0gMVxyXG4gICAgICAgICYmIHZpc2libGVGaWxsc1swXS50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgJiYgQm9vbGVhbih2aXNpYmxlRmlsbHNbMF0uaW1hZ2VSZWYpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3luY1BpeGVsSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1BpeGVsUGF5bG9hZChub2RlKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3luY1N1YnRyZWVIYXNoKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShzeW5jU3VidHJlZVBheWxvYWQobm9kZSkpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBpZHMgPSBbLi4ubmV3IFNldChhbGlhc05vZGVJZHMubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpLmZpbHRlcihCb29sZWFuKSldLnNvcnQoKTtcclxuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KGlkcykpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3luY0ZpbGVIYXNoKGZpbGVLZXk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBub3JtYWxpemVkID0gZmlsZUtleS50cmltKCk7XHJcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+e7hOS7tuWQjOatpee8uuWwkSBGaWdtYSBmaWxlIGtleeOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNoYTI1NihgZmlnbWEtaW1wb3J0ZXI6c3luYy1maWxlOnYxXFwwJHtub3JtYWxpemVkfWApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3luY01hcmtlcihpbnB1dDogU3luY01hcmtlcklucHV0KTogU3luY01hcmtlclNwZWMge1xyXG4gICAgY29uc3Qgbm9kZUlkID0gbm9ybWFsaXplU3luY05vZGVJZChpbnB1dC5ub2RlLmlkKTtcclxuICAgIGlmICghbm9kZUlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXoioLngrnnvLrlsJEgRmlnbWEg6IqC54K5IGlk44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhbGlhc05vZGVJZHMgPSBbLi4ubmV3IFNldCgoaW5wdXQuYWxpYXNOb2RlSWRzID8/IFtdKVxyXG4gICAgICAgIC5tYXAobm9ybWFsaXplU3luY05vZGVJZClcclxuICAgICAgICAuZmlsdGVyKChpZCkgPT4gQm9vbGVhbihpZCkgJiYgaWQgIT09IG5vZGVJZCkpXS5zb3J0KCk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjaGVtYTogaW5wdXQuc2NoZW1hID8/IFNZTkNfTUFSS0VSX1NDSEVNQSxcclxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBzeW5jRmlsZUhhc2goaW5wdXQuZmlsZUtleSksXHJcbiAgICAgICAgZmlnbWFOb2RlSWQ6IG5vZGVJZCxcclxuICAgICAgICBhbGlhc05vZGVJZHMsXHJcbiAgICAgICAgYWxpYXNIYXNoOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyksXHJcbiAgICAgICAgdmlzdWFsSGFzaDogc3luY1Zpc3VhbEhhc2goaW5wdXQubm9kZSksXHJcbiAgICAgICAgcGl4ZWxIYXNoOiBzeW5jUGl4ZWxIYXNoKGlucHV0Lm5vZGUpLFxyXG4gICAgICAgIHN1YnRyZWVIYXNoOiBzeW5jU3VidHJlZUhhc2goaW5wdXQubm9kZSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY29tcGFyZVN5bmNNYXJrZXIoXHJcbiAgICBwcmV2aW91czogU3luY01hcmtlclNwZWMsXHJcbiAgICBuZXh0OiBTeW5jTWFya2VyU3BlYyxcclxuKTogU3luY01hcmtlckNvbXBhcmlzb24ge1xyXG4gICAgY29uc3QgdmlzdWFsQ2hhbmdlZCA9IHByZXZpb3VzLnZpc3VhbEhhc2ggIT09IG5leHQudmlzdWFsSGFzaDtcclxuICAgIGNvbnN0IHN1YnRyZWVDaGFuZ2VkID0gcHJldmlvdXMuc3VidHJlZUhhc2ggIT09IG5leHQuc3VidHJlZUhhc2g7XHJcbiAgICBjb25zdCBzdHJ1Y3R1cmVDaGFuZ2VkID0gcHJldmlvdXMuYWxpYXNIYXNoICE9PSBuZXh0LmFsaWFzSGFzaFxyXG4gICAgICAgIHx8IHByZXZpb3VzLmFsaWFzTm9kZUlkcy5qb2luKCcsJykgIT09IG5leHQuYWxpYXNOb2RlSWRzLmpvaW4oJywnKTtcclxuICAgIGNvbnN0IHNvdXJjZUNoYW5nZWQgPSBwcmV2aW91cy5maWdtYUZpbGVIYXNoICE9PSBuZXh0LmZpZ21hRmlsZUhhc2hcclxuICAgICAgICB8fCBwcmV2aW91cy5maWdtYU5vZGVJZCAhPT0gbmV4dC5maWdtYU5vZGVJZDtcclxuICAgIC8vIOWDj+e0oOaYr+WQpuWPmOWMlu+8muS4pOi+uemDveacieWDj+e0oOaMh+e6ueaXtueUqOWug++8iOS4jeWQq+mhtemdouWdkOagh++8ie+8m1xyXG4gICAgLy8g5pen5qCH6K6w5rKh5pyJ6K+l5a2X5q615pe26YCA5Zue5a2Q5qCR5oyH57q577yM5a6B5Y+v5aSa5Yik5LiA5qyh6L+H5pyf77yM5Lmf5LiN6IO95ryP5o6J55yf5a6e5pS55Yqo44CCXHJcbiAgICBjb25zdCBwaXhlbENvbXBhcmFibGUgPSB0eXBlb2YgcHJldmlvdXMucGl4ZWxIYXNoID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICYmIHR5cGVvZiBuZXh0LnBpeGVsSGFzaCA9PT0gJ3N0cmluZyc7XHJcbiAgICBjb25zdCBwaXhlbENoYW5nZWQgPSBwaXhlbENvbXBhcmFibGVcclxuICAgICAgICA/IHByZXZpb3VzLnBpeGVsSGFzaCAhPT0gbmV4dC5waXhlbEhhc2hcclxuICAgICAgICA6IHN1YnRyZWVDaGFuZ2VkO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2aXN1YWxDaGFuZ2VkLFxyXG4gICAgICAgIHBpeGVsQ2hhbmdlZCxcclxuICAgICAgICBzdWJ0cmVlQ2hhbmdlZCxcclxuICAgICAgICBzdHJ1Y3R1cmVDaGFuZ2VkLFxyXG4gICAgICAgIC8vIOWPquaUueS9jee9ruS4jeWGjeimgeaxgumHjeaWsOWHuuWbvu+8m+adpea6kOOAgeWDj+e0oOaIluaKmOWPoOe7k+aehOWPmOWMluaJjemcgOimgeOAglxyXG4gICAgICAgIGFzc2V0U3RhbGU6IHBpeGVsQ2hhbmdlZCB8fCBzdHJ1Y3R1cmVDaGFuZ2VkIHx8IHNvdXJjZUNoYW5nZWQsXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKiog5Yik5pat5LiA5Liq5LiN6YCP5piO6KeG6KeJ6IqC54K577yI55+i6YePL+aVtOWxgiBQTkcv5oqY5Y+g5YyF6KOF77yJ5piv5ZCm6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH44CCICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jTmVlZHNBc3NldFJlZnJlc2gob3B0aW9uczoge1xyXG4gICAgY29tcGFyaXNvbjogU3luY01hcmtlckNvbXBhcmlzb247XHJcbiAgICAvKiog5b2T5YmN6IqC54K55piv5ZCm5LulIFBORyDlvaLlvI/okL3lnLDvvIjmlbTlsYIgcmVuZGVy44CB55+i6YeP44CB5oqY5Y+gIFNwcml0ZS9MYWJlbO+8ieOAgiAqL1xyXG4gICAgcmFzdGVyaXplZDogYm9vbGVhbjtcclxufSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFvcHRpb25zLnJhc3Rlcml6ZWQpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gb3B0aW9ucy5jb21wYXJpc29uLmFzc2V0U3RhbGU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtYXJrZXJUb0NvbXBvbmVudFZhbHVlcyhtYXJrZXI6IFN5bmNNYXJrZXJTcGVjKTogU3luY01hcmtlckNvbXBvbmVudFZhbHVlcyB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpZ21hTWFya2VyU2NoZW1hOiBtYXJrZXIuc2NoZW1hLFxyXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IG1hcmtlci5maWdtYUZpbGVIYXNoLFxyXG4gICAgICAgIGZpZ21hTm9kZUlkOiBtYXJrZXIuZmlnbWFOb2RlSWQsXHJcbiAgICAgICAgZmlnbWFBbGlhc05vZGVJZHM6IG1hcmtlci5hbGlhc05vZGVJZHMuam9pbignLCcpLFxyXG4gICAgICAgIGZpZ21hQWxpYXNIYXNoOiBtYXJrZXIuYWxpYXNIYXNoLFxyXG4gICAgICAgIGZpZ21hVmlzdWFsSGFzaDogbWFya2VyLnZpc3VhbEhhc2gsXHJcbiAgICAgICAgZmlnbWFQaXhlbEhhc2g6IG1hcmtlci5waXhlbEhhc2ggPz8gJycsXHJcbiAgICAgICAgZmlnbWFTdWJ0cmVlSGFzaDogbWFya2VyLnN1YnRyZWVIYXNoLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOWIpOaWreS4gOS4que7hOS7tuWunuS+i+aYr+WQpuaYr+acrOaPkuS7tueUn+aIkOeahOWQjOatpeagh+iusOOAglxyXG4gKiDnlKjkuo7miYDmnInmnYPliKTlrprvvJrmoIforrDmsLjov5zlsZ7kuo7mj5Lku7bvvIzkuI3og73nrpfkvZxcIuaJi+W3pee7hOS7tlwi6Zi75q2i6IqC54K55Yig6Zmk44CCXHJcbiAqIOaMieWtl+auteivhuWIq++8jOS4jeS+nei1luiEmuacrCBVVUlEIOKAlOKAlCDohJrmnKzph43mlrDlr7zlhaXmiJYgVVVJRCDlj5jljJbml7bku43nhLbmiJDnq4vjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJDb21wb25lbnRWYWx1ZSh2YWx1ZTogdW5rbm93bik6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVjb3JkID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICByZXR1cm4gcmVjb3JkLmZpZ21hTWFya2VyU2NoZW1hID09PSBTWU5DX01BUktFUl9TQ0hFTUFcclxuICAgICAgICAmJiB0eXBlb2YgcmVjb3JkLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICYmIHJlY29yZC5maWdtYU5vZGVJZC5sZW5ndGggPiAwXHJcbiAgICAgICAgJiYgdHlwZW9mIHJlY29yZC5maWdtYVZpc3VhbEhhc2ggPT09ICdzdHJpbmcnO1xyXG59XHJcblxyXG4vKiog5LuOIENvY29zIOe7hOS7tuivu+Wbnuagh+iusO+8m+Wtl+autee8uuWkseaIluaNn+Wdj+aXtui/lOWbniBudWxs77yM55Sx6LCD55So5pa5IGZhaWwtY2xvc2Vk44CCICovZXhwb3J0IGZ1bmN0aW9uIG1hcmtlckZyb21Db21wb25lbnRWYWx1ZXMoXHJcbiAgICB2YWx1ZXM6IFBhcnRpYWw8U3luY01hcmtlckNvbXBvbmVudFZhbHVlcz4gfCBudWxsIHwgdW5kZWZpbmVkLFxyXG4pOiBTeW5jTWFya2VyU3BlYyB8IG51bGwge1xyXG4gICAgaWYgKCF2YWx1ZXMgfHwgdHlwZW9mIHZhbHVlcyAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjaGVtYSA9IHZhbHVlcy5maWdtYU1hcmtlclNjaGVtYTtcclxuICAgIGlmIChzY2hlbWEgIT09IFNZTkNfTUFSS0VSX1NDSEVNQSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUhhc2ggPSB2YWx1ZXMuZmlnbWFGaWxlSGFzaDtcclxuICAgIGNvbnN0IG5vZGVJZCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFOb2RlSWQgPT09ICdzdHJpbmcnID8gbm9ybWFsaXplU3luY05vZGVJZCh2YWx1ZXMuZmlnbWFOb2RlSWQpIDogJyc7XHJcbiAgICBjb25zdCB2aXN1YWxIYXNoID0gdmFsdWVzLmZpZ21hVmlzdWFsSGFzaDtcclxuICAgIGNvbnN0IHN1YnRyZWVIYXNoID0gdmFsdWVzLmZpZ21hU3VidHJlZUhhc2g7XHJcbiAgICBpZiAodHlwZW9mIGZpbGVIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdChmaWxlSGFzaCkpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGlmICghbm9kZUlkIHx8IHR5cGVvZiB2aXN1YWxIYXNoICE9PSAnc3RyaW5nJyB8fCAhU0hBMjU2X1BBVFRFUk4udGVzdCh2aXN1YWxIYXNoKSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgaWYgKHR5cGVvZiBzdWJ0cmVlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3Qoc3VidHJlZUhhc2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhbGlhc05vZGVJZHMgPSB0eXBlb2YgdmFsdWVzLmZpZ21hQWxpYXNOb2RlSWRzID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNOb2RlSWRzLnNwbGl0KCcsJylcclxuICAgICAgICAgICAgLm1hcCgoaWQpID0+IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaWQpKVxyXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgICAgIC5zb3J0KClcclxuICAgICAgICA6IFtdO1xyXG4gICAgY29uc3QgYWxpYXNIYXNoID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzSGFzaCA9PT0gJ3N0cmluZycgJiYgU0hBMjU2X1BBVFRFUk4udGVzdCh2YWx1ZXMuZmlnbWFBbGlhc0hhc2gpXHJcbiAgICAgICAgPyB2YWx1ZXMuZmlnbWFBbGlhc0hhc2hcclxuICAgICAgICA6IHN5bmNBbGlhc0hhc2goYWxpYXNOb2RlSWRzKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc2NoZW1hLFxyXG4gICAgICAgIGZpZ21hRmlsZUhhc2g6IGZpbGVIYXNoLFxyXG4gICAgICAgIGZpZ21hTm9kZUlkOiBub2RlSWQsXHJcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxyXG4gICAgICAgIGFsaWFzSGFzaCxcclxuICAgICAgICB2aXN1YWxIYXNoLFxyXG4gICAgICAgIHBpeGVsSGFzaDogdHlwZW9mIHZhbHVlcy5maWdtYVBpeGVsSGFzaCA9PT0gJ3N0cmluZycgJiYgU0hBMjU2X1BBVFRFUk4udGVzdCh2YWx1ZXMuZmlnbWFQaXhlbEhhc2gpXHJcbiAgICAgICAgICAgID8gdmFsdWVzLmZpZ21hUGl4ZWxIYXNoXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHN1YnRyZWVIYXNoLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOS4gOS4qiBGaWdtYSDoioLngrnlj6rog73ooqvkuIDkuKogQ29jb3Mg6IqC54K55aOw5piO77yI6Ieq5bex5oiW5L2c5Li65Yir5ZCN77yJ44CCXHJcbiAqIOaKmOWPoOeItuWtkOWQjOaXtuWjsOaYjuWQjOa6kOiKgueCueS8muiuqVwi5pS55ZOq5Liq6IqC54K5XCLlj5jlvpfkuI3lj6/liKTlrprjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwKG1hcmtlcnM6IHJlYWRvbmx5IFN5bmNNYXJrZXJTcGVjW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IG93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlSWQgb2YgW21hcmtlci5maWdtYU5vZGVJZCwgLi4ubWFya2VyLmFsaWFzTm9kZUlkc10pIHtcclxuICAgICAgICAgICAgY29uc3Qgb3duZXIgPSBvd25lcnMuZ2V0KG5vZGVJZCk7XHJcbiAgICAgICAgICAgIGlmIChvd25lciAmJiBvd25lciAhPT0gbWFya2VyLmZpZ21hTm9kZUlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYEZpZ21hIOiKgueCuSAke25vZGVJZH0g5ZCM5pe26KKrICR7b3duZXJ9IOWSjCAke21hcmtlci5maWdtYU5vZGVJZH0g5aOw5piO77yM5bey5ouS57ud55Sf5oiQ5ZCM5q2l5qCH6K6w44CCYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgb3duZXJzLnNldChub2RlSWQsIG1hcmtlci5maWdtYU5vZGVJZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vKiog6ZyA6KaB5Zyo6aG555uuIGFzc2V0cyDkuK3nlJ/miJDnmoTmnIDlsI/moIforrDnu4Tku7bmupDnoIHvvIjml6DkuJrliqHpgLvovpHvvIzlj6rkv53lrZjmnaXmupDkuI7mjIfnurnvvInjgIIgKi9cclxuZXhwb3J0IGNvbnN0IFNZTkNfTUFSS0VSX1NDUklQVF9TT1VSQ0UgPSBgaW1wb3J0IHsgX2RlY29yYXRvciwgQ29tcG9uZW50IH0gZnJvbSAnY2MnO1xyXG5cclxuY29uc3QgeyBjY2NsYXNzLCBwcm9wZXJ0eSB9ID0gX2RlY29yYXRvcjtcclxuXHJcbi8qKlxyXG4gKiBGaWdtYSBJbXBvcnRlciDnlJ/miJDnmoTlkIzmraXmoIforrDjgILlrZfmrrXnlLHmj5Lku7bnu7TmiqTvvIzmiYvlt6Xkv67mlLnkvJrlr7zoh7TkuIvmrKHlkIzmraXooqvmi5Lnu53jgIJcclxuICog5Yig6Zmk5pys57uE5Lu25Y2z6KGo56S66K+l6IqC54K56YCA5Ye6IEZpZ21hIOWQjOatpe+8muaPkuS7tuS4jeS8muWGjeenu+WKqOOAgee8qeaUvuaIluWIoOmZpOWug+OAglxyXG4gKi9cclxuQGNjY2xhc3MoJyR7U1lOQ19NQVJLRVJfQ0xBU1N9JylcclxuZXhwb3J0IGNsYXNzICR7U1lOQ19NQVJLRVJfQ0xBU1N9IGV4dGVuZHMgQ29tcG9uZW50IHtcclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmoIforrDljY/orq7niYjmnKwnIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFNYXJrZXJTY2hlbWE6IG51bWJlciA9ICR7U1lOQ19NQVJLRVJfU0NIRU1BfTtcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAnRmlnbWEg5paH5Lu2IGtleSDnmoQgU0hBLTI1NicgfSlcclxuICAgIHB1YmxpYyBmaWdtYUZpbGVIYXNoOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAnRmlnbWEg6IqC54K5IGlkJyB9KVxyXG4gICAgcHVibGljIGZpZ21hTm9kZUlkOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn6KKr5oqY5Y+g5Yiw5pys6IqC54K555qEIEZpZ21hIOWtkOWxgiBpZO+8jOmAl+WPt+WIhumalCcgfSlcclxuICAgIHB1YmxpYyBmaWdtYUFsaWFzTm9kZUlkczogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+aKmOWPoOWtkOWxgumbhuWQiOaMh+e6uScgfSlcclxuICAgIHB1YmxpYyBmaWdtYUFsaWFzSGFzaDogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+acrOasoeWvvOWFpeaXtueahOiKgueCueinhuinieaMh+e6uScgfSlcclxuICAgIHB1YmxpYyBmaWdtYVZpc3VhbEhhc2g6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoTlg4/ntKDmjIfnurnvvIjkuI3lkKvpobXpnaLlnZDmoIfvvIknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFQaXhlbEhhc2g6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoTlrZDmoJHmjIfnurknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFTdWJ0cmVlSGFzaDogc3RyaW5nID0gJyc7XHJcbn1cclxuYDtcclxuXHJcbi8qKiDpqozor4HnlJ/miJDliLDpobnnm67ph4znmoTohJrmnKzmsqHmnInooqvmiKrmlq3miJbooqvmlLnmiJDliKvnmoTnsbvjgIIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGlzU3luY01hcmtlclNjcmlwdChzb3VyY2U6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHR5cGVvZiBzb3VyY2UgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBAY2NjbGFzcygnJHtTWU5DX01BUktFUl9DTEFTU30nKWApXHJcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKGBjbGFzcyAke1NZTkNfTUFSS0VSX0NMQVNTfSBleHRlbmRzIENvbXBvbmVudGApXHJcbiAgICAgICAgJiYgc291cmNlLmluY2x1ZGVzKCdmaWdtYVN1YnRyZWVIYXNoJyk7XHJcbn1cclxuIl19