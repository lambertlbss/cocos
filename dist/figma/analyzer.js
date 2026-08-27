"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVectorNode = isVectorNode;
exports.isStructuredNodeName = isStructuredNodeName;
exports.isNamedSliceGroup = isNamedSliceGroup;
exports.hasManualExport = hasManualExport;
exports.tiledPaintSource = tiledPaintSource;
exports.hasTiledImageFill = hasTiledImageFill;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF3Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQU1ELHdEQW9EQztBQXFCRCxvREF3QkM7QUFFRCw4QkFxQkM7QUFFRCxrQ0E0QkM7QUFFRCxrREFFQztBQTRERCw0REFxQkM7QUFFRCw0Q0FFQztBQXNFRCxrQ0FFQztBQTdaRCx1Q0FBNkM7QUFFN0MsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN6QixRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0lBQ2pCLHNFQUFzRTtJQUN0RSx3RUFBd0U7SUFDeEUsV0FBVztJQUNYLFNBQVM7Q0FDWixDQUFDLENBQUM7QUFFSCxNQUFNLG9CQUFvQixHQUFHLDZCQUE2QixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsMENBQTBDLENBQUM7QUFDeEUsTUFBTSxrQkFBa0IsR0FBRywrR0FBK0csQ0FBQztBQUMzSSxNQUFNLGlCQUFpQixHQUFHLHNGQUFzRixDQUFDO0FBQ2pILE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUMxRCxNQUFNLHVCQUF1QixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ3BDLHNCQUFzQjtJQUN0QixvQkFBb0I7SUFDcEIsbUNBQW1DO0lBQ25DLFlBQVk7SUFDWixVQUFVO0lBQ1YsTUFB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QUFDO1FBQzFCLE1BQU0sRUFBRSxhQUFhLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsY0FBYztRQUNqRCxJQUFJLEVBQUUsU0FBUyxDQUFDLElBQUksQ0FBQztRQUNyQixhQUFhO1FBQ2IsY0FBYyxFQUFFLE9BQU8sQ0FBQyxhQUFhLENBQUM7UUFDdEMsU0FBUyxFQUFFLGFBQWEsYUFBYixhQUFhLHVCQUFiLGFBQWEsQ0FBRSxJQUFJO1FBQzlCLE9BQU8sRUFBRSxVQUFVLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFLGtCQUFrQixDQUFDO1FBQ3hFLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztLQUMvRCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQWdCLFdBQVcsQ0FBQyxLQUFrQjtJQUMxQyxPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNuRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBGaWdtYU5vZGUsIEltcG9ydEFjdGlvbiwgTm9kZUtpbmQsIFRyZWVOb2RlRHRvIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBhbmFseXplU2xpY2VHcmlkIH0gZnJvbSAnLi9zbGljaW5nJztcclxuXHJcbmNvbnN0IENPTlRBSU5FUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0RPQ1VNRU5UJyxcclxuICAgICdDQU5WQVMnLFxyXG4gICAgJ0ZSQU1FJyxcclxuICAgICdHUk9VUCcsXHJcbiAgICAnU0VDVElPTicsXHJcbiAgICAnQ09NUE9ORU5UJyxcclxuICAgICdDT01QT05FTlRfU0VUJyxcclxuICAgICdJTlNUQU5DRScsXHJcbl0pO1xyXG5cclxuY29uc3QgVkVDVE9SX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnVkVDVE9SJyxcclxuICAgICdCT09MRUFOX09QRVJBVElPTicsXHJcbiAgICAnU1RBUicsXHJcbiAgICAnTElORScsXHJcbiAgICAnUkVHVUxBUl9QT0xZR09OJyxcclxuICAgIC8vIEZpZ21hIHJlcHJlc2VudHMgYmFzaWMgc2hhcGUgbGF5ZXJzIGFzIHZlY3RvciBnZW9tZXRyeSB0b28uIEtlZXBpbmdcclxuICAgIC8vIHRoZW0gaW4gdGhlIHJhc3RlciBwYXRoIHByZXZlbnRzIGNjLkdyYXBoaWNzIGZyb20gYXBwcm94aW1hdGluZyB0aGVtLlxyXG4gICAgJ1JFQ1RBTkdMRScsXHJcbiAgICAnRUxMSVBTRScsXHJcbl0pO1xyXG5cclxuY29uc3QgU0xJQ0VfUkVDVEFOR0xFX05BTUUgPSAvXlJlY3RhbmdsZSg/OltcXHNfLV0qXFxkKyk/JC9pO1xyXG5jb25zdCBTVFJVQ1RVUkVEX05PREVfTkFNRSA9IC9eW0EtWmEtel1bQS1aYS16MC05XSooPzpfW0EtWmEtejAtOV0rKSskLztcclxuY29uc3QgU0VNQU5USUNfTk9ERV9OQU1FID0gL14oPzpwYW5lbHxsaXN0fGxheW91dHxidG58YnV0dG9ufGltZ3xpbWFnZXxpY29ufGJnfHNwcml0ZXx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgUlVOVElNRV9ST0xFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258dHh0fHRleHR8bGFiZWwpX1tcXHB7TH1cXHB7Tn1dKyg/Ol9bXFxwe0x9XFxwe059XSspKiQvaXU7XHJcbmNvbnN0IEVYQUNUX1NFTUFOVElDX05BTUVTID0gbmV3IFNldChbJ3ZpZXcnLCAnY29udGVudCddKTtcclxuY29uc3QgRklHTUFfU0NST0xMX0RJUkVDVElPTlMgPSBuZXcgU2V0KFtcclxuICAgICdIT1JJWk9OVEFMX1NDUk9MTElORycsXHJcbiAgICAnVkVSVElDQUxfU0NST0xMSU5HJyxcclxuICAgICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUwnLFxyXG4gICAgJ1ZFUlRJQ0FMJyxcclxuICAgICdCT1RIJyxcclxuXSk7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNWZWN0b3JOb2RlKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAndHlwZSc+KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gVkVDVE9SX1RZUEVTLmhhcyhub2RlLnR5cGUpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobmFtZSAhPT0gbmFtZS50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gRVhBQ1RfU0VNQU5USUNfTkFNRVMuaGFzKG5hbWUudG9Mb3dlckNhc2UoKSlcclxuICAgICAgICB8fCBTVFJVQ1RVUkVEX05PREVfTkFNRS50ZXN0KG5hbWUpXHJcbiAgICAgICAgfHwgU0VNQU5USUNfTk9ERV9OQU1FLnRlc3QobmFtZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc05hbWVkU2xpY2VHcm91cChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiAobm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDMgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggPT09IDkpXHJcbiAgICAgICAgJiYgbm9kZS5jaGlsZHJlbi5ldmVyeSgoY2hpbGQpID0+IFNMSUNFX1JFQ1RBTkdMRV9OQU1FLnRlc3QoY2hpbGQubmFtZS50cmltKCkpKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc01hbnVhbEV4cG9ydChub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2hhc0V4cG9ydFNldHRpbmdzJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmhhc0V4cG9ydFNldHRpbmdzO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNWaXNpYmxlSW1hZ2Uobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5maWxscy5zb21lKChmaWxsKSA9PiBmaWxsLnZpc2libGUgIT09IGZhbHNlXHJcbiAgICAgICAgJiYgKGZpbGwudHlwZSA9PT0gJ0lNQUdFJyB8fCBmaWxsLnR5cGUgPT09ICdQQVRURVJOJykpO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFRpbGVkUGFpbnRTb3VyY2Uge1xyXG4gICAga2luZDogJ2ltYWdlLXJlZicgfCAnc291cmNlLW5vZGUnO1xyXG4gICAgaWQ6IHN0cmluZztcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB0aWxlZFBhaW50U291cmNlKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IFRpbGVkUGFpbnRTb3VyY2UgfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBmaWxsIG9mIG5vZGUuZmlsbHMpIHtcclxuICAgICAgICBpZiAoZmlsbC52aXNpYmxlID09PSBmYWxzZSB8fCAoZmlsbC5vcGFjaXR5ID8/IDEpIDw9IDApIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHNjYWxlID0gdHlwZW9mIGZpbGwuc2NhbGluZ0ZhY3RvciA9PT0gJ251bWJlcidcclxuICAgICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKGZpbGwuc2NhbGluZ0ZhY3RvcilcclxuICAgICAgICAgICAgJiYgZmlsbC5zY2FsaW5nRmFjdG9yID4gMFxyXG4gICAgICAgICAgICA/IGZpbGwuc2NhbGluZ0ZhY3RvclxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgaWYgKGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nICYmIGZpbGwuc291cmNlTm9kZUlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IGtpbmQ6ICdzb3VyY2Utbm9kZScsIGlkOiBmaWxsLnNvdXJjZU5vZGVJZCwgc2NhbGUgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZpbGwudHlwZSA9PT0gJ0lNQUdFJ1xyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA9PT0gJ1RJTEUnXHJcbiAgICAgICAgICAgICYmIGZpbGwuaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ2ltYWdlLXJlZicsIGlkOiBmaWxsLmltYWdlUmVmLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBoYXNUaWxlZEltYWdlRmlsbChub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2ZpbGxzJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHRpbGVkUGFpbnRTb3VyY2Uobm9kZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogQSBuYXRpdmUgdGlsZWQgU3ByaXRlIHJlcHJlc2VudHMgZXhhY3RseSBvbmUgcGFpbnQuIExheWVycyB3aXRoIGFkZGl0aW9uYWxcclxuICogdmlzdWFscyBvciBkZXNjZW5kYW50cyBtdXN0IHN0YXkgb24gdGhlIHdob2xlLW5vZGUgcmFzdGVyIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlOiBGaWdtYU5vZGUpOiBUaWxlZFBhaW50U291cmNlIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICBpZiAoIXNvdXJjZSB8fCBub2RlLmhhc0V4cG9ydFNldHRpbmdzIHx8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlICE9PSAnRUxMSVBTRScgJiYgbm9kZS50eXBlICE9PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgJiYgbm9kZS5hcmNEYXRhKSB7XHJcbiAgICAgICAgY29uc3Qgc3dlZXAgPSBNYXRoLmFicyhub2RlLmFyY0RhdGEuZW5kaW5nQW5nbGUgLSBub2RlLmFyY0RhdGEuc3RhcnRpbmdBbmdsZSk7XHJcbiAgICAgICAgaWYgKG5vZGUuYXJjRGF0YS5pbm5lclJhZGl1cyA+IDFlLTYgfHwgc3dlZXAgPCBNYXRoLlBJICogMiAtIDFlLTYpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIGNvbnN0IHJhZGlpID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgICAgICA/PyBbXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICBdO1xyXG4gICAgICAgIGlmIChyYWRpaS5zb21lKChyYWRpdXMpID0+IHJhZGl1cyA+IDFlLTYpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUZpbGxzID0gbm9kZS5maWxscy5maWx0ZXIoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUZpbGxzLmxlbmd0aCAhPT0gMSB8fCBoYXNWaXNpYmxlU3Ryb2tlIHx8IGhhc1Zpc2libGVFZmZlY3QpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVGaWxsc1swXTtcclxuICAgIGlmICgoZmlsbC5vcGFjaXR5ID8/IDEpIDwgMC45OTlcclxuICAgICAgICB8fCBNYXRoLmFicyhmaWxsLnJvdGF0aW9uID8/IDApID4gMWUtNlxyXG4gICAgICAgIHx8IChmaWxsLmJsZW5kTW9kZSAmJiAhWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMoZmlsbC5ibGVuZE1vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicpIHtcclxuICAgICAgICBjb25zdCBzcGFjaW5nID0gZmlsbC5zcGFjaW5nID8/IHsgeDogMCwgeTogMCB9O1xyXG4gICAgICAgIGNvbnN0IHVuc3VwcG9ydGVkUGF0dGVybiA9IChmaWxsLnRpbGVUeXBlICYmIGZpbGwudGlsZVR5cGUgIT09ICdSRUNUQU5HVUxBUicpXHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueCkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IE1hdGguYWJzKHNwYWNpbmcueSkgPiAxZS02XHJcbiAgICAgICAgICAgIHx8IChmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgJiYgZmlsbC5ob3Jpem9udGFsQWxpZ25tZW50ICE9PSAnU1RBUlQnKVxyXG4gICAgICAgICAgICB8fCAoZmlsbC52ZXJ0aWNhbEFsaWdubWVudCAmJiBmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICE9PSAnU1RBUlQnKTtcclxuICAgICAgICBpZiAodW5zdXBwb3J0ZWRQYXR0ZXJuKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleEVmZmVjdHMobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzQ29tcGxleFBhaW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT4gZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBzdHJva2VzID0gbm9kZS5zdHJva2VzLmZpbHRlcigoc3Ryb2tlKSA9PiBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCB1bnN1cHBvcnRlZEdyYWRpZW50ID0gZmlsbHMuc29tZSgoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9BTkdVTEFSJyB8fCBmaWxsLnR5cGUgPT09ICdHUkFESUVOVF9ESUFNT05EJyk7XHJcbiAgICBjb25zdCB1bmV2ZW5Db3JuZXJzID0gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaVxyXG4gICAgICAgID8gbmV3IFNldChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpLm1hcCgocmFkaXVzKSA9PiBNYXRoLnJvdW5kKHJhZGl1cyAqIDEwMDApKSkuc2l6ZSA+IDFcclxuICAgICAgICA6IGZhbHNlO1xyXG4gICAgcmV0dXJuIGZpbGxzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCBzdHJva2VzLmxlbmd0aCA+IDFcclxuICAgICAgICB8fCB1bnN1cHBvcnRlZEdyYWRpZW50XHJcbiAgICAgICAgfHwgdW5ldmVuQ29ybmVyc1xyXG4gICAgICAgIHx8IEJvb2xlYW4oc3Ryb2tlcy5sZW5ndGggJiYgbm9kZS5zdHJva2VBbGlnbiAmJiBub2RlLnN0cm9rZUFsaWduICE9PSAnQ0VOVEVSJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbW9kZSA9IG5vZGUubGF5b3V0TW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAodmlzaWJsZUNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC5sYXlvdXRQb3NpdGlvbmluZyA9PT0gJ0FCU09MVVRFJykpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbmVlZHNHcmlkVmFsaWRhdGlvbiA9IG1vZGUgPT09ICdHUklEJyB8fCBub2RlLmxheW91dFdyYXAgPT09ICdXUkFQJztcclxuICAgIGlmICghbmVlZHNHcmlkVmFsaWRhdGlvbikge1xyXG4gICAgICAgIHJldHVybiBtb2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gdmlzaWJsZUNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBOb25OdWxsYWJsZTxGaWdtYU5vZGVbJ2Fic29sdXRlQm91bmRpbmdCb3gnXT4gPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKGZyYW1lcy5sZW5ndGggIT09IHZpc2libGVDaGlsZHJlbi5sZW5ndGggfHwgZnJhbWVzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGhzID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLndpZHRoKTtcclxuICAgIGNvbnN0IGhlaWdodHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KTtcclxuICAgIGNvbnN0IHVuaWZvcm1XaWR0aCA9IE1hdGgubWF4KC4uLndpZHRocykgLSBNYXRoLm1pbiguLi53aWR0aHMpIDw9IDI7XHJcbiAgICBjb25zdCB1bmlmb3JtSGVpZ2h0ID0gTWF0aC5tYXgoLi4uaGVpZ2h0cykgLSBNYXRoLm1pbiguLi5oZWlnaHRzKSA8PSAyO1xyXG4gICAgcmV0dXJuIHVuaWZvcm1XaWR0aCAmJiB1bmlmb3JtSGVpZ2h0ID8gJ0dSSUQnIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJLaW5kKG5vZGU6IEZpZ21hTm9kZSk6IE5vZGVLaW5kIHtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiAnbGFiZWwnO1xyXG4gICAgfVxyXG4gICAgLy8gQSBuYW1lIG9yIGNsaXBwaW5nIHJlY3RhbmdsZSBpcyBub3QgcHJvb2Ygb2YgaW50ZXJhY3RpdmUgc2Nyb2xsaW5nLlxyXG4gICAgLy8gT25seSBGaWdtYSdzIGV4cGxpY2l0IHByb3RvdHlwZSBvdmVyZmxvdyBzZXR0aW5nIG1heSBjaGFuZ2UgdGhlIENvY29zXHJcbiAgICAvLyBoaWVyYXJjaHkgdG8gU2Nyb2xsVmlldyAtPiB2aWV3IC0+IGNvbnRlbnQgaW4gYXV0b21hdGljIG1vZGUuXHJcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgaWYgKEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbikpIHtcclxuICAgICAgICByZXR1cm4gJ3Njcm9sbFZpZXcnO1xyXG4gICAgfVxyXG4gICAgaWYgKC8oXnxfKWJ0bl98YnV0dG9ufOaMiemSri9pLnRlc3Qobm9kZS5uYW1lKSkge1xyXG4gICAgICAgIHJldHVybiAnYnV0dG9uJztcclxuICAgIH1cclxuICAgIGlmIChpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAnbGF5b3V0JztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gJ25vZGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdzcHJpdGUnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5mZXJBY3Rpb24obm9kZTogRmlnbWFOb2RlKTogSW1wb3J0QWN0aW9uIHtcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcbiAgICAgICAgLy8gVGV4dCByZW1haW5zIGFuIGVkaXRhYmxlIENvY29zIExhYmVsLiBFdmVuIHdoZW4gRmlnbWEgcmVwb3J0cyBmaWxscyxcclxuICAgICAgICAvLyBzaGFkb3dzLCBleHBvcnQgc2V0dGluZ3MsIG9yIG90aGVyIHBhaW50IGRhdGEsIGV4cG9ydGluZyBhIGJpdG1hcFxyXG4gICAgICAgIC8vIHdvdWxkIGxvc2UgdGhlIHRleHQgc2VtYW50aWNzIGFuZCBtYWtlIHRoZSBpbXBvcnRlZCBVSSBpbXBvc3NpYmxlXHJcbiAgICAgICAgLy8gdG8gZWRpdC5cclxuICAgICAgICByZXR1cm4gJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIGlmIChoYXNNYW51YWxFeHBvcnQobm9kZSkgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAoQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiAnZ2VuZXJhdGUnO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKVxyXG4gICAgICAgICAgICA/ICdyZW5kZXInXHJcbiAgICAgICAgICAgIDogJ2dlbmVyYXRlJztcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gJ3JlbmRlcic7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnRUxMSVBTRScgfHwgbm9kZS50eXBlID09PSAnUkVDVEFOR0xFJykge1xyXG4gICAgICAgIHJldHVybiBoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpXHJcbiAgICAgICAgICAgID8gJ3JlbmRlcidcclxuICAgICAgICAgICAgOiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdyZW5kZXInO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzSGlkZGVuRGVzY2VuZGFudChub2RlOiBQaWNrPEZpZ21hTm9kZSwgJ2NoaWxkcmVuJz4pOiBib29sZWFuIHtcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UgfHwgaGFzSGlkZGVuRGVzY2VuZGFudChjaGlsZCkpO1xufVxuXG5mdW5jdGlvbiBoYXNFeHBsaWNpdFNjcm9sbChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcbiAgICBjb25zdCBvdmVyZmxvd0RpcmVjdGlvbiA9IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24/LnRyaW0oKS50b1VwcGVyQ2FzZSgpID8/ICcnO1xyXG4gICAgcmV0dXJuIEZJR01BX1NDUk9MTF9ESVJFQ1RJT05TLmhhcyhvdmVyZmxvd0RpcmVjdGlvbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKG5vZGUudmlzaWJsZSA9PT0gZmFsc2UgfHwgbm9kZS5vcGFjaXR5IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIHJldHVybiAhZnJhbWUgfHwgKGZyYW1lLndpZHRoID4gMCAmJiBmcmFtZS5oZWlnaHQgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgbmFtZSA9IG5vZGUubmFtZS50cmltKCk7XHJcbiAgICByZXR1cm4gRVhBQ1RfU0VNQU5USUNfTkFNRVMuaGFzKG5hbWUudG9Mb3dlckNhc2UoKSlcclxuICAgICAgICB8fCBSVU5USU1FX1JPTEVfTkFNRS50ZXN0KG5hbWUpXHJcbiAgICAgICAgfHwgaGFzRXhwbGljaXRTY3JvbGwobm9kZSlcclxuICAgICAgICB8fCBCb29sZWFuKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEEgbWVzc3kgdmlzdWFsIHdyYXBwZXIgbXVzdCBub3QgYWJzb3JiIGFuIGVkaXRhYmxlIG9yIGluZGVwZW5kZW50bHkgcGxhbm5lZFxyXG4gKiBkZXNjZW5kYW50LiBTdHJ1Y3R1cmVkIG5hbWVzLCB0ZXh0LCBzY3JvbGxpbmcvbGF5b3V0IHNlbWFudGljcywgbWFudWFsXHJcbiAqIGV4cG9ydHMgYW5kIHNsaWNlIGdyb3VwcyBhbGwgbmVlZCB0byBrZWVwIHRoZWlyIG93biBpbXBvcnQgYm91bmRhcnkuXHJcbiAqL1xyXG5mdW5jdGlvbiBzdWJ0cmVlUmVxdWlyZXNTdHJ1Y3R1cmUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnXHJcbiAgICAgICAgfHwgaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGlzUnVudGltZVJvbGVCb3VuZGFyeShub2RlKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFpc0VmZmVjdGl2ZWx5VmlzaWJsZShub2RlKSB8fCBub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhhc1Zpc2libGVGaWxsID0gbm9kZS5maWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudmlzaWJsZSAhPT0gZmFsc2UgJiYgKGZpbGwub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZVN0cm9rZSA9IG5vZGUuc3Ryb2tlV2VpZ2h0ID4gMCAmJiBub2RlLnN0cm9rZXMuc29tZSgoc3Ryb2tlKSA9PlxyXG4gICAgICAgIHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVFZmZlY3QgPSBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG4gICAgaWYgKGhhc1Zpc2libGVGaWxsIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCB8fCBpc1ZlY3Rvck5vZGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmICghQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJlbmRlck1lc3N5U3VidHJlZShub2RlOiBGaWdtYU5vZGUsIGlzUm9vdDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICAgIGlmIChpc1Jvb3RcbiAgICAgICAgfHwgIUNPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKVxuICAgICAgICB8fCAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUobm9kZS5uYW1lKVxyXG4gICAgICAgIHx8IGhhc01hbnVhbEV4cG9ydChub2RlKVxyXG4gICAgICAgIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gSGlkZGVuIGNoaWxkcmVuIG11c3QgcmVtYWluIGluZGVwZW5kZW50IENvY29zIG5vZGVzIHNvIHRoZWlyIEluYWN0aXZlXG4gICAgLy8gc3RhdGUgY2FuIGJlIHJlc3RvcmVkIGxhdGVyLiBBbiBhdXRvbWF0aWMgcGFyZW50IFBORyB3b3VsZCBlcmFzZSB0aGF0XG4gICAgLy8gcnVudGltZSBib3VuZGFyeS4gQW4gYWxyZWFkeS1oaWRkZW4gaG9zdCBtYXkgc3RpbGwgdXNlIHRoZSBzYW1lIHZpc3VhbFxuICAgIC8vIGhldXJpc3RpYyBhcyBhIHZpc2libGUgaG9zdCB3aGVuIGl0cyBkaXJlY3QgY2hpbGRyZW4gYXJlIHZpc2libGUuXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgPT09IGZhbHNlKSkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IHZpc2libGVDaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4uZmlsdGVyKGlzRWZmZWN0aXZlbHlWaXNpYmxlKTtcbiAgICByZXR1cm4gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCA+IDBcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uZXZlcnkoKGNoaWxkKSA9PiAhaXNTdHJ1Y3R1cmVkTm9kZU5hbWUoY2hpbGQubmFtZSkpXHJcbiAgICAgICAgJiYgIXZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZSlcclxuICAgICAgICAmJiB2aXNpYmxlQ2hpbGRyZW4uc29tZShzdWJ0cmVlSGFzVmlzdWFsQ29udGVudCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBCb29sZWFuKGFuYWx5emVTbGljZUdyaWQobm9kZSkpO1xufVxyXG5cclxuZnVuY3Rpb24gd2FybmluZ0ZvcihcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgcmVuZGVyTWVzc3lTdWJ0cmVlOiBib29sZWFuLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGluYWN0aXZlID0gbm9kZS52aXNpYmxlXG4gICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgIDogJ0ZpZ21hIOWbvuWxguW3sumakOiXj++8jOWvvOWFpeWQjuiKgueCueWwhuWcqCBDb2NvcyDkuK3kv53mjIEgSW5hY3RpdmUnO1xuICAgIGNvbnN0IHdpdGhJbmFjdGl2ZSA9ICh3YXJuaW5nPzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICAgIFtpbmFjdGl2ZSwgd2FybmluZ10uZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gQm9vbGVhbihpdGVtKSkuam9pbign77ybJykgfHwgdW5kZWZpbmVkO1xuICAgIGlmICghbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+e8uuWwkei+ueeVjOS/oeaBr++8jOWwhuaMiSAww5cwIOWvvOWFpScpO1xuICAgIH1cbiAgICBpZiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSkge1xuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmo4DmtYvliLAgRmlnbWEgRXhwb3J0IOiuvue9ru+8jOaZuuiDveaooeW8j+WwhuaMiSBQTkcg5pW05bGC5a+85YWl77ybRmlnbWEg55qE5qC85byP44CB5ZCO57yA5ZKM5YCN546H5LiN5rK/55SoJyk7XG4gICAgfVxuICAgIGlmIChpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKGFuYWx5emVTbGljZUdyaWQobm9kZSlcbiAgICAgICAgICAgID8gJ+ajgOa1i+WIsOacieaViOeahCAzLzkg5LiqIFJlY3RhbmdsZSDov57nu63liIfniYfvvIzlsIbmjIkgUE5HIOaVtOWxguWvvOWFpeOAgeiHquWKqOWQr+eUqOWIh+eJh+W5tuS8mOWFiOWkjeeUqOWQjOWQjei1hOa6kCdcbiAgICAgICAgICAgIDogJ+ajgOa1i+WIsCAzLzkg5LiqIFJlY3RhbmdsZSDlkb3lkI3oioLngrnvvIzkvYblh6DkvZXmnKrlvaLmiJDov57nu63liIfniYfvvJvlsIbmjIkgUE5HIOaVtOWxguWvvOWFpe+8jOS4jeiHquWKqOWQr+eUqOWIh+eJhycpO1xuICAgIH1cbiAgICBpZiAobm9kZS5ibGVuZE1vZGUgJiYgIVsnTk9STUFMJywgJ1BBU1NfVEhST1VHSCddLmluY2x1ZGVzKG5vZGUuYmxlbmRNb2RlKSkge1xuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKGDmt7flkIjmqKHlvI8gJHtub2RlLmJsZW5kTW9kZX0g5bCG6L+R5Ly85aSE55CGYCk7XG4gICAgfVxuICAgIGlmIChyZW5kZXJNZXNzeVN1YnRyZWUpIHtcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5omA5pyJ5pyJ5pWI5Y+v6KeB55u05o6l5a2Q5bGC5Z2H5Li66Z2e57uT5p6E5YyW57qv6KeG6KeJ5YaF5a6577yM5LiU5pyq5qOA5rWL5Yiw5paH5a2X5oiW6L+Q6KGM5pe257uT5p6E77yM5pm66IO95qih5byP5bCG5oyJIFBORyDmlbTlsYLlr7zlhaUnKTtcbiAgICB9XG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnICYmIG5vZGUuY2hhcmFjdGVycyAmJiAhL1tcXHJcXG5cXHUyMDI4XFx1MjAyOV0vLnRlc3Qobm9kZS5jaGFyYWN0ZXJzKSkge1xyXG4gICAgICAgIGNvbnN0IGxpbmVIZWlnaHQgPSBub2RlLnN0eWxlPy5saW5lSGVpZ2h0UHggPz8gbm9kZS5zdHlsZT8uZm9udFNpemUgPz8gMDtcclxuICAgICAgICBjb25zdCBmcmFtZUhlaWdodCA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveD8uaGVpZ2h0ID8/IDA7XG4gICAgICAgIGlmIChsaW5lSGVpZ2h0ID4gMCAmJiBmcmFtZUhlaWdodCA+IGxpbmVIZWlnaHQgKiAxLjI1KSB7XG4gICAgICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmlofmnKznlpHkvLznlLEgRmlnbWEg6Ieq5Yqo5o2i6KGM77ybTk9ORSDmqKHlvI/lj6ror4bliKvmiYvliqjmjaLooYzvvIzor7flnKggRmlnbWEg5Lit5o+S5YWl5o2i6KGM56ymJyk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICYmIChoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpKSkge1xyXG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+WkjeadguWuueWZqOWwhuS8mOWFiOS/neeVmeWPr+e8lui+keWtkOiKgueCue+8jOiDjOaZr+S8mui/keS8vOWkhOeQhicpO1xuICAgIH1cbiAgICByZXR1cm4gd2l0aEluYWN0aXZlKCk7XG59XHJcblxyXG5mdW5jdGlvbiB0b1RyZWUobm9kZTogRmlnbWFOb2RlLCBpc1Jvb3Q6IGJvb2xlYW4pOiBUcmVlTm9kZUR0byB7XG4gICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XG4gICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IGFuYWx5emVTbGljZUdyaWQobm9kZSk7XG4gICAgY29uc3QgaW5mZXJyZWRBY3Rpb24gPSBpbmZlckFjdGlvbihub2RlKTtcclxuICAgIGNvbnN0IHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICYmIGhhc01hbnVhbEV4cG9ydChub2RlKTtcclxuICAgIGNvbnN0IHJlbmRlck1lc3N5U3VidHJlZSA9IHNob3VsZFJlbmRlck1lc3N5U3VidHJlZShub2RlLCBpc1Jvb3QpO1xyXG4gICAgY29uc3QgcmVuZGVyU3VidHJlZSA9IGluZmVycmVkQWN0aW9uICE9PSAnaWdub3JlJ1xyXG4gICAgICAgICYmIChyZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlIHx8IGlzTmFtZWRTbGljZUdyb3VwKG5vZGUpIHx8IHJlbmRlck1lc3N5U3VidHJlZSk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IG5vZGUubmFtZSxcclxuICAgICAgICB0eXBlOiBub2RlLnR5cGUsXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIHdpZHRoOiBmcmFtZT8ud2lkdGggPz8gMCxcclxuICAgICAgICBoZWlnaHQ6IGZyYW1lPy5oZWlnaHQgPz8gMCxcclxuICAgICAgICBhY3Rpb246IHJlbmRlclN1YnRyZWUgPyAncmVuZGVyJyA6IGluZmVycmVkQWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICByZW5kZXJTdWJ0cmVlLFxuICAgICAgICBwYXRjaENhbmRpZGF0ZTogQm9vbGVhbihzbGljZUFuYWx5c2lzKSxcbiAgICAgICAgc2xpY2VNb2RlOiBzbGljZUFuYWx5c2lzPy5tb2RlLFxuICAgICAgICB3YXJuaW5nOiB3YXJuaW5nRm9yKG5vZGUsIHJlbmRlck1hbnVhbEV4cG9ydFN1YnRyZWUsIHJlbmRlck1lc3N5U3VidHJlZSksXG4gICAgICAgIGNoaWxkcmVuOiBub2RlLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHRvVHJlZShjaGlsZCwgZmFsc2UpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhbmFseXplVHJlZShyb290czogRmlnbWFOb2RlW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiByb290cy5tYXAoKHJvb3QpID0+IHRvVHJlZShyb290LCB0cnVlKSk7XHJcbn1cclxuIl19