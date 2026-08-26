import {
    blocksDescendants,
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from '../../import-actions';
import type { ImportAction, NodeKind, TreeNodeDto } from '../../types';

const VECTOR_NODE_TYPES = new Set([
    'VECTOR',
    'BOOLEAN_OPERATION',
    'STAR',
    'LINE',
    'REGULAR_POLYGON',
    'RECTANGLE',
    'ELLIPSE',
]);

export function isVectorNodeType(type: string): boolean {
    return VECTOR_NODE_TYPES.has(type);
}

export function rerenderPreservingScroll(
    target: { scrollTop: number; scrollLeft: number },
    render: () => void,
    reset = false,
): void {
    const scrollTop = reset ? 0 : target.scrollTop;
    const scrollLeft = reset ? 0 : target.scrollLeft;
    try {
        render();
    } finally {
        target.scrollTop = scrollTop;
        target.scrollLeft = scrollLeft;
    }
}

export function smartActionForNode(node: TreeNodeDto): ImportAction {
    const inferred = normalizeImportAction(node.action);
    const renderSubtree = Boolean(node.renderSubtree) || (node.action as unknown) === 'merge';
    if (isVectorNodeType(node.type) && inferred !== 'ignore') {
        return 'render';
    }
    if (node.children.length && isTerminalAction(inferred) && !renderSubtree) {
        return 'generate';
    }
    return inferred;
}

export function actionOptionsForNode(node: TreeNodeDto): Array<[ImportAction, string]> {
    return [
        ['ignore', '忽略'],
        ['generate', '生成'],
        ['render', isVectorNodeType(node.type) ? 'PNG Sprite' : 'PNG 整层'],
        ['transform', '更新'],
    ];
}

export function effectiveKindForNode(
    node: TreeNodeDto,
    selectedKind: NodeKind,
    action: ImportAction,
    nineSlice = false,
): NodeKind {
    const resolvedKind = selectedKind === 'auto'
        ? node.kind === 'auto' ? 'node' : node.kind
        : selectedKind;
    return kindForImportAction(resolvedKind, action, nineSlice);
}

export function resolveEffectiveActions(
    roots: TreeNodeDto[],
    preferredActions: ReadonlyMap<string, ImportAction>,
    forcedRenderIds: ReadonlySet<string> = new Set(),
): { actions: Map<string, ImportAction>; suppressed: Set<string> } {
    const actions = new Map<string, ImportAction>();
    const suppressed = new Set<string>();
    const visit = (node: TreeNodeDto, blockedByAncestor: boolean): void => {
        const preferred = forcedRenderIds.has(node.id)
            ? 'render'
            : preferredActions.get(node.id) ?? smartActionForNode(node);
        const action = blockedByAncestor ? 'ignore' : normalizeImportAction(preferred);
        if (blockedByAncestor) {
            suppressed.add(node.id);
        }
        actions.set(node.id, action);
        const blocksChildren = blockedByAncestor || blocksDescendants(action);
        node.children.forEach((child) => visit(child, blocksChildren));
    };
    roots.forEach((node) => visit(node, false));
    return { actions, suppressed };
}
