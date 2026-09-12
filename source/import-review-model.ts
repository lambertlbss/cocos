import { normalizeCocosUuid } from './roundtrip/uuid';

/** Serializable review data shared by the main process, Scene and panel. */
export interface ReviewComponent {
    id: string;
    type: string;
    managed: boolean;
    properties: Record<string, string | number | boolean | null>;
}

export interface ReviewNode {
    id: string;
    uuid: string;
    parentId: string | null;
    name: string;
    depth: number;
    order: number;
    active: boolean;
    geometry: number[];
    components: ReviewComponent[];
    figmaIds: string[];
}

export interface ReviewScene {
    rootUuid: string;
    targetUuid: string;
    mode: string;
    nodes: ReviewNode[];
    /** Import finalization only: adopted geometry, never an authorization to ignore later edits. */
    saveAdjustments?: { count: number; details: string[] };
}

const resourceProperties = new Set(['spriteFrame', 'font', 'normalSprite', 'pressedSprite', 'hoverSprite', 'disabledSprite']);
const geometryNames = ['位置 X', '位置 Y', '位置 Z', '宽度', '高度', '旋转 X', '旋转 Y', '旋转 Z', '缩放 X', '缩放 Y', '锚点 X', '锚点 Y'];

/** Only the import's save boundary may adopt geometry changes (e.g. deferred text/layout sizing).
 * Never infer that an arbitrary changed property is harmless, or match objects by display name.
 * Object/property enumeration order and equivalent asset UUID encodings are not semantic changes.
 */
export function compareSavedReviewScene(before: ReviewScene, after: ReviewScene): {
    issues: string[]; adjustments: { count: number; details: string[] };
} {
    const issues: string[] = [];
    const adjustments = { count: 0, details: [] as string[] };
    const describe = (value: unknown) => (JSON.stringify(value) ?? '未记录').slice(0, 140);
    const issue = (message: string) => { if (issues.length < 5) issues.push(message); };
    const adjustment = (message: string) => {
        adjustments.count++;
        if (adjustments.details.length < 5) adjustments.details.push(message);
    };
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const index = <T extends { id: string }>(items: T[], label: string) => {
        const result = new Map<string, T>();
        for (const item of items) {
            if (!item.id || result.has(item.id)) issue(`${label}标识为空或重复：${describe(item.id)}`);
            result.set(item.id, item);
        }
        return result;
    };
    const previous = index(before.nodes, '保存前节点');
    const current = index(after.nodes, '保存后节点');
    for (const old of before.nodes) {
        const node = current.get(old.id);
        const label = `节点“${old.name}”[${old.id}]`;
        if (!node) { issue(`${label}已删除或标识改变`); continue; }
        for (const key of ['parentId', 'name', 'depth', 'order', 'active'] as const) {
            if (old[key] !== node[key]) issue(`${label}.${key}：${describe(old[key])} → ${describe(node[key])}`);
        }
        if (!same([...old.figmaIds].sort(), [...node.figmaIds].sort())) issue(`${label}的 Figma 映射改变`);
        if (old.geometry.length !== node.geometry.length || node.geometry.some((value) => !Number.isFinite(value))) {
            issue(`${label}的几何数据无效`);
        } else old.geometry.forEach((value, i) => {
            if (value !== node.geometry[i]) adjustment(`${label}.${geometryNames[i] ?? i}：${value} → ${node.geometry[i]}`);
        });
        const oldComponents = index(old.components, `${label}保存前组件`);
        const newComponents = index(node.components, `${label}保存后组件`);
        for (const component of old.components) {
            const next = newComponents.get(component.id);
            const componentLabel = `${label} / ${component.type}[${component.id}]`;
            if (!next) { issue(`${componentLabel}已移除或标识改变`); continue; }
            if (component.type !== next.type || component.managed !== next.managed) {
                issue(`${componentLabel}的类型或插件管理归属改变`);
            }
            for (const key of new Set([...Object.keys(component.properties), ...Object.keys(next.properties)])) {
                const left = component.properties[key]; const right = next.properties[key];
                const normalize = (value: unknown) => resourceProperties.has(key) && typeof value === 'string'
                    ? normalizeCocosUuid(value) : value;
                if (same(normalize(left), normalize(right))) continue;
                issue(`${componentLabel}.${key}${resourceProperties.has(key) ? '（资源引用）' : ''}：${describe(left)} → ${describe(right)}`);
            }
        }
        for (const component of node.components) {
            if (!oldComponents.has(component.id)) issue(`${label}新增组件 ${component.type}[${component.id}]`);
        }
    }
    for (const node of after.nodes) {
        if (!previous.has(node.id)) issue(`新增节点“${node.name}”[${node.id}]`);
    }
    return { issues, adjustments };
}

export interface ReviewNodeChange {
    id: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    fields: string[];
    before?: ReviewNode;
    after?: ReviewNode;
}

export interface ReviewAsset {
    id: string;
    uuid: string;
    url: string;
    name: string;
    state: 'new' | 'updated' | 'reused' | 'deleted';
    sources: string[];
    figmaIds: string[];
    nodeNames: string[];
    canRemove: boolean;
    reason?: string;
    hasBefore: boolean;
}

export interface ImportReview {
    id: string;
    createdAt: string;
    fileName: string;
    targetUrl?: string;
    assets: ReviewAsset[];
    before: ReviewScene;
    after: ReviewScene;
    sourceTree: Array<{
        id: string; name: string; depth: number; type: string; visible: boolean;
        sliceMerge?: { mode: 'horizontal' | 'vertical' | 'nine'; sourceId: string; targetName: string };
    }>;
    changes: ReviewNodeChange[];
    warnings: string[];
    confirmed: boolean;
    /** Historical snapshot only; no cleanup transaction may be started. */
    readOnlyReason?: string;
    backupFolder?: string;
}

export function diffReviewNodes(before: ReviewNode[], after: ReviewNode[]): ReviewNodeChange[] {
    const previous = new Map(before.map((node) => [node.id, node]));
    const current = new Set(after.map((node) => node.id));
    const rows: ReviewNodeChange[] = after.map((node) => {
        const old = previous.get(node.id);
        if (!old) return { id: node.id, status: 'added', fields: ['新增节点'], after: node };
        const fields: string[] = [];
        if (old.name !== node.name) fields.push('名称');
        if (old.parentId !== node.parentId) fields.push('父节点');
        if (old.order !== node.order) fields.push('顺序');
        if (old.active !== node.active) fields.push('显隐');
        if (JSON.stringify(old.geometry) !== JSON.stringify(node.geometry)) fields.push('位置/尺寸/旋转');
        const comparable = (components: ReviewComponent[]) => components.map(({ id, type, properties }) => ({ id, type, properties }));
        if (JSON.stringify(comparable(old.components)) !== JSON.stringify(comparable(node.components))) fields.push('组件/属性/资源引用');
        return { id: node.id, status: fields.length ? 'changed' : 'unchanged', fields, before: old, after: node };
    });
    for (const old of before) {
        if (!current.has(old.id)) rows.push({ id: old.id, status: 'removed', fields: ['删除节点'], before: old });
    }
    return rows;
}

export function reviewFingerprint(scene: ReviewScene): string {
    // These are ordered, bounded, explicitly selected properties, not live engine objects.
    return JSON.stringify([scene.rootUuid, scene.targetUuid, scene.mode, scene.nodes]);
}

export function validateRemovalSelection(review: ImportReview, ids: unknown): ReviewAsset[] {
    if (review.readOnlyReason) throw new Error(`本次结果仅供查看：${review.readOnlyReason}`);
    if (review.confirmed) throw new Error('本次检查已确认，请重新导入后再调整。');
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('资源选择格式无效。');
    const assets = new Map(review.assets.map((asset) => [asset.id, asset]));
    return [...new Set(ids as string[])].map((id) => {
        const asset = assets.get(id);
        if (!asset || asset.state !== 'new' || !asset.canRemove) {
            throw new Error('只能删除本次新建且允许删除的资源。');
        }
        return asset;
    });
}
