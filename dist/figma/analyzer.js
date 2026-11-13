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
exports.hasPrefabDescendant = hasPrefabDescendant;
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
    var _a, _b, _c;
    if ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim())
        return 'node';
    if (node.type === 'TEXT') {
        return 'label';
    }
    // A name or clipping rectangle is not proof of interactive scrolling.
    // Only Figma's explicit prototype overflow setting may change the Cocos
    // hierarchy to ScrollView -> view -> content in automatic mode.
    const overflowDirection = (_c = (_b = node.overflowDirection) === null || _b === void 0 ? void 0 : _b.trim().toUpperCase()) !== null && _c !== void 0 ? _c : '';
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
/** Prefab references must survive automatic raster boundaries, even hidden. */
function hasPrefabDescendant(node) {
    return node.children.some((child) => { var _a; return Boolean((_a = child.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) || hasPrefabDescendant(child); });
}
function shouldMergeResourceNode(node, isRoot = false) {
    var _a;
    return !isRoot
        && !((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim())
        && !hasPrefabDescendant(node)
        && node.type !== 'TEXT'
        && (0, import_actions_1.isMergedResourceName)(node.name)
        && !hasIndependentSliceDescendant(node);
}
function inferAction(node, isRoot = false) {
    var _a;
    if (((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) || hasPrefabDescendant(node))
        return 'generate';
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
    var _a;
    if ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim())
        return true;
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
    var _a;
    if (isRoot
        || ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim())
        || hasPrefabDescendant(node)
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
    var _a;
    return !((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) && !hasPrefabDescendant(node) && Boolean((0, slicing_1.analyzeSliceGrid)(node));
}
function warningFor(node, renderManualExportSubtree, renderMessySubtree, mergeResourceSubtree, isRoot) {
    var _a;
    const inactive = node.visible
        ? undefined
        : 'Figma 图层已隐藏，导入后节点将在 Cocos 中保持 Inactive';
    const withInactive = (warning) => [inactive, warning].filter((item) => Boolean(item)).join('；') || undefined;
    if ((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) {
        return withInactive(`引用项目 Prefab“${node.prefabName}”，${(0, import_actions_1.prefabUsesFigmaSize)(node.prefabName) ? '按 Figma 调整宽高' : '按 Figma 实例相对母组件的倍率缩放'}；不导入此节点的原始内容及子树`);
    }
    if (hasPrefabDescendant(node)) {
        return withInactive('内部存在 Prefab 引用，智能模式保留节点结构，不自动合并为图片');
    }
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
    var _a, _b, _c, _d;
    const frame = node.absoluteBoundingBox;
    const prefabBoundary = Boolean((_a = node.prefabName) === null || _a === void 0 ? void 0 : _a.trim()) || hasPrefabDescendant(node);
    const sliceAnalysis = prefabBoundary ? undefined : (0, slicing_1.analyzeSliceGrid)(node);
    const inferredAction = inferAction(node, isRoot);
    const renderManualExportSubtree = inferredAction !== 'ignore'
        && !prefabBoundary
        && node.type !== 'TEXT'
        && !sliceAnalysis
        && hasManualExport(node);
    const renderMessySubtree = shouldRenderMessySubtree(node, isRoot);
    const mergeResourceSubtree = shouldMergeResourceNode(node, isRoot);
    const renderSubtree = inferredAction !== 'ignore'
        && !prefabBoundary
        && (Boolean(sliceAnalysis) || renderManualExportSubtree || isNamedSliceGroup(node) || renderMessySubtree || mergeResourceSubtree);
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        width: (_b = frame === null || frame === void 0 ? void 0 : frame.width) !== null && _b !== void 0 ? _b : 0,
        height: (_c = frame === null || frame === void 0 ? void 0 : frame.height) !== null && _c !== void 0 ? _c : 0,
        action: renderSubtree ? 'render' : inferredAction,
        kind: inferKind(node),
        renderSubtree,
        patchCandidate: Boolean(sliceAnalysis),
        sliceMode: sliceAnalysis === null || sliceAnalysis === void 0 ? void 0 : sliceAnalysis.mode,
        reason: ((_d = node.prefabName) === null || _d === void 0 ? void 0 : _d.trim()) ? 'prefab-reference' : undefined,
        warning: warningFor(node, renderManualExportSubtree, renderMessySubtree, mergeResourceSubtree, isRoot),
        children: node.children.map((child) => toTree(child, false)),
    };
}
function analyzeTree(roots) {
    return roots.map((root) => toTree(root, true));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF5Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREEyQ0M7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBc0JDO0FBRUQsc0VBSUM7QUFHRCxrREFFQztBQUVELDBEQU9DO0FBRUQsa0NBaUNDO0FBRUQsa0RBRUM7QUE2REQsNERBd0JDO0FBRUQsNENBRUM7QUE4RkQsa0NBRUM7QUEvaEJELHVDQUE2QztBQUM3QyxzREFBOEU7QUFFOUUsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN6QixRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0lBQ2pCLHNFQUFzRTtJQUN0RSx3RUFBd0U7SUFDeEUsV0FBVztJQUNYLFNBQVM7Q0FDWixDQUFDLENBQUM7QUFFSCxNQUFNLG9CQUFvQixHQUFHLDZCQUE2QixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsMENBQTBDLENBQUM7QUFDeEUsTUFBTSxrQkFBa0IsR0FBRywrR0FBK0csQ0FBQztBQUMzSSxNQUFNLGlCQUFpQixHQUFHLHNGQUFzRixDQUFDO0FBQ2pILE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUMxRCxNQUFNLHVCQUF1QixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ3BDLHNCQUFzQjtJQUN0QixvQkFBb0I7SUFDcEIsbUNBQW1DO0lBQ25DLFlBQVk7SUFDWixVQUFVO0lBQ1YsTUFBTTtDQUNULENBQUMsQ0FBQztBQUVILFNBQWdCLFlBQVksQ0FBQyxJQUE2QjtJQUN0RCxPQUFPLFlBQVksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ3ZDLENBQUM7QUFFRCxTQUFnQixvQkFBb0IsQ0FBQyxJQUFZO0lBQzdDLElBQUksSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ3ZCLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7SUFDRCxPQUFPLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7V0FDNUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztXQUMvQixrQkFBa0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDekMsQ0FBQztBQUVELFNBQWdCLGlCQUFpQixDQUFDLElBQWU7SUFDN0MsT0FBTyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUM7V0FDMUQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLG9CQUFvQixDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUN4RixDQUFDO0FBRUQsU0FBZ0IsZUFBZSxDQUFDLElBQTBDO0lBQ3RFLE9BQU8sSUFBSSxDQUFDLGlCQUFpQixDQUFDO0FBQ2xDLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxJQUFlO0lBQ3BDLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssS0FBSztXQUNoRCxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQztBQUMvRCxDQUFDO0FBUUQsU0FBZ0IsZ0JBQWdCLENBQUMsSUFBOEI7O0lBQzNELEtBQUssTUFBTSxJQUFJLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQzVCLElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxNQUFBLElBQUksQ0FBQyxPQUFPLG1DQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3JELFNBQVM7UUFDYixDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsT0FBTyxJQUFJLENBQUMsYUFBYSxLQUFLLFFBQVE7ZUFDN0MsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO2VBQ25DLElBQUksQ0FBQyxhQUFhLEdBQUcsQ0FBQztZQUN6QixDQUFDLENBQUMsSUFBSSxDQUFDLGFBQWE7WUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNSLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxTQUFTLElBQUksSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQy9DLE9BQU8sRUFBRSxJQUFJLEVBQUUsYUFBYSxFQUFFLEVBQUUsRUFBRSxJQUFJLENBQUMsWUFBWSxFQUFFLEtBQUssRUFBRSxDQUFDO1FBQ2pFLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTztlQUNsQixDQUFBLE1BQUEsSUFBSSxDQUFDLFNBQVMsMENBQUUsV0FBVyxFQUFFLE1BQUssTUFBTTtlQUN4QyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbkIsT0FBTyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsRUFBRSxFQUFFLElBQUksQ0FBQyxRQUFRLEVBQUUsS0FBSyxFQUFFLENBQUM7UUFDM0QsQ0FBQztJQUNMLENBQUM7SUFDRCxPQUFPLFNBQVMsQ0FBQztBQUNyQixDQUFDO0FBRUQsU0FBZ0IsaUJBQWlCLENBQUMsSUFBOEI7SUFDNUQsT0FBTyxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUMzQyxDQUFDO0FBRUQsTUFBTSx5QkFBeUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN0QyxPQUFPO0lBQ1AsT0FBTztJQUNQLFdBQVc7SUFDWCxVQUFVO0NBQ2IsQ0FBQyxDQUFDO0FBRUgsU0FBUyx3QkFBd0IsQ0FBQyxJQUFlO0lBQzdDLE9BQU8sQ0FBQyxJQUFJLENBQUMsWUFBWSxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLFdBQzFELE9BQUEsTUFBTSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxNQUFBLE1BQU0sQ0FBQyxPQUFPLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQSxFQUFBLENBQUMsQ0FBQztXQUNwRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLE9BQU8sS0FBSyxLQUFLLENBQUMsQ0FBQztBQUNuRSxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsSUFBZSxFQUFFLEtBQWdCO0lBQ2xELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FBQztJQUNuQyxNQUFNLENBQUMsR0FBRyxLQUFLLENBQUMsbUJBQW1CLENBQUM7SUFDcEMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUMzQixNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUM7SUFDcEIsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLE9BQU87V0FDOUIsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxPQUFPO1dBQzlCLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksT0FBTztXQUN0QyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE9BQU8sQ0FBQztBQUNwRCxDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxTQUFnQixtQkFBbUIsQ0FBQyxJQUFlOztJQUMvQyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsaUJBQWlCLENBQUM7SUFDekMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxNQUFNLElBQUksSUFBSSxDQUFDLFlBQVk7V0FDbEQsQ0FBQyxJQUFJLENBQUMsU0FBUyxJQUFJLENBQUMsQ0FBQyxRQUFRLEVBQUUsY0FBYyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztXQUN4RSxDQUFDLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEtBQUssQ0FBQztlQUNqQyxDQUFDLENBQUMsTUFBQSxTQUFTLENBQUMsQ0FBQyxDQUFDLDBDQUFHLENBQUMsQ0FBQyxFQUFFLE1BQUEsU0FBUyxDQUFDLENBQUMsQ0FBQywwQ0FBRyxDQUFDLENBQUMsRUFBRSxNQUFBLFNBQVMsQ0FBQyxDQUFDLENBQUMsMENBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBQSxTQUFTLENBQUMsQ0FBQyxDQUFDLDBDQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUM7ZUFDcEcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFBLE1BQUEsU0FBUyxDQUFDLENBQUMsQ0FBQywwQ0FBRyxDQUFDLENBQUMsSUFBRyxDQUFDLENBQUMsR0FBRyxNQUFNLElBQUksSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFBLFNBQVMsQ0FBQyxDQUFDLENBQUMsMENBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxNQUFNO2VBQ2hGLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBQSxTQUFTLENBQUMsQ0FBQyxDQUFDLDBDQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsTUFBTSxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQSxNQUFBLFNBQVMsQ0FBQyxDQUFDLENBQUMsMENBQUcsQ0FBQyxDQUFDLElBQUcsQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUM7V0FDdEYsQ0FBQyxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsRUFBRSxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsb0JBQW9CLG1DQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNqRyxPQUFPLFNBQVMsQ0FBQztJQUNyQixDQUFDO0lBQ0QsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxXQUM1QyxPQUFBLElBQUksQ0FBQyxPQUFPLEtBQUssS0FBSyxJQUFJLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUEsRUFBQSxDQUFDLENBQUM7SUFDdkQsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUVqRixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssV0FBVyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQzFELElBQUksWUFBWSxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksd0JBQXdCLENBQUMsSUFBSSxDQUFDO1lBQUUsT0FBTyxTQUFTLENBQUM7UUFDbEYsTUFBTSxJQUFJLEdBQUcsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzdCLE1BQU0sSUFBSSxHQUFHLE1BQUEsTUFBQSxJQUFJLENBQUMsU0FBUywwQ0FBRSxXQUFXLEVBQUUsbUNBQUksTUFBTSxDQUFDO1FBQ3JELE1BQU0sS0FBSyxHQUFHLE1BQUEsSUFBSSxDQUFDLG9CQUFvQixtQ0FDaEMsQ0FBQyxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsRUFBRSxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsRUFBRSxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsRUFBRSxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsQ0FBQyxDQUFDO1FBQ3hHLE9BQU8sSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPO2VBQ3JCLE9BQU8sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDO2VBQ3RCLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUM7ZUFDOUIsSUFBSSxDQUFDLGNBQWMsS0FBSyxTQUFTO2VBQ2pDLENBQUMsQ0FBQyxJQUFJLENBQUMsT0FBTyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDO2VBQzVFLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsS0FBSyxDQUFDO2VBQ3pCLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsUUFBUSxtQ0FBSSxDQUFDLENBQUMsSUFBSSxJQUFJO2VBQ3BDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxJQUFJLENBQUMsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7ZUFDeEUsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQztZQUMxQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVE7WUFDZixDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ3BCLENBQUM7SUFFRCxJQUFJLENBQUMseUJBQXlCLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7V0FDdEMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQztXQUMxQixDQUFDLFdBQVc7V0FDWixJQUFJLENBQUMsT0FBTyxHQUFHLEtBQUssRUFBRSxDQUFDO1FBQzFCLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQy9CLE9BQU8sS0FBSyxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxJQUFJLFdBQVcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDO1FBQ3ZFLENBQUMsQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ2pELENBQUM7QUFFRDs7O0dBR0c7QUFDSCxTQUFnQixzQkFBc0IsQ0FBQyxJQUFlOztJQUNsRCxNQUFNLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN0QyxJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxpQkFBaUIsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoRSxPQUFPLFNBQVMsQ0FBQztJQUNyQixDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3ZELE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUMxQyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDOUUsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLFdBQVcsR0FBRyxJQUFJLElBQUksS0FBSyxHQUFHLElBQUksQ0FBQyxFQUFFLEdBQUcsQ0FBQyxHQUFHLElBQUksRUFBRSxDQUFDO1lBQ2hFLE9BQU8sU0FBUyxDQUFDO1FBQ3JCLENBQUM7SUFDTCxDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQzVCLE1BQU0sS0FBSyxHQUFHLE1BQUEsSUFBSSxDQUFDLG9CQUFvQixtQ0FDaEM7WUFDQyxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUM7WUFDdEIsTUFBQSxJQUFJLENBQUMsWUFBWSxtQ0FBSSxDQUFDO1lBQ3RCLE1BQUEsSUFBSSxDQUFDLFlBQVksbUNBQUksQ0FBQztZQUN0QixNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUM7U0FDekIsQ0FBQztRQUNOLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDeEMsT0FBTyxTQUFTLENBQUM7UUFDckIsQ0FBQztJQUNMLENBQUM7SUFDRCxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLFdBQzVDLE9BQUEsSUFBSSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxNQUFBLElBQUksQ0FBQyxPQUFPLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQSxFQUFBLENBQUMsQ0FBQztJQUN2RCxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxZQUFZLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsV0FDM0UsT0FBQSxNQUFNLENBQUMsT0FBTyxLQUFLLEtBQUssSUFBSSxDQUFDLE1BQUEsTUFBTSxDQUFDLE9BQU8sbUNBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFBLEVBQUEsQ0FBQyxDQUFDO0lBQzNELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxPQUFPLEtBQUssS0FBSyxDQUFDLENBQUM7SUFDakYsSUFBSSxZQUFZLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxnQkFBZ0IsSUFBSSxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3BFLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDN0IsSUFBSSxDQUFDLE1BQUEsSUFBSSxDQUFDLE9BQU8sbUNBQUksQ0FBQyxDQUFDLEdBQUcsS0FBSztXQUN4QixJQUFJLENBQUMsR0FBRyxDQUFDLE1BQUEsSUFBSSxDQUFDLFFBQVEsbUNBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSTtXQUNuQyxDQUFDLElBQUksQ0FBQyxTQUFTLElBQUksQ0FBQyxDQUFDLFFBQVEsRUFBRSxjQUFjLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUM5RSxPQUFPLFNBQVMsQ0FBQztJQUNyQixDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzFCLE1BQU0sT0FBTyxHQUFHLE1BQUEsSUFBSSxDQUFDLE9BQU8sbUNBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUMvQyxNQUFNLGtCQUFrQixHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxLQUFLLGFBQWEsQ0FBQztlQUN0RSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJO2VBQzFCLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUk7ZUFDMUIsQ0FBQyxJQUFJLENBQUMsbUJBQW1CLElBQUksSUFBSSxDQUFDLG1CQUFtQixLQUFLLE9BQU8sQ0FBQztlQUNsRSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsSUFBSSxJQUFJLENBQUMsaUJBQWlCLEtBQUssT0FBTyxDQUFDLENBQUM7UUFDdEUsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO1lBQ3JCLE9BQU8sU0FBUyxDQUFDO1FBQ3JCLENBQUM7SUFDTCxDQUFDO0lBQ0QsT0FBTyxNQUFNLENBQUM7QUFDbEIsQ0FBQztBQUVELFNBQVMsaUJBQWlCLENBQUMsSUFBZTtJQUN0QyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsT0FBTyxLQUFLLEtBQUssQ0FBQyxDQUFDO0FBQ25FLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxJQUFlO0lBQ3BDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsV0FBQyxPQUFBLElBQUksQ0FBQyxPQUFPLEtBQUssS0FBSyxJQUFJLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUEsRUFBQSxDQUFDLENBQUM7SUFDN0YsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxXQUFDLE9BQUEsTUFBTSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxNQUFBLE1BQU0sQ0FBQyxPQUFPLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQSxFQUFBLENBQUMsQ0FBQztJQUN2RyxNQUFNLG1CQUFtQixHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUM1QyxJQUFJLENBQUMsSUFBSSxLQUFLLGtCQUFrQixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssa0JBQWtCLENBQUMsQ0FBQztJQUMxRSxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsb0JBQW9CO1FBQzNDLENBQUMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUM7UUFDeEYsQ0FBQyxDQUFDLEtBQUssQ0FBQztJQUNaLE9BQU8sS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO1dBQ2hCLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQztXQUNsQixtQkFBbUI7V0FDbkIsYUFBYTtXQUNiLE9BQU8sQ0FBQyxPQUFPLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxXQUFXLElBQUksSUFBSSxDQUFDLFdBQVcsS0FBSyxRQUFRLENBQUMsQ0FBQztBQUN4RixDQUFDO0FBRUQsU0FBZ0Isb0JBQW9CLENBQUMsSUFBZTtJQUNoRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDO0lBQzdCLElBQUksQ0FBQyxJQUFJLElBQUksSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQzNCLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLE9BQU8sS0FBSyxLQUFLLENBQUMsQ0FBQztJQUNqRixJQUFJLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsS0FBSyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQzFFLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLG1CQUFtQixHQUFHLElBQUksS0FBSyxNQUFNLElBQUksSUFBSSxDQUFDLFVBQVUsS0FBSyxNQUFNLENBQUM7SUFDMUUsSUFBSSxDQUFDLG1CQUFtQixFQUFFLENBQUM7UUFDdkIsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUNELE1BQU0sTUFBTSxHQUFHLGVBQWU7U0FDekIsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsbUJBQW1CLENBQUM7U0FDekMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUEwRCxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDL0YsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLGVBQWUsQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNoRSxPQUFPLFNBQVMsQ0FBQztJQUNyQixDQUFDO0lBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2xELE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNwRCxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNwRSxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2RSxPQUFPLFlBQVksSUFBSSxhQUFhLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQzlELENBQUM7QUFFRCxTQUFnQixTQUFTLENBQUMsSUFBZTs7SUFDckMsSUFBSSxNQUFBLElBQUksQ0FBQyxVQUFVLDBDQUFFLElBQUksRUFBRTtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBQzNDLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLEVBQUUsQ0FBQztRQUN2QixPQUFPLE9BQU8sQ0FBQztJQUNuQixDQUFDO0lBQ0Qsc0VBQXNFO0lBQ3RFLHdFQUF3RTtJQUN4RSxnRUFBZ0U7SUFDaEUsTUFBTSxpQkFBaUIsR0FBRyxNQUFBLE1BQUEsSUFBSSxDQUFDLGlCQUFpQiwwQ0FBRSxJQUFJLEdBQUcsV0FBVyxFQUFFLG1DQUFJLEVBQUUsQ0FBQztJQUM3RSxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxFQUFFLENBQUM7UUFDakQsT0FBTyxZQUFZLENBQUM7SUFDeEIsQ0FBQztJQUNELElBQUksc0JBQXNCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3pDLE9BQU8sUUFBUSxDQUFDO0lBQ3BCLENBQUM7SUFDRCxJQUFJLG9CQUFvQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDN0IsT0FBTyxRQUFRLENBQUM7SUFDcEIsQ0FBQztJQUNELElBQUksZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqQyxPQUFPLE1BQU0sQ0FBQztJQUNsQixDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDcEIsQ0FBQztBQUVELFNBQWdCLDZCQUE2QixDQUFDLElBQWU7SUFDekQsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsaUJBQWlCLENBQUMsS0FBSyxDQUFDO1dBQ3RELGdCQUFnQixDQUFDLEtBQUssQ0FBQztXQUN2Qiw2QkFBNkIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ2pELENBQUM7QUFFRCwrRUFBK0U7QUFDL0UsU0FBZ0IsbUJBQW1CLENBQUMsSUFBaUM7SUFDakUsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLFdBQUMsT0FBQSxPQUFPLENBQUMsTUFBQSxLQUFLLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUUsQ0FBQyxJQUFJLG1CQUFtQixDQUFDLEtBQUssQ0FBQyxDQUFBLEVBQUEsQ0FBQyxDQUFDO0FBQzFHLENBQUM7QUFFRCxTQUFnQix1QkFBdUIsQ0FBQyxJQUFlLEVBQUUsTUFBTSxHQUFHLEtBQUs7O0lBQ25FLE9BQU8sQ0FBQyxNQUFNO1dBQ1AsQ0FBQyxDQUFBLE1BQUEsSUFBSSxDQUFDLFVBQVUsMENBQUUsSUFBSSxFQUFFLENBQUE7V0FDeEIsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLENBQUM7V0FDMUIsSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNO1dBQ3BCLElBQUEscUNBQW9CLEVBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztXQUMvQixDQUFDLDZCQUE2QixDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ2hELENBQUM7QUFFRCxTQUFnQixXQUFXLENBQUMsSUFBZSxFQUFFLE1BQU0sR0FBRyxLQUFLOztJQUN2RCxJQUFJLENBQUEsTUFBQSxJQUFJLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUUsS0FBSSxtQkFBbUIsQ0FBQyxJQUFJLENBQUM7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUM1RSxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7UUFDdkIsdUVBQXVFO1FBQ3ZFLG9FQUFvRTtRQUNwRSxvRUFBb0U7UUFDcEUsV0FBVztRQUNYLE9BQU8sVUFBVSxDQUFDO0lBQ3RCLENBQUM7SUFDRCxJQUFJLGdCQUFnQixDQUFDLElBQUksQ0FBQztRQUFFLE9BQU8sUUFBUSxDQUFDO0lBQzVDLElBQUksZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDbkQsT0FBTyxRQUFRLENBQUM7SUFDcEIsQ0FBQztJQUNELElBQUksdUJBQXVCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDeEMsT0FBTyxRQUFRLENBQUM7SUFDcEIsQ0FBQztJQUNELElBQUksZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDdkIsT0FBTyxVQUFVLENBQUM7UUFDdEIsQ0FBQztRQUNELE9BQU8sZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxJQUFJLGVBQWUsQ0FBQyxJQUFJLENBQUM7WUFDNUUsQ0FBQyxDQUFDLFFBQVE7WUFDVixDQUFDLENBQUMsVUFBVSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxJQUFJLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3JCLE9BQU8sUUFBUSxDQUFDO0lBQ3BCLENBQUM7SUFDRCxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDdkQsT0FBTyxlQUFlLENBQUMsSUFBSSxDQUFDLElBQUksaUJBQWlCLENBQUMsSUFBSSxDQUFDLElBQUksZUFBZSxDQUFDLElBQUksQ0FBQztZQUM1RSxDQUFDLENBQUMsUUFBUTtZQUNWLENBQUMsQ0FBQyxVQUFVLENBQUM7SUFDckIsQ0FBQztJQUNELE9BQU8sUUFBUSxDQUFDO0FBQ3BCLENBQUM7QUFFRCxTQUFnQixtQkFBbUIsQ0FBQyxJQUFpQztJQUNqRSxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsT0FBTyxLQUFLLEtBQUssSUFBSSxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ2hHLENBQUM7QUFFRCxTQUFTLGlCQUFpQixDQUFDLElBQWU7O0lBQ3RDLE1BQU0saUJBQWlCLEdBQUcsTUFBQSxNQUFBLElBQUksQ0FBQyxpQkFBaUIsMENBQUUsSUFBSSxHQUFHLFdBQVcsRUFBRSxtQ0FBSSxFQUFFLENBQUM7SUFDN0UsT0FBTyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsaUJBQWlCLENBQUMsQ0FBQztBQUMxRCxDQUFDO0FBRUQsU0FBUyxvQkFBb0IsQ0FBQyxJQUFlO0lBQ3pDLElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksSUFBSSxDQUFDLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUM5QyxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDO0lBQ3ZDLE9BQU8sQ0FBQyxLQUFLLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzNELENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFDLElBQWU7SUFDMUMsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM5QixPQUFPLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7V0FDNUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztXQUM1QixpQkFBaUIsQ0FBQyxJQUFJLENBQUM7V0FDdkIsT0FBTyxDQUFDLG9CQUFvQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDL0MsQ0FBQztBQUVEOzs7O0dBSUc7QUFDSCxTQUFTLHdCQUF3QixDQUFDLElBQWU7O0lBQzdDLElBQUksTUFBQSxJQUFJLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUU7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN6QyxJQUFJLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUM5QixPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU07V0FDakIsb0JBQW9CLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztXQUMvQixxQkFBcUIsQ0FBQyxJQUFJLENBQUM7V0FDM0IsZUFBZSxDQUFDLElBQUksQ0FBQztXQUNyQixpQkFBaUIsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQzdCLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLHdCQUF3QixDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsdUJBQXVCLENBQUMsSUFBZTtJQUM1QyxJQUFJLENBQUMsb0JBQW9CLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLEVBQUUsQ0FBQztRQUN0RCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxXQUM1QyxPQUFBLElBQUksQ0FBQyxPQUFPLEtBQUssS0FBSyxJQUFJLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUEsRUFBQSxDQUFDLENBQUM7SUFDdkQsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsWUFBWSxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLFdBQzNFLE9BQUEsTUFBTSxDQUFDLE9BQU8sS0FBSyxLQUFLLElBQUksQ0FBQyxNQUFBLE1BQU0sQ0FBQyxPQUFPLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQSxFQUFBLENBQUMsQ0FBQztJQUMzRCxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsT0FBTyxLQUFLLEtBQUssQ0FBQyxDQUFDO0lBQ2pGLElBQUksY0FBYyxJQUFJLGdCQUFnQixJQUFJLGdCQUFnQixJQUFJLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQy9FLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUFDRCxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNsQyxPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQ0QsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0FBQ3ZELENBQUM7QUFFRCxTQUFnQix3QkFBd0IsQ0FBQyxJQUFlLEVBQUUsTUFBZTs7SUFDckUsSUFBSSxNQUFNO1lBQ0gsTUFBQSxJQUFJLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUUsQ0FBQTtXQUN2QixtQkFBbUIsQ0FBQyxJQUFJLENBQUM7V0FDekIsQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7V0FDL0IsQ0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDO1dBQ2hDLGVBQWUsQ0FBQyxJQUFJLENBQUM7V0FDckIsaUJBQWlCLENBQUMsSUFBSSxDQUFDO1dBQ3ZCLENBQUMsSUFBQSxxQ0FBb0IsRUFBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksNkJBQTZCLENBQUMsSUFBSSxDQUFDLENBQUM7V0FDeEUscUJBQXFCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNqQyxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0Qsd0VBQXdFO0lBQ3hFLHdFQUF3RTtJQUN4RSx5RUFBeUU7SUFDekUsb0VBQW9FO0lBQ3BFLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLEtBQUssS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6RCxPQUFPLEtBQUssQ0FBQztJQUNqQixDQUFDO0lBQ0QsTUFBTSxlQUFlLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUNuRSxPQUFPLGVBQWUsQ0FBQyxNQUFNLEdBQUcsQ0FBQztXQUMxQixlQUFlLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDLG9CQUFvQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztXQUNuRSxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLENBQUM7V0FDL0MsZUFBZSxDQUFDLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0FBQ3pELENBQUM7QUFFRCxTQUFnQixnQkFBZ0IsQ0FBQyxJQUFlOztJQUM1QyxPQUFPLENBQUMsQ0FBQSxNQUFBLElBQUksQ0FBQyxVQUFVLDBDQUFFLElBQUksRUFBRSxDQUFBLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxJQUFJLENBQUMsSUFBSSxPQUFPLENBQUMsSUFBQSwwQkFBZ0IsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3JHLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FDZixJQUFlLEVBQ2YseUJBQWtDLEVBQ2xDLGtCQUEyQixFQUMzQixvQkFBNkIsRUFDN0IsTUFBZTs7SUFFZixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsT0FBTztRQUN6QixDQUFDLENBQUMsU0FBUztRQUNYLENBQUMsQ0FBQyx3Q0FBd0MsQ0FBQztJQUMvQyxNQUFNLFlBQVksR0FBRyxDQUFDLE9BQWdCLEVBQXNCLEVBQUUsQ0FDMUQsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFrQixFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLFNBQVMsQ0FBQztJQUMvRixJQUFJLE1BQUEsSUFBSSxDQUFDLFVBQVUsMENBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQztRQUMxQixPQUFPLFlBQVksQ0FBQyxlQUFlLElBQUksQ0FBQyxVQUFVLEtBQUssSUFBQSxvQ0FBbUIsRUFBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsc0JBQXNCLGlCQUFpQixDQUFDLENBQUM7SUFDNUosQ0FBQztJQUNELElBQUksbUJBQW1CLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUM1QixPQUFPLFlBQVksQ0FBQyxvQ0FBb0MsQ0FBQyxDQUFDO0lBQzlELENBQUM7SUFDRCxJQUFJLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLENBQUM7UUFDNUIsT0FBTyxZQUFZLENBQUMsa0JBQWtCLENBQUMsQ0FBQztJQUM1QyxDQUFDO0lBQ0QsSUFBSSxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE9BQU8sWUFBWSxDQUFDLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDO1lBQ3hDLENBQUMsQ0FBQyw4QkFBOEI7WUFDaEMsQ0FBQyxDQUFDLGNBQWMsQ0FBQztjQUNmLGtEQUFrRCxDQUFDLENBQUM7SUFDOUQsQ0FBQztJQUNELElBQUkseUJBQXlCLEVBQUUsQ0FBQztRQUM1QixPQUFPLFlBQVksQ0FBQyx3REFBd0QsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7SUFDRCxJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDMUIsT0FBTyxZQUFZLENBQUMsSUFBQSwwQkFBZ0IsRUFBQyxJQUFJLENBQUM7WUFDdEMsQ0FBQyxDQUFDLHlEQUF5RDtZQUMzRCxDQUFDLENBQUMseURBQXlELENBQUMsQ0FBQztJQUNyRSxDQUFDO0lBQ0QsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU0sSUFBSSxJQUFBLHFDQUFvQixFQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3JFLElBQUksZ0JBQWdCLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUN6QixPQUFPLFlBQVksQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO1FBQ25ELENBQUM7UUFDRCxJQUFJLDZCQUE2QixDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDdEMsT0FBTyxZQUFZLENBQUMsaUNBQWlDLENBQUMsQ0FBQztRQUMzRCxDQUFDO1FBQ0QsSUFBSSxvQkFBb0IsRUFBRSxDQUFDO1lBQ3ZCLE9BQU8sWUFBWSxDQUFDLDhDQUE4QyxDQUFDLENBQUM7UUFDeEUsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLElBQUksQ0FBQyxTQUFTLElBQUksQ0FBQyxDQUFDLFFBQVEsRUFBRSxjQUFjLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7UUFDekUsT0FBTyxZQUFZLENBQUMsUUFBUSxJQUFJLENBQUMsU0FBUyxRQUFRLENBQUMsQ0FBQztJQUN4RCxDQUFDO0lBQ0QsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO1FBQ3JCLE9BQU8sWUFBWSxDQUFDLHFEQUFxRCxDQUFDLENBQUM7SUFDL0UsQ0FBQztJQUNELElBQUksZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNO1dBQ25ELENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxJQUFJLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDakYsT0FBTyxZQUFZLENBQUMseUJBQXlCLENBQUMsQ0FBQztJQUNuRCxDQUFDO0lBQ0QsT0FBTyxZQUFZLEVBQUUsQ0FBQztBQUMxQixDQUFDO0FBRUQsU0FBUyxNQUFNLENBQUMsSUFBZSxFQUFFLE1BQWU7O0lBQzVDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxtQkFBbUIsQ0FBQztJQUN2QyxNQUFNLGNBQWMsR0FBRyxPQUFPLENBQUMsTUFBQSxJQUFJLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUUsQ0FBQyxJQUFJLG1CQUFtQixDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3JGLE1BQU0sYUFBYSxHQUFHLGNBQWMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFBLDBCQUFnQixFQUFDLElBQUksQ0FBQyxDQUFDO0lBQzFFLE1BQU0sY0FBYyxHQUFHLFdBQVcsQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDakQsTUFBTSx5QkFBeUIsR0FBRyxjQUFjLEtBQUssUUFBUTtXQUN0RCxDQUFDLGNBQWM7V0FDZixJQUFJLENBQUMsSUFBSSxLQUFLLE1BQU07V0FDcEIsQ0FBQyxhQUFhO1dBQ2QsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzdCLE1BQU0sa0JBQWtCLEdBQUcsd0JBQXdCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ2xFLE1BQU0sb0JBQW9CLEdBQUcsdUJBQXVCLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ25FLE1BQU0sYUFBYSxHQUFHLGNBQWMsS0FBSyxRQUFRO1dBQzFDLENBQUMsY0FBYztXQUNmLENBQUMsT0FBTyxDQUFDLGFBQWEsQ0FBQyxJQUFJLHlCQUF5QixJQUFJLGlCQUFpQixDQUFDLElBQUksQ0FBQyxJQUFJLGtCQUFrQixJQUFJLG9CQUFvQixDQUFDLENBQUM7SUFDdEksT0FBTztRQUNILEVBQUUsRUFBRSxJQUFJLENBQUMsRUFBRTtRQUNYLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTtRQUNmLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTtRQUNmLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztRQUNyQixLQUFLLEVBQUUsTUFBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsS0FBSyxtQ0FBSSxDQUFDO1FBQ3hCLE1BQU0sRUFBRSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxNQUFNLG1DQUFJLENBQUM7UUFDMUIsTUFBTSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxjQUFjO1FBQ2pELElBQUksRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDO1FBQ3JCLGFBQWE7UUFDYixjQUFjLEVBQUUsT0FBTyxDQUFDLGFBQWEsQ0FBQztRQUN0QyxTQUFTLEVBQUUsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLElBQUk7UUFDOUIsTUFBTSxFQUFFLENBQUEsTUFBQSxJQUFJLENBQUMsVUFBVSwwQ0FBRSxJQUFJLEVBQUUsRUFBQyxDQUFDLENBQUMsa0JBQWtCLENBQUMsQ0FBQyxDQUFDLFNBQVM7UUFDaEUsT0FBTyxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUUsa0JBQWtCLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxDQUFDO1FBQ3RHLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztLQUMvRCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQWdCLFdBQVcsQ0FBQyxLQUFrQjtJQUMxQyxPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNuRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBGaWdtYU5vZGUsIEltcG9ydEFjdGlvbiwgTm9kZUtpbmQsIFRyZWVOb2RlRHRvIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBhbmFseXplU2xpY2VHcmlkIH0gZnJvbSAnLi9zbGljaW5nJztcclxuaW1wb3J0IHsgaXNNZXJnZWRSZXNvdXJjZU5hbWUsIHByZWZhYlVzZXNGaWdtYVNpemUgfSBmcm9tICcuLi9pbXBvcnQtYWN0aW9ucyc7XHJcblxyXG5jb25zdCBDT05UQUlORVJfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdET0NVTUVOVCcsXHJcbiAgICAnQ0FOVkFTJyxcclxuICAgICdGUkFNRScsXHJcbiAgICAnR1JPVVAnLFxyXG4gICAgJ1NFQ1RJT04nLFxyXG4gICAgJ0NPTVBPTkVOVCcsXHJcbiAgICAnQ09NUE9ORU5UX1NFVCcsXHJcbiAgICAnSU5TVEFOQ0UnLFxyXG5dKTtcclxuXHJcbmNvbnN0IFZFQ1RPUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ1ZFQ1RPUicsXHJcbiAgICAnQk9PTEVBTl9PUEVSQVRJT04nLFxyXG4gICAgJ1NUQVInLFxyXG4gICAgJ0xJTkUnLFxyXG4gICAgJ1JFR1VMQVJfUE9MWUdPTicsXHJcbiAgICAvLyBGaWdtYSByZXByZXNlbnRzIGJhc2ljIHNoYXBlIGxheWVycyBhcyB2ZWN0b3IgZ2VvbWV0cnkgdG9vLiBLZWVwaW5nXHJcbiAgICAvLyB0aGVtIGluIHRoZSByYXN0ZXIgcGF0aCBwcmV2ZW50cyBjYy5HcmFwaGljcyBmcm9tIGFwcHJveGltYXRpbmcgdGhlbS5cclxuICAgICdSRUNUQU5HTEUnLFxyXG4gICAgJ0VMTElQU0UnLFxyXG5dKTtcclxuXHJcbmNvbnN0IFNMSUNFX1JFQ1RBTkdMRV9OQU1FID0gL15SZWN0YW5nbGUoPzpbXFxzXy1dKlxcZCspPyQvaTtcclxuY29uc3QgU1RSVUNUVVJFRF9OT0RFX05BTUUgPSAvXltBLVphLXpdW0EtWmEtejAtOV0qKD86X1tBLVphLXowLTldKykrJC87XHJcbmNvbnN0IFNFTUFOVElDX05PREVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnxpbWd8aW1hZ2V8aWNvbnxiZ3xzcHJpdGV8dHh0fHRleHR8bGFiZWwpX1tcXHB7TH1cXHB7Tn1dKyg/Ol9bXFxwe0x9XFxwe059XSspKiQvaXU7XHJcbmNvbnN0IFJVTlRJTUVfUk9MRV9OQU1FID0gL14oPzpwYW5lbHxsaXN0fGxheW91dHxidG58YnV0dG9ufHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBFWEFDVF9TRU1BTlRJQ19OQU1FUyA9IG5ldyBTZXQoWyd2aWV3JywgJ2NvbnRlbnQnXSk7XHJcbmNvbnN0IEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TID0gbmV3IFNldChbXHJcbiAgICAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUxfU0NST0xMSU5HJyxcclxuICAgICdIT1JJWk9OVEFMJyxcclxuICAgICdWRVJUSUNBTCcsXHJcbiAgICAnQk9USCcsXHJcbl0pO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzVmVjdG9yTm9kZShub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ3R5cGUnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIFZFQ1RPUl9UWVBFUy5oYXMobm9kZS50eXBlKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzU3RydWN0dXJlZE5vZGVOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5hbWUgIT09IG5hbWUudHJpbSgpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIEVYQUNUX1NFTUFOVElDX05BTUVTLmhhcyhuYW1lLnRvTG93ZXJDYXNlKCkpXHJcbiAgICAgICAgfHwgU1RSVUNUVVJFRF9OT0RFX05BTUUudGVzdChuYW1lKVxyXG4gICAgICAgIHx8IFNFTUFOVElDX05PREVfTkFNRS50ZXN0KG5hbWUpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNOYW1lZFNsaWNlR3JvdXAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gKG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSAzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSA5KVxyXG4gICAgICAgICYmIG5vZGUuY2hpbGRyZW4uZXZlcnkoKGNoaWxkKSA9PiBTTElDRV9SRUNUQU5HTEVfTkFNRS50ZXN0KGNoaWxkLm5hbWUudHJpbSgpKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNNYW51YWxFeHBvcnQobm9kZTogUGljazxGaWdtYU5vZGUsICdoYXNFeHBvcnRTZXR0aW5ncyc+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5oYXNFeHBvcnRTZXR0aW5ncztcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzVmlzaWJsZUltYWdlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuZmlsbHMuc29tZSgoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZVxyXG4gICAgICAgICYmIChmaWxsLnR5cGUgPT09ICdJTUFHRScgfHwgZmlsbC50eXBlID09PSAnUEFUVEVSTicpKTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBUaWxlZFBhaW50U291cmNlIHtcclxuICAgIGtpbmQ6ICdpbWFnZS1yZWYnIHwgJ3NvdXJjZS1ub2RlJztcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdGlsZWRQYWludFNvdXJjZShub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2ZpbGxzJz4pOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3QgZmlsbCBvZiBub2RlLmZpbGxzKSB7XHJcbiAgICAgICAgaWYgKGZpbGwudmlzaWJsZSA9PT0gZmFsc2UgfHwgKGZpbGwub3BhY2l0eSA/PyAxKSA8PSAwKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBzY2FsZSA9IHR5cGVvZiBmaWxsLnNjYWxpbmdGYWN0b3IgPT09ICdudW1iZXInXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShmaWxsLnNjYWxpbmdGYWN0b3IpXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGluZ0ZhY3RvciA+IDBcclxuICAgICAgICAgICAgPyBmaWxsLnNjYWxpbmdGYWN0b3JcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJyAmJiBmaWxsLnNvdXJjZU5vZGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnc291cmNlLW5vZGUnLCBpZDogZmlsbC5zb3VyY2VOb2RlSWQsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChmaWxsLnR5cGUgPT09ICdJTUFHRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPT09ICdUSUxFJ1xyXG4gICAgICAgICAgICAmJiBmaWxsLmltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IGtpbmQ6ICdpbWFnZS1yZWYnLCBpZDogZmlsbC5pbWFnZVJlZiwgc2NhbGUgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzVGlsZWRJbWFnZUZpbGwobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbih0aWxlZFBhaW50U291cmNlKG5vZGUpKTtcclxufVxyXG5cclxuY29uc3QgUkFXX0lNQUdFX0NPTlRBSU5FUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0ZSQU1FJyxcclxuICAgICdHUk9VUCcsXHJcbiAgICAnQ09NUE9ORU5UJyxcclxuICAgICdJTlNUQU5DRScsXHJcbl0pO1xyXG5cclxuZnVuY3Rpb24gaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCkpXHJcbiAgICAgICAgfHwgbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVzTWF0Y2gobGVmdDogRmlnbWFOb2RlLCByaWdodDogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBhID0gbGVmdC5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgYiA9IHJpZ2h0LmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBmYWxzZTtcclxuICAgIGNvbnN0IGVwc2lsb24gPSAwLjU7XHJcbiAgICByZXR1cm4gTWF0aC5hYnMoYS54IC0gYi54KSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS55IC0gYi55KSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS53aWR0aCAtIGIud2lkdGgpIDw9IGVwc2lsb25cclxuICAgICAgICAmJiBNYXRoLmFicyhhLmhlaWdodCAtIGIuaGVpZ2h0KSA8PSBlcHNpbG9uO1xyXG59XHJcblxyXG4vKipcclxuICogUmV0dXJucyB0aGUgb3JpZ2luYWwgSU1BR0UgcGFpbnQgZm9yIGEgdmlzdWFsbHkgcGxhaW4gaW1hZ2Ugbm9kZS9zdWJ0cmVlLlxyXG4gKiBUaGlzIGlzIHVzZWQgZm9yIGVmZmVjdGl2ZWx5LWhpZGRlbiBsYXllcnMgYmVjYXVzZSBGaWdtYSdzIHJlbmRlcmVkLWltYWdlXHJcbiAqIGVuZHBvaW50IHByb2R1Y2VzIGEgdHJhbnNwYXJlbnQgUE5HIHdoZW4gYW55IGFuY2VzdG9yIGlzIGhpZGRlbi4gRG93bmxvYWRpbmdcclxuICogdGhlIHNvdXJjZSBJTUFHRSBwYWludCBpcyB2aXNpYmlsaXR5LWluZGVwZW5kZW50IGFuZCBwcmVzZXJ2ZXMgaXRzIHBpeGVscy5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwbGFpbkltYWdlU291cmNlUmVmKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgaWYgKE1hdGguYWJzKG5vZGUucm90YXRpb24pID4gMC4wMDAxIHx8IG5vZGUuY2xpcHNDb250ZW50XHJcbiAgICAgICAgfHwgKG5vZGUuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhub2RlLmJsZW5kTW9kZSkpXHJcbiAgICAgICAgfHwgKHRyYW5zZm9ybSAmJiAodHJhbnNmb3JtLmxlbmd0aCAhPT0gMlxyXG4gICAgICAgICAgICB8fCAhW3RyYW5zZm9ybVswXT8uWzBdLCB0cmFuc2Zvcm1bMF0/LlsxXSwgdHJhbnNmb3JtWzFdPy5bMF0sIHRyYW5zZm9ybVsxXT8uWzFdXS5ldmVyeShOdW1iZXIuaXNGaW5pdGUpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHRyYW5zZm9ybVswXT8uWzBdIC0gMSkgPiAwLjAwMDEgfHwgTWF0aC5hYnModHJhbnNmb3JtWzBdPy5bMV0pID4gMC4wMDAxXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHRyYW5zZm9ybVsxXT8uWzBdKSA+IDAuMDAwMSB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMV0/LlsxXSAtIDEpID4gMC4wMDAxKSlcclxuICAgICAgICB8fCBbbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgLi4uKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgPz8gW10pXS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDApKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVGaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudmlzaWJsZSAhPT0gZmFsc2UgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3Qgbm9Pd25WaXN1YWwgPSB2aXNpYmxlRmlsbHMubGVuZ3RoID09PSAwICYmICFoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSk7XHJcblxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1JFQ1RBTkdMRScgJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDApIHtcclxuICAgICAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSkpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgICAgICBjb25zdCBtb2RlID0gZmlsbC5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPz8gJ0ZJTEwnO1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCwgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMF07XHJcbiAgICAgICAgcmV0dXJuIGZpbGwudHlwZSA9PT0gJ0lNQUdFJ1xyXG4gICAgICAgICAgICAmJiBCb29sZWFuKGZpbGwuaW1hZ2VSZWYpXHJcbiAgICAgICAgICAgICYmIFsnRklMTCcsICdGSVQnXS5pbmNsdWRlcyhtb2RlKVxyXG4gICAgICAgICAgICAmJiBmaWxsLmltYWdlVHJhbnNmb3JtID09PSB1bmRlZmluZWRcclxuICAgICAgICAgICAgJiYgKCFmaWxsLmZpbHRlcnMgfHwgT2JqZWN0LnZhbHVlcyhmaWxsLmZpbHRlcnMpLmV2ZXJ5KCh2YWx1ZSkgPT4gdmFsdWUgPT09IDApKVxyXG4gICAgICAgICAgICAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID09PSAxXHJcbiAgICAgICAgICAgICYmIE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPD0gMWUtNlxyXG4gICAgICAgICAgICAmJiAoIWZpbGwuYmxlbmRNb2RlIHx8IFsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKGZpbGwuYmxlbmRNb2RlKSlcclxuICAgICAgICAgICAgJiYgcmFkaWkuZXZlcnkoKHJhZGl1cykgPT4gcmFkaXVzIDw9IDFlLTYpXHJcbiAgICAgICAgICAgID8gZmlsbC5pbWFnZVJlZlxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgIH1cclxuXHJcbiAgICBpZiAoIVJBV19JTUFHRV9DT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCAhPT0gMVxyXG4gICAgICAgIHx8ICFub093blZpc3VhbFxyXG4gICAgICAgIHx8IG5vZGUub3BhY2l0eSA8IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNoaWxkID0gbm9kZS5jaGlsZHJlblswXTtcclxuICAgIHJldHVybiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSAmJiAhY2hpbGQuaXNNYXNrICYmIGZyYW1lc01hdGNoKG5vZGUsIGNoaWxkKVxyXG4gICAgICAgID8gcGxhaW5JbWFnZVNvdXJjZVJlZihjaGlsZCkgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBIG5hdGl2ZSB0aWxlZCBTcHJpdGUgcmVwcmVzZW50cyBleGFjdGx5IG9uZSBwYWludC4gTGF5ZXJzIHdpdGggYWRkaXRpb25hbFxyXG4gKiB2aXN1YWxzIG9yIGRlc2NlbmRhbnRzIG11c3Qgc3RheSBvbiB0aGUgd2hvbGUtbm9kZSByYXN0ZXIgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGU6IEZpZ21hTm9kZSk6IFRpbGVkUGFpbnRTb3VyY2UgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3Qgc291cmNlID0gdGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgIGlmICghc291cmNlIHx8IG5vZGUuaGFzRXhwb3J0U2V0dGluZ3MgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgIT09ICdFTExJUFNFJyAmJiBub2RlLnR5cGUgIT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyAmJiBub2RlLmFyY0RhdGEpIHtcclxuICAgICAgICBjb25zdCBzd2VlcCA9IE1hdGguYWJzKG5vZGUuYXJjRGF0YS5lbmRpbmdBbmdsZSAtIG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKTtcclxuICAgICAgICBpZiAobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzID4gMWUtNiB8fCBzd2VlcCA8IE1hdGguUEkgKiAyIC0gMWUtNikge1xyXG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgY29uc3QgcmFkaWkgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgICAgID8/IFtcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgIF07XHJcbiAgICAgICAgaWYgKHJhZGlpLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMWUtNikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlRmlsbHMubGVuZ3RoICE9PSAxIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZUZpbGxzWzBdO1xyXG4gICAgaWYgKChmaWxsLm9wYWNpdHkgPz8gMSkgPCAwLjk5OVxyXG4gICAgICAgIHx8IE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPiAxZS02XHJcbiAgICAgICAgfHwgKGZpbGwuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJykge1xyXG4gICAgICAgIGNvbnN0IHNwYWNpbmcgPSBmaWxsLnNwYWNpbmcgPz8geyB4OiAwLCB5OiAwIH07XHJcbiAgICAgICAgY29uc3QgdW5zdXBwb3J0ZWRQYXR0ZXJuID0gKGZpbGwudGlsZVR5cGUgJiYgZmlsbC50aWxlVHlwZSAhPT0gJ1JFQ1RBTkdVTEFSJylcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy54KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy55KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgKGZpbGwuaG9yaXpvbnRhbEFsaWdubWVudCAmJiBmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpXHJcbiAgICAgICAgICAgIHx8IChmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICYmIGZpbGwudmVydGljYWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpO1xyXG4gICAgICAgIGlmICh1bnN1cHBvcnRlZFBhdHRlcm4pIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4RWZmZWN0cyhub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4UGFpbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PiBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHN0cm9rZXMgPSBub2RlLnN0cm9rZXMuZmlsdGVyKChzdHJva2UpID0+IHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHVuc3VwcG9ydGVkR3JhZGllbnQgPSBmaWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0FOR1VMQVInIHx8IGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0RJQU1PTkQnKTtcclxuICAgIGNvbnN0IHVuZXZlbkNvcm5lcnMgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgPyBuZXcgU2V0KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IE1hdGgucm91bmQocmFkaXVzICogMTAwMCkpKS5zaXplID4gMVxyXG4gICAgICAgIDogZmFsc2U7XHJcbiAgICByZXR1cm4gZmlsbHMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHN0cm9rZXMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHVuc3VwcG9ydGVkR3JhZGllbnRcclxuICAgICAgICB8fCB1bmV2ZW5Db3JuZXJzXHJcbiAgICAgICAgfHwgQm9vbGVhbihzdHJva2VzLmxlbmd0aCAmJiBub2RlLnN0cm9rZUFsaWduICYmIG5vZGUuc3Ryb2tlQWxpZ24gIT09ICdDRU5URVInKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBtb2RlID0gbm9kZS5sYXlvdXRNb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlQ2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLmxheW91dFBvc2l0aW9uaW5nID09PSAnQUJTT0xVVEUnKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBuZWVkc0dyaWRWYWxpZGF0aW9uID0gbW9kZSA9PT0gJ0dSSUQnIHx8IG5vZGUubGF5b3V0V3JhcCA9PT0gJ1dSQVAnO1xyXG4gICAgaWYgKCFuZWVkc0dyaWRWYWxpZGF0aW9uKSB7XHJcbiAgICAgICAgcmV0dXJuIG1vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSB2aXNpYmxlQ2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIE5vbk51bGxhYmxlPEZpZ21hTm9kZVsnYWJzb2x1dGVCb3VuZGluZ0JveCddPiA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoZnJhbWVzLmxlbmd0aCAhPT0gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCB8fCBmcmFtZXMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUud2lkdGgpO1xyXG4gICAgY29uc3QgaGVpZ2h0cyA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpO1xyXG4gICAgY29uc3QgdW5pZm9ybVdpZHRoID0gTWF0aC5tYXgoLi4ud2lkdGhzKSAtIE1hdGgubWluKC4uLndpZHRocykgPD0gMjtcclxuICAgIGNvbnN0IHVuaWZvcm1IZWlnaHQgPSBNYXRoLm1heCguLi5oZWlnaHRzKSAtIE1hdGgubWluKC4uLmhlaWdodHMpIDw9IDI7XHJcbiAgICByZXR1cm4gdW5pZm9ybVdpZHRoICYmIHVuaWZvcm1IZWlnaHQgPyAnR1JJRCcgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlcktpbmQobm9kZTogRmlnbWFOb2RlKTogTm9kZUtpbmQge1xyXG4gICAgaWYgKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKSByZXR1cm4gJ25vZGUnO1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYWJlbCc7XHJcbiAgICB9XHJcbiAgICAvLyBBIG5hbWUgb3IgY2xpcHBpbmcgcmVjdGFuZ2xlIGlzIG5vdCBwcm9vZiBvZiBpbnRlcmFjdGl2ZSBzY3JvbGxpbmcuXHJcbiAgICAvLyBPbmx5IEZpZ21hJ3MgZXhwbGljaXQgcHJvdG90eXBlIG92ZXJmbG93IHNldHRpbmcgbWF5IGNoYW5nZSB0aGUgQ29jb3NcclxuICAgIC8vIGhpZXJhcmNoeSB0byBTY3JvbGxWaWV3IC0+IHZpZXcgLT4gY29udGVudCBpbiBhdXRvbWF0aWMgbW9kZS5cclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICBpZiAoRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKSkge1xyXG4gICAgICAgIHJldHVybiAnc2Nyb2xsVmlldyc7XHJcbiAgICB9XHJcbiAgICBpZiAoLyhefF8pYnRuX3xidXR0b2585oyJ6ZKuL2kudGVzdChub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdidXR0b24nO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYXlvdXQnO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiAnbm9kZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3Nwcml0ZSc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBpc05hbWVkU2xpY2VHcm91cChjaGlsZClcclxuICAgICAgICB8fCBpc1BhdGNoQ2FuZGlkYXRlKGNoaWxkKVxyXG4gICAgICAgIHx8IGhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KGNoaWxkKSk7XHJcbn1cclxuXHJcbi8qKiBQcmVmYWIgcmVmZXJlbmNlcyBtdXN0IHN1cnZpdmUgYXV0b21hdGljIHJhc3RlciBib3VuZGFyaWVzLCBldmVuIGhpZGRlbi4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1ByZWZhYkRlc2NlbmRhbnQobm9kZTogUGljazxGaWdtYU5vZGUsICdjaGlsZHJlbic+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gQm9vbGVhbihjaGlsZC5wcmVmYWJOYW1lPy50cmltKCkpIHx8IGhhc1ByZWZhYkRlc2NlbmRhbnQoY2hpbGQpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZE1lcmdlUmVzb3VyY2VOb2RlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290ID0gZmFsc2UpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAhaXNSb290XHJcbiAgICAgICAgJiYgIW5vZGUucHJlZmFiTmFtZT8udHJpbSgpXHJcbiAgICAgICAgJiYgIWhhc1ByZWZhYkRlc2NlbmRhbnQobm9kZSlcclxuICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICYmIGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICAmJiAhaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckFjdGlvbihub2RlOiBGaWdtYU5vZGUsIGlzUm9vdCA9IGZhbHNlKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIGlmIChub2RlLnByZWZhYk5hbWU/LnRyaW0oKSB8fCBoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGUpKSByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIC8vIFRleHQgcmVtYWlucyBhbiBlZGl0YWJsZSBDb2NvcyBMYWJlbC4gRXZlbiB3aGVuIEZpZ21hIHJlcG9ydHMgZmlsbHMsXHJcbiAgICAgICAgLy8gc2hhZG93cywgZXhwb3J0IHNldHRpbmdzLCBvciBvdGhlciBwYWludCBkYXRhLCBleHBvcnRpbmcgYSBiaXRtYXBcclxuICAgICAgICAvLyB3b3VsZCBsb3NlIHRoZSB0ZXh0IHNlbWFudGljcyBhbmQgbWFrZSB0aGUgaW1wb3J0ZWQgVUkgaW1wb3NzaWJsZVxyXG4gICAgICAgIC8vIHRvIGVkaXQuXHJcbiAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaXNQYXRjaENhbmRpZGF0ZShub2RlKSkgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgaWYgKGhhc01hbnVhbEV4cG9ydChub2RlKSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChzaG91bGRNZXJnZVJlc291cmNlTm9kZShub2RlLCBpc1Jvb3QpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ0VMTElQU0UnIHx8IG5vZGUudHlwZSA9PT0gJ1JFQ1RBTkdMRScpIHtcclxuICAgICAgICByZXR1cm4gaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKVxyXG4gICAgICAgICAgICA/ICdyZW5kZXInXHJcbiAgICAgICAgICAgIDogJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIHJldHVybiAncmVuZGVyJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZTogUGljazxGaWdtYU5vZGUsICdjaGlsZHJlbic+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UgfHwgaGFzSGlkZGVuRGVzY2VuZGFudChjaGlsZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNFeHBsaWNpdFNjcm9sbChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICByZXR1cm4gRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNFZmZlY3RpdmVseVZpc2libGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobm9kZS52aXNpYmxlID09PSBmYWxzZSB8fCBub2RlLm9wYWNpdHkgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgcmV0dXJuICFmcmFtZSB8fCAoZnJhbWUud2lkdGggPiAwICYmIGZyYW1lLmhlaWdodCA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBuYW1lID0gbm9kZS5uYW1lLnRyaW0oKTtcclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFJVTlRJTUVfUk9MRV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBoYXNFeHBsaWNpdFNjcm9sbChub2RlKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogQSBtZXNzeSB2aXN1YWwgd3JhcHBlciBtdXN0IG5vdCBhYnNvcmIgYW4gZWRpdGFibGUgb3IgaW5kZXBlbmRlbnRseSBwbGFubmVkXHJcbiAqIGRlc2NlbmRhbnQuIFN0cnVjdHVyZWQgbmFtZXMsIHRleHQsIHNjcm9sbGluZy9sYXlvdXQgc2VtYW50aWNzLCBtYW51YWxcclxuICogZXhwb3J0cyBhbmQgc2xpY2UgZ3JvdXBzIGFsbCBuZWVkIHRvIGtlZXAgdGhlaXIgb3duIGltcG9ydCBib3VuZGFyeS5cclxuICovXHJcbmZ1bmN0aW9uIHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmIChub2RlLnByZWZhYk5hbWU/LnRyaW0oKSkgcmV0dXJuIHRydWU7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnXHJcbiAgICAgICAgfHwgaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlKSB8fCBub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhhc1Zpc2libGVGaWxsID0gbm9kZS5maWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudmlzaWJsZSAhPT0gZmFsc2UgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZVN0cm9rZSA9IG5vZGUuc3Ryb2tlV2VpZ2h0ID4gMCAmJiBub2RlLnN0cm9rZXMuc29tZSgoc3Ryb2tlKSA9PlxyXG4gICAgICAgIHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVFZmZlY3QgPSBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgaWYgKGhhc1Zpc2libGVGaWxsIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCB8fCBpc1ZlY3Rvck5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmICghQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJlbmRlck1lc3N5U3VidHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IGJvb2xlYW4ge1xyXG4gICAgaWYgKGlzUm9vdFxyXG4gICAgICAgIHx8IG5vZGUucHJlZmFiTmFtZT8udHJpbSgpXHJcbiAgICAgICAgfHwgaGFzUHJlZmFiRGVzY2VuZGFudChub2RlKVxyXG4gICAgICAgIHx8ICFDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSlcclxuICAgICAgICB8fCAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgfHwgKGlzTWVyZ2VkUmVzb3VyY2VOYW1lKG5vZGUubmFtZSkgJiYgaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSkpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgLy8gSGlkZGVuIGNoaWxkcmVuIG11c3QgcmVtYWluIGluZGVwZW5kZW50IENvY29zIG5vZGVzIHNvIHRoZWlyIEluYWN0aXZlXHJcbiAgICAvLyBzdGF0ZSBjYW4gYmUgcmVzdG9yZWQgbGF0ZXIuIEFuIGF1dG9tYXRpYyBwYXJlbnQgUE5HIHdvdWxkIGVyYXNlIHRoYXRcclxuICAgIC8vIHJ1bnRpbWUgYm91bmRhcnkuIEFuIGFscmVhZHktaGlkZGVuIGhvc3QgbWF5IHN0aWxsIHVzZSB0aGUgc2FtZSB2aXN1YWxcclxuICAgIC8vIGhldXJpc3RpYyBhcyBhIHZpc2libGUgaG9zdCB3aGVuIGl0cyBkaXJlY3QgY2hpbGRyZW4gYXJlIHZpc2libGUuXHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoaXNFZmZlY3RpdmVseVZpc2libGUpO1xyXG4gICAgcmV0dXJuIHZpc2libGVDaGlsZHJlbi5sZW5ndGggPiAwXHJcbiAgICAgICAgJiYgdmlzaWJsZUNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gIWlzU3RydWN0dXJlZE5vZGVOYW1lKGNoaWxkLm5hbWUpKVxyXG4gICAgICAgICYmICF2aXNpYmxlQ2hpbGRyZW4uc29tZShzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUpXHJcbiAgICAgICAgJiYgdmlzaWJsZUNoaWxkcmVuLnNvbWUoc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNQYXRjaENhbmRpZGF0ZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAhbm9kZS5wcmVmYWJOYW1lPy50cmltKCkgJiYgIWhhc1ByZWZhYkRlc2NlbmRhbnQobm9kZSkgJiYgQm9vbGVhbihhbmFseXplU2xpY2VHcmlkKG5vZGUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FybmluZ0ZvcihcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWU6IGJvb2xlYW4sXHJcbiAgICByZW5kZXJNZXNzeVN1YnRyZWU6IGJvb2xlYW4sXHJcbiAgICBtZXJnZVJlc291cmNlU3VidHJlZTogYm9vbGVhbixcclxuICAgIGlzUm9vdDogYm9vbGVhbixcclxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGluYWN0aXZlID0gbm9kZS52aXNpYmxlXHJcbiAgICAgICAgPyB1bmRlZmluZWRcclxuICAgICAgICA6ICdGaWdtYSDlm77lsYLlt7LpmpDol4/vvIzlr7zlhaXlkI7oioLngrnlsIblnKggQ29jb3Mg5Lit5L+d5oyBIEluYWN0aXZlJztcclxuICAgIGNvbnN0IHdpdGhJbmFjdGl2ZSA9ICh3YXJuaW5nPzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XHJcbiAgICAgICAgW2luYWN0aXZlLCB3YXJuaW5nXS5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiBCb29sZWFuKGl0ZW0pKS5qb2luKCfvvJsnKSB8fCB1bmRlZmluZWQ7XHJcbiAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKGDlvJXnlKjpobnnm64gUHJlZmFi4oCcJHtub2RlLnByZWZhYk5hbWV94oCd77yMJHtwcmVmYWJVc2VzRmlnbWFTaXplKG5vZGUucHJlZmFiTmFtZSkgPyAn5oyJIEZpZ21hIOiwg+aVtOWuvemrmCcgOiAn5oyJIEZpZ21hIOWunuS+i+ebuOWvueavjee7hOS7tueahOWAjeeOh+e8qeaUvid977yb5LiN5a+85YWl5q2k6IqC54K555qE5Y6f5aeL5YaF5a655Y+K5a2Q5qCRYCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaGFzUHJlZmFiRGVzY2VuZGFudChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WGhemDqOWtmOWcqCBQcmVmYWIg5byV55So77yM5pm66IO95qih5byP5L+d55WZ6IqC54K557uT5p6E77yM5LiN6Ieq5Yqo5ZCI5bm25Li65Zu+54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoIW5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+e8uuWwkei+ueeVjOS/oeaBr++8jOWwhuaMiSAww5cwIOWvvOWFpScpO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKChpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgICAgICA/ICfmo4DmtYvliLDmnInmlYjnmoQgMy85IOS4qiBSZWN0YW5nbGUg6L+e57ut5YiH54mH77ybJ1xyXG4gICAgICAgICAgICA6ICfmo4DmtYvliLDmnInmlYjkuIkv5Lmd5a6r5YiG54mH77ybJylcclxuICAgICAgICAgICAgKyAnRmlnbWEg5YiG54mH5LyY5YWI77yM5oyJIEZpZ21hIOWOn+Wni+i+ueeVjOWvvOWFpe+8jOaXp+etlueVpeOAgUV4cG9ydCDlkozliY3nvIDop4TliJnkuI3og73lhbPpl63liIfniYcnKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5qOA5rWL5YiwIEZpZ21hIEV4cG9ydCDorr7nva7vvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8m0ZpZ21hIOeahOagvOW8j+OAgeWQjue8gOWSjOWAjeeOh+S4jeayv+eUqCcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShhbmFseXplU2xpY2VHcmlkKG5vZGUpXHJcbiAgICAgICAgICAgID8gJ+ajgOa1i+WIsOacieaViOeahCAzLzkg5LiqIFJlY3RhbmdsZSDov57nu63liIfniYfvvIzlsIbmjIkgUE5HIOaVtOWxguWvvOWFpeOAgeiHquWKqOWQr+eUqOWIh+eJh+W5tuS8mOWFiOWkjeeUqOWQjOWQjei1hOa6kCdcclxuICAgICAgICAgICAgOiAn5qOA5rWL5YiwIDMvOSDkuKogUmVjdGFuZ2xlIOWRveWQjeiKgueCue+8jOS9huWHoOS9leacquW9ouaIkOi/nue7reWIh+eJh++8m+WwhuaMiSBQTkcg5pW05bGC5a+85YWl77yM5LiN6Ieq5Yqo5ZCv55So5YiH54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWlzUm9vdCAmJiBub2RlLnR5cGUgIT09ICdURVhUJyAmJiBpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgaWYgKGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5qOA5rWL5Yiw5pyJ5pWI5LiJL+S5neWuq+WIh+eJh++8jOWIh+eJh+etlueVpeS8mOWFiOS6juWJjee8gOWQiOW5ticpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5YmN57yA5pW05bGC5ZCI5bm25bey5YGc55So77ya5YaF6YOo5a2Y5Zyo54us56uL5LiJL+S5neWuq+i1hOa6kO+8jOS8mOWFiOS/neeVmeWIh+eJh+iDveWKmycpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobWVyZ2VSZXNvdXJjZVN1YnRyZWUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgnaWNvbl8vaW1nXyDliY3nvIDmjIkgUE5HIOaVtOWxguWQiOW5tu+8jOmHh+eUqOW9k+WJjeaYvumakOWQiOaIkO+8m+makOiXj+WtkOWxguS4jeeUn+aIkOeLrOeri+iKgueCuScpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMobm9kZS5ibGVuZE1vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShg5re35ZCI5qih5byPICR7bm9kZS5ibGVuZE1vZGV9IOWwhui/keS8vOWkhOeQhmApO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlbmRlck1lc3N5U3VidHJlZSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+aJgOacieacieaViOWPr+ingeebtOaOpeWtkOWxguWdh+S4uumdnue7k+aehOWMlue6r+inhuinieWGheWuue+8jOS4lOacquajgOa1i+WIsOaWh+Wtl+aIlui/kOihjOaXtue7k+aehO+8jOaZuuiDveaooeW8j+WwhuaMiSBQTkcg5pW05bGC5a+85YWlJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgJiYgKGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5aSN5p2C5a655Zmo5bCG5LyY5YWI5L+d55WZ5Y+v57yW6L6R5a2Q6IqC54K577yM6IOM5pmv5Lya6L+R5Ly85aSE55CGJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gd2l0aEluYWN0aXZlKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRvVHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IFRyZWVOb2RlRHRvIHtcclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcHJlZmFiQm91bmRhcnkgPSBCb29sZWFuKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKSB8fCBoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGUpO1xyXG4gICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IHByZWZhYkJvdW5kYXJ5ID8gdW5kZWZpbmVkIDogYW5hbHl6ZVNsaWNlR3JpZChub2RlKTtcclxuICAgIGNvbnN0IGluZmVycmVkQWN0aW9uID0gaW5mZXJBY3Rpb24obm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiAhcHJlZmFiQm91bmRhcnlcclxuICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICYmICFzbGljZUFuYWx5c2lzXHJcbiAgICAgICAgJiYgaGFzTWFudWFsRXhwb3J0KG5vZGUpO1xyXG4gICAgY29uc3QgcmVuZGVyTWVzc3lTdWJ0cmVlID0gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCBtZXJnZVJlc291cmNlU3VidHJlZSA9IHNob3VsZE1lcmdlUmVzb3VyY2VOb2RlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCByZW5kZXJTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgIXByZWZhYkJvdW5kYXJ5XHJcbiAgICAgICAgJiYgKEJvb2xlYW4oc2xpY2VBbmFseXNpcykgfHwgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSB8fCByZW5kZXJNZXNzeVN1YnRyZWUgfHwgbWVyZ2VSZXNvdXJjZVN1YnRyZWUpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICB3aWR0aDogZnJhbWU/LndpZHRoID8/IDAsXHJcbiAgICAgICAgaGVpZ2h0OiBmcmFtZT8uaGVpZ2h0ID8/IDAsXHJcbiAgICAgICAgYWN0aW9uOiByZW5kZXJTdWJ0cmVlID8gJ3JlbmRlcicgOiBpbmZlcnJlZEFjdGlvbixcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgcmVuZGVyU3VidHJlZSxcclxuICAgICAgICBwYXRjaENhbmRpZGF0ZTogQm9vbGVhbihzbGljZUFuYWx5c2lzKSxcclxuICAgICAgICBzbGljZU1vZGU6IHNsaWNlQW5hbHlzaXM/Lm1vZGUsXHJcbiAgICAgICAgcmVhc29uOiBub2RlLnByZWZhYk5hbWU/LnRyaW0oKSA/ICdwcmVmYWItcmVmZXJlbmNlJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB3YXJuaW5nOiB3YXJuaW5nRm9yKG5vZGUsIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUsIHJlbmRlck1lc3N5U3VidHJlZSwgbWVyZ2VSZXNvdXJjZVN1YnRyZWUsIGlzUm9vdCksXHJcbiAgICAgICAgY2hpbGRyZW46IG5vZGUuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gdG9UcmVlKGNoaWxkLCBmYWxzZSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emVUcmVlKHJvb3RzOiBGaWdtYU5vZGVbXSk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIHJvb3RzLm1hcCgocm9vdCkgPT4gdG9UcmVlKHJvb3QsIHRydWUpKTtcclxufVxyXG4iXX0=