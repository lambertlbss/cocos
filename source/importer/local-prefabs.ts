import { readdir, readFile } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';
import type { FigmaNode, ImportDecision, PrefabAssetSpec } from '../types';

const nameKey = (name: string) => name.trim().normalize('NFKC').replace(/\.prefab$/i, '');
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100);
export const samePrefabSize = (width: number, height: number, size: { width: number; height: number }) =>
    [width, height, size.width, size.height].every((value) => Number.isFinite(value) && value > 0)
    && rounded(width) === rounded(size.width) && rounded(height) === rounded(size.height);

interface Entry { path: string; url: string; uuid: string; name: string }
interface Parsed { width: number; height: number; dependencies: string[] }

/** Read-only project asset index. Symlinks and non-assets folders are not followed. */
export class LocalPrefabLibrary {
    private entries: Entry[] = [];
    private byUuid = new Map<string, Entry>();
    private parsed = new Map<string, Promise<Parsed | null>>();
    constructor(private projectPath: string, private decodeUuid: (uuid: string) => string = (uuid) => uuid) {}

    async initialize(): Promise<void> {
        const root = resolve(this.projectPath, 'assets');
        const visit = async (folder: string): Promise<void> => {
            for (const entry of await readdir(folder, { withFileTypes: true })) {
                const path = join(folder, entry.name);
                if (entry.isDirectory()) { await visit(path); continue; }
                if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.prefab')) continue;
                try {
                    const meta = JSON.parse(await readFile(`${path}.meta`, 'utf8'));
                    if (meta.importer !== 'prefab' || typeof meta.uuid !== 'string') continue;
                    const item = { path, uuid: this.decodeUuid(meta.uuid), name: nameKey(basename(path)),
                        url: `db://assets/${relative(root, path).replace(/\\/g, '/')}` };
                    this.entries.push(item);
                    this.byUuid.set(item.uuid, item);
                } catch { /* Unregistered/malformed assets cannot be referenced. */ }
            }
        };
        await visit(root);
    }

    private parse(entry: Entry): Promise<Parsed | null> {
        let task = this.parsed.get(entry.uuid);
        if (!task) {
            task = (async () => {
                try {
                    const objects = JSON.parse(await readFile(entry.path, 'utf8'));
                    if (!Array.isArray(objects) || objects[0]?.__type__ !== 'cc.Prefab') return null;
                    const root = objects[objects[0].data?.__id__];
                    if (root?.__type__ !== 'cc.Node') return null;
                    const transform = root?._components?.map((ref: any) => objects[ref.__id__])
                        .find((item: any) => item?.__type__ === 'cc.UITransform');
                    const rootCompatible = transform && root._lscale?.x === 1 && root._lscale?.y === 1
                        && !root._lrot?.x && !root._lrot?.y && !root._lrot?.z;
                    const ownInfo = objects[root._prefab?.__id__];
                    const dependencies = new Set<string>();
                    const scan = (value: any): void => {
                        if (!value || typeof value !== 'object') return;
                        if (typeof value.__uuid__ === 'string') dependencies.add(this.decodeUuid(value.__uuid__));
                        for (const [key, child] of Object.entries(value)) {
                            // Only the source root's ownership link is not a
                            // dependency. A real nested self-reference is unsafe.
                            if (value === ownInfo && key === 'asset'
                                && typeof (child as any)?.__uuid__ === 'string'
                                && this.decodeUuid((child as any).__uuid__) === entry.uuid) continue;
                            scan(child);
                        }
                    };
                    scan(objects);
                    return { width: rootCompatible ? transform._contentSize.width : NaN,
                        height: rootCompatible ? transform._contentSize.height : NaN,
                        dependencies: [...dependencies] };
                } catch { return null; }
            })();
            this.parsed.set(entry.uuid, task);
        }
        return task;
    }

    private async safeDependency(entry: Entry, excluded: Set<string>, visiting: Set<string>): Promise<boolean> {
        if (excluded.has(entry.uuid) || excluded.has(entry.url) || visiting.has(entry.uuid)) return false;
        const data = await this.parse(entry);
        if (!data) return false;
        const next = new Set(visiting).add(entry.uuid);
        for (const uuid of data.dependencies) {
            if (excluded.has(uuid)) return false;
            const dependency = this.byUuid.get(uuid);
            if (dependency && !await this.safeDependency(dependency, excluded, next)) return false;
        }
        return true;
    }

    async find(name: string, width: number, height: number, excluded: Set<string>): Promise<PrefabAssetSpec | null> {
        const matches: PrefabAssetSpec[] = [];
        for (const entry of this.entries.filter((item) => item.name === nameKey(name))) {
            const data = await this.parse(entry);
            if (!data || !samePrefabSize(width, height, data)) continue;
            if (!await this.safeDependency(entry, excluded, new Set())) {
                console.warn(`[Figma Importer Prefab] 跳过自身、循环引用或不兼容资源：${entry.url}`);
                continue;
            }
            matches.push({ uuid: entry.uuid, url: entry.url, width: data.width, height: data.height });
        }
        if (matches.length > 1) {
            throw new Error(`节点“${name}”匹配到多个同名同尺寸 Prefab，请消除歧义后重试：${matches.map((item) => item.url).join('；')}`);
        }
        return matches[0] ?? null;
    }
}

/** Top-down cut before asset collection. Referenced descendants are never visited. */
export async function matchLocalPrefabs(
    roots: FigmaNode[], decisions: Map<string, ImportDecision>, library: Pick<LocalPrefabLibrary, 'find'>,
    scale: number, excluded: Set<string>,
): Promise<void> {
    const visit = async (node: FigmaNode): Promise<boolean> => {
        const decision = decisions.get(node.id);
        if (!decision || decision.action === 'ignore' || decision.action === 'transform') return false;
        const size = node.size ?? node.absoluteBoundingBox;
        const match = size && await library.find(node.name, size.width * scale, size.height * scale, excluded);
        if (match) {
            decisions.set(node.id, { ...decision, action: 'generate', kind: 'node', nineSlice: false, explicit: true, prefab: match });
            console.log('[Figma Importer Prefab 复用]', JSON.stringify({ nodeId: node.id, nodeName: node.name, ...match }));
            return true;
        }
        if (decision.explicit && (decision.action === 'render' || decision.nineSlice)) return false;
        let containsReference = false;
        for (const child of node.children) containsReference = await visit(child) || containsReference;
        if (containsReference) {
            // Preserve the ancestor hierarchy: automatic PNG flattening must not
            // swallow a reference (or download the same content again).
            decisions.set(node.id, { ...decision, action: 'generate', nineSlice: false, explicit: true });
        }
        return containsReference;
    };
    for (const root of roots) await visit(root);
}
