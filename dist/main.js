"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.overflowingRenderFrame = overflowingRenderFrame;
exports.decisionMap = decisionMap;
exports.subtreeHasExplicitOverride = subtreeHasExplicitOverride;
exports.patchNodeNames = patchNodeNames;
exports.buildAssets = buildAssets;
exports.makeSpec = makeSpec;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const diagnostics_1 = require("./diagnostics");
const promises_1 = require("fs/promises");
const package_json_1 = __importDefault(require("../package.json"));
const client_1 = require("./figma/client");
const analyzer_1 = require("./figma/analyzer");
const parser_1 = require("./figma/parser");
const import_planner_1 = require("./figma/import-planner");
const mask_tint_1 = require("./figma/mask-tint");
const slicing_1 = require("./figma/slicing");
const url_1 = require("./figma/url");
const import_actions_1 = require("./import-actions");
const assets_1 = require("./importer/assets");
const cache_1 = require("./importer/cache");
const local_resources_1 = require("./importer/local-resources");
const svg_1 = require("./importer/svg");
const sliced_png_1 = require("./importer/sliced-png");
const raster_format_1 = require("./importer/raster-format");
const tiled_png_1 = require("./importer/tiled-png");
const image_fill_1 = require("./importer/image-fill");
const prefab_sync_1 = require("./importer/prefab-sync");
const token_vault_1 = require("./security/token-vault");
const mcp_api_1 = require("./mcp-api");
const server_1 = require("./mcp-bridge/server");
const service_1 = require("./roundtrip/service");
const recovery_1 = require("./roundtrip/recovery");
const transaction_1 = require("./roundtrip/transaction");
const types_1 = require("./types");
const node_name_1 = require("./node-name");
const import_review_1 = require("./importer/import-review");
const import_review_finalize_1 = require("./importer/import-review-finalize");
const batch_import_1 = require("./batch-import");
const vault = new token_vault_1.TokenVault(package_json_1.default.name);
const importReviews = new import_review_1.ImportReviewService();
let applyingImportReview = false;
let activeDocument = null;
let activeController = null;
let activeOperationOwner = null;
let roundtripController = null;
let settingsCache = null;
let roundtripRecoveryBlocker = null;
let documentRevision = 0;
let mcpBridge = null;
let mcpApi = null;
const pluginInstanceId = (0, crypto_1.randomBytes)(18).toString('base64url');
let nodeOverrideWriteQueue = Promise.resolve();
let settingsWriteQueue = Promise.resolve();
const MAX_BATCH_ITEMS = 100;
const batchDocuments = new Map();
let activeBatch = null;
let lastBatchResult;
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.fnt', '.woff', '.woff2']);
const NODE_KINDS = new Set([
    'auto',
    'node',
    'sprite',
    'label',
    'richText',
    'button',
    'scrollView',
    'layout',
]);
async function listFontAssets() {
    const assetsRoot = (0, path_1.resolve)(Editor.Project.path, 'assets');
    const fonts = [];
    async function visit(folder) {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(folder, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp') {
                continue;
            }
            const filePath = (0, path_1.join)(folder, entry.name);
            if (entry.isDirectory()) {
                await visit(filePath);
                continue;
            }
            if (!FONT_EXTENSIONS.has((0, path_1.extname)(entry.name).toLowerCase())) {
                continue;
            }
            const path = (0, path_1.relative)(assetsRoot, filePath).replace(/\\/g, '/');
            fonts.push({
                name: (0, path_1.basename)(entry.name, (0, path_1.extname)(entry.name)),
                url: `db://assets/${path}`,
                relativePath: path,
            });
        }
    }
    await visit(assetsRoot);
    return fonts.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}
function emitProgress(progress) {
    Editor.Message.send(package_json_1.default.name, 'progress', {
        ...progress,
        ...(activeBatch && !progress.batch ? { batch: batchProgress(activeBatch) } : {}),
    });
}
function batchProgress(run) {
    var _a, _b;
    const current = run.items[Math.min(run.index, run.items.length - 1)];
    return {
        batchId: run.id, itemId: (_a = current === null || current === void 0 ? void 0 : current.id) !== null && _a !== void 0 ? _a : '', name: (_b = current === null || current === void 0 ? void 0 : current.name) !== null && _b !== void 0 ? _b : '',
        index: Math.min(run.index + 1, run.items.length), total: run.items.length,
        completed: run.items.filter((item) => item.status === 'success' || item.status === 'failed').length,
        stopRequested: run.stopRequested,
        items: run.items.map((item) => ({ ...item })),
    };
}
function defaultCacheFolder() {
    return (0, path_1.join)(Editor.Project.tmpDir, package_json_1.default.name, 'asset-cache');
}
function safeSettings(value) {
    var _a;
    const input = value && typeof value === 'object'
        ? value
        : {};
    const scale = typeof input.scale === 'number' && Number.isFinite(input.scale)
        ? Math.max(0.25, Math.min(4, input.scale))
        : types_1.DEFAULT_SETTINGS.scale;
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
        .filter((folder) => typeof folder === 'string')
        .map((folder) => folder.trim())
        .filter(Boolean)
        .filter((folder, index, folders) => folders.indexOf(folder) === index)
        .slice(0, 3);
    return {
        sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '',
        assetFolder: typeof input.assetFolder === 'string' && input.assetFolder.trim()
            ? input.assetFolder.trim()
            : types_1.DEFAULT_SETTINGS.assetFolder,
        prefabFolder: typeof input.prefabFolder === 'string' && input.prefabFolder.trim()
            ? input.prefabFolder.trim()
            : types_1.DEFAULT_SETTINGS.prefabFolder,
        localResourceFolders,
        localResourceFolder: (_a = localResourceFolders[0]) !== null && _a !== void 0 ? _a : '',
        scale,
        updateExisting: input.updateExisting !== false,
        refreshAssets: input.refreshAssets === true,
        autoSave: input.autoSave === true,
        fontMap,
    };
}
async function getSettingsUnlocked() {
    if (settingsCache) {
        return settingsCache;
    }
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'settings', 'project');
    settingsCache = safeSettings(saved);
    return settingsCache;
}
async function getSettings() {
    await settingsWriteQueue;
    return getSettingsUnlocked();
}
function withSettingsWriteLock(operation) {
    const result = settingsWriteQueue.then(operation);
    settingsWriteQueue = result.then(() => undefined, () => undefined);
    return result;
}
function persistSettingsUnlocked(value) {
    return (async () => {
        const next = safeSettings(value);
        await Editor.Profile.setProject(package_json_1.default.name, 'settings', next, 'project');
        settingsCache = next;
        return next;
    })();
}
function saveSettings(value) {
    return withSettingsWriteLock(() => persistSettingsUnlocked(value));
}
function patchSettings(value) {
    return withSettingsWriteLock(async () => {
        const current = await getSettingsUnlocked();
        return persistSettingsUnlocked({ ...current, ...value });
    });
}
async function client(signal = activeController === null || activeController === void 0 ? void 0 : activeController.signal) {
    return new client_1.FigmaClient(await vault.get(), signal);
}
async function roundtripService(signal) {
    var _a;
    const creatorVersion = (_a = Editor.App.version) !== null && _a !== void 0 ? _a : 'unknown';
    return new service_1.RoundtripService({
        client: await client(signal),
        projectRoot: Editor.Project.path,
        creatorVersion,
    });
}
function beginRoundtripOperation() {
    if (activeBatch || activeController || applyingImportReview)
        throw new Error('导入或结果调整正在执行，请等待完成后再操作 Round-trip。');
    roundtripController === null || roundtripController === void 0 ? void 0 : roundtripController.abort();
    const controller = new AbortController();
    roundtripController = controller;
    return controller;
}
function finishRoundtripOperation(controller) {
    if (roundtripController === controller)
        roundtripController = null;
}
function beginOperation(owner = null) {
    if (applyingImportReview)
        throw new Error('正在确认导入后的资源调整，请稍候。');
    if (roundtripController)
        throw new Error('Round-trip 操作正在执行，请等待完成或先取消。');
    if (activeBatch && owner !== activeBatch.id)
        throw new Error('批量导入正在执行，请等待完成或停止后续任务。');
    if (activeController) {
        throw new Error('当前已有 Figma 操作正在执行，请等待完成或先取消。');
    }
    const controller = new AbortController();
    activeController = controller;
    activeOperationOwner = owner;
    return controller;
}
function finishOperation(controller) {
    if (activeController === controller) {
        activeController = null;
        activeOperationOwner = null;
    }
}
function relativeAssetFolder(selectedPath) {
    const assetsRoot = (0, path_1.resolve)(Editor.Project.path, 'assets');
    const selected = (0, path_1.resolve)(selectedPath);
    const folder = (0, path_1.relative)(assetsRoot, selected);
    if (!folder || folder === '.' || folder.startsWith('..') || (0, path_1.isAbsolute)(folder)) {
        throw new Error('资源输出目录必须是项目 assets 下的子文件夹。');
    }
    return folder.replace(/\\/g, '/');
}
function assetDatabaseUrl(filePath) {
    const assetsRoot = (0, path_1.resolve)(Editor.Project.path, 'assets');
    const selected = (0, path_1.resolve)(filePath);
    const path = (0, path_1.relative)(assetsRoot, selected);
    const outside = path === '..'
        || path.startsWith('../')
        || path.startsWith('..\\')
        || (0, path_1.isAbsolute)(path);
    if (!path || path === '.' || outside) {
        return null;
    }
    return `db://assets/${path.replace(/\\/g, '/')}`;
}
async function pickAssetFolder(current) {
    const assetsRoot = (0, path_1.resolve)(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? (0, path_1.resolve)(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = (0, fs_1.existsSync)(preferredPath) ? preferredPath : assetsRoot;
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
        absolutePath: (0, path_1.resolve)(selected),
    };
}
async function pickPrefabFolder(current) {
    const assetsRoot = (0, path_1.resolve)(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? (0, path_1.resolve)(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = (0, fs_1.existsSync)(preferredPath) ? preferredPath : assetsRoot;
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
        absolutePath: (0, path_1.resolve)(selected),
    };
}
async function pickLocalResourceFolder(current, _index = 0) {
    const currentFolder = typeof current === 'string' ? current.trim() : '';
    const initialPath = currentFolder && (0, path_1.isAbsolute)(currentFolder)
        ? currentFolder
        : (0, path_1.resolve)(Editor.Project.path, 'assets');
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
    const library = new local_resources_1.LocalResourceLibrary(selected);
    return { folder: library.root };
}
function unionFrame(nodes) {
    const frames = nodes.map(nodeFrame).filter((value) => Boolean(value));
    if (!frames.length) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    const x = Math.min(...frames.map((frame) => frame.x));
    const y = Math.min(...frames.map((frame) => frame.y));
    const right = Math.max(...frames.map((frame) => frame.x + frame.width));
    const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
    return { x, y, width: right - x, height: bottom - y };
}
function nodeFrame(node) {
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
function overflowingRenderFrame(node) {
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
function cornerRadii(node) {
    var _a, _b;
    if (((_a = node.rectangleCornerRadii) === null || _a === void 0 ? void 0 : _a.length) === 4) {
        return node.rectangleCornerRadii;
    }
    const radius = (_b = node.cornerRadius) !== null && _b !== void 0 ? _b : 0;
    return [radius, radius, radius, radius];
}
function defaultDecision(node) {
    return {
        action: (0, analyzer_1.inferAction)(node),
        kind: (0, analyzer_1.inferKind)(node),
        nineSlice: (0, analyzer_1.isPatchCandidate)(node),
        explicit: false,
    };
}
function decisionForNode(node, decisions) {
    var _a;
    const decision = (_a = decisions.get(node.id)) !== null && _a !== void 0 ? _a : defaultDecision(node);
    if (node.type === 'TEXT' && decision.action !== 'ignore') {
        return { ...decision, action: 'generate', nineSlice: false };
    }
    if ((0, analyzer_1.isVectorNode)(node) && decision.action !== 'ignore') {
        return { ...decision, action: 'render', nineSlice: false };
    }
    return decision;
}
function decisionMap(overrides, tree) {
    const decisions = new Map();
    const figmaSlices = new Set();
    const addDefaults = (nodes) => {
        for (const node of nodes) {
            if (node.patchCandidate)
                figmaSlices.add(node.id);
            decisions.set(node.id, (0, import_planner_1.normalizeFigmaSliceDecision)({
                action: (0, import_actions_1.normalizeImportAction)(node.action),
                kind: node.kind,
                nineSlice: node.patchCandidate,
                explicit: false,
            }, Boolean(node.patchCandidate)));
            addDefaults(node.children);
        }
    };
    addDefaults(tree);
    for (const item of overrides !== null && overrides !== void 0 ? overrides : []) {
        const name = (0, node_name_1.sanitizeNodeName)(item.name);
        decisions.set(item.id, (0, import_planner_1.normalizeFigmaSliceDecision)({
            action: (0, import_actions_1.normalizeImportAction)(item.action),
            kind: NODE_KINDS.has(item.kind) ? item.kind : 'auto',
            nineSlice: item.nineSlice,
            explicit: item.explicit === true,
            ...(name ? { name } : {}),
        }, figmaSlices.has(item.id)));
    }
    return decisions;
}
function subtreeHasExplicitOverride(node, decisions, includeNodeName = true) {
    const decision = decisions.get(node.id);
    return (decision === null || decision === void 0 ? void 0 : decision.explicit) === true
        || (includeNodeName && Boolean(decision === null || decision === void 0 ? void 0 : decision.name))
        || node.children.some((child) => subtreeHasExplicitOverride(child, decisions));
}
async function getStoredNodeOverrides() {
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'nodeOverrides', 'project');
    return saved && typeof saved === 'object' ? saved : {};
}
function safeNodeOverride(value, fallbackId = '') {
    if (!value || typeof value !== 'object')
        return null;
    const item = value;
    const id = typeof item.id === 'string' && item.id ? item.id : fallbackId;
    if (!id)
        return null;
    const kind = typeof item.kind === 'string' && NODE_KINDS.has(item.kind)
        ? item.kind
        : 'auto';
    const explicit = item.explicit === false ? false : true;
    const name = (0, node_name_1.sanitizeNodeName)(item.name);
    if (!explicit && !name)
        return null;
    return {
        id,
        action: (0, import_actions_1.normalizeImportAction)(item.action),
        kind,
        nineSlice: item.nineSlice === true,
        explicit,
        ...(name ? { name } : {}),
    };
}
async function nodeOverridesFor(fileKey) {
    var _a;
    const stored = (_a = (await getStoredNodeOverrides())[fileKey]) !== null && _a !== void 0 ? _a : {};
    const result = [];
    for (const [id, value] of Object.entries(stored)) {
        const safe = safeNodeOverride(value, id);
        if (safe)
            result.push(safe);
    }
    return result;
}
function withNodeOverrideWriteLock(operation) {
    const result = nodeOverrideWriteQueue.then(operation);
    nodeOverrideWriteQueue = result.then(() => undefined, () => undefined);
    return result;
}
async function saveNodeOverridesUnlocked(fileKey, values, scopeValues) {
    var _a;
    if (typeof fileKey !== 'string' || !fileKey.trim()) {
        throw new Error('无法保存节点策略：缺少 Figma fileKey。');
    }
    const items = Array.isArray(values) ? values : [];
    const safeItems = items
        .map((item) => safeNodeOverride(item))
        .filter((item) => Boolean(item));
    const scopeIds = new Set((Array.isArray(scopeValues) ? scopeValues : safeItems.map((item) => item.id))
        .filter((id) => typeof id === 'string' && Boolean(id)));
    if (!scopeIds.size) {
        throw new Error('无法保存节点策略：缺少当前导入范围。');
    }
    const scopedItems = safeItems.filter((item) => scopeIds.has(item.id));
    const stored = await getStoredNodeOverrides();
    const current = { ...((_a = stored[fileKey]) !== null && _a !== void 0 ? _a : {}) };
    for (const id of scopeIds) {
        delete current[id];
    }
    for (const item of scopedItems) {
        current[item.id] = item;
    }
    if (Object.keys(current).length) {
        stored[fileKey] = current;
    }
    else {
        delete stored[fileKey];
    }
    await Editor.Profile.setProject(package_json_1.default.name, 'nodeOverrides', stored, 'project');
    return scopedItems;
}
function saveNodeOverrides(fileKey, values, scopeValues) {
    return withNodeOverrideWriteLock(() => saveNodeOverridesUnlocked(fileKey, values, scopeValues));
}
function patchNodeNames(fileKey, patches) {
    return withNodeOverrideWriteLock(async () => {
        var _a;
        if (!fileKey.trim())
            throw new Error('无法保存节点名称：缺少 Figma fileKey。');
        const stored = await getStoredNodeOverrides();
        const current = { ...((_a = stored[fileKey]) !== null && _a !== void 0 ? _a : {}) };
        const persisted = [];
        for (const patch of patches) {
            const id = typeof patch.id === 'string' ? patch.id.trim() : '';
            if (!id)
                throw new Error('无法保存节点名称：缺少 nodeId。');
            const existing = safeNodeOverride(current[id], id);
            const fallback = safeNodeOverride(patch.fallback, id);
            const next = existing ? { ...existing } : fallback ? { ...fallback } : null;
            if (!next && patch.name === null) {
                delete current[id];
                continue;
            }
            if (!next)
                throw new Error(`无法保存节点名称：节点 ${id} 缺少有效默认策略。`);
            if (patch.name === null) {
                delete next.name;
            }
            else {
                const name = (0, node_name_1.sanitizeNodeName)(patch.name);
                if (!name)
                    throw new Error(`无法保存节点名称：节点 ${id} 的名称无效。`);
                next.name = name;
            }
            const safe = safeNodeOverride(next, id);
            if (safe) {
                current[id] = safe;
                persisted.push(safe);
            }
            else {
                delete current[id];
            }
        }
        if (Object.keys(current).length)
            stored[fileKey] = current;
        else
            delete stored[fileKey];
        await Editor.Profile.setProject(package_json_1.default.name, 'nodeOverrides', stored, 'project');
        return persisted;
    });
}
function annotateDocumentPlan(session) {
    const defaults = decisionMap([], session.tree);
    session.tree = (0, import_planner_1.annotateTreeWithImportPlan)(session.tree, (0, import_planner_1.compileImportPlan)(session.roots, defaults));
    return session;
}
function collectAssetRequests(roots, decisions, prepared = new Set()) {
    const png = [];
    const tiled = [];
    const rawImages = [];
    const gradients = [];
    const visit = (node, ancestorsVisible) => {
        if (prepared.has(node.id))
            return;
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
            const source = (0, analyzer_1.nativeTiledPaintSource)(node);
            if (source) {
                tiled.push({ node, source });
            }
            else {
                // The same plain IMAGE source and centered crop path serve both
                // visibility states; whole-node exports can bake different alpha.
                const imageRef = (0, analyzer_1.plainImageSourceRef)(node);
                if (imageRef) {
                    rawImages.push({ node, imageRef });
                }
                else {
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
                }
                else {
                    png.push(node);
                }
            }
        }
        node.children.forEach((child) => visit(child, effectivelyVisible));
    };
    roots.forEach((root) => visit(root, true));
    return { png, tiled, rawImages, gradients };
}
async function buildAssets(session, decisions, importSettings, review) {
    var _a, _b, _c, _d, _e;
    const resolvedDecisions = (0, import_planner_1.resolveAutomaticMergeDecisions)(session.roots, decisions);
    decisions.clear();
    resolvedDecisions.forEach((value, key) => decisions.set(key, value));
    const writeStates = new Map();
    const writer = new assets_1.AssetWriter(importSettings.assetFolder, async (url, existed) => {
        await review.beforeWrite(url, existed);
        writeStates.set(url, existed);
    });
    await writer.initialize();
    const cache = new cache_1.LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new local_resources_1.LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    // Index existing names once; new resources are shared by name below.
    const outputPath = (0, path_1.join)(Editor.Project.path, 'assets', writer.folder);
    const outputResources = (0, fs_1.existsSync)(outputPath) ? new local_resources_1.LocalResourceLibrary(outputPath) : null;
    await (outputResources === null || outputResources === void 0 ? void 0 : outputResources.initialize());
    const assets = new Map();
    // The project contract is same name = same resource. Share across render,
    // IMAGE and gradient paths before downloading or comparing any pixels.
    const sharedAssets = new Map();
    const resourceKey = (node) => writer.buildUrl(node.name, '', 'png', importSettings.scale)
        .normalize('NFKC').toLocaleLowerCase('en-US');
    const warnings = new Set();
    const note = (action, name, reason, url) => { var _a; return (_a = review.note) === null || _a === void 0 ? void 0 : _a.call(review, action, name, reason, url); };
    const noteWrite = (asset) => note(writeStates.get(asset.url) ? 'updated' : 'created', (0, path_1.basename)(asset.url), writeStates.get(asset.url)
        ? '写入同名输出资源，保留原 UUID'
        : '按名称导入一份资源，同名节点直接共用', asset.url);
    const nodeSourceKey = (node, variant = 'raster-v2') => JSON.stringify([session.fileKey, node.id, importSettings.scale, variant]);
    const groupSourceKey = (assetKey) => JSON.stringify([session.fileKey, 'tile-v2', assetKey]);
    const imageDetails = (node) => {
        let leaf = node, innerOpacity = 1;
        while (leaf.children.length === 1) {
            leaf = leaf.children[0];
            innerOpacity *= leaf.opacity;
        }
        return { leaf, innerOpacity };
    };
    const findOutput = async (name) => {
        if (!importSettings.refreshAssets && outputResources) {
            const match = await outputResources.find(name, 'png');
            if (match)
                return { ...match, source: 'existing' };
        }
        return null;
    };
    const findLocal = async (name, includeOutput = true) => {
        for (const library of localResources) {
            const match = await library.find(name, 'png');
            // Directory order, extension preference and root-before-subfolder
            // ordering are the existing user-declared name mapping contract.
            if (match)
                return { ...match, source: 'local' };
        }
        return includeOutput ? findOutput(name) : null;
    };
    const prepareMask = async (node) => {
        var _a;
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore' || decision.action === 'transform' || decision.nineSlice)
            return;
        const analysis = (0, mask_tint_1.analyzeMaskTint)(node);
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
                const bytes = localUrl && asset ? match.contents
                    : asset ? await (0, promises_1.readFile)((0, path_1.join)(Editor.Project.path, asset.url.slice('db://'.length))) : null;
                const verified = bytes ? (0, mask_tint_1.verifyWhiteAlphaPng)(bytes) : { valid: false, reason: '没有可验证的本地白色底图' };
                reason = verified.reason;
                if (asset && verified.valid) {
                    const tinted = { ...asset, tint };
                    assets.set(node.id, tinted);
                    review.bind(node, tinted, (_a = match === null || match === void 0 ? void 0 : match.source) !== null && _a !== void 0 ? _a : 'existing');
                    note('tinted', node.name, `${analysis.reason}；${verified.reason}；沿用原 UUID 与九宫参数，透明度仅计算一次`, asset.url);
                    return;
                }
            }
            note('fallback', node.name, `${reason}；使用 Figma 完整蒙版合成，不修改共享底图`);
            return;
        }
        if (decision.action === 'render')
            return;
        for (const child of node.children)
            await prepareMask(child);
    };
    for (const root of session.roots)
        await prepareMask(root);
    const protectedDescendant = (node) => node.children.some((child) => {
        const childDecision = decisionForNode(child, decisions);
        if (childDecision.action === 'ignore')
            return false;
        return Boolean(child.isMask || child.children.some((part) => part.isMask)
            || assets.has(child.id) || childDecision.nineSlice || (0, analyzer_1.isNamedSliceGroup)(child) || (0, analyzer_1.isPatchCandidate)(child))
            || (childDecision.action !== 'render' && protectedDescendant(child));
    });
    const promoteLocalParents = async (node) => {
        if (assets.has(node.id) || (0, mask_tint_1.analyzeMaskTint)(node))
            return;
        const decision = decisionForNode(node, decisions);
        if (decision.action !== 'generate') {
            return;
        }
        if (node.children.length
            && node.type !== 'TEXT'
            && !decision.nineSlice
            // Renaming this container does not change resource matching; only
            // a strategy override on itself or any override below it blocks
            // promotion because descendants would otherwise disappear.
            && !subtreeHasExplicitOverride(node, decisions, false)
            // A same-name ancestor is not permission to erase independent slice
            // resources or a verified/fallback mask representation below it.
            && !protectedDescendant(node)
            // A local parent resource cannot represent independently inactive
            // descendants. Keep the hierarchy whenever such a boundary exists.
            && !(0, analyzer_1.hasHiddenDescendant)(node)) {
            const localMatch = await findLocal(node.name, false);
            if (localMatch) {
                decisions.set(node.id, { ...decision, action: 'render', nineSlice: false });
                return;
            }
        }
        await Promise.all(node.children.map(promoteLocalParents));
    };
    await Promise.all(session.roots.map(promoteLocalParents));
    const finalDecisions = (0, import_planner_1.resolveAutomaticMergeDecisions)(session.roots, decisions);
    decisions.clear();
    finalDecisions.forEach((value, key) => decisions.set(key, value));
    const plans = (0, import_planner_1.compileImportPlan)(session.roots, decisions);
    const activeIds = new Set();
    const activeBoundary = (node) => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore')
            return;
        activeIds.add(node.id);
        if ((0, import_actions_1.isTerminalAction)(decision.action) || decision.nineSlice || assets.has(node.id))
            return;
        node.children.forEach(activeBoundary);
    };
    session.roots.forEach(activeBoundary);
    for (const [id, plan] of plans) {
        if (!activeIds.has(id))
            continue;
        const node = (_a = session.nodeById) === null || _a === void 0 ? void 0 : _a.get(id);
        if (plan.reason === 'prefix-merge')
            note('merged', (_b = node === null || node === void 0 ? void 0 : node.name) !== null && _b !== void 0 ? _b : id, (_c = plan.warning) !== null && _c !== void 0 ? _c : 'icon_/img_ 最外层资源边界，按当前显隐合成，保留父节点几何与透明度');
        else if (plan.warning) {
            warnings.add(`${(_d = node === null || node === void 0 ? void 0 : node.name) !== null && _d !== void 0 ? _d : id}：${plan.warning}`);
            note('fallback', (_e = node === null || node === void 0 ? void 0 : node.name) !== null && _e !== void 0 ? _e : id, plan.warning);
        }
    }
    const requests = collectAssetRequests(session.roots, decisions, new Set(assets.keys()));
    const total = requests.png.length + requests.tiled.length
        + requests.rawImages.length + requests.gradients.length;
    let completed = 0;
    let apiPromise = null;
    const getApi = () => {
        apiPromise !== null && apiPromise !== void 0 ? apiPromise : (apiPromise = (0, diagnostics_1.diagnosticTask)('准备 Figma 客户端', undefined, () => client()));
        return apiPromise;
    };
    const completeAsset = (node, asset, source = 'figma') => {
        assets.set(node.id, asset);
        review.bind(node, asset, source);
        if (source === 'local' || source === 'existing')
            note('reused', node.name, source === 'local' ? '用户指定本地目录的同名映射，保留原 SpriteFrame UUID 与切片参数'
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
    const processTiled = async (items) => {
        var _a, _b;
        if (!items.length) {
            return;
        }
        const requestedScale = (source) => importSettings.scale * source.scale;
        const renderScale = (source) => source.kind === 'source-node'
            ? (0, client_1.clampImageScale)(requestedScale(source))
            : 1;
        const groups = new Map();
        for (const { node, source } of items) {
            const sourceKey = JSON.stringify({
                fileKey: session.fileKey,
                kind: source.kind,
                id: source.id,
                paintScale: source.scale,
                renderScale: renderScale(source),
            });
            const assetKey = (0, tiled_png_1.tiledRasterKey)(sourceKey, requestedScale(source));
            const key = writer.buildTiledUrl(node.name, assetKey, 'png')
                .normalize('NFKC')
                .toLocaleLowerCase('en-US');
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { node, nodes: [], source, sourceKey, assetKey };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const completeGroup = (groupedNodes, asset, source) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        const pending = [];
        for (const group of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
                throw new client_1.CancelledError();
            }
            let existingAsset = null;
            if (!importSettings.refreshAssets) {
                existingAsset = await writer.existingForSource(groupSourceKey(group.assetKey), { tiled: true });
            }
            if (existingAsset) {
                completeGroup(group.nodes, (0, tiled_png_1.pixelSizedTileAsset)(existingAsset), 'existing');
                continue;
            }
            let contents = null;
            let cachedExtension;
            if (!importSettings.refreshAssets) {
                const extensions = group.source.kind === 'source-node'
                    ? ['png']
                    : assets_1.RASTER_IMAGE_EXTENSIONS;
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
        const patternUrls = new Map();
        const patternsByScale = new Map();
        for (const item of remoteItems) {
            if (item.source.kind !== 'source-node') {
                continue;
            }
            const scale = renderScale(item.source);
            const ids = (_b = patternsByScale.get(scale)) !== null && _b !== void 0 ? _b : new Set();
            ids.add(item.source.id);
            patternsByScale.set(scale, ids);
        }
        for (const [scale, ids] of patternsByScale) {
            const urls = await (await getApi()).getImageUrls(session.fileKey, Array.from(ids), 'png', scale);
            for (const [id, url] of Object.entries(urls)) {
                patternUrls.set(`${id}:scale:${scale}`, url);
            }
        }
        const needsImageFills = remoteItems.some((item) => item.source.kind === 'image-ref');
        const imageFillUrls = needsImageFills
            ? await (await getApi()).getImageFillUrls(session.fileKey)
            : {};
        const downloads = new Map();
        const download = (url, nodeLabel) => {
            let task = downloads.get(url);
            if (!task) {
                task = getApi().then((api) => api.download(url, nodeLabel));
                downloads.set(url, task);
            }
            return task;
        };
        for (const item of pending) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
                throw new client_1.CancelledError();
            }
            let contents = item.contents;
            let extension = item.extension;
            if (!contents) {
                const remoteUrl = item.source.kind === 'source-node'
                    ? patternUrls.get(`${item.source.id}:scale:${renderScale(item.source)}`)
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
                    : (0, assets_1.detectImageExtension)(contents);
                await cache.write({
                    fileKey: session.fileKey,
                    nodeId: `tile:${item.sourceKey}`,
                    format: extension,
                    scale: renderScale(item.source),
                }, contents);
            }
            if (!extension) {
                extension = (0, assets_1.detectImageExtension)(contents);
            }
            const trace = (0, diagnostics_1.diagnosticStart)('平铺资源按实际尺寸生成', { node: item.node.name });
            let raster;
            try {
                raster = (0, tiled_png_1.rasterizeTile)(contents, requestedScale(item.source), renderScale(item.source));
            }
            catch (error) {
                trace.fail(error);
                throw new Error(`平铺资源“${item.node.name}”无法按实际尺寸生成：${error.message}`);
            }
            if (raster.rounded)
                warnings.add(`平铺资源“${item.node.name}”的显示尺寸已取整为 ${raster.width}×${raster.height} 像素（最小 1），节点 Scale 保持 1。`);
            const url = writer.buildTiledUrl(item.node.name, item.assetKey, 'png');
            completeGroup(item.nodes, (0, tiled_png_1.pixelSizedTileAsset)(await writer.resolve(url, raster.contents, { sourceKey: groupSourceKey(item.assetKey), tiled: true })), item.sourceType);
            trace.done({ sourceWidth: raster.sourceWidth, sourceHeight: raster.sourceHeight,
                width: raster.width, height: raster.height, tileScale: 1 });
        }
    };
    const processRemote = async (nodes) => {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!nodes.length) {
            return;
        }
        const format = 'png';
        const groups = new Map();
        for (const node of nodes) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}`, format, importSettings.scale);
            const key = resourceKey(node);
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { url, nodes: [] };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const pending = [];
        const completeGroup = (groupedNodes, asset, source) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        for (const { url, nodes: groupedNodes } of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
                throw new client_1.CancelledError();
            }
            // A declared Figma slice owns this same-name resource even when an
            // ordinary PNG was encountered first. IMAGE and gradient stages
            // run later and share this single generated result.
            const slicedSources = groupedNodes.flatMap((candidate) => {
                if (decisionForNode(candidate, decisions).action === 'ignore')
                    return [];
                const analysis = (0, slicing_1.analyzeSliceGrid)(candidate);
                return analysis ? [{ node: candidate, analysis }] : [];
            });
            const selectedSlice = slicedSources[0];
            const node = (_b = selectedSlice === null || selectedSlice === void 0 ? void 0 : selectedSlice.node) !== null && _b !== void 0 ? _b : groupedNodes[0];
            const decision = (_c = decisions.get(node.id)) !== null && _c !== void 0 ? _c : defaultDecision(node);
            const sliceAnalysis = (_d = selectedSlice === null || selectedSlice === void 0 ? void 0 : selectedSlice.analysis) !== null && _d !== void 0 ? _d : (decision.nineSlice ? (0, slicing_1.analyzeSliceGrid)(node) : null);
            if (selectedSlice) {
                const shape = (entry) => JSON.stringify({ mode: entry.analysis.mode,
                    borders: entry.analysis.borders, frame: entry.node.absoluteBoundingBox && {
                        width: entry.node.absoluteBoundingBox.width, height: entry.node.absoluteBoundingBox.height,
                    } });
                if (slicedSources.slice(1).some((entry) => shape(entry) !== shape(selectedSlice))) {
                    const reason = `同名三/九宫定义不同，沿用首个有效 Figma 切片“${node.name}”的原始画布与边距，仅生成一份资源`;
                    warnings.add(reason);
                    note('merged', node.name, reason, url);
                }
                const destination = (0, path_1.resolve)(Editor.Project.path, url.slice('db://'.length));
                if (localResources.some((library) => {
                    const suffix = (0, path_1.relative)(library.root, destination);
                    return !suffix || (!(0, path_1.isAbsolute)(suffix) && suffix !== '..'
                        && !suffix.startsWith(`..\\`) && !suffix.startsWith('../'));
                }))
                    throw new Error('Figma 三/九宫需要写入输出目录，但该目录位于指定本地素材库中；请调整输出目录，避免修改素材库。');
                note('merged', node.name, 'Figma 三/九宫定义优先：使用 Figma 原始画布与边距生成输出资源，不沿用同名素材的旧边距', url);
            }
            const reuseAsset = (asset, source) => {
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
            const localMatch = sliceAnalysis || (0, mask_tint_1.analyzeMaskTint)(node) ? null : await findLocal(node.name, false);
            // Without a valid Figma slice, preserve the existing local name
            // mapping, UUID and slice borders even during an explicit refresh.
            const localUrl = localMatch
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                reuseAsset(localAsset, localMatch.source);
                continue;
            }
            if (localUrl) {
                throw new Error(`同名本地资源尚无可用 SpriteFrame，请先在 Cocos 中完成资源导入并设置为 SpriteFrame 后重试，不会另建副本：${localUrl}`);
            }
            const namedOutput = !sliceAnalysis && !localMatch && !(0, mask_tint_1.analyzeMaskTint)(node) ? await findOutput(node.name) : null;
            if (namedOutput) {
                const namedAsset = await writer.existing(assetDatabaseUrl(namedOutput.path));
                if (!namedAsset)
                    throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
                reuseAsset(namedAsset, 'existing');
                continue;
            }
            if (decision.nineSlice && !sliceAnalysis) {
                warnings.add(`三/九宫节点“${node.name}”无法计算连续切片边界，已临时作为 PNG 整层导入`);
            }
            const borders = sliceAnalysis === null || sliceAnalysis === void 0 ? void 0 : sliceAnalysis.borders;
            // New sliced assets retain their exact geometric canvas because
            // their generated borders use that coordinate space.
            const renderFrame = borders ? undefined : overflowingRenderFrame(node);
            const key = {
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
                const frame = node.absoluteBoundingBox;
                const isFullCanvas = (0, raster_format_1.isPng)(cached) && cached.length >= 24
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
                url: localMatch && (0, assets_1.detectImageExtension)(localMatch.contents) === 'jpg'
                    ? url.replace(/\.png$/i, '.jpg') : url,
                borders,
                sliceAnalysis: sliceAnalysis !== null && sliceAnalysis !== void 0 ? sliceAnalysis : undefined,
                renderFrame: localMatch ? undefined : renderFrame,
                key,
                contents: (_e = localMatch === null || localMatch === void 0 ? void 0 : localMatch.contents) !== null && _e !== void 0 ? _e : cached,
                source: localMatch ? 'local' : cached ? 'cache' : 'figma',
            });
        }
        const urls = {};
        const remoteItems = pending.filter((item) => !item.contents);
        for (const useAbsoluteBounds of [true, false]) {
            const batch = remoteItems.filter((item) => (useAbsoluteBounds ? !item.renderFrame : Boolean(item.renderFrame)));
            if (!batch.length) {
                continue;
            }
            Object.assign(urls, await (await getApi()).getImageUrls(session.fileKey, batch.map((item) => item.node.id), format, importSettings.scale, useAbsoluteBounds, Object.fromEntries(batch.map((item) => [item.node.id, item.node.name]))));
        }
        for (const item of pending) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
                throw new client_1.CancelledError();
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
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)
                throw new client_1.CancelledError();
            let asset;
            if (item.sliceAnalysis) {
                const trace = (0, diagnostics_1.diagnosticStart)('三/九宫资源最小化', { node: item.node.name });
                const result = await (0, sliced_png_1.writeSlicedPng)(writer, item.url, contents, item.node, item.sliceAnalysis, importSettings.scale);
                asset = result.asset;
                trace.done(result.optimization);
                note(asset.sliceFallback ? 'fallback' : 'merged', item.node.name, `三/九宫：${(_f = result.optimization.reason) !== null && _f !== void 0 ? _f : result.optimization.status}`, asset.url);
            }
            else {
                asset = await writer.write(item.url, contents, item.borders);
            }
            noteWrite(asset);
            sharedAssets.set(resourceKey(item.node), asset);
            if (asset.sliceFallback) {
                warnings.add(`三/九宫节点“${item.node.name}”切片设置失败，已临时作为 PNG 整层导入：${asset.sliceFallback}`);
            }
            for (const groupedNode of item.nodes) {
                completeAsset(groupedNode, item.renderFrame
                    ? { ...asset, renderFrame: (_g = overflowingRenderFrame(groupedNode)) !== null && _g !== void 0 ? _g : item.renderFrame }
                    : asset, item.source);
            }
        }
    };
    const processRawImages = async (items) => {
        var _a, _b;
        if (!items.length)
            return;
        const groups = new Map();
        for (const item of items) {
            const key = resourceKey(item.node);
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { node: item.node, nodes: [], imageRef: item.imageRef };
            group.nodes.push(item.node);
            groups.set(key, group);
        }
        let imageFillUrlsPromise;
        const downloads = new Map();
        const completeImages = (nodes, base, source) => {
            sharedAssets.set(resourceKey(nodes[0]), base);
            for (const node of nodes) {
                const { innerOpacity } = imageDetails(node);
                const asset = innerOpacity < 1 ? { ...base, tint: { r: 1, g: 1, b: 1, a: innerOpacity } } : base;
                completeAsset(node, asset, source);
            }
        };
        for (const group of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)
                throw new client_1.CancelledError();
            const shared = sharedAssets.get(resourceKey(group.node));
            if (shared) {
                completeImages(group.nodes, shared, 'existing');
                continue;
            }
            const { leaf } = imageDetails(group.node);
            const match = await findLocal(group.node.name, false);
            const localUrl = match ? assetDatabaseUrl(match.path) : null;
            if (localUrl) {
                const localAsset = await writer.existing(localUrl);
                if (!localAsset)
                    throw new Error(`同名本地资源尚无可用 SpriteFrame，不会另建副本：${localUrl}`);
                completeImages(group.nodes, localAsset, match.source);
                continue;
            }
            const namedOutput = !match ? await findOutput(group.node.name) : null;
            const existing = namedOutput ? await writer.existing(assetDatabaseUrl(namedOutput.path)) : null;
            if (existing) {
                completeImages(group.nodes, existing, 'existing');
                continue;
            }
            if (namedOutput)
                throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
            let contents = null;
            let extension;
            let source = 'cache';
            if (!importSettings.refreshAssets) {
                for (const candidate of assets_1.RASTER_IMAGE_EXTENSIONS) {
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
                extension = (0, assets_1.detectImageExtension)(contents);
                await cache.write({
                    fileKey: session.fileKey,
                    nodeId: `image-ref:${group.imageRef}`,
                    format: extension,
                    scale: 1,
                    variant: 'source-image-v1',
                }, contents);
            }
            extension !== null && extension !== void 0 ? extension : (extension = (0, assets_1.detectImageExtension)(contents));
            const fill = leaf.fills.find((paint) => paint.visible !== false && paint.type === 'IMAGE');
            const frame = nodeFrame(group.node);
            const raster = (0, image_fill_1.rasterizeImageFill)(contents, ((_b = fill === null || fill === void 0 ? void 0 : fill.scaleMode) === null || _b === void 0 ? void 0 : _b.toUpperCase()) === 'FIT' ? 'FIT' : 'FILL', frame.width, frame.height, importSettings.scale);
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)
                throw new client_1.CancelledError();
            const url = writer.buildUrl(group.node.name, `${session.fileKey}:image-ref:${group.imageRef}`, 'png', importSettings.scale);
            const resolved = await writer.write(url, raster);
            noteWrite(resolved);
            if (group.node.children.length)
                note('merged', group.node.name, '普通 IMAGE 在隐藏和显示状态使用相同中心裁切/适配；源图缓存保留原始像素，节点透明度单独应用', resolved.url);
            completeImages(group.nodes, resolved, source);
        }
    };
    await (0, diagnostics_1.diagnosticTask)('准备平铺资源', { count: requests.tiled.length }, () => processTiled(requests.tiled));
    await (0, diagnostics_1.diagnosticTask)('准备 PNG 资源', { count: requests.png.length }, () => processRemote(requests.png));
    await (0, diagnostics_1.diagnosticTask)('准备原始 IMAGE 填充资源', { count: requests.rawImages.length }, () => processRawImages(requests.rawImages));
    for (const node of requests.gradients) {
        const shared = sharedAssets.get(resourceKey(node));
        if (shared) {
            completeAsset(node, shared, 'existing');
            continue;
        }
        const named = await findLocal(node.name, false);
        const namedUrl = named ? assetDatabaseUrl(named.path) : null;
        if (namedUrl) {
            const existing = await writer.existing(namedUrl);
            if (!existing)
                throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedUrl}`);
            sharedAssets.set(resourceKey(node), existing);
            completeAsset(node, existing, named.source);
            continue;
        }
        const namedOutput = !named ? await findOutput(node.name) : null;
        if (namedOutput) {
            const existing = await writer.existing(assetDatabaseUrl(namedOutput.path));
            if (!existing)
                throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
            sharedAssets.set(resourceKey(node), existing);
            completeAsset(node, existing, 'existing');
            continue;
        }
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const png = frame && fill
            ? (0, svg_1.gradientPng)(frame.width, frame.height, fill, cornerRadii(node), importSettings.scale)
            : null;
        if (png) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}:gradient`, 'png', importSettings.scale);
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
    for (const event of writer.events)
        note(event.action, (0, path_1.basename)(event.url), event.reason, event.url);
    return { assets, warnings: [...warnings] };
}
async function resolveFonts(settings) {
    const result = new Map();
    for (const [family, url] of Object.entries(settings.fontMap)) {
        const uuid = await (0, assets_1.resolveAssetUuid)(url);
        if (uuid) {
            result.set(family, uuid);
        }
    }
    return result;
}
function inferredLayoutMode(node) {
    const nativeMode = (0, analyzer_1.inferCocosLayoutMode)(node);
    if (nativeMode) {
        return nativeMode;
    }
    if (node.layoutMode && node.layoutMode !== 'NONE') {
        return undefined;
    }
    const frames = node.children
        .map((child) => child.absoluteBoundingBox)
        .filter((frame) => Boolean(frame));
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
function makeSpec(node, parentFrame, decisions, plans, nodeById, assets, fonts, isRoot = false, parentWorldRotation = 0) {
    var _a, _b, _c;
    const decision = decisionForNode(node, decisions);
    if (decision.action === 'ignore') {
        return null;
    }
    const frame = nodeFrame(node);
    const plan = plans.get(node.id);
    const fold = plan === null || plan === void 0 ? void 0 : plan.fold;
    const foldSource = fold ? nodeById.get(fold.sourceNodeId) : undefined;
    const textSource = (fold === null || fold === void 0 ? void 0 : fold.kind) === 'single-text' && foldSource ? foldSource : node;
    const visualSource = fold && fold.kind !== 'single-text' && foldSource ? foldSource : node;
    const resolvedKind = decision.kind === 'auto' ? (0, analyzer_1.inferKind)(node) : decision.kind;
    const plannedKind = (_a = plan === null || plan === void 0 ? void 0 : plan.kind) !== null && _a !== void 0 ? _a : resolvedKind;
    const bitmapTerminal = decision.nineSlice || decision.action === 'render';
    const terminal = bitmapTerminal || (0, import_actions_1.isTerminalAction)(decision.action);
    const effectiveKind = (0, import_actions_1.kindForImportAction)(plannedKind, decision.action, decision.nineSlice);
    const spriteSourceId = fold && fold.kind !== 'single-text'
        ? fold.sourceNodeId
        : node.id;
    const spriteAsset = assets.get(spriteSourceId);
    const absorbedDirectIds = new Set(fold ? [fold.sourceNodeId] : []);
    const fullFold = (fold === null || fold === void 0 ? void 0 : fold.kind) === 'single-image' || (fold === null || fold === void 0 ? void 0 : fold.kind) === 'single-text';
    const worldRotation = parentWorldRotation + node.rotation;
    return {
        figmaId: node.id,
        name: (_b = decision.name) !== null && _b !== void 0 ? _b : node.name,
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
        fontUuid: ((_c = textSource.style) === null || _c === void 0 ? void 0 : _c.fontFamily) ? fonts.get(textSource.style.fontFamily) : undefined,
        aliasFigmaIds: fold === null || fold === void 0 ? void 0 : fold.absorbedNodeIds,
        flattenBoundary: bitmapTerminal || fullFold
            ? true
            : (fold === null || fold === void 0 ? void 0 : fold.kind) === 'background'
                ? false
                : undefined,
        planReason: plan === null || plan === void 0 ? void 0 : plan.reason,
        children: terminal
            ? []
            : node.children
                .filter((child) => !absorbedDirectIds.has(child.id))
                .map((child) => makeSpec(child, frame, decisions, plans, nodeById, assets, fonts, false, worldRotation))
                .filter((child) => child !== null),
    };
}
async function getNodeMaps() {
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'nodeMaps', 'project');
    return saved && typeof saved === 'object' ? saved : {};
}
function cocosFileId() {
    var _a, _b, _c;
    const generated = (_c = (_b = (_a = Editor.Utils) === null || _a === void 0 ? void 0 : _a.UUID) === null || _b === void 0 ? void 0 : _b.generate) === null || _c === void 0 ? void 0 : _c.call(_b, true);
    return typeof generated === 'string' && generated.length > 0
        ? generated
        : (0, crypto_1.randomBytes)(16).toString('base64').replace(/=+$/g, '');
}
async function queryPrefabAsset(urlOrUuid) {
    return await Editor.Message.request('asset-db', 'query-asset-info', urlOrUuid);
}
function assertPrefabAsset(info, expected = {}) {
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
async function waitForPrefabAsset(url, expectedUuid) {
    const started = Date.now();
    while (Date.now() - started < 30000) {
        const info = await queryPrefabAsset(url);
        if (info === null || info === void 0 ? void 0 : info.invalid) {
            throw new Error(`Cocos Prefab 资源导入失败：${url}`);
        }
        if ((info === null || info === void 0 ? void 0 : info.imported) === true) {
            if (expectedUuid && info.uuid !== expectedUuid) {
                throw new Error(`Prefab UUID 在导入期间发生变化：${url}`);
            }
            assertPrefabAsset(info, { uuid: expectedUuid, url });
            return info;
        }
        if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
            throw new client_1.CancelledError();
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error(`等待 Cocos Prefab 资源就绪超时：${url}`);
}
async function queryPrefabMeta(uuid) {
    const meta = await Editor.Message.request('asset-db', 'query-asset-meta', uuid);
    if (!meta || typeof meta !== 'object') {
        throw new Error(`无法读取 Prefab Meta：${uuid}`);
    }
    const value = meta;
    if (value.uuid !== uuid || value.importer !== 'prefab') {
        throw new Error(`Prefab Meta 与目标资源不匹配：${uuid}`);
    }
    return value;
}
function prefabDiskPath(url) {
    if (!url.startsWith('db://')) {
        throw new Error(`Prefab URL 无效：${url}`);
    }
    return (0, path_1.resolve)(Editor.Project.path, url.slice('db://'.length));
}
async function storedPrefabMatchesRecord(info, record) {
    try {
        return (0, prefab_sync_1.prefabJsonContainsSyncRecord)(await (0, promises_1.readFile)(prefabDiskPath(info.url)), record);
    }
    catch {
        return false;
    }
}
async function waitForOpenedPrefab(prefabUrl, prefabUuid, rootFileId) {
    var _a;
    const currentDirty = await Editor.Message.request('scene', 'query-dirty');
    if (currentDirty) {
        throw new Error('当前打开的场景或 Prefab 有未保存修改；为避免触发保存询问，请先手工保存或还原后再导入。');
    }
    Editor.Selection.clear('node');
    Editor.Selection.select('asset', prefabUuid);
    await Editor.Message.request('asset-db', 'open-asset', prefabUuid);
    const started = Date.now();
    let lastReason = 'Creator 尚未返回 Prefab 编辑状态';
    while (Date.now() - started < 30000) {
        try {
            const state = await Editor.Message.request('scene', 'execute-scene-script', {
                name: package_json_1.default.name,
                method: 'inspectPrefabContext',
                args: [{ prefabUuid, rootFileId }],
            });
            if (state.ready) {
                return;
            }
            lastReason = (_a = state.reason) !== null && _a !== void 0 ? _a : lastReason;
        }
        catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
        }
        if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
            throw new client_1.CancelledError();
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error(`打开目标 Prefab 超时：${lastReason}`);
}
async function assertOpenedPrefab(prefabUuid, rootFileId) {
    var _a;
    const state = await Editor.Message.request('scene', 'execute-scene-script', {
        name: package_json_1.default.name,
        method: 'inspectPrefabContext',
        args: [{ prefabUuid, rootFileId }],
    });
    if (!state.ready) {
        throw new Error(`目标 Prefab 编辑上下文已变化：${(_a = state.reason) !== null && _a !== void 0 ? _a : '未知原因'}`);
    }
}
async function waitForSceneSaved() {
    const started = Date.now();
    while (Date.now() - started < 15000) {
        const dirty = await Editor.Message.request('scene', 'query-dirty');
        if (!dirty) {
            return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    }
    throw new Error('等待 Prefab 保存完成超时。');
}
async function getPrefabBindings() {
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'prefabBindingsV1', 'project');
    if (!saved || typeof saved !== 'object') {
        return {};
    }
    const result = {};
    for (const [sourceHash, prefabUuid] of Object.entries(saved)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(sourceHash)
            || typeof prefabUuid !== 'string'
            || !prefabUuid) {
            throw new Error('Prefab 来源绑定记录已损坏，已停止导入。');
        }
        result[sourceHash] = prefabUuid;
    }
    return result;
}
async function setPrefabBinding(sourceHash, prefabUuid) {
    const bindings = await getPrefabBindings();
    bindings[sourceHash] = prefabUuid;
    await Editor.Profile.setProject(package_json_1.default.name, 'prefabBindingsV1', bindings, 'project');
}
async function removePrefabBinding(sourceHash) {
    const bindings = await getPrefabBindings();
    if (!bindings[sourceHash]) {
        return;
    }
    delete bindings[sourceHash];
    await Editor.Profile.setProject(package_json_1.default.name, 'prefabBindingsV1', bindings, 'project');
}
async function getPendingPrefabSyncs() {
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'pendingPrefabSyncV1', 'project');
    if (!saved || typeof saved !== 'object') {
        return {};
    }
    const result = {};
    for (const [sourceHash, raw] of Object.entries(saved)) {
        if (!/^sha256:[0-9a-f]{64}$/.test(sourceHash)
            || !raw
            || typeof raw !== 'object'
            || typeof raw.prefabUuid !== 'string') {
            throw new Error('Prefab 待恢复同步记录已损坏，已停止导入。');
        }
        const record = (0, prefab_sync_1.readPrefabSyncRecord)({
            userData: {
                figmaImporter: raw.record,
            },
        });
        if (!record || record.sourceHash !== sourceHash) {
            throw new Error('Prefab 待恢复同步记录来源不一致，已停止导入。');
        }
        result[sourceHash] = {
            prefabUuid: raw.prefabUuid,
            record,
        };
    }
    return result;
}
async function setPendingPrefabSync(sourceHash, value) {
    const pending = await getPendingPrefabSyncs();
    if (value) {
        pending[sourceHash] = value;
    }
    else {
        delete pending[sourceHash];
    }
    await Editor.Profile.setProject(package_json_1.default.name, 'pendingPrefabSyncV1', pending, 'project');
}
async function verifiedPrefabRecord(info, sourceHash) {
    let meta = await queryPrefabMeta(info.uuid);
    let record = (0, prefab_sync_1.readPrefabSyncRecord)(meta);
    if (!record) {
        throw new Error(`Prefab 缺少 Figma 来源记录，无法确认是否可安全覆盖：${info.url}。请先移动或重命名该资源。`);
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
            await Editor.Message.request('asset-db', 'save-asset-meta', info.uuid, JSON.stringify((0, prefab_sync_1.mergePrefabSyncRecord)(meta, pending.record), null, 2));
            await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
            await waitForPrefabAsset(info.url, info.uuid);
            meta = await queryPrefabMeta(info.uuid);
            const recovered = (0, prefab_sync_1.readPrefabSyncRecord)(meta);
            if (!recovered || JSON.stringify(recovered) !== JSON.stringify(pending.record)) {
                throw new Error('Prefab 增量同步记录自动恢复失败。');
            }
            record = recovered;
        }
        else if (!await storedPrefabMatchesRecord(info, record)) {
            throw new Error('Prefab 文件与当前及待恢复的同步记录都不一致，已停止自动恢复。');
        }
        await setPendingPrefabSync(sourceHash, null);
    }
    return { meta, record };
}
async function writeVerifiedPrefabRecord(info, sourceHash, record) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const meta = await queryPrefabMeta(info.uuid);
            const existing = (0, prefab_sync_1.readPrefabSyncRecord)(meta);
            if (!existing || existing.sourceHash !== sourceHash) {
                throw new Error('写入前 Prefab 来源记录不一致。');
            }
            await Editor.Message.request('asset-db', 'save-asset-meta', info.uuid, JSON.stringify((0, prefab_sync_1.mergePrefabSyncRecord)(meta, record), null, 2));
            await Editor.Message.request('asset-db', 'reimport-asset', info.uuid);
            await waitForPrefabAsset(info.url, info.uuid);
            const saved = (0, prefab_sync_1.readPrefabSyncRecord)(await queryPrefabMeta(info.uuid));
            if (!saved || JSON.stringify(saved) !== JSON.stringify(record)) {
                throw new Error('Prefab 来源记录写入后校验不一致。');
            }
            return;
        }
        catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Prefab 来源记录写入失败。');
}
async function prepareLinkedFramePrefab(prefabUrl, prefabName, rootFrame, sourceHash, sourceRootId) {
    const bindings = await getPrefabBindings();
    const boundUuid = bindings[sourceHash];
    const pending = (await getPendingPrefabSyncs())[sourceHash];
    const pendingInfo = pending
        ? await queryPrefabAsset(pending.prefabUuid)
        : null;
    const targetPlan = (0, prefab_sync_1.planPrefabRecoveryTarget)(pending === null || pending === void 0 ? void 0 : pending.prefabUuid, boundUuid, Boolean(pendingInfo));
    if (targetPlan.clearPending) {
        await setPendingPrefabSync(sourceHash, null);
    }
    if (targetPlan.clearBinding) {
        await removePrefabBinding(sourceHash);
    }
    const targetUuid = targetPlan.targetUuid;
    if (targetUuid) {
        let targetInfo = (pendingInfo === null || pendingInfo === void 0 ? void 0 : pendingInfo.uuid) === targetUuid
            ? pendingInfo
            : await queryPrefabAsset(targetUuid);
        if (!targetInfo) {
            if (bindings[sourceHash] === targetUuid) {
                await removePrefabBinding(sourceHash);
            }
        }
        else {
            targetInfo = await waitForPrefabAsset(targetInfo.url, targetUuid);
            if ((pending === null || pending === void 0 ? void 0 : pending.prefabUuid) === targetUuid && boundUuid !== targetUuid) {
                // Persist the recovery identity before verifiedPrefabRecord may
                // commit and clear pending. A later move failure must still be
                // able to locate the exact Prefab by UUID on the next attempt.
                await setPrefabBinding(sourceHash, targetUuid);
            }
            const verified = await verifiedPrefabRecord(targetInfo, sourceHash);
            if (targetInfo.url !== prefabUrl) {
                const conflict = await queryPrefabAsset(prefabUrl);
                if (conflict && conflict.uuid !== targetUuid) {
                    throw new Error(`Figma Frame 对应的 Prefab 需要移动到 ${prefabUrl}，但目标路径已被其他资源占用。`);
                }
                if (!conflict) {
                    const moved = await Editor.Message.request('asset-db', 'move-asset', targetInfo.url, prefabUrl, { overwrite: false, rename: false });
                    if (!moved || moved.uuid !== targetUuid) {
                        throw new Error(`无法在保留 UUID 的前提下移动 Prefab：${prefabUrl}`);
                    }
                    targetInfo = await waitForPrefabAsset(prefabUrl, targetUuid);
                }
                else {
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
        const seed = (0, prefab_sync_1.createMinimalPrefabJson)(prefabName, rootFrame, rootFileId, rootTransformFileId);
        const created = await Editor.Message.request('asset-db', 'create-asset', prefabUrl, seed, { overwrite: false, rename: false });
        if (!created) {
            throw new Error(`无法创建 Prefab：${prefabUrl}`);
        }
        info = await waitForPrefabAsset(prefabUrl, created.uuid);
        const meta = await queryPrefabMeta(info.uuid);
        const record = (0, prefab_sync_1.createPrefabSyncRecord)(sourceHash, sourceRootId, rootFileId, rootTransformFileId);
        const nextMeta = (0, prefab_sync_1.mergePrefabSyncRecord)(meta, record);
        await Editor.Message.request('asset-db', 'save-asset-meta', info.uuid, JSON.stringify(nextMeta, null, 2));
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
async function importLinkedFramePrefab(args) {
    const sourceHash = (0, prefab_sync_1.figmaFrameSourceHash)(args.fileKey, args.sourceNodeId);
    const prepared = await prepareLinkedFramePrefab(args.prefabUrl, args.prefabName, {
        x: args.rootFrame.x * args.scale,
        y: args.rootFrame.y * args.scale,
        width: args.rootFrame.width * args.scale,
        height: args.rootFrame.height * args.scale,
    }, sourceHash, args.roots[0].figmaId);
    await waitForOpenedPrefab(prepared.info.url, prepared.info.uuid, prepared.record.rootFileId);
    const existingNodeFileIds = (0, prefab_sync_1.resolveExistingNodeFileIds)(prepared.record, (0, prefab_sync_1.collectSceneSpecFigmaIds)(args.roots));
    const payload = {
        reviewId: args.reviewId,
        packageName: package_json_1.default.name,
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
        const dirtyBeforeImport = await Editor.Message.request('scene', 'query-dirty');
        if (dirtyBeforeImport) {
            throw new Error('目标 Prefab 有未保存的手工修改，请先保存后再执行 Figma 增量导入。');
        }
        await Editor.Message.request('scene', 'snapshot');
        snapshotStarted = true;
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'importDocument',
            args: [payload],
        });
        if (!result.prefabSync) {
            throw new Error('Prefab 增量同步未返回 fileId 记录，已停止保存。');
        }
        const nextRecord = (0, prefab_sync_1.recordPrefabSyncCapture)(prepared.record, result.prefabSync);
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
        const currentRecord = (0, prefab_sync_1.readPrefabSyncRecord)(currentMeta);
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
    }
    catch (error) {
        if (snapshotStarted && !saveAttempted) {
            try {
                await Editor.Message.request('scene', 'snapshot-abort');
            }
            catch {
                if (error instanceof Error)
                    error.requiresAttention = true;
            }
        }
        if (saveAttempted && error instanceof Error)
            error.requiresAttention = true;
        throw error;
    }
}
async function performImport(request, operationOwner = null, options = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const document = (_a = options.document) !== null && _a !== void 0 ? _a : activeDocument;
    if (!document) {
        throw new Error('请先读取 Figma 文件。');
    }
    const importSettings = safeSettings(request.settings);
    const controller = beginOperation(operationOwner);
    const trace = (0, diagnostics_1.diagnosticStart)('导入任务', { roots: document.roots.map((node) => ({ id: node.id, name: node.name })) });
    try {
        await saveSettings(importSettings);
        emitProgress({ phase: 'assets', value: 0, message: '分析并准备资源…' });
        const decisions = decisionMap(request.overrides, document.tree);
        const reviewDocument = document;
        importReviews.invalidate(options.preserveReviews ? { preserveHistory: true } : undefined);
        const reviewRecorder = new import_review_1.ImportReviewRecorder();
        const builtAssets = await (0, diagnostics_1.diagnosticTask)('准备全部资源', undefined, () => buildAssets(document, decisions, importSettings, reviewRecorder));
        const { assets, warnings } = builtAssets;
        if (controller.signal.aborted)
            throw new client_1.CancelledError();
        const attachReview = async (result) => {
            result.review = await (0, import_review_finalize_1.finalizeImportReview)(importReviews, reviewRecorder, reviewDocument, result.reviewBefore, result.reviewAfter, result.prefabUrl, warnings, async () => await Editor.Message.request('scene', 'execute-scene-script', {
                name: package_json_1.default.name, method: 'refreshReviewAfter', args: [{ id: reviewRecorder.id }],
            }));
            // Also cover manual imports whose panel was closed while importing.
            try {
                if (options.silentReview) {
                    delete result.reviewBefore;
                    delete result.reviewAfter;
                    return;
                }
                await Editor.Panel.open(package_json_1.default.name);
                Editor.Message.send(package_json_1.default.name, 'import-review-ready', result.review);
            }
            catch (error) {
                warnings.push(`结果已保存，但自动打开面板失败，请从插件中打开“导入结果检查”：${error.message}`);
            }
            delete result.reviewBefore;
            delete result.reviewAfter;
        };
        // buildAssets may promote a container to a local same-name resource.
        // Compile after that promotion so assets and SceneNodeSpec share the
        // exact same final plan.
        const plans = (0, import_planner_1.compileImportPlan)(document.roots, decisions);
        const fonts = await resolveFonts(importSettings);
        const sourceRootFrames = document.roots.map(nodeFrame);
        const multipleRoots = document.roots.length > 1;
        const arrangedWidth = multipleRoots
            ? sourceRootFrames.reduce((total, frame) => total + frame.width, 0)
                + Math.max(0, sourceRootFrames.length - 1) * 160
            : (_c = (_b = sourceRootFrames[0]) === null || _b === void 0 ? void 0 : _b.width) !== null && _c !== void 0 ? _c : 0;
        const rootFrame = multipleRoots
            ? {
                x: 0,
                y: 0,
                width: arrangedWidth,
                height: Math.max(0, ...sourceRootFrames.map((frame) => frame.height)),
            }
            : (_d = sourceRootFrames[0]) !== null && _d !== void 0 ? _d : { x: 0, y: 0, width: 0, height: 0 };
        let rootCursor = 0;
        const roots = document.roots
            .map((node, index) => {
            const spec = makeSpec(node, rootFrame, decisions, plans, document.nodeById, assets, fonts, true);
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
            .filter((node) => node !== null);
        if (!roots.length) {
            throw new Error('没有选中任何可导入节点。');
        }
        const sourceNodeId = document.sourceNodeId;
        if (sourceNodeId && roots.length === 1) {
            const prefabWriter = new assets_1.AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = ((_f = (_e = roots[0]) === null || _e === void 0 ? void 0 : _e.name) === null || _f === void 0 ? void 0 : _f.trim())
                || ((_h = (_g = document.roots[0]) === null || _g === void 0 ? void 0 : _g.name) === null || _h === void 0 ? void 0 : _h.trim())
                || document.fileName;
            const prefabUrl = `db://assets/${prefabWriter.folder}/${(0, assets_1.sanitizeAssetName)(frameName)}.prefab`;
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
            });
            const nodeMaps = await getNodeMaps();
            // Prefab updates persist by PrefabInfo.fileId in the asset meta;
            // runtime node UUIDs are session-only and must never be reused here.
            delete nodeMaps[document.fileKey];
            await Editor.Profile.setProject(package_json_1.default.name, 'nodeMaps', nodeMaps, 'project');
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
        const payload = {
            reviewId: reviewRecorder.id,
            packageName: package_json_1.default.name,
            fileKey: document.fileKey,
            rootName: document.fileName,
            rootFrame,
            scale: importSettings.scale,
            updateExisting: importSettings.updateExisting,
            existingMap: (_j = nodeMaps[document.fileKey]) !== null && _j !== void 0 ? _j : {},
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'importDocument',
            args: [payload],
        });
        await Editor.Message.request('scene', 'snapshot');
        nodeMaps[document.fileKey] = result.nodeMap;
        await Editor.Profile.setProject(package_json_1.default.name, 'nodeMaps', nodeMaps, 'project');
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
    }
    catch (error) {
        trace.fail(error);
        if (error instanceof client_1.CancelledError || controller.signal.aborted) {
            emitProgress({ phase: 'cancelled', value: 0, message: '已取消。' });
            throw new Error('操作已取消。');
        }
        emitProgress({
            phase: 'error',
            value: 0,
            message: error instanceof Error ? error.message : '导入失败。',
        });
        throw error;
    }
    finally {
        finishOperation(controller);
        trace.event('后台任务已释放');
    }
}
async function getMcpPluginState() {
    await vault.initialize();
    const document = activeDocument;
    return {
        version: package_json_1.default.version,
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
async function fetchFigmaDocument(sourceUrl) {
    const controller = beginOperation();
    try {
        emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取 Figma 文件…' });
        const parsed = (0, url_1.parseFigmaSource)(sourceUrl);
        const api = await client(controller.signal);
        const payload = parsed.nodeId
            ? await api.getNode(parsed.fileKey, parsed.nodeId)
            : await api.getFile(parsed.fileKey);
        const document = annotateDocumentPlan((0, parser_1.parseDocument)(payload, sourceUrl, parsed.fileKey, parsed.nodeId));
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
    }
    catch (error) {
        emitProgress({
            phase: 'error',
            value: 0,
            message: error instanceof Error ? error.message : '读取失败。',
        });
        throw error;
    }
    finally {
        finishOperation(controller);
    }
}
async function batchDocumentDto(document, fontAssets) {
    return {
        fileKey: document.fileKey, fileName: document.fileName, sourceUrl: document.sourceUrl,
        tree: document.tree, fonts: document.fonts,
        fontAssets: fontAssets !== null && fontAssets !== void 0 ? fontAssets : await listFontAssets(),
        nodeOverrides: (await nodeOverridesFor(document.fileKey)).filter((item) => document.nodeById.has(item.id)),
    };
}
async function resolveBatchSource(sourceUrl) {
    const parsed = (0, url_1.parseFigmaSource)(sourceUrl);
    if (!parsed.nodeId) {
        if (batchDocuments.size)
            throw new Error('整份文件请单独导入；请先移除批量界面列表，或使用 Section / Frame 链接。');
        const document = await fetchFigmaDocument(sourceUrl);
        return { sourceType: 'file', sourceUrl, items: [], added: 0, duplicates: 0, document };
    }
    const controller = beginOperation();
    try {
        emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取并识别 Section / Frame…' });
        const api = await client(controller.signal);
        const parsedDocument = (0, parser_1.parseDocument)(await api.getNode(parsed.fileKey, parsed.nodeId), sourceUrl, parsed.fileKey, parsed.nodeId);
        const root = parsedDocument.roots[0];
        const fontAssets = await listFontAssets();
        if (root.type !== 'SECTION' && root.type !== 'FRAME') {
            if (batchDocuments.size)
                throw new Error('批量列表只接受 Section 或 Frame；其他节点请清空列表后单独导入。');
            const document = annotateDocumentPlan(parsedDocument);
            activeDocument = document;
            documentRevision += 1;
            await patchSettings({ sourceUrl });
            return { sourceType: 'node', sourceUrl, items: [], added: 0, duplicates: 0,
                document: await batchDocumentDto(document, fontAssets) };
        }
        const frames = (0, batch_import_1.collectSectionFrames)(root);
        if (!frames.length)
            throw new Error('这个 Section 下没有可独立导入的外层 Frame。');
        const prepared = [];
        let duplicates = 0;
        for (const frame of frames) {
            const id = (0, prefab_sync_1.figmaFrameSourceHash)(parsed.fileKey, frame.id);
            const existing = batchDocuments.get(id);
            if (existing) {
                duplicates += 1;
                prepared.push({ ...existing, item: { ...existing.item,
                        document: await batchDocumentDto(existing.document, fontAssets) } });
                continue;
            }
            const document = annotateDocumentPlan((0, batch_import_1.frameDocument)(parsedDocument, frame));
            const item = {
                id, fileKey: document.fileKey, rootId: frame.id, sourceUrl: document.sourceUrl,
                name: frame.name, enabled: true,
                ...(root.type === 'SECTION' ? { sectionName: root.name } : {}),
                document: await batchDocumentDto(document, fontAssets),
            };
            prepared.push({ item, document });
        }
        const added = prepared.length - duplicates;
        if (batchDocuments.size + added > MAX_BATCH_ITEMS)
            throw new Error('本批最多添加 ' + MAX_BATCH_ITEMS + ' 个界面，请分批导入。');
        if (controller.signal.aborted)
            throw new client_1.CancelledError();
        for (const entry of prepared)
            batchDocuments.set(entry.item.id, entry);
        await patchSettings({ sourceUrl });
        emitProgress({ phase: 'idle', value: 1, message: '已添加 ' + added + ' 个界面'
                + (duplicates ? '，' + duplicates + ' 个已在列表' : '') + '。' });
        return { sourceType: root.type === 'SECTION' ? 'section' : 'frame', sourceUrl,
            items: prepared.map((entry) => entry.item), added, duplicates };
    }
    catch (error) {
        emitProgress({ phase: controller.signal.aborted ? 'cancelled' : 'error', value: 0,
            message: error instanceof Error ? error.message : '读取失败。' });
        throw error;
    }
    finally {
        finishOperation(controller);
    }
}
async function activateBatchItem(id) {
    const controller = beginOperation();
    try {
        const entry = batchDocuments.get(id);
        if (!entry)
            throw new Error('该界面已失效，请重新添加链接。');
        const document = await batchDocumentDto(entry.document);
        activeDocument = entry.document;
        documentRevision += 1;
        entry.item.document = document;
        return document;
    }
    finally {
        finishOperation(controller);
    }
}
function syncBatchItems(items) {
    if (activeBatch || activeController)
        throw new Error('请等待当前任务完成后再修改界面列表。');
    if (!Array.isArray(items) || items.length > MAX_BATCH_ITEMS)
        throw new Error('批量界面列表无效。');
    const next = new Map();
    for (const item of items) {
        const entry = item && batchDocuments.get(item.id);
        if (!entry || typeof item.enabled !== 'boolean' || next.has(item.id))
            throw new Error('界面列表已过期或包含重复项，请重新读取。');
        next.set(item.id, { ...entry, item: { ...entry.item, enabled: item.enabled } });
    }
    batchDocuments.clear();
    for (const [id, entry] of next)
        batchDocuments.set(id, entry);
    return { items: [...batchDocuments.values()].map((entry) => entry.item) };
}
async function getBatchState() {
    if (activeBatch)
        return {
            items: [...batchDocuments.values()].map((entry) => entry.item),
            lastResult: lastBatchResult, running: batchProgress(activeBatch),
        };
    const fonts = await listFontAssets();
    const items = [];
    for (const entry of batchDocuments.values()) {
        items.push({ ...entry.item, document: await batchDocumentDto(entry.document, fonts) });
    }
    return { items, lastResult: lastBatchResult, ...(activeBatch ? { running: batchProgress(activeBatch) } : {}) };
}
async function importBatch(request) {
    var _a;
    if (activeBatch || activeController || applyingImportReview || roundtripController)
        throw new Error('当前已有操作正在执行，请等待完成。');
    if (!request || !Array.isArray(request.items) || !request.items.length || request.items.length > MAX_BATCH_ITEMS) {
        throw new Error('请至少选择一个有效的待导入界面。');
    }
    const settings = safeSettings(request.settings);
    const entries = request.items.map((item) => {
        var _a, _b;
        const entry = item && batchDocuments.get(item.id);
        if (!entry || !entry.item.enabled || !Array.isArray(item.overrides))
            throw new Error('待导入界面已失效或未勾选，请重新读取。');
        const overrides = item.overrides.map((override) => ({ ...override }));
        const root = entry.document.roots[0];
        const decisions = decisionMap(overrides, entry.document.tree);
        if (((_a = decisions.get(root.id)) === null || _a === void 0 ? void 0 : _a.action) === 'ignore')
            throw new Error('“' + entry.item.name + '”根节点已忽略，请取消该界面勾选或恢复根节点策略。');
        const name = ((_b = decisions.get(root.id)) === null || _b === void 0 ? void 0 : _b.name) || root.name;
        return { ...entry, overrides, name };
    });
    (0, batch_import_1.assertBatchTargets)(entries.map((entry) => ({ id: entry.item.id, name: entry.name })));
    const run = {
        id: (0, crypto_1.randomBytes)(18).toString('hex'), index: 0, stopRequested: false,
        items: entries.map((entry) => ({ id: entry.item.id, name: entry.name,
            sourceUrl: entry.item.sourceUrl, status: 'pending' })),
    };
    activeBatch = run;
    for (const entry of entries)
        entry.item.document.nodeOverrides = entry.overrides;
    const previousDocument = activeDocument;
    const previousResult = request.preserveResults ? lastBatchResult : undefined;
    const completedResult = () => {
        var _a;
        const merged = new Map();
        for (const item of (_a = previousResult === null || previousResult === void 0 ? void 0 : previousResult.items) !== null && _a !== void 0 ? _a : []) {
            if (batchDocuments.has(item.id))
                merged.set(item.id, { ...item });
        }
        for (const item of run.items)
            merged.set(item.id, { ...item });
        const items = [...merged.values()];
        return { id: run.id, items, stopped: run.stopRequested,
            completed: items.filter((item) => item.status === 'success' || item.status === 'failed').length,
            total: items.length };
    };
    try {
        // Check every destination before the first image/prefab write.
        const folder = new assets_1.AssetWriter(settings.prefabFolder).folder;
        const bindings = await getPrefabBindings();
        for (const entry of entries) {
            const url = 'db://assets/' + folder + '/' + (0, assets_1.sanitizeAssetName)(entry.name) + '.prefab';
            const info = await queryPrefabAsset(url);
            if (!info)
                continue;
            const record = (0, prefab_sync_1.readPrefabSyncRecord)(await queryPrefabMeta(info.uuid));
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
            if (run.stopRequested)
                break;
            run.index = index;
            const entry = entries[index];
            const row = run.items[index];
            row.status = 'running';
            activeDocument = entry.document;
            documentRevision += 1;
            emitProgress({ phase: 'assets', value: 0, message: '正在导入 ' + (index + 1) + '/' + entries.length + '：' + entry.name });
            try {
                const result = await performImport({ overrides: entry.overrides,
                    settings: { ...settings, sourceUrl: entry.item.sourceUrl } }, run.id, { document: entry.document, preserveReviews: true, silentReview: true });
                Object.assign(row, { status: 'success', prefabUrl: result.prefabUrl,
                    created: result.created, updated: result.updated, warnings: result.warnings,
                    reviewId: (_a = result.review) === null || _a === void 0 ? void 0 : _a.id });
                row.status = 'success';
            }
            catch (error) {
                let unsafe = Boolean(error === null || error === void 0 ? void 0 : error.requiresAttention);
                try {
                    if (await Editor.Message.request('scene', 'query-dirty'))
                        unsafe = true;
                }
                catch {
                    unsafe = true;
                }
                row.status = 'failed';
                row.error = error instanceof Error ? error.message : '导入失败。';
                if (unsafe) {
                    row.requiresAttention = true;
                    row.error += ' 当前编辑或保存状态需要检查，已暂停后续界面；确认目标和保存状态后再重试。';
                }
                if (unsafe || request.failurePolicy === 'stop')
                    run.stopRequested = true;
            }
            emitProgress({ phase: 'scene', value: 1,
                message: entry.name + '：' + (row.status === 'success' ? '已保存' : '失败') });
        }
        const result = completedResult();
        lastBatchResult = result;
        emitProgress({ phase: 'done', value: 1, message: result.stopped ? '本批已停止，已完成项保留。' : '本批导入结束。',
            batch: { ...batchProgress(run), result } });
        return result;
    }
    finally {
        if (activeBatch === run)
            activeBatch = null;
        activeDocument = previousDocument;
        documentRevision += 1;
    }
}
function stopImportBatch() {
    if (!activeBatch)
        return { accepted: false };
    activeBatch.stopRequested = true;
    emitProgress({ phase: 'scene', value: 0, message: '当前界面完成保存后停止，后续界面不会开始。' });
    return { accepted: true };
}
async function getNodePreview(nodeId) {
    const document = activeDocument;
    const node = document === null || document === void 0 ? void 0 : document.nodeById.get(nodeId);
    if (!document || !node) {
        throw new Error('预览节点不存在。');
    }
    const controller = beginOperation();
    try {
        const urls = await (await client(controller.signal)).getImageUrls(document.fileKey, [nodeId], 'png', 1, !overflowingRenderFrame(node));
        if (!urls[nodeId]) {
            throw new Error('无法生成节点预览。');
        }
        return { url: urls[nodeId] };
    }
    finally {
        finishOperation(controller);
    }
}
exports.methods = {
    getImportReview(id) { return importReviews.get(id); },
    resolveBatchSource,
    activateBatchItem,
    syncBatchItems,
    getBatchState,
    importBatch,
    stopImportBatch,
    async getImportReviewPreview(id, assetId) { return importReviews.preview(id, assetId); },
    async applyImportReview(id, removedIds) {
        if (activeController)
            throw new Error('请等待当前导入或 Figma 预览完成。');
        const controller = beginOperation();
        applyingImportReview = true;
        try {
            return await importReviews.apply(id, removedIds);
        }
        finally {
            applyingImportReview = false;
            finishOperation(controller);
        }
    },
    async getImportReviewSourcePreview(id, assetId, nodeId) {
        if (activeController)
            throw new Error('请等待当前操作完成后再加载来源预览。');
        const { fileKey, node } = importReviews.source(id, assetId, nodeId);
        const controller = beginOperation();
        try {
            const api = await client();
            const imageRef = (0, analyzer_1.plainImageSourceRef)(node);
            if (imageRef) {
                const fills = await api.getImageFillUrls(fileKey);
                if (fills[imageRef])
                    return { url: fills[imageRef], note: 'Figma 原图（未合成节点效果）' };
            }
            const urls = await api.getImageUrls(fileKey, [node.id], 'png', 1, !overflowingRenderFrame(node));
            if (!urls[node.id])
                throw new Error('Figma 未返回预览，隐藏或复杂效果节点可能无法单独渲染。');
            return { url: urls[node.id], note: 'Figma 当前节点渲染（隐藏祖先可能使预览透明）' };
        }
        finally {
            finishOperation(controller);
        }
    },
    openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    async getState() {
        return getPluginState();
    },
    async setToken(value) {
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
        }
        finally {
            finishOperation(controller);
        }
    },
    async saveSettings(value) {
        return saveSettings(value);
    },
    async saveNodeOverrides(fileKey, overrides, scopeIds) {
        return saveNodeOverrides(fileKey, overrides, scopeIds);
    },
    async pickAssetFolder(current) {
        return pickAssetFolder(current);
    },
    async pickPrefabFolder(current) {
        return pickPrefabFolder(current);
    },
    async pickLocalResourceFolder(current) {
        return pickLocalResourceFolder(current);
    },
    async pickCacheFolder(current) {
        return pickLocalResourceFolder(current);
    },
    async fetchDocument(sourceUrl) {
        return fetchFigmaDocument(sourceUrl);
    },
    async getPreview(nodeId) {
        return getNodePreview(nodeId);
    },
    async roundtripDetect(sourceUrl, explicitRootId) {
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).detect(sourceUrl, explicitRootId);
        }
        finally {
            finishRoundtripOperation(controller);
        }
    },
    async roundtripPreview(sourceUrl, explicitRootId) {
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).preview(sourceUrl, explicitRootId);
        }
        finally {
            finishRoundtripOperation(controller);
        }
    },
    async roundtripPair(pairToken) {
        if (roundtripRecoveryBlocker)
            throw new Error(roundtripRecoveryBlocker);
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).pair(pairToken);
        }
        finally {
            finishRoundtripOperation(controller);
        }
    },
    async roundtripApply(previewToken) {
        if (roundtripRecoveryBlocker)
            throw new Error(roundtripRecoveryBlocker);
        const controller = beginRoundtripOperation();
        try {
            return await (await roundtripService(controller.signal)).apply(previewToken);
        }
        finally {
            finishRoundtripOperation(controller);
        }
    },
    roundtripCancel() {
        roundtripController === null || roundtripController === void 0 ? void 0 : roundtripController.abort();
    },
    async importSelection(request) {
        return performImport(request);
    },
    cancelImport() {
        if (activeBatch)
            return stopImportBatch();
        activeController === null || activeController === void 0 ? void 0 : activeController.abort();
    },
};
async function startMcpBridge() {
    var _a;
    const previous = mcpBridge;
    mcpBridge = null;
    mcpApi = null;
    if (previous)
        await previous.close();
    const creatorVersion = (_a = Editor.App.version) !== null && _a !== void 0 ? _a : 'unknown';
    const api = new mcp_api_1.FigmaImporterMcpApi({
        projectPath: Editor.Project.path,
        creatorVersion,
        getDocumentRevision: () => documentRevision,
        isImportBusy: () => activeBatch !== null || activeController !== null || roundtripController !== null,
        getState: getMcpPluginState,
        fetchDocument: fetchFigmaDocument,
        getPreview: getNodePreview,
        saveSettings,
        patchSettings,
        saveNodeOverrides,
        patchNodeNames,
        importSelection: (request, operationId) => performImport(request, operationId),
        cancelImport: (operationId) => {
            if (!activeController || activeOperationOwner !== operationId)
                return false;
            activeController.abort();
            return true;
        },
    });
    const bridge = new server_1.McpBridgeServer({
        projectPath: Editor.Project.path,
        pluginVersion: package_json_1.default.version,
        pluginInstanceId,
        invoke: (method, params, signal) => api.invoke(method, params, signal),
    });
    try {
        await bridge.start();
        mcpApi = api;
        mcpBridge = bridge;
    }
    catch (error) {
        await bridge.close().catch(() => undefined);
        console.error(`Figma Importer MCP Bridge 启动失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
}
async function load() {
    await vault.initialize();
    try {
        const recovered = await (0, recovery_1.recoverInterruptedTransactions)(Editor.Project.path, transaction_1.editorReimporter);
        const active = recovered.filter((result) => result.status === 'active-owner');
        roundtripRecoveryBlocker = active.length
            ? `检测到 ${active.length} 个仍由活动进程持有的 Round-trip 事务，暂时禁止 Pair/Apply。`
            : null;
    }
    catch (error) {
        roundtripRecoveryBlocker = `Round-trip 启动恢复失败：${error instanceof Error ? error.message : '未知错误'}`;
        console.error(roundtripRecoveryBlocker);
    }
    await startMcpBridge();
}
function unload() {
    if (activeBatch)
        activeBatch.stopRequested = true;
    batchDocuments.clear();
    lastBatchResult = undefined;
    importReviews.invalidate();
    activeController === null || activeController === void 0 ? void 0 : activeController.abort();
    activeController = null;
    activeOperationOwner = null;
    activeDocument = null;
    documentRevision += 1;
    const bridge = mcpBridge;
    mcpBridge = null;
    mcpApi = null;
    void (bridge === null || bridge === void 0 ? void 0 : bridge.close().catch((error) => {
        console.error(`Figma Importer MCP Bridge 关闭失败：${error instanceof Error ? error.message : '未知错误'}`);
    }));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQTJmQSx3REFnQkM7QUE4QkQsa0NBMkJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBbUVELGtDQXF1QkM7QUF3Q0QsNEJBc0dDO0FBMHVDRCxvQkFhQztBQUVELHdCQWdCQztBQWg1RkQsK0JBQThFO0FBQzlFLDJCQUFnQztBQUNoQyxtQ0FBcUM7QUFDckMsK0NBQWdFO0FBQ2hFLDBDQUFnRDtBQUNoRCxtRUFBMEM7QUFDMUMsMkNBQThFO0FBQzlFLCtDQVcwQjtBQUMxQiwyQ0FBK0M7QUFDL0MsMkRBS2dDO0FBQ2hDLGlEQUF5RTtBQUN6RSw2Q0FBdUU7QUFDdkUscUNBQStDO0FBQy9DLHFEQUkwQjtBQUMxQiw4Q0FPMkI7QUFDM0IsNENBQXVFO0FBRXZFLGdFQUFrRTtBQUNsRSx3Q0FBNkM7QUFDN0Msc0RBQXVEO0FBQ3ZELDREQUFpRDtBQUNqRCxvREFBMEY7QUFDMUYsc0RBQTJEO0FBQzNELHdEQVlnQztBQUNoQyx3REFBb0Q7QUFDcEQsdUNBQXVFO0FBQ3ZFLGdEQUFzRDtBQUN0RCxpREFBdUQ7QUFDdkQsbURBQXNFO0FBQ3RFLHlEQUEyRDtBQUMzRCxtQ0FtQmlCO0FBQ2pCLDJDQUErQztBQUMvQyw0REFBcUY7QUFDckYsOEVBQXlFO0FBRXpFLGlEQUF5RjtBQU16RixNQUFNLEtBQUssR0FBRyxJQUFJLHdCQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMvQyxNQUFNLGFBQWEsR0FBRyxJQUFJLG1DQUFtQixFQUFFLENBQUM7QUFDaEQsSUFBSSxvQkFBb0IsR0FBRyxLQUFLLENBQUM7QUFDakMsSUFBSSxjQUFjLEdBQTJCLElBQUksQ0FBQztBQUNsRCxJQUFJLGdCQUFnQixHQUEyQixJQUFJLENBQUM7QUFDcEQsSUFBSSxvQkFBb0IsR0FBa0IsSUFBSSxDQUFDO0FBQy9DLElB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QUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsS0FBSyxDQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDakMsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIgfSBmcm9tICdmcy9wcm9taXNlcyc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcclxuaW1wb3J0IHtcclxuICAgIGhhc0hpZGRlbkRlc2NlbmRhbnQsXHJcbiAgICBpbmZlckFjdGlvbixcclxuICAgIGluZmVyQ29jb3NMYXlvdXRNb2RlLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcclxuICAgIGlzTmFtZWRTbGljZUdyb3VwLFxyXG4gICAgaXNWZWN0b3JOb2RlLFxyXG4gICAgbmF0aXZlVGlsZWRQYWludFNvdXJjZSxcclxuICAgIHBsYWluSW1hZ2VTb3VyY2VSZWYsXHJcbiAgICB0eXBlIFRpbGVkUGFpbnRTb3VyY2UsXHJcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XHJcbmltcG9ydCB7IHBhcnNlRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hL3BhcnNlcic7XHJcbmltcG9ydCB7XHJcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcclxuICAgIGNvbXBpbGVJbXBvcnRQbGFuLFxyXG4gICAgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uLFxyXG4gICAgcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zLFxyXG59IGZyb20gJy4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBhbmFseXplTWFza1RpbnQsIHZlcmlmeVdoaXRlQWxwaGFQbmcgfSBmcm9tICcuL2ZpZ21hL21hc2stdGludCc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQsIHR5cGUgU2xpY2VBbmFseXNpcyB9IGZyb20gJy4vZmlnbWEvc2xpY2luZyc7XHJcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHtcclxuICAgIEFzc2V0V3JpdGVyLFxyXG4gICAgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMsXHJcbiAgICBkZXRlY3RJbWFnZUV4dGVuc2lvbixcclxuICAgIHJlc29sdmVBc3NldFV1aWQsXHJcbiAgICBzYW5pdGl6ZUFzc2V0TmFtZSxcclxuICAgIHR5cGUgUmFzdGVySW1hZ2VFeHRlbnNpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgeyBMb2NhbEFzc2V0Q2FjaGUsIHR5cGUgQ2FjaGVFbnRyeUtleSB9IGZyb20gJy4vaW1wb3J0ZXIvY2FjaGUnO1xyXG5pbXBvcnQgdHlwZSB7IEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBMb2NhbFJlc291cmNlTGlicmFyeSB9IGZyb20gJy4vaW1wb3J0ZXIvbG9jYWwtcmVzb3VyY2VzJztcclxuaW1wb3J0IHsgZ3JhZGllbnRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3N2Zyc7XHJcbmltcG9ydCB7IHdyaXRlU2xpY2VkUG5nIH0gZnJvbSAnLi9pbXBvcnRlci9zbGljZWQtcG5nJztcclxuaW1wb3J0IHsgaXNQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3Jhc3Rlci1mb3JtYXQnO1xyXG5pbXBvcnQgeyBwaXhlbFNpemVkVGlsZUFzc2V0LCByYXN0ZXJpemVUaWxlLCB0aWxlZFJhc3RlcktleSB9IGZyb20gJy4vaW1wb3J0ZXIvdGlsZWQtcG5nJztcclxuaW1wb3J0IHsgcmFzdGVyaXplSW1hZ2VGaWxsIH0gZnJvbSAnLi9pbXBvcnRlci9pbWFnZS1maWxsJztcclxuaW1wb3J0IHtcclxuICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyxcclxuICAgIGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uLFxyXG4gICAgY3JlYXRlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIGZpZ21hRnJhbWVTb3VyY2VIYXNoLFxyXG4gICAgbWVyZ2VQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxyXG4gICAgcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZCxcclxuICAgIHJlYWRQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXHJcbiAgICByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgIHR5cGUgUHJlZmFiU3luY1JlY29yZCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcclxuaW1wb3J0IHsgVG9rZW5WYXVsdCB9IGZyb20gJy4vc2VjdXJpdHkvdG9rZW4tdmF1bHQnO1xyXG5pbXBvcnQgeyBGaWdtYUltcG9ydGVyTWNwQXBpLCB0eXBlIE1jcE5vZGVOYW1lUGF0Y2ggfSBmcm9tICcuL21jcC1hcGknO1xyXG5pbXBvcnQgeyBNY3BCcmlkZ2VTZXJ2ZXIgfSBmcm9tICcuL21jcC1icmlkZ2Uvc2VydmVyJztcclxuaW1wb3J0IHsgUm91bmR0cmlwU2VydmljZSB9IGZyb20gJy4vcm91bmR0cmlwL3NlcnZpY2UnO1xyXG5pbXBvcnQgeyByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMgfSBmcm9tICcuL3JvdW5kdHJpcC9yZWNvdmVyeSc7XHJcbmltcG9ydCB7IGVkaXRvclJlaW1wb3J0ZXIgfSBmcm9tICcuL3JvdW5kdHJpcC90cmFuc2FjdGlvbic7XHJcbmltcG9ydCB7XHJcbiAgICBERUZBVUxUX1NFVFRJTkdTLFxyXG4gICAgdHlwZSBEb2N1bWVudFNlc3Npb24sXHJcbiAgICB0eXBlIEZpZ21hTm9kZSxcclxuICAgIHR5cGUgSW1wb3J0QWN0aW9uLFxyXG4gICAgdHlwZSBJbXBvcnREZWNpc2lvbixcclxuICAgIHR5cGUgSW1wb3J0T3ZlcnJpZGUsXHJcbiAgICB0eXBlIEltcG9ydFJlcXVlc3QsXHJcbiAgICB0eXBlIEltcG9ydFNldHRpbmdzLFxyXG4gICAgdHlwZSBOb2RlS2luZCxcclxuICAgIHR5cGUgTm9kZUltcG9ydFBsYW4sXHJcbiAgICB0eXBlIFByZWZhYkVkaXRpbmdTdGF0ZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHR5cGUgUHJvZ3Jlc3NFdmVudCxcclxuICAgIHR5cGUgUmVjdCxcclxuICAgIHR5cGUgU2NlbmVOb2RlU3BlYyxcclxuICAgIHR5cGUgU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgdHlwZSBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UmVjb3JkZXIsIEltcG9ydFJldmlld1NlcnZpY2UgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBmaW5hbGl6ZUltcG9ydFJldmlldyB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldy1maW5hbGl6ZSc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3LCBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGFzc2VydEJhdGNoVGFyZ2V0cywgY29sbGVjdFNlY3Rpb25GcmFtZXMsIGZyYW1lRG9jdW1lbnQgfSBmcm9tICcuL2JhdGNoLWltcG9ydCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEJhdGNoRG9jdW1lbnREdG8sIEJhdGNoRnJhbWVJdGVtLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQsIEJhdGNoSW1wb3J0UmVxdWVzdCxcclxuICAgIEJhdGNoSW1wb3J0UmVzdWx0LCBCYXRjaFByb2dyZXNzLCBCYXRjaFNvdXJjZVJlc3VsdCwgQmF0Y2hTdGF0ZSxcclxufSBmcm9tICcuL2JhdGNoLXR5cGVzJztcclxuXHJcbmNvbnN0IHZhdWx0ID0gbmV3IFRva2VuVmF1bHQocGFja2FnZUpTT04ubmFtZSk7XHJcbmNvbnN0IGltcG9ydFJldmlld3MgPSBuZXcgSW1wb3J0UmV2aWV3U2VydmljZSgpO1xyXG5sZXQgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTtcclxubGV0IGFjdGl2ZURvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZUNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlT3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBzZXR0aW5nc0NhY2hlOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxubGV0IGRvY3VtZW50UmV2aXNpb24gPSAwO1xyXG5sZXQgbWNwQnJpZGdlOiBNY3BCcmlkZ2VTZXJ2ZXIgfCBudWxsID0gbnVsbDtcclxubGV0IG1jcEFwaTogRmlnbWFJbXBvcnRlck1jcEFwaSB8IG51bGwgPSBudWxsO1xyXG5jb25zdCBwbHVnaW5JbnN0YW5jZUlkID0gcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxubGV0IG5vZGVPdmVycmlkZVdyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHNldHRpbmdzV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5jb25zdCBNQVhfQkFUQ0hfSVRFTVMgPSAxMDA7XHJcbmNvbnN0IGJhdGNoRG9jdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4oKTtcclxuaW50ZXJmYWNlIEJhdGNoUnVuIHtcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBpdGVtczogQmF0Y2hJbXBvcnRJdGVtUmVzdWx0W107XHJcbiAgICBpbmRleDogbnVtYmVyO1xyXG4gICAgc3RvcFJlcXVlc3RlZDogYm9vbGVhbjtcclxufVxyXG5sZXQgYWN0aXZlQmF0Y2g6IEJhdGNoUnVuIHwgbnVsbCA9IG51bGw7XHJcbmxldCBsYXN0QmF0Y2hSZXN1bHQ6IEJhdGNoSW1wb3J0UmVzdWx0IHwgdW5kZWZpbmVkO1xyXG5cclxudHlwZSBEZWNpc2lvbiA9IEltcG9ydERlY2lzaW9uO1xyXG5cclxuaW50ZXJmYWNlIFRpbGVkQXNzZXRSZXF1ZXN0IHtcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFJhd0ltYWdlQXNzZXRSZXF1ZXN0IHtcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIGltYWdlUmVmOiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcmV2aWV3SWQ/OiBzdHJpbmc7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcmV2aWV3QmVmb3JlPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXdBZnRlcj86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3PzogSW1wb3J0UmV2aWV3O1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFzc2V0QnVpbGRSZXN1bHQge1xyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+O1xyXG4gICAgd2FybmluZ3M6IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiQXNzZXRJbmZvIHtcclxuICAgIHV1aWQ6IHN0cmluZztcclxuICAgIHVybDogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZXI6IHN0cmluZztcclxuICAgIHR5cGU6IHN0cmluZztcclxuICAgIGltcG9ydGVkOiBib29sZWFuO1xyXG4gICAgaW52YWxpZDogYm9vbGVhbjtcclxuICAgIGlzRGlyZWN0b3J5PzogYm9vbGVhbjtcclxuICAgIHJlYWRvbmx5PzogYm9vbGVhbjtcclxuICAgIHJlZGlyZWN0PzogdW5rbm93bjtcclxufVxyXG5cclxuY29uc3QgRk9OVF9FWFRFTlNJT05TID0gbmV3IFNldChbJy50dGYnLCAnLm90ZicsICcuZm50JywgJy53b2ZmJywgJy53b2ZmMiddKTtcclxuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcclxuICAgICdhdXRvJyxcclxuICAgICdub2RlJyxcclxuICAgICdzcHJpdGUnLFxyXG4gICAgJ2xhYmVsJyxcclxuICAgICdyaWNoVGV4dCcsXHJcbiAgICAnYnV0dG9uJyxcclxuICAgICdzY3JvbGxWaWV3JyxcclxuICAgICdsYXlvdXQnLFxyXG5dKTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGxpc3RGb250QXNzZXRzKCk6IFByb21pc2U8Rm9udEFzc2V0T3B0aW9uW10+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGZvbnRzOiBGb250QXNzZXRPcHRpb25bXSA9IFtdO1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gdmlzaXQoZm9sZGVyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBsZXQgZW50cmllcztcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBlbnRyaWVzID0gYXdhaXQgcmVhZGRpcihmb2xkZXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdub2RlX21vZHVsZXMnIHx8IGVudHJ5Lm5hbWUgPT09ICdsaWJyYXJ5JyB8fCBlbnRyeS5uYW1lID09PSAndGVtcCcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihmb2xkZXIsIGVudHJ5Lm5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdmlzaXQoZmlsZVBhdGgpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFGT05UX0VYVEVOU0lPTlMuaGFzKGV4dG5hbWUoZW50cnkubmFtZSkudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBmaWxlUGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG4gICAgICAgICAgICBmb250cy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKGVudHJ5Lm5hbWUsIGV4dG5hbWUoZW50cnkubmFtZSkpLFxyXG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtwYXRofWAsXHJcbiAgICAgICAgICAgICAgICByZWxhdGl2ZVBhdGg6IHBhdGgsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGF3YWl0IHZpc2l0KGFzc2V0c1Jvb3QpO1xyXG4gICAgcmV0dXJuIGZvbnRzLnNvcnQoKGEsIGIpID0+IGEucmVsYXRpdmVQYXRoLmxvY2FsZUNvbXBhcmUoYi5yZWxhdGl2ZVBhdGgsICd6aC1DTicpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFByb2dyZXNzKHByb2dyZXNzOiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAuLi5wcm9ncmVzcyxcclxuICAgICAgICAuLi4oYWN0aXZlQmF0Y2ggJiYgIXByb2dyZXNzLmJhdGNoID8geyBiYXRjaDogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCkgfSA6IHt9KSxcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaFByb2dyZXNzKHJ1bjogQmF0Y2hSdW4pOiBCYXRjaFByb2dyZXNzIHtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSBydW4uaXRlbXNbTWF0aC5taW4ocnVuLmluZGV4LCBydW4uaXRlbXMubGVuZ3RoIC0gMSldO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBiYXRjaElkOiBydW4uaWQsIGl0ZW1JZDogY3VycmVudD8uaWQgPz8gJycsIG5hbWU6IGN1cnJlbnQ/Lm5hbWUgPz8gJycsXHJcbiAgICAgICAgaW5kZXg6IE1hdGgubWluKHJ1bi5pbmRleCArIDEsIHJ1bi5pdGVtcy5sZW5ndGgpLCB0b3RhbDogcnVuLml0ZW1zLmxlbmd0aCxcclxuICAgICAgICBjb21wbGV0ZWQ6IHJ1bi5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgc3RvcFJlcXVlc3RlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgaXRlbXM6IHJ1bi5pdGVtcy5tYXAoKGl0ZW0pID0+ICh7IC4uLml0ZW0gfSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdENhY2hlRm9sZGVyKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihFZGl0b3IuUHJvamVjdC50bXBEaXIsIHBhY2thZ2VKU09OLm5hbWUsICdhc3NldC1jYWNoZScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBJbXBvcnRTZXR0aW5ncyB7XHJcbiAgICBjb25zdCBpbnB1dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+XHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHNjYWxlID0gdHlwZW9mIGlucHV0LnNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoaW5wdXQuc2NhbGUpXHJcbiAgICAgICAgPyBNYXRoLm1heCgwLjI1LCBNYXRoLm1pbig0LCBpbnB1dC5zY2FsZSkpXHJcbiAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnNjYWxlO1xyXG4gICAgY29uc3QgZm9udE1hcCA9IGlucHV0LmZvbnRNYXAgJiYgdHlwZW9mIGlucHV0LmZvbnRNYXAgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoaW5wdXQuZm9udE1hcClcclxuICAgICAgICAgICAgLmZpbHRlcigoW2tleSwgaXRlbV0pID0+IGtleS50cmltKCkgJiYgdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAubWFwKChba2V5LCBpdGVtXSkgPT4gW2tleS50cmltKCksIGl0ZW0udHJpbSgpXSkpXHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHJhd0xvY2FsRm9sZGVycyA9IEFycmF5LmlzQXJyYXkoaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnMpXHJcbiAgICAgICAgPyBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogdHlwZW9mIGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXIgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgID8gW2lucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHJhd0xvY2FsRm9sZGVyc1xyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlcik6IGZvbGRlciBpcyBzdHJpbmcgPT4gdHlwZW9mIGZvbGRlciA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBmb2xkZXIudHJpbSgpKVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIsIGluZGV4LCBmb2xkZXJzKSA9PiBmb2xkZXJzLmluZGV4T2YoZm9sZGVyKSA9PT0gaW5kZXgpXHJcbiAgICAgICAgLnNsaWNlKDAsIDMpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IHR5cGVvZiBpbnB1dC5zb3VyY2VVcmwgPT09ICdzdHJpbmcnID8gaW5wdXQuc291cmNlVXJsLnRyaW0oKSA6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiB0eXBlb2YgaW5wdXQuYXNzZXRGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MuYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiB0eXBlb2YgaW5wdXQucHJlZmFiRm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGxvY2FsUmVzb3VyY2VGb2xkZXJzWzBdID8/ICcnLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbnB1dC51cGRhdGVFeGlzdGluZyAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogaW5wdXQucmVmcmVzaEFzc2V0cyA9PT0gdHJ1ZSxcclxuICAgICAgICBhdXRvU2F2ZTogaW5wdXQuYXV0b1NhdmUgPT09IHRydWUsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzVW5sb2NrZWQoKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgaWYgKHNldHRpbmdzQ2FjaGUpIHtcclxuICAgICAgICByZXR1cm4gc2V0dGluZ3NDYWNoZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCAncHJvamVjdCcpO1xyXG4gICAgc2V0dGluZ3NDYWNoZSA9IHNhZmVTZXR0aW5ncyhzYXZlZCk7XHJcbiAgICByZXR1cm4gc2V0dGluZ3NDYWNoZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3MoKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgYXdhaXQgc2V0dGluZ3NXcml0ZVF1ZXVlO1xyXG4gICAgcmV0dXJuIGdldFNldHRpbmdzVW5sb2NrZWQoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2l0aFNldHRpbmdzV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gc2V0dGluZ3NXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcclxuICAgIHNldHRpbmdzV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgbmV4dCA9IHNhZmVTZXR0aW5ncyh2YWx1ZSk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCBuZXh0LCAncHJvamVjdCcpO1xyXG4gICAgICAgIHNldHRpbmdzQ2FjaGUgPSBuZXh0O1xyXG4gICAgICAgIHJldHVybiBuZXh0O1xyXG4gICAgfSkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIHdpdGhTZXR0aW5nc1dyaXRlTG9jaygoKSA9PiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYXRjaFNldHRpbmdzKHZhbHVlOiBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbiAgICAgICAgcmV0dXJuIHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHsgLi4uY3VycmVudCwgLi4udmFsdWUgfSk7XHJcbiAgICB9KTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY2xpZW50KHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQgPSBhY3RpdmVDb250cm9sbGVyPy5zaWduYWwpOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB7XHJcbiAgICByZXR1cm4gbmV3IEZpZ21hQ2xpZW50KGF3YWl0IHZhdWx0LmdldCgpLCBzaWduYWwpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByb3VuZHRyaXBTZXJ2aWNlKHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTxSb3VuZHRyaXBTZXJ2aWNlPiB7XHJcbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xyXG4gICAgcmV0dXJuIG5ldyBSb3VuZHRyaXBTZXJ2aWNlKHtcclxuICAgICAgICBjbGllbnQ6IGF3YWl0IGNsaWVudChzaWduYWwpLFxyXG4gICAgICAgIHByb2plY3RSb290OiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk6IEFib3J0Q29udHJvbGxlciB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlciB8fCBhcHBseWluZ0ltcG9ydFJldmlldykgdGhyb3cgbmV3IEVycm9yKCflr7zlhaXmiJbnu5PmnpzosIPmlbTmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDlkI7lho3mk43kvZwgUm91bmQtdHJpcOOAgicpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgcm91bmR0cmlwQ29udHJvbGxlciA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luT3BlcmF0aW9uKG93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IEFib3J0Q29udHJvbGxlciB7XHJcbiAgICBpZiAoYXBwbHlpbmdJbXBvcnRSZXZpZXcpIHRocm93IG5ldyBFcnJvcign5q2j5Zyo56Gu6K6k5a+85YWl5ZCO55qE6LWE5rqQ6LCD5pW077yM6K+356iN5YCZ44CCJyk7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCdSb3VuZC10cmlwIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoICYmIG93bmVyICE9PSBhY3RpdmVCYXRjaC5pZCkgdGhyb3cgbmV3IEVycm9yKCfmibnph4/lr7zlhaXmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblgZzmraLlkI7nu63ku7vliqHjgIInKTtcclxuICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnIkgRmlnbWEg5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YWI5Y+W5raI44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG93bmVyO1xyXG4gICAgcmV0dXJuIGNvbnRyb2xsZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIpOiB2b2lkIHtcclxuICAgIGlmIChhY3RpdmVDb250cm9sbGVyID09PSBjb250cm9sbGVyKSB7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICAgICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShzZWxlY3RlZFBhdGgpO1xyXG4gICAgY29uc3QgZm9sZGVyID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgaWYgKCFmb2xkZXIgfHwgZm9sZGVyID09PSAnLicgfHwgZm9sZGVyLnN0YXJ0c1dpdGgoJy4uJykgfHwgaXNBYnNvbHV0ZShmb2xkZXIpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfotYTmupDovpPlh7rnm67lvZXlv4XpobvmmK/pobnnm64gYXNzZXRzIOS4i+eahOWtkOaWh+S7tuWkueOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2V0RGF0YWJhc2VVcmwoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKGZpbGVQYXRoKTtcclxuICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBjb25zdCBvdXRzaWRlID0gcGF0aCA9PT0gJy4uJ1xyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi4vJylcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uXFxcXCcpXHJcbiAgICAgICAgfHwgaXNBYnNvbHV0ZShwYXRoKTtcclxuICAgIGlmICghcGF0aCB8fCBwYXRoID09PSAnLicgfHwgb3V0c2lkZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3BhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpfWA7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqSBGaWdtYSDlr7zlhaXotYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6npooTliLbkvZPovpPlh7rnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24sIF9pbmRleCA9IDApOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJyA/IGN1cnJlbnQudHJpbSgpIDogJyc7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgaXNBYnNvbHV0ZShjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgID8gY3VycmVudEZvbGRlclxyXG4gICAgICAgIDogcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6nmnKzlnLDlkIzlkI3otYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsaWJyYXJ5ID0gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KHNlbGVjdGVkKTtcclxuICAgIHJldHVybiB7IGZvbGRlcjogbGlicmFyeS5yb290IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVuaW9uRnJhbWUobm9kZXM6IEZpZ21hTm9kZVtdKTogUmVjdCB7XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2Rlcy5tYXAobm9kZUZyYW1lKS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgUmVjdCA9PiBCb29sZWFuKHZhbHVlKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCB4ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLngpKTtcclxuICAgIGNvbnN0IHkgPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSkpO1xyXG4gICAgY29uc3QgcmlnaHQgPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoKSk7XHJcbiAgICBjb25zdCBib3R0b20gPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCkpO1xyXG4gICAgcmV0dXJuIHsgeCwgeSwgd2lkdGg6IHJpZ2h0IC0geCwgaGVpZ2h0OiBib3R0b20gLSB5IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHtcclxuICAgIGlmIChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuaW9uRnJhbWUobm9kZS5jaGlsZHJlbik7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbn1cclxuXHJcbmNvbnN0IFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OID0gMC41O1xyXG5cclxuLyoqXHJcbiAqIE9ubHkgZXhwYW5kIHJhc3RlcnMgd2hvc2UgdmlzaWJsZSBwaXhlbHMgZXNjYXBlIHRoZSBnZW9tZXRyaWMgZnJhbWUuIEFcclxuICogcmVuZGVyIGZyYW1lIGNvbnRhaW5lZCBpbnNpZGUgdGhlIGdlb21ldHJ5IG9mdGVuIHJlcHJlc2VudHMgaW50ZW50aW9uYWxcclxuICogdHJhbnNwYXJlbnQgcGFkZGluZyBhbmQgbXVzdCBrZWVwIHRoZSBsZWdhY3kgZml4ZWQtY2FudmFzIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGdlb21ldHJ5ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcmVuZGVyID0gbm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcztcclxuICAgIGlmICghZ2VvbWV0cnkgfHwgIXJlbmRlciB8fCByZW5kZXIud2lkdGggPD0gMCB8fCByZW5kZXIuaGVpZ2h0IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZ2VvbWV0cnlSaWdodCA9IGdlb21ldHJ5LnggKyBnZW9tZXRyeS53aWR0aDtcclxuICAgIGNvbnN0IGdlb21ldHJ5Qm90dG9tID0gZ2VvbWV0cnkueSArIGdlb21ldHJ5LmhlaWdodDtcclxuICAgIGNvbnN0IHJlbmRlclJpZ2h0ID0gcmVuZGVyLnggKyByZW5kZXIud2lkdGg7XHJcbiAgICBjb25zdCByZW5kZXJCb3R0b20gPSByZW5kZXIueSArIHJlbmRlci5oZWlnaHQ7XHJcbiAgICByZXR1cm4gcmVuZGVyLnggPCBnZW9tZXRyeS54IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXIueSA8IGdlb21ldHJ5LnkgLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlclJpZ2h0ID4gZ2VvbWV0cnlSaWdodCArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyQm90dG9tID4gZ2VvbWV0cnlCb3R0b20gKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgID8gcmVuZGVyXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvcm5lclJhZGlpKG5vZGU6IEZpZ21hTm9kZSk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdIHtcclxuICAgIGlmIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpPy5sZW5ndGggPT09IDQpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJhZGl1cyA9IG5vZGUuY29ybmVyUmFkaXVzID8/IDA7XHJcbiAgICByZXR1cm4gW3JhZGl1cywgcmFkaXVzLCByYWRpdXMsIHJhZGl1c107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBEZWNpc2lvbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogaW5mZXJBY3Rpb24obm9kZSksXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXNQYXRjaENhbmRpZGF0ZShub2RlKSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWNpc2lvbkZvck5vZGUobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPik6IERlY2lzaW9uIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb247XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkZWNpc2lvbk1hcChvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10sIHRyZWU6IFRyZWVOb2RlRHRvW10pOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4ge1xyXG4gICAgY29uc3QgZGVjaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIERlY2lzaW9uPigpO1xyXG4gICAgY29uc3QgZmlnbWFTbGljZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IGFkZERlZmF1bHRzID0gKG5vZGVzOiBUcmVlTm9kZUR0b1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChub2RlLnBhdGNoQ2FuZGlkYXRlKSBmaWdtYVNsaWNlcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgICAgICAgICAgfSwgQm9vbGVhbihub2RlLnBhdGNoQ2FuZGlkYXRlKSkpO1xyXG4gICAgICAgICAgICBhZGREZWZhdWx0cyhub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgYWRkRGVmYXVsdHModHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgICAgICBkZWNpc2lvbnMuc2V0KGl0ZW0uaWQsIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICAgICAga2luZDogTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kKSA/IGl0ZW0ua2luZCA6ICdhdXRvJyxcclxuICAgICAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSxcclxuICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICAgICAgfSwgZmlnbWFTbGljZXMuaGFzKGl0ZW0uaWQpKSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb25zO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4gICAgaW5jbHVkZU5vZGVOYW1lID0gdHJ1ZSxcclxuKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCk7XHJcbiAgICByZXR1cm4gZGVjaXNpb24/LmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgfHwgKGluY2x1ZGVOb2RlTmFtZSAmJiBCb29sZWFuKGRlY2lzaW9uPy5uYW1lKSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShjaGlsZCwgZGVjaXNpb25zKSk7XHJcbn1cclxuXHJcbnR5cGUgU3RvcmVkTm9kZU92ZXJyaWRlcyA9IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIEltcG9ydE92ZXJyaWRlPj47XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk6IFByb21pc2U8U3RvcmVkTm9kZU92ZXJyaWRlcz4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnID8gc2F2ZWQgYXMgU3RvcmVkTm9kZU92ZXJyaWRlcyA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlOiB1bmtub3duLCBmYWxsYmFja0lkID0gJycpOiBJbXBvcnRPdmVycmlkZSB8IG51bGwge1xyXG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGl0ZW0gPSB2YWx1ZSBhcyBQYXJ0aWFsPEltcG9ydE92ZXJyaWRlPjtcclxuICAgIGNvbnN0IGlkID0gdHlwZW9mIGl0ZW0uaWQgPT09ICdzdHJpbmcnICYmIGl0ZW0uaWQgPyBpdGVtLmlkIDogZmFsbGJhY2tJZDtcclxuICAgIGlmICghaWQpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3Qga2luZCA9IHR5cGVvZiBpdGVtLmtpbmQgPT09ICdzdHJpbmcnICYmIE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCBhcyBOb2RlS2luZClcclxuICAgICAgICA/IGl0ZW0ua2luZCBhcyBOb2RlS2luZFxyXG4gICAgICAgIDogJ2F1dG8nO1xyXG4gICAgY29uc3QgZXhwbGljaXQgPSBpdGVtLmV4cGxpY2l0ID09PSBmYWxzZSA/IGZhbHNlIDogdHJ1ZTtcclxuICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICBpZiAoIWV4cGxpY2l0ICYmICFuYW1lKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQsXHJcbiAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSA9PT0gdHJ1ZSxcclxuICAgICAgICBleHBsaWNpdCxcclxuICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gbm9kZU92ZXJyaWRlc0ZvcihmaWxlS2V5OiBzdHJpbmcpOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIGNvbnN0IHN0b3JlZCA9IChhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCkpW2ZpbGVLZXldID8/IHt9O1xyXG4gICAgY29uc3QgcmVzdWx0OiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHN0b3JlZCkpIHtcclxuICAgICAgICBjb25zdCBzYWZlID0gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZSwgaWQpO1xyXG4gICAgICAgIGlmIChzYWZlKSByZXN1bHQucHVzaChzYWZlKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcclxuICAgIG5vZGVPdmVycmlkZVdyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIGlmICh0eXBlb2YgZmlsZUtleSAhPT0gJ3N0cmluZycgfHwgIWZpbGVLZXkudHJpbSgpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaXRlbXMgPSBBcnJheS5pc0FycmF5KHZhbHVlcykgPyB2YWx1ZXMgOiBbXTtcclxuICAgIGNvbnN0IHNhZmVJdGVtcyA9IGl0ZW1zXHJcbiAgICAgICAgLm1hcCgoaXRlbSkgPT4gc2FmZU5vZGVPdmVycmlkZShpdGVtKSlcclxuICAgICAgICAuZmlsdGVyKChpdGVtKTogaXRlbSBpcyBJbXBvcnRPdmVycmlkZSA9PiBCb29sZWFuKGl0ZW0pKTtcclxuICAgIGNvbnN0IHNjb3BlSWRzID0gbmV3IFNldChcclxuICAgICAgICAoQXJyYXkuaXNBcnJheShzY29wZVZhbHVlcykgPyBzY29wZVZhbHVlcyA6IHNhZmVJdGVtcy5tYXAoKGl0ZW0pID0+IGl0ZW0uaWQpKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIEJvb2xlYW4oaWQpKSxcclxuICAgICk7XHJcbiAgICBpZiAoIXNjb3BlSWRzLnNpemUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkeW9k+WJjeWvvOWFpeiMg+WbtOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2NvcGVkSXRlbXMgPSBzYWZlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiBzY29wZUlkcy5oYXMoaXRlbS5pZCkpO1xyXG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcclxuICAgIGZvciAoY29uc3QgaWQgb2Ygc2NvcGVJZHMpIHtcclxuICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygc2NvcGVkSXRlbXMpIHtcclxuICAgICAgICBjdXJyZW50W2l0ZW0uaWRdID0gaXRlbTtcclxuICAgIH1cclxuICAgIGlmIChPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGgpIHtcclxuICAgICAgICBzdG9yZWRbZmlsZUtleV0gPSBjdXJyZW50O1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzY29wZWRJdGVtcztcclxufVxyXG5cclxuZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXMoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soXHJcbiAgICAgICAgKCkgPT4gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChmaWxlS2V5LCB2YWx1ZXMsIHNjb3BlVmFsdWVzKSxcclxuICAgICk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXRjaE5vZGVOYW1lcyhmaWxlS2V5OiBzdHJpbmcsIHBhdGNoZXM6IE1jcE5vZGVOYW1lUGF0Y2hbXSk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghZmlsZUtleS50cmltKCkpIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcclxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHBhdGNoIG9mIHBhdGNoZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaWQgPSB0eXBlb2YgcGF0Y2guaWQgPT09ICdzdHJpbmcnID8gcGF0Y2guaWQudHJpbSgpIDogJyc7XHJcbiAgICAgICAgICAgIGlmICghaWQpIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya57y65bCRIG5vZGVJZOOAgicpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHNhZmVOb2RlT3ZlcnJpZGUoY3VycmVudFtpZF0sIGlkKTtcclxuICAgICAgICAgICAgY29uc3QgZmFsbGJhY2sgPSBzYWZlTm9kZU92ZXJyaWRlKHBhdGNoLmZhbGxiYWNrLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5leHQgPSBleGlzdGluZyA/IHsgLi4uZXhpc3RpbmcgfSA6IGZhbGxiYWNrID8geyAuLi5mYWxsYmFjayB9IDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFuZXh0ICYmIHBhdGNoLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghbmV4dCkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g57y65bCR5pyJ5pWI6buY6K6k562W55Wl44CCYCk7XHJcbiAgICAgICAgICAgIGlmIChwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgbmV4dC5uYW1lO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUocGF0Y2gubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5hbWUpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOeahOWQjeensOaXoOaViOOAgmApO1xyXG4gICAgICAgICAgICAgICAgbmV4dC5uYW1lID0gbmFtZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzYWZlID0gc2FmZU5vZGVPdmVycmlkZShuZXh0LCBpZCk7XHJcbiAgICAgICAgICAgIGlmIChzYWZlKSB7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50W2lkXSA9IHNhZmU7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0ZWQucHVzaChzYWZlKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSBzdG9yZWRbZmlsZUtleV0gPSBjdXJyZW50O1xyXG4gICAgICAgIGVsc2UgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0ZWQ7XHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYW5ub3RhdGVEb2N1bWVudFBsYW4oc2Vzc2lvbjogRG9jdW1lbnRTZXNzaW9uKTogRG9jdW1lbnRTZXNzaW9uIHtcclxuICAgIGNvbnN0IGRlZmF1bHRzID0gZGVjaXNpb25NYXAoW10sIHNlc3Npb24udHJlZSk7XHJcbiAgICBzZXNzaW9uLnRyZWUgPSBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbihcclxuICAgICAgICBzZXNzaW9uLnRyZWUsXHJcbiAgICAgICAgY29tcGlsZUltcG9ydFBsYW4oc2Vzc2lvbi5yb290cywgZGVmYXVsdHMpLFxyXG4gICAgKTtcclxuICAgIHJldHVybiBzZXNzaW9uO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2xsZWN0QXNzZXRSZXF1ZXN0cyhcclxuICAgIHJvb3RzOiBGaWdtYU5vZGVbXSxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcHJlcGFyZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KCksXHJcbik6IHsgcG5nOiBGaWdtYU5vZGVbXTsgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W107IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXTsgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSB9IHtcclxuICAgIGNvbnN0IHBuZzogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IGdyYWRpZW50czogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IEZpZ21hTm9kZSwgYW5jZXN0b3JzVmlzaWJsZTogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIGlmIChwcmVwYXJlZC5oYXMobm9kZS5pZCkpIHJldHVybjtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBlZmZlY3RpdmVseVZpc2libGUgPSBhbmNlc3RvcnNWaXNpYmxlICYmIG5vZGUudmlzaWJsZSAhPT0gZmFsc2UgJiYgbm9kZS5vcGFjaXR5ID4gMDtcclxuICAgICAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UpIHtcclxuICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgICAgICAgICAgaWYgKHNvdXJjZSkge1xyXG4gICAgICAgICAgICAgICAgdGlsZWQucHVzaCh7IG5vZGUsIHNvdXJjZSB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIFRoZSBzYW1lIHBsYWluIElNQUdFIHNvdXJjZSBhbmQgY2VudGVyZWQgY3JvcCBwYXRoIHNlcnZlIGJvdGhcclxuICAgICAgICAgICAgICAgIC8vIHZpc2liaWxpdHkgc3RhdGVzOyB3aG9sZS1ub2RlIGV4cG9ydHMgY2FuIGJha2UgZGlmZmVyZW50IGFscGhhLlxyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmF3SW1hZ2VzLnB1c2goeyBub2RlLCBpbWFnZVJlZiB9KTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnZ2VuZXJhdGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICAgICAgaWYgKGZpbGwpIHtcclxuICAgICAgICAgICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGdyYWRpZW50cy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZWZmZWN0aXZlbHlWaXNpYmxlKSk7XHJcbiAgICB9O1xyXG4gICAgcm9vdHMuZm9yRWFjaCgocm9vdCkgPT4gdmlzaXQocm9vdCwgdHJ1ZSkpO1xyXG4gICAgcmV0dXJuIHsgcG5nLCB0aWxlZCwgcmF3SW1hZ2VzLCBncmFkaWVudHMgfTtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkQXNzZXRzKFxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4gICAgcmV2aWV3OiBJbXBvcnRSZXZpZXdSZWNvcmRlcixcclxuKTogUHJvbWlzZTxBc3NldEJ1aWxkUmVzdWx0PiB7XHJcbiAgICBjb25zdCByZXNvbHZlZERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICByZXNvbHZlZERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHdyaXRlU3RhdGVzID0gbmV3IE1hcDxzdHJpbmcsIGJvb2xlYW4+KCk7XHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIsIGFzeW5jICh1cmwsIGV4aXN0ZWQpID0+IHtcclxuICAgICAgICBhd2FpdCByZXZpZXcuYmVmb3JlV3JpdGUodXJsLCBleGlzdGVkKTtcclxuICAgICAgICB3cml0ZVN0YXRlcy5zZXQodXJsLCBleGlzdGVkKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICAvLyBJbmRleCBleGlzdGluZyBuYW1lcyBvbmNlOyBuZXcgcmVzb3VyY2VzIGFyZSBzaGFyZWQgYnkgbmFtZSBiZWxvdy5cclxuICAgIGNvbnN0IG91dHB1dFBhdGggPSBqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnLCB3cml0ZXIuZm9sZGVyKTtcclxuICAgIGNvbnN0IG91dHB1dFJlc291cmNlcyA9IGV4aXN0c1N5bmMob3V0cHV0UGF0aCkgPyBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkob3V0cHV0UGF0aCkgOiBudWxsO1xyXG4gICAgYXdhaXQgb3V0cHV0UmVzb3VyY2VzPy5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgLy8gVGhlIHByb2plY3QgY29udHJhY3QgaXMgc2FtZSBuYW1lID0gc2FtZSByZXNvdXJjZS4gU2hhcmUgYWNyb3NzIHJlbmRlcixcclxuICAgIC8vIElNQUdFIGFuZCBncmFkaWVudCBwYXRocyBiZWZvcmUgZG93bmxvYWRpbmcgb3IgY29tcGFyaW5nIGFueSBwaXhlbHMuXHJcbiAgICBjb25zdCBzaGFyZWRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgY29uc3QgcmVzb3VyY2VLZXkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB3cml0ZXIuYnVpbGRVcmwobm9kZS5uYW1lLCAnJywgJ3BuZycsIGltcG9ydFNldHRpbmdzLnNjYWxlKVxyXG4gICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgIGNvbnN0IHdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBub3RlID0gKGFjdGlvbjogTm9uTnVsbGFibGU8SW1wb3J0UmV2aWV3WydkZWNpc2lvbnMnXT5bbnVtYmVyXVsnYWN0aW9uJ10sIG5hbWU6IHN0cmluZywgcmVhc29uOiBzdHJpbmcsIHVybD86IHN0cmluZykgPT5cclxuICAgICAgICByZXZpZXcubm90ZT8uKGFjdGlvbiwgbmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgY29uc3Qgbm90ZVdyaXRlID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMpID0+IG5vdGUod3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybCkgPyAndXBkYXRlZCcgOiAnY3JlYXRlZCcsXHJcbiAgICAgICAgYmFzZW5hbWUoYXNzZXQudXJsKSwgd3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybClcclxuICAgICAgICAgICAgPyAn5YaZ5YWl5ZCM5ZCN6L6T5Ye66LWE5rqQ77yM5L+d55WZ5Y6fIFVVSUQnXHJcbiAgICAgICAgICAgIDogJ+aMieWQjeensOWvvOWFpeS4gOS7vei1hOa6kO+8jOWQjOWQjeiKgueCueebtOaOpeWFseeUqCcsIGFzc2V0LnVybCk7XHJcbiAgICBjb25zdCBub2RlU291cmNlS2V5ID0gKG5vZGU6IEZpZ21hTm9kZSwgdmFyaWFudCA9ICdyYXN0ZXItdjInKSA9PlxyXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KFtzZXNzaW9uLmZpbGVLZXksIG5vZGUuaWQsIGltcG9ydFNldHRpbmdzLnNjYWxlLCB2YXJpYW50XSk7XHJcbiAgICBjb25zdCBncm91cFNvdXJjZUtleSA9IChhc3NldEtleTogc3RyaW5nKSA9PiBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCAndGlsZS12MicsIGFzc2V0S2V5XSk7XHJcbiAgICBjb25zdCBpbWFnZURldGFpbHMgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgbGV0IGxlYWYgPSBub2RlLCBpbm5lck9wYWNpdHkgPSAxO1xyXG4gICAgICAgIHdoaWxlIChsZWFmLmNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBsZWFmID0gbGVhZi5jaGlsZHJlblswXTtcclxuICAgICAgICAgICAgaW5uZXJPcGFjaXR5ICo9IGxlYWYub3BhY2l0eTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgbGVhZiwgaW5uZXJPcGFjaXR5IH07XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZE91dHB1dCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpID0+IHtcclxuICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgJiYgb3V0cHV0UmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgb3V0cHV0UmVzb3VyY2VzLmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdleGlzdGluZycgYXMgY29uc3QgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZExvY2FsID0gYXN5bmMgKG5hbWU6IHN0cmluZywgaW5jbHVkZU91dHB1dCA9IHRydWUpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICAvLyBEaXJlY3Rvcnkgb3JkZXIsIGV4dGVuc2lvbiBwcmVmZXJlbmNlIGFuZCByb290LWJlZm9yZS1zdWJmb2xkZXJcclxuICAgICAgICAgICAgLy8gb3JkZXJpbmcgYXJlIHRoZSBleGlzdGluZyB1c2VyLWRlY2xhcmVkIG5hbWUgbWFwcGluZyBjb250cmFjdC5cclxuICAgICAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4geyAuLi5tYXRjaCwgc291cmNlOiAnbG9jYWwnIGFzIGNvbnN0IH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBpbmNsdWRlT3V0cHV0ID8gZmluZE91dHB1dChuYW1lKSA6IG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgcHJlcGFyZU1hc2sgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nIHx8IGRlY2lzaW9uLm5pbmVTbGljZSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpO1xyXG4gICAgICAgIGlmIChhbmFseXNpcyAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSkpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBraW5kOiAnc3ByaXRlJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgbGV0IHJlYXNvbiA9IGFuYWx5c2lzLnJlYXNvbjtcclxuICAgICAgICAgICAgaWYgKGFuYWx5c2lzLmNhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgeyBtYXNrLCB0aW50IH0gPSBhbmFseXNpcy5jYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChtYXNrLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybClcclxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShub2RlU291cmNlS2V5KG1hc2spLCB7IHRpbGVkOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICAgIC8vIFZlcmlmeSB0aGUgYnl0ZXMgb2YgdGhlIHJlZmVyZW5jZWQgYXNzZXQsIG5ldmVyIGFuIHVucmVsYXRlZFxyXG4gICAgICAgICAgICAgICAgLy8gc2FtZS1uYW1lIGZpbGUgZnJvbSBhIHByb2plY3QtZXh0ZXJuYWwgbGlicmFyeSBkaXJlY3RvcnkuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBieXRlcyA9IGxvY2FsVXJsICYmIGFzc2V0ID8gbWF0Y2ghLmNvbnRlbnRzXHJcbiAgICAgICAgICAgICAgICAgICAgOiBhc3NldCA/IGF3YWl0IHJlYWRGaWxlKGpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgYXNzZXQudXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSkpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYnl0ZXMgPyB2ZXJpZnlXaGl0ZUFscGhhUG5nKGJ5dGVzKSA6IHsgdmFsaWQ6IGZhbHNlLCByZWFzb246ICfmsqHmnInlj6/pqozor4HnmoTmnKzlnLDnmb3oibLlupXlm74nIH07XHJcbiAgICAgICAgICAgICAgICByZWFzb24gPSB2ZXJpZmllZC5yZWFzb247XHJcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQgJiYgdmVyaWZpZWQudmFsaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB0aW50ZWQgPSB7IC4uLmFzc2V0LCB0aW50IH07XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCB0aW50ZWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldmlldy5iaW5kKG5vZGUsIHRpbnRlZCwgbWF0Y2g/LnNvdXJjZSA/PyAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCd0aW50ZWQnLCBub2RlLm5hbWUsIGAke2FuYWx5c2lzLnJlYXNvbn3vvJske3ZlcmlmaWVkLnJlYXNvbn3vvJvmsr/nlKjljp8gVVVJRCDkuI7kuZ3lrqvlj4LmlbDvvIzpgI/mmI7luqbku4XorqHnrpfkuIDmrKFgLCBhc3NldC51cmwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgYCR7cmVhc29ufe+8m+S9v+eUqCBGaWdtYSDlrozmlbTokpnniYjlkIjmiJDvvIzkuI3kv67mlLnlhbHkuqvlupXlm75gKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykgcmV0dXJuO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikgYXdhaXQgcHJlcGFyZU1hc2soY2hpbGQpO1xyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgcm9vdCBvZiBzZXNzaW9uLnJvb3RzKSBhd2FpdCBwcmVwYXJlTWFzayhyb290KTtcclxuICAgIGNvbnN0IHByb3RlY3RlZERlc2NlbmRhbnQgPSAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiA9PiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY2hpbGREZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShjaGlsZCwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoY2hpbGREZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIEJvb2xlYW4oY2hpbGQuaXNNYXNrIHx8IGNoaWxkLmNoaWxkcmVuLnNvbWUoKHBhcnQpID0+IHBhcnQuaXNNYXNrKVxyXG4gICAgICAgICAgICB8fCBhc3NldHMuaGFzKGNoaWxkLmlkKSB8fCBjaGlsZERlY2lzaW9uLm5pbmVTbGljZSB8fCBpc05hbWVkU2xpY2VHcm91cChjaGlsZCkgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZCkpXHJcbiAgICAgICAgICAgIHx8IChjaGlsZERlY2lzaW9uLmFjdGlvbiAhPT0gJ3JlbmRlcicgJiYgcHJvdGVjdGVkRGVzY2VuZGFudChjaGlsZCkpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBwcm9tb3RlTG9jYWxQYXJlbnRzID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGlmIChhc3NldHMuaGFzKG5vZGUuaWQpIHx8IGFuYWx5emVNYXNrVGludChub2RlKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24ubmluZVNsaWNlXHJcbiAgICAgICAgICAgIC8vIFJlbmFtaW5nIHRoaXMgY29udGFpbmVyIGRvZXMgbm90IGNoYW5nZSByZXNvdXJjZSBtYXRjaGluZzsgb25seVxyXG4gICAgICAgICAgICAvLyBhIHN0cmF0ZWd5IG92ZXJyaWRlIG9uIGl0c2VsZiBvciBhbnkgb3ZlcnJpZGUgYmVsb3cgaXQgYmxvY2tzXHJcbiAgICAgICAgICAgIC8vIHByb21vdGlvbiBiZWNhdXNlIGRlc2NlbmRhbnRzIHdvdWxkIG90aGVyd2lzZSBkaXNhcHBlYXIuXHJcbiAgICAgICAgICAgICYmICFzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShub2RlLCBkZWNpc2lvbnMsIGZhbHNlKVxyXG4gICAgICAgICAgICAvLyBBIHNhbWUtbmFtZSBhbmNlc3RvciBpcyBub3QgcGVybWlzc2lvbiB0byBlcmFzZSBpbmRlcGVuZGVudCBzbGljZVxyXG4gICAgICAgICAgICAvLyByZXNvdXJjZXMgb3IgYSB2ZXJpZmllZC9mYWxsYmFjayBtYXNrIHJlcHJlc2VudGF0aW9uIGJlbG93IGl0LlxyXG4gICAgICAgICAgICAmJiAhcHJvdGVjdGVkRGVzY2VuZGFudChub2RlKVxyXG4gICAgICAgICAgICAvLyBBIGxvY2FsIHBhcmVudCByZXNvdXJjZSBjYW5ub3QgcmVwcmVzZW50IGluZGVwZW5kZW50bHkgaW5hY3RpdmVcclxuICAgICAgICAgICAgLy8gZGVzY2VuZGFudHMuIEtlZXAgdGhlIGhpZXJhcmNoeSB3aGVuZXZlciBzdWNoIGEgYm91bmRhcnkgZXhpc3RzLlxyXG4gICAgICAgICAgICAmJiAhaGFzSGlkZGVuRGVzY2VuZGFudChub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKG5vZGUuY2hpbGRyZW4ubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIH07XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChzZXNzaW9uLnJvb3RzLm1hcChwcm9tb3RlTG9jYWxQYXJlbnRzKSk7XHJcbiAgICBjb25zdCBmaW5hbERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICBmaW5hbERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IGFjdGl2ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgYWN0aXZlQm91bmRhcnkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuO1xyXG4gICAgICAgIGFjdGl2ZUlkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgaWYgKGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKSB8fCBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgYXNzZXRzLmhhcyhub2RlLmlkKSkgcmV0dXJuO1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaChhY3RpdmVCb3VuZGFyeSk7XHJcbiAgICB9O1xyXG4gICAgc2Vzc2lvbi5yb290cy5mb3JFYWNoKGFjdGl2ZUJvdW5kYXJ5KTtcclxuICAgIGZvciAoY29uc3QgW2lkLCBwbGFuXSBvZiBwbGFucykge1xyXG4gICAgICAgIGlmICghYWN0aXZlSWRzLmhhcyhpZCkpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBzZXNzaW9uLm5vZGVCeUlkPy5nZXQoaWQpO1xyXG4gICAgICAgIGlmIChwbGFuLnJlYXNvbiA9PT0gJ3ByZWZpeC1tZXJnZScpIG5vdGUoJ21lcmdlZCcsIG5vZGU/Lm5hbWUgPz8gaWQsXHJcbiAgICAgICAgICAgIHBsYW4ud2FybmluZyA/PyAnaWNvbl8vaW1nXyDmnIDlpJblsYLotYTmupDovrnnlYzvvIzmjInlvZPliY3mmL7pmpDlkIjmiJDvvIzkv53nlZnniLboioLngrnlh6DkvZXkuI7pgI/mmI7luqYnKTtcclxuICAgICAgICBlbHNlIGlmIChwbGFuLndhcm5pbmcpIHtcclxuICAgICAgICAgICAgd2FybmluZ3MuYWRkKGAke25vZGU/Lm5hbWUgPz8gaWR977yaJHtwbGFuLndhcm5pbmd9YCk7XHJcbiAgICAgICAgICAgIG5vdGUoJ2ZhbGxiYWNrJywgbm9kZT8ubmFtZSA/PyBpZCwgcGxhbi53YXJuaW5nKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXF1ZXN0cyA9IGNvbGxlY3RBc3NldFJlcXVlc3RzKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucywgbmV3IFNldChhc3NldHMua2V5cygpKSk7XHJcbiAgICBjb25zdCB0b3RhbCA9IHJlcXVlc3RzLnBuZy5sZW5ndGggKyByZXF1ZXN0cy50aWxlZC5sZW5ndGhcclxuICAgICAgICArIHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggKyByZXF1ZXN0cy5ncmFkaWVudHMubGVuZ3RoO1xyXG4gICAgbGV0IGNvbXBsZXRlZCA9IDA7XHJcbiAgICBsZXQgYXBpUHJvbWlzZTogUHJvbWlzZTxGaWdtYUNsaWVudD4gfCBudWxsID0gbnVsbDtcclxuXHJcbiAgICBjb25zdCBnZXRBcGkgPSAoKSA9PiB7XHJcbiAgICAgICAgYXBpUHJvbWlzZSA/Pz0gZGlhZ25vc3RpY1Rhc2soJ+WHhuWkhyBGaWdtYSDlrqLmiLfnq68nLCB1bmRlZmluZWQsICgpID0+IGNsaWVudCgpKTtcclxuICAgICAgICByZXR1cm4gYXBpUHJvbWlzZTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgY29tcGxldGVBc3NldCA9IChcclxuICAgICAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScgfCAnZ2VuZXJhdGVkJyA9ICdmaWdtYScsXHJcbiAgICApID0+IHtcclxuICAgICAgICBhc3NldHMuc2V0KG5vZGUuaWQsIGFzc2V0KTtcclxuICAgICAgICByZXZpZXcuYmluZChub2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICBpZiAoc291cmNlID09PSAnbG9jYWwnIHx8IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJykgbm90ZSgncmV1c2VkJywgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2UgPT09ICdsb2NhbCcgPyAn55So5oi35oyH5a6a5pys5Zyw55uu5b2V55qE5ZCM5ZCN5pig5bCE77yM5L+d55WZ5Y6fIFNwcml0ZUZyYW1lIFVVSUQg5LiO5YiH54mH5Y+C5pWwJ1xyXG4gICAgICAgICAgICAgICAgOiAn5oyJ5bey5pyJ6LWE5rqQ5oiW5pys5om55ZCM5ZCN6LWE5rqQ5aSN55So5Y6fIFNwcml0ZUZyYW1l77yM5L+d55WZIFVVSUQg5LiO5Y6f5YiH54mH5Y+C5pWwJywgYXNzZXQudXJsKTtcclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBjb25zdCB2ZXJiID0gc291cmNlID09PSAnbG9jYWwnXHJcbiAgICAgICAgICAgID8gJ+WkjeeUqOacrOWcsOi1hOa6kCdcclxuICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdleGlzdGluZydcclxuICAgICAgICAgICAgICAgID8gJ+WkjeeUqOW3suaciei1hOa6kCdcclxuICAgICAgICAgICAgICAgIDogc291cmNlID09PSAnZ2VuZXJhdGVkJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gJ+eUn+aIkOa4kOWPmCdcclxuICAgICAgICAgICAgICAgIDogJ+WvvOWFpei1hOa6kCc7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGAke3ZlcmJ9ICR7Y29tcGxldGVkfS8ke3RvdGFsfSDCtyAke25vZGUubmFtZX1gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzVGlsZWQgPSBhc3luYyAoaXRlbXM6IFRpbGVkQXNzZXRSZXF1ZXN0W10pID0+IHtcclxuICAgICAgICBpZiAoIWl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcclxuICAgICAgICAgICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG4gICAgICAgICAgICBzb3VyY2VLZXk6IHN0cmluZztcclxuICAgICAgICAgICAgYXNzZXRLZXk6IHN0cmluZztcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFBlbmRpbmdUaWxlIGV4dGVuZHMgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbj86IFJhc3RlckltYWdlRXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBzb3VyY2VUeXBlOiAnY2FjaGUnIHwgJ2ZpZ21hJztcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdGVkU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBpbXBvcnRTZXR0aW5ncy5zY2FsZSAqIHNvdXJjZS5zY2FsZTtcclxuICAgICAgICBjb25zdCByZW5kZXJTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IHNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgID8gY2xhbXBJbWFnZVNjYWxlKHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgVGlsZUdyb3VwPigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgeyBub2RlLCBzb3VyY2UgfSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2VLZXkgPSBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBzb3VyY2Uua2luZCxcclxuICAgICAgICAgICAgICAgIGlkOiBzb3VyY2UuaWQsXHJcbiAgICAgICAgICAgICAgICBwYWludFNjYWxlOiBzb3VyY2Uuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByZW5kZXJTY2FsZTogcmVuZGVyU2NhbGUoc291cmNlKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0S2V5ID0gdGlsZWRSYXN0ZXJLZXkoc291cmNlS2V5LCByZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwobm9kZS5uYW1lLCBhc3NldEtleSwgJ3BuZycpXHJcbiAgICAgICAgICAgICAgICAubm9ybWFsaXplKCdORktDJylcclxuICAgICAgICAgICAgICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlLCBub2RlczogW10sIHNvdXJjZSwgc291cmNlS2V5LCBhc3NldEtleSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnY2FjaGUnIHwgJ2ZpZ21hJyxcclxuICAgICAgICApID0+IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBncm91cGVkTm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoZ3JvdXBlZE5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBQZW5kaW5nVGlsZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdBc3NldDogU3ByaXRlQXNzZXRTcGVjIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZXhpc3RpbmdBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShncm91cFNvdXJjZUtleShncm91cC5hc3NldEtleSksIHsgdGlsZWQ6IHRydWUgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHBpeGVsU2l6ZWRUaWxlQXNzZXQoZXhpc3RpbmdBc3NldCksICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZEV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBbJ3BuZyddXHJcbiAgICAgICAgICAgICAgICAgICAgOiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUztcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoZ3JvdXAuc291cmNlKSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gY2FjaGVkO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyxcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogY2FjaGVkRXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVyblVybHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nIHwgbnVsbD4oKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJlbW90ZUl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNvdXJjZS5raW5kICE9PSAnc291cmNlLW5vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzY2FsZSA9IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGlkcy5hZGQoaXRlbS5zb3VyY2UuaWQpO1xyXG4gICAgICAgICAgICBwYXR0ZXJuc0J5U2NhbGUuc2V0KHNjYWxlLCBpZHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IFtzY2FsZSwgaWRzXSBvZiBwYXR0ZXJuc0J5U2NhbGUpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShpZHMpLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbaWQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXModXJscykpIHtcclxuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcclxuICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gbmVlZHNJbWFnZUZpbGxzXHJcbiAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSlcclxuICAgICAgICAgICAgOiB7fTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkID0gKHVybDogc3RyaW5nLCBub2RlTGFiZWw6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQodXJsKTtcclxuICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQodXJsLCBub2RlTGFiZWwpKTtcclxuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gdGFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2l0ZW0uc291cmNlLmlkfTpzY2FsZToke3JlbmRlclNjYWxlKGl0ZW0uc291cmNlKX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIClcclxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYElNQUdFIOWhq+WFhSAke2l0ZW0uc291cmNlLmlkfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5Dkvpske2xhYmVsfe+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7aXRlbS5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+W5s+mTuui1hOa6kOaMieWunumZheWwuuWvuOeUn+aIkCcsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgIGxldCByYXN0ZXI6IFJldHVyblR5cGU8dHlwZW9mIHJhc3Rlcml6ZVRpbGU+O1xyXG4gICAgICAgICAgICB0cnkgeyByYXN0ZXIgPSByYXN0ZXJpemVUaWxlKGNvbnRlbnRzLCByZXF1ZXN0ZWRTY2FsZShpdGVtLnNvdXJjZSksIHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSk7IH1cclxuICAgICAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3ml6Dms5XmjInlrp7pmYXlsLrlr7jnlJ/miJDvvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmFzdGVyLnJvdW5kZWQpIHdhcm5pbmdzLmFkZChg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3nmoTmmL7npLrlsLrlr7jlt7Llj5bmlbTkuLogJHtyYXN0ZXIud2lkdGh9w5cke3Jhc3Rlci5oZWlnaHR9IOWDj+e0oO+8iOacgOWwjyAx77yJ77yM6IqC54K5IFNjYWxlIOS/neaMgSAx44CCYCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFRpbGVkVXJsKGl0ZW0ubm9kZS5uYW1lLCBpdGVtLmFzc2V0S2V5LCAncG5nJyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgcGl4ZWxTaXplZFRpbGVBc3NldChhd2FpdCB3cml0ZXIucmVzb2x2ZSh1cmwsIHJhc3Rlci5jb250ZW50cywgeyBzb3VyY2VLZXk6IGdyb3VwU291cmNlS2V5KGl0ZW0uYXNzZXRLZXkpLCB0aWxlZDogdHJ1ZSB9KSksXHJcbiAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZVR5cGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHRyYWNlLmRvbmUoeyBzb3VyY2VXaWR0aDogcmFzdGVyLnNvdXJjZVdpZHRoLCBzb3VyY2VIZWlnaHQ6IHJhc3Rlci5zb3VyY2VIZWlnaHQsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogcmFzdGVyLndpZHRoLCBoZWlnaHQ6IHJhc3Rlci5oZWlnaHQsIHRpbGVTY2FsZTogMSB9KTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSZW1vdGUgPSBhc3luYyAobm9kZXM6IEZpZ21hTm9kZVtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFub2Rlcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmb3JtYXQgPSAncG5nJyBhcyBjb25zdDtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyB1cmw6IHN0cmluZzsgbm9kZXM6IEZpZ21hTm9kZVtdIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfWAsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzb3VyY2VLZXkobm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgdXJsLCBub2RlczogW10gfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogQXJyYXk8e1xyXG4gICAgICAgICAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcclxuICAgICAgICAgICAgdXJsOiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGJvcmRlcnM/OiB7IGxlZnQ6IG51bWJlcjsgcmlnaHQ6IG51bWJlcjsgdG9wOiBudW1iZXI7IGJvdHRvbTogbnVtYmVyIH07XHJcbiAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM/OiBTbGljZUFuYWx5c2lzO1xyXG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XHJcbiAgICAgICAgICAgIGtleTogQ2FjaGVFbnRyeUtleTtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH0+ID0gW107XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgeyB1cmwsIG5vZGVzOiBncm91cGVkTm9kZXMgfSBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQSBkZWNsYXJlZCBGaWdtYSBzbGljZSBvd25zIHRoaXMgc2FtZS1uYW1lIHJlc291cmNlIGV2ZW4gd2hlbiBhblxyXG4gICAgICAgICAgICAvLyBvcmRpbmFyeSBQTkcgd2FzIGVuY291bnRlcmVkIGZpcnN0LiBJTUFHRSBhbmQgZ3JhZGllbnQgc3RhZ2VzXHJcbiAgICAgICAgICAgIC8vIHJ1biBsYXRlciBhbmQgc2hhcmUgdGhpcyBzaW5nbGUgZ2VuZXJhdGVkIHJlc3VsdC5cclxuICAgICAgICAgICAgY29uc3Qgc2xpY2VkU291cmNlcyA9IGdyb3VwZWROb2Rlcy5mbGF0TWFwKChjYW5kaWRhdGUpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbkZvck5vZGUoY2FuZGlkYXRlLCBkZWNpc2lvbnMpLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBbXTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZVNsaWNlR3JpZChjYW5kaWRhdGUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGFuYWx5c2lzID8gW3sgbm9kZTogY2FuZGlkYXRlLCBhbmFseXNpcyB9XSA6IFtdO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWRTbGljZSA9IHNsaWNlZFNvdXJjZXNbMF07XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBzZWxlY3RlZFNsaWNlPy5ub2RlID8/IGdyb3VwZWROb2Rlc1swXTtcclxuICAgICAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBzZWxlY3RlZFNsaWNlPy5hbmFseXNpcyA/PyAoZGVjaXNpb24ubmluZVNsaWNlID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKSA6IG51bGwpO1xyXG4gICAgICAgICAgICBpZiAoc2VsZWN0ZWRTbGljZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2hhcGUgPSAoZW50cnk6IHR5cGVvZiBzZWxlY3RlZFNsaWNlKSA9PiBKU09OLnN0cmluZ2lmeSh7IG1vZGU6IGVudHJ5LmFuYWx5c2lzLm1vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyczogZW50cnkuYW5hbHlzaXMuYm9yZGVycywgZnJhbWU6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCAmJiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBlbnRyeS5ub2RlLmFic29sdXRlQm91bmRpbmdCb3gud2lkdGgsIGhlaWdodDogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9IH0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNsaWNlZFNvdXJjZXMuc2xpY2UoMSkuc29tZSgoZW50cnkpID0+IHNoYXBlKGVudHJ5KSAhPT0gc2hhcGUoc2VsZWN0ZWRTbGljZSkpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVhc29uID0gYOWQjOWQjeS4iS/kuZ3lrqvlrprkuYnkuI3lkIzvvIzmsr/nlKjpppbkuKrmnInmlYggRmlnbWEg5YiH54mH4oCcJHtub2RlLm5hbWV94oCd55qE5Y6f5aeL55S75biD5LiO6L656Led77yM5LuF55Sf5oiQ5LiA5Lu96LWE5rqQYDtcclxuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQocmVhc29uKTtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCdtZXJnZWQnLCBub2RlLm5hbWUsIHJlYXNvbiwgdXJsKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IGRlc3RpbmF0aW9uID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCB1cmwuc2xpY2UoJ2RiOi8vJy5sZW5ndGgpKTtcclxuICAgICAgICAgICAgICAgIGlmIChsb2NhbFJlc291cmNlcy5zb21lKChsaWJyYXJ5KSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3VmZml4ID0gcmVsYXRpdmUobGlicmFyeS5yb290LCBkZXN0aW5hdGlvbik7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICFzdWZmaXggfHwgKCFpc0Fic29sdXRlKHN1ZmZpeCkgJiYgc3VmZml4ICE9PSAnLi4nXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICYmICFzdWZmaXguc3RhcnRzV2l0aChgLi5cXFxcYCkgJiYgIXN1ZmZpeC5zdGFydHNXaXRoKCcuLi8nKSk7XHJcbiAgICAgICAgICAgICAgICB9KSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDkuIkv5Lmd5a6r6ZyA6KaB5YaZ5YWl6L6T5Ye655uu5b2V77yM5L2G6K+l55uu5b2V5L2N5LqO5oyH5a6a5pys5Zyw57Sg5p2Q5bqT5Lit77yb6K+36LCD5pW06L6T5Ye655uu5b2V77yM6YG/5YWN5L+u5pS557Sg5p2Q5bqT44CCJyk7XHJcbiAgICAgICAgICAgICAgICBub3RlKCdtZXJnZWQnLCBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgJ0ZpZ21hIOS4iS/kuZ3lrqvlrprkuYnkvJjlhYjvvJrkvb/nlKggRmlnbWEg5Y6f5aeL55S75biD5LiO6L656Led55Sf5oiQ6L6T5Ye66LWE5rqQ77yM5LiN5rK/55So5ZCM5ZCN57Sg5p2Q55qE5pen6L656LedJywgdXJsKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCByZXVzZUFzc2V0ID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsIHNvdXJjZTogJ2xvY2FsJyB8ICdleGlzdGluZycpID0+IHtcbiAgICAgICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBhc3NldCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlICYmICFhc3NldC5zbGljZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5bey55u05o6l5byV55So5ZCM5ZCN6LWE5rqQ77yM5L2G6K+lIFNwcml0ZUZyYW1lIOacqumFjee9ruS5neWuq+i+uei3ne+8jOaaguaMieaZrumAmiBTcHJpdGUg5pi+56S677yb6K+35Zyo5Y6f6LWE5rqQ5Lit6K6+572u6L656Led77yaJHthc3NldC51cmx9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXBlZE5vZGVzLCBhc3NldCwgc291cmNlKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBzaGFyZWQgPSBzbGljZUFuYWx5c2lzID8gdW5kZWZpbmVkIDogc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmIChzaGFyZWQpIHtcclxuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQoc2hhcmVkLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsTWF0Y2ggPSBzbGljZUFuYWx5c2lzIHx8IGFuYWx5emVNYXNrVGludChub2RlKSA/IG51bGwgOiBhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgICAgIC8vIFdpdGhvdXQgYSB2YWxpZCBGaWdtYSBzbGljZSwgcHJlc2VydmUgdGhlIGV4aXN0aW5nIGxvY2FsIG5hbWVcclxuICAgICAgICAgICAgLy8gbWFwcGluZywgVVVJRCBhbmQgc2xpY2UgYm9yZGVycyBldmVuIGR1cmluZyBhbiBleHBsaWNpdCByZWZyZXNoLlxyXG4gICAgICAgICAgICBjb25zdCBsb2NhbFVybCA9IGxvY2FsTWF0Y2hcbiAgICAgICAgICAgICAgICA/IGFzc2V0RGF0YWJhc2VVcmwobG9jYWxNYXRjaC5wYXRoKVxuICAgICAgICAgICAgICAgIDogbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsQXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybCkgOiBudWxsO1xuICAgICAgICAgICAgaWYgKGxvY2FsQXNzZXQpIHtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KGxvY2FsQXNzZXQsIGxvY2FsTWF0Y2ghLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChsb2NhbFVybCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5pys5Zyw6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM6K+35YWI5ZyoIENvY29zIOS4reWujOaIkOi1hOa6kOWvvOWFpeW5tuiuvue9ruS4uiBTcHJpdGVGcmFtZSDlkI7ph43or5XvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhc2xpY2VBbmFseXNpcyAmJiAhbG9jYWxNYXRjaCAmJiAhYW5hbHl6ZU1hc2tUaW50KG5vZGUpID8gYXdhaXQgZmluZE91dHB1dChub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lZEFzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKTtcclxuICAgICAgICAgICAgICAgIGlmICghbmFtZWRBc3NldCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XHJcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KG5hbWVkQXNzZXQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhc2xpY2VBbmFseXNpcykge1xuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneaXoOazleiuoeeul+i/nue7reWIh+eJh+i+ueeVjO+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWlYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBib3JkZXJzID0gc2xpY2VBbmFseXNpcz8uYm9yZGVycztcbiAgICAgICAgICAgIC8vIE5ldyBzbGljZWQgYXNzZXRzIHJldGFpbiB0aGVpciBleGFjdCBnZW9tZXRyaWMgY2FudmFzIGJlY2F1c2VcbiAgICAgICAgICAgIC8vIHRoZWlyIGdlbmVyYXRlZCBib3JkZXJzIHVzZSB0aGF0IGNvb3JkaW5hdGUgc3BhY2UuXG4gICAgICAgICAgICBjb25zdCByZW5kZXJGcmFtZSA9IGJvcmRlcnMgPyB1bmRlZmluZWQgOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpO1xuICAgICAgICAgICAgY29uc3Qga2V5OiBDYWNoZUVudHJ5S2V5ID0ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdmFyaWFudDogcmVuZGVyRnJhbWUgPyAndmlzdWFsLW92ZXJmbG93LXYxJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZCA9IGxvY2FsTWF0Y2ggfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGNhY2hlLnJlYWQoa2V5KTtcclxuICAgICAgICAgICAgaWYgKHNsaWNlQW5hbHlzaXMgJiYgY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCE7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpc0Z1bGxDYW52YXMgPSBpc1BuZyhjYWNoZWQpICYmIGNhY2hlZC5sZW5ndGggPj0gMjRcclxuICAgICAgICAgICAgICAgICAgICAmJiBjYWNoZWQudG9TdHJpbmcoJ2FzY2lpJywgMTIsIDE2KSA9PT0gJ0lIRFInXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMoY2FjaGVkLnJlYWRVSW50MzJCRSgxNikgLSBmcmFtZS53aWR0aCAqIGltcG9ydFNldHRpbmdzLnNjYWxlKSA8PSAxXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMoY2FjaGVkLnJlYWRVSW50MzJCRSgyMCkgLSBmcmFtZS5oZWlnaHQgKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSkgPD0gMTtcclxuICAgICAgICAgICAgICAgIGlmICghaXNGdWxsQ2FudmFzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FjaGVkID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgJ+e8k+WtmOS4jeaYryBGaWdtYSDlrozmlbTnlLvluIPvvIzph43mlrDlr7zlh7rljp/lp4sgUE5HIOWQjuWGjeW6lOeUqOS4iS/kuZ3lrqvovrnot50nLCB1cmwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XG4gICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICBub2RlczogZ3JvdXBlZE5vZGVzLFxuICAgICAgICAgICAgICAgIHVybDogbG9jYWxNYXRjaCAmJiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbE1hdGNoLmNvbnRlbnRzKSA9PT0gJ2pwZydcbiAgICAgICAgICAgICAgICAgICAgPyB1cmwucmVwbGFjZSgvXFwucG5nJC9pLCAnLmpwZycpIDogdXJsLFxuICAgICAgICAgICAgICAgIGJvcmRlcnMsXHJcbiAgICAgICAgICAgICAgICBzbGljZUFuYWx5c2lzOiBzbGljZUFuYWx5c2lzID8/IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgIHJlbmRlckZyYW1lOiBsb2NhbE1hdGNoID8gdW5kZWZpbmVkIDogcmVuZGVyRnJhbWUsXHJcbiAgICAgICAgICAgICAgICBrZXksXHJcbiAgICAgICAgICAgICAgICBjb250ZW50czogbG9jYWxNYXRjaD8uY29udGVudHMgPz8gY2FjaGVkLFxyXG4gICAgICAgICAgICAgICAgc291cmNlOiBsb2NhbE1hdGNoID8gJ2xvY2FsJyA6IGNhY2hlZCA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdXJsczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4gPSB7fTtcclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgZm9yIChjb25zdCB1c2VBYnNvbHV0ZUJvdW5kcyBvZiBbdHJ1ZSwgZmFsc2VdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGJhdGNoID0gcmVtb3RlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiAoXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyA/ICFpdGVtLnJlbmRlckZyYW1lIDogQm9vbGVhbihpdGVtLnJlbmRlckZyYW1lKVxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICAgICAgaWYgKCFiYXRjaC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odXJscywgYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBiYXRjaC5tYXAoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzLFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmZyb21FbnRyaWVzKGJhdGNoLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlLm5hbWVdKSksXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IHVybHNbaXRlbS5ub2RlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73muLLmn5PoioLngrnvvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZShpdGVtLmtleSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGxldCBhc3NldDogU3ByaXRlQXNzZXRTcGVjO1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5zbGljZUFuYWx5c2lzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5LiJL+S5neWuq+i1hOa6kOacgOWwj+WMlicsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB3cml0ZVNsaWNlZFBuZyh3cml0ZXIsIGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc2xpY2VBbmFseXNpcywgaW1wb3J0U2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgICAgICAgICAgICAgYXNzZXQgPSByZXN1bHQuYXNzZXQ7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5kb25lKHJlc3VsdC5vcHRpbWl6YXRpb24pO1xyXG4gICAgICAgICAgICAgICAgbm90ZShhc3NldC5zbGljZUZhbGxiYWNrID8gJ2ZhbGxiYWNrJyA6ICdtZXJnZWQnLCBpdGVtLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBg5LiJL+S5neWuq++8miR7cmVzdWx0Lm9wdGltaXphdGlvbi5yZWFzb24gPz8gcmVzdWx0Lm9wdGltaXphdGlvbi5zdGF0dXN9YCwgYXNzZXQudXJsKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGFzc2V0ID0gYXdhaXQgd3JpdGVyLndyaXRlKGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ib3JkZXJzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub3RlV3JpdGUoYXNzZXQpO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KGl0ZW0ubm9kZSksIGFzc2V0KTtcclxuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5YiH54mH6K6+572u5aSx6LSl77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaXvvJoke2Fzc2V0LnNsaWNlRmFsbGJhY2t9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGdyb3VwZWROb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7IC4uLmFzc2V0LCByZW5kZXJGcmFtZTogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShncm91cGVkTm9kZSkgPz8gaXRlbS5yZW5kZXJGcmFtZSB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyBub2RlOiBGaWdtYU5vZGU7IG5vZGVzOiBGaWdtYU5vZGVbXTsgaW1hZ2VSZWY6IHN0cmluZyB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSByZXNvdXJjZUtleShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGU6IGl0ZW0ubm9kZSwgbm9kZXM6IFtdLCBpbWFnZVJlZjogaXRlbS5pbWFnZVJlZiB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4+IHwgdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVJbWFnZXMgPSAobm9kZXM6IEZpZ21hTm9kZVtdLCBiYXNlOiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdleGlzdGluZycgfCAnY2FjaGUnIHwgJ2ZpZ21hJykgPT4ge1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGVzWzBdKSwgYmFzZSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgeyBpbm5lck9wYWNpdHkgfSA9IGltYWdlRGV0YWlscyhub2RlKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gaW5uZXJPcGFjaXR5IDwgMSA/IHsgLi4uYmFzZSwgdGludDogeyByOiAxLCBnOiAxLCBiOiAxLCBhOiBpbm5lck9wYWNpdHkgfSB9IDogYmFzZTtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNoYXJlZCA9IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkoZ3JvdXAubm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoc2hhcmVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2Rlcywgc2hhcmVkLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHsgbGVhZiB9ID0gaW1hZ2VEZXRhaWxzKGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChncm91cC5ub2RlLm5hbWUsIGZhbHNlKTtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFsb2NhbEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgbG9jYWxBc3NldCwgbWF0Y2ghLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBuYW1lZE91dHB1dCA9ICFtYXRjaCA/IGF3YWl0IGZpbmRPdXRwdXQoZ3JvdXAubm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbmFtZWRPdXRwdXQgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGxldCBzb3VyY2U6ICdjYWNoZScgfCAnZmlnbWEnID0gJ2NhY2hlJztcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgY2FjaGUucmVhZCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBjYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gY2FuZGlkYXRlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpbWFnZUZpbGxVcmxzUHJvbWlzZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGltYWdlRmlsbFVybHNQcm9taXNlID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZ2V0SW1hZ2VGaWxsVXJscyhzZXNzaW9uLmZpbGVLZXkpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBhd2FpdCBpbWFnZUZpbGxVcmxzUHJvbWlzZTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGltYWdlRmlsbFVybHNbZ3JvdXAuaW1hZ2VSZWZdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+m+makOiXj+WbvueJh+Whq+WFhe+8miR7Z3JvdXAubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHJlbW90ZVVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtncm91cC5ub2RlLm5hbWV9ICgke2dyb3VwLm5vZGUuaWR9KWApKTtcclxuICAgICAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHJlbW90ZVVybCwgdGFzayk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IHRhc2s7XHJcbiAgICAgICAgICAgICAgICBzb3VyY2UgPSAnZmlnbWEnO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbiA/Pz0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbGVhZi5maWxscy5maW5kKChwYWludCkgPT4gcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UgJiYgcGFpbnQudHlwZSA9PT0gJ0lNQUdFJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCByYXN0ZXIgPSByYXN0ZXJpemVJbWFnZUZpbGwoY29udGVudHMsIGZpbGw/LnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA9PT0gJ0ZJVCcgPyAnRklUJyA6ICdGSUxMJyxcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLCBmcmFtZS5oZWlnaHQsIGltcG9ydFNldHRpbmdzLnNjYWxlKTtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgZ3JvdXAubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fTppbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCByYXN0ZXIpO1xyXG4gICAgICAgICAgICBub3RlV3JpdGUocmVzb2x2ZWQpO1xyXG4gICAgICAgICAgICBpZiAoZ3JvdXAubm9kZS5jaGlsZHJlbi5sZW5ndGgpIG5vdGUoJ21lcmdlZCcsIGdyb3VwLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICfmma7pgJogSU1BR0Ug5Zyo6ZqQ6JeP5ZKM5pi+56S654q25oCB5L2/55So55u45ZCM5Lit5b+D6KOB5YiHL+mAgumFje+8m+a6kOWbvue8k+WtmOS/neeVmeWOn+Wni+WDj+e0oO+8jOiKgueCuemAj+aYjuW6puWNleeLrOW6lOeUqCcsIHJlc29sdmVkLnVybCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlSW1hZ2VzKGdyb3VwLm5vZGVzLCByZXNvbHZlZCwgc291cmNlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflubPpk7rotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy50aWxlZC5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1RpbGVkKHJlcXVlc3RzLnRpbGVkKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSHIFBORyDotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5wbmcubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5Y6f5aeLIElNQUdFIOWhq+WFhei1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1Jhd0ltYWdlcyhyZXF1ZXN0cy5yYXdJbWFnZXMpKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcmVxdWVzdHMuZ3JhZGllbnRzKSB7XHJcbiAgICAgICAgY29uc3Qgc2hhcmVkID0gc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShub2RlKSk7XHJcbiAgICAgICAgaWYgKHNoYXJlZCkge1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuYW1lZCA9IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlKTtcclxuICAgICAgICBjb25zdCBuYW1lZFVybCA9IG5hbWVkID8gYXNzZXREYXRhYmFzZVVybChuYW1lZC5wYXRoKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKG5hbWVkVXJsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKG5hbWVkVXJsKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZykgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkVXJsfWApO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBleGlzdGluZyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsIG5hbWVkIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbmFtZWQgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgIGlmIChuYW1lZE91dHB1dCkge1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBleGlzdGluZyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgIGNvbnN0IHBuZyA9IGZyYW1lICYmIGZpbGxcclxuICAgICAgICAgICAgPyBncmFkaWVudFBuZyhcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUuaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgZmlsbCxcclxuICAgICAgICAgICAgICAgIGNvcm5lclJhZGlpKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChwbmcpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9OmdyYWRpZW50YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcG5nKTtcclxuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgYXNzZXQpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCAnZ2VuZXJhdGVkJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOeUn+aIkOa4kOWPmCAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZXZlbnQgb2Ygd3JpdGVyLmV2ZW50cykgbm90ZShldmVudC5hY3Rpb24sIGJhc2VuYW1lKGV2ZW50LnVybCksIGV2ZW50LnJlYXNvbiwgZXZlbnQudXJsKTtcclxuICAgIHJldHVybiB7IGFzc2V0cywgd2FybmluZ3M6IFsuLi53YXJuaW5nc10gfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUZvbnRzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8TWFwPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZhbWlseSwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCByZXNvbHZlQXNzZXRVdWlkKHVybCk7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChmYW1pbHksIHV1aWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluZmVycmVkTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbmF0aXZlTW9kZSA9IGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpO1xyXG4gICAgaWYgKG5hdGl2ZU1vZGUpIHtcclxuICAgICAgICByZXR1cm4gbmF0aXZlTW9kZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZS5jaGlsZHJlblxyXG4gICAgICAgIC5tYXAoKGNoaWxkKSA9PiBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgIC5maWx0ZXIoKGZyYW1lKTogZnJhbWUgaXMgUmVjdCA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIGNvbnN0IGNlbnRlcnNYID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCAvIDIpO1xyXG4gICAgY29uc3QgY2VudGVyc1kgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCAvIDIpO1xyXG4gICAgY29uc3Qgc3ByZWFkWCA9IE1hdGgubWF4KC4uLmNlbnRlcnNYKSAtIE1hdGgubWluKC4uLmNlbnRlcnNYKTtcclxuICAgIGNvbnN0IHNwcmVhZFkgPSBNYXRoLm1heCguLi5jZW50ZXJzWSkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWSk7XHJcbiAgICBpZiAoc3ByZWFkWSA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdIT1JJWk9OVEFMJztcclxuICAgIH1cclxuICAgIGlmIChzcHJlYWRYIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIHJldHVybiAnR1JJRCc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtYWtlU3BlYyhcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwbGFuczogUmVhZG9ubHlNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4sXHJcbiAgICBub2RlQnlJZDogUmVhZG9ubHlNYXA8c3RyaW5nLCBGaWdtYU5vZGU+LFxyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+LFxyXG4gICAgZm9udHM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBpc1Jvb3QgPSBmYWxzZSxcclxuICAgIHBhcmVudFdvcmxkUm90YXRpb24gPSAwLFxyXG4pOiBTY2VuZU5vZGVTcGVjIHwgbnVsbCB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgcGxhbiA9IHBsYW5zLmdldChub2RlLmlkKTtcclxuICAgIGNvbnN0IGZvbGQgPSBwbGFuPy5mb2xkO1xyXG4gICAgY29uc3QgZm9sZFNvdXJjZSA9IGZvbGQgPyBub2RlQnlJZC5nZXQoZm9sZC5zb3VyY2VOb2RlSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgdGV4dFNvdXJjZSA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgdmlzdWFsU291cmNlID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgcmVzb2x2ZWRLaW5kID0gZGVjaXNpb24ua2luZCA9PT0gJ2F1dG8nID8gaW5mZXJLaW5kKG5vZGUpIDogZGVjaXNpb24ua2luZDtcclxuICAgIGNvbnN0IHBsYW5uZWRLaW5kID0gcGxhbj8ua2luZCA/PyByZXNvbHZlZEtpbmQ7XHJcbiAgICBjb25zdCBiaXRtYXBUZXJtaW5hbCA9IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInO1xyXG4gICAgY29uc3QgdGVybWluYWwgPSBiaXRtYXBUZXJtaW5hbCB8fCBpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbik7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0ga2luZEZvckltcG9ydEFjdGlvbihwbGFubmVkS2luZCwgZGVjaXNpb24uYWN0aW9uLCBkZWNpc2lvbi5uaW5lU2xpY2UpO1xyXG4gICAgY29uc3Qgc3ByaXRlU291cmNlSWQgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0J1xyXG4gICAgICAgID8gZm9sZC5zb3VyY2VOb2RlSWRcclxuICAgICAgICA6IG5vZGUuaWQ7XHJcbiAgICBjb25zdCBzcHJpdGVBc3NldCA9IGFzc2V0cy5nZXQoc3ByaXRlU291cmNlSWQpO1xyXG4gICAgY29uc3QgYWJzb3JiZWREaXJlY3RJZHMgPSBuZXcgU2V0KGZvbGQgPyBbZm9sZC5zb3VyY2VOb2RlSWRdIDogW10pO1xyXG4gICAgY29uc3QgZnVsbEZvbGQgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLWltYWdlJyB8fCBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IHBhcmVudFdvcmxkUm90YXRpb24gKyBub2RlLnJvdGF0aW9uO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYUlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IGRlY2lzaW9uLm5hbWUgPz8gbm9kZS5uYW1lLFxyXG4gICAgICAgIGZpZ21hVHlwZTogdmlzdWFsU291cmNlLnR5cGUsXHJcbiAgICAgICAgYWN0aW9uOiBkZWNpc2lvbi5hY3Rpb24sXHJcbiAgICAgICAga2luZDogZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBmcmFtZSxcclxuICAgICAgICBwYXJlbnRGcmFtZSxcclxuICAgICAgICBpbnRyaW5zaWNTaXplOiBub2RlLnNpemUsXHJcbiAgICAgICAgaXNSb290LFxyXG4gICAgICAgIHJvdGF0aW9uOiBub2RlLnJvdGF0aW9uLFxyXG4gICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgb3BhY2l0eTogZm9sZFNvdXJjZSAmJiBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IG5vZGUub3BhY2l0eSAqIGZvbGRTb3VyY2Uub3BhY2l0eVxyXG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCxcclxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcclxuICAgICAgICBmaWxsczogdGV4dFNvdXJjZS5maWxscyxcclxuICAgICAgICBzdHJva2VzOiB0ZXh0U291cmNlLnN0cm9rZXMsXHJcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0ZXh0U291cmNlLmNoYXJhY3RlcnMsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0U291cmNlLnN0eWxlLFxyXG4gICAgICAgIGxheW91dDoge1xyXG4gICAgICAgICAgICBtb2RlOiBlZmZlY3RpdmVLaW5kID09PSAnbGF5b3V0JyB8fCBlZmZlY3RpdmVLaW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgICAgID8gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgc291cmNlTW9kZTogbm9kZS5sYXlvdXRNb2RlLFxyXG4gICAgICAgICAgICB3cmFwOiBub2RlLmxheW91dFdyYXAsXHJcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIGNvdW50ZXJBbGlnbjogbm9kZS5jb3VudGVyQXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIHByaW1hcnlTaXppbmc6IG5vZGUucHJpbWFyeUF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgaXRlbVNwYWNpbmc6IG5vZGUuaXRlbVNwYWNpbmcsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTcGFjaW5nOiBub2RlLmNvdW50ZXJBeGlzU3BhY2luZyxcclxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdSaWdodDogbm9kZS5wYWRkaW5nUmlnaHQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdUb3A6IG5vZGUucGFkZGluZ1RvcCxcclxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb3ZlcmZsb3dEaXJlY3Rpb246IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24sXHJcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXHJcbiAgICAgICAgcmVsYXRpdmVUcmFuc2Zvcm06IG5vZGUucmVsYXRpdmVUcmFuc2Zvcm0sXHJcbiAgICAgICAgc3ByaXRlOiBzcHJpdGVBc3NldCxcclxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICBmbGF0dGVuQm91bmRhcnk6IGJpdG1hcFRlcm1pbmFsIHx8IGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gdHJ1ZVxyXG4gICAgICAgICAgICA6IGZvbGQ/LmtpbmQgPT09ICdiYWNrZ3JvdW5kJ1xyXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgcGxhblJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgIGNoaWxkcmVuOiB0ZXJtaW5hbFxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogbm9kZS5jaGlsZHJlblxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+ICFhYnNvcmJlZERpcmVjdElkcy5oYXMoY2hpbGQuaWQpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLFxyXG4gICAgICAgICAgICAgICAgICAgIGZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICAgICAgICAgICkpXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCk6IGNoaWxkIGlzIFNjZW5lTm9kZVNwZWMgPT4gY2hpbGQgIT09IG51bGwpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZU1hcHMoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvY29zRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBFZGl0b3IuVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICByZXR1cm4gdHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDBcclxuICAgICAgICA/IGdlbmVyYXRlZFxyXG4gICAgICAgIDogcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjQnKS5yZXBsYWNlKC89KyQvZywgJycpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYkFzc2V0KHVybE9yVXVpZDogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8gfCBudWxsPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcclxuICAgICAgICB1cmxPclV1aWQsXHJcbiAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydFByZWZhYkFzc2V0KFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgZXhwZWN0ZWQ6IHsgdXVpZD86IHN0cmluZzsgdXJsPzogc3RyaW5nIH0gPSB7fSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoaW5mby5pbnZhbGlkIHx8IGluZm8uaW1wb3J0ZWQgIT09IHRydWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlsJrmnKrlrozmiJDlr7zlhaXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8uaW1wb3J0ZXIgIT09ICdwcmVmYWInIHx8IGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicgfHwgaW5mby5pc0RpcmVjdG9yeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCH6LWE5rqQ5LiN5piv5Y+v57yW6L6R55qEIENvY29zIFByZWZhYu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5yZWFkb25seSB8fCBpbmZvLnJlZGlyZWN0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOS4uuWPquivu+aIlumHjeWumuWQkei1hOa6kO+8jOS4jeiDveWuieWFqOabtOaWsO+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkLnV1aWQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOagoemqjOWksei0pe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXJsICYmIGluZm8udXJsICE9PSBleHBlY3RlZC51cmwpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDot6/lvoTmoKHpqozlpLHotKXvvJrmnJ/mnJsgJHtleHBlY3RlZC51cmx977yM5a6e6ZmFICR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JQcmVmYWJBc3NldCh1cmw6IHN0cmluZywgZXhwZWN0ZWRVdWlkPzogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodXJsKTtcclxuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvY29zIFByZWZhYiDotYTmupDlr7zlhaXlpLHotKXvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGluZm8/LmltcG9ydGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIGlmIChleHBlY3RlZFV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5Zyo5a+85YWl5pyf6Ze05Y+R55Sf5Y+Y5YyW77yaJHt1cmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQoaW5mbywgeyB1dWlkOiBleHBlY3RlZFV1aWQsIHVybCB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGluZm87XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3MgUHJlZmFiIOi1hOa6kOWwsee7qui2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYk1ldGEodXVpZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xyXG4gICAgY29uc3QgbWV0YSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgdXVpZCxcclxuICAgICk7XHJcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xor7vlj5YgUHJlZmFiIE1ldGHvvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IG1ldGEgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgIGlmICh2YWx1ZS51dWlkICE9PSB1dWlkIHx8IHZhbHVlLmltcG9ydGVyICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIE1ldGEg5LiO55uu5qCH6LWE5rqQ5LiN5Yy56YWN77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJEaXNrUGF0aCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVJMIOaXoOaViO+8miR7dXJsfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgdXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZChcclxuICAgICAgICAgICAgYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgoaW5mby51cmwpKSxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgICk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZyxcclxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBjdXJyZW50RGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICBpZiAoY3VycmVudERpcnR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3miZPlvIDnmoTlnLrmma/miJYgUHJlZmFiIOacieacquS/neWtmOS/ruaUue+8m+S4uumBv+WFjeinpuWPkeS/neWtmOivoumXru+8jOivt+WFiOaJi+W3peS/neWtmOaIlui/mOWOn+WQjuWGjeWvvOWFpeOAgicpO1xyXG4gICAgfVxyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdvcGVuLWFzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGxldCBsYXN0UmVhc29uID0gJ0NyZWF0b3Ig5bCa5pyq6L+U5ZueIFByZWZhYiDnvJbovpHnirbmgIEnO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgICAgICAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBzdGF0ZS5yZWFzb24gPz8gbGFzdFJlYXNvbjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg5omT5byA55uu5qCHIFByZWZhYiDotoXml7bvvJoke2xhc3RSZWFzb259YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFzc2VydE9wZW5lZFByZWZhYihwcmVmYWJVdWlkOiBzdHJpbmcsIHJvb3RGaWxlSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDnvJbovpHkuIrkuIvmloflt7Llj5jljJbvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjZW5lU2F2ZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDE1XzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmICghZGlydHkpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ+etieW+hSBQcmVmYWIg5L+d5a2Y5a6M5oiQ6LaF5pe244CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFByZWZhYkJpbmRpbmdzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHByZWZhYlV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcHJlZmFiVXVpZCAhPT0gJ3N0cmluZydcclxuICAgICAgICAgICAgfHwgIXByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ57uR5a6a6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZywgcHJlZmFiVXVpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBiaW5kaW5nc1tzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBpZiAoIWJpbmRpbmdzW3NvdXJjZUhhc2hdKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVsZXRlIGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgIXJhd1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0J1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgKHJhdyBhcyB7IHByZWZhYlV1aWQ/OiB1bmtub3duIH0pLnByZWZhYlV1aWQgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZCh7XHJcbiAgICAgICAgICAgIHVzZXJEYXRhOiB7XHJcbiAgICAgICAgICAgICAgICBmaWdtYUltcG9ydGVyOiAocmF3IGFzIHsgcmVjb3JkPzogdW5rbm93biB9KS5yZWNvcmQsXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5p2l5rqQ5LiN5LiA6Ie077yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogKHJhdyBhcyB7IHByZWZhYlV1aWQ6IHN0cmluZyB9KS5wcmVmYWJVdWlkLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFBlbmRpbmdQcmVmYWJTeW5jKFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfSB8IG51bGwsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcGVuZGluZyA9IGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpO1xyXG4gICAgaWYgKHZhbHVlKSB7XHJcbiAgICAgICAgcGVuZGluZ1tzb3VyY2VIYXNoXSA9IHZhbHVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgcGVuZGluZ1tzb3VyY2VIYXNoXTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgcGVuZGluZyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB2ZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7IG1ldGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4ge1xyXG4gICAgbGV0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgIGxldCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgIGlmICghcmVjb3JkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBgUHJlZmFiIOe8uuWwkSBGaWdtYSDmnaXmupDorrDlvZXvvIzml6Dms5Xnoa7orqTmmK/lkKblj6/lronlhajopobnm5bvvJoke2luZm8udXJsfeOAguivt+WFiOenu+WKqOaIlumHjeWRveWQjeivpei1hOa6kOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxuICAgIGlmIChyZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOadpeiHquWPpuS4gOS4qiBGaWdtYSBGcmFtZe+8jOW3suaLkue7neimhueblu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGlmIChwZW5kaW5nKSB7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcucHJlZmFiVXVpZCAhPT0gaW5mby51dWlkIHx8IHBlbmRpbmcucmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmo4DmtYvliLDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtOeahOW+heaBouWkjeWQjOatpeiusOW9le+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCBwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCBwZW5kaW5nLnJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFyZWNvdmVyZWQgfHwgSlNPTi5zdHJpbmdpZnkocmVjb3ZlcmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXorrDlvZXoh6rliqjmgaLlpI3lpLHotKXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZWNvcmQgPSByZWNvdmVyZWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCByZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuS4juW9k+WJjeWPiuW+heaBouWkjeeahOWQjOatpeiusOW9lemDveS4jeS4gOiHtO+8jOW3suWBnOatouiHquWKqOaBouWkjeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IG1ldGEsIHJlY29yZCB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGxldCBsYXN0RXJyb3I6IHVua25vd247XHJcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8IDM7IGF0dGVtcHQgKz0gMSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WGmeWFpeWJjSBQcmVmYWIg5p2l5rqQ6K6w5b2V5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xyXG4gICAgICAgICAgICBpZiAoIXNhdmVkIHx8IEpTT04uc3RyaW5naWZ5KHNhdmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5ZCO5qCh6aqM5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xyXG4gICAgICAgICAgICBpZiAoYXR0ZW1wdCA8IDIpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxNTApKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IGxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbGFzdEVycm9yIDogbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5aSx6LSl44CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nLFxyXG4gICAgcm9vdEZyYW1lOiBSZWN0LFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgc291cmNlUm9vdElkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8e1xyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59PiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBjb25zdCBib3VuZFV1aWQgPSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZ0luZm8gPSBwZW5kaW5nXHJcbiAgICAgICAgPyBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHBlbmRpbmcucHJlZmFiVXVpZClcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBjb25zdCB0YXJnZXRQbGFuID0gcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0KFxyXG4gICAgICAgIHBlbmRpbmc/LnByZWZhYlV1aWQsXHJcbiAgICAgICAgYm91bmRVdWlkLFxyXG4gICAgICAgIEJvb2xlYW4ocGVuZGluZ0luZm8pLFxyXG4gICAgKTtcclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyUGVuZGluZykge1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJCaW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSB0YXJnZXRQbGFuLnRhcmdldFV1aWQ7XHJcbiAgICBpZiAodGFyZ2V0VXVpZCkge1xyXG4gICAgICAgIGxldCB0YXJnZXRJbmZvID0gcGVuZGluZ0luZm8/LnV1aWQgPT09IHRhcmdldFV1aWRcclxuICAgICAgICAgICAgPyBwZW5kaW5nSW5mb1xyXG4gICAgICAgICAgICA6IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgaWYgKCF0YXJnZXRJbmZvKSB7XHJcbiAgICAgICAgICAgIGlmIChiaW5kaW5nc1tzb3VyY2VIYXNoXSA9PT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQodGFyZ2V0SW5mby51cmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICBpZiAocGVuZGluZz8ucHJlZmFiVXVpZCA9PT0gdGFyZ2V0VXVpZCAmJiBib3VuZFV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIHJlY292ZXJ5IGlkZW50aXR5IGJlZm9yZSB2ZXJpZmllZFByZWZhYlJlY29yZCBtYXlcclxuICAgICAgICAgICAgICAgIC8vIGNvbW1pdCBhbmQgY2xlYXIgcGVuZGluZy4gQSBsYXRlciBtb3ZlIGZhaWx1cmUgbXVzdCBzdGlsbCBiZVxyXG4gICAgICAgICAgICAgICAgLy8gYWJsZSB0byBsb2NhdGUgdGhlIGV4YWN0IFByZWZhYiBieSBVVUlEIG9uIHRoZSBuZXh0IGF0dGVtcHQuXHJcbiAgICAgICAgICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQodGFyZ2V0SW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIGlmICh0YXJnZXRJbmZvLnVybCAhPT0gcHJlZmFiVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb25mbGljdCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmIChjb25mbGljdCAmJiBjb25mbGljdC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmlnbWEgRnJhbWUg5a+55bqU55qEIFByZWZhYiDpnIDopoHnp7vliqjliLAgJHtwcmVmYWJVcmx977yM5L2G55uu5qCH6Lev5b6E5bey6KKr5YW25LuW6LWE5rqQ5Y2g55So44CCYCxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFjb25mbGljdCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vdmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ21vdmUtYXNzZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvLnVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICAgICAgICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3ZlZCB8fCBtb3ZlZC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Zyo5L+d55WZIFVVSUQg55qE5YmN5o+Q5LiL56e75YqoIFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaW5mbzogdGFyZ2V0SW5mbyxcclxuICAgICAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm1GaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHNlZWQgPSBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbihcclxuICAgICAgICAgICAgcHJlZmFiTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdjcmVhdGUtYXNzZXQnLFxyXG4gICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgIHNlZWQsXHJcbiAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7ogUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBjcmVhdGVkLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCByZWNvcmQgPSBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgICAgICBzb3VyY2VSb290SWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBuZXh0TWV0YSA9IG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG5leHRNZXRhLCBudWxsLCAyKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpbmZvLFxyXG4gICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpbmZvLFxyXG4gICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoYXJnczoge1xyXG4gICAgcmV2aWV3SWQ6IHN0cmluZztcclxuICAgIHByZWZhYlVybDogc3RyaW5nO1xyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgc291cmNlTm9kZUlkOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufSk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHNvdXJjZUhhc2ggPSBmaWdtYUZyYW1lU291cmNlSGFzaChhcmdzLmZpbGVLZXksIGFyZ3Muc291cmNlTm9kZUlkKTtcclxuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgICAgIGFyZ3MucHJlZmFiVXJsLFxyXG4gICAgICAgIGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIHg6IGFyZ3Mucm9vdEZyYW1lLnggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB5OiBhcmdzLnJvb3RGcmFtZS55ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgd2lkdGg6IGFyZ3Mucm9vdEZyYW1lLndpZHRoICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgaGVpZ2h0OiBhcmdzLnJvb3RGcmFtZS5oZWlnaHQgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICBhcmdzLnJvb3RzWzBdLmZpZ21hSWQsXHJcbiAgICApO1xyXG4gICAgYXdhaXQgd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICApO1xyXG4gICAgY29uc3QgZXhpc3RpbmdOb2RlRmlsZUlkcyA9IHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZCxcclxuICAgICAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMoYXJncy5yb290cyksXHJcbiAgICApO1xyXG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgIHJldmlld0lkOiBhcmdzLnJldmlld0lkLFxyXG4gICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcclxuICAgICAgICByb290TmFtZTogYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHJvb3RGcmFtZTogYXJncy5yb290RnJhbWUsXHJcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgZXhpc3RpbmdNYXA6IHt9LFxyXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcm9vdHM6IGFyZ3Mucm9vdHMsXHJcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQ6IHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XHJcbiAgICBsZXQgc2F2ZUF0dGVtcHRlZCA9IGZhbHNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoZGlydHlCZWZvcmVJbXBvcnQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnm67moIcgUHJlZmFiIOacieacquS/neWtmOeahOaJi+W3peS/ruaUue+8jOivt+WFiOS/neWtmOWQjuWGjeaJp+ihjCBGaWdtYSDlop7ph4/lr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBzbmFwc2hvdFN0YXJ0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBpZiAoIXJlc3VsdC5wcmVmYWJTeW5jKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5leHRSZWNvcmQgPSByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShwcmVwYXJlZC5yZWNvcmQsIHJlc3VsdC5wcmVmYWJTeW5jKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkOiBuZXh0UmVjb3JkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGF3YWl0IGFzc2VydE9wZW5lZFByZWZhYihwcmVwYXJlZC5pbmZvLnV1aWQsIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkKTtcclxuICAgICAgICAvLyBPbmNlIHRoZSBzYXZlIHJlcXVlc3QgaXMgc2VudCBpdHMgcmVzdWx0IGlzIGFtYmlndW91cyB1bnRpbCB0aGVcclxuICAgICAgICAvLyBwZXJzaXN0ZWQgUHJlZmFiIGlzIHZlcmlmaWVkLiBEbyBub3Qgcm9sbCB0aGUgaW4tbWVtb3J5IFByZWZhYiBiYWNrXHJcbiAgICAgICAgLy8gb24gYW4gSVBDIHRpbWVvdXQ6IHRoZSBkaXNrIHdyaXRlIG1heSBhbHJlYWR5IGhhdmUgY29tcGxldGVkLlxyXG4gICAgICAgIHNhdmVBdHRlbXB0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yU2NlbmVTYXZlZCgpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChjdXJyZW50SW5mbywgbmV4dFJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25pyq5YyF5ZCr5pys5qyh5ZCM5q2l55Sf5oiQ55qE5YWo6YOoIGZpbGVJZO+8jOW3suWBnOatouabtOaWsCBNZXRh44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRNZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGN1cnJlbnRJbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChjdXJyZW50TWV0YSk7XHJcbiAgICAgICAgaWYgKCFjdXJyZW50UmVjb3JkIHx8IGN1cnJlbnRSZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlnKjkv53lrZjmnJ/pl7Tlj5HnlJ/lj5jljJbvvIzlt7Lmi5Lnu53mj5DkuqTjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChjdXJyZW50SW5mbywgc291cmNlSGFzaCwgbmV4dFJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsKTtcclxuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCOIFByZWZhYiBVVUlEIOagoemqjOWksei0peOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xyXG4gICAgICAgICAgICB1dWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzdWx0LnByZWZhYlVybCA9IHByZXBhcmVkLmluZm8udXJsO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcclxuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QtYWJvcnQnKTsgfVxyXG4gICAgICAgICAgICBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgKGVycm9yIGFzIEVycm9yICYgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSkucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzYXZlQXR0ZW1wdGVkICYmIGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIChlcnJvciBhcyBFcnJvciAmIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pLnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybUltcG9ydChyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0LCBvcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwsIG9wdGlvbnM6IHtcclxuICAgIGRvY3VtZW50PzogRG9jdW1lbnRTZXNzaW9uOyBwcmVzZXJ2ZVJldmlld3M/OiBib29sZWFuOyBzaWxlbnRSZXZpZXc/OiBib29sZWFuO1xyXG59ID0ge30pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IG9wdGlvbnMuZG9jdW1lbnQgPz8gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBpZiAoIWRvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbXBvcnRTZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbihvcGVyYXRpb25Pd25lcik7XHJcbiAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5a+85YWl5Lu75YqhJywgeyByb290czogZG9jdW1lbnQucm9vdHMubWFwKChub2RlKSA9PiAoeyBpZDogbm9kZS5pZCwgbmFtZTogbm9kZS5uYW1lIH0pKSB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5YiG5p6Q5bm25YeG5aSH6LWE5rqQ4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChyZXF1ZXN0Lm92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3RG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICBpbXBvcnRSZXZpZXdzLmludmFsaWRhdGUob3B0aW9ucy5wcmVzZXJ2ZVJldmlld3MgPyB7IHByZXNlcnZlSGlzdG9yeTogdHJ1ZSB9IDogdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zdCByZXZpZXdSZWNvcmRlciA9IG5ldyBJbXBvcnRSZXZpZXdSZWNvcmRlcigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWx0QXNzZXRzID0gYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WFqOmDqOi1hOa6kCcsIHVuZGVmaW5lZCwgKCkgPT4gYnVpbGRBc3NldHMoZG9jdW1lbnQsIGRlY2lzaW9ucywgaW1wb3J0U2V0dGluZ3MsIHJldmlld1JlY29yZGVyKSk7XHJcbiAgICAgICAgY29uc3QgeyBhc3NldHMsIHdhcm5pbmdzIH0gPSBidWlsdEFzc2V0cztcclxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgY29uc3QgYXR0YWNoUmV2aWV3ID0gYXN5bmMgKHJlc3VsdDogU2NlbmVJbXBvcnRSZXN1bHQpID0+IHtcclxuICAgICAgICAgICAgcmVzdWx0LnJldmlldyA9IGF3YWl0IGZpbmFsaXplSW1wb3J0UmV2aWV3KGltcG9ydFJldmlld3MsIHJldmlld1JlY29yZGVyLCByZXZpZXdEb2N1bWVudCxcclxuICAgICAgICAgICAgICAgIHJlc3VsdC5yZXZpZXdCZWZvcmUsIHJlc3VsdC5yZXZpZXdBZnRlciwgcmVzdWx0LnByZWZhYlVybCwgd2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICBhc3luYyAoKSA9PiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLCBtZXRob2Q6ICdyZWZyZXNoUmV2aWV3QWZ0ZXInLCBhcmdzOiBbeyBpZDogcmV2aWV3UmVjb3JkZXIuaWQgfV0sXHJcbiAgICAgICAgICAgICAgICB9KSBhcyBSZXZpZXdTY2VuZSk7XHJcbiAgICAgICAgICAgIC8vIEFsc28gY292ZXIgbWFudWFsIGltcG9ydHMgd2hvc2UgcGFuZWwgd2FzIGNsb3NlZCB3aGlsZSBpbXBvcnRpbmcuXHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucy5zaWxlbnRSZXZpZXcpIHtcclxuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0JlZm9yZTtcclxuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAnaW1wb3J0LXJldmlldy1yZWFkeScsIHJlc3VsdC5yZXZpZXcpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChg57uT5p6c5bey5L+d5a2Y77yM5L2G6Ieq5Yqo5omT5byA6Z2i5p2/5aSx6LSl77yM6K+35LuO5o+S5Lu25Lit5omT5byA4oCc5a+85YWl57uT5p6c5qOA5p+l4oCd77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QWZ0ZXI7XHJcbiAgICAgICAgfTtcclxuICAgICAgICAvLyBidWlsZEFzc2V0cyBtYXkgcHJvbW90ZSBhIGNvbnRhaW5lciB0byBhIGxvY2FsIHNhbWUtbmFtZSByZXNvdXJjZS5cclxuICAgICAgICAvLyBDb21waWxlIGFmdGVyIHRoYXQgcHJvbW90aW9uIHNvIGFzc2V0cyBhbmQgU2NlbmVOb2RlU3BlYyBzaGFyZSB0aGVcclxuICAgICAgICAvLyBleGFjdCBzYW1lIGZpbmFsIHBsYW4uXHJcbiAgICAgICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCBmb250cyA9IGF3YWl0IHJlc29sdmVGb250cyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlUm9vdEZyYW1lcyA9IGRvY3VtZW50LnJvb3RzLm1hcChub2RlRnJhbWUpO1xyXG4gICAgICAgIGNvbnN0IG11bHRpcGxlUm9vdHMgPSBkb2N1bWVudC5yb290cy5sZW5ndGggPiAxO1xyXG4gICAgICAgIGNvbnN0IGFycmFuZ2VkV2lkdGggPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8gc291cmNlUm9vdEZyYW1lcy5yZWR1Y2UoKHRvdGFsLCBmcmFtZSkgPT4gdG90YWwgKyBmcmFtZS53aWR0aCwgMClcclxuICAgICAgICAgICAgICAgICsgTWF0aC5tYXgoMCwgc291cmNlUm9vdEZyYW1lcy5sZW5ndGggLSAxKSAqIDE2MFxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0/LndpZHRoID8/IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZyYW1lID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHg6IDAsXHJcbiAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGFycmFuZ2VkV2lkdGgsXHJcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IE1hdGgubWF4KDAsIC4uLnNvdXJjZVJvb3RGcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KSksXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdID8/IHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgICAgIGxldCByb290Q3Vyc29yID0gMDtcclxuICAgICAgICBjb25zdCByb290cyA9IGRvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgICAgIC5tYXAoKG5vZGUsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzcGVjID0gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjICYmIG11bHRpcGxlUm9vdHMpIHtcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmZyYW1lID0ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB4OiByb290Q3Vyc29yLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0uaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEN1cnNvciArPSBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCArIDE2MDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBzcGVjO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuZmlsdGVyKChub2RlKTogbm9kZSBpcyBTY2VuZU5vZGVTcGVjID0+IG5vZGUgIT09IG51bGwpO1xyXG4gICAgICAgIGlmICghcm9vdHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ6YCJ5Lit5Lu75L2V5Y+v5a+85YWl6IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBzb3VyY2VOb2RlSWQgPSBkb2N1bWVudC5zb3VyY2VOb2RlSWQ7XHJcbiAgICAgICAgaWYgKHNvdXJjZU5vZGVJZCAmJiByb290cy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiV3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLnByZWZhYkZvbGRlcik7XHJcbiAgICAgICAgICAgIGF3YWl0IHByZWZhYldyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lTmFtZSA9IHJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGRvY3VtZW50LnJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJVcmwgPSBgZGI6Ly9hc3NldHMvJHtwcmVmYWJXcml0ZXIuZm9sZGVyfS8ke3Nhbml0aXplQXNzZXROYW1lKGZyYW1lTmFtZSl9LnByZWZhYmA7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ3NjZW5lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAwLjA1LFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ+ato+WcqOWIm+W7uuaIluaJk+W8gOebruaghyBQcmVmYWLigKYnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoe1xyXG4gICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJldmlld1JlY29yZGVyLmlkLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiTmFtZTogZnJhbWVOYW1lLFxyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZU5vZGVJZCxcclxuICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgICAgICAvLyBQcmVmYWIgdXBkYXRlcyBwZXJzaXN0IGJ5IFByZWZhYkluZm8uZmlsZUlkIGluIHRoZSBhc3NldCBtZXRhO1xyXG4gICAgICAgICAgICAvLyBydW50aW1lIG5vZGUgVVVJRHMgYXJlIHNlc3Npb24tb25seSBhbmQgbXVzdCBuZXZlciBiZSByZXVzZWQgaGVyZS5cclxuICAgICAgICAgICAgZGVsZXRlIG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcclxuICAgICAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH3vvIzlt7LmiZPlvIDpooTliLbkvZMgJHtwcmVmYWJVcmx9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLpgIDogJyd9YCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIHJvb3ROYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbXBvcnRTZXR0aW5ncy51cGRhdGVFeGlzdGluZyxcclxuICAgICAgICAgICAgZXhpc3RpbmdNYXA6IG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID8/IHt9LFxyXG4gICAgICAgICAgICByb290cyxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMC4xLCBtZXNzYWdlOiAn5q2j5Zyo5p6E5bu6IENvY29zIOiKgueCueagkeKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPSByZXN1bHQubm9kZU1hcDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdub2RlJywgcmVzdWx0LnJvb3RVdWlkKTtcclxuICAgICAgICBpZiAoaW1wb3J0U2V0dGluZ3MuYXV0b1NhdmUpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcclxuICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLpgIDogJyd9YCxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0cmFjZS5kb25lKCk7XHJcbiAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBDYW5jZWxsZWRFcnJvciB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnY2FuY2VsbGVkJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflt7Llj5bmtojjgIInIH0pO1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aTjeS9nOW3suWPlua2iOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgicsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB0cmFjZS5ldmVudCgn5ZCO5Y+w5Lu75Yqh5bey6YeK5pS+Jyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE1jcFBsdWdpblN0YXRlKCkge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICB2YXVsdDogdmF1bHQuc3RhdHVzKCksXHJcbiAgICAgICAgc2V0dGluZ3M6IGF3YWl0IGdldFNldHRpbmdzKCksXHJcbiAgICAgICAgZG9jdW1lbnQ6IGRvY3VtZW50ID8ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLFxyXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgIG5vZGVPdmVycmlkZXM6IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSksXHJcbiAgICAgICAgfSA6IG51bGwsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQbHVnaW5TdGF0ZSgpIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uYXdhaXQgZ2V0TWNwUGx1Z2luU3RhdGUoKSxcclxuICAgICAgICBmb250QXNzZXRzOiBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjE1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+WIEZpZ21hIOaWh+S7tuKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHBhcnNlZC5ub2RlSWRcclxuICAgICAgICAgICAgPyBhd2FpdCBhcGkuZ2V0Tm9kZShwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZClcclxuICAgICAgICAgICAgOiBhd2FpdCBhcGkuZ2V0RmlsZShwYXJzZWQuZmlsZUtleSk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhbm5vdGF0ZURvY3VtZW50UGxhbihcclxuICAgICAgICAgICAgcGFyc2VEb2N1bWVudChwYXlsb2FkLCBzb3VyY2VVcmwsIHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xyXG4gICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyh7IC4uLmN1cnJlbnQsIHNvdXJjZVVybCB9KTtcclxuICAgICAgICBjb25zdCBmb250QXNzZXRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgICAgICBjb25zdCBub2RlT3ZlcnJpZGVzID0gYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KTtcclxuICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2lkbGUnLCB2YWx1ZTogMSwgbWVzc2FnZTogYOW3suivu+WPliAke2RvY3VtZW50LmZpbGVOYW1lfWAgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgZm9udEFzc2V0cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlcyxcclxuICAgICAgICB9O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uLCBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW10pOiBQcm9taXNlPEJhdGNoRG9jdW1lbnREdG8+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLCBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLCBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgZm9udEFzc2V0czogZm9udEFzc2V0cyA/PyBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxyXG4gICAgICAgIG5vZGVPdmVycmlkZXM6IChhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpKS5maWx0ZXIoKGl0ZW0pID0+IGRvY3VtZW50Lm5vZGVCeUlkLmhhcyhpdGVtLmlkKSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQmF0Y2hTb3VyY2Uoc291cmNlVXJsOiBzdHJpbmcpOiBQcm9taXNlPEJhdGNoU291cmNlUmVzdWx0PiB7XHJcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICBpZiAoIXBhcnNlZC5ub2RlSWQpIHtcclxuICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuc2l6ZSkgdGhyb3cgbmV3IEVycm9yKCfmlbTku73mlofku7bor7fljZXni6zlr7zlhaXvvJvor7flhYjnp7vpmaTmibnph4/nlYzpnaLliJfooajvvIzmiJbkvb/nlKggU2VjdGlvbiAvIEZyYW1lIOmTvuaOpeOAgicpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICAgICAgcmV0dXJuIHsgc291cmNlVHlwZTogJ2ZpbGUnLCBzb3VyY2VVcmwsIGl0ZW1zOiBbXSwgYWRkZWQ6IDAsIGR1cGxpY2F0ZXM6IDAsIGRvY3VtZW50IH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjE1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+W5bm26K+G5YirIFNlY3Rpb24gLyBGcmFtZeKApicgfSk7XHJcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcclxuICAgICAgICBjb25zdCBwYXJzZWREb2N1bWVudCA9IHBhcnNlRG9jdW1lbnQoYXdhaXQgYXBpLmdldE5vZGUocGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmwsIHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKTtcclxuICAgICAgICBjb25zdCByb290ID0gcGFyc2VkRG9jdW1lbnQucm9vdHNbMF07XHJcbiAgICAgICAgY29uc3QgZm9udEFzc2V0cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICAgICAgaWYgKHJvb3QudHlwZSAhPT0gJ1NFQ1RJT04nICYmIHJvb3QudHlwZSAhPT0gJ0ZSQU1FJykge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuc2l6ZSkgdGhyb3cgbmV3IEVycm9yKCfmibnph4/liJfooajlj6rmjqXlj5cgU2VjdGlvbiDmiJYgRnJhbWXvvJvlhbbku5boioLngrnor7fmuIXnqbrliJfooajlkI7ljZXni6zlr7zlhaXjgIInKTtcclxuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhbm5vdGF0ZURvY3VtZW50UGxhbihwYXJzZWREb2N1bWVudCk7XHJcbiAgICAgICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgICAgICAgICAgYXdhaXQgcGF0Y2hTZXR0aW5ncyh7IHNvdXJjZVVybCB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgc291cmNlVHlwZTogJ25vZGUnLCBzb3VyY2VVcmwsIGl0ZW1zOiBbXSwgYWRkZWQ6IDAsIGR1cGxpY2F0ZXM6IDAsXHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudCwgZm9udEFzc2V0cykgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZnJhbWVzID0gY29sbGVjdFNlY3Rpb25GcmFtZXMocm9vdCk7XHJcbiAgICAgICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ+i/meS4qiBTZWN0aW9uIOS4i+ayoeacieWPr+eLrOeri+WvvOWFpeeahOWkluWxgiBGcmFtZeOAgicpO1xyXG4gICAgICAgIGNvbnN0IHByZXBhcmVkOiBBcnJheTx7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIH0+ID0gW107XHJcbiAgICAgICAgbGV0IGR1cGxpY2F0ZXMgPSAwO1xyXG4gICAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgZnJhbWVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gZmlnbWFGcmFtZVNvdXJjZUhhc2gocGFyc2VkLmZpbGVLZXksIGZyYW1lLmlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBiYXRjaERvY3VtZW50cy5nZXQoaWQpO1xyXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgICAgIGR1cGxpY2F0ZXMgKz0gMTtcclxuICAgICAgICAgICAgICAgIHByZXBhcmVkLnB1c2goeyAuLi5leGlzdGluZywgaXRlbTogeyAuLi5leGlzdGluZy5pdGVtLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGV4aXN0aW5nLmRvY3VtZW50LCBmb250QXNzZXRzKSB9IH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhbm5vdGF0ZURvY3VtZW50UGxhbihmcmFtZURvY3VtZW50KHBhcnNlZERvY3VtZW50LCBmcmFtZSkpO1xyXG4gICAgICAgICAgICBjb25zdCBpdGVtOiBCYXRjaEZyYW1lSXRlbSA9IHtcclxuICAgICAgICAgICAgICAgIGlkLCBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LCByb290SWQ6IGZyYW1lLmlkLCBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgICAgIG5hbWU6IGZyYW1lLm5hbWUsIGVuYWJsZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAuLi4ocm9vdC50eXBlID09PSAnU0VDVElPTicgPyB7IHNlY3Rpb25OYW1lOiByb290Lm5hbWUgfSA6IHt9KSxcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50LCBmb250QXNzZXRzKSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgcHJlcGFyZWQucHVzaCh7IGl0ZW0sIGRvY3VtZW50IH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBhZGRlZCA9IHByZXBhcmVkLmxlbmd0aCAtIGR1cGxpY2F0ZXM7XHJcbiAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUgKyBhZGRlZCA+IE1BWF9CQVRDSF9JVEVNUykgdGhyb3cgbmV3IEVycm9yKCfmnKzmibnmnIDlpJrmt7vliqAgJyArIE1BWF9CQVRDSF9JVEVNUyArICcg5Liq55WM6Z2i77yM6K+35YiG5om55a+85YWl44CCJyk7XHJcbiAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgcHJlcGFyZWQpIGJhdGNoRG9jdW1lbnRzLnNldChlbnRyeS5pdGVtLmlkLCBlbnRyeSk7XHJcbiAgICAgICAgYXdhaXQgcGF0Y2hTZXR0aW5ncyh7IHNvdXJjZVVybCB9KTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2lkbGUnLCB2YWx1ZTogMSwgbWVzc2FnZTogJ+W3sua3u+WKoCAnICsgYWRkZWQgKyAnIOS4queVjOmdoidcclxuICAgICAgICAgICAgKyAoZHVwbGljYXRlcyA/ICfvvIwnICsgZHVwbGljYXRlcyArICcg5Liq5bey5Zyo5YiX6KGoJyA6ICcnKSArICfjgIInIH0pO1xyXG4gICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6IHJvb3QudHlwZSA9PT0gJ1NFQ1RJT04nID8gJ3NlY3Rpb24nIDogJ2ZyYW1lJywgc291cmNlVXJsLFxyXG4gICAgICAgICAgICBpdGVtczogcHJlcGFyZWQubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSksIGFkZGVkLCBkdXBsaWNhdGVzIH07XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkID8gJ2NhbmNlbGxlZCcgOiAnZXJyb3InLCB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhY3RpdmF0ZUJhdGNoSXRlbShpZDogc3RyaW5nKTogUHJvbWlzZTxCYXRjaERvY3VtZW50RHRvPiB7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgZW50cnkgPSBiYXRjaERvY3VtZW50cy5nZXQoaWQpO1xyXG4gICAgICAgIGlmICghZW50cnkpIHRocm93IG5ldyBFcnJvcign6K+l55WM6Z2i5bey5aSx5pWI77yM6K+36YeN5paw5re75Yqg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGVudHJ5LmRvY3VtZW50KTtcclxuICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGVudHJ5LmRvY3VtZW50O1xyXG4gICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgICAgICBlbnRyeS5pdGVtLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgcmV0dXJuIGRvY3VtZW50O1xyXG4gICAgfSBmaW5hbGx5IHsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN5bmNCYXRjaEl0ZW1zKGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IGVuYWJsZWQ6IGJvb2xlYW4gfT4pOiB7IGl0ZW1zOiBCYXRjaEZyYW1lSXRlbVtdIH0ge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoIHx8IGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5Lu75Yqh5a6M5oiQ5ZCO5YaN5L+u5pS555WM6Z2i5YiX6KGo44CCJyk7XHJcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoaXRlbXMpIHx8IGl0ZW1zLmxlbmd0aCA+IE1BWF9CQVRDSF9JVEVNUykgdGhyb3cgbmV3IEVycm9yKCfmibnph4/nlYzpnaLliJfooajml6DmlYjjgIInKTtcclxuICAgIGNvbnN0IG5leHQgPSBuZXcgTWFwPHN0cmluZywgeyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PigpO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgZW50cnkgPSBpdGVtICYmIGJhdGNoRG9jdW1lbnRzLmdldChpdGVtLmlkKTtcclxuICAgICAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBpdGVtLmVuYWJsZWQgIT09ICdib29sZWFuJyB8fCBuZXh0LmhhcyhpdGVtLmlkKSkgdGhyb3cgbmV3IEVycm9yKCfnlYzpnaLliJfooajlt7Lov4fmnJ/miJbljIXlkKvph43lpI3pobnvvIzor7fph43mlrDor7vlj5bjgIInKTtcclxuICAgICAgICBuZXh0LnNldChpdGVtLmlkLCB7IC4uLmVudHJ5LCBpdGVtOiB7IC4uLmVudHJ5Lml0ZW0sIGVuYWJsZWQ6IGl0ZW0uZW5hYmxlZCB9IH0pO1xyXG4gICAgfVxyXG4gICAgYmF0Y2hEb2N1bWVudHMuY2xlYXIoKTtcclxuICAgIGZvciAoY29uc3QgW2lkLCBlbnRyeV0gb2YgbmV4dCkgYmF0Y2hEb2N1bWVudHMuc2V0KGlkLCBlbnRyeSk7XHJcbiAgICByZXR1cm4geyBpdGVtczogWy4uLmJhdGNoRG9jdW1lbnRzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRCYXRjaFN0YXRlKCk6IFByb21pc2U8QmF0Y2hTdGF0ZT4ge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoKSByZXR1cm4ge1xyXG4gICAgICAgIGl0ZW1zOiBbLi4uYmF0Y2hEb2N1bWVudHMudmFsdWVzKCldLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pLFxyXG4gICAgICAgIGxhc3RSZXN1bHQ6IGxhc3RCYXRjaFJlc3VsdCwgcnVubmluZzogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCksXHJcbiAgICB9O1xyXG4gICAgY29uc3QgZm9udHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgY29uc3QgaXRlbXM6IEJhdGNoRnJhbWVJdGVtW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgYmF0Y2hEb2N1bWVudHMudmFsdWVzKCkpIHtcclxuICAgICAgICBpdGVtcy5wdXNoKHsgLi4uZW50cnkuaXRlbSwgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZW50cnkuZG9jdW1lbnQsIGZvbnRzKSB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGl0ZW1zLCBsYXN0UmVzdWx0OiBsYXN0QmF0Y2hSZXN1bHQsIC4uLihhY3RpdmVCYXRjaCA/IHsgcnVubmluZzogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCkgfSA6IHt9KSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRCYXRjaChyZXF1ZXN0OiBCYXRjaEltcG9ydFJlcXVlc3QpOiBQcm9taXNlPEJhdGNoSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlciB8fCBhcHBseWluZ0ltcG9ydFJldmlldyB8fCByb3VuZHRyaXBDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeW3suacieaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOOAgicpO1xyXG4gICAgaWYgKCFyZXF1ZXN0IHx8ICFBcnJheS5pc0FycmF5KHJlcXVlc3QuaXRlbXMpIHx8ICFyZXF1ZXN0Lml0ZW1zLmxlbmd0aCB8fCByZXF1ZXN0Lml0ZW1zLmxlbmd0aCA+IE1BWF9CQVRDSF9JVEVNUykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+36Iez5bCR6YCJ5oup5LiA5Liq5pyJ5pWI55qE5b6F5a+85YWl55WM6Z2i44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGNvbnN0IGVudHJpZXMgPSByZXF1ZXN0Lml0ZW1zLm1hcCgoaXRlbSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkuaXRlbS5lbmFibGVkIHx8ICFBcnJheS5pc0FycmF5KGl0ZW0ub3ZlcnJpZGVzKSkgdGhyb3cgbmV3IEVycm9yKCflvoXlr7zlhaXnlYzpnaLlt7LlpLHmlYjmiJbmnKrli77pgInvvIzor7fph43mlrDor7vlj5bjgIInKTtcclxuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSBpdGVtLm92ZXJyaWRlcy5tYXAoKG92ZXJyaWRlKSA9PiAoeyAuLi5vdmVycmlkZSB9KSk7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IGVudHJ5LmRvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKG92ZXJyaWRlcywgZW50cnkuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9ucy5nZXQocm9vdC5pZCk/LmFjdGlvbiA9PT0gJ2lnbm9yZScpIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lml0ZW0ubmFtZSArICfigJ3moLnoioLngrnlt7Llv73nlaXvvIzor7flj5bmtojor6XnlYzpnaLli77pgInmiJbmgaLlpI3moLnoioLngrnnrZbnlaXjgIInKTtcclxuICAgICAgICBjb25zdCBuYW1lID0gZGVjaXNpb25zLmdldChyb290LmlkKT8ubmFtZSB8fCByb290Lm5hbWU7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZW50cnksIG92ZXJyaWRlcywgbmFtZSB9O1xyXG4gICAgfSk7XHJcbiAgICBhc3NlcnRCYXRjaFRhcmdldHMoZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgbmFtZTogZW50cnkubmFtZSB9KSkpO1xyXG4gICAgY29uc3QgcnVuOiBCYXRjaFJ1biA9IHtcclxuICAgICAgICBpZDogcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdoZXgnKSwgaW5kZXg6IDAsIHN0b3BSZXF1ZXN0ZWQ6IGZhbHNlLFxyXG4gICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBuYW1lOiBlbnRyeS5uYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsLCBzdGF0dXM6ICdwZW5kaW5nJyB9KSksXHJcbiAgICB9O1xyXG4gICAgYWN0aXZlQmF0Y2ggPSBydW47XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIGVudHJ5Lml0ZW0uZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA9IGVudHJ5Lm92ZXJyaWRlcztcclxuICAgIGNvbnN0IHByZXZpb3VzRG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGNvbnN0IHByZXZpb3VzUmVzdWx0ID0gcmVxdWVzdC5wcmVzZXJ2ZVJlc3VsdHMgPyBsYXN0QmF0Y2hSZXN1bHQgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBjb21wbGV0ZWRSZXN1bHQgPSAoKTogQmF0Y2hJbXBvcnRSZXN1bHQgPT4ge1xyXG4gICAgICAgIGNvbnN0IG1lcmdlZCA9IG5ldyBNYXA8c3RyaW5nLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQ+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHByZXZpb3VzUmVzdWx0Py5pdGVtcyA/PyBbXSkge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuaGFzKGl0ZW0uaWQpKSBtZXJnZWQuc2V0KGl0ZW0uaWQsIHsgLi4uaXRlbSB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJ1bi5pdGVtcykgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XHJcbiAgICAgICAgY29uc3QgaXRlbXMgPSBbLi4ubWVyZ2VkLnZhbHVlcygpXTtcclxuICAgICAgICByZXR1cm4geyBpZDogcnVuLmlkLCBpdGVtcywgc3RvcHBlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgICAgIGNvbXBsZXRlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoLFxyXG4gICAgICAgICAgICB0b3RhbDogaXRlbXMubGVuZ3RoIH07XHJcbiAgICB9O1xyXG4gICAgdHJ5IHtcclxuICAgICAgICAvLyBDaGVjayBldmVyeSBkZXN0aW5hdGlvbiBiZWZvcmUgdGhlIGZpcnN0IGltYWdlL3ByZWZhYiB3cml0ZS5cclxuICAgICAgICBjb25zdCBmb2xkZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKS5mb2xkZXI7XHJcbiAgICAgICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSAnZGI6Ly9hc3NldHMvJyArIGZvbGRlciArICcvJyArIHNhbml0aXplQXNzZXROYW1lKGVudHJ5Lm5hbWUpICsgJy5wcmVmYWInO1xyXG4gICAgICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIWluZm8pIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBlbnRyeS5pdGVtLmlkXHJcbiAgICAgICAgICAgICAgICB8fCAoYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gJiYgYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gIT09IGluZm8udXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lm5hbWUgKyAn4oCd55qEIFByZWZhYiDot6/lvoTlt7Looqvlhbbku5bmnaXmupDljaDnlKjvvIzor7fmlLnlkI3miJbosIPmlbTovpPlh7rnm67lvZXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGxldGVkUmVzdWx0KCk7XHJcbiAgICAgICAgICAgIGxhc3RCYXRjaFJlc3VsdCA9IHJlc3VsdDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWBnOatou+8jOWwmuacquW8gOWni+S7u+S9leeVjOmdouOAgicsIGJhdGNoOiB7IC4uLmJhdGNoUHJvZ3Jlc3MocnVuKSwgcmVzdWx0IH0gfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZShyZXF1ZXN0LnByZXNlcnZlUmVzdWx0cyA/IHsgcHJlc2VydmVIaXN0b3J5OiB0cnVlIH0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBlbnRyaWVzLmxlbmd0aDsgaW5kZXgrKykge1xyXG4gICAgICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICBydW4uaW5kZXggPSBpbmRleDtcclxuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBlbnRyaWVzW2luZGV4XTtcclxuICAgICAgICAgICAgY29uc3Qgcm93ID0gcnVuLml0ZW1zW2luZGV4XTtcclxuICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdydW5uaW5nJztcclxuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcclxuICAgICAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5a+85YWlICcgKyAoaW5kZXggKyAxKSArICcvJyArIGVudHJpZXMubGVuZ3RoICsgJ++8micgKyBlbnRyeS5uYW1lIH0pO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGVyZm9ybUltcG9ydCh7IG92ZXJyaWRlczogZW50cnkub3ZlcnJpZGVzLFxyXG4gICAgICAgICAgICAgICAgICAgIHNldHRpbmdzOiB7IC4uLnNldHRpbmdzLCBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsIH0gfSwgcnVuLmlkLFxyXG4gICAgICAgICAgICAgICAgeyBkb2N1bWVudDogZW50cnkuZG9jdW1lbnQsIHByZXNlcnZlUmV2aWV3czogdHJ1ZSwgc2lsZW50UmV2aWV3OiB0cnVlIH0pO1xyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihyb3csIHsgc3RhdHVzOiAnc3VjY2VzcycsIHByZWZhYlVybDogcmVzdWx0LnByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICBjcmVhdGVkOiByZXN1bHQuY3JlYXRlZCwgdXBkYXRlZDogcmVzdWx0LnVwZGF0ZWQsIHdhcm5pbmdzOiByZXN1bHQud2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJlc3VsdC5yZXZpZXc/LmlkIH0pO1xyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdzdWNjZXNzJztcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIGxldCB1bnNhZmUgPSBCb29sZWFuKChlcnJvciBhcyB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KT8ucmVxdWlyZXNBdHRlbnRpb24pO1xyXG4gICAgICAgICAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykpIHVuc2FmZSA9IHRydWU7IH1cclxuICAgICAgICAgICAgICAgIGNhdGNoIHsgdW5zYWZlID0gdHJ1ZTsgfVxyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdmYWlsZWQnO1xyXG4gICAgICAgICAgICAgICAgcm93LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJztcclxuICAgICAgICAgICAgICAgIGlmICh1bnNhZmUpIHtcclxuICAgICAgICAgICAgICAgICAgICByb3cucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJvdy5lcnJvciArPSAnIOW9k+WJjee8lui+keaIluS/neWtmOeKtuaAgemcgOimgeajgOafpe+8jOW3suaaguWBnOWQjue7reeVjOmdou+8m+ehruiupOebruagh+WSjOS/neWtmOeKtuaAgeWQjuWGjemHjeivleOAgic7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAodW5zYWZlIHx8IHJlcXVlc3QuZmFpbHVyZVBvbGljeSA9PT0gJ3N0b3AnKSBydW4uc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogZW50cnkubmFtZSArICfvvJonICsgKHJvdy5zdGF0dXMgPT09ICdzdWNjZXNzJyA/ICflt7Lkv53lrZgnIDogJ+Wksei0pScpIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXN1bHQgPSBjb21wbGV0ZWRSZXN1bHQoKTtcclxuICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdmFsdWU6IDEsIG1lc3NhZ2U6IHJlc3VsdC5zdG9wcGVkID8gJ+acrOaJueW3suWBnOatou+8jOW3suWujOaIkOmhueS/neeVmeOAgicgOiAn5pys5om55a+85YWl57uT5p2f44CCJyxcclxuICAgICAgICAgICAgYmF0Y2g6IHsgLi4uYmF0Y2hQcm9ncmVzcyhydW4pLCByZXN1bHQgfSB9KTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2ggPT09IHJ1bikgYWN0aXZlQmF0Y2ggPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gcHJldmlvdXNEb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN0b3BJbXBvcnRCYXRjaCgpOiB7IGFjY2VwdGVkOiBib29sZWFuIH0ge1xyXG4gICAgaWYgKCFhY3RpdmVCYXRjaCkgcmV0dXJuIHsgYWNjZXB0ZWQ6IGZhbHNlIH07XHJcbiAgICBhY3RpdmVCYXRjaC5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W9k+WJjeeVjOmdouWujOaIkOS/neWtmOWQjuWBnOatou+8jOWQjue7reeVjOmdouS4jeS8muW8gOWni+OAgicgfSk7XHJcbiAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50Py5ub2RlQnlJZC5nZXQobm9kZUlkKTtcclxuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgIDEsXHJcbiAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgZ2V0SW1wb3J0UmV2aWV3KGlkPzogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLmdldChpZCk7IH0sXHJcbiAgICByZXNvbHZlQmF0Y2hTb3VyY2UsXHJcbiAgICBhY3RpdmF0ZUJhdGNoSXRlbSxcclxuICAgIHN5bmNCYXRjaEl0ZW1zLFxyXG4gICAgZ2V0QmF0Y2hTdGF0ZSxcclxuICAgIGltcG9ydEJhdGNoLFxyXG4gICAgc3RvcEltcG9ydEJhdGNoLFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3UHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcpIHsgcmV0dXJuIGltcG9ydFJldmlld3MucHJldmlldyhpZCwgYXNzZXRJZCk7IH0sXHJcbiAgICBhc3luYyBhcHBseUltcG9ydFJldmlldyhpZDogc3RyaW5nLCByZW1vdmVkSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5a+85YWl5oiWIEZpZ21hIOmihOiniOWujOaIkOOAgicpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gdHJ1ZTtcclxuICAgICAgICB0cnkgeyByZXR1cm4gYXdhaXQgaW1wb3J0UmV2aWV3cy5hcHBseShpZCwgcmVtb3ZlZElkcyk7IH1cclxuICAgICAgICBmaW5hbGx5IHsgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3U291cmNlUHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcsIG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5pON5L2c5a6M5oiQ5ZCO5YaN5Yqg6L295p2l5rqQ6aKE6KeI44CCJyk7XHJcbiAgICAgICAgY29uc3QgeyBmaWxlS2V5LCBub2RlIH0gPSBpbXBvcnRSZXZpZXdzLnNvdXJjZShpZCwgYXNzZXRJZCwgbm9kZUlkKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcclxuICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsbHNbaW1hZ2VSZWZdKSByZXR1cm4geyB1cmw6IGZpbGxzW2ltYWdlUmVmXSwgbm90ZTogJ0ZpZ21hIOWOn+Wbvu+8iOacquWQiOaIkOiKgueCueaViOaenO+8iScgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmICghdXJsc1tub2RlLmlkXSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDmnKrov5Tlm57pooTop4jvvIzpmpDol4/miJblpI3mnYLmlYjmnpzoioLngrnlj6/og73ml6Dms5XljZXni6zmuLLmn5PjgIInKTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGUuaWRdLCBub3RlOiAnRmlnbWEg5b2T5YmN6IqC54K55riy5p+T77yI6ZqQ6JeP56WW5YWI5Y+v6IO95L2/6aKE6KeI6YCP5piO77yJJyB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIG9wZW5QYW5lbCgpIHtcclxuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFBsdWdpblN0YXRlKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNldFRva2VuKHZhbHVlOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuc2V0KHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgY2xlYXJUb2tlbigpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkudmVyaWZ5KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleTogdW5rbm93biwgb3ZlcnJpZGVzOiB1bmtub3duLCBzY29wZUlkczogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZ2V0Tm9kZVByZXZpZXcobm9kZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwRGV0ZWN0KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmRldGVjdChzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQcmV2aWV3KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnByZXZpZXcoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUGFpcihwYWlyVG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmFwcGx5KHByZXZpZXdUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgcm91bmR0cmlwQ2FuY2VsKCkge1xyXG4gICAgICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGNhbmNlbEltcG9ydCgpIHtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2gpIHJldHVybiBzdG9wSW1wb3J0QmF0Y2goKTtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxufTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0TWNwQnJpZGdlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIGlmIChwcmV2aW91cykgYXdhaXQgcHJldmlvdXMuY2xvc2UoKTtcclxuXHJcbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xyXG4gICAgY29uc3QgYXBpID0gbmV3IEZpZ21hSW1wb3J0ZXJNY3BBcGkoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxyXG4gICAgICAgIGdldERvY3VtZW50UmV2aXNpb246ICgpID0+IGRvY3VtZW50UmV2aXNpb24sXHJcbiAgICAgICAgaXNJbXBvcnRCdXN5OiAoKSA9PiBhY3RpdmVCYXRjaCAhPT0gbnVsbCB8fCBhY3RpdmVDb250cm9sbGVyICE9PSBudWxsIHx8IHJvdW5kdHJpcENvbnRyb2xsZXIgIT09IG51bGwsXHJcbiAgICAgICAgZ2V0U3RhdGU6IGdldE1jcFBsdWdpblN0YXRlLFxyXG4gICAgICAgIGZldGNoRG9jdW1lbnQ6IGZldGNoRmlnbWFEb2N1bWVudCxcclxuICAgICAgICBnZXRQcmV2aWV3OiBnZXROb2RlUHJldmlldyxcclxuICAgICAgICBzYXZlU2V0dGluZ3MsXHJcbiAgICAgICAgcGF0Y2hTZXR0aW5ncyxcclxuICAgICAgICBzYXZlTm9kZU92ZXJyaWRlcyxcclxuICAgICAgICBwYXRjaE5vZGVOYW1lcyxcclxuICAgICAgICBpbXBvcnRTZWxlY3Rpb246IChyZXF1ZXN0LCBvcGVyYXRpb25JZCkgPT4gcGVyZm9ybUltcG9ydChyZXF1ZXN0LCBvcGVyYXRpb25JZCksXHJcbiAgICAgICAgY2FuY2VsSW1wb3J0OiAob3BlcmF0aW9uSWQpID0+IHtcclxuICAgICAgICAgICAgaWYgKCFhY3RpdmVDb250cm9sbGVyIHx8IGFjdGl2ZU9wZXJhdGlvbk93bmVyICE9PSBvcGVyYXRpb25JZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBhY3RpdmVDb250cm9sbGVyLmFib3J0KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG5ldyBNY3BCcmlkZ2VTZXJ2ZXIoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIHBsdWdpblZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgcGx1Z2luSW5zdGFuY2VJZCxcclxuICAgICAgICBpbnZva2U6IChtZXRob2QsIHBhcmFtcywgc2lnbmFsKSA9PiBhcGkuaW52b2tlKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpLFxyXG4gICAgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5zdGFydCgpO1xyXG4gICAgICAgIG1jcEFwaSA9IGFwaTtcclxuICAgICAgICBtY3BCcmlkZ2UgPSBicmlkZ2U7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5jbG9zZSgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlkK/liqjlpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMoRWRpdG9yLlByb2plY3QucGF0aCwgZWRpdG9yUmVpbXBvcnRlcik7XHJcbiAgICAgICAgY29uc3QgYWN0aXZlID0gcmVjb3ZlcmVkLmZpbHRlcigocmVzdWx0KSA9PiByZXN1bHQuc3RhdHVzID09PSAnYWN0aXZlLW93bmVyJyk7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDmo4DmtYvliLAgJHthY3RpdmUubGVuZ3RofSDkuKrku43nlLHmtLvliqjov5vnqIvmjIHmnInnmoQgUm91bmQtdHJpcCDkuovliqHvvIzmmoLml7bnpoHmraIgUGFpci9BcHBseeOAgmBcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBgUm91bmQtdHJpcCDlkK/liqjmgaLlpI3lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGFydE1jcEJyaWRnZSgpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoKSBhY3RpdmVCYXRjaC5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XHJcbiAgICBsYXN0QmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7XHJcbiAgICBpbXBvcnRSZXZpZXdzLmludmFsaWRhdGUoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIGFjdGl2ZURvY3VtZW50ID0gbnVsbDtcclxuICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG1jcEJyaWRnZTtcclxuICAgIG1jcEJyaWRnZSA9IG51bGw7XHJcbiAgICBtY3BBcGkgPSBudWxsO1xyXG4gICAgdm9pZCBicmlkZ2U/LmNsb3NlKCkuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlhbPpl63lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9KTtcclxufVxyXG4iXX0=