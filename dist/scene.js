"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const node_name_1 = require("./node-name");
const sync_marker_1 = require("./importer/sync-marker");
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
let syncMarkerFailure = null;
/**
 * 组件同步标记：只在节点上写数据，不参与渲染。
 * 组件类由主进程生成到 `assets/figma-importer-runtime/FigmaSyncNode.ts`，
 * 尚未编译完成时整次导入降级为"无标记"并回传警告，不阻断建树。
 */
function configureSyncMarker(node, spec) {
    var _a;
    const marker = spec.syncMarker;
    if (!marker || spec.action === 'transform') {
        return;
    }
    const component = (_a = node.getComponent(sync_marker_1.SYNC_MARKER_CLASS)) !== null && _a !== void 0 ? _a : node.addComponent(sync_marker_1.SYNC_MARKER_CLASS);
    const values = (0, sync_marker_1.markerToComponentValues)(marker);
    for (const [key, value] of Object.entries(values)) {
        component[key] = value;
    }
}
/**
 * 标记组件永远属于插件：旧 Prefab 的 Meta 可能是在没有标记的版本写下的，
 * 其 `managedComponentFileIds` 里没有标记，不能因此把它当成"手工组件"。
 */
function isSyncMarkerComponent(component) {
    var _a;
    if (!component) {
        return false;
    }
    if (((_a = component.constructor) === null || _a === void 0 ? void 0 : _a.name) === sync_marker_1.SYNC_MARKER_CLASS) {
        return true;
    }
    return (0, sync_marker_1.isSyncMarkerComponentValue)(component);
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
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!spec.sprite) {
        return;
    }
    const { Sprite, UITransform, assetManager } = cc;
    const sprite = (_a = node.getComponent(Sprite)) !== null && _a !== void 0 ? _a : node.addComponent(Sprite);
    // Reset on every import: color belongs to this Sprite, never its shared
    // SpriteFrame/texture. Node opacity is applied independently by UIOpacity.
    sprite.color = toColor(cc.Color, (_b = spec.sprite.tint) !== null && _b !== void 0 ? _b : { r: 1, g: 1, b: 1, a: 1 });
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
        const trimmedWidth = Number((_c = transform === null || transform === void 0 ? void 0 : transform.contentSize) === null || _c === void 0 ? void 0 : _c.width);
        const trimmedHeight = Number((_d = transform === null || transform === void 0 ? void 0 : transform.contentSize) === null || _d === void 0 ? void 0 : _d.height);
        const rawWidth = Number((_f = (_e = spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.originalSize) === null || _e === void 0 ? void 0 : _e.width) !== null && _f !== void 0 ? _f : spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.width);
        const rawHeight = Number((_h = (_g = spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.originalSize) === null || _g === void 0 ? void 0 : _g.height) !== null && _h !== void 0 ? _h : spriteFrame === null || spriteFrame === void 0 ? void 0 : spriteFrame.height);
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
            if (isSyncMarkerComponent(component)) {
                // 插件自己的同步标记不算手工组件；旧 Meta 未记录它也允许删除。
                continue;
            }
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
            if (!managedComponentTypes.has(component.constructor) && !isSyncMarkerComponent(component)) {
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
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const cc = require('cc');
        syncMarkerFailure = null;
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
            if (spec.syncMarker && spec.action !== 'transform' && syncMarkerFailure === null) {
                try {
                    configureSyncMarker(node, spec);
                }
                catch (error) {
                    syncMarkerFailure = error instanceof Error ? error.message : String(error);
                }
            }
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
            const retainedNodeFileIds = new Set((_j = payload.retainNodeFileIds) !== null && _j !== void 0 ? _j : []);
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
            reviewAfter: payload.reviewId ? (0, import_review_scene_1.registerSceneReview)(payload.reviewId, importRoot, cc, nodeMap, (_k = prefabSync === null || prefabSync === void 0 ? void 0 : prefabSync.managedComponentFileIds) !== null && _k !== void 0 ? _k : (0, import_review_scene_1.reviewManagedComponentIds)(importRoot, nodeMap, [UITransform, ...generatedClasses]), prefabContext
                ? { targetUuid: prefabContext.prefabUuid, mode: 'prefab' } : undefined) : undefined,
            rootUuid: importRoot.uuid,
            nodeMap,
            created,
            updated,
            temporaryRoot: !prefabContext && directRoot && !reusedImportRoot,
            prefabSync,
            ...(syncMarkerFailure ? { syncMarkerWarning: syncMarkerFailure } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBK3dEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBanhEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFDL0Msd0RBQWdIO0FBQ2hILCtDQUF1RTtBQUV2RSwrREFDaUc7QUFHakcsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQWdDekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSx5QkFBeUIsR0FBRyx1QkFBdUIsQ0FBQztBQUMxRCw2RUFBNkU7QUFDN0UsMkVBQTJFO0FBQzNFLE1BQU0scUJBQXFCLEdBQUcsSUFBSSxPQUFPLEVBQVUsQ0FBQztBQUNwRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ2hDLFFBQVE7SUFDUixtQkFBbUI7SUFDbkIsTUFBTTtJQUNOLE1BQU07SUFDTixpQkFBaUI7Q0FDcEIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxTQUFTLENBQUMsS0FBYTs7SUFDNUIsT0FBTyxNQUFBLElBQUEsNEJBQWdCLEVBQUMsS0FBSyxDQUFDLG1DQUFJLFlBQVksQ0FBQztBQUNuRCxDQUFDO0FBRUQsU0FBUyxPQUFPLENBQUMsS0FBVSxFQUFFLEtBQTZCLEVBQUUsT0FBTyxHQUFHLENBQUM7O0lBQ25FLE1BQU0sTUFBTSxHQUFHLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVB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LENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ2hFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sS0FBSyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxxRUFBcUU7UUFDckUsbUVBQW1FO1FBQ25FLElBQUksQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO1FBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge1xyXG4gICAgaXNUZXJtaW5hbEFjdGlvbixcclxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXHJcbiAgICBub3JtYWxpemVJbXBvcnRBY3Rpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEZpZ21hQ29sb3IsXHJcbiAgICBGaWdtYVBhaW50LFxyXG4gICAgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBSZWN0LFxyXG4gICAgU2NlbmVOb2RlU3BlYyxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgU1lOQ19NQVJLRVJfQ0xBU1MsIGlzU3luY01hcmtlckNvbXBvbmVudFZhbHVlLCBtYXJrZXJUb0NvbXBvbmVudFZhbHVlcyB9IGZyb20gJy4vaW1wb3J0ZXIvc3luYy1tYXJrZXInO1xyXG5pbXBvcnQgeyBzaG91bGRHZW5lcmF0ZU1hc2ssIHNldE1hc2tTaGFwZVNhZmVseSB9IGZyb20gJy4vbWFzay1wb2xpY3knO1xyXG5pbXBvcnQgdHlwZSB7IE1hc2tUYXJnZXQgfSBmcm9tICcuL21hc2stcG9saWN5JztcclxuaW1wb3J0IHsgY2FwdHVyZVJldmlld1NjZW5lLCByZWdpc3RlclNjZW5lUmV2aWV3LCByZXZpZXdNYW5hZ2VkQ29tcG9uZW50SWRzLFxyXG4gICAgcHJlcGFyZVJldmlld1JlbW92YWwsIGZpbmlzaFJldmlld1JlbW92YWwsIHJlZnJlc2hSZXZpZXdBZnRlciB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1zY2VuZSc7XHJcbmltcG9ydCB0eXBlIHsgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5cclxubW9kdWxlLnBhdGhzLnB1c2goam9pbihFZGl0b3IuQXBwLnBhdGgsICdub2RlX21vZHVsZXMnKSk7XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHJldmlld0lkPzogc3RyaW5nO1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgLyoqIOacquWLvumAieiKgueCueWcqCBQcmVmYWIg5Lit5bey5pyJ55qEIGZpbGVJZO+8m+a4heeQhuaXp+iKgueCueaXtuW/hemhu+S/neeVmeOAgiAqL1xyXG4gICAgcmV0YWluTm9kZUZpbGVJZHM/OiBzdHJpbmdbXTtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XHJcbiAgICByZXZpZXdCZWZvcmU/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlld0FmdGVyPzogUmV2aWV3U2NlbmU7XHJcbiAgICByb290VXVpZDogc3RyaW5nO1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIGNyZWF0ZWQ6IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ6IG51bWJlcjtcclxuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiU3luYz86IFByZWZhYlNjZW5lU3luY0NhcHR1cmU7XHJcbiAgICAvKiog5qCH6K6w57uE5Lu26ISa5pys5bCa5pyq57yW6K+R5a6M5oiQ5pe255qE6ZmN57qn6K+05piO77yb5a+85YWl5pys6Lqr57un57ut5oiQ5Yqf44CCICovXHJcbiAgICBzeW5jTWFya2VyV2FybmluZz86IHN0cmluZztcclxufVxyXG5cclxuY29uc3QgQkFDS0dST1VORF9OT0RFX05BTUUgPSAnX19GaWdtYUJhY2tncm91bmQnO1xyXG5jb25zdCBUSUxFRF9NQVNLX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRNYXNrJztcclxuY29uc3QgVElMRURfU1BSSVRFX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRTcHJpdGUnO1xyXG5jb25zdCBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFPdmVyZmxvd1Zpc3VhbCc7XHJcbi8vIFNjZW5lLW9ubHkgdXBkYXRlcyBoYXZlIG5vIHBlcnNpc3RlZCBQcmVmYWIgb3duZXJzaGlwIHNuYXBzaG90LiBLZWVwIGV4YWN0XHJcbi8vIGNvbXBvbmVudCBpZGVudGl0aWVzIGZvciB0aGlzIHNlc3Npb247IHVua25vd24vbGVnYWN5IG1hc2tzIGZhaWwgY2xvc2VkLlxyXG5jb25zdCBzZXNzaW9uTWFza0NvbXBvbmVudHMgPSBuZXcgV2Vha1NldDxvYmplY3Q+KCk7XHJcbmNvbnN0IFJBU1RFUl9WRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIGNsZWFuTmFtZShpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzYW5pdGl6ZU5vZGVOYW1lKGlucHV0KSA/PyAnRmlnbWEgTm9kZSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRvQ29sb3IoQ29sb3I6IGFueSwgdmFsdWU6IEZpZ21hQ29sb3IgfCB1bmRlZmluZWQsIG9wYWNpdHkgPSAxKTogYW55IHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHZhbHVlID8/IHsgcjogMCwgZzogMCwgYjogMCwgYTogMSB9O1xyXG4gICAgcmV0dXJuIG5ldyBDb2xvcihcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5yKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmcpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UuYikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIChzb3VyY2UuYSA/PyAxKSAqIG9wYWNpdHkpKSAqIDI1NSksXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kQnlVdWlkKHJvb3Q6IGFueSwgdXVpZDogc3RyaW5nKTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC51dWlkID09PSB1dWlkKSB7XHJcbiAgICAgICAgcmV0dXJuIHJvb3Q7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRCeVV1aWQoY2hpbGQsIHV1aWQpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVQcmVmYWJGaWxlSWQobm9kZTogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gbm9kZT8uX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50OiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmFsdWUgPSBjb21wb25lbnQ/Ll9fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhbGtOb2Rlcyhyb290OiBhbnksIHZpc2l0OiAobm9kZTogYW55KSA9PiB2b2lkKTogdm9pZCB7XHJcbiAgICB2aXNpdChyb290KTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIHdhbGtOb2RlcyhjaGlsZCwgdmlzaXQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJBc3NldFV1aWQobm9kZTogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGFzc2V0ID0gbm9kZT8uX3ByZWZhYj8uYXNzZXQ7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGFzc2V0Py5fdXVpZCA/PyBhc3NldD8udXVpZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRmlsZUlkSW5kZXgocm9vdDogYW55LCBleHBlY3RlZFByZWZhYlV1aWQ/OiBzdHJpbmcpOiBNYXA8c3RyaW5nLCBhbnk+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBjb25zdCBjb21wb25lbnRGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICB3YWxrTm9kZXMocm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBwcmVmYWJSb290ID0gbm9kZT8uX3ByZWZhYj8ucm9vdDtcclxuICAgICAgICBpZiAobm9kZSAhPT0gcm9vdCAmJiBwcmVmYWJSb290ICYmIHByZWZhYlJvb3QgIT09IHJvb3QpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBhc3NldFV1aWQgPSBwcmVmYWJBc3NldFV1aWQobm9kZSk7XHJcbiAgICAgICAgaWYgKGV4cGVjdGVkUHJlZmFiVXVpZCAmJiBhc3NldFV1aWQgJiYgYXNzZXRVdWlkICE9PSBleHBlY3RlZFByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgICAgIGlmICghZmlsZUlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHJlc3VsdC5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlhoXlrZjlnKjph43lpI3oioLngrkgZmlsZUlk77yaJHtmaWxlSWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdC5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlLmNvbXBvbmVudHMgPz8gbm9kZS5fY29tcG9uZW50cyA/PyBbXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKCFjb21wb25lbnRGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlhoXlrZjlnKjph43lpI3nu4Tku7YgZmlsZUlk77yaJHtjb21wb25lbnRGaWxlSWR9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcG9uZW50RmlsZUlkcy5hZGQoY29tcG9uZW50RmlsZUlkKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkVkaXRpbmdTdGF0ZShcclxuICAgIGV4cGVjdGVkVXVpZDogc3RyaW5nLFxyXG4gICAgZXhwZWN0ZWRSb290RmlsZUlkPzogc3RyaW5nLFxyXG4pOiBQcmVmYWJFZGl0aW5nU3RhdGUge1xyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjb25zdCBtb2RlID0gU3RyaW5nKGNjZUFwaT8uU2NlbmVGYWNhZGVNYW5hZ2VyPy5xdWVyeU1vZGU/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRVdWlkID0gU3RyaW5nKGNjZUFwaT8uU2NlbmVGYWNhZGVNYW5hZ2VyPy5xdWVyeUN1cnJlbnRTY2VuZVV1aWQ/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IHJvb3QgPSBjY2VBcGk/LlNjZW5lPy5yb290Tm9kZSA/PyBudWxsO1xyXG4gICAgY29uc3Qgcm9vdEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQocm9vdCk7XHJcbiAgICBsZXQgcmVhc29uID0gJyc7XHJcbiAgICBpZiAobW9kZSAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICByZWFzb24gPSBg5b2T5YmN57yW6L6R5qih5byP5Li6ICR7bW9kZSB8fCAndW5rbm93bid977yM5bCa5pyq6L+b5YWlIFByZWZhYmA7XHJcbiAgICB9IGVsc2UgaWYgKGN1cnJlbnRVdWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICByZWFzb24gPSBg5b2T5YmN6LWE5rqQIFVVSUQg5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7RgO1xyXG4gICAgfSBlbHNlIGlmICghcm9vdCkge1xyXG4gICAgICAgIHJlYXNvbiA9ICdQcmVmYWIg5qC56IqC54K55bCa5pyq5bCx57uqJztcclxuICAgIH0gZWxzZSBpZiAoZXhwZWN0ZWRSb290RmlsZUlkICYmIHJvb3RGaWxlSWQgIT09IGV4cGVjdGVkUm9vdEZpbGVJZCkge1xyXG4gICAgICAgIHJlYXNvbiA9ICdQcmVmYWIg5qC56IqC54K5IGZpbGVJZCDkuI7mnaXmupDorrDlvZXkuI3kuIDoh7QnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICByZWFkeTogIXJlYXNvbixcclxuICAgICAgICBtb2RlLFxyXG4gICAgICAgIGN1cnJlbnRVdWlkLFxyXG4gICAgICAgIHJvb3RVdWlkOiByb290Py51dWlkLFxyXG4gICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgcmVhc29uOiByZWFzb24gfHwgdW5kZWZpbmVkLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGdlbmVyYXRlZCA9IChnbG9iYWxUaGlzIGFzIGFueSkuRWRpdG9yPy5VdGlscz8uVVVJRD8uZ2VuZXJhdGU/Lih0cnVlKTtcclxuICAgIGlmICh0eXBlb2YgZ2VuZXJhdGVkID09PSAnc3RyaW5nJyAmJiBnZW5lcmF0ZWQubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiBnZW5lcmF0ZWQ7XHJcbiAgICB9XHJcbiAgICAvLyBVbml0LXRlc3QvaGVhZGxlc3MgZmFsbGJhY2suIFRoZSByZWFsIENyZWF0b3Igc2NlbmUgcHJvY2VzcyBhbHdheXMgdXNlc1xyXG4gICAgLy8gRWRpdG9yLlV0aWxzLlVVSUQuZ2VuZXJhdGUodHJ1ZSksIHNvIHByb2R1Y3Rpb24gSURzIGZvbGxvdyBDcmVhdG9yJ3Mgb3duIGZvcm1hdC5cclxuICAgIHJldHVybiBgZmlnbWEke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTQpfWA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGU6IGFueSwgcHJlZmFiUm9vdDogYW55LCBjYzogYW55KTogc3RyaW5nIHtcclxuICAgIGxldCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZE5vZGU/Lihub2RlKTtcclxuICAgIGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uUHJlZmFiSW5mbyA/PyBjYy5QcmVmYWJJbmZvO1xyXG4gICAgaWYgKCFQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBQcmVmYWJJbmZvIEFQSSDkuI3lj6/nlKjvvIzml6Dms5XkuLrmlrDoioLngrnnlJ/miJDnqLPlrpogZmlsZUlk44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbmZvID0gbmV3IFByZWZhYkluZm8oKTtcclxuICAgIGluZm8ucm9vdCA9IHByZWZhYlJvb3Q7XHJcbiAgICBpbmZvLmFzc2V0ID0gcHJlZmFiUm9vdD8uX3ByZWZhYj8uYXNzZXQgPz8gbnVsbDtcclxuICAgIGluZm8uZmlsZUlkID0gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTtcclxuICAgIGluZm8uaW5zdGFuY2UgPSBudWxsO1xyXG4gICAgaW5mby50YXJnZXRPdmVycmlkZXMgPSBudWxsO1xyXG4gICAgbm9kZS5fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQ6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY2NlQXBpPy5QcmVmYWI/Lm9uQWRkQ29tcG9uZW50Py4oY29tcG9uZW50KTtcclxuICAgIGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBDb21wUHJlZmFiSW5mbyA9IGNjLlByZWZhYj8uX3V0aWxzPy5Db21wUHJlZmFiSW5mbyA/PyBjYy5Db21wUHJlZmFiSW5mbztcclxuICAgIGlmICghQ29tcFByZWZhYkluZm8pIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIDMuOC43IENvbXBQcmVmYWJJbmZvIEFQSSDkuI3lj6/nlKjvvIzml6Dms5XkuLrmlrDnu4Tku7bnlJ/miJDnqLPlrpogZmlsZUlk44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbmZvID0gbmV3IENvbXBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBjb21wb25lbnQuX19wcmVmYWIgPSBpbmZvO1xyXG4gICAgcmV0dXJuIGluZm8uZmlsZUlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRQYXJlbnRLZWVwaW5nV29ybGQobm9kZTogYW55LCBwYXJlbnQ6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHR5cGVvZiBub2RlLnNldFBhcmVudCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIG5vZGUuc2V0UGFyZW50KHBhcmVudCwgdHJ1ZSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIG5vZGUucGFyZW50ID0gcGFyZW50O1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQ6IGFueSwgcGFyZW50OiBhbnksIGNjOiBhbnkpOiBib29sZWFuIHtcclxuICAgIGlmIChjaGlsZC5uYW1lID09PSBCQUNLR1JPVU5EX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSAnX19GaWdtYUNvbnRlbnQnKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gJ3ZpZXcnICYmIHBhcmVudC5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGNoaWxkLm5hbWUgPT09ICdjb250ZW50J1xyXG4gICAgICAgICYmIHBhcmVudC5uYW1lID09PSAndmlldydcclxuICAgICAgICAmJiBwYXJlbnQucGFyZW50Py5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgc3RhbGVVdWlkczogU2V0PHN0cmluZz4sXHJcbiAgICBjYzogYW55LFxyXG4pOiBudW1iZXIge1xyXG4gICAgbGV0IHJlbW92ZWQgPSAxO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubm9kZS5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoc3RhbGVVdWlkcy5oYXMoY2hpbGQudXVpZCkgfHwgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpIHtcclxuICAgICAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShjaGlsZCwgc3Vydml2b3JQYXJlbnQsIHN0YWxlVXVpZHMsIGNjKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHN1cnZpdm9yUGFyZW50KSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZVNjZW5lU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogU2NlbmVOb2RlU3BlYyB7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBub3JtYWxpemVJbXBvcnRBY3Rpb24oc3BlYy5hY3Rpb24gYXMgdW5rbm93bik7XHJcbiAgICBjb25zdCBraW5kID0ga2luZEZvckltcG9ydEFjdGlvbihzcGVjLmtpbmQsIGFjdGlvbik7XHJcbiAgICBjb25zdCBjaGlsZHJlbiA9IEFycmF5LmlzQXJyYXkoc3BlYy5jaGlsZHJlbikgPyBzcGVjLmNoaWxkcmVuIDogW107XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLnNwZWMsXHJcbiAgICAgICAgYWN0aW9uLFxyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgY2hpbGRyZW46IGlzVGVybWluYWxBY3Rpb24oYWN0aW9uKSB8fCBzcGVjLmZsYXR0ZW5Cb3VuZGFyeSA9PT0gdHJ1ZVxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKGNoaWxkKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIGNvbnN0IGlkcyA9IFtzcGVjLmZpZ21hSWQsIC4uLihzcGVjLmFsaWFzRmlnbWFJZHMgPz8gW10pXVxyXG4gICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCAmJiBpZCAhPT0gJ19fcm9vdF9fJyk7XHJcbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoaWRzKV07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBzdHJpbmdbXSB7XHJcbiAgICByZXR1cm4gZmlnbWFJZHNGb3JTcGVjKHNwZWMpLmZpbHRlcigoZmlnbWFJZCkgPT4gZmlnbWFJZCAhPT0gc3BlYy5maWdtYUlkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXhpc3RpbmdVdWlkRm9yU3BlYyhcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gZXhpc3RpbmdNYXBbZmlnbWFJZF07XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICBpZiAodHlwZW9mIHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSAnYm9vbGVhbicpIHtcclxuICAgICAgICByZXR1cm4gc3BlYy5mbGF0dGVuQm91bmRhcnk7XHJcbiAgICB9XHJcbiAgICAvLyBCYWNrd2FyZCBjb21wYXRpYmlsaXR5IGZvciBTY2VuZVNwZWNzIHBlcnNpc3RlZCBieSBpbXBvcnRlciB2ZXJzaW9uc1xyXG4gICAgLy8gYmVmb3JlIGZsYXR0ZW5Cb3VuZGFyeSB3YXMgaW50cm9kdWNlZC4gTmV3IHBsYW5zIGFsd2F5cyBzZXQgdGhlIGZsYWcgc29cclxuICAgIC8vIGZvbGRlZCBMYWJlbHMgYW5kIG90aGVyIHByb21vdGVkIHZpc3VhbHMgdXNlIHRoZSBzYW1lIGNsZWFudXAgc2VtYW50aWNzLlxyXG4gICAgcmV0dXJuIHNwZWMuYWN0aW9uID09PSAncmVuZGVyJ1xyXG4gICAgICAgIHx8IChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBCb29sZWFuKHNwZWMuc3ByaXRlKSAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgaW1wb3J0Um9vdDogYW55LFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBjdXJyZW50TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKGN1cnJlbnRNYXApKTtcclxuICAgIGNvbnN0IGJvdW5kYXJ5U3BlY3M6IEFycmF5PHtcclxuICAgICAgICBmaWdtYUlkOiBzdHJpbmc7XHJcbiAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiBib29sZWFuO1xyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgfT4gPSBbXTtcclxuICAgIGNvbnN0IGNvbGxlY3RCb3VuZGFyaWVzID0gKG5vZGVzOiBTY2VuZU5vZGVTcGVjW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgaWYgKGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogdHJ1ZSxcclxuICAgICAgICAgICAgICAgICAgICBhbGlhc0ZpZ21hSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGFsaWFzRmlnbWFJZHMgPSBhbGlhc0ZpZ21hSWRzRm9yU3BlYyhzcGVjKTtcclxuICAgICAgICAgICAgaWYgKGFsaWFzRmlnbWFJZHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBib3VuZGFyeVNwZWNzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZ21hSWQ6IHNwZWMuZmlnbWFJZCxcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoYWxpYXNGaWdtYUlkcyksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29sbGVjdEJvdW5kYXJpZXMoc3BlY3MpO1xyXG4gICAgY29uc3QgYm91bmRhcmllcyA9IGJvdW5kYXJ5U3BlY3NcclxuICAgICAgICAubWFwKChib3VuZGFyeSkgPT4gKHtcclxuICAgICAgICAgICAgLi4uYm91bmRhcnksXHJcbiAgICAgICAgICAgIG5vZGU6IGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF1cclxuICAgICAgICAgICAgICAgID8gZmluZEJ5VXVpZChpbXBvcnRSb290LCBjdXJyZW50TWFwW2JvdW5kYXJ5LmZpZ21hSWRdKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIH0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGJvdW5kYXJ5KTogYm91bmRhcnkgaXMgdHlwZW9mIGJvdW5kYXJ5ICYgeyBub2RlOiBhbnkgfSA9PiBCb29sZWFuKGJvdW5kYXJ5Lm5vZGUpKTtcclxuICAgIGlmICghYm91bmRhcmllcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlTm9kZXMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgcmV0YWluZWRVdWlkcy5oYXModXVpZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgYm91bmRhcnkgb2YgYm91bmRhcmllcykge1xyXG4gICAgICAgICAgICBpZiAoIWJvdW5kYXJ5LnJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50c1xyXG4gICAgICAgICAgICAgICAgJiYgIWJvdW5kYXJ5LmFsaWFzRmlnbWFJZHMuaGFzKGZpZ21hSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChib3VuZGFyeS5ub2RlLCB1dWlkKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgbm9kZSAhPT0gYm91bmRhcnkubm9kZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhbGVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKCFzdGFsZU5vZGVzLnNpemUpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlVXVpZHMgPSBuZXcgU2V0KHN0YWxlTm9kZXMua2V5cygpKTtcclxuICAgIGxldCByZW1vdmVkID0gMDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZU5vZGVzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgaWYgKCFub2RlLnBhcmVudCB8fCBzdGFsZVV1aWRzLmhhcyhub2RlLnBhcmVudC51dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShub2RlLCBub2RlLnBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgY3VycmVudE1hcFtmaWdtYUlkXSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCkpIHtcclxuICAgICAgICAgICAgY3VycmVudE1hcFtmaWdtYUlkXSA9IHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhcclxuICAgIGNvbnRhaW5lcjogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIGV4aXN0aW5nVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoZXhpc3RpbmdVdWlkcy5oYXMoY2hpbGQudXVpZCkpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoY2hpbGQsIHN1cnZpdm9yUGFyZW50LCBleGlzdGluZ1V1aWRzKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRDYW52YXMocm9vdDogYW55LCBDYW52YXM6IGFueSk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QuZ2V0Q29tcG9uZW50KENhbnZhcykpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZENhbnZhcyhjaGlsZCwgQ2FudmFzKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgY2xhc3NlczogYW55W10sXHJcbiAgICBwcmVzZXJ2ZWQ6IFNldDxhbnk+LFxyXG4gICAgcmVuZGVyQ2xhc3NlczogYW55W10sXHJcbiAgICByZW1vdmFibGVGaWxlSWRzPzogU2V0PHN0cmluZz4sXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgbGV0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgdHlwZSBvZiBjbGFzc2VzKSB7XHJcbiAgICAgICAgaWYgKHByZXNlcnZlZC5oYXModHlwZSkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xyXG4gICAgICAgIGlmIChjb21wb25lbnQpIHtcclxuICAgICAgICAgICAgaWYgKHJlbW92YWJsZUZpbGVJZHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFmaWxlSWQgfHwgIXJlbW92YWJsZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocmVuZGVyQ2xhc3Nlcy5zb21lKChyZW5kZXJUeXBlKSA9PiBjb21wb25lbnQgaW5zdGFuY2VvZiByZW5kZXJUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiK55qE5riy5p+T57uE5Lu25LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOS7peS/neaKpOaJi+W3peWGheWuueOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub2RlLnJlbW92ZUNvbXBvbmVudChjb21wb25lbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZW1vdmVkUmVuZGVyQ29tcG9uZW50O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVPYnNvbGV0ZUxhYmVsT3V0bGluZShub2RlOiBhbnksIGNjOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG91dGxpbmUgPSBub2RlLmdldENvbXBvbmVudChjYy5MYWJlbE91dGxpbmUpO1xyXG4gICAgaWYgKCFvdXRsaW5lKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gTGFiZWxPdXRsaW5lIHdhcyB1c2VkIGJ5IG9sZGVyIGltcG9ydGVyIHZlcnNpb25zLiBDb2NvcyBkZXN0cm95c1xyXG4gICAgLy8gY29tcG9uZW50cyBhdCB0aGUgZW5kIG9mIHRoZSBmcmFtZSBhbmQgaXRzIG9uRGlzYWJsZSgpIHdyaXRlcyBiYWNrIHRvXHJcbiAgICAvLyBMYWJlbC5lbmFibGVPdXRsaW5lLCBzbyBsZXQgdGhhdCBsaWZlY3ljbGUgZmluaXNoIGJlZm9yZSBlaXRoZXJcclxuICAgIC8vIHJlY29uZmlndXJpbmcgb3IgcmVtb3ZpbmcgdGhlIExhYmVsIGNvbXBvbmVudC5cclxuICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KG91dGxpbmUpO1xyXG4gICAgYXdhaXQgd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZXNpcmVkR2VuZXJhdGVkQ29tcG9uZW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55LCBub2RlOiBhbnkpOiBTZXQ8YW55PiB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICBpZiAoIXVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKSAmJiAhdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWMpKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLlNwcml0ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5SaWNoVGV4dCk7XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuTGFiZWwpO1xyXG4gICAgfSBlbHNlIGlmICghUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpIHx8IGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuR3JhcGhpY3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5NYXNrKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIGxheW91dE1vZGVcclxuICAgICAgICAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJyAmJiAhaGFzQnV0dG9uQW5jZXN0b3Iobm9kZSwgY2MpKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuQnV0dG9uKTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlVJT3BhY2l0eSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVzaXJlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAwKSk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJPd25lcnNoaXBHdWFyZCB7XHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzT3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgcmV0dXJuICFndWFyZC5wcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oZmlsZUlkICYmIGd1YXJkLnByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoZmlsZUlkKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgY29tcG9uZW50OiBhbnksXHJcbiAgICBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICBvd25lck5hbWU6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoIWNvbXBvbmVudCB8fCAhZ3VhcmQucHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoIWZpbGVJZCB8fCAhZ3VhcmQucHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBg6IqC54K54oCcJHtvd25lck5hbWV94oCd5LiK55qEICR7Y29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lID8/ICdDb21wb25lbnQnfSDkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGlmICghaXNPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDovoXliqnoioLngrnigJwke25vZGUubmFtZX3igJ3kuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KGNvbXBvbmVudCwgZ3VhcmQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIGlmIChpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShjaGlsZCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShcclxuICAgIGhlbHBlcjogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVtb3ZlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChndWFyZCAmJiBpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmUoY2hpbGQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICB9O1xyXG4gICAgcmVtb3ZlKGhlbHBlcik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBiYWNrZ3JvdW5kID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShCQUNLR1JPVU5EX05PREVfTkFNRSk7XHJcbiAgICBpZiAoIWJhY2tncm91bmQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGJhY2tncm91bmQsIG5vZGUsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKFxyXG4gICAgdGlsZWRTcHJpdGU6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIHN1cnZpdm9yLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGlsZWRTcHJpdGUgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKHRpbGVkU3ByaXRlLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZE92ZXJmbG93VmlzdWFsKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChoZWxwZXIpIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gQSBmbGF0dGVuZWQgbm9kZSBoYXMgbm8gbmV3IGNoaWxkIHNwZWNzIGJ5IGRlc2lnbi4gS2VlcCBldmVyeSBleGlzdGluZ1xyXG4gICAgLy8gY2hpbGQgYWxpdmUgdW50aWwgcmVtb3ZlRmxhdHRlbmVkTWFwcGVkRGVzY2VuZGFudHMgY2FuIGRpc3Rpbmd1aXNoIG9sZFxyXG4gICAgLy8gRmlnbWEtbWFwcGVkIG5vZGVzIGZyb20gdXNlci1hdXRob3JlZCBub2Rlcy4gT3RoZXJ3aXNlIGRlc3Ryb3lpbmcgdGhlXHJcbiAgICAvLyBoZWxwZXIgd291bGQgcmVjdXJzaXZlbHkgZGVzdHJveSBtYW51YWwgY2hpbGRyZW4gYXQgQ29jb3MnIGRlZmVycmVkXHJcbiAgICAvLyBkZXN0cnVjdGlvbiBib3VuZGFyeS5cclxuICAgIGNvbnN0IHByZXNlcnZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKTtcclxuICAgIGNvbnN0IG1vdmVDaGlsZHJlblRvTm9kZSA9IChjb250YWluZXI6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZ3VhcmQgfHwgcHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUobGVnYWN5KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICBjb25zdCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgY29uc3QgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50Jyk7XHJcbiAgICBpZiAoIXNjcm9sbCB8fCAhdmlldyB8fCAhY29udGVudFxyXG4gICAgICAgIHx8IChzY3JvbGwuY29udGVudCAhPT0gY29udGVudCAmJiBzY3JvbGwuY29udGVudCAhPSBudWxsKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBub2RlLCBndWFyZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUoY29udGVudCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udmlldy5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGNoaWxkICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29udGVudC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBjb250ZW50LmRlc3Ryb3koKTtcclxuICAgIHZpZXcucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgdmlldy5kZXN0cm95KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lUG9zaXRpb24oXHJcbiAgICBmcmFtZTogUmVjdCxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuICAgIGNoaWxkVHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0ge1xyXG4gICAgaWYgKCFwYXJlbnRGcmFtZSkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLCB5OiAxIH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd2lkdGggPSBmcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBjaGlsZEFuY2hvciA9IGNoaWxkVHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC8vIEZpZ21hIGNvb3JkaW5hdGVzIGFyZSBtZWFzdXJlZCBmcm9tIHRoZSBwYXJlbnQncyB0b3AtbGVmdC4gQ29udmVydFxyXG4gICAgICAgIC8vIHRoYXQgcmVjdGFuZ2xlIHRvIHRoZSBsb2NhbCBwb3NpdGlvbiBvZiB0aGUgbm9kZSdzIGNlbnRlciBhbmNob3IuXHJcbiAgICAgICAgeDogKGZyYW1lLnggLSBwYXJlbnRGcmFtZS54KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICArIHdpZHRoICogY2hpbGRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAtIChmcmFtZS55IC0gcGFyZW50RnJhbWUueSkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIGhlaWdodCAqICgxIC0gY2hpbGRBbmNob3IueSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoc3BlYy5pc1Jvb3QgfHwgIXNwZWMuaW50cmluc2ljU2l6ZSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IG1hdHJpeCA9IHNwZWMucmVsYXRpdmVUcmFuc2Zvcm07XHJcbiAgICBjb25zdCB2YWx1ZXMgPSBbXHJcbiAgICAgICAgbWF0cml4Py5bMF0/LlswXSwgbWF0cml4Py5bMF0/LlsxXSwgbWF0cml4Py5bMF0/LlsyXSxcclxuICAgICAgICBtYXRyaXg/LlsxXT8uWzBdLCBtYXRyaXg/LlsxXT8uWzFdLCBtYXRyaXg/LlsxXT8uWzJdLFxyXG4gICAgXTtcclxuICAgIGlmICghdmFsdWVzLmV2ZXJ5KCh2YWx1ZSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBbbTAwLCBtMDEsIHR4LCBtMTAsIG0xMSwgdHldID0gdmFsdWVzIGFzIG51bWJlcltdO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHBhcmVudFdpZHRoKSB8fCAhTnVtYmVyLmlzRmluaXRlKHBhcmVudEhlaWdodCkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEgcmVsYXRpdmVUcmFuc2Zvcm0gaXMgdG9wLWxlZnQgYmFzZWQuIFRyYW5zZm9ybSB0aGUgdW5yb3RhdGVkIGxvY2FsXHJcbiAgICAvLyBjZW50ZXIsIHRoZW4gY29udmVydCB0aGUgcGFyZW50J3MgZG93bndhcmQgWSBheGlzIHRvIENvY29zIHVwd2FyZCBZLlxyXG4gICAgY29uc3QgY2VudGVyWCA9IHR4ICsgbTAwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTAxICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCBjZW50ZXJZID0gdHkgKyBtMTAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMTEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgeDogY2VudGVyWCAqIHNjYWxlIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KSAtIGNlbnRlclkgKiBzY2FsZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtOiBhbnksIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XHJcbiAgICAvLyBSb3VuZCBvbmx5IGF0IHRoZSBVSVRyYW5zZm9ybSB3cml0ZSBib3VuZGFyeSwgYWZ0ZXIgc2NhbGUvbGF5b3V0IG1hdGguXHJcbiAgICAvLyBEbyBub3QgbG9jayBzaXplcyByZWNhbGN1bGF0ZWQgbGF0ZXIgYnkgTGFiZWwgb3Igb3RoZXIgcnVudGltZSBjb21wb25lbnRzLlxyXG4gICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLnJvdW5kKCh3aWR0aCArIE51bWJlci5FUFNJTE9OKSAqIDEwMCkgLyAxMDAsXHJcbiAgICAgICAgTWF0aC5yb3VuZCgoaGVpZ2h0ICsgTnVtYmVyLkVQU0lMT04pICogMTAwKSAvIDEwMCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IGFueSB7XHJcbiAgICBjb25zdCB7IFVJVHJhbnNmb3JtLCBWZWMzIH0gPSBjYztcclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyBub2RlLmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgY29uc3Qgc2l6ZSA9IHNwZWMuaW50cmluc2ljU2l6ZSA/PyBzcGVjLmZyYW1lO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBub2RlLnBhcmVudD8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3BlYy5pc1Jvb3RcclxuICAgICAgICA/IHsgeDogMCwgeTogMCB9XHJcbiAgICAgICAgOiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKHNwZWMsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IGZyYW1lUG9zaXRpb24oc3BlYy5mcmFtZSwgc3BlYy5wYXJlbnRGcmFtZSwgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSwgdHJhbnNmb3JtKTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbiAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIHNwZWMucm90YXRpb24pO1xyXG4gICAgbm9kZS5hY3RpdmUgPSBzcGVjLnZpc2libGU7XHJcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZFBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC50eXBlID09PSAnU09MSUQnXHJcbiAgICAgICAgJiYgcGFpbnQudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDBcclxuICAgICAgICAmJiBCb29sZWFuKHBhaW50LmNvbG9yKVxyXG4gICAgICAgICYmIChwYWludC5jb2xvcj8uYSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRGaWxsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiB2aXNpYmxlU29saWRQYWludChzcGVjLmZpbGxzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmlyc3RUZXh0RmlsbChwYWludHM6IEZpZ21hUGFpbnRbXSk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgLy8gRmlnbWEncyBwYWludCBhcnJheSBpcyBiYWNrLXRvLWZyb250OiB0aGUgcGFuZWwncyB0b3AgZmlsbCBpcyBsYXN0LlxyXG4gICAgLy8gTmF0aXZlIHRleHQga2VlcHMgdGhlIGZpcnN0IHVzYWJsZSBzb2xpZCBpbiBwYW5lbCBvcmRlciwgd2l0aG91dCBtaXhpbmdcclxuICAgIC8vIHN0YWNrZWQgZmlsbHMgb3IgY2hhbmdpbmcgdGhlIHNvdXJjZSBvcmRlciB1c2VkIGJ5IG90aGVyIHJlbmRlcmVycy5cclxuICAgIHJldHVybiB2aXNpYmxlU29saWRQYWludChbLi4ucGFpbnRzXS5yZXZlcnNlKCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2YWxpZFNvbGlkU3Ryb2tlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBzcGVjLnN0cm9rZVdlaWdodCA+IDAgPyB2aXNpYmxlU29saWRQYWludChzcGVjLnN0cm9rZXMpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiByb3VuZGVkU3Ryb2tlV2lkdGgod2VpZ2h0OiBudW1iZXIsIHNjYWxlOiBudW1iZXIsIG1pbmltdW06IG51bWJlcik6IG51bWJlciB7XHJcbiAgICAvLyBNYXRjaCBpbXBvcnRlZCBzaXplIHByZWNpc2lvbjsgcm91bmQgYWZ0ZXIgc2NhbGluZyBhbmQgcHJlc2VydmUgZXhpc3RpbmcgbWluaW11bXMuXHJcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgoTWF0aC5tYXgobWluaW11bSwgd2VpZ2h0ICogc2NhbGUpICsgTnVtYmVyLkVQU0lMT04pICogMTAwKSAvIDEwMDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzR3JhcGhpY3NWaXN1YWwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odmlzaWJsZVNvbGlkRmlsbChzcGVjKSB8fCB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0dyYXBoaWNzKGdyYXBoaWNzOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlU29saWRGaWxsKHNwZWMpO1xyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmFsaWRTb2xpZFN0cm9rZShzcGVjKTtcclxuICAgIGlmICghZmlsbCAmJiAhc3Ryb2tlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmFkaXVzID0gTWF0aC5tYXgoXHJcbiAgICAgICAgMCxcclxuICAgICAgICBNYXRoLm1pbihNYXRoLm1pbiguLi5zcGVjLmNvcm5lclJhZGlpKSAqIHNjYWxlLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpLFxyXG4gICAgKTtcclxuICAgIGlmIChzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZWxsaXBzZSgwLCAwLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpO1xyXG4gICAgfSBlbHNlIGlmIChyYWRpdXMgPiAwKSB7XHJcbiAgICAgICAgZ3JhcGhpY3Mucm91bmRSZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0LCByYWRpdXMpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBncmFwaGljcy5yZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0KTtcclxuICAgIH1cclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGxDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5maWxsKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmxpbmVXaWR0aCA9IHJvdW5kZWRTdHJva2VXaWR0aChzcGVjLnN0cm9rZVdlaWdodCwgc2NhbGUsIDAuNSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHcmFwaGljcyhub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGV4aXN0aW5nID0gbm9kZS5nZXRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xyXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBleGlzdGluZyA/PyBub2RlLmFkZENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBpZiAoIWV4aXN0aW5nKSBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKGdyYXBoaWNzKTtcclxuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgZ3JhcGhpY3MuY2xlYXIoKTtcclxuICAgIGRyYXdHcmFwaGljcyhncmFwaGljcywgc3BlYywgc2NhbGUsIGNjKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplTGFiZWxUZXh0KGNoYXJhY3RlcnM6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gKGNoYXJhY3RlcnMgPz8gJycpXHJcbiAgICAgICAgLnJlcGxhY2UoL1xcclxcbi9nLCAnXFxuJylcclxuICAgICAgICAucmVwbGFjZSgvW1xcclxcdTIwMjhcXHUyMDI5XS9nLCAnXFxuJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5VGV4dEFsaWdubWVudChjb21wb25lbnQ6IGFueSwgc3R5bGU6IFNjZW5lTm9kZVNwZWNbJ3RleHRTdHlsZSddLCByZW5kZXJlcjogYW55KTogdm9pZCB7XHJcbiAgICAvLyBDb2NvcyBoYXMgbm8gSlVTVElGSUVEIGFsaWdubWVudDogdW5zdXBwb3J0ZWQvbWlzc2luZyB2YWx1ZXMgdXNlIExFRlQvVE9QLlxyXG4gICAgY29tcG9uZW50Lmhvcml6b250YWxBbGlnbiA9IHN0eWxlPy50ZXh0QWxpZ25Ib3Jpem9udGFsID09PSAnQ0VOVEVSJ1xyXG4gICAgICAgID8gcmVuZGVyZXIuSG9yaXpvbnRhbEFsaWduLkNFTlRFUlxyXG4gICAgICAgIDogc3R5bGU/LnRleHRBbGlnbkhvcml6b250YWwgPT09ICdSSUdIVCdcclxuICAgICAgICAgICAgPyByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uUklHSFRcclxuICAgICAgICAgICAgOiByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uTEVGVDtcclxuICAgIGNvbXBvbmVudC52ZXJ0aWNhbEFsaWduID0gc3R5bGU/LnRleHRBbGlnblZlcnRpY2FsID09PSAnQ0VOVEVSJ1xyXG4gICAgICAgID8gcmVuZGVyZXIuVmVydGljYWxBbGlnbi5DRU5URVJcclxuICAgICAgICA6IHN0eWxlPy50ZXh0QWxpZ25WZXJ0aWNhbCA9PT0gJ0JPVFRPTSdcclxuICAgICAgICAgICAgPyByZW5kZXJlci5WZXJ0aWNhbEFsaWduLkJPVFRPTVxyXG4gICAgICAgICAgICA6IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uVE9QO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYVBhbmVsRm9udFNpemUodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB7XHJcbiAgICBjb25zdCBmb250U2l6ZSA9IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogMTY7XHJcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgoZm9udFNpemUgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYVBhbmVsTGluZUhlaWdodCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IGxpbmVIZWlnaHQgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IDE2O1xyXG4gICAgLy8gUHJlc2VydmUgRmlnbWEncyBwaXhlbCBsaW5lIGhlaWdodCBpbmRlcGVuZGVudGx5IG9mIGltcG9ydCBzY2FsZSBhbmRcclxuICAgIC8vIGVuZ2luZS1jb21wdXRlZCBjb250ZW50IHNpemU7IG9ubHkgcm91bmQgdG8gb25lIGRlY2ltYWwgcGxhY2UuXHJcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgobGluZUhlaWdodCArIE51bWJlci5FUFNJTE9OKSAqIDEwKSAvIDEwO1xyXG59XHJcblxyXG5sZXQgc3luY01hcmtlckZhaWx1cmU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5cclxuLyoqXHJcbiAqIOe7hOS7tuWQjOatpeagh+iusO+8muWPquWcqOiKgueCueS4iuWGmeaVsOaNru+8jOS4jeWPguS4jua4suafk+OAglxyXG4gKiDnu4Tku7bnsbvnlLHkuLvov5vnqIvnlJ/miJDliLAgYGFzc2V0cy9maWdtYS1pbXBvcnRlci1ydW50aW1lL0ZpZ21hU3luY05vZGUudHNg77yMXHJcbiAqIOWwmuacque8luivkeWujOaIkOaXtuaVtOasoeWvvOWFpemZjee6p+S4ulwi5peg5qCH6K6wXCLlubblm57kvKDorablkYrvvIzkuI3pmLvmlq3lu7rmoJHjgIJcclxuICovXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVN5bmNNYXJrZXIobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjKTogdm9pZCB7XHJcbiAgICBjb25zdCBtYXJrZXIgPSBzcGVjLnN5bmNNYXJrZXI7XHJcbiAgICBpZiAoIW1hcmtlciB8fCBzcGVjLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb21wb25lbnQgPSBub2RlLmdldENvbXBvbmVudChTWU5DX01BUktFUl9DTEFTUykgPz8gbm9kZS5hZGRDb21wb25lbnQoU1lOQ19NQVJLRVJfQ0xBU1MpO1xyXG4gICAgY29uc3QgdmFsdWVzID0gbWFya2VyVG9Db21wb25lbnRWYWx1ZXMobWFya2VyKSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWVzKSkge1xyXG4gICAgICAgIGNvbXBvbmVudFtrZXldID0gdmFsdWU7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDmoIforrDnu4Tku7bmsLjov5zlsZ7kuo7mj5Lku7bvvJrml6cgUHJlZmFiIOeahCBNZXRhIOWPr+iDveaYr+WcqOayoeacieagh+iusOeahOeJiOacrOWGmeS4i+eahO+8jFxyXG4gKiDlhbYgYG1hbmFnZWRDb21wb25lbnRGaWxlSWRzYCDph4zmsqHmnInmoIforrDvvIzkuI3og73lm6DmraTmiorlroPlvZPmiJBcIuaJi+W3pee7hOS7tlwi44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBpc1N5bmNNYXJrZXJDb21wb25lbnQoY29tcG9uZW50OiBhbnkpOiBib29sZWFuIHtcclxuICAgIGlmICghY29tcG9uZW50KSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKGNvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSA9PT0gU1lOQ19NQVJLRVJfQ0xBU1MpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBpc1N5bmNNYXJrZXJDb21wb25lbnRWYWx1ZShjb21wb25lbnQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYWJlbChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgTGFiZWwgfSA9IGNjO1xyXG4gICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIGNvbnN0IGNoYXJhY3RlcnMgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIC8vIEZpZ21hIE5PTkUgbWVhbnMgYSBmaXhlZCBib3gsIG5vdCBDb2NvcyBPdmVyZmxvdy5OT05FLiBCb3RoIGZpeGVkLXdpZHRoXHJcbiAgICAvLyBtb2RlcyB3cmFwIGFuZCBncm93IHZlcnRpY2FsbHk7IG1pc3NpbmcgbGVnYWN5IG1ldGFkYXRhIHN0YXlzIGF1dG8td2lkdGguXHJcbiAgICBjb25zdCB3cmFwID0gc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdIRUlHSFQnIHx8IHN0eWxlLnRleHRBdXRvUmVzaXplID09PSAnTk9ORSc7XHJcbiAgICAvLyBGaWdtYSBzdG9yZXMgbW9yZSBwcmVjaXNpb24gdGhhbiBpdHMgcGFuZWwgZGlzcGxheXMuIE1hdGNoIHRoZSB2aXNpYmxlXHJcbiAgICAvLyBkZXNpZ24gdmFsdWUgKHVwIHRvIHR3byBkZWNpbWFscykgaW5zdGVhZCBvZiBsZWFraW5nIGl0cyBpbnRlcm5hbCBmbG9hdC5cclxuICAgIGxhYmVsLmZvbnRTaXplID0gZmlnbWFQYW5lbEZvbnRTaXplKHN0eWxlLmZvbnRTaXplKTtcclxuICAgIGxhYmVsLmxpbmVIZWlnaHQgPSBmaWdtYVBhbmVsTGluZUhlaWdodChzdHlsZS5saW5lSGVpZ2h0UHggPz8gc3R5bGUuZm9udFNpemUpO1xyXG4gICAgbGFiZWwuc3BhY2luZ1ggPSAoc3R5bGUubGV0dGVyU3BhY2luZyA/PyAwKSAqIHNjYWxlO1xyXG4gICAgbGFiZWwub3ZlcmZsb3cgPSB3cmFwID8gTGFiZWwuT3ZlcmZsb3cuUkVTSVpFX0hFSUdIVCA6IExhYmVsLk92ZXJmbG93Lk5PTkU7XHJcbiAgICBsYWJlbC5lbmFibGVXcmFwVGV4dCA9IHdyYXA7XHJcbiAgICBhcHBseVRleHRBbGlnbm1lbnQobGFiZWwsIHN0eWxlLCBMYWJlbCk7XHJcbiAgICAvLyBBdXRvLXdpZHRoIGxhYmVscyB1c2UgYSBjZW50ZXJlZCB2ZXJ0aWNhbCBiYXNlbGluZSByZWdhcmRsZXNzIG9mIEZpZ21hJ3NcclxuICAgIC8vIHZlcnRpY2FsIGFsaWdubWVudC4gRml4ZWQtd2lkdGggd3JhcHBpbmcgbGFiZWxzIHJldGFpbiB0aGUgRmlnbWEgc2V0dGluZy5cclxuICAgIGlmIChsYWJlbC5vdmVyZmxvdyA9PT0gTGFiZWwuT3ZlcmZsb3cuTk9ORSkge1xyXG4gICAgICAgIGxhYmVsLnZlcnRpY2FsQWxpZ24gPSBMYWJlbC5WZXJ0aWNhbEFsaWduLkNFTlRFUjtcclxuICAgIH1cclxuICAgIGxhYmVsLnN0cmluZyA9IGNoYXJhY3RlcnM7XHJcbiAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gZmFsc2U7XHJcbiAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHsgcjogMSwgZzogMSwgYjogMSwgYTogMSB9KTtcclxuICAgIGNvbnN0IGZpbGwgPSBmaXJzdFRleHRGaWxsKHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgbGFiZWwuY29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdHJva2UgPSB2aXNpYmxlUGFpbnQoc3BlYy5zdHJva2VzKTtcclxuICAgIGlmIChzdHJva2U/LmNvbG9yICYmIHNwZWMuc3Ryb2tlV2VpZ2h0ID4gMCkge1xyXG4gICAgICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSB0cnVlO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZVdpZHRoID0gcm91bmRlZFN0cm9rZVdpZHRoKHNwZWMuc3Ryb2tlV2VpZ2h0LCBzY2FsZSwgMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBSaWNoVGV4dCB9ID0gY2M7XHJcbiAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KSA/PyBub2RlLmFkZENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgcmljaFRleHQuc3RyaW5nID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICByaWNoVGV4dC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICByaWNoVGV4dC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcclxuICAgIHJpY2hUZXh0Lm1heFdpZHRoID0gTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIHJpY2hUZXh0LmhhbmRsZVRvdWNoRXZlbnQgPSBmYWxzZTtcclxuICAgIGFwcGx5VGV4dEFsaWdubWVudChyaWNoVGV4dCwgc3R5bGUsIFJpY2hUZXh0KTtcclxuICAgIHJpY2hUZXh0LmZvbnRGYW1pbHkgPSBzdHlsZS5mb250RmFtaWx5ID8/ICcnO1xyXG4gICAgcmljaFRleHQudXNlU3lzdGVtRm9udCA9ICFzcGVjLmZvbnRVdWlkO1xyXG4gICAgcmljaFRleHQuZm9udENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xyXG4gICAgY29uc3QgZmlsbCA9IGZpcnN0VGV4dEZpbGwoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICByaWNoVGV4dC5mb250Q29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICB0YXJnZXRGcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0gc3BlYy5mcmFtZSxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xyXG4gICAgY29uc3Qgc3ByaXRlID0gbm9kZS5nZXRDb21wb25lbnQoU3ByaXRlKSA/PyBub2RlLmFkZENvbXBvbmVudChTcHJpdGUpO1xyXG4gICAgLy8gUmVzZXQgb24gZXZlcnkgaW1wb3J0OiBjb2xvciBiZWxvbmdzIHRvIHRoaXMgU3ByaXRlLCBuZXZlciBpdHMgc2hhcmVkXHJcbiAgICAvLyBTcHJpdGVGcmFtZS90ZXh0dXJlLiBOb2RlIG9wYWNpdHkgaXMgYXBwbGllZCBpbmRlcGVuZGVudGx5IGJ5IFVJT3BhY2l0eS5cclxuICAgIHNwcml0ZS5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHNwZWMuc3ByaXRlLnRpbnQgPz8geyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuXHJcbiAgICAvLyBLZWVwIGFzc2lnbm1lbnQgZGV0ZXJtaW5pc3RpYzogYSBuZXcgU3ByaXRlIG1heSBkZWZhdWx0IHRvIFRSSU1NRUQgYW5kXHJcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gYXdhaXQgbG9hZEFzc2V0KGFzc2V0TWFuYWdlciwgc3BlYy5zcHJpdGUudXVpZCk7XHJcbiAgICBzcHJpdGUuc3ByaXRlRnJhbWUgPSBzcHJpdGVGcmFtZTtcclxuICAgIGNvbnN0IHNsaWNlZCA9IHNwZWMuc3ByaXRlLnNsaWNlZCB8fCAoIXNwZWMuc3ByaXRlLnNsaWNlRmFsbGJhY2tcclxuICAgICAgICAmJiBbc3ByaXRlRnJhbWUuaW5zZXRMZWZ0LCBzcHJpdGVGcmFtZS5pbnNldFJpZ2h0LCBzcHJpdGVGcmFtZS5pbnNldFRvcCwgc3ByaXRlRnJhbWUuaW5zZXRCb3R0b21dXHJcbiAgICAgICAgICAgIC5zb21lKCh2YWx1ZSkgPT4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSAmJiB2YWx1ZSA+IDApKTtcclxuICAgIHNwcml0ZS50eXBlID0gc3BlYy5zcHJpdGUudGlsZWRcclxuICAgICAgICA/IFNwcml0ZS5UeXBlLlRJTEVEXHJcbiAgICAgICAgOiBzbGljZWRcclxuICAgICAgICAgICAgPyBTcHJpdGUuVHlwZS5TTElDRURcclxuICAgICAgICAgICAgOiBTcHJpdGUuVHlwZS5TSU1QTEU7XHJcblxyXG4gICAgaWYgKCFzbGljZWQgJiYgIXNwZWMuc3ByaXRlLnRpbGVkKSB7XHJcbiAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLlRSSU1NRUQ7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgcmF3V2lkdGggPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8ud2lkdGggPz8gc3ByaXRlRnJhbWU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZSh0cmltbWVkSGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIHJhd1dpZHRoID4gMFxyXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3V2lkdGggLSB0YXJnZXRXaWR0aCkgPD0gMC41MVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWSA9IHRhcmdldEhlaWdodCAvIHJhd0hlaWdodDtcclxuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyaW1tZWRXaWR0aCAqIHNjYWxlWCwgdHJpbW1lZEhlaWdodCAqIHNjYWxlWSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU2xpY2VkL3RpbGVkIHNwcml0ZXMgYW5kIHNwcml0ZXMgcmVzaXplZCBpbiBGaWdtYSBtdXN0IHJldGFpbiB0aGUgZGVzaWduXHJcbiAgICAvLyBzaXplLiBDb2NvcyByZXByZXNlbnRzIHRoYXQgc3RhdGUgYXMgQ1VTVE9NLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWlyZXNUaWxlZE1hc2soc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAndGlsZWQtaGVscGVyJykuc2hvdWxkTWFzaztcclxufVxyXG5cclxuZnVuY3Rpb24gbmF0aXZlVGlsZVNjYWxlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBudW1iZXIge1xyXG4gICAgY29uc3Qgc2NhbGUgPSBzcGVjLnNwcml0ZT8udGlsZVNjYWxlO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBzY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHNjYWxlKSAmJiBzY2FsZSA+IDBcclxuICAgICAgICA/IHNjYWxlXHJcbiAgICAgICAgOiAxO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnRpbGVkKVxyXG4gICAgICAgICYmIChyZXF1aXJlc1RpbGVkTWFzayhzcGVjKSB8fCBNYXRoLmFicyhuYXRpdmVUaWxlU2NhbGUoc3BlYykgLSAxKSA+IDFlLTYpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lKVxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8uc2xpY2VkXHJcbiAgICAgICAgJiYgIXNwZWMuc3ByaXRlPy50aWxlZDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3ZlcmZsb3dTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlbmRlckZyYW1lID0gc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lO1xyXG4gICAgaWYgKCFyZW5kZXJGcmFtZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6LaF6L6555WMIFBORyDoioLngrnigJwke3NwZWMubmFtZX3igJ3nvLrlsJHmuLLmn5PovrnnlYzjgIJgKTtcclxuICAgIH1cclxuICAgIGxldCBoZWxwZXIgPSBub2RlLmdldENoaWxkQnlOYW1lKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGd1YXJkICYmIGhlbHBlcikge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGlmICghaGVscGVyKSB7XHJcbiAgICAgICAgaGVscGVyID0gbmV3IGNjLk5vZGUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgbm9kZS5hZGRDaGlsZChoZWxwZXIpO1xyXG4gICAgfVxyXG4gICAgaGVscGVyLm5hbWUgPSBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FO1xyXG4gICAgaGVscGVyLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgIGhlbHBlci5hY3RpdmUgPSB0cnVlO1xyXG5cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGhlbHBlci5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgPz8gaGVscGVyLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShoZWxwZXIsIHNwZWMsIHNjYWxlLCBjYywgcmVuZGVyRnJhbWUpO1xyXG5cclxuICAgIGNvbnN0IGdlb21ldHJ5Q2VudGVyWCA9IHNwZWMuZnJhbWUueCArIHNwZWMuZnJhbWUud2lkdGggLyAyO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJZID0gc3BlYy5mcmFtZS55ICsgc3BlYy5mcmFtZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgcmVuZGVyQ2VudGVyWCA9IHJlbmRlckZyYW1lLnggKyByZW5kZXJGcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJZID0gcmVuZGVyRnJhbWUueSArIHJlbmRlckZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICAvLyBGaWdtYSBwYWdlIFkgcG9pbnRzIGRvd253YXJkIHdoaWxlIENvY29zIFVJIFkgcG9pbnRzIHVwd2FyZC5cclxuICAgIGNvbnN0IHdvcmxkRGVsdGFYID0gKHJlbmRlckNlbnRlclggLSBnZW9tZXRyeUNlbnRlclgpICogc2NhbGU7XHJcbiAgICBjb25zdCB3b3JsZERlbHRhWSA9IC0ocmVuZGVyQ2VudGVyWSAtIGdlb21ldHJ5Q2VudGVyWSkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBOdW1iZXIuaXNGaW5pdGUoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgID8gTnVtYmVyKHNwZWMud29ybGRSb3RhdGlvbilcclxuICAgICAgICA6IHNwZWMucm90YXRpb247XHJcbiAgICBjb25zdCByYWRpYW5zID0gd29ybGRSb3RhdGlvbiAqIE1hdGguUEkgLyAxODA7XHJcbiAgICBjb25zdCBjb3NpbmUgPSBNYXRoLmNvcyhyYWRpYW5zKTtcclxuICAgIGNvbnN0IHNpbmUgPSBNYXRoLnNpbihyYWRpYW5zKTtcclxuICAgIC8vIFRoZSBleHBvcnRlZCBQTkcgaXMgYWxyZWFkeSByYXN0ZXJpemVkIGluIEZpZ21hIHBhZ2UgYXhlcy4gQ291bnRlcmFjdFxyXG4gICAgLy8gdGhlIGxvZ2ljYWwgc2hlbGwncyBhY2N1bXVsYXRlZCByb3RhdGlvbiBhbmQgZXhwcmVzcyB0aGUgdmlzdWFsLWNlbnRlclxyXG4gICAgLy8gb2Zmc2V0IGJhY2sgaW4gdGhhdCBzaGVsbCdzIGxvY2FsIGNvb3JkaW5hdGUgc3lzdGVtLlxyXG4gICAgY29uc3QgbG9jYWxYID0gY29zaW5lICogd29ybGREZWx0YVggKyBzaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBjb25zdCBsb2NhbFkgPSAtc2luZSAqIHdvcmxkRGVsdGFYICsgY29zaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBoZWxwZXIuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMobG9jYWxYLCBsb2NhbFksIDApKTtcclxuICAgIGhlbHBlci5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAtd29ybGRSb3RhdGlvbik7XHJcbiAgICBoZWxwZXIuc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgaGVscGVyLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG5lZWRzTWFzayA9IHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpO1xyXG4gICAgbGV0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgbGV0IHRpbGVkU3ByaXRlID0gdGlsZWRNYXNrPy5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKVxyXG4gICAgICAgID8/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChuZWVkc01hc2spIHtcclxuICAgICAgICBpZiAoIXRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICB0aWxlZE1hc2sgPSBuZXcgY2MuTm9kZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgIG5vZGUuYWRkQ2hpbGQodGlsZWRNYXNrKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLm5hbWUgPSBUSUxFRF9NQVNLX05PREVfTkFNRTtcclxuICAgICAgICB0aWxlZE1hc2subGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHRpbGVkTWFzay5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG1hc2tUcmFuc2Zvcm0gPSB0aWxlZE1hc2suZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyB0aWxlZE1hc2suYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxyXG4gICAgICAgICAgICBtYXNrVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICAgICAgY29uZmlndXJlQ2xpcCh0aWxlZE1hc2ssIHNwZWMsIGNjLCAndGlsZWQtaGVscGVyJywgZ3VhcmQpO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnRpbGVkTWFzay5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICB0aWxlZE1hc2suZGVzdHJveSgpO1xyXG4gICAgICAgIHRpbGVkTWFzayA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzcHJpdGVQYXJlbnQgPSB0aWxlZE1hc2sgPz8gbm9kZTtcclxuICAgIGlmICghdGlsZWRTcHJpdGUpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZSA9IG5ldyBjYy5Ob2RlKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIHNwcml0ZVBhcmVudC5hZGRDaGlsZCh0aWxlZFNwcml0ZSk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkU3ByaXRlLnBhcmVudCAhPT0gc3ByaXRlUGFyZW50KSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUucGFyZW50ID0gc3ByaXRlUGFyZW50O1xyXG4gICAgfVxyXG4gICAgdGlsZWRTcHJpdGUubmFtZSA9IFRJTEVEX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICB0aWxlZFNwcml0ZS5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICB0aWxlZFNwcml0ZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKHRpbGVkU3ByaXRlLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG4gICAgY29uc3QgdGlsZVNjYWxlID0gbmF0aXZlVGlsZVNjYWxlKHNwZWMpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gdGlsZWRTcHJpdGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IHRpbGVkU3ByaXRlLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNjYWxlKG5ldyBjYy5WZWMzKHRpbGVTY2FsZSwgdGlsZVNjYWxlLCAxKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZU9wYWNpdHkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5ID49IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3BhY2l0eSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJT3BhY2l0eSkgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcclxuICAgIG9wYWNpdHkub3BhY2l0eSA9IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc3BlYy5vcGFjaXR5KSkgKiAyNTUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYXlvdXQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoIW1vZGUgfHwgbW9kZSA9PT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBMYXlvdXQsIFNpemUgfSA9IGNjO1xyXG4gICAgY29uc3QgbGF5b3V0ID0gbm9kZS5nZXRDb21wb25lbnQoTGF5b3V0KSA/PyBub2RlLmFkZENvbXBvbmVudChMYXlvdXQpO1xyXG4gICAgbGF5b3V0LnR5cGUgPSBtb2RlID09PSAnSE9SSVpPTlRBTCdcclxuICAgICAgICA/IExheW91dC5UeXBlLkhPUklaT05UQUxcclxuICAgICAgICA6IG1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuVHlwZS5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5UeXBlLkdSSUQ7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnKSB7XHJcbiAgICAgICAgbGF5b3V0LnN0YXJ0QXhpcyA9IHNwZWMubGF5b3V0Py5zb3VyY2VNb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LkF4aXNEaXJlY3Rpb24uVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuQXhpc0RpcmVjdGlvbi5IT1JJWk9OVEFMO1xyXG4gICAgfVxyXG4gICAgbGF5b3V0LnJlc2l6ZU1vZGUgPSBMYXlvdXQuUmVzaXplTW9kZS5OT05FO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdMZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1JpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdUb3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdCb3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdYID0gc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1kgPSAobW9kZSA9PT0gJ0dSSUQnID8gc3BlYy5sYXlvdXQhLmNvdW50ZXJTcGFjaW5nIDogc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nKSAqIHNjYWxlO1xyXG4gICAgY29uc3QgYWN0aXZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUpO1xyXG4gICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbldpZHRoID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUud2lkdGggKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nTGVmdCAtIGxheW91dC5wYWRkaW5nUmlnaHQ7XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWCA9IE1hdGgubWF4KDAsIChpbm5lcldpZHRoIC0gY2hpbGRyZW5XaWR0aCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbldpZHRoICsgbGF5b3V0LnNwYWNpbmdYICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVyV2lkdGggLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gJ1ZFUlRJQ0FMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbkhlaWdodCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLmhlaWdodCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lckhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ1RvcCAtIGxheW91dC5wYWRkaW5nQm90dG9tO1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1kgPSBNYXRoLm1heCgwLCAoaW5uZXJIZWlnaHQgLSBjaGlsZHJlbkhlaWdodCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbkhlaWdodCArIGxheW91dC5zcGFjaW5nWSAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lckhlaWdodCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBsYXlvdXQuY2VsbFNpemUgPSBuZXcgU2l6ZShcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS53aWR0aCkpICogc2NhbGUsXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUuaGVpZ2h0KSkgKiBzY2FsZSxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseUNvdW50ZXJBbGlnbm1lbnQoXHJcbiAgICBwYXJlbnQ6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgY29uc3QgYWxpZ25tZW50ID0gc3BlYy5sYXlvdXQ/LmNvdW50ZXJBbGlnbjtcclxuICAgIGlmICghbW9kZSB8fCAhYWxpZ25tZW50IHx8ICFbJ0hPUklaT05UQUwnLCAnVkVSVElDQUwnXS5pbmNsdWRlcyhtb2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IHBhcmVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0V2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB0b3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgY29uc3QgYm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgZm9yIChjb25zdCBjaGlsZFNwZWMgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkU3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBjaGlsZCA9IHV1aWQgPyBmaW5kQnlVdWlkKHBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNoaWxkPy5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIGlmICghY2hpbGQgfHwgIXRyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSBjaGlsZC5wb3NpdGlvbi5jbG9uZSgpO1xyXG4gICAgICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0SGVpZ2h0IC0gdG9wIC0gYm90dG9tKTtcclxuICAgICAgICAgICAgbGV0IHRvcE9mZnNldCA9IHRvcDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IHRvcCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0uaGVpZ2h0KSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gbGF5b3V0SGVpZ2h0IC0gYm90dG9tIC0gdHJhbnNmb3JtLmhlaWdodDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0cmFuc2Zvcm0ud2lkdGgsIGF2YWlsYWJsZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueSA9IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgICAgICAtIHRvcE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSB0cmFuc2Zvcm0uaGVpZ2h0ICogKDEgLSAodHJhbnNmb3JtLmFuY2hvclBvaW50Py55ID8/IDAuNSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dFdpZHRoIC0gbGVmdCAtIHJpZ2h0KTtcclxuICAgICAgICAgICAgbGV0IGxlZnRPZmZzZXQgPSBsZWZ0O1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxlZnQgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLndpZHRoKSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxheW91dFdpZHRoIC0gcmlnaHQgLSB0cmFuc2Zvcm0ud2lkdGg7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgYXZhaWxhYmxlLCB0cmFuc2Zvcm0uaGVpZ2h0KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi54ID0gbGVmdE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICAgICArIHRyYW5zZm9ybS53aWR0aCAqICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnggPz8gMC41KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2hpbGQuc2V0UG9zaXRpb24ocG9zaXRpb24pO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBsb2dNYXNrRGVjaXNpb24oc3BlYzogU2NlbmVOb2RlU3BlYywgdGFyZ2V0OiBNYXNrVGFyZ2V0ID0gJ25vZGUnKTogdm9pZCB7XHJcbiAgICBjb25zb2xlLmxvZygnW0ZpZ21hIEltcG9ydGVyIE1hc2sg5Yaz562WXScsIEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgbm9kZU5hbWU6IHNwZWMubmFtZSxcclxuICAgICAgICB0YXJnZXQsXHJcbiAgICAgICAgLi4uc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCksXHJcbiAgICB9KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQobm9kZTogYW55LCBjYzogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHR5cGUgb2YgW2NjLk1hc2ssIGNjLkdyYXBoaWNzXSkge1xyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xyXG4gICAgICAgIGlmICghY29tcG9uZW50KSBjb250aW51ZTtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcclxuICAgICAgICB9IGVsc2UgaWYgKCFzZXNzaW9uTWFza0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoQgJHt0eXBlLm5hbWV9IOe8uuWwkeWvvOWFpeWZqOW9kuWxnuiusOW9le+8jOW3suWBnOatouabtOaWsOS7peS/neaKpOaJi+W3pee7hOS7tu+8m+ivt+S9v+eUqOW4puWQjOatpeiusOW9leeahCBQcmVmYWIg5oiW5a+85YWl5Li65paw6IqC54K544CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVDbGlwKFxyXG4gICAgbm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55LCB0YXJnZXQ6IE1hc2tUYXJnZXQgPSAnbm9kZScsIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBzaG91bGRHZW5lcmF0ZU1hc2soc3BlYywgdGFyZ2V0KTtcclxuICAgIGlmICghZGVjaXNpb24uc2hvdWxkTWFzaykgcmV0dXJuO1xyXG4gICAgaWYgKHRhcmdldCAhPT0gJ25vZGUnKSBsb2dNYXNrRGVjaXNpb24oc3BlYywgdGFyZ2V0KTtcclxuICAgIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQobm9kZSwgY2MsIGd1YXJkKTtcclxuICAgIC8vIFByb3Zpc2lvbiBHcmFwaGljcyBldmVuIGZvciBpbmFjdGl2ZSBub2RlcyBzbyBvd25lcnNoaXAgaXMgY2FwdHVyZWQgbm93LFxyXG4gICAgLy8gbm90IGxvc3Qgd2hlbiBNYXNrLm9uTG9hZCBjcmVhdGVzIGl0cyByZW5kZXJlciBvbiBhIGxhdGVyIGFjdGl2YXRpb24uXHJcbiAgICBjb25zdCBncmFwaGljcyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKGdyYXBoaWNzKTtcclxuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgLy8gTWFzayBvd25zIHRoZSBkcmF3aW5nOiBjbGVhcmluZyBoZXJlIHdvdWxkIGVyYXNlIGEgcmV1c2VkIG1hc2sgd2hlbiB0aGVcclxuICAgIC8vIHR5cGUgc3RheXMgdW5jaGFuZ2VkIChpdHMgcHVibGljIHNldHRlciBkb2VzIG5vdCByZWRyYXcgaWRlbnRpY2FsIHR5cGVzKS5cclxuICAgIGNvbnN0IG1hc2sgPSBub2RlLmdldENvbXBvbmVudChjYy5NYXNrKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5NYXNrKTtcclxuICAgIHNlc3Npb25NYXNrQ29tcG9uZW50cy5hZGQobWFzayk7XHJcbiAgICBjb25zdCBtYXNrVHlwZSA9IGRlY2lzaW9uLm1hc2tUeXBlID09PSAnZWxsaXBzZSdcclxuICAgICAgICA/IGNjLk1hc2suVHlwZS5HUkFQSElDU19FTExJUFNFID8/IGNjLk1hc2suVHlwZS5FTExJUFNFXHJcbiAgICAgICAgOiBjYy5NYXNrLlR5cGUuR1JBUEhJQ1NfUkVDVCA/PyBjYy5NYXNrLlR5cGUuUkVDVDtcclxuICAgIHNldE1hc2tTaGFwZVNhZmVseShtYXNrLCBtYXNrVHlwZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjKS5zaG91bGRNYXNrO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNCdXR0b25BbmNlc3Rvcihub2RlOiBhbnksIGNjOiBhbnkpOiBib29sZWFuIHtcclxuICAgIGZvciAobGV0IHBhcmVudCA9IG5vZGUucGFyZW50OyBwYXJlbnQ7IHBhcmVudCA9IHBhcmVudC5wYXJlbnQpIHtcclxuICAgICAgICBpZiAocGFyZW50LmdldENvbXBvbmVudChjYy5CdXR0b24pKSByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ2J1dHRvbicgJiYgIWhhc0J1dHRvbkFuY2VzdG9yKG5vZGUsIGNjKSkge1xyXG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkJ1dHRvbikgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuQnV0dG9uKTtcclxuICAgICAgICBidXR0b24udGFyZ2V0ID0gbm9kZTtcclxuICAgICAgICBidXR0b24udHJhbnNpdGlvbiA9IGNjLkJ1dHRvbi5UcmFuc2l0aW9uLlNDQUxFO1xyXG4gICAgICAgIGJ1dHRvbi56b29tU2NhbGUgPSAwLjk7XHJcbiAgICAgICAgYnV0dG9uLmR1cmF0aW9uID0gMC4xO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHJhbnNmb3JtOiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IGFueSB7XHJcbiAgICBpZiAoIXNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAnc2Nyb2xsLXZpZXcnKS5zaG91bGRNYXNrKSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IE5vZGUsIFVJVHJhbnNmb3JtLCBTY3JvbGxWaWV3IH0gPSBjYztcclxuICAgIGxldCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgbGV0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG51bGw7XHJcbiAgICBpZiAodmlldyAmJiBndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChTY3JvbGxWaWV3KSA/PyBub2RlLmFkZENvbXBvbmVudChTY3JvbGxWaWV3KTtcclxuICAgIGlmICghdmlldykge1xyXG4gICAgICAgIHZpZXcgPSBuZXcgTm9kZSgndmlldycpO1xyXG4gICAgICAgIHZpZXcubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQodmlldyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3VHJhbnNmb3JtID0gdmlldy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IHZpZXcuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh2aWV3VHJhbnNmb3JtLCB0cmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgsIHRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpO1xyXG4gICAgdmlldy5zZXRQb3NpdGlvbigwLCAwLCAwKTtcclxuICAgIGNvbmZpZ3VyZUNsaXAodmlldywgc3BlYywgY2MsICdzY3JvbGwtdmlldycsIGd1YXJkKTtcclxuICAgIGlmICghY29udGVudCkge1xyXG4gICAgICAgIGNvbnRlbnQgPSBuZXcgTm9kZSgnY29udGVudCcpO1xyXG4gICAgICAgIGNvbnRlbnQubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHZpZXcuYWRkQ2hpbGQoY29udGVudCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250ZW50VHJhbnNmb3JtID0gY29udGVudC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGNvbnRlbnQuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHByZXZpb3VzTGF5b3V0ID0gY29udGVudC5nZXRDb21wb25lbnQoY2MuTGF5b3V0KTtcclxuICAgIGNvbnN0IG5leHRMYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAocHJldmlvdXNMYXlvdXQgJiYgKCFuZXh0TGF5b3V0TW9kZSB8fCBuZXh0TGF5b3V0TW9kZSA9PT0gJ05PTkUnKSkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChwcmV2aW91c0xheW91dCwgZ3VhcmQsIGNvbnRlbnQubmFtZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnRlbnQucmVtb3ZlQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0KTtcclxuICAgIH1cclxuICAgIGNvbnRlbnRUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCBjb250ZW50VHJhbnNmb3JtLCBzcGVjLCB0cmFuc2Zvcm0sIHNjYWxlKTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5ICYmIGxlZ2FjeSAhPT0gY29udGVudCkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobGVnYWN5LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmxlZ2FjeS5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBjb250ZW50KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgLy8gQ29jb3MgQ3JlYXRvciAzLjguNyBleHBlY3RzIHRoZSBjb250ZW50IE5vZGUgaGVyZS4gU2Nyb2xsVmlldy52aWV3IGlzIGFcclxuICAgIC8vIGdldHRlciBkZXJpdmVkIGZyb20gY29udGVudC5wYXJlbnQgYW5kIG11c3QgbmV2ZXIgYmUgYXNzaWduZWQgZGlyZWN0bHkuXHJcbiAgICBpZiAoc2Nyb2xsLmNvbnRlbnQgPT09IGNvbnRlbnQpIHtcclxuICAgICAgICBzY3JvbGwuY29udGVudCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBzY3JvbGwuY29udGVudCA9IGNvbnRlbnQ7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIHNjcm9sbC5ob3Jpem9udGFsID0gYXhlcy5ob3Jpem9udGFsO1xyXG4gICAgc2Nyb2xsLnZlcnRpY2FsID0gYXhlcy52ZXJ0aWNhbDtcclxuICAgIHJldHVybiBjb250ZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzY3JvbGxBeGVzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiB7IGhvcml6b250YWw6IGJvb2xlYW47IHZlcnRpY2FsOiBib29sZWFuIH0ge1xyXG4gICAgY29uc3QgZGlyZWN0aW9uID0gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbiAmJiBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICE9PSAnTk9ORSdcclxuICAgICAgICA/IHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24udHJpbSgpLnRvVXBwZXJDYXNlKClcclxuICAgICAgICA6ICdWRVJUSUNBTF9TQ1JPTExJTkcnO1xyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUwnIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0JPVEgnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUwnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiB0cnVlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBob3Jpem9udGFsOiBmYWxzZSwgdmVydGljYWw6IHRydWUgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIGNvbnRlbnRUcmFuc2Zvcm06IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aWV3cG9ydFdpZHRoID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy53aWR0aCkgfHwgMCk7XHJcbiAgICBjb25zdCB2aWV3cG9ydEhlaWdodCA9IE1hdGgubWF4KDAsIE51bWJlcih2aWV3cG9ydC5jb250ZW50U2l6ZT8uaGVpZ2h0KSB8fCAwKTtcclxuICAgIGNvbnN0IGNoaWxkUmlnaHQgPSBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+XHJcbiAgICAgICAgKGNoaWxkLmZyYW1lLnggLSBzcGVjLmZyYW1lLnggKyBjaGlsZC5mcmFtZS53aWR0aCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBjaGlsZEJvdHRvbSA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueSAtIHNwZWMuZnJhbWUueSArIGNoaWxkLmZyYW1lLmhlaWdodCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIGNvbnN0IGNvbnRlbnRXaWR0aCA9IGF4ZXMuaG9yaXpvbnRhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRXaWR0aCwgMCwgLi4uY2hpbGRSaWdodClcclxuICAgICAgICA6IHZpZXdwb3J0V2lkdGg7XHJcbiAgICBjb25zdCBjb250ZW50SGVpZ2h0ID0gYXhlcy52ZXJ0aWNhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRIZWlnaHQsIDAsIC4uLmNoaWxkQm90dG9tKVxyXG4gICAgICAgIDogdmlld3BvcnRIZWlnaHQ7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKGNvbnRlbnRUcmFuc2Zvcm0sIGNvbnRlbnRXaWR0aCwgY29udGVudEhlaWdodCk7XHJcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcclxuICAgICAgICAodmlld3BvcnRIZWlnaHQgLSBjb250ZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodCkgLyAyLFxyXG4gICAgICAgIDAsXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5hbGl6ZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBjb250ZW50OiBhbnksXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnIHx8IGNvbnRlbnQgPT09IG5vZGUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIXRyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoY29udGVudCwgdHJhbnNmb3JtLCBzcGVjLCB2aWV3cG9ydCwgc2NhbGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3VudFNwZWNzKHNwZWNzOiBTY2VuZU5vZGVTcGVjW10pOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHNwZWNzLnJlZHVjZSgodG90YWwsIHNwZWMpID0+IHRvdGFsICsgMSArIGNvdW50U3BlY3Moc3BlYy5jaGlsZHJlbiksIDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjZW50ZXJJbkNhbnZhcyhub2RlOiBhbnksIGNhbnZhczogYW55LCBVSVRyYW5zZm9ybTogYW55LCBWZWMzOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG5vZGVUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBjYW52YXNUcmFuc2Zvcm0gPSBjYW52YXM/LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIW5vZGVUcmFuc2Zvcm0gfHwgIWNhbnZhc1RyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGNhbnZhc1NpemUgPSBjYW52YXNUcmFuc2Zvcm0uY29udGVudFNpemUgPz8ge1xyXG4gICAgICAgIHdpZHRoOiBjYW52YXNUcmFuc2Zvcm0ud2lkdGgsXHJcbiAgICAgICAgaGVpZ2h0OiBjYW52YXNUcmFuc2Zvcm0uaGVpZ2h0LFxyXG4gICAgfTtcclxuICAgIGNvbnN0IHdpZHRoID0gTnVtYmVyKGNhbnZhc1NpemU/LndpZHRoKSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS53aWR0aCkgOiA2NDA7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBOdW1iZXIoY2FudmFzU2l6ZT8uaGVpZ2h0KSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS5oZWlnaHQpIDogMTEzNjtcclxuICAgIGNvbnN0IGNhbnZhc0FuY2hvciA9IGNhbnZhc1RyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBub2RlQW5jaG9yID0gbm9kZVRyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCB4ID0gd2lkdGggKiAoMC41IC0gY2FudmFzQW5jaG9yLngpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLndpZHRoICogKDAuNSAtIG5vZGVBbmNob3IueCk7XHJcbiAgICBjb25zdCB5ID0gaGVpZ2h0ICogKDAuNSAtIGNhbnZhc0FuY2hvci55KVxyXG4gICAgICAgIC0gbm9kZVRyYW5zZm9ybS5oZWlnaHQgKiAoMC41IC0gbm9kZUFuY2hvci55KTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMoeCwgeSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVDb21wb25lbnRzKG5vZGU6IGFueSk6IGFueVtdIHtcclxuICAgIGNvbnN0IHZhbHVlID0gbm9kZT8uY29tcG9uZW50cyA/PyBub2RlPy5fY29tcG9uZW50cztcclxuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSA/IHZhbHVlIDogW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlb3JkZXJGaWdtYUNoaWxkcmVuKHBhcmVudDogYW55LCBvcmRlcmVkTm9kZXM6IGFueVtdKTogdm9pZCB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gWy4uLm5ldyBTZXQob3JkZXJlZE5vZGVzLmZpbHRlcihCb29sZWFuKSldO1xyXG4gICAgaWYgKCFkZXNpcmVkLmxlbmd0aCB8fCB0eXBlb2YgZGVzaXJlZFswXT8uc2V0U2libGluZ0luZGV4ICE9PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEtb3duZWQgY2hpbGRyZW4gYXJlIGtlcHQgaW4gRmlnbWEgb3JkZXIuIFVzZXItYXV0aG9yZWQgY2hpbGRyZW4gYXJlXHJcbiAgICAvLyBuZXZlciByZW9yZGVyZWQgYWdhaW5zdCBvbmUgYW5vdGhlcjsgdGhleSBmb2xsb3cgdGhlIG1hbmFnZWQgYmxvY2suXHJcbiAgICBkZXNpcmVkLmZvckVhY2goKG5vZGUsIGluZGV4KSA9PiBub2RlLnNldFNpYmxpbmdJbmRleChpbmRleCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVTdGFsZVByZWZhYk5vZGVzKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgcHJldmlvdXNOb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHJldGFpbmVkTm9kZUZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IGluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCk7XHJcbiAgICBjb25zdCBzdGFsZSA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGVJZCBvZiBwcmV2aW91c05vZGVGaWxlSWRzKSB7XHJcbiAgICAgICAgaWYgKGZpbGVJZCA9PT0gbm9kZVByZWZhYkZpbGVJZChwcmVmYWJSb290KSB8fCByZXRhaW5lZE5vZGVGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gaW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgc3RhbGUuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVJZHMgPSBuZXcgU2V0KHN0YWxlLmtleXMoKSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygc3RhbGUudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBpZiAoaXNTeW5jTWFya2VyQ29tcG9uZW50KGNvbXBvbmVudCkpIHtcclxuICAgICAgICAgICAgICAgIC8vIOaPkuS7tuiHquW3seeahOWQjOatpeagh+iusOS4jeeul+aJi+W3pee7hOS7tu+8m+aXpyBNZXRhIOacquiusOW9leWug+S5n+WFgeiuuOWIoOmZpOOAglxyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICBg5b6F5Yig6Zmk55qEIEZpZ21hIOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneWQq+acieaJi+W3pee7hOS7tu+8jOW3suWBnOatouWQjOatpeS7pemYsuatouaVsOaNruS4ouWkseOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzID0gKGNvbnRhaW5lcjogYW55LCBzdXJ2aXZvclBhcmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoY2hpbGQpO1xyXG4gICAgICAgICAgICBpZiAoY2hpbGRGaWxlSWRcclxuICAgICAgICAgICAgICAgICYmIChwcmV2aW91c05vZGVGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkgfHwgcHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3QgW2ZpbGVJZCwgbm9kZV0gb2Ygc3RhbGUpIHtcclxuICAgICAgICBsZXQgYW5jZXN0b3IgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBsZXQgbmVzdGVkVW5kZXJTdGFsZSA9IGZhbHNlO1xyXG4gICAgICAgIHdoaWxlIChhbmNlc3RvciAmJiBhbmNlc3RvciAhPT0gcHJlZmFiUm9vdC5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgYW5jZXN0b3JGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGFuY2VzdG9yKTtcclxuICAgICAgICAgICAgaWYgKGFuY2VzdG9yRmlsZUlkICYmIHN0YWxlSWRzLmhhcyhhbmNlc3RvckZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIG5lc3RlZFVuZGVyU3RhbGUgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYW5jZXN0b3IgPSBhbmNlc3Rvci5wYXJlbnQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChuZXN0ZWRVbmRlclN0YWxlIHx8ICFub2RlLnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3Vydml2b3JQYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMobm9kZSwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgc3RhbGUuZGVsZXRlKGZpbGVJZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHByZXZpb3VzOiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PixcclxuICAgIGdlbmVyYXRlZENsYXNzZXM6IGFueVtdLFxyXG4gICAgY2M6IGFueSxcclxuKTogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB7XHJcbiAgICBjb25zdCBwcmV2aW91c0NvbXBvbmVudHMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzKTtcclxuICAgIGNvbnN0IHByZXZpb3VzSGVscGVycyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZEhlbHBlckZpbGVJZHMpO1xyXG4gICAgY29uc3Qgbm9kZUZpbGVJZHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGNvbnN0IG1hbmFnZWROb2RlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYXBwZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhub2RlTWFwKSk7XHJcbiAgICBjb25zdCBtYW5hZ2VkUnVudGltZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5ZCM5q2l57uT5p6c57y65bCRIEZpZ21hIOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG5vZGVGaWxlSWRzW2ZpZ21hSWRdID0gZmlsZUlkO1xyXG4gICAgICAgIG1hbmFnZWROb2Rlcy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkUnVudGltZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRUeXBlcyA9IG5ldyBTZXQoW2NjLlVJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgbWFuYWdlZFJ1bnRpbWVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGlmICghbWFuYWdlZENvbXBvbmVudFR5cGVzLmhhcyhjb21wb25lbnQuY29uc3RydWN0b3IpICYmICFpc1N5bmNNYXJrZXJDb21wb25lbnQoY29tcG9uZW50KSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGlmIChtYXBwZWRVdWlkcy5oYXMobm9kZS51dWlkKSB8fCBub2RlID09PSBwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgaWYgKCFwYXJlbnRcclxuICAgICAgICAgICAgfHwgKCFtYXBwZWRVdWlkcy5oYXMocGFyZW50LnV1aWQpICYmICFtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmhhcyhwYXJlbnQudXVpZCkpXHJcbiAgICAgICAgICAgIHx8ICFpc0dlbmVyYXRlZEhlbHBlck5vZGUobm9kZSwgcGFyZW50LCBjYykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKHByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzSGVscGVycy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtwYXJlbnQubmFtZX3igJ3kuIvlrZjlnKjkuI7lr7zlhaXovoXliqnoioLngrnlkIzlkI3nmoTmiYvlt6XoioLngrnigJwke25vZGUubmFtZX3igJ3vvIzlt7LlgZzmraLlkIzmraXjgIJgLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlcnMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoY29tcG9uZW50RmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG5vZGVGaWxlSWRzLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogWy4uLm1hbmFnZWROb2Rlc10sXHJcbiAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IFsuLi5tYW5hZ2VkQ29tcG9uZW50c10sXHJcbiAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IFsuLi5tYW5hZ2VkSGVscGVyc10sXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoUHJlZmFiTGF5b3V0cyhcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgdmlzaXQgPSAoc3BlYzogU2NlbmVOb2RlU3BlYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW3NwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHV1aWQgPyBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgID8gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpPy5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG5vZGVcclxuICAgICAgICAgICAgOiBub2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgYXBwbHlDb3VudGVyQWxpZ25tZW50KGNoaWxkUGFyZW50LCBzcGVjLCBub2RlTWFwLCBzY2FsZSwgY2MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGRQYXJlbnQgIT09IG5vZGUpIHtcclxuICAgICAgICAgICAgZmluYWxpemVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgIGNoaWxkUGFyZW50LFxyXG4gICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3BlYy5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgIH07XHJcbiAgICBzcGVjcy5mb3JFYWNoKHZpc2l0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQsXHJcbiAgICB2YWx1ZTogbnVtYmVyLFxyXG4gICAgbWVzc2FnZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYXlsb2FkLnBhY2thZ2VOYW1lLCAncHJvZ3Jlc3MnLCB7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZSxcclxuICAgICAgICAgICAgbWVzc2FnZSxcclxuICAgICAgICB9KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIOi/m+W6puWPjemmiOS4jeWPr+eUqOaXtuS4jeW6lOS4reaWreWcuuaZr+WvvOWFpeOAglxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzID0ge1xyXG4gICAgcmVmcmVzaFJldmlld0FmdGVyLFxyXG4gICAgcHJlcGFyZVJldmlld1JlbW92YWwsXHJcbiAgICBmaW5pc2hSZXZpZXdSZW1vdmFsLFxyXG4gICAgaW5zcGVjdFByZWZhYkNvbnRleHQocGF5bG9hZDoge1xyXG4gICAgICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgICAgICByb290RmlsZUlkPzogc3RyaW5nO1xyXG4gICAgfSk6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkVkaXRpbmdTdGF0ZShwYXlsb2FkLnByZWZhYlV1aWQsIHBheWxvYWQucm9vdEZpbGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydERvY3VtZW50KHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIHN5bmNNYXJrZXJGYWlsdXJlID0gbnVsbDtcclxuICAgICAgICBjb25zdCB7XHJcbiAgICAgICAgICAgIGRpcmVjdG9yLFxyXG4gICAgICAgICAgICBOb2RlLFxyXG4gICAgICAgICAgICBVSVRyYW5zZm9ybSxcclxuICAgICAgICAgICAgQ2FudmFzLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICAgICAgQ2FtZXJhLFxyXG4gICAgICAgIH0gPSBjYztcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgaWYgKCFzY2VuZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZr+OAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVmYWJDb250ZXh0ID0gcGF5bG9hZC5wcmVmYWJDb250ZXh0O1xyXG4gICAgICAgIGxldCBwcmVmYWJSb290OiBhbnkgfCBudWxsID0gbnVsbDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHByZWZhYkVkaXRpbmdTdGF0ZShwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQsIHByZWZhYkNvbnRleHQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDlsJrmnKrlronlhajmiZPlvIDvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwcmVmYWJSb290ID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2UuU2NlbmUucm9vdE5vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVJZEluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCwgcHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XHJcbiAgICAgICAgICAgICAgICBfX3Jvb3RfXzogcHJlZmFiUm9vdC51dWlkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCBmaWxlSWRdIG9mIE9iamVjdC5lbnRyaWVzKHByZWZhYkNvbnRleHQuZXhpc3RpbmdOb2RlRmlsZUlkcykpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaWxlSWRJbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGF5bG9hZC51cGRhdGVFeGlzdGluZyA9IHRydWU7XHJcbiAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAgPSBleGlzdGluZ01hcDtcclxuICAgICAgICAgICAgcGF5bG9hZC5jZW50ZXJJbkNhbnZhcyA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyA9IG5ldyBTZXQ8YW55PigpO1xyXG4gICAgICAgIGlmIChwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgICAgICBub2RlQ29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMuYWRkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gcGF5bG9hZC5yb290cy5tYXAoKHJvb3QpID0+IG5vcm1hbGl6ZVNjZW5lU3BlYyhyb290KSk7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQgJiYgcm9vdHMubGVuZ3RoICE9PSAxKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeWPquWFgeiuuOS4gOS4qiBGaWdtYSBGcmFtZSDmoLnoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmFsbGJhY2tQYXJlbnQgPSBwcmVmYWJSb290Py5wYXJlbnQgPz8gZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKSA/PyBzY2VuZTtcclxuICAgICAgICBjb25zdCBkaXJlY3RSb290ID0gcm9vdHMubGVuZ3RoID09PSAxO1xyXG4gICAgICAgIGNvbnN0IGNhbnZhcyA9IHByZWZhYlJvb3QgPyBudWxsIDogZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKTtcclxuICAgICAgICBjb25zdCBnZW5lcmF0ZWRDbGFzc2VzID0gW1xyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICBdO1xyXG4gICAgICAgIGNvbnN0IG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgICAgICBsZXQgY3JlYXRlZCA9IDA7XHJcbiAgICAgICAgbGV0IHVwZGF0ZWQgPSAwO1xyXG4gICAgICAgIGNvbnN0IHRvdGFsTm9kZXMgPSBNYXRoLm1heCgxLCBjb3VudFNwZWNzKHJvb3RzKSk7XHJcbiAgICAgICAgbGV0IGNvbXBsZXRlZE5vZGVzID0gMDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZEhlbHBlckZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZWZhYk93bmVyc2hpcEd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCB8IHVuZGVmaW5lZCA9IHByZWZhYkNvbnRleHRcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ05vZGVVdWlkczogcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290VXVpZCA9IHBheWxvYWQudXBkYXRlRXhpc3RpbmdcclxuICAgICAgICAgICAgPyBwYXlsb2FkLmV4aXN0aW5nTWFwLl9fcm9vdF9fXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGxldCBleGlzdGluZ1Jvb3ROb2RlID0gZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIGV4aXN0aW5nUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAoZXhpc3RpbmdSb290Tm9kZT8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgZXhpc3RpbmdSb290Tm9kZSA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIEluIGEgZGlyZWN0LXJvb3QgaW1wb3J0LCBfX3Jvb3RfXyBhbGlhc2VzIHRoZSBGaWdtYSByb290IFVVSUQuIEluIGFcclxuICAgICAgICAvLyBtdWx0aS1yb290IGltcG9ydCBpdCBpZGVudGlmaWVzIGEgc3ludGhldGljIHdyYXBwZXIgYW5kIG11c3QgbmV2ZXIgYmVcclxuICAgICAgICAvLyByZXVzZWQgYXMgb25lIG9mIGl0cyBvd24gY2hpbGRyZW4gd2hlbiB0aGUgcm9vdCBjb3VudCBjaGFuZ2VzLlxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA9IEJvb2xlYW4oZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICAmJiBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKS5zb21lKChbZmlnbWFJZCwgdXVpZF0pID0+XHJcbiAgICAgICAgICAgICAgICBmaWdtYUlkICE9PSAnX19yb290X18nICYmIHV1aWQgPT09IGV4aXN0aW5nUm9vdFV1aWQpKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c0RpcmVjdFJvb3QgPSBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c1dyYXBwZXIgPSAhZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgbWFwcGVkUm9vdFV1aWQgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gZXhpc3RpbmdVdWlkRm9yU3BlYyhwYXlsb2FkLmV4aXN0aW5nTWFwLCByb290c1swXSlcclxuICAgICAgICAgICAgOiAoIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdFV1aWQgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGxldCBpbXBvcnRSb290ID0gcHJlZmFiUm9vdCA/PyAocGF5bG9hZC51cGRhdGVFeGlzdGluZyAmJiBtYXBwZWRSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFJvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGwpO1xyXG4gICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBpbXBvcnRSb290Py5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbGVnYWN5V3JhcHBlciA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBwcmV2aW91c1dyYXBwZXIgPz8gKGltcG9ydFJvb3Q/LnBhcmVudD8ubmFtZS5zdGFydHNXaXRoKCdGaWdtYSDCtyAnKVxyXG4gICAgICAgICAgICAgICAgPyBpbXBvcnRSb290LnBhcmVudFxyXG4gICAgICAgICAgICAgICAgOiBudWxsKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcmV1c2VkSW1wb3J0Um9vdCA9IEJvb2xlYW4oaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3QmVmb3JlID0gcGF5bG9hZC5yZXZpZXdJZFxyXG4gICAgICAgICAgICA/IGNhcHR1cmVSZXZpZXdTY2VuZShpbXBvcnRSb290ID8/IGV4aXN0aW5nUm9vdE5vZGUsIGNjLCBwYXlsb2FkLmV4aXN0aW5nTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dD8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gcmV2aWV3TWFuYWdlZENvbXBvbmVudElkcyhpbXBvcnRSb290ID8/IGV4aXN0aW5nUm9vdE5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCwgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSkpXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZhbGxiYWNrUGFyZW50O1xyXG4gICAgICAgIGlmICghZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YCk7XHJcbiAgICAgICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnBhcmVudCA9IHBhcmVudDtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QubmFtZSA9IGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gO1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm0gPSBpbXBvcnRSb290LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gaW1wb3J0Um9vdC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcclxuICAgICAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS53aWR0aCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS5oZWlnaHQgKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpbXBvcnRSb290LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGNsZWFuTmFtZShyb290c1swXS5uYW1lKSk7XHJcbiAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEEgY29sbGFwc2VkIFNjZW5lU3BlYyBjYW4gaW50ZW50aW9uYWxseSBtYXAgc2V2ZXJhbCBGaWdtYSBJRHMgdG8gYVxyXG4gICAgICAgIC8vIHNpbmdsZSBDb2NvcyBub2RlLiBJZiBhIGxhdGVyIGltcG9ydCBleHBhbmRzIHRoYXQgc3VidHJlZSBhZ2FpbixcclxuICAgICAgICAvLyB0aG9zZSBJRHMgc3RpbGwgcG9pbnQgYXQgdGhlIHNhbWUgb2xkIFVVSUQuIENsYWltIGVhY2ggcmV1c2FibGUgbm9kZVxyXG4gICAgICAgIC8vIG9uY2UgcGVyIGJ1aWxkIHNvIGEgY2hpbGQgY2FuIG5ldmVyIHJldXNlIChhbmQgcmVwYXJlbnQpIGl0cyBwYXJlbnQuXHJcbiAgICAgICAgY29uc3QgY2xhaW1lZE5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gYXN5bmMgKFxyXG4gICAgICAgICAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgICAgICAgICBub2RlUGFyZW50OiBhbnksXHJcbiAgICAgICAgICAgIHByb3ZpZGVkTm9kZT86IGFueSxcclxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICAgICAgbG9nTWFza0RlY2lzaW9uKHNwZWMpO1xyXG4gICAgICAgICAgICBsZXQgbm9kZSA9IHByb3ZpZGVkTm9kZSA/PyBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUgJiYgcGF5bG9hZC51cGRhdGVFeGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZFV1aWQgPSBwYXlsb2FkLmV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZE5vZGUgPSBtYXBwZWRVdWlkID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkVXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXBwZWROb2RlICYmICFjbGFpbWVkTm9kZVV1aWRzLmhhcyhtYXBwZWROb2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUgPSBtYXBwZWROb2RlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgY2xhaW1lZE5vZGVVdWlkcy5oYXMobm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RlZCA9IEJvb2xlYW4obm9kZSk7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG5ldyBOb2RlKGNsZWFuTmFtZShzcGVjLm5hbWUpKTtcclxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nICYmICFwcmVmYWJPd25lcnNoaXBHdWFyZCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spIHx8IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIC8vIEluY2x1ZGUgZ2VuZXJhdGVkIHZpZXcvdGlsZWQgaGVscGVycyBiZWZvcmUgYW55IGRlbGV0aW9uIG9yXHJcbiAgICAgICAgICAgICAgICAvLyByZWNvbmZpZ3VyYXRpb24uIE5ldmVyIGluZmVyIG93bmVyc2hpcCBmcm9tIHRoZWlyIG5hbWVzIGFsb25lLlxyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGhlbHBlci5nZXRDb21wb25lbnQoTWFzaykpIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQoaGVscGVyLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHByZWZhYk93bmVyc2hpcEd1YXJkICYmIGV4aXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZC5uYW1lID09PSAndmlldycpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBoZWxwZXIubmFtZSA9PT0gJ3ZpZXcnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oJ2NvbnRlbnQnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaGVscGVyLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZSA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKHRpbGVkU3ByaXRlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdlbmVyYXRlZENsYXNzZXMuaW5jbHVkZXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2xhaW1lZE5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgaWYgKCEocHJlZmFiQ29udGV4dCAmJiBub2RlID09PSBwcmVmYWJSb290KSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5wYXJlbnQgPSBub2RlUGFyZW50O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUubmFtZSA9IGNsZWFuTmFtZShzcGVjLm5hbWUpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMuc3luY01hcmtlciAmJiBzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScgJiYgc3luY01hcmtlckZhaWx1cmUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlU3luY01hcmtlcihub2RlLCBzcGVjKTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3luY01hcmtlckZhaWx1cmUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhub2RlLCBzcGVjLCBjYywgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlc2VydmVkID0gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYywgY2MsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgLy8gTWFzayBvd25zIGFuZCBkaXNhYmxlcyBpdHMgc2hhcmVkIEdyYXBoaWNzIGR1cmluZyB0aGVcclxuICAgICAgICAgICAgICAgIC8vIGRlZmVycmVkIG9uRGlzYWJsZSBwaGFzZS4gSWYgY2xpcHBpbmcgd2FzIHJlbW92ZWQgYnV0IGFcclxuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBHcmFwaGljcyByZW5kZXJlciBpcyBzdGlsbCBkZXNpcmVkLCByZWNyZWF0ZSB0aGF0XHJcbiAgICAgICAgICAgICAgICAvLyByZW5kZXJlciBvbmx5IGFmdGVyIHRoZSBvbGQgTWFzayBsaWZlY3ljbGUgaGFzIGNvbXBsZXRlZC5cclxuICAgICAgICAgICAgICAgIGlmICghcHJlc2VydmVkLmhhcyhNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgcHJlc2VydmVkLmhhcyhHcmFwaGljcykpIHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQuZGVsZXRlKEdyYXBoaWNzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdGVkQ2xhc3NlcyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgW0dyYXBoaWNzLCBTcHJpdGUsIExhYmVsLCBSaWNoVGV4dF0sXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCA/IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlbW92ZWRSZW5kZXJDb21wb25lbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlSGVscGVyID0gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3ZlcmZsb3dTcHJpdGVIZWxwZXIgPSB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIW92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkT3ZlcmZsb3dWaXN1YWwobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2xpcHNDaGlsZHJlbiA9IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInIHx8IHNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBORyDmlbTlsYLoioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIzotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAncmljaFRleHQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlUmljaFRleHQobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNjLlRURkZvbnQgJiYgIShmb250IGluc3RhbmNlb2YgY2MuVFRGRm9udCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUmljaFRleHQg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5Y+q6IO95L2/55SoIFRURi9PVEYg5a2X5L2T77yM5b2T5YmN5pig5bCE5Y+v6IO95pivIEJpdG1hcEZvbnTvvIguZm5077yJ44CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IGZvbnQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5maWdtYVR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxhYmVsKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWwuZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKS5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKFJBU1RFUl9WRUNUT1JfVFlQRVMuaGFzKHNwZWMuZmlnbWFUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55+i6YeP6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yMUE5HIOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlQ2xpcChub2RlLCBzcGVjLCBjYywgJ25vZGUnLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICAgICA/IG5vZGVcclxuICAgICAgICAgICAgICAgIDogY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlTGF5b3V0KGNoaWxkUGFyZW50LCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChjaGlsZCwgY2hpbGRQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW9yZGVyRmlnbWFDaGlsZHJlbihcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGQuZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB1dWlkID8gZmluZEJ5VXVpZChjaGlsZFBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChMYXlvdXQpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKG5vZGUsIHNwZWMsIGNoaWxkUGFyZW50LCB0cmFuc2Zvcm0sIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGVkICYmIHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lICs9ICcgwrcgVHJhbnNmb3JtJztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZWROb2RlcyArPSAxO1xyXG4gICAgICAgICAgICBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgICAgICAgICAgICAgIHBheWxvYWQsXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZWROb2RlcyAvIHRvdGFsTm9kZXMsXHJcbiAgICAgICAgICAgICAgICBg5p6E5bu66IqC54K5ICR7Y29tcGxldGVkTm9kZXN9LyR7dG90YWxOb2Rlc30gwrcgJHtzcGVjLm5hbWV9YCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKHJvb3QsIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LCBkaXJlY3RSb290ID8gaW1wb3J0Um9vdCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCxcclxuICAgICAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNlbnRlckluQ2FudmFzICYmIGNhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNlbnRlckluQ2FudmFzKGltcG9ydFJvb3QsIGNhbnZhcywgVUlUcmFuc2Zvcm0sIGNjLlZlYzMpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFsZVRyYW5zaXRpb25VdWlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKVxyXG4gICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKFtmaWdtYUlkLCB1dWlkXSkgPT4gZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiAhcmV0YWluZWRVdWlkcy5oYXModXVpZCkpXHJcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgoWywgdXVpZF0pID0+IHV1aWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgbGVnYWN5V3JhcHBlciAmJiBsZWdhY3lXcmFwcGVyICE9PSBpbXBvcnRSb290ICYmIGxlZ2FjeVdyYXBwZXIucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShsZWdhY3lXcmFwcGVyLCBwYXJlbnQsIHN0YWxlVHJhbnNpdGlvblV1aWRzLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIHByZXZpb3VzRGlyZWN0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290ICE9PSBpbXBvcnRSb290XHJcbiAgICAgICAgICAgICAgICAmJiAhcmV0YWluZWRVdWlkcy5oYXMocHJldmlvdXNEaXJlY3RSb290LnV1aWQpXHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91c0RpcmVjdFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgc3RhbGVUcmFuc2l0aW9uVXVpZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhpbXBvcnRSb290LCBwYXlsb2FkLmV4aXN0aW5nTWFwLCBub2RlTWFwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICghcmV1c2VkSW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldChPYmplY3QudmFsdWVzKHBheWxvYWQuZXhpc3RpbmdNYXApKSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgcHJlZmFiU3luYzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZE5vZGVGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KHBheWxvYWQucmV0YWluTm9kZUZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlrprkvY3lr7zlhaXlkI7nmoToioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXRhaW5lZE5vZGVGaWxlSWRzLmFkZChlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBpbXBvcnRSb290LCBjYykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgbmV3IFNldChwcmVmYWJDb250ZXh0Lm1hbmFnZWROb2RlRmlsZUlkcyksXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHJlZnJlc2hQcmVmYWJMYXlvdXRzKHJvb3RzLCBpbXBvcnRSb290LCBub2RlTWFwLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMgPSBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAobm9kZVByZWZhYkZpbGVJZChpbXBvcnRSb290KSAhPT0gcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOWcqOWQjOatpei/h+eoi+S4reWPkeeUn+WPmOWMlu+8jOW3suaLkue7neS/neWtmOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHJldmlld0JlZm9yZSxcclxuICAgICAgICAgICAgcmV2aWV3QWZ0ZXI6IHBheWxvYWQucmV2aWV3SWQgPyByZWdpc3RlclNjZW5lUmV2aWV3KHBheWxvYWQucmV2aWV3SWQsIGltcG9ydFJvb3QsIGNjLCBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiU3luYz8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gcmV2aWV3TWFuYWdlZENvbXBvbmVudElkcyhpbXBvcnRSb290LCBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIFtVSVRyYW5zZm9ybSwgLi4uZ2VuZXJhdGVkQ2xhc3Nlc10pLCBwcmVmYWJDb250ZXh0XHJcbiAgICAgICAgICAgICAgICAgICAgPyB7IHRhcmdldFV1aWQ6IHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCwgbW9kZTogJ3ByZWZhYicgfSA6IHVuZGVmaW5lZCkgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIHJvb3RVdWlkOiBpbXBvcnRSb290LnV1aWQsXHJcbiAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgIGNyZWF0ZWQsXHJcbiAgICAgICAgICAgIHVwZGF0ZWQsXHJcbiAgICAgICAgICAgIHRlbXBvcmFyeVJvb3Q6ICFwcmVmYWJDb250ZXh0ICYmIGRpcmVjdFJvb3QgJiYgIXJldXNlZEltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMsXHJcbiAgICAgICAgICAgIC4uLihzeW5jTWFya2VyRmFpbHVyZSA/IHsgc3luY01hcmtlcldhcm5pbmc6IHN5bmNNYXJrZXJGYWlsdXJlIH0gOiB7fSksXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcblxyXG4gICAgcmVtb3ZlSW1wb3J0ZWROb2RlKHBheWxvYWQ6IHsgcm9vdFV1aWQ6IHN0cmluZyB9KTogYm9vbGVhbiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGNjLmRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lID8gZmluZEJ5VXVpZChzY2VuZSwgcGF5bG9hZC5yb290VXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0b3AgcmVuZGVyaW5nIGltbWVkaWF0ZWx5LiBDb2NvcyBkZXN0cm95cyBub2RlcyBhdCB0aGUgZW5kIG9mIHRoZVxyXG4gICAgICAgIC8vIGZyYW1lLCBzbyByZW1vdmluZyB0aGUgcGFyZW50IGFsb25lIGNhbiBsZWF2ZSBhIG9uZS1mcmFtZSBnaG9zdC5cclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSxcclxufTtcclxuIl19