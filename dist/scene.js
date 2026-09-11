"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const node_name_1 = require("./node-name");
const mask_policy_1 = require("./mask-policy");
const prefab_reference_1 = require("./prefab-reference");
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
    var _a, _b, _c, _d;
    // A referenced asset owns its whole subtree, even if its node names happen
    // to match one of our helper names.
    if ((_a = child === null || child === void 0 ? void 0 : child._prefab) === null || _a === void 0 ? void 0 : _a.instance)
        return false;
    if (child.name === BACKGROUND_NODE_NAME
        || child.name === TILED_MASK_NODE_NAME
        || child.name === TILED_SPRITE_NODE_NAME
        || child.name === OVERFLOW_SPRITE_NODE_NAME
        || child.name === '__FigmaContent') {
        return true;
    }
    if (child.name === 'view' && ((_b = parent.getComponent) === null || _b === void 0 ? void 0 : _b.call(parent, cc.ScrollView))) {
        return true;
    }
    return child.name === 'content'
        && parent.name === 'view'
        && ((_d = (_c = parent.parent) === null || _c === void 0 ? void 0 : _c.getComponent) === null || _d === void 0 ? void 0 : _d.call(_c, cc.ScrollView));
}
function removeMappedNodeTree(node, survivorParent, staleUuids, cc) {
    (0, prefab_reference_1.removePrefabReference)(node);
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
    if (spec.prefab) {
        if (spec.opacity < 0.999)
            desired.add(cc.UIOpacity);
        return desired;
    }
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
    var _a;
    if ((_a = helper === null || helper === void 0 ? void 0 : helper._prefab) === null || _a === void 0 ? void 0 : _a.instance)
        return;
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
        graphics.lineWidth = Math.max(0.5, spec.strokeWeight * scale);
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
        label.outlineWidth = Math.max(1, spec.strokeWeight * scale);
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
        (0, prefab_reference_1.assertReferenceRemovable)(node);
        for (const component of nodeComponents(node)) {
            const componentFileId = componentPrefabFileId(component);
            if (!componentFileId || !previousComponentFileIds.has(componentFileId)) {
                throw new Error(`待删除的 Figma 节点“${node.name}”含有手工组件，已停止同步以防止数据丢失。`);
            }
        }
    }
    const salvageManualDescendants = (container, survivorParent) => {
        (0, prefab_reference_1.removePrefabReference)(container);
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
    inspectPrefabContext(payload) {
        return prefabEditingState(payload.prefabUuid, payload.rootFileId);
    },
    async importDocument(payload) {
        var _a, _b, _c, _d, _e, _f, _g;
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
            const rootTransform = (_g = importRoot.getComponent(UITransform)) !== null && _g !== void 0 ? _g : importRoot.addComponent(UITransform);
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
            const previousReference = (0, prefab_reference_1.referencedPrefabChild)(node);
            if (previousReference && (!spec.prefab
                || prefabAssetUuid(previousReference) !== spec.prefab.uuid))
                (0, prefab_reference_1.assertReferenceRemovable)(node);
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
                if (!spec.prefab)
                    (0, prefab_reference_1.removePrefabReference)(node);
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
                if (spec.prefab) {
                    if (prefabContext)
                        ensureNodePrefabInfo(node, prefabRoot, cc);
                    await (0, prefab_reference_1.configurePrefabReference)(node, spec.prefab, cc);
                }
                else if (spec.action === 'render' || spec.sprite) {
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
                if (!spec.prefab)
                    configureButton(node, spec, cc);
            }
            const transform = node.getComponent(UITransform);
            const childParent = spec.prefab || spec.action === 'transform'
                ? node
                : configureScroll(node, spec, transform, payload.scale, cc, prefabOwnershipGuard);
            if (!spec.prefab && spec.action === 'generate') {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBbXVEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBcnVEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFDL0MsK0NBQXVFO0FBRXZFLHlEQUFzSTtBQUV0SSxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFBLFdBQUksRUFBQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxjQUFjLENBQUMsQ0FBQyxDQUFDO0FBeUJ6RCxNQUFNLG9CQUFvQixHQUFHLG1CQUFtQixDQUFDO0FBQ2pELE1BQU0sb0JBQW9CLEdBQUcsa0JBQWtCLENBQUM7QUFDaEQsTUFBTSxzQkFBc0IsR0FBRyxvQkFBb0IsQ0FBQztBQUNwRCxNQUFNLHlCQUF5QixHQUFHLHVCQUF1QixDQUFDO0FBQzFELDZFQUE2RTtBQUM3RSwyRUFBMkU7QUFDM0UsTUFBTSxxQkFBcUIsR0FBRyxJQUFJLE9BQU8sRUFBVSxDQUFDO0FBQ3BELE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDaEMsUUFBUTtJQUNSLG1CQUFtQjtJQUNuQixNQUFNO0lBQ04sTUFBTTtJQUNOLGlCQUFpQjtDQUNwQixDQUFDLENBQUM7QUFFSCxTQUFTLFNBQVMsQ0FBQyxLQUFhOztJQUM1QixPQUFPLE1BQUEsSUFBQSw0QkFBZ0IsRUFBQyxLQUFLLENBQUMsbUNBQUksWUFBWSxDQUFDO0FBQ25ELENBQUM7QUFFRCxTQUFTLE9BQU8sQ0FBQyxLQUFVLEVBQUUsS0FBNkIsRUFBRSxPQUFPLEdBQUcsQ0FBQzs7SUFDbkUsTUFBTSxNQUFNLEdBQUcsS0FBSyxhQUFMLEtBQUssY0FBTCxLQUFLLEdBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUs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QjtZQUNoRSxVQUFVO1NBQ2IsQ0FBQztJQUNOLENBQUM7SUFFRCxrQkFBa0IsQ0FBQyxPQUE2QjtRQUM1QyxNQUFNLEVBQUUsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFRLENBQUM7UUFDaEMsTUFBTSxLQUFLLEdBQUcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNyQyxNQUFNLElBQUksR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDaEUsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ1IsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUNELHFFQUFxRTtRQUNyRSxtRUFBbUU7UUFDbkUsSUFBSSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDcEIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2YsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgRmlnbWFDb2xvcixcclxuICAgIEZpZ21hUGFpbnQsXHJcbiAgICBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIFJlY3QsXHJcbiAgICBTY2VuZU5vZGVTcGVjLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xuaW1wb3J0IHsgc2hvdWxkR2VuZXJhdGVNYXNrLCBzZXRNYXNrU2hhcGVTYWZlbHkgfSBmcm9tICcuL21hc2stcG9saWN5JztcbmltcG9ydCB0eXBlIHsgTWFza1RhcmdldCB9IGZyb20gJy4vbWFzay1wb2xpY3knO1xuaW1wb3J0IHsgY29uZmlndXJlUHJlZmFiUmVmZXJlbmNlLCByZWZlcmVuY2VkUHJlZmFiQ2hpbGQsIHJlbW92ZVByZWZhYlJlZmVyZW5jZSwgYXNzZXJ0UmVmZXJlbmNlUmVtb3ZhYmxlIH0gZnJvbSAnLi9wcmVmYWItcmVmZXJlbmNlJztcblxyXG5tb2R1bGUucGF0aHMucHVzaChqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpKTtcclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxufVxyXG5cclxuY29uc3QgQkFDS0dST1VORF9OT0RFX05BTUUgPSAnX19GaWdtYUJhY2tncm91bmQnO1xyXG5jb25zdCBUSUxFRF9NQVNLX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRNYXNrJztcclxuY29uc3QgVElMRURfU1BSSVRFX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRTcHJpdGUnO1xyXG5jb25zdCBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFPdmVyZmxvd1Zpc3VhbCc7XG4vLyBTY2VuZS1vbmx5IHVwZGF0ZXMgaGF2ZSBubyBwZXJzaXN0ZWQgUHJlZmFiIG93bmVyc2hpcCBzbmFwc2hvdC4gS2VlcCBleGFjdFxuLy8gY29tcG9uZW50IGlkZW50aXRpZXMgZm9yIHRoaXMgc2Vzc2lvbjsgdW5rbm93bi9sZWdhY3kgbWFza3MgZmFpbCBjbG9zZWQuXG5jb25zdCBzZXNzaW9uTWFza0NvbXBvbmVudHMgPSBuZXcgV2Vha1NldDxvYmplY3Q+KCk7XG5jb25zdCBSQVNURVJfVkVDVE9SX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnVkVDVE9SJyxcclxuICAgICdCT09MRUFOX09QRVJBVElPTicsXHJcbiAgICAnU1RBUicsXHJcbiAgICAnTElORScsXHJcbiAgICAnUkVHVUxBUl9QT0xZR09OJyxcclxuXSk7XHJcblxyXG5mdW5jdGlvbiBjbGVhbk5hbWUoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc2FuaXRpemVOb2RlTmFtZShpbnB1dCkgPz8gJ0ZpZ21hIE5vZGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b0NvbG9yKENvbG9yOiBhbnksIHZhbHVlOiBGaWdtYUNvbG9yIHwgdW5kZWZpbmVkLCBvcGFjaXR5ID0gMSk6IGFueSB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSB2YWx1ZSA/PyB7IHI6IDAsIGc6IDAsIGI6IDAsIGE6IDEgfTtcclxuICAgIHJldHVybiBuZXcgQ29sb3IoXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UucikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5nKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAoc291cmNlLmEgPz8gMSkgKiBvcGFjaXR5KSkgKiAyNTUpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZEJ5VXVpZChyb290OiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QudXVpZCA9PT0gdXVpZCkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQnlVdWlkKGNoaWxkLCB1dWlkKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlUHJlZmFiRmlsZUlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/Ll9wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudDogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gY29tcG9uZW50Py5fX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWxrTm9kZXMocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xyXG4gICAgdmlzaXQocm9vdCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICB3YWxrTm9kZXMoY2hpbGQsIHZpc2l0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiQXNzZXRVdWlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBhc3NldCA9IG5vZGU/Ll9wcmVmYWI/LmFzc2V0O1xyXG4gICAgY29uc3QgdmFsdWUgPSBhc3NldD8uX3V1aWQgPz8gYXNzZXQ/LnV1aWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkZpbGVJZEluZGV4KHJvb3Q6IGFueSwgZXhwZWN0ZWRQcmVmYWJVdWlkPzogc3RyaW5nKTogTWFwPHN0cmluZywgYW55PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgY29uc3QgY29tcG9uZW50RmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgd2Fsa05vZGVzKHJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiUm9vdCA9IG5vZGU/Ll9wcmVmYWI/LnJvb3Q7XHJcbiAgICAgICAgaWYgKG5vZGUgIT09IHJvb3QgJiYgcHJlZmFiUm9vdCAmJiBwcmVmYWJSb290ICE9PSByb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYXNzZXRVdWlkID0gcHJlZmFiQXNzZXRVdWlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChleHBlY3RlZFByZWZhYlV1aWQgJiYgYXNzZXRVdWlkICYmIGFzc2V0VXVpZCAhPT0gZXhwZWN0ZWRQcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAoIWZpbGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChyZXN1bHQuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN6IqC54K5IGZpbGVJZO+8miR7ZmlsZUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHQuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZS5jb21wb25lbnRzID8/IG5vZGUuX2NvbXBvbmVudHMgPz8gW10pIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN57uE5Lu2IGZpbGVJZO+8miR7Y29tcG9uZW50RmlsZUlkfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbXBvbmVudEZpbGVJZHMuYWRkKGNvbXBvbmVudEZpbGVJZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJFZGl0aW5nU3RhdGUoXHJcbiAgICBleHBlY3RlZFV1aWQ6IHN0cmluZyxcclxuICAgIGV4cGVjdGVkUm9vdEZpbGVJZD86IHN0cmluZyxcclxuKTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY29uc3QgbW9kZSA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlNb2RlPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCBjdXJyZW50VXVpZCA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCByb290ID0gY2NlQXBpPy5TY2VuZT8ucm9vdE5vZGUgPz8gbnVsbDtcclxuICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKHJvb3QpO1xyXG4gICAgbGV0IHJlYXNvbiA9ICcnO1xyXG4gICAgaWYgKG1vZGUgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjee8lui+keaooeW8j+S4uiAke21vZGUgfHwgJ3Vua25vd24nfe+8jOWwmuacqui/m+WFpSBQcmVmYWJgO1xyXG4gICAgfSBlbHNlIGlmIChjdXJyZW50VXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjei1hOa6kCBVVUlEIOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie0YDtcclxuICAgIH0gZWxzZSBpZiAoIXJvb3QpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCueWwmuacquWwsee7qic7XHJcbiAgICB9IGVsc2UgaWYgKGV4cGVjdGVkUm9vdEZpbGVJZCAmJiByb290RmlsZUlkICE9PSBleHBlY3RlZFJvb3RGaWxlSWQpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5LiO5p2l5rqQ6K6w5b2V5LiN5LiA6Ie0JztcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgcmVhZHk6ICFyZWFzb24sXHJcbiAgICAgICAgbW9kZSxcclxuICAgICAgICBjdXJyZW50VXVpZCxcclxuICAgICAgICByb290VXVpZDogcm9vdD8udXVpZCxcclxuICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgIHJlYXNvbjogcmVhc29uIHx8IHVuZGVmaW5lZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLkVkaXRvcj8uVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gZ2VuZXJhdGVkO1xyXG4gICAgfVxyXG4gICAgLy8gVW5pdC10ZXN0L2hlYWRsZXNzIGZhbGxiYWNrLiBUaGUgcmVhbCBDcmVhdG9yIHNjZW5lIHByb2Nlc3MgYWx3YXlzIHVzZXNcclxuICAgIC8vIEVkaXRvci5VdGlscy5VVUlELmdlbmVyYXRlKHRydWUpLCBzbyBwcm9kdWN0aW9uIElEcyBmb2xsb3cgQ3JlYXRvcidzIG93biBmb3JtYXQuXHJcbiAgICByZXR1cm4gYGZpZ21hJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDE0KX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlOiBhbnksIHByZWZhYlJvb3Q6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGROb2RlPy4obm9kZSk7XHJcbiAgICBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LlByZWZhYkluZm8gPz8gY2MuUHJlZmFiSW5mbztcclxuICAgIGlmICghUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw6IqC54K555Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLnJvb3QgPSBwcmVmYWJSb290O1xyXG4gICAgaW5mby5hc3NldCA9IHByZWZhYlJvb3Q/Ll9wcmVmYWI/LmFzc2V0ID8/IG51bGw7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBpbmZvLmluc3RhbmNlID0gbnVsbDtcclxuICAgIGluZm8udGFyZ2V0T3ZlcnJpZGVzID0gbnVsbDtcclxuICAgIG5vZGUuX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZENvbXBvbmVudD8uKGNvbXBvbmVudCk7XHJcbiAgICBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgQ29tcFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uQ29tcFByZWZhYkluZm8gPz8gY2MuQ29tcFByZWZhYkluZm87XHJcbiAgICBpZiAoIUNvbXBQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBDb21wUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw57uE5Lu255Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBDb21wUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgY29tcG9uZW50Ll9fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0UGFyZW50S2VlcGluZ1dvcmxkKG5vZGU6IGFueSwgcGFyZW50OiBhbnkpOiB2b2lkIHtcclxuICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRQYXJlbnQgPT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICBub2RlLnNldFBhcmVudChwYXJlbnQsIHRydWUpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBub2RlLnBhcmVudCA9IHBhcmVudDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkOiBhbnksIHBhcmVudDogYW55LCBjYzogYW55KTogYm9vbGVhbiB7XG4gICAgLy8gQSByZWZlcmVuY2VkIGFzc2V0IG93bnMgaXRzIHdob2xlIHN1YnRyZWUsIGV2ZW4gaWYgaXRzIG5vZGUgbmFtZXMgaGFwcGVuXG4gICAgLy8gdG8gbWF0Y2ggb25lIG9mIG91ciBoZWxwZXIgbmFtZXMuXG4gICAgaWYgKGNoaWxkPy5fcHJlZmFiPy5pbnN0YW5jZSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChjaGlsZC5uYW1lID09PSBCQUNLR1JPVU5EX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSAnX19GaWdtYUNvbnRlbnQnKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gJ3ZpZXcnICYmIHBhcmVudC5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGNoaWxkLm5hbWUgPT09ICdjb250ZW50J1xyXG4gICAgICAgICYmIHBhcmVudC5uYW1lID09PSAndmlldydcclxuICAgICAgICAmJiBwYXJlbnQucGFyZW50Py5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIHN0YWxlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcbiAgICByZW1vdmVQcmVmYWJSZWZlcmVuY2Uobm9kZSk7XG4gICAgbGV0IHJlbW92ZWQgPSAxO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubm9kZS5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoc3RhbGVVdWlkcy5oYXMoY2hpbGQudXVpZCkgfHwgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpIHtcclxuICAgICAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShjaGlsZCwgc3Vydml2b3JQYXJlbnQsIHN0YWxlVXVpZHMsIGNjKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHN1cnZpdm9yUGFyZW50KSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZVNjZW5lU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogU2NlbmVOb2RlU3BlYyB7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBub3JtYWxpemVJbXBvcnRBY3Rpb24oc3BlYy5hY3Rpb24gYXMgdW5rbm93bik7XHJcbiAgICBjb25zdCBraW5kID0ga2luZEZvckltcG9ydEFjdGlvbihzcGVjLmtpbmQsIGFjdGlvbik7XHJcbiAgICBjb25zdCBjaGlsZHJlbiA9IEFycmF5LmlzQXJyYXkoc3BlYy5jaGlsZHJlbikgPyBzcGVjLmNoaWxkcmVuIDogW107XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLnNwZWMsXHJcbiAgICAgICAgYWN0aW9uLFxyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgY2hpbGRyZW46IGlzVGVybWluYWxBY3Rpb24oYWN0aW9uKSB8fCBzcGVjLmZsYXR0ZW5Cb3VuZGFyeSA9PT0gdHJ1ZVxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKGNoaWxkKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIGNvbnN0IGlkcyA9IFtzcGVjLmZpZ21hSWQsIC4uLihzcGVjLmFsaWFzRmlnbWFJZHMgPz8gW10pXVxyXG4gICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCAmJiBpZCAhPT0gJ19fcm9vdF9fJyk7XHJcbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoaWRzKV07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBzdHJpbmdbXSB7XHJcbiAgICByZXR1cm4gZmlnbWFJZHNGb3JTcGVjKHNwZWMpLmZpbHRlcigoZmlnbWFJZCkgPT4gZmlnbWFJZCAhPT0gc3BlYy5maWdtYUlkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXhpc3RpbmdVdWlkRm9yU3BlYyhcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gZXhpc3RpbmdNYXBbZmlnbWFJZF07XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICBpZiAodHlwZW9mIHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSAnYm9vbGVhbicpIHtcclxuICAgICAgICByZXR1cm4gc3BlYy5mbGF0dGVuQm91bmRhcnk7XHJcbiAgICB9XHJcbiAgICAvLyBCYWNrd2FyZCBjb21wYXRpYmlsaXR5IGZvciBTY2VuZVNwZWNzIHBlcnNpc3RlZCBieSBpbXBvcnRlciB2ZXJzaW9uc1xyXG4gICAgLy8gYmVmb3JlIGZsYXR0ZW5Cb3VuZGFyeSB3YXMgaW50cm9kdWNlZC4gTmV3IHBsYW5zIGFsd2F5cyBzZXQgdGhlIGZsYWcgc29cclxuICAgIC8vIGZvbGRlZCBMYWJlbHMgYW5kIG90aGVyIHByb21vdGVkIHZpc3VhbHMgdXNlIHRoZSBzYW1lIGNsZWFudXAgc2VtYW50aWNzLlxyXG4gICAgcmV0dXJuIHNwZWMuYWN0aW9uID09PSAncmVuZGVyJ1xyXG4gICAgICAgIHx8IChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBCb29sZWFuKHNwZWMuc3ByaXRlKSAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgaW1wb3J0Um9vdDogYW55LFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBjdXJyZW50TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKGN1cnJlbnRNYXApKTtcclxuICAgIGNvbnN0IGJvdW5kYXJ5U3BlY3M6IEFycmF5PHtcclxuICAgICAgICBmaWdtYUlkOiBzdHJpbmc7XHJcbiAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiBib29sZWFuO1xyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgfT4gPSBbXTtcclxuICAgIGNvbnN0IGNvbGxlY3RCb3VuZGFyaWVzID0gKG5vZGVzOiBTY2VuZU5vZGVTcGVjW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgaWYgKGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogdHJ1ZSxcclxuICAgICAgICAgICAgICAgICAgICBhbGlhc0ZpZ21hSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGFsaWFzRmlnbWFJZHMgPSBhbGlhc0ZpZ21hSWRzRm9yU3BlYyhzcGVjKTtcclxuICAgICAgICAgICAgaWYgKGFsaWFzRmlnbWFJZHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBib3VuZGFyeVNwZWNzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZ21hSWQ6IHNwZWMuZmlnbWFJZCxcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoYWxpYXNGaWdtYUlkcyksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29sbGVjdEJvdW5kYXJpZXMoc3BlY3MpO1xyXG4gICAgY29uc3QgYm91bmRhcmllcyA9IGJvdW5kYXJ5U3BlY3NcclxuICAgICAgICAubWFwKChib3VuZGFyeSkgPT4gKHtcclxuICAgICAgICAgICAgLi4uYm91bmRhcnksXHJcbiAgICAgICAgICAgIG5vZGU6IGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF1cclxuICAgICAgICAgICAgICAgID8gZmluZEJ5VXVpZChpbXBvcnRSb290LCBjdXJyZW50TWFwW2JvdW5kYXJ5LmZpZ21hSWRdKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIH0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGJvdW5kYXJ5KTogYm91bmRhcnkgaXMgdHlwZW9mIGJvdW5kYXJ5ICYgeyBub2RlOiBhbnkgfSA9PiBCb29sZWFuKGJvdW5kYXJ5Lm5vZGUpKTtcclxuICAgIGlmICghYm91bmRhcmllcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlTm9kZXMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgcmV0YWluZWRVdWlkcy5oYXModXVpZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgYm91bmRhcnkgb2YgYm91bmRhcmllcykge1xyXG4gICAgICAgICAgICBpZiAoIWJvdW5kYXJ5LnJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50c1xyXG4gICAgICAgICAgICAgICAgJiYgIWJvdW5kYXJ5LmFsaWFzRmlnbWFJZHMuaGFzKGZpZ21hSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChib3VuZGFyeS5ub2RlLCB1dWlkKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgbm9kZSAhPT0gYm91bmRhcnkubm9kZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhbGVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKCFzdGFsZU5vZGVzLnNpemUpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlVXVpZHMgPSBuZXcgU2V0KHN0YWxlTm9kZXMua2V5cygpKTtcclxuICAgIGxldCByZW1vdmVkID0gMDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZU5vZGVzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgaWYgKCFub2RlLnBhcmVudCB8fCBzdGFsZVV1aWRzLmhhcyhub2RlLnBhcmVudC51dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShub2RlLCBub2RlLnBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgY3VycmVudE1hcFtmaWdtYUlkXSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCkpIHtcclxuICAgICAgICAgICAgY3VycmVudE1hcFtmaWdtYUlkXSA9IHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhcclxuICAgIGNvbnRhaW5lcjogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIGV4aXN0aW5nVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoZXhpc3RpbmdVdWlkcy5oYXMoY2hpbGQudXVpZCkpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoY2hpbGQsIHN1cnZpdm9yUGFyZW50LCBleGlzdGluZ1V1aWRzKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRDYW52YXMocm9vdDogYW55LCBDYW52YXM6IGFueSk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QuZ2V0Q29tcG9uZW50KENhbnZhcykpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZENhbnZhcyhjaGlsZCwgQ2FudmFzKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgY2xhc3NlczogYW55W10sXHJcbiAgICBwcmVzZXJ2ZWQ6IFNldDxhbnk+LFxyXG4gICAgcmVuZGVyQ2xhc3NlczogYW55W10sXHJcbiAgICByZW1vdmFibGVGaWxlSWRzPzogU2V0PHN0cmluZz4sXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgbGV0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgdHlwZSBvZiBjbGFzc2VzKSB7XHJcbiAgICAgICAgaWYgKHByZXNlcnZlZC5oYXModHlwZSkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xyXG4gICAgICAgIGlmIChjb21wb25lbnQpIHtcclxuICAgICAgICAgICAgaWYgKHJlbW92YWJsZUZpbGVJZHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFmaWxlSWQgfHwgIXJlbW92YWJsZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocmVuZGVyQ2xhc3Nlcy5zb21lKChyZW5kZXJUeXBlKSA9PiBjb21wb25lbnQgaW5zdGFuY2VvZiByZW5kZXJUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiK55qE5riy5p+T57uE5Lu25LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOS7peS/neaKpOaJi+W3peWGheWuueOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub2RlLnJlbW92ZUNvbXBvbmVudChjb21wb25lbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZW1vdmVkUmVuZGVyQ29tcG9uZW50O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVPYnNvbGV0ZUxhYmVsT3V0bGluZShub2RlOiBhbnksIGNjOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG91dGxpbmUgPSBub2RlLmdldENvbXBvbmVudChjYy5MYWJlbE91dGxpbmUpO1xyXG4gICAgaWYgKCFvdXRsaW5lKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gTGFiZWxPdXRsaW5lIHdhcyB1c2VkIGJ5IG9sZGVyIGltcG9ydGVyIHZlcnNpb25zLiBDb2NvcyBkZXN0cm95c1xyXG4gICAgLy8gY29tcG9uZW50cyBhdCB0aGUgZW5kIG9mIHRoZSBmcmFtZSBhbmQgaXRzIG9uRGlzYWJsZSgpIHdyaXRlcyBiYWNrIHRvXHJcbiAgICAvLyBMYWJlbC5lbmFibGVPdXRsaW5lLCBzbyBsZXQgdGhhdCBsaWZlY3ljbGUgZmluaXNoIGJlZm9yZSBlaXRoZXJcclxuICAgIC8vIHJlY29uZmlndXJpbmcgb3IgcmVtb3ZpbmcgdGhlIExhYmVsIGNvbXBvbmVudC5cclxuICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KG91dGxpbmUpO1xyXG4gICAgYXdhaXQgd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZXNpcmVkR2VuZXJhdGVkQ29tcG9uZW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55LCBub2RlOiBhbnkpOiBTZXQ8YW55PiB7XG4gICAgY29uc3QgZGVzaXJlZCA9IG5ldyBTZXQ8YW55PigpO1xuICAgIGlmIChzcGVjLnByZWZhYikge1xuICAgICAgICBpZiAoc3BlYy5vcGFjaXR5IDwgMC45OTkpIGRlc2lyZWQuYWRkKGNjLlVJT3BhY2l0eSk7XG4gICAgICAgIHJldHVybiBkZXNpcmVkO1xuICAgIH1cbiAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICBpZiAoIXVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKSAmJiAhdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWMpKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLlNwcml0ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5SaWNoVGV4dCk7XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuTGFiZWwpO1xyXG4gICAgfSBlbHNlIGlmICghUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpIHx8IGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuR3JhcGhpY3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5NYXNrKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIGxheW91dE1vZGVcclxuICAgICAgICAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJyAmJiAhaGFzQnV0dG9uQW5jZXN0b3Iobm9kZSwgY2MpKSB7XG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkJ1dHRvbik7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5IDwgMC45OTkpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5VSU9wYWNpdHkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlc2lyZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMCkpO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiT3duZXJzaGlwR3VhcmQge1xyXG4gICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ05vZGVVdWlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IFNldDxhbnk+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc093bmVkSGVscGVyTm9kZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIHJldHVybiAhZ3VhcmQucHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICB8fCBCb29sZWFuKGZpbGVJZCAmJiBndWFyZC5wcmV2aW91c0hlbHBlckZpbGVJZHMuaGFzKGZpbGVJZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgIGNvbXBvbmVudDogYW55LFxyXG4gICAgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgb3duZXJOYW1lOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKCFjb21wb25lbnQgfHwgIWd1YXJkLnByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKCFmaWxlSWQgfHwgIWd1YXJkLnByZXZpb3VzQ29tcG9uZW50RmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYOiKgueCueKAnCR7b3duZXJOYW1lfeKAneS4iueahCAke2NvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSA/PyAnQ29tcG9uZW50J30g5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBpZiAoIWlzT3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6L6F5Yqp6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmApO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChjb21wb25lbnQsIGd1YXJkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShub2RlLCBndWFyZCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICBpZiAoaXNPd25lZEhlbHBlck5vZGUoY2hpbGQsIGd1YXJkKSkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoY2hpbGQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoXG4gICAgaGVscGVyOiBhbnksXG4gICAgc3Vydml2b3I6IGFueSxcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxuKTogdm9pZCB7XG4gICAgaWYgKGhlbHBlcj8uX3ByZWZhYj8uaW5zdGFuY2UpIHJldHVybjtcbiAgICBpZiAoZ3VhcmQpIHtcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVtb3ZlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChndWFyZCAmJiBpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmUoY2hpbGQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICB9O1xyXG4gICAgcmVtb3ZlKGhlbHBlcik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBiYWNrZ3JvdW5kID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShCQUNLR1JPVU5EX05PREVfTkFNRSk7XHJcbiAgICBpZiAoIWJhY2tncm91bmQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGJhY2tncm91bmQsIG5vZGUsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKFxyXG4gICAgdGlsZWRTcHJpdGU6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIHN1cnZpdm9yLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGlsZWRTcHJpdGUgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKHRpbGVkU3ByaXRlLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZE92ZXJmbG93VmlzdWFsKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChoZWxwZXIpIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gQSBmbGF0dGVuZWQgbm9kZSBoYXMgbm8gbmV3IGNoaWxkIHNwZWNzIGJ5IGRlc2lnbi4gS2VlcCBldmVyeSBleGlzdGluZ1xyXG4gICAgLy8gY2hpbGQgYWxpdmUgdW50aWwgcmVtb3ZlRmxhdHRlbmVkTWFwcGVkRGVzY2VuZGFudHMgY2FuIGRpc3Rpbmd1aXNoIG9sZFxyXG4gICAgLy8gRmlnbWEtbWFwcGVkIG5vZGVzIGZyb20gdXNlci1hdXRob3JlZCBub2Rlcy4gT3RoZXJ3aXNlIGRlc3Ryb3lpbmcgdGhlXHJcbiAgICAvLyBoZWxwZXIgd291bGQgcmVjdXJzaXZlbHkgZGVzdHJveSBtYW51YWwgY2hpbGRyZW4gYXQgQ29jb3MnIGRlZmVycmVkXHJcbiAgICAvLyBkZXN0cnVjdGlvbiBib3VuZGFyeS5cclxuICAgIGNvbnN0IHByZXNlcnZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKTtcclxuICAgIGNvbnN0IG1vdmVDaGlsZHJlblRvTm9kZSA9IChjb250YWluZXI6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZ3VhcmQgfHwgcHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUobGVnYWN5KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICBjb25zdCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgY29uc3QgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50Jyk7XHJcbiAgICBpZiAoIXNjcm9sbCB8fCAhdmlldyB8fCAhY29udGVudFxyXG4gICAgICAgIHx8IChzY3JvbGwuY29udGVudCAhPT0gY29udGVudCAmJiBzY3JvbGwuY29udGVudCAhPSBudWxsKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBub2RlLCBndWFyZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUoY29udGVudCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udmlldy5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGNoaWxkICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29udGVudC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBjb250ZW50LmRlc3Ryb3koKTtcclxuICAgIHZpZXcucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgdmlldy5kZXN0cm95KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lUG9zaXRpb24oXHJcbiAgICBmcmFtZTogUmVjdCxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuICAgIGNoaWxkVHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0ge1xyXG4gICAgaWYgKCFwYXJlbnRGcmFtZSkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLCB5OiAxIH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd2lkdGggPSBmcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBjaGlsZEFuY2hvciA9IGNoaWxkVHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC8vIEZpZ21hIGNvb3JkaW5hdGVzIGFyZSBtZWFzdXJlZCBmcm9tIHRoZSBwYXJlbnQncyB0b3AtbGVmdC4gQ29udmVydFxyXG4gICAgICAgIC8vIHRoYXQgcmVjdGFuZ2xlIHRvIHRoZSBsb2NhbCBwb3NpdGlvbiBvZiB0aGUgbm9kZSdzIGNlbnRlciBhbmNob3IuXHJcbiAgICAgICAgeDogKGZyYW1lLnggLSBwYXJlbnRGcmFtZS54KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICArIHdpZHRoICogY2hpbGRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAtIChmcmFtZS55IC0gcGFyZW50RnJhbWUueSkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIGhlaWdodCAqICgxIC0gY2hpbGRBbmNob3IueSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoc3BlYy5pc1Jvb3QgfHwgIXNwZWMuaW50cmluc2ljU2l6ZSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IG1hdHJpeCA9IHNwZWMucmVsYXRpdmVUcmFuc2Zvcm07XHJcbiAgICBjb25zdCB2YWx1ZXMgPSBbXHJcbiAgICAgICAgbWF0cml4Py5bMF0/LlswXSwgbWF0cml4Py5bMF0/LlsxXSwgbWF0cml4Py5bMF0/LlsyXSxcclxuICAgICAgICBtYXRyaXg/LlsxXT8uWzBdLCBtYXRyaXg/LlsxXT8uWzFdLCBtYXRyaXg/LlsxXT8uWzJdLFxyXG4gICAgXTtcclxuICAgIGlmICghdmFsdWVzLmV2ZXJ5KCh2YWx1ZSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBbbTAwLCBtMDEsIHR4LCBtMTAsIG0xMSwgdHldID0gdmFsdWVzIGFzIG51bWJlcltdO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHBhcmVudFdpZHRoKSB8fCAhTnVtYmVyLmlzRmluaXRlKHBhcmVudEhlaWdodCkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEgcmVsYXRpdmVUcmFuc2Zvcm0gaXMgdG9wLWxlZnQgYmFzZWQuIFRyYW5zZm9ybSB0aGUgdW5yb3RhdGVkIGxvY2FsXHJcbiAgICAvLyBjZW50ZXIsIHRoZW4gY29udmVydCB0aGUgcGFyZW50J3MgZG93bndhcmQgWSBheGlzIHRvIENvY29zIHVwd2FyZCBZLlxyXG4gICAgY29uc3QgY2VudGVyWCA9IHR4ICsgbTAwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTAxICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCBjZW50ZXJZID0gdHkgKyBtMTAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMTEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgeDogY2VudGVyWCAqIHNjYWxlIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KSAtIGNlbnRlclkgKiBzY2FsZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtOiBhbnksIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XG4gICAgLy8gUm91bmQgb25seSBhdCB0aGUgVUlUcmFuc2Zvcm0gd3JpdGUgYm91bmRhcnksIGFmdGVyIHNjYWxlL2xheW91dCBtYXRoLlxuICAgIC8vIERvIG5vdCBsb2NrIHNpemVzIHJlY2FsY3VsYXRlZCBsYXRlciBieSBMYWJlbCBvciBvdGhlciBydW50aW1lIGNvbXBvbmVudHMuXG4gICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZShcbiAgICAgICAgTWF0aC5yb3VuZCgod2lkdGggKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICAgICBNYXRoLnJvdW5kKChoZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICk7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IGFueSB7XG4gICAgY29uc3QgeyBVSVRyYW5zZm9ybSwgVmVjMyB9ID0gY2M7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gbm9kZS5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIGNvbnN0IHNpemUgPSBzcGVjLmludHJpbnNpY1NpemUgPz8gc3BlYy5mcmFtZTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBub2RlLnBhcmVudD8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3BlYy5pc1Jvb3RcclxuICAgICAgICA/IHsgeDogMCwgeTogMCB9XHJcbiAgICAgICAgOiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKHNwZWMsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IGZyYW1lUG9zaXRpb24oc3BlYy5mcmFtZSwgc3BlYy5wYXJlbnRGcmFtZSwgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSwgdHJhbnNmb3JtKTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbiAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIHNwZWMucm90YXRpb24pO1xyXG4gICAgbm9kZS5hY3RpdmUgPSBzcGVjLnZpc2libGU7XHJcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZFBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC50eXBlID09PSAnU09MSUQnXHJcbiAgICAgICAgJiYgcGFpbnQudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDBcclxuICAgICAgICAmJiBCb29sZWFuKHBhaW50LmNvbG9yKVxyXG4gICAgICAgICYmIChwYWludC5jb2xvcj8uYSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRGaWxsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5maWxscyk7XG59XG5cbmZ1bmN0aW9uIGZpcnN0VGV4dEZpbGwocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcbiAgICAvLyBGaWdtYSdzIHBhaW50IGFycmF5IGlzIGJhY2stdG8tZnJvbnQ6IHRoZSBwYW5lbCdzIHRvcCBmaWxsIGlzIGxhc3QuXG4gICAgLy8gTmF0aXZlIHRleHQga2VlcHMgdGhlIGZpcnN0IHVzYWJsZSBzb2xpZCBpbiBwYW5lbCBvcmRlciwgd2l0aG91dCBtaXhpbmdcbiAgICAvLyBzdGFja2VkIGZpbGxzIG9yIGNoYW5naW5nIHRoZSBzb3VyY2Ugb3JkZXIgdXNlZCBieSBvdGhlciByZW5kZXJlcnMuXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KFsuLi5wYWludHNdLnJldmVyc2UoKSk7XG59XG5cclxuZnVuY3Rpb24gdmFsaWRTb2xpZFN0cm9rZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gc3BlYy5zdHJva2VXZWlnaHQgPiAwID8gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5zdHJva2VzKSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzR3JhcGhpY3NWaXN1YWwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odmlzaWJsZVNvbGlkRmlsbChzcGVjKSB8fCB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0dyYXBoaWNzKGdyYXBoaWNzOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlU29saWRGaWxsKHNwZWMpO1xyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmFsaWRTb2xpZFN0cm9rZShzcGVjKTtcclxuICAgIGlmICghZmlsbCAmJiAhc3Ryb2tlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmFkaXVzID0gTWF0aC5tYXgoXHJcbiAgICAgICAgMCxcclxuICAgICAgICBNYXRoLm1pbihNYXRoLm1pbiguLi5zcGVjLmNvcm5lclJhZGlpKSAqIHNjYWxlLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpLFxyXG4gICAgKTtcclxuICAgIGlmIChzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZWxsaXBzZSgwLCAwLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpO1xyXG4gICAgfSBlbHNlIGlmIChyYWRpdXMgPiAwKSB7XHJcbiAgICAgICAgZ3JhcGhpY3Mucm91bmRSZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0LCByYWRpdXMpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBncmFwaGljcy5yZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0KTtcclxuICAgIH1cclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGxDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5maWxsKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmxpbmVXaWR0aCA9IE1hdGgubWF4KDAuNSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHcmFwaGljcyhub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCBleGlzdGluZyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKTtcbiAgICBjb25zdCBncmFwaGljcyA9IGV4aXN0aW5nID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkdyYXBoaWNzKTtcbiAgICBpZiAoIWV4aXN0aW5nKSBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKGdyYXBoaWNzKTtcbiAgICBncmFwaGljcy5lbmFibGVkID0gdHJ1ZTtcclxuICAgIGdyYXBoaWNzLmNsZWFyKCk7XHJcbiAgICBkcmF3R3JhcGhpY3MoZ3JhcGhpY3MsIHNwZWMsIHNjYWxlLCBjYyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZUxhYmVsVGV4dChjaGFyYWN0ZXJzOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIChjaGFyYWN0ZXJzID8/ICcnKVxyXG4gICAgICAgIC5yZXBsYWNlKC9cXHJcXG4vZywgJ1xcbicpXHJcbiAgICAgICAgLnJlcGxhY2UoL1tcXHJcXHUyMDI4XFx1MjAyOV0vZywgJ1xcbicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVRleHRBbGlnbm1lbnQoY29tcG9uZW50OiBhbnksIHN0eWxlOiBTY2VuZU5vZGVTcGVjWyd0ZXh0U3R5bGUnXSwgcmVuZGVyZXI6IGFueSk6IHZvaWQge1xuICAgIC8vIENvY29zIGhhcyBubyBKVVNUSUZJRUQgYWxpZ25tZW50OiB1bnN1cHBvcnRlZC9taXNzaW5nIHZhbHVlcyB1c2UgTEVGVC9UT1AuXG4gICAgY29tcG9uZW50Lmhvcml6b250YWxBbGlnbiA9IHN0eWxlPy50ZXh0QWxpZ25Ib3Jpem9udGFsID09PSAnQ0VOVEVSJ1xuICAgICAgICA/IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduSG9yaXpvbnRhbCA9PT0gJ1JJR0hUJ1xuICAgICAgICAgICAgPyByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uUklHSFRcbiAgICAgICAgICAgIDogcmVuZGVyZXIuSG9yaXpvbnRhbEFsaWduLkxFRlQ7XG4gICAgY29tcG9uZW50LnZlcnRpY2FsQWxpZ24gPSBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdDRU5URVInXG4gICAgICAgID8gcmVuZGVyZXIuVmVydGljYWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdCT1RUT00nXG4gICAgICAgICAgICA/IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uQk9UVE9NXG4gICAgICAgICAgICA6IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uVE9QO1xufVxyXG5cclxuZnVuY3Rpb24gZmlnbWFQYW5lbEZvbnRTaXplKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICAgIGNvbnN0IGZvbnRTaXplID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgoZm9udFNpemUgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwO1xufVxuXG5mdW5jdGlvbiBmaWdtYVBhbmVsTGluZUhlaWdodCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgICBjb25zdCBsaW5lSGVpZ2h0ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICAvLyBQcmVzZXJ2ZSBGaWdtYSdzIHBpeGVsIGxpbmUgaGVpZ2h0IGluZGVwZW5kZW50bHkgb2YgaW1wb3J0IHNjYWxlIGFuZFxuICAgIC8vIGVuZ2luZS1jb21wdXRlZCBjb250ZW50IHNpemU7IG9ubHkgcm91bmQgdG8gb25lIGRlY2ltYWwgcGxhY2UuXG4gICAgcmV0dXJuIE1hdGgucm91bmQoKGxpbmVIZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMCkgLyAxMDtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlTGFiZWwobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB7IExhYmVsIH0gPSBjYztcclxuICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpID8/IG5vZGUuYWRkQ29tcG9uZW50KExhYmVsKTtcclxuICAgIGNvbnN0IHN0eWxlID0gc3BlYy50ZXh0U3R5bGUgPz8ge307XHJcbiAgICBjb25zdCBjaGFyYWN0ZXJzID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICAvLyBGaWdtYSBOT05FIG1lYW5zIGEgZml4ZWQgYm94LCBub3QgQ29jb3MgT3ZlcmZsb3cuTk9ORS4gQm90aCBmaXhlZC13aWR0aFxuICAgIC8vIG1vZGVzIHdyYXAgYW5kIGdyb3cgdmVydGljYWxseTsgbWlzc2luZyBsZWdhY3kgbWV0YWRhdGEgc3RheXMgYXV0by13aWR0aC5cbiAgICBjb25zdCB3cmFwID0gc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdIRUlHSFQnIHx8IHN0eWxlLnRleHRBdXRvUmVzaXplID09PSAnTk9ORSc7XG4gICAgLy8gRmlnbWEgc3RvcmVzIG1vcmUgcHJlY2lzaW9uIHRoYW4gaXRzIHBhbmVsIGRpc3BsYXlzLiBNYXRjaCB0aGUgdmlzaWJsZVxyXG4gICAgLy8gZGVzaWduIHZhbHVlICh1cCB0byB0d28gZGVjaW1hbHMpIGluc3RlYWQgb2YgbGVha2luZyBpdHMgaW50ZXJuYWwgZmxvYXQuXHJcbiAgICBsYWJlbC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICBsYWJlbC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcbiAgICBsYWJlbC5zcGFjaW5nWCA9IChzdHlsZS5sZXR0ZXJTcGFjaW5nID8/IDApICogc2NhbGU7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IHdyYXAgPyBMYWJlbC5PdmVyZmxvdy5SRVNJWkVfSEVJR0hUIDogTGFiZWwuT3ZlcmZsb3cuTk9ORTtcbiAgICBsYWJlbC5lbmFibGVXcmFwVGV4dCA9IHdyYXA7XG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KGxhYmVsLCBzdHlsZSwgTGFiZWwpO1xuICAgIC8vIEF1dG8td2lkdGggbGFiZWxzIHVzZSBhIGNlbnRlcmVkIHZlcnRpY2FsIGJhc2VsaW5lIHJlZ2FyZGxlc3Mgb2YgRmlnbWEnc1xuICAgIC8vIHZlcnRpY2FsIGFsaWdubWVudC4gRml4ZWQtd2lkdGggd3JhcHBpbmcgbGFiZWxzIHJldGFpbiB0aGUgRmlnbWEgc2V0dGluZy5cbiAgICBpZiAobGFiZWwub3ZlcmZsb3cgPT09IExhYmVsLk92ZXJmbG93Lk5PTkUpIHtcbiAgICAgICAgbGFiZWwudmVydGljYWxBbGlnbiA9IExhYmVsLlZlcnRpY2FsQWxpZ24uQ0VOVEVSO1xuICAgIH1cbiAgICBsYWJlbC5zdHJpbmcgPSBjaGFyYWN0ZXJzO1xuICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSBmYWxzZTtcclxuICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xuICAgIGNvbnN0IGZpbGwgPSBmaXJzdFRleHRGaWxsKHNwZWMuZmlsbHMpO1xuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmlzaWJsZVBhaW50KHNwZWMuc3Ryb2tlcyk7XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvciAmJiBzcGVjLnN0cm9rZVdlaWdodCA+IDApIHtcclxuICAgICAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gdHJ1ZTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVXaWR0aCA9IE1hdGgubWF4KDEsIHNwZWMuc3Ryb2tlV2VpZ2h0ICogc2NhbGUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVSaWNoVGV4dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgUmljaFRleHQgfSA9IGNjO1xyXG4gICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCkgPz8gbm9kZS5hZGRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIHJpY2hUZXh0LnN0cmluZyA9IG5vcm1hbGl6ZUxhYmVsVGV4dChzcGVjLmNoYXJhY3RlcnMpO1xyXG4gICAgcmljaFRleHQuZm9udFNpemUgPSBmaWdtYVBhbmVsRm9udFNpemUoc3R5bGUuZm9udFNpemUpO1xyXG4gICAgcmljaFRleHQubGluZUhlaWdodCA9IGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSk7XG4gICAgcmljaFRleHQubWF4V2lkdGggPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpO1xyXG4gICAgcmljaFRleHQuaGFuZGxlVG91Y2hFdmVudCA9IGZhbHNlO1xyXG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KHJpY2hUZXh0LCBzdHlsZSwgUmljaFRleHQpO1xuICAgIHJpY2hUZXh0LmZvbnRGYW1pbHkgPSBzdHlsZS5mb250RmFtaWx5ID8/ICcnO1xyXG4gICAgcmljaFRleHQudXNlU3lzdGVtRm9udCA9ICFzcGVjLmZvbnRVdWlkO1xuICAgIHJpY2hUZXh0LmZvbnRDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHsgcjogMSwgZzogMSwgYjogMSwgYTogMSB9KTtcbiAgICBjb25zdCBmaWxsID0gZmlyc3RUZXh0RmlsbChzcGVjLmZpbGxzKTtcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICByaWNoVGV4dC5mb250Q29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICB0YXJnZXRGcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0gc3BlYy5mcmFtZSxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xyXG4gICAgY29uc3Qgc3ByaXRlID0gbm9kZS5nZXRDb21wb25lbnQoU3ByaXRlKSA/PyBub2RlLmFkZENvbXBvbmVudChTcHJpdGUpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuXHJcbiAgICAvLyBLZWVwIGFzc2lnbm1lbnQgZGV0ZXJtaW5pc3RpYzogYSBuZXcgU3ByaXRlIG1heSBkZWZhdWx0IHRvIFRSSU1NRUQgYW5kXHJcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gYXdhaXQgbG9hZEFzc2V0KGFzc2V0TWFuYWdlciwgc3BlYy5zcHJpdGUudXVpZCk7XG4gICAgc3ByaXRlLnNwcml0ZUZyYW1lID0gc3ByaXRlRnJhbWU7XG4gICAgY29uc3Qgc2xpY2VkID0gc3BlYy5zcHJpdGUuc2xpY2VkIHx8ICghc3BlYy5zcHJpdGUuc2xpY2VGYWxsYmFja1xuICAgICAgICAmJiBbc3ByaXRlRnJhbWUuaW5zZXRMZWZ0LCBzcHJpdGVGcmFtZS5pbnNldFJpZ2h0LCBzcHJpdGVGcmFtZS5pbnNldFRvcCwgc3ByaXRlRnJhbWUuaW5zZXRCb3R0b21dXG4gICAgICAgICAgICAuc29tZSgodmFsdWUpID0+IE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwKSk7XG4gICAgc3ByaXRlLnR5cGUgPSBzcGVjLnNwcml0ZS50aWxlZFxuICAgICAgICA/IFNwcml0ZS5UeXBlLlRJTEVEXG4gICAgICAgIDogc2xpY2VkXG4gICAgICAgICAgICA/IFNwcml0ZS5UeXBlLlNMSUNFRFxyXG4gICAgICAgICAgICA6IFNwcml0ZS5UeXBlLlNJTVBMRTtcclxuXHJcbiAgICBpZiAoIXNsaWNlZCAmJiAhc3BlYy5zcHJpdGUudGlsZWQpIHtcbiAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLlRSSU1NRUQ7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgcmF3V2lkdGggPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8ud2lkdGggPz8gc3ByaXRlRnJhbWU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZSh0cmltbWVkSGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIHJhd1dpZHRoID4gMFxyXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3V2lkdGggLSB0YXJnZXRXaWR0aCkgPD0gMC41MVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWSA9IHRhcmdldEhlaWdodCAvIHJhd0hlaWdodDtcclxuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyaW1tZWRXaWR0aCAqIHNjYWxlWCwgdHJpbW1lZEhlaWdodCAqIHNjYWxlWSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFNsaWNlZC90aWxlZCBzcHJpdGVzIGFuZCBzcHJpdGVzIHJlc2l6ZWQgaW4gRmlnbWEgbXVzdCByZXRhaW4gdGhlIGRlc2lnblxyXG4gICAgLy8gc2l6ZS4gQ29jb3MgcmVwcmVzZW50cyB0aGF0IHN0YXRlIGFzIENVU1RPTS5cclxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgdGFyZ2V0V2lkdGgsIHRhcmdldEhlaWdodCk7XG59XHJcblxyXG5mdW5jdGlvbiByZXF1aXJlc1RpbGVkTWFzayhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAndGlsZWQtaGVscGVyJykuc2hvdWxkTWFzaztcbn1cclxuXHJcbmZ1bmN0aW9uIG5hdGl2ZVRpbGVTY2FsZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHNjYWxlID0gc3BlYy5zcHJpdGU/LnRpbGVTY2FsZTtcclxuICAgIHJldHVybiB0eXBlb2Ygc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShzY2FsZSkgJiYgc2NhbGUgPiAwXHJcbiAgICAgICAgPyBzY2FsZVxyXG4gICAgICAgIDogMTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZClcclxuICAgICAgICAmJiAocmVxdWlyZXNUaWxlZE1hc2soc3BlYykgfHwgTWF0aC5hYnMobmF0aXZlVGlsZVNjYWxlKHNwZWMpIC0gMSkgPiAxZS02KTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZSlcclxuICAgICAgICAmJiAhc3BlYy5zcHJpdGU/LnNsaWNlZFxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8udGlsZWQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZW5kZXJGcmFtZSA9IHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZTtcclxuICAgIGlmICghcmVuZGVyRnJhbWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi2hei+ueeVjCBQTkcg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd57y65bCR5riy5p+T6L6555WM44CCYCk7XHJcbiAgICB9XHJcbiAgICBsZXQgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChndWFyZCAmJiBoZWxwZXIpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWhlbHBlcikge1xyXG4gICAgICAgIGhlbHBlciA9IG5ldyBjYy5Ob2RlKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQoaGVscGVyKTtcclxuICAgIH1cclxuICAgIGhlbHBlci5uYW1lID0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRTtcclxuICAgIGhlbHBlci5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICBoZWxwZXIuYWN0aXZlID0gdHJ1ZTtcclxuXHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBoZWxwZXIuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IGhlbHBlci5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShoZWxwZXIsIHNwZWMsIHNjYWxlLCBjYywgcmVuZGVyRnJhbWUpO1xyXG5cclxuICAgIGNvbnN0IGdlb21ldHJ5Q2VudGVyWCA9IHNwZWMuZnJhbWUueCArIHNwZWMuZnJhbWUud2lkdGggLyAyO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJZID0gc3BlYy5mcmFtZS55ICsgc3BlYy5mcmFtZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgcmVuZGVyQ2VudGVyWCA9IHJlbmRlckZyYW1lLnggKyByZW5kZXJGcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJZID0gcmVuZGVyRnJhbWUueSArIHJlbmRlckZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICAvLyBGaWdtYSBwYWdlIFkgcG9pbnRzIGRvd253YXJkIHdoaWxlIENvY29zIFVJIFkgcG9pbnRzIHVwd2FyZC5cclxuICAgIGNvbnN0IHdvcmxkRGVsdGFYID0gKHJlbmRlckNlbnRlclggLSBnZW9tZXRyeUNlbnRlclgpICogc2NhbGU7XHJcbiAgICBjb25zdCB3b3JsZERlbHRhWSA9IC0ocmVuZGVyQ2VudGVyWSAtIGdlb21ldHJ5Q2VudGVyWSkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBOdW1iZXIuaXNGaW5pdGUoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgID8gTnVtYmVyKHNwZWMud29ybGRSb3RhdGlvbilcclxuICAgICAgICA6IHNwZWMucm90YXRpb247XHJcbiAgICBjb25zdCByYWRpYW5zID0gd29ybGRSb3RhdGlvbiAqIE1hdGguUEkgLyAxODA7XHJcbiAgICBjb25zdCBjb3NpbmUgPSBNYXRoLmNvcyhyYWRpYW5zKTtcclxuICAgIGNvbnN0IHNpbmUgPSBNYXRoLnNpbihyYWRpYW5zKTtcclxuICAgIC8vIFRoZSBleHBvcnRlZCBQTkcgaXMgYWxyZWFkeSByYXN0ZXJpemVkIGluIEZpZ21hIHBhZ2UgYXhlcy4gQ291bnRlcmFjdFxyXG4gICAgLy8gdGhlIGxvZ2ljYWwgc2hlbGwncyBhY2N1bXVsYXRlZCByb3RhdGlvbiBhbmQgZXhwcmVzcyB0aGUgdmlzdWFsLWNlbnRlclxyXG4gICAgLy8gb2Zmc2V0IGJhY2sgaW4gdGhhdCBzaGVsbCdzIGxvY2FsIGNvb3JkaW5hdGUgc3lzdGVtLlxyXG4gICAgY29uc3QgbG9jYWxYID0gY29zaW5lICogd29ybGREZWx0YVggKyBzaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBjb25zdCBsb2NhbFkgPSAtc2luZSAqIHdvcmxkRGVsdGFYICsgY29zaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBoZWxwZXIuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMobG9jYWxYLCBsb2NhbFksIDApKTtcclxuICAgIGhlbHBlci5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAtd29ybGRSb3RhdGlvbik7XHJcbiAgICBoZWxwZXIuc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgaGVscGVyLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG5lZWRzTWFzayA9IHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpO1xyXG4gICAgbGV0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgbGV0IHRpbGVkU3ByaXRlID0gdGlsZWRNYXNrPy5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKVxyXG4gICAgICAgID8/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChuZWVkc01hc2spIHtcclxuICAgICAgICBpZiAoIXRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICB0aWxlZE1hc2sgPSBuZXcgY2MuTm9kZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgIG5vZGUuYWRkQ2hpbGQodGlsZWRNYXNrKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLm5hbWUgPSBUSUxFRF9NQVNLX05PREVfTkFNRTtcclxuICAgICAgICB0aWxlZE1hc2subGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHRpbGVkTWFzay5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG1hc2tUcmFuc2Zvcm0gPSB0aWxlZE1hc2suZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyB0aWxlZE1hc2suYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxuICAgICAgICAgICAgbWFza1RyYW5zZm9ybSxcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgMCk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFNjYWxlKG5ldyBjYy5WZWMzKDEsIDEsIDEpKTtcclxuICAgICAgICBjb25maWd1cmVDbGlwKHRpbGVkTWFzaywgc3BlYywgY2MsICd0aWxlZC1oZWxwZXInLCBndWFyZCk7XG4gICAgICAgIHRpbGVkTWFzay5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnRpbGVkTWFzay5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICB0aWxlZE1hc2suZGVzdHJveSgpO1xyXG4gICAgICAgIHRpbGVkTWFzayA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzcHJpdGVQYXJlbnQgPSB0aWxlZE1hc2sgPz8gbm9kZTtcclxuICAgIGlmICghdGlsZWRTcHJpdGUpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZSA9IG5ldyBjYy5Ob2RlKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIHNwcml0ZVBhcmVudC5hZGRDaGlsZCh0aWxlZFNwcml0ZSk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkU3ByaXRlLnBhcmVudCAhPT0gc3ByaXRlUGFyZW50KSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUucGFyZW50ID0gc3ByaXRlUGFyZW50O1xyXG4gICAgfVxyXG4gICAgdGlsZWRTcHJpdGUubmFtZSA9IFRJTEVEX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICB0aWxlZFNwcml0ZS5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICB0aWxlZFNwcml0ZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKHRpbGVkU3ByaXRlLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG4gICAgY29uc3QgdGlsZVNjYWxlID0gbmF0aXZlVGlsZVNjYWxlKHNwZWMpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gdGlsZWRTcHJpdGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IHRpbGVkU3ByaXRlLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgdHJhbnNmb3JtLFxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0U2NhbGUobmV3IGNjLlZlYzModGlsZVNjYWxlLCB0aWxlU2NhbGUsIDEpKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlT3BhY2l0eShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPj0gMC45OTkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBvcGFjaXR5ID0gbm9kZS5nZXRDb21wb25lbnQoY2MuVUlPcGFjaXR5KSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5VSU9wYWNpdHkpO1xyXG4gICAgb3BhY2l0eS5vcGFjaXR5ID0gTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzcGVjLm9wYWNpdHkpKSAqIDI1NSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUxheW91dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IExheW91dCwgU2l6ZSB9ID0gY2M7XHJcbiAgICBjb25zdCBsYXlvdXQgPSBub2RlLmdldENvbXBvbmVudChMYXlvdXQpID8/IG5vZGUuYWRkQ29tcG9uZW50KExheW91dCk7XHJcbiAgICBsYXlvdXQudHlwZSA9IG1vZGUgPT09ICdIT1JJWk9OVEFMJ1xyXG4gICAgICAgID8gTGF5b3V0LlR5cGUuSE9SSVpPTlRBTFxyXG4gICAgICAgIDogbW9kZSA9PT0gJ1ZFUlRJQ0FMJ1xyXG4gICAgICAgICAgICA/IExheW91dC5UeXBlLlZFUlRJQ0FMXHJcbiAgICAgICAgICAgIDogTGF5b3V0LlR5cGUuR1JJRDtcclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcpIHtcclxuICAgICAgICBsYXlvdXQuc3RhcnRBeGlzID0gc3BlYy5sYXlvdXQ/LnNvdXJjZU1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuQXhpc0RpcmVjdGlvbi5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5BeGlzRGlyZWN0aW9uLkhPUklaT05UQUw7XHJcbiAgICB9XHJcbiAgICBsYXlvdXQucmVzaXplTW9kZSA9IExheW91dC5SZXNpemVNb2RlLk5PTkU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0xlZnQgPSBzcGVjLmxheW91dCEucGFkZGluZ0xlZnQgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nUmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1RvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0JvdHRvbSA9IHNwZWMubGF5b3V0IS5wYWRkaW5nQm90dG9tICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1ggPSBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcgKiBzY2FsZTtcclxuICAgIGxheW91dC5zcGFjaW5nWSA9IChtb2RlID09PSAnR1JJRCcgPyBzcGVjLmxheW91dCEuY291bnRlclNwYWNpbmcgOiBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcpICogc2NhbGU7XHJcbiAgICBjb25zdCBhY3RpdmVDaGlsZHJlbiA9IHNwZWMuY2hpbGRyZW4uZmlsdGVyKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSk7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0hPUklaT05UQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuV2lkdGggPSBhY3RpdmVDaGlsZHJlbi5yZWR1Y2UoKHRvdGFsLCBjaGlsZCkgPT4gdG90YWwgKyBjaGlsZC5mcmFtZS53aWR0aCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lcldpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC0gbGF5b3V0LnBhZGRpbmdMZWZ0IC0gbGF5b3V0LnBhZGRpbmdSaWdodDtcclxuICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ1NQQUNFX0JFVFdFRU4nICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgbGF5b3V0LnNwYWNpbmdYID0gTWF0aC5tYXgoMCwgKGlubmVyV2lkdGggLSBjaGlsZHJlbldpZHRoKSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuV2lkdGggKyBsYXlvdXQuc3BhY2luZ1ggKiBNYXRoLm1heCgwLCBhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgaW5uZXJXaWR0aCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nTGVmdCArPSByZW1haW5pbmcgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChtb2RlID09PSAnVkVSVElDQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuSGVpZ2h0ID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUuaGVpZ2h0ICogc2NhbGUsIDApO1xyXG4gICAgICAgIGNvbnN0IGlubmVySGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nVG9wIC0gbGF5b3V0LnBhZGRpbmdCb3R0b207XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWSA9IE1hdGgubWF4KDAsIChpbm5lckhlaWdodCAtIGNoaWxkcmVuSGVpZ2h0KSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuSGVpZ2h0ICsgbGF5b3V0LnNwYWNpbmdZICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVySGVpZ2h0IC0gdXNlZCk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKG1vZGUgPT09ICdHUklEJyAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGxheW91dC5jZWxsU2l6ZSA9IG5ldyBTaXplKFxyXG4gICAgICAgICAgICBNYXRoLm1heCguLi5zcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IGNoaWxkLmZyYW1lLndpZHRoKSkgKiBzY2FsZSxcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS5oZWlnaHQpKSAqIHNjYWxlLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5Q291bnRlckFsaWdubWVudChcclxuICAgIHBhcmVudDogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBjb25zdCBhbGlnbm1lbnQgPSBzcGVjLmxheW91dD8uY291bnRlckFsaWduO1xyXG4gICAgaWYgKCFtb2RlIHx8ICFhbGlnbm1lbnQgfHwgIVsnSE9SSVpPTlRBTCcsICdWRVJUSUNBTCddLmluY2x1ZGVzKG1vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFyZW50VHJhbnNmb3JtID0gcGFyZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy53aWR0aCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGxheW91dEhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBjb25zdCByaWdodCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nUmlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHRvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBjb25zdCBib3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkU3BlYyBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGRTcGVjLmZpZ21hSWRdO1xyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gdXVpZCA/IGZpbmRCeVV1aWQocGFyZW50LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gY2hpbGQ/LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgaWYgKCFjaGlsZCB8fCAhdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwb3NpdGlvbiA9IGNoaWxkLnBvc2l0aW9uLmNsb25lKCk7XHJcbiAgICAgICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJykge1xyXG4gICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCgwLCBsYXlvdXRIZWlnaHQgLSB0b3AgLSBib3R0b20pO1xyXG4gICAgICAgICAgICBsZXQgdG9wT2Zmc2V0ID0gdG9wO1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gdG9wICsgKGF2YWlsYWJsZSAtIHRyYW5zZm9ybS5oZWlnaHQpIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChhbGlnbm1lbnQgPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICB0b3BPZmZzZXQgPSBsYXlvdXRIZWlnaHQgLSBib3R0b20gLSB0cmFuc2Zvcm0uaGVpZ2h0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ1NUUkVUQ0gnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyYW5zZm9ybS53aWR0aCwgYXZhaWxhYmxlKTtcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueSA9IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgICAgICAtIHRvcE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSB0cmFuc2Zvcm0uaGVpZ2h0ICogKDEgLSAodHJhbnNmb3JtLmFuY2hvclBvaW50Py55ID8/IDAuNSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dFdpZHRoIC0gbGVmdCAtIHJpZ2h0KTtcclxuICAgICAgICAgICAgbGV0IGxlZnRPZmZzZXQgPSBsZWZ0O1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxlZnQgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLndpZHRoKSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxheW91dFdpZHRoIC0gcmlnaHQgLSB0cmFuc2Zvcm0ud2lkdGg7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgYXZhaWxhYmxlLCB0cmFuc2Zvcm0uaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueCA9IGxlZnRPZmZzZXRcclxuICAgICAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICAgICAgKyB0cmFuc2Zvcm0ud2lkdGggKiAodHJhbnNmb3JtLmFuY2hvclBvaW50Py54ID8/IDAuNSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNoaWxkLnNldFBvc2l0aW9uKHBvc2l0aW9uKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gbG9nTWFza0RlY2lzaW9uKHNwZWM6IFNjZW5lTm9kZVNwZWMsIHRhcmdldDogTWFza1RhcmdldCA9ICdub2RlJyk6IHZvaWQge1xuICAgIGNvbnNvbGUubG9nKCdbRmlnbWEgSW1wb3J0ZXIgTWFzayDlhrPnrZZdJywgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXG4gICAgICAgIG5vZGVOYW1lOiBzcGVjLm5hbWUsXG4gICAgICAgIHRhcmdldCxcbiAgICAgICAgLi4uc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCksXG4gICAgfSkpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGU6IGFueSwgY2M6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgdHlwZSBvZiBbY2MuTWFzaywgY2MuR3JhcGhpY3NdKSB7XG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xuICAgICAgICBpZiAoIWNvbXBvbmVudCkgY29udGludWU7XG4gICAgICAgIGlmIChndWFyZCkge1xuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcbiAgICAgICAgfSBlbHNlIGlmICghc2Vzc2lvbk1hc2tDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4iueahCAke3R5cGUubmFtZX0g57y65bCR5a+85YWl5Zmo5b2S5bGe6K6w5b2V77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel57uE5Lu277yb6K+35L2/55So5bim5ZCM5q2l6K6w5b2V55qEIFByZWZhYiDmiJblr7zlhaXkuLrmlrDoioLngrnjgIJgKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuZnVuY3Rpb24gY29uZmlndXJlQ2xpcChcbiAgICBub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnksIHRhcmdldDogTWFza1RhcmdldCA9ICdub2RlJywgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcbik6IHZvaWQge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCk7XG4gICAgaWYgKCFkZWNpc2lvbi5zaG91bGRNYXNrKSByZXR1cm47XG4gICAgaWYgKHRhcmdldCAhPT0gJ25vZGUnKSBsb2dNYXNrRGVjaXNpb24oc3BlYywgdGFyZ2V0KTtcbiAgICBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGUsIGNjLCBndWFyZCk7XG4gICAgLy8gUHJvdmlzaW9uIEdyYXBoaWNzIGV2ZW4gZm9yIGluYWN0aXZlIG5vZGVzIHNvIG93bmVyc2hpcCBpcyBjYXB0dXJlZCBub3csXG4gICAgLy8gbm90IGxvc3Qgd2hlbiBNYXNrLm9uTG9hZCBjcmVhdGVzIGl0cyByZW5kZXJlciBvbiBhIGxhdGVyIGFjdGl2YXRpb24uXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xuICAgIHNlc3Npb25NYXNrQ29tcG9uZW50cy5hZGQoZ3JhcGhpY3MpO1xuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xuICAgIC8vIE1hc2sgb3ducyB0aGUgZHJhd2luZzogY2xlYXJpbmcgaGVyZSB3b3VsZCBlcmFzZSBhIHJldXNlZCBtYXNrIHdoZW4gdGhlXG4gICAgLy8gdHlwZSBzdGF5cyB1bmNoYW5nZWQgKGl0cyBwdWJsaWMgc2V0dGVyIGRvZXMgbm90IHJlZHJhdyBpZGVudGljYWwgdHlwZXMpLlxuICAgIGNvbnN0IG1hc2sgPSBub2RlLmdldENvbXBvbmVudChjYy5NYXNrKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5NYXNrKTtcbiAgICBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKG1hc2spO1xuICAgIGNvbnN0IG1hc2tUeXBlID0gZGVjaXNpb24ubWFza1R5cGUgPT09ICdlbGxpcHNlJ1xuICAgICAgICA/IGNjLk1hc2suVHlwZS5HUkFQSElDU19FTExJUFNFID8/IGNjLk1hc2suVHlwZS5FTExJUFNFXG4gICAgICAgIDogY2MuTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gY2MuTWFzay5UeXBlLlJFQ1Q7XG4gICAgc2V0TWFza1NoYXBlU2FmZWx5KG1hc2ssIG1hc2tUeXBlKTtcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBzaG91bGRHZW5lcmF0ZU1hc2soc3BlYykuc2hvdWxkTWFzaztcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc0J1dHRvbkFuY2VzdG9yKG5vZGU6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xuICAgIGZvciAobGV0IHBhcmVudCA9IG5vZGUucGFyZW50OyBwYXJlbnQ7IHBhcmVudCA9IHBhcmVudC5wYXJlbnQpIHtcbiAgICAgICAgaWYgKHBhcmVudC5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcbiAgICAgICAgY29uc3QgYnV0dG9uID0gbm9kZS5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5CdXR0b24pO1xyXG4gICAgICAgIGJ1dHRvbi50YXJnZXQgPSBub2RlO1xyXG4gICAgICAgIGJ1dHRvbi50cmFuc2l0aW9uID0gY2MuQnV0dG9uLlRyYW5zaXRpb24uU0NBTEU7XHJcbiAgICAgICAgYnV0dG9uLnpvb21TY2FsZSA9IDAuOTtcclxuICAgICAgICBidXR0b24uZHVyYXRpb24gPSAwLjE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0cmFuc2Zvcm06IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogYW55IHtcclxuICAgIGlmICghc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsICdzY3JvbGwtdmlldycpLnNob3VsZE1hc2spIHtcbiAgICAgICAgcmV0dXJuIG5vZGU7XG4gICAgfVxuICAgIGNvbnN0IHsgTm9kZSwgVUlUcmFuc2Zvcm0sIFNjcm9sbFZpZXcgfSA9IGNjO1xuICAgIGxldCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgbGV0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG51bGw7XHJcbiAgICBpZiAodmlldyAmJiBndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChTY3JvbGxWaWV3KSA/PyBub2RlLmFkZENvbXBvbmVudChTY3JvbGxWaWV3KTtcclxuICAgIGlmICghdmlldykge1xyXG4gICAgICAgIHZpZXcgPSBuZXcgTm9kZSgndmlldycpO1xyXG4gICAgICAgIHZpZXcubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQodmlldyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3VHJhbnNmb3JtID0gdmlldy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IHZpZXcuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh2aWV3VHJhbnNmb3JtLCB0cmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgsIHRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpO1xuICAgIHZpZXcuc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICBjb25maWd1cmVDbGlwKHZpZXcsIHNwZWMsIGNjLCAnc2Nyb2xsLXZpZXcnLCBndWFyZCk7XG4gICAgaWYgKCFjb250ZW50KSB7XHJcbiAgICAgICAgY29udGVudCA9IG5ldyBOb2RlKCdjb250ZW50Jyk7XHJcbiAgICAgICAgY29udGVudC5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdmlldy5hZGRDaGlsZChjb250ZW50KTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRlbnRUcmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gY29udGVudC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcHJldmlvdXNMYXlvdXQgPSBjb250ZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpO1xyXG4gICAgY29uc3QgbmV4dExheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChwcmV2aW91c0xheW91dCAmJiAoIW5leHRMYXlvdXRNb2RlIHx8IG5leHRMYXlvdXRNb2RlID09PSAnTk9ORScpKSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0LCBndWFyZCwgY29udGVudC5uYW1lKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29udGVudC5yZW1vdmVDb21wb25lbnQocHJldmlvdXNMYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgY29udGVudFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIGNvbnRlbnRUcmFuc2Zvcm0sIHNwZWMsIHRyYW5zZm9ybSwgc2NhbGUpO1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kgJiYgbGVnYWN5ICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubGVnYWN5LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIGNvbnRlbnQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGV4cGVjdHMgdGhlIGNvbnRlbnQgTm9kZSBoZXJlLiBTY3JvbGxWaWV3LnZpZXcgaXMgYVxyXG4gICAgLy8gZ2V0dGVyIGRlcml2ZWQgZnJvbSBjb250ZW50LnBhcmVudCBhbmQgbXVzdCBuZXZlciBiZSBhc3NpZ25lZCBkaXJlY3RseS5cclxuICAgIGlmIChzY3JvbGwuY29udGVudCA9PT0gY29udGVudCkge1xyXG4gICAgICAgIHNjcm9sbC5jb250ZW50ID0gbnVsbDtcclxuICAgIH1cclxuICAgIHNjcm9sbC5jb250ZW50ID0gY29udGVudDtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgc2Nyb2xsLmhvcml6b250YWwgPSBheGVzLmhvcml6b250YWw7XHJcbiAgICBzY3JvbGwudmVydGljYWwgPSBheGVzLnZlcnRpY2FsO1xyXG4gICAgcmV0dXJuIGNvbnRlbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNjcm9sbEF4ZXMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHsgaG9yaXpvbnRhbDogYm9vbGVhbjsgdmVydGljYWw6IGJvb2xlYW4gfSB7XHJcbiAgICBjb25zdCBkaXJlY3Rpb24gPSBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICYmIHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gIT09ICdOT05FJ1xyXG4gICAgICAgID8gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbi50cmltKCkudG9VcHBlckNhc2UoKVxyXG4gICAgICAgIDogJ1ZFUlRJQ0FMX1NDUk9MTElORyc7XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTCcgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnQk9USCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IHRydWUgfTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGhvcml6b250YWw6IGZhbHNlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgY29udGVudFRyYW5zZm9ybTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LndpZHRoKSB8fCAwKTtcclxuICAgIGNvbnN0IHZpZXdwb3J0SGVpZ2h0ID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy5oZWlnaHQpIHx8IDApO1xyXG4gICAgY29uc3QgY2hpbGRSaWdodCA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueCAtIHNwZWMuZnJhbWUueCArIGNoaWxkLmZyYW1lLndpZHRoKSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGNoaWxkQm90dG9tID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS55IC0gc3BlYy5mcmFtZS55ICsgY2hpbGQuZnJhbWUuaGVpZ2h0KSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgY29uc3QgY29udGVudFdpZHRoID0gYXhlcy5ob3Jpem9udGFsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydFdpZHRoLCAwLCAuLi5jaGlsZFJpZ2h0KVxyXG4gICAgICAgIDogdmlld3BvcnRXaWR0aDtcclxuICAgIGNvbnN0IGNvbnRlbnRIZWlnaHQgPSBheGVzLnZlcnRpY2FsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydEhlaWdodCwgMCwgLi4uY2hpbGRCb3R0b20pXHJcbiAgICAgICAgOiB2aWV3cG9ydEhlaWdodDtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoY29udGVudFRyYW5zZm9ybSwgY29udGVudFdpZHRoLCBjb250ZW50SGVpZ2h0KTtcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcbiAgICAgICAgKHZpZXdwb3J0SGVpZ2h0IC0gY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpIC8gMixcbiAgICAgICAgMCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycgfHwgY29udGVudCA9PT0gbm9kZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCB0cmFuc2Zvcm0sIHNwZWMsIHZpZXdwb3J0LCBzY2FsZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvdW50U3BlY3Moc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSk6IG51bWJlciB7XHJcbiAgICByZXR1cm4gc3BlY3MucmVkdWNlKCh0b3RhbCwgc3BlYykgPT4gdG90YWwgKyAxICsgY291bnRTcGVjcyhzcGVjLmNoaWxkcmVuKSwgMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNlbnRlckluQ2FudmFzKG5vZGU6IGFueSwgY2FudmFzOiBhbnksIFVJVHJhbnNmb3JtOiBhbnksIFZlYzM6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgbm9kZVRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IGNhbnZhc1RyYW5zZm9ybSA9IGNhbnZhcz8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghbm9kZVRyYW5zZm9ybSB8fCAhY2FudmFzVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2FudmFzU2l6ZSA9IGNhbnZhc1RyYW5zZm9ybS5jb250ZW50U2l6ZSA/PyB7XHJcbiAgICAgICAgd2lkdGg6IGNhbnZhc1RyYW5zZm9ybS53aWR0aCxcclxuICAgICAgICBoZWlnaHQ6IGNhbnZhc1RyYW5zZm9ybS5oZWlnaHQsXHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2lkdGggPSBOdW1iZXIoY2FudmFzU2l6ZT8ud2lkdGgpID4gMCA/IE51bWJlcihjYW52YXNTaXplLndpZHRoKSA6IDY0MDtcclxuICAgIGNvbnN0IGhlaWdodCA9IE51bWJlcihjYW52YXNTaXplPy5oZWlnaHQpID4gMCA/IE51bWJlcihjYW52YXNTaXplLmhlaWdodCkgOiAxMTM2O1xyXG4gICAgY29uc3QgY2FudmFzQW5jaG9yID0gY2FudmFzVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IG5vZGVBbmNob3IgPSBub2RlVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHggPSB3aWR0aCAqICgwLjUgLSBjYW52YXNBbmNob3IueClcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0ud2lkdGggKiAoMC41IC0gbm9kZUFuY2hvci54KTtcclxuICAgIGNvbnN0IHkgPSBoZWlnaHQgKiAoMC41IC0gY2FudmFzQW5jaG9yLnkpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLmhlaWdodCAqICgwLjUgLSBub2RlQW5jaG9yLnkpO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyh4LCB5LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUNvbXBvbmVudHMobm9kZTogYW55KTogYW55W10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5jb21wb25lbnRzID8/IG5vZGU/Ll9jb21wb25lbnRzO1xyXG4gICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUgOiBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVvcmRlckZpZ21hQ2hpbGRyZW4ocGFyZW50OiBhbnksIG9yZGVyZWROb2RlczogYW55W10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGRlc2lyZWQgPSBbLi4ubmV3IFNldChvcmRlcmVkTm9kZXMuZmlsdGVyKEJvb2xlYW4pKV07XHJcbiAgICBpZiAoIWRlc2lyZWQubGVuZ3RoIHx8IHR5cGVvZiBkZXNpcmVkWzBdPy5zZXRTaWJsaW5nSW5kZXggIT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYS1vd25lZCBjaGlsZHJlbiBhcmUga2VwdCBpbiBGaWdtYSBvcmRlci4gVXNlci1hdXRob3JlZCBjaGlsZHJlbiBhcmVcclxuICAgIC8vIG5ldmVyIHJlb3JkZXJlZCBhZ2FpbnN0IG9uZSBhbm90aGVyOyB0aGV5IGZvbGxvdyB0aGUgbWFuYWdlZCBibG9jay5cclxuICAgIGRlc2lyZWQuZm9yRWFjaCgobm9kZSwgaW5kZXgpID0+IG5vZGUuc2V0U2libGluZ0luZGV4KGluZGV4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBwcmV2aW91c05vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcmV0YWluZWROb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290KTtcclxuICAgIGNvbnN0IHN0YWxlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgZmlsZUlkIG9mIHByZXZpb3VzTm9kZUZpbGVJZHMpIHtcclxuICAgICAgICBpZiAoZmlsZUlkID09PSBub2RlUHJlZmFiRmlsZUlkKHByZWZhYlJvb3QpIHx8IHJldGFpbmVkTm9kZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICBzdGFsZS5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZUlkcyA9IG5ldyBTZXQoc3RhbGUua2V5cygpKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZS52YWx1ZXMoKSkge1xuICAgICAgICBhc3NlcnRSZWZlcmVuY2VSZW1vdmFibGUobm9kZSk7XG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYOW+heWIoOmZpOeahCBGaWdtYSDoioLngrnigJwke25vZGUubmFtZX3igJ3lkKvmnInmiYvlt6Xnu4Tku7bvvIzlt7LlgZzmraLlkIzmraXku6XpmLLmraLmlbDmja7kuKLlpLHjgIJgLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyA9IChjb250YWluZXI6IGFueSwgc3Vydml2b3JQYXJlbnQ6IGFueSkgPT4ge1xuICAgICAgICByZW1vdmVQcmVmYWJSZWZlcmVuY2UoY29udGFpbmVyKTtcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoY2hpbGQpO1xyXG4gICAgICAgICAgICBpZiAoY2hpbGRGaWxlSWRcclxuICAgICAgICAgICAgICAgICYmIChwcmV2aW91c05vZGVGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkgfHwgcHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3QgW2ZpbGVJZCwgbm9kZV0gb2Ygc3RhbGUpIHtcclxuICAgICAgICBsZXQgYW5jZXN0b3IgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBsZXQgbmVzdGVkVW5kZXJTdGFsZSA9IGZhbHNlO1xyXG4gICAgICAgIHdoaWxlIChhbmNlc3RvciAmJiBhbmNlc3RvciAhPT0gcHJlZmFiUm9vdC5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgYW5jZXN0b3JGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGFuY2VzdG9yKTtcclxuICAgICAgICAgICAgaWYgKGFuY2VzdG9yRmlsZUlkICYmIHN0YWxlSWRzLmhhcyhhbmNlc3RvckZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIG5lc3RlZFVuZGVyU3RhbGUgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYW5jZXN0b3IgPSBhbmNlc3Rvci5wYXJlbnQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChuZXN0ZWRVbmRlclN0YWxlIHx8ICFub2RlLnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3Vydml2b3JQYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMobm9kZSwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgc3RhbGUuZGVsZXRlKGZpbGVJZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHByZXZpb3VzOiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PixcclxuICAgIGdlbmVyYXRlZENsYXNzZXM6IGFueVtdLFxyXG4gICAgY2M6IGFueSxcclxuKTogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB7XHJcbiAgICBjb25zdCBwcmV2aW91c0NvbXBvbmVudHMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzKTtcclxuICAgIGNvbnN0IHByZXZpb3VzSGVscGVycyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZEhlbHBlckZpbGVJZHMpO1xyXG4gICAgY29uc3Qgbm9kZUZpbGVJZHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGNvbnN0IG1hbmFnZWROb2RlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYXBwZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhub2RlTWFwKSk7XHJcbiAgICBjb25zdCBtYW5hZ2VkUnVudGltZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5ZCM5q2l57uT5p6c57y65bCRIEZpZ21hIOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG5vZGVGaWxlSWRzW2ZpZ21hSWRdID0gZmlsZUlkO1xyXG4gICAgICAgIG1hbmFnZWROb2Rlcy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkUnVudGltZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRUeXBlcyA9IG5ldyBTZXQoW2NjLlVJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgbWFuYWdlZFJ1bnRpbWVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGlmICghbWFuYWdlZENvbXBvbmVudFR5cGVzLmhhcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWV4aXN0aW5nRmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudHMuaGFzKGV4aXN0aW5nRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgaWYgKG1hcHBlZFV1aWRzLmhhcyhub2RlLnV1aWQpIHx8IG5vZGUgPT09IHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBpZiAoIXBhcmVudFxyXG4gICAgICAgICAgICB8fCAoIW1hcHBlZFV1aWRzLmhhcyhwYXJlbnQudXVpZCkgJiYgIW1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMuaGFzKHBhcmVudC51dWlkKSlcclxuICAgICAgICAgICAgfHwgIWlzR2VuZXJhdGVkSGVscGVyTm9kZShub2RlLCBwYXJlbnQsIGNjKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAocHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNIZWxwZXJzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgIGDoioLngrnigJwke3BhcmVudC5uYW1lfeKAneS4i+WtmOWcqOS4juWvvOWFpei+heWKqeiKgueCueWQjOWQjeeahOaJi+W3peiKgueCueKAnCR7bm9kZS5uYW1lfeKAne+8jOW3suWBnOatouWQjOatpeOAgmAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVycy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudHMuYWRkKGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50LCBjYykpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgbm9kZUZpbGVJZHMsXHJcbiAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBbLi4ubWFuYWdlZE5vZGVzXSxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogWy4uLm1hbmFnZWRDb21wb25lbnRzXSxcclxuICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogWy4uLm1hbmFnZWRIZWxwZXJzXSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlZnJlc2hQcmVmYWJMYXlvdXRzKFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aXNpdCA9IChzcGVjOiBTY2VuZU5vZGVTcGVjKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbc3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBub2RlID0gdXVpZCA/IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgPyBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk/LmdldENoaWxkQnlOYW1lKCdjb250ZW50JykgPz8gbm9kZVxyXG4gICAgICAgICAgICA6IG5vZGU7XHJcbiAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgID8gY2hpbGRQYXJlbnQuZ2V0Q29tcG9uZW50KGNjLkxheW91dClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgaWYgKGxheW91dCkge1xyXG4gICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHNjYWxlLCBjYyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZFBhcmVudCAhPT0gbm9kZSkge1xyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChcclxuICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSksXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzcGVjLmNoaWxkcmVuLmZvckVhY2godmlzaXQpO1xyXG4gICAgfTtcclxuICAgIHNwZWNzLmZvckVhY2godmlzaXQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgIHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCxcclxuICAgIHZhbHVlOiBudW1iZXIsXHJcbiAgICBtZXNzYWdlOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBheWxvYWQucGFja2FnZU5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgIHZhbHVlLFxyXG4gICAgICAgICAgICBtZXNzYWdlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8g6L+b5bqm5Y+N6aaI5LiN5Y+v55So5pe25LiN5bqU5Lit5pat5Zy65pmv5a+85YWl44CCXHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7fVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHMgPSB7XHJcbiAgICBpbnNwZWN0UHJlZmFiQ29udGV4dChwYXlsb2FkOiB7XHJcbiAgICAgICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgICAgIHJvb3RGaWxlSWQ/OiBzdHJpbmc7XHJcbiAgICB9KTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiRWRpdGluZ1N0YXRlKHBheWxvYWQucHJlZmFiVXVpZCwgcGF5bG9hZC5yb290RmlsZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgaW1wb3J0RG9jdW1lbnQocGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkKTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgICAgIGNvbnN0IGNjID0gcmVxdWlyZSgnY2MnKSBhcyBhbnk7XHJcbiAgICAgICAgY29uc3Qge1xyXG4gICAgICAgICAgICBkaXJlY3RvcixcclxuICAgICAgICAgICAgTm9kZSxcclxuICAgICAgICAgICAgVUlUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgIENhbnZhcyxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgICAgIENhbWVyYSxcclxuICAgICAgICB9ID0gY2M7XHJcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgICAgIGlmICghc2NlbmUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma/jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZmFiQ29udGV4dCA9IHBheWxvYWQucHJlZmFiQ29udGV4dDtcclxuICAgICAgICBsZXQgcHJlZmFiUm9vdDogYW55IHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBwcmVmYWJFZGl0aW5nU3RhdGUocHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkLCBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpO1xyXG4gICAgICAgICAgICBpZiAoIXN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg5bCa5pyq5a6J5YWo5omT5byA77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcHJlZmFiUm9vdCA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlLlNjZW5lLnJvb3ROb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBmaWxlSWRJbmRleCA9IHByZWZhYkZpbGVJZEluZGV4KHByZWZhYlJvb3QsIHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAgICAgICAgICAgICAgX19yb290X186IHByZWZhYlJvb3QudXVpZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbZmlnbWFJZCwgZmlsZUlkXSBvZiBPYmplY3QuZW50cmllcyhwcmVmYWJDb250ZXh0LmV4aXN0aW5nTm9kZUZpbGVJZHMpKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmlsZUlkSW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBheWxvYWQudXBkYXRlRXhpc3RpbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmV4aXN0aW5nTWFwID0gZXhpc3RpbmdNYXA7XHJcbiAgICAgICAgICAgIHBheWxvYWQuY2VudGVySW5DYW52YXMgPSBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgICAgICBpZiAocHJlZmFiUm9vdCkge1xyXG4gICAgICAgICAgICB3YWxrTm9kZXMocHJlZmFiUm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICAgICAgbm9kZUNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLmFkZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByb290cyA9IHBheWxvYWQucm9vdHMubWFwKChyb290KSA9PiBub3JtYWxpemVTY2VuZVNwZWMocm9vdCkpO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0ICYmIHJvb3RzLmxlbmd0aCAhPT0gMSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXlj6rlhYHorrjkuIDkuKogRmlnbWEgRnJhbWUg5qC56IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrUGFyZW50ID0gcHJlZmFiUm9vdD8ucGFyZW50ID8/IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcykgPz8gc2NlbmU7XHJcbiAgICAgICAgY29uc3QgZGlyZWN0Um9vdCA9IHJvb3RzLmxlbmd0aCA9PT0gMTtcclxuICAgICAgICBjb25zdCBjYW52YXMgPSBwcmVmYWJSb290ID8gbnVsbCA6IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcyk7XHJcbiAgICAgICAgY29uc3QgZ2VuZXJhdGVkQ2xhc3NlcyA9IFtcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgXTtcclxuICAgICAgICBjb25zdCBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICAgICAgbGV0IGNyZWF0ZWQgPSAwO1xyXG4gICAgICAgIGxldCB1cGRhdGVkID0gMDtcclxuICAgICAgICBjb25zdCB0b3RhbE5vZGVzID0gTWF0aC5tYXgoMSwgY291bnRTcGVjcyhyb290cykpO1xyXG4gICAgICAgIGxldCBjb21wbGV0ZWROb2RlcyA9IDA7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRIZWxwZXJGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmVmYWJPd25lcnNoaXBHdWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQgfCB1bmRlZmluZWQgPSBwcmVmYWJDb250ZXh0XHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcblxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFV1aWQgPSBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nXHJcbiAgICAgICAgICAgID8gcGF5bG9hZC5leGlzdGluZ01hcC5fX3Jvb3RfX1xyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBsZXQgZXhpc3RpbmdSb290Tm9kZSA9IGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBleGlzdGluZ1Jvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nUm9vdE5vZGU/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGV4aXN0aW5nUm9vdE5vZGUgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBJbiBhIGRpcmVjdC1yb290IGltcG9ydCwgX19yb290X18gYWxpYXNlcyB0aGUgRmlnbWEgcm9vdCBVVUlELiBJbiBhXHJcbiAgICAgICAgLy8gbXVsdGktcm9vdCBpbXBvcnQgaXQgaWRlbnRpZmllcyBhIHN5bnRoZXRpYyB3cmFwcGVyIGFuZCBtdXN0IG5ldmVyIGJlXHJcbiAgICAgICAgLy8gcmV1c2VkIGFzIG9uZSBvZiBpdHMgb3duIGNoaWxkcmVuIHdoZW4gdGhlIHJvb3QgY291bnQgY2hhbmdlcy5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPSBCb29sZWFuKGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgJiYgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcCkuc29tZSgoW2ZpZ21hSWQsIHV1aWRdKSA9PlxyXG4gICAgICAgICAgICAgICAgZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiB1dWlkID09PSBleGlzdGluZ1Jvb3RVdWlkKSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNEaXJlY3RSb290ID0gZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNXcmFwcGVyID0gIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IG1hcHBlZFJvb3RVdWlkID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IGV4aXN0aW5nVXVpZEZvclNwZWMocGF5bG9hZC5leGlzdGluZ01hcCwgcm9vdHNbMF0pXHJcbiAgICAgICAgICAgIDogKCFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3RVdWlkIDogdW5kZWZpbmVkKTtcclxuICAgICAgICBsZXQgaW1wb3J0Um9vdCA9IHByZWZhYlJvb3QgPz8gKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgbWFwcGVkUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBtYXBwZWRSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsKTtcclxuICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgaW1wb3J0Um9vdD8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGxlZ2FjeVdyYXBwZXIgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gcHJldmlvdXNXcmFwcGVyID8/IChpbXBvcnRSb290Py5wYXJlbnQ/Lm5hbWUuc3RhcnRzV2l0aCgnRmlnbWEgwrcgJylcclxuICAgICAgICAgICAgICAgID8gaW1wb3J0Um9vdC5wYXJlbnRcclxuICAgICAgICAgICAgICAgIDogbnVsbClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHJldXNlZEltcG9ydFJvb3QgPSBCb29sZWFuKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZhbGxiYWNrUGFyZW50O1xyXG4gICAgICAgIGlmICghZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YCk7XHJcbiAgICAgICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnBhcmVudCA9IHBhcmVudDtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QubmFtZSA9IGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gO1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm0gPSBpbXBvcnRSb290LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gaW1wb3J0Um9vdC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgICAgICAgICByb290VHJhbnNmb3JtLFxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLndpZHRoICogcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLmhlaWdodCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3Quc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghaW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoY2xlYW5OYW1lKHJvb3RzWzBdLm5hbWUpKTtcclxuICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQSBjb2xsYXBzZWQgU2NlbmVTcGVjIGNhbiBpbnRlbnRpb25hbGx5IG1hcCBzZXZlcmFsIEZpZ21hIElEcyB0byBhXHJcbiAgICAgICAgLy8gc2luZ2xlIENvY29zIG5vZGUuIElmIGEgbGF0ZXIgaW1wb3J0IGV4cGFuZHMgdGhhdCBzdWJ0cmVlIGFnYWluLFxyXG4gICAgICAgIC8vIHRob3NlIElEcyBzdGlsbCBwb2ludCBhdCB0aGUgc2FtZSBvbGQgVVVJRC4gQ2xhaW0gZWFjaCByZXVzYWJsZSBub2RlXHJcbiAgICAgICAgLy8gb25jZSBwZXIgYnVpbGQgc28gYSBjaGlsZCBjYW4gbmV2ZXIgcmV1c2UgKGFuZCByZXBhcmVudCkgaXRzIHBhcmVudC5cclxuICAgICAgICBjb25zdCBjbGFpbWVkTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgYnVpbGQgPSBhc3luYyAoXG4gICAgICAgICAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgICAgICAgICBub2RlUGFyZW50OiBhbnksXHJcbiAgICAgICAgICAgIHByb3ZpZGVkTm9kZT86IGFueSxcclxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgICAgICAgIGxvZ01hc2tEZWNpc2lvbihzcGVjKTtcbiAgICAgICAgICAgIGxldCBub2RlID0gcHJvdmlkZWROb2RlID8/IG51bGw7XG4gICAgICAgICAgICBpZiAoIW5vZGUgJiYgcGF5bG9hZC51cGRhdGVFeGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZFV1aWQgPSBwYXlsb2FkLmV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZE5vZGUgPSBtYXBwZWRVdWlkID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkVXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXBwZWROb2RlICYmICFjbGFpbWVkTm9kZVV1aWRzLmhhcyhtYXBwZWROb2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUgPSBtYXBwZWROb2RlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgY2xhaW1lZE5vZGVVdWlkcy5oYXMobm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RlZCA9IEJvb2xlYW4obm9kZSk7XG4gICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBuZXcgTm9kZShjbGVhbk5hbWUoc3BlYy5uYW1lKSk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgcHJldmlvdXNSZWZlcmVuY2UgPSByZWZlcmVuY2VkUHJlZmFiQ2hpbGQobm9kZSk7XG4gICAgICAgICAgICBpZiAocHJldmlvdXNSZWZlcmVuY2UgJiYgKCFzcGVjLnByZWZhYlxuICAgICAgICAgICAgICAgIHx8IHByZWZhYkFzc2V0VXVpZChwcmV2aW91c1JlZmVyZW5jZSkgIT09IHNwZWMucHJlZmFiLnV1aWQpKSBhc3NlcnRSZWZlcmVuY2VSZW1vdmFibGUobm9kZSk7XG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nICYmICFwcmVmYWJPd25lcnNoaXBHdWFyZCkge1xuICAgICAgICAgICAgICAgIGlmIChub2RlLmdldENvbXBvbmVudChNYXNrKSB8fCBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydE1hc2tDb21wb25lbnRzT3duZWQobm9kZSwgY2MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyBJbmNsdWRlIGdlbmVyYXRlZCB2aWV3L3RpbGVkIGhlbHBlcnMgYmVmb3JlIGFueSBkZWxldGlvbiBvclxuICAgICAgICAgICAgICAgIC8vIHJlY29uZmlndXJhdGlvbi4gTmV2ZXIgaW5mZXIgb3duZXJzaGlwIGZyb20gdGhlaXIgbmFtZXMgYWxvbmUuXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XG4gICAgICAgICAgICAgICAgICAgIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoaGVscGVyLmdldENvbXBvbmVudChNYXNrKSkgYXNzZXJ0TWFza0NvbXBvbmVudHNPd25lZChoZWxwZXIsIGNjKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocHJlZmFiT3duZXJzaGlwR3VhcmQgJiYgZXhpc3RlZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdUcmFuc2Zvcm0pIHtcclxuICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGhlbHBlciBvZiBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT5cclxuICAgICAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYylcclxuICAgICAgICAgICAgICAgICAgICAgICAgfHwgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGNoaWxkLm5hbWUgPT09ICd2aWV3JykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGhlbHBlci5uYW1lID09PSAndmlldycpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBoZWxwZXIuZ2V0Q2hpbGRCeU5hbWU/LignY29udGVudCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUoY29udGVudCwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChoZWxwZXIubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUodGlsZWRTcHJpdGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZ2VuZXJhdGVkQ2xhc3Nlcy5pbmNsdWRlcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjbGFpbWVkTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICBpZiAoIShwcmVmYWJDb250ZXh0ICYmIG5vZGUgPT09IHByZWZhYlJvb3QpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlLnBhcmVudCA9IG5vZGVQYXJlbnQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm9kZS5uYW1lID0gY2xlYW5OYW1lKHNwZWMubmFtZSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG5cclxuICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uICE9PSAndHJhbnNmb3JtJykge1xuICAgICAgICAgICAgICAgIGlmICghc3BlYy5wcmVmYWIpIHJlbW92ZVByZWZhYlJlZmVyZW5jZShub2RlKTtcbiAgICAgICAgICAgICAgICByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMobm9kZSwgc3BlYywgY2MsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHByZXNlcnZlZCA9IGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWMsIGNjLCBub2RlKTtcbiAgICAgICAgICAgICAgICAvLyBNYXNrIG93bnMgYW5kIGRpc2FibGVzIGl0cyBzaGFyZWQgR3JhcGhpY3MgZHVyaW5nIHRoZVxyXG4gICAgICAgICAgICAgICAgLy8gZGVmZXJyZWQgb25EaXNhYmxlIHBoYXNlLiBJZiBjbGlwcGluZyB3YXMgcmVtb3ZlZCBidXQgYVxyXG4gICAgICAgICAgICAgICAgLy8gbm9ybWFsIEdyYXBoaWNzIHJlbmRlcmVyIGlzIHN0aWxsIGRlc2lyZWQsIHJlY3JlYXRlIHRoYXRcclxuICAgICAgICAgICAgICAgIC8vIHJlbmRlcmVyIG9ubHkgYWZ0ZXIgdGhlIG9sZCBNYXNrIGxpZmVjeWNsZSBoYXMgY29tcGxldGVkLlxyXG4gICAgICAgICAgICAgICAgaWYgKCFwcmVzZXJ2ZWQuaGFzKE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgbm9kZS5nZXRDb21wb25lbnQoTWFzaylcclxuICAgICAgICAgICAgICAgICAgICAmJiBwcmVzZXJ2ZWQuaGFzKEdyYXBoaWNzKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZC5kZWxldGUoR3JhcGhpY3MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBnZW5lcmF0ZWRDbGFzc2VzLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZCxcclxuICAgICAgICAgICAgICAgICAgICBbR3JhcGhpY3MsIFNwcml0ZSwgTGFiZWwsIFJpY2hUZXh0XSxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0ID8gcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmVtb3ZlZFJlbmRlckNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGlsZWRTcHJpdGVIZWxwZXIgPSB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvdmVyZmxvd1Nwcml0ZUhlbHBlciA9IHVzZXNPdmVyZmxvd1Nwcml0ZUhlbHBlcihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRUaWxlZE5vZGVzKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghb3ZlcmZsb3dTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRPdmVyZmxvd1Zpc3VhbChub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLnByZWZhYikge1xuICAgICAgICAgICAgICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkgZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xuICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVQcmVmYWJSZWZlcmVuY2Uobm9kZSwgc3BlYy5wcmVmYWIsIGNjKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUE5HIOaVtOWxguiKgueCueKAnCR7c3BlYy5uYW1lfeKAneayoeaciee7keWumiBTcHJpdGVGcmFtZe+8jOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAob3ZlcmZsb3dTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlT3ZlcmZsb3dTcHJpdGVIZWxwZXIoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVSaWNoVGV4dChub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMuZm9udFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2MuVFRGRm9udCAmJiAhKGZvbnQgaW5zdGFuY2VvZiBjYy5UVEZGb250KSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBSaWNoVGV4dCDoioLngrnigJwke3NwZWMubmFtZX3igJ3lj6rog73kvb/nlKggVFRGL09URiDlrZfkvZPvvIzlvZPliY3mmKDlsITlj6/og73mmK8gQml0bWFwRm9udO+8iC5mbnTvvInjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gZm9udDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlTGFiZWwobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsYWJlbC5mb250ID0gYXdhaXQgbG9hZEFzc2V0KGNjLmFzc2V0TWFuYWdlciwgc3BlYy5mb250VXVpZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpLmZvbnQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnn6Lph4/oioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIxQTkcg6LWE5rqQ5Y+v6IO95pyq5oiQ5Yqf5a+85YWl44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVDbGlwKG5vZGUsIHNwZWMsIGNjLCAnbm9kZScsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXNwZWMucHJlZmFiKSBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMucHJlZmFiIHx8IHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJ1xuICAgICAgICAgICAgICAgID8gbm9kZVxyXG4gICAgICAgICAgICAgICAgOiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zZm9ybSxcclxuICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFzcGVjLnByZWZhYiAmJiBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxheW91dChjaGlsZFBhcmVudCwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgYnVpbGQoY2hpbGQsIGNoaWxkUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgcmVvcmRlckZpZ21hQ2hpbGRyZW4oXHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkLmZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdXVpZCA/IGZpbmRCeVV1aWQoY2hpbGRQYXJlbnQsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICAgICAgPyBjaGlsZFBhcmVudC5nZXRDb21wb25lbnQoTGF5b3V0KVxyXG4gICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgICAgICBpZiAobGF5b3V0KSB7XHJcbiAgICAgICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChub2RlLCBzcGVjLCBjaGlsZFBhcmVudCwgdHJhbnNmb3JtLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RlZCAmJiBzcGVjLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSArPSAnIMK3IFRyYW5zZm9ybSc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgKz0gMTtcclxuICAgICAgICAgICAgZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLFxyXG4gICAgICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgLyB0b3RhbE5vZGVzLFxyXG4gICAgICAgICAgICAgICAgYOaehOW7uuiKgueCuSAke2NvbXBsZXRlZE5vZGVzfS8ke3RvdGFsTm9kZXN9IMK3ICR7c3BlYy5uYW1lfWAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIHJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChyb290LCBkaXJlY3RSb290ID8gcGFyZW50IDogaW1wb3J0Um9vdCwgZGlyZWN0Um9vdCA/IGltcG9ydFJvb3QgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmICFwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVDb2xsYXBzZWRNYXBwZWREZXNjZW5kYW50cyhcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAocGF5bG9hZC5jZW50ZXJJbkNhbnZhcyAmJiBjYW52YXMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjZW50ZXJJbkNhbnZhcyhpbXBvcnRSb290LCBjYW52YXMsIFVJVHJhbnNmb3JtLCBjYy5WZWMzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgICAgICAgICAgY29uc3Qgc3RhbGVUcmFuc2l0aW9uVXVpZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcClcclxuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKChbZmlnbWFJZCwgdXVpZF0pID0+IGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHV1aWQpKVxyXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKFssIHV1aWRdKSA9PiB1dWlkKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGxlZ2FjeVdyYXBwZXIgJiYgbGVnYWN5V3JhcHBlciAhPT0gaW1wb3J0Um9vdCAmJiBsZWdhY3lXcmFwcGVyLnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUobGVnYWN5V3JhcHBlciwgcGFyZW50LCBzdGFsZVRyYW5zaXRpb25VdWlkcywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBwcmV2aW91c0RpcmVjdFJvb3RcclxuICAgICAgICAgICAgICAgICYmIHByZXZpb3VzRGlyZWN0Um9vdCAhPT0gaW1wb3J0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHByZXZpb3VzRGlyZWN0Um9vdC51dWlkKVxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290LnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXHJcbiAgICAgICAgICAgICAgICAgICAgcHJldmlvdXNEaXJlY3RSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHN0YWxlVHJhbnNpdGlvblV1aWRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoaW1wb3J0Um9vdCwgcGF5bG9hZC5leGlzdGluZ01hcCwgbm9kZU1hcCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBpZiAoIXJldXNlZEltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50LFxyXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhwYXlsb2FkLmV4aXN0aW5nTWFwKSksXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LmRlc3Ryb3koKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IHByZWZhYlN5bmM6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmV0YWluZWROb2RlRmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlrprkvY3lr7zlhaXlkI7nmoToioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXRhaW5lZE5vZGVGaWxlSWRzLmFkZChlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBpbXBvcnRSb290LCBjYykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgbmV3IFNldChwcmVmYWJDb250ZXh0Lm1hbmFnZWROb2RlRmlsZUlkcyksXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHJlZnJlc2hQcmVmYWJMYXlvdXRzKHJvb3RzLCBpbXBvcnRSb290LCBub2RlTWFwLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMgPSBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAobm9kZVByZWZhYkZpbGVJZChpbXBvcnRSb290KSAhPT0gcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOWcqOWQjOatpei/h+eoi+S4reWPkeeUn+WPmOWMlu+8jOW3suaLkue7neS/neWtmOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHJvb3RVdWlkOiBpbXBvcnRSb290LnV1aWQsXHJcbiAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgIGNyZWF0ZWQsXHJcbiAgICAgICAgICAgIHVwZGF0ZWQsXHJcbiAgICAgICAgICAgIHRlbXBvcmFyeVJvb3Q6ICFwcmVmYWJDb250ZXh0ICYmIGRpcmVjdFJvb3QgJiYgIXJldXNlZEltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMsXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcblxyXG4gICAgcmVtb3ZlSW1wb3J0ZWROb2RlKHBheWxvYWQ6IHsgcm9vdFV1aWQ6IHN0cmluZyB9KTogYm9vbGVhbiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGNjLmRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lID8gZmluZEJ5VXVpZChzY2VuZSwgcGF5bG9hZC5yb290VXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0b3AgcmVuZGVyaW5nIGltbWVkaWF0ZWx5LiBDb2NvcyBkZXN0cm95cyBub2RlcyBhdCB0aGUgZW5kIG9mIHRoZVxyXG4gICAgICAgIC8vIGZyYW1lLCBzbyByZW1vdmluZyB0aGUgcGFyZW50IGFsb25lIGNhbiBsZWF2ZSBhIG9uZS1mcmFtZSBnaG9zdC5cclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSxcclxufTtcclxuIl19