import { quantizeDecimal } from './canonical-json';
import type {
    CanonicalNode,
    ComponentLocator,
    EditableField,
    ResourceBinding,
    SyncId,
} from './protocol';
import { normalizeCocosUuid } from './uuid';

export type RoundtripLeaf =
    | 'position.x'
    | 'position.y'
    | 'contentSize.width'
    | 'contentSize.height'
    | 'spriteFrameUuid';

export interface RoundtripNodeState {
    syncId: SyncId;
    position?: { x: number; y: number };
    contentSize?: { width: number; height: number };
    spriteFrameUuid?: string | null;
}

export interface FieldDecision {
    syncId: SyncId;
    field: RoundtripLeaf;
    baseline: number | string | null;
    figma: number | string | null;
    cocos: number | string | null;
    result: 'apply' | 'preserve-cocos' | 'converged' | 'readonly-unchanged';
}

export interface Conflict {
    syncId: SyncId;
    field: RoundtripLeaf;
    baseline: number | string | null;
    figma: number | string | null;
    cocos: number | string | null;
    reason: 'both-diverged';
}

export interface UnsupportedChange {
    syncId: SyncId;
    field: RoundtripLeaf;
    baseline: number | string | null;
    figma: number | string | null;
    cocos: number | string | null;
    reason: 'readonly-changed' | 'resource-proof-missing';
}

export type PatchOperation =
    | {
        kind: 'set-position-xy';
        syncId: SyncId;
        nodeFileId: string;
        from: { x: number; y: number };
        to: { x: number; y: number };
    }
    | {
        kind: 'set-content-size';
        syncId: SyncId;
        componentLocator: ComponentLocator;
        from: { width: number; height: number };
        to: { width: number; height: number };
    }
    | {
        kind: 'set-sprite-frame';
        syncId: SyncId;
        componentLocator: ComponentLocator;
        fromUuid: string;
        toUuid: string;
        intent: 'explicit-rebind';
        paintVisualId: string;
        paintFingerprint: string;
    };

export interface Diff3Plan {
    apply: PatchOperation[];
    applyLeaves: FieldDecision[];
    preserveCocos: FieldDecision[];
    converged: FieldDecision[];
    readonlyUnchanged: FieldDecision[];
    conflicts: Conflict[];
    unsupported: UnsupportedChange[];
}

interface LeafSpec {
    field: RoundtripLeaf;
    capability: EditableField;
}

const LEAVES: LeafSpec[] = [
    { field: 'position.x', capability: 'position.xy' },
    { field: 'position.y', capability: 'position.xy' },
    { field: 'contentSize.width', capability: 'contentSize.wh' },
    { field: 'contentSize.height', capability: 'contentSize.wh' },
    { field: 'spriteFrameUuid', capability: 'spriteFrame.uuid' },
];

function stateBySyncId(states: readonly RoundtripNodeState[], label: string): Map<SyncId, RoundtripNodeState> {
    const result = new Map<SyncId, RoundtripNodeState>();
    for (const state of states) {
        if (result.has(state.syncId)) throw new Error(`${label} contains duplicate syncId ${state.syncId}`);
        result.set(state.syncId, state);
    }
    return result;
}

function leafValue(state: RoundtripNodeState | CanonicalNode, field: RoundtripLeaf): number | string | null | undefined {
    switch (field) {
        case 'position.x': return state.position?.x;
        case 'position.y': return state.position?.y;
        case 'contentSize.width': return state.contentSize?.width;
        case 'contentSize.height': return state.contentSize?.height;
        case 'spriteFrameUuid': return state.spriteFrameUuid;
    }
}

function normalizeLeaf(field: RoundtripLeaf, value: number | string | null | undefined): number | string | null {
    if (value === undefined) throw new Error(`Missing required ${field} value`);
    if (field === 'spriteFrameUuid') return value === null ? null : normalizeCocosUuid(String(value));
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite`);
    return quantizeDecimal(value);
}

function decideLeaf(
    node: CanonicalNode,
    figma: RoundtripNodeState,
    cocos: RoundtripNodeState,
    spec: LeafSpec,
): FieldDecision | Conflict | UnsupportedChange {
    const baselineValue = normalizeLeaf(spec.field, leafValue(node, spec.field));
    const figmaValue = normalizeLeaf(spec.field, leafValue(figma, spec.field));
    const cocosValue = normalizeLeaf(spec.field, leafValue(cocos, spec.field));
    const writable = node.editable.includes(spec.capability);
    const common = {
        syncId: node.syncId,
        field: spec.field,
        baseline: baselineValue,
        figma: figmaValue,
        cocos: cocosValue,
    };
    if (!writable && figmaValue === baselineValue) {
        return { ...common, result: 'readonly-unchanged' };
    }
    if (!writable) return { ...common, reason: 'readonly-changed' };
    if (figmaValue === cocosValue) return { ...common, result: 'converged' };
    if (figmaValue === baselineValue) return { ...common, result: 'preserve-cocos' };
    if (cocosValue === baselineValue) return { ...common, result: 'apply' };
    return { ...common, reason: 'both-diverged' };
}

function hasResult(value: FieldDecision | Conflict | UnsupportedChange | undefined): value is FieldDecision {
    return value !== undefined && 'result' in value;
}

function isConflict(value: FieldDecision | Conflict | UnsupportedChange | undefined): value is Conflict {
    return value !== undefined && 'reason' in value && value.reason === 'both-diverged';
}

export function createDiff3Plan(input: {
    baseline: readonly CanonicalNode[];
    figma: readonly RoundtripNodeState[];
    cocos: readonly RoundtripNodeState[];
    resourceBindings?: ReadonlyMap<SyncId, ResourceBinding>;
}): Diff3Plan {
    const figmaById = stateBySyncId(input.figma, 'Figma projection');
    const cocosById = stateBySyncId(input.cocos, 'Cocos projection');
    const result: Diff3Plan = {
        apply: [],
        applyLeaves: [],
        preserveCocos: [],
        converged: [],
        readonlyUnchanged: [],
        conflicts: [],
        unsupported: [],
    };

    for (const node of [...input.baseline].sort((left, right) => left.syncId.localeCompare(right.syncId))) {
        const figma = figmaById.get(node.syncId);
        const cocos = cocosById.get(node.syncId);
        if (!figma || !cocos) throw new Error(`Missing projection for ${node.syncId}`);
        const decisions = new Map<RoundtripLeaf, FieldDecision | Conflict | UnsupportedChange>();
        for (const spec of LEAVES) {
            const baselineValue = leafValue(node, spec.field);
            if (baselineValue === undefined && !node.editable.includes(spec.capability)) continue;
            const decision = decideLeaf(node, figma, cocos, spec);
            decisions.set(spec.field, decision);
            if (hasResult(decision)) {
                if (decision.result === 'apply') result.applyLeaves.push(decision);
                else if (decision.result === 'preserve-cocos') result.preserveCocos.push(decision);
                else if (decision.result === 'converged') result.converged.push(decision);
                else result.readonlyUnchanged.push(decision);
            } else if (isConflict(decision)) result.conflicts.push(decision);
            else result.unsupported.push(decision);
        }

        const positionX = decisions.get('position.x');
        const positionY = decisions.get('position.y');
        if ((hasResult(positionX) && positionX.result === 'apply') || (hasResult(positionY) && positionY.result === 'apply')) {
            if (!cocos.position || !figma.position) throw new Error(`Missing position for ${node.syncId}`);
            result.apply.push({
                kind: 'set-position-xy',
                syncId: node.syncId,
                nodeFileId: node.locator.nodeFileId,
                from: { x: normalizeLeaf('position.x', cocos.position.x) as number, y: normalizeLeaf('position.y', cocos.position.y) as number },
                to: {
                    x: hasResult(positionX) && positionX.result === 'apply' ? positionX.figma as number : normalizeLeaf('position.x', cocos.position.x) as number,
                    y: hasResult(positionY) && positionY.result === 'apply' ? positionY.figma as number : normalizeLeaf('position.y', cocos.position.y) as number,
                },
            });
        }

        const width = decisions.get('contentSize.width');
        const height = decisions.get('contentSize.height');
        if ((hasResult(width) && width.result === 'apply') || (hasResult(height) && height.result === 'apply')) {
            if (!cocos.contentSize || !figma.contentSize || !node.componentLocators.uiTransform) {
                throw new Error(`Missing UITransform proof for ${node.syncId}`);
            }
            result.apply.push({
                kind: 'set-content-size',
                syncId: node.syncId,
                componentLocator: node.componentLocators.uiTransform,
                from: {
                    width: normalizeLeaf('contentSize.width', cocos.contentSize.width) as number,
                    height: normalizeLeaf('contentSize.height', cocos.contentSize.height) as number,
                },
                to: {
                    width: hasResult(width) && width.result === 'apply' ? width.figma as number : normalizeLeaf('contentSize.width', cocos.contentSize.width) as number,
                    height: hasResult(height) && height.result === 'apply' ? height.figma as number : normalizeLeaf('contentSize.height', cocos.contentSize.height) as number,
                },
            });
        }

        const sprite = decisions.get('spriteFrameUuid');
        if (hasResult(sprite) && sprite.result === 'apply') {
            const binding = input.resourceBindings?.get(node.syncId);
            if (!binding || binding.intent !== 'explicit-rebind' || !node.componentLocators.sprite ||
                typeof sprite.cocos !== 'string' || typeof sprite.figma !== 'string') {
                result.applyLeaves.splice(result.applyLeaves.indexOf(sprite), 1);
                result.unsupported.push({ ...sprite, reason: 'resource-proof-missing' });
            } else {
                result.apply.push({
                    kind: 'set-sprite-frame',
                    syncId: node.syncId,
                    componentLocator: node.componentLocators.sprite,
                    fromUuid: sprite.cocos,
                    toUuid: sprite.figma,
                    intent: 'explicit-rebind',
                    paintVisualId: binding.paintVisualId,
                    paintFingerprint: binding.paintFingerprint,
                });
            }
        }
    }
    return result;
}
