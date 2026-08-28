import { join } from 'path';
import {
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from './import-actions';
import type {
    FigmaColor,
    FigmaPaint,
    PrefabEditingState,
    PrefabSceneSyncCapture,
    PrefabSceneSyncContext,
    Rect,
    SceneNodeSpec,
} from './types';
import { sanitizeNodeName } from './node-name';

module.paths.push(join(Editor.App.path, 'node_modules'));

interface SceneImportPayload {
    packageName: string;
    fileKey: string;
    rootName: string;
    rootFrame: Rect;
    scale: number;
    updateExisting: boolean;
    existingMap: Record<string, string>;
    prefabUrl?: string;
    centerInCanvas?: boolean;
    prefabContext?: PrefabSceneSyncContext;
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
    temporaryRoot?: boolean;
    prefabSync?: PrefabSceneSyncCapture;
}

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

function cleanName(input: string): string {
    return sanitizeNodeName(input) ?? 'Figma Node';
}

function toColor(Color: any, value: FigmaColor | undefined, opacity = 1): any {
    const source = value ?? { r: 0, g: 0, b: 0, a: 1 };
    return new Color(
        Math.round(Math.max(0, Math.min(1, source.r)) * 255),
        Math.round(Math.max(0, Math.min(1, source.g)) * 255),
        Math.round(Math.max(0, Math.min(1, source.b)) * 255),
        Math.round(Math.max(0, Math.min(1, (source.a ?? 1) * opacity)) * 255),
    );
}

function findByUuid(root: any, uuid: string): any | null {
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

function nodePrefabFileId(node: any): string | undefined {
    const value = node?._prefab?.fileId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function componentPrefabFileId(component: any): string | undefined {
    const value = component?.__prefab?.fileId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function walkNodes(root: any, visit: (node: any) => void): void {
    visit(root);
    for (const child of root.children ?? []) {
        walkNodes(child, visit);
    }
}

function prefabAssetUuid(node: any): string | undefined {
    const asset = node?._prefab?.asset;
    const value = asset?._uuid ?? asset?.uuid;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function prefabFileIdIndex(root: any, expectedPrefabUuid?: string): Map<string, any> {
    const result = new Map<string, any>();
    const componentFileIds = new Set<string>();
    walkNodes(root, (node) => {
        const prefabRoot = node?._prefab?.root;
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
        for (const component of node.components ?? node._components ?? []) {
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

function prefabEditingState(
    expectedUuid: string,
    expectedRootFileId?: string,
): PrefabEditingState {
    const cceApi = (globalThis as any).cce;
    const mode = String(cceApi?.SceneFacadeManager?.queryMode?.() ?? '');
    const currentUuid = String(cceApi?.SceneFacadeManager?.queryCurrentSceneUuid?.() ?? '');
    const root = cceApi?.Scene?.rootNode ?? null;
    const rootFileId = nodePrefabFileId(root);
    let reason = '';
    if (mode !== 'prefab') {
        reason = `当前编辑模式为 ${mode || 'unknown'}，尚未进入 Prefab`;
    } else if (currentUuid !== expectedUuid) {
        reason = `当前资源 UUID 与目标 Prefab 不一致`;
    } else if (!root) {
        reason = 'Prefab 根节点尚未就绪';
    } else if (expectedRootFileId && rootFileId !== expectedRootFileId) {
        reason = 'Prefab 根节点 fileId 与来源记录不一致';
    }
    return {
        ready: !reason,
        mode,
        currentUuid,
        rootUuid: root?.uuid,
        rootFileId,
        reason: reason || undefined,
    };
}

function generatePrefabFileId(): string {
    const generated = (globalThis as any).Editor?.Utils?.UUID?.generate?.(true);
    if (typeof generated === 'string' && generated.length > 0) {
        return generated;
    }
    // Unit-test/headless fallback. The real Creator scene process always uses
    // Editor.Utils.UUID.generate(true), so production IDs follow Creator's own format.
    return `figma${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

function ensureNodePrefabInfo(node: any, prefabRoot: any, cc: any): string {
    let fileId = nodePrefabFileId(node);
    if (fileId) {
        return fileId;
    }
    const cceApi = (globalThis as any).cce;
    cceApi?.Prefab?.onAddNode?.(node);
    fileId = nodePrefabFileId(node);
    if (fileId) {
        return fileId;
    }
    const PrefabInfo = cc.Prefab?._utils?.PrefabInfo ?? cc.PrefabInfo;
    if (!PrefabInfo) {
        throw new Error('Cocos 3.8.7 PrefabInfo API 不可用，无法为新节点生成稳定 fileId。');
    }
    const info = new PrefabInfo();
    info.root = prefabRoot;
    info.asset = prefabRoot?._prefab?.asset ?? null;
    info.fileId = generatePrefabFileId();
    info.instance = null;
    info.targetOverrides = null;
    node._prefab = info;
    return info.fileId;
}

function ensureComponentPrefabInfo(component: any, cc: any): string {
    let fileId = componentPrefabFileId(component);
    if (fileId) {
        return fileId;
    }
    const cceApi = (globalThis as any).cce;
    cceApi?.Prefab?.onAddComponent?.(component);
    fileId = componentPrefabFileId(component);
    if (fileId) {
        return fileId;
    }
    const CompPrefabInfo = cc.Prefab?._utils?.CompPrefabInfo ?? cc.CompPrefabInfo;
    if (!CompPrefabInfo) {
        throw new Error('Cocos 3.8.7 CompPrefabInfo API 不可用，无法为新组件生成稳定 fileId。');
    }
    const info = new CompPrefabInfo();
    info.fileId = generatePrefabFileId();
    component.__prefab = info;
    return info.fileId;
}

function setParentKeepingWorld(node: any, parent: any): void {
    if (typeof node.setParent === 'function') {
        node.setParent(parent, true);
    } else {
        node.parent = parent;
    }
}

function isGeneratedHelperNode(child: any, parent: any, cc: any): boolean {
    if (child.name === BACKGROUND_NODE_NAME
        || child.name === TILED_MASK_NODE_NAME
        || child.name === TILED_SPRITE_NODE_NAME
        || child.name === OVERFLOW_SPRITE_NODE_NAME
        || child.name === '__FigmaContent') {
        return true;
    }
    if (child.name === 'view' && parent.getComponent?.(cc.ScrollView)) {
        return true;
    }
    return child.name === 'content'
        && parent.name === 'view'
        && parent.parent?.getComponent?.(cc.ScrollView);
}

function removeMappedNodeTree(
    node: any,
    survivorParent: any,
    staleUuids: Set<string>,
    cc: any,
): number {
    let removed = 1;
    for (const child of [...node.children]) {
        if (staleUuids.has(child.uuid) || isGeneratedHelperNode(child, node, cc)) {
            removed += removeMappedNodeTree(child, survivorParent, staleUuids, cc);
        } else if (survivorParent) {
            setParentKeepingWorld(child, survivorParent);
        }
    }
    node.active = false;
    node.removeFromParent();
    node.destroy();
    return removed;
}

function normalizeSceneSpec(spec: SceneNodeSpec): SceneNodeSpec {
    const action = normalizeImportAction(spec.action as unknown);
    const kind = kindForImportAction(spec.kind, action);
    const children = Array.isArray(spec.children) ? spec.children : [];
    return {
        ...spec,
        action,
        kind,
        children: isTerminalAction(action) || spec.flattenBoundary === true
            ? []
            : children.map((child) => normalizeSceneSpec(child)),
    };
}

function figmaIdsForSpec(spec: SceneNodeSpec): string[] {
    const ids = [spec.figmaId, ...(spec.aliasFigmaIds ?? [])]
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== '__root__');
    return [...new Set(ids)];
}

function aliasFigmaIdsForSpec(spec: SceneNodeSpec): string[] {
    return figmaIdsForSpec(spec).filter((figmaId) => figmaId !== spec.figmaId);
}

function existingUuidForSpec(
    existingMap: Record<string, string>,
    spec: SceneNodeSpec,
): string | undefined {
    for (const figmaId of figmaIdsForSpec(spec)) {
        const uuid = existingMap[figmaId];
        if (uuid) {
            return uuid;
        }
    }
    return undefined;
}

function flattensDescendants(spec: SceneNodeSpec): boolean {
    if (typeof spec.flattenBoundary === 'boolean') {
        return spec.flattenBoundary;
    }
    // Backward compatibility for SceneSpecs persisted by importer versions
    // before flattenBoundary was introduced. New plans always set the flag so
    // folded Labels and other promoted visuals use the same cleanup semantics.
    return spec.action === 'render'
        || (spec.action === 'generate' && Boolean(spec.sprite) && spec.children.length === 0);
}

function removeCollapsedMappedDescendants(
    importRoot: any,
    existingMap: Record<string, string>,
    currentMap: Record<string, string>,
    specs: SceneNodeSpec[],
    cc: any,
): number {
    const retainedUuids = new Set(Object.values(currentMap));
    const boundarySpecs: Array<{
        figmaId: string;
        removesAllMappedDescendants: boolean;
        aliasFigmaIds: Set<string>;
    }> = [];
    const collectBoundaries = (nodes: SceneNodeSpec[]) => {
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
        .filter((boundary): boundary is typeof boundary & { node: any } => Boolean(boundary.node));
    if (!boundaries.length) {
        return 0;
    }
    const staleNodes = new Map<string, any>();
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

function mergePreservedMappings(
    importRoot: any,
    existingMap: Record<string, string>,
    currentMap: Record<string, string>,
): void {
    for (const [figmaId, uuid] of Object.entries(existingMap)) {
        if (figmaId === '__root__' || currentMap[figmaId]) {
            continue;
        }
        if (findByUuid(importRoot, uuid)) {
            currentMap[figmaId] = uuid;
        }
    }
}

function salvageExistingMappedNodes(
    container: any,
    survivorParent: any,
    existingUuids: Set<string>,
): void {
    for (const child of [...container.children]) {
        if (existingUuids.has(child.uuid)) {
            setParentKeepingWorld(child, survivorParent);
        } else {
            salvageExistingMappedNodes(child, survivorParent, existingUuids);
        }
    }
}

function findCanvas(root: any, Canvas: any): any | null {
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

function removeGeneratedComponents(
    node: any,
    classes: any[],
    preserved: Set<any>,
    renderClasses: any[],
    removableFileIds?: Set<string>,
): boolean {
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
                        throw new Error(
                            `节点“${node.name}”上的渲染组件不是 Figma Importer 创建的，已停止更新以保护手工内容。`,
                        );
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

async function removeObsoleteLabelOutline(node: any, cc: any): Promise<void> {
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

function desiredGeneratedComponents(spec: SceneNodeSpec, cc: any): Set<any> {
    const desired = new Set<any>();
    const clipsChildren = clipsGeneratedChildren(spec);
    if (spec.action === 'render' || spec.sprite) {
        if (!usesTiledSpriteHelper(spec) && !usesOverflowSpriteHelper(spec)) {
            desired.add(cc.Sprite);
        }
    } else if (spec.kind === 'richText') {
        desired.add(cc.RichText);
    } else if (spec.kind === 'label' || spec.figmaType === 'TEXT') {
        desired.add(cc.Label);
    } else if (!RASTER_VECTOR_TYPES.has(spec.figmaType)) {
        if (hasGraphicsVisual(spec) || clipsChildren) {
            desired.add(cc.Graphics);
        }
        if (clipsChildren) {
            desired.add(cc.Mask);
        }
    }
    const layoutMode = spec.layout?.mode;
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

function waitForDeferredComponentRemoval(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

interface PrefabOwnershipGuard {
    previousHelperFileIds: Set<string>;
    previousComponentFileIds: Set<string>;
    preexistingNodeUuids: Set<string>;
    preexistingComponents: Set<any>;
}

function isOwnedHelperNode(node: any, guard: PrefabOwnershipGuard): boolean {
    const fileId = nodePrefabFileId(node);
    return !guard.preexistingNodeUuids.has(node.uuid)
        || Boolean(fileId && guard.previousHelperFileIds.has(fileId));
}

function assertOwnedGeneratedComponent(
    component: any,
    guard: PrefabOwnershipGuard,
    ownerName: string,
): void {
    if (!component || !guard.preexistingComponents.has(component)) {
        return;
    }
    const fileId = componentPrefabFileId(component);
    if (!fileId || !guard.previousComponentFileIds.has(fileId)) {
        throw new Error(
            `节点“${ownerName}”上的 ${component.constructor?.name ?? 'Component'} 不是 Figma Importer 创建的，已停止更新。`,
        );
    }
}

function assertOwnedHelperNode(node: any, guard: PrefabOwnershipGuard): void {
    if (!isOwnedHelperNode(node, guard)) {
        throw new Error(`辅助节点“${node.name}”不是 Figma Importer 创建的，已停止更新。`);
    }
    for (const component of nodeComponents(node)) {
        assertOwnedGeneratedComponent(component, guard, node.name);
    }
}

function assertOwnedHelperSubtree(node: any, guard: PrefabOwnershipGuard): void {
    assertOwnedHelperNode(node, guard);
    for (const child of node.children ?? []) {
        if (isOwnedHelperNode(child, guard)) {
            assertOwnedHelperSubtree(child, guard);
        }
    }
}

function destroyOwnedHelperSubtree(
    helper: any,
    survivor: any,
    guard?: PrefabOwnershipGuard,
): void {
    if (guard) {
        assertOwnedHelperSubtree(helper, guard);
    }
    const remove = (node: any) => {
        for (const child of [...node.children]) {
            if (guard && isOwnedHelperNode(child, guard)) {
                remove(child);
            } else {
                setParentKeepingWorld(child, survivor);
            }
        }
        node.removeFromParent();
        node.destroy();
    };
    remove(helper);
}

function removeGeneratedBackground(node: any, guard?: PrefabOwnershipGuard): void {
    const background = node.getChildByName(BACKGROUND_NODE_NAME);
    if (!background) {
        return;
    }
    destroyOwnedHelperSubtree(background, node, guard);
}

function destroyGeneratedTiledSprite(
    tiledSprite: any,
    survivor: any,
    guard?: PrefabOwnershipGuard,
): void {
    destroyOwnedHelperSubtree(tiledSprite, survivor, guard);
}

function removeGeneratedTiledNodes(node: any, guard?: PrefabOwnershipGuard): void {
    const tiledMask = node.getChildByName(TILED_MASK_NODE_NAME);
    if (tiledMask) {
        destroyOwnedHelperSubtree(tiledMask, node, guard);
    }
    const tiledSprite = node.getChildByName(TILED_SPRITE_NODE_NAME);
    if (tiledSprite) {
        destroyGeneratedTiledSprite(tiledSprite, node, guard);
    }
}

function removeGeneratedOverflowVisual(node: any, guard?: PrefabOwnershipGuard): void {
    const helper = node.getChildByName(OVERFLOW_SPRITE_NODE_NAME);
    if (helper) {
        destroyOwnedHelperSubtree(helper, node, guard);
    }
}

function removeObsoleteScrollHelpers(
    node: any,
    spec: SceneNodeSpec,
    cc: any,
    guard?: PrefabOwnershipGuard,
): void {
    if (spec.kind === 'scrollView') {
        return;
    }
    // A flattened node has no new child specs by design. Keep every existing
    // child alive until removeFlattenedMappedDescendants can distinguish old
    // Figma-mapped nodes from user-authored nodes. Otherwise destroying the
    // helper would recursively destroy manual children at Cocos' deferred
    // destruction boundary.
    const preserveChildren = spec.children.length > 0 || flattensDescendants(spec);
    const moveChildrenToNode = (container: any) => {
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
    const content = view?.getChildByName('content');
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

function framePosition(
    frame: Rect,
    parentFrame: Rect | undefined,
    scale: number,
    parentTransform?: any,
    childTransform?: any,
): { x: number; y: number } {
    if (!parentFrame) {
        return { x: 0, y: 0 };
    }
    const parentAnchor = parentTransform?.anchorPoint ?? { x: 0, y: 1 };
    const parentSize = parentTransform?.contentSize ?? {};
    const parentWidth = Number(parentSize.width) > 0
        ? Number(parentSize.width)
        : parentFrame.width * scale;
    const parentHeight = Number(parentSize.height) > 0
        ? Number(parentSize.height)
        : parentFrame.height * scale;
    const width = frame.width * scale;
    const height = frame.height * scale;
    const childAnchor = childTransform?.anchorPoint ?? { x: 0.5, y: 0.5 };
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

function relativeTransformPosition(
    spec: SceneNodeSpec,
    scale: number,
    parentTransform?: any,
): { x: number; y: number } | undefined {
    if (spec.isRoot || !spec.intrinsicSize) return undefined;
    const matrix = spec.relativeTransform;
    const values = [
        matrix?.[0]?.[0], matrix?.[0]?.[1], matrix?.[0]?.[2],
        matrix?.[1]?.[0], matrix?.[1]?.[1], matrix?.[1]?.[2],
    ];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return undefined;
    }
    const [m00, m01, tx, m10, m11, ty] = values as number[];
    const parentAnchor = parentTransform?.anchorPoint ?? { x: 0.5, y: 0.5 };
    const parentSize = parentTransform?.contentSize ?? {};
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

function configureGeometry(node: any, spec: SceneNodeSpec, scale: number, cc: any): any {
    const { UITransform, Vec3 } = cc;
    const transform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    const size = spec.intrinsicSize ?? spec.frame;
    transform.setContentSize(
        Math.max(0, size.width * scale),
        Math.max(0, size.height * scale),
    );
    const parentTransform = node.parent?.getComponent(UITransform);
    const position = spec.isRoot
        ? { x: 0, y: 0 }
        : relativeTransformPosition(spec, scale, parentTransform)
            ?? framePosition(spec.frame, spec.parentFrame, scale, parentTransform, transform);
    node.setPosition(new Vec3(position.x, position.y, node.position?.z ?? 0));
    node.setRotationFromEuler(0, 0, spec.rotation);
    node.active = spec.visible;
    return transform;
}

function visiblePaint(paints: FigmaPaint[]): FigmaPaint | undefined {
    return paints.find((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
}

function visibleSolidPaint(paints: FigmaPaint[]): FigmaPaint | undefined {
    return paints.find((paint) => paint.type === 'SOLID'
        && paint.visible !== false
        && (paint.opacity ?? 1) > 0
        && Boolean(paint.color)
        && (paint.color?.a ?? 1) > 0);
}

function visibleSolidFill(spec: SceneNodeSpec): FigmaPaint | undefined {
    return visibleSolidPaint(spec.fills);
}

function validSolidStroke(spec: SceneNodeSpec): FigmaPaint | undefined {
    return spec.strokeWeight > 0 ? visibleSolidPaint(spec.strokes) : undefined;
}

function hasGraphicsVisual(spec: SceneNodeSpec): boolean {
    return Boolean(visibleSolidFill(spec) || validSolidStroke(spec));
}

function drawGraphics(graphics: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const fill = visibleSolidFill(spec);
    const stroke = validSolidStroke(spec);
    if (!fill && !stroke) {
        return;
    }
    const width = spec.frame.width * scale;
    const height = spec.frame.height * scale;
    const radius = Math.max(
        0,
        Math.min(Math.min(...spec.cornerRadii) * scale, width / 2, height / 2),
    );
    if (spec.figmaType === 'ELLIPSE') {
        graphics.ellipse(0, 0, width / 2, height / 2);
    } else if (radius > 0) {
        graphics.roundRect(-width / 2, -height / 2, width, height, radius);
    } else {
        graphics.rect(-width / 2, -height / 2, width, height);
    }
    if (fill?.color) {
        graphics.fillColor = toColor(cc.Color, fill.color, fill.opacity ?? 1);
        graphics.fill();
    }
    if (stroke?.color) {
        graphics.lineWidth = Math.max(0.5, spec.strokeWeight * scale);
        graphics.strokeColor = toColor(cc.Color, stroke.color, stroke.opacity ?? 1);
        graphics.stroke();
    }
}

function configureGraphics(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const graphics = node.getComponent(cc.Graphics) ?? node.addComponent(cc.Graphics);
    graphics.enabled = true;
    graphics.clear();
    drawGraphics(graphics, spec, scale, cc);
}

function normalizeLabelText(characters: string | undefined): string {
    return (characters ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/[\r\u2028\u2029]/g, '\n');
}

function isMultilineLabel(characters: string): boolean {
    // Cocos Creator 3.8.7 disables automatic wrapping whenever overflow is
    // NONE. Only explicit line feeds can therefore produce real line breaks.
    return characters.includes('\n');
}

function configureLabel(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const { Label } = cc;
    const label = node.getComponent(Label) ?? node.addComponent(Label);
    const style = spec.textStyle ?? {};
    const characters = normalizeLabelText(spec.characters);
    const multiline = isMultilineLabel(characters);
    label.fontSize = Math.max(1, (style.fontSize ?? 16) * scale);
    label.lineHeight = Math.max(1, (style.lineHeightPx ?? style.fontSize ?? 16) * scale);
    label.spacingX = (style.letterSpacing ?? 0) * scale;
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
    if (fill?.color) {
        label.color = toColor(cc.Color, fill.color, fill.opacity ?? 1);
    }
    const stroke = visiblePaint(spec.strokes);
    if (stroke?.color && spec.strokeWeight > 0) {
        label.enableOutline = true;
        label.outlineColor = toColor(cc.Color, stroke.color, stroke.opacity ?? 1);
        label.outlineWidth = Math.max(1, spec.strokeWeight * scale);
    }
}

function configureRichText(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const { RichText } = cc;
    const richText = node.getComponent(RichText) ?? node.addComponent(RichText);
    const style = spec.textStyle ?? {};
    richText.string = normalizeLabelText(spec.characters);
    richText.fontSize = Math.max(1, (style.fontSize ?? 16) * scale);
    richText.lineHeight = Math.max(1, (style.lineHeightPx ?? style.fontSize ?? 16) * scale);
    richText.maxWidth = Math.max(0, spec.frame.width * scale);
    richText.handleTouchEvent = false;
    // RichText is primarily used for runtime-injected multi-line content. An
    // empty Figma placeholder must therefore keep the same top-left contract
    // after the game assigns its real string.
    richText.horizontalAlign = RichText.HorizontalAlign.LEFT;
    richText.verticalAlign = RichText.VerticalAlign.TOP;
    richText.fontFamily = style.fontFamily ?? '';
    richText.useSystemFont = !spec.fontUuid;
    const fill = visiblePaint(spec.fills);
    if (fill?.color) {
        richText.fontColor = toColor(cc.Color, fill.color, fill.opacity ?? 1);
    }
}

function finalizeLabelGeometry(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const transform = node.getComponent(cc.UITransform);
    if (!transform) {
        return;
    }
    const label = node.getComponent(cc.Label);
    const outlineWidth = label?.enableOutline
        ? Math.max(0, Number(label.outlineWidth) || 0)
        : 0;
    const figmaHeight = Math.max(0, spec.frame.height * scale);
    const fontSize = Math.max(0, Number(label?.fontSize) || 0);
    const finalHeight = Math.max(figmaHeight, fontSize) + outlineWidth * 2;
    // Keep the imported Figma box unless a deterministic outline/font lower
    // bound requires expansion. Expand symmetrically around the center anchor
    // so the node's imported center position remains unchanged.
    // The base box must at least contain the final Cocos font size. When an
    // outline is enabled, reserve one actual Cocos outline width on every side.
    transform.setContentSize(
        Math.max(0, spec.frame.width * scale + outlineWidth * 2),
        finalHeight,
    );
}

function loadAsset(assetManager: any, uuid: string): Promise<any> {
    return new Promise((resolve, reject) => {
        assetManager.loadAny({ uuid }, (error: Error | null, asset: any) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(asset);
        });
    });
}

async function configureSprite(
    node: any,
    spec: SceneNodeSpec,
    scale: number,
    cc: any,
    targetFrame: { width: number; height: number } = spec.frame,
): Promise<void> {
    if (!spec.sprite) {
        return;
    }
    const { Sprite, UITransform, assetManager } = cc;
    const sprite = node.getComponent(Sprite) ?? node.addComponent(Sprite);
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
        const trimmedWidth = Number(transform?.contentSize?.width);
        const trimmedHeight = Number(transform?.contentSize?.height);
        const rawWidth = Number(spriteFrame?.originalSize?.width ?? spriteFrame?.width);
        const rawHeight = Number(spriteFrame?.originalSize?.height ?? spriteFrame?.height);
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
                transform?.setContentSize(trimmedWidth * scaleX, trimmedHeight * scaleY);
                return;
            }
        }
    }

    // Sliced/tiled sprites and sprites resized in Figma must retain the design
    // size. Cocos represents that state as CUSTOM.
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    transform?.setContentSize(targetWidth, targetHeight);
}

function requiresTiledMask(spec: SceneNodeSpec): boolean {
    return Boolean(spec.sprite?.tiled && spec.figmaType === 'ELLIPSE');
}

function nativeTileScale(spec: SceneNodeSpec): number {
    const scale = spec.sprite?.tileScale;
    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0
        ? scale
        : 1;
}

function usesTiledSpriteHelper(spec: SceneNodeSpec): boolean {
    return Boolean(spec.sprite?.tiled)
        && (requiresTiledMask(spec) || Math.abs(nativeTileScale(spec) - 1) > 1e-6);
}

function usesOverflowSpriteHelper(spec: SceneNodeSpec): boolean {
    return Boolean(spec.sprite?.renderFrame)
        && !spec.sprite?.sliced
        && !spec.sprite?.tiled;
}

async function configureOverflowSpriteHelper(
    node: any,
    spec: SceneNodeSpec,
    scale: number,
    cc: any,
    guard?: PrefabOwnershipGuard,
): Promise<void> {
    const renderFrame = spec.sprite?.renderFrame;
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

    const transform = helper.getComponent(cc.UITransform)
        ?? helper.addComponent(cc.UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    transform.setContentSize(
        Math.max(0, renderFrame.width * scale),
        Math.max(0, renderFrame.height * scale),
    );
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

async function configureTiledSpriteHelper(
    node: any,
    spec: SceneNodeSpec,
    scale: number,
    cc: any,
    guard?: PrefabOwnershipGuard,
): Promise<void> {
    const needsMask = requiresTiledMask(spec);
    let tiledMask = node.getChildByName(TILED_MASK_NODE_NAME);
    let tiledSprite = tiledMask?.getChildByName(TILED_SPRITE_NODE_NAME)
        ?? node.getChildByName(TILED_SPRITE_NODE_NAME);
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
        const maskTransform = tiledMask.getComponent(cc.UITransform)
            ?? tiledMask.addComponent(cc.UITransform);
        maskTransform.setAnchorPoint(0.5, 0.5);
        maskTransform.setContentSize(
            Math.max(0, spec.frame.width * scale),
            Math.max(0, spec.frame.height * scale),
        );
        tiledMask.setPosition(new cc.Vec3(0, 0, 0));
        tiledMask.setRotationFromEuler(0, 0, 0);
        tiledMask.setScale(new cc.Vec3(1, 1, 1));
        configureClip(tiledMask, spec, cc);
        tiledMask.setSiblingIndex(0);
    } else if (tiledMask) {
        for (const child of [...tiledMask.children]) {
            setParentKeepingWorld(child, node);
        }
        tiledMask.removeFromParent();
        tiledMask.destroy();
        tiledMask = null;
    }
    const spriteParent = tiledMask ?? node;
    if (!tiledSprite) {
        tiledSprite = new cc.Node(TILED_SPRITE_NODE_NAME);
        spriteParent.addChild(tiledSprite);
    } else if (tiledSprite.parent !== spriteParent) {
        tiledSprite.parent = spriteParent;
    }
    tiledSprite.name = TILED_SPRITE_NODE_NAME;
    tiledSprite.layer = node.layer;
    tiledSprite.active = true;
    await configureSprite(tiledSprite, spec, scale, cc);
    const tileScale = nativeTileScale(spec);
    const transform = tiledSprite.getComponent(cc.UITransform)
        ?? tiledSprite.addComponent(cc.UITransform);
    transform.setAnchorPoint(0.5, 0.5);
    transform.setContentSize(
        Math.max(0, spec.frame.width * scale / tileScale),
        Math.max(0, spec.frame.height * scale / tileScale),
    );
    tiledSprite.setPosition(new cc.Vec3(0, 0, 0));
    tiledSprite.setRotationFromEuler(0, 0, 0);
    tiledSprite.setScale(new cc.Vec3(tileScale, tileScale, 1));
    tiledSprite.setSiblingIndex(0);
}

function configureOpacity(node: any, spec: SceneNodeSpec, cc: any): void {
    if (spec.opacity >= 0.999) {
        return;
    }
    const opacity = node.getComponent(cc.UIOpacity) ?? node.addComponent(cc.UIOpacity);
    opacity.opacity = Math.round(Math.max(0, Math.min(1, spec.opacity)) * 255);
}

function configureLayout(node: any, spec: SceneNodeSpec, scale: number, cc: any): void {
    const mode = spec.layout?.mode;
    if (!mode || mode === 'NONE') {
        return;
    }
    const { Layout, Size } = cc;
    const layout = node.getComponent(Layout) ?? node.addComponent(Layout);
    layout.type = mode === 'HORIZONTAL'
        ? Layout.Type.HORIZONTAL
        : mode === 'VERTICAL'
            ? Layout.Type.VERTICAL
            : Layout.Type.GRID;
    if (mode === 'GRID') {
        layout.startAxis = spec.layout?.sourceMode === 'VERTICAL'
            ? Layout.AxisDirection.VERTICAL
            : Layout.AxisDirection.HORIZONTAL;
    }
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.paddingLeft = spec.layout!.paddingLeft * scale;
    layout.paddingRight = spec.layout!.paddingRight * scale;
    layout.paddingTop = spec.layout!.paddingTop * scale;
    layout.paddingBottom = spec.layout!.paddingBottom * scale;
    layout.spacingX = spec.layout!.itemSpacing * scale;
    layout.spacingY = (mode === 'GRID' ? spec.layout!.counterSpacing : spec.layout!.itemSpacing) * scale;
    const activeChildren = spec.children.filter((child) => child.visible);
    if (mode === 'HORIZONTAL' && activeChildren.length) {
        const childrenWidth = activeChildren.reduce((total, child) => total + child.frame.width * scale, 0);
        const innerWidth = spec.frame.width * scale - layout.paddingLeft - layout.paddingRight;
        if (spec.layout!.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingX = Math.max(0, (innerWidth - childrenWidth) / (activeChildren.length - 1));
        } else {
            const used = childrenWidth + layout.spacingX * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerWidth - used);
            if (spec.layout!.primaryAlign === 'CENTER') {
                layout.paddingLeft += remaining / 2;
            } else if (spec.layout!.primaryAlign === 'MAX') {
                layout.paddingLeft += remaining;
            }
        }
    } else if (mode === 'VERTICAL' && activeChildren.length) {
        const childrenHeight = activeChildren.reduce((total, child) => total + child.frame.height * scale, 0);
        const innerHeight = spec.frame.height * scale - layout.paddingTop - layout.paddingBottom;
        if (spec.layout!.primaryAlign === 'SPACE_BETWEEN' && activeChildren.length > 1) {
            layout.spacingY = Math.max(0, (innerHeight - childrenHeight) / (activeChildren.length - 1));
        } else {
            const used = childrenHeight + layout.spacingY * Math.max(0, activeChildren.length - 1);
            const remaining = Math.max(0, innerHeight - used);
            if (spec.layout!.primaryAlign === 'CENTER') {
                layout.paddingTop += remaining / 2;
            } else if (spec.layout!.primaryAlign === 'MAX') {
                layout.paddingTop += remaining;
            }
        }
    }
    if (mode === 'GRID' && spec.children.length) {
        layout.cellSize = new Size(
            Math.max(...spec.children.map((child) => child.frame.width)) * scale,
            Math.max(...spec.children.map((child) => child.frame.height)) * scale,
        );
    }
}

function applyCounterAlignment(
    parent: any,
    spec: SceneNodeSpec,
    nodeMap: Record<string, string>,
    scale: number,
    cc: any,
): void {
    const mode = spec.layout?.mode;
    const alignment = spec.layout?.counterAlign;
    if (!mode || !alignment || !['HORIZONTAL', 'VERTICAL'].includes(mode)) {
        return;
    }
    const parentTransform = parent.getComponent(cc.UITransform);
    const parentWidth = Number(parentTransform?.contentSize?.width) > 0
        ? Number(parentTransform.contentSize.width)
        : spec.frame.width * scale;
    const parentHeight = Number(parentTransform?.contentSize?.height) > 0
        ? Number(parentTransform.contentSize.height)
        : spec.frame.height * scale;
    const layoutWidth = spec.frame.width * scale;
    const layoutHeight = spec.frame.height * scale;
    const left = spec.layout!.paddingLeft * scale;
    const right = spec.layout!.paddingRight * scale;
    const top = spec.layout!.paddingTop * scale;
    const bottom = spec.layout!.paddingBottom * scale;
    const parentAnchor = parentTransform?.anchorPoint ?? { x: 0.5, y: 0.5 };
    for (const childSpec of spec.children) {
        const uuid = nodeMap[childSpec.figmaId];
        const child = uuid ? findByUuid(parent, uuid) : null;
        const transform = child?.getComponent(cc.UITransform);
        if (!child || !transform) {
            continue;
        }
        const position = child.position.clone();
        if (mode === 'HORIZONTAL') {
            const available = Math.max(0, layoutHeight - top - bottom);
            let topOffset = top;
            if (alignment === 'CENTER') {
                topOffset = top + (available - transform.height) / 2;
            } else if (alignment === 'MAX') {
                topOffset = layoutHeight - bottom - transform.height;
            } else {
                if (alignment === 'STRETCH') {
                    transform.setContentSize(transform.width, available);
                }
            }
            position.y = parentHeight * (1 - parentAnchor.y)
                - topOffset
                - transform.height * (1 - (transform.anchorPoint?.y ?? 0.5));
        } else {
            const available = Math.max(0, layoutWidth - left - right);
            let leftOffset = left;
            if (alignment === 'CENTER') {
                leftOffset = left + (available - transform.width) / 2;
            } else if (alignment === 'MAX') {
                leftOffset = layoutWidth - right - transform.width;
            } else {
                if (alignment === 'STRETCH') {
                    transform.setContentSize(available, transform.height);
                }
            }
            position.x = leftOffset
                - parentWidth * parentAnchor.x
                + transform.width * (transform.anchorPoint?.x ?? 0.5);
        }
        child.setPosition(position);
    }
}

function configureClip(node: any, spec: SceneNodeSpec, cc: any): void {
    const graphics = node.getComponent(cc.Graphics);
    if (graphics) {
        graphics.enabled = true;
        graphics.clear();
    }
    const mask = node.getComponent(cc.Mask) ?? node.addComponent(cc.Mask);
    mask.type = spec.figmaType === 'ELLIPSE'
        ? cc.Mask.Type.GRAPHICS_ELLIPSE ?? cc.Mask.Type.ELLIPSE
        : cc.Mask.Type.GRAPHICS_RECT ?? cc.Mask.Type.RECT;
    mask.inverted = false;
}

function clipsGeneratedChildren(spec: SceneNodeSpec): boolean {
    return spec.clipsContent
        && spec.kind !== 'scrollView'
        && spec.children.length > 0
        && spec.action === 'generate';
}

function configureButton(node: any, spec: SceneNodeSpec, cc: any): void {
    if (spec.kind === 'button') {
        const button = node.getComponent(cc.Button) ?? node.addComponent(cc.Button);
        button.target = node;
        button.transition = cc.Button.Transition.SCALE;
        button.zoomScale = 0.9;
        button.duration = 0.1;
    }
}

function configureScroll(
    node: any,
    spec: SceneNodeSpec,
    transform: any,
    scale: number,
    cc: any,
    guard?: PrefabOwnershipGuard,
): any {
    if (spec.kind !== 'scrollView') {
        return node;
    }
    const { Node, UITransform, Mask, ScrollView } = cc;
    let view = node.getChildByName('view');
    let content = view?.getChildByName('content') ?? null;
    if (view && guard) {
        assertOwnedHelperSubtree(view, guard);
        if (content) {
            assertOwnedHelperNode(content, guard);
        }
    }
    const scroll = node.getComponent(ScrollView) ?? node.addComponent(ScrollView);
    if (!view) {
        view = new Node('view');
        view.layer = node.layer;
        node.addChild(view);
    }
    const viewTransform = view.getComponent(UITransform) ?? view.addComponent(UITransform);
    viewTransform.setAnchorPoint(0.5, 0.5);
    viewTransform.setContentSize(transform.contentSize.width, transform.contentSize.height);
    view.setPosition(0, 0, 0);
    const mask = view.getComponent(Mask) ?? view.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT ?? Mask.Type.RECT;
    if (!content) {
        content = new Node('content');
        content.layer = node.layer;
        view.addChild(content);
    }
    const contentTransform = content.getComponent(UITransform) ?? content.addComponent(UITransform);
    const previousLayout = content.getComponent(cc.Layout);
    const nextLayoutMode = spec.layout?.mode;
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

function scrollAxes(spec: SceneNodeSpec): { horizontal: boolean; vertical: boolean } {
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

function sizeAndPositionScrollContent(
    content: any,
    contentTransform: any,
    spec: SceneNodeSpec,
    viewport: any,
    scale: number,
): void {
    const viewportWidth = Math.max(0, Number(viewport.contentSize?.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.contentSize?.height) || 0);
    const childRight = spec.children.map((child) =>
        (child.frame.x - spec.frame.x + child.frame.width) * scale);
    const childBottom = spec.children.map((child) =>
        (child.frame.y - spec.frame.y + child.frame.height) * scale);
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
    content.setPosition(
        (contentWidth - viewportWidth) / 2,
        (viewportHeight - contentHeight) / 2,
        0,
    );
}

function finalizeScroll(
    node: any,
    spec: SceneNodeSpec,
    content: any,
    viewport: any,
    scale: number,
    cc: any,
): void {
    if (spec.kind !== 'scrollView' || content === node) {
        return;
    }
    const transform = content.getComponent(cc.UITransform);
    if (!transform) {
        return;
    }
    sizeAndPositionScrollContent(content, transform, spec, viewport, scale);
}

function countSpecs(specs: SceneNodeSpec[]): number {
    return specs.reduce((total, spec) => total + 1 + countSpecs(spec.children), 0);
}

function centerInCanvas(node: any, canvas: any, UITransform: any, Vec3: any): void {
    const nodeTransform = node.getComponent(UITransform);
    const canvasTransform = canvas?.getComponent(UITransform);
    if (!nodeTransform || !canvasTransform) {
        return;
    }
    const canvasSize = canvasTransform.contentSize ?? {
        width: canvasTransform.width,
        height: canvasTransform.height,
    };
    const width = Number(canvasSize?.width) > 0 ? Number(canvasSize.width) : 640;
    const height = Number(canvasSize?.height) > 0 ? Number(canvasSize.height) : 1136;
    const canvasAnchor = canvasTransform.anchorPoint ?? { x: 0.5, y: 0.5 };
    const nodeAnchor = nodeTransform.anchorPoint ?? { x: 0.5, y: 0.5 };
    const x = width * (0.5 - canvasAnchor.x)
        - nodeTransform.width * (0.5 - nodeAnchor.x);
    const y = height * (0.5 - canvasAnchor.y)
        - nodeTransform.height * (0.5 - nodeAnchor.y);
    node.setPosition(new Vec3(x, y, node.position?.z ?? 0));
}

function nodeComponents(node: any): any[] {
    const value = node?.components ?? node?._components;
    return Array.isArray(value) ? value : [];
}

function reorderFigmaChildren(parent: any, orderedNodes: any[]): void {
    const desired = [...new Set(orderedNodes.filter(Boolean))];
    if (!desired.length || typeof desired[0]?.setSiblingIndex !== 'function') {
        return;
    }
    // Figma-owned children are kept in Figma order. User-authored children are
    // never reordered against one another; they follow the managed block.
    desired.forEach((node, index) => node.setSiblingIndex(index));
}

function removeStalePrefabNodes(
    prefabRoot: any,
    previousNodeFileIds: Set<string>,
    previousHelperFileIds: Set<string>,
    previousComponentFileIds: Set<string>,
    retainedNodeFileIds: Set<string>,
): void {
    const index = prefabFileIdIndex(prefabRoot);
    const stale = new Map<string, any>();
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
                throw new Error(
                    `待删除的 Figma 节点“${node.name}”含有手工组件，已停止同步以防止数据丢失。`,
                );
            }
        }
    }
    const salvageManualDescendants = (container: any, survivorParent: any) => {
        for (const child of [...container.children]) {
            const childFileId = nodePrefabFileId(child);
            if (childFileId
                && (previousNodeFileIds.has(childFileId) || previousHelperFileIds.has(childFileId))) {
                salvageManualDescendants(child, survivorParent);
            } else {
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

function capturePrefabSync(
    prefabRoot: any,
    nodeMap: Record<string, string>,
    previous: PrefabSceneSyncContext,
    preexistingNodeUuids: Set<string>,
    preexistingComponents: Set<any>,
    generatedClasses: any[],
    cc: any,
): PrefabSceneSyncCapture {
    const previousComponents = new Set(previous.managedComponentFileIds);
    const previousHelpers = new Set(previous.managedHelperFileIds);
    const nodeFileIds: Record<string, string> = {};
    const managedNodes = new Set<string>();
    const managedComponents = new Set<string>();
    const managedHelpers = new Set<string>();
    const managedHelperRuntimeUuids = new Set<string>();
    const mappedUuids = new Set(Object.values(nodeMap));
    const managedRuntimeNodes = new Map<string, any>();

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
            throw new Error(
                `节点“${parent.name}”下存在与导入辅助节点同名的手工节点“${node.name}”，已停止同步。`,
            );
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

function refreshPrefabLayouts(
    specs: SceneNodeSpec[],
    prefabRoot: any,
    nodeMap: Record<string, string>,
    scale: number,
    cc: any,
): void {
    const visit = (spec: SceneNodeSpec) => {
        const uuid = nodeMap[spec.figmaId];
        const node = uuid ? findByUuid(prefabRoot, uuid) : null;
        if (!node) {
            return;
        }
        const childParent = spec.kind === 'scrollView'
            ? node.getChildByName('view')?.getChildByName('content') ?? node
            : node;
        const layoutMode = spec.layout?.mode;
        const layout = spec.action === 'generate' && layoutMode && layoutMode !== 'NONE'
            ? childParent.getComponent(cc.Layout)
            : null;
        layout?.updateLayout();
        if (layout) {
            applyCounterAlignment(childParent, spec, nodeMap, scale, cc);
        }
        if (spec.kind === 'scrollView' && childParent !== node) {
            finalizeScroll(
                node,
                spec,
                childParent,
                node.getComponent(cc.UITransform),
                scale,
                cc,
            );
        }
        spec.children.forEach(visit);
    };
    specs.forEach(visit);
}

function emitSceneProgress(
    payload: SceneImportPayload,
    value: number,
    message: string,
): void {
    try {
        Editor.Message.send(payload.packageName, 'progress', {
            phase: 'scene',
            value,
            message,
        });
    } catch {
        // 进度反馈不可用时不应中断场景导入。
    }
}

export function load(): void {}

export function unload(): void {}

export const methods = {
    inspectPrefabContext(payload: {
        prefabUuid: string;
        rootFileId?: string;
    }): PrefabEditingState {
        return prefabEditingState(payload.prefabUuid, payload.rootFileId);
    },

    async importDocument(payload: SceneImportPayload): Promise<SceneImportResult> {
        const cc = require('cc') as any;
        const {
            director,
            Node,
            UITransform,
            Canvas,
            Graphics,
            Sprite,
            Label,
            RichText,
            LabelOutline,
            Layout,
            ScrollView,
            Mask,
            Button,
            UIOpacity,
            Camera,
        } = cc;
        const scene = director.getScene();
        if (!scene) {
            throw new Error('当前没有打开的场景。');
        }
        const prefabContext = payload.prefabContext;
        let prefabRoot: any | null = null;
        if (prefabContext) {
            const state = prefabEditingState(prefabContext.prefabUuid, prefabContext.rootFileId);
            if (!state.ready) {
                throw new Error(`目标 Prefab 尚未安全打开：${state.reason ?? '未知原因'}`);
            }
            prefabRoot = (globalThis as any).cce.Scene.rootNode;
            const fileIdIndex = prefabFileIdIndex(prefabRoot, prefabContext.prefabUuid);
            const existingMap: Record<string, string> = {
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
        const preexistingPrefabNodeUuids = new Set<string>();
        const preexistingPrefabComponents = new Set<any>();
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
        const fallbackParent = prefabRoot?.parent ?? findCanvas(scene, Canvas) ?? scene;
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
        const nodeMap: Record<string, string> = {};
        let created = 0;
        let updated = 0;
        const totalNodes = Math.max(1, countSpecs(roots));
        let completedNodes = 0;
        const previousManagedComponents = new Set(prefabContext?.managedComponentFileIds ?? []);
        const previousManagedHelpers = new Set(prefabContext?.managedHelperFileIds ?? []);
        const prefabOwnershipGuard: PrefabOwnershipGuard | undefined = prefabContext
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
        if (existingRootNode?.getComponent(Camera)) {
            existingRootNode = null;
        }
        // In a direct-root import, __root__ aliases the Figma root UUID. In a
        // multi-root import it identifies a synthetic wrapper and must never be
        // reused as one of its own children when the root count changes.
        const existingRootWasDirect = Boolean(existingRootUuid
            && Object.entries(payload.existingMap).some(([figmaId, uuid]) =>
                figmaId !== '__root__' && uuid === existingRootUuid));
        const previousDirectRoot = existingRootWasDirect ? existingRootNode : null;
        const previousWrapper = !existingRootWasDirect ? existingRootNode : null;
        const mappedRootUuid = directRoot
            ? existingUuidForSpec(payload.existingMap, roots[0])
            : (!existingRootWasDirect ? existingRootUuid : undefined);
        let importRoot = prefabRoot ?? (payload.updateExisting && mappedRootUuid
            ? findByUuid(scene, mappedRootUuid)
            : null);
        if (!prefabContext && importRoot?.getComponent(Camera)) {
            importRoot = null;
        }
        const legacyWrapper = directRoot
            ? previousWrapper ?? (importRoot?.parent?.name.startsWith('Figma · ')
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
            } else {
                importRoot.parent = parent;
                importRoot.name = `Figma · ${cleanName(payload.rootName)}`;
                updated += 1;
            }
            const rootTransform = importRoot.getComponent(UITransform) ?? importRoot.addComponent(UITransform);
            rootTransform.setAnchorPoint(0.5, 0.5);
            rootTransform.setContentSize(
                payload.rootFrame.width * payload.scale,
                payload.rootFrame.height * payload.scale,
            );
            importRoot.setPosition(0, 0, 0);
            nodeMap.__root__ = importRoot.uuid;
        } else if (!importRoot) {
            importRoot = new Node(cleanName(roots[0].name));
            parent.addChild(importRoot);
        }

        // A collapsed SceneSpec can intentionally map several Figma IDs to a
        // single Cocos node. If a later import expands that subtree again,
        // those IDs still point at the same old UUID. Claim each reusable node
        // once per build so a child can never reuse (and reparent) its parent.
        const claimedNodeUuids = new Set<string>();
        const build = async (
            spec: SceneNodeSpec,
            nodeParent: any,
            providedNode?: any,
        ): Promise<void> => {
            let node = providedNode ?? null;
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
            } else {
                updated += 1;
            }
            if (prefabOwnershipGuard && existed) {
                const existingTransform = node.getComponent(UITransform);
                if (existingTransform) {
                    assertOwnedGeneratedComponent(
                        existingTransform,
                        prefabOwnershipGuard,
                        node.name,
                    );
                }
                if (spec.action !== 'transform') {
                    for (const helper of node.children.filter((child: any) =>
                        isGeneratedHelperNode(child, node, cc)
                        || (spec.kind === 'scrollView' && child.name === 'view'))) {
                        assertOwnedHelperSubtree(helper, prefabOwnershipGuard);
                        if (spec.kind === 'scrollView' && helper.name === 'view') {
                            const content = helper.getChildByName?.('content');
                            if (content) {
                                assertOwnedHelperNode(content, prefabOwnershipGuard);
                            }
                        }
                        if (helper.name === TILED_MASK_NODE_NAME) {
                            const tiledSprite = helper.getChildByName?.(TILED_SPRITE_NODE_NAME);
                            if (tiledSprite) {
                                assertOwnedHelperNode(tiledSprite, prefabOwnershipGuard);
                            }
                        }
                    }
                    for (const component of nodeComponents(node)) {
                        if (generatedClasses.includes(component.constructor)) {
                            assertOwnedGeneratedComponent(
                                component,
                                prefabOwnershipGuard,
                                node.name,
                            );
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
                const removedRenderComponent = removeGeneratedComponents(
                    node,
                    generatedClasses,
                    preserved,
                    [Graphics, Sprite, Label, RichText],
                    prefabContext ? previousManagedComponents : undefined,
                );
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
                        await configureTiledSpriteHelper(
                            node,
                            spec,
                            payload.scale,
                            cc,
                            prefabOwnershipGuard,
                        );
                    } else if (overflowSpriteHelper) {
                        await configureOverflowSpriteHelper(
                            node,
                            spec,
                            payload.scale,
                            cc,
                            prefabOwnershipGuard,
                        );
                    } else {
                        await configureSprite(node, spec, payload.scale, cc);
                    }
                } else if (spec.kind === 'richText') {
                    configureRichText(node, spec, payload.scale, cc);
                    const richText = node.getComponent(RichText);
                    if (spec.fontUuid) {
                        const font = await loadAsset(cc.assetManager, spec.fontUuid);
                        if (cc.TTFFont && !(font instanceof cc.TTFFont)) {
                            throw new Error(
                                `RichText 节点“${spec.name}”只能使用 TTF/OTF 字体，当前映射可能是 BitmapFont（.fnt）。`,
                            );
                        }
                        richText.font = font;
                    } else {
                        richText.font = null;
                    }
                    finalizeLabelGeometry(node, spec, payload.scale, cc);
                } else if (spec.kind === 'label' || spec.figmaType === 'TEXT') {
                    configureLabel(node, spec, payload.scale, cc);
                    if (spec.fontUuid) {
                        const label = node.getComponent(Label);
                        label.font = await loadAsset(cc.assetManager, spec.fontUuid);
                    } else {
                        node.getComponent(Label).font = null;
                    }
                    finalizeLabelGeometry(node, spec, payload.scale, cc);
                } else if (RASTER_VECTOR_TYPES.has(spec.figmaType)) {
                    throw new Error(`矢量节点“${spec.name}”没有绑定 SpriteFrame，PNG 资源可能未成功导入。`);
                } else if (clipsChildren) {
                    configureClip(node, spec, cc);
                } else if (hasGraphicsVisual(spec)) {
                    configureGraphics(node, spec, payload.scale, cc);
                }
                configureOpacity(node, spec, cc);
                configureButton(node, spec, cc);
            }

            const transform = node.getComponent(UITransform);
            const childParent = spec.action === 'transform'
                ? node
                : configureScroll(
                    node,
                    spec,
                    transform,
                    payload.scale,
                    cc,
                    prefabOwnershipGuard,
                );
            if (spec.action === 'generate') {
                configureLayout(childParent, spec, payload.scale, cc);
            }
            for (const child of spec.children) {
                await build(child, childParent);
            }
            if (prefabContext) {
                reorderFigmaChildren(
                    childParent,
                    spec.children.map((child) => {
                        const uuid = nodeMap[child.figmaId];
                        return uuid ? findByUuid(childParent, uuid) : null;
                    }),
                );
            }
            const layoutMode = spec.layout?.mode;
            const layout = spec.action === 'generate' && layoutMode && layoutMode !== 'NONE'
                ? childParent.getComponent(Layout)
                : null;
            layout?.updateLayout();
            if (layout) {
                applyCounterAlignment(childParent, spec, nodeMap, payload.scale, cc);
            }
            finalizeScroll(node, spec, childParent, transform, payload.scale, cc);
            if (!existed && spec.action === 'transform') {
                node.name += ' · Transform';
            }
            completedNodes += 1;
            emitSceneProgress(
                payload,
                completedNodes / totalNodes,
                `构建节点 ${completedNodes}/${totalNodes} · ${spec.name}`,
            );
        };

        try {
            for (const root of roots) {
                await build(root, directRoot ? parent : importRoot, directRoot ? importRoot : undefined);
            }
            if (payload.updateExisting && !prefabContext) {
                removeCollapsedMappedDescendants(
                    importRoot,
                    payload.existingMap,
                    nodeMap,
                    roots,
                    cc,
                );
            }
            if (directRoot) {
                nodeMap.__root__ = importRoot.uuid;
                if (payload.centerInCanvas && canvas) {
                    centerInCanvas(importRoot, canvas, UITransform, cc.Vec3);
                }
            }
            const retainedUuids = new Set(Object.values(nodeMap));
            const staleTransitionUuids = new Set(
                Object.entries(payload.existingMap)
                    .filter(([figmaId, uuid]) => figmaId !== '__root__' && !retainedUuids.has(uuid))
                    .map(([, uuid]) => uuid),
            );
            if (!prefabContext && legacyWrapper && legacyWrapper !== importRoot && legacyWrapper.parent) {
                removeMappedNodeTree(legacyWrapper, parent, staleTransitionUuids, cc);
            }
            if (!prefabContext && previousDirectRoot
                && previousDirectRoot !== importRoot
                && !retainedUuids.has(previousDirectRoot.uuid)
                && previousDirectRoot.parent) {
                removeMappedNodeTree(
                    previousDirectRoot,
                    directRoot ? parent : importRoot,
                    staleTransitionUuids,
                    cc,
                );
            }
            if (!prefabContext) {
                mergePreservedMappings(importRoot, payload.existingMap, nodeMap);
            }
        } catch (error) {
            if (!reusedImportRoot) {
                salvageExistingMappedNodes(
                    importRoot,
                    parent,
                    new Set(Object.values(payload.existingMap)),
                );
                importRoot.removeFromParent();
                importRoot.destroy();
            }
            throw error;
        }
        let prefabSync: PrefabSceneSyncCapture | undefined;
        if (prefabContext) {
            const retainedNodeFileIds = new Set<string>();
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
            removeStalePrefabNodes(
                importRoot,
                new Set(prefabContext.managedNodeFileIds),
                previousManagedHelpers,
                previousManagedComponents,
                retainedNodeFileIds,
            );
            refreshPrefabLayouts(roots, importRoot, nodeMap, payload.scale, cc);
            prefabSync = capturePrefabSync(
                importRoot,
                nodeMap,
                prefabContext,
                preexistingPrefabNodeUuids,
                preexistingPrefabComponents,
                [UITransform, ...generatedClasses],
                cc,
            );
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

    removeImportedNode(payload: { rootUuid: string }): boolean {
        const cc = require('cc') as any;
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
