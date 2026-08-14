import type { FigmaNode, ImportAction, NodeKind, TreeNodeDto } from '../types';
import { analyzeSliceGrid } from './slicing';

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
const FIGMA_SCROLL_DIRECTIONS = new Set([
    'HORIZONTAL_SCROLLING',
    'VERTICAL_SCROLLING',
    'HORIZONTAL_AND_VERTICAL_SCROLLING',
    'HORIZONTAL',
    'VERTICAL',
    'BOTH',
]);

export function isVectorNode(node: Pick<FigmaNode, 'type'>): boolean {
    return VECTOR_TYPES.has(node.type);
}

export function isStructuredNodeName(name: string): boolean {
    return name === name.trim() && STRUCTURED_NODE_NAME.test(name);
}

export function isNamedSliceGroup(node: FigmaNode): boolean {
    return (node.children.length === 3 || node.children.length === 9)
        && node.children.every((child) => SLICE_RECTANGLE_NAME.test(child.name.trim()));
}

function hasVisibleImage(node: FigmaNode): boolean {
    return node.fills.some((fill) => fill.visible !== false && fill.type === 'IMAGE');
}

function hasComplexEffects(node: FigmaNode): boolean {
    return node.effects.some((effect) => effect.visible !== false);
}

function hasComplexPaint(node: FigmaNode): boolean {
    const fills = node.fills.filter((fill) => fill.visible !== false && (fill.opacity ?? 1) > 0);
    const strokes = node.strokes.filter((stroke) => stroke.visible !== false && (stroke.opacity ?? 1) > 0);
    const unsupportedGradient = fills.some((fill) =>
        fill.type === 'GRADIENT_ANGULAR' || fill.type === 'GRADIENT_DIAMOND');
    const unevenCorners = node.rectangleCornerRadii
        ? new Set(node.rectangleCornerRadii.map((radius) => Math.round(radius * 1000))).size > 1
        : false;
    return fills.length > 1
        || strokes.length > 1
        || unsupportedGradient
        || unevenCorners
        || Boolean(strokes.length && node.strokeAlign && node.strokeAlign !== 'CENTER');
}

export function inferCocosLayoutMode(node: FigmaNode): string | undefined {
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
        .filter((frame): frame is NonNullable<FigmaNode['absoluteBoundingBox']> => Boolean(frame));
    if (frames.length !== visibleChildren.length || frames.length < 2) {
        return undefined;
    }
    const widths = frames.map((frame) => frame.width);
    const heights = frames.map((frame) => frame.height);
    const uniformWidth = Math.max(...widths) - Math.min(...widths) <= 2;
    const uniformHeight = Math.max(...heights) - Math.min(...heights) <= 2;
    return uniformWidth && uniformHeight ? 'GRID' : undefined;
}

export function inferKind(node: FigmaNode): NodeKind {
    if (node.type === 'TEXT') {
        return 'label';
    }
    // A name or clipping rectangle is not proof of interactive scrolling.
    // Only Figma's explicit prototype overflow setting may change the Cocos
    // hierarchy to ScrollView -> view -> content in automatic mode.
    const overflowDirection = node.overflowDirection?.trim().toUpperCase() ?? '';
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

export function inferAction(node: FigmaNode): ImportAction {
    if (!node.visible) {
        return 'ignore';
    }
    if (isNamedSliceGroup(node)) {
        return 'render';
    }
    if (node.type === 'TEXT') {
        // Text remains an editable Cocos Label. Even when Figma reports fills,
        // shadows, or other paint data, exporting a bitmap would lose the text
        // semantics and make the imported UI impossible to edit.
        return 'generate';
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

export function shouldRenderMessySubtree(node: FigmaNode, isRoot: boolean): boolean {
    if (isRoot
        || node.visible === false
        || !CONTAINER_TYPES.has(node.type)
        || !isStructuredNodeName(node.name)) {
        return false;
    }
    const overflowDirection = node.overflowDirection?.trim().toUpperCase() ?? '';
    if (FIGMA_SCROLL_DIRECTIONS.has(overflowDirection)) {
        return false;
    }
    const visibleChildren = node.children.filter((child) => child.visible !== false);
    return visibleChildren.length > 0
        && visibleChildren.some((child) => !isStructuredNodeName(child.name));
}

export function isPatchCandidate(node: FigmaNode): boolean {
    return isNamedSliceGroup(node) || Boolean(analyzeSliceGrid(node));
}

function warningFor(node: FigmaNode, renderMessySubtree: boolean): string | undefined {
    if (!node.absoluteBoundingBox) {
        return '缺少边界信息，将按 0×0 导入';
    }
    if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) {
        return `混合模式 ${node.blendMode} 将近似处理`;
    }
    if (isNamedSliceGroup(node)) {
        return '检测到 3/9 个 Rectangle 切片，将按 PNG 整层导入并优先复用同名资源';
    }
    if (renderMessySubtree) {
        return '当前结构化节点包含未结构化的直接子层，智能模式将按 PNG 整层导入';
    }
    if (node.type === 'TEXT' && node.characters && !/[\r\n\u2028\u2029]/.test(node.characters)) {
        const lineHeight = node.style?.lineHeightPx ?? node.style?.fontSize ?? 0;
        const frameHeight = node.absoluteBoundingBox?.height ?? 0;
        if (lineHeight > 0 && frameHeight > lineHeight * 1.25) {
            return '文本疑似由 Figma 自动换行；NONE 模式只识别手动换行，请在 Figma 中插入换行符';
        }
    }
    if (CONTAINER_TYPES.has(node.type) && node.children.length
        && (hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node))) {
        return '复杂容器将优先保留可编辑子节点，背景会近似处理';
    }
    return undefined;
}

function toTree(node: FigmaNode, isRoot: boolean): TreeNodeDto {
    const frame = node.absoluteBoundingBox;
    const inferredAction = inferAction(node);
    const renderMessySubtree = shouldRenderMessySubtree(node, isRoot);
    const renderSubtree = inferredAction !== 'ignore'
        && (isNamedSliceGroup(node) || renderMessySubtree);
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        action: renderSubtree ? 'render' : inferredAction,
        kind: inferKind(node),
        renderSubtree,
        patchCandidate: isPatchCandidate(node),
        warning: inferredAction === 'ignore' ? undefined : warningFor(node, renderMessySubtree),
        children: node.children.map((child) => toTree(child, false)),
    };
}

export function analyzeTree(roots: FigmaNode[]): TreeNodeDto[] {
    return roots.map((root) => toTree(root, true));
}
