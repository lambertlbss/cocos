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
    return isNamedSliceGroup(node) || Boolean((0, slicing_1.analyzeSliceGrid)(node));
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
        return withInactive('检测到 3/9 个 Rectangle 切片，将按 PNG 整层导入并优先复用同名资源');
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
        patchCandidate: isPatchCandidate(node),
        sliceMode: sliceAnalysis === null || sliceAnalysis === void 0 ? void 0 : sliceAnalysis.mode,
        warning: warningFor(node, renderManualExportSubtree, renderMessySubtree),
        children: node.children.map((child) => toTree(child, false)),
    };
}
function analyzeTree(roots) {
    return roots.map((root) => toTree(root, true));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW5hbHl6ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zb3VyY2UvZmlnbWEvYW5hbHl6ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUF3Q0Esb0NBRUM7QUFFRCxvREFPQztBQUVELDhDQUdDO0FBRUQsMENBRUM7QUFhRCw0Q0FvQkM7QUFFRCw4Q0FFQztBQU1ELHdEQW9EQztBQXFCRCxvREF3QkM7QUFFRCw4QkFxQkM7QUFFRCxrQ0E0QkM7QUFFRCxrREFFQztBQTRERCw0REFxQkM7QUFFRCw0Q0FFQztBQW9FRCxrQ0FFQztBQTNaRCx1Q0FBNkM7QUFFN0MsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDNUIsVUFBVTtJQUNWLFFBQVE7SUFDUixPQUFPO0lBQ1AsT0FBTztJQUNQLFNBQVM7SUFDVCxXQUFXO0lBQ1gsZUFBZTtJQUNmLFVBQVU7Q0FDYixDQUFDLENBQUM7QUFFSCxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUN6QixRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0lBQ2pCLHNFQUFzRTtJQUN0RSx3RUFBd0U7SUFDeEUsV0FBVztJQUNYLFNBQVM7Q0FDWixDQUFDLENBQUM7QUFFSCxNQUFNLG9CQUFvQixHQUFHLDZCQUE2QixDQUFDO0FBQzNELE1BQU0sb0JBQW9CLEdBQUcsMENBQTBDLENBQUM7QUFDeEUsTUFBTSxrQkFBa0IsR0FBRywrR0FBK0csQ0FBQztBQUMzSSxNQUFNLGlCQUFpQixHQUFHLHNGQUFzRixDQUFDO0FBQ2pILE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUMxRCxNQUFNLHVCQUF1QixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ3BDLHNCQUFzQjtJQUN0QixvQkFBb0I7SUFDcEIsbUNBQW1DO0lBQ25DLFlBQVk7SUFDWixVQUFVO0lBQ1YsTUFB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LFFBQVEsQ0FBQyxDQUFDLENBQUMsY0FBYztRQUNqRCxJQUFJLEVBQUUsU0FBUyxDQUFDLElBQUksQ0FBQztRQUNyQixhQUFhO1FBQ2IsY0FBYyxFQUFFLGdCQUFnQixDQUFDLElBQUksQ0FBQztRQUN0QyxTQUFTLEVBQUUsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLElBQUk7UUFDOUIsT0FBTyxFQUFFLFVBQVUsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUUsa0JBQWtCLENBQUM7UUFDeEUsUUFBUSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO0tBQy9ELENBQUM7QUFDTixDQUFDO0FBRUQsU0FBZ0IsV0FBVyxDQUFDLEtBQWtCO0lBQzFDLE9BQU8sS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEZpZ21hTm9kZSwgSW1wb3J0QWN0aW9uLCBOb2RlS2luZCwgVHJlZU5vZGVEdG8gfSBmcm9tICcuLi90eXBlcyc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQgfSBmcm9tICcuL3NsaWNpbmcnO1xyXG5cclxuY29uc3QgQ09OVEFJTkVSX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnRE9DVU1FTlQnLFxyXG4gICAgJ0NBTlZBUycsXHJcbiAgICAnRlJBTUUnLFxyXG4gICAgJ0dST1VQJyxcclxuICAgICdTRUNUSU9OJyxcclxuICAgICdDT01QT05FTlQnLFxyXG4gICAgJ0NPTVBPTkVOVF9TRVQnLFxyXG4gICAgJ0lOU1RBTkNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBWRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG4gICAgLy8gRmlnbWEgcmVwcmVzZW50cyBiYXNpYyBzaGFwZSBsYXllcnMgYXMgdmVjdG9yIGdlb21ldHJ5IHRvby4gS2VlcGluZ1xyXG4gICAgLy8gdGhlbSBpbiB0aGUgcmFzdGVyIHBhdGggcHJldmVudHMgY2MuR3JhcGhpY3MgZnJvbSBhcHByb3hpbWF0aW5nIHRoZW0uXHJcbiAgICAnUkVDVEFOR0xFJyxcclxuICAgICdFTExJUFNFJyxcclxuXSk7XHJcblxyXG5jb25zdCBTTElDRV9SRUNUQU5HTEVfTkFNRSA9IC9eUmVjdGFuZ2xlKD86W1xcc18tXSpcXGQrKT8kL2k7XHJcbmNvbnN0IFNUUlVDVFVSRURfTk9ERV9OQU1FID0gL15bQS1aYS16XVtBLVphLXowLTldKig/Ol9bQS1aYS16MC05XSspKyQvO1xyXG5jb25zdCBTRU1BTlRJQ19OT0RFX05BTUUgPSAvXig/OnBhbmVsfGxpc3R8bGF5b3V0fGJ0bnxidXR0b258aW1nfGltYWdlfGljb258Ymd8c3ByaXRlfHR4dHx0ZXh0fGxhYmVsKV9bXFxwe0x9XFxwe059XSsoPzpfW1xccHtMfVxccHtOfV0rKSokL2l1O1xyXG5jb25zdCBSVU5USU1FX1JPTEVfTkFNRSA9IC9eKD86cGFuZWx8bGlzdHxsYXlvdXR8YnRufGJ1dHRvbnx0eHR8dGV4dHxsYWJlbClfW1xccHtMfVxccHtOfV0rKD86X1tcXHB7TH1cXHB7Tn1dKykqJC9pdTtcclxuY29uc3QgRVhBQ1RfU0VNQU5USUNfTkFNRVMgPSBuZXcgU2V0KFsndmlldycsICdjb250ZW50J10pO1xyXG5jb25zdCBGSUdNQV9TQ1JPTExfRElSRUNUSU9OUyA9IG5ldyBTZXQoW1xyXG4gICAgJ0hPUklaT05UQUxfU0NST0xMSU5HJyxcclxuICAgICdWRVJUSUNBTF9TQ1JPTExJTkcnLFxyXG4gICAgJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycsXHJcbiAgICAnSE9SSVpPTlRBTCcsXHJcbiAgICAnVkVSVElDQUwnLFxyXG4gICAgJ0JPVEgnLFxyXG5dKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1ZlY3Rvck5vZGUobm9kZTogUGljazxGaWdtYU5vZGUsICd0eXBlJz4pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBWRUNUT1JfVFlQRVMuaGFzKG5vZGUudHlwZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0cnVjdHVyZWROb2RlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIGlmIChuYW1lICE9PSBuYW1lLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFNUUlVDVFVSRURfTk9ERV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBTRU1BTlRJQ19OT0RFX05BTUUudGVzdChuYW1lKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzTmFtZWRTbGljZUdyb3VwKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIChub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gMyB8fCBub2RlLmNoaWxkcmVuLmxlbmd0aCA9PT0gOSlcclxuICAgICAgICAmJiBub2RlLmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gU0xJQ0VfUkVDVEFOR0xFX05BTUUudGVzdChjaGlsZC5uYW1lLnRyaW0oKSkpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaGFzTWFudWFsRXhwb3J0KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnaGFzRXhwb3J0U2V0dGluZ3MnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIG5vZGUuaGFzRXhwb3J0U2V0dGluZ3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc1Zpc2libGVJbWFnZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+IGZpbGwudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAoZmlsbC50eXBlID09PSAnSU1BR0UnIHx8IGZpbGwudHlwZSA9PT0gJ1BBVFRFUk4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgVGlsZWRQYWludFNvdXJjZSB7XHJcbiAgICBraW5kOiAnaW1hZ2UtcmVmJyB8ICdzb3VyY2Utbm9kZSc7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUGFpbnRTb3VyY2Uobm9kZTogUGljazxGaWdtYU5vZGUsICdmaWxscyc+KTogVGlsZWRQYWludFNvdXJjZSB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGwgb2Ygbm9kZS5maWxscykge1xyXG4gICAgICAgIGlmIChmaWxsLnZpc2libGUgPT09IGZhbHNlIHx8IChmaWxsLm9wYWNpdHkgPz8gMSkgPD0gMCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgZmlsbC5zY2FsaW5nRmFjdG9yID09PSAnbnVtYmVyJ1xyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUoZmlsbC5zY2FsaW5nRmFjdG9yKVxyXG4gICAgICAgICAgICAmJiBmaWxsLnNjYWxpbmdGYWN0b3IgPiAwXHJcbiAgICAgICAgICAgID8gZmlsbC5zY2FsaW5nRmFjdG9yXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnUEFUVEVSTicgJiYgZmlsbC5zb3VyY2VOb2RlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHsga2luZDogJ3NvdXJjZS1ub2RlJywgaWQ6IGZpbGwuc291cmNlTm9kZUlkLCBzY2FsZSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmlsbC50eXBlID09PSAnSU1BR0UnXHJcbiAgICAgICAgICAgICYmIGZpbGwuc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnVElMRSdcclxuICAgICAgICAgICAgJiYgZmlsbC5pbWFnZVJlZikge1xyXG4gICAgICAgICAgICByZXR1cm4geyBraW5kOiAnaW1hZ2UtcmVmJywgaWQ6IGZpbGwuaW1hZ2VSZWYsIHNjYWxlIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGhhc1RpbGVkSW1hZ2VGaWxsKG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnZmlsbHMnPik6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odGlsZWRQYWludFNvdXJjZShub2RlKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBIG5hdGl2ZSB0aWxlZCBTcHJpdGUgcmVwcmVzZW50cyBleGFjdGx5IG9uZSBwYWludC4gTGF5ZXJzIHdpdGggYWRkaXRpb25hbFxyXG4gKiB2aXN1YWxzIG9yIGRlc2NlbmRhbnRzIG11c3Qgc3RheSBvbiB0aGUgd2hvbGUtbm9kZSByYXN0ZXIgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGU6IEZpZ21hTm9kZSk6IFRpbGVkUGFpbnRTb3VyY2UgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3Qgc291cmNlID0gdGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgIGlmICghc291cmNlIHx8IG5vZGUuaGFzRXhwb3J0U2V0dGluZ3MgfHwgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgIT09ICdFTExJUFNFJyAmJiBub2RlLnR5cGUgIT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyAmJiBub2RlLmFyY0RhdGEpIHtcclxuICAgICAgICBjb25zdCBzd2VlcCA9IE1hdGguYWJzKG5vZGUuYXJjRGF0YS5lbmRpbmdBbmdsZSAtIG5vZGUuYXJjRGF0YS5zdGFydGluZ0FuZ2xlKTtcclxuICAgICAgICBpZiAobm9kZS5hcmNEYXRhLmlubmVyUmFkaXVzID4gMWUtNiB8fCBzd2VlcCA8IE1hdGguUEkgKiAyIC0gMWUtNikge1xyXG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgY29uc3QgcmFkaWkgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgICAgID8/IFtcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgICAgICBub2RlLmNvcm5lclJhZGl1cyA/PyAwLFxyXG4gICAgICAgICAgICAgICAgbm9kZS5jb3JuZXJSYWRpdXMgPz8gMCxcclxuICAgICAgICAgICAgICAgIG5vZGUuY29ybmVyUmFkaXVzID8/IDAsXHJcbiAgICAgICAgICAgIF07XHJcbiAgICAgICAgaWYgKHJhZGlpLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMWUtNikpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlRmlsbHMgPSBub2RlLmZpbGxzLmZpbHRlcigoZmlsbCkgPT5cclxuICAgICAgICBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IGhhc1Zpc2libGVTdHJva2UgPSBub2RlLnN0cm9rZVdlaWdodCA+IDAgJiYgbm9kZS5zdHJva2VzLnNvbWUoKHN0cm9rZSkgPT5cclxuICAgICAgICBzdHJva2UudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHN0cm9rZS5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlRWZmZWN0ID0gbm9kZS5lZmZlY3RzLnNvbWUoKGVmZmVjdCkgPT4gZWZmZWN0LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlRmlsbHMubGVuZ3RoICE9PSAxIHx8IGhhc1Zpc2libGVTdHJva2UgfHwgaGFzVmlzaWJsZUVmZmVjdCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZUZpbGxzWzBdO1xyXG4gICAgaWYgKChmaWxsLm9wYWNpdHkgPz8gMSkgPCAwLjk5OVxyXG4gICAgICAgIHx8IE1hdGguYWJzKGZpbGwucm90YXRpb24gPz8gMCkgPiAxZS02XHJcbiAgICAgICAgfHwgKGZpbGwuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhmaWxsLmJsZW5kTW9kZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGlmIChmaWxsLnR5cGUgPT09ICdQQVRURVJOJykge1xyXG4gICAgICAgIGNvbnN0IHNwYWNpbmcgPSBmaWxsLnNwYWNpbmcgPz8geyB4OiAwLCB5OiAwIH07XHJcbiAgICAgICAgY29uc3QgdW5zdXBwb3J0ZWRQYXR0ZXJuID0gKGZpbGwudGlsZVR5cGUgJiYgZmlsbC50aWxlVHlwZSAhPT0gJ1JFQ1RBTkdVTEFSJylcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy54KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgTWF0aC5hYnMoc3BhY2luZy55KSA+IDFlLTZcclxuICAgICAgICAgICAgfHwgKGZpbGwuaG9yaXpvbnRhbEFsaWdubWVudCAmJiBmaWxsLmhvcml6b250YWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpXHJcbiAgICAgICAgICAgIHx8IChmaWxsLnZlcnRpY2FsQWxpZ25tZW50ICYmIGZpbGwudmVydGljYWxBbGlnbm1lbnQgIT09ICdTVEFSVCcpO1xyXG4gICAgICAgIGlmICh1bnN1cHBvcnRlZFBhdHRlcm4pIHtcclxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4RWZmZWN0cyhub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBub2RlLmVmZmVjdHMuc29tZSgoZWZmZWN0KSA9PiBlZmZlY3QudmlzaWJsZSAhPT0gZmFsc2UpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNDb21wbGV4UGFpbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxscyA9IG5vZGUuZmlsbHMuZmlsdGVyKChmaWxsKSA9PiBmaWxsLnZpc2libGUgIT09IGZhbHNlICYmIChmaWxsLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHN0cm9rZXMgPSBub2RlLnN0cm9rZXMuZmlsdGVyKChzdHJva2UpID0+IHN0cm9rZS52aXNpYmxlICE9PSBmYWxzZSAmJiAoc3Ryb2tlLm9wYWNpdHkgPz8gMSkgPiAwKTtcclxuICAgIGNvbnN0IHVuc3VwcG9ydGVkR3JhZGllbnQgPSBmaWxscy5zb21lKChmaWxsKSA9PlxyXG4gICAgICAgIGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0FOR1VMQVInIHx8IGZpbGwudHlwZSA9PT0gJ0dSQURJRU5UX0RJQU1PTkQnKTtcclxuICAgIGNvbnN0IHVuZXZlbkNvcm5lcnMgPSBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpXHJcbiAgICAgICAgPyBuZXcgU2V0KG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkubWFwKChyYWRpdXMpID0+IE1hdGgucm91bmQocmFkaXVzICogMTAwMCkpKS5zaXplID4gMVxyXG4gICAgICAgIDogZmFsc2U7XHJcbiAgICByZXR1cm4gZmlsbHMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHN0cm9rZXMubGVuZ3RoID4gMVxyXG4gICAgICAgIHx8IHVuc3VwcG9ydGVkR3JhZGllbnRcclxuICAgICAgICB8fCB1bmV2ZW5Db3JuZXJzXHJcbiAgICAgICAgfHwgQm9vbGVhbihzdHJva2VzLmxlbmd0aCAmJiBub2RlLnN0cm9rZUFsaWduICYmIG5vZGUuc3Ryb2tlQWxpZ24gIT09ICdDRU5URVInKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBtb2RlID0gbm9kZS5sYXlvdXRNb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aXNpYmxlQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICh2aXNpYmxlQ2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLmxheW91dFBvc2l0aW9uaW5nID09PSAnQUJTT0xVVEUnKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBuZWVkc0dyaWRWYWxpZGF0aW9uID0gbW9kZSA9PT0gJ0dSSUQnIHx8IG5vZGUubGF5b3V0V3JhcCA9PT0gJ1dSQVAnO1xyXG4gICAgaWYgKCFuZWVkc0dyaWRWYWxpZGF0aW9uKSB7XHJcbiAgICAgICAgcmV0dXJuIG1vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSB2aXNpYmxlQ2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIE5vbk51bGxhYmxlPEZpZ21hTm9kZVsnYWJzb2x1dGVCb3VuZGluZ0JveCddPiA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoZnJhbWVzLmxlbmd0aCAhPT0gdmlzaWJsZUNoaWxkcmVuLmxlbmd0aCB8fCBmcmFtZXMubGVuZ3RoIDwgMikge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aHMgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUud2lkdGgpO1xyXG4gICAgY29uc3QgaGVpZ2h0cyA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpO1xyXG4gICAgY29uc3QgdW5pZm9ybVdpZHRoID0gTWF0aC5tYXgoLi4ud2lkdGhzKSAtIE1hdGgubWluKC4uLndpZHRocykgPD0gMjtcclxuICAgIGNvbnN0IHVuaWZvcm1IZWlnaHQgPSBNYXRoLm1heCguLi5oZWlnaHRzKSAtIE1hdGgubWluKC4uLmhlaWdodHMpIDw9IDI7XHJcbiAgICByZXR1cm4gdW5pZm9ybVdpZHRoICYmIHVuaWZvcm1IZWlnaHQgPyAnR1JJRCcgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlcktpbmQobm9kZTogRmlnbWFOb2RlKTogTm9kZUtpbmQge1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYWJlbCc7XHJcbiAgICB9XHJcbiAgICAvLyBBIG5hbWUgb3IgY2xpcHBpbmcgcmVjdGFuZ2xlIGlzIG5vdCBwcm9vZiBvZiBpbnRlcmFjdGl2ZSBzY3JvbGxpbmcuXHJcbiAgICAvLyBPbmx5IEZpZ21hJ3MgZXhwbGljaXQgcHJvdG90eXBlIG92ZXJmbG93IHNldHRpbmcgbWF5IGNoYW5nZSB0aGUgQ29jb3NcclxuICAgIC8vIGhpZXJhcmNoeSB0byBTY3JvbGxWaWV3IC0+IHZpZXcgLT4gY29udGVudCBpbiBhdXRvbWF0aWMgbW9kZS5cclxuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICBpZiAoRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKSkge1xyXG4gICAgICAgIHJldHVybiAnc2Nyb2xsVmlldyc7XHJcbiAgICB9XHJcbiAgICBpZiAoLyhefF8pYnRuX3xidXR0b2585oyJ6ZKuL2kudGVzdChub2RlLm5hbWUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdidXR0b24nO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuICdsYXlvdXQnO1xyXG4gICAgfVxyXG4gICAgaWYgKENPTlRBSU5FUl9UWVBFUy5oYXMobm9kZS50eXBlKSkge1xyXG4gICAgICAgIHJldHVybiAnbm9kZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3Nwcml0ZSc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmZlckFjdGlvbihub2RlOiBGaWdtYU5vZGUpOiBJbXBvcnRBY3Rpb24ge1xuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xuICAgICAgICAvLyBUZXh0IHJlbWFpbnMgYW4gZWRpdGFibGUgQ29jb3MgTGFiZWwuIEV2ZW4gd2hlbiBGaWdtYSByZXBvcnRzIGZpbGxzLFxyXG4gICAgICAgIC8vIHNoYWRvd3MsIGV4cG9ydCBzZXR0aW5ncywgb3Igb3RoZXIgcGFpbnQgZGF0YSwgZXhwb3J0aW5nIGEgYml0bWFwXHJcbiAgICAgICAgLy8gd291bGQgbG9zZSB0aGUgdGV4dCBzZW1hbnRpY3MgYW5kIG1ha2UgdGhlIGltcG9ydGVkIFVJIGltcG9zc2libGVcclxuICAgICAgICAvLyB0byBlZGl0LlxyXG4gICAgICAgIHJldHVybiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKGhhc01hbnVhbEV4cG9ydChub2RlKSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuICdnZW5lcmF0ZSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBoYXNWaXNpYmxlSW1hZ2Uobm9kZSkgfHwgaGFzQ29tcGxleEVmZmVjdHMobm9kZSkgfHwgaGFzQ29tcGxleFBhaW50KG5vZGUpXHJcbiAgICAgICAgICAgID8gJ3JlbmRlcidcclxuICAgICAgICAgICAgOiAnZ2VuZXJhdGUnO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiAncmVuZGVyJztcclxuICAgIH1cclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdFTExJUFNFJyB8fCBub2RlLnR5cGUgPT09ICdSRUNUQU5HTEUnKSB7XHJcbiAgICAgICAgcmV0dXJuIGhhc1Zpc2libGVJbWFnZShub2RlKSB8fCBoYXNDb21wbGV4RWZmZWN0cyhub2RlKSB8fCBoYXNDb21wbGV4UGFpbnQobm9kZSlcclxuICAgICAgICAgICAgPyAncmVuZGVyJ1xyXG4gICAgICAgICAgICA6ICdnZW5lcmF0ZSc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ3JlbmRlcic7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGU6IFBpY2s8RmlnbWFOb2RlLCAnY2hpbGRyZW4nPik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlID09PSBmYWxzZSB8fCBoYXNIaWRkZW5EZXNjZW5kYW50KGNoaWxkKSk7XG59XG5cbmZ1bmN0aW9uIGhhc0V4cGxpY2l0U2Nyb2xsKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IG92ZXJmbG93RGlyZWN0aW9uID0gbm9kZS5vdmVyZmxvd0RpcmVjdGlvbj8udHJpbSgpLnRvVXBwZXJDYXNlKCkgPz8gJyc7XHJcbiAgICByZXR1cm4gRklHTUFfU0NST0xMX0RJUkVDVElPTlMuaGFzKG92ZXJmbG93RGlyZWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNFZmZlY3RpdmVseVZpc2libGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAobm9kZS52aXNpYmxlID09PSBmYWxzZSB8fCBub2RlLm9wYWNpdHkgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgcmV0dXJuICFmcmFtZSB8fCAoZnJhbWUud2lkdGggPiAwICYmIGZyYW1lLmhlaWdodCA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBuYW1lID0gbm9kZS5uYW1lLnRyaW0oKTtcclxuICAgIHJldHVybiBFWEFDVF9TRU1BTlRJQ19OQU1FUy5oYXMobmFtZS50b0xvd2VyQ2FzZSgpKVxyXG4gICAgICAgIHx8IFJVTlRJTUVfUk9MRV9OQU1FLnRlc3QobmFtZSlcclxuICAgICAgICB8fCBoYXNFeHBsaWNpdFNjcm9sbChub2RlKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSkpO1xyXG59XHJcblxyXG4vKipcclxuICogQSBtZXNzeSB2aXN1YWwgd3JhcHBlciBtdXN0IG5vdCBhYnNvcmIgYW4gZWRpdGFibGUgb3IgaW5kZXBlbmRlbnRseSBwbGFubmVkXHJcbiAqIGRlc2NlbmRhbnQuIFN0cnVjdHVyZWQgbmFtZXMsIHRleHQsIHNjcm9sbGluZy9sYXlvdXQgc2VtYW50aWNzLCBtYW51YWxcclxuICogZXhwb3J0cyBhbmQgc2xpY2UgZ3JvdXBzIGFsbCBuZWVkIHRvIGtlZXAgdGhlaXIgb3duIGltcG9ydCBib3VuZGFyeS5cclxuICovXHJcbmZ1bmN0aW9uIHN1YnRyZWVSZXF1aXJlc1N0cnVjdHVyZShub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuIHtcclxuICAgIGlmICghaXNFZmZlY3RpdmVseVZpc2libGUobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCdcclxuICAgICAgICB8fCBpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaXNSdW50aW1lUm9sZUJvdW5kYXJ5KG5vZGUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWlzRWZmZWN0aXZlbHlWaXNpYmxlKG5vZGUpIHx8IG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGFzVmlzaWJsZUZpbGwgPSBub2RlLmZpbGxzLnNvbWUoKGZpbGwpID0+XHJcbiAgICAgICAgZmlsbC52aXNpYmxlICE9PSBmYWxzZSAmJiAoZmlsbC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbiAgICBjb25zdCBoYXNWaXNpYmxlU3Ryb2tlID0gbm9kZS5zdHJva2VXZWlnaHQgPiAwICYmIG5vZGUuc3Ryb2tlcy5zb21lKChzdHJva2UpID0+XHJcbiAgICAgICAgc3Ryb2tlLnZpc2libGUgIT09IGZhbHNlICYmIChzdHJva2Uub3BhY2l0eSA/PyAxKSA+IDApO1xyXG4gICAgY29uc3QgaGFzVmlzaWJsZUVmZmVjdCA9IG5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAoaGFzVmlzaWJsZUZpbGwgfHwgaGFzVmlzaWJsZVN0cm9rZSB8fCBoYXNWaXNpYmxlRWZmZWN0IHx8IGlzVmVjdG9yTm9kZShub2RlKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKCFDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUoc3VidHJlZUhhc1Zpc3VhbENvbnRlbnQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVuZGVyTWVzc3lTdWJ0cmVlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290OiBib29sZWFuKTogYm9vbGVhbiB7XG4gICAgaWYgKGlzUm9vdFxuICAgICAgICB8fCAhQ09OVEFJTkVSX1RZUEVTLmhhcyhub2RlLnR5cGUpXG4gICAgICAgIHx8ICFpc1N0cnVjdHVyZWROb2RlTmFtZShub2RlLm5hbWUpXHJcbiAgICAgICAgfHwgaGFzTWFudWFsRXhwb3J0KG5vZGUpXHJcbiAgICAgICAgfHwgaXNOYW1lZFNsaWNlR3JvdXAobm9kZSlcclxuICAgICAgICB8fCBpc1J1bnRpbWVSb2xlQm91bmRhcnkobm9kZSkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICAvLyBIaWRkZW4gY2hpbGRyZW4gbXVzdCByZW1haW4gaW5kZXBlbmRlbnQgQ29jb3Mgbm9kZXMgc28gdGhlaXIgSW5hY3RpdmVcbiAgICAvLyBzdGF0ZSBjYW4gYmUgcmVzdG9yZWQgbGF0ZXIuIEFuIGF1dG9tYXRpYyBwYXJlbnQgUE5HIHdvdWxkIGVyYXNlIHRoYXRcbiAgICAvLyBydW50aW1lIGJvdW5kYXJ5LiBBbiBhbHJlYWR5LWhpZGRlbiBob3N0IG1heSBzdGlsbCB1c2UgdGhlIHNhbWUgdmlzdWFsXG4gICAgLy8gaGV1cmlzdGljIGFzIGEgdmlzaWJsZSBob3N0IHdoZW4gaXRzIGRpcmVjdCBjaGlsZHJlbiBhcmUgdmlzaWJsZS5cbiAgICBpZiAobm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSA9PT0gZmFsc2UpKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgdmlzaWJsZUNoaWxkcmVuID0gbm9kZS5jaGlsZHJlbi5maWx0ZXIoaXNFZmZlY3RpdmVseVZpc2libGUpO1xuICAgIHJldHVybiB2aXNpYmxlQ2hpbGRyZW4ubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5ldmVyeSgoY2hpbGQpID0+ICFpc1N0cnVjdHVyZWROb2RlTmFtZShjaGlsZC5uYW1lKSlcclxuICAgICAgICAmJiAhdmlzaWJsZUNoaWxkcmVuLnNvbWUoc3VidHJlZVJlcXVpcmVzU3RydWN0dXJlKVxyXG4gICAgICAgICYmIHZpc2libGVDaGlsZHJlbi5zb21lKHN1YnRyZWVIYXNWaXN1YWxDb250ZW50KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzUGF0Y2hDYW5kaWRhdGUobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gaXNOYW1lZFNsaWNlR3JvdXAobm9kZSkgfHwgQm9vbGVhbihhbmFseXplU2xpY2VHcmlkKG5vZGUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FybmluZ0ZvcihcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlOiBib29sZWFuLFxyXG4gICAgcmVuZGVyTWVzc3lTdWJ0cmVlOiBib29sZWFuLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGluYWN0aXZlID0gbm9kZS52aXNpYmxlXG4gICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgIDogJ0ZpZ21hIOWbvuWxguW3sumakOiXj++8jOWvvOWFpeWQjuiKgueCueWwhuWcqCBDb2NvcyDkuK3kv53mjIEgSW5hY3RpdmUnO1xuICAgIGNvbnN0IHdpdGhJbmFjdGl2ZSA9ICh3YXJuaW5nPzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICAgIFtpbmFjdGl2ZSwgd2FybmluZ10uZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gQm9vbGVhbihpdGVtKSkuam9pbign77ybJykgfHwgdW5kZWZpbmVkO1xuICAgIGlmICghbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+e8uuWwkei+ueeVjOS/oeaBr++8jOWwhuaMiSAww5cwIOWvvOWFpScpO1xuICAgIH1cbiAgICBpZiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSkge1xuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmo4DmtYvliLAgRmlnbWEgRXhwb3J0IOiuvue9ru+8jOaZuuiDveaooeW8j+WwhuaMiSBQTkcg5pW05bGC5a+85YWl77ybRmlnbWEg55qE5qC85byP44CB5ZCO57yA5ZKM5YCN546H5LiN5rK/55SoJyk7XG4gICAgfVxuICAgIGlmIChpc05hbWVkU2xpY2VHcm91cChub2RlKSkge1xuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCfmo4DmtYvliLAgMy85IOS4qiBSZWN0YW5nbGUg5YiH54mH77yM5bCG5oyJIFBORyDmlbTlsYLlr7zlhaXlubbkvJjlhYjlpI3nlKjlkIzlkI3otYTmupAnKTtcbiAgICB9XG4gICAgaWYgKG5vZGUuYmxlbmRNb2RlICYmICFbJ05PUk1BTCcsICdQQVNTX1RIUk9VR0gnXS5pbmNsdWRlcyhub2RlLmJsZW5kTW9kZSkpIHtcbiAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZShg5re35ZCI5qih5byPICR7bm9kZS5ibGVuZE1vZGV9IOWwhui/keS8vOWkhOeQhmApO1xuICAgIH1cbiAgICBpZiAocmVuZGVyTWVzc3lTdWJ0cmVlKSB7XG4gICAgICAgIHJldHVybiB3aXRoSW5hY3RpdmUoJ+aJgOacieacieaViOWPr+ingeebtOaOpeWtkOWxguWdh+S4uumdnue7k+aehOWMlue6r+inhuinieWGheWuue+8jOS4lOacquajgOa1i+WIsOaWh+Wtl+aIlui/kOihjOaXtue7k+aehO+8jOaZuuiDveaooeW8j+WwhuaMiSBQTkcg5pW05bGC5a+85YWlJyk7XG4gICAgfVxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBub2RlLmNoYXJhY3RlcnMgJiYgIS9bXFxyXFxuXFx1MjAyOFxcdTIwMjldLy50ZXN0KG5vZGUuY2hhcmFjdGVycykpIHtcclxuICAgICAgICBjb25zdCBsaW5lSGVpZ2h0ID0gbm9kZS5zdHlsZT8ubGluZUhlaWdodFB4ID8/IG5vZGUuc3R5bGU/LmZvbnRTaXplID8/IDA7XHJcbiAgICAgICAgY29uc3QgZnJhbWVIZWlnaHQgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g/LmhlaWdodCA/PyAwO1xuICAgICAgICBpZiAobGluZUhlaWdodCA+IDAgJiYgZnJhbWVIZWlnaHQgPiBsaW5lSGVpZ2h0ICogMS4yNSkge1xuICAgICAgICAgICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgn5paH5pys55aR5Ly855SxIEZpZ21hIOiHquWKqOaNouihjO+8m05PTkUg5qih5byP5Y+q6K+G5Yir5omL5Yqo5o2i6KGM77yM6K+35ZyoIEZpZ21hIOS4reaPkuWFpeaNouihjOespicpO1xuICAgICAgICB9XG4gICAgfVxuICAgIGlmIChDT05UQUlORVJfVFlQRVMuaGFzKG5vZGUudHlwZSkgJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAmJiAoaGFzVmlzaWJsZUltYWdlKG5vZGUpIHx8IGhhc0NvbXBsZXhFZmZlY3RzKG5vZGUpIHx8IGhhc0NvbXBsZXhQYWludChub2RlKSkpIHtcclxuICAgICAgICByZXR1cm4gd2l0aEluYWN0aXZlKCflpI3mnYLlrrnlmajlsIbkvJjlhYjkv53nlZnlj6/nvJbovpHlrZDoioLngrnvvIzog4zmma/kvJrov5HkvLzlpITnkIYnKTtcbiAgICB9XG4gICAgcmV0dXJuIHdpdGhJbmFjdGl2ZSgpO1xufVxyXG5cclxuZnVuY3Rpb24gdG9UcmVlKG5vZGU6IEZpZ21hTm9kZSwgaXNSb290OiBib29sZWFuKTogVHJlZU5vZGVEdG8ge1xuICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xuICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBhbmFseXplU2xpY2VHcmlkKG5vZGUpO1xuICAgIGNvbnN0IGluZmVycmVkQWN0aW9uID0gaW5mZXJBY3Rpb24obm9kZSk7XHJcbiAgICBjb25zdCByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlID0gaW5mZXJyZWRBY3Rpb24gIT09ICdpZ25vcmUnXHJcbiAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAmJiBoYXNNYW51YWxFeHBvcnQobm9kZSk7XHJcbiAgICBjb25zdCByZW5kZXJNZXNzeVN1YnRyZWUgPSBzaG91bGRSZW5kZXJNZXNzeVN1YnRyZWUobm9kZSwgaXNSb290KTtcclxuICAgIGNvbnN0IHJlbmRlclN1YnRyZWUgPSBpbmZlcnJlZEFjdGlvbiAhPT0gJ2lnbm9yZSdcclxuICAgICAgICAmJiAocmVuZGVyTWFudWFsRXhwb3J0U3VidHJlZSB8fCBpc05hbWVkU2xpY2VHcm91cChub2RlKSB8fCByZW5kZXJNZXNzeVN1YnRyZWUpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICB3aWR0aDogZnJhbWU/LndpZHRoID8/IDAsXHJcbiAgICAgICAgaGVpZ2h0OiBmcmFtZT8uaGVpZ2h0ID8/IDAsXHJcbiAgICAgICAgYWN0aW9uOiByZW5kZXJTdWJ0cmVlID8gJ3JlbmRlcicgOiBpbmZlcnJlZEFjdGlvbixcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgcmVuZGVyU3VidHJlZSxcbiAgICAgICAgcGF0Y2hDYW5kaWRhdGU6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXG4gICAgICAgIHNsaWNlTW9kZTogc2xpY2VBbmFseXNpcz8ubW9kZSxcbiAgICAgICAgd2FybmluZzogd2FybmluZ0Zvcihub2RlLCByZW5kZXJNYW51YWxFeHBvcnRTdWJ0cmVlLCByZW5kZXJNZXNzeVN1YnRyZWUpLFxuICAgICAgICBjaGlsZHJlbjogbm9kZS5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB0b1RyZWUoY2hpbGQsIGZhbHNlKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYW5hbHl6ZVRyZWUocm9vdHM6IEZpZ21hTm9kZVtdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gcm9vdHMubWFwKChyb290KSA9PiB0b1RyZWUocm9vdCwgdHJ1ZSkpO1xyXG59XHJcbiJdfQ==