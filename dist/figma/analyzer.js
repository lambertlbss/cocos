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
exports.inferAction = inferAction;
exports.hasHiddenDescendant = hasHiddenDescendant;
exports.shouldRenderMessySubtree = shouldRenderMessySubtree;
exports.isPatchCandidate = isPatchCandidate;
exports.analyzeTree = analyzeTree;
const slicing_1 = require("./slicing");
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const visibleFills = node.fills.filter((fill) => { var _a; return fill.visible !== false && ((_a = fill.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
    const noOwnVisual = visibleFills.length === 0 && !hasVisibleStrokeOrEffect(node);
    if (node.type === 'RECTANGLE' && node.children.length === 0) {
        if (visibleFills.length !== 1 || hasVisibleStrokeOrEffect(node))
            return undefined;
        const fill = visibleFills[0];
        const mode = (_b = (_a = fill.scaleMode) === null || _a === void 0 ? void 0 : _a.toUpperCase()) !== null && _b !== void 0 ? _b : 'FILL';
        const radii = (_c = node.rectangleCornerRadii) !== null && _c !== void 0 ? _c : [(_d = node.cornerRadius) !== null && _d !== void 0 ? _d : 0, (_e = node.cornerRadius) !== null && _e !== void 0 ? _e : 0, (_f = node.cornerRadius) !== null && _f !== void 0 ? _f : 0, (_g = node.cornerRadius) !== null && _g !== void 0 ? _g : 0];
        return fill.type === 'IMAGE'
            && Boolean(fill.imageRef)
            && ['FILL', 'FIT'].includes(mode)
            && ((_h = fill.opacity) !== null && _h !== void 0 ? _h : 1) >= 0.999
            && Math.abs((_j = fill.rotation) !== null && _j !== void 0 ? _j : 0) <= 1e-6
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
    return framesMatch(node, child) ? plainImageSourceRef(child) : undefined;
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
function inferAction(node) {
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
function warningFor(node, renderManualExportSubtree, renderMessySubtree) {
    var _a, _b, _c, _d, _e, _f;
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
    if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) {
        return withInactive(`混合模式 ${node.blendMode} 将近似处理`);
    }
    if (renderMessySubtree) {
        return withInactive('所有有效可见直接子层均为非结构化纯视觉内容，且未检测到文字或运行时结构，智能模式将按 PNG 整层导入');
    }
    if (node.type === 'TEXT' && node.characters && !/[\r\n\u2028\u2029]/.test(node.characters)) {
        const lineHeight = (_d = (_b = (_a = node.style) === null || _a === void 0 ? void 0 : _a.lineHeightPx) !== null && _b !== void 0 ? _b : (_c = node.style) === null || _c === void 0 ? void 0 : _c.fontSize) !== null && _d !== void 0 ? _d : 0;
        const frameHeight = (_f = (_e = node.absoluteBoundingBox) === null || _e === void 0 ? void 0 : _e.height) !== null && _f !== void 0 ? _f : 0;
        if (lineHeight > 0 && frameHeight > lineHeight * 1.25) {
            return withInactive('文本疑似由 Figma 自动换行；NONE 模式只识别手动换行，请在 Figma 中插入换行符');
        }
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
    const inferredAction = inferAction(node);
    const renderManualExportSubtree = inferredAction !== 'ignore'
        && node.type !== 'TEXT'
        && hasManualExport(node);
    const renderMessySubtree = shouldRenderMessySubtree(node, isRoot);
    const renderSubtree = inferredAction !== 'ignore'
        && (renderManualExportSubtree || isNamedSliceGroup(node) || renderMessySubtree);
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
        warning: warningFor(node, renderManualExportSubtree, renderMessySubtree),
        children: node.children.map((child) => toTree(child, false)),
    };
}
function analyzeTree(roots) {
    return roots.map((root) => toTree(root, true));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF3Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREE4QkM7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBcUJDO0FBRUQsa0NBNEJDO0FBRUQsa0RBRUM7QUE0REQsNERBcUJDO0FBRUQsNENBRUM7QUFzRUQsa0NBRUM7QUEzZEQsdUNBQTZDO0FBRTdDLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDO0lBQzVCLFVBQVU7SUFDVixRQUFRO0lBQ1IsT0FBTztJQUNQLE9BQU87SUFDUCxTQUFTO0lBQ1QsV0FBVztJQUNYLGVBQWU7SUFDZixVQUFVO0NBQ2IsQ0FBQyxDQUFDO0FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDekIsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtJQUNqQixzRUFBc0U7SUFDdEUsd0VBQXdFO0lBQ3hFLFdBQVc7SUFDWCxTQUFTO0NBQ1osQ0FBQyxDQUFDO0FBRUgsTUFBTSxvQkFBb0IsR0FBRyw2QkFBNkIsQ0FBQztBQUMzRCxNQUFNLG9CQUFvQixHQUFHLDBDQUEwQyxDQUFDO0FBQ3hFLE1BQU0sa0JBQWtCLEdBQUcsK0dBQStHLENBQUM7QUFDM0ksTUFBTSxpQkFBaUIsR0FBRyxzRkFBc0YsQ0FBQztBQUNqSCxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNwQyxzQkFBc0I7SUFDdEIsb0JBQW9CO0lBQ3BCLG1DQUFtQztJQUNuQyxZQUFZO0lBQ1os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QUFjO1FBQ2pELElBQUksRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDO1FBQ3JCLGFBQWE7UUFDYixjQUFjLEVBQUUsT0FBTyxDQUFDLGFBQWEsQ0FBQztRQUN0QyxTQUFTLEVBQUUsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLElBQUk7UUFDOUIsT0FBTyxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUUsa0JBQWtCLENBQUM7UUFDeEUsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0tBQy9ELENBQUM7QUFDTixDQUFDO0FBRUQsU0FBZ0IsV0FBVyxDQUFDLEtBQWtCO0lBQzFDLE9BQU8sS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEZpZ21hTm9kZSwgSW1wb3J0QWN0aW9uLCBOb2RlS2luZCwgVHJlZU5vZGVEdG8gfSBmcm9tICcuLi90eXBlcyc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQgfSBmcm9tICcuL3NsaWNpbmcnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBWRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG4gICAgLy8gRmlnbWEgcmVwcmVzZW50cyBiYXNpYyBzaGFwZSBsYXllcnMgYXMgdmVjdG9yIGdlb21ldHJ5IHRvby4gS2VlcGluZ1xyXG4gICAgLy8gdGhlbSBpbiB0aGUgcmFzdGVyIHBhdGggcHJldmVudHMgY2MuR3JhcGhpY3MgZnJvbSBhcHByb3hpbWF0aW5nIHRoZW0uXHJcbiAgICAnUkVDVEFOR0xFJyxcclxuICAgICdFTExJUFNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTTElDRV9SRUNUQU5HTEVfTkFNRSA9IC9eUmVjdGFuZ2xlKD86W1xcc18tXSpcXGQrKT8kL2k7XHJcbmNvbnN0IFNUUlVDVFVSRURfTk9ERV9OQU1FID0gL15bQS1aYS16XVtBLVphLXowLTldKig/Ol9bQS1aYS16MC05XSspKyQvO1xyXG5jb25zdCBTRU1BTlRJQ19OT0RFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBSVU5USU1FX1JPTEVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgRVhBQ1RfU0VNQU5USUNfTkFNRVMgPSBuZXcgU2V0KFsndmlldycsICdjb250ZW50J10pO1xyXG5jb25zdCBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1ZlY3Rvck5vZGUobm9kZTogUGljazxGaWdtYU5vZGUsICd0eXBlJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBWRUNUT1JfVFlQRVMuaGFzKG5vZGUudHlwZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cnVjdHVyZWROb2RlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGlmIChuYW1lICE9PSBuYW1lLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFNUUlVDVFVSRURfTk9ERV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBTRU1BTlRJQ19OT0RFX05BTUUudGVzdChuYW1lKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzTmFtZWRTbGljZUdyb3VwKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMyB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gOSlcclxuICAgICAgICAmJiBub2RlLmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gU0xJQ0VfUkVDVEFOR0xFX05BTUUudGVzdChjaGlsZC5uYW1lLnRyaW0oKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzTWFudWFsRXhwb3J0KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnaGFzRXhwb3J0U2V0dGluZ3MnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuaGFzRXhwb3J0U2V0dGluZ3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVJbWFnZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAoZmlsbC50eXBlID09PSAnSU1BR0UnIHx8IGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGlsZWRQYWludFNvdXJjZSB7XHJcbiAgICBraW5kOiAnaW1hZ2UtcmVmJyB8ICdzb3VyY2Utbm9kZSc7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUGFpbnRTb3VyY2Uobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogVGlsZWRQYWludFNvdXJjZSB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGwgb2Ygbm9kZS5maWxscykge1xyXG4gICAgICAgIGlmIChmaWxsLnZpc2libGUgPT09IGZhbHNlIHx8IChmaWxsLm9wYWNpdHkgPz8gMSkgPD0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgZmlsbC5zY2FsaW5nRmFjdG9yID09PSAnbnVtYmVyJ1xyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUoZmlsbC5zY2FsaW5nRmFjdG9yKVxyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxpbmdGYWN0b3IgPiAwXHJcbiAgICAgICAgICAgID8gZmlsbC5zY2FsaW5nRmFjdG9yXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicgJiYgZmlsbC5zb3VyY2VOb2RlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ3NvdXJjZS1ub2RlJywgaWQ6IGZpbGwuc291cmNlTm9kZUlkLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnVElMRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVJlZikge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnaW1hZ2UtcmVmJywgaWQ6IGZpbGwuaW1hZ2VSZWYsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbGVkSW1hZ2VGaWxsKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBCb29sZWFuKHRpbGVkUGFpbnRTb3VyY2Uobm9kZSkpO1xufVxuXG5jb25zdCBSQVdfSU1BR0VfQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXG4gICAgJ0ZSQU1FJyxcbiAgICAnR1JPVVAnLFxuICAgICdDT01QT05FTlQnLFxuICAgICdJTlNUQU5DRScsXG5dKTtcblxuZnVuY3Rpb24gaGFzVmlzaWJsZVN0cm9rZU9yRWZmZWN0KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xuICAgIHJldHVybiAobm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XG4gICAgICAgIHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKSlcbiAgICAgICAgfHwgbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gZnJhbWVzTWF0Y2gobGVmdDogRmlnbWFOb2RlLCByaWdodDogRmlnbWFOb2RlKTogYm9vbGVhbiB7XG4gICAgY29uc3QgYSA9IGxlZnQuYWJzb2x1dGVCb3VuZGluZ0JveDtcbiAgICBjb25zdCBiID0gcmlnaHQuYWJzb2x1dGVCb3VuZGluZ0JveDtcbiAgICBpZiAoIWEgfHwgIWIpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBlcHNpbG9uID0gMC41O1xuICAgIHJldHVybiBNYXRoLmFicyhhLnggLSBiLngpIDw9IGVwc2lsb25cbiAgICAgICAgJiYgTWF0aC5hYnMoYS55IC0gYi55KSA8PSBlcHNpbG9uXG4gICAgICAgICYmIE1hdGguYWJzKGEud2lkdGggLSBiLndpZHRoKSA8PSBlcHNpbG9uXG4gICAgICAgICYmIE1hdGguYWJzKGEuaGVpZ2h0IC0gYi5oZWlnaHQpIDw9IGVwc2lsb247XG59XG5cbi8qKlxuICogUmV0dXJucyB0aGUgb3JpZ2luYWwgSU1BR0UgcGFpbnQgZm9yIGEgdmlzdWFsbHkgcGxhaW4gaW1hZ2Ugbm9kZS9zdWJ0cmVlLlxuICogVGhpcyBpcyB1c2VkIGZvciBlZmZlY3RpdmVseS1oaWRkZW4gbGF5ZXJzIGJlY2F1c2UgRmlnbWEncyByZW5kZXJlZC1pbWFnZVxuICogZW5kcG9pbnQgcHJvZHVjZXMgYSB0cmFuc3BhcmVudCBQTkcgd2hlbiBhbnkgYW5jZXN0b3IgaXMgaGlkZGVuLiBEb3dubG9hZGluZ1xuICogdGhlIHNvdXJjZSBJTUFHRSBwYWludCBpcyB2aXNpYmlsaXR5LWluZGVwZW5kZW50IGFuZCBwcmVzZXJ2ZXMgaXRzIHBpeGVscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XG4gICAgY29uc3Qgbm9Pd25WaXN1YWwgPSB2aXNpYmxlRmlsbHMubGVuZ3RoID09PSAwICYmICFoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSk7XG5cbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlT3JFZmZlY3Qobm9kZSkpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlRmlsbHNbMF07XG4gICAgICAgIGNvbnN0IG1vZGUgPSBmaWxsLnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA/PyAnRklMTCc7XG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxuICAgICAgICAgICAgPz8gW25vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsIG5vZGUuY29ybmVyUmFkaXVzID8/IDBdO1xuICAgICAgICByZXR1cm4gZmlsbC50eXBlID09PSAnSU1BR0UnXG4gICAgICAgICAgICAmJiBCb29sZWFuKGZpbGwuaW1hZ2VSZWYpXG4gICAgICAgICAgICAmJiBbJ0ZJTEwnLCAnRklUJ10uaW5jbHVkZXMobW9kZSlcbiAgICAgICAgICAgICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPj0gMC45OTlcbiAgICAgICAgICAgICYmIE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPD0gMWUtNlxuICAgICAgICAgICAgJiYgKCFmaWxsLmJsZW5kTW9kZSB8fCBbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpXG4gICAgICAgICAgICAmJiByYWRpaS5ldmVyeSgocmFkaXVzKSA9PiByYWRpdXMgPD0gMWUtNilcbiAgICAgICAgICAgID8gZmlsbC5pbWFnZVJlZlxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKCFSQVdfSU1BR0VfQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoICE9PSAxXG4gICAgICAgIHx8ICFub093blZpc3VhbFxuICAgICAgICB8fCBub2RlLm9wYWNpdHkgPCAwLjk5OSkge1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBjb25zdCBjaGlsZCA9IG5vZGUuY2hpbGRyZW5bMF07XG4gICAgcmV0dXJuIGZyYW1lc01hdGNoKG5vZGUsIGNoaWxkKSA/IHBsYWluSW1hZ2VTb3VyY2VSZWYoY2hpbGQpIDogdW5kZWZpbmVkO1xufVxuXHJcbi8qKlxyXG4gKiBBIG5hdGl2ZSB0aWxlZCBTcHJpdGUgcmVwcmVzZW50cyBleGFjdGx5IG9uZSBwYWludC4gTGF5ZXJzIHdpdGggYWRkaXRpb25hbFxyXG4gKiB2aXN1YWxzIG9yIGRlc2NlbmRhbnRzIG11c3Qgc3RheSBvbiB0aGUgd2hvbGUtbm9kZSByYXN0ZXIgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGU6IEZpZ21hTm9kZSk6IFRpbGVkUGFpbnRTb3VyY2UgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3Qgc291cmNlID0gdGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgIGlmICghc291cmNlIHx8IG5vZGUuaGFzRXhwb3J0U2V0dGluZ3MgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgIT09ICdFTExJUFNFJyAmJiBub2RlLnR5cGUgIT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyAmJiBub2RlLmFyY0RhdGEpIHtcclxuICAgICAgICBjb25zdCBzd2VlcCA9IE1hdGguYWJzKG5vZGUuYXJjRGF0YS5lbmRpbmdBbmdsZSAtIG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKTtcclxuICAgICAgICBpZiAobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzID4gMWUtNiB8fCBzd2VlcCA8IE1hdGguUEkgKiAyIC0gMWUtNikge1xyXG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgY29uc3QgcmFkaWkgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgICAgID8/IFtcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgIF07XHJcbiAgICAgICAgaWYgKHJhZGlpLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMWUtNikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlRmlsbHMubGVuZ3RoICE9PSAxIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZUZpbGxzWzBdO1xyXG4gICAgaWYgKChmaWxsLm9wYWNpdHkgPz8gMSkgPCAwLjk5OVxyXG4gICAgICAgIHx8IE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPiAxZS02XHJcbiAgICAgICAgfHwgKGZpbGwuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJykge1xyXG4gICAgICAgIGNvbnN0IHNwYWNpbmcgPSBmaWxsLnNwYWNpbmcgPz8geyB4OiAwLCB5OiAwIH07XHJcbiAgICAgICAgY29uc3QgdW5zdXBwb3J0ZWRQYXR0ZXJuID0gKGZpbGwudGlsZVR5cGUgJiYgZmlsbC50aWxlVHlwZSAhPT0gJ1JFQ1RBTkdVTEFSJylcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy54KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy55KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgKGZpbGwuaG9yaXpvbnRhbEFsaWdubWVudCAmJiBmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpXHJcbiAgICAgICAgICAgIHx8IChmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICYmIGZpbGwudmVydGljYWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpO1xyXG4gICAgICAgIGlmICh1bnN1cHBvcnRlZFBhdHRlcm4pIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4RWZmZWN0cyhub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4UGFpbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PiBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHN0cm9rZXMgPSBub2RlLnN0cm9rZXMuZmlsdGVyKChzdHJva2UpID0+IHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHVuc3VwcG9ydGVkR3JhZGllbnQgPSBmaWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0FOR1VMQVInIHx8IGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0RJQU1PTkQnKTtcclxuICAgIGNvbnN0IHVuZXZlbkNvcm5lcnMgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgPyBuZXcgU2V0KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IE1hdGgucm91bmQocmFkaXVzICogMTAwMCkpKS5zaXplID4gMVxyXG4gICAgICAgIDogZmFsc2U7XHJcbiAgICByZXR1cm4gZmlsbHMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHN0cm9rZXMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHVuc3VwcG9ydGVkR3JhZGllbnRcclxuICAgICAgICB8fCB1bmV2ZW5Db3JuZXJzXHJcbiAgICAgICAgfHwgQm9vbGVhbihzdHJva2VzLmxlbmd0aCAmJiBub2RlLnN0cm9rZUFsaWduICYmIG5vZGUuc3Ryb2tlQWxpZ24gIT09ICdDRU5URVInKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBtb2RlID0gbm9kZS5sYXlvdXRNb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlQ2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLmxheW91dFBvc2l0aW9uaW5nID09PSAnQUJTT0xVVEUnKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBuZWVkc0dyaWRWYWxpZGF0aW9uID0gbW9kZSA9PT0gJ0dSSUQnIHx8IG5vZGUubGF5b3V0V3JhcCA9PT0gJ1dSQVAnO1xyXG4gICAgaWYgKCFuZWVkc0dyaWRWYWxpZGF0aW9uKSB7XHJcbiAgICAgICAgcmV0dXJuIG1vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSB2aXNpYmxlQ2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIE5vbk51bGxhYmxlPEZpZ21hTm9kZVsnYWJzb2x1dGVCb3VuZGluZ0JveCddPiA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoZnJhbWVzLmxlbmd0aCAhPT0gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCB8fCBmcmFtZXMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUud2lkdGgpO1xyXG4gICAgY29uc3QgaGVpZ2h0cyA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpO1xyXG4gICAgY29uc3QgdW5pZm9ybVdpZHRoID0gTWF0aC5tYXgoLi4ud2lkdGhzKSAtIE1hdGgubWluKC4uLndpZHRocykgPD0gMjtcclxuICAgIGNvbnN0IHVuaWZvcm1IZWlnaHQgPSBNYXRoLm1heCguLi5oZWlnaHRzKSAtIE1hdGgubWluKC4uLmhlaWdodHMpIDw9IDI7XHJcbiAgICByZXR1cm4gdW5pZm9ybVdpZHRoICYmIHVuaWZvcm1IZWlnaHQgPyAnR1JJRCcgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlcktpbmQobm9kZTogRmlnbWFOb2RlKTogTm9kZUtpbmQge1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYWJlbCc7XHJcbiAgICB9XHJcbiAgICAvLyBBIG5hbWUgb3IgY2xpcHBpbmcgcmVjdGFuZ2xlIGlzIG5vdCBwcm9vZiBvZiBpbnRlcmFjdGl2ZSBzY3JvbGxpbmcuXHJcbiAgICAvLyBPbmx5IEZpZ21hJ3MgZXhwbGljaXQgcHJvdG90eXBlIG92ZXJmbG93IHNldHRpbmcgbWF5IGNoYW5nZSB0aGUgQ29jb3NcclxuICAgIC8vIGhpZXJhcmNoeSB0byBTY3JvbGxWaWV3IC0+IHZpZXcgLT4gY29udGVudCBpbiBhdXRvbWF0aWMgbW9kZS5cclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICBpZiAoRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKSkge1xyXG4gICAgICAgIHJldHVybiAnc2Nyb2xsVmlldyc7XHJcbiAgICB9XHJcbiAgICBpZiAoLyhefF8pYnRuX3xidXR0b2585oyJ6ZKuL2kudGVzdChub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdidXR0b24nO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYXlvdXQnO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiAnbm9kZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3Nwcml0ZSc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckFjdGlvbihub2RlOiBGaWdtYU5vZGUpOiBJbXBvcnRBY3Rpb24ge1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgLy8gVGV4dCByZW1haW5zIGFuIGVkaXRhYmxlIENvY29zIExhYmVsLiBFdmVuIHdoZW4gRmlnbWEgcmVwb3J0cyBmaWxscyxcclxuICAgICAgICAvLyBzaGFkb3dzLCBleHBvcnQgc2V0dGluZ3MsIG9yIG90aGVyIHBhaW50IGRhdGEsIGV4cG9ydGluZyBhIGJpdG1hcFxyXG4gICAgICAgIC8vIHdvdWxkIGxvc2UgdGhlIHRleHQgc2VtYW50aWNzIGFuZCBtYWtlIHRoZSBpbXBvcnRlZCBVSSBpbXBvc3NpYmxlXHJcbiAgICAgICAgLy8gdG8gZWRpdC5cclxuICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIGlmIChoYXNNYW51YWxFeHBvcnQobm9kZSkgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAoQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiAnZ2VuZXJhdGUnO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKVxyXG4gICAgICAgICAgICA/ICdyZW5kZXInXHJcbiAgICAgICAgICAgIDogJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgfHwgbm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiBoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpXHJcbiAgICAgICAgICAgID8gJ3JlbmRlcidcclxuICAgICAgICAgICAgOiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdyZW5kZXInO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzSGlkZGVuRGVzY2VuZGFudChub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2NoaWxkcmVuJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlID09PSBmYWxzZSB8fCBoYXNIaWRkZW5EZXNjZW5kYW50KGNoaWxkKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc0V4cGxpY2l0U2Nyb2xsKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3Qgb3ZlcmZsb3dEaXJlY3Rpb24gPSBub2RlLm92ZXJmbG93RGlyZWN0aW9uPy50cmltKCkudG9VcHBlckNhc2UoKSA/PyAnJztcclxuICAgIHJldHVybiBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUy5oYXMob3ZlcmZsb3dEaXJlY3Rpb24pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmIChub2RlLnZpc2libGUgPT09IGZhbHNlIHx8IG5vZGUub3BhY2l0eSA8PSAwKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICByZXR1cm4gIWZyYW1lIHx8IChmcmFtZS53aWR0aCA+IDAgJiYgZnJhbWUuaGVpZ2h0ID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IG5hbWUgPSBub2RlLm5hbWUudHJpbSgpO1xyXG4gICAgcmV0dXJuIEVYQUNUX1NFTUFOVElDX05BTUVTLmhhcyhuYW1lLnRvTG93ZXJDYXNlKCkpXHJcbiAgICAgICAgfHwgUlVOVElNRV9ST0xFX05BTUUudGVzdChuYW1lKVxyXG4gICAgICAgIHx8IGhhc0V4cGxpY2l0U2Nyb2xsKG5vZGUpXHJcbiAgICAgICAgfHwgQm9vbGVhbihpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBIG1lc3N5IHZpc3VhbCB3cmFwcGVyIG11c3Qgbm90IGFic29yYiBhbiBlZGl0YWJsZSBvciBpbmRlcGVuZGVudGx5IHBsYW5uZWRcclxuICogZGVzY2VuZGFudC4gU3RydWN0dXJlZCBuYW1lcywgdGV4dCwgc2Nyb2xsaW5nL2xheW91dCBzZW1hbnRpY3MsIG1hbnVhbFxyXG4gKiBleHBvcnRzIGFuZCBzbGljZSBncm91cHMgYWxsIG5lZWQgdG8ga2VlcCB0aGVpciBvd24gaW1wb3J0IGJvdW5kYXJ5LlxyXG4gKi9cclxuZnVuY3Rpb24gc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJ1xyXG4gICAgICAgIHx8IGlzU3RydWN0dXJlZE5vZGVOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICB8fCBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZSlcclxuICAgICAgICB8fCBoYXNNYW51YWxFeHBvcnQobm9kZSlcclxuICAgICAgICB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzdWJ0cmVlSGFzVmlzdWFsQ29udGVudChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmICghaXNFZmZlY3RpdmVseVZpc2libGUobm9kZSkgfHwgbm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRmlsbCA9IG5vZGUuZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmIChoYXNWaXNpYmxlRmlsbCB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QgfHwgaXNWZWN0b3JOb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoIUNPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShzdWJ0cmVlSGFzVmlzdWFsQ29udGVudCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSZW5kZXJNZXNzeVN1YnRyZWUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiBib29sZWFuIHtcclxuICAgIGlmIChpc1Jvb3RcclxuICAgICAgICB8fCAhQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXHJcbiAgICAgICAgfHwgIWlzU3RydWN0dXJlZE5vZGVOYW1lKG5vZGUubmFtZSlcclxuICAgICAgICB8fCBoYXNNYW51YWxFeHBvcnQobm9kZSlcclxuICAgICAgICB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKVxyXG4gICAgICAgIHx8IGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIC8vIEhpZGRlbiBjaGlsZHJlbiBtdXN0IHJlbWFpbiBpbmRlcGVuZGVudCBDb2NvcyBub2RlcyBzbyB0aGVpciBJbmFjdGl2ZVxyXG4gICAgLy8gc3RhdGUgY2FuIGJlIHJlc3RvcmVkIGxhdGVyLiBBbiBhdXRvbWF0aWMgcGFyZW50IFBORyB3b3VsZCBlcmFzZSB0aGF0XHJcbiAgICAvLyBydW50aW1lIGJvdW5kYXJ5LiBBbiBhbHJlYWR5LWhpZGRlbiBob3N0IG1heSBzdGlsbCB1c2UgdGhlIHNhbWUgdmlzdWFsXHJcbiAgICAvLyBoZXVyaXN0aWMgYXMgYSB2aXNpYmxlIGhvc3Qgd2hlbiBpdHMgZGlyZWN0IGNoaWxkcmVuIGFyZSB2aXNpYmxlLlxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgPT09IGZhbHNlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpc2libGVDaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4uZmlsdGVyKGlzRWZmZWN0aXZlbHlWaXNpYmxlKTtcclxuICAgIHJldHVybiB2aXNpYmxlQ2hpbGRyZW4ubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5ldmVyeSgoY2hpbGQpID0+ICFpc1N0cnVjdHVyZWROb2RlTmFtZShjaGlsZC5uYW1lKSlcclxuICAgICAgICAmJiAhdmlzaWJsZUNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKVxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzUGF0Y2hDYW5kaWRhdGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihhbmFseXplU2xpY2VHcmlkKG5vZGUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FybmluZ0ZvcihcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWU6IGJvb2xlYW4sXHJcbiAgICByZW5kZXJNZXNzeVN1YnRyZWU6IGJvb2xlYW4sXHJcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBpbmFjdGl2ZSA9IG5vZGUudmlzaWJsZVxyXG4gICAgICAgID8gdW5kZWZpbmVkXHJcbiAgICAgICAgOiAnRmlnbWEg5Zu+5bGC5bey6ZqQ6JeP77yM5a+85YWl5ZCO6IqC54K55bCG5ZyoIENvY29zIOS4reS/neaMgSBJbmFjdGl2ZSc7XHJcbiAgICBjb25zdCB3aXRoSW5hY3RpdmUgPSAod2FybmluZz86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxyXG4gICAgICAgIFtpbmFjdGl2ZSwgd2FybmluZ10uZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gQm9vbGVhbihpdGVtKSkuam9pbign77ybJykgfHwgdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfnvLrlsJHovrnnlYzkv6Hmga/vvIzlsIbmjIkgMMOXMCDlr7zlhaUnKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5qOA5rWL5YiwIEZpZ21hIEV4cG9ydCDorr7nva7vvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8m0ZpZ21hIOeahOagvOW8j+OAgeWQjue8gOWSjOWAjeeOh+S4jeayv+eUqCcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShhbmFseXplU2xpY2VHcmlkKG5vZGUpXHJcbiAgICAgICAgICAgID8gJ+ajgOa1i+WIsOacieaViOeahCAzLzkg5LiqIFJlY3RhbmdsZSDov57nu63liIfniYfvvIzlsIbmjIkgUE5HIOaVtOWxguWvvOWFpeOAgeiHquWKqOWQr+eUqOWIh+eJh+W5tuS8mOWFiOWkjeeUqOWQjOWQjei1hOa6kCdcclxuICAgICAgICAgICAgOiAn5qOA5rWL5YiwIDMvOSDkuKogUmVjdGFuZ2xlIOWRveWQjeiKgueCue+8jOS9huWHoOS9leacquW9ouaIkOi/nue7reWIh+eJh++8m+WwhuaMiSBQTkcg5pW05bGC5a+85YWl77yM5LiN6Ieq5Yqo5ZCv55So5YiH54mHJyk7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5ibGVuZE1vZGUgJiYgIVsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKG5vZGUuYmxlbmRNb2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYOa3t+WQiOaooeW8jyAke25vZGUuYmxlbmRNb2RlfSDlsIbov5HkvLzlpITnkIZgKTtcclxuICAgIH1cclxuICAgIGlmIChyZW5kZXJNZXNzeVN1YnRyZWUpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmiYDmnInmnInmlYjlj6/op4Hnm7TmjqXlrZDlsYLlnYfkuLrpnZ7nu5PmnoTljJbnuq/op4bop4nlhoXlrrnvvIzkuJTmnKrmo4DmtYvliLDmloflrZfmiJbov5DooYzml7bnu5PmnoTvvIzmmbrog73mqKHlvI/lsIbmjIkgUE5HIOaVtOWxguWvvOWFpScpO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnICYmIG5vZGUuY2hhcmFjdGVycyAmJiAhL1tcXHJcXG5cXHUyMDI4XFx1MjAyOV0vLnRlc3Qobm9kZS5jaGFyYWN0ZXJzKSkge1xyXG4gICAgICAgIGNvbnN0IGxpbmVIZWlnaHQgPSBub2RlLnN0eWxlPy5saW5lSGVpZ2h0UHggPz8gbm9kZS5zdHlsZT8uZm9udFNpemUgPz8gMDtcclxuICAgICAgICBjb25zdCBmcmFtZUhlaWdodCA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveD8uaGVpZ2h0ID8/IDA7XHJcbiAgICAgICAgaWYgKGxpbmVIZWlnaHQgPiAwICYmIGZyYW1lSGVpZ2h0ID4gbGluZUhlaWdodCAqIDEuMjUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5paH5pys55aR5Ly855SxIEZpZ21hIOiHquWKqOaNouihjO+8m05PTkUg5qih5byP5Y+q6K+G5Yir5omL5Yqo5o2i6KGM77yM6K+35ZyoIEZpZ21hIOS4reaPkuWFpeaNouihjOespicpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkgJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAmJiAoaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKSkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCflpI3mnYLlrrnlmajlsIbkvJjlhYjkv53nlZnlj6/nvJbovpHlrZDoioLngrnvvIzog4zmma/kvJrov5HkvLzlpITnkIYnKTtcclxuICAgIH1cclxuICAgIHJldHVybiB3aXRoSW5hY3RpdmUoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdG9UcmVlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290OiBib29sZWFuKTogVHJlZU5vZGVEdG8ge1xyXG4gICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBjb25zdCBzbGljZUFuYWx5c2lzID0gYW5hbHl6ZVNsaWNlR3JpZChub2RlKTtcclxuICAgIGNvbnN0IGluZmVycmVkQWN0aW9uID0gaW5mZXJBY3Rpb24obm9kZSk7XHJcbiAgICBjb25zdCByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAmJiBoYXNNYW51YWxFeHBvcnQobm9kZSk7XHJcbiAgICBjb25zdCByZW5kZXJNZXNzeVN1YnRyZWUgPSBzaG91bGRSZW5kZXJNZXNzeVN1YnRyZWUobm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IHJlbmRlclN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSB8fCByZW5kZXJNZXNzeVN1YnRyZWUpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICB3aWR0aDogZnJhbWU/LndpZHRoID8/IDAsXHJcbiAgICAgICAgaGVpZ2h0OiBmcmFtZT8uaGVpZ2h0ID8/IDAsXHJcbiAgICAgICAgYWN0aW9uOiByZW5kZXJTdWJ0cmVlID8gJ3JlbmRlcicgOiBpbmZlcnJlZEFjdGlvbixcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgcmVuZGVyU3VidHJlZSxcclxuICAgICAgICBwYXRjaENhbmRpZGF0ZTogQm9vbGVhbihzbGljZUFuYWx5c2lzKSxcclxuICAgICAgICBzbGljZU1vZGU6IHNsaWNlQW5hbHlzaXM/Lm1vZGUsXHJcbiAgICAgICAgd2FybmluZzogd2FybmluZ0Zvcihub2RlLCByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlLCByZW5kZXJNZXNzeVN1YnRyZWUpLFxyXG4gICAgICAgIGNoaWxkcmVuOiBub2RlLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHRvVHJlZShjaGlsZCwgZmFsc2UpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhbmFseXplVHJlZShyb290czogRmlnbWFOb2RlW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiByb290cy5tYXAoKHJvb3QpID0+IHRvVHJlZShyb290LCB0cnVlKSk7XHJcbn1cclxuIl19