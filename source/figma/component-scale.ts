import { CancelledError, type FigmaClient } from './client';
import { parseNode } from './parser';
import type { DocumentSession, FigmaComponentGeometry, FigmaNode } from '../types';

class ComponentScaleError extends Error {}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** REST size is before scaling/rotation; matrix columns give local axis lengths.
 * https://developers.figma.com/docs/rest-api/file-node-types/
 */
function unrotatedSize(node: FigmaComponentGeometry): { width: number; height: number } {
    let x = 1, y = 1;
    const matrix = node.relativeTransform;
    if (matrix) {
        const a = matrix[0]?.[0] ?? NaN, b = matrix[1]?.[0] ?? NaN;
        const c = matrix[0]?.[1] ?? NaN, d = matrix[1]?.[1] ?? NaN;
        if (![a, b, c, d].every((value) => typeof value === 'number' && Number.isFinite(value))) {
            throw new ComponentScaleError('Figma 变换矩阵无效');
        }
        x = Math.hypot(a, b);
        y = Math.hypot(c, d);
        if (!(x > 0 && y > 0) || !Number.isFinite(x * y)) {
            throw new ComponentScaleError('Figma 变换矩阵包含零尺寸或无效倍率');
        }
        if (Math.abs(a * c + b * d) > x * y * 1e-6) {
            throw new ComponentScaleError('Figma 变换含斜切，无法安全计算母组件倍率');
        }
    }
    if (node.size) {
        const width = node.size.width * x, height = node.size.height * y;
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
        throw new ComponentScaleError('Figma 实例或母组件的未旋转尺寸为零或无效');
    }
    // Bounding boxes already include scale, so do not apply matrix lengths a
    // second time. A rotated box cannot identify the original local dimensions.
    if (!Number.isFinite(node.rotation) || Math.abs(node.rotation) > 1e-7) {
        throw new ComponentScaleError('旋转节点缺少 Figma 未旋转尺寸，不能使用包围盒猜测倍率');
    }
    const box = node.absoluteBoundingBox;
    if (box && Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0) {
        return { width: box.width, height: box.height };
    }
    throw new ComponentScaleError('Figma 实例或母组件缺少有效尺寸');
}

/** Resolve only the caller's reachable ordinary Prefab references. Never fit
 * against engine geometry or mutate the imported source tree's structure.
 */
export async function resolvePrefabComponentScales(
    document: DocumentSession, nodes: FigmaNode[], api: FigmaClient,
): Promise<void> {
    const componentNodes = new Map<string, Promise<FigmaComponentGeometry>>();
    const published = new Map<string, Promise<{ fileKey: string; nodeId: string }>>();
    const sourceNode = (fileKey: string, nodeId: string, local: boolean): Promise<FigmaComponentGeometry> => {
        const cacheKey = JSON.stringify([fileKey, nodeId, local]);
        let task = componentNodes.get(cacheKey);
        if (!task) {
            task = (async () => {
                const known = local ? document.nodeById.get(nodeId) ?? document.componentNodes?.get(nodeId) : undefined;
                if (known?.type === 'COMPONENT') return known;
                const payload = await api.getNode(fileKey, nodeId);
                const value = record(record(payload.nodes)[nodeId]);
                const source = parseNode({ ...record(value.document), children: [],
                    componentProperties: undefined, componentPropertyDefinitions: undefined });
                if (!source || source.id !== nodeId || source.type !== 'COMPONENT') {
                    throw new ComponentScaleError('未读取到身份一致的 Figma 母组件');
                }
                return source;
            })();
            componentNodes.set(cacheKey, task);
        }
        return task;
    };
    const publishedLocation = (key: string): Promise<{ fileKey: string; nodeId: string }> => {
        let task = published.get(key);
        if (!task) {
            task = (async () => {
                // GET /v1/components/:key returns meta.file_key and meta.node_id.
                // https://developers.figma.com/docs/rest-api/component-endpoints/
                const payload = await api.getComponent(key);
                const meta = record(payload.meta);
                if (payload.error === true || typeof meta.file_key !== 'string' || !meta.file_key.trim()
                    || typeof meta.node_id !== 'string' || !meta.node_id.trim()
                    || (typeof meta.key === 'string' && meta.key !== key)) {
                    throw new ComponentScaleError('远端 Figma 母组件的来源元数据无效');
                }
                return { fileKey: meta.file_key, nodeId: meta.node_id };
            })();
            published.set(key, task);
        }
        return task;
    };
    // Clear old decisions for every supplied node before resolving, including
    // supplied nodes whose parameter was removed since the previous run.
    for (const node of nodes) { delete node.prefabScale; delete node.prefabScaleWarning; }
    for (const node of nodes) {
        if (!node.prefabName?.trim()) continue;
        try {
            if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
                node.prefabScale = { x: 1, y: 1 };
                continue;
            }
            if (node.type !== 'INSTANCE' || !node.componentId?.trim()) {
                throw new ComponentScaleError('缺少 Figma 实例的母组件标识');
            }
            const metadata = document.components?.[node.componentId];
            let mother: FigmaComponentGeometry;
            if (metadata?.remote) {
                if (!metadata.key?.trim()) throw new ComponentScaleError('远端 Figma 母组件缺少发布 key');
                const location = await publishedLocation(metadata.key);
                mother = await sourceNode(location.fileKey, location.nodeId, false);
            } else {
                mother = await sourceNode(document.fileKey, node.componentId, true);
            }
            const instanceSize = unrotatedSize(node);
            const motherSize = unrotatedSize(mother);
            const x = instanceSize.width / motherSize.width, y = instanceSize.height / motherSize.height;
            if (!Number.isFinite(x) || !Number.isFinite(y) || !(x > 0 && y > 0)) {
                throw new ComponentScaleError('Figma 实例相对母组件的倍率无效');
            }
            node.prefabScale = { x, y };
        } catch (error) {
            if (error instanceof CancelledError || (error instanceof Error
                && (error.name === 'CancelledError' || error.name === 'AbortError'))) throw error;
            const reason = error instanceof ComponentScaleError ? error.message
                : '无法读取 Figma 母组件，请检查设计和组件库读取权限后重试';
            node.prefabScaleWarning = `节点“${node.name}”未能计算 Figma 母组件倍率：${reason}；本次不猜测缩放。`;
        }
    }
}
