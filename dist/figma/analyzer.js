"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVectorNode = isVectorNode;
exports.isStructuredNodeName = isStructuredNodeName;
exports.isNamedSliceGroup = isNamedSliceGroup;
exports.hasManualExport = hasManualExport;
exports.tiledPaintSource = tiledPaintSource;
exports.hasTiledImageFill = hasTiledImageFill;
exports.plainImageSourceRef = plainImageSourceRef;
exports.nativeTiledPaintSource = nativeTiledPaintSource;
exports.inferCocosLayoutMode = inferCocosLayoutMode;
exports.inferKind = inferKind;
exports.hasIndependentSliceDescendant = hasIndependentSliceDescendant;
exports.shouldMergeResourceNode = shouldMergeResourceNode;
exports.inferAction = inferAction;
exports.hasHiddenDescendant = hasHiddenDescendant;
exports.shouldRenderMessySubtree = shouldRenderMessySubtree;
exports.isPatchCandidate = isPatchCandidate;
exports.analyzeTree = analyzeTree;
const slicing_1 = require("./slicing");
const import_actions_1 = require("../import-actions");
const CONTAINER_TYPES = new Set([
    'DOCUMENT',
    'CANVAS',
    'FRAME',
    'GROUP',
    'SECTION',
    'COMPONENT',
    'COMPONENT_SET',
    'INSTANCE',
]);
const VECTOR_TYPES = new Set([
    'VECTOR',
    'BOOLEAN_OPERATION',
    'STAR',
    'LINE',
    'REGULAR_POLYGON',
    // Figma represents basic shape layers as vector geometry too. Keeping
    // them in the raster path prevents cc.Graphics from approximating them.
    'RECTANGLE',
    'ELLIPSE',
]);
const SLICE_RECTANGLE_NAME = /^Rectangle(?:[\s_-]*\d+)?$/i;
const STRUCTURED_NODE_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
const SEMANTIC_NODE_NAME = /^(?:panel|list|layout|btn|button|img|image|icon|bg|sprite|txt|text|label)_[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*$/iu;
const RUNTIME_ROLE_NAME = /^(?:panel|list|layout|btn|button|txt|text|label)_[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*$/iu;
const EXACT_SEMANTIC_NAMES = new Set(['view', 'content']);
const FIGMA_SCROLL_DIRECTIONS = new Set([
    'HORIZONTAL_SCROLLING',
    'VERTICAL_SCROLLING',
    'HORIZONTAL_AND_VERTICAL_SCROLLING',
    'HORIZONTAL',
    'VERTICAL',
    'BOTH',
]);
function isVectorNode(node) {
    return VECTOR_TYPES.has(node.type);
}
function isStructuredNodeName(name) {
    if (name !== name.trim()) {
        return false;
    }
    return EXACT_SEMANTIC_NAMES.has(name.toLowerCase())
        || STRUCTURED_NODE_NAME.test(name)
        || SEMANTIC_NODE_NAME.test(name);
}
function isNamedSliceGroup(node) {
    return (node.children.length === 3 || node.children.length === 9)
        && node.children.every((child) => SLICE_RECTANGLE_NAME.test(child.name.trim()));
}
function hasManualExport(node) {
    return node.hasExportSettings;
}
function hasVisibleImage(node) {
    return node.fills.some((fill) => fill.visible !== false
        && (fill.type === 'IMAGE' || fill.type === 'PATTERN'));
}
function tiledPaintSource(node) {
    var _a, _b;
    for (const fill of node.fills) {
        if (fill.visible === false || ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) <= 0) {
            continue;
        }
        const scale = typeof fill.scalingFactor === 'number'
            && Number.isFinite(fill.scalingFactor)
            && fill.scalingFactor > 0
            ? fill.scalingFactor
            : 1;
        if (fill.type === 'PATTERN' && fill.sourceNodeId) {
            return { kind: 'source-node', id: fill.sourceNodeId, scale };
        }
        if (fill.type === 'IMAGE'
            && ((_b = fill.scaleMode) === null || _b === void 0 ? void 0 : _b.toUpperCase()) === 'TILE'
            && fill.imageRef) {
            return { kind: 'image-ref', id: fill.imageRef, scale };
        }
    }
    return undefined;
}
function hasTiledImageFill(node) {
    return Boolean(tiledPaintSource(node));
}
const RAW_IMAGE_CONTAINER_TYPES = new Set([
    'FRAME',
    'GROUP',
    'COMPONENT',
    'INSTANCE',
]);
function hasVisibleStrokeOrEffect(node) {
    return (node.strokeWeight > 0 && node.strokes.some((stroke) => { var _a; return stroke.visible !== false && ((_a = stroke.opacity) !== null && _a !== void 0 ? _a : 1) > 0; }))
        || node.effects.some((effect) => effect.visible !== false);
}
function framesMatch(left, right) {
    const a = left.absoluteBoundingBox;
    const b = right.absoluteBoundingBox;
    if (!a || !b)
        return false;
    const epsilon = 0.5;
    return Math.abs(a.x - b.x) <= epsilon
        && Math.abs(a.y - b.y) <= epsilon
        && Math.abs(a.width - b.width) <= epsilon
        && Math.abs(a.height - b.height) <= epsilon;
}
/**
 * Returns the original IMAGE paint for a visually plain image node/subtree.
 * This is used for effectively-hidden layers because Figma's rendered-image
 * endpoint produces a transparent PNG when any ancestor is hidden. Downloading
 * the source IMAGE paint is visibility-independent and preserves its pixels.
 */
function plainImageSourceRef(node) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
    const transform = node.relativeTransform;
    if (Math.abs(node.rotation) > 0.0001 || node.clipsContent
        || (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode))
        || (transform && (transform.length !== 2
            || ![(_a = transform[0]) === null || _a === void 0 ? void 0 : _a[0], (_b = transform[0]) === null || _b === void 0 ? void 0 : _b[1], (_c = transform[1]) === null || _c === void 0 ? void 0 : _c[0], (_d = transform[1]) === null || _d === void 0 ? void 0 : _d[1]].every(Number.isFinite)
            || Math.abs(((_e = transform[0]) === null || _e === void 0 ? void 0 : _e[0]) - 1) > 0.0001 || Math.abs((_f = transform[0]) === null || _f === void 0 ? void 0 : _f[1]) > 0.0001
            || Math.abs((_g = transform[1]) === null || _g === void 0 ? void 0 : _g[0]) > 0.0001 || Math.abs(((_h = transform[1]) === null || _h === void 0 ? void 0 : _h[1]) - 1) > 0.0001))
        || [(_j = node.cornerRadius) !== null && _j !== void 0 ? _j : 0, ...((_k = node.rectangleCornerRadii) !== null && _k !== void 0 ? _k : [])].some((radius) => radius > 0)) {
        return undefined;
    }
    const visibleFills = node.fills.filter((fill) => { var _a; return fill.visible !== false && ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const noOwnVisual = visibleFills.length === 0 && !hasVisibleStrokeOrEffect(node);
    if (node.type === 'RECTANGLE' && node.children.length === 0) {
        if (visibleFills.length !== 1 || hasVisibleStrokeOrEffect(node))
            return undefined;
        const fill = visibleFills[0];
        const mode = (_m = (_l = fill.scaleMode) === null || _l === void 0 ? void 0 : _l.toUpperCase()) !== null && _m !== void 0 ? _m : 'FILL';
        const radii = (_o = node.rectangleCornerRadii) !== null && _o !== void 0 ? _o : [(_p = node.cornerRadius) !== null && _p !== void 0 ? _p : 0, (_q = node.cornerRadius) !== null && _q !== void 0 ? _q : 0, (_r = node.cornerRadius) !== null && _r !== void 0 ? _r : 0, (_s = node.cornerRadius) !== null && _s !== void 0 ? _s : 0];
        return fill.type === 'IMAGE'
            && Boolean(fill.imageRef)
            && ['FILL', 'FIT'].includes(mode)
            && fill.imageTransform === undefined
            && (!fill.filters || Object.values(fill.filters).every((value) => value === 0))
            && ((_t = fill.opacity) !== null && _t !== void 0 ? _t : 1) === 1
            && Math.abs((_u = fill.rotation) !== null && _u !== void 0 ? _u : 0) <= 1e-6
            && (!fill.blendMode || ['NORMAL', 'PASS_THROUGH'].includes(fill.blendMode))
            && radii.every((radius) => radius <= 1e-6)
            ? fill.imageRef
            : undefined;
    }
    if (!RAW_IMAGE_CONTAINER_TYPES.has(node.type)
        || node.children.length !== 1
        || !noOwnVisual
        || node.opacity < 0.999) {
        return undefined;
    }
    const child = node.children[0];
    return child.visible !== false && !child.isMask && framesMatch(node, child)
        ? plainImageSourceRef(child) : undefined;
}
/**
 * A native tiled Sprite represents exactly one paint. Layers with additional
 * visuals or descendants must stay on the whole-node raster path.
 */
function nativeTiledPaintSource(node) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const source = tiledPaintSource(node);
    if (!source || node.hasExportSettings || node.children.length > 0) {
        return undefined;
    }
    if (node.type !== 'ELLIPSE' && node.type !== 'RECTANGLE') {
        return undefined;
    }
    if (node.type === 'ELLIPSE' && node.arcData) {
        const sweep = Math.abs(node.arcData.endingAngle - node.arcData.startingAngle);
        if (node.arcData.innerRadius > 1e-6 || sweep < Math.PI * 2 - 1e-6) {
            return undefined;
        }
    }
    if (node.type === 'RECTANGLE') {
        const radii = (_a = node.rectangleCornerRadii) !== null && _a !== void 0 ? _a : [
            (_b = node.cornerRadius) !== null && _b !== void 0 ? _b : 0,
            (_c = node.cornerRadius) !== null && _c !== void 0 ? _c : 0,
            (_d = node.cornerRadius) !== null && _d !== void 0 ? _d : 0,
            (_e = node.cornerRadius) !== null && _e !== void 0 ? _e : 0,
        ];
        if (radii.some((radius) => radius > 1e-6)) {
            return undefined;
        }
    }
    const visibleFills = node.fills.filter((fill) => { var _a; return fill.visible !== false && ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasVisibleStroke = node.strokeWeight > 0 && node.strokes.some((stroke) => { var _a; return stroke.visible !== false && ((_a = stroke.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasVisibleEffect = node.effects.some((effect) => effect.visible !== false);
    if (visibleFills.length !== 1 || hasVisibleStroke || hasVisibleEffect) {
        return undefined;
    }
    const fill = visibleFills[0];
    if (((_f = fill.opacity) !== null && _f !== void 0 ? _f : 1) < 0.999
        || Math.abs((_g = fill.rotation) !== null && _g !== void 0 ? _g : 0) > 1e-6
        || (fill.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(fill.blendMode))) {
        return undefined;
    }
    if (fill.type === 'PATTERN') {
        const spacing = (_h = fill.spacing) !== null && _h !== void 0 ? _h : { x: 0, y: 0 };
        const unsupportedPattern = (fill.tileType && fill.tileType !== 'RECTANGULAR')
            || Math.abs(spacing.x) > 1e-6
            || Math.abs(spacing.y) > 1e-6
            || (fill.horizontalAlignment && fill.horizontalAlignment !== 'START')
            || (fill.verticalAlignment && fill.verticalAlignment !== 'START');
        if (unsupportedPattern) {
            return undefined;
        }
    }
    return source;
}
function hasComplexEffects(node) {
    return node.effects.some((effect) => effect.visible !== false);
}
function hasComplexPaint(node) {
    const fills = node.fills.filter((fill) => { var _a; return fill.visible !== false && ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const strokes = node.strokes.filter((stroke) => { var _a; return stroke.visible !== false && ((_a = stroke.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const unsupportedGradient = fills.some((fill) => fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND');
    const unevenCorners = node.rectangleCornerRadii
        ? new Set(node.rectangleCornerRadii.map((radius) => Math.round(radius * 1000))).size > 1
        : false;
    return fills.length > 1
        || strokes.length > 1
        || unsupportedGradient
        || unevenCorners
        || Boolean(strokes.length && node.strokeAlign && node.strokeAlign !== 'CENTER');
}
function inferCocosLayoutMode(node) {
    const mode = node.layoutMode;
    if (!mode || mode === 'NONE') {
        return undefined;
    }
    const visibleChildren = node.children.filter((child) => child.visible !== false);
    if (visibleChildren.some((child) => child.layoutPositioning === 'ABSOLUTE')) {
        return undefined;
    }
    const needsGridValidation = mode === 'GRID' || node.layoutWrap === 'WRAP';
    if (!needsGridValidation) {
        return mode;
    }
    const frames = visibleChildren
        .map((child) => child.absoluteBoundingBox)
        .filter((frame) => Boolean(frame));
    if (frames.length !== visibleChildren.length || frames.length < 2) {
        return undefined;
    }
    const widths = frames.map((frame) => frame.width);
    const heights = frames.map((frame) => frame.height);
    const uniformWidth = Math.max(...widths) - Math.min(...widths) <= 2;
    const uniformHeight = Math.max(...heights) - Math.min(...heights) <= 2;
    return uniformWidth && uniformHeight ? 'GRID' : undefined;
}
function inferKind(node) {
    var _a, _b;
    if (node.type === 'TEXT') {
        return 'label';
    }
    // A name or clipping rectangle is not proof of interactive scrolling.
    // Only Figma's explicit prototype overflow setting may change the Cocos
    // hierarchy to ScrollView -> view -> content in automatic mode.
    const overflowDirection = (_b = (_a = node.overflowDirection) === null || _a === void 0 ? void 0 : _a.trim().toUpperCase()) !== null && _b !== void 0 ? _b : '';
    if (FIGMA_SCROLL_DIRECTIONS.has(overflowDirection)) {
        return 'scrollView';
    }
    if (/(^|_)btn_|button|按钮/i.test(node.name)) {
        return 'button';
    }
    if (inferCocosLayoutMode(node)) {
        return 'layout';
    }
    if (CONTAINER_TYPES.has(node.type)) {
        return 'node';
    }
    return 'sprite';
}
function hasIndependentSliceDescendant(node) {
    return node.children.some((child) => isNamedSliceGroup(child)
        || isPatchCandidate(child)
        || hasIndependentSliceDescendant(child));
}
function shouldMergeResourceNode(node, isRoot = false) {
    return !isRoot
        && node.type !== 'TEXT'
        && (0, import_actions_1.isMergedResourceName)(node.name)
        && !hasIndependentSliceDescendant(node);
}
function inferAction(node, isRoot = false) {
    if (node.type === 'TEXT') {
        // Text remains an editable Cocos Label. Even when Figma reports fills,
        // shadows, export settings, or other paint data, exporting a bitmap
        // would lose the text semantics and make the imported UI impossible
        // to edit.
        return 'generate';
    }
    if (isPatchCandidate(node))
        return 'render';
    if (hasManualExport(node) || isNamedSliceGroup(node)) {
        return 'render';
    }
    if (shouldMergeResourceNode(node, isRoot)) {
        return 'render';
    }
    if (CONTAINER_TYPES.has(node.type)) {
        if (node.children.length) {
            return 'generate';
        }
        return hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node)
            ? 'render'
            : 'generate';
    }
    if (isVectorNode(node)) {
        return 'render';
    }
    if (node.type === 'ELLIPSE' || node.type === 'RECTANGLE') {
        return hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node)
            ? 'render'
            : 'generate';
    }
    return 'render';
}
function hasHiddenDescendant(node) {
    return node.children.some((child) => child.visible === false || hasHiddenDescendant(child));
}
function hasExplicitScroll(node) {
    var _a, _b;
    const overflowDirection = (_b = (_a = node.overflowDirection) === null || _a === void 0 ? void 0 : _a.trim().toUpperCase()) !== null && _b !== void 0 ? _b : '';
    return FIGMA_SCROLL_DIRECTIONS.has(overflowDirection);
}
function isEffectivelyVisible(node) {
    if (node.visible === false || node.opacity <= 0) {
        return false;
    }
    const frame = node.absoluteBoundingBox;
    return !frame || (frame.width > 0 && frame.height > 0);
}
function isRuntimeRoleBoundary(node) {
    const name = node.name.trim();
    return EXACT_SEMANTIC_NAMES.has(name.toLowerCase())
        || RUNTIME_ROLE_NAME.test(name)
        || hasExplicitScroll(node)
        || Boolean(inferCocosLayoutMode(node));
}
/**
 * A messy visual wrapper must not absorb an editable or independently planned
 * descendant. Structured names, text, scrolling/layout semantics, manual
 * exports and slice groups all need to keep their own import boundary.
 */
function subtreeRequiresStructure(node) {
    if (!isEffectivelyVisible(node)) {
        return false;
    }
    if (node.type === 'TEXT'
        || isStructuredNodeName(node.name)
        || isRuntimeRoleBoundary(node)
        || hasManualExport(node)
        || isNamedSliceGroup(node)) {
        return true;
    }
    return node.children.some(subtreeRequiresStructure);
}
function subtreeHasVisualContent(node) {
    if (!isEffectivelyVisible(node) || node.type === 'TEXT') {
        return false;
    }
    const hasVisibleFill = node.fills.some((fill) => { var _a; return fill.visible !== false && ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasVisibleStroke = node.strokeWeight > 0 && node.strokes.some((stroke) => { var _a; return stroke.visible !== false && ((_a = stroke.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const hasVisibleEffect = node.effects.some((effect) => effect.visible !== false);
    if (hasVisibleFill || hasVisibleStroke || hasVisibleEffect || isVectorNode(node)) {
        return true;
    }
    if (!CONTAINER_TYPES.has(node.type)) {
        return true;
    }
    return node.children.some(subtreeHasVisualContent);
}
function shouldRenderMessySubtree(node, isRoot) {
    if (isRoot
        || !CONTAINER_TYPES.has(node.type)
        || !isStructuredNodeName(node.name)
        || hasManualExport(node)
        || isNamedSliceGroup(node)
        || ((0, import_actions_1.isMergedResourceName)(node.name) && hasIndependentSliceDescendant(node))
        || isRuntimeRoleBoundary(node)) {
        return false;
    }
    // Hidden children must remain independent Cocos nodes so their Inactive
    // state can be restored later. An automatic parent PNG would erase that
    // runtime boundary. An already-hidden host may still use the same visual
    // heuristic as a visible host when its direct children are visible.
    if (node.children.some((child) => child.visible === false)) {
        return false;
    }
    const visibleChildren = node.children.filter(isEffectivelyVisible);
    return visibleChildren.length > 0
        && visibleChildren.every((child) => !isStructuredNodeName(child.name))
        && !visibleChildren.some(subtreeRequiresStructure)
        && visibleChildren.some(subtreeHasVisualContent);
}
function isPatchCandidate(node) {
    return Boolean((0, slicing_1.analyzeSliceGrid)(node));
}
function warningFor(node, renderManualExportSubtree, renderMessySubtree, mergeResourceSubtree, isRoot) {
    const inactive = node.visible
        ? undefined
        : 'Figma 图层已隐藏，导入后节点将在 Cocos 中保持 Inactive';
    const withInactive = (warning) => [inactive, warning].filter((item) => Boolean(item)).join('；') || undefined;
    if (!node.absoluteBoundingBox) {
        return withInactive('缺少边界信息，将按 0×0 导入');
    }
    if (isPatchCandidate(node)) {
        return withInactive((isNamedSliceGroup(node)
            ? '检测到有效的 3/9 个 Rectangle 连续切片；'
            : '检测到有效三/九宫分片；')
            + 'Figma 分片优先，按 Figma 原始边界导入，旧策略、Export 和前缀规则不能关闭切片');
    }
    if (renderManualExportSubtree) {
        return withInactive('检测到 Figma Export 设置，智能模式将按 PNG 整层导入；Figma 的格式、后缀和倍率不沿用');
    }
    if (isNamedSliceGroup(node)) {
        return withInactive((0, slicing_1.analyzeSliceGrid)(node)
            ? '检测到有效的 3/9 个 Rectangle 连续切片，将按 PNG 整层导入、自动启用切片并优先复用同名资源'
            : '检测到 3/9 个 Rectangle 命名节点，但几何未形成连续切片；将按 PNG 整层导入，不自动启用切片');
    }
    if (!isRoot && node.type !== 'TEXT' && (0, import_actions_1.isMergedResourceName)(node.name)) {
        if (isPatchCandidate(node)) {
            return withInactive('检测到有效三/九宫切片，切片策略优先于前缀合并');
        }
        if (hasIndependentSliceDescendant(node)) {
            return withInactive('前缀整层合并已停用：内部存在独立三/九宫资源，优先保留切片能力');
        }
        if (mergeResourceSubtree) {
            return withInactive('icon_/img_ 前缀按 PNG 整层合并，采用当前显隐合成；隐藏子层不生成独立节点');
        }
    }
    if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) {
        return withInactive(`混合模式 ${node.blendMode} 将近似处理`);
    }
    if (renderMessySubtree) {
        return withInactive('所有有效可见直接子层均为非结构化纯视觉内容，且未检测到文字或运行时结构，智能模式将按 PNG 整层导入');
    }
    if (CONTAINER_TYPES.has(node.type) && node.children.length
        && (hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node))) {
        return withInactive('复杂容器将优先保留可编辑子节点，背景会近似处理');
    }
    return withInactive();
}
function toTree(node, isRoot) {
    var _a, _b;
    const frame = node.absoluteBoundingBox;
    const sliceAnalysis = (0, slicing_1.analyzeSliceGrid)(node);
    const inferredAction = inferAction(node, isRoot);
    const renderManualExportSubtree = inferredAction !== 'ignore'
        && node.type !== 'TEXT'
        && !sliceAnalysis
        && hasManualExport(node);
    const renderMessySubtree = shouldRenderMessySubtree(node, isRoot);
    const mergeResourceSubtree = shouldMergeResourceNode(node, isRoot);
    const renderSubtree = inferredAction !== 'ignore'
        && (Boolean(sliceAnalysis) || renderManualExportSubtree || isNamedSliceGroup(node) || renderMessySubtree || mergeResourceSubtree);
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        width: (_a = frame === null || frame === void 0 ? void 0 : frame.width) !== null && _a !== void 0 ? _a : 0,
        height: (_b = frame === null || frame === void 0 ? void 0 : frame.height) !== null && _b !== void 0 ? _b : 0,
        action: renderSubtree ? 'render' : inferredAction,
        kind: inferKind(node),
        renderSubtree,
        patchCandidate: Boolean(sliceAnalysis),
        sliceMode: sliceAnalysis === null || sliceAnalysis === void 0 ? void 0 : sliceAnalysis.mode,
        warning: warningFor(node, renderManualExportSubtree, renderMessySubtree, mergeResourceSubtree, isRoot),
        children: node.children.map((child) => toTree(child, false)),
    };
}
function analyzeTree(roots) {
    return roots.map((root) => toTree(root, true));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF5Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREEyQ0M7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBcUJDO0FBRUQsc0VBSUM7QUFFRCwwREFLQztBQUVELGtDQWdDQztBQUVELGtEQUVDO0FBNERELDREQXNCQztBQUVELDRDQUVDO0FBb0ZELGtDQUVDO0FBemdCRCx1Q0FBNkM7QUFDN0Msc0RBQXlEO0FBRXpELE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDO0lBQzVCLFVBQVU7SUFDVixRQUFRO0lBQ1IsT0FBTztJQUNQLE9BQU87SUFDUCxTQUFTO0lBQ1QsV0FBVztJQUNYLGVBQWU7SUFDZixVQUFVO0NBQ2IsQ0FBQyxDQUFDO0FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDekIsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtJQUNqQixzRUFBc0U7SUFDdEUsd0VBQXdFO0lBQ3hFLFdBQVc7SUFDWCxTQUFTO0NBQ1osQ0FBQyxDQUFDO0FBRUgsTUFBTSxvQkFBb0IsR0FBRyw2QkFBNkIsQ0FBQztBQUMzRCxNQUFNLG9CQUFvQixHQUFHLDBDQUEwQyxDQUFDO0FBQ3hFLE1BQU0sa0JBQWtCLEdBQUcsK0dBQStHLENBQUM7QUFDM0ksTUFBTSxpQkFBaUIsR0FBRyxzRkFBc0YsQ0FBQztBQUNqSCxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNwQyxzQkFBc0I7SUFDdEIs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InNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFOb2RlLCBJbXBvcnRBY3Rpb24sIE5vZGVLaW5kLCBUcmVlTm9kZUR0byB9IGZyb20gJy4uL3R5cGVzJztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCB9IGZyb20gJy4vc2xpY2luZyc7XHJcbmltcG9ydCB7IGlzTWVyZ2VkUmVzb3VyY2VOYW1lIH0gZnJvbSAnLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBWRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG4gICAgLy8gRmlnbWEgcmVwcmVzZW50cyBiYXNpYyBzaGFwZSBsYXllcnMgYXMgdmVjdG9yIGdlb21ldHJ5IHRvby4gS2VlcGluZ1xyXG4gICAgLy8gdGhlbSBpbiB0aGUgcmFzdGVyIHBhdGggcHJldmVudHMgY2MuR3JhcGhpY3MgZnJvbSBhcHByb3hpbWF0aW5nIHRoZW0uXHJcbiAgICAnUkVDVEFOR0xFJyxcclxuICAgICdFTExJUFNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTTElDRV9SRUNUQU5HTEVfTkFNRSA9IC9eUmVjdGFuZ2xlKD86W1xcc18tXSpcXGQrKT8kL2k7XHJcbmNvbnN0IFNUUlVDVFVSRURfTk9ERV9OQU1FID0gL15bQS1aYS16XVtBLVphLXowLTldKig/Ol9bQS1aYS16MC05XSspKyQvO1xyXG5jb25zdCBTRU1BTlRJQ19OT0RFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBSVU5USU1FX1JPTEVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgRVhBQ1RfU0VNQU5USUNfTkFNRVMgPSBuZXcgU2V0KFsndmlldycsICdjb250ZW50J10pO1xyXG5jb25zdCBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1ZlY3Rvck5vZGUobm9kZTogUGljazxGaWdtYU5vZGUsICd0eXBlJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBWRUNUT1JfVFlQRVMuaGFzKG5vZGUudHlwZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cnVjdHVyZWROb2RlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGlmIChuYW1lICE9PSBuYW1lLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFNUUlVDVFVSRURfTk9ERV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBTRU1BTlRJQ19OT0RFX05BTUUudGVzdChuYW1lKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzTmFtZWRTbGljZUdyb3VwKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMyB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gOSlcclxuICAgICAgICAmJiBub2RlLmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gU0xJQ0VfUkVDVEFOR0xFX05BTUUudGVzdChjaGlsZC5uYW1lLnRyaW0oKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzTWFudWFsRXhwb3J0KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnaGFzRXhwb3J0U2V0dGluZ3MnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuaGFzRXhwb3J0U2V0dGluZ3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVJbWFnZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAoZmlsbC50eXBlID09PSAnSU1BR0UnIHx8IGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGlsZWRQYWludFNvdXJjZSB7XHJcbiAgICBraW5kOiAnaW1hZ2UtcmVmJyB8ICdzb3VyY2Utbm9kZSc7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUGFpbnRTb3VyY2Uobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogVGlsZWRQYWludFNvdXJjZSB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGwgb2Ygbm9kZS5maWxscykge1xyXG4gICAgICAgIGlmIChmaWxsLnZpc2libGUgPT09IGZhbHNlIHx8IChmaWxsLm9wYWNpdHkgPz8gMSkgPD0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgZmlsbC5zY2FsaW5nRmFjdG9yID09PSAnbnVtYmVyJ1xyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUoZmlsbC5zY2FsaW5nRmFjdG9yKVxyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxpbmdGYWN0b3IgPiAwXHJcbiAgICAgICAgICAgID8gZmlsbC5zY2FsaW5nRmFjdG9yXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicgJiYgZmlsbC5zb3VyY2VOb2RlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ3NvdXJjZS1ub2RlJywgaWQ6IGZpbGwuc291cmNlTm9kZUlkLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnVElMRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVJlZikge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnaW1hZ2UtcmVmJywgaWQ6IGZpbGwuaW1hZ2VSZWYsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbGVkSW1hZ2VGaWxsKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odGlsZWRQYWludFNvdXJjZShub2RlKSk7XHJcbn1cclxuXHJcbmNvbnN0IFJBV19JTUFHRV9DT05UQUlORVJfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdGUkFNRScsXHJcbiAgICAnR1JPVVAnLFxyXG4gICAgJ0NPTVBPTkVOVCcsXHJcbiAgICAnSU5TVEFOQ0UnLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVTdHJva2VPckVmZmVjdChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAobm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApKVxyXG4gICAgICAgIHx8IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lc01hdGNoKGxlZnQ6IEZpZ21hTm9kZSwgcmlnaHQ6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgYSA9IGxlZnQuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IGIgPSByaWdodC5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gZmFsc2U7XHJcbiAgICBjb25zdCBlcHNpbG9uID0gMC41O1xyXG4gICAgcmV0dXJuIE1hdGguYWJzKGEueCAtIGIueCkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEueSAtIGIueSkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEud2lkdGggLSBiLndpZHRoKSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS5oZWlnaHQgLSBiLmhlaWdodCkgPD0gZXBzaWxvbjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIG9yaWdpbmFsIElNQUdFIHBhaW50IGZvciBhIHZpc3VhbGx5IHBsYWluIGltYWdlIG5vZGUvc3VidHJlZS5cclxuICogVGhpcyBpcyB1c2VkIGZvciBlZmZlY3RpdmVseS1oaWRkZW4gbGF5ZXJzIGJlY2F1c2UgRmlnbWEncyByZW5kZXJlZC1pbWFnZVxyXG4gKiBlbmRwb2ludCBwcm9kdWNlcyBhIHRyYW5zcGFyZW50IFBORyB3aGVuIGFueSBhbmNlc3RvciBpcyBoaWRkZW4uIERvd25sb2FkaW5nXHJcbiAqIHRoZSBzb3VyY2UgSU1BR0UgcGFpbnQgaXMgdmlzaWJpbGl0eS1pbmRlcGVuZGVudCBhbmQgcHJlc2VydmVzIGl0cyBwaXhlbHMuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybTtcclxuICAgIGlmIChNYXRoLmFicyhub2RlLnJvdGF0aW9uKSA+IDAuMDAwMSB8fCBub2RlLmNsaXBzQ29udGVudFxyXG4gICAgICAgIHx8IChub2RlLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMobm9kZS5ibGVuZE1vZGUpKVxyXG4gICAgICAgIHx8ICh0cmFuc2Zvcm0gJiYgKHRyYW5zZm9ybS5sZW5ndGggIT09IDJcclxuICAgICAgICAgICAgfHwgIVt0cmFuc2Zvcm1bMF0/LlswXSwgdHJhbnNmb3JtWzBdPy5bMV0sIHRyYW5zZm9ybVsxXT8uWzBdLCB0cmFuc2Zvcm1bMV0/LlsxXV0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKVxyXG4gICAgICAgICAgICB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMF0/LlswXSAtIDEpID4gMC4wMDAxIHx8IE1hdGguYWJzKHRyYW5zZm9ybVswXT8uWzFdKSA+IDAuMDAwMVxyXG4gICAgICAgICAgICB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMV0/LlswXSkgPiAwLjAwMDEgfHwgTWF0aC5hYnModHJhbnNmb3JtWzFdPy5bMV0gLSAxKSA+IDAuMDAwMSkpXHJcbiAgICAgICAgfHwgW25vZGUuY29ybmVyUmFkaXVzID8/IDAsIC4uLihub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpID8/IFtdKV0uc29tZSgocmFkaXVzKSA9PiByYWRpdXMgPiAwKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IG5vT3duVmlzdWFsID0gdmlzaWJsZUZpbGxzLmxlbmd0aCA9PT0gMCAmJiAhaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGUpO1xyXG5cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgaWYgKHZpc2libGVGaWxscy5sZW5ndGggIT09IDEgfHwgaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGUpKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlRmlsbHNbMF07XHJcbiAgICAgICAgY29uc3QgbW9kZSA9IGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID8/ICdGSUxMJztcclxuICAgICAgICBjb25zdCByYWRpaSA9IG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWlcclxuICAgICAgICAgICAgPz8gW25vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDBdO1xyXG4gICAgICAgIHJldHVybiBmaWxsLnR5cGUgPT09ICdJTUFHRSdcclxuICAgICAgICAgICAgJiYgQm9vbGVhbihmaWxsLmltYWdlUmVmKVxyXG4gICAgICAgICAgICAmJiBbJ0ZJTEwnLCAnRklUJ10uaW5jbHVkZXMobW9kZSlcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVRyYW5zZm9ybSA9PT0gdW5kZWZpbmVkXHJcbiAgICAgICAgICAgICYmICghZmlsbC5maWx0ZXJzIHx8IE9iamVjdC52YWx1ZXMoZmlsbC5maWx0ZXJzKS5ldmVyeSgodmFsdWUpID0+IHZhbHVlID09PSAwKSlcclxuICAgICAgICAgICAgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA9PT0gMVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApIDw9IDFlLTZcclxuICAgICAgICAgICAgJiYgKCFmaWxsLmJsZW5kTW9kZSB8fCBbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpXHJcbiAgICAgICAgICAgICYmIHJhZGlpLmV2ZXJ5KChyYWRpdXMpID0+IHJhZGl1cyA8PSAxZS02KVxyXG4gICAgICAgICAgICA/IGZpbGwuaW1hZ2VSZWZcclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFSQVdfSU1BR0VfQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggIT09IDFcclxuICAgICAgICB8fCAhbm9Pd25WaXN1YWxcclxuICAgICAgICB8fCBub2RlLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjaGlsZCA9IG5vZGUuY2hpbGRyZW5bMF07XHJcbiAgICByZXR1cm4gY2hpbGQudmlzaWJsZSAhPT0gZmFsc2UgJiYgIWNoaWxkLmlzTWFzayAmJiBmcmFtZXNNYXRjaChub2RlLCBjaGlsZClcclxuICAgICAgICA/IHBsYWluSW1hZ2VTb3VyY2VSZWYoY2hpbGQpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKipcclxuICogQSBuYXRpdmUgdGlsZWQgU3ByaXRlIHJlcHJlc2VudHMgZXhhY3RseSBvbmUgcGFpbnQuIExheWVycyB3aXRoIGFkZGl0aW9uYWxcclxuICogdmlzdWFscyBvciBkZXNjZW5kYW50cyBtdXN0IHN0YXkgb24gdGhlIHdob2xlLW5vZGUgcmFzdGVyIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlOiBGaWdtYU5vZGUpOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICBpZiAoIXNvdXJjZSB8fCBub2RlLmhhc0V4cG9ydFNldHRpbmdzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlICE9PSAnRUxMSVBTRScgJiYgbm9kZS50eXBlICE9PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgJiYgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgY29uc3Qgc3dlZXAgPSBNYXRoLmFicyhub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUgLSBub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSk7XHJcbiAgICAgICAgaWYgKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyA+IDFlLTYgfHwgc3dlZXAgPCBNYXRoLlBJICogMiAtIDFlLTYpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICBdO1xyXG4gICAgICAgIGlmIChyYWRpaS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDFlLTYpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gbm9kZS5maWxscy5maWx0ZXIoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgIGlmICgoZmlsbC5vcGFjaXR5ID8/IDEpIDwgMC45OTlcclxuICAgICAgICB8fCBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApID4gMWUtNlxyXG4gICAgICAgIHx8IChmaWxsLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMoZmlsbC5ibGVuZE1vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicpIHtcclxuICAgICAgICBjb25zdCBzcGFjaW5nID0gZmlsbC5zcGFjaW5nID8/IHsgeDogMCwgeTogMCB9O1xyXG4gICAgICAgIGNvbnN0IHVuc3VwcG9ydGVkUGF0dGVybiA9IChmaWxsLnRpbGVUeXBlICYmIGZpbGwudGlsZVR5cGUgIT09ICdSRUNUQU5HVUxBUicpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueCkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueSkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IChmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgJiYgZmlsbC5ob3Jpem9udGFsQWxpZ25tZW50ICE9PSAnU1RBUlQnKVxyXG4gICAgICAgICAgICB8fCAoZmlsbC52ZXJ0aWNhbEFsaWdubWVudCAmJiBmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICE9PSAnU1RBUlQnKTtcclxuICAgICAgICBpZiAodW5zdXBwb3J0ZWRQYXR0ZXJuKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleEVmZmVjdHMobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleFBhaW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBzdHJva2VzID0gbm9kZS5zdHJva2VzLmZpbHRlcigoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCB1bnN1cHBvcnRlZEdyYWRpZW50ID0gZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9BTkdVTEFSJyB8fCBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9ESUFNT05EJyk7XHJcbiAgICBjb25zdCB1bmV2ZW5Db3JuZXJzID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgID8gbmV3IFNldChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpLm1hcCgocmFkaXVzKSA9PiBNYXRoLnJvdW5kKHJhZGl1cyAqIDEwMDApKSkuc2l6ZSA+IDFcclxuICAgICAgICA6IGZhbHNlO1xyXG4gICAgcmV0dXJuIGZpbGxzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCBzdHJva2VzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCB1bnN1cHBvcnRlZEdyYWRpZW50XHJcbiAgICAgICAgfHwgdW5ldmVuQ29ybmVyc1xyXG4gICAgICAgIHx8IEJvb2xlYW4oc3Ryb2tlcy5sZW5ndGggJiYgbm9kZS5zdHJva2VBbGlnbiAmJiBub2RlLnN0cm9rZUFsaWduICE9PSAnQ0VOVEVSJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbW9kZSA9IG5vZGUubGF5b3V0TW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5sYXlvdXRQb3NpdGlvbmluZyA9PT0gJ0FCU09MVVRFJykpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbmVlZHNHcmlkVmFsaWRhdGlvbiA9IG1vZGUgPT09ICdHUklEJyB8fCBub2RlLmxheW91dFdyYXAgPT09ICdXUkFQJztcclxuICAgIGlmICghbmVlZHNHcmlkVmFsaWRhdGlvbikge1xyXG4gICAgICAgIHJldHVybiBtb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gdmlzaWJsZUNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBOb25OdWxsYWJsZTxGaWdtYU5vZGVbJ2Fic29sdXRlQm91bmRpbmdCb3gnXT4gPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKGZyYW1lcy5sZW5ndGggIT09IHZpc2libGVDaGlsZHJlbi5sZW5ndGggfHwgZnJhbWVzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGhzID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLndpZHRoKTtcclxuICAgIGNvbnN0IGhlaWdodHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KTtcclxuICAgIGNvbnN0IHVuaWZvcm1XaWR0aCA9IE1hdGgubWF4KC4uLndpZHRocykgLSBNYXRoLm1pbiguLi53aWR0aHMpIDw9IDI7XHJcbiAgICBjb25zdCB1bmlmb3JtSGVpZ2h0ID0gTWF0aC5tYXgoLi4uaGVpZ2h0cykgLSBNYXRoLm1pbiguLi5oZWlnaHRzKSA8PSAyO1xyXG4gICAgcmV0dXJuIHVuaWZvcm1XaWR0aCAmJiB1bmlmb3JtSGVpZ2h0ID8gJ0dSSUQnIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJLaW5kKG5vZGU6IEZpZ21hTm9kZSk6IE5vZGVLaW5kIHtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiAnbGFiZWwnO1xyXG4gICAgfVxyXG4gICAgLy8gQSBuYW1lIG9yIGNsaXBwaW5nIHJlY3RhbmdsZSBpcyBub3QgcHJvb2Ygb2YgaW50ZXJhY3RpdmUgc2Nyb2xsaW5nLlxyXG4gICAgLy8gT25seSBGaWdtYSdzIGV4cGxpY2l0IHByb3RvdHlwZSBvdmVyZmxvdyBzZXR0aW5nIG1heSBjaGFuZ2UgdGhlIENvY29zXHJcbiAgICAvLyBoaWVyYXJjaHkgdG8gU2Nyb2xsVmlldyAtPiB2aWV3IC0+IGNvbnRlbnQgaW4gYXV0b21hdGljIG1vZGUuXHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgaWYgKEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbikpIHtcclxuICAgICAgICByZXR1cm4gJ3Njcm9sbFZpZXcnO1xyXG4gICAgfVxyXG4gICAgaWYgKC8oXnxfKWJ0bl98YnV0dG9ufOaMiemSri9pLnRlc3Qobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIHJldHVybiAnYnV0dG9uJztcclxuICAgIH1cclxuICAgIGlmIChpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAnbGF5b3V0JztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gJ25vZGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdzcHJpdGUnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gaXNOYW1lZFNsaWNlR3JvdXAoY2hpbGQpXHJcbiAgICAgICAgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZClcclxuICAgICAgICB8fCBoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChjaGlsZCkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkTWVyZ2VSZXNvdXJjZU5vZGUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3QgPSBmYWxzZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuICFpc1Jvb3RcclxuICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICYmIGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICAmJiAhaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckFjdGlvbihub2RlOiBGaWdtYU5vZGUsIGlzUm9vdCA9IGZhbHNlKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIC8vIFRleHQgcmVtYWlucyBhbiBlZGl0YWJsZSBDb2NvcyBMYWJlbC4gRXZlbiB3aGVuIEZpZ21hIHJlcG9ydHMgZmlsbHMsXHJcbiAgICAgICAgLy8gc2hhZG93cywgZXhwb3J0IHNldHRpbmdzLCBvciBvdGhlciBwYWludCBkYXRhLCBleHBvcnRpbmcgYSBiaXRtYXBcclxuICAgICAgICAvLyB3b3VsZCBsb3NlIHRoZSB0ZXh0IHNlbWFudGljcyBhbmQgbWFrZSB0aGUgaW1wb3J0ZWQgVUkgaW1wb3NzaWJsZVxyXG4gICAgICAgIC8vIHRvIGVkaXQuXHJcbiAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaXNQYXRjaENhbmRpZGF0ZShub2RlKSkgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgaWYgKGhhc01hbnVhbEV4cG9ydChub2RlKSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChzaG91bGRNZXJnZVJlc291cmNlTm9kZShub2RlLCBpc1Jvb3QpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ0VMTElQU0UnIHx8IG5vZGUudHlwZSA9PT0gJ1JFQ1RBTkdMRScpIHtcclxuICAgICAgICByZXR1cm4gaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKVxyXG4gICAgICAgICAgICA/ICdyZW5kZXInXHJcbiAgICAgICAgICAgIDogJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIHJldHVybiAncmVuZGVyJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZTogUGljazxGaWdtYU5vZGUsICdjaGlsZHJlbic+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UgfHwgaGFzSGlkZGVuRGVzY2VuZGFudChjaGlsZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNFeHBsaWNpdFNjcm9sbChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICByZXR1cm4gRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNFZmZlY3RpdmVseVZpc2libGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobm9kZS52aXNpYmxlID09PSBmYWxzZSB8fCBub2RlLm9wYWNpdHkgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgcmV0dXJuICFmcmFtZSB8fCAoZnJhbWUud2lkdGggPiAwICYmIGZyYW1lLmhlaWdodCA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBuYW1lID0gbm9kZS5uYW1lLnRyaW0oKTtcclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFJVTlRJTUVfUk9MRV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBoYXNFeHBsaWNpdFNjcm9sbChub2RlKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogQSBtZXNzeSB2aXN1YWwgd3JhcHBlciBtdXN0IG5vdCBhYnNvcmIgYW4gZWRpdGFibGUgb3IgaW5kZXBlbmRlbnRseSBwbGFubmVkXHJcbiAqIGRlc2NlbmRhbnQuIFN0cnVjdHVyZWQgbmFtZXMsIHRleHQsIHNjcm9sbGluZy9sYXlvdXQgc2VtYW50aWNzLCBtYW51YWxcclxuICogZXhwb3J0cyBhbmQgc2xpY2UgZ3JvdXBzIGFsbCBuZWVkIHRvIGtlZXAgdGhlaXIgb3duIGltcG9ydCBib3VuZGFyeS5cclxuICovXHJcbmZ1bmN0aW9uIHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmICghaXNFZmZlY3RpdmVseVZpc2libGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCdcclxuICAgICAgICB8fCBpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpIHx8IG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGFzVmlzaWJsZUZpbGwgPSBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAoaGFzVmlzaWJsZUZpbGwgfHwgaGFzVmlzaWJsZVN0cm9rZSB8fCBoYXNWaXNpYmxlRWZmZWN0IHx8IGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKCFDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290OiBib29sZWFuKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoaXNSb290XHJcbiAgICAgICAgfHwgIUNPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKVxyXG4gICAgICAgIHx8ICFpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICB8fCAoaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKSAmJiBoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChub2RlKSlcclxuICAgICAgICB8fCBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICAvLyBIaWRkZW4gY2hpbGRyZW4gbXVzdCByZW1haW4gaW5kZXBlbmRlbnQgQ29jb3Mgbm9kZXMgc28gdGhlaXIgSW5hY3RpdmVcclxuICAgIC8vIHN0YXRlIGNhbiBiZSByZXN0b3JlZCBsYXRlci4gQW4gYXV0b21hdGljIHBhcmVudCBQTkcgd291bGQgZXJhc2UgdGhhdFxyXG4gICAgLy8gcnVudGltZSBib3VuZGFyeS4gQW4gYWxyZWFkeS1oaWRkZW4gaG9zdCBtYXkgc3RpbGwgdXNlIHRoZSBzYW1lIHZpc3VhbFxyXG4gICAgLy8gaGV1cmlzdGljIGFzIGEgdmlzaWJsZSBob3N0IHdoZW4gaXRzIGRpcmVjdCBjaGlsZHJlbiBhcmUgdmlzaWJsZS5cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlID09PSBmYWxzZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcihpc0VmZmVjdGl2ZWx5VmlzaWJsZSk7XHJcbiAgICByZXR1cm4gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCA+IDBcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uZXZlcnkoKGNoaWxkKSA9PiAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUoY2hpbGQubmFtZSkpXHJcbiAgICAgICAgJiYgIXZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSlcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uc29tZShzdWJ0cmVlSGFzVmlzdWFsQ29udGVudCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oYW5hbHl6ZVNsaWNlR3JpZChub2RlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhcm5pbmdGb3IoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgcmVuZGVyTWVzc3lTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgbWVyZ2VSZXNvdXJjZVN1YnRyZWU6IGJvb2xlYW4sXHJcbiAgICBpc1Jvb3Q6IGJvb2xlYW4sXHJcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBpbmFjdGl2ZSA9IG5vZGUudmlzaWJsZVxyXG4gICAgICAgID8gdW5kZWZpbmVkXHJcbiAgICAgICAgOiAnRmlnbWEg5Zu+5bGC5bey6ZqQ6JeP77yM5a+85YWl5ZCO6IqC54K55bCG5ZyoIENvY29zIOS4reS/neaMgSBJbmFjdGl2ZSc7XHJcbiAgICBjb25zdCB3aXRoSW5hY3RpdmUgPSAod2FybmluZz86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxyXG4gICAgICAgIFtpbmFjdGl2ZSwgd2FybmluZ10uZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gQm9vbGVhbihpdGVtKSkuam9pbign77ybJykgfHwgdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfnvLrlsJHovrnnlYzkv6Hmga/vvIzlsIbmjIkgMMOXMCDlr7zlhaUnKTtcclxuICAgIH1cclxuICAgIGlmIChpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgoaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICAgICAgPyAn5qOA5rWL5Yiw5pyJ5pWI55qEIDMvOSDkuKogUmVjdGFuZ2xlIOi/nue7reWIh+eJh++8mydcclxuICAgICAgICAgICAgOiAn5qOA5rWL5Yiw5pyJ5pWI5LiJL+S5neWuq+WIhueJh++8mycpXHJcbiAgICAgICAgICAgICsgJ0ZpZ21hIOWIhueJh+S8mOWFiO+8jOaMiSBGaWdtYSDljp/lp4vovrnnlYzlr7zlhaXvvIzml6fnrZbnlaXjgIFFeHBvcnQg5ZKM5YmN57yA6KeE5YiZ5LiN6IO95YWz6Zet5YiH54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+ajgOa1i+WIsCBGaWdtYSBFeHBvcnQg6K6+572u77yM5pm66IO95qih5byP5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXvvJtGaWdtYSDnmoTmoLzlvI/jgIHlkI7nvIDlkozlgI3njofkuI3msr/nlKgnKTtcclxuICAgIH1cclxuICAgIGlmIChpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxyXG4gICAgICAgICAgICA/ICfmo4DmtYvliLDmnInmlYjnmoQgMy85IOS4qiBSZWN0YW5nbGUg6L+e57ut5YiH54mH77yM5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXjgIHoh6rliqjlkK/nlKjliIfniYflubbkvJjlhYjlpI3nlKjlkIzlkI3otYTmupAnXHJcbiAgICAgICAgICAgIDogJ+ajgOa1i+WIsCAzLzkg5LiqIFJlY3RhbmdsZSDlkb3lkI3oioLngrnvvIzkvYblh6DkvZXmnKrlvaLmiJDov57nu63liIfniYfvvJvlsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8jOS4jeiHquWKqOWQr+eUqOWIh+eJhycpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFpc1Jvb3QgJiYgbm9kZS50eXBlICE9PSAnVEVYVCcgJiYgaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIGlmIChpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+ajgOa1i+WIsOacieaViOS4iS/kuZ3lrqvliIfniYfvvIzliIfniYfnrZbnlaXkvJjlhYjkuo7liY3nvIDlkIjlubYnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WJjee8gOaVtOWxguWQiOW5tuW3suWBnOeUqO+8muWGhemDqOWtmOWcqOeLrOeri+S4iS/kuZ3lrqvotYTmupDvvIzkvJjlhYjkv53nlZnliIfniYfog73lipsnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG1lcmdlUmVzb3VyY2VTdWJ0cmVlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ2ljb25fL2ltZ18g5YmN57yA5oyJIFBORyDmlbTlsYLlkIjlubbvvIzph4fnlKjlvZPliY3mmL7pmpDlkIjmiJDvvJvpmpDol4/lrZDlsYLkuI3nlJ/miJDni6znq4voioLngrknKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5ibGVuZE1vZGUgJiYgIVsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKG5vZGUuYmxlbmRNb2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYOa3t+WQiOaooeW8jyAke25vZGUuYmxlbmRNb2RlfSDlsIbov5HkvLzlpITnkIZgKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNZXNzeVN1YnRyZWUpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmiYDmnInmnInmlYjlj6/op4Hnm7TmjqXlrZDlsYLlnYfkuLrpnZ7nu5PmnoTljJbnuq/op4bop4nlhoXlrrnvvIzkuJTmnKrmo4DmtYvliLDmloflrZfmiJbov5DooYzml7bnu5PmnoTvvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpScpO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICYmIChoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WkjeadguWuueWZqOWwhuS8mOWFiOS/neeVmeWPr+e8lui+keWtkOiKgueCue+8jOiDjOaZr+S8mui/keS8vOWkhOeQhicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b1RyZWUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiBUcmVlTm9kZUR0byB7XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBhbmFseXplU2xpY2VHcmlkKG5vZGUpO1xyXG4gICAgY29uc3QgaW5mZXJyZWRBY3Rpb24gPSBpbmZlckFjdGlvbihub2RlLCBpc1Jvb3QpO1xyXG4gICAgY29uc3QgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSA9IGluZmVycmVkQWN0aW9uICE9PSAnaWdub3JlJ1xyXG4gICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgJiYgIXNsaWNlQW5hbHlzaXNcclxuICAgICAgICAmJiBoYXNNYW51YWxFeHBvcnQobm9kZSk7XHJcbiAgICBjb25zdCByZW5kZXJNZXNzeVN1YnRyZWUgPSBzaG91bGRSZW5kZXJNZXNzeVN1YnRyZWUobm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IG1lcmdlUmVzb3VyY2VTdWJ0cmVlID0gc2hvdWxkTWVyZ2VSZXNvdXJjZU5vZGUobm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IHJlbmRlclN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiAoQm9vbGVhbihzbGljZUFuYWx5c2lzKSB8fCByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpIHx8IHJlbmRlck1lc3N5U3VidHJlZSB8fCBtZXJnZVJlc291cmNlU3VidHJlZSk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IG5vZGUubmFtZSxcclxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIHdpZHRoOiBmcmFtZT8ud2lkdGggPz8gMCxcclxuICAgICAgICBoZWlnaHQ6IGZyYW1lPy5oZWlnaHQgPz8gMCxcclxuICAgICAgICBhY3Rpb246IHJlbmRlclN1YnRyZWUgPyAncmVuZGVyJyA6IGluZmVycmVkQWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICByZW5kZXJTdWJ0cmVlLFxyXG4gICAgICAgIHBhdGNoQ2FuZGlkYXRlOiBCb29sZWFuKHNsaWNlQW5hbHlzaXMpLFxyXG4gICAgICAgIHNsaWNlTW9kZTogc2xpY2VBbmFseXNpcz8ubW9kZSxcclxuICAgICAgICB3YXJuaW5nOiB3YXJuaW5nRm9yKG5vZGUsIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUsIHJlbmRlck1lc3N5U3VidHJlZSwgbWVyZ2VSZXNvdXJjZVN1YnRyZWUsIGlzUm9vdCksXHJcbiAgICAgICAgY2hpbGRyZW46IG5vZGUuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gdG9UcmVlKGNoaWxkLCBmYWxzZSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emVUcmVlKHJvb3RzOiBGaWdtYU5vZGVbXSk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIHJvb3RzLm1hcCgocm9vdCkgPT4gdG9UcmVlKHJvb3QsIHRydWUpKTtcclxufVxyXG4iXX0=