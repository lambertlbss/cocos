import { readdir, readFile } from 'fs/promises';
import { basename, extname, join, relative, resolve } from 'path';
import type { FigmaNode, ImportDecision, PrefabAssetSpec } from '../types';
import { normalizeCocosUuid } from '../roundtrip/uuid';

interface PrefabCandidate { path: string; url: string; name: string; uuid?: string }
interface PrefabInfo {
    uuid?: string; url?: string; imported?: boolean; invalid?: boolean;
    importer?: string; type?: string; isDirectory?: boolean; redirect?: unknown;
}
export interface PrefabLookupOptions {
    projectPath: string;
    forbiddenUrls?: Iterable<string>;
    forbiddenUuids?: Iterable<string>;
    queryAsset: (url: string) => Promise<PrefabInfo | null>;
    signal?: AbortSignal;
}

const nameKey = (name: string): string => name.trim().replace(/\.prefab$/i, '')
    .normalize('NFKC').toLocaleLowerCase('en-US');
const urlKey = (url: string): string => url.normalize('NFKC').toLocaleLowerCase('en-US');

/** Only reachable bindings count: an outer replacement owns its entire subtree. */
export function collectPrefabReferences(
    roots: FigmaNode[],
    decision: (node: FigmaNode) => ImportDecision,
    importHiddenLayers = true,
): FigmaNode[] {
    const result: FigmaNode[] = [];
    const visit = (node: FigmaNode): void => {
        const action = decision(node).action;
        if (action === 'ignore' || (!importHiddenLayers && node.visible === false)) return;
        if (node.prefabName?.trim()) { result.push(node); return; }
        if (action === 'render' || action === 'transform' || decision(node).nineSlice) return;
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

/** Read-only preflight. No downloads, AssetDB writes, or scene changes happen here. */
export async function resolvePrefabReferences(
    nodes: FigmaNode[], options: PrefabLookupOptions,
): Promise<Map<string, PrefabAssetSpec>> {
    const result = new Map<string, PrefabAssetSpec>();
    if (!nodes.length) return result;
    const checkCancelled = (): void => { options.signal?.throwIfAborted(); };
    const assetsRoot = resolve(options.projectPath, 'assets');
    const candidates: PrefabCandidate[] = [];
    const scan = async (folder: string): Promise<void> => {
        checkCancelled();
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.')) await scan(path);
            else if (entry.isFile() && extname(entry.name).toLowerCase() === '.prefab') {
                candidates.push({ path, name: basename(entry.name, extname(entry.name)),
                    url: `db://assets/${relative(assetsRoot, path).replace(/\\/g, '/')}` });
            }
        }
    };
    await scan(assetsRoot);
    const forbiddenUrls = new Set([...options.forbiddenUrls ?? []].map(urlKey));
    const forbiddenUuids = new Set([...options.forbiddenUuids ?? []].map(normalizeCocosUuid));
    const byName = new Map<string, PrefabCandidate[]>();
    const byUuid = new Map<string, PrefabCandidate>();
    for (const candidate of candidates) {
        const key = nameKey(candidate.name);
        byName.set(key, [...byName.get(key) ?? [], candidate]);
        try {
            const meta = JSON.parse(await readFile(`${candidate.path}.meta`, 'utf8'));
            if (typeof meta.uuid === 'string') {
                candidate.uuid = normalizeCocosUuid(meta.uuid);
                byUuid.set(candidate.uuid!, candidate);
                if (forbiddenUrls.has(urlKey(candidate.url))) forbiddenUuids.add(candidate.uuid!);
            }
        } catch { /* Selected candidates still require a ready, verified AssetDB identity below. */ }
    }
    const dependencies = new Map<string, string[]>();
    const dependencyIds = async (candidate: PrefabCandidate): Promise<string[]> => {
        const known = dependencies.get(candidate.path);
        if (known) return known;
        let contents: unknown;
        try { contents = JSON.parse(await readFile(candidate.path, 'utf8')); }
        catch { throw new Error(`无法读取 Prefab 内容，请先修复资源：${candidate.url}`); }
        if (!Array.isArray(contents)) throw new Error(`Prefab 内容格式无效：${candidate.url}`);
        const ids = new Set<string>();
        // Script properties can legitimately hold their own Prefab asset for
        // later use. Only serialized nested Prefab links instantiate recursively.
        for (const value of contents) {
            if (!value || typeof value !== 'object') continue;
            const info = value as { __type__?: string; asset?: { __uuid__?: unknown } };
            if (info.__type__ === 'cc.PrefabInfo' && typeof info.asset?.__uuid__ === 'string') {
                ids.add(normalizeCocosUuid(info.asset.__uuid__));
            }
        }
        const result = [...ids].filter((id) => byUuid.has(id) || forbiddenUuids.has(id));
        dependencies.set(candidate.path, result);
        return result;
    };
    const verified = new Set<string>();
    const verifyDependencies = async (candidate: PrefabCandidate, visiting: Set<string>): Promise<void> => {
        checkCancelled();
        if (forbiddenUrls.has(urlKey(candidate.url)) || (candidate.uuid && forbiddenUuids.has(candidate.uuid))) {
            throw new Error(`Prefab“${candidate.name}”引用了本次输出目标，不能创建自身或循环嵌套：${candidate.url}`);
        }
        if (visiting.has(candidate.path)) throw new Error(`Prefab 存在循环引用：${candidate.url}`);
        if (verified.has(candidate.path)) return;
        visiting.add(candidate.path);
        for (const id of await dependencyIds(candidate)) {
            if (forbiddenUuids.has(id)) throw new Error(`Prefab“${candidate.name}”间接引用了本次输出目标，已停止导入。`);
            const dependency = byUuid.get(id);
            if (dependency) await verifyDependencies(dependency, visiting);
        }
        visiting.delete(candidate.path);
        verified.add(candidate.path);
    };
    const resolved = new Map<string, PrefabAssetSpec>();
    for (const node of nodes) {
        checkCancelled();
        const name = node.prefabName!;
        if (/[\\/\u0000-\u001f]/.test(name) || !nameKey(name)) {
            throw new Error(`节点“${node.name}”的 prefab 参数必须填写 Prefab 名称：${name}`);
        }
        const key = nameKey(name);
        const cached = resolved.get(key);
        if (cached) { result.set(node.id, cached); continue; }
        const named = byName.get(key) ?? [];
        const matches = named.filter((candidate) => !forbiddenUrls.has(urlKey(candidate.url))
            && !(candidate.uuid && forbiddenUuids.has(candidate.uuid)));
        if (!matches.length && named.length) {
            throw new Error(`Prefab“${name}”只匹配到本次输出目标，不能创建自身或循环嵌套。`);
        }
        if (!matches.length) throw new Error(`节点“${node.name}”指定的 Prefab“${name}”在项目 assets 中不存在。`);
        if (matches.length > 1) throw new Error(`Prefab“${name}”有多个同名资源，请使用唯一名称：${matches.map((item) => item.url).join('；')}`);
        const candidate = matches[0];
        const info = await options.queryAsset(candidate.url);
        if (!info?.uuid || info.invalid || info.imported !== true || info.isDirectory
            || info.importer !== 'prefab' || info.type !== 'cc.Prefab' || info.redirect
            || info.url !== candidate.url
            || (candidate.uuid && normalizeCocosUuid(info.uuid) !== candidate.uuid)) {
            throw new Error(`Prefab“${name}”尚未在 Cocos 中就绪或身份不一致，请等待资源导入完成：${candidate.url}`);
        }
        candidate.uuid = normalizeCocosUuid(info.uuid);
        byUuid.set(candidate.uuid, candidate);
        await verifyDependencies(candidate, new Set());
        const asset = { name: candidate.name, uuid: info.uuid, url: candidate.url };
        resolved.set(key, asset);
        result.set(node.id, asset);
    }
    return result;
}
