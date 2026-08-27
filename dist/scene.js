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
        if (!usesTiledSpriteHelper(spec)) {
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
function configureLabel(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const { Label } = cc;
    const label = (_a = node.getComponent(Label)) !== null && _a !== void 0 ? _a : node.addComponent(Label);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    const characters = normalizeLabelText(spec.characters);
    const multiline = isMultilineLabel(characters);
    label.fontSize = Math.max(1, ((_c = style.fontSize) !== null && _c !== void 0 ? _c : 16) * scale);
    label.lineHeight = Math.max(1, ((_e = (_d = style.lineHeightPx) !== null && _d !== void 0 ? _d : style.fontSize) !== null && _e !== void 0 ? _e : 16) * scale);
    label.spacingX = ((_f = style.letterSpacing) !== null && _f !== void 0 ? _f : 0) * scale;
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
        label.color = toColor(cc.Color, fill.color, (_g = fill.opacity) !== null && _g !== void 0 ? _g : 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if ((stroke === null || stroke === void 0 ? void 0 : stroke.color) && spec.strokeWeight > 0) {
        label.enableOutline = true;
        label.outlineColor = toColor(cc.Color, stroke.color, (_h = stroke.opacity) !== null && _h !== void 0 ? _h : 1);
        label.outlineWidth = Math.max(1, spec.strokeWeight * scale);
    }
}
function configureRichText(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f, _g;
    const { RichText } = cc;
    const richText = (_a = node.getComponent(RichText)) !== null && _a !== void 0 ? _a : node.addComponent(RichText);
    const style = (_b = spec.textStyle) !== null && _b !== void 0 ? _b : {};
    richText.string = normalizeLabelText(spec.characters);
    richText.fontSize = Math.max(1, ((_c = style.fontSize) !== null && _c !== void 0 ? _c : 16) * scale);
    richText.lineHeight = Math.max(1, ((_e = (_d = style.lineHeightPx) !== null && _d !== void 0 ? _d : style.fontSize) !== null && _e !== void 0 ? _e : 16) * scale);
    richText.maxWidth = Math.max(0, spec.frame.width * scale);
    richText.handleTouchEvent = false;
    // RichText is primarily used for runtime-injected multi-line content. An
    // empty Figma placeholder must therefore keep the same top-left contract
    // after the game assigns its real string.
    richText.horizontalAlign = RichText.HorizontalAlign.LEFT;
    richText.verticalAlign = RichText.VerticalAlign.TOP;
    richText.fontFamily = (_f = style.fontFamily) !== null && _f !== void 0 ? _f : '';
    richText.useSystemFont = !spec.fontUuid;
    const fill = visiblePaint(spec.fills);
    if (fill === null || fill === void 0 ? void 0 : fill.color) {
        richText.fontColor = toColor(cc.Color, fill.color, (_g = fill.opacity) !== null && _g !== void 0 ? _g : 1);
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
    const finalHeight = figmaHeight < fontSize
        ? fontSize + outlineWidth * 2
        : figmaHeight;
    // Keep the imported Figma box unless a deterministic outline/font lower
    // bound requires expansion. Expand symmetrically around the center anchor
    // so the node's imported center position remains unchanged.
    // An undersized Figma text box must at least contain the final Cocos font
    // size, plus one outline width above and below when outline is enabled.
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
async function configureSprite(node, spec, scale, cc) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (!spec.sprite) {
        return;
    }
    const { Sprite, UITransform, assetManager } = cc;
    const sprite = (_a = node.getComponent(Sprite)) !== null && _a !== void 0 ? _a : node.addComponent(Sprite);
    const transform = node.getComponent(UITransform);
    const targetWidth = Math.max(0, spec.frame.width * scale);
    const targetHeight = Math.max(0, spec.frame.height * scale);
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
                if (!tiledSpriteHelper) {
                    removeGeneratedTiledNodes(node, prefabOwnershipGuard);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBK2tEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBamxEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFFL0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQXlCekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNoQyxRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0NBQ3BCLENBQUMsQ0FBQztBQUVILFNBQVMsU0FBUyxDQUFDLEtBQWE7O0lBQzVCLE9BQU8sTUFBQSxJQUFBLDRCQUFnQixFQUFDLEtBQUssQ0FBQyxtQ0FBSSxZQUFZLENBQUM7QUFDbkQsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLEtBQVUsRUFBRSxLQUE2QixFQUFFLE9BQU8sR0FBRyxDQUFDOztJQUNuRSxNQUFNLE1BQU0sR0FBRyxLQUFLLGFBQUwsS0FBSyxjQUFMLEtBQUssR0FBSSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUNuRCxPQUFPLElBQUksS0FBSyxDQUNaLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFD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Q3BCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNmLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7Q0FDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQge1xyXG4gICAgaXNUZXJtaW5hbEFjdGlvbixcclxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXHJcbiAgICBub3JtYWxpemVJbXBvcnRBY3Rpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEZpZ21hQ29sb3IsXHJcbiAgICBGaWdtYVBhaW50LFxyXG4gICAgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBSZWN0LFxyXG4gICAgU2NlbmVOb2RlU3BlYyxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuXHJcbm1vZHVsZS5wYXRocy5wdXNoKGpvaW4oRWRpdG9yLkFwcC5wYXRoLCAnbm9kZV9tb2R1bGVzJykpO1xyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG59XHJcblxyXG5jb25zdCBCQUNLR1JPVU5EX05PREVfTkFNRSA9ICdfX0ZpZ21hQmFja2dyb3VuZCc7XHJcbmNvbnN0IFRJTEVEX01BU0tfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZE1hc2snO1xyXG5jb25zdCBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FID0gJ19fRmlnbWFUaWxlZFNwcml0ZSc7XHJcbmNvbnN0IFJBU1RFUl9WRUNUT1JfVFlQRVMgPSBuZXcgU2V0KFtcclxuICAgICdWRUNUT1InLFxyXG4gICAgJ0JPT0xFQU5fT1BFUkFUSU9OJyxcclxuICAgICdTVEFSJyxcclxuICAgICdMSU5FJyxcclxuICAgICdSRUdVTEFSX1BPTFlHT04nLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIGNsZWFuTmFtZShpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzYW5pdGl6ZU5vZGVOYW1lKGlucHV0KSA/PyAnRmlnbWEgTm9kZSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRvQ29sb3IoQ29sb3I6IGFueSwgdmFsdWU6IEZpZ21hQ29sb3IgfCB1bmRlZmluZWQsIG9wYWNpdHkgPSAxKTogYW55IHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IHZhbHVlID8/IHsgcjogMCwgZzogMCwgYjogMCwgYTogMSB9O1xyXG4gICAgcmV0dXJuIG5ldyBDb2xvcihcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5yKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmcpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UuYikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIChzb3VyY2UuYSA/PyAxKSAqIG9wYWNpdHkpKSAqIDI1NSksXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kQnlVdWlkKHJvb3Q6IGFueSwgdXVpZDogc3RyaW5nKTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC51dWlkID09PSB1dWlkKSB7XHJcbiAgICAgICAgcmV0dXJuIHJvb3Q7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4pIHtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGZpbmRCeVV1aWQoY2hpbGQsIHV1aWQpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVQcmVmYWJGaWxlSWQobm9kZTogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gbm9kZT8uX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50OiBhbnkpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgdmFsdWUgPSBjb21wb25lbnQ/Ll9fcHJlZmFiPy5maWxlSWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhbGtOb2Rlcyhyb290OiBhbnksIHZpc2l0OiAobm9kZTogYW55KSA9PiB2b2lkKTogdm9pZCB7XHJcbiAgICB2aXNpdChyb290KTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIHdhbGtOb2RlcyhjaGlsZCwgdmlzaXQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJBc3NldFV1aWQobm9kZTogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGFzc2V0ID0gbm9kZT8uX3ByZWZhYj8uYXNzZXQ7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGFzc2V0Py5fdXVpZCA/PyBhc3NldD8udXVpZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRmlsZUlkSW5kZXgocm9vdDogYW55LCBleHBlY3RlZFByZWZhYlV1aWQ/OiBzdHJpbmcpOiBNYXA8c3RyaW5nLCBhbnk+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBjb25zdCBjb21wb25lbnRGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICB3YWxrTm9kZXMocm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBwcmVmYWJSb290ID0gbm9kZT8uX3ByZWZhYj8ucm9vdDtcclxuICAgICAgICBpZiAobm9kZSAhPT0gcm9vdCAmJiBwcmVmYWJSb290ICYmIHByZWZhYlJvb3QgIT09IHJvb3QpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBhc3NldFV1aWQgPSBwcmVmYWJBc3NldFV1aWQobm9kZSk7XHJcbiAgICAgICAgaWYgKGV4cGVjdGVkUHJlZmFiVXVpZCAmJiBhc3NldFV1aWQgJiYgYXNzZXRVdWlkICE9PSBleHBlY3RlZFByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgICAgIGlmICghZmlsZUlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHJlc3VsdC5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlhoXlrZjlnKjph43lpI3oioLngrkgZmlsZUlk77yaJHtmaWxlSWR9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdC5zZXQoZmlsZUlkLCBub2RlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlLmNvbXBvbmVudHMgPz8gbm9kZS5fY29tcG9uZW50cyA/PyBbXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKCFjb21wb25lbnRGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChjb21wb25lbnRGaWxlSWRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlhoXlrZjlnKjph43lpI3nu4Tku7YgZmlsZUlk77yaJHtjb21wb25lbnRGaWxlSWR9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29tcG9uZW50RmlsZUlkcy5hZGQoY29tcG9uZW50RmlsZUlkKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkVkaXRpbmdTdGF0ZShcclxuICAgIGV4cGVjdGVkVXVpZDogc3RyaW5nLFxyXG4gICAgZXhwZWN0ZWRSb290RmlsZUlkPzogc3RyaW5nLFxyXG4pOiBQcmVmYWJFZGl0aW5nU3RhdGUge1xyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjb25zdCBtb2RlID0gU3RyaW5nKGNjZUFwaT8uU2NlbmVGYWNhZGVNYW5hZ2VyPy5xdWVyeU1vZGU/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRVdWlkID0gU3RyaW5nKGNjZUFwaT8uU2NlbmVGYWNhZGVNYW5hZ2VyPy5xdWVyeUN1cnJlbnRTY2VuZVV1aWQ/LigpID8/ICcnKTtcclxuICAgIGNvbnN0IHJvb3QgPSBjY2VBcGk/LlNjZW5lPy5yb290Tm9kZSA/PyBudWxsO1xyXG4gICAgY29uc3Qgcm9vdEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQocm9vdCk7XHJcbiAgICBsZXQgcmVhc29uID0gJyc7XHJcbiAgICBpZiAobW9kZSAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICByZWFzb24gPSBg5b2T5YmN57yW6L6R5qih5byP5Li6ICR7bW9kZSB8fCAndW5rbm93bid977yM5bCa5pyq6L+b5YWlIFByZWZhYmA7XHJcbiAgICB9IGVsc2UgaWYgKGN1cnJlbnRVdWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICByZWFzb24gPSBg5b2T5YmN6LWE5rqQIFVVSUQg5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7RgO1xyXG4gICAgfSBlbHNlIGlmICghcm9vdCkge1xyXG4gICAgICAgIHJlYXNvbiA9ICdQcmVmYWIg5qC56IqC54K55bCa5pyq5bCx57uqJztcclxuICAgIH0gZWxzZSBpZiAoZXhwZWN0ZWRSb290RmlsZUlkICYmIHJvb3RGaWxlSWQgIT09IGV4cGVjdGVkUm9vdEZpbGVJZCkge1xyXG4gICAgICAgIHJlYXNvbiA9ICdQcmVmYWIg5qC56IqC54K5IGZpbGVJZCDkuI7mnaXmupDorrDlvZXkuI3kuIDoh7QnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICByZWFkeTogIXJlYXNvbixcclxuICAgICAgICBtb2RlLFxyXG4gICAgICAgIGN1cnJlbnRVdWlkLFxyXG4gICAgICAgIHJvb3RVdWlkOiByb290Py51dWlkLFxyXG4gICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgcmVhc29uOiByZWFzb24gfHwgdW5kZWZpbmVkLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGdlbmVyYXRlZCA9IChnbG9iYWxUaGlzIGFzIGFueSkuRWRpdG9yPy5VdGlscz8uVVVJRD8uZ2VuZXJhdGU/Lih0cnVlKTtcclxuICAgIGlmICh0eXBlb2YgZ2VuZXJhdGVkID09PSAnc3RyaW5nJyAmJiBnZW5lcmF0ZWQubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiBnZW5lcmF0ZWQ7XHJcbiAgICB9XHJcbiAgICAvLyBVbml0LXRlc3QvaGVhZGxlc3MgZmFsbGJhY2suIFRoZSByZWFsIENyZWF0b3Igc2NlbmUgcHJvY2VzcyBhbHdheXMgdXNlc1xyXG4gICAgLy8gRWRpdG9yLlV0aWxzLlVVSUQuZ2VuZXJhdGUodHJ1ZSksIHNvIHByb2R1Y3Rpb24gSURzIGZvbGxvdyBDcmVhdG9yJ3Mgb3duIGZvcm1hdC5cclxuICAgIHJldHVybiBgZmlnbWEke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTQpfWA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGU6IGFueSwgcHJlZmFiUm9vdDogYW55LCBjYzogYW55KTogc3RyaW5nIHtcclxuICAgIGxldCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZE5vZGU/Lihub2RlKTtcclxuICAgIGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uUHJlZmFiSW5mbyA/PyBjYy5QcmVmYWJJbmZvO1xyXG4gICAgaWYgKCFQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBQcmVmYWJJbmZvIEFQSSDkuI3lj6/nlKjvvIzml6Dms5XkuLrmlrDoioLngrnnlJ/miJDnqLPlrpogZmlsZUlk44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbmZvID0gbmV3IFByZWZhYkluZm8oKTtcclxuICAgIGluZm8ucm9vdCA9IHByZWZhYlJvb3Q7XHJcbiAgICBpbmZvLmFzc2V0ID0gcHJlZmFiUm9vdD8uX3ByZWZhYj8uYXNzZXQgPz8gbnVsbDtcclxuICAgIGluZm8uZmlsZUlkID0gZ2VuZXJhdGVQcmVmYWJGaWxlSWQoKTtcclxuICAgIGluZm8uaW5zdGFuY2UgPSBudWxsO1xyXG4gICAgaW5mby50YXJnZXRPdmVycmlkZXMgPSBudWxsO1xyXG4gICAgbm9kZS5fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQ6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoZmlsZUlkKSB7XHJcbiAgICAgICAgcmV0dXJuIGZpbGVJZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY2NlQXBpPy5QcmVmYWI/Lm9uQWRkQ29tcG9uZW50Py4oY29tcG9uZW50KTtcclxuICAgIGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBDb21wUHJlZmFiSW5mbyA9IGNjLlByZWZhYj8uX3V0aWxzPy5Db21wUHJlZmFiSW5mbyA/PyBjYy5Db21wUHJlZmFiSW5mbztcclxuICAgIGlmICghQ29tcFByZWZhYkluZm8pIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NvY29zIDMuOC43IENvbXBQcmVmYWJJbmZvIEFQSSDkuI3lj6/nlKjvvIzml6Dms5XkuLrmlrDnu4Tku7bnlJ/miJDnqLPlrpogZmlsZUlk44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbmZvID0gbmV3IENvbXBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBjb21wb25lbnQuX19wcmVmYWIgPSBpbmZvO1xyXG4gICAgcmV0dXJuIGluZm8uZmlsZUlkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRQYXJlbnRLZWVwaW5nV29ybGQobm9kZTogYW55LCBwYXJlbnQ6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHR5cGVvZiBub2RlLnNldFBhcmVudCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIG5vZGUuc2V0UGFyZW50KHBhcmVudCwgdHJ1ZSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIG5vZGUucGFyZW50ID0gcGFyZW50O1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQ6IGFueSwgcGFyZW50OiBhbnksIGNjOiBhbnkpOiBib29sZWFuIHtcclxuICAgIGlmIChjaGlsZC5uYW1lID09PSBCQUNLR1JPVU5EX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX01BU0tfTk9ERV9OQU1FXHJcbiAgICAgICAgfHwgY2hpbGQubmFtZSA9PT0gVElMRURfU1BSSVRFX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09ICdfX0ZpZ21hQ29udGVudCcpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGlmIChjaGlsZC5uYW1lID09PSAndmlldycgJiYgcGFyZW50LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2hpbGQubmFtZSA9PT0gJ2NvbnRlbnQnXHJcbiAgICAgICAgJiYgcGFyZW50Lm5hbWUgPT09ICd2aWV3J1xyXG4gICAgICAgICYmIHBhcmVudC5wYXJlbnQ/LmdldENvbXBvbmVudD8uKGNjLlNjcm9sbFZpZXcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHN1cnZpdm9yUGFyZW50OiBhbnksXHJcbiAgICBzdGFsZVV1aWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBsZXQgcmVtb3ZlZCA9IDE7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5ub2RlLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChzdGFsZVV1aWRzLmhhcyhjaGlsZC51dWlkKSB8fCBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKSkge1xyXG4gICAgICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKGNoaWxkLCBzdXJ2aXZvclBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc3Vydml2b3JQYXJlbnQpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgIG5vZGUucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplU2NlbmVTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBTY2VuZU5vZGVTcGVjIHtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzcGVjLmFjdGlvbiBhcyB1bmtub3duKTtcclxuICAgIGNvbnN0IGtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHNwZWMua2luZCwgYWN0aW9uKTtcclxuICAgIGNvbnN0IGNoaWxkcmVuID0gQXJyYXkuaXNBcnJheShzcGVjLmNoaWxkcmVuKSA/IHNwZWMuY2hpbGRyZW4gOiBbXTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uc3BlYyxcclxuICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBjaGlsZHJlbjogaXNUZXJtaW5hbEFjdGlvbihhY3Rpb24pIHx8IHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSB0cnVlXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBjaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBub3JtYWxpemVTY2VuZVNwZWMoY2hpbGQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpZ21hSWRzRm9yU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogc3RyaW5nW10ge1xyXG4gICAgY29uc3QgaWRzID0gW3NwZWMuZmlnbWFJZCwgLi4uKHNwZWMuYWxpYXNGaWdtYUlkcyA/PyBbXSldXHJcbiAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwICYmIGlkICE9PSAnX19yb290X18nKTtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChpZHMpXTtcclxufVxyXG5cclxuZnVuY3Rpb24gYWxpYXNGaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBmaWdtYUlkc0ZvclNwZWMoc3BlYykuZmlsdGVyKChmaWdtYUlkKSA9PiBmaWdtYUlkICE9PSBzcGVjLmZpZ21hSWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGlzdGluZ1V1aWRGb3JTcGVjKFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBleGlzdGluZ01hcFtmaWdtYUlkXTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIGlmICh0eXBlb2Ygc3BlYy5mbGF0dGVuQm91bmRhcnkgPT09ICdib29sZWFuJykge1xyXG4gICAgICAgIHJldHVybiBzcGVjLmZsYXR0ZW5Cb3VuZGFyeTtcclxuICAgIH1cclxuICAgIC8vIEJhY2t3YXJkIGNvbXBhdGliaWxpdHkgZm9yIFNjZW5lU3BlY3MgcGVyc2lzdGVkIGJ5IGltcG9ydGVyIHZlcnNpb25zXHJcbiAgICAvLyBiZWZvcmUgZmxhdHRlbkJvdW5kYXJ5IHdhcyBpbnRyb2R1Y2VkLiBOZXcgcGxhbnMgYWx3YXlzIHNldCB0aGUgZmxhZyBzb1xyXG4gICAgLy8gZm9sZGVkIExhYmVscyBhbmQgb3RoZXIgcHJvbW90ZWQgdmlzdWFscyB1c2UgdGhlIHNhbWUgY2xlYW51cCBzZW1hbnRpY3MuXHJcbiAgICByZXR1cm4gc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInXHJcbiAgICAgICAgfHwgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIEJvb2xlYW4oc3BlYy5zcHJpdGUpICYmIHNwZWMuY2hpbGRyZW4ubGVuZ3RoID09PSAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlQ29sbGFwc2VkTWFwcGVkRGVzY2VuZGFudHMoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgY2M6IGFueSxcclxuKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMoY3VycmVudE1hcCkpO1xyXG4gICAgY29uc3QgYm91bmRhcnlTcGVjczogQXJyYXk8e1xyXG4gICAgICAgIGZpZ21hSWQ6IHN0cmluZztcclxuICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGJvb2xlYW47XHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogU2V0PHN0cmluZz47XHJcbiAgICB9PiA9IFtdO1xyXG4gICAgY29uc3QgY29sbGVjdEJvdW5kYXJpZXMgPSAobm9kZXM6IFNjZW5lTm9kZVNwZWNbXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgc3BlYyBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAoZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgYm91bmRhcnlTcGVjcy5wdXNoKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWdtYUlkOiBzcGVjLmZpZ21hSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYWxpYXNGaWdtYUlkcyA9IGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWMpO1xyXG4gICAgICAgICAgICBpZiAoYWxpYXNGaWdtYUlkcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNGaWdtYUlkczogbmV3IFNldChhbGlhc0ZpZ21hSWRzKSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbGxlY3RCb3VuZGFyaWVzKHNwZWMuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjcyk7XHJcbiAgICBjb25zdCBib3VuZGFyaWVzID0gYm91bmRhcnlTcGVjc1xyXG4gICAgICAgIC5tYXAoKGJvdW5kYXJ5KSA9PiAoe1xyXG4gICAgICAgICAgICAuLi5ib3VuZGFyeSxcclxuICAgICAgICAgICAgbm9kZTogY3VycmVudE1hcFtib3VuZGFyeS5maWdtYUlkXVxyXG4gICAgICAgICAgICAgICAgPyBmaW5kQnlVdWlkKGltcG9ydFJvb3QsIGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF0pXHJcbiAgICAgICAgICAgICAgICA6IG51bGwsXHJcbiAgICAgICAgfSkpXHJcbiAgICAgICAgLmZpbHRlcigoYm91bmRhcnkpOiBib3VuZGFyeSBpcyB0eXBlb2YgYm91bmRhcnkgJiB7IG5vZGU6IGFueSB9ID0+IEJvb2xlYW4oYm91bmRhcnkubm9kZSkpO1xyXG4gICAgaWYgKCFib3VuZGFyaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVOb2RlcyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCByZXRhaW5lZFV1aWRzLmhhcyh1dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBib3VuZGFyeSBvZiBib3VuZGFyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmICghYm91bmRhcnkucmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzXHJcbiAgICAgICAgICAgICAgICAmJiAhYm91bmRhcnkuYWxpYXNGaWdtYUlkcy5oYXMoZmlnbWFJZCkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKGJvdW5kYXJ5Lm5vZGUsIHV1aWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSAmJiBub2RlICE9PSBib3VuZGFyeS5ub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGFsZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YWxlTm9kZXMuc2l6ZSkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVVdWlkcyA9IG5ldyBTZXQoc3RhbGVOb2Rlcy5rZXlzKCkpO1xyXG4gICAgbGV0IHJlbW92ZWQgPSAwO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlTm9kZXMudmFsdWVzKCkpIHtcclxuICAgICAgICBpZiAoIW5vZGUucGFyZW50IHx8IHN0YWxlVXVpZHMuaGFzKG5vZGUucGFyZW50LnV1aWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZW1vdmVkICs9IHJlbW92ZU1hcHBlZE5vZGVUcmVlKG5vZGUsIG5vZGUucGFyZW50LCBzdGFsZVV1aWRzLCBjYyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVtb3ZlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhcclxuICAgIGltcG9ydFJvb3Q6IGFueSxcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgY3VycmVudE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhleGlzdGluZ01hcCkpIHtcclxuICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJyB8fCBjdXJyZW50TWFwW2ZpZ21hSWRdKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmluZEJ5VXVpZChpbXBvcnRSb290LCB1dWlkKSkge1xyXG4gICAgICAgICAgICBjdXJyZW50TWFwW2ZpZ21hSWRdID0gdXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbHZhZ2VFeGlzdGluZ01hcHBlZE5vZGVzKFxyXG4gICAgY29udGFpbmVyOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgZXhpc3RpbmdVdWlkczogU2V0PHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgIGlmIChleGlzdGluZ1V1aWRzLmhhcyhjaGlsZC51dWlkKSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhjaGlsZCwgc3Vydml2b3JQYXJlbnQsIGV4aXN0aW5nVXVpZHMpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluZENhbnZhcyhyb290OiBhbnksIENhbnZhczogYW55KTogYW55IHwgbnVsbCB7XHJcbiAgICBpZiAocm9vdC5nZXRDb21wb25lbnQoQ2FudmFzKSkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQ2FudmFzKGNoaWxkLCBDYW52YXMpO1xyXG4gICAgICAgIGlmIChmb3VuZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBjbGFzc2VzOiBhbnlbXSxcclxuICAgIHByZXNlcnZlZDogU2V0PGFueT4sXHJcbiAgICByZW5kZXJDbGFzc2VzOiBhbnlbXSxcclxuICAgIHJlbW92YWJsZUZpbGVJZHM/OiBTZXQ8c3RyaW5nPixcclxuKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IGZhbHNlO1xyXG4gICAgZm9yIChjb25zdCB0eXBlIG9mIGNsYXNzZXMpIHtcclxuICAgICAgICBpZiAocHJlc2VydmVkLmhhcyh0eXBlKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcG9uZW50ID0gbm9kZS5nZXRDb21wb25lbnQodHlwZSk7XHJcbiAgICAgICAgaWYgKGNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICBpZiAocmVtb3ZhYmxlRmlsZUlkcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWZpbGVJZCB8fCAhcmVtb3ZhYmxlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGDoioLngrnigJwke25vZGUubmFtZX3igJ3kuIrnmoTmuLLmn5Pnu4Tku7bkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw5Lul5L+d5oqk5omL5bel5YaF5a6544CCYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJlbmRlckNsYXNzZXMuc29tZSgocmVuZGVyVHlwZSkgPT4gY29tcG9uZW50IGluc3RhbmNlb2YgcmVuZGVyVHlwZSkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KGNvbXBvbmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWRSZW5kZXJDb21wb25lbnQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGU6IGFueSwgY2M6IGFueSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgb3V0bGluZSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkxhYmVsT3V0bGluZSk7XHJcbiAgICBpZiAoIW91dGxpbmUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBMYWJlbE91dGxpbmUgd2FzIHVzZWQgYnkgb2xkZXIgaW1wb3J0ZXIgdmVyc2lvbnMuIENvY29zIGRlc3Ryb3lzXHJcbiAgICAvLyBjb21wb25lbnRzIGF0IHRoZSBlbmQgb2YgdGhlIGZyYW1lIGFuZCBpdHMgb25EaXNhYmxlKCkgd3JpdGVzIGJhY2sgdG9cclxuICAgIC8vIExhYmVsLmVuYWJsZU91dGxpbmUsIHNvIGxldCB0aGF0IGxpZmVjeWNsZSBmaW5pc2ggYmVmb3JlIGVpdGhlclxyXG4gICAgLy8gcmVjb25maWd1cmluZyBvciByZW1vdmluZyB0aGUgTGFiZWwgY29tcG9uZW50LlxyXG4gICAgbm9kZS5yZW1vdmVDb21wb25lbnQob3V0bGluZSk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiBTZXQ8YW55PiB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gbmV3IFNldDxhbnk+KCk7XHJcbiAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICBpZiAoIXVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKSkge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5TcHJpdGUpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAncmljaFRleHQnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuUmljaFRleHQpO1xyXG4gICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5maWdtYVR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkxhYmVsKTtcclxuICAgIH0gZWxzZSBpZiAoIVJBU1RFUl9WRUNUT1JfVFlQRVMuaGFzKHNwZWMuZmlnbWFUeXBlKSkge1xyXG4gICAgICAgIGlmIChoYXNHcmFwaGljc1Zpc3VhbChzcGVjKSB8fCBjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLkdyYXBoaWNzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuTWFzayk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnXHJcbiAgICAgICAgJiYgc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAmJiBsYXlvdXRNb2RlXHJcbiAgICAgICAgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuTGF5b3V0KTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlNjcm9sbFZpZXcpO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ2J1dHRvbicpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5CdXR0b24pO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwZWMub3BhY2l0eSA8IDAuOTk5KSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuVUlPcGFjaXR5KTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZXNpcmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWl0Rm9yRGVmZXJyZWRDb21wb25lbnRSZW1vdmFsKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDApKTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFByZWZhYk93bmVyc2hpcEd1YXJkIHtcclxuICAgIHByZXZpb3VzSGVscGVyRmlsZUlkczogU2V0PHN0cmluZz47XHJcbiAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PjtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQobm9kZSk7XHJcbiAgICByZXR1cm4gIWd1YXJkLnByZWV4aXN0aW5nTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpXHJcbiAgICAgICAgfHwgQm9vbGVhbihmaWxlSWQgJiYgZ3VhcmQucHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhmaWxlSWQpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoXHJcbiAgICBjb21wb25lbnQ6IGFueSxcclxuICAgIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgIG93bmVyTmFtZTogc3RyaW5nLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmICghY29tcG9uZW50IHx8ICFndWFyZC5wcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudCkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmICghZmlsZUlkIHx8ICFndWFyZC5wcmV2aW91c0NvbXBvbmVudEZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgIGDoioLngrnigJwke293bmVyTmFtZX3igJ3kuIrnmoQgJHtjb21wb25lbnQuY29uc3RydWN0b3I/Lm5hbWUgPz8gJ0NvbXBvbmVudCd9IOS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyTm9kZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgaWYgKCFpc093bmVkSGVscGVyTm9kZShub2RlLCBndWFyZCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOi+heWKqeiKgueCueKAnCR7bm9kZS5uYW1lfeKAneS4jeaYryBGaWdtYSBJbXBvcnRlciDliJvlu7rnmoTvvIzlt7LlgZzmraLmm7TmlrDjgIJgKTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRHZW5lcmF0ZWRDb21wb25lbnQoY29tcG9uZW50LCBndWFyZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKGlzT3duZWRIZWxwZXJOb2RlKGNoaWxkLCBndWFyZCkpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGNoaWxkLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKFxyXG4gICAgaGVscGVyOiBhbnksXHJcbiAgICBzdXJ2aXZvcjogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUoaGVscGVyLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCByZW1vdmUgPSAobm9kZTogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubm9kZS5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgaWYgKGd1YXJkICYmIGlzT3duZWRIZWxwZXJOb2RlKGNoaWxkLCBndWFyZCkpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZShjaGlsZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIHN1cnZpdm9yKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgIH07XHJcbiAgICByZW1vdmUoaGVscGVyKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkQmFja2dyb3VuZChub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IGJhY2tncm91bmQgPSBub2RlLmdldENoaWxkQnlOYW1lKEJBQ0tHUk9VTkRfTk9ERV9OQU1FKTtcclxuICAgIGlmICghYmFja2dyb3VuZCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUoYmFja2dyb3VuZCwgbm9kZSwgZ3VhcmQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95R2VuZXJhdGVkVGlsZWRTcHJpdGUoXHJcbiAgICB0aWxlZFNwcml0ZTogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgZGVzdHJveU93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgc3Vydml2b3IsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlOiBhbnksIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRNYXNrLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0aWxlZFNwcml0ZSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICBkZXN0cm95R2VuZXJhdGVkVGlsZWRTcHJpdGUodGlsZWRTcHJpdGUsIG5vZGUsIGd1YXJkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlT2Jzb2xldGVTY3JvbGxIZWxwZXJzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIEEgZmxhdHRlbmVkIG5vZGUgaGFzIG5vIG5ldyBjaGlsZCBzcGVjcyBieSBkZXNpZ24uIEtlZXAgZXZlcnkgZXhpc3RpbmdcclxuICAgIC8vIGNoaWxkIGFsaXZlIHVudGlsIHJlbW92ZUZsYXR0ZW5lZE1hcHBlZERlc2NlbmRhbnRzIGNhbiBkaXN0aW5ndWlzaCBvbGRcclxuICAgIC8vIEZpZ21hLW1hcHBlZCBub2RlcyBmcm9tIHVzZXItYXV0aG9yZWQgbm9kZXMuIE90aGVyd2lzZSBkZXN0cm95aW5nIHRoZVxyXG4gICAgLy8gaGVscGVyIHdvdWxkIHJlY3Vyc2l2ZWx5IGRlc3Ryb3kgbWFudWFsIGNoaWxkcmVuIGF0IENvY29zJyBkZWZlcnJlZFxyXG4gICAgLy8gZGVzdHJ1Y3Rpb24gYm91bmRhcnkuXHJcbiAgICBjb25zdCBwcmVzZXJ2ZUNoaWxkcmVuID0gc3BlYy5jaGlsZHJlbi5sZW5ndGggPiAwIHx8IGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYyk7XHJcbiAgICBjb25zdCBtb3ZlQ2hpbGRyZW5Ub05vZGUgPSAoY29udGFpbmVyOiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGd1YXJkIHx8IHByZXNlcnZlQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGxlZ2FjeSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxlZ2FjeS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbGVnYWN5LmRlc3Ryb3koKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjcm9sbCA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlNjcm9sbFZpZXcpO1xyXG4gICAgY29uc3QgdmlldyA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKTtcclxuICAgIGNvbnN0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpO1xyXG4gICAgaWYgKCFzY3JvbGwgfHwgIXZpZXcgfHwgIWNvbnRlbnRcclxuICAgICAgICB8fCAoc2Nyb2xsLmNvbnRlbnQgIT09IGNvbnRlbnQgJiYgc2Nyb2xsLmNvbnRlbnQgIT0gbnVsbCkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodmlldywgZ3VhcmQpO1xyXG4gICAgICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodmlldywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChwcmVzZXJ2ZUNoaWxkcmVuKSB7XHJcbiAgICAgICAgbW92ZUNoaWxkcmVuVG9Ob2RlKGNvbnRlbnQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLnZpZXcuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZCAhPT0gY29udGVudCkge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBub2RlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnRlbnQucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgY29udGVudC5kZXN0cm95KCk7XHJcbiAgICB2aWV3LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIHZpZXcuZGVzdHJveSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZVBvc2l0aW9uKFxyXG4gICAgZnJhbWU6IFJlY3QsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBwYXJlbnRUcmFuc2Zvcm0/OiBhbnksXHJcbiAgICBjaGlsZFRyYW5zZm9ybT86IGFueSxcclxuKTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHtcclxuICAgIGlmICghcGFyZW50RnJhbWUpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMCwgeTogMSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKSA+IDBcclxuICAgICAgICA/IE51bWJlcihwYXJlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogcGFyZW50RnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBwYXJlbnRGcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHdpZHRoID0gZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGhlaWdodCA9IGZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgY2hpbGRBbmNob3IgPSBjaGlsZFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAvLyBGaWdtYSBjb29yZGluYXRlcyBhcmUgbWVhc3VyZWQgZnJvbSB0aGUgcGFyZW50J3MgdG9wLWxlZnQuIENvbnZlcnRcclxuICAgICAgICAvLyB0aGF0IHJlY3RhbmdsZSB0byB0aGUgbG9jYWwgcG9zaXRpb24gb2YgdGhlIG5vZGUncyBjZW50ZXIgYW5jaG9yLlxyXG4gICAgICAgIHg6IChmcmFtZS54IC0gcGFyZW50RnJhbWUueCkgKiBzY2FsZVxyXG4gICAgICAgICAgICAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLnhcclxuICAgICAgICAgICAgKyB3aWR0aCAqIGNoaWxkQW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSlcclxuICAgICAgICAgICAgLSAoZnJhbWUueSAtIHBhcmVudEZyYW1lLnkpICogc2NhbGVcclxuICAgICAgICAgICAgLSBoZWlnaHQgKiAoMSAtIGNoaWxkQW5jaG9yLnkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVUcmFuc2Zvcm1Qb3NpdGlvbihcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgcGFyZW50VHJhbnNmb3JtPzogYW55LFxyXG4pOiB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0gfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKHNwZWMuaXNSb290IHx8ICFzcGVjLmludHJpbnNpY1NpemUpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBtYXRyaXggPSBzcGVjLnJlbGF0aXZlVHJhbnNmb3JtO1xyXG4gICAgY29uc3QgdmFsdWVzID0gW1xyXG4gICAgICAgIG1hdHJpeD8uWzBdPy5bMF0sIG1hdHJpeD8uWzBdPy5bMV0sIG1hdHJpeD8uWzBdPy5bMl0sXHJcbiAgICAgICAgbWF0cml4Py5bMV0/LlswXSwgbWF0cml4Py5bMV0/LlsxXSwgbWF0cml4Py5bMV0/LlsyXSxcclxuICAgIF07XHJcbiAgICBpZiAoIXZhbHVlcy5ldmVyeSgodmFsdWUpID0+IHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgW20wMCwgbTAxLCB0eCwgbTEwLCBtMTEsIHR5XSA9IHZhbHVlcyBhcyBudW1iZXJbXTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3QgcGFyZW50U2l6ZSA9IHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemUgPz8ge307XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRTaXplLndpZHRoKTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRTaXplLmhlaWdodCk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShwYXJlbnRXaWR0aCkgfHwgIU51bWJlci5pc0Zpbml0ZShwYXJlbnRIZWlnaHQpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIC8vIEZpZ21hIHJlbGF0aXZlVHJhbnNmb3JtIGlzIHRvcC1sZWZ0IGJhc2VkLiBUcmFuc2Zvcm0gdGhlIHVucm90YXRlZCBsb2NhbFxyXG4gICAgLy8gY2VudGVyLCB0aGVuIGNvbnZlcnQgdGhlIHBhcmVudCdzIGRvd253YXJkIFkgYXhpcyB0byBDb2NvcyB1cHdhcmQgWS5cclxuICAgIGNvbnN0IGNlbnRlclggPSB0eCArIG0wMCAqIHNwZWMuaW50cmluc2ljU2l6ZS53aWR0aCAvIDJcclxuICAgICAgICArIG0wMSAqIHNwZWMuaW50cmluc2ljU2l6ZS5oZWlnaHQgLyAyO1xyXG4gICAgY29uc3QgY2VudGVyWSA9IHR5ICsgbTEwICogc3BlYy5pbnRyaW5zaWNTaXplLndpZHRoIC8gMlxyXG4gICAgICAgICsgbTExICogc3BlYy5pbnRyaW5zaWNTaXplLmhlaWdodCAvIDI7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHg6IGNlbnRlclggKiBzY2FsZSAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLngsXHJcbiAgICAgICAgeTogcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSkgLSBjZW50ZXJZICogc2NhbGUsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHZW9tZXRyeShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiBhbnkge1xyXG4gICAgY29uc3QgeyBVSVRyYW5zZm9ybSwgVmVjMyB9ID0gY2M7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gbm9kZS5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIGNvbnN0IHNpemUgPSBzcGVjLmludHJpbnNpY1NpemUgPz8gc3BlYy5mcmFtZTtcclxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNpemUuaGVpZ2h0ICogc2NhbGUpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IG5vZGUucGFyZW50Py5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcG9zaXRpb24gPSBzcGVjLmlzUm9vdFxyXG4gICAgICAgID8geyB4OiAwLCB5OiAwIH1cclxuICAgICAgICA6IHJlbGF0aXZlVHJhbnNmb3JtUG9zaXRpb24oc3BlYywgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSlcclxuICAgICAgICAgICAgPz8gZnJhbWVQb3NpdGlvbihzcGVjLmZyYW1lLCBzcGVjLnBhcmVudEZyYW1lLCBzY2FsZSwgcGFyZW50VHJhbnNmb3JtLCB0cmFuc2Zvcm0pO1xyXG4gICAgbm9kZS5zZXRQb3NpdGlvbihuZXcgVmVjMyhwb3NpdGlvbi54LCBwb3NpdGlvbi55LCBub2RlLnBvc2l0aW9uPy56ID8/IDApKTtcclxuICAgIG5vZGUuc2V0Um90YXRpb25Gcm9tRXVsZXIoMCwgMCwgc3BlYy5yb3RhdGlvbik7XHJcbiAgICBub2RlLmFjdGl2ZSA9IHNwZWMudmlzaWJsZTtcclxuICAgIHJldHVybiB0cmFuc2Zvcm07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVQYWludChwYWludHM6IEZpZ21hUGFpbnRbXSk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHBhaW50cy5maW5kKChwYWludCkgPT4gcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UgJiYgKHBhaW50Lm9wYWNpdHkgPz8gMSkgPiAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmlzaWJsZVNvbGlkUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnR5cGUgPT09ICdTT0xJRCdcclxuICAgICAgICAmJiBwYWludC52aXNpYmxlICE9PSBmYWxzZVxyXG4gICAgICAgICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMFxyXG4gICAgICAgICYmIEJvb2xlYW4ocGFpbnQuY29sb3IpXHJcbiAgICAgICAgJiYgKHBhaW50LmNvbG9yPy5hID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZEZpbGwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IEZpZ21hUGFpbnQgfCB1bmRlZmluZWQge1xyXG4gICAgcmV0dXJuIHZpc2libGVTb2xpZFBhaW50KHNwZWMuZmlsbHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2YWxpZFNvbGlkU3Ryb2tlKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBzcGVjLnN0cm9rZVdlaWdodCA+IDAgPyB2aXNpYmxlU29saWRQYWludChzcGVjLnN0cm9rZXMpIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYXNHcmFwaGljc1Zpc3VhbChzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbih2aXNpYmxlU29saWRGaWxsKHNwZWMpIHx8IHZhbGlkU29saWRTdHJva2Uoc3BlYykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkcmF3R3JhcGhpY3MoZ3JhcGhpY3M6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZmlsbCA9IHZpc2libGVTb2xpZEZpbGwoc3BlYyk7XHJcbiAgICBjb25zdCBzdHJva2UgPSB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpO1xyXG4gICAgaWYgKCFmaWxsICYmICFzdHJva2UpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB3aWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCByYWRpdXMgPSBNYXRoLm1heChcclxuICAgICAgICAwLFxyXG4gICAgICAgIE1hdGgubWluKE1hdGgubWluKC4uLnNwZWMuY29ybmVyUmFkaWkpICogc2NhbGUsIHdpZHRoIC8gMiwgaGVpZ2h0IC8gMiksXHJcbiAgICApO1xyXG4gICAgaWYgKHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRScpIHtcclxuICAgICAgICBncmFwaGljcy5lbGxpcHNlKDAsIDAsIHdpZHRoIC8gMiwgaGVpZ2h0IC8gMik7XHJcbiAgICB9IGVsc2UgaWYgKHJhZGl1cyA+IDApIHtcclxuICAgICAgICBncmFwaGljcy5yb3VuZFJlY3QoLXdpZHRoIC8gMiwgLWhlaWdodCAvIDIsIHdpZHRoLCBoZWlnaHQsIHJhZGl1cyk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGdyYXBoaWNzLnJlY3QoLXdpZHRoIC8gMiwgLWhlaWdodCAvIDIsIHdpZHRoLCBoZWlnaHQpO1xyXG4gICAgfVxyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZmlsbENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGwoKTtcclxuICAgIH1cclxuICAgIGlmIChzdHJva2U/LmNvbG9yKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MubGluZVdpZHRoID0gTWF0aC5tYXgoMC41LCBzcGVjLnN0cm9rZVdlaWdodCAqIHNjYWxlKTtcclxuICAgICAgICBncmFwaGljcy5zdHJva2VDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlKCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUdyYXBoaWNzKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuR3JhcGhpY3MpO1xyXG4gICAgZ3JhcGhpY3MuZW5hYmxlZCA9IHRydWU7XHJcbiAgICBncmFwaGljcy5jbGVhcigpO1xyXG4gICAgZHJhd0dyYXBoaWNzKGdyYXBoaWNzLCBzcGVjLCBzY2FsZSwgY2MpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVMYWJlbFRleHQoY2hhcmFjdGVyczogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcclxuICAgIHJldHVybiAoY2hhcmFjdGVycyA/PyAnJylcclxuICAgICAgICAucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKVxyXG4gICAgICAgIC5yZXBsYWNlKC9bXFxyXFx1MjAyOFxcdTIwMjldL2csICdcXG4nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaXNNdWx0aWxpbmVMYWJlbChjaGFyYWN0ZXJzOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICAgIC8vIENvY29zIENyZWF0b3IgMy44LjcgZGlzYWJsZXMgYXV0b21hdGljIHdyYXBwaW5nIHdoZW5ldmVyIG92ZXJmbG93IGlzXHJcbiAgICAvLyBOT05FLiBPbmx5IGV4cGxpY2l0IGxpbmUgZmVlZHMgY2FuIHRoZXJlZm9yZSBwcm9kdWNlIHJlYWwgbGluZSBicmVha3MuXHJcbiAgICByZXR1cm4gY2hhcmFjdGVycy5pbmNsdWRlcygnXFxuJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUxhYmVsKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBMYWJlbCB9ID0gY2M7XHJcbiAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKSA/PyBub2RlLmFkZENvbXBvbmVudChMYWJlbCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgY29uc3QgY2hhcmFjdGVycyA9IG5vcm1hbGl6ZUxhYmVsVGV4dChzcGVjLmNoYXJhY3RlcnMpO1xyXG4gICAgY29uc3QgbXVsdGlsaW5lID0gaXNNdWx0aWxpbmVMYWJlbChjaGFyYWN0ZXJzKTtcclxuICAgIGxhYmVsLmZvbnRTaXplID0gTWF0aC5tYXgoMSwgKHN0eWxlLmZvbnRTaXplID8/IDE2KSAqIHNjYWxlKTtcclxuICAgIGxhYmVsLmxpbmVIZWlnaHQgPSBNYXRoLm1heCgxLCAoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplID8/IDE2KSAqIHNjYWxlKTtcclxuICAgIGxhYmVsLnNwYWNpbmdYID0gKHN0eWxlLmxldHRlclNwYWNpbmcgPz8gMCkgKiBzY2FsZTtcclxuICAgIGxhYmVsLmVuYWJsZVdyYXBUZXh0ID0gZmFsc2U7XHJcbiAgICBsYWJlbC5vdmVyZmxvdyA9IExhYmVsLk92ZXJmbG93LkNMQU1QO1xyXG4gICAgbGFiZWwuaG9yaXpvbnRhbEFsaWduID0gbXVsdGlsaW5lXHJcbiAgICAgICAgPyBMYWJlbC5Ib3Jpem9udGFsQWxpZ24uTEVGVFxyXG4gICAgICAgIDogTGFiZWwuSG9yaXpvbnRhbEFsaWduLkNFTlRFUjtcclxuICAgIGxhYmVsLnZlcnRpY2FsQWxpZ24gPSBtdWx0aWxpbmVcclxuICAgICAgICA/IExhYmVsLlZlcnRpY2FsQWxpZ24uVE9QXHJcbiAgICAgICAgOiBMYWJlbC5WZXJ0aWNhbEFsaWduLkNFTlRFUjtcclxuICAgIGxhYmVsLnN0cmluZyA9IGNoYXJhY3RlcnM7XHJcbiAgICBsYWJlbC5lbmFibGVPdXRsaW5lID0gZmFsc2U7XHJcbiAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHsgcjogMSwgZzogMSwgYjogMSwgYTogMSB9KTtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlUGFpbnQoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICBsYWJlbC5jb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0cm9rZSA9IHZpc2libGVQYWludChzcGVjLnN0cm9rZXMpO1xyXG4gICAgaWYgKHN0cm9rZT8uY29sb3IgJiYgc3BlYy5zdHJva2VXZWlnaHQgPiAwKSB7XHJcbiAgICAgICAgbGFiZWwuZW5hYmxlT3V0bGluZSA9IHRydWU7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZUNvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgc3Ryb2tlLmNvbG9yLCBzdHJva2Uub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBsYWJlbC5vdXRsaW5lV2lkdGggPSBNYXRoLm1heCgxLCBzcGVjLnN0cm9rZVdlaWdodCAqIHNjYWxlKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlUmljaFRleHQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCB7IFJpY2hUZXh0IH0gPSBjYztcclxuICAgIGNvbnN0IHJpY2hUZXh0ID0gbm9kZS5nZXRDb21wb25lbnQoUmljaFRleHQpID8/IG5vZGUuYWRkQ29tcG9uZW50KFJpY2hUZXh0KTtcclxuICAgIGNvbnN0IHN0eWxlID0gc3BlYy50ZXh0U3R5bGUgPz8ge307XHJcbiAgICByaWNoVGV4dC5zdHJpbmcgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIHJpY2hUZXh0LmZvbnRTaXplID0gTWF0aC5tYXgoMSwgKHN0eWxlLmZvbnRTaXplID8/IDE2KSAqIHNjYWxlKTtcclxuICAgIHJpY2hUZXh0LmxpbmVIZWlnaHQgPSBNYXRoLm1heCgxLCAoc3R5bGUubGluZUhlaWdodFB4ID8/IHN0eWxlLmZvbnRTaXplID8/IDE2KSAqIHNjYWxlKTtcclxuICAgIHJpY2hUZXh0Lm1heFdpZHRoID0gTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKTtcclxuICAgIHJpY2hUZXh0LmhhbmRsZVRvdWNoRXZlbnQgPSBmYWxzZTtcclxuICAgIC8vIFJpY2hUZXh0IGlzIHByaW1hcmlseSB1c2VkIGZvciBydW50aW1lLWluamVjdGVkIG11bHRpLWxpbmUgY29udGVudC4gQW5cclxuICAgIC8vIGVtcHR5IEZpZ21hIHBsYWNlaG9sZGVyIG11c3QgdGhlcmVmb3JlIGtlZXAgdGhlIHNhbWUgdG9wLWxlZnQgY29udHJhY3RcclxuICAgIC8vIGFmdGVyIHRoZSBnYW1lIGFzc2lnbnMgaXRzIHJlYWwgc3RyaW5nLlxyXG4gICAgcmljaFRleHQuaG9yaXpvbnRhbEFsaWduID0gUmljaFRleHQuSG9yaXpvbnRhbEFsaWduLkxFRlQ7XHJcbiAgICByaWNoVGV4dC52ZXJ0aWNhbEFsaWduID0gUmljaFRleHQuVmVydGljYWxBbGlnbi5UT1A7XHJcbiAgICByaWNoVGV4dC5mb250RmFtaWx5ID0gc3R5bGUuZm9udEZhbWlseSA/PyAnJztcclxuICAgIHJpY2hUZXh0LnVzZVN5c3RlbUZvbnQgPSAhc3BlYy5mb250VXVpZDtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlUGFpbnQoc3BlYy5maWxscyk7XHJcbiAgICBpZiAoZmlsbD8uY29sb3IpIHtcclxuICAgICAgICByaWNoVGV4dC5mb250Q29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmFsaXplTGFiZWxHZW9tZXRyeShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIXRyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhYmVsID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTGFiZWwpO1xyXG4gICAgY29uc3Qgb3V0bGluZVdpZHRoID0gbGFiZWw/LmVuYWJsZU91dGxpbmVcbiAgICAgICAgPyBNYXRoLm1heCgwLCBOdW1iZXIobGFiZWwub3V0bGluZVdpZHRoKSB8fCAwKVxuICAgICAgICA6IDA7XG4gICAgY29uc3QgZmlnbWFIZWlnaHQgPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKTtcbiAgICBjb25zdCBmb250U2l6ZSA9IE1hdGgubWF4KDAsIE51bWJlcihsYWJlbD8uZm9udFNpemUpIHx8IDApO1xuICAgIGNvbnN0IGZpbmFsSGVpZ2h0ID0gZmlnbWFIZWlnaHQgPCBmb250U2l6ZVxuICAgICAgICA/IGZvbnRTaXplICsgb3V0bGluZVdpZHRoICogMlxuICAgICAgICA6IGZpZ21hSGVpZ2h0O1xuICAgIC8vIEtlZXAgdGhlIGltcG9ydGVkIEZpZ21hIGJveCB1bmxlc3MgYSBkZXRlcm1pbmlzdGljIG91dGxpbmUvZm9udCBsb3dlclxuICAgIC8vIGJvdW5kIHJlcXVpcmVzIGV4cGFuc2lvbi4gRXhwYW5kIHN5bW1ldHJpY2FsbHkgYXJvdW5kIHRoZSBjZW50ZXIgYW5jaG9yXG4gICAgLy8gc28gdGhlIG5vZGUncyBpbXBvcnRlZCBjZW50ZXIgcG9zaXRpb24gcmVtYWlucyB1bmNoYW5nZWQuXG4gICAgLy8gQW4gdW5kZXJzaXplZCBGaWdtYSB0ZXh0IGJveCBtdXN0IGF0IGxlYXN0IGNvbnRhaW4gdGhlIGZpbmFsIENvY29zIGZvbnRcbiAgICAvLyBzaXplLCBwbHVzIG9uZSBvdXRsaW5lIHdpZHRoIGFib3ZlIGFuZCBiZWxvdyB3aGVuIG91dGxpbmUgaXMgZW5hYmxlZC5cbiAgICB0cmFuc2Zvcm0uc2V0Q29udGVudFNpemUoXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSArIG91dGxpbmVXaWR0aCAqIDIpLFxuICAgICAgICBmaW5hbEhlaWdodCxcbiAgICApO1xufVxuXHJcbmZ1bmN0aW9uIGxvYWRBc3NldChhc3NldE1hbmFnZXI6IGFueSwgdXVpZDogc3RyaW5nKTogUHJvbWlzZTxhbnk+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgYXNzZXRNYW5hZ2VyLmxvYWRBbnkoeyB1dWlkIH0sIChlcnJvcjogRXJyb3IgfCBudWxsLCBhc3NldDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXNvbHZlKGFzc2V0KTtcclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjb25maWd1cmVTcHJpdGUobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxuICAgIGNvbnN0IHsgU3ByaXRlLCBVSVRyYW5zZm9ybSwgYXNzZXRNYW5hZ2VyIH0gPSBjYztcbiAgICBjb25zdCBzcHJpdGUgPSBub2RlLmdldENvbXBvbmVudChTcHJpdGUpID8/IG5vZGUuYWRkQ29tcG9uZW50KFNwcml0ZSk7XG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xuICAgIGNvbnN0IHRhcmdldFdpZHRoID0gTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKTtcbiAgICBjb25zdCB0YXJnZXRIZWlnaHQgPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKTtcblxuICAgIC8vIEtlZXAgYXNzaWdubWVudCBkZXRlcm1pbmlzdGljOiBhIG5ldyBTcHJpdGUgbWF5IGRlZmF1bHQgdG8gVFJJTU1FRCBhbmRcbiAgICAvLyBpbW1lZGlhdGVseSByZXdyaXRlIFVJVHJhbnNmb3JtIHdoZW4gaXRzIFNwcml0ZUZyYW1lIGlzIGFzc2lnbmVkLlxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XG4gICAgY29uc3Qgc3ByaXRlRnJhbWUgPSBhd2FpdCBsb2FkQXNzZXQoYXNzZXRNYW5hZ2VyLCBzcGVjLnNwcml0ZS51dWlkKTtcbiAgICBzcHJpdGUuc3ByaXRlRnJhbWUgPSBzcHJpdGVGcmFtZTtcbiAgICBzcHJpdGUudHlwZSA9IHNwZWMuc3ByaXRlLnRpbGVkXG4gICAgICAgID8gU3ByaXRlLlR5cGUuVElMRURcbiAgICAgICAgOiBzcGVjLnNwcml0ZS5zbGljZWRcbiAgICAgICAgICAgID8gU3ByaXRlLlR5cGUuU0xJQ0VEXG4gICAgICAgICAgICA6IFNwcml0ZS5UeXBlLlNJTVBMRTtcblxuICAgIGlmICghc3BlYy5zcHJpdGUuc2xpY2VkICYmICFzcGVjLnNwcml0ZS50aWxlZCkge1xuICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuVFJJTU1FRDtcbiAgICAgICAgY29uc3QgdHJpbW1lZFdpZHRoID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LndpZHRoKTtcbiAgICAgICAgY29uc3QgdHJpbW1lZEhlaWdodCA9IE51bWJlcih0cmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpO1xuICAgICAgICBjb25zdCByYXdXaWR0aCA9IE51bWJlcihzcHJpdGVGcmFtZT8ub3JpZ2luYWxTaXplPy53aWR0aCA/PyBzcHJpdGVGcmFtZT8ud2lkdGgpO1xuICAgICAgICBjb25zdCByYXdIZWlnaHQgPSBOdW1iZXIoc3ByaXRlRnJhbWU/Lm9yaWdpbmFsU2l6ZT8uaGVpZ2h0ID8/IHNwcml0ZUZyYW1lPy5oZWlnaHQpO1xuICAgICAgICBjb25zdCBoYXNWYWxpZFNwcml0ZVNpemUgPSBOdW1iZXIuaXNGaW5pdGUodHJpbW1lZFdpZHRoKVxuICAgICAgICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKHRyaW1tZWRIZWlnaHQpXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3V2lkdGgpXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUocmF3SGVpZ2h0KVxuICAgICAgICAgICAgJiYgcmF3V2lkdGggPiAwXG4gICAgICAgICAgICAmJiByYXdIZWlnaHQgPiAwO1xuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdXaWR0aCAtIHRhcmdldFdpZHRoKSA8PSAwLjUxXG4gICAgICAgICAgICAmJiBNYXRoLmFicyhyYXdIZWlnaHQgLSB0YXJnZXRIZWlnaHQpIDw9IDAuNTEpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaGFzVmFsaWRTcHJpdGVTaXplKSB7XG4gICAgICAgICAgICBjb25zdCBzY2FsZVggPSB0YXJnZXRXaWR0aCAvIHJhd1dpZHRoO1xuICAgICAgICAgICAgY29uc3Qgc2NhbGVZID0gdGFyZ2V0SGVpZ2h0IC8gcmF3SGVpZ2h0O1xuICAgICAgICAgICAgaWYgKE1hdGguYWJzKHNjYWxlWCAtIHNjYWxlWSkgPD0gMC4wMDAxKSB7XG4gICAgICAgICAgICAgICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcbiAgICAgICAgICAgICAgICB0cmFuc2Zvcm0/LnNldENvbnRlbnRTaXplKHRyaW1tZWRXaWR0aCAqIHNjYWxlWCwgdHJpbW1lZEhlaWdodCAqIHNjYWxlWSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gU2xpY2VkL3RpbGVkIHNwcml0ZXMgYW5kIHNwcml0ZXMgcmVzaXplZCBpbiBGaWdtYSBtdXN0IHJldGFpbiB0aGUgZGVzaWduXG4gICAgLy8gc2l6ZS4gQ29jb3MgcmVwcmVzZW50cyB0aGF0IHN0YXRlIGFzIENVU1RPTS5cbiAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xuICAgIHRyYW5zZm9ybT8uc2V0Q29udGVudFNpemUodGFyZ2V0V2lkdGgsIHRhcmdldEhlaWdodCk7XG59XG5cclxuZnVuY3Rpb24gcmVxdWlyZXNUaWxlZE1hc2soc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4oc3BlYy5zcHJpdGU/LnRpbGVkICYmIHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBuYXRpdmVUaWxlU2NhbGUoc3BlYzogU2NlbmVOb2RlU3BlYyk6IG51bWJlciB7XHJcbiAgICBjb25zdCBzY2FsZSA9IHNwZWMuc3ByaXRlPy50aWxlU2NhbGU7XHJcbiAgICByZXR1cm4gdHlwZW9mIHNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoc2NhbGUpICYmIHNjYWxlID4gMFxyXG4gICAgICAgID8gc2NhbGVcclxuICAgICAgICA6IDE7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihzcGVjLnNwcml0ZT8udGlsZWQpXHJcbiAgICAgICAgJiYgKHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpIHx8IE1hdGguYWJzKG5hdGl2ZVRpbGVTY2FsZShzcGVjKSAtIDEpID4gMWUtNik7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVRpbGVkU3ByaXRlSGVscGVyKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBuZWVkc01hc2sgPSByZXF1aXJlc1RpbGVkTWFzayhzcGVjKTtcclxuICAgIGxldCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGxldCB0aWxlZFNwcml0ZSA9IHRpbGVkTWFzaz8uZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSlcclxuICAgICAgICA/PyBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgaWYgKHRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodGlsZWRNYXNrLCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAobmVlZHNNYXNrKSB7XHJcbiAgICAgICAgaWYgKCF0aWxlZE1hc2spIHtcclxuICAgICAgICAgICAgdGlsZWRNYXNrID0gbmV3IGNjLk5vZGUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgICAgICAgICBub2RlLmFkZENoaWxkKHRpbGVkTWFzayk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRpbGVkTWFzay5uYW1lID0gVElMRURfTUFTS19OT0RFX05BTUU7XHJcbiAgICAgICAgdGlsZWRNYXNrLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICB0aWxlZE1hc2suYWN0aXZlID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBtYXNrVHJhbnNmb3JtID0gdGlsZWRNYXNrLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSlcclxuICAgICAgICAgICAgPz8gdGlsZWRNYXNrLmFkZENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgbWFza1RyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICAgICAgbWFza1RyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSksXHJcbiAgICAgICAgKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0UG9zaXRpb24obmV3IGNjLlZlYzMoMCwgMCwgMCkpO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0U2NhbGUobmV3IGNjLlZlYzMoMSwgMSwgMSkpO1xyXG4gICAgICAgIGNvbmZpZ3VyZUNsaXAodGlsZWRNYXNrLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFNpYmxpbmdJbmRleCgwKTtcclxuICAgIH0gZWxzZSBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4udGlsZWRNYXNrLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aWxlZE1hc2sucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIHRpbGVkTWFzay5kZXN0cm95KCk7XHJcbiAgICAgICAgdGlsZWRNYXNrID0gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHNwcml0ZVBhcmVudCA9IHRpbGVkTWFzayA/PyBub2RlO1xyXG4gICAgaWYgKCF0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgIHRpbGVkU3ByaXRlID0gbmV3IGNjLk5vZGUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgc3ByaXRlUGFyZW50LmFkZENoaWxkKHRpbGVkU3ByaXRlKTtcclxuICAgIH0gZWxzZSBpZiAodGlsZWRTcHJpdGUucGFyZW50ICE9PSBzcHJpdGVQYXJlbnQpIHtcclxuICAgICAgICB0aWxlZFNwcml0ZS5wYXJlbnQgPSBzcHJpdGVQYXJlbnQ7XHJcbiAgICB9XHJcbiAgICB0aWxlZFNwcml0ZS5uYW1lID0gVElMRURfU1BSSVRFX05PREVfTkFNRTtcclxuICAgIHRpbGVkU3ByaXRlLmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgIHRpbGVkU3ByaXRlLmFjdGl2ZSA9IHRydWU7XHJcbiAgICBhd2FpdCBjb25maWd1cmVTcHJpdGUodGlsZWRTcHJpdGUsIHNwZWMsIHNjYWxlLCBjYyk7XHJcbiAgICBjb25zdCB0aWxlU2NhbGUgPSBuYXRpdmVUaWxlU2NhbGUoc3BlYyk7XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSB0aWxlZFNwcml0ZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pXHJcbiAgICAgICAgPz8gdGlsZWRTcHJpdGUuYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICB0cmFuc2Zvcm0uc2V0Q29udGVudFNpemUoXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlIC8gdGlsZVNjYWxlKSxcclxuICAgICk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRSb3RhdGlvbkZyb21FdWxlcigwLCAwLCAwKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNjYWxlKG5ldyBjYy5WZWMzKHRpbGVTY2FsZSwgdGlsZVNjYWxlLCAxKSk7XHJcbiAgICB0aWxlZFNwcml0ZS5zZXRTaWJsaW5nSW5kZXgoMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZU9wYWNpdHkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5vcGFjaXR5ID49IDAuOTk5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3BhY2l0eSA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJT3BhY2l0eSkgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuVUlPcGFjaXR5KTtcclxuICAgIG9wYWNpdHkub3BhY2l0eSA9IE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc3BlYy5vcGFjaXR5KSkgKiAyNTUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYXlvdXQobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAoIW1vZGUgfHwgbW9kZSA9PT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBMYXlvdXQsIFNpemUgfSA9IGNjO1xyXG4gICAgY29uc3QgbGF5b3V0ID0gbm9kZS5nZXRDb21wb25lbnQoTGF5b3V0KSA/PyBub2RlLmFkZENvbXBvbmVudChMYXlvdXQpO1xyXG4gICAgbGF5b3V0LnR5cGUgPSBtb2RlID09PSAnSE9SSVpPTlRBTCdcclxuICAgICAgICA/IExheW91dC5UeXBlLkhPUklaT05UQUxcclxuICAgICAgICA6IG1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuVHlwZS5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5UeXBlLkdSSUQ7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0dSSUQnKSB7XHJcbiAgICAgICAgbGF5b3V0LnN0YXJ0QXhpcyA9IHNwZWMubGF5b3V0Py5zb3VyY2VNb2RlID09PSAnVkVSVElDQUwnXHJcbiAgICAgICAgICAgID8gTGF5b3V0LkF4aXNEaXJlY3Rpb24uVkVSVElDQUxcclxuICAgICAgICAgICAgOiBMYXlvdXQuQXhpc0RpcmVjdGlvbi5IT1JJWk9OVEFMO1xyXG4gICAgfVxyXG4gICAgbGF5b3V0LnJlc2l6ZU1vZGUgPSBMYXlvdXQuUmVzaXplTW9kZS5OT05FO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdMZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1JpZ2h0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdSaWdodCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdUb3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnBhZGRpbmdCb3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgbGF5b3V0LnNwYWNpbmdYID0gc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1kgPSAobW9kZSA9PT0gJ0dSSUQnID8gc3BlYy5sYXlvdXQhLmNvdW50ZXJTcGFjaW5nIDogc3BlYy5sYXlvdXQhLml0ZW1TcGFjaW5nKSAqIHNjYWxlO1xyXG4gICAgY29uc3QgYWN0aXZlQ2hpbGRyZW4gPSBzcGVjLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnZpc2libGUpO1xyXG4gICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbldpZHRoID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUud2lkdGggKiBzY2FsZSwgMCk7XHJcbiAgICAgICAgY29uc3QgaW5uZXJXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nTGVmdCAtIGxheW91dC5wYWRkaW5nUmlnaHQ7XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWCA9IE1hdGgubWF4KDAsIChpbm5lcldpZHRoIC0gY2hpbGRyZW5XaWR0aCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbldpZHRoICsgbGF5b3V0LnNwYWNpbmdYICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVyV2lkdGggLSB1c2VkKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdMZWZ0ICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gJ1ZFUlRJQ0FMJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBjaGlsZHJlbkhlaWdodCA9IGFjdGl2ZUNoaWxkcmVuLnJlZHVjZSgodG90YWwsIGNoaWxkKSA9PiB0b3RhbCArIGNoaWxkLmZyYW1lLmhlaWdodCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lckhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLSBsYXlvdXQucGFkZGluZ1RvcCAtIGxheW91dC5wYWRkaW5nQm90dG9tO1xyXG4gICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnU1BBQ0VfQkVUV0VFTicgJiYgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoID4gMSkge1xyXG4gICAgICAgICAgICBsYXlvdXQuc3BhY2luZ1kgPSBNYXRoLm1heCgwLCAoaW5uZXJIZWlnaHQgLSBjaGlsZHJlbkhlaWdodCkgLyAoYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVzZWQgPSBjaGlsZHJlbkhlaWdodCArIGxheW91dC5zcGFjaW5nWSAqIE1hdGgubWF4KDAsIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCAtIDEpO1xyXG4gICAgICAgICAgICBjb25zdCByZW1haW5pbmcgPSBNYXRoLm1heCgwLCBpbm5lckhlaWdodCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZyAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ01BWCcpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nVG9wICs9IHJlbWFpbmluZztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICBsYXlvdXQuY2VsbFNpemUgPSBuZXcgU2l6ZShcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS53aWR0aCkpICogc2NhbGUsXHJcbiAgICAgICAgICAgIE1hdGgubWF4KC4uLnNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gY2hpbGQuZnJhbWUuaGVpZ2h0KSkgKiBzY2FsZSxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseUNvdW50ZXJBbGlnbm1lbnQoXHJcbiAgICBwYXJlbnQ6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgY29uc3QgbW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgY29uc3QgYWxpZ25tZW50ID0gc3BlYy5sYXlvdXQ/LmNvdW50ZXJBbGlnbjtcclxuICAgIGlmICghbW9kZSB8fCAhYWxpZ25tZW50IHx8ICFbJ0hPUklaT05UQUwnLCAnVkVSVElDQUwnXS5pbmNsdWRlcyhtb2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHBhcmVudFRyYW5zZm9ybSA9IHBhcmVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50VHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEhlaWdodCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpXHJcbiAgICAgICAgOiBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGF5b3V0V2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRIZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgbGVmdCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nTGVmdCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB0b3AgPSBzcGVjLmxheW91dCEucGFkZGluZ1RvcCAqIHNjYWxlO1xyXG4gICAgY29uc3QgYm90dG9tID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdCb3R0b20gKiBzY2FsZTtcclxuICAgIGNvbnN0IHBhcmVudEFuY2hvciA9IHBhcmVudFRyYW5zZm9ybT8uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgZm9yIChjb25zdCBjaGlsZFNwZWMgb2Ygc3BlYy5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBub2RlTWFwW2NoaWxkU3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBjaGlsZCA9IHV1aWQgPyBmaW5kQnlVdWlkKHBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHRyYW5zZm9ybSA9IGNoaWxkPy5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgIGlmICghY2hpbGQgfHwgIXRyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcG9zaXRpb24gPSBjaGlsZC5wb3NpdGlvbi5jbG9uZSgpO1xyXG4gICAgICAgIGlmIChtb2RlID09PSAnSE9SSVpPTlRBTCcpIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0SGVpZ2h0IC0gdG9wIC0gYm90dG9tKTtcclxuICAgICAgICAgICAgbGV0IHRvcE9mZnNldCA9IHRvcDtcclxuICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIHRvcE9mZnNldCA9IHRvcCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0uaGVpZ2h0KSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gbGF5b3V0SGVpZ2h0IC0gYm90dG9tIC0gdHJhbnNmb3JtLmhlaWdodDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZSh0cmFuc2Zvcm0ud2lkdGgsIGF2YWlsYWJsZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcG9zaXRpb24ueSA9IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgICAgICAtIHRvcE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSB0cmFuc2Zvcm0uaGVpZ2h0ICogKDEgLSAodHJhbnNmb3JtLmFuY2hvclBvaW50Py55ID8/IDAuNSkpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IE1hdGgubWF4KDAsIGxheW91dFdpZHRoIC0gbGVmdCAtIHJpZ2h0KTtcclxuICAgICAgICAgICAgbGV0IGxlZnRPZmZzZXQgPSBsZWZ0O1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxlZnQgKyAoYXZhaWxhYmxlIC0gdHJhbnNmb3JtLndpZHRoKSAvIDI7XHJcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoYWxpZ25tZW50ID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGVmdE9mZnNldCA9IGxheW91dFdpZHRoIC0gcmlnaHQgLSB0cmFuc2Zvcm0ud2lkdGg7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnU1RSRVRDSCcpIHtcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0uc2V0Q29udGVudFNpemUoYXZhaWxhYmxlLCB0cmFuc2Zvcm0uaGVpZ2h0KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi54ID0gbGVmdE9mZnNldFxyXG4gICAgICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICAgICArIHRyYW5zZm9ybS53aWR0aCAqICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnggPz8gMC41KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY2hpbGQuc2V0UG9zaXRpb24ocG9zaXRpb24pO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVDbGlwKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgZ3JhcGhpY3MgPSBub2RlLmdldENvbXBvbmVudChjYy5HcmFwaGljcyk7XHJcbiAgICBpZiAoZ3JhcGhpY3MpIHtcclxuICAgICAgICBncmFwaGljcy5lbmFibGVkID0gdHJ1ZTtcclxuICAgICAgICBncmFwaGljcy5jbGVhcigpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbWFzayA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLk1hc2spID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLk1hc2spO1xyXG4gICAgbWFzay50eXBlID0gc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJ1xyXG4gICAgICAgID8gY2MuTWFzay5UeXBlLkdSQVBISUNTX0VMTElQU0UgPz8gY2MuTWFzay5UeXBlLkVMTElQU0VcclxuICAgICAgICA6IGNjLk1hc2suVHlwZS5HUkFQSElDU19SRUNUID8/IGNjLk1hc2suVHlwZS5SRUNUO1xyXG4gICAgbWFzay5pbnZlcnRlZCA9IGZhbHNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBzcGVjLmNsaXBzQ29udGVudFxyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgc3BlYy5jaGlsZHJlbi5sZW5ndGggPiAwXHJcbiAgICAgICAgJiYgc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUJ1dHRvbihub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nKSB7XHJcbiAgICAgICAgY29uc3QgYnV0dG9uID0gbm9kZS5nZXRDb21wb25lbnQoY2MuQnV0dG9uKSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5CdXR0b24pO1xyXG4gICAgICAgIGJ1dHRvbi50YXJnZXQgPSBub2RlO1xyXG4gICAgICAgIGJ1dHRvbi50cmFuc2l0aW9uID0gY2MuQnV0dG9uLlRyYW5zaXRpb24uU0NBTEU7XHJcbiAgICAgICAgYnV0dG9uLnpvb21TY2FsZSA9IDAuOTtcclxuICAgICAgICBidXR0b24uZHVyYXRpb24gPSAwLjE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0cmFuc2Zvcm06IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogYW55IHtcclxuICAgIGlmIChzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3Jykge1xyXG4gICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgeyBOb2RlLCBVSVRyYW5zZm9ybSwgTWFzaywgU2Nyb2xsVmlldyB9ID0gY2M7XHJcbiAgICBsZXQgdmlldyA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKTtcclxuICAgIGxldCBjb250ZW50ID0gdmlldz8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKSA/PyBudWxsO1xyXG4gICAgaWYgKHZpZXcgJiYgZ3VhcmQpIHtcclxuICAgICAgICBhc3NlcnRPd25lZEhlbHBlclN1YnRyZWUodmlldywgZ3VhcmQpO1xyXG4gICAgICAgIGlmIChjb250ZW50KSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShjb250ZW50LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc2Nyb2xsID0gbm9kZS5nZXRDb21wb25lbnQoU2Nyb2xsVmlldykgPz8gbm9kZS5hZGRDb21wb25lbnQoU2Nyb2xsVmlldyk7XHJcbiAgICBpZiAoIXZpZXcpIHtcclxuICAgICAgICB2aWV3ID0gbmV3IE5vZGUoJ3ZpZXcnKTtcclxuICAgICAgICB2aWV3LmxheWVyID0gbm9kZS5sYXllcjtcclxuICAgICAgICBub2RlLmFkZENoaWxkKHZpZXcpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgdmlld1RyYW5zZm9ybSA9IHZpZXcuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyB2aWV3LmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICB2aWV3VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0Q29udGVudFNpemUodHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoLCB0cmFuc2Zvcm0uY29udGVudFNpemUuaGVpZ2h0KTtcclxuICAgIHZpZXcuc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICBjb25zdCBtYXNrID0gdmlldy5nZXRDb21wb25lbnQoTWFzaykgPz8gdmlldy5hZGRDb21wb25lbnQoTWFzayk7XHJcbiAgICBtYXNrLnR5cGUgPSBNYXNrLlR5cGUuR1JBUEhJQ1NfUkVDVCA/PyBNYXNrLlR5cGUuUkVDVDtcclxuICAgIGlmICghY29udGVudCkge1xyXG4gICAgICAgIGNvbnRlbnQgPSBuZXcgTm9kZSgnY29udGVudCcpO1xyXG4gICAgICAgIGNvbnRlbnQubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHZpZXcuYWRkQ2hpbGQoY29udGVudCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250ZW50VHJhbnNmb3JtID0gY29udGVudC5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IGNvbnRlbnQuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHByZXZpb3VzTGF5b3V0ID0gY29udGVudC5nZXRDb21wb25lbnQoY2MuTGF5b3V0KTtcclxuICAgIGNvbnN0IG5leHRMYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBpZiAocHJldmlvdXNMYXlvdXQgJiYgKCFuZXh0TGF5b3V0TW9kZSB8fCBuZXh0TGF5b3V0TW9kZSA9PT0gJ05PTkUnKSkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChwcmV2aW91c0xheW91dCwgZ3VhcmQsIGNvbnRlbnQubmFtZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnRlbnQucmVtb3ZlQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0KTtcclxuICAgIH1cclxuICAgIGNvbnRlbnRUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChjb250ZW50LCBjb250ZW50VHJhbnNmb3JtLCBzcGVjLCB0cmFuc2Zvcm0sIHNjYWxlKTtcclxuICAgIGNvbnN0IGxlZ2FjeSA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ19fRmlnbWFDb250ZW50Jyk7XHJcbiAgICBpZiAobGVnYWN5ICYmIGxlZ2FjeSAhPT0gY29udGVudCkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobGVnYWN5LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmxlZ2FjeS5jaGlsZHJlbl0pIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBjb250ZW50KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGVnYWN5LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBsZWdhY3kuZGVzdHJveSgpO1xyXG4gICAgfVxyXG4gICAgLy8gQ29jb3MgQ3JlYXRvciAzLjguNyBleHBlY3RzIHRoZSBjb250ZW50IE5vZGUgaGVyZS4gU2Nyb2xsVmlldy52aWV3IGlzIGFcclxuICAgIC8vIGdldHRlciBkZXJpdmVkIGZyb20gY29udGVudC5wYXJlbnQgYW5kIG11c3QgbmV2ZXIgYmUgYXNzaWduZWQgZGlyZWN0bHkuXHJcbiAgICBpZiAoc2Nyb2xsLmNvbnRlbnQgPT09IGNvbnRlbnQpIHtcclxuICAgICAgICBzY3JvbGwuY29udGVudCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBzY3JvbGwuY29udGVudCA9IGNvbnRlbnQ7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIHNjcm9sbC5ob3Jpem9udGFsID0gYXhlcy5ob3Jpem9udGFsO1xyXG4gICAgc2Nyb2xsLnZlcnRpY2FsID0gYXhlcy52ZXJ0aWNhbDtcclxuICAgIHJldHVybiBjb250ZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzY3JvbGxBeGVzKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiB7IGhvcml6b250YWw6IGJvb2xlYW47IHZlcnRpY2FsOiBib29sZWFuIH0ge1xyXG4gICAgY29uc3QgZGlyZWN0aW9uID0gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbiAmJiBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICE9PSAnTk9ORSdcclxuICAgICAgICA/IHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24udHJpbSgpLnRvVXBwZXJDYXNlKClcclxuICAgICAgICA6ICdWRVJUSUNBTF9TQ1JPTExJTkcnO1xyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUwnIHx8IGRpcmVjdGlvbiA9PT0gJ0hPUklaT05UQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGRpcmVjdGlvbiA9PT0gJ0JPVEgnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUwnXHJcbiAgICAgICAgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9BTkRfVkVSVElDQUxfU0NST0xMSU5HJykge1xyXG4gICAgICAgIHJldHVybiB7IGhvcml6b250YWw6IHRydWUsIHZlcnRpY2FsOiB0cnVlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBob3Jpem9udGFsOiBmYWxzZSwgdmVydGljYWw6IHRydWUgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2l6ZUFuZFBvc2l0aW9uU2Nyb2xsQ29udGVudChcclxuICAgIGNvbnRlbnQ6IGFueSxcclxuICAgIGNvbnRlbnRUcmFuc2Zvcm06IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aWV3cG9ydFdpZHRoID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy53aWR0aCkgfHwgMCk7XHJcbiAgICBjb25zdCB2aWV3cG9ydEhlaWdodCA9IE1hdGgubWF4KDAsIE51bWJlcih2aWV3cG9ydC5jb250ZW50U2l6ZT8uaGVpZ2h0KSB8fCAwKTtcclxuICAgIGNvbnN0IGNoaWxkUmlnaHQgPSBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+XHJcbiAgICAgICAgKGNoaWxkLmZyYW1lLnggLSBzcGVjLmZyYW1lLnggKyBjaGlsZC5mcmFtZS53aWR0aCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBjaGlsZEJvdHRvbSA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueSAtIHNwZWMuZnJhbWUueSArIGNoaWxkLmZyYW1lLmhlaWdodCkgKiBzY2FsZSk7XHJcbiAgICBjb25zdCBheGVzID0gc2Nyb2xsQXhlcyhzcGVjKTtcclxuICAgIGNvbnN0IGNvbnRlbnRXaWR0aCA9IGF4ZXMuaG9yaXpvbnRhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRXaWR0aCwgMCwgLi4uY2hpbGRSaWdodClcclxuICAgICAgICA6IHZpZXdwb3J0V2lkdGg7XHJcbiAgICBjb25zdCBjb250ZW50SGVpZ2h0ID0gYXhlcy52ZXJ0aWNhbFxyXG4gICAgICAgID8gTWF0aC5tYXgodmlld3BvcnRIZWlnaHQsIDAsIC4uLmNoaWxkQm90dG9tKVxyXG4gICAgICAgIDogdmlld3BvcnRIZWlnaHQ7XHJcbiAgICBjb250ZW50VHJhbnNmb3JtLnNldENvbnRlbnRTaXplKGNvbnRlbnRXaWR0aCwgY29udGVudEhlaWdodCk7XHJcbiAgICAvLyBCb3RoIGhlbHBlcnMgdXNlIENvY29zJyBkZWZhdWx0IGNlbnRlciBhbmNob3IuIE1vdmUgYW4gb3ZlcnNpemVkIGNvbnRlbnRcclxuICAgIC8vIG5vZGUgc28gaXRzIHRvcC1sZWZ0IHN0aWxsIGNvaW5jaWRlcyB3aXRoIHRoZSB2aWV3cG9ydCdzIHRvcC1sZWZ0LlxyXG4gICAgY29udGVudC5zZXRQb3NpdGlvbihcclxuICAgICAgICAoY29udGVudFdpZHRoIC0gdmlld3BvcnRXaWR0aCkgLyAyLFxyXG4gICAgICAgICh2aWV3cG9ydEhlaWdodCAtIGNvbnRlbnRIZWlnaHQpIC8gMixcclxuICAgICAgICAwLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluYWxpemVTY3JvbGwoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgdmlld3BvcnQ6IGFueSxcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLmtpbmQgIT09ICdzY3JvbGxWaWV3JyB8fCBjb250ZW50ID09PSBub2RlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gY29udGVudC5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgaWYgKCF0cmFuc2Zvcm0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIHRyYW5zZm9ybSwgc3BlYywgdmlld3BvcnQsIHNjYWxlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY291bnRTcGVjcyhzcGVjczogU2NlbmVOb2RlU3BlY1tdKTogbnVtYmVyIHtcclxuICAgIHJldHVybiBzcGVjcy5yZWR1Y2UoKHRvdGFsLCBzcGVjKSA9PiB0b3RhbCArIDEgKyBjb3VudFNwZWNzKHNwZWMuY2hpbGRyZW4pLCAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2VudGVySW5DYW52YXMobm9kZTogYW55LCBjYW52YXM6IGFueSwgVUlUcmFuc2Zvcm06IGFueSwgVmVjMzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBub2RlVHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgY2FudmFzVHJhbnNmb3JtID0gY2FudmFzPy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgaWYgKCFub2RlVHJhbnNmb3JtIHx8ICFjYW52YXNUcmFuc2Zvcm0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBjYW52YXNTaXplID0gY2FudmFzVHJhbnNmb3JtLmNvbnRlbnRTaXplID8/IHtcclxuICAgICAgICB3aWR0aDogY2FudmFzVHJhbnNmb3JtLndpZHRoLFxyXG4gICAgICAgIGhlaWdodDogY2FudmFzVHJhbnNmb3JtLmhlaWdodCxcclxuICAgIH07XHJcbiAgICBjb25zdCB3aWR0aCA9IE51bWJlcihjYW52YXNTaXplPy53aWR0aCkgPiAwID8gTnVtYmVyKGNhbnZhc1NpemUud2lkdGgpIDogNjQwO1xyXG4gICAgY29uc3QgaGVpZ2h0ID0gTnVtYmVyKGNhbnZhc1NpemU/LmhlaWdodCkgPiAwID8gTnVtYmVyKGNhbnZhc1NpemUuaGVpZ2h0KSA6IDExMzY7XHJcbiAgICBjb25zdCBjYW52YXNBbmNob3IgPSBjYW52YXNUcmFuc2Zvcm0uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3Qgbm9kZUFuY2hvciA9IG5vZGVUcmFuc2Zvcm0uYW5jaG9yUG9pbnQgPz8geyB4OiAwLjUsIHk6IDAuNSB9O1xyXG4gICAgY29uc3QgeCA9IHdpZHRoICogKDAuNSAtIGNhbnZhc0FuY2hvci54KVxyXG4gICAgICAgIC0gbm9kZVRyYW5zZm9ybS53aWR0aCAqICgwLjUgLSBub2RlQW5jaG9yLngpO1xyXG4gICAgY29uc3QgeSA9IGhlaWdodCAqICgwLjUgLSBjYW52YXNBbmNob3IueSlcclxuICAgICAgICAtIG5vZGVUcmFuc2Zvcm0uaGVpZ2h0ICogKDAuNSAtIG5vZGVBbmNob3IueSk7XHJcbiAgICBub2RlLnNldFBvc2l0aW9uKG5ldyBWZWMzKHgsIHksIG5vZGUucG9zaXRpb24/LnogPz8gMCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlQ29tcG9uZW50cyhub2RlOiBhbnkpOiBhbnlbXSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/LmNvbXBvbmVudHMgPz8gbm9kZT8uX2NvbXBvbmVudHM7XHJcbiAgICByZXR1cm4gQXJyYXkuaXNBcnJheSh2YWx1ZSkgPyB2YWx1ZSA6IFtdO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW9yZGVyRmlnbWFDaGlsZHJlbihwYXJlbnQ6IGFueSwgb3JkZXJlZE5vZGVzOiBhbnlbXSk6IHZvaWQge1xyXG4gICAgY29uc3QgZGVzaXJlZCA9IFsuLi5uZXcgU2V0KG9yZGVyZWROb2Rlcy5maWx0ZXIoQm9vbGVhbikpXTtcclxuICAgIGlmICghZGVzaXJlZC5sZW5ndGggfHwgdHlwZW9mIGRlc2lyZWRbMF0/LnNldFNpYmxpbmdJbmRleCAhPT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIC8vIEZpZ21hLW93bmVkIGNoaWxkcmVuIGFyZSBrZXB0IGluIEZpZ21hIG9yZGVyLiBVc2VyLWF1dGhvcmVkIGNoaWxkcmVuIGFyZVxyXG4gICAgLy8gbmV2ZXIgcmVvcmRlcmVkIGFnYWluc3Qgb25lIGFub3RoZXI7IHRoZXkgZm9sbG93IHRoZSBtYW5hZ2VkIGJsb2NrLlxyXG4gICAgZGVzaXJlZC5mb3JFYWNoKChub2RlLCBpbmRleCkgPT4gbm9kZS5zZXRTaWJsaW5nSW5kZXgoaW5kZXgpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIHByZXZpb3VzTm9kZUZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHByZXZpb3VzQ29tcG9uZW50RmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICByZXRhaW5lZE5vZGVGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBpbmRleCA9IHByZWZhYkZpbGVJZEluZGV4KHByZWZhYlJvb3QpO1xyXG4gICAgY29uc3Qgc3RhbGUgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgZm9yIChjb25zdCBmaWxlSWQgb2YgcHJldmlvdXNOb2RlRmlsZUlkcykge1xyXG4gICAgICAgIGlmIChmaWxlSWQgPT09IG5vZGVQcmVmYWJGaWxlSWQocHJlZmFiUm9vdCkgfHwgcmV0YWluZWROb2RlRmlsZUlkcy5oYXMoZmlsZUlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGluZGV4LmdldChmaWxlSWQpO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHN0YWxlLnNldChmaWxlSWQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlSWRzID0gbmV3IFNldChzdGFsZS5rZXlzKCkpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHN0YWxlLnZhbHVlcygpKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudEZpbGVJZHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICBg5b6F5Yig6Zmk55qEIEZpZ21hIOiKgueCueKAnCR7bm9kZS5uYW1lfeKAneWQq+acieaJi+W3pee7hOS7tu+8jOW3suWBnOatouWQjOatpeS7pemYsuatouaVsOaNruS4ouWkseOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc2FsdmFnZU1hbnVhbERlc2NlbmRhbnRzID0gKGNvbnRhaW5lcjogYW55LCBzdXJ2aXZvclBhcmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBjb25zdCBjaGlsZEZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoY2hpbGQpO1xyXG4gICAgICAgICAgICBpZiAoY2hpbGRGaWxlSWRcclxuICAgICAgICAgICAgICAgICYmIChwcmV2aW91c05vZGVGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkgfHwgcHJldmlvdXNIZWxwZXJGaWxlSWRzLmhhcyhjaGlsZEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMoY2hpbGQsIHN1cnZpdm9yUGFyZW50KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3QgW2ZpbGVJZCwgbm9kZV0gb2Ygc3RhbGUpIHtcclxuICAgICAgICBsZXQgYW5jZXN0b3IgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBsZXQgbmVzdGVkVW5kZXJTdGFsZSA9IGZhbHNlO1xyXG4gICAgICAgIHdoaWxlIChhbmNlc3RvciAmJiBhbmNlc3RvciAhPT0gcHJlZmFiUm9vdC5wYXJlbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgYW5jZXN0b3JGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKGFuY2VzdG9yKTtcclxuICAgICAgICAgICAgaWYgKGFuY2VzdG9yRmlsZUlkICYmIHN0YWxlSWRzLmhhcyhhbmNlc3RvckZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgIG5lc3RlZFVuZGVyU3RhbGUgPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYW5jZXN0b3IgPSBhbmNlc3Rvci5wYXJlbnQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChuZXN0ZWRVbmRlclN0YWxlIHx8ICFub2RlLnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3Vydml2b3JQYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMobm9kZSwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgc3RhbGUuZGVsZXRlKGZpbGVJZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHByZXZpb3VzOiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBTZXQ8YW55PixcclxuICAgIGdlbmVyYXRlZENsYXNzZXM6IGFueVtdLFxyXG4gICAgY2M6IGFueSxcclxuKTogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB7XHJcbiAgICBjb25zdCBwcmV2aW91c0NvbXBvbmVudHMgPSBuZXcgU2V0KHByZXZpb3VzLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzKTtcclxuICAgIGNvbnN0IHByZXZpb3VzSGVscGVycyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZEhlbHBlckZpbGVJZHMpO1xyXG4gICAgY29uc3Qgbm9kZUZpbGVJZHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGNvbnN0IG1hbmFnZWROb2RlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYXBwZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhub2RlTWFwKSk7XHJcbiAgICBjb25zdCBtYW5hZ2VkUnVudGltZU5vZGVzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCB1dWlkXSBvZiBPYmplY3QuZW50cmllcyhub2RlTWFwKSkge1xyXG4gICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5ZCM5q2l57uT5p6c57y65bCRIEZpZ21hIOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG5vZGVGaWxlSWRzW2ZpZ21hSWRdID0gZmlsZUlkO1xyXG4gICAgICAgIG1hbmFnZWROb2Rlcy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkUnVudGltZU5vZGVzLnNldChub2RlLnV1aWQsIG5vZGUpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IG1hbmFnZWRDb21wb25lbnRUeXBlcyA9IG5ldyBTZXQoW2NjLlVJVHJhbnNmb3JtLCAuLi5nZW5lcmF0ZWRDbGFzc2VzXSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgbWFuYWdlZFJ1bnRpbWVOb2Rlcy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGlmICghbWFuYWdlZENvbXBvbmVudFR5cGVzLmhhcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZ0ZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWV4aXN0aW5nRmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudHMuaGFzKGV4aXN0aW5nRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRzLmFkZChlbnN1cmVDb21wb25lbnRQcmVmYWJJbmZvKGNvbXBvbmVudCwgY2MpKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgd2Fsa05vZGVzKHByZWZhYlJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgaWYgKG1hcHBlZFV1aWRzLmhhcyhub2RlLnV1aWQpIHx8IG5vZGUgPT09IHByZWZhYlJvb3QpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXJlbnQgPSBub2RlLnBhcmVudDtcclxuICAgICAgICBpZiAoIXBhcmVudFxyXG4gICAgICAgICAgICB8fCAoIW1hcHBlZFV1aWRzLmhhcyhwYXJlbnQudXVpZCkgJiYgIW1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMuaGFzKHBhcmVudC51dWlkKSlcclxuICAgICAgICAgICAgfHwgIWlzR2VuZXJhdGVkSGVscGVyTm9kZShub2RlLCBwYXJlbnQsIGNjKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAocHJlZXhpc3RpbmdOb2RlVXVpZHMuaGFzKG5vZGUudXVpZClcclxuICAgICAgICAgICAgJiYgKCFleGlzdGluZ0ZpbGVJZCB8fCAhcHJldmlvdXNIZWxwZXJzLmhhcyhleGlzdGluZ0ZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgIGDoioLngrnigJwke3BhcmVudC5uYW1lfeKAneS4i+WtmOWcqOS4juWvvOWFpei+heWKqeiKgueCueWQjOWQjeeahOaJi+W3peiKgueCueKAnCR7bm9kZS5uYW1lfeKAne+8jOW3suWBnOatouWQjOatpeOAgmAsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZpbGVJZCA9IGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIHByZWZhYlJvb3QsIGNjKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVycy5hZGQoZmlsZUlkKTtcclxuICAgICAgICBtYW5hZ2VkSGVscGVyUnVudGltZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNvbXBvbmVudEZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICBpZiAocHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpXHJcbiAgICAgICAgICAgICAgICAmJiAoIWNvbXBvbmVudEZpbGVJZCB8fCAhcHJldmlvdXNDb21wb25lbnRzLmhhcyhjb21wb25lbnRGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudHMuYWRkKGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50LCBjYykpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgbm9kZUZpbGVJZHMsXHJcbiAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBbLi4ubWFuYWdlZE5vZGVzXSxcclxuICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogWy4uLm1hbmFnZWRDb21wb25lbnRzXSxcclxuICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogWy4uLm1hbmFnZWRIZWxwZXJzXSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlZnJlc2hQcmVmYWJMYXlvdXRzKFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIHByZWZhYlJvb3Q6IGFueSxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCB2aXNpdCA9IChzcGVjOiBTY2VuZU5vZGVTcGVjKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbc3BlYy5maWdtYUlkXTtcclxuICAgICAgICBjb25zdCBub2RlID0gdXVpZCA/IGZpbmRCeVV1aWQocHJlZmFiUm9vdCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgPyBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk/LmdldENoaWxkQnlOYW1lKCdjb250ZW50JykgPz8gbm9kZVxyXG4gICAgICAgICAgICA6IG5vZGU7XHJcbiAgICAgICAgY29uc3QgbGF5b3V0TW9kZSA9IHNwZWMubGF5b3V0Py5tb2RlO1xyXG4gICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgID8gY2hpbGRQYXJlbnQuZ2V0Q29tcG9uZW50KGNjLkxheW91dClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgaWYgKGxheW91dCkge1xyXG4gICAgICAgICAgICBhcHBseUNvdW50ZXJBbGlnbm1lbnQoY2hpbGRQYXJlbnQsIHNwZWMsIG5vZGVNYXAsIHNjYWxlLCBjYyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3JyAmJiBjaGlsZFBhcmVudCAhPT0gbm9kZSkge1xyXG4gICAgICAgICAgICBmaW5hbGl6ZVNjcm9sbChcclxuICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgY2hpbGRQYXJlbnQsXHJcbiAgICAgICAgICAgICAgICBub2RlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSksXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzcGVjLmNoaWxkcmVuLmZvckVhY2godmlzaXQpO1xyXG4gICAgfTtcclxuICAgIHNwZWNzLmZvckVhY2godmlzaXQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgIHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCxcclxuICAgIHZhbHVlOiBudW1iZXIsXHJcbiAgICBtZXNzYWdlOiBzdHJpbmcsXHJcbik6IHZvaWQge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBheWxvYWQucGFja2FnZU5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgIHZhbHVlLFxyXG4gICAgICAgICAgICBtZXNzYWdlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8g6L+b5bqm5Y+N6aaI5LiN5Y+v55So5pe25LiN5bqU5Lit5pat5Zy65pmv5a+85YWl44CCXHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkKCk6IHZvaWQge31cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7fVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHMgPSB7XHJcbiAgICBpbnNwZWN0UHJlZmFiQ29udGV4dChwYXlsb2FkOiB7XHJcbiAgICAgICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgICAgIHJvb3RGaWxlSWQ/OiBzdHJpbmc7XHJcbiAgICB9KTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiRWRpdGluZ1N0YXRlKHBheWxvYWQucHJlZmFiVXVpZCwgcGF5bG9hZC5yb290RmlsZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgaW1wb3J0RG9jdW1lbnQocGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkKTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgICAgIGNvbnN0IGNjID0gcmVxdWlyZSgnY2MnKSBhcyBhbnk7XHJcbiAgICAgICAgY29uc3Qge1xyXG4gICAgICAgICAgICBkaXJlY3RvcixcclxuICAgICAgICAgICAgTm9kZSxcclxuICAgICAgICAgICAgVUlUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgIENhbnZhcyxcclxuICAgICAgICAgICAgR3JhcGhpY3MsXHJcbiAgICAgICAgICAgIFNwcml0ZSxcclxuICAgICAgICAgICAgTGFiZWwsXHJcbiAgICAgICAgICAgIFJpY2hUZXh0LFxyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgTWFzayxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgICAgIENhbWVyYSxcclxuICAgICAgICB9ID0gY2M7XHJcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgICAgIGlmICghc2NlbmUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3msqHmnInmiZPlvIDnmoTlnLrmma/jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZmFiQ29udGV4dCA9IHBheWxvYWQucHJlZmFiQ29udGV4dDtcclxuICAgICAgICBsZXQgcHJlZmFiUm9vdDogYW55IHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBwcmVmYWJFZGl0aW5nU3RhdGUocHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkLCBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpO1xyXG4gICAgICAgICAgICBpZiAoIXN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg5bCa5pyq5a6J5YWo5omT5byA77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcHJlZmFiUm9vdCA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlLlNjZW5lLnJvb3ROb2RlO1xyXG4gICAgICAgICAgICBjb25zdCBmaWxlSWRJbmRleCA9IHByZWZhYkZpbGVJZEluZGV4KHByZWZhYlJvb3QsIHByZWZhYkNvbnRleHQucHJlZmFiVXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xyXG4gICAgICAgICAgICAgICAgX19yb290X186IHByZWZhYlJvb3QudXVpZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbZmlnbWFJZCwgZmlsZUlkXSBvZiBPYmplY3QuZW50cmllcyhwcmVmYWJDb250ZXh0LmV4aXN0aW5nTm9kZUZpbGVJZHMpKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmlsZUlkSW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nTWFwW2ZpZ21hSWRdID0gbm9kZS51dWlkO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBheWxvYWQudXBkYXRlRXhpc3RpbmcgPSB0cnVlO1xyXG4gICAgICAgICAgICBwYXlsb2FkLmV4aXN0aW5nTWFwID0gZXhpc3RpbmdNYXA7XHJcbiAgICAgICAgICAgIHBheWxvYWQuY2VudGVySW5DYW52YXMgPSBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMgPSBuZXcgU2V0PGFueT4oKTtcclxuICAgICAgICBpZiAocHJlZmFiUm9vdCkge1xyXG4gICAgICAgICAgICB3YWxrTm9kZXMocHJlZmFiUm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICAgICAgbm9kZUNvbXBvbmVudHMobm9kZSkuZm9yRWFjaCgoY29tcG9uZW50KSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJDb21wb25lbnRzLmFkZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByb290cyA9IHBheWxvYWQucm9vdHMubWFwKChyb290KSA9PiBub3JtYWxpemVTY2VuZVNwZWMocm9vdCkpO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0ICYmIHJvb3RzLmxlbmd0aCAhPT0gMSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXlj6rlhYHorrjkuIDkuKogRmlnbWEgRnJhbWUg5qC56IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrUGFyZW50ID0gcHJlZmFiUm9vdD8ucGFyZW50ID8/IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcykgPz8gc2NlbmU7XHJcbiAgICAgICAgY29uc3QgZGlyZWN0Um9vdCA9IHJvb3RzLmxlbmd0aCA9PT0gMTtcclxuICAgICAgICBjb25zdCBjYW52YXMgPSBwcmVmYWJSb290ID8gbnVsbCA6IGZpbmRDYW52YXMoc2NlbmUsIENhbnZhcyk7XHJcbiAgICAgICAgY29uc3QgZ2VuZXJhdGVkQ2xhc3NlcyA9IFtcclxuICAgICAgICAgICAgTGFiZWxPdXRsaW5lLFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExheW91dCxcclxuICAgICAgICAgICAgU2Nyb2xsVmlldyxcclxuICAgICAgICAgICAgQnV0dG9uLFxyXG4gICAgICAgICAgICBVSU9wYWNpdHksXHJcbiAgICAgICAgXTtcclxuICAgICAgICBjb25zdCBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICAgICAgbGV0IGNyZWF0ZWQgPSAwO1xyXG4gICAgICAgIGxldCB1cGRhdGVkID0gMDtcclxuICAgICAgICBjb25zdCB0b3RhbE5vZGVzID0gTWF0aC5tYXgoMSwgY291bnRTcGVjcyhyb290cykpO1xyXG4gICAgICAgIGxldCBjb21wbGV0ZWROb2RlcyA9IDA7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZENvbXBvbmVudEZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMgPSBuZXcgU2V0KHByZWZhYkNvbnRleHQ/Lm1hbmFnZWRIZWxwZXJGaWxlSWRzID8/IFtdKTtcclxuICAgICAgICBjb25zdCBwcmVmYWJPd25lcnNoaXBHdWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQgfCB1bmRlZmluZWQgPSBwcmVmYWJDb250ZXh0XHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNIZWxwZXJGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRIZWxwZXJzLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdOb2RlVXVpZHM6IHByZWV4aXN0aW5nUHJlZmFiTm9kZVV1aWRzLFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdDb21wb25lbnRzOiBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcblxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFV1aWQgPSBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nXHJcbiAgICAgICAgICAgID8gcGF5bG9hZC5leGlzdGluZ01hcC5fX3Jvb3RfX1xyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBsZXQgZXhpc3RpbmdSb290Tm9kZSA9IGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBleGlzdGluZ1Jvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKGV4aXN0aW5nUm9vdE5vZGU/LmdldENvbXBvbmVudChDYW1lcmEpKSB7XHJcbiAgICAgICAgICAgIGV4aXN0aW5nUm9vdE5vZGUgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBJbiBhIGRpcmVjdC1yb290IGltcG9ydCwgX19yb290X18gYWxpYXNlcyB0aGUgRmlnbWEgcm9vdCBVVUlELiBJbiBhXHJcbiAgICAgICAgLy8gbXVsdGktcm9vdCBpbXBvcnQgaXQgaWRlbnRpZmllcyBhIHN5bnRoZXRpYyB3cmFwcGVyIGFuZCBtdXN0IG5ldmVyIGJlXHJcbiAgICAgICAgLy8gcmV1c2VkIGFzIG9uZSBvZiBpdHMgb3duIGNoaWxkcmVuIHdoZW4gdGhlIHJvb3QgY291bnQgY2hhbmdlcy5cclxuICAgICAgICBjb25zdCBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPSBCb29sZWFuKGV4aXN0aW5nUm9vdFV1aWRcclxuICAgICAgICAgICAgJiYgT2JqZWN0LmVudHJpZXMocGF5bG9hZC5leGlzdGluZ01hcCkuc29tZSgoW2ZpZ21hSWQsIHV1aWRdKSA9PlxyXG4gICAgICAgICAgICAgICAgZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiB1dWlkID09PSBleGlzdGluZ1Jvb3RVdWlkKSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNEaXJlY3RSb290ID0gZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNXcmFwcGVyID0gIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdE5vZGUgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IG1hcHBlZFJvb3RVdWlkID0gZGlyZWN0Um9vdFxyXG4gICAgICAgICAgICA/IGV4aXN0aW5nVXVpZEZvclNwZWMocGF5bG9hZC5leGlzdGluZ01hcCwgcm9vdHNbMF0pXHJcbiAgICAgICAgICAgIDogKCFleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3RVdWlkIDogdW5kZWZpbmVkKTtcclxuICAgICAgICBsZXQgaW1wb3J0Um9vdCA9IHByZWZhYlJvb3QgPz8gKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgbWFwcGVkUm9vdFV1aWRcclxuICAgICAgICAgICAgPyBmaW5kQnlVdWlkKHNjZW5lLCBtYXBwZWRSb290VXVpZClcclxuICAgICAgICAgICAgOiBudWxsKTtcclxuICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgaW1wb3J0Um9vdD8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGxlZ2FjeVdyYXBwZXIgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gcHJldmlvdXNXcmFwcGVyID8/IChpbXBvcnRSb290Py5wYXJlbnQ/Lm5hbWUuc3RhcnRzV2l0aCgnRmlnbWEgwrcgJylcclxuICAgICAgICAgICAgICAgID8gaW1wb3J0Um9vdC5wYXJlbnRcclxuICAgICAgICAgICAgICAgIDogbnVsbClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IHJldXNlZEltcG9ydFJvb3QgPSBCb29sZWFuKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IGZhbGxiYWNrUGFyZW50O1xyXG4gICAgICAgIGlmICghZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFJvb3QpIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShgRmlnbWEgwrcgJHtjbGVhbk5hbWUocGF5bG9hZC5yb290TmFtZSl9YCk7XHJcbiAgICAgICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgICAgICAgICBjcmVhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnBhcmVudCA9IHBhcmVudDtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QubmFtZSA9IGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gO1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm0gPSBpbXBvcnRSb290LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gaW1wb3J0Um9vdC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLndpZHRoICogcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHBheWxvYWQucm9vdEZyYW1lLmhlaWdodCAqIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3Quc2V0UG9zaXRpb24oMCwgMCwgMCk7XHJcbiAgICAgICAgICAgIG5vZGVNYXAuX19yb290X18gPSBpbXBvcnRSb290LnV1aWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghaW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbmV3IE5vZGUoY2xlYW5OYW1lKHJvb3RzWzBdLm5hbWUpKTtcclxuICAgICAgICAgICAgcGFyZW50LmFkZENoaWxkKGltcG9ydFJvb3QpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgLy8gQSBjb2xsYXBzZWQgU2NlbmVTcGVjIGNhbiBpbnRlbnRpb25hbGx5IG1hcCBzZXZlcmFsIEZpZ21hIElEcyB0byBhXHJcbiAgICAgICAgLy8gc2luZ2xlIENvY29zIG5vZGUuIElmIGEgbGF0ZXIgaW1wb3J0IGV4cGFuZHMgdGhhdCBzdWJ0cmVlIGFnYWluLFxyXG4gICAgICAgIC8vIHRob3NlIElEcyBzdGlsbCBwb2ludCBhdCB0aGUgc2FtZSBvbGQgVVVJRC4gQ2xhaW0gZWFjaCByZXVzYWJsZSBub2RlXHJcbiAgICAgICAgLy8gb25jZSBwZXIgYnVpbGQgc28gYSBjaGlsZCBjYW4gbmV2ZXIgcmV1c2UgKGFuZCByZXBhcmVudCkgaXRzIHBhcmVudC5cclxuICAgICAgICBjb25zdCBjbGFpbWVkTm9kZVV1aWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgYnVpbGQgPSBhc3luYyAoXHJcbiAgICAgICAgICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICAgICAgICAgIG5vZGVQYXJlbnQ6IGFueSxcclxuICAgICAgICAgICAgcHJvdmlkZWROb2RlPzogYW55LFxyXG4gICAgICAgICk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgICAgICBsZXQgbm9kZSA9IHByb3ZpZGVkTm9kZSA/PyBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUgJiYgcGF5bG9hZC51cGRhdGVFeGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZFV1aWQgPSBwYXlsb2FkLmV4aXN0aW5nTWFwW2ZpZ21hSWRdO1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hcHBlZE5vZGUgPSBtYXBwZWRVdWlkID8gZmluZEJ5VXVpZChzY2VuZSwgbWFwcGVkVXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXBwZWROb2RlICYmICFjbGFpbWVkTm9kZVV1aWRzLmhhcyhtYXBwZWROb2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUgPSBtYXBwZWROb2RlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgY2xhaW1lZE5vZGVVdWlkcy5oYXMobm9kZS51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG51bGw7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZXhpc3RlZCA9IEJvb2xlYW4obm9kZSk7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZSA9IG5ldyBOb2RlKGNsZWFuTmFtZShzcGVjLm5hbWUpKTtcclxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocHJlZmFiT3duZXJzaGlwR3VhcmQgJiYgZXhpc3RlZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdUcmFuc2Zvcm0pIHtcclxuICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdUcmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiAhPT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGhlbHBlciBvZiBub2RlLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQ6IGFueSkgPT5cclxuICAgICAgICAgICAgICAgICAgICAgICAgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYylcclxuICAgICAgICAgICAgICAgICAgICAgICAgfHwgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGNoaWxkLm5hbWUgPT09ICd2aWV3JykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShoZWxwZXIsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGhlbHBlci5uYW1lID09PSAndmlldycpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSBoZWxwZXIuZ2V0Q2hpbGRCeU5hbWU/LignY29udGVudCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUoY29udGVudCwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChoZWxwZXIubmFtZSA9PT0gVElMRURfTUFTS19OT0RFX05BTUUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHRpbGVkU3ByaXRlID0gaGVscGVyLmdldENoaWxkQnlOYW1lPy4oVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUodGlsZWRTcHJpdGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZ2VuZXJhdGVkQ2xhc3Nlcy5pbmNsdWRlcyhjb21wb25lbnQuY29uc3RydWN0b3IpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnRPd25lZEdlbmVyYXRlZENvbXBvbmVudChcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21wb25lbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjbGFpbWVkTm9kZVV1aWRzLmFkZChub2RlLnV1aWQpO1xyXG4gICAgICAgICAgICBpZiAoIShwcmVmYWJDb250ZXh0ICYmIG5vZGUgPT09IHByZWZhYlJvb3QpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlLnBhcmVudCA9IG5vZGVQYXJlbnQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm9kZS5uYW1lID0gY2xlYW5OYW1lKHNwZWMubmFtZSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIG5vZGVNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uZmlndXJlR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG5cclxuICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uICE9PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlT2Jzb2xldGVTY3JvbGxIZWxwZXJzKG5vZGUsIHNwZWMsIGNjLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZW1vdmVPYnNvbGV0ZUxhYmVsT3V0bGluZShub2RlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwcmVzZXJ2ZWQgPSBkZXNpcmVkR2VuZXJhdGVkQ29tcG9uZW50cyhzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAvLyBNYXNrIG93bnMgYW5kIGRpc2FibGVzIGl0cyBzaGFyZWQgR3JhcGhpY3MgZHVyaW5nIHRoZVxyXG4gICAgICAgICAgICAgICAgLy8gZGVmZXJyZWQgb25EaXNhYmxlIHBoYXNlLiBJZiBjbGlwcGluZyB3YXMgcmVtb3ZlZCBidXQgYVxyXG4gICAgICAgICAgICAgICAgLy8gbm9ybWFsIEdyYXBoaWNzIHJlbmRlcmVyIGlzIHN0aWxsIGRlc2lyZWQsIHJlY3JlYXRlIHRoYXRcclxuICAgICAgICAgICAgICAgIC8vIHJlbmRlcmVyIG9ubHkgYWZ0ZXIgdGhlIG9sZCBNYXNrIGxpZmVjeWNsZSBoYXMgY29tcGxldGVkLlxyXG4gICAgICAgICAgICAgICAgaWYgKCFwcmVzZXJ2ZWQuaGFzKE1hc2spXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgbm9kZS5nZXRDb21wb25lbnQoTWFzaylcclxuICAgICAgICAgICAgICAgICAgICAmJiBwcmVzZXJ2ZWQuaGFzKEdyYXBoaWNzKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZC5kZWxldGUoR3JhcGhpY3MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3ZlZFJlbmRlckNvbXBvbmVudCA9IHJlbW92ZUdlbmVyYXRlZENvbXBvbmVudHMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBnZW5lcmF0ZWRDbGFzc2VzLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZXNlcnZlZCxcclxuICAgICAgICAgICAgICAgICAgICBbR3JhcGhpY3MsIFNwcml0ZSwgTGFiZWwsIFJpY2hUZXh0XSxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0ID8gcHJldmlvdXNNYW5hZ2VkQ29tcG9uZW50cyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmVtb3ZlZFJlbmRlckNvbXBvbmVudCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JEZWZlcnJlZENvbXBvbmVudFJlbW92YWwoKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdGlsZWRTcHJpdGVIZWxwZXIgPSB1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYyk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRpbGVkU3ByaXRlSGVscGVyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkVGlsZWROb2Rlcyhub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjbGlwc0NoaWxkcmVuID0gY2xpcHNHZW5lcmF0ZWRDaGlsZHJlbihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ3JlbmRlcicgfHwgc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIXNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUE5HIOaVtOWxguiKgueCueKAnCR7c3BlYy5uYW1lfeKAneayoeaciee7keWumiBTcHJpdGVGcmFtZe+8jOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBpZiAodGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBheWxvYWQuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdyaWNoVGV4dCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVSaWNoVGV4dChub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmljaFRleHQgPSBub2RlLmdldENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMuZm9udFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2MuVFRGRm9udCAmJiAhKGZvbnQgaW5zdGFuY2VvZiBjYy5UVEZGb250KSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGBSaWNoVGV4dCDoioLngrnigJwke3NwZWMubmFtZX3igJ3lj6rog73kvb/nlKggVFRGL09URiDlrZfkvZPvvIzlvZPliY3mmKDlsITlj6/og73mmK8gQml0bWFwRm9udO+8iC5mbnTvvInjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gZm9udDtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByaWNoVGV4dC5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZmluYWxpemVMYWJlbEdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVMYWJlbChub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHNwZWMuZm9udFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsLmZvbnQgPSBhd2FpdCBsb2FkQXNzZXQoY2MuYXNzZXRNYW5hZ2VyLCBzcGVjLmZvbnRVdWlkKTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlLmdldENvbXBvbmVudChMYWJlbCkuZm9udCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGZpbmFsaXplTGFiZWxHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKFJBU1RFUl9WRUNUT1JfVFlQRVMuaGFzKHNwZWMuZmlnbWFUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55+i6YeP6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yMUE5HIOi1hOa6kOWPr+iDveacquaIkOWKn+WvvOWFpeOAgmApO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlQ2xpcChub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGhhc0dyYXBoaWNzVmlzdWFsKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uZmlndXJlR3JhcGhpY3Mobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlT3BhY2l0eShub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVCdXR0b24obm9kZSwgc3BlYywgY2MpO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkUGFyZW50ID0gc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nXHJcbiAgICAgICAgICAgICAgICA/IG5vZGVcclxuICAgICAgICAgICAgICAgIDogY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYyxcclxuICAgICAgICAgICAgICAgICAgICB0cmFuc2Zvcm0sXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlTGF5b3V0KGNoaWxkUGFyZW50LCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBidWlsZChjaGlsZCwgY2hpbGRQYXJlbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICByZW9yZGVyRmlnbWFDaGlsZHJlbihcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGQuZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB1dWlkID8gZmluZEJ5VXVpZChjaGlsZFBhcmVudCwgdXVpZCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dCA9IHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnICYmIGxheW91dE1vZGUgJiYgbGF5b3V0TW9kZSAhPT0gJ05PTkUnXHJcbiAgICAgICAgICAgICAgICA/IGNoaWxkUGFyZW50LmdldENvbXBvbmVudChMYXlvdXQpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGxheW91dD8udXBkYXRlTGF5b3V0KCk7XHJcbiAgICAgICAgICAgIGlmIChsYXlvdXQpIHtcclxuICAgICAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKG5vZGUsIHNwZWMsIGNoaWxkUGFyZW50LCB0cmFuc2Zvcm0sIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGVkICYmIHNwZWMuYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lICs9ICcgwrcgVHJhbnNmb3JtJztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZWROb2RlcyArPSAxO1xyXG4gICAgICAgICAgICBlbWl0U2NlbmVQcm9ncmVzcyhcclxuICAgICAgICAgICAgICAgIHBheWxvYWQsXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZWROb2RlcyAvIHRvdGFsTm9kZXMsXHJcbiAgICAgICAgICAgICAgICBg5p6E5bu66IqC54K5ICR7Y29tcGxldGVkTm9kZXN9LyR7dG90YWxOb2Rlc30gwrcgJHtzcGVjLm5hbWV9YCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygcm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKHJvb3QsIGRpcmVjdFJvb3QgPyBwYXJlbnQgOiBpbXBvcnRSb290LCBkaXJlY3RSb290ID8gaW1wb3J0Um9vdCA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHBheWxvYWQudXBkYXRlRXhpc3RpbmcgJiYgIXByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5leGlzdGluZ01hcCxcclxuICAgICAgICAgICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGlyZWN0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNlbnRlckluQ2FudmFzICYmIGNhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNlbnRlckluQ2FudmFzKGltcG9ydFJvb3QsIGNhbnZhcywgVUlUcmFuc2Zvcm0sIGNjLlZlYzMpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkVXVpZHMgPSBuZXcgU2V0KE9iamVjdC52YWx1ZXMobm9kZU1hcCkpO1xyXG4gICAgICAgICAgICBjb25zdCBzdGFsZVRyYW5zaXRpb25VdWlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKVxyXG4gICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKFtmaWdtYUlkLCB1dWlkXSkgPT4gZmlnbWFJZCAhPT0gJ19fcm9vdF9fJyAmJiAhcmV0YWluZWRVdWlkcy5oYXModXVpZCkpXHJcbiAgICAgICAgICAgICAgICAgICAgLm1hcCgoWywgdXVpZF0pID0+IHV1aWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgbGVnYWN5V3JhcHBlciAmJiBsZWdhY3lXcmFwcGVyICE9PSBpbXBvcnRSb290ICYmIGxlZ2FjeVdyYXBwZXIucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShsZWdhY3lXcmFwcGVyLCBwYXJlbnQsIHN0YWxlVHJhbnNpdGlvblV1aWRzLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0ICYmIHByZXZpb3VzRGlyZWN0Um9vdFxyXG4gICAgICAgICAgICAgICAgJiYgcHJldmlvdXNEaXJlY3RSb290ICE9PSBpbXBvcnRSb290XHJcbiAgICAgICAgICAgICAgICAmJiAhcmV0YWluZWRVdWlkcy5oYXMocHJldmlvdXNEaXJlY3RSb290LnV1aWQpXHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QucGFyZW50KSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVNYXBwZWROb2RlVHJlZShcclxuICAgICAgICAgICAgICAgICAgICBwcmV2aW91c0RpcmVjdFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICAgICAgc3RhbGVUcmFuc2l0aW9uVXVpZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VQcmVzZXJ2ZWRNYXBwaW5ncyhpbXBvcnRSb290LCBwYXlsb2FkLmV4aXN0aW5nTWFwLCBub2RlTWFwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGlmICghcmV1c2VkSW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXJlbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldChPYmplY3QudmFsdWVzKHBheWxvYWQuZXhpc3RpbmdNYXApKSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgcHJlZmFiU3luYzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXRhaW5lZE5vZGVGaWxlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlnbWFJZCA9PT0gJ19fcm9vdF9fJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWumuS9jeWvvOWFpeWQjueahOiKgueCue+8miR7ZmlnbWFJZH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldGFpbmVkTm9kZUZpbGVJZHMuYWRkKGVuc3VyZU5vZGVQcmVmYWJJbmZvKG5vZGUsIGltcG9ydFJvb3QsIGNjKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVtb3ZlU3RhbGVQcmVmYWJOb2RlcyhcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QsXHJcbiAgICAgICAgICAgICAgICBuZXcgU2V0KHByZWZhYkNvbnRleHQubWFuYWdlZE5vZGVGaWxlSWRzKSxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzLFxyXG4gICAgICAgICAgICAgICAgcmV0YWluZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgcmVmcmVzaFByZWZhYkxheW91dHMocm9vdHMsIGltcG9ydFJvb3QsIG5vZGVNYXAsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgcHJlZmFiU3luYyA9IGNhcHR1cmVQcmVmYWJTeW5jKFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJDb250ZXh0LFxyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBbVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChub2RlUHJlZmFiRmlsZUlkKGltcG9ydFJvb3QpICE9PSBwcmVmYWJDb250ZXh0LnJvb3RGaWxlSWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5Zyo5ZCM5q2l6L+H56iL5Lit5Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgcm9vdFV1aWQ6IGltcG9ydFJvb3QudXVpZCxcclxuICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgY3JlYXRlZCxcclxuICAgICAgICAgICAgdXBkYXRlZCxcclxuICAgICAgICAgICAgdGVtcG9yYXJ5Um9vdDogIXByZWZhYkNvbnRleHQgJiYgZGlyZWN0Um9vdCAmJiAhcmV1c2VkSW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgcHJlZmFiU3luYyxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxuXHJcbiAgICByZW1vdmVJbXBvcnRlZE5vZGUocGF5bG9hZDogeyByb290VXVpZDogc3RyaW5nIH0pOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBjYyA9IHJlcXVpcmUoJ2NjJykgYXMgYW55O1xyXG4gICAgICAgIGNvbnN0IHNjZW5lID0gY2MuZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgICAgICBjb25zdCBub2RlID0gc2NlbmUgPyBmaW5kQnlVdWlkKHNjZW5lLCBwYXlsb2FkLnJvb3RVdWlkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gU3RvcCByZW5kZXJpbmcgaW1tZWRpYXRlbHkuIENvY29zIGRlc3Ryb3lzIG5vZGVzIGF0IHRoZSBlbmQgb2YgdGhlXHJcbiAgICAgICAgLy8gZnJhbWUsIHNvIHJlbW92aW5nIHRoZSBwYXJlbnQgYWxvbmUgY2FuIGxlYXZlIGEgb25lLWZyYW1lIGdob3N0LlxyXG4gICAgICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9LFxyXG59O1xyXG4iXX0=