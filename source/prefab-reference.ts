import type { PrefabAssetSpec } from './types';
import { samePrefabSize } from './importer/local-prefabs';

const RECORD = 'figmaImporterPrefabReferenceV1';
const RESERVED = new Set(['_name', '_lpos', '_lrot', '_lscale', '_active']);

export function referencedPrefabChild(node: any): any | null {
    const record = node.__editorExtras__?.[RECORD];
    if (!record) return null;
    const child = node.children.find((item: any) => item._prefab?.instance?.fileId === record.instanceId);
    const uuid = child?._prefab?.asset?._uuid ?? child?._prefab?.asset?.uuid;
    if (!child || uuid !== record.uuid) {
        throw new Error(`节点“${node.name}”的 Prefab 引用已被手工替换或丢失，已停止更新。`);
    }
    return child;
}

export function assertReferenceRemovable(node: any): void {
    const child = referencedPrefabChild(node);
    if (!child) return;
    const instance = child._prefab.instance;
    const hasOverrides = instance.propertyOverrides?.some((item: any) =>
        item.targetInfo?.localID?.length !== 1
        || item.targetInfo.localID[0] !== child._prefab.fileId
        || item.propertyPath?.length !== 1 || !RESERVED.has(item.propertyPath[0]));
    if (hasOverrides || instance.mountedChildren?.length || instance.mountedComponents?.length
        || instance.removedComponents?.length || child._prefab.targetOverrides?.length) {
        throw new Error(`节点“${node.name}”引用的 Prefab 含有手工修改，已停止替换或移除。`);
    }
}

export function removePrefabReference(node: any): void {
    assertReferenceRemovable(node);
    const child = referencedPrefabChild(node);
    if (!child) return;
    child.active = false;
    child.removeFromParent();
    child.destroy();
    delete node.__editorExtras__[RECORD];
}

function recordPosition(child: any, cc: any): void {
    const utils = cc.Prefab?._utils;
    if (!utils?.PropertyOverrideInfo || !utils?.TargetInfo) {
        throw new Error('Cocos Prefab 属性覆盖 API 不可用，无法保存嵌套引用。');
    }
    const instance = child._prefab.instance;
    const propertyPath = '_lpos';
    let override = instance.propertyOverrides.find((item: any) =>
        item.targetInfo?.localID?.length === 1 && item.targetInfo.localID[0] === child._prefab.fileId
        && item.propertyPath?.length === 1 && item.propertyPath[0] === propertyPath);
    if (!override) {
        override = new utils.PropertyOverrideInfo();
        override.targetInfo = new utils.TargetInfo();
        override.targetInfo.localID = [child._prefab.fileId];
        override.propertyPath = [propertyPath];
        instance.propertyOverrides.push(override);
    }
    override.value = child.position.clone();
}

export async function configurePrefabReference(node: any, spec: PrefabAssetSpec, cc: any): Promise<void> {
    if (!cc.Prefab?._utils?.PropertyOverrideInfo || !cc.Prefab?._utils?.TargetInfo) {
        throw new Error('Cocos Prefab 属性覆盖 API 不可用，无法保存嵌套引用。');
    }
    let child = referencedPrefabChild(node);
    if (child && node.__editorExtras__[RECORD].uuid !== spec.uuid) {
        assertReferenceRemovable(node);
        child = null;
    }
    if (!child) {
        const api = (globalThis as any).cce?.Prefab;
        if (!api?.createNodeFromPrefabAsset) throw new Error('Cocos 嵌套 Prefab 创建 API 不可用。');
        const asset: any = await new Promise((resolve, reject) =>
            cc.assetManager.loadAny({ uuid: spec.uuid }, (error: Error | null, result: any) =>
                error ? reject(error) : resolve(result)));
        if (!(asset instanceof cc.Prefab)) throw new Error(`资源不是 Prefab：${spec.url}`);
        const size = asset.data?.getComponent(cc.UITransform)?.contentSize;
        if (!size || !samePrefabSize(spec.width, spec.height, size)) {
            throw new Error(`Prefab 尺寸已变化，请重新导入：${spec.url}`);
        }
        const created = api.createNodeFromPrefabAsset(asset);
        const createdUuid = created?._prefab?.asset?._uuid ?? created?._prefab?.asset?.uuid;
        if (!created?._prefab?.instance?.fileId || createdUuid !== spec.uuid
            || !created.getComponent(cc.UITransform)) {
            created?.destroy();
            throw new Error(`未能创建带资源关联的 Prefab 实例：${spec.url}`);
        }
        // Load and validate the replacement before removing the previous one.
        removePrefabReference(node);
        child = created;
        node.addChild(child);
        node.__editorExtras__ ??= {};
        node.__editorExtras__[RECORD] = { uuid: spec.uuid, instanceId: child._prefab.instance.fileId };
    }
    const transform = child.getComponent(cc.UITransform);
    child.setPosition(new cc.Vec3(
        (transform.anchorPoint.x - 0.5) * spec.width,
        (transform.anchorPoint.y - 0.5) * spec.height, 0,
    ));
    recordPosition(child, cc);
}
