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
                // The explicitly selected output stays writable even when it
                // is also indexed as a local source. Slice writes use this URL.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQTJmQSx3REFnQkM7QUE4QkQsa0NBMkJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBbUVELGtDQWl1QkM7QUF3Q0QsNEJBc0dDO0FBMHVDRCxvQkFhQztBQUVELHdCQWdCQztBQTU0RkQsK0JBQThFO0FBQzlFLDJCQUFnQztBQUNoQyxtQ0FBcUM7QUFDckMsK0NBQWdFO0FBQ2hFLDBDQUFnRDtBQUNoRCxtRUFBMEM7QUFDMUMsMkNBQThFO0FBQzlFLCtDQVcwQjtBQUMxQiwyQ0FBK0M7QUFDL0MsMkRBS2dDO0FBQ2hDLGlEQUF5RTtBQUN6RSw2Q0FBdUU7QUFDdkUscUNBQStDO0FBQy9DLHFEQUkwQjtBQUMxQiw4Q0FPMkI7QUFDM0IsNENBQXVFO0FBRXZFLGdFQUFrRTtBQUNsRSx3Q0FBNkM7QUFDN0Msc0RBQXVEO0FBQ3ZELDREQUFpRDtBQUNqRCxvREFBMEY7QUFDMUYsc0RBQTJEO0FBQzNELHdEQVlnQztBQUNoQyx3REFBb0Q7QUFDcEQsdUNBQXVFO0FBQ3ZFLGdEQUFzRDtBQUN0RCxpREFBdUQ7QUFDdkQsbURBQXNFO0FBQ3RFLHlEQUEyRDtBQUMzRCxtQ0FtQmlCO0FBQ2pCLDJDQUErQztBQUMvQyw0REFBcUY7QUFDckYsOEVBQXlFO0FBRXpFLGlEQUF5RjtBQU16RixNQUFNLEtBQUssR0FBRyxJQUFJLHdCQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMvQyxNQUFNLGFBQWEsR0FBRyxJQUFJLG1DQUFtQixFQUFFLENBQUM7QUFDaEQsSUFBSSxvQkFBb0IsR0FBRyxLQUFLLENBQUM7QUFDakMsSUFBSSxjQUFjLEdBQTJCLElBQUksQ0FBQztBQUNsRCxJQUFJLGdCQUFnQixHQUEyQixJQUFJLENBQUM7QUFDcEQsSUFBSSxvQkFBb0IsR0FBa0IsSUFBSSxDQUFDO0FBQy9DLElB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Q0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFDRCxNQUFNLGNBQWMsRUFBRSxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFnQixNQUFNO0lBQ2xCLElBQUksV0FBVztRQUFFLFdBQVcsQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDO0lBQ2xELGNBQWMsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUN2QixlQUFlLEdBQUcsU0FBUyxDQUFDO0lBQzVCLGFBQWEsQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUMzQixnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxLQUFLLEVBQUUsQ0FBQztJQUMxQixnQkFBZ0IsR0FBRyxJQUFJLENBQUM7SUFDeEIsb0JBQW9CLEdBQUcsSUFBSSxDQUFDO0lBQzVCLGNBQWMsR0FBRyxJQUFJLENBQUM7SUFDdEIsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO0lBQ3RCLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQztJQUN6QixTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ2pCLE1BQU0sR0FBRyxJQUFJLENBQUM7SUFDZCxLQUFLLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLEtBQUssR0FBRyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtRQUNqQyxPQUFPLENBQUMsS0FBSyxDQUFDLGtDQUFrQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZHLENBQUMsQ0FBQyxDQUFBLENBQUM7QUFDUCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgYmFzZW5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnY3J5cHRvJztcclxuaW1wb3J0IHsgZGlhZ25vc3RpY1N0YXJ0LCBkaWFnbm9zdGljVGFzayB9IGZyb20gJy4vZGlhZ25vc3RpY3MnO1xyXG5pbXBvcnQgeyByZWFkRmlsZSwgcmVhZGRpciB9IGZyb20gJ2ZzL3Byb21pc2VzJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEZpZ21hQ2xpZW50LCBDYW5jZWxsZWRFcnJvciwgY2xhbXBJbWFnZVNjYWxlIH0gZnJvbSAnLi9maWdtYS9jbGllbnQnO1xyXG5pbXBvcnQge1xyXG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcclxuICAgIGluZmVyQWN0aW9uLFxyXG4gICAgaW5mZXJDb2Nvc0xheW91dE1vZGUsXHJcbiAgICBpbmZlcktpbmQsXHJcbiAgICBpc1BhdGNoQ2FuZGlkYXRlLFxyXG4gICAgaXNOYW1lZFNsaWNlR3JvdXAsXHJcbiAgICBpc1ZlY3Rvck5vZGUsXHJcbiAgICBuYXRpdmVUaWxlZFBhaW50U291cmNlLFxyXG4gICAgcGxhaW5JbWFnZVNvdXJjZVJlZixcclxuICAgIHR5cGUgVGlsZWRQYWludFNvdXJjZSxcclxufSBmcm9tICcuL2ZpZ21hL2FuYWx5emVyJztcclxuaW1wb3J0IHsgcGFyc2VEb2N1bWVudCB9IGZyb20gJy4vZmlnbWEvcGFyc2VyJztcclxuaW1wb3J0IHtcclxuICAgIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuLFxyXG4gICAgY29tcGlsZUltcG9ydFBsYW4sXHJcbiAgICBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24sXHJcbiAgICByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMsXHJcbn0gZnJvbSAnLi9maWdtYS9pbXBvcnQtcGxhbm5lcic7XHJcbmltcG9ydCB7IGFuYWx5emVNYXNrVGludCwgdmVyaWZ5V2hpdGVBbHBoYVBuZyB9IGZyb20gJy4vZmlnbWEvbWFzay10aW50JztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCwgdHlwZSBTbGljZUFuYWx5c2lzIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgQXNzZXRXcml0ZXIsXHJcbiAgICBSQVNURVJfSU1BR0VfRVhURU5TSU9OUyxcclxuICAgIGRldGVjdEltYWdlRXh0ZW5zaW9uLFxyXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcclxuICAgIHNhbml0aXplQXNzZXROYW1lLFxyXG4gICAgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbixcclxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB7IExvY2FsQXNzZXRDYWNoZSwgdHlwZSBDYWNoZUVudHJ5S2V5IH0gZnJvbSAnLi9pbXBvcnRlci9jYWNoZSc7XHJcbmltcG9ydCB0eXBlIHsgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBncmFkaWVudFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc3ZnJztcclxuaW1wb3J0IHsgd3JpdGVTbGljZWRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3NsaWNlZC1wbmcnO1xyXG5pbXBvcnQgeyBpc1BuZyB9IGZyb20gJy4vaW1wb3J0ZXIvcmFzdGVyLWZvcm1hdCc7XHJcbmltcG9ydCB7IHBpeGVsU2l6ZWRUaWxlQXNzZXQsIHJhc3Rlcml6ZVRpbGUsIHRpbGVkUmFzdGVyS2V5IH0gZnJvbSAnLi9pbXBvcnRlci90aWxlZC1wbmcnO1xyXG5pbXBvcnQgeyByYXN0ZXJpemVJbWFnZUZpbGwgfSBmcm9tICcuL2ltcG9ydGVyL2ltYWdlLWZpbGwnO1xyXG5pbXBvcnQge1xyXG4gICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzLFxyXG4gICAgY3JlYXRlTWluaW1hbFByZWZhYkpzb24sXHJcbiAgICBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgZmlnbWFGcmFtZVNvdXJjZUhhc2gsXHJcbiAgICBtZXJnZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBwbGFuUHJlZmFiUmVjb3ZlcnlUYXJnZXQsXHJcbiAgICBwcmVmYWJKc29uQ29udGFpbnNTeW5jUmVjb3JkLFxyXG4gICAgcmVhZFByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZSxcclxuICAgIHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgdHlwZSBQcmVmYWJTeW5jUmVjb3JkLFxyXG59IGZyb20gJy4vaW1wb3J0ZXIvcHJlZmFiLXN5bmMnO1xyXG5pbXBvcnQgeyBUb2tlblZhdWx0IH0gZnJvbSAnLi9zZWN1cml0eS90b2tlbi12YXVsdCc7XHJcbmltcG9ydCB7IEZpZ21hSW1wb3J0ZXJNY3BBcGksIHR5cGUgTWNwTm9kZU5hbWVQYXRjaCB9IGZyb20gJy4vbWNwLWFwaSc7XHJcbmltcG9ydCB7IE1jcEJyaWRnZVNlcnZlciB9IGZyb20gJy4vbWNwLWJyaWRnZS9zZXJ2ZXInO1xyXG5pbXBvcnQgeyBSb3VuZHRyaXBTZXJ2aWNlIH0gZnJvbSAnLi9yb3VuZHRyaXAvc2VydmljZSc7XHJcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcclxuaW1wb3J0IHsgZWRpdG9yUmVpbXBvcnRlciB9IGZyb20gJy4vcm91bmR0cmlwL3RyYW5zYWN0aW9uJztcclxuaW1wb3J0IHtcclxuICAgIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgICB0eXBlIERvY3VtZW50U2Vzc2lvbixcclxuICAgIHR5cGUgRmlnbWFOb2RlLFxyXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXHJcbiAgICB0eXBlIEltcG9ydERlY2lzaW9uLFxyXG4gICAgdHlwZSBJbXBvcnRPdmVycmlkZSxcclxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcclxuICAgIHR5cGUgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICB0eXBlIE5vZGVLaW5kLFxyXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcclxuICAgIHR5cGUgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgdHlwZSBQcm9ncmVzc0V2ZW50LFxyXG4gICAgdHlwZSBSZWN0LFxyXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHlwZSBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICB0eXBlIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdSZWNvcmRlciwgSW1wb3J0UmV2aWV3U2VydmljZSB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB7IGZpbmFsaXplSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3LWZpbmFsaXplJztcclxuaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcsIFJldmlld1NjZW5lIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3LW1vZGVsJztcclxuaW1wb3J0IHsgYXNzZXJ0QmF0Y2hUYXJnZXRzLCBjb2xsZWN0U2VjdGlvbkZyYW1lcywgZnJhbWVEb2N1bWVudCB9IGZyb20gJy4vYmF0Y2gtaW1wb3J0JztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgQmF0Y2hEb2N1bWVudER0bywgQmF0Y2hGcmFtZUl0ZW0sIEJhdGNoSW1wb3J0SXRlbVJlc3VsdCwgQmF0Y2hJbXBvcnRSZXF1ZXN0LFxyXG4gICAgQmF0Y2hJbXBvcnRSZXN1bHQsIEJhdGNoUHJvZ3Jlc3MsIEJhdGNoU291cmNlUmVzdWx0LCBCYXRjaFN0YXRlLFxyXG59IGZyb20gJy4vYmF0Y2gtdHlwZXMnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxuY29uc3QgaW1wb3J0UmV2aWV3cyA9IG5ldyBJbXBvcnRSZXZpZXdTZXJ2aWNlKCk7XHJcbmxldCBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlO1xyXG5sZXQgYWN0aXZlRG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVPcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IHNldHRpbmdzQ2FjaGU6IEltcG9ydFNldHRpbmdzIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZG9jdW1lbnRSZXZpc2lvbiA9IDA7XHJcbmxldCBtY3BCcmlkZ2U6IE1jcEJyaWRnZVNlcnZlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgbWNwQXBpOiBGaWdtYUltcG9ydGVyTWNwQXBpIHwgbnVsbCA9IG51bGw7XHJcbmNvbnN0IHBsdWdpbkluc3RhbmNlSWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG5sZXQgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgc2V0dGluZ3NXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmNvbnN0IE1BWF9CQVRDSF9JVEVNUyA9IDEwMDtcclxuY29uc3QgYmF0Y2hEb2N1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgeyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PigpO1xyXG5pbnRlcmZhY2UgQmF0Y2hSdW4ge1xyXG4gICAgaWQ6IHN0cmluZztcclxuICAgIGl0ZW1zOiBCYXRjaEltcG9ydEl0ZW1SZXN1bHRbXTtcclxuICAgIGluZGV4OiBudW1iZXI7XHJcbiAgICBzdG9wUmVxdWVzdGVkOiBib29sZWFuO1xyXG59XHJcbmxldCBhY3RpdmVCYXRjaDogQmF0Y2hSdW4gfCBudWxsID0gbnVsbDtcclxubGV0IGxhc3RCYXRjaFJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQgfCB1bmRlZmluZWQ7XHJcblxyXG50eXBlIERlY2lzaW9uID0gSW1wb3J0RGVjaXNpb247XHJcblxyXG5pbnRlcmZhY2UgVGlsZWRBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUmF3SW1hZ2VBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgaW1hZ2VSZWY6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICByZXZpZXdJZD86IHN0cmluZztcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XHJcbiAgICByZXZpZXdCZWZvcmU/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlld0FmdGVyPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXc/OiBJbXBvcnRSZXZpZXc7XHJcbiAgICByb290VXVpZDogc3RyaW5nO1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIGNyZWF0ZWQ6IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ6IG51bWJlcjtcclxuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgcHJlZmFiU3luYz86IFByZWZhYlNjZW5lU3luY0NhcHR1cmU7XHJcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQXNzZXRCdWlsZFJlc3VsdCB7XHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz47XHJcbiAgICB3YXJuaW5nczogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJBc3NldEluZm8ge1xyXG4gICAgdXVpZDogc3RyaW5nO1xyXG4gICAgdXJsOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlcjogc3RyaW5nO1xyXG4gICAgdHlwZTogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZWQ6IGJvb2xlYW47XHJcbiAgICBpbnZhbGlkOiBib29sZWFuO1xyXG4gICAgaXNEaXJlY3Rvcnk/OiBib29sZWFuO1xyXG4gICAgcmVhZG9ubHk/OiBib29sZWFuO1xyXG4gICAgcmVkaXJlY3Q/OiB1bmtub3duO1xyXG59XHJcblxyXG5jb25zdCBGT05UX0VYVEVOU0lPTlMgPSBuZXcgU2V0KFsnLnR0ZicsICcub3RmJywgJy5mbnQnLCAnLndvZmYnLCAnLndvZmYyJ10pO1xyXG5jb25zdCBOT0RFX0tJTkRTID0gbmV3IFNldDxOb2RlS2luZD4oW1xyXG4gICAgJ2F1dG8nLFxyXG4gICAgJ25vZGUnLFxyXG4gICAgJ3Nwcml0ZScsXHJcbiAgICAnbGFiZWwnLFxyXG4gICAgJ3JpY2hUZXh0JyxcclxuICAgICdidXR0b24nLFxyXG4gICAgJ3Njcm9sbFZpZXcnLFxyXG4gICAgJ2xheW91dCcsXHJcbl0pO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gbGlzdEZvbnRBc3NldHMoKTogUHJvbWlzZTxGb250QXNzZXRPcHRpb25bXT4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgZm9udHM6IEZvbnRBc3NldE9wdGlvbltdID0gW107XHJcbiAgICBhc3luYyBmdW5jdGlvbiB2aXNpdChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGxldCBlbnRyaWVzO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKGZvbGRlciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ25vZGVfbW9kdWxlcycgfHwgZW50cnkubmFtZSA9PT0gJ2xpYnJhcnknIHx8IGVudHJ5Lm5hbWUgPT09ICd0ZW1wJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGZvbGRlciwgZW50cnkubmFtZSk7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB2aXNpdChmaWxlUGF0aCk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIUZPTlRfRVhURU5TSU9OUy5oYXMoZXh0bmFtZShlbnRyeS5uYW1lKS50b0xvd2VyQ2FzZSgpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIGZpbGVQYXRoKS5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbiAgICAgICAgICAgIGZvbnRzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoZW50cnkubmFtZSwgZXh0bmFtZShlbnRyeS5uYW1lKSksXHJcbiAgICAgICAgICAgICAgICB1cmw6IGBkYjovL2Fzc2V0cy8ke3BhdGh9YCxcclxuICAgICAgICAgICAgICAgIHJlbGF0aXZlUGF0aDogcGF0aCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgYXdhaXQgdmlzaXQoYXNzZXRzUm9vdCk7XHJcbiAgICByZXR1cm4gZm9udHMuc29ydCgoYSwgYikgPT4gYS5yZWxhdGl2ZVBhdGgubG9jYWxlQ29tcGFyZShiLnJlbGF0aXZlUGF0aCwgJ3poLUNOJykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0UHJvZ3Jlc3MocHJvZ3Jlc3M6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ3Byb2dyZXNzJywge1xyXG4gICAgICAgIC4uLnByb2dyZXNzLFxyXG4gICAgICAgIC4uLihhY3RpdmVCYXRjaCAmJiAhcHJvZ3Jlc3MuYmF0Y2ggPyB7IGJhdGNoOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSB9IDoge30pLFxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoUHJvZ3Jlc3MocnVuOiBCYXRjaFJ1bik6IEJhdGNoUHJvZ3Jlc3Mge1xyXG4gICAgY29uc3QgY3VycmVudCA9IHJ1bi5pdGVtc1tNYXRoLm1pbihydW4uaW5kZXgsIHJ1bi5pdGVtcy5sZW5ndGggLSAxKV07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGJhdGNoSWQ6IHJ1bi5pZCwgaXRlbUlkOiBjdXJyZW50Py5pZCA/PyAnJywgbmFtZTogY3VycmVudD8ubmFtZSA/PyAnJyxcclxuICAgICAgICBpbmRleDogTWF0aC5taW4ocnVuLmluZGV4ICsgMSwgcnVuLml0ZW1zLmxlbmd0aCksIHRvdGFsOiBydW4uaXRlbXMubGVuZ3RoLFxyXG4gICAgICAgIGNvbXBsZXRlZDogcnVuLml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJyB8fCBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCxcclxuICAgICAgICBzdG9wUmVxdWVzdGVkOiBydW4uc3RvcFJlcXVlc3RlZCxcclxuICAgICAgICBpdGVtczogcnVuLml0ZW1zLm1hcCgoaXRlbSkgPT4gKHsgLi4uaXRlbSB9KSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0Q2FjaGVGb2xkZXIoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBqb2luKEVkaXRvci5Qcm9qZWN0LnRtcERpciwgcGFja2FnZUpTT04ubmFtZSwgJ2Fzc2V0LWNhY2hlJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IEltcG9ydFNldHRpbmdzIHtcclxuICAgIGNvbnN0IGlucHV0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRTZXR0aW5ncz5cclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgaW5wdXQuc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpbnB1dC5zY2FsZSlcclxuICAgICAgICA/IE1hdGgubWF4KDAuMjUsIE1hdGgubWluKDQsIGlucHV0LnNjYWxlKSlcclxuICAgICAgICA6IERFRkFVTFRfU0VUVElOR1Muc2NhbGU7XHJcbiAgICBjb25zdCBmb250TWFwID0gaW5wdXQuZm9udE1hcCAmJiB0eXBlb2YgaW5wdXQuZm9udE1hcCA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhpbnB1dC5mb250TWFwKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChba2V5LCBpdGVtXSkgPT4ga2V5LnRyaW0oKSAmJiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGl0ZW1dKSA9PiBba2V5LnRyaW0oKSwgaXRlbS50cmltKCldKSlcclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3QgcmF3TG9jYWxGb2xkZXJzID0gQXJyYXkuaXNBcnJheShpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVycylcclxuICAgICAgICA/IGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiB0eXBlb2YgaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlciA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgPyBbaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcl1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VGb2xkZXJzID0gcmF3TG9jYWxGb2xkZXJzXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyKTogZm9sZGVyIGlzIHN0cmluZyA9PiB0eXBlb2YgZm9sZGVyID09PSAnc3RyaW5nJylcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlciwgaW5kZXgsIGZvbGRlcnMpID0+IGZvbGRlcnMuaW5kZXhPZihmb2xkZXIpID09PSBpbmRleClcclxuICAgICAgICAuc2xpY2UoMCwgMyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogdHlwZW9mIGlucHV0LnNvdXJjZVVybCA9PT0gJ3N0cmluZycgPyBpbnB1dC5zb3VyY2VVcmwudHJpbSgpIDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHR5cGVvZiBpbnB1dC5hc3NldEZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5hc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXI6IHR5cGVvZiBpbnB1dC5wcmVmYWJGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5wcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnMsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogbG9jYWxSZXNvdXJjZUZvbGRlcnNbMF0gPz8gJycsXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGlucHV0LnVwZGF0ZUV4aXN0aW5nICE9PSBmYWxzZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBpbnB1dC5yZWZyZXNoQXNzZXRzID09PSB0cnVlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBpbnB1dC5hdXRvU2F2ZSA9PT0gdHJ1ZSxcclxuICAgICAgICBmb250TWFwLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBpZiAoc2V0dGluZ3NDYWNoZSkge1xyXG4gICAgICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsICdwcm9qZWN0Jyk7XHJcbiAgICBzZXR0aW5nc0NhY2hlID0gc2FmZVNldHRpbmdzKHNhdmVkKTtcclxuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBhd2FpdCBzZXR0aW5nc1dyaXRlUXVldWU7XHJcbiAgICByZXR1cm4gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoU2V0dGluZ3NXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBzZXR0aW5nc1dyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgc2V0dGluZ3NXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBuZXh0ID0gc2FmZVNldHRpbmdzKHZhbHVlKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsIG5leHQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgc2V0dGluZ3NDYWNoZSA9IG5leHQ7XHJcbiAgICAgICAgcmV0dXJuIG5leHQ7XHJcbiAgICB9KSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKCgpID0+IHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhdGNoU2V0dGluZ3ModmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIHdpdGhTZXR0aW5nc1dyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzVW5sb2NrZWQoKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQoeyAuLi5jdXJyZW50LCAuLi52YWx1ZSB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjbGllbnQoc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCA9IGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbCk6IFByb21pc2U8RmlnbWFDbGllbnQ+IHtcclxuICAgIHJldHVybiBuZXcgRmlnbWFDbGllbnQoYXdhaXQgdmF1bHQuZ2V0KCksIHNpZ25hbCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJvdW5kdHJpcFNlcnZpY2Uoc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPFJvdW5kdHJpcFNlcnZpY2U+IHtcclxuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XHJcbiAgICByZXR1cm4gbmV3IFJvdW5kdHJpcFNlcnZpY2Uoe1xyXG4gICAgICAgIGNsaWVudDogYXdhaXQgY2xpZW50KHNpZ25hbCksXHJcbiAgICAgICAgcHJvamVjdFJvb3Q6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgY3JlYXRvclZlcnNpb24sXHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTogQWJvcnRDb250cm9sbGVyIHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyIHx8IGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+WvvOWFpeaIlue7k+aenOiwg+aVtOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOWQjuWGjeaTjeS9nCBSb3VuZC10cmlw44CCJyk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xyXG4gICAgcmV0dXJuIGNvbnRyb2xsZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIpOiB2b2lkIHtcclxuICAgIGlmIChyb3VuZHRyaXBDb250cm9sbGVyID09PSBjb250cm9sbGVyKSByb3VuZHRyaXBDb250cm9sbGVyID0gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gYmVnaW5PcGVyYXRpb24ob3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsKTogQWJvcnRDb250cm9sbGVyIHtcclxuICAgIGlmIChhcHBseWluZ0ltcG9ydFJldmlldykgdGhyb3cgbmV3IEVycm9yKCfmraPlnKjnoa7orqTlr7zlhaXlkI7nmoTotYTmupDosIPmlbTvvIzor7fnqI3lgJnjgIInKTtcclxuICAgIGlmIChyb3VuZHRyaXBDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ1JvdW5kLXRyaXAg5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YWI5Y+W5raI44CCJyk7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggJiYgb3duZXIgIT09IGFjdGl2ZUJhdGNoLmlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aJuemHj+WvvOWFpeato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWBnOatouWQjue7reS7u+WKoeOAgicpO1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeW3suaciSBGaWdtYSDmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblhYjlj5bmtojjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gb3duZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgICAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWRQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKHNlbGVjdGVkUGF0aCk7XHJcbiAgICBjb25zdCBmb2xkZXIgPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBpZiAoIWZvbGRlciB8fCBmb2xkZXIgPT09ICcuJyB8fCBmb2xkZXIuc3RhcnRzV2l0aCgnLi4nKSB8fCBpc0Fic29sdXRlKGZvbGRlcikpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOi+k+WHuuebruW9leW/hemhu+aYr+mhueebriBhc3NldHMg5LiL55qE5a2Q5paH5Lu25aS544CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXREYXRhYmFzZVVybChmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoZmlsZVBhdGgpO1xyXG4gICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGNvbnN0IG91dHNpZGUgPSBwYXRoID09PSAnLi4nXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLi8nKVxyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi5cXFxcJylcclxuICAgICAgICB8fCBpc0Fic29sdXRlKHBhdGgpO1xyXG4gICAgaWYgKCFwYXRoIHx8IHBhdGggPT09ICcuJyB8fCBvdXRzaWRlKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gYGRiOi8vYXNzZXRzLyR7cGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyl9YDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oupIEZpZ21hIOWvvOWFpei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqemihOWItuS9k+i+k+WHuuebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93biwgX2luZGV4ID0gMCk6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnID8gY3VycmVudC50cmltKCkgOiAnJztcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gY3VycmVudEZvbGRlciAmJiBpc0Fic29sdXRlKGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgPyBjdXJyZW50Rm9sZGVyXHJcbiAgICAgICAgOiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqeacrOWcsOWQjOWQjei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGxpYnJhcnkgPSBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoc2VsZWN0ZWQpO1xyXG4gICAgcmV0dXJuIHsgZm9sZGVyOiBsaWJyYXJ5LnJvb3QgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5pb25GcmFtZShub2RlczogRmlnbWFOb2RlW10pOiBSZWN0IHtcclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGVzLm1hcChub2RlRnJhbWUpLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBSZWN0ID0+IEJvb2xlYW4odmFsdWUpKTtcclxuICAgIGlmICghZnJhbWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHggPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCkpO1xyXG4gICAgY29uc3QgeSA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55KSk7XHJcbiAgICBjb25zdCByaWdodCA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGgpKTtcclxuICAgIGNvbnN0IGJvdHRvbSA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0KSk7XHJcbiAgICByZXR1cm4geyB4LCB5LCB3aWR0aDogcmlnaHQgLSB4LCBoZWlnaHQ6IGJvdHRvbSAtIHkgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3Qge1xyXG4gICAgaWYgKG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gdW5pb25GcmFtZShub2RlLmNoaWxkcmVuKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxufVxyXG5cclxuY29uc3QgUkVOREVSX09WRVJGTE9XX0VQU0lMT04gPSAwLjU7XHJcblxyXG4vKipcclxuICogT25seSBleHBhbmQgcmFzdGVycyB3aG9zZSB2aXNpYmxlIHBpeGVscyBlc2NhcGUgdGhlIGdlb21ldHJpYyBmcmFtZS4gQVxyXG4gKiByZW5kZXIgZnJhbWUgY29udGFpbmVkIGluc2lkZSB0aGUgZ2VvbWV0cnkgb2Z0ZW4gcmVwcmVzZW50cyBpbnRlbnRpb25hbFxyXG4gKiB0cmFuc3BhcmVudCBwYWRkaW5nIGFuZCBtdXN0IGtlZXAgdGhlIGxlZ2FjeSBmaXhlZC1jYW52YXMgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3QgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgZ2VvbWV0cnkgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBjb25zdCByZW5kZXIgPSBub2RlLmFic29sdXRlUmVuZGVyQm91bmRzO1xyXG4gICAgaWYgKCFnZW9tZXRyeSB8fCAhcmVuZGVyIHx8IHJlbmRlci53aWR0aCA8PSAwIHx8IHJlbmRlci5oZWlnaHQgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBnZW9tZXRyeVJpZ2h0ID0gZ2VvbWV0cnkueCArIGdlb21ldHJ5LndpZHRoO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlCb3R0b20gPSBnZW9tZXRyeS55ICsgZ2VvbWV0cnkuaGVpZ2h0O1xyXG4gICAgY29uc3QgcmVuZGVyUmlnaHQgPSByZW5kZXIueCArIHJlbmRlci53aWR0aDtcclxuICAgIGNvbnN0IHJlbmRlckJvdHRvbSA9IHJlbmRlci55ICsgcmVuZGVyLmhlaWdodDtcclxuICAgIHJldHVybiByZW5kZXIueCA8IGdlb21ldHJ5LnggLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlci55IDwgZ2VvbWV0cnkueSAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyUmlnaHQgPiBnZW9tZXRyeVJpZ2h0ICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJCb3R0b20gPiBnZW9tZXRyeUJvdHRvbSArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgPyByZW5kZXJcclxuICAgICAgICA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29ybmVyUmFkaWkobm9kZTogRmlnbWFOb2RlKTogW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl0ge1xyXG4gICAgaWYgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWk/Lmxlbmd0aCA9PT0gNCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpIGFzIFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmFkaXVzID0gbm9kZS5jb3JuZXJSYWRpdXMgPz8gMDtcclxuICAgIHJldHVybiBbcmFkaXVzLCByYWRpdXMsIHJhZGl1cywgcmFkaXVzXTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdERlY2lzaW9uKG5vZGU6IEZpZ21hTm9kZSk6IERlY2lzaW9uIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgYWN0aW9uOiBpbmZlckFjdGlvbihub2RlKSxcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgbmluZVNsaWNlOiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlY2lzaW9uRm9yTm9kZShub2RlOiBGaWdtYU5vZGUsIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+KTogRGVjaXNpb24ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lzaW9uTWFwKG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSwgdHJlZTogVHJlZU5vZGVEdG9bXSk6IE1hcDxzdHJpbmcsIERlY2lzaW9uPiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRGVjaXNpb24+KCk7XHJcbiAgICBjb25zdCBmaWdtYVNsaWNlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgYWRkRGVmYXVsdHMgPSAobm9kZXM6IFRyZWVOb2RlRHRvW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgaWYgKG5vZGUucGF0Y2hDYW5kaWRhdGUpIGZpZ21hU2xpY2VzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24obm9kZS5hY3Rpb24pLFxyXG4gICAgICAgICAgICAgICAga2luZDogbm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBub2RlLnBhdGNoQ2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgICAgICAgICB9LCBCb29sZWFuKG5vZGUucGF0Y2hDYW5kaWRhdGUpKSk7XHJcbiAgICAgICAgICAgIGFkZERlZmF1bHRzKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBhZGREZWZhdWx0cyh0cmVlKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBvdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgICAgIGRlY2lzaW9ucy5zZXQoaXRlbS5pZCwgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcclxuICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgICAgICBraW5kOiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQpID8gaXRlbS5raW5kIDogJ2F1dG8nLFxyXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxyXG4gICAgICAgICAgICBleHBsaWNpdDogaXRlbS5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgICAgICB9LCBmaWdtYVNsaWNlcy5oYXMoaXRlbS5pZCkpKTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbnM7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbiAgICBpbmNsdWRlTm9kZU5hbWUgPSB0cnVlLFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKTtcclxuICAgIHJldHVybiBkZWNpc2lvbj8uZXhwbGljaXQgPT09IHRydWVcclxuICAgICAgICB8fCAoaW5jbHVkZU5vZGVOYW1lICYmIEJvb2xlYW4oZGVjaXNpb24/Lm5hbWUpKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxudHlwZSBTdG9yZWROb2RlT3ZlcnJpZGVzID0gUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+PjtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTogUHJvbWlzZTxTdG9yZWROb2RlT3ZlcnJpZGVzPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgaXRlbSA9IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0T3ZlcnJpZGU+O1xyXG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xyXG4gICAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBraW5kID0gdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgJiYgTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKVxyXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXHJcbiAgICAgICAgOiAnYXV0byc7XHJcbiAgICBjb25zdCBleHBsaWNpdCA9IGl0ZW0uZXhwbGljaXQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgIGlmICghZXhwbGljaXQgJiYgIW5hbWUpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZCxcclxuICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxyXG4gICAgICAgIGV4cGxpY2l0LFxyXG4gICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgY29uc3Qgc3RvcmVkID0gKGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKSlbZmlsZUtleV0gPz8ge307XHJcbiAgICBjb25zdCByZXN1bHQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xyXG4gICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlLCBpZCk7XHJcbiAgICAgICAgaWYgKHNhZmUpIHJlc3VsdC5wdXNoKHNhZmUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5vZGVPdmVycmlkZVdyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xyXG4gICAgY29uc3Qgc2FmZUl0ZW1zID0gaXRlbXNcclxuICAgICAgICAubWFwKChpdGVtKSA9PiBzYWZlTm9kZU92ZXJyaWRlKGl0ZW0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgIChBcnJheS5pc0FycmF5KHNjb3BlVmFsdWVzKSA/IHNjb3BlVmFsdWVzIDogc2FmZUl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxyXG4gICAgKTtcclxuICAgIGlmICghc2NvcGVJZHMuc2l6ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY29wZWRJdGVtcyA9IHNhZmVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNjb3BlSWRzLmhhcyhpdGVtLmlkKSk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgZm9yIChjb25zdCBpZCBvZiBzY29wZUlkcykge1xyXG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzY29wZWRJdGVtcykge1xyXG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xyXG4gICAgfVxyXG4gICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkge1xyXG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNjb3BlZEl0ZW1zO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlcyhcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhcclxuICAgICAgICAoKSA9PiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKGZpbGVLZXksIHZhbHVlcywgc2NvcGVWYWx1ZXMpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhdGNoTm9kZU5hbWVzKGZpbGVLZXk6IHN0cmluZywgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFmaWxlS2V5LnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgcGF0Y2ggb2YgcGF0Y2hlcykge1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiBwYXRjaC5pZCA9PT0gJ3N0cmluZycgPyBwYXRjaC5pZC50cmltKCkgOiAnJztcclxuICAgICAgICAgICAgaWYgKCFpZCkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgbm9kZUlk44CCJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gc2FmZU5vZGVPdmVycmlkZShjdXJyZW50W2lkXSwgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBmYWxsYmFjayA9IHNhZmVOb2RlT3ZlcnJpZGUocGF0Y2guZmFsbGJhY2ssIGlkKTtcclxuICAgICAgICAgICAgY29uc3QgbmV4dCA9IGV4aXN0aW5nID8geyAuLi5leGlzdGluZyB9IDogZmFsbGJhY2sgPyB7IC4uLmZhbGxiYWNrIH0gOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5leHQgJiYgcGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFuZXh0KSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnvLrlsJHmnInmlYjpu5jorqTnrZbnlaXjgIJgKTtcclxuICAgICAgICAgICAgaWYgKHBhdGNoLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBuZXh0Lm5hbWU7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShwYXRjaC5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g55qE5ZCN56ew5peg5pWI44CCYCk7XHJcbiAgICAgICAgICAgICAgICBuZXh0Lm5hbWUgPSBuYW1lO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKG5leHQsIGlkKTtcclxuICAgICAgICAgICAgaWYgKHNhZmUpIHtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnRbaWRdID0gc2FmZTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3RlZC5wdXNoKHNhZmUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGgpIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICAgICAgZWxzZSBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIHBlcnNpc3RlZDtcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xyXG4gICAgY29uc3QgZGVmYXVsdHMgPSBkZWNpc2lvbk1hcChbXSwgc2Vzc2lvbi50cmVlKTtcclxuICAgIHNlc3Npb24udHJlZSA9IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgICAgIHNlc3Npb24udHJlZSxcclxuICAgICAgICBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWZhdWx0cyksXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwcmVwYXJlZDogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKSxcclxuKTogeyBwbmc6IEZpZ21hTm9kZVtdOyB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXTsgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdOyBncmFkaWVudHM6IEZpZ21hTm9kZVtdIH0ge1xyXG4gICAgY29uc3QgcG5nOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBhbmNlc3RvcnNWaXNpYmxlOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgaWYgKHByZXBhcmVkLmhhcyhub2RlLmlkKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZWx5VmlzaWJsZSA9IGFuY2VzdG9yc1Zpc2libGUgJiYgbm9kZS52aXNpYmxlICE9PSBmYWxzZSAmJiBub2RlLm9wYWNpdHkgPiAwO1xyXG4gICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZWZmZWN0aXZlbHlWaXNpYmxlKSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSkge1xyXG4gICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2UgPSBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoc291cmNlKSB7XHJcbiAgICAgICAgICAgICAgICB0aWxlZC5wdXNoKHsgbm9kZSwgc291cmNlIH0pO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gVGhlIHNhbWUgcGxhaW4gSU1BR0Ugc291cmNlIGFuZCBjZW50ZXJlZCBjcm9wIHBhdGggc2VydmUgYm90aFxyXG4gICAgICAgICAgICAgICAgLy8gdmlzaWJpbGl0eSBzdGF0ZXM7IHdob2xlLW5vZGUgZXhwb3J0cyBjYW4gYmFrZSBkaWZmZXJlbnQgYWxwaGEuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZVJlZiA9IHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgICAgICByYXdJbWFnZXMucHVzaCh7IG5vZGUsIGltYWdlUmVmIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgICAgICBpZiAoZmlsbCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZ3JhZGllbnRzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB0cnVlKSk7XHJcbiAgICByZXR1cm4geyBwbmcsIHRpbGVkLCByYXdJbWFnZXMsIGdyYWRpZW50cyB9O1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRBc3NldHMoXG4gICAgc2Vzc2lvbjogRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBpbXBvcnRTZXR0aW5nczogSW1wb3J0U2V0dGluZ3MsXHJcbiAgICByZXZpZXc6IEltcG9ydFJldmlld1JlY29yZGVyLFxyXG4pOiBQcm9taXNlPEFzc2V0QnVpbGRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHJlc29sdmVkRGVjaXNpb25zID0gcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBkZWNpc2lvbnMuY2xlYXIoKTtcclxuICAgIHJlc29sdmVkRGVjaXNpb25zLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IGRlY2lzaW9ucy5zZXQoa2V5LCB2YWx1ZSkpO1xyXG4gICAgY29uc3Qgd3JpdGVTdGF0ZXMgPSBuZXcgTWFwPHN0cmluZywgYm9vbGVhbj4oKTtcclxuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5hc3NldEZvbGRlciwgYXN5bmMgKHVybCwgZXhpc3RlZCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IHJldmlldy5iZWZvcmVXcml0ZSh1cmwsIGV4aXN0ZWQpO1xyXG4gICAgICAgIHdyaXRlU3RhdGVzLnNldCh1cmwsIGV4aXN0ZWQpO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCB3cml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgY2FjaGUgPSBuZXcgTG9jYWxBc3NldENhY2hlKGRlZmF1bHRDYWNoZUZvbGRlcigpKTtcclxuICAgIGF3YWl0IGNhY2hlLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VzID0gaW1wb3J0U2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShmb2xkZXIpKTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKGxvY2FsUmVzb3VyY2VzLm1hcCgobGlicmFyeSkgPT4gbGlicmFyeS5pbml0aWFsaXplKCkpKTtcclxuICAgIC8vIEluZGV4IGV4aXN0aW5nIG5hbWVzIG9uY2U7IG5ldyByZXNvdXJjZXMgYXJlIHNoYXJlZCBieSBuYW1lIGJlbG93LlxyXG4gICAgY29uc3Qgb3V0cHV0UGF0aCA9IGpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycsIHdyaXRlci5mb2xkZXIpO1xyXG4gICAgY29uc3Qgb3V0cHV0UmVzb3VyY2VzID0gZXhpc3RzU3luYyhvdXRwdXRQYXRoKSA/IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShvdXRwdXRQYXRoKSA6IG51bGw7XHJcbiAgICBhd2FpdCBvdXRwdXRSZXNvdXJjZXM/LmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XHJcbiAgICAvLyBUaGUgcHJvamVjdCBjb250cmFjdCBpcyBzYW1lIG5hbWUgPSBzYW1lIHJlc291cmNlLiBTaGFyZSBhY3Jvc3MgcmVuZGVyLFxyXG4gICAgLy8gSU1BR0UgYW5kIGdyYWRpZW50IHBhdGhzIGJlZm9yZSBkb3dubG9hZGluZyBvciBjb21wYXJpbmcgYW55IHBpeGVscy5cclxuICAgIGNvbnN0IHNoYXJlZEFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XHJcbiAgICBjb25zdCByZXNvdXJjZUtleSA9IChub2RlOiBGaWdtYU5vZGUpID0+IHdyaXRlci5idWlsZFVybChub2RlLm5hbWUsICcnLCAncG5nJywgaW1wb3J0U2V0dGluZ3Muc2NhbGUpXHJcbiAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgY29uc3Qgd2FybmluZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IG5vdGUgPSAoYWN0aW9uOiBOb25OdWxsYWJsZTxJbXBvcnRSZXZpZXdbJ2RlY2lzaW9ucyddPltudW1iZXJdWydhY3Rpb24nXSwgbmFtZTogc3RyaW5nLCByZWFzb246IHN0cmluZywgdXJsPzogc3RyaW5nKSA9PlxyXG4gICAgICAgIHJldmlldy5ub3RlPy4oYWN0aW9uLCBuYW1lLCByZWFzb24sIHVybCk7XHJcbiAgICBjb25zdCBub3RlV3JpdGUgPSAoYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYykgPT4gbm90ZSh3cml0ZVN0YXRlcy5nZXQoYXNzZXQudXJsKSA/ICd1cGRhdGVkJyA6ICdjcmVhdGVkJyxcclxuICAgICAgICBiYXNlbmFtZShhc3NldC51cmwpLCB3cml0ZVN0YXRlcy5nZXQoYXNzZXQudXJsKVxyXG4gICAgICAgICAgICA/ICflhpnlhaXlkIzlkI3ovpPlh7rotYTmupDvvIzkv53nlZnljp8gVVVJRCdcclxuICAgICAgICAgICAgOiAn5oyJ5ZCN56ew5a+85YWl5LiA5Lu96LWE5rqQ77yM5ZCM5ZCN6IqC54K555u05o6l5YWx55SoJywgYXNzZXQudXJsKTtcclxuICAgIGNvbnN0IG5vZGVTb3VyY2VLZXkgPSAobm9kZTogRmlnbWFOb2RlLCB2YXJpYW50ID0gJ3Jhc3Rlci12MicpID0+XHJcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoW3Nlc3Npb24uZmlsZUtleSwgbm9kZS5pZCwgaW1wb3J0U2V0dGluZ3Muc2NhbGUsIHZhcmlhbnRdKTtcclxuICAgIGNvbnN0IGdyb3VwU291cmNlS2V5ID0gKGFzc2V0S2V5OiBzdHJpbmcpID0+IEpTT04uc3RyaW5naWZ5KFtzZXNzaW9uLmZpbGVLZXksICd0aWxlLXYyJywgYXNzZXRLZXldKTtcclxuICAgIGNvbnN0IGltYWdlRGV0YWlscyA9IChub2RlOiBGaWdtYU5vZGUpID0+IHtcclxuICAgICAgICBsZXQgbGVhZiA9IG5vZGUsIGlubmVyT3BhY2l0eSA9IDE7XHJcbiAgICAgICAgd2hpbGUgKGxlYWYuY2hpbGRyZW4ubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGxlYWYgPSBsZWFmLmNoaWxkcmVuWzBdO1xyXG4gICAgICAgICAgICBpbm5lck9wYWNpdHkgKj0gbGVhZi5vcGFjaXR5O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBsZWFmLCBpbm5lck9wYWNpdHkgfTtcclxuICAgIH07XHJcbiAgICBjb25zdCBmaW5kT3V0cHV0ID0gYXN5bmMgKG5hbWU6IHN0cmluZykgPT4ge1xyXG4gICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cyAmJiBvdXRwdXRSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBvdXRwdXRSZXNvdXJjZXMuZmluZChuYW1lLCAncG5nJyk7XHJcbiAgICAgICAgICAgIGlmIChtYXRjaCkgcmV0dXJuIHsgLi4ubWF0Y2gsIHNvdXJjZTogJ2V4aXN0aW5nJyBhcyBjb25zdCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH07XHJcbiAgICBjb25zdCBmaW5kTG9jYWwgPSBhc3luYyAobmFtZTogc3RyaW5nLCBpbmNsdWRlT3V0cHV0ID0gdHJ1ZSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbFJlc291cmNlcykge1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChuYW1lLCAncG5nJyk7XHJcbiAgICAgICAgICAgIC8vIERpcmVjdG9yeSBvcmRlciwgZXh0ZW5zaW9uIHByZWZlcmVuY2UgYW5kIHJvb3QtYmVmb3JlLXN1YmZvbGRlclxyXG4gICAgICAgICAgICAvLyBvcmRlcmluZyBhcmUgdGhlIGV4aXN0aW5nIHVzZXItZGVjbGFyZWQgbmFtZSBtYXBwaW5nIGNvbnRyYWN0LlxyXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdsb2NhbCcgYXMgY29uc3QgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIGluY2x1ZGVPdXRwdXQgPyBmaW5kT3V0cHV0KG5hbWUpIDogbnVsbDtcclxuICAgIH07XHJcbiAgICBjb25zdCBwcmVwYXJlTWFzayA9IGFzeW5jIChub2RlOiBGaWdtYU5vZGUpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScgfHwgZGVjaXNpb24ubmluZVNsaWNlKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgYW5hbHlzaXMgPSBhbmFseXplTWFza1RpbnQobm9kZSk7XHJcbiAgICAgICAgaWYgKGFuYWx5c2lzICYmICFzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShub2RlLCBkZWNpc2lvbnMsIGZhbHNlKSkge1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIGtpbmQ6ICdzcHJpdGUnLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICBsZXQgcmVhc29uID0gYW5hbHlzaXMucmVhc29uO1xyXG4gICAgICAgICAgICBpZiAoYW5hbHlzaXMuY2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IG1hc2ssIHRpbnQgfSA9IGFuYWx5c2lzLmNhbmRpZGF0ZTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgZmluZExvY2FsKG1hc2submFtZSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsb2NhbFVybCA9IG1hdGNoID8gYXNzZXREYXRhYmFzZVVybChtYXRjaC5wYXRoKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKVxyXG4gICAgICAgICAgICAgICAgICAgIDogYXdhaXQgd3JpdGVyLmV4aXN0aW5nRm9yU291cmNlKG5vZGVTb3VyY2VLZXkobWFzayksIHsgdGlsZWQ6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgICAgLy8gVmVyaWZ5IHRoZSBieXRlcyBvZiB0aGUgcmVmZXJlbmNlZCBhc3NldCwgbmV2ZXIgYW4gdW5yZWxhdGVkXHJcbiAgICAgICAgICAgICAgICAvLyBzYW1lLW5hbWUgZmlsZSBmcm9tIGEgcHJvamVjdC1leHRlcm5hbCBsaWJyYXJ5IGRpcmVjdG9yeS5cclxuICAgICAgICAgICAgICAgIGNvbnN0IGJ5dGVzID0gbG9jYWxVcmwgJiYgYXNzZXQgPyBtYXRjaCEuY29udGVudHNcclxuICAgICAgICAgICAgICAgICAgICA6IGFzc2V0ID8gYXdhaXQgcmVhZEZpbGUoam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCBhc3NldC51cmwuc2xpY2UoJ2RiOi8vJy5sZW5ndGgpKSkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBieXRlcyA/IHZlcmlmeVdoaXRlQWxwaGFQbmcoYnl0ZXMpIDogeyB2YWxpZDogZmFsc2UsIHJlYXNvbjogJ+ayoeacieWPr+mqjOivgeeahOacrOWcsOeZveiJsuW6leWbvicgfTtcclxuICAgICAgICAgICAgICAgIHJlYXNvbiA9IHZlcmlmaWVkLnJlYXNvbjtcclxuICAgICAgICAgICAgICAgIGlmIChhc3NldCAmJiB2ZXJpZmllZC52YWxpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRpbnRlZCA9IHsgLi4uYXNzZXQsIHRpbnQgfTtcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMuc2V0KG5vZGUuaWQsIHRpbnRlZCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV2aWV3LmJpbmQobm9kZSwgdGludGVkLCBtYXRjaD8uc291cmNlID8/ICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgICAgIG5vdGUoJ3RpbnRlZCcsIG5vZGUubmFtZSwgYCR7YW5hbHlzaXMucmVhc29ufe+8myR7dmVyaWZpZWQucmVhc29ufe+8m+ayv+eUqOWOnyBVVUlEIOS4juS5neWuq+WPguaVsO+8jOmAj+aYjuW6puS7heiuoeeul+S4gOasoWAsIGFzc2V0LnVybCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vdGUoJ2ZhbGxiYWNrJywgbm9kZS5uYW1lLCBgJHtyZWFzb25977yb5L2/55SoIEZpZ21hIOWujOaVtOiSmeeJiOWQiOaIkO+8jOS4jeS/ruaUueWFseS6q+W6leWbvmApO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInKSByZXR1cm47XHJcbiAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuKSBhd2FpdCBwcmVwYXJlTWFzayhjaGlsZCk7XHJcbiAgICB9O1xyXG4gICAgZm9yIChjb25zdCByb290IG9mIHNlc3Npb24ucm9vdHMpIGF3YWl0IHByZXBhcmVNYXNrKHJvb3QpO1xyXG4gICAgY29uc3QgcHJvdGVjdGVkRGVzY2VuZGFudCA9IChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuID0+IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHtcclxuICAgICAgICBjb25zdCBjaGlsZERlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKGNoaWxkLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChjaGlsZERlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBmYWxzZTtcclxuICAgICAgICByZXR1cm4gQm9vbGVhbihjaGlsZC5pc01hc2sgfHwgY2hpbGQuY2hpbGRyZW4uc29tZSgocGFydCkgPT4gcGFydC5pc01hc2spXHJcbiAgICAgICAgICAgIHx8IGFzc2V0cy5oYXMoY2hpbGQuaWQpIHx8IGNoaWxkRGVjaXNpb24ubmluZVNsaWNlIHx8IGlzTmFtZWRTbGljZUdyb3VwKGNoaWxkKSB8fCBpc1BhdGNoQ2FuZGlkYXRlKGNoaWxkKSlcclxuICAgICAgICAgICAgfHwgKGNoaWxkRGVjaXNpb24uYWN0aW9uICE9PSAncmVuZGVyJyAmJiBwcm90ZWN0ZWREZXNjZW5kYW50KGNoaWxkKSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHByb21vdGVMb2NhbFBhcmVudHMgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgaWYgKGFzc2V0cy5oYXMobm9kZS5pZCkgfHwgYW5hbHl6ZU1hc2tUaW50KG5vZGUpKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uICE9PSAnZ2VuZXJhdGUnKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICAgICAgLy8gUmVuYW1pbmcgdGhpcyBjb250YWluZXIgZG9lcyBub3QgY2hhbmdlIHJlc291cmNlIG1hdGNoaW5nOyBvbmx5XHJcbiAgICAgICAgICAgIC8vIGEgc3RyYXRlZ3kgb3ZlcnJpZGUgb24gaXRzZWxmIG9yIGFueSBvdmVycmlkZSBiZWxvdyBpdCBibG9ja3NcclxuICAgICAgICAgICAgLy8gcHJvbW90aW9uIGJlY2F1c2UgZGVzY2VuZGFudHMgd291bGQgb3RoZXJ3aXNlIGRpc2FwcGVhci5cclxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpXHJcbiAgICAgICAgICAgIC8vIEEgc2FtZS1uYW1lIGFuY2VzdG9yIGlzIG5vdCBwZXJtaXNzaW9uIHRvIGVyYXNlIGluZGVwZW5kZW50IHNsaWNlXHJcbiAgICAgICAgICAgIC8vIHJlc291cmNlcyBvciBhIHZlcmlmaWVkL2ZhbGxiYWNrIG1hc2sgcmVwcmVzZW50YXRpb24gYmVsb3cgaXQuXHJcbiAgICAgICAgICAgICYmICFwcm90ZWN0ZWREZXNjZW5kYW50KG5vZGUpXHJcbiAgICAgICAgICAgIC8vIEEgbG9jYWwgcGFyZW50IHJlc291cmNlIGNhbm5vdCByZXByZXNlbnQgaW5kZXBlbmRlbnRseSBpbmFjdGl2ZVxyXG4gICAgICAgICAgICAvLyBkZXNjZW5kYW50cy4gS2VlcCB0aGUgaGllcmFyY2h5IHdoZW5ldmVyIHN1Y2ggYSBib3VuZGFyeSBleGlzdHMuXHJcbiAgICAgICAgICAgICYmICFoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsTWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobm9kZS5jaGlsZHJlbi5tYXAocHJvbW90ZUxvY2FsUGFyZW50cykpO1xyXG4gICAgfTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKHNlc3Npb24ucm9vdHMubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIGNvbnN0IGZpbmFsRGVjaXNpb25zID0gcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBkZWNpc2lvbnMuY2xlYXIoKTtcclxuICAgIGZpbmFsRGVjaXNpb25zLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IGRlY2lzaW9ucy5zZXQoa2V5LCB2YWx1ZSkpO1xyXG4gICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgY29uc3QgYWN0aXZlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBhY3RpdmVCb3VuZGFyeSA9IChub2RlOiBGaWdtYU5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm47XHJcbiAgICAgICAgYWN0aXZlSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICBpZiAoaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pIHx8IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBhc3NldHMuaGFzKG5vZGUuaWQpKSByZXR1cm47XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFjdGl2ZUJvdW5kYXJ5KTtcclxuICAgIH07XHJcbiAgICBzZXNzaW9uLnJvb3RzLmZvckVhY2goYWN0aXZlQm91bmRhcnkpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHBsYW5dIG9mIHBsYW5zKSB7XHJcbiAgICAgICAgaWYgKCFhY3RpdmVJZHMuaGFzKGlkKSkgY29udGludWU7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNlc3Npb24ubm9kZUJ5SWQ/LmdldChpZCk7XHJcbiAgICAgICAgaWYgKHBsYW4ucmVhc29uID09PSAncHJlZml4LW1lcmdlJykgbm90ZSgnbWVyZ2VkJywgbm9kZT8ubmFtZSA/PyBpZCxcclxuICAgICAgICAgICAgcGxhbi53YXJuaW5nID8/ICdpY29uXy9pbWdfIOacgOWkluWxgui1hOa6kOi+ueeVjO+8jOaMieW9k+WJjeaYvumakOWQiOaIkO+8jOS/neeVmeeItuiKgueCueWHoOS9leS4jumAj+aYjuW6picpO1xyXG4gICAgICAgIGVsc2UgaWYgKHBsYW4ud2FybmluZykge1xyXG4gICAgICAgICAgICB3YXJuaW5ncy5hZGQoYCR7bm9kZT8ubmFtZSA/PyBpZH3vvJoke3BsYW4ud2FybmluZ31gKTtcclxuICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlPy5uYW1lID8/IGlkLCBwbGFuLndhcm5pbmcpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHJlcXVlc3RzID0gY29sbGVjdEFzc2V0UmVxdWVzdHMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zLCBuZXcgU2V0KGFzc2V0cy5rZXlzKCkpKTtcclxuICAgIGNvbnN0IHRvdGFsID0gcmVxdWVzdHMucG5nLmxlbmd0aCArIHJlcXVlc3RzLnRpbGVkLmxlbmd0aFxyXG4gICAgICAgICsgcmVxdWVzdHMucmF3SW1hZ2VzLmxlbmd0aCArIHJlcXVlc3RzLmdyYWRpZW50cy5sZW5ndGg7XHJcbiAgICBsZXQgY29tcGxldGVkID0gMDtcclxuICAgIGxldCBhcGlQcm9taXNlOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgIGNvbnN0IGdldEFwaSA9ICgpID0+IHtcclxuICAgICAgICBhcGlQcm9taXNlID8/PSBkaWFnbm9zdGljVGFzaygn5YeG5aSHIEZpZ21hIOWuouaIt+errycsIHVuZGVmaW5lZCwgKCkgPT4gY2xpZW50KCkpO1xyXG4gICAgICAgIHJldHVybiBhcGlQcm9taXNlO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBjb21wbGV0ZUFzc2V0ID0gKFxyXG4gICAgICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyB8ICdnZW5lcmF0ZWQnID0gJ2ZpZ21hJyxcclxuICAgICkgPT4ge1xyXG4gICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgYXNzZXQpO1xyXG4gICAgICAgIHJldmlldy5iaW5kKG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgIGlmIChzb3VyY2UgPT09ICdsb2NhbCcgfHwgc291cmNlID09PSAnZXhpc3RpbmcnKSBub3RlKCdyZXVzZWQnLCBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZSA9PT0gJ2xvY2FsJyA/ICfnlKjmiLfmjIflrprmnKzlnLDnm67lvZXnmoTlkIzlkI3mmKDlsITvvIzkv53nlZnljp8gU3ByaXRlRnJhbWUgVVVJRCDkuI7liIfniYflj4LmlbAnXHJcbiAgICAgICAgICAgICAgICA6ICfmjInlt7LmnInotYTmupDmiJbmnKzmibnlkIzlkI3otYTmupDlpI3nlKjljp8gU3ByaXRlRnJhbWXvvIzkv53nlZkgVVVJRCDkuI7ljp/liIfniYflj4LmlbAnLCBhc3NldC51cmwpO1xyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGNvbnN0IHZlcmIgPSBzb3VyY2UgPT09ICdsb2NhbCdcclxuICAgICAgICAgICAgPyAn5aSN55So5pys5Zyw6LWE5rqQJ1xyXG4gICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJ1xyXG4gICAgICAgICAgICAgICAgPyAn5aSN55So5bey5pyJ6LWE5rqQJ1xyXG4gICAgICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdnZW5lcmF0ZWQnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAn55Sf5oiQ5riQ5Y+YJ1xyXG4gICAgICAgICAgICAgICAgOiAn5a+85YWl6LWE5rqQJztcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYCR7dmVyYn0gJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NUaWxlZCA9IGFzeW5jIChpdGVtczogVGlsZWRBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbiAgICAgICAgICAgIHNvdXJjZUtleTogc3RyaW5nO1xyXG4gICAgICAgICAgICBhc3NldEtleTogc3RyaW5nO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgUGVuZGluZ1RpbGUgZXh0ZW5kcyBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgZXh0ZW5zaW9uPzogUmFzdGVySW1hZ2VFeHRlbnNpb247XHJcbiAgICAgICAgICAgIHNvdXJjZVR5cGU6ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXF1ZXN0ZWRTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IGltcG9ydFNldHRpbmdzLnNjYWxlICogc291cmNlLnNjYWxlO1xyXG4gICAgICAgIGNvbnN0IHJlbmRlclNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgPyBjbGFtcEltYWdlU2NhbGUocmVxdWVzdGVkU2NhbGUoc291cmNlKSlcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBUaWxlR3JvdXA+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCB7IG5vZGUsIHNvdXJjZSB9IG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUtleSA9IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHNvdXJjZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgaWQ6IHNvdXJjZS5pZCxcclxuICAgICAgICAgICAgICAgIHBhaW50U2NhbGU6IHNvdXJjZS5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJlbmRlclNjYWxlOiByZW5kZXJTY2FsZShzb3VyY2UpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXRLZXkgPSB0aWxlZFJhc3RlcktleShzb3VyY2VLZXksIHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChub2RlLm5hbWUsIGFzc2V0S2V5LCAncG5nJylcclxuICAgICAgICAgICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKVxyXG4gICAgICAgICAgICAgICAgLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGUsIG5vZGVzOiBbXSwgc291cmNlLCBzb3VyY2VLZXksIGFzc2V0S2V5IH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZ0Fzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBleGlzdGluZ0Fzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nRm9yU291cmNlKGdyb3VwU291cmNlS2V5KGdyb3VwLmFzc2V0S2V5KSwgeyB0aWxlZDogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdBc3NldCkge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cC5ub2RlcywgcGl4ZWxTaXplZFRpbGVBc3NldChleGlzdGluZ0Fzc2V0KSwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgY2FjaGVkRXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRlbnNpb25zOiByZWFkb25seSBSYXN0ZXJJbWFnZUV4dGVuc2lvbltdID0gZ3JvdXAuc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IFsncG5nJ11cclxuICAgICAgICAgICAgICAgICAgICA6IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TO1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBleHRlbnNpb24gb2YgZXh0ZW5zaW9ucykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtncm91cC5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShncm91cC5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWNoZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBjYWNoZWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlZEV4dGVuc2lvbiA9IGV4dGVuc2lvbjtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAuLi5ncm91cCxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBjYWNoZWRFeHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VUeXBlOiBjb250ZW50cyA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuVXJscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5zQnlTY2FsZSA9IG5ldyBNYXA8bnVtYmVyLCBTZXQ8c3RyaW5nPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmVtb3RlSXRlbXMpIHtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc291cmNlLmtpbmQgIT09ICdzb3VyY2Utbm9kZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBpZHMgPSBwYXR0ZXJuc0J5U2NhbGUuZ2V0KHNjYWxlKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgaWRzLmFkZChpdGVtLnNvdXJjZS5pZCk7XHJcbiAgICAgICAgICAgIHBhdHRlcm5zQnlTY2FsZS5zZXQoc2NhbGUsIGlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgW3NjYWxlLCBpZHNdIG9mIHBhdHRlcm5zQnlTY2FsZSkge1xyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBBcnJheS5mcm9tKGlkcyksXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtpZCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyh1cmxzKSkge1xyXG4gICAgICAgICAgICAgICAgcGF0dGVyblVybHMuc2V0KGAke2lkfTpzY2FsZToke3NjYWxlfWAsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmVlZHNJbWFnZUZpbGxzID0gcmVtb3RlSXRlbXMuc29tZSgoaXRlbSkgPT4gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ2ltYWdlLXJlZicpO1xyXG4gICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBuZWVkc0ltYWdlRmlsbHNcclxuICAgICAgICAgICAgPyBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KVxyXG4gICAgICAgICAgICA6IHt9O1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWQgPSAodXJsOiBzdHJpbmcsIG5vZGVMYWJlbDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZCh1cmwsIG5vZGVMYWJlbCkpO1xyXG4gICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldCh1cmwsIHRhc2spO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB0YXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uID0gaXRlbS5leHRlbnNpb247XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IHBhdHRlcm5VcmxzLmdldChcclxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7aXRlbS5zb3VyY2UuaWR9OnNjYWxlOiR7cmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgICAgICAgIDogaW1hZ2VGaWxsVXJsc1tpdGVtLnNvdXJjZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGBQQVRURVJOIOa6kOiKgueCuSAke2l0ZW0uc291cmNlLmlkfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBgSU1BR0Ug5aGr5YWFICR7aXRlbS5zb3VyY2UuaWR9YDtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+myR7bGFiZWx977yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdwbmcnXHJcbiAgICAgICAgICAgICAgICAgICAgOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtpdGVtLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFleHRlbnNpb24pIHtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5bmz6ZO66LWE5rqQ5oyJ5a6e6ZmF5bC65a+455Sf5oiQJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcclxuICAgICAgICAgICAgbGV0IHJhc3RlcjogUmV0dXJuVHlwZTx0eXBlb2YgcmFzdGVyaXplVGlsZT47XHJcbiAgICAgICAgICAgIHRyeSB7IHJhc3RlciA9IHJhc3Rlcml6ZVRpbGUoY29udGVudHMsIHJlcXVlc3RlZFNjYWxlKGl0ZW0uc291cmNlKSwgcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpKTsgfVxyXG4gICAgICAgICAgICBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlubPpk7rotYTmupDigJwke2l0ZW0ubm9kZS5uYW1lfeKAneaXoOazleaMieWunumZheWwuuWvuOeUn+aIkO+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChyYXN0ZXIucm91bmRlZCkgd2FybmluZ3MuYWRkKGDlubPpk7rotYTmupDigJwke2l0ZW0ubm9kZS5uYW1lfeKAneeahOaYvuekuuWwuuWvuOW3suWPluaVtOS4uiAke3Jhc3Rlci53aWR0aH3DlyR7cmFzdGVyLmhlaWdodH0g5YOP57Sg77yI5pyA5bCPIDHvvInvvIzoioLngrkgU2NhbGUg5L+d5oyBIDHjgIJgKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwoaXRlbS5ub2RlLm5hbWUsIGl0ZW0uYXNzZXRLZXksICdwbmcnKTtcclxuICAgICAgICAgICAgY29tcGxldGVHcm91cChcclxuICAgICAgICAgICAgICAgIGl0ZW0ubm9kZXMsXHJcbiAgICAgICAgICAgICAgICBwaXhlbFNpemVkVGlsZUFzc2V0KGF3YWl0IHdyaXRlci5yZXNvbHZlKHVybCwgcmFzdGVyLmNvbnRlbnRzLCB7IHNvdXJjZUtleTogZ3JvdXBTb3VyY2VLZXkoaXRlbS5hc3NldEtleSksIHRpbGVkOiB0cnVlIH0pKSxcclxuICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlVHlwZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgdHJhY2UuZG9uZSh7IHNvdXJjZVdpZHRoOiByYXN0ZXIuc291cmNlV2lkdGgsIHNvdXJjZUhlaWdodDogcmFzdGVyLnNvdXJjZUhlaWdodCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiByYXN0ZXIud2lkdGgsIGhlaWdodDogcmFzdGVyLmhlaWdodCwgdGlsZVNjYWxlOiAxIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1JlbW90ZSA9IGFzeW5jIChub2RlczogRmlnbWFOb2RlW10pID0+IHtcclxuICAgICAgICBpZiAoIW5vZGVzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZvcm1hdCA9ICdwbmcnIGFzIGNvbnN0O1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHVybDogc3RyaW5nOyBub2RlczogRmlnbWFOb2RlW10gfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9YCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSByZXNvdXJjZUtleShub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBBcnJheTx7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICB1cmw6IHN0cmluZztcclxuICAgICAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfTtcclxuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XHJcbiAgICAgICAgICAgIHJlbmRlckZyYW1lPzogUmVjdDtcclxuICAgICAgICAgICAga2V5OiBDYWNoZUVudHJ5S2V5O1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfT4gPSBbXTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBBIGRlY2xhcmVkIEZpZ21hIHNsaWNlIG93bnMgdGhpcyBzYW1lLW5hbWUgcmVzb3VyY2UgZXZlbiB3aGVuIGFuXHJcbiAgICAgICAgICAgIC8vIG9yZGluYXJ5IFBORyB3YXMgZW5jb3VudGVyZWQgZmlyc3QuIElNQUdFIGFuZCBncmFkaWVudCBzdGFnZXNcclxuICAgICAgICAgICAgLy8gcnVuIGxhdGVyIGFuZCBzaGFyZSB0aGlzIHNpbmdsZSBnZW5lcmF0ZWQgcmVzdWx0LlxyXG4gICAgICAgICAgICBjb25zdCBzbGljZWRTb3VyY2VzID0gZ3JvdXBlZE5vZGVzLmZsYXRNYXAoKGNhbmRpZGF0ZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgaWYgKGRlY2lzaW9uRm9yTm9kZShjYW5kaWRhdGUsIGRlY2lzaW9ucykuYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIFtdO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYW5hbHlzaXMgPSBhbmFseXplU2xpY2VHcmlkKGNhbmRpZGF0ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gYW5hbHlzaXMgPyBbeyBub2RlOiBjYW5kaWRhdGUsIGFuYWx5c2lzIH1dIDogW107XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZFNsaWNlID0gc2xpY2VkU291cmNlc1swXTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IHNlbGVjdGVkU2xpY2U/Lm5vZGUgPz8gZ3JvdXBlZE5vZGVzWzBdO1xyXG4gICAgICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xuICAgICAgICAgICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IHNlbGVjdGVkU2xpY2U/LmFuYWx5c2lzID8/IChkZWNpc2lvbi5uaW5lU2xpY2UgPyBhbmFseXplU2xpY2VHcmlkKG5vZGUpIDogbnVsbCk7XHJcbiAgICAgICAgICAgIGlmIChzZWxlY3RlZFNsaWNlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzaGFwZSA9IChlbnRyeTogdHlwZW9mIHNlbGVjdGVkU2xpY2UpID0+IEpTT04uc3RyaW5naWZ5KHsgbW9kZTogZW50cnkuYW5hbHlzaXMubW9kZSxcclxuICAgICAgICAgICAgICAgICAgICBib3JkZXJzOiBlbnRyeS5hbmFseXNpcy5ib3JkZXJzLCBmcmFtZTogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94ICYmIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveC53aWR0aCwgaGVpZ2h0OiBlbnRyeS5ub2RlLmFic29sdXRlQm91bmRpbmdCb3guaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIH0gfSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2xpY2VkU291cmNlcy5zbGljZSgxKS5zb21lKChlbnRyeSkgPT4gc2hhcGUoZW50cnkpICE9PSBzaGFwZShzZWxlY3RlZFNsaWNlKSkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByZWFzb24gPSBg5ZCM5ZCN5LiJL+S5neWuq+WumuS5ieS4jeWQjO+8jOayv+eUqOmmluS4quacieaViCBGaWdtYSDliIfniYfigJwke25vZGUubmFtZX3igJ3nmoTljp/lp4vnlLvluIPkuI7ovrnot53vvIzku4XnlJ/miJDkuIDku73otYTmupBgO1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChyZWFzb24pO1xyXG4gICAgICAgICAgICAgICAgICAgIG5vdGUoJ21lcmdlZCcsIG5vZGUubmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgLy8gVGhlIGV4cGxpY2l0bHkgc2VsZWN0ZWQgb3V0cHV0IHN0YXlzIHdyaXRhYmxlIGV2ZW4gd2hlbiBpdFxyXG4gICAgICAgICAgICAgICAgLy8gaXMgYWxzbyBpbmRleGVkIGFzIGEgbG9jYWwgc291cmNlLiBTbGljZSB3cml0ZXMgdXNlIHRoaXMgVVJMLlxyXG4gICAgICAgICAgICAgICAgbm90ZSgnbWVyZ2VkJywgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICdGaWdtYSDkuIkv5Lmd5a6r5a6a5LmJ5LyY5YWI77ya5L2/55SoIEZpZ21hIOWOn+Wni+eUu+W4g+S4jui+uei3neeUn+aIkOi+k+WHuui1hOa6kO+8jOS4jeayv+eUqOWQjOWQjee0oOadkOeahOaXp+i+uei3nScsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcmV1c2VBc3NldCA9IChhc3NldDogU3ByaXRlQXNzZXRTcGVjLCBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnKSA9PiB7XG4gICAgICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgYXNzZXQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhYXNzZXQuc2xpY2VkKSB7XG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneW3suebtOaOpeW8leeUqOWQjOWQjei1hOa6kO+8jOS9huivpSBTcHJpdGVGcmFtZSDmnKrphY3nva7kuZ3lrqvovrnot53vvIzmmoLmjInmma7pgJogU3ByaXRlIOaYvuekuu+8m+ivt+WcqOWOn+i1hOa6kOS4reiuvue9rui+uei3ne+8miR7YXNzZXQudXJsfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgYXNzZXQsIHNvdXJjZSk7XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc3Qgc2hhcmVkID0gc2xpY2VBbmFseXNpcyA/IHVuZGVmaW5lZCA6IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkobm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoc2hhcmVkKSB7XHJcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gc2xpY2VBbmFseXNpcyB8fCBhbmFseXplTWFza1RpbnQobm9kZSkgPyBudWxsIDogYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UpO1xyXG4gICAgICAgICAgICAvLyBXaXRob3V0IGEgdmFsaWQgRmlnbWEgc2xpY2UsIHByZXNlcnZlIHRoZSBleGlzdGluZyBsb2NhbCBuYW1lXHJcbiAgICAgICAgICAgIC8vIG1hcHBpbmcsIFVVSUQgYW5kIHNsaWNlIGJvcmRlcnMgZXZlbiBkdXJpbmcgYW4gZXhwbGljaXQgcmVmcmVzaC5cclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBsb2NhbE1hdGNoXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcbiAgICAgICAgICAgICAgICA6IG51bGw7XG4gICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChsb2NhbEFzc2V0LCBsb2NhbE1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlubborr7nva7kuLogU3ByaXRlRnJhbWUg5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIXNsaWNlQW5hbHlzaXMgJiYgIWxvY2FsTWF0Y2ggJiYgIWFuYWx5emVNYXNrVGludChub2RlKSA/IGF3YWl0IGZpbmRPdXRwdXQobm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChuYW1lZE91dHB1dCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZWRBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5hbWVkQXNzZXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChuYW1lZEFzc2V0LCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIXNsaWNlQW5hbHlzaXMpIHtcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3ml6Dms5XorqHnrpfov57nu63liIfniYfovrnnlYzvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYm9yZGVycyA9IHNsaWNlQW5hbHlzaXM/LmJvcmRlcnM7XG4gICAgICAgICAgICAvLyBOZXcgc2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlXG4gICAgICAgICAgICAvLyB0aGVpciBnZW5lcmF0ZWQgYm9yZGVycyB1c2UgdGhhdCBjb29yZGluYXRlIHNwYWNlLlxuICAgICAgICAgICAgY29uc3QgcmVuZGVyRnJhbWUgPSBib3JkZXJzID8gdW5kZWZpbmVkIDogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGtleTogQ2FjaGVFbnRyeUtleSA9IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHZhcmlhbnQ6IHJlbmRlckZyYW1lID8gJ3Zpc3VhbC1vdmVyZmxvdy12MScgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGxldCBjYWNoZWQgPSBsb2NhbE1hdGNoIHx8IGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHNcclxuICAgICAgICAgICAgICAgID8gbnVsbFxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCBjYWNoZS5yZWFkKGtleSk7XHJcbiAgICAgICAgICAgIGlmIChzbGljZUFuYWx5c2lzICYmIGNhY2hlZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3ghO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaXNGdWxsQ2FudmFzID0gaXNQbmcoY2FjaGVkKSAmJiBjYWNoZWQubGVuZ3RoID49IDI0XHJcbiAgICAgICAgICAgICAgICAgICAgJiYgY2FjaGVkLnRvU3RyaW5nKCdhc2NpaScsIDEyLCAxNikgPT09ICdJSERSJ1xyXG4gICAgICAgICAgICAgICAgICAgICYmIE1hdGguYWJzKGNhY2hlZC5yZWFkVUludDMyQkUoMTYpIC0gZnJhbWUud2lkdGggKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSkgPD0gMVxyXG4gICAgICAgICAgICAgICAgICAgICYmIE1hdGguYWJzKGNhY2hlZC5yZWFkVUludDMyQkUoMjApIC0gZnJhbWUuaGVpZ2h0ICogaW1wb3J0U2V0dGluZ3Muc2NhbGUpIDw9IDE7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWlzRnVsbENhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNhY2hlZCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlLm5hbWUsICfnvJPlrZjkuI3mmK8gRmlnbWEg5a6M5pW055S75biD77yM6YeN5paw5a+85Ye65Y6f5aeLIFBORyDlkI7lho3lupTnlKjkuIkv5Lmd5a6r6L656LedJywgdXJsKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xuICAgICAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICAgICAgbm9kZXM6IGdyb3VwZWROb2RlcyxcbiAgICAgICAgICAgICAgICB1cmw6IGxvY2FsTWF0Y2ggJiYgZGV0ZWN0SW1hZ2VFeHRlbnNpb24obG9jYWxNYXRjaC5jb250ZW50cykgPT09ICdqcGcnXG4gICAgICAgICAgICAgICAgICAgID8gdXJsLnJlcGxhY2UoL1xcLnBuZyQvaSwgJy5qcGcnKSA6IHVybCxcbiAgICAgICAgICAgICAgICBib3JkZXJzLFxyXG4gICAgICAgICAgICAgICAgc2xpY2VBbmFseXNpczogc2xpY2VBbmFseXNpcyA/PyB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICByZW5kZXJGcmFtZTogbG9jYWxNYXRjaCA/IHVuZGVmaW5lZCA6IHJlbmRlckZyYW1lLFxyXG4gICAgICAgICAgICAgICAga2V5LFxyXG4gICAgICAgICAgICAgICAgY29udGVudHM6IGxvY2FsTWF0Y2g/LmNvbnRlbnRzID8/IGNhY2hlZCxcclxuICAgICAgICAgICAgICAgIHNvdXJjZTogbG9jYWxNYXRjaCA/ICdsb2NhbCcgOiBjYWNoZWQgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHVybHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+ID0ge307XHJcbiAgICAgICAgY29uc3QgcmVtb3RlSXRlbXMgPSBwZW5kaW5nLmZpbHRlcigoaXRlbSkgPT4gIWl0ZW0uY29udGVudHMpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdXNlQWJzb2x1dGVCb3VuZHMgb2YgW3RydWUsIGZhbHNlXSkge1xyXG4gICAgICAgICAgICBjb25zdCBiYXRjaCA9IHJlbW90ZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gKFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMgPyAhaXRlbS5yZW5kZXJGcmFtZSA6IEJvb2xlYW4oaXRlbS5yZW5kZXJGcmFtZSlcclxuICAgICAgICAgICAgKSk7XHJcbiAgICAgICAgICAgIGlmICghYmF0Y2gubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHVybHMsIGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgYmF0Y2gubWFwKChpdGVtKSA9PiBpdGVtLm5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyxcclxuICAgICAgICAgICAgICAgIE9iamVjdC5mcm9tRW50cmllcyhiYXRjaC5tYXAoKGl0ZW0pID0+IFtpdGVtLm5vZGUuaWQsIGl0ZW0ubm9kZS5uYW1lXSkpLFxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSB1cmxzW2l0ZW0ubm9kZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95riy5p+T6IqC54K577yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5kb3dubG9hZChyZW1vdGVVcmwsIGAke2l0ZW0ubm9kZS5uYW1lfSAoJHtpdGVtLm5vZGUuaWR9KWApO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoaXRlbS5rZXksIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBsZXQgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYztcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc2xpY2VBbmFseXNpcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+S4iS/kuZ3lrqvotYTmupDmnIDlsI/ljJYnLCB7IG5vZGU6IGl0ZW0ubm9kZS5uYW1lIH0pO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgd3JpdGVTbGljZWRQbmcod3JpdGVyLCBpdGVtLnVybCwgY29udGVudHMsIGl0ZW0ubm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNsaWNlQW5hbHlzaXMsIGltcG9ydFNldHRpbmdzLnNjYWxlKTtcclxuICAgICAgICAgICAgICAgIGFzc2V0ID0gcmVzdWx0LmFzc2V0O1xyXG4gICAgICAgICAgICAgICAgdHJhY2UuZG9uZShyZXN1bHQub3B0aW1pemF0aW9uKTtcclxuICAgICAgICAgICAgICAgIG5vdGUoYXNzZXQuc2xpY2VGYWxsYmFjayA/ICdmYWxsYmFjaycgOiAnbWVyZ2VkJywgaXRlbS5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgYOS4iS/kuZ3lrqvvvJoke3Jlc3VsdC5vcHRpbWl6YXRpb24ucmVhc29uID8/IHJlc3VsdC5vcHRpbWl6YXRpb24uc3RhdHVzfWAsIGFzc2V0LnVybCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShpdGVtLm5vZGUpLCBhc3NldCk7XHJcbiAgICAgICAgICAgIGlmIChhc3NldC5zbGljZUZhbGxiYWNrKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke2l0ZW0ubm9kZS5uYW1lfeKAneWIh+eJh+iuvue9ruWksei0pe+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWl77yaJHthc3NldC5zbGljZUZhbGxiYWNrfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgaXRlbS5ub2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChcclxuICAgICAgICAgICAgICAgICAgICBncm91cGVkTm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnJlbmRlckZyYW1lXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8geyAuLi5hc3NldCwgcmVuZGVyRnJhbWU6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUoZ3JvdXBlZE5vZGUpID8/IGl0ZW0ucmVuZGVyRnJhbWUgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGFzc2V0LFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1Jhd0ltYWdlcyA9IGFzeW5jIChpdGVtczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgbm9kZTogRmlnbWFOb2RlOyBub2RlczogRmlnbWFOb2RlW107IGltYWdlUmVmOiBzdHJpbmcgfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzb3VyY2VLZXkoaXRlbS5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlOiBpdGVtLm5vZGUsIG5vZGVzOiBbXSwgaW1hZ2VSZWY6IGl0ZW0uaW1hZ2VSZWYgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGltYWdlRmlsbFVybHNQcm9taXNlOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+PiB8IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlSW1hZ2VzID0gKG5vZGVzOiBGaWdtYU5vZGVbXSwgYmFzZTogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnIHwgJ2NhY2hlJyB8ICdmaWdtYScpID0+IHtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2Rlc1swXSksIGJhc2UpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgaW5uZXJPcGFjaXR5IH0gPSBpbWFnZURldGFpbHMobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGlubmVyT3BhY2l0eSA8IDEgPyB7IC4uLmJhc2UsIHRpbnQ6IHsgcjogMSwgZzogMSwgYjogMSwgYTogaW5uZXJPcGFjaXR5IH0gfSA6IGJhc2U7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBjb25zdCBzaGFyZWQgPSBzaGFyZWRBc3NldHMuZ2V0KHJlc291cmNlS2V5KGdyb3VwLm5vZGUpKTtcclxuICAgICAgICAgICAgaWYgKHNoYXJlZCkge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB7IGxlYWYgfSA9IGltYWdlRGV0YWlscyhncm91cC5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwoZ3JvdXAubm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGxvY2FsVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmICghbG9jYWxBc3NldCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3mnKzlnLDotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGxvY2FsQXNzZXQsIG1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbWF0Y2ggPyBhd2FpdCBmaW5kT3V0cHV0KGdyb3VwLm5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IG5hbWVkT3V0cHV0ID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChuYW1lZE91dHB1dCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBsZXQgc291cmNlOiAnY2FjaGUnIHwgJ2ZpZ21hJyA9ICdjYWNoZSc7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogY2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGNhbmRpZGF0ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGlmICghaW1hZ2VGaWxsVXJsc1Byb21pc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICBpbWFnZUZpbGxVcmxzUHJvbWlzZSA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gYXdhaXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpbWFnZUZpbGxVcmxzW2dyb3VwLmltYWdlUmVmXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5DkvpvpmpDol4/lm77niYfloavlhYXvvJoke2dyb3VwLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldChyZW1vdGVVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7Z3JvdXAubm9kZS5uYW1lfSAoJHtncm91cC5ub2RlLmlkfSlgKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldChyZW1vdGVVcmwsIHRhc2spO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCB0YXNrO1xyXG4gICAgICAgICAgICAgICAgc291cmNlID0gJ2ZpZ21hJztcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBleHRlbnNpb24gPz89IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgY29uc3QgZmlsbCA9IGxlYWYuZmlsbHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIHBhaW50LnR5cGUgPT09ICdJTUFHRScpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShncm91cC5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgcmFzdGVyID0gcmFzdGVyaXplSW1hZ2VGaWxsKGNvbnRlbnRzLCBmaWxsPy5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPT09ICdGSVQnID8gJ0ZJVCcgOiAnRklMTCcsXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCwgZnJhbWUuaGVpZ2h0LCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIGdyb3VwLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06aW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcmFzdGVyKTtcclxuICAgICAgICAgICAgbm90ZVdyaXRlKHJlc29sdmVkKTtcclxuICAgICAgICAgICAgaWYgKGdyb3VwLm5vZGUuY2hpbGRyZW4ubGVuZ3RoKSBub3RlKCdtZXJnZWQnLCBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAn5pmu6YCaIElNQUdFIOWcqOmakOiXj+WSjOaYvuekuueKtuaAgeS9v+eUqOebuOWQjOS4reW/g+ijgeWIhy/pgILphY3vvJvmupDlm77nvJPlrZjkv53nlZnljp/lp4vlg4/ntKDvvIzoioLngrnpgI/mmI7luqbljZXni6zlupTnlKgnLCByZXNvbHZlZC51cmwpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgcmVzb2x2ZWQsIHNvdXJjZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5bmz6ZO66LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMudGlsZWQubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NUaWxlZChyZXF1ZXN0cy50aWxlZCkpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkhyBQTkcg6LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMucG5nLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzUmVtb3RlKHJlcXVlc3RzLnBuZykpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WOn+WniyBJTUFHRSDloavlhYXotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XHJcblxyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IHNoYXJlZCA9IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkobm9kZSkpO1xyXG4gICAgICAgIGlmIChzaGFyZWQpIHtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBzaGFyZWQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmFtZWQgPSBhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgY29uc3QgbmFtZWRVcmwgPSBuYW1lZCA/IGFzc2V0RGF0YWJhc2VVcmwobmFtZWQucGF0aCkgOiBudWxsO1xyXG4gICAgICAgIGlmIChuYW1lZFVybCkge1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhuYW1lZFVybCk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZFVybH1gKTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgZXhpc3RpbmcpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGV4aXN0aW5nLCBuYW1lZCEuc291cmNlKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIW5hbWVkID8gYXdhaXQgZmluZE91dHB1dChub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgZXhpc3RpbmcpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXHJcbiAgICAgICAgICAgID8gZ3JhZGllbnRQbmcoXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGZpbGwsXHJcbiAgICAgICAgICAgICAgICBjb3JuZXJSYWRpaShub2RlKSxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAocG5nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIHBuZyk7XHJcbiAgICAgICAgICAgIG5vdGVXcml0ZShhc3NldCk7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGFzc2V0KTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgJ2dlbmVyYXRlZCcpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDnlJ/miJDmuJDlj5ggJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIHdyaXRlci5ldmVudHMpIG5vdGUoZXZlbnQuYWN0aW9uLCBiYXNlbmFtZShldmVudC51cmwpLCBldmVudC5yZWFzb24sIGV2ZW50LnVybCk7XHJcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmYW1pbHksIHVybF0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgcmVzb2x2ZUFzc2V0VXVpZCh1cmwpO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQoZmFtaWx5LCB1dWlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlcnJlZExheW91dE1vZGUobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IG5hdGl2ZU1vZGUgPSBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKTtcclxuICAgIGlmIChuYXRpdmVNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIG5hdGl2ZU1vZGU7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIFJlY3QgPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcclxuICAgIGNvbnN0IGNlbnRlcnNZID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQgLyAyKTtcclxuICAgIGNvbnN0IHNwcmVhZFggPSBNYXRoLm1heCguLi5jZW50ZXJzWCkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWCk7XHJcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xyXG4gICAgaWYgKHNwcmVhZFkgPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnSE9SSVpPTlRBTCc7XHJcbiAgICB9XHJcbiAgICBpZiAoc3ByZWFkWCA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ0dSSUQnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFrZVNwZWMoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcGxhbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+LFxyXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPixcclxuICAgIGZvbnRzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbiAgICBwYXJlbnRXb3JsZFJvdGF0aW9uID0gMCxcclxuKTogU2NlbmVOb2RlU3BlYyB8IG51bGwge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShub2RlKTtcclxuICAgIGNvbnN0IHBsYW4gPSBwbGFucy5nZXQobm9kZS5pZCk7XHJcbiAgICBjb25zdCBmb2xkID0gcGxhbj8uZm9sZDtcclxuICAgIGNvbnN0IGZvbGRTb3VyY2UgPSBmb2xkID8gbm9kZUJ5SWQuZ2V0KGZvbGQuc291cmNlTm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IHRleHRTb3VyY2UgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHZpc3VhbFNvdXJjZSA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHJlc29sdmVkS2luZCA9IGRlY2lzaW9uLmtpbmQgPT09ICdhdXRvJyA/IGluZmVyS2luZChub2RlKSA6IGRlY2lzaW9uLmtpbmQ7XHJcbiAgICBjb25zdCBwbGFubmVkS2luZCA9IHBsYW4/LmtpbmQgPz8gcmVzb2x2ZWRLaW5kO1xyXG4gICAgY29uc3QgYml0bWFwVGVybWluYWwgPSBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJztcclxuICAgIGNvbnN0IHRlcm1pbmFsID0gYml0bWFwVGVybWluYWwgfHwgaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24ocGxhbm5lZEtpbmQsIGRlY2lzaW9uLmFjdGlvbiwgZGVjaXNpb24ubmluZVNsaWNlKTtcclxuICAgIGNvbnN0IHNwcml0ZVNvdXJjZUlkID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCdcclxuICAgICAgICA/IGZvbGQuc291cmNlTm9kZUlkXHJcbiAgICAgICAgOiBub2RlLmlkO1xyXG4gICAgY29uc3Qgc3ByaXRlQXNzZXQgPSBhc3NldHMuZ2V0KHNwcml0ZVNvdXJjZUlkKTtcclxuICAgIGNvbnN0IGFic29yYmVkRGlyZWN0SWRzID0gbmV3IFNldChmb2xkID8gW2ZvbGQuc291cmNlTm9kZUlkXSA6IFtdKTtcclxuICAgIGNvbnN0IGZ1bGxGb2xkID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS1pbWFnZScgfHwgZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JztcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBwYXJlbnRXb3JsZFJvdGF0aW9uICsgbm9kZS5yb3RhdGlvbjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZmlnbWFJZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBkZWNpc2lvbi5uYW1lID8/IG5vZGUubmFtZSxcclxuICAgICAgICBmaWdtYVR5cGU6IHZpc3VhbFNvdXJjZS50eXBlLFxyXG4gICAgICAgIGFjdGlvbjogZGVjaXNpb24uYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgcGFyZW50RnJhbWUsXHJcbiAgICAgICAgaW50cmluc2ljU2l6ZTogbm9kZS5zaXplLFxyXG4gICAgICAgIGlzUm9vdCxcclxuICAgICAgICByb3RhdGlvbjogbm9kZS5yb3RhdGlvbixcclxuICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgIG9wYWNpdHk6IGZvbGRTb3VyY2UgJiYgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyBub2RlLm9wYWNpdHkgKiBmb2xkU291cmNlLm9wYWNpdHlcclxuICAgICAgICAgICAgOiBub2RlLm9wYWNpdHksXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQsXHJcbiAgICAgICAgY29ybmVyUmFkaWk6IGNvcm5lclJhZGlpKHZpc3VhbFNvdXJjZSksXHJcbiAgICAgICAgZmlsbHM6IHRleHRTb3VyY2UuZmlsbHMsXHJcbiAgICAgICAgc3Ryb2tlczogdGV4dFNvdXJjZS5zdHJva2VzLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogdGV4dFNvdXJjZS5zdHJva2VXZWlnaHQsXHJcbiAgICAgICAgY2hhcmFjdGVyczogdGV4dFNvdXJjZS5jaGFyYWN0ZXJzLFxyXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFNvdXJjZS5zdHlsZSxcclxuICAgICAgICBsYXlvdXQ6IHtcclxuICAgICAgICAgICAgbW9kZTogZWZmZWN0aXZlS2luZCA9PT0gJ2xheW91dCcgfHwgZWZmZWN0aXZlS2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgICAgICA/IGluZmVycmVkTGF5b3V0TW9kZShub2RlKVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIHNvdXJjZU1vZGU6IG5vZGUubGF5b3V0TW9kZSxcclxuICAgICAgICAgICAgd3JhcDogbm9kZS5sYXlvdXRXcmFwLFxyXG4gICAgICAgICAgICBwcmltYXJ5QWxpZ246IG5vZGUucHJpbWFyeUF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBjb3VudGVyQWxpZ246IG5vZGUuY291bnRlckF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBwcmltYXJ5U2l6aW5nOiBub2RlLnByaW1hcnlBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgY291bnRlclNpemluZzogbm9kZS5jb3VudGVyQXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGl0ZW1TcGFjaW5nOiBub2RlLml0ZW1TcGFjaW5nLFxyXG4gICAgICAgICAgICBjb3VudGVyU3BhY2luZzogbm9kZS5jb3VudGVyQXhpc1NwYWNpbmcsXHJcbiAgICAgICAgICAgIHBhZGRpbmdMZWZ0OiBub2RlLnBhZGRpbmdMZWZ0LFxyXG4gICAgICAgICAgICBwYWRkaW5nUmlnaHQ6IG5vZGUucGFkZGluZ1JpZ2h0LFxyXG4gICAgICAgICAgICBwYWRkaW5nVG9wOiBub2RlLnBhZGRpbmdUb3AsXHJcbiAgICAgICAgICAgIHBhZGRpbmdCb3R0b206IG5vZGUucGFkZGluZ0JvdHRvbSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIG92ZXJmbG93RGlyZWN0aW9uOiBub2RlLm92ZXJmbG93RGlyZWN0aW9uLFxyXG4gICAgICAgIGNvbnN0cmFpbnRzOiBub2RlLmNvbnN0cmFpbnRzLFxyXG4gICAgICAgIHJlbGF0aXZlVHJhbnNmb3JtOiBub2RlLnJlbGF0aXZlVHJhbnNmb3JtLFxyXG4gICAgICAgIHNwcml0ZTogc3ByaXRlQXNzZXQsXHJcbiAgICAgICAgZm9udFV1aWQ6IHRleHRTb3VyY2Uuc3R5bGU/LmZvbnRGYW1pbHkgPyBmb250cy5nZXQodGV4dFNvdXJjZS5zdHlsZS5mb250RmFtaWx5KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMsXHJcbiAgICAgICAgZmxhdHRlbkJvdW5kYXJ5OiBiaXRtYXBUZXJtaW5hbCB8fCBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IHRydWVcclxuICAgICAgICAgICAgOiBmb2xkPy5raW5kID09PSAnYmFja2dyb3VuZCdcclxuICAgICAgICAgICAgICAgID8gZmFsc2VcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHBsYW5SZWFzb246IHBsYW4/LnJlYXNvbixcclxuICAgICAgICBjaGlsZHJlbjogdGVybWluYWxcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKSA9PiAhYWJzb3JiZWREaXJlY3RJZHMuaGFzKGNoaWxkLmlkKSlcclxuICAgICAgICAgICAgICAgIC5tYXAoKGNoaWxkKSA9PiBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZCxcclxuICAgICAgICAgICAgICAgICAgICBmcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgICAgICAgICApKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpOiBjaGlsZCBpcyBTY2VuZU5vZGVTcGVjID0+IGNoaWxkICE9PSBudWxsKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVNYXBzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2Nvc0ZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gRWRpdG9yLlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXHJcbiAgICAgICAgPyBnZW5lcmF0ZWRcclxuICAgICAgICA6IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnYmFzZTY0JykucmVwbGFjZSgvPSskL2csICcnKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJBc3NldCh1cmxPclV1aWQ6IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtaW5mbycsXHJcbiAgICAgICAgdXJsT3JVdWlkLFxyXG4gICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRQcmVmYWJBc3NldChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGluZm8uaW52YWxpZCB8fCBpbmZvLmltcG9ydGVkICE9PSB0cnVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLmltcG9ydGVyICE9PSAncHJlZmFiJyB8fCBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInIHx8IGluZm8uaXNEaXJlY3RvcnkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8ucmVhZG9ubHkgfHwgaW5mby5yZWRpcmVjdCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZC51dWlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnVybCAmJiBpbmZvLnVybCAhPT0gZXhwZWN0ZWQudXJsKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yUHJlZmFiQXNzZXQodXJsOiBzdHJpbmcsIGV4cGVjdGVkVXVpZD86IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbmZvPy5pbXBvcnRlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOWcqOWvvOWFpeacn+mXtOWPkeeUn+WPmOWMlu+8miR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIFByZWZhYiDotYTmupDlsLHnu6rotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJNZXRhKHV1aWQ6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgIHV1aWQsXHJcbiAgICApO1xyXG4gICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSBtZXRhIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBNZXRhIOS4juebruagh+i1hOa6kOS4jeWMuemFje+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVSTCDml6DmlYjvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICApO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmcsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgY3VycmVudERpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgaWYgKGN1cnJlbnREaXJ0eSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcclxuICAgIH1cclxuICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnb3Blbi1hc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgICAgICAgICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gc3RhdGUucmVhc29uID8/IGxhc3RSZWFzb247XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOaJk+W8gOebruaghyBQcmVmYWIg6LaF5pe277yaJHtsYXN0UmVhc29ufWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRPcGVuZWRQcmVmYWIocHJlZmFiVXVpZDogc3RyaW5nLCByb290RmlsZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTY2VuZVNhdmVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBkaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoIWRpcnR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCfnrYnlvoUgUHJlZmFiIOS/neWtmOWujOaIkOi2heaXtuOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQcmVmYWJCaW5kaW5ncygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCBwcmVmYWJVdWlkXSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHByZWZhYlV1aWQgIT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8ICFwcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcsIHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgaWYgKCFiaW5kaW5nc1tzb3VyY2VIYXNoXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywge1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8ICFyYXdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIChyYXcgYXMgeyBwcmVmYWJVdWlkPzogdW5rbm93biB9KS5wcmVmYWJVdWlkICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoe1xyXG4gICAgICAgICAgICB1c2VyRGF0YToge1xyXG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leadpea6kOS4jeS4gOiHtO+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IChyYXcgYXMgeyBwcmVmYWJVdWlkOiBzdHJpbmcgfSkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQZW5kaW5nUHJlZmFiU3luYyhcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHZhbHVlOiB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0gfCBudWxsLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcclxuICAgIGlmICh2YWx1ZSkge1xyXG4gICAgICAgIHBlbmRpbmdbc291cmNlSGFzaF0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbc291cmNlSGFzaF07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgIHBlbmRpbmcsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gdmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbik6IFByb21pc2U8eyBtZXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+IHtcclxuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICBsZXQgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICBpZiAoIXJlY29yZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYFByZWZhYiDnvLrlsJEgRmlnbWEg5p2l5rqQ6K6w5b2V77yM5peg5rOV56Gu6K6k5piv5ZCm5Y+v5a6J5YWo6KaG55uW77yaJHtpbmZvLnVybH3jgILor7flhYjnp7vliqjmiJbph43lkb3lkI3or6XotYTmupDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDmnaXoh6rlj6bkuIDkuKogRmlnbWEgRnJhbWXvvIzlt7Lmi5Lnu53opobnm5bvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBpZiAocGVuZGluZykge1xyXG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5qOA5rWL5Yiw5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7TnmoTlvoXmgaLlpI3lkIzmraXorrDlvZXvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcGVuZGluZy5yZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3ZlcmVkIHx8IEpTT04uc3RyaW5naWZ5KHJlY292ZXJlZCkgIT09IEpTT04uc3RyaW5naWZ5KHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVjb3JkID0gcmVjb3ZlcmVkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bkuI7lvZPliY3lj4rlvoXmgaLlpI3nmoTlkIzmraXorrDlvZXpg73kuI3kuIDoh7TvvIzlt7LlgZzmraLoh6rliqjmgaLlpI3jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBtZXRhLCByZWNvcmQgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBsZXQgbGFzdEVycm9yOiB1bmtub3duO1xyXG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0ICs9IDEpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflhpnlhaXliY0gUHJlZmFiIOadpea6kOiusOW9leS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWQjuagoemqjOS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcclxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTUwKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGxhc3RFcnJvciA6IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWksei0peOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZyxcclxuICAgIHJvb3RGcmFtZTogUmVjdCxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHNvdXJjZVJvb3RJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHtcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgY29uc3QgYm91bmRVdWlkID0gYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xyXG4gICAgICAgID8gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwZW5kaW5nLnByZWZhYlV1aWQpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgICAgICBwZW5kaW5nPy5wcmVmYWJVdWlkLFxyXG4gICAgICAgIGJvdW5kVXVpZCxcclxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcclxuICAgICk7XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhclBlbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyQmluZGluZykge1xyXG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gdGFyZ2V0UGxhbi50YXJnZXRVdWlkO1xyXG4gICAgaWYgKHRhcmdldFV1aWQpIHtcclxuICAgICAgICBsZXQgdGFyZ2V0SW5mbyA9IHBlbmRpbmdJbmZvPy51dWlkID09PSB0YXJnZXRVdWlkXHJcbiAgICAgICAgICAgID8gcGVuZGluZ0luZm9cclxuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xyXG4gICAgICAgICAgICBpZiAoYmluZGluZ3Nbc291cmNlSGFzaF0gPT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgaWYgKHBlbmRpbmc/LnByZWZhYlV1aWQgPT09IHRhcmdldFV1aWQgJiYgYm91bmRVdWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSByZWNvdmVyeSBpZGVudGl0eSBiZWZvcmUgdmVyaWZpZWRQcmVmYWJSZWNvcmQgbWF5XHJcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcclxuICAgICAgICAgICAgICAgIC8vIGFibGUgdG8gbG9jYXRlIHRoZSBleGFjdCBQcmVmYWIgYnkgVVVJRCBvbiB0aGUgbmV4dCBhdHRlbXB0LlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKHRhcmdldEluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0SW5mby51cmwgIT09IHByZWZhYlVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoY29uZmxpY3QgJiYgY29uZmxpY3QudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3ZlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mby51cmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW92ZWQgfHwgbW92ZWQudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGluZm86IHRhcmdldEluZm8sXHJcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCByb290RmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCByb290VHJhbnNmb3JtRmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXHJcbiAgICAgICAgICAgIHByZWZhYk5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnY3JlYXRlLWFzc2V0JyxcclxuICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICBzZWVkLFxyXG4gICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu6IFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgY3JlYXRlZC51dWlkKTtcclxuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcclxuICAgICAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICAgICAgc291cmNlUm9vdElkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShuZXh0TWV0YSwgbnVsbCwgMiksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgaW5mbyxcclxuICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaW5mbyxcclxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKGFyZ3M6IHtcclxuICAgIHJldmlld0lkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZztcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHNvdXJjZU5vZGVJZDogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn0pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBzb3VyY2VIYXNoID0gZmlnbWFGcmFtZVNvdXJjZUhhc2goYXJncy5maWxlS2V5LCBhcmdzLnNvdXJjZU5vZGVJZCk7XHJcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgICAgICBhcmdzLnByZWZhYlVybCxcclxuICAgICAgICBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICB4OiBhcmdzLnJvb3RGcmFtZS54ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgeTogYXJncy5yb290RnJhbWUueSAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHdpZHRoOiBhcmdzLnJvb3RGcmFtZS53aWR0aCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIGhlaWdodDogYXJncy5yb290RnJhbWUuaGVpZ2h0ICogYXJncy5zY2FsZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgYXJncy5yb290c1swXS5maWdtYUlkLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGV4aXN0aW5nTm9kZUZpbGVJZHMgPSByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyhcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQsXHJcbiAgICAgICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKGFyZ3Mucm9vdHMpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICByZXZpZXdJZDogYXJncy5yZXZpZXdJZCxcclxuICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBmaWxlS2V5OiBhcmdzLmZpbGVLZXksXHJcbiAgICAgICAgcm9vdE5hbWU6IGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICByb290RnJhbWU6IGFyZ3Mucm9vdEZyYW1lLFxyXG4gICAgICAgIHNjYWxlOiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIGV4aXN0aW5nTWFwOiB7fSxcclxuICAgICAgICBwcmVmYWJVcmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHJvb3RzOiBhcmdzLnJvb3RzLFxyXG4gICAgICAgIHByZWZhYkNvbnRleHQ6IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkOiBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgZXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZE5vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRIZWxwZXJGaWxlSWRzLFxyXG4gICAgICAgIH0sXHJcbiAgICB9O1xyXG4gICAgbGV0IHNuYXBzaG90U3RhcnRlZCA9IGZhbHNlO1xyXG4gICAgbGV0IHNhdmVBdHRlbXB0ZWQgPSBmYWxzZTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgZGlydHlCZWZvcmVJbXBvcnQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICAgICAgaWYgKGRpcnR5QmVmb3JlSW1wb3J0KSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign55uu5qCHIFByZWZhYiDmnInmnKrkv53lrZjnmoTmiYvlt6Xkv67mlLnvvIzor7flhYjkv53lrZjlkI7lho3miafooYwgRmlnbWEg5aKe6YeP5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgc25hcHNob3RTdGFydGVkID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgaWYgKCFyZXN1bHQucHJlZmFiU3luYykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXmnKrov5Tlm54gZmlsZUlkIOiusOW9le+8jOW3suWBnOatouS/neWtmOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuZXh0UmVjb3JkID0gcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUocHJlcGFyZWQucmVjb3JkLCByZXN1bHQucHJlZmFiU3luYyk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZDogbmV4dFJlY29yZCxcclxuICAgICAgICB9KTtcclxuICAgICAgICBhd2FpdCBhc3NlcnRPcGVuZWRQcmVmYWIocHJlcGFyZWQuaW5mby51dWlkLCBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgLy8gT25jZSB0aGUgc2F2ZSByZXF1ZXN0IGlzIHNlbnQgaXRzIHJlc3VsdCBpcyBhbWJpZ3VvdXMgdW50aWwgdGhlXHJcbiAgICAgICAgLy8gcGVyc2lzdGVkIFByZWZhYiBpcyB2ZXJpZmllZC4gRG8gbm90IHJvbGwgdGhlIGluLW1lbW9yeSBQcmVmYWIgYmFja1xyXG4gICAgICAgIC8vIG9uIGFuIElQQyB0aW1lb3V0OiB0aGUgZGlzayB3cml0ZSBtYXkgYWxyZWFkeSBoYXZlIGNvbXBsZXRlZC5cclxuICAgICAgICBzYXZlQXR0ZW1wdGVkID0gdHJ1ZTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclNjZW5lU2F2ZWQoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCwgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoY3VycmVudEluZm8sIG5leHRSZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuacquWMheWQq+acrOasoeWQjOatpeeUn+aIkOeahOWFqOmDqCBmaWxlSWTvvIzlt7LlgZzmraLmm7TmlrAgTWV0YeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXJyZW50TWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShjdXJyZW50SW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50UmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoY3VycmVudE1ldGEpO1xyXG4gICAgICAgIGlmICghY3VycmVudFJlY29yZCB8fCBjdXJyZW50UmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5Zyo5L+d5a2Y5pyf6Ze05Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5o+Q5Lqk44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoY3VycmVudEluZm8sIHNvdXJjZUhhc2gsIG5leHRSZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCk7XHJcbiAgICAgICAgaWYgKCF2ZXJpZmllZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjiBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQodmVyaWZpZWQsIHtcclxuICAgICAgICAgICAgdXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICB1cmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlc3VsdC5wcmVmYWJVcmwgPSBwcmVwYXJlZC5pbmZvLnVybDtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLmNsZWFyKCdub2RlJyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBpZiAoc25hcHNob3RTdGFydGVkICYmICFzYXZlQXR0ZW1wdGVkKSB7XHJcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90LWFib3J0Jyk7IH1cclxuICAgICAgICAgICAgY2F0Y2gge1xyXG4gICAgICAgICAgICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIChlcnJvciBhcyBFcnJvciAmIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pLnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc2F2ZUF0dGVtcHRlZCAmJiBlcnJvciBpbnN0YW5jZW9mIEVycm9yKSAoZXJyb3IgYXMgRXJyb3IgJiB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KS5yZXF1aXJlc0F0dGVudGlvbiA9IHRydWU7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1JbXBvcnQocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsLCBvcHRpb25zOiB7XHJcbiAgICBkb2N1bWVudD86IERvY3VtZW50U2Vzc2lvbjsgcHJlc2VydmVSZXZpZXdzPzogYm9vbGVhbjsgc2lsZW50UmV2aWV3PzogYm9vbGVhbjtcclxufSA9IHt9KTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBvcHRpb25zLmRvY3VtZW50ID8/IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgaWYgKCFkb2N1bWVudCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1wb3J0U2V0dGluZ3MgPSBzYWZlU2V0dGluZ3MocmVxdWVzdC5zZXR0aW5ncyk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24ob3BlcmF0aW9uT3duZXIpO1xyXG4gICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+WvvOWFpeS7u+WKoScsIHsgcm9vdHM6IGRvY3VtZW50LnJvb3RzLm1hcCgobm9kZSkgPT4gKHsgaWQ6IG5vZGUuaWQsIG5hbWU6IG5vZGUubmFtZSB9KSkgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+WIhuaekOW5tuWHhuWkh+i1hOa6kOKApicgfSk7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAocmVxdWVzdC5vdmVycmlkZXMsIGRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGNvbnN0IHJldmlld0RvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKG9wdGlvbnMucHJlc2VydmVSZXZpZXdzID8geyBwcmVzZXJ2ZUhpc3Rvcnk6IHRydWUgfSA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3UmVjb3JkZXIgPSBuZXcgSW1wb3J0UmV2aWV3UmVjb3JkZXIoKTtcclxuICAgICAgICBjb25zdCBidWlsdEFzc2V0cyA9IGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflhajpg6jotYTmupAnLCB1bmRlZmluZWQsICgpID0+IGJ1aWxkQXNzZXRzKGRvY3VtZW50LCBkZWNpc2lvbnMsIGltcG9ydFNldHRpbmdzLCByZXZpZXdSZWNvcmRlcikpO1xyXG4gICAgICAgIGNvbnN0IHsgYXNzZXRzLCB3YXJuaW5ncyB9ID0gYnVpbHRBc3NldHM7XHJcbiAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIGNvbnN0IGF0dGFjaFJldmlldyA9IGFzeW5jIChyZXN1bHQ6IFNjZW5lSW1wb3J0UmVzdWx0KSA9PiB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5yZXZpZXcgPSBhd2FpdCBmaW5hbGl6ZUltcG9ydFJldmlldyhpbXBvcnRSZXZpZXdzLCByZXZpZXdSZWNvcmRlciwgcmV2aWV3RG9jdW1lbnQsXHJcbiAgICAgICAgICAgICAgICByZXN1bHQucmV2aWV3QmVmb3JlLCByZXN1bHQucmV2aWV3QWZ0ZXIsIHJlc3VsdC5wcmVmYWJVcmwsIHdhcm5pbmdzLFxyXG4gICAgICAgICAgICAgICAgYXN5bmMgKCkgPT4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSwgbWV0aG9kOiAncmVmcmVzaFJldmlld0FmdGVyJywgYXJnczogW3sgaWQ6IHJldmlld1JlY29yZGVyLmlkIH1dLFxyXG4gICAgICAgICAgICAgICAgfSkgYXMgUmV2aWV3U2NlbmUpO1xyXG4gICAgICAgICAgICAvLyBBbHNvIGNvdmVyIG1hbnVhbCBpbXBvcnRzIHdob3NlIHBhbmVsIHdhcyBjbG9zZWQgd2hpbGUgaW1wb3J0aW5nLlxyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMuc2lsZW50UmV2aWV3KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XHJcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdBZnRlcjtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgICAgICAgICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ2ltcG9ydC1yZXZpZXctcmVhZHknLCByZXN1bHQucmV2aWV3KTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOe7k+aenOW3suS/neWtmO+8jOS9huiHquWKqOaJk+W8gOmdouadv+Wksei0pe+8jOivt+S7juaPkuS7tuS4reaJk+W8gOKAnOWvvOWFpee7k+aenOajgOafpeKAne+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QmVmb3JlO1xyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgLy8gYnVpbGRBc3NldHMgbWF5IHByb21vdGUgYSBjb250YWluZXIgdG8gYSBsb2NhbCBzYW1lLW5hbWUgcmVzb3VyY2UuXHJcbiAgICAgICAgLy8gQ29tcGlsZSBhZnRlciB0aGF0IHByb21vdGlvbiBzbyBhc3NldHMgYW5kIFNjZW5lTm9kZVNwZWMgc2hhcmUgdGhlXHJcbiAgICAgICAgLy8gZXhhY3Qgc2FtZSBmaW5hbCBwbGFuLlxyXG4gICAgICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgY29uc3QgZm9udHMgPSBhd2FpdCByZXNvbHZlRm9udHMoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZVJvb3RGcmFtZXMgPSBkb2N1bWVudC5yb290cy5tYXAobm9kZUZyYW1lKTtcclxuICAgICAgICBjb25zdCBtdWx0aXBsZVJvb3RzID0gZG9jdW1lbnQucm9vdHMubGVuZ3RoID4gMTtcclxuICAgICAgICBjb25zdCBhcnJhbmdlZFdpZHRoID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHNvdXJjZVJvb3RGcmFtZXMucmVkdWNlKCh0b3RhbCwgZnJhbWUpID0+IHRvdGFsICsgZnJhbWUud2lkdGgsIDApXHJcbiAgICAgICAgICAgICAgICArIE1hdGgubWF4KDAsIHNvdXJjZVJvb3RGcmFtZXMubGVuZ3RoIC0gMSkgKiAxNjBcclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdPy53aWR0aCA/PyAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RGcmFtZSA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICB4OiAwLFxyXG4gICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiBhcnJhbmdlZFdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCgwLCAuLi5zb3VyY2VSb290RnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLmhlaWdodCkpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXSA/PyB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgICAgICBsZXQgcm9vdEN1cnNvciA9IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBkb2N1bWVudC5yb290c1xyXG4gICAgICAgICAgICAubWFwKChub2RlLCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc3BlYyA9IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5ub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5mcmFtZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogcm9vdEN1cnNvcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDdXJzb3IgKz0gc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGggKyAxNjA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigobm9kZSk6IG5vZGUgaXMgU2NlbmVOb2RlU3BlYyA9PiBub2RlICE9PSBudWxsKTtcclxuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeaciemAieS4reS7u+S9leWPr+WvvOWFpeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgc291cmNlTm9kZUlkID0gZG9jdW1lbnQuc291cmNlTm9kZUlkO1xyXG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVmYWJXcml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5yb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMC4wNSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKHtcclxuICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgIHByZWZhYk5hbWU6IGZyYW1lTmFtZSxcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VOb2RlSWQsXHJcbiAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICAgICAgLy8gUHJlZmFiIHVwZGF0ZXMgcGVyc2lzdCBieSBQcmVmYWJJbmZvLmZpbGVJZCBpbiB0aGUgYXNzZXQgbWV0YTtcclxuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR977yM5bey5omT5byA6aKE5Yi25L2TICR7cHJlZmFiVXJsfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICByb290TmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB1cGRhdGVFeGlzdGluZzogaW1wb3J0U2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTWFwOiBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA/PyB7fSxcclxuICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgfTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDAuMSwgbWVzc2FnZTogJ+ato+WcqOaehOW7uiBDb2NvcyDoioLngrnmoJHigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID0gcmVzdWx0Lm5vZGVNYXA7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnbm9kZScsIHJlc3VsdC5yb290VXVpZCk7XHJcbiAgICAgICAgaWYgKGltcG9ydFNldHRpbmdzLmF1dG9TYXZlKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdHJhY2UuZG9uZSgpO1xyXG4gICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgQ2FuY2VsbGVkRXJyb3IgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5Y+W5raI44CCJyB9KTtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmk43kvZzlt7Llj5bmtojjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflr7zlhaXlpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgdHJhY2UuZXZlbnQoJ+WQjuWPsOS7u+WKoeW3sumHiuaUvicpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRNY3BQbHVnaW5TdGF0ZSgpIHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgdmF1bHQ6IHZhdWx0LnN0YXR1cygpLFxyXG4gICAgICAgIHNldHRpbmdzOiBhd2FpdCBnZXRTZXR0aW5ncygpLFxyXG4gICAgICAgIGRvY3VtZW50OiBkb2N1bWVudCA/IHtcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpLFxyXG4gICAgICAgIH0gOiBudWxsLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGx1Z2luU3RhdGUoKSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLmF3YWl0IGdldE1jcFBsdWdpblN0YXRlKCksXHJcbiAgICAgICAgZm9udEFzc2V0czogYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPliBGaWdtYSDmlofku7bigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXJzZWQubm9kZUlkXHJcbiAgICAgICAgICAgID8gYXdhaXQgYXBpLmdldE5vZGUocGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpXHJcbiAgICAgICAgICAgIDogYXdhaXQgYXBpLmdldEZpbGUocGFyc2VkLmZpbGVLZXkpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oXHJcbiAgICAgICAgICAgIHBhcnNlRG9jdW1lbnQocGF5bG9hZCwgc291cmNlVXJsLCBwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoeyAuLi5jdXJyZW50LCBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgY29uc3QgZm9udEFzc2V0cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZU92ZXJyaWRlcyA9IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSk7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6IGDlt7Lor7vlj5YgJHtkb2N1bWVudC5maWxlTmFtZX1gIH0pO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsLFxyXG4gICAgICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLFxyXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgIGZvbnRBc3NldHMsXHJcbiAgICAgICAgICAgIG5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiwgZm9udEFzc2V0cz86IEZvbnRBc3NldE9wdGlvbltdKTogUHJvbWlzZTxCYXRjaERvY3VtZW50RHRvPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSwgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGZvbnRBc3NldHMgPz8gYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgICAgICBub2RlT3ZlcnJpZGVzOiAoYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSkuZmlsdGVyKChpdGVtKSA9PiBkb2N1bWVudC5ub2RlQnlJZC5oYXMoaXRlbS5pZCkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJhdGNoU291cmNlKHNvdXJjZVVybDogc3RyaW5nKTogUHJvbWlzZTxCYXRjaFNvdXJjZVJlc3VsdD4ge1xyXG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgaWYgKCFwYXJzZWQubm9kZUlkKSB7XHJcbiAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUpIHRocm93IG5ldyBFcnJvcign5pW05Lu95paH5Lu26K+35Y2V54us5a+85YWl77yb6K+35YWI56e76Zmk5om56YeP55WM6Z2i5YiX6KGo77yM5oiW5L2/55SoIFNlY3Rpb24gLyBGcmFtZSDpk77mjqXjgIInKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6ICdmaWxlJywgc291cmNlVXJsLCBpdGVtczogW10sIGFkZGVkOiAwLCBkdXBsaWNhdGVzOiAwLCBkb2N1bWVudCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPluW5tuivhuWIqyBTZWN0aW9uIC8gRnJhbWXigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCk7XHJcbiAgICAgICAgY29uc3QgcGFyc2VkRG9jdW1lbnQgPSBwYXJzZURvY3VtZW50KGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcclxuICAgICAgICAgICAgc291cmNlVXJsLCBwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IHBhcnNlZERvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGlmIChyb290LnR5cGUgIT09ICdTRUNUSU9OJyAmJiByb290LnR5cGUgIT09ICdGUkFNRScpIHtcclxuICAgICAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUpIHRocm93IG5ldyBFcnJvcign5om56YeP5YiX6KGo5Y+q5o6l5Y+XIFNlY3Rpb24g5oiWIEZyYW1l77yb5YW25LuW6IqC54K56K+35riF56m65YiX6KGo5ZCO5Y2V54us5a+85YWl44CCJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4ocGFyc2VkRG9jdW1lbnQpO1xyXG4gICAgICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgICAgIGF3YWl0IHBhdGNoU2V0dGluZ3MoeyBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6ICdub2RlJywgc291cmNlVXJsLCBpdGVtczogW10sIGFkZGVkOiAwLCBkdXBsaWNhdGVzOiAwLFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQsIGZvbnRBc3NldHMpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZyYW1lcyA9IGNvbGxlY3RTZWN0aW9uRnJhbWVzKHJvb3QpO1xyXG4gICAgICAgIGlmICghZnJhbWVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfov5nkuKogU2VjdGlvbiDkuIvmsqHmnInlj6/ni6znq4vlr7zlhaXnmoTlpJblsYIgRnJhbWXjgIInKTtcclxuICAgICAgICBjb25zdCBwcmVwYXJlZDogQXJyYXk8eyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PiA9IFtdO1xyXG4gICAgICAgIGxldCBkdXBsaWNhdGVzID0gMDtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGZyYW1lcykge1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKHBhcnNlZC5maWxlS2V5LCBmcmFtZS5pZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYmF0Y2hEb2N1bWVudHMuZ2V0KGlkKTtcclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBkdXBsaWNhdGVzICs9IDE7XHJcbiAgICAgICAgICAgICAgICBwcmVwYXJlZC5wdXNoKHsgLi4uZXhpc3RpbmcsIGl0ZW06IHsgLi4uZXhpc3RpbmcuaXRlbSxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhleGlzdGluZy5kb2N1bWVudCwgZm9udEFzc2V0cykgfSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oZnJhbWVEb2N1bWVudChwYXJzZWREb2N1bWVudCwgZnJhbWUpKTtcclxuICAgICAgICAgICAgY29uc3QgaXRlbTogQmF0Y2hGcmFtZUl0ZW0gPSB7XHJcbiAgICAgICAgICAgICAgICBpZCwgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgcm9vdElkOiBmcmFtZS5pZCwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgICAgICBuYW1lOiBmcmFtZS5uYW1lLCBlbmFibGVkOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgLi4uKHJvb3QudHlwZSA9PT0gJ1NFQ1RJT04nID8geyBzZWN0aW9uTmFtZTogcm9vdC5uYW1lIH0gOiB7fSksXHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudCwgZm9udEFzc2V0cyksXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIHByZXBhcmVkLnB1c2goeyBpdGVtLCBkb2N1bWVudCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYWRkZWQgPSBwcmVwYXJlZC5sZW5ndGggLSBkdXBsaWNhdGVzO1xyXG4gICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplICsgYWRkZWQgPiBNQVhfQkFUQ0hfSVRFTVMpIHRocm93IG5ldyBFcnJvcign5pys5om55pyA5aSa5re75YqgICcgKyBNQVhfQkFUQ0hfSVRFTVMgKyAnIOS4queVjOmdou+8jOivt+WIhuaJueWvvOWFpeOAgicpO1xyXG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHByZXBhcmVkKSBiYXRjaERvY3VtZW50cy5zZXQoZW50cnkuaXRlbS5pZCwgZW50cnkpO1xyXG4gICAgICAgIGF3YWl0IHBhdGNoU2V0dGluZ3MoeyBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6ICflt7Lmt7vliqAgJyArIGFkZGVkICsgJyDkuKrnlYzpnaInXHJcbiAgICAgICAgICAgICsgKGR1cGxpY2F0ZXMgPyAn77yMJyArIGR1cGxpY2F0ZXMgKyAnIOS4quW3suWcqOWIl+ihqCcgOiAnJykgKyAn44CCJyB9KTtcclxuICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiByb290LnR5cGUgPT09ICdTRUNUSU9OJyA/ICdzZWN0aW9uJyA6ICdmcmFtZScsIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgaXRlbXM6IHByZXBhcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pLCBhZGRlZCwgZHVwbGljYXRlcyB9O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYWN0aXZhdGVCYXRjaEl0ZW0oaWQ6IHN0cmluZyk6IFByb21pc2U8QmF0Y2hEb2N1bWVudER0bz4ge1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gYmF0Y2hEb2N1bWVudHMuZ2V0KGlkKTtcclxuICAgICAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgRXJyb3IoJ+ivpeeVjOmdouW3suWkseaViO+8jOivt+mHjeaWsOa3u+WKoOmTvuaOpeOAgicpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgYmF0Y2hEb2N1bWVudER0byhlbnRyeS5kb2N1bWVudCk7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgZW50cnkuaXRlbS5kb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIHJldHVybiBkb2N1bWVudDtcclxuICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzeW5jQmF0Y2hJdGVtcyhpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBlbmFibGVkOiBib29sZWFuIH0+KTogeyBpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSB9IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeS7u+WKoeWujOaIkOWQjuWGjeS/ruaUueeVjOmdouWIl+ihqOOAgicpO1xyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGl0ZW1zKSB8fCBpdGVtcy5sZW5ndGggPiBNQVhfQkFUQ0hfSVRFTVMpIHRocm93IG5ldyBFcnJvcign5om56YeP55WM6Z2i5YiX6KGo5peg5pWI44CCJyk7XHJcbiAgICBjb25zdCBuZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4oKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgaXRlbS5lbmFibGVkICE9PSAnYm9vbGVhbicgfHwgbmV4dC5oYXMoaXRlbS5pZCkpIHRocm93IG5ldyBFcnJvcign55WM6Z2i5YiX6KGo5bey6L+H5pyf5oiW5YyF5ZCr6YeN5aSN6aG577yM6K+36YeN5paw6K+75Y+W44CCJyk7XHJcbiAgICAgICAgbmV4dC5zZXQoaXRlbS5pZCwgeyAuLi5lbnRyeSwgaXRlbTogeyAuLi5lbnRyeS5pdGVtLCBlbmFibGVkOiBpdGVtLmVuYWJsZWQgfSB9KTtcclxuICAgIH1cclxuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgZW50cnldIG9mIG5leHQpIGJhdGNoRG9jdW1lbnRzLnNldChpZCwgZW50cnkpO1xyXG4gICAgcmV0dXJuIHsgaXRlbXM6IFsuLi5iYXRjaERvY3VtZW50cy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSkgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0QmF0Y2hTdGF0ZSgpOiBQcm9taXNlPEJhdGNoU3RhdGU+IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCkgcmV0dXJuIHtcclxuICAgICAgICBpdGVtczogWy4uLmJhdGNoRG9jdW1lbnRzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSxcclxuICAgICAgICBsYXN0UmVzdWx0OiBsYXN0QmF0Y2hSZXN1bHQsIHJ1bm5pbmc6IGJhdGNoUHJvZ3Jlc3MoYWN0aXZlQmF0Y2gpLFxyXG4gICAgfTtcclxuICAgIGNvbnN0IGZvbnRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgIGNvbnN0IGl0ZW1zOiBCYXRjaEZyYW1lSXRlbVtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGJhdGNoRG9jdW1lbnRzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgaXRlbXMucHVzaCh7IC4uLmVudHJ5Lml0ZW0sIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGVudHJ5LmRvY3VtZW50LCBmb250cykgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBpdGVtcywgbGFzdFJlc3VsdDogbGFzdEJhdGNoUmVzdWx0LCAuLi4oYWN0aXZlQmF0Y2ggPyB7IHJ1bm5pbmc6IGJhdGNoUHJvZ3Jlc3MoYWN0aXZlQmF0Y2gpIH0gOiB7fSkgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmF0Y2gocmVxdWVzdDogQmF0Y2hJbXBvcnRSZXF1ZXN0KTogUHJvbWlzZTxCYXRjaEltcG9ydFJlc3VsdD4ge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoIHx8IGFjdGl2ZUNvbnRyb2xsZXIgfHwgYXBwbHlpbmdJbXBvcnRSZXZpZXcgfHwgcm91bmR0cmlwQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnInmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDjgIInKTtcclxuICAgIGlmICghcmVxdWVzdCB8fCAhQXJyYXkuaXNBcnJheShyZXF1ZXN0Lml0ZW1zKSB8fCAhcmVxdWVzdC5pdGVtcy5sZW5ndGggfHwgcmVxdWVzdC5pdGVtcy5sZW5ndGggPiBNQVhfQkFUQ0hfSVRFTVMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+iHs+WwkemAieaLqeS4gOS4quacieaViOeahOW+heWvvOWFpeeVjOmdouOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBzYWZlU2V0dGluZ3MocmVxdWVzdC5zZXR0aW5ncyk7XHJcbiAgICBjb25zdCBlbnRyaWVzID0gcmVxdWVzdC5pdGVtcy5tYXAoKGl0ZW0pID0+IHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IGl0ZW0gJiYgYmF0Y2hEb2N1bWVudHMuZ2V0KGl0ZW0uaWQpO1xyXG4gICAgICAgIGlmICghZW50cnkgfHwgIWVudHJ5Lml0ZW0uZW5hYmxlZCB8fCAhQXJyYXkuaXNBcnJheShpdGVtLm92ZXJyaWRlcykpIHRocm93IG5ldyBFcnJvcign5b6F5a+85YWl55WM6Z2i5bey5aSx5pWI5oiW5pyq5Yu+6YCJ77yM6K+36YeN5paw6K+75Y+W44CCJyk7XHJcbiAgICAgICAgY29uc3Qgb3ZlcnJpZGVzID0gaXRlbS5vdmVycmlkZXMubWFwKChvdmVycmlkZSkgPT4gKHsgLi4ub3ZlcnJpZGUgfSkpO1xyXG4gICAgICAgIGNvbnN0IHJvb3QgPSBlbnRyeS5kb2N1bWVudC5yb290c1swXTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChvdmVycmlkZXMsIGVudHJ5LmRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbnMuZ2V0KHJvb3QuaWQpPy5hY3Rpb24gPT09ICdpZ25vcmUnKSB0aHJvdyBuZXcgRXJyb3IoJ+KAnCcgKyBlbnRyeS5pdGVtLm5hbWUgKyAn4oCd5qC56IqC54K55bey5b+955Wl77yM6K+35Y+W5raI6K+l55WM6Z2i5Yu+6YCJ5oiW5oGi5aSN5qC56IqC54K5562W55Wl44CCJyk7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IGRlY2lzaW9ucy5nZXQocm9vdC5pZCk/Lm5hbWUgfHwgcm9vdC5uYW1lO1xyXG4gICAgICAgIHJldHVybiB7IC4uLmVudHJ5LCBvdmVycmlkZXMsIG5hbWUgfTtcclxuICAgIH0pO1xyXG4gICAgYXNzZXJ0QmF0Y2hUYXJnZXRzKGVudHJpZXMubWFwKChlbnRyeSkgPT4gKHsgaWQ6IGVudHJ5Lml0ZW0uaWQsIG5hbWU6IGVudHJ5Lm5hbWUgfSkpKTtcclxuICAgIGNvbnN0IHJ1bjogQmF0Y2hSdW4gPSB7XHJcbiAgICAgICAgaWQ6IHJhbmRvbUJ5dGVzKDE4KS50b1N0cmluZygnaGV4JyksIGluZGV4OiAwLCBzdG9wUmVxdWVzdGVkOiBmYWxzZSxcclxuICAgICAgICBpdGVtczogZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgbmFtZTogZW50cnkubmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBlbnRyeS5pdGVtLnNvdXJjZVVybCwgc3RhdHVzOiAncGVuZGluZycgfSkpLFxyXG4gICAgfTtcclxuICAgIGFjdGl2ZUJhdGNoID0gcnVuO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBlbnRyeS5pdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPSBlbnRyeS5vdmVycmlkZXM7XHJcbiAgICBjb25zdCBwcmV2aW91c0RvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBjb25zdCBwcmV2aW91c1Jlc3VsdCA9IHJlcXVlc3QucHJlc2VydmVSZXN1bHRzID8gbGFzdEJhdGNoUmVzdWx0IDogdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgY29tcGxldGVkUmVzdWx0ID0gKCk6IEJhdGNoSW1wb3J0UmVzdWx0ID0+IHtcclxuICAgICAgICBjb25zdCBtZXJnZWQgPSBuZXcgTWFwPHN0cmluZywgQmF0Y2hJbXBvcnRJdGVtUmVzdWx0PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwcmV2aW91c1Jlc3VsdD8uaXRlbXMgPz8gW10pIHtcclxuICAgICAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLmhhcyhpdGVtLmlkKSkgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBydW4uaXRlbXMpIG1lcmdlZC5zZXQoaXRlbS5pZCwgeyAuLi5pdGVtIH0pO1xyXG4gICAgICAgIGNvbnN0IGl0ZW1zID0gWy4uLm1lcmdlZC52YWx1ZXMoKV07XHJcbiAgICAgICAgcmV0dXJuIHsgaWQ6IHJ1bi5pZCwgaXRlbXMsIHN0b3BwZWQ6IHJ1bi5zdG9wUmVxdWVzdGVkLFxyXG4gICAgICAgICAgICBjb21wbGV0ZWQ6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJyB8fCBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCxcclxuICAgICAgICAgICAgdG90YWw6IGl0ZW1zLmxlbmd0aCB9O1xyXG4gICAgfTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgLy8gQ2hlY2sgZXZlcnkgZGVzdGluYXRpb24gYmVmb3JlIHRoZSBmaXJzdCBpbWFnZS9wcmVmYWIgd3JpdGUuXHJcbiAgICAgICAgY29uc3QgZm9sZGVyID0gbmV3IEFzc2V0V3JpdGVyKHNldHRpbmdzLnByZWZhYkZvbGRlcikuZm9sZGVyO1xyXG4gICAgICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gJ2RiOi8vYXNzZXRzLycgKyBmb2xkZXIgKyAnLycgKyBzYW5pdGl6ZUFzc2V0TmFtZShlbnRyeS5uYW1lKSArICcucHJlZmFiJztcclxuICAgICAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodXJsKTtcclxuICAgICAgICAgICAgaWYgKCFpbmZvKSBjb250aW51ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xyXG4gICAgICAgICAgICBpZiAoIXJlY29yZCB8fCByZWNvcmQuc291cmNlSGFzaCAhPT0gZW50cnkuaXRlbS5pZFxyXG4gICAgICAgICAgICAgICAgfHwgKGJpbmRpbmdzW2VudHJ5Lml0ZW0uaWRdICYmIGJpbmRpbmdzW2VudHJ5Lml0ZW0uaWRdICE9PSBpbmZvLnV1aWQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+KAnCcgKyBlbnRyeS5uYW1lICsgJ+KAneeahCBQcmVmYWIg6Lev5b6E5bey6KKr5YW25LuW5p2l5rqQ5Y2g55So77yM6K+35pS55ZCN5oiW6LCD5pW06L6T5Ye655uu5b2V44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHJ1bi5zdG9wUmVxdWVzdGVkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGNvbXBsZXRlZFJlc3VsdCgpO1xyXG4gICAgICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnY2FuY2VsbGVkJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflt7LlgZzmraLvvIzlsJrmnKrlvIDlp4vku7vkvZXnlYzpnaLjgIInLCBiYXRjaDogeyAuLi5iYXRjaFByb2dyZXNzKHJ1biksIHJlc3VsdCB9IH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbXBvcnRSZXZpZXdzLmludmFsaWRhdGUocmVxdWVzdC5wcmVzZXJ2ZVJlc3VsdHMgPyB7IHByZXNlcnZlSGlzdG9yeTogdHJ1ZSB9IDogdW5kZWZpbmVkKTtcclxuICAgICAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgZW50cmllcy5sZW5ndGg7IGluZGV4KyspIHtcclxuICAgICAgICAgICAgaWYgKHJ1bi5zdG9wUmVxdWVzdGVkKSBicmVhaztcclxuICAgICAgICAgICAgcnVuLmluZGV4ID0gaW5kZXg7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gZW50cmllc1tpbmRleF07XHJcbiAgICAgICAgICAgIGNvbnN0IHJvdyA9IHJ1bi5pdGVtc1tpbmRleF07XHJcbiAgICAgICAgICAgIHJvdy5zdGF0dXMgPSAncnVubmluZyc7XHJcbiAgICAgICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZW50cnkuZG9jdW1lbnQ7XHJcbiAgICAgICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+ato+WcqOWvvOWFpSAnICsgKGluZGV4ICsgMSkgKyAnLycgKyBlbnRyaWVzLmxlbmd0aCArICfvvJonICsgZW50cnkubmFtZSB9KTtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBlcmZvcm1JbXBvcnQoeyBvdmVycmlkZXM6IGVudHJ5Lm92ZXJyaWRlcyxcclxuICAgICAgICAgICAgICAgICAgICBzZXR0aW5nczogeyAuLi5zZXR0aW5ncywgc291cmNlVXJsOiBlbnRyeS5pdGVtLnNvdXJjZVVybCB9IH0sIHJ1bi5pZCxcclxuICAgICAgICAgICAgICAgIHsgZG9jdW1lbnQ6IGVudHJ5LmRvY3VtZW50LCBwcmVzZXJ2ZVJldmlld3M6IHRydWUsIHNpbGVudFJldmlldzogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24ocm93LCB7IHN0YXR1czogJ3N1Y2Nlc3MnLCBwcmVmYWJVcmw6IHJlc3VsdC5wcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICAgICAgY3JlYXRlZDogcmVzdWx0LmNyZWF0ZWQsIHVwZGF0ZWQ6IHJlc3VsdC51cGRhdGVkLCB3YXJuaW5nczogcmVzdWx0Lndhcm5pbmdzLFxyXG4gICAgICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXN1bHQucmV2aWV3Py5pZCB9KTtcclxuICAgICAgICAgICAgICAgIHJvdy5zdGF0dXMgPSAnc3VjY2Vzcyc7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICBsZXQgdW5zYWZlID0gQm9vbGVhbigoZXJyb3IgYXMgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSk/LnJlcXVpcmVzQXR0ZW50aW9uKTtcclxuICAgICAgICAgICAgICAgIHRyeSB7IGlmIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpKSB1bnNhZmUgPSB0cnVlOyB9XHJcbiAgICAgICAgICAgICAgICBjYXRjaCB7IHVuc2FmZSA9IHRydWU7IH1cclxuICAgICAgICAgICAgICAgIHJvdy5zdGF0dXMgPSAnZmFpbGVkJztcclxuICAgICAgICAgICAgICAgIHJvdy5lcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgic7XHJcbiAgICAgICAgICAgICAgICBpZiAodW5zYWZlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcm93LnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICByb3cuZXJyb3IgKz0gJyDlvZPliY3nvJbovpHmiJbkv53lrZjnirbmgIHpnIDopoHmo4Dmn6XvvIzlt7LmmoLlgZzlkI7nu63nlYzpnaLvvJvnoa7orqTnm67moIflkozkv53lrZjnirbmgIHlkI7lho3ph43or5XjgIInO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKHVuc2FmZSB8fCByZXF1ZXN0LmZhaWx1cmVQb2xpY3kgPT09ICdzdG9wJykgcnVuLnN0b3BSZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGVudHJ5Lm5hbWUgKyAn77yaJyArIChyb3cuc3RhdHVzID09PSAnc3VjY2VzcycgPyAn5bey5L+d5a2YJyA6ICflpLHotKUnKSB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGxldGVkUmVzdWx0KCk7XHJcbiAgICAgICAgbGFzdEJhdGNoUmVzdWx0ID0gcmVzdWx0O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHZhbHVlOiAxLCBtZXNzYWdlOiByZXN1bHQuc3RvcHBlZCA/ICfmnKzmibnlt7LlgZzmraLvvIzlt7LlrozmiJDpobnkv53nlZnjgIInIDogJ+acrOaJueWvvOWFpee7k+adn+OAgicsXHJcbiAgICAgICAgICAgIGJhdGNoOiB7IC4uLmJhdGNoUHJvZ3Jlc3MocnVuKSwgcmVzdWx0IH0gfSk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoID09PSBydW4pIGFjdGl2ZUJhdGNoID0gbnVsbDtcclxuICAgICAgICBhY3RpdmVEb2N1bWVudCA9IHByZXZpb3VzRG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzdG9wSW1wb3J0QmF0Y2goKTogeyBhY2NlcHRlZDogYm9vbGVhbiB9IHtcclxuICAgIGlmICghYWN0aXZlQmF0Y2gpIHJldHVybiB7IGFjY2VwdGVkOiBmYWxzZSB9O1xyXG4gICAgYWN0aXZlQmF0Y2guc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflvZPliY3nlYzpnaLlrozmiJDkv53lrZjlkI7lgZzmraLvvIzlkI7nu63nlYzpnaLkuI3kvJrlvIDlp4vjgIInIH0pO1xyXG4gICAgcmV0dXJuIHsgYWNjZXB0ZWQ6IHRydWUgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZVByZXZpZXcobm9kZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgdXJsOiBzdHJpbmcgfT4ge1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudD8ubm9kZUJ5SWQuZ2V0KG5vZGVJZCk7XHJcbiAgICBpZiAoIWRvY3VtZW50IHx8ICFub2RlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfpooTop4joioLngrnkuI3lrZjlnKjjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgW25vZGVJZF0sXHJcbiAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAxLFxyXG4gICAgICAgICAgICAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGlmICghdXJsc1tub2RlSWRdKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV55Sf5oiQ6IqC54K56aKE6KeI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IHVybDogdXJsc1tub2RlSWRdIH07XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IFJlY29yZDxzdHJpbmcsICguLi5hcmdzOiBhbnlbXSkgPT4gYW55PiA9IHtcclxuICAgIGdldEltcG9ydFJldmlldyhpZD86IHN0cmluZykgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5nZXQoaWQpOyB9LFxyXG4gICAgcmVzb2x2ZUJhdGNoU291cmNlLFxyXG4gICAgYWN0aXZhdGVCYXRjaEl0ZW0sXHJcbiAgICBzeW5jQmF0Y2hJdGVtcyxcclxuICAgIGdldEJhdGNoU3RhdGUsXHJcbiAgICBpbXBvcnRCYXRjaCxcclxuICAgIHN0b3BJbXBvcnRCYXRjaCxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1ByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLnByZXZpZXcoaWQsIGFzc2V0SWQpOyB9LFxyXG4gICAgYXN5bmMgYXBwbHlJbXBvcnRSZXZpZXcoaWQ6IHN0cmluZywgcmVtb3ZlZElkczogdW5rbm93bikge1xyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeWvvOWFpeaIliBGaWdtYSDpooTop4jlrozmiJDjgIInKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICBhcHBseWluZ0ltcG9ydFJldmlldyA9IHRydWU7XHJcbiAgICAgICAgdHJ5IHsgcmV0dXJuIGF3YWl0IGltcG9ydFJldmlld3MuYXBwbHkoaWQsIHJlbW92ZWRJZHMpOyB9XHJcbiAgICAgICAgZmluYWxseSB7IGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gZmFsc2U7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1NvdXJjZVByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nLCBub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeaTjeS9nOWujOaIkOWQjuWGjeWKoOi9veadpea6kOmihOiniOOAgicpO1xyXG4gICAgICAgIGNvbnN0IHsgZmlsZUtleSwgbm9kZSB9ID0gaW1wb3J0UmV2aWV3cy5zb3VyY2UoaWQsIGFzc2V0SWQsIG5vZGVJZCk7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgaWYgKGltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmaWxscyA9IGF3YWl0IGFwaS5nZXRJbWFnZUZpbGxVcmxzKGZpbGVLZXkpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpbGxzW2ltYWdlUmVmXSkgcmV0dXJuIHsgdXJsOiBmaWxsc1tpbWFnZVJlZl0sIG5vdGU6ICdGaWdtYSDljp/lm77vvIjmnKrlkIjmiJDoioLngrnmlYjmnpzvvIknIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IGFwaS5nZXRJbWFnZVVybHMoZmlsZUtleSwgW25vZGUuaWRdLCAncG5nJywgMSwgIW92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoIXVybHNbbm9kZS5pZF0pIHRocm93IG5ldyBFcnJvcignRmlnbWEg5pyq6L+U5Zue6aKE6KeI77yM6ZqQ6JeP5oiW5aSN5p2C5pWI5p6c6IqC54K55Y+v6IO95peg5rOV5Y2V54us5riy5p+T44CCJyk7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHVybDogdXJsc1tub2RlLmlkXSwgbm90ZTogJ0ZpZ21hIOW9k+WJjeiKgueCuea4suafk++8iOmakOiXj+elluWFiOWPr+iDveS9v+mihOiniOmAj+aYju+8iScgfTtcclxuICAgICAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxuICAgIH0sXHJcbiAgICBvcGVuUGFuZWwoKSB7XHJcbiAgICAgICAgRWRpdG9yLlBhbmVsLm9wZW4ocGFja2FnZUpTT04ubmFtZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFN0YXRlKCkge1xyXG4gICAgICAgIHJldHVybiBnZXRQbHVnaW5TdGF0ZSgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzZXRUb2tlbih2YWx1ZTogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LnNldCh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGNsZWFyVG9rZW4oKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LmNsZWFyKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHZlcmlmeVRva2VuKCkge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkZW50aXR5ID0gYXdhaXQgKGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCkpLnZlcmlmeSgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBoYW5kbGU6IGlkZW50aXR5LmhhbmRsZSB8fCAnRmlnbWEgVXNlcicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVTZXR0aW5ncyh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXk6IHVua25vd24sIG92ZXJyaWRlczogdW5rbm93biwgc2NvcGVJZHM6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleSwgb3ZlcnJpZGVzLCBzY29wZUlkcyk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tBc3NldEZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tDYWNoZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBmZXRjaERvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRQcmV2aWV3KG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldE5vZGVQcmV2aWV3KG5vZGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcERldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5kZXRlY3Qoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wcmV2aWV3KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFBhaXIocGFpclRva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wYWlyKHBhaXJUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwQXBwbHkocHJldmlld1Rva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcclxuICAgICAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCkge1xyXG4gICAgICAgIHJldHVybiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QpO1xyXG4gICAgfSxcclxuXHJcbiAgICBjYW5jZWxJbXBvcnQoKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoKSByZXR1cm4gc3RvcEltcG9ydEJhdGNoKCk7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydE1jcEJyaWRnZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XHJcblxyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxyXG4gICAgICAgIGlzSW1wb3J0QnVzeTogKCkgPT4gYWN0aXZlQmF0Y2ggIT09IG51bGwgfHwgYWN0aXZlQ29udHJvbGxlciAhPT0gbnVsbCB8fCByb3VuZHRyaXBDb250cm9sbGVyICE9PSBudWxsLFxyXG4gICAgICAgIGdldFN0YXRlOiBnZXRNY3BQbHVnaW5TdGF0ZSxcclxuICAgICAgICBmZXRjaERvY3VtZW50OiBmZXRjaEZpZ21hRG9jdW1lbnQsXHJcbiAgICAgICAgZ2V0UHJldmlldzogZ2V0Tm9kZVByZXZpZXcsXHJcbiAgICAgICAgc2F2ZVNldHRpbmdzLFxyXG4gICAgICAgIHBhdGNoU2V0dGluZ3MsXHJcbiAgICAgICAgc2F2ZU5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgcGF0Y2hOb2RlTmFtZXMsXHJcbiAgICAgICAgaW1wb3J0U2VsZWN0aW9uOiAocmVxdWVzdCwgb3BlcmF0aW9uSWQpID0+IHBlcmZvcm1JbXBvcnQocmVxdWVzdCwgb3BlcmF0aW9uSWQpLFxyXG4gICAgICAgIGNhbmNlbEltcG9ydDogKG9wZXJhdGlvbklkKSA9PiB7XHJcbiAgICAgICAgICAgIGlmICghYWN0aXZlQ29udHJvbGxlciB8fCBhY3RpdmVPcGVyYXRpb25Pd25lciAhPT0gb3BlcmF0aW9uSWQpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgYWN0aXZlQ29udHJvbGxlci5hYm9ydCgpO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBuZXcgTWNwQnJpZGdlU2VydmVyKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBwbHVnaW5WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHBsdWdpbkluc3RhbmNlSWQsXHJcbiAgICAgICAgaW52b2tlOiAobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCkgPT4gYXBpLmludm9rZShtZXRob2QsIHBhcmFtcywgc2lnbmFsKSxcclxuICAgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBicmlkZ2Uuc3RhcnQoKTtcclxuICAgICAgICBtY3BBcGkgPSBhcGk7XHJcbiAgICAgICAgbWNwQnJpZGdlID0gYnJpZGdlO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBhd2FpdCBicmlkZ2UuY2xvc2UoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5ZCv5Yqo5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gYXdhaXQgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGVkaXRvclJlaW1wb3J0ZXIpO1xyXG4gICAgICAgIGNvbnN0IGFjdGl2ZSA9IHJlY292ZXJlZC5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyA9PT0gJ2FjdGl2ZS1vd25lcicpO1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGFjdGl2ZS5sZW5ndGhcclxuICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7YWN0aXZlLmxlbmd0aH0g5Liq5LuN55Sx5rS75Yqo6L+b56iL5oyB5pyJ55qEIFJvdW5kLXRyaXAg5LqL5Yqh77yM5pqC5pe256aB5q2iIFBhaXIvQXBwbHnjgIJgXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYFJvdW5kLXRyaXAg5ZCv5Yqo5oGi5aSN5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWA7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RhcnRNY3BCcmlkZ2UoKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCkgYWN0aXZlQmF0Y2guc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICBiYXRjaERvY3VtZW50cy5jbGVhcigpO1xyXG4gICAgbGFzdEJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkO1xyXG4gICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbiAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIHZvaWQgYnJpZGdlPy5jbG9zZSgpLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5YWz6Zet5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfSk7XHJcbn1cclxuIl19