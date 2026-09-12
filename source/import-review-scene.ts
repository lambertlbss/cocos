import { compareSavedReviewScene, reviewFingerprint, type ReviewComponent, type ReviewNode, type ReviewScene } from './import-review-model';
import { normalizeCocosUuid } from './roundtrip/uuid';

function walk(root: any, visit: (node: any, depth: number) => void, depth = 0): void {
    if (!root) return;
    visit(root, depth);
    for (const child of root.children ?? []) walk(child, visit, depth + 1);
}

function components(node: any): any[] { return node.components ?? node._components ?? []; }
function nodeId(node: any): string { return node?._prefab?.fileId || node?.uuid || ''; }
function componentId(component: any, index: number): string {
    return component.__prefab?.fileId || component.uuid || `${index}:${component.constructor?.name}`;
}
function assetId(asset: any): string | null { return asset?._uuid || asset?.uuid || null; }
function instanceOf(component: any, Class: any): boolean {
    return typeof Class === 'function' && component instanceof Class;
}
function recordColor(properties: ReviewComponent['properties'], component: any, key: string): void {
    // Getters may have side effects. Read each supported color exactly once.
    const color = component[key];
    if (color) properties[key] = ['r', 'g', 'b', 'a'].map((channel) => color[channel]).join(',');
}
export function reviewManagedComponentIds(root: any, nodeMap: Record<string, string>, classes: any[]): string[] {
    const mapped = new Set(Object.values(nodeMap));
    const ids: string[] = [];
    walk(root, (node) => {
        if (!mapped.has(node.uuid) && !/^__Figma(?:OverflowVisual|TiledMask|TiledSprite)$/.test(node.name)) return;
        components(node).forEach((component, index) => {
            if (classes.some((Class) => Class && component instanceof Class)) ids.push(componentId(component, index));
        });
    });
    return ids;
}
const number = (value: any, fallback = 0) => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : fallback;

export function captureReviewScene(
    root: any,
    cc: any,
    nodeMap: Record<string, string> = {},
    managedIds: string[] = [],
): ReviewScene {
    const facade = (globalThis as any).cce?.SceneFacadeManager;
    const mapped = new Map<string, string[]>();
    for (const [id, uuid] of Object.entries(nodeMap)) {
        if (id === '__root__') continue;
        mapped.set(uuid, [...(mapped.get(uuid) ?? []), id]);
    }
    const managed = new Set(managedIds);
    const nodes: ReviewNode[] = [];
    walk(root, (node, depth) => {
        const ui = node.getComponent(cc.UITransform);
        const rotation = node.eulerAngles ?? node.euler;
        const recorded: ReviewComponent[] = components(node).map((component, index) => {
            const type = cc.js?.getClassName?.(component) || component.constructor?.name || 'Component';
            const id = componentId(component, index);
            const properties: ReviewComponent['properties'] = { enabled: component.enabled !== false };
            if (instanceOf(component, cc.Mask)) {
                // Creator >=3.6 separates Mask rules from its Sprite/Graphics.
                // Legacy Mask.color warns even on reads; do not probe legacy
                // renderer properties (including Mask.spriteFrame) at all.
                properties.type = number(component.type);
                properties.inverted = Boolean(component.inverted);
                properties.alphaThreshold = number(component.alphaThreshold);
                properties.segments = number(component.segments);
                const renderer = component.subComp;
                if (instanceOf(renderer, cc.Sprite)) properties.spriteFrame = assetId(renderer.spriteFrame);
                return { id, type, managed: managed.has(id), properties };
            }
            for (const key of ['string', 'fontSize', 'lineHeight', 'overflow', 'type', 'sizeMode', 'opacity',
                'horizontal', 'vertical', 'inverted', 'spacingX', 'spacingY', 'paddingLeft', 'paddingRight',
                'paddingTop', 'paddingBottom', 'resizeMode', 'transition', 'enableOutline', 'outlineWidth']) {
                const value = component[key];
                if (typeof value === 'number') properties[key] = number(value);
                else if (typeof value === 'string' || typeof value === 'boolean') properties[key] = value;
            }
            for (const key of ['spriteFrame', 'font', 'normalSprite', 'pressedSprite', 'hoverSprite', 'disabledSprite']) {
                if (key in component) properties[key] = assetId(component[key]);
            }
            if ([cc.Sprite, cc.Label, cc.RichText, cc.Graphics].some((Class) => instanceOf(component, Class))) {
                recordColor(properties, component, 'color');
            }
            if (instanceOf(component, cc.Graphics)) {
                recordColor(properties, component, 'fillColor');
                recordColor(properties, component, 'strokeColor');
            }
            return { id, type, managed: managed.has(id), properties };
        });
        nodes.push({
            id: nodeId(node), uuid: node.uuid, parentId: node === root ? null : nodeId(node.parent),
            name: node.name, depth, order: node === root ? 0 : node.parent.children.indexOf(node),
            active: node.active !== false,
            geometry: [node.position?.x, node.position?.y, node.position?.z, ui?.width, ui?.height,
                rotation?.x, rotation?.y, rotation?.z, node.scale?.x ?? 1, node.scale?.y ?? 1,
                ui?.anchorPoint?.x ?? 0.5, ui?.anchorPoint?.y ?? 0.5].map((value) => number(value)),
            components: recorded, figmaIds: mapped.get(node.uuid) ?? [],
        });
    });
    return { rootUuid: root?.uuid ?? '', targetUuid: String(facade?.queryCurrentSceneUuid?.() ?? ''),
        mode: String(facade?.queryMode?.() ?? 'scene'), nodes };
}

interface SceneReviewSession {
    root: any;
    scene: any;
    cc: any;
    nodeMap: Record<string, string>;
    managedIds: string[];
    after: ReviewScene;
    detached?: Array<{ component: any; asset: any }>;
}
const sessions = new Map<string, SceneReviewSession>();

export function registerSceneReview(id: string, root: any, cc: any, nodeMap: Record<string, string>, managedIds: string[],
    expectedTarget?: { targetUuid: string; mode: string }): ReviewScene {
    const after = captureReviewScene(root, cc, nodeMap, managedIds);
    // Prefab import already verified this identity before writing. Facade queries
    // can still expose the previous target while Creator finishes opening it.
    if (expectedTarget) Object.assign(after, expectedTarget);
    sessions.clear();
    sessions.set(id, { root, scene: cc.director.getScene(), cc, nodeMap, managedIds, after });
    return after;
}

function sessionFor(id: string): SceneReviewSession {
    const session = sessions.get(id);
    if (!session || session.cc.director.getScene() !== session.scene) throw new Error('检查结果已过期，请重新导入。');
    if (session.cc.isValid && !session.cc.isValid(session.root, true)) throw new Error('原导入节点已失效，请重新导入。');
    const current = captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
    if (reviewFingerprint(current) !== reviewFingerprint(session.after)) {
        throw new Error('节点或编辑目标在导入后发生变化，请重新导入生成新的对比结果。');
    }
    return session;
}

/** Discover custom component/array references as well as ordinary Sprite slots. */
function containsAsset(value: any, ids: Set<string>, cc: any, seen = new Set<any>()): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    const uuid = assetId(value);
    if (uuid && ids.has(normalizeCocosUuid(uuid))) return true;
    if (value instanceof cc.Node || (cc.Component && value instanceof cc.Component)
        || (cc.Asset && value instanceof cc.Asset)) return false;
    seen.add(value);
    return Object.values(value).some((child) => containsAsset(child, ids, cc, seen));
}

function clearFrame(component: any, value: any, cc: any): void {
    const ui = component.node.getComponent(cc.UITransform);
    const width = ui?.width;
    const height = ui?.height;
    component.spriteFrame = value;
    if (ui) ui.setContentSize(width, height);
}

export function prepareReviewRemoval(payload: { id: string; uuids: string[]; detach?: boolean }): ReviewScene {
    const session = sessionFor(payload.id);
    if (session.detached) throw new Error('资源清理正在执行。');
    const ids = new Set(payload.uuids.map(normalizeCocosUuid));
    const snapshotNodes = new Map(session.after.nodes.map((node) => [node.uuid, node]));
    const allowed = new Set<any>();
    const slots: Array<{ component: any; asset: any }> = [];
    walk(session.root, (node) => {
        components(node).forEach((component, index) => {
            const snapshot = snapshotNodes.get(node.uuid);
            const recorded = snapshot?.components.find((item) => item.id === componentId(component, index));
            if (component instanceof session.cc.Sprite && recorded?.managed
                && ids.has(normalizeCocosUuid(assetId(component.spriteFrame) ?? ''))) {
                allowed.add(component);
                slots.push({ component, asset: component.spriteFrame });
            }
        });
    });
    // Include inactive nodes and nodes outside the imported root.
    const inspected = new Set<any>();
    const inspectNode = (node: any) => {
        if (inspected.has(node)) return;
        inspected.add(node);
        for (const component of components(node)) {
            const declared = component.constructor?.__props__;
            const attributes = session.cc.js?.getClassAttrs?.(component.constructor) ?? {};
            const keys: string[] = Array.isArray(declared) ? declared : Object.keys(component);
            for (const key of keys) {
                if (attributes[`${key}$_$serializable`] === false) continue;
                if (['node', '_node', '__prefab'].includes(key)) continue;
                if (allowed.has(component) && ['_spriteFrame', 'spriteFrame'].includes(key)) continue;
                if (containsAsset(component[key], ids, session.cc)) {
                    throw new Error(`资源还被节点“${node.name}”的其他组件或属性引用，已停止删除。`);
                }
            }
        }
    };
    walk(session.scene, inspectNode);
    walk(session.root, inspectNode);
    if (payload.detach) {
        session.detached = [];
        try {
            for (const slot of slots) {
                session.detached.push(slot);
                clearFrame(slot.component, null, session.cc);
            }
        } catch (error) {
            for (const slot of session.detached) clearFrame(slot.component, slot.asset, session.cc);
            session.detached = undefined;
            throw error;
        }
    }
    return captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
}

export function finishReviewRemoval(payload: { id: string; restore?: boolean }): ReviewScene {
    const session = sessions.get(payload.id);
    if (!session || session.cc.director.getScene() !== session.scene) throw new Error('编辑目标已切换，无法完成资源清理。');
    if (payload.restore) for (const slot of session.detached ?? []) clearFrame(slot.component, slot.asset, session.cc);
    session.detached = undefined;
    session.after = captureReviewScene(session.root, session.cc, session.nodeMap, session.managedIds);
    return session.after;
}

/** Called only by the main import flow after Creator's save/serialization has completed. */
export function refreshReviewAfter(payload: { id: string }): ReviewScene {
    const session = sessions.get(payload.id);
    if (!session) throw new Error('导入检查会话已失效。');
    const facade = (globalThis as any).cce?.SceneFacadeManager;
    const targetUuid = String(facade?.queryCurrentSceneUuid?.() ?? '');
    const mode = String(facade?.queryMode?.() ?? 'scene');
    if (normalizeCocosUuid(targetUuid) !== normalizeCocosUuid(session.after.targetUuid) || mode !== session.after.mode) {
        throw new Error(`导入编辑目标尚未稳定或已切换（预期 ${session.after.mode}:${session.after.targetUuid || '未保存'}，当前 ${mode}:${targetUuid || '未保存'}）。`);
    }
    const scene = session.cc.director.getScene();
    let root = session.root;
    let nodeMap = session.nodeMap;
    if (scene !== session.scene || (session.cc.isValid && !session.cc.isValid(root, true))) {
        const candidate = (globalThis as any).cce?.Scene?.rootNode;
        const fileId = root?._prefab?.fileId;
        if (mode !== 'prefab' || !targetUuid || !fileId || candidate?._prefab?.fileId !== fileId) {
            throw new Error('保存后无法核实原导入根节点。');
        }
        const nodes = new Map<string, any>();
        walk(candidate, (node) => {
            const id = nodeId(node);
            if (nodes.has(id)) throw new Error('保存后节点标识重复，无法安全恢复检查。');
            nodes.set(id, node);
        });
        nodeMap = {};
        for (const previous of session.after.nodes) {
            const current = nodes.get(previous.id);
            if (!current) throw new Error('保存后节点结构已改变。');
            for (const id of previous.figmaIds) nodeMap[id] = current.uuid;
        }
        root = candidate;
    }
    const after = captureReviewScene(root, session.cc, nodeMap, session.managedIds);
    const comparison = compareSavedReviewScene(session.after, after);
    if (comparison.issues.length) {
        throw new Error(`保存后节点或组件内容已变化，当前结果不能用于资源清理。具体差异：${comparison.issues.join('；')}`);
    }
    // Geometry changes do not change ownership or resource consumers. Adopt actual saved values;
    // do not write them back to the scene. Subsequent cleanup still uses the strict fingerprint.
    if (comparison.adjustments.count) after.saveAdjustments = comparison.adjustments;
    session.scene = scene;
    session.root = root;
    session.nodeMap = nodeMap;
    session.after = after;
    return after;
}
