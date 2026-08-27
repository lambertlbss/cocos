import {
    blocksDescendants,
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from '../../import-actions';
import type { ImportAction, NodeKind, TreeNodeDto } from '../../types';

export interface NodeStrategySummary {
    strategy?: string;
    warning?: string;
}

const REASON_LABELS: Record<NonNullable<TreeNodeDto['reason']>, string> = {
    ignored: '节点已忽略',
    'root-structure': '保留根节点结构',
    'manual-export': 'Figma Export 资源边界',
    'slice-resource': '三/九宫资源边界',
    'semantic-container': '保留语义容器',
    'editable-text': '保留可编辑文字',
    'single-image-fold': '单图片包装层可折叠',
    'single-text-fold': '单文字包装层可折叠',
    'background-promotion': '背景可提升到父节点',
    'visual-fallback': '纯视觉子树使用 PNG',
    'default-generate': '保留可编辑结构',
    'user-override': '用户显式覆盖',
};

const FOLD_LABELS: Record<NonNullable<TreeNodeDto['fold']>, string> = {
    'single-image': '折叠单图片子层',
    'single-text': '折叠单文字子层',
    background: '提升背景子层',
};

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

export function defaultNineSliceIds(roots: TreeNodeDto[]): Set<string> {
    const result = new Set<string>();
    const visit = (node: TreeNodeDto): void => {
        if (node.patchCandidate) {
            result.add(node.id);
        }
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

export function actionOptionsForNode(node: TreeNodeDto): Array<[ImportAction, string]> {
    return [
        ['ignore', '忽略'],
        ['generate', '生成'],
        ['render', isVectorNodeType(node.type) ? 'PNG Sprite' : 'PNG 整层'],
        ['transform', '更新'],
    ];
}

export function kindOptionsForAction(action: ImportAction): Array<[NodeKind, string]> {
    if (action === 'render') {
        return [
            ['sprite', 'Sprite'],
            ['button', 'Button'],
        ];
    }
    return [
        ['auto', '自动'],
        ['node', 'Node'],
        ['sprite', 'Sprite'],
        ['label', 'Label'],
        ['richText', 'RichText'],
        ['button', 'Button'],
        ['scrollView', 'ScrollView'],
        ['layout', 'Layout'],
    ];
}

export function strategySummaryForNode(
    node: TreeNodeDto,
    explicit = false,
): NodeStrategySummary {
    const details: string[] = [];
    const reason = explicit ? 'user-override' : node.reason;
    if (reason) {
        details.push(REASON_LABELS[reason]);
    }
    if (node.fold && !explicit) {
        const absorbed = node.absorbedNodeIds?.length ?? 0;
        details.push(`${FOLD_LABELS[node.fold]}，吸收 ${absorbed} 个子层`);
    }
    return {
        strategy: details.length ? details.join(' · ') : undefined,
        warning: node.warning,
    };
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
