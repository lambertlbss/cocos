"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prefabAssetUuid = prefabAssetUuid;
exports.nativePrefabIdentity = nativePrefabIdentity;
exports.isInsideNestedPrefab = isInsideNestedPrefab;
exports.prefabScopedId = prefabScopedId;
exports.ownedPrefabAttachment = ownedPrefabAttachment;
exports.rememberPrefabAttachment = rememberPrefabAttachment;
exports.removeOwnedPrefabAttachment = removeOwnedPrefabAttachment;
exports.configurePrefabAttachment = configurePrefabAttachment;
const uuid_1 = require("./roundtrip/uuid");
const attachments = new WeakMap();
function prefabAssetUuid(node) {
    var _a, _b, _c, _d, _e;
    const value = (_c = (_b = (_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.asset) === null || _b === void 0 ? void 0 : _b._uuid) !== null && _c !== void 0 ? _c : (_e = (_d = node === null || node === void 0 ? void 0 : node._prefab) === null || _d === void 0 ? void 0 : _d.asset) === null || _e === void 0 ? void 0 : _e.uuid;
    return typeof value === 'string' && value ? (0, uuid_1.normalizeCocosUuid)(value) : undefined;
}
function nativePrefabIdentity(node) {
    var _a, _b, _c;
    const assetUuid = prefabAssetUuid(node);
    const instanceFileId = (_b = (_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.instance) === null || _b === void 0 ? void 0 : _b.fileId;
    return assetUuid && ((_c = node === null || node === void 0 ? void 0 : node._prefab) === null || _c === void 0 ? void 0 : _c.root) === node && typeof instanceFileId === 'string' && instanceFileId
        ? { assetUuid, instanceFileId } : undefined;
}
function isInsideNestedPrefab(node, root) {
    for (let current = node; current && current !== root; current = current.parent) {
        const info = current._prefab;
        if ((info === null || info === void 0 ? void 0 : info.root) && info.root !== root)
            return true;
        const asset = prefabAssetUuid(current);
        if (asset && prefabAssetUuid(root) && asset !== prefabAssetUuid(root))
            return true;
    }
    return false;
}
/** Source fileIds repeat across instances; instance paths supply the outer identity. */
function prefabScopedId(node, root, localId) {
    const scope = [];
    for (let current = node; current && current !== root; current = current.parent) {
        const identity = nativePrefabIdentity(current);
        if (identity)
            scope.unshift(`${encodeURIComponent(identity.assetUuid)}:${encodeURIComponent(identity.instanceFileId)}`);
    }
    return scope.length ? `prefab-instance/${scope.join('/')}/${encodeURIComponent(localId)}` : localId;
}
function ownedPrefabAttachment(carrier) {
    return attachments.get(carrier);
}
function rememberPrefabAttachment(carrier, attachment) {
    var _a;
    const expected = { assetUuid: (0, uuid_1.normalizeCocosUuid)(attachment.assetUuid), instanceFileId: attachment.instanceFileId };
    const matches = ((_a = carrier.children) !== null && _a !== void 0 ? _a : []).filter((child) => {
        const identity = nativePrefabIdentity(child);
        return child.parent === carrier && (identity === null || identity === void 0 ? void 0 : identity.assetUuid) === expected.assetUuid && identity.instanceFileId === expected.instanceFileId;
    });
    if (matches.length !== 1)
        throw new Error(`节点“${carrier.name}”的受管 Prefab 实例链接已丢失或不唯一。`);
    attachments.set(carrier, expected);
    return matches[0];
}
function removeOwnedPrefabAttachment(carrier) {
    const attachment = attachments.get(carrier);
    if (!attachment)
        return;
    const instance = rememberPrefabAttachment(carrier, attachment);
    instance.active = false;
    instance.removeFromParent();
    instance.destroy();
    attachments.delete(carrier);
}
/** Editor creation is required: cloning a node does not prove a persistent nested link. */
async function configurePrefabAttachment(carrier, requested, _scene) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const previous = attachments.get(carrier);
    const existing = previous ? rememberPrefabAttachment(carrier, previous) : undefined;
    if (!requested) {
        removeOwnedPrefabAttachment(carrier);
        return;
    }
    for (const child of (_a = carrier.children) !== null && _a !== void 0 ? _a : []) {
        if (child !== existing && (((_b = child === null || child === void 0 ? void 0 : child._prefab) === null || _b === void 0 ? void 0 : _b.root) === child || ((_c = child === null || child === void 0 ? void 0 : child._prefab) === null || _c === void 0 ? void 0 : _c.instance))) {
            throw new Error(`节点“${carrier.name}”含有来源未知的 Prefab 实例，已停止替换。`);
        }
    }
    const assetUuid = (0, uuid_1.normalizeCocosUuid)(requested.uuid);
    if ((previous === null || previous === void 0 ? void 0 : previous.assetUuid) === assetUuid)
        return;
    for (let ancestor = carrier; ancestor; ancestor = ancestor.parent) {
        if (prefabAssetUuid(ancestor) === assetUuid)
            throw new Error('Prefab 不允许引用自身或祖先 Prefab。');
    }
    const facade = (_d = globalThis.cce) === null || _d === void 0 ? void 0 : _d.SceneFacadeManager;
    if (typeof (facade === null || facade === void 0 ? void 0 : facade.createNode) !== 'function')
        throw new Error('Creator Prefab 实例创建 API 不可用。');
    const beforeChildren = new Set((_e = carrier.children) !== null && _e !== void 0 ? _e : []);
    let uuid;
    try {
        uuid = await facade.createNode({ parent: carrier.uuid, assetUuid: requested.uuid, type: 'cc.Prefab',
            unlinkPrefab: false, snapshot: false, nameIncrease: false, autoAdaptToCreate: false });
    }
    catch (error) {
        for (const child of [...((_f = carrier.children) !== null && _f !== void 0 ? _f : [])]) {
            if (!beforeChildren.has(child) && ((_g = nativePrefabIdentity(child)) === null || _g === void 0 ? void 0 : _g.assetUuid) === assetUuid) {
                child.removeFromParent();
                child.destroy();
            }
        }
        throw error;
    }
    const instance = ((_h = carrier.children) !== null && _h !== void 0 ? _h : []).find((child) => child.uuid === uuid);
    const identity = nativePrefabIdentity(instance);
    if (typeof uuid !== 'string' || !identity || instance.parent !== carrier || identity.assetUuid !== assetUuid || beforeChildren.has(instance)) {
        // Only the returned, newly-created child is eligible for cleanup.
        if (instance && !beforeChildren.has(instance)) {
            instance.removeFromParent();
            instance.destroy();
        }
        throw new Error(`节点“${carrier.name}”的 Prefab 实例未保留原生链接，已拒绝导入。`);
    }
    // Keep the Prefab's authored size, scale, rotation and internal components.
    instance.setPosition(0, 0, 0);
    if (existing) {
        existing.active = false;
        existing.removeFromParent();
        existing.destroy();
    }
    attachments.set(carrier, identity);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJlZmFiLWluc3RhbmNlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc291cmNlL3ByZWZhYi1pbnN0YW5jZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQU1BLDBDQUdDO0FBRUQsb0RBS0M7QUFFRCxvREFRQztBQUdELHdDQU9DO0FBRUQsc0RBRUM7QUFFRCw0REFTQztBQUVELGtFQVFDO0FBR0QsOERBNENDO0FBNUdELDJDQUFzRDtBQUl0RCxNQUFNLFdBQVcsR0FBRyxJQUFJLE9BQU8sRUFBb0MsQ0FBQztBQUVwRSxTQUFnQixlQUFlLENBQUMsSUFBUzs7SUFDckMsTUFBTSxLQUFLLEdBQUcsTUFBQSxNQUFBLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE9BQU8sMENBQUUsS0FBSywwQ0FBRSxLQUFLLG1DQUFJLE1BQUEsTUFBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsT0FBTywwQ0FBRSxLQUFLLDBDQUFFLElBQUksQ0FBQztJQUN4RSxPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUEseUJBQWtCLEVBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUN0RixDQUFDO0FBRUQsU0FBZ0Isb0JBQW9CLENBQUMsSUFBUzs7SUFDMUMsTUFBTSxTQUFTLEdBQUcsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hDLE1BQU0sY0FBYyxHQUFHLE1BQUEsTUFBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsT0FBTywwQ0FBRSxRQUFRLDBDQUFFLE1BQU0sQ0FBQztJQUN2RCxPQUFPLFNBQVMsSUFBSSxDQUFBLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE9BQU8sMENBQUUsSUFBSSxNQUFLLElBQUksSUFBSSxPQUFPLGNBQWMsS0FBSyxRQUFRLElBQUksY0FBYztRQUNwRyxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsY0FBYyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNwRCxDQUFDO0FBRUQsU0FBZ0Isb0JBQW9CLENBQUMsSUFBUyxFQUFFLElBQVM7SUFDckQsS0FBSyxJQUFJLE9BQU8sR0FBRyxJQUFJLEVBQUUsT0FBTyxJQUFJLE9BQU8sS0FBSyxJQUFJLEVBQUUsT0FBTyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUM3RSxNQUFNLElBQUksR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDO1FBQzdCLElBQUksQ0FBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsSUFBSSxLQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ2xELE1BQU0sS0FBSyxHQUFHLGVBQWUsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN2QyxJQUFJLEtBQUssSUFBSSxlQUFlLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxLQUFLLGVBQWUsQ0FBQyxJQUFJLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztJQUN2RixDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQztBQUVELHdGQUF3RjtBQUN4RixTQUFnQixjQUFjLENBQUMsSUFBUyxFQUFFLElBQVMsRUFBRSxPQUFlO0lBQ2hFLE1BQU0sS0FBSyxHQUFhLEVBQUUsQ0FBQztJQUMzQixLQUFLLElBQUksT0FBTyxHQUFHLElBQUksRUFBRSxPQUFPLElBQUksT0FBTyxLQUFLLElBQUksRUFBRSxPQUFPLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQzdFLE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQy9DLElBQUksUUFBUTtZQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLElBQUksa0JBQWtCLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUM1SCxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxtQkFBbUIsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDeEcsQ0FBQztBQUVELFNBQWdCLHFCQUFxQixDQUFDLE9BQVk7SUFDOUMsT0FBTyxXQUFXLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3BDLENBQUM7QUFFRCxTQUFnQix3QkFBd0IsQ0FBQyxPQUFZLEVBQUUsVUFBb0M7O0lBQ3ZGLE1BQU0sUUFBUSxHQUFHLEVBQUUsU0FBUyxFQUFFLElBQUEseUJBQWtCLEVBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFLGNBQWMsRUFBRSxVQUFVLENBQUMsY0FBYyxFQUFFLENBQUM7SUFDcEgsTUFBTSxPQUFPLEdBQUcsQ0FBQyxNQUFBLE9BQU8sQ0FBQyxRQUFRLG1DQUFJLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQVUsRUFBRSxFQUFFO1FBQzNELE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzdDLE9BQU8sS0FBSyxDQUFDLE1BQU0sS0FBSyxPQUFPLElBQUksQ0FBQSxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsU0FBUyxNQUFLLFFBQVEsQ0FBQyxTQUFTLElBQUksUUFBUSxDQUFDLGNBQWMsS0FBSyxRQUFRLENBQUMsY0FBYyxDQUFDO0lBQ3pJLENBQUMsQ0FBQyxDQUFDO0lBQ0gsSUFBSSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUM7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLE1BQU0sT0FBTyxDQUFDLElBQUksMEJBQTBCLENBQUMsQ0FBQztJQUN4RixXQUFXLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQztJQUNuQyxPQUFPLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0QixDQUFDO0FBRUQsU0FBZ0IsMkJBQTJCLENBQUMsT0FBWTtJQUNwRCxNQUFNLFVBQVUsR0FBRyxXQUFXLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzVDLElBQUksQ0FBQyxVQUFVO1FBQUUsT0FBTztJQUN4QixNQUFNLFFBQVEsR0FBRyx3QkFBd0IsQ0FBQyxPQUFPLEVBQUUsVUFBVSxDQUFDLENBQUM7SUFDL0QsUUFBUSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7SUFDeEIsUUFBUSxDQUFDLGdCQUFnQixFQUFFLENBQUM7SUFDNUIsUUFBUSxDQUFDLE9BQU8sRUFBRSxDQUFDO0lBQ25CLFdBQVcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELDJGQUEyRjtBQUNwRixLQUFLLFVBQVUseUJBQXlCLENBQUMsT0FBWSxFQUFFLFNBQXVDLEVBQ2pHLE1BQVc7O0lBQ1gsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUMxQyxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ3BGLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUNiLDJCQUEyQixDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3JDLE9BQU87SUFDWCxDQUFDO0lBQ0QsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFBLE9BQU8sQ0FBQyxRQUFRLG1DQUFJLEVBQUUsRUFBRSxDQUFDO1FBQ3pDLElBQUksS0FBSyxLQUFLLFFBQVEsSUFBSSxDQUFDLENBQUEsTUFBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsT0FBTywwQ0FBRSxJQUFJLE1BQUssS0FBSyxLQUFJLE1BQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLE9BQU8sMENBQUUsUUFBUSxDQUFBLENBQUMsRUFBRSxDQUFDO1lBQ3JGLE1BQU0sSUFBSSxLQUFLLENBQUMsTUFBTSxPQUFPLENBQUMsSUFBSSwyQkFBMkIsQ0FBQyxDQUFDO1FBQ25FLENBQUM7SUFDTCxDQUFDO0lBQ0QsTUFBTSxTQUFTLEdBQUcsSUFBQSx5QkFBa0IsRUFBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDckQsSUFBSSxDQUFBLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxTQUFTLE1BQUssU0FBUztRQUFFLE9BQU87SUFDOUMsS0FBSyxJQUFJLFFBQVEsR0FBRyxPQUFPLEVBQUUsUUFBUSxFQUFFLFFBQVEsR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDaEUsSUFBSSxlQUFlLENBQUMsUUFBUSxDQUFDLEtBQUssU0FBUztZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMkJBQTJCLENBQUMsQ0FBQztJQUM5RixDQUFDO0lBQ0QsTUFBTSxNQUFNLEdBQUcsTUFBQyxVQUFrQixDQUFDLEdBQUcsMENBQUUsa0JBQWtCLENBQUM7SUFDM0QsSUFBSSxPQUFPLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLFVBQVUsQ0FBQSxLQUFLLFVBQVU7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDhCQUE4QixDQUFDLENBQUM7SUFDOUYsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQUMsTUFBQSxPQUFPLENBQUMsUUFBUSxtQ0FBSSxFQUFFLENBQUMsQ0FBQztJQUN2RCxJQUFJLElBQWEsQ0FBQztJQUNsQixJQUFJLENBQUM7UUFDRCxJQUFJLEdBQUcsTUFBTSxNQUFNLENBQUMsVUFBVSxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLFNBQVMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLFdBQVc7WUFDL0YsWUFBWSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxLQUFLLEVBQUUsaUJBQWlCLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUMvRixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLEtBQUssTUFBTSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBQSxPQUFPLENBQUMsUUFBUSxtQ0FBSSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDaEQsSUFBSSxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQSxNQUFBLG9CQUFvQixDQUFDLEtBQUssQ0FBQywwQ0FBRSxTQUFTLE1BQUssU0FBUyxFQUFFLENBQUM7Z0JBQ3JGLEtBQUssQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2dCQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUM5QyxDQUFDO1FBQ0wsQ0FBQztRQUNELE1BQU0sS0FBSyxDQUFDO0lBQ2hCLENBQUM7SUFDRCxNQUFNLFFBQVEsR0FBRyxDQUFDLE1BQUEsT0FBTyxDQUFDLFFBQVEsbUNBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBVSxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxDQUFDO0lBQ3BGLE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQ2hELElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxJQUFJLENBQUMsUUFBUSxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssT0FBTyxJQUFJLFFBQVEsQ0FBQyxTQUFTLEtBQUssU0FBUyxJQUFJLGNBQWMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztRQUMzSSxrRUFBa0U7UUFDbEUsSUFBSSxRQUFRLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7WUFBQyxRQUFRLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUFDLENBQUM7UUFDbkcsTUFBTSxJQUFJLEtBQUssQ0FBQyxNQUFNLE9BQU8sQ0FBQyxJQUFJLDRCQUE0QixDQUFDLENBQUM7SUFDcEUsQ0FBQztJQUNELDRFQUE0RTtJQUM1RSxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDOUIsSUFBSSxRQUFRLEVBQUUsQ0FBQztRQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO1FBQUMsUUFBUSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFBQyxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUM7SUFBQyxDQUFDO0lBQzNGLFdBQVcsQ0FBQyxHQUFHLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ3ZDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBub3JtYWxpemVDb2Nvc1V1aWQgfSBmcm9tICcuL3JvdW5kdHJpcC91dWlkJztcblxuZXhwb3J0IGludGVyZmFjZSBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQgeyBhc3NldFV1aWQ6IHN0cmluZzsgaW5zdGFuY2VGaWxlSWQ6IHN0cmluZyB9XG5cbmNvbnN0IGF0dGFjaG1lbnRzID0gbmV3IFdlYWtNYXA8b2JqZWN0LCBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQ+KCk7XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmVmYWJBc3NldFV1aWQobm9kZTogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/Ll9wcmVmYWI/LmFzc2V0Py5fdXVpZCA/PyBub2RlPy5fcHJlZmFiPy5hc3NldD8udXVpZDtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSA/IG5vcm1hbGl6ZUNvY29zVXVpZCh2YWx1ZSkgOiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVQcmVmYWJJZGVudGl0eShub2RlOiBhbnkpOiBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IGFzc2V0VXVpZCA9IHByZWZhYkFzc2V0VXVpZChub2RlKTtcbiAgICBjb25zdCBpbnN0YW5jZUZpbGVJZCA9IG5vZGU/Ll9wcmVmYWI/Lmluc3RhbmNlPy5maWxlSWQ7XG4gICAgcmV0dXJuIGFzc2V0VXVpZCAmJiBub2RlPy5fcHJlZmFiPy5yb290ID09PSBub2RlICYmIHR5cGVvZiBpbnN0YW5jZUZpbGVJZCA9PT0gJ3N0cmluZycgJiYgaW5zdGFuY2VGaWxlSWRcbiAgICAgICAgPyB7IGFzc2V0VXVpZCwgaW5zdGFuY2VGaWxlSWQgfSA6IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzSW5zaWRlTmVzdGVkUHJlZmFiKG5vZGU6IGFueSwgcm9vdDogYW55KTogYm9vbGVhbiB7XG4gICAgZm9yIChsZXQgY3VycmVudCA9IG5vZGU7IGN1cnJlbnQgJiYgY3VycmVudCAhPT0gcm9vdDsgY3VycmVudCA9IGN1cnJlbnQucGFyZW50KSB7XG4gICAgICAgIGNvbnN0IGluZm8gPSBjdXJyZW50Ll9wcmVmYWI7XG4gICAgICAgIGlmIChpbmZvPy5yb290ICYmIGluZm8ucm9vdCAhPT0gcm9vdCkgcmV0dXJuIHRydWU7XG4gICAgICAgIGNvbnN0IGFzc2V0ID0gcHJlZmFiQXNzZXRVdWlkKGN1cnJlbnQpO1xuICAgICAgICBpZiAoYXNzZXQgJiYgcHJlZmFiQXNzZXRVdWlkKHJvb3QpICYmIGFzc2V0ICE9PSBwcmVmYWJBc3NldFV1aWQocm9vdCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBTb3VyY2UgZmlsZUlkcyByZXBlYXQgYWNyb3NzIGluc3RhbmNlczsgaW5zdGFuY2UgcGF0aHMgc3VwcGx5IHRoZSBvdXRlciBpZGVudGl0eS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmVmYWJTY29wZWRJZChub2RlOiBhbnksIHJvb3Q6IGFueSwgbG9jYWxJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBzY29wZTogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGxldCBjdXJyZW50ID0gbm9kZTsgY3VycmVudCAmJiBjdXJyZW50ICE9PSByb290OyBjdXJyZW50ID0gY3VycmVudC5wYXJlbnQpIHtcbiAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBuYXRpdmVQcmVmYWJJZGVudGl0eShjdXJyZW50KTtcbiAgICAgICAgaWYgKGlkZW50aXR5KSBzY29wZS51bnNoaWZ0KGAke2VuY29kZVVSSUNvbXBvbmVudChpZGVudGl0eS5hc3NldFV1aWQpfToke2VuY29kZVVSSUNvbXBvbmVudChpZGVudGl0eS5pbnN0YW5jZUZpbGVJZCl9YCk7XG4gICAgfVxuICAgIHJldHVybiBzY29wZS5sZW5ndGggPyBgcHJlZmFiLWluc3RhbmNlLyR7c2NvcGUuam9pbignLycpfS8ke2VuY29kZVVSSUNvbXBvbmVudChsb2NhbElkKX1gIDogbG9jYWxJZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG93bmVkUHJlZmFiQXR0YWNobWVudChjYXJyaWVyOiBhbnkpOiBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiBhdHRhY2htZW50cy5nZXQoY2Fycmllcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1lbWJlclByZWZhYkF0dGFjaG1lbnQoY2FycmllcjogYW55LCBhdHRhY2htZW50OiBQcmVmYWJJbnN0YW5jZUF0dGFjaG1lbnQpOiBhbnkge1xuICAgIGNvbnN0IGV4cGVjdGVkID0geyBhc3NldFV1aWQ6IG5vcm1hbGl6ZUNvY29zVXVpZChhdHRhY2htZW50LmFzc2V0VXVpZCksIGluc3RhbmNlRmlsZUlkOiBhdHRhY2htZW50Lmluc3RhbmNlRmlsZUlkIH07XG4gICAgY29uc3QgbWF0Y2hlcyA9IChjYXJyaWVyLmNoaWxkcmVuID8/IFtdKS5maWx0ZXIoKGNoaWxkOiBhbnkpID0+IHtcbiAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBuYXRpdmVQcmVmYWJJZGVudGl0eShjaGlsZCk7XG4gICAgICAgIHJldHVybiBjaGlsZC5wYXJlbnQgPT09IGNhcnJpZXIgJiYgaWRlbnRpdHk/LmFzc2V0VXVpZCA9PT0gZXhwZWN0ZWQuYXNzZXRVdWlkICYmIGlkZW50aXR5Lmluc3RhbmNlRmlsZUlkID09PSBleHBlY3RlZC5pbnN0YW5jZUZpbGVJZDtcbiAgICB9KTtcbiAgICBpZiAobWF0Y2hlcy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihg6IqC54K54oCcJHtjYXJyaWVyLm5hbWV94oCd55qE5Y+X566hIFByZWZhYiDlrp7kvovpk77mjqXlt7LkuKLlpLHmiJbkuI3llK/kuIDjgIJgKTtcbiAgICBhdHRhY2htZW50cy5zZXQoY2FycmllciwgZXhwZWN0ZWQpO1xuICAgIHJldHVybiBtYXRjaGVzWzBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlT3duZWRQcmVmYWJBdHRhY2htZW50KGNhcnJpZXI6IGFueSk6IHZvaWQge1xuICAgIGNvbnN0IGF0dGFjaG1lbnQgPSBhdHRhY2htZW50cy5nZXQoY2Fycmllcik7XG4gICAgaWYgKCFhdHRhY2htZW50KSByZXR1cm47XG4gICAgY29uc3QgaW5zdGFuY2UgPSByZW1lbWJlclByZWZhYkF0dGFjaG1lbnQoY2FycmllciwgYXR0YWNobWVudCk7XG4gICAgaW5zdGFuY2UuYWN0aXZlID0gZmFsc2U7XG4gICAgaW5zdGFuY2UucmVtb3ZlRnJvbVBhcmVudCgpO1xuICAgIGluc3RhbmNlLmRlc3Ryb3koKTtcbiAgICBhdHRhY2htZW50cy5kZWxldGUoY2Fycmllcik7XG59XG5cbi8qKiBFZGl0b3IgY3JlYXRpb24gaXMgcmVxdWlyZWQ6IGNsb25pbmcgYSBub2RlIGRvZXMgbm90IHByb3ZlIGEgcGVyc2lzdGVudCBuZXN0ZWQgbGluay4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb25maWd1cmVQcmVmYWJBdHRhY2htZW50KGNhcnJpZXI6IGFueSwgcmVxdWVzdGVkOiB7IHV1aWQ6IHN0cmluZyB9IHwgdW5kZWZpbmVkLFxuICAgIF9zY2VuZTogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcHJldmlvdXMgPSBhdHRhY2htZW50cy5nZXQoY2Fycmllcik7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBwcmV2aW91cyA/IHJlbWVtYmVyUHJlZmFiQXR0YWNobWVudChjYXJyaWVyLCBwcmV2aW91cykgOiB1bmRlZmluZWQ7XG4gICAgaWYgKCFyZXF1ZXN0ZWQpIHtcbiAgICAgICAgcmVtb3ZlT3duZWRQcmVmYWJBdHRhY2htZW50KGNhcnJpZXIpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2Fycmllci5jaGlsZHJlbiA/PyBbXSkge1xuICAgICAgICBpZiAoY2hpbGQgIT09IGV4aXN0aW5nICYmIChjaGlsZD8uX3ByZWZhYj8ucm9vdCA9PT0gY2hpbGQgfHwgY2hpbGQ/Ll9wcmVmYWI/Lmluc3RhbmNlKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDoioLngrnigJwke2NhcnJpZXIubmFtZX3igJ3lkKvmnInmnaXmupDmnKrnn6XnmoQgUHJlZmFiIOWunuS+i++8jOW3suWBnOatouabv+aNouOAgmApO1xuICAgICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGFzc2V0VXVpZCA9IG5vcm1hbGl6ZUNvY29zVXVpZChyZXF1ZXN0ZWQudXVpZCk7XG4gICAgaWYgKHByZXZpb3VzPy5hc3NldFV1aWQgPT09IGFzc2V0VXVpZCkgcmV0dXJuO1xuICAgIGZvciAobGV0IGFuY2VzdG9yID0gY2FycmllcjsgYW5jZXN0b3I7IGFuY2VzdG9yID0gYW5jZXN0b3IucGFyZW50KSB7XG4gICAgICAgIGlmIChwcmVmYWJBc3NldFV1aWQoYW5jZXN0b3IpID09PSBhc3NldFV1aWQpIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOS4jeWFgeiuuOW8leeUqOiHqui6q+aIluelluWFiCBQcmVmYWLjgIInKTtcbiAgICB9XG4gICAgY29uc3QgZmFjYWRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lRmFjYWRlTWFuYWdlcjtcbiAgICBpZiAodHlwZW9mIGZhY2FkZT8uY3JlYXRlTm9kZSAhPT0gJ2Z1bmN0aW9uJykgdGhyb3cgbmV3IEVycm9yKCdDcmVhdG9yIFByZWZhYiDlrp7kvovliJvlu7ogQVBJIOS4jeWPr+eUqOOAgicpO1xuICAgIGNvbnN0IGJlZm9yZUNoaWxkcmVuID0gbmV3IFNldChjYXJyaWVyLmNoaWxkcmVuID8/IFtdKTtcbiAgICBsZXQgdXVpZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgICB1dWlkID0gYXdhaXQgZmFjYWRlLmNyZWF0ZU5vZGUoeyBwYXJlbnQ6IGNhcnJpZXIudXVpZCwgYXNzZXRVdWlkOiByZXF1ZXN0ZWQudXVpZCwgdHlwZTogJ2NjLlByZWZhYicsXG4gICAgICAgICAgICB1bmxpbmtQcmVmYWI6IGZhbHNlLCBzbmFwc2hvdDogZmFsc2UsIG5hbWVJbmNyZWFzZTogZmFsc2UsIGF1dG9BZGFwdFRvQ3JlYXRlOiBmYWxzZSB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi4oY2Fycmllci5jaGlsZHJlbiA/PyBbXSldKSB7XG4gICAgICAgICAgICBpZiAoIWJlZm9yZUNoaWxkcmVuLmhhcyhjaGlsZCkgJiYgbmF0aXZlUHJlZmFiSWRlbnRpdHkoY2hpbGQpPy5hc3NldFV1aWQgPT09IGFzc2V0VXVpZCkge1xuICAgICAgICAgICAgICAgIGNoaWxkLnJlbW92ZUZyb21QYXJlbnQoKTsgY2hpbGQuZGVzdHJveSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICBjb25zdCBpbnN0YW5jZSA9IChjYXJyaWVyLmNoaWxkcmVuID8/IFtdKS5maW5kKChjaGlsZDogYW55KSA9PiBjaGlsZC51dWlkID09PSB1dWlkKTtcbiAgICBjb25zdCBpZGVudGl0eSA9IG5hdGl2ZVByZWZhYklkZW50aXR5KGluc3RhbmNlKTtcbiAgICBpZiAodHlwZW9mIHV1aWQgIT09ICdzdHJpbmcnIHx8ICFpZGVudGl0eSB8fCBpbnN0YW5jZS5wYXJlbnQgIT09IGNhcnJpZXIgfHwgaWRlbnRpdHkuYXNzZXRVdWlkICE9PSBhc3NldFV1aWQgfHwgYmVmb3JlQ2hpbGRyZW4uaGFzKGluc3RhbmNlKSkge1xuICAgICAgICAvLyBPbmx5IHRoZSByZXR1cm5lZCwgbmV3bHktY3JlYXRlZCBjaGlsZCBpcyBlbGlnaWJsZSBmb3IgY2xlYW51cC5cbiAgICAgICAgaWYgKGluc3RhbmNlICYmICFiZWZvcmVDaGlsZHJlbi5oYXMoaW5zdGFuY2UpKSB7IGluc3RhbmNlLnJlbW92ZUZyb21QYXJlbnQoKTsgaW5zdGFuY2UuZGVzdHJveSgpOyB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6IqC54K54oCcJHtjYXJyaWVyLm5hbWV94oCd55qEIFByZWZhYiDlrp7kvovmnKrkv53nlZnljp/nlJ/pk77mjqXvvIzlt7Lmi5Lnu53lr7zlhaXjgIJgKTtcbiAgICB9XG4gICAgLy8gS2VlcCB0aGUgUHJlZmFiJ3MgYXV0aG9yZWQgc2l6ZSwgc2NhbGUsIHJvdGF0aW9uIGFuZCBpbnRlcm5hbCBjb21wb25lbnRzLlxuICAgIGluc3RhbmNlLnNldFBvc2l0aW9uKDAsIDAsIDApO1xuICAgIGlmIChleGlzdGluZykgeyBleGlzdGluZy5hY3RpdmUgPSBmYWxzZTsgZXhpc3RpbmcucmVtb3ZlRnJvbVBhcmVudCgpOyBleGlzdGluZy5kZXN0cm95KCk7IH1cbiAgICBhdHRhY2htZW50cy5zZXQoY2FycmllciwgaWRlbnRpdHkpO1xufVxuIl19