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
    return spec.clipsContent
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBOHFEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBaHJEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFFL0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQXlCekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSx5QkFBeUIsR0FBRyx1QkFBdUIsQ0FBQztBQUMxRCxNQUFNLG1CQUFtQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ2hDLFFBQVE7SUFDUixtQkFBbUI7SUFDbkIsTUFBTTtJQUNOLE1BQU07SUFDTixpQkFBaUI7Q0FDcEIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxTQUFTLENBQUMsS0FBYTs7SUFDNUIsT0FBTyxNQUFBLElBQUEsNEJBQWdCLEVBQUMsS0FBSyxDQUFDLG1DQUFJLFlBQVksQ0FBQztBQUNuRCxDQUFDO0FBRUQsU0FBUyxPQUFPLENBQUMsS0FBVSxFQUFFLEtBQTZCLEVBQUUsT0FBTyxHQUFHLENBQUM7O0lBQ25FLE1BQU0sTUFBTSxHQUFHLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQ25ELE9BQU8sSUFBSSxLQUFLLENBQ1osSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJ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LENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1FBQ2hFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNSLE9BQU8sS0FBSyxDQUFDO1FBQ2pCLENBQUM7UUFDRCxxRUFBcUU7UUFDckUsbUVBQW1FO1FBQ25FLElBQUksQ0FBQyxNQUFNLEdBQUcsS0FBSyxDQUFDO1FBQ3BCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge1xyXG4gICAgaXNUZXJtaW5hbEFjdGlvbixcclxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXHJcbiAgICBub3JtYWxpemVJbXBvcnRBY3Rpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEZpZ21hQ29sb3IsXHJcbiAgICBGaWdtYVBhaW50LFxyXG4gICAgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBSZWN0LFxyXG4gICAgU2NlbmVOb2RlU3BlYyxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuXHJcbm1vZHVsZS5wYXRocy5wdXNoKGpvaW4oRWRpdG9yLkFwcC5wYXRoLCAnbm9kZV9tb2R1bGVzJykpO1xyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG59XHJcblxyXG5jb25zdCBCQUNLR1JPVU5EX05PREVfTkFNRSA9ICdfX0ZpZ21hQmFja2dyb3VuZCc7XHJcbmNvbnN0IFRJTEVEX01BU0tfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZE1hc2snO1xyXG5jb25zdCBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZFNwcml0ZSc7XHJcbmNvbnN0IE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUgPSAnX19GaWdtYU92ZXJmbG93VmlzdWFsJztcclxuY29uc3QgUkFTVEVSX1ZFQ1RPUl9UWVBFUyA9IG5ldyBTZXQoW1xyXG4gICAgJ1ZFQ1RPUicsXHJcbiAgICAnQk9PTEVBTl9PUEVSQVRJT04nLFxyXG4gICAgJ1NUQVInLFxyXG4gICAgJ0xJTkUnLFxyXG4gICAgJ1JFR1VMQVJfUE9MWUdPTicsXHJcbl0pO1xyXG5cclxuZnVuY3Rpb24gY2xlYW5OYW1lKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHNhbml0aXplTm9kZU5hbWUoaW5wdXQpID8/ICdGaWdtYSBOb2RlJztcclxufVxyXG5cclxuZnVuY3Rpb24gdG9Db2xvcihDb2xvcjogYW55LCB2YWx1ZTogRmlnbWFDb2xvciB8IHVuZGVmaW5lZCwgb3BhY2l0eSA9IDEpOiBhbnkge1xyXG4gICAgY29uc3Qgc291cmNlID0gdmFsdWUgPz8geyByOiAwLCBnOiAwLCBiOiAwLCBhOiAxIH07XHJcbiAgICByZXR1cm4gbmV3IENvbG9yKFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLnIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UuZykpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5iKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgKHNvdXJjZS5hID8/IDEpICogb3BhY2l0eSkpICogMjU1KSxcclxuICAgICk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRCeVV1aWQocm9vdDogYW55LCB1dWlkOiBzdHJpbmcpOiBhbnkgfCBudWxsIHtcclxuICAgIGlmIChyb290LnV1aWQgPT09IHV1aWQpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZEJ5VXVpZChjaGlsZCwgdXVpZCk7XHJcbiAgICAgICAgaWYgKGZvdW5kKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZVByZWZhYkZpbGVJZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmFsdWUgPSBub2RlPy5fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQ6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGNvbXBvbmVudD8uX19wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2Fsa05vZGVzKHJvb3Q6IGFueSwgdmlzaXQ6IChub2RlOiBhbnkpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIHZpc2l0KHJvb3QpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuID8/IFtdKSB7XHJcbiAgICAgICAgd2Fsa05vZGVzKGNoaWxkLCB2aXNpdCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkFzc2V0VXVpZChub2RlOiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgYXNzZXQgPSBub2RlPy5fcHJlZmFiPy5hc3NldDtcclxuICAgIGNvbnN0IHZhbHVlID0gYXNzZXQ/Ll91dWlkID8/IGFzc2V0Py51dWlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJGaWxlSWRJbmRleChyb290OiBhbnksIGV4cGVjdGVkUHJlZmFiVXVpZD86IHN0cmluZyk6IE1hcDxzdHJpbmcsIGFueT4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIHdhbGtOb2Rlcyhyb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHByZWZhYlJvb3QgPSBub2RlPy5fcHJlZmFiPy5yb290O1xyXG4gICAgICAgIGlmIChub2RlICE9PSByb290ICYmIHByZWZhYlJvb3QgJiYgcHJlZmFiUm9vdCAhPT0gcm9vdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFzc2V0VXVpZCA9IHByZWZhYkFzc2V0VXVpZChub2RlKTtcclxuICAgICAgICBpZiAoZXhwZWN0ZWRQcmVmYWJVdWlkICYmIGFzc2V0VXVpZCAmJiBhc3NldFV1aWQgIT09IGV4cGVjdGVkUHJlZmFiVXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICAgICAgaWYgKCFmaWxlSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocmVzdWx0LmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjeiKgueCuSBmaWxlSWTvvJoke2ZpbGVJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0LnNldChmaWxlSWQsIG5vZGUpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGUuY29tcG9uZW50cyA/PyBub2RlLl9jb21wb25lbnRzID8/IFtdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAoIWNvbXBvbmVudEZpbGVJZCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGNvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWGheWtmOWcqOmHjeWkjee7hOS7tiBmaWxlSWTvvJoke2NvbXBvbmVudEZpbGVJZH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wb25lbnRGaWxlSWRzLmFkZChjb21wb25lbnRGaWxlSWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRWRpdGluZ1N0YXRlKFxyXG4gICAgZXhwZWN0ZWRVdWlkOiBzdHJpbmcsXHJcbiAgICBleHBlY3RlZFJvb3RGaWxlSWQ/OiBzdHJpbmcsXHJcbik6IFByZWZhYkVkaXRpbmdTdGF0ZSB7XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNvbnN0IG1vZGUgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5TW9kZT8uKCkgPz8gJycpO1xyXG4gICAgY29uc3QgY3VycmVudFV1aWQgPSBTdHJpbmcoY2NlQXBpPy5TY2VuZUZhY2FkZU1hbmFnZXI/LnF1ZXJ5Q3VycmVudFNjZW5lVXVpZD8uKCkgPz8gJycpO1xyXG4gICAgY29uc3Qgcm9vdCA9IGNjZUFwaT8uU2NlbmU/LnJvb3ROb2RlID8/IG51bGw7XHJcbiAgICBjb25zdCByb290RmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChyb290KTtcclxuICAgIGxldCByZWFzb24gPSAnJztcclxuICAgIGlmIChtb2RlICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3nvJbovpHmqKHlvI/kuLogJHttb2RlIHx8ICd1bmtub3duJ33vvIzlsJrmnKrov5vlhaUgUHJlZmFiYDtcclxuICAgIH0gZWxzZSBpZiAoY3VycmVudFV1aWQgIT09IGV4cGVjdGVkVXVpZCkge1xyXG4gICAgICAgIHJlYXNvbiA9IGDlvZPliY3otYTmupAgVVVJRCDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtGA7XHJcbiAgICB9IGVsc2UgaWYgKCFyb290KSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrnlsJrmnKrlsLHnu6onO1xyXG4gICAgfSBlbHNlIGlmIChleHBlY3RlZFJvb3RGaWxlSWQgJiYgcm9vdEZpbGVJZCAhPT0gZXhwZWN0ZWRSb290RmlsZUlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gJ1ByZWZhYiDmoLnoioLngrkgZmlsZUlkIOS4juadpea6kOiusOW9leS4jeS4gOiHtCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHJlYWR5OiAhcmVhc29uLFxyXG4gICAgICAgIG1vZGUsXHJcbiAgICAgICAgY3VycmVudFV1aWQsXHJcbiAgICAgICAgcm9vdFV1aWQ6IHJvb3Q/LnV1aWQsXHJcbiAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICByZWFzb246IHJlYXNvbiB8fCB1bmRlZmluZWQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gKGdsb2JhbFRoaXMgYXMgYW55KS5FZGl0b3I/LlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgaWYgKHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgcmV0dXJuIGdlbmVyYXRlZDtcclxuICAgIH1cclxuICAgIC8vIFVuaXQtdGVzdC9oZWFkbGVzcyBmYWxsYmFjay4gVGhlIHJlYWwgQ3JlYXRvciBzY2VuZSBwcm9jZXNzIGFsd2F5cyB1c2VzXHJcbiAgICAvLyBFZGl0b3IuVXRpbHMuVVVJRC5nZW5lcmF0ZSh0cnVlKSwgc28gcHJvZHVjdGlvbiBJRHMgZm9sbG93IENyZWF0b3IncyBvd24gZm9ybWF0LlxyXG4gICAgcmV0dXJuIGBmaWdtYSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9JHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxNCl9YDtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZTogYW55LCBwcmVmYWJSb290OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY2NlQXBpPy5QcmVmYWI/Lm9uQWRkTm9kZT8uKG5vZGUpO1xyXG4gICAgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgUHJlZmFiSW5mbyA9IGNjLlByZWZhYj8uX3V0aWxzPy5QcmVmYWJJbmZvID8/IGNjLlByZWZhYkluZm87XHJcbiAgICBpZiAoIVByZWZhYkluZm8pIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIDMuOC43IFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOiKgueCueeUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5yb290ID0gcHJlZmFiUm9vdDtcclxuICAgIGluZm8uYXNzZXQgPSBwcmVmYWJSb290Py5fcHJlZmFiPy5hc3NldCA/PyBudWxsO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgaW5mby5pbnN0YW5jZSA9IG51bGw7XHJcbiAgICBpbmZvLnRhcmdldE92ZXJyaWRlcyA9IG51bGw7XHJcbiAgICBub2RlLl9wcmVmYWIgPSBpbmZvO1xyXG4gICAgcmV0dXJuIGluZm8uZmlsZUlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudDogYW55LCBjYzogYW55KTogc3RyaW5nIHtcclxuICAgIGxldCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGRDb21wb25lbnQ/Lihjb21wb25lbnQpO1xyXG4gICAgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IENvbXBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LkNvbXBQcmVmYWJJbmZvID8/IGNjLkNvbXBQcmVmYWJJbmZvO1xyXG4gICAgaWYgKCFDb21wUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgQ29tcFByZWZhYkluZm8gQVBJIOS4jeWPr+eUqO+8jOaXoOazleS4uuaWsOe7hOS7tueUn+aIkOeos+WumiBmaWxlSWTjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBuZXcgQ29tcFByZWZhYkluZm8oKTtcclxuICAgIGluZm8uZmlsZUlkID0gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTtcclxuICAgIGNvbXBvbmVudC5fX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldFBhcmVudEtlZXBpbmdXb3JsZChub2RlOiBhbnksIHBhcmVudDogYW55KTogdm9pZCB7XHJcbiAgICBpZiAodHlwZW9mIG5vZGUuc2V0UGFyZW50ID09PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgbm9kZS5zZXRQYXJlbnQocGFyZW50LCB0cnVlKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgbm9kZS5wYXJlbnQgPSBwYXJlbnQ7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzR2VuZXJhdGVkSGVscGVyTm9kZShjaGlsZDogYW55LCBwYXJlbnQ6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKGNoaWxkLm5hbWUgPT09IEJBQ0tHUk9VTkRfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09ICdfX0ZpZ21hQ29udGVudCcpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmIChjaGlsZC5uYW1lID09PSAndmlldycgJiYgcGFyZW50LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2hpbGQubmFtZSA9PT0gJ2NvbnRlbnQnXHJcbiAgICAgICAgJiYgcGFyZW50Lm5hbWUgPT09ICd2aWV3J1xyXG4gICAgICAgICYmIHBhcmVudC5wYXJlbnQ/LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBzdGFsZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDE7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChzdGFsZVV1aWRzLmhhcyhjaGlsZC51dWlkKSB8fCBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKSkge1xyXG4gICAgICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc3Vydml2b3JQYXJlbnQpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplU2NlbmVTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBTY2VuZU5vZGVTcGVjIHtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzcGVjLmFjdGlvbiBhcyB1bmtub3duKTtcclxuICAgIGNvbnN0IGtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHNwZWMua2luZCwgYWN0aW9uKTtcclxuICAgIGNvbnN0IGNoaWxkcmVuID0gQXJyYXkuaXNBcnJheShzcGVjLmNoaWxkcmVuKSA/IHNwZWMuY2hpbGRyZW4gOiBbXTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uc3BlYyxcclxuICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBjaGlsZHJlbjogaXNUZXJtaW5hbEFjdGlvbihhY3Rpb24pIHx8IHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSB0cnVlXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBjaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBub3JtYWxpemVTY2VuZVNwZWMoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgaWRzID0gW3NwZWMuZmlnbWFJZCwgLi4uKHNwZWMuYWxpYXNGaWdtYUlkcyA/PyBbXSldXHJcbiAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwICYmIGlkICE9PSAnX19yb290X18nKTtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChpZHMpXTtcclxufVxyXG5cclxuZnVuY3Rpb24gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBmaWdtYUlkc0ZvclNwZWMoc3BlYykuZmlsdGVyKChmaWdtYUlkKSA9PiBmaWdtYUlkICE9PSBzcGVjLmZpZ21hSWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGlzdGluZ1V1aWRGb3JTcGVjKFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBleGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIGlmICh0eXBlb2Ygc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09ICdib29sZWFuJykge1xyXG4gICAgICAgIHJldHVybiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeTtcclxuICAgIH1cclxuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIFNjZW5lU3BlY3MgcGVyc2lzdGVkIGJ5IGltcG9ydGVyIHZlcnNpb25zXHJcbiAgICAvLyBiZWZvcmUgZmxhdHRlbkJvdW5kYXJ5IHdhcyBpbnRyb2R1Y2VkLiBOZXcgcGxhbnMgYWx3YXlzIHNldCB0aGUgZmxhZyBzb1xyXG4gICAgLy8gZm9sZGVkIExhYmVscyBhbmQgb3RoZXIgcHJvbW90ZWQgdmlzdWFscyB1c2UgdGhlIHNhbWUgY2xlYW51cCBzZW1hbnRpY3MuXHJcbiAgICByZXR1cm4gc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInXHJcbiAgICAgICAgfHwgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIEJvb2xlYW4oc3BlYy5zcHJpdGUpICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID09PSAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlQ29sbGFwc2VkTWFwcGVkRGVzY2VuZGFudHMoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMoY3VycmVudE1hcCkpO1xyXG4gICAgY29uc3QgYm91bmRhcnlTcGVjczogQXJyYXk8e1xyXG4gICAgICAgIGZpZ21hSWQ6IHN0cmluZztcclxuICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGJvb2xlYW47XHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogU2V0PHN0cmluZz47XHJcbiAgICB9PiA9IFtdO1xyXG4gICAgY29uc3QgY29sbGVjdEJvdW5kYXJpZXMgPSAobm9kZXM6IFNjZW5lTm9kZVNwZWNbXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAoZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYWxpYXNGaWdtYUlkcyA9IGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWMpO1xyXG4gICAgICAgICAgICBpZiAoYWxpYXNGaWdtYUlkcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldChhbGlhc0ZpZ21hSWRzKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWMuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjcyk7XHJcbiAgICBjb25zdCBib3VuZGFyaWVzID0gYm91bmRhcnlTcGVjc1xyXG4gICAgICAgIC5tYXAoKGJvdW5kYXJ5KSA9PiAoe1xyXG4gICAgICAgICAgICAuLi5ib3VuZGFyeSxcclxuICAgICAgICAgICAgbm9kZTogY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXVxyXG4gICAgICAgICAgICAgICAgPyBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF0pXHJcbiAgICAgICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgfSkpXHJcbiAgICAgICAgLmZpbHRlcigoYm91bmRhcnkpOiBib3VuZGFyeSBpcyB0eXBlb2YgYm91bmRhcnkgJiB7IG5vZGU6IGFueSB9ID0+IEJvb2xlYW4oYm91bmRhcnkubm9kZSkpO1xyXG4gICAgaWYgKCFib3VuZGFyaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCByZXRhaW5lZFV1aWRzLmhhcyh1dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBib3VuZGFyeSBvZiBib3VuZGFyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmICghYm91bmRhcnkucmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzXHJcbiAgICAgICAgICAgICAgICAmJiAhYm91bmRhcnkuYWxpYXNGaWdtYUlkcy5oYXMoZmlnbWFJZCkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGJvdW5kYXJ5Lm5vZGUsIHV1aWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSAmJiBub2RlICE9PSBib3VuZGFyeS5ub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGFsZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YWxlTm9kZXMuc2l6ZSkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVVdWlkcyA9IG5ldyBTZXQoc3RhbGVOb2Rlcy5rZXlzKCkpO1xyXG4gICAgbGV0IHJlbW92ZWQgPSAwO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBpZiAoIW5vZGUucGFyZW50IHx8IHN0YWxlVXVpZHMuaGFzKG5vZGUucGFyZW50LnV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKG5vZGUsIG5vZGUucGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCBjdXJyZW50TWFwW2ZpZ21hSWRdKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmluZEJ5VXVpZChpbXBvcnRSb290LCB1dWlkKSkge1xyXG4gICAgICAgICAgICBjdXJyZW50TWFwW2ZpZ21hSWRdID0gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgY29udGFpbmVyOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgZXhpc3RpbmdVdWlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChleGlzdGluZ1V1aWRzLmhhcyhjaGlsZC51dWlkKSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhjaGlsZCwgc3Vydml2b3JQYXJlbnQsIGV4aXN0aW5nVXVpZHMpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluZENhbnZhcyhyb290OiBhbnksIENhbnZhczogYW55KTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC5nZXRDb21wb25lbnQoQ2FudmFzKSkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQ2FudmFzKGNoaWxkLCBDYW52YXMpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBjbGFzc2VzOiBhbnlbXSxcclxuICAgIHByZXNlcnZlZDogU2V0PGFueT4sXHJcbiAgICByZW5kZXJDbGFzc2VzOiBhbnlbXSxcclxuICAgIHJlbW92YWJsZUZpbGVJZHM/OiBTZXQ8c3RyaW5nPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IGZhbHNlO1xyXG4gICAgZm9yIChjb25zdCB0eXBlIG9mIGNsYXNzZXMpIHtcclxuICAgICAgICBpZiAocHJlc2VydmVkLmhhcyh0eXBlKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gbm9kZS5nZXRDb21wb25lbnQodHlwZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICBpZiAocmVtb3ZhYmxlRmlsZUlkcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWZpbGVJZCB8fCAhcmVtb3ZhYmxlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoTmuLLmn5Pnu4Tku7bkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel5YaF5a6544CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KGNvbXBvbmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWRSZW5kZXJDb21wb25lbnQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGU6IGFueSwgY2M6IGFueSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgb3V0bGluZSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkxhYmVsT3V0bGluZSk7XHJcbiAgICBpZiAoIW91dGxpbmUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBMYWJlbE91dGxpbmUgd2FzIHVzZWQgYnkgb2xkZXIgaW1wb3J0ZXIgdmVyc2lvbnMuIENvY29zIGRlc3Ryb3lzXHJcbiAgICAvLyBjb21wb25lbnRzIGF0IHRoZSBlbmQgb2YgdGhlIGZyYW1lIGFuZCBpdHMgb25EaXNhYmxlKCkgd3JpdGVzIGJhY2sgdG9cclxuICAgIC8vIExhYmVsLmVuYWJsZU91dGxpbmUsIHNvIGxldCB0aGF0IGxpZmVjeWNsZSBmaW5pc2ggYmVmb3JlIGVpdGhlclxyXG4gICAgLy8gcmVjb25maWd1cmluZyBvciByZW1vdmluZyB0aGUgTGFiZWwgY29tcG9uZW50LlxyXG4gICAgbm9kZS5yZW1vdmVDb21wb25lbnQob3V0bGluZSk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnksIG5vZGU6IGFueSk6IFNldDxhbnk+IHtcbiAgICBjb25zdCBkZXNpcmVkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICBpZiAoIXVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKSAmJiAhdXNlc092ZXJmbG93U3ByaXRlSGVscGVyKHNwZWMpKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLlNwcml0ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5SaWNoVGV4dCk7XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ2xhYmVsJyB8fCBzcGVjLmZpZ21hVHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuTGFiZWwpO1xyXG4gICAgfSBlbHNlIGlmICghUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpIHx8IGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuR3JhcGhpY3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5NYXNrKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSdcclxuICAgICAgICAmJiBzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICYmIGxheW91dE1vZGVcclxuICAgICAgICAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuU2Nyb2xsVmlldyk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnYnV0dG9uJyAmJiAhaGFzQnV0dG9uQW5jZXN0b3Iobm9kZSwgY2MpKSB7XG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkJ1dHRvbik7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5IDwgMC45OTkpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5VSU9wYWNpdHkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlc2lyZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMCkpO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiT3duZXJzaGlwR3VhcmQge1xyXG4gICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ05vZGVVdWlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IFNldDxhbnk+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc093bmVkSGVscGVyTm9kZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIHJldHVybiAhZ3VhcmQucHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICB8fCBCb29sZWFuKGZpbGVJZCAmJiBndWFyZC5wcmV2aW91c0hlbHBlckZpbGVJZHMuaGFzKGZpbGVJZCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgIGNvbXBvbmVudDogYW55LFxyXG4gICAgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgb3duZXJOYW1lOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKCFjb21wb25lbnQgfHwgIWd1YXJkLnByZWV4aXN0aW5nQ29tcG9uZW50cy5oYXMoY29tcG9uZW50KSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKCFmaWxlSWQgfHwgIWd1YXJkLnByZXZpb3VzQ29tcG9uZW50RmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYOiKgueCueKAnCR7b3duZXJOYW1lfeKAneS4iueahCAke2NvbXBvbmVudC5jb25zdHJ1Y3Rvcj8ubmFtZSA/PyAnQ29tcG9uZW50J30g5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBpZiAoIWlzT3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6L6F5Yqp6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOOAgmApO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChjb21wb25lbnQsIGd1YXJkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShub2RlLCBndWFyZCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICBpZiAoaXNPd25lZEhlbHBlck5vZGUoY2hpbGQsIGd1YXJkKSkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoY2hpbGQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoXHJcbiAgICBoZWxwZXI6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlbW92ZSA9IChub2RlOiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBpZiAoZ3VhcmQgJiYgaXNPd25lZEhlbHBlck5vZGUoY2hpbGQsIGd1YXJkKSkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlKGNoaWxkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3IpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgfTtcclxuICAgIHJlbW92ZShoZWxwZXIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgYmFja2dyb3VuZCA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoQkFDS0dST1VORF9OT0RFX05BTUUpO1xyXG4gICAgaWYgKCFiYWNrZ3JvdW5kKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShiYWNrZ3JvdW5kLCBub2RlLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lHZW5lcmF0ZWRUaWxlZFNwcml0ZShcclxuICAgIHRpbGVkU3ByaXRlOiBhbnksXHJcbiAgICBzdXJ2aXZvcjogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkU3ByaXRlLCBzdXJ2aXZvciwgZ3VhcmQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRUaWxlZE5vZGVzKG5vZGU6IGFueSwgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgY29uc3QgdGlsZWRNYXNrID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRpbGVkU3ByaXRlID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgIGRlc3Ryb3lHZW5lcmF0ZWRUaWxlZFNwcml0ZSh0aWxlZFNwcml0ZSwgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRPdmVyZmxvd1Zpc3VhbChub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IGhlbHBlciA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoaGVscGVyKSB7XHJcbiAgICAgICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlT2Jzb2xldGVTY3JvbGxIZWxwZXJzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIEEgZmxhdHRlbmVkIG5vZGUgaGFzIG5vIG5ldyBjaGlsZCBzcGVjcyBieSBkZXNpZ24uIEtlZXAgZXZlcnkgZXhpc3RpbmdcclxuICAgIC8vIGNoaWxkIGFsaXZlIHVudGlsIHJlbW92ZUZsYXR0ZW5lZE1hcHBlZERlc2NlbmRhbnRzIGNhbiBkaXN0aW5ndWlzaCBvbGRcclxuICAgIC8vIEZpZ21hLW1hcHBlZCBub2RlcyBmcm9tIHVzZXItYXV0aG9yZWQgbm9kZXMuIE90aGVyd2lzZSBkZXN0cm95aW5nIHRoZVxyXG4gICAgLy8gaGVscGVyIHdvdWxkIHJlY3Vyc2l2ZWx5IGRlc3Ryb3kgbWFudWFsIGNoaWxkcmVuIGF0IENvY29zJyBkZWZlcnJlZFxyXG4gICAgLy8gZGVzdHJ1Y3Rpb24gYm91bmRhcnkuXHJcbiAgICBjb25zdCBwcmVzZXJ2ZUNoaWxkcmVuID0gc3BlYy5jaGlsZHJlbi5sZW5ndGggPiAwIHx8IGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYyk7XHJcbiAgICBjb25zdCBtb3ZlQ2hpbGRyZW5Ub05vZGUgPSAoY29udGFpbmVyOiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGd1YXJkIHx8IHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGxlZ2FjeSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxlZ2FjeS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbGVnYWN5LmRlc3Ryb3koKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjcm9sbCA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlNjcm9sbFZpZXcpO1xyXG4gICAgY29uc3QgdmlldyA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKTtcclxuICAgIGNvbnN0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpO1xyXG4gICAgaWYgKCFzY3JvbGwgfHwgIXZpZXcgfHwgIWNvbnRlbnRcclxuICAgICAgICB8fCAoc2Nyb2xsLmNvbnRlbnQgIT09IGNvbnRlbnQgJiYgc2Nyb2xsLmNvbnRlbnQgIT0gbnVsbCkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodmlldywgZ3VhcmQpO1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodmlldywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChwcmVzZXJ2ZUNoaWxkcmVuKSB7XHJcbiAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGNvbnRlbnQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnZpZXcuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZCAhPT0gY29udGVudCkge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnRlbnQucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgY29udGVudC5kZXN0cm95KCk7XHJcbiAgICB2aWV3LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIHZpZXcuZGVzdHJveSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZVBvc2l0aW9uKFxyXG4gICAgZnJhbWU6IFJlY3QsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbiAgICBjaGlsZFRyYW5zZm9ybT86IGFueSxcclxuKTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHtcclxuICAgIGlmICghcGFyZW50RnJhbWUpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMCwgeTogMSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogcGFyZW50RnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdpZHRoID0gZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGhlaWdodCA9IGZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgY2hpbGRBbmNob3IgPSBjaGlsZFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAvLyBGaWdtYSBjb29yZGluYXRlcyBhcmUgbWVhc3VyZWQgZnJvbSB0aGUgcGFyZW50J3MgdG9wLWxlZnQuIENvbnZlcnRcclxuICAgICAgICAvLyB0aGF0IHJlY3RhbmdsZSB0byB0aGUgbG9jYWwgcG9zaXRpb24gb2YgdGhlIG5vZGUncyBjZW50ZXIgYW5jaG9yLlxyXG4gICAgICAgIHg6IChmcmFtZS54IC0gcGFyZW50RnJhbWUueCkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLnhcclxuICAgICAgICAgICAgKyB3aWR0aCAqIGNoaWxkQW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSlcclxuICAgICAgICAgICAgLSAoZnJhbWUueSAtIHBhcmVudEZyYW1lLnkpICogc2NhbGVcclxuICAgICAgICAgICAgLSBoZWlnaHQgKiAoMSAtIGNoaWxkQW5jaG9yLnkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVUcmFuc2Zvcm1Qb3NpdGlvbihcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgcGFyZW50VHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKHNwZWMuaXNSb290IHx8ICFzcGVjLmludHJpbnNpY1NpemUpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBtYXRyaXggPSBzcGVjLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgY29uc3QgdmFsdWVzID0gW1xyXG4gICAgICAgIG1hdHJpeD8uWzBdPy5bMF0sIG1hdHJpeD8uWzBdPy5bMV0sIG1hdHJpeD8uWzBdPy5bMl0sXHJcbiAgICAgICAgbWF0cml4Py5bMV0/LlswXSwgbWF0cml4Py5bMV0/LlsxXSwgbWF0cml4Py5bMV0/LlsyXSxcclxuICAgIF07XHJcbiAgICBpZiAoIXZhbHVlcy5ldmVyeSgodmFsdWUpID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgW20wMCwgbTAxLCB0eCwgbTEwLCBtMTEsIHR5XSA9IHZhbHVlcyBhcyBudW1iZXJbXTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShwYXJlbnRXaWR0aCkgfHwgIU51bWJlci5pc0Zpbml0ZShwYXJlbnRIZWlnaHQpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIC8vIEZpZ21hIHJlbGF0aXZlVHJhbnNmb3JtIGlzIHRvcC1sZWZ0IGJhc2VkLiBUcmFuc2Zvcm0gdGhlIHVucm90YXRlZCBsb2NhbFxyXG4gICAgLy8gY2VudGVyLCB0aGVuIGNvbnZlcnQgdGhlIHBhcmVudCdzIGRvd253YXJkIFkgYXhpcyB0byBDb2NvcyB1cHdhcmQgWS5cclxuICAgIGNvbnN0IGNlbnRlclggPSB0eCArIG0wMCAqIHNwZWMuaW50cmluc2ljU2l6ZS53aWR0aCAvIDJcclxuICAgICAgICArIG0wMSAqIHNwZWMuaW50cmluc2ljU2l6ZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgY2VudGVyWSA9IHR5ICsgbTEwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTExICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHg6IGNlbnRlclggKiBzY2FsZSAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSkgLSBjZW50ZXJZICogc2NhbGUsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybTogYW55LCB3aWR0aDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlcik6IHZvaWQge1xuICAgIC8vIFJvdW5kIG9ubHkgYXQgdGhlIFVJVHJhbnNmb3JtIHdyaXRlIGJvdW5kYXJ5LCBhZnRlciBzY2FsZS9sYXlvdXQgbWF0aC5cbiAgICAvLyBEbyBub3QgbG9jayBzaXplcyByZWNhbGN1bGF0ZWQgbGF0ZXIgYnkgTGFiZWwgb3Igb3RoZXIgcnVudGltZSBjb21wb25lbnRzLlxuICAgIHRyYW5zZm9ybT8uc2V0Q29udGVudFNpemUoXG4gICAgICAgIE1hdGgucm91bmQoKHdpZHRoICsgTnVtYmVyLkVQU0lMT04pICogMTAwKSAvIDEwMCxcbiAgICAgICAgTWF0aC5yb3VuZCgoaGVpZ2h0ICsgTnVtYmVyLkVQU0lMT04pICogMTAwKSAvIDEwMCxcbiAgICApO1xufVxuXG5mdW5jdGlvbiBjb25maWd1cmVHZW9tZXRyeShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiBhbnkge1xuICAgIGNvbnN0IHsgVUlUcmFuc2Zvcm0sIFZlYzMgfSA9IGNjO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IG5vZGUuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBjb25zdCBzaXplID0gc3BlYy5pbnRyaW5zaWNTaXplID8/IHNwZWMuZnJhbWU7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxuICAgICAgICB0cmFuc2Zvcm0sXG4gICAgICAgIE1hdGgubWF4KDAsIHNpemUud2lkdGggKiBzY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS5oZWlnaHQgKiBzY2FsZSksXHJcbiAgICApO1xyXG4gICAgY29uc3QgcGFyZW50VHJhbnNmb3JtID0gbm9kZS5wYXJlbnQ/LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwb3NpdGlvbiA9IHNwZWMuaXNSb290XHJcbiAgICAgICAgPyB7IHg6IDAsIHk6IDAgfVxyXG4gICAgICAgIDogcmVsYXRpdmVUcmFuc2Zvcm1Qb3NpdGlvbihzcGVjLCBzY2FsZSwgcGFyZW50VHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyBmcmFtZVBvc2l0aW9uKHNwZWMuZnJhbWUsIHNwZWMucGFyZW50RnJhbWUsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0sIHRyYW5zZm9ybSk7XHJcbiAgICBub2RlLnNldFBvc2l0aW9uKG5ldyBWZWMzKHBvc2l0aW9uLngsIHBvc2l0aW9uLnksIG5vZGUucG9zaXRpb24/LnogPz8gMCkpO1xyXG4gICAgbm9kZS5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCBzcGVjLnJvdGF0aW9uKTtcclxuICAgIG5vZGUuYWN0aXZlID0gc3BlYy52aXNpYmxlO1xyXG4gICAgcmV0dXJuIHRyYW5zZm9ybTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC52aXNpYmxlICE9PSBmYWxzZSAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRQYWludChwYWludHM6IEZpZ21hUGFpbnRbXSk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHBhaW50cy5maW5kKChwYWludCkgPT4gcGFpbnQudHlwZSA9PT0gJ1NPTElEJ1xyXG4gICAgICAgICYmIHBhaW50LnZpc2libGUgIT09IGZhbHNlXHJcbiAgICAgICAgJiYgKHBhaW50Lm9wYWNpdHkgPz8gMSkgPiAwXHJcbiAgICAgICAgJiYgQm9vbGVhbihwYWludC5jb2xvcilcclxuICAgICAgICAmJiAocGFpbnQuY29sb3I/LmEgPz8gMSkgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVNvbGlkRmlsbChzcGVjOiBTY2VuZU5vZGVTcGVjKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5maWxscyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZhbGlkU29saWRTdHJva2Uoc3BlYzogU2NlbmVOb2RlU3BlYyk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHNwZWMuc3Ryb2tlV2VpZ2h0ID4gMCA/IHZpc2libGVTb2xpZFBhaW50KHNwZWMuc3Ryb2tlcykgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc0dyYXBoaWNzVmlzdWFsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHZpc2libGVTb2xpZEZpbGwoc3BlYykgfHwgdmFsaWRTb2xpZFN0cm9rZShzcGVjKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRyYXdHcmFwaGljcyhncmFwaGljczogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVNvbGlkRmlsbChzcGVjKTtcclxuICAgIGNvbnN0IHN0cm9rZSA9IHZhbGlkU29saWRTdHJva2Uoc3BlYyk7XHJcbiAgICBpZiAoIWZpbGwgJiYgIXN0cm9rZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHJhZGl1cyA9IE1hdGgubWF4KFxyXG4gICAgICAgIDAsXHJcbiAgICAgICAgTWF0aC5taW4oTWF0aC5taW4oLi4uc3BlYy5jb3JuZXJSYWRpaSkgKiBzY2FsZSwgd2lkdGggLyAyLCBoZWlnaHQgLyAyKSxcclxuICAgICk7XHJcbiAgICBpZiAoc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJykge1xyXG4gICAgICAgIGdyYXBoaWNzLmVsbGlwc2UoMCwgMCwgd2lkdGggLyAyLCBoZWlnaHQgLyAyKTtcclxuICAgIH0gZWxzZSBpZiAocmFkaXVzID4gMCkge1xyXG4gICAgICAgIGdyYXBoaWNzLnJvdW5kUmVjdCgtd2lkdGggLyAyLCAtaGVpZ2h0IC8gMiwgd2lkdGgsIGhlaWdodCwgcmFkaXVzKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZ3JhcGhpY3MucmVjdCgtd2lkdGggLyAyLCAtaGVpZ2h0IC8gMiwgd2lkdGgsIGhlaWdodCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICBncmFwaGljcy5maWxsQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgZ3JhcGhpY3MuZmlsbCgpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cm9rZT8uY29sb3IpIHtcclxuICAgICAgICBncmFwaGljcy5saW5lV2lkdGggPSBNYXRoLm1heCgwLjUsIHNwZWMuc3Ryb2tlV2VpZ2h0ICogc2NhbGUpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZUNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgc3Ryb2tlLmNvbG9yLCBzdHJva2Uub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5zdHJva2UoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlR3JhcGhpY3Mobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBncmFwaGljcyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBncmFwaGljcy5lbmFibGVkID0gdHJ1ZTtcclxuICAgIGdyYXBoaWNzLmNsZWFyKCk7XHJcbiAgICBkcmF3R3JhcGhpY3MoZ3JhcGhpY3MsIHNwZWMsIHNjYWxlLCBjYyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZUxhYmVsVGV4dChjaGFyYWN0ZXJzOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIChjaGFyYWN0ZXJzID8/ICcnKVxyXG4gICAgICAgIC5yZXBsYWNlKC9cXHJcXG4vZywgJ1xcbicpXHJcbiAgICAgICAgLnJlcGxhY2UoL1tcXHJcXHUyMDI4XFx1MjAyOV0vZywgJ1xcbicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVRleHRBbGlnbm1lbnQoY29tcG9uZW50OiBhbnksIHN0eWxlOiBTY2VuZU5vZGVTcGVjWyd0ZXh0U3R5bGUnXSwgcmVuZGVyZXI6IGFueSk6IHZvaWQge1xuICAgIC8vIENvY29zIGhhcyBubyBKVVNUSUZJRUQgYWxpZ25tZW50OiB1bnN1cHBvcnRlZC9taXNzaW5nIHZhbHVlcyB1c2UgTEVGVC9UT1AuXG4gICAgY29tcG9uZW50Lmhvcml6b250YWxBbGlnbiA9IHN0eWxlPy50ZXh0QWxpZ25Ib3Jpem9udGFsID09PSAnQ0VOVEVSJ1xuICAgICAgICA/IHJlbmRlcmVyLkhvcml6b250YWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduSG9yaXpvbnRhbCA9PT0gJ1JJR0hUJ1xuICAgICAgICAgICAgPyByZW5kZXJlci5Ib3Jpem9udGFsQWxpZ24uUklHSFRcbiAgICAgICAgICAgIDogcmVuZGVyZXIuSG9yaXpvbnRhbEFsaWduLkxFRlQ7XG4gICAgY29tcG9uZW50LnZlcnRpY2FsQWxpZ24gPSBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdDRU5URVInXG4gICAgICAgID8gcmVuZGVyZXIuVmVydGljYWxBbGlnbi5DRU5URVJcbiAgICAgICAgOiBzdHlsZT8udGV4dEFsaWduVmVydGljYWwgPT09ICdCT1RUT00nXG4gICAgICAgICAgICA/IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uQk9UVE9NXG4gICAgICAgICAgICA6IHJlbmRlcmVyLlZlcnRpY2FsQWxpZ24uVE9QO1xufVxyXG5cclxuZnVuY3Rpb24gZmlnbWFQYW5lbEZvbnRTaXplKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICAgIGNvbnN0IGZvbnRTaXplID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICByZXR1cm4gTWF0aC5yb3VuZCgoZm9udFNpemUgKyBOdW1iZXIuRVBTSUxPTikgKiAxMDApIC8gMTAwO1xufVxuXG5mdW5jdGlvbiBmaWdtYVBhbmVsTGluZUhlaWdodCh2YWx1ZTogbnVtYmVyIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgICBjb25zdCBsaW5lSGVpZ2h0ID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiAxNjtcbiAgICAvLyBQcmVzZXJ2ZSBGaWdtYSdzIHBpeGVsIGxpbmUgaGVpZ2h0IGluZGVwZW5kZW50bHkgb2YgaW1wb3J0IHNjYWxlIGFuZFxuICAgIC8vIGVuZ2luZS1jb21wdXRlZCBjb250ZW50IHNpemU7IG9ubHkgcm91bmQgdG8gb25lIGRlY2ltYWwgcGxhY2UuXG4gICAgcmV0dXJuIE1hdGgucm91bmQoKGxpbmVIZWlnaHQgKyBOdW1iZXIuRVBTSUxPTikgKiAxMCkgLyAxMDtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlTGFiZWwobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB7IExhYmVsIH0gPSBjYztcclxuICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoTGFiZWwpID8/IG5vZGUuYWRkQ29tcG9uZW50KExhYmVsKTtcclxuICAgIGNvbnN0IHN0eWxlID0gc3BlYy50ZXh0U3R5bGUgPz8ge307XHJcbiAgICBjb25zdCBjaGFyYWN0ZXJzID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICAvLyBGaWdtYSBOT05FIG1lYW5zIGEgZml4ZWQgYm94LCBub3QgQ29jb3MgT3ZlcmZsb3cuTk9ORS4gQm90aCBmaXhlZC13aWR0aFxuICAgIC8vIG1vZGVzIHdyYXAgYW5kIGdyb3cgdmVydGljYWxseTsgbWlzc2luZyBsZWdhY3kgbWV0YWRhdGEgc3RheXMgYXV0by13aWR0aC5cbiAgICBjb25zdCB3cmFwID0gc3R5bGUudGV4dEF1dG9SZXNpemUgPT09ICdIRUlHSFQnIHx8IHN0eWxlLnRleHRBdXRvUmVzaXplID09PSAnTk9ORSc7XG4gICAgLy8gRmlnbWEgc3RvcmVzIG1vcmUgcHJlY2lzaW9uIHRoYW4gaXRzIHBhbmVsIGRpc3BsYXlzLiBNYXRjaCB0aGUgdmlzaWJsZVxyXG4gICAgLy8gZGVzaWduIHZhbHVlICh1cCB0byB0d28gZGVjaW1hbHMpIGluc3RlYWQgb2YgbGVha2luZyBpdHMgaW50ZXJuYWwgZmxvYXQuXHJcbiAgICBsYWJlbC5mb250U2l6ZSA9IGZpZ21hUGFuZWxGb250U2l6ZShzdHlsZS5mb250U2l6ZSk7XHJcbiAgICBsYWJlbC5saW5lSGVpZ2h0ID0gZmlnbWFQYW5lbExpbmVIZWlnaHQoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplKTtcbiAgICBsYWJlbC5zcGFjaW5nWCA9IChzdHlsZS5sZXR0ZXJTcGFjaW5nID8/IDApICogc2NhbGU7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IHdyYXAgPyBMYWJlbC5PdmVyZmxvdy5SRVNJWkVfSEVJR0hUIDogTGFiZWwuT3ZlcmZsb3cuTk9ORTtcbiAgICBsYWJlbC5lbmFibGVXcmFwVGV4dCA9IHdyYXA7XG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KGxhYmVsLCBzdHlsZSwgTGFiZWwpO1xuICAgIC8vIEF1dG8td2lkdGggbGFiZWxzIHVzZSBhIGNlbnRlcmVkIHZlcnRpY2FsIGJhc2VsaW5lIHJlZ2FyZGxlc3Mgb2YgRmlnbWEnc1xuICAgIC8vIHZlcnRpY2FsIGFsaWdubWVudC4gRml4ZWQtd2lkdGggd3JhcHBpbmcgbGFiZWxzIHJldGFpbiB0aGUgRmlnbWEgc2V0dGluZy5cbiAgICBpZiAobGFiZWwub3ZlcmZsb3cgPT09IExhYmVsLk92ZXJmbG93Lk5PTkUpIHtcbiAgICAgICAgbGFiZWwudmVydGljYWxBbGlnbiA9IExhYmVsLlZlcnRpY2FsQWxpZ24uQ0VOVEVSO1xuICAgIH1cbiAgICBsYWJlbC5zdHJpbmcgPSBjaGFyYWN0ZXJzO1xuICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSBmYWxzZTtcclxuICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgeyByOiAxLCBnOiAxLCBiOiAxLCBhOiAxIH0pO1xyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVQYWludChzcGVjLmZpbGxzKTtcclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGxhYmVsLmNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmlzaWJsZVBhaW50KHNwZWMuc3Ryb2tlcyk7XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvciAmJiBzcGVjLnN0cm9rZVdlaWdodCA+IDApIHtcclxuICAgICAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gdHJ1ZTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVXaWR0aCA9IE1hdGgubWF4KDEsIHNwZWMuc3Ryb2tlV2VpZ2h0ICogc2NhbGUpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVSaWNoVGV4dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgUmljaFRleHQgfSA9IGNjO1xyXG4gICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCkgPz8gbm9kZS5hZGRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIHJpY2hUZXh0LnN0cmluZyA9IG5vcm1hbGl6ZUxhYmVsVGV4dChzcGVjLmNoYXJhY3RlcnMpO1xyXG4gICAgcmljaFRleHQuZm9udFNpemUgPSBmaWdtYVBhbmVsRm9udFNpemUoc3R5bGUuZm9udFNpemUpO1xyXG4gICAgcmljaFRleHQubGluZUhlaWdodCA9IGZpZ21hUGFuZWxMaW5lSGVpZ2h0KHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSk7XG4gICAgcmljaFRleHQubWF4V2lkdGggPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpO1xyXG4gICAgcmljaFRleHQuaGFuZGxlVG91Y2hFdmVudCA9IGZhbHNlO1xyXG4gICAgYXBwbHlUZXh0QWxpZ25tZW50KHJpY2hUZXh0LCBzdHlsZSwgUmljaFRleHQpO1xuICAgIHJpY2hUZXh0LmZvbnRGYW1pbHkgPSBzdHlsZS5mb250RmFtaWx5ID8/ICcnO1xyXG4gICAgcmljaFRleHQudXNlU3lzdGVtRm9udCA9ICFzcGVjLmZvbnRVdWlkO1xyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVQYWludChzcGVjLmZpbGxzKTtcclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIHJpY2hUZXh0LmZvbnRDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gbG9hZEFzc2V0KGFzc2V0TWFuYWdlcjogYW55LCB1dWlkOiBzdHJpbmcpOiBQcm9taXNlPGFueT4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICBhc3NldE1hbmFnZXIubG9hZEFueSh7IHV1aWQgfSwgKGVycm9yOiBFcnJvciB8IG51bGwsIGFzc2V0OiBhbnkpID0+IHtcclxuICAgICAgICAgICAgaWYgKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICByZWplY3QoZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlc29sdmUoYXNzZXQpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVNwcml0ZShcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIHRhcmdldEZyYW1lOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gPSBzcGVjLmZyYW1lLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICghc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IFNwcml0ZSwgVUlUcmFuc2Zvcm0sIGFzc2V0TWFuYWdlciB9ID0gY2M7XHJcbiAgICBjb25zdCBzcHJpdGUgPSBub2RlLmdldENvbXBvbmVudChTcHJpdGUpID8/IG5vZGUuYWRkQ29tcG9uZW50KFNwcml0ZSk7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCB0YXJnZXRXaWR0aCA9IE1hdGgubWF4KDAsIHRhcmdldEZyYW1lLndpZHRoICogc2NhbGUpO1xyXG4gICAgY29uc3QgdGFyZ2V0SGVpZ2h0ID0gTWF0aC5tYXgoMCwgdGFyZ2V0RnJhbWUuaGVpZ2h0ICogc2NhbGUpO1xyXG5cclxuICAgIC8vIEtlZXAgYXNzaWdubWVudCBkZXRlcm1pbmlzdGljOiBhIG5ldyBTcHJpdGUgbWF5IGRlZmF1bHQgdG8gVFJJTU1FRCBhbmRcclxuICAgIC8vIGltbWVkaWF0ZWx5IHJld3JpdGUgVUlUcmFuc2Zvcm0gd2hlbiBpdHMgU3ByaXRlRnJhbWUgaXMgYXNzaWduZWQuXHJcbiAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xyXG4gICAgY29uc3Qgc3ByaXRlRnJhbWUgPSBhd2FpdCBsb2FkQXNzZXQoYXNzZXRNYW5hZ2VyLCBzcGVjLnNwcml0ZS51dWlkKTtcbiAgICBzcHJpdGUuc3ByaXRlRnJhbWUgPSBzcHJpdGVGcmFtZTtcbiAgICBjb25zdCBzbGljZWQgPSBzcGVjLnNwcml0ZS5zbGljZWQgfHwgKCFzcGVjLnNwcml0ZS5zbGljZUZhbGxiYWNrXG4gICAgICAgICYmIFtzcHJpdGVGcmFtZS5pbnNldExlZnQsIHNwcml0ZUZyYW1lLmluc2V0UmlnaHQsIHNwcml0ZUZyYW1lLmluc2V0VG9wLCBzcHJpdGVGcmFtZS5pbnNldEJvdHRvbV1cbiAgICAgICAgICAgIC5zb21lKCh2YWx1ZSkgPT4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSAmJiB2YWx1ZSA+IDApKTtcbiAgICBzcHJpdGUudHlwZSA9IHNwZWMuc3ByaXRlLnRpbGVkXG4gICAgICAgID8gU3ByaXRlLlR5cGUuVElMRURcbiAgICAgICAgOiBzbGljZWRcbiAgICAgICAgICAgID8gU3ByaXRlLlR5cGUuU0xJQ0VEXHJcbiAgICAgICAgICAgIDogU3ByaXRlLlR5cGUuU0lNUExFO1xyXG5cclxuICAgIGlmICghc2xpY2VkICYmICFzcGVjLnNwcml0ZS50aWxlZCkge1xuICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuVFJJTU1FRDtcclxuICAgICAgICBjb25zdCB0cmltbWVkV2lkdGggPSBOdW1iZXIodHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpO1xyXG4gICAgICAgIGNvbnN0IHRyaW1tZWRIZWlnaHQgPSBOdW1iZXIodHJhbnNmb3JtPy5jb250ZW50U2l6ZT8uaGVpZ2h0KTtcclxuICAgICAgICBjb25zdCByYXdXaWR0aCA9IE51bWJlcihzcHJpdGVGcmFtZT8ub3JpZ2luYWxTaXplPy53aWR0aCA/PyBzcHJpdGVGcmFtZT8ud2lkdGgpO1xyXG4gICAgICAgIGNvbnN0IHJhd0hlaWdodCA9IE51bWJlcihzcHJpdGVGcmFtZT8ub3JpZ2luYWxTaXplPy5oZWlnaHQgPz8gc3ByaXRlRnJhbWU/LmhlaWdodCk7XHJcbiAgICAgICAgY29uc3QgaGFzVmFsaWRTcHJpdGVTaXplID0gTnVtYmVyLmlzRmluaXRlKHRyaW1tZWRXaWR0aClcclxuICAgICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKHRyaW1tZWRIZWlnaHQpXHJcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdXaWR0aClcclxuICAgICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKHJhd0hlaWdodClcclxuICAgICAgICAgICAgJiYgcmF3V2lkdGggPiAwXHJcbiAgICAgICAgICAgICYmIHJhd0hlaWdodCA+IDA7XHJcbiAgICAgICAgaWYgKGhhc1ZhbGlkU3ByaXRlU2l6ZVxyXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdXaWR0aCAtIHRhcmdldFdpZHRoKSA8PSAwLjUxXHJcbiAgICAgICAgICAgICYmIE1hdGguYWJzKHJhd0hlaWdodCAtIHRhcmdldEhlaWdodCkgPD0gMC41MSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemUpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2NhbGVYID0gdGFyZ2V0V2lkdGggLyByYXdXaWR0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2NhbGVZID0gdGFyZ2V0SGVpZ2h0IC8gcmF3SGVpZ2h0O1xyXG4gICAgICAgICAgICBpZiAoTWF0aC5hYnMoc2NhbGVYIC0gc2NhbGVZKSA8PSAwLjAwMDEpIHtcclxuICAgICAgICAgICAgICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XHJcbiAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgdHJpbW1lZFdpZHRoICogc2NhbGVYLCB0cmltbWVkSGVpZ2h0ICogc2NhbGVZKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU2xpY2VkL3RpbGVkIHNwcml0ZXMgYW5kIHNwcml0ZXMgcmVzaXplZCBpbiBGaWdtYSBtdXN0IHJldGFpbiB0aGUgZGVzaWduXHJcbiAgICAvLyBzaXplLiBDb2NvcyByZXByZXNlbnRzIHRoYXQgc3RhdGUgYXMgQ1VTVE9NLlxyXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCB0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0KTtcbn1cclxuXHJcbmZ1bmN0aW9uIHJlcXVpcmVzVGlsZWRNYXNrKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZCAmJiBzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbmF0aXZlVGlsZVNjYWxlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBudW1iZXIge1xyXG4gICAgY29uc3Qgc2NhbGUgPSBzcGVjLnNwcml0ZT8udGlsZVNjYWxlO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBzY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHNjYWxlKSAmJiBzY2FsZSA+IDBcclxuICAgICAgICA/IHNjYWxlXHJcbiAgICAgICAgOiAxO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnRpbGVkKVxyXG4gICAgICAgICYmIChyZXF1aXJlc1RpbGVkTWFzayhzcGVjKSB8fCBNYXRoLmFicyhuYXRpdmVUaWxlU2NhbGUoc3BlYykgLSAxKSA+IDFlLTYpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lKVxyXG4gICAgICAgICYmICFzcGVjLnNwcml0ZT8uc2xpY2VkXHJcbiAgICAgICAgJiYgIXNwZWMuc3ByaXRlPy50aWxlZDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlT3ZlcmZsb3dTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlbmRlckZyYW1lID0gc3BlYy5zcHJpdGU/LnJlbmRlckZyYW1lO1xyXG4gICAgaWYgKCFyZW5kZXJGcmFtZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg6LaF6L6555WMIFBORyDoioLngrnigJwke3NwZWMubmFtZX3igJ3nvLrlsJHmuLLmn5PovrnnlYzjgIJgKTtcclxuICAgIH1cclxuICAgIGxldCBoZWxwZXIgPSBub2RlLmdldENoaWxkQnlOYW1lKE9WRVJGTE9XX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGd1YXJkICYmIGhlbHBlcikge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIGd1YXJkKTtcclxuICAgIH1cclxuICAgIGlmICghaGVscGVyKSB7XHJcbiAgICAgICAgaGVscGVyID0gbmV3IGNjLk5vZGUoT1ZFUkZMT1dfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgbm9kZS5hZGRDaGlsZChoZWxwZXIpO1xyXG4gICAgfVxyXG4gICAgaGVscGVyLm5hbWUgPSBPVkVSRkxPV19TUFJJVEVfTk9ERV9OQU1FO1xyXG4gICAgaGVscGVyLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgIGhlbHBlci5hY3RpdmUgPSB0cnVlO1xyXG5cclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IGhlbHBlci5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgPz8gaGVscGVyLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgdHJhbnNmb3JtLFxuICAgICAgICBNYXRoLm1heCgwLCByZW5kZXJGcmFtZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCByZW5kZXJGcmFtZS5oZWlnaHQgKiBzY2FsZSksXHJcbiAgICApO1xyXG4gICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKGhlbHBlciwgc3BlYywgc2NhbGUsIGNjLCByZW5kZXJGcmFtZSk7XHJcblxyXG4gICAgY29uc3QgZ2VvbWV0cnlDZW50ZXJYID0gc3BlYy5mcmFtZS54ICsgc3BlYy5mcmFtZS53aWR0aCAvIDI7XHJcbiAgICBjb25zdCBnZW9tZXRyeUNlbnRlclkgPSBzcGVjLmZyYW1lLnkgKyBzcGVjLmZyYW1lLmhlaWdodCAvIDI7XHJcbiAgICBjb25zdCByZW5kZXJDZW50ZXJYID0gcmVuZGVyRnJhbWUueCArIHJlbmRlckZyYW1lLndpZHRoIC8gMjtcclxuICAgIGNvbnN0IHJlbmRlckNlbnRlclkgPSByZW5kZXJGcmFtZS55ICsgcmVuZGVyRnJhbWUuaGVpZ2h0IC8gMjtcclxuICAgIC8vIEZpZ21hIHBhZ2UgWSBwb2ludHMgZG93bndhcmQgd2hpbGUgQ29jb3MgVUkgWSBwb2ludHMgdXB3YXJkLlxyXG4gICAgY29uc3Qgd29ybGREZWx0YVggPSAocmVuZGVyQ2VudGVyWCAtIGdlb21ldHJ5Q2VudGVyWCkgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdvcmxkRGVsdGFZID0gLShyZW5kZXJDZW50ZXJZIC0gZ2VvbWV0cnlDZW50ZXJZKSAqIHNjYWxlO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IE51bWJlci5pc0Zpbml0ZShzcGVjLndvcmxkUm90YXRpb24pXHJcbiAgICAgICAgPyBOdW1iZXIoc3BlYy53b3JsZFJvdGF0aW9uKVxyXG4gICAgICAgIDogc3BlYy5yb3RhdGlvbjtcclxuICAgIGNvbnN0IHJhZGlhbnMgPSB3b3JsZFJvdGF0aW9uICogTWF0aC5QSSAvIDE4MDtcclxuICAgIGNvbnN0IGNvc2luZSA9IE1hdGguY29zKHJhZGlhbnMpO1xyXG4gICAgY29uc3Qgc2luZSA9IE1hdGguc2luKHJhZGlhbnMpO1xyXG4gICAgLy8gVGhlIGV4cG9ydGVkIFBORyBpcyBhbHJlYWR5IHJhc3Rlcml6ZWQgaW4gRmlnbWEgcGFnZSBheGVzLiBDb3VudGVyYWN0XHJcbiAgICAvLyB0aGUgbG9naWNhbCBzaGVsbCdzIGFjY3VtdWxhdGVkIHJvdGF0aW9uIGFuZCBleHByZXNzIHRoZSB2aXN1YWwtY2VudGVyXHJcbiAgICAvLyBvZmZzZXQgYmFjayBpbiB0aGF0IHNoZWxsJ3MgbG9jYWwgY29vcmRpbmF0ZSBzeXN0ZW0uXHJcbiAgICBjb25zdCBsb2NhbFggPSBjb3NpbmUgKiB3b3JsZERlbHRhWCArIHNpbmUgKiB3b3JsZERlbHRhWTtcclxuICAgIGNvbnN0IGxvY2FsWSA9IC1zaW5lICogd29ybGREZWx0YVggKyBjb3NpbmUgKiB3b3JsZERlbHRhWTtcclxuICAgIGhlbHBlci5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMyhsb2NhbFgsIGxvY2FsWSwgMCkpO1xyXG4gICAgaGVscGVyLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIC13b3JsZFJvdGF0aW9uKTtcclxuICAgIGhlbHBlci5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICBoZWxwZXIuc2V0U2libGluZ0luZGV4KDApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVUaWxlZFNwcml0ZUhlbHBlcihcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgbmVlZHNNYXNrID0gcmVxdWlyZXNUaWxlZE1hc2soc3BlYyk7XHJcbiAgICBsZXQgdGlsZWRNYXNrID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICBsZXQgdGlsZWRTcHJpdGUgPSB0aWxlZE1hc2s/LmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpXHJcbiAgICAgICAgPz8gbm9kZS5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkU3ByaXRlLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKG5lZWRzTWFzaykge1xyXG4gICAgICAgIGlmICghdGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIHRpbGVkTWFzayA9IG5ldyBjYy5Ob2RlKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgICAgICAgICAgbm9kZS5hZGRDaGlsZCh0aWxlZE1hc2spO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aWxlZE1hc2submFtZSA9IFRJTEVEX01BU0tfTk9ERV9OQU1FO1xyXG4gICAgICAgIHRpbGVkTWFzay5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdGlsZWRNYXNrLmFjdGl2ZSA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgbWFza1RyYW5zZm9ybSA9IHRpbGVkTWFzay5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IHRpbGVkTWFzay5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIG1hc2tUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUoXG4gICAgICAgICAgICBtYXNrVHJhbnNmb3JtLFxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSksXHJcbiAgICAgICAgKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0UG9zaXRpb24obmV3IGNjLlZlYzMoMCwgMCwgMCkpO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgICAgIGNvbmZpZ3VyZUNsaXAodGlsZWRNYXNrLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFNpYmxpbmdJbmRleCgwKTtcclxuICAgIH0gZWxzZSBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udGlsZWRNYXNrLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aWxlZE1hc2sucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIHRpbGVkTWFzay5kZXN0cm95KCk7XHJcbiAgICAgICAgdGlsZWRNYXNrID0gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHNwcml0ZVBhcmVudCA9IHRpbGVkTWFzayA/PyBub2RlO1xyXG4gICAgaWYgKCF0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgIHRpbGVkU3ByaXRlID0gbmV3IGNjLk5vZGUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgc3ByaXRlUGFyZW50LmFkZENoaWxkKHRpbGVkU3ByaXRlKTtcclxuICAgIH0gZWxzZSBpZiAodGlsZWRTcHJpdGUucGFyZW50ICE9PSBzcHJpdGVQYXJlbnQpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZS5wYXJlbnQgPSBzcHJpdGVQYXJlbnQ7XHJcbiAgICB9XHJcbiAgICB0aWxlZFNwcml0ZS5uYW1lID0gVElMRURfU1BSSVRFX05PREVfTkFNRTtcclxuICAgIHRpbGVkU3ByaXRlLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgIHRpbGVkU3ByaXRlLmFjdGl2ZSA9IHRydWU7XHJcbiAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUodGlsZWRTcHJpdGUsIHNwZWMsIHNjYWxlLCBjYyk7XHJcbiAgICBjb25zdCB0aWxlU2NhbGUgPSBuYXRpdmVUaWxlU2NhbGUoc3BlYyk7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSB0aWxlZFNwcml0ZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgPz8gdGlsZWRTcHJpdGUuYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKFxuICAgICAgICB0cmFuc2Zvcm0sXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAvIHRpbGVTY2FsZSksXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSAvIHRpbGVTY2FsZSksXHJcbiAgICApO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0UG9zaXRpb24obmV3IGNjLlZlYzMoMCwgMCwgMCkpO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgMCk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTY2FsZShuZXcgY2MuVmVjMyh0aWxlU2NhbGUsIHRpbGVTY2FsZSwgMSkpO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0U2libGluZ0luZGV4KDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVPcGFjaXR5KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMub3BhY2l0eSA+PSAwLjk5OSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG9wYWNpdHkgPSBub2RlLmdldENvbXBvbmVudChjYy5VSU9wYWNpdHkpID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLlVJT3BhY2l0eSk7XHJcbiAgICBvcGFjaXR5Lm9wYWNpdHkgPSBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNwZWMub3BhY2l0eSkpICogMjU1KTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlTGF5b3V0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgaWYgKCFtb2RlIHx8IG1vZGUgPT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHsgTGF5b3V0LCBTaXplIH0gPSBjYztcclxuICAgIGNvbnN0IGxheW91dCA9IG5vZGUuZ2V0Q29tcG9uZW50KExheW91dCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGF5b3V0KTtcclxuICAgIGxheW91dC50eXBlID0gbW9kZSA9PT0gJ0hPUklaT05UQUwnXHJcbiAgICAgICAgPyBMYXlvdXQuVHlwZS5IT1JJWk9OVEFMXHJcbiAgICAgICAgOiBtb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LlR5cGUuVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuVHlwZS5HUklEO1xyXG4gICAgaWYgKG1vZGUgPT09ICdHUklEJykge1xyXG4gICAgICAgIGxheW91dC5zdGFydEF4aXMgPSBzcGVjLmxheW91dD8uc291cmNlTW9kZSA9PT0gJ1ZFUlRJQ0FMJ1xyXG4gICAgICAgICAgICA/IExheW91dC5BeGlzRGlyZWN0aW9uLlZFUlRJQ0FMXHJcbiAgICAgICAgICAgIDogTGF5b3V0LkF4aXNEaXJlY3Rpb24uSE9SSVpPTlRBTDtcclxuICAgIH1cclxuICAgIGxheW91dC5yZXNpemVNb2RlID0gTGF5b3V0LlJlc2l6ZU1vZGUuTk9ORTtcclxuICAgIGxheW91dC5wYWRkaW5nTGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdSaWdodCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nUmlnaHQgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nVG9wID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdUb3AgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nQm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGxheW91dC5zcGFjaW5nWCA9IHNwZWMubGF5b3V0IS5pdGVtU3BhY2luZyAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdZID0gKG1vZGUgPT09ICdHUklEJyA/IHNwZWMubGF5b3V0IS5jb3VudGVyU3BhY2luZyA6IHNwZWMubGF5b3V0IS5pdGVtU3BhY2luZykgKiBzY2FsZTtcclxuICAgIGNvbnN0IGFjdGl2ZUNoaWxkcmVuID0gc3BlYy5jaGlsZHJlbi5maWx0ZXIoKGNoaWxkKSA9PiBjaGlsZC52aXNpYmxlKTtcclxuICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW5XaWR0aCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLndpZHRoICogc2NhbGUsIDApO1xyXG4gICAgICAgIGNvbnN0IGlubmVyV2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ0xlZnQgLSBsYXlvdXQucGFkZGluZ1JpZ2h0O1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1ggPSBNYXRoLm1heCgwLCAoaW5uZXJXaWR0aCAtIGNoaWxkcmVuV2lkdGgpIC8gKGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCB1c2VkID0gY2hpbGRyZW5XaWR0aCArIGxheW91dC5zcGFjaW5nWCAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lcldpZHRoIC0gdXNlZCk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nTGVmdCArPSByZW1haW5pbmc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG1vZGUgPT09ICdWRVJUSUNBTCcgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgY2hpbGRyZW5IZWlnaHQgPSBhY3RpdmVDaGlsZHJlbi5yZWR1Y2UoKHRvdGFsLCBjaGlsZCkgPT4gdG90YWwgKyBjaGlsZC5mcmFtZS5oZWlnaHQgKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC0gbGF5b3V0LnBhZGRpbmdUb3AgLSBsYXlvdXQucGFkZGluZ0JvdHRvbTtcclxuICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ1NQQUNFX0JFVFdFRU4nICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgbGF5b3V0LnNwYWNpbmdZID0gTWF0aC5tYXgoMCwgKGlubmVySGVpZ2h0IC0gY2hpbGRyZW5IZWlnaHQpIC8gKGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBjb25zdCB1c2VkID0gY2hpbGRyZW5IZWlnaHQgKyBsYXlvdXQuc3BhY2luZ1kgKiBNYXRoLm1heCgwLCBhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgaW5uZXJIZWlnaHQgLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ1RvcCArPSByZW1haW5pbmcgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ1RvcCArPSByZW1haW5pbmc7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgbGF5b3V0LmNlbGxTaXplID0gbmV3IFNpemUoXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUud2lkdGgpKSAqIHNjYWxlLFxyXG4gICAgICAgICAgICBNYXRoLm1heCguLi5zcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IGNoaWxkLmZyYW1lLmhlaWdodCkpICogc2NhbGUsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlDb3VudGVyQWxpZ25tZW50KFxyXG4gICAgcGFyZW50OiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IG1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGNvbnN0IGFsaWdubWVudCA9IHNwZWMubGF5b3V0Py5jb3VudGVyQWxpZ247XHJcbiAgICBpZiAoIW1vZGUgfHwgIWFsaWdubWVudCB8fCAhWydIT1JJWk9OVEFMJywgJ1ZFUlRJQ0FMJ10uaW5jbHVkZXMobW9kZSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBwYXJlbnQuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBhcmVudFdpZHRoID0gTnVtYmVyKHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8uaGVpZ2h0KSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0uY29udGVudFNpemUuaGVpZ2h0KVxyXG4gICAgICAgIDogc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGxheW91dFdpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0SGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGxlZnQgPSBzcGVjLmxheW91dCEucGFkZGluZ0xlZnQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgdG9wID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdUb3AgKiBzY2FsZTtcclxuICAgIGNvbnN0IGJvdHRvbSA9IHNwZWMubGF5b3V0IS5wYWRkaW5nQm90dG9tICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGZvciAoY29uc3QgY2hpbGRTcGVjIG9mIHNwZWMuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gbm9kZU1hcFtjaGlsZFNwZWMuZmlnbWFJZF07XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSB1dWlkID8gZmluZEJ5VXVpZChwYXJlbnQsIHV1aWQpIDogbnVsbDtcclxuICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBjaGlsZD8uZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBpZiAoIWNoaWxkIHx8ICF0cmFuc2Zvcm0pIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBvc2l0aW9uID0gY2hpbGQucG9zaXRpb24uY2xvbmUoKTtcclxuICAgICAgICBpZiAobW9kZSA9PT0gJ0hPUklaT05UQUwnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dEhlaWdodCAtIHRvcCAtIGJvdHRvbSk7XHJcbiAgICAgICAgICAgIGxldCB0b3BPZmZzZXQgPSB0b3A7XHJcbiAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICB0b3BPZmZzZXQgPSB0b3AgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLmhlaWdodCkgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKGFsaWdubWVudCA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IGxheW91dEhlaWdodCAtIGJvdHRvbSAtIHRyYW5zZm9ybS5oZWlnaHQ7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRJbXBvcnRlZENvbnRlbnRTaXplKHRyYW5zZm9ybSwgdHJhbnNmb3JtLndpZHRoLCBhdmFpbGFibGUpO1xuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi55ID0gcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSlcclxuICAgICAgICAgICAgICAgIC0gdG9wT2Zmc2V0XHJcbiAgICAgICAgICAgICAgICAtIHRyYW5zZm9ybS5oZWlnaHQgKiAoMSAtICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnkgPz8gMC41KSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0V2lkdGggLSBsZWZ0IC0gcmlnaHQpO1xyXG4gICAgICAgICAgICBsZXQgbGVmdE9mZnNldCA9IGxlZnQ7XHJcbiAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsZWZ0T2Zmc2V0ID0gbGVmdCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0ud2lkdGgpIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChhbGlnbm1lbnQgPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsZWZ0T2Zmc2V0ID0gbGF5b3V0V2lkdGggLSByaWdodCAtIHRyYW5zZm9ybS53aWR0aDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodHJhbnNmb3JtLCBhdmFpbGFibGUsIHRyYW5zZm9ybS5oZWlnaHQpO1xuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi54ID0gbGVmdE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICAgICArIHRyYW5zZm9ybS53aWR0aCAqICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnggPz8gMC41KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2hpbGQuc2V0UG9zaXRpb24ocG9zaXRpb24pO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVDbGlwKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBpZiAoZ3JhcGhpY3MpIHtcclxuICAgICAgICBncmFwaGljcy5lbmFibGVkID0gdHJ1ZTtcclxuICAgICAgICBncmFwaGljcy5jbGVhcigpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbWFzayA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLk1hc2spID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLk1hc2spO1xyXG4gICAgbWFzay50eXBlID0gc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJ1xyXG4gICAgICAgID8gY2MuTWFzay5UeXBlLkdSQVBISUNTX0VMTElQU0UgPz8gY2MuTWFzay5UeXBlLkVMTElQU0VcclxuICAgICAgICA6IGNjLk1hc2suVHlwZS5HUkFQSElDU19SRUNUID8/IGNjLk1hc2suVHlwZS5SRUNUO1xyXG4gICAgbWFzay5pbnZlcnRlZCA9IGZhbHNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBzcGVjLmNsaXBzQ29udGVudFxyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGggPiAwXHJcbiAgICAgICAgJiYgc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhc0J1dHRvbkFuY2VzdG9yKG5vZGU6IGFueSwgY2M6IGFueSk6IGJvb2xlYW4ge1xuICAgIGZvciAobGV0IHBhcmVudCA9IG5vZGUucGFyZW50OyBwYXJlbnQ7IHBhcmVudCA9IHBhcmVudC5wYXJlbnQpIHtcbiAgICAgICAgaWYgKHBhcmVudC5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nICYmICFoYXNCdXR0b25BbmNlc3Rvcihub2RlLCBjYykpIHtcbiAgICAgICAgY29uc3QgYnV0dG9uID0gbm9kZS5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5CdXR0b24pO1xyXG4gICAgICAgIGJ1dHRvbi50YXJnZXQgPSBub2RlO1xyXG4gICAgICAgIGJ1dHRvbi50cmFuc2l0aW9uID0gY2MuQnV0dG9uLlRyYW5zaXRpb24uU0NBTEU7XHJcbiAgICAgICAgYnV0dG9uLnpvb21TY2FsZSA9IDAuOTtcclxuICAgICAgICBidXR0b24uZHVyYXRpb24gPSAwLjE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0cmFuc2Zvcm06IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogYW55IHtcclxuICAgIGlmIChzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBOb2RlLCBVSVRyYW5zZm9ybSwgTWFzaywgU2Nyb2xsVmlldyB9ID0gY2M7XHJcbiAgICBsZXQgdmlldyA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKTtcclxuICAgIGxldCBjb250ZW50ID0gdmlldz8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKSA/PyBudWxsO1xyXG4gICAgaWYgKHZpZXcgJiYgZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodmlldywgZ3VhcmQpO1xyXG4gICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShjb250ZW50LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoU2Nyb2xsVmlldykgPz8gbm9kZS5hZGRDb21wb25lbnQoU2Nyb2xsVmlldyk7XHJcbiAgICBpZiAoIXZpZXcpIHtcclxuICAgICAgICB2aWV3ID0gbmV3IE5vZGUoJ3ZpZXcnKTtcclxuICAgICAgICB2aWV3LmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICBub2RlLmFkZENoaWxkKHZpZXcpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgdmlld1RyYW5zZm9ybSA9IHZpZXcuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyB2aWV3LmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICB2aWV3VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNldEltcG9ydGVkQ29udGVudFNpemUodmlld1RyYW5zZm9ybSwgdHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoLCB0cmFuc2Zvcm0uY29udGVudFNpemUuaGVpZ2h0KTtcbiAgICB2aWV3LnNldFBvc2l0aW9uKDAsIDAsIDApO1xyXG4gICAgY29uc3QgbWFzayA9IHZpZXcuZ2V0Q29tcG9uZW50KE1hc2spID8/IHZpZXcuYWRkQ29tcG9uZW50KE1hc2spO1xyXG4gICAgbWFzay50eXBlID0gTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gTWFzay5UeXBlLlJFQ1Q7XHJcbiAgICBpZiAoIWNvbnRlbnQpIHtcclxuICAgICAgICBjb250ZW50ID0gbmV3IE5vZGUoJ2NvbnRlbnQnKTtcclxuICAgICAgICBjb250ZW50LmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICB2aWV3LmFkZENoaWxkKGNvbnRlbnQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udGVudFRyYW5zZm9ybSA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyBjb250ZW50LmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwcmV2aW91c0xheW91dCA9IGNvbnRlbnQuZ2V0Q29tcG9uZW50KGNjLkxheW91dCk7XHJcbiAgICBjb25zdCBuZXh0TGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgaWYgKHByZXZpb3VzTGF5b3V0ICYmICghbmV4dExheW91dE1vZGUgfHwgbmV4dExheW91dE1vZGUgPT09ICdOT05FJykpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQocHJldmlvdXNMYXlvdXQsIGd1YXJkLCBjb250ZW50Lm5hbWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb250ZW50LnJlbW92ZUNvbXBvbmVudChwcmV2aW91c0xheW91dCk7XHJcbiAgICB9XHJcbiAgICBjb250ZW50VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoY29udGVudCwgY29udGVudFRyYW5zZm9ybSwgc3BlYywgdHJhbnNmb3JtLCBzY2FsZSk7XHJcbiAgICBjb25zdCBsZWdhY3kgPSBub2RlLmdldENoaWxkQnlOYW1lKCdfX0ZpZ21hQ29udGVudCcpO1xyXG4gICAgaWYgKGxlZ2FjeSAmJiBsZWdhY3kgIT09IGNvbnRlbnQpIHtcclxuICAgICAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGxlZ2FjeSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5sZWdhY3kuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgY29udGVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxlZ2FjeS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbGVnYWN5LmRlc3Ryb3koKTtcclxuICAgIH1cclxuICAgIC8vIENvY29zIENyZWF0b3IgMy44LjcgZXhwZWN0cyB0aGUgY29udGVudCBOb2RlIGhlcmUuIFNjcm9sbFZpZXcudmlldyBpcyBhXHJcbiAgICAvLyBnZXR0ZXIgZGVyaXZlZCBmcm9tIGNvbnRlbnQucGFyZW50IGFuZCBtdXN0IG5ldmVyIGJlIGFzc2lnbmVkIGRpcmVjdGx5LlxyXG4gICAgaWYgKHNjcm9sbC5jb250ZW50ID09PSBjb250ZW50KSB7XHJcbiAgICAgICAgc2Nyb2xsLmNvbnRlbnQgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgc2Nyb2xsLmNvbnRlbnQgPSBjb250ZW50O1xyXG4gICAgY29uc3QgYXhlcyA9IHNjcm9sbEF4ZXMoc3BlYyk7XHJcbiAgICBzY3JvbGwuaG9yaXpvbnRhbCA9IGF4ZXMuaG9yaXpvbnRhbDtcclxuICAgIHNjcm9sbC52ZXJ0aWNhbCA9IGF4ZXMudmVydGljYWw7XHJcbiAgICByZXR1cm4gY29udGVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2Nyb2xsQXhlcyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogeyBob3Jpem9udGFsOiBib29sZWFuOyB2ZXJ0aWNhbDogYm9vbGVhbiB9IHtcclxuICAgIGNvbnN0IGRpcmVjdGlvbiA9IHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gJiYgc3BlYy5vdmVyZmxvd0RpcmVjdGlvbiAhPT0gJ05PTkUnXHJcbiAgICAgICAgPyBzcGVjLm92ZXJmbG93RGlyZWN0aW9uLnRyaW0oKS50b1VwcGVyQ2FzZSgpXHJcbiAgICAgICAgOiAnVkVSVElDQUxfU0NST0xMSU5HJztcclxuICAgIGlmIChkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMJyB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX1NDUk9MTElORycpIHtcclxuICAgICAgICByZXR1cm4geyBob3Jpem9udGFsOiB0cnVlLCB2ZXJ0aWNhbDogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChkaXJlY3Rpb24gPT09ICdCT1RIJ1xyXG4gICAgICAgIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMJ1xyXG4gICAgICAgIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfQU5EX1ZFUlRJQ0FMX1NDUk9MTElORycpIHtcclxuICAgICAgICByZXR1cm4geyBob3Jpem9udGFsOiB0cnVlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogZmFsc2UsIHZlcnRpY2FsOiB0cnVlIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoXHJcbiAgICBjb250ZW50OiBhbnksXHJcbiAgICBjb250ZW50VHJhbnNmb3JtOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdmlld3BvcnQ6IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3Qgdmlld3BvcnRXaWR0aCA9IE1hdGgubWF4KDAsIE51bWJlcih2aWV3cG9ydC5jb250ZW50U2l6ZT8ud2lkdGgpIHx8IDApO1xyXG4gICAgY29uc3Qgdmlld3BvcnRIZWlnaHQgPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LmhlaWdodCkgfHwgMCk7XHJcbiAgICBjb25zdCBjaGlsZFJpZ2h0ID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS54IC0gc3BlYy5mcmFtZS54ICsgY2hpbGQuZnJhbWUud2lkdGgpICogc2NhbGUpO1xyXG4gICAgY29uc3QgY2hpbGRCb3R0b20gPSBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+XHJcbiAgICAgICAgKGNoaWxkLmZyYW1lLnkgLSBzcGVjLmZyYW1lLnkgKyBjaGlsZC5mcmFtZS5oZWlnaHQpICogc2NhbGUpO1xyXG4gICAgY29uc3QgYXhlcyA9IHNjcm9sbEF4ZXMoc3BlYyk7XHJcbiAgICBjb25zdCBjb250ZW50V2lkdGggPSBheGVzLmhvcml6b250YWxcclxuICAgICAgICA/IE1hdGgubWF4KHZpZXdwb3J0V2lkdGgsIDAsIC4uLmNoaWxkUmlnaHQpXHJcbiAgICAgICAgOiB2aWV3cG9ydFdpZHRoO1xyXG4gICAgY29uc3QgY29udGVudEhlaWdodCA9IGF4ZXMudmVydGljYWxcclxuICAgICAgICA/IE1hdGgubWF4KHZpZXdwb3J0SGVpZ2h0LCAwLCAuLi5jaGlsZEJvdHRvbSlcclxuICAgICAgICA6IHZpZXdwb3J0SGVpZ2h0O1xyXG4gICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShjb250ZW50VHJhbnNmb3JtLCBjb250ZW50V2lkdGgsIGNvbnRlbnRIZWlnaHQpO1xuICAgIC8vIEJvdGggaGVscGVycyB1c2UgQ29jb3MnIGRlZmF1bHQgY2VudGVyIGFuY2hvci4gTW92ZSBhbiBvdmVyc2l6ZWQgY29udGVudFxyXG4gICAgLy8gbm9kZSBzbyBpdHMgdG9wLWxlZnQgc3RpbGwgY29pbmNpZGVzIHdpdGggdGhlIHZpZXdwb3J0J3MgdG9wLWxlZnQuXHJcbiAgICBjb250ZW50LnNldFBvc2l0aW9uKFxyXG4gICAgICAgIChjb250ZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoIC0gdmlld3BvcnRXaWR0aCkgLyAyLFxuICAgICAgICAodmlld3BvcnRIZWlnaHQgLSBjb250ZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodCkgLyAyLFxuICAgICAgICAwLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluYWxpemVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgdmlld3BvcnQ6IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3JyB8fCBjb250ZW50ID09PSBub2RlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gY29udGVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgaWYgKCF0cmFuc2Zvcm0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIHRyYW5zZm9ybSwgc3BlYywgdmlld3BvcnQsIHNjYWxlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY291bnRTcGVjcyhzcGVjczogU2NlbmVOb2RlU3BlY1tdKTogbnVtYmVyIHtcclxuICAgIHJldHVybiBzcGVjcy5yZWR1Y2UoKHRvdGFsLCBzcGVjKSA9PiB0b3RhbCArIDEgKyBjb3VudFNwZWNzKHNwZWMuY2hpbGRyZW4pLCAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2VudGVySW5DYW52YXMobm9kZTogYW55LCBjYW52YXM6IGFueSwgVUlUcmFuc2Zvcm06IGFueSwgVmVjMzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBub2RlVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgY2FudmFzVHJhbnNmb3JtID0gY2FudmFzPy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgaWYgKCFub2RlVHJhbnNmb3JtIHx8ICFjYW52YXNUcmFuc2Zvcm0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBjYW52YXNTaXplID0gY2FudmFzVHJhbnNmb3JtLmNvbnRlbnRTaXplID8/IHtcclxuICAgICAgICB3aWR0aDogY2FudmFzVHJhbnNmb3JtLndpZHRoLFxyXG4gICAgICAgIGhlaWdodDogY2FudmFzVHJhbnNmb3JtLmhlaWdodCxcclxuICAgIH07XHJcbiAgICBjb25zdCB3aWR0aCA9IE51bWJlcihjYW52YXNTaXplPy53aWR0aCkgPiAwID8gTnVtYmVyKGNhbnZhc1NpemUud2lkdGgpIDogNjQwO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gTnVtYmVyKGNhbnZhc1NpemU/LmhlaWdodCkgPiAwID8gTnVtYmVyKGNhbnZhc1NpemUuaGVpZ2h0KSA6IDExMzY7XHJcbiAgICBjb25zdCBjYW52YXNBbmNob3IgPSBjYW52YXNUcmFuc2Zvcm0uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3Qgbm9kZUFuY2hvciA9IG5vZGVUcmFuc2Zvcm0uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3QgeCA9IHdpZHRoICogKDAuNSAtIGNhbnZhc0FuY2hvci54KVxyXG4gICAgICAgIC0gbm9kZVRyYW5zZm9ybS53aWR0aCAqICgwLjUgLSBub2RlQW5jaG9yLngpO1xyXG4gICAgY29uc3QgeSA9IGhlaWdodCAqICgwLjUgLSBjYW52YXNBbmNob3IueSlcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0uaGVpZ2h0ICogKDAuNSAtIG5vZGVBbmNob3IueSk7XHJcbiAgICBub2RlLnNldFBvc2l0aW9uKG5ldyBWZWMzKHgsIHksIG5vZGUucG9zaXRpb24/LnogPz8gMCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlQ29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/LmNvbXBvbmVudHMgPz8gbm9kZT8uX2NvbXBvbmVudHM7XHJcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheSh2YWx1ZSkgPyB2YWx1ZSA6IFtdO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW9yZGVyRmlnbWFDaGlsZHJlbihwYXJlbnQ6IGFueSwgb3JkZXJlZE5vZGVzOiBhbnlbXSk6IHZvaWQge1xyXG4gICAgY29uc3QgZGVzaXJlZCA9IFsuLi5uZXcgU2V0KG9yZGVyZWROb2Rlcy5maWx0ZXIoQm9vbGVhbikpXTtcclxuICAgIGlmICghZGVzaXJlZC5sZW5ndGggfHwgdHlwZW9mIGRlc2lyZWRbMF0/LnNldFNpYmxpbmdJbmRleCAhPT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIEZpZ21hLW93bmVkIGNoaWxkcmVuIGFyZSBrZXB0IGluIEZpZ21hIG9yZGVyLiBVc2VyLWF1dGhvcmVkIGNoaWxkcmVuIGFyZVxyXG4gICAgLy8gbmV2ZXIgcmVvcmRlcmVkIGFnYWluc3Qgb25lIGFub3RoZXI7IHRoZXkgZm9sbG93IHRoZSBtYW5hZ2VkIGJsb2NrLlxyXG4gICAgZGVzaXJlZC5mb3JFYWNoKChub2RlLCBpbmRleCkgPT4gbm9kZS5zZXRTaWJsaW5nSW5kZXgoaW5kZXgpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIHByZXZpb3VzTm9kZUZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICByZXRhaW5lZE5vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBpbmRleCA9IHByZWZhYkZpbGVJZEluZGV4KHByZWZhYlJvb3QpO1xyXG4gICAgY29uc3Qgc3RhbGUgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgZm9yIChjb25zdCBmaWxlSWQgb2YgcHJldmlvdXNOb2RlRmlsZUlkcykge1xyXG4gICAgICAgIGlmIChmaWxlSWQgPT09IG5vZGVQcmVmYWJGaWxlSWQocHJlZmFiUm9vdCkgfHwgcmV0YWluZWROb2RlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGluZGV4LmdldChmaWxlSWQpO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHN0YWxlLnNldChmaWxlSWQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlSWRzID0gbmV3IFNldChzdGFsZS5rZXlzKCkpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlLnZhbHVlcygpKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICBg5b6F5Yig6Zmk55qEIEZpZ21hIOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneWQq+acieaJi+W3pee7hOS7tu+8jOW3suWBnOatouWQjOatpeS7pemYsuatouaVsOaNruS4ouWkseOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzID0gKGNvbnRhaW5lcjogYW55LCBzdXJ2aXZvclBhcmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoY2hpbGQpO1xyXG4gICAgICAgICAgICBpZiAoY2hpbGRGaWxlSWRcclxuICAgICAgICAgICAgICAgICYmIChwcmV2aW91c05vZGVGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkgfHwgcHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3QgW2ZpbGVJZCwgbm9kZV0gb2Ygc3RhbGUpIHtcclxuICAgICAgICBsZXQgYW5jZXN0b3IgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBsZXQgbmVzdGVkVW5kZXJTdGFsZSA9IGZhbHNlO1xyXG4gICAgICAgIHdoaWxlIChhbmNlc3RvciAmJiBhbmNlc3RvciAhPT0gcHJlZmFiUm9vdC5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgYW5jZXN0b3JGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGFuY2VzdG9yKTtcclxuICAgICAgICAgICAgaWYgKGFuY2VzdG9yRmlsZUlkICYmIHN0YWxlSWRzLmhhcyhhbmNlc3RvckZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIG5lc3RlZFVuZGVyU3RhbGUgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYW5jZXN0b3IgPSBhbmNlc3Rvci5wYXJlbnQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChuZXN0ZWRVbmRlclN0YWxlIHx8ICFub2RlLnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3Vydml2b3JQYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMobm9kZSwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgc3RhbGUuZGVsZXRlKGZpbGVJZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHByZXZpb3VzOiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PixcclxuICAgIGdlbmVyYXRlZENsYXNzZXM6IGFueVtdLFxyXG4gICAgY2M6IGFueSxcclxuKTogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB7XHJcbiAgICBjb25zdCBwcmV2aW91c0NvbXBvbmVudHMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzKTtcclxuICAgIGNvbnN0IHByZXZpb3VzSGVscGVycyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZEhlbHBlckZpbGVJZHMpO1xyXG4gICAgY29uc3Qgbm9kZUZpbGVJZHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGNvbnN0IG1hbmFnZWROb2RlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYXBwZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhub2RlTWFwKSk7XHJcbiAgICBjb25zdCBtYW5hZ2VkUnVudGltZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5ZCM5q2l57uT5p6c57y65bCRIEZpZ21hIOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG5vZGVGaWxlSWRzW2ZpZ21hSWRdID0gZmlsZUlkO1xyXG4gICAgICAgIG1hbmFnZWROb2Rlcy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkUnVudGltZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRUeXBlcyA9IG5ldyBTZXQoW2NjLlVJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgbWFuYWdlZFJ1bnRpbWVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGlmICghbWFuYWdlZENvbXBvbmVudFR5cGVzLmhhcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWV4aXN0aW5nRmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudHMuaGFzKGV4aXN0aW5nRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgaWYgKG1hcHBlZFV1aWRzLmhhcyhub2RlLnV1aWQpIHx8IG5vZGUgPT09IHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBpZiAoIXBhcmVudFxyXG4gICAgICAgICAgICB8fCAoIW1hcHBlZFV1aWRzLmhhcyhwYXJlbnQudXVpZCkgJiYgIW1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMuaGFzKHBhcmVudC51dWlkKSlcclxuICAgICAgICAgICAgfHwgIWlzR2VuZXJhdGVkSGVscGVyTm9kZShub2RlLCBwYXJlbnQsIGNjKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAocHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNIZWxwZXJzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgIGDoioLngrnigJwke3BhcmVudC5uYW1lfeKAneS4i+WtmOWcqOS4juWvvOWFpei+heWKqeiKgueCueWQjOWQjeeahOaJi+W3peiKgueCueKAnCR7bm9kZS5uYW1lfeKAne+8jOW3suWBnOatouWQjOatpeOAgmAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVycy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudHMuYWRkKGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50LCBjYykpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgbm9kZUZpbGVJZHMsXHJcbiAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBbLi4ubWFuYWdlZE5vZGVzXSxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogWy4uLm1hbmFnZWRDb21wb25lbnRzXSxcclxuICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogWy4uLm1hbmFnZWRIZWxwZXJzXSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlZnJlc2hQcmVmYWJMYXlvdXRzKFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aXNpdCA9IChzcGVjOiBTY2VuZU5vZGVTcGVjKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbc3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBub2RlID0gdXVpZCA/IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgPyBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk/LmdldENoaWxkQnlOYW1lKCdjb250ZW50JykgPz8gbm9kZVxyXG4gICAgICAgICAgICA6IG5vZGU7XHJcbiAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgID8gY2hpbGRQYXJlbnQuZ2V0Q29tcG9uZW50KGNjLkxheW91dClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgaWYgKGxheW91dCkge1xyXG4gICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHNjYWxlLCBjYyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZFBhcmVudCAhPT0gbm9kZSkge1xyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChcclxuICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSksXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzcGVjLmNoaWxkcmVuLmZvckVhY2godmlzaXQpO1xyXG4gICAgfTtcclxuICAgIHNwZWNzLmZvckVhY2godmlzaXQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgIHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCxcclxuICAgIHZhbHVlOiBudW1iZXIsXHJcbiAgICBtZXNzYWdlOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBheWxvYWQucGFja2FnZU5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgIHZhbHVlLFxyXG4gICAgICAgICAgICBtZXNzYWdlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8g6L+b5bqm5Y+N6aaI5LiN5Y+v55So5pe25LiN5bqU5Lit5pat5Zy65pmv5a+85YWl44CCXHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7fVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHMgPSB7XHJcbiAgICBpbnNwZWN0UHJlZmFiQ29udGV4dChwYXlsb2FkOiB7XHJcbiAgICAgICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgICAgIHJvb3RGaWxlSWQ/OiBzdHJpbmc7XHJcbiAgICB9KTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiRWRpdGluZ1N0YXRlKHBheWxvYWQucHJlZmFiVXVpZCwgcGF5bG9hZC5yb290RmlsZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgaW1wb3J0RG9jdW1lbnQocGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkKTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgICAgIGNvbnN0IGNjID0gcmVxdWlyZSgnY2MnKSBhcyBhbnk7XHJcbiAgICAgICAgY29uc3Qge1xyXG4gICAgICAgICAgICBkaXJlY3RvcixcclxuICAgICAgICAgICAgTm9kZSxcclxuICAgICAgICAgICAgVUlUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgIENhbnZhcyxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgICAgIENhbWVyYSxcclxuICAgICAgICB9ID0gY2M7XHJcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgICAgIGlmICghc2NlbmUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma/jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZmFiQ29udGV4dCA9IHBheWxvYWQucHJlZmFiQ29udGV4dDtcclxuICAgICAgICBsZXQgcHJlZmFiUm9vdDogYW55IHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBwcmVmYWJFZGl0aW5nU3RhdGUocHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkLCBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpO1xyXG4gICAgICAgICAgICBpZiAoIXN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg5bCa5pyq5a6J5YWo5omT5byA77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcHJlZmFiUm9vdCA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlLlNjZW5lLnJvb3ROb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBmaWxlSWRJbmRleCA9IHByZWZhYkZpbGVJZEluZGV4KHByZWZhYlJvb3QsIHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAgICAgICAgICAgICAgX19yb290X186IHByZWZhYlJvb3QudXVpZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbZmlnbWFJZCwgZmlsZUlkXSBvZiBPYmplY3QuZW50cmllcyhwcmVmYWJDb250ZXh0LmV4aXN0aW5nTm9kZUZpbGVJZHMpKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmlsZUlkSW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBheWxvYWQudXBkYXRlRXhpc3RpbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmV4aXN0aW5nTWFwID0gZXhpc3RpbmdNYXA7XHJcbiAgICAgICAgICAgIHBheWxvYWQuY2VudGVySW5DYW52YXMgPSBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgICAgICBpZiAocHJlZmFiUm9vdCkge1xyXG4gICAgICAgICAgICB3YWxrTm9kZXMocHJlZmFiUm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICAgICAgbm9kZUNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLmFkZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByb290cyA9IHBheWxvYWQucm9vdHMubWFwKChyb290KSA9PiBub3JtYWxpemVTY2VuZVNwZWMocm9vdCkpO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0ICYmIHJvb3RzLmxlbmd0aCAhPT0gMSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXlj6rlhYHorrjkuIDkuKogRmlnbWEgRnJhbWUg5qC56IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrUGFyZW50ID0gcHJlZmFiUm9vdD8ucGFyZW50ID8/IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcykgPz8gc2NlbmU7XHJcbiAgICAgICAgY29uc3QgZGlyZWN0Um9vdCA9IHJvb3RzLmxlbmd0aCA9PT0gMTtcclxuICAgICAgICBjb25zdCBjYW52YXMgPSBwcmVmYWJSb290ID8gbnVsbCA6IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcyk7XHJcbiAgICAgICAgY29uc3QgZ2VuZXJhdGVkQ2xhc3NlcyA9IFtcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgXTtcclxuICAgICAgICBjb25zdCBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICAgICAgbGV0IGNyZWF0ZWQgPSAwO1xyXG4gICAgICAgIGxldCB1cGRhdGVkID0gMDtcclxuICAgICAgICBjb25zdCB0b3RhbE5vZGVzID0gTWF0aC5tYXgoMSwgY291bnRTcGVjcyhyb290cykpO1xyXG4gICAgICAgIGxldCBjb21wbGV0ZWROb2RlcyA9IDA7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRIZWxwZXJGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmVmYWJPd25lcnNoaXBHdWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQgfCB1bmRlZmluZWQgPSBwcmVmYWJDb250ZXh0XHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcblxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFV1aWQgPSBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nXHJcbiAgICAgICAgICAgID8gcGF5bG9hZC5leGlzdGluZ01hcC5fX3Jvb3RfX1xyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBsZXQgZXhpc3RpbmdSb290Tm9kZSA9IGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBleGlzdGluZ1Jvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nUm9vdE5vZGU/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGV4aXN0aW5nUm9vdE5vZGUgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBJbiBhIGRpcmVjdC1yb290IGltcG9ydCwgX19yb290X18gYWxpYXNlcyB0aGUgRmlnbWEgcm9vdCBVVUlELiBJbiBhXHJcbiAgICAgICAgLy8gbXVsdGktcm9vdCBpbXBvcnQgaXQgaWRlbnRpZmllcyBhIHN5bnRoZXRpYyB3cmFwcGVyIGFuZCBtdXN0IG5ldmVyIGJlXHJcbiAgICAgICAgLy8gcmV1c2VkIGFzIG9uZSBvZiBpdHMgb3duIGNoaWxkcmVuIHdoZW4gdGhlIHJvb3QgY291bnQgY2hhbmdlcy5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPSBCb29sZWFuKGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgJiYgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcCkuc29tZSgoW2ZpZ21hSWQsIHV1aWRdKSA9PlxyXG4gICAgICAgICAgICAgICAgZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiB1dWlkID09PSBleGlzdGluZ1Jvb3RVdWlkKSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNEaXJlY3RSb290ID0gZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNXcmFwcGVyID0gIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IG1hcHBlZFJvb3RVdWlkID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IGV4aXN0aW5nVXVpZEZvclNwZWMocGF5bG9hZC5leGlzdGluZ01hcCwgcm9vdHNbMF0pXHJcbiAgICAgICAgICAgIDogKCFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3RVdWlkIDogdW5kZWZpbmVkKTtcclxuICAgICAgICBsZXQgaW1wb3J0Um9vdCA9IHByZWZhYlJvb3QgPz8gKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgbWFwcGVkUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBtYXBwZWRSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsKTtcclxuICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgaW1wb3J0Um9vdD8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGxlZ2FjeVdyYXBwZXIgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gcHJldmlvdXNXcmFwcGVyID8/IChpbXBvcnRSb290Py5wYXJlbnQ/Lm5hbWUuc3RhcnRzV2l0aCgnRmlnbWEgwrcgJylcclxuICAgICAgICAgICAgICAgID8gaW1wb3J0Um9vdC5wYXJlbnRcclxuICAgICAgICAgICAgICAgIDogbnVsbClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHJldXNlZEltcG9ydFJvb3QgPSBCb29sZWFuKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZhbGxiYWNrUGFyZW50O1xyXG4gICAgICAgIGlmICghZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YCk7XHJcbiAgICAgICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnBhcmVudCA9IHBhcmVudDtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QubmFtZSA9IGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gO1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm0gPSBpbXBvcnRSb290LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gaW1wb3J0Um9vdC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICAgICAgc2V0SW1wb3J0ZWRDb250ZW50U2l6ZShcbiAgICAgICAgICAgICAgICByb290VHJhbnNmb3JtLFxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLndpZHRoICogcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLmhlaWdodCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3Quc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghaW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoY2xlYW5OYW1lKHJvb3RzWzBdLm5hbWUpKTtcclxuICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQSBjb2xsYXBzZWQgU2NlbmVTcGVjIGNhbiBpbnRlbnRpb25hbGx5IG1hcCBzZXZlcmFsIEZpZ21hIElEcyB0byBhXHJcbiAgICAgICAgLy8gc2luZ2xlIENvY29zIG5vZGUuIElmIGEgbGF0ZXIgaW1wb3J0IGV4cGFuZHMgdGhhdCBzdWJ0cmVlIGFnYWluLFxyXG4gICAgICAgIC8vIHRob3NlIElEcyBzdGlsbCBwb2ludCBhdCB0aGUgc2FtZSBvbGQgVVVJRC4gQ2xhaW0gZWFjaCByZXVzYWJsZSBub2RlXHJcbiAgICAgICAgLy8gb25jZSBwZXIgYnVpbGQgc28gYSBjaGlsZCBjYW4gbmV2ZXIgcmV1c2UgKGFuZCByZXBhcmVudCkgaXRzIHBhcmVudC5cclxuICAgICAgICBjb25zdCBjbGFpbWVkTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgYnVpbGQgPSBhc3luYyAoXHJcbiAgICAgICAgICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICAgICAgICAgIG5vZGVQYXJlbnQ6IGFueSxcclxuICAgICAgICAgICAgcHJvdmlkZWROb2RlPzogYW55LFxyXG4gICAgICAgICk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgICAgICBsZXQgbm9kZSA9IHByb3ZpZGVkTm9kZSA/PyBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUgJiYgcGF5bG9hZC51cGRhdGVFeGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZFV1aWQgPSBwYXlsb2FkLmV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZE5vZGUgPSBtYXBwZWRVdWlkID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkVXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXBwZWROb2RlICYmICFjbGFpbWVkTm9kZVV1aWRzLmhhcyhtYXBwZWROb2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUgPSBtYXBwZWROb2RlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgY2xhaW1lZE5vZGVVdWlkcy5oYXMobm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RlZCA9IEJvb2xlYW4obm9kZSk7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG5ldyBOb2RlKGNsZWFuTmFtZShzcGVjLm5hbWUpKTtcclxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocHJlZmFiT3duZXJzaGlwR3VhcmQgJiYgZXhpc3RlZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdUcmFuc2Zvcm0pIHtcclxuICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGhlbHBlciBvZiBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT5cclxuICAgICAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYylcclxuICAgICAgICAgICAgICAgICAgICAgICAgfHwgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGNoaWxkLm5hbWUgPT09ICd2aWV3JykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGhlbHBlci5uYW1lID09PSAndmlldycpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBoZWxwZXIuZ2V0Q2hpbGRCeU5hbWU/LignY29udGVudCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUoY29udGVudCwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChoZWxwZXIubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUodGlsZWRTcHJpdGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZ2VuZXJhdGVkQ2xhc3Nlcy5pbmNsdWRlcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjbGFpbWVkTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICBpZiAoIShwcmVmYWJDb250ZXh0ICYmIG5vZGUgPT09IHByZWZhYlJvb3QpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlLnBhcmVudCA9IG5vZGVQYXJlbnQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm9kZS5uYW1lID0gY2xlYW5OYW1lKHNwZWMubmFtZSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG5cclxuICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uICE9PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlT2Jzb2xldGVTY3JvbGxIZWxwZXJzKG5vZGUsIHNwZWMsIGNjLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZW1vdmVPYnNvbGV0ZUxhYmVsT3V0bGluZShub2RlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwcmVzZXJ2ZWQgPSBkZXNpcmVkR2VuZXJhdGVkQ29tcG9uZW50cyhzcGVjLCBjYywgbm9kZSk7XG4gICAgICAgICAgICAgICAgLy8gTWFzayBvd25zIGFuZCBkaXNhYmxlcyBpdHMgc2hhcmVkIEdyYXBoaWNzIGR1cmluZyB0aGVcclxuICAgICAgICAgICAgICAgIC8vIGRlZmVycmVkIG9uRGlzYWJsZSBwaGFzZS4gSWYgY2xpcHBpbmcgd2FzIHJlbW92ZWQgYnV0IGFcclxuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBHcmFwaGljcyByZW5kZXJlciBpcyBzdGlsbCBkZXNpcmVkLCByZWNyZWF0ZSB0aGF0XHJcbiAgICAgICAgICAgICAgICAvLyByZW5kZXJlciBvbmx5IGFmdGVyIHRoZSBvbGQgTWFzayBsaWZlY3ljbGUgaGFzIGNvbXBsZXRlZC5cclxuICAgICAgICAgICAgICAgIGlmICghcHJlc2VydmVkLmhhcyhNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIG5vZGUuZ2V0Q29tcG9uZW50KE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgcHJlc2VydmVkLmhhcyhHcmFwaGljcykpIHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQuZGVsZXRlKEdyYXBoaWNzKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgZ2VuZXJhdGVkQ2xhc3NlcyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVzZXJ2ZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgW0dyYXBoaWNzLCBTcHJpdGUsIExhYmVsLCBSaWNoVGV4dF0sXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZmFiQ29udGV4dCA/IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJlbW92ZWRSZW5kZXJDb21wb25lbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRCYWNrZ3JvdW5kKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlSGVscGVyID0gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3ZlcmZsb3dTcHJpdGVIZWxwZXIgPSB1c2VzT3ZlcmZsb3dTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIW92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkT3ZlcmZsb3dWaXN1YWwobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2xpcHNDaGlsZHJlbiA9IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInIHx8IHNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBORyDmlbTlsYLoioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIzotYTmupDlj6/og73mnKrmiJDlip/lr7zlhaXjgIJgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG92ZXJmbG93U3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZU92ZXJmbG93U3ByaXRlSGVscGVyKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAncmljaFRleHQnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlUmljaFRleHQobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChzcGVjLmZvbnRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNjLlRURkZvbnQgJiYgIShmb250IGluc3RhbmNlb2YgY2MuVFRGRm9udCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgUmljaFRleHQg6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5Y+q6IO95L2/55SoIFRURi9PVEYg5a2X5L2T77yM5b2T5YmN5pig5bCE5Y+v6IO95pivIEJpdG1hcEZvbnTvvIguZm5077yJ44CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IGZvbnQ7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmljaFRleHQuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5maWdtYVR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxhYmVsKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWwuZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKS5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKFJBU1RFUl9WRUNUT1JfVFlQRVMuaGFzKHNwZWMuZmlnbWFUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55+i6YeP6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yMUE5HIOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlQ2xpcChub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICAgICA/IG5vZGVcclxuICAgICAgICAgICAgICAgIDogY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlTGF5b3V0KGNoaWxkUGFyZW50LCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChjaGlsZCwgY2hpbGRQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW9yZGVyRmlnbWFDaGlsZHJlbihcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGQuZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB1dWlkID8gZmluZEJ5VXVpZChjaGlsZFBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChMYXlvdXQpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKG5vZGUsIHNwZWMsIGNoaWxkUGFyZW50LCB0cmFuc2Zvcm0sIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGVkICYmIHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lICs9ICcgwrcgVHJhbnNmb3JtJztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZWROb2RlcyArPSAxO1xyXG4gICAgICAgICAgICBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgICAgICAgICAgICAgIHBheWxvYWQsXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZWROb2RlcyAvIHRvdGFsTm9kZXMsXHJcbiAgICAgICAgICAgICAgICBg5p6E5bu66IqC54K5ICR7Y29tcGxldGVkTm9kZXN9LyR7dG90YWxOb2Rlc30gwrcgJHtzcGVjLm5hbWV9YCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKHJvb3QsIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LCBkaXJlY3RSb290ID8gaW1wb3J0Um9vdCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCxcclxuICAgICAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNlbnRlckluQ2FudmFzICYmIGNhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNlbnRlckluQ2FudmFzKGltcG9ydFJvb3QsIGNhbnZhcywgVUlUcmFuc2Zvcm0sIGNjLlZlYzMpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFsZVRyYW5zaXRpb25VdWlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKVxyXG4gICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKFtmaWdtYUlkLCB1dWlkXSkgPT4gZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiAhcmV0YWluZWRVdWlkcy5oYXModXVpZCkpXHJcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgoWywgdXVpZF0pID0+IHV1aWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgbGVnYWN5V3JhcHBlciAmJiBsZWdhY3lXcmFwcGVyICE9PSBpbXBvcnRSb290ICYmIGxlZ2FjeVdyYXBwZXIucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShsZWdhY3lXcmFwcGVyLCBwYXJlbnQsIHN0YWxlVHJhbnNpdGlvblV1aWRzLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIHByZXZpb3VzRGlyZWN0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290ICE9PSBpbXBvcnRSb290XHJcbiAgICAgICAgICAgICAgICAmJiAhcmV0YWluZWRVdWlkcy5oYXMocHJldmlvdXNEaXJlY3RSb290LnV1aWQpXHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91c0RpcmVjdFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgc3RhbGVUcmFuc2l0aW9uVXVpZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhpbXBvcnRSb290LCBwYXlsb2FkLmV4aXN0aW5nTWFwLCBub2RlTWFwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICghcmV1c2VkSW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldChPYmplY3QudmFsdWVzKHBheWxvYWQuZXhpc3RpbmdNYXApKSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgcHJlZmFiU3luYzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZE5vZGVGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWumuS9jeWvvOWFpeWQjueahOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMuYWRkKGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIGltcG9ydFJvb3QsIGNjKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBuZXcgU2V0KHByZWZhYkNvbnRleHQubWFuYWdlZE5vZGVGaWxlSWRzKSxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcmV0YWluZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgcmVmcmVzaFByZWZhYkxheW91dHMocm9vdHMsIGltcG9ydFJvb3QsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgcHJlZmFiU3luYyA9IGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0LFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBbVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChub2RlUHJlZmFiRmlsZUlkKGltcG9ydFJvb3QpICE9PSBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5Zyo5ZCM5q2l6L+H56iL5Lit5Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgcm9vdFV1aWQ6IGltcG9ydFJvb3QudXVpZCxcclxuICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgY3JlYXRlZCxcclxuICAgICAgICAgICAgdXBkYXRlZCxcclxuICAgICAgICAgICAgdGVtcG9yYXJ5Um9vdDogIXByZWZhYkNvbnRleHQgJiYgZGlyZWN0Um9vdCAmJiAhcmV1c2VkSW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgcHJlZmFiU3luYyxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxuXHJcbiAgICByZW1vdmVJbXBvcnRlZE5vZGUocGF5bG9hZDogeyByb290VXVpZDogc3RyaW5nIH0pOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBjb25zdCBub2RlID0gc2NlbmUgPyBmaW5kQnlVdWlkKHNjZW5lLCBwYXlsb2FkLnJvb3RVdWlkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gU3RvcCByZW5kZXJpbmcgaW1tZWRpYXRlbHkuIENvY29zIGRlc3Ryb3lzIG5vZGVzIGF0IHRoZSBlbmQgb2YgdGhlXHJcbiAgICAgICAgLy8gZnJhbWUsIHNvIHJlbW92aW5nIHRoZSBwYXJlbnQgYWxvbmUgY2FuIGxlYXZlIGEgb25lLWZyYW1lIGdob3N0LlxyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9LFxyXG59O1xyXG4iXX0=