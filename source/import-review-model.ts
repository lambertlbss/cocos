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
    sourceTree: Array<{ id: string; name: string; depth: number; type: string; visible: boolean }>;
    changes: ReviewNodeChange[];
    warnings: string[];
    confirmed: boolean;
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
