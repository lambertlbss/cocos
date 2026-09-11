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
    const fill = visiblePaint(spec.fills);
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
    const fill = visiblePaint(spec.fills);
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
    // The imported root is a screen container, not a clipping viewport.
    return !spec.isRoot
        && spec.clipsContent
        && spec.kind !== 'scrollView'
        && spec.children.length > 0
        && spec.action === 'generate';
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
    setImportedContentSize(viewTransform, transform.contentSize.width, transform.contentSize.height);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBZ3JEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBbHJEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFFL0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQXlCekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSx5QkFBeUIsR0FBRyx1QkFBdUIsQ0FBQztBQUMxRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ2hDLFFBQVE7SUFDUixtQkFBbUI7SUFDbkIsTUFBTTtJQUNOLE1BQU07SUFDTixpQkFBaUI7Q0FDcEIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxTQUFTLENBQUMsS0FBYTs7SUFDNUIsT0FBTyxNQUFBLElBQUEsNEJBQWdCLEVBQUMsS0FBSyxDQUFDLG1DQUFJLFlBQVksQ0FBQztBQUNuRCxDQUFDO0FBRUQsU0FBUyxPQUFPLENBQUMsS0FBVSxFQUFFLEtBQTZCLEVBQUUsT0FBTyxHQUFHLENBQUM7O0lBQ25FLE1BQU0sTUFBTSxHQUFHLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQ25ELE9BQU8sSUFBSSxLQUFLLENBQ1osSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJ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QUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDaEUsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ1IsT0FBTyxLQUFLLENBQUM7UUFDakIsQ0FBQztRQUNELHFFQUFxRTtRQUNyRSxtRUFBbUU7UUFDbkUsSUFBSSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDcEIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2YsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztDQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgRmlnbWFDb2xvcixcclxuICAgIEZpZ21hUGFpbnQsXHJcbiAgICBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIFJlY3QsXHJcbiAgICBTY2VuZU5vZGVTcGVjLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5cclxubW9kdWxlLnBhdGhzLnB1c2goam9pbihFZGl0b3IuQXBwLnBhdGgsICdub2RlX21vZHVsZXMnKSk7XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XHJcbiAgICByb290VXVpZDogc3RyaW5nO1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIGNyZWF0ZWQ6IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ6IG51bWJlcjtcclxuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiU3luYz86IFByZWZhYlNjZW5lU3luY0NhcHR1cmU7XHJcbn1cclxuXHJcbmNvbnN0IEJBQ0tHUk9VTkRfTk9ERV9OQU1FID0gJ19fRmlnbWFCYWNrZ3JvdW5kJztcclxuY29uc3QgVElMRURfTUFTS19OT0RFX05BTUUgPSAnX19GaWdtYVRpbGVkTWFzayc7XHJcbmNvbnN0IFRJTEVEX1NQUklURV9OT0RFX05BTUUgPSAnX19GaWdtYVRpbGVkU3ByaXRlJztcclxuY29uc3QgT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSA9ICdfX0ZpZ21hT3ZlcmZsb3dWaXN1YWwnO1xyXG5jb25zdCBSQVNURVJfVkVDVE9SX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnVkVDVE9SJyxcclxuICAgICdCT09MRUFOX09QRVJBVElPTicsXHJcbiAgICAnU1RBUicsXHJcbiAgICAnTElORScsXHJcbiAgICAnUkVHVUxBUl9QT0xZR09OJyxcclxuXSk7XHJcblxyXG5mdW5jdGlvbiBjbGVhbk5hbWUoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc2FuaXRpemVOb2RlTmFtZShpbnB1dCkgPz8gJ0ZpZ21hIE5vZGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b0NvbG9yKENvbG9yOiBhbnksIHZhbHVlOiBGaWdtYUNvbG9yIHwgdW5kZWZpbmVkLCBvcGFjaXR5ID0gMSk6IGFueSB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSB2YWx1ZSA/PyB7IHI6IDAsIGc6IDAsIGI6IDAsIGE6IDEgfTtcclxuICAgIHJldHVybiBuZXcgQ29sb3IoXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UucikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5nKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAoc291cmNlLmEgPz8gMSkgKiBvcGFjaXR5KSkgKiAyNTUpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZEJ5VXVpZChyb290OiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QudXVpZCA9PT0gdXVpZCkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQnlVdWlkKGNoaWxkLCB1dWlkKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlUHJlZmFiRmlsZUlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/Ll9wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudDogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gY29tcG9uZW50Py5fX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWxrTm9kZXMocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xyXG4gICAgdmlzaXQocm9vdCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICB3YWxrTm9kZXMoY2hpbGQsIHZpc2l0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiQXNzZXRVdWlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBhc3NldCA9IG5vZGU/Ll9wcmVmYWI/LmFzc2V0O1xyXG4gICAgY29uc3QgdmFsdWUgPSBhc3NldD8uX3V1aWQgPz8gYXNzZXQ/LnV1aWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkZpbGVJZEluZGV4KHJvb3Q6IGFueSwgZXhwZWN0ZWRQcmVmYWJVdWlkPzogc3RyaW5nKTogTWFwPHN0cmluZywgYW55PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgY29uc3QgY29tcG9uZW50RmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgd2Fsa05vZGVzKHJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiUm9vdCA9IG5vZGU/Ll9wcmVmYWI/LnJvb3Q7XHJcbiAgICAgICAgaWYgKG5vZGUgIT09IHJvb3QgJiYgcHJlZmFiUm9vdCAmJiBwcmVmYWJSb290ICE9PSByb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYXNzZXRVdWlkID0gcHJlZmFiQXNzZXRVdWlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChleHBlY3RlZFByZWZhYlV1aWQgJiYgYXNzZXRVdWlkICYmIGFzc2V0VXVpZCAhPT0gZXhwZWN0ZWRQcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAoIWZpbGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChyZXN1bHQuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN6IqC54K5IGZpbGVJZO+8miR7ZmlsZUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHQuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZS5jb21wb25lbnRzID8/IG5vZGUuX2NvbXBvbmVudHMgPz8gW10pIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN57uE5Lu2IGZpbGVJZO+8miR7Y29tcG9uZW50RmlsZUlkfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbXBvbmVudEZpbGVJZHMuYWRkKGNvbXBvbmVudEZpbGVJZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJFZGl0aW5nU3RhdGUoXHJcbiAgICBleHBlY3RlZFV1aWQ6IHN0cmluZyxcclxuICAgIGV4cGVjdGVkUm9vdEZpbGVJZD86IHN0cmluZyxcclxuKTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY29uc3QgbW9kZSA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlNb2RlPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCBjdXJyZW50VXVpZCA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCByb290ID0gY2NlQXBpPy5TY2VuZT8ucm9vdE5vZGUgPz8gbnVsbDtcclxuICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKHJvb3QpO1xyXG4gICAgbGV0IHJlYXNvbiA9ICcnO1xyXG4gICAgaWYgKG1vZGUgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjee8lui+keaooeW8j+S4uiAke21vZGUgfHwgJ3Vua25vd24nfe+8jOWwmuacqui/m+WFpSBQcmVmYWJgO1xyXG4gICAgfSBlbHNlIGlmIChjdXJyZW50VXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjei1hOa6kCBVVUlEIOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie0YDtcclxuICAgIH0gZWxzZSBpZiAoIXJvb3QpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCueWwmuacquWwsee7qic7XHJcbiAgICB9IGVsc2UgaWYgKGV4cGVjdGVkUm9vdEZpbGVJZCAmJiByb290RmlsZUlkICE9PSBleHBlY3RlZFJvb3RGaWxlSWQpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5LiO5p2l5rqQ6K6w5b2V5LiN5LiA6Ie0JztcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgcmVhZHk6ICFyZWFzb24sXHJcbiAgICAgICAgbW9kZSxcclxuICAgICAgICBjdXJyZW50VXVpZCxcclxuICAgICAgICByb290VXVpZDogcm9vdD8udXVpZCxcclxuICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgIHJlYXNvbjogcmVhc29uIHx8IHVuZGVmaW5lZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLkVkaXRvcj8uVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gZ2VuZXJhdGVkO1xyXG4gICAgfVxyXG4gICAgLy8gVW5pdC10ZXN0L2hlYWRsZXNzIGZhbGxiYWNrLiBUaGUgcmVhbCBDcmVhdG9yIHNjZW5lIHByb2Nlc3MgYWx3YXlzIHVzZXNcclxuICAgIC8vIEVkaXRvci5VdGlscy5VVUlELmdlbmVyYXRlKHRydWUpLCBzbyBwcm9kdWN0aW9uIElEcyBmb2xsb3cgQ3JlYXRvcidzIG93biBmb3JtYXQuXHJcbiAgICByZXR1cm4gYGZpZ21hJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDE0KX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlOiBhbnksIHByZWZhYlJvb3Q6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGROb2RlPy4obm9kZSk7XHJcbiAgICBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LlByZWZhYkluZm8gPz8gY2MuUHJlZmFiSW5mbztcclxuICAgIGlmICghUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw6IqC54K555Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLnJvb3QgPSBwcmVmYWJSb290O1xyXG4gICAgaW5mby5hc3NldCA9IHByZWZhYlJvb3Q/Ll9wcmVmYWI/LmFzc2V0ID8/IG51bGw7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBpbmZvLmluc3RhbmNlID0gbnVsbDtcclxuICAgIGluZm8udGFyZ2V0T3ZlcnJpZGVzID0gbnVsbDtcclxuICAgIG5vZGUuX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZENvbXBvbmVudD8uKGNvbXBvbmVudCk7XHJcbiAgICBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgQ29tcFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uQ29tcFByZWZhYkluZm8gPz8gY2MuQ29tcFByZWZhYkluZm87XHJcbiAgICBpZiAoIUNvbXBQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBDb21wUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw57uE5Lu255Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBDb21wUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgY29tcG9uZW50Ll9fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0UGFyZW50S2VlcGluZ1dvcmxkKG5vZGU6IGFueSwgcGFyZW50OiBhbnkpOiB2b2lkIHtcclxuICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRQYXJlbnQgPT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICBub2RlLnNldFBhcmVudChwYXJlbnQsIHRydWUpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBub2RlLnBhcmVudCA9IHBhcmVudDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkOiBhbnksIHBhcmVudDogYW55LCBjYzogYW55KTogYm9vbGVhbiB7XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gQkFDS0dST1VORF9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9NQVNLX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX1NQUklURV9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gJ19fRmlnbWFDb250ZW50Jykge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgaWYgKGNoaWxkLm5hbWUgPT09ICd2aWV3JyAmJiBwYXJlbnQuZ2V0Q29tcG9uZW50Py4oY2MuU2Nyb2xsVmlldykpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBjaGlsZC5uYW1lID09PSAnY29udGVudCdcclxuICAgICAgICAmJiBwYXJlbnQubmFtZSA9PT0gJ3ZpZXcnXHJcbiAgICAgICAgJiYgcGFyZW50LnBhcmVudD8uZ2V0Q29tcG9uZW50Py4oY2MuU2Nyb2xsVmlldyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZU1hcHBlZE5vZGVUcmVlKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIHN0YWxlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGxldCByZW1vdmVkID0gMTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgaWYgKHN0YWxlVXVpZHMuaGFzKGNoaWxkLnV1aWQpIHx8IGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpKSB7XHJcbiAgICAgICAgICAgIHJlbW92ZWQgKz0gcmVtb3ZlTWFwcGVkTm9kZVRyZWUoY2hpbGQsIHN1cnZpdm9yUGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChzdXJ2aXZvclBhcmVudCkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgIHJldHVybiByZW1vdmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVTY2VuZVNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IFNjZW5lTm9kZVNwZWMge1xyXG4gICAgY29uc3QgYWN0aW9uID0gbm9ybWFsaXplSW1wb3J0QWN0aW9uKHNwZWMuYWN0aW9uIGFzIHVua25vd24pO1xyXG4gICAgY29uc3Qga2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24oc3BlYy5raW5kLCBhY3Rpb24pO1xyXG4gICAgY29uc3QgY2hpbGRyZW4gPSBBcnJheS5pc0FycmF5KHNwZWMuY2hpbGRyZW4pID8gc3BlYy5jaGlsZHJlbiA6IFtdO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5zcGVjLFxyXG4gICAgICAgIGFjdGlvbixcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIGNoaWxkcmVuOiBpc1Rlcm1pbmFsQWN0aW9uKGFjdGlvbikgfHwgc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09IHRydWVcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IGNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IG5vcm1hbGl6ZVNjZW5lU3BlYyhjaGlsZCkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmlnbWFJZHNGb3JTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBzdHJpbmdbXSB7XHJcbiAgICBjb25zdCBpZHMgPSBbc3BlYy5maWdtYUlkLCAuLi4oc3BlYy5hbGlhc0ZpZ21hSWRzID8/IFtdKV1cclxuICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIGlkLmxlbmd0aCA+IDAgJiYgaWQgIT09ICdfX3Jvb3RfXycpO1xyXG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KGlkcyldO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbGlhc0ZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgcmV0dXJuIGZpZ21hSWRzRm9yU3BlYyhzcGVjKS5maWx0ZXIoKGZpZ21hSWQpID0+IGZpZ21hSWQgIT09IHNwZWMuZmlnbWFJZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4aXN0aW5nVXVpZEZvclNwZWMoXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IGV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKHR5cGVvZiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeSA9PT0gJ2Jvb2xlYW4nKSB7XHJcbiAgICAgICAgcmV0dXJuIHNwZWMuZmxhdHRlbkJvdW5kYXJ5O1xyXG4gICAgfVxyXG4gICAgLy8gQmFja3dhcmQgY29tcGF0aWJpbGl0eSBmb3IgU2NlbmVTcGVjcyBwZXJzaXN0ZWQgYnkgaW1wb3J0ZXIgdmVyc2lvbnNcclxuICAgIC8vIGJlZm9yZSBmbGF0dGVuQm91bmRhcnkgd2FzIGludHJvZHVjZWQuIE5ldyBwbGFucyBhbHdheXMgc2V0IHRoZSBmbGFnIHNvXHJcbiAgICAvLyBmb2xkZWQgTGFiZWxzIGFuZCBvdGhlciBwcm9tb3RlZCB2aXN1YWxzIHVzZSB0aGUgc2FtZSBjbGVhbnVwIHNlbWFudGljcy5cclxuICAgIHJldHVybiBzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcidcclxuICAgICAgICB8fCAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgQm9vbGVhbihzcGVjLnNwcml0ZSkgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGggPT09IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVDb2xsYXBzZWRNYXBwZWREZXNjZW5kYW50cyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBjYzogYW55LFxyXG4pOiBudW1iZXIge1xyXG4gICAgY29uc3QgcmV0YWluZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhjdXJyZW50TWFwKSk7XHJcbiAgICBjb25zdCBib3VuZGFyeVNwZWNzOiBBcnJheTx7XHJcbiAgICAgICAgZmlnbWFJZDogc3RyaW5nO1xyXG4gICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogYm9vbGVhbjtcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIH0+ID0gW107XHJcbiAgICBjb25zdCBjb2xsZWN0Qm91bmRhcmllcyA9IChub2RlczogU2NlbmVOb2RlU3BlY1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBzcGVjIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBib3VuZGFyeVNwZWNzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZ21hSWQ6IHNwZWMuZmlnbWFJZCxcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldCgpLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBhbGlhc0ZpZ21hSWRzID0gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYyk7XHJcbiAgICAgICAgICAgIGlmIChhbGlhc0ZpZ21hSWRzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiBmYWxzZSxcclxuICAgICAgICAgICAgICAgICAgICBhbGlhc0ZpZ21hSWRzOiBuZXcgU2V0KGFsaWFzRmlnbWFJZHMpLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29sbGVjdEJvdW5kYXJpZXMoc3BlYy5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWNzKTtcclxuICAgIGNvbnN0IGJvdW5kYXJpZXMgPSBib3VuZGFyeVNwZWNzXHJcbiAgICAgICAgLm1hcCgoYm91bmRhcnkpID0+ICh7XHJcbiAgICAgICAgICAgIC4uLmJvdW5kYXJ5LFxyXG4gICAgICAgICAgICBub2RlOiBjdXJyZW50TWFwW2JvdW5kYXJ5LmZpZ21hSWRdXHJcbiAgICAgICAgICAgICAgICA/IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXSlcclxuICAgICAgICAgICAgICAgIDogbnVsbCxcclxuICAgICAgICB9KSlcclxuICAgICAgICAuZmlsdGVyKChib3VuZGFyeSk6IGJvdW5kYXJ5IGlzIHR5cGVvZiBib3VuZGFyeSAmIHsgbm9kZTogYW55IH0gPT4gQm9vbGVhbihib3VuZGFyeS5ub2RlKSk7XHJcbiAgICBpZiAoIWJvdW5kYXJpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4aXN0aW5nTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nIHx8IHJldGFpbmVkVXVpZHMuaGFzKHV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGJvdW5kYXJ5IG9mIGJvdW5kYXJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKCFib3VuZGFyeS5yZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHNcclxuICAgICAgICAgICAgICAgICYmICFib3VuZGFyeS5hbGlhc0ZpZ21hSWRzLmhhcyhmaWdtYUlkKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoYm91bmRhcnkubm9kZSwgdXVpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlICYmIG5vZGUgIT09IGJvdW5kYXJ5Lm5vZGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YWxlTm9kZXMuc2V0KG5vZGUudXVpZCwgbm9kZSk7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmICghc3RhbGVOb2Rlcy5zaXplKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZVV1aWRzID0gbmV3IFNldChzdGFsZU5vZGVzLmtleXMoKSk7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygc3RhbGVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGlmICghbm9kZS5wYXJlbnQgfHwgc3RhbGVVdWlkcy5oYXMobm9kZS5wYXJlbnQudXVpZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlbW92ZWQgKz0gcmVtb3ZlTWFwcGVkTm9kZVRyZWUobm9kZSwgbm9kZS5wYXJlbnQsIHN0YWxlVXVpZHMsIGNjKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZW1vdmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtZXJnZVByZXNlcnZlZE1hcHBpbmdzKFxyXG4gICAgaW1wb3J0Um9vdDogYW55LFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBjdXJyZW50TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKGV4aXN0aW5nTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nIHx8IGN1cnJlbnRNYXBbZmlnbWFJZF0pIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpKSB7XHJcbiAgICAgICAgICAgIGN1cnJlbnRNYXBbZmlnbWFJZF0gPSB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICBjb250YWluZXI6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBleGlzdGluZ1V1aWRzOiBTZXQ8c3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nVXVpZHMuaGFzKGNoaWxkLnV1aWQpKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgZXhpc3RpbmdVdWlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kQ2FudmFzKHJvb3Q6IGFueSwgQ2FudmFzOiBhbnkpOiBhbnkgfCBudWxsIHtcclxuICAgIGlmIChyb290LmdldENvbXBvbmVudChDYW52YXMpKSB7XHJcbiAgICAgICAgcmV0dXJuIHJvb3Q7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRDYW52YXMoY2hpbGQsIENhbnZhcyk7XHJcbiAgICAgICAgaWYgKGZvdW5kKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkQ29tcG9uZW50cyhcclxuICAgIG5vZGU6IGFueSxcclxuICAgIGNsYXNzZXM6IGFueVtdLFxyXG4gICAgcHJlc2VydmVkOiBTZXQ8YW55PixcclxuICAgIHJlbmRlckNsYXNzZXM6IGFueVtdLFxyXG4gICAgcmVtb3ZhYmxlRmlsZUlkcz86IFNldDxzdHJpbmc+LFxyXG4pOiBib29sZWFuIHtcclxuICAgIGxldCByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gZmFsc2U7XHJcbiAgICBmb3IgKGNvbnN0IHR5cGUgb2YgY2xhc3Nlcykge1xyXG4gICAgICAgIGlmIChwcmVzZXJ2ZWQuaGFzKHR5cGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wb25lbnQgPSBub2RlLmdldENvbXBvbmVudCh0eXBlKTtcclxuICAgICAgICBpZiAoY29tcG9uZW50KSB7XHJcbiAgICAgICAgICAgIGlmIChyZW1vdmFibGVGaWxlSWRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIGlmICghZmlsZUlkIHx8ICFyZW1vdmFibGVGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4iueahOa4suafk+e7hOS7tuS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDku6Xkv53miqTmiYvlt6XlhoXlrrnjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmVuZGVyQ2xhc3Nlcy5zb21lKChyZW5kZXJUeXBlKSA9PiBjb21wb25lbnQgaW5zdGFuY2VvZiByZW5kZXJUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm9kZS5yZW1vdmVDb21wb25lbnQoY29tcG9uZW50KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZFJlbmRlckNvbXBvbmVudDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZTogYW55LCBjYzogYW55KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBvdXRsaW5lID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTGFiZWxPdXRsaW5lKTtcclxuICAgIGlmICghb3V0bGluZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIExhYmVsT3V0bGluZSB3YXMgdXNlZCBieSBvbGRlciBpbXBvcnRlciB2ZXJzaW9ucy4gQ29jb3MgZGVzdHJveXNcclxuICAgIC8vIGNvbXBvbmVudHMgYXQgdGhlIGVuZCBvZiB0aGUgZnJhbWUgYW5kIGl0cyBvbkRpc2FibGUoKSB3cml0ZXMgYmFjayB0b1xyXG4gICAgLy8gTGFiZWwuZW5hYmxlT3V0bGluZSwgc28gbGV0IHRoYXQgbGlmZWN5Y2xlIGZpbmlzaCBiZWZvcmUgZWl0aGVyXHJcbiAgICAvLyByZWNvbmZpZ3VyaW5nIG9yIHJlbW92aW5nIHRoZSBMYWJlbCBjb21wb25lbnQuXHJcbiAgICBub2RlLnJlbW92ZUNvbXBvbmVudChvdXRsaW5lKTtcclxuICAgIGF3YWl0IHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSwgbm9kZTogYW55KTogU2V0PGFueT4ge1xuICAgIGNvbnN0IGRlc2lyZWQgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgIGNvbnN0IGNsaXBzQ2hpbGRyZW4gPSBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpO1xyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgIGlmICghdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpICYmICF1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYykpIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuU3ByaXRlKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlJpY2hUZXh0KTtcclxuICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYWJlbCk7XHJcbiAgICB9IGVsc2UgaWYgKCFSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICBpZiAoaGFzR3JhcGhpY3NWaXN1YWwoc3BlYykgfHwgY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5HcmFwaGljcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLk1hc2spO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgbGF5b3V0TW9kZVxyXG4gICAgICAgICYmIGxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkxheW91dCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5TY3JvbGxWaWV3KTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuQnV0dG9uKTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlVJT3BhY2l0eSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVzaXJlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAwKSk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJPd25lcnNoaXBHdWFyZCB7XHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzT3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgcmV0dXJuICFndWFyZC5wcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oZmlsZUlkICYmIGd1YXJkLnByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoZmlsZUlkKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgY29tcG9uZW50OiBhbnksXHJcbiAgICBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICBvd25lck5hbWU6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoIWNvbXBvbmVudCB8fCAhZ3VhcmQucHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoIWZpbGVJZCB8fCAhZ3VhcmQucHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBg6IqC54K54oCcJHtvd25lck5hbWV94oCd5LiK55qEICR7Y29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lID8/ICdDb21wb25lbnQnfSDkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGlmICghaXNPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDovoXliqnoioLngrnigJwke25vZGUubmFtZX3igJ3kuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KGNvbXBvbmVudCwgZ3VhcmQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIGlmIChpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShjaGlsZCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShcclxuICAgIGhlbHBlcjogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVtb3ZlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChndWFyZCAmJiBpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmUoY2hpbGQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICB9O1xyXG4gICAgcmVtb3ZlKGhlbHBlcik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBiYWNrZ3JvdW5kID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShCQUNLR1JPVU5EX05PREVfTkFNRSk7XHJcbiAgICBpZiAoIWJhY2tncm91bmQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGJhY2tncm91bmQsIG5vZGUsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKFxyXG4gICAgdGlsZWRTcHJpdGU6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIHN1cnZpdm9yLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGlsZWRTcHJpdGUgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKHRpbGVkU3ByaXRlLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZE92ZXJmbG93VmlzdWFsKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgaGVscGVyID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChoZWxwZXIpIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gQSBmbGF0dGVuZWQgbm9kZSBoYXMgbm8gbmV3IGNoaWxkIHNwZWNzIGJ5IGRlc2lnbi4gS2VlcCBldmVyeSBleGlzdGluZ1xyXG4gICAgLy8gY2hpbGQgYWxpdmUgdW50aWwgcmVtb3ZlRmxhdHRlbmVkTWFwcGVkRGVzY2VuZGFudHMgY2FuIGRpc3Rpbmd1aXNoIG9sZFxyXG4gICAgLy8gRmlnbWEtbWFwcGVkIG5vZGVzIGZyb20gdXNlci1hdXRob3JlZCBub2Rlcy4gT3RoZXJ3aXNlIGRlc3Ryb3lpbmcgdGhlXHJcbiAgICAvLyBoZWxwZXIgd291bGQgcmVjdXJzaXZlbHkgZGVzdHJveSBtYW51YWwgY2hpbGRyZW4gYXQgQ29jb3MnIGRlZmVycmVkXHJcbiAgICAvLyBkZXN0cnVjdGlvbiBib3VuZGFyeS5cclxuICAgIGNvbnN0IHByZXNlcnZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKTtcclxuICAgIGNvbnN0IG1vdmVDaGlsZHJlblRvTm9kZSA9IChjb250YWluZXI6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZ3VhcmQgfHwgcHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUobGVnYWN5KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICBjb25zdCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgY29uc3QgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50Jyk7XHJcbiAgICBpZiAoIXNjcm9sbCB8fCAhdmlldyB8fCAhY29udGVudFxyXG4gICAgICAgIHx8IChzY3JvbGwuY29udGVudCAhPT0gY29udGVudCAmJiBzY3JvbGwuY29udGVudCAhPSBudWxsKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBub2RlLCBndWFyZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICBtb3ZlQ2hpbGRyZW5Ub05vZGUoY29udGVudCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udmlldy5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGNoaWxkICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29udGVudC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICBjb250ZW50LmRlc3Ryb3koKTtcclxuICAgIHZpZXcucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgdmlldy5kZXN0cm95KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lUG9zaXRpb24oXHJcbiAgICBmcmFtZTogUmVjdCxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuICAgIGNoaWxkVHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0ge1xyXG4gICAgaWYgKCFwYXJlbnRGcmFtZSkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLCB5OiAxIH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd2lkdGggPSBmcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBjaGlsZEFuY2hvciA9IGNoaWxkVHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC8vIEZpZ21hIGNvb3JkaW5hdGVzIGFyZSBtZWFzdXJlZCBmcm9tIHRoZSBwYXJlbnQncyB0b3AtbGVmdC4gQ29udmVydFxyXG4gICAgICAgIC8vIHRoYXQgcmVjdGFuZ2xlIHRvIHRoZSBsb2NhbCBwb3NpdGlvbiBvZiB0aGUgbm9kZSdzIGNlbnRlciBhbmNob3IuXHJcbiAgICAgICAgeDogKGZyYW1lLnggLSBwYXJlbnRGcmFtZS54KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueFxyXG4gICAgICAgICAgICArIHdpZHRoICogY2hpbGRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAtIChmcmFtZS55IC0gcGFyZW50RnJhbWUueSkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIGhlaWdodCAqICgxIC0gY2hpbGRBbmNob3IueSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoc3BlYy5pc1Jvb3QgfHwgIXNwZWMuaW50cmluc2ljU2l6ZSkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IG1hdHJpeCA9IHNwZWMucmVsYXRpdmVUcmFuc2Zvcm07XHJcbiAgICBjb25zdCB2YWx1ZXMgPSBbXHJcbiAgICAgICAgbWF0cml4Py5bMF0/LlswXSwgbWF0cml4Py5bMF0/LlsxXSwgbWF0cml4Py5bMF0/LlsyXSxcclxuICAgICAgICBtYXRyaXg/LlsxXT8uWzBdLCBtYXRyaXg/LlsxXT8uWzFdLCBtYXRyaXg/LlsxXT8uWzJdLFxyXG4gICAgXTtcclxuICAgIGlmICghdmFsdWVzLmV2ZXJ5KCh2YWx1ZSkgPT4gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBbbTAwLCBtMDEsIHR4LCBtMTAsIG0xMSwgdHldID0gdmFsdWVzIGFzIG51bWJlcltdO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBwYXJlbnRTaXplID0gcGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZSA/PyB7fTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFNpemUud2lkdGgpO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHBhcmVudFdpZHRoKSB8fCAhTnVtYmVyLmlzRmluaXRlKHBhcmVudEhlaWdodCkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEgcmVsYXRpdmVUcmFuc2Zvcm0gaXMgdG9wLWxlZnQgYmFzZWQuIFRyYW5zZm9ybSB0aGUgdW5yb3RhdGVkIGxvY2FsXHJcbiAgICAvLyBjZW50ZXIsIHRoZW4gY29udmVydCB0aGUgcGFyZW50J3MgZG93bndhcmQgWSBheGlzIHRvIENvY29zIHVwd2FyZCBZLlxyXG4gICAgY29uc3QgY2VudGVyWCA9IHR4ICsgbTAwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTAxICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCBjZW50ZXJZID0gdHkgKyBtMTAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMTEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgeDogY2VudGVyWCAqIHNjYWxlIC0gcGFyZW50V2lkdGggKiBwYXJlbnRBbmNob3IueCxcclxuICAgICAgICB5OiBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KSAtIGNlbnRlclkgKiBzY2FsZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtOiBhbnksIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XG4gICAgLy8gUm91bmQgb25seSBhdCB0aGUgVUlUcmFuc2Zvcm0gd3JpdGUgYm91bmRhcnksIGFmdGVyIHNjYWxlL2xheW91dCBtYXRoLlxuICAgIC8vIERvIG5vdCBsb2NrIHNpemVzIHJlY2FsY3VsYXRlZCBsYXRlciBieSBMYWJlbCBvciBvdGhlciBydW50aW1lIGNvbXBvbmVudHMuXG4gICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZShcbiAgICAgICAgTWF0aC5yb3VuZCgod2lkdGggKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICAgICBNYXRoLnJvdW5kKChoZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwLFxuICAgICk7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IGFueSB7XG4gICAgY29uc3QgeyBVSVRyYW5zZm9ybSwgVmVjMyB9ID0gY2M7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gbm9kZS5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIGNvbnN0IHNpemUgPSBzcGVjLmludHJpbnNpY1NpemUgPz8gc3BlYy5mcmFtZTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBub2RlLnBhcmVudD8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3BlYy5pc1Jvb3RcclxuICAgICAgICA/IHsgeDogMCwgeTogMCB9XHJcbiAgICAgICAgOiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKHNwZWMsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IGZyYW1lUG9zaXRpb24oc3BlYy5mcmFtZSwgc3BlYy5wYXJlbnRGcmFtZSwgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSwgdHJhbnNmb3JtKTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbiAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIHNwZWMucm90YXRpb24pO1xyXG4gICAgbm9kZS5hY3RpdmUgPSBzcGVjLnZpc2libGU7XHJcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZFBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC50eXBlID09PSAnU09MSUQnXHJcbiAgICAgICAgJiYgcGFpbnQudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDBcclxuICAgICAgICAmJiBCb29sZWFuKHBhaW50LmNvbG9yKVxyXG4gICAgICAgICYmIChwYWludC5jb2xvcj8uYSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRGaWxsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiB2aXNpYmxlU29saWRQYWludChzcGVjLmZpbGxzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmFsaWRTb2xpZFN0cm9rZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gc3BlYy5zdHJva2VXZWlnaHQgPiAwID8gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5zdHJva2VzKSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzR3JhcGhpY3NWaXN1YWwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odmlzaWJsZVNvbGlkRmlsbChzcGVjKSB8fCB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0dyYXBoaWNzKGdyYXBoaWNzOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlU29saWRGaWxsKHNwZWMpO1xyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmFsaWRTb2xpZFN0cm9rZShzcGVjKTtcclxuICAgIGlmICghZmlsbCAmJiAhc3Ryb2tlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmFkaXVzID0gTWF0aC5tYXgoXHJcbiAgICAgICAgMCxcclxuICAgICAgICBNYXRoLm1pbihNYXRoLm1pbiguLi5zcGVjLmNvcm5lclJhZGlpKSAqIHNjYWxlLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpLFxyXG4gICAgKTtcclxuICAgIGlmIChzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZWxsaXBzZSgwLCAwLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpO1xyXG4gICAgfSBlbHNlIGlmIChyYWRpdXMgPiAwKSB7XHJcbiAgICAgICAgZ3JhcGhpY3Mucm91bmRSZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0LCByYWRpdXMpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBncmFwaGljcy5yZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0KTtcclxuICAgIH1cclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGxDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5maWxsKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmxpbmVXaWR0aCA9IE1hdGgubWF4KDAuNSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHcmFwaGljcyhub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGdyYXBoaWNzID0gbm9kZS5nZXRDb21wb25lbnQoY2MuR3JhcGhpY3MpID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkdyYXBoaWNzKTtcclxuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgZ3JhcGhpY3MuY2xlYXIoKTtcclxuICAgIGRyYXdHcmFwaGljcyhncmFwaGljcywgc3BlYywgc2NhbGUsIGNjKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplTGFiZWxUZXh0KGNoYXJhY3RlcnM6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gKGNoYXJhY3RlcnMgPz8gJycpXHJcbiAgICAgICAgLnJlcGxhY2UoL1xcclxcbi9nLCAnXFxuJylcclxuICAgICAgICAucmVwbGFjZSgvW1xcclxcdTIwMjhcXHUyMDI5XS9nLCAnXFxuJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5VGV4dEFsaWdubWVudChjb21wb25lbnQ6IGFueSwgc3R5bGU6IFNjZW5lTm9kZVNwZWNbJ3RleHRTdHlsZSddLCByZW5kZXJlcjogYW55KTogdm9pZCB7XG4gICAgLy8gQ29jb3MgaGFzIG5vIEpVU1RJRklFRCBhbGlnbm1lbnQ6IHVuc3VwcG9ydGVkL21pc3NpbmcgdmFsdWVzIHVzZSBMRUZUL1RPUC5cbiAgICBjb21wb25lbnQuaG9yaXpvbnRhbEFsaWduID0gc3R5bGU/LnRleHRBbGlnbkhvcml6b250YWwgPT09ICdDRU5URVInXG4gICAgICAgID8gcmVuZGVyZXIuSG9yaXpvbnRhbEFsaWduLkNFTlRFUlxuICAgICAgICA6IHN0eWxlPy50ZXh0QWxpZ25Ib3Jpem9udGFsID09PSAnUklHSFQnXG4gICAgICAgICAgICA/IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5SSUdIVFxuICAgICAgICAgICAgOiByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uTEVGVDtcbiAgICBjb21wb25lbnQudmVydGljYWxBbGlnbiA9IHN0eWxlPy50ZXh0QWxpZ25WZXJ0aWNhbCA9PT0gJ0NFTlRFUidcbiAgICAgICAgPyByZW5kZXJlci5WZXJ0aWNhbEFsaWduLkNFTlRFUlxuICAgICAgICA6IHN0eWxlPy50ZXh0QWxpZ25WZXJ0aWNhbCA9PT0gJ0JPVFRPTSdcbiAgICAgICAgICAgID8gcmVuZGVyZXIuVmVydGljYWxBbGlnbi5CT1RUT01cbiAgICAgICAgICAgIDogcmVuZGVyZXIuVmVydGljYWxBbGlnbi5UT1A7XG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYVBhbmVsRm9udFNpemUodmFsdWU6IG51bWJlciB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gICAgY29uc3QgZm9udFNpemUgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IDE2O1xuICAgIHJldHVybiBNYXRoLnJvdW5kKChmb250U2l6ZSArIE51bWJlci5FUFNJTE9OKSAqIDEwMCkgLyAxMDA7XG59XG5cbmZ1bmN0aW9uIGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICAgIGNvbnN0IGxpbmVIZWlnaHQgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IDE2O1xuICAgIC8vIFByZXNlcnZlIEZpZ21hJ3MgcGl4ZWwgbGluZSBoZWlnaHQgaW5kZXBlbmRlbnRseSBvZiBpbXBvcnQgc2NhbGUgYW5kXG4gICAgLy8gZW5naW5lLWNvbXB1dGVkIGNvbnRlbnQgc2l6ZTsgb25seSByb3VuZCB0byBvbmUgZGVjaW1hbCBwbGFjZS5cbiAgICByZXR1cm4gTWF0aC5yb3VuZCgobGluZUhlaWdodCArIE51bWJlci5FUFNJTE9OKSAqIDEwKSAvIDEwO1xufVxuXG5mdW5jdGlvbiBjb25maWd1cmVMYWJlbChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgTGFiZWwgfSA9IGNjO1xyXG4gICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIGNvbnN0IGNoYXJhY3RlcnMgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIC8vIEZpZ21hIE5PTkUgbWVhbnMgYSBmaXhlZCBib3gsIG5vdCBDb2NvcyBPdmVyZmxvdy5OT05FLiBCb3RoIGZpeGVkLXdpZHRoXG4gICAgLy8gbW9kZXMgd3JhcCBhbmQgZ3JvdyB2ZXJ0aWNhbGx5OyBtaXNzaW5nIGxlZ2FjeSBtZXRhZGF0YSBzdGF5cyBhdXRvLXdpZHRoLlxuICAgIGNvbnN0IHdyYXAgPSBzdHlsZS50ZXh0QXV0b1Jlc2l6ZSA9PT0gJ0hFSUdIVCcgfHwgc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdOT05FJztcbiAgICAvLyBGaWdtYSBzdG9yZXMgbW9yZSBwcmVjaXNpb24gdGhhbiBpdHMgcGFuZWwgZGlzcGxheXMuIE1hdGNoIHRoZSB2aXNpYmxlXHJcbiAgICAvLyBkZXNpZ24gdmFsdWUgKHVwIHRvIHR3byBkZWNpbWFscykgaW5zdGVhZCBvZiBsZWFraW5nIGl0cyBpbnRlcm5hbCBmbG9hdC5cclxuICAgIGxhYmVsLmZvbnRTaXplID0gZmlnbWFQYW5lbEZvbnRTaXplKHN0eWxlLmZvbnRTaXplKTtcclxuICAgIGxhYmVsLmxpbmVIZWlnaHQgPSBmaWdtYVBhbmVsTGluZUhlaWdodChzdHlsZS5saW5lSGVpZ2h0UHggPz8gc3R5bGUuZm9udFNpemUpO1xuICAgIGxhYmVsLnNwYWNpbmdYID0gKHN0eWxlLmxldHRlclNwYWNpbmcgPz8gMCkgKiBzY2FsZTtcclxuICAgIGxhYmVsLm92ZXJmbG93ID0gd3JhcCA/IExhYmVsLk92ZXJmbG93LlJFU0laRV9IRUlHSFQgOiBMYWJlbC5PdmVyZmxvdy5OT05FO1xuICAgIGxhYmVsLmVuYWJsZVdyYXBUZXh0ID0gd3JhcDtcbiAgICBhcHBseVRleHRBbGlnbm1lbnQobGFiZWwsIHN0eWxlLCBMYWJlbCk7XG4gICAgLy8gQXV0by13aWR0aCBsYWJlbHMgdXNlIGEgY2VudGVyZWQgdmVydGljYWwgYmFzZWxpbmUgcmVnYXJkbGVzcyBvZiBGaWdtYSdzXG4gICAgLy8gdmVydGljYWwgYWxpZ25tZW50LiBGaXhlZC13aWR0aCB3cmFwcGluZyBsYWJlbHMgcmV0YWluIHRoZSBGaWdtYSBzZXR0aW5nLlxuICAgIGlmIChsYWJlbC5vdmVyZmxvdyA9PT0gTGFiZWwuT3ZlcmZsb3cuTk9ORSkge1xuICAgICAgICBsYWJlbC52ZXJ0aWNhbEFsaWduID0gTGFiZWwuVmVydGljYWxBbGlnbi5DRU5URVI7XG4gICAgfVxuICAgIGxhYmVsLnN0cmluZyA9IGNoYXJhY3RlcnM7XG4gICAgbGFiZWwuZW5hYmxlT3V0bGluZSA9IGZhbHNlO1xyXG4gICAgbGFiZWwuY29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IDEgfSk7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVBhaW50KHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgbGFiZWwuY29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdHJva2UgPSB2aXNpYmxlUGFpbnQoc3BlYy5zdHJva2VzKTtcclxuICAgIGlmIChzdHJva2U/LmNvbG9yICYmIHNwZWMuc3Ryb2tlV2VpZ2h0ID4gMCkge1xyXG4gICAgICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSB0cnVlO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZVdpZHRoID0gTWF0aC5tYXgoMSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBSaWNoVGV4dCB9ID0gY2M7XHJcbiAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KSA/PyBub2RlLmFkZENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgcmljaFRleHQuc3RyaW5nID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICByaWNoVGV4dC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICByaWNoVGV4dC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcbiAgICByaWNoVGV4dC5tYXhXaWR0aCA9IE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5oYW5kbGVUb3VjaEV2ZW50ID0gZmFsc2U7XHJcbiAgICBhcHBseVRleHRBbGlnbm1lbnQocmljaFRleHQsIHN0eWxlLCBSaWNoVGV4dCk7XG4gICAgcmljaFRleHQuZm9udEZhbWlseSA9IHN0eWxlLmZvbnRGYW1pbHkgPz8gJyc7XHJcbiAgICByaWNoVGV4dC51c2VTeXN0ZW1Gb250ID0gIXNwZWMuZm9udFV1aWQ7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVBhaW50KHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgcmljaFRleHQuZm9udENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBsb2FkQXNzZXQoYXNzZXRNYW5hZ2VyOiBhbnksIHV1aWQ6IHN0cmluZyk6IFByb21pc2U8YW55PiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICAgIGFzc2V0TWFuYWdlci5sb2FkQW55KHsgdXVpZCB9LCAoZXJyb3I6IEVycm9yIHwgbnVsbCwgYXNzZXQ6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHJlamVjdChlcnJvcik7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVzb2x2ZShhc3NldCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlU3ByaXRlKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgdGFyZ2V0RnJhbWU6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSA9IHNwZWMuZnJhbWUsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKCFzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHsgU3ByaXRlLCBVSVRyYW5zZm9ybSwgYXNzZXRNYW5hZ2VyIH0gPSBjYztcclxuICAgIGNvbnN0IHNwcml0ZSA9IG5vZGUuZ2V0Q29tcG9uZW50KFNwcml0ZSkgPz8gbm9kZS5hZGRDb21wb25lbnQoU3ByaXRlKTtcclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHRhcmdldFdpZHRoID0gTWF0aC5tYXgoMCwgdGFyZ2V0RnJhbWUud2lkdGggKiBzY2FsZSk7XHJcbiAgICBjb25zdCB0YXJnZXRIZWlnaHQgPSBNYXRoLm1heCgwLCB0YXJnZXRGcmFtZS5oZWlnaHQgKiBzY2FsZSk7XHJcblxyXG4gICAgLy8gS2VlcCBhc3NpZ25tZW50IGRldGVybWluaXN0aWM6IGEgbmV3IFNwcml0ZSBtYXkgZGVmYXVsdCB0byBUUklNTUVEIGFuZFxyXG4gICAgLy8gaW1tZWRpYXRlbHkgcmV3cml0ZSBVSVRyYW5zZm9ybSB3aGVuIGl0cyBTcHJpdGVGcmFtZSBpcyBhc3NpZ25lZC5cclxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XHJcbiAgICBjb25zdCBzcHJpdGVGcmFtZSA9IGF3YWl0IGxvYWRBc3NldChhc3NldE1hbmFnZXIsIHNwZWMuc3ByaXRlLnV1aWQpO1xuICAgIHNwcml0ZS5zcHJpdGVGcmFtZSA9IHNwcml0ZUZyYW1lO1xuICAgIGNvbnN0IHNsaWNlZCA9IHNwZWMuc3ByaXRlLnNsaWNlZCB8fCAoIXNwZWMuc3ByaXRlLnNsaWNlRmFsbGJhY2tcbiAgICAgICAgJiYgW3Nwcml0ZUZyYW1lLmluc2V0TGVmdCwgc3ByaXRlRnJhbWUuaW5zZXRSaWdodCwgc3ByaXRlRnJhbWUuaW5zZXRUb3AsIHNwcml0ZUZyYW1lLmluc2V0Qm90dG9tXVxuICAgICAgICAgICAgLnNvbWUoKHZhbHVlKSA9PiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpICYmIHZhbHVlID4gMCkpO1xuICAgIHNwcml0ZS50eXBlID0gc3BlYy5zcHJpdGUudGlsZWRcbiAgICAgICAgPyBTcHJpdGUuVHlwZS5USUxFRFxuICAgICAgICA6IHNsaWNlZFxuICAgICAgICAgICAgPyBTcHJpdGUuVHlwZS5TTElDRURcclxuICAgICAgICAgICAgOiBTcHJpdGUuVHlwZS5TSU1QTEU7XHJcblxyXG4gICAgaWYgKCFzbGljZWQgJiYgIXNwZWMuc3ByaXRlLnRpbGVkKSB7XG4gICAgICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5UUklNTUVEO1xyXG4gICAgICAgIGNvbnN0IHRyaW1tZWRXaWR0aCA9IE51bWJlcih0cmFuc2Zvcm0/LmNvbnRlbnRTaXplPy53aWR0aCk7XHJcbiAgICAgICAgY29uc3QgdHJpbW1lZEhlaWdodCA9IE51bWJlcih0cmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpO1xyXG4gICAgICAgIGNvbnN0IHJhd1dpZHRoID0gTnVtYmVyKHNwcml0ZUZyYW1lPy5vcmlnaW5hbFNpemU/LndpZHRoID8/IHNwcml0ZUZyYW1lPy53aWR0aCk7XHJcbiAgICAgICAgY29uc3QgcmF3SGVpZ2h0ID0gTnVtYmVyKHNwcml0ZUZyYW1lPy5vcmlnaW5hbFNpemU/LmhlaWdodCA/PyBzcHJpdGVGcmFtZT8uaGVpZ2h0KTtcclxuICAgICAgICBjb25zdCBoYXNWYWxpZFNwcml0ZVNpemUgPSBOdW1iZXIuaXNGaW5pdGUodHJpbW1lZFdpZHRoKVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUodHJpbW1lZEhlaWdodClcclxuICAgICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKHJhd1dpZHRoKVxyXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3SGVpZ2h0KVxyXG4gICAgICAgICAgICAmJiByYXdXaWR0aCA+IDBcclxuICAgICAgICAgICAgJiYgcmF3SGVpZ2h0ID4gMDtcclxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplXHJcbiAgICAgICAgICAgICYmIE1hdGguYWJzKHJhd1dpZHRoIC0gdGFyZ2V0V2lkdGgpIDw9IDAuNTFcclxuICAgICAgICAgICAgJiYgTWF0aC5hYnMocmF3SGVpZ2h0IC0gdGFyZ2V0SGVpZ2h0KSA8PSAwLjUxKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGhhc1ZhbGlkU3ByaXRlU2l6ZSkge1xyXG4gICAgICAgICAgICBjb25zdCBzY2FsZVggPSB0YXJnZXRXaWR0aCAvIHJhd1dpZHRoO1xyXG4gICAgICAgICAgICBjb25zdCBzY2FsZVkgPSB0YXJnZXRIZWlnaHQgLyByYXdIZWlnaHQ7XHJcbiAgICAgICAgICAgIGlmIChNYXRoLmFicyhzY2FsZVggLSBzY2FsZVkpIDw9IDAuMDAwMSkge1xyXG4gICAgICAgICAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgICAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0cmltbWVkV2lkdGggKiBzY2FsZVgsIHRyaW1tZWRIZWlnaHQgKiBzY2FsZVkpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBTbGljZWQvdGlsZWQgc3ByaXRlcyBhbmQgc3ByaXRlcyByZXNpemVkIGluIEZpZ21hIG11c3QgcmV0YWluIHRoZSBkZXNpZ25cclxuICAgIC8vIHNpemUuIENvY29zIHJlcHJlc2VudHMgdGhhdCBzdGF0ZSBhcyBDVVNUT00uXHJcbiAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIHRhcmdldFdpZHRoLCB0YXJnZXRIZWlnaHQpO1xufVxyXG5cclxuZnVuY3Rpb24gcmVxdWlyZXNUaWxlZE1hc2soc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnRpbGVkICYmIHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBuYXRpdmVUaWxlU2NhbGUoc3BlYzogU2NlbmVOb2RlU3BlYyk6IG51bWJlciB7XHJcbiAgICBjb25zdCBzY2FsZSA9IHNwZWMuc3ByaXRlPy50aWxlU2NhbGU7XHJcbiAgICByZXR1cm4gdHlwZW9mIHNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoc2NhbGUpICYmIHNjYWxlID4gMFxyXG4gICAgICAgID8gc2NhbGVcclxuICAgICAgICA6IDE7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihzcGVjLnNwcml0ZT8udGlsZWQpXHJcbiAgICAgICAgJiYgKHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpIHx8IE1hdGguYWJzKG5hdGl2ZVRpbGVTY2FsZShzcGVjKSAtIDEpID4gMWUtNik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVzZXNPdmVyZmxvd1Nwcml0ZUhlbHBlcihzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihzcGVjLnNwcml0ZT8ucmVuZGVyRnJhbWUpXHJcbiAgICAgICAgJiYgIXNwZWMuc3ByaXRlPy5zbGljZWRcclxuICAgICAgICAmJiAhc3BlYy5zcHJpdGU/LnRpbGVkO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVPdmVyZmxvd1Nwcml0ZUhlbHBlcihcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVuZGVyRnJhbWUgPSBzcGVjLnNwcml0ZT8ucmVuZGVyRnJhbWU7XHJcbiAgICBpZiAoIXJlbmRlckZyYW1lKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDotoXovrnnlYwgUE5HIOiKgueCueKAnCR7c3BlYy5uYW1lfeKAnee8uuWwkea4suafk+i+ueeVjOOAgmApO1xyXG4gICAgfVxyXG4gICAgbGV0IGhlbHBlciA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQgJiYgaGVscGVyKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFoZWxwZXIpIHtcclxuICAgICAgICBoZWxwZXIgPSBuZXcgY2MuTm9kZShPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgICAgICBub2RlLmFkZENoaWxkKGhlbHBlcik7XHJcbiAgICB9XHJcbiAgICBoZWxwZXIubmFtZSA9IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUU7XHJcbiAgICBoZWxwZXIubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgaGVscGVyLmFjdGl2ZSA9IHRydWU7XHJcblxyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gaGVscGVyLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSlcclxuICAgICAgICA/PyBoZWxwZXIuYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxuICAgICAgICB0cmFuc2Zvcm0sXG4gICAgICAgIE1hdGgubWF4KDAsIHJlbmRlckZyYW1lLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHJlbmRlckZyYW1lLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUoaGVscGVyLCBzcGVjLCBzY2FsZSwgY2MsIHJlbmRlckZyYW1lKTtcclxuXHJcbiAgICBjb25zdCBnZW9tZXRyeUNlbnRlclggPSBzcGVjLmZyYW1lLnggKyBzcGVjLmZyYW1lLndpZHRoIC8gMjtcclxuICAgIGNvbnN0IGdlb21ldHJ5Q2VudGVyWSA9IHNwZWMuZnJhbWUueSArIHNwZWMuZnJhbWUuaGVpZ2h0IC8gMjtcclxuICAgIGNvbnN0IHJlbmRlckNlbnRlclggPSByZW5kZXJGcmFtZS54ICsgcmVuZGVyRnJhbWUud2lkdGggLyAyO1xyXG4gICAgY29uc3QgcmVuZGVyQ2VudGVyWSA9IHJlbmRlckZyYW1lLnkgKyByZW5kZXJGcmFtZS5oZWlnaHQgLyAyO1xyXG4gICAgLy8gRmlnbWEgcGFnZSBZIHBvaW50cyBkb3dud2FyZCB3aGlsZSBDb2NvcyBVSSBZIHBvaW50cyB1cHdhcmQuXHJcbiAgICBjb25zdCB3b3JsZERlbHRhWCA9IChyZW5kZXJDZW50ZXJYIC0gZ2VvbWV0cnlDZW50ZXJYKSAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd29ybGREZWx0YVkgPSAtKHJlbmRlckNlbnRlclkgLSBnZW9tZXRyeUNlbnRlclkpICogc2NhbGU7XHJcbiAgICBjb25zdCB3b3JsZFJvdGF0aW9uID0gTnVtYmVyLmlzRmluaXRlKHNwZWMud29ybGRSb3RhdGlvbilcclxuICAgICAgICA/IE51bWJlcihzcGVjLndvcmxkUm90YXRpb24pXHJcbiAgICAgICAgOiBzcGVjLnJvdGF0aW9uO1xyXG4gICAgY29uc3QgcmFkaWFucyA9IHdvcmxkUm90YXRpb24gKiBNYXRoLlBJIC8gMTgwO1xyXG4gICAgY29uc3QgY29zaW5lID0gTWF0aC5jb3MocmFkaWFucyk7XHJcbiAgICBjb25zdCBzaW5lID0gTWF0aC5zaW4ocmFkaWFucyk7XHJcbiAgICAvLyBUaGUgZXhwb3J0ZWQgUE5HIGlzIGFscmVhZHkgcmFzdGVyaXplZCBpbiBGaWdtYSBwYWdlIGF4ZXMuIENvdW50ZXJhY3RcclxuICAgIC8vIHRoZSBsb2dpY2FsIHNoZWxsJ3MgYWNjdW11bGF0ZWQgcm90YXRpb24gYW5kIGV4cHJlc3MgdGhlIHZpc3VhbC1jZW50ZXJcclxuICAgIC8vIG9mZnNldCBiYWNrIGluIHRoYXQgc2hlbGwncyBsb2NhbCBjb29yZGluYXRlIHN5c3RlbS5cclxuICAgIGNvbnN0IGxvY2FsWCA9IGNvc2luZSAqIHdvcmxkRGVsdGFYICsgc2luZSAqIHdvcmxkRGVsdGFZO1xyXG4gICAgY29uc3QgbG9jYWxZID0gLXNpbmUgKiB3b3JsZERlbHRhWCArIGNvc2luZSAqIHdvcmxkRGVsdGFZO1xyXG4gICAgaGVscGVyLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKGxvY2FsWCwgbG9jYWxZLCAwKSk7XHJcbiAgICBoZWxwZXIuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgLXdvcmxkUm90YXRpb24pO1xyXG4gICAgaGVscGVyLnNldFNjYWxlKG5ldyBjYy5WZWMzKDEsIDEsIDEpKTtcclxuICAgIGhlbHBlci5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBuZWVkc01hc2sgPSByZXF1aXJlc1RpbGVkTWFzayhzcGVjKTtcclxuICAgIGxldCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGxldCB0aWxlZFNwcml0ZSA9IHRpbGVkTWFzaz8uZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSlcclxuICAgICAgICA/PyBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodGlsZWRNYXNrLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobmVlZHNNYXNrKSB7XHJcbiAgICAgICAgaWYgKCF0aWxlZE1hc2spIHtcclxuICAgICAgICAgICAgdGlsZWRNYXNrID0gbmV3IGNjLk5vZGUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICBub2RlLmFkZENoaWxkKHRpbGVkTWFzayk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRpbGVkTWFzay5uYW1lID0gVElMRURfTUFTS19OT0RFX05BTUU7XHJcbiAgICAgICAgdGlsZWRNYXNrLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICB0aWxlZE1hc2suYWN0aXZlID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBtYXNrVHJhbnNmb3JtID0gdGlsZWRNYXNrLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSlcclxuICAgICAgICAgICAgPz8gdGlsZWRNYXNrLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgbWFza1RyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgICAgIG1hc2tUcmFuc2Zvcm0sXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICAgICAgY29uZmlndXJlQ2xpcCh0aWxlZE1hc2ssIHNwZWMsIGNjKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0U2libGluZ0luZGV4KDApO1xyXG4gICAgfSBlbHNlIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi50aWxlZE1hc2suY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRpbGVkTWFzay5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgdGlsZWRNYXNrLmRlc3Ryb3koKTtcclxuICAgICAgICB0aWxlZE1hc2sgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3ByaXRlUGFyZW50ID0gdGlsZWRNYXNrID8/IG5vZGU7XHJcbiAgICBpZiAoIXRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUgPSBuZXcgY2MuTm9kZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgICAgICBzcHJpdGVQYXJlbnQuYWRkQ2hpbGQodGlsZWRTcHJpdGUpO1xyXG4gICAgfSBlbHNlIGlmICh0aWxlZFNwcml0ZS5wYXJlbnQgIT09IHNwcml0ZVBhcmVudCkge1xyXG4gICAgICAgIHRpbGVkU3ByaXRlLnBhcmVudCA9IHNwcml0ZVBhcmVudDtcclxuICAgIH1cclxuICAgIHRpbGVkU3ByaXRlLm5hbWUgPSBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FO1xyXG4gICAgdGlsZWRTcHJpdGUubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgdGlsZWRTcHJpdGUuYWN0aXZlID0gdHJ1ZTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZSh0aWxlZFNwcml0ZSwgc3BlYywgc2NhbGUsIGNjKTtcclxuICAgIGNvbnN0IHRpbGVTY2FsZSA9IG5hdGl2ZVRpbGVTY2FsZShzcGVjKTtcclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IHRpbGVkU3ByaXRlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSlcclxuICAgICAgICA/PyB0aWxlZFNwcml0ZS5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgIHRyYW5zZm9ybSxcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNjYWxlKG5ldyBjYy5WZWMzKHRpbGVTY2FsZSwgdGlsZVNjYWxlLCAxKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZU9wYWNpdHkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5ID49IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3BhY2l0eSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJT3BhY2l0eSkgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcclxuICAgIG9wYWNpdHkub3BhY2l0eSA9IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc3BlYy5vcGFjaXR5KSkgKiAyNTUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYXlvdXQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoIW1vZGUgfHwgbW9kZSA9PT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBMYXlvdXQsIFNpemUgfSA9IGNjO1xyXG4gICAgY29uc3QgbGF5b3V0ID0gbm9kZS5nZXRDb21wb25lbnQoTGF5b3V0KSA/PyBub2RlLmFkZENvbXBvbmVudChMYXlvdXQpO1xyXG4gICAgbGF5b3V0LnR5cGUgPSBtb2RlID09PSAnSE9SSVpPTlRBTCdcclxuICAgICAgICA/IExheW91dC5UeXBlLkhPUklaT05UQUxcclxuICAgICAgICA6IG1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuVHlwZS5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5UeXBlLkdSSUQ7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnKSB7XHJcbiAgICAgICAgbGF5b3V0LnN0YXJ0QXhpcyA9IHNwZWMubGF5b3V0Py5zb3VyY2VNb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LkF4aXNEaXJlY3Rpb24uVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuQXhpc0RpcmVjdGlvbi5IT1JJWk9OVEFMO1xyXG4gICAgfVxyXG4gICAgbGF5b3V0LnJlc2l6ZU1vZGUgPSBMYXlvdXQuUmVzaXplTW9kZS5OT05FO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdMZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1JpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdUb3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdCb3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdYID0gc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1kgPSAobW9kZSA9PT0gJ0dSSUQnID8gc3BlYy5sYXlvdXQhLmNvdW50ZXJTcGFjaW5nIDogc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nKSAqIHNjYWxlO1xyXG4gICAgY29uc3QgYWN0aXZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUpO1xyXG4gICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbldpZHRoID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUud2lkdGggKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nTGVmdCAtIGxheW91dC5wYWRkaW5nUmlnaHQ7XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWCA9IE1hdGgubWF4KDAsIChpbm5lcldpZHRoIC0gY2hpbGRyZW5XaWR0aCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbldpZHRoICsgbGF5b3V0LnNwYWNpbmdYICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVyV2lkdGggLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gJ1ZFUlRJQ0FMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbkhlaWdodCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLmhlaWdodCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lckhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ1RvcCAtIGxheW91dC5wYWRkaW5nQm90dG9tO1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1kgPSBNYXRoLm1heCgwLCAoaW5uZXJIZWlnaHQgLSBjaGlsZHJlbkhlaWdodCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbkhlaWdodCArIGxheW91dC5zcGFjaW5nWSAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lckhlaWdodCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBsYXlvdXQuY2VsbFNpemUgPSBuZXcgU2l6ZShcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS53aWR0aCkpICogc2NhbGUsXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUuaGVpZ2h0KSkgKiBzY2FsZSxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseUNvdW50ZXJBbGlnbm1lbnQoXHJcbiAgICBwYXJlbnQ6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgY29uc3QgYWxpZ25tZW50ID0gc3BlYy5sYXlvdXQ/LmNvdW50ZXJBbGlnbjtcclxuICAgIGlmICghbW9kZSB8fCAhYWxpZ25tZW50IHx8ICFbJ0hPUklaT05UQUwnLCAnVkVSVElDQUwnXS5pbmNsdWRlcyhtb2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IHBhcmVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0V2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB0b3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgY29uc3QgYm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgZm9yIChjb25zdCBjaGlsZFNwZWMgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkU3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBjaGlsZCA9IHV1aWQgPyBmaW5kQnlVdWlkKHBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNoaWxkPy5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIGlmICghY2hpbGQgfHwgIXRyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSBjaGlsZC5wb3NpdGlvbi5jbG9uZSgpO1xyXG4gICAgICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0SGVpZ2h0IC0gdG9wIC0gYm90dG9tKTtcclxuICAgICAgICAgICAgbGV0IHRvcE9mZnNldCA9IHRvcDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IHRvcCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0uaGVpZ2h0KSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gbGF5b3V0SGVpZ2h0IC0gYm90dG9tIC0gdHJhbnNmb3JtLmhlaWdodDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0cmFuc2Zvcm0ud2lkdGgsIGF2YWlsYWJsZSk7XG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBvc2l0aW9uLnkgPSBwYXJlbnRIZWlnaHQgKiAoMSAtIHBhcmVudEFuY2hvci55KVxyXG4gICAgICAgICAgICAgICAgLSB0b3BPZmZzZXRcclxuICAgICAgICAgICAgICAgIC0gdHJhbnNmb3JtLmhlaWdodCAqICgxIC0gKHRyYW5zZm9ybS5hbmNob3JQb2ludD8ueSA/PyAwLjUpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCgwLCBsYXlvdXRXaWR0aCAtIGxlZnQgLSByaWdodCk7XHJcbiAgICAgICAgICAgIGxldCBsZWZ0T2Zmc2V0ID0gbGVmdDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxlZnRPZmZzZXQgPSBsZWZ0ICsgKGF2YWlsYWJsZSAtIHRyYW5zZm9ybS53aWR0aCkgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKGFsaWdubWVudCA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxlZnRPZmZzZXQgPSBsYXlvdXRXaWR0aCAtIHJpZ2h0IC0gdHJhbnNmb3JtLndpZHRoO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ1NUUkVUQ0gnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZSh0cmFuc2Zvcm0sIGF2YWlsYWJsZSwgdHJhbnNmb3JtLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBvc2l0aW9uLnggPSBsZWZ0T2Zmc2V0XHJcbiAgICAgICAgICAgICAgICAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLnhcclxuICAgICAgICAgICAgICAgICsgdHJhbnNmb3JtLndpZHRoICogKHRyYW5zZm9ybS5hbmNob3JQb2ludD8ueCA/PyAwLjUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjaGlsZC5zZXRQb3NpdGlvbihwb3NpdGlvbik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUNsaXAobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBncmFwaGljcyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKTtcclxuICAgIGlmIChncmFwaGljcykge1xyXG4gICAgICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgICAgIGdyYXBoaWNzLmNsZWFyKCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBtYXNrID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTWFzaykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuTWFzayk7XHJcbiAgICBtYXNrLnR5cGUgPSBzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnXHJcbiAgICAgICAgPyBjYy5NYXNrLlR5cGUuR1JBUEhJQ1NfRUxMSVBTRSA/PyBjYy5NYXNrLlR5cGUuRUxMSVBTRVxyXG4gICAgICAgIDogY2MuTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gY2MuTWFzay5UeXBlLlJFQ1Q7XHJcbiAgICBtYXNrLmludmVydGVkID0gZmFsc2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xuICAgIC8vIFRoZSBpbXBvcnRlZCByb290IGlzIGEgc2NyZWVuIGNvbnRhaW5lciwgbm90IGEgY2xpcHBpbmcgdmlld3BvcnQuXG4gICAgcmV0dXJuICFzcGVjLmlzUm9vdFxuICAgICAgICAmJiBzcGVjLmNsaXBzQ29udGVudFxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID4gMFxyXG4gICAgICAgICYmIHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNCdXR0b25BbmNlc3Rvcihub2RlOiBhbnksIGNjOiBhbnkpOiBib29sZWFuIHtcbiAgICBmb3IgKGxldCBwYXJlbnQgPSBub2RlLnBhcmVudDsgcGFyZW50OyBwYXJlbnQgPSBwYXJlbnQucGFyZW50KSB7XG4gICAgICAgIGlmIChwYXJlbnQuZ2V0Q29tcG9uZW50KGNjLkJ1dHRvbikpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZUJ1dHRvbihub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJyAmJiAhaGFzQnV0dG9uQW5jZXN0b3Iobm9kZSwgY2MpKSB7XG4gICAgICAgIGNvbnN0IGJ1dHRvbiA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkJ1dHRvbikgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuQnV0dG9uKTtcclxuICAgICAgICBidXR0b24udGFyZ2V0ID0gbm9kZTtcclxuICAgICAgICBidXR0b24udHJhbnNpdGlvbiA9IGNjLkJ1dHRvbi5UcmFuc2l0aW9uLlNDQUxFO1xyXG4gICAgICAgIGJ1dHRvbi56b29tU2NhbGUgPSAwLjk7XHJcbiAgICAgICAgYnV0dG9uLmR1cmF0aW9uID0gMC4xO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHJhbnNmb3JtOiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IGFueSB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHsgTm9kZSwgVUlUcmFuc2Zvcm0sIE1hc2ssIFNjcm9sbFZpZXcgfSA9IGNjO1xyXG4gICAgbGV0IHZpZXcgPSBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk7XHJcbiAgICBsZXQgY29udGVudCA9IHZpZXc/LmdldENoaWxkQnlOYW1lKCdjb250ZW50JykgPz8gbnVsbDtcclxuICAgIGlmICh2aWV3ICYmIGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIGd1YXJkKTtcclxuICAgICAgICBpZiAoY29udGVudCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUoY29udGVudCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNjcm9sbCA9IG5vZGUuZ2V0Q29tcG9uZW50KFNjcm9sbFZpZXcpID8/IG5vZGUuYWRkQ29tcG9uZW50KFNjcm9sbFZpZXcpO1xyXG4gICAgaWYgKCF2aWV3KSB7XHJcbiAgICAgICAgdmlldyA9IG5ldyBOb2RlKCd2aWV3Jyk7XHJcbiAgICAgICAgdmlldy5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgbm9kZS5hZGRDaGlsZCh2aWV3KTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZpZXdUcmFuc2Zvcm0gPSB2aWV3LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gdmlldy5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdmlld1RyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHZpZXdUcmFuc2Zvcm0sIHRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCwgdHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodCk7XG4gICAgdmlldy5zZXRQb3NpdGlvbigwLCAwLCAwKTtcclxuICAgIGNvbnN0IG1hc2sgPSB2aWV3LmdldENvbXBvbmVudChNYXNrKSA/PyB2aWV3LmFkZENvbXBvbmVudChNYXNrKTtcclxuICAgIG1hc2sudHlwZSA9IE1hc2suVHlwZS5HUkFQSElDU19SRUNUID8/IE1hc2suVHlwZS5SRUNUO1xyXG4gICAgaWYgKCFjb250ZW50KSB7XHJcbiAgICAgICAgY29udGVudCA9IG5ldyBOb2RlKCdjb250ZW50Jyk7XHJcbiAgICAgICAgY29udGVudC5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdmlldy5hZGRDaGlsZChjb250ZW50KTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRlbnRUcmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gY29udGVudC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcHJldmlvdXNMYXlvdXQgPSBjb250ZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpO1xyXG4gICAgY29uc3QgbmV4dExheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChwcmV2aW91c0xheW91dCAmJiAoIW5leHRMYXlvdXRNb2RlIHx8IG5leHRMYXlvdXRNb2RlID09PSAnTk9ORScpKSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0LCBndWFyZCwgY29udGVudC5uYW1lKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29udGVudC5yZW1vdmVDb21wb25lbnQocHJldmlvdXNMYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgY29udGVudFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIGNvbnRlbnRUcmFuc2Zvcm0sIHNwZWMsIHRyYW5zZm9ybSwgc2NhbGUpO1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kgJiYgbGVnYWN5ICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubGVnYWN5LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIGNvbnRlbnQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGV4cGVjdHMgdGhlIGNvbnRlbnQgTm9kZSBoZXJlLiBTY3JvbGxWaWV3LnZpZXcgaXMgYVxyXG4gICAgLy8gZ2V0dGVyIGRlcml2ZWQgZnJvbSBjb250ZW50LnBhcmVudCBhbmQgbXVzdCBuZXZlciBiZSBhc3NpZ25lZCBkaXJlY3RseS5cclxuICAgIGlmIChzY3JvbGwuY29udGVudCA9PT0gY29udGVudCkge1xyXG4gICAgICAgIHNjcm9sbC5jb250ZW50ID0gbnVsbDtcclxuICAgIH1cclxuICAgIHNjcm9sbC5jb250ZW50ID0gY29udGVudDtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgc2Nyb2xsLmhvcml6b250YWwgPSBheGVzLmhvcml6b250YWw7XHJcbiAgICBzY3JvbGwudmVydGljYWwgPSBheGVzLnZlcnRpY2FsO1xyXG4gICAgcmV0dXJuIGNvbnRlbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNjcm9sbEF4ZXMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHsgaG9yaXpvbnRhbDogYm9vbGVhbjsgdmVydGljYWw6IGJvb2xlYW4gfSB7XHJcbiAgICBjb25zdCBkaXJlY3Rpb24gPSBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICYmIHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gIT09ICdOT05FJ1xyXG4gICAgICAgID8gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbi50cmltKCkudG9VcHBlckNhc2UoKVxyXG4gICAgICAgIDogJ1ZFUlRJQ0FMX1NDUk9MTElORyc7XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTCcgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnQk9USCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IHRydWUgfTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGhvcml6b250YWw6IGZhbHNlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgY29udGVudFRyYW5zZm9ybTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LndpZHRoKSB8fCAwKTtcclxuICAgIGNvbnN0IHZpZXdwb3J0SGVpZ2h0ID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy5oZWlnaHQpIHx8IDApO1xyXG4gICAgY29uc3QgY2hpbGRSaWdodCA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueCAtIHNwZWMuZnJhbWUueCArIGNoaWxkLmZyYW1lLndpZHRoKSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGNoaWxkQm90dG9tID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS55IC0gc3BlYy5mcmFtZS55ICsgY2hpbGQuZnJhbWUuaGVpZ2h0KSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgY29uc3QgY29udGVudFdpZHRoID0gYXhlcy5ob3Jpem9udGFsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydFdpZHRoLCAwLCAuLi5jaGlsZFJpZ2h0KVxyXG4gICAgICAgIDogdmlld3BvcnRXaWR0aDtcclxuICAgIGNvbnN0IGNvbnRlbnRIZWlnaHQgPSBheGVzLnZlcnRpY2FsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydEhlaWdodCwgMCwgLi4uY2hpbGRCb3R0b20pXHJcbiAgICAgICAgOiB2aWV3cG9ydEhlaWdodDtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoY29udGVudFRyYW5zZm9ybSwgY29udGVudFdpZHRoLCBjb250ZW50SGVpZ2h0KTtcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aCAtIHZpZXdwb3J0V2lkdGgpIC8gMixcbiAgICAgICAgKHZpZXdwb3J0SGVpZ2h0IC0gY29udGVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpIC8gMixcbiAgICAgICAgMCxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldycgfHwgY29udGVudCA9PT0gbm9kZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCB0cmFuc2Zvcm0sIHNwZWMsIHZpZXdwb3J0LCBzY2FsZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvdW50U3BlY3Moc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSk6IG51bWJlciB7XHJcbiAgICByZXR1cm4gc3BlY3MucmVkdWNlKCh0b3RhbCwgc3BlYykgPT4gdG90YWwgKyAxICsgY291bnRTcGVjcyhzcGVjLmNoaWxkcmVuKSwgMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNlbnRlckluQ2FudmFzKG5vZGU6IGFueSwgY2FudmFzOiBhbnksIFVJVHJhbnNmb3JtOiBhbnksIFZlYzM6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgbm9kZVRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IGNhbnZhc1RyYW5zZm9ybSA9IGNhbnZhcz8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGlmICghbm9kZVRyYW5zZm9ybSB8fCAhY2FudmFzVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2FudmFzU2l6ZSA9IGNhbnZhc1RyYW5zZm9ybS5jb250ZW50U2l6ZSA/PyB7XHJcbiAgICAgICAgd2lkdGg6IGNhbnZhc1RyYW5zZm9ybS53aWR0aCxcclxuICAgICAgICBoZWlnaHQ6IGNhbnZhc1RyYW5zZm9ybS5oZWlnaHQsXHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2lkdGggPSBOdW1iZXIoY2FudmFzU2l6ZT8ud2lkdGgpID4gMCA/IE51bWJlcihjYW52YXNTaXplLndpZHRoKSA6IDY0MDtcclxuICAgIGNvbnN0IGhlaWdodCA9IE51bWJlcihjYW52YXNTaXplPy5oZWlnaHQpID4gMCA/IE51bWJlcihjYW52YXNTaXplLmhlaWdodCkgOiAxMTM2O1xyXG4gICAgY29uc3QgY2FudmFzQW5jaG9yID0gY2FudmFzVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IG5vZGVBbmNob3IgPSBub2RlVHJhbnNmb3JtLmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHggPSB3aWR0aCAqICgwLjUgLSBjYW52YXNBbmNob3IueClcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0ud2lkdGggKiAoMC41IC0gbm9kZUFuY2hvci54KTtcclxuICAgIGNvbnN0IHkgPSBoZWlnaHQgKiAoMC41IC0gY2FudmFzQW5jaG9yLnkpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLmhlaWdodCAqICgwLjUgLSBub2RlQW5jaG9yLnkpO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyh4LCB5LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUNvbXBvbmVudHMobm9kZTogYW55KTogYW55W10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5jb21wb25lbnRzID8/IG5vZGU/Ll9jb21wb25lbnRzO1xyXG4gICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUgOiBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVvcmRlckZpZ21hQ2hpbGRyZW4ocGFyZW50OiBhbnksIG9yZGVyZWROb2RlczogYW55W10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGRlc2lyZWQgPSBbLi4ubmV3IFNldChvcmRlcmVkTm9kZXMuZmlsdGVyKEJvb2xlYW4pKV07XHJcbiAgICBpZiAoIWRlc2lyZWQubGVuZ3RoIHx8IHR5cGVvZiBkZXNpcmVkWzBdPy5zZXRTaWJsaW5nSW5kZXggIT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYS1vd25lZCBjaGlsZHJlbiBhcmUga2VwdCBpbiBGaWdtYSBvcmRlci4gVXNlci1hdXRob3JlZCBjaGlsZHJlbiBhcmVcclxuICAgIC8vIG5ldmVyIHJlb3JkZXJlZCBhZ2FpbnN0IG9uZSBhbm90aGVyOyB0aGV5IGZvbGxvdyB0aGUgbWFuYWdlZCBibG9jay5cclxuICAgIGRlc2lyZWQuZm9yRWFjaCgobm9kZSwgaW5kZXgpID0+IG5vZGUuc2V0U2libGluZ0luZGV4KGluZGV4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBwcmV2aW91c05vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcmV0YWluZWROb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgaW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290KTtcclxuICAgIGNvbnN0IHN0YWxlID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGZvciAoY29uc3QgZmlsZUlkIG9mIHByZXZpb3VzTm9kZUZpbGVJZHMpIHtcclxuICAgICAgICBpZiAoZmlsZUlkID09PSBub2RlUHJlZmFiRmlsZUlkKHByZWZhYlJvb3QpIHx8IHJldGFpbmVkTm9kZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICBzdGFsZS5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdGFsZUlkcyA9IG5ldyBTZXQoc3RhbGUua2V5cygpKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZS52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgYOW+heWIoOmZpOeahCBGaWdtYSDoioLngrnigJwke25vZGUubmFtZX3igJ3lkKvmnInmiYvlt6Xnu4Tku7bvvIzlt7LlgZzmraLlkIzmraXku6XpmLLmraLmlbDmja7kuKLlpLHjgIJgLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyA9IChjb250YWluZXI6IGFueSwgc3Vydml2b3JQYXJlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgY29uc3QgY2hpbGRGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGNoaWxkKTtcclxuICAgICAgICAgICAgaWYgKGNoaWxkRmlsZUlkXHJcbiAgICAgICAgICAgICAgICAmJiAocHJldmlvdXNOb2RlRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpIHx8IHByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoY2hpbGRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IFtmaWxlSWQsIG5vZGVdIG9mIHN0YWxlKSB7XHJcbiAgICAgICAgbGV0IGFuY2VzdG9yID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgbGV0IG5lc3RlZFVuZGVyU3RhbGUgPSBmYWxzZTtcclxuICAgICAgICB3aGlsZSAoYW5jZXN0b3IgJiYgYW5jZXN0b3IgIT09IHByZWZhYlJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFuY2VzdG9yRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChhbmNlc3Rvcik7XHJcbiAgICAgICAgICAgIGlmIChhbmNlc3RvckZpbGVJZCAmJiBzdGFsZUlkcy5oYXMoYW5jZXN0b3JGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBuZXN0ZWRVbmRlclN0YWxlID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFuY2VzdG9yID0gYW5jZXN0b3IucGFyZW50O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobmVzdGVkVW5kZXJTdGFsZSB8fCAhbm9kZS5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN1cnZpdm9yUGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzKG5vZGUsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHN0YWxlLmRlbGV0ZShmaWxlSWQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBwcmV2aW91czogUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT4sXHJcbiAgICBnZW5lcmF0ZWRDbGFzc2VzOiBhbnlbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUge1xyXG4gICAgY29uc3QgcHJldmlvdXNDb21wb25lbnRzID0gbmV3IFNldChwcmV2aW91cy5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyk7XHJcbiAgICBjb25zdCBwcmV2aW91c0hlbHBlcnMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRIZWxwZXJGaWxlSWRzKTtcclxuICAgIGNvbnN0IG5vZGVGaWxlSWRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBjb25zdCBtYW5hZ2VkTm9kZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFwcGVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgY29uc3QgbWFuYWdlZFJ1bnRpbWVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcblxyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMobm9kZU1hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWQjOatpee7k+aenOe8uuWwkSBGaWdtYSDoioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBub2RlRmlsZUlkc1tmaWdtYUlkXSA9IGZpbGVJZDtcclxuICAgICAgICBtYW5hZ2VkTm9kZXMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZFJ1bnRpbWVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBtYW5hZ2VkQ29tcG9uZW50VHlwZXMgPSBuZXcgU2V0KFtjYy5VSVRyYW5zZm9ybSwgLi4uZ2VuZXJhdGVkQ2xhc3Nlc10pO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG1hbmFnZWRSdW50aW1lTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBpZiAoIW1hbmFnZWRDb21wb25lbnRUeXBlcy5oYXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGlmIChtYXBwZWRVdWlkcy5oYXMobm9kZS51dWlkKSB8fCBub2RlID09PSBwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGFyZW50ID0gbm9kZS5wYXJlbnQ7XHJcbiAgICAgICAgaWYgKCFwYXJlbnRcclxuICAgICAgICAgICAgfHwgKCFtYXBwZWRVdWlkcy5oYXMocGFyZW50LnV1aWQpICYmICFtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmhhcyhwYXJlbnQudXVpZCkpXHJcbiAgICAgICAgICAgIHx8ICFpc0dlbmVyYXRlZEhlbHBlck5vZGUobm9kZSwgcGFyZW50LCBjYykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKHByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzSGVscGVycy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtwYXJlbnQubmFtZX3igJ3kuIvlrZjlnKjkuI7lr7zlhaXovoXliqnoioLngrnlkIzlkI3nmoTmiYvlt6XoioLngrnigJwke25vZGUubmFtZX3igJ3vvIzlt7LlgZzmraLlkIzmraXjgIJgLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlcnMuYWRkKGZpbGVJZCk7XHJcbiAgICAgICAgbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKHByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KVxyXG4gICAgICAgICAgICAgICAgJiYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoY29tcG9uZW50RmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIG5vZGVGaWxlSWRzLFxyXG4gICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogWy4uLm1hbmFnZWROb2Rlc10sXHJcbiAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IFsuLi5tYW5hZ2VkQ29tcG9uZW50c10sXHJcbiAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IFsuLi5tYW5hZ2VkSGVscGVyc10sXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWZyZXNoUHJlZmFiTGF5b3V0cyhcclxuICAgIHNwZWNzOiBTY2VuZU5vZGVTcGVjW10sXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgdmlzaXQgPSAoc3BlYzogU2NlbmVOb2RlU3BlYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW3NwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHV1aWQgPyBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgID8gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpPy5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG5vZGVcclxuICAgICAgICAgICAgOiBub2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgYXBwbHlDb3VudGVyQWxpZ25tZW50KGNoaWxkUGFyZW50LCBzcGVjLCBub2RlTWFwLCBzY2FsZSwgY2MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGRQYXJlbnQgIT09IG5vZGUpIHtcclxuICAgICAgICAgICAgZmluYWxpemVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgIGNoaWxkUGFyZW50LFxyXG4gICAgICAgICAgICAgICAgbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3BlYy5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgIH07XHJcbiAgICBzcGVjcy5mb3JFYWNoKHZpc2l0KTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQsXHJcbiAgICB2YWx1ZTogbnVtYmVyLFxyXG4gICAgbWVzc2FnZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYXlsb2FkLnBhY2thZ2VOYW1lLCAncHJvZ3Jlc3MnLCB7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZSxcclxuICAgICAgICAgICAgbWVzc2FnZSxcclxuICAgICAgICB9KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIOi/m+W6puWPjemmiOS4jeWPr+eUqOaXtuS4jeW6lOS4reaWreWcuuaZr+WvvOWFpeOAglxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzID0ge1xyXG4gICAgaW5zcGVjdFByZWZhYkNvbnRleHQocGF5bG9hZDoge1xyXG4gICAgICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgICAgICByb290RmlsZUlkPzogc3RyaW5nO1xyXG4gICAgfSk6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkVkaXRpbmdTdGF0ZShwYXlsb2FkLnByZWZhYlV1aWQsIHBheWxvYWQucm9vdEZpbGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydERvY3VtZW50KHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHtcclxuICAgICAgICAgICAgZGlyZWN0b3IsXHJcbiAgICAgICAgICAgIE5vZGUsXHJcbiAgICAgICAgICAgIFVJVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICBDYW52YXMsXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgICAgICBDYW1lcmEsXHJcbiAgICAgICAgfSA9IGNjO1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBpZiAoIXNjZW5lKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5rKh5pyJ5omT5byA55qE5Zy65pmv44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWZhYkNvbnRleHQgPSBwYXlsb2FkLnByZWZhYkNvbnRleHQ7XHJcbiAgICAgICAgbGV0IHByZWZhYlJvb3Q6IGFueSB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcHJlZmFiRWRpdGluZ1N0YXRlKHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCwgcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKTtcclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOWwmuacquWuieWFqOaJk+W8gO+8miR7c3RhdGUucmVhc29uID8/ICfmnKrnn6Xljp/lm6AnfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHByZWZhYlJvb3QgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZS5TY2VuZS5yb290Tm9kZTtcclxuICAgICAgICAgICAgY29uc3QgZmlsZUlkSW5kZXggPSBwcmVmYWJGaWxlSWRJbmRleChwcmVmYWJSb290LCBwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcclxuICAgICAgICAgICAgICAgIF9fcm9vdF9fOiBwcmVmYWJSb290LnV1aWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIGZpbGVJZF0gb2YgT2JqZWN0LmVudHJpZXMocHJlZmFiQ29udGV4dC5leGlzdGluZ05vZGVGaWxlSWRzKSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbGVJZEluZGV4LmdldChmaWxlSWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBleGlzdGluZ01hcFtmaWdtYUlkXSA9IG5vZGUudXVpZDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nID0gdHJ1ZTtcclxuICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCA9IGV4aXN0aW5nTWFwO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmNlbnRlckluQ2FudmFzID0gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICAgICAgaWYgKHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgICAgIG5vZGVDb21wb25lbnRzKG5vZGUpLmZvckVhY2goKGNvbXBvbmVudCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cy5hZGQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBwYXlsb2FkLnJvb3RzLm1hcCgocm9vdCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKHJvb3QpKTtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCAmJiByb290cy5sZW5ndGggIT09IDEpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5Y+q5YWB6K645LiA5LiqIEZpZ21hIEZyYW1lIOagueiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmYWxsYmFja1BhcmVudCA9IHByZWZhYlJvb3Q/LnBhcmVudCA/PyBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpID8/IHNjZW5lO1xyXG4gICAgICAgIGNvbnN0IGRpcmVjdFJvb3QgPSByb290cy5sZW5ndGggPT09IDE7XHJcbiAgICAgICAgY29uc3QgY2FudmFzID0gcHJlZmFiUm9vdCA/IG51bGwgOiBmaW5kQ2FudmFzKHNjZW5lLCBDYW52YXMpO1xyXG4gICAgICAgIGNvbnN0IGdlbmVyYXRlZENsYXNzZXMgPSBbXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYXlvdXQsXHJcbiAgICAgICAgICAgIFNjcm9sbFZpZXcsXHJcbiAgICAgICAgICAgIEJ1dHRvbixcclxuICAgICAgICAgICAgVUlPcGFjaXR5LFxyXG4gICAgICAgIF07XHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgICAgIGxldCBjcmVhdGVkID0gMDtcclxuICAgICAgICBsZXQgdXBkYXRlZCA9IDA7XHJcbiAgICAgICAgY29uc3QgdG90YWxOb2RlcyA9IE1hdGgubWF4KDEsIGNvdW50U3BlY3Mocm9vdHMpKTtcclxuICAgICAgICBsZXQgY29tcGxldGVkTm9kZXMgPSAwO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRDb21wb25lbnRGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRIZWxwZXJzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkSGVscGVyRmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiT3duZXJzaGlwR3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkIHwgdW5kZWZpbmVkID0gcHJlZmFiQ29udGV4dFxyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogcHJldmlvdXNNYW5hZ2VkSGVscGVycyxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RVdWlkID0gcGF5bG9hZC51cGRhdGVFeGlzdGluZ1xyXG4gICAgICAgICAgICA/IHBheWxvYWQuZXhpc3RpbmdNYXAuX19yb290X19cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgbGV0IGV4aXN0aW5nUm9vdE5vZGUgPSBleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgZXhpc3RpbmdSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChleGlzdGluZ1Jvb3ROb2RlPy5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBleGlzdGluZ1Jvb3ROb2RlID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gSW4gYSBkaXJlY3Qtcm9vdCBpbXBvcnQsIF9fcm9vdF9fIGFsaWFzZXMgdGhlIEZpZ21hIHJvb3QgVVVJRC4gSW4gYVxyXG4gICAgICAgIC8vIG11bHRpLXJvb3QgaW1wb3J0IGl0IGlkZW50aWZpZXMgYSBzeW50aGV0aWMgd3JhcHBlciBhbmQgbXVzdCBuZXZlciBiZVxyXG4gICAgICAgIC8vIHJldXNlZCBhcyBvbmUgb2YgaXRzIG93biBjaGlsZHJlbiB3aGVuIHRoZSByb290IGNvdW50IGNoYW5nZXMuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290V2FzRGlyZWN0ID0gQm9vbGVhbihleGlzdGluZ1Jvb3RVdWlkXHJcbiAgICAgICAgICAgICYmIE9iamVjdC5lbnRyaWVzKHBheWxvYWQuZXhpc3RpbmdNYXApLnNvbWUoKFtmaWdtYUlkLCB1dWlkXSkgPT5cclxuICAgICAgICAgICAgICAgIGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgdXVpZCA9PT0gZXhpc3RpbmdSb290VXVpZCkpO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzRGlyZWN0Um9vdCA9IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzV3JhcHBlciA9ICFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBtYXBwZWRSb290VXVpZCA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBleGlzdGluZ1V1aWRGb3JTcGVjKHBheWxvYWQuZXhpc3RpbmdNYXAsIHJvb3RzWzBdKVxyXG4gICAgICAgICAgICA6ICghZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290VXVpZCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgbGV0IGltcG9ydFJvb3QgPSBwcmVmYWJSb290ID8/IChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmIG1hcHBlZFJvb3RVdWlkXHJcbiAgICAgICAgICAgID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbCk7XHJcbiAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGltcG9ydFJvb3Q/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3QgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBsZWdhY3lXcmFwcGVyID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IHByZXZpb3VzV3JhcHBlciA/PyAoaW1wb3J0Um9vdD8ucGFyZW50Py5uYW1lLnN0YXJ0c1dpdGgoJ0ZpZ21hIMK3ICcpXHJcbiAgICAgICAgICAgICAgICA/IGltcG9ydFJvb3QucGFyZW50XHJcbiAgICAgICAgICAgICAgICA6IG51bGwpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBjb25zdCByZXVzZWRJbXBvcnRSb290ID0gQm9vbGVhbihpbXBvcnRSb290KTtcclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBmYWxsYmFja1BhcmVudDtcclxuICAgICAgICBpZiAoIWRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRSb290KSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoYEZpZ21hIMK3ICR7Y2xlYW5OYW1lKHBheWxvYWQucm9vdE5hbWUpfWApO1xyXG4gICAgICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgICAgICAgICAgY3JlYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290Lm5hbWUgPSBgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YDtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByb290VHJhbnNmb3JtID0gaW1wb3J0Um9vdC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGltcG9ydFJvb3QuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgICAgICAgICAgcm9vdFRyYW5zZm9ybSxcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS53aWR0aCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLnJvb3RGcmFtZS5oZWlnaHQgKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpbXBvcnRSb290LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGNsZWFuTmFtZShyb290c1swXS5uYW1lKSk7XHJcbiAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIC8vIEEgY29sbGFwc2VkIFNjZW5lU3BlYyBjYW4gaW50ZW50aW9uYWxseSBtYXAgc2V2ZXJhbCBGaWdtYSBJRHMgdG8gYVxyXG4gICAgICAgIC8vIHNpbmdsZSBDb2NvcyBub2RlLiBJZiBhIGxhdGVyIGltcG9ydCBleHBhbmRzIHRoYXQgc3VidHJlZSBhZ2FpbixcclxuICAgICAgICAvLyB0aG9zZSBJRHMgc3RpbGwgcG9pbnQgYXQgdGhlIHNhbWUgb2xkIFVVSUQuIENsYWltIGVhY2ggcmV1c2FibGUgbm9kZVxyXG4gICAgICAgIC8vIG9uY2UgcGVyIGJ1aWxkIHNvIGEgY2hpbGQgY2FuIG5ldmVyIHJldXNlIChhbmQgcmVwYXJlbnQpIGl0cyBwYXJlbnQuXHJcbiAgICAgICAgY29uc3QgY2xhaW1lZE5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWxkID0gYXN5bmMgKFxyXG4gICAgICAgICAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgICAgICAgICBub2RlUGFyZW50OiBhbnksXHJcbiAgICAgICAgICAgIHByb3ZpZGVkTm9kZT86IGFueSxcclxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICAgICAgbGV0IG5vZGUgPSBwcm92aWRlZE5vZGUgPz8gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFub2RlICYmIHBheWxvYWQudXBkYXRlRXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWRVdWlkID0gcGF5bG9hZC5leGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtYXBwZWROb2RlID0gbWFwcGVkVXVpZCA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAobWFwcGVkTm9kZSAmJiAhY2xhaW1lZE5vZGVVdWlkcy5oYXMobWFwcGVkTm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlID0gbWFwcGVkTm9kZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChub2RlICYmIGNsYWltZWROb2RlVXVpZHMuaGFzKG5vZGUudXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0ZWQgPSBCb29sZWFuKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUgPSBuZXcgTm9kZShjbGVhbk5hbWUoc3BlYy5uYW1lKSk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICB1cGRhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHByZWZhYk93bmVyc2hpcEd1YXJkICYmIGV4aXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nVHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nVHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBoZWxwZXIgb2Ygbm9kZS5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkOiBhbnkpID0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZCwgbm9kZSwgY2MpXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHx8IChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZC5uYW1lID09PSAndmlldycpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBoZWxwZXIubmFtZSA9PT0gJ3ZpZXcnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjb250ZW50ID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oJ2NvbnRlbnQnKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaGVscGVyLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZSA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKHRpbGVkU3ByaXRlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGdlbmVyYXRlZENsYXNzZXMuaW5jbHVkZXMoY29tcG9uZW50LmNvbnN0cnVjdG9yKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY2xhaW1lZE5vZGVVdWlkcy5hZGQobm9kZS51dWlkKTtcclxuICAgICAgICAgICAgaWYgKCEocHJlZmFiQ29udGV4dCAmJiBub2RlID09PSBwcmVmYWJSb290KSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5wYXJlbnQgPSBub2RlUGFyZW50O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUubmFtZSA9IGNsZWFuTmFtZShzcGVjLm5hbWUpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuXHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhub2RlLCBzcGVjLCBjYywgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlT2Jzb2xldGVMYWJlbE91dGxpbmUobm9kZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlc2VydmVkID0gZGVzaXJlZEdlbmVyYXRlZENvbXBvbmVudHMoc3BlYywgY2MsIG5vZGUpO1xuICAgICAgICAgICAgICAgIC8vIE1hc2sgb3ducyBhbmQgZGlzYWJsZXMgaXRzIHNoYXJlZCBHcmFwaGljcyBkdXJpbmcgdGhlXHJcbiAgICAgICAgICAgICAgICAvLyBkZWZlcnJlZCBvbkRpc2FibGUgcGhhc2UuIElmIGNsaXBwaW5nIHdhcyByZW1vdmVkIGJ1dCBhXHJcbiAgICAgICAgICAgICAgICAvLyBub3JtYWwgR3JhcGhpY3MgcmVuZGVyZXIgaXMgc3RpbGwgZGVzaXJlZCwgcmVjcmVhdGUgdGhhdFxyXG4gICAgICAgICAgICAgICAgLy8gcmVuZGVyZXIgb25seSBhZnRlciB0aGUgb2xkIE1hc2sgbGlmZWN5Y2xlIGhhcyBjb21wbGV0ZWQuXHJcbiAgICAgICAgICAgICAgICBpZiAoIXByZXNlcnZlZC5oYXMoTWFzaylcclxuICAgICAgICAgICAgICAgICAgICAmJiBub2RlLmdldENvbXBvbmVudChNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIHByZXNlcnZlZC5oYXMoR3JhcGhpY3MpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJlc2VydmVkLmRlbGV0ZShHcmFwaGljcyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gcmVtb3ZlR2VuZXJhdGVkQ29tcG9uZW50cyhcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGdlbmVyYXRlZENsYXNzZXMsXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlc2VydmVkLFxyXG4gICAgICAgICAgICAgICAgICAgIFtHcmFwaGljcywgU3ByaXRlLCBMYWJlbCwgUmljaFRleHRdLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZWZhYkNvbnRleHQgPyBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZW1vdmVkUmVuZGVyQ29tcG9uZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkQmFja2dyb3VuZChub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZUhlbHBlciA9IHVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG92ZXJmbG93U3ByaXRlSGVscGVyID0gdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0aWxlZFNwcml0ZUhlbHBlcikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFvdmVyZmxvd1Nwcml0ZUhlbHBlcikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZUdlbmVyYXRlZE92ZXJmbG93VmlzdWFsKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNsaXBzQ2hpbGRyZW4gPSBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQTkcg5pW05bGC6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yM6LWE5rqQ5Y+v6IO95pyq5oiQ5Yqf5a+85YWl44CCYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aWxlZFNwcml0ZUhlbHBlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVUaWxlZFNwcml0ZUhlbHBlcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChvdmVyZmxvd1Nwcml0ZUhlbHBlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVPdmVyZmxvd1Nwcml0ZUhlbHBlcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmb250ID0gYXdhaXQgbG9hZEFzc2V0KGNjLmFzc2V0TWFuYWdlciwgc3BlYy5mb250VXVpZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjYy5UVEZGb250ICYmICEoZm9udCBpbnN0YW5jZW9mIGNjLlRURkZvbnQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYFJpY2hUZXh0IOiKgueCueKAnCR7c3BlYy5uYW1lfeKAneWPquiDveS9v+eUqCBUVEYvT1RGIOWtl+S9k++8jOW9k+WJjeaYoOWwhOWPr+iDveaYryBCaXRtYXBGb25077yILmZudO+8ieOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJpY2hUZXh0LmZvbnQgPSBmb250O1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJpY2hUZXh0LmZvbnQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVMYWJlbChub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMuZm9udFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsLmZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlLmdldENvbXBvbmVudChMYWJlbCkuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOefoumHj+iKgueCueKAnCR7c3BlYy5uYW1lfeKAneayoeaciee7keWumiBTcHJpdGVGcmFtZe+8jFBORyDotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUNsaXAobm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChoYXNHcmFwaGljc1Zpc3VhbChzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUdyYXBoaWNzKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZU9wYWNpdHkobm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlQnV0dG9uKG5vZGUsIHNwZWMsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZFBhcmVudCA9IHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJ1xyXG4gICAgICAgICAgICAgICAgPyBub2RlXHJcbiAgICAgICAgICAgICAgICA6IGNvbmZpZ3VyZVNjcm9sbChcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNmb3JtLFxyXG4gICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxheW91dChjaGlsZFBhcmVudCwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgYnVpbGQoY2hpbGQsIGNoaWxkUGFyZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgcmVvcmRlckZpZ21hQ2hpbGRyZW4oXHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkLmZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdXVpZCA/IGZpbmRCeVV1aWQoY2hpbGRQYXJlbnQsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXQgPSBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBsYXlvdXRNb2RlICYmIGxheW91dE1vZGUgIT09ICdOT05FJ1xyXG4gICAgICAgICAgICAgICAgPyBjaGlsZFBhcmVudC5nZXRDb21wb25lbnQoTGF5b3V0KVxyXG4gICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICBsYXlvdXQ/LnVwZGF0ZUxheW91dCgpO1xyXG4gICAgICAgICAgICBpZiAobGF5b3V0KSB7XHJcbiAgICAgICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChub2RlLCBzcGVjLCBjaGlsZFBhcmVudCwgdHJhbnNmb3JtLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RlZCAmJiBzcGVjLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSArPSAnIMK3IFRyYW5zZm9ybSc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgKz0gMTtcclxuICAgICAgICAgICAgZW1pdFNjZW5lUHJvZ3Jlc3MoXHJcbiAgICAgICAgICAgICAgICBwYXlsb2FkLFxyXG4gICAgICAgICAgICAgICAgY29tcGxldGVkTm9kZXMgLyB0b3RhbE5vZGVzLFxyXG4gICAgICAgICAgICAgICAgYOaehOW7uuiKgueCuSAke2NvbXBsZXRlZE5vZGVzfS8ke3RvdGFsTm9kZXN9IMK3ICR7c3BlYy5uYW1lfWAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIHJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChyb290LCBkaXJlY3RSb290ID8gcGFyZW50IDogaW1wb3J0Um9vdCwgZGlyZWN0Um9vdCA/IGltcG9ydFJvb3QgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nICYmICFwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVDb2xsYXBzZWRNYXBwZWREZXNjZW5kYW50cyhcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGRpcmVjdFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAocGF5bG9hZC5jZW50ZXJJbkNhbnZhcyAmJiBjYW52YXMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjZW50ZXJJbkNhbnZhcyhpbXBvcnRSb290LCBjYW52YXMsIFVJVHJhbnNmb3JtLCBjYy5WZWMzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgICAgICAgICAgY29uc3Qgc3RhbGVUcmFuc2l0aW9uVXVpZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcClcclxuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKChbZmlnbWFJZCwgdXVpZF0pID0+IGZpZ21hSWQgIT09ICdfX3Jvb3RfXycgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHV1aWQpKVxyXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKFssIHV1aWRdKSA9PiB1dWlkKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIGxlZ2FjeVdyYXBwZXIgJiYgbGVnYWN5V3JhcHBlciAhPT0gaW1wb3J0Um9vdCAmJiBsZWdhY3lXcmFwcGVyLnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUobGVnYWN5V3JhcHBlciwgcGFyZW50LCBzdGFsZVRyYW5zaXRpb25VdWlkcywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBwcmV2aW91c0RpcmVjdFJvb3RcclxuICAgICAgICAgICAgICAgICYmIHByZXZpb3VzRGlyZWN0Um9vdCAhPT0gaW1wb3J0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgIXJldGFpbmVkVXVpZHMuaGFzKHByZXZpb3VzRGlyZWN0Um9vdC51dWlkKVxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290LnBhcmVudCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXHJcbiAgICAgICAgICAgICAgICAgICAgcHJldmlvdXNEaXJlY3RSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHN0YWxlVHJhbnNpdGlvblV1aWRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoaW1wb3J0Um9vdCwgcGF5bG9hZC5leGlzdGluZ01hcCwgbm9kZU1hcCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBpZiAoIXJldXNlZEltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGFyZW50LFxyXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhwYXlsb2FkLmV4aXN0aW5nTWFwKSksXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LmRlc3Ryb3koKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IHByZWZhYlN5bmM6IFByZWZhYlNjZW5lU3luY0NhcHR1cmUgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmV0YWluZWROb2RlRmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIHV1aWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlrprkvY3lr7zlhaXlkI7nmoToioLngrnvvJoke2ZpZ21hSWR9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXRhaW5lZE5vZGVGaWxlSWRzLmFkZChlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBpbXBvcnRSb290LCBjYykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbW92ZVN0YWxlUHJlZmFiTm9kZXMoXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgbmV3IFNldChwcmVmYWJDb250ZXh0Lm1hbmFnZWROb2RlRmlsZUlkcyksXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHJlZnJlc2hQcmVmYWJMYXlvdXRzKHJvb3RzLCBpbXBvcnRSb290LCBub2RlTWFwLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMgPSBjYXB0dXJlUHJlZmFiU3luYyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgW1VJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAobm9kZVByZWZhYkZpbGVJZChpbXBvcnRSb290KSAhPT0gcHJlZmFiQ29udGV4dC5yb290RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOWcqOWQjOatpei/h+eoi+S4reWPkeeUn+WPmOWMlu+8jOW3suaLkue7neS/neWtmOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHJvb3RVdWlkOiBpbXBvcnRSb290LnV1aWQsXHJcbiAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgIGNyZWF0ZWQsXHJcbiAgICAgICAgICAgIHVwZGF0ZWQsXHJcbiAgICAgICAgICAgIHRlbXBvcmFyeVJvb3Q6ICFwcmVmYWJDb250ZXh0ICYmIGRpcmVjdFJvb3QgJiYgIXJldXNlZEltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgIHByZWZhYlN5bmMsXHJcbiAgICAgICAgfTtcclxuICAgIH0sXHJcblxyXG4gICAgcmVtb3ZlSW1wb3J0ZWROb2RlKHBheWxvYWQ6IHsgcm9vdFV1aWQ6IHN0cmluZyB9KTogYm9vbGVhbiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGNjLmRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNjZW5lID8gZmluZEJ5VXVpZChzY2VuZSwgcGF5bG9hZC5yb290VXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIFN0b3AgcmVuZGVyaW5nIGltbWVkaWF0ZWx5LiBDb2NvcyBkZXN0cm95cyBub2RlcyBhdCB0aGUgZW5kIG9mIHRoZVxyXG4gICAgICAgIC8vIGZyYW1lLCBzbyByZW1vdmluZyB0aGUgcGFyZW50IGFsb25lIGNhbiBsZWF2ZSBhIG9uZS1mcmFtZSBnaG9zdC5cclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSxcclxufTtcclxuIl19