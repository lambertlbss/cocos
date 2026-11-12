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
        return withInactive(`引用项目 Prefab“${node.prefabName}”，${node.prefabName.replace(/\.prefab$/i, '').normalize('NFKC').toLocaleLowerCase('en-US') === 'popup' ? '按 Figma 调整宽高' : '实例保持原尺寸'}；不导入此节点的原始内容及子树`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF5Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREEyQ0M7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBc0JDO0FBRUQsc0VBSUM7QUFHRCxrREFFQztBQUVELDBEQU9DO0FBRUQsa0NBaUNDO0FBRUQsa0RBRUM7QUE2REQsNERBd0JDO0FBRUQsNENBRUM7QUE4RkQsa0NBRUM7QUEvaEJELHVDQUE2QztBQUM3QyxzREFBeUQ7QUFFekQsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN6QixRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0lBQ2pCLHNFQUFzRTtJQUN0RSx3RUFBd0U7SUFDeEUsV0FBVztJQUNYLFNBQVM7Q0FDWixDQUFDLENBQUM7QUFFSCxNQUFNLG9CQUFvQixHQUFHLDZCQUE2QixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsMENBQTBDLENBQUM7QUFDeEUsTUFBTSxrQkFBa0IsR0FBRywrR0FBK0csQ0FBQztBQUMzSSxNQUFNLGlCQUFpQixHQUFHLHNGQUFzRixDQUFDO0FBQ2pILE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUMxRCxNQUFNLHVCQUF1QixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ3BDLHNC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YixhQUFhLHVCQUFiLGFBQWEsQ0FBRSxJQUFJO1FBQzlCLE1BQU0sRUFBRSxDQUFBLE1BQUEsSUFBSSxDQUFDLFVBQVUsMENBQUUsSUFBSSxFQUFFLEVBQUMsQ0FBQyxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQyxTQUFTO1FBQ2hFLE9BQU8sRUFBRSxVQUFVLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFLGtCQUFrQixFQUFFLG9CQUFvQixFQUFFLE1BQU0sQ0FBQztRQUN0RyxRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUM7S0FDL0QsQ0FBQztBQUNOLENBQUM7QUFFRCxTQUFnQixXQUFXLENBQUMsS0FBa0I7SUFDMUMsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDbkQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgRmlnbWFOb2RlLCBJbXBvcnRBY3Rpb24sIE5vZGVLaW5kLCBUcmVlTm9kZUR0byB9IGZyb20gJy4uL3R5cGVzJztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCB9IGZyb20gJy4vc2xpY2luZyc7XHJcbmltcG9ydCB7IGlzTWVyZ2VkUmVzb3VyY2VOYW1lIH0gZnJvbSAnLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBWRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG4gICAgLy8gRmlnbWEgcmVwcmVzZW50cyBiYXNpYyBzaGFwZSBsYXllcnMgYXMgdmVjdG9yIGdlb21ldHJ5IHRvby4gS2VlcGluZ1xyXG4gICAgLy8gdGhlbSBpbiB0aGUgcmFzdGVyIHBhdGggcHJldmVudHMgY2MuR3JhcGhpY3MgZnJvbSBhcHByb3hpbWF0aW5nIHRoZW0uXHJcbiAgICAnUkVDVEFOR0xFJyxcclxuICAgICdFTExJUFNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTTElDRV9SRUNUQU5HTEVfTkFNRSA9IC9eUmVjdGFuZ2xlKD86W1xcc18tXSpcXGQrKT8kL2k7XHJcbmNvbnN0IFNUUlVDVFVSRURfTk9ERV9OQU1FID0gL15bQS1aYS16XVtBLVphLXowLTldKig/Ol9bQS1aYS16MC05XSspKyQvO1xyXG5jb25zdCBTRU1BTlRJQ19OT0RFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBSVU5USU1FX1JPTEVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgRVhBQ1RfU0VNQU5USUNfTkFNRVMgPSBuZXcgU2V0KFsndmlldycsICdjb250ZW50J10pO1xyXG5jb25zdCBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1ZlY3Rvck5vZGUobm9kZTogUGljazxGaWdtYU5vZGUsICd0eXBlJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBWRUNUT1JfVFlQRVMuaGFzKG5vZGUudHlwZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cnVjdHVyZWROb2RlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGlmIChuYW1lICE9PSBuYW1lLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFNUUlVDVFVSRURfTk9ERV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBTRU1BTlRJQ19OT0RFX05BTUUudGVzdChuYW1lKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzTmFtZWRTbGljZUdyb3VwKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMyB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gOSlcclxuICAgICAgICAmJiBub2RlLmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gU0xJQ0VfUkVDVEFOR0xFX05BTUUudGVzdChjaGlsZC5uYW1lLnRyaW0oKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzTWFudWFsRXhwb3J0KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnaGFzRXhwb3J0U2V0dGluZ3MnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuaGFzRXhwb3J0U2V0dGluZ3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVJbWFnZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAoZmlsbC50eXBlID09PSAnSU1BR0UnIHx8IGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGlsZWRQYWludFNvdXJjZSB7XHJcbiAgICBraW5kOiAnaW1hZ2UtcmVmJyB8ICdzb3VyY2Utbm9kZSc7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUGFpbnRTb3VyY2Uobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogVGlsZWRQYWludFNvdXJjZSB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGwgb2Ygbm9kZS5maWxscykge1xyXG4gICAgICAgIGlmIChmaWxsLnZpc2libGUgPT09IGZhbHNlIHx8IChmaWxsLm9wYWNpdHkgPz8gMSkgPD0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgZmlsbC5zY2FsaW5nRmFjdG9yID09PSAnbnVtYmVyJ1xyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUoZmlsbC5zY2FsaW5nRmFjdG9yKVxyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxpbmdGYWN0b3IgPiAwXHJcbiAgICAgICAgICAgID8gZmlsbC5zY2FsaW5nRmFjdG9yXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicgJiYgZmlsbC5zb3VyY2VOb2RlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ3NvdXJjZS1ub2RlJywgaWQ6IGZpbGwuc291cmNlTm9kZUlkLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnVElMRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVJlZikge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnaW1hZ2UtcmVmJywgaWQ6IGZpbGwuaW1hZ2VSZWYsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbGVkSW1hZ2VGaWxsKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odGlsZWRQYWludFNvdXJjZShub2RlKSk7XHJcbn1cclxuXHJcbmNvbnN0IFJBV19JTUFHRV9DT05UQUlORVJfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdGUkFNRScsXHJcbiAgICAnR1JPVVAnLFxyXG4gICAgJ0NPTVBPTkVOVCcsXHJcbiAgICAnSU5TVEFOQ0UnLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVTdHJva2VPckVmZmVjdChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAobm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApKVxyXG4gICAgICAgIHx8IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lc01hdGNoKGxlZnQ6IEZpZ21hTm9kZSwgcmlnaHQ6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgYSA9IGxlZnQuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IGIgPSByaWdodC5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gZmFsc2U7XHJcbiAgICBjb25zdCBlcHNpbG9uID0gMC41O1xyXG4gICAgcmV0dXJuIE1hdGguYWJzKGEueCAtIGIueCkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEueSAtIGIueSkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEud2lkdGggLSBiLndpZHRoKSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS5oZWlnaHQgLSBiLmhlaWdodCkgPD0gZXBzaWxvbjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIG9yaWdpbmFsIElNQUdFIHBhaW50IGZvciBhIHZpc3VhbGx5IHBsYWluIGltYWdlIG5vZGUvc3VidHJlZS5cclxuICogVGhpcyBpcyB1c2VkIGZvciBlZmZlY3RpdmVseS1oaWRkZW4gbGF5ZXJzIGJlY2F1c2UgRmlnbWEncyByZW5kZXJlZC1pbWFnZVxyXG4gKiBlbmRwb2ludCBwcm9kdWNlcyBhIHRyYW5zcGFyZW50IFBORyB3aGVuIGFueSBhbmNlc3RvciBpcyBoaWRkZW4uIERvd25sb2FkaW5nXHJcbiAqIHRoZSBzb3VyY2UgSU1BR0UgcGFpbnQgaXMgdmlzaWJpbGl0eS1pbmRlcGVuZGVudCBhbmQgcHJlc2VydmVzIGl0cyBwaXhlbHMuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybTtcclxuICAgIGlmIChNYXRoLmFicyhub2RlLnJvdGF0aW9uKSA+IDAuMDAwMSB8fCBub2RlLmNsaXBzQ29udGVudFxyXG4gICAgICAgIHx8IChub2RlLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMobm9kZS5ibGVuZE1vZGUpKVxyXG4gICAgICAgIHx8ICh0cmFuc2Zvcm0gJiYgKHRyYW5zZm9ybS5sZW5ndGggIT09IDJcclxuICAgICAgICAgICAgfHwgIVt0cmFuc2Zvcm1bMF0/LlswXSwgdHJhbnNmb3JtWzBdPy5bMV0sIHRyYW5zZm9ybVsxXT8uWzBdLCB0cmFuc2Zvcm1bMV0/LlsxXV0uZXZlcnkoTnVtYmVyLmlzRmluaXRlKVxyXG4gICAgICAgICAgICB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMF0/LlswXSAtIDEpID4gMC4wMDAxIHx8IE1hdGguYWJzKHRyYW5zZm9ybVswXT8uWzFdKSA+IDAuMDAwMVxyXG4gICAgICAgICAgICB8fCBNYXRoLmFicyh0cmFuc2Zvcm1bMV0/LlswXSkgPiAwLjAwMDEgfHwgTWF0aC5hYnModHJhbnNmb3JtWzFdPy5bMV0gLSAxKSA+IDAuMDAwMSkpXHJcbiAgICAgICAgfHwgW25vZGUuY29ybmVyUmFkaXVzID8/IDAsIC4uLihub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpID8/IFtdKV0uc29tZSgocmFkaXVzKSA9PiByYWRpdXMgPiAwKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IG5vT3duVmlzdWFsID0gdmlzaWJsZUZpbGxzLmxlbmd0aCA9PT0gMCAmJiAhaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGUpO1xyXG5cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgaWYgKHZpc2libGVGaWxscy5sZW5ndGggIT09IDEgfHwgaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGUpKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlRmlsbHNbMF07XHJcbiAgICAgICAgY29uc3QgbW9kZSA9IGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID8/ICdGSUxMJztcclxuICAgICAgICBjb25zdCByYWRpaSA9IG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWlcclxuICAgICAgICAgICAgPz8gW25vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDBdO1xyXG4gICAgICAgIHJldHVybiBmaWxsLnR5cGUgPT09ICdJTUFHRSdcclxuICAgICAgICAgICAgJiYgQm9vbGVhbihmaWxsLmltYWdlUmVmKVxyXG4gICAgICAgICAgICAmJiBbJ0ZJTEwnLCAnRklUJ10uaW5jbHVkZXMobW9kZSlcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVRyYW5zZm9ybSA9PT0gdW5kZWZpbmVkXHJcbiAgICAgICAgICAgICYmICghZmlsbC5maWx0ZXJzIHx8IE9iamVjdC52YWx1ZXMoZmlsbC5maWx0ZXJzKS5ldmVyeSgodmFsdWUpID0+IHZhbHVlID09PSAwKSlcclxuICAgICAgICAgICAgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA9PT0gMVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApIDw9IDFlLTZcclxuICAgICAgICAgICAgJiYgKCFmaWxsLmJsZW5kTW9kZSB8fCBbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpXHJcbiAgICAgICAgICAgICYmIHJhZGlpLmV2ZXJ5KChyYWRpdXMpID0+IHJhZGl1cyA8PSAxZS02KVxyXG4gICAgICAgICAgICA/IGZpbGwuaW1hZ2VSZWZcclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKCFSQVdfSU1BR0VfQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggIT09IDFcclxuICAgICAgICB8fCAhbm9Pd25WaXN1YWxcclxuICAgICAgICB8fCBub2RlLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjaGlsZCA9IG5vZGUuY2hpbGRyZW5bMF07XHJcbiAgICByZXR1cm4gY2hpbGQudmlzaWJsZSAhPT0gZmFsc2UgJiYgIWNoaWxkLmlzTWFzayAmJiBmcmFtZXNNYXRjaChub2RlLCBjaGlsZClcclxuICAgICAgICA/IHBsYWluSW1hZ2VTb3VyY2VSZWYoY2hpbGQpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKipcclxuICogQSBuYXRpdmUgdGlsZWQgU3ByaXRlIHJlcHJlc2VudHMgZXhhY3RseSBvbmUgcGFpbnQuIExheWVycyB3aXRoIGFkZGl0aW9uYWxcclxuICogdmlzdWFscyBvciBkZXNjZW5kYW50cyBtdXN0IHN0YXkgb24gdGhlIHdob2xlLW5vZGUgcmFzdGVyIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlOiBGaWdtYU5vZGUpOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICBpZiAoIXNvdXJjZSB8fCBub2RlLmhhc0V4cG9ydFNldHRpbmdzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlICE9PSAnRUxMSVBTRScgJiYgbm9kZS50eXBlICE9PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgJiYgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgY29uc3Qgc3dlZXAgPSBNYXRoLmFicyhub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUgLSBub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSk7XHJcbiAgICAgICAgaWYgKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyA+IDFlLTYgfHwgc3dlZXAgPCBNYXRoLlBJICogMiAtIDFlLTYpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICBdO1xyXG4gICAgICAgIGlmIChyYWRpaS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDFlLTYpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gbm9kZS5maWxscy5maWx0ZXIoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgIGlmICgoZmlsbC5vcGFjaXR5ID8/IDEpIDwgMC45OTlcclxuICAgICAgICB8fCBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApID4gMWUtNlxyXG4gICAgICAgIHx8IChmaWxsLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMoZmlsbC5ibGVuZE1vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicpIHtcclxuICAgICAgICBjb25zdCBzcGFjaW5nID0gZmlsbC5zcGFjaW5nID8/IHsgeDogMCwgeTogMCB9O1xyXG4gICAgICAgIGNvbnN0IHVuc3VwcG9ydGVkUGF0dGVybiA9IChmaWxsLnRpbGVUeXBlICYmIGZpbGwudGlsZVR5cGUgIT09ICdSRUNUQU5HVUxBUicpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueCkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueSkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IChmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgJiYgZmlsbC5ob3Jpem9udGFsQWxpZ25tZW50ICE9PSAnU1RBUlQnKVxyXG4gICAgICAgICAgICB8fCAoZmlsbC52ZXJ0aWNhbEFsaWdubWVudCAmJiBmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICE9PSAnU1RBUlQnKTtcclxuICAgICAgICBpZiAodW5zdXBwb3J0ZWRQYXR0ZXJuKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleEVmZmVjdHMobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleFBhaW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBzdHJva2VzID0gbm9kZS5zdHJva2VzLmZpbHRlcigoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCB1bnN1cHBvcnRlZEdyYWRpZW50ID0gZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9BTkdVTEFSJyB8fCBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9ESUFNT05EJyk7XHJcbiAgICBjb25zdCB1bmV2ZW5Db3JuZXJzID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgID8gbmV3IFNldChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpLm1hcCgocmFkaXVzKSA9PiBNYXRoLnJvdW5kKHJhZGl1cyAqIDEwMDApKSkuc2l6ZSA+IDFcclxuICAgICAgICA6IGZhbHNlO1xyXG4gICAgcmV0dXJuIGZpbGxzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCBzdHJva2VzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCB1bnN1cHBvcnRlZEdyYWRpZW50XHJcbiAgICAgICAgfHwgdW5ldmVuQ29ybmVyc1xyXG4gICAgICAgIHx8IEJvb2xlYW4oc3Ryb2tlcy5sZW5ndGggJiYgbm9kZS5zdHJva2VBbGlnbiAmJiBub2RlLnN0cm9rZUFsaWduICE9PSAnQ0VOVEVSJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbW9kZSA9IG5vZGUubGF5b3V0TW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5sYXlvdXRQb3NpdGlvbmluZyA9PT0gJ0FCU09MVVRFJykpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbmVlZHNHcmlkVmFsaWRhdGlvbiA9IG1vZGUgPT09ICdHUklEJyB8fCBub2RlLmxheW91dFdyYXAgPT09ICdXUkFQJztcclxuICAgIGlmICghbmVlZHNHcmlkVmFsaWRhdGlvbikge1xyXG4gICAgICAgIHJldHVybiBtb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gdmlzaWJsZUNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBOb25OdWxsYWJsZTxGaWdtYU5vZGVbJ2Fic29sdXRlQm91bmRpbmdCb3gnXT4gPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKGZyYW1lcy5sZW5ndGggIT09IHZpc2libGVDaGlsZHJlbi5sZW5ndGggfHwgZnJhbWVzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGhzID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLndpZHRoKTtcclxuICAgIGNvbnN0IGhlaWdodHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KTtcclxuICAgIGNvbnN0IHVuaWZvcm1XaWR0aCA9IE1hdGgubWF4KC4uLndpZHRocykgLSBNYXRoLm1pbiguLi53aWR0aHMpIDw9IDI7XHJcbiAgICBjb25zdCB1bmlmb3JtSGVpZ2h0ID0gTWF0aC5tYXgoLi4uaGVpZ2h0cykgLSBNYXRoLm1pbiguLi5oZWlnaHRzKSA8PSAyO1xyXG4gICAgcmV0dXJuIHVuaWZvcm1XaWR0aCAmJiB1bmlmb3JtSGVpZ2h0ID8gJ0dSSUQnIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJLaW5kKG5vZGU6IEZpZ21hTm9kZSk6IE5vZGVLaW5kIHtcclxuICAgIGlmIChub2RlLnByZWZhYk5hbWU/LnRyaW0oKSkgcmV0dXJuICdub2RlJztcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiAnbGFiZWwnO1xyXG4gICAgfVxyXG4gICAgLy8gQSBuYW1lIG9yIGNsaXBwaW5nIHJlY3RhbmdsZSBpcyBub3QgcHJvb2Ygb2YgaW50ZXJhY3RpdmUgc2Nyb2xsaW5nLlxyXG4gICAgLy8gT25seSBGaWdtYSdzIGV4cGxpY2l0IHByb3RvdHlwZSBvdmVyZmxvdyBzZXR0aW5nIG1heSBjaGFuZ2UgdGhlIENvY29zXHJcbiAgICAvLyBoaWVyYXJjaHkgdG8gU2Nyb2xsVmlldyAtPiB2aWV3IC0+IGNvbnRlbnQgaW4gYXV0b21hdGljIG1vZGUuXHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgaWYgKEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbikpIHtcclxuICAgICAgICByZXR1cm4gJ3Njcm9sbFZpZXcnO1xyXG4gICAgfVxyXG4gICAgaWYgKC8oXnxfKWJ0bl98YnV0dG9ufOaMiemSri9pLnRlc3Qobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIHJldHVybiAnYnV0dG9uJztcclxuICAgIH1cclxuICAgIGlmIChpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAnbGF5b3V0JztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gJ25vZGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdzcHJpdGUnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gaXNOYW1lZFNsaWNlR3JvdXAoY2hpbGQpXHJcbiAgICAgICAgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZClcclxuICAgICAgICB8fCBoYXNJbmRlcGVuZGVudFNsaWNlRGVzY2VuZGFudChjaGlsZCkpO1xyXG59XHJcblxyXG4vKiogUHJlZmFiIHJlZmVyZW5jZXMgbXVzdCBzdXJ2aXZlIGF1dG9tYXRpYyByYXN0ZXIgYm91bmRhcmllcywgZXZlbiBoaWRkZW4uICovXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnY2hpbGRyZW4nPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IEJvb2xlYW4oY2hpbGQucHJlZmFiTmFtZT8udHJpbSgpKSB8fCBoYXNQcmVmYWJEZXNjZW5kYW50KGNoaWxkKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRNZXJnZVJlc291cmNlTm9kZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdCA9IGZhbHNlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gIWlzUm9vdFxyXG4gICAgICAgICYmICFub2RlLnByZWZhYk5hbWU/LnRyaW0oKVxyXG4gICAgICAgICYmICFoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGUpXHJcbiAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAmJiBpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgJiYgIWhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KG5vZGUpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJBY3Rpb24obm9kZTogRmlnbWFOb2RlLCBpc1Jvb3QgPSBmYWxzZSk6IEltcG9ydEFjdGlvbiB7XHJcbiAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKCkgfHwgaGFzUHJlZmFiRGVzY2VuZGFudChub2RlKSkgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAvLyBUZXh0IHJlbWFpbnMgYW4gZWRpdGFibGUgQ29jb3MgTGFiZWwuIEV2ZW4gd2hlbiBGaWdtYSByZXBvcnRzIGZpbGxzLFxyXG4gICAgICAgIC8vIHNoYWRvd3MsIGV4cG9ydCBzZXR0aW5ncywgb3Igb3RoZXIgcGFpbnQgZGF0YSwgZXhwb3J0aW5nIGEgYml0bWFwXHJcbiAgICAgICAgLy8gd291bGQgbG9zZSB0aGUgdGV4dCBzZW1hbnRpY3MgYW5kIG1ha2UgdGhlIGltcG9ydGVkIFVJIGltcG9zc2libGVcclxuICAgICAgICAvLyB0byBlZGl0LlxyXG4gICAgICAgIHJldHVybiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHJldHVybiAncmVuZGVyJztcclxuICAgIGlmIChoYXNNYW51YWxFeHBvcnQobm9kZSkgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAoc2hvdWxkTWVyZ2VSZXNvdXJjZU5vZGUobm9kZSwgaXNSb290KSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpXHJcbiAgICAgICAgICAgID8gJ3JlbmRlcidcclxuICAgICAgICAgICAgOiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyB8fCBub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3JlbmRlcic7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnY2hpbGRyZW4nPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgPT09IGZhbHNlIHx8IGhhc0hpZGRlbkRlc2NlbmRhbnQoY2hpbGQpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzRXhwbGljaXRTY3JvbGwobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgcmV0dXJuIEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5vZGUudmlzaWJsZSA9PT0gZmFsc2UgfHwgbm9kZS5vcGFjaXR5IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIHJldHVybiAhZnJhbWUgfHwgKGZyYW1lLndpZHRoID4gMCAmJiBmcmFtZS5oZWlnaHQgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgbmFtZSA9IG5vZGUubmFtZS50cmltKCk7XHJcbiAgICByZXR1cm4gRVhBQ1RfU0VNQU5USUNfTkFNRVMuaGFzKG5hbWUudG9Mb3dlckNhc2UoKSlcclxuICAgICAgICB8fCBSVU5USU1FX1JPTEVfTkFNRS50ZXN0KG5hbWUpXHJcbiAgICAgICAgfHwgaGFzRXhwbGljaXRTY3JvbGwobm9kZSlcclxuICAgICAgICB8fCBCb29sZWFuKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEEgbWVzc3kgdmlzdWFsIHdyYXBwZXIgbXVzdCBub3QgYWJzb3JiIGFuIGVkaXRhYmxlIG9yIGluZGVwZW5kZW50bHkgcGxhbm5lZFxyXG4gKiBkZXNjZW5kYW50LiBTdHJ1Y3R1cmVkIG5hbWVzLCB0ZXh0LCBzY3JvbGxpbmcvbGF5b3V0IHNlbWFudGljcywgbWFudWFsXHJcbiAqIGV4cG9ydHMgYW5kIHNsaWNlIGdyb3VwcyBhbGwgbmVlZCB0byBrZWVwIHRoZWlyIG93biBpbXBvcnQgYm91bmRhcnkuXHJcbiAqL1xyXG5mdW5jdGlvbiBzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobm9kZS5wcmVmYWJOYW1lPy50cmltKCkpIHJldHVybiB0cnVlO1xyXG4gICAgaWYgKCFpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJ1xyXG4gICAgICAgIHx8IGlzU3RydWN0dXJlZE5vZGVOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICB8fCBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZSlcclxuICAgICAgICB8fCBoYXNNYW51YWxFeHBvcnQobm9kZSlcclxuICAgICAgICB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzdWJ0cmVlSGFzVmlzdWFsQ29udGVudChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmICghaXNFZmZlY3RpdmVseVZpc2libGUobm9kZSkgfHwgbm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRmlsbCA9IG5vZGUuZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmIChoYXNWaXNpYmxlRmlsbCB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QgfHwgaXNWZWN0b3JOb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoIUNPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShzdWJ0cmVlSGFzVmlzdWFsQ29udGVudCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSZW5kZXJNZXNzeVN1YnRyZWUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiBib29sZWFuIHtcclxuICAgIGlmIChpc1Jvb3RcclxuICAgICAgICB8fCBub2RlLnByZWZhYk5hbWU/LnRyaW0oKVxyXG4gICAgICAgIHx8IGhhc1ByZWZhYkRlc2NlbmRhbnQobm9kZSlcclxuICAgICAgICB8fCAhQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXHJcbiAgICAgICAgfHwgIWlzU3RydWN0dXJlZE5vZGVOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICB8fCBoYXNNYW51YWxFeHBvcnQobm9kZSlcclxuICAgICAgICB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgIHx8IChpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpICYmIGhhc0luZGVwZW5kZW50U2xpY2VEZXNjZW5kYW50KG5vZGUpKVxyXG4gICAgICAgIHx8IGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIC8vIEhpZGRlbiBjaGlsZHJlbiBtdXN0IHJlbWFpbiBpbmRlcGVuZGVudCBDb2NvcyBub2RlcyBzbyB0aGVpciBJbmFjdGl2ZVxyXG4gICAgLy8gc3RhdGUgY2FuIGJlIHJlc3RvcmVkIGxhdGVyLiBBbiBhdXRvbWF0aWMgcGFyZW50IFBORyB3b3VsZCBlcmFzZSB0aGF0XHJcbiAgICAvLyBydW50aW1lIGJvdW5kYXJ5LiBBbiBhbHJlYWR5LWhpZGRlbiBob3N0IG1heSBzdGlsbCB1c2UgdGhlIHNhbWUgdmlzdWFsXHJcbiAgICAvLyBoZXVyaXN0aWMgYXMgYSB2aXNpYmxlIGhvc3Qgd2hlbiBpdHMgZGlyZWN0IGNoaWxkcmVuIGFyZSB2aXNpYmxlLlxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgPT09IGZhbHNlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVDaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4uZmlsdGVyKGlzRWZmZWN0aXZlbHlWaXNpYmxlKTtcclxuICAgIHJldHVybiB2aXNpYmxlQ2hpbGRyZW4ubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5ldmVyeSgoY2hpbGQpID0+ICFpc1N0cnVjdHVyZWROb2RlTmFtZShjaGlsZC5uYW1lKSlcclxuICAgICAgICAmJiAhdmlzaWJsZUNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKVxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzUGF0Y2hDYW5kaWRhdGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gIW5vZGUucHJlZmFiTmFtZT8udHJpbSgpICYmICFoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGUpICYmIEJvb2xlYW4oYW5hbHl6ZVNsaWNlR3JpZChub2RlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhcm5pbmdGb3IoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgcmVuZGVyTWVzc3lTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgbWVyZ2VSZXNvdXJjZVN1YnRyZWU6IGJvb2xlYW4sXHJcbiAgICBpc1Jvb3Q6IGJvb2xlYW4sXHJcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBpbmFjdGl2ZSA9IG5vZGUudmlzaWJsZVxyXG4gICAgICAgID8gdW5kZWZpbmVkXHJcbiAgICAgICAgOiAnRmlnbWEg5Zu+5bGC5bey6ZqQ6JeP77yM5a+85YWl5ZCO6IqC54K55bCG5ZyoIENvY29zIOS4reS/neaMgSBJbmFjdGl2ZSc7XHJcbiAgICBjb25zdCB3aXRoSW5hY3RpdmUgPSAod2FybmluZz86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxyXG4gICAgICAgIFtpbmFjdGl2ZSwgd2FybmluZ10uZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gQm9vbGVhbihpdGVtKSkuam9pbign77ybJykgfHwgdW5kZWZpbmVkO1xyXG4gICAgaWYgKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShg5byV55So6aG555uuIFByZWZhYuKAnCR7bm9kZS5wcmVmYWJOYW1lfeKAne+8jCR7bm9kZS5wcmVmYWJOYW1lLnJlcGxhY2UoL1xcLnByZWZhYiQvaSwgJycpLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpID09PSAncG9wdXAnID8gJ+aMiSBGaWdtYSDosIPmlbTlrr3pq5gnIDogJ+WunuS+i+S/neaMgeWOn+WwuuWvuCd977yb5LiN5a+85YWl5q2k6IqC54K555qE5Y6f5aeL5YaF5a655Y+K5a2Q5qCRYCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaGFzUHJlZmFiRGVzY2VuZGFudChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WGhemDqOWtmOWcqCBQcmVmYWIg5byV55So77yM5pm66IO95qih5byP5L+d55WZ6IqC54K557uT5p6E77yM5LiN6Ieq5Yqo5ZCI5bm25Li65Zu+54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoIW5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+e8uuWwkei+ueeVjOS/oeaBr++8jOWwhuaMiSAww5cwIOWvvOWFpScpO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKChpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgICAgICA/ICfmo4DmtYvliLDmnInmlYjnmoQgMy85IOS4qiBSZWN0YW5nbGUg6L+e57ut5YiH54mH77ybJ1xyXG4gICAgICAgICAgICA6ICfmo4DmtYvliLDmnInmlYjkuIkv5Lmd5a6r5YiG54mH77ybJylcclxuICAgICAgICAgICAgKyAnRmlnbWEg5YiG54mH5LyY5YWI77yM5oyJIEZpZ21hIOWOn+Wni+i+ueeVjOWvvOWFpe+8jOaXp+etlueVpeOAgUV4cG9ydCDlkozliY3nvIDop4TliJnkuI3og73lhbPpl63liIfniYcnKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5qOA5rWL5YiwIEZpZ21hIEV4cG9ydCDorr7nva7vvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8m0ZpZ21hIOeahOagvOW8j+OAgeWQjue8gOWSjOWAjeeOh+S4jeayv+eUqCcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShhbmFseXplU2xpY2VHcmlkKG5vZGUpXHJcbiAgICAgICAgICAgID8gJ+ajgOa1i+WIsOacieaViOeahCAzLzkg5LiqIFJlY3RhbmdsZSDov57nu63liIfniYfvvIzlsIbmjIkgUE5HIOaVtOWxguWvvOWFpeOAgeiHquWKqOWQr+eUqOWIh+eJh+W5tuS8mOWFiOWkjeeUqOWQjOWQjei1hOa6kCdcclxuICAgICAgICAgICAgOiAn5qOA5rWL5YiwIDMvOSDkuKogUmVjdGFuZ2xlIOWRveWQjeiKgueCue+8jOS9huWHoOS9leacquW9ouaIkOi/nue7reWIh+eJh++8m+WwhuaMiSBQTkcg5pW05bGC5a+85YWl77yM5LiN6Ieq5Yqo5ZCv55So5YiH54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWlzUm9vdCAmJiBub2RlLnR5cGUgIT09ICdURVhUJyAmJiBpc01lcmdlZFJlc291cmNlTmFtZShub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgaWYgKGlzUGF0Y2hDYW5kaWRhdGUobm9kZSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5qOA5rWL5Yiw5pyJ5pWI5LiJL+S5neWuq+WIh+eJh++8jOWIh+eJh+etlueVpeS8mOWFiOS6juWJjee8gOWQiOW5ticpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzSW5kZXBlbmRlbnRTbGljZURlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5YmN57yA5pW05bGC5ZCI5bm25bey5YGc55So77ya5YaF6YOo5a2Y5Zyo54us56uL5LiJL+S5neWuq+i1hOa6kO+8jOS8mOWFiOS/neeVmeWIh+eJh+iDveWKmycpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobWVyZ2VSZXNvdXJjZVN1YnRyZWUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgnaWNvbl8vaW1nXyDliY3nvIDmjIkgUE5HIOaVtOWxguWQiOW5tu+8jOmHh+eUqOW9k+WJjeaYvumakOWQiOaIkO+8m+makOiXj+WtkOWxguS4jeeUn+aIkOeLrOeri+iKgueCuScpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMobm9kZS5ibGVuZE1vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShg5re35ZCI5qih5byPICR7bm9kZS5ibGVuZE1vZGV9IOWwhui/keS8vOWkhOeQhmApO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlbmRlck1lc3N5U3VidHJlZSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+aJgOacieacieaViOWPr+ingeebtOaOpeWtkOWxguWdh+S4uumdnue7k+aehOWMlue6r+inhuinieWGheWuue+8jOS4lOacquajgOa1i+WIsOaWh+Wtl+aIlui/kOihjOaXtue7k+aehO+8jOaZuuiDveaooeW8j+WwhuaMiSBQTkcg5pW05bGC5a+85YWlJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgJiYgKGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5aSN5p2C5a655Zmo5bCG5LyY5YWI5L+d55WZ5Y+v57yW6L6R5a2Q6IqC54K577yM6IOM5pmv5Lya6L+R5Ly85aSE55CGJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gd2l0aEluYWN0aXZlKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRvVHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IFRyZWVOb2RlRHRvIHtcclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcHJlZmFiQm91bmRhcnkgPSBCb29sZWFuKG5vZGUucHJlZmFiTmFtZT8udHJpbSgpKSB8fCBoYXNQcmVmYWJEZXNjZW5kYW50KG5vZGUpO1xyXG4gICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IHByZWZhYkJvdW5kYXJ5ID8gdW5kZWZpbmVkIDogYW5hbHl6ZVNsaWNlR3JpZChub2RlKTtcclxuICAgIGNvbnN0IGluZmVycmVkQWN0aW9uID0gaW5mZXJBY3Rpb24obm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiAhcHJlZmFiQm91bmRhcnlcclxuICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICYmICFzbGljZUFuYWx5c2lzXHJcbiAgICAgICAgJiYgaGFzTWFudWFsRXhwb3J0KG5vZGUpO1xyXG4gICAgY29uc3QgcmVuZGVyTWVzc3lTdWJ0cmVlID0gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCBtZXJnZVJlc291cmNlU3VidHJlZSA9IHNob3VsZE1lcmdlUmVzb3VyY2VOb2RlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCByZW5kZXJTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgIXByZWZhYkJvdW5kYXJ5XHJcbiAgICAgICAgJiYgKEJvb2xlYW4oc2xpY2VBbmFseXNpcykgfHwgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSB8fCByZW5kZXJNZXNzeVN1YnRyZWUgfHwgbWVyZ2VSZXNvdXJjZVN1YnRyZWUpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICB3aWR0aDogZnJhbWU/LndpZHRoID8/IDAsXHJcbiAgICAgICAgaGVpZ2h0OiBmcmFtZT8uaGVpZ2h0ID8/IDAsXHJcbiAgICAgICAgYWN0aW9uOiByZW5kZXJTdWJ0cmVlID8gJ3JlbmRlcicgOiBpbmZlcnJlZEFjdGlvbixcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgcmVuZGVyU3VidHJlZSxcclxuICAgICAgICBwYXRjaENhbmRpZGF0ZTogQm9vbGVhbihzbGljZUFuYWx5c2lzKSxcclxuICAgICAgICBzbGljZU1vZGU6IHNsaWNlQW5hbHlzaXM/Lm1vZGUsXHJcbiAgICAgICAgcmVhc29uOiBub2RlLnByZWZhYk5hbWU/LnRyaW0oKSA/ICdwcmVmYWItcmVmZXJlbmNlJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB3YXJuaW5nOiB3YXJuaW5nRm9yKG5vZGUsIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUsIHJlbmRlck1lc3N5U3VidHJlZSwgbWVyZ2VSZXNvdXJjZVN1YnRyZWUsIGlzUm9vdCksXHJcbiAgICAgICAgY2hpbGRyZW46IG5vZGUuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gdG9UcmVlKGNoaWxkLCBmYWxzZSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emVUcmVlKHJvb3RzOiBGaWdtYU5vZGVbXSk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIHJvb3RzLm1hcCgocm9vdCkgPT4gdG9UcmVlKHJvb3QsIHRydWUpKTtcclxufVxyXG4iXX0=