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
const slicing_1 = require("../figma/slicing");
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
function syncPixelPayload(node, origin, root = true, stripGeometry = false, stripScale) {
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
    const scale = stripScale !== null && stripScale !== void 0 ? stripScale : (strip && box && box.width > 0 && box.height > 0
        ? { width: box.width, height: box.height }
        : undefined);
    // Figma 的 Scale 工具在缩放图片节点时会改写填充里的裁切矩阵。按节点尺寸归一化后，
    // 等比/按轴缩放不再算变化；真正的裁切调整仍然会改变指纹。
    const visualFills = scale
        ? {
            ...visual,
            fills: visual.fills.map((fill) => normalizePaintScale(fill, scale)),
            strokes: visual.strokes.map((fill) => normalizePaintScale(fill, scale)),
        }
        : visual;
    return {
        ...visualFills,
        size: strip ? null : visualFills.size,
        rotation: strip ? null : visualFills.rotation,
        frame: strip ? null : relative(visualFills.frame),
        renderBounds: strip ? null : relative(visualFills.renderBounds),
        children: ((_c = node.children) !== null && _c !== void 0 ? _c : []).map((child) => syncPixelPayload(child, base, false, strip, scale)),
    };
}
/** 把图片裁切矩阵按节点尺寸归一化，使等比缩放不改变结果。 */
function normalizePaintScale(fill, scale) {
    const transform = fill.imageTransform;
    if (!Array.isArray(transform) || transform.length !== 2) {
        return fill;
    }
    const scaled = transform.map((row, rowIndex) => (Array.isArray(row)
        ? row.map((value) => (typeof value === 'number' && Number.isFinite(value)
            ? (0, canonical_json_1.quantizeDecimal)(value / (rowIndex === 0 ? scale.width : scale.height), 4)
            : value))
        : row));
    return { ...fill, imageTransform: scaled };
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
    // 三/九宫节点：拉伸由 Cocos 的 SLICED Sprite 完成，尺寸变化不需要重新出图。
    // 只认几何识别通过的结构，命名像切片但几何不成立的节点仍按普通图片处理。
    if ((0, slicing_1.analyzeSliceGrid)(node)) {
        return true;
    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3luYy1tYXJrZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvaW1wb3J0ZXIvc3luYy1tYXJrZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBMERBLGtEQUVDO0FBaUhELDhDQWtDQztBQUdELGdEQUtDO0FBRUQsd0NBRUM7QUFRRCw0Q0E0Q0M7QUFrREQsZ0RBZ0NDO0FBTUQsNENBb0JDO0FBRUQsc0NBRUM7QUFFRCwwQ0FFQztBQUVELHNDQUdDO0FBRUQsb0NBTUM7QUFFRCw0Q0FrQkM7QUFFRCw4Q0F5QkM7QUFHRCxzREFTQztBQUVELDBEQVdDO0FBT0QsZ0VBU0M7QUFFc0QsOERBNEN0RDtBQU1ELDhEQWFDO0FBd0NELGdEQUtDO0FBcmxCRCw4Q0FBb0Q7QUFDcEQsZ0VBQTBGO0FBRTFGOzs7Ozs7Ozs7R0FTRztBQUNVLFFBQUEsa0JBQWtCLEdBQUcsQ0FBVSxDQUFDO0FBQ2hDLFFBQUEsaUJBQWlCLEdBQUcsZUFBZSxDQUFDO0FBQ3BDLFFBQUEsa0JBQWtCLEdBQUcsd0JBQXdCLENBQUM7QUFDOUMsUUFBQSxnQkFBZ0IsR0FBRyxrQkFBa0IsQ0FBQztBQUN0QyxRQUFBLHNCQUFzQixHQUFHLGVBQWUsMEJBQWtCLElBQUksd0JBQWdCLEVBQUUsQ0FBQztBQUNqRixRQUFBLG9CQUFvQixHQUFHLGdCQUFnQixDQUFDO0FBcUNyRCxNQUFNLGNBQWMsR0FBRyx1QkFBdUIsQ0FBQztBQUUvQyxTQUFnQixtQkFBbUIsQ0FBQyxLQUFhO0lBQzdDLE9BQU8sS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDM0MsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQXlCO0lBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUEsZ0NBQWUsRUFBQyxLQUFLLEVB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VyxDQUFDLENBQUM7UUFDM0MsQ0FBQztJQUNMLENBQUM7QUFDTCxDQUFDO0FBRUQsaURBQWlEO0FBQ3BDLFFBQUEseUJBQXlCLEdBQUc7Ozs7Ozs7O1lBUTdCLHlCQUFpQjtlQUNkLHlCQUFpQjs7eUNBRVMsMEJBQWtCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXVCMUQsQ0FBQztBQUVGLCtCQUErQjtBQUMvQixTQUFnQixrQkFBa0IsQ0FBQyxNQUFjO0lBQzdDLE9BQU8sT0FBTyxNQUFNLEtBQUssUUFBUTtXQUMxQixNQUFNLENBQUMsUUFBUSxDQUFDLGFBQWEseUJBQWlCLElBQUksQ0FBQztXQUNuRCxNQUFNLENBQUMsUUFBUSxDQUFDLFNBQVMseUJBQWlCLG9CQUFvQixDQUFDO1dBQy9ELE1BQU0sQ0FBQyxRQUFRLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUMvQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBGaWdtYUVmZmVjdCwgRmlnbWFOb2RlLCBGaWdtYVBhaW50LCBGaWdtYVRleHRTdHlsZSwgUmVjdCwgU3luY01hcmtlclNwZWMgfSBmcm9tICcuLi90eXBlcyc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQgfSBmcm9tICcuLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgY2Fub25pY2FsU3RyaW5naWZ5LCBxdWFudGl6ZURlY2ltYWwsIHNoYTI1NiB9IGZyb20gJy4uL3JvdW5kdHJpcC9jYW5vbmljYWwtanNvbic7XHJcblxyXG4vKipcclxuICog57uE5Lu257qn5Y+M6L655ZCM5q2l77yIQ29tcG9uZW50IFN5bmPvvInnmoTmoIforrDljY/orq7jgIJcclxuICpcclxuICog5qCH6K6w57uE5Lu2IGBGaWdtYVN5bmNOb2RlYCDmjILlnKjmr4/kuKrnlLHlkIzmraXmqKHlvI/nlJ/miJDnmoQgQ29jb3Mg6IqC54K55LiK77yMXHJcbiAqIOaXouaPkOS+m+WPr+ingei6q+S7ve+8iEZpZ21hIOiKgueCuSBpZO+8ie+8jOS5n+S/neWtmOS4iuasoeWvvOWFpeaXtueahOinhuiniS/lrZDmoJHmjIfnurnvvIxcclxuICog5L2/6YeN5paw5a+85YWl6IO95Zyo5LiN5omT5byAIFByZWZhYiDnmoTmg4XlhrXkuIvliKTmlq1cIuiuvuiuoeaUueS6huS7gOS5iFwi44CCXHJcbiAqXHJcbiAqIOWuieWFqOi+ueeVjO+8mmZpbGUga2V5IOWPquS7pSBTSEEtMjU2IOW9ouW8j+S/neWtmO+8m25vZGUgaWQg5oyJ6ZyA5rGC5piO5paH5L+d5a2Y77yMXHJcbiAqIOS4jiBQcm9qZWN0IFByb2ZpbGUg5LitIG5vZGVNYXBzIC8gbm9kZU92ZXJyaWRlcyDnmoTml6LmnInmmI7mlofkuIDoh7TjgIJcclxuICovXHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ0hFTUEgPSAxIGFzIGNvbnN0O1xyXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfQ0xBU1MgPSAnRmlnbWFTeW5jTm9kZSc7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GT0xERVIgPSAnZmlnbWEtaW1wb3J0ZXItcnVudGltZSc7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9GSUxFID0gJ0ZpZ21hU3luY05vZGUudHMnO1xyXG5leHBvcnQgY29uc3QgU1lOQ19NQVJLRVJfU0NSSVBUX1VSTCA9IGBkYjovL2Fzc2V0cy8ke1NZTkNfTUFSS0VSX0ZPTERFUn0vJHtTWU5DX01BUktFUl9GSUxFfWA7XHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9DQVRFR09SWSA9ICdGaWdtYSBJbXBvcnRlcic7XHJcblxyXG4vKiog5qCH6K6w57uE5Lu25ZyoIFByZWZhYiDkuK3kv53lrZjnmoTlrZfmrrXjgIIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcG9uZW50VmFsdWVzIHtcclxuICAgIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXI7XHJcbiAgICBmaWdtYUZpbGVIYXNoOiBzdHJpbmc7XHJcbiAgICBmaWdtYU5vZGVJZDogc3RyaW5nO1xyXG4gICAgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZztcclxuICAgIGZpZ21hQWxpYXNIYXNoOiBzdHJpbmc7XHJcbiAgICBmaWdtYVZpc3VhbEhhc2g6IHN0cmluZztcclxuICAgIGZpZ21hUGl4ZWxIYXNoOiBzdHJpbmc7XHJcbiAgICBmaWdtYVN1YnRyZWVIYXNoOiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCB0eXBlIHsgU3luY01hcmtlclNwZWMgfSBmcm9tICcuLi90eXBlcyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN5bmNNYXJrZXJJbnB1dCB7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAvKiog6KKr5oqY5Y+g5ZC45pS255qE5a2Q5bGCIGlk77yI5LiN5ZCrIG5vZGUg6Ieq6Lqr77yJ44CCICovXHJcbiAgICBhbGlhc05vZGVJZHM/OiBzdHJpbmdbXTtcclxuICAgIHNjaGVtYT86IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTeW5jTWFya2VyQ29tcGFyaXNvbiB7XHJcbiAgICAvKiog5pys6IqC54K555qE5Yeg5L2V44CB5pi+6ZqQ44CB5aSW6KeC44CB5paH5a2X5oiW57uE5Lu257G75Z6L5Y+R55Sf5Y+Y5YyW44CCICovXHJcbiAgICB2aXN1YWxDaGFuZ2VkOiBib29sZWFuO1xyXG4gICAgLyoqIOWDj+e0oOWGheWuueWPmOWMlu+8iOS4jeWQq+mhtemdouWdkOagh++8jOWQq+aVtOajteWtkOagke+8ie+8m+aXp+agh+iusOe8uuWtl+auteaXtuaMieWtkOagkeWPmOWMluaOqOaWreOAgiAqL1xyXG4gICAgcGl4ZWxDaGFuZ2VkOiBib29sZWFuO1xyXG4gICAgLyoqIEZpZ21hIOWtkOagkeWGheS7u+aEj+WQjuS7o+WPkeeUn+WPmOWMlu+8iOWQq+aWsOWini/liKDpmaQv5ZCM5ZCN5pu/5o2i77yJ44CCICovXHJcbiAgICBzdWJ0cmVlQ2hhbmdlZDogYm9vbGVhbjtcclxuICAgIC8qKiDmipjlj6DlrZDlsYLpm4blkIjlj5HnlJ/lj5jljJbvvIjlrZDlsYLmlrDlop7jgIHliKDpmaTmiJbooqvmm7/mjaLvvInjgIIgKi9cclxuICAgIHN0cnVjdHVyZUNoYW5nZWQ6IGJvb2xlYW47XHJcbiAgICAvKiog6ZyA6KaB6YeN5paw55Sf5oiQ5Zu+54mH6LWE5rqQ5omN6IO95Y+N5pig6K6+6K6h5Y+Y5YyW44CCICovXHJcbiAgICBhc3NldFN0YWxlOiBib29sZWFuO1xyXG59XHJcblxyXG5jb25zdCBTSEEyNTZfUEFUVEVSTiA9IC9ec2hhMjU2OlswLTlhLWZdezY0fSQvO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gdmFsdWUudHJpbSgpLnJlcGxhY2UoLy0vZywgJzonKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXRlT3JOdWxsKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIgfCBudWxsIHtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBxdWFudGl6ZURlY2ltYWwodmFsdWUsIDQpIDogbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVQYXlsb2FkKGZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkKTogbnVtYmVyW10gfCBudWxsIHtcclxuICAgIGlmICghZnJhbWUpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBbXHJcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLngpID8/IDAsXHJcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLnkpID8/IDAsXHJcbiAgICAgICAgZmluaXRlT3JOdWxsKGZyYW1lLndpZHRoKSA/PyAwLFxyXG4gICAgICAgIGZpbml0ZU9yTnVsbChmcmFtZS5oZWlnaHQpID8/IDAsXHJcbiAgICBdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYWludFBheWxvYWQocGFpbnQ6IEZpZ21hUGFpbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHR5cGU6IHBhaW50LnR5cGUsXHJcbiAgICAgICAgdmlzaWJsZTogcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UsXHJcbiAgICAgICAgb3BhY2l0eTogZmluaXRlT3JOdWxsKHBhaW50Lm9wYWNpdHkgPz8gMSksXHJcbiAgICAgICAgYmxlbmRNb2RlOiBwYWludC5ibGVuZE1vZGUgPz8gbnVsbCxcclxuICAgICAgICBjb2xvcjogcGFpbnQuY29sb3JcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuciksXHJcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuZyksXHJcbiAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuYiksXHJcbiAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwocGFpbnQuY29sb3IuYSA/PyAxKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgaW1hZ2VSZWY6IHBhaW50LmltYWdlUmVmID8/IG51bGwsXHJcbiAgICAgICAgc2NhbGVNb2RlOiBwYWludC5zY2FsZU1vZGUgPz8gbnVsbCxcclxuICAgICAgICByb3RhdGlvbjogZmluaXRlT3JOdWxsKHBhaW50LnJvdGF0aW9uKSxcclxuICAgICAgICBzb3VyY2VOb2RlSWQ6IHBhaW50LnNvdXJjZU5vZGVJZCA/PyBudWxsLFxyXG4gICAgICAgIHRpbGVUeXBlOiBwYWludC50aWxlVHlwZSA/PyBudWxsLFxyXG4gICAgICAgIHNjYWxpbmdGYWN0b3I6IGZpbml0ZU9yTnVsbChwYWludC5zY2FsaW5nRmFjdG9yKSxcclxuICAgICAgICBzcGFjaW5nOiBwYWludC5zcGFjaW5nXHJcbiAgICAgICAgICAgID8gW2Zpbml0ZU9yTnVsbChwYWludC5zcGFjaW5nLngpLCBmaW5pdGVPck51bGwocGFpbnQuc3BhY2luZy55KV1cclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIGhvcml6b250YWxBbGlnbm1lbnQ6IHBhaW50Lmhvcml6b250YWxBbGlnbm1lbnQgPz8gbnVsbCxcclxuICAgICAgICB2ZXJ0aWNhbEFsaWdubWVudDogcGFpbnQudmVydGljYWxBbGlnbm1lbnQgPz8gbnVsbCxcclxuICAgICAgICBncmFkaWVudEhhbmRsZVBvc2l0aW9uczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudEhhbmRsZVBvc2l0aW9ucylcclxuICAgICAgICAgICAgPyBwYWludC5ncmFkaWVudEhhbmRsZVBvc2l0aW9ucy5tYXAoKGhhbmRsZSkgPT4gW2Zpbml0ZU9yTnVsbChoYW5kbGUueCksIGZpbml0ZU9yTnVsbChoYW5kbGUueSldKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgZ3JhZGllbnRTdG9wczogQXJyYXkuaXNBcnJheShwYWludC5ncmFkaWVudFN0b3BzKVxyXG4gICAgICAgICAgICA/IHBhaW50LmdyYWRpZW50U3RvcHMubWFwKChzdG9wKSA9PiBbZmluaXRlT3JOdWxsKHN0b3AucG9zaXRpb24pLCBzdG9wLmNvbG9yXHJcbiAgICAgICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgICAgICByOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5yKSxcclxuICAgICAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5nKSxcclxuICAgICAgICAgICAgICAgICAgICBiOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5iKSxcclxuICAgICAgICAgICAgICAgICAgICBhOiBmaW5pdGVPck51bGwoc3RvcC5jb2xvci5hID8/IDEpLFxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgOiBudWxsXSlcclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIC8vIOWbvueJh+ijgeWIh+efqemYteS4jua7pOmVnOWQjOagt+aUueWPmOWDj+e0oO+8jOS9huS4jeS8muaUueWPmCBpbWFnZVJlZu+8m+a8j+aOieWug+S7rOS8muiuqVxyXG4gICAgICAgIC8vIOaVtOWxguiKgueCueWcqOmHjeWvvOWFpeWQjue7p+e7reaYvuekuuaXp+WbvuOAglxyXG4gICAgICAgIGltYWdlVHJhbnNmb3JtOiBBcnJheS5pc0FycmF5KHBhaW50LmltYWdlVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/IHBhaW50LmltYWdlVHJhbnNmb3JtLm1hcCgocm93KSA9PiAoQXJyYXkuaXNBcnJheShyb3cpXHJcbiAgICAgICAgICAgICAgICA/IHJvdy5tYXAoKHZhbHVlKSA9PiBmaW5pdGVPck51bGwodmFsdWUpKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsKSlcclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIGZpbHRlcnM6IHBhaW50LmZpbHRlcnNcclxuICAgICAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMocGFpbnQuZmlsdGVycylcclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoW2tleSwgdmFsdWVdKSA9PiBba2V5LCBmaW5pdGVPck51bGwodmFsdWUpXSkpXHJcbiAgICAgICAgICAgIDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVmZmVjdFBheWxvYWQoZWZmZWN0OiBGaWdtYUVmZmVjdCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdHlwZTogZWZmZWN0LnR5cGUsXHJcbiAgICAgICAgdmlzaWJsZTogZWZmZWN0LnZpc2libGUgIT09IGZhbHNlLFxyXG4gICAgICAgIHJhZGl1czogZmluaXRlT3JOdWxsKGVmZmVjdC5yYWRpdXMpLFxyXG4gICAgICAgIHNwcmVhZDogZmluaXRlT3JOdWxsKGVmZmVjdC5zcHJlYWQpLFxyXG4gICAgICAgIG9mZnNldFg6IGZpbml0ZU9yTnVsbChlZmZlY3Qub2Zmc2V0Py54KSxcclxuICAgICAgICBvZmZzZXRZOiBmaW5pdGVPck51bGwoZWZmZWN0Lm9mZnNldD8ueSksXHJcbiAgICAgICAgY29sb3I6IGVmZmVjdC5jb2xvclxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHI6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuciksXHJcbiAgICAgICAgICAgICAgICBnOiBmaW5pdGVPck51bGwoZWZmZWN0LmNvbG9yLmcpLFxyXG4gICAgICAgICAgICAgICAgYjogZmluaXRlT3JOdWxsKGVmZmVjdC5jb2xvci5iKSxcclxuICAgICAgICAgICAgICAgIGE6IGZpbml0ZU9yTnVsbChlZmZlY3QuY29sb3IuYSA/PyAxKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiB0ZXh0UGF5bG9hZChzdHlsZTogRmlnbWFUZXh0U3R5bGUgfCB1bmRlZmluZWQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xyXG4gICAgaWYgKCFzdHlsZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb250RmFtaWx5OiBzdHlsZS5mb250RmFtaWx5ID8/IG51bGwsXHJcbiAgICAgICAgZm9udFBvc3RTY3JpcHROYW1lOiBzdHlsZS5mb250UG9zdFNjcmlwdE5hbWUgPz8gbnVsbCxcclxuICAgICAgICBmb250V2VpZ2h0OiBmaW5pdGVPck51bGwoc3R5bGUuZm9udFdlaWdodCksXHJcbiAgICAgICAgZm9udFNpemU6IGZpbml0ZU9yTnVsbChzdHlsZS5mb250U2l6ZSksXHJcbiAgICAgICAgdGV4dEFsaWduSG9yaXpvbnRhbDogc3R5bGUudGV4dEFsaWduSG9yaXpvbnRhbCA/PyBudWxsLFxyXG4gICAgICAgIHRleHRBbGlnblZlcnRpY2FsOiBzdHlsZS50ZXh0QWxpZ25WZXJ0aWNhbCA/PyBudWxsLFxyXG4gICAgICAgIGxldHRlclNwYWNpbmc6IGZpbml0ZU9yTnVsbChzdHlsZS5sZXR0ZXJTcGFjaW5nKSxcclxuICAgICAgICBsaW5lSGVpZ2h0UHg6IGZpbml0ZU9yTnVsbChzdHlsZS5saW5lSGVpZ2h0UHgpLFxyXG4gICAgICAgIHRleHRBdXRvUmVzaXplOiBzdHlsZS50ZXh0QXV0b1Jlc2l6ZSA/PyBudWxsLFxyXG4gICAgICAgIHRleHRUcnVuY2F0aW9uOiBzdHlsZS50ZXh0VHJ1bmNhdGlvbiA/PyBudWxsLFxyXG4gICAgICAgIG1heExpbmVzOiBmaW5pdGVPck51bGwoc3R5bGUubWF4TGluZXMpLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOacrOiKgueCueiHqui6q+eahOinhuiniei0oeeMru+8muWHoOS9leOAgeaYvumakOOAgeWhq+WFhS/mj4/ovrkv54m55pWI44CB5ZyG6KeS44CB5paH5a2X5LiO5qC35byP44CCXHJcbiAqIOS4jeWMheWQq+WtkOiKgueCue+8jOWboOatpOaKmOWPoOeItuiKgueCueeahOaMh+e6ueS4jeS8muWboOWtkOWxguenu+WKqOiAjOWPmOWMluOAglxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNWaXN1YWxQYXlsb2FkKG5vZGU6IEZpZ21hTm9kZSk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQ6IG5vcm1hbGl6ZVN5bmNOb2RlSWQobm9kZS5pZCksXHJcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgIGZyYW1lOiBmcmFtZVBheWxvYWQobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSxcclxuICAgICAgICByZW5kZXJCb3VuZHM6IGZyYW1lUGF5bG9hZChub2RlLmFic29sdXRlUmVuZGVyQm91bmRzKSxcclxuICAgICAgICBzaXplOiBub2RlLnNpemVcclxuICAgICAgICAgICAgPyBbZmluaXRlT3JOdWxsKG5vZGUuc2l6ZS53aWR0aCksIGZpbml0ZU9yTnVsbChub2RlLnNpemUuaGVpZ2h0KV1cclxuICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIHJvdGF0aW9uOiBmaW5pdGVPck51bGwobm9kZS5yb3RhdGlvbiksXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlICE9PSBmYWxzZSxcclxuICAgICAgICBvcGFjaXR5OiBmaW5pdGVPck51bGwobm9kZS5vcGFjaXR5ID8/IDEpLFxyXG4gICAgICAgIGJsZW5kTW9kZTogbm9kZS5ibGVuZE1vZGUgPz8gbnVsbCxcclxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50ID09PSB0cnVlLFxyXG4gICAgICAgIGNvcm5lclJhZGl1czogZmluaXRlT3JOdWxsKG5vZGUuY29ybmVyUmFkaXVzKSxcclxuICAgICAgICByZWN0YW5nbGVDb3JuZXJSYWRpaTogQXJyYXkuaXNBcnJheShub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpKVxyXG4gICAgICAgICAgICA/IG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IGZpbml0ZU9yTnVsbChyYWRpdXMpKVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgLy8g5ZyG5byn55qE6LW35q2i6KeS5LiO5YaF5Y2K5b6E5Y+q5pS55YOP57Sg77yM5LiN5pS55aSW5qGG77yb5LiN57qz5YWl5oyH57q55Lya5ryP5o6J5pW05bGC6IqC54K555qE5paw5b2i54q244CCXHJcbiAgICAgICAgYXJjRGF0YTogbm9kZS5hcmNEYXRhXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgc3RhcnRpbmdBbmdsZTogZmluaXRlT3JOdWxsKG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKSxcclxuICAgICAgICAgICAgICAgIGVuZGluZ0FuZ2xlOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmVuZGluZ0FuZ2xlKSxcclxuICAgICAgICAgICAgICAgIGlubmVyUmFkaXVzOiBmaW5pdGVPck51bGwobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgZmlsbHM6IChub2RlLmZpbGxzID8/IFtdKS5tYXAocGFpbnRQYXlsb2FkKSxcclxuICAgICAgICBzdHJva2VzOiAobm9kZS5zdHJva2VzID8/IFtdKS5tYXAocGFpbnRQYXlsb2FkKSxcclxuICAgICAgICBzdHJva2VXZWlnaHQ6IGZpbml0ZU9yTnVsbChub2RlLnN0cm9rZVdlaWdodCksXHJcbiAgICAgICAgc3Ryb2tlQWxpZ246IG5vZGUuc3Ryb2tlQWxpZ24gPz8gbnVsbCxcclxuICAgICAgICBlZmZlY3RzOiAobm9kZS5lZmZlY3RzID8/IFtdKS5tYXAoZWZmZWN0UGF5bG9hZCksXHJcbiAgICAgICAgY2hhcmFjdGVyczogdHlwZW9mIG5vZGUuY2hhcmFjdGVycyA9PT0gJ3N0cmluZycgPyBub2RlLmNoYXJhY3RlcnMgOiBudWxsLFxyXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFBheWxvYWQobm9kZS5zdHlsZSksXHJcbiAgICB9O1xyXG59XHJcblxyXG4vKiog5a2Q5qCR57uT5p6E77ya5pys6IqC54K55oyH57q5ICsg6YCQ5bGC5a2Q6IqC54K55oyH57q577yM55So5LqO5Yik5pat5riy5p+T5Z6L6IqC54K55piv5ZCm6ZyA6KaB6YeN5paw5Ye65Zu+44CCICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jU3VidHJlZVBheWxvYWQobm9kZTogRmlnbWFOb2RlKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2aXN1YWw6IHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpLFxyXG4gICAgICAgIGNoaWxkcmVuOiAobm9kZS5jaGlsZHJlbiA/PyBbXSkubWFwKChjaGlsZCkgPT4gc3luY1N1YnRyZWVQYXlsb2FkKGNoaWxkKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3luY1Zpc3VhbEhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNWaXN1YWxQYXlsb2FkKG5vZGUpKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDlj6rkv53nlZnlvbHlk43lg4/ntKDnmoTlsZ7mgKfvvJrlnZDmoIfmlLnkuLrnm7jlr7nmnKzoioLngrnljp/ngrnnmoTlgY/np7vvvIzlubbpgJLlvZLljIXlkKvmlbTmo7XlrZDmoJHjgIJcclxuICogLSDmlbTkuKroioLngrnlnKjpobXpnaLph4znp7vliqjvvJrmiYDmnInnm7jlr7nlnZDmoIfkuI3lj5gg4oaSIOWDj+e0oOaMh+e6ueS4jeWPmO+8m1xyXG4gKiAtIOWtkOWxguWcqOiKgueCueWGhemDqOenu+WKqO+8muebuOWvueWdkOagh+aUueWPmCDihpIg5YOP57Sg5oyH57q55pS55Y+Y77ybXHJcbiAqIC0g5bC65a+444CB5peL6L2s44CB5aSW6KeC44CB5paH5a2X5LiO5Lu75L2V5ZCO5Luj5Y+Y5YyW6YO96K6h5YWl44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3luY1BpeGVsUGF5bG9hZChcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIG9yaWdpbj86IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSxcclxuICAgIHJvb3QgPSB0cnVlLFxyXG4gICAgc3RyaXBHZW9tZXRyeSA9IGZhbHNlLFxyXG4gICAgc3RyaXBTY2FsZT86IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcclxuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgY29uc3QgdmlzdWFsID0gc3luY1Zpc3VhbFBheWxvYWQobm9kZSk7XHJcbiAgICBjb25zdCBib3ggPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBjb25zdCBiYXNlID0gb3JpZ2luID8/IHsgeDogYm94Py54ID8/IDAsIHk6IGJveD8ueSA/PyAwIH07XHJcbiAgICBjb25zdCByZWxhdGl2ZSA9IChmcmFtZTogbnVtYmVyW10gfCBudWxsKTogbnVtYmVyW10gfCBudWxsID0+IChmcmFtZVxyXG4gICAgICAgID8gW1xyXG4gICAgICAgICAgICBxdWFudGl6ZURlY2ltYWwoZnJhbWVbMF0gLSBiYXNlLngsIDQpLFxyXG4gICAgICAgICAgICBxdWFudGl6ZURlY2ltYWwoZnJhbWVbMV0gLSBiYXNlLnksIDQpLFxyXG4gICAgICAgICAgICBmcmFtZVsyXSxcclxuICAgICAgICAgICAgZnJhbWVbM10sXHJcbiAgICAgICAgXVxyXG4gICAgICAgIDogbnVsbCk7XHJcbiAgICAvLyDnuq/lm77niYfoioLngrnvvIzmiJZcIuWPquWMheedgOS4gOW8oOWQjOahhuWbvueJh1wi55qE5YyF6KOF5bGC77ya5L2N5Zu+5Y+v5Lul6KKrIFNwcml0ZSDnm7TmjqXmi4nkvLjvvIxcclxuICAgIC8vIOWwuuWvuOWPmOWMluS4jeaUueWPmOWDj+e0oOWGheWuue+8jOWboOatpOaVtOadoemTvueahOWHoOS9lemDveS4jeWPguS4juWDj+e0oOaMh+e6ueOAglxyXG4gICAgLy8g5YW25LuW5oOF5Ya177yI5pyJ5ZyG6KeSL+aPj+i+uS/nibnmlYjjgIHmiJblm77niYfkuI3mu6HmoYbvvInku43mjInljp/op4TliJnorqHnrpfjgIJcclxuICAgIGNvbnN0IHN0cmlwID0gc3RyaXBHZW9tZXRyeSB8fCAocm9vdCAmJiBpc1N0cmV0Y2hhYmxlSW1hZ2Uobm9kZSkpO1xyXG4gICAgY29uc3Qgc2NhbGUgPSBzdHJpcFNjYWxlID8/IChzdHJpcCAmJiBib3ggJiYgYm94LndpZHRoID4gMCAmJiBib3guaGVpZ2h0ID4gMFxyXG4gICAgICAgID8geyB3aWR0aDogYm94LndpZHRoLCBoZWlnaHQ6IGJveC5oZWlnaHQgfVxyXG4gICAgICAgIDogdW5kZWZpbmVkKTtcclxuICAgIC8vIEZpZ21hIOeahCBTY2FsZSDlt6XlhbflnKjnvKnmlL7lm77niYfoioLngrnml7bkvJrmlLnlhpnloavlhYXph4znmoToo4HliIfnn6npmLXjgILmjInoioLngrnlsLrlr7jlvZLkuIDljJblkI7vvIxcclxuICAgIC8vIOetieavlC/mjInovbTnvKnmlL7kuI3lho3nrpflj5jljJbvvJvnnJ/mraPnmoToo4HliIfosIPmlbTku43nhLbkvJrmlLnlj5jmjIfnurnjgIJcclxuICAgIGNvbnN0IHZpc3VhbEZpbGxzID0gc2NhbGVcclxuICAgICAgICA/IHtcclxuICAgICAgICAgICAgLi4udmlzdWFsLFxyXG4gICAgICAgICAgICBmaWxsczogKHZpc3VhbC5maWxscyBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4pLm1hcCgoZmlsbCkgPT5cclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZVBhaW50U2NhbGUoZmlsbCwgc2NhbGUpKSxcclxuICAgICAgICAgICAgc3Ryb2tlczogKHZpc3VhbC5zdHJva2VzIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PikubWFwKChmaWxsKSA9PlxyXG4gICAgICAgICAgICAgICAgbm9ybWFsaXplUGFpbnRTY2FsZShmaWxsLCBzY2FsZSkpLFxyXG4gICAgICAgIH1cclxuICAgICAgICA6IHZpc3VhbDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4udmlzdWFsRmlsbHMsXHJcbiAgICAgICAgc2l6ZTogc3RyaXAgPyBudWxsIDogdmlzdWFsRmlsbHMuc2l6ZSxcclxuICAgICAgICByb3RhdGlvbjogc3RyaXAgPyBudWxsIDogdmlzdWFsRmlsbHMucm90YXRpb24sXHJcbiAgICAgICAgZnJhbWU6IHN0cmlwID8gbnVsbCA6IHJlbGF0aXZlKHZpc3VhbEZpbGxzLmZyYW1lIGFzIG51bWJlcltdIHwgbnVsbCksXHJcbiAgICAgICAgcmVuZGVyQm91bmRzOiBzdHJpcCA/IG51bGwgOiByZWxhdGl2ZSh2aXN1YWxGaWxscy5yZW5kZXJCb3VuZHMgYXMgbnVtYmVyW10gfCBudWxsKSxcclxuICAgICAgICBjaGlsZHJlbjogKG5vZGUuY2hpbGRyZW4gPz8gW10pLm1hcCgoY2hpbGQpID0+IHN5bmNQaXhlbFBheWxvYWQoY2hpbGQsIGJhc2UsIGZhbHNlLCBzdHJpcCwgc2NhbGUpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKiDmiorlm77niYfoo4HliIfnn6npmLXmjInoioLngrnlsLrlr7jlvZLkuIDljJbvvIzkvb/nrYnmr5TnvKnmlL7kuI3mlLnlj5jnu5PmnpzjgIIgKi9cclxuZnVuY3Rpb24gbm9ybWFsaXplUGFpbnRTY2FsZShcclxuICAgIGZpbGw6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxyXG4gICAgc2NhbGU6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcclxuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gZmlsbC5pbWFnZVRyYW5zZm9ybTtcclxuICAgIGlmICghQXJyYXkuaXNBcnJheSh0cmFuc2Zvcm0pIHx8IHRyYW5zZm9ybS5sZW5ndGggIT09IDIpIHtcclxuICAgICAgICByZXR1cm4gZmlsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjYWxlZCA9IHRyYW5zZm9ybS5tYXAoKHJvdywgcm93SW5kZXgpID0+IChBcnJheS5pc0FycmF5KHJvdylcclxuICAgICAgICA/IHJvdy5tYXAoKHZhbHVlKSA9PiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpXHJcbiAgICAgICAgICAgID8gcXVhbnRpemVEZWNpbWFsKHZhbHVlIC8gKHJvd0luZGV4ID09PSAwID8gc2NhbGUud2lkdGggOiBzY2FsZS5oZWlnaHQpLCA0KVxyXG4gICAgICAgICAgICA6IHZhbHVlKSlcclxuICAgICAgICA6IHJvdykpO1xyXG4gICAgcmV0dXJuIHsgLi4uZmlsbCwgaW1hZ2VUcmFuc2Zvcm06IHNjYWxlZCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZXNFcXVhbChsZWZ0OiBSZWN0IHwgdW5kZWZpbmVkLCByaWdodDogUmVjdCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFsZWZ0IHx8ICFyaWdodCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IG5lYXIgPSAoYTogbnVtYmVyLCBiOiBudW1iZXIpID0+IE1hdGguYWJzKGEgLSBiKSA8PSAwLjAxO1xyXG4gICAgcmV0dXJuIG5lYXIobGVmdC54LCByaWdodC54KSAmJiBuZWFyKGxlZnQueSwgcmlnaHQueSlcclxuICAgICAgICAmJiBuZWFyKGxlZnQud2lkdGgsIHJpZ2h0LndpZHRoKSAmJiBuZWFyKGxlZnQuaGVpZ2h0LCByaWdodC5oZWlnaHQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNPd25WaXN1YWwobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoKG5vZGUuZmlsbHMgPz8gW10pLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuc3Ryb2tlcyA/PyBbXSkuc29tZSgoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuZWZmZWN0cyA/PyBbXSkuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuY29ybmVyUmFkaXVzID8/IDApID4gMCkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpID8/IFtdKS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDApO1xyXG59XHJcblxyXG4vKipcclxuICog5Y+v6KKrIFNwcml0ZSDnm7TmjqXmi4nkvLjnmoTlm77niYfnu5PmnoTvvJpcclxuICogLSDoh6rouqvlsLHmmK/nuq/lm77niYfoioLngrnvvJvmiJZcclxuICogLSDoh6rouqvmsqHmnInku7vkvZXloavlhYUv5o+P6L65L+eJueaViC/lnIbop5LvvIzlj6rljIXnnYDkuIDlsYLmiJblpJrlsYLnqbrlrrnlmajvvIxcclxuICogICDmnIDlhoXlsYLmmK/nuq/lm77niYfoioLngrnvvIzkuJTkuI7mnIDlpJblsYLlrozlhajlkIzmoYbvvIjov5nmraPmmK/ljZXlm77niYfmipjlj6DnmoTlvaLmgIHvvInjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cmV0Y2hhYmxlSW1hZ2Uobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICAvLyDkuIkv5Lmd5a6r6IqC54K577ya5ouJ5Ly455SxIENvY29zIOeahCBTTElDRUQgU3ByaXRlIOWujOaIkO+8jOWwuuWvuOWPmOWMluS4jemcgOimgemHjeaWsOWHuuWbvuOAglxyXG4gICAgLy8g5Y+q6K6k5Yeg5L2V6K+G5Yir6YCa6L+H55qE57uT5p6E77yM5ZG95ZCN5YOP5YiH54mH5L2G5Yeg5L2V5LiN5oiQ56uL55qE6IqC54K55LuN5oyJ5pmu6YCa5Zu+54mH5aSE55CG44CCXHJcbiAgICBpZiAoYW5hbHl6ZVNsaWNlR3JpZChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzUGxhaW5JbWFnZU5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJvb3RCb3ggPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBpZiAoIXJvb3RCb3ggfHwgaGFzT3duVmlzdWFsKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgbGV0IGN1cnJlbnQ6IEZpZ21hTm9kZSA9IG5vZGU7XHJcbiAgICBmb3IgKGxldCBkZXB0aCA9IDA7IGRlcHRoIDwgODsgZGVwdGggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gY3VycmVudC5jaGlsZHJlbiA/PyBbXTtcclxuICAgICAgICBpZiAoIWNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBjaGlsZHJlblswXTtcclxuICAgICAgICBpZiAoaXNQbGFpbkltYWdlTm9kZShjaGlsZCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZyYW1lc0VxdWFsKHJvb3RCb3gsIGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzT3duVmlzdWFsKGNoaWxkKSB8fCBjaGlsZC5hcmNEYXRhIHx8IGNoaWxkLmNsaXBzQ29udGVudCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGN1cnJlbnQgPSBjaGlsZDtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOe6r+WbvueJh+iKgueCue+8muWNleS4quWPr+ingSBJTUFHRSDloavlhYXjgIHml6Dmj4/ovrkv54m55pWIL+Wchuinki/oo4Hliaov5ZyG5byn44CB5peg5a2Q5bGC44CCXHJcbiAqIOi/meexu+iKgueCueeahOS9jeWbvuWPr+S7peiiqyBTcHJpdGUg55u05o6l5ouJ5Ly477yM5pS55Y+Y5bC65a+45oiW5peL6L2s5LiN6ZyA6KaB6YeN5paw5Ye65Zu+44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNQbGFpbkltYWdlTm9kZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmIChub2RlLmNoaWxkcmVuPy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5jbGlwc0NvbnRlbnQgfHwgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKChub2RlLmNvcm5lclJhZGl1cyA/PyAwKSA+IDAgfHwgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgPz8gW10pLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMCkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAoKG5vZGUuc3Ryb2tlcyA/PyBbXSkuc29tZSgoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKChub2RlLmVmZmVjdHMgPz8gW10pLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVGaWxscyA9IChub2RlLmZpbGxzID8/IFtdKS5maWx0ZXIoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgcmV0dXJuIHZpc2libGVGaWxscy5sZW5ndGggPT09IDFcclxuICAgICAgICAmJiB2aXNpYmxlRmlsbHNbMF0udHlwZSA9PT0gJ0lNQUdFJ1xyXG4gICAgICAgICYmIEJvb2xlYW4odmlzaWJsZUZpbGxzWzBdLmltYWdlUmVmKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNQaXhlbEhhc2gobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzaGEyNTYoY2Fub25pY2FsU3RyaW5naWZ5KHN5bmNQaXhlbFBheWxvYWQobm9kZSkpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdWJ0cmVlSGFzaChub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNoYTI1NihjYW5vbmljYWxTdHJpbmdpZnkoc3luY1N1YnRyZWVQYXlsb2FkKG5vZGUpKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xyXG4gICAgY29uc3QgaWRzID0gWy4uLm5ldyBTZXQoYWxpYXNOb2RlSWRzLm1hcChub3JtYWxpemVTeW5jTm9kZUlkKS5maWx0ZXIoQm9vbGVhbikpXS5zb3J0KCk7XHJcbiAgICByZXR1cm4gc2hhMjU2KGNhbm9uaWNhbFN0cmluZ2lmeShpZHMpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNGaWxlSGFzaChmaWxlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3Qgbm9ybWFsaXplZCA9IGZpbGVLZXkudHJpbSgpO1xyXG4gICAgaWYgKCFub3JtYWxpemVkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnu4Tku7blkIzmraXnvLrlsJEgRmlnbWEgZmlsZSBrZXnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBzaGEyNTYoYGZpZ21hLWltcG9ydGVyOnN5bmMtZmlsZTp2MVxcMCR7bm9ybWFsaXplZH1gKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVN5bmNNYXJrZXIoaW5wdXQ6IFN5bmNNYXJrZXJJbnB1dCk6IFN5bmNNYXJrZXJTcGVjIHtcclxuICAgIGNvbnN0IG5vZGVJZCA9IG5vcm1hbGl6ZVN5bmNOb2RlSWQoaW5wdXQubm9kZS5pZCk7XHJcbiAgICBpZiAoIW5vZGVJZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign57uE5Lu25ZCM5q2l6IqC54K557y65bCRIEZpZ21hIOiKgueCuSBpZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gWy4uLm5ldyBTZXQoKGlucHV0LmFsaWFzTm9kZUlkcyA/PyBbXSlcclxuICAgICAgICAubWFwKG5vcm1hbGl6ZVN5bmNOb2RlSWQpXHJcbiAgICAgICAgLmZpbHRlcigoaWQpID0+IEJvb2xlYW4oaWQpICYmIGlkICE9PSBub2RlSWQpKV0uc29ydCgpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzY2hlbWE6IGlucHV0LnNjaGVtYSA/PyBTWU5DX01BUktFUl9TQ0hFTUEsXHJcbiAgICAgICAgZmlnbWFGaWxlSGFzaDogc3luY0ZpbGVIYXNoKGlucHV0LmZpbGVLZXkpLFxyXG4gICAgICAgIGZpZ21hTm9kZUlkOiBub2RlSWQsXHJcbiAgICAgICAgYWxpYXNOb2RlSWRzLFxyXG4gICAgICAgIGFsaWFzSGFzaDogc3luY0FsaWFzSGFzaChhbGlhc05vZGVJZHMpLFxyXG4gICAgICAgIHZpc3VhbEhhc2g6IHN5bmNWaXN1YWxIYXNoKGlucHV0Lm5vZGUpLFxyXG4gICAgICAgIHBpeGVsSGFzaDogc3luY1BpeGVsSGFzaChpbnB1dC5ub2RlKSxcclxuICAgICAgICBzdWJ0cmVlSGFzaDogc3luY1N1YnRyZWVIYXNoKGlucHV0Lm5vZGUpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNvbXBhcmVTeW5jTWFya2VyKFxyXG4gICAgcHJldmlvdXM6IFN5bmNNYXJrZXJTcGVjLFxyXG4gICAgbmV4dDogU3luY01hcmtlclNwZWMsXHJcbik6IFN5bmNNYXJrZXJDb21wYXJpc29uIHtcclxuICAgIGNvbnN0IHZpc3VhbENoYW5nZWQgPSBwcmV2aW91cy52aXN1YWxIYXNoICE9PSBuZXh0LnZpc3VhbEhhc2g7XHJcbiAgICBjb25zdCBzdWJ0cmVlQ2hhbmdlZCA9IHByZXZpb3VzLnN1YnRyZWVIYXNoICE9PSBuZXh0LnN1YnRyZWVIYXNoO1xyXG4gICAgY29uc3Qgc3RydWN0dXJlQ2hhbmdlZCA9IHByZXZpb3VzLmFsaWFzSGFzaCAhPT0gbmV4dC5hbGlhc0hhc2hcclxuICAgICAgICB8fCBwcmV2aW91cy5hbGlhc05vZGVJZHMuam9pbignLCcpICE9PSBuZXh0LmFsaWFzTm9kZUlkcy5qb2luKCcsJyk7XHJcbiAgICBjb25zdCBzb3VyY2VDaGFuZ2VkID0gcHJldmlvdXMuZmlnbWFGaWxlSGFzaCAhPT0gbmV4dC5maWdtYUZpbGVIYXNoXHJcbiAgICAgICAgfHwgcHJldmlvdXMuZmlnbWFOb2RlSWQgIT09IG5leHQuZmlnbWFOb2RlSWQ7XHJcbiAgICAvLyDlg4/ntKDmmK/lkKblj5jljJbvvJrkuKTovrnpg73mnInlg4/ntKDmjIfnurnml7bnlKjlroPvvIjkuI3lkKvpobXpnaLlnZDmoIfvvInvvJtcclxuICAgIC8vIOaXp+agh+iusOayoeacieivpeWtl+auteaXtumAgOWbnuWtkOagkeaMh+e6ue+8jOWugeWPr+WkmuWIpOS4gOasoei/h+acn++8jOS5n+S4jeiDvea8j+aOieecn+WunuaUueWKqOOAglxyXG4gICAgY29uc3QgcGl4ZWxDb21wYXJhYmxlID0gdHlwZW9mIHByZXZpb3VzLnBpeGVsSGFzaCA9PT0gJ3N0cmluZydcclxuICAgICAgICAmJiB0eXBlb2YgbmV4dC5waXhlbEhhc2ggPT09ICdzdHJpbmcnO1xyXG4gICAgY29uc3QgcGl4ZWxDaGFuZ2VkID0gcGl4ZWxDb21wYXJhYmxlXHJcbiAgICAgICAgPyBwcmV2aW91cy5waXhlbEhhc2ggIT09IG5leHQucGl4ZWxIYXNoXHJcbiAgICAgICAgOiBzdWJ0cmVlQ2hhbmdlZDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdmlzdWFsQ2hhbmdlZCxcclxuICAgICAgICBwaXhlbENoYW5nZWQsXHJcbiAgICAgICAgc3VidHJlZUNoYW5nZWQsXHJcbiAgICAgICAgc3RydWN0dXJlQ2hhbmdlZCxcclxuICAgICAgICAvLyDlj6rmlLnkvY3nva7kuI3lho3opoHmsYLph43mlrDlh7rlm77vvJvmnaXmupDjgIHlg4/ntKDmiJbmipjlj6Dnu5PmnoTlj5jljJbmiY3pnIDopoHjgIJcclxuICAgICAgICBhc3NldFN0YWxlOiBwaXhlbENoYW5nZWQgfHwgc3RydWN0dXJlQ2hhbmdlZCB8fCBzb3VyY2VDaGFuZ2VkLFxyXG4gICAgfTtcclxufVxyXG5cclxuLyoqIOWIpOaWreS4gOS4quS4jemAj+aYjuinhuinieiKgueCue+8iOefoumHjy/mlbTlsYIgUE5HL+aKmOWPoOWMheijhe+8ieaYr+WQpumcgOimgemHjeaWsOeUn+aIkOWbvueJh+OAgiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3luY05lZWRzQXNzZXRSZWZyZXNoKG9wdGlvbnM6IHtcclxuICAgIGNvbXBhcmlzb246IFN5bmNNYXJrZXJDb21wYXJpc29uO1xyXG4gICAgLyoqIOW9k+WJjeiKgueCueaYr+WQpuS7pSBQTkcg5b2i5byP6JC95Zyw77yI5pW05bGCIHJlbmRlcuOAgeefoumHj+OAgeaKmOWPoCBTcHJpdGUvTGFiZWzvvInjgIIgKi9cclxuICAgIHJhc3Rlcml6ZWQ6IGJvb2xlYW47XHJcbn0pOiBib29sZWFuIHtcclxuICAgIGlmICghb3B0aW9ucy5yYXN0ZXJpemVkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG9wdGlvbnMuY29tcGFyaXNvbi5hc3NldFN0YWxlO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFya2VyVG9Db21wb25lbnRWYWx1ZXMobWFya2VyOiBTeW5jTWFya2VyU3BlYyk6IFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXMge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYU1hcmtlclNjaGVtYTogbWFya2VyLnNjaGVtYSxcclxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBtYXJrZXIuZmlnbWFGaWxlSGFzaCxcclxuICAgICAgICBmaWdtYU5vZGVJZDogbWFya2VyLmZpZ21hTm9kZUlkLFxyXG4gICAgICAgIGZpZ21hQWxpYXNOb2RlSWRzOiBtYXJrZXIuYWxpYXNOb2RlSWRzLmpvaW4oJywnKSxcclxuICAgICAgICBmaWdtYUFsaWFzSGFzaDogbWFya2VyLmFsaWFzSGFzaCxcclxuICAgICAgICBmaWdtYVZpc3VhbEhhc2g6IG1hcmtlci52aXN1YWxIYXNoLFxyXG4gICAgICAgIGZpZ21hUGl4ZWxIYXNoOiBtYXJrZXIucGl4ZWxIYXNoID8/ICcnLFxyXG4gICAgICAgIGZpZ21hU3VidHJlZUhhc2g6IG1hcmtlci5zdWJ0cmVlSGFzaCxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDliKTmlq3kuIDkuKrnu4Tku7blrp7kvovmmK/lkKbmmK/mnKzmj5Lku7bnlJ/miJDnmoTlkIzmraXmoIforrDjgIJcclxuICog55So5LqO5omA5pyJ5p2D5Yik5a6a77ya5qCH6K6w5rC46L+c5bGe5LqO5o+S5Lu277yM5LiN6IO9566X5L2cXCLmiYvlt6Xnu4Tku7ZcIumYu+atouiKgueCueWIoOmZpOOAglxyXG4gKiDmjInlrZfmrrXor4bliKvvvIzkuI3kvp3otZbohJrmnKwgVVVJRCDigJTigJQg6ISa5pys6YeN5paw5a+85YWl5oiWIFVVSUQg5Y+Y5YyW5pe25LuN54S25oiQ56uL44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTeW5jTWFya2VyQ29tcG9uZW50VmFsdWUodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlY29yZCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgcmV0dXJuIHJlY29yZC5maWdtYU1hcmtlclNjaGVtYSA9PT0gU1lOQ19NQVJLRVJfU0NIRU1BXHJcbiAgICAgICAgJiYgdHlwZW9mIHJlY29yZC5maWdtYU5vZGVJZCA9PT0gJ3N0cmluZydcclxuICAgICAgICAmJiByZWNvcmQuZmlnbWFOb2RlSWQubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHR5cGVvZiByZWNvcmQuZmlnbWFWaXN1YWxIYXNoID09PSAnc3RyaW5nJztcclxufVxyXG5cclxuLyoqIOS7jiBDb2NvcyDnu4Tku7bor7vlm57moIforrDvvJvlrZfmrrXnvLrlpLHmiJbmjZ/lnY/ml7bov5Tlm54gbnVsbO+8jOeUseiwg+eUqOaWuSBmYWlsLWNsb3NlZOOAgiAqL2V4cG9ydCBmdW5jdGlvbiBtYXJrZXJGcm9tQ29tcG9uZW50VmFsdWVzKFxyXG4gICAgdmFsdWVzOiBQYXJ0aWFsPFN5bmNNYXJrZXJDb21wb25lbnRWYWx1ZXM+IHwgbnVsbCB8IHVuZGVmaW5lZCxcclxuKTogU3luY01hcmtlclNwZWMgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWVzIHx8IHR5cGVvZiB2YWx1ZXMgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY2hlbWEgPSB2YWx1ZXMuZmlnbWFNYXJrZXJTY2hlbWE7XHJcbiAgICBpZiAoc2NoZW1hICE9PSBTWU5DX01BUktFUl9TQ0hFTUEpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVIYXNoID0gdmFsdWVzLmZpZ21hRmlsZUhhc2g7XHJcbiAgICBjb25zdCBub2RlSWQgPSB0eXBlb2YgdmFsdWVzLmZpZ21hTm9kZUlkID09PSAnc3RyaW5nJyA/IG5vcm1hbGl6ZVN5bmNOb2RlSWQodmFsdWVzLmZpZ21hTm9kZUlkKSA6ICcnO1xyXG4gICAgY29uc3QgdmlzdWFsSGFzaCA9IHZhbHVlcy5maWdtYVZpc3VhbEhhc2g7XHJcbiAgICBjb25zdCBzdWJ0cmVlSGFzaCA9IHZhbHVlcy5maWdtYVN1YnRyZWVIYXNoO1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QoZmlsZUhhc2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIW5vZGVJZCB8fCB0eXBlb2YgdmlzdWFsSGFzaCAhPT0gJ3N0cmluZycgfHwgIVNIQTI1Nl9QQVRURVJOLnRlc3QodmlzdWFsSGFzaCkpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2Ygc3VidHJlZUhhc2ggIT09ICdzdHJpbmcnIHx8ICFTSEEyNTZfUEFUVEVSTi50ZXN0KHN1YnRyZWVIYXNoKSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxpYXNOb2RlSWRzID0gdHlwZW9mIHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcyA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IHZhbHVlcy5maWdtYUFsaWFzTm9kZUlkcy5zcGxpdCgnLCcpXHJcbiAgICAgICAgICAgIC5tYXAoKGlkKSA9PiBub3JtYWxpemVTeW5jTm9kZUlkKGlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgICAgICAuc29ydCgpXHJcbiAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGFsaWFzSGFzaCA9IHR5cGVvZiB2YWx1ZXMuZmlnbWFBbGlhc0hhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hQWxpYXNIYXNoKVxyXG4gICAgICAgID8gdmFsdWVzLmZpZ21hQWxpYXNIYXNoXHJcbiAgICAgICAgOiBzeW5jQWxpYXNIYXNoKGFsaWFzTm9kZUlkcyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjaGVtYSxcclxuICAgICAgICBmaWdtYUZpbGVIYXNoOiBmaWxlSGFzaCxcclxuICAgICAgICBmaWdtYU5vZGVJZDogbm9kZUlkLFxyXG4gICAgICAgIGFsaWFzTm9kZUlkcyxcclxuICAgICAgICBhbGlhc0hhc2gsXHJcbiAgICAgICAgdmlzdWFsSGFzaCxcclxuICAgICAgICBwaXhlbEhhc2g6IHR5cGVvZiB2YWx1ZXMuZmlnbWFQaXhlbEhhc2ggPT09ICdzdHJpbmcnICYmIFNIQTI1Nl9QQVRURVJOLnRlc3QodmFsdWVzLmZpZ21hUGl4ZWxIYXNoKVxyXG4gICAgICAgICAgICA/IHZhbHVlcy5maWdtYVBpeGVsSGFzaFxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICBzdWJ0cmVlSGFzaCxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDkuIDkuKogRmlnbWEg6IqC54K55Y+q6IO96KKr5LiA5LiqIENvY29zIOiKgueCueWjsOaYju+8iOiHquW3seaIluS9nOS4uuWIq+WQje+8ieOAglxyXG4gKiDmipjlj6DniLblrZDlkIzml7blo7DmmI7lkIzmupDoioLngrnkvJrorqlcIuaUueWTquS4quiKgueCuVwi5Y+Y5b6X5LiN5Y+v5Yik5a6a44CCXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0VW5pcXVlU3luY093bmVyc2hpcChtYXJrZXJzOiByZWFkb25seSBTeW5jTWFya2VyU3BlY1tdKTogdm9pZCB7XHJcbiAgICBjb25zdCBvd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xyXG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIFttYXJrZXIuZmlnbWFOb2RlSWQsIC4uLm1hcmtlci5hbGlhc05vZGVJZHNdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG93bmVyID0gb3duZXJzLmdldChub2RlSWQpO1xyXG4gICAgICAgICAgICBpZiAob3duZXIgJiYgb3duZXIgIT09IG1hcmtlci5maWdtYU5vZGVJZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGBGaWdtYSDoioLngrkgJHtub2RlSWR9IOWQjOaXtuiiqyAke293bmVyfSDlkowgJHttYXJrZXIuZmlnbWFOb2RlSWR9IOWjsOaYju+8jOW3suaLkue7neeUn+aIkOWQjOatpeagh+iusOOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG93bmVycy5zZXQobm9kZUlkLCBtYXJrZXIuZmlnbWFOb2RlSWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuLyoqIOmcgOimgeWcqOmhueebriBhc3NldHMg5Lit55Sf5oiQ55qE5pyA5bCP5qCH6K6w57uE5Lu25rqQ56CB77yI5peg5Lia5Yqh6YC76L6R77yM5Y+q5L+d5a2Y5p2l5rqQ5LiO5oyH57q577yJ44CCICovXHJcbmV4cG9ydCBjb25zdCBTWU5DX01BUktFUl9TQ1JJUFRfU09VUkNFID0gYGltcG9ydCB7IF9kZWNvcmF0b3IsIENvbXBvbmVudCB9IGZyb20gJ2NjJztcclxuXHJcbmNvbnN0IHsgY2NjbGFzcywgcHJvcGVydHkgfSA9IF9kZWNvcmF0b3I7XHJcblxyXG4vKipcclxuICogRmlnbWEgSW1wb3J0ZXIg55Sf5oiQ55qE5ZCM5q2l5qCH6K6w44CC5a2X5q6155Sx5o+S5Lu257u05oqk77yM5omL5bel5L+u5pS55Lya5a+86Ie05LiL5qyh5ZCM5q2l6KKr5ouS57ud44CCXHJcbiAqIOWIoOmZpOacrOe7hOS7tuWNs+ihqOekuuivpeiKgueCuemAgOWHuiBGaWdtYSDlkIzmraXvvJrmj5Lku7bkuI3kvJrlho3np7vliqjjgIHnvKnmlL7miJbliKDpmaTlroPjgIJcclxuICovXHJcbkBjY2NsYXNzKCcke1NZTkNfTUFSS0VSX0NMQVNTfScpXHJcbmV4cG9ydCBjbGFzcyAke1NZTkNfTUFSS0VSX0NMQVNTfSBleHRlbmRzIENvbXBvbmVudCB7XHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5qCH6K6w5Y2P6K6u54mI5pysJyB9KVxyXG4gICAgcHVibGljIGZpZ21hTWFya2VyU2NoZW1hOiBudW1iZXIgPSAke1NZTkNfTUFSS0VSX1NDSEVNQX07XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOaWh+S7tiBrZXkg55qEIFNIQS0yNTYnIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFGaWxlSGFzaDogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ0ZpZ21hIOiKgueCuSBpZCcgfSlcclxuICAgIHB1YmxpYyBmaWdtYU5vZGVJZDogc3RyaW5nID0gJyc7XHJcblxyXG4gICAgQHByb3BlcnR5KHsgdG9vbHRpcDogJ+iiq+aKmOWPoOWIsOacrOiKgueCueeahCBGaWdtYSDlrZDlsYIgaWTvvIzpgJflj7fliIbpmpQnIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFBbGlhc05vZGVJZHM6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmipjlj6DlrZDlsYLpm4blkIjmjIfnurknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFBbGlhc0hhc2g6IHN0cmluZyA9ICcnO1xyXG5cclxuICAgIEBwcm9wZXJ0eSh7IHRvb2x0aXA6ICfmnKzmrKHlr7zlhaXml7bnmoToioLngrnop4bop4nmjIfnurknIH0pXHJcbiAgICBwdWJsaWMgZmlnbWFWaXN1YWxIYXNoOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5YOP57Sg5oyH57q577yI5LiN5ZCr6aG16Z2i5Z2Q5qCH77yJJyB9KVxyXG4gICAgcHVibGljIGZpZ21hUGl4ZWxIYXNoOiBzdHJpbmcgPSAnJztcclxuXHJcbiAgICBAcHJvcGVydHkoeyB0b29sdGlwOiAn5pys5qyh5a+85YWl5pe255qE5a2Q5qCR5oyH57q5JyB9KVxyXG4gICAgcHVibGljIGZpZ21hU3VidHJlZUhhc2g6IHN0cmluZyA9ICcnO1xyXG59XHJcbmA7XHJcblxyXG4vKiog6aqM6K+B55Sf5oiQ5Yiw6aG555uu6YeM55qE6ISa5pys5rKh5pyJ6KKr5oiq5pat5oiW6KKr5pS55oiQ5Yir55qE57G744CCICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N5bmNNYXJrZXJTY3JpcHQoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIHJldHVybiB0eXBlb2Ygc291cmNlID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgQGNjY2xhc3MoJyR7U1lOQ19NQVJLRVJfQ0xBU1N9JylgKVxyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcyhgY2xhc3MgJHtTWU5DX01BUktFUl9DTEFTU30gZXh0ZW5kcyBDb21wb25lbnRgKVxyXG4gICAgICAgICYmIHNvdXJjZS5pbmNsdWRlcygnZmlnbWFTdWJ0cmVlSGFzaCcpO1xyXG59XHJcbiJdfQ==