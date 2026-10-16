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
        && hasManualExport(node);
    const renderMessySubtree = shouldRenderMessySubtree(node, isRoot);
    const mergeResourceSubtree = shouldMergeResourceNode(node, isRoot);
    const renderSubtree = inferredAction !== 'ignore'
        && (renderManualExportSubtree || isNamedSliceGroup(node) || renderMessySubtree || mergeResourceSubtree);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF5Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREEyQ0M7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBcUJDO0FBRUQsc0VBSUM7QUFFRCwwREFLQztBQUVELGtDQStCQztBQUVELGtEQUVDO0FBNERELDREQXNCQztBQUVELDRDQUVDO0FBNkVELGtDQUVDO0FBamdCRCx1Q0FBNkM7QUFDN0Msc0RBQXlEO0FBRXpELE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDO0lBQzVCLFVBQVU7SUFDVixRQUFRO0lBQ1IsT0FBTztJQUNQLE9BQU87SUFDUCxTQUFTO0lBQ1QsV0FBVztJQUNYLGVBQWU7SUFDZixVQUFVO0NBQ2IsQ0FBQyxDQUFDO0FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDekIsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtJQUNqQixzRUFBc0U7SUFDdEUsd0VBQXdFO0lBQ3hFLFdBQVc7SUFDWCxTQUFTO0NBQ1osQ0FBQyxDQUFDO0FBRUgsTUFBTSxvQkFBb0IsR0FBRyw2QkFBNkIsQ0FBQztBQUMzRCxNQUFNLG9CQUFvQixHQUFHLDBDQUEwQyxDQUFDO0FBQ3hFLE1BQU0sa0JBQWtCLEdBQUcsK0dBQStHLENBQUM7QUFDM0ksTUFBTSxpQkFBaUIsR0FBRyxzRkFBc0YsQ0FBQztBQUNqSCxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNwQyxzQkFBc0I7SUFDdEIs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TCxLQUFLLENBQUUsS0FBSyxtQ0FBSSxDQUFDO1FBQ3hCLE1BQU0sRUFBRSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxNQUFNLG1DQUFJLENBQUM7UUFDMUIsTUFBTSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxjQUFjO1FBQ2pELElBQUksRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDO1FBQ3JCLGFBQWE7UUFDYixjQUFjLEVBQUUsT0FBTyxDQUFDLGFBQWEsQ0FBQztRQUN0QyxTQUFTLEVBQUUsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLElBQUk7UUFDOUIsT0FBTyxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUUsa0JBQWtCLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxDQUFDO1FBQ3RHLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztLQUMvRCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQWdCLFdBQVcsQ0FBQyxLQUFrQjtJQUMxQyxPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNuRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBGaWdtYU5vZGUsIEltcG9ydEFjdGlvbiwgTm9kZUtpbmQsIFRyZWVOb2RlRHRvIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBhbmFseXplU2xpY2VHcmlkIH0gZnJvbSAnLi9zbGljaW5nJztcclxuaW1wb3J0IHsgaXNNZXJnZWRSZXNvdXJjZU5hbWUgfSBmcm9tICcuLi9pbXBvcnQtYWN0aW9ucyc7XHJcblxyXG5jb25zdCBDT05UQUlORVJfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdET0NVTUVOVCcsXHJcbiAgICAnQ0FOVkFTJyxcclxuICAgICdGUkFNRScsXHJcbiAgICAnR1JPVVAnLFxyXG4gICAgJ1NFQ1RJT04nLFxyXG4gICAgJ0NPTVBPTkVOVCcsXHJcbiAgICAnQ09NUE9ORU5UX1NFVCcsXHJcbiAgICAnSU5TVEFOQ0UnLFxyXG5dKTtcclxuXHJcbmNvbnN0IFZFQ1RPUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ1ZFQ1RPUicsXHJcbiAgICAnQk9PTEVBTl9PUEVSQVRJT04nLFxyXG4gICAgJ1NUQVInLFxyXG4gICAgJ0xJTkUnLFxyXG4gICAgJ1JFR1VMQVJfUE9MWUdPTicsXHJcbiAgICAvLyBGaWdtYSByZXByZXNlbnRzIGJhc2ljIHNoYXBlIGxheWVycyBhcyB2ZWN0b3IgZ2VvbWV0cnkgdG9vLiBLZWVwaW5nXHJcbiAgICAvLyB0aGVtIGluIHRoZSByYXN0ZXIgcGF0aCBwcmV2ZW50cyBjYy5HcmFwaGljcyBmcm9tIGFwcHJveGltYXRpbmcgdGhlbS5cclxuICAgICdSRUNUQU5HTEUnLFxyXG4gICAgJ0VMTElQU0UnLFxyXG5dKTtcclxuXHJcbmNvbnN0IFNMSUNFX1JFQ1RBTkdMRV9OQU1FID0gL15SZWN0YW5nbGUoPzpbXFxzXy1dKlxcZCspPyQvaTtcclxuY29uc3QgU1RSVUNUVVJFRF9OT0RFX05BTUUgPSAvXltBLVphLXpdW0EtWmEtejAtOV0qKD86X1tBLVphLXowLTldKykrJC87XHJcbmNvbnN0IFNFTUFOVElDX05PREVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnxpbWd8aW1hZ2V8aWNvbnxiZ3xzcHJpdGV8dHh0fHRleHR8bGFiZWwpX1tcXHB7TH1cXHB7Tn1dKyg/Ol9bXFxwe0x9XFxwe059XSspKiQvaXU7XHJcbmNvbnN0IFJVTlRJTUVfUk9MRV9OQU1FID0gL14oPzpwYW5lbHxsaXN0fGxheW91dHxidG58YnV0dG9ufHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBFWEFDVF9TRU1BTlRJQ19OQU1FUyA9IG5ldyBTZXQoWyd2aWV3JywgJ2NvbnRlbnQnXSk7XHJcbmNvbnN0IEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TID0gbmV3IFNldChbXHJcbiAgICAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUxfU0NST0xMSU5HJyxcclxuICAgICdIT1JJWk9OVEFMJyxcclxuICAgICdWRVJUSUNBTCcsXHJcbiAgICAnQk9USCcsXHJcbl0pO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzVmVjdG9yTm9kZShub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ3R5cGUnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIFZFQ1RPUl9UWVBFUy5oYXMobm9kZS50eXBlKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzU3RydWN0dXJlZE5vZGVOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5hbWUgIT09IG5hbWUudHJpbSgpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIEVYQUNUX1NFTUFOVElDX05BTUVTLmhhcyhuYW1lLnRvTG93ZXJDYXNlKCkpXHJcbiAgICAgICAgfHwgU1RSVUNUVVJFRF9OT0RFX05BTUUudGVzdChuYW1lKVxyXG4gICAgICAgIHx8IFNFTUFOVElDX05PREVfTkFNRS50ZXN0KG5hbWUpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNOYW1lZFNsaWNlR3JvdXAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gKG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSAzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSA5KVxyXG4gICAgICAgICYmIG5vZGUuY2hpbGRyZW4uZXZlcnkoKGNoaWxkKSA9PiBTTElDRV9SRUNUQU5HTEVfTkFNRS50ZXN0KGNoaWxkLm5hbWUudHJpbSgpKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNNYW51YWxFeHBvcnQobm9kZTogUGljazxGaWdtYU5vZGUsICdoYXNFeHBvcnRTZXR0aW5ncyc+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5oYXNFeHBvcnRTZXR0aW5ncztcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzVmlzaWJsZUltYWdlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuZmlsbHMuc29tZSgoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZVxyXG4gICAgICAgICYmIChmaWxsLnR5cGUgPT09ICdJTUFHRScgfHwgZmlsbC50eXBlID09PSAnUEFUVEVSTicpKTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBUaWxlZFBhaW50U291cmNlIHtcclxuICAgIGtpbmQ6ICdpbWFnZS1yZWYnIHwgJ3NvdXJjZS1ub2RlJztcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdGlsZWRQYWludFNvdXJjZShub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2ZpbGxzJz4pOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3QgZmlsbCBvZiBub2RlLmZpbGxzKSB7XHJcbiAgICAgICAgaWYgKGZpbGwudmlzaWJsZSA9PT0gZmFsc2UgfHwgKGZpbGwub3BhY2l0eSA/PyAxKSA8PSAwKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBzY2FsZSA9IHR5cGVvZiBmaWxsLnNjYWxpbmdGYWN0b3IgPT09ICdudW1iZXInXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShmaWxsLnNjYWxpbmdGYWN0b3IpXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGluZ0ZhY3RvciA+IDBcclxuICAgICAgICAgICAgPyBmaWxsLnNjYWxpbmdGYWN0b3JcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJyAmJiBmaWxsLnNvdXJjZU5vZGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnc291cmNlLW5vZGUnLCBpZDogZmlsbC5zb3VyY2VOb2RlSWQsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChmaWxsLnR5cGUgPT09ICdJTUFHRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPT09ICdUSUxFJ1xyXG4gICAgICAgICAgICAmJiBmaWxsLmltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IGtpbmQ6ICdpbWFnZS1yZWYnLCBpZDogZmlsbC5pbWFnZVJlZiwgc2NhbGUgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzVGlsZWRJbWFnZUZpbGwobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbih0aWxlZFBhaW50U291cmNlKG5vZGUpKTtcclxufVxyXG5cclxuY29uc3QgUkFXX0lNQUdFX0NPTlRBSU5FUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0ZSQU1FJyxcclxuICAgICdHUk9VUCcsXHJcbiAgICAnQ09NUE9ORU5UJyxcclxuICAgICdJTlNUQU5DRScsXHJcbl0pO1xyXG5cclxuZnVuY3Rpb24gaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCkpXHJcbiAgICAgICAgfHwgbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVzTWF0Y2gobGVmdDogRmlnbWFOb2RlLCByaWdodDogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBhID0gbGVmdC5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgYiA9IHJpZ2h0LmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBmYWxzZTtcclxuICAgIGNvbnN0IGVwc2lsb24gPSAwLjU7XHJcbiAgICByZXR1cm4gTWF0aC5hYnMoYS54IC0gYi54KSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS55IC0gYi55KSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS53aWR0aCAtIGIud2lkdGgpIDw9IGVwc2lsb25cclxuICAgICAgICAmJiBNYXRoLmFicyhhLmhlaWdodCAtIGIuaGVpZ2h0KSA8PSBlcHNpbG9uO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgb3JpZ2luYWwgSU1BR0UgcGFpbnQgZm9yIGEgdmlzdWFsbHkgcGxhaW4gaW1hZ2Ugbm9kZS9zdWJ0cmVlLlxyXG4gKiBUaGlzIGlzIHVzZWQgZm9yIGVmZmVjdGl2ZWx5LWhpZGRlbiBsYXllcnMgYmVjYXVzZSBGaWdtYSdzIHJlbmRlcmVkLWltYWdlXHJcbiAqIGVuZHBvaW50IHByb2R1Y2VzIGEgdHJhbnNwYXJlbnQgUE5HIHdoZW4gYW55IGFuY2VzdG9yIGlzIGhpZGRlbi4gRG93bmxvYWRpbmdcclxuICogdGhlIHNvdXJjZSBJTUFHRSBwYWludCBpcyB2aXNpYmlsaXR5LWluZGVwZW5kZW50IGFuZCBwcmVzZXJ2ZXMgaXRzIHBpeGVscy5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwbGFpbkltYWdlU291cmNlUmVmKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgaWYgKE1hdGguYWJzKG5vZGUucm90YXRpb24pID4gMC4wMDAxIHx8IG5vZGUuY2xpcHNDb250ZW50XHJcbiAgICAgICAgfHwgKG5vZGUuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhub2RlLmJsZW5kTW9kZSkpXHJcbiAgICAgICAgfHwgKHRyYW5zZm9ybSAmJiAodHJhbnNmb3JtLmxlbmd0aCAhPT0gMlxyXG4gICAgICAgICAgICB8fCAhW3RyYW5zZm9ybVswXT8uWzBdLCB0cmFuc2Zvcm1bMF0/LlsxXSwgdHJhbnNmb3JtWzFdPy5bMF0sIHRyYW5zZm9ybVsxXT8uWzFdXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHRyYW5zZm9ybVswXT8uWzBdIC0gMSkgPiAwLjAwMDEgfHwgTWF0aC5hYnModHJhbnNmb3JtWzBdPy5bMV0pID4gMC4wMDAxXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHRyYW5zZm9ybVsxXT8uWzBdKSA+IDAuMDAwMSB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMV0/LlsxXSAtIDEpID4gMC4wMDAxKSlcclxuICAgICAgICB8fCBbbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgLi4uKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgPz8gW10pXS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDApKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVGaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudmlzaWJsZSAhPT0gZmFsc2UgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3Qgbm9Pd25WaXN1YWwgPSB2aXNpYmxlRmlsbHMubGVuZ3RoID09PSAwICYmICFoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSk7XHJcblxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1JFQ1RBTkdMRScgJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDApIHtcclxuICAgICAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSkpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgICAgICBjb25zdCBtb2RlID0gZmlsbC5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPz8gJ0ZJTEwnO1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMF07XHJcbiAgICAgICAgcmV0dXJuIGZpbGwudHlwZSA9PT0gJ0lNQUdFJ1xyXG4gICAgICAgICAgICAmJiBCb29sZWFuKGZpbGwuaW1hZ2VSZWYpXHJcbiAgICAgICAgICAgICYmIFsnRklMTCcsICdGSVQnXS5pbmNsdWRlcyhtb2RlKVxyXG4gICAgICAgICAgICAmJiBmaWxsLmltYWdlVHJhbnNmb3JtID09PSB1bmRlZmluZWRcclxuICAgICAgICAgICAgJiYgKCFmaWxsLmZpbHRlcnMgfHwgT2JqZWN0LnZhbHVlcyhmaWxsLmZpbHRlcnMpLmV2ZXJ5KCh2YWx1ZSkgPT4gdmFsdWUgPT09IDApKVxyXG4gICAgICAgICAgICAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID09PSAxXHJcbiAgICAgICAgICAgICYmIE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPD0gMWUtNlxyXG4gICAgICAgICAgICAmJiAoIWZpbGwuYmxlbmRNb2RlIHx8IFsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKGZpbGwuYmxlbmRNb2RlKSlcclxuICAgICAgICAgICAgJiYgcmFkaWkuZXZlcnkoKHJhZGl1cykgPT4gcmFkaXVzIDw9IDFlLTYpXHJcbiAgICAgICAgICAgID8gZmlsbC5pbWFnZVJlZlxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIVJBV19JTUFHRV9DT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCAhPT0gMVxyXG4gICAgICAgIHx8ICFub093blZpc3VhbFxyXG4gICAgICAgIHx8IG5vZGUub3BhY2l0eSA8IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNoaWxkID0gbm9kZS5jaGlsZHJlblswXTtcclxuICAgIHJldHVybiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSAmJiAhY2hpbGQuaXNNYXNrICYmIGZyYW1lc01hdGNoKG5vZGUsIGNoaWxkKVxyXG4gICAgICAgID8gcGxhaW5JbWFnZVNvdXJjZVJlZihjaGlsZCkgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBIG5hdGl2ZSB0aWxlZCBTcHJpdGUgcmVwcmVzZW50cyBleGFjdGx5IG9uZSBwYWludC4gTGF5ZXJzIHdpdGggYWRkaXRpb25hbFxyXG4gKiB2aXN1YWxzIG9yIGRlc2NlbmRhbnRzIG11c3Qgc3RheSBvbiB0aGUgd2hvbGUtbm9kZSByYXN0ZXIgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGU6IEZpZ21hTm9kZSk6IFRpbGVkUGFpbnRTb3VyY2UgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3Qgc291cmNlID0gdGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgIGlmICghc291cmNlIHx8IG5vZGUuaGFzRXhwb3J0U2V0dGluZ3MgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgIT09ICdFTExJUFNFJyAmJiBub2RlLnR5cGUgIT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyAmJiBub2RlLmFyY0RhdGEpIHtcclxuICAgICAgICBjb25zdCBzd2VlcCA9IE1hdGguYWJzKG5vZGUuYXJjRGF0YS5lbmRpbmdBbmdsZSAtIG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKTtcclxuICAgICAgICBpZiAobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzID4gMWUtNiB8fCBzd2VlcCA8IE1hdGguUEkgKiAyIC0gMWUtNikge1xyXG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgY29uc3QgcmFkaWkgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgICAgID8/IFtcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgIF07XHJcbiAgICAgICAgaWYgKHJhZGlpLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMWUtNikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlRmlsbHMubGVuZ3RoICE9PSAxIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZUZpbGxzWzBdO1xyXG4gICAgaWYgKChmaWxsLm9wYWNpdHkgPz8gMSkgPCAwLjk5OVxyXG4gICAgICAgIHx8IE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPiAxZS02XHJcbiAgICAgICAgfHwgKGZpbGwuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJykge1xyXG4gICAgICAgIGNvbnN0IHNwYWNpbmcgPSBmaWxsLnNwYWNpbmcgPz8geyB4OiAwLCB5OiAwIH07XHJcbiAgICAgICAgY29uc3QgdW5zdXBwb3J0ZWRQYXR0ZXJuID0gKGZpbGwudGlsZVR5cGUgJiYgZmlsbC50aWxlVHlwZSAhPT0gJ1JFQ1RBTkdVTEFSJylcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy54KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy55KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgKGZpbGwuaG9yaXpvbnRhbEFsaWdubWVudCAmJiBmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpXHJcbiAgICAgICAgICAgIHx8IChmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICYmIGZpbGwudmVydGljYWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpO1xyXG4gICAgICAgIGlmICh1bnN1cHBvcnRlZFBhdHRlcm4pIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4RWZmZWN0cyhub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4UGFpbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PiBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHN0cm9rZXMgPSBub2RlLnN0cm9rZXMuZmlsdGVyKChzdHJva2UpID0+IHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHVuc3VwcG9ydGVkR3JhZGllbnQgPSBmaWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0FOR1VMQVInIHx8IGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0RJQU1PTkQnKTtcclxuICAgIGNvbnN0IHVuZXZlbkNvcm5lcnMgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgPyBuZXcgU2V0KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IE1hdGgucm91bmQocmFkaXVzICogMTAwMCkpKS5zaXplID4gMVxyXG4gICAgICAgIDogZmFsc2U7XHJcbiAgICByZXR1cm4gZmlsbHMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHN0cm9rZXMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHVuc3VwcG9ydGVkR3JhZGllbnRcclxuICAgICAgICB8fCB1bmV2ZW5Db3JuZXJzXHJcbiAgICAgICAgfHwgQm9vbGVhbihzdHJva2VzLmxlbmd0aCAmJiBub2RlLnN0cm9rZUFsaWduICYmIG5vZGUuc3Ryb2tlQWxpZ24gIT09ICdDRU5URVInKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBtb2RlID0gbm9kZS5sYXlvdXRNb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlQ2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLmxheW91dFBvc2l0aW9uaW5nID09PSAnQUJTT0xVVEUnKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBuZWVkc0dyaWRWYWxpZGF0aW9uID0gbW9kZSA9PT0gJ0dSSUQnIHx8IG5vZGUubGF5b3V0V3JhcCA9PT0gJ1dSQVAnO1xyXG4gICAgaWYgKCFuZWVkc0dyaWRWYWxpZGF0aW9uKSB7XHJcbiAgICAgICAgcmV0dXJuIG1vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSB2aXNpYmxlQ2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIE5vbk51bGxhYmxlPEZpZ21hTm9kZVsnYWJzb2x1dGVCb3VuZGluZ0JveCddPiA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoZnJhbWVzLmxlbmd0aCAhPT0gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCB8fCBmcmFtZXMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUud2lkdGgpO1xyXG4gICAgY29uc3QgaGVpZ2h0cyA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpO1xyXG4gICAgY29uc3QgdW5pZm9ybVdpZHRoID0gTWF0aC5tYXgoLi4ud2lkdGhzKSAtIE1hdGgubWluKC4uLndpZHRocykgPD0gMjtcclxuICAgIGNvbnN0IHVuaWZvcm1IZWlnaHQgPSBNYXRoLm1heCguLi5oZWlnaHRzKSAtIE1hdGgubWluKC4uLmhlaWdodHMpIDw9IDI7XHJcbiAgICByZXR1cm4gdW5pZm9ybVdpZHRoICYmIHVuaWZvcm1IZWlnaHQgPyAnR1JJRCcgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlcktpbmQobm9kZTogRmlnbWFOb2RlKTogTm9kZUtpbmQge1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYWJlbCc7XHJcbiAgICB9XHJcbiAgICAvLyBBIG5hbWUgb3IgY2xpcHBpbmcgcmVjdGFuZ2xlIGlzIG5vdCBwcm9vZiBvZiBpbnRlcmFjdGl2ZSBzY3JvbGxpbmcuXHJcbiAgICAvLyBPbmx5IEZpZ21hJ3MgZXhwbGljaXQgcHJvdG90eXBlIG92ZXJmbG93IHNldHRpbmcgbWF5IGNoYW5nZSB0aGUgQ29jb3NcclxuICAgIC8vIGhpZXJhcmNoeSB0byBTY3JvbGxWaWV3IC0+IHZpZXcgLT4gY29udGVudCBpbiBhdXRvbWF0aWMgbW9kZS5cclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICBpZiAoRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKSkge1xyXG4gICAgICAgIHJldHVybiAnc2Nyb2xsVmlldyc7XHJcbiAgICB9XHJcbiAgICBpZiAoLyhefF8pYnRuX3xidXR0b2585oyJ6ZKuL2kudGVzdChub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdidXR0b24nO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYXlvdXQnO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiAnbm9kZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3Nwcml0ZSc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBpc05hbWVkU2xpY2VHcm91cChjaGlsZClcclxuICAgICAgICB8fCBpc1BhdGNoQ2FuZGlkYXRlKGNoaWxkKVxyXG4gICAgICAgIHx8IGhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KGNoaWxkKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRNZXJnZVJlc291cmNlTm9kZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdCA9IGZhbHNlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gIWlzUm9vdFxyXG4gICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgJiYgaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgICYmICFoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChub2RlKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQWN0aW9uKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290ID0gZmFsc2UpOiBJbXBvcnRBY3Rpb24ge1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgLy8gVGV4dCByZW1haW5zIGFuIGVkaXRhYmxlIENvY29zIExhYmVsLiBFdmVuIHdoZW4gRmlnbWEgcmVwb3J0cyBmaWxscyxcclxuICAgICAgICAvLyBzaGFkb3dzLCBleHBvcnQgc2V0dGluZ3MsIG9yIG90aGVyIHBhaW50IGRhdGEsIGV4cG9ydGluZyBhIGJpdG1hcFxyXG4gICAgICAgIC8vIHdvdWxkIGxvc2UgdGhlIHRleHQgc2VtYW50aWNzIGFuZCBtYWtlIHRoZSBpbXBvcnRlZCBVSSBpbXBvc3NpYmxlXHJcbiAgICAgICAgLy8gdG8gZWRpdC5cclxuICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIGlmIChoYXNNYW51YWxFeHBvcnQobm9kZSkgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAoc2hvdWxkTWVyZ2VSZXNvdXJjZU5vZGUobm9kZSwgaXNSb290KSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpXHJcbiAgICAgICAgICAgID8gJ3JlbmRlcidcclxuICAgICAgICAgICAgOiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyB8fCBub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3JlbmRlcic7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnY2hpbGRyZW4nPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgPT09IGZhbHNlIHx8IGhhc0hpZGRlbkRlc2NlbmRhbnQoY2hpbGQpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzRXhwbGljaXRTY3JvbGwobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgcmV0dXJuIEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5vZGUudmlzaWJsZSA9PT0gZmFsc2UgfHwgbm9kZS5vcGFjaXR5IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIHJldHVybiAhZnJhbWUgfHwgKGZyYW1lLndpZHRoID4gMCAmJiBmcmFtZS5oZWlnaHQgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgbmFtZSA9IG5vZGUubmFtZS50cmltKCk7XHJcbiAgICByZXR1cm4gRVhBQ1RfU0VNQU5USUNfTkFNRVMuaGFzKG5hbWUudG9Mb3dlckNhc2UoKSlcclxuICAgICAgICB8fCBSVU5USU1FX1JPTEVfTkFNRS50ZXN0KG5hbWUpXHJcbiAgICAgICAgfHwgaGFzRXhwbGljaXRTY3JvbGwobm9kZSlcclxuICAgICAgICB8fCBCb29sZWFuKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEEgbWVzc3kgdmlzdWFsIHdyYXBwZXIgbXVzdCBub3QgYWJzb3JiIGFuIGVkaXRhYmxlIG9yIGluZGVwZW5kZW50bHkgcGxhbm5lZFxyXG4gKiBkZXNjZW5kYW50LiBTdHJ1Y3R1cmVkIG5hbWVzLCB0ZXh0LCBzY3JvbGxpbmcvbGF5b3V0IHNlbWFudGljcywgbWFudWFsXHJcbiAqIGV4cG9ydHMgYW5kIHNsaWNlIGdyb3VwcyBhbGwgbmVlZCB0byBrZWVwIHRoZWlyIG93biBpbXBvcnQgYm91bmRhcnkuXHJcbiAqL1xyXG5mdW5jdGlvbiBzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnXHJcbiAgICAgICAgfHwgaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlKSB8fCBub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhhc1Zpc2libGVGaWxsID0gbm9kZS5maWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudmlzaWJsZSAhPT0gZmFsc2UgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZVN0cm9rZSA9IG5vZGUuc3Ryb2tlV2VpZ2h0ID4gMCAmJiBub2RlLnN0cm9rZXMuc29tZSgoc3Ryb2tlKSA9PlxyXG4gICAgICAgIHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVFZmZlY3QgPSBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgaWYgKGhhc1Zpc2libGVGaWxsIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCB8fCBpc1ZlY3Rvck5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmICghQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJlbmRlck1lc3N5U3VidHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IGJvb2xlYW4ge1xyXG4gICAgaWYgKGlzUm9vdFxyXG4gICAgICAgIHx8ICFDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSlcclxuICAgICAgICB8fCAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgfHwgKGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSkgJiYgaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSkpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgLy8gSGlkZGVuIGNoaWxkcmVuIG11c3QgcmVtYWluIGluZGVwZW5kZW50IENvY29zIG5vZGVzIHNvIHRoZWlyIEluYWN0aXZlXHJcbiAgICAvLyBzdGF0ZSBjYW4gYmUgcmVzdG9yZWQgbGF0ZXIuIEFuIGF1dG9tYXRpYyBwYXJlbnQgUE5HIHdvdWxkIGVyYXNlIHRoYXRcclxuICAgIC8vIHJ1bnRpbWUgYm91bmRhcnkuIEFuIGFscmVhZHktaGlkZGVuIGhvc3QgbWF5IHN0aWxsIHVzZSB0aGUgc2FtZSB2aXN1YWxcclxuICAgIC8vIGhldXJpc3RpYyBhcyBhIHZpc2libGUgaG9zdCB3aGVuIGl0cyBkaXJlY3QgY2hpbGRyZW4gYXJlIHZpc2libGUuXHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoaXNFZmZlY3RpdmVseVZpc2libGUpO1xyXG4gICAgcmV0dXJuIHZpc2libGVDaGlsZHJlbi5sZW5ndGggPiAwXHJcbiAgICAgICAgJiYgdmlzaWJsZUNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gIWlzU3RydWN0dXJlZE5vZGVOYW1lKGNoaWxkLm5hbWUpKVxyXG4gICAgICAgICYmICF2aXNpYmxlQ2hpbGRyZW4uc29tZShzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUpXHJcbiAgICAgICAgJiYgdmlzaWJsZUNoaWxkcmVuLnNvbWUoc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNQYXRjaENhbmRpZGF0ZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKGFuYWx5emVTbGljZUdyaWQobm9kZSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YXJuaW5nRm9yKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZTogYm9vbGVhbixcclxuICAgIHJlbmRlck1lc3N5U3VidHJlZTogYm9vbGVhbixcclxuICAgIG1lcmdlUmVzb3VyY2VTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgaXNSb290OiBib29sZWFuLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgaW5hY3RpdmUgPSBub2RlLnZpc2libGVcclxuICAgICAgICA/IHVuZGVmaW5lZFxyXG4gICAgICAgIDogJ0ZpZ21hIOWbvuWxguW3sumakOiXj++8jOWvvOWFpeWQjuiKgueCueWwhuWcqCBDb2NvcyDkuK3kv53mjIEgSW5hY3RpdmUnO1xyXG4gICAgY29uc3Qgd2l0aEluYWN0aXZlID0gKHdhcm5pbmc/OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cclxuICAgICAgICBbaW5hY3RpdmUsIHdhcm5pbmddLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgc3RyaW5nID0+IEJvb2xlYW4oaXRlbSkpLmpvaW4oJ++8mycpIHx8IHVuZGVmaW5lZDtcclxuICAgIGlmICghbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn57y65bCR6L6555WM5L+h5oGv77yM5bCG5oyJIDDDlzAg5a+85YWlJyk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+ajgOa1i+WIsCBGaWdtYSBFeHBvcnQg6K6+572u77yM5pm66IO95qih5byP5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXvvJtGaWdtYSDnmoTmoLzlvI/jgIHlkI7nvIDlkozlgI3njofkuI3msr/nlKgnKTtcclxuICAgIH1cclxuICAgIGlmIChpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxyXG4gICAgICAgICAgICA/ICfmo4DmtYvliLDmnInmlYjnmoQgMy85IOS4qiBSZWN0YW5nbGUg6L+e57ut5YiH54mH77yM5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXjgIHoh6rliqjlkK/nlKjliIfniYflubbkvJjlhYjlpI3nlKjlkIzlkI3otYTmupAnXHJcbiAgICAgICAgICAgIDogJ+ajgOa1i+WIsCAzLzkg5LiqIFJlY3RhbmdsZSDlkb3lkI3oioLngrnvvIzkvYblh6DkvZXmnKrlvaLmiJDov57nu63liIfniYfvvJvlsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8jOS4jeiHquWKqOWQr+eUqOWIh+eJhycpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFpc1Jvb3QgJiYgbm9kZS50eXBlICE9PSAnVEVYVCcgJiYgaXNNZXJnZWRSZXNvdXJjZU5hbWUobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIGlmIChpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+ajgOa1i+WIsOacieaViOS4iS/kuZ3lrqvliIfniYfvvIzliIfniYfnrZbnlaXkvJjlhYjkuo7liY3nvIDlkIjlubYnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WJjee8gOaVtOWxguWQiOW5tuW3suWBnOeUqO+8muWGhemDqOWtmOWcqOeLrOeri+S4iS/kuZ3lrqvotYTmupDvvIzkvJjlhYjkv53nlZnliIfniYfog73lipsnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG1lcmdlUmVzb3VyY2VTdWJ0cmVlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ2ljb25fL2ltZ18g5YmN57yA5oyJIFBORyDmlbTlsYLlkIjlubbvvIzph4fnlKjlvZPliY3mmL7pmpDlkIjmiJDvvJvpmpDol4/lrZDlsYLkuI3nlJ/miJDni6znq4voioLngrknKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5ibGVuZE1vZGUgJiYgIVsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKG5vZGUuYmxlbmRNb2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYOa3t+WQiOaooeW8jyAke25vZGUuYmxlbmRNb2RlfSDlsIbov5HkvLzlpITnkIZgKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNZXNzeVN1YnRyZWUpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmiYDmnInmnInmlYjlj6/op4Hnm7TmjqXlrZDlsYLlnYfkuLrpnZ7nu5PmnoTljJbnuq/op4bop4nlhoXlrrnvvIzkuJTmnKrmo4DmtYvliLDmloflrZfmiJbov5DooYzml7bnu5PmnoTvvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpScpO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICYmIChoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WkjeadguWuueWZqOWwhuS8mOWFiOS/neeVmeWPr+e8lui+keWtkOiKgueCue+8jOiDjOaZr+S8mui/keS8vOWkhOeQhicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b1RyZWUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiBUcmVlTm9kZUR0byB7XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBhbmFseXplU2xpY2VHcmlkKG5vZGUpO1xyXG4gICAgY29uc3QgaW5mZXJyZWRBY3Rpb24gPSBpbmZlckFjdGlvbihub2RlLCBpc1Jvb3QpO1xyXG4gICAgY29uc3QgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSA9IGluZmVycmVkQWN0aW9uICE9PSAnaWdub3JlJ1xyXG4gICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgJiYgaGFzTWFudWFsRXhwb3J0KG5vZGUpO1xyXG4gICAgY29uc3QgcmVuZGVyTWVzc3lTdWJ0cmVlID0gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCBtZXJnZVJlc291cmNlU3VidHJlZSA9IHNob3VsZE1lcmdlUmVzb3VyY2VOb2RlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCByZW5kZXJTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgKHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkgfHwgcmVuZGVyTWVzc3lTdWJ0cmVlIHx8IG1lcmdlUmVzb3VyY2VTdWJ0cmVlKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxyXG4gICAgICAgIHR5cGU6IG5vZGUudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgd2lkdGg6IGZyYW1lPy53aWR0aCA/PyAwLFxyXG4gICAgICAgIGhlaWdodDogZnJhbWU/LmhlaWdodCA/PyAwLFxyXG4gICAgICAgIGFjdGlvbjogcmVuZGVyU3VidHJlZSA/ICdyZW5kZXInIDogaW5mZXJyZWRBY3Rpb24sXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIHJlbmRlclN1YnRyZWUsXHJcbiAgICAgICAgcGF0Y2hDYW5kaWRhdGU6IEJvb2xlYW4oc2xpY2VBbmFseXNpcyksXHJcbiAgICAgICAgc2xpY2VNb2RlOiBzbGljZUFuYWx5c2lzPy5tb2RlLFxyXG4gICAgICAgIHdhcm5pbmc6IHdhcm5pbmdGb3Iobm9kZSwgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSwgcmVuZGVyTWVzc3lTdWJ0cmVlLCBtZXJnZVJlc291cmNlU3VidHJlZSwgaXNSb290KSxcclxuICAgICAgICBjaGlsZHJlbjogbm9kZS5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB0b1RyZWUoY2hpbGQsIGZhbHNlKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYW5hbHl6ZVRyZWUocm9vdHM6IEZpZ21hTm9kZVtdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gcm9vdHMubWFwKChyb290KSA9PiB0b1RyZWUocm9vdCwgdHJ1ZSkpO1xyXG59XHJcbiJdfQ==