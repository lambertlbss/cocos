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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF3Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQWdDRCxrREE4QkM7QUFNRCx3REFvREM7QUFxQkQsb0RBd0JDO0FBRUQsOEJBcUJDO0FBRUQsa0NBNEJDO0FBRUQsa0RBRUM7QUE0REQsNERBcUJDO0FBRUQsNENBRUM7QUFzRUQsa0NBRUM7QUEzZEQsdUNBQTZDO0FBRTdDLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDO0lBQzVCLFVBQVU7SUFDVixRQUFRO0lBQ1IsT0FBTztJQUNQLE9BQU87SUFDUCxTQUFTO0lBQ1QsV0FBVztJQUNYLGVBQWU7SUFDZixVQUFVO0NBQ2IsQ0FBQyxDQUFDO0FBRUgsTUFBTSxZQUFZLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDekIsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtJQUNqQixzRUFBc0U7SUFDdEUsd0VBQXdFO0lBQ3hFLFdBQVc7SUFDWCxTQUFTO0NBQ1osQ0FBQyxDQUFDO0FBRUgsTUFBTSxvQkFBb0IsR0FBRyw2QkFBNkIsQ0FBQztBQUMzRCxNQUFNLG9CQUFvQixHQUFHLDBDQUEwQyxDQUFDO0FBQ3hFLE1BQU0sa0JBQWtCLEdBQUcsK0dBQStHLENBQUM7QUFDM0ksTUFBTSxpQkFBaUIsR0FBRyxzRkFBc0YsQ0FBQztBQUNqSCxNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDMUQsTUFBTSx1QkFBdUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNwQyxzQkFBc0I7SUFDdEIsb0JBQW9CO0lBQ3BCLG1DQUFtQztJQUNuQyxZQUFZO0lBQ1os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QUFjO1FBQ2pELElBQUksRUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDO1FBQ3JCLGFBQWE7UUFDYixjQUFjLEVBQUUsT0FBTyxDQUFDLGFBQWEsQ0FBQztRQUN0QyxTQUFTLEVBQUUsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLElBQUk7UUFDOUIsT0FBTyxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUUsa0JBQWtCLENBQUM7UUFDeEUsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0tBQy9ELENBQUM7QUFDTixDQUFDO0FBRUQsU0FBZ0IsV0FBVyxDQUFDLEtBQWtCO0lBQzFDLE9BQU8sS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEZpZ21hTm9kZSwgSW1wb3J0QWN0aW9uLCBOb2RlS2luZCwgVHJlZU5vZGVEdG8gfSBmcm9tICcuLi90eXBlcyc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQgfSBmcm9tICcuL3NsaWNpbmcnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBWRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG4gICAgLy8gRmlnbWEgcmVwcmVzZW50cyBiYXNpYyBzaGFwZSBsYXllcnMgYXMgdmVjdG9yIGdlb21ldHJ5IHRvby4gS2VlcGluZ1xyXG4gICAgLy8gdGhlbSBpbiB0aGUgcmFzdGVyIHBhdGggcHJldmVudHMgY2MuR3JhcGhpY3MgZnJvbSBhcHByb3hpbWF0aW5nIHRoZW0uXHJcbiAgICAnUkVDVEFOR0xFJyxcclxuICAgICdFTExJUFNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTTElDRV9SRUNUQU5HTEVfTkFNRSA9IC9eUmVjdGFuZ2xlKD86W1xcc18tXSpcXGQrKT8kL2k7XHJcbmNvbnN0IFNUUlVDVFVSRURfTk9ERV9OQU1FID0gL15bQS1aYS16XVtBLVphLXowLTldKig/Ol9bQS1aYS16MC05XSspKyQvO1xyXG5jb25zdCBTRU1BTlRJQ19OT0RFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBSVU5USU1FX1JPTEVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgRVhBQ1RfU0VNQU5USUNfTkFNRVMgPSBuZXcgU2V0KFsndmlldycsICdjb250ZW50J10pO1xyXG5jb25zdCBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1ZlY3Rvck5vZGUobm9kZTogUGljazxGaWdtYU5vZGUsICd0eXBlJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBWRUNUT1JfVFlQRVMuaGFzKG5vZGUudHlwZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cnVjdHVyZWROb2RlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGlmIChuYW1lICE9PSBuYW1lLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFNUUlVDVFVSRURfTk9ERV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBTRU1BTlRJQ19OT0RFX05BTUUudGVzdChuYW1lKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzTmFtZWRTbGljZUdyb3VwKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMyB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gOSlcclxuICAgICAgICAmJiBub2RlLmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gU0xJQ0VfUkVDVEFOR0xFX05BTUUudGVzdChjaGlsZC5uYW1lLnRyaW0oKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzTWFudWFsRXhwb3J0KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnaGFzRXhwb3J0U2V0dGluZ3MnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuaGFzRXhwb3J0U2V0dGluZ3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVJbWFnZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAoZmlsbC50eXBlID09PSAnSU1BR0UnIHx8IGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGlsZWRQYWludFNvdXJjZSB7XHJcbiAgICBraW5kOiAnaW1hZ2UtcmVmJyB8ICdzb3VyY2Utbm9kZSc7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUGFpbnRTb3VyY2Uobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogVGlsZWRQYWludFNvdXJjZSB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGwgb2Ygbm9kZS5maWxscykge1xyXG4gICAgICAgIGlmIChmaWxsLnZpc2libGUgPT09IGZhbHNlIHx8IChmaWxsLm9wYWNpdHkgPz8gMSkgPD0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgZmlsbC5zY2FsaW5nRmFjdG9yID09PSAnbnVtYmVyJ1xyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUoZmlsbC5zY2FsaW5nRmFjdG9yKVxyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxpbmdGYWN0b3IgPiAwXHJcbiAgICAgICAgICAgID8gZmlsbC5zY2FsaW5nRmFjdG9yXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicgJiYgZmlsbC5zb3VyY2VOb2RlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ3NvdXJjZS1ub2RlJywgaWQ6IGZpbGwuc291cmNlTm9kZUlkLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnVElMRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVJlZikge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnaW1hZ2UtcmVmJywgaWQ6IGZpbGwuaW1hZ2VSZWYsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbGVkSW1hZ2VGaWxsKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odGlsZWRQYWludFNvdXJjZShub2RlKSk7XHJcbn1cclxuXHJcbmNvbnN0IFJBV19JTUFHRV9DT05UQUlORVJfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdGUkFNRScsXHJcbiAgICAnR1JPVVAnLFxyXG4gICAgJ0NPTVBPTkVOVCcsXHJcbiAgICAnSU5TVEFOQ0UnLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVTdHJva2VPckVmZmVjdChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAobm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApKVxyXG4gICAgICAgIHx8IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lc01hdGNoKGxlZnQ6IEZpZ21hTm9kZSwgcmlnaHQ6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgYSA9IGxlZnQuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IGIgPSByaWdodC5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgaWYgKCFhIHx8ICFiKSByZXR1cm4gZmFsc2U7XHJcbiAgICBjb25zdCBlcHNpbG9uID0gMC41O1xyXG4gICAgcmV0dXJuIE1hdGguYWJzKGEueCAtIGIueCkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEueSAtIGIueSkgPD0gZXBzaWxvblxyXG4gICAgICAgICYmIE1hdGguYWJzKGEud2lkdGggLSBiLndpZHRoKSA8PSBlcHNpbG9uXHJcbiAgICAgICAgJiYgTWF0aC5hYnMoYS5oZWlnaHQgLSBiLmhlaWdodCkgPD0gZXBzaWxvbjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJldHVybnMgdGhlIG9yaWdpbmFsIElNQUdFIHBhaW50IGZvciBhIHZpc3VhbGx5IHBsYWluIGltYWdlIG5vZGUvc3VidHJlZS5cclxuICogVGhpcyBpcyB1c2VkIGZvciBlZmZlY3RpdmVseS1oaWRkZW4gbGF5ZXJzIGJlY2F1c2UgRmlnbWEncyByZW5kZXJlZC1pbWFnZVxyXG4gKiBlbmRwb2ludCBwcm9kdWNlcyBhIHRyYW5zcGFyZW50IFBORyB3aGVuIGFueSBhbmNlc3RvciBpcyBoaWRkZW4uIERvd25sb2FkaW5nXHJcbiAqIHRoZSBzb3VyY2UgSU1BR0UgcGFpbnQgaXMgdmlzaWJpbGl0eS1pbmRlcGVuZGVudCBhbmQgcHJlc2VydmVzIGl0cyBwaXhlbHMuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gbm9kZS5maWxscy5maWx0ZXIoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBub093blZpc3VhbCA9IHZpc2libGVGaWxscy5sZW5ndGggPT09IDAgJiYgIWhhc1Zpc2libGVTdHJva2VPckVmZmVjdChub2RlKTtcclxuXHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgICAgIGlmICh2aXNpYmxlRmlsbHMubGVuZ3RoICE9PSAxIHx8IGhhc1Zpc2libGVTdHJva2VPckVmZmVjdChub2RlKSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBmaWxsID0gdmlzaWJsZUZpbGxzWzBdO1xyXG4gICAgICAgIGNvbnN0IG1vZGUgPSBmaWxsLnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA/PyAnRklMTCc7XHJcbiAgICAgICAgY29uc3QgcmFkaWkgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgICAgID8/IFtub2RlLmNvcm5lclJhZGl1cyA/PyAwLCBub2RlLmNvcm5lclJhZGl1cyA/PyAwLCBub2RlLmNvcm5lclJhZGl1cyA/PyAwLCBub2RlLmNvcm5lclJhZGl1cyA/PyAwXTtcclxuICAgICAgICByZXR1cm4gZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIEJvb2xlYW4oZmlsbC5pbWFnZVJlZilcclxuICAgICAgICAgICAgJiYgWydGSUxMJywgJ0ZJVCddLmluY2x1ZGVzKG1vZGUpXHJcbiAgICAgICAgICAgICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPj0gMC45OTlcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMoZmlsbC5yb3RhdGlvbiA/PyAwKSA8PSAxZS02XHJcbiAgICAgICAgICAgICYmICghZmlsbC5ibGVuZE1vZGUgfHwgWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMoZmlsbC5ibGVuZE1vZGUpKVxyXG4gICAgICAgICAgICAmJiByYWRpaS5ldmVyeSgocmFkaXVzKSA9PiByYWRpdXMgPD0gMWUtNilcclxuICAgICAgICAgICAgPyBmaWxsLmltYWdlUmVmXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgfVxyXG5cclxuICAgIGlmICghUkFXX0lNQUdFX0NPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoICE9PSAxXHJcbiAgICAgICAgfHwgIW5vT3duVmlzdWFsXHJcbiAgICAgICAgfHwgbm9kZS5vcGFjaXR5IDwgMC45OTkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2hpbGQgPSBub2RlLmNoaWxkcmVuWzBdO1xyXG4gICAgcmV0dXJuIGZyYW1lc01hdGNoKG5vZGUsIGNoaWxkKSA/IHBsYWluSW1hZ2VTb3VyY2VSZWYoY2hpbGQpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKipcclxuICogQSBuYXRpdmUgdGlsZWQgU3ByaXRlIHJlcHJlc2VudHMgZXhhY3RseSBvbmUgcGFpbnQuIExheWVycyB3aXRoIGFkZGl0aW9uYWxcclxuICogdmlzdWFscyBvciBkZXNjZW5kYW50cyBtdXN0IHN0YXkgb24gdGhlIHdob2xlLW5vZGUgcmFzdGVyIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlOiBGaWdtYU5vZGUpOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICBpZiAoIXNvdXJjZSB8fCBub2RlLmhhc0V4cG9ydFNldHRpbmdzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlICE9PSAnRUxMSVBTRScgJiYgbm9kZS50eXBlICE9PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgJiYgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgY29uc3Qgc3dlZXAgPSBNYXRoLmFicyhub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUgLSBub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSk7XHJcbiAgICAgICAgaWYgKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyA+IDFlLTYgfHwgc3dlZXAgPCBNYXRoLlBJICogMiAtIDFlLTYpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICBdO1xyXG4gICAgICAgIGlmIChyYWRpaS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDFlLTYpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gbm9kZS5maWxscy5maWx0ZXIoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgIGlmICgoZmlsbC5vcGFjaXR5ID8/IDEpIDwgMC45OTlcclxuICAgICAgICB8fCBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApID4gMWUtNlxyXG4gICAgICAgIHx8IChmaWxsLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMoZmlsbC5ibGVuZE1vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicpIHtcclxuICAgICAgICBjb25zdCBzcGFjaW5nID0gZmlsbC5zcGFjaW5nID8/IHsgeDogMCwgeTogMCB9O1xyXG4gICAgICAgIGNvbnN0IHVuc3VwcG9ydGVkUGF0dGVybiA9IChmaWxsLnRpbGVUeXBlICYmIGZpbGwudGlsZVR5cGUgIT09ICdSRUNUQU5HVUxBUicpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueCkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueSkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IChmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgJiYgZmlsbC5ob3Jpem9udGFsQWxpZ25tZW50ICE9PSAnU1RBUlQnKVxyXG4gICAgICAgICAgICB8fCAoZmlsbC52ZXJ0aWNhbEFsaWdubWVudCAmJiBmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICE9PSAnU1RBUlQnKTtcclxuICAgICAgICBpZiAodW5zdXBwb3J0ZWRQYXR0ZXJuKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleEVmZmVjdHMobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleFBhaW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBzdHJva2VzID0gbm9kZS5zdHJva2VzLmZpbHRlcigoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCB1bnN1cHBvcnRlZEdyYWRpZW50ID0gZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9BTkdVTEFSJyB8fCBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9ESUFNT05EJyk7XHJcbiAgICBjb25zdCB1bmV2ZW5Db3JuZXJzID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgID8gbmV3IFNldChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpLm1hcCgocmFkaXVzKSA9PiBNYXRoLnJvdW5kKHJhZGl1cyAqIDEwMDApKSkuc2l6ZSA+IDFcclxuICAgICAgICA6IGZhbHNlO1xyXG4gICAgcmV0dXJuIGZpbGxzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCBzdHJva2VzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCB1bnN1cHBvcnRlZEdyYWRpZW50XHJcbiAgICAgICAgfHwgdW5ldmVuQ29ybmVyc1xyXG4gICAgICAgIHx8IEJvb2xlYW4oc3Ryb2tlcy5sZW5ndGggJiYgbm9kZS5zdHJva2VBbGlnbiAmJiBub2RlLnN0cm9rZUFsaWduICE9PSAnQ0VOVEVSJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbW9kZSA9IG5vZGUubGF5b3V0TW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5sYXlvdXRQb3NpdGlvbmluZyA9PT0gJ0FCU09MVVRFJykpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbmVlZHNHcmlkVmFsaWRhdGlvbiA9IG1vZGUgPT09ICdHUklEJyB8fCBub2RlLmxheW91dFdyYXAgPT09ICdXUkFQJztcclxuICAgIGlmICghbmVlZHNHcmlkVmFsaWRhdGlvbikge1xyXG4gICAgICAgIHJldHVybiBtb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gdmlzaWJsZUNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBOb25OdWxsYWJsZTxGaWdtYU5vZGVbJ2Fic29sdXRlQm91bmRpbmdCb3gnXT4gPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKGZyYW1lcy5sZW5ndGggIT09IHZpc2libGVDaGlsZHJlbi5sZW5ndGggfHwgZnJhbWVzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGhzID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLndpZHRoKTtcclxuICAgIGNvbnN0IGhlaWdodHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KTtcclxuICAgIGNvbnN0IHVuaWZvcm1XaWR0aCA9IE1hdGgubWF4KC4uLndpZHRocykgLSBNYXRoLm1pbiguLi53aWR0aHMpIDw9IDI7XHJcbiAgICBjb25zdCB1bmlmb3JtSGVpZ2h0ID0gTWF0aC5tYXgoLi4uaGVpZ2h0cykgLSBNYXRoLm1pbiguLi5oZWlnaHRzKSA8PSAyO1xyXG4gICAgcmV0dXJuIHVuaWZvcm1XaWR0aCAmJiB1bmlmb3JtSGVpZ2h0ID8gJ0dSSUQnIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJLaW5kKG5vZGU6IEZpZ21hTm9kZSk6IE5vZGVLaW5kIHtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiAnbGFiZWwnO1xyXG4gICAgfVxyXG4gICAgLy8gQSBuYW1lIG9yIGNsaXBwaW5nIHJlY3RhbmdsZSBpcyBub3QgcHJvb2Ygb2YgaW50ZXJhY3RpdmUgc2Nyb2xsaW5nLlxyXG4gICAgLy8gT25seSBGaWdtYSdzIGV4cGxpY2l0IHByb3RvdHlwZSBvdmVyZmxvdyBzZXR0aW5nIG1heSBjaGFuZ2UgdGhlIENvY29zXHJcbiAgICAvLyBoaWVyYXJjaHkgdG8gU2Nyb2xsVmlldyAtPiB2aWV3IC0+IGNvbnRlbnQgaW4gYXV0b21hdGljIG1vZGUuXHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgaWYgKEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbikpIHtcclxuICAgICAgICByZXR1cm4gJ3Njcm9sbFZpZXcnO1xyXG4gICAgfVxyXG4gICAgaWYgKC8oXnxfKWJ0bl98YnV0dG9ufOaMiemSri9pLnRlc3Qobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIHJldHVybiAnYnV0dG9uJztcclxuICAgIH1cclxuICAgIGlmIChpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAnbGF5b3V0JztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gJ25vZGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdzcHJpdGUnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJBY3Rpb24obm9kZTogRmlnbWFOb2RlKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIC8vIFRleHQgcmVtYWlucyBhbiBlZGl0YWJsZSBDb2NvcyBMYWJlbC4gRXZlbiB3aGVuIEZpZ21hIHJlcG9ydHMgZmlsbHMsXHJcbiAgICAgICAgLy8gc2hhZG93cywgZXhwb3J0IHNldHRpbmdzLCBvciBvdGhlciBwYWludCBkYXRhLCBleHBvcnRpbmcgYSBiaXRtYXBcclxuICAgICAgICAvLyB3b3VsZCBsb3NlIHRoZSB0ZXh0IHNlbWFudGljcyBhbmQgbWFrZSB0aGUgaW1wb3J0ZWQgVUkgaW1wb3NzaWJsZVxyXG4gICAgICAgIC8vIHRvIGVkaXQuXHJcbiAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaGFzTWFudWFsRXhwb3J0KG5vZGUpIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdyZW5kZXInO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ0VMTElQU0UnIHx8IG5vZGUudHlwZSA9PT0gJ1JFQ1RBTkdMRScpIHtcclxuICAgICAgICByZXR1cm4gaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKVxyXG4gICAgICAgICAgICA/ICdyZW5kZXInXHJcbiAgICAgICAgICAgIDogJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIHJldHVybiAncmVuZGVyJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZTogUGljazxGaWdtYU5vZGUsICdjaGlsZHJlbic+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UgfHwgaGFzSGlkZGVuRGVzY2VuZGFudChjaGlsZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNFeHBsaWNpdFNjcm9sbChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICByZXR1cm4gRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNFZmZlY3RpdmVseVZpc2libGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobm9kZS52aXNpYmxlID09PSBmYWxzZSB8fCBub2RlLm9wYWNpdHkgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgcmV0dXJuICFmcmFtZSB8fCAoZnJhbWUud2lkdGggPiAwICYmIGZyYW1lLmhlaWdodCA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBuYW1lID0gbm9kZS5uYW1lLnRyaW0oKTtcclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFJVTlRJTUVfUk9MRV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBoYXNFeHBsaWNpdFNjcm9sbChub2RlKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogQSBtZXNzeSB2aXN1YWwgd3JhcHBlciBtdXN0IG5vdCBhYnNvcmIgYW4gZWRpdGFibGUgb3IgaW5kZXBlbmRlbnRseSBwbGFubmVkXHJcbiAqIGRlc2NlbmRhbnQuIFN0cnVjdHVyZWQgbmFtZXMsIHRleHQsIHNjcm9sbGluZy9sYXlvdXQgc2VtYW50aWNzLCBtYW51YWxcclxuICogZXhwb3J0cyBhbmQgc2xpY2UgZ3JvdXBzIGFsbCBuZWVkIHRvIGtlZXAgdGhlaXIgb3duIGltcG9ydCBib3VuZGFyeS5cclxuICovXHJcbmZ1bmN0aW9uIHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmICghaXNFZmZlY3RpdmVseVZpc2libGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCdcclxuICAgICAgICB8fCBpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpIHx8IG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGFzVmlzaWJsZUZpbGwgPSBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAoaGFzVmlzaWJsZUZpbGwgfHwgaGFzVmlzaWJsZVN0cm9rZSB8fCBoYXNWaXNpYmxlRWZmZWN0IHx8IGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKCFDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290OiBib29sZWFuKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoaXNSb290XHJcbiAgICAgICAgfHwgIUNPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKVxyXG4gICAgICAgIHx8ICFpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICB8fCBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICAvLyBIaWRkZW4gY2hpbGRyZW4gbXVzdCByZW1haW4gaW5kZXBlbmRlbnQgQ29jb3Mgbm9kZXMgc28gdGhlaXIgSW5hY3RpdmVcclxuICAgIC8vIHN0YXRlIGNhbiBiZSByZXN0b3JlZCBsYXRlci4gQW4gYXV0b21hdGljIHBhcmVudCBQTkcgd291bGQgZXJhc2UgdGhhdFxyXG4gICAgLy8gcnVudGltZSBib3VuZGFyeS4gQW4gYWxyZWFkeS1oaWRkZW4gaG9zdCBtYXkgc3RpbGwgdXNlIHRoZSBzYW1lIHZpc3VhbFxyXG4gICAgLy8gaGV1cmlzdGljIGFzIGEgdmlzaWJsZSBob3N0IHdoZW4gaXRzIGRpcmVjdCBjaGlsZHJlbiBhcmUgdmlzaWJsZS5cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlID09PSBmYWxzZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcihpc0VmZmVjdGl2ZWx5VmlzaWJsZSk7XHJcbiAgICByZXR1cm4gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCA+IDBcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uZXZlcnkoKGNoaWxkKSA9PiAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUoY2hpbGQubmFtZSkpXHJcbiAgICAgICAgJiYgIXZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSlcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uc29tZShzdWJ0cmVlSGFzVmlzdWFsQ29udGVudCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oYW5hbHl6ZVNsaWNlR3JpZChub2RlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhcm5pbmdGb3IoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgcmVuZGVyTWVzc3lTdWJ0cmVlOiBib29sZWFuLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgaW5hY3RpdmUgPSBub2RlLnZpc2libGVcclxuICAgICAgICA/IHVuZGVmaW5lZFxyXG4gICAgICAgIDogJ0ZpZ21hIOWbvuWxguW3sumakOiXj++8jOWvvOWFpeWQjuiKgueCueWwhuWcqCBDb2NvcyDkuK3kv53mjIEgSW5hY3RpdmUnO1xyXG4gICAgY29uc3Qgd2l0aEluYWN0aXZlID0gKHdhcm5pbmc/OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cclxuICAgICAgICBbaW5hY3RpdmUsIHdhcm5pbmddLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgc3RyaW5nID0+IEJvb2xlYW4oaXRlbSkpLmpvaW4oJ++8mycpIHx8IHVuZGVmaW5lZDtcclxuICAgIGlmICghbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn57y65bCR6L6555WM5L+h5oGv77yM5bCG5oyJIDDDlzAg5a+85YWlJyk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+ajgOa1i+WIsCBGaWdtYSBFeHBvcnQg6K6+572u77yM5pm66IO95qih5byP5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXvvJtGaWdtYSDnmoTmoLzlvI/jgIHlkI7nvIDlkozlgI3njofkuI3msr/nlKgnKTtcclxuICAgIH1cclxuICAgIGlmIChpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxyXG4gICAgICAgICAgICA/ICfmo4DmtYvliLDmnInmlYjnmoQgMy85IOS4qiBSZWN0YW5nbGUg6L+e57ut5YiH54mH77yM5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXjgIHoh6rliqjlkK/nlKjliIfniYflubbkvJjlhYjlpI3nlKjlkIzlkI3otYTmupAnXHJcbiAgICAgICAgICAgIDogJ+ajgOa1i+WIsCAzLzkg5LiqIFJlY3RhbmdsZSDlkb3lkI3oioLngrnvvIzkvYblh6DkvZXmnKrlvaLmiJDov57nu63liIfniYfvvJvlsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8jOS4jeiHquWKqOWQr+eUqOWIh+eJhycpO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhub2RlLmJsZW5kTW9kZSkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKGDmt7flkIjmqKHlvI8gJHtub2RlLmJsZW5kTW9kZX0g5bCG6L+R5Ly85aSE55CGYCk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVuZGVyTWVzc3lTdWJ0cmVlKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5omA5pyJ5pyJ5pWI5Y+v6KeB55u05o6l5a2Q5bGC5Z2H5Li66Z2e57uT5p6E5YyW57qv6KeG6KeJ5YaF5a6577yM5LiU5pyq5qOA5rWL5Yiw5paH5a2X5oiW6L+Q6KGM5pe257uT5p6E77yM5pm66IO95qih5byP5bCG5oyJIFBORyDmlbTlsYLlr7zlhaUnKTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBub2RlLmNoYXJhY3RlcnMgJiYgIS9bXFxyXFxuXFx1MjAyOFxcdTIwMjldLy50ZXN0KG5vZGUuY2hhcmFjdGVycykpIHtcclxuICAgICAgICBjb25zdCBsaW5lSGVpZ2h0ID0gbm9kZS5zdHlsZT8ubGluZUhlaWdodFB4ID8/IG5vZGUuc3R5bGU/LmZvbnRTaXplID8/IDA7XHJcbiAgICAgICAgY29uc3QgZnJhbWVIZWlnaHQgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g/LmhlaWdodCA/PyAwO1xyXG4gICAgICAgIGlmIChsaW5lSGVpZ2h0ID4gMCAmJiBmcmFtZUhlaWdodCA+IGxpbmVIZWlnaHQgKiAxLjI1KSB7XHJcbiAgICAgICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+aWh+acrOeWkeS8vOeUsSBGaWdtYSDoh6rliqjmjaLooYzvvJtOT05FIOaooeW8j+WPquivhuWIq+aJi+WKqOaNouihjO+8jOivt+WcqCBGaWdtYSDkuK3mj5LlhaXmjaLooYznrKYnKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgJiYgKGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5aSN5p2C5a655Zmo5bCG5LyY5YWI5L+d55WZ5Y+v57yW6L6R5a2Q6IqC54K577yM6IOM5pmv5Lya6L+R5Ly85aSE55CGJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gd2l0aEluYWN0aXZlKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRvVHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IFRyZWVOb2RlRHRvIHtcclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IGFuYWx5emVTbGljZUdyaWQobm9kZSk7XHJcbiAgICBjb25zdCBpbmZlcnJlZEFjdGlvbiA9IGluZmVyQWN0aW9uKG5vZGUpO1xyXG4gICAgY29uc3QgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSA9IGluZmVycmVkQWN0aW9uICE9PSAnaWdub3JlJ1xyXG4gICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgJiYgaGFzTWFudWFsRXhwb3J0KG5vZGUpO1xyXG4gICAgY29uc3QgcmVuZGVyTWVzc3lTdWJ0cmVlID0gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGUsIGlzUm9vdCk7XHJcbiAgICBjb25zdCByZW5kZXJTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgKHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkgfHwgcmVuZGVyTWVzc3lTdWJ0cmVlKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxyXG4gICAgICAgIHR5cGU6IG5vZGUudHlwZSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgd2lkdGg6IGZyYW1lPy53aWR0aCA/PyAwLFxyXG4gICAgICAgIGhlaWdodDogZnJhbWU/LmhlaWdodCA/PyAwLFxyXG4gICAgICAgIGFjdGlvbjogcmVuZGVyU3VidHJlZSA/ICdyZW5kZXInIDogaW5mZXJyZWRBY3Rpb24sXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIHJlbmRlclN1YnRyZWUsXHJcbiAgICAgICAgcGF0Y2hDYW5kaWRhdGU6IEJvb2xlYW4oc2xpY2VBbmFseXNpcyksXHJcbiAgICAgICAgc2xpY2VNb2RlOiBzbGljZUFuYWx5c2lzPy5tb2RlLFxyXG4gICAgICAgIHdhcm5pbmc6IHdhcm5pbmdGb3Iobm9kZSwgcmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSwgcmVuZGVyTWVzc3lTdWJ0cmVlKSxcclxuICAgICAgICBjaGlsZHJlbjogbm9kZS5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB0b1RyZWUoY2hpbGQsIGZhbHNlKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYW5hbHl6ZVRyZWUocm9vdHM6IEZpZ21hTm9kZVtdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gcm9vdHMubWFwKChyb290KSA9PiB0b1RyZWUocm9vdCwgdHJ1ZSkpO1xyXG59XHJcbiJdfQ==