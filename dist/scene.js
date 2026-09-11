"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const node_name_1 = require("./node-name");
const mask_policy_1 = require("./mask-policy");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBdXREQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBenREakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFDL0MsK0NBQXVFO0FBR3ZFLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUEsV0FBSSxFQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7QUF5QnpELE1BQU0sb0JBQW9CLEdBQUcsbUJBQW1CLENBQUM7QUFDakQsTUFBTSxvQkFBb0IsR0FBRyxrQkFBa0IsQ0FBQztBQUNoRCxNQUFNLHNCQUFzQixHQUFHLG9CQUFvQixDQUFDO0FBQ3BELE1BQU0seUJBQXlCLEdBQUcsdUJBQXVCLENBQUM7QUFDMUQsNkVBQTZFO0FBQzdFLDJFQUEyRTtBQUMzRSxNQUFNLHFCQUFxQixHQUFHLElBQUksT0FBTyxFQUFVLENBQUM7QUFDcEQsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNoQyxRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0NBQ3BCLENBQUMsQ0FBQztBQUVILFNBQVMsU0FBUyxDQUFDLEtBQWE7O0lBQzVCLE9BQU8sTUFBQSxJQUFBLDRCQUFnQixFQUFDLEtBQUssQ0FBQyxtQ0FBSSxZQUFZLENBQUM7QUFDbkQsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLEtBQVUsRUFBRSxLQUE2QixFQUFFLE9BQU8sR0FBRyxDQUFDOztJQUNuRSxNQUFNLE1BQU0sR0FBRyxLQUFLLGFBQUwsS0FBSyxjQUFMLEtBQUssR0FBSSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FB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Q2hDLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDckMsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ2hFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sS0FBSyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxxRUFBcUU7UUFDckUsbUVBQW1FO1FBQ25FLElBQUksQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO1FBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge1xyXG4gICAgaXNUZXJtaW5hbEFjdGlvbixcclxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXHJcbiAgICBub3JtYWxpemVJbXBvcnRBY3Rpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEZpZ21hQ29sb3IsXHJcbiAgICBGaWdtYVBhaW50LFxyXG4gICAgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBSZWN0LFxyXG4gICAgU2NlbmVOb2RlU3BlYyxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcbmltcG9ydCB7IHNob3VsZEdlbmVyYXRlTWFzaywgc2V0TWFza1NoYXBlU2FmZWx5IH0gZnJvbSAnLi9tYXNrLXBvbGljeSc7XG5pbXBvcnQgdHlwZSB7IE1hc2tUYXJnZXQgfSBmcm9tICcuL21hc2stcG9saWN5JztcblxyXG5tb2R1bGUucGF0aHMucHVzaChqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpKTtcclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxufVxyXG5cclxuY29uc3QgQkFDS0dST1VORF9OT0RFX05BTUUgPSAnX19GaWdtYUJhY2tncm91bmQnO1xyXG5jb25zdCBUSUxFRF9NQVNLX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRNYXNrJztcclxuY29uc3QgVElMRURfU1BSSVRFX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRTcHJpdGUnO1xyXG5jb25zdCBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFPdmVyZmxvd1Zpc3VhbCc7XG4vLyBTY2VuZS1vbmx5IHVwZGF0ZXMgaGF2ZSBubyBwZXJzaXN0ZWQgUHJlZmFiIG93bmVyc2hpcCBzbmFwc2hvdC4gS2VlcCBleGFjdFxuLy8gY29tcG9uZW50IGlkZW50aXRpZXMgZm9yIHRoaXMgc2Vzc2lvbjsgdW5rbm93bi9sZWdhY3kgbWFza3MgZmFpbCBjbG9zZWQuXG5jb25zdCBzZXNzaW9uTWFza0NvbXBvbmVudHMgPSBuZXcgV2Vha1NldDxvYmplY3Q+KCk7XG5jb25zdCBSQVNURVJfVkVDVE9SX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnVkVDVE9SJyxcclxuICAgICdCT09MRUFOX09QRVJBVElPTicsXHJcbiAgICAnU1RBUicsXHJcbiAgICAnTElORScsXHJcbiAgICAnUkVHVUxBUl9QT0xZR09OJyxcclxuXSk7XHJcblxyXG5mdW5jdGlvbiBjbGVhbk5hbWUoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc2FuaXRpemVOb2RlTmFtZShpbnB1dCkgPz8gJ0ZpZ21hIE5vZGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b0NvbG9yKENvbG9yOiBhbnksIHZhbHVlOiBGaWdtYUNvbG9yIHwgdW5kZWZpbmVkLCBvcGFjaXR5ID0gMSk6IGFueSB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSB2YWx1ZSA/PyB7IHI6IDAsIGc6IDAsIGI6IDAsIGE6IDEgfTtcclxuICAgIHJldHVybiBuZXcgQ29sb3IoXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UucikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5nKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAoc291cmNlLmEgPz8gMSkgKiBvcGFjaXR5KSkgKiAyNTUpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZEJ5VXVpZChyb290OiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QudXVpZCA9PT0gdXVpZCkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQnlVdWlkKGNoaWxkLCB1dWlkKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlUHJlZmFiRmlsZUlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/Ll9wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudDogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gY29tcG9uZW50Py5fX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWxrTm9kZXMocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xyXG4gICAgdmlzaXQocm9vdCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICB3YWxrTm9kZXMoY2hpbGQsIHZpc2l0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiQXNzZXRVdWlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBhc3NldCA9IG5vZGU/Ll9wcmVmYWI/LmFzc2V0O1xyXG4gICAgY29uc3QgdmFsdWUgPSBhc3NldD8uX3V1aWQgPz8gYXNzZXQ/LnV1aWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkZpbGVJZEluZGV4KHJvb3Q6IGFueSwgZXhwZWN0ZWRQcmVmYWJVdWlkPzogc3RyaW5nKTogTWFwPHN0cmluZywgYW55PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgY29uc3QgY29tcG9uZW50RmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgd2Fsa05vZGVzKHJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiUm9vdCA9IG5vZGU/Ll9wcmVmYWI/LnJvb3Q7XHJcbiAgICAgICAgaWYgKG5vZGUgIT09IHJvb3QgJiYgcHJlZmFiUm9vdCAmJiBwcmVmYWJSb290ICE9PSByb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYXNzZXRVdWlkID0gcHJlZmFiQXNzZXRVdWlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChleHBlY3RlZFByZWZhYlV1aWQgJiYgYXNzZXRVdWlkICYmIGFzc2V0VXVpZCAhPT0gZXhwZWN0ZWRQcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAoIWZpbGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChyZXN1bHQuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN6IqC54K5IGZpbGVJZO+8miR7ZmlsZUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHQuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZS5jb21wb25lbnRzID8/IG5vZGUuX2NvbXBvbmVudHMgPz8gW10pIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN57uE5Lu2IGZpbGVJZO+8miR7Y29tcG9uZW50RmlsZUlkfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbXBvbmVudEZpbGVJZHMuYWRkKGNvbXBvbmVudEZpbGVJZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJFZGl0aW5nU3RhdGUoXHJcbiAgICBleHBlY3RlZFV1aWQ6IHN0cmluZyxcclxuICAgIGV4cGVjdGVkUm9vdEZpbGVJZD86IHN0cmluZyxcclxuKTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY29uc3QgbW9kZSA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlNb2RlPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCBjdXJyZW50VXVpZCA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCByb290ID0gY2NlQXBpPy5TY2VuZT8ucm9vdE5vZGUgPz8gbnVsbDtcclxuICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKHJvb3QpO1xyXG4gICAgbGV0IHJlYXNvbiA9ICcnO1xyXG4gICAgaWYgKG1vZGUgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjee8lui+keaooeW8j+S4uiAke21vZGUgfHwgJ3Vua25vd24nfe+8jOWwmuacqui/m+WFpSBQcmVmYWJgO1xyXG4gICAgfSBlbHNlIGlmIChjdXJyZW50VXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjei1hOa6kCBVVUlEIOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie0YDtcclxuICAgIH0gZWxzZSBpZiAoIXJvb3QpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCueWwmuacquWwsee7qic7XHJcbiAgICB9IGVsc2UgaWYgKGV4cGVjdGVkUm9vdEZpbGVJZCAmJiByb290RmlsZUlkICE9PSBleHBlY3RlZFJvb3RGaWxlSWQpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5LiO5p2l5rqQ6K6w5b2V5LiN5LiA6Ie0JztcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgcmVhZHk6ICFyZWFzb24sXHJcbiAgICAgICAgbW9kZSxcclxuICAgICAgICBjdXJyZW50VXVpZCxcclxuICAgICAgICByb290VXVpZDogcm9vdD8udXVpZCxcclxuICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgIHJlYXNvbjogcmVhc29uIHx8IHVuZGVmaW5lZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLkVkaXRvcj8uVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gZ2VuZXJhdGVkO1xyXG4gICAgfVxyXG4gICAgLy8gVW5pdC10ZXN0L2hlYWRsZXNzIGZhbGxiYWNrLiBUaGUgcmVhbCBDcmVhdG9yIHNjZW5lIHByb2Nlc3MgYWx3YXlzIHVzZXNcclxuICAgIC8vIEVkaXRvci5VdGlscy5VVUlELmdlbmVyYXRlKHRydWUpLCBzbyBwcm9kdWN0aW9uIElEcyBmb2xsb3cgQ3JlYXRvcidzIG93biBmb3JtYXQuXHJcbiAgICByZXR1cm4gYGZpZ21hJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDE0KX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlOiBhbnksIHByZWZhYlJvb3Q6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGROb2RlPy4obm9kZSk7XHJcbiAgICBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LlByZWZhYkluZm8gPz8gY2MuUHJlZmFiSW5mbztcclxuICAgIGlmICghUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw6IqC54K555Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLnJvb3QgPSBwcmVmYWJSb290O1xyXG4gICAgaW5mby5hc3NldCA9IHByZWZhYlJvb3Q/Ll9wcmVmYWI/LmFzc2V0ID8/IG51bGw7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBpbmZvLmluc3RhbmNlID0gbnVsbDtcclxuICAgIGluZm8udGFyZ2V0T3ZlcnJpZGVzID0gbnVsbDtcclxuICAgIG5vZGUuX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZENvbXBvbmVudD8uKGNvbXBvbmVudCk7XHJcbiAgICBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgQ29tcFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uQ29tcFByZWZhYkluZm8gPz8gY2MuQ29tcFByZWZhYkluZm87XHJcbiAgICBpZiAoIUNvbXBQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBDb21wUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw57uE5Lu255Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBDb21wUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgY29tcG9uZW50Ll9fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0UGFyZW50S2VlcGluZ1dvcmxkKG5vZGU6IGFueSwgcGFyZW50OiBhbnkpOiB2b2lkIHtcclxuICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRQYXJlbnQgPT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICBub2RlLnNldFBhcmVudChwYXJlbnQsIHRydWUpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBub2RlLnBhcmVudCA9IHBhcmVudDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkOiBhbnksIHBhcmVudDogYW55LCBjYzogYW55KTogYm9vbGVhbiB7XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gQkFDS0dST1VORF9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9NQVNLX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX1NQUklURV9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gJ19fRmlnbWFDb250ZW50Jykge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKGNoaWxkLm5hbWUgPT09ICd2aWV3JyAmJiBwYXJlbnQuZ2V0Q29tcG9uZW50Py4oY2MuU2Nyb2xsVmlldykpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBjaGlsZC5uYW1lID09PSAnY29udGVudCdcclxuICAgICAgICAmJiBwYXJlbnQubmFtZSA9PT0gJ3ZpZXcnXHJcbiAgICAgICAgJiYgcGFyZW50LnBhcmVudD8uZ2V0Q29tcG9uZW50Py4oY2MuU2Nyb2xsVmlldyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZU1hcHBlZE5vZGVUcmVlKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIHN0YWxlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGxldCByZW1vdmVkID0gMTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgaWYgKHN0YWxlVXVpZHMuaGFzKGNoaWxkLnV1aWQpIHx8IGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpKSB7XHJcbiAgICAgICAgICAgIHJlbW92ZWQgKz0gcmVtb3ZlTWFwcGVkTm9kZVRyZWUoY2hpbGQsIHN1cnZpdm9yUGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChzdXJ2aXZvclBhcmVudCkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgIHJldHVybiByZW1vdmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVTY2VuZVNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IFNjZW5lTm9kZVNwZWMge1xyXG4gICAgY29uc3QgYWN0aW9uID0gbm9ybWFsaXplSW1wb3J0QWN0aW9uKHNwZWMuYWN0aW9uIGFzIHVua25vd24pO1xyXG4gICAgY29uc3Qga2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24oc3BlYy5raW5kLCBhY3Rpb24pO1xyXG4gICAgY29uc3QgY2hpbGRyZW4gPSBBcnJheS5pc0FycmF5KHNwZWMuY2hpbGRyZW4pID8gc3BlYy5jaGlsZHJlbiA6IFtdO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5zcGVjLFxyXG4gICAgICAgIGFjdGlvbixcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIGNoaWxkcmVuOiBpc1Rlcm1pbmFsQWN0aW9uKGFjdGlvbikgfHwgc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09IHRydWVcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IGNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IG5vcm1hbGl6ZVNjZW5lU3BlYyhjaGlsZCkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmlnbWFJZHNGb3JTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCBpZHMgPSBbc3BlYy5maWdtYUlkLCAuLi4oc3BlYy5hbGlhc0ZpZ21hSWRzID8/IFtdKV1cclxuICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIGlkLmxlbmd0aCA+IDAgJiYgaWQgIT09ICdfX3Jvb3RfXycpO1xyXG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KGlkcyldO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbGlhc0ZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgcmV0dXJuIGZpZ21hSWRzRm9yU3BlYyhzcGVjKS5maWx0ZXIoKGZpZ21hSWQpID0+IGZpZ21hSWQgIT09IHNwZWMuZmlnbWFJZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4aXN0aW5nVXVpZEZvclNwZWMoXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IGV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKHR5cGVvZiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeSA9PT0gJ2Jvb2xlYW4nKSB7XHJcbiAgICAgICAgcmV0dXJuIHNwZWMuZmxhdHRlbkJvdW5kYXJ5O1xyXG4gICAgfVxyXG4gICAgLy8gQmFja3dhcmQgY29tcGF0aWJpbGl0eSBmb3IgU2NlbmVTcGVjcyBwZXJzaXN0ZWQgYnkgaW1wb3J0ZXIgdmVyc2lvbnNcclxuICAgIC8vIGJlZm9yZSBmbGF0dGVuQm91bmRhcnkgd2FzIGludHJvZHVjZWQuIE5ldyBwbGFucyBhbHdheXMgc2V0IHRoZSBmbGFnIHNvXHJcbiAgICAvLyBmb2xkZWQgTGFiZWxzIGFuZCBvdGhlciBwcm9tb3RlZCB2aXN1YWxzIHVzZSB0aGUgc2FtZSBjbGVhbnVwIHNlbWFudGljcy5cclxuICAgIHJldHVybiBzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcidcclxuICAgICAgICB8fCAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgQm9vbGVhbihzcGVjLnNwcml0ZSkgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGggPT09IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVDb2xsYXBzZWRNYXBwZWREZXNjZW5kYW50cyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBjYzogYW55LFxyXG4pOiBudW1iZXIge1xyXG4gICAgY29uc3QgcmV0YWluZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhjdXJyZW50TWFwKSk7XHJcbiAgICBjb25zdCBib3VuZGFyeVNwZWNzOiBBcnJheTx7XHJcbiAgICAgICAgZmlnbWFJZDogc3RyaW5nO1xyXG4gICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogYm9vbGVhbjtcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIH0+ID0gW107XHJcbiAgICBjb25zdCBjb2xsZWN0Qm91bmRhcmllcyA9IChub2RlczogU2NlbmVOb2RlU3BlY1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBzcGVjIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBib3VuZGFyeVNwZWNzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZ21hSWQ6IHNwZWMuZmlnbWFJZCxcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldCgpLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBhbGlhc0ZpZ21hSWRzID0gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYyk7XHJcbiAgICAgICAgICAgIGlmIChhbGlhc0ZpZ21hSWRzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiBmYWxzZSxcclxuICAgICAgICAgICAgICAgICAgICBhbGlhc0ZpZ21hSWRzOiBuZXcgU2V0KGFsaWFzRmlnbWFJZHMpLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29sbGVjdEJvdW5kYXJpZXMoc3BlYy5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWNzKTtcclxuICAgIGNvbnN0IGJvdW5kYXJpZXMgPSBib3VuZGFyeVNwZWNzXHJcbiAgICAgICAgLm1hcCgoYm91bmRhcnkpID0+ICh7XHJcbiAgICAgICAgICAgIC4uLmJvdW5kYXJ5LFxyXG4gICAgICAgICAgICBub2RlOiBjdXJyZW50TWFwW2JvdW5kYXJ5LmZpZ21hSWRdXHJcbiAgICAgICAgICAgICAgICA/IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXSlcclxuICAgICAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICB9KSlcclxuICAgICAgICAuZmlsdGVyKChib3VuZGFyeSk6IGJvdW5kYXJ5IGlzIHR5cGVvZiBib3VuZGFyeSAmIHsgbm9kZTogYW55IH0gPT4gQm9vbGVhbihib3VuZGFyeS5ub2RlKSk7XHJcbiAgICBpZiAoIWJvdW5kYXJpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4aXN0aW5nTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nIHx8IHJldGFpbmVkVXVpZHMuaGFzKHV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGJvdW5kYXJ5IG9mIGJvdW5kYXJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKCFib3VuZGFyeS5yZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHNcclxuICAgICAgICAgICAgICAgICYmICFib3VuZGFyeS5hbGlhc0ZpZ21hSWRzLmhhcyhmaWdtYUlkKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoYm91bmRhcnkubm9kZSwgdXVpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlICYmIG5vZGUgIT09IGJvdW5kYXJ5Lm5vZGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YWxlTm9kZXMuc2V0KG5vZGUudXVpZCwgbm9kZSk7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmICghc3RhbGVOb2Rlcy5zaXplKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZVV1aWRzID0gbmV3IFNldChzdGFsZU5vZGVzLmtleXMoKSk7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygc3RhbGVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGlmICghbm9kZS5wYXJlbnQgfHwgc3RhbGVVdWlkcy5oYXMobm9kZS5wYXJlbnQudXVpZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlbW92ZWQgKz0gcmVtb3ZlTWFwcGVkTm9kZVRyZWUobm9kZSwgbm9kZS5wYXJlbnQsIHN0YWxlVXVpZHMsIGNjKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZW1vdmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtZXJnZVByZXNlcnZlZE1hcHBpbmdzKFxyXG4gICAgaW1wb3J0Um9vdDogYW55LFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBjdXJyZW50TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4aXN0aW5nTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nIHx8IGN1cnJlbnRNYXBbZmlnbWFJZF0pIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpKSB7XHJcbiAgICAgICAgICAgIGN1cnJlbnRNYXBbZmlnbWFJZF0gPSB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICBjb250YWluZXI6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBleGlzdGluZ1V1aWRzOiBTZXQ8c3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nVXVpZHMuaGFzKGNoaWxkLnV1aWQpKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgZXhpc3RpbmdVdWlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kQ2FudmFzKHJvb3Q6IGFueSwgQ2FudmFzOiBhbnkpOiBhbnkgfCBudWxsIHtcclxuICAgIGlmIChyb290LmdldENvbXBvbmVudChDYW52YXMpKSB7XHJcbiAgICAgICAgcmV0dXJuIHJvb3Q7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRDYW52YXMoY2hpbGQsIENhbnZhcyk7XHJcbiAgICAgICAgaWYgKGZvdW5kKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkQ29tcG9uZW50cyhcclxuICAgIG5vZGU6IGFueSxcclxuICAgIGNsYXNzZXM6IGFueVtdLFxyXG4gICAgcHJlc2VydmVkOiBTZXQ8YW55PixcclxuICAgIHJlbmRlckNsYXNzZXM6IGFueVtdLFxyXG4gICAgcmVtb3ZhYmxlRmlsZUlkcz86IFNldDxzdHJpbmc+LFxyXG4pOiBib29sZWFuIHtcclxuICAgIGxldCByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gZmFsc2U7XHJcbiAgICBmb3IgKGNvbnN0IHR5cGUgb2YgY2xhc3Nlcykge1xyXG4gICAgICAgIGlmIChwcmVzZXJ2ZWQuaGFzKHR5cGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBub2RlLmdldENvbXBvbmVudCh0eXBlKTtcclxuICAgICAgICBpZiAoY29tcG9uZW50KSB7XHJcbiAgICAgICAgICAgIGlmIChyZW1vdmFibGVGaWxlSWRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIGlmICghZmlsZUlkIHx8ICFyZW1vdmFibGVGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4iueahOa4suafk+e7hOS7tuS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDku6Xkv53miqTmiYvlt6XlhoXlrrnjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmVuZGVyQ2xhc3Nlcy5zb21lKChyZW5kZXJUeXBlKSA9PiBjb21wb25lbnQgaW5zdGFuY2VvZiByZW5kZXJUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm9kZS5yZW1vdmVDb21wb25lbnQoY29tcG9uZW50KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZFJlbmRlckNvbXBvbmVudDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZTogYW55LCBjYzogYW55KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBvdXRsaW5lID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTGFiZWxPdXRsaW5lKTtcclxuICAgIGlmICghb3V0bGluZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIExhYmVsT3V0bGluZSB3YXMgdXNlZCBieSBvbGRlciBpbXBvcnRlciB2ZXJzaW9ucy4gQ29jb3MgZGVzdHJveXNcclxuICAgIC8vIGNvbXBvbmVudHMgYXQgdGhlIGVuZCBvZiB0aGUgZnJhbWUgYW5kIGl0cyBvbkRpc2FibGUoKSB3cml0ZXMgYmFjayB0b1xyXG4gICAgLy8gTGFiZWwuZW5hYmxlT3V0bGluZSwgc28gbGV0IHRoYXQgbGlmZWN5Y2xlIGZpbmlzaCBiZWZvcmUgZWl0aGVyXHJcbiAgICAvLyByZWNvbmZpZ3VyaW5nIG9yIHJlbW92aW5nIHRoZSBMYWJlbCBjb21wb25lbnQuXHJcbiAgICBub2RlLnJlbW92ZUNvbXBvbmVudChvdXRsaW5lKTtcclxuICAgIGF3YWl0IHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSwgbm9kZTogYW55KTogU2V0PGFueT4ge1xuICAgIGNvbnN0IGRlc2lyZWQgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgIGNvbnN0IGNsaXBzQ2hpbGRyZW4gPSBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpO1xyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgIGlmICghdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpICYmICF1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYykpIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuU3ByaXRlKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlJpY2hUZXh0KTtcclxuICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYWJlbCk7XHJcbiAgICB9IGVsc2UgaWYgKCFSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICBpZiAoaGFzR3JhcGhpY3NWaXN1YWwoc3BlYykgfHwgY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5HcmFwaGljcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLk1hc2spO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgbGF5b3V0TW9kZVxyXG4gICAgICAgICYmIGxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkxheW91dCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5TY3JvbGxWaWV3KTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuQnV0dG9uKTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlVJT3BhY2l0eSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVzaXJlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAwKSk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJPd25lcnNoaXBHdWFyZCB7XHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzT3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgcmV0dXJuICFndWFyZC5wcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oZmlsZUlkICYmIGd1YXJkLnByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoZmlsZUlkKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgY29tcG9uZW50OiBhbnksXHJcbiAgICBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICBvd25lck5hbWU6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoIWNvbXBvbmVudCB8fCAhZ3VhcmQucHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoIWZpbGVJZCB8fCAhZ3VhcmQucHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBg6IqC54K54oCcJHtvd25lck5hbWV94oCd5LiK55qEICR7Y29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lID8/ICdDb21wb25lbnQnfSDkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGlmICghaXNPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDovoXliqnoioLngrnigJwke25vZGUubmFtZX3igJ3kuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KGNvbXBvbmVudCwgZ3VhcmQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIGlmIChpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShjaGlsZCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShcclxuICAgIGhlbHBlcjogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVtb3ZlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChndWFyZCAmJiBpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmUoY2hpbGQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICB9O1xyXG4gICAgcmVtb3ZlKGhlbHBlcik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBiYWNrZ3JvdW5kID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShCQUNLR1JPVU5EX05PREVfTkFNRSk7XHJcbiAgICBpZiAoIWJhY2tncm91bmQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGJhY2tncm91bmQsIG5vZGUsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKFxyXG4gICAgdGlsZWRTcHJpdGU6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIHN1cnZpdm9yLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGlsZWRTcHJpdGUgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKHRpbGVkU3ByaXRlLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZE92ZXJmbG93VmlzdWFsKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChoZWxwZXIpIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gQSBmbGF0dGVuZWQgbm9kZSBoYXMgbm8gbmV3IGNoaWxkIHNwZWNzIGJ5IGRlc2lnbi4gS2VlcCBldmVyeSBleGlzdGluZ1xyXG4gICAgLy8gY2hpbGQgYWxpdmUgdW50aWwgcmVtb3ZlRmxhdHRlbmVkTWFwcGVkRGVzY2VuZGFudHMgY2FuIGRpc3Rpbmd1aXNoIG9sZFxyXG4gICAgLy8gRmlnbWEtbWFwcGVkIG5vZGVzIGZyb20gdXNlci1hdXRob3JlZCBub2Rlcy4gT3RoZXJ3aXNlIGRlc3Ryb3lpbmcgdGhlXHJcbiAgICAvLyBoZWxwZXIgd291bGQgcmVjdXJzaXZlbHkgZGVzdHJveSBtYW51YWwgY2hpbGRyZW4gYXQgQ29jb3MnIGRlZmVycmVkXHJcbiAgICAvLyBkZXN0cnVjdGlvbiBib3VuZGFyeS5cclxuICAgIGNvbnN0IHByZXNlcnZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKTtcclxuICAgIGNvbnN0IG1vdmVDaGlsZHJlblRvTm9kZSA9IChjb250YWluZXI6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZ3VhcmQgfHwgcHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUobGVnYWN5KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICBjb25zdCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgY29uc3QgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50Jyk7XHJcbiAgICBpZiAoIXNjcm9sbCB8fCAhdmlldyB8fCAhY29udGVudFxyXG4gICAgICAgIHx8IChzY3JvbGwuY29udGVudCAhPT0gY29udGVudCAmJiBzY3JvbGwuY29udGVudCAhPSBudWxsKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBub2RlLCBndWFyZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUoY29udGVudCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udmlldy5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGNoaWxkICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29udGVudC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBjb250ZW50LmRlc3Ryb3koKTtcclxuICAgIHZpZXcucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgdmlldy5kZXN0cm95KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lUG9zaXRpb24oXHJcbiAgICBmcmFtZTogUmVjdCxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuICAgIGNoaWxkVHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0ge1xyXG4gICAgaWYgKCFwYXJlbnRGcmFtZSkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLCB5OiAxIH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd2lkdGggPSBmcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBjaGlsZEFuY2hvciA9IGNoaWxkVHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC8vIEZpZ21hIGNvb3JkaW5hdGVzIGFyZSBtZWFzdXJlZCBmcm9tIHRoZSBwYXJlbnQncyB0b3AtbGVmdC4gQ29udmVydFxyXG4gICAgICAgIC8vIHRoYXQgcmVjdGFuZ2xlIHRvIHRoZSBsb2NhbCBwb3NpdGlvbiBvZiB0aGUgbm9kZSdzIGNlbnRlciBhbmNob3IuXHJcbiAgICAgICAgeDogKGZyYW1lLnggLSBwYXJlbnRGcmFtZS54KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICArIHdpZHRoICogY2hpbGRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAtIChmcmFtZS55IC0gcGFyZW50RnJhbWUueSkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIGhlaWdodCAqICgxIC0gY2hpbGRBbmNob3IueSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoc3BlYy5pc1Jvb3QgfHwgIXNwZWMuaW50cmluc2ljU2l6ZSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IG1hdHJpeCA9IHNwZWMucmVsYXRpdmVUcmFuc2Zvcm07XHJcbiAgICBjb25zdCB2YWx1ZXMgPSBbXHJcbiAgICAgICAgbWF0cml4Py5bMF0/LlswXSwgbWF0cml4Py5bMF0/LlsxXSwgbWF0cml4Py5bMF0/LlsyXSxcclxuICAgICAgICBtYXRyaXg/LlsxXT8uWzBdLCBtYXRyaXg/LlsxXT8uWzFdLCBtYXRyaXg/LlsxXT8uWzJdLFxyXG4gICAgXTtcclxuICAgIGlmICghdmFsdWVzLmV2ZXJ5KCh2YWx1ZSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBbbTAwLCBtMDEsIHR4LCBtMTAsIG0xMSwgdHldID0gdmFsdWVzIGFzIG51bWJlcltdO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHBhcmVudFdpZHRoKSB8fCAhTnVtYmVyLmlzRmluaXRlKHBhcmVudEhlaWdodCkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEgcmVsYXRpdmVUcmFuc2Zvcm0gaXMgdG9wLWxlZnQgYmFzZWQuIFRyYW5zZm9ybSB0aGUgdW5yb3RhdGVkIGxvY2FsXHJcbiAgICAvLyBjZW50ZXIsIHRoZW4gY29udmVydCB0aGUgcGFyZW50J3MgZG93bndhcmQgWSBheGlzIHRvIENvY29zIHVwd2FyZCBZLlxyXG4gICAgY29uc3QgY2VudGVyWCA9IHR4ICsgbTAwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTAxICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCBjZW50ZXJZID0gdHkgKyBtMTAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMTEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgeDogY2VudGVyWCAqIHNjYWxlIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KSAtIGNlbnRlclkgKiBzY2FsZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtOiBhbnksIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XG4gICAgLy8gUm91bmQgb25seSBhdCB0aGUgVUlUcmFuc2Zvcm0gd3JpdGUgYm91bmRhcnksIGFmdGVyIHNjYWxlL2xheW91dCBtYXRoLlxuICAgIC8vIERvIG5vdCBsb2NrIHNpemVzIHJlY2FsY3VsYXRlZCBsYXRlciBieSBMYWJlbCBvciBvdGhlciBydW50aW1lIGNvbXBvbmVudHMuXG4gICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZShcbiAgICAgICAgTWF0aC5yb3VuZCgod2lkdGggKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICAgICBNYXRoLnJvdW5kKChoZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICk7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IGFueSB7XG4gICAgY29uc3QgeyBVSVRyYW5zZm9ybSwgVmVjMyB9ID0gY2M7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gbm9kZS5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIGNvbnN0IHNpemUgPSBzcGVjLmludHJpbnNpY1NpemUgPz8gc3BlYy5mcmFtZTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBub2RlLnBhcmVudD8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3BlYy5pc1Jvb3RcclxuICAgICAgICA/IHsgeDogMCwgeTogMCB9XHJcbiAgICAgICAgOiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKHNwZWMsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IGZyYW1lUG9zaXRpb24oc3BlYy5mcmFtZSwgc3BlYy5wYXJlbnRGcmFtZSwgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSwgdHJhbnNmb3JtKTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbiAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIHNwZWMucm90YXRpb24pO1xyXG4gICAgbm9kZS5hY3RpdmUgPSBzcGVjLnZpc2libGU7XHJcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZFBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC50eXBlID09PSAnU09MSUQnXHJcbiAgICAgICAgJiYgcGFpbnQudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDBcclxuICAgICAgICAmJiBCb29sZWFuKHBhaW50LmNvbG9yKVxyXG4gICAgICAgICYmIChwYWludC5jb2xvcj8uYSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRGaWxsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5maWxscyk7XG59XG5cbmZ1bmN0aW9uIGZpcnN0VGV4dEZpbGwocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcbiAgICAvLyBGaWdtYSdzIHBhaW50IGFycmF5IGlzIGJhY2stdG8tZnJvbnQ6IHRoZSBwYW5lbCdzIHRvcCBmaWxsIGlzIGxhc3QuXG4gICAgLy8gTmF0aXZlIHRleHQga2VlcHMgdGhlIGZpcnN0IHVzYWJsZSBzb2xpZCBpbiBwYW5lbCBvcmRlciwgd2l0aG91dCBtaXhpbmdcbiAgICAvLyBzdGFja2VkIGZpbGxzIG9yIGNoYW5naW5nIHRoZSBzb3VyY2Ugb3JkZXIgdXNlZCBieSBvdGhlciByZW5kZXJlcnMuXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KFsuLi5wYWludHNdLnJldmVyc2UoKSk7XG59XG5cclxuZnVuY3Rpb24gdmFsaWRTb2xpZFN0cm9rZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gc3BlYy5zdHJva2VXZWlnaHQgPiAwID8gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5zdHJva2VzKSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzR3JhcGhpY3NWaXN1YWwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odmlzaWJsZVNvbGlkRmlsbChzcGVjKSB8fCB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0dyYXBoaWNzKGdyYXBoaWNzOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlU29saWRGaWxsKHNwZWMpO1xyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmFsaWRTb2xpZFN0cm9rZShzcGVjKTtcclxuICAgIGlmICghZmlsbCAmJiAhc3Ryb2tlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmFkaXVzID0gTWF0aC5tYXgoXHJcbiAgICAgICAgMCxcclxuICAgICAgICBNYXRoLm1pbihNYXRoLm1pbiguLi5zcGVjLmNvcm5lclJhZGlpKSAqIHNjYWxlLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpLFxyXG4gICAgKTtcclxuICAgIGlmIChzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZWxsaXBzZSgwLCAwLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpO1xyXG4gICAgfSBlbHNlIGlmIChyYWRpdXMgPiAwKSB7XHJcbiAgICAgICAgZ3JhcGhpY3Mucm91bmRSZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0LCByYWRpdXMpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBncmFwaGljcy5yZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0KTtcclxuICAgIH1cclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGxDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5maWxsKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmxpbmVXaWR0aCA9IE1hdGgubWF4KDAuNSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHcmFwaGljcyhub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCBleGlzdGluZyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKTtcbiAgICBjb25zdCBncmFwaGljcyA9IGV4aXN0aW5nID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkdyYXBoaWNzKTtcbiAgICBpZiAoIWV4aXN0aW5nKSBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKGdyYXBoaWNzKTtcbiAgICBncmFwaGljcy5lbmFibGVkID0gdHJ1ZTtcclxuICAgIGdyYXBoaWNzLmNsZWFyKCk7XHJcbiAgICBkcmF3R3JhcGhpY3MoZ3JhcGhpY3MsIHNwZWMsIHNjYWxlLCBjYyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZUxhYmVsVGV4dChjaGFyYWN0ZXJzOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIChjaGFyYWN0ZXJzID8/ICcnKVxyXG4gICAgICAgIC5yZXBsYWNlKC9cXHJcXG4vZywgJ1xcbicpXHJcbiAgICAgICAgLnJlcGxhY2UoL1tcXHJcXHUyMDI4XFx1MjAyOV0vZywgJ1xcbicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVRleHRBbGlnbm1lbnQoY29tcG9uZW50OiBhbnksIHN0eWxlOiBTY2VuZU5vZGVTcGVjWyd0ZXh0U3R5bGUnXSwgcmVuZGVyZXI6IGFueSk6IHZvaWQge1xuICAgIC8vIENvY29zIGhhcyBubyBKVVNUSUZJRUQgYWxpZ25tZW50OiB1bnN1cHBvcnRlZC9taXNzaW5nIHZhbHVlcyB1c2UgTEVGVC9UT1AuXG4gICAgY29tcG9uZW50Lmhvcml6b250YWxBbGlnbiA9IHN0eWxlPy50ZXh0QWxpZ25Ib3Jpem9udGFsID09PSAnQ0VOVEVSJ1xuICAgICAgICA/IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduSG9yaXpvbnRhbCA9PT0gJ1JJR0hUJ1xuICAgICAgICAgICAgPyByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uUklHSFRcbiAgICAgICAgICAgIDogcmVuZGVyZXIuSG9yaXpvbnRhbEFsaWduLkxFRlQ7XG4gICAgY29tcG9uZW50LnZlcnRpY2FsQWxpZ24gPSBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdDRU5URVInXG4gICAgICAgID8gcmVuZGVyZXIuVmVydGljYWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdCT1RUT00nXG4gICAgICAgICAgICA/IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uQk9UVE9NXG4gICAgICAgICAgICA6IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uVE9QO1xufVxyXG5cclxuZnVuY3Rpb24gZmlnbWFQYW5lbEZvbnRTaXplKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICAgIGNvbnN0IGZvbnRTaXplID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgoZm9udFNpemUgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwO1xufVxuXG5mdW5jdGlvbiBmaWdtYVBhbmVsTGluZUhlaWdodCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgICBjb25zdCBsaW5lSGVpZ2h0ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICAvLyBQcmVzZXJ2ZSBGaWdtYSdzIHBpeGVsIGxpbmUgaGVpZ2h0IGluZGVwZW5kZW50bHkgb2YgaW1wb3J0IHNjYWxlIGFuZFxuICAgIC8vIGVuZ2luZS1jb21wdXRlZCBjb250ZW50IHNpemU7IG9ubHkgcm91bmQgdG8gb25lIGRlY2ltYWwgcGxhY2UuXG4gICAgcmV0dXJuIE1hdGgucm91bmQoKGxpbmVIZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMCkgLyAxMDtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlTGFiZWwobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB7IExhYmVsIH0gPSBjYztcclxuICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpID8/IG5vZGUuYWRkQ29tcG9uZW50KExhYmVsKTtcclxuICAgIGNvbnN0IHN0eWxlID0gc3BlYy50ZXh0U3R5bGUgPz8ge307XHJcbiAgICBjb25zdCBjaGFyYWN0ZXJzID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICAvLyBGaWdtYSBOT05FIG1lYW5zIGEgZml4ZWQgYm94LCBub3QgQ29jb3MgT3ZlcmZsb3cuTk9ORS4gQm90aCBmaXhlZC13aWR0aFxuICAgIC8vIG1vZGVzIHdyYXAgYW5kIGdyb3cgdmVydGljYWxseTsgbWlzc2luZyBsZWdhY3kgbWV0YWRhdGEgc3RheXMgYXV0by13aWR0aC5cbiAgICBjb25zdCB3cmFwID0gc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdIRUlHSFQnIHx8IHN0eWxlLnRleHRBdXRvUmVzaXplID09PSAnTk9ORSc7XG4gICAgLy8gRmlnbWEgc3RvcmVzIG1vcmUgcHJlY2lzaW9uIHRoYW4gaXRzIHBhbmVsIGRpc3BsYXlzLiBNYXRjaCB0aGUgdmlzaWJsZVxyXG4gICAgLy8gZGVzaWduIHZhbHVlICh1cCB0byB0d28gZGVjaW1hbHMpIGluc3RlYWQgb2YgbGVha2luZyBpdHMgaW50ZXJuYWwgZmxvYXQuXHJcbiAgICBsYWJlbC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICBsYWJlbC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcbiAgICBsYWJlbC5zcGFjaW5nWCA9IChzdHlsZS5sZXR0ZXJTcGFjaW5nID8/IDApICogc2NhbGU7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IHdyYXAgPyBMYWJlbC5PdmVyZmxvdy5SRVNJWkVfSEVJR0hUIDogTGFiZWwuT3ZlcmZsb3cuTk9ORTtcbiAgICBsYWJlbC5lbmFibGVXcmFwVGV4dCA9IHdyYXA7XG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KGxhYmVsLCBzdHlsZSwgTGFiZWwpO1xuICAgIC8vIEF1dG8td2lkdGggbGFiZWxzIHVzZSBhIGNlbnRlcmVkIHZlcnRpY2FsIGJhc2VsaW5lIHJlZ2FyZGxlc3Mgb2YgRmlnbWEnc1xuICAgIC8vIHZlcnRpY2FsIGFsaWdubWVudC4gRml4ZWQtd2lkdGggd3JhcHBpbmcgbGFiZWxzIHJldGFpbiB0aGUgRmlnbWEgc2V0dGluZy5cbiAgICBpZiAobGFiZWwub3ZlcmZsb3cgPT09IExhYmVsLk92ZXJmbG93Lk5PTkUpIHtcbiAgICAgICAgbGFiZWwudmVydGljYWxBbGlnbiA9IExhYmVsLlZlcnRpY2FsQWxpZ24uQ0VOVEVSO1xuICAgIH1cbiAgICBsYWJlbC5zdHJpbmcgPSBjaGFyYWN0ZXJzO1xuICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSBmYWxzZTtcclxuICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xuICAgIGNvbnN0IGZpbGwgPSBmaXJzdFRleHRGaWxsKHNwZWMuZmlsbHMpO1xuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmlzaWJsZVBhaW50KHNwZWMuc3Ryb2tlcyk7XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvciAmJiBzcGVjLnN0cm9rZVdlaWdodCA+IDApIHtcclxuICAgICAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gdHJ1ZTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVXaWR0aCA9IE1hdGgubWF4KDEsIHNwZWMuc3Ryb2tlV2VpZ2h0ICogc2NhbGUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVSaWNoVGV4dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgUmljaFRleHQgfSA9IGNjO1xyXG4gICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCkgPz8gbm9kZS5hZGRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIHJpY2hUZXh0LnN0cmluZyA9IG5vcm1hbGl6ZUxhYmVsVGV4dChzcGVjLmNoYXJhY3RlcnMpO1xyXG4gICAgcmljaFRleHQuZm9udFNpemUgPSBmaWdtYVBhbmVsRm9udFNpemUoc3R5bGUuZm9udFNpemUpO1xyXG4gICAgcmljaFRleHQubGluZUhlaWdodCA9IGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSk7XG4gICAgcmljaFRleHQubWF4V2lkdGggPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpO1xyXG4gICAgcmljaFRleHQuaGFuZGxlVG91Y2hFdmVudCA9IGZhbHNlO1xyXG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KHJpY2hUZXh0LCBzdHlsZSwgUmljaFRleHQpO1xuICAgIHJpY2hUZXh0LmZvbnRGYW1pbHkgPSBzdHlsZS5mb250RmFtaWx5ID8/ICcnO1xyXG4gICAgcmljaFRleHQudXNlU3lzdGVtRm9udCA9ICFzcGVjLmZvbnRVdWlkO1xuICAgIHJpY2hUZXh0LmZvbnRDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHsgcjogMSwgZzogMSwgYjogMSwgYTogMSB9KTtcbiAgICBjb25zdCBmaWxsID0gZmlyc3RUZXh0RmlsbChzcGVjLmZpbGxzKTtcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICByaWNoVGV4dC5mb250Q29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICB0YXJnZXRGcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0gc3BlYy5mcmFtZSxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xyXG4gICAgY29uc3Qgc3ByaXRlID0gbm9kZS5nZXRDb21wb25lbnQoU3ByaXRlKSA/PyBub2RlLmFkZENvbXBvbmVudChTcHJpdGUpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuXHJcbiAgICAvLyBLZWVwIGFzc2lnbm1lbnQgZGV0ZXJtaW5pc3RpYzogYSBuZXcgU3ByaXRlIG1heSBkZWZhdWx0IHRvIFRSSU1NRUQgYW5kXHJcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gYXdhaXQgbG9hZEFzc2V0KGFzc2V0TWFuYWdlciwgc3BlYy5zcHJpdGUudXVpZCk7XG4gICAgc3ByaXRlLnNwcml0ZUZyYW1lID0gc3ByaXRlRnJhbWU7XG4gICAgY29uc3Qgc2xpY2VkID0gc3BlYy5zcHJpdGUuc2xpY2VkIHx8ICghc3BlYy5zcHJpdGUuc2xpY2VGYWxsYmFja1xuICAgICAgICAmJiBbc3ByaXRlRnJhbWUuaW5zZXRMZWZ0LCBzcHJpdGVGcmFtZS5pbnNldFJpZ2h0LCBzcHJpdGVGcmFtZS5pbnNldFRvcCwgc3ByaXRlRnJhbWUuaW5zZXRCb3R0b21dXG4gICAgICAgICAgICAuc29tZSgodmFsdWUpID0+IE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwKSk7XG4gICAgc3ByaXRlLnR5cGUgPSBzcGVjLnNwcml0ZS50aWxlZFxuICAgICAgICA/IFNwcml0ZS5UeXBlLlRJTEVEXG4gICAgICAgIDogc2xpY2VkXG4gICAgICAgICAgICA/IFNwcml0ZS5UeXBlLlNMSUNFRFxyXG4gICAgICAgICAgICA6IFNwcml0ZS5UeXBlLlNJTVBMRTtcclxuXHJcbiAgICBpZiAoIXNsaWNlZCAmJiAhc3BlYy5zcHJpdGUudGlsZWQpIHtcbiAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLlRSSU1NRUQ7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgcmF3V2lkdGggPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8ud2lkdGggPz8gc3ByaXRlRnJhbWU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZSh0cmltbWVkSGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIHJhd1dpZHRoID4gMFxyXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3V2lkdGggLSB0YXJnZXRXaWR0aCkgPD0gMC41MVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWSA9IHRhcmdldEhlaWdodCAvIHJhd0hlaWdodDtcclxuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyaW1tZWRXaWR0aCAqIHNjYWxlWCwgdHJpbW1lZEhlaWdodCAqIHNjYWxlWSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFNsaWNlZC90aWxlZCBzcHJpdGVzIGFuZCBzcHJpdGVzIHJlc2l6ZWQgaW4gRmlnbWEgbXVzdCByZXRhaW4gdGhlIGRlc2lnblxyXG4gICAgLy8gc2l6ZS4gQ29jb3MgcmVwcmVzZW50cyB0aGF0IHN0YXRlIGFzIENVU1RPTS5cclxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgdGFyZ2V0V2lkdGgsIHRhcmdldEhlaWdodCk7XG59XHJcblxyXG5mdW5jdGlvbiByZXF1aXJlc1RpbGVkTWFzayhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjLCAndGlsZWQtaGVscGVyJykuc2hvdWxkTWFzaztcbn1cclxuXHJcbmZ1bmN0aW9uIG5hdGl2ZVRpbGVTY2FsZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHNjYWxlID0gc3BlYy5zcHJpdGU/LnRpbGVTY2FsZTtcclxuICAgIHJldHVybiB0eXBlb2Ygc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShzY2FsZSkgJiYgc2NhbGUgPiAwXHJcbiAgICAgICAgPyBzY2FsZVxyXG4gICAgICAgIDogMTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZClcclxuICAgICAgICAmJiAocmVxdWlyZXNUaWxlZE1hc2soc3BlYykgfHwgTWF0aC5hYnMobmF0aXZlVGlsZVNjYWxlKHNwZWMpIC0gMSkgPiAxZS02KTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZSlcclxuICAgICAgICAmJiAhc3BlYy5zcHJpdGU/LnNsaWNlZFxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8udGlsZWQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZW5kZXJGcmFtZSA9IHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZTtcclxuICAgIGlmICghcmVuZGVyRnJhbWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi2hei+ueeVjCBQTkcg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd57y65bCR5riy5p+T6L6555WM44CCYCk7XHJcbiAgICB9XHJcbiAgICBsZXQgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChndWFyZCAmJiBoZWxwZXIpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWhlbHBlcikge1xyXG4gICAgICAgIGhlbHBlciA9IG5ldyBjYy5Ob2RlKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQoaGVscGVyKTtcclxuICAgIH1cclxuICAgIGhlbHBlci5uYW1lID0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRTtcclxuICAgIGhlbHBlci5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICBoZWxwZXIuYWN0aXZlID0gdHJ1ZTtcclxuXHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBoZWxwZXIuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IGhlbHBlci5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgcmVuZGVyRnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShoZWxwZXIsIHNwZWMsIHNjYWxlLCBjYywgcmVuZGVyRnJhbWUpO1xyXG5cclxuICAgIGNvbnN0IGdlb21ldHJ5Q2VudGVyWCA9IHNwZWMuZnJhbWUueCArIHNwZWMuZnJhbWUud2lkdGggLyAyO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJZID0gc3BlYy5mcmFtZS55ICsgc3BlYy5mcmFtZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgcmVuZGVyQ2VudGVyWCA9IHJlbmRlckZyYW1lLnggKyByZW5kZXJGcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJZID0gcmVuZGVyRnJhbWUueSArIHJlbmRlckZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICAvLyBGaWdtYSBwYWdlIFkgcG9pbnRzIGRvd253YXJkIHdoaWxlIENvY29zIFVJIFkgcG9pbnRzIHVwd2FyZC5cclxuICAgIGNvbnN0IHdvcmxkRGVsdGFYID0gKHJlbmRlckNlbnRlclggLSBnZW9tZXRyeUNlbnRlclgpICogc2NhbGU7XHJcbiAgICBjb25zdCB3b3JsZERlbHRhWSA9IC0ocmVuZGVyQ2VudGVyWSAtIGdlb21ldHJ5Q2VudGVyWSkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBOdW1iZXIuaXNGaW5pdGUoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgID8gTnVtYmVyKHNwZWMud29ybGRSb3RhdGlvbilcclxuICAgICAgICA6IHNwZWMucm90YXRpb247XHJcbiAgICBjb25zdCByYWRpYW5zID0gd29ybGRSb3RhdGlvbiAqIE1hdGguUEkgLyAxODA7XHJcbiAgICBjb25zdCBjb3NpbmUgPSBNYXRoLmNvcyhyYWRpYW5zKTtcclxuICAgIGNvbnN0IHNpbmUgPSBNYXRoLnNpbihyYWRpYW5zKTtcclxuICAgIC8vIFRoZSBleHBvcnRlZCBQTkcgaXMgYWxyZWFkeSByYXN0ZXJpemVkIGluIEZpZ21hIHBhZ2UgYXhlcy4gQ291bnRlcmFjdFxyXG4gICAgLy8gdGhlIGxvZ2ljYWwgc2hlbGwncyBhY2N1bXVsYXRlZCByb3RhdGlvbiBhbmQgZXhwcmVzcyB0aGUgdmlzdWFsLWNlbnRlclxyXG4gICAgLy8gb2Zmc2V0IGJhY2sgaW4gdGhhdCBzaGVsbCdzIGxvY2FsIGNvb3JkaW5hdGUgc3lzdGVtLlxyXG4gICAgY29uc3QgbG9jYWxYID0gY29zaW5lICogd29ybGREZWx0YVggKyBzaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBjb25zdCBsb2NhbFkgPSAtc2luZSAqIHdvcmxkRGVsdGFYICsgY29zaW5lICogd29ybGREZWx0YVk7XHJcbiAgICBoZWxwZXIuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMobG9jYWxYLCBsb2NhbFksIDApKTtcclxuICAgIGhlbHBlci5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAtd29ybGRSb3RhdGlvbik7XHJcbiAgICBoZWxwZXIuc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgaGVscGVyLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG5lZWRzTWFzayA9IHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpO1xyXG4gICAgbGV0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgbGV0IHRpbGVkU3ByaXRlID0gdGlsZWRNYXNrPy5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKVxyXG4gICAgICAgID8/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChuZWVkc01hc2spIHtcclxuICAgICAgICBpZiAoIXRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICB0aWxlZE1hc2sgPSBuZXcgY2MuTm9kZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgIG5vZGUuYWRkQ2hpbGQodGlsZWRNYXNrKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLm5hbWUgPSBUSUxFRF9NQVNLX05PREVfTkFNRTtcclxuICAgICAgICB0aWxlZE1hc2subGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHRpbGVkTWFzay5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG1hc2tUcmFuc2Zvcm0gPSB0aWxlZE1hc2suZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyB0aWxlZE1hc2suYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxuICAgICAgICAgICAgbWFza1RyYW5zZm9ybSxcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgMCk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFNjYWxlKG5ldyBjYy5WZWMzKDEsIDEsIDEpKTtcclxuICAgICAgICBjb25maWd1cmVDbGlwKHRpbGVkTWFzaywgc3BlYywgY2MsICd0aWxlZC1oZWxwZXInLCBndWFyZCk7XG4gICAgICAgIHRpbGVkTWFzay5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnRpbGVkTWFzay5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICB0aWxlZE1hc2suZGVzdHJveSgpO1xyXG4gICAgICAgIHRpbGVkTWFzayA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzcHJpdGVQYXJlbnQgPSB0aWxlZE1hc2sgPz8gbm9kZTtcclxuICAgIGlmICghdGlsZWRTcHJpdGUpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZSA9IG5ldyBjYy5Ob2RlKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIHNwcml0ZVBhcmVudC5hZGRDaGlsZCh0aWxlZFNwcml0ZSk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkU3ByaXRlLnBhcmVudCAhPT0gc3ByaXRlUGFyZW50KSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUucGFyZW50ID0gc3ByaXRlUGFyZW50O1xyXG4gICAgfVxyXG4gICAgdGlsZWRTcHJpdGUubmFtZSA9IFRJTEVEX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICB0aWxlZFNwcml0ZS5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICB0aWxlZFNwcml0ZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKHRpbGVkU3ByaXRlLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG4gICAgY29uc3QgdGlsZVNjYWxlID0gbmF0aXZlVGlsZVNjYWxlKHNwZWMpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gdGlsZWRTcHJpdGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IHRpbGVkU3ByaXRlLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgdHJhbnNmb3JtLFxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0U2NhbGUobmV3IGNjLlZlYzModGlsZVNjYWxlLCB0aWxlU2NhbGUsIDEpKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlT3BhY2l0eShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPj0gMC45OTkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBvcGFjaXR5ID0gbm9kZS5nZXRDb21wb25lbnQoY2MuVUlPcGFjaXR5KSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5VSU9wYWNpdHkpO1xyXG4gICAgb3BhY2l0eS5vcGFjaXR5ID0gTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzcGVjLm9wYWNpdHkpKSAqIDI1NSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUxheW91dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IExheW91dCwgU2l6ZSB9ID0gY2M7XHJcbiAgICBjb25zdCBsYXlvdXQgPSBub2RlLmdldENvbXBvbmVudChMYXlvdXQpID8/IG5vZGUuYWRkQ29tcG9uZW50KExheW91dCk7XHJcbiAgICBsYXlvdXQudHlwZSA9IG1vZGUgPT09ICdIT1JJWk9OVEFMJ1xyXG4gICAgICAgID8gTGF5b3V0LlR5cGUuSE9SSVpPTlRBTFxyXG4gICAgICAgIDogbW9kZSA9PT0gJ1ZFUlRJQ0FMJ1xyXG4gICAgICAgICAgICA/IExheW91dC5UeXBlLlZFUlRJQ0FMXHJcbiAgICAgICAgICAgIDogTGF5b3V0LlR5cGUuR1JJRDtcclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcpIHtcclxuICAgICAgICBsYXlvdXQuc3RhcnRBeGlzID0gc3BlYy5sYXlvdXQ/LnNvdXJjZU1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuQXhpc0RpcmVjdGlvbi5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5BeGlzRGlyZWN0aW9uLkhPUklaT05UQUw7XHJcbiAgICB9XHJcbiAgICBsYXlvdXQucmVzaXplTW9kZSA9IExheW91dC5SZXNpemVNb2RlLk5PTkU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0xlZnQgPSBzcGVjLmxheW91dCEucGFkZGluZ0xlZnQgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nUmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1RvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0JvdHRvbSA9IHNwZWMubGF5b3V0IS5wYWRkaW5nQm90dG9tICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1ggPSBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcgKiBzY2FsZTtcclxuICAgIGxheW91dC5zcGFjaW5nWSA9IChtb2RlID09PSAnR1JJRCcgPyBzcGVjLmxheW91dCEuY291bnRlclNwYWNpbmcgOiBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcpICogc2NhbGU7XHJcbiAgICBjb25zdCBhY3RpdmVDaGlsZHJlbiA9IHNwZWMuY2hpbGRyZW4uZmlsdGVyKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSk7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0hPUklaT05UQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuV2lkdGggPSBhY3RpdmVDaGlsZHJlbi5yZWR1Y2UoKHRvdGFsLCBjaGlsZCkgPT4gdG90YWwgKyBjaGlsZC5mcmFtZS53aWR0aCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lcldpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC0gbGF5b3V0LnBhZGRpbmdMZWZ0IC0gbGF5b3V0LnBhZGRpbmdSaWdodDtcclxuICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ1NQQUNFX0JFVFdFRU4nICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgbGF5b3V0LnNwYWNpbmdYID0gTWF0aC5tYXgoMCwgKGlubmVyV2lkdGggLSBjaGlsZHJlbldpZHRoKSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuV2lkdGggKyBsYXlvdXQuc3BhY2luZ1ggKiBNYXRoLm1heCgwLCBhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgaW5uZXJXaWR0aCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nTGVmdCArPSByZW1haW5pbmcgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChtb2RlID09PSAnVkVSVElDQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuSGVpZ2h0ID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUuaGVpZ2h0ICogc2NhbGUsIDApO1xyXG4gICAgICAgIGNvbnN0IGlubmVySGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nVG9wIC0gbGF5b3V0LnBhZGRpbmdCb3R0b207XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWSA9IE1hdGgubWF4KDAsIChpbm5lckhlaWdodCAtIGNoaWxkcmVuSGVpZ2h0KSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuSGVpZ2h0ICsgbGF5b3V0LnNwYWNpbmdZICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVySGVpZ2h0IC0gdXNlZCk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKG1vZGUgPT09ICdHUklEJyAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGxheW91dC5jZWxsU2l6ZSA9IG5ldyBTaXplKFxyXG4gICAgICAgICAgICBNYXRoLm1heCguLi5zcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IGNoaWxkLmZyYW1lLndpZHRoKSkgKiBzY2FsZSxcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS5oZWlnaHQpKSAqIHNjYWxlLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5Q291bnRlckFsaWdubWVudChcclxuICAgIHBhcmVudDogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBjb25zdCBhbGlnbm1lbnQgPSBzcGVjLmxheW91dD8uY291bnRlckFsaWduO1xyXG4gICAgaWYgKCFtb2RlIHx8ICFhbGlnbm1lbnQgfHwgIVsnSE9SSVpPTlRBTCcsICdWRVJUSUNBTCddLmluY2x1ZGVzKG1vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFyZW50VHJhbnNmb3JtID0gcGFyZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy53aWR0aCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGxheW91dEhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBjb25zdCByaWdodCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nUmlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHRvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBjb25zdCBib3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkU3BlYyBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGRTcGVjLmZpZ21hSWRdO1xyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gdXVpZCA/IGZpbmRCeVV1aWQocGFyZW50LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gY2hpbGQ/LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgaWYgKCFjaGlsZCB8fCAhdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwb3NpdGlvbiA9IGNoaWxkLnBvc2l0aW9uLmNsb25lKCk7XHJcbiAgICAgICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJykge1xyXG4gICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCgwLCBsYXlvdXRIZWlnaHQgLSB0b3AgLSBib3R0b20pO1xyXG4gICAgICAgICAgICBsZXQgdG9wT2Zmc2V0ID0gdG9wO1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gdG9wICsgKGF2YWlsYWJsZSAtIHRyYW5zZm9ybS5oZWlnaHQpIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChhbGlnbm1lbnQgPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICB0b3BPZmZzZXQgPSBsYXlvdXRIZWlnaHQgLSBib3R0b20gLSB0cmFuc2Zvcm0uaGVpZ2h0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ1NUUkVUQ0gnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRyYW5zZm9ybS53aWR0aCwgYXZhaWxhYmxlKTtcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueSA9IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgICAgICAtIHRvcE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSB0cmFuc2Zvcm0uaGVpZ2h0ICogKDEgLSAodHJhbnNmb3JtLmFuY2hvclBvaW50Py55ID8/IDAuNSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dFdpZHRoIC0gbGVmdCAtIHJpZ2h0KTtcclxuICAgICAgICAgICAgbGV0IGxlZnRPZmZzZXQgPSBsZWZ0O1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxlZnQgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLndpZHRoKSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxheW91dFdpZHRoIC0gcmlnaHQgLSB0cmFuc2Zvcm0ud2lkdGg7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgYXZhaWxhYmxlLCB0cmFuc2Zvcm0uaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueCA9IGxlZnRPZmZzZXRcclxuICAgICAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICAgICAgKyB0cmFuc2Zvcm0ud2lkdGggKiAodHJhbnNmb3JtLmFuY2hvclBvaW50Py54ID8/IDAuNSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNoaWxkLnNldFBvc2l0aW9uKHBvc2l0aW9uKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gbG9nTWFza0RlY2lzaW9uKHNwZWM6IFNjZW5lTm9kZVNwZWMsIHRhcmdldDogTWFza1RhcmdldCA9ICdub2RlJyk6IHZvaWQge1xuICAgIGNvbnNvbGUubG9nKCdbRmlnbWEgSW1wb3J0ZXIgTWFzayDlhrPnrZZdJywgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXG4gICAgICAgIG5vZGVOYW1lOiBzcGVjLm5hbWUsXG4gICAgICAgIHRhcmdldCxcbiAgICAgICAgLi4uc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCksXG4gICAgfSkpO1xufVxuXG5mdW5jdGlvbiBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGU6IGFueSwgY2M6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgdHlwZSBvZiBbY2MuTWFzaywgY2MuR3JhcGhpY3NdKSB7XG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xuICAgICAgICBpZiAoIWNvbXBvbmVudCkgY29udGludWU7XG4gICAgICAgIGlmIChndWFyZCkge1xuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcbiAgICAgICAgfSBlbHNlIGlmICghc2Vzc2lvbk1hc2tDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4iueahCAke3R5cGUubmFtZX0g57y65bCR5a+85YWl5Zmo5b2S5bGe6K6w5b2V77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel57uE5Lu277yb6K+35L2/55So5bim5ZCM5q2l6K6w5b2V55qEIFByZWZhYiDmiJblr7zlhaXkuLrmlrDoioLngrnjgIJgKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuZnVuY3Rpb24gY29uZmlndXJlQ2xpcChcbiAgICBub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnksIHRhcmdldDogTWFza1RhcmdldCA9ICdub2RlJywgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcbik6IHZvaWQge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsIHRhcmdldCk7XG4gICAgaWYgKCFkZWNpc2lvbi5zaG91bGRNYXNrKSByZXR1cm47XG4gICAgaWYgKHRhcmdldCAhPT0gJ25vZGUnKSBsb2dNYXNrRGVjaXNpb24oc3BlYywgdGFyZ2V0KTtcbiAgICBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKG5vZGUsIGNjLCBndWFyZCk7XG4gICAgLy8gUHJvdmlzaW9uIEdyYXBoaWNzIGV2ZW4gZm9yIGluYWN0aXZlIG5vZGVzIHNvIG93bmVyc2hpcCBpcyBjYXB0dXJlZCBub3csXG4gICAgLy8gbm90IGxvc3Qgd2hlbiBNYXNrLm9uTG9hZCBjcmVhdGVzIGl0cyByZW5kZXJlciBvbiBhIGxhdGVyIGFjdGl2YXRpb24uXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xuICAgIHNlc3Npb25NYXNrQ29tcG9uZW50cy5hZGQoZ3JhcGhpY3MpO1xuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xuICAgIC8vIE1hc2sgb3ducyB0aGUgZHJhd2luZzogY2xlYXJpbmcgaGVyZSB3b3VsZCBlcmFzZSBhIHJldXNlZCBtYXNrIHdoZW4gdGhlXG4gICAgLy8gdHlwZSBzdGF5cyB1bmNoYW5nZWQgKGl0cyBwdWJsaWMgc2V0dGVyIGRvZXMgbm90IHJlZHJhdyBpZGVudGljYWwgdHlwZXMpLlxuICAgIGNvbnN0IG1hc2sgPSBub2RlLmdldENvbXBvbmVudChjYy5NYXNrKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5NYXNrKTtcbiAgICBzZXNzaW9uTWFza0NvbXBvbmVudHMuYWRkKG1hc2spO1xuICAgIGNvbnN0IG1hc2tUeXBlID0gZGVjaXNpb24ubWFza1R5cGUgPT09ICdlbGxpcHNlJ1xuICAgICAgICA/IGNjLk1hc2suVHlwZS5HUkFQSElDU19FTExJUFNFID8/IGNjLk1hc2suVHlwZS5FTExJUFNFXG4gICAgICAgIDogY2MuTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gY2MuTWFzay5UeXBlLlJFQ1Q7XG4gICAgc2V0TWFza1NoYXBlU2FmZWx5KG1hc2ssIG1hc2tUeXBlKTtcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBzaG91bGRHZW5lcmF0ZU1hc2soc3BlYykuc2hvdWxkTWFzaztcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc0J1dHRvbkFuY2VzdG9yKG5vZGU6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xuICAgIGZvciAobGV0IHBhcmVudCA9IG5vZGUucGFyZW50OyBwYXJlbnQ7IHBhcmVudCA9IHBhcmVudC5wYXJlbnQpIHtcbiAgICAgICAgaWYgKHBhcmVudC5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcbiAgICAgICAgY29uc3QgYnV0dG9uID0gbm9kZS5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5CdXR0b24pO1xyXG4gICAgICAgIGJ1dHRvbi50YXJnZXQgPSBub2RlO1xyXG4gICAgICAgIGJ1dHRvbi50cmFuc2l0aW9uID0gY2MuQnV0dG9uLlRyYW5zaXRpb24uU0NBTEU7XHJcbiAgICAgICAgYnV0dG9uLnpvb21TY2FsZSA9IDAuOTtcclxuICAgICAgICBidXR0b24uZHVyYXRpb24gPSAwLjE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0cmFuc2Zvcm06IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogYW55IHtcclxuICAgIGlmICghc2hvdWxkR2VuZXJhdGVNYXNrKHNwZWMsICdzY3JvbGwtdmlldycpLnNob3VsZE1hc2spIHtcbiAgICAgICAgcmV0dXJuIG5vZGU7XG4gICAgfVxuICAgIGNvbnN0IHsgTm9kZSwgVUlUcmFuc2Zvcm0sIFNjcm9sbFZpZXcgfSA9IGNjO1xuICAgIGxldCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgbGV0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG51bGw7XHJcbiAgICBpZiAodmlldyAmJiBndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChTY3JvbGxWaWV3KSA/PyBub2RlLmFkZENvbXBvbmVudChTY3JvbGxWaWV3KTtcclxuICAgIGlmICghdmlldykge1xyXG4gICAgICAgIHZpZXcgPSBuZXcgTm9kZSgndmlldycpO1xyXG4gICAgICAgIHZpZXcubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQodmlldyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3VHJhbnNmb3JtID0gdmlldy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IHZpZXcuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh2aWV3VHJhbnNmb3JtLCB0cmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgsIHRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpO1xuICAgIHZpZXcuc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICBjb25maWd1cmVDbGlwKHZpZXcsIHNwZWMsIGNjLCAnc2Nyb2xsLXZpZXcnLCBndWFyZCk7XG4gICAgaWYgKCFjb250ZW50KSB7XHJcbiAgICAgICAgY29udGVudCA9IG5ldyBOb2RlKCdjb250ZW50Jyk7XHJcbiAgICAgICAgY29udGVudC5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdmlldy5hZGRDaGlsZChjb250ZW50KTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRlbnRUcmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gY29udGVudC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcHJldmlvdXNMYXlvdXQgPSBjb250ZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpO1xyXG4gICAgY29uc3QgbmV4dExheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChwcmV2aW91c0xheW91dCAmJiAoIW5leHRMYXlvdXRNb2RlIHx8IG5leHRMYXlvdXRNb2RlID09PSAnTk9ORScpKSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0LCBndWFyZCwgY29udGVudC5uYW1lKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29udGVudC5yZW1vdmVDb21wb25lbnQocHJldmlvdXNMYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgY29udGVudFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIGNvbnRlbnRUcmFuc2Zvcm0sIHNwZWMsIHRyYW5zZm9ybSwgc2NhbGUpO1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kgJiYgbGVnYWN5ICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubGVnYWN5LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIGNvbnRlbnQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGV4cGVjdHMgdGhlIGNvbnRlbnQgTm9kZSBoZXJlLiBTY3JvbGxWaWV3LnZpZXcgaXMgYVxyXG4gICAgLy8gZ2V0dGVyIGRlcml2ZWQgZnJvbSBjb250ZW50LnBhcmVudCBhbmQgbXVzdCBuZXZlciBiZSBhc3NpZ25lZCBkaXJlY3RseS5cclxuICAgIGlmIChzY3JvbGwuY29udGVudCA9PT0gY29udGVudCkge1xyXG4gICAgICAgIHNjcm9sbC5jb250ZW50ID0gbnVsbDtcclxuICAgIH1cclxuICAgIHNjcm9sbC5jb250ZW50ID0gY29udGVudDtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgc2Nyb2xsLmhvcml6b250YWwgPSBheGVzLmhvcml6b250YWw7XHJcbiAgICBzY3JvbGwudmVydGljYWwgPSBheGVzLnZlcnRpY2FsO1xyXG4gICAgcmV0dXJuIGNvbnRlbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNjcm9sbEF4ZXMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHsgaG9yaXpvbnRhbDogYm9vbGVhbjsgdmVydGljYWw6IGJvb2xlYW4gfSB7XHJcbiAgICBjb25zdCBkaXJlY3Rpb24gPSBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICYmIHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gIT09ICdOT05FJ1xyXG4gICAgICAgID8gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbi50cmltKCkudG9VcHBlckNhc2UoKVxyXG4gICAgICAgIDogJ1ZFUlRJQ0FMX1NDUk9MTElORyc7XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTCcgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnQk9USCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IHRydWUgfTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGhvcml6b250YWw6IGZhbHNlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgY29udGVudFRyYW5zZm9ybTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LndpZHRoKSB8fCAwKTtcclxuICAgIGNvbnN0IHZpZXdwb3J0SGVpZ2h0ID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy5oZWlnaHQpIHx8IDApO1xyXG4gICAgY29uc3QgY2hpbGRSaWdodCA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueCAtIHNwZWMuZnJhbWUueCArIGNoaWxkLmZyYW1lLndpZHRoKSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGNoaWxkQm90dG9tID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS55IC0gc3BlYy5mcmFtZS55ICsgY2hpbGQuZnJhbWUuaGVpZ2h0KSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgY29uc3QgY29udGVudFdpZHRoID0gYXhlcy5ob3Jpem9udGFsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydFdpZHRoLCAwLCAuLi5jaGlsZFJpZ2h0KVxyXG4gICAgICAgIDogdmlld3BvcnRXaWR0aDtcclxuICAgIGNvbnN0IGNvbnRlbnRIZWlnaHQgPSBheGVzLnZlcnRpY2FsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydEhlaWdodCwgMCwgLi4uY2hpbGRCb3R0b20pXHJcbiAgICAgICAgOiB2aWV3cG9ydEhlaWdodDtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoY29udGVudFRyYW5zZm9ybSwgY29udGVudFdpZHRoLCBjb250ZW50SGVpZ2h0KTtcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcbiAgICAgICAgKHZpZXdwb3J0SGVpZ2h0IC0gY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpIC8gMixcbiAgICAgICAgMCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycgfHwgY29udGVudCA9PT0gbm9kZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCB0cmFuc2Zvcm0sIHNwZWMsIHZpZXdwb3J0LCBzY2FsZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvdW50U3BlY3Moc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSk6IG51bWJlciB7XHJcbiAgICByZXR1cm4gc3BlY3MucmVkdWNlKCh0b3RhbCwgc3BlYykgPT4gdG90YWwgKyAxICsgY291bnRTcGVjcyhzcGVjLmNoaWxkcmVuKSwgMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNlbnRlckluQ2FudmFzKG5vZGU6IGFueSwgY2FudmFzOiBhbnksIFVJVHJhbnNmb3JtOiBhbnksIFZlYzM6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgbm9kZVRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IGNhbnZhc1RyYW5zZm9ybSA9IGNhbnZhcz8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghbm9kZVRyYW5zZm9ybSB8fCAhY2FudmFzVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2FudmFzU2l6ZSA9IGNhbnZhc1RyYW5zZm9ybS5jb250ZW50U2l6ZSA/PyB7XHJcbiAgICAgICAgd2lkdGg6IGNhbnZhc1RyYW5zZm9ybS53aWR0aCxcclxuICAgICAgICBoZWlnaHQ6IGNhbnZhc1RyYW5zZm9ybS5oZWlnaHQsXHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2lkdGggPSBOdW1iZXIoY2FudmFzU2l6ZT8ud2lkdGgpID4gMCA/IE51bWJlcihjYW52YXNTaXplLndpZHRoKSA6IDY0MDtcclxuICAgIGNvbnN0IGhlaWdodCA9IE51bWJlcihjYW52YXNTaXplPy5oZWlnaHQpID4gMCA/IE51bWJlcihjYW52YXNTaXplLmhlaWdodCkgOiAxMTM2O1xyXG4gICAgY29uc3QgY2FudmFzQW5jaG9yID0gY2FudmFzVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IG5vZGVBbmNob3IgPSBub2RlVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHggPSB3aWR0aCAqICgwLjUgLSBjYW52YXNBbmNob3IueClcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0ud2lkdGggKiAoMC41IC0gbm9kZUFuY2hvci54KTtcclxuICAgIGNvbnN0IHkgPSBoZWlnaHQgKiAoMC41IC0gY2FudmFzQW5jaG9yLnkpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLmhlaWdodCAqICgwLjUgLSBub2RlQW5jaG9yLnkpO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyh4LCB5LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUNvbXBvbmVudHMobm9kZTogYW55KTogYW55W10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5jb21wb25lbnRzID8/IG5vZGU/Ll9jb21wb25lbnRzO1xyXG4gICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUgOiBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVvcmRlckZpZ21hQ2hpbGRyZW4ocGFyZW50OiBhbnksIG9yZGVyZWROb2RlczogYW55W10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGRlc2lyZWQgPSBbLi4ubmV3IFNldChvcmRlcmVkTm9kZXMuZmlsdGVyKEJvb2xlYW4pKV07XHJcbiAgICBpZiAoIWRlc2lyZWQubGVuZ3RoIHx8IHR5cGVvZiBkZXNpcmVkWzBdPy5zZXRTaWJsaW5nSW5kZXggIT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYS1vd25lZCBjaGlsZHJlbiBhcmUga2VwdCBpbiBGaWdtYSBvcmRlci4gVXNlci1hdXRob3JlZCBjaGlsZHJlbiBhcmVcclxuICAgIC8vIG5ldmVyIHJlb3JkZXJlZCBhZ2FpbnN0IG9uZSBhbm90aGVyOyB0aGV5IGZvbGxvdyB0aGUgbWFuYWdlZCBibG9jay5cclxuICAgIGRlc2lyZWQuZm9yRWFjaCgobm9kZSwgaW5kZXgpID0+IG5vZGUuc2V0U2libGluZ0luZGV4KGluZGV4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBwcmV2aW91c05vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcmV0YWluZWROb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290KTtcclxuICAgIGNvbnN0IHN0YWxlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgZmlsZUlkIG9mIHByZXZpb3VzTm9kZUZpbGVJZHMpIHtcclxuICAgICAgICBpZiAoZmlsZUlkID09PSBub2RlUHJlZmFiRmlsZUlkKHByZWZhYlJvb3QpIHx8IHJldGFpbmVkTm9kZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICBzdGFsZS5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZUlkcyA9IG5ldyBTZXQoc3RhbGUua2V5cygpKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZS52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYOW+heWIoOmZpOeahCBGaWdtYSDoioLngrnigJwke25vZGUubmFtZX3igJ3lkKvmnInmiYvlt6Xnu4Tku7bvvIzlt7LlgZzmraLlkIzmraXku6XpmLLmraLmlbDmja7kuKLlpLHjgIJgLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyA9IChjb250YWluZXI6IGFueSwgc3Vydml2b3JQYXJlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgY29uc3QgY2hpbGRGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGNoaWxkKTtcclxuICAgICAgICAgICAgaWYgKGNoaWxkRmlsZUlkXHJcbiAgICAgICAgICAgICAgICAmJiAocHJldmlvdXNOb2RlRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpIHx8IHByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IFtmaWxlSWQsIG5vZGVdIG9mIHN0YWxlKSB7XHJcbiAgICAgICAgbGV0IGFuY2VzdG9yID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgbGV0IG5lc3RlZFVuZGVyU3RhbGUgPSBmYWxzZTtcclxuICAgICAgICB3aGlsZSAoYW5jZXN0b3IgJiYgYW5jZXN0b3IgIT09IHByZWZhYlJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFuY2VzdG9yRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChhbmNlc3Rvcik7XHJcbiAgICAgICAgICAgIGlmIChhbmNlc3RvckZpbGVJZCAmJiBzdGFsZUlkcy5oYXMoYW5jZXN0b3JGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBuZXN0ZWRVbmRlclN0YWxlID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFuY2VzdG9yID0gYW5jZXN0b3IucGFyZW50O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobmVzdGVkVW5kZXJTdGFsZSB8fCAhbm9kZS5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN1cnZpdm9yUGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKG5vZGUsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHN0YWxlLmRlbGV0ZShmaWxlSWQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBwcmV2aW91czogUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT4sXHJcbiAgICBnZW5lcmF0ZWRDbGFzc2VzOiBhbnlbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUge1xyXG4gICAgY29uc3QgcHJldmlvdXNDb21wb25lbnRzID0gbmV3IFNldChwcmV2aW91cy5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyk7XHJcbiAgICBjb25zdCBwcmV2aW91c0hlbHBlcnMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRIZWxwZXJGaWxlSWRzKTtcclxuICAgIGNvbnN0IG5vZGVGaWxlSWRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBjb25zdCBtYW5hZ2VkTm9kZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFwcGVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgY29uc3QgbWFuYWdlZFJ1bnRpbWVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMobm9kZU1hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWQjOatpee7k+aenOe8uuWwkSBGaWdtYSDoioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBub2RlRmlsZUlkc1tmaWdtYUlkXSA9IGZpbGVJZDtcclxuICAgICAgICBtYW5hZ2VkTm9kZXMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZFJ1bnRpbWVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBtYW5hZ2VkQ29tcG9uZW50VHlwZXMgPSBuZXcgU2V0KFtjYy5VSVRyYW5zZm9ybSwgLi4uZ2VuZXJhdGVkQ2xhc3Nlc10pO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG1hbmFnZWRSdW50aW1lTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBpZiAoIW1hbmFnZWRDb21wb25lbnRUeXBlcy5oYXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGlmIChtYXBwZWRVdWlkcy5oYXMobm9kZS51dWlkKSB8fCBub2RlID09PSBwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgaWYgKCFwYXJlbnRcclxuICAgICAgICAgICAgfHwgKCFtYXBwZWRVdWlkcy5oYXMocGFyZW50LnV1aWQpICYmICFtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmhhcyhwYXJlbnQudXVpZCkpXHJcbiAgICAgICAgICAgIHx8ICFpc0dlbmVyYXRlZEhlbHBlck5vZGUobm9kZSwgcGFyZW50LCBjYykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKHByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzSGVscGVycy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtwYXJlbnQubmFtZX3igJ3kuIvlrZjlnKjkuI7lr7zlhaXovoXliqnoioLngrnlkIzlkI3nmoTmiYvlt6XoioLngrnigJwke25vZGUubmFtZX3igJ3vvIzlt7LlgZzmraLlkIzmraXjgIJgLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlcnMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoY29tcG9uZW50RmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG5vZGVGaWxlSWRzLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogWy4uLm1hbmFnZWROb2Rlc10sXHJcbiAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IFsuLi5tYW5hZ2VkQ29tcG9uZW50c10sXHJcbiAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IFsuLi5tYW5hZ2VkSGVscGVyc10sXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoUHJlZmFiTGF5b3V0cyhcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgdmlzaXQgPSAoc3BlYzogU2NlbmVOb2RlU3BlYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW3NwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHV1aWQgPyBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgID8gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpPy5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG5vZGVcclxuICAgICAgICAgICAgOiBub2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgYXBwbHlDb3VudGVyQWxpZ25tZW50KGNoaWxkUGFyZW50LCBzcGVjLCBub2RlTWFwLCBzY2FsZSwgY2MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGRQYXJlbnQgIT09IG5vZGUpIHtcclxuICAgICAgICAgICAgZmluYWxpemVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgIGNoaWxkUGFyZW50LFxyXG4gICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3BlYy5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgIH07XHJcbiAgICBzcGVjcy5mb3JFYWNoKHZpc2l0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQsXHJcbiAgICB2YWx1ZTogbnVtYmVyLFxyXG4gICAgbWVzc2FnZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYXlsb2FkLnBhY2thZ2VOYW1lLCAncHJvZ3Jlc3MnLCB7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZSxcclxuICAgICAgICAgICAgbWVzc2FnZSxcclxuICAgICAgICB9KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIOi/m+W6puWPjemmiOS4jeWPr+eUqOaXtuS4jeW6lOS4reaWreWcuuaZr+WvvOWFpeOAglxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzID0ge1xyXG4gICAgaW5zcGVjdFByZWZhYkNvbnRleHQocGF5bG9hZDoge1xyXG4gICAgICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgICAgICByb290RmlsZUlkPzogc3RyaW5nO1xyXG4gICAgfSk6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkVkaXRpbmdTdGF0ZShwYXlsb2FkLnByZWZhYlV1aWQsIHBheWxvYWQucm9vdEZpbGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydERvY3VtZW50KHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHtcclxuICAgICAgICAgICAgZGlyZWN0b3IsXHJcbiAgICAgICAgICAgIE5vZGUsXHJcbiAgICAgICAgICAgIFVJVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICBDYW52YXMsXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgICAgICBDYW1lcmEsXHJcbiAgICAgICAgfSA9IGNjO1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBpZiAoIXNjZW5lKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmv44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWZhYkNvbnRleHQgPSBwYXlsb2FkLnByZWZhYkNvbnRleHQ7XHJcbiAgICAgICAgbGV0IHByZWZhYlJvb3Q6IGFueSB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcHJlZmFiRWRpdGluZ1N0YXRlKHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCwgcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKTtcclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOWwmuacquWuieWFqOaJk+W8gO+8miR7c3RhdGUucmVhc29uID8/ICfmnKrnn6Xljp/lm6AnfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHByZWZhYlJvb3QgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZS5TY2VuZS5yb290Tm9kZTtcclxuICAgICAgICAgICAgY29uc3QgZmlsZUlkSW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290LCBwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcclxuICAgICAgICAgICAgICAgIF9fcm9vdF9fOiBwcmVmYWJSb290LnV1aWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIGZpbGVJZF0gb2YgT2JqZWN0LmVudHJpZXMocHJlZmFiQ29udGV4dC5leGlzdGluZ05vZGVGaWxlSWRzKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbGVJZEluZGV4LmdldChmaWxlSWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBleGlzdGluZ01hcFtmaWdtYUlkXSA9IG5vZGUudXVpZDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nID0gdHJ1ZTtcclxuICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCA9IGV4aXN0aW5nTWFwO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmNlbnRlckluQ2FudmFzID0gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICAgICAgaWYgKHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgICAgIG5vZGVDb21wb25lbnRzKG5vZGUpLmZvckVhY2goKGNvbXBvbmVudCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cy5hZGQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBwYXlsb2FkLnJvb3RzLm1hcCgocm9vdCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKHJvb3QpKTtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCAmJiByb290cy5sZW5ndGggIT09IDEpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5Y+q5YWB6K645LiA5LiqIEZpZ21hIEZyYW1lIOagueiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmYWxsYmFja1BhcmVudCA9IHByZWZhYlJvb3Q/LnBhcmVudCA/PyBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpID8/IHNjZW5lO1xyXG4gICAgICAgIGNvbnN0IGRpcmVjdFJvb3QgPSByb290cy5sZW5ndGggPT09IDE7XHJcbiAgICAgICAgY29uc3QgY2FudmFzID0gcHJlZmFiUm9vdCA/IG51bGwgOiBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpO1xyXG4gICAgICAgIGNvbnN0IGdlbmVyYXRlZENsYXNzZXMgPSBbXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgIF07XHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgICAgIGxldCBjcmVhdGVkID0gMDtcclxuICAgICAgICBsZXQgdXBkYXRlZCA9IDA7XHJcbiAgICAgICAgY29uc3QgdG90YWxOb2RlcyA9IE1hdGgubWF4KDEsIGNvdW50U3BlY3Mocm9vdHMpKTtcclxuICAgICAgICBsZXQgY29tcGxldGVkTm9kZXMgPSAwO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRDb21wb25lbnRGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRIZWxwZXJzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkSGVscGVyRmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiT3duZXJzaGlwR3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkIHwgdW5kZWZpbmVkID0gcHJlZmFiQ29udGV4dFxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogcHJldmlvdXNNYW5hZ2VkSGVscGVycyxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RVdWlkID0gcGF5bG9hZC51cGRhdGVFeGlzdGluZ1xyXG4gICAgICAgICAgICA/IHBheWxvYWQuZXhpc3RpbmdNYXAuX19yb290X19cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgbGV0IGV4aXN0aW5nUm9vdE5vZGUgPSBleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgZXhpc3RpbmdSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChleGlzdGluZ1Jvb3ROb2RlPy5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBleGlzdGluZ1Jvb3ROb2RlID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gSW4gYSBkaXJlY3Qtcm9vdCBpbXBvcnQsIF9fcm9vdF9fIGFsaWFzZXMgdGhlIEZpZ21hIHJvb3QgVVVJRC4gSW4gYVxyXG4gICAgICAgIC8vIG11bHRpLXJvb3QgaW1wb3J0IGl0IGlkZW50aWZpZXMgYSBzeW50aGV0aWMgd3JhcHBlciBhbmQgbXVzdCBuZXZlciBiZVxyXG4gICAgICAgIC8vIHJldXNlZCBhcyBvbmUgb2YgaXRzIG93biBjaGlsZHJlbiB3aGVuIHRoZSByb290IGNvdW50IGNoYW5nZXMuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290V2FzRGlyZWN0ID0gQm9vbGVhbihleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgICYmIE9iamVjdC5lbnRyaWVzKHBheWxvYWQuZXhpc3RpbmdNYXApLnNvbWUoKFtmaWdtYUlkLCB1dWlkXSkgPT5cclxuICAgICAgICAgICAgICAgIGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgdXVpZCA9PT0gZXhpc3RpbmdSb290VXVpZCkpO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzRGlyZWN0Um9vdCA9IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzV3JhcHBlciA9ICFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBtYXBwZWRSb290VXVpZCA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBleGlzdGluZ1V1aWRGb3JTcGVjKHBheWxvYWQuZXhpc3RpbmdNYXAsIHJvb3RzWzBdKVxyXG4gICAgICAgICAgICA6ICghZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290VXVpZCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgbGV0IGltcG9ydFJvb3QgPSBwcmVmYWJSb290ID8/IChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmIG1hcHBlZFJvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbCk7XHJcbiAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGltcG9ydFJvb3Q/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3QgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBsZWdhY3lXcmFwcGVyID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IHByZXZpb3VzV3JhcHBlciA/PyAoaW1wb3J0Um9vdD8ucGFyZW50Py5uYW1lLnN0YXJ0c1dpdGgoJ0ZpZ21hIMK3ICcpXHJcbiAgICAgICAgICAgICAgICA/IGltcG9ydFJvb3QucGFyZW50XHJcbiAgICAgICAgICAgICAgICA6IG51bGwpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBjb25zdCByZXVzZWRJbXBvcnRSb290ID0gQm9vbGVhbihpbXBvcnRSb290KTtcclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBmYWxsYmFja1BhcmVudDtcclxuICAgICAgICBpZiAoIWRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRSb290KSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoYEZpZ21hIMK3ICR7Y2xlYW5OYW1lKHBheWxvYWQucm9vdE5hbWUpfWApO1xyXG4gICAgICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgICAgICAgICAgY3JlYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290Lm5hbWUgPSBgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YDtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByb290VHJhbnNmb3JtID0gaW1wb3J0Um9vdC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGltcG9ydFJvb3QuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgICAgICAgICAgcm9vdFRyYW5zZm9ybSxcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS53aWR0aCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS5oZWlnaHQgKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpbXBvcnRSb290LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGNsZWFuTmFtZShyb290c1swXS5uYW1lKSk7XHJcbiAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEEgY29sbGFwc2VkIFNjZW5lU3BlYyBjYW4gaW50ZW50aW9uYWxseSBtYXAgc2V2ZXJhbCBGaWdtYSBJRHMgdG8gYVxyXG4gICAgICAgIC8vIHNpbmdsZSBDb2NvcyBub2RlLiBJZiBhIGxhdGVyIGltcG9ydCBleHBhbmRzIHRoYXQgc3VidHJlZSBhZ2FpbixcclxuICAgICAgICAvLyB0aG9zZSBJRHMgc3RpbGwgcG9pbnQgYXQgdGhlIHNhbWUgb2xkIFVVSUQuIENsYWltIGVhY2ggcmV1c2FibGUgbm9kZVxyXG4gICAgICAgIC8vIG9uY2UgcGVyIGJ1aWxkIHNvIGEgY2hpbGQgY2FuIG5ldmVyIHJldXNlIChhbmQgcmVwYXJlbnQpIGl0cyBwYXJlbnQuXHJcbiAgICAgICAgY29uc3QgY2xhaW1lZE5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gYXN5bmMgKFxuICAgICAgICAgICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgICAgICAgICAgbm9kZVBhcmVudDogYW55LFxyXG4gICAgICAgICAgICBwcm92aWRlZE5vZGU/OiBhbnksXHJcbiAgICAgICAgKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICAgICAgICBsb2dNYXNrRGVjaXNpb24oc3BlYyk7XG4gICAgICAgICAgICBsZXQgbm9kZSA9IHByb3ZpZGVkTm9kZSA/PyBudWxsO1xuICAgICAgICAgICAgaWYgKCFub2RlICYmIHBheWxvYWQudXBkYXRlRXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWRVdWlkID0gcGF5bG9hZC5leGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWROb2RlID0gbWFwcGVkVXVpZCA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFwcGVkTm9kZSAmJiAhY2xhaW1lZE5vZGVVdWlkcy5oYXMobWFwcGVkTm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlID0gbWFwcGVkTm9kZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChub2RlICYmIGNsYWltZWROb2RlVXVpZHMuaGFzKG5vZGUudXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0ZWQgPSBCb29sZWFuKG5vZGUpO1xuICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlID0gbmV3IE5vZGUoY2xlYW5OYW1lKHNwZWMubmFtZSkpO1xyXG4gICAgICAgICAgICAgICAgY3JlYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScgJiYgIXByZWZhYk93bmVyc2hpcEd1YXJkKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spIHx8IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYykpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0TWFza0NvbXBvbmVudHNPd25lZChub2RlLCBjYyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIEluY2x1ZGUgZ2VuZXJhdGVkIHZpZXcvdGlsZWQgaGVscGVycyBiZWZvcmUgYW55IGRlbGV0aW9uIG9yXG4gICAgICAgICAgICAgICAgLy8gcmVjb25maWd1cmF0aW9uLiBOZXZlciBpbmZlciBvd25lcnNoaXAgZnJvbSB0aGVpciBuYW1lcyBhbG9uZS5cbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGhlbHBlciBvZiBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT5cbiAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChoZWxwZXIuZ2V0Q29tcG9uZW50KE1hc2spKSBhc3NlcnRNYXNrQ29tcG9uZW50c093bmVkKGhlbHBlciwgY2MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChwcmVmYWJPd25lcnNoaXBHdWFyZCAmJiBleGlzdGVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleGlzdGluZ1RyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1RyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1RyYW5zZm9ybSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uICE9PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgaGVscGVyIG9mIG5vZGUuY2hpbGRyZW4uZmlsdGVyKChjaGlsZDogYW55KSA9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB8fCAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGQubmFtZSA9PT0gJ3ZpZXcnKSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgaGVscGVyLm5hbWUgPT09ICd2aWV3Jykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKCdjb250ZW50Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShjb250ZW50LCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGhlbHBlci5uYW1lID09PSBUSUxFRF9NQVNLX05PREVfTkFNRSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGlsZWRTcHJpdGUgPSBoZWxwZXIuZ2V0Q2hpbGRCeU5hbWU/LihUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZSh0aWxlZFNwcml0ZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChnZW5lcmF0ZWRDbGFzc2VzLmluY2x1ZGVzKGNvbXBvbmVudC5jb25zdHJ1Y3RvcikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNsYWltZWROb2RlVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgIGlmICghKHByZWZhYkNvbnRleHQgJiYgbm9kZSA9PT0gcHJlZmFiUm9vdCkpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUucGFyZW50ID0gbm9kZVBhcmVudDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub2RlLm5hbWUgPSBjbGVhbk5hbWUoc3BlYy5uYW1lKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcFtmaWdtYUlkXSA9IG5vZGUudXVpZDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25maWd1cmVHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcblxyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMobm9kZSwgc3BlYywgY2MsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHByZXNlcnZlZCA9IGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWMsIGNjLCBub2RlKTtcbiAgICAgICAgICAgICAgICAvLyBNYXNrIG93bnMgYW5kIGRpc2FibGVzIGl0cyBzaGFyZWQgR3JhcGhpY3MgZHVyaW5nIHRoZVxyXG4gICAgICAgICAgICAgICAgLy8gZGVmZXJyZWQgb25EaXNhYmxlIHBoYXNlLiBJZiBjbGlwcGluZyB3YXMgcmVtb3ZlZCBidXQgYVxyXG4gICAgICAgICAgICAgICAgLy8gbm9ybWFsIEdyYXBoaWNzIHJlbmRlcmVyIGlzIHN0aWxsIGRlc2lyZWQsIHJlY3JlYXRlIHRoYXRcclxuICAgICAgICAgICAgICAgIC8vIHJlbmRlcmVyIG9ubHkgYWZ0ZXIgdGhlIG9sZCBNYXNrIGxpZmVjeWNsZSBoYXMgY29tcGxldGVkLlxyXG4gICAgICAgICAgICAgICAgaWYgKCFwcmVzZXJ2ZWQuaGFzKE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgbm9kZS5nZXRDb21wb25lbnQoTWFzaylcclxuICAgICAgICAgICAgICAgICAgICAmJiBwcmVzZXJ2ZWQuaGFzKEdyYXBoaWNzKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZC5kZWxldGUoR3JhcGhpY3MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBnZW5lcmF0ZWRDbGFzc2VzLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZCxcclxuICAgICAgICAgICAgICAgICAgICBbR3JhcGhpY3MsIFNwcml0ZSwgTGFiZWwsIFJpY2hUZXh0XSxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0ID8gcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmVtb3ZlZFJlbmRlckNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGlsZWRTcHJpdGVIZWxwZXIgPSB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvdmVyZmxvd1Nwcml0ZUhlbHBlciA9IHVzZXNPdmVyZmxvd1Nwcml0ZUhlbHBlcihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRUaWxlZE5vZGVzKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghb3ZlcmZsb3dTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRPdmVyZmxvd1Zpc3VhbChub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUE5HIOaVtOWxguiKgueCueKAnCR7c3BlYy5uYW1lfeKAneayoeaciee7keWumiBTcHJpdGVGcmFtZe+8jOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAob3ZlcmZsb3dTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlT3ZlcmZsb3dTcHJpdGVIZWxwZXIoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVSaWNoVGV4dChub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMuZm9udFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2MuVFRGRm9udCAmJiAhKGZvbnQgaW5zdGFuY2VvZiBjYy5UVEZGb250KSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBSaWNoVGV4dCDoioLngrnigJwke3NwZWMubmFtZX3igJ3lj6rog73kvb/nlKggVFRGL09URiDlrZfkvZPvvIzlvZPliY3mmKDlsITlj6/og73mmK8gQml0bWFwRm9udO+8iC5mbnTvvInjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gZm9udDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlTGFiZWwobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsYWJlbC5mb250ID0gYXdhaXQgbG9hZEFzc2V0KGNjLmFzc2V0TWFuYWdlciwgc3BlYy5mb250VXVpZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpLmZvbnQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnn6Lph4/oioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIxQTkcg6LWE5rqQ5Y+v6IO95pyq5oiQ5Yqf5a+85YWl44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVDbGlwKG5vZGUsIHNwZWMsIGNjLCAnbm9kZScsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICAgICA/IG5vZGVcclxuICAgICAgICAgICAgICAgIDogY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlTGF5b3V0KGNoaWxkUGFyZW50LCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChjaGlsZCwgY2hpbGRQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW9yZGVyRmlnbWFDaGlsZHJlbihcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGQuZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB1dWlkID8gZmluZEJ5VXVpZChjaGlsZFBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChMYXlvdXQpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKG5vZGUsIHNwZWMsIGNoaWxkUGFyZW50LCB0cmFuc2Zvcm0sIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGVkICYmIHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lICs9ICcgwrcgVHJhbnNmb3JtJztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZWROb2RlcyArPSAxO1xyXG4gICAgICAgICAgICBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgICAgICAgICAgICAgIHBheWxvYWQsXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZWROb2RlcyAvIHRvdGFsTm9kZXMsXHJcbiAgICAgICAgICAgICAgICBg5p6E5bu66IqC54K5ICR7Y29tcGxldGVkTm9kZXN9LyR7dG90YWxOb2Rlc30gwrcgJHtzcGVjLm5hbWV9YCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKHJvb3QsIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LCBkaXJlY3RSb290ID8gaW1wb3J0Um9vdCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCxcclxuICAgICAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNlbnRlckluQ2FudmFzICYmIGNhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNlbnRlckluQ2FudmFzKGltcG9ydFJvb3QsIGNhbnZhcywgVUlUcmFuc2Zvcm0sIGNjLlZlYzMpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFsZVRyYW5zaXRpb25VdWlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKVxyXG4gICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKFtmaWdtYUlkLCB1dWlkXSkgPT4gZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiAhcmV0YWluZWRVdWlkcy5oYXModXVpZCkpXHJcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgoWywgdXVpZF0pID0+IHV1aWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgbGVnYWN5V3JhcHBlciAmJiBsZWdhY3lXcmFwcGVyICE9PSBpbXBvcnRSb290ICYmIGxlZ2FjeVdyYXBwZXIucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShsZWdhY3lXcmFwcGVyLCBwYXJlbnQsIHN0YWxlVHJhbnNpdGlvblV1aWRzLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIHByZXZpb3VzRGlyZWN0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290ICE9PSBpbXBvcnRSb290XHJcbiAgICAgICAgICAgICAgICAmJiAhcmV0YWluZWRVdWlkcy5oYXMocHJldmlvdXNEaXJlY3RSb290LnV1aWQpXHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91c0RpcmVjdFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgc3RhbGVUcmFuc2l0aW9uVXVpZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhpbXBvcnRSb290LCBwYXlsb2FkLmV4aXN0aW5nTWFwLCBub2RlTWFwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICghcmV1c2VkSW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldChPYmplY3QudmFsdWVzKHBheWxvYWQuZXhpc3RpbmdNYXApKSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgcHJlZmFiU3luYzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZE5vZGVGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWumuS9jeWvvOWFpeWQjueahOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMuYWRkKGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIGltcG9ydFJvb3QsIGNjKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBuZXcgU2V0KHByZWZhYkNvbnRleHQubWFuYWdlZE5vZGVGaWxlSWRzKSxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcmV0YWluZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgcmVmcmVzaFByZWZhYkxheW91dHMocm9vdHMsIGltcG9ydFJvb3QsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgcHJlZmFiU3luYyA9IGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0LFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBbVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChub2RlUHJlZmFiRmlsZUlkKGltcG9ydFJvb3QpICE9PSBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5Zyo5ZCM5q2l6L+H56iL5Lit5Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgcm9vdFV1aWQ6IGltcG9ydFJvb3QudXVpZCxcclxuICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgY3JlYXRlZCxcclxuICAgICAgICAgICAgdXBkYXRlZCxcclxuICAgICAgICAgICAgdGVtcG9yYXJ5Um9vdDogIXByZWZhYkNvbnRleHQgJiYgZGlyZWN0Um9vdCAmJiAhcmV1c2VkSW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgcHJlZmFiU3luYyxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxuXHJcbiAgICByZW1vdmVJbXBvcnRlZE5vZGUocGF5bG9hZDogeyByb290VXVpZDogc3RyaW5nIH0pOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBjb25zdCBub2RlID0gc2NlbmUgPyBmaW5kQnlVdWlkKHNjZW5lLCBwYXlsb2FkLnJvb3RVdWlkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gU3RvcCByZW5kZXJpbmcgaW1tZWRpYXRlbHkuIENvY29zIGRlc3Ryb3lzIG5vZGVzIGF0IHRoZSBlbmQgb2YgdGhlXHJcbiAgICAgICAgLy8gZnJhbWUsIHNvIHJlbW92aW5nIHRoZSBwYXJlbnQgYWxvbmUgY2FuIGxlYXZlIGEgb25lLWZyYW1lIGdob3N0LlxyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9LFxyXG59O1xyXG4iXX0=