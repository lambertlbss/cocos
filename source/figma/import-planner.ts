import type {
    FigmaNode,
    ImportDecision,
    ImportPlanReason,
    NodeImportPlan,
    NodeKind,
    NodeSemanticRole,
    Rect,
    TreeNodeDto,
    VisualFoldPlan,
} from '../types';
import {
    hasHiddenDescendant,
    hasManualExport,
    inferAction,
    inferKind,
    isNamedSliceGroup,
} from './analyzer';

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

const SCROLL_DIRECTIONS = new Set([
    'HORIZONTAL_SCROLLING',
    'VERTICAL_SCROLLING',
    'HORIZONTAL_AND_VERTICAL_SCROLLING',
    'HORIZONTAL',
    'VERTICAL',
    'BOTH',
]);

const ROLE_PREFIX = /^(panel|list|layout|btn|button|img|image|icon|bg|sprite|txt|text|label)(?:_|$)/i;

function normalizedName(node: Pick<FigmaNode, 'name'>): string {
    return node.name.trim().normalize('NFKC');
}

export function semanticRoleForNode(
    node: Pick<FigmaNode, 'name'>,
    isRoot = false,
): NodeSemanticRole {
    if (isRoot) {
        return 'root';
    }
    const name = normalizedName(node);
    const lower = name.toLocaleLowerCase('en-US');
    if (lower === 'view') return 'view';
    if (lower === 'content') return 'content';
    const match = ROLE_PREFIX.exec(lower);
    switch (match?.[1]) {
        case 'panel': return 'panel';
        case 'list': return 'list';
        case 'layout': return 'layout';
        case 'btn':
        case 'button': return 'button';
        case 'img':
        case 'image':
        case 'icon':
        case 'bg':
        case 'sprite': return 'image';
        case 'txt':
        case 'text':
        case 'label': return 'text';
        default: return 'unknown';
    }
}

function defaultDecision(node: FigmaNode): ImportDecision {
    return {
        action: inferAction(node),
        kind: inferKind(node),
        nineSlice: false,
        explicit: false,
    };
}

function resolvedDecision(
    node: FigmaNode,
    decisions: ReadonlyMap<string, ImportDecision>,
): ImportDecision {
    return decisions.get(node.id) ?? defaultDecision(node);
}

function visiblePaints(node: FigmaNode): boolean {
    const hasFill = node.fills.some((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
    const hasStroke = node.strokeWeight > 0
        && node.strokes.some((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
    const hasEffect = node.effects.some((effect) => effect.visible !== false);
    return hasFill || hasStroke || hasEffect;
}

function hasRuntimeContainerBehavior(node: FigmaNode): boolean {
    const overflow = node.overflowDirection?.trim().toUpperCase() ?? '';
    return node.clipsContent
        || SCROLL_DIRECTIONS.has(overflow)
        || Boolean(node.layoutMode && node.layoutMode !== 'NONE');
}

function isSafeVisualHost(node: FigmaNode): boolean {
    return CONTAINER_TYPES.has(node.type)
        && !visiblePaints(node)
        && !hasRuntimeContainerBehavior(node)
        && (!node.blendMode || node.blendMode === 'NORMAL' || node.blendMode === 'PASS_THROUGH');
}

const GEOMETRY_EPSILON = 0.0001;

function framesEquivalent(parent: Rect | undefined, child: Rect | undefined): boolean {
    if (!parent || !child) return false;
    return Math.abs(parent.x - child.x) <= GEOMETRY_EPSILON
        && Math.abs(parent.y - child.y) <= GEOMETRY_EPSILON
        && Math.abs(parent.width - child.width) <= GEOMETRY_EPSILON
        && Math.abs(parent.height - child.height) <= GEOMETRY_EPSILON;
}

function hasTranslationOnlyTransform(node: FigmaNode): boolean {
    const transform = node.relativeTransform;
    if (!transform) return true;
    if (transform.length < 2 || transform[0]?.length < 2 || transform[1]?.length < 2) {
        return false;
    }
    return Math.abs(transform[0][0] - 1) <= GEOMETRY_EPSILON
        && Math.abs(transform[0][1]) <= GEOMETRY_EPSILON
        && Math.abs(transform[1][0]) <= GEOMETRY_EPSILON
        && Math.abs(transform[1][1] - 1) <= GEOMETRY_EPSILON;
}

function transformsFoldable(parent: FigmaNode, child: FigmaNode): boolean {
    return Math.abs(parent.rotation ?? 0) <= GEOMETRY_EPSILON
        && Math.abs(child.rotation ?? 0) <= GEOMETRY_EPSILON
        && hasTranslationOnlyTransform(parent)
        && hasTranslationOnlyTransform(child);
}

function opacityIsNeutral(node: FigmaNode): boolean {
    return Math.abs(node.opacity - 1) <= GEOMETRY_EPSILON;
}

function effectiveChildren(
    node: FigmaNode,
    decisions: ReadonlyMap<string, ImportDecision>,
): FigmaNode[] {
    return node.children.filter((child) => resolvedDecision(child, decisions).action !== 'ignore');
}

function canFoldSourceVisibility(host: FigmaNode, source: FigmaNode): boolean {
    // A hidden source under a visible host needs its own Inactive node. Folding
    // it onto the host would make the visual appear immediately in Cocos.
    return (host.visible === false || source.visible !== false)
        && !hasHiddenDescendant(source);
}

function collectSubtreeIds(node: FigmaNode): string[] {
    return [node.id, ...node.children.flatMap(collectSubtreeIds)];
}

function foldPlan(kind: VisualFoldPlan['kind'], source: FigmaNode): VisualFoldPlan {
    return {
        kind,
        sourceNodeId: source.id,
        absorbedNodeIds: collectSubtreeIds(source),
    };
}

function canUseChildAsSprite(
    child: FigmaNode,
    decisions: ReadonlyMap<string, ImportDecision>,
): boolean {
    const decision = resolvedDecision(child, decisions);
    return decision.action === 'render' || decision.nineSlice;
}

function subtreeHasExplicitConflict(
    node: FigmaNode,
    decisions: ReadonlyMap<string, ImportDecision>,
): boolean {
    const decision = resolvedDecision(node, decisions);
    return decision.explicit === true
        || Boolean(decision.name)
        || node.children.some((child) => subtreeHasExplicitConflict(child, decisions));
}

function baseReason(
    node: FigmaNode,
    role: NodeSemanticRole,
    decision: ImportDecision,
    isRoot: boolean,
): ImportPlanReason {
    if (decision.explicit) return 'user-override';
    if (decision.action === 'ignore') return 'ignored';
    if (isRoot) return 'root-structure';
    if (node.type === 'TEXT') return 'editable-text';
    if (hasManualExport(node)) return 'manual-export';
    if (decision.nineSlice || isNamedSliceGroup(node)) return 'slice-resource';
    if (['panel', 'list', 'layout', 'button', 'view', 'content'].includes(role)) {
        return 'semantic-container';
    }
    if (decision.action === 'render') return 'visual-fallback';
    return 'default-generate';
}

function plannedKindForEmptyTextHost(
    node: FigmaNode,
    role: NodeSemanticRole,
    decision: ImportDecision,
    children: FigmaNode[],
): NodeKind | undefined {
    if (role !== 'text'
        || children.length
        || decision.action !== 'generate'
        || decision.explicit
        || !isSafeVisualHost(node)) {
        return undefined;
    }
    return 'label';
}

function visualFoldForNode(
    node: FigmaNode,
    role: NodeSemanticRole,
    decision: ImportDecision,
    decisions: ReadonlyMap<string, ImportDecision>,
): { fold: VisualFoldPlan; kind: NodeKind; reason: ImportPlanReason } | undefined {
    const explicitKindRequestsFold = decision.explicit === true && (
        (role === 'text' && (decision.kind === 'label' || decision.kind === 'richText'))
        || (role === 'image' && (decision.kind === 'sprite' || decision.kind === 'button'))
        || (role === 'button' && decision.kind === 'button')
    );
    if (decision.action !== 'generate'
        || (decision.explicit && !explicitKindRequestsFold)
        || !isSafeVisualHost(node)) {
        return undefined;
    }
    const children = effectiveChildren(node, decisions);
    if (role === 'text' && children.length === 1) {
        const child = children[0];
        if (child.type === 'TEXT'
            && canFoldSourceVisibility(node, child)
            && !subtreeHasExplicitConflict(child, decisions)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)) {
            return {
                fold: foldPlan('single-text', child),
                kind: decision.kind === 'richText' ? 'richText' : 'label',
                reason: 'single-text-fold',
            };
        }
    }
    if (role === 'image' && children.length === 1) {
        const child = children[0];
        if (canUseChildAsSprite(child, decisions)
            && canFoldSourceVisibility(node, child)
            && !subtreeHasExplicitConflict(child, decisions)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)) {
            return {
                fold: foldPlan('single-image', child),
                kind: decision.kind === 'button' ? 'button' : 'sprite',
                reason: 'single-image-fold',
            };
        }
    }
    if (role === 'button' && (decision.kind === 'button' || decision.kind === 'auto')) {
        const candidates = children.filter((child) => canUseChildAsSprite(child, decisions)
            && canFoldSourceVisibility(node, child)
            && framesEquivalent(node.absoluteBoundingBox, child.absoluteBoundingBox)
            && transformsFoldable(node, child)
            && opacityIsNeutral(child));
        if (candidates.length === 1
            && children[0] === candidates[0]
            && !subtreeHasExplicitConflict(candidates[0], decisions)) {
            return {
                fold: foldPlan('background', candidates[0]),
                kind: 'button',
                reason: 'background-promotion',
            };
        }
    }
    return undefined;
}

/**
 * 编译一次导入使用的唯一规划表。资源收集完成后可再次编译，以接收本地同名
 * 资源对 decision 的提升；SceneNodeSpec 与面板说明都消费同一套纯规则。
 */
export function compileImportPlan(
    roots: FigmaNode[],
    decisions: ReadonlyMap<string, ImportDecision>,
): Map<string, NodeImportPlan> {
    const plans = new Map<string, NodeImportPlan>();
    const visit = (node: FigmaNode, isRoot: boolean) => {
        const decision = resolvedDecision(node, decisions);
        const role = semanticRoleForNode(node, isRoot);
        const children = effectiveChildren(node, decisions);
        const fold = visualFoldForNode(node, role, decision, decisions);
        const emptyTextKind = plannedKindForEmptyTextHost(node, role, decision, children);
        plans.set(node.id, {
            nodeId: node.id,
            role,
            reason: fold?.reason ?? (emptyTextKind ? 'editable-text' : baseReason(node, role, decision, isRoot)),
            kind: fold?.kind ?? emptyTextKind,
            fold: fold?.fold,
        });
        node.children.forEach((child) => visit(child, false));
    };
    roots.forEach((root) => visit(root, true));
    return plans;
}

export function annotateTreeWithImportPlan(
    tree: TreeNodeDto[],
    plans: ReadonlyMap<string, NodeImportPlan>,
): TreeNodeDto[] {
    return tree.map((node) => {
        const plan = plans.get(node.id);
        return {
            ...node,
            reason: plan?.reason,
            fold: plan?.fold?.kind,
            absorbedNodeIds: plan?.fold?.absorbedNodeIds,
            children: annotateTreeWithImportPlan(node.children, plans),
        };
    });
}

export function importPlanReasonText(reason: ImportPlanReason | undefined): string {
    switch (reason) {
        case 'ignored': return '节点策略设为忽略，不导入';
        case 'root-structure': return '保留为 Prefab 根结构';
        case 'manual-export': return '检测到 Figma Export，按整层资源导入';
        case 'slice-resource': return '识别为三/九宫资源';
        case 'semantic-container': return '保留 Cocos 运行时语义容器';
        case 'editable-text': return '保留为可编辑文字';
        case 'single-image-fold': return '单一图片子层提升到父节点';
        case 'single-text-fold': return '单一文字子层提升到父节点';
        case 'background-promotion': return '背景资源提升到父节点，保留内容子层';
        case 'visual-fallback': return '纯视觉内容按 PNG 导入';
        case 'user-override': return '采用手动节点策略';
        case 'default-generate': return '按可编辑节点结构生成';
        default: return '';
    }
}
