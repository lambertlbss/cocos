import { parseFigmaSource } from '../figma/url';
import { MAX_MANAGED_NODES, ROOT_HEADER_KEY, SHARED_NAMESPACE } from './protocol';

export interface RoundtripSource {
    fileKey: string;
    nodeId?: string;
}

export interface FigmaRestNode {
    id: string;
    type: string;
    name?: string;
    children?: FigmaRestNode[];
    sharedPluginData?: Record<string, Record<string, string>>;
    relativeTransform?: [[number, number, number], [number, number, number]];
    absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
    size?: { x: number; y: number };
    visible?: boolean;
    opacity?: number;
    fills?: unknown;
    characters?: string;
    fontSize?: number | symbol;
    textAlignHorizontal?: string;
}

export interface IndexedFigmaDocument {
    version: string;
    name?: string;
    document: FigmaRestNode;
    nodes: ReadonlyMap<string, FigmaRestNode>;
    parentIds: ReadonlyMap<string, string | null>;
}

export interface RoundtripFigmaClient {
    getRoundtripFile(fileKey: string): Promise<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteRect(value: unknown): boolean {
    return isRecord(value) && ['x', 'y', 'width', 'height'].every(
        (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    );
}

function validateNode(raw: unknown, label: string): asserts raw is FigmaRestNode {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.type !== 'string' || !raw.type) {
        throw new Error(`${label} 不是有效的 Figma 节点。`);
    }
    if (raw.children !== undefined && !Array.isArray(raw.children)) throw new Error(`${label}.children 必须是数组。`);
    if (raw.sharedPluginData !== undefined && !isRecord(raw.sharedPluginData)) {
        throw new Error(`${label}.sharedPluginData 无效。`);
    }
    if (raw.relativeTransform !== undefined) {
        const matrix = raw.relativeTransform;
        if (!Array.isArray(matrix) || matrix.length !== 2 || matrix.some(
            (row) => !Array.isArray(row) || row.length !== 3 || row.some(
                (entry) => typeof entry !== 'number' || !Number.isFinite(entry),
            ),
        )) throw new Error(`${label}.relativeTransform 无效。`);
    }
    if (raw.absoluteBoundingBox !== undefined && !isFiniteRect(raw.absoluteBoundingBox)) {
        throw new Error(`${label}.absoluteBoundingBox 无效。`);
    }
}

export function parseRoundtripSource(input: string): RoundtripSource {
    const trimmed = input.trim();
    if (/^https?:/i.test(trimmed)) {
        const url = new URL(trimmed);
        for (const key of ['version-id', 'version', 'branch-id']) {
            if (url.searchParams.has(key)) throw new Error('Round-trip P0 仅支持 Figma 当前版本链接。');
        }
    }
    return parseFigmaSource(trimmed);
}

export function indexRoundtripFile(payload: Record<string, unknown>): IndexedFigmaDocument {
    if (typeof payload.version !== 'string' || !payload.version.trim()) {
        throw new Error('Figma REST 响应缺少 version，无法建立并发保护。');
    }
    validateNode(payload.document, 'document');
    const nodes = new Map<string, FigmaRestNode>();
    const parentIds = new Map<string, string | null>();
    const stack: Array<{ node: FigmaRestNode; parentId: string | null }> = [
        { node: payload.document, parentId: null },
    ];
    while (stack.length > 0) {
        const current = stack.pop()!;
        validateNode(current.node, `node(${current.node.id || '?'})`);
        if (nodes.has(current.node.id)) throw new Error(`Figma 响应包含重复 node id：${current.node.id}`);
        nodes.set(current.node.id, current.node);
        parentIds.set(current.node.id, current.parentId);
        if (nodes.size > MAX_MANAGED_NODES * 5) throw new Error('Figma 文档节点数超过本地安全上限。');
        const children = current.node.children ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {
            validateNode(children[index], `node(${current.node.id}).children[${index}]`);
            stack.push({ node: children[index], parentId: current.node.id });
        }
    }
    return {
        version: payload.version,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        document: payload.document,
        nodes,
        parentIds,
    };
}

export function sharedValue(node: FigmaRestNode, key: string): string | undefined {
    const namespace = node.sharedPluginData?.[SHARED_NAMESPACE];
    if (namespace === undefined) return undefined;
    if (!isRecord(namespace)) throw new Error(`节点 ${node.id} 的 sharedPluginData namespace 无效。`);
    const value = namespace[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`节点 ${node.id} 的 sharedPluginData.${key} 必须是字符串。`);
    return value;
}

export function managedRootIds(index: IndexedFigmaDocument): string[] {
    return [...index.nodes.values()]
        .filter((node) => sharedValue(node, ROOT_HEADER_KEY) !== undefined)
        .map((node) => node.id)
        .sort();
}

export function selectManagedRoot(
    index: IndexedFigmaDocument,
    options: { descendantNodeId?: string; explicitRootId?: string } = {},
): FigmaRestNode {
    const roots = managedRootIds(index);
    if (roots.length === 0) throw new Error('当前 Figma 文件中没有 Round-trip managed root。');
    if (options.explicitRootId !== undefined) {
        if (!roots.includes(options.explicitRootId)) throw new Error('选择的节点不是 managed root。');
        return index.nodes.get(options.explicitRootId)!;
    }
    if (options.descendantNodeId !== undefined) {
        if (!index.nodes.has(options.descendantNodeId)) throw new Error('Figma 链接中的 node id 不存在。');
        const ancestors: string[] = [];
        let current: string | null | undefined = options.descendantNodeId;
        while (current !== null && current !== undefined) {
            if (roots.includes(current)) ancestors.push(current);
            current = index.parentIds.get(current);
        }
        if (ancestors.length !== 1) throw new Error('目标节点未唯一归属于一个 managed root。');
        return index.nodes.get(ancestors[0])!;
    }
    if (roots.length !== 1) throw new Error('文件包含多个 managed root，请明确选择一个。');
    return index.nodes.get(roots[0])!;
}

export async function fetchRoundtripFile(
    client: RoundtripFigmaClient,
    source: RoundtripSource,
): Promise<IndexedFigmaDocument> {
    return indexRoundtripFile(await client.getRoundtripFile(source.fileKey));
}
