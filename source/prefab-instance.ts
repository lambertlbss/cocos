import { normalizeCocosUuid } from './roundtrip/uuid';

export interface PrefabInstanceAttachment { assetUuid: string; instanceFileId: string }

const attachments = new WeakMap<object, PrefabInstanceAttachment>();

export function prefabAssetUuid(node: any): string | undefined {
    const value = node?._prefab?.asset?._uuid ?? node?._prefab?.asset?.uuid;
    return typeof value === 'string' && value ? normalizeCocosUuid(value) : undefined;
}

export function nativePrefabIdentity(node: any): PrefabInstanceAttachment | undefined {
    const assetUuid = prefabAssetUuid(node);
    const instanceFileId = node?._prefab?.instance?.fileId;
    return assetUuid && node?._prefab?.root === node && typeof instanceFileId === 'string' && instanceFileId
        ? { assetUuid, instanceFileId } : undefined;
}

export function isInsideNestedPrefab(node: any, root: any): boolean {
    for (let current = node; current && current !== root; current = current.parent) {
        const info = current._prefab;
        if (info?.root && info.root !== root) return true;
        const asset = prefabAssetUuid(current);
        if (asset && prefabAssetUuid(root) && asset !== prefabAssetUuid(root)) return true;
    }
    return false;
}

/** Source fileIds repeat across instances; instance paths supply the outer identity. */
export function prefabScopedId(node: any, root: any, localId: string): string {
    const scope: string[] = [];
    for (let current = node; current && current !== root; current = current.parent) {
        const identity = nativePrefabIdentity(current);
        if (identity) scope.unshift(`${encodeURIComponent(identity.assetUuid)}:${encodeURIComponent(identity.instanceFileId)}`);
    }
    return scope.length ? `prefab-instance/${scope.join('/')}/${encodeURIComponent(localId)}` : localId;
}

export function ownedPrefabAttachment(carrier: any): PrefabInstanceAttachment | undefined {
    return attachments.get(carrier);
}

export function rememberPrefabAttachment(carrier: any, attachment: PrefabInstanceAttachment): any {
    const expected = { assetUuid: normalizeCocosUuid(attachment.assetUuid), instanceFileId: attachment.instanceFileId };
    const matches = (carrier.children ?? []).filter((child: any) => {
        const identity = nativePrefabIdentity(child);
        return child.parent === carrier && identity?.assetUuid === expected.assetUuid && identity.instanceFileId === expected.instanceFileId;
    });
    if (matches.length !== 1) throw new Error(`节点“${carrier.name}”的受管 Prefab 实例链接已丢失或不唯一。`);
    attachments.set(carrier, expected);
    return matches[0];
}

export function removeOwnedPrefabAttachment(carrier: any): void {
    const attachment = attachments.get(carrier);
    if (!attachment) return;
    const instance = rememberPrefabAttachment(carrier, attachment);
    instance.active = false;
    instance.removeFromParent();
    instance.destroy();
    attachments.delete(carrier);
}

/** Editor creation is required: cloning a node does not prove a persistent nested link. */
export async function configurePrefabAttachment(carrier: any, requested: { uuid: string } | undefined,
    _scene: any): Promise<void> {
    const previous = attachments.get(carrier);
    const existing = previous ? rememberPrefabAttachment(carrier, previous) : undefined;
    if (!requested) {
        removeOwnedPrefabAttachment(carrier);
        return;
    }
    for (const child of carrier.children ?? []) {
        if (child !== existing && (child?._prefab?.root === child || child?._prefab?.instance)) {
            throw new Error(`节点“${carrier.name}”含有来源未知的 Prefab 实例，已停止替换。`);
        }
    }
    const assetUuid = normalizeCocosUuid(requested.uuid);
    if (previous?.assetUuid === assetUuid) return;
    for (let ancestor = carrier; ancestor; ancestor = ancestor.parent) {
        if (prefabAssetUuid(ancestor) === assetUuid) throw new Error('Prefab 不允许引用自身或祖先 Prefab。');
    }
    const facade = (globalThis as any).cce?.SceneFacadeManager;
    if (typeof facade?.createNode !== 'function') throw new Error('Creator Prefab 实例创建 API 不可用。');
    const beforeChildren = new Set(carrier.children ?? []);
    let uuid: unknown;
    try {
        uuid = await facade.createNode({ parent: carrier.uuid, assetUuid: requested.uuid, type: 'cc.Prefab',
            unlinkPrefab: false, snapshot: false, nameIncrease: false, autoAdaptToCreate: false });
    } catch (error) {
        for (const child of [...(carrier.children ?? [])]) {
            if (!beforeChildren.has(child) && nativePrefabIdentity(child)?.assetUuid === assetUuid) {
                child.removeFromParent(); child.destroy();
            }
        }
        throw error;
    }
    const instance = (carrier.children ?? []).find((child: any) => child.uuid === uuid);
    const identity = nativePrefabIdentity(instance);
    if (typeof uuid !== 'string' || !identity || instance.parent !== carrier || identity.assetUuid !== assetUuid || beforeChildren.has(instance)) {
        // Only the returned, newly-created child is eligible for cleanup.
        if (instance && !beforeChildren.has(instance)) { instance.removeFromParent(); instance.destroy(); }
        throw new Error(`节点“${carrier.name}”的 Prefab 实例未保留原生链接，已拒绝导入。`);
    }
    // Keep the Prefab's authored size, scale, rotation and internal components.
    instance.setPosition(0, 0, 0);
    if (existing) { existing.active = false; existing.removeFromParent(); existing.destroy(); }
    attachments.set(carrier, identity);
}
