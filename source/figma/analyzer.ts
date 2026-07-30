import type { FigmaNode, ImportAction, NodeKind, TreeNodeDto } from '../types';

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
]);

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

export function inferKind(node: FigmaNode): NodeKind {
    if (node.type === 'TEXT') {
        return 'label';
    }
    if (node.overflowDirection && node.overflowDirection !== 'NONE') {
        return 'scroll';
    }
    if (/button|按钮/i.test(node.name)) {
        return 'button';
    }
    if (node.layoutMode === 'GRID') {
        return 'grid';
    }
    if (CONTAINER_TYPES.has(node.type)) {
        return 'container';
    }
    return 'sprite';
}

export function inferAction(node: FigmaNode): ImportAction {
    if (!node.visible) {
        return 'ignore';
    }
    if (node.type === 'TEXT' || CONTAINER_TYPES.has(node.type)) {
        if (hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node)) {
            return 'render';
        }
        return 'generate';
    }
    if (VECTOR_TYPES.has(node.type)) {
        return 'svg';
    }
    if (node.type === 'ELLIPSE' || node.type === 'RECTANGLE') {
        return hasVisibleImage(node) || hasComplexEffects(node) || hasComplexPaint(node)
            ? 'render'
            : 'generate';
    }
    return 'render';
}

export function isPatchCandidate(node: FigmaNode): boolean {
    if (node.children.length !== 3 && node.children.length !== 9) {
        return false;
    }
    const counts = new Map<string, number>();
    for (const child of node.children) {
        const key = child.name.trim().toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.values()].some((count) => count >= 3);
}

function warningFor(node: FigmaNode): string | undefined {
    if (!node.absoluteBoundingBox) {
        return '缺少边界信息，将按 0×0 导入';
    }
    if (node.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(node.blendMode)) {
        return `混合模式 ${node.blendMode} 将近似处理`;
    }
    return undefined;
}

function toTree(node: FigmaNode): TreeNodeDto {
    const frame = node.absoluteBoundingBox;
    return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        width: frame?.width ?? 0,
        height: frame?.height ?? 0,
        action: inferAction(node),
        kind: inferKind(node),
        patchCandidate: isPatchCandidate(node),
        warning: warningFor(node),
        children: node.children.map(toTree),
    };
}

export function analyzeTree(roots: FigmaNode[]): TreeNodeDto[] {
    return roots.map(toTree);
}
