"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewManagedComponentIds = reviewManagedComponentIds;
exports.captureReviewScene = captureReviewScene;
exports.registerSceneReview = registerSceneReview;
exports.prepareReviewRemoval = prepareReviewRemoval;
exports.finishReviewRemoval = finishReviewRemoval;
exports.refreshReviewAfter = refreshReviewAfter;
const import_review_model_1 = require("./import-review-model");
const uuid_1 = require("./roundtrip/uuid");
const prefab_instance_1 = require("./prefab-instance");
function walk(root, visit, depth = 0) {
    var _a;
    if (!root)
        return;
    visit(root, depth);
    for (const child of (_a = root.children) !== null && _a !== void 0 ? _a : [])
        walk(child, visit, depth + 1);
}
function components(node) { var _a, _b; return (_b = (_a = node.components) !== null && _a !== void 0 ? _a : node._components) !== null && _b !== void 0 ? _b : []; }
function nodeId(node, root) {
    var _a;
    return (0, prefab_instance_1.prefabScopedId)(node, root, ((_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.fileId) || (node === null || node === void 0 ? void 0 : node.uuid) || '');
}
function componentId(component, index, root) {
    var _a, _b;
    return (0, prefab_instance_1.prefabScopedId)(component.node, root, ((_a = component.__prefab) === null || _a === void 0 ? void 0 : _a.fileId) || component.uuid || `${index}:${(_b = component.constructor) === null || _b === void 0 ? void 0 : _b.name}`);
}
function assetId(asset) { return (asset === null || asset === void 0 ? void 0 : asset._uuid) || (asset === null || asset === void 0 ? void 0 : asset.uuid) || null; }
function instanceOf(component, Class) {
    return typeof Class === 'function' && component instanceof Class;
}
function recordColor(properties, component, key) {
    // Getters may have side effects. Read each supported color exactly once.
    const color = component[key];
    if (color)
        properties[key] = ['r', 'g', 'b', 'a'].map((channel) => color[channel]).join(',');
}
function reviewManagedComponentIds(root, nodeMap, classes) {
    const mapped = new Set(Object.values(nodeMap));
    const ids = [];
    walk(root, (node) => {
        if ((0, prefab_instance_1.isInsideNestedPrefab)(node, root))
            return;
        if (!mapped.has(node.uuid) && !/^__Figma(?:OverflowVisual|TiledMask|TiledSprite)$/.test(node.name))
            return;
        components(node).forEach((component, index) => {
            if (classes.some((Class) => Class && component instanceof Class))
                ids.push(componentId(component, index, root));
        });
    });
    return ids;
}
const number = (value, fallback = 0) => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : fallback;
function captureReviewScene(root, cc, nodeMap = {}, managedIds = []) {
    var _a, _b, _c, _d, _e, _f, _g;
    const facade = (_a = globalThis.cce) === null || _a === void 0 ? void 0 : _a.SceneFacadeManager;
    const mapped = new Map();
    for (const [id, uuid] of Object.entries(nodeMap)) {
        if (id === '__root__')
            continue;
        mapped.set(uuid, [...((_b = mapped.get(uuid)) !== null && _b !== void 0 ? _b : []), id]);
    }
    const managed = new Set(managedIds);
    const nodes = [];
    walk(root, (node, depth) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const nested = (0, prefab_instance_1.isInsideNestedPrefab)(node, root);
        const ui = node.getComponent(cc.UITransform);
        const rotation = (_a = node.eulerAngles) !== null && _a !== void 0 ? _a : node.euler;
        const recorded = components(node).map((component, index) => {
            var _a, _b, _c;
            const type = ((_b = (_a = cc.js) === null || _a === void 0 ? void 0 : _a.getClassName) === null || _b === void 0 ? void 0 : _b.call(_a, component)) || ((_c = component.constructor) === null || _c === void 0 ? void 0 : _c.name) || 'Component';
            const id = componentId(component, index, root);
            const properties = { enabled: component.enabled !== false };
            if (instanceOf(component, cc.Mask)) {
                // Creator >=3.6 separates Mask rules from its Sprite/Graphics.
                // Legacy Mask.color warns even on reads; do not probe legacy
                // renderer properties (including Mask.spriteFrame) at all.
                properties.type = number(component.type);
                properties.inverted = Boolean(component.inverted);
                properties.alphaThreshold = number(component.alphaThreshold);
                properties.segments = number(component.segments);
                const renderer = component.subComp;
                if (instanceOf(renderer, cc.Sprite))
                    properties.spriteFrame = assetId(renderer.spriteFrame);
                return { id, type, managed: !nested && managed.has(id), properties };
            }
            for (const key of ['string', 'fontSize', 'lineHeight', 'overflow', 'type', 'sizeMode', 'opacity',
                'horizontal', 'vertical', 'inverted', 'spacingX', 'spacingY', 'paddingLeft', 'paddingRight',
                'paddingTop', 'paddingBottom', 'resizeMode', 'transition', 'enableOutline', 'outlineWidth']) {
                const value = component[key];
                if (typeof value === 'number')
                    properties[key] = number(value);
                else if (typeof value === 'string' || typeof value === 'boolean')
                    properties[key] = value;
            }
            for (const key of ['spriteFrame', 'font', 'normalSprite', 'pressedSprite', 'hoverSprite', 'disabledSprite']) {
                if (key in component)
                    properties[key] = assetId(component[key]);
            }
            if ([cc.Sprite, cc.Label, cc.RichText, cc.Graphics].some((Class) => instanceOf(component, Class))) {
                recordColor(properties, component, 'color');
            }
            if (instanceOf(component, cc.Graphics)) {
                recordColor(properties, component, 'fillColor');
                recordColor(properties, component, 'strokeColor');
            }
            return { id, type, managed: !nested && managed.has(id), properties };
        });
        const prefabLink = (0, prefab_instance_1.nativePrefabIdentity)(node);
        nodes.push({
            id: nodeId(node, root), uuid: node.uuid, parentId: node === root ? null : nodeId(node.parent, root),
            name: node.name, depth, order: node === root ? 0 : node.parent.children.indexOf(node),
            active: node.active !== false,
            geometry: [(_b = node.position) === null || _b === void 0 ? void 0 : _b.x, (_c = node.position) === null || _c === void 0 ? void 0 : _c.y, (_d = node.position) === null || _d === void 0 ? void 0 : _d.z, ui === null || ui === void 0 ? void 0 : ui.width, ui === null || ui === void 0 ? void 0 : ui.height, rotation === null || rotation === void 0 ? void 0 : rotation.x, rotation === null || rotation === void 0 ? void 0 : rotation.y, rotation === null || rotation === void 0 ? void 0 : rotation.z, (_f = (_e = node.scale) === null || _e === void 0 ? void 0 : _e.x) !== null && _f !== void 0 ? _f : 1, (_h = (_g = node.scale) === null || _g === void 0 ? void 0 : _g.y) !== null && _h !== void 0 ? _h : 1, (_k = (_j = ui === null || ui === void 0 ? void 0 : ui.anchorPoint) === null || _j === void 0 ? void 0 : _j.x) !== null && _k !== void 0 ? _k : 0.5, (_m = (_l = ui === null || ui === void 0 ? void 0 : ui.anchorPoint) === null || _l === void 0 ? void 0 : _l.y) !== null && _m !== void 0 ? _m : 0.5].map((value) => number(value)),
            components: recorded, figmaIds: (_o = mapped.get(node.uuid)) !== null && _o !== void 0 ? _o : [],
            ...(prefabLink ? { prefab: prefabLink } : {}),
        });
    });
    return { rootUuid: (_c = root === null || root === void 0 ? void 0 : root.uuid) !== null && _c !== void 0 ? _c : '', targetUuid: String((_e = (_d = facade === null || facade === void 0 ? void 0 : facade.queryCurrentSceneUuid) === null || _d === void 0 ? void 0 : _d.call(facade)) !== null && _e !== void 0 ? _e : ''),
        mode: String((_g = (_f = facade === null || facade === void 0 ? void 0 : facade.queryMode) === null || _f === void 0 ? void 0 : _f.call(facade)) !== null && _g !== void 0 ? _g : 'scene'), nodes };
}
const sessions = new Map();
function registerSceneReview(id, root, cc, nodeMap, managedIds, expectedTarget) {
    const after = captureReviewScene(root, cc, nodeMap, managedIds);
    // Prefab import already verified this identity before writing. Facade queries
    // can still expose the previous target while Creator finishes opening it.
    if (expectedTarget)
        Object.assign(after, expectedTarget);
    sessions.clear();
    sessions.set(id, { root, scene: cc.director.getScene(), cc, nodeMap, managedIds, after });
    return after;
}
function sessionFor(id) {
    const session = sessions.get(id);
    if (!session || session.cc.director.getScene() !== session.scene)
        throw new Error('检查结果已过期，请重新导入。');
    if (session.cc.isValid && !session.cc.isValid(session.root, true))
        throw new Error('原导入节点已失效，请重新导入。');
    const current = captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
    if ((0, import_review_model_1.reviewFingerprint)(current) !== (0, import_review_model_1.reviewFingerprint)(session.after)) {
        throw new Error('节点或编辑目标在导入后发生变化，请重新导入生成新的对比结果。');
    }
    return session;
}
/** Discover custom component/array references as well as ordinary Sprite slots. */
function containsAsset(value, ids, cc, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value))
        return false;
    const uuid = assetId(value);
    if (uuid && ids.has((0, uuid_1.normalizeCocosUuid)(uuid)))
        return true;
    if (value instanceof cc.Node || (cc.Component && value instanceof cc.Component)
        || (cc.Asset && value instanceof cc.Asset))
        return false;
    seen.add(value);
    return Object.values(value).some((child) => containsAsset(child, ids, cc, seen));
}
function clearFrame(component, value, cc) {
    const ui = component.node.getComponent(cc.UITransform);
    const width = ui === null || ui === void 0 ? void 0 : ui.width;
    const height = ui === null || ui === void 0 ? void 0 : ui.height;
    component.spriteFrame = value;
    if (ui)
        ui.setContentSize(width, height);
}
function prepareReviewRemoval(payload) {
    const session = sessionFor(payload.id);
    if (session.detached)
        throw new Error('资源清理正在执行。');
    const ids = new Set(payload.uuids.map(uuid_1.normalizeCocosUuid));
    const snapshotNodes = new Map(session.after.nodes.map((node) => [node.uuid, node]));
    const allowed = new Set();
    const slots = [];
    walk(session.root, (node) => {
        components(node).forEach((component, index) => {
            var _a;
            const snapshot = snapshotNodes.get(node.uuid);
            const recorded = snapshot === null || snapshot === void 0 ? void 0 : snapshot.components.find((item) => item.id === componentId(component, index, session.root));
            if (component instanceof session.cc.Sprite && (recorded === null || recorded === void 0 ? void 0 : recorded.managed)
                && ids.has((0, uuid_1.normalizeCocosUuid)((_a = assetId(component.spriteFrame)) !== null && _a !== void 0 ? _a : ''))) {
                allowed.add(component);
                slots.push({ component, asset: component.spriteFrame });
            }
        });
    });
    // Include inactive nodes and nodes outside the imported root.
    const inspected = new Set();
    const inspectNode = (node) => {
        var _a, _b, _c, _d;
        if (inspected.has(node))
            return;
        inspected.add(node);
        for (const component of components(node)) {
            const declared = (_a = component.constructor) === null || _a === void 0 ? void 0 : _a.__props__;
            const attributes = (_d = (_c = (_b = session.cc.js) === null || _b === void 0 ? void 0 : _b.getClassAttrs) === null || _c === void 0 ? void 0 : _c.call(_b, component.constructor)) !== null && _d !== void 0 ? _d : {};
            const keys = Array.isArray(declared) ? declared : Object.keys(component);
            for (const key of keys) {
                if (attributes[`${key}$_$serializable`] === false)
                    continue;
                if (['node', '_node', '__prefab'].includes(key))
                    continue;
                if (allowed.has(component) && ['_spriteFrame', 'spriteFrame'].includes(key))
                    continue;
                if (containsAsset(component[key], ids, session.cc)) {
                    throw new Error(`资源还被节点“${node.name}”的其他组件或属性引用，已停止删除。`);
                }
            }
        }
    };
    walk(session.scene, inspectNode);
    walk(session.root, inspectNode);
    if (payload.detach) {
        session.detached = [];
        try {
            for (const slot of slots) {
                session.detached.push(slot);
                clearFrame(slot.component, null, session.cc);
            }
        }
        catch (error) {
            for (const slot of session.detached)
                clearFrame(slot.component, slot.asset, session.cc);
            session.detached = undefined;
            throw error;
        }
    }
    return captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
}
function finishReviewRemoval(payload) {
    var _a;
    const session = sessions.get(payload.id);
    if (!session || session.cc.director.getScene() !== session.scene)
        throw new Error('编辑目标已切换，无法完成资源清理。');
    if (payload.restore)
        for (const slot of (_a = session.detached) !== null && _a !== void 0 ? _a : [])
            clearFrame(slot.component, slot.asset, session.cc);
    session.detached = undefined;
    session.after = captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
    return session.after;
}
/** Called only by the main import flow after Creator's save/serialization has completed. */
function refreshReviewAfter(payload) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const session = sessions.get(payload.id);
    if (!session)
        throw new Error('导入检查会话已失效。');
    const facade = (_a = globalThis.cce) === null || _a === void 0 ? void 0 : _a.SceneFacadeManager;
    const targetUuid = String((_c = (_b = facade === null || facade === void 0 ? void 0 : facade.queryCurrentSceneUuid) === null || _b === void 0 ? void 0 : _b.call(facade)) !== null && _c !== void 0 ? _c : '');
    const mode = String((_e = (_d = facade === null || facade === void 0 ? void 0 : facade.queryMode) === null || _d === void 0 ? void 0 : _d.call(facade)) !== null && _e !== void 0 ? _e : 'scene');
    if ((0, uuid_1.normalizeCocosUuid)(targetUuid) !== (0, uuid_1.normalizeCocosUuid)(session.after.targetUuid) || mode !== session.after.mode) {
        throw new Error(`导入编辑目标尚未稳定或已切换（预期 ${session.after.mode}:${session.after.targetUuid || '未保存'}，当前 ${mode}:${targetUuid || '未保存'}）。`);
    }
    const scene = session.cc.director.getScene();
    let root = session.root;
    let nodeMap = session.nodeMap;
    if (scene !== session.scene || (session.cc.isValid && !session.cc.isValid(root, true))) {
        const candidate = (_g = (_f = globalThis.cce) === null || _f === void 0 ? void 0 : _f.Scene) === null || _g === void 0 ? void 0 : _g.rootNode;
        const fileId = (_h = root === null || root === void 0 ? void 0 : root._prefab) === null || _h === void 0 ? void 0 : _h.fileId;
        if (mode !== 'prefab' || !targetUuid || !fileId || ((_j = candidate === null || candidate === void 0 ? void 0 : candidate._prefab) === null || _j === void 0 ? void 0 : _j.fileId) !== fileId) {
            throw new Error('保存后无法核实原导入根节点。');
        }
        const nodes = new Map();
        walk(candidate, (node) => {
            const id = nodeId(node, candidate);
            if (nodes.has(id))
                throw new Error('保存后节点标识重复，无法安全恢复检查。');
            nodes.set(id, node);
        });
        nodeMap = {};
        for (const previous of session.after.nodes) {
            const current = nodes.get(previous.id);
            if (!current)
                throw new Error('保存后节点结构已改变。');
            for (const id of previous.figmaIds)
                nodeMap[id] = current.uuid;
        }
        root = candidate;
    }
    const after = captureReviewScene(root, session.cc, nodeMap, session.managedIds);
    const comparison = (0, import_review_model_1.compareSavedReviewScene)(session.after, after);
    if (comparison.issues.length) {
        throw new Error(`保存后节点或组件内容已变化，当前结果不能用于资源清理。具体差异：${comparison.issues.join('；')}`);
    }
    // Geometry changes do not change ownership or resource consumers. Adopt actual saved values;
    // do not write them back to the scene. Subsequent cleanup still uses the strict fingerprint.
    if (comparison.adjustments.count)
        after.saveAdjustments = comparison.adjustments;
    session.scene = scene;
    session.root = root;
    session.nodeMap = nodeMap;
    session.after = after;
    return after;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXJldmlldy1zY2VuZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9pbXBvcnQtcmV2aWV3LXNjZW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBMkJBLDhEQVdDO0FBR0QsZ0RBbUVDO0FBYUQsa0RBU0M7QUFnQ0Qsb0RBcURDO0FBRUQsa0RBT0M7QUFHRCxnREE2Q0M7QUFoUkQsK0RBQTRJO0FBQzVJLDJDQUFzRDtBQUN0RCx1REFBK0Y7QUFFL0YsU0FBUyxJQUFJLENBQUMsSUFBUyxFQUFFLEtBQXlDLEVBQUUsS0FBSyxHQUFHLENBQUM7O0lBQ3pFLElBQUksQ0FBQyxJQUFJO1FBQUUsT0FBTztJQUNsQixLQUFLLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ25CLEtBQUssTUFBTSxLQUFLLElBQUksTUFBQSxJQUFJLENBQUMsUUFBUSxtQ0FBSSxFQUFFO1FBQUUsSUFBSSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzNFLENBQUM7QUFFRCxTQUFTLFVBQVUsQ0FBQyxJQUFTLGdCQUFXLE9BQU8sTUFBQSxNQUFBLElBQUksQ0FBQyxVQUFVLG1DQUFJLElBQUksQ0FBQyxXQUFXLG1DQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDM0YsU0FBUyxNQUFNLENBQUMsSUFBUyxFQUFFLElBQVM7O0lBQ2hDLE9BQU8sSUFBQSxnQ0FBYyxFQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQSxNQUFBLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxPQUFPLDBDQUFFLE1BQU0sTUFBSSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsSUFBSSxDQUFBLElBQUksRUFBRSxDQUFDLENBQUM7QUFDakYsQ0FBQztBQUNELFNBQVMsV0FBVyxDQUFDLFNBQWMsRUFBRSxLQUFhLEVBQUUsSUFBUzs7SUFDekQsT0FBTyxJQUFBLGdDQUFjLEVBQUMs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SUFDakYsT0FBTyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7SUFDdEIsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFJLENBQUM7SUFDcEIsT0FBTyxDQUFDLE9BQU8sR0FBRyxPQUFPLENBQUM7SUFDMUIsT0FBTyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7SUFDdEIsT0FBTyxLQUFLLENBQUM7QUFDakIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGNvbXBhcmVTYXZlZFJldmlld1NjZW5lLCByZXZpZXdGaW5nZXJwcmludCwgdHlwZSBSZXZpZXdDb21wb25lbnQsIHR5cGUgUmV2aWV3Tm9kZSwgdHlwZSBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IG5vcm1hbGl6ZUNvY29zVXVpZCB9IGZyb20gJy4vcm91bmR0cmlwL3V1aWQnO1xyXG5pbXBvcnQgeyBpc0luc2lkZU5lc3RlZFByZWZhYiwgbmF0aXZlUHJlZmFiSWRlbnRpdHksIHByZWZhYlNjb3BlZElkIH0gZnJvbSAnLi9wcmVmYWItaW5zdGFuY2UnO1xyXG5cclxuZnVuY3Rpb24gd2Fsayhyb290OiBhbnksIHZpc2l0OiAobm9kZTogYW55LCBkZXB0aDogbnVtYmVyKSA9PiB2b2lkLCBkZXB0aCA9IDApOiB2b2lkIHtcclxuICAgIGlmICghcm9vdCkgcmV0dXJuO1xyXG4gICAgdmlzaXQocm9vdCwgZGVwdGgpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuID8/IFtdKSB3YWxrKGNoaWxkLCB2aXNpdCwgZGVwdGggKyAxKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7IHJldHVybiBub2RlLmNvbXBvbmVudHMgPz8gbm9kZS5fY29tcG9uZW50cyA/PyBbXTsgfVxyXG5mdW5jdGlvbiBub2RlSWQobm9kZTogYW55LCByb290OiBhbnkpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHByZWZhYlNjb3BlZElkKG5vZGUsIHJvb3QsIG5vZGU/Ll9wcmVmYWI/LmZpbGVJZCB8fCBub2RlPy51dWlkIHx8ICcnKTtcclxufVxyXG5mdW5jdGlvbiBjb21wb25lbnRJZChjb21wb25lbnQ6IGFueSwgaW5kZXg6IG51bWJlciwgcm9vdDogYW55KTogc3RyaW5nIHtcclxuICAgIHJldHVybiBwcmVmYWJTY29wZWRJZChjb21wb25lbnQubm9kZSwgcm9vdCxcclxuICAgICAgICBjb21wb25lbnQuX19wcmVmYWI/LmZpbGVJZCB8fCBjb21wb25lbnQudXVpZCB8fCBgJHtpbmRleH06JHtjb21wb25lbnQuY29uc3RydWN0b3I/Lm5hbWV9YCk7XHJcbn1cclxuZnVuY3Rpb24gYXNzZXRJZChhc3NldDogYW55KTogc3RyaW5nIHwgbnVsbCB7IHJldHVybiBhc3NldD8uX3V1aWQgfHwgYXNzZXQ/LnV1aWQgfHwgbnVsbDsgfVxyXG5mdW5jdGlvbiBpbnN0YW5jZU9mKGNvbXBvbmVudDogYW55LCBDbGFzczogYW55KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdHlwZW9mIENsYXNzID09PSAnZnVuY3Rpb24nICYmIGNvbXBvbmVudCBpbnN0YW5jZW9mIENsYXNzO1xyXG59XHJcbmZ1bmN0aW9uIHJlY29yZENvbG9yKHByb3BlcnRpZXM6IFJldmlld0NvbXBvbmVudFsncHJvcGVydGllcyddLCBjb21wb25lbnQ6IGFueSwga2V5OiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIC8vIEdldHRlcnMgbWF5IGhhdmUgc2lkZSBlZmZlY3RzLiBSZWFkIGVhY2ggc3VwcG9ydGVkIGNvbG9yIGV4YWN0bHkgb25jZS5cclxuICAgIGNvbnN0IGNvbG9yID0gY29tcG9uZW50W2tleV07XHJcbiAgICBpZiAoY29sb3IpIHByb3BlcnRpZXNba2V5XSA9IFsncicsICdnJywgJ2InLCAnYSddLm1hcCgoY2hhbm5lbCkgPT4gY29sb3JbY2hhbm5lbF0pLmpvaW4oJywnKTtcclxufVxyXG5leHBvcnQgZnVuY3Rpb24gcmV2aWV3TWFuYWdlZENvbXBvbmVudElkcyhyb290OiBhbnksIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sIGNsYXNzZXM6IGFueVtdKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgbWFwcGVkID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcclxuICAgIHdhbGsocm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBpZiAoaXNJbnNpZGVOZXN0ZWRQcmVmYWIobm9kZSwgcm9vdCkpIHJldHVybjtcclxuICAgICAgICBpZiAoIW1hcHBlZC5oYXMobm9kZS51dWlkKSAmJiAhL15fX0ZpZ21hKD86T3ZlcmZsb3dWaXN1YWx8VGlsZWRNYXNrfFRpbGVkU3ByaXRlKSQvLnRlc3Qobm9kZS5uYW1lKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50LCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoY2xhc3Nlcy5zb21lKChDbGFzcykgPT4gQ2xhc3MgJiYgY29tcG9uZW50IGluc3RhbmNlb2YgQ2xhc3MpKSBpZHMucHVzaChjb21wb25lbnRJZChjb21wb25lbnQsIGluZGV4LCByb290KSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIHJldHVybiBpZHM7XHJcbn1cclxuY29uc3QgbnVtYmVyID0gKHZhbHVlOiBhbnksIGZhbGxiYWNrID0gMCkgPT4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgucm91bmQodmFsdWUgKiAxMDAwMCkgLyAxMDAwMCA6IGZhbGxiYWNrO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNhcHR1cmVSZXZpZXdTY2VuZShcclxuICAgIHJvb3Q6IGFueSxcclxuICAgIGNjOiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30sXHJcbiAgICBtYW5hZ2VkSWRzOiBzdHJpbmdbXSA9IFtdLFxyXG4pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBmYWNhZGUgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZT8uU2NlbmVGYWNhZGVNYW5hZ2VyO1xyXG4gICAgY29uc3QgbWFwcGVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgaWYgKGlkID09PSAnX19yb290X18nKSBjb250aW51ZTtcclxuICAgICAgICBtYXBwZWQuc2V0KHV1aWQsIFsuLi4obWFwcGVkLmdldCh1dWlkKSA/PyBbXSksIGlkXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBtYW5hZ2VkID0gbmV3IFNldChtYW5hZ2VkSWRzKTtcclxuICAgIGNvbnN0IG5vZGVzOiBSZXZpZXdOb2RlW10gPSBbXTtcclxuICAgIHdhbGsocm9vdCwgKG5vZGUsIGRlcHRoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgbmVzdGVkID0gaXNJbnNpZGVOZXN0ZWRQcmVmYWIobm9kZSwgcm9vdCk7XHJcbiAgICAgICAgY29uc3QgdWkgPSBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgY29uc3Qgcm90YXRpb24gPSBub2RlLmV1bGVyQW5nbGVzID8/IG5vZGUuZXVsZXI7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkZWQ6IFJldmlld0NvbXBvbmVudFtdID0gY29tcG9uZW50cyhub2RlKS5tYXAoKGNvbXBvbmVudCwgaW5kZXgpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGNjLmpzPy5nZXRDbGFzc05hbWU/Lihjb21wb25lbnQpIHx8IGNvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSB8fCAnQ29tcG9uZW50JztcclxuICAgICAgICAgICAgY29uc3QgaWQgPSBjb21wb25lbnRJZChjb21wb25lbnQsIGluZGV4LCByb290KTtcclxuICAgICAgICAgICAgY29uc3QgcHJvcGVydGllczogUmV2aWV3Q29tcG9uZW50Wydwcm9wZXJ0aWVzJ10gPSB7IGVuYWJsZWQ6IGNvbXBvbmVudC5lbmFibGVkICE9PSBmYWxzZSB9O1xyXG4gICAgICAgICAgICBpZiAoaW5zdGFuY2VPZihjb21wb25lbnQsIGNjLk1hc2spKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBDcmVhdG9yID49My42IHNlcGFyYXRlcyBNYXNrIHJ1bGVzIGZyb20gaXRzIFNwcml0ZS9HcmFwaGljcy5cclxuICAgICAgICAgICAgICAgIC8vIExlZ2FjeSBNYXNrLmNvbG9yIHdhcm5zIGV2ZW4gb24gcmVhZHM7IGRvIG5vdCBwcm9iZSBsZWdhY3lcclxuICAgICAgICAgICAgICAgIC8vIHJlbmRlcmVyIHByb3BlcnRpZXMgKGluY2x1ZGluZyBNYXNrLnNwcml0ZUZyYW1lKSBhdCBhbGwuXHJcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzLnR5cGUgPSBudW1iZXIoY29tcG9uZW50LnR5cGUpO1xyXG4gICAgICAgICAgICAgICAgcHJvcGVydGllcy5pbnZlcnRlZCA9IEJvb2xlYW4oY29tcG9uZW50LmludmVydGVkKTtcclxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXMuYWxwaGFUaHJlc2hvbGQgPSBudW1iZXIoY29tcG9uZW50LmFscGhhVGhyZXNob2xkKTtcclxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXMuc2VnbWVudHMgPSBudW1iZXIoY29tcG9uZW50LnNlZ21lbnRzKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbmRlcmVyID0gY29tcG9uZW50LnN1YkNvbXA7XHJcbiAgICAgICAgICAgICAgICBpZiAoaW5zdGFuY2VPZihyZW5kZXJlciwgY2MuU3ByaXRlKSkgcHJvcGVydGllcy5zcHJpdGVGcmFtZSA9IGFzc2V0SWQocmVuZGVyZXIuc3ByaXRlRnJhbWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgaWQsIHR5cGUsIG1hbmFnZWQ6ICFuZXN0ZWQgJiYgbWFuYWdlZC5oYXMoaWQpLCBwcm9wZXJ0aWVzIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgWydzdHJpbmcnLCAnZm9udFNpemUnLCAnbGluZUhlaWdodCcsICdvdmVyZmxvdycsICd0eXBlJywgJ3NpemVNb2RlJywgJ29wYWNpdHknLFxyXG4gICAgICAgICAgICAgICAgJ2hvcml6b250YWwnLCAndmVydGljYWwnLCAnaW52ZXJ0ZWQnLCAnc3BhY2luZ1gnLCAnc3BhY2luZ1knLCAncGFkZGluZ0xlZnQnLCAncGFkZGluZ1JpZ2h0JyxcclxuICAgICAgICAgICAgICAgICdwYWRkaW5nVG9wJywgJ3BhZGRpbmdCb3R0b20nLCAncmVzaXplTW9kZScsICd0cmFuc2l0aW9uJywgJ2VuYWJsZU91dGxpbmUnLCAnb3V0bGluZVdpZHRoJ10pIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gY29tcG9uZW50W2tleV07XHJcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykgcHJvcGVydGllc1trZXldID0gbnVtYmVyKHZhbHVlKTtcclxuICAgICAgICAgICAgICAgIGVsc2UgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpIHByb3BlcnRpZXNba2V5XSA9IHZhbHVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsnc3ByaXRlRnJhbWUnLCAnZm9udCcsICdub3JtYWxTcHJpdGUnLCAncHJlc3NlZFNwcml0ZScsICdob3ZlclNwcml0ZScsICdkaXNhYmxlZFNwcml0ZSddKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoa2V5IGluIGNvbXBvbmVudCkgcHJvcGVydGllc1trZXldID0gYXNzZXRJZChjb21wb25lbnRba2V5XSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKFtjYy5TcHJpdGUsIGNjLkxhYmVsLCBjYy5SaWNoVGV4dCwgY2MuR3JhcGhpY3NdLnNvbWUoKENsYXNzKSA9PiBpbnN0YW5jZU9mKGNvbXBvbmVudCwgQ2xhc3MpKSkge1xyXG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnY29sb3InKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoaW5zdGFuY2VPZihjb21wb25lbnQsIGNjLkdyYXBoaWNzKSkge1xyXG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnZmlsbENvbG9yJyk7XHJcbiAgICAgICAgICAgICAgICByZWNvcmRDb2xvcihwcm9wZXJ0aWVzLCBjb21wb25lbnQsICdzdHJva2VDb2xvcicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB7IGlkLCB0eXBlLCBtYW5hZ2VkOiAhbmVzdGVkICYmIG1hbmFnZWQuaGFzKGlkKSwgcHJvcGVydGllcyB9O1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IHByZWZhYkxpbmsgPSBuYXRpdmVQcmVmYWJJZGVudGl0eShub2RlKTtcclxuICAgICAgICBub2Rlcy5wdXNoKHtcclxuICAgICAgICAgICAgaWQ6IG5vZGVJZChub2RlLCByb290KSwgdXVpZDogbm9kZS51dWlkLCBwYXJlbnRJZDogbm9kZSA9PT0gcm9vdCA/IG51bGwgOiBub2RlSWQobm9kZS5wYXJlbnQsIHJvb3QpLFxyXG4gICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsIGRlcHRoLCBvcmRlcjogbm9kZSA9PT0gcm9vdCA/IDAgOiBub2RlLnBhcmVudC5jaGlsZHJlbi5pbmRleE9mKG5vZGUpLFxyXG4gICAgICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlICE9PSBmYWxzZSxcclxuICAgICAgICAgICAgZ2VvbWV0cnk6IFtub2RlLnBvc2l0aW9uPy54LCBub2RlLnBvc2l0aW9uPy55LCBub2RlLnBvc2l0aW9uPy56LCB1aT8ud2lkdGgsIHVpPy5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICByb3RhdGlvbj8ueCwgcm90YXRpb24/LnksIHJvdGF0aW9uPy56LCBub2RlLnNjYWxlPy54ID8/IDEsIG5vZGUuc2NhbGU/LnkgPz8gMSxcclxuICAgICAgICAgICAgICAgIHVpPy5hbmNob3JQb2ludD8ueCA/PyAwLjUsIHVpPy5hbmNob3JQb2ludD8ueSA/PyAwLjVdLm1hcCgodmFsdWUpID0+IG51bWJlcih2YWx1ZSkpLFxyXG4gICAgICAgICAgICBjb21wb25lbnRzOiByZWNvcmRlZCwgZmlnbWFJZHM6IG1hcHBlZC5nZXQobm9kZS51dWlkKSA/PyBbXSxcclxuICAgICAgICAgICAgLi4uKHByZWZhYkxpbmsgPyB7IHByZWZhYjogcHJlZmFiTGluayB9IDoge30pLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgICByZXR1cm4geyByb290VXVpZDogcm9vdD8udXVpZCA/PyAnJywgdGFyZ2V0VXVpZDogU3RyaW5nKGZhY2FkZT8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyksXHJcbiAgICAgICAgbW9kZTogU3RyaW5nKGZhY2FkZT8ucXVlcnlNb2RlPy4oKSA/PyAnc2NlbmUnKSwgbm9kZXMgfTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lUmV2aWV3U2Vzc2lvbiB7XHJcbiAgICByb290OiBhbnk7XHJcbiAgICBzY2VuZTogYW55O1xyXG4gICAgY2M6IGFueTtcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBtYW5hZ2VkSWRzOiBzdHJpbmdbXTtcclxuICAgIGFmdGVyOiBSZXZpZXdTY2VuZTtcclxuICAgIGRldGFjaGVkPzogQXJyYXk8eyBjb21wb25lbnQ6IGFueTsgYXNzZXQ6IGFueSB9PjtcclxufVxyXG5jb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBTY2VuZVJldmlld1Nlc3Npb24+KCk7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTY2VuZVJldmlldyhpZDogc3RyaW5nLCByb290OiBhbnksIGNjOiBhbnksIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sIG1hbmFnZWRJZHM6IHN0cmluZ1tdLFxyXG4gICAgZXhwZWN0ZWRUYXJnZXQ/OiB7IHRhcmdldFV1aWQ6IHN0cmluZzsgbW9kZTogc3RyaW5nIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBhZnRlciA9IGNhcHR1cmVSZXZpZXdTY2VuZShyb290LCBjYywgbm9kZU1hcCwgbWFuYWdlZElkcyk7XHJcbiAgICAvLyBQcmVmYWIgaW1wb3J0IGFscmVhZHkgdmVyaWZpZWQgdGhpcyBpZGVudGl0eSBiZWZvcmUgd3JpdGluZy4gRmFjYWRlIHF1ZXJpZXNcclxuICAgIC8vIGNhbiBzdGlsbCBleHBvc2UgdGhlIHByZXZpb3VzIHRhcmdldCB3aGlsZSBDcmVhdG9yIGZpbmlzaGVzIG9wZW5pbmcgaXQuXHJcbiAgICBpZiAoZXhwZWN0ZWRUYXJnZXQpIE9iamVjdC5hc3NpZ24oYWZ0ZXIsIGV4cGVjdGVkVGFyZ2V0KTtcclxuICAgIHNlc3Npb25zLmNsZWFyKCk7XHJcbiAgICBzZXNzaW9ucy5zZXQoaWQsIHsgcm9vdCwgc2NlbmU6IGNjLmRpcmVjdG9yLmdldFNjZW5lKCksIGNjLCBub2RlTWFwLCBtYW5hZ2VkSWRzLCBhZnRlciB9KTtcclxuICAgIHJldHVybiBhZnRlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gc2Vzc2lvbkZvcihpZDogc3RyaW5nKTogU2NlbmVSZXZpZXdTZXNzaW9uIHtcclxuICAgIGNvbnN0IHNlc3Npb24gPSBzZXNzaW9ucy5nZXQoaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSAhPT0gc2Vzc2lvbi5zY2VuZSkgdGhyb3cgbmV3IEVycm9yKCfmo4Dmn6Xnu5Pmnpzlt7Lov4fmnJ/vvIzor7fph43mlrDlr7zlhaXjgIInKTtcclxuICAgIGlmIChzZXNzaW9uLmNjLmlzVmFsaWQgJiYgIXNlc3Npb24uY2MuaXNWYWxpZChzZXNzaW9uLnJvb3QsIHRydWUpKSB0aHJvdyBuZXcgRXJyb3IoJ+WOn+WvvOWFpeiKgueCueW3suWkseaViO+8jOivt+mHjeaWsOWvvOWFpeOAgicpO1xyXG4gICAgY29uc3QgY3VycmVudCA9IGNhcHR1cmVSZXZpZXdTY2VuZShzZXNzaW9uLnJvb3QsIHNlc3Npb24uY2MsIHNlc3Npb24ubm9kZU1hcCwgc2Vzc2lvbi5tYW5hZ2VkSWRzKTtcclxuICAgIGlmIChyZXZpZXdGaW5nZXJwcmludChjdXJyZW50KSAhPT0gcmV2aWV3RmluZ2VycHJpbnQoc2Vzc2lvbi5hZnRlcikpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+iKgueCueaIlue8lui+keebruagh+WcqOWvvOWFpeWQjuWPkeeUn+WPmOWMlu+8jOivt+mHjeaWsOWvvOWFpeeUn+aIkOaWsOeahOWvueavlOe7k+aenOOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbi8qKiBEaXNjb3ZlciBjdXN0b20gY29tcG9uZW50L2FycmF5IHJlZmVyZW5jZXMgYXMgd2VsbCBhcyBvcmRpbmFyeSBTcHJpdGUgc2xvdHMuICovXHJcbmZ1bmN0aW9uIGNvbnRhaW5zQXNzZXQodmFsdWU6IGFueSwgaWRzOiBTZXQ8c3RyaW5nPiwgY2M6IGFueSwgc2VlbiA9IG5ldyBTZXQ8YW55PigpKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gZmFsc2U7XHJcbiAgICBjb25zdCB1dWlkID0gYXNzZXRJZCh2YWx1ZSk7XHJcbiAgICBpZiAodXVpZCAmJiBpZHMuaGFzKG5vcm1hbGl6ZUNvY29zVXVpZCh1dWlkKSkpIHJldHVybiB0cnVlO1xyXG4gICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgY2MuTm9kZSB8fCAoY2MuQ29tcG9uZW50ICYmIHZhbHVlIGluc3RhbmNlb2YgY2MuQ29tcG9uZW50KVxyXG4gICAgICAgIHx8IChjYy5Bc3NldCAmJiB2YWx1ZSBpbnN0YW5jZW9mIGNjLkFzc2V0KSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgc2Vlbi5hZGQodmFsdWUpO1xyXG4gICAgcmV0dXJuIE9iamVjdC52YWx1ZXModmFsdWUpLnNvbWUoKGNoaWxkKSA9PiBjb250YWluc0Fzc2V0KGNoaWxkLCBpZHMsIGNjLCBzZWVuKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsZWFyRnJhbWUoY29tcG9uZW50OiBhbnksIHZhbHVlOiBhbnksIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHVpID0gY29tcG9uZW50Lm5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHdpZHRoID0gdWk/LndpZHRoO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gdWk/LmhlaWdodDtcclxuICAgIGNvbXBvbmVudC5zcHJpdGVGcmFtZSA9IHZhbHVlO1xyXG4gICAgaWYgKHVpKSB1aS5zZXRDb250ZW50U2l6ZSh3aWR0aCwgaGVpZ2h0KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVSZXZpZXdSZW1vdmFsKHBheWxvYWQ6IHsgaWQ6IHN0cmluZzsgdXVpZHM6IHN0cmluZ1tdOyBkZXRhY2g/OiBib29sZWFuIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkZvcihwYXlsb2FkLmlkKTtcclxuICAgIGlmIChzZXNzaW9uLmRldGFjaGVkKSB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOa4heeQhuato+WcqOaJp+ihjOOAgicpO1xyXG4gICAgY29uc3QgaWRzID0gbmV3IFNldChwYXlsb2FkLnV1aWRzLm1hcChub3JtYWxpemVDb2Nvc1V1aWQpKTtcclxuICAgIGNvbnN0IHNuYXBzaG90Tm9kZXMgPSBuZXcgTWFwKHNlc3Npb24uYWZ0ZXIubm9kZXMubWFwKChub2RlKSA9PiBbbm9kZS51dWlkLCBub2RlXSkpO1xyXG4gICAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQ8YW55PigpO1xyXG4gICAgY29uc3Qgc2xvdHM6IEFycmF5PHsgY29tcG9uZW50OiBhbnk7IGFzc2V0OiBhbnkgfT4gPSBbXTtcclxuICAgIHdhbGsoc2Vzc2lvbi5yb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50LCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBzbmFwc2hvdCA9IHNuYXBzaG90Tm9kZXMuZ2V0KG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZGVkID0gc25hcHNob3Q/LmNvbXBvbmVudHMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gY29tcG9uZW50SWQoY29tcG9uZW50LCBpbmRleCwgc2Vzc2lvbi5yb290KSk7XHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnQgaW5zdGFuY2VvZiBzZXNzaW9uLmNjLlNwcml0ZSAmJiByZWNvcmRlZD8ubWFuYWdlZFxyXG4gICAgICAgICAgICAgICAgJiYgaWRzLmhhcyhub3JtYWxpemVDb2Nvc1V1aWQoYXNzZXRJZChjb21wb25lbnQuc3ByaXRlRnJhbWUpID8/ICcnKSkpIHtcclxuICAgICAgICAgICAgICAgIGFsbG93ZWQuYWRkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBzbG90cy5wdXNoKHsgY29tcG9uZW50LCBhc3NldDogY29tcG9uZW50LnNwcml0ZUZyYW1lIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIC8vIEluY2x1ZGUgaW5hY3RpdmUgbm9kZXMgYW5kIG5vZGVzIG91dHNpZGUgdGhlIGltcG9ydGVkIHJvb3QuXHJcbiAgICBjb25zdCBpbnNwZWN0ZWQgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgIGNvbnN0IGluc3BlY3ROb2RlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGlmIChpbnNwZWN0ZWQuaGFzKG5vZGUpKSByZXR1cm47XHJcbiAgICAgICAgaW5zcGVjdGVkLmFkZChub2RlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBjb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRlY2xhcmVkID0gY29tcG9uZW50LmNvbnN0cnVjdG9yPy5fX3Byb3BzX187XHJcbiAgICAgICAgICAgIGNvbnN0IGF0dHJpYnV0ZXMgPSBzZXNzaW9uLmNjLmpzPy5nZXRDbGFzc0F0dHJzPy4oY29tcG9uZW50LmNvbnN0cnVjdG9yKSA/PyB7fTtcclxuICAgICAgICAgICAgY29uc3Qga2V5czogc3RyaW5nW10gPSBBcnJheS5pc0FycmF5KGRlY2xhcmVkKSA/IGRlY2xhcmVkIDogT2JqZWN0LmtleXMoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKGF0dHJpYnV0ZXNbYCR7a2V5fSRfJHNlcmlhbGl6YWJsZWBdID09PSBmYWxzZSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoWydub2RlJywgJ19ub2RlJywgJ19fcHJlZmFiJ10uaW5jbHVkZXMoa2V5KSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxsb3dlZC5oYXMoY29tcG9uZW50KSAmJiBbJ19zcHJpdGVGcmFtZScsICdzcHJpdGVGcmFtZSddLmluY2x1ZGVzKGtleSkpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5zQXNzZXQoY29tcG9uZW50W2tleV0sIGlkcywgc2Vzc2lvbi5jYykpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi1hOa6kOi/mOiiq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneeahOWFtuS7lue7hOS7tuaIluWxnuaAp+W8leeUqO+8jOW3suWBnOatouWIoOmZpOOAgmApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIHdhbGsoc2Vzc2lvbi5zY2VuZSwgaW5zcGVjdE5vZGUpO1xyXG4gICAgd2FsayhzZXNzaW9uLnJvb3QsIGluc3BlY3ROb2RlKTtcclxuICAgIGlmIChwYXlsb2FkLmRldGFjaCkge1xyXG4gICAgICAgIHNlc3Npb24uZGV0YWNoZWQgPSBbXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHNsb3Qgb2Ygc2xvdHMpIHtcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZGV0YWNoZWQucHVzaChzbG90KTtcclxuICAgICAgICAgICAgICAgIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIG51bGwsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBzbG90IG9mIHNlc3Npb24uZGV0YWNoZWQpIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIHNsb3QuYXNzZXQsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICBzZXNzaW9uLmRldGFjaGVkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZmluaXNoUmV2aWV3UmVtb3ZhbChwYXlsb2FkOiB7IGlkOiBzdHJpbmc7IHJlc3RvcmU/OiBib29sZWFuIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSAhPT0gc2Vzc2lvbi5zY2VuZSkgdGhyb3cgbmV3IEVycm9yKCfnvJbovpHnm67moIflt7LliIfmjaLvvIzml6Dms5XlrozmiJDotYTmupDmuIXnkIbjgIInKTtcclxuICAgIGlmIChwYXlsb2FkLnJlc3RvcmUpIGZvciAoY29uc3Qgc2xvdCBvZiBzZXNzaW9uLmRldGFjaGVkID8/IFtdKSBjbGVhckZyYW1lKHNsb3QuY29tcG9uZW50LCBzbG90LmFzc2V0LCBzZXNzaW9uLmNjKTtcclxuICAgIHNlc3Npb24uZGV0YWNoZWQgPSB1bmRlZmluZWQ7XHJcbiAgICBzZXNzaW9uLmFmdGVyID0gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgcmV0dXJuIHNlc3Npb24uYWZ0ZXI7XHJcbn1cclxuXHJcbi8qKiBDYWxsZWQgb25seSBieSB0aGUgbWFpbiBpbXBvcnQgZmxvdyBhZnRlciBDcmVhdG9yJ3Mgc2F2ZS9zZXJpYWxpemF0aW9uIGhhcyBjb21wbGV0ZWQuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoUmV2aWV3QWZ0ZXIocGF5bG9hZDogeyBpZDogc3RyaW5nIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoJ+WvvOWFpeajgOafpeS8muivneW3suWkseaViOOAgicpO1xyXG4gICAgY29uc3QgZmFjYWRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lRmFjYWRlTWFuYWdlcjtcclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSBTdHJpbmcoZmFjYWRlPy5xdWVyeUN1cnJlbnRTY2VuZVV1aWQ/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IG1vZGUgPSBTdHJpbmcoZmFjYWRlPy5xdWVyeU1vZGU/LigpID8/ICdzY2VuZScpO1xyXG4gICAgaWYgKG5vcm1hbGl6ZUNvY29zVXVpZCh0YXJnZXRVdWlkKSAhPT0gbm9ybWFsaXplQ29jb3NVdWlkKHNlc3Npb24uYWZ0ZXIudGFyZ2V0VXVpZCkgfHwgbW9kZSAhPT0gc2Vzc2lvbi5hZnRlci5tb2RlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlr7zlhaXnvJbovpHnm67moIflsJrmnKrnqLPlrprmiJblt7LliIfmjaLvvIjpooTmnJ8gJHtzZXNzaW9uLmFmdGVyLm1vZGV9OiR7c2Vzc2lvbi5hZnRlci50YXJnZXRVdWlkIHx8ICfmnKrkv53lrZgnfe+8jOW9k+WJjSAke21vZGV9OiR7dGFyZ2V0VXVpZCB8fCAn5pyq5L+d5a2YJ33vvInjgIJgKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjZW5lID0gc2Vzc2lvbi5jYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgbGV0IHJvb3QgPSBzZXNzaW9uLnJvb3Q7XHJcbiAgICBsZXQgbm9kZU1hcCA9IHNlc3Npb24ubm9kZU1hcDtcclxuICAgIGlmIChzY2VuZSAhPT0gc2Vzc2lvbi5zY2VuZSB8fCAoc2Vzc2lvbi5jYy5pc1ZhbGlkICYmICFzZXNzaW9uLmNjLmlzVmFsaWQocm9vdCwgdHJ1ZSkpKSB7XHJcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lPy5yb290Tm9kZTtcclxuICAgICAgICBjb25zdCBmaWxlSWQgPSByb290Py5fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICAgICAgaWYgKG1vZGUgIT09ICdwcmVmYWInIHx8ICF0YXJnZXRVdWlkIHx8ICFmaWxlSWQgfHwgY2FuZGlkYXRlPy5fcHJlZmFiPy5maWxlSWQgIT09IGZpbGVJZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjuaXoOazleaguOWunuWOn+WvvOWFpeagueiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICAgICAgd2FsayhjYW5kaWRhdGUsIChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gbm9kZUlkKG5vZGUsIGNhbmRpZGF0ZSk7XHJcbiAgICAgICAgICAgIGlmIChub2Rlcy5oYXMoaWQpKSB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjuiKgueCueagh+ivhumHjeWkje+8jOaXoOazleWuieWFqOaBouWkjeajgOafpeOAgicpO1xyXG4gICAgICAgICAgICBub2Rlcy5zZXQoaWQsIG5vZGUpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG5vZGVNYXAgPSB7fTtcclxuICAgICAgICBmb3IgKGNvbnN0IHByZXZpb3VzIG9mIHNlc3Npb24uYWZ0ZXIubm9kZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IG5vZGVzLmdldChwcmV2aW91cy5pZCk7XHJcbiAgICAgICAgICAgIGlmICghY3VycmVudCkgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI7oioLngrnnu5PmnoTlt7LmlLnlj5jjgIInKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBpZCBvZiBwcmV2aW91cy5maWdtYUlkcykgbm9kZU1hcFtpZF0gPSBjdXJyZW50LnV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJvb3QgPSBjYW5kaWRhdGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhZnRlciA9IGNhcHR1cmVSZXZpZXdTY2VuZShyb290LCBzZXNzaW9uLmNjLCBub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgY29uc3QgY29tcGFyaXNvbiA9IGNvbXBhcmVTYXZlZFJldmlld1NjZW5lKHNlc3Npb24uYWZ0ZXIsIGFmdGVyKTtcclxuICAgIGlmIChjb21wYXJpc29uLmlzc3Vlcy5sZW5ndGgpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOS/neWtmOWQjuiKgueCueaIlue7hOS7tuWGheWuueW3suWPmOWMlu+8jOW9k+WJjee7k+aenOS4jeiDveeUqOS6jui1hOa6kOa4heeQhuOAguWFt+S9k+W3ruW8gu+8miR7Y29tcGFyaXNvbi5pc3N1ZXMuam9pbign77ybJyl9YCk7XHJcbiAgICB9XHJcbiAgICAvLyBHZW9tZXRyeSBjaGFuZ2VzIGRvIG5vdCBjaGFuZ2Ugb3duZXJzaGlwIG9yIHJlc291cmNlIGNvbnN1bWVycy4gQWRvcHQgYWN0dWFsIHNhdmVkIHZhbHVlcztcclxuICAgIC8vIGRvIG5vdCB3cml0ZSB0aGVtIGJhY2sgdG8gdGhlIHNjZW5lLiBTdWJzZXF1ZW50IGNsZWFudXAgc3RpbGwgdXNlcyB0aGUgc3RyaWN0IGZpbmdlcnByaW50LlxyXG4gICAgaWYgKGNvbXBhcmlzb24uYWRqdXN0bWVudHMuY291bnQpIGFmdGVyLnNhdmVBZGp1c3RtZW50cyA9IGNvbXBhcmlzb24uYWRqdXN0bWVudHM7XHJcbiAgICBzZXNzaW9uLnNjZW5lID0gc2NlbmU7XHJcbiAgICBzZXNzaW9uLnJvb3QgPSByb290O1xyXG4gICAgc2Vzc2lvbi5ub2RlTWFwID0gbm9kZU1hcDtcclxuICAgIHNlc3Npb24uYWZ0ZXIgPSBhZnRlcjtcclxuICAgIHJldHVybiBhZnRlcjtcclxufVxyXG4iXX0=