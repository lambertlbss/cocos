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
function walk(root, visit, depth = 0) {
    var _a;
    if (!root)
        return;
    visit(root, depth);
    for (const child of (_a = root.children) !== null && _a !== void 0 ? _a : [])
        walk(child, visit, depth + 1);
}
function components(node) { var _a, _b; return (_b = (_a = node.components) !== null && _a !== void 0 ? _a : node._components) !== null && _b !== void 0 ? _b : []; }
function nodeId(node) { var _a; return ((_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.fileId) || (node === null || node === void 0 ? void 0 : node.uuid) || ''; }
function componentId(component, index) {
    var _a, _b;
    return ((_a = component.__prefab) === null || _a === void 0 ? void 0 : _a.fileId) || component.uuid || `${index}:${(_b = component.constructor) === null || _b === void 0 ? void 0 : _b.name}`;
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
        if (!mapped.has(node.uuid) && !/^__Figma(?:OverflowVisual|TiledMask|TiledSprite)$/.test(node.name))
            return;
        components(node).forEach((component, index) => {
            if (classes.some((Class) => Class && component instanceof Class))
                ids.push(componentId(component, index));
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
        const ui = node.getComponent(cc.UITransform);
        const rotation = (_a = node.eulerAngles) !== null && _a !== void 0 ? _a : node.euler;
        const recorded = components(node).map((component, index) => {
            var _a, _b, _c;
            const type = ((_b = (_a = cc.js) === null || _a === void 0 ? void 0 : _a.getClassName) === null || _b === void 0 ? void 0 : _b.call(_a, component)) || ((_c = component.constructor) === null || _c === void 0 ? void 0 : _c.name) || 'Component';
            const id = componentId(component, index);
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
                return { id, type, managed: managed.has(id), properties };
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
            return { id, type, managed: managed.has(id), properties };
        });
        nodes.push({
            id: nodeId(node), uuid: node.uuid, parentId: node === root ? null : nodeId(node.parent),
            name: node.name, depth, order: node === root ? 0 : node.parent.children.indexOf(node),
            active: node.active !== false,
            geometry: [(_b = node.position) === null || _b === void 0 ? void 0 : _b.x, (_c = node.position) === null || _c === void 0 ? void 0 : _c.y, (_d = node.position) === null || _d === void 0 ? void 0 : _d.z, ui === null || ui === void 0 ? void 0 : ui.width, ui === null || ui === void 0 ? void 0 : ui.height, rotation === null || rotation === void 0 ? void 0 : rotation.x, rotation === null || rotation === void 0 ? void 0 : rotation.y, rotation === null || rotation === void 0 ? void 0 : rotation.z, (_f = (_e = node.scale) === null || _e === void 0 ? void 0 : _e.x) !== null && _f !== void 0 ? _f : 1, (_h = (_g = node.scale) === null || _g === void 0 ? void 0 : _g.y) !== null && _h !== void 0 ? _h : 1, (_k = (_j = ui === null || ui === void 0 ? void 0 : ui.anchorPoint) === null || _j === void 0 ? void 0 : _j.x) !== null && _k !== void 0 ? _k : 0.5, (_m = (_l = ui === null || ui === void 0 ? void 0 : ui.anchorPoint) === null || _l === void 0 ? void 0 : _l.y) !== null && _m !== void 0 ? _m : 0.5].map((value) => number(value)),
            components: recorded, figmaIds: (_o = mapped.get(node.uuid)) !== null && _o !== void 0 ? _o : [],
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
            const recorded = snapshot === null || snapshot === void 0 ? void 0 : snapshot.components.find((item) => item.id === componentId(component, index));
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
            const id = nodeId(node);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXJldmlldy1zY2VuZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9pbXBvcnQtcmV2aWV3LXNjZW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBdUJBLDhEQVVDO0FBR0QsZ0RBZ0VDO0FBYUQsa0RBU0M7QUFnQ0Qsb0RBcURDO0FBRUQsa0RBT0M7QUFHRCxnREE2Q0M7QUF4UUQsK0RBQTRJO0FBQzVJLDJDQUFzRDtBQUV0RCxTQUFTLElBQUksQ0FBQyxJQUFTLEVBQUUsS0FBeUMsRUFBRSxLQUFLLEdBQUcsQ0FBQzs7SUFDekUsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPO0lBQ2xCLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDbkIsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFBLElBQUksQ0FBQyxRQUFRLG1DQUFJLEVBQUU7UUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDM0UsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLElBQVMsZ0JBQVcsT0FBTyxNQUFBLE1BQUEsSUFBSSxDQUFDLFVBQVUsbUNBQUksSUFBSSxDQUFDLFdBQVcsbUNBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUMzRixTQUFTLE1BQU0sQ0FBQyxJQUFTLFlBQVksT0FBTyxDQUFBLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE9BQU8sMENBQUUsTUFBTSxNQUFJLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxJQUFJLENBQUEsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3hGLFNBQVMsV0FBVyxDQUFDLFNBQWMsRUFBRSxLQUFhOztJQUM5QyxPQUFPLENBQUEsTUFBQSxTQUFTLENBQUMsUUFBUSwwQ0FBRSxNQUFNLEtBQUksU0FBUyxDQUFDLElBQUksSUFBSSxHQUFHLEtBQUssSUFBSSxNQUFBLFNBQVMsQ0FBQyxXQUFXLDBDQUFFLElBQUksRUFBRSxDQUFDO0FBQ3JHLENBQUM7QUFDRCxTQUFTLE9BQU8sQ0FBQyxLQUFVLElBQW1CLE9BQU8sQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsS0FBSyxNQUFJLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxJQUFJLENBQUEsSUFBSSxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQzNGLFNBQVMsVUFBVSxDQUFDLFNBQWMsRUFBRSxLQUFVO0lBQzFDLE9BQU8sT0FBTyxLQUFLLEtBQUssVUFBVSxJQUFJLFNBQVMsWUFBWSxLQUFLLENBQUM7QUFDckUsQ0FBQztBQUNELFNBQVMsV0FBVyxDQUFDLFVBQXlDLEVBQUUsU0FBYyxFQUFFLEdBQVc7SUFDdkYseUVBQXlFO0lBQ3pFLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM3QixJQUFJLEtBQUs7UUFBRSxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNqRyxDQUFDO0FBQ0QsU0FBZ0IseUJBQXlCLENBQUMsSUFBUyxFQUFFLE9BQStCLEVBQUUsT0FBYztJQUNoRyxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7SUFDL0MsTUFBTSxHQUFHLEdBQWEsRUFBRSxDQUFDO0lBQ3pCLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsRUFBRTtRQUNoQixJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxtREFBbUQsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztZQUFFLE9BQU87UUFDM0csVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLFNBQVMsRUFBRSxLQUFLLEVBQUUsRUFBRTtZQUMxQyxJQUFJLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssSUFBSSxTQUFTLFlBQVksS0FBSyxDQUFDO2dCQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQzlHLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQyxDQUFDLENBQUM7SUFDSCxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFDRCxNQUFNLE1BQU0sR0FBRyxDQUFDLEtBQVUsRUFBRSxRQUFRLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUVuSCxTQUFnQixrQkFBa0IsQ0FDOUIsSUFBUyxFQUNULEVBQU8sRUFDUCxVQUFrQyxFQUFFLEVBQ3BDLGFBQXVCLEVBQUU7O0lBRXpCLE1BQU0sTUFBTSxHQUFHLE1BQUMsVUFBa0IsQ0FBQyxHQUFHLDBDQUFFLGtCQUFrQixDQUFDO0lBQzNELE1BQU0sTUFBTSxHQUFHLElBQUksR0FBRyxFQUFvQixDQUFDO0lBQzNDLEtBQUssTUFBTSxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDL0MsSUFBSSxFQUFFLEtBQUssVUFBVTtZQUFFLFNBQVM7UUFDaEMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxHQUFHLENBQUMsTUFBQSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxtQ0FBSSxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUNwQyxNQUFNLEtBQUssR0FBaUIsRUFBRSxDQUFDO0lBQy9CLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUU7O1FBQ3ZCLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzdDLE1BQU0sUUFBUSxHQUFHLE1BQUEsSUFBSSxDQUFDLFdBQVcsbUNBQUksSUFBSSxDQUFDLEtBQUssQ0FBQztRQUNoRCxNQUFNLFFBQVEsR0FBc0IsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFNBQVMsRUFBRSxLQUFLLEVBQUUsRUFBRTs7WUFDMUUsTUFBTSxJQUFJLEdBQUcsQ0FBQSxNQUFBLE1BQUEsRUFBRSxDQUFDLEVBQUUsMENBQUUsWUFBWSxtREFBRyxTQUFTLENBQUMsTUFBSSxNQUFBLFNBQVMsQ0FBQyxXQUFXLDBDQUFFLElBQUksQ0FBQSxJQUFJLFdBQVcsQ0FBQztZQUM1RixNQUFNLEVBQUUsR0FBRyxXQUFXLENBQUMsU0FBUyxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ3pDLE1BQU0sVUFBVSxHQUFrQyxFQUFFLE9BQU8sRUFBRSxTQUFTLENBQUMsT0FBTyxLQUFLLEtBQUssRUFBRSxDQUFDO1lBQzNGLElBQUksVUFBVSxDQUFDLFNBQVMsRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDakMsK0RBQStEO2dCQUMvRCw2REFBNkQ7Z0JBQzdELDJEQUEyRDtnQkFDM0QsVUFBVSxDQUFDLElBQUksR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN6QyxVQUFVLENBQUMsUUFBUSxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ2xELFVBQVUsQ0FBQyxjQUFjLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsQ0FBQztnQkFDN0QsVUFBVSxDQUFDLFFBQVEsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDO2dCQUNqRCxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsT0FBTyxDQUFDO2dCQUNuQyxJQUFJLFVBQVUsQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQztvQkFBRSxVQUFVLENBQUMsV0FBVyxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLENBQUM7Z0JBQzVGLE9BQU8sRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxDQUFDO1lBQzlELENBQUM7WUFDRCxLQUFLLE1BQU0sR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLFVBQVUsRUFBRSxZQUFZLEVBQUUsVUFBVSxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsU0FBUztnQkFDNUYsWUFBWSxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxhQUFhLEVBQUUsY0FBYztnQkFDM0YsWUFBWSxFQUFFLGVBQWUsRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLGVBQWUsRUFBRSxjQUFjLENBQUMsRUFBRSxDQUFDO2dCQUM5RixNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQzdCLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtvQkFBRSxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO3FCQUMxRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxPQUFPLEtBQUssS0FBSyxTQUFTO29CQUFFLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUM7WUFDOUYsQ0FBQztZQUNELEtBQUssTUFBTSxHQUFHLElBQUksQ0FBQyxhQUFhLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxlQUFlLEVBQUUsYUFBYSxFQUFFLGdCQUFnQixDQUFDLEVBQUUsQ0FBQztnQkFDMUcsSUFBSSxHQUFHLElBQUksU0FBUztvQkFBRSxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ3BFLENBQUM7WUFDRCxJQUFJLENBQUMsRUFBRSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ2hHLFdBQVcsQ0FBQyxVQUFVLEVBQUUsU0FBUyxFQUFFLE9BQU8sQ0FBQyxDQUFDO1lBQ2hELENBQUM7WUFDRCxJQUFJLFVBQVUsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7Z0JBQ3JDLFdBQVcsQ0FBQyxVQUFVLEVBQUUsU0FBUyxFQUFFLFdBQVcsQ0FBQyxDQUFDO2dCQUNoRCxXQUFXLENBQUMsVUFBVSxFQUFFLFNBQVMsRUFBRSxhQUFhLENBQUMsQ0FBQztZQUN0RCxDQUFDO1lBQ0QsT0FBTyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUUsVUFBVSxFQUFFLENBQUM7UUFDOUQsQ0FBQyxDQUFDLENBQUM7UUFDSCxLQUFLLENBQUMsSUFBSSxDQUFDO1lBQ1AsRUFBRSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsSUFBSSxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztZQUN2RixJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNyRixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLO1lBQzdCLFFBQVEsRUFBRSxDQUFDLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLEVBQUUsYUFBRixFQUFFLHVCQUFGLEVBQUUsQ0FBRSxLQUFLLEVBQUUsRUFBRSxhQUFGLEVBQUUsdUJBQUYsRUFBRSxDQUFFLE1BQU0sRUFDbEYsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLENBQUMsRUFBRSxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsQ0FBQyxFQUFFLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxDQUFDLEVBQUUsTUFBQSxNQUFBLElBQUksQ0FBQyxLQUFLLDBDQUFFLENBQUMsbUNBQUksQ0FBQyxFQUFFLE1BQUEsTUFBQSxJQUFJLENBQUMsS0FBSywwQ0FBRSxDQUFDLG1DQUFJLENBQUMsRUFDN0UsTUFBQSxNQUFBLEVBQUUsYUFBRixFQUFFLHVCQUFGLEVBQUUsQ0FBRSxXQUFXLDBDQUFFLENBQUMsbUNBQUksR0FBRyxFQUFFLE1BQUEsTUFBQSxFQUFFLGFBQUYsRUFBRSx1QkFBRixFQUFFLENBQUUsV0FBVywwQ0FBRSxDQUFDLG1DQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3ZGLFVBQVUsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE1BQUEsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFB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LEtBQUssR0FBRyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLEVBQUUsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2hGLE1BQU0sVUFBVSxHQUFHLElBQUEsNkNBQXVCLEVBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztJQUNqRSxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDM0IsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7SUFDRCw2RkFBNkY7SUFDN0YsNkZBQTZGO0lBQzdGLElBQUksVUFBVSxDQUFDLFdBQVcsQ0FBQyxLQUFLO1FBQUUsS0FBSyxDQUFDLGVBQWUsR0FBRyxVQUFVLENBQUMsV0FBVyxDQUFDO0lBQ2pGLE9BQU8sQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ3RCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ3BCLE9BQU8sQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0lBQzFCLE9BQU8sQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ3RCLE9BQU8sS0FBSyxDQUFDO0FBQ2pCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjb21wYXJlU2F2ZWRSZXZpZXdTY2VuZSwgcmV2aWV3RmluZ2VycHJpbnQsIHR5cGUgUmV2aWV3Q29tcG9uZW50LCB0eXBlIFJldmlld05vZGUsIHR5cGUgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xuaW1wb3J0IHsgbm9ybWFsaXplQ29jb3NVdWlkIH0gZnJvbSAnLi9yb3VuZHRyaXAvdXVpZCc7XG5cclxuZnVuY3Rpb24gd2Fsayhyb290OiBhbnksIHZpc2l0OiAobm9kZTogYW55LCBkZXB0aDogbnVtYmVyKSA9PiB2b2lkLCBkZXB0aCA9IDApOiB2b2lkIHtcclxuICAgIGlmICghcm9vdCkgcmV0dXJuO1xyXG4gICAgdmlzaXQocm9vdCwgZGVwdGgpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuID8/IFtdKSB3YWxrKGNoaWxkLCB2aXNpdCwgZGVwdGggKyAxKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7IHJldHVybiBub2RlLmNvbXBvbmVudHMgPz8gbm9kZS5fY29tcG9uZW50cyA/PyBbXTsgfVxyXG5mdW5jdGlvbiBub2RlSWQobm9kZTogYW55KTogc3RyaW5nIHsgcmV0dXJuIG5vZGU/Ll9wcmVmYWI/LmZpbGVJZCB8fCBub2RlPy51dWlkIHx8ICcnOyB9XHJcbmZ1bmN0aW9uIGNvbXBvbmVudElkKGNvbXBvbmVudDogYW55LCBpbmRleDogbnVtYmVyKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBjb21wb25lbnQuX19wcmVmYWI/LmZpbGVJZCB8fCBjb21wb25lbnQudXVpZCB8fCBgJHtpbmRleH06JHtjb21wb25lbnQuY29uc3RydWN0b3I/Lm5hbWV9YDtcclxufVxyXG5mdW5jdGlvbiBhc3NldElkKGFzc2V0OiBhbnkpOiBzdHJpbmcgfCBudWxsIHsgcmV0dXJuIGFzc2V0Py5fdXVpZCB8fCBhc3NldD8udXVpZCB8fCBudWxsOyB9XG5mdW5jdGlvbiBpbnN0YW5jZU9mKGNvbXBvbmVudDogYW55LCBDbGFzczogYW55KTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHR5cGVvZiBDbGFzcyA9PT0gJ2Z1bmN0aW9uJyAmJiBjb21wb25lbnQgaW5zdGFuY2VvZiBDbGFzcztcbn1cbmZ1bmN0aW9uIHJlY29yZENvbG9yKHByb3BlcnRpZXM6IFJldmlld0NvbXBvbmVudFsncHJvcGVydGllcyddLCBjb21wb25lbnQ6IGFueSwga2V5OiBzdHJpbmcpOiB2b2lkIHtcbiAgICAvLyBHZXR0ZXJzIG1heSBoYXZlIHNpZGUgZWZmZWN0cy4gUmVhZCBlYWNoIHN1cHBvcnRlZCBjb2xvciBleGFjdGx5IG9uY2UuXG4gICAgY29uc3QgY29sb3IgPSBjb21wb25lbnRba2V5XTtcbiAgICBpZiAoY29sb3IpIHByb3BlcnRpZXNba2V5XSA9IFsncicsICdnJywgJ2InLCAnYSddLm1hcCgoY2hhbm5lbCkgPT4gY29sb3JbY2hhbm5lbF0pLmpvaW4oJywnKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiByZXZpZXdNYW5hZ2VkQ29tcG9uZW50SWRzKHJvb3Q6IGFueSwgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiwgY2xhc3NlczogYW55W10pOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCBtYXBwZWQgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgY29uc3QgaWRzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgd2Fsayhyb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGlmICghbWFwcGVkLmhhcyhub2RlLnV1aWQpICYmICEvXl9fRmlnbWEoPzpPdmVyZmxvd1Zpc3VhbHxUaWxlZE1hc2t8VGlsZWRTcHJpdGUpJC8udGVzdChub2RlLm5hbWUpKSByZXR1cm47XHJcbiAgICAgICAgY29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChjbGFzc2VzLnNvbWUoKENsYXNzKSA9PiBDbGFzcyAmJiBjb21wb25lbnQgaW5zdGFuY2VvZiBDbGFzcykpIGlkcy5wdXNoKGNvbXBvbmVudElkKGNvbXBvbmVudCwgaW5kZXgpKTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIGlkcztcclxufVxyXG5jb25zdCBudW1iZXIgPSAodmFsdWU6IGFueSwgZmFsbGJhY2sgPSAwKSA9PiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC5yb3VuZCh2YWx1ZSAqIDEwMDAwKSAvIDEwMDAwIDogZmFsbGJhY2s7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY2FwdHVyZVJldmlld1NjZW5lKFxyXG4gICAgcm9vdDogYW55LFxyXG4gICAgY2M6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSxcclxuICAgIG1hbmFnZWRJZHM6IHN0cmluZ1tdID0gW10sXHJcbik6IFJldmlld1NjZW5lIHtcclxuICAgIGNvbnN0IGZhY2FkZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlPy5TY2VuZUZhY2FkZU1hbmFnZXI7XHJcbiAgICBjb25zdCBtYXBwZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMobm9kZU1hcCkpIHtcclxuICAgICAgICBpZiAoaWQgPT09ICdfX3Jvb3RfXycpIGNvbnRpbnVlO1xyXG4gICAgICAgIG1hcHBlZC5zZXQodXVpZCwgWy4uLihtYXBwZWQuZ2V0KHV1aWQpID8/IFtdKSwgaWRdKTtcclxuICAgIH1cclxuICAgIGNvbnN0IG1hbmFnZWQgPSBuZXcgU2V0KG1hbmFnZWRJZHMpO1xyXG4gICAgY29uc3Qgbm9kZXM6IFJldmlld05vZGVbXSA9IFtdO1xyXG4gICAgd2Fsayhyb290LCAobm9kZSwgZGVwdGgpID0+IHtcclxuICAgICAgICBjb25zdCB1aSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBjb25zdCByb3RhdGlvbiA9IG5vZGUuZXVsZXJBbmdsZXMgPz8gbm9kZS5ldWxlcjtcclxuICAgICAgICBjb25zdCByZWNvcmRlZDogUmV2aWV3Q29tcG9uZW50W10gPSBjb21wb25lbnRzKG5vZGUpLm1hcCgoY29tcG9uZW50LCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCB0eXBlID0gY2MuanM/LmdldENsYXNzTmFtZT8uKGNvbXBvbmVudCkgfHwgY29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lIHx8ICdDb21wb25lbnQnO1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IGNvbXBvbmVudElkKGNvbXBvbmVudCwgaW5kZXgpO1xuICAgICAgICAgICAgY29uc3QgcHJvcGVydGllczogUmV2aWV3Q29tcG9uZW50Wydwcm9wZXJ0aWVzJ10gPSB7IGVuYWJsZWQ6IGNvbXBvbmVudC5lbmFibGVkICE9PSBmYWxzZSB9O1xuICAgICAgICAgICAgaWYgKGluc3RhbmNlT2YoY29tcG9uZW50LCBjYy5NYXNrKSkge1xuICAgICAgICAgICAgICAgIC8vIENyZWF0b3IgPj0zLjYgc2VwYXJhdGVzIE1hc2sgcnVsZXMgZnJvbSBpdHMgU3ByaXRlL0dyYXBoaWNzLlxuICAgICAgICAgICAgICAgIC8vIExlZ2FjeSBNYXNrLmNvbG9yIHdhcm5zIGV2ZW4gb24gcmVhZHM7IGRvIG5vdCBwcm9iZSBsZWdhY3lcbiAgICAgICAgICAgICAgICAvLyByZW5kZXJlciBwcm9wZXJ0aWVzIChpbmNsdWRpbmcgTWFzay5zcHJpdGVGcmFtZSkgYXQgYWxsLlxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXMudHlwZSA9IG51bWJlcihjb21wb25lbnQudHlwZSk7XG4gICAgICAgICAgICAgICAgcHJvcGVydGllcy5pbnZlcnRlZCA9IEJvb2xlYW4oY29tcG9uZW50LmludmVydGVkKTtcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzLmFscGhhVGhyZXNob2xkID0gbnVtYmVyKGNvbXBvbmVudC5hbHBoYVRocmVzaG9sZCk7XG4gICAgICAgICAgICAgICAgcHJvcGVydGllcy5zZWdtZW50cyA9IG51bWJlcihjb21wb25lbnQuc2VnbWVudHMpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlbmRlcmVyID0gY29tcG9uZW50LnN1YkNvbXA7XG4gICAgICAgICAgICAgICAgaWYgKGluc3RhbmNlT2YocmVuZGVyZXIsIGNjLlNwcml0ZSkpIHByb3BlcnRpZXMuc3ByaXRlRnJhbWUgPSBhc3NldElkKHJlbmRlcmVyLnNwcml0ZUZyYW1lKTtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBpZCwgdHlwZSwgbWFuYWdlZDogbWFuYWdlZC5oYXMoaWQpLCBwcm9wZXJ0aWVzIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ3N0cmluZycsICdmb250U2l6ZScsICdsaW5lSGVpZ2h0JywgJ292ZXJmbG93JywgJ3R5cGUnLCAnc2l6ZU1vZGUnLCAnb3BhY2l0eScsXHJcbiAgICAgICAgICAgICAgICAnaG9yaXpvbnRhbCcsICd2ZXJ0aWNhbCcsICdpbnZlcnRlZCcsICdzcGFjaW5nWCcsICdzcGFjaW5nWScsICdwYWRkaW5nTGVmdCcsICdwYWRkaW5nUmlnaHQnLFxyXG4gICAgICAgICAgICAgICAgJ3BhZGRpbmdUb3AnLCAncGFkZGluZ0JvdHRvbScsICdyZXNpemVNb2RlJywgJ3RyYW5zaXRpb24nLCAnZW5hYmxlT3V0bGluZScsICdvdXRsaW5lV2lkdGgnXSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBjb21wb25lbnRba2V5XTtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSBwcm9wZXJ0aWVzW2tleV0gPSBudW1iZXIodmFsdWUpO1xyXG4gICAgICAgICAgICAgICAgZWxzZSBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyB8fCB0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcHJvcGVydGllc1trZXldID0gdmFsdWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgWydzcHJpdGVGcmFtZScsICdmb250JywgJ25vcm1hbFNwcml0ZScsICdwcmVzc2VkU3ByaXRlJywgJ2hvdmVyU3ByaXRlJywgJ2Rpc2FibGVkU3ByaXRlJ10pIHtcclxuICAgICAgICAgICAgICAgIGlmIChrZXkgaW4gY29tcG9uZW50KSBwcm9wZXJ0aWVzW2tleV0gPSBhc3NldElkKGNvbXBvbmVudFtrZXldKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoW2NjLlNwcml0ZSwgY2MuTGFiZWwsIGNjLlJpY2hUZXh0LCBjYy5HcmFwaGljc10uc29tZSgoQ2xhc3MpID0+IGluc3RhbmNlT2YoY29tcG9uZW50LCBDbGFzcykpKSB7XG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnY29sb3InKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpbnN0YW5jZU9mKGNvbXBvbmVudCwgY2MuR3JhcGhpY3MpKSB7XG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnZmlsbENvbG9yJyk7XG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnc3Ryb2tlQ29sb3InKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7IGlkLCB0eXBlLCBtYW5hZ2VkOiBtYW5hZ2VkLmhhcyhpZCksIHByb3BlcnRpZXMgfTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBub2Rlcy5wdXNoKHtcclxuICAgICAgICAgICAgaWQ6IG5vZGVJZChub2RlKSwgdXVpZDogbm9kZS51dWlkLCBwYXJlbnRJZDogbm9kZSA9PT0gcm9vdCA/IG51bGwgOiBub2RlSWQobm9kZS5wYXJlbnQpLFxyXG4gICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsIGRlcHRoLCBvcmRlcjogbm9kZSA9PT0gcm9vdCA/IDAgOiBub2RlLnBhcmVudC5jaGlsZHJlbi5pbmRleE9mKG5vZGUpLFxyXG4gICAgICAgICAgICBhY3RpdmU6IG5vZGUuYWN0aXZlICE9PSBmYWxzZSxcclxuICAgICAgICAgICAgZ2VvbWV0cnk6IFtub2RlLnBvc2l0aW9uPy54LCBub2RlLnBvc2l0aW9uPy55LCBub2RlLnBvc2l0aW9uPy56LCB1aT8ud2lkdGgsIHVpPy5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICByb3RhdGlvbj8ueCwgcm90YXRpb24/LnksIHJvdGF0aW9uPy56LCBub2RlLnNjYWxlPy54ID8/IDEsIG5vZGUuc2NhbGU/LnkgPz8gMSxcclxuICAgICAgICAgICAgICAgIHVpPy5hbmNob3JQb2ludD8ueCA/PyAwLjUsIHVpPy5hbmNob3JQb2ludD8ueSA/PyAwLjVdLm1hcCgodmFsdWUpID0+IG51bWJlcih2YWx1ZSkpLFxyXG4gICAgICAgICAgICBjb21wb25lbnRzOiByZWNvcmRlZCwgZmlnbWFJZHM6IG1hcHBlZC5nZXQobm9kZS51dWlkKSA/PyBbXSxcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIHsgcm9vdFV1aWQ6IHJvb3Q/LnV1aWQgPz8gJycsIHRhcmdldFV1aWQ6IFN0cmluZyhmYWNhZGU/LnF1ZXJ5Q3VycmVudFNjZW5lVXVpZD8uKCkgPz8gJycpLFxyXG4gICAgICAgIG1vZGU6IFN0cmluZyhmYWNhZGU/LnF1ZXJ5TW9kZT8uKCkgPz8gJ3NjZW5lJyksIG5vZGVzIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZVJldmlld1Nlc3Npb24ge1xyXG4gICAgcm9vdDogYW55O1xyXG4gICAgc2NlbmU6IGFueTtcclxuICAgIGNjOiBhbnk7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgbWFuYWdlZElkczogc3RyaW5nW107XHJcbiAgICBhZnRlcjogUmV2aWV3U2NlbmU7XHJcbiAgICBkZXRhY2hlZD86IEFycmF5PHsgY29tcG9uZW50OiBhbnk7IGFzc2V0OiBhbnkgfT47XHJcbn1cclxuY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgU2NlbmVSZXZpZXdTZXNzaW9uPigpO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2NlbmVSZXZpZXcoaWQ6IHN0cmluZywgcm9vdDogYW55LCBjYzogYW55LCBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LCBtYW5hZ2VkSWRzOiBzdHJpbmdbXSxcbiAgICBleHBlY3RlZFRhcmdldD86IHsgdGFyZ2V0VXVpZDogc3RyaW5nOyBtb2RlOiBzdHJpbmcgfSk6IFJldmlld1NjZW5lIHtcbiAgICBjb25zdCBhZnRlciA9IGNhcHR1cmVSZXZpZXdTY2VuZShyb290LCBjYywgbm9kZU1hcCwgbWFuYWdlZElkcyk7XG4gICAgLy8gUHJlZmFiIGltcG9ydCBhbHJlYWR5IHZlcmlmaWVkIHRoaXMgaWRlbnRpdHkgYmVmb3JlIHdyaXRpbmcuIEZhY2FkZSBxdWVyaWVzXG4gICAgLy8gY2FuIHN0aWxsIGV4cG9zZSB0aGUgcHJldmlvdXMgdGFyZ2V0IHdoaWxlIENyZWF0b3IgZmluaXNoZXMgb3BlbmluZyBpdC5cbiAgICBpZiAoZXhwZWN0ZWRUYXJnZXQpIE9iamVjdC5hc3NpZ24oYWZ0ZXIsIGV4cGVjdGVkVGFyZ2V0KTtcbiAgICBzZXNzaW9ucy5jbGVhcigpO1xyXG4gICAgc2Vzc2lvbnMuc2V0KGlkLCB7IHJvb3QsIHNjZW5lOiBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpLCBjYywgbm9kZU1hcCwgbWFuYWdlZElkcywgYWZ0ZXIgfSk7XHJcbiAgICByZXR1cm4gYWZ0ZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNlc3Npb25Gb3IoaWQ6IHN0cmluZyk6IFNjZW5lUmV2aWV3U2Vzc2lvbiB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNlc3Npb25zLmdldChpZCk7XG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSAhPT0gc2Vzc2lvbi5zY2VuZSkgdGhyb3cgbmV3IEVycm9yKCfmo4Dmn6Xnu5Pmnpzlt7Lov4fmnJ/vvIzor7fph43mlrDlr7zlhaXjgIInKTtcbiAgICBpZiAoc2Vzc2lvbi5jYy5pc1ZhbGlkICYmICFzZXNzaW9uLmNjLmlzVmFsaWQoc2Vzc2lvbi5yb290LCB0cnVlKSkgdGhyb3cgbmV3IEVycm9yKCfljp/lr7zlhaXoioLngrnlt7LlpLHmlYjvvIzor7fph43mlrDlr7zlhaXjgIInKTtcbiAgICBjb25zdCBjdXJyZW50ID0gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgaWYgKHJldmlld0ZpbmdlcnByaW50KGN1cnJlbnQpICE9PSByZXZpZXdGaW5nZXJwcmludChzZXNzaW9uLmFmdGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6IqC54K55oiW57yW6L6R55uu5qCH5Zyo5a+85YWl5ZCO5Y+R55Sf5Y+Y5YyW77yM6K+36YeN5paw5a+85YWl55Sf5oiQ5paw55qE5a+55q+U57uT5p6c44CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuLyoqIERpc2NvdmVyIGN1c3RvbSBjb21wb25lbnQvYXJyYXkgcmVmZXJlbmNlcyBhcyB3ZWxsIGFzIG9yZGluYXJ5IFNwcml0ZSBzbG90cy4gKi9cclxuZnVuY3Rpb24gY29udGFpbnNBc3NldCh2YWx1ZTogYW55LCBpZHM6IFNldDxzdHJpbmc+LCBjYzogYW55LCBzZWVuID0gbmV3IFNldDxhbnk+KCkpOiBib29sZWFuIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBzZWVuLmhhcyh2YWx1ZSkpIHJldHVybiBmYWxzZTtcclxuICAgIGNvbnN0IHV1aWQgPSBhc3NldElkKHZhbHVlKTtcclxuICAgIGlmICh1dWlkICYmIGlkcy5oYXMobm9ybWFsaXplQ29jb3NVdWlkKHV1aWQpKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgY2MuTm9kZSB8fCAoY2MuQ29tcG9uZW50ICYmIHZhbHVlIGluc3RhbmNlb2YgY2MuQ29tcG9uZW50KVxyXG4gICAgICAgIHx8IChjYy5Bc3NldCAmJiB2YWx1ZSBpbnN0YW5jZW9mIGNjLkFzc2V0KSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgc2Vlbi5hZGQodmFsdWUpO1xyXG4gICAgcmV0dXJuIE9iamVjdC52YWx1ZXModmFsdWUpLnNvbWUoKGNoaWxkKSA9PiBjb250YWluc0Fzc2V0KGNoaWxkLCBpZHMsIGNjLCBzZWVuKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsZWFyRnJhbWUoY29tcG9uZW50OiBhbnksIHZhbHVlOiBhbnksIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHVpID0gY29tcG9uZW50Lm5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHdpZHRoID0gdWk/LndpZHRoO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gdWk/LmhlaWdodDtcclxuICAgIGNvbXBvbmVudC5zcHJpdGVGcmFtZSA9IHZhbHVlO1xyXG4gICAgaWYgKHVpKSB1aS5zZXRDb250ZW50U2l6ZSh3aWR0aCwgaGVpZ2h0KTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVSZXZpZXdSZW1vdmFsKHBheWxvYWQ6IHsgaWQ6IHN0cmluZzsgdXVpZHM6IHN0cmluZ1tdOyBkZXRhY2g/OiBib29sZWFuIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbkZvcihwYXlsb2FkLmlkKTtcclxuICAgIGlmIChzZXNzaW9uLmRldGFjaGVkKSB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOa4heeQhuato+WcqOaJp+ihjOOAgicpO1xyXG4gICAgY29uc3QgaWRzID0gbmV3IFNldChwYXlsb2FkLnV1aWRzLm1hcChub3JtYWxpemVDb2Nvc1V1aWQpKTtcbiAgICBjb25zdCBzbmFwc2hvdE5vZGVzID0gbmV3IE1hcChzZXNzaW9uLmFmdGVyLm5vZGVzLm1hcCgobm9kZSkgPT4gW25vZGUudXVpZCwgbm9kZV0pKTtcbiAgICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBzbG90czogQXJyYXk8eyBjb21wb25lbnQ6IGFueTsgYXNzZXQ6IGFueSB9PiA9IFtdO1xyXG4gICAgd2FsayhzZXNzaW9uLnJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNuYXBzaG90ID0gc25hcHNob3ROb2Rlcy5nZXQobm9kZS51dWlkKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZGVkID0gc25hcHNob3Q/LmNvbXBvbmVudHMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gY29tcG9uZW50SWQoY29tcG9uZW50LCBpbmRleCkpO1xyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50IGluc3RhbmNlb2Ygc2Vzc2lvbi5jYy5TcHJpdGUgJiYgcmVjb3JkZWQ/Lm1hbmFnZWRcclxuICAgICAgICAgICAgICAgICYmIGlkcy5oYXMobm9ybWFsaXplQ29jb3NVdWlkKGFzc2V0SWQoY29tcG9uZW50LnNwcml0ZUZyYW1lKSA/PyAnJykpKSB7XG4gICAgICAgICAgICAgICAgYWxsb3dlZC5hZGQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIHNsb3RzLnB1c2goeyBjb21wb25lbnQsIGFzc2V0OiBjb21wb25lbnQuc3ByaXRlRnJhbWUgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgLy8gSW5jbHVkZSBpbmFjdGl2ZSBub2RlcyBhbmQgbm9kZXMgb3V0c2lkZSB0aGUgaW1wb3J0ZWQgcm9vdC5cclxuICAgIGNvbnN0IGluc3BlY3RlZCA9IG5ldyBTZXQ8YW55PigpO1xuICAgIGNvbnN0IGluc3BlY3ROb2RlID0gKG5vZGU6IGFueSkgPT4ge1xuICAgICAgICBpZiAoaW5zcGVjdGVkLmhhcyhub2RlKSkgcmV0dXJuO1xuICAgICAgICBpbnNwZWN0ZWQuYWRkKG5vZGUpO1xuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBjb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRlY2xhcmVkID0gY29tcG9uZW50LmNvbnN0cnVjdG9yPy5fX3Byb3BzX187XHJcbiAgICAgICAgICAgIGNvbnN0IGF0dHJpYnV0ZXMgPSBzZXNzaW9uLmNjLmpzPy5nZXRDbGFzc0F0dHJzPy4oY29tcG9uZW50LmNvbnN0cnVjdG9yKSA/PyB7fTtcclxuICAgICAgICAgICAgY29uc3Qga2V5czogc3RyaW5nW10gPSBBcnJheS5pc0FycmF5KGRlY2xhcmVkKSA/IGRlY2xhcmVkIDogT2JqZWN0LmtleXMoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKGF0dHJpYnV0ZXNbYCR7a2V5fSRfJHNlcmlhbGl6YWJsZWBdID09PSBmYWxzZSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoWydub2RlJywgJ19ub2RlJywgJ19fcHJlZmFiJ10uaW5jbHVkZXMoa2V5KSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxsb3dlZC5oYXMoY29tcG9uZW50KSAmJiBbJ19zcHJpdGVGcmFtZScsICdzcHJpdGVGcmFtZSddLmluY2x1ZGVzKGtleSkpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5zQXNzZXQoY29tcG9uZW50W2tleV0sIGlkcywgc2Vzc2lvbi5jYykpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi1hOa6kOi/mOiiq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneeahOWFtuS7lue7hOS7tuaIluWxnuaAp+W8leeUqO+8jOW3suWBnOatouWIoOmZpOOAgmApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcbiAgICB3YWxrKHNlc3Npb24uc2NlbmUsIGluc3BlY3ROb2RlKTtcbiAgICB3YWxrKHNlc3Npb24ucm9vdCwgaW5zcGVjdE5vZGUpO1xuICAgIGlmIChwYXlsb2FkLmRldGFjaCkge1xyXG4gICAgICAgIHNlc3Npb24uZGV0YWNoZWQgPSBbXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHNsb3Qgb2Ygc2xvdHMpIHtcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZGV0YWNoZWQucHVzaChzbG90KTtcclxuICAgICAgICAgICAgICAgIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIG51bGwsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBzbG90IG9mIHNlc3Npb24uZGV0YWNoZWQpIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIHNsb3QuYXNzZXQsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICBzZXNzaW9uLmRldGFjaGVkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZmluaXNoUmV2aWV3UmVtb3ZhbChwYXlsb2FkOiB7IGlkOiBzdHJpbmc7IHJlc3RvcmU/OiBib29sZWFuIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSAhPT0gc2Vzc2lvbi5zY2VuZSkgdGhyb3cgbmV3IEVycm9yKCfnvJbovpHnm67moIflt7LliIfmjaLvvIzml6Dms5XlrozmiJDotYTmupDmuIXnkIbjgIInKTtcclxuICAgIGlmIChwYXlsb2FkLnJlc3RvcmUpIGZvciAoY29uc3Qgc2xvdCBvZiBzZXNzaW9uLmRldGFjaGVkID8/IFtdKSBjbGVhckZyYW1lKHNsb3QuY29tcG9uZW50LCBzbG90LmFzc2V0LCBzZXNzaW9uLmNjKTtcclxuICAgIHNlc3Npb24uZGV0YWNoZWQgPSB1bmRlZmluZWQ7XHJcbiAgICBzZXNzaW9uLmFmdGVyID0gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgcmV0dXJuIHNlc3Npb24uYWZ0ZXI7XHJcbn1cclxuXHJcbi8qKiBDYWxsZWQgb25seSBieSB0aGUgbWFpbiBpbXBvcnQgZmxvdyBhZnRlciBDcmVhdG9yJ3Mgc2F2ZS9zZXJpYWxpemF0aW9uIGhhcyBjb21wbGV0ZWQuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoUmV2aWV3QWZ0ZXIocGF5bG9hZDogeyBpZDogc3RyaW5nIH0pOiBSZXZpZXdTY2VuZSB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNlc3Npb25zLmdldChwYXlsb2FkLmlkKTtcbiAgICBpZiAoIXNlc3Npb24pIHRocm93IG5ldyBFcnJvcign5a+85YWl5qOA5p+l5Lya6K+d5bey5aSx5pWI44CCJyk7XG4gICAgY29uc3QgZmFjYWRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lRmFjYWRlTWFuYWdlcjtcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gU3RyaW5nKGZhY2FkZT8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyk7XG4gICAgY29uc3QgbW9kZSA9IFN0cmluZyhmYWNhZGU/LnF1ZXJ5TW9kZT8uKCkgPz8gJ3NjZW5lJyk7XG4gICAgaWYgKG5vcm1hbGl6ZUNvY29zVXVpZCh0YXJnZXRVdWlkKSAhPT0gbm9ybWFsaXplQ29jb3NVdWlkKHNlc3Npb24uYWZ0ZXIudGFyZ2V0VXVpZCkgfHwgbW9kZSAhPT0gc2Vzc2lvbi5hZnRlci5tb2RlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5a+85YWl57yW6L6R55uu5qCH5bCa5pyq56iz5a6a5oiW5bey5YiH5o2i77yI6aKE5pyfICR7c2Vzc2lvbi5hZnRlci5tb2RlfToke3Nlc3Npb24uYWZ0ZXIudGFyZ2V0VXVpZCB8fCAn5pyq5L+d5a2YJ33vvIzlvZPliY0gJHttb2RlfToke3RhcmdldFV1aWQgfHwgJ+acquS/neWtmCd977yJ44CCYCk7XG4gICAgfVxuICAgIGNvbnN0IHNjZW5lID0gc2Vzc2lvbi5jYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xuICAgIGxldCByb290ID0gc2Vzc2lvbi5yb290O1xuICAgIGxldCBub2RlTWFwID0gc2Vzc2lvbi5ub2RlTWFwO1xuICAgIGlmIChzY2VuZSAhPT0gc2Vzc2lvbi5zY2VuZSB8fCAoc2Vzc2lvbi5jYy5pc1ZhbGlkICYmICFzZXNzaW9uLmNjLmlzVmFsaWQocm9vdCwgdHJ1ZSkpKSB7XG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlPy5TY2VuZT8ucm9vdE5vZGU7XG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IHJvb3Q/Ll9wcmVmYWI/LmZpbGVJZDtcbiAgICAgICAgaWYgKG1vZGUgIT09ICdwcmVmYWInIHx8ICF0YXJnZXRVdWlkIHx8ICFmaWxlSWQgfHwgY2FuZGlkYXRlPy5fcHJlZmFiPy5maWxlSWQgIT09IGZpbGVJZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI7ml6Dms5XmoLjlrp7ljp/lr7zlhaXmoLnoioLngrnjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XG4gICAgICAgIHdhbGsoY2FuZGlkYXRlLCAobm9kZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgaWQgPSBub2RlSWQobm9kZSk7XG4gICAgICAgICAgICBpZiAobm9kZXMuaGFzKGlkKSkgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI7oioLngrnmoIfor4bph43lpI3vvIzml6Dms5XlronlhajmgaLlpI3mo4Dmn6XjgIInKTtcbiAgICAgICAgICAgIG5vZGVzLnNldChpZCwgbm9kZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBub2RlTWFwID0ge307XG4gICAgICAgIGZvciAoY29uc3QgcHJldmlvdXMgb2Ygc2Vzc2lvbi5hZnRlci5ub2Rlcykge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IG5vZGVzLmdldChwcmV2aW91cy5pZCk7XG4gICAgICAgICAgICBpZiAoIWN1cnJlbnQpIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCO6IqC54K557uT5p6E5bey5pS55Y+Y44CCJyk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIHByZXZpb3VzLmZpZ21hSWRzKSBub2RlTWFwW2lkXSA9IGN1cnJlbnQudXVpZDtcbiAgICAgICAgfVxuICAgICAgICByb290ID0gY2FuZGlkYXRlO1xuICAgIH1cbiAgICBjb25zdCBhZnRlciA9IGNhcHR1cmVSZXZpZXdTY2VuZShyb290LCBzZXNzaW9uLmNjLCBub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xuICAgIGNvbnN0IGNvbXBhcmlzb24gPSBjb21wYXJlU2F2ZWRSZXZpZXdTY2VuZShzZXNzaW9uLmFmdGVyLCBhZnRlcik7XG4gICAgaWYgKGNvbXBhcmlzb24uaXNzdWVzLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOS/neWtmOWQjuiKgueCueaIlue7hOS7tuWGheWuueW3suWPmOWMlu+8jOW9k+WJjee7k+aenOS4jeiDveeUqOS6jui1hOa6kOa4heeQhuOAguWFt+S9k+W3ruW8gu+8miR7Y29tcGFyaXNvbi5pc3N1ZXMuam9pbign77ybJyl9YCk7XG4gICAgfVxuICAgIC8vIEdlb21ldHJ5IGNoYW5nZXMgZG8gbm90IGNoYW5nZSBvd25lcnNoaXAgb3IgcmVzb3VyY2UgY29uc3VtZXJzLiBBZG9wdCBhY3R1YWwgc2F2ZWQgdmFsdWVzO1xuICAgIC8vIGRvIG5vdCB3cml0ZSB0aGVtIGJhY2sgdG8gdGhlIHNjZW5lLiBTdWJzZXF1ZW50IGNsZWFudXAgc3RpbGwgdXNlcyB0aGUgc3RyaWN0IGZpbmdlcnByaW50LlxuICAgIGlmIChjb21wYXJpc29uLmFkanVzdG1lbnRzLmNvdW50KSBhZnRlci5zYXZlQWRqdXN0bWVudHMgPSBjb21wYXJpc29uLmFkanVzdG1lbnRzO1xuICAgIHNlc3Npb24uc2NlbmUgPSBzY2VuZTtcbiAgICBzZXNzaW9uLnJvb3QgPSByb290O1xuICAgIHNlc3Npb24ubm9kZU1hcCA9IG5vZGVNYXA7XG4gICAgc2Vzc2lvbi5hZnRlciA9IGFmdGVyO1xuICAgIHJldHVybiBhZnRlcjtcclxufVxyXG4iXX0=