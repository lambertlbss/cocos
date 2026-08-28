import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import packageJSON from '../package.json';
import { FigmaClient, CancelledError, clampImageScale } from './figma/client';
import {
    hasHiddenDescendant,
    inferAction,
    inferCocosLayoutMode,
    inferKind,
    isPatchCandidate,
    isVectorNode,
    nativeTiledPaintSource,
    plainImageSourceRef,
    type TiledPaintSource,
} from './figma/analyzer';
import { parseDocument } from './figma/parser';
import {
    annotateTreeWithImportPlan,
    compileImportPlan,
} from './figma/import-planner';
import { analyzeSliceGrid } from './figma/slicing';
import { parseFigmaSource } from './figma/url';
import {
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from './import-actions';
import {
    AssetWriter,
    RASTER_IMAGE_EXTENSIONS,
    detectImageExtension,
    resolveAssetUuid,
    sanitizeAssetName,
    type RasterImageExtension,
} from './importer/assets';
import { LocalAssetCache, type CacheEntryKey } from './importer/cache';
import type { FontAssetOption } from './importer/fonts';
import { LocalResourceLibrary } from './importer/local-resources';
import { gradientPng } from './importer/svg';
import {
    collectSceneSpecFigmaIds,
    createMinimalPrefabJson,
    createPrefabSyncRecord,
    figmaFrameSourceHash,
    mergePrefabSyncRecord,
    planPrefabRecoveryTarget,
    prefabJsonContainsSyncRecord,
    readPrefabSyncRecord,
    recordPrefabSyncCapture,
    resolveExistingNodeFileIds,
    type PrefabSyncRecord,
} from './importer/prefab-sync';
import { TokenVault } from './security/token-vault';
import { RoundtripService } from './roundtrip/service';
import { recoverInterruptedTransactions } from './roundtrip/recovery';
import { editorReimporter } from './roundtrip/transaction';
import {
    DEFAULT_SETTINGS,
    type DocumentSession,
    type FigmaNode,
    type ImportAction,
    type ImportDecision,
    type ImportOverride,
    type ImportRequest,
    type ImportSettings,
    type NodeKind,
    type NodeImportPlan,
    type PrefabEditingState,
    type PrefabSceneSyncCapture,
    type PrefabSceneSyncContext,
    type ProgressEvent,
    type Rect,
    type SceneNodeSpec,
    type SpriteAssetSpec,
    type TreeNodeDto,
} from './types';
import { sanitizeNodeName } from './node-name';

const vault = new TokenVault(packageJSON.name);
let activeDocument: DocumentSession | null = null;
let activeController: AbortController | null = null;
let roundtripController: AbortController | null = null;
let settingsCache: ImportSettings | null = null;
let roundtripRecoveryBlocker: string | null = null;

type Decision = ImportDecision;

interface TiledAssetRequest {
    node: FigmaNode;
    source: TiledPaintSource;
}

interface RawImageAssetRequest {
    node: FigmaNode;
    imageRef: string;
}

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
    prefabUrl?: string;
    prefabSync?: PrefabSceneSyncCapture;
    warnings?: string[];
}

interface AssetBuildResult {
    assets: Map<string, SpriteAssetSpec>;
    warnings: string[];
}

interface PrefabAssetInfo {
    uuid: string;
    url: string;
    importer: string;
    type: string;
    imported: boolean;
    invalid: boolean;
    isDirectory?: boolean;
    readonly?: boolean;
    redirect?: unknown;
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.fnt', '.woff', '.woff2']);
const NODE_KINDS = new Set<NodeKind>([
    'auto',
    'node',
    'sprite',
    'label',
    'richText',
    'button',
    'scrollView',
    'layout',
]);

async function listFontAssets(): Promise<FontAssetOption[]> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const fonts: FontAssetOption[] = [];
    async function visit(folder: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp') {
                continue;
            }
            const filePath = join(folder, entry.name);
            if (entry.isDirectory()) {
                await visit(filePath);
                continue;
            }
            if (!FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
                continue;
            }
            const path = relative(assetsRoot, filePath).replace(/\\/g, '/');
            fonts.push({
                name: basename(entry.name, extname(entry.name)),
                url: `db://assets/${path}`,
                relativePath: path,
            });
        }
    }
    await visit(assetsRoot);
    return fonts.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function emitProgress(progress: ProgressEvent): void {
    Editor.Message.send(packageJSON.name, 'progress', progress);
}

function defaultCacheFolder(): string {
    return join(Editor.Project.tmpDir, packageJSON.name, 'asset-cache');
}

function safeSettings(value: unknown): ImportSettings {
    const input = value && typeof value === 'object'
        ? value as Partial<ImportSettings>
        : {};
    const scale = typeof input.scale === 'number' && Number.isFinite(input.scale)
        ? Math.max(0.25, Math.min(4, input.scale))
        : DEFAULT_SETTINGS.scale;
    const fontMap = input.fontMap && typeof input.fontMap === 'object'
        ? Object.fromEntries(Object.entries(input.fontMap)
            .filter(([key, item]) => key.trim() && typeof item === 'string')
            .map(([key, item]) => [key.trim(), item.trim()]))
        : {};
    const rawLocalFolders = Array.isArray(input.localResourceFolders)
        ? input.localResourceFolders
        : typeof input.localResourceFolder === 'string'
            ? [input.localResourceFolder]
            : [];
    const localResourceFolders = rawLocalFolders
        .filter((folder): folder is string => typeof folder === 'string')
        .map((folder) => folder.trim())
        .filter(Boolean)
        .filter((folder, index, folders) => folders.indexOf(folder) === index)
        .slice(0, 3);
    return {
        sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '',
        assetFolder: typeof input.assetFolder === 'string' && input.assetFolder.trim()
            ? input.assetFolder.trim()
            : DEFAULT_SETTINGS.assetFolder,
        prefabFolder: typeof input.prefabFolder === 'string' && input.prefabFolder.trim()
            ? input.prefabFolder.trim()
            : DEFAULT_SETTINGS.prefabFolder,
        localResourceFolders,
        localResourceFolder: localResourceFolders[0] ?? '',
        scale,
        updateExisting: input.updateExisting !== false,
        refreshAssets: input.refreshAssets === true,
        autoSave: input.autoSave === true,
        fontMap,
    };
}

async function getSettings(): Promise<ImportSettings> {
    if (settingsCache) {
        return settingsCache;
    }
    const saved = await Editor.Profile.getProject(packageJSON.name, 'settings', 'project');
    settingsCache = safeSettings(saved);
    return settingsCache;
}

async function saveSettings(value: unknown): Promise<ImportSettings> {
    settingsCache = safeSettings(value);
    await Editor.Profile.setProject(packageJSON.name, 'settings', settingsCache, 'project');
    return settingsCache;
}

async function client(signal: AbortSignal | undefined = activeController?.signal): Promise<FigmaClient> {
    return new FigmaClient(await vault.get(), signal);
}

async function roundtripService(signal?: AbortSignal): Promise<RoundtripService> {
    const creatorVersion = (Editor.App as unknown as { version?: string }).version ?? 'unknown';
    return new RoundtripService({
        client: await client(signal),
        projectRoot: Editor.Project.path,
        creatorVersion,
    });
}

function beginRoundtripOperation(): AbortController {
    roundtripController?.abort();
    const controller = new AbortController();
    roundtripController = controller;
    return controller;
}

function finishRoundtripOperation(controller: AbortController): void {
    if (roundtripController === controller) roundtripController = null;
}

function beginOperation(): void {
    activeController?.abort();
    activeController = new AbortController();
}

function finishOperation(): void {
    activeController = null;
}

function relativeAssetFolder(selectedPath: string): string {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const selected = resolve(selectedPath);
    const folder = relative(assetsRoot, selected);
    if (!folder || folder === '.' || folder.startsWith('..') || isAbsolute(folder)) {
        throw new Error('资源输出目录必须是项目 assets 下的子文件夹。');
    }
    return folder.replace(/\\/g, '/');
}

function assetDatabaseUrl(filePath: string): string | null {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const selected = resolve(filePath);
    const path = relative(assetsRoot, selected);
    const outside = path === '..'
        || path.startsWith('../')
        || path.startsWith('..\\')
        || isAbsolute(path);
    if (!path || path === '.' || outside) {
        return null;
    }
    return `db://assets/${path.replace(/\\/g, '/')}`;
}

async function pickAssetFolder(current: unknown): Promise<{
    folder: string;
    absolutePath: string;
} | null> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? resolve(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = existsSync(preferredPath) ? preferredPath : assetsRoot;
    const result = await Editor.Dialog.select({
        title: '选择 Figma 导入资源目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    return {
        folder: relativeAssetFolder(selected),
        absolutePath: resolve(selected),
    };
}

async function pickPrefabFolder(current: unknown): Promise<{
    folder: string;
    absolutePath: string;
} | null> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? resolve(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = existsSync(preferredPath) ? preferredPath : assetsRoot;
    const result = await Editor.Dialog.select({
        title: '选择预制体输出目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    return {
        folder: relativeAssetFolder(selected),
        absolutePath: resolve(selected),
    };
}

async function pickLocalResourceFolder(current: unknown, _index = 0): Promise<{
    folder: string;
} | null> {
    const currentFolder = typeof current === 'string' ? current.trim() : '';
    const initialPath = currentFolder && isAbsolute(currentFolder)
        ? currentFolder
        : resolve(Editor.Project.path, 'assets');
    const result = await Editor.Dialog.select({
        title: '选择本地同名资源目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    const library = new LocalResourceLibrary(selected);
    return { folder: library.root };
}

function unionFrame(nodes: FigmaNode[]): Rect {
    const frames = nodes.map(nodeFrame).filter((value): value is Rect => Boolean(value));
    if (!frames.length) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    const x = Math.min(...frames.map((frame) => frame.x));
    const y = Math.min(...frames.map((frame) => frame.y));
    const right = Math.max(...frames.map((frame) => frame.x + frame.width));
    const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
    return { x, y, width: right - x, height: bottom - y };
}

function nodeFrame(node: FigmaNode): Rect {
    if (node.absoluteBoundingBox) {
        return node.absoluteBoundingBox;
    }
    if (node.children.length) {
        return unionFrame(node.children);
    }
    return { x: 0, y: 0, width: 0, height: 0 };
}

const RENDER_OVERFLOW_EPSILON = 0.5;

/**
 * Only expand rasters whose visible pixels escape the geometric frame. A
 * render frame contained inside the geometry often represents intentional
 * transparent padding and must keep the legacy fixed-canvas path.
 */
export function overflowingRenderFrame(node: FigmaNode): Rect | undefined {
    const geometry = node.absoluteBoundingBox;
    const render = node.absoluteRenderBounds;
    if (!geometry || !render || render.width <= 0 || render.height <= 0) {
        return undefined;
    }
    const geometryRight = geometry.x + geometry.width;
    const geometryBottom = geometry.y + geometry.height;
    const renderRight = render.x + render.width;
    const renderBottom = render.y + render.height;
    return render.x < geometry.x - RENDER_OVERFLOW_EPSILON
        || render.y < geometry.y - RENDER_OVERFLOW_EPSILON
        || renderRight > geometryRight + RENDER_OVERFLOW_EPSILON
        || renderBottom > geometryBottom + RENDER_OVERFLOW_EPSILON
        ? render
        : undefined;
}

function cornerRadii(node: FigmaNode): [number, number, number, number] {
    if (node.rectangleCornerRadii?.length === 4) {
        return node.rectangleCornerRadii as [number, number, number, number];
    }
    const radius = node.cornerRadius ?? 0;
    return [radius, radius, radius, radius];
}

function defaultDecision(node: FigmaNode): Decision {
    return {
        action: inferAction(node),
        kind: inferKind(node),
        nineSlice: isPatchCandidate(node),
        explicit: false,
    };
}

function decisionForNode(node: FigmaNode, decisions: Map<string, Decision>): Decision {
    const decision = decisions.get(node.id) ?? defaultDecision(node);
    if (node.type === 'TEXT' && decision.action !== 'ignore') {
        return { ...decision, action: 'generate', nineSlice: false };
    }
    if (isVectorNode(node) && decision.action !== 'ignore') {
        return { ...decision, action: 'render', nineSlice: false };
    }
    return decision;
}

export function decisionMap(overrides: ImportOverride[], tree: TreeNodeDto[]): Map<string, Decision> {
    const decisions = new Map<string, Decision>();
    const addDefaults = (nodes: TreeNodeDto[]) => {
        for (const node of nodes) {
            decisions.set(node.id, {
                action: normalizeImportAction(node.action),
                kind: node.kind,
                nineSlice: node.patchCandidate,
                explicit: false,
            });
            addDefaults(node.children);
        }
    };
    addDefaults(tree);
    for (const item of overrides ?? []) {
        const name = sanitizeNodeName(item.name);
        decisions.set(item.id, {
            action: normalizeImportAction(item.action),
            kind: NODE_KINDS.has(item.kind) ? item.kind : 'auto',
            nineSlice: item.nineSlice,
            explicit: item.explicit === true,
            ...(name ? { name } : {}),
        });
    }
    return decisions;
}

export function subtreeHasExplicitOverride(
    node: FigmaNode,
    decisions: ReadonlyMap<string, ImportDecision>,
    includeNodeName = true,
): boolean {
    const decision = decisions.get(node.id);
    return decision?.explicit === true
        || (includeNodeName && Boolean(decision?.name))
        || node.children.some((child) => subtreeHasExplicitOverride(child, decisions));
}

type StoredNodeOverrides = Record<string, Record<string, ImportOverride>>;

async function getStoredNodeOverrides(): Promise<StoredNodeOverrides> {
    const saved = await Editor.Profile.getProject(packageJSON.name, 'nodeOverrides', 'project');
    return saved && typeof saved === 'object' ? saved as StoredNodeOverrides : {};
}

function safeNodeOverride(value: unknown, fallbackId = ''): ImportOverride | null {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<ImportOverride>;
    const id = typeof item.id === 'string' && item.id ? item.id : fallbackId;
    if (!id) return null;
    const kind = typeof item.kind === 'string' && NODE_KINDS.has(item.kind as NodeKind)
        ? item.kind as NodeKind
        : 'auto';
    const explicit = item.explicit === false ? false : true;
    const name = sanitizeNodeName(item.name);
    if (!explicit && !name) return null;
    return {
        id,
        action: normalizeImportAction(item.action),
        kind,
        nineSlice: item.nineSlice === true,
        explicit,
        ...(name ? { name } : {}),
    };
}

async function nodeOverridesFor(fileKey: string): Promise<ImportOverride[]> {
    const stored = (await getStoredNodeOverrides())[fileKey] ?? {};
    const result: ImportOverride[] = [];
    for (const [id, value] of Object.entries(stored)) {
        const safe = safeNodeOverride(value, id);
        if (safe) result.push(safe);
    }
    return result;
}

async function saveNodeOverrides(
    fileKey: unknown,
    values: unknown,
    scopeValues: unknown,
): Promise<ImportOverride[]> {
    if (typeof fileKey !== 'string' || !fileKey.trim()) {
        throw new Error('无法保存节点策略：缺少 Figma fileKey。');
    }
    const items = Array.isArray(values) ? values : [];
    const safeItems = items
        .map((item) => safeNodeOverride(item))
        .filter((item): item is ImportOverride => Boolean(item));
    const scopeIds = new Set(
        (Array.isArray(scopeValues) ? scopeValues : safeItems.map((item) => item.id))
            .filter((id): id is string => typeof id === 'string' && Boolean(id)),
    );
    if (!scopeIds.size) {
        throw new Error('无法保存节点策略：缺少当前导入范围。');
    }
    const scopedItems = safeItems.filter((item) => scopeIds.has(item.id));
    const stored = await getStoredNodeOverrides();
    const current = { ...(stored[fileKey] ?? {}) };
    for (const id of scopeIds) {
        delete current[id];
    }
    for (const item of scopedItems) {
        current[item.id] = item;
    }
    if (Object.keys(current).length) {
        stored[fileKey] = current;
    } else {
        delete stored[fileKey];
    }
    await Editor.Profile.setProject(packageJSON.name, 'nodeOverrides', stored, 'project');
    return scopedItems;
}

function annotateDocumentPlan(session: DocumentSession): DocumentSession {
    const defaults = decisionMap([], session.tree);
    session.tree = annotateTreeWithImportPlan(
        session.tree,
        compileImportPlan(session.roots, defaults),
    );
    return session;
}

function collectAssetRequests(
    roots: FigmaNode[],
    decisions: Map<string, Decision>,
): { png: FigmaNode[]; tiled: TiledAssetRequest[]; rawImages: RawImageAssetRequest[]; gradients: FigmaNode[] } {
    const png: FigmaNode[] = [];
    const tiled: TiledAssetRequest[] = [];
    const rawImages: RawImageAssetRequest[] = [];
    const gradients: FigmaNode[] = [];
    const visit = (node: FigmaNode, ancestorsVisible: boolean) => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') {
            return;
        }
        const effectivelyVisible = ancestorsVisible && node.visible !== false && node.opacity > 0;
        if (node.type === 'TEXT') {
            node.children.forEach((child) => visit(child, effectivelyVisible));
            return;
        }
        if (decision.nineSlice) {
            png.push(node);
            return;
        }
        if (decision.action === 'render') {
            const source = nativeTiledPaintSource(node);
            if (source) {
                tiled.push({ node, source });
            } else {
                const imageRef = effectivelyVisible ? undefined : plainImageSourceRef(node);
                if (imageRef) {
                    rawImages.push({ node, imageRef });
                } else {
                    png.push(node);
                }
            }
            return;
        }
        if (decision.action === 'generate') {
            const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
            if (fill) {
                if (node.children.length) {
                    gradients.push(node);
                } else {
                    png.push(node);
                }
            }
        }
        node.children.forEach((child) => visit(child, effectivelyVisible));
    };
    roots.forEach((root) => visit(root, true));
    return { png, tiled, rawImages, gradients };
}

async function buildAssets(
    session: DocumentSession,
    decisions: Map<string, Decision>,
    importSettings: ImportSettings,
): Promise<AssetBuildResult> {
    const writer = new AssetWriter(importSettings.assetFolder);
    await writer.initialize();
    const cache = new LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    const promoteLocalParents = async (node: FigmaNode): Promise<void> => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') {
            return;
        }
        if (node.children.length
            && node.type !== 'TEXT'
            && !decision.nineSlice
            // Renaming this container does not change resource matching; only
            // a strategy override on itself or any override below it blocks
            // promotion because descendants would otherwise disappear.
            && !subtreeHasExplicitOverride(node, decisions, false)
            // A local parent resource cannot represent independently inactive
            // descendants. Keep the hierarchy whenever such a boundary exists.
            && !hasHiddenDescendant(node)) {
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, 'png');
                if (localMatch) {
                    break;
                }
            }
            if (localMatch) {
                decisions.set(node.id, { ...decision, action: 'render', nineSlice: false });
                return;
            }
        }
        await Promise.all(node.children.map(promoteLocalParents));
    };
    await Promise.all(session.roots.map(promoteLocalParents));
    const requests = collectAssetRequests(session.roots, decisions);
    const assets = new Map<string, SpriteAssetSpec>();
    const warnings = new Set<string>();
    const total = requests.png.length + requests.tiled.length
        + requests.rawImages.length + requests.gradients.length;
    let completed = 0;
    let apiPromise: Promise<FigmaClient> | null = null;

    const getApi = () => {
        apiPromise ??= client();
        return apiPromise;
    };

    const completeAsset = (
        node: FigmaNode,
        asset: SpriteAssetSpec,
        source: 'existing' | 'local' | 'cache' | 'figma' | 'generated' = 'figma',
    ) => {
        assets.set(node.id, asset);
        completed += 1;
        const verb = source === 'local'
            ? '复用本地资源'
            : source === 'existing'
                ? '复用已有资源'
                : source === 'generated'
                    ? '生成渐变'
                : '导入资源';
        emitProgress({
            phase: 'assets',
            value: total ? completed / total : 1,
            message: `${verb} ${completed}/${total} · ${node.name}`,
        });
    };

    const processTiled = async (items: TiledAssetRequest[]) => {
        if (!items.length) {
            return;
        }
        interface TileGroup {
            node: FigmaNode;
            nodes: FigmaNode[];
            source: TiledPaintSource;
            sourceKey: string;
        }
        interface PendingTile extends TileGroup {
            contents: Buffer | null;
            extension?: RasterImageExtension;
            sourceType: 'cache' | 'figma';
        }
        const requestedScale = (source: TiledPaintSource) => importSettings.scale * source.scale;
        const renderScale = (source: TiledPaintSource) => source.kind === 'source-node'
            ? clampImageScale(requestedScale(source))
            : 1;
        const tileAsset = (asset: SpriteAssetSpec, source: TiledPaintSource): SpriteAssetSpec => ({
            ...asset,
            tiled: true,
            tileScale: requestedScale(source) / renderScale(source),
        });
        const groups = new Map<string, TileGroup>();
        for (const { node, source } of items) {
            const sourceKey = JSON.stringify({
                fileKey: session.fileKey,
                kind: source.kind,
                id: source.id,
                paintScale: source.scale,
                renderScale: renderScale(source),
            });
            const key = writer.buildTiledUrl(node.name, sourceKey, 'png')
                .normalize('NFKC')
                .toLocaleLowerCase('en-US');
            const group = groups.get(key) ?? { node, nodes: [], source, sourceKey };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const completeGroup = (
            groupedNodes: FigmaNode[],
            asset: SpriteAssetSpec,
            source: 'existing' | 'cache' | 'figma',
        ) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        const pending: PendingTile[] = [];
        for (const group of groups.values()) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            let existingAsset: SpriteAssetSpec | null = null;
            if (!importSettings.refreshAssets) {
                for (const extension of RASTER_IMAGE_EXTENSIONS) {
                    existingAsset = await writer.existing(
                        writer.buildTiledUrl(group.node.name, group.sourceKey, extension),
                        true,
                    );
                    if (existingAsset) {
                        break;
                    }
                }
            }
            if (existingAsset) {
                completeGroup(group.nodes, tileAsset(existingAsset, group.source), 'existing');
                continue;
            }
            let contents: Buffer | null = null;
            let cachedExtension: RasterImageExtension | undefined;
            if (!importSettings.refreshAssets) {
                const extensions: readonly RasterImageExtension[] = group.source.kind === 'source-node'
                    ? ['png']
                    : RASTER_IMAGE_EXTENSIONS;
                for (const extension of extensions) {
                    const cached = await cache.read({
                        fileKey: session.fileKey,
                        nodeId: `tile:${group.sourceKey}`,
                        format: extension,
                        scale: renderScale(group.source),
                    });
                    if (cached) {
                        contents = cached;
                        cachedExtension = extension;
                        break;
                    }
                }
            }
            pending.push({
                ...group,
                contents,
                extension: cachedExtension,
                sourceType: contents ? 'cache' : 'figma',
            });
        }

        const remoteItems = pending.filter((item) => !item.contents);
        const patternUrls = new Map<string, string | null>();
        const patternsByScale = new Map<number, Set<string>>();
        for (const item of remoteItems) {
            if (item.source.kind !== 'source-node') {
                continue;
            }
            const scale = renderScale(item.source);
            const ids = patternsByScale.get(scale) ?? new Set<string>();
            ids.add(item.source.id);
            patternsByScale.set(scale, ids);
        }
        for (const [scale, ids] of patternsByScale) {
            const urls = await (await getApi()).getImageUrls(
                session.fileKey,
                Array.from(ids),
                'png',
                scale,
            );
            for (const [id, url] of Object.entries(urls)) {
                patternUrls.set(`${id}:scale:${scale}`, url);
            }
        }
        const needsImageFills = remoteItems.some((item) => item.source.kind === 'image-ref');
        const imageFillUrls = needsImageFills
            ? await (await getApi()).getImageFillUrls(session.fileKey)
            : {};
        const downloads = new Map<string, Promise<Buffer>>();
        const download = (url: string) => {
            let task = downloads.get(url);
            if (!task) {
                task = getApi().then((api) => api.download(url));
                downloads.set(url, task);
            }
            return task;
        };
        for (const item of pending) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            let contents = item.contents;
            let extension = item.extension;
            if (!contents) {
                const remoteUrl = item.source.kind === 'source-node'
                    ? patternUrls.get(
                        `${item.source.id}:scale:${renderScale(item.source)}`,
                    )
                    : imageFillUrls[item.source.id];
                if (!remoteUrl) {
                    const label = item.source.kind === 'source-node'
                        ? `PATTERN 源节点 ${item.source.id}`
                        : `IMAGE 填充 ${item.source.id}`;
                    throw new Error(`Figma 未能提供${label}：${item.node.name}`);
                }
                contents = await download(remoteUrl);
                extension = item.source.kind === 'source-node'
                    ? 'png'
                    : detectImageExtension(contents);
                await cache.write({
                    fileKey: session.fileKey,
                    nodeId: `tile:${item.sourceKey}`,
                    format: extension,
                    scale: renderScale(item.source),
                }, contents);
            }
            if (!extension) {
                extension = detectImageExtension(contents);
            }
            const url = writer.buildTiledUrl(item.node.name, item.sourceKey, extension);
            completeGroup(
                item.nodes,
                tileAsset(
                    await writer.write(url, contents, undefined, true),
                    item.source,
                ),
                item.sourceType,
            );
        }
    };

    const processRemote = async (nodes: FigmaNode[]) => {
        if (!nodes.length) {
            return;
        }
        const format = 'png' as const;
        const groups = new Map<string, { url: string; nodes: FigmaNode[] }>();
        for (const node of nodes) {
            const url = writer.buildUrl(
                node.name,
                `${session.fileKey}:${node.id}`,
                format,
                importSettings.scale,
            );
            const key = url.normalize('NFKC').toLocaleLowerCase('en-US');
            const group = groups.get(key) ?? { url, nodes: [] };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const pending: Array<{
            node: FigmaNode;
            nodes: FigmaNode[];
            url: string;
            borders?: { left: number; right: number; top: number; bottom: number };
            renderFrame?: Rect;
            key: CacheEntryKey;
            contents: Buffer | null;
            source: 'local' | 'cache' | 'figma';
        }> = [];
        const completeGroup = (
            groupedNodes: FigmaNode[],
            asset: SpriteAssetSpec,
            source: 'existing' | 'local' | 'cache' | 'figma',
        ) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        for (const { url, nodes: groupedNodes } of groups.values()) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            const node = groupedNodes[0];
            const decision = decisions.get(node.id) ?? defaultDecision(node);
            const sliceAnalysis = decision.nineSlice && format === 'png'
                ? analyzeSliceGrid(node, importSettings.scale)
                : null;
            if (decision.nineSlice && !sliceAnalysis) {
                warnings.add(`三/九宫节点“${node.name}”无法计算连续切片边界，已临时作为 PNG 整层导入`);
            }
            const borders = sliceAnalysis?.borders;
            // Sliced assets retain their exact geometric canvas because their
            // border metadata is expressed in that coordinate space.
            const renderFrame = borders ? undefined : overflowingRenderFrame(node);
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, format);
                if (localMatch) {
                    break;
                }
            }
            const localUrl = localMatch && !borders
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                completeGroup(groupedNodes, localAsset, 'local');
                continue;
            }
            const existing = !importSettings.refreshAssets ? await writer.existing(url) : null;
            if (!localMatch && existing && !borders && !renderFrame) {
                completeGroup(groupedNodes, existing, 'existing');
                continue;
            }
            const key: CacheEntryKey = {
                fileKey: session.fileKey,
                nodeId: node.id,
                format,
                scale: importSettings.scale,
                variant: renderFrame ? 'visual-overflow-v1' : undefined,
            };
            const cached = localMatch || importSettings.refreshAssets
                ? null
                : await cache.read(key);
            pending.push({
                node,
                nodes: groupedNodes,
                url,
                borders,
                renderFrame: localMatch ? undefined : renderFrame,
                key,
                contents: localMatch?.contents ?? cached,
                source: localMatch ? 'local' : cached ? 'cache' : 'figma',
            });
        }
        const urls: Record<string, string | null> = {};
        const remoteItems = pending.filter((item) => !item.contents);
        for (const useAbsoluteBounds of [true, false]) {
            const batch = remoteItems.filter((item) => (
                useAbsoluteBounds ? !item.renderFrame : Boolean(item.renderFrame)
            ));
            if (!batch.length) {
                continue;
            }
            Object.assign(urls, await (await getApi()).getImageUrls(
                session.fileKey,
                batch.map((item) => item.node.id),
                format,
                importSettings.scale,
                useAbsoluteBounds,
            ));
        }
        for (const item of pending) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            let contents = item.contents;
            if (!contents) {
                const remoteUrl = urls[item.node.id];
                if (!remoteUrl) {
                    throw new Error(`Figma 未能渲染节点：${item.node.name}`);
                }
                contents = await (await getApi()).download(remoteUrl);
                await cache.write(item.key, contents);
            }
            const asset = await writer.write(item.url, contents, item.borders);
            if (asset.sliceFallback) {
                warnings.add(`三/九宫节点“${item.node.name}”切片设置失败，已临时作为 PNG 整层导入：${asset.sliceFallback}`);
            }
            for (const groupedNode of item.nodes) {
                completeAsset(
                    groupedNode,
                    item.renderFrame
                        ? { ...asset, renderFrame: overflowingRenderFrame(groupedNode) ?? item.renderFrame }
                        : asset,
                    item.source,
                );
            }
        }
    };

    const processRawImages = async (items: RawImageAssetRequest[]) => {
        if (!items.length) return;
        const groups = new Map<string, { node: FigmaNode; nodes: FigmaNode[]; imageRef: string }>();
        for (const item of items) {
            const key = `${item.node.name.normalize('NFKC').toLocaleLowerCase('en-US')}\0${item.imageRef}`;
            const group = groups.get(key) ?? { node: item.node, nodes: [], imageRef: item.imageRef };
            group.nodes.push(item.node);
            groups.set(key, group);
        }

        let imageFillUrlsPromise: Promise<Record<string, string | null>> | undefined;
        const downloads = new Map<string, Promise<Buffer>>();
        for (const group of groups.values()) {
            if (activeController?.signal.aborted) throw new CancelledError();
            let contents: Buffer | null = null;
            let extension: RasterImageExtension | undefined;
            let source: 'cache' | 'figma' = 'cache';
            if (!importSettings.refreshAssets) {
                for (const candidate of RASTER_IMAGE_EXTENSIONS) {
                    contents = await cache.read({
                        fileKey: session.fileKey,
                        nodeId: `image-ref:${group.imageRef}`,
                        format: candidate,
                        scale: 1,
                        variant: 'source-image-v1',
                    });
                    if (contents) {
                        extension = candidate;
                        break;
                    }
                }
            }
            if (!contents) {
                if (!imageFillUrlsPromise) {
                    imageFillUrlsPromise = getApi().then((api) => api.getImageFillUrls(session.fileKey));
                }
                const imageFillUrls = await imageFillUrlsPromise;
                const remoteUrl = imageFillUrls[group.imageRef];
                if (!remoteUrl) {
                    throw new Error(`Figma 未能提供隐藏图片填充：${group.node.name}`);
                }
                let task = downloads.get(remoteUrl);
                if (!task) {
                    task = getApi().then((api) => api.download(remoteUrl));
                    downloads.set(remoteUrl, task);
                }
                contents = await task;
                source = 'figma';
                extension = detectImageExtension(contents);
                await cache.write({
                    fileKey: session.fileKey,
                    nodeId: `image-ref:${group.imageRef}`,
                    format: extension,
                    scale: 1,
                    variant: 'source-image-v1',
                }, contents);
            }
            extension ??= detectImageExtension(contents);
            const url = writer.buildUrl(
                group.node.name,
                `${session.fileKey}:image-ref:${group.imageRef}`,
                extension,
                1,
            );
            const asset = await writer.write(url, contents);
            for (const node of group.nodes) completeAsset(node, asset, source);
        }
    };

    await processTiled(requests.tiled);
    await processRemote(requests.png);
    // Run after whole-node renders so a correct visibility-independent source
    // image wins if both paths share the same legacy asset filename.
    await processRawImages(requests.rawImages);

    const gradientAssets = new Map<string, SpriteAssetSpec>();
    for (const node of requests.gradients) {
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const png = frame && fill
            ? gradientPng(
                frame.width,
                frame.height,
                fill,
                cornerRadii(node),
                importSettings.scale,
            )
            : null;
        if (png) {
            const url = writer.buildUrl(
                node.name,
                `${session.fileKey}:${node.id}:gradient`,
                'png',
                importSettings.scale,
            );
            const gradientKey = url.normalize('NFKC').toLocaleLowerCase('en-US');
            const firstAsset = gradientAssets.get(gradientKey);
            const existing = firstAsset || importSettings.refreshAssets
                ? null
                : await writer.existing(url);
            const asset = firstAsset ?? existing ?? await writer.write(url, png);
            gradientAssets.set(gradientKey, asset);
            completeAsset(node, asset, firstAsset || existing ? 'existing' : 'generated');
            continue;
        }
        completed += 1;
        emitProgress({
            phase: 'assets',
            value: total ? completed / total : 1,
            message: `生成渐变 ${completed}/${total} · ${node.name}`,
        });
    }
    return { assets, warnings: [...warnings] };
}

async function resolveFonts(settings: ImportSettings): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [family, url] of Object.entries(settings.fontMap)) {
        const uuid = await resolveAssetUuid(url);
        if (uuid) {
            result.set(family, uuid);
        }
    }
    return result;
}

function inferredLayoutMode(node: FigmaNode): string | undefined {
    const nativeMode = inferCocosLayoutMode(node);
    if (nativeMode) {
        return nativeMode;
    }
    if (node.layoutMode && node.layoutMode !== 'NONE') {
        return undefined;
    }
    const frames = node.children
        .map((child) => child.absoluteBoundingBox)
        .filter((frame): frame is Rect => Boolean(frame));
    if (!frames.length) {
        return 'VERTICAL';
    }
    const centersX = frames.map((frame) => frame.x + frame.width / 2);
    const centersY = frames.map((frame) => frame.y + frame.height / 2);
    const spreadX = Math.max(...centersX) - Math.min(...centersX);
    const spreadY = Math.max(...centersY) - Math.min(...centersY);
    if (spreadY <= 2) {
        return 'HORIZONTAL';
    }
    if (spreadX <= 2) {
        return 'VERTICAL';
    }
    return 'GRID';
}

export function makeSpec(
    node: FigmaNode,
    parentFrame: Rect | undefined,
    decisions: Map<string, Decision>,
    plans: ReadonlyMap<string, NodeImportPlan>,
    nodeById: ReadonlyMap<string, FigmaNode>,
    assets: Map<string, SpriteAssetSpec>,
    fonts: Map<string, string>,
    isRoot = false,
    parentWorldRotation = 0,
): SceneNodeSpec | null {
    const decision = decisionForNode(node, decisions);
    if (decision.action === 'ignore') {
        return null;
    }
    const frame = nodeFrame(node);
    const plan = plans.get(node.id);
    const fold = plan?.fold;
    const foldSource = fold ? nodeById.get(fold.sourceNodeId) : undefined;
    const textSource = fold?.kind === 'single-text' && foldSource ? foldSource : node;
    const visualSource = fold && fold.kind !== 'single-text' && foldSource ? foldSource : node;
    const resolvedKind = decision.kind === 'auto' ? inferKind(node) : decision.kind;
    const plannedKind = plan?.kind ?? resolvedKind;
    const bitmapTerminal = decision.nineSlice || decision.action === 'render';
    const terminal = bitmapTerminal || isTerminalAction(decision.action);
    const effectiveKind = kindForImportAction(plannedKind, decision.action, decision.nineSlice);
    const spriteSourceId = fold && fold.kind !== 'single-text'
        ? fold.sourceNodeId
        : node.id;
    const spriteAsset = assets.get(spriteSourceId);
    const absorbedDirectIds = new Set(fold ? [fold.sourceNodeId] : []);
    const fullFold = fold?.kind === 'single-image' || fold?.kind === 'single-text';
    const worldRotation = parentWorldRotation + node.rotation;
    return {
        figmaId: node.id,
        name: decision.name ?? node.name,
        figmaType: visualSource.type,
        action: decision.action,
        kind: effectiveKind,
        frame,
        parentFrame,
        intrinsicSize: node.size,
        isRoot,
        rotation: node.rotation,
        worldRotation,
        opacity: foldSource && fullFold
            ? node.opacity * foldSource.opacity
            : node.opacity,
        visible: node.visible,
        clipsContent: node.clipsContent,
        cornerRadii: cornerRadii(visualSource),
        fills: textSource.fills,
        strokes: textSource.strokes,
        strokeWeight: textSource.strokeWeight,
        characters: textSource.characters,
        textStyle: textSource.style,
        layout: {
            mode: effectiveKind === 'layout' || effectiveKind === 'scrollView'
                ? inferredLayoutMode(node)
                : undefined,
            sourceMode: node.layoutMode,
            wrap: node.layoutWrap,
            primaryAlign: node.primaryAxisAlignItems,
            counterAlign: node.counterAxisAlignItems,
            primarySizing: node.primaryAxisSizingMode,
            counterSizing: node.counterAxisSizingMode,
            itemSpacing: node.itemSpacing,
            counterSpacing: node.counterAxisSpacing,
            paddingLeft: node.paddingLeft,
            paddingRight: node.paddingRight,
            paddingTop: node.paddingTop,
            paddingBottom: node.paddingBottom,
        },
        overflowDirection: node.overflowDirection,
        constraints: node.constraints,
        relativeTransform: node.relativeTransform,
        sprite: spriteAsset,
        fontUuid: textSource.style?.fontFamily ? fonts.get(textSource.style.fontFamily) : undefined,
        aliasFigmaIds: fold?.absorbedNodeIds,
        flattenBoundary: bitmapTerminal || fullFold
            ? true
            : fold?.kind === 'background'
                ? false
                : undefined,
        planReason: plan?.reason,
        children: terminal
            ? []
            : node.children
                .filter((child) => !absorbedDirectIds.has(child.id))
                .map((child) => makeSpec(
                    child,
                    frame,
                    decisions,
                    plans,
                    nodeById,
                    assets,
                    fonts,
                    false,
                    worldRotation,
                ))
                .filter((child): child is SceneNodeSpec => child !== null),
    };
}

async function getNodeMaps(): Promise<Record<string, Record<string, string>>> {
    const saved = await Editor.Profile.getProject(packageJSON.name, 'nodeMaps', 'project');
    return saved && typeof saved === 'object' ? saved as Record<string, Record<string, string>> : {};
}

function cocosFileId(): string {
    const generated = Editor.Utils?.UUID?.generate?.(true);
    return typeof generated === 'string' && generated.length > 0
        ? generated
        : randomBytes(16).toString('base64').replace(/=+$/g, '');
}

async function queryPrefabAsset(urlOrUuid: string): Promise<PrefabAssetInfo | null> {
    return await Editor.Message.request(
        'asset-db',
        'query-asset-info',
        urlOrUuid,
    ) as PrefabAssetInfo | null;
}

function assertPrefabAsset(
    info: PrefabAssetInfo,
    expected: { uuid?: string; url?: string } = {},
): void {
    if (info.invalid || info.imported !== true) {
        throw new Error(`Prefab 尚未完成导入：${info.url}`);
    }
    if (info.importer !== 'prefab' || info.type !== 'cc.Prefab' || info.isDirectory) {
        throw new Error(`目标资源不是可编辑的 Cocos Prefab：${info.url}`);
    }
    if (info.readonly || info.redirect) {
        throw new Error(`目标 Prefab 为只读或重定向资源，不能安全更新：${info.url}`);
    }
    if (expected.uuid && info.uuid !== expected.uuid) {
        throw new Error(`Prefab UUID 校验失败：${info.url}`);
    }
    if (expected.url && info.url !== expected.url) {
        throw new Error(`Prefab 路径校验失败：期望 ${expected.url}，实际 ${info.url}`);
    }
}

async function waitForPrefabAsset(url: string, expectedUuid?: string): Promise<PrefabAssetInfo> {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
        const info = await queryPrefabAsset(url);
        if (info?.invalid) {
            throw new Error(`Cocos Prefab 资源导入失败：${url}`);
        }
        if (info?.imported === true) {
            if (expectedUuid && info.uuid !== expectedUuid) {
                throw new Error(`Prefab UUID 在导入期间发生变化：${url}`);
            }
            assertPrefabAsset(info, { uuid: expectedUuid, url });
            return info;
        }
        if (activeController?.signal.aborted) {
            throw new CancelledError();
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error(`等待 Cocos Prefab 资源就绪超时：${url}`);
}

async function queryPrefabMeta(uuid: string): Promise<Record<string, unknown>> {
    const meta = await Editor.Message.request(
        'asset-db',
        'query-asset-meta',
        uuid,
    );
    if (!meta || typeof meta !== 'object') {
        throw new Error(`无法读取 Prefab Meta：${uuid}`);
    }
    const value = meta as unknown as Record<string, unknown>;
    if (value.uuid !== uuid || value.importer !== 'prefab') {
        throw new Error(`Prefab Meta 与目标资源不匹配：${uuid}`);
    }
    return value;
}

function prefabDiskPath(url: string): string {
    if (!url.startsWith('db://')) {
        throw new Error(`Prefab URL 无效：${url}`);
    }
    return resolve(Editor.Project.path, url.slice('db://'.length));
}

async function storedPrefabMatchesRecord(
    info: PrefabAssetInfo,
    record: PrefabSyncRecord,
): Promise<boolean> {
    try {
        return prefabJsonContainsSyncRecord(
            await readFile(prefabDiskPath(info.url)),
            record,
        );
    } catch {
        return false;
    }
}

async function waitForOpenedPrefab(
    prefabUrl: string,
    prefabUuid: string,
    rootFileId: string,
): Promise<void> {
    const currentDirty = await Editor.Message.request('scene', 'query-dirty') as boolean;
    if (currentDirty) {
        throw new Error('当前打开的场景或 Prefab 有未保存修改；为避免触发保存询问，请先手工保存或还原后再导入。');
    }
    Editor.Selection.clear('node');
    Editor.Selection.select('asset', prefabUuid);
    await Editor.Message.request('asset-db', 'open-asset', prefabUuid);
    const started = Date.now();
    let lastReason = 'Creator 尚未返回 Prefab 编辑状态';
    while (Date.now() - started < 30_000) {
        try {
            const state = await Editor.Message.request('scene', 'execute-scene-script', {
                name: packageJSON.name,
                method: 'inspectPrefabContext',
                args: [{ prefabUuid, rootFileId }],
            }) as PrefabEditingState;
            if (state.ready) {
                return;
            }
            lastReason = state.reason ?? lastReason;
        } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
        }
        if (activeController?.signal.aborted) {
            throw new CancelledError();
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error(`打开目标 Prefab 超时：${lastReason}`);
}

async function assertOpenedPrefab(prefabUuid: string, rootFileId: string): Promise<void> {
    const state = await Editor.Message.request('scene', 'execute-scene-script', {
        name: packageJSON.name,
        method: 'inspectPrefabContext',
        args: [{ prefabUuid, rootFileId }],
    }) as PrefabEditingState;
    if (!state.ready) {
        throw new Error(`目标 Prefab 编辑上下文已变化：${state.reason ?? '未知原因'}`);
    }
}

async function waitForSceneSaved(): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
        const dirty = await Editor.Message.request('scene', 'query-dirty') as boolean;
        if (!dirty) {
            return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error('等待 Prefab 保存完成超时。');
}

async function getPrefabBindings(): Promise<Record<string, string>> {
    const saved = await Editor.Profile.getProject(
        packageJSON.name,
        'prefabBindingsV1',
        'project',
    );
    if (!saved || typeof saved !== 'object') {
        return {};
    }
    const result: Record<string, string> = {};
    for (const [sourceHash, prefabUuid] of Object.entries(saved as Record<string, unknown>)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(sourceHash)
            || typeof prefabUuid !== 'string'
            || !prefabUuid) {
            throw new Error('Prefab 来源绑定记录已损坏，已停止导入。');
        }
        result[sourceHash] = prefabUuid;
    }
    return result;
}

async function setPrefabBinding(sourceHash: string, prefabUuid: string): Promise<void> {
    const bindings = await getPrefabBindings();
    bindings[sourceHash] = prefabUuid;
    await Editor.Profile.setProject(
        packageJSON.name,
        'prefabBindingsV1',
        bindings,
        'project',
    );
}

async function removePrefabBinding(sourceHash: string): Promise<void> {
    const bindings = await getPrefabBindings();
    if (!bindings[sourceHash]) {
        return;
    }
    delete bindings[sourceHash];
    await Editor.Profile.setProject(
        packageJSON.name,
        'prefabBindingsV1',
        bindings,
        'project',
    );
}

async function getPendingPrefabSyncs(): Promise<Record<string, {
    prefabUuid: string;
    record: PrefabSyncRecord;
}>> {
    const saved = await Editor.Profile.getProject(
        packageJSON.name,
        'pendingPrefabSyncV1',
        'project',
    );
    if (!saved || typeof saved !== 'object') {
        return {};
    }
    const result: Record<string, { prefabUuid: string; record: PrefabSyncRecord }> = {};
    for (const [sourceHash, raw] of Object.entries(saved as Record<string, unknown>)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(sourceHash)
            || !raw
            || typeof raw !== 'object'
            || typeof (raw as { prefabUuid?: unknown }).prefabUuid !== 'string') {
            throw new Error('Prefab 待恢复同步记录已损坏，已停止导入。');
        }
        const record = readPrefabSyncRecord({
            userData: {
                figmaImporter: (raw as { record?: unknown }).record,
            },
        });
        if (!record || record.sourceHash !== sourceHash) {
            throw new Error('Prefab 待恢复同步记录来源不一致，已停止导入。');
        }
        result[sourceHash] = {
            prefabUuid: (raw as { prefabUuid: string }).prefabUuid,
            record,
        };
    }
    return result;
}

async function setPendingPrefabSync(
    sourceHash: string,
    value: { prefabUuid: string; record: PrefabSyncRecord } | null,
): Promise<void> {
    const pending = await getPendingPrefabSyncs();
    if (value) {
        pending[sourceHash] = value;
    } else {
        delete pending[sourceHash];
    }
    await Editor.Profile.setProject(
        packageJSON.name,
        'pendingPrefabSyncV1',
        pending,
        'project',
    );
}

async function verifiedPrefabRecord(
    info: PrefabAssetInfo,
    sourceHash: string,
): Promise<{ meta: Record<string, unknown>; record: PrefabSyncRecord }> {
    let meta = await queryPrefabMeta(info.uuid);
    let record = readPrefabSyncRecord(meta);
    if (!record) {
        throw new Error(
            `Prefab 缺少 Figma 来源记录，无法确认是否可安全覆盖：${info.url}。请先移动或重命名该资源。`,
        );
    }
    if (record.sourceHash !== sourceHash) {
        throw new Error(`Prefab 来自另一个 Figma Frame，已拒绝覆盖：${info.url}`);
    }
    const pending = (await getPendingPrefabSyncs())[sourceHash];
    if (pending) {
        if (pending.prefabUuid !== info.uuid || pending.record.sourceHash !== sourceHash) {
            throw new Error('检测到与目标 Prefab 不一致的待恢复同步记录，已停止导入。');
        }
        if (await storedPrefabMatchesRecord(info, pending.record)) {
            await Editor.Message.request(
                'asset-db',
                'save-asset-meta',
                info.uuid,
                JSON.stringify(mergePrefabSyncRecord(meta, pending.record), null, 2),
            );
            await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
            await waitForPrefabAsset(info.url, info.uuid);
            meta = await queryPrefabMeta(info.uuid);
            const recovered = readPrefabSyncRecord(meta);
            if (!recovered || JSON.stringify(recovered) !== JSON.stringify(pending.record)) {
                throw new Error('Prefab 增量同步记录自动恢复失败。');
            }
            record = recovered;
        } else if (!await storedPrefabMatchesRecord(info, record)) {
            throw new Error('Prefab 文件与当前及待恢复的同步记录都不一致，已停止自动恢复。');
        }
        await setPendingPrefabSync(sourceHash, null);
    }
    return { meta, record };
}

async function writeVerifiedPrefabRecord(
    info: PrefabAssetInfo,
    sourceHash: string,
    record: PrefabSyncRecord,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const meta = await queryPrefabMeta(info.uuid);
            const existing = readPrefabSyncRecord(meta);
            if (!existing || existing.sourceHash !== sourceHash) {
                throw new Error('写入前 Prefab 来源记录不一致。');
            }
            await Editor.Message.request(
                'asset-db',
                'save-asset-meta',
                info.uuid,
                JSON.stringify(mergePrefabSyncRecord(meta, record), null, 2),
            );
            await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
            await waitForPrefabAsset(info.url, info.uuid);
            const saved = readPrefabSyncRecord(await queryPrefabMeta(info.uuid));
            if (!saved || JSON.stringify(saved) !== JSON.stringify(record)) {
                throw new Error('Prefab 来源记录写入后校验不一致。');
            }
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Prefab 来源记录写入失败。');
}

async function prepareLinkedFramePrefab(
    prefabUrl: string,
    prefabName: string,
    rootFrame: Rect,
    sourceHash: string,
    sourceRootId: string,
): Promise<{
    info: PrefabAssetInfo;
    record: PrefabSyncRecord;
}> {
    const bindings = await getPrefabBindings();
    const boundUuid = bindings[sourceHash];
    const pending = (await getPendingPrefabSyncs())[sourceHash];
    const pendingInfo = pending
        ? await queryPrefabAsset(pending.prefabUuid)
        : null;
    const targetPlan = planPrefabRecoveryTarget(
        pending?.prefabUuid,
        boundUuid,
        Boolean(pendingInfo),
    );
    if (targetPlan.clearPending) {
        await setPendingPrefabSync(sourceHash, null);
    }
    if (targetPlan.clearBinding) {
        await removePrefabBinding(sourceHash);
    }
    const targetUuid = targetPlan.targetUuid;
    if (targetUuid) {
        let targetInfo = pendingInfo?.uuid === targetUuid
            ? pendingInfo
            : await queryPrefabAsset(targetUuid);
        if (!targetInfo) {
            if (bindings[sourceHash] === targetUuid) {
                await removePrefabBinding(sourceHash);
            }
        } else {
            targetInfo = await waitForPrefabAsset(targetInfo.url, targetUuid);
            if (pending?.prefabUuid === targetUuid && boundUuid !== targetUuid) {
                // Persist the recovery identity before verifiedPrefabRecord may
                // commit and clear pending. A later move failure must still be
                // able to locate the exact Prefab by UUID on the next attempt.
                await setPrefabBinding(sourceHash, targetUuid);
            }
            const verified = await verifiedPrefabRecord(targetInfo, sourceHash);
            if (targetInfo.url !== prefabUrl) {
                const conflict = await queryPrefabAsset(prefabUrl);
                if (conflict && conflict.uuid !== targetUuid) {
                    throw new Error(
                        `Figma Frame 对应的 Prefab 需要移动到 ${prefabUrl}，但目标路径已被其他资源占用。`,
                    );
                }
                if (!conflict) {
                    const moved = await Editor.Message.request(
                        'asset-db',
                        'move-asset',
                        targetInfo.url,
                        prefabUrl,
                        { overwrite: false, rename: false },
                    ) as PrefabAssetInfo | null;
                    if (!moved || moved.uuid !== targetUuid) {
                        throw new Error(`无法在保留 UUID 的前提下移动 Prefab：${prefabUrl}`);
                    }
                    targetInfo = await waitForPrefabAsset(prefabUrl, targetUuid);
                } else {
                    targetInfo = await waitForPrefabAsset(prefabUrl, targetUuid);
                }
            }
            return {
                info: targetInfo,
                record: verified.record,
            };
        }
    }

    let info = await queryPrefabAsset(prefabUrl);
    if (!info) {
        const rootFileId = cocosFileId();
        const rootTransformFileId = cocosFileId();
        const seed = createMinimalPrefabJson(
            prefabName,
            rootFrame,
            rootFileId,
            rootTransformFileId,
        );
        const created = await Editor.Message.request(
            'asset-db',
            'create-asset',
            prefabUrl,
            seed,
            { overwrite: false, rename: false },
        ) as PrefabAssetInfo | null;
        if (!created) {
            throw new Error(`无法创建 Prefab：${prefabUrl}`);
        }
        info = await waitForPrefabAsset(prefabUrl, created.uuid);
        const meta = await queryPrefabMeta(info.uuid);
        const record = createPrefabSyncRecord(
            sourceHash,
            sourceRootId,
            rootFileId,
            rootTransformFileId,
        );
        const nextMeta = mergePrefabSyncRecord(meta, record);
        await Editor.Message.request(
            'asset-db',
            'save-asset-meta',
            info.uuid,
            JSON.stringify(nextMeta, null, 2),
        );
        await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
        info = await waitForPrefabAsset(prefabUrl, info.uuid);
        const verified = await verifiedPrefabRecord(info, sourceHash);
        await setPrefabBinding(sourceHash, info.uuid);
        return {
            info,
            record: verified.record,
        };
    }
    info = await waitForPrefabAsset(prefabUrl, info.uuid);
    const verified = await verifiedPrefabRecord(info, sourceHash);
    await setPrefabBinding(sourceHash, info.uuid);
    return {
        info,
        record: verified.record,
    };
}

async function importLinkedFramePrefab(args: {
    prefabUrl: string;
    prefabName: string;
    fileKey: string;
    sourceNodeId: string;
    rootFrame: Rect;
    scale: number;
    roots: SceneNodeSpec[];
}): Promise<SceneImportResult> {
    const sourceHash = figmaFrameSourceHash(args.fileKey, args.sourceNodeId);
    const prepared = await prepareLinkedFramePrefab(
        args.prefabUrl,
        args.prefabName,
        {
            x: args.rootFrame.x * args.scale,
            y: args.rootFrame.y * args.scale,
            width: args.rootFrame.width * args.scale,
            height: args.rootFrame.height * args.scale,
        },
        sourceHash,
        args.roots[0].figmaId,
    );
    await waitForOpenedPrefab(
        prepared.info.url,
        prepared.info.uuid,
        prepared.record.rootFileId,
    );
    const existingNodeFileIds = resolveExistingNodeFileIds(
        prepared.record,
        collectSceneSpecFigmaIds(args.roots),
    );
    const payload: SceneImportPayload = {
        packageName: packageJSON.name,
        fileKey: args.fileKey,
        rootName: args.prefabName,
        rootFrame: args.rootFrame,
        scale: args.scale,
        updateExisting: true,
        existingMap: {},
        prefabUrl: prepared.info.url,
        roots: args.roots,
        prefabContext: {
            prefabUuid: prepared.info.uuid,
            rootFileId: prepared.record.rootFileId,
            existingNodeFileIds,
            managedNodeFileIds: prepared.record.managedNodeFileIds,
            managedComponentFileIds: prepared.record.managedComponentFileIds,
            managedHelperFileIds: prepared.record.managedHelperFileIds,
        },
    };
    let snapshotStarted = false;
    let saveAttempted = false;
    try {
        const dirtyBeforeImport = await Editor.Message.request('scene', 'query-dirty') as boolean;
        if (dirtyBeforeImport) {
            throw new Error('目标 Prefab 有未保存的手工修改，请先保存后再执行 Figma 增量导入。');
        }
        await Editor.Message.request('scene', 'snapshot');
        snapshotStarted = true;
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: 'importDocument',
            args: [payload],
        }) as SceneImportResult;
        if (!result.prefabSync) {
            throw new Error('Prefab 增量同步未返回 fileId 记录，已停止保存。');
        }
        const nextRecord = recordPrefabSyncCapture(prepared.record, result.prefabSync);
        await setPendingPrefabSync(sourceHash, {
            prefabUuid: prepared.info.uuid,
            record: nextRecord,
        });
        await assertOpenedPrefab(prepared.info.uuid, prepared.record.rootFileId);
        // Once the save request is sent its result is ambiguous until the
        // persisted Prefab is verified. Do not roll the in-memory Prefab back
        // on an IPC timeout: the disk write may already have completed.
        saveAttempted = true;
        await Editor.Message.request('scene', 'save-scene');
        await waitForSceneSaved();
        const currentInfo = await waitForPrefabAsset(prepared.info.url, prepared.info.uuid);
        if (!await storedPrefabMatchesRecord(currentInfo, nextRecord)) {
            throw new Error('Prefab 文件未包含本次同步生成的全部 fileId，已停止更新 Meta。');
        }
        const currentMeta = await queryPrefabMeta(currentInfo.uuid);
        const currentRecord = readPrefabSyncRecord(currentMeta);
        if (!currentRecord || currentRecord.sourceHash !== sourceHash) {
            throw new Error('Prefab 来源记录在保存期间发生变化，已拒绝提交。');
        }
        await writeVerifiedPrefabRecord(currentInfo, sourceHash, nextRecord);
        await setPendingPrefabSync(sourceHash, null);
        const verified = await queryPrefabAsset(prepared.info.url);
        if (!verified) {
            throw new Error('保存后 Prefab UUID 校验失败。');
        }
        assertPrefabAsset(verified, {
            uuid: prepared.info.uuid,
            url: prepared.info.url,
        });
        result.prefabUrl = prepared.info.url;
        Editor.Selection.clear('node');
        Editor.Selection.select('asset', prepared.info.uuid);
        return result;
    } catch (error) {
        if (snapshotStarted && !saveAttempted) {
            await Editor.Message.request('scene', 'snapshot-abort').catch(() => undefined);
        }
        throw error;
    }
}

async function performImport(request: ImportRequest): Promise<SceneImportResult> {
    if (!activeDocument) {
        throw new Error('请先读取 Figma 文件。');
    }
    const importSettings = safeSettings(request.settings);
    await saveSettings(importSettings);
    beginOperation();
    try {
        emitProgress({ phase: 'assets', value: 0, message: '分析并准备资源…' });
        const decisions = decisionMap(request.overrides, activeDocument.tree);
        const builtAssets = await buildAssets(activeDocument, decisions, importSettings);
        const { assets, warnings } = builtAssets;
        // buildAssets may promote a container to a local same-name resource.
        // Compile after that promotion so assets and SceneNodeSpec share the
        // exact same final plan.
        const plans = compileImportPlan(activeDocument.roots, decisions);
        const fonts = await resolveFonts(importSettings);
        const sourceRootFrames = activeDocument.roots.map(nodeFrame);
        const multipleRoots = activeDocument.roots.length > 1;
        const arrangedWidth = multipleRoots
            ? sourceRootFrames.reduce((total, frame) => total + frame.width, 0)
                + Math.max(0, sourceRootFrames.length - 1) * 160
            : sourceRootFrames[0]?.width ?? 0;
        const rootFrame = multipleRoots
            ? {
                x: 0,
                y: 0,
                width: arrangedWidth,
                height: Math.max(0, ...sourceRootFrames.map((frame) => frame.height)),
            }
            : sourceRootFrames[0] ?? { x: 0, y: 0, width: 0, height: 0 };
        let rootCursor = 0;
        const roots = activeDocument.roots
            .map((node, index) => {
                const spec = makeSpec(
                    node,
                    rootFrame,
                    decisions,
                    plans,
                    activeDocument!.nodeById,
                    assets,
                    fonts,
                    true,
                );
                if (spec && multipleRoots) {
                    spec.frame = {
                        x: rootCursor,
                        y: 0,
                        width: sourceRootFrames[index].width,
                        height: sourceRootFrames[index].height,
                    };
                    rootCursor += sourceRootFrames[index].width + 160;
                }
                return spec;
            })
            .filter((node): node is SceneNodeSpec => node !== null);
        if (!roots.length) {
            throw new Error('没有选中任何可导入节点。');
        }

        const sourceNodeId = activeDocument.sourceNodeId;
        if (sourceNodeId && roots.length === 1) {
            const prefabWriter = new AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = roots[0]?.name?.trim()
                || activeDocument.roots[0]?.name?.trim()
                || activeDocument.fileName;
            const prefabUrl = `db://assets/${prefabWriter.folder}/${sanitizeAssetName(frameName)}.prefab`;
            emitProgress({
                phase: 'scene',
                value: 0.05,
                message: '正在创建或打开目标 Prefab…',
            });
            const result = await importLinkedFramePrefab({
                prefabUrl,
                prefabName: frameName,
                fileKey: activeDocument.fileKey,
                sourceNodeId,
                rootFrame,
                scale: importSettings.scale,
                roots,
            });
            const nodeMaps = await getNodeMaps();
            // Prefab updates persist by PrefabInfo.fileId in the asset meta;
            // runtime node UUIDs are session-only and must never be reused here.
            delete nodeMaps[activeDocument.fileKey];
            await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
            const finalResult = warnings.length ? { ...result, warnings } : result;
            emitProgress({
                phase: 'done',
                value: 1,
                message: `完成：新建 ${result.created}，更新 ${result.updated}，已打开预制体 ${prefabUrl}${warnings.length ? `；${warnings.length} 个三/九宫已降级为 PNG 整层` : ''}`,
            });
            return finalResult;
        }

        const nodeMaps = await getNodeMaps();
        const payload: SceneImportPayload = {
            packageName: packageJSON.name,
            fileKey: activeDocument.fileKey,
            rootName: activeDocument.fileName,
            rootFrame,
            scale: importSettings.scale,
            updateExisting: importSettings.updateExisting,
            existingMap: nodeMaps[activeDocument.fileKey] ?? {},
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: 'importDocument',
            args: [payload],
        }) as SceneImportResult;
        await Editor.Message.request('scene', 'snapshot');
        nodeMaps[activeDocument.fileKey] = result.nodeMap;
        await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
        Editor.Selection.select('node', result.rootUuid);
        if (importSettings.autoSave) {
            await Editor.Message.request('scene', 'save-scene');
        }
        const finalResult = warnings.length ? { ...result, warnings } : result;
        emitProgress({
            phase: 'done',
            value: 1,
            message: `完成：新建 ${result.created}，更新 ${result.updated}${warnings.length ? `；${warnings.length} 个三/九宫已降级为 PNG 整层` : ''}`,
        });
        return finalResult;
    } catch (error) {
        if (error instanceof CancelledError || activeController?.signal.aborted) {
            emitProgress({ phase: 'cancelled', value: 0, message: '已取消。' });
            throw new Error('操作已取消。');
        }
        emitProgress({
            phase: 'error',
            value: 0,
            message: error instanceof Error ? error.message : '导入失败。',
        });
        throw error;
    } finally {
        finishOperation();
    }
}

export const methods: Record<string, (...args: any[]) => any> = {
    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    async getState() {
        await vault.initialize();
        return {
            version: packageJSON.version,
            vault: vault.status(),
            settings: await getSettings(),
            fontAssets: await listFontAssets(),
            document: activeDocument ? {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl: activeDocument.sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
                nodeOverrides: await nodeOverridesFor(activeDocument.fileKey),
            } : null,
        };
    },

    async setToken(value: string) {
        return vault.set(value);
    },

    async clearToken() {
        return vault.clear();
    },

    async verifyToken() {
        beginOperation();
        try {
            const identity = await (await client()).verify();
            return {
                ok: true,
                handle: identity.handle || 'Figma User',
            };
        } finally {
            finishOperation();
        }
    },

    async saveSettings(value: unknown) {
        return saveSettings(value);
    },

    async saveNodeOverrides(fileKey: unknown, overrides: unknown, scopeIds: unknown) {
        return saveNodeOverrides(fileKey, overrides, scopeIds);
    },

    async pickAssetFolder(current: unknown) {
        return pickAssetFolder(current);
    },

    async pickPrefabFolder(current: unknown) {
        return pickPrefabFolder(current);
    },

    async pickLocalResourceFolder(current: unknown) {
        return pickLocalResourceFolder(current);
    },

    async pickCacheFolder(current: unknown) {
        return pickLocalResourceFolder(current);
    },

    async fetchDocument(sourceUrl: string) {
        beginOperation();
        try {
            emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取 Figma 文件…' });
            const parsed = parseFigmaSource(sourceUrl);
            const api = await client();
            const payload = parsed.nodeId
                ? await api.getNode(parsed.fileKey, parsed.nodeId)
                : await api.getFile(parsed.fileKey);
            activeDocument = annotateDocumentPlan(
                parseDocument(payload, sourceUrl, parsed.fileKey, parsed.nodeId),
            );
            const current = await getSettings();
            await saveSettings({ ...current, sourceUrl });
            emitProgress({ phase: 'idle', value: 1, message: `已读取 ${activeDocument.fileName}` });
            return {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
                fontAssets: await listFontAssets(),
                nodeOverrides: await nodeOverridesFor(activeDocument.fileKey),
            };
        } catch (error) {
            emitProgress({
                phase: 'error',
                value: 0,
                message: error instanceof Error ? error.message : '读取失败。',
            });
            throw error;
        } finally {
            finishOperation();
        }
    },

    async getPreview(nodeId: string) {
        const node = activeDocument?.nodeById.get(nodeId);
        if (!activeDocument || !node) {
            throw new Error('预览节点不存在。');
        }
        beginOperation();
        try {
            const urls = await (await client()).getImageUrls(
                activeDocument.fileKey,
                [nodeId],
                'png',
                1,
                !overflowingRenderFrame(node),
            );
            if (!urls[nodeId]) {
                throw new Error('无法生成节点预览。');
            }
            return { url: urls[nodeId] };
        } finally {
            finishOperation();
        }
    },

    async roundtripDetect(sourceUrl: string, explicitRootId?: string) {
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).detect(sourceUrl, explicitRootId);
        } finally {
            finishRoundtripOperation(controller);
        }
    },

    async roundtripPreview(sourceUrl: string, explicitRootId?: string) {
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).preview(sourceUrl, explicitRootId);
        } finally {
            finishRoundtripOperation(controller);
        }
    },

    async roundtripPair(pairToken: string) {
        if (roundtripRecoveryBlocker) throw new Error(roundtripRecoveryBlocker);
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).pair(pairToken);
        } finally {
            finishRoundtripOperation(controller);
        }
    },

    async roundtripApply(previewToken: string) {
        if (roundtripRecoveryBlocker) throw new Error(roundtripRecoveryBlocker);
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).apply(previewToken);
        } finally {
            finishRoundtripOperation(controller);
        }
    },

    roundtripCancel() {
        roundtripController?.abort();
    },

    async importSelection(request: ImportRequest) {
        return performImport(request);
    },

    cancelImport() {
        activeController?.abort();
    },
};

export async function load(): Promise<void> {
    await vault.initialize();
    try {
        const recovered = await recoverInterruptedTransactions(Editor.Project.path, editorReimporter);
        const active = recovered.filter((result) => result.status === 'active-owner');
        roundtripRecoveryBlocker = active.length
            ? `检测到 ${active.length} 个仍由活动进程持有的 Round-trip 事务，暂时禁止 Pair/Apply。`
            : null;
    } catch (error) {
        roundtripRecoveryBlocker = `Round-trip 启动恢复失败：${error instanceof Error ? error.message : '未知错误'}`;
        console.error(roundtripRecoveryBlocker);
    }
}

export function unload(): void {
    activeController?.abort();
    activeController = null;
    activeDocument = null;
}
