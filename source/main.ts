import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { diagnosticStart, diagnosticTask } from './diagnostics';
import { readFile, readdir } from 'fs/promises';
import packageJSON from '../package.json';
import { FigmaClient, CancelledError, clampImageScale } from './figma/client';
import {
    hasHiddenDescendant,
    inferAction,
    inferCocosLayoutMode,
    inferKind,
    isPatchCandidate,
    isNamedSliceGroup,
    isVectorNode,
    nativeTiledPaintSource,
    plainImageSourceRef,
    type TiledPaintSource,
} from './figma/analyzer';
import { parseDocument } from './figma/parser';
import {
    annotateTreeWithImportPlan,
    compileImportPlan,
    normalizeFigmaSliceDecision,
    resolveAutomaticMergeDecisions,
} from './figma/import-planner';
import { analyzeMaskTint, verifyWhiteAlphaPng } from './figma/mask-tint';
import { analyzeSliceGrid, type SliceAnalysis } from './figma/slicing';
import { parseFigmaSource } from './figma/url';
import {
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from './import-actions';
import {
    SYNC_MARKER_SCRIPT_URL,
    assertUniqueSyncOwnership,
    createSyncMarker,
    type SyncMarkerSpec,
} from './importer/sync-marker';
import { planSyncMarkerScript } from './importer/sync-marker-asset';
import {
    emptySyncPreviewSummary,
    planSyncPreview,
    readPrefabSyncMarkers,
    type SyncPreviewResult,
} from './importer/sync-preview';
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
import { writeSlicedPng } from './importer/sliced-png';
import { hiddenLayerIds } from './import-visibility';
import { isPng } from './importer/raster-format';
import { pixelSizedTileAsset, rasterizeTile, tiledRasterKey } from './importer/tiled-png';
import { rasterizeImageFill } from './importer/image-fill';
import {
    collectSceneSpecFigmaIds,
    createMinimalPrefabJson,
    createPrefabSyncRecord,
    collectPrefabComponentFileIds,
    figmaFrameSourceHash,
    mergePrefabSyncRecord,
    planPrefabRecoveryTarget,
    prefabJsonContainsSyncRecord,
    readPrefabSyncRecord,
    retainPrefabSyncEntries,
    recordPrefabSyncCapture,
    resolveExistingNodeFileIds,
    type PrefabSyncRecord,
} from './importer/prefab-sync';
import { TokenVault } from './security/token-vault';
import { FigmaImporterMcpApi, type McpNodeNamePatch } from './mcp-api';
import { McpBridgeServer } from './mcp-bridge/server';
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
import { ImportReviewRecorder, ImportReviewService } from './importer/import-review';
import { finalizeImportReview } from './importer/import-review-finalize';
import type { ImportReview, ReviewScene } from './import-review-model';
import { assertBatchTargets, collectSectionFrames, frameDocument } from './batch-import';
import type {
    BatchDocumentDto, BatchFrameItem, BatchImportItemResult, BatchImportRequest,
    BatchImportResult, BatchProgress, BatchSourceResult, BatchState,
} from './batch-types';

const vault = new TokenVault(packageJSON.name);
const importReviews = new ImportReviewService();
let applyingImportReview = false;
let activeDocument: DocumentSession | null = null;
let activeController: AbortController | null = null;
let activeOperationOwner: string | null = null;
let roundtripController: AbortController | null = null;
let settingsCache: ImportSettings | null = null;
let roundtripRecoveryBlocker: string | null = null;
let documentRevision = 0;
let mcpBridge: McpBridgeServer | null = null;
let mcpApi: FigmaImporterMcpApi | null = null;
const pluginInstanceId = randomBytes(18).toString('base64url');
let nodeOverrideWriteQueue: Promise<void> = Promise.resolve();
let settingsWriteQueue: Promise<void> = Promise.resolve();
const MAX_BATCH_ITEMS = 100;
const batchDocuments = new Map<string, { item: BatchFrameItem; document: DocumentSession }>();
interface BatchRun {
    id: string;
    items: BatchImportItemResult[];
    index: number;
    stopRequested: boolean;
}
let activeBatch: BatchRun | null = null;
let lastBatchResult: BatchImportResult | undefined;

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
    reviewId?: string;
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
    /** 未勾选节点在 Prefab 中已有的 fileId；清理旧节点时必须保留。 */
    retainNodeFileIds?: string[];
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    reviewBefore?: ReviewScene;
    reviewAfter?: ReviewScene;
    review?: ImportReview;
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
    temporaryRoot?: boolean;
    prefabUrl?: string;
    prefabSync?: PrefabSceneSyncCapture;
    /** 标记组件脚本尚未编译完成时的降级说明；导入本身继续成功。 */
    syncMarkerWarning?: string;
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
    Editor.Message.send(packageJSON.name, 'progress', {
        ...progress,
        ...(activeBatch && !progress.batch ? { batch: batchProgress(activeBatch) } : {}),
    });
}

function batchProgress(run: BatchRun): BatchProgress {
    const current = run.items[Math.min(run.index, run.items.length - 1)];
    return {
        batchId: run.id, itemId: current?.id ?? '', name: current?.name ?? '',
        index: Math.min(run.index + 1, run.items.length), total: run.items.length,
        completed: run.items.filter((item) => item.status === 'success' || item.status === 'failed').length,
        stopRequested: run.stopRequested,
        items: run.items.map((item) => ({ ...item })),
    };
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
        importHiddenLayers: input.importHiddenLayers !== false,
        autoSave: input.autoSave === true,
        fontMap,
    };
}

async function getSettingsUnlocked(): Promise<ImportSettings> {
    if (settingsCache) {
        return settingsCache;
    }
    const saved = await Editor.Profile.getProject(packageJSON.name, 'settings', 'project');
    settingsCache = safeSettings(saved);
    return settingsCache;
}

async function getSettings(): Promise<ImportSettings> {
    await settingsWriteQueue;
    return getSettingsUnlocked();
}

function withSettingsWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = settingsWriteQueue.then(operation);
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
}

function persistSettingsUnlocked(value: unknown): Promise<ImportSettings> {
    return (async () => {
        const next = safeSettings(value);
        await Editor.Profile.setProject(packageJSON.name, 'settings', next, 'project');
        settingsCache = next;
        return next;
    })();
}

function saveSettings(value: unknown): Promise<ImportSettings> {
    return withSettingsWriteLock(() => persistSettingsUnlocked(value));
}

function patchSettings(value: Partial<ImportSettings>): Promise<ImportSettings> {
    return withSettingsWriteLock(async () => {
        const current = await getSettingsUnlocked();
        return persistSettingsUnlocked({ ...current, ...value });
    });
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
    if (activeBatch || activeController || applyingImportReview) throw new Error('导入或结果调整正在执行，请等待完成后再操作 Round-trip。');
    roundtripController?.abort();
    const controller = new AbortController();
    roundtripController = controller;
    return controller;
}

function finishRoundtripOperation(controller: AbortController): void {
    if (roundtripController === controller) roundtripController = null;
}

function beginOperation(owner: string | null = null): AbortController {
    if (applyingImportReview) throw new Error('正在确认导入后的资源调整，请稍候。');
    if (roundtripController) throw new Error('Round-trip 操作正在执行，请等待完成或先取消。');
    if (activeBatch && owner !== activeBatch.id) throw new Error('批量导入正在执行，请等待完成或停止后续任务。');
    if (activeController) {
        throw new Error('当前已有 Figma 操作正在执行，请等待完成或先取消。');
    }
    const controller = new AbortController();
    activeController = controller;
    activeOperationOwner = owner;
    return controller;
}

function finishOperation(controller: AbortController): void {
    if (activeController === controller) {
        activeController = null;
        activeOperationOwner = null;
    }
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
    const figmaSlices = new Set<string>();
    const addDefaults = (nodes: TreeNodeDto[]) => {
        for (const node of nodes) {
            if (node.patchCandidate) figmaSlices.add(node.id);
            decisions.set(node.id, normalizeFigmaSliceDecision({
                action: normalizeImportAction(node.action),
                kind: node.kind,
                nineSlice: node.patchCandidate,
                explicit: false,
            }, Boolean(node.patchCandidate)));
            addDefaults(node.children);
        }
    };
    addDefaults(tree);
    for (const item of overrides ?? []) {
        const name = sanitizeNodeName(item.name);
        decisions.set(item.id, normalizeFigmaSliceDecision({
            action: normalizeImportAction(item.action),
            kind: NODE_KINDS.has(item.kind) ? item.kind : 'auto',
            nineSlice: item.nineSlice,
            explicit: item.explicit === true,
            ...(name ? { name } : {}),
        }, figmaSlices.has(item.id)));
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

/**
 * 本地同名素材把父容器整体提升为 PNG 整层：该父容器的子层不再单独建节点。
 * 导入与"改动预检"共用这段规则，避免预检把被吸收的子层报成"新增"。
 */
/**
 * 同步标记适用于插件的全部单节点链接：任意根类型（Frame / Group / Component / Instance…）
 * 都生成 FigmaSyncNode；整份文件导入与多根来源不生成。
 */
export function syncMarkersEnabled(sourceNodeId: string | undefined, rootCount: number): boolean {
    return Boolean(sourceNodeId) && rootCount === 1;
}

export async function applyLocalParentPromotion(
    roots: readonly FigmaNode[],
    decisions: Map<string, Decision>,
    matchesLocal: (node: FigmaNode) => Promise<boolean>,
    protectedDescendant: (node: FigmaNode) => boolean,
    hasAsset: (nodeId: string) => boolean = () => false,
): Promise<void> {
    const promote = async (node: FigmaNode): Promise<void> => {
        if (hasAsset(node.id) || analyzeMaskTint(node)) {
            return;
        }
        const decision = decisionForNode(node, decisions);
        if (decision.action !== 'generate') {
            return;
        }
        if (node.children.length
            && node.type !== 'TEXT'
            && !decision.nineSlice
            // 重命名不改变资源匹配；只有自身或后代的显式策略覆盖才阻止提升，
            // 否则被吸收的后代会静默消失。
            && !subtreeHasExplicitOverride(node, decisions, false)
            // 同名祖先不能成为抹掉独立切片资源或蒙版表示的理由。
            && !protectedDescendant(node)
            // 父资源无法表达独立的隐藏后代，这种边界必须保留层级。
            && !hasHiddenDescendant(node)
            && await matchesLocal(node)) {
            decisions.set(node.id, { ...decision, action: 'render', nineSlice: false });
            return;
        }
        await Promise.all(node.children.map(promote));
    };
    await Promise.all(roots.map(promote));
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

function withNodeOverrideWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = nodeOverrideWriteQueue.then(operation);
    nodeOverrideWriteQueue = result.then(() => undefined, () => undefined);
    return result;
}

async function saveNodeOverridesUnlocked(
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

function saveNodeOverrides(
    fileKey: unknown,
    values: unknown,
    scopeValues: unknown,
): Promise<ImportOverride[]> {
    return withNodeOverrideWriteLock(
        () => saveNodeOverridesUnlocked(fileKey, values, scopeValues),
    );
}

export function patchNodeNames(fileKey: string, patches: McpNodeNamePatch[]): Promise<ImportOverride[]> {
    return withNodeOverrideWriteLock(async () => {
        if (!fileKey.trim()) throw new Error('无法保存节点名称：缺少 Figma fileKey。');
        const stored = await getStoredNodeOverrides();
        const current = { ...(stored[fileKey] ?? {}) };
        const persisted: ImportOverride[] = [];
        for (const patch of patches) {
            const id = typeof patch.id === 'string' ? patch.id.trim() : '';
            if (!id) throw new Error('无法保存节点名称：缺少 nodeId。');
            const existing = safeNodeOverride(current[id], id);
            const fallback = safeNodeOverride(patch.fallback, id);
            const next = existing ? { ...existing } : fallback ? { ...fallback } : null;
            if (!next && patch.name === null) {
                delete current[id];
                continue;
            }
            if (!next) throw new Error(`无法保存节点名称：节点 ${id} 缺少有效默认策略。`);
            if (patch.name === null) {
                delete next.name;
            } else {
                const name = sanitizeNodeName(patch.name);
                if (!name) throw new Error(`无法保存节点名称：节点 ${id} 的名称无效。`);
                next.name = name;
            }
            const safe = safeNodeOverride(next, id);
            if (safe) {
                current[id] = safe;
                persisted.push(safe);
            } else {
                delete current[id];
            }
        }
        if (Object.keys(current).length) stored[fileKey] = current;
        else delete stored[fileKey];
        await Editor.Profile.setProject(packageJSON.name, 'nodeOverrides', stored, 'project');
        return persisted;
    });
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
    prepared: ReadonlySet<string> = new Set(),
): { png: FigmaNode[]; tiled: TiledAssetRequest[]; rawImages: RawImageAssetRequest[]; gradients: FigmaNode[] } {
    const png: FigmaNode[] = [];
    const tiled: TiledAssetRequest[] = [];
    const rawImages: RawImageAssetRequest[] = [];
    const gradients: FigmaNode[] = [];
    const visit = (node: FigmaNode, ancestorsVisible: boolean) => {
        if (prepared.has(node.id)) return;
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore' || decision.action === 'transform') {
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
                // The same plain IMAGE source and centered crop path serve both
                // visibility states; whole-node exports can bake different alpha.
                const imageRef = plainImageSourceRef(node);
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

export async function buildAssets(
    session: DocumentSession,
    decisions: Map<string, Decision>,
    importSettings: ImportSettings,
    review: ImportReviewRecorder,
    options: { regenerateNodeIds?: ReadonlySet<string> } = {},
): Promise<AssetBuildResult> {
    const hidden = hiddenLayerIds(session.roots, importSettings.importHiddenLayers !== false);
    const applyVisibility = (node: FigmaNode): void => {
        if (hidden.has(node.id)) decisions.set(node.id, {
            ...(decisions.get(node.id) ?? defaultDecision(node)), action: 'ignore', nineSlice: false,
        });
        node.children.forEach(applyVisibility);
    };
    session.roots.forEach(applyVisibility);
    const resolvedDecisions = resolveAutomaticMergeDecisions(session.roots, decisions);
    decisions.clear();
    resolvedDecisions.forEach((value, key) => decisions.set(key, value));
    const writeStates = new Map<string, boolean>();
    const writer = new AssetWriter(importSettings.assetFolder, async (url, existed) => {
        await review.beforeWrite(url, existed);
        writeStates.set(url, existed);
    });
    await writer.initialize();
    const cache = new LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    // Index existing names once; new resources are shared by name below.
    const outputPath = join(Editor.Project.path, 'assets', writer.folder);
    const outputResources = existsSync(outputPath) ? new LocalResourceLibrary(outputPath) : null;
    await outputResources?.initialize();
    const assets = new Map<string, SpriteAssetSpec>();
    // The project contract is same name = same resource. Share across render,
    // IMAGE and gradient paths before downloading or comparing any pixels.
    const sharedAssets = new Map<string, SpriteAssetSpec>();
    const resourceKey = (node: FigmaNode) => writer.buildUrl(node.name, '', 'png', importSettings.scale)
        .normalize('NFKC').toLocaleLowerCase('en-US');
    const warnings = new Set<string>();
    const note = (action: NonNullable<ImportReview['decisions']>[number]['action'], name: string, reason: string, url?: string) =>
        review.note?.(action, name, reason, url);
    const noteWrite = (asset: SpriteAssetSpec) => note(writeStates.get(asset.url) ? 'updated' : 'created',
        basename(asset.url), writeStates.get(asset.url)
            ? '写入同名输出资源，保留原 UUID'
            : '按名称导入一份资源，同名节点直接共用', asset.url);
    const nodeSourceKey = (node: FigmaNode, variant = 'raster-v2') =>
        JSON.stringify([session.fileKey, node.id, importSettings.scale, variant]);
    const groupSourceKey = (assetKey: string) => JSON.stringify([session.fileKey, 'tile-v2', assetKey]);
    const imageDetails = (node: FigmaNode) => {
        let leaf = node, innerOpacity = 1;
        while (leaf.children.length === 1) {
            leaf = leaf.children[0];
            innerOpacity *= leaf.opacity;
        }
        return { leaf, innerOpacity };
    };
    const findOutput = async (name: string) => {
        if (!importSettings.refreshAssets && outputResources) {
            const match = await outputResources.find(name, 'png');
            if (match) return { ...match, source: 'existing' as const };
        }
        return null;
    };
    const findLocal = async (name: string, includeOutput = true, nodeId?: string) => {
        // 组件同步：只有像素指纹判定为"图片已变化"的节点才跳过本地素材复用；
        // 没变化的节点继续引用项目里的同名素材，不生成重复图片。
        if (nodeId && options.regenerateNodeIds?.has(nodeId)) {
            return null;
        }
        for (const library of localResources) {
            const match = await library.find(name, 'png');
            // Directory order, extension preference and root-before-subfolder
            // ordering are the existing user-declared name mapping contract.
            if (match) return { ...match, source: 'local' as const };
        }
        return includeOutput ? findOutput(name) : null;
    };
    const prepareMask = async (node: FigmaNode): Promise<void> => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore' || decision.action === 'transform' || decision.nineSlice) return;
        const analysis = analyzeMaskTint(node);
        if (analysis && !subtreeHasExplicitOverride(node, decisions, false)) {
            decisions.set(node.id, { ...decision, action: 'render', kind: 'sprite', nineSlice: false });
            let reason = analysis.reason;
            if (analysis.candidate) {
                const { mask, tint } = analysis.candidate;
                const match = await findLocal(mask.name);
                const localUrl = match ? assetDatabaseUrl(match.path) : null;
                const asset = localUrl ? await writer.existing(localUrl)
                    : await writer.existingForSource(nodeSourceKey(mask), { tiled: false });
                // Verify the bytes of the referenced asset, never an unrelated
                // same-name file from a project-external library directory.
                const bytes = localUrl && asset ? match!.contents
                    : asset ? await readFile(join(Editor.Project.path, asset.url.slice('db://'.length))) : null;
                const verified = bytes ? verifyWhiteAlphaPng(bytes) : { valid: false, reason: '没有可验证的本地白色底图' };
                reason = verified.reason;
                if (asset && verified.valid) {
                    const tinted = { ...asset, tint };
                    assets.set(node.id, tinted);
                    review.bind(node, tinted, match?.source ?? 'existing');
                    note('tinted', node.name, `${analysis.reason}；${verified.reason}；沿用原 UUID 与九宫参数，透明度仅计算一次`, asset.url);
                    return;
                }
            }
            note('fallback', node.name, `${reason}；使用 Figma 完整蒙版合成，不修改共享底图`);
            return;
        }
        if (decision.action === 'render') return;
        for (const child of node.children) await prepareMask(child);
    };
    for (const root of session.roots) await prepareMask(root);
    const protectedDescendant = (node: FigmaNode): boolean => node.children.some((child) => {
        const childDecision = decisionForNode(child, decisions);
        if (childDecision.action === 'ignore') return false;
        return Boolean(child.isMask || child.children.some((part) => part.isMask)
            || assets.has(child.id) || childDecision.nineSlice || isNamedSliceGroup(child) || isPatchCandidate(child))
            || (childDecision.action !== 'render' && protectedDescendant(child));
    });
    await applyLocalParentPromotion(
        session.roots,
        decisions,
        async (node) => Boolean(await findLocal(node.name, false, node.id)),
        protectedDescendant,
        (nodeId) => assets.has(nodeId),
    );
    const finalDecisions = resolveAutomaticMergeDecisions(session.roots, decisions);
    decisions.clear();
    finalDecisions.forEach((value, key) => decisions.set(key, value));
    const plans = compileImportPlan(session.roots, decisions);
    const activeIds = new Set<string>();
    const activeBoundary = (node: FigmaNode) => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') return;
        activeIds.add(node.id);
        if (isTerminalAction(decision.action) || decision.nineSlice || assets.has(node.id)) return;
        node.children.forEach(activeBoundary);
    };
    session.roots.forEach(activeBoundary);
    for (const [id, plan] of plans) {
        if (!activeIds.has(id)) continue;
        const node = session.nodeById?.get(id);
        if (plan.reason === 'prefix-merge') note('merged', node?.name ?? id,
            plan.warning ?? 'icon_/img_ 最外层资源边界，按当前显隐合成，保留父节点几何与透明度');
        else if (plan.warning) {
            warnings.add(`${node?.name ?? id}：${plan.warning}`);
            note('fallback', node?.name ?? id, plan.warning);
        }
    }
    const requests = collectAssetRequests(session.roots, decisions, new Set(assets.keys()));
    const total = requests.png.length + requests.tiled.length
        + requests.rawImages.length + requests.gradients.length;
    let completed = 0;
    let apiPromise: Promise<FigmaClient> | null = null;

    const getApi = () => {
        apiPromise ??= diagnosticTask('准备 Figma 客户端', undefined, () => client());
        return apiPromise;
    };

    const completeAsset = (
        node: FigmaNode,
        asset: SpriteAssetSpec,
        source: 'existing' | 'local' | 'cache' | 'figma' | 'generated' = 'figma',
    ) => {
        assets.set(node.id, asset);
        review.bind(node, asset, source);
        if (source === 'local' || source === 'existing') note('reused', node.name,
            source === 'local' ? '用户指定本地目录的同名映射，保留原 SpriteFrame UUID 与切片参数'
                : '按已有资源或本批同名资源复用原 SpriteFrame，保留 UUID 与原切片参数', asset.url);
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
            assetKey: string;
        }
        interface PendingTile extends TileGroup {
            contents: Buffer | null;
            extension?: RasterImageExtension;
            sourceType: 'local' | 'cache' | 'figma';
            sourceRenderScale?: number;
        }
        const requestedScale = (source: TiledPaintSource) => importSettings.scale * source.scale;
        const renderScale = (source: TiledPaintSource) => source.kind === 'source-node'
            ? clampImageScale(requestedScale(source))
            : 1;
        const groups = new Map<string, TileGroup>();
        for (const { node, source } of items) {
            const sourceKey = JSON.stringify({
                fileKey: session.fileKey,
                kind: source.kind,
                id: source.id,
                paintScale: source.scale,
                renderScale: renderScale(source),
            });
            const assetKey = tiledRasterKey(sourceKey, requestedScale(source));
            const key = writer.buildTiledUrl(node.name, assetKey, 'png')
                .normalize('NFKC')
                .toLocaleLowerCase('en-US');
            const group = groups.get(key) ?? { node, nodes: [], source, sourceKey, assetKey };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const completeGroup = (
            groupedNodes: FigmaNode[],
            asset: SpriteAssetSpec,
            source: 'existing' | 'local' | 'cache' | 'figma',
        ) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        const pending: PendingTile[] = [];
        const namedLocalTiles = new Map<string, {
            match: Awaited<ReturnType<typeof findLocal>>;
            asset: SpriteAssetSpec | null;
        }>();
        for (const group of groups.values()) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            const nameKey = resourceKey(group.node);
            let local = namedLocalTiles.get(nameKey);
            if (!local) {
                const match = await findLocal(group.node.name, false, group.node.id);
                const localUrl = match ? assetDatabaseUrl(match.path) : null;
                const asset = localUrl ? await writer.existing(localUrl) : null;
                if (localUrl && !asset) throw new Error(`同名本地资源尚无可用 SpriteFrame，请先在 Cocos 中完成资源导入后重试，不会另建副本：${localUrl}`);
                local = { match, asset };
                namedLocalTiles.set(nameKey, local);
            }
            if (local.asset) {
                // Tiling and its period belong to this node, not the shared
                // SpriteFrame Meta. Keep the original UUID and pixels intact.
                completeGroup(group.nodes, { ...local.asset, sliced: false, tiled: true,
                    tileScale: requestedScale(group.source) }, 'local');
                continue;
            }
            if (local.match) {
                // An external bitmap has no project UUID. Import it through
                // the existing generated-tile path, with its unscaled pixels.
                pending.push({ ...group, contents: local.match.contents,
                    extension: detectImageExtension(local.match.contents), sourceType: 'local', sourceRenderScale: 1 });
                continue;
            }
            let existingAsset: SpriteAssetSpec | null = null;
            if (!importSettings.refreshAssets) {
                existingAsset = await writer.existingForSource(groupSourceKey(group.assetKey), { tiled: true });
            }
            if (existingAsset) {
                completeGroup(group.nodes, pixelSizedTileAsset(existingAsset), 'existing');
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
        const download = (url: string, nodeLabel: string) => {
            let task = downloads.get(url);
            if (!task) {
                task = getApi().then((api) => api.download(url, nodeLabel));
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
                contents = await download(remoteUrl, `${item.node.name} (${item.node.id})`);
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
            const trace = diagnosticStart('平铺资源按实际尺寸生成', { node: item.node.name });
            let raster: ReturnType<typeof rasterizeTile>;
            try { raster = rasterizeTile(contents, requestedScale(item.source), item.sourceRenderScale ?? renderScale(item.source)); }
            catch (error) {
                trace.fail(error);
                throw new Error(`平铺资源“${item.node.name}”无法按实际尺寸生成：${(error as Error).message}`);
            }
            if (raster.rounded) warnings.add(`平铺资源“${item.node.name}”的显示尺寸已取整为 ${raster.width}×${raster.height} 像素（最小 1），节点 Scale 保持 1。`);
            const url = writer.buildTiledUrl(item.node.name, item.assetKey, 'png');
            completeGroup(
                item.nodes,
                pixelSizedTileAsset(await writer.resolve(url, raster.contents, { sourceKey: groupSourceKey(item.assetKey), tiled: true })),
                item.sourceType,
            );
            trace.done({ sourceWidth: raster.sourceWidth, sourceHeight: raster.sourceHeight,
                width: raster.width, height: raster.height, tileScale: 1 });
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
            const key = resourceKey(node);
            const group = groups.get(key) ?? { url, nodes: [] };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const pending: Array<{
            node: FigmaNode;
            nodes: FigmaNode[];
            url: string;
            borders?: { left: number; right: number; top: number; bottom: number };
            sliceAnalysis?: SliceAnalysis;
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
            // A declared Figma slice owns this same-name resource even when an
            // ordinary PNG was encountered first. IMAGE and gradient stages
            // run later and share this single generated result.
            const slicedSources = groupedNodes.flatMap((candidate) => {
                if (decisionForNode(candidate, decisions).action === 'ignore') return [];
                const analysis = analyzeSliceGrid(candidate);
                return analysis ? [{ node: candidate, analysis }] : [];
            });
            const selectedSlice = slicedSources[0];
            const node = selectedSlice?.node ?? groupedNodes[0];
            const decision = decisions.get(node.id) ?? defaultDecision(node);
            const sliceAnalysis = selectedSlice?.analysis ?? (decision.nineSlice ? analyzeSliceGrid(node) : null);
            const reuseAsset = (asset: SpriteAssetSpec, source: 'local' | 'existing') => {
                sharedAssets.set(resourceKey(node), asset);
                if (decision.nineSlice && !asset.sliced) {
                    warnings.add(`三/九宫节点“${node.name}”已直接引用同名资源，但该 SpriteFrame 未配置九宫边距，暂按普通 Sprite 显示；请在原资源中设置边距：${asset.url}`);
                }
                completeGroup(groupedNodes, asset, source);
            };
            const shared = sliceAnalysis ? undefined : sharedAssets.get(resourceKey(node));
            if (shared) {
                reuseAsset(shared, 'existing');
                continue;
            }
            const localMatch = analyzeMaskTint(node) && !sliceAnalysis ? null : await findLocal(node.name, false, node.id);
            // An explicitly designated local SpriteFrame owns its pixels and
            // insets. Reuse it read-only, even when Figma defines a slice or
            // refresh is requested; source insets cannot be applied to an
            // unknown or already-compacted local canvas.
            const localUrl = localMatch
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                reuseAsset(localAsset, localMatch!.source);
                continue;
            }
            if (localUrl) {
                throw new Error(`同名本地资源尚无可用 SpriteFrame，请先在 Cocos 中完成资源导入并设置为 SpriteFrame 后重试，不会另建副本：${localUrl}`);
            }
            const namedOutput = !sliceAnalysis && !localMatch && !analyzeMaskTint(node) ? await findOutput(node.name) : null;
            if (namedOutput) {
                const namedAsset = await writer.existing(assetDatabaseUrl(namedOutput.path)!);
                if (!namedAsset) throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
                reuseAsset(namedAsset, 'existing');
                continue;
            }
            if (selectedSlice && !localMatch) {
                const shape = (entry: typeof selectedSlice) => JSON.stringify({ mode: entry.analysis.mode,
                    borders: entry.analysis.borders, frame: entry.node.absoluteBoundingBox && {
                        width: entry.node.absoluteBoundingBox.width, height: entry.node.absoluteBoundingBox.height,
                    } });
                if (slicedSources.slice(1).some((entry) => shape(entry) !== shape(selectedSlice))) {
                    const reason = `同名三/九宫定义不同，沿用首个有效 Figma 切片“${node.name}”的原始画布与边距，仅生成一份资源`;
                    warnings.add(reason);
                    note('merged', node.name, reason, url);
                }
                note('merged', node.name,
                    'Figma 三/九宫定义优先：使用 Figma 原始画布与边距生成输出资源，不沿用未指定输出资源的旧边距', url);
            }
            if (decision.nineSlice && !sliceAnalysis) {
                warnings.add(`三/九宫节点“${node.name}”无法计算连续切片边界，已临时作为 PNG 整层导入`);
            }
            const borders = sliceAnalysis?.borders;
            // New sliced assets retain their exact geometric canvas because
            // their generated borders use that coordinate space.
            const renderFrame = borders ? undefined : overflowingRenderFrame(node);
            const key: CacheEntryKey = {
                fileKey: session.fileKey,
                nodeId: node.id,
                format,
                scale: importSettings.scale,
                variant: renderFrame ? 'visual-overflow-v1' : undefined,
            };
            let cached = localMatch || importSettings.refreshAssets
                ? null
                : await cache.read(key);
            if (sliceAnalysis && cached) {
                const frame = node.absoluteBoundingBox!;
                const isFullCanvas = isPng(cached) && cached.length >= 24
                    && cached.toString('ascii', 12, 16) === 'IHDR'
                    && Math.abs(cached.readUInt32BE(16) - frame.width * importSettings.scale) <= 1
                    && Math.abs(cached.readUInt32BE(20) - frame.height * importSettings.scale) <= 1;
                if (!isFullCanvas) {
                    cached = null;
                    note('fallback', node.name, '缓存不是 Figma 完整画布，重新导出原始 PNG 后再应用三/九宫边距', url);
                }
            }
            pending.push({
                node,
                nodes: groupedNodes,
                url: localMatch && detectImageExtension(localMatch.contents) === 'jpg'
                    ? url.replace(/\.png$/i, '.jpg') : url,
                borders,
                sliceAnalysis: sliceAnalysis ?? undefined,
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
                Object.fromEntries(batch.map((item) => [item.node.id, item.node.name])),
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
                contents = await (await getApi()).download(remoteUrl, `${item.node.name} (${item.node.id})`);
                await cache.write(item.key, contents);
            }
            if (activeController?.signal.aborted) throw new CancelledError();
            let asset: SpriteAssetSpec;
            if (item.sliceAnalysis) {
                const trace = diagnosticStart('三/九宫资源最小化', { node: item.node.name });
                const result = await writeSlicedPng(writer, item.url, contents, item.node,
                    item.sliceAnalysis, importSettings.scale);
                asset = result.asset;
                trace.done(result.optimization);
                note(asset.sliceFallback ? 'fallback' : 'merged', item.node.name,
                    `三/九宫：${result.optimization.reason ?? result.optimization.status}`, asset.url);
            } else {
                asset = await writer.write(item.url, contents, item.borders);
            }
            noteWrite(asset);
            sharedAssets.set(resourceKey(item.node), asset);
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
            const key = resourceKey(item.node);
            const group = groups.get(key) ?? { node: item.node, nodes: [], imageRef: item.imageRef };
            group.nodes.push(item.node);
            groups.set(key, group);
        }

        let imageFillUrlsPromise: Promise<Record<string, string | null>> | undefined;
        const downloads = new Map<string, Promise<Buffer>>();
        const completeImages = (nodes: FigmaNode[], base: SpriteAssetSpec,
            source: 'local' | 'existing' | 'cache' | 'figma') => {
            sharedAssets.set(resourceKey(nodes[0]), base);
            for (const node of nodes) {
                const { innerOpacity } = imageDetails(node);
                const asset = innerOpacity < 1 ? { ...base, tint: { r: 1, g: 1, b: 1, a: innerOpacity } } : base;
                completeAsset(node, asset, source);
            }
        };
        for (const group of groups.values()) {
            if (activeController?.signal.aborted) throw new CancelledError();
            const shared = sharedAssets.get(resourceKey(group.node));
            if (shared) {
                completeImages(group.nodes, shared, 'existing');
                continue;
            }
            const { leaf } = imageDetails(group.node);
            const match = await findLocal(group.node.name, false, group.node.id);
            const localUrl = match ? assetDatabaseUrl(match.path) : null;
            if (localUrl) {
                const localAsset = await writer.existing(localUrl);
                if (!localAsset) throw new Error(`同名本地资源尚无可用 SpriteFrame，不会另建副本：${localUrl}`);
                completeImages(group.nodes, localAsset, match!.source);
                continue;
            }
            const namedOutput = !match ? await findOutput(group.node.name) : null;
            const existing = namedOutput ? await writer.existing(assetDatabaseUrl(namedOutput.path)!) : null;
            if (existing) {
                completeImages(group.nodes, existing, 'existing');
                continue;
            }
            if (namedOutput) throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
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
                    task = getApi().then((api) => api.download(remoteUrl, `${group.node.name} (${group.node.id})`));
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
            const fill = leaf.fills.find((paint) => paint.visible !== false && paint.type === 'IMAGE');
            const frame = nodeFrame(group.node);
            const raster = rasterizeImageFill(contents, fill?.scaleMode?.toUpperCase() === 'FIT' ? 'FIT' : 'FILL',
                frame.width, frame.height, importSettings.scale);
            if (activeController?.signal.aborted) throw new CancelledError();
            const url = writer.buildUrl(
                group.node.name,
                `${session.fileKey}:image-ref:${group.imageRef}`,
                'png',
                importSettings.scale,
            );
            const resolved = await writer.write(url, raster);
            noteWrite(resolved);
            if (group.node.children.length) note('merged', group.node.name,
                '普通 IMAGE 在隐藏和显示状态使用相同中心裁切/适配；源图缓存保留原始像素，节点透明度单独应用', resolved.url);
            completeImages(group.nodes, resolved, source);
        }
    };

    await diagnosticTask('准备平铺资源', { count: requests.tiled.length }, () => processTiled(requests.tiled));
    await diagnosticTask('准备 PNG 资源', { count: requests.png.length }, () => processRemote(requests.png));
    await diagnosticTask('准备原始 IMAGE 填充资源', { count: requests.rawImages.length }, () => processRawImages(requests.rawImages));

    for (const node of requests.gradients) {
        const shared = sharedAssets.get(resourceKey(node));
        if (shared) {
            completeAsset(node, shared, 'existing');
            continue;
        }
        const named = await findLocal(node.name, false, node.id);
        const namedUrl = named ? assetDatabaseUrl(named.path) : null;
        if (namedUrl) {
            const existing = await writer.existing(namedUrl);
            if (!existing) throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedUrl}`);
            sharedAssets.set(resourceKey(node), existing);
            completeAsset(node, existing, named!.source);
            continue;
        }
        const namedOutput = !named ? await findOutput(node.name) : null;
        if (namedOutput) {
            const existing = await writer.existing(assetDatabaseUrl(namedOutput.path)!);
            if (!existing) throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
            sharedAssets.set(resourceKey(node), existing);
            completeAsset(node, existing, 'existing');
            continue;
        }
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
            const asset = await writer.write(url, png);
            noteWrite(asset);
            sharedAssets.set(resourceKey(node), asset);
            completeAsset(node, asset, 'generated');
            continue;
        }
        completed += 1;
        emitProgress({
            phase: 'assets',
            value: total ? completed / total : 1,
            message: `生成渐变 ${completed}/${total} · ${node.name}`,
        });
    }
    for (const event of writer.events) note(event.action, basename(event.url), event.reason, event.url);
    return { assets, warnings: [...warnings] };
}

async function resolveFonts(settings: ImportSettings): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [family, url] of Object.entries(settings.fontMap)) {
        if (!url) continue;
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
    sync?: { fileKey: string },
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
    // 折叠到本节点的子层 id 与 aliasFigmaIds 一致；标记只记录聚合身份，
    // 不试图为折叠子层单独建节点。
    const syncMarker: SyncMarkerSpec | undefined = sync
        ? createSyncMarker({
            fileKey: sync.fileKey,
            node,
            aliasNodeIds: fold?.absorbedNodeIds ?? [],
        })
        : undefined;
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
        syncMarker,
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
                    sync,
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

async function waitForSyncMarkerScript(url: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', url) as {
            uuid?: string;
        } | null;
        if (typeof info?.uuid === 'string') {
            return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`等待 Cocos 导入组件同步标记脚本超时：${url}`);
}

/**
 * 组件同步需要在项目里有一个极小的标记组件脚本。首次导入时生成，
 * 之后每次导入校验；被其他脚本占用时 fail-closed，被截断或改旧时重建。
 */
async function ensureSyncMarkerScript(): Promise<{ action: string; reason?: string }> {
    const url = SYNC_MARKER_SCRIPT_URL;
    let existing: string | null = null;
    try {
        existing = await readFile(prefabDiskPath(url), 'utf8');
    } catch {
        existing = null;
    }
    const plan = planSyncMarkerScript(existing);
    if (plan.action === 'reject') {
        throw new Error(plan.reason);
    }
    if (plan.action === 'keep') {
        await waitForSyncMarkerScript(url);
        return { action: 'keep' };
    }
    const info = await Editor.Message.request('asset-db', 'query-asset-info', url) as {
        uuid?: string;
    } | null;
    if (!info) {
        const created = await Editor.Message.request('asset-db', 'create-asset', url, plan.content, {
            overwrite: false,
            rename: false,
        }) as { uuid?: string } | null;
        if (!created) {
            throw new Error(`无法创建组件同步标记脚本：${url}`);
        }
    } else {
        await Editor.Message.request('asset-db', 'save-asset', url, plan.content);
    }
    await waitForSyncMarkerScript(url);
    return {
        action: plan.action,
        reason: plan.action === 'rewrite' ? plan.reason : undefined,
    };
}

function collectSyncMarkerSpecs(specs: readonly SceneNodeSpec[]): SyncMarkerSpec[] {
    const markers: SyncMarkerSpec[] = [];
    const visit = (nodes: readonly SceneNodeSpec[]) => {
        for (const node of nodes) {
            if (node.syncMarker) {
                markers.push(node.syncMarker);
            }
            visit(node.children);
        }
    };
    visit(specs);
    return markers;
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
    reviewId: string;
    prefabUrl: string;
    prefabName: string;
    fileKey: string;
    sourceNodeId: string;
    rootFrame: Rect;
    scale: number;
    roots: SceneNodeSpec[];
    /** 未勾选的节点：保留它们在 Prefab 里的现有节点，不参与本次清理。 */
    skipSyncNodeIds?: ReadonlySet<string>;
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
    // 未勾选的节点在本次计划里不存在，但它们仍属于受管节点：把已知 fileId 传给
    // Scene 作为保留集合，避免"删除"分支把它们清掉。
    const retainNodeFileIds = args.skipSyncNodeIds?.size
        ? Object.values(resolveExistingNodeFileIds(prepared.record, args.skipSyncNodeIds))
        : [];
    const payload: SceneImportPayload = {
        reviewId: args.reviewId,
        packageName: packageJSON.name,
        fileKey: args.fileKey,
        rootName: args.prefabName,
        rootFrame: args.rootFrame,
        scale: args.scale,
        updateExisting: true,
        existingMap: {},
        prefabUrl: prepared.info.url,
        retainNodeFileIds,
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
        // 未勾选的节点不在本次重建结果里，保留它们原有的 fileId 映射。
        const retainedRecord = args.skipSyncNodeIds?.size
            ? retainPrefabSyncEntries(prepared.record, nextRecord, args.skipSyncNodeIds)
            : nextRecord;
        await setPendingPrefabSync(sourceHash, {
            prefabUuid: prepared.info.uuid,
            record: retainedRecord,
        });
        await assertOpenedPrefab(prepared.info.uuid, prepared.record.rootFileId);
        // Once the save request is sent its result is ambiguous until the
        // persisted Prefab is verified. Do not roll the in-memory Prefab back
        // on an IPC timeout: the disk write may already have completed.
        saveAttempted = true;
        await Editor.Message.request('scene', 'save-scene');
        await waitForSceneSaved();
        const currentInfo = await waitForPrefabAsset(prepared.info.url, prepared.info.uuid);
        if (!await storedPrefabMatchesRecord(currentInfo, retainedRecord)) {
            throw new Error('Prefab 文件未包含本次同步生成的全部 fileId，已停止更新 Meta。');
        }
        // 未勾选节点的组件（UITransform、标记等）仍属插件所有：从保存后的
        // Prefab 里读回它们的 fileId 并合并进记录，否则下次重新勾选会被归属校验拦下。
        let finalRecord = retainedRecord;
        if (args.skipSyncNodeIds?.size) {
            const skippedFileIds = Object.values(
                resolveExistingNodeFileIds(prepared.record, args.skipSyncNodeIds),
            );
            if (skippedFileIds.length) {
                const extras = collectPrefabComponentFileIds(
                    await readFile(prefabDiskPath(currentInfo.url)),
                    skippedFileIds,
                ).filter((fileId) => !retainedRecord.managedComponentFileIds.includes(fileId));
                if (extras.length) {
                    finalRecord = {
                        ...retainedRecord,
                        managedComponentFileIds: [
                            ...retainedRecord.managedComponentFileIds,
                            ...extras,
                        ].sort(),
                    };
                }
            }
        }
        const currentMeta = await queryPrefabMeta(currentInfo.uuid);
        const currentRecord = readPrefabSyncRecord(currentMeta);
        if (!currentRecord || currentRecord.sourceHash !== sourceHash) {
            throw new Error('Prefab 来源记录在保存期间发生变化，已拒绝提交。');
        }
        await setPendingPrefabSync(sourceHash, { prefabUuid: prepared.info.uuid, record: finalRecord });
        await writeVerifiedPrefabRecord(currentInfo, sourceHash, finalRecord);
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
            try { await Editor.Message.request('scene', 'snapshot-abort'); }
            catch {
                if (error instanceof Error) (error as Error & { requiresAttention?: boolean }).requiresAttention = true;
            }
        }
        if (saveAttempted && error instanceof Error) (error as Error & { requiresAttention?: boolean }).requiresAttention = true;
        throw error;
    }
}

/**
 * 组件同步预检：只读目标 Prefab 与当前 Figma 计划。
 * 不下载图片、不打开 Prefab、不写入任何文件，可在用户点击导入前反复调用。
 */
async function previewComponentSync(): Promise<SyncPreviewResult> {
    const document = activeDocument;
    if (!document) {
        throw new Error('请先读取 Figma 文件。');
    }
    if (!document.sourceNodeId || document.roots.length !== 1) {
        throw new Error('只有单个节点链接才能预览组件同步。');
    }
    const root = document.roots[0];
    const settings = await getSettings();
    // AssetWriter 构造函数只规范化目录，不会创建文件夹。
    const writer = new AssetWriter(settings.prefabFolder);
    const prefabUrl = `db://assets/${writer.folder}/${sanitizeAssetName(root.name)}.prefab`;
    const info = await queryPrefabAsset(prefabUrl);
    if (!info) {
        return { targetUrl: prefabUrl, exists: false, ...emptySyncPreviewSummary() };
    }
    const previous = readPrefabSyncMarkers(await readFile(prefabDiskPath(prefabUrl)));
    const overrides = await nodeOverridesFor(document.fileKey);
    const decisions = decisionMap(overrides, document.tree);
    // 与真实导入保持一致的第一步：本地同名素材命中时把父容器整体提升为整层。
    const localLibraries = settings.localResourceFolders
        .map((folder) => {
            try {
                return new LocalResourceLibrary(folder);
            } catch {
                return null;
            }
        })
        .filter((library): library is LocalResourceLibrary => library !== null);
    if (localLibraries.length) {
        await Promise.all(localLibraries.map((library) => library.initialize()));
        const protectedPreview = (node: FigmaNode): boolean => node.children.some((child) => {
            const childDecision = decisionForNode(child, decisions);
            if (childDecision.action === 'ignore') return false;
            return Boolean(child.isMask || child.children.some((part) => part.isMask)
                || childDecision.nineSlice || isNamedSliceGroup(child) || isPatchCandidate(child))
                || (childDecision.action !== 'render' && protectedPreview(child));
        });
        await applyLocalParentPromotion(
            document.roots,
            decisions,
            async (node) => {
                for (const library of localLibraries) {
                    if (await library.find(node.name, 'png')) {
                        return true;
                    }
                }
                return false;
            },
            protectedPreview,
        );
    }
    // 与真实导入保持一致的第二步：自动折叠/收口决定生效后再编译计划。
    const resolved = resolveAutomaticMergeDecisions(document.roots, decisions);
    decisions.clear();
    resolved.forEach((value, key) => decisions.set(key, value));
    const plans = compileImportPlan(document.roots, decisions);
    const rootFrame = nodeFrame(root);
    const specs = document.roots
        .map((node) => makeSpec(
            node,
            rootFrame,
            decisions,
            plans,
            document.nodeById,
            new Map(),
            new Map(),
            true,
            0,
            { fileKey: document.fileKey },
        ))
        .filter((spec): spec is SceneNodeSpec => spec !== null);
    return {
        targetUrl: prefabUrl,
        exists: true,
        prefabUuid: info.uuid,
        ...planSyncPreview(previous, specs, { scale: settings.scale }),
    };
}

async function performImport(request: ImportRequest, operationOwner: string | null = null, options: {
    document?: DocumentSession; preserveReviews?: boolean; silentReview?: boolean;
} = {}): Promise<SceneImportResult> {
    const document = options.document ?? activeDocument;
    if (!document) {
        throw new Error('请先读取 Figma 文件。');
    }
    const importSettings = safeSettings(request.settings);
    const controller = beginOperation(operationOwner);
    const trace = diagnosticStart('导入任务', { roots: document.roots.map((node) => ({ id: node.id, name: node.name })) });
    try {
        await saveSettings(importSettings);
        emitProgress({ phase: 'assets', value: 0, message: '分析并准备资源…' });
        const decisions = decisionMap(request.overrides, document.tree);
        // 改动清单里未勾选的节点：本次按"忽略"处理，既不更新也不创建；它们的旧标记
        // 不会被重写，因此下次导入仍会作为待更新项出现。
        const skipSyncNodeIds = new Set((request.skipSyncNodeIds ?? [])
            .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
            .map((id) => id.trim().replace(/-/g, ':')));
        for (const nodeId of skipSyncNodeIds) {
            decisions.set(nodeId, {
                action: 'ignore',
                kind: 'auto',
                nineSlice: false,
                explicit: true,
            });
        }
        const reviewDocument = document;
        importReviews.invalidate(options.preserveReviews ? { preserveHistory: true } : undefined);
        const reviewRecorder = new ImportReviewRecorder();
        // 组件同步（单节点 COMPONENT/INSTANCE 链接）：先用像素指纹算出哪些节点的
        // 图片内容确实变了，只有这些节点在资源准备阶段跳过本地同名素材复用。
        const syncMode = syncMarkersEnabled(document.sourceNodeId, document.roots.length);
        let regenerateNodeIds: ReadonlySet<string> | undefined;
        if (syncMode && importSettings.refreshAssets) {
            try {
                const prefabWriter = new AssetWriter(importSettings.prefabFolder);
                const prefabUrl = `db://assets/${prefabWriter.folder}/`
                    + `${sanitizeAssetName(document.roots[0].name)}.prefab`;
                if (await queryPrefabAsset(prefabUrl)) {
                    const previous = readPrefabSyncMarkers(await readFile(prefabDiskPath(prefabUrl)));
                    if (previous.size) {
                        const stale = new Set<string>();
                        const visit = (node: FigmaNode) => {
                            const before = previous.get(node.id.replace(/-/g, ':'));
                            const fresh = createSyncMarker({ fileKey: document.fileKey, node });
                            const pixelComparable = typeof before?.pixelHash === 'string'
                                && typeof fresh.pixelHash === 'string';
                            const changed = before
                                ? pixelComparable
                                    ? before.pixelHash !== fresh.pixelHash
                                    : before.subtreeHash !== fresh.subtreeHash
                                : true;
                            if (changed) stale.add(node.id);
                            node.children.forEach(visit);
                        };
                        document.roots.forEach(visit);
                        regenerateNodeIds = stale;
                    }
                }
            } catch {
                // 预检失败不阻断导入：退回"所有节点都按现有规则处理"。
                regenerateNodeIds = undefined;
            }
        }
        const builtAssets = await diagnosticTask('准备全部资源', undefined, () => buildAssets(
            document,
            decisions,
            importSettings,
            reviewRecorder,
            { regenerateNodeIds },
        ));
        const { assets, warnings } = builtAssets;
        if (controller.signal.aborted) throw new CancelledError();
        const attachReview = async (result: SceneImportResult) => {
            result.review = await finalizeImportReview(importReviews, reviewRecorder, reviewDocument,
                result.reviewBefore, result.reviewAfter, result.prefabUrl, warnings,
                async () => await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name, method: 'refreshReviewAfter', args: [{ id: reviewRecorder.id }],
                }) as ReviewScene);
            // Also cover manual imports whose panel was closed while importing.
            try {
                if (options.silentReview) {
                    delete result.reviewBefore;
                    delete result.reviewAfter;
                    return;
                }
                await Editor.Panel.open(packageJSON.name);
                Editor.Message.send(packageJSON.name, 'import-review-ready', result.review);
            } catch (error) {
                warnings.push(`结果已保存，但自动打开面板失败，请从插件中打开“导入结果检查”：${(error as Error).message}`);
            }
            delete result.reviewBefore;
            delete result.reviewAfter;
        };
        // buildAssets may promote a container to a local same-name resource.
        // Compile after that promotion so assets and SceneNodeSpec share the
        // exact same final plan.
        const plans = compileImportPlan(document.roots, decisions);
        const fonts = await resolveFonts(importSettings);
        const sourceRootFrames = document.roots.map(nodeFrame);
        const multipleRoots = document.roots.length > 1;
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
        // 组件级同步：只有单节点链接、且根节点确实是组件（或实例）时启用。
        // Frame 链接保持原有行为，不生成标记、不额外创建项目脚本。
        const syncContext = syncMode ? { fileKey: document.fileKey } : undefined;
        const roots = document.roots
            .map((node, index) => {
                const spec = makeSpec(
                    node,
                    rootFrame,
                    decisions,
                    plans,
                    document.nodeById,
                    assets,
                    fonts,
                    true,
                    0,
                    syncContext,
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
        if (syncContext) {
            try {
                assertUniqueSyncOwnership(collectSyncMarkerSpecs(roots));
            } catch (error) {
                warnings.push(error instanceof Error ? error.message : '同步标记所有权校验失败。');
            }
        }

        const sourceNodeId = document.sourceNodeId;
        if (sourceNodeId && roots.length === 1) {
            const prefabWriter = new AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = roots[0]?.name?.trim()
                || document.roots[0]?.name?.trim()
                || document.fileName;
            const prefabUrl = `db://assets/${prefabWriter.folder}/${sanitizeAssetName(frameName)}.prefab`;
            if (syncContext) {
                emitProgress({
                    phase: 'scene',
                    value: 0.02,
                    message: '正在准备组件同步标记脚本…',
                });
                const script = await ensureSyncMarkerScript();
                if (script.reason) {
                    warnings.push(script.reason);
                }
            }
            emitProgress({
                phase: 'scene',
                value: 0.05,
                message: '正在创建或打开目标 Prefab…',
            });
            const result = await importLinkedFramePrefab({
                reviewId: reviewRecorder.id,
                prefabUrl,
                prefabName: frameName,
                fileKey: document.fileKey,
                sourceNodeId,
                rootFrame,
                scale: importSettings.scale,
                roots,
                skipSyncNodeIds,
            });
            if (result.syncMarkerWarning) {
                warnings.push(`组件同步标记未写入：${result.syncMarkerWarning}`);
            }
            const nodeMaps = await getNodeMaps();
            // Prefab updates persist by PrefabInfo.fileId in the asset meta;
            // runtime node UUIDs are session-only and must never be reused here.
            delete nodeMaps[document.fileKey];
            await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
            await attachReview(result);
            const finalResult = warnings.length ? { ...result, warnings } : result;
            emitProgress({
                phase: 'done',
                value: 1,
                message: `完成：新建 ${result.created}，更新 ${result.updated}，已打开预制体 ${prefabUrl}${warnings.length ? `；${warnings.length} 条导入/收尾提示` : ''}`,
            });
            return finalResult;
        }

        const nodeMaps = await getNodeMaps();
        const payload: SceneImportPayload = {
            reviewId: reviewRecorder.id,
            packageName: packageJSON.name,
            fileKey: document.fileKey,
            rootName: document.fileName,
            rootFrame,
            scale: importSettings.scale,
            updateExisting: importSettings.updateExisting,
            existingMap: nodeMaps[document.fileKey] ?? {},
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: 'importDocument',
            args: [payload],
        }) as SceneImportResult;
        await Editor.Message.request('scene', 'snapshot');
        nodeMaps[document.fileKey] = result.nodeMap;
        await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
        Editor.Selection.select('node', result.rootUuid);
        if (importSettings.autoSave) {
            await Editor.Message.request('scene', 'save-scene');
        }
        await attachReview(result);
        const finalResult = warnings.length ? { ...result, warnings } : result;
        emitProgress({
            phase: 'done',
            value: 1,
            message: `完成：新建 ${result.created}，更新 ${result.updated}${warnings.length ? `；${warnings.length} 条导入/收尾提示` : ''}`,
        });
        trace.done();
        return finalResult;
    } catch (error) {
        trace.fail(error);
        if (error instanceof CancelledError || controller.signal.aborted) {
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
        finishOperation(controller);
        trace.event('后台任务已释放');
    }
}

async function getMcpPluginState() {
    await vault.initialize();
    const document = activeDocument;
    return {
        version: packageJSON.version,
        vault: vault.status(),
        settings: await getSettings(),
        document: document ? {
            fileKey: document.fileKey,
            fileName: document.fileName,
            sourceUrl: document.sourceUrl,
            tree: document.tree,
            fonts: document.fonts,
            nodeOverrides: await nodeOverridesFor(document.fileKey),
        } : null,
    };
}

async function getPluginState() {
    return {
        ...await getMcpPluginState(),
        fontAssets: await listFontAssets(),
    };
}

async function fetchFigmaDocument(sourceUrl: string) {
    const controller = beginOperation();
    try {
        emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取 Figma 文件…' });
        const parsed = parseFigmaSource(sourceUrl);
        const api = await client(controller.signal);
        const payload = parsed.nodeId
            ? await api.getNode(parsed.fileKey, parsed.nodeId)
            : await api.getFile(parsed.fileKey);
        const document = annotateDocumentPlan(
            parseDocument(payload, sourceUrl, parsed.fileKey, parsed.nodeId),
        );
        const current = await getSettings();
        await saveSettings({ ...current, sourceUrl });
        const fontAssets = await listFontAssets();
        const nodeOverrides = await nodeOverridesFor(document.fileKey);
        activeDocument = document;
        documentRevision += 1;
        emitProgress({ phase: 'idle', value: 1, message: `已读取 ${document.fileName}` });
        return {
            fileKey: document.fileKey,
            fileName: document.fileName,
            sourceUrl,
            tree: document.tree,
            fonts: document.fonts,
            fontAssets,
            nodeOverrides,
        };
    } catch (error) {
        emitProgress({
            phase: 'error',
            value: 0,
            message: error instanceof Error ? error.message : '读取失败。',
        });
        throw error;
    } finally {
        finishOperation(controller);
    }
}

async function batchDocumentDto(document: DocumentSession, fontAssets?: FontAssetOption[]): Promise<BatchDocumentDto> {
    return {
        fileKey: document.fileKey, fileName: document.fileName, sourceUrl: document.sourceUrl,
        tree: document.tree, fonts: document.fonts,
        fontAssets: fontAssets ?? await listFontAssets(),
        nodeOverrides: (await nodeOverridesFor(document.fileKey)).filter((item) => document.nodeById.has(item.id)),
    };
}

async function resolveBatchSource(sourceUrl: string): Promise<BatchSourceResult> {
    const parsed = parseFigmaSource(sourceUrl);
    if (!parsed.nodeId) {
        if (batchDocuments.size) throw new Error('整份文件请单独导入；请先移除批量界面列表，或使用 Section / Frame 链接。');
        const document = await fetchFigmaDocument(sourceUrl);
        return { sourceType: 'file', sourceUrl, items: [], added: 0, duplicates: 0, document };
    }
    const controller = beginOperation();
    try {
        emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取并识别 Section / Frame…' });
        const api = await client(controller.signal);
        const parsedDocument = parseDocument(await api.getNode(parsed.fileKey, parsed.nodeId),
            sourceUrl, parsed.fileKey, parsed.nodeId);
        const root = parsedDocument.roots[0];
        const fontAssets = await listFontAssets();
        if (root.type !== 'SECTION' && root.type !== 'FRAME') {
            if (batchDocuments.size) throw new Error('批量列表只接受 Section 或 Frame；其他节点请清空列表后单独导入。');
            const document = annotateDocumentPlan(parsedDocument);
            activeDocument = document;
            documentRevision += 1;
            await patchSettings({ sourceUrl });
            return { sourceType: 'node', sourceUrl, items: [], added: 0, duplicates: 0,
                document: await batchDocumentDto(document, fontAssets) };
        }
        const frames = collectSectionFrames(root);
        if (!frames.length) throw new Error('这个 Section 下没有可独立导入的外层 Frame 或 Component。');
        const prepared: Array<{ item: BatchFrameItem; document: DocumentSession }> = [];
        let duplicates = 0;
        for (const frame of frames) {
            const id = figmaFrameSourceHash(parsed.fileKey, frame.id);
            const existing = batchDocuments.get(id);
            if (existing) {
                duplicates += 1;
                prepared.push({ ...existing, item: { ...existing.item,
                    document: await batchDocumentDto(existing.document, fontAssets) } });
                continue;
            }
            const document = annotateDocumentPlan(frameDocument(parsedDocument, frame));
            const item: BatchFrameItem = {
                id, fileKey: document.fileKey, rootId: frame.id, sourceUrl: document.sourceUrl,
                name: frame.name, enabled: true,
                ...(root.type === 'SECTION' ? { sectionName: root.name } : {}),
                document: await batchDocumentDto(document, fontAssets),
            };
            prepared.push({ item, document });
        }
        const added = prepared.length - duplicates;
        if (batchDocuments.size + added > MAX_BATCH_ITEMS) throw new Error('本批最多添加 ' + MAX_BATCH_ITEMS + ' 个界面，请分批导入。');
        if (controller.signal.aborted) throw new CancelledError();
        for (const entry of prepared) batchDocuments.set(entry.item.id, entry);
        await patchSettings({ sourceUrl });
        emitProgress({ phase: 'idle', value: 1, message: '已添加 ' + added + ' 个界面'
            + (duplicates ? '，' + duplicates + ' 个已在列表' : '') + '。' });
        return { sourceType: root.type === 'SECTION' ? 'section' : 'frame', sourceUrl,
            items: prepared.map((entry) => entry.item), added, duplicates };
    } catch (error) {
        emitProgress({ phase: controller.signal.aborted ? 'cancelled' : 'error', value: 0,
            message: error instanceof Error ? error.message : '读取失败。' });
        throw error;
    } finally { finishOperation(controller); }
}

async function activateBatchItem(id: string): Promise<BatchDocumentDto> {
    const controller = beginOperation();
    try {
        const entry = batchDocuments.get(id);
        if (!entry) throw new Error('该界面已失效，请重新添加链接。');
        const document = await batchDocumentDto(entry.document);
        activeDocument = entry.document;
        documentRevision += 1;
        entry.item.document = document;
        return document;
    } finally { finishOperation(controller); }
}

function syncBatchItems(items: Array<{ id: string; enabled: boolean }>): { items: BatchFrameItem[] } {
    if (activeBatch || activeController) throw new Error('请等待当前任务完成后再修改界面列表。');
    if (!Array.isArray(items) || items.length > MAX_BATCH_ITEMS) throw new Error('批量界面列表无效。');
    const next = new Map<string, { item: BatchFrameItem; document: DocumentSession }>();
    for (const item of items) {
        const entry = item && batchDocuments.get(item.id);
        if (!entry || typeof item.enabled !== 'boolean' || next.has(item.id)) throw new Error('界面列表已过期或包含重复项，请重新读取。');
        next.set(item.id, { ...entry, item: { ...entry.item, enabled: item.enabled } });
    }
    batchDocuments.clear();
    for (const [id, entry] of next) batchDocuments.set(id, entry);
    return { items: [...batchDocuments.values()].map((entry) => entry.item) };
}

async function getBatchState(): Promise<BatchState> {
    if (activeBatch) return {
        items: [...batchDocuments.values()].map((entry) => entry.item),
        lastResult: lastBatchResult, running: batchProgress(activeBatch),
    };
    const fonts = await listFontAssets();
    const items: BatchFrameItem[] = [];
    for (const entry of batchDocuments.values()) {
        items.push({ ...entry.item, document: await batchDocumentDto(entry.document, fonts) });
    }
    return { items, lastResult: lastBatchResult, ...(activeBatch ? { running: batchProgress(activeBatch) } : {}) };
}

async function importBatch(request: BatchImportRequest): Promise<BatchImportResult> {
    if (activeBatch || activeController || applyingImportReview || roundtripController) throw new Error('当前已有操作正在执行，请等待完成。');
    if (!request || !Array.isArray(request.items) || !request.items.length || request.items.length > MAX_BATCH_ITEMS) {
        throw new Error('请至少选择一个有效的待导入界面。');
    }
    const settings = safeSettings(request.settings);
    const visibleItems = request.items.filter((item) => settings.importHiddenLayers
        || batchDocuments.get(item?.id)?.document.roots[0]?.visible !== false);
    if (!visibleItems.length) throw new Error('已关闭隐藏图层导入，所选界面均已隐藏；请选择可见界面或开启导入隐藏图层。');
    const entries = visibleItems.map((item) => {
        const entry = item && batchDocuments.get(item.id);
        if (!entry || !entry.item.enabled || !Array.isArray(item.overrides)) throw new Error('待导入界面已失效或未勾选，请重新读取。');
        const overrides = item.overrides.map((override) => ({ ...override }));
        const root = entry.document.roots[0];
        const decisions = decisionMap(overrides, entry.document.tree);
        if (decisions.get(root.id)?.action === 'ignore') throw new Error('“' + entry.item.name + '”根节点已忽略，请取消该界面勾选或恢复根节点策略。');
        const name = decisions.get(root.id)?.name || root.name;
        return { ...entry, overrides, name };
    });
    assertBatchTargets(entries.map((entry) => ({ id: entry.item.id, name: entry.name })));
    const run: BatchRun = {
        id: randomBytes(18).toString('hex'), index: 0, stopRequested: false,
        items: entries.map((entry) => ({ id: entry.item.id, name: entry.name,
            sourceUrl: entry.item.sourceUrl, status: 'pending' })),
    };
    activeBatch = run;
    for (const entry of entries) entry.item.document.nodeOverrides = entry.overrides;
    const previousDocument = activeDocument;
    const previousResult = request.preserveResults ? lastBatchResult : undefined;
    const completedResult = (): BatchImportResult => {
        const merged = new Map<string, BatchImportItemResult>();
        for (const item of previousResult?.items ?? []) {
            if (batchDocuments.has(item.id)) merged.set(item.id, { ...item });
        }
        for (const item of run.items) merged.set(item.id, { ...item });
        const items = [...merged.values()];
        return { id: run.id, items, stopped: run.stopRequested,
            completed: items.filter((item) => item.status === 'success' || item.status === 'failed').length,
            total: items.length };
    };
    try {
        // Check every destination before the first image/prefab write.
        const folder = new AssetWriter(settings.prefabFolder).folder;
        const bindings = await getPrefabBindings();
        for (const entry of entries) {
            const url = 'db://assets/' + folder + '/' + sanitizeAssetName(entry.name) + '.prefab';
            const info = await queryPrefabAsset(url);
            if (!info) continue;
            const record = readPrefabSyncRecord(await queryPrefabMeta(info.uuid));
            if (!record || record.sourceHash !== entry.item.id
                || (bindings[entry.item.id] && bindings[entry.item.id] !== info.uuid)) {
                throw new Error('“' + entry.name + '”的 Prefab 路径已被其他来源占用，请改名或调整输出目录。');
            }
        }
        if (run.stopRequested) {
            const result = completedResult();
            lastBatchResult = result;
            emitProgress({ phase: 'cancelled', value: 0, message: '已停止，尚未开始任何界面。', batch: { ...batchProgress(run), result } });
            return result;
        }
        importReviews.invalidate(request.preserveResults ? { preserveHistory: true } : undefined);
        for (let index = 0; index < entries.length; index++) {
            if (run.stopRequested) break;
            run.index = index;
            const entry = entries[index];
            const row = run.items[index];
            row.status = 'running';
            activeDocument = entry.document;
            documentRevision += 1;
            emitProgress({ phase: 'assets', value: 0, message: '正在导入 ' + (index + 1) + '/' + entries.length + '：' + entry.name });
            try {
                const result = await performImport({ overrides: entry.overrides,
                    settings: { ...settings, sourceUrl: entry.item.sourceUrl } }, run.id,
                { document: entry.document, preserveReviews: true, silentReview: true });
                Object.assign(row, { status: 'success', prefabUrl: result.prefabUrl,
                    created: result.created, updated: result.updated, warnings: result.warnings,
                    reviewId: result.review?.id });
                row.status = 'success';
            } catch (error) {
                let unsafe = Boolean((error as { requiresAttention?: boolean })?.requiresAttention);
                try { if (await Editor.Message.request('scene', 'query-dirty')) unsafe = true; }
                catch { unsafe = true; }
                row.status = 'failed';
                row.error = error instanceof Error ? error.message : '导入失败。';
                if (unsafe) {
                    row.requiresAttention = true;
                    row.error += ' 当前编辑或保存状态需要检查，已暂停后续界面；确认目标和保存状态后再重试。';
                }
                if (unsafe || request.failurePolicy === 'stop') run.stopRequested = true;
            }
            emitProgress({ phase: 'scene', value: 1,
                message: entry.name + '：' + (row.status === 'success' ? '已保存' : '失败') });
        }
        const result = completedResult();
        lastBatchResult = result;
        emitProgress({ phase: 'done', value: 1, message: result.stopped ? '本批已停止，已完成项保留。' : '本批导入结束。',
            batch: { ...batchProgress(run), result } });
        return result;
    } finally {
        if (activeBatch === run) activeBatch = null;
        activeDocument = previousDocument;
        documentRevision += 1;
    }
}

function stopImportBatch(): { accepted: boolean } {
    if (!activeBatch) return { accepted: false };
    activeBatch.stopRequested = true;
    emitProgress({ phase: 'scene', value: 0, message: '当前界面完成保存后停止，后续界面不会开始。' });
    return { accepted: true };
}

async function getNodePreview(nodeId: string): Promise<{ url: string }> {
    const document = activeDocument;
    const node = document?.nodeById.get(nodeId);
    if (!document || !node) {
        throw new Error('预览节点不存在。');
    }
    const controller = beginOperation();
    try {
        const urls = await (await client(controller.signal)).getImageUrls(
            document.fileKey,
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
        finishOperation(controller);
    }
}

export const methods: Record<string, (...args: any[]) => any> = {
    getImportReview(id?: string) { return importReviews.get(id); },
    resolveBatchSource,
    activateBatchItem,
    syncBatchItems,
    getBatchState,
    importBatch,
    stopImportBatch,
    async getImportReviewPreview(id: string, assetId: string) { return importReviews.preview(id, assetId); },
    async applyImportReview(id: string, removedIds: unknown) {
        if (activeController) throw new Error('请等待当前导入或 Figma 预览完成。');
        const controller = beginOperation();
        applyingImportReview = true;
        try { return await importReviews.apply(id, removedIds); }
        finally { applyingImportReview = false; finishOperation(controller); }
    },
    async getImportReviewSourcePreview(id: string, assetId: string, nodeId: string) {
        if (activeController) throw new Error('请等待当前操作完成后再加载来源预览。');
        const { fileKey, node } = importReviews.source(id, assetId, nodeId);
        const controller = beginOperation();
        try {
            const api = await client();
            const imageRef = plainImageSourceRef(node);
            if (imageRef) {
                const fills = await api.getImageFillUrls(fileKey);
                if (fills[imageRef]) return { url: fills[imageRef], note: 'Figma 原图（未合成节点效果）' };
            }
            const urls = await api.getImageUrls(fileKey, [node.id], 'png', 1, !overflowingRenderFrame(node));
            if (!urls[node.id]) throw new Error('Figma 未返回预览，隐藏或复杂效果节点可能无法单独渲染。');
            return { url: urls[node.id], note: 'Figma 当前节点渲染（隐藏祖先可能使预览透明）' };
        } finally { finishOperation(controller); }
    },
    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    async getState() {
        return getPluginState();
    },

    async setToken(value: string) {
        return vault.set(value);
    },

    async clearToken() {
        return vault.clear();
    },

    async verifyToken() {
        const controller = beginOperation();
        try {
            const identity = await (await client(controller.signal)).verify();
            return {
                ok: true,
                handle: identity.handle || 'Figma User',
            };
        } finally {
            finishOperation(controller);
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
        return fetchFigmaDocument(sourceUrl);
    },

    async getPreview(nodeId: string) {
        return getNodePreview(nodeId);
    },

    async syncPreview() {
        return previewComponentSync();
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
        if (activeBatch) return stopImportBatch();
        activeController?.abort();
    },
};

async function startMcpBridge(): Promise<void> {
    const previous = mcpBridge;
    mcpBridge = null;
    mcpApi = null;
    if (previous) await previous.close();

    const creatorVersion = (Editor.App as unknown as { version?: string }).version ?? 'unknown';
    const api = new FigmaImporterMcpApi({
        projectPath: Editor.Project.path,
        creatorVersion,
        getDocumentRevision: () => documentRevision,
        isImportBusy: () => activeBatch !== null || activeController !== null || roundtripController !== null,
        getState: getMcpPluginState,
        fetchDocument: fetchFigmaDocument,
        getPreview: getNodePreview,
        syncPreview: () => previewComponentSync(),
        saveSettings,
        patchSettings,
        saveNodeOverrides,
        patchNodeNames,
        importSelection: (request, operationId) => performImport(request, operationId),
        cancelImport: (operationId) => {
            if (!activeController || activeOperationOwner !== operationId) return false;
            activeController.abort();
            return true;
        },
    });
    const bridge = new McpBridgeServer({
        projectPath: Editor.Project.path,
        pluginVersion: packageJSON.version,
        pluginInstanceId,
        invoke: (method, params, signal) => api.invoke(method, params, signal),
    });
    try {
        await bridge.start();
        mcpApi = api;
        mcpBridge = bridge;
    } catch (error) {
        await bridge.close().catch(() => undefined);
        console.error(`Figma Importer MCP Bridge 启动失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
}

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
    await startMcpBridge();
}

export function unload(): void {
    if (activeBatch) activeBatch.stopRequested = true;
    batchDocuments.clear();
    lastBatchResult = undefined;
    importReviews.invalidate();
    activeController?.abort();
    activeController = null;
    activeOperationOwner = null;
    activeDocument = null;
    documentRevision += 1;
    const bridge = mcpBridge;
    mcpBridge = null;
    mcpApi = null;
    void bridge?.close().catch((error) => {
        console.error(`Figma Importer MCP Bridge 关闭失败：${error instanceof Error ? error.message : '未知错误'}`);
    });
}
