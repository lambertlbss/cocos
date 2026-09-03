"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const node_name_1 = require("./node-name");
module.paths.push((0, path_1.join)(Editor.App.path, 'node_modules'));
const BACKGROUND_NODE_NAME = '__FigmaBackground';
const TILED_MASK_NODE_NAME = '__FigmaTiledMask';
const TILED_SPRITE_NODE_NAME = '__FigmaTiledSprite';
const OVERFLOW_SPRITE_NODE_NAME = '__FigmaOverflowVisual';
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
function desiredGeneratedComponents(spec, cc) {
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
    if (spec.kind === 'button') {
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
function configureGeometry(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f;
    const { UITransform, Vec3 } = cc;
    const transform = (_a = node.getComponent(UITransform)) !== null && _a !== void 0 ? _a : node.addComponent(UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    const size = (_b = spec.intrinsicSize) !== null && _b !== void 0 ? _b : spec.frame;
    transform.setContentSize(Math.max(0, size.width * scale), Math.max(0, size.height * scale));
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
    var _a;
    const graphics = (_a = node.getComponent(cc.Graphics)) !== null && _a !== void 0 ? _a : node.addComponent(cc.Graphics);
    graphics.enabled = true;
    graphics.clear();
    drawGraphics(graphics, spec, scale, cc);
}
function normalizeLabelText(characters) {
    return (characters !== null && characters !== void 0 ? characters : '')
        .replace(/\r\n/g, '\n')
        .replace(/[\r\u2028\u2029]/g, '\n');
}
function isMultilineLabel(characters) {
    // Cocos Creator 3.8.7 disables automatic wrapping whenever overflow is
    // NONE. Only explicit line feeds can therefore produce real line breaks.
    return characters.includes('\n');
}
function figmaPanelFontSize(value) {
    const fontSize = typeof value === 'number' && Number.isFinite(value) ? value : 16;
    return Math.round((fontSize + Number.EPSILON) * 100) / 100;
}
function configureLabel(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f, _g;
    const { Label } = cc;
    const label = (_a = node.getComponent(Label)) !== null && _a !== void 0 ? _a : node.addComponent(Label);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    const characters = normalizeLabelText(spec.characters);
    const multiline = isMultilineLabel(characters);
    // Figma stores more precision than its panel displays. Match the visible
    // design value (up to two decimals) instead of leaking its internal float.
    label.fontSize = figmaPanelFontSize(style.fontSize);
    label.lineHeight = Math.max(1, ((_d = (_c = style.lineHeightPx) !== null && _c !== void 0 ? _c : style.fontSize) !== null && _d !== void 0 ? _d : 16) * scale);
    label.spacingX = ((_e = style.letterSpacing) !== null && _e !== void 0 ? _e : 0) * scale;
    label.enableWrapText = false;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = multiline
        ? Label.HorizontalAlign.LEFT
        : Label.HorizontalAlign.CENTER;
    label.verticalAlign = multiline
        ? Label.VerticalAlign.TOP
        : Label.VerticalAlign.CENTER;
    label.string = characters;
    label.enableOutline = false;
    label.color = toColor(cc.Color, { r: 1, g: 1, b: 1, a: 1 });
    const fill = visiblePaint(spec.fills);
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        label.color = toColor(cc.Color, fill.color, (_f = fill.opacity) !== null && _f !== void 0 ? _f : 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if ((stroke === null || stroke === void 0 ? void 0 : stroke.color) && spec.strokeWeight > 0) {
        label.enableOutline = true;
        label.outlineColor = toColor(cc.Color, stroke.color, (_g = stroke.opacity) !== null && _g !== void 0 ? _g : 1);
        label.outlineWidth = Math.max(1, spec.strokeWeight * scale);
    }
}
function configureRichText(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f;
    const { RichText } = cc;
    const richText = (_a = node.getComponent(RichText)) !== null && _a !== void 0 ? _a : node.addComponent(RichText);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    richText.string = normalizeLabelText(spec.characters);
    richText.fontSize = figmaPanelFontSize(style.fontSize);
    richText.lineHeight = Math.max(1, ((_d = (_c = style.lineHeightPx) !== null && _c !== void 0 ? _c : style.fontSize) !== null && _d !== void 0 ? _d : 16) * scale);
    richText.maxWidth = Math.max(0, spec.frame.width * scale);
    richText.handleTouchEvent = false;
    // RichText is primarily used for runtime-injected multi-line content. An
    // empty Figma placeholder must therefore keep the same top-left contract
    // after the game assigns its real string.
    richText.horizontalAlign = RichText.HorizontalAlign.LEFT;
    richText.verticalAlign = RichText.VerticalAlign.TOP;
    richText.fontFamily = (_e = style.fontFamily) !== null && _e !== void 0 ? _e : '';
    richText.useSystemFont = !spec.fontUuid;
    const fill = visiblePaint(spec.fills);
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        richText.fontColor = toColor(cc.Color, fill.color, (_f = fill.opacity) !== null && _f !== void 0 ? _f : 1);
    }
}
function finalizeLabelGeometry(node, spec, scale, cc) {
    const transform = node.getComponent(cc.UITransform);
    if (!transform) {
        return;
    }
    const label = node.getComponent(cc.Label);
    const outlineWidth = (label === null || label === void 0 ? void 0 : label.enableOutline)
        ? Math.max(0, Number(label.outlineWidth) || 0)
        : 0;
    const figmaHeight = Math.max(0, spec.frame.height * scale);
    const fontSize = Math.max(0, Number(label === null || label === void 0 ? void 0 : label.fontSize) || 0);
    const finalHeight = Math.max(figmaHeight, fontSize) + outlineWidth * 2;
    // Keep the imported Figma box unless a deterministic outline/font lower
    // bound requires expansion. Expand symmetrically around the center anchor
    // so the node's imported center position remains unchanged.
    // The base box must at least contain the final Cocos font size. When an
    // outline is enabled, reserve one actual Cocos outline width on every side.
    transform.setContentSize(Math.max(0, spec.frame.width * scale + outlineWidth * 2), finalHeight);
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
    sprite.type = spec.sprite.tiled
        ? Sprite.Type.TILED
        : spec.sprite.sliced
            ? Sprite.Type.SLICED
            : Sprite.Type.SIMPLE;
    if (!spec.sprite.sliced && !spec.sprite.tiled) {
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
                transform === null || transform === void 0 ? void 0 : transform.setContentSize(trimmedWidth * scaleX, trimmedHeight * scaleY);
                return;
            }
        }
    }
    // Sliced/tiled sprites and sprites resized in Figma must retain the design
    // size. Cocos represents that state as CUSTOM.
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    transform === null || transform === void 0 ? void 0 : transform.setContentSize(targetWidth, targetHeight);
}
function requiresTiledMask(spec) {
    var _a;
    return Boolean(((_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.tiled) && spec.figmaType === 'ELLIPSE');
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
    transform.setContentSize(Math.max(0, renderFrame.width * scale), Math.max(0, renderFrame.height * scale));
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
        maskTransform.setContentSize(Math.max(0, spec.frame.width * scale), Math.max(0, spec.frame.height * scale));
        tiledMask.setPosition(new cc.Vec3(0, 0, 0));
        tiledMask.setRotationFromEuler(0, 0, 0);
        tiledMask.setScale(new cc.Vec3(1, 1, 1));
        configureClip(tiledMask, spec, cc);
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
    transform.setContentSize(Math.max(0, spec.frame.width * scale / tileScale), Math.max(0, spec.frame.height * scale / tileScale));
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
                    transform.setContentSize(transform.width, available);
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
                    transform.setContentSize(available, transform.height);
                }
            }
            position.x = leftOffset
                - parentWidth * parentAnchor.x
                + transform.width * ((_j = (_h = transform.anchorPoint) === null || _h === void 0 ? void 0 : _h.x) !== null && _j !== void 0 ? _j : 0.5);
        }
        child.setPosition(position);
    }
}
function configureClip(node, spec, cc) {
    var _a, _b, _c;
    const graphics = node.getComponent(cc.Graphics);
    if (graphics) {
        graphics.enabled = true;
        graphics.clear();
    }
    const mask = (_a = node.getComponent(cc.Mask)) !== null && _a !== void 0 ? _a : node.addComponent(cc.Mask);
    mask.type = spec.figmaType === 'ELLIPSE'
        ? (_b = cc.Mask.Type.GRAPHICS_ELLIPSE) !== null && _b !== void 0 ? _b : cc.Mask.Type.ELLIPSE
        : (_c = cc.Mask.Type.GRAPHICS_RECT) !== null && _c !== void 0 ? _c : cc.Mask.Type.RECT;
    mask.inverted = false;
}
function clipsGeneratedChildren(spec) {
    return spec.clipsContent
        && spec.kind !== 'scrollView'
        && spec.children.length > 0
        && spec.action === 'generate';
}
function configureButton(node, spec, cc) {
    var _a;
    if (spec.kind === 'button') {
        const button = (_a = node.getComponent(cc.Button)) !== null && _a !== void 0 ? _a : node.addComponent(cc.Button);
        button.target = node;
        button.transition = cc.Button.Transition.SCALE;
        button.zoomScale = 0.9;
        button.duration = 0.1;
    }
}
function configureScroll(node, spec, transform, scale, cc, guard) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (spec.kind !== 'scrollView') {
        return node;
    }
    const { Node, UITransform, Mask, ScrollView } = cc;
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
    viewTransform.setContentSize(transform.contentSize.width, transform.contentSize.height);
    view.setPosition(0, 0, 0);
    const mask = (_d = view.getComponent(Mask)) !== null && _d !== void 0 ? _d : view.addComponent(Mask);
    mask.type = (_e = Mask.Type.GRAPHICS_RECT) !== null && _e !== void 0 ? _e : Mask.Type.RECT;
    if (!content) {
        content = new Node('content');
        content.layer = node.layer;
        view.addChild(content);
    }
    const contentTransform = (_f = content.getComponent(UITransform)) !== null && _f !== void 0 ? _f : content.addComponent(UITransform);
    const previousLayout = content.getComponent(cc.Layout);
    const nextLayoutMode = (_g = spec.layout) === null || _g === void 0 ? void 0 : _g.mode;
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
    contentTransform.setContentSize(contentWidth, contentHeight);
    // Both helpers use Cocos' default center anchor. Move an oversized content
    // node so its top-left still coincides with the viewport's top-left.
    content.setPosition((contentWidth - viewportWidth) / 2, (viewportHeight - contentHeight) / 2, 0);
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
            rootTransform.setContentSize(payload.rootFrame.width * payload.scale, payload.rootFrame.height * payload.scale);
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
                const preserved = desiredGeneratedComponents(spec, cc);
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
                    finalizeLabelGeometry(node, spec, payload.scale, cc);
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
                    finalizeLabelGeometry(node, spec, payload.scale, cc);
                }
                else if (RASTER_VECTOR_TYPES.has(spec.figmaType)) {
                    throw new Error(`矢量节点“${spec.name}”没有绑定 SpriteFrame，PNG 资源可能未成功导入。`);
                }
                else if (clipsChildren) {
                    configureClip(node, spec, cc);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBaXFEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBbnFEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFFL0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQXlCekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSx5QkFBeUIsR0FBRyx1QkFBdUIsQ0FBQztBQUMxRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ2hDLFFBQVE7SUFDUixtQkFBbUI7SUFDbkIsTUFBTTtJQUNOLE1BQU07SUFDTixpQkFBaUI7Q0FDcEIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxTQUFTLENBQUMsS0FBYTs7SUFDNUIsT0FBTyxNQUFBLElBQUEsNEJBQWdCLEVBQUMsS0FBSyxDQUFDLG1DQUFJLFlBQVksQ0FBQztBQUNuRCxDQUFDO0FBRUQsU0FBUyxPQUFPLENBQUMsS0FBVSxFQUFFLEtBQTZCLEVBQUUsT0FBTyxHQUFHLENBQUM7O0lBQ25FLE1BQU0sTUFBTSxHQUFHLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQ25ELE9BQU8sSUFBSSxLQUFLLENBQ1osSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJ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LENBQUM7WUFDM0QsQ0FBQztRQUNMLENBQUM7UUFDRCxPQUFPO1lBQ0gsUUFBUSxFQUFFLFVBQVUsQ0FBQyxJQUFJO1lBQ3pCLE9BQU87WUFDUCxPQUFPO1lBQ1AsT0FBTztZQUNQLGFBQWEsRUFBRSxDQUFDLGFBQWEsSUFBSSxVQUFVLElBQUksQ0FBQyxnQkFBZ0I7WUFDaEUsVUFBVTtTQUNiLENBQUM7SUFDTixDQUFDO0lBRUQsa0JBQWtCLENBQUMsT0FBNkI7UUFDNUMsTUFBTSxFQUFFLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBUSxDQUFDO1FBQ2hDLE1BQU0sS0FBSyxHQUFHLEVBQUUsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDckMsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ2hFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sS0FBSyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxxRUFBcUU7UUFDckUsbUVBQW1FO1FBQ25FLElBQUksQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO1FBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge1xyXG4gICAgaXNUZXJtaW5hbEFjdGlvbixcclxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXHJcbiAgICBub3JtYWxpemVJbXBvcnRBY3Rpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEZpZ21hQ29sb3IsXHJcbiAgICBGaWdtYVBhaW50LFxyXG4gICAgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBSZWN0LFxyXG4gICAgU2NlbmVOb2RlU3BlYyxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuXHJcbm1vZHVsZS5wYXRocy5wdXNoKGpvaW4oRWRpdG9yLkFwcC5wYXRoLCAnbm9kZV9tb2R1bGVzJykpO1xyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG59XHJcblxyXG5jb25zdCBCQUNLR1JPVU5EX05PREVfTkFNRSA9ICdfX0ZpZ21hQmFja2dyb3VuZCc7XHJcbmNvbnN0IFRJTEVEX01BU0tfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZE1hc2snO1xyXG5jb25zdCBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZFNwcml0ZSc7XHJcbmNvbnN0IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUgPSAnX19GaWdtYU92ZXJmbG93VmlzdWFsJztcclxuY29uc3QgUkFTVEVSX1ZFQ1RPUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ1ZFQ1RPUicsXHJcbiAgICAnQk9PTEVBTl9PUEVSQVRJT04nLFxyXG4gICAgJ1NUQVInLFxyXG4gICAgJ0xJTkUnLFxyXG4gICAgJ1JFR1VMQVJfUE9MWUdPTicsXHJcbl0pO1xyXG5cclxuZnVuY3Rpb24gY2xlYW5OYW1lKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNhbml0aXplTm9kZU5hbWUoaW5wdXQpID8/ICdGaWdtYSBOb2RlJztcclxufVxyXG5cclxuZnVuY3Rpb24gdG9Db2xvcihDb2xvcjogYW55LCB2YWx1ZTogRmlnbWFDb2xvciB8IHVuZGVmaW5lZCwgb3BhY2l0eSA9IDEpOiBhbnkge1xyXG4gICAgY29uc3Qgc291cmNlID0gdmFsdWUgPz8geyByOiAwLCBnOiAwLCBiOiAwLCBhOiAxIH07XHJcbiAgICByZXR1cm4gbmV3IENvbG9yKFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLnIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UuZykpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5iKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgKHNvdXJjZS5hID8/IDEpICogb3BhY2l0eSkpICogMjU1KSxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRCeVV1aWQocm9vdDogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkgfCBudWxsIHtcclxuICAgIGlmIChyb290LnV1aWQgPT09IHV1aWQpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZEJ5VXVpZChjaGlsZCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKGZvdW5kKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZVByZWZhYkZpbGVJZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQ6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGNvbXBvbmVudD8uX19wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2Fsa05vZGVzKHJvb3Q6IGFueSwgdmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIHZpc2l0KHJvb3QpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuID8/IFtdKSB7XHJcbiAgICAgICAgd2Fsa05vZGVzKGNoaWxkLCB2aXNpdCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkFzc2V0VXVpZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgYXNzZXQgPSBub2RlPy5fcHJlZmFiPy5hc3NldDtcclxuICAgIGNvbnN0IHZhbHVlID0gYXNzZXQ/Ll91dWlkID8/IGFzc2V0Py51dWlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJGaWxlSWRJbmRleChyb290OiBhbnksIGV4cGVjdGVkUHJlZmFiVXVpZD86IHN0cmluZyk6IE1hcDxzdHJpbmcsIGFueT4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIHdhbGtOb2Rlcyhyb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHByZWZhYlJvb3QgPSBub2RlPy5fcHJlZmFiPy5yb290O1xyXG4gICAgICAgIGlmIChub2RlICE9PSByb290ICYmIHByZWZhYlJvb3QgJiYgcHJlZmFiUm9vdCAhPT0gcm9vdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFzc2V0VXVpZCA9IHByZWZhYkFzc2V0VXVpZChub2RlKTtcclxuICAgICAgICBpZiAoZXhwZWN0ZWRQcmVmYWJVdWlkICYmIGFzc2V0VXVpZCAmJiBhc3NldFV1aWQgIT09IGV4cGVjdGVkUHJlZmFiVXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKCFmaWxlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocmVzdWx0LmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjeiKgueCuSBmaWxlSWTvvJoke2ZpbGVJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0LnNldChmaWxlSWQsIG5vZGUpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGUuY29tcG9uZW50cyA/PyBub2RlLl9jb21wb25lbnRzID8/IFtdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjee7hOS7tiBmaWxlSWTvvJoke2NvbXBvbmVudEZpbGVJZH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wb25lbnRGaWxlSWRzLmFkZChjb21wb25lbnRGaWxlSWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRWRpdGluZ1N0YXRlKFxyXG4gICAgZXhwZWN0ZWRVdWlkOiBzdHJpbmcsXHJcbiAgICBleHBlY3RlZFJvb3RGaWxlSWQ/OiBzdHJpbmcsXHJcbik6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNvbnN0IG1vZGUgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5TW9kZT8uKCkgPz8gJycpO1xyXG4gICAgY29uc3QgY3VycmVudFV1aWQgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5Q3VycmVudFNjZW5lVXVpZD8uKCkgPz8gJycpO1xyXG4gICAgY29uc3Qgcm9vdCA9IGNjZUFwaT8uU2NlbmU/LnJvb3ROb2RlID8/IG51bGw7XHJcbiAgICBjb25zdCByb290RmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChyb290KTtcclxuICAgIGxldCByZWFzb24gPSAnJztcclxuICAgIGlmIChtb2RlICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3nvJbovpHmqKHlvI/kuLogJHttb2RlIHx8ICd1bmtub3duJ33vvIzlsJrmnKrov5vlhaUgUHJlZmFiYDtcclxuICAgIH0gZWxzZSBpZiAoY3VycmVudFV1aWQgIT09IGV4cGVjdGVkVXVpZCkge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3otYTmupAgVVVJRCDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtGA7XHJcbiAgICB9IGVsc2UgaWYgKCFyb290KSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrnlsJrmnKrlsLHnu6onO1xyXG4gICAgfSBlbHNlIGlmIChleHBlY3RlZFJvb3RGaWxlSWQgJiYgcm9vdEZpbGVJZCAhPT0gZXhwZWN0ZWRSb290RmlsZUlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOS4juadpea6kOiusOW9leS4jeS4gOiHtCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHJlYWR5OiAhcmVhc29uLFxyXG4gICAgICAgIG1vZGUsXHJcbiAgICAgICAgY3VycmVudFV1aWQsXHJcbiAgICAgICAgcm9vdFV1aWQ6IHJvb3Q/LnV1aWQsXHJcbiAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICByZWFzb246IHJlYXNvbiB8fCB1bmRlZmluZWQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gKGdsb2JhbFRoaXMgYXMgYW55KS5FZGl0b3I/LlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgaWYgKHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIGdlbmVyYXRlZDtcclxuICAgIH1cclxuICAgIC8vIFVuaXQtdGVzdC9oZWFkbGVzcyBmYWxsYmFjay4gVGhlIHJlYWwgQ3JlYXRvciBzY2VuZSBwcm9jZXNzIGFsd2F5cyB1c2VzXHJcbiAgICAvLyBFZGl0b3IuVXRpbHMuVVVJRC5nZW5lcmF0ZSh0cnVlKSwgc28gcHJvZHVjdGlvbiBJRHMgZm9sbG93IENyZWF0b3IncyBvd24gZm9ybWF0LlxyXG4gICAgcmV0dXJuIGBmaWdtYSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxNCl9YDtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZTogYW55LCBwcmVmYWJSb290OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY2NlQXBpPy5QcmVmYWI/Lm9uQWRkTm9kZT8uKG5vZGUpO1xyXG4gICAgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgUHJlZmFiSW5mbyA9IGNjLlByZWZhYj8uX3V0aWxzPy5QcmVmYWJJbmZvID8/IGNjLlByZWZhYkluZm87XHJcbiAgICBpZiAoIVByZWZhYkluZm8pIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIDMuOC43IFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOiKgueCueeUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5yb290ID0gcHJlZmFiUm9vdDtcclxuICAgIGluZm8uYXNzZXQgPSBwcmVmYWJSb290Py5fcHJlZmFiPy5hc3NldCA/PyBudWxsO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgaW5mby5pbnN0YW5jZSA9IG51bGw7XHJcbiAgICBpbmZvLnRhcmdldE92ZXJyaWRlcyA9IG51bGw7XHJcbiAgICBub2RlLl9wcmVmYWIgPSBpbmZvO1xyXG4gICAgcmV0dXJuIGluZm8uZmlsZUlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudDogYW55LCBjYzogYW55KTogc3RyaW5nIHtcclxuICAgIGxldCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGRDb21wb25lbnQ/Lihjb21wb25lbnQpO1xyXG4gICAgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IENvbXBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LkNvbXBQcmVmYWJJbmZvID8/IGNjLkNvbXBQcmVmYWJJbmZvO1xyXG4gICAgaWYgKCFDb21wUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgQ29tcFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOe7hOS7tueUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgQ29tcFByZWZhYkluZm8oKTtcclxuICAgIGluZm8uZmlsZUlkID0gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTtcclxuICAgIGNvbXBvbmVudC5fX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldFBhcmVudEtlZXBpbmdXb3JsZChub2RlOiBhbnksIHBhcmVudDogYW55KTogdm9pZCB7XHJcbiAgICBpZiAodHlwZW9mIG5vZGUuc2V0UGFyZW50ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgbm9kZS5zZXRQYXJlbnQocGFyZW50LCB0cnVlKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgbm9kZS5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZDogYW55LCBwYXJlbnQ6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKGNoaWxkLm5hbWUgPT09IEJBQ0tHUk9VTkRfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09ICdfX0ZpZ21hQ29udGVudCcpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmIChjaGlsZC5uYW1lID09PSAndmlldycgJiYgcGFyZW50LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2hpbGQubmFtZSA9PT0gJ2NvbnRlbnQnXHJcbiAgICAgICAgJiYgcGFyZW50Lm5hbWUgPT09ICd2aWV3J1xyXG4gICAgICAgICYmIHBhcmVudC5wYXJlbnQ/LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBzdGFsZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDE7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChzdGFsZVV1aWRzLmhhcyhjaGlsZC51dWlkKSB8fCBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKSkge1xyXG4gICAgICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc3Vydml2b3JQYXJlbnQpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplU2NlbmVTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBTY2VuZU5vZGVTcGVjIHtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzcGVjLmFjdGlvbiBhcyB1bmtub3duKTtcclxuICAgIGNvbnN0IGtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHNwZWMua2luZCwgYWN0aW9uKTtcclxuICAgIGNvbnN0IGNoaWxkcmVuID0gQXJyYXkuaXNBcnJheShzcGVjLmNoaWxkcmVuKSA/IHNwZWMuY2hpbGRyZW4gOiBbXTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uc3BlYyxcclxuICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBjaGlsZHJlbjogaXNUZXJtaW5hbEFjdGlvbihhY3Rpb24pIHx8IHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSB0cnVlXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBjaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBub3JtYWxpemVTY2VuZVNwZWMoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgaWRzID0gW3NwZWMuZmlnbWFJZCwgLi4uKHNwZWMuYWxpYXNGaWdtYUlkcyA/PyBbXSldXHJcbiAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwICYmIGlkICE9PSAnX19yb290X18nKTtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChpZHMpXTtcclxufVxyXG5cclxuZnVuY3Rpb24gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBmaWdtYUlkc0ZvclNwZWMoc3BlYykuZmlsdGVyKChmaWdtYUlkKSA9PiBmaWdtYUlkICE9PSBzcGVjLmZpZ21hSWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGlzdGluZ1V1aWRGb3JTcGVjKFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBleGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIGlmICh0eXBlb2Ygc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09ICdib29sZWFuJykge1xyXG4gICAgICAgIHJldHVybiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeTtcclxuICAgIH1cclxuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIFNjZW5lU3BlY3MgcGVyc2lzdGVkIGJ5IGltcG9ydGVyIHZlcnNpb25zXHJcbiAgICAvLyBiZWZvcmUgZmxhdHRlbkJvdW5kYXJ5IHdhcyBpbnRyb2R1Y2VkLiBOZXcgcGxhbnMgYWx3YXlzIHNldCB0aGUgZmxhZyBzb1xyXG4gICAgLy8gZm9sZGVkIExhYmVscyBhbmQgb3RoZXIgcHJvbW90ZWQgdmlzdWFscyB1c2UgdGhlIHNhbWUgY2xlYW51cCBzZW1hbnRpY3MuXHJcbiAgICByZXR1cm4gc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInXHJcbiAgICAgICAgfHwgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIEJvb2xlYW4oc3BlYy5zcHJpdGUpICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID09PSAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlQ29sbGFwc2VkTWFwcGVkRGVzY2VuZGFudHMoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMoY3VycmVudE1hcCkpO1xyXG4gICAgY29uc3QgYm91bmRhcnlTcGVjczogQXJyYXk8e1xyXG4gICAgICAgIGZpZ21hSWQ6IHN0cmluZztcclxuICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGJvb2xlYW47XHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogU2V0PHN0cmluZz47XHJcbiAgICB9PiA9IFtdO1xyXG4gICAgY29uc3QgY29sbGVjdEJvdW5kYXJpZXMgPSAobm9kZXM6IFNjZW5lTm9kZVNwZWNbXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAoZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYWxpYXNGaWdtYUlkcyA9IGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWMpO1xyXG4gICAgICAgICAgICBpZiAoYWxpYXNGaWdtYUlkcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldChhbGlhc0ZpZ21hSWRzKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWMuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjcyk7XHJcbiAgICBjb25zdCBib3VuZGFyaWVzID0gYm91bmRhcnlTcGVjc1xyXG4gICAgICAgIC5tYXAoKGJvdW5kYXJ5KSA9PiAoe1xyXG4gICAgICAgICAgICAuLi5ib3VuZGFyeSxcclxuICAgICAgICAgICAgbm9kZTogY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXVxyXG4gICAgICAgICAgICAgICAgPyBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF0pXHJcbiAgICAgICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgfSkpXHJcbiAgICAgICAgLmZpbHRlcigoYm91bmRhcnkpOiBib3VuZGFyeSBpcyB0eXBlb2YgYm91bmRhcnkgJiB7IG5vZGU6IGFueSB9ID0+IEJvb2xlYW4oYm91bmRhcnkubm9kZSkpO1xyXG4gICAgaWYgKCFib3VuZGFyaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCByZXRhaW5lZFV1aWRzLmhhcyh1dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBib3VuZGFyeSBvZiBib3VuZGFyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmICghYm91bmRhcnkucmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzXHJcbiAgICAgICAgICAgICAgICAmJiAhYm91bmRhcnkuYWxpYXNGaWdtYUlkcy5oYXMoZmlnbWFJZCkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGJvdW5kYXJ5Lm5vZGUsIHV1aWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSAmJiBub2RlICE9PSBib3VuZGFyeS5ub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGFsZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YWxlTm9kZXMuc2l6ZSkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVVdWlkcyA9IG5ldyBTZXQoc3RhbGVOb2Rlcy5rZXlzKCkpO1xyXG4gICAgbGV0IHJlbW92ZWQgPSAwO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBpZiAoIW5vZGUucGFyZW50IHx8IHN0YWxlVXVpZHMuaGFzKG5vZGUucGFyZW50LnV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKG5vZGUsIG5vZGUucGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCBjdXJyZW50TWFwW2ZpZ21hSWRdKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmluZEJ5VXVpZChpbXBvcnRSb290LCB1dWlkKSkge1xyXG4gICAgICAgICAgICBjdXJyZW50TWFwW2ZpZ21hSWRdID0gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgY29udGFpbmVyOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgZXhpc3RpbmdVdWlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChleGlzdGluZ1V1aWRzLmhhcyhjaGlsZC51dWlkKSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhjaGlsZCwgc3Vydml2b3JQYXJlbnQsIGV4aXN0aW5nVXVpZHMpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluZENhbnZhcyhyb290OiBhbnksIENhbnZhczogYW55KTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC5nZXRDb21wb25lbnQoQ2FudmFzKSkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQ2FudmFzKGNoaWxkLCBDYW52YXMpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBjbGFzc2VzOiBhbnlbXSxcclxuICAgIHByZXNlcnZlZDogU2V0PGFueT4sXHJcbiAgICByZW5kZXJDbGFzc2VzOiBhbnlbXSxcclxuICAgIHJlbW92YWJsZUZpbGVJZHM/OiBTZXQ8c3RyaW5nPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IGZhbHNlO1xyXG4gICAgZm9yIChjb25zdCB0eXBlIG9mIGNsYXNzZXMpIHtcclxuICAgICAgICBpZiAocHJlc2VydmVkLmhhcyh0eXBlKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gbm9kZS5nZXRDb21wb25lbnQodHlwZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICBpZiAocmVtb3ZhYmxlRmlsZUlkcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWZpbGVJZCB8fCAhcmVtb3ZhYmxlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoTmuLLmn5Pnu4Tku7bkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel5YaF5a6544CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KGNvbXBvbmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWRSZW5kZXJDb21wb25lbnQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGU6IGFueSwgY2M6IGFueSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgb3V0bGluZSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkxhYmVsT3V0bGluZSk7XHJcbiAgICBpZiAoIW91dGxpbmUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBMYWJlbE91dGxpbmUgd2FzIHVzZWQgYnkgb2xkZXIgaW1wb3J0ZXIgdmVyc2lvbnMuIENvY29zIGRlc3Ryb3lzXHJcbiAgICAvLyBjb21wb25lbnRzIGF0IHRoZSBlbmQgb2YgdGhlIGZyYW1lIGFuZCBpdHMgb25EaXNhYmxlKCkgd3JpdGVzIGJhY2sgdG9cclxuICAgIC8vIExhYmVsLmVuYWJsZU91dGxpbmUsIHNvIGxldCB0aGF0IGxpZmVjeWNsZSBmaW5pc2ggYmVmb3JlIGVpdGhlclxyXG4gICAgLy8gcmVjb25maWd1cmluZyBvciByZW1vdmluZyB0aGUgTGFiZWwgY29tcG9uZW50LlxyXG4gICAgbm9kZS5yZW1vdmVDb21wb25lbnQob3V0bGluZSk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiBTZXQ8YW55PiB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICBpZiAoIXVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKSAmJiAhdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWMpKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLlNwcml0ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5SaWNoVGV4dCk7XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuTGFiZWwpO1xyXG4gICAgfSBlbHNlIGlmICghUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpIHx8IGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuR3JhcGhpY3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5NYXNrKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIGxheW91dE1vZGVcclxuICAgICAgICAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkJ1dHRvbik7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5IDwgMC45OTkpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5VSU9wYWNpdHkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlc2lyZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMCkpO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiT3duZXJzaGlwR3VhcmQge1xyXG4gICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ05vZGVVdWlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IFNldDxhbnk+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc093bmVkSGVscGVyTm9kZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIHJldHVybiAhZ3VhcmQucHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICB8fCBCb29sZWFuKGZpbGVJZCAmJiBndWFyZC5wcmV2aW91c0hlbHBlckZpbGVJZHMuaGFzKGZpbGVJZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgIGNvbXBvbmVudDogYW55LFxyXG4gICAgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgb3duZXJOYW1lOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKCFjb21wb25lbnQgfHwgIWd1YXJkLnByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKCFmaWxlSWQgfHwgIWd1YXJkLnByZXZpb3VzQ29tcG9uZW50RmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYOiKgueCueKAnCR7b3duZXJOYW1lfeKAneS4iueahCAke2NvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSA/PyAnQ29tcG9uZW50J30g5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBpZiAoIWlzT3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6L6F5Yqp6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmApO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChjb21wb25lbnQsIGd1YXJkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShub2RlLCBndWFyZCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICBpZiAoaXNPd25lZEhlbHBlck5vZGUoY2hpbGQsIGd1YXJkKSkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoY2hpbGQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoXHJcbiAgICBoZWxwZXI6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlbW92ZSA9IChub2RlOiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBpZiAoZ3VhcmQgJiYgaXNPd25lZEhlbHBlck5vZGUoY2hpbGQsIGd1YXJkKSkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlKGNoaWxkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3IpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgfTtcclxuICAgIHJlbW92ZShoZWxwZXIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgYmFja2dyb3VuZCA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoQkFDS0dST1VORF9OT0RFX05BTUUpO1xyXG4gICAgaWYgKCFiYWNrZ3JvdW5kKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShiYWNrZ3JvdW5kLCBub2RlLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lHZW5lcmF0ZWRUaWxlZFNwcml0ZShcclxuICAgIHRpbGVkU3ByaXRlOiBhbnksXHJcbiAgICBzdXJ2aXZvcjogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkU3ByaXRlLCBzdXJ2aXZvciwgZ3VhcmQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRUaWxlZE5vZGVzKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgdGlsZWRNYXNrID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRpbGVkU3ByaXRlID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgIGRlc3Ryb3lHZW5lcmF0ZWRUaWxlZFNwcml0ZSh0aWxlZFNwcml0ZSwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRPdmVyZmxvd1Zpc3VhbChub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IGhlbHBlciA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoaGVscGVyKSB7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlT2Jzb2xldGVTY3JvbGxIZWxwZXJzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIEEgZmxhdHRlbmVkIG5vZGUgaGFzIG5vIG5ldyBjaGlsZCBzcGVjcyBieSBkZXNpZ24uIEtlZXAgZXZlcnkgZXhpc3RpbmdcclxuICAgIC8vIGNoaWxkIGFsaXZlIHVudGlsIHJlbW92ZUZsYXR0ZW5lZE1hcHBlZERlc2NlbmRhbnRzIGNhbiBkaXN0aW5ndWlzaCBvbGRcclxuICAgIC8vIEZpZ21hLW1hcHBlZCBub2RlcyBmcm9tIHVzZXItYXV0aG9yZWQgbm9kZXMuIE90aGVyd2lzZSBkZXN0cm95aW5nIHRoZVxyXG4gICAgLy8gaGVscGVyIHdvdWxkIHJlY3Vyc2l2ZWx5IGRlc3Ryb3kgbWFudWFsIGNoaWxkcmVuIGF0IENvY29zJyBkZWZlcnJlZFxyXG4gICAgLy8gZGVzdHJ1Y3Rpb24gYm91bmRhcnkuXHJcbiAgICBjb25zdCBwcmVzZXJ2ZUNoaWxkcmVuID0gc3BlYy5jaGlsZHJlbi5sZW5ndGggPiAwIHx8IGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYyk7XHJcbiAgICBjb25zdCBtb3ZlQ2hpbGRyZW5Ub05vZGUgPSAoY29udGFpbmVyOiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGd1YXJkIHx8IHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGxlZ2FjeSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxlZ2FjeS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbGVnYWN5LmRlc3Ryb3koKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjcm9sbCA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlNjcm9sbFZpZXcpO1xyXG4gICAgY29uc3QgdmlldyA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKTtcclxuICAgIGNvbnN0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpO1xyXG4gICAgaWYgKCFzY3JvbGwgfHwgIXZpZXcgfHwgIWNvbnRlbnRcclxuICAgICAgICB8fCAoc2Nyb2xsLmNvbnRlbnQgIT09IGNvbnRlbnQgJiYgc2Nyb2xsLmNvbnRlbnQgIT0gbnVsbCkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodmlldywgZ3VhcmQpO1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodmlldywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChwcmVzZXJ2ZUNoaWxkcmVuKSB7XHJcbiAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGNvbnRlbnQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnZpZXcuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZCAhPT0gY29udGVudCkge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnRlbnQucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgY29udGVudC5kZXN0cm95KCk7XHJcbiAgICB2aWV3LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIHZpZXcuZGVzdHJveSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZVBvc2l0aW9uKFxyXG4gICAgZnJhbWU6IFJlY3QsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbiAgICBjaGlsZFRyYW5zZm9ybT86IGFueSxcclxuKTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHtcclxuICAgIGlmICghcGFyZW50RnJhbWUpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMCwgeTogMSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogcGFyZW50RnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdpZHRoID0gZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGhlaWdodCA9IGZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgY2hpbGRBbmNob3IgPSBjaGlsZFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAvLyBGaWdtYSBjb29yZGluYXRlcyBhcmUgbWVhc3VyZWQgZnJvbSB0aGUgcGFyZW50J3MgdG9wLWxlZnQuIENvbnZlcnRcclxuICAgICAgICAvLyB0aGF0IHJlY3RhbmdsZSB0byB0aGUgbG9jYWwgcG9zaXRpb24gb2YgdGhlIG5vZGUncyBjZW50ZXIgYW5jaG9yLlxyXG4gICAgICAgIHg6IChmcmFtZS54IC0gcGFyZW50RnJhbWUueCkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLnhcclxuICAgICAgICAgICAgKyB3aWR0aCAqIGNoaWxkQW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSlcclxuICAgICAgICAgICAgLSAoZnJhbWUueSAtIHBhcmVudEZyYW1lLnkpICogc2NhbGVcclxuICAgICAgICAgICAgLSBoZWlnaHQgKiAoMSAtIGNoaWxkQW5jaG9yLnkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVUcmFuc2Zvcm1Qb3NpdGlvbihcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgcGFyZW50VHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKHNwZWMuaXNSb290IHx8ICFzcGVjLmludHJpbnNpY1NpemUpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBtYXRyaXggPSBzcGVjLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgY29uc3QgdmFsdWVzID0gW1xyXG4gICAgICAgIG1hdHJpeD8uWzBdPy5bMF0sIG1hdHJpeD8uWzBdPy5bMV0sIG1hdHJpeD8uWzBdPy5bMl0sXHJcbiAgICAgICAgbWF0cml4Py5bMV0/LlswXSwgbWF0cml4Py5bMV0/LlsxXSwgbWF0cml4Py5bMV0/LlsyXSxcclxuICAgIF07XHJcbiAgICBpZiAoIXZhbHVlcy5ldmVyeSgodmFsdWUpID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgW20wMCwgbTAxLCB0eCwgbTEwLCBtMTEsIHR5XSA9IHZhbHVlcyBhcyBudW1iZXJbXTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShwYXJlbnRXaWR0aCkgfHwgIU51bWJlci5pc0Zpbml0ZShwYXJlbnRIZWlnaHQpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIC8vIEZpZ21hIHJlbGF0aXZlVHJhbnNmb3JtIGlzIHRvcC1sZWZ0IGJhc2VkLiBUcmFuc2Zvcm0gdGhlIHVucm90YXRlZCBsb2NhbFxyXG4gICAgLy8gY2VudGVyLCB0aGVuIGNvbnZlcnQgdGhlIHBhcmVudCdzIGRvd253YXJkIFkgYXhpcyB0byBDb2NvcyB1cHdhcmQgWS5cclxuICAgIGNvbnN0IGNlbnRlclggPSB0eCArIG0wMCAqIHNwZWMuaW50cmluc2ljU2l6ZS53aWR0aCAvIDJcclxuICAgICAgICArIG0wMSAqIHNwZWMuaW50cmluc2ljU2l6ZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgY2VudGVyWSA9IHR5ICsgbTEwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTExICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHg6IGNlbnRlclggKiBzY2FsZSAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSkgLSBjZW50ZXJZICogc2NhbGUsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHZW9tZXRyeShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiBhbnkge1xyXG4gICAgY29uc3QgeyBVSVRyYW5zZm9ybSwgVmVjMyB9ID0gY2M7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gbm9kZS5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIGNvbnN0IHNpemUgPSBzcGVjLmludHJpbnNpY1NpemUgPz8gc3BlYy5mcmFtZTtcclxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNpemUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IG5vZGUucGFyZW50Py5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcG9zaXRpb24gPSBzcGVjLmlzUm9vdFxyXG4gICAgICAgID8geyB4OiAwLCB5OiAwIH1cclxuICAgICAgICA6IHJlbGF0aXZlVHJhbnNmb3JtUG9zaXRpb24oc3BlYywgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSlcclxuICAgICAgICAgICAgPz8gZnJhbWVQb3NpdGlvbihzcGVjLmZyYW1lLCBzcGVjLnBhcmVudEZyYW1lLCBzY2FsZSwgcGFyZW50VHJhbnNmb3JtLCB0cmFuc2Zvcm0pO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyhwb3NpdGlvbi54LCBwb3NpdGlvbi55LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxuICAgIG5vZGUuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgc3BlYy5yb3RhdGlvbik7XHJcbiAgICBub2RlLmFjdGl2ZSA9IHNwZWMudmlzaWJsZTtcclxuICAgIHJldHVybiB0cmFuc2Zvcm07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVQYWludChwYWludHM6IEZpZ21hUGFpbnRbXSk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHBhaW50cy5maW5kKChwYWludCkgPT4gcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHBhaW50Lm9wYWNpdHkgPz8gMSkgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVNvbGlkUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnR5cGUgPT09ICdTT0xJRCdcclxuICAgICAgICAmJiBwYWludC52aXNpYmxlICE9PSBmYWxzZVxyXG4gICAgICAgICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMFxyXG4gICAgICAgICYmIEJvb2xlYW4ocGFpbnQuY29sb3IpXHJcbiAgICAgICAgJiYgKHBhaW50LmNvbG9yPy5hID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZEZpbGwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KHNwZWMuZmlsbHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2YWxpZFNvbGlkU3Ryb2tlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBzcGVjLnN0cm9rZVdlaWdodCA+IDAgPyB2aXNpYmxlU29saWRQYWludChzcGVjLnN0cm9rZXMpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNHcmFwaGljc1Zpc3VhbChzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbih2aXNpYmxlU29saWRGaWxsKHNwZWMpIHx8IHZhbGlkU29saWRTdHJva2Uoc3BlYykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkcmF3R3JhcGhpY3MoZ3JhcGhpY3M6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVTb2xpZEZpbGwoc3BlYyk7XHJcbiAgICBjb25zdCBzdHJva2UgPSB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpO1xyXG4gICAgaWYgKCFmaWxsICYmICFzdHJva2UpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCByYWRpdXMgPSBNYXRoLm1heChcclxuICAgICAgICAwLFxyXG4gICAgICAgIE1hdGgubWluKE1hdGgubWluKC4uLnNwZWMuY29ybmVyUmFkaWkpICogc2NhbGUsIHdpZHRoIC8gMiwgaGVpZ2h0IC8gMiksXHJcbiAgICApO1xyXG4gICAgaWYgKHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRScpIHtcclxuICAgICAgICBncmFwaGljcy5lbGxpcHNlKDAsIDAsIHdpZHRoIC8gMiwgaGVpZ2h0IC8gMik7XHJcbiAgICB9IGVsc2UgaWYgKHJhZGl1cyA+IDApIHtcclxuICAgICAgICBncmFwaGljcy5yb3VuZFJlY3QoLXdpZHRoIC8gMiwgLWhlaWdodCAvIDIsIHdpZHRoLCBoZWlnaHQsIHJhZGl1cyk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGdyYXBoaWNzLnJlY3QoLXdpZHRoIC8gMiwgLWhlaWdodCAvIDIsIHdpZHRoLCBoZWlnaHQpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZmlsbENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGwoKTtcclxuICAgIH1cclxuICAgIGlmIChzdHJva2U/LmNvbG9yKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MubGluZVdpZHRoID0gTWF0aC5tYXgoMC41LCBzcGVjLnN0cm9rZVdlaWdodCAqIHNjYWxlKTtcclxuICAgICAgICBncmFwaGljcy5zdHJva2VDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlKCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUdyYXBoaWNzKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xyXG4gICAgZ3JhcGhpY3MuZW5hYmxlZCA9IHRydWU7XHJcbiAgICBncmFwaGljcy5jbGVhcigpO1xyXG4gICAgZHJhd0dyYXBoaWNzKGdyYXBoaWNzLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVMYWJlbFRleHQoY2hhcmFjdGVyczogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcclxuICAgIHJldHVybiAoY2hhcmFjdGVycyA/PyAnJylcclxuICAgICAgICAucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKVxyXG4gICAgICAgIC5yZXBsYWNlKC9bXFxyXFx1MjAyOFxcdTIwMjldL2csICdcXG4nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNNdWx0aWxpbmVMYWJlbChjaGFyYWN0ZXJzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGRpc2FibGVzIGF1dG9tYXRpYyB3cmFwcGluZyB3aGVuZXZlciBvdmVyZmxvdyBpc1xyXG4gICAgLy8gTk9ORS4gT25seSBleHBsaWNpdCBsaW5lIGZlZWRzIGNhbiB0aGVyZWZvcmUgcHJvZHVjZSByZWFsIGxpbmUgYnJlYWtzLlxyXG4gICAgcmV0dXJuIGNoYXJhY3RlcnMuaW5jbHVkZXMoJ1xcbicpO1xufVxuXG5mdW5jdGlvbiBmaWdtYVBhbmVsRm9udFNpemUodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gICAgY29uc3QgZm9udFNpemUgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IDE2O1xuICAgIHJldHVybiBNYXRoLnJvdW5kKChmb250U2l6ZSArIE51bWJlci5FUFNJTE9OKSAqIDEwMCkgLyAxMDA7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZUxhYmVsKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xuICAgIGNvbnN0IHsgTGFiZWwgfSA9IGNjO1xyXG4gICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIGNvbnN0IGNoYXJhY3RlcnMgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIGNvbnN0IG11bHRpbGluZSA9IGlzTXVsdGlsaW5lTGFiZWwoY2hhcmFjdGVycyk7XHJcbiAgICAvLyBGaWdtYSBzdG9yZXMgbW9yZSBwcmVjaXNpb24gdGhhbiBpdHMgcGFuZWwgZGlzcGxheXMuIE1hdGNoIHRoZSB2aXNpYmxlXG4gICAgLy8gZGVzaWduIHZhbHVlICh1cCB0byB0d28gZGVjaW1hbHMpIGluc3RlYWQgb2YgbGVha2luZyBpdHMgaW50ZXJuYWwgZmxvYXQuXG4gICAgbGFiZWwuZm9udFNpemUgPSBmaWdtYVBhbmVsRm9udFNpemUoc3R5bGUuZm9udFNpemUpO1xuICAgIGxhYmVsLmxpbmVIZWlnaHQgPSBNYXRoLm1heCgxLCAoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplID8/IDE2KSAqIHNjYWxlKTtcclxuICAgIGxhYmVsLnNwYWNpbmdYID0gKHN0eWxlLmxldHRlclNwYWNpbmcgPz8gMCkgKiBzY2FsZTtcclxuICAgIGxhYmVsLmVuYWJsZVdyYXBUZXh0ID0gZmFsc2U7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IExhYmVsLk92ZXJmbG93LkNMQU1QO1xyXG4gICAgbGFiZWwuaG9yaXpvbnRhbEFsaWduID0gbXVsdGlsaW5lXHJcbiAgICAgICAgPyBMYWJlbC5Ib3Jpem9udGFsQWxpZ24uTEVGVFxyXG4gICAgICAgIDogTGFiZWwuSG9yaXpvbnRhbEFsaWduLkNFTlRFUjtcclxuICAgIGxhYmVsLnZlcnRpY2FsQWxpZ24gPSBtdWx0aWxpbmVcclxuICAgICAgICA/IExhYmVsLlZlcnRpY2FsQWxpZ24uVE9QXHJcbiAgICAgICAgOiBMYWJlbC5WZXJ0aWNhbEFsaWduLkNFTlRFUjtcclxuICAgIGxhYmVsLnN0cmluZyA9IGNoYXJhY3RlcnM7XHJcbiAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gZmFsc2U7XHJcbiAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHsgcjogMSwgZzogMSwgYjogMSwgYTogMSB9KTtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlUGFpbnQoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0cm9rZSA9IHZpc2libGVQYWludChzcGVjLnN0cm9rZXMpO1xyXG4gICAgaWYgKHN0cm9rZT8uY29sb3IgJiYgc3BlYy5zdHJva2VXZWlnaHQgPiAwKSB7XHJcbiAgICAgICAgbGFiZWwuZW5hYmxlT3V0bGluZSA9IHRydWU7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZUNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgc3Ryb2tlLmNvbG9yLCBzdHJva2Uub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lV2lkdGggPSBNYXRoLm1heCgxLCBzcGVjLnN0cm9rZVdlaWdodCAqIHNjYWxlKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlUmljaFRleHQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB7IFJpY2hUZXh0IH0gPSBjYztcclxuICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpID8/IG5vZGUuYWRkQ29tcG9uZW50KFJpY2hUZXh0KTtcclxuICAgIGNvbnN0IHN0eWxlID0gc3BlYy50ZXh0U3R5bGUgPz8ge307XHJcbiAgICByaWNoVGV4dC5zdHJpbmcgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIHJpY2hUZXh0LmZvbnRTaXplID0gZmlnbWFQYW5lbEZvbnRTaXplKHN0eWxlLmZvbnRTaXplKTtcbiAgICByaWNoVGV4dC5saW5lSGVpZ2h0ID0gTWF0aC5tYXgoMSwgKHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSA/PyAxNikgKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5tYXhXaWR0aCA9IE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5oYW5kbGVUb3VjaEV2ZW50ID0gZmFsc2U7XHJcbiAgICAvLyBSaWNoVGV4dCBpcyBwcmltYXJpbHkgdXNlZCBmb3IgcnVudGltZS1pbmplY3RlZCBtdWx0aS1saW5lIGNvbnRlbnQuIEFuXHJcbiAgICAvLyBlbXB0eSBGaWdtYSBwbGFjZWhvbGRlciBtdXN0IHRoZXJlZm9yZSBrZWVwIHRoZSBzYW1lIHRvcC1sZWZ0IGNvbnRyYWN0XHJcbiAgICAvLyBhZnRlciB0aGUgZ2FtZSBhc3NpZ25zIGl0cyByZWFsIHN0cmluZy5cclxuICAgIHJpY2hUZXh0Lmhvcml6b250YWxBbGlnbiA9IFJpY2hUZXh0Lkhvcml6b250YWxBbGlnbi5MRUZUO1xyXG4gICAgcmljaFRleHQudmVydGljYWxBbGlnbiA9IFJpY2hUZXh0LlZlcnRpY2FsQWxpZ24uVE9QO1xyXG4gICAgcmljaFRleHQuZm9udEZhbWlseSA9IHN0eWxlLmZvbnRGYW1pbHkgPz8gJyc7XHJcbiAgICByaWNoVGV4dC51c2VTeXN0ZW1Gb250ID0gIXNwZWMuZm9udFV1aWQ7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVBhaW50KHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgcmljaFRleHQuZm9udENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5hbGl6ZUxhYmVsR2VvbWV0cnkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIXRyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTGFiZWwpO1xyXG4gICAgY29uc3Qgb3V0bGluZVdpZHRoID0gbGFiZWw/LmVuYWJsZU91dGxpbmVcclxuICAgICAgICA/IE1hdGgubWF4KDAsIE51bWJlcihsYWJlbC5vdXRsaW5lV2lkdGgpIHx8IDApXHJcbiAgICAgICAgOiAwO1xyXG4gICAgY29uc3QgZmlnbWFIZWlnaHQgPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGZvbnRTaXplID0gTWF0aC5tYXgoMCwgTnVtYmVyKGxhYmVsPy5mb250U2l6ZSkgfHwgMCk7XHJcbiAgICBjb25zdCBmaW5hbEhlaWdodCA9IE1hdGgubWF4KGZpZ21hSGVpZ2h0LCBmb250U2l6ZSkgKyBvdXRsaW5lV2lkdGggKiAyO1xyXG4gICAgLy8gS2VlcCB0aGUgaW1wb3J0ZWQgRmlnbWEgYm94IHVubGVzcyBhIGRldGVybWluaXN0aWMgb3V0bGluZS9mb250IGxvd2VyXHJcbiAgICAvLyBib3VuZCByZXF1aXJlcyBleHBhbnNpb24uIEV4cGFuZCBzeW1tZXRyaWNhbGx5IGFyb3VuZCB0aGUgY2VudGVyIGFuY2hvclxyXG4gICAgLy8gc28gdGhlIG5vZGUncyBpbXBvcnRlZCBjZW50ZXIgcG9zaXRpb24gcmVtYWlucyB1bmNoYW5nZWQuXHJcbiAgICAvLyBUaGUgYmFzZSBib3ggbXVzdCBhdCBsZWFzdCBjb250YWluIHRoZSBmaW5hbCBDb2NvcyBmb250IHNpemUuIFdoZW4gYW5cclxuICAgIC8vIG91dGxpbmUgaXMgZW5hYmxlZCwgcmVzZXJ2ZSBvbmUgYWN0dWFsIENvY29zIG91dGxpbmUgd2lkdGggb24gZXZlcnkgc2lkZS5cclxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgKyBvdXRsaW5lV2lkdGggKiAyKSxcclxuICAgICAgICBmaW5hbEhlaWdodCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICB0YXJnZXRGcmFtZTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9ID0gc3BlYy5mcmFtZSxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xyXG4gICAgY29uc3Qgc3ByaXRlID0gbm9kZS5nZXRDb21wb25lbnQoU3ByaXRlKSA/PyBub2RlLmFkZENvbXBvbmVudChTcHJpdGUpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLmhlaWdodCAqIHNjYWxlKTtcclxuXHJcbiAgICAvLyBLZWVwIGFzc2lnbm1lbnQgZGV0ZXJtaW5pc3RpYzogYSBuZXcgU3ByaXRlIG1heSBkZWZhdWx0IHRvIFRSSU1NRUQgYW5kXHJcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIGNvbnN0IHNwcml0ZUZyYW1lID0gYXdhaXQgbG9hZEFzc2V0KGFzc2V0TWFuYWdlciwgc3BlYy5zcHJpdGUudXVpZCk7XHJcbiAgICBzcHJpdGUuc3ByaXRlRnJhbWUgPSBzcHJpdGVGcmFtZTtcclxuICAgIHNwcml0ZS50eXBlID0gc3BlYy5zcHJpdGUudGlsZWRcclxuICAgICAgICA/IFNwcml0ZS5UeXBlLlRJTEVEXHJcbiAgICAgICAgOiBzcGVjLnNwcml0ZS5zbGljZWRcclxuICAgICAgICAgICAgPyBTcHJpdGUuVHlwZS5TTElDRURcclxuICAgICAgICAgICAgOiBTcHJpdGUuVHlwZS5TSU1QTEU7XHJcblxyXG4gICAgaWYgKCFzcGVjLnNwcml0ZS5zbGljZWQgJiYgIXNwZWMuc3ByaXRlLnRpbGVkKSB7XHJcbiAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLlRSSU1NRUQ7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgcmF3V2lkdGggPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8ud2lkdGggPz8gc3ByaXRlRnJhbWU/LndpZHRoKTtcclxuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZSh0cmltbWVkSGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIHJhd1dpZHRoID4gMFxyXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3V2lkdGggLSB0YXJnZXRXaWR0aCkgPD0gMC41MVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWSA9IHRhcmdldEhlaWdodCAvIHJhd0hlaWdodDtcclxuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XHJcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgICAgICAgICAgICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZSh0cmltbWVkV2lkdGggKiBzY2FsZVgsIHRyaW1tZWRIZWlnaHQgKiBzY2FsZVkpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIFNsaWNlZC90aWxlZCBzcHJpdGVzIGFuZCBzcHJpdGVzIHJlc2l6ZWQgaW4gRmlnbWEgbXVzdCByZXRhaW4gdGhlIGRlc2lnblxyXG4gICAgLy8gc2l6ZS4gQ29jb3MgcmVwcmVzZW50cyB0aGF0IHN0YXRlIGFzIENVU1RPTS5cclxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XHJcbiAgICB0cmFuc2Zvcm0/LnNldENvbnRlbnRTaXplKHRhcmdldFdpZHRoLCB0YXJnZXRIZWlnaHQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXF1aXJlc1RpbGVkTWFzayhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihzcGVjLnNwcml0ZT8udGlsZWQgJiYgc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5hdGl2ZVRpbGVTY2FsZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHNjYWxlID0gc3BlYy5zcHJpdGU/LnRpbGVTY2FsZTtcclxuICAgIHJldHVybiB0eXBlb2Ygc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShzY2FsZSkgJiYgc2NhbGUgPiAwXHJcbiAgICAgICAgPyBzY2FsZVxyXG4gICAgICAgIDogMTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZClcclxuICAgICAgICAmJiAocmVxdWlyZXNUaWxlZE1hc2soc3BlYykgfHwgTWF0aC5hYnMobmF0aXZlVGlsZVNjYWxlKHNwZWMpIC0gMSkgPiAxZS02KTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZSlcclxuICAgICAgICAmJiAhc3BlYy5zcHJpdGU/LnNsaWNlZFxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8udGlsZWQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZW5kZXJGcmFtZSA9IHNwZWMuc3ByaXRlPy5yZW5kZXJGcmFtZTtcclxuICAgIGlmICghcmVuZGVyRnJhbWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi2hei+ueeVjCBQTkcg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd57y65bCR5riy5p+T6L6555WM44CCYCk7XHJcbiAgICB9XHJcbiAgICBsZXQgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChndWFyZCAmJiBoZWxwZXIpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWhlbHBlcikge1xyXG4gICAgICAgIGhlbHBlciA9IG5ldyBjYy5Ob2RlKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQoaGVscGVyKTtcclxuICAgIH1cclxuICAgIGhlbHBlci5uYW1lID0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRTtcclxuICAgIGhlbHBlci5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICBoZWxwZXIuYWN0aXZlID0gdHJ1ZTtcclxuXHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBoZWxwZXIuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IGhlbHBlci5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLm1heCgwLCByZW5kZXJGcmFtZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCByZW5kZXJGcmFtZS5oZWlnaHQgKiBzY2FsZSksXHJcbiAgICApO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKGhlbHBlciwgc3BlYywgc2NhbGUsIGNjLCByZW5kZXJGcmFtZSk7XHJcblxyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJYID0gc3BlYy5mcmFtZS54ICsgc3BlYy5mcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCBnZW9tZXRyeUNlbnRlclkgPSBzcGVjLmZyYW1lLnkgKyBzcGVjLmZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJYID0gcmVuZGVyRnJhbWUueCArIHJlbmRlckZyYW1lLndpZHRoIC8gMjtcclxuICAgIGNvbnN0IHJlbmRlckNlbnRlclkgPSByZW5kZXJGcmFtZS55ICsgcmVuZGVyRnJhbWUuaGVpZ2h0IC8gMjtcclxuICAgIC8vIEZpZ21hIHBhZ2UgWSBwb2ludHMgZG93bndhcmQgd2hpbGUgQ29jb3MgVUkgWSBwb2ludHMgdXB3YXJkLlxyXG4gICAgY29uc3Qgd29ybGREZWx0YVggPSAocmVuZGVyQ2VudGVyWCAtIGdlb21ldHJ5Q2VudGVyWCkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkRGVsdGFZID0gLShyZW5kZXJDZW50ZXJZIC0gZ2VvbWV0cnlDZW50ZXJZKSAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IE51bWJlci5pc0Zpbml0ZShzcGVjLndvcmxkUm90YXRpb24pXHJcbiAgICAgICAgPyBOdW1iZXIoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgIDogc3BlYy5yb3RhdGlvbjtcclxuICAgIGNvbnN0IHJhZGlhbnMgPSB3b3JsZFJvdGF0aW9uICogTWF0aC5QSSAvIDE4MDtcclxuICAgIGNvbnN0IGNvc2luZSA9IE1hdGguY29zKHJhZGlhbnMpO1xyXG4gICAgY29uc3Qgc2luZSA9IE1hdGguc2luKHJhZGlhbnMpO1xyXG4gICAgLy8gVGhlIGV4cG9ydGVkIFBORyBpcyBhbHJlYWR5IHJhc3Rlcml6ZWQgaW4gRmlnbWEgcGFnZSBheGVzLiBDb3VudGVyYWN0XHJcbiAgICAvLyB0aGUgbG9naWNhbCBzaGVsbCdzIGFjY3VtdWxhdGVkIHJvdGF0aW9uIGFuZCBleHByZXNzIHRoZSB2aXN1YWwtY2VudGVyXHJcbiAgICAvLyBvZmZzZXQgYmFjayBpbiB0aGF0IHNoZWxsJ3MgbG9jYWwgY29vcmRpbmF0ZSBzeXN0ZW0uXHJcbiAgICBjb25zdCBsb2NhbFggPSBjb3NpbmUgKiB3b3JsZERlbHRhWCArIHNpbmUgKiB3b3JsZERlbHRhWTtcclxuICAgIGNvbnN0IGxvY2FsWSA9IC1zaW5lICogd29ybGREZWx0YVggKyBjb3NpbmUgKiB3b3JsZERlbHRhWTtcclxuICAgIGhlbHBlci5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMyhsb2NhbFgsIGxvY2FsWSwgMCkpO1xyXG4gICAgaGVscGVyLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIC13b3JsZFJvdGF0aW9uKTtcclxuICAgIGhlbHBlci5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICBoZWxwZXIuc2V0U2libGluZ0luZGV4KDApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVUaWxlZFNwcml0ZUhlbHBlcihcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgbmVlZHNNYXNrID0gcmVxdWlyZXNUaWxlZE1hc2soc3BlYyk7XHJcbiAgICBsZXQgdGlsZWRNYXNrID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICBsZXQgdGlsZWRTcHJpdGUgPSB0aWxlZE1hc2s/LmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpXHJcbiAgICAgICAgPz8gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkU3ByaXRlLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKG5lZWRzTWFzaykge1xyXG4gICAgICAgIGlmICghdGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIHRpbGVkTWFzayA9IG5ldyBjYy5Ob2RlKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgICAgICAgICAgbm9kZS5hZGRDaGlsZCh0aWxlZE1hc2spO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aWxlZE1hc2submFtZSA9IFRJTEVEX01BU0tfTk9ERV9OQU1FO1xyXG4gICAgICAgIHRpbGVkTWFzay5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdGlsZWRNYXNrLmFjdGl2ZSA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgbWFza1RyYW5zZm9ybSA9IHRpbGVkTWFzay5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IHRpbGVkTWFzay5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIG1hc2tUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgICAgIG1hc2tUcmFuc2Zvcm0uc2V0Q29udGVudFNpemUoXHJcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgMCk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFNjYWxlKG5ldyBjYy5WZWMzKDEsIDEsIDEpKTtcclxuICAgICAgICBjb25maWd1cmVDbGlwKHRpbGVkTWFzaywgc3BlYywgY2MpO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnRpbGVkTWFzay5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICB0aWxlZE1hc2suZGVzdHJveSgpO1xyXG4gICAgICAgIHRpbGVkTWFzayA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzcHJpdGVQYXJlbnQgPSB0aWxlZE1hc2sgPz8gbm9kZTtcclxuICAgIGlmICghdGlsZWRTcHJpdGUpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZSA9IG5ldyBjYy5Ob2RlKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgIHNwcml0ZVBhcmVudC5hZGRDaGlsZCh0aWxlZFNwcml0ZSk7XHJcbiAgICB9IGVsc2UgaWYgKHRpbGVkU3ByaXRlLnBhcmVudCAhPT0gc3ByaXRlUGFyZW50KSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUucGFyZW50ID0gc3ByaXRlUGFyZW50O1xyXG4gICAgfVxyXG4gICAgdGlsZWRTcHJpdGUubmFtZSA9IFRJTEVEX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICB0aWxlZFNwcml0ZS5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICB0aWxlZFNwcml0ZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKHRpbGVkU3ByaXRlLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG4gICAgY29uc3QgdGlsZVNjYWxlID0gbmF0aXZlVGlsZVNjYWxlKHNwZWMpO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gdGlsZWRTcHJpdGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgID8/IHRpbGVkU3ByaXRlLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgdHJhbnNmb3JtLnNldENvbnRlbnRTaXplKFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAvIHRpbGVTY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSAvIHRpbGVTY2FsZSksXHJcbiAgICApO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMoMCwgMCwgMCkpO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgMCk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTY2FsZShuZXcgY2MuVmVjMyh0aWxlU2NhbGUsIHRpbGVTY2FsZSwgMSkpO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0U2libGluZ0luZGV4KDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVPcGFjaXR5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMub3BhY2l0eSA+PSAwLjk5OSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG9wYWNpdHkgPSBub2RlLmdldENvbXBvbmVudChjYy5VSU9wYWNpdHkpID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLlVJT3BhY2l0eSk7XHJcbiAgICBvcGFjaXR5Lm9wYWNpdHkgPSBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNwZWMub3BhY2l0eSkpICogMjU1KTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlTGF5b3V0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHsgTGF5b3V0LCBTaXplIH0gPSBjYztcclxuICAgIGNvbnN0IGxheW91dCA9IG5vZGUuZ2V0Q29tcG9uZW50KExheW91dCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGF5b3V0KTtcclxuICAgIGxheW91dC50eXBlID0gbW9kZSA9PT0gJ0hPUklaT05UQUwnXHJcbiAgICAgICAgPyBMYXlvdXQuVHlwZS5IT1JJWk9OVEFMXHJcbiAgICAgICAgOiBtb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LlR5cGUuVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuVHlwZS5HUklEO1xyXG4gICAgaWYgKG1vZGUgPT09ICdHUklEJykge1xyXG4gICAgICAgIGxheW91dC5zdGFydEF4aXMgPSBzcGVjLmxheW91dD8uc291cmNlTW9kZSA9PT0gJ1ZFUlRJQ0FMJ1xyXG4gICAgICAgICAgICA/IExheW91dC5BeGlzRGlyZWN0aW9uLlZFUlRJQ0FMXHJcbiAgICAgICAgICAgIDogTGF5b3V0LkF4aXNEaXJlY3Rpb24uSE9SSVpPTlRBTDtcclxuICAgIH1cclxuICAgIGxheW91dC5yZXNpemVNb2RlID0gTGF5b3V0LlJlc2l6ZU1vZGUuTk9ORTtcclxuICAgIGxheW91dC5wYWRkaW5nTGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdSaWdodCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nUmlnaHQgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nVG9wID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdUb3AgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nQm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGxheW91dC5zcGFjaW5nWCA9IHNwZWMubGF5b3V0IS5pdGVtU3BhY2luZyAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdZID0gKG1vZGUgPT09ICdHUklEJyA/IHNwZWMubGF5b3V0IS5jb3VudGVyU3BhY2luZyA6IHNwZWMubGF5b3V0IS5pdGVtU3BhY2luZykgKiBzY2FsZTtcclxuICAgIGNvbnN0IGFjdGl2ZUNoaWxkcmVuID0gc3BlYy5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlKTtcclxuICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW5XaWR0aCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLndpZHRoICogc2NhbGUsIDApO1xyXG4gICAgICAgIGNvbnN0IGlubmVyV2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ0xlZnQgLSBsYXlvdXQucGFkZGluZ1JpZ2h0O1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1ggPSBNYXRoLm1heCgwLCAoaW5uZXJXaWR0aCAtIGNoaWxkcmVuV2lkdGgpIC8gKGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCB1c2VkID0gY2hpbGRyZW5XaWR0aCArIGxheW91dC5zcGFjaW5nWCAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lcldpZHRoIC0gdXNlZCk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nTGVmdCArPSByZW1haW5pbmc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09ICdWRVJUSUNBTCcgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW5IZWlnaHQgPSBhY3RpdmVDaGlsZHJlbi5yZWR1Y2UoKHRvdGFsLCBjaGlsZCkgPT4gdG90YWwgKyBjaGlsZC5mcmFtZS5oZWlnaHQgKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC0gbGF5b3V0LnBhZGRpbmdUb3AgLSBsYXlvdXQucGFkZGluZ0JvdHRvbTtcclxuICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ1NQQUNFX0JFVFdFRU4nICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgbGF5b3V0LnNwYWNpbmdZID0gTWF0aC5tYXgoMCwgKGlubmVySGVpZ2h0IC0gY2hpbGRyZW5IZWlnaHQpIC8gKGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCB1c2VkID0gY2hpbGRyZW5IZWlnaHQgKyBsYXlvdXQuc3BhY2luZ1kgKiBNYXRoLm1heCgwLCBhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgaW5uZXJIZWlnaHQgLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ1RvcCArPSByZW1haW5pbmcgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ1RvcCArPSByZW1haW5pbmc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgbGF5b3V0LmNlbGxTaXplID0gbmV3IFNpemUoXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUud2lkdGgpKSAqIHNjYWxlLFxyXG4gICAgICAgICAgICBNYXRoLm1heCguLi5zcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IGNoaWxkLmZyYW1lLmhlaWdodCkpICogc2NhbGUsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlDb3VudGVyQWxpZ25tZW50KFxyXG4gICAgcGFyZW50OiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IG1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGNvbnN0IGFsaWdubWVudCA9IHNwZWMubGF5b3V0Py5jb3VudGVyQWxpZ247XHJcbiAgICBpZiAoIW1vZGUgfHwgIWFsaWdubWVudCB8fCAhWydIT1JJWk9OVEFMJywgJ1ZFUlRJQ0FMJ10uaW5jbHVkZXMobW9kZSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBwYXJlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8uaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0uY29udGVudFNpemUuaGVpZ2h0KVxyXG4gICAgICAgIDogc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGxheW91dFdpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0SGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGxlZnQgPSBzcGVjLmxheW91dCEucGFkZGluZ0xlZnQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgdG9wID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdUb3AgKiBzY2FsZTtcclxuICAgIGNvbnN0IGJvdHRvbSA9IHNwZWMubGF5b3V0IS5wYWRkaW5nQm90dG9tICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGZvciAoY29uc3QgY2hpbGRTcGVjIG9mIHNwZWMuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gbm9kZU1hcFtjaGlsZFNwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSB1dWlkID8gZmluZEJ5VXVpZChwYXJlbnQsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBjaGlsZD8uZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBpZiAoIWNoaWxkIHx8ICF0cmFuc2Zvcm0pIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0gY2hpbGQucG9zaXRpb24uY2xvbmUoKTtcclxuICAgICAgICBpZiAobW9kZSA9PT0gJ0hPUklaT05UQUwnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dEhlaWdodCAtIHRvcCAtIGJvdHRvbSk7XHJcbiAgICAgICAgICAgIGxldCB0b3BPZmZzZXQgPSB0b3A7XHJcbiAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICB0b3BPZmZzZXQgPSB0b3AgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLmhlaWdodCkgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKGFsaWdubWVudCA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IGxheW91dEhlaWdodCAtIGJvdHRvbSAtIHRyYW5zZm9ybS5oZWlnaHQ7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0uc2V0Q29udGVudFNpemUodHJhbnNmb3JtLndpZHRoLCBhdmFpbGFibGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBvc2l0aW9uLnkgPSBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAgICAgLSB0b3BPZmZzZXRcclxuICAgICAgICAgICAgICAgIC0gdHJhbnNmb3JtLmhlaWdodCAqICgxIC0gKHRyYW5zZm9ybS5hbmNob3JQb2ludD8ueSA/PyAwLjUpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCgwLCBsYXlvdXRXaWR0aCAtIGxlZnQgLSByaWdodCk7XHJcbiAgICAgICAgICAgIGxldCBsZWZ0T2Zmc2V0ID0gbGVmdDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxlZnRPZmZzZXQgPSBsZWZ0ICsgKGF2YWlsYWJsZSAtIHRyYW5zZm9ybS53aWR0aCkgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKGFsaWdubWVudCA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxlZnRPZmZzZXQgPSBsYXlvdXRXaWR0aCAtIHJpZ2h0IC0gdHJhbnNmb3JtLndpZHRoO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ1NUUkVUQ0gnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNmb3JtLnNldENvbnRlbnRTaXplKGF2YWlsYWJsZSwgdHJhbnNmb3JtLmhlaWdodCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueCA9IGxlZnRPZmZzZXRcclxuICAgICAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICAgICAgKyB0cmFuc2Zvcm0ud2lkdGggKiAodHJhbnNmb3JtLmFuY2hvclBvaW50Py54ID8/IDAuNSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNoaWxkLnNldFBvc2l0aW9uKHBvc2l0aW9uKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlQ2xpcChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGdyYXBoaWNzID0gbm9kZS5nZXRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xyXG4gICAgaWYgKGdyYXBoaWNzKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZW5hYmxlZCA9IHRydWU7XHJcbiAgICAgICAgZ3JhcGhpY3MuY2xlYXIoKTtcclxuICAgIH1cclxuICAgIGNvbnN0IG1hc2sgPSBub2RlLmdldENvbXBvbmVudChjYy5NYXNrKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5NYXNrKTtcclxuICAgIG1hc2sudHlwZSA9IHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRSdcclxuICAgICAgICA/IGNjLk1hc2suVHlwZS5HUkFQSElDU19FTExJUFNFID8/IGNjLk1hc2suVHlwZS5FTExJUFNFXHJcbiAgICAgICAgOiBjYy5NYXNrLlR5cGUuR1JBUEhJQ1NfUkVDVCA/PyBjYy5NYXNrLlR5cGUuUkVDVDtcclxuICAgIG1hc2suaW52ZXJ0ZWQgPSBmYWxzZTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gc3BlYy5jbGlwc0NvbnRlbnRcclxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVCdXR0b24obm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJykge1xyXG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkJ1dHRvbikgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuQnV0dG9uKTtcclxuICAgICAgICBidXR0b24udGFyZ2V0ID0gbm9kZTtcclxuICAgICAgICBidXR0b24udHJhbnNpdGlvbiA9IGNjLkJ1dHRvbi5UcmFuc2l0aW9uLlNDQUxFO1xyXG4gICAgICAgIGJ1dHRvbi56b29tU2NhbGUgPSAwLjk7XHJcbiAgICAgICAgYnV0dG9uLmR1cmF0aW9uID0gMC4xO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHJhbnNmb3JtOiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IGFueSB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHsgTm9kZSwgVUlUcmFuc2Zvcm0sIE1hc2ssIFNjcm9sbFZpZXcgfSA9IGNjO1xyXG4gICAgbGV0IHZpZXcgPSBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk7XHJcbiAgICBsZXQgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50JykgPz8gbnVsbDtcclxuICAgIGlmICh2aWV3ICYmIGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIGd1YXJkKTtcclxuICAgICAgICBpZiAoY29udGVudCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUoY29udGVudCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNjcm9sbCA9IG5vZGUuZ2V0Q29tcG9uZW50KFNjcm9sbFZpZXcpID8/IG5vZGUuYWRkQ29tcG9uZW50KFNjcm9sbFZpZXcpO1xyXG4gICAgaWYgKCF2aWV3KSB7XHJcbiAgICAgICAgdmlldyA9IG5ldyBOb2RlKCd2aWV3Jyk7XHJcbiAgICAgICAgdmlldy5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgbm9kZS5hZGRDaGlsZCh2aWV3KTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpZXdUcmFuc2Zvcm0gPSB2aWV3LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gdmlldy5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdmlld1RyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICB2aWV3VHJhbnNmb3JtLnNldENvbnRlbnRTaXplKHRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCwgdHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodCk7XHJcbiAgICB2aWV3LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgY29uc3QgbWFzayA9IHZpZXcuZ2V0Q29tcG9uZW50KE1hc2spID8/IHZpZXcuYWRkQ29tcG9uZW50KE1hc2spO1xyXG4gICAgbWFzay50eXBlID0gTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gTWFzay5UeXBlLlJFQ1Q7XHJcbiAgICBpZiAoIWNvbnRlbnQpIHtcclxuICAgICAgICBjb250ZW50ID0gbmV3IE5vZGUoJ2NvbnRlbnQnKTtcclxuICAgICAgICBjb250ZW50LmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICB2aWV3LmFkZENoaWxkKGNvbnRlbnQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udGVudFRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyBjb250ZW50LmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwcmV2aW91c0xheW91dCA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLkxheW91dCk7XHJcbiAgICBjb25zdCBuZXh0TGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgaWYgKHByZXZpb3VzTGF5b3V0ICYmICghbmV4dExheW91dE1vZGUgfHwgbmV4dExheW91dE1vZGUgPT09ICdOT05FJykpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQocHJldmlvdXNMYXlvdXQsIGd1YXJkLCBjb250ZW50Lm5hbWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb250ZW50LnJlbW92ZUNvbXBvbmVudChwcmV2aW91c0xheW91dCk7XHJcbiAgICB9XHJcbiAgICBjb250ZW50VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoY29udGVudCwgY29udGVudFRyYW5zZm9ybSwgc3BlYywgdHJhbnNmb3JtLCBzY2FsZSk7XHJcbiAgICBjb25zdCBsZWdhY3kgPSBub2RlLmdldENoaWxkQnlOYW1lKCdfX0ZpZ21hQ29udGVudCcpO1xyXG4gICAgaWYgKGxlZ2FjeSAmJiBsZWdhY3kgIT09IGNvbnRlbnQpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5sZWdhY3kuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgY29udGVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxlZ2FjeS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbGVnYWN5LmRlc3Ryb3koKTtcclxuICAgIH1cclxuICAgIC8vIENvY29zIENyZWF0b3IgMy44LjcgZXhwZWN0cyB0aGUgY29udGVudCBOb2RlIGhlcmUuIFNjcm9sbFZpZXcudmlldyBpcyBhXHJcbiAgICAvLyBnZXR0ZXIgZGVyaXZlZCBmcm9tIGNvbnRlbnQucGFyZW50IGFuZCBtdXN0IG5ldmVyIGJlIGFzc2lnbmVkIGRpcmVjdGx5LlxyXG4gICAgaWYgKHNjcm9sbC5jb250ZW50ID09PSBjb250ZW50KSB7XHJcbiAgICAgICAgc2Nyb2xsLmNvbnRlbnQgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgc2Nyb2xsLmNvbnRlbnQgPSBjb250ZW50O1xyXG4gICAgY29uc3QgYXhlcyA9IHNjcm9sbEF4ZXMoc3BlYyk7XHJcbiAgICBzY3JvbGwuaG9yaXpvbnRhbCA9IGF4ZXMuaG9yaXpvbnRhbDtcclxuICAgIHNjcm9sbC52ZXJ0aWNhbCA9IGF4ZXMudmVydGljYWw7XHJcbiAgICByZXR1cm4gY29udGVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2Nyb2xsQXhlcyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogeyBob3Jpem9udGFsOiBib29sZWFuOyB2ZXJ0aWNhbDogYm9vbGVhbiB9IHtcclxuICAgIGNvbnN0IGRpcmVjdGlvbiA9IHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gJiYgc3BlYy5vdmVyZmxvd0RpcmVjdGlvbiAhPT0gJ05PTkUnXHJcbiAgICAgICAgPyBzcGVjLm92ZXJmbG93RGlyZWN0aW9uLnRyaW0oKS50b1VwcGVyQ2FzZSgpXHJcbiAgICAgICAgOiAnVkVSVElDQUxfU0NST0xMSU5HJztcclxuICAgIGlmIChkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMJyB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX1NDUk9MTElORycpIHtcclxuICAgICAgICByZXR1cm4geyBob3Jpem9udGFsOiB0cnVlLCB2ZXJ0aWNhbDogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChkaXJlY3Rpb24gPT09ICdCT1RIJ1xyXG4gICAgICAgIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMJ1xyXG4gICAgICAgIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycpIHtcclxuICAgICAgICByZXR1cm4geyBob3Jpem9udGFsOiB0cnVlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogZmFsc2UsIHZlcnRpY2FsOiB0cnVlIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoXHJcbiAgICBjb250ZW50OiBhbnksXHJcbiAgICBjb250ZW50VHJhbnNmb3JtOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdmlld3BvcnQ6IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3Qgdmlld3BvcnRXaWR0aCA9IE1hdGgubWF4KDAsIE51bWJlcih2aWV3cG9ydC5jb250ZW50U2l6ZT8ud2lkdGgpIHx8IDApO1xyXG4gICAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LmhlaWdodCkgfHwgMCk7XHJcbiAgICBjb25zdCBjaGlsZFJpZ2h0ID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS54IC0gc3BlYy5mcmFtZS54ICsgY2hpbGQuZnJhbWUud2lkdGgpICogc2NhbGUpO1xyXG4gICAgY29uc3QgY2hpbGRCb3R0b20gPSBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+XHJcbiAgICAgICAgKGNoaWxkLmZyYW1lLnkgLSBzcGVjLmZyYW1lLnkgKyBjaGlsZC5mcmFtZS5oZWlnaHQpICogc2NhbGUpO1xyXG4gICAgY29uc3QgYXhlcyA9IHNjcm9sbEF4ZXMoc3BlYyk7XHJcbiAgICBjb25zdCBjb250ZW50V2lkdGggPSBheGVzLmhvcml6b250YWxcclxuICAgICAgICA/IE1hdGgubWF4KHZpZXdwb3J0V2lkdGgsIDAsIC4uLmNoaWxkUmlnaHQpXHJcbiAgICAgICAgOiB2aWV3cG9ydFdpZHRoO1xyXG4gICAgY29uc3QgY29udGVudEhlaWdodCA9IGF4ZXMudmVydGljYWxcclxuICAgICAgICA/IE1hdGgubWF4KHZpZXdwb3J0SGVpZ2h0LCAwLCAuLi5jaGlsZEJvdHRvbSlcclxuICAgICAgICA6IHZpZXdwb3J0SGVpZ2h0O1xyXG4gICAgY29udGVudFRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShjb250ZW50V2lkdGgsIGNvbnRlbnRIZWlnaHQpO1xyXG4gICAgLy8gQm90aCBoZWxwZXJzIHVzZSBDb2NvcycgZGVmYXVsdCBjZW50ZXIgYW5jaG9yLiBNb3ZlIGFuIG92ZXJzaXplZCBjb250ZW50XHJcbiAgICAvLyBub2RlIHNvIGl0cyB0b3AtbGVmdCBzdGlsbCBjb2luY2lkZXMgd2l0aCB0aGUgdmlld3BvcnQncyB0b3AtbGVmdC5cclxuICAgIGNvbnRlbnQuc2V0UG9zaXRpb24oXHJcbiAgICAgICAgKGNvbnRlbnRXaWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcclxuICAgICAgICAodmlld3BvcnRIZWlnaHQgLSBjb250ZW50SGVpZ2h0KSAvIDIsXHJcbiAgICAgICAgMCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycgfHwgY29udGVudCA9PT0gbm9kZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCB0cmFuc2Zvcm0sIHNwZWMsIHZpZXdwb3J0LCBzY2FsZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvdW50U3BlY3Moc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSk6IG51bWJlciB7XHJcbiAgICByZXR1cm4gc3BlY3MucmVkdWNlKCh0b3RhbCwgc3BlYykgPT4gdG90YWwgKyAxICsgY291bnRTcGVjcyhzcGVjLmNoaWxkcmVuKSwgMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNlbnRlckluQ2FudmFzKG5vZGU6IGFueSwgY2FudmFzOiBhbnksIFVJVHJhbnNmb3JtOiBhbnksIFZlYzM6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgbm9kZVRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IGNhbnZhc1RyYW5zZm9ybSA9IGNhbnZhcz8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghbm9kZVRyYW5zZm9ybSB8fCAhY2FudmFzVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2FudmFzU2l6ZSA9IGNhbnZhc1RyYW5zZm9ybS5jb250ZW50U2l6ZSA/PyB7XHJcbiAgICAgICAgd2lkdGg6IGNhbnZhc1RyYW5zZm9ybS53aWR0aCxcclxuICAgICAgICBoZWlnaHQ6IGNhbnZhc1RyYW5zZm9ybS5oZWlnaHQsXHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2lkdGggPSBOdW1iZXIoY2FudmFzU2l6ZT8ud2lkdGgpID4gMCA/IE51bWJlcihjYW52YXNTaXplLndpZHRoKSA6IDY0MDtcclxuICAgIGNvbnN0IGhlaWdodCA9IE51bWJlcihjYW52YXNTaXplPy5oZWlnaHQpID4gMCA/IE51bWJlcihjYW52YXNTaXplLmhlaWdodCkgOiAxMTM2O1xyXG4gICAgY29uc3QgY2FudmFzQW5jaG9yID0gY2FudmFzVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IG5vZGVBbmNob3IgPSBub2RlVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHggPSB3aWR0aCAqICgwLjUgLSBjYW52YXNBbmNob3IueClcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0ud2lkdGggKiAoMC41IC0gbm9kZUFuY2hvci54KTtcclxuICAgIGNvbnN0IHkgPSBoZWlnaHQgKiAoMC41IC0gY2FudmFzQW5jaG9yLnkpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLmhlaWdodCAqICgwLjUgLSBub2RlQW5jaG9yLnkpO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyh4LCB5LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUNvbXBvbmVudHMobm9kZTogYW55KTogYW55W10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5jb21wb25lbnRzID8/IG5vZGU/Ll9jb21wb25lbnRzO1xyXG4gICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUgOiBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVvcmRlckZpZ21hQ2hpbGRyZW4ocGFyZW50OiBhbnksIG9yZGVyZWROb2RlczogYW55W10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGRlc2lyZWQgPSBbLi4ubmV3IFNldChvcmRlcmVkTm9kZXMuZmlsdGVyKEJvb2xlYW4pKV07XHJcbiAgICBpZiAoIWRlc2lyZWQubGVuZ3RoIHx8IHR5cGVvZiBkZXNpcmVkWzBdPy5zZXRTaWJsaW5nSW5kZXggIT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYS1vd25lZCBjaGlsZHJlbiBhcmUga2VwdCBpbiBGaWdtYSBvcmRlci4gVXNlci1hdXRob3JlZCBjaGlsZHJlbiBhcmVcclxuICAgIC8vIG5ldmVyIHJlb3JkZXJlZCBhZ2FpbnN0IG9uZSBhbm90aGVyOyB0aGV5IGZvbGxvdyB0aGUgbWFuYWdlZCBibG9jay5cclxuICAgIGRlc2lyZWQuZm9yRWFjaCgobm9kZSwgaW5kZXgpID0+IG5vZGUuc2V0U2libGluZ0luZGV4KGluZGV4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBwcmV2aW91c05vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcmV0YWluZWROb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290KTtcclxuICAgIGNvbnN0IHN0YWxlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgZmlsZUlkIG9mIHByZXZpb3VzTm9kZUZpbGVJZHMpIHtcclxuICAgICAgICBpZiAoZmlsZUlkID09PSBub2RlUHJlZmFiRmlsZUlkKHByZWZhYlJvb3QpIHx8IHJldGFpbmVkTm9kZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICBzdGFsZS5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZUlkcyA9IG5ldyBTZXQoc3RhbGUua2V5cygpKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZS52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYOW+heWIoOmZpOeahCBGaWdtYSDoioLngrnigJwke25vZGUubmFtZX3igJ3lkKvmnInmiYvlt6Xnu4Tku7bvvIzlt7LlgZzmraLlkIzmraXku6XpmLLmraLmlbDmja7kuKLlpLHjgIJgLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyA9IChjb250YWluZXI6IGFueSwgc3Vydml2b3JQYXJlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgY29uc3QgY2hpbGRGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGNoaWxkKTtcclxuICAgICAgICAgICAgaWYgKGNoaWxkRmlsZUlkXHJcbiAgICAgICAgICAgICAgICAmJiAocHJldmlvdXNOb2RlRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpIHx8IHByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IFtmaWxlSWQsIG5vZGVdIG9mIHN0YWxlKSB7XHJcbiAgICAgICAgbGV0IGFuY2VzdG9yID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgbGV0IG5lc3RlZFVuZGVyU3RhbGUgPSBmYWxzZTtcclxuICAgICAgICB3aGlsZSAoYW5jZXN0b3IgJiYgYW5jZXN0b3IgIT09IHByZWZhYlJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFuY2VzdG9yRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChhbmNlc3Rvcik7XHJcbiAgICAgICAgICAgIGlmIChhbmNlc3RvckZpbGVJZCAmJiBzdGFsZUlkcy5oYXMoYW5jZXN0b3JGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBuZXN0ZWRVbmRlclN0YWxlID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFuY2VzdG9yID0gYW5jZXN0b3IucGFyZW50O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobmVzdGVkVW5kZXJTdGFsZSB8fCAhbm9kZS5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN1cnZpdm9yUGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKG5vZGUsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHN0YWxlLmRlbGV0ZShmaWxlSWQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBwcmV2aW91czogUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT4sXHJcbiAgICBnZW5lcmF0ZWRDbGFzc2VzOiBhbnlbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUge1xyXG4gICAgY29uc3QgcHJldmlvdXNDb21wb25lbnRzID0gbmV3IFNldChwcmV2aW91cy5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyk7XHJcbiAgICBjb25zdCBwcmV2aW91c0hlbHBlcnMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRIZWxwZXJGaWxlSWRzKTtcclxuICAgIGNvbnN0IG5vZGVGaWxlSWRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBjb25zdCBtYW5hZ2VkTm9kZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFwcGVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgY29uc3QgbWFuYWdlZFJ1bnRpbWVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMobm9kZU1hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWQjOatpee7k+aenOe8uuWwkSBGaWdtYSDoioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBub2RlRmlsZUlkc1tmaWdtYUlkXSA9IGZpbGVJZDtcclxuICAgICAgICBtYW5hZ2VkTm9kZXMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZFJ1bnRpbWVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBtYW5hZ2VkQ29tcG9uZW50VHlwZXMgPSBuZXcgU2V0KFtjYy5VSVRyYW5zZm9ybSwgLi4uZ2VuZXJhdGVkQ2xhc3Nlc10pO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG1hbmFnZWRSdW50aW1lTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBpZiAoIW1hbmFnZWRDb21wb25lbnRUeXBlcy5oYXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGlmIChtYXBwZWRVdWlkcy5oYXMobm9kZS51dWlkKSB8fCBub2RlID09PSBwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgaWYgKCFwYXJlbnRcclxuICAgICAgICAgICAgfHwgKCFtYXBwZWRVdWlkcy5oYXMocGFyZW50LnV1aWQpICYmICFtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmhhcyhwYXJlbnQudXVpZCkpXHJcbiAgICAgICAgICAgIHx8ICFpc0dlbmVyYXRlZEhlbHBlck5vZGUobm9kZSwgcGFyZW50LCBjYykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKHByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzSGVscGVycy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtwYXJlbnQubmFtZX3igJ3kuIvlrZjlnKjkuI7lr7zlhaXovoXliqnoioLngrnlkIzlkI3nmoTmiYvlt6XoioLngrnigJwke25vZGUubmFtZX3igJ3vvIzlt7LlgZzmraLlkIzmraXjgIJgLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlcnMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoY29tcG9uZW50RmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG5vZGVGaWxlSWRzLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogWy4uLm1hbmFnZWROb2Rlc10sXHJcbiAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IFsuLi5tYW5hZ2VkQ29tcG9uZW50c10sXHJcbiAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IFsuLi5tYW5hZ2VkSGVscGVyc10sXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoUHJlZmFiTGF5b3V0cyhcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgdmlzaXQgPSAoc3BlYzogU2NlbmVOb2RlU3BlYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW3NwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHV1aWQgPyBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgID8gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpPy5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG5vZGVcclxuICAgICAgICAgICAgOiBub2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgYXBwbHlDb3VudGVyQWxpZ25tZW50KGNoaWxkUGFyZW50LCBzcGVjLCBub2RlTWFwLCBzY2FsZSwgY2MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGRQYXJlbnQgIT09IG5vZGUpIHtcclxuICAgICAgICAgICAgZmluYWxpemVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgIGNoaWxkUGFyZW50LFxyXG4gICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3BlYy5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgIH07XHJcbiAgICBzcGVjcy5mb3JFYWNoKHZpc2l0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQsXHJcbiAgICB2YWx1ZTogbnVtYmVyLFxyXG4gICAgbWVzc2FnZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYXlsb2FkLnBhY2thZ2VOYW1lLCAncHJvZ3Jlc3MnLCB7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZSxcclxuICAgICAgICAgICAgbWVzc2FnZSxcclxuICAgICAgICB9KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIOi/m+W6puWPjemmiOS4jeWPr+eUqOaXtuS4jeW6lOS4reaWreWcuuaZr+WvvOWFpeOAglxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzID0ge1xyXG4gICAgaW5zcGVjdFByZWZhYkNvbnRleHQocGF5bG9hZDoge1xyXG4gICAgICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgICAgICByb290RmlsZUlkPzogc3RyaW5nO1xyXG4gICAgfSk6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkVkaXRpbmdTdGF0ZShwYXlsb2FkLnByZWZhYlV1aWQsIHBheWxvYWQucm9vdEZpbGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydERvY3VtZW50KHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHtcclxuICAgICAgICAgICAgZGlyZWN0b3IsXHJcbiAgICAgICAgICAgIE5vZGUsXHJcbiAgICAgICAgICAgIFVJVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICBDYW52YXMsXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgICAgICBDYW1lcmEsXHJcbiAgICAgICAgfSA9IGNjO1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBpZiAoIXNjZW5lKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmv44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWZhYkNvbnRleHQgPSBwYXlsb2FkLnByZWZhYkNvbnRleHQ7XHJcbiAgICAgICAgbGV0IHByZWZhYlJvb3Q6IGFueSB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcHJlZmFiRWRpdGluZ1N0YXRlKHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCwgcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKTtcclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOWwmuacquWuieWFqOaJk+W8gO+8miR7c3RhdGUucmVhc29uID8/ICfmnKrnn6Xljp/lm6AnfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHByZWZhYlJvb3QgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZS5TY2VuZS5yb290Tm9kZTtcclxuICAgICAgICAgICAgY29uc3QgZmlsZUlkSW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290LCBwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcclxuICAgICAgICAgICAgICAgIF9fcm9vdF9fOiBwcmVmYWJSb290LnV1aWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIGZpbGVJZF0gb2YgT2JqZWN0LmVudHJpZXMocHJlZmFiQ29udGV4dC5leGlzdGluZ05vZGVGaWxlSWRzKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbGVJZEluZGV4LmdldChmaWxlSWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBleGlzdGluZ01hcFtmaWdtYUlkXSA9IG5vZGUudXVpZDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nID0gdHJ1ZTtcclxuICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCA9IGV4aXN0aW5nTWFwO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmNlbnRlckluQ2FudmFzID0gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICAgICAgaWYgKHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgICAgIG5vZGVDb21wb25lbnRzKG5vZGUpLmZvckVhY2goKGNvbXBvbmVudCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cy5hZGQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBwYXlsb2FkLnJvb3RzLm1hcCgocm9vdCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKHJvb3QpKTtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCAmJiByb290cy5sZW5ndGggIT09IDEpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5Y+q5YWB6K645LiA5LiqIEZpZ21hIEZyYW1lIOagueiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmYWxsYmFja1BhcmVudCA9IHByZWZhYlJvb3Q/LnBhcmVudCA/PyBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpID8/IHNjZW5lO1xyXG4gICAgICAgIGNvbnN0IGRpcmVjdFJvb3QgPSByb290cy5sZW5ndGggPT09IDE7XHJcbiAgICAgICAgY29uc3QgY2FudmFzID0gcHJlZmFiUm9vdCA/IG51bGwgOiBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpO1xyXG4gICAgICAgIGNvbnN0IGdlbmVyYXRlZENsYXNzZXMgPSBbXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgIF07XHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgICAgIGxldCBjcmVhdGVkID0gMDtcclxuICAgICAgICBsZXQgdXBkYXRlZCA9IDA7XHJcbiAgICAgICAgY29uc3QgdG90YWxOb2RlcyA9IE1hdGgubWF4KDEsIGNvdW50U3BlY3Mocm9vdHMpKTtcclxuICAgICAgICBsZXQgY29tcGxldGVkTm9kZXMgPSAwO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRDb21wb25lbnRGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRIZWxwZXJzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkSGVscGVyRmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiT3duZXJzaGlwR3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkIHwgdW5kZWZpbmVkID0gcHJlZmFiQ29udGV4dFxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogcHJldmlvdXNNYW5hZ2VkSGVscGVycyxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RVdWlkID0gcGF5bG9hZC51cGRhdGVFeGlzdGluZ1xyXG4gICAgICAgICAgICA/IHBheWxvYWQuZXhpc3RpbmdNYXAuX19yb290X19cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgbGV0IGV4aXN0aW5nUm9vdE5vZGUgPSBleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgZXhpc3RpbmdSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChleGlzdGluZ1Jvb3ROb2RlPy5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBleGlzdGluZ1Jvb3ROb2RlID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gSW4gYSBkaXJlY3Qtcm9vdCBpbXBvcnQsIF9fcm9vdF9fIGFsaWFzZXMgdGhlIEZpZ21hIHJvb3QgVVVJRC4gSW4gYVxyXG4gICAgICAgIC8vIG11bHRpLXJvb3QgaW1wb3J0IGl0IGlkZW50aWZpZXMgYSBzeW50aGV0aWMgd3JhcHBlciBhbmQgbXVzdCBuZXZlciBiZVxyXG4gICAgICAgIC8vIHJldXNlZCBhcyBvbmUgb2YgaXRzIG93biBjaGlsZHJlbiB3aGVuIHRoZSByb290IGNvdW50IGNoYW5nZXMuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290V2FzRGlyZWN0ID0gQm9vbGVhbihleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgICYmIE9iamVjdC5lbnRyaWVzKHBheWxvYWQuZXhpc3RpbmdNYXApLnNvbWUoKFtmaWdtYUlkLCB1dWlkXSkgPT5cclxuICAgICAgICAgICAgICAgIGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgdXVpZCA9PT0gZXhpc3RpbmdSb290VXVpZCkpO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzRGlyZWN0Um9vdCA9IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzV3JhcHBlciA9ICFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBtYXBwZWRSb290VXVpZCA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBleGlzdGluZ1V1aWRGb3JTcGVjKHBheWxvYWQuZXhpc3RpbmdNYXAsIHJvb3RzWzBdKVxyXG4gICAgICAgICAgICA6ICghZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290VXVpZCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgbGV0IGltcG9ydFJvb3QgPSBwcmVmYWJSb290ID8/IChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmIG1hcHBlZFJvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbCk7XHJcbiAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGltcG9ydFJvb3Q/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3QgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBsZWdhY3lXcmFwcGVyID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IHByZXZpb3VzV3JhcHBlciA/PyAoaW1wb3J0Um9vdD8ucGFyZW50Py5uYW1lLnN0YXJ0c1dpdGgoJ0ZpZ21hIMK3ICcpXHJcbiAgICAgICAgICAgICAgICA/IGltcG9ydFJvb3QucGFyZW50XHJcbiAgICAgICAgICAgICAgICA6IG51bGwpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBjb25zdCByZXVzZWRJbXBvcnRSb290ID0gQm9vbGVhbihpbXBvcnRSb290KTtcclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBmYWxsYmFja1BhcmVudDtcclxuICAgICAgICBpZiAoIWRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRSb290KSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoYEZpZ21hIMK3ICR7Y2xlYW5OYW1lKHBheWxvYWQucm9vdE5hbWUpfWApO1xyXG4gICAgICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgICAgICAgICAgY3JlYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290Lm5hbWUgPSBgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YDtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByb290VHJhbnNmb3JtID0gaW1wb3J0Um9vdC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGltcG9ydFJvb3QuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm0uc2V0Q29udGVudFNpemUoXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS53aWR0aCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS5oZWlnaHQgKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpbXBvcnRSb290LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGNsZWFuTmFtZShyb290c1swXS5uYW1lKSk7XHJcbiAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEEgY29sbGFwc2VkIFNjZW5lU3BlYyBjYW4gaW50ZW50aW9uYWxseSBtYXAgc2V2ZXJhbCBGaWdtYSBJRHMgdG8gYVxyXG4gICAgICAgIC8vIHNpbmdsZSBDb2NvcyBub2RlLiBJZiBhIGxhdGVyIGltcG9ydCBleHBhbmRzIHRoYXQgc3VidHJlZSBhZ2FpbixcclxuICAgICAgICAvLyB0aG9zZSBJRHMgc3RpbGwgcG9pbnQgYXQgdGhlIHNhbWUgb2xkIFVVSUQuIENsYWltIGVhY2ggcmV1c2FibGUgbm9kZVxyXG4gICAgICAgIC8vIG9uY2UgcGVyIGJ1aWxkIHNvIGEgY2hpbGQgY2FuIG5ldmVyIHJldXNlIChhbmQgcmVwYXJlbnQpIGl0cyBwYXJlbnQuXHJcbiAgICAgICAgY29uc3QgY2xhaW1lZE5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gYXN5bmMgKFxyXG4gICAgICAgICAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgICAgICAgICBub2RlUGFyZW50OiBhbnksXHJcbiAgICAgICAgICAgIHByb3ZpZGVkTm9kZT86IGFueSxcclxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICAgICAgbGV0IG5vZGUgPSBwcm92aWRlZE5vZGUgPz8gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFub2RlICYmIHBheWxvYWQudXBkYXRlRXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWRVdWlkID0gcGF5bG9hZC5leGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWROb2RlID0gbWFwcGVkVXVpZCA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFwcGVkTm9kZSAmJiAhY2xhaW1lZE5vZGVVdWlkcy5oYXMobWFwcGVkTm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlID0gbWFwcGVkTm9kZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChub2RlICYmIGNsYWltZWROb2RlVXVpZHMuaGFzKG5vZGUudXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0ZWQgPSBCb29sZWFuKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBuZXcgTm9kZShjbGVhbk5hbWUoc3BlYy5uYW1lKSk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICB1cGRhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHByZWZhYk93bmVyc2hpcEd1YXJkICYmIGV4aXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZC5uYW1lID09PSAndmlldycpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBoZWxwZXIubmFtZSA9PT0gJ3ZpZXcnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oJ2NvbnRlbnQnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaGVscGVyLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZSA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKHRpbGVkU3ByaXRlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdlbmVyYXRlZENsYXNzZXMuaW5jbHVkZXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2xhaW1lZE5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgaWYgKCEocHJlZmFiQ29udGV4dCAmJiBub2RlID09PSBwcmVmYWJSb290KSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5wYXJlbnQgPSBub2RlUGFyZW50O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUubmFtZSA9IGNsZWFuTmFtZShzcGVjLm5hbWUpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuXHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhub2RlLCBzcGVjLCBjYywgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlc2VydmVkID0gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYywgY2MpO1xyXG4gICAgICAgICAgICAgICAgLy8gTWFzayBvd25zIGFuZCBkaXNhYmxlcyBpdHMgc2hhcmVkIEdyYXBoaWNzIGR1cmluZyB0aGVcclxuICAgICAgICAgICAgICAgIC8vIGRlZmVycmVkIG9uRGlzYWJsZSBwaGFzZS4gSWYgY2xpcHBpbmcgd2FzIHJlbW92ZWQgYnV0IGFcclxuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBHcmFwaGljcyByZW5kZXJlciBpcyBzdGlsbCBkZXNpcmVkLCByZWNyZWF0ZSB0aGF0XHJcbiAgICAgICAgICAgICAgICAvLyByZW5kZXJlciBvbmx5IGFmdGVyIHRoZSBvbGQgTWFzayBsaWZlY3ljbGUgaGFzIGNvbXBsZXRlZC5cclxuICAgICAgICAgICAgICAgIGlmICghcHJlc2VydmVkLmhhcyhNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgcHJlc2VydmVkLmhhcyhHcmFwaGljcykpIHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQuZGVsZXRlKEdyYXBoaWNzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdGVkQ2xhc3NlcyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgW0dyYXBoaWNzLCBTcHJpdGUsIExhYmVsLCBSaWNoVGV4dF0sXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCA/IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlbW92ZWRSZW5kZXJDb21wb25lbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlSGVscGVyID0gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3ZlcmZsb3dTcHJpdGVIZWxwZXIgPSB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIW92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkT3ZlcmZsb3dWaXN1YWwobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2xpcHNDaGlsZHJlbiA9IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInIHx8IHNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBORyDmlbTlsYLoioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIzotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAncmljaFRleHQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlUmljaFRleHQobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNjLlRURkZvbnQgJiYgIShmb250IGluc3RhbmNlb2YgY2MuVFRGRm9udCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUmljaFRleHQg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5Y+q6IO95L2/55SoIFRURi9PVEYg5a2X5L2T77yM5b2T5YmN5pig5bCE5Y+v6IO95pivIEJpdG1hcEZvbnTvvIguZm5077yJ44CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IGZvbnQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGZpbmFsaXplTGFiZWxHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlTGFiZWwobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBsYWJlbC5mb250ID0gYXdhaXQgbG9hZEFzc2V0KGNjLmFzc2V0TWFuYWdlciwgc3BlYy5mb250VXVpZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpLmZvbnQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBmaW5hbGl6ZUxhYmVsR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOefoumHj+iKgueCueKAnCR7c3BlYy5uYW1lfeKAneayoeaciee7keWumiBTcHJpdGVGcmFtZe+8jFBORyDotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUNsaXAobm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChoYXNHcmFwaGljc1Zpc3VhbChzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUdyYXBoaWNzKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZU9wYWNpdHkobm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlQnV0dG9uKG5vZGUsIHNwZWMsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJ1xyXG4gICAgICAgICAgICAgICAgPyBub2RlXHJcbiAgICAgICAgICAgICAgICA6IGNvbmZpZ3VyZVNjcm9sbChcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxheW91dChjaGlsZFBhcmVudCwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgYnVpbGQoY2hpbGQsIGNoaWxkUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgcmVvcmRlckZpZ21hQ2hpbGRyZW4oXHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkLmZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdXVpZCA/IGZpbmRCeVV1aWQoY2hpbGRQYXJlbnQsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICAgICAgPyBjaGlsZFBhcmVudC5nZXRDb21wb25lbnQoTGF5b3V0KVxyXG4gICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgICAgICBpZiAobGF5b3V0KSB7XHJcbiAgICAgICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChub2RlLCBzcGVjLCBjaGlsZFBhcmVudCwgdHJhbnNmb3JtLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RlZCAmJiBzcGVjLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSArPSAnIMK3IFRyYW5zZm9ybSc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgKz0gMTtcclxuICAgICAgICAgICAgZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLFxyXG4gICAgICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgLyB0b3RhbE5vZGVzLFxyXG4gICAgICAgICAgICAgICAgYOaehOW7uuiKgueCuSAke2NvbXBsZXRlZE5vZGVzfS8ke3RvdGFsTm9kZXN9IMK3ICR7c3BlYy5uYW1lfWAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIHJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChyb290LCBkaXJlY3RSb290ID8gcGFyZW50IDogaW1wb3J0Um9vdCwgZGlyZWN0Um9vdCA/IGltcG9ydFJvb3QgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmICFwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVDb2xsYXBzZWRNYXBwZWREZXNjZW5kYW50cyhcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAocGF5bG9hZC5jZW50ZXJJbkNhbnZhcyAmJiBjYW52YXMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjZW50ZXJJbkNhbnZhcyhpbXBvcnRSb290LCBjYW52YXMsIFVJVHJhbnNmb3JtLCBjYy5WZWMzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgICAgICAgICAgY29uc3Qgc3RhbGVUcmFuc2l0aW9uVXVpZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcClcclxuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKChbZmlnbWFJZCwgdXVpZF0pID0+IGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHV1aWQpKVxyXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKFssIHV1aWRdKSA9PiB1dWlkKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGxlZ2FjeVdyYXBwZXIgJiYgbGVnYWN5V3JhcHBlciAhPT0gaW1wb3J0Um9vdCAmJiBsZWdhY3lXcmFwcGVyLnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUobGVnYWN5V3JhcHBlciwgcGFyZW50LCBzdGFsZVRyYW5zaXRpb25VdWlkcywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBwcmV2aW91c0RpcmVjdFJvb3RcclxuICAgICAgICAgICAgICAgICYmIHByZXZpb3VzRGlyZWN0Um9vdCAhPT0gaW1wb3J0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHByZXZpb3VzRGlyZWN0Um9vdC51dWlkKVxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290LnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXHJcbiAgICAgICAgICAgICAgICAgICAgcHJldmlvdXNEaXJlY3RSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHN0YWxlVHJhbnNpdGlvblV1aWRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoaW1wb3J0Um9vdCwgcGF5bG9hZC5leGlzdGluZ01hcCwgbm9kZU1hcCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBpZiAoIXJldXNlZEltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50LFxyXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhwYXlsb2FkLmV4aXN0aW5nTWFwKSksXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LmRlc3Ryb3koKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IHByZWZhYlN5bmM6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmV0YWluZWROb2RlRmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlrprkvY3lr7zlhaXlkI7nmoToioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXRhaW5lZE5vZGVGaWxlSWRzLmFkZChlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBpbXBvcnRSb290LCBjYykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgbmV3IFNldChwcmVmYWJDb250ZXh0Lm1hbmFnZWROb2RlRmlsZUlkcyksXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHJlZnJlc2hQcmVmYWJMYXlvdXRzKHJvb3RzLCBpbXBvcnRSb290LCBub2RlTWFwLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMgPSBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAobm9kZVByZWZhYkZpbGVJZChpbXBvcnRSb290KSAhPT0gcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOWcqOWQjOatpei/h+eoi+S4reWPkeeUn+WPmOWMlu+8jOW3suaLkue7neS/neWtmOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHJvb3RVdWlkOiBpbXBvcnRSb290LnV1aWQsXHJcbiAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgIGNyZWF0ZWQsXHJcbiAgICAgICAgICAgIHVwZGF0ZWQsXHJcbiAgICAgICAgICAgIHRlbXBvcmFyeVJvb3Q6ICFwcmVmYWJDb250ZXh0ICYmIGRpcmVjdFJvb3QgJiYgIXJldXNlZEltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMsXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcblxyXG4gICAgcmVtb3ZlSW1wb3J0ZWROb2RlKHBheWxvYWQ6IHsgcm9vdFV1aWQ6IHN0cmluZyB9KTogYm9vbGVhbiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGNjLmRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lID8gZmluZEJ5VXVpZChzY2VuZSwgcGF5bG9hZC5yb290VXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0b3AgcmVuZGVyaW5nIGltbWVkaWF0ZWx5LiBDb2NvcyBkZXN0cm95cyBub2RlcyBhdCB0aGUgZW5kIG9mIHRoZVxyXG4gICAgICAgIC8vIGZyYW1lLCBzbyByZW1vdmluZyB0aGUgcGFyZW50IGFsb25lIGNhbiBsZWF2ZSBhIG9uZS1mcmFtZSBnaG9zdC5cclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSxcclxufTtcclxuIl19