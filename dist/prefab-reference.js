"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.referencedPrefabChild = referencedPrefabChild;
exports.assertReferenceRemovable = assertReferenceRemovable;
exports.removePrefabReference = removePrefabReference;
exports.configurePrefabReference = configurePrefabReference;
const local_prefabs_1 = require("./importer/local-prefabs");
const RECORD = 'figmaImporterPrefabReferenceV1';
const RESERVED = new Set(['_name', '_lpos', '_lrot', '_lscale', '_active']);
function referencedPrefabChild(node) {
    var _a, _b, _c, _d, _e, _f;
    const record = (_a = node.__editorExtras__) === null || _a === void 0 ? void 0 : _a[RECORD];
    if (!record)
        return null;
    const child = node.children.find((item) => { var _a, _b; return ((_b = (_a = item._prefab) === null || _a === void 0 ? void 0 : _a.instance) === null || _b === void 0 ? void 0 : _b.fileId) === record.instanceId; });
    const uuid = (_d = (_c = (_b = child === null || child === void 0 ? void 0 : child._prefab) === null || _b === void 0 ? void 0 : _b.asset) === null || _c === void 0 ? void 0 : _c._uuid) !== null && _d !== void 0 ? _d : (_f = (_e = child === null || child === void 0 ? void 0 : child._prefab) === null || _e === void 0 ? void 0 : _e.asset) === null || _f === void 0 ? void 0 : _f.uuid;
    if (!child || uuid !== record.uuid) {
        throw new Error(`节点“${node.name}”的 Prefab 引用已被手工替换或丢失，已停止更新。`);
    }
    return child;
}
function assertReferenceRemovable(node) {
    var _a, _b, _c, _d, _e;
    const child = referencedPrefabChild(node);
    if (!child)
        return;
    const instance = child._prefab.instance;
    const hasOverrides = (_a = instance.propertyOverrides) === null || _a === void 0 ? void 0 : _a.some((item) => {
        var _a, _b, _c;
        return ((_b = (_a = item.targetInfo) === null || _a === void 0 ? void 0 : _a.localID) === null || _b === void 0 ? void 0 : _b.length) !== 1
            || item.targetInfo.localID[0] !== child._prefab.fileId
            || ((_c = item.propertyPath) === null || _c === void 0 ? void 0 : _c.length) !== 1 || !RESERVED.has(item.propertyPath[0]);
    });
    if (hasOverrides || ((_b = instance.mountedChildren) === null || _b === void 0 ? void 0 : _b.length) || ((_c = instance.mountedComponents) === null || _c === void 0 ? void 0 : _c.length)
        || ((_d = instance.removedComponents) === null || _d === void 0 ? void 0 : _d.length) || ((_e = child._prefab.targetOverrides) === null || _e === void 0 ? void 0 : _e.length)) {
        throw new Error(`节点“${node.name}”引用的 Prefab 含有手工修改，已停止替换或移除。`);
    }
}
function removePrefabReference(node) {
    assertReferenceRemovable(node);
    const child = referencedPrefabChild(node);
    if (!child)
        return;
    child.active = false;
    child.removeFromParent();
    child.destroy();
    delete node.__editorExtras__[RECORD];
}
function recordPosition(child, cc) {
    var _a;
    const utils = (_a = cc.Prefab) === null || _a === void 0 ? void 0 : _a._utils;
    if (!(utils === null || utils === void 0 ? void 0 : utils.PropertyOverrideInfo) || !(utils === null || utils === void 0 ? void 0 : utils.TargetInfo)) {
        throw new Error('Cocos Prefab 属性覆盖 API 不可用，无法保存嵌套引用。');
    }
    const instance = child._prefab.instance;
    const propertyPath = '_lpos';
    let override = instance.propertyOverrides.find((item) => {
        var _a, _b, _c;
        return ((_b = (_a = item.targetInfo) === null || _a === void 0 ? void 0 : _a.localID) === null || _b === void 0 ? void 0 : _b.length) === 1 && item.targetInfo.localID[0] === child._prefab.fileId
            && ((_c = item.propertyPath) === null || _c === void 0 ? void 0 : _c.length) === 1 && item.propertyPath[0] === propertyPath;
    });
    if (!override) {
        override = new utils.PropertyOverrideInfo();
        override.targetInfo = new utils.TargetInfo();
        override.targetInfo.localID = [child._prefab.fileId];
        override.propertyPath = [propertyPath];
        instance.propertyOverrides.push(override);
    }
    override.value = child.position.clone();
}
async function configurePrefabReference(node, spec, cc) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    if (!((_b = (_a = cc.Prefab) === null || _a === void 0 ? void 0 : _a._utils) === null || _b === void 0 ? void 0 : _b.PropertyOverrideInfo) || !((_d = (_c = cc.Prefab) === null || _c === void 0 ? void 0 : _c._utils) === null || _d === void 0 ? void 0 : _d.TargetInfo)) {
        throw new Error('Cocos Prefab 属性覆盖 API 不可用，无法保存嵌套引用。');
    }
    let child = referencedPrefabChild(node);
    if (child && node.__editorExtras__[RECORD].uuid !== spec.uuid) {
        assertReferenceRemovable(node);
        child = null;
    }
    if (!child) {
        const api = (_e = globalThis.cce) === null || _e === void 0 ? void 0 : _e.Prefab;
        if (!(api === null || api === void 0 ? void 0 : api.createNodeFromPrefabAsset))
            throw new Error('Cocos 嵌套 Prefab 创建 API 不可用。');
        const asset = await new Promise((resolve, reject) => cc.assetManager.loadAny({ uuid: spec.uuid }, (error, result) => error ? reject(error) : resolve(result)));
        if (!(asset instanceof cc.Prefab))
            throw new Error(`资源不是 Prefab：${spec.url}`);
        const size = (_g = (_f = asset.data) === null || _f === void 0 ? void 0 : _f.getComponent(cc.UITransform)) === null || _g === void 0 ? void 0 : _g.contentSize;
        if (!size || !(0, local_prefabs_1.samePrefabSize)(spec.width, spec.height, size)) {
            throw new Error(`Prefab 尺寸已变化，请重新导入：${spec.url}`);
        }
        const created = api.createNodeFromPrefabAsset(asset);
        const createdUuid = (_k = (_j = (_h = created === null || created === void 0 ? void 0 : created._prefab) === null || _h === void 0 ? void 0 : _h.asset) === null || _j === void 0 ? void 0 : _j._uuid) !== null && _k !== void 0 ? _k : (_m = (_l = created === null || created === void 0 ? void 0 : created._prefab) === null || _l === void 0 ? void 0 : _l.asset) === null || _m === void 0 ? void 0 : _m.uuid;
        if (!((_p = (_o = created === null || created === void 0 ? void 0 : created._prefab) === null || _o === void 0 ? void 0 : _o.instance) === null || _p === void 0 ? void 0 : _p.fileId) || createdUuid !== spec.uuid
            || !created.getComponent(cc.UITransform)) {
            created === null || created === void 0 ? void 0 : created.destroy();
            throw new Error(`未能创建带资源关联的 Prefab 实例：${spec.url}`);
        }
        // Load and validate the replacement before removing the previous one.
        removePrefabReference(node);
        child = created;
        node.addChild(child);
        (_q = node.__editorExtras__) !== null && _q !== void 0 ? _q : (node.__editorExtras__ = {});
        node.__editorExtras__[RECORD] = { uuid: spec.uuid, instanceId: child._prefab.instance.fileId };
    }
    const transform = child.getComponent(cc.UITransform);
    child.setPosition(new cc.Vec3((transform.anchorPoint.x - 0.5) * spec.width, (transform.anchorPoint.y - 0.5) * spec.height, 0));
    recordPosition(child, cc);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJlZmFiLXJlZmVyZW5jZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9wcmVmYWItcmVmZXJlbmNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBTUEsc0RBU0M7QUFFRCw0REFZQztBQUVELHNEQVFDO0FBc0JELDREQXdDQztBQXBHRCw0REFBMEQ7QUFFMUQsTUFBTSxNQUFNLEdBQUcsZ0NBQWdDLENBQUM7QUFDaEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUU1RSxTQUFnQixxQkFBcUIsQ0FBQyxJQUFTOztJQUMzQyxNQUFNLE1BQU0sR0FBRyxNQUFBLElBQUksQ0FBQyxnQkFBZ0IsMENBQUcsTUFBTSxDQUFDLENBQUM7SUFDL0MsSUFBSSxDQUFDLE1BQU07UUFBRSxPQUFPLElBQUksQ0FBQztJQUN6QixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQVMsRUFBRSxFQUFFLGVBQUMsT0FBQSxDQUFBLE1BQUEsTUFBQSxJQUFJLENBQUMsT0FBTywwQ0FBRSxRQUFRLDBDQUFFLE1BQU0sTUFBSyxNQUFNLENBQUMsVUFBVSxDQUFBLEVBQUEsQ0FBQyxDQUFDO0lBQ3RHLE1BQU0sSUFBSSxHQUFHLE1BQUEsTUFBQSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxPQUFPLDBDQUFFLEtBQUssMENBQUUsS0FBSyxtQ0FBSSxNQUFBLE1BQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLE9BQU8sMENBQUUsS0FBSywwQ0FBRSxJQUFJLENBQUM7SUFDekUsSUFBSSxDQUFDLEtBQUssSUFBSSxJQUFJLEtBQUssTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2pDLE1BQU0sSUFBSSxLQUFLLENBQUMsTUFBTSxJQUFJLENB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QUFFLENBQUMsV0FBVyxDQUFDLENBQUM7SUFDckQsS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQ3pCLENBQUMsU0FBUyxDQUFDLFdBQVcsQ0FBQyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUssRUFDNUMsQ0FBQyxTQUFTLENBQUMsV0FBVyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FDbkQsQ0FBQyxDQUFDO0lBQ0gsY0FBYyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUM5QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBQcmVmYWJBc3NldFNwZWMgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB7IHNhbWVQcmVmYWJTaXplIH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1wcmVmYWJzJztcblxuY29uc3QgUkVDT1JEID0gJ2ZpZ21hSW1wb3J0ZXJQcmVmYWJSZWZlcmVuY2VWMSc7XG5jb25zdCBSRVNFUlZFRCA9IG5ldyBTZXQoWydfbmFtZScsICdfbHBvcycsICdfbHJvdCcsICdfbHNjYWxlJywgJ19hY3RpdmUnXSk7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWZlcmVuY2VkUHJlZmFiQ2hpbGQobm9kZTogYW55KTogYW55IHwgbnVsbCB7XG4gICAgY29uc3QgcmVjb3JkID0gbm9kZS5fX2VkaXRvckV4dHJhc19fPy5bUkVDT1JEXTtcbiAgICBpZiAoIXJlY29yZCkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY2hpbGQgPSBub2RlLmNoaWxkcmVuLmZpbmQoKGl0ZW06IGFueSkgPT4gaXRlbS5fcHJlZmFiPy5pbnN0YW5jZT8uZmlsZUlkID09PSByZWNvcmQuaW5zdGFuY2VJZCk7XG4gICAgY29uc3QgdXVpZCA9IGNoaWxkPy5fcHJlZmFiPy5hc3NldD8uX3V1aWQgPz8gY2hpbGQ/Ll9wcmVmYWI/LmFzc2V0Py51dWlkO1xuICAgIGlmICghY2hpbGQgfHwgdXVpZCAhPT0gcmVjb3JkLnV1aWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDoioLngrnigJwke25vZGUubmFtZX3igJ3nmoQgUHJlZmFiIOW8leeUqOW3suiiq+aJi+W3peabv+aNouaIluS4ouWkse+8jOW3suWBnOatouabtOaWsOOAgmApO1xuICAgIH1cbiAgICByZXR1cm4gY2hpbGQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRSZWZlcmVuY2VSZW1vdmFibGUobm9kZTogYW55KTogdm9pZCB7XG4gICAgY29uc3QgY2hpbGQgPSByZWZlcmVuY2VkUHJlZmFiQ2hpbGQobm9kZSk7XG4gICAgaWYgKCFjaGlsZCkgcmV0dXJuO1xuICAgIGNvbnN0IGluc3RhbmNlID0gY2hpbGQuX3ByZWZhYi5pbnN0YW5jZTtcbiAgICBjb25zdCBoYXNPdmVycmlkZXMgPSBpbnN0YW5jZS5wcm9wZXJ0eU92ZXJyaWRlcz8uc29tZSgoaXRlbTogYW55KSA9PlxuICAgICAgICBpdGVtLnRhcmdldEluZm8/LmxvY2FsSUQ/Lmxlbmd0aCAhPT0gMVxuICAgICAgICB8fCBpdGVtLnRhcmdldEluZm8ubG9jYWxJRFswXSAhPT0gY2hpbGQuX3ByZWZhYi5maWxlSWRcbiAgICAgICAgfHwgaXRlbS5wcm9wZXJ0eVBhdGg/Lmxlbmd0aCAhPT0gMSB8fCAhUkVTRVJWRUQuaGFzKGl0ZW0ucHJvcGVydHlQYXRoWzBdKSk7XG4gICAgaWYgKGhhc092ZXJyaWRlcyB8fCBpbnN0YW5jZS5tb3VudGVkQ2hpbGRyZW4/Lmxlbmd0aCB8fCBpbnN0YW5jZS5tb3VudGVkQ29tcG9uZW50cz8ubGVuZ3RoXG4gICAgICAgIHx8IGluc3RhbmNlLnJlbW92ZWRDb21wb25lbnRzPy5sZW5ndGggfHwgY2hpbGQuX3ByZWZhYi50YXJnZXRPdmVycmlkZXM/Lmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneW8leeUqOeahCBQcmVmYWIg5ZCr5pyJ5omL5bel5L+u5pS577yM5bey5YGc5q2i5pu/5o2i5oiW56e76Zmk44CCYCk7XG4gICAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlUHJlZmFiUmVmZXJlbmNlKG5vZGU6IGFueSk6IHZvaWQge1xuICAgIGFzc2VydFJlZmVyZW5jZVJlbW92YWJsZShub2RlKTtcbiAgICBjb25zdCBjaGlsZCA9IHJlZmVyZW5jZWRQcmVmYWJDaGlsZChub2RlKTtcbiAgICBpZiAoIWNoaWxkKSByZXR1cm47XG4gICAgY2hpbGQuYWN0aXZlID0gZmFsc2U7XG4gICAgY2hpbGQucmVtb3ZlRnJvbVBhcmVudCgpO1xuICAgIGNoaWxkLmRlc3Ryb3koKTtcbiAgICBkZWxldGUgbm9kZS5fX2VkaXRvckV4dHJhc19fW1JFQ09SRF07XG59XG5cbmZ1bmN0aW9uIHJlY29yZFBvc2l0aW9uKGNoaWxkOiBhbnksIGNjOiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCB1dGlscyA9IGNjLlByZWZhYj8uX3V0aWxzO1xuICAgIGlmICghdXRpbHM/LlByb3BlcnR5T3ZlcnJpZGVJbmZvIHx8ICF1dGlscz8uVGFyZ2V0SW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIFByZWZhYiDlsZ7mgKfopobnm5YgQVBJIOS4jeWPr+eUqO+8jOaXoOazleS/neWtmOW1jOWll+W8leeUqOOAgicpO1xuICAgIH1cbiAgICBjb25zdCBpbnN0YW5jZSA9IGNoaWxkLl9wcmVmYWIuaW5zdGFuY2U7XG4gICAgY29uc3QgcHJvcGVydHlQYXRoID0gJ19scG9zJztcbiAgICBsZXQgb3ZlcnJpZGUgPSBpbnN0YW5jZS5wcm9wZXJ0eU92ZXJyaWRlcy5maW5kKChpdGVtOiBhbnkpID0+XG4gICAgICAgIGl0ZW0udGFyZ2V0SW5mbz8ubG9jYWxJRD8ubGVuZ3RoID09PSAxICYmIGl0ZW0udGFyZ2V0SW5mby5sb2NhbElEWzBdID09PSBjaGlsZC5fcHJlZmFiLmZpbGVJZFxuICAgICAgICAmJiBpdGVtLnByb3BlcnR5UGF0aD8ubGVuZ3RoID09PSAxICYmIGl0ZW0ucHJvcGVydHlQYXRoWzBdID09PSBwcm9wZXJ0eVBhdGgpO1xuICAgIGlmICghb3ZlcnJpZGUpIHtcbiAgICAgICAgb3ZlcnJpZGUgPSBuZXcgdXRpbHMuUHJvcGVydHlPdmVycmlkZUluZm8oKTtcbiAgICAgICAgb3ZlcnJpZGUudGFyZ2V0SW5mbyA9IG5ldyB1dGlscy5UYXJnZXRJbmZvKCk7XG4gICAgICAgIG92ZXJyaWRlLnRhcmdldEluZm8ubG9jYWxJRCA9IFtjaGlsZC5fcHJlZmFiLmZpbGVJZF07XG4gICAgICAgIG92ZXJyaWRlLnByb3BlcnR5UGF0aCA9IFtwcm9wZXJ0eVBhdGhdO1xuICAgICAgICBpbnN0YW5jZS5wcm9wZXJ0eU92ZXJyaWRlcy5wdXNoKG92ZXJyaWRlKTtcbiAgICB9XG4gICAgb3ZlcnJpZGUudmFsdWUgPSBjaGlsZC5wb3NpdGlvbi5jbG9uZSgpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlUHJlZmFiUmVmZXJlbmNlKG5vZGU6IGFueSwgc3BlYzogUHJlZmFiQXNzZXRTcGVjLCBjYzogYW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFjYy5QcmVmYWI/Ll91dGlscz8uUHJvcGVydHlPdmVycmlkZUluZm8gfHwgIWNjLlByZWZhYj8uX3V0aWxzPy5UYXJnZXRJbmZvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgUHJlZmFiIOWxnuaAp+imhuebliBBUEkg5LiN5Y+v55So77yM5peg5rOV5L+d5a2Y5bWM5aWX5byV55So44CCJyk7XG4gICAgfVxuICAgIGxldCBjaGlsZCA9IHJlZmVyZW5jZWRQcmVmYWJDaGlsZChub2RlKTtcbiAgICBpZiAoY2hpbGQgJiYgbm9kZS5fX2VkaXRvckV4dHJhc19fW1JFQ09SRF0udXVpZCAhPT0gc3BlYy51dWlkKSB7XG4gICAgICAgIGFzc2VydFJlZmVyZW5jZVJlbW92YWJsZShub2RlKTtcbiAgICAgICAgY2hpbGQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIWNoaWxkKSB7XG4gICAgICAgIGNvbnN0IGFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlPy5QcmVmYWI7XG4gICAgICAgIGlmICghYXBpPy5jcmVhdGVOb2RlRnJvbVByZWZhYkFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIOW1jOWllyBQcmVmYWIg5Yib5bu6IEFQSSDkuI3lj6/nlKjjgIInKTtcbiAgICAgICAgY29uc3QgYXNzZXQ6IGFueSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+XG4gICAgICAgICAgICBjYy5hc3NldE1hbmFnZXIubG9hZEFueSh7IHV1aWQ6IHNwZWMudXVpZCB9LCAoZXJyb3I6IEVycm9yIHwgbnVsbCwgcmVzdWx0OiBhbnkpID0+XG4gICAgICAgICAgICAgICAgZXJyb3IgPyByZWplY3QoZXJyb3IpIDogcmVzb2x2ZShyZXN1bHQpKSk7XG4gICAgICAgIGlmICghKGFzc2V0IGluc3RhbmNlb2YgY2MuUHJlZmFiKSkgdGhyb3cgbmV3IEVycm9yKGDotYTmupDkuI3mmK8gUHJlZmFi77yaJHtzcGVjLnVybH1gKTtcbiAgICAgICAgY29uc3Qgc2l6ZSA9IGFzc2V0LmRhdGE/LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk/LmNvbnRlbnRTaXplO1xuICAgICAgICBpZiAoIXNpemUgfHwgIXNhbWVQcmVmYWJTaXplKHNwZWMud2lkdGgsIHNwZWMuaGVpZ2h0LCBzaXplKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bC65a+45bey5Y+Y5YyW77yM6K+36YeN5paw5a+85YWl77yaJHtzcGVjLnVybH1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjcmVhdGVkID0gYXBpLmNyZWF0ZU5vZGVGcm9tUHJlZmFiQXNzZXQoYXNzZXQpO1xuICAgICAgICBjb25zdCBjcmVhdGVkVXVpZCA9IGNyZWF0ZWQ/Ll9wcmVmYWI/LmFzc2V0Py5fdXVpZCA/PyBjcmVhdGVkPy5fcHJlZmFiPy5hc3NldD8udXVpZDtcbiAgICAgICAgaWYgKCFjcmVhdGVkPy5fcHJlZmFiPy5pbnN0YW5jZT8uZmlsZUlkIHx8IGNyZWF0ZWRVdWlkICE9PSBzcGVjLnV1aWRcbiAgICAgICAgICAgIHx8ICFjcmVhdGVkLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSkpIHtcbiAgICAgICAgICAgIGNyZWF0ZWQ/LmRlc3Ryb3koKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5pyq6IO95Yib5bu65bim6LWE5rqQ5YWz6IGU55qEIFByZWZhYiDlrp7kvovvvJoke3NwZWMudXJsfWApO1xuICAgICAgICB9XG4gICAgICAgIC8vIExvYWQgYW5kIHZhbGlkYXRlIHRoZSByZXBsYWNlbWVudCBiZWZvcmUgcmVtb3ZpbmcgdGhlIHByZXZpb3VzIG9uZS5cbiAgICAgICAgcmVtb3ZlUHJlZmFiUmVmZXJlbmNlKG5vZGUpO1xuICAgICAgICBjaGlsZCA9IGNyZWF0ZWQ7XG4gICAgICAgIG5vZGUuYWRkQ2hpbGQoY2hpbGQpO1xuICAgICAgICBub2RlLl9fZWRpdG9yRXh0cmFzX18gPz89IHt9O1xuICAgICAgICBub2RlLl9fZWRpdG9yRXh0cmFzX19bUkVDT1JEXSA9IHsgdXVpZDogc3BlYy51dWlkLCBpbnN0YW5jZUlkOiBjaGlsZC5fcHJlZmFiLmluc3RhbmNlLmZpbGVJZCB9O1xuICAgIH1cbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBjaGlsZC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xuICAgIGNoaWxkLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKFxuICAgICAgICAodHJhbnNmb3JtLmFuY2hvclBvaW50LnggLSAwLjUpICogc3BlYy53aWR0aCxcbiAgICAgICAgKHRyYW5zZm9ybS5hbmNob3JQb2ludC55IC0gMC41KSAqIHNwZWMuaGVpZ2h0LCAwLFxuICAgICkpO1xuICAgIHJlY29yZFBvc2l0aW9uKGNoaWxkLCBjYyk7XG59XG4iXX0=