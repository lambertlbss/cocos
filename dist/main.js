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
const sync_marker_1 = require("./importer/sync-marker");
const sync_marker_asset_1 = require("./importer/sync-marker-asset");
const sync_preview_1 = require("./importer/sync-preview");
const assets_1 = require("./importer/assets");
const cache_1 = require("./importer/cache");
const local_resources_1 = require("./importer/local-resources");
const svg_1 = require("./importer/svg");
const sliced_png_1 = require("./importer/sliced-png");
const import_visibility_1 = require("./import-visibility");
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
        importHiddenLayers: input.importHiddenLayers !== false,
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
    const hidden = (0, import_visibility_1.hiddenLayerIds)(session.roots, importSettings.importHiddenLayers !== false);
    const applyVisibility = (node) => {
        var _a;
        if (hidden.has(node.id))
            decisions.set(node.id, {
                ...((_a = decisions.get(node.id)) !== null && _a !== void 0 ? _a : defaultDecision(node)), action: 'ignore', nineSlice: false,
            });
        node.children.forEach(applyVisibility);
    };
    session.roots.forEach(applyVisibility);
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
        var _a, _b, _c;
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
        const namedLocalTiles = new Map();
        for (const group of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted) {
                throw new client_1.CancelledError();
            }
            const nameKey = resourceKey(group.node);
            let local = namedLocalTiles.get(nameKey);
            if (!local) {
                const match = await findLocal(group.node.name, false);
                const localUrl = match ? assetDatabaseUrl(match.path) : null;
                const asset = localUrl ? await writer.existing(localUrl) : null;
                if (localUrl && !asset)
                    throw new Error(`同名本地资源尚无可用 SpriteFrame，请先在 Cocos 中完成资源导入后重试，不会另建副本：${localUrl}`);
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
                    extension: (0, assets_1.detectImageExtension)(local.match.contents), sourceType: 'local', sourceRenderScale: 1 });
                continue;
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
                raster = (0, tiled_png_1.rasterizeTile)(contents, requestedScale(item.source), (_c = item.sourceRenderScale) !== null && _c !== void 0 ? _c : renderScale(item.source));
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
            const localMatch = (0, mask_tint_1.analyzeMaskTint)(node) && !sliceAnalysis ? null : await findLocal(node.name, false);
            // An explicitly designated local SpriteFrame owns its pixels and
            // insets. Reuse it read-only, even when Figma defines a slice or
            // refresh is requested; source insets cannot be applied to an
            // unknown or already-compacted local canvas.
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
            if (selectedSlice && !localMatch) {
                const shape = (entry) => JSON.stringify({ mode: entry.analysis.mode,
                    borders: entry.analysis.borders, frame: entry.node.absoluteBoundingBox && {
                        width: entry.node.absoluteBoundingBox.width, height: entry.node.absoluteBoundingBox.height,
                    } });
                if (slicedSources.slice(1).some((entry) => shape(entry) !== shape(selectedSlice))) {
                    const reason = `同名三/九宫定义不同，沿用首个有效 Figma 切片“${node.name}”的原始画布与边距，仅生成一份资源`;
                    warnings.add(reason);
                    note('merged', node.name, reason, url);
                }
                note('merged', node.name, 'Figma 三/九宫定义优先：使用 Figma 原始画布与边距生成输出资源，不沿用未指定输出资源的旧边距', url);
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
        if (!url)
            continue;
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
function makeSpec(node, parentFrame, decisions, plans, nodeById, assets, fonts, isRoot = false, parentWorldRotation = 0, sync) {
    var _a, _b, _c, _d;
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
    // 折叠到本节点的子层 id 与 aliasFigmaIds 一致；标记只记录聚合身份，
    // 不试图为折叠子层单独建节点。
    const syncMarker = sync
        ? (0, sync_marker_1.createSyncMarker)({
            fileKey: sync.fileKey,
            node,
            aliasNodeIds: (_b = fold === null || fold === void 0 ? void 0 : fold.absorbedNodeIds) !== null && _b !== void 0 ? _b : [],
        })
        : undefined;
    return {
        figmaId: node.id,
        name: (_c = decision.name) !== null && _c !== void 0 ? _c : node.name,
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
        fontUuid: ((_d = textSource.style) === null || _d === void 0 ? void 0 : _d.fontFamily) ? fonts.get(textSource.style.fontFamily) : undefined,
        aliasFigmaIds: fold === null || fold === void 0 ? void 0 : fold.absorbedNodeIds,
        flattenBoundary: bitmapTerminal || fullFold
            ? true
            : (fold === null || fold === void 0 ? void 0 : fold.kind) === 'background'
                ? false
                : undefined,
        planReason: plan === null || plan === void 0 ? void 0 : plan.reason,
        syncMarker,
        children: terminal
            ? []
            : node.children
                .filter((child) => !absorbedDirectIds.has(child.id))
                .map((child) => makeSpec(child, frame, decisions, plans, nodeById, assets, fonts, false, worldRotation, sync))
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
async function waitForSyncMarkerScript(url) {
    const started = Date.now();
    while (Date.now() - started < 15000) {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
        if (typeof (info === null || info === void 0 ? void 0 : info.uuid) === 'string') {
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
async function ensureSyncMarkerScript() {
    const url = sync_marker_1.SYNC_MARKER_SCRIPT_URL;
    let existing = null;
    try {
        existing = await (0, promises_1.readFile)(prefabDiskPath(url), 'utf8');
    }
    catch {
        existing = null;
    }
    const plan = (0, sync_marker_asset_1.planSyncMarkerScript)(existing);
    if (plan.action === 'reject') {
        throw new Error(plan.reason);
    }
    if (plan.action === 'keep') {
        await waitForSyncMarkerScript(url);
        return { action: 'keep' };
    }
    const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
    if (!info) {
        const created = await Editor.Message.request('asset-db', 'create-asset', url, plan.content, {
            overwrite: false,
            rename: false,
        });
        if (!created) {
            throw new Error(`无法创建组件同步标记脚本：${url}`);
        }
    }
    else {
        await Editor.Message.request('asset-db', 'save-asset', url, plan.content);
    }
    await waitForSyncMarkerScript(url);
    return {
        action: plan.action,
        reason: plan.action === 'rewrite' ? plan.reason : undefined,
    };
}
function collectSyncMarkerSpecs(specs) {
    const markers = [];
    const visit = (nodes) => {
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
/**
 * 组件同步预检：只读目标 Prefab 与当前 Figma 计划。
 * 不下载图片、不打开 Prefab、不写入任何文件，可在用户点击导入前反复调用。
 */
async function previewComponentSync() {
    const document = activeDocument;
    if (!document) {
        throw new Error('请先读取 Figma 文件。');
    }
    if (!document.sourceNodeId || document.roots.length !== 1) {
        throw new Error('只有单个节点链接才能预览组件同步。');
    }
    const root = document.roots[0];
    if (root.type !== 'COMPONENT' && root.type !== 'INSTANCE') {
        throw new Error(`当前根节点是 ${root.type}，只有组件（COMPONENT/INSTANCE）链接支持组件同步。`);
    }
    const settings = await getSettings();
    // AssetWriter 构造函数只规范化目录，不会创建文件夹。
    const writer = new assets_1.AssetWriter(settings.prefabFolder);
    const prefabUrl = `db://assets/${writer.folder}/${(0, assets_1.sanitizeAssetName)(root.name)}.prefab`;
    const info = await queryPrefabAsset(prefabUrl);
    if (!info) {
        return { targetUrl: prefabUrl, exists: false, ...(0, sync_preview_1.emptySyncPreviewSummary)() };
    }
    const previous = (0, sync_preview_1.readPrefabSyncMarkers)(await (0, promises_1.readFile)(prefabDiskPath(prefabUrl)));
    const overrides = await nodeOverridesFor(document.fileKey);
    const decisions = decisionMap(overrides, document.tree);
    const plans = (0, import_planner_1.compileImportPlan)(document.roots, decisions);
    const rootFrame = nodeFrame(root);
    const specs = document.roots
        .map((node) => makeSpec(node, rootFrame, decisions, plans, document.nodeById, new Map(), new Map(), true, 0, { fileKey: document.fileKey }))
        .filter((spec) => spec !== null);
    return {
        targetUrl: prefabUrl,
        exists: true,
        prefabUuid: info.uuid,
        ...(0, sync_preview_1.planSyncPreview)(previous, specs, { scale: settings.scale }),
    };
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
        // 组件级同步：只有单节点链接、且根节点确实是组件（或实例）时启用。
        // Frame 链接保持原有行为，不生成标记、不额外创建项目脚本。
        const syncRootNode = document.sourceNodeId && document.roots.length === 1
            ? document.roots[0]
            : undefined;
        const syncContext = syncRootNode
            && (syncRootNode.type === 'COMPONENT' || syncRootNode.type === 'INSTANCE')
            ? { fileKey: document.fileKey }
            : undefined;
        const roots = document.roots
            .map((node, index) => {
            const spec = makeSpec(node, rootFrame, decisions, plans, document.nodeById, assets, fonts, true, 0, syncContext);
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
        if (syncContext) {
            try {
                (0, sync_marker_1.assertUniqueSyncOwnership)(collectSyncMarkerSpecs(roots));
            }
            catch (error) {
                warnings.push(error instanceof Error ? error.message : '同步标记所有权校验失败。');
            }
        }
        const sourceNodeId = document.sourceNodeId;
        if (sourceNodeId && roots.length === 1) {
            const prefabWriter = new assets_1.AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = ((_f = (_e = roots[0]) === null || _e === void 0 ? void 0 : _e.name) === null || _f === void 0 ? void 0 : _f.trim())
                || ((_h = (_g = document.roots[0]) === null || _g === void 0 ? void 0 : _g.name) === null || _h === void 0 ? void 0 : _h.trim())
                || document.fileName;
            const prefabUrl = `db://assets/${prefabWriter.folder}/${(0, assets_1.sanitizeAssetName)(frameName)}.prefab`;
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
            });
            if (result.syncMarkerWarning) {
                warnings.push(`组件同步标记未写入：${result.syncMarkerWarning}`);
            }
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
    const visibleItems = request.items.filter((item) => {
        var _a, _b;
        return settings.importHiddenLayers
            || ((_b = (_a = batchDocuments.get(item === null || item === void 0 ? void 0 : item.id)) === null || _a === void 0 ? void 0 : _a.document.roots[0]) === null || _b === void 0 ? void 0 : _b.visible) !== false;
    });
    if (!visibleItems.length)
        throw new Error('已关闭隐藏图层导入，所选界面均已隐藏；请选择可见界面或开启导入隐藏图层。');
    const entries = visibleItems.map((item) => {
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
    async syncPreview() {
        return previewComponentSync();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQTRnQkEsd0RBZ0JDO0FBOEJELGtDQTJCQztBQUVELGdFQVNDO0FBNkZELHdDQXFDQztBQW1FRCxrQ0Fzd0JDO0FBeUNELDRCQWtIQztBQXk0Q0Qsb0JBYUM7QUFFRCx3QkFnQkM7QUE5bUdELCtCQUE4RTtBQUM5RSwyQkFBZ0M7QUFDaEMsbUNBQXFDO0FBQ3JDLCtDQUFnRTtBQUNoRSwwQ0FBZ0Q7QUFDaEQsbUVBQTBDO0FBQzFDLDJDQUE4RTtBQUM5RSwrQ0FXMEI7QUFDMUIsMkNBQStDO0FBQy9DLDJEQUtnQztBQUNoQyxpREFBeUU7QUFDekUsNkNBQXVFO0FBQ3ZFLHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsd0RBS2dDO0FBQ2hDLG9FQUFvRTtBQUNwRSwwREFLaUM7QUFDakMsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHNEQUF1RDtBQUN2RCwyREFBcUQ7QUFDckQsNERBQWlEO0FBQ2pELG9EQUEwRjtBQUMxRixzREFBMkQ7QUFDM0Qsd0RBWWdDO0FBQ2hDLHdEQUFvRDtBQUNwRCx1Q0FBdUU7QUFDdkUsZ0RBQXNEO0FBQ3RELGlEQUF1RDtBQUN2RCxtREFBc0U7QUFDdEUseURBQTJEO0FBQzNELG1DQW1CaUI7QUFDakIsMkNBQStDO0FBQy9DLDREQUFxRjtBQUNyRiw4RUFBeUU7QUFFekUsaURBQXlGO0FBTXpGLE1BQU0sS0FBSyxHQUFHLElBQUksd0JBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQy9DLE1BQU0sYUFBYSxHQUFHLElBQUksbUNBQW1CLEVBQUUsQ0FBQztBQUNoRCxJQUFJLG9CQUFvQixHQUFHLEtBQUssQ0FBQztBQUNqQyxJQUFJLGNBQWMsR0FBMkIsSUFBSSxDQUFDO0FBQ2xELElBQUksZ0JBQWdCLEdBQTJC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LENBQUMsQ0FBQyxDQUFBLENBQUM7QUFDUCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgYmFzZW5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnY3J5cHRvJztcclxuaW1wb3J0IHsgZGlhZ25vc3RpY1N0YXJ0LCBkaWFnbm9zdGljVGFzayB9IGZyb20gJy4vZGlhZ25vc3RpY3MnO1xyXG5pbXBvcnQgeyByZWFkRmlsZSwgcmVhZGRpciB9IGZyb20gJ2ZzL3Byb21pc2VzJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEZpZ21hQ2xpZW50LCBDYW5jZWxsZWRFcnJvciwgY2xhbXBJbWFnZVNjYWxlIH0gZnJvbSAnLi9maWdtYS9jbGllbnQnO1xyXG5pbXBvcnQge1xyXG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcclxuICAgIGluZmVyQWN0aW9uLFxyXG4gICAgaW5mZXJDb2Nvc0xheW91dE1vZGUsXHJcbiAgICBpbmZlcktpbmQsXHJcbiAgICBpc1BhdGNoQ2FuZGlkYXRlLFxyXG4gICAgaXNOYW1lZFNsaWNlR3JvdXAsXHJcbiAgICBpc1ZlY3Rvck5vZGUsXHJcbiAgICBuYXRpdmVUaWxlZFBhaW50U291cmNlLFxyXG4gICAgcGxhaW5JbWFnZVNvdXJjZVJlZixcclxuICAgIHR5cGUgVGlsZWRQYWludFNvdXJjZSxcclxufSBmcm9tICcuL2ZpZ21hL2FuYWx5emVyJztcclxuaW1wb3J0IHsgcGFyc2VEb2N1bWVudCB9IGZyb20gJy4vZmlnbWEvcGFyc2VyJztcclxuaW1wb3J0IHtcclxuICAgIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuLFxyXG4gICAgY29tcGlsZUltcG9ydFBsYW4sXHJcbiAgICBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24sXHJcbiAgICByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMsXHJcbn0gZnJvbSAnLi9maWdtYS9pbXBvcnQtcGxhbm5lcic7XHJcbmltcG9ydCB7IGFuYWx5emVNYXNrVGludCwgdmVyaWZ5V2hpdGVBbHBoYVBuZyB9IGZyb20gJy4vZmlnbWEvbWFzay10aW50JztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCwgdHlwZSBTbGljZUFuYWx5c2lzIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgU1lOQ19NQVJLRVJfU0NSSVBUX1VSTCxcclxuICAgIGFzc2VydFVuaXF1ZVN5bmNPd25lcnNoaXAsXHJcbiAgICBjcmVhdGVTeW5jTWFya2VyLFxyXG4gICAgdHlwZSBTeW5jTWFya2VyU3BlYyxcclxufSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtbWFya2VyJztcclxuaW1wb3J0IHsgcGxhblN5bmNNYXJrZXJTY3JpcHQgfSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtbWFya2VyLWFzc2V0JztcclxuaW1wb3J0IHtcclxuICAgIGVtcHR5U3luY1ByZXZpZXdTdW1tYXJ5LFxyXG4gICAgcGxhblN5bmNQcmV2aWV3LFxyXG4gICAgcmVhZFByZWZhYlN5bmNNYXJrZXJzLFxyXG4gICAgdHlwZSBTeW5jUHJldmlld1Jlc3VsdCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtcHJldmlldyc7XHJcbmltcG9ydCB7XHJcbiAgICBBc3NldFdyaXRlcixcclxuICAgIFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TLFxyXG4gICAgZGV0ZWN0SW1hZ2VFeHRlbnNpb24sXHJcbiAgICByZXNvbHZlQXNzZXRVdWlkLFxyXG4gICAgc2FuaXRpemVBc3NldE5hbWUsXHJcbiAgICB0eXBlIFJhc3RlckltYWdlRXh0ZW5zaW9uLFxyXG59IGZyb20gJy4vaW1wb3J0ZXIvYXNzZXRzJztcclxuaW1wb3J0IHsgTG9jYWxBc3NldENhY2hlLCB0eXBlIENhY2hlRW50cnlLZXkgfSBmcm9tICcuL2ltcG9ydGVyL2NhY2hlJztcclxuaW1wb3J0IHR5cGUgeyBGb250QXNzZXRPcHRpb24gfSBmcm9tICcuL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgTG9jYWxSZXNvdXJjZUxpYnJhcnkgfSBmcm9tICcuL2ltcG9ydGVyL2xvY2FsLXJlc291cmNlcyc7XHJcbmltcG9ydCB7IGdyYWRpZW50UG5nIH0gZnJvbSAnLi9pbXBvcnRlci9zdmcnO1xyXG5pbXBvcnQgeyB3cml0ZVNsaWNlZFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc2xpY2VkLXBuZyc7XHJcbmltcG9ydCB7IGhpZGRlbkxheWVySWRzIH0gZnJvbSAnLi9pbXBvcnQtdmlzaWJpbGl0eSc7XHJcbmltcG9ydCB7IGlzUG5nIH0gZnJvbSAnLi9pbXBvcnRlci9yYXN0ZXItZm9ybWF0JztcclxuaW1wb3J0IHsgcGl4ZWxTaXplZFRpbGVBc3NldCwgcmFzdGVyaXplVGlsZSwgdGlsZWRSYXN0ZXJLZXkgfSBmcm9tICcuL2ltcG9ydGVyL3RpbGVkLXBuZyc7XHJcbmltcG9ydCB7IHJhc3Rlcml6ZUltYWdlRmlsbCB9IGZyb20gJy4vaW1wb3J0ZXIvaW1hZ2UtZmlsbCc7XHJcbmltcG9ydCB7XHJcbiAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMsXHJcbiAgICBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbixcclxuICAgIGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBmaWdtYUZyYW1lU291cmNlSGFzaCxcclxuICAgIG1lcmdlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldCxcclxuICAgIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQsXHJcbiAgICByZWFkUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHJlY29yZFByZWZhYlN5bmNDYXB0dXJlLFxyXG4gICAgcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICB0eXBlIFByZWZhYlN5bmNSZWNvcmQsXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9wcmVmYWItc3luYyc7XHJcbmltcG9ydCB7IFRva2VuVmF1bHQgfSBmcm9tICcuL3NlY3VyaXR5L3Rva2VuLXZhdWx0JztcclxuaW1wb3J0IHsgRmlnbWFJbXBvcnRlck1jcEFwaSwgdHlwZSBNY3BOb2RlTmFtZVBhdGNoIH0gZnJvbSAnLi9tY3AtYXBpJztcclxuaW1wb3J0IHsgTWNwQnJpZGdlU2VydmVyIH0gZnJvbSAnLi9tY3AtYnJpZGdlL3NlcnZlcic7XHJcbmltcG9ydCB7IFJvdW5kdHJpcFNlcnZpY2UgfSBmcm9tICcuL3JvdW5kdHJpcC9zZXJ2aWNlJztcclxuaW1wb3J0IHsgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zIH0gZnJvbSAnLi9yb3VuZHRyaXAvcmVjb3ZlcnknO1xyXG5pbXBvcnQgeyBlZGl0b3JSZWltcG9ydGVyIH0gZnJvbSAnLi9yb3VuZHRyaXAvdHJhbnNhY3Rpb24nO1xyXG5pbXBvcnQge1xyXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcclxuICAgIHR5cGUgRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgdHlwZSBGaWdtYU5vZGUsXHJcbiAgICB0eXBlIEltcG9ydEFjdGlvbixcclxuICAgIHR5cGUgSW1wb3J0RGVjaXNpb24sXHJcbiAgICB0eXBlIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgdHlwZSBJbXBvcnRSZXF1ZXN0LFxyXG4gICAgdHlwZSBJbXBvcnRTZXR0aW5ncyxcclxuICAgIHR5cGUgTm9kZUtpbmQsXHJcbiAgICB0eXBlIE5vZGVJbXBvcnRQbGFuLFxyXG4gICAgdHlwZSBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NhcHR1cmUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICB0eXBlIFByb2dyZXNzRXZlbnQsXHJcbiAgICB0eXBlIFJlY3QsXHJcbiAgICB0eXBlIFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0eXBlIFNwcml0ZUFzc2V0U3BlYyxcclxuICAgIHR5cGUgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuL25vZGUtbmFtZSc7XHJcbmltcG9ydCB7IEltcG9ydFJldmlld1JlY29yZGVyLCBJbXBvcnRSZXZpZXdTZXJ2aWNlIH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3JztcclxuaW1wb3J0IHsgZmluYWxpemVJbXBvcnRSZXZpZXcgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXctZmluYWxpemUnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldywgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5pbXBvcnQgeyBhc3NlcnRCYXRjaFRhcmdldHMsIGNvbGxlY3RTZWN0aW9uRnJhbWVzLCBmcmFtZURvY3VtZW50IH0gZnJvbSAnLi9iYXRjaC1pbXBvcnQnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBCYXRjaERvY3VtZW50RHRvLCBCYXRjaEZyYW1lSXRlbSwgQmF0Y2hJbXBvcnRJdGVtUmVzdWx0LCBCYXRjaEltcG9ydFJlcXVlc3QsXHJcbiAgICBCYXRjaEltcG9ydFJlc3VsdCwgQmF0Y2hQcm9ncmVzcywgQmF0Y2hTb3VyY2VSZXN1bHQsIEJhdGNoU3RhdGUsXHJcbn0gZnJvbSAnLi9iYXRjaC10eXBlcyc7XHJcblxyXG5jb25zdCB2YXVsdCA9IG5ldyBUb2tlblZhdWx0KHBhY2thZ2VKU09OLm5hbWUpO1xyXG5jb25zdCBpbXBvcnRSZXZpZXdzID0gbmV3IEltcG9ydFJldmlld1NlcnZpY2UoKTtcclxubGV0IGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gZmFsc2U7XHJcbmxldCBhY3RpdmVEb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZU9wZXJhdGlvbk93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgc2V0dGluZ3NDYWNoZTogSW1wb3J0U2V0dGluZ3MgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCBkb2N1bWVudFJldmlzaW9uID0gMDtcclxubGV0IG1jcEJyaWRnZTogTWNwQnJpZGdlU2VydmVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBtY3BBcGk6IEZpZ21hSW1wb3J0ZXJNY3BBcGkgfCBudWxsID0gbnVsbDtcclxuY29uc3QgcGx1Z2luSW5zdGFuY2VJZCA9IHJhbmRvbUJ5dGVzKDE4KS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbmxldCBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCBzZXR0aW5nc1dyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuY29uc3QgTUFYX0JBVENIX0lURU1TID0gMTAwO1xyXG5jb25zdCBiYXRjaERvY3VtZW50cyA9IG5ldyBNYXA8c3RyaW5nLCB7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIH0+KCk7XHJcbmludGVyZmFjZSBCYXRjaFJ1biB7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgaXRlbXM6IEJhdGNoSW1wb3J0SXRlbVJlc3VsdFtdO1xyXG4gICAgaW5kZXg6IG51bWJlcjtcclxuICAgIHN0b3BSZXF1ZXN0ZWQ6IGJvb2xlYW47XHJcbn1cclxubGV0IGFjdGl2ZUJhdGNoOiBCYXRjaFJ1biB8IG51bGwgPSBudWxsO1xyXG5sZXQgbGFzdEJhdGNoUmVzdWx0OiBCYXRjaEltcG9ydFJlc3VsdCB8IHVuZGVmaW5lZDtcclxuXHJcbnR5cGUgRGVjaXNpb24gPSBJbXBvcnREZWNpc2lvbjtcclxuXHJcbmludGVyZmFjZSBUaWxlZEFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSYXdJbWFnZUFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBpbWFnZVJlZjogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHJldmlld0lkPzogc3RyaW5nO1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJldmlld0JlZm9yZT86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3QWZ0ZXI/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlldz86IEltcG9ydFJldmlldztcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxuICAgIC8qKiDmoIforrDnu4Tku7bohJrmnKzlsJrmnKrnvJbor5HlrozmiJDml7bnmoTpmY3nuqfor7TmmI7vvJvlr7zlhaXmnKzouqvnu6fnu63miJDlip/jgIIgKi9cclxuICAgIHN5bmNNYXJrZXJXYXJuaW5nPzogc3RyaW5nO1xyXG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFzc2V0QnVpbGRSZXN1bHQge1xyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+O1xyXG4gICAgd2FybmluZ3M6IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiQXNzZXRJbmZvIHtcclxuICAgIHV1aWQ6IHN0cmluZztcclxuICAgIHVybDogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZXI6IHN0cmluZztcclxuICAgIHR5cGU6IHN0cmluZztcclxuICAgIGltcG9ydGVkOiBib29sZWFuO1xyXG4gICAgaW52YWxpZDogYm9vbGVhbjtcclxuICAgIGlzRGlyZWN0b3J5PzogYm9vbGVhbjtcclxuICAgIHJlYWRvbmx5PzogYm9vbGVhbjtcclxuICAgIHJlZGlyZWN0PzogdW5rbm93bjtcclxufVxyXG5cclxuY29uc3QgRk9OVF9FWFRFTlNJT05TID0gbmV3IFNldChbJy50dGYnLCAnLm90ZicsICcuZm50JywgJy53b2ZmJywgJy53b2ZmMiddKTtcclxuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcclxuICAgICdhdXRvJyxcclxuICAgICdub2RlJyxcclxuICAgICdzcHJpdGUnLFxyXG4gICAgJ2xhYmVsJyxcclxuICAgICdyaWNoVGV4dCcsXHJcbiAgICAnYnV0dG9uJyxcclxuICAgICdzY3JvbGxWaWV3JyxcclxuICAgICdsYXlvdXQnLFxyXG5dKTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGxpc3RGb250QXNzZXRzKCk6IFByb21pc2U8Rm9udEFzc2V0T3B0aW9uW10+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGZvbnRzOiBGb250QXNzZXRPcHRpb25bXSA9IFtdO1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gdmlzaXQoZm9sZGVyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBsZXQgZW50cmllcztcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBlbnRyaWVzID0gYXdhaXQgcmVhZGRpcihmb2xkZXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdub2RlX21vZHVsZXMnIHx8IGVudHJ5Lm5hbWUgPT09ICdsaWJyYXJ5JyB8fCBlbnRyeS5uYW1lID09PSAndGVtcCcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihmb2xkZXIsIGVudHJ5Lm5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdmlzaXQoZmlsZVBhdGgpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFGT05UX0VYVEVOU0lPTlMuaGFzKGV4dG5hbWUoZW50cnkubmFtZSkudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBmaWxlUGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG4gICAgICAgICAgICBmb250cy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKGVudHJ5Lm5hbWUsIGV4dG5hbWUoZW50cnkubmFtZSkpLFxyXG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtwYXRofWAsXHJcbiAgICAgICAgICAgICAgICByZWxhdGl2ZVBhdGg6IHBhdGgsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGF3YWl0IHZpc2l0KGFzc2V0c1Jvb3QpO1xyXG4gICAgcmV0dXJuIGZvbnRzLnNvcnQoKGEsIGIpID0+IGEucmVsYXRpdmVQYXRoLmxvY2FsZUNvbXBhcmUoYi5yZWxhdGl2ZVBhdGgsICd6aC1DTicpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFByb2dyZXNzKHByb2dyZXNzOiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAuLi5wcm9ncmVzcyxcclxuICAgICAgICAuLi4oYWN0aXZlQmF0Y2ggJiYgIXByb2dyZXNzLmJhdGNoID8geyBiYXRjaDogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCkgfSA6IHt9KSxcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaFByb2dyZXNzKHJ1bjogQmF0Y2hSdW4pOiBCYXRjaFByb2dyZXNzIHtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSBydW4uaXRlbXNbTWF0aC5taW4ocnVuLmluZGV4LCBydW4uaXRlbXMubGVuZ3RoIC0gMSldO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBiYXRjaElkOiBydW4uaWQsIGl0ZW1JZDogY3VycmVudD8uaWQgPz8gJycsIG5hbWU6IGN1cnJlbnQ/Lm5hbWUgPz8gJycsXHJcbiAgICAgICAgaW5kZXg6IE1hdGgubWluKHJ1bi5pbmRleCArIDEsIHJ1bi5pdGVtcy5sZW5ndGgpLCB0b3RhbDogcnVuLml0ZW1zLmxlbmd0aCxcclxuICAgICAgICBjb21wbGV0ZWQ6IHJ1bi5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgc3RvcFJlcXVlc3RlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgaXRlbXM6IHJ1bi5pdGVtcy5tYXAoKGl0ZW0pID0+ICh7IC4uLml0ZW0gfSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdENhY2hlRm9sZGVyKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihFZGl0b3IuUHJvamVjdC50bXBEaXIsIHBhY2thZ2VKU09OLm5hbWUsICdhc3NldC1jYWNoZScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBJbXBvcnRTZXR0aW5ncyB7XHJcbiAgICBjb25zdCBpbnB1dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+XHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHNjYWxlID0gdHlwZW9mIGlucHV0LnNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoaW5wdXQuc2NhbGUpXHJcbiAgICAgICAgPyBNYXRoLm1heCgwLjI1LCBNYXRoLm1pbig0LCBpbnB1dC5zY2FsZSkpXHJcbiAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnNjYWxlO1xyXG4gICAgY29uc3QgZm9udE1hcCA9IGlucHV0LmZvbnRNYXAgJiYgdHlwZW9mIGlucHV0LmZvbnRNYXAgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoaW5wdXQuZm9udE1hcClcclxuICAgICAgICAgICAgLmZpbHRlcigoW2tleSwgaXRlbV0pID0+IGtleS50cmltKCkgJiYgdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAubWFwKChba2V5LCBpdGVtXSkgPT4gW2tleS50cmltKCksIGl0ZW0udHJpbSgpXSkpXHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHJhd0xvY2FsRm9sZGVycyA9IEFycmF5LmlzQXJyYXkoaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnMpXHJcbiAgICAgICAgPyBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogdHlwZW9mIGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXIgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgID8gW2lucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHJhd0xvY2FsRm9sZGVyc1xyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlcik6IGZvbGRlciBpcyBzdHJpbmcgPT4gdHlwZW9mIGZvbGRlciA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBmb2xkZXIudHJpbSgpKVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIsIGluZGV4LCBmb2xkZXJzKSA9PiBmb2xkZXJzLmluZGV4T2YoZm9sZGVyKSA9PT0gaW5kZXgpXHJcbiAgICAgICAgLnNsaWNlKDAsIDMpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IHR5cGVvZiBpbnB1dC5zb3VyY2VVcmwgPT09ICdzdHJpbmcnID8gaW5wdXQuc291cmNlVXJsLnRyaW0oKSA6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiB0eXBlb2YgaW5wdXQuYXNzZXRGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MuYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiB0eXBlb2YgaW5wdXQucHJlZmFiRm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGxvY2FsUmVzb3VyY2VGb2xkZXJzWzBdID8/ICcnLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbnB1dC51cGRhdGVFeGlzdGluZyAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogaW5wdXQucmVmcmVzaEFzc2V0cyA9PT0gdHJ1ZSxcclxuICAgICAgICBpbXBvcnRIaWRkZW5MYXllcnM6IGlucHV0LmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UsXHJcbiAgICAgICAgYXV0b1NhdmU6IGlucHV0LmF1dG9TYXZlID09PSB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5nc1VubG9ja2VkKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGlmIChzZXR0aW5nc0NhY2hlKSB7XHJcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgJ3Byb2plY3QnKTtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGF3YWl0IHNldHRpbmdzV3JpdGVRdWV1ZTtcclxuICAgIHJldHVybiBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhTZXR0aW5nc1dyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHNldHRpbmdzV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBzZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSBzYWZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgbmV4dCwgJ3Byb2plY3QnKTtcclxuICAgICAgICBzZXR0aW5nc0NhY2hlID0gbmV4dDtcclxuICAgICAgICByZXR1cm4gbmV4dDtcclxuICAgIH0pKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soKCkgPT4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGF0Y2hTZXR0aW5ncyh2YWx1ZTogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz4pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh7IC4uLmN1cnJlbnQsIC4uLnZhbHVlIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWVudChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkID0gYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsKTogUHJvbWlzZTxGaWdtYUNsaWVudD4ge1xyXG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIHJldHVybiBuZXcgUm91bmR0cmlwU2VydmljZSh7XHJcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcclxuICAgICAgICBwcm9qZWN0Um9vdDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoIHx8IGFjdGl2ZUNvbnRyb2xsZXIgfHwgYXBwbHlpbmdJbXBvcnRSZXZpZXcpIHRocm93IG5ldyBFcnJvcign5a+85YWl5oiW57uT5p6c6LCD5pW05q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5ZCO5YaN5pON5L2cIFJvdW5kLXRyaXDjgIInKTtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbihvd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ato+WcqOehruiupOWvvOWFpeWQjueahOi1hOa6kOiwg+aVtO+8jOivt+eojeWAmeOAgicpO1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcignUm91bmQtdHJpcCDmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblhYjlj5bmtojjgIInKTtcclxuICAgIGlmIChhY3RpdmVCYXRjaCAmJiBvd25lciAhPT0gYWN0aXZlQmF0Y2guaWQpIHRocm93IG5ldyBFcnJvcign5om56YeP5a+85YWl5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YGc5q2i5ZCO57ut5Lu75Yqh44CCJyk7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJIEZpZ21hIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xyXG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBvd25lcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikge1xyXG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoc2VsZWN0ZWRQYXRoKTtcclxuICAgIGNvbnN0IGZvbGRlciA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGlmICghZm9sZGVyIHx8IGZvbGRlciA9PT0gJy4nIHx8IGZvbGRlci5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUoZm9sZGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6LWE5rqQ6L6T5Ye655uu5b2V5b+F6aG75piv6aG555uuIGFzc2V0cyDkuIvnmoTlrZDmlofku7blpLnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NldERhdGFiYXNlVXJsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShmaWxlUGF0aCk7XHJcbiAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgY29uc3Qgb3V0c2lkZSA9IHBhdGggPT09ICcuLidcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uLycpXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLlxcXFwnKVxyXG4gICAgICAgIHx8IGlzQWJzb2x1dGUocGF0aCk7XHJcbiAgICBpZiAoIXBhdGggfHwgcGF0aCA9PT0gJy4nIHx8IG91dHNpZGUpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBgZGI6Ly9hc3NldHMvJHtwYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKX1gO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6kgRmlnbWEg5a+85YWl6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duLCBfaW5kZXggPSAwKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZycgPyBjdXJyZW50LnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBjdXJyZW50Rm9sZGVyICYmIGlzQWJzb2x1dGUoY3VycmVudEZvbGRlcilcclxuICAgICAgICA/IGN1cnJlbnRGb2xkZXJcclxuICAgICAgICA6IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGlicmFyeSA9IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShzZWxlY3RlZCk7XHJcbiAgICByZXR1cm4geyBmb2xkZXI6IGxpYnJhcnkucm9vdCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiB1bmlvbkZyYW1lKG5vZGVzOiBGaWdtYU5vZGVbXSk6IFJlY3Qge1xyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZXMubWFwKG5vZGVGcmFtZSkuZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIFJlY3QgPT4gQm9vbGVhbih2YWx1ZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgeCA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54KSk7XHJcbiAgICBjb25zdCB5ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkpKTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCkpO1xyXG4gICAgY29uc3QgYm90dG9tID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQpKTtcclxuICAgIHJldHVybiB7IHgsIHksIHdpZHRoOiByaWdodCAtIHgsIGhlaWdodDogYm90dG9tIC0geSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB7XHJcbiAgICBpZiAobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB1bmlvbkZyYW1lKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG59XHJcblxyXG5jb25zdCBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTiA9IDAuNTtcclxuXHJcbi8qKlxyXG4gKiBPbmx5IGV4cGFuZCByYXN0ZXJzIHdob3NlIHZpc2libGUgcGl4ZWxzIGVzY2FwZSB0aGUgZ2VvbWV0cmljIGZyYW1lLiBBXHJcbiAqIHJlbmRlciBmcmFtZSBjb250YWluZWQgaW5zaWRlIHRoZSBnZW9tZXRyeSBvZnRlbiByZXByZXNlbnRzIGludGVudGlvbmFsXHJcbiAqIHRyYW5zcGFyZW50IHBhZGRpbmcgYW5kIG11c3Qga2VlcCB0aGUgbGVnYWN5IGZpeGVkLWNhbnZhcyBwYXRoLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBnZW9tZXRyeSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IHJlbmRlciA9IG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHM7XHJcbiAgICBpZiAoIWdlb21ldHJ5IHx8ICFyZW5kZXIgfHwgcmVuZGVyLndpZHRoIDw9IDAgfHwgcmVuZGVyLmhlaWdodCA8PSAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGdlb21ldHJ5UmlnaHQgPSBnZW9tZXRyeS54ICsgZ2VvbWV0cnkud2lkdGg7XHJcbiAgICBjb25zdCBnZW9tZXRyeUJvdHRvbSA9IGdlb21ldHJ5LnkgKyBnZW9tZXRyeS5oZWlnaHQ7XHJcbiAgICBjb25zdCByZW5kZXJSaWdodCA9IHJlbmRlci54ICsgcmVuZGVyLndpZHRoO1xyXG4gICAgY29uc3QgcmVuZGVyQm90dG9tID0gcmVuZGVyLnkgKyByZW5kZXIuaGVpZ2h0O1xyXG4gICAgcmV0dXJuIHJlbmRlci54IDwgZ2VvbWV0cnkueCAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyLnkgPCBnZW9tZXRyeS55IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJSaWdodCA+IGdlb21ldHJ5UmlnaHQgKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlckJvdHRvbSA+IGdlb21ldHJ5Qm90dG9tICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICA/IHJlbmRlclxyXG4gICAgICAgIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3JuZXJSYWRpaShub2RlOiBGaWdtYU5vZGUpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XHJcbiAgICBpZiAobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaT8ubGVuZ3RoID09PSA0KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XHJcbiAgICB9XHJcbiAgICBjb25zdCByYWRpdXMgPSBub2RlLmNvcm5lclJhZGl1cyA/PyAwO1xyXG4gICAgcmV0dXJuIFtyYWRpdXMsIHJhZGl1cywgcmFkaXVzLCByYWRpdXNdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0RGVjaXNpb24obm9kZTogRmlnbWFOb2RlKTogRGVjaXNpb24ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IGluZmVyQWN0aW9uKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICBuaW5lU2xpY2U6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXHJcbiAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVjaXNpb25Gb3JOb2RlKG5vZGU6IEZpZ21hTm9kZSwgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4pOiBEZWNpc2lvbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAnZ2VuZXJhdGUnLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9uO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZGVjaXNpb25NYXAob3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdLCB0cmVlOiBUcmVlTm9kZUR0b1tdKTogTWFwPHN0cmluZywgRGVjaXNpb24+IHtcclxuICAgIGNvbnN0IGRlY2lzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBEZWNpc2lvbj4oKTtcclxuICAgIGNvbnN0IGZpZ21hU2xpY2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBhZGREZWZhdWx0cyA9IChub2RlczogVHJlZU5vZGVEdG9bXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkgZmlnbWFTbGljZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihub2RlLmFjdGlvbiksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICAgICAgICAgIH0sIEJvb2xlYW4obm9kZS5wYXRjaENhbmRpZGF0ZSkpKTtcclxuICAgICAgICAgICAgYWRkRGVmYXVsdHMobm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGFkZERlZmF1bHRzKHRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIG92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICAgICAgZGVjaXNpb25zLnNldChpdGVtLmlkLCBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAgICAgIGtpbmQ6IE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCkgPyBpdGVtLmtpbmQgOiAnYXV0bycsXHJcbiAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgICAgIH0sIGZpZ21hU2xpY2VzLmhhcyhpdGVtLmlkKSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9ucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuICAgIGluY2x1ZGVOb2RlTmFtZSA9IHRydWUsXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgcmV0dXJuIGRlY2lzaW9uPy5leHBsaWNpdCA9PT0gdHJ1ZVxyXG4gICAgICAgIHx8IChpbmNsdWRlTm9kZU5hbWUgJiYgQm9vbGVhbihkZWNpc2lvbj8ubmFtZSkpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG50eXBlIFN0b3JlZE5vZGVPdmVycmlkZXMgPSBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4+O1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpOiBQcm9taXNlPFN0b3JlZE5vZGVPdmVycmlkZXM+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFN0b3JlZE5vZGVPdmVycmlkZXMgOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2tJZCA9ICcnKTogSW1wb3J0T3ZlcnJpZGUgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBpdGVtID0gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRPdmVycmlkZT47XHJcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyAmJiBpdGVtLmlkID8gaXRlbS5pZCA6IGZhbGxiYWNrSWQ7XHJcbiAgICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgaXRlbS5raW5kID09PSAnc3RyaW5nJyAmJiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpXHJcbiAgICAgICAgPyBpdGVtLmtpbmQgYXMgTm9kZUtpbmRcclxuICAgICAgICA6ICdhdXRvJztcclxuICAgIGNvbnN0IGV4cGxpY2l0ID0gaXRlbS5leHBsaWNpdCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgaWYgKCFleHBsaWNpdCAmJiAhbmFtZSkgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkLFxyXG4gICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UgPT09IHRydWUsXHJcbiAgICAgICAgZXhwbGljaXQsXHJcbiAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG5vZGVPdmVycmlkZXNGb3IoZmlsZUtleTogc3RyaW5nKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSAoYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpKVtmaWxlS2V5XSA/PyB7fTtcclxuICAgIGNvbnN0IHJlc3VsdDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzdG9yZWQpKSB7XHJcbiAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUodmFsdWUsIGlkKTtcclxuICAgICAgICBpZiAoc2FmZSkgcmVzdWx0LnB1c2goc2FmZSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBpZiAodHlwZW9mIGZpbGVLZXkgIT09ICdzdHJpbmcnIHx8ICFmaWxlS2V5LnRyaW0oKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW1zID0gQXJyYXkuaXNBcnJheSh2YWx1ZXMpID8gdmFsdWVzIDogW107XHJcbiAgICBjb25zdCBzYWZlSXRlbXMgPSBpdGVtc1xyXG4gICAgICAgIC5tYXAoKGl0ZW0pID0+IHNhZmVOb2RlT3ZlcnJpZGUoaXRlbSkpXHJcbiAgICAgICAgLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgSW1wb3J0T3ZlcnJpZGUgPT4gQm9vbGVhbihpdGVtKSk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgKEFycmF5LmlzQXJyYXkoc2NvcGVWYWx1ZXMpID8gc2NvcGVWYWx1ZXMgOiBzYWZlSXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLmlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBCb29sZWFuKGlkKSksXHJcbiAgICApO1xyXG4gICAgaWYgKCFzY29wZUlkcy5zaXplKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJHlvZPliY3lr7zlhaXojIPlm7TjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjb3BlZEl0ZW1zID0gc2FmZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2NvcGVJZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICBmb3IgKGNvbnN0IGlkIG9mIHNjb3BlSWRzKSB7XHJcbiAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHNjb3BlZEl0ZW1zKSB7XHJcbiAgICAgICAgY3VycmVudFtpdGVtLmlkXSA9IGl0ZW07XHJcbiAgICB9XHJcbiAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSB7XHJcbiAgICAgICAgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2NvcGVkSXRlbXM7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKFxyXG4gICAgICAgICgpID0+IHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoZmlsZUtleSwgdmFsdWVzLCBzY29wZVZhbHVlcyksXHJcbiAgICApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcGF0Y2hOb2RlTmFtZXMoZmlsZUtleTogc3RyaW5nLCBwYXRjaGVzOiBNY3BOb2RlTmFtZVBhdGNoW10pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIWZpbGVLZXkudHJpbSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkOiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBwYXRjaCBvZiBwYXRjaGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIHBhdGNoLmlkID09PSAnc3RyaW5nJyA/IHBhdGNoLmlkLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgICAgICBpZiAoIWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBub2RlSWTjgIInKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBzYWZlTm9kZU92ZXJyaWRlKGN1cnJlbnRbaWRdLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZhbGxiYWNrID0gc2FmZU5vZGVPdmVycmlkZShwYXRjaC5mYWxsYmFjaywgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBuZXh0ID0gZXhpc3RpbmcgPyB7IC4uLmV4aXN0aW5nIH0gOiBmYWxsYmFjayA/IHsgLi4uZmFsbGJhY2sgfSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbmV4dCAmJiBwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIW5leHQpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOe8uuWwkeacieaViOm7mOiupOetlueVpeOAgmApO1xyXG4gICAgICAgICAgICBpZiAocGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIG5leHQubmFtZTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHBhdGNoLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnmoTlkI3np7Dml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIG5leHQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUobmV4dCwgaWQpO1xyXG4gICAgICAgICAgICBpZiAoc2FmZSkge1xyXG4gICAgICAgICAgICAgICAgY3VycmVudFtpZF0gPSBzYWZlO1xyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVkLnB1c2goc2FmZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgICAgICBlbHNlIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdGVkO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFubm90YXRlRG9jdW1lbnRQbGFuKHNlc3Npb246IERvY3VtZW50U2Vzc2lvbik6IERvY3VtZW50U2Vzc2lvbiB7XHJcbiAgICBjb25zdCBkZWZhdWx0cyA9IGRlY2lzaW9uTWFwKFtdLCBzZXNzaW9uLnRyZWUpO1xyXG4gICAgc2Vzc2lvbi50cmVlID0gYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4oXHJcbiAgICAgICAgc2Vzc2lvbi50cmVlLFxyXG4gICAgICAgIGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlZmF1bHRzKSxcclxuICAgICk7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdEFzc2V0UmVxdWVzdHMoXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIHByZXBhcmVkOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldCgpLFxyXG4pOiB7IHBuZzogRmlnbWFOb2RlW107IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdOyByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W107IGdyYWRpZW50czogRmlnbWFOb2RlW10gfSB7XHJcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCBncmFkaWVudHM6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGFuY2VzdG9yc1Zpc2libGU6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBpZiAocHJlcGFyZWQuaGFzKG5vZGUuaWQpKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZWZmZWN0aXZlbHlWaXNpYmxlID0gYW5jZXN0b3JzVmlzaWJsZSAmJiBub2RlLnZpc2libGUgIT09IGZhbHNlICYmIG5vZGUub3BhY2l0eSA+IDA7XHJcbiAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlKSB7XHJcbiAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChzb3VyY2UpIHtcclxuICAgICAgICAgICAgICAgIHRpbGVkLnB1c2goeyBub2RlLCBzb3VyY2UgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaGUgc2FtZSBwbGFpbiBJTUFHRSBzb3VyY2UgYW5kIGNlbnRlcmVkIGNyb3AgcGF0aCBzZXJ2ZSBib3RoXHJcbiAgICAgICAgICAgICAgICAvLyB2aXNpYmlsaXR5IHN0YXRlczsgd2hvbGUtbm9kZSBleHBvcnRzIGNhbiBiYWtlIGRpZmZlcmVudCBhbHBoYS5cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJhd0ltYWdlcy5wdXNoKHsgbm9kZSwgaW1hZ2VSZWYgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEFzc2V0cyhcclxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4gICAgcmV2aWV3OiBJbXBvcnRSZXZpZXdSZWNvcmRlcixcclxuKTogUHJvbWlzZTxBc3NldEJ1aWxkUmVzdWx0PiB7XHJcbiAgICBjb25zdCBoaWRkZW4gPSBoaWRkZW5MYXllcklkcyhzZXNzaW9uLnJvb3RzLCBpbXBvcnRTZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlKTtcclxuICAgIGNvbnN0IGFwcGx5VmlzaWJpbGl0eSA9IChub2RlOiBGaWdtYU5vZGUpOiB2b2lkID0+IHtcclxuICAgICAgICBpZiAoaGlkZGVuLmhhcyhub2RlLmlkKSkgZGVjaXNpb25zLnNldChub2RlLmlkLCB7XHJcbiAgICAgICAgICAgIC4uLihkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKSksIGFjdGlvbjogJ2lnbm9yZScsIG5pbmVTbGljZTogZmFsc2UsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFwcGx5VmlzaWJpbGl0eSk7XHJcbiAgICB9O1xyXG4gICAgc2Vzc2lvbi5yb290cy5mb3JFYWNoKGFwcGx5VmlzaWJpbGl0eSk7XHJcbiAgICBjb25zdCByZXNvbHZlZERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICByZXNvbHZlZERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHdyaXRlU3RhdGVzID0gbmV3IE1hcDxzdHJpbmcsIGJvb2xlYW4+KCk7XHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIsIGFzeW5jICh1cmwsIGV4aXN0ZWQpID0+IHtcclxuICAgICAgICBhd2FpdCByZXZpZXcuYmVmb3JlV3JpdGUodXJsLCBleGlzdGVkKTtcclxuICAgICAgICB3cml0ZVN0YXRlcy5zZXQodXJsLCBleGlzdGVkKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICAvLyBJbmRleCBleGlzdGluZyBuYW1lcyBvbmNlOyBuZXcgcmVzb3VyY2VzIGFyZSBzaGFyZWQgYnkgbmFtZSBiZWxvdy5cclxuICAgIGNvbnN0IG91dHB1dFBhdGggPSBqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnLCB3cml0ZXIuZm9sZGVyKTtcclxuICAgIGNvbnN0IG91dHB1dFJlc291cmNlcyA9IGV4aXN0c1N5bmMob3V0cHV0UGF0aCkgPyBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkob3V0cHV0UGF0aCkgOiBudWxsO1xyXG4gICAgYXdhaXQgb3V0cHV0UmVzb3VyY2VzPy5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgLy8gVGhlIHByb2plY3QgY29udHJhY3QgaXMgc2FtZSBuYW1lID0gc2FtZSByZXNvdXJjZS4gU2hhcmUgYWNyb3NzIHJlbmRlcixcclxuICAgIC8vIElNQUdFIGFuZCBncmFkaWVudCBwYXRocyBiZWZvcmUgZG93bmxvYWRpbmcgb3IgY29tcGFyaW5nIGFueSBwaXhlbHMuXHJcbiAgICBjb25zdCBzaGFyZWRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgY29uc3QgcmVzb3VyY2VLZXkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB3cml0ZXIuYnVpbGRVcmwobm9kZS5uYW1lLCAnJywgJ3BuZycsIGltcG9ydFNldHRpbmdzLnNjYWxlKVxyXG4gICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgIGNvbnN0IHdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBub3RlID0gKGFjdGlvbjogTm9uTnVsbGFibGU8SW1wb3J0UmV2aWV3WydkZWNpc2lvbnMnXT5bbnVtYmVyXVsnYWN0aW9uJ10sIG5hbWU6IHN0cmluZywgcmVhc29uOiBzdHJpbmcsIHVybD86IHN0cmluZykgPT5cclxuICAgICAgICByZXZpZXcubm90ZT8uKGFjdGlvbiwgbmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgY29uc3Qgbm90ZVdyaXRlID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMpID0+IG5vdGUod3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybCkgPyAndXBkYXRlZCcgOiAnY3JlYXRlZCcsXHJcbiAgICAgICAgYmFzZW5hbWUoYXNzZXQudXJsKSwgd3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybClcclxuICAgICAgICAgICAgPyAn5YaZ5YWl5ZCM5ZCN6L6T5Ye66LWE5rqQ77yM5L+d55WZ5Y6fIFVVSUQnXHJcbiAgICAgICAgICAgIDogJ+aMieWQjeensOWvvOWFpeS4gOS7vei1hOa6kO+8jOWQjOWQjeiKgueCueebtOaOpeWFseeUqCcsIGFzc2V0LnVybCk7XHJcbiAgICBjb25zdCBub2RlU291cmNlS2V5ID0gKG5vZGU6IEZpZ21hTm9kZSwgdmFyaWFudCA9ICdyYXN0ZXItdjInKSA9PlxyXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KFtzZXNzaW9uLmZpbGVLZXksIG5vZGUuaWQsIGltcG9ydFNldHRpbmdzLnNjYWxlLCB2YXJpYW50XSk7XHJcbiAgICBjb25zdCBncm91cFNvdXJjZUtleSA9IChhc3NldEtleTogc3RyaW5nKSA9PiBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCAndGlsZS12MicsIGFzc2V0S2V5XSk7XHJcbiAgICBjb25zdCBpbWFnZURldGFpbHMgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgbGV0IGxlYWYgPSBub2RlLCBpbm5lck9wYWNpdHkgPSAxO1xyXG4gICAgICAgIHdoaWxlIChsZWFmLmNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBsZWFmID0gbGVhZi5jaGlsZHJlblswXTtcclxuICAgICAgICAgICAgaW5uZXJPcGFjaXR5ICo9IGxlYWYub3BhY2l0eTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgbGVhZiwgaW5uZXJPcGFjaXR5IH07XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZE91dHB1dCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpID0+IHtcclxuICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgJiYgb3V0cHV0UmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgb3V0cHV0UmVzb3VyY2VzLmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdleGlzdGluZycgYXMgY29uc3QgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZExvY2FsID0gYXN5bmMgKG5hbWU6IHN0cmluZywgaW5jbHVkZU91dHB1dCA9IHRydWUpID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICAvLyBEaXJlY3Rvcnkgb3JkZXIsIGV4dGVuc2lvbiBwcmVmZXJlbmNlIGFuZCByb290LWJlZm9yZS1zdWJmb2xkZXJcclxuICAgICAgICAgICAgLy8gb3JkZXJpbmcgYXJlIHRoZSBleGlzdGluZyB1c2VyLWRlY2xhcmVkIG5hbWUgbWFwcGluZyBjb250cmFjdC5cclxuICAgICAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4geyAuLi5tYXRjaCwgc291cmNlOiAnbG9jYWwnIGFzIGNvbnN0IH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBpbmNsdWRlT3V0cHV0ID8gZmluZE91dHB1dChuYW1lKSA6IG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgcHJlcGFyZU1hc2sgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nIHx8IGRlY2lzaW9uLm5pbmVTbGljZSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpO1xyXG4gICAgICAgIGlmIChhbmFseXNpcyAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSkpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBraW5kOiAnc3ByaXRlJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgbGV0IHJlYXNvbiA9IGFuYWx5c2lzLnJlYXNvbjtcclxuICAgICAgICAgICAgaWYgKGFuYWx5c2lzLmNhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgeyBtYXNrLCB0aW50IH0gPSBhbmFseXNpcy5jYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChtYXNrLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybClcclxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShub2RlU291cmNlS2V5KG1hc2spLCB7IHRpbGVkOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICAgIC8vIFZlcmlmeSB0aGUgYnl0ZXMgb2YgdGhlIHJlZmVyZW5jZWQgYXNzZXQsIG5ldmVyIGFuIHVucmVsYXRlZFxyXG4gICAgICAgICAgICAgICAgLy8gc2FtZS1uYW1lIGZpbGUgZnJvbSBhIHByb2plY3QtZXh0ZXJuYWwgbGlicmFyeSBkaXJlY3RvcnkuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBieXRlcyA9IGxvY2FsVXJsICYmIGFzc2V0ID8gbWF0Y2ghLmNvbnRlbnRzXHJcbiAgICAgICAgICAgICAgICAgICAgOiBhc3NldCA/IGF3YWl0IHJlYWRGaWxlKGpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgYXNzZXQudXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSkpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYnl0ZXMgPyB2ZXJpZnlXaGl0ZUFscGhhUG5nKGJ5dGVzKSA6IHsgdmFsaWQ6IGZhbHNlLCByZWFzb246ICfmsqHmnInlj6/pqozor4HnmoTmnKzlnLDnmb3oibLlupXlm74nIH07XHJcbiAgICAgICAgICAgICAgICByZWFzb24gPSB2ZXJpZmllZC5yZWFzb247XHJcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQgJiYgdmVyaWZpZWQudmFsaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB0aW50ZWQgPSB7IC4uLmFzc2V0LCB0aW50IH07XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCB0aW50ZWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldmlldy5iaW5kKG5vZGUsIHRpbnRlZCwgbWF0Y2g/LnNvdXJjZSA/PyAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCd0aW50ZWQnLCBub2RlLm5hbWUsIGAke2FuYWx5c2lzLnJlYXNvbn3vvJske3ZlcmlmaWVkLnJlYXNvbn3vvJvmsr/nlKjljp8gVVVJRCDkuI7kuZ3lrqvlj4LmlbDvvIzpgI/mmI7luqbku4XorqHnrpfkuIDmrKFgLCBhc3NldC51cmwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgYCR7cmVhc29ufe+8m+S9v+eUqCBGaWdtYSDlrozmlbTokpnniYjlkIjmiJDvvIzkuI3kv67mlLnlhbHkuqvlupXlm75gKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykgcmV0dXJuO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikgYXdhaXQgcHJlcGFyZU1hc2soY2hpbGQpO1xyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgcm9vdCBvZiBzZXNzaW9uLnJvb3RzKSBhd2FpdCBwcmVwYXJlTWFzayhyb290KTtcclxuICAgIGNvbnN0IHByb3RlY3RlZERlc2NlbmRhbnQgPSAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiA9PiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY2hpbGREZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShjaGlsZCwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoY2hpbGREZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIEJvb2xlYW4oY2hpbGQuaXNNYXNrIHx8IGNoaWxkLmNoaWxkcmVuLnNvbWUoKHBhcnQpID0+IHBhcnQuaXNNYXNrKVxyXG4gICAgICAgICAgICB8fCBhc3NldHMuaGFzKGNoaWxkLmlkKSB8fCBjaGlsZERlY2lzaW9uLm5pbmVTbGljZSB8fCBpc05hbWVkU2xpY2VHcm91cChjaGlsZCkgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZCkpXHJcbiAgICAgICAgICAgIHx8IChjaGlsZERlY2lzaW9uLmFjdGlvbiAhPT0gJ3JlbmRlcicgJiYgcHJvdGVjdGVkRGVzY2VuZGFudChjaGlsZCkpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBwcm9tb3RlTG9jYWxQYXJlbnRzID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGlmIChhc3NldHMuaGFzKG5vZGUuaWQpIHx8IGFuYWx5emVNYXNrVGludChub2RlKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24ubmluZVNsaWNlXHJcbiAgICAgICAgICAgIC8vIFJlbmFtaW5nIHRoaXMgY29udGFpbmVyIGRvZXMgbm90IGNoYW5nZSByZXNvdXJjZSBtYXRjaGluZzsgb25seVxyXG4gICAgICAgICAgICAvLyBhIHN0cmF0ZWd5IG92ZXJyaWRlIG9uIGl0c2VsZiBvciBhbnkgb3ZlcnJpZGUgYmVsb3cgaXQgYmxvY2tzXHJcbiAgICAgICAgICAgIC8vIHByb21vdGlvbiBiZWNhdXNlIGRlc2NlbmRhbnRzIHdvdWxkIG90aGVyd2lzZSBkaXNhcHBlYXIuXHJcbiAgICAgICAgICAgICYmICFzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShub2RlLCBkZWNpc2lvbnMsIGZhbHNlKVxyXG4gICAgICAgICAgICAvLyBBIHNhbWUtbmFtZSBhbmNlc3RvciBpcyBub3QgcGVybWlzc2lvbiB0byBlcmFzZSBpbmRlcGVuZGVudCBzbGljZVxyXG4gICAgICAgICAgICAvLyByZXNvdXJjZXMgb3IgYSB2ZXJpZmllZC9mYWxsYmFjayBtYXNrIHJlcHJlc2VudGF0aW9uIGJlbG93IGl0LlxyXG4gICAgICAgICAgICAmJiAhcHJvdGVjdGVkRGVzY2VuZGFudChub2RlKVxyXG4gICAgICAgICAgICAvLyBBIGxvY2FsIHBhcmVudCByZXNvdXJjZSBjYW5ub3QgcmVwcmVzZW50IGluZGVwZW5kZW50bHkgaW5hY3RpdmVcclxuICAgICAgICAgICAgLy8gZGVzY2VuZGFudHMuIEtlZXAgdGhlIGhpZXJhcmNoeSB3aGVuZXZlciBzdWNoIGEgYm91bmRhcnkgZXhpc3RzLlxyXG4gICAgICAgICAgICAmJiAhaGFzSGlkZGVuRGVzY2VuZGFudChub2RlKSkge1xyXG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKG5vZGUuY2hpbGRyZW4ubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIH07XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChzZXNzaW9uLnJvb3RzLm1hcChwcm9tb3RlTG9jYWxQYXJlbnRzKSk7XHJcbiAgICBjb25zdCBmaW5hbERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICBmaW5hbERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IGFjdGl2ZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgYWN0aXZlQm91bmRhcnkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuO1xyXG4gICAgICAgIGFjdGl2ZUlkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgaWYgKGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKSB8fCBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgYXNzZXRzLmhhcyhub2RlLmlkKSkgcmV0dXJuO1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaChhY3RpdmVCb3VuZGFyeSk7XHJcbiAgICB9O1xyXG4gICAgc2Vzc2lvbi5yb290cy5mb3JFYWNoKGFjdGl2ZUJvdW5kYXJ5KTtcclxuICAgIGZvciAoY29uc3QgW2lkLCBwbGFuXSBvZiBwbGFucykge1xyXG4gICAgICAgIGlmICghYWN0aXZlSWRzLmhhcyhpZCkpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBzZXNzaW9uLm5vZGVCeUlkPy5nZXQoaWQpO1xyXG4gICAgICAgIGlmIChwbGFuLnJlYXNvbiA9PT0gJ3ByZWZpeC1tZXJnZScpIG5vdGUoJ21lcmdlZCcsIG5vZGU/Lm5hbWUgPz8gaWQsXHJcbiAgICAgICAgICAgIHBsYW4ud2FybmluZyA/PyAnaWNvbl8vaW1nXyDmnIDlpJblsYLotYTmupDovrnnlYzvvIzmjInlvZPliY3mmL7pmpDlkIjmiJDvvIzkv53nlZnniLboioLngrnlh6DkvZXkuI7pgI/mmI7luqYnKTtcclxuICAgICAgICBlbHNlIGlmIChwbGFuLndhcm5pbmcpIHtcclxuICAgICAgICAgICAgd2FybmluZ3MuYWRkKGAke25vZGU/Lm5hbWUgPz8gaWR977yaJHtwbGFuLndhcm5pbmd9YCk7XHJcbiAgICAgICAgICAgIG5vdGUoJ2ZhbGxiYWNrJywgbm9kZT8ubmFtZSA/PyBpZCwgcGxhbi53YXJuaW5nKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXF1ZXN0cyA9IGNvbGxlY3RBc3NldFJlcXVlc3RzKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucywgbmV3IFNldChhc3NldHMua2V5cygpKSk7XHJcbiAgICBjb25zdCB0b3RhbCA9IHJlcXVlc3RzLnBuZy5sZW5ndGggKyByZXF1ZXN0cy50aWxlZC5sZW5ndGhcclxuICAgICAgICArIHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggKyByZXF1ZXN0cy5ncmFkaWVudHMubGVuZ3RoO1xyXG4gICAgbGV0IGNvbXBsZXRlZCA9IDA7XHJcbiAgICBsZXQgYXBpUHJvbWlzZTogUHJvbWlzZTxGaWdtYUNsaWVudD4gfCBudWxsID0gbnVsbDtcclxuXHJcbiAgICBjb25zdCBnZXRBcGkgPSAoKSA9PiB7XHJcbiAgICAgICAgYXBpUHJvbWlzZSA/Pz0gZGlhZ25vc3RpY1Rhc2soJ+WHhuWkhyBGaWdtYSDlrqLmiLfnq68nLCB1bmRlZmluZWQsICgpID0+IGNsaWVudCgpKTtcclxuICAgICAgICByZXR1cm4gYXBpUHJvbWlzZTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgY29tcGxldGVBc3NldCA9IChcclxuICAgICAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScgfCAnZ2VuZXJhdGVkJyA9ICdmaWdtYScsXHJcbiAgICApID0+IHtcclxuICAgICAgICBhc3NldHMuc2V0KG5vZGUuaWQsIGFzc2V0KTtcclxuICAgICAgICByZXZpZXcuYmluZChub2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICBpZiAoc291cmNlID09PSAnbG9jYWwnIHx8IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJykgbm90ZSgncmV1c2VkJywgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2UgPT09ICdsb2NhbCcgPyAn55So5oi35oyH5a6a5pys5Zyw55uu5b2V55qE5ZCM5ZCN5pig5bCE77yM5L+d55WZ5Y6fIFNwcml0ZUZyYW1lIFVVSUQg5LiO5YiH54mH5Y+C5pWwJ1xyXG4gICAgICAgICAgICAgICAgOiAn5oyJ5bey5pyJ6LWE5rqQ5oiW5pys5om55ZCM5ZCN6LWE5rqQ5aSN55So5Y6fIFNwcml0ZUZyYW1l77yM5L+d55WZIFVVSUQg5LiO5Y6f5YiH54mH5Y+C5pWwJywgYXNzZXQudXJsKTtcclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBjb25zdCB2ZXJiID0gc291cmNlID09PSAnbG9jYWwnXHJcbiAgICAgICAgICAgID8gJ+WkjeeUqOacrOWcsOi1hOa6kCdcclxuICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdleGlzdGluZydcclxuICAgICAgICAgICAgICAgID8gJ+WkjeeUqOW3suaciei1hOa6kCdcclxuICAgICAgICAgICAgICAgIDogc291cmNlID09PSAnZ2VuZXJhdGVkJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gJ+eUn+aIkOa4kOWPmCdcclxuICAgICAgICAgICAgICAgIDogJ+WvvOWFpei1hOa6kCc7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGAke3ZlcmJ9ICR7Y29tcGxldGVkfS8ke3RvdGFsfSDCtyAke25vZGUubmFtZX1gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzVGlsZWQgPSBhc3luYyAoaXRlbXM6IFRpbGVkQXNzZXRSZXF1ZXN0W10pID0+IHtcclxuICAgICAgICBpZiAoIWl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcclxuICAgICAgICAgICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG4gICAgICAgICAgICBzb3VyY2VLZXk6IHN0cmluZztcclxuICAgICAgICAgICAgYXNzZXRLZXk6IHN0cmluZztcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFBlbmRpbmdUaWxlIGV4dGVuZHMgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbj86IFJhc3RlckltYWdlRXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBzb3VyY2VUeXBlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgICAgIHNvdXJjZVJlbmRlclNjYWxlPzogbnVtYmVyO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXF1ZXN0ZWRTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IGltcG9ydFNldHRpbmdzLnNjYWxlICogc291cmNlLnNjYWxlO1xyXG4gICAgICAgIGNvbnN0IHJlbmRlclNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgPyBjbGFtcEltYWdlU2NhbGUocmVxdWVzdGVkU2NhbGUoc291cmNlKSlcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBUaWxlR3JvdXA+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCB7IG5vZGUsIHNvdXJjZSB9IG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUtleSA9IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHNvdXJjZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgaWQ6IHNvdXJjZS5pZCxcclxuICAgICAgICAgICAgICAgIHBhaW50U2NhbGU6IHNvdXJjZS5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJlbmRlclNjYWxlOiByZW5kZXJTY2FsZShzb3VyY2UpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXRLZXkgPSB0aWxlZFJhc3RlcktleShzb3VyY2VLZXksIHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChub2RlLm5hbWUsIGFzc2V0S2V5LCAncG5nJylcclxuICAgICAgICAgICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKVxyXG4gICAgICAgICAgICAgICAgLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGUsIG5vZGVzOiBbXSwgc291cmNlLCBzb3VyY2VLZXksIGFzc2V0S2V5IH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyxcclxuICAgICAgICApID0+IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBncm91cGVkTm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoZ3JvdXBlZE5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBQZW5kaW5nVGlsZVtdID0gW107XHJcbiAgICAgICAgY29uc3QgbmFtZWRMb2NhbFRpbGVzID0gbmV3IE1hcDxzdHJpbmcsIHtcclxuICAgICAgICAgICAgbWF0Y2g6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgZmluZExvY2FsPj47XHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsO1xyXG4gICAgICAgIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBuYW1lS2V5ID0gcmVzb3VyY2VLZXkoZ3JvdXAubm9kZSk7XHJcbiAgICAgICAgICAgIGxldCBsb2NhbCA9IG5hbWVkTG9jYWxUaWxlcy5nZXQobmFtZUtleSk7XHJcbiAgICAgICAgICAgIGlmICghbG9jYWwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgZmluZExvY2FsKGdyb3VwLm5vZGUubmFtZSwgZmFsc2UpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsVXJsICYmICFhc3NldCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3mnKzlnLDotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzor7flhYjlnKggQ29jb3Mg5Lit5a6M5oiQ6LWE5rqQ5a+85YWl5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcclxuICAgICAgICAgICAgICAgIGxvY2FsID0geyBtYXRjaCwgYXNzZXQgfTtcclxuICAgICAgICAgICAgICAgIG5hbWVkTG9jYWxUaWxlcy5zZXQobmFtZUtleSwgbG9jYWwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbC5hc3NldCkge1xyXG4gICAgICAgICAgICAgICAgLy8gVGlsaW5nIGFuZCBpdHMgcGVyaW9kIGJlbG9uZyB0byB0aGlzIG5vZGUsIG5vdCB0aGUgc2hhcmVkXHJcbiAgICAgICAgICAgICAgICAvLyBTcHJpdGVGcmFtZSBNZXRhLiBLZWVwIHRoZSBvcmlnaW5hbCBVVUlEIGFuZCBwaXhlbHMgaW50YWN0LlxyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cC5ub2RlcywgeyAuLi5sb2NhbC5hc3NldCwgc2xpY2VkOiBmYWxzZSwgdGlsZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgdGlsZVNjYWxlOiByZXF1ZXN0ZWRTY2FsZShncm91cC5zb3VyY2UpIH0sICdsb2NhbCcpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGxvY2FsLm1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBBbiBleHRlcm5hbCBiaXRtYXAgaGFzIG5vIHByb2plY3QgVVVJRC4gSW1wb3J0IGl0IHRocm91Z2hcclxuICAgICAgICAgICAgICAgIC8vIHRoZSBleGlzdGluZyBnZW5lcmF0ZWQtdGlsZSBwYXRoLCB3aXRoIGl0cyB1bnNjYWxlZCBwaXhlbHMuXHJcbiAgICAgICAgICAgICAgICBwZW5kaW5nLnB1c2goeyAuLi5ncm91cCwgY29udGVudHM6IGxvY2FsLm1hdGNoLmNvbnRlbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogZGV0ZWN0SW1hZ2VFeHRlbnNpb24obG9jYWwubWF0Y2guY29udGVudHMpLCBzb3VyY2VUeXBlOiAnbG9jYWwnLCBzb3VyY2VSZW5kZXJTY2FsZTogMSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZ0Fzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBleGlzdGluZ0Fzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nRm9yU291cmNlKGdyb3VwU291cmNlS2V5KGdyb3VwLmFzc2V0S2V5KSwgeyB0aWxlZDogdHJ1ZSB9KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdBc3NldCkge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cC5ub2RlcywgcGl4ZWxTaXplZFRpbGVBc3NldChleGlzdGluZ0Fzc2V0KSwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgY2FjaGVkRXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRlbnNpb25zOiByZWFkb25seSBSYXN0ZXJJbWFnZUV4dGVuc2lvbltdID0gZ3JvdXAuc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IFsncG5nJ11cclxuICAgICAgICAgICAgICAgICAgICA6IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TO1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBleHRlbnNpb24gb2YgZXh0ZW5zaW9ucykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtncm91cC5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShncm91cC5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWNoZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBjYWNoZWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlZEV4dGVuc2lvbiA9IGV4dGVuc2lvbjtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAuLi5ncm91cCxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBjYWNoZWRFeHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VUeXBlOiBjb250ZW50cyA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuVXJscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5zQnlTY2FsZSA9IG5ldyBNYXA8bnVtYmVyLCBTZXQ8c3RyaW5nPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmVtb3RlSXRlbXMpIHtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc291cmNlLmtpbmQgIT09ICdzb3VyY2Utbm9kZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBpZHMgPSBwYXR0ZXJuc0J5U2NhbGUuZ2V0KHNjYWxlKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgaWRzLmFkZChpdGVtLnNvdXJjZS5pZCk7XHJcbiAgICAgICAgICAgIHBhdHRlcm5zQnlTY2FsZS5zZXQoc2NhbGUsIGlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgW3NjYWxlLCBpZHNdIG9mIHBhdHRlcm5zQnlTY2FsZSkge1xyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBBcnJheS5mcm9tKGlkcyksXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtpZCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyh1cmxzKSkge1xyXG4gICAgICAgICAgICAgICAgcGF0dGVyblVybHMuc2V0KGAke2lkfTpzY2FsZToke3NjYWxlfWAsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmVlZHNJbWFnZUZpbGxzID0gcmVtb3RlSXRlbXMuc29tZSgoaXRlbSkgPT4gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ2ltYWdlLXJlZicpO1xyXG4gICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBuZWVkc0ltYWdlRmlsbHNcclxuICAgICAgICAgICAgPyBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KVxyXG4gICAgICAgICAgICA6IHt9O1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWQgPSAodXJsOiBzdHJpbmcsIG5vZGVMYWJlbDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZCh1cmwsIG5vZGVMYWJlbCkpO1xyXG4gICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldCh1cmwsIHRhc2spO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB0YXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uID0gaXRlbS5leHRlbnNpb247XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IHBhdHRlcm5VcmxzLmdldChcclxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7aXRlbS5zb3VyY2UuaWR9OnNjYWxlOiR7cmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgICAgICAgIDogaW1hZ2VGaWxsVXJsc1tpdGVtLnNvdXJjZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGBQQVRURVJOIOa6kOiKgueCuSAke2l0ZW0uc291cmNlLmlkfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBgSU1BR0Ug5aGr5YWFICR7aXRlbS5zb3VyY2UuaWR9YDtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+myR7bGFiZWx977yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdwbmcnXHJcbiAgICAgICAgICAgICAgICAgICAgOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtpdGVtLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFleHRlbnNpb24pIHtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5bmz6ZO66LWE5rqQ5oyJ5a6e6ZmF5bC65a+455Sf5oiQJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcclxuICAgICAgICAgICAgbGV0IHJhc3RlcjogUmV0dXJuVHlwZTx0eXBlb2YgcmFzdGVyaXplVGlsZT47XHJcbiAgICAgICAgICAgIHRyeSB7IHJhc3RlciA9IHJhc3Rlcml6ZVRpbGUoY29udGVudHMsIHJlcXVlc3RlZFNjYWxlKGl0ZW0uc291cmNlKSwgaXRlbS5zb3VyY2VSZW5kZXJTY2FsZSA/PyByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSkpOyB9XHJcbiAgICAgICAgICAgIGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOW5s+mTuui1hOa6kOKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5peg5rOV5oyJ5a6e6ZmF5bC65a+455Sf5oiQ77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJhc3Rlci5yb3VuZGVkKSB3YXJuaW5ncy5hZGQoYOW5s+mTuui1hOa6kOKAnCR7aXRlbS5ub2RlLm5hbWV94oCd55qE5pi+56S65bC65a+45bey5Y+W5pW05Li6ICR7cmFzdGVyLndpZHRofcOXJHtyYXN0ZXIuaGVpZ2h0fSDlg4/ntKDvvIjmnIDlsI8gMe+8ie+8jOiKgueCuSBTY2FsZSDkv53mjIEgMeOAgmApO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChpdGVtLm5vZGUubmFtZSwgaXRlbS5hc3NldEtleSwgJ3BuZycpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUdyb3VwKFxyXG4gICAgICAgICAgICAgICAgaXRlbS5ub2RlcyxcclxuICAgICAgICAgICAgICAgIHBpeGVsU2l6ZWRUaWxlQXNzZXQoYXdhaXQgd3JpdGVyLnJlc29sdmUodXJsLCByYXN0ZXIuY29udGVudHMsIHsgc291cmNlS2V5OiBncm91cFNvdXJjZUtleShpdGVtLmFzc2V0S2V5KSwgdGlsZWQ6IHRydWUgfSkpLFxyXG4gICAgICAgICAgICAgICAgaXRlbS5zb3VyY2VUeXBlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB0cmFjZS5kb25lKHsgc291cmNlV2lkdGg6IHJhc3Rlci5zb3VyY2VXaWR0aCwgc291cmNlSGVpZ2h0OiByYXN0ZXIuc291cmNlSGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IHJhc3Rlci53aWR0aCwgaGVpZ2h0OiByYXN0ZXIuaGVpZ2h0LCB0aWxlU2NhbGU6IDEgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmVtb3RlID0gYXN5bmMgKG5vZGVzOiBGaWdtYU5vZGVbXSkgPT4ge1xyXG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgdXJsOiBzdHJpbmc7IG5vZGVzOiBGaWdtYU5vZGVbXSB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH1gLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc291cmNlS2V5KG5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IHVybCwgbm9kZXM6IFtdIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IEFycmF5PHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHVybDogc3RyaW5nO1xyXG4gICAgICAgICAgICBib3JkZXJzPzogeyBsZWZ0OiBudW1iZXI7IHJpZ2h0OiBudW1iZXI7IHRvcDogbnVtYmVyOyBib3R0b206IG51bWJlciB9O1xyXG4gICAgICAgICAgICBzbGljZUFuYWx5c2lzPzogU2xpY2VBbmFseXNpcztcclxuICAgICAgICAgICAgcmVuZGVyRnJhbWU/OiBSZWN0O1xyXG4gICAgICAgICAgICBrZXk6IENhY2hlRW50cnlLZXk7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBzb3VyY2U6ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJztcclxuICAgICAgICB9PiA9IFtdO1xyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyxcclxuICAgICAgICApID0+IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBncm91cGVkTm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoZ3JvdXBlZE5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgdXJsLCBub2RlczogZ3JvdXBlZE5vZGVzIH0gb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgLy8gQSBkZWNsYXJlZCBGaWdtYSBzbGljZSBvd25zIHRoaXMgc2FtZS1uYW1lIHJlc291cmNlIGV2ZW4gd2hlbiBhblxyXG4gICAgICAgICAgICAvLyBvcmRpbmFyeSBQTkcgd2FzIGVuY291bnRlcmVkIGZpcnN0LiBJTUFHRSBhbmQgZ3JhZGllbnQgc3RhZ2VzXHJcbiAgICAgICAgICAgIC8vIHJ1biBsYXRlciBhbmQgc2hhcmUgdGhpcyBzaW5nbGUgZ2VuZXJhdGVkIHJlc3VsdC5cclxuICAgICAgICAgICAgY29uc3Qgc2xpY2VkU291cmNlcyA9IGdyb3VwZWROb2Rlcy5mbGF0TWFwKChjYW5kaWRhdGUpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbkZvck5vZGUoY2FuZGlkYXRlLCBkZWNpc2lvbnMpLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBbXTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZVNsaWNlR3JpZChjYW5kaWRhdGUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGFuYWx5c2lzID8gW3sgbm9kZTogY2FuZGlkYXRlLCBhbmFseXNpcyB9XSA6IFtdO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWRTbGljZSA9IHNsaWNlZFNvdXJjZXNbMF07XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBzZWxlY3RlZFNsaWNlPy5ub2RlID8/IGdyb3VwZWROb2Rlc1swXTtcclxuICAgICAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgICAgICAgICAgY29uc3Qgc2xpY2VBbmFseXNpcyA9IHNlbGVjdGVkU2xpY2U/LmFuYWx5c2lzID8/IChkZWNpc2lvbi5uaW5lU2xpY2UgPyBhbmFseXplU2xpY2VHcmlkKG5vZGUpIDogbnVsbCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJldXNlQXNzZXQgPSAoYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYywgc291cmNlOiAnbG9jYWwnIHwgJ2V4aXN0aW5nJykgPT4ge1xyXG4gICAgICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgYXNzZXQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhYXNzZXQuc2xpY2VkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5bey55u05o6l5byV55So5ZCM5ZCN6LWE5rqQ77yM5L2G6K+lIFNwcml0ZUZyYW1lIOacqumFjee9ruS5neWuq+i+uei3ne+8jOaaguaMieaZrumAmiBTcHJpdGUg5pi+56S677yb6K+35Zyo5Y6f6LWE5rqQ5Lit6K6+572u6L656Led77yaJHthc3NldC51cmx9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGNvbnN0IHNoYXJlZCA9IHNsaWNlQW5hbHlzaXMgPyB1bmRlZmluZWQgOiBzaGFyZWRBc3NldHMuZ2V0KHJlc291cmNlS2V5KG5vZGUpKTtcclxuICAgICAgICAgICAgaWYgKHNoYXJlZCkge1xyXG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChzaGFyZWQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbG9jYWxNYXRjaCA9IGFuYWx5emVNYXNrVGludChub2RlKSAmJiAhc2xpY2VBbmFseXNpcyA/IG51bGwgOiBhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgICAgIC8vIEFuIGV4cGxpY2l0bHkgZGVzaWduYXRlZCBsb2NhbCBTcHJpdGVGcmFtZSBvd25zIGl0cyBwaXhlbHMgYW5kXHJcbiAgICAgICAgICAgIC8vIGluc2V0cy4gUmV1c2UgaXQgcmVhZC1vbmx5LCBldmVuIHdoZW4gRmlnbWEgZGVmaW5lcyBhIHNsaWNlIG9yXHJcbiAgICAgICAgICAgIC8vIHJlZnJlc2ggaXMgcmVxdWVzdGVkOyBzb3VyY2UgaW5zZXRzIGNhbm5vdCBiZSBhcHBsaWVkIHRvIGFuXHJcbiAgICAgICAgICAgIC8vIHVua25vd24gb3IgYWxyZWFkeS1jb21wYWN0ZWQgbG9jYWwgY2FudmFzLlxyXG4gICAgICAgICAgICBjb25zdCBsb2NhbFVybCA9IGxvY2FsTWF0Y2hcclxuICAgICAgICAgICAgICAgID8gYXNzZXREYXRhYmFzZVVybChsb2NhbE1hdGNoLnBhdGgpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsQXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxBc3NldCkge1xyXG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChsb2NhbEFzc2V0LCBsb2NhbE1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGxvY2FsVXJsKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlubborr7nva7kuLogU3ByaXRlRnJhbWUg5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBuYW1lZE91dHB1dCA9ICFzbGljZUFuYWx5c2lzICYmICFsb2NhbE1hdGNoICYmICFhbmFseXplTWFza1RpbnQobm9kZSkgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVkQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lZEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQobmFtZWRBc3NldCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoc2VsZWN0ZWRTbGljZSAmJiAhbG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc2hhcGUgPSAoZW50cnk6IHR5cGVvZiBzZWxlY3RlZFNsaWNlKSA9PiBKU09OLnN0cmluZ2lmeSh7IG1vZGU6IGVudHJ5LmFuYWx5c2lzLm1vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyczogZW50cnkuYW5hbHlzaXMuYm9yZGVycywgZnJhbWU6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCAmJiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBlbnRyeS5ub2RlLmFic29sdXRlQm91bmRpbmdCb3gud2lkdGgsIGhlaWdodDogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9IH0pO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNsaWNlZFNvdXJjZXMuc2xpY2UoMSkuc29tZSgoZW50cnkpID0+IHNoYXBlKGVudHJ5KSAhPT0gc2hhcGUoc2VsZWN0ZWRTbGljZSkpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVhc29uID0gYOWQjOWQjeS4iS/kuZ3lrqvlrprkuYnkuI3lkIzvvIzmsr/nlKjpppbkuKrmnInmlYggRmlnbWEg5YiH54mH4oCcJHtub2RlLm5hbWV94oCd55qE5Y6f5aeL55S75biD5LiO6L656Led77yM5LuF55Sf5oiQ5LiA5Lu96LWE5rqQYDtcclxuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQocmVhc29uKTtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCdtZXJnZWQnLCBub2RlLm5hbWUsIHJlYXNvbiwgdXJsKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIG5vdGUoJ21lcmdlZCcsIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAnRmlnbWEg5LiJL+S5neWuq+WumuS5ieS8mOWFiO+8muS9v+eUqCBGaWdtYSDljp/lp4vnlLvluIPkuI7ovrnot53nlJ/miJDovpPlh7rotYTmupDvvIzkuI3msr/nlKjmnKrmjIflrprovpPlh7rotYTmupDnmoTml6fovrnot50nLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIXNsaWNlQW5hbHlzaXMpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneaXoOazleiuoeeul+i/nue7reWIh+eJh+i+ueeVjO+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWlYCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYm9yZGVycyA9IHNsaWNlQW5hbHlzaXM/LmJvcmRlcnM7XHJcbiAgICAgICAgICAgIC8vIE5ldyBzbGljZWQgYXNzZXRzIHJldGFpbiB0aGVpciBleGFjdCBnZW9tZXRyaWMgY2FudmFzIGJlY2F1c2VcclxuICAgICAgICAgICAgLy8gdGhlaXIgZ2VuZXJhdGVkIGJvcmRlcnMgdXNlIHRoYXQgY29vcmRpbmF0ZSBzcGFjZS5cclxuICAgICAgICAgICAgY29uc3QgcmVuZGVyRnJhbWUgPSBib3JkZXJzID8gdW5kZWZpbmVkIDogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5OiBDYWNoZUVudHJ5S2V5ID0ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdmFyaWFudDogcmVuZGVyRnJhbWUgPyAndmlzdWFsLW92ZXJmbG93LXYxJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZCA9IGxvY2FsTWF0Y2ggfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGNhY2hlLnJlYWQoa2V5KTtcclxuICAgICAgICAgICAgaWYgKHNsaWNlQW5hbHlzaXMgJiYgY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCE7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpc0Z1bGxDYW52YXMgPSBpc1BuZyhjYWNoZWQpICYmIGNhY2hlZC5sZW5ndGggPj0gMjRcclxuICAgICAgICAgICAgICAgICAgICAmJiBjYWNoZWQudG9TdHJpbmcoJ2FzY2lpJywgMTIsIDE2KSA9PT0gJ0lIRFInXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMoY2FjaGVkLnJlYWRVSW50MzJCRSgxNikgLSBmcmFtZS53aWR0aCAqIGltcG9ydFNldHRpbmdzLnNjYWxlKSA8PSAxXHJcbiAgICAgICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMoY2FjaGVkLnJlYWRVSW50MzJCRSgyMCkgLSBmcmFtZS5oZWlnaHQgKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSkgPD0gMTtcclxuICAgICAgICAgICAgICAgIGlmICghaXNGdWxsQ2FudmFzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY2FjaGVkID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgJ+e8k+WtmOS4jeaYryBGaWdtYSDlrozmlbTnlLvluIPvvIzph43mlrDlr7zlh7rljp/lp4sgUE5HIOWQjuWGjeW6lOeUqOS4iS/kuZ3lrqvovrnot50nLCB1cmwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgbm9kZXM6IGdyb3VwZWROb2RlcyxcclxuICAgICAgICAgICAgICAgIHVybDogbG9jYWxNYXRjaCAmJiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbE1hdGNoLmNvbnRlbnRzKSA9PT0gJ2pwZydcclxuICAgICAgICAgICAgICAgICAgICA/IHVybC5yZXBsYWNlKC9cXC5wbmckL2ksICcuanBnJykgOiB1cmwsXHJcbiAgICAgICAgICAgICAgICBib3JkZXJzLFxyXG4gICAgICAgICAgICAgICAgc2xpY2VBbmFseXNpczogc2xpY2VBbmFseXNpcyA/PyB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICByZW5kZXJGcmFtZTogbG9jYWxNYXRjaCA/IHVuZGVmaW5lZCA6IHJlbmRlckZyYW1lLFxyXG4gICAgICAgICAgICAgICAga2V5LFxyXG4gICAgICAgICAgICAgICAgY29udGVudHM6IGxvY2FsTWF0Y2g/LmNvbnRlbnRzID8/IGNhY2hlZCxcclxuICAgICAgICAgICAgICAgIHNvdXJjZTogbG9jYWxNYXRjaCA/ICdsb2NhbCcgOiBjYWNoZWQgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHVybHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+ID0ge307XHJcbiAgICAgICAgY29uc3QgcmVtb3RlSXRlbXMgPSBwZW5kaW5nLmZpbHRlcigoaXRlbSkgPT4gIWl0ZW0uY29udGVudHMpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdXNlQWJzb2x1dGVCb3VuZHMgb2YgW3RydWUsIGZhbHNlXSkge1xyXG4gICAgICAgICAgICBjb25zdCBiYXRjaCA9IHJlbW90ZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gKFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMgPyAhaXRlbS5yZW5kZXJGcmFtZSA6IEJvb2xlYW4oaXRlbS5yZW5kZXJGcmFtZSlcclxuICAgICAgICAgICAgKSk7XHJcbiAgICAgICAgICAgIGlmICghYmF0Y2gubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHVybHMsIGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgYmF0Y2gubWFwKChpdGVtKSA9PiBpdGVtLm5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyxcclxuICAgICAgICAgICAgICAgIE9iamVjdC5mcm9tRW50cmllcyhiYXRjaC5tYXAoKGl0ZW0pID0+IFtpdGVtLm5vZGUuaWQsIGl0ZW0ubm9kZS5uYW1lXSkpLFxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSB1cmxzW2l0ZW0ubm9kZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95riy5p+T6IqC54K577yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5kb3dubG9hZChyZW1vdGVVcmwsIGAke2l0ZW0ubm9kZS5uYW1lfSAoJHtpdGVtLm5vZGUuaWR9KWApO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoaXRlbS5rZXksIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBsZXQgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYztcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc2xpY2VBbmFseXNpcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+S4iS/kuZ3lrqvotYTmupDmnIDlsI/ljJYnLCB7IG5vZGU6IGl0ZW0ubm9kZS5uYW1lIH0pO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgd3JpdGVTbGljZWRQbmcod3JpdGVyLCBpdGVtLnVybCwgY29udGVudHMsIGl0ZW0ubm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNsaWNlQW5hbHlzaXMsIGltcG9ydFNldHRpbmdzLnNjYWxlKTtcclxuICAgICAgICAgICAgICAgIGFzc2V0ID0gcmVzdWx0LmFzc2V0O1xyXG4gICAgICAgICAgICAgICAgdHJhY2UuZG9uZShyZXN1bHQub3B0aW1pemF0aW9uKTtcclxuICAgICAgICAgICAgICAgIG5vdGUoYXNzZXQuc2xpY2VGYWxsYmFjayA/ICdmYWxsYmFjaycgOiAnbWVyZ2VkJywgaXRlbS5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgYOS4iS/kuZ3lrqvvvJoke3Jlc3VsdC5vcHRpbWl6YXRpb24ucmVhc29uID8/IHJlc3VsdC5vcHRpbWl6YXRpb24uc3RhdHVzfWAsIGFzc2V0LnVybCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShpdGVtLm5vZGUpLCBhc3NldCk7XHJcbiAgICAgICAgICAgIGlmIChhc3NldC5zbGljZUZhbGxiYWNrKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke2l0ZW0ubm9kZS5uYW1lfeKAneWIh+eJh+iuvue9ruWksei0pe+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWl77yaJHthc3NldC5zbGljZUZhbGxiYWNrfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgaXRlbS5ub2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChcclxuICAgICAgICAgICAgICAgICAgICBncm91cGVkTm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnJlbmRlckZyYW1lXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8geyAuLi5hc3NldCwgcmVuZGVyRnJhbWU6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUoZ3JvdXBlZE5vZGUpID8/IGl0ZW0ucmVuZGVyRnJhbWUgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGFzc2V0LFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1Jhd0ltYWdlcyA9IGFzeW5jIChpdGVtczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgbm9kZTogRmlnbWFOb2RlOyBub2RlczogRmlnbWFOb2RlW107IGltYWdlUmVmOiBzdHJpbmcgfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzb3VyY2VLZXkoaXRlbS5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlOiBpdGVtLm5vZGUsIG5vZGVzOiBbXSwgaW1hZ2VSZWY6IGl0ZW0uaW1hZ2VSZWYgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGltYWdlRmlsbFVybHNQcm9taXNlOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+PiB8IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlSW1hZ2VzID0gKG5vZGVzOiBGaWdtYU5vZGVbXSwgYmFzZTogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnIHwgJ2NhY2hlJyB8ICdmaWdtYScpID0+IHtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2Rlc1swXSksIGJhc2UpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgaW5uZXJPcGFjaXR5IH0gPSBpbWFnZURldGFpbHMobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGlubmVyT3BhY2l0eSA8IDEgPyB7IC4uLmJhc2UsIHRpbnQ6IHsgcjogMSwgZzogMSwgYjogMSwgYTogaW5uZXJPcGFjaXR5IH0gfSA6IGJhc2U7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBjb25zdCBzaGFyZWQgPSBzaGFyZWRBc3NldHMuZ2V0KHJlc291cmNlS2V5KGdyb3VwLm5vZGUpKTtcclxuICAgICAgICAgICAgaWYgKHNoYXJlZCkge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB7IGxlYWYgfSA9IGltYWdlRGV0YWlscyhncm91cC5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwoZ3JvdXAubm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGxvY2FsVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmICghbG9jYWxBc3NldCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3mnKzlnLDotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGxvY2FsQXNzZXQsIG1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbWF0Y2ggPyBhd2FpdCBmaW5kT3V0cHV0KGdyb3VwLm5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IG5hbWVkT3V0cHV0ID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChuYW1lZE91dHB1dCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBsZXQgc291cmNlOiAnY2FjaGUnIHwgJ2ZpZ21hJyA9ICdjYWNoZSc7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogY2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGNhbmRpZGF0ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGlmICghaW1hZ2VGaWxsVXJsc1Byb21pc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICBpbWFnZUZpbGxVcmxzUHJvbWlzZSA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gYXdhaXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpbWFnZUZpbGxVcmxzW2dyb3VwLmltYWdlUmVmXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5DkvpvpmpDol4/lm77niYfloavlhYXvvJoke2dyb3VwLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldChyZW1vdGVVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7Z3JvdXAubm9kZS5uYW1lfSAoJHtncm91cC5ub2RlLmlkfSlgKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldChyZW1vdGVVcmwsIHRhc2spO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCB0YXNrO1xyXG4gICAgICAgICAgICAgICAgc291cmNlID0gJ2ZpZ21hJztcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBleHRlbnNpb24gPz89IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgY29uc3QgZmlsbCA9IGxlYWYuZmlsbHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIHBhaW50LnR5cGUgPT09ICdJTUFHRScpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShncm91cC5ub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgcmFzdGVyID0gcmFzdGVyaXplSW1hZ2VGaWxsKGNvbnRlbnRzLCBmaWxsPy5zY2FsZU1vZGU/LnRvVXBwZXJDYXNlKCkgPT09ICdGSVQnID8gJ0ZJVCcgOiAnRklMTCcsXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCwgZnJhbWUuaGVpZ2h0LCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIGdyb3VwLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06aW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkID0gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcmFzdGVyKTtcclxuICAgICAgICAgICAgbm90ZVdyaXRlKHJlc29sdmVkKTtcclxuICAgICAgICAgICAgaWYgKGdyb3VwLm5vZGUuY2hpbGRyZW4ubGVuZ3RoKSBub3RlKCdtZXJnZWQnLCBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAn5pmu6YCaIElNQUdFIOWcqOmakOiXj+WSjOaYvuekuueKtuaAgeS9v+eUqOebuOWQjOS4reW/g+ijgeWIhy/pgILphY3vvJvmupDlm77nvJPlrZjkv53nlZnljp/lp4vlg4/ntKDvvIzoioLngrnpgI/mmI7luqbljZXni6zlupTnlKgnLCByZXNvbHZlZC51cmwpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgcmVzb2x2ZWQsIHNvdXJjZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5bmz6ZO66LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMudGlsZWQubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NUaWxlZChyZXF1ZXN0cy50aWxlZCkpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkhyBQTkcg6LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMucG5nLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzUmVtb3RlKHJlcXVlc3RzLnBuZykpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WOn+WniyBJTUFHRSDloavlhYXotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XHJcblxyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IHNoYXJlZCA9IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkobm9kZSkpO1xyXG4gICAgICAgIGlmIChzaGFyZWQpIHtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBzaGFyZWQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmFtZWQgPSBhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSk7XHJcbiAgICAgICAgY29uc3QgbmFtZWRVcmwgPSBuYW1lZCA/IGFzc2V0RGF0YWJhc2VVcmwobmFtZWQucGF0aCkgOiBudWxsO1xyXG4gICAgICAgIGlmIChuYW1lZFVybCkge1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhuYW1lZFVybCk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZFVybH1gKTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgZXhpc3RpbmcpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGV4aXN0aW5nLCBuYW1lZCEuc291cmNlKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIW5hbWVkID8gYXdhaXQgZmluZE91dHB1dChub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgZXhpc3RpbmcpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXHJcbiAgICAgICAgICAgID8gZ3JhZGllbnRQbmcoXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGZpbGwsXHJcbiAgICAgICAgICAgICAgICBjb3JuZXJSYWRpaShub2RlKSxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAocG5nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIHBuZyk7XHJcbiAgICAgICAgICAgIG5vdGVXcml0ZShhc3NldCk7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGFzc2V0KTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgJ2dlbmVyYXRlZCcpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDnlJ/miJDmuJDlj5ggJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIHdyaXRlci5ldmVudHMpIG5vdGUoZXZlbnQuYWN0aW9uLCBiYXNlbmFtZShldmVudC51cmwpLCBldmVudC5yZWFzb24sIGV2ZW50LnVybCk7XHJcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmYW1pbHksIHVybF0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkpIHtcclxuICAgICAgICBpZiAoIXVybCkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IGF3YWl0IHJlc29sdmVBc3NldFV1aWQodXJsKTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXN1bHQuc2V0KGZhbWlseSwgdXVpZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBuYXRpdmVNb2RlID0gaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSk7XHJcbiAgICBpZiAobmF0aXZlTW9kZSkge1xyXG4gICAgICAgIHJldHVybiBuYXRpdmVNb2RlO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUubGF5b3V0TW9kZSAmJiBub2RlLmxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2RlLmNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBSZWN0ID0+IEJvb2xlYW4oZnJhbWUpKTtcclxuICAgIGlmICghZnJhbWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAnVkVSVElDQUwnO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2VudGVyc1ggPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoIC8gMik7XHJcbiAgICBjb25zdCBjZW50ZXJzWSA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0IC8gMik7XHJcbiAgICBjb25zdCBzcHJlYWRYID0gTWF0aC5tYXgoLi4uY2VudGVyc1gpIC0gTWF0aC5taW4oLi4uY2VudGVyc1gpO1xyXG4gICAgY29uc3Qgc3ByZWFkWSA9IE1hdGgubWF4KC4uLmNlbnRlcnNZKSAtIE1hdGgubWluKC4uLmNlbnRlcnNZKTtcclxuICAgIGlmIChzcHJlYWRZIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ0hPUklaT05UQUwnO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwcmVhZFggPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnVkVSVElDQUwnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdHUklEJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VTcGVjKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcGFyZW50RnJhbWU6IFJlY3QgfCB1bmRlZmluZWQsXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIHBsYW5zOiBSZWFkb25seU1hcDxzdHJpbmcsIE5vZGVJbXBvcnRQbGFuPixcclxuICAgIG5vZGVCeUlkOiBSZWFkb25seU1hcDxzdHJpbmcsIEZpZ21hTm9kZT4sXHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4sXHJcbiAgICBmb250czogTWFwPHN0cmluZywgc3RyaW5nPixcclxuICAgIGlzUm9vdCA9IGZhbHNlLFxyXG4gICAgcGFyZW50V29ybGRSb3RhdGlvbiA9IDAsXHJcbiAgICBzeW5jPzogeyBmaWxlS2V5OiBzdHJpbmcgfSxcclxuKTogU2NlbmVOb2RlU3BlYyB8IG51bGwge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShub2RlKTtcclxuICAgIGNvbnN0IHBsYW4gPSBwbGFucy5nZXQobm9kZS5pZCk7XHJcbiAgICBjb25zdCBmb2xkID0gcGxhbj8uZm9sZDtcclxuICAgIGNvbnN0IGZvbGRTb3VyY2UgPSBmb2xkID8gbm9kZUJ5SWQuZ2V0KGZvbGQuc291cmNlTm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IHRleHRTb3VyY2UgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHZpc3VhbFNvdXJjZSA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHJlc29sdmVkS2luZCA9IGRlY2lzaW9uLmtpbmQgPT09ICdhdXRvJyA/IGluZmVyS2luZChub2RlKSA6IGRlY2lzaW9uLmtpbmQ7XHJcbiAgICBjb25zdCBwbGFubmVkS2luZCA9IHBsYW4/LmtpbmQgPz8gcmVzb2x2ZWRLaW5kO1xyXG4gICAgY29uc3QgYml0bWFwVGVybWluYWwgPSBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJztcclxuICAgIGNvbnN0IHRlcm1pbmFsID0gYml0bWFwVGVybWluYWwgfHwgaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24ocGxhbm5lZEtpbmQsIGRlY2lzaW9uLmFjdGlvbiwgZGVjaXNpb24ubmluZVNsaWNlKTtcclxuICAgIGNvbnN0IHNwcml0ZVNvdXJjZUlkID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCdcclxuICAgICAgICA/IGZvbGQuc291cmNlTm9kZUlkXHJcbiAgICAgICAgOiBub2RlLmlkO1xyXG4gICAgY29uc3Qgc3ByaXRlQXNzZXQgPSBhc3NldHMuZ2V0KHNwcml0ZVNvdXJjZUlkKTtcclxuICAgIGNvbnN0IGFic29yYmVkRGlyZWN0SWRzID0gbmV3IFNldChmb2xkID8gW2ZvbGQuc291cmNlTm9kZUlkXSA6IFtdKTtcclxuICAgIGNvbnN0IGZ1bGxGb2xkID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS1pbWFnZScgfHwgZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JztcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBwYXJlbnRXb3JsZFJvdGF0aW9uICsgbm9kZS5yb3RhdGlvbjtcclxuICAgIC8vIOaKmOWPoOWIsOacrOiKgueCueeahOWtkOWxgiBpZCDkuI4gYWxpYXNGaWdtYUlkcyDkuIDoh7TvvJvmoIforrDlj6rorrDlvZXogZrlkIjouqvku73vvIxcclxuICAgIC8vIOS4jeivleWbvuS4uuaKmOWPoOWtkOWxguWNleeLrOW7uuiKgueCueOAglxyXG4gICAgY29uc3Qgc3luY01hcmtlcjogU3luY01hcmtlclNwZWMgfCB1bmRlZmluZWQgPSBzeW5jXHJcbiAgICAgICAgPyBjcmVhdGVTeW5jTWFya2VyKHtcclxuICAgICAgICAgICAgZmlsZUtleTogc3luYy5maWxlS2V5LFxyXG4gICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICBhbGlhc05vZGVJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyA/PyBbXSxcclxuICAgICAgICB9KVxyXG4gICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYUlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IGRlY2lzaW9uLm5hbWUgPz8gbm9kZS5uYW1lLFxyXG4gICAgICAgIGZpZ21hVHlwZTogdmlzdWFsU291cmNlLnR5cGUsXHJcbiAgICAgICAgYWN0aW9uOiBkZWNpc2lvbi5hY3Rpb24sXHJcbiAgICAgICAga2luZDogZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBmcmFtZSxcclxuICAgICAgICBwYXJlbnRGcmFtZSxcclxuICAgICAgICBpbnRyaW5zaWNTaXplOiBub2RlLnNpemUsXHJcbiAgICAgICAgaXNSb290LFxyXG4gICAgICAgIHJvdGF0aW9uOiBub2RlLnJvdGF0aW9uLFxyXG4gICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgb3BhY2l0eTogZm9sZFNvdXJjZSAmJiBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IG5vZGUub3BhY2l0eSAqIGZvbGRTb3VyY2Uub3BhY2l0eVxyXG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCxcclxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcclxuICAgICAgICBmaWxsczogdGV4dFNvdXJjZS5maWxscyxcclxuICAgICAgICBzdHJva2VzOiB0ZXh0U291cmNlLnN0cm9rZXMsXHJcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0ZXh0U291cmNlLmNoYXJhY3RlcnMsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0U291cmNlLnN0eWxlLFxyXG4gICAgICAgIGxheW91dDoge1xyXG4gICAgICAgICAgICBtb2RlOiBlZmZlY3RpdmVLaW5kID09PSAnbGF5b3V0JyB8fCBlZmZlY3RpdmVLaW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgICAgID8gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgc291cmNlTW9kZTogbm9kZS5sYXlvdXRNb2RlLFxyXG4gICAgICAgICAgICB3cmFwOiBub2RlLmxheW91dFdyYXAsXHJcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIGNvdW50ZXJBbGlnbjogbm9kZS5jb3VudGVyQXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIHByaW1hcnlTaXppbmc6IG5vZGUucHJpbWFyeUF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgaXRlbVNwYWNpbmc6IG5vZGUuaXRlbVNwYWNpbmcsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTcGFjaW5nOiBub2RlLmNvdW50ZXJBeGlzU3BhY2luZyxcclxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdSaWdodDogbm9kZS5wYWRkaW5nUmlnaHQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdUb3A6IG5vZGUucGFkZGluZ1RvcCxcclxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb3ZlcmZsb3dEaXJlY3Rpb246IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24sXHJcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXHJcbiAgICAgICAgcmVsYXRpdmVUcmFuc2Zvcm06IG5vZGUucmVsYXRpdmVUcmFuc2Zvcm0sXHJcbiAgICAgICAgc3ByaXRlOiBzcHJpdGVBc3NldCxcclxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICBmbGF0dGVuQm91bmRhcnk6IGJpdG1hcFRlcm1pbmFsIHx8IGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gdHJ1ZVxyXG4gICAgICAgICAgICA6IGZvbGQ/LmtpbmQgPT09ICdiYWNrZ3JvdW5kJ1xyXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgcGxhblJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgIHN5bmNNYXJrZXIsXHJcbiAgICAgICAgY2hpbGRyZW46IHRlcm1pbmFsXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBub2RlLmNoaWxkcmVuXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCkgPT4gIWFic29yYmVkRGlyZWN0SWRzLmhhcyhjaGlsZC5pZCkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChjaGlsZCkgPT4gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQsXHJcbiAgICAgICAgICAgICAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcclxuICAgICAgICAgICAgICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHN5bmMsXHJcbiAgICAgICAgICAgICAgICApKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpOiBjaGlsZCBpcyBTY2VuZU5vZGVTcGVjID0+IGNoaWxkICE9PSBudWxsKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVNYXBzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2Nvc0ZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gRWRpdG9yLlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXHJcbiAgICAgICAgPyBnZW5lcmF0ZWRcclxuICAgICAgICA6IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnYmFzZTY0JykucmVwbGFjZSgvPSskL2csICcnKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJBc3NldCh1cmxPclV1aWQ6IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtaW5mbycsXHJcbiAgICAgICAgdXJsT3JVdWlkLFxyXG4gICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRQcmVmYWJBc3NldChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGluZm8uaW52YWxpZCB8fCBpbmZvLmltcG9ydGVkICE9PSB0cnVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLmltcG9ydGVyICE9PSAncHJlZmFiJyB8fCBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInIHx8IGluZm8uaXNEaXJlY3RvcnkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8ucmVhZG9ubHkgfHwgaW5mby5yZWRpcmVjdCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZC51dWlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnVybCAmJiBpbmZvLnVybCAhPT0gZXhwZWN0ZWQudXJsKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yUHJlZmFiQXNzZXQodXJsOiBzdHJpbmcsIGV4cGVjdGVkVXVpZD86IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbmZvPy5pbXBvcnRlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOWcqOWvvOWFpeacn+mXtOWPkeeUn+WPmOWMlu+8miR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIFByZWZhYiDotYTmupDlsLHnu6rotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJNZXRhKHV1aWQ6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgIHV1aWQsXHJcbiAgICApO1xyXG4gICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSBtZXRhIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBNZXRhIOS4juebruagh+i1hOa6kOS4jeWMuemFje+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVSTCDml6DmlYjvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yU3luY01hcmtlclNjcmlwdCh1cmw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtaW5mbycsIHVybCkgYXMge1xyXG4gICAgICAgICAgICB1dWlkPzogc3RyaW5nO1xyXG4gICAgICAgIH0gfCBudWxsO1xyXG4gICAgICAgIGlmICh0eXBlb2YgaW5mbz8udXVpZCA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTAwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOetieW+hSBDb2NvcyDlr7zlhaXnu4Tku7blkIzmraXmoIforrDohJrmnKzotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIOe7hOS7tuWQjOatpemcgOimgeWcqOmhueebrumHjOacieS4gOS4quaegeWwj+eahOagh+iusOe7hOS7tuiEmuacrOOAgummluasoeWvvOWFpeaXtueUn+aIkO+8jFxyXG4gKiDkuYvlkI7mr4/mrKHlr7zlhaXmoKHpqozvvJvooqvlhbbku5bohJrmnKzljaDnlKjml7YgZmFpbC1jbG9zZWTvvIzooqvmiKrmlq3miJbmlLnml6fml7bph43lu7rjgIJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZVN5bmNNYXJrZXJTY3JpcHQoKTogUHJvbWlzZTx7IGFjdGlvbjogc3RyaW5nOyByZWFzb24/OiBzdHJpbmcgfT4ge1xyXG4gICAgY29uc3QgdXJsID0gU1lOQ19NQVJLRVJfU0NSSVBUX1VSTDtcclxuICAgIGxldCBleGlzdGluZzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGV4aXN0aW5nID0gYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgodXJsKSwgJ3V0ZjgnKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIGV4aXN0aW5nID0gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHBsYW4gPSBwbGFuU3luY01hcmtlclNjcmlwdChleGlzdGluZyk7XHJcbiAgICBpZiAocGxhbi5hY3Rpb24gPT09ICdyZWplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKHBsYW4ucmVhc29uKTtcclxuICAgIH1cclxuICAgIGlmIChwbGFuLmFjdGlvbiA9PT0gJ2tlZXAnKSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclN5bmNNYXJrZXJTY3JpcHQodXJsKTtcclxuICAgICAgICByZXR1cm4geyBhY3Rpb246ICdrZWVwJyB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmwpIGFzIHtcclxuICAgICAgICB1dWlkPzogc3RyaW5nO1xyXG4gICAgfSB8IG51bGw7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnY3JlYXRlLWFzc2V0JywgdXJsLCBwbGFuLmNvbnRlbnQsIHtcclxuICAgICAgICAgICAgb3ZlcndyaXRlOiBmYWxzZSxcclxuICAgICAgICAgICAgcmVuYW1lOiBmYWxzZSxcclxuICAgICAgICB9KSBhcyB7IHV1aWQ/OiBzdHJpbmcgfSB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu657uE5Lu25ZCM5q2l5qCH6K6w6ISa5pys77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdzYXZlLWFzc2V0JywgdXJsLCBwbGFuLmNvbnRlbnQpO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgd2FpdEZvclN5bmNNYXJrZXJTY3JpcHQodXJsKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgYWN0aW9uOiBwbGFuLmFjdGlvbixcclxuICAgICAgICByZWFzb246IHBsYW4uYWN0aW9uID09PSAncmV3cml0ZScgPyBwbGFuLnJlYXNvbiA6IHVuZGVmaW5lZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RTeW5jTWFya2VyU3BlY3Moc3BlY3M6IHJlYWRvbmx5IFNjZW5lTm9kZVNwZWNbXSk6IFN5bmNNYXJrZXJTcGVjW10ge1xyXG4gICAgY29uc3QgbWFya2VyczogU3luY01hcmtlclNwZWNbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZXM6IHJlYWRvbmx5IFNjZW5lTm9kZVNwZWNbXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAobm9kZS5zeW5jTWFya2VyKSB7XHJcbiAgICAgICAgICAgICAgICBtYXJrZXJzLnB1c2gobm9kZS5zeW5jTWFya2VyKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB2aXNpdChub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgdmlzaXQoc3BlY3MpO1xyXG4gICAgcmV0dXJuIG1hcmtlcnM7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZChcclxuICAgICAgICAgICAgYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgoaW5mby51cmwpKSxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgICk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZyxcclxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBjdXJyZW50RGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICBpZiAoY3VycmVudERpcnR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3miZPlvIDnmoTlnLrmma/miJYgUHJlZmFiIOacieacquS/neWtmOS/ruaUue+8m+S4uumBv+WFjeinpuWPkeS/neWtmOivoumXru+8jOivt+WFiOaJi+W3peS/neWtmOaIlui/mOWOn+WQjuWGjeWvvOWFpeOAgicpO1xyXG4gICAgfVxyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdvcGVuLWFzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGxldCBsYXN0UmVhc29uID0gJ0NyZWF0b3Ig5bCa5pyq6L+U5ZueIFByZWZhYiDnvJbovpHnirbmgIEnO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgICAgICAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBzdGF0ZS5yZWFzb24gPz8gbGFzdFJlYXNvbjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg5omT5byA55uu5qCHIFByZWZhYiDotoXml7bvvJoke2xhc3RSZWFzb259YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFzc2VydE9wZW5lZFByZWZhYihwcmVmYWJVdWlkOiBzdHJpbmcsIHJvb3RGaWxlSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDnvJbovpHkuIrkuIvmloflt7Llj5jljJbvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjZW5lU2F2ZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDE1XzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmICghZGlydHkpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ+etieW+hSBQcmVmYWIg5L+d5a2Y5a6M5oiQ6LaF5pe244CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFByZWZhYkJpbmRpbmdzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHByZWZhYlV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcHJlZmFiVXVpZCAhPT0gJ3N0cmluZydcclxuICAgICAgICAgICAgfHwgIXByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ57uR5a6a6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZywgcHJlZmFiVXVpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBiaW5kaW5nc1tzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBpZiAoIWJpbmRpbmdzW3NvdXJjZUhhc2hdKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVsZXRlIGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgIXJhd1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0J1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgKHJhdyBhcyB7IHByZWZhYlV1aWQ/OiB1bmtub3duIH0pLnByZWZhYlV1aWQgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZCh7XHJcbiAgICAgICAgICAgIHVzZXJEYXRhOiB7XHJcbiAgICAgICAgICAgICAgICBmaWdtYUltcG9ydGVyOiAocmF3IGFzIHsgcmVjb3JkPzogdW5rbm93biB9KS5yZWNvcmQsXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5p2l5rqQ5LiN5LiA6Ie077yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogKHJhdyBhcyB7IHByZWZhYlV1aWQ6IHN0cmluZyB9KS5wcmVmYWJVdWlkLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFBlbmRpbmdQcmVmYWJTeW5jKFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfSB8IG51bGwsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcGVuZGluZyA9IGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpO1xyXG4gICAgaWYgKHZhbHVlKSB7XHJcbiAgICAgICAgcGVuZGluZ1tzb3VyY2VIYXNoXSA9IHZhbHVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgcGVuZGluZ1tzb3VyY2VIYXNoXTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgcGVuZGluZyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB2ZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7IG1ldGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4ge1xyXG4gICAgbGV0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgIGxldCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgIGlmICghcmVjb3JkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBgUHJlZmFiIOe8uuWwkSBGaWdtYSDmnaXmupDorrDlvZXvvIzml6Dms5Xnoa7orqTmmK/lkKblj6/lronlhajopobnm5bvvJoke2luZm8udXJsfeOAguivt+WFiOenu+WKqOaIlumHjeWRveWQjeivpei1hOa6kOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxuICAgIGlmIChyZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOadpeiHquWPpuS4gOS4qiBGaWdtYSBGcmFtZe+8jOW3suaLkue7neimhueblu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGlmIChwZW5kaW5nKSB7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcucHJlZmFiVXVpZCAhPT0gaW5mby51dWlkIHx8IHBlbmRpbmcucmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmo4DmtYvliLDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtOeahOW+heaBouWkjeWQjOatpeiusOW9le+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCBwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCBwZW5kaW5nLnJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFyZWNvdmVyZWQgfHwgSlNPTi5zdHJpbmdpZnkocmVjb3ZlcmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXorrDlvZXoh6rliqjmgaLlpI3lpLHotKXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZWNvcmQgPSByZWNvdmVyZWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCByZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuS4juW9k+WJjeWPiuW+heaBouWkjeeahOWQjOatpeiusOW9lemDveS4jeS4gOiHtO+8jOW3suWBnOatouiHquWKqOaBouWkjeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IG1ldGEsIHJlY29yZCB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGxldCBsYXN0RXJyb3I6IHVua25vd247XHJcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8IDM7IGF0dGVtcHQgKz0gMSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WGmeWFpeWJjSBQcmVmYWIg5p2l5rqQ6K6w5b2V5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xyXG4gICAgICAgICAgICBpZiAoIXNhdmVkIHx8IEpTT04uc3RyaW5naWZ5KHNhdmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5ZCO5qCh6aqM5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xyXG4gICAgICAgICAgICBpZiAoYXR0ZW1wdCA8IDIpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxNTApKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IGxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbGFzdEVycm9yIDogbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5aSx6LSl44CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nLFxyXG4gICAgcm9vdEZyYW1lOiBSZWN0LFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgc291cmNlUm9vdElkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8e1xyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59PiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBjb25zdCBib3VuZFV1aWQgPSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZ0luZm8gPSBwZW5kaW5nXHJcbiAgICAgICAgPyBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHBlbmRpbmcucHJlZmFiVXVpZClcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBjb25zdCB0YXJnZXRQbGFuID0gcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0KFxyXG4gICAgICAgIHBlbmRpbmc/LnByZWZhYlV1aWQsXHJcbiAgICAgICAgYm91bmRVdWlkLFxyXG4gICAgICAgIEJvb2xlYW4ocGVuZGluZ0luZm8pLFxyXG4gICAgKTtcclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyUGVuZGluZykge1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJCaW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSB0YXJnZXRQbGFuLnRhcmdldFV1aWQ7XHJcbiAgICBpZiAodGFyZ2V0VXVpZCkge1xyXG4gICAgICAgIGxldCB0YXJnZXRJbmZvID0gcGVuZGluZ0luZm8/LnV1aWQgPT09IHRhcmdldFV1aWRcclxuICAgICAgICAgICAgPyBwZW5kaW5nSW5mb1xyXG4gICAgICAgICAgICA6IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgaWYgKCF0YXJnZXRJbmZvKSB7XHJcbiAgICAgICAgICAgIGlmIChiaW5kaW5nc1tzb3VyY2VIYXNoXSA9PT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQodGFyZ2V0SW5mby51cmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICBpZiAocGVuZGluZz8ucHJlZmFiVXVpZCA9PT0gdGFyZ2V0VXVpZCAmJiBib3VuZFV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIHJlY292ZXJ5IGlkZW50aXR5IGJlZm9yZSB2ZXJpZmllZFByZWZhYlJlY29yZCBtYXlcclxuICAgICAgICAgICAgICAgIC8vIGNvbW1pdCBhbmQgY2xlYXIgcGVuZGluZy4gQSBsYXRlciBtb3ZlIGZhaWx1cmUgbXVzdCBzdGlsbCBiZVxyXG4gICAgICAgICAgICAgICAgLy8gYWJsZSB0byBsb2NhdGUgdGhlIGV4YWN0IFByZWZhYiBieSBVVUlEIG9uIHRoZSBuZXh0IGF0dGVtcHQuXHJcbiAgICAgICAgICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQodGFyZ2V0SW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIGlmICh0YXJnZXRJbmZvLnVybCAhPT0gcHJlZmFiVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb25mbGljdCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmIChjb25mbGljdCAmJiBjb25mbGljdC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmlnbWEgRnJhbWUg5a+55bqU55qEIFByZWZhYiDpnIDopoHnp7vliqjliLAgJHtwcmVmYWJVcmx977yM5L2G55uu5qCH6Lev5b6E5bey6KKr5YW25LuW6LWE5rqQ5Y2g55So44CCYCxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFjb25mbGljdCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vdmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ21vdmUtYXNzZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvLnVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICAgICAgICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3ZlZCB8fCBtb3ZlZC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Zyo5L+d55WZIFVVSUQg55qE5YmN5o+Q5LiL56e75YqoIFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaW5mbzogdGFyZ2V0SW5mbyxcclxuICAgICAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm1GaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHNlZWQgPSBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbihcclxuICAgICAgICAgICAgcHJlZmFiTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdjcmVhdGUtYXNzZXQnLFxyXG4gICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgIHNlZWQsXHJcbiAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7ogUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBjcmVhdGVkLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCByZWNvcmQgPSBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgICAgICBzb3VyY2VSb290SWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBuZXh0TWV0YSA9IG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG5leHRNZXRhLCBudWxsLCAyKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpbmZvLFxyXG4gICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpbmZvLFxyXG4gICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoYXJnczoge1xyXG4gICAgcmV2aWV3SWQ6IHN0cmluZztcclxuICAgIHByZWZhYlVybDogc3RyaW5nO1xyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgc291cmNlTm9kZUlkOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufSk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHNvdXJjZUhhc2ggPSBmaWdtYUZyYW1lU291cmNlSGFzaChhcmdzLmZpbGVLZXksIGFyZ3Muc291cmNlTm9kZUlkKTtcclxuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgICAgIGFyZ3MucHJlZmFiVXJsLFxyXG4gICAgICAgIGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIHg6IGFyZ3Mucm9vdEZyYW1lLnggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB5OiBhcmdzLnJvb3RGcmFtZS55ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgd2lkdGg6IGFyZ3Mucm9vdEZyYW1lLndpZHRoICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgaGVpZ2h0OiBhcmdzLnJvb3RGcmFtZS5oZWlnaHQgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICBhcmdzLnJvb3RzWzBdLmZpZ21hSWQsXHJcbiAgICApO1xyXG4gICAgYXdhaXQgd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICApO1xyXG4gICAgY29uc3QgZXhpc3RpbmdOb2RlRmlsZUlkcyA9IHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZCxcclxuICAgICAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMoYXJncy5yb290cyksXHJcbiAgICApO1xyXG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgIHJldmlld0lkOiBhcmdzLnJldmlld0lkLFxyXG4gICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcclxuICAgICAgICByb290TmFtZTogYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHJvb3RGcmFtZTogYXJncy5yb290RnJhbWUsXHJcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgZXhpc3RpbmdNYXA6IHt9LFxyXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcm9vdHM6IGFyZ3Mucm9vdHMsXHJcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQ6IHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XHJcbiAgICBsZXQgc2F2ZUF0dGVtcHRlZCA9IGZhbHNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoZGlydHlCZWZvcmVJbXBvcnQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnm67moIcgUHJlZmFiIOacieacquS/neWtmOeahOaJi+W3peS/ruaUue+8jOivt+WFiOS/neWtmOWQjuWGjeaJp+ihjCBGaWdtYSDlop7ph4/lr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBzbmFwc2hvdFN0YXJ0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBpZiAoIXJlc3VsdC5wcmVmYWJTeW5jKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5leHRSZWNvcmQgPSByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShwcmVwYXJlZC5yZWNvcmQsIHJlc3VsdC5wcmVmYWJTeW5jKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkOiBuZXh0UmVjb3JkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGF3YWl0IGFzc2VydE9wZW5lZFByZWZhYihwcmVwYXJlZC5pbmZvLnV1aWQsIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkKTtcclxuICAgICAgICAvLyBPbmNlIHRoZSBzYXZlIHJlcXVlc3QgaXMgc2VudCBpdHMgcmVzdWx0IGlzIGFtYmlndW91cyB1bnRpbCB0aGVcclxuICAgICAgICAvLyBwZXJzaXN0ZWQgUHJlZmFiIGlzIHZlcmlmaWVkLiBEbyBub3Qgcm9sbCB0aGUgaW4tbWVtb3J5IFByZWZhYiBiYWNrXHJcbiAgICAgICAgLy8gb24gYW4gSVBDIHRpbWVvdXQ6IHRoZSBkaXNrIHdyaXRlIG1heSBhbHJlYWR5IGhhdmUgY29tcGxldGVkLlxyXG4gICAgICAgIHNhdmVBdHRlbXB0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yU2NlbmVTYXZlZCgpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChjdXJyZW50SW5mbywgbmV4dFJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25pyq5YyF5ZCr5pys5qyh5ZCM5q2l55Sf5oiQ55qE5YWo6YOoIGZpbGVJZO+8jOW3suWBnOatouabtOaWsCBNZXRh44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRNZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGN1cnJlbnRJbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChjdXJyZW50TWV0YSk7XHJcbiAgICAgICAgaWYgKCFjdXJyZW50UmVjb3JkIHx8IGN1cnJlbnRSZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlnKjkv53lrZjmnJ/pl7Tlj5HnlJ/lj5jljJbvvIzlt7Lmi5Lnu53mj5DkuqTjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChjdXJyZW50SW5mbywgc291cmNlSGFzaCwgbmV4dFJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsKTtcclxuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCOIFByZWZhYiBVVUlEIOagoemqjOWksei0peOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xyXG4gICAgICAgICAgICB1dWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzdWx0LnByZWZhYlVybCA9IHByZXBhcmVkLmluZm8udXJsO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcclxuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QtYWJvcnQnKTsgfVxyXG4gICAgICAgICAgICBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgKGVycm9yIGFzIEVycm9yICYgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSkucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzYXZlQXR0ZW1wdGVkICYmIGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIChlcnJvciBhcyBFcnJvciAmIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pLnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIOe7hOS7tuWQjOatpemihOajgO+8muWPquivu+ebruaghyBQcmVmYWIg5LiO5b2T5YmNIEZpZ21hIOiuoeWIkuOAglxyXG4gKiDkuI3kuIvovb3lm77niYfjgIHkuI3miZPlvIAgUHJlZmFi44CB5LiN5YaZ5YWl5Lu75L2V5paH5Lu277yM5Y+v5Zyo55So5oi354K55Ye75a+85YWl5YmN5Y+N5aSN6LCD55So44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3Q29tcG9uZW50U3luYygpOiBQcm9taXNlPFN5bmNQcmV2aWV3UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgaWYgKCFkb2N1bWVudCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFkb2N1bWVudC5zb3VyY2VOb2RlSWQgfHwgZG9jdW1lbnQucm9vdHMubGVuZ3RoICE9PSAxKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflj6rmnInljZXkuKroioLngrnpk77mjqXmiY3og73pooTop4jnu4Tku7blkIzmraXjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5yb290c1swXTtcclxuICAgIGlmIChyb290LnR5cGUgIT09ICdDT01QT05FTlQnICYmIHJvb3QudHlwZSAhPT0gJ0lOU1RBTkNFJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5b2T5YmN5qC56IqC54K55pivICR7cm9vdC50eXBlfe+8jOWPquaciee7hOS7tu+8iENPTVBPTkVOVC9JTlNUQU5DRe+8iemTvuaOpeaUr+aMgee7hOS7tuWQjOatpeOAgmApO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xyXG4gICAgLy8gQXNzZXRXcml0ZXIg5p6E6YCg5Ye95pWw5Y+q6KeE6IyD5YyW55uu5b2V77yM5LiN5Lya5Yib5bu65paH5Lu25aS544CCXHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcclxuICAgIGNvbnN0IHByZWZhYlVybCA9IGBkYjovL2Fzc2V0cy8ke3dyaXRlci5mb2xkZXJ9LyR7c2FuaXRpemVBc3NldE5hbWUocm9vdC5uYW1lKX0ucHJlZmFiYDtcclxuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICByZXR1cm4geyB0YXJnZXRVcmw6IHByZWZhYlVybCwgZXhpc3RzOiBmYWxzZSwgLi4uZW1wdHlTeW5jUHJldmlld1N1bW1hcnkoKSB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJldmlvdXMgPSByZWFkUHJlZmFiU3luY01hcmtlcnMoYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgocHJlZmFiVXJsKSkpO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGVzID0gYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KTtcclxuICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKG92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XHJcbiAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKGRvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgY29uc3Qgcm9vdEZyYW1lID0gbm9kZUZyYW1lKHJvb3QpO1xyXG4gICAgY29uc3Qgc3BlY3MgPSBkb2N1bWVudC5yb290c1xyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICBuZXcgTWFwKCksXHJcbiAgICAgICAgICAgIG5ldyBNYXAoKSxcclxuICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgMCxcclxuICAgICAgICAgICAgeyBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5IH0sXHJcbiAgICAgICAgKSlcclxuICAgICAgICAuZmlsdGVyKChzcGVjKTogc3BlYyBpcyBTY2VuZU5vZGVTcGVjID0+IHNwZWMgIT09IG51bGwpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB0YXJnZXRVcmw6IHByZWZhYlVybCxcclxuICAgICAgICBleGlzdHM6IHRydWUsXHJcbiAgICAgICAgcHJlZmFiVXVpZDogaW5mby51dWlkLFxyXG4gICAgICAgIC4uLnBsYW5TeW5jUHJldmlldyhwcmV2aW91cywgc3BlY3MsIHsgc2NhbGU6IHNldHRpbmdzLnNjYWxlIH0pLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybUltcG9ydChyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0LCBvcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwsIG9wdGlvbnM6IHtcclxuICAgIGRvY3VtZW50PzogRG9jdW1lbnRTZXNzaW9uOyBwcmVzZXJ2ZVJldmlld3M/OiBib29sZWFuOyBzaWxlbnRSZXZpZXc/OiBib29sZWFuO1xyXG59ID0ge30pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IG9wdGlvbnMuZG9jdW1lbnQgPz8gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBpZiAoIWRvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbXBvcnRTZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbihvcGVyYXRpb25Pd25lcik7XHJcbiAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5a+85YWl5Lu75YqhJywgeyByb290czogZG9jdW1lbnQucm9vdHMubWFwKChub2RlKSA9PiAoeyBpZDogbm9kZS5pZCwgbmFtZTogbm9kZS5uYW1lIH0pKSB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5YiG5p6Q5bm25YeG5aSH6LWE5rqQ4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChyZXF1ZXN0Lm92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3RG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICBpbXBvcnRSZXZpZXdzLmludmFsaWRhdGUob3B0aW9ucy5wcmVzZXJ2ZVJldmlld3MgPyB7IHByZXNlcnZlSGlzdG9yeTogdHJ1ZSB9IDogdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zdCByZXZpZXdSZWNvcmRlciA9IG5ldyBJbXBvcnRSZXZpZXdSZWNvcmRlcigpO1xyXG4gICAgICAgIGNvbnN0IGJ1aWx0QXNzZXRzID0gYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WFqOmDqOi1hOa6kCcsIHVuZGVmaW5lZCwgKCkgPT4gYnVpbGRBc3NldHMoZG9jdW1lbnQsIGRlY2lzaW9ucywgaW1wb3J0U2V0dGluZ3MsIHJldmlld1JlY29yZGVyKSk7XHJcbiAgICAgICAgY29uc3QgeyBhc3NldHMsIHdhcm5pbmdzIH0gPSBidWlsdEFzc2V0cztcclxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgY29uc3QgYXR0YWNoUmV2aWV3ID0gYXN5bmMgKHJlc3VsdDogU2NlbmVJbXBvcnRSZXN1bHQpID0+IHtcclxuICAgICAgICAgICAgcmVzdWx0LnJldmlldyA9IGF3YWl0IGZpbmFsaXplSW1wb3J0UmV2aWV3KGltcG9ydFJldmlld3MsIHJldmlld1JlY29yZGVyLCByZXZpZXdEb2N1bWVudCxcclxuICAgICAgICAgICAgICAgIHJlc3VsdC5yZXZpZXdCZWZvcmUsIHJlc3VsdC5yZXZpZXdBZnRlciwgcmVzdWx0LnByZWZhYlVybCwgd2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICBhc3luYyAoKSA9PiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLCBtZXRob2Q6ICdyZWZyZXNoUmV2aWV3QWZ0ZXInLCBhcmdzOiBbeyBpZDogcmV2aWV3UmVjb3JkZXIuaWQgfV0sXHJcbiAgICAgICAgICAgICAgICB9KSBhcyBSZXZpZXdTY2VuZSk7XHJcbiAgICAgICAgICAgIC8vIEFsc28gY292ZXIgbWFudWFsIGltcG9ydHMgd2hvc2UgcGFuZWwgd2FzIGNsb3NlZCB3aGlsZSBpbXBvcnRpbmcuXHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucy5zaWxlbnRSZXZpZXcpIHtcclxuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0JlZm9yZTtcclxuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAnaW1wb3J0LXJldmlldy1yZWFkeScsIHJlc3VsdC5yZXZpZXcpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChg57uT5p6c5bey5L+d5a2Y77yM5L2G6Ieq5Yqo5omT5byA6Z2i5p2/5aSx6LSl77yM6K+35LuO5o+S5Lu25Lit5omT5byA4oCc5a+85YWl57uT5p6c5qOA5p+l4oCd77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QWZ0ZXI7XHJcbiAgICAgICAgfTtcclxuICAgICAgICAvLyBidWlsZEFzc2V0cyBtYXkgcHJvbW90ZSBhIGNvbnRhaW5lciB0byBhIGxvY2FsIHNhbWUtbmFtZSByZXNvdXJjZS5cclxuICAgICAgICAvLyBDb21waWxlIGFmdGVyIHRoYXQgcHJvbW90aW9uIHNvIGFzc2V0cyBhbmQgU2NlbmVOb2RlU3BlYyBzaGFyZSB0aGVcclxuICAgICAgICAvLyBleGFjdCBzYW1lIGZpbmFsIHBsYW4uXHJcbiAgICAgICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCBmb250cyA9IGF3YWl0IHJlc29sdmVGb250cyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlUm9vdEZyYW1lcyA9IGRvY3VtZW50LnJvb3RzLm1hcChub2RlRnJhbWUpO1xyXG4gICAgICAgIGNvbnN0IG11bHRpcGxlUm9vdHMgPSBkb2N1bWVudC5yb290cy5sZW5ndGggPiAxO1xyXG4gICAgICAgIGNvbnN0IGFycmFuZ2VkV2lkdGggPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8gc291cmNlUm9vdEZyYW1lcy5yZWR1Y2UoKHRvdGFsLCBmcmFtZSkgPT4gdG90YWwgKyBmcmFtZS53aWR0aCwgMClcclxuICAgICAgICAgICAgICAgICsgTWF0aC5tYXgoMCwgc291cmNlUm9vdEZyYW1lcy5sZW5ndGggLSAxKSAqIDE2MFxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0/LndpZHRoID8/IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZyYW1lID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHg6IDAsXHJcbiAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGFycmFuZ2VkV2lkdGgsXHJcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IE1hdGgubWF4KDAsIC4uLnNvdXJjZVJvb3RGcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KSksXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdID8/IHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgICAgIGxldCByb290Q3Vyc29yID0gMDtcclxuICAgICAgICAvLyDnu4Tku7bnuqflkIzmraXvvJrlj6rmnInljZXoioLngrnpk77mjqXjgIHkuJTmoLnoioLngrnnoa7lrp7mmK/nu4Tku7bvvIjmiJblrp7kvovvvInml7blkK/nlKjjgIJcclxuICAgICAgICAvLyBGcmFtZSDpk77mjqXkv53mjIHljp/mnInooYzkuLrvvIzkuI3nlJ/miJDmoIforrDjgIHkuI3pop3lpJbliJvlu7rpobnnm67ohJrmnKzjgIJcclxuICAgICAgICBjb25zdCBzeW5jUm9vdE5vZGUgPSBkb2N1bWVudC5zb3VyY2VOb2RlSWQgJiYgZG9jdW1lbnQucm9vdHMubGVuZ3RoID09PSAxXHJcbiAgICAgICAgICAgID8gZG9jdW1lbnQucm9vdHNbMF1cclxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3Qgc3luY0NvbnRleHQgPSBzeW5jUm9vdE5vZGVcclxuICAgICAgICAgICAgJiYgKHN5bmNSb290Tm9kZS50eXBlID09PSAnQ09NUE9ORU5UJyB8fCBzeW5jUm9vdE5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJylcclxuICAgICAgICAgICAgPyB7IGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXkgfVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCByb290cyA9IGRvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgICAgIC5tYXAoKG5vZGUsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzcGVjID0gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIDAsXHJcbiAgICAgICAgICAgICAgICAgICAgc3luY0NvbnRleHQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMgJiYgbXVsdGlwbGVSb290cykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMuZnJhbWUgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IHJvb3RDdXJzb3IsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgICByb290Q3Vyc29yICs9IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoICsgMTYwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNwZWM7XHJcbiAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKG5vZGUpOiBub2RlIGlzIFNjZW5lTm9kZVNwZWMgPT4gbm9kZSAhPT0gbnVsbCk7XHJcbiAgICAgICAgaWYgKCFyb290cy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInpgInkuK3ku7vkvZXlj6/lr7zlhaXoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHN5bmNDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwKGNvbGxlY3RTeW5jTWFya2VyU3BlY3Mocm9vdHMpKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5ZCM5q2l5qCH6K6w5omA5pyJ5p2D5qCh6aqM5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHNvdXJjZU5vZGVJZCA9IGRvY3VtZW50LnNvdXJjZU5vZGVJZDtcclxuICAgICAgICBpZiAoc291cmNlTm9kZUlkICYmIHJvb3RzLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJXcml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcclxuICAgICAgICAgICAgYXdhaXQgcHJlZmFiV3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWVOYW1lID0gcm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQucm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYlVybCA9IGBkYjovL2Fzc2V0cy8ke3ByZWZhYldyaXRlci5mb2xkZXJ9LyR7c2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKX0ucHJlZmFiYDtcclxuICAgICAgICAgICAgaWYgKHN5bmNDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiAwLjAyLFxyXG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjlh4blpIfnu4Tku7blkIzmraXmoIforrDohJrmnKzigKYnLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzY3JpcHQgPSBhd2FpdCBlbnN1cmVTeW5jTWFya2VyU2NyaXB0KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2NyaXB0LnJlYXNvbikge1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goc2NyaXB0LnJlYXNvbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDAuMDUsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAn5q2j5Zyo5Yib5bu65oiW5omT5byA55uu5qCHIFByZWZhYuKApicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYih7XHJcbiAgICAgICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJOYW1lOiBmcmFtZU5hbWUsXHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgc291cmNlTm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBpZiAocmVzdWx0LnN5bmNNYXJrZXJXYXJuaW5nKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5wdXNoKGDnu4Tku7blkIzmraXmoIforrDmnKrlhpnlhaXvvJoke3Jlc3VsdC5zeW5jTWFya2VyV2FybmluZ31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgICAgIC8vIFByZWZhYiB1cGRhdGVzIHBlcnNpc3QgYnkgUHJlZmFiSW5mby5maWxlSWQgaW4gdGhlIGFzc2V0IG1ldGE7XHJcbiAgICAgICAgICAgIC8vIHJ1bnRpbWUgbm9kZSBVVUlEcyBhcmUgc2Vzc2lvbi1vbmx5IGFuZCBtdXN0IG5ldmVyIGJlIHJldXNlZCBoZXJlLlxyXG4gICAgICAgICAgICBkZWxldGUgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV07XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfe+8jOW3suaJk+W8gOmihOWItuS9kyAke3ByZWZhYlVybH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgcmV2aWV3SWQ6IHJldmlld1JlY29yZGVyLmlkLFxyXG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgcm9vdE5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGltcG9ydFNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxyXG4gICAgICAgICAgICBleGlzdGluZ01hcDogbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPz8ge30sXHJcbiAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLjEsIG1lc3NhZ2U6ICfmraPlnKjmnoTlu7ogQ29jb3Mg6IqC54K55qCR4oCmJyB9KTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA9IHJlc3VsdC5ub2RlTWFwO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ25vZGUnLCByZXN1bHQucm9vdFV1aWQpO1xyXG4gICAgICAgIGlmIChpbXBvcnRTZXR0aW5ncy5hdXRvU2F2ZSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRyYWNlLmRvbmUoKTtcclxuICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWPlua2iOOAgicgfSk7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5pON5L2c5bey5Y+W5raI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIHRyYWNlLmV2ZW50KCflkI7lj7Dku7vliqHlt7Lph4rmlL4nKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TWNwUGx1Z2luU3RhdGUoKSB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2ZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcclxuICAgICAgICBzZXR0aW5nczogYXdhaXQgZ2V0U2V0dGluZ3MoKSxcclxuICAgICAgICBkb2N1bWVudDogZG9jdW1lbnQgPyB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlczogYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSxcclxuICAgICAgICB9IDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBsdWdpblN0YXRlKCkge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5hd2FpdCBnZXRNY3BQbHVnaW5TdGF0ZSgpLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5YgRmlnbWEg5paH5Lu24oCmJyB9KTtcclxuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0gcGFyc2VkLm5vZGVJZFxyXG4gICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxyXG4gICAgICAgICAgICA6IGF3YWl0IGFwaS5nZXRGaWxlKHBhcnNlZC5maWxlS2V5KTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKFxyXG4gICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGNvbnN0IG5vZGVPdmVycmlkZXMgPSBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiBg5bey6K+75Y+WICR7ZG9jdW1lbnQuZmlsZU5hbWV9YCB9KTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBmb250QXNzZXRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIH07XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24sIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXSk6IFByb21pc2U8QmF0Y2hEb2N1bWVudER0bz4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LCBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICBmb250QXNzZXRzOiBmb250QXNzZXRzID8/IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICAgICAgbm9kZU92ZXJyaWRlczogKGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSkpLmZpbHRlcigoaXRlbSkgPT4gZG9jdW1lbnQubm9kZUJ5SWQuaGFzKGl0ZW0uaWQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCYXRjaFNvdXJjZShzb3VyY2VVcmw6IHN0cmluZyk6IFByb21pc2U8QmF0Y2hTb3VyY2VSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgIGlmICghcGFyc2VkLm5vZGVJZCkge1xyXG4gICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoJ+aVtOS7veaWh+S7tuivt+WNleeLrOWvvOWFpe+8m+ivt+WFiOenu+mZpOaJuemHj+eVjOmdouWIl+ihqO+8jOaIluS9v+eUqCBTZWN0aW9uIC8gRnJhbWUg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsKTtcclxuICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiAnZmlsZScsIHNvdXJjZVVybCwgaXRlbXM6IFtdLCBhZGRlZDogMCwgZHVwbGljYXRlczogMCwgZG9jdW1lbnQgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5blubbor4bliKsgU2VjdGlvbiAvIEZyYW1l4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpO1xyXG4gICAgICAgIGNvbnN0IHBhcnNlZERvY3VtZW50ID0gcGFyc2VEb2N1bWVudChhd2FpdCBhcGkuZ2V0Tm9kZShwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCksXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpO1xyXG4gICAgICAgIGNvbnN0IHJvb3QgPSBwYXJzZWREb2N1bWVudC5yb290c1swXTtcclxuICAgICAgICBjb25zdCBmb250QXNzZXRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgICAgICBpZiAocm9vdC50eXBlICE9PSAnU0VDVElPTicgJiYgcm9vdC50eXBlICE9PSAnRlJBTUUnKSB7XHJcbiAgICAgICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoJ+aJuemHj+WIl+ihqOWPquaOpeWPlyBTZWN0aW9uIOaIliBGcmFtZe+8m+WFtuS7luiKgueCueivt+a4heepuuWIl+ihqOWQjuWNleeLrOWvvOWFpeOAgicpO1xyXG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKHBhcnNlZERvY3VtZW50KTtcclxuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICBhd2FpdCBwYXRjaFNldHRpbmdzKHsgc291cmNlVXJsIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiAnbm9kZScsIHNvdXJjZVVybCwgaXRlbXM6IFtdLCBhZGRlZDogMCwgZHVwbGljYXRlczogMCxcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50LCBmb250QXNzZXRzKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmcmFtZXMgPSBjb2xsZWN0U2VjdGlvbkZyYW1lcyhyb290KTtcclxuICAgICAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign6L+Z5LiqIFNlY3Rpb24g5LiL5rKh5pyJ5Y+v54us56uL5a+85YWl55qE5aSW5bGCIEZyYW1l44CCJyk7XHJcbiAgICAgICAgY29uc3QgcHJlcGFyZWQ6IEFycmF5PHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4gPSBbXTtcclxuICAgICAgICBsZXQgZHVwbGljYXRlcyA9IDA7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBmcmFtZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaWQgPSBmaWdtYUZyYW1lU291cmNlSGFzaChwYXJzZWQuZmlsZUtleSwgZnJhbWUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGJhdGNoRG9jdW1lbnRzLmdldChpZCk7XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZHVwbGljYXRlcyArPSAxO1xyXG4gICAgICAgICAgICAgICAgcHJlcGFyZWQucHVzaCh7IC4uLmV4aXN0aW5nLCBpdGVtOiB7IC4uLmV4aXN0aW5nLml0ZW0sXHJcbiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZXhpc3RpbmcuZG9jdW1lbnQsIGZvbnRBc3NldHMpIH0gfSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKGZyYW1lRG9jdW1lbnQocGFyc2VkRG9jdW1lbnQsIGZyYW1lKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW06IEJhdGNoRnJhbWVJdGVtID0ge1xyXG4gICAgICAgICAgICAgICAgaWQsIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIHJvb3RJZDogZnJhbWUuaWQsIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICAgICAgbmFtZTogZnJhbWUubmFtZSwgZW5hYmxlZDogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIC4uLihyb290LnR5cGUgPT09ICdTRUNUSU9OJyA/IHsgc2VjdGlvbk5hbWU6IHJvb3QubmFtZSB9IDoge30pLFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQsIGZvbnRBc3NldHMpLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBwcmVwYXJlZC5wdXNoKHsgaXRlbSwgZG9jdW1lbnQgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFkZGVkID0gcHJlcGFyZWQubGVuZ3RoIC0gZHVwbGljYXRlcztcclxuICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuc2l6ZSArIGFkZGVkID4gTUFYX0JBVENIX0lURU1TKSB0aHJvdyBuZXcgRXJyb3IoJ+acrOaJueacgOWkmua3u+WKoCAnICsgTUFYX0JBVENIX0lURU1TICsgJyDkuKrnlYzpnaLvvIzor7fliIbmibnlr7zlhaXjgIInKTtcclxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBwcmVwYXJlZCkgYmF0Y2hEb2N1bWVudHMuc2V0KGVudHJ5Lml0ZW0uaWQsIGVudHJ5KTtcclxuICAgICAgICBhd2FpdCBwYXRjaFNldHRpbmdzKHsgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiAn5bey5re75YqgICcgKyBhZGRlZCArICcg5Liq55WM6Z2iJ1xyXG4gICAgICAgICAgICArIChkdXBsaWNhdGVzID8gJ++8jCcgKyBkdXBsaWNhdGVzICsgJyDkuKrlt7LlnKjliJfooagnIDogJycpICsgJ+OAgicgfSk7XHJcbiAgICAgICAgcmV0dXJuIHsgc291cmNlVHlwZTogcm9vdC50eXBlID09PSAnU0VDVElPTicgPyAnc2VjdGlvbicgOiAnZnJhbWUnLCBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIGl0ZW1zOiBwcmVwYXJlZC5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSwgYWRkZWQsIGR1cGxpY2F0ZXMgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgPyAnY2FuY2VsbGVkJyA6ICdlcnJvcicsIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFjdGl2YXRlQmF0Y2hJdGVtKGlkOiBzdHJpbmcpOiBQcm9taXNlPEJhdGNoRG9jdW1lbnREdG8+IHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IGJhdGNoRG9jdW1lbnRzLmdldChpZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSkgdGhyb3cgbmV3IEVycm9yKCfor6XnlYzpnaLlt7LlpLHmlYjvvIzor7fph43mlrDmt7vliqDpk77mjqXjgIInKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZW50cnkuZG9jdW1lbnQpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZW50cnkuZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVudHJ5Lml0ZW0uZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICByZXR1cm4gZG9jdW1lbnQ7XHJcbiAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxufVxyXG5cclxuZnVuY3Rpb24gc3luY0JhdGNoSXRlbXMoaXRlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgZW5hYmxlZDogYm9vbGVhbiB9Pik6IHsgaXRlbXM6IEJhdGNoRnJhbWVJdGVtW10gfSB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3ku7vliqHlrozmiJDlkI7lho3kv67mlLnnlYzpnaLliJfooajjgIInKTtcclxuICAgIGlmICghQXJyYXkuaXNBcnJheShpdGVtcykgfHwgaXRlbXMubGVuZ3RoID4gTUFYX0JBVENIX0lURU1TKSB0aHJvdyBuZXcgRXJyb3IoJ+aJuemHj+eVjOmdouWIl+ihqOaXoOaViOOAgicpO1xyXG4gICAgY29uc3QgbmV4dCA9IG5ldyBNYXA8c3RyaW5nLCB7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIH0+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IGl0ZW0gJiYgYmF0Y2hEb2N1bWVudHMuZ2V0KGl0ZW0uaWQpO1xyXG4gICAgICAgIGlmICghZW50cnkgfHwgdHlwZW9mIGl0ZW0uZW5hYmxlZCAhPT0gJ2Jvb2xlYW4nIHx8IG5leHQuaGFzKGl0ZW0uaWQpKSB0aHJvdyBuZXcgRXJyb3IoJ+eVjOmdouWIl+ihqOW3sui/h+acn+aIluWMheWQq+mHjeWkjemhue+8jOivt+mHjeaWsOivu+WPluOAgicpO1xyXG4gICAgICAgIG5leHQuc2V0KGl0ZW0uaWQsIHsgLi4uZW50cnksIGl0ZW06IHsgLi4uZW50cnkuaXRlbSwgZW5hYmxlZDogaXRlbS5lbmFibGVkIH0gfSk7XHJcbiAgICB9XHJcbiAgICBiYXRjaERvY3VtZW50cy5jbGVhcigpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIGVudHJ5XSBvZiBuZXh0KSBiYXRjaERvY3VtZW50cy5zZXQoaWQsIGVudHJ5KTtcclxuICAgIHJldHVybiB7IGl0ZW1zOiBbLi4uYmF0Y2hEb2N1bWVudHMudmFsdWVzKCldLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldEJhdGNoU3RhdGUoKTogUHJvbWlzZTxCYXRjaFN0YXRlPiB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2gpIHJldHVybiB7XHJcbiAgICAgICAgaXRlbXM6IFsuLi5iYXRjaERvY3VtZW50cy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSksXHJcbiAgICAgICAgbGFzdFJlc3VsdDogbGFzdEJhdGNoUmVzdWx0LCBydW5uaW5nOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSxcclxuICAgIH07XHJcbiAgICBjb25zdCBmb250cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICBjb25zdCBpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaERvY3VtZW50cy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGl0ZW1zLnB1c2goeyAuLi5lbnRyeS5pdGVtLCBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhlbnRyeS5kb2N1bWVudCwgZm9udHMpIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgaXRlbXMsIGxhc3RSZXN1bHQ6IGxhc3RCYXRjaFJlc3VsdCwgLi4uKGFjdGl2ZUJhdGNoID8geyBydW5uaW5nOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSB9IDoge30pIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhdGNoKHJlcXVlc3Q6IEJhdGNoSW1wb3J0UmVxdWVzdCk6IFByb21pc2U8QmF0Y2hJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyIHx8IGFwcGx5aW5nSW1wb3J0UmV2aWV3IHx8IHJvdW5kdHJpcENvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJ5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ44CCJyk7XHJcbiAgICBpZiAoIXJlcXVlc3QgfHwgIUFycmF5LmlzQXJyYXkocmVxdWVzdC5pdGVtcykgfHwgIXJlcXVlc3QuaXRlbXMubGVuZ3RoIHx8IHJlcXVlc3QuaXRlbXMubGVuZ3RoID4gTUFYX0JBVENIX0lURU1TKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7foh7PlsJHpgInmi6nkuIDkuKrmnInmlYjnmoTlvoXlr7zlhaXnlYzpnaLjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgdmlzaWJsZUl0ZW1zID0gcmVxdWVzdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVyc1xyXG4gICAgICAgIHx8IGJhdGNoRG9jdW1lbnRzLmdldChpdGVtPy5pZCk/LmRvY3VtZW50LnJvb3RzWzBdPy52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAoIXZpc2libGVJdGVtcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign5bey5YWz6Zet6ZqQ6JeP5Zu+5bGC5a+85YWl77yM5omA6YCJ55WM6Z2i5Z2H5bey6ZqQ6JeP77yb6K+36YCJ5oup5Y+v6KeB55WM6Z2i5oiW5byA5ZCv5a+85YWl6ZqQ6JeP5Zu+5bGC44CCJyk7XHJcbiAgICBjb25zdCBlbnRyaWVzID0gdmlzaWJsZUl0ZW1zLm1hcCgoaXRlbSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkuaXRlbS5lbmFibGVkIHx8ICFBcnJheS5pc0FycmF5KGl0ZW0ub3ZlcnJpZGVzKSkgdGhyb3cgbmV3IEVycm9yKCflvoXlr7zlhaXnlYzpnaLlt7LlpLHmlYjmiJbmnKrli77pgInvvIzor7fph43mlrDor7vlj5bjgIInKTtcclxuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSBpdGVtLm92ZXJyaWRlcy5tYXAoKG92ZXJyaWRlKSA9PiAoeyAuLi5vdmVycmlkZSB9KSk7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IGVudHJ5LmRvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKG92ZXJyaWRlcywgZW50cnkuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9ucy5nZXQocm9vdC5pZCk/LmFjdGlvbiA9PT0gJ2lnbm9yZScpIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lml0ZW0ubmFtZSArICfigJ3moLnoioLngrnlt7Llv73nlaXvvIzor7flj5bmtojor6XnlYzpnaLli77pgInmiJbmgaLlpI3moLnoioLngrnnrZbnlaXjgIInKTtcclxuICAgICAgICBjb25zdCBuYW1lID0gZGVjaXNpb25zLmdldChyb290LmlkKT8ubmFtZSB8fCByb290Lm5hbWU7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZW50cnksIG92ZXJyaWRlcywgbmFtZSB9O1xyXG4gICAgfSk7XHJcbiAgICBhc3NlcnRCYXRjaFRhcmdldHMoZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgbmFtZTogZW50cnkubmFtZSB9KSkpO1xyXG4gICAgY29uc3QgcnVuOiBCYXRjaFJ1biA9IHtcclxuICAgICAgICBpZDogcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdoZXgnKSwgaW5kZXg6IDAsIHN0b3BSZXF1ZXN0ZWQ6IGZhbHNlLFxyXG4gICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBuYW1lOiBlbnRyeS5uYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsLCBzdGF0dXM6ICdwZW5kaW5nJyB9KSksXHJcbiAgICB9O1xyXG4gICAgYWN0aXZlQmF0Y2ggPSBydW47XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIGVudHJ5Lml0ZW0uZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA9IGVudHJ5Lm92ZXJyaWRlcztcclxuICAgIGNvbnN0IHByZXZpb3VzRG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGNvbnN0IHByZXZpb3VzUmVzdWx0ID0gcmVxdWVzdC5wcmVzZXJ2ZVJlc3VsdHMgPyBsYXN0QmF0Y2hSZXN1bHQgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBjb21wbGV0ZWRSZXN1bHQgPSAoKTogQmF0Y2hJbXBvcnRSZXN1bHQgPT4ge1xyXG4gICAgICAgIGNvbnN0IG1lcmdlZCA9IG5ldyBNYXA8c3RyaW5nLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQ+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHByZXZpb3VzUmVzdWx0Py5pdGVtcyA/PyBbXSkge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuaGFzKGl0ZW0uaWQpKSBtZXJnZWQuc2V0KGl0ZW0uaWQsIHsgLi4uaXRlbSB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJ1bi5pdGVtcykgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XHJcbiAgICAgICAgY29uc3QgaXRlbXMgPSBbLi4ubWVyZ2VkLnZhbHVlcygpXTtcclxuICAgICAgICByZXR1cm4geyBpZDogcnVuLmlkLCBpdGVtcywgc3RvcHBlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgICAgIGNvbXBsZXRlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoLFxyXG4gICAgICAgICAgICB0b3RhbDogaXRlbXMubGVuZ3RoIH07XHJcbiAgICB9O1xyXG4gICAgdHJ5IHtcclxuICAgICAgICAvLyBDaGVjayBldmVyeSBkZXN0aW5hdGlvbiBiZWZvcmUgdGhlIGZpcnN0IGltYWdlL3ByZWZhYiB3cml0ZS5cclxuICAgICAgICBjb25zdCBmb2xkZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKS5mb2xkZXI7XHJcbiAgICAgICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSAnZGI6Ly9hc3NldHMvJyArIGZvbGRlciArICcvJyArIHNhbml0aXplQXNzZXROYW1lKGVudHJ5Lm5hbWUpICsgJy5wcmVmYWInO1xyXG4gICAgICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIWluZm8pIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBlbnRyeS5pdGVtLmlkXHJcbiAgICAgICAgICAgICAgICB8fCAoYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gJiYgYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gIT09IGluZm8udXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lm5hbWUgKyAn4oCd55qEIFByZWZhYiDot6/lvoTlt7Looqvlhbbku5bmnaXmupDljaDnlKjvvIzor7fmlLnlkI3miJbosIPmlbTovpPlh7rnm67lvZXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGxldGVkUmVzdWx0KCk7XHJcbiAgICAgICAgICAgIGxhc3RCYXRjaFJlc3VsdCA9IHJlc3VsdDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWBnOatou+8jOWwmuacquW8gOWni+S7u+S9leeVjOmdouOAgicsIGJhdGNoOiB7IC4uLmJhdGNoUHJvZ3Jlc3MocnVuKSwgcmVzdWx0IH0gfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZShyZXF1ZXN0LnByZXNlcnZlUmVzdWx0cyA/IHsgcHJlc2VydmVIaXN0b3J5OiB0cnVlIH0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBlbnRyaWVzLmxlbmd0aDsgaW5kZXgrKykge1xyXG4gICAgICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICBydW4uaW5kZXggPSBpbmRleDtcclxuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBlbnRyaWVzW2luZGV4XTtcclxuICAgICAgICAgICAgY29uc3Qgcm93ID0gcnVuLml0ZW1zW2luZGV4XTtcclxuICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdydW5uaW5nJztcclxuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcclxuICAgICAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5a+85YWlICcgKyAoaW5kZXggKyAxKSArICcvJyArIGVudHJpZXMubGVuZ3RoICsgJ++8micgKyBlbnRyeS5uYW1lIH0pO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGVyZm9ybUltcG9ydCh7IG92ZXJyaWRlczogZW50cnkub3ZlcnJpZGVzLFxyXG4gICAgICAgICAgICAgICAgICAgIHNldHRpbmdzOiB7IC4uLnNldHRpbmdzLCBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsIH0gfSwgcnVuLmlkLFxyXG4gICAgICAgICAgICAgICAgeyBkb2N1bWVudDogZW50cnkuZG9jdW1lbnQsIHByZXNlcnZlUmV2aWV3czogdHJ1ZSwgc2lsZW50UmV2aWV3OiB0cnVlIH0pO1xyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihyb3csIHsgc3RhdHVzOiAnc3VjY2VzcycsIHByZWZhYlVybDogcmVzdWx0LnByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICBjcmVhdGVkOiByZXN1bHQuY3JlYXRlZCwgdXBkYXRlZDogcmVzdWx0LnVwZGF0ZWQsIHdhcm5pbmdzOiByZXN1bHQud2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJlc3VsdC5yZXZpZXc/LmlkIH0pO1xyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdzdWNjZXNzJztcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIGxldCB1bnNhZmUgPSBCb29sZWFuKChlcnJvciBhcyB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KT8ucmVxdWlyZXNBdHRlbnRpb24pO1xyXG4gICAgICAgICAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykpIHVuc2FmZSA9IHRydWU7IH1cclxuICAgICAgICAgICAgICAgIGNhdGNoIHsgdW5zYWZlID0gdHJ1ZTsgfVxyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdmYWlsZWQnO1xyXG4gICAgICAgICAgICAgICAgcm93LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJztcclxuICAgICAgICAgICAgICAgIGlmICh1bnNhZmUpIHtcclxuICAgICAgICAgICAgICAgICAgICByb3cucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJvdy5lcnJvciArPSAnIOW9k+WJjee8lui+keaIluS/neWtmOeKtuaAgemcgOimgeajgOafpe+8jOW3suaaguWBnOWQjue7reeVjOmdou+8m+ehruiupOebruagh+WSjOS/neWtmOeKtuaAgeWQjuWGjemHjeivleOAgic7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAodW5zYWZlIHx8IHJlcXVlc3QuZmFpbHVyZVBvbGljeSA9PT0gJ3N0b3AnKSBydW4uc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogZW50cnkubmFtZSArICfvvJonICsgKHJvdy5zdGF0dXMgPT09ICdzdWNjZXNzJyA/ICflt7Lkv53lrZgnIDogJ+Wksei0pScpIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXN1bHQgPSBjb21wbGV0ZWRSZXN1bHQoKTtcclxuICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdmFsdWU6IDEsIG1lc3NhZ2U6IHJlc3VsdC5zdG9wcGVkID8gJ+acrOaJueW3suWBnOatou+8jOW3suWujOaIkOmhueS/neeVmeOAgicgOiAn5pys5om55a+85YWl57uT5p2f44CCJyxcclxuICAgICAgICAgICAgYmF0Y2g6IHsgLi4uYmF0Y2hQcm9ncmVzcyhydW4pLCByZXN1bHQgfSB9KTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2ggPT09IHJ1bikgYWN0aXZlQmF0Y2ggPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gcHJldmlvdXNEb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN0b3BJbXBvcnRCYXRjaCgpOiB7IGFjY2VwdGVkOiBib29sZWFuIH0ge1xyXG4gICAgaWYgKCFhY3RpdmVCYXRjaCkgcmV0dXJuIHsgYWNjZXB0ZWQ6IGZhbHNlIH07XHJcbiAgICBhY3RpdmVCYXRjaC5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W9k+WJjeeVjOmdouWujOaIkOS/neWtmOWQjuWBnOatou+8jOWQjue7reeVjOmdouS4jeS8muW8gOWni+OAgicgfSk7XHJcbiAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50Py5ub2RlQnlJZC5nZXQobm9kZUlkKTtcclxuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgIDEsXHJcbiAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgZ2V0SW1wb3J0UmV2aWV3KGlkPzogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLmdldChpZCk7IH0sXHJcbiAgICByZXNvbHZlQmF0Y2hTb3VyY2UsXHJcbiAgICBhY3RpdmF0ZUJhdGNoSXRlbSxcclxuICAgIHN5bmNCYXRjaEl0ZW1zLFxyXG4gICAgZ2V0QmF0Y2hTdGF0ZSxcclxuICAgIGltcG9ydEJhdGNoLFxyXG4gICAgc3RvcEltcG9ydEJhdGNoLFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3UHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcpIHsgcmV0dXJuIGltcG9ydFJldmlld3MucHJldmlldyhpZCwgYXNzZXRJZCk7IH0sXHJcbiAgICBhc3luYyBhcHBseUltcG9ydFJldmlldyhpZDogc3RyaW5nLCByZW1vdmVkSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5a+85YWl5oiWIEZpZ21hIOmihOiniOWujOaIkOOAgicpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gdHJ1ZTtcclxuICAgICAgICB0cnkgeyByZXR1cm4gYXdhaXQgaW1wb3J0UmV2aWV3cy5hcHBseShpZCwgcmVtb3ZlZElkcyk7IH1cclxuICAgICAgICBmaW5hbGx5IHsgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3U291cmNlUHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcsIG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5pON5L2c5a6M5oiQ5ZCO5YaN5Yqg6L295p2l5rqQ6aKE6KeI44CCJyk7XHJcbiAgICAgICAgY29uc3QgeyBmaWxlS2V5LCBub2RlIH0gPSBpbXBvcnRSZXZpZXdzLnNvdXJjZShpZCwgYXNzZXRJZCwgbm9kZUlkKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcclxuICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsbHNbaW1hZ2VSZWZdKSByZXR1cm4geyB1cmw6IGZpbGxzW2ltYWdlUmVmXSwgbm90ZTogJ0ZpZ21hIOWOn+Wbvu+8iOacquWQiOaIkOiKgueCueaViOaenO+8iScgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmICghdXJsc1tub2RlLmlkXSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDmnKrov5Tlm57pooTop4jvvIzpmpDol4/miJblpI3mnYLmlYjmnpzoioLngrnlj6/og73ml6Dms5XljZXni6zmuLLmn5PjgIInKTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGUuaWRdLCBub3RlOiAnRmlnbWEg5b2T5YmN6IqC54K55riy5p+T77yI6ZqQ6JeP56WW5YWI5Y+v6IO95L2/6aKE6KeI6YCP5piO77yJJyB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIG9wZW5QYW5lbCgpIHtcclxuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFBsdWdpblN0YXRlKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNldFRva2VuKHZhbHVlOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuc2V0KHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgY2xlYXJUb2tlbigpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkudmVyaWZ5KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleTogdW5rbm93biwgb3ZlcnJpZGVzOiB1bmtub3duLCBzY29wZUlkczogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZ2V0Tm9kZVByZXZpZXcobm9kZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc3luY1ByZXZpZXcoKSB7XHJcbiAgICAgICAgcmV0dXJuIHByZXZpZXdDb21wb25lbnRTeW5jKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcERldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5kZXRlY3Qoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wcmV2aWV3KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFBhaXIocGFpclRva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wYWlyKHBhaXJUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwQXBwbHkocHJldmlld1Rva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcclxuICAgICAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCkge1xyXG4gICAgICAgIHJldHVybiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QpO1xyXG4gICAgfSxcclxuXHJcbiAgICBjYW5jZWxJbXBvcnQoKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoKSByZXR1cm4gc3RvcEltcG9ydEJhdGNoKCk7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydE1jcEJyaWRnZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XHJcblxyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxyXG4gICAgICAgIGlzSW1wb3J0QnVzeTogKCkgPT4gYWN0aXZlQmF0Y2ggIT09IG51bGwgfHwgYWN0aXZlQ29udHJvbGxlciAhPT0gbnVsbCB8fCByb3VuZHRyaXBDb250cm9sbGVyICE9PSBudWxsLFxyXG4gICAgICAgIGdldFN0YXRlOiBnZXRNY3BQbHVnaW5TdGF0ZSxcclxuICAgICAgICBmZXRjaERvY3VtZW50OiBmZXRjaEZpZ21hRG9jdW1lbnQsXHJcbiAgICAgICAgZ2V0UHJldmlldzogZ2V0Tm9kZVByZXZpZXcsXHJcbiAgICAgICAgc2F2ZVNldHRpbmdzLFxyXG4gICAgICAgIHBhdGNoU2V0dGluZ3MsXHJcbiAgICAgICAgc2F2ZU5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgcGF0Y2hOb2RlTmFtZXMsXHJcbiAgICAgICAgaW1wb3J0U2VsZWN0aW9uOiAocmVxdWVzdCwgb3BlcmF0aW9uSWQpID0+IHBlcmZvcm1JbXBvcnQocmVxdWVzdCwgb3BlcmF0aW9uSWQpLFxyXG4gICAgICAgIGNhbmNlbEltcG9ydDogKG9wZXJhdGlvbklkKSA9PiB7XHJcbiAgICAgICAgICAgIGlmICghYWN0aXZlQ29udHJvbGxlciB8fCBhY3RpdmVPcGVyYXRpb25Pd25lciAhPT0gb3BlcmF0aW9uSWQpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgYWN0aXZlQ29udHJvbGxlci5hYm9ydCgpO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBuZXcgTWNwQnJpZGdlU2VydmVyKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBwbHVnaW5WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHBsdWdpbkluc3RhbmNlSWQsXHJcbiAgICAgICAgaW52b2tlOiAobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCkgPT4gYXBpLmludm9rZShtZXRob2QsIHBhcmFtcywgc2lnbmFsKSxcclxuICAgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBicmlkZ2Uuc3RhcnQoKTtcclxuICAgICAgICBtY3BBcGkgPSBhcGk7XHJcbiAgICAgICAgbWNwQnJpZGdlID0gYnJpZGdlO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBhd2FpdCBicmlkZ2UuY2xvc2UoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5ZCv5Yqo5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gYXdhaXQgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGVkaXRvclJlaW1wb3J0ZXIpO1xyXG4gICAgICAgIGNvbnN0IGFjdGl2ZSA9IHJlY292ZXJlZC5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyA9PT0gJ2FjdGl2ZS1vd25lcicpO1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGFjdGl2ZS5sZW5ndGhcclxuICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7YWN0aXZlLmxlbmd0aH0g5Liq5LuN55Sx5rS75Yqo6L+b56iL5oyB5pyJ55qEIFJvdW5kLXRyaXAg5LqL5Yqh77yM5pqC5pe256aB5q2iIFBhaXIvQXBwbHnjgIJgXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYFJvdW5kLXRyaXAg5ZCv5Yqo5oGi5aSN5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWA7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RhcnRNY3BCcmlkZ2UoKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCkgYWN0aXZlQmF0Y2guc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICBiYXRjaERvY3VtZW50cy5jbGVhcigpO1xyXG4gICAgbGFzdEJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkO1xyXG4gICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbiAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIHZvaWQgYnJpZGdlPy5jbG9zZSgpLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5YWz6Zet5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfSk7XHJcbn1cclxuIl19