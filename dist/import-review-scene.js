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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXJldmlldy1zY2VuZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9pbXBvcnQtcmV2aWV3LXNjZW5lLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBdUJBLDhEQVVDO0FBR0QsZ0RBZ0VDO0FBYUQsa0RBU0M7QUFnQ0Qsb0RBcURDO0FBRUQsa0RBT0M7QUFHRCxnREE2Q0M7QUF4UUQsK0RBQTRJO0FBQzVJLDJDQUFzRDtBQUV0RCxTQUFTLElBQUksQ0FBQyxJQUFTLEVBQUUsS0FBeUMsRUFBRSxLQUFLLEdBQUcsQ0FBQzs7SUFDekUsSUFBSSxDQUFDLElBQUk7UUFBRSxPQUFPO0lBQ2xCLEtBQUssQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDbkIsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFBLElBQUksQ0FBQyxRQUFRLG1DQUFJLEVBQUU7UUFBRSxJQUFJLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDM0UsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLElBQVMsZ0JBQVcsT0FBTyxNQUFBLE1BQUEsSUFBSSxDQUFDLFVBQVUsbUNBQUksSUFBSSxDQUFDLFdBQVcsbUNBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUMzRixTQUFTLE1BQU0sQ0FBQyxJQUFTLFlBQVksT0FBTyxDQUFBLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE9BQU8sMENBQUUsTUFBTSxNQUFJLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxJQUFJLENBQUEsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3hGLFNBQVMsV0FBVyxDQUFDLFNBQWMsRUFBRSxLQUFhOztJQUM5QyxPQUFPLENBQUEsTUFBQSxTQUFTLENBQUMsUUFBUSwwQ0FBRSxNQUFNLEtBQUksU0FBUyxDQUFDLElBQUksSUFBSSxHQUFHLEtBQUssSUFBSSxNQUFBLFNBQVMsQ0FBQyxX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QUFDLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNyRixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLO1lBQzdCLFFBQVEsRUFBRSxDQUFDLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsQ0FBQyxFQUFFLEVBQUUsYUFBRixFQUFFLHVCQUFGLEVBQUUsQ0FBRSxLQUFLLEVBQUUsRUFBRSxhQUFGLEVBQUUsdUJBQUYsRUFBRSxDQUFFLE1BQU0sRUFDbEYsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLENBQUMsRUFBRSxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsQ0FBQyxFQUFFLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxDQUFDLEVBQUUsTUFBQSxNQUFBLElBQUksQ0FBQyxLQUFLLDBDQUFFLENBQUMsbUNBQUksQ0FBQyxFQUFFLE1BQUEsTUFBQSxJQUFJLENBQUMsS0FBSywwQ0FBRSxDQUFDLG1DQUFJLENBQUMsRUFDN0UsTUFBQSxNQUFBLEVBQUUsYUFBRixFQUFFLHVCQUFGLEVBQUUsQ0FBRSxXQUFXLDBDQUFFLENBQUMsbUNBQUksR0FBRyxFQUFFLE1BQUEsTUFBQSxFQUFFLGFBQUYsRUFBRSx1QkFBRixFQUFFLENBQUUsV0FBVywwQ0FBRSxDQUFDLG1DQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3ZGLFVBQVUsRUFBRSxRQUFRLEVBQUUsUUFBUSxFQUFFLE1BQUEsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFB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LEtBQUssR0FBRyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLEVBQUUsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2hGLE1BQU0sVUFBVSxHQUFHLElBQUEsNkNBQXVCLEVBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQztJQUNqRSxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDM0IsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7SUFDRCw2RkFBNkY7SUFDN0YsNkZBQTZGO0lBQzdGLElBQUksVUFBVSxDQUFDLFdBQVcsQ0FBQyxLQUFLO1FBQUUsS0FBSyxDQUFDLGVBQWUsR0FBRyxVQUFVLENBQUMsV0FBVyxDQUFDO0lBQ2pGLE9BQU8sQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ3RCLE9BQU8sQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ3BCLE9BQU8sQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO0lBQzFCLE9BQU8sQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ3RCLE9BQU8sS0FBSyxDQUFDO0FBQ2pCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjb21wYXJlU2F2ZWRSZXZpZXdTY2VuZSwgcmV2aWV3RmluZ2VycHJpbnQsIHR5cGUgUmV2aWV3Q29tcG9uZW50LCB0eXBlIFJldmlld05vZGUsIHR5cGUgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVDb2Nvc1V1aWQgfSBmcm9tICcuL3JvdW5kdHJpcC91dWlkJztcclxuXHJcbmZ1bmN0aW9uIHdhbGsocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSwgZGVwdGg6IG51bWJlcikgPT4gdm9pZCwgZGVwdGggPSAwKTogdm9pZCB7XHJcbiAgICBpZiAoIXJvb3QpIHJldHVybjtcclxuICAgIHZpc2l0KHJvb3QsIGRlcHRoKTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbiA/PyBbXSkgd2FsayhjaGlsZCwgdmlzaXQsIGRlcHRoICsgMSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbXBvbmVudHMobm9kZTogYW55KTogYW55W10geyByZXR1cm4gbm9kZS5jb21wb25lbnRzID8/IG5vZGUuX2NvbXBvbmVudHMgPz8gW107IH1cclxuZnVuY3Rpb24gbm9kZUlkKG5vZGU6IGFueSk6IHN0cmluZyB7IHJldHVybiBub2RlPy5fcHJlZmFiPy5maWxlSWQgfHwgbm9kZT8udXVpZCB8fCAnJzsgfVxyXG5mdW5jdGlvbiBjb21wb25lbnRJZChjb21wb25lbnQ6IGFueSwgaW5kZXg6IG51bWJlcik6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gY29tcG9uZW50Ll9fcHJlZmFiPy5maWxlSWQgfHwgY29tcG9uZW50LnV1aWQgfHwgYCR7aW5kZXh9OiR7Y29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lfWA7XHJcbn1cclxuZnVuY3Rpb24gYXNzZXRJZChhc3NldDogYW55KTogc3RyaW5nIHwgbnVsbCB7IHJldHVybiBhc3NldD8uX3V1aWQgfHwgYXNzZXQ/LnV1aWQgfHwgbnVsbDsgfVxyXG5mdW5jdGlvbiBpbnN0YW5jZU9mKGNvbXBvbmVudDogYW55LCBDbGFzczogYW55KTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gdHlwZW9mIENsYXNzID09PSAnZnVuY3Rpb24nICYmIGNvbXBvbmVudCBpbnN0YW5jZW9mIENsYXNzO1xyXG59XHJcbmZ1bmN0aW9uIHJlY29yZENvbG9yKHByb3BlcnRpZXM6IFJldmlld0NvbXBvbmVudFsncHJvcGVydGllcyddLCBjb21wb25lbnQ6IGFueSwga2V5OiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIC8vIEdldHRlcnMgbWF5IGhhdmUgc2lkZSBlZmZlY3RzLiBSZWFkIGVhY2ggc3VwcG9ydGVkIGNvbG9yIGV4YWN0bHkgb25jZS5cclxuICAgIGNvbnN0IGNvbG9yID0gY29tcG9uZW50W2tleV07XHJcbiAgICBpZiAoY29sb3IpIHByb3BlcnRpZXNba2V5XSA9IFsncicsICdnJywgJ2InLCAnYSddLm1hcCgoY2hhbm5lbCkgPT4gY29sb3JbY2hhbm5lbF0pLmpvaW4oJywnKTtcclxufVxyXG5leHBvcnQgZnVuY3Rpb24gcmV2aWV3TWFuYWdlZENvbXBvbmVudElkcyhyb290OiBhbnksIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sIGNsYXNzZXM6IGFueVtdKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgbWFwcGVkID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcclxuICAgIHdhbGsocm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBpZiAoIW1hcHBlZC5oYXMobm9kZS51dWlkKSAmJiAhL15fX0ZpZ21hKD86T3ZlcmZsb3dWaXN1YWx8VGlsZWRNYXNrfFRpbGVkU3ByaXRlKSQvLnRlc3Qobm9kZS5uYW1lKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50LCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoY2xhc3Nlcy5zb21lKChDbGFzcykgPT4gQ2xhc3MgJiYgY29tcG9uZW50IGluc3RhbmNlb2YgQ2xhc3MpKSBpZHMucHVzaChjb21wb25lbnRJZChjb21wb25lbnQsIGluZGV4KSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIHJldHVybiBpZHM7XHJcbn1cclxuY29uc3QgbnVtYmVyID0gKHZhbHVlOiBhbnksIGZhbGxiYWNrID0gMCkgPT4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgucm91bmQodmFsdWUgKiAxMDAwMCkgLyAxMDAwMCA6IGZhbGxiYWNrO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNhcHR1cmVSZXZpZXdTY2VuZShcclxuICAgIHJvb3Q6IGFueSxcclxuICAgIGNjOiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30sXHJcbiAgICBtYW5hZ2VkSWRzOiBzdHJpbmdbXSA9IFtdLFxyXG4pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBmYWNhZGUgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZT8uU2NlbmVGYWNhZGVNYW5hZ2VyO1xyXG4gICAgY29uc3QgbWFwcGVkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgaWYgKGlkID09PSAnX19yb290X18nKSBjb250aW51ZTtcclxuICAgICAgICBtYXBwZWQuc2V0KHV1aWQsIFsuLi4obWFwcGVkLmdldCh1dWlkKSA/PyBbXSksIGlkXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBtYW5hZ2VkID0gbmV3IFNldChtYW5hZ2VkSWRzKTtcclxuICAgIGNvbnN0IG5vZGVzOiBSZXZpZXdOb2RlW10gPSBbXTtcclxuICAgIHdhbGsocm9vdCwgKG5vZGUsIGRlcHRoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdWkgPSBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgY29uc3Qgcm90YXRpb24gPSBub2RlLmV1bGVyQW5nbGVzID8/IG5vZGUuZXVsZXI7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkZWQ6IFJldmlld0NvbXBvbmVudFtdID0gY29tcG9uZW50cyhub2RlKS5tYXAoKGNvbXBvbmVudCwgaW5kZXgpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgdHlwZSA9IGNjLmpzPy5nZXRDbGFzc05hbWU/Lihjb21wb25lbnQpIHx8IGNvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSB8fCAnQ29tcG9uZW50JztcclxuICAgICAgICAgICAgY29uc3QgaWQgPSBjb21wb25lbnRJZChjb21wb25lbnQsIGluZGV4KTtcclxuICAgICAgICAgICAgY29uc3QgcHJvcGVydGllczogUmV2aWV3Q29tcG9uZW50Wydwcm9wZXJ0aWVzJ10gPSB7IGVuYWJsZWQ6IGNvbXBvbmVudC5lbmFibGVkICE9PSBmYWxzZSB9O1xyXG4gICAgICAgICAgICBpZiAoaW5zdGFuY2VPZihjb21wb25lbnQsIGNjLk1hc2spKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBDcmVhdG9yID49My42IHNlcGFyYXRlcyBNYXNrIHJ1bGVzIGZyb20gaXRzIFNwcml0ZS9HcmFwaGljcy5cclxuICAgICAgICAgICAgICAgIC8vIExlZ2FjeSBNYXNrLmNvbG9yIHdhcm5zIGV2ZW4gb24gcmVhZHM7IGRvIG5vdCBwcm9iZSBsZWdhY3lcclxuICAgICAgICAgICAgICAgIC8vIHJlbmRlcmVyIHByb3BlcnRpZXMgKGluY2x1ZGluZyBNYXNrLnNwcml0ZUZyYW1lKSBhdCBhbGwuXHJcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzLnR5cGUgPSBudW1iZXIoY29tcG9uZW50LnR5cGUpO1xyXG4gICAgICAgICAgICAgICAgcHJvcGVydGllcy5pbnZlcnRlZCA9IEJvb2xlYW4oY29tcG9uZW50LmludmVydGVkKTtcclxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXMuYWxwaGFUaHJlc2hvbGQgPSBudW1iZXIoY29tcG9uZW50LmFscGhhVGhyZXNob2xkKTtcclxuICAgICAgICAgICAgICAgIHByb3BlcnRpZXMuc2VnbWVudHMgPSBudW1iZXIoY29tcG9uZW50LnNlZ21lbnRzKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbmRlcmVyID0gY29tcG9uZW50LnN1YkNvbXA7XHJcbiAgICAgICAgICAgICAgICBpZiAoaW5zdGFuY2VPZihyZW5kZXJlciwgY2MuU3ByaXRlKSkgcHJvcGVydGllcy5zcHJpdGVGcmFtZSA9IGFzc2V0SWQocmVuZGVyZXIuc3ByaXRlRnJhbWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgaWQsIHR5cGUsIG1hbmFnZWQ6IG1hbmFnZWQuaGFzKGlkKSwgcHJvcGVydGllcyB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsnc3RyaW5nJywgJ2ZvbnRTaXplJywgJ2xpbmVIZWlnaHQnLCAnb3ZlcmZsb3cnLCAndHlwZScsICdzaXplTW9kZScsICdvcGFjaXR5JyxcclxuICAgICAgICAgICAgICAgICdob3Jpem9udGFsJywgJ3ZlcnRpY2FsJywgJ2ludmVydGVkJywgJ3NwYWNpbmdYJywgJ3NwYWNpbmdZJywgJ3BhZGRpbmdMZWZ0JywgJ3BhZGRpbmdSaWdodCcsXHJcbiAgICAgICAgICAgICAgICAncGFkZGluZ1RvcCcsICdwYWRkaW5nQm90dG9tJywgJ3Jlc2l6ZU1vZGUnLCAndHJhbnNpdGlvbicsICdlbmFibGVPdXRsaW5lJywgJ291dGxpbmVXaWR0aCddKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB2YWx1ZSA9IGNvbXBvbmVudFtrZXldO1xyXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHByb3BlcnRpZXNba2V5XSA9IG51bWJlcih2YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICBlbHNlIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSBwcm9wZXJ0aWVzW2tleV0gPSB2YWx1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ3Nwcml0ZUZyYW1lJywgJ2ZvbnQnLCAnbm9ybWFsU3ByaXRlJywgJ3ByZXNzZWRTcHJpdGUnLCAnaG92ZXJTcHJpdGUnLCAnZGlzYWJsZWRTcHJpdGUnXSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGtleSBpbiBjb21wb25lbnQpIHByb3BlcnRpZXNba2V5XSA9IGFzc2V0SWQoY29tcG9uZW50W2tleV0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChbY2MuU3ByaXRlLCBjYy5MYWJlbCwgY2MuUmljaFRleHQsIGNjLkdyYXBoaWNzXS5zb21lKChDbGFzcykgPT4gaW5zdGFuY2VPZihjb21wb25lbnQsIENsYXNzKSkpIHtcclxuICAgICAgICAgICAgICAgIHJlY29yZENvbG9yKHByb3BlcnRpZXMsIGNvbXBvbmVudCwgJ2NvbG9yJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGluc3RhbmNlT2YoY29tcG9uZW50LCBjYy5HcmFwaGljcykpIHtcclxuICAgICAgICAgICAgICAgIHJlY29yZENvbG9yKHByb3BlcnRpZXMsIGNvbXBvbmVudCwgJ2ZpbGxDb2xvcicpO1xyXG4gICAgICAgICAgICAgICAgcmVjb3JkQ29sb3IocHJvcGVydGllcywgY29tcG9uZW50LCAnc3Ryb2tlQ29sb3InKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4geyBpZCwgdHlwZSwgbWFuYWdlZDogbWFuYWdlZC5oYXMoaWQpLCBwcm9wZXJ0aWVzIH07XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbm9kZXMucHVzaCh7XHJcbiAgICAgICAgICAgIGlkOiBub2RlSWQobm9kZSksIHV1aWQ6IG5vZGUudXVpZCwgcGFyZW50SWQ6IG5vZGUgPT09IHJvb3QgPyBudWxsIDogbm9kZUlkKG5vZGUucGFyZW50KSxcclxuICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLCBkZXB0aCwgb3JkZXI6IG5vZGUgPT09IHJvb3QgPyAwIDogbm9kZS5wYXJlbnQuY2hpbGRyZW4uaW5kZXhPZihub2RlKSxcclxuICAgICAgICAgICAgYWN0aXZlOiBub2RlLmFjdGl2ZSAhPT0gZmFsc2UsXHJcbiAgICAgICAgICAgIGdlb21ldHJ5OiBbbm9kZS5wb3NpdGlvbj8ueCwgbm9kZS5wb3NpdGlvbj8ueSwgbm9kZS5wb3NpdGlvbj8ueiwgdWk/LndpZHRoLCB1aT8uaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgcm90YXRpb24/LngsIHJvdGF0aW9uPy55LCByb3RhdGlvbj8ueiwgbm9kZS5zY2FsZT8ueCA/PyAxLCBub2RlLnNjYWxlPy55ID8/IDEsXHJcbiAgICAgICAgICAgICAgICB1aT8uYW5jaG9yUG9pbnQ/LnggPz8gMC41LCB1aT8uYW5jaG9yUG9pbnQ/LnkgPz8gMC41XS5tYXAoKHZhbHVlKSA9PiBudW1iZXIodmFsdWUpKSxcclxuICAgICAgICAgICAgY29tcG9uZW50czogcmVjb3JkZWQsIGZpZ21hSWRzOiBtYXBwZWQuZ2V0KG5vZGUudXVpZCkgPz8gW10sXHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIHJldHVybiB7IHJvb3RVdWlkOiByb290Py51dWlkID8/ICcnLCB0YXJnZXRVdWlkOiBTdHJpbmcoZmFjYWRlPy5xdWVyeUN1cnJlbnRTY2VuZVV1aWQ/LigpID8/ICcnKSxcclxuICAgICAgICBtb2RlOiBTdHJpbmcoZmFjYWRlPy5xdWVyeU1vZGU/LigpID8/ICdzY2VuZScpLCBub2RlcyB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVSZXZpZXdTZXNzaW9uIHtcclxuICAgIHJvb3Q6IGFueTtcclxuICAgIHNjZW5lOiBhbnk7XHJcbiAgICBjYzogYW55O1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIG1hbmFnZWRJZHM6IHN0cmluZ1tdO1xyXG4gICAgYWZ0ZXI6IFJldmlld1NjZW5lO1xyXG4gICAgZGV0YWNoZWQ/OiBBcnJheTx7IGNvbXBvbmVudDogYW55OyBhc3NldDogYW55IH0+O1xyXG59XHJcbmNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIFNjZW5lUmV2aWV3U2Vzc2lvbj4oKTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNjZW5lUmV2aWV3KGlkOiBzdHJpbmcsIHJvb3Q6IGFueSwgY2M6IGFueSwgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiwgbWFuYWdlZElkczogc3RyaW5nW10sXHJcbiAgICBleHBlY3RlZFRhcmdldD86IHsgdGFyZ2V0VXVpZDogc3RyaW5nOyBtb2RlOiBzdHJpbmcgfSk6IFJldmlld1NjZW5lIHtcclxuICAgIGNvbnN0IGFmdGVyID0gY2FwdHVyZVJldmlld1NjZW5lKHJvb3QsIGNjLCBub2RlTWFwLCBtYW5hZ2VkSWRzKTtcclxuICAgIC8vIFByZWZhYiBpbXBvcnQgYWxyZWFkeSB2ZXJpZmllZCB0aGlzIGlkZW50aXR5IGJlZm9yZSB3cml0aW5nLiBGYWNhZGUgcXVlcmllc1xyXG4gICAgLy8gY2FuIHN0aWxsIGV4cG9zZSB0aGUgcHJldmlvdXMgdGFyZ2V0IHdoaWxlIENyZWF0b3IgZmluaXNoZXMgb3BlbmluZyBpdC5cclxuICAgIGlmIChleHBlY3RlZFRhcmdldCkgT2JqZWN0LmFzc2lnbihhZnRlciwgZXhwZWN0ZWRUYXJnZXQpO1xyXG4gICAgc2Vzc2lvbnMuY2xlYXIoKTtcclxuICAgIHNlc3Npb25zLnNldChpZCwgeyByb290LCBzY2VuZTogY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSwgY2MsIG5vZGVNYXAsIG1hbmFnZWRJZHMsIGFmdGVyIH0pO1xyXG4gICAgcmV0dXJuIGFmdGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXNzaW9uRm9yKGlkOiBzdHJpbmcpOiBTY2VuZVJldmlld1Nlc3Npb24ge1xyXG4gICAgY29uc3Qgc2Vzc2lvbiA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5jYy5kaXJlY3Rvci5nZXRTY2VuZSgpICE9PSBzZXNzaW9uLnNjZW5lKSB0aHJvdyBuZXcgRXJyb3IoJ+ajgOafpee7k+aenOW3sui/h+acn++8jOivt+mHjeaWsOWvvOWFpeOAgicpO1xyXG4gICAgaWYgKHNlc3Npb24uY2MuaXNWYWxpZCAmJiAhc2Vzc2lvbi5jYy5pc1ZhbGlkKHNlc3Npb24ucm9vdCwgdHJ1ZSkpIHRocm93IG5ldyBFcnJvcign5Y6f5a+85YWl6IqC54K55bey5aSx5pWI77yM6K+36YeN5paw5a+85YWl44CCJyk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgaWYgKHJldmlld0ZpbmdlcnByaW50KGN1cnJlbnQpICE9PSByZXZpZXdGaW5nZXJwcmludChzZXNzaW9uLmFmdGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6IqC54K55oiW57yW6L6R55uu5qCH5Zyo5a+85YWl5ZCO5Y+R55Sf5Y+Y5YyW77yM6K+36YeN5paw5a+85YWl55Sf5oiQ5paw55qE5a+55q+U57uT5p6c44CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuLyoqIERpc2NvdmVyIGN1c3RvbSBjb21wb25lbnQvYXJyYXkgcmVmZXJlbmNlcyBhcyB3ZWxsIGFzIG9yZGluYXJ5IFNwcml0ZSBzbG90cy4gKi9cclxuZnVuY3Rpb24gY29udGFpbnNBc3NldCh2YWx1ZTogYW55LCBpZHM6IFNldDxzdHJpbmc+LCBjYzogYW55LCBzZWVuID0gbmV3IFNldDxhbnk+KCkpOiBib29sZWFuIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBzZWVuLmhhcyh2YWx1ZSkpIHJldHVybiBmYWxzZTtcclxuICAgIGNvbnN0IHV1aWQgPSBhc3NldElkKHZhbHVlKTtcclxuICAgIGlmICh1dWlkICYmIGlkcy5oYXMobm9ybWFsaXplQ29jb3NVdWlkKHV1aWQpKSkgcmV0dXJuIHRydWU7XHJcbiAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBjYy5Ob2RlIHx8IChjYy5Db21wb25lbnQgJiYgdmFsdWUgaW5zdGFuY2VvZiBjYy5Db21wb25lbnQpXHJcbiAgICAgICAgfHwgKGNjLkFzc2V0ICYmIHZhbHVlIGluc3RhbmNlb2YgY2MuQXNzZXQpKSByZXR1cm4gZmFsc2U7XHJcbiAgICBzZWVuLmFkZCh2YWx1ZSk7XHJcbiAgICByZXR1cm4gT2JqZWN0LnZhbHVlcyh2YWx1ZSkuc29tZSgoY2hpbGQpID0+IGNvbnRhaW5zQXNzZXQoY2hpbGQsIGlkcywgY2MsIHNlZW4pKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xlYXJGcmFtZShjb21wb25lbnQ6IGFueSwgdmFsdWU6IGFueSwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgdWkgPSBjb21wb25lbnQubm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3Qgd2lkdGggPSB1aT8ud2lkdGg7XHJcbiAgICBjb25zdCBoZWlnaHQgPSB1aT8uaGVpZ2h0O1xyXG4gICAgY29tcG9uZW50LnNwcml0ZUZyYW1lID0gdmFsdWU7XHJcbiAgICBpZiAodWkpIHVpLnNldENvbnRlbnRTaXplKHdpZHRoLCBoZWlnaHQpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcHJlcGFyZVJldmlld1JlbW92YWwocGF5bG9hZDogeyBpZDogc3RyaW5nOyB1dWlkczogc3RyaW5nW107IGRldGFjaD86IGJvb2xlYW4gfSk6IFJldmlld1NjZW5lIHtcclxuICAgIGNvbnN0IHNlc3Npb24gPSBzZXNzaW9uRm9yKHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKHNlc3Npb24uZGV0YWNoZWQpIHRocm93IG5ldyBFcnJvcign6LWE5rqQ5riF55CG5q2j5Zyo5omn6KGM44CCJyk7XHJcbiAgICBjb25zdCBpZHMgPSBuZXcgU2V0KHBheWxvYWQudXVpZHMubWFwKG5vcm1hbGl6ZUNvY29zVXVpZCkpO1xyXG4gICAgY29uc3Qgc25hcHNob3ROb2RlcyA9IG5ldyBNYXAoc2Vzc2lvbi5hZnRlci5ub2Rlcy5tYXAoKG5vZGUpID0+IFtub2RlLnV1aWQsIG5vZGVdKSk7XHJcbiAgICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBzbG90czogQXJyYXk8eyBjb21wb25lbnQ6IGFueTsgYXNzZXQ6IGFueSB9PiA9IFtdO1xyXG4gICAgd2FsayhzZXNzaW9uLnJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNuYXBzaG90ID0gc25hcHNob3ROb2Rlcy5nZXQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3JkZWQgPSBzbmFwc2hvdD8uY29tcG9uZW50cy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBjb21wb25lbnRJZChjb21wb25lbnQsIGluZGV4KSk7XHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnQgaW5zdGFuY2VvZiBzZXNzaW9uLmNjLlNwcml0ZSAmJiByZWNvcmRlZD8ubWFuYWdlZFxyXG4gICAgICAgICAgICAgICAgJiYgaWRzLmhhcyhub3JtYWxpemVDb2Nvc1V1aWQoYXNzZXRJZChjb21wb25lbnQuc3ByaXRlRnJhbWUpID8/ICcnKSkpIHtcclxuICAgICAgICAgICAgICAgIGFsbG93ZWQuYWRkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBzbG90cy5wdXNoKHsgY29tcG9uZW50LCBhc3NldDogY29tcG9uZW50LnNwcml0ZUZyYW1lIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIC8vIEluY2x1ZGUgaW5hY3RpdmUgbm9kZXMgYW5kIG5vZGVzIG91dHNpZGUgdGhlIGltcG9ydGVkIHJvb3QuXHJcbiAgICBjb25zdCBpbnNwZWN0ZWQgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgIGNvbnN0IGluc3BlY3ROb2RlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGlmIChpbnNwZWN0ZWQuaGFzKG5vZGUpKSByZXR1cm47XHJcbiAgICAgICAgaW5zcGVjdGVkLmFkZChub2RlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBjb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRlY2xhcmVkID0gY29tcG9uZW50LmNvbnN0cnVjdG9yPy5fX3Byb3BzX187XHJcbiAgICAgICAgICAgIGNvbnN0IGF0dHJpYnV0ZXMgPSBzZXNzaW9uLmNjLmpzPy5nZXRDbGFzc0F0dHJzPy4oY29tcG9uZW50LmNvbnN0cnVjdG9yKSA/PyB7fTtcclxuICAgICAgICAgICAgY29uc3Qga2V5czogc3RyaW5nW10gPSBBcnJheS5pc0FycmF5KGRlY2xhcmVkKSA/IGRlY2xhcmVkIDogT2JqZWN0LmtleXMoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKGF0dHJpYnV0ZXNbYCR7a2V5fSRfJHNlcmlhbGl6YWJsZWBdID09PSBmYWxzZSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoWydub2RlJywgJ19ub2RlJywgJ19fcHJlZmFiJ10uaW5jbHVkZXMoa2V5KSkgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxsb3dlZC5oYXMoY29tcG9uZW50KSAmJiBbJ19zcHJpdGVGcmFtZScsICdzcHJpdGVGcmFtZSddLmluY2x1ZGVzKGtleSkpIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbnRhaW5zQXNzZXQoY29tcG9uZW50W2tleV0sIGlkcywgc2Vzc2lvbi5jYykpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi1hOa6kOi/mOiiq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneeahOWFtuS7lue7hOS7tuaIluWxnuaAp+W8leeUqO+8jOW3suWBnOatouWIoOmZpOOAgmApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIHdhbGsoc2Vzc2lvbi5zY2VuZSwgaW5zcGVjdE5vZGUpO1xyXG4gICAgd2FsayhzZXNzaW9uLnJvb3QsIGluc3BlY3ROb2RlKTtcclxuICAgIGlmIChwYXlsb2FkLmRldGFjaCkge1xyXG4gICAgICAgIHNlc3Npb24uZGV0YWNoZWQgPSBbXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHNsb3Qgb2Ygc2xvdHMpIHtcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZGV0YWNoZWQucHVzaChzbG90KTtcclxuICAgICAgICAgICAgICAgIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIG51bGwsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBzbG90IG9mIHNlc3Npb24uZGV0YWNoZWQpIGNsZWFyRnJhbWUoc2xvdC5jb21wb25lbnQsIHNsb3QuYXNzZXQsIHNlc3Npb24uY2MpO1xyXG4gICAgICAgICAgICBzZXNzaW9uLmRldGFjaGVkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZmluaXNoUmV2aWV3UmVtb3ZhbChwYXlsb2FkOiB7IGlkOiBzdHJpbmc7IHJlc3RvcmU/OiBib29sZWFuIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKSAhPT0gc2Vzc2lvbi5zY2VuZSkgdGhyb3cgbmV3IEVycm9yKCfnvJbovpHnm67moIflt7LliIfmjaLvvIzml6Dms5XlrozmiJDotYTmupDmuIXnkIbjgIInKTtcclxuICAgIGlmIChwYXlsb2FkLnJlc3RvcmUpIGZvciAoY29uc3Qgc2xvdCBvZiBzZXNzaW9uLmRldGFjaGVkID8/IFtdKSBjbGVhckZyYW1lKHNsb3QuY29tcG9uZW50LCBzbG90LmFzc2V0LCBzZXNzaW9uLmNjKTtcclxuICAgIHNlc3Npb24uZGV0YWNoZWQgPSB1bmRlZmluZWQ7XHJcbiAgICBzZXNzaW9uLmFmdGVyID0gY2FwdHVyZVJldmlld1NjZW5lKHNlc3Npb24ucm9vdCwgc2Vzc2lvbi5jYywgc2Vzc2lvbi5ub2RlTWFwLCBzZXNzaW9uLm1hbmFnZWRJZHMpO1xyXG4gICAgcmV0dXJuIHNlc3Npb24uYWZ0ZXI7XHJcbn1cclxuXHJcbi8qKiBDYWxsZWQgb25seSBieSB0aGUgbWFpbiBpbXBvcnQgZmxvdyBhZnRlciBDcmVhdG9yJ3Mgc2F2ZS9zZXJpYWxpemF0aW9uIGhhcyBjb21wbGV0ZWQuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoUmV2aWV3QWZ0ZXIocGF5bG9hZDogeyBpZDogc3RyaW5nIH0pOiBSZXZpZXdTY2VuZSB7XHJcbiAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnMuZ2V0KHBheWxvYWQuaWQpO1xyXG4gICAgaWYgKCFzZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoJ+WvvOWFpeajgOafpeS8muivneW3suWkseaViOOAgicpO1xyXG4gICAgY29uc3QgZmFjYWRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lRmFjYWRlTWFuYWdlcjtcclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSBTdHJpbmcoZmFjYWRlPy5xdWVyeUN1cnJlbnRTY2VuZVV1aWQ/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IG1vZGUgPSBTdHJpbmcoZmFjYWRlPy5xdWVyeU1vZGU/LigpID8/ICdzY2VuZScpO1xyXG4gICAgaWYgKG5vcm1hbGl6ZUNvY29zVXVpZCh0YXJnZXRVdWlkKSAhPT0gbm9ybWFsaXplQ29jb3NVdWlkKHNlc3Npb24uYWZ0ZXIudGFyZ2V0VXVpZCkgfHwgbW9kZSAhPT0gc2Vzc2lvbi5hZnRlci5tb2RlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlr7zlhaXnvJbovpHnm67moIflsJrmnKrnqLPlrprmiJblt7LliIfmjaLvvIjpooTmnJ8gJHtzZXNzaW9uLmFmdGVyLm1vZGV9OiR7c2Vzc2lvbi5hZnRlci50YXJnZXRVdWlkIHx8ICfmnKrkv53lrZgnfe+8jOW9k+WJjSAke21vZGV9OiR7dGFyZ2V0VXVpZCB8fCAn5pyq5L+d5a2YJ33vvInjgIJgKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjZW5lID0gc2Vzc2lvbi5jYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgbGV0IHJvb3QgPSBzZXNzaW9uLnJvb3Q7XHJcbiAgICBsZXQgbm9kZU1hcCA9IHNlc3Npb24ubm9kZU1hcDtcclxuICAgIGlmIChzY2VuZSAhPT0gc2Vzc2lvbi5zY2VuZSB8fCAoc2Vzc2lvbi5jYy5pc1ZhbGlkICYmICFzZXNzaW9uLmNjLmlzVmFsaWQocm9vdCwgdHJ1ZSkpKSB7XHJcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U/LlNjZW5lPy5yb290Tm9kZTtcclxuICAgICAgICBjb25zdCBmaWxlSWQgPSByb290Py5fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICAgICAgaWYgKG1vZGUgIT09ICdwcmVmYWInIHx8ICF0YXJnZXRVdWlkIHx8ICFmaWxlSWQgfHwgY2FuZGlkYXRlPy5fcHJlZmFiPy5maWxlSWQgIT09IGZpbGVJZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjuaXoOazleaguOWunuWOn+WvvOWFpeagueiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICAgICAgd2FsayhjYW5kaWRhdGUsIChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gbm9kZUlkKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAobm9kZXMuaGFzKGlkKSkgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI7oioLngrnmoIfor4bph43lpI3vvIzml6Dms5XlronlhajmgaLlpI3mo4Dmn6XjgIInKTtcclxuICAgICAgICAgICAgbm9kZXMuc2V0KGlkLCBub2RlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBub2RlTWFwID0ge307XHJcbiAgICAgICAgZm9yIChjb25zdCBwcmV2aW91cyBvZiBzZXNzaW9uLmFmdGVyLm5vZGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBub2Rlcy5nZXQocHJldmlvdXMuaWQpO1xyXG4gICAgICAgICAgICBpZiAoIWN1cnJlbnQpIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCO6IqC54K557uT5p6E5bey5pS55Y+Y44CCJyk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgaWQgb2YgcHJldmlvdXMuZmlnbWFJZHMpIG5vZGVNYXBbaWRdID0gY3VycmVudC51dWlkO1xyXG4gICAgICAgIH1cclxuICAgICAgICByb290ID0gY2FuZGlkYXRlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWZ0ZXIgPSBjYXB0dXJlUmV2aWV3U2NlbmUocm9vdCwgc2Vzc2lvbi5jYywgbm9kZU1hcCwgc2Vzc2lvbi5tYW5hZ2VkSWRzKTtcclxuICAgIGNvbnN0IGNvbXBhcmlzb24gPSBjb21wYXJlU2F2ZWRSZXZpZXdTY2VuZShzZXNzaW9uLmFmdGVyLCBhZnRlcik7XHJcbiAgICBpZiAoY29tcGFyaXNvbi5pc3N1ZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDkv53lrZjlkI7oioLngrnmiJbnu4Tku7blhoXlrrnlt7Llj5jljJbvvIzlvZPliY3nu5PmnpzkuI3og73nlKjkuo7otYTmupDmuIXnkIbjgILlhbfkvZPlt67lvILvvJoke2NvbXBhcmlzb24uaXNzdWVzLmpvaW4oJ++8mycpfWApO1xyXG4gICAgfVxyXG4gICAgLy8gR2VvbWV0cnkgY2hhbmdlcyBkbyBub3QgY2hhbmdlIG93bmVyc2hpcCBvciByZXNvdXJjZSBjb25zdW1lcnMuIEFkb3B0IGFjdHVhbCBzYXZlZCB2YWx1ZXM7XHJcbiAgICAvLyBkbyBub3Qgd3JpdGUgdGhlbSBiYWNrIHRvIHRoZSBzY2VuZS4gU3Vic2VxdWVudCBjbGVhbnVwIHN0aWxsIHVzZXMgdGhlIHN0cmljdCBmaW5nZXJwcmludC5cclxuICAgIGlmIChjb21wYXJpc29uLmFkanVzdG1lbnRzLmNvdW50KSBhZnRlci5zYXZlQWRqdXN0bWVudHMgPSBjb21wYXJpc29uLmFkanVzdG1lbnRzO1xyXG4gICAgc2Vzc2lvbi5zY2VuZSA9IHNjZW5lO1xyXG4gICAgc2Vzc2lvbi5yb290ID0gcm9vdDtcclxuICAgIHNlc3Npb24ubm9kZU1hcCA9IG5vZGVNYXA7XHJcbiAgICBzZXNzaW9uLmFmdGVyID0gYWZ0ZXI7XHJcbiAgICByZXR1cm4gYWZ0ZXI7XHJcbn1cclxuIl19