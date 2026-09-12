"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const node_name_1 = require("./node-name");
const mask_policy_1 = require("./mask-policy");
const import_review_scene_1 = require("./import-review-scene");
module.paths.push((0, path_1.join)(Editor.App.path, 'node_modules'));
const BACKGROUND_NODE_NAME = '__FigmaBackground';
const TILED_MASK_NODE_NAME = '__FigmaTiledMask';
const TILED_SPRITE_NODE_NAME = '__FigmaTiledSprite';
const OVERFLOW_SPRITE_NODE_NAME = '__FigmaOverflowVisual';
// Scene-only updates have no persisted Prefab ownership snapshot. Keep exact
// component identities for this session; unknown/legacy masks fail closed.
const sessionMaskComponents = new WeakSet();
const RASTER_VECTOR_TYPES = new Set([
    'VECTOR',
    'BOOLEAN_OPERATION',
    'STAR',
    'LINE',
    'REGULAR_POLYGON',
]);
function cleanName(input) {
    var _a;
    return (_a = (0, node_name_1.sanitizeNodeName)(input)) !== null && _a !== void 0 ? _a : 'Figma Node';
}
function toColor(Color, value, opacity = 1) {
    var _a;
    const source = value !== null && value !== void 0 ? value : { r: 0, g: 0, b: 0, a: 1 };
    return new Color(Math.round(Math.max(0, Math.min(1, source.r)) * 255), Math.round(Math.max(0, Math.min(1, source.g)) * 255), Math.round(Math.max(0, Math.min(1, source.b)) * 255), Math.round(Math.max(0, Math.min(1, ((_a = source.a) !== null && _a !== void 0 ? _a : 1) * opacity)) * 255));
}
function findByUuid(root, uuid) {
    if (root.uuid === uuid) {
        return root;
    }
    for (const child of root.children) {
        const found = findByUuid(child, uuid);
        if (found) {
            return found;
        }
    }
    return null;
}
function nodePrefabFileId(node) {
    var _a;
    const value = (_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.fileId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function componentPrefabFileId(component) {
    var _a;
    const value = (_a = component === null || component === void 0 ? void 0 : component.__prefab) === null || _a === void 0 ? void 0 : _a.fileId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function walkNodes(root, visit) {
    var _a;
    visit(root);
    for (const child of (_a = root.children) !== null && _a !== void 0 ? _a : []) {
        walkNodes(child, visit);
    }
}
function prefabAssetUuid(node) {
    var _a, _b;
    const asset = (_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.asset;
    const value = (_b = asset === null || asset === void 0 ? void 0 : asset._uuid) !== null && _b !== void 0 ? _b : asset === null || asset === void 0 ? void 0 : asset.uuid;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function prefabFileIdIndex(root, expectedPrefabUuid) {
    const result = new Map();
    const componentFileIds = new Set();
    walkNodes(root, (node) => {
        var _a, _b, _c;
        const prefabRoot = (_a = node === null || node === void 0 ? void 0 : node._prefab) === null || _a === void 0 ? void 0 : _a.root;
        if (node !== root && prefabRoot && prefabRoot !== root) {
            return;
        }
        const assetUuid = prefabAssetUuid(node);
        if (expectedPrefabUuid && assetUuid && assetUuid !== expectedPrefabUuid) {
            return;
        }
        const fileId = nodePrefabFileId(node);
        if (!fileId) {
            return;
        }
        if (result.has(fileId)) {
            throw new Error(`Prefab 内存在重复节点 fileId：${fileId}`);
        }
        result.set(fileId, node);
        for (const component of (_c = (_b = node.components) !== null && _b !== void 0 ? _b : node._components) !== null && _c !== void 0 ? _c : []) {
            const componentFileId = componentPrefabFileId(component);
            if (!componentFileId) {
                continue;
            }
            if (componentFileIds.has(componentFileId)) {
                throw new Error(`Prefab 内存在重复组件 fileId：${componentFileId}`);
            }
            componentFileIds.add(componentFileId);
        }
    });
    return result;
}
function prefabEditingState(expectedUuid, expectedRootFileId) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const cceApi = globalThis.cce;
    const mode = String((_c = (_b = (_a = cceApi === null || cceApi === void 0 ? void 0 : cceApi.SceneFacadeManager) === null || _a === void 0 ? void 0 : _a.queryMode) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : '');
    const currentUuid = String((_f = (_e = (_d = cceApi === null || cceApi === void 0 ? void 0 : cceApi.SceneFacadeManager) === null || _d === void 0 ? void 0 : _d.queryCurrentSceneUuid) === null || _e === void 0 ? void 0 : _e.call(_d)) !== null && _f !== void 0 ? _f : '');
    const root = (_h = (_g = cceApi === null || cceApi === void 0 ? void 0 : cceApi.Scene) === null || _g === void 0 ? void 0 : _g.rootNode) !== null && _h !== void 0 ? _h : null;
    const rootFileId = nodePrefabFileId(root);
    let reason = '';
    if (mode !== 'prefab') {
        reason = `当前编辑模式为 ${mode || 'unknown'}，尚未进入 Prefab`;
    }
    else if (currentUuid !== expectedUuid) {
        reason = `当前资源 UUID 与目标 Prefab 不一致`;
    }
    else if (!root) {
        reason = 'Prefab 根节点尚未就绪';
    }
    else if (expectedRootFileId && rootFileId !== expectedRootFileId) {
        reason = 'Prefab 根节点 fileId 与来源记录不一致';
    }
    return {
        ready: !reason,
        mode,
        currentUuid,
        rootUuid: root === null || root === void 0 ? void 0 : root.uuid,
        rootFileId,
        reason: reason || undefined,
    };
}
function generatePrefabFileId() {
    var _a, _b, _c, _d;
    const generated = (_d = (_c = (_b = (_a = globalThis.Editor) === null || _a === void 0 ? void 0 : _a.Utils) === null || _b === void 0 ? void 0 : _b.UUID) === null || _c === void 0 ? void 0 : _c.generate) === null || _d === void 0 ? void 0 : _d.call(_c, true);
    if (typeof generated === 'string' && generated.length > 0) {
        return generated;
    }
    // Unit-test/headless fallback. The real Creator scene process always uses
    // Editor.Utils.UUID.generate(true), so production IDs follow Creator's own format.
    return `figma${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}
function ensureNodePrefabInfo(node, prefabRoot, cc) {
    var _a, _b, _c, _d, _e, _f, _g;
    let fileId = nodePrefabFileId(node);
    if (fileId) {
        return fileId;
    }
    const cceApi = globalThis.cce;
    (_b = (_a = cceApi === null || cceApi === void 0 ? void 0 : cceApi.Prefab) === null || _a === void 0 ? void 0 : _a.onAddNode) === null || _b === void 0 ? void 0 : _b.call(_a, node);
    fileId = nodePrefabFileId(node);
    if (fileId) {
        return fileId;
    }
    const PrefabInfo = (_e = (_d = (_c = cc.Prefab) === null || _c === void 0 ? void 0 : _c._utils) === null || _d === void 0 ? void 0 : _d.PrefabInfo) !== null && _e !== void 0 ? _e : cc.PrefabInfo;
    if (!PrefabInfo) {
        throw new Error('Cocos 3.8.7 PrefabInfo API 不可用，无法为新节点生成稳定 fileId。');
    }
    const info = new PrefabInfo();
    info.root = prefabRoot;
    info.asset = (_g = (_f = prefabRoot === null || prefabRoot === void 0 ? void 0 : prefabRoot._prefab) === null || _f === void 0 ? void 0 : _f.asset) !== null && _g !== void 0 ? _g : null;
    info.fileId = generatePrefabFileId();
    info.instance = null;
    info.targetOverrides = null;
    node._prefab = info;
    return info.fileId;
}
function ensureComponentPrefabInfo(component, cc) {
    var _a, _b, _c, _d, _e;
    let fileId = componentPrefabFileId(component);
    if (fileId) {
        return fileId;
    }
    const cceApi = globalThis.cce;
    (_b = (_a = cceApi === null || cceApi === void 0 ? void 0 : cceApi.Prefab) === null || _a === void 0 ? void 0 : _a.onAddComponent) === null || _b === void 0 ? void 0 : _b.call(_a, component);
    fileId = componentPrefabFileId(component);
    if (fileId) {
        return fileId;
    }
    const CompPrefabInfo = (_e = (_d = (_c = cc.Prefab) === null || _c === void 0 ? void 0 : _c._utils) === null || _d === void 0 ? void 0 : _d.CompPrefabInfo) !== null && _e !== void 0 ? _e : cc.CompPrefabInfo;
    if (!CompPrefabInfo) {
        throw new Error('Cocos 3.8.7 CompPrefabInfo API 不可用，无法为新组件生成稳定 fileId。');
    }
    const info = new CompPrefabInfo();
    info.fileId = generatePrefabFileId();
    component.__prefab = info;
    return info.fileId;
}
function setParentKeepingWorld(node, parent) {
    if (typeof node.setParent === 'function') {
        node.setParent(parent, true);
    }
    else {
        node.parent = parent;
    }
}
function isGeneratedHelperNode(child, parent, cc) {
    var _a, _b, _c;
    if (child.name === BACKGROUND_NODE_NAME
        || child.name === TILED_MASK_NODE_NAME
        || child.name === TILED_SPRITE_NODE_NAME
        || child.name === OVERFLOW_SPRITE_NODE_NAME
        || child.name === '__FigmaContent') {
        return true;
    }
    if (child.name === 'view' && ((_a = parent.getComponent) === null || _a === void 0 ? void 0 : _a.call(parent, cc.ScrollView))) {
        return true;
    }
    return child.name === 'content'
        && parent.name === 'view'
        && ((_c = (_b = parent.parent) === null || _b === void 0 ? void 0 : _b.getComponent) === null || _c === void 0 ? void 0 : _c.call(_b, cc.ScrollView));
}
function removeMappedNodeTree(node, survivorParent, staleUuids, cc) {
    let removed = 1;
    for (const child of [...node.children]) {
        if (staleUuids.has(child.uuid) || isGeneratedHelperNode(child, node, cc)) {
            removed += removeMappedNodeTree(child, survivorParent, staleUuids, cc);
        }
        else if (survivorParent) {
            setParentKeepingWorld(child, survivorParent);
        }
    }
    node.active = false;
    node.removeFromParent();
    node.destroy();
    return removed;
}
function normalizeSceneSpec(spec) {
    const action = (0, import_actions_1.normalizeImportAction)(spec.action);
    const kind = (0, import_actions_1.kindForImportAction)(spec.kind, action);
    const children = Array.isArray(spec.children) ? spec.children : [];
    return {
        ...spec,
        action,
        kind,
        children: (0, import_actions_1.isTerminalAction)(action) || spec.flattenBoundary === true
            ? []
            : children.map((child) => normalizeSceneSpec(child)),
    };
}
function figmaIdsForSpec(spec) {
    var _a;
    const ids = [spec.figmaId, ...((_a = spec.aliasFigmaIds) !== null && _a !== void 0 ? _a : [])]
        .filter((id) => typeof id === 'string' && id.length > 0 && id !== '__root__');
    return [...new Set(ids)];
}
function aliasFigmaIdsForSpec(spec) {
    return figmaIdsForSpec(spec).filter((figmaId) => figmaId !== spec.figmaId);
}
function existingUuidForSpec(existingMap, spec) {
    for (const figmaId of figmaIdsForSpec(spec)) {
        const uuid = existingMap[figmaId];
        if (uuid) {
            return uuid;
        }
    }
    return undefined;
}
function flattensDescendants(spec) {
    if (typeof spec.flattenBoundary === 'boolean') {
        return spec.flattenBoundary;
    }
    // Backward compatibility for SceneSpecs persisted by importer versions
    // before flattenBoundary was introduced. New plans always set the flag so
    // folded Labels and other promoted visuals use the same cleanup semantics.
    return spec.action === 'render'
        || (spec.action === 'generate' && Boolean(spec.sprite) && spec.children.length === 0);
}
function removeCollapsedMappedDescendants(importRoot, existingMap, currentMap, specs, cc) {
    const retainedUuids = new Set(Object.values(currentMap));
    const boundarySpecs = [];
    const collectBoundaries = (nodes) => {
        for (const spec of nodes) {
            if (flattensDescendants(spec)) {
                boundarySpecs.push({
                    figmaId: spec.figmaId,
                    removesAllMappedDescendants: true,
                    aliasFigmaIds: new Set(),
                });
                continue;
            }
            const aliasFigmaIds = aliasFigmaIdsForSpec(spec);
            if (aliasFigmaIds.length) {
                boundarySpecs.push({
                    figmaId: spec.figmaId,
                    removesAllMappedDescendants: false,
                    aliasFigmaIds: new Set(aliasFigmaIds),
                });
            }
            collectBoundaries(spec.children);
        }
    };
    collectBoundaries(specs);
    const boundaries = boundarySpecs
        .map((boundary) => ({
        ...boundary,
        node: currentMap[boundary.figmaId]
            ? findByUuid(importRoot, currentMap[boundary.figmaId])
            : null,
    }))
        .filter((boundary) => Boolean(boundary.node));
    if (!boundaries.length) {
        return 0;
    }
    const staleNodes = new Map();
    for (const [figmaId, uuid] of Object.entries(existingMap)) {
        if (figmaId === '__root__' || retainedUuids.has(uuid)) {
            continue;
        }
        for (const boundary of boundaries) {
            if (!boundary.removesAllMappedDescendants
                && !boundary.aliasFigmaIds.has(figmaId)) {
                continue;
            }
            const node = findByUuid(boundary.node, uuid);
            if (node && node !== boundary.node) {
                staleNodes.set(node.uuid, node);
                break;
            }
        }
    }
    if (!staleNodes.size) {
        return 0;
    }
    const staleUuids = new Set(staleNodes.keys());
    let removed = 0;
    for (const node of staleNodes.values()) {
        if (!node.parent || staleUuids.has(node.parent.uuid)) {
            continue;
        }
        removed += removeMappedNodeTree(node, node.parent, staleUuids, cc);
    }
    return removed;
}
function mergePreservedMappings(importRoot, existingMap, currentMap) {
    for (const [figmaId, uuid] of Object.entries(existingMap)) {
        if (figmaId === '__root__' || currentMap[figmaId]) {
            continue;
        }
        if (findByUuid(importRoot, uuid)) {
            currentMap[figmaId] = uuid;
        }
    }
}
function salvageExistingMappedNodes(container, survivorParent, existingUuids) {
    for (const child of [...container.children]) {
        if (existingUuids.has(child.uuid)) {
            setParentKeepingWorld(child, survivorParent);
        }
        else {
            salvageExistingMappedNodes(child, survivorParent, existingUuids);
        }
    }
}
function findCanvas(root, Canvas) {
    if (root.getComponent(Canvas)) {
        return root;
    }
    for (const child of root.children) {
        const found = findCanvas(child, Canvas);
        if (found) {
            return found;
        }
    }
    return null;
}
function removeGeneratedComponents(node, classes, preserved, renderClasses, removableFileIds) {
    let removedRenderComponent = false;
    for (const type of classes) {
        if (preserved.has(type)) {
            continue;
        }
        const component = node.getComponent(type);
        if (component) {
            if (removableFileIds) {
                const fileId = componentPrefabFileId(component);
                if (!fileId || !removableFileIds.has(fileId)) {
                    if (renderClasses.some((renderType) => component instanceof renderType)) {
                        throw new Error(`节点“${node.name}”上的渲染组件不是 Figma Importer 创建的，已停止更新以保护手工内容。`);
                    }
                    continue;
                }
            }
            if (renderClasses.some((renderType) => component instanceof renderType)) {
                removedRenderComponent = true;
            }
            node.removeComponent(component);
        }
    }
    return removedRenderComponent;
}
async function removeObsoleteLabelOutline(node, cc) {
    const outline = node.getComponent(cc.LabelOutline);
    if (!outline) {
        return;
    }
    // LabelOutline was used by older importer versions. Cocos destroys
    // components at the end of the frame and its onDisable() writes back to
    // Label.enableOutline, so let that lifecycle finish before either
    // reconfiguring or removing the Label component.
    node.removeComponent(outline);
    await waitForDeferredComponentRemoval();
}
function desiredGeneratedComponents(spec, cc, node) {
    var _a;
    const desired = new Set();
    const clipsChildren = clipsGeneratedChildren(spec);
    if (spec.action === 'render' || spec.sprite) {
        if (!usesTiledSpriteHelper(spec) && !usesOverflowSpriteHelper(spec)) {
            desired.add(cc.Sprite);
        }
    }
    else if (spec.kind === 'richText') {
        desired.add(cc.RichText);
    }
    else if (spec.kind === 'label' || spec.figmaType === 'TEXT') {
        desired.add(cc.Label);
    }
    else if (!RASTER_VECTOR_TYPES.has(spec.figmaType)) {
        if (hasGraphicsVisual(spec) || clipsChildren) {
            desired.add(cc.Graphics);
        }
        if (clipsChildren) {
            desired.add(cc.Mask);
        }
    }
    const layoutMode = (_a = spec.layout) === null || _a === void 0 ? void 0 : _a.mode;
    if (spec.action === 'generate'
        && spec.kind !== 'scrollView'
        && layoutMode
        && layoutMode !== 'NONE') {
        desired.add(cc.Layout);
    }
    if (spec.action === 'generate' && spec.kind === 'scrollView') {
        desired.add(cc.ScrollView);
    }
    if (spec.kind === 'button' && !hasButtonAncestor(node, cc)) {
        desired.add(cc.Button);
    }
    if (spec.opacity < 0.999) {
        desired.add(cc.UIOpacity);
    }
    return desired;
}
function waitForDeferredComponentRemoval() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
function isOwnedHelperNode(node, guard) {
    const fileId = nodePrefabFileId(node);
    return !guard.preexistingNodeUuids.has(node.uuid)
        || Boolean(fileId && guard.previousHelperFileIds.has(fileId));
}
function assertOwnedGeneratedComponent(component, guard, ownerName) {
    var _a, _b;
    if (!component || !guard.preexistingComponents.has(component)) {
        return;
    }
    const fileId = componentPrefabFileId(component);
    if (!fileId || !guard.previousComponentFileIds.has(fileId)) {
        throw new Error(`节点“${ownerName}”上的 ${(_b = (_a = component.constructor) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'Component'} 不是 Figma Importer 创建的，已停止更新。`);
    }
}
function assertOwnedHelperNode(node, guard) {
    if (!isOwnedHelperNode(node, guard)) {
        throw new Error(`辅助节点“${node.name}”不是 Figma Importer 创建的，已停止更新。`);
    }
    for (const component of nodeComponents(node)) {
        assertOwnedGeneratedComponent(component, guard, node.name);
    }
}
function assertOwnedHelperSubtree(node, guard) {
    var _a;
    assertOwnedHelperNode(node, guard);
    for (const child of (_a = node.children) !== null && _a !== void 0 ? _a : []) {
        if (isOwnedHelperNode(child, guard)) {
            assertOwnedHelperSubtree(child, guard);
        }
    }
}
function destroyOwnedHelperSubtree(helper, survivor, guard) {
    if (guard) {
        assertOwnedHelperSubtree(helper, guard);
    }
    const remove = (node) => {
        for (const child of [...node.children]) {
            if (guard && isOwnedHelperNode(child, guard)) {
                remove(child);
            }
            else {
                setParentKeepingWorld(child, survivor);
            }
        }
        node.removeFromParent();
        node.destroy();
    };
    remove(helper);
}
function removeGeneratedBackground(node, guard) {
    const background = node.getChildByName(BACKGROUND_NODE_NAME);
    if (!background) {
        return;
    }
    destroyOwnedHelperSubtree(background, node, guard);
}
function destroyGeneratedTiledSprite(tiledSprite, survivor, guard) {
    destroyOwnedHelperSubtree(tiledSprite, survivor, guard);
}
function removeGeneratedTiledNodes(node, guard) {
    const tiledMask = node.getChildByName(TILED_MASK_NODE_NAME);
    if (tiledMask) {
        destroyOwnedHelperSubtree(tiledMask, node, guard);
    }
    const tiledSprite = node.getChildByName(TILED_SPRITE_NODE_NAME);
    if (tiledSprite) {
        destroyGeneratedTiledSprite(tiledSprite, node, guard);
    }
}
function removeGeneratedOverflowVisual(node, guard) {
    const helper = node.getChildByName(OVERFLOW_SPRITE_NODE_NAME);
    if (helper) {
        destroyOwnedHelperSubtree(helper, node, guard);
    }
}
function removeObsoleteScrollHelpers(node, spec, cc, guard) {
    if (spec.kind === 'scrollView') {
        return;
    }
    // A flattened node has no new child specs by design. Keep every existing
    // child alive until removeFlattenedMappedDescendants can distinguish old
    // Figma-mapped nodes from user-authored nodes. Otherwise destroying the
    // helper would recursively destroy manual children at Cocos' deferred
    // destruction boundary.
    const preserveChildren = spec.children.length > 0 || flattensDescendants(spec);
    const moveChildrenToNode = (container) => {
        for (const child of [...container.children]) {
            setParentKeepingWorld(child, node);
        }
    };
    const legacy = node.getChildByName('__FigmaContent');
    if (legacy) {
        if (guard) {
            assertOwnedHelperNode(legacy, guard);
        }
        if (guard || preserveChildren) {
            moveChildrenToNode(legacy);
        }
        legacy.removeFromParent();
        legacy.destroy();
    }
    const scroll = node.getComponent(cc.ScrollView);
    const view = node.getChildByName('view');
    const content = view === null || view === void 0 ? void 0 : view.getChildByName('content');
    if (!scroll || !view || !content
        || (scroll.content !== content && scroll.content != null)) {
        return;
    }
    if (guard) {
        assertOwnedHelperSubtree(view, guard);
        destroyOwnedHelperSubtree(view, node, guard);
        return;
    }
    if (preserveChildren) {
        moveChildrenToNode(content);
        for (const child of [...view.children]) {
            if (child !== content) {
                setParentKeepingWorld(child, node);
            }
        }
    }
    content.removeFromParent();
    content.destroy();
    view.removeFromParent();
    view.destroy();
}
function framePosition(frame, parentFrame, scale, parentTransform, childTransform) {
    var _a, _b, _c;
    if (!parentFrame) {
        return { x: 0, y: 0 };
    }
    const parentAnchor = (_a = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.anchorPoint) !== null && _a !== void 0 ? _a : { x: 0, y: 1 };
    const parentSize = (_b = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.contentSize) !== null && _b !== void 0 ? _b : {};
    const parentWidth = Number(parentSize.width) > 0
        ? Number(parentSize.width)
        : parentFrame.width * scale;
    const parentHeight = Number(parentSize.height) > 0
        ? Number(parentSize.height)
        : parentFrame.height * scale;
    const width = frame.width * scale;
    const height = frame.height * scale;
    const childAnchor = (_c = childTransform === null || childTransform === void 0 ? void 0 : childTransform.anchorPoint) !== null && _c !== void 0 ? _c : { x: 0.5, y: 0.5 };
    return {
        // Figma coordinates are measured from the parent's top-left. Convert
        // that rectangle to the local position of the node's center anchor.
        x: (frame.x - parentFrame.x) * scale
            - parentWidth * parentAnchor.x
            + width * childAnchor.x,
        y: parentHeight * (1 - parentAnchor.y)
            - (frame.y - parentFrame.y) * scale
            - height * (1 - childAnchor.y),
    };
}
function relativeTransformPosition(spec, scale, parentTransform) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (spec.isRoot || !spec.intrinsicSize)
        return undefined;
    const matrix = spec.relativeTransform;
    const values = [
        (_a = matrix === null || matrix === void 0 ? void 0 : matrix[0]) === null || _a === void 0 ? void 0 : _a[0],
        (_b = matrix === null || matrix === void 0 ? void 0 : matrix[0]) === null || _b === void 0 ? void 0 : _b[1],
        (_c = matrix === null || matrix === void 0 ? void 0 : matrix[0]) === null || _c === void 0 ? void 0 : _c[2],
        (_d = matrix === null || matrix === void 0 ? void 0 : matrix[1]) === null || _d === void 0 ? void 0 : _d[0],
        (_e = matrix === null || matrix === void 0 ? void 0 : matrix[1]) === null || _e === void 0 ? void 0 : _e[1],
        (_f = matrix === null || matrix === void 0 ? void 0 : matrix[1]) === null || _f === void 0 ? void 0 : _f[2],
    ];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return undefined;
    }
    const [m00, m01, tx, m10, m11, ty] = values;
    const parentAnchor = (_g = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.anchorPoint) !== null && _g !== void 0 ? _g : { x: 0.5, y: 0.5 };
    const parentSize = (_h = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.contentSize) !== null && _h !== void 0 ? _h : {};
    const parentWidth = Number(parentSize.width);
    const parentHeight = Number(parentSize.height);
    if (!Number.isFinite(parentWidth) || !Number.isFinite(parentHeight)) {
        return undefined;
    }
    // Figma relativeTransform is top-left based. Transform the unrotated local
    // center, then convert the parent's downward Y axis to Cocos upward Y.
    const centerX = tx + m00 * spec.intrinsicSize.width / 2
        + m01 * spec.intrinsicSize.height / 2;
    const centerY = ty + m10 * spec.intrinsicSize.width / 2
        + m11 * spec.intrinsicSize.height / 2;
    return {
        x: centerX * scale - parentWidth * parentAnchor.x,
        y: parentHeight * (1 - parentAnchor.y) - centerY * scale,
    };
}
function setImportedContentSize(transform, width, height) {
    // Round only at the UITransform write boundary, after scale/layout math.
    // Do not lock sizes recalculated later by Label or other runtime components.
    transform === null || transform === void 0 ? void 0 : transform.setContentSize(Math.round((width + Number.EPSILON) * 100) / 100, Math.round((height + Number.EPSILON) * 100) / 100);
}
function configureGeometry(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f;
    const { UITransform, Vec3 } = cc;
    const transform = (_a = node.getComponent(UITransform)) !== null && _a !== void 0 ? _a : node.addComponent(UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    const size = (_b = spec.intrinsicSize) !== null && _b !== void 0 ? _b : spec.frame;
    setImportedContentSize(transform, Math.max(0, size.width * scale), Math.max(0, size.height * scale));
    const parentTransform = (_c = node.parent) === null || _c === void 0 ? void 0 : _c.getComponent(UITransform);
    const position = spec.isRoot
        ? { x: 0, y: 0 }
        : (_d = relativeTransformPosition(spec, scale, parentTransform)) !== null && _d !== void 0 ? _d : framePosition(spec.frame, spec.parentFrame, scale, parentTransform, transform);
    node.setPosition(new Vec3(position.x, position.y, (_f = (_e = node.position) === null || _e === void 0 ? void 0 : _e.z) !== null && _f !== void 0 ? _f : 0));
    node.setRotationFromEuler(0, 0, spec.rotation);
    node.active = spec.visible;
    return transform;
}
function visiblePaint(paints) {
    return paints.find((paint) => { var _a; return paint.visible !== false && ((_a = paint.opacity) !== null && _a !== void 0 ? _a : 1) > 0; });
}
function visibleSolidPaint(paints) {
    return paints.find((paint) => {
        var _a, _b, _c;
        return paint.type === 'SOLID'
            && paint.visible !== false
            && ((_a = paint.opacity) !== null && _a !== void 0 ? _a : 1) > 0
            && Boolean(paint.color)
            && ((_c = (_b = paint.color) === null || _b === void 0 ? void 0 : _b.a) !== null && _c !== void 0 ? _c : 1) > 0;
    });
}
function visibleSolidFill(spec) {
    return visibleSolidPaint(spec.fills);
}
function firstTextFill(paints) {
    // Figma's paint array is back-to-front: the panel's top fill is last.
    // Native text keeps the first usable solid in panel order, without mixing
    // stacked fills or changing the source order used by other renderers.
    return visibleSolidPaint([...paints].reverse());
}
function validSolidStroke(spec) {
    return spec.strokeWeight > 0 ? visibleSolidPaint(spec.strokes) : undefined;
}
function roundedStrokeWidth(weight, scale, minimum) {
    // Match imported size precision; round after scaling and preserve existing minimums.
    return Math.round((Math.max(minimum, weight * scale) + Number.EPSILON) * 100) / 100;
}
function hasGraphicsVisual(spec) {
    return Boolean(visibleSolidFill(spec) || validSolidStroke(spec));
}
function drawGraphics(graphics, spec, scale, cc) {
    var _a, _b;
    const fill = visibleSolidFill(spec);
    const stroke = validSolidStroke(spec);
    if (!fill && !stroke) {
        return;
    }
    const width = spec.frame.width * scale;
    const height = spec.frame.height * scale;
    const radius = Math.max(0, Math.min(Math.min(...spec.cornerRadii) * scale, width / 2, height / 2));
    if (spec.figmaType === 'ELLIPSE') {
        graphics.ellipse(0, 0, width / 2, height / 2);
    }
    else if (radius > 0) {
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
    }
    else {
        graphics.rect(-width / 2, -height / 2, width, height);
    }
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        graphics.fillColor = toColor(cc.Color, fill.color, (_a = fill.opacity) !== null && _a !== void 0 ? _a : 1);
        graphics.fill();
    }
    if (stroke === null || stroke === void 0 ? void 0 : stroke.color) {
        graphics.lineWidth = roundedStrokeWidth(spec.strokeWeight, scale, 0.5);
        graphics.strokeColor = toColor(cc.Color, stroke.color, (_b = stroke.opacity) !== null && _b !== void 0 ? _b : 1);
        graphics.stroke();
    }
}
function configureGraphics(node, spec, scale, cc) {
    const existing = node.getComponent(cc.Graphics);
    const graphics = existing !== null && existing !== void 0 ? existing : node.addComponent(cc.Graphics);
    if (!existing)
        sessionMaskComponents.add(graphics);
    graphics.enabled = true;
    graphics.clear();
    drawGraphics(graphics, spec, scale, cc);
}
function normalizeLabelText(characters) {
    return (characters !== null && characters !== void 0 ? characters : '')
        .replace(/\r\n/g, '\n')
        .replace(/[\r\u2028\u2029]/g, '\n');
}
function applyTextAlignment(component, style, renderer) {
    // Cocos has no JUSTIFIED alignment: unsupported/missing values use LEFT/TOP.
    component.horizontalAlign = (style === null || style === void 0 ? void 0 : style.textAlignHorizontal) === 'CENTER'
        ? renderer.HorizontalAlign.CENTER
        : (style === null || style === void 0 ? void 0 : style.textAlignHorizontal) === 'RIGHT'
            ? renderer.HorizontalAlign.RIGHT
            : renderer.HorizontalAlign.LEFT;
    component.verticalAlign = (style === null || style === void 0 ? void 0 : style.textAlignVertical) === 'CENTER'
        ? renderer.VerticalAlign.CENTER
        : (style === null || style === void 0 ? void 0 : style.textAlignVertical) === 'BOTTOM'
            ? renderer.VerticalAlign.BOTTOM
            : renderer.VerticalAlign.TOP;
}
function figmaPanelFontSize(value) {
    const fontSize = typeof value === 'number' && Number.isFinite(value) ? value : 16;
    return Math.round((fontSize + Number.EPSILON) * 100) / 100;
}
function figmaPanelLineHeight(value) {
    const lineHeight = typeof value === 'number' && Number.isFinite(value) ? value : 16;
    // Preserve Figma's pixel line height independently of import scale and
    // engine-computed content size; only round to one decimal place.
    return Math.round((lineHeight + Number.EPSILON) * 10) / 10;
}
function configureLabel(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f;
    const { Label } = cc;
    const label = (_a = node.getComponent(Label)) !== null && _a !== void 0 ? _a : node.addComponent(Label);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    const characters = normalizeLabelText(spec.characters);
    // Figma NONE means a fixed box, not Cocos Overflow.NONE. Both fixed-width
    // modes wrap and grow vertically; missing legacy metadata stays auto-width.
    const wrap = style.textAutoResize === 'HEIGHT' || style.textAutoResize === 'NONE';
    // Figma stores more precision than its panel displays. Match the visible
    // design value (up to two decimals) instead of leaking its internal float.
    label.fontSize = figmaPanelFontSize(style.fontSize);
    label.lineHeight = figmaPanelLineHeight((_c = style.lineHeightPx) !== null && _c !== void 0 ? _c : style.fontSize);
    label.spacingX = ((_d = style.letterSpacing) !== null && _d !== void 0 ? _d : 0) * scale;
    label.overflow = wrap ? Label.Overflow.RESIZE_HEIGHT : Label.Overflow.NONE;
    label.enableWrapText = wrap;
    applyTextAlignment(label, style, Label);
    // Auto-width labels use a centered vertical baseline regardless of Figma's
    // vertical alignment. Fixed-width wrapping labels retain the Figma setting.
    if (label.overflow === Label.Overflow.NONE) {
        label.verticalAlign = Label.VerticalAlign.CENTER;
    }
    label.string = characters;
    label.enableOutline = false;
    label.color = toColor(cc.Color, { r: 1, g: 1, b: 1, a: 1 });
    const fill = firstTextFill(spec.fills);
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        label.color = toColor(cc.Color, fill.color, (_e = fill.opacity) !== null && _e !== void 0 ? _e : 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if ((stroke === null || stroke === void 0 ? void 0 : stroke.color) && spec.strokeWeight > 0) {
        label.enableOutline = true;
        label.outlineColor = toColor(cc.Color, stroke.color, (_f = stroke.opacity) !== null && _f !== void 0 ? _f : 1);
        label.outlineWidth = roundedStrokeWidth(spec.strokeWeight, scale, 1);
    }
}
function configureRichText(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e;
    const { RichText } = cc;
    const richText = (_a = node.getComponent(RichText)) !== null && _a !== void 0 ? _a : node.addComponent(RichText);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    richText.string = normalizeLabelText(spec.characters);
    richText.fontSize = figmaPanelFontSize(style.fontSize);
    richText.lineHeight = figmaPanelLineHeight((_c = style.lineHeightPx) !== null && _c !== void 0 ? _c : style.fontSize);
    richText.maxWidth = Math.max(0, spec.frame.width * scale);
    richText.handleTouchEvent = false;
    applyTextAlignment(richText, style, RichText);
    richText.fontFamily = (_d = style.fontFamily) !== null && _d !== void 0 ? _d : '';
    richText.useSystemFont = !spec.fontUuid;
    richText.fontColor = toColor(cc.Color, { r: 1, g: 1, b: 1, a: 1 });
    const fill = firstTextFill(spec.fills);
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        richText.fontColor = toColor(cc.Color, fill.color, (_e = fill.opacity) !== null && _e !== void 0 ? _e : 1);
    }
}
function loadAsset(assetManager, uuid) {
    return new Promise((resolve, reject) => {
        assetManager.loadAny({ uuid }, (error, asset) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(asset);
        });
    });
}
async function configureSprite(node, spec, scale, cc, targetFrame = spec.frame) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!spec.sprite) {
        return;
    }
    const { Sprite, UITransform, assetManager } = cc;
    const sprite = (_a = node.getComponent(Sprite)) !== null && _a !== void 0 ? _a : node.addComponent(Sprite);
    const transform = node.getComponent(UITransform);
    const targetWidth = Math.max(0, targetFrame.width * scale);
    const targetHeight = Math.max(0, targetFrame.height * scale);
    // Keep assignment deterministic: a new Sprite may default to TRIMMED and
    // immediately rewrite UITransform when its SpriteFrame is assigned.
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    const spriteFrame = await loadAsset(assetManager, spec.sprite.uuid);
    sprite.spriteFrame = spriteFrame;
    const sliced = spec.sprite.sliced || (!spec.sprite.sliceFallback
        && [spriteFrame.insetLeft, spriteFrame.insetRight, spriteFrame.insetTop, spriteFrame.insetBottom]
            .some((value) => Number.isFinite(value) && value > 0));
    sprite.type = spec.sprite.tiled
        ? Sprite.Type.TILED
        : sliced
            ? Sprite.Type.SLICED
            : Sprite.Type.SIMPLE;
    if (!sliced && !spec.sprite.tiled) {
        sprite.sizeMode = Sprite.SizeMode.TRIMMED;
        const trimmedWidth = Number((_b = transform === null || transform === void 0 ? void 0 : transform.contentSize) === null || _b === void 0 ? void 0 : _b.width);
        const trimmedHeight = Number((_c = transform === null || transform === void 0 ? void 0 : transform.contentSize) === null || _c === void 0 ? void 0 : _c.height);
        const rawWidth = Number((_e = (_d = spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.originalSize) === null || _d === void 0 ? void 0 : _d.width) !== null && _e !== void 0 ? _e : spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.width);
        const rawHeight = Number((_g = (_f = spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.originalSize) === null || _f === void 0 ? void 0 : _f.height) !== null && _g !== void 0 ? _g : spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.height);
        const hasValidSpriteSize = Number.isFinite(trimmedWidth)
            && Number.isFinite(trimmedHeight)
            && Number.isFinite(rawWidth)
            && Number.isFinite(rawHeight)
            && rawWidth > 0
            && rawHeight > 0;
        if (hasValidSpriteSize
            && Math.abs(rawWidth - targetWidth) <= 0.51
            && Math.abs(rawHeight - targetHeight) <= 0.51) {
            return;
        }
        if (hasValidSpriteSize) {
            const scaleX = targetWidth / rawWidth;
            const scaleY = targetHeight / rawHeight;
            if (Math.abs(scaleX - scaleY) <= 0.0001) {
                sprite.sizeMode = Sprite.SizeMode.CUSTOM;
                setImportedContentSize(transform, trimmedWidth * scaleX, trimmedHeight * scaleY);
                return;
            }
        }
    }
    // Sliced/tiled sprites and sprites resized in Figma must retain the design
    // size. Cocos represents that state as CUSTOM.
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    setImportedContentSize(transform, targetWidth, targetHeight);
}
function requiresTiledMask(spec) {
    return (0, mask_policy_1.shouldGenerateMask)(spec, 'tiled-helper').shouldMask;
}
function nativeTileScale(spec) {
    var _a;
    const scale = (_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.tileScale;
    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0
        ? scale
        : 1;
}
function usesTiledSpriteHelper(spec) {
    var _a;
    return Boolean((_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.tiled)
        && (requiresTiledMask(spec) || Math.abs(nativeTileScale(spec) - 1) > 1e-6);
}
function usesOverflowSpriteHelper(spec) {
    var _a, _b, _c;
    return Boolean((_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.renderFrame)
        && !((_b = spec.sprite) === null || _b === void 0 ? void 0 : _b.sliced)
        && !((_c = spec.sprite) === null || _c === void 0 ? void 0 : _c.tiled);
}
async function configureOverflowSpriteHelper(node, spec, scale, cc, guard) {
    var _a, _b;
    const renderFrame = (_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.renderFrame;
    if (!renderFrame) {
        throw new Error(`超边界 PNG 节点“${spec.name}”缺少渲染边界。`);
    }
    let helper = node.getChildByName(OVERFLOW_SPRITE_NODE_NAME);
    if (guard && helper) {
        assertOwnedHelperSubtree(helper, guard);
    }
    if (!helper) {
        helper = new cc.Node(OVERFLOW_SPRITE_NODE_NAME);
        node.addChild(helper);
    }
    helper.name = OVERFLOW_SPRITE_NODE_NAME;
    helper.layer = node.layer;
    helper.active = true;
    const transform = (_b = helper.getComponent(cc.UITransform)) !== null && _b !== void 0 ? _b : helper.addComponent(cc.UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    setImportedContentSize(transform, Math.max(0, renderFrame.width * scale), Math.max(0, renderFrame.height * scale));
    await configureSprite(helper, spec, scale, cc, renderFrame);
    const geometryCenterX = spec.frame.x + spec.frame.width / 2;
    const geometryCenterY = spec.frame.y + spec.frame.height / 2;
    const renderCenterX = renderFrame.x + renderFrame.width / 2;
    const renderCenterY = renderFrame.y + renderFrame.height / 2;
    // Figma page Y points downward while Cocos UI Y points upward.
    const worldDeltaX = (renderCenterX - geometryCenterX) * scale;
    const worldDeltaY = -(renderCenterY - geometryCenterY) * scale;
    const worldRotation = Number.isFinite(spec.worldRotation)
        ? Number(spec.worldRotation)
        : spec.rotation;
    const radians = worldRotation * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    // The exported PNG is already rasterized in Figma page axes. Counteract
    // the logical shell's accumulated rotation and express the visual-center
    // offset back in that shell's local coordinate system.
    const localX = cosine * worldDeltaX + sine * worldDeltaY;
    const localY = -sine * worldDeltaX + cosine * worldDeltaY;
    helper.setPosition(new cc.Vec3(localX, localY, 0));
    helper.setRotationFromEuler(0, 0, -worldRotation);
    helper.setScale(new cc.Vec3(1, 1, 1));
    helper.setSiblingIndex(0);
}
async function configureTiledSpriteHelper(node, spec, scale, cc, guard) {
    var _a, _b, _c;
    const needsMask = requiresTiledMask(spec);
    let tiledMask = node.getChildByName(TILED_MASK_NODE_NAME);
    let tiledSprite = (_a = tiledMask === null || tiledMask === void 0 ? void 0 : tiledMask.getChildByName(TILED_SPRITE_NODE_NAME)) !== null && _a !== void 0 ? _a : node.getChildByName(TILED_SPRITE_NODE_NAME);
    if (guard) {
        if (tiledMask) {
            assertOwnedHelperSubtree(tiledMask, guard);
        }
        if (tiledSprite) {
            assertOwnedHelperSubtree(tiledSprite, guard);
        }
    }
    if (needsMask) {
        if (!tiledMask) {
            tiledMask = new cc.Node(TILED_MASK_NODE_NAME);
            node.addChild(tiledMask);
        }
        tiledMask.name = TILED_MASK_NODE_NAME;
        tiledMask.layer = node.layer;
        tiledMask.active = true;
        const maskTransform = (_b = tiledMask.getComponent(cc.UITransform)) !== null && _b !== void 0 ? _b : tiledMask.addComponent(cc.UITransform);
        maskTransform.setAnchorPoint(0.5, 0.5);
        setImportedContentSize(maskTransform, Math.max(0, spec.frame.width * scale), Math.max(0, spec.frame.height * scale));
        tiledMask.setPosition(new cc.Vec3(0, 0, 0));
        tiledMask.setRotationFromEuler(0, 0, 0);
        tiledMask.setScale(new cc.Vec3(1, 1, 1));
        configureClip(tiledMask, spec, cc, 'tiled-helper', guard);
        tiledMask.setSiblingIndex(0);
    }
    else if (tiledMask) {
        for (const child of [...tiledMask.children]) {
            setParentKeepingWorld(child, node);
        }
        tiledMask.removeFromParent();
        tiledMask.destroy();
        tiledMask = null;
    }
    const spriteParent = tiledMask !== null && tiledMask !== void 0 ? tiledMask : node;
    if (!tiledSprite) {
        tiledSprite = new cc.Node(TILED_SPRITE_NODE_NAME);
        spriteParent.addChild(tiledSprite);
    }
    else if (tiledSprite.parent !== spriteParent) {
        tiledSprite.parent = spriteParent;
    }
    tiledSprite.name = TILED_SPRITE_NODE_NAME;
    tiledSprite.layer = node.layer;
    tiledSprite.active = true;
    await configureSprite(tiledSprite, spec, scale, cc);
    const tileScale = nativeTileScale(spec);
    const transform = (_c = tiledSprite.getComponent(cc.UITransform)) !== null && _c !== void 0 ? _c : tiledSprite.addComponent(cc.UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    setImportedContentSize(transform, Math.max(0, spec.frame.width * scale / tileScale), Math.max(0, spec.frame.height * scale / tileScale));
    tiledSprite.setPosition(new cc.Vec3(0, 0, 0));
    tiledSprite.setRotationFromEuler(0, 0, 0);
    tiledSprite.setScale(new cc.Vec3(tileScale, tileScale, 1));
    tiledSprite.setSiblingIndex(0);
}
function configureOpacity(node, spec, cc) {
    var _a;
    if (spec.opacity >= 0.999) {
        return;
    }
    const opacity = (_a = node.getComponent(cc.UIOpacity)) !== null && _a !== void 0 ? _a : node.addComponent(cc.UIOpacity);
    opacity.opacity = Math.round(Math.max(0, Math.min(1, spec.opacity)) * 255);
}
function configureLayout(node, spec, scale, cc) {
    var _a, _b, _c;
    const mode = (_a = spec.layout) === null || _a === void 0 ? void 0 : _a.mode;
    if (!mode || mode === 'NONE') {
        return;
    }
    const { Layout, Size } = cc;
    const layout = (_b = node.getComponent(Layout)) !== null && _b !== void 0 ? _b : node.addComponent(Layout);
    layout.type = mode === 'HORIZONTAL'
        ? Layout.Type.HORIZONTAL
        : mode === 'VERTICAL'
            ? Layout.Type.VERTICAL
            : Layout.Type.GRID;
    if (mode === 'GRID') {
        layout.startAxis = ((_c = spec.layout) === null || _c === void 0 ? void 0 : _c.sourceMode) === 'VERTICAL'
            ? Layout.AxisDirection.VERTICAL
            : Layout.AxisDirection.HORIZONTAL;
    }
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.paddingLeft = spec.layout.paddingLeft * scale;
    layout.paddingRight = spec.layout.paddingRight * scale;
    layout.paddingTop = spec.layout.paddingTop * scale;
    layout.paddingBottom = spec.layout.paddingBottom * scale;
    layout.spacingX = spec.layout.itemSpacing * scale;
    layout.spacingY = (mode === 'GRID' ? spec.layout.counterSpacing : spec.layout.itemSpacing) * scale;
    const activeChildren = spec.children.filter((child) => child.visible);
    if (mode === 'HORIZONTAL' && activeChildren.length) {
        const childrenWidth = activeChildren.reduce((total, child) => total + child.frame.width * scale, 0);
        const innerWidth = spec.frame.width * scale - layout.paddingLeft - layout.paddingRight;
        if (spec.layout.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingX = Math.max(0, (innerWidth - childrenWidth) / (activeChildren.length - 1));
        }
        else {
            const used = childrenWidth + layout.spacingX * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerWidth - used);
            if (spec.layout.primaryAlign === 'CENTER') {
                layout.paddingLeft += remaining / 2;
            }
            else if (spec.layout.primaryAlign === 'MAX') {
                layout.paddingLeft += remaining;
            }
        }
    }
    else if (mode === 'VERTICAL' && activeChildren.length) {
        const childrenHeight = activeChildren.reduce((total, child) => total + child.frame.height * scale, 0);
        const innerHeight = spec.frame.height * scale - layout.paddingTop - layout.paddingBottom;
        if (spec.layout.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingY = Math.max(0, (innerHeight - childrenHeight) / (activeChildren.length - 1));
        }
        else {
            const used = childrenHeight + layout.spacingY * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerHeight - used);
            if (spec.layout.primaryAlign === 'CENTER') {
                layout.paddingTop += remaining / 2;
            }
            else if (spec.layout.primaryAlign === 'MAX') {
                layout.paddingTop += remaining;
            }
        }
    }
    if (mode === 'GRID' && spec.children.length) {
        layout.cellSize = new Size(Math.max(...spec.children.map((child) => child.frame.width)) * scale, Math.max(...spec.children.map((child) => child.frame.height)) * scale);
    }
}
function applyCounterAlignment(parent, spec, nodeMap, scale, cc) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const mode = (_a = spec.layout) === null || _a === void 0 ? void 0 : _a.mode;
    const alignment = (_b = spec.layout) === null || _b === void 0 ? void 0 : _b.counterAlign;
    if (!mode || !alignment || !['HORIZONTAL', 'VERTICAL'].includes(mode)) {
        return;
    }
    const parentTransform = parent.getComponent(cc.UITransform);
    const parentWidth = Number((_c = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.contentSize) === null || _c === void 0 ? void 0 : _c.width) > 0
        ? Number(parentTransform.contentSize.width)
        : spec.frame.width * scale;
    const parentHeight = Number((_d = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.contentSize) === null || _d === void 0 ? void 0 : _d.height) > 0
        ? Number(parentTransform.contentSize.height)
        : spec.frame.height * scale;
    const layoutWidth = spec.frame.width * scale;
    const layoutHeight = spec.frame.height * scale;
    const left = spec.layout.paddingLeft * scale;
    const right = spec.layout.paddingRight * scale;
    const top = spec.layout.paddingTop * scale;
    const bottom = spec.layout.paddingBottom * scale;
    const parentAnchor = (_e = parentTransform === null || parentTransform === void 0 ? void 0 : parentTransform.anchorPoint) !== null && _e !== void 0 ? _e : { x: 0.5, y: 0.5 };
    for (const childSpec of spec.children) {
        const uuid = nodeMap[childSpec.figmaId];
        const child = uuid ? findByUuid(parent, uuid) : null;
        const transform = child === null || child === void 0 ? void 0 : child.getComponent(cc.UITransform);
        if (!child || !transform) {
            continue;
        }
        const position = child.position.clone();
        if (mode === 'HORIZONTAL') {
            const available = Math.max(0, layoutHeight - top - bottom);
            let topOffset = top;
            if (alignment === 'CENTER') {
                topOffset = top + (available - transform.height) / 2;
            }
            else if (alignment === 'MAX') {
                topOffset = layoutHeight - bottom - transform.height;
            }
            else {
                if (alignment === 'STRETCH') {
                    setImportedContentSize(transform, transform.width, available);
                }
            }
            position.y = parentHeight * (1 - parentAnchor.y)
                - topOffset
                - transform.height * (1 - ((_g = (_f = transform.anchorPoint) === null || _f === void 0 ? void 0 : _f.y) !== null && _g !== void 0 ? _g : 0.5));
        }
        else {
            const available = Math.max(0, layoutWidth - left - right);
            let leftOffset = left;
            if (alignment === 'CENTER') {
                leftOffset = left + (available - transform.width) / 2;
            }
            else if (alignment === 'MAX') {
                leftOffset = layoutWidth - right - transform.width;
            }
            else {
                if (alignment === 'STRETCH') {
                    setImportedContentSize(transform, available, transform.height);
                }
            }
            position.x = leftOffset
                - parentWidth * parentAnchor.x
                + transform.width * ((_j = (_h = transform.anchorPoint) === null || _h === void 0 ? void 0 : _h.x) !== null && _j !== void 0 ? _j : 0.5);
        }
        child.setPosition(position);
    }
}
function logMaskDecision(spec, target = 'node') {
    console.log('[Figma Importer Mask 决策]', JSON.stringify({
        figmaId: spec.figmaId,
        nodeName: spec.name,
        target,
        ...(0, mask_policy_1.shouldGenerateMask)(spec, target),
    }));
}
function assertMaskComponentsOwned(node, cc, guard) {
    for (const type of [cc.Mask, cc.Graphics]) {
        const component = node.getComponent(type);
        if (!component)
            continue;
        if (guard) {
            assertOwnedGeneratedComponent(component, guard, node.name);
        }
        else if (!sessionMaskComponents.has(component)) {
            throw new Error(`节点“${node.name}”上的 ${type.name} 缺少导入器归属记录，已停止更新以保护手工组件；请使用带同步记录的 Prefab 或导入为新节点。`);
        }
    }
}
function configureClip(node, spec, cc, target = 'node', guard) {
    var _a, _b, _c, _d;
    const decision = (0, mask_policy_1.shouldGenerateMask)(spec, target);
    if (!decision.shouldMask)
        return;
    if (target !== 'node')
        logMaskDecision(spec, target);
    assertMaskComponentsOwned(node, cc, guard);
    // Provision Graphics even for inactive nodes so ownership is captured now,
    // not lost when Mask.onLoad creates its renderer on a later activation.
    const graphics = (_a = node.getComponent(cc.Graphics)) !== null && _a !== void 0 ? _a : node.addComponent(cc.Graphics);
    sessionMaskComponents.add(graphics);
    graphics.enabled = true;
    // Mask owns the drawing: clearing here would erase a reused mask when the
    // type stays unchanged (its public setter does not redraw identical types).
    const mask = (_b = node.getComponent(cc.Mask)) !== null && _b !== void 0 ? _b : node.addComponent(cc.Mask);
    sessionMaskComponents.add(mask);
    const maskType = decision.maskType === 'ellipse'
        ? (_c = cc.Mask.Type.GRAPHICS_ELLIPSE) !== null && _c !== void 0 ? _c : cc.Mask.Type.ELLIPSE
        : (_d = cc.Mask.Type.GRAPHICS_RECT) !== null && _d !== void 0 ? _d : cc.Mask.Type.RECT;
    (0, mask_policy_1.setMaskShapeSafely)(mask, maskType);
}
function clipsGeneratedChildren(spec) {
    return (0, mask_policy_1.shouldGenerateMask)(spec).shouldMask;
}
function hasButtonAncestor(node, cc) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.getComponent(cc.Button))
            return true;
    }
    return false;
}
function configureButton(node, spec, cc) {
    var _a;
    if (spec.kind === 'button' && !hasButtonAncestor(node, cc)) {
        const button = (_a = node.getComponent(cc.Button)) !== null && _a !== void 0 ? _a : node.addComponent(cc.Button);
        button.target = node;
        button.transition = cc.Button.Transition.SCALE;
        button.zoomScale = 0.9;
        button.duration = 0.1;
    }
}
function configureScroll(node, spec, transform, scale, cc, guard) {
    var _a, _b, _c, _d, _e;
    if (!(0, mask_policy_1.shouldGenerateMask)(spec, 'scroll-view').shouldMask) {
        return node;
    }
    const { Node, UITransform, ScrollView } = cc;
    let view = node.getChildByName('view');
    let content = (_a = view === null || view === void 0 ? void 0 : view.getChildByName('content')) !== null && _a !== void 0 ? _a : null;
    if (view && guard) {
        assertOwnedHelperSubtree(view, guard);
        if (content) {
            assertOwnedHelperNode(content, guard);
        }
    }
    const scroll = (_b = node.getComponent(ScrollView)) !== null && _b !== void 0 ? _b : node.addComponent(ScrollView);
    if (!view) {
        view = new Node('view');
        view.layer = node.layer;
        node.addChild(view);
    }
    const viewTransform = (_c = view.getComponent(UITransform)) !== null && _c !== void 0 ? _c : view.addComponent(UITransform);
    viewTransform.setAnchorPoint(0.5, 0.5);
    setImportedContentSize(viewTransform, transform.contentSize.width, transform.contentSize.height);
    view.setPosition(0, 0, 0);
    configureClip(view, spec, cc, 'scroll-view', guard);
    if (!content) {
        content = new Node('content');
        content.layer = node.layer;
        view.addChild(content);
    }
    const contentTransform = (_d = content.getComponent(UITransform)) !== null && _d !== void 0 ? _d : content.addComponent(UITransform);
    const previousLayout = content.getComponent(cc.Layout);
    const nextLayoutMode = (_e = spec.layout) === null || _e === void 0 ? void 0 : _e.mode;
    if (previousLayout && (!nextLayoutMode || nextLayoutMode === 'NONE')) {
        if (guard) {
            assertOwnedGeneratedComponent(previousLayout, guard, content.name);
        }
        content.removeComponent(previousLayout);
    }
    contentTransform.setAnchorPoint(0.5, 0.5);
    sizeAndPositionScrollContent(content, contentTransform, spec, transform, scale);
    const legacy = node.getChildByName('__FigmaContent');
    if (legacy && legacy !== content) {
        if (guard) {
            assertOwnedHelperNode(legacy, guard);
        }
        for (const child of [...legacy.children]) {
            setParentKeepingWorld(child, content);
        }
        legacy.removeFromParent();
        legacy.destroy();
    }
    // Cocos Creator 3.8.7 expects the content Node here. ScrollView.view is a
    // getter derived from content.parent and must never be assigned directly.
    if (scroll.content === content) {
        scroll.content = null;
    }
    scroll.content = content;
    const axes = scrollAxes(spec);
    scroll.horizontal = axes.horizontal;
    scroll.vertical = axes.vertical;
    return content;
}
function scrollAxes(spec) {
    const direction = spec.overflowDirection && spec.overflowDirection !== 'NONE'
        ? spec.overflowDirection.trim().toUpperCase()
        : 'VERTICAL_SCROLLING';
    if (direction === 'HORIZONTAL' || direction === 'HORIZONTAL_SCROLLING') {
        return { horizontal: true, vertical: false };
    }
    if (direction === 'BOTH'
        || direction === 'HORIZONTAL_AND_VERTICAL'
        || direction === 'HORIZONTAL_AND_VERTICAL_SCROLLING') {
        return { horizontal: true, vertical: true };
    }
    return { horizontal: false, vertical: true };
}
function sizeAndPositionScrollContent(content, contentTransform, spec, viewport, scale) {
    var _a, _b;
    const viewportWidth = Math.max(0, Number((_a = viewport.contentSize) === null || _a === void 0 ? void 0 : _a.width) || 0);
    const viewportHeight = Math.max(0, Number((_b = viewport.contentSize) === null || _b === void 0 ? void 0 : _b.height) || 0);
    const childRight = spec.children.map((child) => (child.frame.x - spec.frame.x + child.frame.width) * scale);
    const childBottom = spec.children.map((child) => (child.frame.y - spec.frame.y + child.frame.height) * scale);
    const axes = scrollAxes(spec);
    const contentWidth = axes.horizontal
        ? Math.max(viewportWidth, 0, ...childRight)
        : viewportWidth;
    const contentHeight = axes.vertical
        ? Math.max(viewportHeight, 0, ...childBottom)
        : viewportHeight;
    setImportedContentSize(contentTransform, contentWidth, contentHeight);
    // Both helpers use Cocos' default center anchor. Move an oversized content
    // node so its top-left still coincides with the viewport's top-left.
    content.setPosition((contentTransform.contentSize.width - viewportWidth) / 2, (viewportHeight - contentTransform.contentSize.height) / 2, 0);
}
function finalizeScroll(node, spec, content, viewport, scale, cc) {
    if (spec.kind !== 'scrollView' || content === node) {
        return;
    }
    const transform = content.getComponent(cc.UITransform);
    if (!transform) {
        return;
    }
    sizeAndPositionScrollContent(content, transform, spec, viewport, scale);
}
function countSpecs(specs) {
    return specs.reduce((total, spec) => total + 1 + countSpecs(spec.children), 0);
}
function centerInCanvas(node, canvas, UITransform, Vec3) {
    var _a, _b, _c, _d, _e;
    const nodeTransform = node.getComponent(UITransform);
    const canvasTransform = canvas === null || canvas === void 0 ? void 0 : canvas.getComponent(UITransform);
    if (!nodeTransform || !canvasTransform) {
        return;
    }
    const canvasSize = (_a = canvasTransform.contentSize) !== null && _a !== void 0 ? _a : {
        width: canvasTransform.width,
        height: canvasTransform.height,
    };
    const width = Number(canvasSize === null || canvasSize === void 0 ? void 0 : canvasSize.width) > 0 ? Number(canvasSize.width) : 640;
    const height = Number(canvasSize === null || canvasSize === void 0 ? void 0 : canvasSize.height) > 0 ? Number(canvasSize.height) : 1136;
    const canvasAnchor = (_b = canvasTransform.anchorPoint) !== null && _b !== void 0 ? _b : { x: 0.5, y: 0.5 };
    const nodeAnchor = (_c = nodeTransform.anchorPoint) !== null && _c !== void 0 ? _c : { x: 0.5, y: 0.5 };
    const x = width * (0.5 - canvasAnchor.x)
        - nodeTransform.width * (0.5 - nodeAnchor.x);
    const y = height * (0.5 - canvasAnchor.y)
        - nodeTransform.height * (0.5 - nodeAnchor.y);
    node.setPosition(new Vec3(x, y, (_e = (_d = node.position) === null || _d === void 0 ? void 0 : _d.z) !== null && _e !== void 0 ? _e : 0));
}
function nodeComponents(node) {
    var _a;
    const value = (_a = node === null || node === void 0 ? void 0 : node.components) !== null && _a !== void 0 ? _a : node === null || node === void 0 ? void 0 : node._components;
    return Array.isArray(value) ? value : [];
}
function reorderFigmaChildren(parent, orderedNodes) {
    var _a;
    const desired = [...new Set(orderedNodes.filter(Boolean))];
    if (!desired.length || typeof ((_a = desired[0]) === null || _a === void 0 ? void 0 : _a.setSiblingIndex) !== 'function') {
        return;
    }
    // Figma-owned children are kept in Figma order. User-authored children are
    // never reordered against one another; they follow the managed block.
    desired.forEach((node, index) => node.setSiblingIndex(index));
}
function removeStalePrefabNodes(prefabRoot, previousNodeFileIds, previousHelperFileIds, previousComponentFileIds, retainedNodeFileIds) {
    const index = prefabFileIdIndex(prefabRoot);
    const stale = new Map();
    for (const fileId of previousNodeFileIds) {
        if (fileId === nodePrefabFileId(prefabRoot) || retainedNodeFileIds.has(fileId)) {
            continue;
        }
        const node = index.get(fileId);
        if (node) {
            stale.set(fileId, node);
        }
    }
    const staleIds = new Set(stale.keys());
    for (const node of stale.values()) {
        for (const component of nodeComponents(node)) {
            const componentFileId = componentPrefabFileId(component);
            if (!componentFileId || !previousComponentFileIds.has(componentFileId)) {
                throw new Error(`待删除的 Figma 节点“${node.name}”含有手工组件，已停止同步以防止数据丢失。`);
            }
        }
    }
    const salvageManualDescendants = (container, survivorParent) => {
        for (const child of [...container.children]) {
            const childFileId = nodePrefabFileId(child);
            if (childFileId
                && (previousNodeFileIds.has(childFileId) || previousHelperFileIds.has(childFileId))) {
                salvageManualDescendants(child, survivorParent);
            }
            else {
                setParentKeepingWorld(child, survivorParent);
            }
        }
    };
    for (const [fileId, node] of stale) {
        let ancestor = node.parent;
        let nestedUnderStale = false;
        while (ancestor && ancestor !== prefabRoot.parent) {
            const ancestorFileId = nodePrefabFileId(ancestor);
            if (ancestorFileId && staleIds.has(ancestorFileId)) {
                nestedUnderStale = true;
                break;
            }
            ancestor = ancestor.parent;
        }
        if (nestedUnderStale || !node.parent) {
            continue;
        }
        const survivorParent = node.parent;
        salvageManualDescendants(node, survivorParent);
        node.active = false;
        node.removeFromParent();
        node.destroy();
        stale.delete(fileId);
    }
}
function capturePrefabSync(prefabRoot, nodeMap, previous, preexistingNodeUuids, preexistingComponents, generatedClasses, cc) {
    const previousComponents = new Set(previous.managedComponentFileIds);
    const previousHelpers = new Set(previous.managedHelperFileIds);
    const nodeFileIds = {};
    const managedNodes = new Set();
    const managedComponents = new Set();
    const managedHelpers = new Set();
    const managedHelperRuntimeUuids = new Set();
    const mappedUuids = new Set(Object.values(nodeMap));
    const managedRuntimeNodes = new Map();
    for (const [figmaId, uuid] of Object.entries(nodeMap)) {
        if (figmaId === '__root__') {
            continue;
        }
        const node = findByUuid(prefabRoot, uuid);
        if (!node) {
            throw new Error(`Prefab 同步结果缺少 Figma 节点：${figmaId}`);
        }
        const fileId = ensureNodePrefabInfo(node, prefabRoot, cc);
        nodeFileIds[figmaId] = fileId;
        managedNodes.add(fileId);
        managedRuntimeNodes.set(node.uuid, node);
    }
    const managedComponentTypes = new Set([cc.UITransform, ...generatedClasses]);
    for (const node of managedRuntimeNodes.values()) {
        for (const component of nodeComponents(node)) {
            if (!managedComponentTypes.has(component.constructor)) {
                continue;
            }
            const existingFileId = componentPrefabFileId(component);
            if (preexistingComponents.has(component)
                && (!existingFileId || !previousComponents.has(existingFileId))) {
                continue;
            }
            managedComponents.add(ensureComponentPrefabInfo(component, cc));
        }
    }
    walkNodes(prefabRoot, (node) => {
        if (mappedUuids.has(node.uuid) || node === prefabRoot) {
            return;
        }
        const parent = node.parent;
        if (!parent
            || (!mappedUuids.has(parent.uuid) && !managedHelperRuntimeUuids.has(parent.uuid))
            || !isGeneratedHelperNode(node, parent, cc)) {
            return;
        }
        const existingFileId = nodePrefabFileId(node);
        if (preexistingNodeUuids.has(node.uuid)
            && (!existingFileId || !previousHelpers.has(existingFileId))) {
            throw new Error(`节点“${parent.name}”下存在与导入辅助节点同名的手工节点“${node.name}”，已停止同步。`);
        }
        const fileId = ensureNodePrefabInfo(node, prefabRoot, cc);
        managedHelpers.add(fileId);
        managedHelperRuntimeUuids.add(node.uuid);
        for (const component of nodeComponents(node)) {
            const componentFileId = componentPrefabFileId(component);
            if (preexistingComponents.has(component)
                && (!componentFileId || !previousComponents.has(componentFileId))) {
                continue;
            }
            managedComponents.add(ensureComponentPrefabInfo(component, cc));
        }
    });
    return {
        nodeFileIds,
        managedNodeFileIds: [...managedNodes],
        managedComponentFileIds: [...managedComponents],
        managedHelperFileIds: [...managedHelpers],
    };
}
function refreshPrefabLayouts(specs, prefabRoot, nodeMap, scale, cc) {
    const visit = (spec) => {
        var _a, _b, _c;
        const uuid = nodeMap[spec.figmaId];
        const node = uuid ? findByUuid(prefabRoot, uuid) : null;
        if (!node) {
            return;
        }
        const childParent = spec.kind === 'scrollView'
            ? (_b = (_a = node.getChildByName('view')) === null || _a === void 0 ? void 0 : _a.getChildByName('content')) !== null && _b !== void 0 ? _b : node
            : node;
        const layoutMode = (_c = spec.layout) === null || _c === void 0 ? void 0 : _c.mode;
        const layout = spec.action === 'generate' && layoutMode && layoutMode !== 'NONE'
            ? childParent.getComponent(cc.Layout)
            : null;
        layout === null || layout === void 0 ? void 0 : layout.updateLayout();
        if (layout) {
            applyCounterAlignment(childParent, spec, nodeMap, scale, cc);
        }
        if (spec.kind === 'scrollView' && childParent !== node) {
            finalizeScroll(node, spec, childParent, node.getComponent(cc.UITransform), scale, cc);
        }
        spec.children.forEach(visit);
    };
    specs.forEach(visit);
}
function emitSceneProgress(payload, value, message) {
    try {
        Editor.Message.send(payload.packageName, 'progress', {
            phase: 'scene',
            value,
            message,
        });
    }
    catch {
        // 进度反馈不可用时不应中断场景导入。
    }
}
function load() { }
function unload() { }
exports.methods = {
    refreshReviewAfter: import_review_scene_1.refreshReviewAfter,
    prepareReviewRemoval: import_review_scene_1.prepareReviewRemoval,
    finishReviewRemoval: import_review_scene_1.finishReviewRemoval,
    inspectPrefabContext(payload) {
        return prefabEditingState(payload.prefabUuid, payload.rootFileId);
    },
    async importDocument(payload) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const cc = require('cc');
        const { director, Node, UITransform, Canvas, Graphics, Sprite, Label, RichText, LabelOutline, Layout, ScrollView, Mask, Button, UIOpacity, Camera, } = cc;
        const scene = director.getScene();
        if (!scene) {
            throw new Error('当前没有打开的场景。');
        }
        const prefabContext = payload.prefabContext;
        let prefabRoot = null;
        if (prefabContext) {
            const state = prefabEditingState(prefabContext.prefabUuid, prefabContext.rootFileId);
            if (!state.ready) {
                throw new Error(`目标 Prefab 尚未安全打开：${(_a = state.reason) !== null && _a !== void 0 ? _a : '未知原因'}`);
            }
            prefabRoot = globalThis.cce.Scene.rootNode;
            const fileIdIndex = prefabFileIdIndex(prefabRoot, prefabContext.prefabUuid);
            const existingMap = {
                __root__: prefabRoot.uuid,
            };
            for (const [figmaId, fileId] of Object.entries(prefabContext.existingNodeFileIds)) {
                const node = fileIdIndex.get(fileId);
                if (node) {
                    existingMap[figmaId] = node.uuid;
                }
            }
            payload.updateExisting = true;
            payload.existingMap = existingMap;
            payload.centerInCanvas = false;
        }
        const preexistingPrefabNodeUuids = new Set();
        const preexistingPrefabComponents = new Set();
        if (prefabRoot) {
            walkNodes(prefabRoot, (node) => {
                preexistingPrefabNodeUuids.add(node.uuid);
                nodeComponents(node).forEach((component) => {
                    preexistingPrefabComponents.add(component);
                });
            });
        }
        const roots = payload.roots.map((root) => normalizeSceneSpec(root));
        if (prefabContext && roots.length !== 1) {
            throw new Error('Prefab 增量同步只允许一个 Figma Frame 根节点。');
        }
        const fallbackParent = (_c = (_b = prefabRoot === null || prefabRoot === void 0 ? void 0 : prefabRoot.parent) !== null && _b !== void 0 ? _b : findCanvas(scene, Canvas)) !== null && _c !== void 0 ? _c : scene;
        const directRoot = roots.length === 1;
        const canvas = prefabRoot ? null : findCanvas(scene, Canvas);
        const generatedClasses = [
            LabelOutline,
            Mask,
            Graphics,
            Sprite,
            Label,
            RichText,
            Layout,
            ScrollView,
            Button,
            UIOpacity,
        ];
        const nodeMap = {};
        let created = 0;
        let updated = 0;
        const totalNodes = Math.max(1, countSpecs(roots));
        let completedNodes = 0;
        const previousManagedComponents = new Set((_d = prefabContext === null || prefabContext === void 0 ? void 0 : prefabContext.managedComponentFileIds) !== null && _d !== void 0 ? _d : []);
        const previousManagedHelpers = new Set((_e = prefabContext === null || prefabContext === void 0 ? void 0 : prefabContext.managedHelperFileIds) !== null && _e !== void 0 ? _e : []);
        const prefabOwnershipGuard = prefabContext
            ? {
                previousHelperFileIds: previousManagedHelpers,
                previousComponentFileIds: previousManagedComponents,
                preexistingNodeUuids: preexistingPrefabNodeUuids,
                preexistingComponents: preexistingPrefabComponents,
            }
            : undefined;
        const existingRootUuid = payload.updateExisting
            ? payload.existingMap.__root__
            : undefined;
        let existingRootNode = existingRootUuid
            ? findByUuid(scene, existingRootUuid)
            : null;
        if (existingRootNode === null || existingRootNode === void 0 ? void 0 : existingRootNode.getComponent(Camera)) {
            existingRootNode = null;
        }
        // In a direct-root import, __root__ aliases the Figma root UUID. In a
        // multi-root import it identifies a synthetic wrapper and must never be
        // reused as one of its own children when the root count changes.
        const existingRootWasDirect = Boolean(existingRootUuid
            && Object.entries(payload.existingMap).some(([figmaId, uuid]) => figmaId !== '__root__' && uuid === existingRootUuid));
        const previousDirectRoot = existingRootWasDirect ? existingRootNode : null;
        const previousWrapper = !existingRootWasDirect ? existingRootNode : null;
        const mappedRootUuid = directRoot
            ? existingUuidForSpec(payload.existingMap, roots[0])
            : (!existingRootWasDirect ? existingRootUuid : undefined);
        let importRoot = prefabRoot !== null && prefabRoot !== void 0 ? prefabRoot : (payload.updateExisting && mappedRootUuid
            ? findByUuid(scene, mappedRootUuid)
            : null);
        if (!prefabContext && (importRoot === null || importRoot === void 0 ? void 0 : importRoot.getComponent(Camera))) {
            importRoot = null;
        }
        const legacyWrapper = directRoot
            ? previousWrapper !== null && previousWrapper !== void 0 ? previousWrapper : (((_f = importRoot === null || importRoot === void 0 ? void 0 : importRoot.parent) === null || _f === void 0 ? void 0 : _f.name.startsWith('Figma · '))
                ? importRoot.parent
                : null)
            : null;
        const reusedImportRoot = Boolean(importRoot);
        const reviewBefore = payload.reviewId
            ? (0, import_review_scene_1.captureReviewScene)(importRoot !== null && importRoot !== void 0 ? importRoot : existingRootNode, cc, payload.existingMap, (_g = prefabContext === null || prefabContext === void 0 ? void 0 : prefabContext.managedComponentFileIds) !== null && _g !== void 0 ? _g : (0, import_review_scene_1.reviewManagedComponentIds)(importRoot !== null && importRoot !== void 0 ? importRoot : existingRootNode, payload.existingMap, [UITransform, ...generatedClasses]))
            : undefined;
        const parent = fallbackParent;
        if (!directRoot) {
            if (!importRoot) {
                importRoot = new Node(`Figma · ${cleanName(payload.rootName)}`);
                parent.addChild(importRoot);
                created += 1;
            }
            else {
                importRoot.parent = parent;
                importRoot.name = `Figma · ${cleanName(payload.rootName)}`;
                updated += 1;
            }
            const rootTransform = (_h = importRoot.getComponent(UITransform)) !== null && _h !== void 0 ? _h : importRoot.addComponent(UITransform);
            rootTransform.setAnchorPoint(0.5, 0.5);
            setImportedContentSize(rootTransform, payload.rootFrame.width * payload.scale, payload.rootFrame.height * payload.scale);
            importRoot.setPosition(0, 0, 0);
            nodeMap.__root__ = importRoot.uuid;
        }
        else if (!importRoot) {
            importRoot = new Node(cleanName(roots[0].name));
            parent.addChild(importRoot);
        }
        // A collapsed SceneSpec can intentionally map several Figma IDs to a
        // single Cocos node. If a later import expands that subtree again,
        // those IDs still point at the same old UUID. Claim each reusable node
        // once per build so a child can never reuse (and reparent) its parent.
        const claimedNodeUuids = new Set();
        const build = async (spec, nodeParent, providedNode) => {
            var _a, _b, _c;
            logMaskDecision(spec);
            let node = providedNode !== null && providedNode !== void 0 ? providedNode : null;
            if (!node && payload.updateExisting) {
                for (const figmaId of figmaIdsForSpec(spec)) {
                    const mappedUuid = payload.existingMap[figmaId];
                    const mappedNode = mappedUuid ? findByUuid(scene, mappedUuid) : null;
                    if (mappedNode && !claimedNodeUuids.has(mappedNode.uuid)) {
                        node = mappedNode;
                        break;
                    }
                }
            }
            if (node && claimedNodeUuids.has(node.uuid)) {
                node = null;
            }
            const existed = Boolean(node);
            if (!node) {
                node = new Node(cleanName(spec.name));
                created += 1;
            }
            else {
                updated += 1;
            }
            if (spec.action !== 'transform' && !prefabOwnershipGuard) {
                if (node.getComponent(Mask) || clipsGeneratedChildren(spec)) {
                    assertMaskComponentsOwned(node, cc);
                }
                // Include generated view/tiled helpers before any deletion or
                // reconfiguration. Never infer ownership from their names alone.
                for (const helper of node.children.filter((child) => isGeneratedHelperNode(child, node, cc))) {
                    if (helper.getComponent(Mask))
                        assertMaskComponentsOwned(helper, cc);
                }
            }
            if (prefabOwnershipGuard && existed) {
                const existingTransform = node.getComponent(UITransform);
                if (existingTransform) {
                    assertOwnedGeneratedComponent(existingTransform, prefabOwnershipGuard, node.name);
                }
                if (spec.action !== 'transform') {
                    for (const helper of node.children.filter((child) => isGeneratedHelperNode(child, node, cc)
                        || (spec.kind === 'scrollView' && child.name === 'view'))) {
                        assertOwnedHelperSubtree(helper, prefabOwnershipGuard);
                        if (spec.kind === 'scrollView' && helper.name === 'view') {
                            const content = (_a = helper.getChildByName) === null || _a === void 0 ? void 0 : _a.call(helper, 'content');
                            if (content) {
                                assertOwnedHelperNode(content, prefabOwnershipGuard);
                            }
                        }
                        if (helper.name === TILED_MASK_NODE_NAME) {
                            const tiledSprite = (_b = helper.getChildByName) === null || _b === void 0 ? void 0 : _b.call(helper, TILED_SPRITE_NODE_NAME);
                            if (tiledSprite) {
                                assertOwnedHelperNode(tiledSprite, prefabOwnershipGuard);
                            }
                        }
                    }
                    for (const component of nodeComponents(node)) {
                        if (generatedClasses.includes(component.constructor)) {
                            assertOwnedGeneratedComponent(component, prefabOwnershipGuard, node.name);
                        }
                    }
                }
            }
            claimedNodeUuids.add(node.uuid);
            if (!(prefabContext && node === prefabRoot)) {
                node.parent = nodeParent;
            }
            node.name = cleanName(spec.name);
            for (const figmaId of figmaIdsForSpec(spec)) {
                nodeMap[figmaId] = node.uuid;
            }
            configureGeometry(node, spec, payload.scale, cc);
            if (spec.action !== 'transform') {
                removeObsoleteScrollHelpers(node, spec, cc, prefabOwnershipGuard);
                await removeObsoleteLabelOutline(node, cc);
                const preserved = desiredGeneratedComponents(spec, cc, node);
                // Mask owns and disables its shared Graphics during the
                // deferred onDisable phase. If clipping was removed but a
                // normal Graphics renderer is still desired, recreate that
                // renderer only after the old Mask lifecycle has completed.
                if (!preserved.has(Mask)
                    && node.getComponent(Mask)
                    && preserved.has(Graphics)) {
                    preserved.delete(Graphics);
                }
                const removedRenderComponent = removeGeneratedComponents(node, generatedClasses, preserved, [Graphics, Sprite, Label, RichText], prefabContext ? previousManagedComponents : undefined);
                if (removedRenderComponent) {
                    await waitForDeferredComponentRemoval();
                }
                removeGeneratedBackground(node, prefabOwnershipGuard);
                const tiledSpriteHelper = usesTiledSpriteHelper(spec);
                const overflowSpriteHelper = usesOverflowSpriteHelper(spec);
                if (!tiledSpriteHelper) {
                    removeGeneratedTiledNodes(node, prefabOwnershipGuard);
                }
                if (!overflowSpriteHelper) {
                    removeGeneratedOverflowVisual(node, prefabOwnershipGuard);
                }
                configureGeometry(node, spec, payload.scale, cc);
                const clipsChildren = clipsGeneratedChildren(spec);
                if (spec.action === 'render' || spec.sprite) {
                    if (!spec.sprite) {
                        throw new Error(`PNG 整层节点“${spec.name}”没有绑定 SpriteFrame，资源可能未成功导入。`);
                    }
                    if (tiledSpriteHelper) {
                        await configureTiledSpriteHelper(node, spec, payload.scale, cc, prefabOwnershipGuard);
                    }
                    else if (overflowSpriteHelper) {
                        await configureOverflowSpriteHelper(node, spec, payload.scale, cc, prefabOwnershipGuard);
                    }
                    else {
                        await configureSprite(node, spec, payload.scale, cc);
                    }
                }
                else if (spec.kind === 'richText') {
                    configureRichText(node, spec, payload.scale, cc);
                    const richText = node.getComponent(RichText);
                    if (spec.fontUuid) {
                        const font = await loadAsset(cc.assetManager, spec.fontUuid);
                        if (cc.TTFFont && !(font instanceof cc.TTFFont)) {
                            throw new Error(`RichText 节点“${spec.name}”只能使用 TTF/OTF 字体，当前映射可能是 BitmapFont（.fnt）。`);
                        }
                        richText.font = font;
                    }
                    else {
                        richText.font = null;
                    }
                }
                else if (spec.kind === 'label' || spec.figmaType === 'TEXT') {
                    configureLabel(node, spec, payload.scale, cc);
                    if (spec.fontUuid) {
                        const label = node.getComponent(Label);
                        label.font = await loadAsset(cc.assetManager, spec.fontUuid);
                    }
                    else {
                        node.getComponent(Label).font = null;
                    }
                }
                else if (RASTER_VECTOR_TYPES.has(spec.figmaType)) {
                    throw new Error(`矢量节点“${spec.name}”没有绑定 SpriteFrame，PNG 资源可能未成功导入。`);
                }
                else if (clipsChildren) {
                    configureClip(node, spec, cc, 'node', prefabOwnershipGuard);
                }
                else if (hasGraphicsVisual(spec)) {
                    configureGraphics(node, spec, payload.scale, cc);
                }
                configureOpacity(node, spec, cc);
                configureButton(node, spec, cc);
            }
            const transform = node.getComponent(UITransform);
            const childParent = spec.action === 'transform'
                ? node
                : configureScroll(node, spec, transform, payload.scale, cc, prefabOwnershipGuard);
            if (spec.action === 'generate') {
                configureLayout(childParent, spec, payload.scale, cc);
            }
            for (const child of spec.children) {
                await build(child, childParent);
            }
            if (prefabContext) {
                reorderFigmaChildren(childParent, spec.children.map((child) => {
                    const uuid = nodeMap[child.figmaId];
                    return uuid ? findByUuid(childParent, uuid) : null;
                }));
            }
            const layoutMode = (_c = spec.layout) === null || _c === void 0 ? void 0 : _c.mode;
            const layout = spec.action === 'generate' && layoutMode && layoutMode !== 'NONE'
                ? childParent.getComponent(Layout)
                : null;
            layout === null || layout === void 0 ? void 0 : layout.updateLayout();
            if (layout) {
                applyCounterAlignment(childParent, spec, nodeMap, payload.scale, cc);
            }
            finalizeScroll(node, spec, childParent, transform, payload.scale, cc);
            if (!existed && spec.action === 'transform') {
                node.name += ' · Transform';
            }
            completedNodes += 1;
            emitSceneProgress(payload, completedNodes / totalNodes, `构建节点 ${completedNodes}/${totalNodes} · ${spec.name}`);
        };
        try {
            for (const root of roots) {
                await build(root, directRoot ? parent : importRoot, directRoot ? importRoot : undefined);
            }
            if (payload.updateExisting && !prefabContext) {
                removeCollapsedMappedDescendants(importRoot, payload.existingMap, nodeMap, roots, cc);
            }
            if (directRoot) {
                nodeMap.__root__ = importRoot.uuid;
                if (payload.centerInCanvas && canvas) {
                    centerInCanvas(importRoot, canvas, UITransform, cc.Vec3);
                }
            }
            const retainedUuids = new Set(Object.values(nodeMap));
            const staleTransitionUuids = new Set(Object.entries(payload.existingMap)
                .filter(([figmaId, uuid]) => figmaId !== '__root__' && !retainedUuids.has(uuid))
                .map(([, uuid]) => uuid));
            if (!prefabContext && legacyWrapper && legacyWrapper !== importRoot && legacyWrapper.parent) {
                removeMappedNodeTree(legacyWrapper, parent, staleTransitionUuids, cc);
            }
            if (!prefabContext && previousDirectRoot
                && previousDirectRoot !== importRoot
                && !retainedUuids.has(previousDirectRoot.uuid)
                && previousDirectRoot.parent) {
                removeMappedNodeTree(previousDirectRoot, directRoot ? parent : importRoot, staleTransitionUuids, cc);
            }
            if (!prefabContext) {
                mergePreservedMappings(importRoot, payload.existingMap, nodeMap);
            }
        }
        catch (error) {
            if (!reusedImportRoot) {
                salvageExistingMappedNodes(importRoot, parent, new Set(Object.values(payload.existingMap)));
                importRoot.removeFromParent();
                importRoot.destroy();
            }
            throw error;
        }
        let prefabSync;
        if (prefabContext) {
            const retainedNodeFileIds = new Set();
            for (const [figmaId, uuid] of Object.entries(nodeMap)) {
                if (figmaId === '__root__') {
                    continue;
                }
                const node = findByUuid(importRoot, uuid);
                if (!node) {
                    throw new Error(`无法定位导入后的节点：${figmaId}`);
                }
                retainedNodeFileIds.add(ensureNodePrefabInfo(node, importRoot, cc));
            }
            removeStalePrefabNodes(importRoot, new Set(prefabContext.managedNodeFileIds), previousManagedHelpers, previousManagedComponents, retainedNodeFileIds);
            refreshPrefabLayouts(roots, importRoot, nodeMap, payload.scale, cc);
            prefabSync = capturePrefabSync(importRoot, nodeMap, prefabContext, preexistingPrefabNodeUuids, preexistingPrefabComponents, [UITransform, ...generatedClasses], cc);
            if (nodePrefabFileId(importRoot) !== prefabContext.rootFileId) {
                throw new Error('Prefab 根节点 fileId 在同步过程中发生变化，已拒绝保存。');
            }
        }
        return {
            reviewBefore,
            reviewAfter: payload.reviewId ? (0, import_review_scene_1.registerSceneReview)(payload.reviewId, importRoot, cc, nodeMap, (_j = prefabSync === null || prefabSync === void 0 ? void 0 : prefabSync.managedComponentFileIds) !== null && _j !== void 0 ? _j : (0, import_review_scene_1.reviewManagedComponentIds)(importRoot, nodeMap, [UITransform, ...generatedClasses]), prefabContext
                ? { targetUuid: prefabContext.prefabUuid, mode: 'prefab' } : undefined) : undefined,
            rootUuid: importRoot.uuid,
            nodeMap,
            created,
            updated,
            temporaryRoot: !prefabContext && directRoot && !reusedImportRoot,
            prefabSync,
        };
    },
    removeImportedNode(payload) {
        const cc = require('cc');
        const scene = cc.director.getScene();
        const node = scene ? findByUuid(scene, payload.rootUuid) : null;
        if (!node) {
            return false;
        }
        // Stop rendering immediately. Cocos destroys nodes at the end of the
        // frame, so removing the parent alone can leave a one-frame ghost.
        node.active = false;
        node.removeFromParent();
        node.destroy();
        return true;
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBa3VEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBcHVEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFDL0MsK0NBQXVFO0FBRXZFLCtEQUNpRztBQUdqRyxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFBLFdBQUksRUFBQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxjQUFjLENBQUMsQ0FBQyxDQUFDO0FBNEJ6RCxNQUFNLG9CQUFvQixHQUFHLG1CQUFtQixDQUFDO0FBQ2pELE1BQU0sb0JBQW9CLEdBQUcsa0JBQWtCLENBQUM7QUFDaEQsTUFBTSxzQkFBc0IsR0FBRyxvQkFBb0IsQ0FBQztBQUNwRCxNQUFNLHlCQUF5QixHQUFHLHVCQUF1QixDQUFDO0FBQzFELDZFQUE2RTtBQUM3RSwyRUFBMkU7QUFDM0UsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLE9BQU8sRUFBVSxDQUFDO0FBQ3BELE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDaEMsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtDQUNwQixDQUFDLENBQUM7QUFFSCxTQUFTLFNBQVMsQ0FBQyxLQUFhOztJQUM1QixPQUFPLE1BQUEsSUFBQSw0QkFBZ0IsRUFBQyxLQUFLLENBQUMsbUNBQUksWUFBWSxDQUFDO0FBQ25ELENBQUM7QUFFRCxTQUFTLE9BQU8sQ0FBQyxLQUFVLEVBQUUsS0FBNkIsRUFBRSxPQUFPLEdBQUcsQ0FBQzs7SUFDbkUsTUFBTSxNQUFNLEdBQUcsS0FBSyxhQUFMLEtBQUssY0FBTCxLQUFLLEdBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUs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QUNoRSxVQUFVO1NBQ2IsQ0FBQztJQUNOLENBQUM7SUFFRCxrQkFBa0IsQ0FBQyxPQUE2QjtRQUM1QyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFRLENBQUM7UUFDaEMsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNyQyxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDaEUsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ1IsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUNELHFFQUFxRTtRQUNyRSxtRUFBbUU7UUFDbkUsSUFBSSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDcEIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2YsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgRmlnbWFDb2xvcixcclxuICAgIEZpZ21hUGFpbnQsXHJcbiAgICBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIFJlY3QsXHJcbiAgICBTY2VuZU5vZGVTcGVjLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQgeyBzaG91bGRHZW5lcmF0ZU1hc2ssIHNldE1hc2tTaGFwZVNhZmVseSB9IGZyb20gJy4vbWFzay1wb2xpY3knO1xuaW1wb3J0IHR5cGUgeyBNYXNrVGFyZ2V0IH0gZnJvbSAnLi9tYXNrLXBvbGljeSc7XG5pbXBvcnQgeyBjYXB0dXJlUmV2aWV3U2NlbmUsIHJlZ2lzdGVyU2NlbmVSZXZpZXcsIHJldmlld01hbmFnZWRDb21wb25lbnRJZHMsXG4gICAgcHJlcGFyZVJldmlld1JlbW92YWwsIGZpbmlzaFJldmlld1JlbW92YWwsIHJlZnJlc2hSZXZpZXdBZnRlciB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1zY2VuZSc7XG5pbXBvcnQgdHlwZSB7IFJldmlld1NjZW5lIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3LW1vZGVsJztcblxyXG5tb2R1bGUucGF0aHMucHVzaChqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpKTtcclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcmV2aWV3SWQ/OiBzdHJpbmc7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcmV2aWV3QmVmb3JlPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXdBZnRlcj86IFJldmlld1NjZW5lO1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG59XHJcblxyXG5jb25zdCBCQUNLR1JPVU5EX05PREVfTkFNRSA9ICdfX0ZpZ21hQmFja2dyb3VuZCc7XHJcbmNvbnN0IFRJTEVEX01BU0tfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZE1hc2snO1xyXG5jb25zdCBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZFNwcml0ZSc7XHJcbmNvbnN0IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUgPSAnX19GaWdtYU92ZXJmbG93VmlzdWFsJztcclxuLy8gU2NlbmUtb25seSB1cGRhdGVzIGhhdmUgbm8gcGVyc2lzdGVkIFByZWZhYiBvd25lcnNoaXAgc25hcHNob3QuIEtlZXAgZXhhY3RcclxuLy8gY29tcG9uZW50IGlkZW50aXRpZXMgZm9yIHRoaXMgc2Vzc2lvbjsgdW5rbm93bi9sZWdhY3kgbWFza3MgZmFpbCBjbG9zZWQuXHJcbmNvbnN0IHNlc3Npb25NYXNrQ29tcG9uZW50cyA9IG5ldyBXZWFrU2V0PG9iamVjdD4oKTtcclxuY29uc3QgUkFTVEVSX1ZFQ1RPUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ1ZFQ1RPUicsXHJcbiAgICAnQk9PTEVBTl9PUEVSQVRJT04nLFxyXG4gICAgJ1NUQVInLFxyXG4gICAgJ0xJTkUnLFxyXG4gICAgJ1JFR1VMQVJfUE9MWUdPTicsXHJcbl0pO1xyXG5cclxuZnVuY3Rpb24gY2xlYW5OYW1lKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNhbml0aXplTm9kZU5hbWUoaW5wdXQpID8/ICdGaWdtYSBOb2RlJztcclxufVxyXG5cclxuZnVuY3Rpb24gdG9Db2xvcihDb2xvcjogYW55LCB2YWx1ZTogRmlnbWFDb2xvciB8IHVuZGVmaW5lZCwgb3BhY2l0eSA9IDEpOiBhbnkge1xyXG4gICAgY29uc3Qgc291cmNlID0gdmFsdWUgPz8geyByOiAwLCBnOiAwLCBiOiAwLCBhOiAxIH07XHJcbiAgICByZXR1cm4gbmV3IENvbG9yKFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLnIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UuZykpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5iKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgKHNvdXJjZS5hID8/IDEpICogb3BhY2l0eSkpICogMjU1KSxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRCeVV1aWQocm9vdDogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkgfCBudWxsIHtcclxuICAgIGlmIChyb290LnV1aWQgPT09IHV1aWQpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZEJ5VXVpZChjaGlsZCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKGZvdW5kKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZVByZWZhYkZpbGVJZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQ6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGNvbXBvbmVudD8uX19wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2Fsa05vZGVzKHJvb3Q6IGFueSwgdmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIHZpc2l0KHJvb3QpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuID8/IFtdKSB7XHJcbiAgICAgICAgd2Fsa05vZGVzKGNoaWxkLCB2aXNpdCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkFzc2V0VXVpZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgYXNzZXQgPSBub2RlPy5fcHJlZmFiPy5hc3NldDtcclxuICAgIGNvbnN0IHZhbHVlID0gYXNzZXQ/Ll91dWlkID8/IGFzc2V0Py51dWlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJGaWxlSWRJbmRleChyb290OiBhbnksIGV4cGVjdGVkUHJlZmFiVXVpZD86IHN0cmluZyk6IE1hcDxzdHJpbmcsIGFueT4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIHdhbGtOb2Rlcyhyb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHByZWZhYlJvb3QgPSBub2RlPy5fcHJlZmFiPy5yb290O1xyXG4gICAgICAgIGlmIChub2RlICE9PSByb290ICYmIHByZWZhYlJvb3QgJiYgcHJlZmFiUm9vdCAhPT0gcm9vdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFzc2V0VXVpZCA9IHByZWZhYkFzc2V0VXVpZChub2RlKTtcclxuICAgICAgICBpZiAoZXhwZWN0ZWRQcmVmYWJVdWlkICYmIGFzc2V0VXVpZCAmJiBhc3NldFV1aWQgIT09IGV4cGVjdGVkUHJlZmFiVXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKCFmaWxlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocmVzdWx0LmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjeiKgueCuSBmaWxlSWTvvJoke2ZpbGVJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0LnNldChmaWxlSWQsIG5vZGUpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGUuY29tcG9uZW50cyA/PyBub2RlLl9jb21wb25lbnRzID8/IFtdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjee7hOS7tiBmaWxlSWTvvJoke2NvbXBvbmVudEZpbGVJZH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wb25lbnRGaWxlSWRzLmFkZChjb21wb25lbnRGaWxlSWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRWRpdGluZ1N0YXRlKFxyXG4gICAgZXhwZWN0ZWRVdWlkOiBzdHJpbmcsXHJcbiAgICBleHBlY3RlZFJvb3RGaWxlSWQ/OiBzdHJpbmcsXHJcbik6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNvbnN0IG1vZGUgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5TW9kZT8uKCkgPz8gJycpO1xyXG4gICAgY29uc3QgY3VycmVudFV1aWQgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5Q3VycmVudFNjZW5lVXVpZD8uKCkgPz8gJycpO1xyXG4gICAgY29uc3Qgcm9vdCA9IGNjZUFwaT8uU2NlbmU/LnJvb3ROb2RlID8/IG51bGw7XHJcbiAgICBjb25zdCByb290RmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChyb290KTtcclxuICAgIGxldCByZWFzb24gPSAnJztcclxuICAgIGlmIChtb2RlICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3nvJbovpHmqKHlvI/kuLogJHttb2RlIHx8ICd1bmtub3duJ33vvIzlsJrmnKrov5vlhaUgUHJlZmFiYDtcclxuICAgIH0gZWxzZSBpZiAoY3VycmVudFV1aWQgIT09IGV4cGVjdGVkVXVpZCkge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3otYTmupAgVVVJRCDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtGA7XHJcbiAgICB9IGVsc2UgaWYgKCFyb290KSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrnlsJrmnKrlsLHnu6onO1xyXG4gICAgfSBlbHNlIGlmIChleHBlY3RlZFJvb3RGaWxlSWQgJiYgcm9vdEZpbGVJZCAhPT0gZXhwZWN0ZWRSb290RmlsZUlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOS4juadpea6kOiusOW9leS4jeS4gOiHtCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHJlYWR5OiAhcmVhc29uLFxyXG4gICAgICAgIG1vZGUsXHJcbiAgICAgICAgY3VycmVudFV1aWQsXHJcbiAgICAgICAgcm9vdFV1aWQ6IHJvb3Q/LnV1aWQsXHJcbiAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICByZWFzb246IHJlYXNvbiB8fCB1bmRlZmluZWQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gKGdsb2JhbFRoaXMgYXMgYW55KS5FZGl0b3I/LlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgaWYgKHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIGdlbmVyYXRlZDtcclxuICAgIH1cclxuICAgIC8vIFVuaXQtdGVzdC9oZWFkbGVzcyBmYWxsYmFjay4gVGhlIHJlYWwgQ3JlYXRvciBzY2VuZSBwcm9jZXNzIGFsd2F5cyB1c2VzXHJcbiAgICAvLyBFZGl0b3IuVXRpbHMuVVVJRC5nZW5lcmF0ZSh0cnVlKSwgc28gcHJvZHVjdGlvbiBJRHMgZm9sbG93IENyZWF0b3IncyBvd24gZm9ybWF0LlxyXG4gICAgcmV0dXJuIGBmaWdtYSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxNCl9YDtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZTogYW55LCBwcmVmYWJSb290OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY2NlQXBpPy5QcmVmYWI/Lm9uQWRkTm9kZT8uKG5vZGUpO1xyXG4gICAgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgUHJlZmFiSW5mbyA9IGNjLlByZWZhYj8uX3V0aWxzPy5QcmVmYWJJbmZvID8/IGNjLlByZWZhYkluZm87XHJcbiAgICBpZiAoIVByZWZhYkluZm8pIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIDMuOC43IFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOiKgueCueeUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5yb290ID0gcHJlZmFiUm9vdDtcclxuICAgIGluZm8uYXNzZXQgPSBwcmVmYWJSb290Py5fcHJlZmFiPy5hc3NldCA/PyBudWxsO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgaW5mby5pbnN0YW5jZSA9IG51bGw7XHJcbiAgICBpbmZvLnRhcmdldE92ZXJyaWRlcyA9IG51bGw7XHJcbiAgICBub2RlLl9wcmVmYWIgPSBpbmZvO1xyXG4gICAgcmV0dXJuIGluZm8uZmlsZUlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudDogYW55LCBjYzogYW55KTogc3RyaW5nIHtcclxuICAgIGxldCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGRDb21wb25lbnQ/Lihjb21wb25lbnQpO1xyXG4gICAgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IENvbXBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LkNvbXBQcmVmYWJJbmZvID8/IGNjLkNvbXBQcmVmYWJJbmZvO1xyXG4gICAgaWYgKCFDb21wUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgQ29tcFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOe7hOS7tueUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgQ29tcFByZWZhYkluZm8oKTtcclxuICAgIGluZm8uZmlsZUlkID0gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTtcclxuICAgIGNvbXBvbmVudC5fX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldFBhcmVudEtlZXBpbmdXb3JsZChub2RlOiBhbnksIHBhcmVudDogYW55KTogdm9pZCB7XHJcbiAgICBpZiAodHlwZW9mIG5vZGUuc2V0UGFyZW50ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgbm9kZS5zZXRQYXJlbnQocGFyZW50LCB0cnVlKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgbm9kZS5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZDogYW55LCBwYXJlbnQ6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKGNoaWxkLm5hbWUgPT09IEJBQ0tHUk9VTkRfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09ICdfX0ZpZ21hQ29udGVudCcpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmIChjaGlsZC5uYW1lID09PSAndmlldycgJiYgcGFyZW50LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2hpbGQubmFtZSA9PT0gJ2NvbnRlbnQnXHJcbiAgICAgICAgJiYgcGFyZW50Lm5hbWUgPT09ICd2aWV3J1xyXG4gICAgICAgICYmIHBhcmVudC5wYXJlbnQ/LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBzdGFsZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDE7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChzdGFsZVV1aWRzLmhhcyhjaGlsZC51dWlkKSB8fCBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKSkge1xyXG4gICAgICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc3Vydml2b3JQYXJlbnQpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplU2NlbmVTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBTY2VuZU5vZGVTcGVjIHtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzcGVjLmFjdGlvbiBhcyB1bmtub3duKTtcclxuICAgIGNvbnN0IGtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHNwZWMua2luZCwgYWN0aW9uKTtcclxuICAgIGNvbnN0IGNoaWxkcmVuID0gQXJyYXkuaXNBcnJheShzcGVjLmNoaWxkcmVuKSA/IHNwZWMuY2hpbGRyZW4gOiBbXTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uc3BlYyxcclxuICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBjaGlsZHJlbjogaXNUZXJtaW5hbEFjdGlvbihhY3Rpb24pIHx8IHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSB0cnVlXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBjaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBub3JtYWxpemVTY2VuZVNwZWMoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgaWRzID0gW3NwZWMuZmlnbWFJZCwgLi4uKHNwZWMuYWxpYXNGaWdtYUlkcyA/PyBbXSldXHJcbiAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwICYmIGlkICE9PSAnX19yb290X18nKTtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChpZHMpXTtcclxufVxyXG5cclxuZnVuY3Rpb24gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBmaWdtYUlkc0ZvclNwZWMoc3BlYykuZmlsdGVyKChmaWdtYUlkKSA9PiBmaWdtYUlkICE9PSBzcGVjLmZpZ21hSWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGlzdGluZ1V1aWRGb3JTcGVjKFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBleGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIGlmICh0eXBlb2Ygc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09ICdib29sZWFuJykge1xyXG4gICAgICAgIHJldHVybiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeTtcclxuICAgIH1cclxuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIFNjZW5lU3BlY3MgcGVyc2lzdGVkIGJ5IGltcG9ydGVyIHZlcnNpb25zXHJcbiAgICAvLyBiZWZvcmUgZmxhdHRlbkJvdW5kYXJ5IHdhcyBpbnRyb2R1Y2VkLiBOZXcgcGxhbnMgYWx3YXlzIHNldCB0aGUgZmxhZyBzb1xyXG4gICAgLy8gZm9sZGVkIExhYmVscyBhbmQgb3RoZXIgcHJvbW90ZWQgdmlzdWFscyB1c2UgdGhlIHNhbWUgY2xlYW51cCBzZW1hbnRpY3MuXHJcbiAgICByZXR1cm4gc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInXHJcbiAgICAgICAgfHwgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIEJvb2xlYW4oc3BlYy5zcHJpdGUpICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID09PSAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlQ29sbGFwc2VkTWFwcGVkRGVzY2VuZGFudHMoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMoY3VycmVudE1hcCkpO1xyXG4gICAgY29uc3QgYm91bmRhcnlTcGVjczogQXJyYXk8e1xyXG4gICAgICAgIGZpZ21hSWQ6IHN0cmluZztcclxuICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGJvb2xlYW47XHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogU2V0PHN0cmluZz47XHJcbiAgICB9PiA9IFtdO1xyXG4gICAgY29uc3QgY29sbGVjdEJvdW5kYXJpZXMgPSAobm9kZXM6IFNjZW5lTm9kZVNwZWNbXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAoZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYWxpYXNGaWdtYUlkcyA9IGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWMpO1xyXG4gICAgICAgICAgICBpZiAoYWxpYXNGaWdtYUlkcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldChhbGlhc0ZpZ21hSWRzKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWMuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjcyk7XHJcbiAgICBjb25zdCBib3VuZGFyaWVzID0gYm91bmRhcnlTcGVjc1xyXG4gICAgICAgIC5tYXAoKGJvdW5kYXJ5KSA9PiAoe1xyXG4gICAgICAgICAgICAuLi5ib3VuZGFyeSxcclxuICAgICAgICAgICAgbm9kZTogY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXVxyXG4gICAgICAgICAgICAgICAgPyBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF0pXHJcbiAgICAgICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgfSkpXHJcbiAgICAgICAgLmZpbHRlcigoYm91bmRhcnkpOiBib3VuZGFyeSBpcyB0eXBlb2YgYm91bmRhcnkgJiB7IG5vZGU6IGFueSB9ID0+IEJvb2xlYW4oYm91bmRhcnkubm9kZSkpO1xyXG4gICAgaWYgKCFib3VuZGFyaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCByZXRhaW5lZFV1aWRzLmhhcyh1dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBib3VuZGFyeSBvZiBib3VuZGFyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmICghYm91bmRhcnkucmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzXHJcbiAgICAgICAgICAgICAgICAmJiAhYm91bmRhcnkuYWxpYXNGaWdtYUlkcy5oYXMoZmlnbWFJZCkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGJvdW5kYXJ5Lm5vZGUsIHV1aWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSAmJiBub2RlICE9PSBib3VuZGFyeS5ub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGFsZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YWxlTm9kZXMuc2l6ZSkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVVdWlkcyA9IG5ldyBTZXQoc3RhbGVOb2Rlcy5rZXlzKCkpO1xyXG4gICAgbGV0IHJlbW92ZWQgPSAwO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBpZiAoIW5vZGUucGFyZW50IHx8IHN0YWxlVXVpZHMuaGFzKG5vZGUucGFyZW50LnV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKG5vZGUsIG5vZGUucGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCBjdXJyZW50TWFwW2ZpZ21hSWRdKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmluZEJ5VXVpZChpbXBvcnRSb290LCB1dWlkKSkge1xyXG4gICAgICAgICAgICBjdXJyZW50TWFwW2ZpZ21hSWRdID0gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgY29udGFpbmVyOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgZXhpc3RpbmdVdWlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChleGlzdGluZ1V1aWRzLmhhcyhjaGlsZC51dWlkKSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhjaGlsZCwgc3Vydml2b3JQYXJlbnQsIGV4aXN0aW5nVXVpZHMpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluZENhbnZhcyhyb290OiBhbnksIENhbnZhczogYW55KTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC5nZXRDb21wb25lbnQoQ2FudmFzKSkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQ2FudmFzKGNoaWxkLCBDYW52YXMpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBjbGFzc2VzOiBhbnlbXSxcclxuICAgIHByZXNlcnZlZDogU2V0PGFueT4sXHJcbiAgICByZW5kZXJDbGFzc2VzOiBhbnlbXSxcclxuICAgIHJlbW92YWJsZUZpbGVJZHM/OiBTZXQ8c3RyaW5nPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IGZhbHNlO1xyXG4gICAgZm9yIChjb25zdCB0eXBlIG9mIGNsYXNzZXMpIHtcclxuICAgICAgICBpZiAocHJlc2VydmVkLmhhcyh0eXBlKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gbm9kZS5nZXRDb21wb25lbnQodHlwZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICBpZiAocmVtb3ZhYmxlRmlsZUlkcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWZpbGVJZCB8fCAhcmVtb3ZhYmxlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoTmuLLmn5Pnu4Tku7bkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel5YaF5a6544CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KGNvbXBvbmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWRSZW5kZXJDb21wb25lbnQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGU6IGFueSwgY2M6IGFueSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgb3V0bGluZSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkxhYmVsT3V0bGluZSk7XHJcbiAgICBpZiAoIW91dGxpbmUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBMYWJlbE91dGxpbmUgd2FzIHVzZWQgYnkgb2xkZXIgaW1wb3J0ZXIgdmVyc2lvbnMuIENvY29zIGRlc3Ryb3lzXHJcbiAgICAvLyBjb21wb25lbnRzIGF0IHRoZSBlbmQgb2YgdGhlIGZyYW1lIGFuZCBpdHMgb25EaXNhYmxlKCkgd3JpdGVzIGJhY2sgdG9cclxuICAgIC8vIExhYmVsLmVuYWJsZU91dGxpbmUsIHNvIGxldCB0aGF0IGxpZmVjeWNsZSBmaW5pc2ggYmVmb3JlIGVpdGhlclxyXG4gICAgLy8gcmVjb25maWd1cmluZyBvciByZW1vdmluZyB0aGUgTGFiZWwgY29tcG9uZW50LlxyXG4gICAgbm9kZS5yZW1vdmVDb21wb25lbnQob3V0bGluZSk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnksIG5vZGU6IGFueSk6IFNldDxhbnk+IHtcclxuICAgIGNvbnN0IGRlc2lyZWQgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgIGNvbnN0IGNsaXBzQ2hpbGRyZW4gPSBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpO1xyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgIGlmICghdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpICYmICF1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYykpIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuU3ByaXRlKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlJpY2hUZXh0KTtcclxuICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYWJlbCk7XHJcbiAgICB9IGVsc2UgaWYgKCFSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICBpZiAoaGFzR3JhcGhpY3NWaXN1YWwoc3BlYykgfHwgY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5HcmFwaGljcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLk1hc2spO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgbGF5b3V0TW9kZVxyXG4gICAgICAgICYmIGxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkxheW91dCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5TY3JvbGxWaWV3KTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5CdXR0b24pO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMub3BhY2l0eSA8IDAuOTk5KSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuVUlPcGFjaXR5KTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZXNpcmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDApKTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFByZWZhYk93bmVyc2hpcEd1YXJkIHtcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PjtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICByZXR1cm4gIWd1YXJkLnByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgfHwgQm9vbGVhbihmaWxlSWQgJiYgZ3VhcmQucHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhmaWxlSWQpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICBjb21wb25lbnQ6IGFueSxcclxuICAgIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgIG93bmVyTmFtZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmICghY29tcG9uZW50IHx8ICFndWFyZC5wcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudCkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmICghZmlsZUlkIHx8ICFndWFyZC5wcmV2aW91c0NvbXBvbmVudEZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgIGDoioLngrnigJwke293bmVyTmFtZX3igJ3kuIrnmoQgJHtjb21wb25lbnQuY29uc3RydWN0b3I/Lm5hbWUgPz8gJ0NvbXBvbmVudCd9IOS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyTm9kZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgaWYgKCFpc093bmVkSGVscGVyTm9kZShub2RlLCBndWFyZCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi+heWKqeiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDjgIJgKTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKGlzT3duZWRIZWxwZXJOb2RlKGNoaWxkLCBndWFyZCkpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGNoaWxkLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKFxyXG4gICAgaGVscGVyOiBhbnksXHJcbiAgICBzdXJ2aXZvcjogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCByZW1vdmUgPSAobm9kZTogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubm9kZS5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGd1YXJkICYmIGlzT3duZWRIZWxwZXJOb2RlKGNoaWxkLCBndWFyZCkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZShjaGlsZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgIH07XHJcbiAgICByZW1vdmUoaGVscGVyKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkQmFja2dyb3VuZChub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IGJhY2tncm91bmQgPSBub2RlLmdldENoaWxkQnlOYW1lKEJBQ0tHUk9VTkRfTk9ERV9OQU1FKTtcclxuICAgIGlmICghYmFja2dyb3VuZCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoYmFja2dyb3VuZCwgbm9kZSwgZ3VhcmQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95R2VuZXJhdGVkVGlsZWRTcHJpdGUoXHJcbiAgICB0aWxlZFNwcml0ZTogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgc3Vydml2b3IsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRNYXNrLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0aWxlZFNwcml0ZSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICBkZXN0cm95R2VuZXJhdGVkVGlsZWRTcHJpdGUodGlsZWRTcHJpdGUsIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkT3ZlcmZsb3dWaXN1YWwobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBoZWxwZXIgPSBub2RlLmdldENoaWxkQnlOYW1lKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGhlbHBlcikge1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBBIGZsYXR0ZW5lZCBub2RlIGhhcyBubyBuZXcgY2hpbGQgc3BlY3MgYnkgZGVzaWduLiBLZWVwIGV2ZXJ5IGV4aXN0aW5nXHJcbiAgICAvLyBjaGlsZCBhbGl2ZSB1bnRpbCByZW1vdmVGbGF0dGVuZWRNYXBwZWREZXNjZW5kYW50cyBjYW4gZGlzdGluZ3Vpc2ggb2xkXHJcbiAgICAvLyBGaWdtYS1tYXBwZWQgbm9kZXMgZnJvbSB1c2VyLWF1dGhvcmVkIG5vZGVzLiBPdGhlcndpc2UgZGVzdHJveWluZyB0aGVcclxuICAgIC8vIGhlbHBlciB3b3VsZCByZWN1cnNpdmVseSBkZXN0cm95IG1hbnVhbCBjaGlsZHJlbiBhdCBDb2NvcycgZGVmZXJyZWRcclxuICAgIC8vIGRlc3RydWN0aW9uIGJvdW5kYXJ5LlxyXG4gICAgY29uc3QgcHJlc2VydmVDaGlsZHJlbiA9IHNwZWMuY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWMpO1xyXG4gICAgY29uc3QgbW92ZUNoaWxkcmVuVG9Ob2RlID0gKGNvbnRhaW5lcjogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCBsZWdhY3kgPSBub2RlLmdldENoaWxkQnlOYW1lKCdfX0ZpZ21hQ29udGVudCcpO1xyXG4gICAgaWYgKGxlZ2FjeSkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobGVnYWN5LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChndWFyZCB8fCBwcmVzZXJ2ZUNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIG1vdmVDaGlsZHJlblRvTm9kZShsZWdhY3kpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChjYy5TY3JvbGxWaWV3KTtcclxuICAgIGNvbnN0IHZpZXcgPSBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk7XHJcbiAgICBjb25zdCBjb250ZW50ID0gdmlldz8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKTtcclxuICAgIGlmICghc2Nyb2xsIHx8ICF2aWV3IHx8ICFjb250ZW50XHJcbiAgICAgICAgfHwgKHNjcm9sbC5jb250ZW50ICE9PSBjb250ZW50ICYmIHNjcm9sbC5jb250ZW50ICE9IG51bGwpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIGd1YXJkKTtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIG5vZGUsIGd1YXJkKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgIG1vdmVDaGlsZHJlblRvTm9kZShjb250ZW50KTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi52aWV3LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBpZiAoY2hpbGQgIT09IGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb250ZW50LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIGNvbnRlbnQuZGVzdHJveSgpO1xyXG4gICAgdmlldy5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICB2aWV3LmRlc3Ryb3koKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVQb3NpdGlvbihcclxuICAgIGZyYW1lOiBSZWN0LFxyXG4gICAgcGFyZW50RnJhbWU6IFJlY3QgfCB1bmRlZmluZWQsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgcGFyZW50VHJhbnNmb3JtPzogYW55LFxyXG4gICAgY2hpbGRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB7XHJcbiAgICBpZiAoIXBhcmVudEZyYW1lKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAsIHk6IDEgfTtcclxuICAgIGNvbnN0IHBhcmVudFNpemUgPSBwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplID8/IHt9O1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50U2l6ZS53aWR0aCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KVxyXG4gICAgICAgIDogcGFyZW50RnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB3aWR0aCA9IGZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBmcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGNoaWxkQW5jaG9yID0gY2hpbGRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLy8gRmlnbWEgY29vcmRpbmF0ZXMgYXJlIG1lYXN1cmVkIGZyb20gdGhlIHBhcmVudCdzIHRvcC1sZWZ0LiBDb252ZXJ0XHJcbiAgICAgICAgLy8gdGhhdCByZWN0YW5nbGUgdG8gdGhlIGxvY2FsIHBvc2l0aW9uIG9mIHRoZSBub2RlJ3MgY2VudGVyIGFuY2hvci5cclxuICAgICAgICB4OiAoZnJhbWUueCAtIHBhcmVudEZyYW1lLngpICogc2NhbGVcclxuICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICsgd2lkdGggKiBjaGlsZEFuY2hvci54LFxyXG4gICAgICAgIHk6IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgIC0gKGZyYW1lLnkgLSBwYXJlbnRGcmFtZS55KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gaGVpZ2h0ICogKDEgLSBjaGlsZEFuY2hvci55KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbGF0aXZlVHJhbnNmb3JtUG9zaXRpb24oXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuKTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcclxuICAgIGlmIChzcGVjLmlzUm9vdCB8fCAhc3BlYy5pbnRyaW5zaWNTaXplKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgbWF0cml4ID0gc3BlYy5yZWxhdGl2ZVRyYW5zZm9ybTtcclxuICAgIGNvbnN0IHZhbHVlcyA9IFtcclxuICAgICAgICBtYXRyaXg/LlswXT8uWzBdLCBtYXRyaXg/LlswXT8uWzFdLCBtYXRyaXg/LlswXT8uWzJdLFxyXG4gICAgICAgIG1hdHJpeD8uWzFdPy5bMF0sIG1hdHJpeD8uWzFdPy5bMV0sIG1hdHJpeD8uWzFdPy5bMl0sXHJcbiAgICBdO1xyXG4gICAgaWYgKCF2YWx1ZXMuZXZlcnkoKHZhbHVlKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IFttMDAsIG0wMSwgdHgsIG0xMCwgbTExLCB0eV0gPSB2YWx1ZXMgYXMgbnVtYmVyW107XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHBhcmVudFNpemUgPSBwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplID8/IHt9O1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50U2l6ZS53aWR0aCk7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpO1xyXG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyZW50V2lkdGgpIHx8ICFOdW1iZXIuaXNGaW5pdGUocGFyZW50SGVpZ2h0KSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYSByZWxhdGl2ZVRyYW5zZm9ybSBpcyB0b3AtbGVmdCBiYXNlZC4gVHJhbnNmb3JtIHRoZSB1bnJvdGF0ZWQgbG9jYWxcclxuICAgIC8vIGNlbnRlciwgdGhlbiBjb252ZXJ0IHRoZSBwYXJlbnQncyBkb3dud2FyZCBZIGF4aXMgdG8gQ29jb3MgdXB3YXJkIFkuXHJcbiAgICBjb25zdCBjZW50ZXJYID0gdHggKyBtMDAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMDEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIGNvbnN0IGNlbnRlclkgPSB0eSArIG0xMCAqIHNwZWMuaW50cmluc2ljU2l6ZS53aWR0aCAvIDJcclxuICAgICAgICArIG0xMSAqIHNwZWMuaW50cmluc2ljU2l6ZS5oZWlnaHQgLyAyO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB4OiBjZW50ZXJYICogc2NhbGUgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54LFxyXG4gICAgICAgIHk6IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpIC0gY2VudGVyWSAqIHNjYWxlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm06IGFueSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiB2b2lkIHtcclxuICAgIC8vIFJvdW5kIG9ubHkgYXQgdGhlIFVJVHJhbnNmb3JtIHdyaXRlIGJvdW5kYXJ5LCBhZnRlciBzY2FsZS9sYXlvdXQgbWF0aC5cclxuICAgIC8vIERvIG5vdCBsb2NrIHNpemVzIHJlY2FsY3VsYXRlZCBsYXRlciBieSBMYWJlbCBvciBvdGhlciBydW50aW1lIGNvbXBvbmVudHMuXHJcbiAgICB0cmFuc2Zvcm0/LnNldENvbnRlbnRTaXplKFxyXG4gICAgICAgIE1hdGgucm91bmQoKHdpZHRoICsgTnVtYmVyLkVQU0lMT04pICogMTAwKSAvIDEwMCxcclxuICAgICAgICBNYXRoLnJvdW5kKChoZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlR2VvbWV0cnkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogYW55IHtcclxuICAgIGNvbnN0IHsgVUlUcmFuc2Zvcm0sIFZlYzMgfSA9IGNjO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IG5vZGUuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBjb25zdCBzaXplID0gc3BlYy5pbnRyaW5zaWNTaXplID8/IHNwZWMuZnJhbWU7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxyXG4gICAgICAgIHRyYW5zZm9ybSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNpemUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IG5vZGUucGFyZW50Py5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcG9zaXRpb24gPSBzcGVjLmlzUm9vdFxyXG4gICAgICAgID8geyB4OiAwLCB5OiAwIH1cclxuICAgICAgICA6IHJlbGF0aXZlVHJhbnNmb3JtUG9zaXRpb24oc3BlYywgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSlcclxuICAgICAgICAgICAgPz8gZnJhbWVQb3NpdGlvbihzcGVjLmZyYW1lLCBzcGVjLnBhcmVudEZyYW1lLCBzY2FsZSwgcGFyZW50VHJhbnNmb3JtLCB0cmFuc2Zvcm0pO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyhwb3NpdGlvbi54LCBwb3NpdGlvbi55LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxuICAgIG5vZGUuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgc3BlYy5yb3RhdGlvbik7XHJcbiAgICBub2RlLmFjdGl2ZSA9IHNwZWMudmlzaWJsZTtcclxuICAgIHJldHVybiB0cmFuc2Zvcm07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVQYWludChwYWludHM6IEZpZ21hUGFpbnRbXSk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHBhaW50cy5maW5kKChwYWludCkgPT4gcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHBhaW50Lm9wYWNpdHkgPz8gMSkgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVNvbGlkUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnR5cGUgPT09ICdTT0xJRCdcclxuICAgICAgICAmJiBwYWludC52aXNpYmxlICE9PSBmYWxzZVxyXG4gICAgICAgICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMFxyXG4gICAgICAgICYmIEJvb2xlYW4ocGFpbnQuY29sb3IpXHJcbiAgICAgICAgJiYgKHBhaW50LmNvbG9yPy5hID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZEZpbGwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KHNwZWMuZmlsbHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaXJzdFRleHRGaWxsKHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICAvLyBGaWdtYSdzIHBhaW50IGFycmF5IGlzIGJhY2stdG8tZnJvbnQ6IHRoZSBwYW5lbCdzIHRvcCBmaWxsIGlzIGxhc3QuXHJcbiAgICAvLyBOYXRpdmUgdGV4dCBrZWVwcyB0aGUgZmlyc3QgdXNhYmxlIHNvbGlkIGluIHBhbmVsIG9yZGVyLCB3aXRob3V0IG1peGluZ1xyXG4gICAgLy8gc3RhY2tlZCBmaWxscyBvciBjaGFuZ2luZyB0aGUgc291cmNlIG9yZGVyIHVzZWQgYnkgb3RoZXIgcmVuZGVyZXJzLlxyXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KFsuLi5wYWludHNdLnJldmVyc2UoKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZhbGlkU29saWRTdHJva2Uoc3BlYzogU2NlbmVOb2RlU3BlYyk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiBzcGVjLnN0cm9rZVdlaWdodCA+IDAgPyB2aXNpYmxlU29saWRQYWludChzcGVjLnN0cm9rZXMpIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiByb3VuZGVkU3Ryb2tlV2lkdGgod2VpZ2h0OiBudW1iZXIsIHNjYWxlOiBudW1iZXIsIG1pbmltdW06IG51bWJlcik6IG51bWJlciB7XG4gICAgLy8gTWF0Y2ggaW1wb3J0ZWQgc2l6ZSBwcmVjaXNpb247IHJvdW5kIGFmdGVyIHNjYWxpbmcgYW5kIHByZXNlcnZlIGV4aXN0aW5nIG1pbmltdW1zLlxuICAgIHJldHVybiBNYXRoLnJvdW5kKChNYXRoLm1heChtaW5pbXVtLCB3ZWlnaHQgKiBzY2FsZSkgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwO1xufVxuXHJcbmZ1bmN0aW9uIGhhc0dyYXBoaWNzVmlzdWFsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHZpc2libGVTb2xpZEZpbGwoc3BlYykgfHwgdmFsaWRTb2xpZFN0cm9rZShzcGVjKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRyYXdHcmFwaGljcyhncmFwaGljczogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVNvbGlkRmlsbChzcGVjKTtcclxuICAgIGNvbnN0IHN0cm9rZSA9IHZhbGlkU29saWRTdHJva2Uoc3BlYyk7XHJcbiAgICBpZiAoIWZpbGwgJiYgIXN0cm9rZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHJhZGl1cyA9IE1hdGgubWF4KFxyXG4gICAgICAgIDAsXHJcbiAgICAgICAgTWF0aC5taW4oTWF0aC5taW4oLi4uc3BlYy5jb3JuZXJSYWRpaSkgKiBzY2FsZSwgd2lkdGggLyAyLCBoZWlnaHQgLyAyKSxcclxuICAgICk7XHJcbiAgICBpZiAoc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJykge1xyXG4gICAgICAgIGdyYXBoaWNzLmVsbGlwc2UoMCwgMCwgd2lkdGggLyAyLCBoZWlnaHQgLyAyKTtcclxuICAgIH0gZWxzZSBpZiAocmFkaXVzID4gMCkge1xyXG4gICAgICAgIGdyYXBoaWNzLnJvdW5kUmVjdCgtd2lkdGggLyAyLCAtaGVpZ2h0IC8gMiwgd2lkdGgsIGhlaWdodCwgcmFkaXVzKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZ3JhcGhpY3MucmVjdCgtd2lkdGggLyAyLCAtaGVpZ2h0IC8gMiwgd2lkdGgsIGhlaWdodCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICBncmFwaGljcy5maWxsQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgZ3JhcGhpY3MuZmlsbCgpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cm9rZT8uY29sb3IpIHtcclxuICAgICAgICBncmFwaGljcy5saW5lV2lkdGggPSByb3VuZGVkU3Ryb2tlV2lkdGgoc3BlYy5zdHJva2VXZWlnaHQsIHNjYWxlLCAwLjUpO1xuICAgICAgICBncmFwaGljcy5zdHJva2VDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlKCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUdyYXBoaWNzKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZXhpc3RpbmcgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBjb25zdCBncmFwaGljcyA9IGV4aXN0aW5nID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkdyYXBoaWNzKTtcclxuICAgIGlmICghZXhpc3RpbmcpIHNlc3Npb25NYXNrQ29tcG9uZW50cy5hZGQoZ3JhcGhpY3MpO1xyXG4gICAgZ3JhcGhpY3MuZW5hYmxlZCA9IHRydWU7XHJcbiAgICBncmFwaGljcy5jbGVhcigpO1xyXG4gICAgZHJhd0dyYXBoaWNzKGdyYXBoaWNzLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVMYWJlbFRleHQoY2hhcmFjdGVyczogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcclxuICAgIHJldHVybiAoY2hhcmFjdGVycyA/PyAnJylcclxuICAgICAgICAucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKVxyXG4gICAgICAgIC5yZXBsYWNlKC9bXFxyXFx1MjAyOFxcdTIwMjldL2csICdcXG4nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlUZXh0QWxpZ25tZW50KGNvbXBvbmVudDogYW55LCBzdHlsZTogU2NlbmVOb2RlU3BlY1sndGV4dFN0eWxlJ10sIHJlbmRlcmVyOiBhbnkpOiB2b2lkIHtcclxuICAgIC8vIENvY29zIGhhcyBubyBKVVNUSUZJRUQgYWxpZ25tZW50OiB1bnN1cHBvcnRlZC9taXNzaW5nIHZhbHVlcyB1c2UgTEVGVC9UT1AuXHJcbiAgICBjb21wb25lbnQuaG9yaXpvbnRhbEFsaWduID0gc3R5bGU/LnRleHRBbGlnbkhvcml6b250YWwgPT09ICdDRU5URVInXHJcbiAgICAgICAgPyByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uQ0VOVEVSXHJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduSG9yaXpvbnRhbCA9PT0gJ1JJR0hUJ1xyXG4gICAgICAgICAgICA/IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5SSUdIVFxyXG4gICAgICAgICAgICA6IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5MRUZUO1xyXG4gICAgY29tcG9uZW50LnZlcnRpY2FsQWxpZ24gPSBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdDRU5URVInXHJcbiAgICAgICAgPyByZW5kZXJlci5WZXJ0aWNhbEFsaWduLkNFTlRFUlxyXG4gICAgICAgIDogc3R5bGU/LnRleHRBbGlnblZlcnRpY2FsID09PSAnQk9UVE9NJ1xyXG4gICAgICAgICAgICA/IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uQk9UVE9NXHJcbiAgICAgICAgICAgIDogcmVuZGVyZXIuVmVydGljYWxBbGlnbi5UT1A7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hUGFuZWxGb250U2l6ZSh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IGZvbnRTaXplID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcclxuICAgIHJldHVybiBNYXRoLnJvdW5kKChmb250U2l6ZSArIE51bWJlci5FUFNJTE9OKSAqIDEwMCkgLyAxMDA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xyXG4gICAgY29uc3QgbGluZUhlaWdodCA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogMTY7XHJcbiAgICAvLyBQcmVzZXJ2ZSBGaWdtYSdzIHBpeGVsIGxpbmUgaGVpZ2h0IGluZGVwZW5kZW50bHkgb2YgaW1wb3J0IHNjYWxlIGFuZFxyXG4gICAgLy8gZW5naW5lLWNvbXB1dGVkIGNvbnRlbnQgc2l6ZTsgb25seSByb3VuZCB0byBvbmUgZGVjaW1hbCBwbGFjZS5cclxuICAgIHJldHVybiBNYXRoLnJvdW5kKChsaW5lSGVpZ2h0ICsgTnVtYmVyLkVQU0lMT04pICogMTApIC8gMTA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUxhYmVsKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBMYWJlbCB9ID0gY2M7XHJcbiAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKSA/PyBub2RlLmFkZENvbXBvbmVudChMYWJlbCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgY29uc3QgY2hhcmFjdGVycyA9IG5vcm1hbGl6ZUxhYmVsVGV4dChzcGVjLmNoYXJhY3RlcnMpO1xyXG4gICAgLy8gRmlnbWEgTk9ORSBtZWFucyBhIGZpeGVkIGJveCwgbm90IENvY29zIE92ZXJmbG93Lk5PTkUuIEJvdGggZml4ZWQtd2lkdGhcclxuICAgIC8vIG1vZGVzIHdyYXAgYW5kIGdyb3cgdmVydGljYWxseTsgbWlzc2luZyBsZWdhY3kgbWV0YWRhdGEgc3RheXMgYXV0by13aWR0aC5cclxuICAgIGNvbnN0IHdyYXAgPSBzdHlsZS50ZXh0QXV0b1Jlc2l6ZSA9PT0gJ0hFSUdIVCcgfHwgc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdOT05FJztcclxuICAgIC8vIEZpZ21hIHN0b3JlcyBtb3JlIHByZWNpc2lvbiB0aGFuIGl0cyBwYW5lbCBkaXNwbGF5cy4gTWF0Y2ggdGhlIHZpc2libGVcclxuICAgIC8vIGRlc2lnbiB2YWx1ZSAodXAgdG8gdHdvIGRlY2ltYWxzKSBpbnN0ZWFkIG9mIGxlYWtpbmcgaXRzIGludGVybmFsIGZsb2F0LlxyXG4gICAgbGFiZWwuZm9udFNpemUgPSBmaWdtYVBhbmVsRm9udFNpemUoc3R5bGUuZm9udFNpemUpO1xyXG4gICAgbGFiZWwubGluZUhlaWdodCA9IGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSk7XHJcbiAgICBsYWJlbC5zcGFjaW5nWCA9IChzdHlsZS5sZXR0ZXJTcGFjaW5nID8/IDApICogc2NhbGU7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IHdyYXAgPyBMYWJlbC5PdmVyZmxvdy5SRVNJWkVfSEVJR0hUIDogTGFiZWwuT3ZlcmZsb3cuTk9ORTtcclxuICAgIGxhYmVsLmVuYWJsZVdyYXBUZXh0ID0gd3JhcDtcclxuICAgIGFwcGx5VGV4dEFsaWdubWVudChsYWJlbCwgc3R5bGUsIExhYmVsKTtcclxuICAgIC8vIEF1dG8td2lkdGggbGFiZWxzIHVzZSBhIGNlbnRlcmVkIHZlcnRpY2FsIGJhc2VsaW5lIHJlZ2FyZGxlc3Mgb2YgRmlnbWEnc1xyXG4gICAgLy8gdmVydGljYWwgYWxpZ25tZW50LiBGaXhlZC13aWR0aCB3cmFwcGluZyBsYWJlbHMgcmV0YWluIHRoZSBGaWdtYSBzZXR0aW5nLlxyXG4gICAgaWYgKGxhYmVsLm92ZXJmbG93ID09PSBMYWJlbC5PdmVyZmxvdy5OT05FKSB7XHJcbiAgICAgICAgbGFiZWwudmVydGljYWxBbGlnbiA9IExhYmVsLlZlcnRpY2FsQWxpZ24uQ0VOVEVSO1xyXG4gICAgfVxyXG4gICAgbGFiZWwuc3RyaW5nID0gY2hhcmFjdGVycztcclxuICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSBmYWxzZTtcclxuICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xyXG4gICAgY29uc3QgZmlsbCA9IGZpcnN0VGV4dEZpbGwoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0cm9rZSA9IHZpc2libGVQYWludChzcGVjLnN0cm9rZXMpO1xyXG4gICAgaWYgKHN0cm9rZT8uY29sb3IgJiYgc3BlYy5zdHJva2VXZWlnaHQgPiAwKSB7XHJcbiAgICAgICAgbGFiZWwuZW5hYmxlT3V0bGluZSA9IHRydWU7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZUNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgc3Ryb2tlLmNvbG9yLCBzdHJva2Uub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lV2lkdGggPSByb3VuZGVkU3Ryb2tlV2lkdGgoc3BlYy5zdHJva2VXZWlnaHQsIHNjYWxlLCAxKTtcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBSaWNoVGV4dCB9ID0gY2M7XHJcbiAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KSA/PyBub2RlLmFkZENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgcmljaFRleHQuc3RyaW5nID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICByaWNoVGV4dC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICByaWNoVGV4dC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcclxuICAgIHJpY2hUZXh0Lm1heFdpZHRoID0gTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIHJpY2hUZXh0LmhhbmRsZVRvdWNoRXZlbnQgPSBmYWxzZTtcclxuICAgIGFwcGx5VGV4dEFsaWdubWVudChyaWNoVGV4dCwgc3R5bGUsIFJpY2hUZXh0KTtcclxuICAgIHJpY2hUZXh0LmZvbnRGYW1pbHkgPSBzdHlsZS5mb250RmFtaWx5ID8/ICcnO1xyXG4gICAgcmljaFRleHQudXNlU3lzdGVtRm9udCA9ICFzcGVjLmZvbnRVdWlkO1xyXG4gICAgcmljaFRleHQuZm9udENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xyXG4gICAgY29uc3QgZmlsbCA9IGZpcnN0VGV4dEZpbGwoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICByaWNoVGV4dC5mb250Q29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICB0YXJnZXRGcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0gc3BlYy5mcmFtZSxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xyXG4gICAgY29uc3Qgc3ByaXRlID0gbm9kZS5nZXRDb21wb25lbnQoU3ByaXRlKSA/PyBub2RlLmFkZENvbXBvbmVudChTcHJpdGUpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuXHJcbiAgICAvLyBLZWVwIGFzc2lnbm1lbnQgZGV0ZXJtaW5pc3RpYzogYSBuZXcgU3ByaXRlIG1heSBkZWZhdWx0IHRvIFRSSU1NRUQgYW5kXHJcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gYXdhaXQgbG9hZEFzc2V0KGFzc2V0TWFuYWdlciwgc3BlYy5zcHJpdGUudXVpZCk7XHJcbiAgICBzcHJpdGUuc3ByaXRlRnJhbWUgPSBzcHJpdGVGcmFtZTtcclxuICAgIGNvbnN0IHNsaWNlZCA9IHNwZWMuc3ByaXRlLnNsaWNlZCB8fCAoIXNwZWMuc3ByaXRlLnNsaWNlRmFsbGJhY2tcclxuICAgICAgICAmJiBbc3ByaXRlRnJhbWUuaW5zZXRMZWZ0LCBzcHJpdGVGcmFtZS5pbnNldFJpZ2h0LCBzcHJpdGVGcmFtZS5pbnNldFRvcCwgc3ByaXRlRnJhbWUuaW5zZXRCb3R0b21dXHJcbiAgICAgICAgICAgIC5zb21lKCh2YWx1ZSkgPT4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSAmJiB2YWx1ZSA+IDApKTtcclxuICAgIHNwcml0ZS50eXBlID0gc3BlYy5zcHJpdGUudGlsZWRcclxuICAgICAgICA/IFNwcml0ZS5UeXBlLlRJTEVEXHJcbiAgICAgICAgOiBzbGljZWRcclxuICAgICAgICAgICAgPyBTcHJpdGUuVHlwZS5TTElDRURcclxuICAgICAgICAgICAgOiBTcHJpdGUuVHlwZS5TSU1QTEU7XHJcblxyXG4gICAgaWYgKCFzbGljZWQgJiYgIXNwZWMuc3ByaXRlLnRpbGVkKSB7XHJcbiAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLlRSSU1NRUQ7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgcmF3V2lkdGggPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8ud2lkdGggPz8gc3ByaXRlRnJhbWU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZSh0cmltbWVkSGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIHJhd1dpZHRoID4gMFxyXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3V2lkdGggLSB0YXJnZXRXaWR0aCkgPD0gMC41MVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWSA9IHRhcmdldEhlaWdodCAvIHJhd0hlaWdodDtcclxuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyaW1tZWRXaWR0aCAqIHNjYWxlWCwgdHJpbW1lZEhlaWdodCAqIHNjYWxlWSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU2xpY2VkL3RpbGVkIHNwcml0ZXMgYW5kIHNwcml0ZXMgcmVzaXplZCBpbiBGaWdtYSBtdXN0IHJldGFpbiB0aGUgZGVzaWduXHJcbiAgICAvLyBzaXplLiBDb2NvcyByZXByZXNlbnRzIHRoYXQgc3RhdGUgYXMgQ1VTVE9NLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWlyZXNUaWxlZE1hc2soc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAndGlsZWQtaGVscGVyJykuc2hvdWxkTWFzaztcclxufVxyXG5cclxuZnVuY3Rpb24gbmF0aXZlVGlsZVNjYWxlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBudW1iZXIge1xyXG4gICAgY29uc3Qgc2NhbGUgPSBzcGVjLnNwcml0ZT8udGlsZVNjYWxlO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBzY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHNjYWxlKSAmJiBzY2FsZSA+IDBcclxuICAgICAgICA/IHNjYWxlXHJcbiAgICAgICAgOiAxO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnRpbGVkKVxyXG4gICAgICAgICYmIChyZXF1aXJlc1RpbGVkTWFzayhzcGVjKSB8fCBNYXRoLmFicyhuYXRpdmVUaWxlU2NhbGUoc3BlYykgLSAxKSA+IDFlLTYpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lKVxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8uc2xpY2VkXHJcbiAgICAgICAgJiYgIXNwZWMuc3ByaXRlPy50aWxlZDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3ZlcmZsb3dTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlbmRlckZyYW1lID0gc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lO1xyXG4gICAgaWYgKCFyZW5kZXJGcmFtZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6LaF6L6555WMIFBORyDoioLngrnigJwke3NwZWMubmFtZX3igJ3nvLrlsJHmuLLmn5PovrnnlYzjgIJgKTtcclxuICAgIH1cclxuICAgIGxldCBoZWxwZXIgPSBub2RlLmdldENoaWxkQnlOYW1lKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGd1YXJkICYmIGhlbHBlcikge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGlmICghaGVscGVyKSB7XHJcbiAgICAgICAgaGVscGVyID0gbmV3IGNjLk5vZGUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgbm9kZS5hZGRDaGlsZChoZWxwZXIpO1xyXG4gICAgfVxyXG4gICAgaGVscGVyLm5hbWUgPSBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FO1xyXG4gICAgaGVscGVyLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgIGhlbHBlci5hY3RpdmUgPSB0cnVlO1xyXG5cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGhlbHBlci5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgPz8gaGVscGVyLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShoZWxwZXIsIHNwZWMsIHNjYWxlLCBjYywgcmVuZGVyRnJhbWUpO1xyXG5cclxuICAgIGNvbnN0IGdlb21ldHJ5Q2VudGVyWCA9IHNwZWMuZnJhbWUueCArIHNwZWMuZnJhbWUud2lkdGggLyAyO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJZID0gc3BlYy5mcmFtZS55ICsgc3BlYy5mcmFtZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgcmVuZGVyQ2VudGVyWCA9IHJlbmRlckZyYW1lLnggKyByZW5kZXJGcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJZID0gcmVuZGVyRnJhbWUueSArIHJlbmRlckZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICAvLyBGaWdtYSBwYWdlIFkgcG9pbnRzIGRvd253YXJkIHdoaWxlIENvY29zIFVJIFkgcG9pbnRzIHVwd2FyZC5cclxuICAgIGNvbnN0IHdvcmxkRGVsdGFYID0gKHJlbmRlckNlbnRlclggLSBnZW9tZXRyeUNlbnRlclgpICogc2NhbGU7XHJcbiAgICBjb25zdCB3b3JsZERlbHRhWSA9IC0ocmVuZGVyQ2VudGVyWSAtIGdlb21ldHJ5Q2VudGVyWSkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBOdW1iZXIuaXNGaW5pdGUoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgID8gTnVtYmVyKHNwZWMud29ybGRSb3RhdGlvbilcclxuICAgICAgICA6IHNwZWMucm90YXRpb247XHJcbiAgICBjb25zdCByYWRpYW5zID0gd29ybGRSb3RhdGlvbiAqIE1hdGguUEkgLyAxODA7XHJcbiAgICBjb25zdCBjb3NpbmUgPSBNYXRoLmNvcyhyYWRpYW5zKTtcclxuICAgIGNvbnN0IHNpbmUgPSBNYXRoLnNpbihyYWRpYW5zKTtcclxuICAgIC8vIFRoZSBleHBvcnRlZCBQTkcgaXMgYWxyZWFkeSByYXN0ZXJpemVkIGluIEZpZ21hIHBhZ2UgYXhlcy4gQ291bnRlcmFjdFxyXG4gICAgLy8gdGhlIGxvZ2ljYWwgc2hlbGwncyBhY2N1bXVsYXRlZCByb3RhdGlvbiBhbmQgZXhwcmVzcyB0aGUgdmlzdWFsLWNlbnRlclxyXG4gICAgLy8gb2Zmc2V0IGJhY2sgaW4gdGhhdCBzaGVsbCdzIGxvY2FsIGNvb3JkaW5hdGUgc3lzdGVtLlxyXG4gICAgY29uc3QgbG9jYWxYID0gY29zaW5lICogd29ybGREZWx0YVggKyBzaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBjb25zdCBsb2NhbFkgPSAtc2luZSAqIHdvcmxkRGVsdGFYICsgY29zaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBoZWxwZXIuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMobG9jYWxYLCBsb2NhbFksIDApKTtcclxuICAgIGhlbHBlci5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAtd29ybGRSb3RhdGlvbik7XHJcbiAgICBoZWxwZXIuc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgaGVscGVyLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG5lZWRzTWFzayA9IHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpO1xyXG4gICAgbGV0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgbGV0IHRpbGVkU3ByaXRlID0gdGlsZWRNYXNrPy5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKVxyXG4gICAgICAgID8/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChuZWVkc01hc2spIHtcclxuICAgICAgICBpZiAoIXRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICB0aWxlZE1hc2sgPSBuZXcgY2MuTm9kZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgIG5vZGUuYWRkQ2hpbGQodGlsZWRNYXNrKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLm5hbWUgPSBUSUxFRF9NQVNLX05PREVfTkFNRTtcclxuICAgICAgICB0aWxlZE1hc2subGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHRpbGVkTWFzay5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG1hc2tUcmFuc2Zvcm0gPSB0aWxlZE1hc2suZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyB0aWxlZE1hc2suYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxyXG4gICAgICAgICAgICBtYXNrVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICAgICAgY29uZmlndXJlQ2xpcCh0aWxlZE1hc2ssIHNwZWMsIGNjLCAndGlsZWQtaGVscGVyJywgZ3VhcmQpO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnRpbGVkTWFzay5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICB0aWxlZE1hc2suZGVzdHJveSgpO1xyXG4gICAgICAgIHRpbGVkTWFzayA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzcHJpdGVQYXJlbnQgPSB0aWxlZE1hc2sgPz8gbm9kZTtcclxuICAgIGlmICghdGlsZWRTcHJpdGUpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZSA9IG5ldyBjYy5Ob2RlKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIHNwcml0ZVBhcmVudC5hZGRDaGlsZCh0aWxlZFNwcml0ZSk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkU3ByaXRlLnBhcmVudCAhPT0gc3ByaXRlUGFyZW50KSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUucGFyZW50ID0gc3ByaXRlUGFyZW50O1xyXG4gICAgfVxyXG4gICAgdGlsZWRTcHJpdGUubmFtZSA9IFRJTEVEX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICB0aWxlZFNwcml0ZS5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICB0aWxlZFNwcml0ZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKHRpbGVkU3ByaXRlLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG4gICAgY29uc3QgdGlsZVNjYWxlID0gbmF0aXZlVGlsZVNjYWxlKHNwZWMpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gdGlsZWRTcHJpdGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IHRpbGVkU3ByaXRlLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNjYWxlKG5ldyBjYy5WZWMzKHRpbGVTY2FsZSwgdGlsZVNjYWxlLCAxKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZU9wYWNpdHkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5ID49IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3BhY2l0eSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJT3BhY2l0eSkgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcclxuICAgIG9wYWNpdHkub3BhY2l0eSA9IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc3BlYy5vcGFjaXR5KSkgKiAyNTUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYXlvdXQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoIW1vZGUgfHwgbW9kZSA9PT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBMYXlvdXQsIFNpemUgfSA9IGNjO1xyXG4gICAgY29uc3QgbGF5b3V0ID0gbm9kZS5nZXRDb21wb25lbnQoTGF5b3V0KSA/PyBub2RlLmFkZENvbXBvbmVudChMYXlvdXQpO1xyXG4gICAgbGF5b3V0LnR5cGUgPSBtb2RlID09PSAnSE9SSVpPTlRBTCdcclxuICAgICAgICA/IExheW91dC5UeXBlLkhPUklaT05UQUxcclxuICAgICAgICA6IG1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuVHlwZS5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5UeXBlLkdSSUQ7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnKSB7XHJcbiAgICAgICAgbGF5b3V0LnN0YXJ0QXhpcyA9IHNwZWMubGF5b3V0Py5zb3VyY2VNb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LkF4aXNEaXJlY3Rpb24uVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuQXhpc0RpcmVjdGlvbi5IT1JJWk9OVEFMO1xyXG4gICAgfVxyXG4gICAgbGF5b3V0LnJlc2l6ZU1vZGUgPSBMYXlvdXQuUmVzaXplTW9kZS5OT05FO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdMZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1JpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdUb3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdCb3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdYID0gc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1kgPSAobW9kZSA9PT0gJ0dSSUQnID8gc3BlYy5sYXlvdXQhLmNvdW50ZXJTcGFjaW5nIDogc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nKSAqIHNjYWxlO1xyXG4gICAgY29uc3QgYWN0aXZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUpO1xyXG4gICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbldpZHRoID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUud2lkdGggKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nTGVmdCAtIGxheW91dC5wYWRkaW5nUmlnaHQ7XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWCA9IE1hdGgubWF4KDAsIChpbm5lcldpZHRoIC0gY2hpbGRyZW5XaWR0aCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbldpZHRoICsgbGF5b3V0LnNwYWNpbmdYICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVyV2lkdGggLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gJ1ZFUlRJQ0FMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbkhlaWdodCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLmhlaWdodCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lckhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ1RvcCAtIGxheW91dC5wYWRkaW5nQm90dG9tO1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1kgPSBNYXRoLm1heCgwLCAoaW5uZXJIZWlnaHQgLSBjaGlsZHJlbkhlaWdodCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbkhlaWdodCArIGxheW91dC5zcGFjaW5nWSAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lckhlaWdodCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBsYXlvdXQuY2VsbFNpemUgPSBuZXcgU2l6ZShcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS53aWR0aCkpICogc2NhbGUsXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUuaGVpZ2h0KSkgKiBzY2FsZSxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseUNvdW50ZXJBbGlnbm1lbnQoXHJcbiAgICBwYXJlbnQ6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgY29uc3QgYWxpZ25tZW50ID0gc3BlYy5sYXlvdXQ/LmNvdW50ZXJBbGlnbjtcclxuICAgIGlmICghbW9kZSB8fCAhYWxpZ25tZW50IHx8ICFbJ0hPUklaT05UQUwnLCAnVkVSVElDQUwnXS5pbmNsdWRlcyhtb2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IHBhcmVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0V2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB0b3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgY29uc3QgYm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgZm9yIChjb25zdCBjaGlsZFNwZWMgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkU3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBjaGlsZCA9IHV1aWQgPyBmaW5kQnlVdWlkKHBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNoaWxkPy5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIGlmICghY2hpbGQgfHwgIXRyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSBjaGlsZC5wb3NpdGlvbi5jbG9uZSgpO1xyXG4gICAgICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0SGVpZ2h0IC0gdG9wIC0gYm90dG9tKTtcclxuICAgICAgICAgICAgbGV0IHRvcE9mZnNldCA9IHRvcDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IHRvcCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0uaGVpZ2h0KSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gbGF5b3V0SGVpZ2h0IC0gYm90dG9tIC0gdHJhbnNmb3JtLmhlaWdodDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0cmFuc2Zvcm0ud2lkdGgsIGF2YWlsYWJsZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueSA9IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgICAgICAtIHRvcE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSB0cmFuc2Zvcm0uaGVpZ2h0ICogKDEgLSAodHJhbnNmb3JtLmFuY2hvclBvaW50Py55ID8/IDAuNSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dFdpZHRoIC0gbGVmdCAtIHJpZ2h0KTtcclxuICAgICAgICAgICAgbGV0IGxlZnRPZmZzZXQgPSBsZWZ0O1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxlZnQgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLndpZHRoKSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxheW91dFdpZHRoIC0gcmlnaHQgLSB0cmFuc2Zvcm0ud2lkdGg7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgYXZhaWxhYmxlLCB0cmFuc2Zvcm0uaGVpZ2h0KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi54ID0gbGVmdE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICAgICArIHRyYW5zZm9ybS53aWR0aCAqICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnggPz8gMC41KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2hpbGQuc2V0UG9zaXRpb24ocG9zaXRpb24pO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBsb2dNYXNrRGVjaXNpb24oc3BlYzogU2NlbmVOb2RlU3BlYywgdGFyZ2V0OiBNYXNrVGFyZ2V0ID0gJ25vZGUnKTogdm9pZCB7XHJcbiAgICBjb25zb2xlLmxvZygnW0ZpZ21hIEltcG9ydGVyIE1hc2sg5Yaz562WXScsIEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgbm9kZU5hbWU6IHNwZWMubmFtZSxcclxuICAgICAgICB0YXJnZXQsXHJcbiAgICAgICAgLi4uc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCksXHJcbiAgICB9KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQobm9kZTogYW55LCBjYzogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHR5cGUgb2YgW2NjLk1hc2ssIGNjLkdyYXBoaWNzXSkge1xyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xyXG4gICAgICAgIGlmICghY29tcG9uZW50KSBjb250aW51ZTtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcclxuICAgICAgICB9IGVsc2UgaWYgKCFzZXNzaW9uTWFza0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoQgJHt0eXBlLm5hbWV9IOe8uuWwkeWvvOWFpeWZqOW9kuWxnuiusOW9le+8jOW3suWBnOatouabtOaWsOS7peS/neaKpOaJi+W3pee7hOS7tu+8m+ivt+S9v+eUqOW4puWQjOatpeiusOW9leeahCBQcmVmYWIg5oiW5a+85YWl5Li65paw6IqC54K544CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVDbGlwKFxyXG4gICAgbm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55LCB0YXJnZXQ6IE1hc2tUYXJnZXQgPSAnbm9kZScsIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBzaG91bGRHZW5lcmF0ZU1hc2soc3BlYywgdGFyZ2V0KTtcclxuICAgIGlmICghZGVjaXNpb24uc2hvdWxkTWFzaykgcmV0dXJuO1xyXG4gICAgaWYgKHRhcmdldCAhPT0gJ25vZGUnKSBsb2dNYXNrRGVjaXNpb24oc3BlYywgdGFyZ2V0KTtcclxuICAgIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQobm9kZSwgY2MsIGd1YXJkKTtcclxuICAgIC8vIFByb3Zpc2lvbiBHcmFwaGljcyBldmVuIGZvciBpbmFjdGl2ZSBub2RlcyBzbyBvd25lcnNoaXAgaXMgY2FwdHVyZWQgbm93LFxyXG4gICAgLy8gbm90IGxvc3Qgd2hlbiBNYXNrLm9uTG9hZCBjcmVhdGVzIGl0cyByZW5kZXJlciBvbiBhIGxhdGVyIGFjdGl2YXRpb24uXHJcbiAgICBjb25zdCBncmFwaGljcyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKGdyYXBoaWNzKTtcclxuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgLy8gTWFzayBvd25zIHRoZSBkcmF3aW5nOiBjbGVhcmluZyBoZXJlIHdvdWxkIGVyYXNlIGEgcmV1c2VkIG1hc2sgd2hlbiB0aGVcclxuICAgIC8vIHR5cGUgc3RheXMgdW5jaGFuZ2VkIChpdHMgcHVibGljIHNldHRlciBkb2VzIG5vdCByZWRyYXcgaWRlbnRpY2FsIHR5cGVzKS5cclxuICAgIGNvbnN0IG1hc2sgPSBub2RlLmdldENvbXBvbmVudChjYy5NYXNrKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5NYXNrKTtcclxuICAgIHNlc3Npb25NYXNrQ29tcG9uZW50cy5hZGQobWFzayk7XHJcbiAgICBjb25zdCBtYXNrVHlwZSA9IGRlY2lzaW9uLm1hc2tUeXBlID09PSAnZWxsaXBzZSdcclxuICAgICAgICA/IGNjLk1hc2suVHlwZS5HUkFQSElDU19FTExJUFNFID8/IGNjLk1hc2suVHlwZS5FTExJUFNFXHJcbiAgICAgICAgOiBjYy5NYXNrLlR5cGUuR1JBUEhJQ1NfUkVDVCA/PyBjYy5NYXNrLlR5cGUuUkVDVDtcclxuICAgIHNldE1hc2tTaGFwZVNhZmVseShtYXNrLCBtYXNrVHlwZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjKS5zaG91bGRNYXNrO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNCdXR0b25BbmNlc3Rvcihub2RlOiBhbnksIGNjOiBhbnkpOiBib29sZWFuIHtcclxuICAgIGZvciAobGV0IHBhcmVudCA9IG5vZGUucGFyZW50OyBwYXJlbnQ7IHBhcmVudCA9IHBhcmVudC5wYXJlbnQpIHtcclxuICAgICAgICBpZiAocGFyZW50LmdldENvbXBvbmVudChjYy5CdXR0b24pKSByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ2J1dHRvbicgJiYgIWhhc0J1dHRvbkFuY2VzdG9yKG5vZGUsIGNjKSkge1xyXG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkJ1dHRvbikgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuQnV0dG9uKTtcclxuICAgICAgICBidXR0b24udGFyZ2V0ID0gbm9kZTtcclxuICAgICAgICBidXR0b24udHJhbnNpdGlvbiA9IGNjLkJ1dHRvbi5UcmFuc2l0aW9uLlNDQUxFO1xyXG4gICAgICAgIGJ1dHRvbi56b29tU2NhbGUgPSAwLjk7XHJcbiAgICAgICAgYnV0dG9uLmR1cmF0aW9uID0gMC4xO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHJhbnNmb3JtOiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IGFueSB7XHJcbiAgICBpZiAoIXNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAnc2Nyb2xsLXZpZXcnKS5zaG91bGRNYXNrKSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IE5vZGUsIFVJVHJhbnNmb3JtLCBTY3JvbGxWaWV3IH0gPSBjYztcclxuICAgIGxldCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgbGV0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG51bGw7XHJcbiAgICBpZiAodmlldyAmJiBndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChTY3JvbGxWaWV3KSA/PyBub2RlLmFkZENvbXBvbmVudChTY3JvbGxWaWV3KTtcclxuICAgIGlmICghdmlldykge1xyXG4gICAgICAgIHZpZXcgPSBuZXcgTm9kZSgndmlldycpO1xyXG4gICAgICAgIHZpZXcubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQodmlldyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3VHJhbnNmb3JtID0gdmlldy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IHZpZXcuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh2aWV3VHJhbnNmb3JtLCB0cmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgsIHRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpO1xyXG4gICAgdmlldy5zZXRQb3NpdGlvbigwLCAwLCAwKTtcclxuICAgIGNvbmZpZ3VyZUNsaXAodmlldywgc3BlYywgY2MsICdzY3JvbGwtdmlldycsIGd1YXJkKTtcclxuICAgIGlmICghY29udGVudCkge1xyXG4gICAgICAgIGNvbnRlbnQgPSBuZXcgTm9kZSgnY29udGVudCcpO1xyXG4gICAgICAgIGNvbnRlbnQubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHZpZXcuYWRkQ2hpbGQoY29udGVudCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250ZW50VHJhbnNmb3JtID0gY29udGVudC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGNvbnRlbnQuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHByZXZpb3VzTGF5b3V0ID0gY29udGVudC5nZXRDb21wb25lbnQoY2MuTGF5b3V0KTtcclxuICAgIGNvbnN0IG5leHRMYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAocHJldmlvdXNMYXlvdXQgJiYgKCFuZXh0TGF5b3V0TW9kZSB8fCBuZXh0TGF5b3V0TW9kZSA9PT0gJ05PTkUnKSkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChwcmV2aW91c0xheW91dCwgZ3VhcmQsIGNvbnRlbnQubmFtZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnRlbnQucmVtb3ZlQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0KTtcclxuICAgIH1cclxuICAgIGNvbnRlbnRUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCBjb250ZW50VHJhbnNmb3JtLCBzcGVjLCB0cmFuc2Zvcm0sIHNjYWxlKTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5ICYmIGxlZ2FjeSAhPT0gY29udGVudCkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobGVnYWN5LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmxlZ2FjeS5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBjb250ZW50KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgLy8gQ29jb3MgQ3JlYXRvciAzLjguNyBleHBlY3RzIHRoZSBjb250ZW50IE5vZGUgaGVyZS4gU2Nyb2xsVmlldy52aWV3IGlzIGFcclxuICAgIC8vIGdldHRlciBkZXJpdmVkIGZyb20gY29udGVudC5wYXJlbnQgYW5kIG11c3QgbmV2ZXIgYmUgYXNzaWduZWQgZGlyZWN0bHkuXHJcbiAgICBpZiAoc2Nyb2xsLmNvbnRlbnQgPT09IGNvbnRlbnQpIHtcclxuICAgICAgICBzY3JvbGwuY29udGVudCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBzY3JvbGwuY29udGVudCA9IGNvbnRlbnQ7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIHNjcm9sbC5ob3Jpem9udGFsID0gYXhlcy5ob3Jpem9udGFsO1xyXG4gICAgc2Nyb2xsLnZlcnRpY2FsID0gYXhlcy52ZXJ0aWNhbDtcclxuICAgIHJldHVybiBjb250ZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzY3JvbGxBeGVzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiB7IGhvcml6b250YWw6IGJvb2xlYW47IHZlcnRpY2FsOiBib29sZWFuIH0ge1xyXG4gICAgY29uc3QgZGlyZWN0aW9uID0gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbiAmJiBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICE9PSAnTk9ORSdcclxuICAgICAgICA/IHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24udHJpbSgpLnRvVXBwZXJDYXNlKClcclxuICAgICAgICA6ICdWRVJUSUNBTF9TQ1JPTExJTkcnO1xyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUwnIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0JPVEgnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUwnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiB0cnVlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBob3Jpem9udGFsOiBmYWxzZSwgdmVydGljYWw6IHRydWUgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIGNvbnRlbnRUcmFuc2Zvcm06IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aWV3cG9ydFdpZHRoID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy53aWR0aCkgfHwgMCk7XHJcbiAgICBjb25zdCB2aWV3cG9ydEhlaWdodCA9IE1hdGgubWF4KDAsIE51bWJlcih2aWV3cG9ydC5jb250ZW50U2l6ZT8uaGVpZ2h0KSB8fCAwKTtcclxuICAgIGNvbnN0IGNoaWxkUmlnaHQgPSBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+XHJcbiAgICAgICAgKGNoaWxkLmZyYW1lLnggLSBzcGVjLmZyYW1lLnggKyBjaGlsZC5mcmFtZS53aWR0aCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBjaGlsZEJvdHRvbSA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueSAtIHNwZWMuZnJhbWUueSArIGNoaWxkLmZyYW1lLmhlaWdodCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIGNvbnN0IGNvbnRlbnRXaWR0aCA9IGF4ZXMuaG9yaXpvbnRhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRXaWR0aCwgMCwgLi4uY2hpbGRSaWdodClcclxuICAgICAgICA6IHZpZXdwb3J0V2lkdGg7XHJcbiAgICBjb25zdCBjb250ZW50SGVpZ2h0ID0gYXhlcy52ZXJ0aWNhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRIZWlnaHQsIDAsIC4uLmNoaWxkQm90dG9tKVxyXG4gICAgICAgIDogdmlld3BvcnRIZWlnaHQ7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKGNvbnRlbnRUcmFuc2Zvcm0sIGNvbnRlbnRXaWR0aCwgY29udGVudEhlaWdodCk7XHJcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcclxuICAgICAgICAodmlld3BvcnRIZWlnaHQgLSBjb250ZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodCkgLyAyLFxyXG4gICAgICAgIDAsXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5hbGl6ZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBjb250ZW50OiBhbnksXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnIHx8IGNvbnRlbnQgPT09IG5vZGUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIXRyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoY29udGVudCwgdHJhbnNmb3JtLCBzcGVjLCB2aWV3cG9ydCwgc2NhbGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3VudFNwZWNzKHNwZWNzOiBTY2VuZU5vZGVTcGVjW10pOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHNwZWNzLnJlZHVjZSgodG90YWwsIHNwZWMpID0+IHRvdGFsICsgMSArIGNvdW50U3BlY3Moc3BlYy5jaGlsZHJlbiksIDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjZW50ZXJJbkNhbnZhcyhub2RlOiBhbnksIGNhbnZhczogYW55LCBVSVRyYW5zZm9ybTogYW55LCBWZWMzOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG5vZGVUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBjYW52YXNUcmFuc2Zvcm0gPSBjYW52YXM/LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIW5vZGVUcmFuc2Zvcm0gfHwgIWNhbnZhc1RyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGNhbnZhc1NpemUgPSBjYW52YXNUcmFuc2Zvcm0uY29udGVudFNpemUgPz8ge1xyXG4gICAgICAgIHdpZHRoOiBjYW52YXNUcmFuc2Zvcm0ud2lkdGgsXHJcbiAgICAgICAgaGVpZ2h0OiBjYW52YXNUcmFuc2Zvcm0uaGVpZ2h0LFxyXG4gICAgfTtcclxuICAgIGNvbnN0IHdpZHRoID0gTnVtYmVyKGNhbnZhc1NpemU/LndpZHRoKSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS53aWR0aCkgOiA2NDA7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBOdW1iZXIoY2FudmFzU2l6ZT8uaGVpZ2h0KSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS5oZWlnaHQpIDogMTEzNjtcclxuICAgIGNvbnN0IGNhbnZhc0FuY2hvciA9IGNhbnZhc1RyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBub2RlQW5jaG9yID0gbm9kZVRyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCB4ID0gd2lkdGggKiAoMC41IC0gY2FudmFzQW5jaG9yLngpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLndpZHRoICogKDAuNSAtIG5vZGVBbmNob3IueCk7XHJcbiAgICBjb25zdCB5ID0gaGVpZ2h0ICogKDAuNSAtIGNhbnZhc0FuY2hvci55KVxyXG4gICAgICAgIC0gbm9kZVRyYW5zZm9ybS5oZWlnaHQgKiAoMC41IC0gbm9kZUFuY2hvci55KTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMoeCwgeSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVDb21wb25lbnRzKG5vZGU6IGFueSk6IGFueVtdIHtcclxuICAgIGNvbnN0IHZhbHVlID0gbm9kZT8uY29tcG9uZW50cyA/PyBub2RlPy5fY29tcG9uZW50cztcclxuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSA/IHZhbHVlIDogW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlb3JkZXJGaWdtYUNoaWxkcmVuKHBhcmVudDogYW55LCBvcmRlcmVkTm9kZXM6IGFueVtdKTogdm9pZCB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gWy4uLm5ldyBTZXQob3JkZXJlZE5vZGVzLmZpbHRlcihCb29sZWFuKSldO1xyXG4gICAgaWYgKCFkZXNpcmVkLmxlbmd0aCB8fCB0eXBlb2YgZGVzaXJlZFswXT8uc2V0U2libGluZ0luZGV4ICE9PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEtb3duZWQgY2hpbGRyZW4gYXJlIGtlcHQgaW4gRmlnbWEgb3JkZXIuIFVzZXItYXV0aG9yZWQgY2hpbGRyZW4gYXJlXHJcbiAgICAvLyBuZXZlciByZW9yZGVyZWQgYWdhaW5zdCBvbmUgYW5vdGhlcjsgdGhleSBmb2xsb3cgdGhlIG1hbmFnZWQgYmxvY2suXHJcbiAgICBkZXNpcmVkLmZvckVhY2goKG5vZGUsIGluZGV4KSA9PiBub2RlLnNldFNpYmxpbmdJbmRleChpbmRleCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVTdGFsZVByZWZhYk5vZGVzKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgcHJldmlvdXNOb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHJldGFpbmVkTm9kZUZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IGluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCk7XHJcbiAgICBjb25zdCBzdGFsZSA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGVJZCBvZiBwcmV2aW91c05vZGVGaWxlSWRzKSB7XHJcbiAgICAgICAgaWYgKGZpbGVJZCA9PT0gbm9kZVByZWZhYkZpbGVJZChwcmVmYWJSb290KSB8fCByZXRhaW5lZE5vZGVGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gaW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgc3RhbGUuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVJZHMgPSBuZXcgU2V0KHN0YWxlLmtleXMoKSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygc3RhbGUudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGDlvoXliKDpmaTnmoQgRmlnbWEg6IqC54K54oCcJHtub2RlLm5hbWV94oCd5ZCr5pyJ5omL5bel57uE5Lu277yM5bey5YGc5q2i5ZCM5q2l5Lul6Ziy5q2i5pWw5o2u5Lii5aSx44CCYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMgPSAoY29udGFpbmVyOiBhbnksIHN1cnZpdm9yUGFyZW50OiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChjaGlsZCk7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZEZpbGVJZFxyXG4gICAgICAgICAgICAgICAgJiYgKHByZXZpb3VzTm9kZUZpbGVJZHMuaGFzKGNoaWxkRmlsZUlkKSB8fCBwcmV2aW91c0hlbHBlckZpbGVJZHMuaGFzKGNoaWxkRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyhjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgZm9yIChjb25zdCBbZmlsZUlkLCBub2RlXSBvZiBzdGFsZSkge1xyXG4gICAgICAgIGxldCBhbmNlc3RvciA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIGxldCBuZXN0ZWRVbmRlclN0YWxlID0gZmFsc2U7XHJcbiAgICAgICAgd2hpbGUgKGFuY2VzdG9yICYmIGFuY2VzdG9yICE9PSBwcmVmYWJSb290LnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBhbmNlc3RvckZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoYW5jZXN0b3IpO1xyXG4gICAgICAgICAgICBpZiAoYW5jZXN0b3JGaWxlSWQgJiYgc3RhbGVJZHMuaGFzKGFuY2VzdG9yRmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgbmVzdGVkVW5kZXJTdGFsZSA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhbmNlc3RvciA9IGFuY2VzdG9yLnBhcmVudDtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG5lc3RlZFVuZGVyU3RhbGUgfHwgIW5vZGUucGFyZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBzdXJ2aXZvclBhcmVudCA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyhub2RlLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgICAgICBzdGFsZS5kZWxldGUoZmlsZUlkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY2FwdHVyZVByZWZhYlN5bmMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgcHJldmlvdXM6IFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBwcmVleGlzdGluZ05vZGVVdWlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IFNldDxhbnk+LFxyXG4gICAgZ2VuZXJhdGVkQ2xhc3NlczogYW55W10sXHJcbiAgICBjYzogYW55LFxyXG4pOiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlIHtcclxuICAgIGNvbnN0IHByZXZpb3VzQ29tcG9uZW50cyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZENvbXBvbmVudEZpbGVJZHMpO1xyXG4gICAgY29uc3QgcHJldmlvdXNIZWxwZXJzID0gbmV3IFNldChwcmV2aW91cy5tYW5hZ2VkSGVscGVyRmlsZUlkcyk7XHJcbiAgICBjb25zdCBub2RlRmlsZUlkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgY29uc3QgbWFuYWdlZE5vZGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkQ29tcG9uZW50cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZEhlbHBlcnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hcHBlZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgIGNvbnN0IG1hbmFnZWRSdW50aW1lTm9kZXMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG5cclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlkIzmraXnu5PmnpznvLrlsJEgRmlnbWEg6IqC54K577yaJHtmaWdtYUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbm9kZUZpbGVJZHNbZmlnbWFJZF0gPSBmaWxlSWQ7XHJcbiAgICAgICAgbWFuYWdlZE5vZGVzLmFkZChmaWxlSWQpO1xyXG4gICAgICAgIG1hbmFnZWRSdW50aW1lTm9kZXMuc2V0KG5vZGUudXVpZCwgbm9kZSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudFR5cGVzID0gbmV3IFNldChbY2MuVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBtYW5hZ2VkUnVudGltZU5vZGVzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgaWYgKCFtYW5hZ2VkQ29tcG9uZW50VHlwZXMuaGFzKGNvbXBvbmVudC5jb25zdHJ1Y3RvcikpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmIChwcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudClcclxuICAgICAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudHMuYWRkKGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50LCBjYykpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICB3YWxrTm9kZXMocHJlZmFiUm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBpZiAobWFwcGVkVXVpZHMuaGFzKG5vZGUudXVpZCkgfHwgbm9kZSA9PT0gcHJlZmFiUm9vdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIGlmICghcGFyZW50XHJcbiAgICAgICAgICAgIHx8ICghbWFwcGVkVXVpZHMuaGFzKHBhcmVudC51dWlkKSAmJiAhbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5oYXMocGFyZW50LnV1aWQpKVxyXG4gICAgICAgICAgICB8fCAhaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKG5vZGUsIHBhcmVudCwgY2MpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChwcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgICAgICAmJiAoIWV4aXN0aW5nRmlsZUlkIHx8ICFwcmV2aW91c0hlbHBlcnMuaGFzKGV4aXN0aW5nRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgYOiKgueCueKAnCR7cGFyZW50Lm5hbWV94oCd5LiL5a2Y5Zyo5LiO5a+85YWl6L6F5Yqp6IqC54K55ZCM5ZCN55qE5omL5bel6IqC54K54oCcJHtub2RlLm5hbWV94oCd77yM5bey5YGc5q2i5ZCM5q2l44CCYCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJzLmFkZChmaWxlSWQpO1xyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmIChwcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudClcclxuICAgICAgICAgICAgICAgICYmICghY29tcG9uZW50RmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBub2RlRmlsZUlkcyxcclxuICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IFsuLi5tYW5hZ2VkTm9kZXNdLFxyXG4gICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBbLi4ubWFuYWdlZENvbXBvbmVudHNdLFxyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBbLi4ubWFuYWdlZEhlbHBlcnNdLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVmcmVzaFByZWZhYkxheW91dHMoXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpc2l0ID0gKHNwZWM6IFNjZW5lTm9kZVNwZWMpID0+IHtcclxuICAgICAgICBjb25zdCB1dWlkID0gbm9kZU1hcFtzcGVjLmZpZ21hSWRdO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSB1dWlkID8gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGRQYXJlbnQgPSBzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICAgICA/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKT8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKSA/PyBub2RlXHJcbiAgICAgICAgICAgIDogbm9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgY29uc3QgbGF5b3V0ID0gc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgbGF5b3V0TW9kZSAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORSdcclxuICAgICAgICAgICAgPyBjaGlsZFBhcmVudC5nZXRDb21wb25lbnQoY2MuTGF5b3V0KVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgbGF5b3V0Py51cGRhdGVMYXlvdXQoKTtcclxuICAgICAgICBpZiAobGF5b3V0KSB7XHJcbiAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgc2NhbGUsIGNjKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGNoaWxkUGFyZW50ICE9PSBub2RlKSB7XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKSxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNwZWMuY2hpbGRyZW4uZm9yRWFjaCh2aXNpdCk7XHJcbiAgICB9O1xyXG4gICAgc3BlY3MuZm9yRWFjaCh2aXNpdCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVtaXRTY2VuZVByb2dyZXNzKFxyXG4gICAgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkLFxyXG4gICAgdmFsdWU6IG51bWJlcixcclxuICAgIG1lc3NhZ2U6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGF5bG9hZC5wYWNrYWdlTmFtZSwgJ3Byb2dyZXNzJywge1xyXG4gICAgICAgICAgICBwaGFzZTogJ3NjZW5lJyxcclxuICAgICAgICAgICAgdmFsdWUsXHJcbiAgICAgICAgICAgIG1lc3NhZ2UsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyDov5vluqblj43ppojkuI3lj6/nlKjml7bkuI3lupTkuK3mlq3lnLrmma/lr7zlhaXjgIJcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGxvYWQoKTogdm9pZCB7fVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kcyA9IHtcclxuICAgIHJlZnJlc2hSZXZpZXdBZnRlcixcclxuICAgIHByZXBhcmVSZXZpZXdSZW1vdmFsLFxyXG4gICAgZmluaXNoUmV2aWV3UmVtb3ZhbCxcclxuICAgIGluc3BlY3RQcmVmYWJDb250ZXh0KHBheWxvYWQ6IHtcclxuICAgICAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICAgICAgcm9vdEZpbGVJZD86IHN0cmluZztcclxuICAgIH0pOiBQcmVmYWJFZGl0aW5nU3RhdGUge1xyXG4gICAgICAgIHJldHVybiBwcmVmYWJFZGl0aW5nU3RhdGUocGF5bG9hZC5wcmVmYWJVdWlkLCBwYXlsb2FkLnJvb3RGaWxlSWQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnREb2N1bWVudChwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQpOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCB7XHJcbiAgICAgICAgICAgIGRpcmVjdG9yLFxyXG4gICAgICAgICAgICBOb2RlLFxyXG4gICAgICAgICAgICBVSVRyYW5zZm9ybSxcclxuICAgICAgICAgICAgQ2FudmFzLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICAgICAgQ2FtZXJhLFxyXG4gICAgICAgIH0gPSBjYztcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgaWYgKCFzY2VuZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZr+OAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVmYWJDb250ZXh0ID0gcGF5bG9hZC5wcmVmYWJDb250ZXh0O1xyXG4gICAgICAgIGxldCBwcmVmYWJSb290OiBhbnkgfCBudWxsID0gbnVsbDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHByZWZhYkVkaXRpbmdTdGF0ZShwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQsIHByZWZhYkNvbnRleHQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDlsJrmnKrlronlhajmiZPlvIDvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwcmVmYWJSb290ID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2UuU2NlbmUucm9vdE5vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVJZEluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCwgcHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XHJcbiAgICAgICAgICAgICAgICBfX3Jvb3RfXzogcHJlZmFiUm9vdC51dWlkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCBmaWxlSWRdIG9mIE9iamVjdC5lbnRyaWVzKHByZWZhYkNvbnRleHQuZXhpc3RpbmdOb2RlRmlsZUlkcykpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaWxlSWRJbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGF5bG9hZC51cGRhdGVFeGlzdGluZyA9IHRydWU7XHJcbiAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAgPSBleGlzdGluZ01hcDtcclxuICAgICAgICAgICAgcGF5bG9hZC5jZW50ZXJJbkNhbnZhcyA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyA9IG5ldyBTZXQ8YW55PigpO1xyXG4gICAgICAgIGlmIChwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgICAgICBub2RlQ29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMuYWRkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gcGF5bG9hZC5yb290cy5tYXAoKHJvb3QpID0+IG5vcm1hbGl6ZVNjZW5lU3BlYyhyb290KSk7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQgJiYgcm9vdHMubGVuZ3RoICE9PSAxKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeWPquWFgeiuuOS4gOS4qiBGaWdtYSBGcmFtZSDmoLnoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmFsbGJhY2tQYXJlbnQgPSBwcmVmYWJSb290Py5wYXJlbnQgPz8gZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKSA/PyBzY2VuZTtcclxuICAgICAgICBjb25zdCBkaXJlY3RSb290ID0gcm9vdHMubGVuZ3RoID09PSAxO1xyXG4gICAgICAgIGNvbnN0IGNhbnZhcyA9IHByZWZhYlJvb3QgPyBudWxsIDogZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKTtcclxuICAgICAgICBjb25zdCBnZW5lcmF0ZWRDbGFzc2VzID0gW1xyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICBdO1xyXG4gICAgICAgIGNvbnN0IG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgICAgICBsZXQgY3JlYXRlZCA9IDA7XHJcbiAgICAgICAgbGV0IHVwZGF0ZWQgPSAwO1xyXG4gICAgICAgIGNvbnN0IHRvdGFsTm9kZXMgPSBNYXRoLm1heCgxLCBjb3VudFNwZWNzKHJvb3RzKSk7XHJcbiAgICAgICAgbGV0IGNvbXBsZXRlZE5vZGVzID0gMDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZEhlbHBlckZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZWZhYk93bmVyc2hpcEd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCB8IHVuZGVmaW5lZCA9IHByZWZhYkNvbnRleHRcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ05vZGVVdWlkczogcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290VXVpZCA9IHBheWxvYWQudXBkYXRlRXhpc3RpbmdcclxuICAgICAgICAgICAgPyBwYXlsb2FkLmV4aXN0aW5nTWFwLl9fcm9vdF9fXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGxldCBleGlzdGluZ1Jvb3ROb2RlID0gZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIGV4aXN0aW5nUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAoZXhpc3RpbmdSb290Tm9kZT8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgZXhpc3RpbmdSb290Tm9kZSA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIEluIGEgZGlyZWN0LXJvb3QgaW1wb3J0LCBfX3Jvb3RfXyBhbGlhc2VzIHRoZSBGaWdtYSByb290IFVVSUQuIEluIGFcclxuICAgICAgICAvLyBtdWx0aS1yb290IGltcG9ydCBpdCBpZGVudGlmaWVzIGEgc3ludGhldGljIHdyYXBwZXIgYW5kIG11c3QgbmV2ZXIgYmVcclxuICAgICAgICAvLyByZXVzZWQgYXMgb25lIG9mIGl0cyBvd24gY2hpbGRyZW4gd2hlbiB0aGUgcm9vdCBjb3VudCBjaGFuZ2VzLlxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA9IEJvb2xlYW4oZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICAmJiBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKS5zb21lKChbZmlnbWFJZCwgdXVpZF0pID0+XHJcbiAgICAgICAgICAgICAgICBmaWdtYUlkICE9PSAnX19yb290X18nICYmIHV1aWQgPT09IGV4aXN0aW5nUm9vdFV1aWQpKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c0RpcmVjdFJvb3QgPSBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c1dyYXBwZXIgPSAhZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgbWFwcGVkUm9vdFV1aWQgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gZXhpc3RpbmdVdWlkRm9yU3BlYyhwYXlsb2FkLmV4aXN0aW5nTWFwLCByb290c1swXSlcclxuICAgICAgICAgICAgOiAoIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdFV1aWQgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGxldCBpbXBvcnRSb290ID0gcHJlZmFiUm9vdCA/PyAocGF5bG9hZC51cGRhdGVFeGlzdGluZyAmJiBtYXBwZWRSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFJvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGwpO1xyXG4gICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBpbXBvcnRSb290Py5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbGVnYWN5V3JhcHBlciA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBwcmV2aW91c1dyYXBwZXIgPz8gKGltcG9ydFJvb3Q/LnBhcmVudD8ubmFtZS5zdGFydHNXaXRoKCdGaWdtYSDCtyAnKVxyXG4gICAgICAgICAgICAgICAgPyBpbXBvcnRSb290LnBhcmVudFxyXG4gICAgICAgICAgICAgICAgOiBudWxsKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcmV1c2VkSW1wb3J0Um9vdCA9IEJvb2xlYW4oaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3QmVmb3JlID0gcGF5bG9hZC5yZXZpZXdJZFxyXG4gICAgICAgICAgICA/IGNhcHR1cmVSZXZpZXdTY2VuZShpbXBvcnRSb290ID8/IGV4aXN0aW5nUm9vdE5vZGUsIGNjLCBwYXlsb2FkLmV4aXN0aW5nTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dD8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gcmV2aWV3TWFuYWdlZENvbXBvbmVudElkcyhpbXBvcnRSb290ID8/IGV4aXN0aW5nUm9vdE5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCwgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSkpXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZhbGxiYWNrUGFyZW50O1xyXG4gICAgICAgIGlmICghZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YCk7XHJcbiAgICAgICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnBhcmVudCA9IHBhcmVudDtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QubmFtZSA9IGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gO1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm0gPSBpbXBvcnRSb290LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gaW1wb3J0Um9vdC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS53aWR0aCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS5oZWlnaHQgKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpbXBvcnRSb290LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGNsZWFuTmFtZShyb290c1swXS5uYW1lKSk7XHJcbiAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEEgY29sbGFwc2VkIFNjZW5lU3BlYyBjYW4gaW50ZW50aW9uYWxseSBtYXAgc2V2ZXJhbCBGaWdtYSBJRHMgdG8gYVxyXG4gICAgICAgIC8vIHNpbmdsZSBDb2NvcyBub2RlLiBJZiBhIGxhdGVyIGltcG9ydCBleHBhbmRzIHRoYXQgc3VidHJlZSBhZ2FpbixcclxuICAgICAgICAvLyB0aG9zZSBJRHMgc3RpbGwgcG9pbnQgYXQgdGhlIHNhbWUgb2xkIFVVSUQuIENsYWltIGVhY2ggcmV1c2FibGUgbm9kZVxyXG4gICAgICAgIC8vIG9uY2UgcGVyIGJ1aWxkIHNvIGEgY2hpbGQgY2FuIG5ldmVyIHJldXNlIChhbmQgcmVwYXJlbnQpIGl0cyBwYXJlbnQuXHJcbiAgICAgICAgY29uc3QgY2xhaW1lZE5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gYXN5bmMgKFxyXG4gICAgICAgICAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgICAgICAgICBub2RlUGFyZW50OiBhbnksXHJcbiAgICAgICAgICAgIHByb3ZpZGVkTm9kZT86IGFueSxcclxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICAgICAgbG9nTWFza0RlY2lzaW9uKHNwZWMpO1xyXG4gICAgICAgICAgICBsZXQgbm9kZSA9IHByb3ZpZGVkTm9kZSA/PyBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUgJiYgcGF5bG9hZC51cGRhdGVFeGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZFV1aWQgPSBwYXlsb2FkLmV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZE5vZGUgPSBtYXBwZWRVdWlkID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkVXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXBwZWROb2RlICYmICFjbGFpbWVkTm9kZVV1aWRzLmhhcyhtYXBwZWROb2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUgPSBtYXBwZWROb2RlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgY2xhaW1lZE5vZGVVdWlkcy5oYXMobm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RlZCA9IEJvb2xlYW4obm9kZSk7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG5ldyBOb2RlKGNsZWFuTmFtZShzcGVjLm5hbWUpKTtcclxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nICYmICFwcmVmYWJPd25lcnNoaXBHdWFyZCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spIHx8IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIC8vIEluY2x1ZGUgZ2VuZXJhdGVkIHZpZXcvdGlsZWQgaGVscGVycyBiZWZvcmUgYW55IGRlbGV0aW9uIG9yXHJcbiAgICAgICAgICAgICAgICAvLyByZWNvbmZpZ3VyYXRpb24uIE5ldmVyIGluZmVyIG93bmVyc2hpcCBmcm9tIHRoZWlyIG5hbWVzIGFsb25lLlxyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGhlbHBlci5nZXRDb21wb25lbnQoTWFzaykpIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQoaGVscGVyLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHByZWZhYk93bmVyc2hpcEd1YXJkICYmIGV4aXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZC5uYW1lID09PSAndmlldycpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBoZWxwZXIubmFtZSA9PT0gJ3ZpZXcnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oJ2NvbnRlbnQnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaGVscGVyLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZSA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKHRpbGVkU3ByaXRlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdlbmVyYXRlZENsYXNzZXMuaW5jbHVkZXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2xhaW1lZE5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgaWYgKCEocHJlZmFiQ29udGV4dCAmJiBub2RlID09PSBwcmVmYWJSb290KSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5wYXJlbnQgPSBub2RlUGFyZW50O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUubmFtZSA9IGNsZWFuTmFtZShzcGVjLm5hbWUpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuXHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhub2RlLCBzcGVjLCBjYywgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlc2VydmVkID0gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYywgY2MsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgLy8gTWFzayBvd25zIGFuZCBkaXNhYmxlcyBpdHMgc2hhcmVkIEdyYXBoaWNzIGR1cmluZyB0aGVcclxuICAgICAgICAgICAgICAgIC8vIGRlZmVycmVkIG9uRGlzYWJsZSBwaGFzZS4gSWYgY2xpcHBpbmcgd2FzIHJlbW92ZWQgYnV0IGFcclxuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBHcmFwaGljcyByZW5kZXJlciBpcyBzdGlsbCBkZXNpcmVkLCByZWNyZWF0ZSB0aGF0XHJcbiAgICAgICAgICAgICAgICAvLyByZW5kZXJlciBvbmx5IGFmdGVyIHRoZSBvbGQgTWFzayBsaWZlY3ljbGUgaGFzIGNvbXBsZXRlZC5cclxuICAgICAgICAgICAgICAgIGlmICghcHJlc2VydmVkLmhhcyhNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgcHJlc2VydmVkLmhhcyhHcmFwaGljcykpIHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQuZGVsZXRlKEdyYXBoaWNzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdGVkQ2xhc3NlcyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgW0dyYXBoaWNzLCBTcHJpdGUsIExhYmVsLCBSaWNoVGV4dF0sXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCA/IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlbW92ZWRSZW5kZXJDb21wb25lbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlSGVscGVyID0gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3ZlcmZsb3dTcHJpdGVIZWxwZXIgPSB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIW92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkT3ZlcmZsb3dWaXN1YWwobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2xpcHNDaGlsZHJlbiA9IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInIHx8IHNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBORyDmlbTlsYLoioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIzotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAncmljaFRleHQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlUmljaFRleHQobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNjLlRURkZvbnQgJiYgIShmb250IGluc3RhbmNlb2YgY2MuVFRGRm9udCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUmljaFRleHQg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5Y+q6IO95L2/55SoIFRURi9PVEYg5a2X5L2T77yM5b2T5YmN5pig5bCE5Y+v6IO95pivIEJpdG1hcEZvbnTvvIguZm5077yJ44CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IGZvbnQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5maWdtYVR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxhYmVsKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWwuZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKS5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKFJBU1RFUl9WRUNUT1JfVFlQRVMuaGFzKHNwZWMuZmlnbWFUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55+i6YeP6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yMUE5HIOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlQ2xpcChub2RlLCBzcGVjLCBjYywgJ25vZGUnLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICAgICA/IG5vZGVcclxuICAgICAgICAgICAgICAgIDogY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlTGF5b3V0KGNoaWxkUGFyZW50LCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChjaGlsZCwgY2hpbGRQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW9yZGVyRmlnbWFDaGlsZHJlbihcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGQuZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB1dWlkID8gZmluZEJ5VXVpZChjaGlsZFBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChMYXlvdXQpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKG5vZGUsIHNwZWMsIGNoaWxkUGFyZW50LCB0cmFuc2Zvcm0sIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGVkICYmIHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lICs9ICcgwrcgVHJhbnNmb3JtJztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZWROb2RlcyArPSAxO1xyXG4gICAgICAgICAgICBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgICAgICAgICAgICAgIHBheWxvYWQsXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZWROb2RlcyAvIHRvdGFsTm9kZXMsXHJcbiAgICAgICAgICAgICAgICBg5p6E5bu66IqC54K5ICR7Y29tcGxldGVkTm9kZXN9LyR7dG90YWxOb2Rlc30gwrcgJHtzcGVjLm5hbWV9YCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKHJvb3QsIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LCBkaXJlY3RSb290ID8gaW1wb3J0Um9vdCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCxcclxuICAgICAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNlbnRlckluQ2FudmFzICYmIGNhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNlbnRlckluQ2FudmFzKGltcG9ydFJvb3QsIGNhbnZhcywgVUlUcmFuc2Zvcm0sIGNjLlZlYzMpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFsZVRyYW5zaXRpb25VdWlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKVxyXG4gICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKFtmaWdtYUlkLCB1dWlkXSkgPT4gZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiAhcmV0YWluZWRVdWlkcy5oYXModXVpZCkpXHJcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgoWywgdXVpZF0pID0+IHV1aWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgbGVnYWN5V3JhcHBlciAmJiBsZWdhY3lXcmFwcGVyICE9PSBpbXBvcnRSb290ICYmIGxlZ2FjeVdyYXBwZXIucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShsZWdhY3lXcmFwcGVyLCBwYXJlbnQsIHN0YWxlVHJhbnNpdGlvblV1aWRzLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIHByZXZpb3VzRGlyZWN0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290ICE9PSBpbXBvcnRSb290XHJcbiAgICAgICAgICAgICAgICAmJiAhcmV0YWluZWRVdWlkcy5oYXMocHJldmlvdXNEaXJlY3RSb290LnV1aWQpXHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91c0RpcmVjdFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgc3RhbGVUcmFuc2l0aW9uVXVpZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhpbXBvcnRSb290LCBwYXlsb2FkLmV4aXN0aW5nTWFwLCBub2RlTWFwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICghcmV1c2VkSW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldChPYmplY3QudmFsdWVzKHBheWxvYWQuZXhpc3RpbmdNYXApKSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgcHJlZmFiU3luYzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZE5vZGVGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWumuS9jeWvvOWFpeWQjueahOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMuYWRkKGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIGltcG9ydFJvb3QsIGNjKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBuZXcgU2V0KHByZWZhYkNvbnRleHQubWFuYWdlZE5vZGVGaWxlSWRzKSxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcmV0YWluZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgcmVmcmVzaFByZWZhYkxheW91dHMocm9vdHMsIGltcG9ydFJvb3QsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgcHJlZmFiU3luYyA9IGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0LFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBbVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChub2RlUHJlZmFiRmlsZUlkKGltcG9ydFJvb3QpICE9PSBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5Zyo5ZCM5q2l6L+H56iL5Lit5Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgcmV2aWV3QmVmb3JlLFxyXG4gICAgICAgICAgICByZXZpZXdBZnRlcjogcGF5bG9hZC5yZXZpZXdJZCA/IHJlZ2lzdGVyU2NlbmVSZXZpZXcocGF5bG9hZC5yZXZpZXdJZCwgaW1wb3J0Um9vdCwgY2MsIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJTeW5jPy5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyA/PyByZXZpZXdNYW5hZ2VkQ29tcG9uZW50SWRzKGltcG9ydFJvb3QsIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICAgICAgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSksIHByZWZhYkNvbnRleHRcbiAgICAgICAgICAgICAgICAgICAgPyB7IHRhcmdldFV1aWQ6IHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCwgbW9kZTogJ3ByZWZhYicgfSA6IHVuZGVmaW5lZCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICByb290VXVpZDogaW1wb3J0Um9vdC51dWlkLFxyXG4gICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICBjcmVhdGVkLFxyXG4gICAgICAgICAgICB1cGRhdGVkLFxyXG4gICAgICAgICAgICB0ZW1wb3JhcnlSb290OiAhcHJlZmFiQ29udGV4dCAmJiBkaXJlY3RSb290ICYmICFyZXVzZWRJbXBvcnRSb290LFxyXG4gICAgICAgICAgICBwcmVmYWJTeW5jLFxyXG4gICAgICAgIH07XHJcbiAgICB9LFxyXG5cclxuICAgIHJlbW92ZUltcG9ydGVkTm9kZShwYXlsb2FkOiB7IHJvb3RVdWlkOiBzdHJpbmcgfSk6IGJvb2xlYW4ge1xyXG4gICAgICAgIGNvbnN0IGNjID0gcmVxdWlyZSgnY2MnKSBhcyBhbnk7XHJcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBzY2VuZSA/IGZpbmRCeVV1aWQoc2NlbmUsIHBheWxvYWQucm9vdFV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBTdG9wIHJlbmRlcmluZyBpbW1lZGlhdGVseS4gQ29jb3MgZGVzdHJveXMgbm9kZXMgYXQgdGhlIGVuZCBvZiB0aGVcclxuICAgICAgICAvLyBmcmFtZSwgc28gcmVtb3ZpbmcgdGhlIHBhcmVudCBhbG9uZSBjYW4gbGVhdmUgYSBvbmUtZnJhbWUgZ2hvc3QuXHJcbiAgICAgICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0sXHJcbn07XHJcbiJdfQ==