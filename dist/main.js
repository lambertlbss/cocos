"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.overflowingRenderFrame = overflowingRenderFrame;
exports.decisionMap = decisionMap;
exports.subtreeHasExplicitOverride = subtreeHasExplicitOverride;
exports.syncMarkersEnabled = syncMarkersEnabled;
exports.applyLocalParentPromotion = applyLocalParentPromotion;
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
/**
 * 本地同名素材把父容器整体提升为 PNG 整层：该父容器的子层不再单独建节点。
 * 导入与"改动预检"共用这段规则，避免预检把被吸收的子层报成"新增"。
 */
/**
 * 同步标记适用于插件的全部单节点链接：任意根类型（Frame / Group / Component / Instance…）
 * 都生成 FigmaSyncNode；整份文件导入与多根来源不生成。
 */
function syncMarkersEnabled(sourceNodeId, rootCount) {
    return Boolean(sourceNodeId) && rootCount === 1;
}
async function applyLocalParentPromotion(roots, decisions, matchesLocal, protectedDescendant, hasAsset = () => false) {
    const promote = async (node) => {
        if (hasAsset(node.id) || (0, mask_tint_1.analyzeMaskTint)(node)) {
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
            && !(0, analyzer_1.hasHiddenDescendant)(node)
            && await matchesLocal(node)) {
            decisions.set(node.id, { ...decision, action: 'render', nineSlice: false });
            return;
        }
        await Promise.all(node.children.map(promote));
    };
    await Promise.all(roots.map(promote));
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
async function buildAssets(session, decisions, importSettings, review, options = {}) {
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
    const findLocal = async (name, includeOutput = true, nodeId) => {
        var _a;
        // 组件同步：只有像素指纹判定为"图片已变化"的节点才跳过本地素材复用；
        // 没变化的节点继续引用项目里的同名素材，不生成重复图片。
        if (nodeId && ((_a = options.regenerateNodeIds) === null || _a === void 0 ? void 0 : _a.has(nodeId))) {
            return null;
        }
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
    await applyLocalParentPromotion(session.roots, decisions, async (node) => Boolean(await findLocal(node.name, false, node.id)), protectedDescendant, (nodeId) => assets.has(nodeId));
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
                const match = await findLocal(group.node.name, false, group.node.id);
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
            const localMatch = (0, mask_tint_1.analyzeMaskTint)(node) && !sliceAnalysis ? null : await findLocal(node.name, false, node.id);
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
            const match = await findLocal(group.node.name, false, group.node.id);
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
        const named = await findLocal(node.name, false, node.id);
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
    var _a, _b, _c;
    const sourceHash = (0, prefab_sync_1.figmaFrameSourceHash)(args.fileKey, args.sourceNodeId);
    const prepared = await prepareLinkedFramePrefab(args.prefabUrl, args.prefabName, {
        x: args.rootFrame.x * args.scale,
        y: args.rootFrame.y * args.scale,
        width: args.rootFrame.width * args.scale,
        height: args.rootFrame.height * args.scale,
    }, sourceHash, args.roots[0].figmaId);
    await waitForOpenedPrefab(prepared.info.url, prepared.info.uuid, prepared.record.rootFileId);
    const existingNodeFileIds = (0, prefab_sync_1.resolveExistingNodeFileIds)(prepared.record, (0, prefab_sync_1.collectSceneSpecFigmaIds)(args.roots));
    // 未勾选的节点在本次计划里不存在，但它们仍属于受管节点：把已知 fileId 传给
    // Scene 作为保留集合，避免"删除"分支把它们清掉。
    const retainNodeFileIds = ((_a = args.skipSyncNodeIds) === null || _a === void 0 ? void 0 : _a.size)
        ? Object.values((0, prefab_sync_1.resolveExistingNodeFileIds)(prepared.record, args.skipSyncNodeIds))
        : [];
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
        // 未勾选的节点不在本次重建结果里，保留它们原有的 fileId 映射。
        const retainedRecord = ((_b = args.skipSyncNodeIds) === null || _b === void 0 ? void 0 : _b.size)
            ? (0, prefab_sync_1.retainPrefabSyncEntries)(prepared.record, nextRecord, args.skipSyncNodeIds)
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
        if ((_c = args.skipSyncNodeIds) === null || _c === void 0 ? void 0 : _c.size) {
            const skippedFileIds = Object.values((0, prefab_sync_1.resolveExistingNodeFileIds)(prepared.record, args.skipSyncNodeIds));
            if (skippedFileIds.length) {
                const extras = (0, prefab_sync_1.collectPrefabComponentFileIds)(await (0, promises_1.readFile)(prefabDiskPath(currentInfo.url)), skippedFileIds).filter((fileId) => !retainedRecord.managedComponentFileIds.includes(fileId));
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
        const currentRecord = (0, prefab_sync_1.readPrefabSyncRecord)(currentMeta);
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
    // 与真实导入保持一致的第一步：本地同名素材命中时把父容器整体提升为整层。
    const localLibraries = settings.localResourceFolders
        .map((folder) => {
        try {
            return new local_resources_1.LocalResourceLibrary(folder);
        }
        catch {
            return null;
        }
    })
        .filter((library) => library !== null);
    if (localLibraries.length) {
        await Promise.all(localLibraries.map((library) => library.initialize()));
        const protectedPreview = (node) => node.children.some((child) => {
            const childDecision = decisionForNode(child, decisions);
            if (childDecision.action === 'ignore')
                return false;
            return Boolean(child.isMask || child.children.some((part) => part.isMask)
                || childDecision.nineSlice || (0, analyzer_1.isNamedSliceGroup)(child) || (0, analyzer_1.isPatchCandidate)(child))
                || (childDecision.action !== 'render' && protectedPreview(child));
        });
        await applyLocalParentPromotion(document.roots, decisions, async (node) => {
            for (const library of localLibraries) {
                if (await library.find(node.name, 'png')) {
                    return true;
                }
            }
            return false;
        }, protectedPreview);
    }
    // 与真实导入保持一致的第二步：自动折叠/收口决定生效后再编译计划。
    const resolved = (0, import_planner_1.resolveAutomaticMergeDecisions)(document.roots, decisions);
    decisions.clear();
    resolved.forEach((value, key) => decisions.set(key, value));
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
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
        // 改动清单里未勾选的节点：本次按"忽略"处理，既不更新也不创建；它们的旧标记
        // 不会被重写，因此下次导入仍会作为待更新项出现。
        const skipSyncNodeIds = new Set(((_b = request.skipSyncNodeIds) !== null && _b !== void 0 ? _b : [])
            .filter((id) => typeof id === 'string' && Boolean(id.trim()))
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
        const reviewRecorder = new import_review_1.ImportReviewRecorder();
        // 组件同步（单节点 COMPONENT/INSTANCE 链接）：先用像素指纹算出哪些节点的
        // 图片内容确实变了，只有这些节点在资源准备阶段跳过本地同名素材复用。
        const syncMode = syncMarkersEnabled(document.sourceNodeId, document.roots.length);
        let regenerateNodeIds;
        if (syncMode && importSettings.refreshAssets) {
            try {
                const prefabWriter = new assets_1.AssetWriter(importSettings.prefabFolder);
                const prefabUrl = `db://assets/${prefabWriter.folder}/`
                    + `${(0, assets_1.sanitizeAssetName)(document.roots[0].name)}.prefab`;
                if (await queryPrefabAsset(prefabUrl)) {
                    const previous = (0, sync_preview_1.readPrefabSyncMarkers)(await (0, promises_1.readFile)(prefabDiskPath(prefabUrl)));
                    if (previous.size) {
                        const stale = new Set();
                        const visit = (node) => {
                            const before = previous.get(node.id.replace(/-/g, ':'));
                            const fresh = (0, sync_marker_1.createSyncMarker)({ fileKey: document.fileKey, node });
                            const pixelComparable = typeof (before === null || before === void 0 ? void 0 : before.pixelHash) === 'string'
                                && typeof fresh.pixelHash === 'string';
                            const changed = before
                                ? pixelComparable
                                    ? before.pixelHash !== fresh.pixelHash
                                    : before.subtreeHash !== fresh.subtreeHash
                                : true;
                            if (changed)
                                stale.add(node.id);
                            node.children.forEach(visit);
                        };
                        document.roots.forEach(visit);
                        regenerateNodeIds = stale;
                    }
                }
            }
            catch {
                // 预检失败不阻断导入：退回"所有节点都按现有规则处理"。
                regenerateNodeIds = undefined;
            }
        }
        const builtAssets = await (0, diagnostics_1.diagnosticTask)('准备全部资源', undefined, () => buildAssets(document, decisions, importSettings, reviewRecorder, { regenerateNodeIds }));
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
            : (_d = (_c = sourceRootFrames[0]) === null || _c === void 0 ? void 0 : _c.width) !== null && _d !== void 0 ? _d : 0;
        const rootFrame = multipleRoots
            ? {
                x: 0,
                y: 0,
                width: arrangedWidth,
                height: Math.max(0, ...sourceRootFrames.map((frame) => frame.height)),
            }
            : (_e = sourceRootFrames[0]) !== null && _e !== void 0 ? _e : { x: 0, y: 0, width: 0, height: 0 };
        let rootCursor = 0;
        // 组件级同步：只有单节点链接、且根节点确实是组件（或实例）时启用。
        // Frame 链接保持原有行为，不生成标记、不额外创建项目脚本。
        const syncContext = syncMode ? { fileKey: document.fileKey } : undefined;
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
            const frameName = ((_g = (_f = roots[0]) === null || _f === void 0 ? void 0 : _f.name) === null || _g === void 0 ? void 0 : _g.trim())
                || ((_j = (_h = document.roots[0]) === null || _h === void 0 ? void 0 : _h.name) === null || _j === void 0 ? void 0 : _j.trim())
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
                skipSyncNodeIds,
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
            existingMap: (_k = nodeMaps[document.fileKey]) !== null && _k !== void 0 ? _k : {},
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
            throw new Error('这个 Section 下没有可独立导入的外层 Frame 或 Component。');
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
        syncPreview: () => previewComponentSync(),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQWdoQkEsd0RBZ0JDO0FBOEJELGtDQTJCQztBQUVELGdFQVNDO0FBVUQsZ0RBRUM7QUFFRCw4REFnQ0M7QUE2RkQsd0NBcUNDO0FBbUVELGtDQXV2QkM7QUF5Q0QsNEJBa0hDO0FBaWdERCxvQkFhQztBQUVELHdCQWdCQztBQXp3R0QsK0JBQThFO0FBQzlFLDJCQUFnQztBQUNoQyxtQ0FBcUM7QUFDckMsK0NBQWdFO0FBQ2hFLDBDQUFnRDtBQUNoRCxtRUFBMEM7QUFDMUMsMkNBQThFO0FBQzlFLCtDQVcwQjtBQUMxQiwyQ0FBK0M7QUFDL0MsMkRBS2dDO0FBQ2hDLGlEQUF5RTtBQUN6RSw2Q0FBdUU7QUFDdkUscUNBQStDO0FBQy9DLHFEQUkwQjtBQUMxQix3REFLZ0M7QUFDaEMsb0VBQW9FO0FBQ3BFLDBEQUtpQztBQUNqQyw4Q0FPMkI7QUFDM0IsNENBQXVFO0FBRXZFLGdFQUFrRTtBQUNsRSx3Q0FBNkM7QUFDN0Msc0RBQXVEO0FBQ3ZELDJEQUFxRDtBQUNyRCw0REFBaUQ7QUFDakQsb0RBQTBGO0FBQzFGLHNEQUEyRDtBQUMzRCx3REFjZ0M7QUFDaEMsd0RBQW9EO0FBQ3BELHVDQUF1RTtBQUN2RSxnREFBc0Q7QUFDdEQsaURBQXVEO0FBQ3ZELG1EQUFzRTtBQUN0RSx5REFBMkQ7QUFDM0QsbUNBbUJpQjtBQUNqQiwyQ0FBK0M7QUFDL0MsNERBQXFGO0FBQ3JGLDhFQUF5RTtBQUV6RSxpREFBeUY7QUFNekYsTUFBTSxLQUFLLEdBQUcsSUFBSSx3QkFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsTUFBTSxhQUFhLEdBQUcsSUFBSSxtQ0FBbUIsRUFBRSxDQUFDO0FBQ2hELElBQUksb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0FBQ2pDLElBQUksY0FBYyxHQUEyQixJQUFJLENBQUM7QUFDbEQsSUFBSSxnQkFBZ0IsR0FBMkIsSUFBSSxDQUFDO0FBQ3BELElBQUksb0JBQW9CLEdBQWtCLElBQUksQ0FBQztBQUMvQyxJQUFJLG1CQUFtQixHQUEyQixJQUFJLENBQUM7QUFDdkQsSUFBSSxhQUFhLEdBQTBCLElBQUksQ0FBQztBQUNoRCxJQUFJLHdCQUF3QixHQUFrQixJQUFJLENBQUM7QUFDbkQsSUFBSSxnQkFBZ0IsR0FBRyxDQUFDLENBQUM7QUFDekIsSUFBSSxTQUFTLEdBQTJCLElBQUksQ0FBQztBQUM3QyxJQUFJLE1BQU0sR0FBK0IsSUFBSSxDQUFDO0FBQzlDLE1BQU0sZ0JBQWdCLEdBQUcsSUFBQSxvQkFBVyxFQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMvRCxJQUFJLHNCQUFzQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDOUQsSUFBSSxrQkFBa0IsR0FBa0IsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQzFELE1BQU0sZUFBZSxHQUFHLEdBQUcsQ0FBQztBQUM1QixNQUFNLGNBQWMsR0FBRyxJQUFJLEdBQUcsRUFBK0QsQ0FBQztBQU85RixJQUFJLFdBQVcsR0FBb0IsSUFBSSxDQUFDO0FBQ3hDLElBQUksZUFBOEMsQ0FBQztBQWdFbkQsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUM3RSxNQUFNLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBVztJQUNqQyxNQUFNO0lBQ04sTUFBTTtJQUNOLFFBQVE7SUFDUixPQUFPO0lBQ1AsVUFBVTtJQUNWLFFBQVE7SUFDUixZQUFZO0lBQ1osUUFBUTtDQUNYLENBQUMsQ0FBQztBQUVILEtBQUssVUFBVSxjQUFjO0lBQ3pCLE1BQU0sVUFBVSxHQUFHLElBQUEsY0FBTyxFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQzFELE1BQU0sS0FBSyxHQUFzQixFQUFFLENBQUM7SUFDcEMsS0FBSyxVQUFVLEtBQUssQ0FBQyxNQUFjO1FBQy9CLElBQUksT0FBTyxDQUFDO1FBQ1osSUFBSSxDQUFDO1lBQ0QsT0FBTyxHQUFHLE1BQU0sSUFBQSxrQkFBTyxFQUFDLE1BQU0sRUFBRSxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1FBQzdELENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxPQUFPO1FBQ1gsQ0FBQztRQUNELEtBQUssTUFBTSxLQUFLLElBQUksT0FBTyxFQUFFLENBQUM7WUFDMUIsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLGNBQWMsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO2dCQUNyRixTQUFTO1lBQ2IsQ0FBQztZQUNELE1BQU0sUUFBUSxHQUFHLElBQUEsV0FBSSxFQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDMUMsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQztnQkFDdEIsTUFBTSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ3RCLFNBQVM7WUFDYixDQUFDO1lBQ0QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsSUFBQSxjQUFPLEVBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDLEVBQUUsQ0FBQztnQkFDMUQsU0FBUztZQUNiLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxJQUFBLGVBQVEsRUFBQyxVQUFVLEVBQUUsUUFBUSxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztZQUNoRSxLQUFLLENBQUMsSUFBSSxDQUFDO2dCQUNQLElBQUksRUFBRSxJQUFBLGVBQVEsRUFBQyxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUEsY0FBTyxFQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDL0MsR0FBRyxFQUFFLGVBQWUsSUFBSSxFQUFFO2dCQUMxQixZQUFZLEVBQUUsSUFBSTthQUNyQixDQUFDLENBQUM7UUFDUCxDQUFDO0lBQ0wsQ0FBQztJQUNELE1BQU0sS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3hCLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxZQUFZLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN2RixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsUUFBdUI7SUFDekMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1FBQzlDLEdBQUcsUUFBUTtRQUNYLEdBQUcsQ0FBQyxXQUFXLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxhQUFhLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ25GLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxHQUFhOztJQUNoQyxNQUFNLE9BQU8sR0FBRyxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3JFLE9BQU87UUFDSCxPQUFPLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxNQUFNLEVBQUUsTUFBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsRUFBRSxtQ0FBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLElBQUksbUNBQUksRUFBRTtRQUNyRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU07UUFDekUsU0FBUyxFQUFFLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU07UUFDbkcsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhO1FBQ2hDLEtBQUssRUFBRSxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEdBQUcsSUFBSSxFQUFFLENBQUMsQ0FBQztLQUNoRCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQVMsa0JBQWtCO0lBQ3ZCLE9BQU8sSUFBQSxXQUFJLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsYUFBYSxDQUFDLENBQUM7QUFDeEUsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQWM7O0lBQ2hDLE1BQU0sS0FBSyxHQUFHLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQzVDLENBQUMsQ0FBQyxLQUFnQztRQUNsQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1QsTUFBTSxLQUFLLEdBQUcsT0FBTyxLQUFLLENBQUMsS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUM7UUFDekUsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQyxDQUFDLENBQUMsd0JBQWdCLENBQUMsS0FBSyxDQUFDO0lBQzdCLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxPQUFPLElBQUksT0FBTyxLQUFLLENBQUMsT0FBTyxLQUFLLFFBQVE7UUFDOUQsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDO2FBQzdDLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLElBQUksT0FBTyxJQUFJLEtBQUssUUFBUSxDQUFDO2FBQy9ELEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3JELENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDVCxNQUFNLGVBQWUsR0FBRyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQztRQUM3RCxDQUFDLENBQUMsS0FBSyxDQUFDLG9CQUFvQjtRQUM1QixDQUFDLENBQUMsT0FBTyxLQUFLLENBQUMsbUJBQW1CLEtBQUssUUFBUTtZQUMzQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsbUJBQW1CLENBQUM7WUFDN0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNiLE1BQU0sb0JBQW9CLEdBQUcsZUFBZTtTQUN2QyxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQW9CLEVBQUUsQ0FBQyxPQUFPLE1BQU0sS0FBSyxRQUFRLENBQUM7U0FDaEUsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7U0FDOUIsTUFBTSxDQUFDLE9BQU8sQ0FBQztTQUNmLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLLEtBQUssQ0FBQztTQUNyRSxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ2pCLE9BQU87UUFDSCxTQUFTLEVBQUUsT0FBTyxLQUFLLENBQUMsU0FBUyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRTtRQUM1RSxXQUFXLEVBQUUsT0FBTyxLQUFLLENBQUMsV0FBVyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRTtZQUMxRSxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUU7WUFDMUIsQ0FBQyxDQUFDLHdCQUFnQixDQUFDLFdBQVc7UUFDbEMsWUFBWSxFQUFFLE9BQU8sS0FBSyxDQUFDLFlBQVksS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUU7WUFDN0UsQ0FBQyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFO1lBQzNCLENBQUMsQ0FBQyx3QkFBZ0IsQ0FBQyxZQUFZO1FBQ25DLG9CQUFvQjtRQUNwQixtQkFBbUIsRUFBRSxNQUFBLG9CQUFvQixDQUFDLENBQUMsQ0FBQyxtQ0FBSSxFQUFFO1FBQ2xELEtBQUs7UUFDTCxjQUFjLEVBQUUsS0FBSyxDQUFDLGNBQWMsS0FBSyxLQUFLO1FBQzlDLGFBQWEsRUFBRSxLQUFLLENBQUMsYUFBYSxLQUFLLElBQUk7UUFDM0Msa0JBQWtCLEVBQUUsS0FBSyxDQUFDLGtCQUFrQixLQUFLLEtBQUs7UUFDdEQsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRLEtBQUssSUFBSTtRQUNqQyxPQUFPO0tBQ1YsQ0FBQztBQUNOLENBQUM7QUFFRCxLQUFLLFVBQVUsbUJBQW1CO0lBQzlCLElBQUksYUFBYSxFQUFFLENBQUM7UUFDaEIsT0FBTyxhQUFhLENBQUM7SUFDekIsQ0FBQztJQUNELE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZGLGFBQWEsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEMsT0FBTyxhQUFhLENBQUM7QUFDekIsQ0FBQztBQUVELEtBQUssVUFBVSxXQUFXO0lBQ3RCLE1BQU0sa0JBQWtCLENBQUM7SUFDekIsT0FBTyxtQkFBbUIsRUFBRSxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLHFCQUFxQixDQUFJLFNBQTJCO0lBQ3pELE1BQU0sTUFBTSxHQUFHLGtCQUFrQixDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNsRCxrQkFBa0IsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLFNBQVMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUNuRSxPQUFPLE1BQU0sQ0FBQztBQUNsQixDQUFDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxLQUFjO0lBQzNDLE9BQU8sQ0FBQyxLQUFLLElBQUksRUFBRTtRQUNmLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNqQyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDL0UsYUFBYSxHQUFHLElBQUksQ0FBQztRQUNyQixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ1QsQ0FBQztBQUVELFNBQVMsWUFBWSxDQUFDLEtBQWM7SUFDaEMsT0FBTyxxQkFBcUIsQ0FBQyxHQUFHLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ3ZFLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxLQUE4QjtJQUNqRCxPQUFPLHFCQUFxQixDQUFDLEtBQUssSUFBSSxFQUFFO1FBQ3BDLE1BQU0sT0FBTyxHQUFHLE1BQU0sbUJBQW1CLEVBQUUsQ0FBQztRQUM1QyxPQUFPLHVCQUF1QixDQUFDLEVBQUUsR0FBRyxPQUFPLEVBQUUsR0FBRyxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzdELENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELEtBQUssVUFBVSxNQUFNLENBQUMsU0FBa0MsZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsTUFBTTtJQUM1RSxPQUFPLElBQUksb0JBQVcsQ0FBQyxNQUFNLEtBQUssQ0FBQyxHQUFHLEVBQUUsRUFBRSxNQUFNLENBQUMsQ0FBQztBQUN0RCxDQUFDO0FBRUQsS0FBSyxVQUFVLGdCQUFnQixDQUFDLE1BQW9COztJQUNoRCxNQUFNLGNBQWMsR0FBRyxNQUFDLE1BQU0sQ0FBQyxHQUF1QyxDQUFDLE9BQU8sbUNBQUksU0FBUyxDQUFDO0lBQzVGLE9BQU8sSUFBSSwwQkFBZ0IsQ0FBQztRQUN4QixNQUFNLEVBQUUsTUFBTSxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQzVCLFdBQVcsRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUk7UUFDaEMsY0FBYztLQUNqQixDQUFDLENBQUM7QUFDUCxDQUFDO0FBRUQsU0FBUyx1QkFBdUI7SUFDNUIsSUFBSSxXQUFXLElBQUksZ0JBQWdCLElBQUksb0JBQW9CO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQ0FBbUMsQ0FBQyxDQUFDO0lBQ2xILG1CQUFtQixhQUFuQixtQkFBbUIsdUJBQW5CLG1CQUFtQixDQUFFLEtBQUssRUFBRSxDQUFDO0lBQzdCLE1BQU0sVUFBVSxHQUFHLElBQUksZUFBZSxFQUFFLENBQUM7SUFDekMsbUJBQW1CLEdBQUcsVUFBVSxDQUFDO0lBQ2pDLE9BQU8sVUFBVSxDQUFDO0FBQ3RCLENBQUM7QUFFRCxTQUFTLHdCQUF3QixDQUFDLFVBQTJCO0lBQ3pELElBQUksbUJBQW1CLEtBQUssVUFBVTtRQUFFLG1CQUFtQixHQUFHLElBQUksQ0FBQztBQUN2RSxDQUFDO0FBRUQsU0FBUyxjQUFjLENBQUMsUUFBdUIsSUFBSTtJQUMvQyxJQUFJLG9CQUFvQjtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUMvRCxJQUFJLG1CQUFtQjtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLENBQUMsQ0FBQztJQUN6RSxJQUFJLFdBQVcsSUFBSSxLQUFLLEtBQUssV0FBVyxDQUFDLEVBQUU7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDdkYsSUFBSSxnQkFBZ0IsRUFBRSxDQUFDO1FBQ25CLE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLENBQUMsQ0FBQztJQUNwRCxDQUFDO0lBQ0QsTUFBTSxVQUFVLEdBQUcsSUFBSSxlQUFlLEVBQUUsQ0FBQztJQUN6QyxnQkFBZ0IsR0FBRyxVQUFVLENBQUM7SUFDOUIsb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0lBQzdCLE9BQU8sVUFBVSxDQUFDO0FBQ3RCLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxVQUEyQjtJQUNoRCxJQUFJLGdCQUFnQixLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ2xDLGdCQUFnQixHQUFHLElBQUksQ0FBQztRQUN4QixvQkFBb0IsR0FBRyxJQUFJLENBQUM7SUFDaEMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLFlBQW9CO0lBQzdDLE1BQU0sVUFBVSxHQUFHLElBQUEsY0FBTyxFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQzFELE1BQU0sUUFBUSxHQUFHLElBQUEsY0FBTyxFQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ3ZDLE1BQU0sTUFBTSxHQUFHLElBQUEsZUFBUSxFQUFDLFVBQVUsRUFBRSxRQUFRLENBQUMsQ0FBQztJQUM5QyxJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sS0FBSyxHQUFHLElBQUksTUFBTSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFBLGlCQUFVLEVBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUM3RSxNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixDQUFDLENBQUM7SUFDbEQsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDdEMsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsUUFBZ0I7SUFDdEMsTUFBTSxVQUFVLEdBQUcsSUFBQSxjQUFPLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDMUQsTUFBTSxRQUFRLEdBQUcsSUFBQSxjQUFPLEVBQUMsUUFBUSxDQUFDLENBQUM7SUFDbkMsTUFBTSxJQUFJLEdBQUcsSUFBQSxlQUFRLEVBQUMsVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQzVDLE1BQU0sT0FBTyxHQUFHLElBQUksS0FBSyxJQUFJO1dBQ3RCLElBQUksQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDO1dBQ3RCLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDO1dBQ3ZCLElBQUEsaUJBQVUsRUFBQyxJQUFJLENBQUMsQ0FBQztJQUN4QixJQUFJLENBQUMsSUFBSSxJQUFJLElBQUksS0FBSyxHQUFHLElBQUksT0FBTyxFQUFFLENBQUM7UUFDbkMsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUNELE9BQU8sZUFBZSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDO0FBQ3JELENBQUM7QUFFRCxLQUFLLFVBQVUsZUFBZSxDQUFDLE9BQWdCO0lBSTNDLE1BQU0sVUFBVSxHQUFHLElBQUEsY0FBTyxFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBQzFELE1BQU0sYUFBYSxHQUFHLE9BQU8sT0FBTyxLQUFLLFFBQVE7UUFDN0MsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDO1FBQzlELENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDVCxNQUFNLGFBQWEsR0FBRyxhQUFhLElBQUksQ0FBQyxhQUFhLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQztRQUNsRSxDQUFDLENBQUMsSUFBQSxjQUFPLEVBQUMsVUFBVSxFQUFFLGFBQWEsQ0FBQztRQUNwQyxDQUFDLENBQUMsVUFBVSxDQUFDO0lBQ2pCLE1BQU0sV0FBVyxHQUFHLElBQUEsZUFBVSxFQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQztJQUMzRSxNQUFNLE1BQU0sR0FBRyxNQUFNLE1BQU0sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ3RDLEtBQUssRUFBRSxpQkFBaUI7UUFDeEIsSUFBSSxFQUFFLFdBQVc7UUFDakIsSUFBSSxFQUFFLFdBQVc7UUFDakIsTUFBTSxFQUFFLE1BQU07S0FDakIsQ0FBQyxDQUFDO0lBQ0gsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNyQyxJQUFJLE1BQU0sQ0FBQyxRQUFRLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUMvQixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQ0QsT0FBTztRQUNILE1BQU0sRUFBRSxtQkFBbUIsQ0FBQyxRQUFRLENBQUM7UUFDckMsWUFBWSxFQUFFLElBQUEsY0FBTyxFQUFDLFFBQVEsQ0FBQztLQUNsQyxDQUFDO0FBQ04sQ0FBQztBQUVELEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxPQUFnQjtJQUk1QyxNQUFNLFVBQVUsR0FBRyxJQUFBLGNBQU8sRUFBQyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztJQUMxRCxNQUFNLGFBQWEsR0FBRyxPQUFPLE9BQU8sS0FBSyxRQUFRO1FBQzdDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FBQztRQUM5RCxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1QsTUFBTSxhQUFhLEdBQUcsYUFBYSxJQUFJLENBQUMsYUFBYSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUM7UUFDbEUsQ0FBQyxDQUFDLElBQUEsY0FBTyxFQUFDLFVBQVUsRUFBRSxhQUFhLENBQUM7UUFDcEMsQ0FBQyxDQUFDLFVBQVUsQ0FBQztJQUNqQixNQUFNLFdBQVcsR0FBRyxJQUFBLGVBQVUsRUFBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUM7SUFDM0UsTUFBTSxNQUFNLEdBQUcsTUFBTSxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztRQUN0QyxLQUFLLEVBQUUsV0FBVztRQUNsQixJQUFJLEVBQUUsV0FBVztRQUNqQixJQUFJLEVBQUUsV0FBVztRQUNqQixNQUFNLEVBQUUsTUFBTTtLQUNqQixDQUFDLENBQUM7SUFDSCxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3JDLElBQUksTUFBTSxDQUFDLFFBQVEsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQy9CLE9BQU8sSUFBSSxDQUFDO0lBQ2hCLENBQUM7SUFDRCxPQUFPO1FBQ0gsTUFBTSxFQUFFLG1CQUFtQixDQUFDLFFBQVEsQ0FBQztRQUNyQyxZQUFZLEVBQUUsSUFBQSxjQUFPLEVBQUMsUUFBUSxDQUFDO0tBQ2xDLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLHVCQUF1QixDQUFDLE9BQWdCLEVBQUUsTUFBTSxHQUFHLENBQUM7SUFHL0QsTUFBTSxhQUFhLEdBQUcsT0FBTyxPQUFPLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUN4RSxNQUFNLFdBQVcsR0FBRyxhQUFhLElBQUksSUFBQSxpQkFBVSxFQUFDLGFBQWEsQ0FBQztRQUMxRCxDQUFDLENBQUMsYUFBYTtRQUNmLENBQUMsQ0FBQyxJQUFBLGNBQU8sRUFBQyxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztJQUM3QyxNQUFNLE1BQU0sR0FBRyxNQUFNLE1BQU0sQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ3RDLEtBQUssRUFBRSxZQUFZO1FBQ25CLElBQUksRUFBRSxXQUFXO1FBQ2pCLElBQUksRUFBRSxXQUFXO1FBQ2pCLE1BQU0sRUFBRSxNQUFNO0tBQ2pCLENBQUMsQ0FBQztJQUNILE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDckMsSUFBSSxNQUFNLENBQUMsUUFBUSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDL0IsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQztJQUNELE1BQU0sT0FBTyxHQUFHLElBQUksc0NBQW9CLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDbkQsT0FBTyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLEtBQWtCO0lBQ2xDLE1BQU0sTUFBTSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFpQixFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDckYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNqQixPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQy9DLENBQUM7SUFDRCxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEQsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3hFLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0lBQzFFLE9BQU8sRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxLQUFLLEdBQUcsQ0FBQyxFQUFFLE1BQU0sRUFBRSxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFDMUQsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLElBQWU7SUFDOUIsSUFBSSxJQUFJLENBQUMsbUJBQW1CLEVBQUUsQ0FBQztRQUMzQixPQUFPLElBQUksQ0FBQyxtQkFBbUIsQ0FBQztJQUNwQyxDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3ZCLE9BQU8sVUFBVSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNyQyxDQUFDO0lBQ0QsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUMvQyxDQUFDO0FBRUQsTUFBTSx1QkFBdUIsR0FBRyxHQUFHLENBQUM7QUFFcEM7Ozs7R0FJRztBQUNILFNBQWdCLHNCQUFzQixDQUFDLElBQWU7SUFDbEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDO0lBQzFDLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxvQkFBb0IsQ0FBQztJQUN6QyxJQUFJLENBQUMsUUFBUSxJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDbEUsT0FBTyxTQUFTLENBQUM7SUFDckIsQ0FBQztJQUNELE1BQU0sYUFBYSxHQUFHLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQztJQUNsRCxNQUFNLGNBQWMsR0FBRyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUM7SUFDcEQsTUFBTSxXQUFXLEdBQUcsTUFBTSxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO0lBQzVDLE1BQU0sWUFBWSxHQUFHLE1BQU0sQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUM5QyxPQUFPLE1BQU0sQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsR0FBRyx1QkFBdUI7V0FDL0MsTUFBTSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxHQUFHLHVCQUF1QjtXQUMvQyxXQUFXLEdBQUcsYUFBYSxHQUFHLHVCQUF1QjtXQUNyRCxZQUFZLEdBQUcsY0FBYyxHQUFHLHVCQUF1QjtRQUMxRCxDQUFDLENBQUMsTUFBTTtRQUNSLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDcEIsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQWU7O0lBQ2hDLElBQUksQ0FBQSxNQUFBLElBQUksQ0FBQyxvQkFBb0IsMENBQUUsTUFBTSxNQUFLLENBQUMsRUFBRSxDQUFDO1FBQzFDLE9BQU8sSUFBSSxDQUFDLG9CQUF3RCxDQUFDO0lBQ3pFLENBQUM7SUFDRCxNQUFNLE1BQU0sR0FBRyxNQUFBLElBQUksQ0FBQyxZQUFZLG1DQUFJLENBQUMsQ0FBQztJQUN0QyxPQUFPLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDNUMsQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLElBQWU7SUFDcEMsT0FBTztRQUNILE1BQU0sRUFBRSxJQUFBLHNCQUFXLEVBQUMsSUFBSSxDQUFDO1FBQ3pCLElBQUksRUFBRSxJQUFBLG9CQUFTLEVBQUMsSUFBSSxDQUFDO1FBQ3JCLFNBQVMsRUFBRSxJQUFBLDJCQUFnQixFQUFDLElBQUksQ0FBQztRQUNqQyxRQUFRLEVBQUUsS0FBSztLQUNsQixDQUFDO0FBQ04sQ0FBQztBQUVELFNBQVMsZUFBZSxDQUFDLElBQWUsRUFBRSxTQUFnQzs7SUFDdEUsTUFBTSxRQUFRLEdBQUcsTUFBQSxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsbUNBQUksZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2pFLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxNQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUN2RCxPQUFPLEVBQUUsR0FBRyxRQUFRLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLENBQUM7SUFDakUsQ0FBQztJQUNELElBQUksSUFBQSx1QkFBWSxFQUFDLElBQUksQ0FBQyxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDckQsT0FBTyxFQUFFLEdBQUcsUUFBUSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxDQUFDO0lBQy9ELENBQUM7SUFDRCxPQUFPLFFBQVEsQ0FBQztBQUNwQixDQUFDO0FBRUQsU0FBZ0IsV0FBVyxDQUFDLFNBQTJCLEVBQUUsSUFBbUI7SUFDeEUsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLEVBQW9CLENBQUM7SUFDOUMsTUFBTSxXQUFXLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUN0QyxNQUFNLFdBQVcsR0FBRyxDQUFDLEtBQW9CLEVBQUUsRUFBRTtRQUN6QyxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3ZCLElBQUksSUFBSSxDQUFDLGNBQWM7Z0JBQUUsV0FBVyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDbEQsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUEsNENBQTJCLEVBQUM7Z0JBQy9DLE1BQU0sRUFBRSxJQUFBLHNDQUFxQixFQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7Z0JBQzFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSTtnQkFDZixTQUFTLEVBQUUsSUFBSSxDQUFDLGNBQWM7Z0JBQzlCLFFBQVEsRUFBRSxLQUFLO2FBQ2xCLEVBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDbEMsV0FBVyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUMvQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBQ0YsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ2xCLEtBQUssTUFBTSxJQUFJLElBQUksU0FBUyxhQUFULFNBQVMsY0FBVCxTQUFTLEdBQUksRUFBRSxFQUFFLENBQUM7UUFDakMsTUFBTSxJQUFJLEdBQUcsSUFBQSw0QkFBZ0IsRUFBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDekMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUEsNENBQTJCLEVBQUM7WUFDL0MsTUFBTSxFQUFFLElBQUEsc0NBQXFCLEVBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztZQUMxQyxJQUFJLEVBQUUsVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU07WUFDcEQsU0FBUyxFQUFFLElBQUksQ0FBQyxTQUFTO1lBQ3pCLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUSxLQUFLLElBQUk7WUFDaEMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQzVCLEVBQUUsV0FBVyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xDLENBQUM7SUFDRCxPQUFPLFNBQVMsQ0FBQztBQUNyQixDQUFDO0FBRUQsU0FBZ0IsMEJBQTBCLENBQ3RDLElBQWUsRUFDZixTQUE4QyxFQUM5QyxlQUFlLEdBQUcsSUFBSTtJQUV0QixNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN4QyxPQUFPLENBQUEsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLFFBQVEsTUFBSyxJQUFJO1dBQzNCLENBQUMsZUFBZSxJQUFJLE9BQU8sQ0FBQyxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsSUFBSSxDQUFDLENBQUM7V0FDNUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLDBCQUEwQixDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQyxDQUFDO0FBQ3ZGLENBQUM7QUFFRDs7O0dBR0c7QUFDSDs7O0dBR0c7QUFDSCxTQUFnQixrQkFBa0IsQ0FBQyxZQUFnQyxFQUFFLFNBQWlCO0lBQ2xGLE9BQU8sT0FBTyxDQUFDLFlBQVksQ0FBQyxJQUFJLFNBQVMsS0FBSyxDQUFDLENBQUM7QUFDcEQsQ0FBQztBQUVNLEtBQUssVUFBVSx5QkFBeUIsQ0FDM0MsS0FBMkIsRUFDM0IsU0FBZ0MsRUFDaEMsWUFBbUQsRUFDbkQsbUJBQWlELEVBQ2pELFdBQXdDLEdBQUcsRUFBRSxDQUFDLEtBQUs7SUFFbkQsTUFBTSxPQUFPLEdBQUcsS0FBSyxFQUFFLElBQWUsRUFBaUIsRUFBRTtRQUNyRCxJQUFJLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksSUFBQSwyQkFBZSxFQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDN0MsT0FBTztRQUNYLENBQUM7UUFDRCxNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ2xELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUNqQyxPQUFPO1FBQ1gsQ0FBQztRQUNELElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNO2VBQ2pCLElBQUksQ0FBQyxJQUFJLEtBQUssTUFBTTtlQUNwQixDQUFDLFFBQVEsQ0FBQyxTQUFTO1lBQ3RCLGtDQUFrQztZQUNsQyxpQkFBaUI7ZUFDZCxDQUFDLDBCQUEwQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxDQUFDO1lBQ3RELDRCQUE0QjtlQUN6QixDQUFDLG1CQUFtQixDQUFDLElBQUksQ0FBQztZQUM3Qiw2QkFBNkI7ZUFDMUIsQ0FBQyxJQUFBLDhCQUFtQixFQUFDLElBQUksQ0FBQztlQUMxQixNQUFNLFlBQVksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQzlCLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLEdBQUcsUUFBUSxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDNUUsT0FBTztRQUNYLENBQUM7UUFDRCxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUNsRCxDQUFDLENBQUM7SUFDRixNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQzFDLENBQUM7QUFJRCxLQUFLLFVBQVUsc0JBQXNCO0lBQ2pDLE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzVGLE9BQU8sS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBNEIsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ2xGLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLEtBQWMsRUFBRSxVQUFVLEdBQUcsRUFBRTtJQUNyRCxJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNyRCxNQUFNLElBQUksR0FBRyxLQUFnQyxDQUFDO0lBQzlDLE1BQU0sRUFBRSxHQUFHLE9BQU8sSUFBSSxDQUFDLEVBQUUsS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO0lBQ3pFLElBQUksQ0FBQyxFQUFFO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDckIsTUFBTSxJQUFJLEdBQUcsT0FBTyxJQUFJLENBQUMsSUFBSSxLQUFLLFFBQVEsSUFBSSxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFnQixDQUFDO1FBQy9FLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBZ0I7UUFDdkIsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUNiLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLEtBQUssS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUN4RCxNQUFNLElBQUksR0FBRyxJQUFBLDRCQUFnQixFQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN6QyxJQUFJLENBQUMsUUFBUSxJQUFJLENBQUMsSUFBSTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3BDLE9BQU87UUFDSCxFQUFFO1FBQ0YsTUFBTSxFQUFFLElBQUEsc0NBQXFCLEVBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztRQUMxQyxJQUFJO1FBQ0osU0FBUyxFQUFFLElBQUksQ0FBQyxTQUFTLEtBQUssSUFBSTtRQUNsQyxRQUFRO1FBQ1IsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQzVCLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLGdCQUFnQixDQUFDLE9BQWU7O0lBQzNDLE1BQU0sTUFBTSxHQUFHLE1BQUEsQ0FBQyxNQUFNLHNCQUFzQixFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsbUNBQUksRUFBRSxDQUFDO0lBQy9ELE1BQU0sTUFBTSxHQUFxQixFQUFFLENBQUM7SUFDcEMsS0FBSyxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUMvQyxNQUFNLElBQUksR0FBRyxnQkFBZ0IsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDekMsSUFBSSxJQUFJO1lBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBQ0QsT0FBTyxNQUFNLENBQUM7QUFDbEIsQ0FBQztBQUVELFNBQVMseUJBQXlCLENBQUksU0FBMkI7SUFDN0QsTUFBTSxNQUFNLEdBQUcsc0JBQXNCLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3RELHNCQUFzQixHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsU0FBUyxFQUFFLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3ZFLE9BQU8sTUFBTSxDQUFDO0FBQ2xCLENBQUM7QUFFRCxLQUFLLFVBQVUseUJBQXlCLENBQ3BDLE9BQWdCLEVBQ2hCLE1BQWUsRUFDZixXQUFvQjs7SUFFcEIsSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQztRQUNqRCxNQUFNLElBQUksS0FBSyxDQUFDLDRCQUE0QixDQUFDLENBQUM7SUFDbEQsQ0FBQztJQUNELE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ2xELE1BQU0sU0FBUyxHQUFHLEtBQUs7U0FDbEIsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztTQUNyQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQTBCLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUM3RCxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FDcEIsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztTQUN4RSxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQWdCLEVBQUUsQ0FBQyxPQUFPLEVBQUUsS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQzNFLENBQUM7SUFDRixJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2pCLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBQ0QsTUFBTSxXQUFXLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztJQUN0RSxNQUFNLE1BQU0sR0FBRyxNQUFNLHNCQUFzQixFQUFFLENBQUM7SUFDOUMsTUFBTSxPQUFPLEdBQUcsRUFBRSxHQUFHLENBQUMsTUFBQSxNQUFNLENBQUMsT0FBTyxDQUFDLG1DQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDL0MsS0FBSyxNQUFNLEVBQUUsSUFBSSxRQUFRLEVBQUUsQ0FBQztRQUN4QixPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN2QixDQUFDO0lBQ0QsS0FBSyxNQUFNLElBQUksSUFBSSxXQUFXLEVBQUUsQ0FBQztRQUM3QixPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQztJQUM1QixDQUFDO0lBQ0QsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQzlCLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxPQUFPLENBQUM7SUFDOUIsQ0FBQztTQUFNLENBQUM7UUFDSixPQUFPLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBQ0QsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ3RGLE9BQU8sV0FBVyxDQUFDO0FBQ3ZCLENBQUM7QUFFRCxTQUFTLGlCQUFpQixDQUN0QixPQUFnQixFQUNoQixNQUFlLEVBQ2YsV0FBb0I7SUFFcEIsT0FBTyx5QkFBeUIsQ0FDNUIsR0FBRyxFQUFFLENBQUMseUJBQXlCLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxXQUFXLENBQUMsQ0FDaEUsQ0FBQztBQUNOLENBQUM7QUFFRCxTQUFnQixjQUFjLENBQUMsT0FBZSxFQUFFLE9BQTJCO0lBQ3ZFLE9BQU8seUJBQXlCLENBQUMsS0FBSyxJQUFJLEVBQUU7O1FBQ3hDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDO1FBQ25FLE1BQU0sTUFBTSxHQUFHLE1BQU0sc0JBQXNCLEVBQUUsQ0FBQztRQUM5QyxNQUFNLE9BQU8sR0FBRyxFQUFFLEdBQUcsQ0FBQyxNQUFBLE1BQU0sQ0FBQyxPQUFPLENBQUMsbUNBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQztRQUMvQyxNQUFNLFNBQVMsR0FBcUIsRUFBRSxDQUFDO1FBQ3ZDLEtBQUssTUFBTSxLQUFLLElBQUksT0FBTyxFQUFFLENBQUM7WUFDMUIsTUFBTSxFQUFFLEdBQUcsT0FBTyxLQUFLLENBQUMsRUFBRSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQy9ELElBQUksQ0FBQyxFQUFFO2dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMscUJBQXFCLENBQUMsQ0FBQztZQUNoRCxNQUFNLFFBQVEsR0FBRyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDbkQsTUFBTSxRQUFRLEdBQUcsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUN0RCxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQUcsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztZQUM1RSxJQUFJLENBQUMsSUFBSSxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssSUFBSSxFQUFFLENBQUM7Z0JBQy9CLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUNuQixTQUFTO1lBQ2IsQ0FBQztZQUNELElBQUksQ0FBQyxJQUFJO2dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsZUFBZSxFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQzFELElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLEVBQUUsQ0FBQztnQkFDdEIsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBQ3JCLENBQUM7aUJBQU0sQ0FBQztnQkFDSixNQUFNLElBQUksR0FBRyxJQUFBLDRCQUFnQixFQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDMUMsSUFBSSxDQUFDLElBQUk7b0JBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxlQUFlLEVBQUUsU0FBUyxDQUFDLENBQUM7Z0JBQ3ZELElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1lBQ3JCLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDeEMsSUFBSSxJQUFJLEVBQUUsQ0FBQztnQkFDUCxPQUFPLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDO2dCQUNuQixTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3pCLENBQUM7aUJBQU0sQ0FBQztnQkFDSixPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUN2QixDQUFDO1FBQ0wsQ0FBQztRQUNELElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxNQUFNO1lBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxHQUFHLE9BQU8sQ0FBQzs7WUFDdEQsT0FBTyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDNUIsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ3RGLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELFNBQVMsb0JBQW9CLENBQUMsT0FBd0I7SUFDbEQsTUFBTSxRQUFRLEdBQUcsV0FBVyxDQUFDLEVBQUUsRUFBRSxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDL0MsT0FBTyxDQUFDLElBQUksR0FBRyxJQUFBLDJDQUEwQixFQUNyQyxPQUFPLENBQUMsSUFBSSxFQUNaLElBQUEsa0NBQWlCLEVBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxRQUFRLENBQUMsQ0FDN0MsQ0FBQztJQUNGLE9BQU8sT0FBTyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLG9CQUFvQixDQUN6QixLQUFrQixFQUNsQixTQUFnQyxFQUNoQyxXQUFnQyxJQUFJLEdBQUcsRUFBRTtJQUV6QyxNQUFNLEdBQUcsR0FBZ0IsRUFBRSxDQUFDO0lBQzVCLE1BQU0sS0FBSyxHQUF3QixFQUFFLENBQUM7SUFDdEMsTUFBTSxTQUFTLEdBQTJCLEVBQUUsQ0FBQztJQUM3QyxNQUFNLFNBQVMsR0FBZ0IsRUFBRSxDQUFDO0lBQ2xDLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBZSxFQUFFLGdCQUF5QixFQUFFLEVBQUU7UUFDekQsSUFBSSxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFBRSxPQUFPO1FBQ2xDLE1BQU0sUUFBUSxHQUFHLGVBQWUsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDbEQsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1lBQ2xFLE9BQU87UUFDWCxDQUFDO1FBQ0QsTUFBTSxrQkFBa0IsR0FBRyxnQkFBZ0IsSUFBSSxJQUFJLENBQUMsT0FBTyxLQUFLLEtBQUssSUFBSSxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsQ0FBQztRQUMxRixJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7WUFDdkIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsa0JBQWtCLENBQUMsQ0FBQyxDQUFDO1lBQ25FLE9BQU87UUFDWCxDQUFDO1FBQ0QsSUFBSSxRQUFRLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDckIsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNmLE9BQU87UUFDWCxDQUFDO1FBQ0QsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQy9CLE1BQU0sTUFBTSxHQUFHLElBQUEsaUNBQXNCLEVBQUMsSUFBSSxDQUFDLENBQUM7WUFDNUMsSUFBSSxNQUFNLEVBQUUsQ0FBQztnQkFDVCxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7WUFDakMsQ0FBQztpQkFBTSxDQUFDO2dCQUNKLGdFQUFnRTtnQkFDaEUsa0VBQWtFO2dCQUNsRSxNQUFNLFFBQVEsR0FBRyxJQUFBLDhCQUFtQixFQUFDLElBQUksQ0FBQyxDQUFDO2dCQUMzQyxJQUFJLFFBQVEsRUFBRSxDQUFDO29CQUNYLFNBQVMsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLENBQUMsQ0FBQztnQkFDdkMsQ0FBQztxQkFBTSxDQUFDO29CQUNKLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ25CLENBQUM7WUFDTCxDQUFDO1lBQ0QsT0FBTztRQUNYLENBQUM7UUFDRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDakMsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxPQUFPLEtBQUssS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7WUFDcEcsSUFBSSxJQUFJLEVBQUUsQ0FBQztnQkFDUCxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxFQUFFLENBQUM7b0JBQ3ZCLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3pCLENBQUM7cUJBQU0sQ0FBQztvQkFDSixHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNuQixDQUFDO1lBQ0wsQ0FBQztRQUNMLENBQUM7UUFDRCxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxrQkFBa0IsQ0FBQyxDQUFDLENBQUM7SUFDdkUsQ0FBQyxDQUFDO0lBQ0YsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQzNDLE9BQU8sRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsQ0FBQztBQUNoRCxDQUFDO0FBRU0sS0FBSyxVQUFVLFdBQVcsQ0FDN0IsT0FBd0IsRUFDeEIsU0FBZ0MsRUFDaEMsY0FBOEIsRUFDOUIsTUFBNEIsRUFDNUIsVUFBdUQsRUFBRTs7SUFFekQsTUFBTSxNQUFNLEdBQUcsSUFBQSxrQ0FBYyxFQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsY0FBYyxDQUFDLGtCQUFrQixLQUFLLEtBQUssQ0FBQyxDQUFDO0lBQzFGLE1BQU0sZUFBZSxHQUFHLENBQUMsSUFBZSxFQUFRLEVBQUU7O1FBQzlDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFO2dCQUM1QyxHQUFHLENBQUMsTUFBQSxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsbUNBQUksZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsS0FBSzthQUMzRixDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQztJQUMzQyxDQUFDLENBQUM7SUFDRixPQUFPLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQztJQUN2QyxNQUFNLGlCQUFpQixHQUFHLElBQUEsK0NBQThCLEVBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQztJQUNuRixTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDbEIsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSxFQUFFLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUNyRSxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBbUIsQ0FBQztJQUMvQyxNQUFNLE1BQU0sR0FBRyxJQUFJLG9CQUFXLENBQUMsY0FBYyxDQUFDLFdBQVcsRUFBRSxLQUFLLEVBQUUsR0FBRyxFQUFFLE9BQU8sRUFBRSxFQUFFO1FBQzlFLE1BQU0sTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDdkMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDbEMsQ0FBQyxDQUFDLENBQUM7SUFDSCxNQUFNLE1BQU0sQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLHVCQUFlLENBQUMsa0JBQWtCLEVBQUUsQ0FBQyxDQUFDO0lBQ3hELE1BQU0sS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDO0lBQ3pCLE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQyxvQkFBb0I7U0FDckQsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxJQUFJLHNDQUFvQixDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7SUFDdkQsTUFBTSxPQUFPLENBQUMsR0FBRyxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDekUscUVBQXFFO0lBQ3JFLE1BQU0sVUFBVSxHQUFHLElBQUEsV0FBSSxFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdEUsTUFBTSxlQUFlLEdBQUcsSUFBQSxlQUFVLEVBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksc0NBQW9CLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUM3RixNQUFNLENBQUEsZUFBZSxhQUFmLGVBQWUsdUJBQWYsZUFBZSxDQUFFLFVBQVUsRUFBRSxDQUFBLENBQUM7SUFDcEMsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLEVBQTJCLENBQUM7SUFDbEQsMEVBQTBFO0lBQzFFLHVFQUF1RTtJQUN2RSxNQUFNLFlBQVksR0FBRyxJQUFJLEdBQUcsRUFBMkIsQ0FBQztJQUN4RCxNQUFNLFdBQVcsR0FBRyxDQUFDLElBQWUsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsY0FBYyxDQUFDLEtBQUssQ0FBQztTQUMvRixTQUFTLENBQUMsTUFBTSxDQUFDLENBQUMsaUJBQWlCLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUNuQyxNQUFNLElBQUksR0FBRyxDQUFDLE1BQWdFLEVBQUUsSUFBWSxFQUFFLE1BQWMsRUFBRSxHQUFZLEVBQUUsRUFBRSxXQUMxSCxPQUFBLE1BQUEsTUFBTSxDQUFDLElBQUksdURBQUcsTUFBTSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUEsRUFBQSxDQUFDO0lBQzdDLE1BQU0sU0FBUyxHQUFHLENBQUMsS0FBc0IsRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFNBQVMsRUFDakcsSUFBQSxlQUFRLEVBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLFdBQVcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQztRQUMzQyxDQUFDLENBQUMsbUJBQW1CO1FBQ3JCLENBQUMsQ0FBQyxvQkFBb0IsRUFBRSxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDM0MsTUFBTSxhQUFhLEdBQUcsQ0FBQyxJQUFlLEVBQUUsT0FBTyxHQUFHLFdBQVcsRUFBRSxFQUFFLENBQzdELElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsY0FBYyxDQUFDLEtBQUssRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQzlFLE1BQU0sY0FBYyxHQUFHLENBQUMsUUFBZ0IsRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7SUFDcEcsTUFBTSxZQUFZLEdBQUcsQ0FBQyxJQUFlLEVBQUUsRUFBRTtRQUNyQyxJQUFJLElBQUksR0FBRyxJQUFJLEVBQUUsWUFBWSxHQUFHLENBQUMsQ0FBQztRQUNsQyxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ2hDLElBQUksR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3hCLFlBQVksSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDO1FBQ2pDLENBQUM7UUFDRCxPQUFPLEVBQUUsSUFBSSxFQUFFLFlBQVksRUFBRSxDQUFDO0lBQ2xDLENBQUMsQ0FBQztJQUNGLE1BQU0sVUFBVSxHQUFHLEtBQUssRUFBRSxJQUFZLEVBQUUsRUFBRTtRQUN0QyxJQUFJLENBQUMsY0FBYyxDQUFDLGFBQWEsSUFBSSxlQUFlLEVBQUUsQ0FBQztZQUNuRCxNQUFNLEtBQUssR0FBRyxNQUFNLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ3RELElBQUksS0FBSztnQkFBRSxPQUFPLEVBQUUsR0FBRyxLQUFLLEVBQUUsTUFBTSxFQUFFLFVBQW1CLEVBQUUsQ0FBQztRQUNoRSxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUM7SUFDaEIsQ0FBQyxDQUFDO0lBQ0YsTUFBTSxTQUFTLEdBQUcsS0FBSyxFQUFFLElBQVksRUFBRSxhQUFhLEdBQUcsSUFBSSxFQUFFLE1BQWUsRUFBRSxFQUFFOztRQUM1RSxxQ0FBcUM7UUFDckMsOEJBQThCO1FBQzlCLElBQUksTUFBTSxLQUFJLE1BQUEsT0FBTyxDQUFDLGlCQUFpQiwwQ0FBRSxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUEsRUFBRSxDQUFDO1lBQ25ELE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7UUFDRCxLQUFLLE1BQU0sT0FBTyxJQUFJLGNBQWMsRUFBRSxDQUFDO1lBQ25DLE1BQU0sS0FBSyxHQUFHLE1BQU0sT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDOUMsa0VBQWtFO1lBQ2xFLGlFQUFpRTtZQUNqRSxJQUFJLEtBQUs7Z0JBQUUsT0FBTyxFQUFFLEdBQUcsS0FBSyxFQUFFLE1BQU0sRUFBRSxPQUFnQixFQUFFLENBQUM7UUFDN0QsQ0FBQztRQUNELE9BQU8sYUFBYSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNuRCxDQUFDLENBQUM7SUFDRixNQUFNLFdBQVcsR0FBRyxLQUFLLEVBQUUsSUFBZSxFQUFpQixFQUFFOztRQUN6RCxNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ2xELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxRQUFRLElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxXQUFXLElBQUksUUFBUSxDQUFDLFNBQVM7WUFBRSxPQUFPO1FBQ2xHLE1BQU0sUUFBUSxHQUFHLElBQUEsMkJBQWUsRUFBQyxJQUFJLENBQUMsQ0FBQztRQUN2QyxJQUFJLFFBQVEsSUFBSSxDQUFDLDBCQUEwQixDQUFDLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNsRSxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxHQUFHLFFBQVEsRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDNUYsSUFBSSxNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQztZQUM3QixJQUFJLFFBQVEsQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDckIsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsR0FBRyxRQUFRLENBQUMsU0FBUyxDQUFDO2dCQUMxQyxNQUFNLEtBQUssR0FBRyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3pDLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7Z0JBQzdELE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxNQUFNLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQztvQkFDcEQsQ0FBQyxDQUFDLE1BQU0sTUFBTSxDQUFDLGlCQUFpQixDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO2dCQUM1RSwrREFBK0Q7Z0JBQy9ELDREQUE0RDtnQkFDNUQsTUFBTSxLQUFLLEdBQUcsUUFBUSxJQUFJLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBTSxDQUFDLFFBQVE7b0JBQzdDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sSUFBQSxtQkFBUSxFQUFDLElBQUEsV0FBSSxFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQkFDaEcsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFBLCtCQUFtQixFQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGNBQWMsRUFBRSxDQUFDO2dCQUMvRixNQUFNLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQztnQkFDekIsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDO29CQUMxQixNQUFNLE1BQU0sR0FBRyxFQUFFLEdBQUcsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDO29CQUNsQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUM7b0JBQzVCLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxNQUFNLG1DQUFJLFVBQVUsQ0FBQyxDQUFDO29CQUN2RCxJQUFJLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsR0FBRyxRQUFRLENBQUMsTUFBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLDBCQUEwQixFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFDdEcsT0FBTztnQkFDWCxDQUFDO1lBQ0wsQ0FBQztZQUNELElBQUksQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0sMEJBQTBCLENBQUMsQ0FBQztZQUNqRSxPQUFPO1FBQ1gsQ0FBQztRQUNELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxRQUFRO1lBQUUsT0FBTztRQUN6QyxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsTUFBTSxXQUFXLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDaEUsQ0FBQyxDQUFDO0lBQ0YsS0FBSyxNQUFNLElBQUksSUFBSSxPQUFPLENBQUMsS0FBSztRQUFFLE1BQU0sV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzFELE1BQU0sbUJBQW1CLEdBQUcsQ0FBQyxJQUFlLEVBQVcsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDbkYsTUFBTSxhQUFhLEdBQUcsZUFBZSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQztRQUN4RCxJQUFJLGFBQWEsQ0FBQyxNQUFNLEtBQUssUUFBUTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ3BELE9BQU8sT0FBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7ZUFDbEUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksYUFBYSxDQUFDLFNBQVMsSUFBSSxJQUFBLDRCQUFpQixFQUFDLEtBQUssQ0FBQyxJQUFJLElBQUEsMkJBQWdCLEVBQUMsS0FBSyxDQUFDLENBQUM7ZUFDdkcsQ0FBQyxhQUFhLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQzdFLENBQUMsQ0FBQyxDQUFDO0lBQ0gsTUFBTSx5QkFBeUIsQ0FDM0IsT0FBTyxDQUFDLEtBQUssRUFDYixTQUFTLEVBQ1QsS0FBSyxFQUFFLElBQUksRUFBRSxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUNuRSxtQkFBbUIsRUFDbkIsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQ2pDLENBQUM7SUFDRixNQUFNLGNBQWMsR0FBRyxJQUFBLCtDQUE4QixFQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDaEYsU0FBUyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ2xCLGNBQWMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxLQUFLLEVBQUUsR0FBRyxFQUFFLEVBQUUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ2xFLE1BQU0sS0FBSyxHQUFHLElBQUEsa0NBQWlCLEVBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQztJQUMxRCxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQ3BDLE1BQU0sY0FBYyxHQUFHLENBQUMsSUFBZSxFQUFFLEVBQUU7UUFDdkMsTUFBTSxRQUFRLEdBQUcsZUFBZSxDQUFDLElBQUksRUFBRSxTQUFTLENBQUMsQ0FBQztRQUNsRCxJQUFJLFFBQVEsQ0FBQyxNQUFNLEtBQUssUUFBUTtZQUFFLE9BQU87UUFDekMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdkIsSUFBSSxJQUFBLGlDQUFnQixFQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsSUFBSSxRQUFRLENBQUMsU0FBUyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUFFLE9BQU87UUFDM0YsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDMUMsQ0FBQyxDQUFDO0lBQ0YsT0FBTyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDdEMsS0FBSyxNQUFNLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxJQUFJLEtBQUssRUFBRSxDQUFDO1FBQzdCLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUFFLFNBQVM7UUFDakMsTUFBTSxJQUFJLEdBQUcsTUFBQSxPQUFPLENBQUMsUUFBUSwwQ0FBRSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDdkMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLGNBQWM7WUFBRSxJQUFJLENBQUMsUUFBUSxFQUFFLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksbUNBQUksRUFBRSxFQUMvRCxNQUFBLElBQUksQ0FBQyxPQUFPLG1DQUFJLHdDQUF3QyxDQUFDLENBQUM7YUFDekQsSUFBSSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksbUNBQUksRUFBRSxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3BELElBQUksQ0FBQyxVQUFVLEVBQUUsTUFBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsSUFBSSxtQ0FBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3JELENBQUM7SUFDTCxDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsb0JBQW9CLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztJQUN4RixNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU07VUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEdBQUcsUUFBUSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUM7SUFDNUQsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDO0lBQ2xCLElBQUksVUFBVSxHQUFnQyxJQUFJLENBQUM7SUFFbkQsTUFBTSxNQUFNLEdBQUcsR0FBRyxFQUFFO1FBQ2hCLFVBQVUsYUFBVixVQUFVLGNBQVYsVUFBVSxJQUFWLFVBQVUsR0FBSyxJQUFBLDRCQUFjLEVBQUMsY0FBYyxFQUFFLFNBQVMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFDO1FBQ3pFLE9BQU8sVUFBVSxDQUFDO0lBQ3RCLENBQUMsQ0FBQztJQUVGLE1BQU0sYUFBYSxHQUFHLENBQ2xCLElBQWUsRUFDZixLQUFzQixFQUN0QixTQUFpRSxPQUFPLEVBQzFFLEVBQUU7UUFDQSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDM0IsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ2pDLElBQUksTUFBTSxLQUFLLE9BQU8sSUFBSSxNQUFNLEtBQUssVUFBVTtZQUFFLElBQUksQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLElBQUksRUFDckUsTUFBTSxLQUFLLE9BQU8sQ0FBQyxDQUFDLENBQUMsMENBQTBDO2dCQUMzRCxDQUFDLENBQUMsNENBQTRDLEVBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ25FLFNBQVMsSUFBSSxDQUFDLENBQUM7UUFDZixNQUFNLElBQUksR0FBRyxNQUFNLEtBQUssT0FBTztZQUMzQixDQUFDLENBQUMsUUFBUTtZQUNWLENBQUMsQ0FBQyxNQUFNLEtBQUssVUFBVTtnQkFDbkIsQ0FBQyxDQUFDLFFBQVE7Z0JBQ1YsQ0FBQyxDQUFDLE1BQU0sS0FBSyxXQUFXO29CQUNwQixDQUFDLENBQUMsTUFBTTtvQkFDWixDQUFDLENBQUMsTUFBTSxDQUFDO1FBQ2pCLFlBQVksQ0FBQztZQUNULEtBQUssRUFBRSxRQUFRO1lBQ2YsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNwQyxPQUFPLEVBQUUsR0FBRyxJQUFJLElBQUksU0FBUyxJQUFJLEtBQUssTUFBTSxJQUFJLENBQUMsSUFBSSxFQUFFO1NBQzFELENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQztJQUVGLE1BQU0sWUFBWSxHQUFHLEtBQUssRUFBRSxLQUEwQixFQUFFLEVBQUU7O1FBQ3RELElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDaEIsT0FBTztRQUNYLENBQUM7UUFjRCxNQUFNLGNBQWMsR0FBRyxDQUFDLE1BQXdCLEVBQUUsRUFBRSxDQUFDLGNBQWMsQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztRQUN6RixNQUFNLFdBQVcsR0FBRyxDQUFDLE1BQXdCLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssYUFBYTtZQUMzRSxDQUFDLENBQUMsSUFBQSx3QkFBZSxFQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUN6QyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ1IsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLEVBQXFCLENBQUM7UUFDNUMsS0FBSyxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ25DLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQzdCLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTztnQkFDeEIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJO2dCQUNqQixFQUFFLEVBQUUsTUFBTSxDQUFDLEVBQUU7Z0JBQ2IsVUFBVSxFQUFFLE1BQU0sQ0FBQyxLQUFLO2dCQUN4QixXQUFXLEVBQUUsV0FBVyxDQUFDLE1BQU0sQ0FBQzthQUNuQyxDQUFDLENBQUM7WUFDSCxNQUFNLFFBQVEsR0FBRyxJQUFBLDBCQUFjLEVBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO1lBQ25FLE1BQU0sR0FBRyxHQUFHLE1BQU0sQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxDQUFDO2lCQUN2RCxTQUFTLENBQUMsTUFBTSxDQUFDO2lCQUNqQixpQkFBaUIsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUNoQyxNQUFNLEtBQUssR0FBRyxNQUFBLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLG1DQUFJLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsQ0FBQztZQUNsRixLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN2QixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMzQixDQUFDO1FBQ0QsTUFBTSxhQUFhLEdBQUcsQ0FDbEIsWUFBeUIsRUFDekIsS0FBc0IsRUFDdEIsTUFBZ0QsRUFDbEQsRUFBRTtZQUNBLEtBQUssTUFBTSxXQUFXLElBQUksWUFBWSxFQUFFLENBQUM7Z0JBQ3JDLGFBQWEsQ0FBQyxXQUFXLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQzlDLENBQUM7UUFDTCxDQUFDLENBQUM7UUFDRixNQUFNLE9BQU8sR0FBa0IsRUFBRSxDQUFDO1FBQ2xDLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxFQUczQixDQUFDO1FBQ0wsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQztZQUNsQyxJQUFJLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDbkMsTUFBTSxJQUFJLHVCQUFjLEVBQUUsQ0FBQztZQUMvQixDQUFDO1lBQ0QsTUFBTSxPQUFPLEdBQUcsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN4QyxJQUFJLEtBQUssR0FBRyxlQUFlLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ3pDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztnQkFDVCxNQUFNLEtBQUssR0FBRyxNQUFNLFNBQVMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDckUsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQkFDN0QsTUFBTSxLQUFLLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQkFDaEUsSUFBSSxRQUFRLElBQUksQ0FBQyxLQUFLO29CQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0RBQXNELFFBQVEsRUFBRSxDQUFDLENBQUM7Z0JBQzFHLEtBQUssR0FBRyxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsQ0FBQztnQkFDekIsZUFBZSxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDeEMsQ0FBQztZQUNELElBQUksS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUNkLDREQUE0RDtnQkFDNUQsOERBQThEO2dCQUM5RCxhQUFhLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEdBQUcsS0FBSyxDQUFDLEtBQUssRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJO29CQUNuRSxTQUFTLEVBQUUsY0FBYyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDO2dCQUN4RCxTQUFTO1lBQ2IsQ0FBQztZQUNELElBQUksS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUNkLDREQUE0RDtnQkFDNUQsOERBQThEO2dCQUM5RCxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxLQUFLLEVBQUUsUUFBUSxFQUFFLEtBQUssQ0FBQyxLQUFLLENBQUMsUUFBUTtvQkFDbkQsU0FBUyxFQUFFLElBQUEsNkJBQW9CLEVBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsRUFBRSxVQUFVLEVBQUUsT0FBTyxFQUFFLGlCQUFpQixFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ3hHLFNBQVM7WUFDYixDQUFDO1lBQ0QsSUFBSSxhQUFhLEdBQTJCLElBQUksQ0FBQztZQUNqRCxJQUFJLENBQUMsY0FBYyxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUNoQyxhQUFhLEdBQUcsTUFBTSxNQUFNLENBQUMsaUJBQWlCLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ3BHLENBQUM7WUFDRCxJQUFJLGFBQWEsRUFBRSxDQUFDO2dCQUNoQixhQUFhLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxJQUFBLCtCQUFtQixFQUFDLGFBQWEsQ0FBQyxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUMzRSxTQUFTO1lBQ2IsQ0FBQztZQUNELElBQUksUUFBUSxHQUFrQixJQUFJLENBQUM7WUFDbkMsSUFBSSxlQUFpRCxDQUFDO1lBQ3RELElBQUksQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLENBQUM7Z0JBQ2hDLE1BQU0sVUFBVSxHQUFvQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxhQUFhO29CQUNuRixDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7b0JBQ1QsQ0FBQyxDQUFDLGdDQUF1QixDQUFDO2dCQUM5QixLQUFLLE1BQU0sU0FBUyxJQUFJLFVBQVUsRUFBRSxDQUFDO29CQUNqQyxNQUFNLE1BQU0sR0FBRyxNQUFNLEtBQUssQ0FBQyxJQUFJLENBQUM7d0JBQzVCLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTzt3QkFDeEIsTUFBTSxFQUFFLFFBQVEsS0FBSyxDQUFDLFNBQVMsRUFBRTt3QkFDakMsTUFBTSxFQUFFLFNBQVM7d0JBQ2pCLEtBQUssRUFBRSxXQUFXLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztxQkFDbkMsQ0FBQyxDQUFDO29CQUNILElBQUksTUFBTSxFQUFFLENBQUM7d0JBQ1QsUUFBUSxHQUFHLE1BQU0sQ0FBQzt3QkFDbEIsZUFBZSxHQUFHLFNBQVMsQ0FBQzt3QkFDNUIsTUFBTTtvQkFDVixDQUFDO2dCQUNMLENBQUM7WUFDTCxDQUFDO1lBQ0QsT0FBTyxDQUFDLElBQUksQ0FBQztnQkFDVCxHQUFHLEtBQUs7Z0JBQ1IsUUFBUTtnQkFDUixTQUFTLEVBQUUsZUFBZTtnQkFDMUIsVUFBVSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxPQUFPO2FBQzNDLENBQUMsQ0FBQztRQUNQLENBQUM7UUFFRCxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM3RCxNQUFNLFdBQVcsR0FBRyxJQUFJLEdBQUcsRUFBeUIsQ0FBQztRQUNyRCxNQUFNLGVBQWUsR0FBRyxJQUFJLEdBQUcsRUFBdUIsQ0FBQztRQUN2RCxLQUFLLE1BQU0sSUFBSSxJQUFJLFdBQVcsRUFBRSxDQUFDO1lBQzdCLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssYUFBYSxFQUFFLENBQUM7Z0JBQ3JDLFNBQVM7WUFDYixDQUFDO1lBQ0QsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUN2QyxNQUFNLEdBQUcsR0FBRyxNQUFBLGVBQWUsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLG1DQUFJLElBQUksR0FBRyxFQUFVLENBQUM7WUFDNUQsR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3hCLGVBQWUsQ0FBQyxHQUFHLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQ3BDLENBQUM7UUFDRCxLQUFLLE1BQU0sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLElBQUksZUFBZSxFQUFFLENBQUM7WUFDekMsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLE1BQU0sTUFBTSxFQUFFLENBQUMsQ0FBQyxZQUFZLENBQzVDLE9BQU8sQ0FBQyxPQUFPLEVBQ2YsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFDZixLQUFLLEVBQ0wsS0FBSyxDQUNSLENBQUM7WUFDRixLQUFLLE1BQU0sQ0FBQyxFQUFFLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUMzQyxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxVQUFVLEtBQUssRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ2pELENBQUM7UUFDTCxDQUFDO1FBQ0QsTUFBTSxlQUFlLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssV0FBVyxDQUFDLENBQUM7UUFDckYsTUFBTSxhQUFhLEdBQUcsZUFBZTtZQUNqQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sTUFBTSxFQUFFLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDO1lBQzFELENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDVCxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBMkIsQ0FBQztRQUNyRCxNQUFNLFFBQVEsR0FBRyxDQUFDLEdBQVcsRUFBRSxTQUFpQixFQUFFLEVBQUU7WUFDaEQsSUFBSSxJQUFJLEdBQUcsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUM5QixJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ1IsSUFBSSxHQUFHLE1BQU0sRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQztnQkFDNUQsU0FBUyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDN0IsQ0FBQztZQUNELE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUMsQ0FBQztRQUNGLEtBQUssTUFBTSxJQUFJLElBQUksT0FBTyxFQUFFLENBQUM7WUFDekIsSUFBSSxnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7Z0JBQ25DLE1BQU0sSUFBSSx1QkFBYyxFQUFFLENBQUM7WUFDL0IsQ0FBQztZQUNELElBQUksUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUM7WUFDN0IsSUFBSSxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUMvQixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ1osTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssYUFBYTtvQkFDaEQsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQ2IsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsVUFBVSxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQ3hEO29CQUNELENBQUMsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDcEMsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO29CQUNiLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLGFBQWE7d0JBQzVDLENBQUMsQ0FBQyxlQUFlLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxFQUFFO3dCQUNqQyxDQUFDLENBQUMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsRUFBRSxDQUFDO29CQUNuQyxNQUFNLElBQUksS0FBSyxDQUFDLGFBQWEsS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDNUQsQ0FBQztnQkFDRCxRQUFRLEdBQUcsTUFBTSxRQUFRLENBQUMsU0FBUyxFQUFFLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO2dCQUM1RSxTQUFTLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEtBQUssYUFBYTtvQkFDMUMsQ0FBQyxDQUFDLEtBQUs7b0JBQ1AsQ0FBQyxDQUFDLElBQUEsNkJBQW9CLEVBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ3JDLE1BQU0sS0FBSyxDQUFDLEtBQUssQ0FBQztvQkFDZCxPQUFPLEVBQUUsT0FBTyxDQUFDLE9BQU87b0JBQ3hCLE1BQU0sRUFBRSxRQUFRLElBQUksQ0FBQyxTQUFTLEVBQUU7b0JBQ2hDLE1BQU0sRUFBRSxTQUFTO29CQUNqQixLQUFLLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7aUJBQ2xDLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDakIsQ0FBQztZQUNELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDYixTQUFTLEdBQUcsSUFBQSw2QkFBb0IsRUFBQyxRQUFRLENBQUMsQ0FBQztZQUMvQyxDQUFDO1lBQ0QsTUFBTSxLQUFLLEdBQUcsSUFBQSw2QkFBZSxFQUFDLGFBQWEsRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7WUFDdkUsSUFBSSxNQUF3QyxDQUFDO1lBQzdDLElBQUksQ0FBQztnQkFBQyxNQUFNLEdBQUcsSUFBQSx5QkFBYSxFQUFDLFFBQVEsRUFBRSxjQUFjLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQUEsSUFBSSxDQUFDLGlCQUFpQixtQ0FBSSxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7WUFBQyxDQUFDO1lBQzFILE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ1gsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztnQkFDbEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxjQUFlLEtBQWUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3BGLENBQUM7WUFDRCxJQUFJLE1BQU0sQ0FBQyxPQUFPO2dCQUFFLFFBQVEsQ0FBQyxHQUFHLENBQUMsUUFBUSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksY0FBYyxNQUFNLENBQUMsS0FBSyxJQUFJLE1BQU0sQ0FBQyxNQUFNLDBCQUEwQixDQUFDLENBQUM7WUFDOUgsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ3ZFLGFBQWEsQ0FDVCxJQUFJLENBQUMsS0FBSyxFQUNWLElBQUEsK0JBQW1CLEVBQUMsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsUUFBUSxFQUFFLEVBQUUsU0FBUyxFQUFFLGNBQWMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsRUFDMUgsSUFBSSxDQUFDLFVBQVUsQ0FDbEIsQ0FBQztZQUNGLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxXQUFXLEVBQUUsTUFBTSxDQUFDLFdBQVcsRUFBRSxZQUFZLEVBQUUsTUFBTSxDQUFDLFlBQVk7Z0JBQzNFLEtBQUssRUFBRSxNQUFNLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3BFLENBQUM7SUFDTCxDQUFDLENBQUM7SUFFRixNQUFNLGFBQWEsR0FBRyxLQUFLLEVBQUUsS0FBa0IsRUFBRSxFQUFFOztRQUMvQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ2hCLE9BQU87UUFDWCxDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsS0FBYyxDQUFDO1FBQzlCLE1BQU0sTUFBTSxHQUFHLElBQUksR0FBRyxFQUErQyxDQUFDO1FBQ3RFLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7WUFDdkIsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FDdkIsSUFBSSxDQUFDLElBQUksRUFDVCxHQUFHLE9BQU8sQ0FBQyxPQUFPLElBQUksSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUMvQixNQUFNLEVBQ04sY0FBYyxDQUFDLEtBQUssQ0FDdkIsQ0FBQztZQUNGLE1BQU0sR0FBRyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM5QixNQUFNLEtBQUssR0FBRyxNQUFBLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLG1DQUFJLEVBQUUsR0FBRyxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsQ0FBQztZQUNwRCxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN2QixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMzQixDQUFDO1FBQ0QsTUFBTSxPQUFPLEdBVVIsRUFBRSxDQUFDO1FBQ1IsTUFBTSxhQUFhLEdBQUcsQ0FDbEIsWUFBeUIsRUFDekIsS0FBc0IsRUFDdEIsTUFBZ0QsRUFDbEQsRUFBRTtZQUNBLEtBQUssTUFBTSxXQUFXLElBQUksWUFBWSxFQUFFLENBQUM7Z0JBQ3JDLGFBQWEsQ0FBQyxXQUFXLEVBQUUsS0FBSyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQzlDLENBQUM7UUFDTCxDQUFDLENBQUM7UUFDRixLQUFLLE1BQU0sRUFBRSxHQUFHLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxJQUFJLE1BQU0sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDO1lBQ3pELElBQUksZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxDQUFDO2dCQUNuQyxNQUFNLElBQUksdUJBQWMsRUFBRSxDQUFDO1lBQy9CLENBQUM7WUFDRCxtRUFBbUU7WUFDbkUsZ0VBQWdFO1lBQ2hFLG9EQUFvRDtZQUNwRCxNQUFNLGFBQWEsR0FBRyxZQUFZLENBQUMsT0FBTyxDQUFDLENBQUMsU0FBUyxFQUFFLEVBQUU7Z0JBQ3JELElBQUksZUFBZSxDQUFDLFNBQVMsRUFBRSxTQUFTLENBQUMsQ0FBQyxNQUFNLEtBQUssUUFBUTtvQkFBRSxPQUFPLEVBQUUsQ0FBQztnQkFDekUsTUFBTSxRQUFRLEdBQUcsSUFBQSwwQkFBZ0IsRUFBQyxTQUFTLENBQUMsQ0FBQztnQkFDN0MsT0FBTyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUMzRCxDQUFDLENBQUMsQ0FBQztZQUNILE1BQU0sYUFBYSxHQUFHLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN2QyxNQUFNLElBQUksR0FBRyxNQUFBLGFBQWEsYUFBYixhQUFhLHVCQUFiLGFBQWEsQ0FBRSxJQUFJLG1DQUFJLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNwRCxNQUFNLFFBQVEsR0FBRyxNQUFBLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxtQ0FBSSxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDakUsTUFBTSxhQUFhLEdBQUcsTUFBQSxhQUFhLGFBQWIsYUFBYSx1QkFBYixhQUFhLENBQUUsUUFBUSxtQ0FBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUEsMEJBQWdCLEVBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3RHLE1BQU0sVUFBVSxHQUFHLENBQUMsS0FBc0IsRUFBRSxNQUE0QixFQUFFLEVBQUU7Z0JBQ3hFLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLEtBQUssQ0FBQyxDQUFDO2dCQUMzQyxJQUFJLFFBQVEsQ0FBQyxTQUFTLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7b0JBQ3RDLFFBQVEsQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLENBQUMsSUFBSSwrREFBK0QsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7Z0JBQ2hILENBQUM7Z0JBQ0QsYUFBYSxDQUFDLFlBQVksRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDL0MsQ0FBQyxDQUFDO1lBQ0YsTUFBTSxNQUFNLEdBQUcsYUFBYSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDL0UsSUFBSSxNQUFNLEVBQUUsQ0FBQztnQkFDVCxVQUFVLENBQUMsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUMvQixTQUFTO1lBQ2IsQ0FBQztZQUNELE1BQU0sVUFBVSxHQUFHLElBQUEsMkJBQWUsRUFBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDL0csaUVBQWlFO1lBQ2pFLGlFQUFpRTtZQUNqRSw4REFBOEQ7WUFDOUQsNkNBQTZDO1lBQzdDLE1BQU0sUUFBUSxHQUFHLFVBQVU7Z0JBQ3ZCLENBQUMsQ0FBQyxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDO2dCQUNuQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQ1gsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztZQUNyRSxJQUFJLFVBQVUsRUFBRSxDQUFDO2dCQUNiLFVBQVUsQ0FBQyxVQUFVLEVBQUUsVUFBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDO2dCQUMzQyxTQUFTO1lBQ2IsQ0FBQztZQUNELElBQUksUUFBUSxFQUFFLENBQUM7Z0JBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQyx1RUFBdUUsUUFBUSxFQUFFLENBQUMsQ0FBQztZQUN2RyxDQUFDO1lBQ0QsTUFBTSxXQUFXLEdBQUcsQ0FBQyxhQUFhLElBQUksQ0FBQyxVQUFVLElBQUksQ0FBQyxJQUFBLDJCQUFlLEVBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQ2pILElBQUksV0FBVyxFQUFFLENBQUM7Z0JBQ2QsTUFBTSxVQUFVLEdBQUcsTUFBTSxNQUFNLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUUsQ0FBQyxDQUFDO2dCQUM5RSxJQUFJLENBQUMsVUFBVTtvQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztnQkFDdEYsVUFBVSxDQUFDLFVBQVUsRUFBRSxVQUFVLENBQUMsQ0FBQztnQkFDbkMsU0FBUztZQUNiLENBQUM7WUFDRCxJQUFJLGFBQWEsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO2dCQUMvQixNQUFNLEtBQUssR0FBRyxDQUFDLEtBQTJCLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxJQUFJO29CQUNyRixPQUFPLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsbUJBQW1CLElBQUk7d0JBQ3RFLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLEtBQUssRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNO3FCQUM3RixFQUFFLENBQUMsQ0FBQztnQkFDVCxJQUFJLGFBQWEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEtBQUssS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLEVBQUUsQ0FBQztvQkFDaEYsTUFBTSxNQUFNLEdBQUcsOEJBQThCLElBQUksQ0FBQyxJQUFJLG1CQUFtQixDQUFDO29CQUMxRSxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO29CQUNyQixJQUFJLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDO2dCQUMzQyxDQUFDO2dCQUNELElBQUksQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLElBQUksRUFDcEIsc0RBQXNELEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDckUsQ0FBQztZQUNELElBQUksUUFBUSxDQUFDLFNBQVMsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO2dCQUN2QyxRQUFRLENBQUMsR0FBRyxDQUFDLFVBQVUsSUFBSSxDQUFDLElBQUksNEJBQTRCLENBQUMsQ0FBQztZQUNsRSxDQUFDO1lBQ0QsTUFBTSxPQUFPLEdBQUcsYUFBYSxhQUFiLGFBQWEsdUJBQWIsYUFBYSxDQUFFLE9BQU8sQ0FBQztZQUN2QyxnRUFBZ0U7WUFDaEUscURBQXFEO1lBQ3JELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN2RSxNQUFNLEdBQUcsR0FBa0I7Z0JBQ3ZCLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTztnQkFDeEIsTUFBTSxFQUFFLElBQUksQ0FBQyxFQUFFO2dCQUNmLE1BQU07Z0JBQ04sS0FBSyxFQUFFLGNBQWMsQ0FBQyxLQUFLO2dCQUMzQixPQUFPLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLENBQUMsU0FBUzthQUMxRCxDQUFDO1lBQ0YsSUFBSSxNQUFNLEdBQUcsVUFBVSxJQUFJLGNBQWMsQ0FBQyxhQUFhO2dCQUNuRCxDQUFDLENBQUMsSUFBSTtnQkFDTixDQUFDLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQzVCLElBQUksYUFBYSxJQUFJLE1BQU0sRUFBRSxDQUFDO2dCQUMxQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsbUJBQW9CLENBQUM7Z0JBQ3hDLE1BQU0sWUFBWSxHQUFHLElBQUEscUJBQUssRUFBQyxNQUFNLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxJQUFJLEVBQUU7dUJBQ2xELE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLEVBQUUsRUFBRSxFQUFFLENBQUMsS0FBSyxNQUFNO3VCQUMzQyxJQUFJLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLEtBQUssR0FBRyxjQUFjLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQzt1QkFDM0UsSUFBSSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEdBQUcsY0FBYyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDcEYsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO29CQUNoQixNQUFNLEdBQUcsSUFBSSxDQUFDO29CQUNkLElBQUksQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLElBQUksRUFBRSx1Q0FBdUMsRUFBRSxHQUFHLENBQUMsQ0FBQztnQkFDOUUsQ0FBQztZQUNMLENBQUM7WUFDRCxPQUFPLENBQUMsSUFBSSxDQUFDO2dCQUNULElBQUk7Z0JBQ0osS0FBSyxFQUFFLFlBQVk7Z0JBQ25CLEdBQUcsRUFBRSxVQUFVLElBQUksSUFBQSw2QkFBb0IsRUFBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEtBQUssS0FBSztvQkFDbEUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsU0FBUyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHO2dCQUMxQyxPQUFPO2dCQUNQLGFBQWEsRUFBRSxhQUFhLGFBQWIsYUFBYSxjQUFiLGFBQWEsR0FBSSxTQUFTO2dCQUN6QyxXQUFXLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFdBQVc7Z0JBQ2pELEdBQUc7Z0JBQ0gsUUFBUSxFQUFFLE1BQUEsVUFBVSxhQUFWLFVBQVUsdUJBQVYsVUFBVSxDQUFFLFFBQVEsbUNBQUksTUFBTTtnQkFDeEMsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTzthQUM1RCxDQUFDLENBQUM7UUFDUCxDQUFDO1FBQ0QsTUFBTSxJQUFJLEdBQWtDLEVBQUUsQ0FBQztRQUMvQyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUM3RCxLQUFLLE1BQU0saUJBQWlCLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUM1QyxNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUN2QyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxDQUNwRSxDQUFDLENBQUM7WUFDSCxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO2dCQUNoQixTQUFTO1lBQ2IsQ0FBQztZQUNELE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxNQUFNLE1BQU0sRUFBRSxDQUFDLENBQUMsWUFBWSxDQUNuRCxPQUFPLENBQUMsT0FBTyxFQUNmLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQ2pDLE1BQU0sRUFDTixjQUFjLENBQUMsS0FBSyxFQUNwQixpQkFBaUIsRUFDakIsTUFBTSxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUMxRSxDQUFDLENBQUM7UUFDUCxDQUFDO1FBQ0QsS0FBSyxNQUFNLElBQUksSUFBSSxPQUFPLEVBQUUsQ0FBQztZQUN6QixJQUFJLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDbkMsTUFBTSxJQUFJLHVCQUFjLEVBQUUsQ0FBQztZQUMvQixDQUFDO1lBQ0QsSUFBSSxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQztZQUM3QixJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ1osTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ3JDLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztvQkFDYixNQUFNLElBQUksS0FBSyxDQUFDLGdCQUFnQixJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBQ3RELENBQUM7Z0JBQ0QsUUFBUSxHQUFHLE1BQU0sQ0FBQyxNQUFNLE1BQU0sRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLFNBQVMsRUFBRSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQztnQkFDN0YsTUFBTSxLQUFLLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsUUFBUSxDQUFDLENBQUM7WUFDMUMsQ0FBQztZQUNELElBQUksZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsTUFBTSxDQUFDLE9BQU87Z0JBQUUsTUFBTSxJQUFJLHVCQUFjLEVBQUUsQ0FBQztZQUNqRSxJQUFJLEtBQXNCLENBQUM7WUFDM0IsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7Z0JBQ3JCLE1BQU0sS0FBSyxHQUFHLElBQUEsNkJBQWUsRUFBQyxXQUFXLEVBQUUsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUNyRSxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUEsMkJBQWMsRUFBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxRQUFRLEVBQUUsSUFBSSxDQUFDLElBQUksRUFDckUsSUFBSSxDQUFDLGFBQWEsRUFBRSxjQUFjLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQzlDLEtBQUssR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDO2dCQUNyQixLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQztnQkFDaEMsSUFBSSxDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUM1RCxRQUFRLE1BQUEsTUFBTSxDQUFDLFlBQVksQ0FBQyxNQUFNLG1DQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBTSxFQUFFLEVBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3ZGLENBQUM7aUJBQU0sQ0FBQztnQkFDSixLQUFLLEdBQUcsTUFBTSxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUNqRSxDQUFDO1lBQ0QsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ2pCLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQztZQUNoRCxJQUFJLEtBQUssQ0FBQyxhQUFhLEVBQUUsQ0FBQztnQkFDdEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSwwQkFBMEIsS0FBSyxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUM7WUFDMUYsQ0FBQztZQUNELEtBQUssTUFBTSxXQUFXLElBQUksSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUNuQyxhQUFhLENBQ1QsV0FBVyxFQUNYLElBQUksQ0FBQyxXQUFXO29CQUNaLENBQUMsQ0FBQyxFQUFFLEdBQUcsS0FBSyxFQUFFLFdBQVcsRUFBRSxNQUFBLHNCQUFzQixDQUFDLFdBQVcsQ0FBQyxtQ0FBSSxJQUFJLENBQUMsV0FBVyxFQUFFO29CQUNwRixDQUFDLENBQUMsS0FBSyxFQUNYLElBQUksQ0FBQyxNQUFNLENBQ2QsQ0FBQztZQUNOLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsTUFBTSxnQkFBZ0IsR0FBRyxLQUFLLEVBQUUsS0FBNkIsRUFBRSxFQUFFOztRQUM3RCxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU07WUFBRSxPQUFPO1FBQzFCLE1BQU0sTUFBTSxHQUFHLElBQUksR0FBRyxFQUFxRSxDQUFDO1FBQzVGLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7WUFDdkIsTUFBTSxHQUFHLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNuQyxNQUFNLEtBQUssR0FBRyxNQUFBLE1BQU0sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLG1DQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ3pGLEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM1QixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMzQixDQUFDO1FBRUQsSUFBSSxvQkFBd0UsQ0FBQztRQUM3RSxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBMkIsQ0FBQztRQUNyRCxNQUFNLGNBQWMsR0FBRyxDQUFDLEtBQWtCLEVBQUUsSUFBcUIsRUFDN0QsTUFBZ0QsRUFBRSxFQUFFO1lBQ3BELFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzlDLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7Z0JBQ3ZCLE1BQU0sRUFBRSxZQUFZLEVBQUUsR0FBRyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzVDLE1BQU0sS0FBSyxHQUFHLFlBQVksR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxJQUFJLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLFlBQVksRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztnQkFDakcsYUFBYSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7WUFDdkMsQ0FBQztRQUNMLENBQUMsQ0FBQztRQUNGLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7WUFDbEMsSUFBSSxnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxNQUFNLENBQUMsT0FBTztnQkFBRSxNQUFNLElBQUksdUJBQWMsRUFBRSxDQUFDO1lBQ2pFLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ3pELElBQUksTUFBTSxFQUFFLENBQUM7Z0JBQ1QsY0FBYyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUNoRCxTQUFTO1lBQ2IsQ0FBQztZQUNELE1BQU0sRUFBRSxJQUFJLEVBQUUsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzFDLE1BQU0sS0FBSyxHQUFHLE1BQU0sU0FBUyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3JFLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7WUFDN0QsSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDWCxNQUFNLFVBQVUsR0FBRyxNQUFNLE1BQU0sQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ25ELElBQUksQ0FBQyxVQUFVO29CQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsaUNBQWlDLFFBQVEsRUFBRSxDQUFDLENBQUM7Z0JBQzlFLGNBQWMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLFVBQVUsRUFBRSxLQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7Z0JBQ3ZELFNBQVM7WUFDYixDQUFDO1lBQ0QsTUFBTSxXQUFXLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sVUFBVSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztZQUN0RSxNQUFNLFFBQVEsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sTUFBTSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO1lBQ2pHLElBQUksUUFBUSxFQUFFLENBQUM7Z0JBQ1gsY0FBYyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsUUFBUSxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUNsRCxTQUFTO1lBQ2IsQ0FBQztZQUNELElBQUksV0FBVztnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztZQUN0RixJQUFJLFFBQVEsR0FBa0IsSUFBSSxDQUFDO1lBQ25DLElBQUksU0FBMkMsQ0FBQztZQUNoRCxJQUFJLE1BQU0sR0FBc0IsT0FBTyxDQUFDO1lBQ3hDLElBQUksQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFLENBQUM7Z0JBQ2hDLEtBQUssTUFBTSxTQUFTLElBQUksZ0NBQXVCLEVBQUUsQ0FBQztvQkFDOUMsUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLElBQUksQ0FBQzt3QkFDeEIsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPO3dCQUN4QixNQUFNLEVBQUUsYUFBYSxLQUFLLENBQUMsUUFBUSxFQUFFO3dCQUNyQyxNQUFNLEVBQUUsU0FBUzt3QkFDakIsS0FBSyxFQUFFLENBQUM7d0JBQ1IsT0FBTyxFQUFFLGlCQUFpQjtxQkFDN0IsQ0FBQyxDQUFDO29CQUNILElBQUksUUFBUSxFQUFFLENBQUM7d0JBQ1gsU0FBUyxHQUFHLFNBQVMsQ0FBQzt3QkFDdEIsTUFBTTtvQkFDVixDQUFDO2dCQUNMLENBQUM7WUFDTCxDQUFDO1lBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNaLElBQUksQ0FBQyxvQkFBb0IsRUFBRSxDQUFDO29CQUN4QixvQkFBb0IsR0FBRyxNQUFNLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztnQkFDekYsQ0FBQztnQkFDRCxNQUFNLGFBQWEsR0FBRyxNQUFNLG9CQUFvQixDQUFDO2dCQUNqRCxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDO2dCQUNoRCxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7b0JBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUMzRCxDQUFDO2dCQUNELElBQUksSUFBSSxHQUFHLFNBQVMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7Z0JBQ3BDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztvQkFDUixJQUFJLEdBQUcsTUFBTSxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLFNBQVMsRUFBRSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxLQUFLLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO29CQUNoRyxTQUFTLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsQ0FBQztnQkFDbkMsQ0FBQztnQkFDRCxRQUFRLEdBQUcsTUFBTSxJQUFJLENBQUM7Z0JBQ3RCLE1BQU0sR0FBRyxPQUFPLENBQUM7Z0JBQ2pCLFNBQVMsR0FBRyxJQUFBLDZCQUFvQixFQUFDLFFBQVEsQ0FBQyxDQUFDO2dCQUMzQyxNQUFNLEtBQUssQ0FBQyxLQUFLLENBQUM7b0JBQ2QsT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFPO29CQUN4QixNQUFNLEVBQUUsYUFBYSxLQUFLLENBQUMsUUFBUSxFQUFFO29CQUNyQyxNQUFNLEVBQUUsU0FBUztvQkFDakIsS0FBSyxFQUFFLENBQUM7b0JBQ1IsT0FBTyxFQUFFLGlCQUFpQjtpQkFDN0IsRUFBRSxRQUFRLENBQUMsQ0FBQztZQUNqQixDQUFDO1lBQ0QsU0FBUyxhQUFULFNBQVMsY0FBVCxTQUFTLElBQVQsU0FBUyxHQUFLLElBQUEsNkJBQW9CLEVBQUMsUUFBUSxDQUFDLEVBQUM7WUFDN0MsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxPQUFPLEtBQUssS0FBSyxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssT0FBTyxDQUFDLENBQUM7WUFDM0YsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNwQyxNQUFNLE1BQU0sR0FBRyxJQUFBLCtCQUFrQixFQUFDLFFBQVEsRUFBRSxDQUFBLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLFNBQVMsMENBQUUsV0FBVyxFQUFFLE1BQUssS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFDakcsS0FBSyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUNyRCxJQUFJLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLE1BQU0sQ0FBQyxPQUFPO2dCQUFFLE1BQU0sSUFBSSx1QkFBYyxFQUFFLENBQUM7WUFDakUsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FDdkIsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQ2YsR0FBRyxPQUFPLENBQUMsT0FBTyxjQUFjLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFDaEQsS0FBSyxFQUNMLGNBQWMsQ0FBQyxLQUFLLENBQ3ZCLENBQUM7WUFDRixNQUFNLFFBQVEsR0FBRyxNQUFNLE1BQU0sQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1lBQ2pELFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUNwQixJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU07Z0JBQUUsSUFBSSxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksRUFDMUQsbURBQW1ELEVBQUUsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3ZFLGNBQWMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNsRCxDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBRUYsTUFBTSxJQUFBLDRCQUFjLEVBQUMsUUFBUSxFQUFFLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JHLE1BQU0sSUFBQSw0QkFBYyxFQUFDLFdBQVcsRUFBRSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLGFBQWEsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUNyRyxNQUFNLElBQUEsNEJBQWMsRUFBQyxpQkFBaUIsRUFBRSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsU0FBUyxDQUFDLE1BQU0sRUFBRSxFQUFFLEdBQUcsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO0lBRTFILEtBQUssTUFBTSxJQUFJLElBQUksUUFBUSxDQUFDLFNBQVMsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDbkQsSUFBSSxNQUFNLEVBQUUsQ0FBQztZQUNULGFBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBQ3hDLFNBQVM7UUFDYixDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3pELE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7UUFDN0QsSUFBSSxRQUFRLEVBQUUsQ0FBQztZQUNYLE1BQU0sUUFBUSxHQUFHLE1BQU0sTUFBTSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUNqRCxJQUFJLENBQUMsUUFBUTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBQzVFLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQzlDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLEtBQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUM3QyxTQUFTO1FBQ2IsQ0FBQztRQUNELE1BQU0sV0FBVyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxNQUFNLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUNoRSxJQUFJLFdBQVcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxRQUFRLEdBQUcsTUFBTSxNQUFNLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUUsQ0FBQyxDQUFDO1lBQzVFLElBQUksQ0FBQyxRQUFRO2dCQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsaUNBQWlDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ3BGLFlBQVksQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQzlDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBQzFDLFNBQVM7UUFDYixDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDO1FBQ3ZDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxLQUFLLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO1FBQ3BHLE1BQU0sR0FBRyxHQUFHLEtBQUssSUFBSSxJQUFJO1lBQ3JCLENBQUMsQ0FBQyxJQUFBLGlCQUFXLEVBQ1QsS0FBSyxDQUFDLEtBQUssRUFDWCxLQUFLLENBQUMsTUFBTSxFQUNaLElBQUksRUFDSixXQUFXLENBQUMsSUFBSSxDQUFDLEVBQ2pCLGNBQWMsQ0FBQyxLQUFLLENBQ3ZCO1lBQ0QsQ0FBQyxDQUFDLElBQUksQ0FBQztRQUNYLElBQUksR0FBRyxFQUFFLENBQUM7WUFDTixNQUFNLEdBQUcsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUN2QixJQUFJLENBQUMsSUFBSSxFQUNULEdBQUcsT0FBTyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsRUFBRSxXQUFXLEVBQ3hDLEtBQUssRUFDTCxjQUFjLENBQUMsS0FBSyxDQUN2QixDQUFDO1lBQ0YsTUFBTSxLQUFLLEdBQUcsTUFBTSxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUMzQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDakIsWUFBWSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDM0MsYUFBYSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsV0FBVyxDQUFDLENBQUM7WUFDeEMsU0FBUztRQUNiLENBQUM7UUFDRCxTQUFTLElBQUksQ0FBQyxDQUFDO1FBQ2YsWUFBWSxDQUFDO1lBQ1QsS0FBSyxFQUFFLFFBQVE7WUFDZixLQUFLLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3BDLE9BQU8sRUFBRSxRQUFRLFNBQVMsSUFBSSxLQUFLLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRTtTQUN2RCxDQUFDLENBQUM7SUFDUCxDQUFDO0lBQ0QsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFNLENBQUMsTUFBTTtRQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLElBQUEsZUFBUSxFQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNwRyxPQUFPLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDLEdBQUcsUUFBUSxDQUFDLEVBQUUsQ0FBQztBQUMvQyxDQUFDO0FBRUQsS0FBSyxVQUFVLFlBQVksQ0FBQyxRQUF3QjtJQUNoRCxNQUFNLE1BQU0sR0FBRyxJQUFJLEdBQUcsRUFBa0IsQ0FBQztJQUN6QyxLQUFLLE1BQU0sQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztRQUMzRCxJQUFJLENBQUMsR0FBRztZQUFFLFNBQVM7UUFDbkIsTUFBTSxJQUFJLEdBQUcsTUFBTSxJQUFBLHlCQUFnQixFQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3pDLElBQUksSUFBSSxFQUFFLENBQUM7WUFDUCxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztRQUM3QixDQUFDO0lBQ0wsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2xCLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLElBQWU7SUFDdkMsTUFBTSxVQUFVLEdBQUcsSUFBQSwrQkFBb0IsRUFBQyxJQUFJLENBQUMsQ0FBQztJQUM5QyxJQUFJLFVBQVUsRUFBRSxDQUFDO1FBQ2IsT0FBTyxVQUFVLENBQUM7SUFDdEIsQ0FBQztJQUNELElBQUksSUFBSSxDQUFDLFVBQVUsSUFBSSxJQUFJLENBQUMsVUFBVSxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQ2hELE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsUUFBUTtTQUN2QixHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQztTQUN6QyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQWlCLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN0RCxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2pCLE9BQU8sVUFBVSxDQUFDO0lBQ3RCLENBQUM7SUFDRCxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDbEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ25FLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUM7SUFDOUQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQztJQUM5RCxJQUFJLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNmLE9BQU8sWUFBWSxDQUFDO0lBQ3hCLENBQUM7SUFDRCxJQUFJLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNmLE9BQU8sVUFBVSxDQUFDO0lBQ3RCLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQztBQUNsQixDQUFDO0FBRUQsU0FBZ0IsUUFBUSxDQUNwQixJQUFlLEVBQ2YsV0FBNkIsRUFDN0IsU0FBZ0MsRUFDaEMsS0FBMEMsRUFDMUMsUUFBd0MsRUFDeEMsTUFBb0MsRUFDcEMsS0FBMEIsRUFDMUIsTUFBTSxHQUFHLEtBQUssRUFDZCxtQkFBbUIsR0FBRyxDQUFDLEVBQ3ZCLElBQTBCOztJQUUxQixNQUFNLFFBQVEsR0FBRyxlQUFlLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQ2xELElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUMvQixPQUFPLElBQUksQ0FBQztJQUNoQixDQUFDO0lBQ0QsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzlCLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ2hDLE1BQU0sSUFBSSxHQUFHLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxJQUFJLENBQUM7SUFDeEIsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0lBQ3RFLE1BQU0sVUFBVSxHQUFHLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksTUFBSyxhQUFhLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNsRixNQUFNLFlBQVksR0FBRyxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxhQUFhLElBQUksVUFBVSxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUMzRixNQUFNLFlBQVksR0FBRyxRQUFRLENBQUMsSUFBSSxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBQSxvQkFBUyxFQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO0lBQ2hGLE1BQU0sV0FBVyxHQUFHLE1BQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksbUNBQUksWUFBWSxDQUFDO0lBQy9DLE1BQU0sY0FBYyxHQUFHLFFBQVEsQ0FBQyxTQUFTLElBQUksUUFBUSxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUM7SUFDMUUsTUFBTSxRQUFRLEdBQUcsY0FBYyxJQUFJLElBQUEsaUNBQWdCLEVBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3JFLE1BQU0sYUFBYSxHQUFHLElBQUEsb0NBQW1CLEVBQUMsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLEVBQUUsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzVGLE1BQU0sY0FBYyxHQUFHLElBQUksSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLGFBQWE7UUFDdEQsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZO1FBQ25CLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO0lBQ2QsTUFBTSxXQUFXLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsQ0FBQztJQUMvQyxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ25FLE1BQU0sUUFBUSxHQUFHLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksTUFBSyxjQUFjLElBQUksQ0FBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsSUFBSSxNQUFLLGFBQWEsQ0FBQztJQUMvRSxNQUFNLGFBQWEsR0FBRyxtQkFBbUIsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQzFELDZDQUE2QztJQUM3QyxpQkFBaUI7SUFDakIsTUFBTSxVQUFVLEdBQStCLElBQUk7UUFDL0MsQ0FBQyxDQUFDLElBQUEsOEJBQWdCLEVBQUM7WUFDZixPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87WUFDckIsSUFBSTtZQUNKLFlBQVksRUFBRSxNQUFBLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxlQUFlLG1DQUFJLEVBQUU7U0FDNUMsQ0FBQztRQUNGLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFDaEIsT0FBTztRQUNILE9BQU8sRUFBRSxJQUFJLENBQUMsRUFBRTtRQUNoQixJQUFJLEVBQUUsTUFBQSxRQUFRLENBQUMsSUFBSSxtQ0FBSSxJQUFJLENBQUMsSUFBSTtRQUNoQyxTQUFTLEVBQUUsWUFBWSxDQUFDLElBQUk7UUFDNUIsTUFBTSxFQUFFLFFBQVEsQ0FBQyxNQUFNO1FBQ3ZCLElBQUksRUFBRSxhQUFhO1FBQ25CLEtBQUs7UUFDTCxXQUFXO1FBQ1gsYUFBYSxFQUFFLElBQUksQ0FBQyxJQUFJO1FBQ3hCLE1BQU07UUFDTixRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7UUFDdkIsYUFBYTtRQUNiLE9BQU8sRUFBRSxVQUFVLElBQUksUUFBUTtZQUMzQixDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sR0FBRyxVQUFVLENBQUMsT0FBTztZQUNuQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU87UUFDbEIsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPO1FBQ3JCLFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWTtRQUMvQixXQUFXLEVBQUUsV0FBVyxDQUFDLFlBQVksQ0FBQztRQUN0QyxLQUFLLEVBQUUsVUFBVSxDQUFDLEtBQUs7UUFDdkIsT0FBTyxFQUFFLFVBQVUsQ0FBQyxPQUFPO1FBQzNCLFlBQVksRUFBRSxVQUFVLENBQUMsWUFBWTtRQUNyQyxVQUFVLEVBQUUsVUFBVSxDQUFDLFVBQVU7UUFDakMsU0FBUyxFQUFFLFVBQVUsQ0FBQyxLQUFLO1FBQzNCLE1BQU0sRUFBRTtZQUNKLElBQUksRUFBRSxhQUFhLEtBQUssUUFBUSxJQUFJLGFBQWEsS0FBSyxZQUFZO2dCQUM5RCxDQUFDLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDO2dCQUMxQixDQUFDLENBQUMsU0FBUztZQUNmLFVBQVUsRUFBRSxJQUFJLENBQUMsVUFBVTtZQUMzQixJQUFJLEVBQUUsSUFBSSxDQUFDLFVBQVU7WUFDckIsWUFBWSxFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDeEMsWUFBWSxFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDeEMsYUFBYSxFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDekMsYUFBYSxFQUFFLElBQUksQ0FBQyxxQkFBcUI7WUFDekMsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO1lBQzdCLGNBQWMsRUFBRSxJQUFJLENBQUMsa0JBQWtCO1lBQ3ZDLFdBQVcsRUFBRSxJQUFJLENBQUMsV0FBVztZQUM3QixZQUFZLEVBQUUsSUFBSSxDQUFDLFlBQVk7WUFDL0IsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO1lBQzNCLGFBQWEsRUFBRSxJQUFJLENBQUMsYUFBYTtTQUNwQztRQUNELGlCQUFpQixFQUFFLElBQUksQ0FBQyxpQkFBaUI7UUFDekMsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO1FBQzdCLGlCQUFpQixFQUFFLElBQUksQ0FBQyxpQkFBaUI7UUFDekMsTUFBTSxFQUFFLFdBQVc7UUFDbkIsUUFBUSxFQUFFLENBQUEsTUFBQSxVQUFVLENBQUMsS0FBSywwQ0FBRSxVQUFVLEVBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztRQUMzRixhQUFhLEVBQUUsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLGVBQWU7UUFDcEMsZUFBZSxFQUFFLGNBQWMsSUFBSSxRQUFRO1lBQ3ZDLENBQUMsQ0FBQyxJQUFJO1lBQ04sQ0FBQyxDQUFDLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksTUFBSyxZQUFZO2dCQUN6QixDQUFDLENBQUMsS0FBSztnQkFDUCxDQUFDLENBQUMsU0FBUztRQUNuQixVQUFVLEVBQUUsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLE1BQU07UUFDeEIsVUFBVTtRQUNWLFFBQVEsRUFBRSxRQUFRO1lBQ2QsQ0FBQyxDQUFDLEVBQUU7WUFDSixDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVE7aUJBQ1YsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7aUJBQ25ELEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsUUFBUSxDQUNwQixLQUFLLEVBQ0wsS0FBSyxFQUNMLFNBQVMsRUFDVCxLQUFLLEVBQ0wsUUFBUSxFQUNSLE1BQU0sRUFDTixLQUFLLEVBQ0wsS0FBSyxFQUNMLGFBQWEsRUFDYixJQUFJLENBQ1AsQ0FBQztpQkFDRCxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQTBCLEVBQUUsQ0FBQyxLQUFLLEtBQUssSUFBSSxDQUFDO0tBQ3JFLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLFdBQVc7SUFDdEIsTUFBTSxLQUFLLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDdkYsT0FBTyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUErQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDckcsQ0FBQztBQUVELFNBQVMsV0FBVzs7SUFDaEIsTUFBTSxTQUFTLEdBQUcsTUFBQSxNQUFBLE1BQUEsTUFBTSxDQUFDLEtBQUssMENBQUUsSUFBSSwwQ0FBRSxRQUFRLG1EQUFHLElBQUksQ0FBQyxDQUFDO0lBQ3ZELE9BQU8sT0FBTyxTQUFTLEtBQUssUUFBUSxJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQztRQUN4RCxDQUFDLENBQUMsU0FBUztRQUNYLENBQUMsQ0FBQyxJQUFBLG9CQUFXLEVBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDakUsQ0FBQztBQUVELEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxTQUFpQjtJQUM3QyxPQUFPLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQy9CLFVBQVUsRUFDVixrQkFBa0IsRUFDbEIsU0FBUyxDQUNjLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsaUJBQWlCLENBQ3RCLElBQXFCLEVBQ3JCLFdBQTRDLEVBQUU7SUFFOUMsSUFBSSxJQUFJLENBQUMsT0FBTyxJQUFJLElBQUksQ0FBQyxRQUFRLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDekMsTUFBTSxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7SUFDakQsQ0FBQztJQUNELElBQUksSUFBSSxDQUFDLFFBQVEsS0FBSyxRQUFRLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzlFLE1BQU0sSUFBSSxLQUFLLENBQUMsMkJBQTJCLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQzNELENBQUM7SUFDRCxJQUFJLElBQUksQ0FBQyxRQUFRLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ2pDLE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQzlELENBQUM7SUFDRCxJQUFJLFFBQVEsQ0FBQyxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDL0MsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUNELElBQUksUUFBUSxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsR0FBRyxLQUFLLFFBQVEsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUM1QyxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixRQUFRLENBQUMsR0FBRyxPQUFPLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLGtCQUFrQixDQUFDLEdBQVcsRUFBRSxZQUFxQjtJQUNoRSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDM0IsT0FBTyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsT0FBTyxHQUFHLEtBQU0sRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDekMsSUFBSSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsT0FBTyxFQUFFLENBQUM7WUFDaEIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1QkFBdUIsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUNsRCxDQUFDO1FBQ0QsSUFBSSxDQUFBLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxRQUFRLE1BQUssSUFBSSxFQUFFLENBQUM7WUFDMUIsSUFBSSxZQUFZLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxZQUFZLEVBQUUsQ0FBQztnQkFDN0MsTUFBTSxJQUFJLEtBQUssQ0FBQyx5QkFBeUIsR0FBRyxFQUFFLENBQUMsQ0FBQztZQUNwRCxDQUFDO1lBQ0QsaUJBQWlCLENBQUMsSUFBSSxFQUFFLEVBQUUsSUFBSSxFQUFFLFlBQVksRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO1lBQ3JELE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7UUFDRCxJQUFJLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNuQyxNQUFNLElBQUksdUJBQWMsRUFBRSxDQUFDO1FBQy9CLENBQUM7UUFDRCxNQUFNLElBQUksT0FBTyxDQUFDLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsWUFBWSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDdkUsQ0FBQztJQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsMEJBQTBCLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDckQsQ0FBQztBQUVELEtBQUssVUFBVSxlQUFlLENBQUMsSUFBWTtJQUN2QyxNQUFNLElBQUksR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUNyQyxVQUFVLEVBQ1Ysa0JBQWtCLEVBQ2xCLElBQUksQ0FDUCxDQUFDO0lBQ0YsSUFBSSxDQUFDLElBQUksSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNwQyxNQUFNLElBQUksS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFDRCxNQUFNLEtBQUssR0FBRyxJQUEwQyxDQUFDO0lBQ3pELElBQUksS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLElBQUksS0FBSyxDQUFDLFFBQVEsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUNyRCxNQUFNLElBQUksS0FBSyxDQUFDLHdCQUF3QixJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUyxjQUFjLENBQUMsR0FBVztJQUMvQixJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQzNCLE1BQU0sSUFBSSxLQUFLLENBQUMsaUJBQWlCLEdBQUcsRUFBRSxDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELE9BQU8sSUFBQSxjQUFPLEVBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNuRSxDQUFDO0FBRUQsS0FBSyxVQUFVLHVCQUF1QixDQUFDLEdBQVc7SUFDOUMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO0lBQzNCLE9BQU8sSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLE9BQU8sR0FBRyxLQUFNLEVBQUUsQ0FBQztRQUNuQyxNQUFNLElBQUksR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxrQkFBa0IsRUFBRSxHQUFHLENBRXJFLENBQUM7UUFDVCxJQUFJLE9BQU8sQ0FBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsSUFBSSxDQUFBLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDakMsT0FBTztRQUNYLENBQUM7UUFDRCxNQUFNLElBQUksT0FBTyxDQUFDLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsWUFBWSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDdkUsQ0FBQztJQUNELE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDcEQsQ0FBQztBQUVEOzs7R0FHRztBQUNILEtBQUssVUFBVSxzQkFBc0I7SUFDakMsTUFBTSxHQUFHLEdBQUcsb0NBQXNCLENBQUM7SUFDbkMsSUFBSSxRQUFRLEdBQWtCLElBQUksQ0FBQztJQUNuQyxJQUFJLENBQUM7UUFDRCxRQUFRLEdBQUcsTUFBTSxJQUFBLG1CQUFRLEVBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQzNELENBQUM7SUFBQyxNQUFNLENBQUM7UUFDTCxRQUFRLEdBQUcsSUFBSSxDQUFDO0lBQ3BCLENBQUM7SUFDRCxNQUFNLElBQUksR0FBRyxJQUFBLHdDQUFvQixFQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQzVDLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNqQyxDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQ3pCLE1BQU0sdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbkMsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUM5QixDQUFDO0lBQ0QsTUFBTSxJQUFJLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsa0JBQWtCLEVBQUUsR0FBRyxDQUVyRSxDQUFDO0lBQ1QsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ1IsTUFBTSxPQUFPLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsY0FBYyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFO1lBQ3hGLFNBQVMsRUFBRSxLQUFLO1lBQ2hCLE1BQU0sRUFBRSxLQUFLO1NBQ2hCLENBQTZCLENBQUM7UUFDL0IsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1lBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUMzQyxDQUFDO0lBQ0wsQ0FBQztTQUFNLENBQUM7UUFDSixNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxZQUFZLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM5RSxDQUFDO0lBQ0QsTUFBTSx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNuQyxPQUFPO1FBQ0gsTUFBTSxFQUFFLElBQUksQ0FBQyxNQUFNO1FBQ25CLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsU0FBUztLQUM5RCxDQUFDO0FBQ04sQ0FBQztBQUVELFNBQVMsc0JBQXNCLENBQUMsS0FBK0I7SUFDM0QsTUFBTSxPQUFPLEdBQXFCLEVBQUUsQ0FBQztJQUNyQyxNQUFNLEtBQUssR0FBRyxDQUFDLEtBQStCLEVBQUUsRUFBRTtRQUM5QyxLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3ZCLElBQUksSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO2dCQUNsQixPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztZQUNsQyxDQUFDO1lBQ0QsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN6QixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBQ0YsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2IsT0FBTyxPQUFPLENBQUM7QUFDbkIsQ0FBQztBQUVELEtBQUssVUFBVSx5QkFBeUIsQ0FDcEMsSUFBcUIsRUFDckIsTUFBd0I7SUFFeEIsSUFBSSxDQUFDO1FBQ0QsT0FBTyxJQUFBLDBDQUE0QixFQUMvQixNQUFNLElBQUEsbUJBQVEsRUFBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQ3hDLE1BQU0sQ0FDVCxDQUFDO0lBQ04sQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNMLE9BQU8sS0FBSyxDQUFDO0lBQ2pCLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLG1CQUFtQixDQUM5QixTQUFpQixFQUNqQixVQUFrQixFQUNsQixVQUFrQjs7SUFFbEIsTUFBTSxZQUFZLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsYUFBYSxDQUFZLENBQUM7SUFDckYsSUFBSSxZQUFZLEVBQUUsQ0FBQztRQUNmLE1BQU0sSUFBSSxLQUFLLENBQUMsaURBQWlELENBQUMsQ0FBQztJQUN2RSxDQUFDO0lBQ0QsTUFBTSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDL0IsTUFBTSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQzdDLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLFlBQVksRUFBRSxVQUFVLENBQUMsQ0FBQztJQUNuRSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDM0IsSUFBSSxVQUFVLEdBQUcsMEJBQTBCLENBQUM7SUFDNUMsT0FBTyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsT0FBTyxHQUFHLEtBQU0sRUFBRSxDQUFDO1FBQ25DLElBQUksQ0FBQztZQUNELE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLHNCQUFzQixFQUFFO2dCQUN4RSxJQUFJLEVBQUUsc0JBQVcsQ0FBQyxJQUFJO2dCQUN0QixNQUFNLEVBQUUsc0JBQXNCO2dCQUM5QixJQUFJLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsQ0FBQzthQUNyQyxDQUF1QixDQUFDO1lBQ3pCLElBQUksS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUNkLE9BQU87WUFDWCxDQUFDO1lBQ0QsVUFBVSxHQUFHLE1BQUEsS0FBSyxDQUFDLE1BQU0sbUNBQUksVUFBVSxDQUFDO1FBQzVDLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2IsVUFBVSxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN4RSxDQUFDO1FBQ0QsSUFBSSxnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDbkMsTUFBTSxJQUFJLHVCQUFjLEVBQUUsQ0FBQztRQUMvQixDQUFDO1FBQ0QsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLFlBQVksRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLFlBQVksRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7SUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLGtCQUFrQixVQUFVLEVBQUUsQ0FBQyxDQUFDO0FBQ3BELENBQUM7QUFFRCxLQUFLLFVBQVUsa0JBQWtCLENBQUMsVUFBa0IsRUFBRSxVQUFrQjs7SUFDcEUsTUFBTSxLQUFLLEdBQUcsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsc0JBQXNCLEVBQUU7UUFDeEUsSUFBSSxFQUFFLHNCQUFXLENBQUMsSUFBSTtRQUN0QixNQUFNLEVBQUUsc0JBQXNCO1FBQzlCLElBQUksRUFBRSxDQUFDLEVBQUUsVUFBVSxFQUFFLFVBQVUsRUFBRSxDQUFDO0tBQ3JDLENBQXVCLENBQUM7SUFDekIsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNmLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLE1BQUEsS0FBSyxDQUFDLE1BQU0sbUNBQUksTUFBTSxFQUFFLENBQUMsQ0FBQztJQUNwRSxDQUFDO0FBQ0wsQ0FBQztBQUVELEtBQUssVUFBVSxpQkFBaUI7SUFDNUIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO0lBQzNCLE9BQU8sSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLE9BQU8sR0FBRyxLQUFNLEVBQUUsQ0FBQztRQUNuQyxNQUFNLEtBQUssR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxhQUFhLENBQVksQ0FBQztRQUM5RSxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7WUFDVCxPQUFPO1FBQ1gsQ0FBQztRQUNELE1BQU0sSUFBSSxPQUFPLENBQUMsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxZQUFZLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUN2RSxDQUFDO0lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO0FBQ3pDLENBQUM7QUFFRCxLQUFLLFVBQVUsaUJBQWlCO0lBQzVCLE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQ3pDLHNCQUFXLENBQUMsSUFBSSxFQUNoQixrQkFBa0IsRUFDbEIsU0FBUyxDQUNaLENBQUM7SUFDRixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ3RDLE9BQU8sRUFBRSxDQUFDO0lBQ2QsQ0FBQztJQUNELE1BQU0sTUFBTSxHQUEyQixFQUFFLENBQUM7SUFDMUMsS0FBSyxNQUFNLENBQUMsVUFBVSxFQUFFLFVBQVUsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBZ0MsQ0FBQyxFQUFFLENBQUM7UUFDdEYsSUFBSSxDQUFDLHVCQUF1QixDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7ZUFDdEMsT0FBTyxVQUFVLEtBQUssUUFBUTtlQUM5QixDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sSUFBSSxLQUFLLENBQUMseUJBQXlCLENBQUMsQ0FBQztRQUMvQyxDQUFDO1FBQ0QsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLFVBQVUsQ0FBQztJQUNwQyxDQUFDO0lBQ0QsT0FBTyxNQUFNLENBQUM7QUFDbEIsQ0FBQztBQUVELEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxVQUFrQixFQUFFLFVBQWtCO0lBQ2xFLE1BQU0sUUFBUSxHQUFHLE1BQU0saUJBQWlCLEVBQUUsQ0FBQztJQUMzQyxRQUFRLENBQUMsVUFBVSxDQUFDLEdBQUcsVUFBVSxDQUFDO0lBQ2xDLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQzNCLHNCQUFXLENBQUMsSUFBSSxFQUNoQixrQkFBa0IsRUFDbEIsUUFBUSxFQUNSLFNBQVMsQ0FDWixDQUFDO0FBQ04sQ0FBQztBQUVELEtBQUssVUFBVSxtQkFBbUIsQ0FBQyxVQUFrQjtJQUNqRCxNQUFNLFFBQVEsR0FBRyxNQUFNLGlCQUFpQixFQUFFLENBQUM7SUFDM0MsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQ3hCLE9BQU87SUFDWCxDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDNUIsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FDM0Isc0JBQVcsQ0FBQyxJQUFJLEVBQ2hCLGtCQUFrQixFQUNsQixRQUFRLEVBQ1IsU0FBUyxDQUNaLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLHFCQUFxQjtJQUloQyxNQUFNLEtBQUssR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUN6QyxzQkFBVyxDQUFDLElBQUksRUFDaEIscUJBQXFCLEVBQ3JCLFNBQVMsQ0FDWixDQUFDO0lBQ0YsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUN0QyxPQUFPLEVBQUUsQ0FBQztJQUNkLENBQUM7SUFDRCxNQUFNLE1BQU0sR0FBcUUsRUFBRSxDQUFDO0lBQ3BGLEtBQUssTUFBTSxDQUFDLFVBQVUsRUFBRSxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQWdDLENBQUMsRUFBRSxDQUFDO1FBQy9FLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDO2VBQ3RDLENBQUMsR0FBRztlQUNKLE9BQU8sR0FBRyxLQUFLLFFBQVE7ZUFDdkIsT0FBUSxHQUFnQyxDQUFDLFVBQVUsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUN0RSxNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixDQUFDLENBQUM7UUFDaEQsQ0FBQztRQUNELE1BQU0sTUFBTSxHQUFHLElBQUEsa0NBQW9CLEVBQUM7WUFDaEMsUUFBUSxFQUFFO2dCQUNOLGFBQWEsRUFBRyxHQUE0QixDQUFDLE1BQU07YUFDdEQ7U0FDSixDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxVQUFVLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDOUMsTUFBTSxJQUFJLEtBQUssQ0FBQyw0QkFBNEIsQ0FBQyxDQUFDO1FBQ2xELENBQUM7UUFDRCxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUc7WUFDakIsVUFBVSxFQUFHLEdBQThCLENBQUMsVUFBVTtZQUN0RCxNQUFNO1NBQ1QsQ0FBQztJQUNOLENBQUM7SUFDRCxPQUFPLE1BQU0sQ0FBQztBQUNsQixDQUFDO0FBRUQsS0FBSyxVQUFVLG9CQUFvQixDQUMvQixVQUFrQixFQUNsQixLQUE4RDtJQUU5RCxNQUFNLE9BQU8sR0FBRyxNQUFNLHFCQUFxQixFQUFFLENBQUM7SUFDOUMsSUFBSSxLQUFLLEVBQUUsQ0FBQztRQUNSLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxLQUFLLENBQUM7SUFDaEMsQ0FBQztTQUFNLENBQUM7UUFDSixPQUFPLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUMvQixDQUFDO0lBQ0QsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FDM0Isc0JBQVcsQ0FBQyxJQUFJLEVBQ2hCLHFCQUFxQixFQUNyQixPQUFPLEVBQ1AsU0FBUyxDQUNaLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLG9CQUFvQixDQUMvQixJQUFxQixFQUNyQixVQUFrQjtJQUVsQixJQUFJLElBQUksR0FBRyxNQUFNLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDNUMsSUFBSSxNQUFNLEdBQUcsSUFBQSxrQ0FBb0IsRUFBQyxJQUFJLENBQUMsQ0FBQztJQUN4QyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDVixNQUFNLElBQUksS0FBSyxDQUNYLG9DQUFvQyxJQUFJLENBQUMsR0FBRyxlQUFlLENBQzlELENBQUM7SUFDTixDQUFDO0lBQ0QsSUFBSSxNQUFNLENBQUMsVUFBVSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ25DLE1BQU0sSUFBSSxLQUFLLENBQUMsa0NBQWtDLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDO0lBQ2xFLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxDQUFDLE1BQU0scUJBQXFCLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQzVELElBQUksT0FBTyxFQUFFLENBQUM7UUFDVixJQUFJLE9BQU8sQ0FBQyxVQUFVLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxPQUFPLENBQUMsTUFBTSxDQUFDLFVBQVUsS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUMvRSxNQUFNLElBQUksS0FBSyxDQUFDLGtDQUFrQyxDQUFDLENBQUM7UUFDeEQsQ0FBQztRQUNELElBQUksTUFBTSx5QkFBeUIsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7WUFDeEQsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FDeEIsVUFBVSxFQUNWLGlCQUFpQixFQUNqQixJQUFJLENBQUMsSUFBSSxFQUNULElBQUksQ0FBQyxTQUFTLENBQUMsSUFBQSxtQ0FBcUIsRUFBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FDdkUsQ0FBQztZQUNGLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLGdCQUFnQixFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN0RSxNQUFNLGtCQUFrQixDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzlDLElBQUksR0FBRyxNQUFNLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDeEMsTUFBTSxTQUFTLEdBQUcsSUFBQSxrQ0FBb0IsRUFBQyxJQUFJLENBQUMsQ0FBQztZQUM3QyxJQUFJLENBQUMsU0FBUyxJQUFJLElBQUksQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLEtBQUssSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztnQkFDN0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO1lBQzVDLENBQUM7WUFDRCxNQUFNLEdBQUcsU0FBUyxDQUFDO1FBQ3ZCLENBQUM7YUFBTSxJQUFJLENBQUMsTUFBTSx5QkFBeUIsQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUN4RCxNQUFNLElBQUksS0FBSyxDQUFDLG9DQUFvQyxDQUFDLENBQUM7UUFDMUQsQ0FBQztRQUNELE1BQU0sb0JBQW9CLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ2pELENBQUM7SUFDRCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDO0FBQzVCLENBQUM7QUFFRCxLQUFLLFVBQVUseUJBQXlCLENBQ3BDLElBQXFCLEVBQ3JCLFVBQWtCLEVBQ2xCLE1BQXdCO0lBRXhCLElBQUksU0FBa0IsQ0FBQztJQUN2QixLQUFLLElBQUksT0FBTyxHQUFHLENBQUMsRUFBRSxPQUFPLEdBQUcsQ0FBQyxFQUFFLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUM5QyxJQUFJLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxNQUFNLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDOUMsTUFBTSxRQUFRLEdBQUcsSUFBQSxrQ0FBb0IsRUFBQyxJQUFJLENBQUMsQ0FBQztZQUM1QyxJQUFJLENBQUMsUUFBUSxJQUFJLFFBQVEsQ0FBQyxVQUFVLEtBQUssVUFBVSxFQUFFLENBQUM7Z0JBQ2xELE1BQU0sSUFBSSxLQUFLLENBQUMscUJBQXFCLENBQUMsQ0FBQztZQUMzQyxDQUFDO1lBQ0QsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FDeEIsVUFBVSxFQUNWLGlCQUFpQixFQUNqQixJQUFJLENBQUMsSUFBSSxFQUNULElBQUksQ0FBQyxTQUFTLENBQUMsSUFBQSxtQ0FBcUIsRUFBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUMvRCxDQUFDO1lBQ0YsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsZ0JBQWdCLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3RFLE1BQU0sa0JBQWtCLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDOUMsTUFBTSxLQUFLLEdBQUcsSUFBQSxrQ0FBb0IsRUFBQyxNQUFNLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztZQUNyRSxJQUFJLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLEtBQUssSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO2dCQUM3RCxNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7WUFDNUMsQ0FBQztZQUNELE9BQU87UUFDWCxDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNiLFNBQVMsR0FBRyxLQUFLLENBQUM7WUFDbEIsSUFBSSxPQUFPLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQ2QsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLFlBQVksRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLFlBQVksRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ3ZFLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQztJQUNELE1BQU0sU0FBUyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO0FBQ2pGLENBQUM7QUFFRCxLQUFLLFVBQVUsd0JBQXdCLENBQ25DLFNBQWlCLEVBQ2pCLFVBQWtCLEVBQ2xCLFNBQWUsRUFDZixVQUFrQixFQUNsQixZQUFvQjtJQUtwQixNQUFNLFFBQVEsR0FBRyxNQUFNLGlCQUFpQixFQUFFLENBQUM7SUFDM0MsTUFBTSxTQUFTLEdBQUcsUUFBUSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ3ZDLE1BQU0sT0FBTyxHQUFHLENBQUMsTUFBTSxxQkFBcUIsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDNUQsTUFBTSxXQUFXLEdBQUcsT0FBTztRQUN2QixDQUFDLENBQUMsTUFBTSxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDO1FBQzVDLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDWCxNQUFNLFVBQVUsR0FBRyxJQUFBLHNDQUF3QixFQUN2QyxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsVUFBVSxFQUNuQixTQUFTLEVBQ1QsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUN2QixDQUFDO0lBQ0YsSUFBSSxVQUFVLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDMUIsTUFBTSxvQkFBb0IsQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDakQsQ0FBQztJQUNELElBQUksVUFBVSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQzFCLE1BQU0sbUJBQW1CLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELE1BQU0sVUFBVSxHQUFHLFVBQVUsQ0FBQyxVQUFVLENBQUM7SUFDekMsSUFBSSxVQUFVLEVBQUUsQ0FBQztRQUNiLElBQUksVUFBVSxHQUFHLENBQUEsV0FBVyxhQUFYLFdBQVcsdUJBQVgsV0FBVyxDQUFFLElBQUksTUFBSyxVQUFVO1lBQzdDLENBQUMsQ0FBQyxXQUFXO1lBQ2IsQ0FBQyxDQUFDLE1BQU0sZ0JBQWdCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ2QsSUFBSSxRQUFRLENBQUMsVUFBVSxDQUFDLEtBQUssVUFBVSxFQUFFLENBQUM7Z0JBQ3RDLE1BQU0sbUJBQW1CLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDMUMsQ0FBQztRQUNMLENBQUM7YUFBTSxDQUFDO1lBQ0osVUFBVSxHQUFHLE1BQU0sa0JBQWtCLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxVQUFVLENBQUMsQ0FBQztZQUNsRSxJQUFJLENBQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFVBQVUsTUFBSyxVQUFVLElBQUksU0FBUyxLQUFLLFVBQVUsRUFBRSxDQUFDO2dCQUNqRSxnRUFBZ0U7Z0JBQ2hFLCtEQUErRDtnQkFDL0QsK0RBQStEO2dCQUMvRCxNQUFNLGdCQUFnQixDQUFDLFVBQVUsRUFBRSxVQUFVLENBQUMsQ0FBQztZQUNuRCxDQUFDO1lBQ0QsTUFBTSxRQUFRLEdBQUcsTUFBTSxvQkFBb0IsQ0FBQyxVQUFVLEVBQUUsVUFBVSxDQUFDLENBQUM7WUFDcEUsSUFBSSxVQUFVLENBQUMsR0FBRyxLQUFLLFNBQVMsRUFBRSxDQUFDO2dCQUMvQixNQUFNLFFBQVEsR0FBRyxNQUFNLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDO2dCQUNuRCxJQUFJLFFBQVEsSUFBSSxRQUFRLENBQUMsSUFBSSxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMzQyxNQUFNLElBQUksS0FBSyxDQUNYLGdDQUFnQyxTQUFTLGlCQUFpQixDQUM3RCxDQUFDO2dCQUNOLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO29CQUNaLE1BQU0sS0FBSyxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQ3RDLFVBQVUsRUFDVixZQUFZLEVBQ1osVUFBVSxDQUFDLEdBQUcsRUFDZCxTQUFTLEVBQ1QsRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsQ0FDWixDQUFDO29CQUM1QixJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxJQUFJLEtBQUssVUFBVSxFQUFFLENBQUM7d0JBQ3RDLE1BQU0sSUFBSSxLQUFLLENBQUMsNEJBQTRCLFNBQVMsRUFBRSxDQUFDLENBQUM7b0JBQzdELENBQUM7b0JBQ0QsVUFBVSxHQUFHLE1BQU0sa0JBQWtCLENBQUMsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUNqRSxDQUFDO3FCQUFNLENBQUM7b0JBQ0osVUFBVSxHQUFHLE1BQU0sa0JBQWtCLENBQUMsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUNqRSxDQUFDO1lBQ0wsQ0FBQztZQUNELE9BQU87Z0JBQ0gsSUFBSSxFQUFFLFVBQVU7Z0JBQ2hCLE1BQU0sRUFBRSxRQUFRLENBQUMsTUFBTTthQUMxQixDQUFDO1FBQ04sQ0FBQztJQUNMLENBQUM7SUFFRCxJQUFJLElBQUksR0FBRyxNQUFNLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzdDLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNSLE1BQU0sVUFBVSxHQUFHLFdBQVcsRUFBRSxDQUFDO1FBQ2pDLE1BQU0sbUJBQW1CLEdBQUcsV0FBVyxFQUFFLENBQUM7UUFDMUMsTUFBTSxJQUFJLEdBQUcsSUFBQSxxQ0FBdUIsRUFDaEMsVUFBVSxFQUNWLFNBQVMsRUFDVCxVQUFVLEVBQ1YsbUJBQW1CLENBQ3RCLENBQUM7UUFDRixNQUFNLE9BQU8sR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUN4QyxVQUFVLEVBQ1YsY0FBYyxFQUNkLFNBQVMsRUFDVCxJQUFJLEVBQ0osRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsQ0FDWixDQUFDO1FBQzVCLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNYLE1BQU0sSUFBSSxLQUFLLENBQUMsZUFBZSxTQUFTLEVBQUUsQ0FBQyxDQUFDO1FBQ2hELENBQUM7UUFDRCxJQUFJLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pELE1BQU0sSUFBSSxHQUFHLE1BQU0sZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM5QyxNQUFNLE1BQU0sR0FBRyxJQUFBLG9DQUFzQixFQUNqQyxVQUFVLEVBQ1YsWUFBWSxFQUNaLFVBQVUsRUFDVixtQkFBbUIsQ0FDdEIsQ0FBQztRQUNGLE1BQU0sUUFBUSxHQUFHLElBQUEsbUNBQXFCLEVBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3JELE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQ3hCLFVBQVUsRUFDVixpQkFBaUIsRUFDakIsSUFBSSxDQUFDLElBQUksRUFDVCxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQ3BDLENBQUM7UUFDRixNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDdEUsSUFBSSxHQUFHLE1BQU0sa0JBQWtCLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN0RCxNQUFNLFFBQVEsR0FBRyxNQUFNLG9CQUFvQixDQUFDLElBQUksRUFBRSxVQUFVLENBQUMsQ0FBQztRQUM5RCxNQUFNLGdCQUFnQixDQUFDLFVBQVUsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUMsT0FBTztZQUNILElBQUk7WUFDSixNQUFNLEVBQUUsUUFBUSxDQUFDLE1BQU07U0FDMUIsQ0FBQztJQUNOLENBQUM7SUFDRCxJQUFJLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3RELE1BQU0sUUFBUSxHQUFHLE1BQU0sb0JBQW9CLENBQUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQzlELE1BQU0sZ0JBQWdCLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUM5QyxPQUFPO1FBQ0gsSUFBSTtRQUNKLE1BQU0sRUFBRSxRQUFRLENBQUMsTUFBTTtLQUMxQixDQUFDO0FBQ04sQ0FBQztBQUVELEtBQUssVUFBVSx1QkFBdUIsQ0FBQyxJQVd0Qzs7SUFDRyxNQUFNLFVBQVUsR0FBRyxJQUFBLGtDQUFvQixFQUFDLElBQUksQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ3pFLE1BQU0sUUFBUSxHQUFHLE1BQU0sd0JBQXdCLENBQzNDLElBQUksQ0FBQyxTQUFTLEVBQ2QsSUFBSSxDQUFDLFVBQVUsRUFDZjtRQUNJLENBQUMsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSztRQUNoQyxDQUFDLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEtBQUs7UUFDaEMsS0FBSyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxHQUFHLElBQUksQ0FBQyxLQUFLO1FBQ3hDLE1BQU0sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsS0FBSztLQUM3QyxFQUNELFVBQVUsRUFDVixJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FDeEIsQ0FBQztJQUNGLE1BQU0sbUJBQW1CLENBQ3JCLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxFQUNqQixRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFDbEIsUUFBUSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQzdCLENBQUM7SUFDRixNQUFNLG1CQUFtQixHQUFHLElBQUEsd0NBQTBCLEVBQ2xELFFBQVEsQ0FBQyxNQUFNLEVBQ2YsSUFBQSxzQ0FBd0IsRUFBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQ3ZDLENBQUM7SUFDRiwyQ0FBMkM7SUFDM0MsOEJBQThCO0lBQzlCLE1BQU0saUJBQWlCLEdBQUcsQ0FBQSxNQUFBLElBQUksQ0FBQyxlQUFlLDBDQUFFLElBQUk7UUFDaEQsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBQSx3Q0FBMEIsRUFBQyxRQUFRLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUNsRixDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ1QsTUFBTSxPQUFPLEdBQXVCO1FBQ2hDLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtRQUN2QixXQUFXLEVBQUUsc0JBQVcsQ0FBQyxJQUFJO1FBQzdCLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztRQUNyQixRQUFRLEVBQUUsSUFBSSxDQUFDLFVBQVU7UUFDekIsU0FBUyxFQUFFLElBQUksQ0FBQyxTQUFTO1FBQ3pCLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSztRQUNqQixjQUFjLEVBQUUsSUFBSTtRQUNwQixXQUFXLEVBQUUsRUFBRTtRQUNmLFNBQVMsRUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUc7UUFDNUIsaUJBQWlCO1FBQ2pCLEtBQUssRUFBRSxJQUFJLENBQUMsS0FBSztRQUNqQixhQUFhLEVBQUU7WUFDWCxVQUFVLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJO1lBQzlCLFVBQVUsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFVBQVU7WUFDdEMsbUJBQW1CO1lBQ25CLGtCQUFrQixFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsa0JBQWtCO1lBQ3RELHVCQUF1QixFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsdUJBQXVCO1lBQ2hFLG9CQUFvQixFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsb0JBQW9CO1NBQzdEO0tBQ0osQ0FBQztJQUNGLElBQUksZUFBZSxHQUFHLEtBQUssQ0FBQztJQUM1QixJQUFJLGFBQWEsR0FBRyxLQUFLLENBQUM7SUFDMUIsSUFBSSxDQUFDO1FBQ0QsTUFBTSxpQkFBaUIsR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxhQUFhLENBQVksQ0FBQztRQUMxRixJQUFJLGlCQUFpQixFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO1FBQ2hFLENBQUM7UUFDRCxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxVQUFVLENBQUMsQ0FBQztRQUNsRCxlQUFlLEdBQUcsSUFBSSxDQUFDO1FBQ3ZCLE1BQU0sTUFBTSxHQUFHLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLHNCQUFzQixFQUFFO1lBQ3pFLElBQUksRUFBRSxzQkFBVyxDQUFDLElBQUk7WUFDdEIsTUFBTSxFQUFFLGdCQUFnQjtZQUN4QixJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUM7U0FDbEIsQ0FBc0IsQ0FBQztRQUN4QixJQUFJLENBQUMsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQ3JCLE1BQU0sSUFBSSxLQUFLLENBQUMsaUNBQWlDLENBQUMsQ0FBQztRQUN2RCxDQUFDO1FBQ0QsTUFBTSxVQUFVLEdBQUcsSUFBQSxxQ0FBdUIsRUFBQyxRQUFRLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUMvRSxxQ0FBcUM7UUFDckMsTUFBTSxjQUFjLEdBQUcsQ0FBQSxNQUFBLElBQUksQ0FBQyxlQUFlLDBDQUFFLElBQUk7WUFDN0MsQ0FBQyxDQUFDLElBQUEscUNBQXVCLEVBQUMsUUFBUSxDQUFDLE1BQU0sRUFBRSxVQUFVLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQztZQUM1RSxDQUFDLENBQUMsVUFBVSxDQUFDO1FBQ2pCLE1BQU0sb0JBQW9CLENBQUMsVUFBVSxFQUFFO1lBQ25DLFVBQVUsRUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUk7WUFDOUIsTUFBTSxFQUFFLGNBQWM7U0FDekIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3pFLGtFQUFrRTtRQUNsRSxzRUFBc0U7UUFDdEUsZ0VBQWdFO1FBQ2hFLGFBQWEsR0FBRyxJQUFJLENBQUM7UUFDckIsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDcEQsTUFBTSxpQkFBaUIsRUFBRSxDQUFDO1FBQzFCLE1BQU0sV0FBVyxHQUFHLE1BQU0sa0JBQWtCLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNwRixJQUFJLENBQUMsTUFBTSx5QkFBeUIsQ0FBQyxXQUFXLEVBQUUsY0FBYyxDQUFDLEVBQUUsQ0FBQztZQUNoRSxNQUFNLElBQUksS0FBSyxDQUFDLDBDQUEwQyxDQUFDLENBQUM7UUFDaEUsQ0FBQztRQUNELHdDQUF3QztRQUN4QyxnREFBZ0Q7UUFDaEQsSUFBSSxXQUFXLEdBQUcsY0FBYyxDQUFDO1FBQ2pDLElBQUksTUFBQSxJQUFJLENBQUMsZUFBZSwwQ0FBRSxJQUFJLEVBQUUsQ0FBQztZQUM3QixNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUNoQyxJQUFBLHdDQUEwQixFQUFDLFFBQVEsQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUNwRSxDQUFDO1lBQ0YsSUFBSSxjQUFjLENBQUMsTUFBTSxFQUFFLENBQUM7Z0JBQ3hCLE1BQU0sTUFBTSxHQUFHLElBQUEsMkNBQTZCLEVBQ3hDLE1BQU0sSUFBQSxtQkFBUSxFQUFDLGNBQWMsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsRUFDL0MsY0FBYyxDQUNqQixDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxjQUFjLENBQUMsdUJBQXVCLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7Z0JBQy9FLElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO29CQUNoQixXQUFXLEdBQUc7d0JBQ1YsR0FBRyxjQUFjO3dCQUNqQix1QkFBdUIsRUFBRTs0QkFDckIsR0FBRyxjQUFjLENBQUMsdUJBQXVCOzRCQUN6QyxHQUFHLE1BQU07eUJBQ1osQ0FBQyxJQUFJLEVBQUU7cUJBQ1gsQ0FBQztnQkFDTixDQUFDO1lBQ0wsQ0FBQztRQUNMLENBQUM7UUFDRCxNQUFNLFdBQVcsR0FBRyxNQUFNLGVBQWUsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDNUQsTUFBTSxhQUFhLEdBQUcsSUFBQSxrQ0FBb0IsRUFBQyxXQUFXLENBQUMsQ0FBQztRQUN4RCxJQUFJLENBQUMsYUFBYSxJQUFJLGFBQWEsQ0FBQyxVQUFVLEtBQUssVUFBVSxFQUFFLENBQUM7WUFDNUQsTUFBTSxJQUFJLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO1FBQ25ELENBQUM7UUFDRCxNQUFNLG9CQUFvQixDQUFDLFVBQVUsRUFBRSxFQUFFLFVBQVUsRUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsV0FBVyxFQUFFLENBQUMsQ0FBQztRQUNoRyxNQUFNLHlCQUF5QixDQUFDLFdBQVcsRUFBRSxVQUFVLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDdEUsTUFBTSxvQkFBb0IsQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDN0MsTUFBTSxRQUFRLEdBQUcsTUFBTSxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzNELElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsdUJBQXVCLENBQUMsQ0FBQztRQUM3QyxDQUFDO1FBQ0QsaUJBQWlCLENBQUMsUUFBUSxFQUFFO1lBQ3hCLElBQUksRUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUk7WUFDeEIsR0FBRyxFQUFFLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRztTQUN6QixDQUFDLENBQUM7UUFDSCxNQUFNLENBQUMsU0FBUyxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO1FBQ3JDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQy9CLE1BQU0sQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3JELE9BQU8sTUFBTSxDQUFDO0lBQ2xCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsSUFBSSxlQUFlLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUNwQyxJQUFJLENBQUM7Z0JBQUMsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztZQUFDLENBQUM7WUFDaEUsTUFBTSxDQUFDO2dCQUNILElBQUksS0FBSyxZQUFZLEtBQUs7b0JBQUcsS0FBaUQsQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDNUcsQ0FBQztRQUNMLENBQUM7UUFDRCxJQUFJLGFBQWEsSUFBSSxLQUFLLFlBQVksS0FBSztZQUFHLEtBQWlELENBQUMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1FBQ3pILE1BQU0sS0FBSyxDQUFDO0lBQ2hCLENBQUM7QUFDTCxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsS0FBSyxVQUFVLG9CQUFvQjtJQUMvQixNQUFNLFFBQVEsR0FBRyxjQUFjLENBQUM7SUFDaEMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ1osTUFBTSxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7SUFDRCxJQUFJLENBQUMsUUFBUSxDQUFDLFlBQVksSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN4RCxNQUFNLElBQUksS0FBSyxDQUFDLG1CQUFtQixDQUFDLENBQUM7SUFDekMsQ0FBQztJQUNELE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDL0IsTUFBTSxRQUFRLEdBQUcsTUFBTSxXQUFXLEVBQUUsQ0FBQztJQUNyQyxrQ0FBa0M7SUFDbEMsTUFBTSxNQUFNLEdBQUcsSUFBSSxvQkFBVyxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUN0RCxNQUFNLFNBQVMsR0FBRyxlQUFlLE1BQU0sQ0FBQyxNQUFNLElBQUksSUFBQSwwQkFBaUIsRUFBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztJQUN4RixNQUFNLElBQUksR0FBRyxNQUFNLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQy9DLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNSLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsR0FBRyxJQUFBLHNDQUF1QixHQUFFLEVBQUUsQ0FBQztJQUNqRixDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsSUFBQSxvQ0FBcUIsRUFBQyxNQUFNLElBQUEsbUJBQVEsRUFBQyxjQUFjLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLE1BQU0sU0FBUyxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzNELE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hELHNDQUFzQztJQUN0QyxNQUFNLGNBQWMsR0FBRyxRQUFRLENBQUMsb0JBQW9CO1NBQy9DLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFO1FBQ1osSUFBSSxDQUFDO1lBQ0QsT0FBTyxJQUFJLHNDQUFvQixDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzVDLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDTCxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO1NBQ0QsTUFBTSxDQUFDLENBQUMsT0FBTyxFQUFtQyxFQUFFLENBQUMsT0FBTyxLQUFLLElBQUksQ0FBQyxDQUFDO0lBQzVFLElBQUksY0FBYyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ3hCLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3pFLE1BQU0sZ0JBQWdCLEdBQUcsQ0FBQyxJQUFlLEVBQVcsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7WUFDaEYsTUFBTSxhQUFhLEdBQUcsZUFBZSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQztZQUN4RCxJQUFJLGFBQWEsQ0FBQyxNQUFNLEtBQUssUUFBUTtnQkFBRSxPQUFPLEtBQUssQ0FBQztZQUNwRCxPQUFPLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO21CQUNsRSxhQUFhLENBQUMsU0FBUyxJQUFJLElBQUEsNEJBQWlCLEVBQUMsS0FBSyxDQUFDLElBQUksSUFBQSwyQkFBZ0IsRUFBQyxLQUFLLENBQUMsQ0FBQzttQkFDL0UsQ0FBQyxhQUFhLENBQUMsTUFBTSxLQUFLLFFBQVEsSUFBSSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQzFFLENBQUMsQ0FBQyxDQUFDO1FBQ0gsTUFBTSx5QkFBeUIsQ0FDM0IsUUFBUSxDQUFDLEtBQUssRUFDZCxTQUFTLEVBQ1QsS0FBSyxFQUFFLElBQUksRUFBRSxFQUFFO1lBQ1gsS0FBSyxNQUFNLE9BQU8sSUFBSSxjQUFjLEVBQUUsQ0FBQztnQkFDbkMsSUFBSSxNQUFNLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDO29CQUN2QyxPQUFPLElBQUksQ0FBQztnQkFDaEIsQ0FBQztZQUNMLENBQUM7WUFDRCxPQUFPLEtBQUssQ0FBQztRQUNqQixDQUFDLEVBQ0QsZ0JBQWdCLENBQ25CLENBQUM7SUFDTixDQUFDO0lBQ0QsbUNBQW1DO0lBQ25DLE1BQU0sUUFBUSxHQUFHLElBQUEsK0NBQThCLEVBQUMsUUFBUSxDQUFDLEtBQUssRUFBRSxTQUFTLENBQUMsQ0FBQztJQUMzRSxTQUFTLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDbEIsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEtBQUssRUFBRSxHQUFHLEVBQUUsRUFBRSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7SUFDNUQsTUFBTSxLQUFLLEdBQUcsSUFBQSxrQ0FBaUIsRUFBQyxRQUFRLENBQUMsS0FBSyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzNELE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNsQyxNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsS0FBSztTQUN2QixHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FDbkIsSUFBSSxFQUNKLFNBQVMsRUFDVCxTQUFTLEVBQ1QsS0FBSyxFQUNMLFFBQVEsQ0FBQyxRQUFRLEVBQ2pCLElBQUksR0FBRyxFQUFFLEVBQ1QsSUFBSSxHQUFHLEVBQUUsRUFDVCxJQUFJLEVBQ0osQ0FBQyxFQUNELEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FDaEMsQ0FBQztTQUNELE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBeUIsRUFBRSxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQztJQUM1RCxPQUFPO1FBQ0gsU0FBUyxFQUFFLFNBQVM7UUFDcEIsTUFBTSxFQUFFLElBQUk7UUFDWixVQUFVLEVBQUUsSUFBSSxDQUFDLElBQUk7UUFDckIsR0FBRyxJQUFBLDhCQUFlLEVBQUMsUUFBUSxFQUFFLEtBQUssRUFBRSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsS0FBSyxFQUFFLENBQUM7S0FDakUsQ0FBQztBQUNOLENBQUM7QUFFRCxLQUFLLFVBQVUsYUFBYSxDQUFDLE9BQXNCLEVBQUUsaUJBQWdDLElBQUksRUFBRSxVQUV2RixFQUFFOztJQUNGLE1BQU0sUUFBUSxHQUFHLE1BQUEsT0FBTyxDQUFDLFFBQVEsbUNBQUksY0FBYyxDQUFDO0lBQ3BELElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBQ0QsTUFBTSxjQUFjLEdBQUcsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN0RCxNQUFNLFVBQVUsR0FBRyxjQUFjLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDbEQsTUFBTSxLQUFLLEdBQUcsSUFBQSw2QkFBZSxFQUFDLE1BQU0sRUFBRSxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNuSCxJQUFJLENBQUM7UUFDRCxNQUFNLFlBQVksQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUNuQyxZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDakUsTUFBTSxTQUFTLEdBQUcsV0FBVyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2hFLHdDQUF3QztRQUN4QywwQkFBMEI7UUFDMUIsTUFBTSxlQUFlLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxNQUFBLE9BQU8sQ0FBQyxlQUFlLG1DQUFJLEVBQUUsQ0FBQzthQUMxRCxNQUFNLENBQUMsQ0FBQyxFQUFFLEVBQWdCLEVBQUUsQ0FBQyxPQUFPLEVBQUUsS0FBSyxRQUFRLElBQUksT0FBTyxDQUFDLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO2FBQzFFLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2hELEtBQUssTUFBTSxNQUFNLElBQUksZUFBZSxFQUFFLENBQUM7WUFDbkMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUU7Z0JBQ2xCLE1BQU0sRUFBRSxRQUFRO2dCQUNoQixJQUFJLEVBQUUsTUFBTTtnQkFDWixTQUFTLEVBQUUsS0FBSztnQkFDaEIsUUFBUSxFQUFFLElBQUk7YUFDakIsQ0FBQyxDQUFDO1FBQ1AsQ0FBQztRQUNELE1BQU0sY0FBYyxHQUFHLFFBQVEsQ0FBQztRQUNoQyxhQUFhLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxRixNQUFNLGNBQWMsR0FBRyxJQUFJLG9DQUFvQixFQUFFLENBQUM7UUFDbEQsZ0RBQWdEO1FBQ2hELG9DQUFvQztRQUNwQyxNQUFNLFFBQVEsR0FBRyxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsWUFBWSxFQUFFLFFBQVEsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbEYsSUFBSSxpQkFBa0QsQ0FBQztRQUN2RCxJQUFJLFFBQVEsSUFBSSxjQUFjLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDM0MsSUFBSSxDQUFDO2dCQUNELE1BQU0sWUFBWSxHQUFHLElBQUksb0JBQVcsQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDLENBQUM7Z0JBQ2xFLE1BQU0sU0FBUyxHQUFHLGVBQWUsWUFBWSxDQUFDLE1BQU0sR0FBRztzQkFDakQsR0FBRyxJQUFBLDBCQUFpQixFQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDNUQsSUFBSSxNQUFNLGdCQUFnQixDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7b0JBQ3BDLE1BQU0sUUFBUSxHQUFHLElBQUEsb0NBQXFCLEVBQUMsTUFBTSxJQUFBLG1CQUFRLEVBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztvQkFDbEYsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7d0JBQ2hCLE1BQU0sS0FBSyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7d0JBQ2hDLE1BQU0sS0FBSyxHQUFHLENBQUMsSUFBZSxFQUFFLEVBQUU7NEJBQzlCLE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7NEJBQ3hELE1BQU0sS0FBSyxHQUFHLElBQUEsOEJBQWdCLEVBQUMsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDOzRCQUNwRSxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLFNBQVMsQ0FBQSxLQUFLLFFBQVE7bUNBQ3RELE9BQU8sS0FBSyxDQUFDLFNBQVMsS0FBSyxRQUFRLENBQUM7NEJBQzNDLE1BQU0sT0FBTyxHQUFHLE1BQU07Z0NBQ2xCLENBQUMsQ0FBQyxlQUFlO29DQUNiLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxTQUFTO29DQUN0QyxDQUFDLENBQUMsTUFBTSxDQUFDLFdBQVcsS0FBSyxLQUFLLENBQUMsV0FBVztnQ0FDOUMsQ0FBQyxDQUFDLElBQUksQ0FBQzs0QkFDWCxJQUFJLE9BQU87Z0NBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7NEJBQ2hDLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDO3dCQUNqQyxDQUFDLENBQUM7d0JBQ0YsUUFBUSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7d0JBQzlCLGlCQUFpQixHQUFHLEtBQUssQ0FBQztvQkFDOUIsQ0FBQztnQkFDTCxDQUFDO1lBQ0wsQ0FBQztZQUFDLE1BQU0sQ0FBQztnQkFDTCw4QkFBOEI7Z0JBQzlCLGlCQUFpQixHQUFHLFNBQVMsQ0FBQztZQUNsQyxDQUFDO1FBQ0wsQ0FBQztRQUNELE1BQU0sV0FBVyxHQUFHLE1BQU0sSUFBQSw0QkFBYyxFQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsR0FBRyxFQUFFLENBQUMsV0FBVyxDQUMzRSxRQUFRLEVBQ1IsU0FBUyxFQUNULGNBQWMsRUFDZCxjQUFjLEVBQ2QsRUFBRSxpQkFBaUIsRUFBRSxDQUN4QixDQUFDLENBQUM7UUFDSCxNQUFNLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxHQUFHLFdBQVcsQ0FBQztRQUN6QyxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTztZQUFFLE1BQU0sSUFBSSx1QkFBYyxFQUFFLENBQUM7UUFDMUQsTUFBTSxZQUFZLEdBQUcsS0FBSyxFQUFFLE1BQXlCLEVBQUUsRUFBRTtZQUNyRCxNQUFNLENBQUMsTUFBTSxHQUFHLE1BQU0sSUFBQSw2Q0FBb0IsRUFBQyxhQUFhLEVBQUUsY0FBYyxFQUFFLGNBQWMsRUFDcEYsTUFBTSxDQUFDLFlBQVksRUFBRSxNQUFNLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxTQUFTLEVBQUUsUUFBUSxFQUNuRSxLQUFLLElBQUksRUFBRSxDQUFDLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLHNCQUFzQixFQUFFO2dCQUN0RSxJQUFJLEVBQUUsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLG9CQUFvQixFQUFFLElBQUksRUFBRSxDQUFDLEVBQUUsRUFBRSxFQUFFLGNBQWMsQ0FBQyxFQUFFLEVBQUUsQ0FBQzthQUMxRixDQUFnQixDQUFDLENBQUM7WUFDdkIsb0VBQW9FO1lBQ3BFLElBQUksQ0FBQztnQkFDRCxJQUFJLE9BQU8sQ0FBQyxZQUFZLEVBQUUsQ0FBQztvQkFDdkIsT0FBTyxNQUFNLENBQUMsWUFBWSxDQUFDO29CQUMzQixPQUFPLE1BQU0sQ0FBQyxXQUFXLENBQUM7b0JBQzFCLE9BQU87Z0JBQ1gsQ0FBQztnQkFDRCxNQUFNLE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLHNCQUFXLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNoRixDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDYixRQUFRLENBQUMsSUFBSSxDQUFDLG1DQUFvQyxLQUFlLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUNqRixDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUMsWUFBWSxDQUFDO1lBQzNCLE9BQU8sTUFBTSxDQUFDLFdBQVcsQ0FBQztRQUM5QixDQUFDLENBQUM7UUFDRixxRUFBcUU7UUFDckUscUVBQXFFO1FBQ3JFLHlCQUF5QjtRQUN6QixNQUFNLEtBQUssR0FBRyxJQUFBLGtDQUFpQixFQUFDLFFBQVEsQ0FBQyxLQUFLLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDM0QsTUFBTSxLQUFLLEdBQUcsTUFBTSxZQUFZLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDakQsTUFBTSxnQkFBZ0IsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUN2RCxNQUFNLGFBQWEsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDaEQsTUFBTSxhQUFhLEdBQUcsYUFBYTtZQUMvQixDQUFDLENBQUMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxFQUFFLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO2tCQUM3RCxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLEdBQUcsR0FBRztZQUNwRCxDQUFDLENBQUMsTUFBQSxNQUFBLGdCQUFnQixDQUFDLENBQUMsQ0FBQywwQ0FBRSxLQUFLLG1DQUFJLENBQUMsQ0FBQztRQUN0QyxNQUFNLFNBQVMsR0FBRyxhQUFhO1lBQzNCLENBQUMsQ0FBQztnQkFDRSxDQUFDLEVBQUUsQ0FBQztnQkFDSixDQUFDLEVBQUUsQ0FBQztnQkFDSixLQUFLLEVBQUUsYUFBYTtnQkFDcEIsTUFBTSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLEdBQUcsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7YUFDeEU7WUFDRCxDQUFDLENBQUMsTUFBQSxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsbUNBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLENBQUM7UUFDakUsSUFBSSxVQUFVLEdBQUcsQ0FBQyxDQUFDO1FBQ25CLG1DQUFtQztRQUNuQyxrQ0FBa0M7UUFDbEMsTUFBTSxXQUFXLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUN6RSxNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsS0FBSzthQUN2QixHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUU7WUFDakIsTUFBTSxJQUFJLEdBQUcsUUFBUSxDQUNqQixJQUFJLEVBQ0osU0FBUyxFQUNULFNBQVMsRUFDVCxLQUFLLEVBQ0wsUUFBUSxDQUFDLFFBQVEsRUFDakIsTUFBTSxFQUNOLEtBQUssRUFDTCxJQUFJLEVBQ0osQ0FBQyxFQUNELFdBQVcsQ0FDZCxDQUFDO1lBQ0YsSUFBSSxJQUFJLElBQUksYUFBYSxFQUFFLENBQUM7Z0JBQ3hCLElBQUksQ0FBQyxLQUFLLEdBQUc7b0JBQ1QsQ0FBQyxFQUFFLFVBQVU7b0JBQ2IsQ0FBQyxFQUFFLENBQUM7b0JBQ0osS0FBSyxFQUFFLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUs7b0JBQ3BDLE1BQU0sRUFBRSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNO2lCQUN6QyxDQUFDO2dCQUNGLFVBQVUsSUFBSSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLEdBQUcsR0FBRyxDQUFDO1lBQ3RELENBQUM7WUFDRCxPQUFPLElBQUksQ0FBQztRQUNoQixDQUFDLENBQUM7YUFDRCxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQXlCLEVBQUUsQ0FBQyxJQUFJLEtBQUssSUFBSSxDQUFDLENBQUM7UUFDNUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNoQixNQUFNLElBQUksS0FBSyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1FBQ3BDLENBQUM7UUFDRCxJQUFJLFdBQVcsRUFBRSxDQUFDO1lBQ2QsSUFBSSxDQUFDO2dCQUNELElBQUEsdUNBQXlCLEVBQUMsc0JBQXNCLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUM3RCxDQUFDO1lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztnQkFDYixRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDO1lBQzNFLENBQUM7UUFDTCxDQUFDO1FBRUQsTUFBTSxZQUFZLEdBQUcsUUFBUSxDQUFDLFlBQVksQ0FBQztRQUMzQyxJQUFJLFlBQVksSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3JDLE1BQU0sWUFBWSxHQUFHLElBQUksb0JBQVcsQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDbEUsTUFBTSxZQUFZLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEMsTUFBTSxTQUFTLEdBQUcsQ0FBQSxNQUFBLE1BQUEsS0FBSyxDQUFDLENBQUMsQ0FBQywwQ0FBRSxJQUFJLDBDQUFFLElBQUksRUFBRTtvQkFDakMsTUFBQSxNQUFBLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLDBDQUFFLElBQUksMENBQUUsSUFBSSxFQUFFLENBQUE7bUJBQy9CLFFBQVEsQ0FBQyxRQUFRLENBQUM7WUFDekIsTUFBTSxTQUFTLEdBQUcsZUFBZSxZQUFZLENBQUMsTUFBTSxJQUFJLElBQUEsMEJBQWlCLEVBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQztZQUM5RixJQUFJLFdBQVcsRUFBRSxDQUFDO2dCQUNkLFlBQVksQ0FBQztvQkFDVCxLQUFLLEVBQUUsT0FBTztvQkFDZCxLQUFLLEVBQUUsSUFBSTtvQkFDWCxPQUFPLEVBQUUsZUFBZTtpQkFDM0IsQ0FBQyxDQUFDO2dCQUNILE1BQU0sTUFBTSxHQUFHLE1BQU0sc0JBQXNCLEVBQUUsQ0FBQztnQkFDOUMsSUFBSSxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7b0JBQ2hCLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2dCQUNqQyxDQUFDO1lBQ0wsQ0FBQztZQUNELFlBQVksQ0FBQztnQkFDVCxLQUFLLEVBQUUsT0FBTztnQkFDZCxLQUFLLEVBQUUsSUFBSTtnQkFDWCxPQUFPLEVBQUUsbUJBQW1CO2FBQy9CLENBQUMsQ0FBQztZQUNILE1BQU0sTUFBTSxHQUFHLE1BQU0sdUJBQXVCLENBQUM7Z0JBQ3pDLFFBQVEsRUFBRSxjQUFjLENBQUMsRUFBRTtnQkFDM0IsU0FBUztnQkFDVCxVQUFVLEVBQUUsU0FBUztnQkFDckIsT0FBTyxFQUFFLFFBQVEsQ0FBQyxPQUFPO2dCQUN6QixZQUFZO2dCQUNaLFNBQVM7Z0JBQ1QsS0FBSyxFQUFFLGNBQWMsQ0FBQyxLQUFLO2dCQUMzQixLQUFLO2dCQUNMLGVBQWU7YUFDbEIsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxNQUFNLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztnQkFDM0IsUUFBUSxDQUFDLElBQUksQ0FBQyxhQUFhLE1BQU0sQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLENBQUM7WUFDM0QsQ0FBQztZQUNELE1BQU0sUUFBUSxHQUFHLE1BQU0sV0FBVyxFQUFFLENBQUM7WUFDckMsaUVBQWlFO1lBQ2pFLHFFQUFxRTtZQUNyRSxPQUFPLFFBQVEsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDbEMsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ25GLE1BQU0sWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzNCLE1BQU0sV0FBVyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxNQUFNLEVBQUUsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztZQUN2RSxZQUFZLENBQUM7Z0JBQ1QsS0FBSyxFQUFFLE1BQU07Z0JBQ2IsS0FBSyxFQUFFLENBQUM7Z0JBQ1IsT0FBTyxFQUFFLFNBQVMsTUFBTSxDQUFDLE9BQU8sT0FBTyxNQUFNLENBQUMsT0FBTyxXQUFXLFNBQVMsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFO2FBQ3RJLENBQUMsQ0FBQztZQUNILE9BQU8sV0FBVyxDQUFDO1FBQ3ZCLENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxNQUFNLFdBQVcsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sT0FBTyxHQUF1QjtZQUNoQyxRQUFRLEVBQUUsY0FBYyxDQUFDLEVBQUU7WUFDM0IsV0FBVyxFQUFFLHNCQUFXLENBQUMsSUFBSTtZQUM3QixPQUFPLEVBQUUsUUFBUSxDQUFDLE9BQU87WUFDekIsUUFBUSxFQUFFLFFBQVEsQ0FBQyxRQUFRO1lBQzNCLFNBQVM7WUFDVCxLQUFLLEVBQUUsY0FBYyxDQUFDLEtBQUs7WUFDM0IsY0FBYyxFQUFFLGNBQWMsQ0FBQyxjQUFjO1lBQzdDLFdBQVcsRUFBRSxNQUFBLFFBQVEsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLG1DQUFJLEVBQUU7WUFDN0MsS0FBSztTQUNSLENBQUM7UUFDRixZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxHQUFHLEVBQUUsT0FBTyxFQUFFLGlCQUFpQixFQUFFLENBQUMsQ0FBQztRQUN6RSxNQUFNLE1BQU0sR0FBRyxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxzQkFBc0IsRUFBRTtZQUN6RSxJQUFJLEVBQUUsc0JBQVcsQ0FBQyxJQUFJO1lBQ3RCLE1BQU0sRUFBRSxnQkFBZ0I7WUFDeEIsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDO1NBQ2xCLENBQXNCLENBQUM7UUFDeEIsTUFBTSxNQUFNLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDbEQsUUFBUSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDO1FBQzVDLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQztRQUNuRixNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ2pELElBQUksY0FBYyxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQzFCLE1BQU0sTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLFlBQVksQ0FBQyxDQUFDO1FBQ3hELENBQUM7UUFDRCxNQUFNLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUMzQixNQUFNLFdBQVcsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQUcsTUFBTSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7UUFDdkUsWUFBWSxDQUFDO1lBQ1QsS0FBSyxFQUFFLE1BQU07WUFDYixLQUFLLEVBQUUsQ0FBQztZQUNSLE9BQU8sRUFBRSxTQUFTLE1BQU0sQ0FBQyxPQUFPLE9BQU8sTUFBTSxDQUFDLE9BQU8sR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFO1NBQ2xILENBQUMsQ0FBQztRQUNILEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNiLE9BQU8sV0FBVyxDQUFDO0lBQ3ZCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNsQixJQUFJLEtBQUssWUFBWSx1QkFBYyxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDL0QsWUFBWSxDQUFDLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDO1lBQ2hFLE1BQU0sSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDOUIsQ0FBQztRQUNELFlBQVksQ0FBQztZQUNULEtBQUssRUFBRSxPQUFPO1lBQ2QsS0FBSyxFQUFFLENBQUM7WUFDUixPQUFPLEVBQUUsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTztTQUM1RCxDQUFDLENBQUM7UUFDSCxNQUFNLEtBQUssQ0FBQztJQUNoQixDQUFDO1lBQVMsQ0FBQztRQUNQLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUM1QixLQUFLLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzNCLENBQUM7QUFDTCxDQUFDO0FBRUQsS0FBSyxVQUFVLGlCQUFpQjtJQUM1QixNQUFNLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUN6QixNQUFNLFFBQVEsR0FBRyxjQUFjLENBQUM7SUFDaEMsT0FBTztRQUNILE9BQU8sRUFBRSxzQkFBVyxDQUFDLE9BQU87UUFDNUIsS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUU7UUFDckIsUUFBUSxFQUFFLE1BQU0sV0FBVyxFQUFFO1FBQzdCLFFBQVEsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO1lBQ2pCLE9BQU8sRUFBRSxRQUFRLENBQUMsT0FBTztZQUN6QixRQUFRLEVBQUUsUUFBUSxDQUFDLFFBQVE7WUFDM0IsU0FBUyxFQUFFLFFBQVEsQ0FBQyxTQUFTO1lBQzdCLElBQUksRUFBRSxRQUFRLENBQUMsSUFBSTtZQUNuQixLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQUs7WUFDckIsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQztTQUMxRCxDQUFDLENBQUMsQ0FBQyxJQUFJO0tBQ1gsQ0FBQztBQUNOLENBQUM7QUFFRCxLQUFLLFVBQVUsY0FBYztJQUN6QixPQUFPO1FBQ0gsR0FBRyxNQUFNLGlCQUFpQixFQUFFO1FBQzVCLFVBQVUsRUFBRSxNQUFNLGNBQWMsRUFBRTtLQUNyQyxDQUFDO0FBQ04sQ0FBQztBQUVELEtBQUssVUFBVSxrQkFBa0IsQ0FBQyxTQUFpQjtJQUMvQyxNQUFNLFVBQVUsR0FBRyxjQUFjLEVBQUUsQ0FBQztJQUNwQyxJQUFJLENBQUM7UUFDRCxZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFLENBQUMsQ0FBQztRQUN6RSxNQUFNLE1BQU0sR0FBRyxJQUFBLHNCQUFnQixFQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQzNDLE1BQU0sR0FBRyxHQUFHLE1BQU0sTUFBTSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUM1QyxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsTUFBTTtZQUN6QixDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQztZQUNsRCxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN4QyxNQUFNLFFBQVEsR0FBRyxvQkFBb0IsQ0FDakMsSUFBQSxzQkFBYSxFQUFDLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQ25FLENBQUM7UUFDRixNQUFNLE9BQU8sR0FBRyxNQUFNLFdBQVcsRUFBRSxDQUFDO1FBQ3BDLE1BQU0sWUFBWSxDQUFDLEVBQUUsR0FBRyxPQUFPLEVBQUUsU0FBUyxFQUFFLENBQUMsQ0FBQztRQUM5QyxNQUFNLFVBQVUsR0FBRyxNQUFNLGNBQWMsRUFBRSxDQUFDO1FBQzFDLE1BQU0sYUFBYSxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQy9ELGNBQWMsR0FBRyxRQUFRLENBQUM7UUFDMUIsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO1FBQ3RCLFlBQVksQ0FBQyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxPQUFPLEVBQUUsT0FBTyxRQUFRLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQy9FLE9BQU87WUFDSCxPQUFPLEVBQUUsUUFBUSxDQUFDLE9BQU87WUFDekIsUUFBUSxFQUFFLFFBQVEsQ0FBQyxRQUFRO1lBQzNCLFNBQVM7WUFDVCxJQUFJLEVBQUUsUUFBUSxDQUFDLElBQUk7WUFDbkIsS0FBSyxFQUFFLFFBQVEsQ0FBQyxLQUFLO1lBQ3JCLFVBQVU7WUFDVixhQUFhO1NBQ2hCLENBQUM7SUFDTixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLFlBQVksQ0FBQztZQUNULEtBQUssRUFBRSxPQUFPO1lBQ2QsS0FBSyxFQUFFLENBQUM7WUFDUixPQUFPLEVBQUUsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTztTQUM1RCxDQUFDLENBQUM7UUFDSCxNQUFNLEtBQUssQ0FBQztJQUNoQixDQUFDO1lBQVMsQ0FBQztRQUNQLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUNoQyxDQUFDO0FBQ0wsQ0FBQztBQUVELEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxRQUF5QixFQUFFLFVBQThCO0lBQ3JGLE9BQU87UUFDSCxPQUFPLEVBQUUsUUFBUSxDQUFDLE9BQU8sRUFBRSxRQUFRLEVBQUUsUUFBUSxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsUUFBUSxDQUFDLFNBQVM7UUFDckYsSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxLQUFLO1FBQzFDLFVBQVUsRUFBRSxVQUFVLGFBQVYsVUFBVSxjQUFWLFVBQVUsR0FBSSxNQUFNLGNBQWMsRUFBRTtRQUNoRCxhQUFhLEVBQUUsQ0FBQyxNQUFNLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0tBQzdHLENBQUM7QUFDTixDQUFDO0FBRUQsS0FBSyxVQUFVLGtCQUFrQixDQUFDLFNBQWlCO0lBQy9DLE1BQU0sTUFBTSxHQUFHLElBQUEsc0JBQWdCLEVBQUMsU0FBUyxDQUFDLENBQUM7SUFDM0MsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNqQixJQUFJLGNBQWMsQ0FBQyxJQUFJO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1FBQ3pGLE1BQU0sUUFBUSxHQUFHLE1BQU0sa0JBQWtCLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDckQsT0FBTyxFQUFFLFVBQVUsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxVQUFVLEVBQUUsQ0FBQyxFQUFFLFFBQVEsRUFBRSxDQUFDO0lBQzNGLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxjQUFjLEVBQUUsQ0FBQztJQUNwQyxJQUFJLENBQUM7UUFDRCxZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLDBCQUEwQixFQUFFLENBQUMsQ0FBQztRQUNuRixNQUFNLEdBQUcsR0FBRyxNQUFNLE1BQU0sQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDNUMsTUFBTSxjQUFjLEdBQUcsSUFBQSxzQkFBYSxFQUFDLE1BQU0sR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFDakYsU0FBUyxFQUFFLE1BQU0sQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzlDLE1BQU0sSUFBSSxHQUFHLGNBQWMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckMsTUFBTSxVQUFVLEdBQUcsTUFBTSxjQUFjLEVBQUUsQ0FBQztRQUMxQyxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFLENBQUM7WUFDbkQsSUFBSSxjQUFjLENBQUMsSUFBSTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHlDQUF5QyxDQUFDLENBQUM7WUFDcEYsTUFBTSxRQUFRLEdBQUcsb0JBQW9CLENBQUMsY0FBYyxDQUFDLENBQUM7WUFDdEQsY0FBYyxHQUFHLFFBQVEsQ0FBQztZQUMxQixnQkFBZ0IsSUFBSSxDQUFDLENBQUM7WUFDdEIsTUFBTSxhQUFhLENBQUMsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDO1lBQ25DLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsVUFBVSxFQUFFLENBQUM7Z0JBQ3RFLFFBQVEsRUFBRSxNQUFNLGdCQUFnQixDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsRUFBRSxDQUFDO1FBQ2pFLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxJQUFBLG1DQUFvQixFQUFDLElBQUksQ0FBQyxDQUFDO1FBQzFDLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsMkNBQTJDLENBQUMsQ0FBQztRQUNqRixNQUFNLFFBQVEsR0FBK0QsRUFBRSxDQUFDO1FBQ2hGLElBQUksVUFBVSxHQUFHLENBQUMsQ0FBQztRQUNuQixLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ3pCLE1BQU0sRUFBRSxHQUFHLElBQUEsa0NBQW9CLEVBQUMsTUFBTSxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDMUQsTUFBTSxRQUFRLEdBQUcsY0FBYyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUN4QyxJQUFJLFFBQVEsRUFBRSxDQUFDO2dCQUNYLFVBQVUsSUFBSSxDQUFDLENBQUM7Z0JBQ2hCLFFBQVEsQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLFFBQVEsRUFBRSxJQUFJLEVBQUUsRUFBRSxHQUFHLFFBQVEsQ0FBQyxJQUFJO3dCQUNqRCxRQUFRLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLFVBQVUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO2dCQUN6RSxTQUFTO1lBQ2IsQ0FBQztZQUNELE1BQU0sUUFBUSxHQUFHLG9CQUFvQixDQUFDLElBQUEsNEJBQWEsRUFBQyxjQUFjLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUM1RSxNQUFNLElBQUksR0FBbUI7Z0JBQ3pCLEVBQUUsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLEVBQUUsRUFBRSxTQUFTLEVBQUUsUUFBUSxDQUFDLFNBQVM7Z0JBQzlFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJO2dCQUMvQixHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO2dCQUM5RCxRQUFRLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQyxRQUFRLEVBQUUsVUFBVSxDQUFDO2FBQ3pELENBQUM7WUFDRixRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDdEMsQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEdBQUcsVUFBVSxDQUFDO1FBQzNDLElBQUksY0FBYyxDQUFDLElBQUksR0FBRyxLQUFLLEdBQUcsZUFBZTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxHQUFHLGVBQWUsR0FBRyxhQUFhLENBQUMsQ0FBQztRQUNoSCxJQUFJLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTztZQUFFLE1BQU0sSUFBSSx1QkFBYyxFQUFFLENBQUM7UUFDMUQsS0FBSyxNQUFNLEtBQUssSUFBSSxRQUFRO1lBQUUsY0FBYyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN2RSxNQUFNLGFBQWEsQ0FBQyxFQUFFLFNBQVMsRUFBRSxDQUFDLENBQUM7UUFDbkMsWUFBWSxDQUFDLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxNQUFNLEdBQUcsS0FBSyxHQUFHLE1BQU07a0JBQ2xFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxHQUFHLEdBQUcsVUFBVSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUMvRCxPQUFPLEVBQUUsVUFBVSxFQUFFLElBQUksQ0FBQyxJQUFJLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxTQUFTO1lBQ3pFLEtBQUssRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxDQUFDO0lBQ3hFLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2IsWUFBWSxDQUFDLEVBQUUsS0FBSyxFQUFFLFVBQVUsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztZQUM3RSxPQUFPLEVBQUUsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztRQUNqRSxNQUFNLEtBQUssQ0FBQztJQUNoQixDQUFDO1lBQVMsQ0FBQztRQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUFDLENBQUM7QUFDOUMsQ0FBQztBQUVELEtBQUssVUFBVSxpQkFBaUIsQ0FBQyxFQUFVO0lBQ3ZDLE1BQU0sVUFBVSxHQUFHLGNBQWMsRUFBRSxDQUFDO0lBQ3BDLElBQUksQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFHLGNBQWMsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDckMsSUFBSSxDQUFDLEtBQUs7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDL0MsTUFBTSxRQUFRLEdBQUcsTUFBTSxnQkFBZ0IsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDeEQsY0FBYyxHQUFHLEtBQUssQ0FBQyxRQUFRLENBQUM7UUFDaEMsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO1FBQ3RCLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQztRQUMvQixPQUFPLFFBQVEsQ0FBQztJQUNwQixDQUFDO1lBQVMsQ0FBQztRQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztJQUFDLENBQUM7QUFDOUMsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEtBQThDO0lBQ2xFLElBQUksV0FBVyxJQUFJLGdCQUFnQjtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUMzRSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxHQUFHLGVBQWU7UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQzFGLE1BQU0sSUFBSSxHQUFHLElBQUksR0FBRyxFQUErRCxDQUFDO0lBQ3BGLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7UUFDdkIsTUFBTSxLQUFLLEdBQUcsSUFBSSxJQUFJLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2xELElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxJQUFJLENBQUMsT0FBTyxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDOUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLEVBQUUsR0FBRyxLQUFLLEVBQUUsSUFBSSxFQUFFLEVBQUUsR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ3BGLENBQUM7SUFDRCxjQUFjLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDdkIsS0FBSyxNQUFNLENBQUMsRUFBRSxFQUFFLEtBQUssQ0FBQyxJQUFJLElBQUk7UUFBRSxjQUFjLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUM5RCxPQUFPLEVBQUUsS0FBSyxFQUFFLENBQUMsR0FBRyxjQUFjLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO0FBQzlFLENBQUM7QUFFRCxLQUFLLFVBQVUsYUFBYTtJQUN4QixJQUFJLFdBQVc7UUFBRSxPQUFPO1lBQ3BCLEtBQUssRUFBRSxDQUFDLEdBQUcsY0FBYyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDO1lBQzlELFVBQVUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLGFBQWEsQ0FBQyxXQUFXLENBQUM7U0FDbkUsQ0FBQztJQUNGLE1BQU0sS0FBSyxHQUFHLE1BQU0sY0FBYyxFQUFFLENBQUM7SUFDckMsTUFBTSxLQUFLLEdBQXFCLEVBQUUsQ0FBQztJQUNuQyxLQUFLLE1BQU0sS0FBSyxJQUFJLGNBQWMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDO1FBQzFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFLE1BQU0sZ0JBQWdCLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDM0YsQ0FBQztJQUNELE9BQU8sRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLGVBQWUsRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFLE9BQU8sRUFBRSxhQUFhLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUNuSCxDQUFDO0FBRUQsS0FBSyxVQUFVLFdBQVcsQ0FBQyxPQUEyQjs7SUFDbEQsSUFBSSxXQUFXLElBQUksZ0JBQWdCLElBQUksb0JBQW9CLElBQUksbUJBQW1CO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDO0lBQ3pILElBQUksQ0FBQyxPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLGVBQWUsRUFBRSxDQUFDO1FBQy9HLE1BQU0sSUFBSSxLQUFLLENBQUMsa0JBQWtCLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBQ0QsTUFBTSxRQUFRLEdBQUcsWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNoRCxNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFOztRQUFDLE9BQUEsUUFBUSxDQUFDLGtCQUFrQjtlQUN4RSxDQUFBLE1BQUEsTUFBQSxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksYUFBSixJQUFJLHVCQUFKLElBQUksQ0FBRSxFQUFFLENBQUMsMENBQUUsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsMENBQUUsT0FBTyxNQUFLLEtBQUssQ0FBQTtLQUFBLENBQUMsQ0FBQztJQUMzRSxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU07UUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxDQUFDLENBQUM7SUFDbEYsTUFBTSxPQUFPLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFOztRQUN0QyxNQUFNLEtBQUssR0FBRyxJQUFJLElBQUksY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDbEQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQzVHLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsR0FBRyxRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDdEUsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDckMsTUFBTSxTQUFTLEdBQUcsV0FBVyxDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzlELElBQUksQ0FBQSxNQUFBLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQywwQ0FBRSxNQUFNLE1BQUssUUFBUTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLDJCQUEyQixDQUFDLENBQUM7UUFDdEgsTUFBTSxJQUFJLEdBQUcsQ0FBQSxNQUFBLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQywwQ0FBRSxJQUFJLEtBQUksSUFBSSxDQUFDLElBQUksQ0FBQztRQUN2RCxPQUFPLEVBQUUsR0FBRyxLQUFLLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDO0lBQ3pDLENBQUMsQ0FBQyxDQUFDO0lBQ0gsSUFBQSxpQ0FBa0IsRUFBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEYsTUFBTSxHQUFHLEdBQWE7UUFDbEIsRUFBRSxFQUFFLElBQUEsb0JBQVcsRUFBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxhQUFhLEVBQUUsS0FBSztRQUNuRSxLQUFLLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEUsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDO0tBQzdELENBQUM7SUFDRixXQUFXLEdBQUcsR0FBRyxDQUFDO0lBQ2xCLEtBQUssTUFBTSxLQUFLLElBQUksT0FBTztRQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUMsU0FBUyxDQUFDO0lBQ2pGLE1BQU0sZ0JBQWdCLEdBQUcsY0FBYyxDQUFDO0lBQ3hDLE1BQU0sY0FBYyxHQUFHLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0lBQzdFLE1BQU0sZUFBZSxHQUFHLEdBQXNCLEVBQUU7O1FBQzVDLE1BQU0sTUFBTSxHQUFHLElBQUksR0FBRyxFQUFpQyxDQUFDO1FBQ3hELEtBQUssTUFBTSxJQUFJLElBQUksTUFBQSxjQUFjLGFBQWQsY0FBYyx1QkFBZCxjQUFjLENBQUUsS0FBSyxtQ0FBSSxFQUFFLEVBQUUsQ0FBQztZQUM3QyxJQUFJLGNBQWMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxHQUFHLElBQUksRUFBRSxDQUFDLENBQUM7UUFDdEUsQ0FBQztRQUNELEtBQUssTUFBTSxJQUFJLElBQUksR0FBRyxDQUFDLEtBQUs7WUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxHQUFHLElBQUksRUFBRSxDQUFDLENBQUM7UUFDL0QsTUFBTSxLQUFLLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ25DLE9BQU8sRUFBRSxFQUFFLEVBQUUsR0FBRyxDQUFDLEVBQUUsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxhQUFhO1lBQ2xELFNBQVMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU07WUFDL0YsS0FBSyxFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztJQUM5QixDQUFDLENBQUM7SUFDRixJQUFJLENBQUM7UUFDRCwrREFBK0Q7UUFDL0QsTUFBTSxNQUFNLEdBQUcsSUFBSSxvQkFBVyxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxNQUFNLENBQUM7UUFDN0QsTUFBTSxRQUFRLEdBQUcsTUFBTSxpQkFBaUIsRUFBRSxDQUFDO1FBQzNDLEtBQUssTUFBTSxLQUFLLElBQUksT0FBTyxFQUFFLENBQUM7WUFDMUIsTUFBTSxHQUFHLEdBQUcsY0FBYyxHQUFHLE1BQU0sR0FBRyxHQUFHLEdBQUcsSUFBQSwwQkFBaUIsRUFBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsU0FBUyxDQUFDO1lBQ3RGLE1BQU0sSUFBSSxHQUFHLE1BQU0sZ0JBQWdCLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDekMsSUFBSSxDQUFDLElBQUk7Z0JBQUUsU0FBUztZQUNwQixNQUFNLE1BQU0sR0FBRyxJQUFBLGtDQUFvQixFQUFDLE1BQU0sZUFBZSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ3RFLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLFVBQVUsS0FBSyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUU7bUJBQzNDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksUUFBUSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7Z0JBQ3hFLE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLEdBQUcsa0NBQWtDLENBQUMsQ0FBQztZQUMzRSxDQUFDO1FBQ0wsQ0FBQztRQUNELElBQUksR0FBRyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3BCLE1BQU0sTUFBTSxHQUFHLGVBQWUsRUFBRSxDQUFDO1lBQ2pDLGVBQWUsR0FBRyxNQUFNLENBQUM7WUFDekIsWUFBWSxDQUFDLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxlQUFlLEVBQUUsS0FBSyxFQUFFLEVBQUUsR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLEVBQUUsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ25ILE9BQU8sTUFBTSxDQUFDO1FBQ2xCLENBQUM7UUFDRCxhQUFhLENBQUMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMxRixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1lBQ2xELElBQUksR0FBRyxDQUFDLGFBQWE7Z0JBQUUsTUFBTTtZQUM3QixHQUFHLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztZQUNsQixNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDN0IsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUM3QixHQUFHLENBQUMsTUFBTSxHQUFHLFNBQVMsQ0FBQztZQUN2QixjQUFjLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQztZQUNoQyxnQkFBZ0IsSUFBSSxDQUFDLENBQUM7WUFDdEIsWUFBWSxDQUFDLEVBQUUsS0FBSyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE9BQU8sRUFBRSxPQUFPLEdBQUcsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEdBQUcsR0FBRyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEdBQUcsR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ3RILElBQUksQ0FBQztnQkFDRCxNQUFNLE1BQU0sR0FBRyxNQUFNLGFBQWEsQ0FBQyxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztvQkFDM0QsUUFBUSxFQUFFLEVBQUUsR0FBRyxRQUFRLEVBQUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLEVBQUUsRUFBRSxHQUFHLENBQUMsRUFBRSxFQUN4RSxFQUFFLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxFQUFFLGVBQWUsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7Z0JBQ3pFLE1BQU0sQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDLFNBQVM7b0JBQy9ELE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsUUFBUTtvQkFDM0UsUUFBUSxFQUFFLE1BQUEsTUFBTSxDQUFDLE1BQU0sMENBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQztnQkFDbkMsR0FBRyxDQUFDLE1BQU0sR0FBRyxTQUFTLENBQUM7WUFDM0IsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2IsSUFBSSxNQUFNLEdBQUcsT0FBTyxDQUFFLEtBQXlDLGFBQXpDLEtBQUssdUJBQUwsS0FBSyxDQUFzQyxpQkFBaUIsQ0FBQyxDQUFDO2dCQUNwRixJQUFJLENBQUM7b0JBQUMsSUFBSSxNQUFNLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxhQUFhLENBQUM7d0JBQUUsTUFBTSxHQUFHLElBQUksQ0FBQztnQkFBQyxDQUFDO2dCQUNoRixNQUFNLENBQUM7b0JBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztnQkFBQyxDQUFDO2dCQUN4QixHQUFHLENBQUMsTUFBTSxHQUFHLFFBQVEsQ0FBQztnQkFDdEIsR0FBRyxDQUFDLEtBQUssR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7Z0JBQzdELElBQUksTUFBTSxFQUFFLENBQUM7b0JBQ1QsR0FBRyxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztvQkFDN0IsR0FBRyxDQUFDLEtBQUssSUFBSSx1Q0FBdUMsQ0FBQztnQkFDekQsQ0FBQztnQkFDRCxJQUFJLE1BQU0sSUFBSSxPQUFPLENBQUMsYUFBYSxLQUFLLE1BQU07b0JBQUUsR0FBRyxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7WUFDN0UsQ0FBQztZQUNELFlBQVksQ0FBQyxFQUFFLEtBQUssRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLENBQUM7Z0JBQ25DLE9BQU8sRUFBRSxLQUFLLENBQUMsSUFBSSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNqRixDQUFDO1FBQ0QsTUFBTSxNQUFNLEdBQUcsZUFBZSxFQUFFLENBQUM7UUFDakMsZUFBZSxHQUFHLE1BQU0sQ0FBQztRQUN6QixZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsU0FBUztZQUN6RixLQUFLLEVBQUUsRUFBRSxHQUFHLGFBQWEsQ0FBQyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDaEQsT0FBTyxNQUFNLENBQUM7SUFDbEIsQ0FBQztZQUFTLENBQUM7UUFDUCxJQUFJLFdBQVcsS0FBSyxHQUFHO1lBQUUsV0FBVyxHQUFHLElBQUksQ0FBQztRQUM1QyxjQUFjLEdBQUcsZ0JBQWdCLENBQUM7UUFDbEMsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO0lBQzFCLENBQUM7QUFDTCxDQUFDO0FBRUQsU0FBUyxlQUFlO0lBQ3BCLElBQUksQ0FBQyxXQUFXO1FBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsQ0FBQztJQUM3QyxXQUFXLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztJQUNqQyxZQUFZLENBQUMsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsT0FBTyxFQUFFLHVCQUF1QixFQUFFLENBQUMsQ0FBQztJQUM3RSxPQUFPLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDO0FBQzlCLENBQUM7QUFFRCxLQUFLLFVBQVUsY0FBYyxDQUFDLE1BQWM7SUFDeEMsTUFBTSxRQUFRLEdBQUcsY0FBYyxDQUFDO0lBQ2hDLE1BQU0sSUFBSSxHQUFHLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzVDLElBQUksQ0FBQyxRQUFRLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNyQixNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7SUFDRCxNQUFNLFVBQVUsR0FBRyxjQUFjLEVBQUUsQ0FBQztJQUNwQyxJQUFJLENBQUM7UUFDRCxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsTUFBTSxNQUFNLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUM3RCxRQUFRLENBQUMsT0FBTyxFQUNoQixDQUFDLE1BQU0sQ0FBQyxFQUNSLEtBQUssRUFDTCxDQUFDLEVBQ0QsQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsQ0FDaEMsQ0FBQztRQUNGLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUNoQixNQUFNLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQ2pDLENBQUM7UUFDRCxPQUFPLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO0lBQ2pDLENBQUM7WUFBUyxDQUFDO1FBQ1AsZUFBZSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2hDLENBQUM7QUFDTCxDQUFDO0FBRVksUUFBQSxPQUFPLEdBQTRDO0lBQzVELGVBQWUsQ0FBQyxFQUFXLElBQUksT0FBTyxhQUFhLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RCxrQkFBa0I7SUFDbEIsaUJBQWlCO0lBQ2pCLGNBQWM7SUFDZCxhQUFhO0lBQ2IsV0FBVztJQUNYLGVBQWU7SUFDZixLQUFLLENBQUMsc0JBQXNCLENBQUMsRUFBVSxFQUFFLE9BQWUsSUFBSSxPQUFPLGFBQWEsQ0FBQyxPQUFPLENBQUMsRUFBRSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN4RyxLQUFLLENBQUMsaUJBQWlCLENBQUMsRUFBVSxFQUFFLFVBQW1CO1FBQ25ELElBQUksZ0JBQWdCO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO1FBQzlELE1BQU0sVUFBVSxHQUFHLGNBQWMsRUFBRSxDQUFDO1FBQ3BDLG9CQUFvQixHQUFHLElBQUksQ0FBQztRQUM1QixJQUFJLENBQUM7WUFBQyxPQUFPLE1BQU0sYUFBYSxDQUFDLEtBQUssQ0FBQyxFQUFFLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFBQyxDQUFDO2dCQUNqRCxDQUFDO1lBQUMsb0JBQW9CLEdBQUcsS0FBSyxDQUFDO1lBQUMsZUFBZSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQUMsQ0FBQztJQUMxRSxDQUFDO0lBQ0QsS0FBSyxDQUFDLDRCQUE0QixDQUFDLEVBQVUsRUFBRSxPQUFlLEVBQUUsTUFBYztRQUMxRSxJQUFJLGdCQUFnQjtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztRQUM1RCxNQUFNLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxHQUFHLGFBQWEsQ0FBQyxNQUFNLENBQUMsRUFBRSxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNwRSxNQUFNLFVBQVUsR0FBRyxjQUFjLEVBQUUsQ0FBQztRQUNwQyxJQUFJLENBQUM7WUFDRCxNQUFNLEdBQUcsR0FBRyxNQUFNLE1BQU0sRUFBRSxDQUFDO1lBQzNCLE1BQU0sUUFBUSxHQUFHLElBQUEsOEJBQW1CLEVBQUMsSUFBSSxDQUFDLENBQUM7WUFDM0MsSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDWCxNQUFNLEtBQUssR0FBRyxNQUFNLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDbEQsSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDO29CQUFFLE9BQU8sRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxFQUFFLElBQUksRUFBRSxtQkFBbUIsRUFBRSxDQUFDO1lBQ3BGLENBQUM7WUFDRCxNQUFNLElBQUksR0FBRyxNQUFNLEdBQUcsQ0FBQyxZQUFZLENBQUMsT0FBTyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1lBQ2pHLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGdDQUFnQyxDQUFDLENBQUM7WUFDdEUsT0FBTyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSwyQkFBMkIsRUFBRSxDQUFDO1FBQ3JFLENBQUM7Z0JBQVMsQ0FBQztZQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUFDLENBQUM7SUFDOUMsQ0FBQztJQUNELFNBQVM7UUFDTCxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxzQkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hDLENBQUM7SUFFRCxLQUFLLENBQUMsUUFBUTtRQUNWLE9BQU8sY0FBYyxFQUFFLENBQUM7SUFDNUIsQ0FBQztJQUVELEtBQUssQ0FBQyxRQUFRLENBQUMsS0FBYTtRQUN4QixPQUFPLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUIsQ0FBQztJQUVELEtBQUssQ0FBQyxVQUFVO1FBQ1osT0FBTyxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDekIsQ0FBQztJQUVELEtBQUssQ0FBQyxXQUFXO1FBQ2IsTUFBTSxVQUFVLEdBQUcsY0FBYyxFQUFFLENBQUM7UUFDcEMsSUFBSSxDQUFDO1lBQ0QsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLE1BQU0sTUFBTSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ2xFLE9BQU87Z0JBQ0gsRUFBRSxFQUFFLElBQUk7Z0JBQ1IsTUFBTSxFQUFFLFFBQVEsQ0FBQyxNQUFNLElBQUksWUFBWTthQUMxQyxDQUFDO1FBQ04sQ0FBQztnQkFBUyxDQUFDO1lBQ1AsZUFBZSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ2hDLENBQUM7SUFDTCxDQUFDO0lBRUQsS0FBSyxDQUFDLFlBQVksQ0FBQyxLQUFjO1FBQzdCLE9BQU8sWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQy9CLENBQUM7SUFFRCxLQUFLLENBQUMsaUJBQWlCLENBQUMsT0FBZ0IsRUFBRSxTQUFrQixFQUFFLFFBQWlCO1FBQzNFLE9BQU8saUJBQWlCLENBQUMsT0FBTyxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBRUQsS0FBSyxDQUFDLGVBQWUsQ0FBQyxPQUFnQjtRQUNsQyxPQUFPLGVBQWUsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNwQyxDQUFDO0lBRUQsS0FBSyxDQUFDLGdCQUFnQixDQUFDLE9BQWdCO1FBQ25DLE9BQU8sZ0JBQWdCLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDckMsQ0FBQztJQUVELEtBQUssQ0FBQyx1QkFBdUIsQ0FBQyxPQUFnQjtRQUMxQyxPQUFPLHVCQUF1QixDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFFRCxLQUFLLENBQUMsZUFBZSxDQUFDLE9BQWdCO1FBQ2xDLE9BQU8sdUJBQXVCLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUVELEtBQUssQ0FBQyxhQUFhLENBQUMsU0FBaUI7UUFDakMsT0FBTyxrQkFBa0IsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBRUQsS0FBSyxDQUFDLFVBQVUsQ0FBQyxNQUFjO1FBQzNCLE9BQU8sY0FBYyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ2xDLENBQUM7SUFFRCxLQUFLLENBQUMsV0FBVztRQUNiLE9BQU8sb0JBQW9CLEVBQUUsQ0FBQztJQUNsQyxDQUFDO0lBRUQsS0FBSyxDQUFDLGVBQWUsQ0FBQyxTQUFpQixFQUFFLGNBQXVCO1FBQzVELE1BQU0sVUFBVSxHQUFHLHVCQUF1QixFQUFFLENBQUM7UUFDN0MsSUFBSSxDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUMsTUFBTSxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxFQUFFLGNBQWMsQ0FBQyxDQUFDO1FBQy9GLENBQUM7Z0JBQVMsQ0FBQztZQUNQLHdCQUF3QixDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3pDLENBQUM7SUFDTCxDQUFDO0lBRUQsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFNBQWlCLEVBQUUsY0FBdUI7UUFDN0QsTUFBTSxVQUFVLEdBQUcsdUJBQXVCLEVBQUUsQ0FBQztRQUM3QyxJQUFJLENBQUM7WUFDRCxPQUFPLE1BQU0sQ0FBQyxNQUFNLGdCQUFnQixDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsY0FBYyxDQUFDLENBQUM7UUFDaEcsQ0FBQztnQkFBUyxDQUFDO1lBQ1Asd0JBQXdCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekMsQ0FBQztJQUNMLENBQUM7SUFFRCxLQUFLLENBQUMsYUFBYSxDQUFDLFNBQWlCO1FBQ2pDLElBQUksd0JBQXdCO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1FBQ3hFLE1BQU0sVUFBVSxHQUFHLHVCQUF1QixFQUFFLENBQUM7UUFDN0MsSUFBSSxDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUMsTUFBTSxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDN0UsQ0FBQztnQkFBUyxDQUFDO1lBQ1Asd0JBQXdCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekMsQ0FBQztJQUNMLENBQUM7SUFFRCxLQUFLLENBQUMsY0FBYyxDQUFDLFlBQW9CO1FBQ3JDLElBQUksd0JBQXdCO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1FBQ3hFLE1BQU0sVUFBVSxHQUFHLHVCQUF1QixFQUFFLENBQUM7UUFDN0MsSUFBSSxDQUFDO1lBQ0QsT0FBTyxNQUFNLENBQUMsTUFBTSxnQkFBZ0IsQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDakYsQ0FBQztnQkFBUyxDQUFDO1lBQ1Asd0JBQXdCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekMsQ0FBQztJQUNMLENBQUM7SUFFRCxlQUFlO1FBQ1gsbUJBQW1CLGFBQW5CLG1CQUFtQix1QkFBbkIsbUJBQW1CLENBQUUsS0FBSyxFQUFFLENBQUM7SUFDakMsQ0FBQztJQUVELEtBQUssQ0FBQyxlQUFlLENBQUMsT0FBc0I7UUFDeEMsT0FBTyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDbEMsQ0FBQztJQUVELFlBQVk7UUFDUixJQUFJLFdBQVc7WUFBRSxPQUFPLGVBQWUsRUFBRSxDQUFDO1FBQzFDLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLEtBQUssRUFBRSxDQUFDO0lBQzlCLENBQUM7Q0FDSixDQUFDO0FBRUYsS0FBSyxVQUFVLGNBQWM7O0lBQ3pCLE1BQU0sUUFBUSxHQUFHLFNBQVMsQ0FBQztJQUMzQixTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ2pCLE1BQU0sR0FBRyxJQUFJLENBQUM7SUFDZCxJQUFJLFFBQVE7UUFBRSxNQUFNLFFBQVEsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUVyQyxNQUFNLGNBQWMsR0FBRyxNQUFDLE1BQU0sQ0FBQyxHQUF1QyxDQUFDLE9BQU8sbUNBQUksU0FBUyxDQUFDO0lBQzVGLE1BQU0sR0FBRyxHQUFHLElBQUksNkJBQW1CLENBQUM7UUFDaEMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSTtRQUNoQyxjQUFjO1FBQ2QsbUJBQW1CLEVBQUUsR0FBRyxFQUFFLENBQUMsZ0JBQWdCO1FBQzNDLFlBQVksRUFBRSxHQUFHLEVBQUUsQ0FBQyxXQUFXLEtBQUssSUFBSSxJQUFJLGdCQUFnQixLQUFLLElBQUksSUFBSSxtQkFBbUIsS0FBSyxJQUFJO1FBQ3JHLFFBQVEsRUFBRSxpQkFBaUI7UUFDM0IsYUFBYSxFQUFFLGtCQUFrQjtRQUNqQyxVQUFVLEVBQUUsY0FBYztRQUMxQixXQUFXLEVBQUUsR0FBRyxFQUFFLENBQUMsb0JBQW9CLEVBQUU7UUFDekMsWUFBWTtRQUNaLGFBQWE7UUFDYixpQkFBaUI7UUFDakIsY0FBYztRQUNkLGVBQWUsRUFBRSxDQUFDLE9BQU8sRUFBRSxXQUFXLEVBQUUsRUFBRSxDQUFDLGFBQWEsQ0FBQyxPQUFPLEVBQUUsV0FBVyxDQUFDO1FBQzlFLFlBQVksRUFBRSxDQUFDLFdBQVcsRUFBRSxFQUFFO1lBQzFCLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxvQkFBb0IsS0FBSyxXQUFXO2dCQUFFLE9BQU8sS0FBSyxDQUFDO1lBQzVFLGdCQUFnQixDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ3pCLE9BQU8sSUFBSSxDQUFDO1FBQ2hCLENBQUM7S0FDSixDQUFDLENBQUM7SUFDSCxNQUFNLE1BQU0sR0FBRyxJQUFJLHdCQUFlLENBQUM7UUFDL0IsV0FBVyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSTtRQUNoQyxhQUFhLEVBQUUsc0JBQVcsQ0FBQyxPQUFPO1FBQ2xDLGdCQUFnQjtRQUNoQixNQUFNLEVBQUUsQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQztLQUN6RSxDQUFDLENBQUM7SUFDSCxJQUFJLENBQUM7UUFDRCxNQUFNLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNyQixNQUFNLEdBQUcsR0FBRyxDQUFDO1FBQ2IsU0FBUyxHQUFHLE1BQU0sQ0FBQztJQUN2QixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLE1BQU0sTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM1QyxPQUFPLENBQUMsS0FBSyxDQUFDLGtDQUFrQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZHLENBQUM7QUFDTCxDQUFDO0FBRU0sS0FBSyxVQUFVLElBQUk7SUFDdEIsTUFBTSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUM7SUFDekIsSUFBSSxDQUFDO1FBQ0QsTUFBTSxTQUFTLEdBQUcsTUFBTSxJQUFBLHlDQUE4QixFQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLDhCQUFnQixDQUFDLENBQUM7UUFDOUYsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sS0FBSyxjQUFjLENBQUMsQ0FBQztRQUM5RSx3QkFBd0IsR0FBRyxNQUFNLENBQUMsTUFBTTtZQUNwQyxDQUFDLENBQUMsT0FBTyxNQUFNLENBQUMsTUFBTSw0Q0FBNEM7WUFDbEUsQ0FBQyxDQUFDLElBQUksQ0FBQztJQUNmLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2Isd0JBQXdCLEdBQUcscUJBQXFCLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ2xHLE9BQU8sQ0FBQyxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUM1QyxDQUFDO0lBQ0QsTUFBTSxjQUFjLEVBQUUsQ0FBQztBQUMzQixDQUFDO0FBRUQsU0FBZ0IsTUFBTTtJQUNsQixJQUFJLFdBQVc7UUFBRSxXQUFXLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztJQUNsRCxjQUFjLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDdkIsZUFBZSxHQUFHLFNBQVMsQ0FBQztJQUM1QixhQUFhLENBQUMsVUFBVSxFQUFFLENBQUM7SUFDM0IsZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsS0FBSyxFQUFFLENBQUM7SUFDMUIsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLG9CQUFvQixHQUFHLElBQUksQ0FBQztJQUM1QixjQUFjLEdBQUcsSUFBSSxDQUFDO0lBQ3RCLGdCQUFnQixJQUFJLENBQUMsQ0FBQztJQUN0QixNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsS0FBSyxDQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDakMsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcbmltcG9ydCB7IHJlYWRGaWxlLCByZWFkZGlyIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcbmltcG9ydCB7XG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcbiAgICBpbmZlckFjdGlvbixcbiAgICBpbmZlckNvY29zTGF5b3V0TW9kZSxcbiAgICBpbmZlcktpbmQsXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcbiAgICBpc05hbWVkU2xpY2VHcm91cCxcbiAgICBpc1ZlY3Rvck5vZGUsXG4gICAgbmF0aXZlVGlsZWRQYWludFNvdXJjZSxcbiAgICBwbGFpbkltYWdlU291cmNlUmVmLFxuICAgIHR5cGUgVGlsZWRQYWludFNvdXJjZSxcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XG5pbXBvcnQgeyBwYXJzZURvY3VtZW50IH0gZnJvbSAnLi9maWdtYS9wYXJzZXInO1xuaW1wb3J0IHtcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcbiAgICBjb21waWxlSW1wb3J0UGxhbixcbiAgICBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24sXG4gICAgcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zLFxufSBmcm9tICcuL2ZpZ21hL2ltcG9ydC1wbGFubmVyJztcbmltcG9ydCB7IGFuYWx5emVNYXNrVGludCwgdmVyaWZ5V2hpdGVBbHBoYVBuZyB9IGZyb20gJy4vZmlnbWEvbWFzay10aW50JztcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQsIHR5cGUgU2xpY2VBbmFseXNpcyB9IGZyb20gJy4vZmlnbWEvc2xpY2luZyc7XG5pbXBvcnQgeyBwYXJzZUZpZ21hU291cmNlIH0gZnJvbSAnLi9maWdtYS91cmwnO1xuaW1wb3J0IHtcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxuICAgIGtpbmRGb3JJbXBvcnRBY3Rpb24sXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcbmltcG9ydCB7XG4gICAgU1lOQ19NQVJLRVJfU0NSSVBUX1VSTCxcbiAgICBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwLFxuICAgIGNyZWF0ZVN5bmNNYXJrZXIsXG4gICAgdHlwZSBTeW5jTWFya2VyU3BlYyxcbn0gZnJvbSAnLi9pbXBvcnRlci9zeW5jLW1hcmtlcic7XG5pbXBvcnQgeyBwbGFuU3luY01hcmtlclNjcmlwdCB9IGZyb20gJy4vaW1wb3J0ZXIvc3luYy1tYXJrZXItYXNzZXQnO1xuaW1wb3J0IHtcbiAgICBlbXB0eVN5bmNQcmV2aWV3U3VtbWFyeSxcbiAgICBwbGFuU3luY1ByZXZpZXcsXG4gICAgcmVhZFByZWZhYlN5bmNNYXJrZXJzLFxuICAgIHR5cGUgU3luY1ByZXZpZXdSZXN1bHQsXG59IGZyb20gJy4vaW1wb3J0ZXIvc3luYy1wcmV2aWV3JztcbmltcG9ydCB7XG4gICAgQXNzZXRXcml0ZXIsXG4gICAgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMsXG4gICAgZGV0ZWN0SW1hZ2VFeHRlbnNpb24sXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcbiAgICBzYW5pdGl6ZUFzc2V0TmFtZSxcbiAgICB0eXBlIFJhc3RlckltYWdlRXh0ZW5zaW9uLFxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XG5pbXBvcnQgeyBMb2NhbEFzc2V0Q2FjaGUsIHR5cGUgQ2FjaGVFbnRyeUtleSB9IGZyb20gJy4vaW1wb3J0ZXIvY2FjaGUnO1xuaW1wb3J0IHR5cGUgeyBGb250QXNzZXRPcHRpb24gfSBmcm9tICcuL2ltcG9ydGVyL2ZvbnRzJztcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xuaW1wb3J0IHsgZ3JhZGllbnRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3N2Zyc7XG5pbXBvcnQgeyB3cml0ZVNsaWNlZFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc2xpY2VkLXBuZyc7XG5pbXBvcnQgeyBoaWRkZW5MYXllcklkcyB9IGZyb20gJy4vaW1wb3J0LXZpc2liaWxpdHknO1xuaW1wb3J0IHsgaXNQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3Jhc3Rlci1mb3JtYXQnO1xuaW1wb3J0IHsgcGl4ZWxTaXplZFRpbGVBc3NldCwgcmFzdGVyaXplVGlsZSwgdGlsZWRSYXN0ZXJLZXkgfSBmcm9tICcuL2ltcG9ydGVyL3RpbGVkLXBuZyc7XG5pbXBvcnQgeyByYXN0ZXJpemVJbWFnZUZpbGwgfSBmcm9tICcuL2ltcG9ydGVyL2ltYWdlLWZpbGwnO1xuaW1wb3J0IHtcbiAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMsXG4gICAgY3JlYXRlTWluaW1hbFByZWZhYkpzb24sXG4gICAgY3JlYXRlUHJlZmFiU3luY1JlY29yZCxcbiAgICBjb2xsZWN0UHJlZmFiQ29tcG9uZW50RmlsZUlkcyxcbiAgICBmaWdtYUZyYW1lU291cmNlSGFzaCxcbiAgICBtZXJnZVByZWZhYlN5bmNSZWNvcmQsXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxuICAgIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQsXG4gICAgcmVhZFByZWZhYlN5bmNSZWNvcmQsXG4gICAgcmV0YWluUHJlZmFiU3luY0VudHJpZXMsXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXG4gICAgcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMsXG4gICAgdHlwZSBQcmVmYWJTeW5jUmVjb3JkLFxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcbmltcG9ydCB7IFRva2VuVmF1bHQgfSBmcm9tICcuL3NlY3VyaXR5L3Rva2VuLXZhdWx0JztcbmltcG9ydCB7IEZpZ21hSW1wb3J0ZXJNY3BBcGksIHR5cGUgTWNwTm9kZU5hbWVQYXRjaCB9IGZyb20gJy4vbWNwLWFwaSc7XG5pbXBvcnQgeyBNY3BCcmlkZ2VTZXJ2ZXIgfSBmcm9tICcuL21jcC1icmlkZ2Uvc2VydmVyJztcbmltcG9ydCB7IFJvdW5kdHJpcFNlcnZpY2UgfSBmcm9tICcuL3JvdW5kdHJpcC9zZXJ2aWNlJztcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcbmltcG9ydCB7IGVkaXRvclJlaW1wb3J0ZXIgfSBmcm9tICcuL3JvdW5kdHJpcC90cmFuc2FjdGlvbic7XG5pbXBvcnQge1xuICAgIERFRkFVTFRfU0VUVElOR1MsXG4gICAgdHlwZSBEb2N1bWVudFNlc3Npb24sXG4gICAgdHlwZSBGaWdtYU5vZGUsXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXG4gICAgdHlwZSBJbXBvcnREZWNpc2lvbixcbiAgICB0eXBlIEltcG9ydE92ZXJyaWRlLFxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcbiAgICB0eXBlIEltcG9ydFNldHRpbmdzLFxuICAgIHR5cGUgTm9kZUtpbmQsXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcbiAgICB0eXBlIFByZWZhYkVkaXRpbmdTdGF0ZSxcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NhcHR1cmUsXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxuICAgIHR5cGUgUHJvZ3Jlc3NFdmVudCxcbiAgICB0eXBlIFJlY3QsXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxuICAgIHR5cGUgU3ByaXRlQXNzZXRTcGVjLFxuICAgIHR5cGUgVHJlZU5vZGVEdG8sXG59IGZyb20gJy4vdHlwZXMnO1xuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcbmltcG9ydCB7IEltcG9ydFJldmlld1JlY29yZGVyLCBJbXBvcnRSZXZpZXdTZXJ2aWNlIH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3JztcbmltcG9ydCB7IGZpbmFsaXplSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3LWZpbmFsaXplJztcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3LCBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XG5pbXBvcnQgeyBhc3NlcnRCYXRjaFRhcmdldHMsIGNvbGxlY3RTZWN0aW9uRnJhbWVzLCBmcmFtZURvY3VtZW50IH0gZnJvbSAnLi9iYXRjaC1pbXBvcnQnO1xuaW1wb3J0IHR5cGUge1xuICAgIEJhdGNoRG9jdW1lbnREdG8sIEJhdGNoRnJhbWVJdGVtLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQsIEJhdGNoSW1wb3J0UmVxdWVzdCxcbiAgICBCYXRjaEltcG9ydFJlc3VsdCwgQmF0Y2hQcm9ncmVzcywgQmF0Y2hTb3VyY2VSZXN1bHQsIEJhdGNoU3RhdGUsXG59IGZyb20gJy4vYmF0Y2gtdHlwZXMnO1xuXG5jb25zdCB2YXVsdCA9IG5ldyBUb2tlblZhdWx0KHBhY2thZ2VKU09OLm5hbWUpO1xuY29uc3QgaW1wb3J0UmV2aWV3cyA9IG5ldyBJbXBvcnRSZXZpZXdTZXJ2aWNlKCk7XG5sZXQgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTtcbmxldCBhY3RpdmVEb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIHwgbnVsbCA9IG51bGw7XG5sZXQgYWN0aXZlQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG5sZXQgYWN0aXZlT3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xubGV0IHJvdW5kdHJpcENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xubGV0IHNldHRpbmdzQ2FjaGU6IEltcG9ydFNldHRpbmdzIHwgbnVsbCA9IG51bGw7XG5sZXQgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmxldCBkb2N1bWVudFJldmlzaW9uID0gMDtcbmxldCBtY3BCcmlkZ2U6IE1jcEJyaWRnZVNlcnZlciB8IG51bGwgPSBudWxsO1xubGV0IG1jcEFwaTogRmlnbWFJbXBvcnRlck1jcEFwaSB8IG51bGwgPSBudWxsO1xuY29uc3QgcGx1Z2luSW5zdGFuY2VJZCA9IHJhbmRvbUJ5dGVzKDE4KS50b1N0cmluZygnYmFzZTY0dXJsJyk7XG5sZXQgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xubGV0IHNldHRpbmdzV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuY29uc3QgTUFYX0JBVENIX0lURU1TID0gMTAwO1xuY29uc3QgYmF0Y2hEb2N1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgeyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PigpO1xuaW50ZXJmYWNlIEJhdGNoUnVuIHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGl0ZW1zOiBCYXRjaEltcG9ydEl0ZW1SZXN1bHRbXTtcbiAgICBpbmRleDogbnVtYmVyO1xuICAgIHN0b3BSZXF1ZXN0ZWQ6IGJvb2xlYW47XG59XG5sZXQgYWN0aXZlQmF0Y2g6IEJhdGNoUnVuIHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdEJhdGNoUmVzdWx0OiBCYXRjaEltcG9ydFJlc3VsdCB8IHVuZGVmaW5lZDtcblxudHlwZSBEZWNpc2lvbiA9IEltcG9ydERlY2lzaW9uO1xuXG5pbnRlcmZhY2UgVGlsZWRBc3NldFJlcXVlc3Qge1xuICAgIG5vZGU6IEZpZ21hTm9kZTtcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XG59XG5cbmludGVyZmFjZSBSYXdJbWFnZUFzc2V0UmVxdWVzdCB7XG4gICAgbm9kZTogRmlnbWFOb2RlO1xuICAgIGltYWdlUmVmOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xuICAgIHJldmlld0lkPzogc3RyaW5nO1xuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XG4gICAgZmlsZUtleTogc3RyaW5nO1xuICAgIHJvb3ROYW1lOiBzdHJpbmc7XG4gICAgcm9vdEZyYW1lOiBSZWN0O1xuICAgIHNjYWxlOiBudW1iZXI7XG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcbiAgICAvKiog5pyq5Yu+6YCJ6IqC54K55ZyoIFByZWZhYiDkuK3lt7LmnInnmoQgZmlsZUlk77yb5riF55CG5pen6IqC54K55pe25b+F6aG75L+d55WZ44CCICovXG4gICAgcmV0YWluTm9kZUZpbGVJZHM/OiBzdHJpbmdbXTtcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xufVxuXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xuICAgIHJldmlld0JlZm9yZT86IFJldmlld1NjZW5lO1xuICAgIHJldmlld0FmdGVyPzogUmV2aWV3U2NlbmU7XG4gICAgcmV2aWV3PzogSW1wb3J0UmV2aWV3O1xuICAgIHJvb3RVdWlkOiBzdHJpbmc7XG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICBjcmVhdGVkOiBudW1iZXI7XG4gICAgdXBkYXRlZDogbnVtYmVyO1xuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xuICAgIHByZWZhYlVybD86IHN0cmluZztcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcbiAgICAvKiog5qCH6K6w57uE5Lu26ISa5pys5bCa5pyq57yW6K+R5a6M5oiQ5pe255qE6ZmN57qn6K+05piO77yb5a+85YWl5pys6Lqr57un57ut5oiQ5Yqf44CCICovXG4gICAgc3luY01hcmtlcldhcm5pbmc/OiBzdHJpbmc7XG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcbn1cblxuaW50ZXJmYWNlIEFzc2V0QnVpbGRSZXN1bHQge1xuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPjtcbiAgICB3YXJuaW5nczogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBQcmVmYWJBc3NldEluZm8ge1xuICAgIHV1aWQ6IHN0cmluZztcbiAgICB1cmw6IHN0cmluZztcbiAgICBpbXBvcnRlcjogc3RyaW5nO1xuICAgIHR5cGU6IHN0cmluZztcbiAgICBpbXBvcnRlZDogYm9vbGVhbjtcbiAgICBpbnZhbGlkOiBib29sZWFuO1xuICAgIGlzRGlyZWN0b3J5PzogYm9vbGVhbjtcbiAgICByZWFkb25seT86IGJvb2xlYW47XG4gICAgcmVkaXJlY3Q/OiB1bmtub3duO1xufVxuXG5jb25zdCBGT05UX0VYVEVOU0lPTlMgPSBuZXcgU2V0KFsnLnR0ZicsICcub3RmJywgJy5mbnQnLCAnLndvZmYnLCAnLndvZmYyJ10pO1xuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcbiAgICAnYXV0bycsXG4gICAgJ25vZGUnLFxuICAgICdzcHJpdGUnLFxuICAgICdsYWJlbCcsXG4gICAgJ3JpY2hUZXh0JyxcbiAgICAnYnV0dG9uJyxcbiAgICAnc2Nyb2xsVmlldycsXG4gICAgJ2xheW91dCcsXG5dKTtcblxuYXN5bmMgZnVuY3Rpb24gbGlzdEZvbnRBc3NldHMoKTogUHJvbWlzZTxGb250QXNzZXRPcHRpb25bXT4ge1xuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcbiAgICBjb25zdCBmb250czogRm9udEFzc2V0T3B0aW9uW10gPSBbXTtcbiAgICBhc3luYyBmdW5jdGlvbiB2aXNpdChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgICAgICBsZXQgZW50cmllcztcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKGZvbGRlciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnbm9kZV9tb2R1bGVzJyB8fCBlbnRyeS5uYW1lID09PSAnbGlicmFyeScgfHwgZW50cnkubmFtZSA9PT0gJ3RlbXAnKSB7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZm9sZGVyLCBlbnRyeS5uYW1lKTtcbiAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdmlzaXQoZmlsZVBhdGgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFGT05UX0VYVEVOU0lPTlMuaGFzKGV4dG5hbWUoZW50cnkubmFtZSkudG9Mb3dlckNhc2UoKSkpIHtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBmaWxlUGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xuICAgICAgICAgICAgZm9udHMucHVzaCh7XG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoZW50cnkubmFtZSwgZXh0bmFtZShlbnRyeS5uYW1lKSksXG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtwYXRofWAsXG4gICAgICAgICAgICAgICAgcmVsYXRpdmVQYXRoOiBwYXRoLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgdmlzaXQoYXNzZXRzUm9vdCk7XG4gICAgcmV0dXJuIGZvbnRzLnNvcnQoKGEsIGIpID0+IGEucmVsYXRpdmVQYXRoLmxvY2FsZUNvbXBhcmUoYi5yZWxhdGl2ZVBhdGgsICd6aC1DTicpKTtcbn1cblxuZnVuY3Rpb24gZW1pdFByb2dyZXNzKHByb2dyZXNzOiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XG4gICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAncHJvZ3Jlc3MnLCB7XG4gICAgICAgIC4uLnByb2dyZXNzLFxuICAgICAgICAuLi4oYWN0aXZlQmF0Y2ggJiYgIXByb2dyZXNzLmJhdGNoID8geyBiYXRjaDogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCkgfSA6IHt9KSxcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gYmF0Y2hQcm9ncmVzcyhydW46IEJhdGNoUnVuKTogQmF0Y2hQcm9ncmVzcyB7XG4gICAgY29uc3QgY3VycmVudCA9IHJ1bi5pdGVtc1tNYXRoLm1pbihydW4uaW5kZXgsIHJ1bi5pdGVtcy5sZW5ndGggLSAxKV07XG4gICAgcmV0dXJuIHtcbiAgICAgICAgYmF0Y2hJZDogcnVuLmlkLCBpdGVtSWQ6IGN1cnJlbnQ/LmlkID8/ICcnLCBuYW1lOiBjdXJyZW50Py5uYW1lID8/ICcnLFxuICAgICAgICBpbmRleDogTWF0aC5taW4ocnVuLmluZGV4ICsgMSwgcnVuLml0ZW1zLmxlbmd0aCksIHRvdGFsOiBydW4uaXRlbXMubGVuZ3RoLFxuICAgICAgICBjb21wbGV0ZWQ6IHJ1bi5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXG4gICAgICAgIHN0b3BSZXF1ZXN0ZWQ6IHJ1bi5zdG9wUmVxdWVzdGVkLFxuICAgICAgICBpdGVtczogcnVuLml0ZW1zLm1hcCgoaXRlbSkgPT4gKHsgLi4uaXRlbSB9KSksXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdENhY2hlRm9sZGVyKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4oRWRpdG9yLlByb2plY3QudG1wRGlyLCBwYWNrYWdlSlNPTi5uYW1lLCAnYXNzZXQtY2FjaGUnKTtcbn1cblxuZnVuY3Rpb24gc2FmZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogSW1wb3J0U2V0dGluZ3Mge1xuICAgIGNvbnN0IGlucHV0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0J1xuICAgICAgICA/IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+XG4gICAgICAgIDoge307XG4gICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgaW5wdXQuc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpbnB1dC5zY2FsZSlcbiAgICAgICAgPyBNYXRoLm1heCgwLjI1LCBNYXRoLm1pbig0LCBpbnB1dC5zY2FsZSkpXG4gICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5zY2FsZTtcbiAgICBjb25zdCBmb250TWFwID0gaW5wdXQuZm9udE1hcCAmJiB0eXBlb2YgaW5wdXQuZm9udE1hcCA9PT0gJ29iamVjdCdcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoaW5wdXQuZm9udE1hcClcbiAgICAgICAgICAgIC5maWx0ZXIoKFtrZXksIGl0ZW1dKSA9PiBrZXkudHJpbSgpICYmIHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGl0ZW1dKSA9PiBba2V5LnRyaW0oKSwgaXRlbS50cmltKCldKSlcbiAgICAgICAgOiB7fTtcbiAgICBjb25zdCByYXdMb2NhbEZvbGRlcnMgPSBBcnJheS5pc0FycmF5KGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzKVxuICAgICAgICA/IGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzXG4gICAgICAgIDogdHlwZW9mIGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXIgPT09ICdzdHJpbmcnXG4gICAgICAgICAgICA/IFtpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyXVxuICAgICAgICAgICAgOiBbXTtcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHJhd0xvY2FsRm9sZGVyc1xuICAgICAgICAuZmlsdGVyKChmb2xkZXIpOiBmb2xkZXIgaXMgc3RyaW5nID0+IHR5cGVvZiBmb2xkZXIgPT09ICdzdHJpbmcnKVxuICAgICAgICAubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyLCBpbmRleCwgZm9sZGVycykgPT4gZm9sZGVycy5pbmRleE9mKGZvbGRlcikgPT09IGluZGV4KVxuICAgICAgICAuc2xpY2UoMCwgMyk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc291cmNlVXJsOiB0eXBlb2YgaW5wdXQuc291cmNlVXJsID09PSAnc3RyaW5nJyA/IGlucHV0LnNvdXJjZVVybC50cmltKCkgOiAnJyxcbiAgICAgICAgYXNzZXRGb2xkZXI6IHR5cGVvZiBpbnB1dC5hc3NldEZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXG4gICAgICAgICAgICA/IGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLmFzc2V0Rm9sZGVyLFxuICAgICAgICBwcmVmYWJGb2xkZXI6IHR5cGVvZiBpbnB1dC5wcmVmYWJGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LnByZWZhYkZvbGRlci50cmltKClcbiAgICAgICAgICAgID8gaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnByZWZhYkZvbGRlcixcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnMsXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGxvY2FsUmVzb3VyY2VGb2xkZXJzWzBdID8/ICcnLFxuICAgICAgICBzY2FsZSxcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGlucHV0LnVwZGF0ZUV4aXN0aW5nICE9PSBmYWxzZSxcbiAgICAgICAgcmVmcmVzaEFzc2V0czogaW5wdXQucmVmcmVzaEFzc2V0cyA9PT0gdHJ1ZSxcbiAgICAgICAgaW1wb3J0SGlkZGVuTGF5ZXJzOiBpbnB1dC5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlLFxuICAgICAgICBhdXRvU2F2ZTogaW5wdXQuYXV0b1NhdmUgPT09IHRydWUsXG4gICAgICAgIGZvbnRNYXAsXG4gICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XG4gICAgaWYgKHNldHRpbmdzQ2FjaGUpIHtcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XG4gICAgfVxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCAncHJvamVjdCcpO1xuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XG4gICAgYXdhaXQgc2V0dGluZ3NXcml0ZVF1ZXVlO1xuICAgIHJldHVybiBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XG59XG5cbmZ1bmN0aW9uIHdpdGhTZXR0aW5nc1dyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcbiAgICBjb25zdCByZXN1bHQgPSBzZXR0aW5nc1dyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xuICAgIHNldHRpbmdzV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcbiAgICByZXR1cm4gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgbmV4dCA9IHNhZmVTZXR0aW5ncyh2YWx1ZSk7XG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgbmV4dCwgJ3Byb2plY3QnKTtcbiAgICAgICAgc2V0dGluZ3NDYWNoZSA9IG5leHQ7XG4gICAgICAgIHJldHVybiBuZXh0O1xuICAgIH0pKCk7XG59XG5cbmZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKCgpID0+IHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlKSk7XG59XG5cbmZ1bmN0aW9uIHBhdGNoU2V0dGluZ3ModmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xuICAgICAgICByZXR1cm4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQoeyAuLi5jdXJyZW50LCAuLi52YWx1ZSB9KTtcbiAgICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY2xpZW50KHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQgPSBhY3RpdmVDb250cm9sbGVyPy5zaWduYWwpOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB7XG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XG4gICAgcmV0dXJuIG5ldyBSb3VuZHRyaXBTZXJ2aWNlKHtcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcbiAgICAgICAgcHJvamVjdFJvb3Q6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyIHx8IGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+WvvOWFpeaIlue7k+aenOiwg+aVtOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOWQjuWGjeaTjeS9nCBSb3VuZC10cmlw44CCJyk7XG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xuICAgIHJldHVybiBjb250cm9sbGVyO1xufVxuXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xufVxuXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbihvd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBBYm9ydENvbnRyb2xsZXIge1xuICAgIGlmIChhcHBseWluZ0ltcG9ydFJldmlldykgdGhyb3cgbmV3IEVycm9yKCfmraPlnKjnoa7orqTlr7zlhaXlkI7nmoTotYTmupDosIPmlbTvvIzor7fnqI3lgJnjgIInKTtcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCdSb3VuZC10cmlwIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xuICAgIGlmIChhY3RpdmVCYXRjaCAmJiBvd25lciAhPT0gYWN0aXZlQmF0Y2guaWQpIHRocm93IG5ldyBFcnJvcign5om56YeP5a+85YWl5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YGc5q2i5ZCO57ut5Lu75Yqh44CCJyk7XG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnIkgRmlnbWEg5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YWI5Y+W5raI44CCJyk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgYWN0aXZlQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBvd25lcjtcbiAgICByZXR1cm4gY29udHJvbGxlcjtcbn1cblxuZnVuY3Rpb24gZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xuICAgIGlmIChhY3RpdmVDb250cm9sbGVyID09PSBjb250cm9sbGVyKSB7XG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xuICAgICAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XG4gICAgfVxufVxuXG5mdW5jdGlvbiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKHNlbGVjdGVkUGF0aCk7XG4gICAgY29uc3QgZm9sZGVyID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xuICAgIGlmICghZm9sZGVyIHx8IGZvbGRlciA9PT0gJy4nIHx8IGZvbGRlci5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUoZm9sZGVyKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOi+k+WHuuebruW9leW/hemhu+aYr+mhueebriBhc3NldHMg5LiL55qE5a2Q5paH5Lu25aS544CCJyk7XG4gICAgfVxuICAgIHJldHVybiBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xufVxuXG5mdW5jdGlvbiBhc3NldERhdGFiYXNlVXJsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKGZpbGVQYXRoKTtcbiAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xuICAgIGNvbnN0IG91dHNpZGUgPSBwYXRoID09PSAnLi4nXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi4vJylcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLlxcXFwnKVxuICAgICAgICB8fCBpc0Fic29sdXRlKHBhdGgpO1xuICAgIGlmICghcGF0aCB8fCBwYXRoID09PSAnLicgfHwgb3V0c2lkZSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3BhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpfWA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XG4gICAgZm9sZGVyOiBzdHJpbmc7XG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XG59IHwgbnVsbD4ge1xuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXG4gICAgICAgIDogJyc7XG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcbiAgICAgICAgOiBhc3NldHNSb290O1xuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcbiAgICAgICAgdGl0bGU6ICfpgInmi6kgRmlnbWEg5a+85YWl6LWE5rqQ55uu5b2VJyxcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxuICAgIH0pO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcbiAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcbiAgICBmb2xkZXI6IHN0cmluZztcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcbn0gfCBudWxsPiB7XG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcbiAgICAgICAgOiAnJztcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xuICAgICAgICB0aXRsZTogJ+mAieaLqemihOWItuS9k+i+k+WHuuebruW9lScsXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcbiAgICB9KTtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXG4gICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93biwgX2luZGV4ID0gMCk6IFByb21pc2U8e1xuICAgIGZvbGRlcjogc3RyaW5nO1xufSB8IG51bGw+IHtcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnID8gY3VycmVudC50cmltKCkgOiAnJztcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgaXNBYnNvbHV0ZShjdXJyZW50Rm9sZGVyKVxuICAgICAgICA/IGN1cnJlbnRGb2xkZXJcbiAgICAgICAgOiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XG4gICAgICAgIHRpdGxlOiAn6YCJ5oup5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VJyxcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxuICAgIH0pO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgbGlicmFyeSA9IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShzZWxlY3RlZCk7XG4gICAgcmV0dXJuIHsgZm9sZGVyOiBsaWJyYXJ5LnJvb3QgfTtcbn1cblxuZnVuY3Rpb24gdW5pb25GcmFtZShub2RlczogRmlnbWFOb2RlW10pOiBSZWN0IHtcbiAgICBjb25zdCBmcmFtZXMgPSBub2Rlcy5tYXAobm9kZUZyYW1lKS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgUmVjdCA9PiBCb29sZWFuKHZhbHVlKSk7XG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcbiAgICB9XG4gICAgY29uc3QgeCA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54KSk7XG4gICAgY29uc3QgeSA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55KSk7XG4gICAgY29uc3QgcmlnaHQgPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoKSk7XG4gICAgY29uc3QgYm90dG9tID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQpKTtcbiAgICByZXR1cm4geyB4LCB5LCB3aWR0aDogcmlnaHQgLSB4LCBoZWlnaHQ6IGJvdHRvbSAtIHkgfTtcbn1cblxuZnVuY3Rpb24gbm9kZUZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3Qge1xuICAgIGlmIChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcbiAgICAgICAgcmV0dXJuIG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcbiAgICB9XG4gICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiB1bmlvbkZyYW1lKG5vZGUuY2hpbGRyZW4pO1xuICAgIH1cbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XG59XG5cbmNvbnN0IFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OID0gMC41O1xuXG4vKipcbiAqIE9ubHkgZXhwYW5kIHJhc3RlcnMgd2hvc2UgdmlzaWJsZSBwaXhlbHMgZXNjYXBlIHRoZSBnZW9tZXRyaWMgZnJhbWUuIEFcbiAqIHJlbmRlciBmcmFtZSBjb250YWluZWQgaW5zaWRlIHRoZSBnZW9tZXRyeSBvZnRlbiByZXByZXNlbnRzIGludGVudGlvbmFsXG4gKiB0cmFuc3BhcmVudCBwYWRkaW5nIGFuZCBtdXN0IGtlZXAgdGhlIGxlZ2FjeSBmaXhlZC1jYW52YXMgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgZ2VvbWV0cnkgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XG4gICAgY29uc3QgcmVuZGVyID0gbm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcztcbiAgICBpZiAoIWdlb21ldHJ5IHx8ICFyZW5kZXIgfHwgcmVuZGVyLndpZHRoIDw9IDAgfHwgcmVuZGVyLmhlaWdodCA8PSAwKSB7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGNvbnN0IGdlb21ldHJ5UmlnaHQgPSBnZW9tZXRyeS54ICsgZ2VvbWV0cnkud2lkdGg7XG4gICAgY29uc3QgZ2VvbWV0cnlCb3R0b20gPSBnZW9tZXRyeS55ICsgZ2VvbWV0cnkuaGVpZ2h0O1xuICAgIGNvbnN0IHJlbmRlclJpZ2h0ID0gcmVuZGVyLnggKyByZW5kZXIud2lkdGg7XG4gICAgY29uc3QgcmVuZGVyQm90dG9tID0gcmVuZGVyLnkgKyByZW5kZXIuaGVpZ2h0O1xuICAgIHJldHVybiByZW5kZXIueCA8IGdlb21ldHJ5LnggLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxuICAgICAgICB8fCByZW5kZXIueSA8IGdlb21ldHJ5LnkgLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxuICAgICAgICB8fCByZW5kZXJSaWdodCA+IGdlb21ldHJ5UmlnaHQgKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxuICAgICAgICB8fCByZW5kZXJCb3R0b20gPiBnZW9tZXRyeUJvdHRvbSArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXG4gICAgICAgID8gcmVuZGVyXG4gICAgICAgIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBjb3JuZXJSYWRpaShub2RlOiBGaWdtYU5vZGUpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XG4gICAgaWYgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWk/Lmxlbmd0aCA9PT0gNCkge1xuICAgICAgICByZXR1cm4gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcbiAgICB9XG4gICAgY29uc3QgcmFkaXVzID0gbm9kZS5jb3JuZXJSYWRpdXMgPz8gMDtcbiAgICByZXR1cm4gW3JhZGl1cywgcmFkaXVzLCByYWRpdXMsIHJhZGl1c107XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBEZWNpc2lvbiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBpbmZlckFjdGlvbihub2RlKSxcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxuICAgICAgICBuaW5lU2xpY2U6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBkZWNpc2lvbkZvck5vZGUobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPik6IERlY2lzaW9uIHtcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfTtcbiAgICB9XG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH07XG4gICAgfVxuICAgIHJldHVybiBkZWNpc2lvbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lzaW9uTWFwKG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSwgdHJlZTogVHJlZU5vZGVEdG9bXSk6IE1hcDxzdHJpbmcsIERlY2lzaW9uPiB7XG4gICAgY29uc3QgZGVjaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIERlY2lzaW9uPigpO1xuICAgIGNvbnN0IGZpZ21hU2xpY2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3QgYWRkRGVmYXVsdHMgPSAobm9kZXM6IFRyZWVOb2RlRHRvW10pID0+IHtcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkgZmlnbWFTbGljZXMuYWRkKG5vZGUuaWQpO1xuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcbiAgICAgICAgICAgICAgICBraW5kOiBub2RlLmtpbmQsXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBub2RlLnBhdGNoQ2FuZGlkYXRlLFxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcbiAgICAgICAgICAgIH0sIEJvb2xlYW4obm9kZS5wYXRjaENhbmRpZGF0ZSkpKTtcbiAgICAgICAgICAgIGFkZERlZmF1bHRzKG5vZGUuY2hpbGRyZW4pO1xuICAgICAgICB9XG4gICAgfTtcbiAgICBhZGREZWZhdWx0cyh0cmVlKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XG4gICAgICAgIGRlY2lzaW9ucy5zZXQoaXRlbS5pZCwgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcbiAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcbiAgICAgICAgICAgIGtpbmQ6IE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCkgPyBpdGVtLmtpbmQgOiAnYXV0bycsXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxuICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXG4gICAgICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxuICAgICAgICB9LCBmaWdtYVNsaWNlcy5oYXMoaXRlbS5pZCkpKTtcbiAgICB9XG4gICAgcmV0dXJuIGRlY2lzaW9ucztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKFxuICAgIG5vZGU6IEZpZ21hTm9kZSxcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxuICAgIGluY2x1ZGVOb2RlTmFtZSA9IHRydWUsXG4pOiBib29sZWFuIHtcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCk7XG4gICAgcmV0dXJuIGRlY2lzaW9uPy5leHBsaWNpdCA9PT0gdHJ1ZVxuICAgICAgICB8fCAoaW5jbHVkZU5vZGVOYW1lICYmIEJvb2xlYW4oZGVjaXNpb24/Lm5hbWUpKVxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShjaGlsZCwgZGVjaXNpb25zKSk7XG59XG5cbi8qKlxuICog5pys5Zyw5ZCM5ZCN57Sg5p2Q5oqK54i25a655Zmo5pW05L2T5o+Q5Y2H5Li6IFBORyDmlbTlsYLvvJror6XniLblrrnlmajnmoTlrZDlsYLkuI3lho3ljZXni6zlu7roioLngrnjgIJcbiAqIOWvvOWFpeS4jlwi5pS55Yqo6aKE5qOAXCLlhbHnlKjov5nmrrXop4TliJnvvIzpgb/lhY3pooTmo4DmiorooqvlkLjmlLbnmoTlrZDlsYLmiqXmiJBcIuaWsOWinlwi44CCXG4gKi9cbi8qKlxuICog5ZCM5q2l5qCH6K6w6YCC55So5LqO5o+S5Lu255qE5YWo6YOo5Y2V6IqC54K56ZO+5o6l77ya5Lu75oSP5qC557G75Z6L77yIRnJhbWUgLyBHcm91cCAvIENvbXBvbmVudCAvIEluc3RhbmNl4oCm77yJXG4gKiDpg73nlJ/miJAgRmlnbWFTeW5jTm9kZe+8m+aVtOS7veaWh+S7tuWvvOWFpeS4juWkmuagueadpea6kOS4jeeUn+aIkOOAglxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY01hcmtlcnNFbmFibGVkKHNvdXJjZU5vZGVJZDogc3RyaW5nIHwgdW5kZWZpbmVkLCByb290Q291bnQ6IG51bWJlcik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBCb29sZWFuKHNvdXJjZU5vZGVJZCkgJiYgcm9vdENvdW50ID09PSAxO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXBwbHlMb2NhbFBhcmVudFByb21vdGlvbihcbiAgICByb290czogcmVhZG9ubHkgRmlnbWFOb2RlW10sXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXG4gICAgbWF0Y2hlc0xvY2FsOiAobm9kZTogRmlnbWFOb2RlKSA9PiBQcm9taXNlPGJvb2xlYW4+LFxuICAgIHByb3RlY3RlZERlc2NlbmRhbnQ6IChub2RlOiBGaWdtYU5vZGUpID0+IGJvb2xlYW4sXG4gICAgaGFzQXNzZXQ6IChub2RlSWQ6IHN0cmluZykgPT4gYm9vbGVhbiA9ICgpID0+IGZhbHNlLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcHJvbW90ZSA9IGFzeW5jIChub2RlOiBGaWdtYU5vZGUpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgICAgaWYgKGhhc0Fzc2V0KG5vZGUuaWQpIHx8IGFuYWx5emVNYXNrVGludChub2RlKSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gIT09ICdnZW5lcmF0ZScpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGhcbiAgICAgICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24ubmluZVNsaWNlXG4gICAgICAgICAgICAvLyDph43lkb3lkI3kuI3mlLnlj5jotYTmupDljLnphY3vvJvlj6rmnInoh6rouqvmiJblkI7ku6PnmoTmmL7lvI/nrZbnlaXopobnm5bmiY3pmLvmraLmj5DljYfvvIxcbiAgICAgICAgICAgIC8vIOWQpuWImeiiq+WQuOaUtueahOWQjuS7o+S8mumdmem7mOa2iOWkseOAglxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpXG4gICAgICAgICAgICAvLyDlkIzlkI3npZblhYjkuI3og73miJDkuLrmirnmjonni6znq4vliIfniYfotYTmupDmiJbokpnniYjooajnpLrnmoTnkIbnlLHjgIJcbiAgICAgICAgICAgICYmICFwcm90ZWN0ZWREZXNjZW5kYW50KG5vZGUpXG4gICAgICAgICAgICAvLyDniLbotYTmupDml6Dms5Xooajovr7ni6znq4vnmoTpmpDol4/lkI7ku6PvvIzov5nnp43ovrnnlYzlv4Xpobvkv53nlZnlsYLnuqfjgIJcbiAgICAgICAgICAgICYmICFoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGUpXG4gICAgICAgICAgICAmJiBhd2FpdCBtYXRjaGVzTG9jYWwobm9kZSkpIHtcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgeyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChub2RlLmNoaWxkcmVuLm1hcChwcm9tb3RlKSk7XG4gICAgfTtcbiAgICBhd2FpdCBQcm9taXNlLmFsbChyb290cy5tYXAocHJvbW90ZSkpO1xufVxuXG50eXBlIFN0b3JlZE5vZGVPdmVycmlkZXMgPSBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4+O1xuXG5hc3luYyBmdW5jdGlvbiBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk6IFByb21pc2U8U3RvcmVkTm9kZU92ZXJyaWRlcz4ge1xuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsICdwcm9qZWN0Jyk7XG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XG59XG5cbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBpdGVtID0gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRPdmVycmlkZT47XG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xuICAgIGlmICghaWQpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgaXRlbS5raW5kID09PSAnc3RyaW5nJyAmJiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXG4gICAgICAgIDogJ2F1dG8nO1xuICAgIGNvbnN0IGV4cGxpY2l0ID0gaXRlbS5leHBsaWNpdCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcbiAgICBpZiAoIWV4cGxpY2l0ICYmICFuYW1lKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgICBpZCxcbiAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxuICAgICAgICBraW5kLFxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxuICAgICAgICBleHBsaWNpdCxcbiAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcbiAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xuICAgIGNvbnN0IHN0b3JlZCA9IChhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCkpW2ZpbGVLZXldID8/IHt9O1xuICAgIGNvbnN0IHJlc3VsdDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xuICAgICAgICBjb25zdCBzYWZlID0gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZSwgaWQpO1xuICAgICAgICBpZiAoc2FmZSkgcmVzdWx0LnB1c2goc2FmZSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gICAgY29uc3QgcmVzdWx0ID0gbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XG4gICAgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5hc3luYyBmdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKFxuICAgIGZpbGVLZXk6IHVua25vd24sXG4gICAgdmFsdWVzOiB1bmtub3duLFxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xuICAgIH1cbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xuICAgIGNvbnN0IHNhZmVJdGVtcyA9IGl0ZW1zXG4gICAgICAgIC5tYXAoKGl0ZW0pID0+IHNhZmVOb2RlT3ZlcnJpZGUoaXRlbSkpXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xuICAgIGNvbnN0IHNjb3BlSWRzID0gbmV3IFNldChcbiAgICAgICAgKEFycmF5LmlzQXJyYXkoc2NvcGVWYWx1ZXMpID8gc2NvcGVWYWx1ZXMgOiBzYWZlSXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLmlkKSlcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxuICAgICk7XG4gICAgaWYgKCFzY29wZUlkcy5zaXplKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XG4gICAgfVxuICAgIGNvbnN0IHNjb3BlZEl0ZW1zID0gc2FmZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2NvcGVJZHMuaGFzKGl0ZW0uaWQpKTtcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XG4gICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcbiAgICBmb3IgKGNvbnN0IGlkIG9mIHNjb3BlSWRzKSB7XG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHNjb3BlZEl0ZW1zKSB7XG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSB7XG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcbiAgICB9XG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcbiAgICByZXR1cm4gc2NvcGVkSXRlbXM7XG59XG5cbmZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzKFxuICAgIGZpbGVLZXk6IHVua25vd24sXG4gICAgdmFsdWVzOiB1bmtub3duLFxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soXG4gICAgICAgICgpID0+IHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoZmlsZUtleSwgdmFsdWVzLCBzY29wZVZhbHVlcyksXG4gICAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhdGNoTm9kZU5hbWVzKGZpbGVLZXk6IHN0cmluZywgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xuICAgICAgICBpZiAoIWZpbGVLZXkudHJpbSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkOiBJbXBvcnRPdmVycmlkZVtdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgcGF0Y2ggb2YgcGF0Y2hlcykge1xuICAgICAgICAgICAgY29uc3QgaWQgPSB0eXBlb2YgcGF0Y2guaWQgPT09ICdzdHJpbmcnID8gcGF0Y2guaWQudHJpbSgpIDogJyc7XG4gICAgICAgICAgICBpZiAoIWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBub2RlSWTjgIInKTtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gc2FmZU5vZGVPdmVycmlkZShjdXJyZW50W2lkXSwgaWQpO1xuICAgICAgICAgICAgY29uc3QgZmFsbGJhY2sgPSBzYWZlTm9kZU92ZXJyaWRlKHBhdGNoLmZhbGxiYWNrLCBpZCk7XG4gICAgICAgICAgICBjb25zdCBuZXh0ID0gZXhpc3RpbmcgPyB7IC4uLmV4aXN0aW5nIH0gOiBmYWxsYmFjayA/IHsgLi4uZmFsbGJhY2sgfSA6IG51bGw7XG4gICAgICAgICAgICBpZiAoIW5leHQgJiYgcGF0Y2gubmFtZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghbmV4dCkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g57y65bCR5pyJ5pWI6buY6K6k562W55Wl44CCYCk7XG4gICAgICAgICAgICBpZiAocGF0Y2gubmFtZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBuZXh0Lm5hbWU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHBhdGNoLm5hbWUpO1xuICAgICAgICAgICAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g55qE5ZCN56ew5peg5pWI44CCYCk7XG4gICAgICAgICAgICAgICAgbmV4dC5uYW1lID0gbmFtZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKG5leHQsIGlkKTtcbiAgICAgICAgICAgIGlmIChzYWZlKSB7XG4gICAgICAgICAgICAgICAgY3VycmVudFtpZF0gPSBzYWZlO1xuICAgICAgICAgICAgICAgIHBlcnNpc3RlZC5wdXNoKHNhZmUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcbiAgICAgICAgZWxzZSBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xuICAgICAgICByZXR1cm4gcGVyc2lzdGVkO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xuICAgIGNvbnN0IGRlZmF1bHRzID0gZGVjaXNpb25NYXAoW10sIHNlc3Npb24udHJlZSk7XG4gICAgc2Vzc2lvbi50cmVlID0gYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4oXG4gICAgICAgIHNlc3Npb24udHJlZSxcbiAgICAgICAgY29tcGlsZUltcG9ydFBsYW4oc2Vzc2lvbi5yb290cywgZGVmYXVsdHMpLFxuICAgICk7XG4gICAgcmV0dXJuIHNlc3Npb247XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxuICAgIHJvb3RzOiBGaWdtYU5vZGVbXSxcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcbiAgICBwcmVwYXJlZDogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKSxcbik6IHsgcG5nOiBGaWdtYU5vZGVbXTsgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W107IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXTsgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSB9IHtcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XG4gICAgY29uc3QgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W10gPSBbXTtcbiAgICBjb25zdCByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10gPSBbXTtcbiAgICBjb25zdCBncmFkaWVudHM6IEZpZ21hTm9kZVtdID0gW107XG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBhbmNlc3RvcnNWaXNpYmxlOiBib29sZWFuKSA9PiB7XG4gICAgICAgIGlmIChwcmVwYXJlZC5oYXMobm9kZS5pZCkpIHJldHVybjtcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZWx5VmlzaWJsZSA9IGFuY2VzdG9yc1Zpc2libGUgJiYgbm9kZS52aXNpYmxlICE9PSBmYWxzZSAmJiBub2RlLm9wYWNpdHkgPiAwO1xuICAgICAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlKSB7XG4gICAgICAgICAgICBwbmcucHVzaChub2RlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykge1xuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlKTtcbiAgICAgICAgICAgIGlmIChzb3VyY2UpIHtcbiAgICAgICAgICAgICAgICB0aWxlZC5wdXNoKHsgbm9kZSwgc291cmNlIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBUaGUgc2FtZSBwbGFpbiBJTUFHRSBzb3VyY2UgYW5kIGNlbnRlcmVkIGNyb3AgcGF0aCBzZXJ2ZSBib3RoXG4gICAgICAgICAgICAgICAgLy8gdmlzaWJpbGl0eSBzdGF0ZXM7IHdob2xlLW5vZGUgZXhwb3J0cyBjYW4gYmFrZSBkaWZmZXJlbnQgYWxwaGEuXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xuICAgICAgICAgICAgICAgICAgICByYXdJbWFnZXMucHVzaCh7IG5vZGUsIGltYWdlUmVmIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnZ2VuZXJhdGUnKSB7XG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XG4gICAgICAgICAgICBpZiAoZmlsbCkge1xuICAgICAgICAgICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xuICAgIH07XG4gICAgcm9vdHMuZm9yRWFjaCgocm9vdCkgPT4gdmlzaXQocm9vdCwgdHJ1ZSkpO1xuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEFzc2V0cyhcbiAgICBzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24sXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxuICAgIHJldmlldzogSW1wb3J0UmV2aWV3UmVjb3JkZXIsXG4gICAgb3B0aW9uczogeyByZWdlbmVyYXRlTm9kZUlkcz86IFJlYWRvbmx5U2V0PHN0cmluZz4gfSA9IHt9LFxuKTogUHJvbWlzZTxBc3NldEJ1aWxkUmVzdWx0PiB7XG4gICAgY29uc3QgaGlkZGVuID0gaGlkZGVuTGF5ZXJJZHMoc2Vzc2lvbi5yb290cywgaW1wb3J0U2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSk7XG4gICAgY29uc3QgYXBwbHlWaXNpYmlsaXR5ID0gKG5vZGU6IEZpZ21hTm9kZSk6IHZvaWQgPT4ge1xuICAgICAgICBpZiAoaGlkZGVuLmhhcyhub2RlLmlkKSkgZGVjaXNpb25zLnNldChub2RlLmlkLCB7XG4gICAgICAgICAgICAuLi4oZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSkpLCBhY3Rpb246ICdpZ25vcmUnLCBuaW5lU2xpY2U6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFwcGx5VmlzaWJpbGl0eSk7XG4gICAgfTtcbiAgICBzZXNzaW9uLnJvb3RzLmZvckVhY2goYXBwbHlWaXNpYmlsaXR5KTtcbiAgICBjb25zdCByZXNvbHZlZERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xuICAgIHJlc29sdmVkRGVjaXNpb25zLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IGRlY2lzaW9ucy5zZXQoa2V5LCB2YWx1ZSkpO1xuICAgIGNvbnN0IHdyaXRlU3RhdGVzID0gbmV3IE1hcDxzdHJpbmcsIGJvb2xlYW4+KCk7XG4gICAgY29uc3Qgd3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLmFzc2V0Rm9sZGVyLCBhc3luYyAodXJsLCBleGlzdGVkKSA9PiB7XG4gICAgICAgIGF3YWl0IHJldmlldy5iZWZvcmVXcml0ZSh1cmwsIGV4aXN0ZWQpO1xuICAgICAgICB3cml0ZVN0YXRlcy5zZXQodXJsLCBleGlzdGVkKTtcbiAgICB9KTtcbiAgICBhd2FpdCB3cml0ZXIuaW5pdGlhbGl6ZSgpO1xuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XG4gICAgYXdhaXQgY2FjaGUuaW5pdGlhbGl6ZSgpO1xuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VzID0gaW1wb3J0U2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XG4gICAgYXdhaXQgUHJvbWlzZS5hbGwobG9jYWxSZXNvdXJjZXMubWFwKChsaWJyYXJ5KSA9PiBsaWJyYXJ5LmluaXRpYWxpemUoKSkpO1xuICAgIC8vIEluZGV4IGV4aXN0aW5nIG5hbWVzIG9uY2U7IG5ldyByZXNvdXJjZXMgYXJlIHNoYXJlZCBieSBuYW1lIGJlbG93LlxuICAgIGNvbnN0IG91dHB1dFBhdGggPSBqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnLCB3cml0ZXIuZm9sZGVyKTtcbiAgICBjb25zdCBvdXRwdXRSZXNvdXJjZXMgPSBleGlzdHNTeW5jKG91dHB1dFBhdGgpID8gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KG91dHB1dFBhdGgpIDogbnVsbDtcbiAgICBhd2FpdCBvdXRwdXRSZXNvdXJjZXM/LmluaXRpYWxpemUoKTtcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xuICAgIC8vIFRoZSBwcm9qZWN0IGNvbnRyYWN0IGlzIHNhbWUgbmFtZSA9IHNhbWUgcmVzb3VyY2UuIFNoYXJlIGFjcm9zcyByZW5kZXIsXG4gICAgLy8gSU1BR0UgYW5kIGdyYWRpZW50IHBhdGhzIGJlZm9yZSBkb3dubG9hZGluZyBvciBjb21wYXJpbmcgYW55IHBpeGVscy5cbiAgICBjb25zdCBzaGFyZWRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xuICAgIGNvbnN0IHJlc291cmNlS2V5ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4gd3JpdGVyLmJ1aWxkVXJsKG5vZGUubmFtZSwgJycsICdwbmcnLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSlcbiAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xuICAgIGNvbnN0IHdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qgbm90ZSA9IChhY3Rpb246IE5vbk51bGxhYmxlPEltcG9ydFJldmlld1snZGVjaXNpb25zJ10+W251bWJlcl1bJ2FjdGlvbiddLCBuYW1lOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nLCB1cmw/OiBzdHJpbmcpID0+XG4gICAgICAgIHJldmlldy5ub3RlPy4oYWN0aW9uLCBuYW1lLCByZWFzb24sIHVybCk7XG4gICAgY29uc3Qgbm90ZVdyaXRlID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMpID0+IG5vdGUod3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybCkgPyAndXBkYXRlZCcgOiAnY3JlYXRlZCcsXG4gICAgICAgIGJhc2VuYW1lKGFzc2V0LnVybCksIHdyaXRlU3RhdGVzLmdldChhc3NldC51cmwpXG4gICAgICAgICAgICA/ICflhpnlhaXlkIzlkI3ovpPlh7rotYTmupDvvIzkv53nlZnljp8gVVVJRCdcbiAgICAgICAgICAgIDogJ+aMieWQjeensOWvvOWFpeS4gOS7vei1hOa6kO+8jOWQjOWQjeiKgueCueebtOaOpeWFseeUqCcsIGFzc2V0LnVybCk7XG4gICAgY29uc3Qgbm9kZVNvdXJjZUtleSA9IChub2RlOiBGaWdtYU5vZGUsIHZhcmlhbnQgPSAncmFzdGVyLXYyJykgPT5cbiAgICAgICAgSlNPTi5zdHJpbmdpZnkoW3Nlc3Npb24uZmlsZUtleSwgbm9kZS5pZCwgaW1wb3J0U2V0dGluZ3Muc2NhbGUsIHZhcmlhbnRdKTtcbiAgICBjb25zdCBncm91cFNvdXJjZUtleSA9IChhc3NldEtleTogc3RyaW5nKSA9PiBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCAndGlsZS12MicsIGFzc2V0S2V5XSk7XG4gICAgY29uc3QgaW1hZ2VEZXRhaWxzID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xuICAgICAgICBsZXQgbGVhZiA9IG5vZGUsIGlubmVyT3BhY2l0eSA9IDE7XG4gICAgICAgIHdoaWxlIChsZWFmLmNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgbGVhZiA9IGxlYWYuY2hpbGRyZW5bMF07XG4gICAgICAgICAgICBpbm5lck9wYWNpdHkgKj0gbGVhZi5vcGFjaXR5O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IGxlYWYsIGlubmVyT3BhY2l0eSB9O1xuICAgIH07XG4gICAgY29uc3QgZmluZE91dHB1dCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzICYmIG91dHB1dFJlc291cmNlcykge1xuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBvdXRwdXRSZXNvdXJjZXMuZmluZChuYW1lLCAncG5nJyk7XG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdleGlzdGluZycgYXMgY29uc3QgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9O1xuICAgIGNvbnN0IGZpbmRMb2NhbCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGluY2x1ZGVPdXRwdXQgPSB0cnVlLCBub2RlSWQ/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgLy8g57uE5Lu25ZCM5q2l77ya5Y+q5pyJ5YOP57Sg5oyH57q55Yik5a6a5Li6XCLlm77niYflt7Llj5jljJZcIueahOiKgueCueaJjei3s+i/h+acrOWcsOe0oOadkOWkjeeUqO+8m1xuICAgICAgICAvLyDmsqHlj5jljJbnmoToioLngrnnu6fnu63lvJXnlKjpobnnm67ph4znmoTlkIzlkI3ntKDmnZDvvIzkuI3nlJ/miJDph43lpI3lm77niYfjgIJcbiAgICAgICAgaWYgKG5vZGVJZCAmJiBvcHRpb25zLnJlZ2VuZXJhdGVOb2RlSWRzPy5oYXMobm9kZUlkKSkge1xuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChuYW1lLCAncG5nJyk7XG4gICAgICAgICAgICAvLyBEaXJlY3Rvcnkgb3JkZXIsIGV4dGVuc2lvbiBwcmVmZXJlbmNlIGFuZCByb290LWJlZm9yZS1zdWJmb2xkZXJcbiAgICAgICAgICAgIC8vIG9yZGVyaW5nIGFyZSB0aGUgZXhpc3RpbmcgdXNlci1kZWNsYXJlZCBuYW1lIG1hcHBpbmcgY29udHJhY3QuXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdsb2NhbCcgYXMgY29uc3QgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaW5jbHVkZU91dHB1dCA/IGZpbmRPdXRwdXQobmFtZSkgOiBudWxsO1xuICAgIH07XG4gICAgY29uc3QgcHJlcGFyZU1hc2sgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3RyYW5zZm9ybScgfHwgZGVjaXNpb24ubmluZVNsaWNlKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpO1xuICAgICAgICBpZiAoYW5hbHlzaXMgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpKSB7XG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIGtpbmQ6ICdzcHJpdGUnLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xuICAgICAgICAgICAgbGV0IHJlYXNvbiA9IGFuYWx5c2lzLnJlYXNvbjtcbiAgICAgICAgICAgIGlmIChhbmFseXNpcy5jYW5kaWRhdGUpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IG1hc2ssIHRpbnQgfSA9IGFuYWx5c2lzLmNhbmRpZGF0ZTtcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChtYXNrLm5hbWUpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKVxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShub2RlU291cmNlS2V5KG1hc2spLCB7IHRpbGVkOiBmYWxzZSB9KTtcbiAgICAgICAgICAgICAgICAvLyBWZXJpZnkgdGhlIGJ5dGVzIG9mIHRoZSByZWZlcmVuY2VkIGFzc2V0LCBuZXZlciBhbiB1bnJlbGF0ZWRcbiAgICAgICAgICAgICAgICAvLyBzYW1lLW5hbWUgZmlsZSBmcm9tIGEgcHJvamVjdC1leHRlcm5hbCBsaWJyYXJ5IGRpcmVjdG9yeS5cbiAgICAgICAgICAgICAgICBjb25zdCBieXRlcyA9IGxvY2FsVXJsICYmIGFzc2V0ID8gbWF0Y2ghLmNvbnRlbnRzXG4gICAgICAgICAgICAgICAgICAgIDogYXNzZXQgPyBhd2FpdCByZWFkRmlsZShqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGFzc2V0LnVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpKSA6IG51bGw7XG4gICAgICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBieXRlcyA/IHZlcmlmeVdoaXRlQWxwaGFQbmcoYnl0ZXMpIDogeyB2YWxpZDogZmFsc2UsIHJlYXNvbjogJ+ayoeacieWPr+mqjOivgeeahOacrOWcsOeZveiJsuW6leWbvicgfTtcbiAgICAgICAgICAgICAgICByZWFzb24gPSB2ZXJpZmllZC5yZWFzb247XG4gICAgICAgICAgICAgICAgaWYgKGFzc2V0ICYmIHZlcmlmaWVkLnZhbGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHRpbnRlZCA9IHsgLi4uYXNzZXQsIHRpbnQgfTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCB0aW50ZWQpO1xuICAgICAgICAgICAgICAgICAgICByZXZpZXcuYmluZChub2RlLCB0aW50ZWQsIG1hdGNoPy5zb3VyY2UgPz8gJ2V4aXN0aW5nJyk7XG4gICAgICAgICAgICAgICAgICAgIG5vdGUoJ3RpbnRlZCcsIG5vZGUubmFtZSwgYCR7YW5hbHlzaXMucmVhc29ufe+8myR7dmVyaWZpZWQucmVhc29ufe+8m+ayv+eUqOWOnyBVVUlEIOS4juS5neWuq+WPguaVsO+8jOmAj+aYjuW6puS7heiuoeeul+S4gOasoWAsIGFzc2V0LnVybCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgYCR7cmVhc29ufe+8m+S9v+eUqCBGaWdtYSDlrozmlbTokpnniYjlkIjmiJDvvIzkuI3kv67mlLnlhbHkuqvlupXlm75gKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykgcmV0dXJuO1xuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIGF3YWl0IHByZXBhcmVNYXNrKGNoaWxkKTtcbiAgICB9O1xuICAgIGZvciAoY29uc3Qgcm9vdCBvZiBzZXNzaW9uLnJvb3RzKSBhd2FpdCBwcmVwYXJlTWFzayhyb290KTtcbiAgICBjb25zdCBwcm90ZWN0ZWREZXNjZW5kYW50ID0gKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4gPT4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4ge1xuICAgICAgICBjb25zdCBjaGlsZERlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKGNoaWxkLCBkZWNpc2lvbnMpO1xuICAgICAgICBpZiAoY2hpbGREZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHJldHVybiBCb29sZWFuKGNoaWxkLmlzTWFzayB8fCBjaGlsZC5jaGlsZHJlbi5zb21lKChwYXJ0KSA9PiBwYXJ0LmlzTWFzaylcbiAgICAgICAgICAgIHx8IGFzc2V0cy5oYXMoY2hpbGQuaWQpIHx8IGNoaWxkRGVjaXNpb24ubmluZVNsaWNlIHx8IGlzTmFtZWRTbGljZUdyb3VwKGNoaWxkKSB8fCBpc1BhdGNoQ2FuZGlkYXRlKGNoaWxkKSlcbiAgICAgICAgICAgIHx8IChjaGlsZERlY2lzaW9uLmFjdGlvbiAhPT0gJ3JlbmRlcicgJiYgcHJvdGVjdGVkRGVzY2VuZGFudChjaGlsZCkpO1xuICAgIH0pO1xuICAgIGF3YWl0IGFwcGx5TG9jYWxQYXJlbnRQcm9tb3Rpb24oXG4gICAgICAgIHNlc3Npb24ucm9vdHMsXG4gICAgICAgIGRlY2lzaW9ucyxcbiAgICAgICAgYXN5bmMgKG5vZGUpID0+IEJvb2xlYW4oYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UsIG5vZGUuaWQpKSxcbiAgICAgICAgcHJvdGVjdGVkRGVzY2VuZGFudCxcbiAgICAgICAgKG5vZGVJZCkgPT4gYXNzZXRzLmhhcyhub2RlSWQpLFxuICAgICk7XG4gICAgY29uc3QgZmluYWxEZWNpc2lvbnMgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcbiAgICBkZWNpc2lvbnMuY2xlYXIoKTtcbiAgICBmaW5hbERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcbiAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XG4gICAgY29uc3QgYWN0aXZlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3QgYWN0aXZlQm91bmRhcnkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm47XG4gICAgICAgIGFjdGl2ZUlkcy5hZGQobm9kZS5pZCk7XG4gICAgICAgIGlmIChpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbikgfHwgZGVjaXNpb24ubmluZVNsaWNlIHx8IGFzc2V0cy5oYXMobm9kZS5pZCkpIHJldHVybjtcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFjdGl2ZUJvdW5kYXJ5KTtcbiAgICB9O1xuICAgIHNlc3Npb24ucm9vdHMuZm9yRWFjaChhY3RpdmVCb3VuZGFyeSk7XG4gICAgZm9yIChjb25zdCBbaWQsIHBsYW5dIG9mIHBsYW5zKSB7XG4gICAgICAgIGlmICghYWN0aXZlSWRzLmhhcyhpZCkpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBub2RlID0gc2Vzc2lvbi5ub2RlQnlJZD8uZ2V0KGlkKTtcbiAgICAgICAgaWYgKHBsYW4ucmVhc29uID09PSAncHJlZml4LW1lcmdlJykgbm90ZSgnbWVyZ2VkJywgbm9kZT8ubmFtZSA/PyBpZCxcbiAgICAgICAgICAgIHBsYW4ud2FybmluZyA/PyAnaWNvbl8vaW1nXyDmnIDlpJblsYLotYTmupDovrnnlYzvvIzmjInlvZPliY3mmL7pmpDlkIjmiJDvvIzkv53nlZnniLboioLngrnlh6DkvZXkuI7pgI/mmI7luqYnKTtcbiAgICAgICAgZWxzZSBpZiAocGxhbi53YXJuaW5nKSB7XG4gICAgICAgICAgICB3YXJuaW5ncy5hZGQoYCR7bm9kZT8ubmFtZSA/PyBpZH3vvJoke3BsYW4ud2FybmluZ31gKTtcbiAgICAgICAgICAgIG5vdGUoJ2ZhbGxiYWNrJywgbm9kZT8ubmFtZSA/PyBpZCwgcGxhbi53YXJuaW5nKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0cyA9IGNvbGxlY3RBc3NldFJlcXVlc3RzKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucywgbmV3IFNldChhc3NldHMua2V5cygpKSk7XG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoXG4gICAgICAgICsgcmVxdWVzdHMucmF3SW1hZ2VzLmxlbmd0aCArIHJlcXVlc3RzLmdyYWRpZW50cy5sZW5ndGg7XG4gICAgbGV0IGNvbXBsZXRlZCA9IDA7XG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XG5cbiAgICBjb25zdCBnZXRBcGkgPSAoKSA9PiB7XG4gICAgICAgIGFwaVByb21pc2UgPz89IGRpYWdub3N0aWNUYXNrKCflh4blpIcgRmlnbWEg5a6i5oi356uvJywgdW5kZWZpbmVkLCAoKSA9PiBjbGllbnQoKSk7XG4gICAgICAgIHJldHVybiBhcGlQcm9taXNlO1xuICAgIH07XG5cbiAgICBjb25zdCBjb21wbGV0ZUFzc2V0ID0gKFxuICAgICAgICBub2RlOiBGaWdtYU5vZGUsXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXG4gICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyB8ICdnZW5lcmF0ZWQnID0gJ2ZpZ21hJyxcbiAgICApID0+IHtcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XG4gICAgICAgIHJldmlldy5iaW5kKG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xuICAgICAgICBpZiAoc291cmNlID09PSAnbG9jYWwnIHx8IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJykgbm90ZSgncmV1c2VkJywgbm9kZS5uYW1lLFxuICAgICAgICAgICAgc291cmNlID09PSAnbG9jYWwnID8gJ+eUqOaIt+aMh+WumuacrOWcsOebruW9leeahOWQjOWQjeaYoOWwhO+8jOS/neeVmeWOnyBTcHJpdGVGcmFtZSBVVUlEIOS4juWIh+eJh+WPguaVsCdcbiAgICAgICAgICAgICAgICA6ICfmjInlt7LmnInotYTmupDmiJbmnKzmibnlkIzlkI3otYTmupDlpI3nlKjljp8gU3ByaXRlRnJhbWXvvIzkv53nlZkgVVVJRCDkuI7ljp/liIfniYflj4LmlbAnLCBhc3NldC51cmwpO1xuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xuICAgICAgICAgICAgPyAn5aSN55So5pys5Zyw6LWE5rqQJ1xuICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdleGlzdGluZydcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXG4gICAgICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdnZW5lcmF0ZWQnXG4gICAgICAgICAgICAgICAgICAgID8gJ+eUn+aIkOa4kOWPmCdcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxuICAgICAgICAgICAgbWVzc2FnZTogYCR7dmVyYn0gJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXG4gICAgICAgIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBwcm9jZXNzVGlsZWQgPSBhc3luYyAoaXRlbXM6IFRpbGVkQXNzZXRSZXF1ZXN0W10pID0+IHtcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcbiAgICAgICAgICAgIHNvdXJjZUtleTogc3RyaW5nO1xuICAgICAgICAgICAgYXNzZXRLZXk6IHN0cmluZztcbiAgICAgICAgfVxuICAgICAgICBpbnRlcmZhY2UgUGVuZGluZ1RpbGUgZXh0ZW5kcyBUaWxlR3JvdXAge1xuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcbiAgICAgICAgICAgIHNvdXJjZVR5cGU6ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJztcbiAgICAgICAgICAgIHNvdXJjZVJlbmRlclNjYWxlPzogbnVtYmVyO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XG4gICAgICAgIGNvbnN0IHJlbmRlclNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcbiAgICAgICAgICAgID8gY2xhbXBJbWFnZVNjYWxlKHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpXG4gICAgICAgICAgICA6IDE7XG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBUaWxlR3JvdXA+KCk7XG4gICAgICAgIGZvciAoY29uc3QgeyBub2RlLCBzb3VyY2UgfSBvZiBpdGVtcykge1xuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcbiAgICAgICAgICAgICAgICBraW5kOiBzb3VyY2Uua2luZCxcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxuICAgICAgICAgICAgICAgIHBhaW50U2NhbGU6IHNvdXJjZS5zY2FsZSxcbiAgICAgICAgICAgICAgICByZW5kZXJTY2FsZTogcmVuZGVyU2NhbGUoc291cmNlKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgYXNzZXRLZXkgPSB0aWxlZFJhc3RlcktleShzb3VyY2VLZXksIHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpO1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwobm9kZS5uYW1lLCBhc3NldEtleSwgJ3BuZycpXG4gICAgICAgICAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpXG4gICAgICAgICAgICAgICAgLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlLCBub2RlczogW10sIHNvdXJjZSwgc291cmNlS2V5LCBhc3NldEtleSB9O1xuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxuICAgICAgICApID0+IHtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcbiAgICAgICAgY29uc3QgbmFtZWRMb2NhbFRpbGVzID0gbmV3IE1hcDxzdHJpbmcsIHtcbiAgICAgICAgICAgIG1hdGNoOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGZpbmRMb2NhbD4+O1xuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGw7XG4gICAgICAgIH0+KCk7XG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG5hbWVLZXkgPSByZXNvdXJjZUtleShncm91cC5ub2RlKTtcbiAgICAgICAgICAgIGxldCBsb2NhbCA9IG5hbWVkTG9jYWxUaWxlcy5nZXQobmFtZUtleSk7XG4gICAgICAgICAgICBpZiAoIWxvY2FsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwoZ3JvdXAubm9kZS5uYW1lLCBmYWxzZSwgZ3JvdXAubm9kZS5pZCk7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxVcmwgJiYgIWFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlkI7ph43or5XvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xuICAgICAgICAgICAgICAgIGxvY2FsID0geyBtYXRjaCwgYXNzZXQgfTtcbiAgICAgICAgICAgICAgICBuYW1lZExvY2FsVGlsZXMuc2V0KG5hbWVLZXksIGxvY2FsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChsb2NhbC5hc3NldCkge1xuICAgICAgICAgICAgICAgIC8vIFRpbGluZyBhbmQgaXRzIHBlcmlvZCBiZWxvbmcgdG8gdGhpcyBub2RlLCBub3QgdGhlIHNoYXJlZFxuICAgICAgICAgICAgICAgIC8vIFNwcml0ZUZyYW1lIE1ldGEuIEtlZXAgdGhlIG9yaWdpbmFsIFVVSUQgYW5kIHBpeGVscyBpbnRhY3QuXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cC5ub2RlcywgeyAuLi5sb2NhbC5hc3NldCwgc2xpY2VkOiBmYWxzZSwgdGlsZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHRpbGVTY2FsZTogcmVxdWVzdGVkU2NhbGUoZ3JvdXAuc291cmNlKSB9LCAnbG9jYWwnKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChsb2NhbC5tYXRjaCkge1xuICAgICAgICAgICAgICAgIC8vIEFuIGV4dGVybmFsIGJpdG1hcCBoYXMgbm8gcHJvamVjdCBVVUlELiBJbXBvcnQgaXQgdGhyb3VnaFxuICAgICAgICAgICAgICAgIC8vIHRoZSBleGlzdGluZyBnZW5lcmF0ZWQtdGlsZSBwYXRoLCB3aXRoIGl0cyB1bnNjYWxlZCBwaXhlbHMuXG4gICAgICAgICAgICAgICAgcGVuZGluZy5wdXNoKHsgLi4uZ3JvdXAsIGNvbnRlbnRzOiBsb2NhbC5tYXRjaC5jb250ZW50cyxcbiAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbC5tYXRjaC5jb250ZW50cyksIHNvdXJjZVR5cGU6ICdsb2NhbCcsIHNvdXJjZVJlbmRlclNjYWxlOiAxIH0pO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IGV4aXN0aW5nQXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XG4gICAgICAgICAgICAgICAgZXhpc3RpbmdBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShncm91cFNvdXJjZUtleShncm91cC5hc3NldEtleSksIHsgdGlsZWQ6IHRydWUgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdBc3NldCkge1xuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHBpeGVsU2l6ZWRUaWxlQXNzZXQoZXhpc3RpbmdBc3NldCksICdleGlzdGluZycpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcbiAgICAgICAgICAgIGxldCBjYWNoZWRFeHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXG4gICAgICAgICAgICAgICAgICAgID8gWydwbmcnXVxuICAgICAgICAgICAgICAgICAgICA6IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TO1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gYXdhaXQgY2FjaGUucmVhZCh7XG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShncm91cC5zb3VyY2UpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhY2hlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBjYWNoZWQ7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXG4gICAgICAgICAgICAgICAgY29udGVudHMsXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBjYWNoZWRFeHRlbnNpb24sXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVtb3RlSXRlbXMgPSBwZW5kaW5nLmZpbHRlcigoaXRlbSkgPT4gIWl0ZW0uY29udGVudHMpO1xuICAgICAgICBjb25zdCBwYXR0ZXJuVXJscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiByZW1vdGVJdGVtcykge1xuICAgICAgICAgICAgaWYgKGl0ZW0uc291cmNlLmtpbmQgIT09ICdzb3VyY2Utbm9kZScpIHtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpO1xuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICAgICAgICBpZHMuYWRkKGl0ZW0uc291cmNlLmlkKTtcbiAgICAgICAgICAgIHBhdHRlcm5zQnlTY2FsZS5zZXQoc2NhbGUsIGlkcyk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBbc2NhbGUsIGlkc10gb2YgcGF0dGVybnNCeVNjYWxlKSB7XG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxuICAgICAgICAgICAgICAgIEFycmF5LmZyb20oaWRzKSxcbiAgICAgICAgICAgICAgICAncG5nJyxcbiAgICAgICAgICAgICAgICBzY2FsZSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtpZCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyh1cmxzKSkge1xuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcbiAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IG5lZWRzSW1hZ2VGaWxsc1xuICAgICAgICAgICAgPyBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KVxuICAgICAgICAgICAgOiB7fTtcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcbiAgICAgICAgY29uc3QgZG93bmxvYWQgPSAodXJsOiBzdHJpbmcsIG5vZGVMYWJlbDogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQodXJsKTtcbiAgICAgICAgICAgIGlmICghdGFzaykge1xuICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZCh1cmwsIG5vZGVMYWJlbCkpO1xuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0YXNrO1xuICAgICAgICB9O1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXG4gICAgICAgICAgICAgICAgICAgICAgICBgJHtpdGVtLnNvdXJjZS5pZH06c2NhbGU6JHtyZW5kZXJTY2FsZShpdGVtLnNvdXJjZSl9YCxcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGBJTUFHRSDloavlhYUgJHtpdGVtLnNvdXJjZS5pZH1gO1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+myR7bGFiZWx977yaJHtpdGVtLm5vZGUubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBkb3dubG9hZChyZW1vdGVVcmwsIGAke2l0ZW0ubm9kZS5uYW1lfSAoJHtpdGVtLm5vZGUuaWR9KWApO1xuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xuICAgICAgICAgICAgICAgICAgICA6IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgdGlsZToke2l0ZW0uc291cmNlS2V5fWAsXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+W5s+mTuui1hOa6kOaMieWunumZheWwuuWvuOeUn+aIkCcsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XG4gICAgICAgICAgICBsZXQgcmFzdGVyOiBSZXR1cm5UeXBlPHR5cGVvZiByYXN0ZXJpemVUaWxlPjtcbiAgICAgICAgICAgIHRyeSB7IHJhc3RlciA9IHJhc3Rlcml6ZVRpbGUoY29udGVudHMsIHJlcXVlc3RlZFNjYWxlKGl0ZW0uc291cmNlKSwgaXRlbS5zb3VyY2VSZW5kZXJTY2FsZSA/PyByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSkpOyB9XG4gICAgICAgICAgICBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOW5s+mTuui1hOa6kOKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5peg5rOV5oyJ5a6e6ZmF5bC65a+455Sf5oiQ77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmFzdGVyLnJvdW5kZWQpIHdhcm5pbmdzLmFkZChg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3nmoTmmL7npLrlsLrlr7jlt7Llj5bmlbTkuLogJHtyYXN0ZXIud2lkdGh9w5cke3Jhc3Rlci5oZWlnaHR9IOWDj+e0oO+8iOacgOWwjyAx77yJ77yM6IqC54K5IFNjYWxlIOS/neaMgSAx44CCYCk7XG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChpdGVtLm5vZGUubmFtZSwgaXRlbS5hc3NldEtleSwgJ3BuZycpO1xuICAgICAgICAgICAgY29tcGxldGVHcm91cChcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxuICAgICAgICAgICAgICAgIHBpeGVsU2l6ZWRUaWxlQXNzZXQoYXdhaXQgd3JpdGVyLnJlc29sdmUodXJsLCByYXN0ZXIuY29udGVudHMsIHsgc291cmNlS2V5OiBncm91cFNvdXJjZUtleShpdGVtLmFzc2V0S2V5KSwgdGlsZWQ6IHRydWUgfSkpLFxuICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlVHlwZSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0cmFjZS5kb25lKHsgc291cmNlV2lkdGg6IHJhc3Rlci5zb3VyY2VXaWR0aCwgc291cmNlSGVpZ2h0OiByYXN0ZXIuc291cmNlSGVpZ2h0LFxuICAgICAgICAgICAgICAgIHdpZHRoOiByYXN0ZXIud2lkdGgsIGhlaWdodDogcmFzdGVyLmhlaWdodCwgdGlsZVNjYWxlOiAxIH0pO1xuICAgICAgICB9XG4gICAgfTtcblxuICAgIGNvbnN0IHByb2Nlc3NSZW1vdGUgPSBhc3luYyAobm9kZXM6IEZpZ21hTm9kZVtdKSA9PiB7XG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHVybDogc3RyaW5nOyBub2RlczogRmlnbWFOb2RlW10gfT4oKTtcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfWAsXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc291cmNlS2V5KG5vZGUpO1xuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcGVuZGluZzogQXJyYXk8e1xuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xuICAgICAgICAgICAgdXJsOiBzdHJpbmc7XG4gICAgICAgICAgICBib3JkZXJzPzogeyBsZWZ0OiBudW1iZXI7IHJpZ2h0OiBudW1iZXI7IHRvcDogbnVtYmVyOyBib3R0b206IG51bWJlciB9O1xuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XG4gICAgICAgICAgICBrZXk6IENhY2hlRW50cnlLZXk7XG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xuICAgICAgICB9PiA9IFtdO1xuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXG4gICAgICAgICkgPT4ge1xuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBncm91cGVkTm9kZXMpIHtcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBBIGRlY2xhcmVkIEZpZ21hIHNsaWNlIG93bnMgdGhpcyBzYW1lLW5hbWUgcmVzb3VyY2UgZXZlbiB3aGVuIGFuXG4gICAgICAgICAgICAvLyBvcmRpbmFyeSBQTkcgd2FzIGVuY291bnRlcmVkIGZpcnN0LiBJTUFHRSBhbmQgZ3JhZGllbnQgc3RhZ2VzXG4gICAgICAgICAgICAvLyBydW4gbGF0ZXIgYW5kIHNoYXJlIHRoaXMgc2luZ2xlIGdlbmVyYXRlZCByZXN1bHQuXG4gICAgICAgICAgICBjb25zdCBzbGljZWRTb3VyY2VzID0gZ3JvdXBlZE5vZGVzLmZsYXRNYXAoKGNhbmRpZGF0ZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbkZvck5vZGUoY2FuZGlkYXRlLCBkZWNpc2lvbnMpLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICBjb25zdCBhbmFseXNpcyA9IGFuYWx5emVTbGljZUdyaWQoY2FuZGlkYXRlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gYW5hbHlzaXMgPyBbeyBub2RlOiBjYW5kaWRhdGUsIGFuYWx5c2lzIH1dIDogW107XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkU2xpY2UgPSBzbGljZWRTb3VyY2VzWzBdO1xuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IHNlbGVjdGVkU2xpY2U/Lm5vZGUgPz8gZ3JvdXBlZE5vZGVzWzBdO1xuICAgICAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBzZWxlY3RlZFNsaWNlPy5hbmFseXNpcyA/PyAoZGVjaXNpb24ubmluZVNsaWNlID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKSA6IG51bGwpO1xuICAgICAgICAgICAgY29uc3QgcmV1c2VBc3NldCA9IChhc3NldDogU3ByaXRlQXNzZXRTcGVjLCBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnKSA9PiB7XG4gICAgICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgYXNzZXQpO1xuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIWFzc2V0LnNsaWNlZCkge1xuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3lt7Lnm7TmjqXlvJXnlKjlkIzlkI3otYTmupDvvIzkvYbor6UgU3ByaXRlRnJhbWUg5pyq6YWN572u5Lmd5a6r6L656Led77yM5pqC5oyJ5pmu6YCaIFNwcml0ZSDmmL7npLrvvJvor7flnKjljp/otYTmupDkuK3orr7nva7ovrnot53vvJoke2Fzc2V0LnVybH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cGVkTm9kZXMsIGFzc2V0LCBzb3VyY2UpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IHNoYXJlZCA9IHNsaWNlQW5hbHlzaXMgPyB1bmRlZmluZWQgOiBzaGFyZWRBc3NldHMuZ2V0KHJlc291cmNlS2V5KG5vZGUpKTtcbiAgICAgICAgICAgIGlmIChzaGFyZWQpIHtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KHNoYXJlZCwgJ2V4aXN0aW5nJyk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpICYmICFzbGljZUFuYWx5c2lzID8gbnVsbCA6IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlLCBub2RlLmlkKTtcbiAgICAgICAgICAgIC8vIEFuIGV4cGxpY2l0bHkgZGVzaWduYXRlZCBsb2NhbCBTcHJpdGVGcmFtZSBvd25zIGl0cyBwaXhlbHMgYW5kXG4gICAgICAgICAgICAvLyBpbnNldHMuIFJldXNlIGl0IHJlYWQtb25seSwgZXZlbiB3aGVuIEZpZ21hIGRlZmluZXMgYSBzbGljZSBvclxuICAgICAgICAgICAgLy8gcmVmcmVzaCBpcyByZXF1ZXN0ZWQ7IHNvdXJjZSBpbnNldHMgY2Fubm90IGJlIGFwcGxpZWQgdG8gYW5cbiAgICAgICAgICAgIC8vIHVua25vd24gb3IgYWxyZWFkeS1jb21wYWN0ZWQgbG9jYWwgY2FudmFzLlxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBsb2NhbE1hdGNoXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcbiAgICAgICAgICAgICAgICA6IG51bGw7XG4gICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChsb2NhbEFzc2V0LCBsb2NhbE1hdGNoIS5zb3VyY2UpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGxvY2FsVXJsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3mnKzlnLDotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzor7flhYjlnKggQ29jb3Mg5Lit5a6M5oiQ6LWE5rqQ5a+85YWl5bm26K6+572u5Li6IFNwcml0ZUZyYW1lIOWQjumHjeivle+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBuYW1lZE91dHB1dCA9ICFzbGljZUFuYWx5c2lzICYmICFsb2NhbE1hdGNoICYmICFhbmFseXplTWFza1RpbnQobm9kZSkgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZWRBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lZEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KG5hbWVkQXNzZXQsICdleGlzdGluZycpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHNlbGVjdGVkU2xpY2UgJiYgIWxvY2FsTWF0Y2gpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBzaGFwZSA9IChlbnRyeTogdHlwZW9mIHNlbGVjdGVkU2xpY2UpID0+IEpTT04uc3RyaW5naWZ5KHsgbW9kZTogZW50cnkuYW5hbHlzaXMubW9kZSxcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyczogZW50cnkuYW5hbHlzaXMuYm9yZGVycywgZnJhbWU6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCAmJiB7XG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LndpZHRoLCBoZWlnaHQ6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveC5oZWlnaHQsXG4gICAgICAgICAgICAgICAgICAgIH0gfSk7XG4gICAgICAgICAgICAgICAgaWYgKHNsaWNlZFNvdXJjZXMuc2xpY2UoMSkuc29tZSgoZW50cnkpID0+IHNoYXBlKGVudHJ5KSAhPT0gc2hhcGUoc2VsZWN0ZWRTbGljZSkpKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGDlkIzlkI3kuIkv5Lmd5a6r5a6a5LmJ5LiN5ZCM77yM5rK/55So6aaW5Liq5pyJ5pWIIEZpZ21hIOWIh+eJh+KAnCR7bm9kZS5uYW1lfeKAneeahOWOn+Wni+eUu+W4g+S4jui+uei3ne+8jOS7heeUn+aIkOS4gOS7vei1hOa6kGA7XG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChyZWFzb24pO1xuICAgICAgICAgICAgICAgICAgICBub3RlKCdtZXJnZWQnLCBub2RlLm5hbWUsIHJlYXNvbiwgdXJsKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbm90ZSgnbWVyZ2VkJywgbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAnRmlnbWEg5LiJL+S5neWuq+WumuS5ieS8mOWFiO+8muS9v+eUqCBGaWdtYSDljp/lp4vnlLvluIPkuI7ovrnot53nlJ/miJDovpPlh7rotYTmupDvvIzkuI3msr/nlKjmnKrmjIflrprovpPlh7rotYTmupDnmoTml6fovrnot50nLCB1cmwpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhc2xpY2VBbmFseXNpcykge1xuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneaXoOazleiuoeeul+i/nue7reWIh+eJh+i+ueeVjO+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWlYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBib3JkZXJzID0gc2xpY2VBbmFseXNpcz8uYm9yZGVycztcbiAgICAgICAgICAgIC8vIE5ldyBzbGljZWQgYXNzZXRzIHJldGFpbiB0aGVpciBleGFjdCBnZW9tZXRyaWMgY2FudmFzIGJlY2F1c2VcbiAgICAgICAgICAgIC8vIHRoZWlyIGdlbmVyYXRlZCBib3JkZXJzIHVzZSB0aGF0IGNvb3JkaW5hdGUgc3BhY2UuXG4gICAgICAgICAgICBjb25zdCByZW5kZXJGcmFtZSA9IGJvcmRlcnMgPyB1bmRlZmluZWQgOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpO1xuICAgICAgICAgICAgY29uc3Qga2V5OiBDYWNoZUVudHJ5S2V5ID0ge1xuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcbiAgICAgICAgICAgICAgICBub2RlSWQ6IG5vZGUuaWQsXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcbiAgICAgICAgICAgICAgICB2YXJpYW50OiByZW5kZXJGcmFtZSA/ICd2aXN1YWwtb3ZlcmZsb3ctdjEnIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGxldCBjYWNoZWQgPSBsb2NhbE1hdGNoIHx8IGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHNcbiAgICAgICAgICAgICAgICA/IG51bGxcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGNhY2hlLnJlYWQoa2V5KTtcbiAgICAgICAgICAgIGlmIChzbGljZUFuYWx5c2lzICYmIGNhY2hlZCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94ITtcbiAgICAgICAgICAgICAgICBjb25zdCBpc0Z1bGxDYW52YXMgPSBpc1BuZyhjYWNoZWQpICYmIGNhY2hlZC5sZW5ndGggPj0gMjRcbiAgICAgICAgICAgICAgICAgICAgJiYgY2FjaGVkLnRvU3RyaW5nKCdhc2NpaScsIDEyLCAxNikgPT09ICdJSERSJ1xuICAgICAgICAgICAgICAgICAgICAmJiBNYXRoLmFicyhjYWNoZWQucmVhZFVJbnQzMkJFKDE2KSAtIGZyYW1lLndpZHRoICogaW1wb3J0U2V0dGluZ3Muc2NhbGUpIDw9IDFcbiAgICAgICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMoY2FjaGVkLnJlYWRVSW50MzJCRSgyMCkgLSBmcmFtZS5oZWlnaHQgKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSkgPD0gMTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzRnVsbENhbnZhcykge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZWQgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgJ+e8k+WtmOS4jeaYryBGaWdtYSDlrozmlbTnlLvluIPvvIzph43mlrDlr7zlh7rljp/lp4sgUE5HIOWQjuWGjeW6lOeUqOS4iS/kuZ3lrqvovrnot50nLCB1cmwpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XG4gICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICBub2RlczogZ3JvdXBlZE5vZGVzLFxuICAgICAgICAgICAgICAgIHVybDogbG9jYWxNYXRjaCAmJiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbE1hdGNoLmNvbnRlbnRzKSA9PT0gJ2pwZydcbiAgICAgICAgICAgICAgICAgICAgPyB1cmwucmVwbGFjZSgvXFwucG5nJC9pLCAnLmpwZycpIDogdXJsLFxuICAgICAgICAgICAgICAgIGJvcmRlcnMsXG4gICAgICAgICAgICAgICAgc2xpY2VBbmFseXNpczogc2xpY2VBbmFseXNpcyA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgcmVuZGVyRnJhbWU6IGxvY2FsTWF0Y2ggPyB1bmRlZmluZWQgOiByZW5kZXJGcmFtZSxcbiAgICAgICAgICAgICAgICBrZXksXG4gICAgICAgICAgICAgICAgY29udGVudHM6IGxvY2FsTWF0Y2g/LmNvbnRlbnRzID8/IGNhY2hlZCxcbiAgICAgICAgICAgICAgICBzb3VyY2U6IGxvY2FsTWF0Y2ggPyAnbG9jYWwnIDogY2FjaGVkID8gJ2NhY2hlJyA6ICdmaWdtYScsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB1cmxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPiA9IHt9O1xuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XG4gICAgICAgIGZvciAoY29uc3QgdXNlQWJzb2x1dGVCb3VuZHMgb2YgW3RydWUsIGZhbHNlXSkge1xuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSByZW1vdGVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyA/ICFpdGVtLnJlbmRlckZyYW1lIDogQm9vbGVhbihpdGVtLnJlbmRlckZyYW1lKVxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICBpZiAoIWJhdGNoLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih1cmxzLCBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXG4gICAgICAgICAgICAgICAgYmF0Y2gubWFwKChpdGVtKSA9PiBpdGVtLm5vZGUuaWQpLFxuICAgICAgICAgICAgICAgIGZvcm1hdCxcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyxcbiAgICAgICAgICAgICAgICBPYmplY3QuZnJvbUVudHJpZXMoYmF0Y2gubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGUubmFtZV0pKSxcbiAgICAgICAgICAgICkpO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gdXJsc1tpdGVtLm5vZGUuaWRdO1xuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95riy5p+T6IqC54K577yaJHtpdGVtLm5vZGUubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoaXRlbS5rZXksIGNvbnRlbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XG4gICAgICAgICAgICBsZXQgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYztcbiAgICAgICAgICAgIGlmIChpdGVtLnNsaWNlQW5hbHlzaXMpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5LiJL+S5neWuq+i1hOa6kOacgOWwj+WMlicsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgd3JpdGVTbGljZWRQbmcod3JpdGVyLCBpdGVtLnVybCwgY29udGVudHMsIGl0ZW0ubm9kZSxcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zbGljZUFuYWx5c2lzLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XG4gICAgICAgICAgICAgICAgYXNzZXQgPSByZXN1bHQuYXNzZXQ7XG4gICAgICAgICAgICAgICAgdHJhY2UuZG9uZShyZXN1bHQub3B0aW1pemF0aW9uKTtcbiAgICAgICAgICAgICAgICBub3RlKGFzc2V0LnNsaWNlRmFsbGJhY2sgPyAnZmFsbGJhY2snIDogJ21lcmdlZCcsIGl0ZW0ubm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICBg5LiJL+S5neWuq++8miR7cmVzdWx0Lm9wdGltaXphdGlvbi5yZWFzb24gPz8gcmVzdWx0Lm9wdGltaXphdGlvbi5zdGF0dXN9YCwgYXNzZXQudXJsKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUoaXRlbS51cmwsIGNvbnRlbnRzLCBpdGVtLmJvcmRlcnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkoaXRlbS5ub2RlKSwgYXNzZXQpO1xuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke2l0ZW0ubm9kZS5uYW1lfeKAneWIh+eJh+iuvue9ruWksei0pe+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWl77yaJHthc3NldC5zbGljZUZhbGxiYWNrfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChcbiAgICAgICAgICAgICAgICAgICAgZ3JvdXBlZE5vZGUsXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcbiAgICAgICAgICAgICAgICAgICAgICAgID8geyAuLi5hc3NldCwgcmVuZGVyRnJhbWU6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUoZ3JvdXBlZE5vZGUpID8/IGl0ZW0ucmVuZGVyRnJhbWUgfVxuICAgICAgICAgICAgICAgICAgICAgICAgOiBhc3NldCxcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH07XG5cbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IG5vZGU6IEZpZ21hTm9kZTsgbm9kZXM6IEZpZ21hTm9kZVtdOyBpbWFnZVJlZjogc3RyaW5nIH0+KCk7XG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzb3VyY2VLZXkoaXRlbS5ub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZTogaXRlbS5ub2RlLCBub2RlczogW10sIGltYWdlUmVmOiBpdGVtLmltYWdlUmVmIH07XG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKGl0ZW0ubm9kZSk7XG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGltYWdlRmlsbFVybHNQcm9taXNlOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+PiB8IHVuZGVmaW5lZDtcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcbiAgICAgICAgY29uc3QgY29tcGxldGVJbWFnZXMgPSAobm9kZXM6IEZpZ21hTm9kZVtdLCBiYXNlOiBTcHJpdGVBc3NldFNwZWMsXG4gICAgICAgICAgICBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnIHwgJ2NhY2hlJyB8ICdmaWdtYScpID0+IHtcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZXNbMF0pLCBiYXNlKTtcbiAgICAgICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgaW5uZXJPcGFjaXR5IH0gPSBpbWFnZURldGFpbHMobm9kZSk7XG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBpbm5lck9wYWNpdHkgPCAxID8geyAuLi5iYXNlLCB0aW50OiB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IGlubmVyT3BhY2l0eSB9IH0gOiBiYXNlO1xuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xuICAgICAgICAgICAgY29uc3Qgc2hhcmVkID0gc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShncm91cC5ub2RlKSk7XG4gICAgICAgICAgICBpZiAoc2hhcmVkKSB7XG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB7IGxlYWYgfSA9IGltYWdlRGV0YWlscyhncm91cC5ub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgZmluZExvY2FsKGdyb3VwLm5vZGUubmFtZSwgZmFsc2UsIGdyb3VwLm5vZGUuaWQpO1xuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xuICAgICAgICAgICAgaWYgKGxvY2FsVXJsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybCk7XG4gICAgICAgICAgICAgICAgaWYgKCFsb2NhbEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGxvY2FsQXNzZXQsIG1hdGNoIS5zb3VyY2UpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbWF0Y2ggPyBhd2FpdCBmaW5kT3V0cHV0KGdyb3VwLm5vZGUubmFtZSkgOiBudWxsO1xuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBuYW1lZE91dHB1dCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISkgOiBudWxsO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChuYW1lZE91dHB1dCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XG4gICAgICAgICAgICBsZXQgc291cmNlOiAnY2FjaGUnIHwgJ2ZpZ21hJyA9ICdjYWNoZSc7XG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xuICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGNhY2hlLnJlYWQoe1xuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogY2FuZGlkYXRlLFxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gY2FuZGlkYXRlO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFpbWFnZUZpbGxVcmxzUHJvbWlzZSkge1xuICAgICAgICAgICAgICAgICAgICBpbWFnZUZpbGxVcmxzUHJvbWlzZSA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBhd2FpdCBpbWFnZUZpbGxVcmxzUHJvbWlzZTtcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpbWFnZUZpbGxVcmxzW2dyb3VwLmltYWdlUmVmXTtcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+m+makOiXj+WbvueJh+Whq+WFhe+8miR7Z3JvdXAubm9kZS5uYW1lfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQocmVtb3RlVXJsKTtcbiAgICAgICAgICAgICAgICBpZiAoIXRhc2spIHtcbiAgICAgICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7Z3JvdXAubm9kZS5uYW1lfSAoJHtncm91cC5ub2RlLmlkfSlgKSk7XG4gICAgICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQocmVtb3RlVXJsLCB0YXNrKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCB0YXNrO1xuICAgICAgICAgICAgICAgIHNvdXJjZSA9ICdmaWdtYSc7XG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcbiAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGV4dGVuc2lvbiA/Pz0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xuICAgICAgICAgICAgY29uc3QgZmlsbCA9IGxlYWYuZmlsbHMuZmluZCgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIHBhaW50LnR5cGUgPT09ICdJTUFHRScpO1xuICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUoZ3JvdXAubm9kZSk7XG4gICAgICAgICAgICBjb25zdCByYXN0ZXIgPSByYXN0ZXJpemVJbWFnZUZpbGwoY29udGVudHMsIGZpbGw/LnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA9PT0gJ0ZJVCcgPyAnRklUJyA6ICdGSUxMJyxcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCwgZnJhbWUuaGVpZ2h0LCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxuICAgICAgICAgICAgICAgIGdyb3VwLm5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OmltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXG4gICAgICAgICAgICAgICAgJ3BuZycsXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCByYXN0ZXIpO1xuICAgICAgICAgICAgbm90ZVdyaXRlKHJlc29sdmVkKTtcbiAgICAgICAgICAgIGlmIChncm91cC5ub2RlLmNoaWxkcmVuLmxlbmd0aCkgbm90ZSgnbWVyZ2VkJywgZ3JvdXAubm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgICfmma7pgJogSU1BR0Ug5Zyo6ZqQ6JeP5ZKM5pi+56S654q25oCB5L2/55So55u45ZCM5Lit5b+D6KOB5YiHL+mAgumFje+8m+a6kOWbvue8k+WtmOS/neeVmeWOn+Wni+WDj+e0oO+8jOiKgueCuemAj+aYjuW6puWNleeLrOW6lOeUqCcsIHJlc29sdmVkLnVybCk7XG4gICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgcmVzb2x2ZWQsIHNvdXJjZSk7XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+W5s+mTuui1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnRpbGVkLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzVGlsZWQocmVxdWVzdHMudGlsZWQpKTtcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSHIFBORyDotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5wbmcubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKSk7XG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WOn+WniyBJTUFHRSDloavlhYXotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XG5cbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcmVxdWVzdHMuZ3JhZGllbnRzKSB7XG4gICAgICAgIGNvbnN0IHNoYXJlZCA9IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkobm9kZSkpO1xuICAgICAgICBpZiAoc2hhcmVkKSB7XG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBuYW1lZCA9IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlLCBub2RlLmlkKTtcbiAgICAgICAgY29uc3QgbmFtZWRVcmwgPSBuYW1lZCA/IGFzc2V0RGF0YWJhc2VVcmwobmFtZWQucGF0aCkgOiBudWxsO1xuICAgICAgICBpZiAobmFtZWRVcmwpIHtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKG5hbWVkVXJsKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZFVybH1gKTtcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGV4aXN0aW5nKTtcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsIG5hbWVkIS5zb3VyY2UpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbmFtZWQgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xuICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgZXhpc3RpbmcpO1xuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBleGlzdGluZywgJ2V4aXN0aW5nJyk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcbiAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXG4gICAgICAgICAgICA/IGdyYWRpZW50UG5nKFxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLFxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcbiAgICAgICAgICAgICAgICBmaWxsLFxuICAgICAgICAgICAgICAgIGNvcm5lclJhZGlpKG5vZGUpLFxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICBpZiAocG5nKSB7XG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXG4gICAgICAgICAgICAgICAgJ3BuZycsXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBwbmcpO1xuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGFzc2V0KTtcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsICdnZW5lcmF0ZWQnKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxuICAgICAgICAgICAgbWVzc2FnZTogYOeUn+aIkOa4kOWPmCAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcbiAgICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZXZlbnQgb2Ygd3JpdGVyLmV2ZW50cykgbm90ZShldmVudC5hY3Rpb24sIGJhc2VuYW1lKGV2ZW50LnVybCksIGV2ZW50LnJlYXNvbiwgZXZlbnQudXJsKTtcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgW2ZhbWlseSwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKSkge1xuICAgICAgICBpZiAoIXVybCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCByZXNvbHZlQXNzZXRVdWlkKHVybCk7XG4gICAgICAgIGlmICh1dWlkKSB7XG4gICAgICAgICAgICByZXN1bHQuc2V0KGZhbWlseSwgdXVpZCk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgbmF0aXZlTW9kZSA9IGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpO1xuICAgIGlmIChuYXRpdmVNb2RlKSB7XG4gICAgICAgIHJldHVybiBuYXRpdmVNb2RlO1xuICAgIH1cbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXG4gICAgICAgIC5maWx0ZXIoKGZyYW1lKTogZnJhbWUgaXMgUmVjdCA9PiBCb29sZWFuKGZyYW1lKSk7XG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiAnVkVSVElDQUwnO1xuICAgIH1cbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcbiAgICBjb25zdCBjZW50ZXJzWSA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0IC8gMik7XG4gICAgY29uc3Qgc3ByZWFkWCA9IE1hdGgubWF4KC4uLmNlbnRlcnNYKSAtIE1hdGgubWluKC4uLmNlbnRlcnNYKTtcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xuICAgIGlmIChzcHJlYWRZIDw9IDIpIHtcbiAgICAgICAgcmV0dXJuICdIT1JJWk9OVEFMJztcbiAgICB9XG4gICAgaWYgKHNwcmVhZFggPD0gMikge1xuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcbiAgICB9XG4gICAgcmV0dXJuICdHUklEJztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VTcGVjKFxuICAgIG5vZGU6IEZpZ21hTm9kZSxcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcbiAgICBwbGFuczogUmVhZG9ubHlNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4sXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4sXG4gICAgZm9udHM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXG4gICAgaXNSb290ID0gZmFsc2UsXG4gICAgcGFyZW50V29ybGRSb3RhdGlvbiA9IDAsXG4gICAgc3luYz86IHsgZmlsZUtleTogc3RyaW5nIH0sXG4pOiBTY2VuZU5vZGVTcGVjIHwgbnVsbCB7XG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUobm9kZSk7XG4gICAgY29uc3QgcGxhbiA9IHBsYW5zLmdldChub2RlLmlkKTtcbiAgICBjb25zdCBmb2xkID0gcGxhbj8uZm9sZDtcbiAgICBjb25zdCBmb2xkU291cmNlID0gZm9sZCA/IG5vZGVCeUlkLmdldChmb2xkLnNvdXJjZU5vZGVJZCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgdGV4dFNvdXJjZSA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xuICAgIGNvbnN0IHZpc3VhbFNvdXJjZSA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcbiAgICBjb25zdCByZXNvbHZlZEtpbmQgPSBkZWNpc2lvbi5raW5kID09PSAnYXV0bycgPyBpbmZlcktpbmQobm9kZSkgOiBkZWNpc2lvbi5raW5kO1xuICAgIGNvbnN0IHBsYW5uZWRLaW5kID0gcGxhbj8ua2luZCA/PyByZXNvbHZlZEtpbmQ7XG4gICAgY29uc3QgYml0bWFwVGVybWluYWwgPSBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJztcbiAgICBjb25zdCB0ZXJtaW5hbCA9IGJpdG1hcFRlcm1pbmFsIHx8IGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKTtcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0ga2luZEZvckltcG9ydEFjdGlvbihwbGFubmVkS2luZCwgZGVjaXNpb24uYWN0aW9uLCBkZWNpc2lvbi5uaW5lU2xpY2UpO1xuICAgIGNvbnN0IHNwcml0ZVNvdXJjZUlkID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCdcbiAgICAgICAgPyBmb2xkLnNvdXJjZU5vZGVJZFxuICAgICAgICA6IG5vZGUuaWQ7XG4gICAgY29uc3Qgc3ByaXRlQXNzZXQgPSBhc3NldHMuZ2V0KHNwcml0ZVNvdXJjZUlkKTtcbiAgICBjb25zdCBhYnNvcmJlZERpcmVjdElkcyA9IG5ldyBTZXQoZm9sZCA/IFtmb2xkLnNvdXJjZU5vZGVJZF0gOiBbXSk7XG4gICAgY29uc3QgZnVsbEZvbGQgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLWltYWdlJyB8fCBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnO1xuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBwYXJlbnRXb3JsZFJvdGF0aW9uICsgbm9kZS5yb3RhdGlvbjtcbiAgICAvLyDmipjlj6DliLDmnKzoioLngrnnmoTlrZDlsYIgaWQg5LiOIGFsaWFzRmlnbWFJZHMg5LiA6Ie077yb5qCH6K6w5Y+q6K6w5b2V6IGa5ZCI6Lqr5Lu977yMXG4gICAgLy8g5LiN6K+V5Zu+5Li65oqY5Y+g5a2Q5bGC5Y2V54us5bu66IqC54K544CCXG4gICAgY29uc3Qgc3luY01hcmtlcjogU3luY01hcmtlclNwZWMgfCB1bmRlZmluZWQgPSBzeW5jXG4gICAgICAgID8gY3JlYXRlU3luY01hcmtlcih7XG4gICAgICAgICAgICBmaWxlS2V5OiBzeW5jLmZpbGVLZXksXG4gICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgYWxpYXNOb2RlSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMgPz8gW10sXG4gICAgICAgIH0pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgIHJldHVybiB7XG4gICAgICAgIGZpZ21hSWQ6IG5vZGUuaWQsXG4gICAgICAgIG5hbWU6IGRlY2lzaW9uLm5hbWUgPz8gbm9kZS5uYW1lLFxuICAgICAgICBmaWdtYVR5cGU6IHZpc3VhbFNvdXJjZS50eXBlLFxuICAgICAgICBhY3Rpb246IGRlY2lzaW9uLmFjdGlvbixcbiAgICAgICAga2luZDogZWZmZWN0aXZlS2luZCxcbiAgICAgICAgZnJhbWUsXG4gICAgICAgIHBhcmVudEZyYW1lLFxuICAgICAgICBpbnRyaW5zaWNTaXplOiBub2RlLnNpemUsXG4gICAgICAgIGlzUm9vdCxcbiAgICAgICAgcm90YXRpb246IG5vZGUucm90YXRpb24sXG4gICAgICAgIHdvcmxkUm90YXRpb24sXG4gICAgICAgIG9wYWNpdHk6IGZvbGRTb3VyY2UgJiYgZnVsbEZvbGRcbiAgICAgICAgICAgID8gbm9kZS5vcGFjaXR5ICogZm9sZFNvdXJjZS5vcGFjaXR5XG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50LFxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcbiAgICAgICAgZmlsbHM6IHRleHRTb3VyY2UuZmlsbHMsXG4gICAgICAgIHN0cm9rZXM6IHRleHRTb3VyY2Uuc3Ryb2tlcyxcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcbiAgICAgICAgY2hhcmFjdGVyczogdGV4dFNvdXJjZS5jaGFyYWN0ZXJzLFxuICAgICAgICB0ZXh0U3R5bGU6IHRleHRTb3VyY2Uuc3R5bGUsXG4gICAgICAgIGxheW91dDoge1xuICAgICAgICAgICAgbW9kZTogZWZmZWN0aXZlS2luZCA9PT0gJ2xheW91dCcgfHwgZWZmZWN0aXZlS2luZCA9PT0gJ3Njcm9sbFZpZXcnXG4gICAgICAgICAgICAgICAgPyBpbmZlcnJlZExheW91dE1vZGUobm9kZSlcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHNvdXJjZU1vZGU6IG5vZGUubGF5b3V0TW9kZSxcbiAgICAgICAgICAgIHdyYXA6IG5vZGUubGF5b3V0V3JhcCxcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXG4gICAgICAgICAgICBjb3VudGVyQWxpZ246IG5vZGUuY291bnRlckF4aXNBbGlnbkl0ZW1zLFxuICAgICAgICAgICAgcHJpbWFyeVNpemluZzogbm9kZS5wcmltYXJ5QXhpc1NpemluZ01vZGUsXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcbiAgICAgICAgICAgIGl0ZW1TcGFjaW5nOiBub2RlLml0ZW1TcGFjaW5nLFxuICAgICAgICAgICAgY291bnRlclNwYWNpbmc6IG5vZGUuY291bnRlckF4aXNTcGFjaW5nLFxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXG4gICAgICAgICAgICBwYWRkaW5nUmlnaHQ6IG5vZGUucGFkZGluZ1JpZ2h0LFxuICAgICAgICAgICAgcGFkZGluZ1RvcDogbm9kZS5wYWRkaW5nVG9wLFxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxuICAgICAgICB9LFxuICAgICAgICBvdmVyZmxvd0RpcmVjdGlvbjogbm9kZS5vdmVyZmxvd0RpcmVjdGlvbixcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXG4gICAgICAgIHJlbGF0aXZlVHJhbnNmb3JtOiBub2RlLnJlbGF0aXZlVHJhbnNmb3JtLFxuICAgICAgICBzcHJpdGU6IHNwcml0ZUFzc2V0LFxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMsXG4gICAgICAgIGZsYXR0ZW5Cb3VuZGFyeTogYml0bWFwVGVybWluYWwgfHwgZnVsbEZvbGRcbiAgICAgICAgICAgID8gdHJ1ZVxuICAgICAgICAgICAgOiBmb2xkPy5raW5kID09PSAnYmFja2dyb3VuZCdcbiAgICAgICAgICAgICAgICA/IGZhbHNlXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIHBsYW5SZWFzb246IHBsYW4/LnJlYXNvbixcbiAgICAgICAgc3luY01hcmtlcixcbiAgICAgICAgY2hpbGRyZW46IHRlcm1pbmFsXG4gICAgICAgICAgICA/IFtdXG4gICAgICAgICAgICA6IG5vZGUuY2hpbGRyZW5cbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCkgPT4gIWFic29yYmVkRGlyZWN0SWRzLmhhcyhjaGlsZC5pZCkpXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxuICAgICAgICAgICAgICAgICAgICBjaGlsZCxcbiAgICAgICAgICAgICAgICAgICAgZnJhbWUsXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXG4gICAgICAgICAgICAgICAgICAgIG5vZGVCeUlkLFxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgd29ybGRSb3RhdGlvbixcbiAgICAgICAgICAgICAgICAgICAgc3luYyxcbiAgICAgICAgICAgICAgICApKVxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKTogY2hpbGQgaXMgU2NlbmVOb2RlU3BlYyA9PiBjaGlsZCAhPT0gbnVsbCksXG4gICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZU1hcHMoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+Pj4ge1xuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xuICAgIHJldHVybiBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnID8gc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4gOiB7fTtcbn1cblxuZnVuY3Rpb24gY29jb3NGaWxlSWQoKTogc3RyaW5nIHtcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBFZGl0b3IuVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXG4gICAgICAgID8gZ2VuZXJhdGVkXG4gICAgICAgIDogcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjQnKS5yZXBsYWNlKC89KyQvZywgJycpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYkFzc2V0KHVybE9yVXVpZDogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8gfCBudWxsPiB7XG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXG4gICAgICAgICdhc3NldC1kYicsXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcbiAgICAgICAgdXJsT3JVdWlkLFxuICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gYXNzZXJ0UHJlZmFiQXNzZXQoXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXG4pOiB2b2lkIHtcbiAgICBpZiAoaW5mby5pbnZhbGlkIHx8IGluZm8uaW1wb3J0ZWQgIT09IHRydWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcbiAgICB9XG4gICAgaWYgKGluZm8uaW1wb3J0ZXIgIT09ICdwcmVmYWInIHx8IGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicgfHwgaW5mby5pc0RpcmVjdG9yeSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xuICAgIH1cbiAgICBpZiAoaW5mby5yZWFkb25seSB8fCBpbmZvLnJlZGlyZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xuICAgIH1cbiAgICBpZiAoZXhwZWN0ZWQudXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkLnV1aWQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xuICAgIH1cbiAgICBpZiAoZXhwZWN0ZWQudXJsICYmIGluZm8udXJsICE9PSBleHBlY3RlZC51cmwpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclByZWZhYkFzc2V0KHVybDogc3RyaW5nLCBleHBlY3RlZFV1aWQ/OiBzdHJpbmcpOiBQcm9taXNlPFByZWZhYkFzc2V0SW5mbz4ge1xuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGluZm8/LmltcG9ydGVkID09PSB0cnVlKSB7XG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDlnKjlr7zlhaXmnJ/pl7Tlj5HnlJ/lj5jljJbvvJoke3VybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XG4gICAgICAgICAgICByZXR1cm4gaW5mbztcbiAgICAgICAgfVxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3MgUHJlZmFiIOi1hOa6kOWwsee7qui2heaXtu+8miR7dXJsfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYk1ldGEodXVpZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxuICAgICAgICAnYXNzZXQtZGInLFxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXG4gICAgICAgIHV1aWQsXG4gICAgKTtcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xuICAgIH1cbiAgICBjb25zdCB2YWx1ZSA9IG1ldGEgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgTWV0YSDkuI7nm67moIfotYTmupDkuI3ljLnphY3vvJoke3V1aWR9YCk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVJMIOaXoOaViO+8miR7dXJsfWApO1xuICAgIH1cbiAgICByZXR1cm4gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCB1cmwuc2xpY2UoJ2RiOi8vJy5sZW5ndGgpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclN5bmNNYXJrZXJTY3JpcHQodXJsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmwpIGFzIHtcbiAgICAgICAgICAgIHV1aWQ/OiBzdHJpbmc7XG4gICAgICAgIH0gfCBudWxsO1xuICAgICAgICBpZiAodHlwZW9mIGluZm8/LnV1aWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEwMCkpO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoYOetieW+hSBDb2NvcyDlr7zlhaXnu4Tku7blkIzmraXmoIforrDohJrmnKzotoXml7bvvJoke3VybH1gKTtcbn1cblxuLyoqXG4gKiDnu4Tku7blkIzmraXpnIDopoHlnKjpobnnm67ph4zmnInkuIDkuKrmnoHlsI/nmoTmoIforrDnu4Tku7bohJrmnKzjgILpppbmrKHlr7zlhaXml7bnlJ/miJDvvIxcbiAqIOS5i+WQjuavj+asoeWvvOWFpeagoemqjO+8m+iiq+WFtuS7luiEmuacrOWNoOeUqOaXtiBmYWlsLWNsb3NlZO+8jOiiq+aIquaWreaIluaUueaXp+aXtumHjeW7uuOAglxuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVTeW5jTWFya2VyU2NyaXB0KCk6IFByb21pc2U8eyBhY3Rpb246IHN0cmluZzsgcmVhc29uPzogc3RyaW5nIH0+IHtcbiAgICBjb25zdCB1cmwgPSBTWU5DX01BUktFUl9TQ1JJUFRfVVJMO1xuICAgIGxldCBleGlzdGluZzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aCh1cmwpLCAndXRmOCcpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgICBleGlzdGluZyA9IG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHBsYW4gPSBwbGFuU3luY01hcmtlclNjcmlwdChleGlzdGluZyk7XG4gICAgaWYgKHBsYW4uYWN0aW9uID09PSAncmVqZWN0Jykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocGxhbi5yZWFzb24pO1xuICAgIH1cbiAgICBpZiAocGxhbi5hY3Rpb24gPT09ICdrZWVwJykge1xuICAgICAgICBhd2FpdCB3YWl0Rm9yU3luY01hcmtlclNjcmlwdCh1cmwpO1xuICAgICAgICByZXR1cm4geyBhY3Rpb246ICdrZWVwJyB9O1xuICAgIH1cbiAgICBjb25zdCBpbmZvID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtaW5mbycsIHVybCkgYXMge1xuICAgICAgICB1dWlkPzogc3RyaW5nO1xuICAgIH0gfCBudWxsO1xuICAgIGlmICghaW5mbykge1xuICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnY3JlYXRlLWFzc2V0JywgdXJsLCBwbGFuLmNvbnRlbnQsIHtcbiAgICAgICAgICAgIG92ZXJ3cml0ZTogZmFsc2UsXG4gICAgICAgICAgICByZW5hbWU6IGZhbHNlLFxuICAgICAgICB9KSBhcyB7IHV1aWQ/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7rnu4Tku7blkIzmraXmoIforrDohJrmnKzvvJoke3VybH1gKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3NhdmUtYXNzZXQnLCB1cmwsIHBsYW4uY29udGVudCk7XG4gICAgfVxuICAgIGF3YWl0IHdhaXRGb3JTeW5jTWFya2VyU2NyaXB0KHVybCk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBwbGFuLmFjdGlvbixcbiAgICAgICAgcmVhc29uOiBwbGFuLmFjdGlvbiA9PT0gJ3Jld3JpdGUnID8gcGxhbi5yZWFzb24gOiB1bmRlZmluZWQsXG4gICAgfTtcbn1cblxuZnVuY3Rpb24gY29sbGVjdFN5bmNNYXJrZXJTcGVjcyhzcGVjczogcmVhZG9ubHkgU2NlbmVOb2RlU3BlY1tdKTogU3luY01hcmtlclNwZWNbXSB7XG4gICAgY29uc3QgbWFya2VyczogU3luY01hcmtlclNwZWNbXSA9IFtdO1xuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGVzOiByZWFkb25seSBTY2VuZU5vZGVTcGVjW10pID0+IHtcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgICAgICAgICBpZiAobm9kZS5zeW5jTWFya2VyKSB7XG4gICAgICAgICAgICAgICAgbWFya2Vycy5wdXNoKG5vZGUuc3luY01hcmtlcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2aXNpdChub2RlLmNoaWxkcmVuKTtcbiAgICAgICAgfVxuICAgIH07XG4gICAgdmlzaXQoc3BlY3MpO1xuICAgIHJldHVybiBtYXJrZXJzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0cnkge1xuICAgICAgICByZXR1cm4gcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZChcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXG4gICAgICAgICAgICByZWNvcmQsXG4gICAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPcGVuZWRQcmVmYWIoXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nLFxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnREaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcbiAgICBpZiAoY3VycmVudERpcnR5KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcbiAgICB9XG4gICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xuICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ29wZW4tYXNzZXQnLCBwcmVmYWJVdWlkKTtcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcbiAgICAgICAgICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcbiAgICAgICAgICAgIGlmIChzdGF0ZS5yZWFkeSkge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBzdGF0ZS5yZWFzb24gPz8gbGFzdFJlYXNvbjtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihg5omT5byA55uu5qCHIFByZWZhYiDotoXml7bvvJoke2xhc3RSZWFzb259YCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFzc2VydE9wZW5lZFByZWZhYihwcmVmYWJVdWlkOiBzdHJpbmcsIHJvb3RGaWxlSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcbiAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XG4gICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yU2NlbmVTYXZlZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcbiAgICAgICAgY29uc3QgZGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XG4gICAgICAgIGlmICghZGlydHkpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcign562J5b6FIFByZWZhYiDkv53lrZjlrozmiJDotoXml7bjgIInKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0UHJlZmFiQmluZGluZ3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXG4gICAgICAgICdwcm9qZWN0JyxcbiAgICApO1xuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHByZWZhYlV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcbiAgICAgICAgICAgIHx8IHR5cGVvZiBwcmVmYWJVdWlkICE9PSAnc3RyaW5nJ1xuICAgICAgICAgICAgfHwgIXByZWZhYlV1aWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xuICAgICAgICB9XG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nLCBwcmVmYWJVdWlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcbiAgICAgICAgYmluZGluZ3MsXG4gICAgICAgICdwcm9qZWN0JyxcbiAgICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcbiAgICBpZiAoIWJpbmRpbmdzW3NvdXJjZUhhc2hdKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZGVsZXRlIGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcbiAgICAgICAgYmluZGluZ3MsXG4gICAgICAgICdwcm9qZWN0JyxcbiAgICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB7XG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcbn0+PiB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXG4gICAgICAgICdwcm9qZWN0JyxcbiAgICApO1xuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xuICAgICAgICByZXR1cm4ge307XG4gICAgfVxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiA9IHt9O1xuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxuICAgICAgICAgICAgfHwgIXJhd1xuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcbiAgICAgICAgICAgIHx8IHR5cGVvZiAocmF3IGFzIHsgcHJlZmFiVXVpZD86IHVua25vd24gfSkucHJlZmFiVXVpZCAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKHtcbiAgICAgICAgICAgIHVzZXJEYXRhOiB7XG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXmnaXmupDkuI3kuIDoh7TvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcbiAgICAgICAgfVxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XG4gICAgICAgICAgICBwcmVmYWJVdWlkOiAocmF3IGFzIHsgcHJlZmFiVXVpZDogc3RyaW5nIH0pLnByZWZhYlV1aWQsXG4gICAgICAgICAgICByZWNvcmQsXG4gICAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFBlbmRpbmdQcmVmYWJTeW5jKFxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcbiAgICB2YWx1ZTogeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9IHwgbnVsbCxcbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcbiAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgcGVuZGluZ1tzb3VyY2VIYXNoXSA9IHZhbHVlO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGRlbGV0ZSBwZW5kaW5nW3NvdXJjZUhhc2hdO1xuICAgIH1cbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXG4gICAgICAgIHBlbmRpbmcsXG4gICAgICAgICdwcm9qZWN0JyxcbiAgICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiB2ZXJpZmllZFByZWZhYlJlY29yZChcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IG1ldGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4ge1xuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XG4gICAgbGV0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xuICAgIGlmICghcmVjb3JkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBQcmVmYWIg57y65bCRIEZpZ21hIOadpea6kOiusOW9le+8jOaXoOazleehruiupOaYr+WQpuWPr+WuieWFqOimhueblu+8miR7aW5mby51cmx944CC6K+35YWI56e75Yqo5oiW6YeN5ZG95ZCN6K+l6LWE5rqQ44CCYCxcbiAgICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOadpeiHquWPpuS4gOS4qiBGaWdtYSBGcmFtZe+8jOW3suaLkue7neimhueblu+8miR7aW5mby51cmx9YCk7XG4gICAgfVxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xuICAgIGlmIChwZW5kaW5nKSB7XG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ajgOa1i+WIsOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie055qE5b6F5oGi5aSN5ZCM5q2l6K6w5b2V77yM5bey5YGc5q2i5a+85YWl44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCBwZW5kaW5nLnJlY29yZCksIG51bGwsIDIpLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcbiAgICAgICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xuICAgICAgICAgICAgaWYgKCFyZWNvdmVyZWQgfHwgSlNPTi5zdHJpbmdpZnkocmVjb3ZlcmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocGVuZGluZy5yZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZWNvcmQgPSByZWNvdmVyZWQ7XG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25LiO5b2T5YmN5Y+K5b6F5oGi5aSN55qE5ZCM5q2l6K6w5b2V6YO95LiN5LiA6Ie077yM5bey5YGc5q2i6Ieq5Yqo5oGi5aSN44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XG4gICAgfVxuICAgIHJldHVybiB7IG1ldGEsIHJlY29yZCB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKFxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8IDM7IGF0dGVtcHQgKz0gMSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5YaZ5YWl5YmNIFByZWZhYiDmnaXmupDorrDlvZXkuI3kuIDoh7TjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHJlY29yZCksIG51bGwsIDIpLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlhpnlhaXlkI7moKHpqozkuI3kuIDoh7TjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDE1MCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIHRocm93IGxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbGFzdEVycm9yIDogbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5aSx6LSl44CCJyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmcsXG4gICAgcm9vdEZyYW1lOiBSZWN0LFxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcbiAgICBzb3VyY2VSb290SWQ6IHN0cmluZyxcbik6IFByb21pc2U8e1xuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XG59PiB7XG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xuICAgIGNvbnN0IGJvdW5kVXVpZCA9IGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xuICAgICAgICA/IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocGVuZGluZy5wcmVmYWJVdWlkKVxuICAgICAgICA6IG51bGw7XG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcbiAgICAgICAgcGVuZGluZz8ucHJlZmFiVXVpZCxcbiAgICAgICAgYm91bmRVdWlkLFxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcbiAgICApO1xuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyUGVuZGluZykge1xuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcbiAgICB9XG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJCaW5kaW5nKSB7XG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XG4gICAgfVxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSB0YXJnZXRQbGFuLnRhcmdldFV1aWQ7XG4gICAgaWYgKHRhcmdldFV1aWQpIHtcbiAgICAgICAgbGV0IHRhcmdldEluZm8gPSBwZW5kaW5nSW5mbz8udXVpZCA9PT0gdGFyZ2V0VXVpZFxuICAgICAgICAgICAgPyBwZW5kaW5nSW5mb1xuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xuICAgICAgICBpZiAoIXRhcmdldEluZm8pIHtcbiAgICAgICAgICAgIGlmIChiaW5kaW5nc1tzb3VyY2VIYXNoXSA9PT0gdGFyZ2V0VXVpZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcbiAgICAgICAgICAgIGlmIChwZW5kaW5nPy5wcmVmYWJVdWlkID09PSB0YXJnZXRVdWlkICYmIGJvdW5kVXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xuICAgICAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIHJlY292ZXJ5IGlkZW50aXR5IGJlZm9yZSB2ZXJpZmllZFByZWZhYlJlY29yZCBtYXlcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcbiAgICAgICAgICAgICAgICAvLyBhYmxlIHRvIGxvY2F0ZSB0aGUgZXhhY3QgUHJlZmFiIGJ5IFVVSUQgb24gdGhlIG5leHQgYXR0ZW1wdC5cbiAgICAgICAgICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIHRhcmdldFV1aWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZCh0YXJnZXRJbmZvLCBzb3VyY2VIYXNoKTtcbiAgICAgICAgICAgIGlmICh0YXJnZXRJbmZvLnVybCAhPT0gcHJlZmFiVXJsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XG4gICAgICAgICAgICAgICAgaWYgKGNvbmZsaWN0ICYmIGNvbmZsaWN0LnV1aWQgIT09IHRhcmdldFV1aWQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW92ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxuICAgICAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8udXJsLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXG4gICAgICAgICAgICAgICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3ZlZCB8fCBtb3ZlZC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgaW5mbzogdGFyZ2V0SW5mbyxcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcbiAgICBpZiAoIWluZm8pIHtcbiAgICAgICAgY29uc3Qgcm9vdEZpbGVJZCA9IGNvY29zRmlsZUlkKCk7XG4gICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm1GaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXG4gICAgICAgICAgICBwcmVmYWJOYW1lLFxuICAgICAgICAgICAgcm9vdEZyYW1lLFxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxuICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcbiAgICAgICAgICAgICdjcmVhdGUtYXNzZXQnLFxuICAgICAgICAgICAgcHJlZmFiVXJsLFxuICAgICAgICAgICAgc2VlZCxcbiAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XG4gICAgICAgIGlmICghY3JlYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7ogUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGNyZWF0ZWQudXVpZCk7XG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcbiAgICAgICAgICAgIHNvdXJjZUhhc2gsXG4gICAgICAgICAgICBzb3VyY2VSb290SWQsXG4gICAgICAgICAgICByb290RmlsZUlkLFxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcbiAgICAgICAgICAgICdhc3NldC1kYicsXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcbiAgICAgICAgICAgIGluZm8udXVpZCxcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG5leHRNZXRhLCBudWxsLCAyKSxcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcbiAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaW5mbyxcbiAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxuICAgICAgICB9O1xuICAgIH1cbiAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcbiAgICByZXR1cm4ge1xuICAgICAgICBpbmZvLFxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcbiAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYihhcmdzOiB7XG4gICAgcmV2aWV3SWQ6IHN0cmluZztcbiAgICBwcmVmYWJVcmw6IHN0cmluZztcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmc7XG4gICAgZmlsZUtleTogc3RyaW5nO1xuICAgIHNvdXJjZU5vZGVJZDogc3RyaW5nO1xuICAgIHJvb3RGcmFtZTogUmVjdDtcbiAgICBzY2FsZTogbnVtYmVyO1xuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XG4gICAgLyoqIOacquWLvumAieeahOiKgueCue+8muS/neeVmeWug+S7rOWcqCBQcmVmYWIg6YeM55qE546w5pyJ6IqC54K577yM5LiN5Y+C5LiO5pys5qyh5riF55CG44CCICovXG4gICAgc2tpcFN5bmNOb2RlSWRzPzogUmVhZG9ubHlTZXQ8c3RyaW5nPjtcbn0pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XG4gICAgY29uc3Qgc291cmNlSGFzaCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKGFyZ3MuZmlsZUtleSwgYXJncy5zb3VyY2VOb2RlSWQpO1xuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxuICAgICAgICBhcmdzLnByZWZhYlVybCxcbiAgICAgICAgYXJncy5wcmVmYWJOYW1lLFxuICAgICAgICB7XG4gICAgICAgICAgICB4OiBhcmdzLnJvb3RGcmFtZS54ICogYXJncy5zY2FsZSxcbiAgICAgICAgICAgIHk6IGFyZ3Mucm9vdEZyYW1lLnkgKiBhcmdzLnNjYWxlLFxuICAgICAgICAgICAgd2lkdGg6IGFyZ3Mucm9vdEZyYW1lLndpZHRoICogYXJncy5zY2FsZSxcbiAgICAgICAgICAgIGhlaWdodDogYXJncy5yb290RnJhbWUuaGVpZ2h0ICogYXJncy5zY2FsZSxcbiAgICAgICAgfSxcbiAgICAgICAgc291cmNlSGFzaCxcbiAgICAgICAgYXJncy5yb290c1swXS5maWdtYUlkLFxuICAgICk7XG4gICAgYXdhaXQgd2FpdEZvck9wZW5lZFByZWZhYihcbiAgICAgICAgcHJlcGFyZWQuaW5mby51cmwsXG4gICAgICAgIHByZXBhcmVkLmluZm8udXVpZCxcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXG4gICAgKTtcbiAgICBjb25zdCBleGlzdGluZ05vZGVGaWxlSWRzID0gcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMoXG4gICAgICAgIHByZXBhcmVkLnJlY29yZCxcbiAgICAgICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKGFyZ3Mucm9vdHMpLFxuICAgICk7XG4gICAgLy8g5pyq5Yu+6YCJ55qE6IqC54K55Zyo5pys5qyh6K6h5YiS6YeM5LiN5a2Y5Zyo77yM5L2G5a6D5Lus5LuN5bGe5LqO5Y+X566h6IqC54K577ya5oqK5bey55+lIGZpbGVJZCDkvKDnu5lcbiAgICAvLyBTY2VuZSDkvZzkuLrkv53nlZnpm4blkIjvvIzpgb/lhY1cIuWIoOmZpFwi5YiG5pSv5oqK5a6D5Lus5riF5o6J44CCXG4gICAgY29uc3QgcmV0YWluTm9kZUZpbGVJZHMgPSBhcmdzLnNraXBTeW5jTm9kZUlkcz8uc2l6ZVxuICAgICAgICA/IE9iamVjdC52YWx1ZXMocmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMocHJlcGFyZWQucmVjb3JkLCBhcmdzLnNraXBTeW5jTm9kZUlkcykpXG4gICAgICAgIDogW107XG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xuICAgICAgICByZXZpZXdJZDogYXJncy5yZXZpZXdJZCxcbiAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcbiAgICAgICAgcm9vdE5hbWU6IGFyZ3MucHJlZmFiTmFtZSxcbiAgICAgICAgcm9vdEZyYW1lOiBhcmdzLnJvb3RGcmFtZSxcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxuICAgICAgICBleGlzdGluZ01hcDoge30sXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXG4gICAgICAgIHJldGFpbk5vZGVGaWxlSWRzLFxuICAgICAgICByb290czogYXJncy5yb290cyxcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxuICAgICAgICAgICAgcm9vdEZpbGVJZDogcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxuICAgICAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZE5vZGVGaWxlSWRzLFxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXG4gICAgICAgIH0sXG4gICAgfTtcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XG4gICAgbGV0IHNhdmVBdHRlbXB0ZWQgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcbiAgICAgICAgaWYgKGRpcnR5QmVmb3JlSW1wb3J0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ebruaghyBQcmVmYWIg5pyJ5pyq5L+d5a2Y55qE5omL5bel5L+u5pS577yM6K+35YWI5L+d5a2Y5ZCO5YaN5omn6KGMIEZpZ21hIOWinumHj+WvvOWFpeOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XG4gICAgICAgIHNuYXBzaG90U3RhcnRlZCA9IHRydWU7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XG4gICAgICAgIGlmICghcmVzdWx0LnByZWZhYlN5bmMpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbmV4dFJlY29yZCA9IHJlY29yZFByZWZhYlN5bmNDYXB0dXJlKHByZXBhcmVkLnJlY29yZCwgcmVzdWx0LnByZWZhYlN5bmMpO1xuICAgICAgICAvLyDmnKrli77pgInnmoToioLngrnkuI3lnKjmnKzmrKHph43lu7rnu5Pmnpzph4zvvIzkv53nlZnlroPku6zljp/mnInnmoQgZmlsZUlkIOaYoOWwhOOAglxuICAgICAgICBjb25zdCByZXRhaW5lZFJlY29yZCA9IGFyZ3Muc2tpcFN5bmNOb2RlSWRzPy5zaXplXG4gICAgICAgICAgICA/IHJldGFpblByZWZhYlN5bmNFbnRyaWVzKHByZXBhcmVkLnJlY29yZCwgbmV4dFJlY29yZCwgYXJncy5za2lwU3luY05vZGVJZHMpXG4gICAgICAgICAgICA6IG5leHRSZWNvcmQ7XG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIHtcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcbiAgICAgICAgICAgIHJlY29yZDogcmV0YWluZWRSZWNvcmQsXG4gICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhc3NlcnRPcGVuZWRQcmVmYWIocHJlcGFyZWQuaW5mby51dWlkLCBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCk7XG4gICAgICAgIC8vIE9uY2UgdGhlIHNhdmUgcmVxdWVzdCBpcyBzZW50IGl0cyByZXN1bHQgaXMgYW1iaWd1b3VzIHVudGlsIHRoZVxuICAgICAgICAvLyBwZXJzaXN0ZWQgUHJlZmFiIGlzIHZlcmlmaWVkLiBEbyBub3Qgcm9sbCB0aGUgaW4tbWVtb3J5IFByZWZhYiBiYWNrXG4gICAgICAgIC8vIG9uIGFuIElQQyB0aW1lb3V0OiB0aGUgZGlzayB3cml0ZSBtYXkgYWxyZWFkeSBoYXZlIGNvbXBsZXRlZC5cbiAgICAgICAgc2F2ZUF0dGVtcHRlZCA9IHRydWU7XG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgYXdhaXQgd2FpdEZvclNjZW5lU2F2ZWQoKTtcbiAgICAgICAgY29uc3QgY3VycmVudEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwsIHByZXBhcmVkLmluZm8udXVpZCk7XG4gICAgICAgIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChjdXJyZW50SW5mbywgcmV0YWluZWRSZWNvcmQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bmnKrljIXlkKvmnKzmrKHlkIzmraXnlJ/miJDnmoTlhajpg6ggZmlsZUlk77yM5bey5YGc5q2i5pu05pawIE1ldGHjgIInKTtcbiAgICAgICAgfVxuICAgICAgICAvLyDmnKrli77pgInoioLngrnnmoTnu4Tku7bvvIhVSVRyYW5zZm9ybeOAgeagh+iusOetie+8ieS7jeWxnuaPkuS7tuaJgOacie+8muS7juS/neWtmOWQjueahFxuICAgICAgICAvLyBQcmVmYWIg6YeM6K+75Zue5a6D5Lus55qEIGZpbGVJZCDlubblkIjlubbov5vorrDlvZXvvIzlkKbliJnkuIvmrKHph43mlrDli77pgInkvJrooqvlvZLlsZ7moKHpqozmi6bkuIvjgIJcbiAgICAgICAgbGV0IGZpbmFsUmVjb3JkID0gcmV0YWluZWRSZWNvcmQ7XG4gICAgICAgIGlmIChhcmdzLnNraXBTeW5jTm9kZUlkcz8uc2l6ZSkge1xuICAgICAgICAgICAgY29uc3Qgc2tpcHBlZEZpbGVJZHMgPSBPYmplY3QudmFsdWVzKFxuICAgICAgICAgICAgICAgIHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKHByZXBhcmVkLnJlY29yZCwgYXJncy5za2lwU3luY05vZGVJZHMpLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChza2lwcGVkRmlsZUlkcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBleHRyYXMgPSBjb2xsZWN0UHJlZmFiQ29tcG9uZW50RmlsZUlkcyhcbiAgICAgICAgICAgICAgICAgICAgYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgoY3VycmVudEluZm8udXJsKSksXG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWRGaWxlSWRzLFxuICAgICAgICAgICAgICAgICkuZmlsdGVyKChmaWxlSWQpID0+ICFyZXRhaW5lZFJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcy5pbmNsdWRlcyhmaWxlSWQpKTtcbiAgICAgICAgICAgICAgICBpZiAoZXh0cmFzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBmaW5hbFJlY29yZCA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLnJldGFpbmVkUmVjb3JkLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5yZXRhaW5lZFJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5leHRyYXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBdLnNvcnQoKSxcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY3VycmVudE1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoY3VycmVudEluZm8udXVpZCk7XG4gICAgICAgIGNvbnN0IGN1cnJlbnRSZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChjdXJyZW50TWV0YSk7XG4gICAgICAgIGlmICghY3VycmVudFJlY29yZCB8fCBjdXJyZW50UmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWcqOS/neWtmOacn+mXtOWPkeeUn+WPmOWMlu+8jOW3suaLkue7neaPkOS6pOOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIHsgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLCByZWNvcmQ6IGZpbmFsUmVjb3JkIH0pO1xuICAgICAgICBhd2FpdCB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKGN1cnJlbnRJbmZvLCBzb3VyY2VIYXNoLCBmaW5hbFJlY29yZCk7XG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwpO1xuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjiBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xuICAgICAgICAgICAgdXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxuICAgICAgICAgICAgdXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcbiAgICAgICAgfSk7XG4gICAgICAgIHJlc3VsdC5wcmVmYWJVcmwgPSBwcmVwYXJlZC5pbmZvLnVybDtcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcbiAgICAgICAgICAgIHRyeSB7IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90LWFib3J0Jyk7IH1cbiAgICAgICAgICAgIGNhdGNoIHtcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgKGVycm9yIGFzIEVycm9yICYgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSkucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChzYXZlQXR0ZW1wdGVkICYmIGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIChlcnJvciBhcyBFcnJvciAmIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pLnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxufVxuXG4vKipcbiAqIOe7hOS7tuWQjOatpemihOajgO+8muWPquivu+ebruaghyBQcmVmYWIg5LiO5b2T5YmNIEZpZ21hIOiuoeWIkuOAglxuICog5LiN5LiL6L295Zu+54mH44CB5LiN5omT5byAIFByZWZhYuOAgeS4jeWGmeWFpeS7u+S9leaWh+S7tu+8jOWPr+WcqOeUqOaIt+eCueWHu+WvvOWFpeWJjeWPjeWkjeiwg+eUqOOAglxuICovXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3Q29tcG9uZW50U3luYygpOiBQcm9taXNlPFN5bmNQcmV2aWV3UmVzdWx0PiB7XG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcbiAgICBpZiAoIWRvY3VtZW50KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xuICAgIH1cbiAgICBpZiAoIWRvY3VtZW50LnNvdXJjZU5vZGVJZCB8fCBkb2N1bWVudC5yb290cy5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflj6rmnInljZXkuKroioLngrnpk77mjqXmiY3og73pooTop4jnu4Tku7blkIzmraXjgIInKTtcbiAgICB9XG4gICAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LnJvb3RzWzBdO1xuICAgIGNvbnN0IHNldHRpbmdzID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgICAvLyBBc3NldFdyaXRlciDmnoTpgKDlh73mlbDlj6rop4TojIPljJbnm67lvZXvvIzkuI3kvJrliJvlu7rmlofku7blpLnjgIJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcbiAgICBjb25zdCBwcmVmYWJVcmwgPSBgZGI6Ly9hc3NldHMvJHt3cml0ZXIuZm9sZGVyfS8ke3Nhbml0aXplQXNzZXROYW1lKHJvb3QubmFtZSl9LnByZWZhYmA7XG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcbiAgICBpZiAoIWluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgdGFyZ2V0VXJsOiBwcmVmYWJVcmwsIGV4aXN0czogZmFsc2UsIC4uLmVtcHR5U3luY1ByZXZpZXdTdW1tYXJ5KCkgfTtcbiAgICB9XG4gICAgY29uc3QgcHJldmlvdXMgPSByZWFkUHJlZmFiU3luY01hcmtlcnMoYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgocHJlZmFiVXJsKSkpO1xuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSk7XG4gICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAob3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcbiAgICAvLyDkuI7nnJ/lrp7lr7zlhaXkv53mjIHkuIDoh7TnmoTnrKzkuIDmraXvvJrmnKzlnLDlkIzlkI3ntKDmnZDlkb3kuK3ml7bmiorniLblrrnlmajmlbTkvZPmj5DljYfkuLrmlbTlsYLjgIJcbiAgICBjb25zdCBsb2NhbExpYnJhcmllcyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4ge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KGZvbGRlcik7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgLmZpbHRlcigobGlicmFyeSk6IGxpYnJhcnkgaXMgTG9jYWxSZXNvdXJjZUxpYnJhcnkgPT4gbGlicmFyeSAhPT0gbnVsbCk7XG4gICAgaWYgKGxvY2FsTGlicmFyaWVzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbExpYnJhcmllcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XG4gICAgICAgIGNvbnN0IHByb3RlY3RlZFByZXZpZXcgPSAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiA9PiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjaGlsZERlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKGNoaWxkLCBkZWNpc2lvbnMpO1xuICAgICAgICAgICAgaWYgKGNoaWxkRGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIEJvb2xlYW4oY2hpbGQuaXNNYXNrIHx8IGNoaWxkLmNoaWxkcmVuLnNvbWUoKHBhcnQpID0+IHBhcnQuaXNNYXNrKVxuICAgICAgICAgICAgICAgIHx8IGNoaWxkRGVjaXNpb24ubmluZVNsaWNlIHx8IGlzTmFtZWRTbGljZUdyb3VwKGNoaWxkKSB8fCBpc1BhdGNoQ2FuZGlkYXRlKGNoaWxkKSlcbiAgICAgICAgICAgICAgICB8fCAoY2hpbGREZWNpc2lvbi5hY3Rpb24gIT09ICdyZW5kZXInICYmIHByb3RlY3RlZFByZXZpZXcoY2hpbGQpKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IGFwcGx5TG9jYWxQYXJlbnRQcm9tb3Rpb24oXG4gICAgICAgICAgICBkb2N1bWVudC5yb290cyxcbiAgICAgICAgICAgIGRlY2lzaW9ucyxcbiAgICAgICAgICAgIGFzeW5jIChub2RlKSA9PiB7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsTGlicmFyaWVzKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhd2FpdCBsaWJyYXJ5LmZpbmQobm9kZS5uYW1lLCAncG5nJykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBwcm90ZWN0ZWRQcmV2aWV3LFxuICAgICAgICApO1xuICAgIH1cbiAgICAvLyDkuI7nnJ/lrp7lr7zlhaXkv53mjIHkuIDoh7TnmoTnrKzkuozmraXvvJroh6rliqjmipjlj6Av5pS25Y+j5Yaz5a6a55Sf5pWI5ZCO5YaN57yW6K+R6K6h5YiS44CCXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XG4gICAgcmVzb2x2ZWQuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XG4gICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcbiAgICBjb25zdCByb290RnJhbWUgPSBub2RlRnJhbWUocm9vdCk7XG4gICAgY29uc3Qgc3BlY3MgPSBkb2N1bWVudC5yb290c1xuICAgICAgICAubWFwKChub2RlKSA9PiBtYWtlU3BlYyhcbiAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICByb290RnJhbWUsXG4gICAgICAgICAgICBkZWNpc2lvbnMsXG4gICAgICAgICAgICBwbGFucyxcbiAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxuICAgICAgICAgICAgbmV3IE1hcCgpLFxuICAgICAgICAgICAgbmV3IE1hcCgpLFxuICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgIDAsXG4gICAgICAgICAgICB7IGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXkgfSxcbiAgICAgICAgKSlcbiAgICAgICAgLmZpbHRlcigoc3BlYyk6IHNwZWMgaXMgU2NlbmVOb2RlU3BlYyA9PiBzcGVjICE9PSBudWxsKTtcbiAgICByZXR1cm4ge1xuICAgICAgICB0YXJnZXRVcmw6IHByZWZhYlVybCxcbiAgICAgICAgZXhpc3RzOiB0cnVlLFxuICAgICAgICBwcmVmYWJVdWlkOiBpbmZvLnV1aWQsXG4gICAgICAgIC4uLnBsYW5TeW5jUHJldmlldyhwcmV2aW91cywgc3BlY3MsIHsgc2NhbGU6IHNldHRpbmdzLnNjYWxlIH0pLFxuICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1JbXBvcnQocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsLCBvcHRpb25zOiB7XG4gICAgZG9jdW1lbnQ/OiBEb2N1bWVudFNlc3Npb247IHByZXNlcnZlUmV2aWV3cz86IGJvb2xlYW47IHNpbGVudFJldmlldz86IGJvb2xlYW47XG59ID0ge30pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XG4gICAgY29uc3QgZG9jdW1lbnQgPSBvcHRpb25zLmRvY3VtZW50ID8/IGFjdGl2ZURvY3VtZW50O1xuICAgIGlmICghZG9jdW1lbnQpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XG4gICAgfVxuICAgIGNvbnN0IGltcG9ydFNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbihvcGVyYXRpb25Pd25lcik7XG4gICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+WvvOWFpeS7u+WKoScsIHsgcm9vdHM6IGRvY3VtZW50LnJvb3RzLm1hcCgobm9kZSkgPT4gKHsgaWQ6IG5vZGUuaWQsIG5hbWU6IG5vZGUubmFtZSB9KSkgfSk7XG4gICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKGltcG9ydFNldHRpbmdzKTtcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+WIhuaekOW5tuWHhuWkh+i1hOa6kOKApicgfSk7XG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKHJlcXVlc3Qub3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcbiAgICAgICAgLy8g5pS55Yqo5riF5Y2V6YeM5pyq5Yu+6YCJ55qE6IqC54K577ya5pys5qyh5oyJXCLlv73nlaVcIuWkhOeQhu+8jOaXouS4jeabtOaWsOS5n+S4jeWIm+W7uu+8m+Wug+S7rOeahOaXp+agh+iusFxuICAgICAgICAvLyDkuI3kvJrooqvph43lhpnvvIzlm6DmraTkuIvmrKHlr7zlhaXku43kvJrkvZzkuLrlvoXmm7TmlrDpobnlh7rnjrDjgIJcbiAgICAgICAgY29uc3Qgc2tpcFN5bmNOb2RlSWRzID0gbmV3IFNldCgocmVxdWVzdC5za2lwU3luY05vZGVJZHMgPz8gW10pXG4gICAgICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIEJvb2xlYW4oaWQudHJpbSgpKSlcbiAgICAgICAgICAgIC5tYXAoKGlkKSA9PiBpZC50cmltKCkucmVwbGFjZSgvLS9nLCAnOicpKSk7XG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIHNraXBTeW5jTm9kZUlkcykge1xuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlSWQsIHtcbiAgICAgICAgICAgICAgICBhY3Rpb246ICdpZ25vcmUnLFxuICAgICAgICAgICAgICAgIGtpbmQ6ICdhdXRvJyxcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiB0cnVlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmV2aWV3RG9jdW1lbnQgPSBkb2N1bWVudDtcbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKG9wdGlvbnMucHJlc2VydmVSZXZpZXdzID8geyBwcmVzZXJ2ZUhpc3Rvcnk6IHRydWUgfSA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGNvbnN0IHJldmlld1JlY29yZGVyID0gbmV3IEltcG9ydFJldmlld1JlY29yZGVyKCk7XG4gICAgICAgIC8vIOe7hOS7tuWQjOatpe+8iOWNleiKgueCuSBDT01QT05FTlQvSU5TVEFOQ0Ug6ZO+5o6l77yJ77ya5YWI55So5YOP57Sg5oyH57q5566X5Ye65ZOq5Lqb6IqC54K555qEXG4gICAgICAgIC8vIOWbvueJh+WGheWuueehruWunuWPmOS6hu+8jOWPquaciei/meS6m+iKgueCueWcqOi1hOa6kOWHhuWkh+mYtuautei3s+i/h+acrOWcsOWQjOWQjee0oOadkOWkjeeUqOOAglxuICAgICAgICBjb25zdCBzeW5jTW9kZSA9IHN5bmNNYXJrZXJzRW5hYmxlZChkb2N1bWVudC5zb3VyY2VOb2RlSWQsIGRvY3VtZW50LnJvb3RzLmxlbmd0aCk7XG4gICAgICAgIGxldCByZWdlbmVyYXRlTm9kZUlkczogUmVhZG9ubHlTZXQ8c3RyaW5nPiB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHN5bmNNb2RlICYmIGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJlZmFiV3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLnByZWZhYkZvbGRlcik7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vYFxuICAgICAgICAgICAgICAgICAgICArIGAke3Nhbml0aXplQXNzZXROYW1lKGRvY3VtZW50LnJvb3RzWzBdLm5hbWUpfS5wcmVmYWJgO1xuICAgICAgICAgICAgICAgIGlmIChhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCkpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSByZWFkUHJlZmFiU3luY01hcmtlcnMoYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgocHJlZmFiVXJsKSkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMuc2l6ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhbGUgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJlZm9yZSA9IHByZXZpb3VzLmdldChub2RlLmlkLnJlcGxhY2UoLy0vZywgJzonKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZnJlc2ggPSBjcmVhdGVTeW5jTWFya2VyKHsgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgbm9kZSB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwaXhlbENvbXBhcmFibGUgPSB0eXBlb2YgYmVmb3JlPy5waXhlbEhhc2ggPT09ICdzdHJpbmcnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICYmIHR5cGVvZiBmcmVzaC5waXhlbEhhc2ggPT09ICdzdHJpbmcnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNoYW5nZWQgPSBiZWZvcmVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBwaXhlbENvbXBhcmFibGVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gYmVmb3JlLnBpeGVsSGFzaCAhPT0gZnJlc2gucGl4ZWxIYXNoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IGJlZm9yZS5zdWJ0cmVlSGFzaCAhPT0gZnJlc2guc3VidHJlZUhhc2hcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjaGFuZ2VkKSBzdGFsZS5hZGQobm9kZS5pZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5yb290cy5mb3JFYWNoKHZpc2l0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2VuZXJhdGVOb2RlSWRzID0gc3RhbGU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICAvLyDpooTmo4DlpLHotKXkuI3pmLvmlq3lr7zlhaXvvJrpgIDlm55cIuaJgOacieiKgueCuemDveaMieeOsOacieinhOWImeWkhOeQhlwi44CCXG4gICAgICAgICAgICAgICAgcmVnZW5lcmF0ZU5vZGVJZHMgPSB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYnVpbHRBc3NldHMgPSBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5YWo6YOo6LWE5rqQJywgdW5kZWZpbmVkLCAoKSA9PiBidWlsZEFzc2V0cyhcbiAgICAgICAgICAgIGRvY3VtZW50LFxuICAgICAgICAgICAgZGVjaXNpb25zLFxuICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3MsXG4gICAgICAgICAgICByZXZpZXdSZWNvcmRlcixcbiAgICAgICAgICAgIHsgcmVnZW5lcmF0ZU5vZGVJZHMgfSxcbiAgICAgICAgKSk7XG4gICAgICAgIGNvbnN0IHsgYXNzZXRzLCB3YXJuaW5ncyB9ID0gYnVpbHRBc3NldHM7XG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcbiAgICAgICAgY29uc3QgYXR0YWNoUmV2aWV3ID0gYXN5bmMgKHJlc3VsdDogU2NlbmVJbXBvcnRSZXN1bHQpID0+IHtcbiAgICAgICAgICAgIHJlc3VsdC5yZXZpZXcgPSBhd2FpdCBmaW5hbGl6ZUltcG9ydFJldmlldyhpbXBvcnRSZXZpZXdzLCByZXZpZXdSZWNvcmRlciwgcmV2aWV3RG9jdW1lbnQsXG4gICAgICAgICAgICAgICAgcmVzdWx0LnJldmlld0JlZm9yZSwgcmVzdWx0LnJldmlld0FmdGVyLCByZXN1bHQucHJlZmFiVXJsLCB3YXJuaW5ncyxcbiAgICAgICAgICAgICAgICBhc3luYyAoKSA9PiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSwgbWV0aG9kOiAncmVmcmVzaFJldmlld0FmdGVyJywgYXJnczogW3sgaWQ6IHJldmlld1JlY29yZGVyLmlkIH1dLFxuICAgICAgICAgICAgICAgIH0pIGFzIFJldmlld1NjZW5lKTtcbiAgICAgICAgICAgIC8vIEFsc28gY292ZXIgbWFudWFsIGltcG9ydHMgd2hvc2UgcGFuZWwgd2FzIGNsb3NlZCB3aGlsZSBpbXBvcnRpbmcuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zLnNpbGVudFJldmlldykge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0JlZm9yZTtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdBZnRlcjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcbiAgICAgICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdpbXBvcnQtcmV2aWV3LXJlYWR5JywgcmVzdWx0LnJldmlldyk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOe7k+aenOW3suS/neWtmO+8jOS9huiHquWKqOaJk+W8gOmdouadv+Wksei0pe+8jOivt+S7juaPkuS7tuS4reaJk+W8gOKAnOWvvOWFpee7k+aenOajgOafpeKAne+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xuICAgICAgICB9O1xuICAgICAgICAvLyBidWlsZEFzc2V0cyBtYXkgcHJvbW90ZSBhIGNvbnRhaW5lciB0byBhIGxvY2FsIHNhbWUtbmFtZSByZXNvdXJjZS5cbiAgICAgICAgLy8gQ29tcGlsZSBhZnRlciB0aGF0IHByb21vdGlvbiBzbyBhc3NldHMgYW5kIFNjZW5lTm9kZVNwZWMgc2hhcmUgdGhlXG4gICAgICAgIC8vIGV4YWN0IHNhbWUgZmluYWwgcGxhbi5cbiAgICAgICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcbiAgICAgICAgY29uc3QgZm9udHMgPSBhd2FpdCByZXNvbHZlRm9udHMoaW1wb3J0U2V0dGluZ3MpO1xuICAgICAgICBjb25zdCBzb3VyY2VSb290RnJhbWVzID0gZG9jdW1lbnQucm9vdHMubWFwKG5vZGVGcmFtZSk7XG4gICAgICAgIGNvbnN0IG11bHRpcGxlUm9vdHMgPSBkb2N1bWVudC5yb290cy5sZW5ndGggPiAxO1xuICAgICAgICBjb25zdCBhcnJhbmdlZFdpZHRoID0gbXVsdGlwbGVSb290c1xuICAgICAgICAgICAgPyBzb3VyY2VSb290RnJhbWVzLnJlZHVjZSgodG90YWwsIGZyYW1lKSA9PiB0b3RhbCArIGZyYW1lLndpZHRoLCAwKVxuICAgICAgICAgICAgICAgICsgTWF0aC5tYXgoMCwgc291cmNlUm9vdEZyYW1lcy5sZW5ndGggLSAxKSAqIDE2MFxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdPy53aWR0aCA/PyAwO1xuICAgICAgICBjb25zdCByb290RnJhbWUgPSBtdWx0aXBsZVJvb3RzXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICB4OiAwLFxuICAgICAgICAgICAgICAgIHk6IDAsXG4gICAgICAgICAgICAgICAgd2lkdGg6IGFycmFuZ2VkV2lkdGgsXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCgwLCAuLi5zb3VyY2VSb290RnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLmhlaWdodCkpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdID8/IHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xuICAgICAgICBsZXQgcm9vdEN1cnNvciA9IDA7XG4gICAgICAgIC8vIOe7hOS7tue6p+WQjOatpe+8muWPquacieWNleiKgueCuemTvuaOpeOAgeS4lOagueiKgueCueehruWunuaYr+e7hOS7tu+8iOaIluWunuS+i++8ieaXtuWQr+eUqOOAglxuICAgICAgICAvLyBGcmFtZSDpk77mjqXkv53mjIHljp/mnInooYzkuLrvvIzkuI3nlJ/miJDmoIforrDjgIHkuI3pop3lpJbliJvlu7rpobnnm67ohJrmnKzjgIJcbiAgICAgICAgY29uc3Qgc3luY0NvbnRleHQgPSBzeW5jTW9kZSA/IHsgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSB9IDogdW5kZWZpbmVkO1xuICAgICAgICBjb25zdCByb290cyA9IGRvY3VtZW50LnJvb3RzXG4gICAgICAgICAgICAubWFwKChub2RlLCBpbmRleCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNwZWMgPSBtYWtlU3BlYyhcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5ub2RlQnlJZCxcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxuICAgICAgICAgICAgICAgICAgICBmb250cyxcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgMCxcbiAgICAgICAgICAgICAgICAgICAgc3luY0NvbnRleHQsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNwZWMuZnJhbWUgPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB4OiByb290Q3Vyc29yLFxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0uaGVpZ2h0LFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICByb290Q3Vyc29yICs9IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoICsgMTYwO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuZmlsdGVyKChub2RlKTogbm9kZSBpcyBTY2VuZU5vZGVTcGVjID0+IG5vZGUgIT09IG51bGwpO1xuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInpgInkuK3ku7vkvZXlj6/lr7zlhaXoioLngrnjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3luY0NvbnRleHQpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0VW5pcXVlU3luY093bmVyc2hpcChjb2xsZWN0U3luY01hcmtlclNwZWNzKHJvb3RzKSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5ZCM5q2l5qCH6K6w5omA5pyJ5p2D5qCh6aqM5aSx6LSl44CCJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzb3VyY2VOb2RlSWQgPSBkb2N1bWVudC5zb3VyY2VOb2RlSWQ7XG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICBjb25zdCBwcmVmYWJXcml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcbiAgICAgICAgICAgIGF3YWl0IHByZWZhYldyaXRlci5pbml0aWFsaXplKCk7XG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQucm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxuICAgICAgICAgICAgICAgIHx8IGRvY3VtZW50LmZpbGVOYW1lO1xuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xuICAgICAgICAgICAgaWYgKHN5bmNDb250ZXh0KSB7XG4gICAgICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcbiAgICAgICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiAwLjAyLFxuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlOiAn5q2j5Zyo5YeG5aSH57uE5Lu25ZCM5q2l5qCH6K6w6ISa5pys4oCmJyxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBjb25zdCBzY3JpcHQgPSBhd2FpdCBlbnN1cmVTeW5jTWFya2VyU2NyaXB0KCk7XG4gICAgICAgICAgICAgICAgaWYgKHNjcmlwdC5yZWFzb24pIHtcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChzY3JpcHQucmVhc29uKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiAwLjA1LFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoe1xuICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcbiAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXG4gICAgICAgICAgICAgICAgcHJlZmFiTmFtZTogZnJhbWVOYW1lLFxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXG4gICAgICAgICAgICAgICAgc291cmNlTm9kZUlkLFxuICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXG4gICAgICAgICAgICAgICAgcm9vdHMsXG4gICAgICAgICAgICAgICAgc2tpcFN5bmNOb2RlSWRzLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LnN5bmNNYXJrZXJXYXJuaW5nKSB7XG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChg57uE5Lu25ZCM5q2l5qCH6K6w5pyq5YaZ5YWl77yaJHtyZXN1bHQuc3luY01hcmtlcldhcm5pbmd9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XG4gICAgICAgICAgICAvLyBQcmVmYWIgdXBkYXRlcyBwZXJzaXN0IGJ5IFByZWZhYkluZm8uZmlsZUlkIGluIHRoZSBhc3NldCBtZXRhO1xuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXG4gICAgICAgICAgICBkZWxldGUgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV07XG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xuICAgICAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XG4gICAgICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiAxLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH3vvIzlt7LmiZPlvIDpooTliLbkvZMgJHtwcmVmYWJVcmx9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLpgIDogJyd9YCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xuICAgICAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XG4gICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXG4gICAgICAgICAgICByb290TmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXG4gICAgICAgICAgICByb290RnJhbWUsXG4gICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXG4gICAgICAgICAgICB1cGRhdGVFeGlzdGluZzogaW1wb3J0U2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXG4gICAgICAgICAgICBleGlzdGluZ01hcDogbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPz8ge30sXG4gICAgICAgICAgICByb290cyxcbiAgICAgICAgfTtcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLjEsIG1lc3NhZ2U6ICfmraPlnKjmnoTlu7ogQ29jb3Mg6IqC54K55qCR4oCmJyB9KTtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcbiAgICAgICAgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPSByZXN1bHQubm9kZU1hcDtcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ25vZGUnLCByZXN1bHQucm9vdFV1aWQpO1xuICAgICAgICBpZiAoaW1wb3J0U2V0dGluZ3MuYXV0b1NhdmUpIHtcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcbiAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcbiAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXG4gICAgICAgICAgICB2YWx1ZTogMSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxuICAgICAgICB9KTtcbiAgICAgICAgdHJhY2UuZG9uZSgpO1xuICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnY2FuY2VsbGVkJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflt7Llj5bmtojjgIInIH0pO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmk43kvZzlt7Llj5bmtojjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXG4gICAgICAgICAgICB2YWx1ZTogMCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgicsXG4gICAgICAgIH0pO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XG4gICAgICAgIHRyYWNlLmV2ZW50KCflkI7lj7Dku7vliqHlt7Lph4rmlL4nKTtcbiAgICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldE1jcFBsdWdpblN0YXRlKCkge1xuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xuICAgIHJldHVybiB7XG4gICAgICAgIHZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXG4gICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcbiAgICAgICAgc2V0dGluZ3M6IGF3YWl0IGdldFNldHRpbmdzKCksXG4gICAgICAgIGRvY3VtZW50OiBkb2N1bWVudCA/IHtcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpLFxuICAgICAgICB9IDogbnVsbCxcbiAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRQbHVnaW5TdGF0ZSgpIHtcbiAgICByZXR1cm4ge1xuICAgICAgICAuLi5hd2FpdCBnZXRNY3BQbHVnaW5TdGF0ZSgpLFxuICAgICAgICBmb250QXNzZXRzOiBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxuICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xuICAgIHRyeSB7XG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPliBGaWdtYSDmlofku7bigKYnIH0pO1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XG4gICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCk7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXJzZWQubm9kZUlkXG4gICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxuICAgICAgICAgICAgOiBhd2FpdCBhcGkuZ2V0RmlsZShwYXJzZWQuZmlsZUtleSk7XG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oXG4gICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xuICAgICAgICBjb25zdCBmb250QXNzZXRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcbiAgICAgICAgY29uc3Qgbm9kZU92ZXJyaWRlcyA9IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSk7XG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XG4gICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6IGDlt7Lor7vlj5YgJHtkb2N1bWVudC5maWxlTmFtZX1gIH0pO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcbiAgICAgICAgICAgIHNvdXJjZVVybCxcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXG4gICAgICAgICAgICBmb250QXNzZXRzLFxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlcyxcbiAgICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXG4gICAgICAgICAgICB2YWx1ZTogMCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicsXG4gICAgICAgIH0pO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XG4gICAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24sIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXSk6IFByb21pc2U8QmF0Y2hEb2N1bWVudER0bz4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXG4gICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsIGZvbnRzOiBkb2N1bWVudC5mb250cyxcbiAgICAgICAgZm9udEFzc2V0czogZm9udEFzc2V0cyA/PyBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxuICAgICAgICBub2RlT3ZlcnJpZGVzOiAoYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSkuZmlsdGVyKChpdGVtKSA9PiBkb2N1bWVudC5ub2RlQnlJZC5oYXMoaXRlbS5pZCkpLFxuICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCYXRjaFNvdXJjZShzb3VyY2VVcmw6IHN0cmluZyk6IFByb21pc2U8QmF0Y2hTb3VyY2VSZXN1bHQ+IHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XG4gICAgaWYgKCFwYXJzZWQubm9kZUlkKSB7XG4gICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoJ+aVtOS7veaWh+S7tuivt+WNleeLrOWvvOWFpe+8m+ivt+WFiOenu+mZpOaJuemHj+eVjOmdouWIl+ihqO+8jOaIluS9v+eUqCBTZWN0aW9uIC8gRnJhbWUg6ZO+5o6l44CCJyk7XG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XG4gICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6ICdmaWxlJywgc291cmNlVXJsLCBpdGVtczogW10sIGFkZGVkOiAwLCBkdXBsaWNhdGVzOiAwLCBkb2N1bWVudCB9O1xuICAgIH1cbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcbiAgICB0cnkge1xuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5blubbor4bliKsgU2VjdGlvbiAvIEZyYW1l4oCmJyB9KTtcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcbiAgICAgICAgY29uc3QgcGFyc2VkRG9jdW1lbnQgPSBwYXJzZURvY3VtZW50KGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcbiAgICAgICAgICAgIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpO1xuICAgICAgICBjb25zdCByb290ID0gcGFyc2VkRG9jdW1lbnQucm9vdHNbMF07XG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xuICAgICAgICBpZiAocm9vdC50eXBlICE9PSAnU0VDVElPTicgJiYgcm9vdC50eXBlICE9PSAnRlJBTUUnKSB7XG4gICAgICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuc2l6ZSkgdGhyb3cgbmV3IEVycm9yKCfmibnph4/liJfooajlj6rmjqXlj5cgU2VjdGlvbiDmiJYgRnJhbWXvvJvlhbbku5boioLngrnor7fmuIXnqbrliJfooajlkI7ljZXni6zlr7zlhaXjgIInKTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4ocGFyc2VkRG9jdW1lbnQpO1xuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcbiAgICAgICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcbiAgICAgICAgICAgIGF3YWl0IHBhdGNoU2V0dGluZ3MoeyBzb3VyY2VVcmwgfSk7XG4gICAgICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiAnbm9kZScsIHNvdXJjZVVybCwgaXRlbXM6IFtdLCBhZGRlZDogMCwgZHVwbGljYXRlczogMCxcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudCwgZm9udEFzc2V0cykgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBmcmFtZXMgPSBjb2xsZWN0U2VjdGlvbkZyYW1lcyhyb290KTtcbiAgICAgICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ+i/meS4qiBTZWN0aW9uIOS4i+ayoeacieWPr+eLrOeri+WvvOWFpeeahOWkluWxgiBGcmFtZSDmiJYgQ29tcG9uZW5044CCJyk7XG4gICAgICAgIGNvbnN0IHByZXBhcmVkOiBBcnJheTx7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIH0+ID0gW107XG4gICAgICAgIGxldCBkdXBsaWNhdGVzID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBmcmFtZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gZmlnbWFGcmFtZVNvdXJjZUhhc2gocGFyc2VkLmZpbGVLZXksIGZyYW1lLmlkKTtcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYmF0Y2hEb2N1bWVudHMuZ2V0KGlkKTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICAgICAgICAgIGR1cGxpY2F0ZXMgKz0gMTtcbiAgICAgICAgICAgICAgICBwcmVwYXJlZC5wdXNoKHsgLi4uZXhpc3RpbmcsIGl0ZW06IHsgLi4uZXhpc3RpbmcuaXRlbSxcbiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZXhpc3RpbmcuZG9jdW1lbnQsIGZvbnRBc3NldHMpIH0gfSk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKGZyYW1lRG9jdW1lbnQocGFyc2VkRG9jdW1lbnQsIGZyYW1lKSk7XG4gICAgICAgICAgICBjb25zdCBpdGVtOiBCYXRjaEZyYW1lSXRlbSA9IHtcbiAgICAgICAgICAgICAgICBpZCwgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgcm9vdElkOiBmcmFtZS5pZCwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXG4gICAgICAgICAgICAgICAgbmFtZTogZnJhbWUubmFtZSwgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAuLi4ocm9vdC50eXBlID09PSAnU0VDVElPTicgPyB7IHNlY3Rpb25OYW1lOiByb290Lm5hbWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudCwgZm9udEFzc2V0cyksXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgcHJlcGFyZWQucHVzaCh7IGl0ZW0sIGRvY3VtZW50IH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGFkZGVkID0gcHJlcGFyZWQubGVuZ3RoIC0gZHVwbGljYXRlcztcbiAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUgKyBhZGRlZCA+IE1BWF9CQVRDSF9JVEVNUykgdGhyb3cgbmV3IEVycm9yKCfmnKzmibnmnIDlpJrmt7vliqAgJyArIE1BWF9CQVRDSF9JVEVNUyArICcg5Liq55WM6Z2i77yM6K+35YiG5om55a+85YWl44CCJyk7XG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBwcmVwYXJlZCkgYmF0Y2hEb2N1bWVudHMuc2V0KGVudHJ5Lml0ZW0uaWQsIGVudHJ5KTtcbiAgICAgICAgYXdhaXQgcGF0Y2hTZXR0aW5ncyh7IHNvdXJjZVVybCB9KTtcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6ICflt7Lmt7vliqAgJyArIGFkZGVkICsgJyDkuKrnlYzpnaInXG4gICAgICAgICAgICArIChkdXBsaWNhdGVzID8gJ++8jCcgKyBkdXBsaWNhdGVzICsgJyDkuKrlt7LlnKjliJfooagnIDogJycpICsgJ+OAgicgfSk7XG4gICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6IHJvb3QudHlwZSA9PT0gJ1NFQ1RJT04nID8gJ3NlY3Rpb24nIDogJ2ZyYW1lJywgc291cmNlVXJsLFxuICAgICAgICAgICAgaXRlbXM6IHByZXBhcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pLCBhZGRlZCwgZHVwbGljYXRlcyB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkID8gJ2NhbmNlbGxlZCcgOiAnZXJyb3InLCB2YWx1ZTogMCxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicgfSk7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBhY3RpdmF0ZUJhdGNoSXRlbShpZDogc3RyaW5nKTogUHJvbWlzZTxCYXRjaERvY3VtZW50RHRvPiB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSBiYXRjaERvY3VtZW50cy5nZXQoaWQpO1xuICAgICAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgRXJyb3IoJ+ivpeeVjOmdouW3suWkseaViO+8jOivt+mHjeaWsOa3u+WKoOmTvuaOpeOAgicpO1xuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZW50cnkuZG9jdW1lbnQpO1xuICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGVudHJ5LmRvY3VtZW50O1xuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XG4gICAgICAgIGVudHJ5Lml0ZW0uZG9jdW1lbnQgPSBkb2N1bWVudDtcbiAgICAgICAgcmV0dXJuIGRvY3VtZW50O1xuICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxufVxuXG5mdW5jdGlvbiBzeW5jQmF0Y2hJdGVtcyhpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBlbmFibGVkOiBib29sZWFuIH0+KTogeyBpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSB9IHtcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3ku7vliqHlrozmiJDlkI7lho3kv67mlLnnlYzpnaLliJfooajjgIInKTtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoaXRlbXMpIHx8IGl0ZW1zLmxlbmd0aCA+IE1BWF9CQVRDSF9JVEVNUykgdGhyb3cgbmV3IEVycm9yKCfmibnph4/nlYzpnaLliJfooajml6DmlYjjgIInKTtcbiAgICBjb25zdCBuZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4oKTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSBpdGVtICYmIGJhdGNoRG9jdW1lbnRzLmdldChpdGVtLmlkKTtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgaXRlbS5lbmFibGVkICE9PSAnYm9vbGVhbicgfHwgbmV4dC5oYXMoaXRlbS5pZCkpIHRocm93IG5ldyBFcnJvcign55WM6Z2i5YiX6KGo5bey6L+H5pyf5oiW5YyF5ZCr6YeN5aSN6aG577yM6K+36YeN5paw6K+75Y+W44CCJyk7XG4gICAgICAgIG5leHQuc2V0KGl0ZW0uaWQsIHsgLi4uZW50cnksIGl0ZW06IHsgLi4uZW50cnkuaXRlbSwgZW5hYmxlZDogaXRlbS5lbmFibGVkIH0gfSk7XG4gICAgfVxuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XG4gICAgZm9yIChjb25zdCBbaWQsIGVudHJ5XSBvZiBuZXh0KSBiYXRjaERvY3VtZW50cy5zZXQoaWQsIGVudHJ5KTtcbiAgICByZXR1cm4geyBpdGVtczogWy4uLmJhdGNoRG9jdW1lbnRzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRCYXRjaFN0YXRlKCk6IFByb21pc2U8QmF0Y2hTdGF0ZT4ge1xuICAgIGlmIChhY3RpdmVCYXRjaCkgcmV0dXJuIHtcbiAgICAgICAgaXRlbXM6IFsuLi5iYXRjaERvY3VtZW50cy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSksXG4gICAgICAgIGxhc3RSZXN1bHQ6IGxhc3RCYXRjaFJlc3VsdCwgcnVubmluZzogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCksXG4gICAgfTtcbiAgICBjb25zdCBmb250cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XG4gICAgY29uc3QgaXRlbXM6IEJhdGNoRnJhbWVJdGVtW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGJhdGNoRG9jdW1lbnRzLnZhbHVlcygpKSB7XG4gICAgICAgIGl0ZW1zLnB1c2goeyAuLi5lbnRyeS5pdGVtLCBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhlbnRyeS5kb2N1bWVudCwgZm9udHMpIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBpdGVtcywgbGFzdFJlc3VsdDogbGFzdEJhdGNoUmVzdWx0LCAuLi4oYWN0aXZlQmF0Y2ggPyB7IHJ1bm5pbmc6IGJhdGNoUHJvZ3Jlc3MoYWN0aXZlQmF0Y2gpIH0gOiB7fSkgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmF0Y2gocmVxdWVzdDogQmF0Y2hJbXBvcnRSZXF1ZXN0KTogUHJvbWlzZTxCYXRjaEltcG9ydFJlc3VsdD4ge1xuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyIHx8IGFwcGx5aW5nSW1wb3J0UmV2aWV3IHx8IHJvdW5kdHJpcENvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJ5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ44CCJyk7XG4gICAgaWYgKCFyZXF1ZXN0IHx8ICFBcnJheS5pc0FycmF5KHJlcXVlc3QuaXRlbXMpIHx8ICFyZXF1ZXN0Lml0ZW1zLmxlbmd0aCB8fCByZXF1ZXN0Lml0ZW1zLmxlbmd0aCA+IE1BWF9CQVRDSF9JVEVNUykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+iHs+WwkemAieaLqeS4gOS4quacieaViOeahOW+heWvvOWFpeeVjOmdouOAgicpO1xuICAgIH1cbiAgICBjb25zdCBzZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcbiAgICBjb25zdCB2aXNpYmxlSXRlbXMgPSByZXF1ZXN0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzXG4gICAgICAgIHx8IGJhdGNoRG9jdW1lbnRzLmdldChpdGVtPy5pZCk/LmRvY3VtZW50LnJvb3RzWzBdPy52aXNpYmxlICE9PSBmYWxzZSk7XG4gICAgaWYgKCF2aXNpYmxlSXRlbXMubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ+W3suWFs+mXremakOiXj+WbvuWxguWvvOWFpe+8jOaJgOmAieeVjOmdouWdh+W3sumakOiXj++8m+ivt+mAieaLqeWPr+ingeeVjOmdouaIluW8gOWQr+WvvOWFpemakOiXj+WbvuWxguOAgicpO1xuICAgIGNvbnN0IGVudHJpZXMgPSB2aXNpYmxlSXRlbXMubWFwKChpdGVtKSA9PiB7XG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XG4gICAgICAgIGlmICghZW50cnkgfHwgIWVudHJ5Lml0ZW0uZW5hYmxlZCB8fCAhQXJyYXkuaXNBcnJheShpdGVtLm92ZXJyaWRlcykpIHRocm93IG5ldyBFcnJvcign5b6F5a+85YWl55WM6Z2i5bey5aSx5pWI5oiW5pyq5Yu+6YCJ77yM6K+36YeN5paw6K+75Y+W44CCJyk7XG4gICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IGl0ZW0ub3ZlcnJpZGVzLm1hcCgob3ZlcnJpZGUpID0+ICh7IC4uLm92ZXJyaWRlIH0pKTtcbiAgICAgICAgY29uc3Qgcm9vdCA9IGVudHJ5LmRvY3VtZW50LnJvb3RzWzBdO1xuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChvdmVycmlkZXMsIGVudHJ5LmRvY3VtZW50LnRyZWUpO1xuICAgICAgICBpZiAoZGVjaXNpb25zLmdldChyb290LmlkKT8uYWN0aW9uID09PSAnaWdub3JlJykgdGhyb3cgbmV3IEVycm9yKCfigJwnICsgZW50cnkuaXRlbS5uYW1lICsgJ+KAneagueiKgueCueW3suW/veeVpe+8jOivt+WPlua2iOivpeeVjOmdouWLvumAieaIluaBouWkjeagueiKgueCueetlueVpeOAgicpO1xuICAgICAgICBjb25zdCBuYW1lID0gZGVjaXNpb25zLmdldChyb290LmlkKT8ubmFtZSB8fCByb290Lm5hbWU7XG4gICAgICAgIHJldHVybiB7IC4uLmVudHJ5LCBvdmVycmlkZXMsIG5hbWUgfTtcbiAgICB9KTtcbiAgICBhc3NlcnRCYXRjaFRhcmdldHMoZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgbmFtZTogZW50cnkubmFtZSB9KSkpO1xuICAgIGNvbnN0IHJ1bjogQmF0Y2hSdW4gPSB7XG4gICAgICAgIGlkOiByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2hleCcpLCBpbmRleDogMCwgc3RvcFJlcXVlc3RlZDogZmFsc2UsXG4gICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBuYW1lOiBlbnRyeS5uYW1lLFxuICAgICAgICAgICAgc291cmNlVXJsOiBlbnRyeS5pdGVtLnNvdXJjZVVybCwgc3RhdHVzOiAncGVuZGluZycgfSkpLFxuICAgIH07XG4gICAgYWN0aXZlQmF0Y2ggPSBydW47XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBlbnRyeS5pdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPSBlbnRyeS5vdmVycmlkZXM7XG4gICAgY29uc3QgcHJldmlvdXNEb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xuICAgIGNvbnN0IHByZXZpb3VzUmVzdWx0ID0gcmVxdWVzdC5wcmVzZXJ2ZVJlc3VsdHMgPyBsYXN0QmF0Y2hSZXN1bHQgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgY29tcGxldGVkUmVzdWx0ID0gKCk6IEJhdGNoSW1wb3J0UmVzdWx0ID0+IHtcbiAgICAgICAgY29uc3QgbWVyZ2VkID0gbmV3IE1hcDxzdHJpbmcsIEJhdGNoSW1wb3J0SXRlbVJlc3VsdD4oKTtcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHByZXZpb3VzUmVzdWx0Py5pdGVtcyA/PyBbXSkge1xuICAgICAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLmhhcyhpdGVtLmlkKSkgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJ1bi5pdGVtcykgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XG4gICAgICAgIGNvbnN0IGl0ZW1zID0gWy4uLm1lcmdlZC52YWx1ZXMoKV07XG4gICAgICAgIHJldHVybiB7IGlkOiBydW4uaWQsIGl0ZW1zLCBzdG9wcGVkOiBydW4uc3RvcFJlcXVlc3RlZCxcbiAgICAgICAgICAgIGNvbXBsZXRlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoLFxuICAgICAgICAgICAgdG90YWw6IGl0ZW1zLmxlbmd0aCB9O1xuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gQ2hlY2sgZXZlcnkgZGVzdGluYXRpb24gYmVmb3JlIHRoZSBmaXJzdCBpbWFnZS9wcmVmYWIgd3JpdGUuXG4gICAgICAgIGNvbnN0IGZvbGRlciA9IG5ldyBBc3NldFdyaXRlcihzZXR0aW5ncy5wcmVmYWJGb2xkZXIpLmZvbGRlcjtcbiAgICAgICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IHVybCA9ICdkYjovL2Fzc2V0cy8nICsgZm9sZGVyICsgJy8nICsgc2FuaXRpemVBc3NldE5hbWUoZW50cnkubmFtZSkgKyAnLnByZWZhYic7XG4gICAgICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xuICAgICAgICAgICAgaWYgKCFpbmZvKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBlbnRyeS5pdGVtLmlkXG4gICAgICAgICAgICAgICAgfHwgKGJpbmRpbmdzW2VudHJ5Lml0ZW0uaWRdICYmIGJpbmRpbmdzW2VudHJ5Lml0ZW0uaWRdICE9PSBpbmZvLnV1aWQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfigJwnICsgZW50cnkubmFtZSArICfigJ3nmoQgUHJlZmFiIOi3r+W+hOW3suiiq+WFtuS7luadpea6kOWNoOeUqO+8jOivt+aUueWQjeaIluiwg+aVtOi+k+WHuuebruW9leOAgicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChydW4uc3RvcFJlcXVlc3RlZCkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGxldGVkUmVzdWx0KCk7XG4gICAgICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5YGc5q2i77yM5bCa5pyq5byA5aeL5Lu75L2V55WM6Z2i44CCJywgYmF0Y2g6IHsgLi4uYmF0Y2hQcm9ncmVzcyhydW4pLCByZXN1bHQgfSB9KTtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKHJlcXVlc3QucHJlc2VydmVSZXN1bHRzID8geyBwcmVzZXJ2ZUhpc3Rvcnk6IHRydWUgfSA6IHVuZGVmaW5lZCk7XG4gICAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBlbnRyaWVzLmxlbmd0aDsgaW5kZXgrKykge1xuICAgICAgICAgICAgaWYgKHJ1bi5zdG9wUmVxdWVzdGVkKSBicmVhaztcbiAgICAgICAgICAgIHJ1bi5pbmRleCA9IGluZGV4O1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBlbnRyaWVzW2luZGV4XTtcbiAgICAgICAgICAgIGNvbnN0IHJvdyA9IHJ1bi5pdGVtc1tpbmRleF07XG4gICAgICAgICAgICByb3cuc3RhdHVzID0gJ3J1bm5pbmcnO1xuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcbiAgICAgICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlr7zlhaUgJyArIChpbmRleCArIDEpICsgJy8nICsgZW50cmllcy5sZW5ndGggKyAn77yaJyArIGVudHJ5Lm5hbWUgfSk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBlcmZvcm1JbXBvcnQoeyBvdmVycmlkZXM6IGVudHJ5Lm92ZXJyaWRlcyxcbiAgICAgICAgICAgICAgICAgICAgc2V0dGluZ3M6IHsgLi4uc2V0dGluZ3MsIHNvdXJjZVVybDogZW50cnkuaXRlbS5zb3VyY2VVcmwgfSB9LCBydW4uaWQsXG4gICAgICAgICAgICAgICAgeyBkb2N1bWVudDogZW50cnkuZG9jdW1lbnQsIHByZXNlcnZlUmV2aWV3czogdHJ1ZSwgc2lsZW50UmV2aWV3OiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24ocm93LCB7IHN0YXR1czogJ3N1Y2Nlc3MnLCBwcmVmYWJVcmw6IHJlc3VsdC5wcmVmYWJVcmwsXG4gICAgICAgICAgICAgICAgICAgIGNyZWF0ZWQ6IHJlc3VsdC5jcmVhdGVkLCB1cGRhdGVkOiByZXN1bHQudXBkYXRlZCwgd2FybmluZ3M6IHJlc3VsdC53YXJuaW5ncyxcbiAgICAgICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJlc3VsdC5yZXZpZXc/LmlkIH0pO1xuICAgICAgICAgICAgICAgIHJvdy5zdGF0dXMgPSAnc3VjY2Vzcyc7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGxldCB1bnNhZmUgPSBCb29sZWFuKChlcnJvciBhcyB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KT8ucmVxdWlyZXNBdHRlbnRpb24pO1xuICAgICAgICAgICAgICAgIHRyeSB7IGlmIChhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpKSB1bnNhZmUgPSB0cnVlOyB9XG4gICAgICAgICAgICAgICAgY2F0Y2ggeyB1bnNhZmUgPSB0cnVlOyB9XG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdmYWlsZWQnO1xuICAgICAgICAgICAgICAgIHJvdy5lcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgic7XG4gICAgICAgICAgICAgICAgaWYgKHVuc2FmZSkge1xuICAgICAgICAgICAgICAgICAgICByb3cucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICByb3cuZXJyb3IgKz0gJyDlvZPliY3nvJbovpHmiJbkv53lrZjnirbmgIHpnIDopoHmo4Dmn6XvvIzlt7LmmoLlgZzlkI7nu63nlYzpnaLvvJvnoa7orqTnm67moIflkozkv53lrZjnirbmgIHlkI7lho3ph43or5XjgIInO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAodW5zYWZlIHx8IHJlcXVlc3QuZmFpbHVyZVBvbGljeSA9PT0gJ3N0b3AnKSBydW4uc3RvcFJlcXVlc3RlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDEsXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogZW50cnkubmFtZSArICfvvJonICsgKHJvdy5zdGF0dXMgPT09ICdzdWNjZXNzJyA/ICflt7Lkv53lrZgnIDogJ+Wksei0pScpIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGNvbXBsZXRlZFJlc3VsdCgpO1xuICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHZhbHVlOiAxLCBtZXNzYWdlOiByZXN1bHQuc3RvcHBlZCA/ICfmnKzmibnlt7LlgZzmraLvvIzlt7LlrozmiJDpobnkv53nlZnjgIInIDogJ+acrOaJueWvvOWFpee7k+adn+OAgicsXG4gICAgICAgICAgICBiYXRjaDogeyAuLi5iYXRjaFByb2dyZXNzKHJ1biksIHJlc3VsdCB9IH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmIChhY3RpdmVCYXRjaCA9PT0gcnVuKSBhY3RpdmVCYXRjaCA9IG51bGw7XG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gcHJldmlvdXNEb2N1bWVudDtcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gc3RvcEltcG9ydEJhdGNoKCk6IHsgYWNjZXB0ZWQ6IGJvb2xlYW4gfSB7XG4gICAgaWYgKCFhY3RpdmVCYXRjaCkgcmV0dXJuIHsgYWNjZXB0ZWQ6IGZhbHNlIH07XG4gICAgYWN0aXZlQmF0Y2guc3RvcFJlcXVlc3RlZCA9IHRydWU7XG4gICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5b2T5YmN55WM6Z2i5a6M5oiQ5L+d5a2Y5ZCO5YGc5q2i77yM5ZCO57ut55WM6Z2i5LiN5Lya5byA5aeL44CCJyB9KTtcbiAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcbiAgICBjb25zdCBub2RlID0gZG9jdW1lbnQ/Lm5vZGVCeUlkLmdldChub2RlSWQpO1xuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfpooTop4joioLngrnkuI3lrZjlnKjjgIInKTtcbiAgICB9XG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpKS5nZXRJbWFnZVVybHMoXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxuICAgICAgICAgICAgW25vZGVJZF0sXG4gICAgICAgICAgICAncG5nJyxcbiAgICAgICAgICAgIDEsXG4gICAgICAgICAgICAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV55Sf5oiQ6IqC54K56aKE6KeI44CCJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XG4gICAgfVxufVxuXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xuICAgIGdldEltcG9ydFJldmlldyhpZD86IHN0cmluZykgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5nZXQoaWQpOyB9LFxuICAgIHJlc29sdmVCYXRjaFNvdXJjZSxcbiAgICBhY3RpdmF0ZUJhdGNoSXRlbSxcbiAgICBzeW5jQmF0Y2hJdGVtcyxcbiAgICBnZXRCYXRjaFN0YXRlLFxuICAgIGltcG9ydEJhdGNoLFxuICAgIHN0b3BJbXBvcnRCYXRjaCxcbiAgICBhc3luYyBnZXRJbXBvcnRSZXZpZXdQcmV2aWV3KGlkOiBzdHJpbmcsIGFzc2V0SWQ6IHN0cmluZykgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5wcmV2aWV3KGlkLCBhc3NldElkKTsgfSxcbiAgICBhc3luYyBhcHBseUltcG9ydFJldmlldyhpZDogc3RyaW5nLCByZW1vdmVkSWRzOiB1bmtub3duKSB7XG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeWvvOWFpeaIliBGaWdtYSDpooTop4jlrozmiJDjgIInKTtcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XG4gICAgICAgIGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gdHJ1ZTtcbiAgICAgICAgdHJ5IHsgcmV0dXJuIGF3YWl0IGltcG9ydFJldmlld3MuYXBwbHkoaWQsIHJlbW92ZWRJZHMpOyB9XG4gICAgICAgIGZpbmFsbHkgeyBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlOyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cbiAgICB9LFxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1NvdXJjZVByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nLCBub2RlSWQ6IHN0cmluZykge1xuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3mk43kvZzlrozmiJDlkI7lho3liqDovb3mnaXmupDpooTop4jjgIInKTtcbiAgICAgICAgY29uc3QgeyBmaWxlS2V5LCBub2RlIH0gPSBpbXBvcnRSZXZpZXdzLnNvdXJjZShpZCwgYXNzZXRJZCwgbm9kZUlkKTtcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcbiAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcbiAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XG4gICAgICAgICAgICAgICAgaWYgKGZpbGxzW2ltYWdlUmVmXSkgcmV0dXJuIHsgdXJsOiBmaWxsc1tpbWFnZVJlZl0sIG5vdGU6ICdGaWdtYSDljp/lm77vvIjmnKrlkIjmiJDoioLngrnmlYjmnpzvvIknIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XG4gICAgICAgICAgICBpZiAoIXVybHNbbm9kZS5pZF0pIHRocm93IG5ldyBFcnJvcignRmlnbWEg5pyq6L+U5Zue6aKE6KeI77yM6ZqQ6JeP5oiW5aSN5p2C5pWI5p6c6IqC54K55Y+v6IO95peg5rOV5Y2V54us5riy5p+T44CCJyk7XG4gICAgICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZS5pZF0sIG5vdGU6ICdGaWdtYSDlvZPliY3oioLngrnmuLLmn5PvvIjpmpDol4/npZblhYjlj6/og73kvb/pooTop4jpgI/mmI7vvIknIH07XG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxuICAgIH0sXG4gICAgb3BlblBhbmVsKCkge1xuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XG4gICAgICAgIHJldHVybiBnZXRQbHVnaW5TdGF0ZSgpO1xuICAgIH0sXG5cbiAgICBhc3luYyBzZXRUb2tlbih2YWx1ZTogc3RyaW5nKSB7XG4gICAgICAgIHJldHVybiB2YXVsdC5zZXQodmFsdWUpO1xuICAgIH0sXG5cbiAgICBhc3luYyBjbGVhclRva2VuKCkge1xuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkudmVyaWZ5KCk7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKSB7XG4gICAgICAgIHJldHVybiBzYXZlU2V0dGluZ3ModmFsdWUpO1xuICAgIH0sXG5cbiAgICBhc3luYyBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKSB7XG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcbiAgICAgICAgcmV0dXJuIHBpY2tBc3NldEZvbGRlcihjdXJyZW50KTtcbiAgICB9LFxuXG4gICAgYXN5bmMgcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XG4gICAgICAgIHJldHVybiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQpO1xuICAgIH0sXG5cbiAgICBhc3luYyBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcbiAgICB9LFxuXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xuICAgIH0sXG5cbiAgICBhc3luYyBmZXRjaERvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XG4gICAgICAgIHJldHVybiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZykge1xuICAgICAgICByZXR1cm4gZ2V0Tm9kZVByZXZpZXcobm9kZUlkKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgc3luY1ByZXZpZXcoKSB7XG4gICAgICAgIHJldHVybiBwcmV2aWV3Q29tcG9uZW50U3luYygpO1xuICAgIH0sXG5cbiAgICBhc3luYyByb3VuZHRyaXBEZXRlY3Qoc291cmNlVXJsOiBzdHJpbmcsIGV4cGxpY2l0Um9vdElkPzogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkuZGV0ZWN0KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIGFzeW5jIHJvdW5kdHJpcFByZXZpZXcoc291cmNlVXJsOiBzdHJpbmcsIGV4cGxpY2l0Um9vdElkPzogc3RyaW5nKSB7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkucHJldmlldyhzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBhc3luYyByb3VuZHRyaXBQYWlyKHBhaXJUb2tlbjogc3RyaW5nKSB7XG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xuICAgICAgICB9XG4gICAgfSxcblxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcbiAgICAgICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcbiAgICB9LFxuXG4gICAgYXN5bmMgaW1wb3J0U2VsZWN0aW9uKHJlcXVlc3Q6IEltcG9ydFJlcXVlc3QpIHtcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XG4gICAgfSxcblxuICAgIGNhbmNlbEltcG9ydCgpIHtcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoKSByZXR1cm4gc3RvcEltcG9ydEJhdGNoKCk7XG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgfSxcbn07XG5cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0TWNwQnJpZGdlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xuICAgIG1jcEJyaWRnZSA9IG51bGw7XG4gICAgbWNwQXBpID0gbnVsbDtcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XG5cbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxuICAgICAgICBpc0ltcG9ydEJ1c3k6ICgpID0+IGFjdGl2ZUJhdGNoICE9PSBudWxsIHx8IGFjdGl2ZUNvbnRyb2xsZXIgIT09IG51bGwgfHwgcm91bmR0cmlwQ29udHJvbGxlciAhPT0gbnVsbCxcbiAgICAgICAgZ2V0U3RhdGU6IGdldE1jcFBsdWdpblN0YXRlLFxuICAgICAgICBmZXRjaERvY3VtZW50OiBmZXRjaEZpZ21hRG9jdW1lbnQsXG4gICAgICAgIGdldFByZXZpZXc6IGdldE5vZGVQcmV2aWV3LFxuICAgICAgICBzeW5jUHJldmlldzogKCkgPT4gcHJldmlld0NvbXBvbmVudFN5bmMoKSxcbiAgICAgICAgc2F2ZVNldHRpbmdzLFxuICAgICAgICBwYXRjaFNldHRpbmdzLFxuICAgICAgICBzYXZlTm9kZU92ZXJyaWRlcyxcbiAgICAgICAgcGF0Y2hOb2RlTmFtZXMsXG4gICAgICAgIGltcG9ydFNlbGVjdGlvbjogKHJlcXVlc3QsIG9wZXJhdGlvbklkKSA9PiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QsIG9wZXJhdGlvbklkKSxcbiAgICAgICAgY2FuY2VsSW1wb3J0OiAob3BlcmF0aW9uSWQpID0+IHtcbiAgICAgICAgICAgIGlmICghYWN0aXZlQ29udHJvbGxlciB8fCBhY3RpdmVPcGVyYXRpb25Pd25lciAhPT0gb3BlcmF0aW9uSWQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGJyaWRnZSA9IG5ldyBNY3BCcmlkZ2VTZXJ2ZXIoe1xuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcbiAgICAgICAgcGx1Z2luVmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcbiAgICAgICAgcGx1Z2luSW5zdGFuY2VJZCxcbiAgICAgICAgaW52b2tlOiAobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCkgPT4gYXBpLmludm9rZShtZXRob2QsIHBhcmFtcywgc2lnbmFsKSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBicmlkZ2Uuc3RhcnQoKTtcbiAgICAgICAgbWNwQXBpID0gYXBpO1xuICAgICAgICBtY3BCcmlkZ2UgPSBicmlkZ2U7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgYXdhaXQgYnJpZGdlLmNsb3NlKCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlkK/liqjlpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XG4gICAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gYXdhaXQgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGVkaXRvclJlaW1wb3J0ZXIpO1xuICAgICAgICBjb25zdCBhY3RpdmUgPSByZWNvdmVyZWQuZmlsdGVyKChyZXN1bHQpID0+IHJlc3VsdC5zdGF0dXMgPT09ICdhY3RpdmUtb3duZXInKTtcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxuICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7YWN0aXZlLmxlbmd0aH0g5Liq5LuN55Sx5rS75Yqo6L+b56iL5oyB5pyJ55qEIFJvdW5kLXRyaXAg5LqL5Yqh77yM5pqC5pe256aB5q2iIFBhaXIvQXBwbHnjgIJgXG4gICAgICAgICAgICA6IG51bGw7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYFJvdW5kLXRyaXAg5ZCv5Yqo5oGi5aSN5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWA7XG4gICAgICAgIGNvbnNvbGUuZXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcbiAgICB9XG4gICAgYXdhaXQgc3RhcnRNY3BCcmlkZ2UoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcbiAgICBpZiAoYWN0aXZlQmF0Y2gpIGFjdGl2ZUJhdGNoLnN0b3BSZXF1ZXN0ZWQgPSB0cnVlO1xuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XG4gICAgbGFzdEJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkO1xuICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZSgpO1xuICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xuICAgIGFjdGl2ZURvY3VtZW50ID0gbnVsbDtcbiAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XG4gICAgY29uc3QgYnJpZGdlID0gbWNwQnJpZGdlO1xuICAgIG1jcEJyaWRnZSA9IG51bGw7XG4gICAgbWNwQXBpID0gbnVsbDtcbiAgICB2b2lkIGJyaWRnZT8uY2xvc2UoKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlhbPpl63lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XG4gICAgfSk7XG59XG4iXX0=