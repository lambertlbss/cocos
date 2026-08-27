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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBNmtEQSxvQkFBK0I7QUFFL0Isd0JBQWlDO0FBL2tEakMsK0JBQTRCO0FBQzVCLHFEQUkwQjtBQVUxQiwyQ0FBK0M7QUFFL0MsTUFBTSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztBQXlCekQsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQztBQUNqRCxNQUFNLG9CQUFvQixHQUFHLGtCQUFrQixDQUFDO0FBQ2hELE1BQU0sc0JBQXNCLEdBQUcsb0JBQW9CLENBQUM7QUFDcEQsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNoQyxRQUFRO0lBQ1IsbUJBQW1CO0lBQ25CLE1BQU07SUFDTixNQUFNO0lBQ04saUJBQWlCO0NBQ3BCLENBQUMsQ0FBQztBQUVILFNBQVMsU0FBUyxDQUFDLEtBQWE7O0lBQzVCLE9BQU8sTUFBQSxJQUFBLDRCQUFnQixFQUFDLEtBQUssQ0FBQyxtQ0FBSSxZQUFZLENBQUM7QUFDbkQsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLEtBQVUsRUFBRSxLQUE2QixFQUFFLE9BQU8sR0FBRyxDQUFDOztJQUNuRSxNQUFNLE1BQU0sR0FBRyxLQUFLLGFBQUwsS0FBSyxjQUFMLEtBQUssR0FBSSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUNuRCxPQUFPLElBQUksS0FBSyxDQUNaLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFD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RyxFQUFFLENBQUM7SUFDNUIsTUFBTSxNQUFNLEdBQUcsTUFBQSxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxtQ0FBSSxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3RFLE1BQU0sQ0FBQyxJQUFJLEdBQUcsSUFBSSxLQUFLLFlBQVk7UUFDL0IsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVTtRQUN4QixDQUFDLENBQUMsSUFBSSxLQUFLLFVBQVU7WUFDakIsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUTtZQUN0QixDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDM0IsSUFBSSxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7UUFDbEIsTUFBTSxDQUFDLFNBQVMsR0FBRyxDQUFBLE1BQUEsSUFBSSxDQUFDLE1BQU0sMENBQUUsVUFBVSxNQUFLLFVBQVU7WUFDckQsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxhQUFhLENBQUMsUUFBUTtZQUMvQixDQUFDLENBQUMsTUFBTSxDQUFDLGFBQWEsQ0FBQyxVQUFVLENBQUM7SUFDMUMsQ0FBQztJQUNELE1BQU0sQ0FBQyxVQUFVLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7SUFDM0MsTUFBTSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsTUFBTyxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUM7SUFDdEQsTUFBTSxDQUFDLFlBQVksR0FBRyxJQUFJLENBQUMsTUFBTyxDQUFDLFlBQVksR0FBRyxLQUFLLENBQUM7SUFDeEQsTUFBTSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUMsTUFBTyxDQUFDLFVBQVUsR0FBRyxLQUFLLENBQUM7SUFDcEQsTUFBTSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUMsTUFBTyxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUM7SUFDMUQsTUFBTSxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsTUFBTyxDQUFDLFdBQVcsR0FBRyxLQUFLLENBQUM7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QWdCLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDZixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0NBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBGaWdtYUNvbG9yLFxyXG4gICAgRmlnbWFQYWludCxcclxuICAgIFByZWZhYkVkaXRpbmdTdGF0ZSxcclxuICAgIFByZWZhYlNjZW5lU3luY0NhcHR1cmUsXHJcbiAgICBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgUmVjdCxcclxuICAgIFNjZW5lTm9kZVNwZWMsXHJcbn0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuL25vZGUtbmFtZSc7XHJcblxyXG5tb2R1bGUucGF0aHMucHVzaChqb2luKEVkaXRvci5BcHAucGF0aCwgJ25vZGVfbW9kdWxlcycpKTtcclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxufVxyXG5cclxuY29uc3QgQkFDS0dST1VORF9OT0RFX05BTUUgPSAnX19GaWdtYUJhY2tncm91bmQnO1xyXG5jb25zdCBUSUxFRF9NQVNLX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRNYXNrJztcclxuY29uc3QgVElMRURfU1BSSVRFX05PREVfTkFNRSA9ICdfX0ZpZ21hVGlsZWRTcHJpdGUnO1xyXG5jb25zdCBSQVNURVJfVkVDVE9SX1RZUEVTID0gbmV3IFNldChbXHJcbiAgICAnVkVDVE9SJyxcclxuICAgICdCT09MRUFOX09QRVJBVElPTicsXHJcbiAgICAnU1RBUicsXHJcbiAgICAnTElORScsXHJcbiAgICAnUkVHVUxBUl9QT0xZR09OJyxcclxuXSk7XHJcblxyXG5mdW5jdGlvbiBjbGVhbk5hbWUoaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc2FuaXRpemVOb2RlTmFtZShpbnB1dCkgPz8gJ0ZpZ21hIE5vZGUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b0NvbG9yKENvbG9yOiBhbnksIHZhbHVlOiBGaWdtYUNvbG9yIHwgdW5kZWZpbmVkLCBvcGFjaXR5ID0gMSk6IGFueSB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSB2YWx1ZSA/PyB7IHI6IDAsIGc6IDAsIGI6IDAsIGE6IDEgfTtcclxuICAgIHJldHVybiBuZXcgQ29sb3IoXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzb3VyY2UucikpICogMjU1KSxcclxuICAgICAgICBNYXRoLnJvdW5kKE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHNvdXJjZS5nKSkgKiAyNTUpLFxyXG4gICAgICAgIE1hdGgucm91bmQoTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgc291cmNlLmIpKSAqIDI1NSksXHJcbiAgICAgICAgTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAoc291cmNlLmEgPz8gMSkgKiBvcGFjaXR5KSkgKiAyNTUpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZEJ5VXVpZChyb290OiBhbnksIHV1aWQ6IHN0cmluZyk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QudXVpZCA9PT0gdXVpZCkge1xyXG4gICAgICAgIHJldHVybiByb290O1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiByb290LmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBmaW5kQnlVdWlkKGNoaWxkLCB1dWlkKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlUHJlZmFiRmlsZUlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IG5vZGU/Ll9wcmVmYWI/LmZpbGVJZDtcclxuICAgIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyB2YWx1ZSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudDogYW55KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IHZhbHVlID0gY29tcG9uZW50Py5fX3ByZWZhYj8uZmlsZUlkO1xyXG4gICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUubGVuZ3RoID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YWxrTm9kZXMocm9vdDogYW55LCB2aXNpdDogKG5vZGU6IGFueSkgPT4gdm9pZCk6IHZvaWQge1xyXG4gICAgdmlzaXQocm9vdCk7XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHJvb3QuY2hpbGRyZW4gPz8gW10pIHtcclxuICAgICAgICB3YWxrTm9kZXMoY2hpbGQsIHZpc2l0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiQXNzZXRVdWlkKG5vZGU6IGFueSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBhc3NldCA9IG5vZGU/Ll9wcmVmYWI/LmFzc2V0O1xyXG4gICAgY29uc3QgdmFsdWUgPSBhc3NldD8uX3V1aWQgPz8gYXNzZXQ/LnV1aWQ7XHJcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkZpbGVJZEluZGV4KHJvb3Q6IGFueSwgZXhwZWN0ZWRQcmVmYWJVdWlkPzogc3RyaW5nKTogTWFwPHN0cmluZywgYW55PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgY29uc3QgY29tcG9uZW50RmlsZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgd2Fsa05vZGVzKHJvb3QsIChub2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcHJlZmFiUm9vdCA9IG5vZGU/Ll9wcmVmYWI/LnJvb3Q7XHJcbiAgICAgICAgaWYgKG5vZGUgIT09IHJvb3QgJiYgcHJlZmFiUm9vdCAmJiBwcmVmYWJSb290ICE9PSByb290KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYXNzZXRVdWlkID0gcHJlZmFiQXNzZXRVdWlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChleHBlY3RlZFByZWZhYlV1aWQgJiYgYXNzZXRVdWlkICYmIGFzc2V0VXVpZCAhPT0gZXhwZWN0ZWRQcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgICAgICBpZiAoIWZpbGVJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChyZXN1bHQuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN6IqC54K5IGZpbGVJZO+8miR7ZmlsZUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHQuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZS5jb21wb25lbnRzID8/IG5vZGUuX2NvbXBvbmVudHMgPz8gW10pIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmICghY29tcG9uZW50RmlsZUlkKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoY29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5YaF5a2Y5Zyo6YeN5aSN57uE5Lu2IGZpbGVJZO+8miR7Y29tcG9uZW50RmlsZUlkfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbXBvbmVudEZpbGVJZHMuYWRkKGNvbXBvbmVudEZpbGVJZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJFZGl0aW5nU3RhdGUoXHJcbiAgICBleHBlY3RlZFV1aWQ6IHN0cmluZyxcclxuICAgIGV4cGVjdGVkUm9vdEZpbGVJZD86IHN0cmluZyxcclxuKTogUHJlZmFiRWRpdGluZ1N0YXRlIHtcclxuICAgIGNvbnN0IGNjZUFwaSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgY29uc3QgbW9kZSA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlNb2RlPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCBjdXJyZW50VXVpZCA9IFN0cmluZyhjY2VBcGk/LlNjZW5lRmFjYWRlTWFuYWdlcj8ucXVlcnlDdXJyZW50U2NlbmVVdWlkPy4oKSA/PyAnJyk7XHJcbiAgICBjb25zdCByb290ID0gY2NlQXBpPy5TY2VuZT8ucm9vdE5vZGUgPz8gbnVsbDtcclxuICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKHJvb3QpO1xyXG4gICAgbGV0IHJlYXNvbiA9ICcnO1xyXG4gICAgaWYgKG1vZGUgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjee8lui+keaooeW8j+S4uiAke21vZGUgfHwgJ3Vua25vd24nfe+8jOWwmuacqui/m+WFpSBQcmVmYWJgO1xyXG4gICAgfSBlbHNlIGlmIChjdXJyZW50VXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgcmVhc29uID0gYOW9k+WJjei1hOa6kCBVVUlEIOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie0YDtcclxuICAgIH0gZWxzZSBpZiAoIXJvb3QpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCueWwmuacquWwsee7qic7XHJcbiAgICB9IGVsc2UgaWYgKGV4cGVjdGVkUm9vdEZpbGVJZCAmJiByb290RmlsZUlkICE9PSBleHBlY3RlZFJvb3RGaWxlSWQpIHtcclxuICAgICAgICByZWFzb24gPSAnUHJlZmFiIOagueiKgueCuSBmaWxlSWQg5LiO5p2l5rqQ6K6w5b2V5LiN5LiA6Ie0JztcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgcmVhZHk6ICFyZWFzb24sXHJcbiAgICAgICAgbW9kZSxcclxuICAgICAgICBjdXJyZW50VXVpZCxcclxuICAgICAgICByb290VXVpZDogcm9vdD8udXVpZCxcclxuICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgIHJlYXNvbjogcmVhc29uIHx8IHVuZGVmaW5lZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLkVkaXRvcj8uVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDApIHtcclxuICAgICAgICByZXR1cm4gZ2VuZXJhdGVkO1xyXG4gICAgfVxyXG4gICAgLy8gVW5pdC10ZXN0L2hlYWRsZXNzIGZhbGxiYWNrLiBUaGUgcmVhbCBDcmVhdG9yIHNjZW5lIHByb2Nlc3MgYWx3YXlzIHVzZXNcclxuICAgIC8vIEVkaXRvci5VdGlscy5VVUlELmdlbmVyYXRlKHRydWUpLCBzbyBwcm9kdWN0aW9uIElEcyBmb2xsb3cgQ3JlYXRvcidzIG93biBmb3JtYXQuXHJcbiAgICByZXR1cm4gYGZpZ21hJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDE0KX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlOiBhbnksIHByZWZhYlJvb3Q6IGFueSwgY2M6IGFueSk6IHN0cmluZyB7XHJcbiAgICBsZXQgZmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChub2RlKTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2NlQXBpID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBjY2VBcGk/LlByZWZhYj8ub25BZGROb2RlPy4obm9kZSk7XHJcbiAgICBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBQcmVmYWJJbmZvID0gY2MuUHJlZmFiPy5fdXRpbHM/LlByZWZhYkluZm8gPz8gY2MuUHJlZmFiSW5mbztcclxuICAgIGlmICghUHJlZmFiSW5mbykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQ29jb3MgMy44LjcgUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw6IqC54K555Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBQcmVmYWJJbmZvKCk7XHJcbiAgICBpbmZvLnJvb3QgPSBwcmVmYWJSb290O1xyXG4gICAgaW5mby5hc3NldCA9IHByZWZhYlJvb3Q/Ll9wcmVmYWI/LmFzc2V0ID8/IG51bGw7XHJcbiAgICBpbmZvLmZpbGVJZCA9IGdlbmVyYXRlUHJlZmFiRmlsZUlkKCk7XHJcbiAgICBpbmZvLmluc3RhbmNlID0gbnVsbDtcclxuICAgIGluZm8udGFyZ2V0T3ZlcnJpZGVzID0gbnVsbDtcclxuICAgIG5vZGUuX3ByZWZhYiA9IGluZm87XHJcbiAgICByZXR1cm4gaW5mby5maWxlSWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50OiBhbnksIGNjOiBhbnkpOiBzdHJpbmcge1xyXG4gICAgbGV0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgaWYgKGZpbGVJZCkge1xyXG4gICAgICAgIHJldHVybiBmaWxlSWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjY2VBcGkgPSAoZ2xvYmFsVGhpcyBhcyBhbnkpLmNjZTtcclxuICAgIGNjZUFwaT8uUHJlZmFiPy5vbkFkZENvbXBvbmVudD8uKGNvbXBvbmVudCk7XHJcbiAgICBmaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgIGlmIChmaWxlSWQpIHtcclxuICAgICAgICByZXR1cm4gZmlsZUlkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgQ29tcFByZWZhYkluZm8gPSBjYy5QcmVmYWI/Ll91dGlscz8uQ29tcFByZWZhYkluZm8gPz8gY2MuQ29tcFByZWZhYkluZm87XHJcbiAgICBpZiAoIUNvbXBQcmVmYWJJbmZvKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb2NvcyAzLjguNyBDb21wUHJlZmFiSW5mbyBBUEkg5LiN5Y+v55So77yM5peg5rOV5Li65paw57uE5Lu255Sf5oiQ56iz5a6aIGZpbGVJZOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IG5ldyBDb21wUHJlZmFiSW5mbygpO1xyXG4gICAgaW5mby5maWxlSWQgPSBnZW5lcmF0ZVByZWZhYkZpbGVJZCgpO1xyXG4gICAgY29tcG9uZW50Ll9fcHJlZmFiID0gaW5mbztcclxuICAgIHJldHVybiBpbmZvLmZpbGVJZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0UGFyZW50S2VlcGluZ1dvcmxkKG5vZGU6IGFueSwgcGFyZW50OiBhbnkpOiB2b2lkIHtcclxuICAgIGlmICh0eXBlb2Ygbm9kZS5zZXRQYXJlbnQgPT09ICdmdW5jdGlvbicpIHtcclxuICAgICAgICBub2RlLnNldFBhcmVudChwYXJlbnQsIHRydWUpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBub2RlLnBhcmVudCA9IHBhcmVudDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkOiBhbnksIHBhcmVudDogYW55LCBjYzogYW55KTogYm9vbGVhbiB7XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gQkFDS0dST1VORF9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSBUSUxFRF9NQVNLX05PREVfTkFNRVxyXG4gICAgICAgIHx8IGNoaWxkLm5hbWUgPT09IFRJTEVEX1NQUklURV9OT0RFX05BTUVcclxuICAgICAgICB8fCBjaGlsZC5uYW1lID09PSAnX19GaWdtYUNvbnRlbnQnKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBpZiAoY2hpbGQubmFtZSA9PT0gJ3ZpZXcnICYmIHBhcmVudC5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGNoaWxkLm5hbWUgPT09ICdjb250ZW50J1xyXG4gICAgICAgICYmIHBhcmVudC5uYW1lID09PSAndmlldydcclxuICAgICAgICAmJiBwYXJlbnQucGFyZW50Py5nZXRDb21wb25lbnQ/LihjYy5TY3JvbGxWaWV3KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlTWFwcGVkTm9kZVRyZWUoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzdXJ2aXZvclBhcmVudDogYW55LFxyXG4gICAgc3RhbGVVdWlkczogU2V0PHN0cmluZz4sXHJcbiAgICBjYzogYW55LFxyXG4pOiBudW1iZXIge1xyXG4gICAgbGV0IHJlbW92ZWQgPSAxO1xyXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubm9kZS5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoc3RhbGVVdWlkcy5oYXMoY2hpbGQudXVpZCkgfHwgaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKGNoaWxkLCBub2RlLCBjYykpIHtcclxuICAgICAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShjaGlsZCwgc3Vydml2b3JQYXJlbnQsIHN0YWxlVXVpZHMsIGNjKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHN1cnZpdm9yUGFyZW50KSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIG5vZGUuYWN0aXZlID0gZmFsc2U7XHJcbiAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZVNjZW5lU3BlYyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogU2NlbmVOb2RlU3BlYyB7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBub3JtYWxpemVJbXBvcnRBY3Rpb24oc3BlYy5hY3Rpb24gYXMgdW5rbm93bik7XHJcbiAgICBjb25zdCBraW5kID0ga2luZEZvckltcG9ydEFjdGlvbihzcGVjLmtpbmQsIGFjdGlvbik7XHJcbiAgICBjb25zdCBjaGlsZHJlbiA9IEFycmF5LmlzQXJyYXkoc3BlYy5jaGlsZHJlbikgPyBzcGVjLmNoaWxkcmVuIDogW107XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLnNwZWMsXHJcbiAgICAgICAgYWN0aW9uLFxyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgY2hpbGRyZW46IGlzVGVybWluYWxBY3Rpb24oYWN0aW9uKSB8fCBzcGVjLmZsYXR0ZW5Cb3VuZGFyeSA9PT0gdHJ1ZVxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gbm9ybWFsaXplU2NlbmVTcGVjKGNoaWxkKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaWdtYUlkc0ZvclNwZWMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHN0cmluZ1tdIHtcclxuICAgIGNvbnN0IGlkcyA9IFtzcGVjLmZpZ21hSWQsIC4uLihzcGVjLmFsaWFzRmlnbWFJZHMgPz8gW10pXVxyXG4gICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCAmJiBpZCAhPT0gJ19fcm9vdF9fJyk7XHJcbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoaWRzKV07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFsaWFzRmlnbWFJZHNGb3JTcGVjKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBzdHJpbmdbXSB7XHJcbiAgICByZXR1cm4gZmlnbWFJZHNGb3JTcGVjKHNwZWMpLmZpbHRlcigoZmlnbWFJZCkgPT4gZmlnbWFJZCAhPT0gc3BlYy5maWdtYUlkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXhpc3RpbmdVdWlkRm9yU3BlYyhcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3QgZmlnbWFJZCBvZiBmaWdtYUlkc0ZvclNwZWMoc3BlYykpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gZXhpc3RpbmdNYXBbZmlnbWFJZF07XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbnNEZXNjZW5kYW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICBpZiAodHlwZW9mIHNwZWMuZmxhdHRlbkJvdW5kYXJ5ID09PSAnYm9vbGVhbicpIHtcclxuICAgICAgICByZXR1cm4gc3BlYy5mbGF0dGVuQm91bmRhcnk7XHJcbiAgICB9XHJcbiAgICAvLyBCYWNrd2FyZCBjb21wYXRpYmlsaXR5IGZvciBTY2VuZVNwZWNzIHBlcnNpc3RlZCBieSBpbXBvcnRlciB2ZXJzaW9uc1xyXG4gICAgLy8gYmVmb3JlIGZsYXR0ZW5Cb3VuZGFyeSB3YXMgaW50cm9kdWNlZC4gTmV3IHBsYW5zIGFsd2F5cyBzZXQgdGhlIGZsYWcgc29cclxuICAgIC8vIGZvbGRlZCBMYWJlbHMgYW5kIG90aGVyIHByb21vdGVkIHZpc3VhbHMgdXNlIHRoZSBzYW1lIGNsZWFudXAgc2VtYW50aWNzLlxyXG4gICAgcmV0dXJuIHNwZWMuYWN0aW9uID09PSAncmVuZGVyJ1xyXG4gICAgICAgIHx8IChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJyAmJiBCb29sZWFuKHNwZWMuc3ByaXRlKSAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCA9PT0gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUNvbGxhcHNlZE1hcHBlZERlc2NlbmRhbnRzKFxyXG4gICAgaW1wb3J0Um9vdDogYW55LFxyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBjdXJyZW50TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgc3BlY3M6IFNjZW5lTm9kZVNwZWNbXSxcclxuICAgIGNjOiBhbnksXHJcbik6IG51bWJlciB7XHJcbiAgICBjb25zdCByZXRhaW5lZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKGN1cnJlbnRNYXApKTtcclxuICAgIGNvbnN0IGJvdW5kYXJ5U3BlY3M6IEFycmF5PHtcclxuICAgICAgICBmaWdtYUlkOiBzdHJpbmc7XHJcbiAgICAgICAgcmVtb3Zlc0FsbE1hcHBlZERlc2NlbmRhbnRzOiBib29sZWFuO1xyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgfT4gPSBbXTtcclxuICAgIGNvbnN0IGNvbGxlY3RCb3VuZGFyaWVzID0gKG5vZGVzOiBTY2VuZU5vZGVTcGVjW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IHNwZWMgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgaWYgKGZsYXR0ZW5zRGVzY2VuZGFudHMoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgIGJvdW5kYXJ5U3BlY3MucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlnbWFJZDogc3BlYy5maWdtYUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50czogdHJ1ZSxcclxuICAgICAgICAgICAgICAgICAgICBhbGlhc0ZpZ21hSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGFsaWFzRmlnbWFJZHMgPSBhbGlhc0ZpZ21hSWRzRm9yU3BlYyhzcGVjKTtcclxuICAgICAgICAgICAgaWYgKGFsaWFzRmlnbWFJZHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBib3VuZGFyeVNwZWNzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpZ21hSWQ6IHNwZWMuZmlnbWFJZCxcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVzQWxsTWFwcGVkRGVzY2VuZGFudHM6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzRmlnbWFJZHM6IG5ldyBTZXQoYWxpYXNGaWdtYUlkcyksXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb2xsZWN0Qm91bmRhcmllcyhzcGVjLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29sbGVjdEJvdW5kYXJpZXMoc3BlY3MpO1xyXG4gICAgY29uc3QgYm91bmRhcmllcyA9IGJvdW5kYXJ5U3BlY3NcclxuICAgICAgICAubWFwKChib3VuZGFyeSkgPT4gKHtcclxuICAgICAgICAgICAgLi4uYm91bmRhcnksXHJcbiAgICAgICAgICAgIG5vZGU6IGN1cnJlbnRNYXBbYm91bmRhcnkuZmlnbWFJZF1cclxuICAgICAgICAgICAgICAgID8gZmluZEJ5VXVpZChpbXBvcnRSb290LCBjdXJyZW50TWFwW2JvdW5kYXJ5LmZpZ21hSWRdKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsLFxyXG4gICAgICAgIH0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGJvdW5kYXJ5KTogYm91bmRhcnkgaXMgdHlwZW9mIGJvdW5kYXJ5ICYgeyBub2RlOiBhbnkgfSA9PiBCb29sZWFuKGJvdW5kYXJ5Lm5vZGUpKTtcclxuICAgIGlmICghYm91bmRhcmllcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlTm9kZXMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgcmV0YWluZWRVdWlkcy5oYXModXVpZCkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgYm91bmRhcnkgb2YgYm91bmRhcmllcykge1xyXG4gICAgICAgICAgICBpZiAoIWJvdW5kYXJ5LnJlbW92ZXNBbGxNYXBwZWREZXNjZW5kYW50c1xyXG4gICAgICAgICAgICAgICAgJiYgIWJvdW5kYXJ5LmFsaWFzRmlnbWFJZHMuaGFzKGZpZ21hSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChib3VuZGFyeS5ub2RlLCB1dWlkKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUgJiYgbm9kZSAhPT0gYm91bmRhcnkubm9kZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhbGVOb2Rlcy5zZXQobm9kZS51dWlkLCBub2RlKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKCFzdGFsZU5vZGVzLnNpemUpIHtcclxuICAgICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICAgIGNvbnN0IHN0YWxlVXVpZHMgPSBuZXcgU2V0KHN0YWxlTm9kZXMua2V5cygpKTtcclxuICAgIGxldCByZW1vdmVkID0gMDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBzdGFsZU5vZGVzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgaWYgKCFub2RlLnBhcmVudCB8fCBzdGFsZVV1aWRzLmhhcyhub2RlLnBhcmVudC51dWlkKSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVtb3ZlZCArPSByZW1vdmVNYXBwZWROb2RlVHJlZShub2RlLCBub2RlLnBhcmVudCwgc3RhbGVVdWlkcywgY2MpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbW92ZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1lcmdlUHJlc2VydmVkTWFwcGluZ3MoXHJcbiAgICBpbXBvcnRSb290OiBhbnksXHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIGN1cnJlbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoZXhpc3RpbmdNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycgfHwgY3VycmVudE1hcFtmaWdtYUlkXSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZpbmRCeVV1aWQoaW1wb3J0Um9vdCwgdXVpZCkpIHtcclxuICAgICAgICAgICAgY3VycmVudE1hcFtmaWdtYUlkXSA9IHV1aWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhcclxuICAgIGNvbnRhaW5lcjogYW55LFxyXG4gICAgc3Vydml2b3JQYXJlbnQ6IGFueSxcclxuICAgIGV4aXN0aW5nVXVpZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLmNvbnRhaW5lci5jaGlsZHJlbl0pIHtcclxuICAgICAgICBpZiAoZXhpc3RpbmdVdWlkcy5oYXMoY2hpbGQudXVpZCkpIHtcclxuICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgc2FsdmFnZUV4aXN0aW5nTWFwcGVkTm9kZXMoY2hpbGQsIHN1cnZpdm9yUGFyZW50LCBleGlzdGluZ1V1aWRzKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmRDYW52YXMocm9vdDogYW55LCBDYW52YXM6IGFueSk6IGFueSB8IG51bGwge1xyXG4gICAgaWYgKHJvb3QuZ2V0Q29tcG9uZW50KENhbnZhcykpIHtcclxuICAgICAgICByZXR1cm4gcm9vdDtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygcm9vdC5jaGlsZHJlbikge1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gZmluZENhbnZhcyhjaGlsZCwgQ2FudmFzKTtcclxuICAgICAgICBpZiAoZm91bmQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVHZW5lcmF0ZWRDb21wb25lbnRzKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgY2xhc3NlczogYW55W10sXHJcbiAgICBwcmVzZXJ2ZWQ6IFNldDxhbnk+LFxyXG4gICAgcmVuZGVyQ2xhc3NlczogYW55W10sXHJcbiAgICByZW1vdmFibGVGaWxlSWRzPzogU2V0PHN0cmluZz4sXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgbGV0IHJlbW92ZWRSZW5kZXJDb21wb25lbnQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgdHlwZSBvZiBjbGFzc2VzKSB7XHJcbiAgICAgICAgaWYgKHByZXNlcnZlZC5oYXModHlwZSkpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBvbmVudCA9IG5vZGUuZ2V0Q29tcG9uZW50KHR5cGUpO1xyXG4gICAgICAgIGlmIChjb21wb25lbnQpIHtcclxuICAgICAgICAgICAgaWYgKHJlbW92YWJsZUZpbGVJZHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGVJZCA9IGNvbXBvbmVudFByZWZhYkZpbGVJZChjb21wb25lbnQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFmaWxlSWQgfHwgIXJlbW92YWJsZUZpbGVJZHMuaGFzKGZpbGVJZCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBpZiAocmVuZGVyQ2xhc3Nlcy5zb21lKChyZW5kZXJUeXBlKSA9PiBjb21wb25lbnQgaW5zdGFuY2VvZiByZW5kZXJUeXBlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBg6IqC54K54oCcJHtub2RlLm5hbWV94oCd5LiK55qE5riy5p+T57uE5Lu25LiN5pivIEZpZ21hIEltcG9ydGVyIOWIm+W7uueahO+8jOW3suWBnOatouabtOaWsOS7peS/neaKpOaJi+W3peWGheWuueOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChyZW5kZXJDbGFzc2VzLnNvbWUoKHJlbmRlclR5cGUpID0+IGNvbXBvbmVudCBpbnN0YW5jZW9mIHJlbmRlclR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub2RlLnJlbW92ZUNvbXBvbmVudChjb21wb25lbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZW1vdmVkUmVuZGVyQ29tcG9uZW50O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVPYnNvbGV0ZUxhYmVsT3V0bGluZShub2RlOiBhbnksIGNjOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG91dGxpbmUgPSBub2RlLmdldENvbXBvbmVudChjYy5MYWJlbE91dGxpbmUpO1xyXG4gICAgaWYgKCFvdXRsaW5lKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gTGFiZWxPdXRsaW5lIHdhcyB1c2VkIGJ5IG9sZGVyIGltcG9ydGVyIHZlcnNpb25zLiBDb2NvcyBkZXN0cm95c1xyXG4gICAgLy8gY29tcG9uZW50cyBhdCB0aGUgZW5kIG9mIHRoZSBmcmFtZSBhbmQgaXRzIG9uRGlzYWJsZSgpIHdyaXRlcyBiYWNrIHRvXHJcbiAgICAvLyBMYWJlbC5lbmFibGVPdXRsaW5lLCBzbyBsZXQgdGhhdCBsaWZlY3ljbGUgZmluaXNoIGJlZm9yZSBlaXRoZXJcclxuICAgIC8vIHJlY29uZmlndXJpbmcgb3IgcmVtb3ZpbmcgdGhlIExhYmVsIGNvbXBvbmVudC5cclxuICAgIG5vZGUucmVtb3ZlQ29tcG9uZW50KG91dGxpbmUpO1xyXG4gICAgYXdhaXQgd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZXNpcmVkR2VuZXJhdGVkQ29tcG9uZW50cyhzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogU2V0PGFueT4ge1xyXG4gICAgY29uc3QgZGVzaXJlZCA9IG5ldyBTZXQ8YW55PigpO1xyXG4gICAgY29uc3QgY2xpcHNDaGlsZHJlbiA9IGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYyk7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInIHx8IHNwZWMuc3ByaXRlKSB7XHJcbiAgICAgICAgaWYgKCF1c2VzVGlsZWRTcHJpdGVIZWxwZXIoc3BlYykpIHtcclxuICAgICAgICAgICAgZGVzaXJlZC5hZGQoY2MuU3ByaXRlKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlJpY2hUZXh0KTtcclxuICAgIH0gZWxzZSBpZiAoc3BlYy5raW5kID09PSAnbGFiZWwnIHx8IHNwZWMuZmlnbWFUeXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5MYWJlbCk7XHJcbiAgICB9IGVsc2UgaWYgKCFSQVNURVJfVkVDVE9SX1RZUEVTLmhhcyhzcGVjLmZpZ21hVHlwZSkpIHtcclxuICAgICAgICBpZiAoaGFzR3JhcGhpY3NWaXN1YWwoc3BlYykgfHwgY2xpcHNDaGlsZHJlbikge1xyXG4gICAgICAgICAgICBkZXNpcmVkLmFkZChjYy5HcmFwaGljcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChjbGlwc0NoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIGRlc2lyZWQuYWRkKGNjLk1hc2spO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICYmIHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgJiYgbGF5b3V0TW9kZVxyXG4gICAgICAgICYmIGxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLkxheW91dCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICBkZXNpcmVkLmFkZChjYy5TY3JvbGxWaWV3KTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdidXR0b24nKSB7XHJcbiAgICAgICAgZGVzaXJlZC5hZGQoY2MuQnV0dG9uKTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPCAwLjk5OSkge1xyXG4gICAgICAgIGRlc2lyZWQuYWRkKGNjLlVJT3BhY2l0eSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVzaXJlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAwKSk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJPd25lcnNoaXBHdWFyZCB7XHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nTm9kZVV1aWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIHByZWV4aXN0aW5nQ29tcG9uZW50czogU2V0PGFueT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzT3duZWRIZWxwZXJOb2RlKG5vZGU6IGFueSwgZ3VhcmQ6IFByZWZhYk93bmVyc2hpcEd1YXJkKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBmaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgcmV0dXJuICFndWFyZC5wcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgIHx8IEJvb2xlYW4oZmlsZUlkICYmIGd1YXJkLnByZXZpb3VzSGVscGVyRmlsZUlkcy5oYXMoZmlsZUlkKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgY29tcG9uZW50OiBhbnksXHJcbiAgICBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICBvd25lck5hbWU6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoIWNvbXBvbmVudCB8fCAhZ3VhcmQucHJlZXhpc3RpbmdDb21wb25lbnRzLmhhcyhjb21wb25lbnQpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICBpZiAoIWZpbGVJZCB8fCAhZ3VhcmQucHJldmlvdXNDb21wb25lbnRGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBg6IqC54K54oCcJHtvd25lck5hbWV94oCd5LiK55qEICR7Y29tcG9uZW50LmNvbnN0cnVjdG9yPy5uYW1lID8/ICdDb21wb25lbnQnfSDkuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRPd25lZEhlbHBlck5vZGUobm9kZTogYW55LCBndWFyZDogUHJlZmFiT3duZXJzaGlwR3VhcmQpOiB2b2lkIHtcclxuICAgIGlmICghaXNPd25lZEhlbHBlck5vZGUobm9kZSwgZ3VhcmQpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDovoXliqnoioLngrnigJwke25vZGUubmFtZX3igJ3kuI3mmK8gRmlnbWEgSW1wb3J0ZXIg5Yib5bu655qE77yM5bey5YGc5q2i5pu05paw44CCYCk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KGNvbXBvbmVudCwgZ3VhcmQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShub2RlOiBhbnksIGd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCk6IHZvaWQge1xyXG4gICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKG5vZGUsIGd1YXJkKTtcclxuICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbiA/PyBbXSkge1xyXG4gICAgICAgIGlmIChpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZShjaGlsZCwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveU93bmVkSGVscGVyU3VidHJlZShcclxuICAgIGhlbHBlcjogYW55LFxyXG4gICAgc3Vydml2b3I6IGFueSxcclxuICAgIGd1YXJkPzogUHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVtb3ZlID0gKG5vZGU6IGFueSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2YgWy4uLm5vZGUuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGlmIChndWFyZCAmJiBpc093bmVkSGVscGVyTm9kZShjaGlsZCwgZ3VhcmQpKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmUoY2hpbGQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgbm9kZS5kZXN0cm95KCk7XHJcbiAgICB9O1xyXG4gICAgcmVtb3ZlKGhlbHBlcik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZEJhY2tncm91bmQobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCBiYWNrZ3JvdW5kID0gbm9kZS5nZXRDaGlsZEJ5TmFtZShCQUNLR1JPVU5EX05PREVfTkFNRSk7XHJcbiAgICBpZiAoIWJhY2tncm91bmQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKGJhY2tncm91bmQsIG5vZGUsIGd1YXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKFxyXG4gICAgdGlsZWRTcHJpdGU6IGFueSxcclxuICAgIHN1cnZpdm9yOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiB2b2lkIHtcclxuICAgIGRlc3Ryb3lPd25lZEhlbHBlclN1YnRyZWUodGlsZWRTcHJpdGUsIHN1cnZpdm9yLCBndWFyZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZUdlbmVyYXRlZFRpbGVkTm9kZXMobm9kZTogYW55LCBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkKTogdm9pZCB7XHJcbiAgICBjb25zdCB0aWxlZE1hc2sgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX01BU0tfTk9ERV9OQU1FKTtcclxuICAgIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHRpbGVkTWFzaywgbm9kZSwgZ3VhcmQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGlsZWRTcHJpdGUgPSBub2RlLmdldENoaWxkQnlOYW1lKFRJTEVEX1NQUklURV9OT0RFX05BTUUpO1xyXG4gICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgZGVzdHJveUdlbmVyYXRlZFRpbGVkU3ByaXRlKHRpbGVkU3ByaXRlLCBub2RlLCBndWFyZCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbW92ZU9ic29sZXRlU2Nyb2xsSGVscGVycyhcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBjYzogYW55LFxyXG4gICAgZ3VhcmQ/OiBQcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICAvLyBBIGZsYXR0ZW5lZCBub2RlIGhhcyBubyBuZXcgY2hpbGQgc3BlY3MgYnkgZGVzaWduLiBLZWVwIGV2ZXJ5IGV4aXN0aW5nXHJcbiAgICAvLyBjaGlsZCBhbGl2ZSB1bnRpbCByZW1vdmVGbGF0dGVuZWRNYXBwZWREZXNjZW5kYW50cyBjYW4gZGlzdGluZ3Vpc2ggb2xkXHJcbiAgICAvLyBGaWdtYS1tYXBwZWQgbm9kZXMgZnJvbSB1c2VyLWF1dGhvcmVkIG5vZGVzLiBPdGhlcndpc2UgZGVzdHJveWluZyB0aGVcclxuICAgIC8vIGhlbHBlciB3b3VsZCByZWN1cnNpdmVseSBkZXN0cm95IG1hbnVhbCBjaGlsZHJlbiBhdCBDb2NvcycgZGVmZXJyZWRcclxuICAgIC8vIGRlc3RydWN0aW9uIGJvdW5kYXJ5LlxyXG4gICAgY29uc3QgcHJlc2VydmVDaGlsZHJlbiA9IHNwZWMuY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBmbGF0dGVuc0Rlc2NlbmRhbnRzKHNwZWMpO1xyXG4gICAgY29uc3QgbW92ZUNoaWxkcmVuVG9Ob2RlID0gKGNvbnRhaW5lcjogYW55KSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4uY29udGFpbmVyLmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCBsZWdhY3kgPSBub2RlLmdldENoaWxkQnlOYW1lKCdfX0ZpZ21hQ29udGVudCcpO1xyXG4gICAgaWYgKGxlZ2FjeSkge1xyXG4gICAgICAgIGlmIChndWFyZCkge1xyXG4gICAgICAgICAgICBhc3NlcnRPd25lZEhlbHBlck5vZGUobGVnYWN5LCBndWFyZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChndWFyZCB8fCBwcmVzZXJ2ZUNoaWxkcmVuKSB7XHJcbiAgICAgICAgICAgIG1vdmVDaGlsZHJlblRvTm9kZShsZWdhY3kpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChjYy5TY3JvbGxWaWV3KTtcclxuICAgIGNvbnN0IHZpZXcgPSBub2RlLmdldENoaWxkQnlOYW1lKCd2aWV3Jyk7XHJcbiAgICBjb25zdCBjb250ZW50ID0gdmlldz8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKTtcclxuICAgIGlmICghc2Nyb2xsIHx8ICF2aWV3IHx8ICFjb250ZW50XHJcbiAgICAgICAgfHwgKHNjcm9sbC5jb250ZW50ICE9PSBjb250ZW50ICYmIHNjcm9sbC5jb250ZW50ICE9IG51bGwpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIGd1YXJkKTtcclxuICAgICAgICBkZXN0cm95T3duZWRIZWxwZXJTdWJ0cmVlKHZpZXcsIG5vZGUsIGd1YXJkKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocHJlc2VydmVDaGlsZHJlbikge1xyXG4gICAgICAgIG1vdmVDaGlsZHJlblRvTm9kZShjb250ZW50KTtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi52aWV3LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBpZiAoY2hpbGQgIT09IGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb250ZW50LnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgIGNvbnRlbnQuZGVzdHJveSgpO1xyXG4gICAgdmlldy5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICB2aWV3LmRlc3Ryb3koKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVQb3NpdGlvbihcclxuICAgIGZyYW1lOiBSZWN0LFxyXG4gICAgcGFyZW50RnJhbWU6IFJlY3QgfCB1bmRlZmluZWQsXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgcGFyZW50VHJhbnNmb3JtPzogYW55LFxyXG4gICAgY2hpbGRUcmFuc2Zvcm0/OiBhbnksXHJcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXIgfSB7XHJcbiAgICBpZiAoIXBhcmVudEZyYW1lKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAsIHk6IDEgfTtcclxuICAgIGNvbnN0IHBhcmVudFNpemUgPSBwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplID8/IHt9O1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50U2l6ZS53aWR0aCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50U2l6ZS53aWR0aClcclxuICAgICAgICA6IHBhcmVudEZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpID4gMFxyXG4gICAgICAgID8gTnVtYmVyKHBhcmVudFNpemUuaGVpZ2h0KVxyXG4gICAgICAgIDogcGFyZW50RnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCB3aWR0aCA9IGZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBmcmFtZS5oZWlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IGNoaWxkQW5jaG9yID0gY2hpbGRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLy8gRmlnbWEgY29vcmRpbmF0ZXMgYXJlIG1lYXN1cmVkIGZyb20gdGhlIHBhcmVudCdzIHRvcC1sZWZ0LiBDb252ZXJ0XHJcbiAgICAgICAgLy8gdGhhdCByZWN0YW5nbGUgdG8gdGhlIGxvY2FsIHBvc2l0aW9uIG9mIHRoZSBub2RlJ3MgY2VudGVyIGFuY2hvci5cclxuICAgICAgICB4OiAoZnJhbWUueCAtIHBhcmVudEZyYW1lLngpICogc2NhbGVcclxuICAgICAgICAgICAgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54XHJcbiAgICAgICAgICAgICsgd2lkdGggKiBjaGlsZEFuY2hvci54LFxyXG4gICAgICAgIHk6IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpXHJcbiAgICAgICAgICAgIC0gKGZyYW1lLnkgLSBwYXJlbnRGcmFtZS55KSAqIHNjYWxlXHJcbiAgICAgICAgICAgIC0gaGVpZ2h0ICogKDEgLSBjaGlsZEFuY2hvci55KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbGF0aXZlVHJhbnNmb3JtUG9zaXRpb24oXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIHBhcmVudFRyYW5zZm9ybT86IGFueSxcclxuKTogeyB4OiBudW1iZXI7IHk6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcclxuICAgIGlmIChzcGVjLmlzUm9vdCB8fCAhc3BlYy5pbnRyaW5zaWNTaXplKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgbWF0cml4ID0gc3BlYy5yZWxhdGl2ZVRyYW5zZm9ybTtcclxuICAgIGNvbnN0IHZhbHVlcyA9IFtcclxuICAgICAgICBtYXRyaXg/LlswXT8uWzBdLCBtYXRyaXg/LlswXT8uWzFdLCBtYXRyaXg/LlswXT8uWzJdLFxyXG4gICAgICAgIG1hdHJpeD8uWzFdPy5bMF0sIG1hdHJpeD8uWzFdPy5bMV0sIG1hdHJpeD8uWzFdPy5bMl0sXHJcbiAgICBdO1xyXG4gICAgaWYgKCF2YWx1ZXMuZXZlcnkoKHZhbHVlKSA9PiB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IFttMDAsIG0wMSwgdHgsIG0xMCwgbTExLCB0eV0gPSB2YWx1ZXMgYXMgbnVtYmVyW107XHJcbiAgICBjb25zdCBwYXJlbnRBbmNob3IgPSBwYXJlbnRUcmFuc2Zvcm0/LmFuY2hvclBvaW50ID8/IHsgeDogMC41LCB5OiAwLjUgfTtcclxuICAgIGNvbnN0IHBhcmVudFNpemUgPSBwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplID8/IHt9O1xyXG4gICAgY29uc3QgcGFyZW50V2lkdGggPSBOdW1iZXIocGFyZW50U2l6ZS53aWR0aCk7XHJcbiAgICBjb25zdCBwYXJlbnRIZWlnaHQgPSBOdW1iZXIocGFyZW50U2l6ZS5oZWlnaHQpO1xyXG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyZW50V2lkdGgpIHx8ICFOdW1iZXIuaXNGaW5pdGUocGFyZW50SGVpZ2h0KSkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICAvLyBGaWdtYSByZWxhdGl2ZVRyYW5zZm9ybSBpcyB0b3AtbGVmdCBiYXNlZC4gVHJhbnNmb3JtIHRoZSB1bnJvdGF0ZWQgbG9jYWxcclxuICAgIC8vIGNlbnRlciwgdGhlbiBjb252ZXJ0IHRoZSBwYXJlbnQncyBkb3dud2FyZCBZIGF4aXMgdG8gQ29jb3MgdXB3YXJkIFkuXHJcbiAgICBjb25zdCBjZW50ZXJYID0gdHggKyBtMDAgKiBzcGVjLmludHJpbnNpY1NpemUud2lkdGggLyAyXHJcbiAgICAgICAgKyBtMDEgKiBzcGVjLmludHJpbnNpY1NpemUuaGVpZ2h0IC8gMjtcclxuICAgIGNvbnN0IGNlbnRlclkgPSB0eSArIG0xMCAqIHNwZWMuaW50cmluc2ljU2l6ZS53aWR0aCAvIDJcclxuICAgICAgICArIG0xMSAqIHNwZWMuaW50cmluc2ljU2l6ZS5oZWlnaHQgLyAyO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB4OiBjZW50ZXJYICogc2NhbGUgLSBwYXJlbnRXaWR0aCAqIHBhcmVudEFuY2hvci54LFxyXG4gICAgICAgIHk6IHBhcmVudEhlaWdodCAqICgxIC0gcGFyZW50QW5jaG9yLnkpIC0gY2VudGVyWSAqIHNjYWxlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlR2VvbWV0cnkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogYW55IHtcclxuICAgIGNvbnN0IHsgVUlUcmFuc2Zvcm0sIFZlYzMgfSA9IGNjO1xyXG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IG5vZGUuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBjb25zdCBzaXplID0gc3BlYy5pbnRyaW5zaWNTaXplID8/IHNwZWMuZnJhbWU7XHJcbiAgICB0cmFuc2Zvcm0uc2V0Q29udGVudFNpemUoXHJcbiAgICAgICAgTWF0aC5tYXgoMCwgc2l6ZS53aWR0aCAqIHNjYWxlKSxcclxuICAgICAgICBNYXRoLm1heCgwLCBzaXplLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXJlbnRUcmFuc2Zvcm0gPSBub2RlLnBhcmVudD8uZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIGNvbnN0IHBvc2l0aW9uID0gc3BlYy5pc1Jvb3RcclxuICAgICAgICA/IHsgeDogMCwgeTogMCB9XHJcbiAgICAgICAgOiByZWxhdGl2ZVRyYW5zZm9ybVBvc2l0aW9uKHNwZWMsIHNjYWxlLCBwYXJlbnRUcmFuc2Zvcm0pXHJcbiAgICAgICAgICAgID8/IGZyYW1lUG9zaXRpb24oc3BlYy5mcmFtZSwgc3BlYy5wYXJlbnRGcmFtZSwgc2NhbGUsIHBhcmVudFRyYW5zZm9ybSwgdHJhbnNmb3JtKTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMocG9zaXRpb24ueCwgcG9zaXRpb24ueSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbiAgICBub2RlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIHNwZWMucm90YXRpb24pO1xyXG4gICAgbm9kZS5hY3RpdmUgPSBzcGVjLnZpc2libGU7XHJcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlUGFpbnQocGFpbnRzOiBGaWdtYVBhaW50W10pOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiBwYWludHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpc2libGVTb2xpZFBhaW50KHBhaW50czogRmlnbWFQYWludFtdKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gcGFpbnRzLmZpbmQoKHBhaW50KSA9PiBwYWludC50eXBlID09PSAnU09MSUQnXHJcbiAgICAgICAgJiYgcGFpbnQudmlzaWJsZSAhPT0gZmFsc2VcclxuICAgICAgICAmJiAocGFpbnQub3BhY2l0eSA/PyAxKSA+IDBcclxuICAgICAgICAmJiBCb29sZWFuKHBhaW50LmNvbG9yKVxyXG4gICAgICAgICYmIChwYWludC5jb2xvcj8uYSA/PyAxKSA+IDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2aXNpYmxlU29saWRGaWxsKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBGaWdtYVBhaW50IHwgdW5kZWZpbmVkIHtcclxuICAgIHJldHVybiB2aXNpYmxlU29saWRQYWludChzcGVjLmZpbGxzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdmFsaWRTb2xpZFN0cm9rZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogRmlnbWFQYWludCB8IHVuZGVmaW5lZCB7XHJcbiAgICByZXR1cm4gc3BlYy5zdHJva2VXZWlnaHQgPiAwID8gdmlzaWJsZVNvbGlkUGFpbnQoc3BlYy5zdHJva2VzKSA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzR3JhcGhpY3NWaXN1YWwoc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIEJvb2xlYW4odmlzaWJsZVNvbGlkRmlsbChzcGVjKSB8fCB2YWxpZFNvbGlkU3Ryb2tlKHNwZWMpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZHJhd0dyYXBoaWNzKGdyYXBoaWNzOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGZpbGwgPSB2aXNpYmxlU29saWRGaWxsKHNwZWMpO1xyXG4gICAgY29uc3Qgc3Ryb2tlID0gdmFsaWRTb2xpZFN0cm9rZShzcGVjKTtcclxuICAgIGlmICghZmlsbCAmJiAhc3Ryb2tlKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2lkdGggPSBzcGVjLmZyYW1lLndpZHRoICogc2NhbGU7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcmFkaXVzID0gTWF0aC5tYXgoXHJcbiAgICAgICAgMCxcclxuICAgICAgICBNYXRoLm1pbihNYXRoLm1pbiguLi5zcGVjLmNvcm5lclJhZGlpKSAqIHNjYWxlLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpLFxyXG4gICAgKTtcclxuICAgIGlmIChzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnKSB7XHJcbiAgICAgICAgZ3JhcGhpY3MuZWxsaXBzZSgwLCAwLCB3aWR0aCAvIDIsIGhlaWdodCAvIDIpO1xyXG4gICAgfSBlbHNlIGlmIChyYWRpdXMgPiAwKSB7XHJcbiAgICAgICAgZ3JhcGhpY3Mucm91bmRSZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0LCByYWRpdXMpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBncmFwaGljcy5yZWN0KC13aWR0aCAvIDIsIC1oZWlnaHQgLyAyLCB3aWR0aCwgaGVpZ2h0KTtcclxuICAgIH1cclxuICAgIGlmIChmaWxsPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmZpbGxDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIGZpbGwuY29sb3IsIGZpbGwub3BhY2l0eSA/PyAxKTtcclxuICAgICAgICBncmFwaGljcy5maWxsKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3Ryb2tlPy5jb2xvcikge1xyXG4gICAgICAgIGdyYXBoaWNzLmxpbmVXaWR0aCA9IE1hdGgubWF4KDAuNSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICAgICAgZ3JhcGhpY3Muc3Ryb2tlQ29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBzdHJva2UuY29sb3IsIHN0cm9rZS5vcGFjaXR5ID8/IDEpO1xyXG4gICAgICAgIGdyYXBoaWNzLnN0cm9rZSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVHcmFwaGljcyhub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IGdyYXBoaWNzID0gbm9kZS5nZXRDb21wb25lbnQoY2MuR3JhcGhpY3MpID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkdyYXBoaWNzKTtcclxuICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgZ3JhcGhpY3MuY2xlYXIoKTtcclxuICAgIGRyYXdHcmFwaGljcyhncmFwaGljcywgc3BlYywgc2NhbGUsIGNjKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplTGFiZWxUZXh0KGNoYXJhY3RlcnM6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gKGNoYXJhY3RlcnMgPz8gJycpXHJcbiAgICAgICAgLnJlcGxhY2UoL1xcclxcbi9nLCAnXFxuJylcclxuICAgICAgICAucmVwbGFjZSgvW1xcclxcdTIwMjhcXHUyMDI5XS9nLCAnXFxuJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGlzTXVsdGlsaW5lTGFiZWwoY2hhcmFjdGVyczogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGRpc2FibGVzIGF1dG9tYXRpYyB3cmFwcGluZyB3aGVuZXZlciBvdmVyZmxvdyBpc1xyXG4gICAgLy8gTk9ORS4gT25seSBleHBsaWNpdCBsaW5lIGZlZWRzIGNhbiB0aGVyZWZvcmUgcHJvZHVjZSByZWFsIGxpbmUgYnJlYWtzLlxyXG4gICAgcmV0dXJuIGNoYXJhY3RlcnMuaW5jbHVkZXMoJ1xcbicpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb25maWd1cmVMYWJlbChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IHsgTGFiZWwgfSA9IGNjO1xyXG4gICAgY29uc3QgbGFiZWwgPSBub2RlLmdldENvbXBvbmVudChMYWJlbCkgPz8gbm9kZS5hZGRDb21wb25lbnQoTGFiZWwpO1xyXG4gICAgY29uc3Qgc3R5bGUgPSBzcGVjLnRleHRTdHlsZSA/PyB7fTtcclxuICAgIGNvbnN0IGNoYXJhY3RlcnMgPSBub3JtYWxpemVMYWJlbFRleHQoc3BlYy5jaGFyYWN0ZXJzKTtcclxuICAgIGNvbnN0IG11bHRpbGluZSA9IGlzTXVsdGlsaW5lTGFiZWwoY2hhcmFjdGVycyk7XHJcbiAgICBsYWJlbC5mb250U2l6ZSA9IE1hdGgubWF4KDEsIChzdHlsZS5mb250U2l6ZSA/PyAxNikgKiBzY2FsZSk7XHJcbiAgICBsYWJlbC5saW5lSGVpZ2h0ID0gTWF0aC5tYXgoMSwgKHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSA/PyAxNikgKiBzY2FsZSk7XHJcbiAgICBsYWJlbC5zcGFjaW5nWCA9IChzdHlsZS5sZXR0ZXJTcGFjaW5nID8/IDApICogc2NhbGU7XHJcbiAgICBsYWJlbC5lbmFibGVXcmFwVGV4dCA9IGZhbHNlO1xyXG4gICAgbGFiZWwub3ZlcmZsb3cgPSBMYWJlbC5PdmVyZmxvdy5DTEFNUDtcclxuICAgIGxhYmVsLmhvcml6b250YWxBbGlnbiA9IG11bHRpbGluZVxyXG4gICAgICAgID8gTGFiZWwuSG9yaXpvbnRhbEFsaWduLkxFRlRcclxuICAgICAgICA6IExhYmVsLkhvcml6b250YWxBbGlnbi5DRU5URVI7XHJcbiAgICBsYWJlbC52ZXJ0aWNhbEFsaWduID0gbXVsdGlsaW5lXHJcbiAgICAgICAgPyBMYWJlbC5WZXJ0aWNhbEFsaWduLlRPUFxyXG4gICAgICAgIDogTGFiZWwuVmVydGljYWxBbGlnbi5DRU5URVI7XHJcbiAgICBsYWJlbC5zdHJpbmcgPSBjaGFyYWN0ZXJzO1xyXG4gICAgbGFiZWwuZW5hYmxlT3V0bGluZSA9IGZhbHNlO1xyXG4gICAgbGFiZWwuY29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IDEgfSk7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVBhaW50KHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgbGFiZWwuY29sb3IgPSB0b0NvbG9yKGNjLkNvbG9yLCBmaWxsLmNvbG9yLCBmaWxsLm9wYWNpdHkgPz8gMSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdHJva2UgPSB2aXNpYmxlUGFpbnQoc3BlYy5zdHJva2VzKTtcclxuICAgIGlmIChzdHJva2U/LmNvbG9yICYmIHNwZWMuc3Ryb2tlV2VpZ2h0ID4gMCkge1xyXG4gICAgICAgIGxhYmVsLmVuYWJsZU91dGxpbmUgPSB0cnVlO1xyXG4gICAgICAgIGxhYmVsLm91dGxpbmVDb2xvciA9IHRvQ29sb3IoY2MuQ29sb3IsIHN0cm9rZS5jb2xvciwgc3Ryb2tlLm9wYWNpdHkgPz8gMSk7XHJcbiAgICAgICAgbGFiZWwub3V0bGluZVdpZHRoID0gTWF0aC5tYXgoMSwgc3BlYy5zdHJva2VXZWlnaHQgKiBzY2FsZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgc2NhbGU6IG51bWJlciwgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3QgeyBSaWNoVGV4dCB9ID0gY2M7XHJcbiAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KSA/PyBub2RlLmFkZENvbXBvbmVudChSaWNoVGV4dCk7XHJcbiAgICBjb25zdCBzdHlsZSA9IHNwZWMudGV4dFN0eWxlID8/IHt9O1xyXG4gICAgcmljaFRleHQuc3RyaW5nID0gbm9ybWFsaXplTGFiZWxUZXh0KHNwZWMuY2hhcmFjdGVycyk7XHJcbiAgICByaWNoVGV4dC5mb250U2l6ZSA9IE1hdGgubWF4KDEsIChzdHlsZS5mb250U2l6ZSA/PyAxNikgKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5saW5lSGVpZ2h0ID0gTWF0aC5tYXgoMSwgKHN0eWxlLmxpbmVIZWlnaHRQeCA/PyBzdHlsZS5mb250U2l6ZSA/PyAxNikgKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5tYXhXaWR0aCA9IE1hdGgubWF4KDAsIHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZSk7XHJcbiAgICByaWNoVGV4dC5oYW5kbGVUb3VjaEV2ZW50ID0gZmFsc2U7XHJcbiAgICAvLyBSaWNoVGV4dCBpcyBwcmltYXJpbHkgdXNlZCBmb3IgcnVudGltZS1pbmplY3RlZCBtdWx0aS1saW5lIGNvbnRlbnQuIEFuXHJcbiAgICAvLyBlbXB0eSBGaWdtYSBwbGFjZWhvbGRlciBtdXN0IHRoZXJlZm9yZSBrZWVwIHRoZSBzYW1lIHRvcC1sZWZ0IGNvbnRyYWN0XHJcbiAgICAvLyBhZnRlciB0aGUgZ2FtZSBhc3NpZ25zIGl0cyByZWFsIHN0cmluZy5cclxuICAgIHJpY2hUZXh0Lmhvcml6b250YWxBbGlnbiA9IFJpY2hUZXh0Lkhvcml6b250YWxBbGlnbi5MRUZUO1xyXG4gICAgcmljaFRleHQudmVydGljYWxBbGlnbiA9IFJpY2hUZXh0LlZlcnRpY2FsQWxpZ24uVE9QO1xyXG4gICAgcmljaFRleHQuZm9udEZhbWlseSA9IHN0eWxlLmZvbnRGYW1pbHkgPz8gJyc7XHJcbiAgICByaWNoVGV4dC51c2VTeXN0ZW1Gb250ID0gIXNwZWMuZm9udFV1aWQ7XHJcbiAgICBjb25zdCBmaWxsID0gdmlzaWJsZVBhaW50KHNwZWMuZmlsbHMpO1xyXG4gICAgaWYgKGZpbGw/LmNvbG9yKSB7XHJcbiAgICAgICAgcmljaFRleHQuZm9udENvbG9yID0gdG9Db2xvcihjYy5Db2xvciwgZmlsbC5jb2xvciwgZmlsbC5vcGFjaXR5ID8/IDEpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5hbGl6ZUxhYmVsR2VvbWV0cnkobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBzY2FsZTogbnVtYmVyLCBjYzogYW55KTogdm9pZCB7XG4gICAgY29uc3QgdHJhbnNmb3JtID0gbm9kZS5nZXRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgaWYgKCF0cmFuc2Zvcm0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkxhYmVsKTtcclxuICAgIGNvbnN0IG91dGxpbmVXaWR0aCA9IGxhYmVsPy5lbmFibGVPdXRsaW5lXG4gICAgICAgID8gTWF0aC5tYXgoMCwgTnVtYmVyKGxhYmVsLm91dGxpbmVXaWR0aCkgfHwgMClcbiAgICAgICAgOiAwO1xuICAgIGNvbnN0IGZpZ21hSGVpZ2h0ID0gTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSk7XG4gICAgY29uc3QgZm9udFNpemUgPSBNYXRoLm1heCgwLCBOdW1iZXIobGFiZWw/LmZvbnRTaXplKSB8fCAwKTtcbiAgICBjb25zdCBmaW5hbEhlaWdodCA9IE1hdGgubWF4KGZpZ21hSGVpZ2h0LCBmb250U2l6ZSkgKyBvdXRsaW5lV2lkdGggKiAyO1xuICAgIC8vIEtlZXAgdGhlIGltcG9ydGVkIEZpZ21hIGJveCB1bmxlc3MgYSBkZXRlcm1pbmlzdGljIG91dGxpbmUvZm9udCBsb3dlclxuICAgIC8vIGJvdW5kIHJlcXVpcmVzIGV4cGFuc2lvbi4gRXhwYW5kIHN5bW1ldHJpY2FsbHkgYXJvdW5kIHRoZSBjZW50ZXIgYW5jaG9yXG4gICAgLy8gc28gdGhlIG5vZGUncyBpbXBvcnRlZCBjZW50ZXIgcG9zaXRpb24gcmVtYWlucyB1bmNoYW5nZWQuXG4gICAgLy8gVGhlIGJhc2UgYm94IG11c3QgYXQgbGVhc3QgY29udGFpbiB0aGUgZmluYWwgQ29jb3MgZm9udCBzaXplLiBXaGVuIGFuXG4gICAgLy8gb3V0bGluZSBpcyBlbmFibGVkLCByZXNlcnZlIG9uZSBhY3R1YWwgQ29jb3Mgb3V0bGluZSB3aWR0aCBvbiBldmVyeSBzaWRlLlxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcbiAgICAgICAgTWF0aC5tYXgoMCwgc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlICsgb3V0bGluZVdpZHRoICogMiksXG4gICAgICAgIGZpbmFsSGVpZ2h0LFxuICAgICk7XG59XG5cclxuZnVuY3Rpb24gbG9hZEFzc2V0KGFzc2V0TWFuYWdlcjogYW55LCB1dWlkOiBzdHJpbmcpOiBQcm9taXNlPGFueT4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICBhc3NldE1hbmFnZXIubG9hZEFueSh7IHV1aWQgfSwgKGVycm9yOiBFcnJvciB8IG51bGwsIGFzc2V0OiBhbnkpID0+IHtcclxuICAgICAgICAgICAgaWYgKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICByZWplY3QoZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlc29sdmUoYXNzZXQpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNvbmZpZ3VyZVNwcml0ZShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICghc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XG4gICAgY29uc3QgeyBTcHJpdGUsIFVJVHJhbnNmb3JtLCBhc3NldE1hbmFnZXIgfSA9IGNjO1xuICAgIGNvbnN0IHNwcml0ZSA9IG5vZGUuZ2V0Q29tcG9uZW50KFNwcml0ZSkgPz8gbm9kZS5hZGRDb21wb25lbnQoU3ByaXRlKTtcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpO1xuICAgIGNvbnN0IHRhcmdldEhlaWdodCA9IE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUpO1xuXG4gICAgLy8gS2VlcCBhc3NpZ25tZW50IGRldGVybWluaXN0aWM6IGEgbmV3IFNwcml0ZSBtYXkgZGVmYXVsdCB0byBUUklNTUVEIGFuZFxuICAgIC8vIGltbWVkaWF0ZWx5IHJld3JpdGUgVUlUcmFuc2Zvcm0gd2hlbiBpdHMgU3ByaXRlRnJhbWUgaXMgYXNzaWduZWQuXG4gICAgc3ByaXRlLnNpemVNb2RlID0gU3ByaXRlLlNpemVNb2RlLkNVU1RPTTtcbiAgICBjb25zdCBzcHJpdGVGcmFtZSA9IGF3YWl0IGxvYWRBc3NldChhc3NldE1hbmFnZXIsIHNwZWMuc3ByaXRlLnV1aWQpO1xuICAgIHNwcml0ZS5zcHJpdGVGcmFtZSA9IHNwcml0ZUZyYW1lO1xuICAgIHNwcml0ZS50eXBlID0gc3BlYy5zcHJpdGUudGlsZWRcbiAgICAgICAgPyBTcHJpdGUuVHlwZS5USUxFRFxuICAgICAgICA6IHNwZWMuc3ByaXRlLnNsaWNlZFxuICAgICAgICAgICAgPyBTcHJpdGUuVHlwZS5TTElDRURcbiAgICAgICAgICAgIDogU3ByaXRlLlR5cGUuU0lNUExFO1xuXG4gICAgaWYgKCFzcGVjLnNwcml0ZS5zbGljZWQgJiYgIXNwZWMuc3ByaXRlLnRpbGVkKSB7XG4gICAgICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5UUklNTUVEO1xuICAgICAgICBjb25zdCB0cmltbWVkV2lkdGggPSBOdW1iZXIodHJhbnNmb3JtPy5jb250ZW50U2l6ZT8ud2lkdGgpO1xuICAgICAgICBjb25zdCB0cmltbWVkSGVpZ2h0ID0gTnVtYmVyKHRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCk7XG4gICAgICAgIGNvbnN0IHJhd1dpZHRoID0gTnVtYmVyKHNwcml0ZUZyYW1lPy5vcmlnaW5hbFNpemU/LndpZHRoID8/IHNwcml0ZUZyYW1lPy53aWR0aCk7XG4gICAgICAgIGNvbnN0IHJhd0hlaWdodCA9IE51bWJlcihzcHJpdGVGcmFtZT8ub3JpZ2luYWxTaXplPy5oZWlnaHQgPz8gc3ByaXRlRnJhbWU/LmhlaWdodCk7XG4gICAgICAgIGNvbnN0IGhhc1ZhbGlkU3ByaXRlU2l6ZSA9IE51bWJlci5pc0Zpbml0ZSh0cmltbWVkV2lkdGgpXG4gICAgICAgICAgICAmJiBOdW1iZXIuaXNGaW5pdGUodHJpbW1lZEhlaWdodClcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdXaWR0aClcbiAgICAgICAgICAgICYmIE51bWJlci5pc0Zpbml0ZShyYXdIZWlnaHQpXG4gICAgICAgICAgICAmJiByYXdXaWR0aCA+IDBcbiAgICAgICAgICAgICYmIHJhd0hlaWdodCA+IDA7XG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemVcbiAgICAgICAgICAgICYmIE1hdGguYWJzKHJhd1dpZHRoIC0gdGFyZ2V0V2lkdGgpIDw9IDAuNTFcbiAgICAgICAgICAgICYmIE1hdGguYWJzKHJhd0hlaWdodCAtIHRhcmdldEhlaWdodCkgPD0gMC41MSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoYXNWYWxpZFNwcml0ZVNpemUpIHtcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlWCA9IHRhcmdldFdpZHRoIC8gcmF3V2lkdGg7XG4gICAgICAgICAgICBjb25zdCBzY2FsZVkgPSB0YXJnZXRIZWlnaHQgLyByYXdIZWlnaHQ7XG4gICAgICAgICAgICBpZiAoTWF0aC5hYnMoc2NhbGVYIC0gc2NhbGVZKSA8PSAwLjAwMDEpIHtcbiAgICAgICAgICAgICAgICBzcHJpdGUuc2l6ZU1vZGUgPSBTcHJpdGUuU2l6ZU1vZGUuQ1VTVE9NO1xuICAgICAgICAgICAgICAgIHRyYW5zZm9ybT8uc2V0Q29udGVudFNpemUodHJpbW1lZFdpZHRoICogc2NhbGVYLCB0cmltbWVkSGVpZ2h0ICogc2NhbGVZKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBTbGljZWQvdGlsZWQgc3ByaXRlcyBhbmQgc3ByaXRlcyByZXNpemVkIGluIEZpZ21hIG11c3QgcmV0YWluIHRoZSBkZXNpZ25cbiAgICAvLyBzaXplLiBDb2NvcyByZXByZXNlbnRzIHRoYXQgc3RhdGUgYXMgQ1VTVE9NLlxuICAgIHNwcml0ZS5zaXplTW9kZSA9IFNwcml0ZS5TaXplTW9kZS5DVVNUT007XG4gICAgdHJhbnNmb3JtPy5zZXRDb250ZW50U2l6ZSh0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0KTtcbn1cblxyXG5mdW5jdGlvbiByZXF1aXJlc1RpbGVkTWFzayhzcGVjOiBTY2VuZU5vZGVTcGVjKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gQm9vbGVhbihzcGVjLnNwcml0ZT8udGlsZWQgJiYgc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5hdGl2ZVRpbGVTY2FsZShzcGVjOiBTY2VuZU5vZGVTcGVjKTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHNjYWxlID0gc3BlYy5zcHJpdGU/LnRpbGVTY2FsZTtcclxuICAgIHJldHVybiB0eXBlb2Ygc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShzY2FsZSkgJiYgc2NhbGUgPiAwXHJcbiAgICAgICAgPyBzY2FsZVxyXG4gICAgICAgIDogMTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXNlc1RpbGVkU3ByaXRlSGVscGVyKHNwZWM6IFNjZW5lTm9kZVNwZWMpOiBib29sZWFuIHtcclxuICAgIHJldHVybiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZClcclxuICAgICAgICAmJiAocmVxdWlyZXNUaWxlZE1hc2soc3BlYykgfHwgTWF0aC5hYnMobmF0aXZlVGlsZVNjYWxlKHNwZWMpIC0gMSkgPiAxZS02KTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY29uZmlndXJlVGlsZWRTcHJpdGVIZWxwZXIoXHJcbiAgICBub2RlOiBhbnksXHJcbiAgICBzcGVjOiBTY2VuZU5vZGVTcGVjLFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IG5lZWRzTWFzayA9IHJlcXVpcmVzVGlsZWRNYXNrKHNwZWMpO1xyXG4gICAgbGV0IHRpbGVkTWFzayA9IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfTUFTS19OT0RFX05BTUUpO1xyXG4gICAgbGV0IHRpbGVkU3ByaXRlID0gdGlsZWRNYXNrPy5nZXRDaGlsZEJ5TmFtZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKVxyXG4gICAgICAgID8/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoVElMRURfU1BSSVRFX05PREVfTkFNRSk7XHJcbiAgICBpZiAoZ3VhcmQpIHtcclxuICAgICAgICBpZiAodGlsZWRNYXNrKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZE1hc2ssIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh0aWxlZFNwcml0ZSwgZ3VhcmQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChuZWVkc01hc2spIHtcclxuICAgICAgICBpZiAoIXRpbGVkTWFzaykge1xyXG4gICAgICAgICAgICB0aWxlZE1hc2sgPSBuZXcgY2MuTm9kZShUSUxFRF9NQVNLX05PREVfTkFNRSk7XHJcbiAgICAgICAgICAgIG5vZGUuYWRkQ2hpbGQodGlsZWRNYXNrKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGlsZWRNYXNrLm5hbWUgPSBUSUxFRF9NQVNLX05PREVfTkFNRTtcclxuICAgICAgICB0aWxlZE1hc2subGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIHRpbGVkTWFzay5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG1hc2tUcmFuc2Zvcm0gPSB0aWxlZE1hc2suZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKVxyXG4gICAgICAgICAgICA/PyB0aWxlZE1hc2suYWRkQ29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgICAgICBtYXNrVHJhbnNmb3JtLnNldENvbnRlbnRTaXplKFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUpLFxyXG4gICAgICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLmhlaWdodCAqIHNjYWxlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRQb3NpdGlvbihuZXcgY2MuVmVjMygwLCAwLCAwKSk7XHJcbiAgICAgICAgdGlsZWRNYXNrLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgICAgIHRpbGVkTWFzay5zZXRTY2FsZShuZXcgY2MuVmVjMygxLCAxLCAxKSk7XHJcbiAgICAgICAgY29uZmlndXJlQ2xpcCh0aWxlZE1hc2ssIHNwZWMsIGNjKTtcclxuICAgICAgICB0aWxlZE1hc2suc2V0U2libGluZ0luZGV4KDApO1xyXG4gICAgfSBlbHNlIGlmICh0aWxlZE1hc2spIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi50aWxlZE1hc2suY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIHNldFBhcmVudEtlZXBpbmdXb3JsZChjaGlsZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRpbGVkTWFzay5yZW1vdmVGcm9tUGFyZW50KCk7XHJcbiAgICAgICAgdGlsZWRNYXNrLmRlc3Ryb3koKTtcclxuICAgICAgICB0aWxlZE1hc2sgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3ByaXRlUGFyZW50ID0gdGlsZWRNYXNrID8/IG5vZGU7XHJcbiAgICBpZiAoIXRpbGVkU3ByaXRlKSB7XHJcbiAgICAgICAgdGlsZWRTcHJpdGUgPSBuZXcgY2MuTm9kZShUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgICAgICBzcHJpdGVQYXJlbnQuYWRkQ2hpbGQodGlsZWRTcHJpdGUpO1xyXG4gICAgfSBlbHNlIGlmICh0aWxlZFNwcml0ZS5wYXJlbnQgIT09IHNwcml0ZVBhcmVudCkge1xyXG4gICAgICAgIHRpbGVkU3ByaXRlLnBhcmVudCA9IHNwcml0ZVBhcmVudDtcclxuICAgIH1cclxuICAgIHRpbGVkU3ByaXRlLm5hbWUgPSBUSUxFRF9TUFJJVEVfTk9ERV9OQU1FO1xyXG4gICAgdGlsZWRTcHJpdGUubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgdGlsZWRTcHJpdGUuYWN0aXZlID0gdHJ1ZTtcclxuICAgIGF3YWl0IGNvbmZpZ3VyZVNwcml0ZSh0aWxlZFNwcml0ZSwgc3BlYywgc2NhbGUsIGNjKTtcclxuICAgIGNvbnN0IHRpbGVTY2FsZSA9IG5hdGl2ZVRpbGVTY2FsZShzcGVjKTtcclxuICAgIGNvbnN0IHRyYW5zZm9ybSA9IHRpbGVkU3ByaXRlLmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSlcclxuICAgICAgICA/PyB0aWxlZFNwcml0ZS5hZGRDb21wb25lbnQoY2MuVUlUcmFuc2Zvcm0pO1xyXG4gICAgdHJhbnNmb3JtLnNldEFuY2hvclBvaW50KDAuNSwgMC41KTtcclxuICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShcclxuICAgICAgICBNYXRoLm1heCgwLCBzcGVjLmZyYW1lLndpZHRoICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgICAgIE1hdGgubWF4KDAsIHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGUgLyB0aWxlU2NhbGUpLFxyXG4gICAgKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFBvc2l0aW9uKG5ldyBjYy5WZWMzKDAsIDAsIDApKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFJvdGF0aW9uRnJvbUV1bGVyKDAsIDAsIDApO1xyXG4gICAgdGlsZWRTcHJpdGUuc2V0U2NhbGUobmV3IGNjLlZlYzModGlsZVNjYWxlLCB0aWxlU2NhbGUsIDEpKTtcclxuICAgIHRpbGVkU3ByaXRlLnNldFNpYmxpbmdJbmRleCgwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlT3BhY2l0eShub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGlmIChzcGVjLm9wYWNpdHkgPj0gMC45OTkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBvcGFjaXR5ID0gbm9kZS5nZXRDb21wb25lbnQoY2MuVUlPcGFjaXR5KSA/PyBub2RlLmFkZENvbXBvbmVudChjYy5VSU9wYWNpdHkpO1xyXG4gICAgb3BhY2l0eS5vcGFjaXR5ID0gTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBzcGVjLm9wYWNpdHkpKSAqIDI1NSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUxheW91dChub2RlOiBhbnksIHNwZWM6IFNjZW5lTm9kZVNwZWMsIHNjYWxlOiBudW1iZXIsIGNjOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmICghbW9kZSB8fCBtb2RlID09PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IExheW91dCwgU2l6ZSB9ID0gY2M7XHJcbiAgICBjb25zdCBsYXlvdXQgPSBub2RlLmdldENvbXBvbmVudChMYXlvdXQpID8/IG5vZGUuYWRkQ29tcG9uZW50KExheW91dCk7XHJcbiAgICBsYXlvdXQudHlwZSA9IG1vZGUgPT09ICdIT1JJWk9OVEFMJ1xyXG4gICAgICAgID8gTGF5b3V0LlR5cGUuSE9SSVpPTlRBTFxyXG4gICAgICAgIDogbW9kZSA9PT0gJ1ZFUlRJQ0FMJ1xyXG4gICAgICAgICAgICA/IExheW91dC5UeXBlLlZFUlRJQ0FMXHJcbiAgICAgICAgICAgIDogTGF5b3V0LlR5cGUuR1JJRDtcclxuICAgIGlmIChtb2RlID09PSAnR1JJRCcpIHtcclxuICAgICAgICBsYXlvdXQuc3RhcnRBeGlzID0gc3BlYy5sYXlvdXQ/LnNvdXJjZU1vZGUgPT09ICdWRVJUSUNBTCdcclxuICAgICAgICAgICAgPyBMYXlvdXQuQXhpc0RpcmVjdGlvbi5WRVJUSUNBTFxyXG4gICAgICAgICAgICA6IExheW91dC5BeGlzRGlyZWN0aW9uLkhPUklaT05UQUw7XHJcbiAgICB9XHJcbiAgICBsYXlvdXQucmVzaXplTW9kZSA9IExheW91dC5SZXNpemVNb2RlLk5PTkU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0xlZnQgPSBzcGVjLmxheW91dCEucGFkZGluZ0xlZnQgKiBzY2FsZTtcclxuICAgIGxheW91dC5wYWRkaW5nUmlnaHQgPSBzcGVjLmxheW91dCEucGFkZGluZ1JpZ2h0ICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ1RvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBsYXlvdXQucGFkZGluZ0JvdHRvbSA9IHNwZWMubGF5b3V0IS5wYWRkaW5nQm90dG9tICogc2NhbGU7XHJcbiAgICBsYXlvdXQuc3BhY2luZ1ggPSBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcgKiBzY2FsZTtcclxuICAgIGxheW91dC5zcGFjaW5nWSA9IChtb2RlID09PSAnR1JJRCcgPyBzcGVjLmxheW91dCEuY291bnRlclNwYWNpbmcgOiBzcGVjLmxheW91dCEuaXRlbVNwYWNpbmcpICogc2NhbGU7XHJcbiAgICBjb25zdCBhY3RpdmVDaGlsZHJlbiA9IHNwZWMuY2hpbGRyZW4uZmlsdGVyKChjaGlsZCkgPT4gY2hpbGQudmlzaWJsZSk7XHJcbiAgICBpZiAobW9kZSA9PT0gJ0hPUklaT05UQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuV2lkdGggPSBhY3RpdmVDaGlsZHJlbi5yZWR1Y2UoKHRvdGFsLCBjaGlsZCkgPT4gdG90YWwgKyBjaGlsZC5mcmFtZS53aWR0aCAqIHNjYWxlLCAwKTtcclxuICAgICAgICBjb25zdCBpbm5lcldpZHRoID0gc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlIC0gbGF5b3V0LnBhZGRpbmdMZWZ0IC0gbGF5b3V0LnBhZGRpbmdSaWdodDtcclxuICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ1NQQUNFX0JFVFdFRU4nICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCA+IDEpIHtcclxuICAgICAgICAgICAgbGF5b3V0LnNwYWNpbmdYID0gTWF0aC5tYXgoMCwgKGlubmVyV2lkdGggLSBjaGlsZHJlbldpZHRoKSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuV2lkdGggKyBsYXlvdXQuc3BhY2luZ1ggKiBNYXRoLm1heCgwLCBhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgY29uc3QgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgaW5uZXJXaWR0aCAtIHVzZWQpO1xyXG4gICAgICAgICAgICBpZiAoc3BlYy5sYXlvdXQhLnByaW1hcnlBbGlnbiA9PT0gJ0NFTlRFUicpIHtcclxuICAgICAgICAgICAgICAgIGxheW91dC5wYWRkaW5nTGVmdCArPSByZW1haW5pbmcgLyAyO1xyXG4gICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsYXlvdXQucGFkZGluZ0xlZnQgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChtb2RlID09PSAnVkVSVElDQUwnICYmIGFjdGl2ZUNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkcmVuSGVpZ2h0ID0gYWN0aXZlQ2hpbGRyZW4ucmVkdWNlKCh0b3RhbCwgY2hpbGQpID0+IHRvdGFsICsgY2hpbGQuZnJhbWUuaGVpZ2h0ICogc2NhbGUsIDApO1xyXG4gICAgICAgIGNvbnN0IGlubmVySGVpZ2h0ID0gc3BlYy5mcmFtZS5oZWlnaHQgKiBzY2FsZSAtIGxheW91dC5wYWRkaW5nVG9wIC0gbGF5b3V0LnBhZGRpbmdCb3R0b207XHJcbiAgICAgICAgaWYgKHNwZWMubGF5b3V0IS5wcmltYXJ5QWxpZ24gPT09ICdTUEFDRV9CRVRXRUVOJyAmJiBhY3RpdmVDaGlsZHJlbi5sZW5ndGggPiAxKSB7XHJcbiAgICAgICAgICAgIGxheW91dC5zcGFjaW5nWSA9IE1hdGgubWF4KDAsIChpbm5lckhlaWdodCAtIGNoaWxkcmVuSGVpZ2h0KSAvIChhY3RpdmVDaGlsZHJlbi5sZW5ndGggLSAxKSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgdXNlZCA9IGNoaWxkcmVuSGVpZ2h0ICsgbGF5b3V0LnNwYWNpbmdZICogTWF0aC5tYXgoMCwgYWN0aXZlQ2hpbGRyZW4ubGVuZ3RoIC0gMSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IE1hdGgubWF4KDAsIGlubmVySGVpZ2h0IC0gdXNlZCk7XHJcbiAgICAgICAgICAgIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmxheW91dCEucHJpbWFyeUFsaWduID09PSAnTUFYJykge1xyXG4gICAgICAgICAgICAgICAgbGF5b3V0LnBhZGRpbmdUb3AgKz0gcmVtYWluaW5nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKG1vZGUgPT09ICdHUklEJyAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIGxheW91dC5jZWxsU2l6ZSA9IG5ldyBTaXplKFxyXG4gICAgICAgICAgICBNYXRoLm1heCguLi5zcGVjLmNoaWxkcmVuLm1hcCgoY2hpbGQpID0+IGNoaWxkLmZyYW1lLndpZHRoKSkgKiBzY2FsZSxcclxuICAgICAgICAgICAgTWF0aC5tYXgoLi4uc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBjaGlsZC5mcmFtZS5oZWlnaHQpKSAqIHNjYWxlLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5Q291bnRlckFsaWdubWVudChcclxuICAgIHBhcmVudDogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4gICAgY2M6IGFueSxcclxuKTogdm9pZCB7XHJcbiAgICBjb25zdCBtb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICBjb25zdCBhbGlnbm1lbnQgPSBzcGVjLmxheW91dD8uY291bnRlckFsaWduO1xyXG4gICAgaWYgKCFtb2RlIHx8ICFhbGlnbm1lbnQgfHwgIVsnSE9SSVpPTlRBTCcsICdWRVJUSUNBTCddLmluY2x1ZGVzKG1vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGFyZW50VHJhbnNmb3JtID0gcGFyZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBwYXJlbnRXaWR0aCA9IE51bWJlcihwYXJlbnRUcmFuc2Zvcm0/LmNvbnRlbnRTaXplPy53aWR0aCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLndpZHRoKVxyXG4gICAgICAgIDogc3BlYy5mcmFtZS53aWR0aCAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50SGVpZ2h0ID0gTnVtYmVyKHBhcmVudFRyYW5zZm9ybT8uY29udGVudFNpemU/LmhlaWdodCkgPiAwXHJcbiAgICAgICAgPyBOdW1iZXIocGFyZW50VHJhbnNmb3JtLmNvbnRlbnRTaXplLmhlaWdodClcclxuICAgICAgICA6IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsYXlvdXRXaWR0aCA9IHNwZWMuZnJhbWUud2lkdGggKiBzY2FsZTtcclxuICAgIGNvbnN0IGxheW91dEhlaWdodCA9IHNwZWMuZnJhbWUuaGVpZ2h0ICogc2NhbGU7XHJcbiAgICBjb25zdCBsZWZ0ID0gc3BlYy5sYXlvdXQhLnBhZGRpbmdMZWZ0ICogc2NhbGU7XHJcbiAgICBjb25zdCByaWdodCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nUmlnaHQgKiBzY2FsZTtcclxuICAgIGNvbnN0IHRvcCA9IHNwZWMubGF5b3V0IS5wYWRkaW5nVG9wICogc2NhbGU7XHJcbiAgICBjb25zdCBib3R0b20gPSBzcGVjLmxheW91dCEucGFkZGluZ0JvdHRvbSAqIHNjYWxlO1xyXG4gICAgY29uc3QgcGFyZW50QW5jaG9yID0gcGFyZW50VHJhbnNmb3JtPy5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBmb3IgKGNvbnN0IGNoaWxkU3BlYyBvZiBzcGVjLmNoaWxkcmVuKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IG5vZGVNYXBbY2hpbGRTcGVjLmZpZ21hSWRdO1xyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gdXVpZCA/IGZpbmRCeVV1aWQocGFyZW50LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgdHJhbnNmb3JtID0gY2hpbGQ/LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgaWYgKCFjaGlsZCB8fCAhdHJhbnNmb3JtKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwb3NpdGlvbiA9IGNoaWxkLnBvc2l0aW9uLmNsb25lKCk7XHJcbiAgICAgICAgaWYgKG1vZGUgPT09ICdIT1JJWk9OVEFMJykge1xyXG4gICAgICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBNYXRoLm1heCgwLCBsYXlvdXRIZWlnaHQgLSB0b3AgLSBib3R0b20pO1xyXG4gICAgICAgICAgICBsZXQgdG9wT2Zmc2V0ID0gdG9wO1xyXG4gICAgICAgICAgICBpZiAoYWxpZ25tZW50ID09PSAnQ0VOVEVSJykge1xyXG4gICAgICAgICAgICAgICAgdG9wT2Zmc2V0ID0gdG9wICsgKGF2YWlsYWJsZSAtIHRyYW5zZm9ybS5oZWlnaHQpIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChhbGlnbm1lbnQgPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICB0b3BPZmZzZXQgPSBsYXlvdXRIZWlnaHQgLSBib3R0b20gLSB0cmFuc2Zvcm0uaGVpZ2h0O1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgaWYgKGFsaWdubWVudCA9PT0gJ1NUUkVUQ0gnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdHJhbnNmb3JtLnNldENvbnRlbnRTaXplKHRyYW5zZm9ybS53aWR0aCwgYXZhaWxhYmxlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwb3NpdGlvbi55ID0gcGFyZW50SGVpZ2h0ICogKDEgLSBwYXJlbnRBbmNob3IueSlcclxuICAgICAgICAgICAgICAgIC0gdG9wT2Zmc2V0XHJcbiAgICAgICAgICAgICAgICAtIHRyYW5zZm9ybS5oZWlnaHQgKiAoMSAtICh0cmFuc2Zvcm0uYW5jaG9yUG9pbnQ/LnkgPz8gMC41KSk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29uc3QgYXZhaWxhYmxlID0gTWF0aC5tYXgoMCwgbGF5b3V0V2lkdGggLSBsZWZ0IC0gcmlnaHQpO1xyXG4gICAgICAgICAgICBsZXQgbGVmdE9mZnNldCA9IGxlZnQ7XHJcbiAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdDRU5URVInKSB7XHJcbiAgICAgICAgICAgICAgICBsZWZ0T2Zmc2V0ID0gbGVmdCArIChhdmFpbGFibGUgLSB0cmFuc2Zvcm0ud2lkdGgpIC8gMjtcclxuICAgICAgICAgICAgfSBlbHNlIGlmIChhbGlnbm1lbnQgPT09ICdNQVgnKSB7XHJcbiAgICAgICAgICAgICAgICBsZWZ0T2Zmc2V0ID0gbGF5b3V0V2lkdGggLSByaWdodCAtIHRyYW5zZm9ybS53aWR0aDtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGlmIChhbGlnbm1lbnQgPT09ICdTVFJFVENIJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zZm9ybS5zZXRDb250ZW50U2l6ZShhdmFpbGFibGUsIHRyYW5zZm9ybS5oZWlnaHQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBvc2l0aW9uLnggPSBsZWZ0T2Zmc2V0XHJcbiAgICAgICAgICAgICAgICAtIHBhcmVudFdpZHRoICogcGFyZW50QW5jaG9yLnhcclxuICAgICAgICAgICAgICAgICsgdHJhbnNmb3JtLndpZHRoICogKHRyYW5zZm9ybS5hbmNob3JQb2ludD8ueCA/PyAwLjUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjaGlsZC5zZXRQb3NpdGlvbihwb3NpdGlvbik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbmZpZ3VyZUNsaXAobm9kZTogYW55LCBzcGVjOiBTY2VuZU5vZGVTcGVjLCBjYzogYW55KTogdm9pZCB7XHJcbiAgICBjb25zdCBncmFwaGljcyA9IG5vZGUuZ2V0Q29tcG9uZW50KGNjLkdyYXBoaWNzKTtcclxuICAgIGlmIChncmFwaGljcykge1xyXG4gICAgICAgIGdyYXBoaWNzLmVuYWJsZWQgPSB0cnVlO1xyXG4gICAgICAgIGdyYXBoaWNzLmNsZWFyKCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBtYXNrID0gbm9kZS5nZXRDb21wb25lbnQoY2MuTWFzaykgPz8gbm9kZS5hZGRDb21wb25lbnQoY2MuTWFzayk7XHJcbiAgICBtYXNrLnR5cGUgPSBzcGVjLmZpZ21hVHlwZSA9PT0gJ0VMTElQU0UnXHJcbiAgICAgICAgPyBjYy5NYXNrLlR5cGUuR1JBUEhJQ1NfRUxMSVBTRSA/PyBjYy5NYXNrLlR5cGUuRUxMSVBTRVxyXG4gICAgICAgIDogY2MuTWFzay5UeXBlLkdSQVBISUNTX1JFQ1QgPz8gY2MuTWFzay5UeXBlLlJFQ1Q7XHJcbiAgICBtYXNrLmludmVydGVkID0gZmFsc2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsaXBzR2VuZXJhdGVkQ2hpbGRyZW4oc3BlYzogU2NlbmVOb2RlU3BlYyk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHNwZWMuY2xpcHNDb250ZW50XHJcbiAgICAgICAgJiYgc3BlYy5raW5kICE9PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAmJiBzcGVjLmNoaWxkcmVuLmxlbmd0aCA+IDBcclxuICAgICAgICAmJiBzcGVjLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJztcclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlQnV0dG9uKG5vZGU6IGFueSwgc3BlYzogU2NlbmVOb2RlU3BlYywgY2M6IGFueSk6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCA9PT0gJ2J1dHRvbicpIHtcclxuICAgICAgICBjb25zdCBidXR0b24gPSBub2RlLmdldENvbXBvbmVudChjYy5CdXR0b24pID8/IG5vZGUuYWRkQ29tcG9uZW50KGNjLkJ1dHRvbik7XHJcbiAgICAgICAgYnV0dG9uLnRhcmdldCA9IG5vZGU7XHJcbiAgICAgICAgYnV0dG9uLnRyYW5zaXRpb24gPSBjYy5CdXR0b24uVHJhbnNpdGlvbi5TQ0FMRTtcclxuICAgICAgICBidXR0b24uem9vbVNjYWxlID0gMC45O1xyXG4gICAgICAgIGJ1dHRvbi5kdXJhdGlvbiA9IDAuMTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY29uZmlndXJlU2Nyb2xsKFxyXG4gICAgbm9kZTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHRyYW5zZm9ybTogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbiAgICBndWFyZD86IFByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4pOiBhbnkge1xyXG4gICAgaWYgKHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnKSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCB7IE5vZGUsIFVJVHJhbnNmb3JtLCBNYXNrLCBTY3JvbGxWaWV3IH0gPSBjYztcclxuICAgIGxldCB2aWV3ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgndmlldycpO1xyXG4gICAgbGV0IGNvbnRlbnQgPSB2aWV3Py5nZXRDaGlsZEJ5TmFtZSgnY29udGVudCcpID8/IG51bGw7XHJcbiAgICBpZiAodmlldyAmJiBndWFyZCkge1xyXG4gICAgICAgIGFzc2VydE93bmVkSGVscGVyU3VidHJlZSh2aWV3LCBndWFyZCk7XHJcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcclxuICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJOb2RlKGNvbnRlbnQsIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY3JvbGwgPSBub2RlLmdldENvbXBvbmVudChTY3JvbGxWaWV3KSA/PyBub2RlLmFkZENvbXBvbmVudChTY3JvbGxWaWV3KTtcclxuICAgIGlmICghdmlldykge1xyXG4gICAgICAgIHZpZXcgPSBuZXcgTm9kZSgndmlldycpO1xyXG4gICAgICAgIHZpZXcubGF5ZXIgPSBub2RlLmxheWVyO1xyXG4gICAgICAgIG5vZGUuYWRkQ2hpbGQodmlldyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2aWV3VHJhbnNmb3JtID0gdmlldy5nZXRDb21wb25lbnQoVUlUcmFuc2Zvcm0pID8/IHZpZXcuYWRkQ29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgIHZpZXdUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgdmlld1RyYW5zZm9ybS5zZXRDb250ZW50U2l6ZSh0cmFuc2Zvcm0uY29udGVudFNpemUud2lkdGgsIHRyYW5zZm9ybS5jb250ZW50U2l6ZS5oZWlnaHQpO1xyXG4gICAgdmlldy5zZXRQb3NpdGlvbigwLCAwLCAwKTtcclxuICAgIGNvbnN0IG1hc2sgPSB2aWV3LmdldENvbXBvbmVudChNYXNrKSA/PyB2aWV3LmFkZENvbXBvbmVudChNYXNrKTtcclxuICAgIG1hc2sudHlwZSA9IE1hc2suVHlwZS5HUkFQSElDU19SRUNUID8/IE1hc2suVHlwZS5SRUNUO1xyXG4gICAgaWYgKCFjb250ZW50KSB7XHJcbiAgICAgICAgY29udGVudCA9IG5ldyBOb2RlKCdjb250ZW50Jyk7XHJcbiAgICAgICAgY29udGVudC5sYXllciA9IG5vZGUubGF5ZXI7XHJcbiAgICAgICAgdmlldy5hZGRDaGlsZChjb250ZW50KTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRlbnRUcmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSkgPz8gY29udGVudC5hZGRDb21wb25lbnQoVUlUcmFuc2Zvcm0pO1xyXG4gICAgY29uc3QgcHJldmlvdXNMYXlvdXQgPSBjb250ZW50LmdldENvbXBvbmVudChjYy5MYXlvdXQpO1xyXG4gICAgY29uc3QgbmV4dExheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgIGlmIChwcmV2aW91c0xheW91dCAmJiAoIW5leHRMYXlvdXRNb2RlIHx8IG5leHRMYXlvdXRNb2RlID09PSAnTk9ORScpKSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KHByZXZpb3VzTGF5b3V0LCBndWFyZCwgY29udGVudC5uYW1lKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29udGVudC5yZW1vdmVDb21wb25lbnQocHJldmlvdXNMYXlvdXQpO1xyXG4gICAgfVxyXG4gICAgY29udGVudFRyYW5zZm9ybS5zZXRBbmNob3JQb2ludCgwLjUsIDAuNSk7XHJcbiAgICBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KGNvbnRlbnQsIGNvbnRlbnRUcmFuc2Zvcm0sIHNwZWMsIHRyYW5zZm9ybSwgc2NhbGUpO1xyXG4gICAgY29uc3QgbGVnYWN5ID0gbm9kZS5nZXRDaGlsZEJ5TmFtZSgnX19GaWdtYUNvbnRlbnQnKTtcclxuICAgIGlmIChsZWdhY3kgJiYgbGVnYWN5ICE9PSBjb250ZW50KSB7XHJcbiAgICAgICAgaWYgKGd1YXJkKSB7XHJcbiAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShsZWdhY3ksIGd1YXJkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBbLi4ubGVnYWN5LmNoaWxkcmVuXSkge1xyXG4gICAgICAgICAgICBzZXRQYXJlbnRLZWVwaW5nV29ybGQoY2hpbGQsIGNvbnRlbnQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZWdhY3kucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgIGxlZ2FjeS5kZXN0cm95KCk7XHJcbiAgICB9XHJcbiAgICAvLyBDb2NvcyBDcmVhdG9yIDMuOC43IGV4cGVjdHMgdGhlIGNvbnRlbnQgTm9kZSBoZXJlLiBTY3JvbGxWaWV3LnZpZXcgaXMgYVxyXG4gICAgLy8gZ2V0dGVyIGRlcml2ZWQgZnJvbSBjb250ZW50LnBhcmVudCBhbmQgbXVzdCBuZXZlciBiZSBhc3NpZ25lZCBkaXJlY3RseS5cclxuICAgIGlmIChzY3JvbGwuY29udGVudCA9PT0gY29udGVudCkge1xyXG4gICAgICAgIHNjcm9sbC5jb250ZW50ID0gbnVsbDtcclxuICAgIH1cclxuICAgIHNjcm9sbC5jb250ZW50ID0gY29udGVudDtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgc2Nyb2xsLmhvcml6b250YWwgPSBheGVzLmhvcml6b250YWw7XHJcbiAgICBzY3JvbGwudmVydGljYWwgPSBheGVzLnZlcnRpY2FsO1xyXG4gICAgcmV0dXJuIGNvbnRlbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNjcm9sbEF4ZXMoc3BlYzogU2NlbmVOb2RlU3BlYyk6IHsgaG9yaXpvbnRhbDogYm9vbGVhbjsgdmVydGljYWw6IGJvb2xlYW4gfSB7XHJcbiAgICBjb25zdCBkaXJlY3Rpb24gPSBzcGVjLm92ZXJmbG93RGlyZWN0aW9uICYmIHNwZWMub3ZlcmZsb3dEaXJlY3Rpb24gIT09ICdOT05FJ1xyXG4gICAgICAgID8gc3BlYy5vdmVyZmxvd0RpcmVjdGlvbi50cmltKCkudG9VcHBlckNhc2UoKVxyXG4gICAgICAgIDogJ1ZFUlRJQ0FMX1NDUk9MTElORyc7XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTCcgfHwgZGlyZWN0aW9uID09PSAnSE9SSVpPTlRBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoZGlyZWN0aW9uID09PSAnQk9USCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTCdcclxuICAgICAgICB8fCBkaXJlY3Rpb24gPT09ICdIT1JJWk9OVEFMX0FORF9WRVJUSUNBTF9TQ1JPTExJTkcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgaG9yaXpvbnRhbDogdHJ1ZSwgdmVydGljYWw6IHRydWUgfTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGhvcml6b250YWw6IGZhbHNlLCB2ZXJ0aWNhbDogdHJ1ZSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaXplQW5kUG9zaXRpb25TY3JvbGxDb250ZW50KFxyXG4gICAgY29udGVudDogYW55LFxyXG4gICAgY29udGVudFRyYW5zZm9ybTogYW55LFxyXG4gICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgIHZpZXdwb3J0OiBhbnksXHJcbiAgICBzY2FsZTogbnVtYmVyLFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpZXdwb3J0V2lkdGggPSBNYXRoLm1heCgwLCBOdW1iZXIodmlld3BvcnQuY29udGVudFNpemU/LndpZHRoKSB8fCAwKTtcclxuICAgIGNvbnN0IHZpZXdwb3J0SGVpZ2h0ID0gTWF0aC5tYXgoMCwgTnVtYmVyKHZpZXdwb3J0LmNvbnRlbnRTaXplPy5oZWlnaHQpIHx8IDApO1xyXG4gICAgY29uc3QgY2hpbGRSaWdodCA9IHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT5cclxuICAgICAgICAoY2hpbGQuZnJhbWUueCAtIHNwZWMuZnJhbWUueCArIGNoaWxkLmZyYW1lLndpZHRoKSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGNoaWxkQm90dG9tID0gc3BlYy5jaGlsZHJlbi5tYXAoKGNoaWxkKSA9PlxyXG4gICAgICAgIChjaGlsZC5mcmFtZS55IC0gc3BlYy5mcmFtZS55ICsgY2hpbGQuZnJhbWUuaGVpZ2h0KSAqIHNjYWxlKTtcclxuICAgIGNvbnN0IGF4ZXMgPSBzY3JvbGxBeGVzKHNwZWMpO1xyXG4gICAgY29uc3QgY29udGVudFdpZHRoID0gYXhlcy5ob3Jpem9udGFsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydFdpZHRoLCAwLCAuLi5jaGlsZFJpZ2h0KVxyXG4gICAgICAgIDogdmlld3BvcnRXaWR0aDtcclxuICAgIGNvbnN0IGNvbnRlbnRIZWlnaHQgPSBheGVzLnZlcnRpY2FsXHJcbiAgICAgICAgPyBNYXRoLm1heCh2aWV3cG9ydEhlaWdodCwgMCwgLi4uY2hpbGRCb3R0b20pXHJcbiAgICAgICAgOiB2aWV3cG9ydEhlaWdodDtcclxuICAgIGNvbnRlbnRUcmFuc2Zvcm0uc2V0Q29udGVudFNpemUoY29udGVudFdpZHRoLCBjb250ZW50SGVpZ2h0KTtcclxuICAgIC8vIEJvdGggaGVscGVycyB1c2UgQ29jb3MnIGRlZmF1bHQgY2VudGVyIGFuY2hvci4gTW92ZSBhbiBvdmVyc2l6ZWQgY29udGVudFxyXG4gICAgLy8gbm9kZSBzbyBpdHMgdG9wLWxlZnQgc3RpbGwgY29pbmNpZGVzIHdpdGggdGhlIHZpZXdwb3J0J3MgdG9wLWxlZnQuXHJcbiAgICBjb250ZW50LnNldFBvc2l0aW9uKFxyXG4gICAgICAgIChjb250ZW50V2lkdGggLSB2aWV3cG9ydFdpZHRoKSAvIDIsXHJcbiAgICAgICAgKHZpZXdwb3J0SGVpZ2h0IC0gY29udGVudEhlaWdodCkgLyAyLFxyXG4gICAgICAgIDAsXHJcbiAgICApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5hbGl6ZVNjcm9sbChcclxuICAgIG5vZGU6IGFueSxcclxuICAgIHNwZWM6IFNjZW5lTm9kZVNwZWMsXHJcbiAgICBjb250ZW50OiBhbnksXHJcbiAgICB2aWV3cG9ydDogYW55LFxyXG4gICAgc2NhbGU6IG51bWJlcixcclxuICAgIGNjOiBhbnksXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKHNwZWMua2luZCAhPT0gJ3Njcm9sbFZpZXcnIHx8IGNvbnRlbnQgPT09IG5vZGUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCB0cmFuc2Zvcm0gPSBjb250ZW50LmdldENvbXBvbmVudChjYy5VSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIXRyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHNpemVBbmRQb3NpdGlvblNjcm9sbENvbnRlbnQoY29udGVudCwgdHJhbnNmb3JtLCBzcGVjLCB2aWV3cG9ydCwgc2NhbGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3VudFNwZWNzKHNwZWNzOiBTY2VuZU5vZGVTcGVjW10pOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHNwZWNzLnJlZHVjZSgodG90YWwsIHNwZWMpID0+IHRvdGFsICsgMSArIGNvdW50U3BlY3Moc3BlYy5jaGlsZHJlbiksIDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjZW50ZXJJbkNhbnZhcyhub2RlOiBhbnksIGNhbnZhczogYW55LCBVSVRyYW5zZm9ybTogYW55LCBWZWMzOiBhbnkpOiB2b2lkIHtcclxuICAgIGNvbnN0IG5vZGVUcmFuc2Zvcm0gPSBub2RlLmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBjb25zdCBjYW52YXNUcmFuc2Zvcm0gPSBjYW52YXM/LmdldENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICBpZiAoIW5vZGVUcmFuc2Zvcm0gfHwgIWNhbnZhc1RyYW5zZm9ybSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGNhbnZhc1NpemUgPSBjYW52YXNUcmFuc2Zvcm0uY29udGVudFNpemUgPz8ge1xyXG4gICAgICAgIHdpZHRoOiBjYW52YXNUcmFuc2Zvcm0ud2lkdGgsXHJcbiAgICAgICAgaGVpZ2h0OiBjYW52YXNUcmFuc2Zvcm0uaGVpZ2h0LFxyXG4gICAgfTtcclxuICAgIGNvbnN0IHdpZHRoID0gTnVtYmVyKGNhbnZhc1NpemU/LndpZHRoKSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS53aWR0aCkgOiA2NDA7XHJcbiAgICBjb25zdCBoZWlnaHQgPSBOdW1iZXIoY2FudmFzU2l6ZT8uaGVpZ2h0KSA+IDAgPyBOdW1iZXIoY2FudmFzU2l6ZS5oZWlnaHQpIDogMTEzNjtcclxuICAgIGNvbnN0IGNhbnZhc0FuY2hvciA9IGNhbnZhc1RyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCBub2RlQW5jaG9yID0gbm9kZVRyYW5zZm9ybS5hbmNob3JQb2ludCA/PyB7IHg6IDAuNSwgeTogMC41IH07XHJcbiAgICBjb25zdCB4ID0gd2lkdGggKiAoMC41IC0gY2FudmFzQW5jaG9yLngpXHJcbiAgICAgICAgLSBub2RlVHJhbnNmb3JtLndpZHRoICogKDAuNSAtIG5vZGVBbmNob3IueCk7XHJcbiAgICBjb25zdCB5ID0gaGVpZ2h0ICogKDAuNSAtIGNhbnZhc0FuY2hvci55KVxyXG4gICAgICAgIC0gbm9kZVRyYW5zZm9ybS5oZWlnaHQgKiAoMC41IC0gbm9kZUFuY2hvci55KTtcclxuICAgIG5vZGUuc2V0UG9zaXRpb24obmV3IFZlYzMoeCwgeSwgbm9kZS5wb3NpdGlvbj8ueiA/PyAwKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVDb21wb25lbnRzKG5vZGU6IGFueSk6IGFueVtdIHtcclxuICAgIGNvbnN0IHZhbHVlID0gbm9kZT8uY29tcG9uZW50cyA/PyBub2RlPy5fY29tcG9uZW50cztcclxuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSA/IHZhbHVlIDogW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlb3JkZXJGaWdtYUNoaWxkcmVuKHBhcmVudDogYW55LCBvcmRlcmVkTm9kZXM6IGFueVtdKTogdm9pZCB7XHJcbiAgICBjb25zdCBkZXNpcmVkID0gWy4uLm5ldyBTZXQob3JkZXJlZE5vZGVzLmZpbHRlcihCb29sZWFuKSldO1xyXG4gICAgaWYgKCFkZXNpcmVkLmxlbmd0aCB8fCB0eXBlb2YgZGVzaXJlZFswXT8uc2V0U2libGluZ0luZGV4ICE9PSAnZnVuY3Rpb24nKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgLy8gRmlnbWEtb3duZWQgY2hpbGRyZW4gYXJlIGtlcHQgaW4gRmlnbWEgb3JkZXIuIFVzZXItYXV0aG9yZWQgY2hpbGRyZW4gYXJlXHJcbiAgICAvLyBuZXZlciByZW9yZGVyZWQgYWdhaW5zdCBvbmUgYW5vdGhlcjsgdGhleSBmb2xsb3cgdGhlIG1hbmFnZWQgYmxvY2suXHJcbiAgICBkZXNpcmVkLmZvckVhY2goKG5vZGUsIGluZGV4KSA9PiBub2RlLnNldFNpYmxpbmdJbmRleChpbmRleCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVTdGFsZVByZWZhYk5vZGVzKFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgcHJldmlvdXNOb2RlRmlsZUlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4gICAgcHJldmlvdXNDb21wb25lbnRGaWxlSWRzOiBTZXQ8c3RyaW5nPixcclxuICAgIHJldGFpbmVkTm9kZUZpbGVJZHM6IFNldDxzdHJpbmc+LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IGluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCk7XHJcbiAgICBjb25zdCBzdGFsZSA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGZpbGVJZCBvZiBwcmV2aW91c05vZGVGaWxlSWRzKSB7XHJcbiAgICAgICAgaWYgKGZpbGVJZCA9PT0gbm9kZVByZWZhYkZpbGVJZChwcmVmYWJSb290KSB8fCByZXRhaW5lZE5vZGVGaWxlSWRzLmhhcyhmaWxlSWQpKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gaW5kZXguZ2V0KGZpbGVJZCk7XHJcbiAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgc3RhbGUuc2V0KGZpbGVJZCwgbm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3Qgc3RhbGVJZHMgPSBuZXcgU2V0KHN0YWxlLmtleXMoKSk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygc3RhbGUudmFsdWVzKCkpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBub2RlQ29tcG9uZW50cyhub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wb25lbnRGaWxlSWQgPSBjb21wb25lbnRQcmVmYWJGaWxlSWQoY29tcG9uZW50KTtcclxuICAgICAgICAgICAgaWYgKCFjb21wb25lbnRGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50RmlsZUlkcy5oYXMoY29tcG9uZW50RmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgIGDlvoXliKDpmaTnmoQgRmlnbWEg6IqC54K54oCcJHtub2RlLm5hbWV94oCd5ZCr5pyJ5omL5bel57uE5Lu277yM5bey5YGc5q2i5ZCM5q2l5Lul6Ziy5q2i5pWw5o2u5Lii5aSx44CCYCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYWx2YWdlTWFudWFsRGVzY2VuZGFudHMgPSAoY29udGFpbmVyOiBhbnksIHN1cnZpdm9yUGFyZW50OiBhbnkpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIFsuLi5jb250YWluZXIuY2hpbGRyZW5dKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkRmlsZUlkID0gbm9kZVByZWZhYkZpbGVJZChjaGlsZCk7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZEZpbGVJZFxyXG4gICAgICAgICAgICAgICAgJiYgKHByZXZpb3VzTm9kZUZpbGVJZHMuaGFzKGNoaWxkRmlsZUlkKSB8fCBwcmV2aW91c0hlbHBlckZpbGVJZHMuaGFzKGNoaWxkRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgICAgIHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyhjaGlsZCwgc3Vydml2b3JQYXJlbnQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2V0UGFyZW50S2VlcGluZ1dvcmxkKGNoaWxkLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgZm9yIChjb25zdCBbZmlsZUlkLCBub2RlXSBvZiBzdGFsZSkge1xyXG4gICAgICAgIGxldCBhbmNlc3RvciA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIGxldCBuZXN0ZWRVbmRlclN0YWxlID0gZmFsc2U7XHJcbiAgICAgICAgd2hpbGUgKGFuY2VzdG9yICYmIGFuY2VzdG9yICE9PSBwcmVmYWJSb290LnBhcmVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBhbmNlc3RvckZpbGVJZCA9IG5vZGVQcmVmYWJGaWxlSWQoYW5jZXN0b3IpO1xyXG4gICAgICAgICAgICBpZiAoYW5jZXN0b3JGaWxlSWQgJiYgc3RhbGVJZHMuaGFzKGFuY2VzdG9yRmlsZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgbmVzdGVkVW5kZXJTdGFsZSA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhbmNlc3RvciA9IGFuY2VzdG9yLnBhcmVudDtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG5lc3RlZFVuZGVyU3RhbGUgfHwgIW5vZGUucGFyZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBzdXJ2aXZvclBhcmVudCA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIHNhbHZhZ2VNYW51YWxEZXNjZW5kYW50cyhub2RlLCBzdXJ2aXZvclBhcmVudCk7XHJcbiAgICAgICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgICAgICBzdGFsZS5kZWxldGUoZmlsZUlkKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gY2FwdHVyZVByZWZhYlN5bmMoXHJcbiAgICBwcmVmYWJSb290OiBhbnksXHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgcHJldmlvdXM6IFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICBwcmVleGlzdGluZ05vZGVVdWlkczogU2V0PHN0cmluZz4sXHJcbiAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IFNldDxhbnk+LFxyXG4gICAgZ2VuZXJhdGVkQ2xhc3NlczogYW55W10sXHJcbiAgICBjYzogYW55LFxyXG4pOiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlIHtcclxuICAgIGNvbnN0IHByZXZpb3VzQ29tcG9uZW50cyA9IG5ldyBTZXQocHJldmlvdXMubWFuYWdlZENvbXBvbmVudEZpbGVJZHMpO1xyXG4gICAgY29uc3QgcHJldmlvdXNIZWxwZXJzID0gbmV3IFNldChwcmV2aW91cy5tYW5hZ2VkSGVscGVyRmlsZUlkcyk7XHJcbiAgICBjb25zdCBub2RlRmlsZUlkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgY29uc3QgbWFuYWdlZE5vZGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBtYW5hZ2VkQ29tcG9uZW50cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgbWFuYWdlZEhlbHBlcnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG1hcHBlZFV1aWRzID0gbmV3IFNldChPYmplY3QudmFsdWVzKG5vZGVNYXApKTtcclxuICAgIGNvbnN0IG1hbmFnZWRSdW50aW1lTm9kZXMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xyXG5cclxuICAgIGZvciAoY29uc3QgW2ZpZ21hSWQsIHV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKG5vZGVNYXApKSB7XHJcbiAgICAgICAgaWYgKGZpZ21hSWQgPT09ICdfX3Jvb3RfXycpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kQnlVdWlkKHByZWZhYlJvb3QsIHV1aWQpO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlkIzmraXnu5PmnpznvLrlsJEgRmlnbWEg6IqC54K577yaJHtmaWdtYUlkfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaWxlSWQgPSBlbnN1cmVOb2RlUHJlZmFiSW5mbyhub2RlLCBwcmVmYWJSb290LCBjYyk7XHJcbiAgICAgICAgbm9kZUZpbGVJZHNbZmlnbWFJZF0gPSBmaWxlSWQ7XHJcbiAgICAgICAgbWFuYWdlZE5vZGVzLmFkZChmaWxlSWQpO1xyXG4gICAgICAgIG1hbmFnZWRSdW50aW1lTm9kZXMuc2V0KG5vZGUudXVpZCwgbm9kZSk7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbWFuYWdlZENvbXBvbmVudFR5cGVzID0gbmV3IFNldChbY2MuVUlUcmFuc2Zvcm0sIC4uLmdlbmVyYXRlZENsYXNzZXNdKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBtYW5hZ2VkUnVudGltZU5vZGVzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgaWYgKCFtYW5hZ2VkQ29tcG9uZW50VHlwZXMuaGFzKGNvbXBvbmVudC5jb25zdHJ1Y3RvcikpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nRmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmIChwcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudClcclxuICAgICAgICAgICAgICAgICYmICghZXhpc3RpbmdGaWxlSWQgfHwgIXByZXZpb3VzQ29tcG9uZW50cy5oYXMoZXhpc3RpbmdGaWxlSWQpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudHMuYWRkKGVuc3VyZUNvbXBvbmVudFByZWZhYkluZm8oY29tcG9uZW50LCBjYykpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICB3YWxrTm9kZXMocHJlZmFiUm9vdCwgKG5vZGUpID0+IHtcclxuICAgICAgICBpZiAobWFwcGVkVXVpZHMuaGFzKG5vZGUudXVpZCkgfHwgbm9kZSA9PT0gcHJlZmFiUm9vdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBhcmVudCA9IG5vZGUucGFyZW50O1xyXG4gICAgICAgIGlmICghcGFyZW50XHJcbiAgICAgICAgICAgIHx8ICghbWFwcGVkVXVpZHMuaGFzKHBhcmVudC51dWlkKSAmJiAhbWFuYWdlZEhlbHBlclJ1bnRpbWVVdWlkcy5oYXMocGFyZW50LnV1aWQpKVxyXG4gICAgICAgICAgICB8fCAhaXNHZW5lcmF0ZWRIZWxwZXJOb2RlKG5vZGUsIHBhcmVudCwgY2MpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdGaWxlSWQgPSBub2RlUHJlZmFiRmlsZUlkKG5vZGUpO1xyXG4gICAgICAgIGlmIChwcmVleGlzdGluZ05vZGVVdWlkcy5oYXMobm9kZS51dWlkKVxyXG4gICAgICAgICAgICAmJiAoIWV4aXN0aW5nRmlsZUlkIHx8ICFwcmV2aW91c0hlbHBlcnMuaGFzKGV4aXN0aW5nRmlsZUlkKSkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgYOiKgueCueKAnCR7cGFyZW50Lm5hbWV94oCd5LiL5a2Y5Zyo5LiO5a+85YWl6L6F5Yqp6IqC54K55ZCM5ZCN55qE5omL5bel6IqC54K54oCcJHtub2RlLm5hbWV94oCd77yM5bey5YGc5q2i5ZCM5q2l44CCYCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmlsZUlkID0gZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgcHJlZmFiUm9vdCwgY2MpO1xyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJzLmFkZChmaWxlSWQpO1xyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJSdW50aW1lVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBjb21wb25lbnQgb2Ygbm9kZUNvbXBvbmVudHMobm9kZSkpIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcG9uZW50RmlsZUlkID0gY29tcG9uZW50UHJlZmFiRmlsZUlkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgIGlmIChwcmVleGlzdGluZ0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudClcclxuICAgICAgICAgICAgICAgICYmICghY29tcG9uZW50RmlsZUlkIHx8ICFwcmV2aW91c0NvbXBvbmVudHMuaGFzKGNvbXBvbmVudEZpbGVJZCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50cy5hZGQoZW5zdXJlQ29tcG9uZW50UHJlZmFiSW5mbyhjb21wb25lbnQsIGNjKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBub2RlRmlsZUlkcyxcclxuICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IFsuLi5tYW5hZ2VkTm9kZXNdLFxyXG4gICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBbLi4ubWFuYWdlZENvbXBvbmVudHNdLFxyXG4gICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBbLi4ubWFuYWdlZEhlbHBlcnNdLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVmcmVzaFByZWZhYkxheW91dHMoXHJcbiAgICBzcGVjczogU2NlbmVOb2RlU3BlY1tdLFxyXG4gICAgcHJlZmFiUm9vdDogYW55LFxyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcclxuICAgIHNjYWxlOiBudW1iZXIsXHJcbiAgICBjYzogYW55LFxyXG4pOiB2b2lkIHtcclxuICAgIGNvbnN0IHZpc2l0ID0gKHNwZWM6IFNjZW5lTm9kZVNwZWMpID0+IHtcclxuICAgICAgICBjb25zdCB1dWlkID0gbm9kZU1hcFtzcGVjLmZpZ21hSWRdO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSB1dWlkID8gZmluZEJ5VXVpZChwcmVmYWJSb290LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGRQYXJlbnQgPSBzcGVjLmtpbmQgPT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICAgICA/IG5vZGUuZ2V0Q2hpbGRCeU5hbWUoJ3ZpZXcnKT8uZ2V0Q2hpbGRCeU5hbWUoJ2NvbnRlbnQnKSA/PyBub2RlXHJcbiAgICAgICAgICAgIDogbm9kZTtcclxuICAgICAgICBjb25zdCBsYXlvdXRNb2RlID0gc3BlYy5sYXlvdXQ/Lm1vZGU7XHJcbiAgICAgICAgY29uc3QgbGF5b3V0ID0gc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgbGF5b3V0TW9kZSAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORSdcclxuICAgICAgICAgICAgPyBjaGlsZFBhcmVudC5nZXRDb21wb25lbnQoY2MuTGF5b3V0KVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgbGF5b3V0Py51cGRhdGVMYXlvdXQoKTtcclxuICAgICAgICBpZiAobGF5b3V0KSB7XHJcbiAgICAgICAgICAgIGFwcGx5Q291bnRlckFsaWdubWVudChjaGlsZFBhcmVudCwgc3BlYywgbm9kZU1hcCwgc2NhbGUsIGNjKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNwZWMua2luZCA9PT0gJ3Njcm9sbFZpZXcnICYmIGNoaWxkUGFyZW50ICE9PSBub2RlKSB7XHJcbiAgICAgICAgICAgIGZpbmFsaXplU2Nyb2xsKFxyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIHNwZWMsXHJcbiAgICAgICAgICAgICAgICBjaGlsZFBhcmVudCxcclxuICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KGNjLlVJVHJhbnNmb3JtKSxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNwZWMuY2hpbGRyZW4uZm9yRWFjaCh2aXNpdCk7XHJcbiAgICB9O1xyXG4gICAgc3BlY3MuZm9yRWFjaCh2aXNpdCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVtaXRTY2VuZVByb2dyZXNzKFxyXG4gICAgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkLFxyXG4gICAgdmFsdWU6IG51bWJlcixcclxuICAgIG1lc3NhZ2U6IHN0cmluZyxcclxuKTogdm9pZCB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGF5bG9hZC5wYWNrYWdlTmFtZSwgJ3Byb2dyZXNzJywge1xyXG4gICAgICAgICAgICBwaGFzZTogJ3NjZW5lJyxcclxuICAgICAgICAgICAgdmFsdWUsXHJcbiAgICAgICAgICAgIG1lc3NhZ2UsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyDov5vluqblj43ppojkuI3lj6/nlKjml7bkuI3lupTkuK3mlq3lnLrmma/lr7zlhaXjgIJcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGxvYWQoKTogdm9pZCB7fVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHt9XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kcyA9IHtcclxuICAgIGluc3BlY3RQcmVmYWJDb250ZXh0KHBheWxvYWQ6IHtcclxuICAgICAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICAgICAgcm9vdEZpbGVJZD86IHN0cmluZztcclxuICAgIH0pOiBQcmVmYWJFZGl0aW5nU3RhdGUge1xyXG4gICAgICAgIHJldHVybiBwcmVmYWJFZGl0aW5nU3RhdGUocGF5bG9hZC5wcmVmYWJVdWlkLCBwYXlsb2FkLnJvb3RGaWxlSWQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnREb2N1bWVudChwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQpOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICAgICAgY29uc3QgY2MgPSByZXF1aXJlKCdjYycpIGFzIGFueTtcclxuICAgICAgICBjb25zdCB7XHJcbiAgICAgICAgICAgIGRpcmVjdG9yLFxyXG4gICAgICAgICAgICBOb2RlLFxyXG4gICAgICAgICAgICBVSVRyYW5zZm9ybSxcclxuICAgICAgICAgICAgQ2FudmFzLFxyXG4gICAgICAgICAgICBHcmFwaGljcyxcclxuICAgICAgICAgICAgU3ByaXRlLFxyXG4gICAgICAgICAgICBMYWJlbCxcclxuICAgICAgICAgICAgUmljaFRleHQsXHJcbiAgICAgICAgICAgIExhYmVsT3V0bGluZSxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBNYXNrLFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICAgICAgQ2FtZXJhLFxyXG4gICAgICAgIH0gPSBjYztcclxuICAgICAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICAgICAgaWYgKCFzY2VuZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeayoeacieaJk+W8gOeahOWcuuaZr+OAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVmYWJDb250ZXh0ID0gcGF5bG9hZC5wcmVmYWJDb250ZXh0O1xyXG4gICAgICAgIGxldCBwcmVmYWJSb290OiBhbnkgfCBudWxsID0gbnVsbDtcclxuICAgICAgICBpZiAocHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IHByZWZhYkVkaXRpbmdTdGF0ZShwcmVmYWJDb250ZXh0LnByZWZhYlV1aWQsIHByZWZhYkNvbnRleHQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDlsJrmnKrlronlhajmiZPlvIDvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwcmVmYWJSb290ID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2UuU2NlbmUucm9vdE5vZGU7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVJZEluZGV4ID0gcHJlZmFiRmlsZUlkSW5kZXgocHJlZmFiUm9vdCwgcHJlZmFiQ29udGV4dC5wcmVmYWJVdWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XHJcbiAgICAgICAgICAgICAgICBfX3Jvb3RfXzogcHJlZmFiUm9vdC51dWlkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtmaWdtYUlkLCBmaWxlSWRdIG9mIE9iamVjdC5lbnRyaWVzKHByZWZhYkNvbnRleHQuZXhpc3RpbmdOb2RlRmlsZUlkcykpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaWxlSWRJbmRleC5nZXQoZmlsZUlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZXhpc3RpbmdNYXBbZmlnbWFJZF0gPSBub2RlLnV1aWQ7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGF5bG9hZC51cGRhdGVFeGlzdGluZyA9IHRydWU7XHJcbiAgICAgICAgICAgIHBheWxvYWQuZXhpc3RpbmdNYXAgPSBleGlzdGluZ01hcDtcclxuICAgICAgICAgICAgcGF5bG9hZC5jZW50ZXJJbkNhbnZhcyA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyA9IG5ldyBTZXQ8YW55PigpO1xyXG4gICAgICAgIGlmIChwcmVmYWJSb290KSB7XHJcbiAgICAgICAgICAgIHdhbGtOb2RlcyhwcmVmYWJSb290LCAobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgICAgICBub2RlQ29tcG9uZW50cyhub2RlKS5mb3JFYWNoKChjb21wb25lbnQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYkNvbXBvbmVudHMuYWRkKGNvbXBvbmVudCk7XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gcGF5bG9hZC5yb290cy5tYXAoKHJvb3QpID0+IG5vcm1hbGl6ZVNjZW5lU3BlYyhyb290KSk7XHJcbiAgICAgICAgaWYgKHByZWZhYkNvbnRleHQgJiYgcm9vdHMubGVuZ3RoICE9PSAxKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeWPquWFgeiuuOS4gOS4qiBGaWdtYSBGcmFtZSDmoLnoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZmFsbGJhY2tQYXJlbnQgPSBwcmVmYWJSb290Py5wYXJlbnQgPz8gZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKSA/PyBzY2VuZTtcclxuICAgICAgICBjb25zdCBkaXJlY3RSb290ID0gcm9vdHMubGVuZ3RoID09PSAxO1xyXG4gICAgICAgIGNvbnN0IGNhbnZhcyA9IHByZWZhYlJvb3QgPyBudWxsIDogZmluZENhbnZhcyhzY2VuZSwgQ2FudmFzKTtcclxuICAgICAgICBjb25zdCBnZW5lcmF0ZWRDbGFzc2VzID0gW1xyXG4gICAgICAgICAgICBMYWJlbE91dGxpbmUsXHJcbiAgICAgICAgICAgIE1hc2ssXHJcbiAgICAgICAgICAgIEdyYXBoaWNzLFxyXG4gICAgICAgICAgICBTcHJpdGUsXHJcbiAgICAgICAgICAgIExhYmVsLFxyXG4gICAgICAgICAgICBSaWNoVGV4dCxcclxuICAgICAgICAgICAgTGF5b3V0LFxyXG4gICAgICAgICAgICBTY3JvbGxWaWV3LFxyXG4gICAgICAgICAgICBCdXR0b24sXHJcbiAgICAgICAgICAgIFVJT3BhY2l0eSxcclxuICAgICAgICBdO1xyXG4gICAgICAgIGNvbnN0IG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgICAgICBsZXQgY3JlYXRlZCA9IDA7XHJcbiAgICAgICAgbGV0IHVwZGF0ZWQgPSAwO1xyXG4gICAgICAgIGNvbnN0IHRvdGFsTm9kZXMgPSBNYXRoLm1heCgxLCBjb3VudFNwZWNzKHJvb3RzKSk7XHJcbiAgICAgICAgbGV0IGNvbXBsZXRlZE5vZGVzID0gMDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzID0gbmV3IFNldChwcmVmYWJDb250ZXh0Py5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyA/PyBbXSk7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNYW5hZ2VkSGVscGVycyA9IG5ldyBTZXQocHJlZmFiQ29udGV4dD8ubWFuYWdlZEhlbHBlckZpbGVJZHMgPz8gW10pO1xyXG4gICAgICAgIGNvbnN0IHByZWZhYk93bmVyc2hpcEd1YXJkOiBQcmVmYWJPd25lcnNoaXBHdWFyZCB8IHVuZGVmaW5lZCA9IHByZWZhYkNvbnRleHRcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0hlbHBlckZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZEhlbHBlcnMsXHJcbiAgICAgICAgICAgICAgICBwcmV2aW91c0NvbXBvbmVudEZpbGVJZHM6IHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ05vZGVVdWlkczogcHJlZXhpc3RpbmdQcmVmYWJOb2RlVXVpZHMsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ0NvbXBvbmVudHM6IHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuXHJcbiAgICAgICAgY29uc3QgZXhpc3RpbmdSb290VXVpZCA9IHBheWxvYWQudXBkYXRlRXhpc3RpbmdcclxuICAgICAgICAgICAgPyBwYXlsb2FkLmV4aXN0aW5nTWFwLl9fcm9vdF9fXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGxldCBleGlzdGluZ1Jvb3ROb2RlID0gZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIGV4aXN0aW5nUm9vdFV1aWQpXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAoZXhpc3RpbmdSb290Tm9kZT8uZ2V0Q29tcG9uZW50KENhbWVyYSkpIHtcclxuICAgICAgICAgICAgZXhpc3RpbmdSb290Tm9kZSA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIEluIGEgZGlyZWN0LXJvb3QgaW1wb3J0LCBfX3Jvb3RfXyBhbGlhc2VzIHRoZSBGaWdtYSByb290IFVVSUQuIEluIGFcclxuICAgICAgICAvLyBtdWx0aS1yb290IGltcG9ydCBpdCBpZGVudGlmaWVzIGEgc3ludGhldGljIHdyYXBwZXIgYW5kIG11c3QgbmV2ZXIgYmVcclxuICAgICAgICAvLyByZXVzZWQgYXMgb25lIG9mIGl0cyBvd24gY2hpbGRyZW4gd2hlbiB0aGUgcm9vdCBjb3VudCBjaGFuZ2VzLlxyXG4gICAgICAgIGNvbnN0IGV4aXN0aW5nUm9vdFdhc0RpcmVjdCA9IEJvb2xlYW4oZXhpc3RpbmdSb290VXVpZFxyXG4gICAgICAgICAgICAmJiBPYmplY3QuZW50cmllcyhwYXlsb2FkLmV4aXN0aW5nTWFwKS5zb21lKChbZmlnbWFJZCwgdXVpZF0pID0+XHJcbiAgICAgICAgICAgICAgICBmaWdtYUlkICE9PSAnX19yb290X18nICYmIHV1aWQgPT09IGV4aXN0aW5nUm9vdFV1aWQpKTtcclxuICAgICAgICBjb25zdCBwcmV2aW91c0RpcmVjdFJvb3QgPSBleGlzdGluZ1Jvb3RXYXNEaXJlY3QgPyBleGlzdGluZ1Jvb3ROb2RlIDogbnVsbDtcclxuICAgICAgICBjb25zdCBwcmV2aW91c1dyYXBwZXIgPSAhZXhpc3RpbmdSb290V2FzRGlyZWN0ID8gZXhpc3RpbmdSb290Tm9kZSA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgbWFwcGVkUm9vdFV1aWQgPSBkaXJlY3RSb290XHJcbiAgICAgICAgICAgID8gZXhpc3RpbmdVdWlkRm9yU3BlYyhwYXlsb2FkLmV4aXN0aW5nTWFwLCByb290c1swXSlcclxuICAgICAgICAgICAgOiAoIWV4aXN0aW5nUm9vdFdhc0RpcmVjdCA/IGV4aXN0aW5nUm9vdFV1aWQgOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGxldCBpbXBvcnRSb290ID0gcHJlZmFiUm9vdCA/PyAocGF5bG9hZC51cGRhdGVFeGlzdGluZyAmJiBtYXBwZWRSb290VXVpZFxyXG4gICAgICAgICAgICA/IGZpbmRCeVV1aWQoc2NlbmUsIG1hcHBlZFJvb3RVdWlkKVxyXG4gICAgICAgICAgICA6IG51bGwpO1xyXG4gICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBpbXBvcnRSb290Py5nZXRDb21wb25lbnQoQ2FtZXJhKSkge1xyXG4gICAgICAgICAgICBpbXBvcnRSb290ID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbGVnYWN5V3JhcHBlciA9IGRpcmVjdFJvb3RcclxuICAgICAgICAgICAgPyBwcmV2aW91c1dyYXBwZXIgPz8gKGltcG9ydFJvb3Q/LnBhcmVudD8ubmFtZS5zdGFydHNXaXRoKCdGaWdtYSDCtyAnKVxyXG4gICAgICAgICAgICAgICAgPyBpbXBvcnRSb290LnBhcmVudFxyXG4gICAgICAgICAgICAgICAgOiBudWxsKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgcmV1c2VkSW1wb3J0Um9vdCA9IEJvb2xlYW4oaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgY29uc3QgcGFyZW50ID0gZmFsbGJhY2tQYXJlbnQ7XHJcbiAgICAgICAgaWYgKCFkaXJlY3RSb290KSB7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0Um9vdCkge1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCA9IG5ldyBOb2RlKGBGaWdtYSDCtyAke2NsZWFuTmFtZShwYXlsb2FkLnJvb3ROYW1lKX1gKTtcclxuICAgICAgICAgICAgICAgIHBhcmVudC5hZGRDaGlsZChpbXBvcnRSb290KTtcclxuICAgICAgICAgICAgICAgIGNyZWF0ZWQgKz0gMTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QucGFyZW50ID0gcGFyZW50O1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5uYW1lID0gYEZpZ21hIMK3ICR7Y2xlYW5OYW1lKHBheWxvYWQucm9vdE5hbWUpfWA7XHJcbiAgICAgICAgICAgICAgICB1cGRhdGVkICs9IDE7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgcm9vdFRyYW5zZm9ybSA9IGltcG9ydFJvb3QuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKSA/PyBpbXBvcnRSb290LmFkZENvbXBvbmVudChVSVRyYW5zZm9ybSk7XHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm0uc2V0QW5jaG9yUG9pbnQoMC41LCAwLjUpO1xyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtLnNldENvbnRlbnRTaXplKFxyXG4gICAgICAgICAgICAgICAgcGF5bG9hZC5yb290RnJhbWUud2lkdGggKiBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcGF5bG9hZC5yb290RnJhbWUuaGVpZ2h0ICogcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaW1wb3J0Um9vdC5zZXRQb3NpdGlvbigwLCAwLCAwKTtcclxuICAgICAgICAgICAgbm9kZU1hcC5fX3Jvb3RfXyA9IGltcG9ydFJvb3QudXVpZDtcclxuICAgICAgICB9IGVsc2UgaWYgKCFpbXBvcnRSb290KSB7XHJcbiAgICAgICAgICAgIGltcG9ydFJvb3QgPSBuZXcgTm9kZShjbGVhbk5hbWUocm9vdHNbMF0ubmFtZSkpO1xyXG4gICAgICAgICAgICBwYXJlbnQuYWRkQ2hpbGQoaW1wb3J0Um9vdCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICAvLyBBIGNvbGxhcHNlZCBTY2VuZVNwZWMgY2FuIGludGVudGlvbmFsbHkgbWFwIHNldmVyYWwgRmlnbWEgSURzIHRvIGFcclxuICAgICAgICAvLyBzaW5nbGUgQ29jb3Mgbm9kZS4gSWYgYSBsYXRlciBpbXBvcnQgZXhwYW5kcyB0aGF0IHN1YnRyZWUgYWdhaW4sXHJcbiAgICAgICAgLy8gdGhvc2UgSURzIHN0aWxsIHBvaW50IGF0IHRoZSBzYW1lIG9sZCBVVUlELiBDbGFpbSBlYWNoIHJldXNhYmxlIG5vZGVcclxuICAgICAgICAvLyBvbmNlIHBlciBidWlsZCBzbyBhIGNoaWxkIGNhbiBuZXZlciByZXVzZSAoYW5kIHJlcGFyZW50KSBpdHMgcGFyZW50LlxyXG4gICAgICAgIGNvbnN0IGNsYWltZWROb2RlVXVpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICBjb25zdCBidWlsZCA9IGFzeW5jIChcclxuICAgICAgICAgICAgc3BlYzogU2NlbmVOb2RlU3BlYyxcclxuICAgICAgICAgICAgbm9kZVBhcmVudDogYW55LFxyXG4gICAgICAgICAgICBwcm92aWRlZE5vZGU/OiBhbnksXHJcbiAgICAgICAgKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgICAgIGxldCBub2RlID0gcHJvdmlkZWROb2RlID8/IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSAmJiBwYXlsb2FkLnVwZGF0ZUV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGZpZ21hSWQgb2YgZmlnbWFJZHNGb3JTcGVjKHNwZWMpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFwcGVkVXVpZCA9IHBheWxvYWQuZXhpc3RpbmdNYXBbZmlnbWFJZF07XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFwcGVkTm9kZSA9IG1hcHBlZFV1aWQgPyBmaW5kQnlVdWlkKHNjZW5lLCBtYXBwZWRVdWlkKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKG1hcHBlZE5vZGUgJiYgIWNsYWltZWROb2RlVXVpZHMuaGFzKG1hcHBlZE5vZGUudXVpZCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSA9IG1hcHBlZE5vZGU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobm9kZSAmJiBjbGFpbWVkTm9kZVV1aWRzLmhhcyhub2RlLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlID0gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGVkID0gQm9vbGVhbihub2RlKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlID0gbmV3IE5vZGUoY2xlYW5OYW1lKHNwZWMubmFtZSkpO1xyXG4gICAgICAgICAgICAgICAgY3JlYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlZCArPSAxO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChwcmVmYWJPd25lcnNoaXBHdWFyZCAmJiBleGlzdGVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleGlzdGluZ1RyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1RyYW5zZm9ybSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1RyYW5zZm9ybSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uICE9PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgaGVscGVyIG9mIG5vZGUuY2hpbGRyZW4uZmlsdGVyKChjaGlsZDogYW55KSA9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICBpc0dlbmVyYXRlZEhlbHBlck5vZGUoY2hpbGQsIG5vZGUsIGNjKVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB8fCAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgY2hpbGQubmFtZSA9PT0gJ3ZpZXcnKSkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0T3duZWRIZWxwZXJTdWJ0cmVlKGhlbHBlciwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycgJiYgaGVscGVyLm5hbWUgPT09ICd2aWV3Jykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY29udGVudCA9IGhlbHBlci5nZXRDaGlsZEJ5TmFtZT8uKCdjb250ZW50Jyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZShjb250ZW50LCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGhlbHBlci5uYW1lID09PSBUSUxFRF9NQVNLX05PREVfTkFNRSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGlsZWRTcHJpdGUgPSBoZWxwZXIuZ2V0Q2hpbGRCeU5hbWU/LihUSUxFRF9TUFJJVEVfTk9ERV9OQU1FKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aWxlZFNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkSGVscGVyTm9kZSh0aWxlZFNwcml0ZSwgcHJlZmFiT3duZXJzaGlwR3VhcmQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY29tcG9uZW50IG9mIG5vZGVDb21wb25lbnRzKG5vZGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChnZW5lcmF0ZWRDbGFzc2VzLmluY2x1ZGVzKGNvbXBvbmVudC5jb25zdHJ1Y3RvcikpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydE93bmVkR2VuZXJhdGVkQ29tcG9uZW50KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJPd25lcnNoaXBHdWFyZCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNsYWltZWROb2RlVXVpZHMuYWRkKG5vZGUudXVpZCk7XHJcbiAgICAgICAgICAgIGlmICghKHByZWZhYkNvbnRleHQgJiYgbm9kZSA9PT0gcHJlZmFiUm9vdCkpIHtcclxuICAgICAgICAgICAgICAgIG5vZGUucGFyZW50ID0gbm9kZVBhcmVudDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub2RlLm5hbWUgPSBjbGVhbk5hbWUoc3BlYy5uYW1lKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBmaWdtYUlkIG9mIGZpZ21hSWRzRm9yU3BlYyhzcGVjKSkge1xyXG4gICAgICAgICAgICAgICAgbm9kZU1hcFtmaWdtYUlkXSA9IG5vZGUudXVpZDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25maWd1cmVHZW9tZXRyeShub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcblxyXG4gICAgICAgICAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICByZW1vdmVPYnNvbGV0ZVNjcm9sbEhlbHBlcnMobm9kZSwgc3BlYywgY2MsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZU9ic29sZXRlTGFiZWxPdXRsaW5lKG5vZGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHByZXNlcnZlZCA9IGRlc2lyZWRHZW5lcmF0ZWRDb21wb25lbnRzKHNwZWMsIGNjKTtcclxuICAgICAgICAgICAgICAgIC8vIE1hc2sgb3ducyBhbmQgZGlzYWJsZXMgaXRzIHNoYXJlZCBHcmFwaGljcyBkdXJpbmcgdGhlXHJcbiAgICAgICAgICAgICAgICAvLyBkZWZlcnJlZCBvbkRpc2FibGUgcGhhc2UuIElmIGNsaXBwaW5nIHdhcyByZW1vdmVkIGJ1dCBhXHJcbiAgICAgICAgICAgICAgICAvLyBub3JtYWwgR3JhcGhpY3MgcmVuZGVyZXIgaXMgc3RpbGwgZGVzaXJlZCwgcmVjcmVhdGUgdGhhdFxyXG4gICAgICAgICAgICAgICAgLy8gcmVuZGVyZXIgb25seSBhZnRlciB0aGUgb2xkIE1hc2sgbGlmZWN5Y2xlIGhhcyBjb21wbGV0ZWQuXHJcbiAgICAgICAgICAgICAgICBpZiAoIXByZXNlcnZlZC5oYXMoTWFzaylcclxuICAgICAgICAgICAgICAgICAgICAmJiBub2RlLmdldENvbXBvbmVudChNYXNrKVxyXG4gICAgICAgICAgICAgICAgICAgICYmIHByZXNlcnZlZC5oYXMoR3JhcGhpY3MpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcHJlc2VydmVkLmRlbGV0ZShHcmFwaGljcyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdmVkUmVuZGVyQ29tcG9uZW50ID0gcmVtb3ZlR2VuZXJhdGVkQ29tcG9uZW50cyhcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGdlbmVyYXRlZENsYXNzZXMsXHJcbiAgICAgICAgICAgICAgICAgICAgcHJlc2VydmVkLFxyXG4gICAgICAgICAgICAgICAgICAgIFtHcmFwaGljcywgU3ByaXRlLCBMYWJlbCwgUmljaFRleHRdLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZWZhYkNvbnRleHQgPyBwcmV2aW91c01hbmFnZWRDb21wb25lbnRzIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZW1vdmVkUmVuZGVyQ29tcG9uZW50KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgd2FpdEZvckRlZmVycmVkQ29tcG9uZW50UmVtb3ZhbCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmVtb3ZlR2VuZXJhdGVkQmFja2dyb3VuZChub2RlLCBwcmVmYWJPd25lcnNoaXBHdWFyZCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0aWxlZFNwcml0ZUhlbHBlciA9IHVzZXNUaWxlZFNwcml0ZUhlbHBlcihzcGVjKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGlsZWRTcHJpdGVIZWxwZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICByZW1vdmVHZW5lcmF0ZWRUaWxlZE5vZGVzKG5vZGUsIHByZWZhYk93bmVyc2hpcEd1YXJkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNsaXBzQ2hpbGRyZW4gPSBjbGlwc0dlbmVyYXRlZENoaWxkcmVuKHNwZWMpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uID09PSAncmVuZGVyJyB8fCBzcGVjLnNwcml0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghc3BlYy5zcHJpdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQTkcg5pW05bGC6IqC54K54oCcJHtzcGVjLm5hbWV94oCd5rKh5pyJ57uR5a6aIFNwcml0ZUZyYW1l77yM6LWE5rqQ5Y+v6IO95pyq5oiQ5Yqf5a+85YWl44CCYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aWxlZFNwcml0ZUhlbHBlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBhd2FpdCBjb25maWd1cmVUaWxlZFNwcml0ZUhlbHBlcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGF5bG9hZC5zY2FsZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiT3duZXJzaGlwR3VhcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYXdhaXQgY29uZmlndXJlU3ByaXRlKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHNwZWMua2luZCA9PT0gJ3JpY2hUZXh0Jykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZVJpY2hUZXh0KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByaWNoVGV4dCA9IG5vZGUuZ2V0Q29tcG9uZW50KFJpY2hUZXh0KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmb250ID0gYXdhaXQgbG9hZEFzc2V0KGNjLmFzc2V0TWFuYWdlciwgc3BlYy5mb250VXVpZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjYy5UVEZGb250ICYmICEoZm9udCBpbnN0YW5jZW9mIGNjLlRURkZvbnQpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYFJpY2hUZXh0IOiKgueCueKAnCR7c3BlYy5uYW1lfeKAneWPquiDveS9v+eUqCBUVEYvT1RGIOWtl+S9k++8jOW9k+WJjeaYoOWwhOWPr+iDveaYryBCaXRtYXBGb25077yILmZudO+8ieOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJpY2hUZXh0LmZvbnQgPSBmb250O1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJpY2hUZXh0LmZvbnQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBmaW5hbGl6ZUxhYmVsR2VvbWV0cnkobm9kZSwgc3BlYywgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5maWdtYVR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUxhYmVsKG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoc3BlYy5mb250VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWwuZm9udCA9IGF3YWl0IGxvYWRBc3NldChjYy5hc3NldE1hbmFnZXIsIHNwZWMuZm9udFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuZ2V0Q29tcG9uZW50KExhYmVsKS5mb250ID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgZmluYWxpemVMYWJlbEdlb21ldHJ5KG5vZGUsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoUkFTVEVSX1ZFQ1RPUl9UWVBFUy5oYXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnn6Lph4/oioLngrnigJwke3NwZWMubmFtZX3igJ3msqHmnInnu5HlrpogU3ByaXRlRnJhbWXvvIxQTkcg6LWE5rqQ5Y+v6IO95pyq5oiQ5Yqf5a+85YWl44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGNsaXBzQ2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVDbGlwKG5vZGUsIHNwZWMsIGNjKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaGFzR3JhcGhpY3NWaXN1YWwoc3BlYykpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25maWd1cmVHcmFwaGljcyhub2RlLCBzcGVjLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVPcGFjaXR5KG5vZGUsIHNwZWMsIGNjKTtcclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZUJ1dHRvbihub2RlLCBzcGVjLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIGNvbnN0IHRyYW5zZm9ybSA9IG5vZGUuZ2V0Q29tcG9uZW50KFVJVHJhbnNmb3JtKTtcclxuICAgICAgICAgICAgY29uc3QgY2hpbGRQYXJlbnQgPSBzcGVjLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybSdcclxuICAgICAgICAgICAgICAgID8gbm9kZVxyXG4gICAgICAgICAgICAgICAgOiBjb25maWd1cmVTY3JvbGwoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLFxyXG4gICAgICAgICAgICAgICAgICAgIHRyYW5zZm9ybSxcclxuICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgICAgIGNjLFxyXG4gICAgICAgICAgICAgICAgICAgIHByZWZhYk93bmVyc2hpcEd1YXJkLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKHNwZWMuYWN0aW9uID09PSAnZ2VuZXJhdGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb25maWd1cmVMYXlvdXQoY2hpbGRQYXJlbnQsIHNwZWMsIHBheWxvYWQuc2NhbGUsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIHNwZWMuY2hpbGRyZW4pIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGJ1aWxkKGNoaWxkLCBjaGlsZFBhcmVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHByZWZhYkNvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIHJlb3JkZXJGaWdtYUNoaWxkcmVuKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkUGFyZW50LFxyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMuY2hpbGRyZW4ubWFwKChjaGlsZCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB1dWlkID0gbm9kZU1hcFtjaGlsZC5maWdtYUlkXTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHV1aWQgPyBmaW5kQnlVdWlkKGNoaWxkUGFyZW50LCB1dWlkKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxheW91dE1vZGUgPSBzcGVjLmxheW91dD8ubW9kZTtcclxuICAgICAgICAgICAgY29uc3QgbGF5b3V0ID0gc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgbGF5b3V0TW9kZSAmJiBsYXlvdXRNb2RlICE9PSAnTk9ORSdcclxuICAgICAgICAgICAgICAgID8gY2hpbGRQYXJlbnQuZ2V0Q29tcG9uZW50KExheW91dClcclxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgbGF5b3V0Py51cGRhdGVMYXlvdXQoKTtcclxuICAgICAgICAgICAgaWYgKGxheW91dCkge1xyXG4gICAgICAgICAgICAgICAgYXBwbHlDb3VudGVyQWxpZ25tZW50KGNoaWxkUGFyZW50LCBzcGVjLCBub2RlTWFwLCBwYXlsb2FkLnNjYWxlLCBjYyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZmluYWxpemVTY3JvbGwobm9kZSwgc3BlYywgY2hpbGRQYXJlbnQsIHRyYW5zZm9ybSwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0ZWQgJiYgc3BlYy5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUgKz0gJyDCtyBUcmFuc2Zvcm0nO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbXBsZXRlZE5vZGVzICs9IDE7XHJcbiAgICAgICAgICAgIGVtaXRTY2VuZVByb2dyZXNzKFxyXG4gICAgICAgICAgICAgICAgcGF5bG9hZCxcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlZE5vZGVzIC8gdG90YWxOb2RlcyxcclxuICAgICAgICAgICAgICAgIGDmnoTlu7roioLngrkgJHtjb21wbGV0ZWROb2Rlc30vJHt0b3RhbE5vZGVzfSDCtyAke3NwZWMubmFtZX1gLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgcm9vdCBvZiByb290cykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgYnVpbGQocm9vdCwgZGlyZWN0Um9vdCA/IHBhcmVudCA6IGltcG9ydFJvb3QsIGRpcmVjdFJvb3QgPyBpbXBvcnRSb290IDogdW5kZWZpbmVkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocGF5bG9hZC51cGRhdGVFeGlzdGluZyAmJiAhcHJlZmFiQ29udGV4dCkge1xyXG4gICAgICAgICAgICAgICAgcmVtb3ZlQ29sbGFwc2VkTWFwcGVkRGVzY2VuZGFudHMoXHJcbiAgICAgICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBwYXlsb2FkLmV4aXN0aW5nTWFwLFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVNYXAsXHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgICAgICAgICAgICAgY2MsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChkaXJlY3RSb290KSB7XHJcbiAgICAgICAgICAgICAgICBub2RlTWFwLl9fcm9vdF9fID0gaW1wb3J0Um9vdC51dWlkO1xyXG4gICAgICAgICAgICAgICAgaWYgKHBheWxvYWQuY2VudGVySW5DYW52YXMgJiYgY2FudmFzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2VudGVySW5DYW52YXMoaW1wb3J0Um9vdCwgY2FudmFzLCBVSVRyYW5zZm9ybSwgY2MuVmVjMyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcmV0YWluZWRVdWlkcyA9IG5ldyBTZXQoT2JqZWN0LnZhbHVlcyhub2RlTWFwKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YWxlVHJhbnNpdGlvblV1aWRzID0gbmV3IFNldChcclxuICAgICAgICAgICAgICAgIE9iamVjdC5lbnRyaWVzKHBheWxvYWQuZXhpc3RpbmdNYXApXHJcbiAgICAgICAgICAgICAgICAgICAgLmZpbHRlcigoW2ZpZ21hSWQsIHV1aWRdKSA9PiBmaWdtYUlkICE9PSAnX19yb290X18nICYmICFyZXRhaW5lZFV1aWRzLmhhcyh1dWlkKSlcclxuICAgICAgICAgICAgICAgICAgICAubWFwKChbLCB1dWlkXSkgPT4gdXVpZCksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcHJlZmFiQ29udGV4dCAmJiBsZWdhY3lXcmFwcGVyICYmIGxlZ2FjeVdyYXBwZXIgIT09IGltcG9ydFJvb3QgJiYgbGVnYWN5V3JhcHBlci5wYXJlbnQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU1hcHBlZE5vZGVUcmVlKGxlZ2FjeVdyYXBwZXIsIHBhcmVudCwgc3RhbGVUcmFuc2l0aW9uVXVpZHMsIGNjKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXByZWZhYkNvbnRleHQgJiYgcHJldmlvdXNEaXJlY3RSb290XHJcbiAgICAgICAgICAgICAgICAmJiBwcmV2aW91c0RpcmVjdFJvb3QgIT09IGltcG9ydFJvb3RcclxuICAgICAgICAgICAgICAgICYmICFyZXRhaW5lZFV1aWRzLmhhcyhwcmV2aW91c0RpcmVjdFJvb3QudXVpZClcclxuICAgICAgICAgICAgICAgICYmIHByZXZpb3VzRGlyZWN0Um9vdC5wYXJlbnQpIHtcclxuICAgICAgICAgICAgICAgIHJlbW92ZU1hcHBlZE5vZGVUcmVlKFxyXG4gICAgICAgICAgICAgICAgICAgIHByZXZpb3VzRGlyZWN0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBkaXJlY3RSb290ID8gcGFyZW50IDogaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgICAgICBzdGFsZVRyYW5zaXRpb25VdWlkcyxcclxuICAgICAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICBtZXJnZVByZXNlcnZlZE1hcHBpbmdzKGltcG9ydFJvb3QsIHBheWxvYWQuZXhpc3RpbmdNYXAsIG5vZGVNYXApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgaWYgKCFyZXVzZWRJbXBvcnRSb290KSB7XHJcbiAgICAgICAgICAgICAgICBzYWx2YWdlRXhpc3RpbmdNYXBwZWROb2RlcyhcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgICAgIHBhcmVudCxcclxuICAgICAgICAgICAgICAgICAgICBuZXcgU2V0KE9iamVjdC52YWx1ZXMocGF5bG9hZC5leGlzdGluZ01hcCkpLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGltcG9ydFJvb3QucmVtb3ZlRnJvbVBhcmVudCgpO1xyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdC5kZXN0cm95KCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBwcmVmYWJTeW5jOiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChwcmVmYWJDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJldGFpbmVkTm9kZUZpbGVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbZmlnbWFJZCwgdXVpZF0gb2YgT2JqZWN0LmVudHJpZXMobm9kZU1hcCkpIHtcclxuICAgICAgICAgICAgICAgIGlmIChmaWdtYUlkID09PSAnX19yb290X18nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmluZEJ5VXVpZChpbXBvcnRSb290LCB1dWlkKTtcclxuICAgICAgICAgICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5a6a5L2N5a+85YWl5ZCO55qE6IqC54K577yaJHtmaWdtYUlkfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0YWluZWROb2RlRmlsZUlkcy5hZGQoZW5zdXJlTm9kZVByZWZhYkluZm8obm9kZSwgaW1wb3J0Um9vdCwgY2MpKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW1vdmVTdGFsZVByZWZhYk5vZGVzKFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0Um9vdCxcclxuICAgICAgICAgICAgICAgIG5ldyBTZXQocHJlZmFiQ29udGV4dC5tYW5hZ2VkTm9kZUZpbGVJZHMpLFxyXG4gICAgICAgICAgICAgICAgcHJldmlvdXNNYW5hZ2VkSGVscGVycyxcclxuICAgICAgICAgICAgICAgIHByZXZpb3VzTWFuYWdlZENvbXBvbmVudHMsXHJcbiAgICAgICAgICAgICAgICByZXRhaW5lZE5vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICByZWZyZXNoUHJlZmFiTGF5b3V0cyhyb290cywgaW1wb3J0Um9vdCwgbm9kZU1hcCwgcGF5bG9hZC5zY2FsZSwgY2MpO1xyXG4gICAgICAgICAgICBwcmVmYWJTeW5jID0gY2FwdHVyZVByZWZhYlN5bmMoXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRSb290LFxyXG4gICAgICAgICAgICAgICAgbm9kZU1hcCxcclxuICAgICAgICAgICAgICAgIHByZWZhYkNvbnRleHQsXHJcbiAgICAgICAgICAgICAgICBwcmVleGlzdGluZ1ByZWZhYk5vZGVVdWlkcyxcclxuICAgICAgICAgICAgICAgIHByZWV4aXN0aW5nUHJlZmFiQ29tcG9uZW50cyxcclxuICAgICAgICAgICAgICAgIFtVSVRyYW5zZm9ybSwgLi4uZ2VuZXJhdGVkQ2xhc3Nlc10sXHJcbiAgICAgICAgICAgICAgICBjYyxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKG5vZGVQcmVmYWJGaWxlSWQoaW1wb3J0Um9vdCkgIT09IHByZWZhYkNvbnRleHQucm9vdEZpbGVJZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5qC56IqC54K5IGZpbGVJZCDlnKjlkIzmraXov4fnqIvkuK3lj5HnlJ/lj5jljJbvvIzlt7Lmi5Lnu53kv53lrZjjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICByb290VXVpZDogaW1wb3J0Um9vdC51dWlkLFxyXG4gICAgICAgICAgICBub2RlTWFwLFxyXG4gICAgICAgICAgICBjcmVhdGVkLFxyXG4gICAgICAgICAgICB1cGRhdGVkLFxyXG4gICAgICAgICAgICB0ZW1wb3JhcnlSb290OiAhcHJlZmFiQ29udGV4dCAmJiBkaXJlY3RSb290ICYmICFyZXVzZWRJbXBvcnRSb290LFxyXG4gICAgICAgICAgICBwcmVmYWJTeW5jLFxyXG4gICAgICAgIH07XHJcbiAgICB9LFxyXG5cclxuICAgIHJlbW92ZUltcG9ydGVkTm9kZShwYXlsb2FkOiB7IHJvb3RVdWlkOiBzdHJpbmcgfSk6IGJvb2xlYW4ge1xyXG4gICAgICAgIGNvbnN0IGNjID0gcmVxdWlyZSgnY2MnKSBhcyBhbnk7XHJcbiAgICAgICAgY29uc3Qgc2NlbmUgPSBjYy5kaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBzY2VuZSA/IGZpbmRCeVV1aWQoc2NlbmUsIHBheWxvYWQucm9vdFV1aWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyBTdG9wIHJlbmRlcmluZyBpbW1lZGlhdGVseS4gQ29jb3MgZGVzdHJveXMgbm9kZXMgYXQgdGhlIGVuZCBvZiB0aGVcclxuICAgICAgICAvLyBmcmFtZSwgc28gcmVtb3ZpbmcgdGhlIHBhcmVudCBhbG9uZSBjYW4gbGVhdmUgYSBvbmUtZnJhbWUgZ2hvc3QuXHJcbiAgICAgICAgbm9kZS5hY3RpdmUgPSBmYWxzZTtcclxuICAgICAgICBub2RlLnJlbW92ZUZyb21QYXJlbnQoKTtcclxuICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0sXHJcbn07XHJcbiJdfQ==