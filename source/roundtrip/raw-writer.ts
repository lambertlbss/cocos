import { canonicalStringify, quantizeDecimal, sha256 } from './canonical-json';
import type { PatchOperation } from './diff3';
import type { CanonicalNode, ComponentLocator, SyncId } from './protocol';
import { normalizeCocosUuid } from './uuid';

type Serialized = Record<string, unknown>;

function isRecord(value: unknown): value is Serialized {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refId(value: unknown): number | undefined {
    return isRecord(value) && Number.isInteger(value.__id__) && (value.__id__ as number) >= 0
        ? value.__id__ as number
        : undefined;
}

function resolveReference(entries: Serialized[], value: unknown): Serialized | undefined {
    const index = refId(value);
    return index === undefined ? undefined : entries[index];
}

function typeOf(value: Serialized | undefined): string {
    return typeof value?.__type__ === 'string' ? value.__type__ : '';
}

function fileId(entries: Serialized[], node: Serialized): string | undefined {
    const info = resolveReference(entries, node._prefab);
    return typeOf(info) === 'cc.PrefabInfo' && typeof info?.fileId === 'string' ? info.fileId : undefined;
}

function componentFileId(entries: Serialized[], component: Serialized): string | undefined {
    const info = resolveReference(entries, component.__prefab);
    return typeOf(info) === 'cc.CompPrefabInfo' && typeof info?.fileId === 'string' ? info.fileId : undefined;
}

function nodeComponents(entries: Serialized[], node: Serialized): Serialized[] {
    if (!Array.isArray(node._components)) throw new Error('目标 Node._components 无效。');
    return node._components.map((value) => {
        const component = resolveReference(entries, value);
        if (!component) throw new Error('目标组件引用无效。');
        return component;
    });
}

function maskedComponentFingerprint(component: Serialized, componentType: string): string {
    const masked = JSON.parse(JSON.stringify(component)) as Serialized;
    if (componentType === 'cc.UITransform') masked._contentSize = '__ROUNDTRIP_EDITABLE__';
    if (componentType === 'cc.Sprite') masked._spriteFrame = '__ROUNDTRIP_EDITABLE__';
    return sha256(canonicalStringify(masked));
}

function componentByLocator(entries: Serialized[], node: Serialized, locator: ComponentLocator): Serialized {
    const candidates = nodeComponents(entries, node).filter((value) => typeOf(value) === locator.componentType);
    if (locator.strategy === 'comp-prefab-file-id') {
        const matches = candidates.filter((value) => componentFileId(entries, value) === locator.fileId);
        if (matches.length !== 1) throw new Error(`Writer 组件 fileId ${locator.fileId} 未唯一命中。`);
        return matches[0];
    }
    if (candidates.length !== 1 || maskedComponentFingerprint(candidates[0], locator.componentType) !== locator.baselineFingerprint) {
        throw new Error(`Writer 组件 ${locator.componentType} fingerprint 不匹配。`);
    }
    return candidates[0];
}

function equalNumber(actual: unknown, expected: number, label: string): void {
    if (typeof actual !== 'number' || !Number.isFinite(actual) || quantizeDecimal(actual) !== quantizeDecimal(expected)) {
        throw new Error(`${label} preimage 已变化。`);
    }
}

function baselineById(baseline: readonly CanonicalNode[]): Map<SyncId, CanonicalNode> {
    const map = new Map<SyncId, CanonicalNode>();
    for (const node of baseline) {
        if (map.has(node.syncId)) throw new Error(`重复 baseline syncId：${node.syncId}`);
        map.set(node.syncId, node);
    }
    return map;
}

/** Applies only the three P0 operation kinds to an isolated JSON clone. */
export function writePatchedPrefab(input: {
    serialized: readonly Serialized[];
    baseline: readonly CanonicalNode[];
    operations: readonly PatchOperation[];
}): Buffer {
    const entries = JSON.parse(JSON.stringify(input.serialized)) as Serialized[];
    const canonicalNodes = baselineById(input.baseline);
    const nodesByFileId = new Map<string, Serialized>();
    for (const entry of entries) {
        if (typeOf(entry) !== 'cc.Node') continue;
        const id = fileId(entries, entry);
        if (!id) continue;
        if (nodesByFileId.has(id)) throw new Error(`Writer 遇到重复 node fileId：${id}`);
        nodesByFileId.set(id, entry);
    }

    for (const operation of input.operations) {
        const canonicalNode = canonicalNodes.get(operation.syncId);
        if (!canonicalNode) throw new Error(`PatchOperation syncId 不在 baseline：${operation.syncId}`);
        const node = nodesByFileId.get(canonicalNode.locator.nodeFileId);
        if (!node) throw new Error(`Writer node fileId 未命中：${canonicalNode.locator.nodeFileId}`);
        if (operation.kind === 'set-position-xy') {
            if (operation.nodeFileId !== canonicalNode.locator.nodeFileId || !canonicalNode.editable.includes('position.xy') || !isRecord(node._lpos)) {
                throw new Error(`set-position-xy proof 无效：${operation.syncId}`);
            }
            equalNumber(node._lpos.x, operation.from.x, '_lpos.x');
            equalNumber(node._lpos.y, operation.from.y, '_lpos.y');
            node._lpos.x = quantizeDecimal(operation.to.x);
            node._lpos.y = quantizeDecimal(operation.to.y);
        } else if (operation.kind === 'set-content-size') {
            if (!canonicalNode.editable.includes('contentSize.wh')) throw new Error(`contentSize 不可写：${operation.syncId}`);
            const transform = componentByLocator(entries, node, operation.componentLocator);
            if (typeOf(transform) !== 'cc.UITransform' || !isRecord(transform._contentSize)) throw new Error('UITransform proof 无效。');
            equalNumber(transform._contentSize.width, operation.from.width, '_contentSize.width');
            equalNumber(transform._contentSize.height, operation.from.height, '_contentSize.height');
            transform._contentSize.width = quantizeDecimal(operation.to.width);
            transform._contentSize.height = quantizeDecimal(operation.to.height);
        } else {
            if (!canonicalNode.editable.includes('spriteFrame.uuid')) throw new Error(`spriteFrame 不可写：${operation.syncId}`);
            const sprite = componentByLocator(entries, node, operation.componentLocator);
            if (typeOf(sprite) !== 'cc.Sprite' || sprite._type !== 0 || sprite._sizeMode !== 0 || !isRecord(sprite._spriteFrame)) {
                throw new Error('P0 Sprite 必须保持 SIMPLE + CUSTOM 且原绑定非空。');
            }
            const currentUuid = typeof sprite._spriteFrame.__uuid__ === 'string'
                ? normalizeCocosUuid(sprite._spriteFrame.__uuid__)
                : '';
            if (currentUuid !== normalizeCocosUuid(operation.fromUuid)) throw new Error('SpriteFrame preimage 已变化。');
            sprite._spriteFrame.__uuid__ = normalizeCocosUuid(operation.toUuid);
        }
    }
    return Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function setLeaf(node: CanonicalNode, field: string, value: number | string | null): void {
    if (field === 'position.x') node.position!.x = value as number;
    else if (field === 'position.y') node.position!.y = value as number;
    else if (field === 'contentSize.width') node.contentSize!.width = value as number;
    else if (field === 'contentSize.height') node.contentSize!.height = value as number;
    else node.spriteFrameUuid = value as string | null;
}

export function advancedBaseline(
    baseline: readonly CanonicalNode[],
    decisions: ReadonlyArray<{ syncId: SyncId; field: string; figma: number | string | null }>,
): CanonicalNode[] {
    const result = JSON.parse(JSON.stringify(baseline)) as CanonicalNode[];
    const byId = baselineById(result);
    for (const decision of decisions) {
        const node = byId.get(decision.syncId);
        if (!node) throw new Error(`Baseline advancement syncId 不存在：${decision.syncId}`);
        setLeaf(node, decision.field, decision.figma);
    }
    return result;
}
