"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.overflowingRenderFrame = overflowingRenderFrame;
exports.decisionMap = decisionMap;
exports.subtreeHasExplicitOverride = subtreeHasExplicitOverride;
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
        const syncRootCandidate = document.sourceNodeId && document.roots.length === 1
            ? document.roots[0]
            : undefined;
        const syncMode = Boolean(syncRootCandidate
            && (syncRootCandidate.type === 'COMPONENT' || syncRootCandidate.type === 'INSTANCE'));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQWdoQkEsd0RBZ0JDO0FBOEJELGtDQTJCQztBQUVELGdFQVNDO0FBTUQsOERBZ0NDO0FBNkZELHdDQXFDQztBQW1FRCxrQ0F1dkJDO0FBeUNELDRCQWtIQztBQXdnREQsb0JBYUM7QUFFRCx3QkFnQkM7QUF4d0dELCtCQUE4RTtBQUM5RSwyQkFBZ0M7QUFDaEMsbUNBQXFDO0FBQ3JDLCtDQUFnRTtBQUNoRSwwQ0FBZ0Q7QUFDaEQsbUVBQTBDO0FBQzFDLDJDQUE4RTtBQUM5RSwrQ0FXMEI7QUFDMUIsMkNBQStDO0FBQy9DLDJEQUtnQztBQUNoQyxpREFBeUU7QUFDekUsNkNBQXVFO0FBQ3ZFLHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsd0RBS2dDO0FBQ2hDLG9FQUFvRTtBQUNwRSwwREFLaUM7QUFDakMsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHNEQUF1RDtBQUN2RCwyREFBcUQ7QUFDckQsNERBQWlEO0FBQ2pELG9EQUEwRjtBQUMxRixzREFBMkQ7QUFDM0Qsd0RBY2dDO0FBQ2hDLHdEQUFvRDtBQUNwRCx1Q0FBdUU7QUFDdkUsZ0RBQXNEO0FBQ3RELGlEQUF1RDtBQUN2RCxtREFBc0U7QUFDdEUseURBQTJEO0FBQzNELG1DQW1CaUI7QUFDakIsMkNBQStDO0FBQy9DLDREQUFxRjtBQUNyRiw4RUFBeUU7QUFFekUsaURBQXlGO0FBTXpGLE1BQU0sS0FBSyxHQUFHLElBQUksd0JBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQy9DLE1BQU0sYUFBYSxHQUFHLElBQUksbUNBQW1CLEVBQUUsQ0FBQztBQUNoRCxJQUFJLG9CQUFvQixHQUFHLEtBQUssQ0FBQztBQUNqQyxJQUFJLGNBQWMsR0FBMkIsSUFBSSxDQUFDO0FBQ2xELElBQUks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RSxDQUFDO1FBQ2xHLE9BQU8sQ0FBQyxLQUFLLENBQUMsd0JBQXdCLENBQUMsQ0FBQztJQUM1QyxDQUFDO0lBQ0QsTUFBTSxjQUFjLEVBQUUsQ0FBQztBQUMzQixDQUFDO0FBRUQsU0FBZ0IsTUFBTTtJQUNsQixJQUFJLFdBQVc7UUFBRSxXQUFXLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztJQUNsRCxjQUFjLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDdkIsZUFBZSxHQUFHLFNBQVMsQ0FBQztJQUM1QixhQUFhLENBQUMsVUFBVSxFQUFFLENBQUM7SUFDM0IsZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsS0FBSyxFQUFFLENBQUM7SUFDMUIsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLG9CQUFvQixHQUFHLElBQUksQ0FBQztJQUM1QixjQUFjLEdBQUcsSUFBSSxDQUFDO0lBQ3RCLGdCQUFnQixJQUFJLENBQUMsQ0FBQztJQUN0QixNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsS0FBSyxDQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDakMsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIgfSBmcm9tICdmcy9wcm9taXNlcyc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcclxuaW1wb3J0IHtcclxuICAgIGhhc0hpZGRlbkRlc2NlbmRhbnQsXHJcbiAgICBpbmZlckFjdGlvbixcclxuICAgIGluZmVyQ29jb3NMYXlvdXRNb2RlLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcclxuICAgIGlzTmFtZWRTbGljZUdyb3VwLFxyXG4gICAgaXNWZWN0b3JOb2RlLFxyXG4gICAgbmF0aXZlVGlsZWRQYWludFNvdXJjZSxcclxuICAgIHBsYWluSW1hZ2VTb3VyY2VSZWYsXHJcbiAgICB0eXBlIFRpbGVkUGFpbnRTb3VyY2UsXHJcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XHJcbmltcG9ydCB7IHBhcnNlRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hL3BhcnNlcic7XHJcbmltcG9ydCB7XHJcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcclxuICAgIGNvbXBpbGVJbXBvcnRQbGFuLFxyXG4gICAgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uLFxyXG4gICAgcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zLFxyXG59IGZyb20gJy4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBhbmFseXplTWFza1RpbnQsIHZlcmlmeVdoaXRlQWxwaGFQbmcgfSBmcm9tICcuL2ZpZ21hL21hc2stdGludCc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQsIHR5cGUgU2xpY2VBbmFseXNpcyB9IGZyb20gJy4vZmlnbWEvc2xpY2luZyc7XHJcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHtcclxuICAgIFNZTkNfTUFSS0VSX1NDUklQVF9VUkwsXHJcbiAgICBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwLFxyXG4gICAgY3JlYXRlU3luY01hcmtlcixcclxuICAgIHR5cGUgU3luY01hcmtlclNwZWMsXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9zeW5jLW1hcmtlcic7XHJcbmltcG9ydCB7IHBsYW5TeW5jTWFya2VyU2NyaXB0IH0gZnJvbSAnLi9pbXBvcnRlci9zeW5jLW1hcmtlci1hc3NldCc7XHJcbmltcG9ydCB7XHJcbiAgICBlbXB0eVN5bmNQcmV2aWV3U3VtbWFyeSxcclxuICAgIHBsYW5TeW5jUHJldmlldyxcclxuICAgIHJlYWRQcmVmYWJTeW5jTWFya2VycyxcclxuICAgIHR5cGUgU3luY1ByZXZpZXdSZXN1bHQsXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9zeW5jLXByZXZpZXcnO1xyXG5pbXBvcnQge1xyXG4gICAgQXNzZXRXcml0ZXIsXHJcbiAgICBSQVNURVJfSU1BR0VfRVhURU5TSU9OUyxcclxuICAgIGRldGVjdEltYWdlRXh0ZW5zaW9uLFxyXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcclxuICAgIHNhbml0aXplQXNzZXROYW1lLFxyXG4gICAgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbixcclxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB7IExvY2FsQXNzZXRDYWNoZSwgdHlwZSBDYWNoZUVudHJ5S2V5IH0gZnJvbSAnLi9pbXBvcnRlci9jYWNoZSc7XHJcbmltcG9ydCB0eXBlIHsgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBncmFkaWVudFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc3ZnJztcclxuaW1wb3J0IHsgd3JpdGVTbGljZWRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3NsaWNlZC1wbmcnO1xyXG5pbXBvcnQgeyBoaWRkZW5MYXllcklkcyB9IGZyb20gJy4vaW1wb3J0LXZpc2liaWxpdHknO1xyXG5pbXBvcnQgeyBpc1BuZyB9IGZyb20gJy4vaW1wb3J0ZXIvcmFzdGVyLWZvcm1hdCc7XHJcbmltcG9ydCB7IHBpeGVsU2l6ZWRUaWxlQXNzZXQsIHJhc3Rlcml6ZVRpbGUsIHRpbGVkUmFzdGVyS2V5IH0gZnJvbSAnLi9pbXBvcnRlci90aWxlZC1wbmcnO1xyXG5pbXBvcnQgeyByYXN0ZXJpemVJbWFnZUZpbGwgfSBmcm9tICcuL2ltcG9ydGVyL2ltYWdlLWZpbGwnO1xyXG5pbXBvcnQge1xyXG4gICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzLFxyXG4gICAgY3JlYXRlTWluaW1hbFByZWZhYkpzb24sXHJcbiAgICBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgY29sbGVjdFByZWZhYkNvbXBvbmVudEZpbGVJZHMsXHJcbiAgICBmaWdtYUZyYW1lU291cmNlSGFzaCxcclxuICAgIG1lcmdlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldCxcclxuICAgIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQsXHJcbiAgICByZWFkUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHJldGFpblByZWZhYlN5bmNFbnRyaWVzLFxyXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXHJcbiAgICByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgIHR5cGUgUHJlZmFiU3luY1JlY29yZCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcclxuaW1wb3J0IHsgVG9rZW5WYXVsdCB9IGZyb20gJy4vc2VjdXJpdHkvdG9rZW4tdmF1bHQnO1xyXG5pbXBvcnQgeyBGaWdtYUltcG9ydGVyTWNwQXBpLCB0eXBlIE1jcE5vZGVOYW1lUGF0Y2ggfSBmcm9tICcuL21jcC1hcGknO1xyXG5pbXBvcnQgeyBNY3BCcmlkZ2VTZXJ2ZXIgfSBmcm9tICcuL21jcC1icmlkZ2Uvc2VydmVyJztcclxuaW1wb3J0IHsgUm91bmR0cmlwU2VydmljZSB9IGZyb20gJy4vcm91bmR0cmlwL3NlcnZpY2UnO1xyXG5pbXBvcnQgeyByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMgfSBmcm9tICcuL3JvdW5kdHJpcC9yZWNvdmVyeSc7XHJcbmltcG9ydCB7IGVkaXRvclJlaW1wb3J0ZXIgfSBmcm9tICcuL3JvdW5kdHJpcC90cmFuc2FjdGlvbic7XHJcbmltcG9ydCB7XHJcbiAgICBERUZBVUxUX1NFVFRJTkdTLFxyXG4gICAgdHlwZSBEb2N1bWVudFNlc3Npb24sXHJcbiAgICB0eXBlIEZpZ21hTm9kZSxcclxuICAgIHR5cGUgSW1wb3J0QWN0aW9uLFxyXG4gICAgdHlwZSBJbXBvcnREZWNpc2lvbixcclxuICAgIHR5cGUgSW1wb3J0T3ZlcnJpZGUsXHJcbiAgICB0eXBlIEltcG9ydFJlcXVlc3QsXHJcbiAgICB0eXBlIEltcG9ydFNldHRpbmdzLFxyXG4gICAgdHlwZSBOb2RlS2luZCxcclxuICAgIHR5cGUgTm9kZUltcG9ydFBsYW4sXHJcbiAgICB0eXBlIFByZWZhYkVkaXRpbmdTdGF0ZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHR5cGUgUHJvZ3Jlc3NFdmVudCxcclxuICAgIHR5cGUgUmVjdCxcclxuICAgIHR5cGUgU2NlbmVOb2RlU3BlYyxcclxuICAgIHR5cGUgU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgdHlwZSBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UmVjb3JkZXIsIEltcG9ydFJldmlld1NlcnZpY2UgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBmaW5hbGl6ZUltcG9ydFJldmlldyB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldy1maW5hbGl6ZSc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3LCBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGFzc2VydEJhdGNoVGFyZ2V0cywgY29sbGVjdFNlY3Rpb25GcmFtZXMsIGZyYW1lRG9jdW1lbnQgfSBmcm9tICcuL2JhdGNoLWltcG9ydCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEJhdGNoRG9jdW1lbnREdG8sIEJhdGNoRnJhbWVJdGVtLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQsIEJhdGNoSW1wb3J0UmVxdWVzdCxcclxuICAgIEJhdGNoSW1wb3J0UmVzdWx0LCBCYXRjaFByb2dyZXNzLCBCYXRjaFNvdXJjZVJlc3VsdCwgQmF0Y2hTdGF0ZSxcclxufSBmcm9tICcuL2JhdGNoLXR5cGVzJztcclxuXHJcbmNvbnN0IHZhdWx0ID0gbmV3IFRva2VuVmF1bHQocGFja2FnZUpTT04ubmFtZSk7XHJcbmNvbnN0IGltcG9ydFJldmlld3MgPSBuZXcgSW1wb3J0UmV2aWV3U2VydmljZSgpO1xyXG5sZXQgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTtcclxubGV0IGFjdGl2ZURvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZUNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlT3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBzZXR0aW5nc0NhY2hlOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxubGV0IGRvY3VtZW50UmV2aXNpb24gPSAwO1xyXG5sZXQgbWNwQnJpZGdlOiBNY3BCcmlkZ2VTZXJ2ZXIgfCBudWxsID0gbnVsbDtcclxubGV0IG1jcEFwaTogRmlnbWFJbXBvcnRlck1jcEFwaSB8IG51bGwgPSBudWxsO1xyXG5jb25zdCBwbHVnaW5JbnN0YW5jZUlkID0gcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxubGV0IG5vZGVPdmVycmlkZVdyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHNldHRpbmdzV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5jb25zdCBNQVhfQkFUQ0hfSVRFTVMgPSAxMDA7XHJcbmNvbnN0IGJhdGNoRG9jdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4oKTtcclxuaW50ZXJmYWNlIEJhdGNoUnVuIHtcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBpdGVtczogQmF0Y2hJbXBvcnRJdGVtUmVzdWx0W107XHJcbiAgICBpbmRleDogbnVtYmVyO1xyXG4gICAgc3RvcFJlcXVlc3RlZDogYm9vbGVhbjtcclxufVxyXG5sZXQgYWN0aXZlQmF0Y2g6IEJhdGNoUnVuIHwgbnVsbCA9IG51bGw7XHJcbmxldCBsYXN0QmF0Y2hSZXN1bHQ6IEJhdGNoSW1wb3J0UmVzdWx0IHwgdW5kZWZpbmVkO1xyXG5cclxudHlwZSBEZWNpc2lvbiA9IEltcG9ydERlY2lzaW9uO1xyXG5cclxuaW50ZXJmYWNlIFRpbGVkQXNzZXRSZXF1ZXN0IHtcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFJhd0ltYWdlQXNzZXRSZXF1ZXN0IHtcclxuICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgIGltYWdlUmVmOiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcmV2aWV3SWQ/OiBzdHJpbmc7XHJcbiAgICBwYWNrYWdlTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgcm9vdE5hbWU6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICB1cGRhdGVFeGlzdGluZzogYm9vbGVhbjtcclxuICAgIGV4aXN0aW5nTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgY2VudGVySW5DYW52YXM/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiQ29udGV4dD86IFByZWZhYlNjZW5lU3luY0NvbnRleHQ7XHJcbiAgICAvKiog5pyq5Yu+6YCJ6IqC54K55ZyoIFByZWZhYiDkuK3lt7LmnInnmoQgZmlsZUlk77yb5riF55CG5pen6IqC54K55pe25b+F6aG75L+d55WZ44CCICovXHJcbiAgICByZXRhaW5Ob2RlRmlsZUlkcz86IHN0cmluZ1tdO1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJldmlld0JlZm9yZT86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3QWZ0ZXI/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlldz86IEltcG9ydFJldmlldztcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxuICAgIC8qKiDmoIforrDnu4Tku7bohJrmnKzlsJrmnKrnvJbor5HlrozmiJDml7bnmoTpmY3nuqfor7TmmI7vvJvlr7zlhaXmnKzouqvnu6fnu63miJDlip/jgIIgKi9cclxuICAgIHN5bmNNYXJrZXJXYXJuaW5nPzogc3RyaW5nO1xyXG4gICAgd2FybmluZ3M/OiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFzc2V0QnVpbGRSZXN1bHQge1xyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+O1xyXG4gICAgd2FybmluZ3M6IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUHJlZmFiQXNzZXRJbmZvIHtcclxuICAgIHV1aWQ6IHN0cmluZztcclxuICAgIHVybDogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZXI6IHN0cmluZztcclxuICAgIHR5cGU6IHN0cmluZztcclxuICAgIGltcG9ydGVkOiBib29sZWFuO1xyXG4gICAgaW52YWxpZDogYm9vbGVhbjtcclxuICAgIGlzRGlyZWN0b3J5PzogYm9vbGVhbjtcclxuICAgIHJlYWRvbmx5PzogYm9vbGVhbjtcclxuICAgIHJlZGlyZWN0PzogdW5rbm93bjtcclxufVxyXG5cclxuY29uc3QgRk9OVF9FWFRFTlNJT05TID0gbmV3IFNldChbJy50dGYnLCAnLm90ZicsICcuZm50JywgJy53b2ZmJywgJy53b2ZmMiddKTtcclxuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcclxuICAgICdhdXRvJyxcclxuICAgICdub2RlJyxcclxuICAgICdzcHJpdGUnLFxyXG4gICAgJ2xhYmVsJyxcclxuICAgICdyaWNoVGV4dCcsXHJcbiAgICAnYnV0dG9uJyxcclxuICAgICdzY3JvbGxWaWV3JyxcclxuICAgICdsYXlvdXQnLFxyXG5dKTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGxpc3RGb250QXNzZXRzKCk6IFByb21pc2U8Rm9udEFzc2V0T3B0aW9uW10+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGZvbnRzOiBGb250QXNzZXRPcHRpb25bXSA9IFtdO1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gdmlzaXQoZm9sZGVyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBsZXQgZW50cmllcztcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBlbnRyaWVzID0gYXdhaXQgcmVhZGRpcihmb2xkZXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdub2RlX21vZHVsZXMnIHx8IGVudHJ5Lm5hbWUgPT09ICdsaWJyYXJ5JyB8fCBlbnRyeS5uYW1lID09PSAndGVtcCcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihmb2xkZXIsIGVudHJ5Lm5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdmlzaXQoZmlsZVBhdGgpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFGT05UX0VYVEVOU0lPTlMuaGFzKGV4dG5hbWUoZW50cnkubmFtZSkudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBmaWxlUGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG4gICAgICAgICAgICBmb250cy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKGVudHJ5Lm5hbWUsIGV4dG5hbWUoZW50cnkubmFtZSkpLFxyXG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtwYXRofWAsXHJcbiAgICAgICAgICAgICAgICByZWxhdGl2ZVBhdGg6IHBhdGgsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGF3YWl0IHZpc2l0KGFzc2V0c1Jvb3QpO1xyXG4gICAgcmV0dXJuIGZvbnRzLnNvcnQoKGEsIGIpID0+IGEucmVsYXRpdmVQYXRoLmxvY2FsZUNvbXBhcmUoYi5yZWxhdGl2ZVBhdGgsICd6aC1DTicpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFByb2dyZXNzKHByb2dyZXNzOiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdwcm9ncmVzcycsIHtcclxuICAgICAgICAuLi5wcm9ncmVzcyxcclxuICAgICAgICAuLi4oYWN0aXZlQmF0Y2ggJiYgIXByb2dyZXNzLmJhdGNoID8geyBiYXRjaDogYmF0Y2hQcm9ncmVzcyhhY3RpdmVCYXRjaCkgfSA6IHt9KSxcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaFByb2dyZXNzKHJ1bjogQmF0Y2hSdW4pOiBCYXRjaFByb2dyZXNzIHtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSBydW4uaXRlbXNbTWF0aC5taW4ocnVuLmluZGV4LCBydW4uaXRlbXMubGVuZ3RoIC0gMSldO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBiYXRjaElkOiBydW4uaWQsIGl0ZW1JZDogY3VycmVudD8uaWQgPz8gJycsIG5hbWU6IGN1cnJlbnQ/Lm5hbWUgPz8gJycsXHJcbiAgICAgICAgaW5kZXg6IE1hdGgubWluKHJ1bi5pbmRleCArIDEsIHJ1bi5pdGVtcy5sZW5ndGgpLCB0b3RhbDogcnVuLml0ZW1zLmxlbmd0aCxcclxuICAgICAgICBjb21wbGV0ZWQ6IHJ1bi5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgc3RvcFJlcXVlc3RlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgaXRlbXM6IHJ1bi5pdGVtcy5tYXAoKGl0ZW0pID0+ICh7IC4uLml0ZW0gfSkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdENhY2hlRm9sZGVyKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihFZGl0b3IuUHJvamVjdC50bXBEaXIsIHBhY2thZ2VKU09OLm5hbWUsICdhc3NldC1jYWNoZScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBJbXBvcnRTZXR0aW5ncyB7XHJcbiAgICBjb25zdCBpbnB1dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+XHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHNjYWxlID0gdHlwZW9mIGlucHV0LnNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoaW5wdXQuc2NhbGUpXHJcbiAgICAgICAgPyBNYXRoLm1heCgwLjI1LCBNYXRoLm1pbig0LCBpbnB1dC5zY2FsZSkpXHJcbiAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnNjYWxlO1xyXG4gICAgY29uc3QgZm9udE1hcCA9IGlucHV0LmZvbnRNYXAgJiYgdHlwZW9mIGlucHV0LmZvbnRNYXAgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoaW5wdXQuZm9udE1hcClcclxuICAgICAgICAgICAgLmZpbHRlcigoW2tleSwgaXRlbV0pID0+IGtleS50cmltKCkgJiYgdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAubWFwKChba2V5LCBpdGVtXSkgPT4gW2tleS50cmltKCksIGl0ZW0udHJpbSgpXSkpXHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHJhd0xvY2FsRm9sZGVycyA9IEFycmF5LmlzQXJyYXkoaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnMpXHJcbiAgICAgICAgPyBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogdHlwZW9mIGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXIgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgID8gW2lucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHJhd0xvY2FsRm9sZGVyc1xyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlcik6IGZvbGRlciBpcyBzdHJpbmcgPT4gdHlwZW9mIGZvbGRlciA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBmb2xkZXIudHJpbSgpKVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIsIGluZGV4LCBmb2xkZXJzKSA9PiBmb2xkZXJzLmluZGV4T2YoZm9sZGVyKSA9PT0gaW5kZXgpXHJcbiAgICAgICAgLnNsaWNlKDAsIDMpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IHR5cGVvZiBpbnB1dC5zb3VyY2VVcmwgPT09ICdzdHJpbmcnID8gaW5wdXQuc291cmNlVXJsLnRyaW0oKSA6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiB0eXBlb2YgaW5wdXQuYXNzZXRGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MuYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiB0eXBlb2YgaW5wdXQucHJlZmFiRm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGxvY2FsUmVzb3VyY2VGb2xkZXJzWzBdID8/ICcnLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbnB1dC51cGRhdGVFeGlzdGluZyAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogaW5wdXQucmVmcmVzaEFzc2V0cyA9PT0gdHJ1ZSxcclxuICAgICAgICBpbXBvcnRIaWRkZW5MYXllcnM6IGlucHV0LmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UsXHJcbiAgICAgICAgYXV0b1NhdmU6IGlucHV0LmF1dG9TYXZlID09PSB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5nc1VubG9ja2VkKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGlmIChzZXR0aW5nc0NhY2hlKSB7XHJcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgJ3Byb2plY3QnKTtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGF3YWl0IHNldHRpbmdzV3JpdGVRdWV1ZTtcclxuICAgIHJldHVybiBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhTZXR0aW5nc1dyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHNldHRpbmdzV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBzZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSBzYWZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgbmV4dCwgJ3Byb2plY3QnKTtcclxuICAgICAgICBzZXR0aW5nc0NhY2hlID0gbmV4dDtcclxuICAgICAgICByZXR1cm4gbmV4dDtcclxuICAgIH0pKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soKCkgPT4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGF0Y2hTZXR0aW5ncyh2YWx1ZTogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz4pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh7IC4uLmN1cnJlbnQsIC4uLnZhbHVlIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWVudChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkID0gYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsKTogUHJvbWlzZTxGaWdtYUNsaWVudD4ge1xyXG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIHJldHVybiBuZXcgUm91bmR0cmlwU2VydmljZSh7XHJcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcclxuICAgICAgICBwcm9qZWN0Um9vdDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoIHx8IGFjdGl2ZUNvbnRyb2xsZXIgfHwgYXBwbHlpbmdJbXBvcnRSZXZpZXcpIHRocm93IG5ldyBFcnJvcign5a+85YWl5oiW57uT5p6c6LCD5pW05q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5ZCO5YaN5pON5L2cIFJvdW5kLXRyaXDjgIInKTtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbihvd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ato+WcqOehruiupOWvvOWFpeWQjueahOi1hOa6kOiwg+aVtO+8jOivt+eojeWAmeOAgicpO1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcignUm91bmQtdHJpcCDmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblhYjlj5bmtojjgIInKTtcclxuICAgIGlmIChhY3RpdmVCYXRjaCAmJiBvd25lciAhPT0gYWN0aXZlQmF0Y2guaWQpIHRocm93IG5ldyBFcnJvcign5om56YeP5a+85YWl5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YGc5q2i5ZCO57ut5Lu75Yqh44CCJyk7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJIEZpZ21hIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xyXG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBvd25lcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikge1xyXG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoc2VsZWN0ZWRQYXRoKTtcclxuICAgIGNvbnN0IGZvbGRlciA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGlmICghZm9sZGVyIHx8IGZvbGRlciA9PT0gJy4nIHx8IGZvbGRlci5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUoZm9sZGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6LWE5rqQ6L6T5Ye655uu5b2V5b+F6aG75piv6aG555uuIGFzc2V0cyDkuIvnmoTlrZDmlofku7blpLnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NldERhdGFiYXNlVXJsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShmaWxlUGF0aCk7XHJcbiAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgY29uc3Qgb3V0c2lkZSA9IHBhdGggPT09ICcuLidcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uLycpXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLlxcXFwnKVxyXG4gICAgICAgIHx8IGlzQWJzb2x1dGUocGF0aCk7XHJcbiAgICBpZiAoIXBhdGggfHwgcGF0aCA9PT0gJy4nIHx8IG91dHNpZGUpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBgZGI6Ly9hc3NldHMvJHtwYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKX1gO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6kgRmlnbWEg5a+85YWl6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duLCBfaW5kZXggPSAwKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZycgPyBjdXJyZW50LnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBjdXJyZW50Rm9sZGVyICYmIGlzQWJzb2x1dGUoY3VycmVudEZvbGRlcilcclxuICAgICAgICA/IGN1cnJlbnRGb2xkZXJcclxuICAgICAgICA6IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGlicmFyeSA9IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShzZWxlY3RlZCk7XHJcbiAgICByZXR1cm4geyBmb2xkZXI6IGxpYnJhcnkucm9vdCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiB1bmlvbkZyYW1lKG5vZGVzOiBGaWdtYU5vZGVbXSk6IFJlY3Qge1xyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZXMubWFwKG5vZGVGcmFtZSkuZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIFJlY3QgPT4gQm9vbGVhbih2YWx1ZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgeCA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54KSk7XHJcbiAgICBjb25zdCB5ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkpKTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCkpO1xyXG4gICAgY29uc3QgYm90dG9tID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQpKTtcclxuICAgIHJldHVybiB7IHgsIHksIHdpZHRoOiByaWdodCAtIHgsIGhlaWdodDogYm90dG9tIC0geSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB7XHJcbiAgICBpZiAobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB1bmlvbkZyYW1lKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG59XHJcblxyXG5jb25zdCBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTiA9IDAuNTtcclxuXHJcbi8qKlxyXG4gKiBPbmx5IGV4cGFuZCByYXN0ZXJzIHdob3NlIHZpc2libGUgcGl4ZWxzIGVzY2FwZSB0aGUgZ2VvbWV0cmljIGZyYW1lLiBBXHJcbiAqIHJlbmRlciBmcmFtZSBjb250YWluZWQgaW5zaWRlIHRoZSBnZW9tZXRyeSBvZnRlbiByZXByZXNlbnRzIGludGVudGlvbmFsXHJcbiAqIHRyYW5zcGFyZW50IHBhZGRpbmcgYW5kIG11c3Qga2VlcCB0aGUgbGVnYWN5IGZpeGVkLWNhbnZhcyBwYXRoLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBnZW9tZXRyeSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IHJlbmRlciA9IG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHM7XHJcbiAgICBpZiAoIWdlb21ldHJ5IHx8ICFyZW5kZXIgfHwgcmVuZGVyLndpZHRoIDw9IDAgfHwgcmVuZGVyLmhlaWdodCA8PSAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGdlb21ldHJ5UmlnaHQgPSBnZW9tZXRyeS54ICsgZ2VvbWV0cnkud2lkdGg7XHJcbiAgICBjb25zdCBnZW9tZXRyeUJvdHRvbSA9IGdlb21ldHJ5LnkgKyBnZW9tZXRyeS5oZWlnaHQ7XHJcbiAgICBjb25zdCByZW5kZXJSaWdodCA9IHJlbmRlci54ICsgcmVuZGVyLndpZHRoO1xyXG4gICAgY29uc3QgcmVuZGVyQm90dG9tID0gcmVuZGVyLnkgKyByZW5kZXIuaGVpZ2h0O1xyXG4gICAgcmV0dXJuIHJlbmRlci54IDwgZ2VvbWV0cnkueCAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyLnkgPCBnZW9tZXRyeS55IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJSaWdodCA+IGdlb21ldHJ5UmlnaHQgKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlckJvdHRvbSA+IGdlb21ldHJ5Qm90dG9tICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICA/IHJlbmRlclxyXG4gICAgICAgIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3JuZXJSYWRpaShub2RlOiBGaWdtYU5vZGUpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XHJcbiAgICBpZiAobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaT8ubGVuZ3RoID09PSA0KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XHJcbiAgICB9XHJcbiAgICBjb25zdCByYWRpdXMgPSBub2RlLmNvcm5lclJhZGl1cyA/PyAwO1xyXG4gICAgcmV0dXJuIFtyYWRpdXMsIHJhZGl1cywgcmFkaXVzLCByYWRpdXNdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0RGVjaXNpb24obm9kZTogRmlnbWFOb2RlKTogRGVjaXNpb24ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IGluZmVyQWN0aW9uKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICBuaW5lU2xpY2U6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXHJcbiAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVjaXNpb25Gb3JOb2RlKG5vZGU6IEZpZ21hTm9kZSwgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4pOiBEZWNpc2lvbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAnZ2VuZXJhdGUnLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9uO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZGVjaXNpb25NYXAob3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdLCB0cmVlOiBUcmVlTm9kZUR0b1tdKTogTWFwPHN0cmluZywgRGVjaXNpb24+IHtcclxuICAgIGNvbnN0IGRlY2lzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBEZWNpc2lvbj4oKTtcclxuICAgIGNvbnN0IGZpZ21hU2xpY2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBhZGREZWZhdWx0cyA9IChub2RlczogVHJlZU5vZGVEdG9bXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkgZmlnbWFTbGljZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihub2RlLmFjdGlvbiksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICAgICAgICAgIH0sIEJvb2xlYW4obm9kZS5wYXRjaENhbmRpZGF0ZSkpKTtcclxuICAgICAgICAgICAgYWRkRGVmYXVsdHMobm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGFkZERlZmF1bHRzKHRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIG92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICAgICAgZGVjaXNpb25zLnNldChpdGVtLmlkLCBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAgICAgIGtpbmQ6IE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCkgPyBpdGVtLmtpbmQgOiAnYXV0bycsXHJcbiAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgICAgIH0sIGZpZ21hU2xpY2VzLmhhcyhpdGVtLmlkKSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9ucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuICAgIGluY2x1ZGVOb2RlTmFtZSA9IHRydWUsXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgcmV0dXJuIGRlY2lzaW9uPy5leHBsaWNpdCA9PT0gdHJ1ZVxyXG4gICAgICAgIHx8IChpbmNsdWRlTm9kZU5hbWUgJiYgQm9vbGVhbihkZWNpc2lvbj8ubmFtZSkpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG4vKipcclxuICog5pys5Zyw5ZCM5ZCN57Sg5p2Q5oqK54i25a655Zmo5pW05L2T5o+Q5Y2H5Li6IFBORyDmlbTlsYLvvJror6XniLblrrnlmajnmoTlrZDlsYLkuI3lho3ljZXni6zlu7roioLngrnjgIJcclxuICog5a+85YWl5LiOXCLmlLnliqjpooTmo4BcIuWFseeUqOi/meauteinhOWIme+8jOmBv+WFjemihOajgOaKiuiiq+WQuOaUtueahOWtkOWxguaKpeaIkFwi5paw5aKeXCLjgIJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhcHBseUxvY2FsUGFyZW50UHJvbW90aW9uKFxyXG4gICAgcm9vdHM6IHJlYWRvbmx5IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBtYXRjaGVzTG9jYWw6IChub2RlOiBGaWdtYU5vZGUpID0+IFByb21pc2U8Ym9vbGVhbj4sXHJcbiAgICBwcm90ZWN0ZWREZXNjZW5kYW50OiAobm9kZTogRmlnbWFOb2RlKSA9PiBib29sZWFuLFxyXG4gICAgaGFzQXNzZXQ6IChub2RlSWQ6IHN0cmluZykgPT4gYm9vbGVhbiA9ICgpID0+IGZhbHNlLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByb21vdGUgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgaWYgKGhhc0Fzc2V0KG5vZGUuaWQpIHx8IGFuYWx5emVNYXNrVGludChub2RlKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAmJiAhZGVjaXNpb24ubmluZVNsaWNlXHJcbiAgICAgICAgICAgIC8vIOmHjeWRveWQjeS4jeaUueWPmOi1hOa6kOWMuemFje+8m+WPquacieiHqui6q+aIluWQjuS7o+eahOaYvuW8j+etlueVpeimhuebluaJjemYu+atouaPkOWNh++8jFxyXG4gICAgICAgICAgICAvLyDlkKbliJnooqvlkLjmlLbnmoTlkI7ku6PkvJrpnZnpu5jmtojlpLHjgIJcclxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpXHJcbiAgICAgICAgICAgIC8vIOWQjOWQjeelluWFiOS4jeiDveaIkOS4uuaKueaOieeLrOeri+WIh+eJh+i1hOa6kOaIluiSmeeJiOihqOekuueahOeQhueUseOAglxyXG4gICAgICAgICAgICAmJiAhcHJvdGVjdGVkRGVzY2VuZGFudChub2RlKVxyXG4gICAgICAgICAgICAvLyDniLbotYTmupDml6Dms5Xooajovr7ni6znq4vnmoTpmpDol4/lkI7ku6PvvIzov5nnp43ovrnnlYzlv4Xpobvkv53nlZnlsYLnuqfjgIJcclxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSlcclxuICAgICAgICAgICAgJiYgYXdhaXQgbWF0Y2hlc0xvY2FsKG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgeyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChub2RlLmNoaWxkcmVuLm1hcChwcm9tb3RlKSk7XHJcbiAgICB9O1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwocm9vdHMubWFwKHByb21vdGUpKTtcclxufVxyXG5cclxudHlwZSBTdG9yZWROb2RlT3ZlcnJpZGVzID0gUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+PjtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTogUHJvbWlzZTxTdG9yZWROb2RlT3ZlcnJpZGVzPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgaXRlbSA9IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0T3ZlcnJpZGU+O1xyXG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xyXG4gICAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBraW5kID0gdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgJiYgTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKVxyXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXHJcbiAgICAgICAgOiAnYXV0byc7XHJcbiAgICBjb25zdCBleHBsaWNpdCA9IGl0ZW0uZXhwbGljaXQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgIGlmICghZXhwbGljaXQgJiYgIW5hbWUpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZCxcclxuICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxyXG4gICAgICAgIGV4cGxpY2l0LFxyXG4gICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgY29uc3Qgc3RvcmVkID0gKGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKSlbZmlsZUtleV0gPz8ge307XHJcbiAgICBjb25zdCByZXN1bHQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xyXG4gICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlLCBpZCk7XHJcbiAgICAgICAgaWYgKHNhZmUpIHJlc3VsdC5wdXNoKHNhZmUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5vZGVPdmVycmlkZVdyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xyXG4gICAgY29uc3Qgc2FmZUl0ZW1zID0gaXRlbXNcclxuICAgICAgICAubWFwKChpdGVtKSA9PiBzYWZlTm9kZU92ZXJyaWRlKGl0ZW0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgIChBcnJheS5pc0FycmF5KHNjb3BlVmFsdWVzKSA/IHNjb3BlVmFsdWVzIDogc2FmZUl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxyXG4gICAgKTtcclxuICAgIGlmICghc2NvcGVJZHMuc2l6ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY29wZWRJdGVtcyA9IHNhZmVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNjb3BlSWRzLmhhcyhpdGVtLmlkKSk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgZm9yIChjb25zdCBpZCBvZiBzY29wZUlkcykge1xyXG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzY29wZWRJdGVtcykge1xyXG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xyXG4gICAgfVxyXG4gICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkge1xyXG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNjb3BlZEl0ZW1zO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlcyhcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhcclxuICAgICAgICAoKSA9PiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKGZpbGVLZXksIHZhbHVlcywgc2NvcGVWYWx1ZXMpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhdGNoTm9kZU5hbWVzKGZpbGVLZXk6IHN0cmluZywgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFmaWxlS2V5LnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgcGF0Y2ggb2YgcGF0Y2hlcykge1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiBwYXRjaC5pZCA9PT0gJ3N0cmluZycgPyBwYXRjaC5pZC50cmltKCkgOiAnJztcclxuICAgICAgICAgICAgaWYgKCFpZCkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgbm9kZUlk44CCJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gc2FmZU5vZGVPdmVycmlkZShjdXJyZW50W2lkXSwgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBmYWxsYmFjayA9IHNhZmVOb2RlT3ZlcnJpZGUocGF0Y2guZmFsbGJhY2ssIGlkKTtcclxuICAgICAgICAgICAgY29uc3QgbmV4dCA9IGV4aXN0aW5nID8geyAuLi5leGlzdGluZyB9IDogZmFsbGJhY2sgPyB7IC4uLmZhbGxiYWNrIH0gOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5leHQgJiYgcGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFuZXh0KSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnvLrlsJHmnInmlYjpu5jorqTnrZbnlaXjgIJgKTtcclxuICAgICAgICAgICAgaWYgKHBhdGNoLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBuZXh0Lm5hbWU7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShwYXRjaC5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g55qE5ZCN56ew5peg5pWI44CCYCk7XHJcbiAgICAgICAgICAgICAgICBuZXh0Lm5hbWUgPSBuYW1lO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKG5leHQsIGlkKTtcclxuICAgICAgICAgICAgaWYgKHNhZmUpIHtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnRbaWRdID0gc2FmZTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3RlZC5wdXNoKHNhZmUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGgpIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICAgICAgZWxzZSBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIHBlcnNpc3RlZDtcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xyXG4gICAgY29uc3QgZGVmYXVsdHMgPSBkZWNpc2lvbk1hcChbXSwgc2Vzc2lvbi50cmVlKTtcclxuICAgIHNlc3Npb24udHJlZSA9IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgICAgIHNlc3Npb24udHJlZSxcclxuICAgICAgICBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWZhdWx0cyksXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwcmVwYXJlZDogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKSxcclxuKTogeyBwbmc6IEZpZ21hTm9kZVtdOyB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXTsgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdOyBncmFkaWVudHM6IEZpZ21hTm9kZVtdIH0ge1xyXG4gICAgY29uc3QgcG5nOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBhbmNlc3RvcnNWaXNpYmxlOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgaWYgKHByZXBhcmVkLmhhcyhub2RlLmlkKSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZWx5VmlzaWJsZSA9IGFuY2VzdG9yc1Zpc2libGUgJiYgbm9kZS52aXNpYmxlICE9PSBmYWxzZSAmJiBub2RlLm9wYWNpdHkgPiAwO1xyXG4gICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZWZmZWN0aXZlbHlWaXNpYmxlKSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSkge1xyXG4gICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2UgPSBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoc291cmNlKSB7XHJcbiAgICAgICAgICAgICAgICB0aWxlZC5wdXNoKHsgbm9kZSwgc291cmNlIH0pO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gVGhlIHNhbWUgcGxhaW4gSU1BR0Ugc291cmNlIGFuZCBjZW50ZXJlZCBjcm9wIHBhdGggc2VydmUgYm90aFxyXG4gICAgICAgICAgICAgICAgLy8gdmlzaWJpbGl0eSBzdGF0ZXM7IHdob2xlLW5vZGUgZXhwb3J0cyBjYW4gYmFrZSBkaWZmZXJlbnQgYWxwaGEuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZVJlZiA9IHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgICAgICByYXdJbWFnZXMucHVzaCh7IG5vZGUsIGltYWdlUmVmIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgICAgICBpZiAoZmlsbCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZ3JhZGllbnRzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB0cnVlKSk7XHJcbiAgICByZXR1cm4geyBwbmcsIHRpbGVkLCByYXdJbWFnZXMsIGdyYWRpZW50cyB9O1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRBc3NldHMoXHJcbiAgICBzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIGltcG9ydFNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyxcclxuICAgIHJldmlldzogSW1wb3J0UmV2aWV3UmVjb3JkZXIsXHJcbiAgICBvcHRpb25zOiB7IHJlZ2VuZXJhdGVOb2RlSWRzPzogUmVhZG9ubHlTZXQ8c3RyaW5nPiB9ID0ge30sXHJcbik6IFByb21pc2U8QXNzZXRCdWlsZFJlc3VsdD4ge1xyXG4gICAgY29uc3QgaGlkZGVuID0gaGlkZGVuTGF5ZXJJZHMoc2Vzc2lvbi5yb290cywgaW1wb3J0U2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSk7XHJcbiAgICBjb25zdCBhcHBseVZpc2liaWxpdHkgPSAobm9kZTogRmlnbWFOb2RlKTogdm9pZCA9PiB7XHJcbiAgICAgICAgaWYgKGhpZGRlbi5oYXMobm9kZS5pZCkpIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwge1xyXG4gICAgICAgICAgICAuLi4oZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSkpLCBhY3Rpb246ICdpZ25vcmUnLCBuaW5lU2xpY2U6IGZhbHNlLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaChhcHBseVZpc2liaWxpdHkpO1xyXG4gICAgfTtcclxuICAgIHNlc3Npb24ucm9vdHMuZm9yRWFjaChhcHBseVZpc2liaWxpdHkpO1xyXG4gICAgY29uc3QgcmVzb2x2ZWREZWNpc2lvbnMgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xyXG4gICAgcmVzb2x2ZWREZWNpc2lvbnMuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XHJcbiAgICBjb25zdCB3cml0ZVN0YXRlcyA9IG5ldyBNYXA8c3RyaW5nLCBib29sZWFuPigpO1xyXG4gICAgY29uc3Qgd3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLmFzc2V0Rm9sZGVyLCBhc3luYyAodXJsLCBleGlzdGVkKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgcmV2aWV3LmJlZm9yZVdyaXRlKHVybCwgZXhpc3RlZCk7XHJcbiAgICAgICAgd3JpdGVTdGF0ZXMuc2V0KHVybCwgZXhpc3RlZCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHdyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBjYWNoZSA9IG5ldyBMb2NhbEFzc2V0Q2FjaGUoZGVmYXVsdENhY2hlRm9sZGVyKCkpO1xyXG4gICAgYXdhaXQgY2FjaGUuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZXMgPSBpbXBvcnRTZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KGZvbGRlcikpO1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwobG9jYWxSZXNvdXJjZXMubWFwKChsaWJyYXJ5KSA9PiBsaWJyYXJ5LmluaXRpYWxpemUoKSkpO1xyXG4gICAgLy8gSW5kZXggZXhpc3RpbmcgbmFtZXMgb25jZTsgbmV3IHJlc291cmNlcyBhcmUgc2hhcmVkIGJ5IG5hbWUgYmVsb3cuXHJcbiAgICBjb25zdCBvdXRwdXRQYXRoID0gam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJywgd3JpdGVyLmZvbGRlcik7XHJcbiAgICBjb25zdCBvdXRwdXRSZXNvdXJjZXMgPSBleGlzdHNTeW5jKG91dHB1dFBhdGgpID8gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KG91dHB1dFBhdGgpIDogbnVsbDtcclxuICAgIGF3YWl0IG91dHB1dFJlc291cmNlcz8uaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgYXNzZXRzID0gbmV3IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4oKTtcclxuICAgIC8vIFRoZSBwcm9qZWN0IGNvbnRyYWN0IGlzIHNhbWUgbmFtZSA9IHNhbWUgcmVzb3VyY2UuIFNoYXJlIGFjcm9zcyByZW5kZXIsXHJcbiAgICAvLyBJTUFHRSBhbmQgZ3JhZGllbnQgcGF0aHMgYmVmb3JlIGRvd25sb2FkaW5nIG9yIGNvbXBhcmluZyBhbnkgcGl4ZWxzLlxyXG4gICAgY29uc3Qgc2hhcmVkQXNzZXRzID0gbmV3IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4oKTtcclxuICAgIGNvbnN0IHJlc291cmNlS2V5ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4gd3JpdGVyLmJ1aWxkVXJsKG5vZGUubmFtZSwgJycsICdwbmcnLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSlcclxuICAgICAgICAubm9ybWFsaXplKCdORktDJykudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICBjb25zdCB3YXJuaW5ncyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3Qgbm90ZSA9IChhY3Rpb246IE5vbk51bGxhYmxlPEltcG9ydFJldmlld1snZGVjaXNpb25zJ10+W251bWJlcl1bJ2FjdGlvbiddLCBuYW1lOiBzdHJpbmcsIHJlYXNvbjogc3RyaW5nLCB1cmw/OiBzdHJpbmcpID0+XHJcbiAgICAgICAgcmV2aWV3Lm5vdGU/LihhY3Rpb24sIG5hbWUsIHJlYXNvbiwgdXJsKTtcclxuICAgIGNvbnN0IG5vdGVXcml0ZSA9IChhc3NldDogU3ByaXRlQXNzZXRTcGVjKSA9PiBub3RlKHdyaXRlU3RhdGVzLmdldChhc3NldC51cmwpID8gJ3VwZGF0ZWQnIDogJ2NyZWF0ZWQnLFxyXG4gICAgICAgIGJhc2VuYW1lKGFzc2V0LnVybCksIHdyaXRlU3RhdGVzLmdldChhc3NldC51cmwpXHJcbiAgICAgICAgICAgID8gJ+WGmeWFpeWQjOWQjei+k+WHuui1hOa6kO+8jOS/neeVmeWOnyBVVUlEJ1xyXG4gICAgICAgICAgICA6ICfmjInlkI3np7Dlr7zlhaXkuIDku73otYTmupDvvIzlkIzlkI3oioLngrnnm7TmjqXlhbHnlKgnLCBhc3NldC51cmwpO1xyXG4gICAgY29uc3Qgbm9kZVNvdXJjZUtleSA9IChub2RlOiBGaWdtYU5vZGUsIHZhcmlhbnQgPSAncmFzdGVyLXYyJykgPT5cclxuICAgICAgICBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCBub2RlLmlkLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSwgdmFyaWFudF0pO1xyXG4gICAgY29uc3QgZ3JvdXBTb3VyY2VLZXkgPSAoYXNzZXRLZXk6IHN0cmluZykgPT4gSlNPTi5zdHJpbmdpZnkoW3Nlc3Npb24uZmlsZUtleSwgJ3RpbGUtdjInLCBhc3NldEtleV0pO1xyXG4gICAgY29uc3QgaW1hZ2VEZXRhaWxzID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xyXG4gICAgICAgIGxldCBsZWFmID0gbm9kZSwgaW5uZXJPcGFjaXR5ID0gMTtcclxuICAgICAgICB3aGlsZSAobGVhZi5jaGlsZHJlbi5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICAgICAgbGVhZiA9IGxlYWYuY2hpbGRyZW5bMF07XHJcbiAgICAgICAgICAgIGlubmVyT3BhY2l0eSAqPSBsZWFmLm9wYWNpdHk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGxlYWYsIGlubmVyT3BhY2l0eSB9O1xyXG4gICAgfTtcclxuICAgIGNvbnN0IGZpbmRPdXRwdXQgPSBhc3luYyAobmFtZTogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzICYmIG91dHB1dFJlc291cmNlcykge1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IG91dHB1dFJlc291cmNlcy5maW5kKG5hbWUsICdwbmcnKTtcclxuICAgICAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4geyAuLi5tYXRjaCwgc291cmNlOiAnZXhpc3RpbmcnIGFzIGNvbnN0IH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfTtcclxuICAgIGNvbnN0IGZpbmRMb2NhbCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGluY2x1ZGVPdXRwdXQgPSB0cnVlLCBub2RlSWQ/OiBzdHJpbmcpID0+IHtcclxuICAgICAgICAvLyDnu4Tku7blkIzmraXvvJrlj6rmnInlg4/ntKDmjIfnurnliKTlrprkuLpcIuWbvueJh+W3suWPmOWMllwi55qE6IqC54K55omN6Lez6L+H5pys5Zyw57Sg5p2Q5aSN55So77ybXHJcbiAgICAgICAgLy8g5rKh5Y+Y5YyW55qE6IqC54K557un57ut5byV55So6aG555uu6YeM55qE5ZCM5ZCN57Sg5p2Q77yM5LiN55Sf5oiQ6YeN5aSN5Zu+54mH44CCXHJcbiAgICAgICAgaWYgKG5vZGVJZCAmJiBvcHRpb25zLnJlZ2VuZXJhdGVOb2RlSWRzPy5oYXMobm9kZUlkKSkge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgbGlicmFyeS5maW5kKG5hbWUsICdwbmcnKTtcclxuICAgICAgICAgICAgLy8gRGlyZWN0b3J5IG9yZGVyLCBleHRlbnNpb24gcHJlZmVyZW5jZSBhbmQgcm9vdC1iZWZvcmUtc3ViZm9sZGVyXHJcbiAgICAgICAgICAgIC8vIG9yZGVyaW5nIGFyZSB0aGUgZXhpc3RpbmcgdXNlci1kZWNsYXJlZCBuYW1lIG1hcHBpbmcgY29udHJhY3QuXHJcbiAgICAgICAgICAgIGlmIChtYXRjaCkgcmV0dXJuIHsgLi4ubWF0Y2gsIHNvdXJjZTogJ2xvY2FsJyBhcyBjb25zdCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaW5jbHVkZU91dHB1dCA/IGZpbmRPdXRwdXQobmFtZSkgOiBudWxsO1xyXG4gICAgfTtcclxuICAgIGNvbnN0IHByZXBhcmVNYXNrID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJyB8fCBkZWNpc2lvbi5uaW5lU2xpY2UpIHJldHVybjtcclxuICAgICAgICBjb25zdCBhbmFseXNpcyA9IGFuYWx5emVNYXNrVGludChub2RlKTtcclxuICAgICAgICBpZiAoYW5hbHlzaXMgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpKSB7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgeyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywga2luZDogJ3Nwcml0ZScsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgIGxldCByZWFzb24gPSBhbmFseXNpcy5yZWFzb247XHJcbiAgICAgICAgICAgIGlmIChhbmFseXNpcy5jYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgbWFzaywgdGludCB9ID0gYW5hbHlzaXMuY2FuZGlkYXRlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwobWFzay5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpXHJcbiAgICAgICAgICAgICAgICAgICAgOiBhd2FpdCB3cml0ZXIuZXhpc3RpbmdGb3JTb3VyY2Uobm9kZVNvdXJjZUtleShtYXNrKSwgeyB0aWxlZDogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICAvLyBWZXJpZnkgdGhlIGJ5dGVzIG9mIHRoZSByZWZlcmVuY2VkIGFzc2V0LCBuZXZlciBhbiB1bnJlbGF0ZWRcclxuICAgICAgICAgICAgICAgIC8vIHNhbWUtbmFtZSBmaWxlIGZyb20gYSBwcm9qZWN0LWV4dGVybmFsIGxpYnJhcnkgZGlyZWN0b3J5LlxyXG4gICAgICAgICAgICAgICAgY29uc3QgYnl0ZXMgPSBsb2NhbFVybCAmJiBhc3NldCA/IG1hdGNoIS5jb250ZW50c1xyXG4gICAgICAgICAgICAgICAgICAgIDogYXNzZXQgPyBhd2FpdCByZWFkRmlsZShqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGFzc2V0LnVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGJ5dGVzID8gdmVyaWZ5V2hpdGVBbHBoYVBuZyhieXRlcykgOiB7IHZhbGlkOiBmYWxzZSwgcmVhc29uOiAn5rKh5pyJ5Y+v6aqM6K+B55qE5pys5Zyw55m96Imy5bqV5Zu+JyB9O1xyXG4gICAgICAgICAgICAgICAgcmVhc29uID0gdmVyaWZpZWQucmVhc29uO1xyXG4gICAgICAgICAgICAgICAgaWYgKGFzc2V0ICYmIHZlcmlmaWVkLnZhbGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdGludGVkID0geyAuLi5hc3NldCwgdGludCB9O1xyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgdGludGVkKTtcclxuICAgICAgICAgICAgICAgICAgICByZXZpZXcuYmluZChub2RlLCB0aW50ZWQsIG1hdGNoPy5zb3VyY2UgPz8gJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgbm90ZSgndGludGVkJywgbm9kZS5uYW1lLCBgJHthbmFseXNpcy5yZWFzb25977ybJHt2ZXJpZmllZC5yZWFzb25977yb5rK/55So5Y6fIFVVSUQg5LiO5Lmd5a6r5Y+C5pWw77yM6YCP5piO5bqm5LuF6K6h566X5LiA5qyhYCwgYXNzZXQudXJsKTtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlLm5hbWUsIGAke3JlYXNvbn3vvJvkvb/nlKggRmlnbWEg5a6M5pW06JKZ54mI5ZCI5oiQ77yM5LiN5L+u5pS55YWx5Lqr5bqV5Zu+YCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHJldHVybjtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIGF3YWl0IHByZXBhcmVNYXNrKGNoaWxkKTtcclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygc2Vzc2lvbi5yb290cykgYXdhaXQgcHJlcGFyZU1hc2socm9vdCk7XHJcbiAgICBjb25zdCBwcm90ZWN0ZWREZXNjZW5kYW50ID0gKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4gPT4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkRGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUoY2hpbGQsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGNoaWxkRGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIHJldHVybiBCb29sZWFuKGNoaWxkLmlzTWFzayB8fCBjaGlsZC5jaGlsZHJlbi5zb21lKChwYXJ0KSA9PiBwYXJ0LmlzTWFzaylcclxuICAgICAgICAgICAgfHwgYXNzZXRzLmhhcyhjaGlsZC5pZCkgfHwgY2hpbGREZWNpc2lvbi5uaW5lU2xpY2UgfHwgaXNOYW1lZFNsaWNlR3JvdXAoY2hpbGQpIHx8IGlzUGF0Y2hDYW5kaWRhdGUoY2hpbGQpKVxyXG4gICAgICAgICAgICB8fCAoY2hpbGREZWNpc2lvbi5hY3Rpb24gIT09ICdyZW5kZXInICYmIHByb3RlY3RlZERlc2NlbmRhbnQoY2hpbGQpKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgYXBwbHlMb2NhbFBhcmVudFByb21vdGlvbihcclxuICAgICAgICBzZXNzaW9uLnJvb3RzLFxyXG4gICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICBhc3luYyAobm9kZSkgPT4gQm9vbGVhbihhd2FpdCBmaW5kTG9jYWwobm9kZS5uYW1lLCBmYWxzZSwgbm9kZS5pZCkpLFxyXG4gICAgICAgIHByb3RlY3RlZERlc2NlbmRhbnQsXHJcbiAgICAgICAgKG5vZGVJZCkgPT4gYXNzZXRzLmhhcyhub2RlSWQpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGZpbmFsRGVjaXNpb25zID0gcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBkZWNpc2lvbnMuY2xlYXIoKTtcclxuICAgIGZpbmFsRGVjaXNpb25zLmZvckVhY2goKHZhbHVlLCBrZXkpID0+IGRlY2lzaW9ucy5zZXQoa2V5LCB2YWx1ZSkpO1xyXG4gICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgY29uc3QgYWN0aXZlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBhY3RpdmVCb3VuZGFyeSA9IChub2RlOiBGaWdtYU5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm47XHJcbiAgICAgICAgYWN0aXZlSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICBpZiAoaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pIHx8IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBhc3NldHMuaGFzKG5vZGUuaWQpKSByZXR1cm47XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFjdGl2ZUJvdW5kYXJ5KTtcclxuICAgIH07XHJcbiAgICBzZXNzaW9uLnJvb3RzLmZvckVhY2goYWN0aXZlQm91bmRhcnkpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHBsYW5dIG9mIHBsYW5zKSB7XHJcbiAgICAgICAgaWYgKCFhY3RpdmVJZHMuaGFzKGlkKSkgY29udGludWU7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IHNlc3Npb24ubm9kZUJ5SWQ/LmdldChpZCk7XHJcbiAgICAgICAgaWYgKHBsYW4ucmVhc29uID09PSAncHJlZml4LW1lcmdlJykgbm90ZSgnbWVyZ2VkJywgbm9kZT8ubmFtZSA/PyBpZCxcclxuICAgICAgICAgICAgcGxhbi53YXJuaW5nID8/ICdpY29uXy9pbWdfIOacgOWkluWxgui1hOa6kOi+ueeVjO+8jOaMieW9k+WJjeaYvumakOWQiOaIkO+8jOS/neeVmeeItuiKgueCueWHoOS9leS4jumAj+aYjuW6picpO1xyXG4gICAgICAgIGVsc2UgaWYgKHBsYW4ud2FybmluZykge1xyXG4gICAgICAgICAgICB3YXJuaW5ncy5hZGQoYCR7bm9kZT8ubmFtZSA/PyBpZH3vvJoke3BsYW4ud2FybmluZ31gKTtcclxuICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlPy5uYW1lID8/IGlkLCBwbGFuLndhcm5pbmcpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IHJlcXVlc3RzID0gY29sbGVjdEFzc2V0UmVxdWVzdHMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zLCBuZXcgU2V0KGFzc2V0cy5rZXlzKCkpKTtcclxuICAgIGNvbnN0IHRvdGFsID0gcmVxdWVzdHMucG5nLmxlbmd0aCArIHJlcXVlc3RzLnRpbGVkLmxlbmd0aFxyXG4gICAgICAgICsgcmVxdWVzdHMucmF3SW1hZ2VzLmxlbmd0aCArIHJlcXVlc3RzLmdyYWRpZW50cy5sZW5ndGg7XHJcbiAgICBsZXQgY29tcGxldGVkID0gMDtcclxuICAgIGxldCBhcGlQcm9taXNlOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgIGNvbnN0IGdldEFwaSA9ICgpID0+IHtcclxuICAgICAgICBhcGlQcm9taXNlID8/PSBkaWFnbm9zdGljVGFzaygn5YeG5aSHIEZpZ21hIOWuouaIt+errycsIHVuZGVmaW5lZCwgKCkgPT4gY2xpZW50KCkpO1xyXG4gICAgICAgIHJldHVybiBhcGlQcm9taXNlO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBjb21wbGV0ZUFzc2V0ID0gKFxyXG4gICAgICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyB8ICdnZW5lcmF0ZWQnID0gJ2ZpZ21hJyxcclxuICAgICkgPT4ge1xyXG4gICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgYXNzZXQpO1xyXG4gICAgICAgIHJldmlldy5iaW5kKG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgIGlmIChzb3VyY2UgPT09ICdsb2NhbCcgfHwgc291cmNlID09PSAnZXhpc3RpbmcnKSBub3RlKCdyZXVzZWQnLCBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZSA9PT0gJ2xvY2FsJyA/ICfnlKjmiLfmjIflrprmnKzlnLDnm67lvZXnmoTlkIzlkI3mmKDlsITvvIzkv53nlZnljp8gU3ByaXRlRnJhbWUgVVVJRCDkuI7liIfniYflj4LmlbAnXHJcbiAgICAgICAgICAgICAgICA6ICfmjInlt7LmnInotYTmupDmiJbmnKzmibnlkIzlkI3otYTmupDlpI3nlKjljp8gU3ByaXRlRnJhbWXvvIzkv53nlZkgVVVJRCDkuI7ljp/liIfniYflj4LmlbAnLCBhc3NldC51cmwpO1xyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGNvbnN0IHZlcmIgPSBzb3VyY2UgPT09ICdsb2NhbCdcclxuICAgICAgICAgICAgPyAn5aSN55So5pys5Zyw6LWE5rqQJ1xyXG4gICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJ1xyXG4gICAgICAgICAgICAgICAgPyAn5aSN55So5bey5pyJ6LWE5rqQJ1xyXG4gICAgICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdnZW5lcmF0ZWQnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAn55Sf5oiQ5riQ5Y+YJ1xyXG4gICAgICAgICAgICAgICAgOiAn5a+85YWl6LWE5rqQJztcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYCR7dmVyYn0gJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NUaWxlZCA9IGFzeW5jIChpdGVtczogVGlsZWRBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbiAgICAgICAgICAgIHNvdXJjZUtleTogc3RyaW5nO1xyXG4gICAgICAgICAgICBhc3NldEtleTogc3RyaW5nO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgUGVuZGluZ1RpbGUgZXh0ZW5kcyBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgZXh0ZW5zaW9uPzogUmFzdGVySW1hZ2VFeHRlbnNpb247XHJcbiAgICAgICAgICAgIHNvdXJjZVR5cGU6ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJztcclxuICAgICAgICAgICAgc291cmNlUmVuZGVyU2NhbGU/OiBudW1iZXI7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XHJcbiAgICAgICAgY29uc3QgcmVuZGVyU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBzb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICA/IGNsYW1wSW1hZ2VTY2FsZShyZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKVxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFRpbGVHcm91cD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgbm9kZSwgc291cmNlIH0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAga2luZDogc291cmNlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFpbnRTY2FsZTogc291cmNlLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyU2NhbGU6IHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldEtleSA9IHRpbGVkUmFzdGVyS2V5KHNvdXJjZUtleSwgcmVxdWVzdGVkU2NhbGUoc291cmNlKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHdyaXRlci5idWlsZFRpbGVkVXJsKG5vZGUubmFtZSwgYXNzZXRLZXksICdwbmcnKVxyXG4gICAgICAgICAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpXHJcbiAgICAgICAgICAgICAgICAudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZSwgbm9kZXM6IFtdLCBzb3VyY2UsIHNvdXJjZUtleSwgYXNzZXRLZXkgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcclxuICAgICAgICBjb25zdCBuYW1lZExvY2FsVGlsZXMgPSBuZXcgTWFwPHN0cmluZywge1xyXG4gICAgICAgICAgICBtYXRjaDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBmaW5kTG9jYWw+PjtcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGw7XHJcbiAgICAgICAgfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5hbWVLZXkgPSByZXNvdXJjZUtleShncm91cC5ub2RlKTtcclxuICAgICAgICAgICAgbGV0IGxvY2FsID0gbmFtZWRMb2NhbFRpbGVzLmdldChuYW1lS2V5KTtcclxuICAgICAgICAgICAgaWYgKCFsb2NhbCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwoZ3JvdXAubm9kZS5uYW1lLCBmYWxzZSwgZ3JvdXAubm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBsb2NhbFVybCA9IG1hdGNoID8gYXNzZXREYXRhYmFzZVVybChtYXRjaC5wYXRoKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxVcmwgJiYgIWFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlkI7ph43or5XvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgbG9jYWwgPSB7IG1hdGNoLCBhc3NldCB9O1xyXG4gICAgICAgICAgICAgICAgbmFtZWRMb2NhbFRpbGVzLnNldChuYW1lS2V5LCBsb2NhbCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGxvY2FsLmFzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaWxpbmcgYW5kIGl0cyBwZXJpb2QgYmVsb25nIHRvIHRoaXMgbm9kZSwgbm90IHRoZSBzaGFyZWRcclxuICAgICAgICAgICAgICAgIC8vIFNwcml0ZUZyYW1lIE1ldGEuIEtlZXAgdGhlIG9yaWdpbmFsIFVVSUQgYW5kIHBpeGVscyBpbnRhY3QuXHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwLm5vZGVzLCB7IC4uLmxvY2FsLmFzc2V0LCBzbGljZWQ6IGZhbHNlLCB0aWxlZDogdHJ1ZSxcclxuICAgICAgICAgICAgICAgICAgICB0aWxlU2NhbGU6IHJlcXVlc3RlZFNjYWxlKGdyb3VwLnNvdXJjZSkgfSwgJ2xvY2FsJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobG9jYWwubWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgIC8vIEFuIGV4dGVybmFsIGJpdG1hcCBoYXMgbm8gcHJvamVjdCBVVUlELiBJbXBvcnQgaXQgdGhyb3VnaFxyXG4gICAgICAgICAgICAgICAgLy8gdGhlIGV4aXN0aW5nIGdlbmVyYXRlZC10aWxlIHBhdGgsIHdpdGggaXRzIHVuc2NhbGVkIHBpeGVscy5cclxuICAgICAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7IC4uLmdyb3VwLCBjb250ZW50czogbG9jYWwubWF0Y2guY29udGVudHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbC5tYXRjaC5jb250ZW50cyksIHNvdXJjZVR5cGU6ICdsb2NhbCcsIHNvdXJjZVJlbmRlclNjYWxlOiAxIH0pO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGV4aXN0aW5nQXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGV4aXN0aW5nQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmdGb3JTb3VyY2UoZ3JvdXBTb3VyY2VLZXkoZ3JvdXAuYXNzZXRLZXkpLCB7IHRpbGVkOiB0cnVlIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0Fzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwLm5vZGVzLCBwaXhlbFNpemVkVGlsZUFzc2V0KGV4aXN0aW5nQXNzZXQpLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBjYWNoZWRFeHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4dGVuc2lvbnM6IHJlYWRvbmx5IFJhc3RlckltYWdlRXh0ZW5zaW9uW10gPSBncm91cC5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gWydwbmcnXVxyXG4gICAgICAgICAgICAgICAgICAgIDogUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlM7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGV4dGVuc2lvbiBvZiBleHRlbnNpb25zKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gYXdhaXQgY2FjaGUucmVhZCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgdGlsZToke2dyb3VwLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IHJlbmRlclNjYWxlKGdyb3VwLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhY2hlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGNhY2hlZDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGVkRXh0ZW5zaW9uID0gZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGVuZGluZy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIC4uLmdyb3VwLFxyXG4gICAgICAgICAgICAgICAgY29udGVudHMsXHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb246IGNhY2hlZEV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgIHNvdXJjZVR5cGU6IGNvbnRlbnRzID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgcmVtb3RlSXRlbXMgPSBwZW5kaW5nLmZpbHRlcigoaXRlbSkgPT4gIWl0ZW0uY29udGVudHMpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5VcmxzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVybnNCeVNjYWxlID0gbmV3IE1hcDxudW1iZXIsIFNldDxzdHJpbmc+PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiByZW1vdGVJdGVtcykge1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5zb3VyY2Uua2luZCAhPT0gJ3NvdXJjZS1ub2RlJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2NhbGUgPSByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkcyA9IHBhdHRlcm5zQnlTY2FsZS5nZXQoc2NhbGUpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgICAgICBpZHMuYWRkKGl0ZW0uc291cmNlLmlkKTtcclxuICAgICAgICAgICAgcGF0dGVybnNCeVNjYWxlLnNldChzY2FsZSwgaWRzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBbc2NhbGUsIGlkc10gb2YgcGF0dGVybnNCeVNjYWxlKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIEFycmF5LmZyb20oaWRzKSxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2lkLCB1cmxdIG9mIE9iamVjdC5lbnRyaWVzKHVybHMpKSB7XHJcbiAgICAgICAgICAgICAgICBwYXR0ZXJuVXJscy5zZXQoYCR7aWR9OnNjYWxlOiR7c2NhbGV9YCwgdXJsKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuZWVkc0ltYWdlRmlsbHMgPSByZW1vdGVJdGVtcy5zb21lKChpdGVtKSA9PiBpdGVtLnNvdXJjZS5raW5kID09PSAnaW1hZ2UtcmVmJyk7XHJcbiAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IG5lZWRzSW1hZ2VGaWxsc1xyXG4gICAgICAgICAgICA/IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VGaWxsVXJscyhzZXNzaW9uLmZpbGVLZXkpXHJcbiAgICAgICAgICAgIDoge307XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZCA9ICh1cmw6IHN0cmluZywgbm9kZUxhYmVsOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHVybCk7XHJcbiAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHVybCwgbm9kZUxhYmVsKSk7XHJcbiAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHVybCwgdGFzayk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHRhc2s7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb24gPSBpdGVtLmV4dGVuc2lvbjtcclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gcGF0dGVyblVybHMuZ2V0KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgJHtpdGVtLnNvdXJjZS5pZH06c2NhbGU6JHtyZW5kZXJTY2FsZShpdGVtLnNvdXJjZSl9YCxcclxuICAgICAgICAgICAgICAgICAgICApXHJcbiAgICAgICAgICAgICAgICAgICAgOiBpbWFnZUZpbGxVcmxzW2l0ZW0uc291cmNlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8gYFBBVFRFUk4g5rqQ6IqC54K5ICR7aXRlbS5zb3VyY2UuaWR9YFxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGBJTUFHRSDloavlhYUgJHtpdGVtLnNvdXJjZS5pZH1gO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95o+Q5L6bJHtsYWJlbH3vvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBkb3dubG9hZChyZW1vdGVVcmwsIGAke2l0ZW0ubm9kZS5uYW1lfSAoJHtpdGVtLm5vZGUuaWR9KWApO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gJ3BuZydcclxuICAgICAgICAgICAgICAgICAgICA6IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgdGlsZToke2l0ZW0uc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgc2NhbGU6IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIWV4dGVuc2lvbikge1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCflubPpk7rotYTmupDmjInlrp7pmYXlsLrlr7jnlJ/miJAnLCB7IG5vZGU6IGl0ZW0ubm9kZS5uYW1lIH0pO1xyXG4gICAgICAgICAgICBsZXQgcmFzdGVyOiBSZXR1cm5UeXBlPHR5cGVvZiByYXN0ZXJpemVUaWxlPjtcclxuICAgICAgICAgICAgdHJ5IHsgcmFzdGVyID0gcmFzdGVyaXplVGlsZShjb250ZW50cywgcmVxdWVzdGVkU2NhbGUoaXRlbS5zb3VyY2UpLCBpdGVtLnNvdXJjZVJlbmRlclNjYWxlID8/IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSk7IH1cclxuICAgICAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3ml6Dms5XmjInlrp7pmYXlsLrlr7jnlJ/miJDvvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmFzdGVyLnJvdW5kZWQpIHdhcm5pbmdzLmFkZChg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3nmoTmmL7npLrlsLrlr7jlt7Llj5bmlbTkuLogJHtyYXN0ZXIud2lkdGh9w5cke3Jhc3Rlci5oZWlnaHR9IOWDj+e0oO+8iOacgOWwjyAx77yJ77yM6IqC54K5IFNjYWxlIOS/neaMgSAx44CCYCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFRpbGVkVXJsKGl0ZW0ubm9kZS5uYW1lLCBpdGVtLmFzc2V0S2V5LCAncG5nJyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgcGl4ZWxTaXplZFRpbGVBc3NldChhd2FpdCB3cml0ZXIucmVzb2x2ZSh1cmwsIHJhc3Rlci5jb250ZW50cywgeyBzb3VyY2VLZXk6IGdyb3VwU291cmNlS2V5KGl0ZW0uYXNzZXRLZXkpLCB0aWxlZDogdHJ1ZSB9KSksXHJcbiAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZVR5cGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIHRyYWNlLmRvbmUoeyBzb3VyY2VXaWR0aDogcmFzdGVyLnNvdXJjZVdpZHRoLCBzb3VyY2VIZWlnaHQ6IHJhc3Rlci5zb3VyY2VIZWlnaHQsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogcmFzdGVyLndpZHRoLCBoZWlnaHQ6IHJhc3Rlci5oZWlnaHQsIHRpbGVTY2FsZTogMSB9KTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSZW1vdGUgPSBhc3luYyAobm9kZXM6IEZpZ21hTm9kZVtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFub2Rlcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmb3JtYXQgPSAncG5nJyBhcyBjb25zdDtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyB1cmw6IHN0cmluZzsgbm9kZXM6IEZpZ21hTm9kZVtdIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfWAsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gcmVzb3VyY2VLZXkobm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgdXJsLCBub2RlczogW10gfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogQXJyYXk8e1xyXG4gICAgICAgICAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcclxuICAgICAgICAgICAgdXJsOiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGJvcmRlcnM/OiB7IGxlZnQ6IG51bWJlcjsgcmlnaHQ6IG51bWJlcjsgdG9wOiBudW1iZXI7IGJvdHRvbTogbnVtYmVyIH07XHJcbiAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM/OiBTbGljZUFuYWx5c2lzO1xyXG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XHJcbiAgICAgICAgICAgIGtleTogQ2FjaGVFbnRyeUtleTtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH0+ID0gW107XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgeyB1cmwsIG5vZGVzOiBncm91cGVkTm9kZXMgfSBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAvLyBBIGRlY2xhcmVkIEZpZ21hIHNsaWNlIG93bnMgdGhpcyBzYW1lLW5hbWUgcmVzb3VyY2UgZXZlbiB3aGVuIGFuXHJcbiAgICAgICAgICAgIC8vIG9yZGluYXJ5IFBORyB3YXMgZW5jb3VudGVyZWQgZmlyc3QuIElNQUdFIGFuZCBncmFkaWVudCBzdGFnZXNcclxuICAgICAgICAgICAgLy8gcnVuIGxhdGVyIGFuZCBzaGFyZSB0aGlzIHNpbmdsZSBnZW5lcmF0ZWQgcmVzdWx0LlxyXG4gICAgICAgICAgICBjb25zdCBzbGljZWRTb3VyY2VzID0gZ3JvdXBlZE5vZGVzLmZsYXRNYXAoKGNhbmRpZGF0ZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgaWYgKGRlY2lzaW9uRm9yTm9kZShjYW5kaWRhdGUsIGRlY2lzaW9ucykuYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIFtdO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYW5hbHlzaXMgPSBhbmFseXplU2xpY2VHcmlkKGNhbmRpZGF0ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gYW5hbHlzaXMgPyBbeyBub2RlOiBjYW5kaWRhdGUsIGFuYWx5c2lzIH1dIDogW107XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZFNsaWNlID0gc2xpY2VkU291cmNlc1swXTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IHNlbGVjdGVkU2xpY2U/Lm5vZGUgPz8gZ3JvdXBlZE5vZGVzWzBdO1xyXG4gICAgICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBzbGljZUFuYWx5c2lzID0gc2VsZWN0ZWRTbGljZT8uYW5hbHlzaXMgPz8gKGRlY2lzaW9uLm5pbmVTbGljZSA/IGFuYWx5emVTbGljZUdyaWQobm9kZSkgOiBudWxsKTtcclxuICAgICAgICAgICAgY29uc3QgcmV1c2VBc3NldCA9IChhc3NldDogU3ByaXRlQXNzZXRTcGVjLCBzb3VyY2U6ICdsb2NhbCcgfCAnZXhpc3RpbmcnKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBhc3NldCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlICYmICFhc3NldC5zbGljZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3lt7Lnm7TmjqXlvJXnlKjlkIzlkI3otYTmupDvvIzkvYbor6UgU3ByaXRlRnJhbWUg5pyq6YWN572u5Lmd5a6r6L656Led77yM5pqC5oyJ5pmu6YCaIFNwcml0ZSDmmL7npLrvvJvor7flnKjljp/otYTmupDkuK3orr7nva7ovrnot53vvJoke2Fzc2V0LnVybH1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXBlZE5vZGVzLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgY29uc3Qgc2hhcmVkID0gc2xpY2VBbmFseXNpcyA/IHVuZGVmaW5lZCA6IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkobm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoc2hhcmVkKSB7XHJcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpICYmICFzbGljZUFuYWx5c2lzID8gbnVsbCA6IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlLCBub2RlLmlkKTtcclxuICAgICAgICAgICAgLy8gQW4gZXhwbGljaXRseSBkZXNpZ25hdGVkIGxvY2FsIFNwcml0ZUZyYW1lIG93bnMgaXRzIHBpeGVscyBhbmRcclxuICAgICAgICAgICAgLy8gaW5zZXRzLiBSZXVzZSBpdCByZWFkLW9ubHksIGV2ZW4gd2hlbiBGaWdtYSBkZWZpbmVzIGEgc2xpY2Ugb3JcclxuICAgICAgICAgICAgLy8gcmVmcmVzaCBpcyByZXF1ZXN0ZWQ7IHNvdXJjZSBpbnNldHMgY2Fubm90IGJlIGFwcGxpZWQgdG8gYW5cclxuICAgICAgICAgICAgLy8gdW5rbm93biBvciBhbHJlYWR5LWNvbXBhY3RlZCBsb2NhbCBjYW52YXMuXHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbG9jYWxNYXRjaFxyXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcclxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KGxvY2FsQXNzZXQsIGxvY2FsTWF0Y2ghLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5pys5Zyw6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM6K+35YWI5ZyoIENvY29zIOS4reWujOaIkOi1hOa6kOWvvOWFpeW5tuiuvue9ruS4uiBTcHJpdGVGcmFtZSDlkI7ph43or5XvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke2xvY2FsVXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIXNsaWNlQW5hbHlzaXMgJiYgIWxvY2FsTWF0Y2ggJiYgIWFuYWx5emVNYXNrVGludChub2RlKSA/IGF3YWl0IGZpbmRPdXRwdXQobm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChuYW1lZE91dHB1dCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZWRBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5hbWVkQXNzZXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChuYW1lZEFzc2V0LCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChzZWxlY3RlZFNsaWNlICYmICFsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzaGFwZSA9IChlbnRyeTogdHlwZW9mIHNlbGVjdGVkU2xpY2UpID0+IEpTT04uc3RyaW5naWZ5KHsgbW9kZTogZW50cnkuYW5hbHlzaXMubW9kZSxcclxuICAgICAgICAgICAgICAgICAgICBib3JkZXJzOiBlbnRyeS5hbmFseXNpcy5ib3JkZXJzLCBmcmFtZTogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94ICYmIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveC53aWR0aCwgaGVpZ2h0OiBlbnRyeS5ub2RlLmFic29sdXRlQm91bmRpbmdCb3guaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIH0gfSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2xpY2VkU291cmNlcy5zbGljZSgxKS5zb21lKChlbnRyeSkgPT4gc2hhcGUoZW50cnkpICE9PSBzaGFwZShzZWxlY3RlZFNsaWNlKSkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCByZWFzb24gPSBg5ZCM5ZCN5LiJL+S5neWuq+WumuS5ieS4jeWQjO+8jOayv+eUqOmmluS4quacieaViCBGaWdtYSDliIfniYfigJwke25vZGUubmFtZX3igJ3nmoTljp/lp4vnlLvluIPkuI7ovrnot53vvIzku4XnlJ/miJDkuIDku73otYTmupBgO1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChyZWFzb24pO1xyXG4gICAgICAgICAgICAgICAgICAgIG5vdGUoJ21lcmdlZCcsIG5vZGUubmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbm90ZSgnbWVyZ2VkJywgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgICdGaWdtYSDkuIkv5Lmd5a6r5a6a5LmJ5LyY5YWI77ya5L2/55SoIEZpZ21hIOWOn+Wni+eUu+W4g+S4jui+uei3neeUn+aIkOi+k+WHuui1hOa6kO+8jOS4jeayv+eUqOacquaMh+Wumui+k+WHuui1hOa6kOeahOaXp+i+uei3nScsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhc2xpY2VBbmFseXNpcykge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5peg5rOV6K6h566X6L+e57ut5YiH54mH6L6555WM77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaVgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBib3JkZXJzID0gc2xpY2VBbmFseXNpcz8uYm9yZGVycztcclxuICAgICAgICAgICAgLy8gTmV3IHNsaWNlZCBhc3NldHMgcmV0YWluIHRoZWlyIGV4YWN0IGdlb21ldHJpYyBjYW52YXMgYmVjYXVzZVxyXG4gICAgICAgICAgICAvLyB0aGVpciBnZW5lcmF0ZWQgYm9yZGVycyB1c2UgdGhhdCBjb29yZGluYXRlIHNwYWNlLlxyXG4gICAgICAgICAgICBjb25zdCByZW5kZXJGcmFtZSA9IGJvcmRlcnMgPyB1bmRlZmluZWQgOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBrZXk6IENhY2hlRW50cnlLZXkgPSB7XHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBub2RlSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICB2YXJpYW50OiByZW5kZXJGcmFtZSA/ICd2aXN1YWwtb3ZlcmZsb3ctdjEnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBsZXQgY2FjaGVkID0gbG9jYWxNYXRjaCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgY2FjaGUucmVhZChrZXkpO1xyXG4gICAgICAgICAgICBpZiAoc2xpY2VBbmFseXNpcyAmJiBjYWNoZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94ITtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGlzRnVsbENhbnZhcyA9IGlzUG5nKGNhY2hlZCkgJiYgY2FjaGVkLmxlbmd0aCA+PSAyNFxyXG4gICAgICAgICAgICAgICAgICAgICYmIGNhY2hlZC50b1N0cmluZygnYXNjaWknLCAxMiwgMTYpID09PSAnSUhEUidcclxuICAgICAgICAgICAgICAgICAgICAmJiBNYXRoLmFicyhjYWNoZWQucmVhZFVJbnQzMkJFKDE2KSAtIGZyYW1lLndpZHRoICogaW1wb3J0U2V0dGluZ3Muc2NhbGUpIDw9IDFcclxuICAgICAgICAgICAgICAgICAgICAmJiBNYXRoLmFicyhjYWNoZWQucmVhZFVJbnQzMkJFKDIwKSAtIGZyYW1lLmhlaWdodCAqIGltcG9ydFNldHRpbmdzLnNjYWxlKSA8PSAxO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpc0Z1bGxDYW52YXMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjYWNoZWQgPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIG5vdGUoJ2ZhbGxiYWNrJywgbm9kZS5uYW1lLCAn57yT5a2Y5LiN5pivIEZpZ21hIOWujOaVtOeUu+W4g++8jOmHjeaWsOWvvOWHuuWOn+WniyBQTkcg5ZCO5YaN5bqU55So5LiJL+S5neWuq+i+uei3nScsIHVybCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGVuZGluZy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICBub2RlczogZ3JvdXBlZE5vZGVzLFxyXG4gICAgICAgICAgICAgICAgdXJsOiBsb2NhbE1hdGNoICYmIGRldGVjdEltYWdlRXh0ZW5zaW9uKGxvY2FsTWF0Y2guY29udGVudHMpID09PSAnanBnJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gdXJsLnJlcGxhY2UoL1xcLnBuZyQvaSwgJy5qcGcnKSA6IHVybCxcclxuICAgICAgICAgICAgICAgIGJvcmRlcnMsXHJcbiAgICAgICAgICAgICAgICBzbGljZUFuYWx5c2lzOiBzbGljZUFuYWx5c2lzID8/IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgIHJlbmRlckZyYW1lOiBsb2NhbE1hdGNoID8gdW5kZWZpbmVkIDogcmVuZGVyRnJhbWUsXHJcbiAgICAgICAgICAgICAgICBrZXksXHJcbiAgICAgICAgICAgICAgICBjb250ZW50czogbG9jYWxNYXRjaD8uY29udGVudHMgPz8gY2FjaGVkLFxyXG4gICAgICAgICAgICAgICAgc291cmNlOiBsb2NhbE1hdGNoID8gJ2xvY2FsJyA6IGNhY2hlZCA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdXJsczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4gPSB7fTtcclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgZm9yIChjb25zdCB1c2VBYnNvbHV0ZUJvdW5kcyBvZiBbdHJ1ZSwgZmFsc2VdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGJhdGNoID0gcmVtb3RlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiAoXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyA/ICFpdGVtLnJlbmRlckZyYW1lIDogQm9vbGVhbihpdGVtLnJlbmRlckZyYW1lKVxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICAgICAgaWYgKCFiYXRjaC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odXJscywgYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBiYXRjaC5tYXAoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzLFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmZyb21FbnRyaWVzKGJhdGNoLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlLm5hbWVdKSksXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IHVybHNbaXRlbS5ub2RlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73muLLmn5PoioLngrnvvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZShpdGVtLmtleSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGxldCBhc3NldDogU3ByaXRlQXNzZXRTcGVjO1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5zbGljZUFuYWx5c2lzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5LiJL+S5neWuq+i1hOa6kOacgOWwj+WMlicsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB3cml0ZVNsaWNlZFBuZyh3cml0ZXIsIGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc2xpY2VBbmFseXNpcywgaW1wb3J0U2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgICAgICAgICAgICAgYXNzZXQgPSByZXN1bHQuYXNzZXQ7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5kb25lKHJlc3VsdC5vcHRpbWl6YXRpb24pO1xyXG4gICAgICAgICAgICAgICAgbm90ZShhc3NldC5zbGljZUZhbGxiYWNrID8gJ2ZhbGxiYWNrJyA6ICdtZXJnZWQnLCBpdGVtLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBg5LiJL+S5neWuq++8miR7cmVzdWx0Lm9wdGltaXphdGlvbi5yZWFzb24gPz8gcmVzdWx0Lm9wdGltaXphdGlvbi5zdGF0dXN9YCwgYXNzZXQudXJsKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGFzc2V0ID0gYXdhaXQgd3JpdGVyLndyaXRlKGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ib3JkZXJzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub3RlV3JpdGUoYXNzZXQpO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KGl0ZW0ubm9kZSksIGFzc2V0KTtcclxuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5YiH54mH6K6+572u5aSx6LSl77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaXvvJoke2Fzc2V0LnNsaWNlRmFsbGJhY2t9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGdyb3VwZWROb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7IC4uLmFzc2V0LCByZW5kZXJGcmFtZTogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShncm91cGVkTm9kZSkgPz8gaXRlbS5yZW5kZXJGcmFtZSB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyBub2RlOiBGaWdtYU5vZGU7IG5vZGVzOiBGaWdtYU5vZGVbXTsgaW1hZ2VSZWY6IHN0cmluZyB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSByZXNvdXJjZUtleShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGU6IGl0ZW0ubm9kZSwgbm9kZXM6IFtdLCBpbWFnZVJlZjogaXRlbS5pbWFnZVJlZiB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4+IHwgdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVJbWFnZXMgPSAobm9kZXM6IEZpZ21hTm9kZVtdLCBiYXNlOiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdleGlzdGluZycgfCAnY2FjaGUnIHwgJ2ZpZ21hJykgPT4ge1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGVzWzBdKSwgYmFzZSk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgeyBpbm5lck9wYWNpdHkgfSA9IGltYWdlRGV0YWlscyhub2RlKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gaW5uZXJPcGFjaXR5IDwgMSA/IHsgLi4uYmFzZSwgdGludDogeyByOiAxLCBnOiAxLCBiOiAxLCBhOiBpbm5lck9wYWNpdHkgfSB9IDogYmFzZTtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNoYXJlZCA9IHNoYXJlZEFzc2V0cy5nZXQocmVzb3VyY2VLZXkoZ3JvdXAubm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoc2hhcmVkKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2Rlcywgc2hhcmVkLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHsgbGVhZiB9ID0gaW1hZ2VEZXRhaWxzKGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChncm91cC5ub2RlLm5hbWUsIGZhbHNlLCBncm91cC5ub2RlLmlkKTtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFsb2NhbEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgbG9jYWxBc3NldCwgbWF0Y2ghLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBuYW1lZE91dHB1dCA9ICFtYXRjaCA/IGF3YWl0IGZpbmRPdXRwdXQoZ3JvdXAubm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbmFtZWRPdXRwdXQgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUltYWdlcyhncm91cC5ub2RlcywgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGxldCBzb3VyY2U6ICdjYWNoZScgfCAnZmlnbWEnID0gJ2NhY2hlJztcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgY2FjaGUucmVhZCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBjYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gY2FuZGlkYXRlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpbWFnZUZpbGxVcmxzUHJvbWlzZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGltYWdlRmlsbFVybHNQcm9taXNlID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZ2V0SW1hZ2VGaWxsVXJscyhzZXNzaW9uLmZpbGVLZXkpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBhd2FpdCBpbWFnZUZpbGxVcmxzUHJvbWlzZTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGltYWdlRmlsbFVybHNbZ3JvdXAuaW1hZ2VSZWZdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+m+makOiXj+WbvueJh+Whq+WFhe+8miR7Z3JvdXAubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHJlbW90ZVVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtncm91cC5ub2RlLm5hbWV9ICgke2dyb3VwLm5vZGUuaWR9KWApKTtcclxuICAgICAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHJlbW90ZVVybCwgdGFzayk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IHRhc2s7XHJcbiAgICAgICAgICAgICAgICBzb3VyY2UgPSAnZmlnbWEnO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbiA/Pz0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbGVhZi5maWxscy5maW5kKChwYWludCkgPT4gcGFpbnQudmlzaWJsZSAhPT0gZmFsc2UgJiYgcGFpbnQudHlwZSA9PT0gJ0lNQUdFJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCByYXN0ZXIgPSByYXN0ZXJpemVJbWFnZUZpbGwoY29udGVudHMsIGZpbGw/LnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA9PT0gJ0ZJVCcgPyAnRklUJyA6ICdGSUxMJyxcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLCBmcmFtZS5oZWlnaHQsIGltcG9ydFNldHRpbmdzLnNjYWxlKTtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgZ3JvdXAubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fTppbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCByYXN0ZXIpO1xyXG4gICAgICAgICAgICBub3RlV3JpdGUocmVzb2x2ZWQpO1xyXG4gICAgICAgICAgICBpZiAoZ3JvdXAubm9kZS5jaGlsZHJlbi5sZW5ndGgpIG5vdGUoJ21lcmdlZCcsIGdyb3VwLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICfmma7pgJogSU1BR0Ug5Zyo6ZqQ6JeP5ZKM5pi+56S654q25oCB5L2/55So55u45ZCM5Lit5b+D6KOB5YiHL+mAgumFje+8m+a6kOWbvue8k+WtmOS/neeVmeWOn+Wni+WDj+e0oO+8jOiKgueCuemAj+aYjuW6puWNleeLrOW6lOeUqCcsIHJlc29sdmVkLnVybCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlSW1hZ2VzKGdyb3VwLm5vZGVzLCByZXNvbHZlZCwgc291cmNlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflubPpk7rotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy50aWxlZC5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1RpbGVkKHJlcXVlc3RzLnRpbGVkKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSHIFBORyDotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5wbmcubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5Y6f5aeLIElNQUdFIOWhq+WFhei1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1Jhd0ltYWdlcyhyZXF1ZXN0cy5yYXdJbWFnZXMpKTtcclxuXHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcmVxdWVzdHMuZ3JhZGllbnRzKSB7XHJcbiAgICAgICAgY29uc3Qgc2hhcmVkID0gc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShub2RlKSk7XHJcbiAgICAgICAgaWYgKHNoYXJlZCkge1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIHNoYXJlZCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuYW1lZCA9IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlLCBub2RlLmlkKTtcclxuICAgICAgICBjb25zdCBuYW1lZFVybCA9IG5hbWVkID8gYXNzZXREYXRhYmFzZVVybChuYW1lZC5wYXRoKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKG5hbWVkVXJsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKG5hbWVkVXJsKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZykgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkVXJsfWApO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBleGlzdGluZyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsIG5hbWVkIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbmFtZWQgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgIGlmIChuYW1lZE91dHB1dCkge1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBleGlzdGluZyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgIGNvbnN0IHBuZyA9IGZyYW1lICYmIGZpbGxcclxuICAgICAgICAgICAgPyBncmFkaWVudFBuZyhcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUuaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgZmlsbCxcclxuICAgICAgICAgICAgICAgIGNvcm5lclJhZGlpKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChwbmcpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9OmdyYWRpZW50YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcG5nKTtcclxuICAgICAgICAgICAgbm90ZVdyaXRlKGFzc2V0KTtcclxuICAgICAgICAgICAgc2hhcmVkQXNzZXRzLnNldChyZXNvdXJjZUtleShub2RlKSwgYXNzZXQpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCAnZ2VuZXJhdGVkJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOeUn+aIkOa4kOWPmCAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZXZlbnQgb2Ygd3JpdGVyLmV2ZW50cykgbm90ZShldmVudC5hY3Rpb24sIGJhc2VuYW1lKGV2ZW50LnVybCksIGV2ZW50LnJlYXNvbiwgZXZlbnQudXJsKTtcclxuICAgIHJldHVybiB7IGFzc2V0cywgd2FybmluZ3M6IFsuLi53YXJuaW5nc10gfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUZvbnRzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8TWFwPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZhbWlseSwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKSkge1xyXG4gICAgICAgIGlmICghdXJsKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgcmVzb2x2ZUFzc2V0VXVpZCh1cmwpO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQoZmFtaWx5LCB1dWlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlcnJlZExheW91dE1vZGUobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IG5hdGl2ZU1vZGUgPSBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKTtcclxuICAgIGlmIChuYXRpdmVNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIG5hdGl2ZU1vZGU7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIFJlY3QgPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcclxuICAgIGNvbnN0IGNlbnRlcnNZID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQgLyAyKTtcclxuICAgIGNvbnN0IHNwcmVhZFggPSBNYXRoLm1heCguLi5jZW50ZXJzWCkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWCk7XHJcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xyXG4gICAgaWYgKHNwcmVhZFkgPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnSE9SSVpPTlRBTCc7XHJcbiAgICB9XHJcbiAgICBpZiAoc3ByZWFkWCA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ0dSSUQnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFrZVNwZWMoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcGxhbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+LFxyXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPixcclxuICAgIGZvbnRzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbiAgICBwYXJlbnRXb3JsZFJvdGF0aW9uID0gMCxcclxuICAgIHN5bmM/OiB7IGZpbGVLZXk6IHN0cmluZyB9LFxyXG4pOiBTY2VuZU5vZGVTcGVjIHwgbnVsbCB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgcGxhbiA9IHBsYW5zLmdldChub2RlLmlkKTtcclxuICAgIGNvbnN0IGZvbGQgPSBwbGFuPy5mb2xkO1xyXG4gICAgY29uc3QgZm9sZFNvdXJjZSA9IGZvbGQgPyBub2RlQnlJZC5nZXQoZm9sZC5zb3VyY2VOb2RlSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgdGV4dFNvdXJjZSA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgdmlzdWFsU291cmNlID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgcmVzb2x2ZWRLaW5kID0gZGVjaXNpb24ua2luZCA9PT0gJ2F1dG8nID8gaW5mZXJLaW5kKG5vZGUpIDogZGVjaXNpb24ua2luZDtcclxuICAgIGNvbnN0IHBsYW5uZWRLaW5kID0gcGxhbj8ua2luZCA/PyByZXNvbHZlZEtpbmQ7XHJcbiAgICBjb25zdCBiaXRtYXBUZXJtaW5hbCA9IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInO1xyXG4gICAgY29uc3QgdGVybWluYWwgPSBiaXRtYXBUZXJtaW5hbCB8fCBpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbik7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0ga2luZEZvckltcG9ydEFjdGlvbihwbGFubmVkS2luZCwgZGVjaXNpb24uYWN0aW9uLCBkZWNpc2lvbi5uaW5lU2xpY2UpO1xyXG4gICAgY29uc3Qgc3ByaXRlU291cmNlSWQgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0J1xyXG4gICAgICAgID8gZm9sZC5zb3VyY2VOb2RlSWRcclxuICAgICAgICA6IG5vZGUuaWQ7XHJcbiAgICBjb25zdCBzcHJpdGVBc3NldCA9IGFzc2V0cy5nZXQoc3ByaXRlU291cmNlSWQpO1xyXG4gICAgY29uc3QgYWJzb3JiZWREaXJlY3RJZHMgPSBuZXcgU2V0KGZvbGQgPyBbZm9sZC5zb3VyY2VOb2RlSWRdIDogW10pO1xyXG4gICAgY29uc3QgZnVsbEZvbGQgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLWltYWdlJyB8fCBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IHBhcmVudFdvcmxkUm90YXRpb24gKyBub2RlLnJvdGF0aW9uO1xyXG4gICAgLy8g5oqY5Y+g5Yiw5pys6IqC54K555qE5a2Q5bGCIGlkIOS4jiBhbGlhc0ZpZ21hSWRzIOS4gOiHtO+8m+agh+iusOWPquiusOW9leiBmuWQiOi6q+S7ve+8jFxyXG4gICAgLy8g5LiN6K+V5Zu+5Li65oqY5Y+g5a2Q5bGC5Y2V54us5bu66IqC54K544CCXHJcbiAgICBjb25zdCBzeW5jTWFya2VyOiBTeW5jTWFya2VyU3BlYyB8IHVuZGVmaW5lZCA9IHN5bmNcclxuICAgICAgICA/IGNyZWF0ZVN5bmNNYXJrZXIoe1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBzeW5jLmZpbGVLZXksXHJcbiAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgIGFsaWFzTm9kZUlkczogZm9sZD8uYWJzb3JiZWROb2RlSWRzID8/IFtdLFxyXG4gICAgICAgIH0pXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpZ21hSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgbmFtZTogZGVjaXNpb24ubmFtZSA/PyBub2RlLm5hbWUsXHJcbiAgICAgICAgZmlnbWFUeXBlOiB2aXN1YWxTb3VyY2UudHlwZSxcclxuICAgICAgICBhY3Rpb246IGRlY2lzaW9uLmFjdGlvbixcclxuICAgICAgICBraW5kOiBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGZyYW1lLFxyXG4gICAgICAgIHBhcmVudEZyYW1lLFxyXG4gICAgICAgIGludHJpbnNpY1NpemU6IG5vZGUuc2l6ZSxcclxuICAgICAgICBpc1Jvb3QsXHJcbiAgICAgICAgcm90YXRpb246IG5vZGUucm90YXRpb24sXHJcbiAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICBvcGFjaXR5OiBmb2xkU291cmNlICYmIGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gbm9kZS5vcGFjaXR5ICogZm9sZFNvdXJjZS5vcGFjaXR5XHJcbiAgICAgICAgICAgIDogbm9kZS5vcGFjaXR5LFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50LFxyXG4gICAgICAgIGNvcm5lclJhZGlpOiBjb3JuZXJSYWRpaSh2aXN1YWxTb3VyY2UpLFxyXG4gICAgICAgIGZpbGxzOiB0ZXh0U291cmNlLmZpbGxzLFxyXG4gICAgICAgIHN0cm9rZXM6IHRleHRTb3VyY2Uuc3Ryb2tlcyxcclxuICAgICAgICBzdHJva2VXZWlnaHQ6IHRleHRTb3VyY2Uuc3Ryb2tlV2VpZ2h0LFxyXG4gICAgICAgIGNoYXJhY3RlcnM6IHRleHRTb3VyY2UuY2hhcmFjdGVycyxcclxuICAgICAgICB0ZXh0U3R5bGU6IHRleHRTb3VyY2Uuc3R5bGUsXHJcbiAgICAgICAgbGF5b3V0OiB7XHJcbiAgICAgICAgICAgIG1vZGU6IGVmZmVjdGl2ZUtpbmQgPT09ICdsYXlvdXQnIHx8IGVmZmVjdGl2ZUtpbmQgPT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICAgICAgICAgPyBpbmZlcnJlZExheW91dE1vZGUobm9kZSlcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBzb3VyY2VNb2RlOiBub2RlLmxheW91dE1vZGUsXHJcbiAgICAgICAgICAgIHdyYXA6IG5vZGUubGF5b3V0V3JhcCxcclxuICAgICAgICAgICAgcHJpbWFyeUFsaWduOiBub2RlLnByaW1hcnlBeGlzQWxpZ25JdGVtcyxcclxuICAgICAgICAgICAgY291bnRlckFsaWduOiBub2RlLmNvdW50ZXJBeGlzQWxpZ25JdGVtcyxcclxuICAgICAgICAgICAgcHJpbWFyeVNpemluZzogbm9kZS5wcmltYXJ5QXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTaXppbmc6IG5vZGUuY291bnRlckF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBpdGVtU3BhY2luZzogbm9kZS5pdGVtU3BhY2luZyxcclxuICAgICAgICAgICAgY291bnRlclNwYWNpbmc6IG5vZGUuY291bnRlckF4aXNTcGFjaW5nLFxyXG4gICAgICAgICAgICBwYWRkaW5nTGVmdDogbm9kZS5wYWRkaW5nTGVmdCxcclxuICAgICAgICAgICAgcGFkZGluZ1JpZ2h0OiBub2RlLnBhZGRpbmdSaWdodCxcclxuICAgICAgICAgICAgcGFkZGluZ1RvcDogbm9kZS5wYWRkaW5nVG9wLFxyXG4gICAgICAgICAgICBwYWRkaW5nQm90dG9tOiBub2RlLnBhZGRpbmdCb3R0b20sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBvdmVyZmxvd0RpcmVjdGlvbjogbm9kZS5vdmVyZmxvd0RpcmVjdGlvbixcclxuICAgICAgICBjb25zdHJhaW50czogbm9kZS5jb25zdHJhaW50cyxcclxuICAgICAgICByZWxhdGl2ZVRyYW5zZm9ybTogbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybSxcclxuICAgICAgICBzcHJpdGU6IHNwcml0ZUFzc2V0LFxyXG4gICAgICAgIGZvbnRVdWlkOiB0ZXh0U291cmNlLnN0eWxlPy5mb250RmFtaWx5ID8gZm9udHMuZ2V0KHRleHRTb3VyY2Uuc3R5bGUuZm9udEZhbWlseSkgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogZm9sZD8uYWJzb3JiZWROb2RlSWRzLFxyXG4gICAgICAgIGZsYXR0ZW5Cb3VuZGFyeTogYml0bWFwVGVybWluYWwgfHwgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyB0cnVlXHJcbiAgICAgICAgICAgIDogZm9sZD8ua2luZCA9PT0gJ2JhY2tncm91bmQnXHJcbiAgICAgICAgICAgICAgICA/IGZhbHNlXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICBwbGFuUmVhc29uOiBwbGFuPy5yZWFzb24sXHJcbiAgICAgICAgc3luY01hcmtlcixcclxuICAgICAgICBjaGlsZHJlbjogdGVybWluYWxcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKSA9PiAhYWJzb3JiZWREaXJlY3RJZHMuaGFzKGNoaWxkLmlkKSlcclxuICAgICAgICAgICAgICAgIC5tYXAoKGNoaWxkKSA9PiBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZCxcclxuICAgICAgICAgICAgICAgICAgICBmcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgc3luYyxcclxuICAgICAgICAgICAgICAgICkpXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCk6IGNoaWxkIGlzIFNjZW5lTm9kZVNwZWMgPT4gY2hpbGQgIT09IG51bGwpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZU1hcHMoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvY29zRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBFZGl0b3IuVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICByZXR1cm4gdHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDBcclxuICAgICAgICA/IGdlbmVyYXRlZFxyXG4gICAgICAgIDogcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjQnKS5yZXBsYWNlKC89KyQvZywgJycpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYkFzc2V0KHVybE9yVXVpZDogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8gfCBudWxsPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcclxuICAgICAgICB1cmxPclV1aWQsXHJcbiAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydFByZWZhYkFzc2V0KFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgZXhwZWN0ZWQ6IHsgdXVpZD86IHN0cmluZzsgdXJsPzogc3RyaW5nIH0gPSB7fSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoaW5mby5pbnZhbGlkIHx8IGluZm8uaW1wb3J0ZWQgIT09IHRydWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlsJrmnKrlrozmiJDlr7zlhaXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8uaW1wb3J0ZXIgIT09ICdwcmVmYWInIHx8IGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicgfHwgaW5mby5pc0RpcmVjdG9yeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCH6LWE5rqQ5LiN5piv5Y+v57yW6L6R55qEIENvY29zIFByZWZhYu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5yZWFkb25seSB8fCBpbmZvLnJlZGlyZWN0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOS4uuWPquivu+aIlumHjeWumuWQkei1hOa6kO+8jOS4jeiDveWuieWFqOabtOaWsO+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkLnV1aWQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOagoemqjOWksei0pe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXJsICYmIGluZm8udXJsICE9PSBleHBlY3RlZC51cmwpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDot6/lvoTmoKHpqozlpLHotKXvvJrmnJ/mnJsgJHtleHBlY3RlZC51cmx977yM5a6e6ZmFICR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JQcmVmYWJBc3NldCh1cmw6IHN0cmluZywgZXhwZWN0ZWRVdWlkPzogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodXJsKTtcclxuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvY29zIFByZWZhYiDotYTmupDlr7zlhaXlpLHotKXvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGluZm8/LmltcG9ydGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIGlmIChleHBlY3RlZFV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5Zyo5a+85YWl5pyf6Ze05Y+R55Sf5Y+Y5YyW77yaJHt1cmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQoaW5mbywgeyB1dWlkOiBleHBlY3RlZFV1aWQsIHVybCB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGluZm87XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3MgUHJlZmFiIOi1hOa6kOWwsee7qui2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYk1ldGEodXVpZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xyXG4gICAgY29uc3QgbWV0YSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgdXVpZCxcclxuICAgICk7XHJcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xor7vlj5YgUHJlZmFiIE1ldGHvvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IG1ldGEgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgIGlmICh2YWx1ZS51dWlkICE9PSB1dWlkIHx8IHZhbHVlLmltcG9ydGVyICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIE1ldGEg5LiO55uu5qCH6LWE5rqQ5LiN5Yy56YWN77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJEaXNrUGF0aCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVJMIOaXoOaViO+8miR7dXJsfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgdXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTeW5jTWFya2VyU2NyaXB0KHVybDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDE1XzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdxdWVyeS1hc3NldC1pbmZvJywgdXJsKSBhcyB7XHJcbiAgICAgICAgICAgIHV1aWQ/OiBzdHJpbmc7XHJcbiAgICAgICAgfSB8IG51bGw7XHJcbiAgICAgICAgaWYgKHR5cGVvZiBpbmZvPy51dWlkID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMDApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIOWvvOWFpee7hOS7tuWQjOatpeagh+iusOiEmuacrOi2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG4vKipcclxuICog57uE5Lu25ZCM5q2l6ZyA6KaB5Zyo6aG555uu6YeM5pyJ5LiA5Liq5p6B5bCP55qE5qCH6K6w57uE5Lu26ISa5pys44CC6aaW5qyh5a+85YWl5pe255Sf5oiQ77yMXHJcbiAqIOS5i+WQjuavj+asoeWvvOWFpeagoemqjO+8m+iiq+WFtuS7luiEmuacrOWNoOeUqOaXtiBmYWlsLWNsb3NlZO+8jOiiq+aIquaWreaIluaUueaXp+aXtumHjeW7uuOAglxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlU3luY01hcmtlclNjcmlwdCgpOiBQcm9taXNlPHsgYWN0aW9uOiBzdHJpbmc7IHJlYXNvbj86IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCB1cmwgPSBTWU5DX01BUktFUl9TQ1JJUFRfVVJMO1xyXG4gICAgbGV0IGV4aXN0aW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aCh1cmwpLCAndXRmOCcpO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgZXhpc3RpbmcgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGxhbiA9IHBsYW5TeW5jTWFya2VyU2NyaXB0KGV4aXN0aW5nKTtcclxuICAgIGlmIChwbGFuLmFjdGlvbiA9PT0gJ3JlamVjdCcpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocGxhbi5yZWFzb24pO1xyXG4gICAgfVxyXG4gICAgaWYgKHBsYW4uYWN0aW9uID09PSAna2VlcCcpIHtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yU3luY01hcmtlclNjcmlwdCh1cmwpO1xyXG4gICAgICAgIHJldHVybiB7IGFjdGlvbjogJ2tlZXAnIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbmZvID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncXVlcnktYXNzZXQtaW5mbycsIHVybCkgYXMge1xyXG4gICAgICAgIHV1aWQ/OiBzdHJpbmc7XHJcbiAgICB9IHwgbnVsbDtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdjcmVhdGUtYXNzZXQnLCB1cmwsIHBsYW4uY29udGVudCwge1xyXG4gICAgICAgICAgICBvdmVyd3JpdGU6IGZhbHNlLFxyXG4gICAgICAgICAgICByZW5hbWU6IGZhbHNlLFxyXG4gICAgICAgIH0pIGFzIHsgdXVpZD86IHN0cmluZyB9IHwgbnVsbDtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7rnu4Tku7blkIzmraXmoIforrDohJrmnKzvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3NhdmUtYXNzZXQnLCB1cmwsIHBsYW4uY29udGVudCk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCB3YWl0Rm9yU3luY01hcmtlclNjcmlwdCh1cmwpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IHBsYW4uYWN0aW9uLFxyXG4gICAgICAgIHJlYXNvbjogcGxhbi5hY3Rpb24gPT09ICdyZXdyaXRlJyA/IHBsYW4ucmVhc29uIDogdW5kZWZpbmVkLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdFN5bmNNYXJrZXJTcGVjcyhzcGVjczogcmVhZG9ubHkgU2NlbmVOb2RlU3BlY1tdKTogU3luY01hcmtlclNwZWNbXSB7XHJcbiAgICBjb25zdCBtYXJrZXJzOiBTeW5jTWFya2VyU3BlY1tdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlczogcmVhZG9ubHkgU2NlbmVOb2RlU3BlY1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChub2RlLnN5bmNNYXJrZXIpIHtcclxuICAgICAgICAgICAgICAgIG1hcmtlcnMucHVzaChub2RlLnN5bmNNYXJrZXIpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHZpc2l0KG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICB2aXNpdChzcGVjcyk7XHJcbiAgICByZXR1cm4gbWFya2VycztcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHJldHVybiBwcmVmYWJKc29uQ29udGFpbnNTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aChpbmZvLnVybCkpLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nLFxyXG4gICAgcm9vdEZpbGVJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGN1cnJlbnREaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgIGlmIChjdXJyZW50RGlydHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeaJk+W8gOeahOWcuuaZr+aIliBQcmVmYWIg5pyJ5pyq5L+d5a2Y5L+u5pS577yb5Li66YG/5YWN6Kem5Y+R5L+d5a2Y6K+i6Zeu77yM6K+35YWI5omL5bel5L+d5a2Y5oiW6L+Y5Y6f5ZCO5YaN5a+85YWl44CCJyk7XHJcbiAgICB9XHJcbiAgICBFZGl0b3IuU2VsZWN0aW9uLmNsZWFyKCdub2RlJyk7XHJcbiAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVmYWJVdWlkKTtcclxuICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ29wZW4tYXNzZXQnLCBwcmVmYWJVdWlkKTtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgbGV0IGxhc3RSZWFzb24gPSAnQ3JlYXRvciDlsJrmnKrov5Tlm54gUHJlZmFiIOe8lui+keeKtuaAgSc7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICAgICAgICAgIGFyZ3M6IFt7IHByZWZhYlV1aWQsIHJvb3RGaWxlSWQgfV0sXHJcbiAgICAgICAgICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IHN0YXRlLnJlYXNvbiA/PyBsYXN0UmVhc29uO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDmiZPlvIDnm67moIcgUHJlZmFiIOi2heaXtu+8miR7bGFzdFJlYXNvbn1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYXNzZXJ0T3BlbmVkUHJlZmFiKHByZWZhYlV1aWQ6IHN0cmluZywgcm9vdEZpbGVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgIGFyZ3M6IFt7IHByZWZhYlV1aWQsIHJvb3RGaWxlSWQgfV0sXHJcbiAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICBpZiAoIXN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOe8lui+keS4iuS4i+aWh+W3suWPmOWMlu+8miR7c3RhdGUucmVhc29uID8/ICfmnKrnn6Xljp/lm6AnfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yU2NlbmVTYXZlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMTVfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgZGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICAgICAgaWYgKCFkaXJ0eSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcign562J5b6FIFByZWZhYiDkv53lrZjlrozmiJDotoXml7bjgIInKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UHJlZmFiQmluZGluZ3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcHJlZmFiVXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiBwcmVmYWJVdWlkICE9PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICB8fCAhcHJlZmFiVXVpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDnu5HlrprorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0W3NvdXJjZUhhc2hdID0gcHJlZmFiVXVpZDtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nLCBwcmVmYWJVdWlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGJpbmRpbmdzW3NvdXJjZUhhc2hdID0gcHJlZmFiVXVpZDtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGlmICghYmluZGluZ3Nbc291cmNlSGFzaF0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZWxldGUgYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBlbmRpbmdQcmVmYWJTeW5jcygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHtcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwZW5kaW5nUHJlZmFiU3luY1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCByYXddIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCAhcmF3XHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiByYXcgIT09ICdvYmplY3QnXHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiAocmF3IGFzIHsgcHJlZmFiVXVpZD86IHVua25vd24gfSkucHJlZmFiVXVpZCAhPT0gJ3N0cmluZycpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKHtcclxuICAgICAgICAgICAgdXNlckRhdGE6IHtcclxuICAgICAgICAgICAgICAgIGZpZ21hSW1wb3J0ZXI6IChyYXcgYXMgeyByZWNvcmQ/OiB1bmtub3duIH0pLnJlY29yZCxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoIXJlY29yZCB8fCByZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXmnaXmupDkuI3kuIDoh7TvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0W3NvdXJjZUhhc2hdID0ge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiAocmF3IGFzIHsgcHJlZmFiVXVpZDogc3RyaW5nIH0pLnByZWZhYlV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UGVuZGluZ1ByZWZhYlN5bmMoXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9IHwgbnVsbCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBwZW5kaW5nID0gYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk7XHJcbiAgICBpZiAodmFsdWUpIHtcclxuICAgICAgICBwZW5kaW5nW3NvdXJjZUhhc2hdID0gdmFsdWU7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBwZW5kaW5nW3NvdXJjZUhhc2hdO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwZW5kaW5nUHJlZmFiU3luY1YxJyxcclxuICAgICAgICBwZW5kaW5nLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHsgbWV0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiB7XHJcbiAgICBsZXQgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgbGV0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgaWYgKCFyZWNvcmQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgIGBQcmVmYWIg57y65bCRIEZpZ21hIOadpea6kOiusOW9le+8jOaXoOazleehruiupOaYr+WQpuWPr+WuieWFqOimhueblu+8miR7aW5mby51cmx944CC6K+35YWI56e75Yqo5oiW6YeN5ZG95ZCN6K+l6LWE5rqQ44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5p2l6Ieq5Y+m5LiA5LiqIEZpZ21hIEZyYW1l77yM5bey5ouS57ud6KaG55uW77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgaWYgKHBlbmRpbmcpIHtcclxuICAgICAgICBpZiAocGVuZGluZy5wcmVmYWJVdWlkICE9PSBpbmZvLnV1aWQgfHwgcGVuZGluZy5yZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ajgOa1i+WIsOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie055qE5b6F5oGi5aSN5ZCM5q2l6K6w5b2V77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGluZm8sIHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHBlbmRpbmcucmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgICAgICAgICBpZiAoIXJlY292ZXJlZCB8fCBKU09OLnN0cmluZ2lmeShyZWNvdmVyZWQpICE9PSBKU09OLnN0cmluZ2lmeShwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeiusOW9leiHquWKqOaBouWkjeWksei0peOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlY29yZCA9IHJlY292ZXJlZDtcclxuICAgICAgICB9IGVsc2UgaWYgKCFhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGluZm8sIHJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25LiO5b2T5YmN5Y+K5b6F5oGi5aSN55qE5ZCM5q2l6K6w5b2V6YO95LiN5LiA6Ie077yM5bey5YGc5q2i6Ieq5Yqo5oGi5aSN44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgbWV0YSwgcmVjb3JkIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcclxuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDwgMzsgYXR0ZW1wdCArPSAxKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nIHx8IGV4aXN0aW5nLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5YaZ5YWl5YmNIFByZWZhYiDmnaXmupDorrDlvZXkuI3kuIDoh7TjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3Qgc2F2ZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKSk7XHJcbiAgICAgICAgICAgIGlmICghc2F2ZWQgfHwgSlNPTi5zdHJpbmdpZnkoc2F2ZWQpICE9PSBKU09OLnN0cmluZ2lmeShyZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlhpnlhaXlkI7moKHpqozkuI3kuIDoh7TjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdEVycm9yID0gZXJyb3I7XHJcbiAgICAgICAgICAgIGlmIChhdHRlbXB0IDwgMikge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDE1MCkpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgdGhyb3cgbGFzdEVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBsYXN0RXJyb3IgOiBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlhpnlhaXlpLHotKXjgIInKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmcsXHJcbiAgICByb290RnJhbWU6IFJlY3QsXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICBzb3VyY2VSb290SWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7XHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm87XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGNvbnN0IGJvdW5kVXVpZCA9IGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nSW5mbyA9IHBlbmRpbmdcclxuICAgICAgICA/IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocGVuZGluZy5wcmVmYWJVdWlkKVxyXG4gICAgICAgIDogbnVsbDtcclxuICAgIGNvbnN0IHRhcmdldFBsYW4gPSBwbGFuUHJlZmFiUmVjb3ZlcnlUYXJnZXQoXHJcbiAgICAgICAgcGVuZGluZz8ucHJlZmFiVXVpZCxcclxuICAgICAgICBib3VuZFV1aWQsXHJcbiAgICAgICAgQm9vbGVhbihwZW5kaW5nSW5mbyksXHJcbiAgICApO1xyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJQZW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhckJpbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGFyZ2V0VXVpZCA9IHRhcmdldFBsYW4udGFyZ2V0VXVpZDtcclxuICAgIGlmICh0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgbGV0IHRhcmdldEluZm8gPSBwZW5kaW5nSW5mbz8udXVpZCA9PT0gdGFyZ2V0VXVpZFxyXG4gICAgICAgICAgICA/IHBlbmRpbmdJbmZvXHJcbiAgICAgICAgICAgIDogYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh0YXJnZXRVdWlkKTtcclxuICAgICAgICBpZiAoIXRhcmdldEluZm8pIHtcclxuICAgICAgICAgICAgaWYgKGJpbmRpbmdzW3NvdXJjZUhhc2hdID09PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldCh0YXJnZXRJbmZvLnVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgIGlmIChwZW5kaW5nPy5wcmVmYWJVdWlkID09PSB0YXJnZXRVdWlkICYmIGJvdW5kVXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgLy8gUGVyc2lzdCB0aGUgcmVjb3ZlcnkgaWRlbnRpdHkgYmVmb3JlIHZlcmlmaWVkUHJlZmFiUmVjb3JkIG1heVxyXG4gICAgICAgICAgICAgICAgLy8gY29tbWl0IGFuZCBjbGVhciBwZW5kaW5nLiBBIGxhdGVyIG1vdmUgZmFpbHVyZSBtdXN0IHN0aWxsIGJlXHJcbiAgICAgICAgICAgICAgICAvLyBhYmxlIHRvIGxvY2F0ZSB0aGUgZXhhY3QgUHJlZmFiIGJ5IFVVSUQgb24gdGhlIG5leHQgYXR0ZW1wdC5cclxuICAgICAgICAgICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZCh0YXJnZXRJbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgaWYgKHRhcmdldEluZm8udXJsICE9PSBwcmVmYWJVcmwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbmZsaWN0ID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVmYWJVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbmZsaWN0ICYmIGNvbmZsaWN0LnV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGBGaWdtYSBGcmFtZSDlr7nlupTnmoQgUHJlZmFiIOmcgOimgeenu+WKqOWIsCAke3ByZWZhYlVybH3vvIzkvYbnm67moIfot6/lvoTlt7Looqvlhbbku5botYTmupDljaDnlKjjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIWNvbmZsaWN0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW92ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAnbW92ZS1hc3NldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8udXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICAgICAgICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIW1vdmVkIHx8IG1vdmVkLnV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlnKjkv53nlZkgVVVJRCDnmoTliY3mj5DkuIvnp7vliqggUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBpbmZvOiB0YXJnZXRJbmZvLFxyXG4gICAgICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGxldCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVmYWJVcmwpO1xyXG4gICAgaWYgKCFpbmZvKSB7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZpbGVJZCA9IGNvY29zRmlsZUlkKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdFRyYW5zZm9ybUZpbGVJZCA9IGNvY29zRmlsZUlkKCk7XHJcbiAgICAgICAgY29uc3Qgc2VlZCA9IGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uKFxyXG4gICAgICAgICAgICBwcmVmYWJOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgJ2NyZWF0ZS1hc3NldCcsXHJcbiAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgc2VlZCxcclxuICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgIGlmICghY3JlYXRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWIm+W7uiBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGNyZWF0ZWQudXVpZCk7XHJcbiAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IHJlY29yZCA9IGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgICAgIHNvdXJjZVJvb3RJZCxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IG5leHRNZXRhID0gbWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobmV4dE1ldGEsIG51bGwsIDIpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQoaW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGluZm8sXHJcbiAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQoaW5mbywgc291cmNlSGFzaCk7XHJcbiAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGluZm8sXHJcbiAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYihhcmdzOiB7XHJcbiAgICByZXZpZXdJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBzb3VyY2VOb2RlSWQ6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG4gICAgLyoqIOacquWLvumAieeahOiKgueCue+8muS/neeVmeWug+S7rOWcqCBQcmVmYWIg6YeM55qE546w5pyJ6IqC54K577yM5LiN5Y+C5LiO5pys5qyh5riF55CG44CCICovXHJcbiAgICBza2lwU3luY05vZGVJZHM/OiBSZWFkb25seVNldDxzdHJpbmc+O1xyXG59KTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3Qgc291cmNlSGFzaCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKGFyZ3MuZmlsZUtleSwgYXJncy5zb3VyY2VOb2RlSWQpO1xyXG4gICAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICAgICAgYXJncy5wcmVmYWJVcmwsXHJcbiAgICAgICAgYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgeDogYXJncy5yb290RnJhbWUueCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHk6IGFyZ3Mucm9vdEZyYW1lLnkgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB3aWR0aDogYXJncy5yb290RnJhbWUud2lkdGggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICBoZWlnaHQ6IGFyZ3Mucm9vdEZyYW1lLmhlaWdodCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgIGFyZ3Mucm9vdHNbMF0uZmlnbWFJZCxcclxuICAgICk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICk7XHJcbiAgICBjb25zdCBleGlzdGluZ05vZGVGaWxlSWRzID0gcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMoXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLFxyXG4gICAgICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyhhcmdzLnJvb3RzKSxcclxuICAgICk7XHJcbiAgICAvLyDmnKrli77pgInnmoToioLngrnlnKjmnKzmrKHorqHliJLph4zkuI3lrZjlnKjvvIzkvYblroPku6zku43lsZ7kuo7lj5fnrqHoioLngrnvvJrmiorlt7Lnn6UgZmlsZUlkIOS8oOe7mVxyXG4gICAgLy8gU2NlbmUg5L2c5Li65L+d55WZ6ZuG5ZCI77yM6YG/5YWNXCLliKDpmaRcIuWIhuaUr+aKiuWug+S7rOa4heaOieOAglxyXG4gICAgY29uc3QgcmV0YWluTm9kZUZpbGVJZHMgPSBhcmdzLnNraXBTeW5jTm9kZUlkcz8uc2l6ZVxyXG4gICAgICAgID8gT2JqZWN0LnZhbHVlcyhyZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyhwcmVwYXJlZC5yZWNvcmQsIGFyZ3Muc2tpcFN5bmNOb2RlSWRzKSlcclxuICAgICAgICA6IFtdO1xyXG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgIHJldmlld0lkOiBhcmdzLnJldmlld0lkLFxyXG4gICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcclxuICAgICAgICByb290TmFtZTogYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHJvb3RGcmFtZTogYXJncy5yb290RnJhbWUsXHJcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgZXhpc3RpbmdNYXA6IHt9LFxyXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcmV0YWluTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgcm9vdHM6IGFyZ3Mucm9vdHMsXHJcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQ6IHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XHJcbiAgICBsZXQgc2F2ZUF0dGVtcHRlZCA9IGZhbHNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoZGlydHlCZWZvcmVJbXBvcnQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnm67moIcgUHJlZmFiIOacieacquS/neWtmOeahOaJi+W3peS/ruaUue+8jOivt+WFiOS/neWtmOWQjuWGjeaJp+ihjCBGaWdtYSDlop7ph4/lr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBzbmFwc2hvdFN0YXJ0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBpZiAoIXJlc3VsdC5wcmVmYWJTeW5jKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5leHRSZWNvcmQgPSByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShwcmVwYXJlZC5yZWNvcmQsIHJlc3VsdC5wcmVmYWJTeW5jKTtcclxuICAgICAgICAvLyDmnKrli77pgInnmoToioLngrnkuI3lnKjmnKzmrKHph43lu7rnu5Pmnpzph4zvvIzkv53nlZnlroPku6zljp/mnInnmoQgZmlsZUlkIOaYoOWwhOOAglxyXG4gICAgICAgIGNvbnN0IHJldGFpbmVkUmVjb3JkID0gYXJncy5za2lwU3luY05vZGVJZHM/LnNpemVcclxuICAgICAgICAgICAgPyByZXRhaW5QcmVmYWJTeW5jRW50cmllcyhwcmVwYXJlZC5yZWNvcmQsIG5leHRSZWNvcmQsIGFyZ3Muc2tpcFN5bmNOb2RlSWRzKVxyXG4gICAgICAgICAgICA6IG5leHRSZWNvcmQ7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZDogcmV0YWluZWRSZWNvcmQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgYXdhaXQgYXNzZXJ0T3BlbmVkUHJlZmFiKHByZXBhcmVkLmluZm8udXVpZCwgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQpO1xyXG4gICAgICAgIC8vIE9uY2UgdGhlIHNhdmUgcmVxdWVzdCBpcyBzZW50IGl0cyByZXN1bHQgaXMgYW1iaWd1b3VzIHVudGlsIHRoZVxyXG4gICAgICAgIC8vIHBlcnNpc3RlZCBQcmVmYWIgaXMgdmVyaWZpZWQuIERvIG5vdCByb2xsIHRoZSBpbi1tZW1vcnkgUHJlZmFiIGJhY2tcclxuICAgICAgICAvLyBvbiBhbiBJUEMgdGltZW91dDogdGhlIGRpc2sgd3JpdGUgbWF5IGFscmVhZHkgaGF2ZSBjb21wbGV0ZWQuXHJcbiAgICAgICAgc2F2ZUF0dGVtcHRlZCA9IHRydWU7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JTY2VuZVNhdmVkKCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgaWYgKCFhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGN1cnJlbnRJbmZvLCByZXRhaW5lZFJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25pyq5YyF5ZCr5pys5qyh5ZCM5q2l55Sf5oiQ55qE5YWo6YOoIGZpbGVJZO+8jOW3suWBnOatouabtOaWsCBNZXRh44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIOacquWLvumAieiKgueCueeahOe7hOS7tu+8iFVJVHJhbnNmb3Jt44CB5qCH6K6w562J77yJ5LuN5bGe5o+S5Lu25omA5pyJ77ya5LuO5L+d5a2Y5ZCO55qEXHJcbiAgICAgICAgLy8gUHJlZmFiIOmHjOivu+WbnuWug+S7rOeahCBmaWxlSWQg5bm25ZCI5bm26L+b6K6w5b2V77yM5ZCm5YiZ5LiL5qyh6YeN5paw5Yu+6YCJ5Lya6KKr5b2S5bGe5qCh6aqM5oum5LiL44CCXHJcbiAgICAgICAgbGV0IGZpbmFsUmVjb3JkID0gcmV0YWluZWRSZWNvcmQ7XHJcbiAgICAgICAgaWYgKGFyZ3Muc2tpcFN5bmNOb2RlSWRzPy5zaXplKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNraXBwZWRGaWxlSWRzID0gT2JqZWN0LnZhbHVlcyhcclxuICAgICAgICAgICAgICAgIHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKHByZXBhcmVkLnJlY29yZCwgYXJncy5za2lwU3luY05vZGVJZHMpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoc2tpcHBlZEZpbGVJZHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRyYXMgPSBjb2xsZWN0UHJlZmFiQ29tcG9uZW50RmlsZUlkcyhcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aChjdXJyZW50SW5mby51cmwpKSxcclxuICAgICAgICAgICAgICAgICAgICBza2lwcGVkRmlsZUlkcyxcclxuICAgICAgICAgICAgICAgICkuZmlsdGVyKChmaWxlSWQpID0+ICFyZXRhaW5lZFJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcy5pbmNsdWRlcyhmaWxlSWQpKTtcclxuICAgICAgICAgICAgICAgIGlmIChleHRyYXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZmluYWxSZWNvcmQgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIC4uLnJldGFpbmVkUmVjb3JkLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogW1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4ucmV0YWluZWRSZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5leHRyYXMsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIF0uc29ydCgpLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY3VycmVudE1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoY3VycmVudEluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudFJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGN1cnJlbnRNZXRhKTtcclxuICAgICAgICBpZiAoIWN1cnJlbnRSZWNvcmQgfHwgY3VycmVudFJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWcqOS/neWtmOacn+mXtOWPkeeUn+WPmOWMlu+8jOW3suaLkue7neaPkOS6pOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7IHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCwgcmVjb3JkOiBmaW5hbFJlY29yZCB9KTtcclxuICAgICAgICBhd2FpdCB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKGN1cnJlbnRJbmZvLCBzb3VyY2VIYXNoLCBmaW5hbFJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsKTtcclxuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCOIFByZWZhYiBVVUlEIOagoemqjOWksei0peOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xyXG4gICAgICAgICAgICB1dWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzdWx0LnByZWZhYlVybCA9IHByZXBhcmVkLmluZm8udXJsO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcclxuICAgICAgICAgICAgdHJ5IHsgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QtYWJvcnQnKTsgfVxyXG4gICAgICAgICAgICBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgKGVycm9yIGFzIEVycm9yICYgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSkucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzYXZlQXR0ZW1wdGVkICYmIGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIChlcnJvciBhcyBFcnJvciAmIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pLnJlcXVpcmVzQXR0ZW50aW9uID0gdHJ1ZTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIOe7hOS7tuWQjOatpemihOajgO+8muWPquivu+ebruaghyBQcmVmYWIg5LiO5b2T5YmNIEZpZ21hIOiuoeWIkuOAglxyXG4gKiDkuI3kuIvovb3lm77niYfjgIHkuI3miZPlvIAgUHJlZmFi44CB5LiN5YaZ5YWl5Lu75L2V5paH5Lu277yM5Y+v5Zyo55So5oi354K55Ye75a+85YWl5YmN5Y+N5aSN6LCD55So44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3Q29tcG9uZW50U3luYygpOiBQcm9taXNlPFN5bmNQcmV2aWV3UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgaWYgKCFkb2N1bWVudCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFkb2N1bWVudC5zb3VyY2VOb2RlSWQgfHwgZG9jdW1lbnQucm9vdHMubGVuZ3RoICE9PSAxKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflj6rmnInljZXkuKroioLngrnpk77mjqXmiY3og73pooTop4jnu4Tku7blkIzmraXjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5yb290c1swXTtcclxuICAgIGlmIChyb290LnR5cGUgIT09ICdDT01QT05FTlQnICYmIHJvb3QudHlwZSAhPT0gJ0lOU1RBTkNFJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5b2T5YmN5qC56IqC54K55pivICR7cm9vdC50eXBlfe+8jOWPquaciee7hOS7tu+8iENPTVBPTkVOVC9JTlNUQU5DRe+8iemTvuaOpeaUr+aMgee7hOS7tuWQjOatpeOAgmApO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xyXG4gICAgLy8gQXNzZXRXcml0ZXIg5p6E6YCg5Ye95pWw5Y+q6KeE6IyD5YyW55uu5b2V77yM5LiN5Lya5Yib5bu65paH5Lu25aS544CCXHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcclxuICAgIGNvbnN0IHByZWZhYlVybCA9IGBkYjovL2Fzc2V0cy8ke3dyaXRlci5mb2xkZXJ9LyR7c2FuaXRpemVBc3NldE5hbWUocm9vdC5uYW1lKX0ucHJlZmFiYDtcclxuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICByZXR1cm4geyB0YXJnZXRVcmw6IHByZWZhYlVybCwgZXhpc3RzOiBmYWxzZSwgLi4uZW1wdHlTeW5jUHJldmlld1N1bW1hcnkoKSB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJldmlvdXMgPSByZWFkUHJlZmFiU3luY01hcmtlcnMoYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgocHJlZmFiVXJsKSkpO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGVzID0gYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KTtcclxuICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKG92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAvLyDkuI7nnJ/lrp7lr7zlhaXkv53mjIHkuIDoh7TnmoTnrKzkuIDmraXvvJrmnKzlnLDlkIzlkI3ntKDmnZDlkb3kuK3ml7bmiorniLblrrnlmajmlbTkvZPmj5DljYfkuLrmlbTlsYLjgIJcclxuICAgIGNvbnN0IGxvY2FsTGlicmFyaWVzID0gc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKTtcclxuICAgICAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pXHJcbiAgICAgICAgLmZpbHRlcigobGlicmFyeSk6IGxpYnJhcnkgaXMgTG9jYWxSZXNvdXJjZUxpYnJhcnkgPT4gbGlicmFyeSAhPT0gbnVsbCk7XHJcbiAgICBpZiAobG9jYWxMaWJyYXJpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobG9jYWxMaWJyYXJpZXMubWFwKChsaWJyYXJ5KSA9PiBsaWJyYXJ5LmluaXRpYWxpemUoKSkpO1xyXG4gICAgICAgIGNvbnN0IHByb3RlY3RlZFByZXZpZXcgPSAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiA9PiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNoaWxkRGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUoY2hpbGQsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgICAgIGlmIChjaGlsZERlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgcmV0dXJuIEJvb2xlYW4oY2hpbGQuaXNNYXNrIHx8IGNoaWxkLmNoaWxkcmVuLnNvbWUoKHBhcnQpID0+IHBhcnQuaXNNYXNrKVxyXG4gICAgICAgICAgICAgICAgfHwgY2hpbGREZWNpc2lvbi5uaW5lU2xpY2UgfHwgaXNOYW1lZFNsaWNlR3JvdXAoY2hpbGQpIHx8IGlzUGF0Y2hDYW5kaWRhdGUoY2hpbGQpKVxyXG4gICAgICAgICAgICAgICAgfHwgKGNoaWxkRGVjaXNpb24uYWN0aW9uICE9PSAncmVuZGVyJyAmJiBwcm90ZWN0ZWRQcmV2aWV3KGNoaWxkKSk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgYXdhaXQgYXBwbHlMb2NhbFBhcmVudFByb21vdGlvbihcclxuICAgICAgICAgICAgZG9jdW1lbnQucm9vdHMsXHJcbiAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgYXN5bmMgKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbExpYnJhcmllcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChhd2FpdCBsaWJyYXJ5LmZpbmQobm9kZS5uYW1lLCAncG5nJykpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBwcm90ZWN0ZWRQcmV2aWV3LFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICAvLyDkuI7nnJ/lrp7lr7zlhaXkv53mjIHkuIDoh7TnmoTnrKzkuozmraXvvJroh6rliqjmipjlj6Av5pS25Y+j5Yaz5a6a55Sf5pWI5ZCO5YaN57yW6K+R6K6h5YiS44CCXHJcbiAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xyXG4gICAgcmVzb2x2ZWQuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XHJcbiAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKGRvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgY29uc3Qgcm9vdEZyYW1lID0gbm9kZUZyYW1lKHJvb3QpO1xyXG4gICAgY29uc3Qgc3BlY3MgPSBkb2N1bWVudC5yb290c1xyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICBuZXcgTWFwKCksXHJcbiAgICAgICAgICAgIG5ldyBNYXAoKSxcclxuICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgMCxcclxuICAgICAgICAgICAgeyBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5IH0sXHJcbiAgICAgICAgKSlcclxuICAgICAgICAuZmlsdGVyKChzcGVjKTogc3BlYyBpcyBTY2VuZU5vZGVTcGVjID0+IHNwZWMgIT09IG51bGwpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB0YXJnZXRVcmw6IHByZWZhYlVybCxcclxuICAgICAgICBleGlzdHM6IHRydWUsXHJcbiAgICAgICAgcHJlZmFiVXVpZDogaW5mby51dWlkLFxyXG4gICAgICAgIC4uLnBsYW5TeW5jUHJldmlldyhwcmV2aW91cywgc3BlY3MsIHsgc2NhbGU6IHNldHRpbmdzLnNjYWxlIH0pLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybUltcG9ydChyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0LCBvcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwsIG9wdGlvbnM6IHtcclxuICAgIGRvY3VtZW50PzogRG9jdW1lbnRTZXNzaW9uOyBwcmVzZXJ2ZVJldmlld3M/OiBib29sZWFuOyBzaWxlbnRSZXZpZXc/OiBib29sZWFuO1xyXG59ID0ge30pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IG9wdGlvbnMuZG9jdW1lbnQgPz8gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBpZiAoIWRvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbXBvcnRTZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbihvcGVyYXRpb25Pd25lcik7XHJcbiAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5a+85YWl5Lu75YqhJywgeyByb290czogZG9jdW1lbnQucm9vdHMubWFwKChub2RlKSA9PiAoeyBpZDogbm9kZS5pZCwgbmFtZTogbm9kZS5uYW1lIH0pKSB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5YiG5p6Q5bm25YeG5aSH6LWE5rqQ4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChyZXF1ZXN0Lm92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgLy8g5pS55Yqo5riF5Y2V6YeM5pyq5Yu+6YCJ55qE6IqC54K577ya5pys5qyh5oyJXCLlv73nlaVcIuWkhOeQhu+8jOaXouS4jeabtOaWsOS5n+S4jeWIm+W7uu+8m+Wug+S7rOeahOaXp+agh+iusFxyXG4gICAgICAgIC8vIOS4jeS8muiiq+mHjeWGme+8jOWboOatpOS4i+asoeWvvOWFpeS7jeS8muS9nOS4uuW+heabtOaWsOmhueWHuueOsOOAglxyXG4gICAgICAgIGNvbnN0IHNraXBTeW5jTm9kZUlkcyA9IG5ldyBTZXQoKHJlcXVlc3Quc2tpcFN5bmNOb2RlSWRzID8/IFtdKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIEJvb2xlYW4oaWQudHJpbSgpKSlcclxuICAgICAgICAgICAgLm1hcCgoaWQpID0+IGlkLnRyaW0oKS5yZXBsYWNlKC8tL2csICc6JykpKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGVJZCBvZiBza2lwU3luY05vZGVJZHMpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlSWQsIHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogJ2lnbm9yZScsXHJcbiAgICAgICAgICAgICAgICBraW5kOiAnYXV0bycsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHRydWUsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXZpZXdEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZShvcHRpb25zLnByZXNlcnZlUmV2aWV3cyA/IHsgcHJlc2VydmVIaXN0b3J5OiB0cnVlIH0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGNvbnN0IHJldmlld1JlY29yZGVyID0gbmV3IEltcG9ydFJldmlld1JlY29yZGVyKCk7XHJcbiAgICAgICAgLy8g57uE5Lu25ZCM5q2l77yI5Y2V6IqC54K5IENPTVBPTkVOVC9JTlNUQU5DRSDpk77mjqXvvInvvJrlhYjnlKjlg4/ntKDmjIfnurnnrpflh7rlk6rkupvoioLngrnnmoRcclxuICAgICAgICAvLyDlm77niYflhoXlrrnnoa7lrp7lj5jkuobvvIzlj6rmnInov5nkupvoioLngrnlnKjotYTmupDlh4blpIfpmLbmrrXot7Pov4fmnKzlnLDlkIzlkI3ntKDmnZDlpI3nlKjjgIJcclxuICAgICAgICBjb25zdCBzeW5jUm9vdENhbmRpZGF0ZSA9IGRvY3VtZW50LnNvdXJjZU5vZGVJZCAmJiBkb2N1bWVudC5yb290cy5sZW5ndGggPT09IDFcclxuICAgICAgICAgICAgPyBkb2N1bWVudC5yb290c1swXVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBzeW5jTW9kZSA9IEJvb2xlYW4oc3luY1Jvb3RDYW5kaWRhdGVcclxuICAgICAgICAgICAgJiYgKHN5bmNSb290Q2FuZGlkYXRlLnR5cGUgPT09ICdDT01QT05FTlQnIHx8IHN5bmNSb290Q2FuZGlkYXRlLnR5cGUgPT09ICdJTlNUQU5DRScpKTtcclxuICAgICAgICBsZXQgcmVnZW5lcmF0ZU5vZGVJZHM6IFJlYWRvbmx5U2V0PHN0cmluZz4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKHN5bmNNb2RlICYmIGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vYFxyXG4gICAgICAgICAgICAgICAgICAgICsgYCR7c2FuaXRpemVBc3NldE5hbWUoZG9jdW1lbnQucm9vdHNbMF0ubmFtZSl9LnByZWZhYmA7XHJcbiAgICAgICAgICAgICAgICBpZiAoYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVmYWJVcmwpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcHJldmlvdXMgPSByZWFkUHJlZmFiU3luY01hcmtlcnMoYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgocHJlZmFiVXJsKSkpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cy5zaXplKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHN0YWxlID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYmVmb3JlID0gcHJldmlvdXMuZ2V0KG5vZGUuaWQucmVwbGFjZSgvLS9nLCAnOicpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGZyZXNoID0gY3JlYXRlU3luY01hcmtlcih7IGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIG5vZGUgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBwaXhlbENvbXBhcmFibGUgPSB0eXBlb2YgYmVmb3JlPy5waXhlbEhhc2ggPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJiYgdHlwZW9mIGZyZXNoLnBpeGVsSGFzaCA9PT0gJ3N0cmluZyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjaGFuZ2VkID0gYmVmb3JlXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBwaXhlbENvbXBhcmFibGVcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBiZWZvcmUucGl4ZWxIYXNoICE9PSBmcmVzaC5waXhlbEhhc2hcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBiZWZvcmUuc3VidHJlZUhhc2ggIT09IGZyZXNoLnN1YnRyZWVIYXNoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNoYW5nZWQpIHN0YWxlLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCh2aXNpdCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LnJvb3RzLmZvckVhY2godmlzaXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZWdlbmVyYXRlTm9kZUlkcyA9IHN0YWxlO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICAvLyDpooTmo4DlpLHotKXkuI3pmLvmlq3lr7zlhaXvvJrpgIDlm55cIuaJgOacieiKgueCuemDveaMieeOsOacieinhOWImeWkhOeQhlwi44CCXHJcbiAgICAgICAgICAgICAgICByZWdlbmVyYXRlTm9kZUlkcyA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBidWlsdEFzc2V0cyA9IGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflhajpg6jotYTmupAnLCB1bmRlZmluZWQsICgpID0+IGJ1aWxkQXNzZXRzKFxyXG4gICAgICAgICAgICBkb2N1bWVudCxcclxuICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICBpbXBvcnRTZXR0aW5ncyxcclxuICAgICAgICAgICAgcmV2aWV3UmVjb3JkZXIsXHJcbiAgICAgICAgICAgIHsgcmVnZW5lcmF0ZU5vZGVJZHMgfSxcclxuICAgICAgICApKTtcclxuICAgICAgICBjb25zdCB7IGFzc2V0cywgd2FybmluZ3MgfSA9IGJ1aWx0QXNzZXRzO1xyXG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICBjb25zdCBhdHRhY2hSZXZpZXcgPSBhc3luYyAocmVzdWx0OiBTY2VuZUltcG9ydFJlc3VsdCkgPT4ge1xyXG4gICAgICAgICAgICByZXN1bHQucmV2aWV3ID0gYXdhaXQgZmluYWxpemVJbXBvcnRSZXZpZXcoaW1wb3J0UmV2aWV3cywgcmV2aWV3UmVjb3JkZXIsIHJldmlld0RvY3VtZW50LFxyXG4gICAgICAgICAgICAgICAgcmVzdWx0LnJldmlld0JlZm9yZSwgcmVzdWx0LnJldmlld0FmdGVyLCByZXN1bHQucHJlZmFiVXJsLCB3YXJuaW5ncyxcclxuICAgICAgICAgICAgICAgIGFzeW5jICgpID0+IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsIG1ldGhvZDogJ3JlZnJlc2hSZXZpZXdBZnRlcicsIGFyZ3M6IFt7IGlkOiByZXZpZXdSZWNvcmRlci5pZCB9XSxcclxuICAgICAgICAgICAgICAgIH0pIGFzIFJldmlld1NjZW5lKTtcclxuICAgICAgICAgICAgLy8gQWxzbyBjb3ZlciBtYW51YWwgaW1wb3J0cyB3aG9zZSBwYW5lbCB3YXMgY2xvc2VkIHdoaWxlIGltcG9ydGluZy5cclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zLnNpbGVudFJldmlldykge1xyXG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QmVmb3JlO1xyXG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QWZ0ZXI7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLm9wZW4ocGFja2FnZUpTT04ubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdpbXBvcnQtcmV2aWV3LXJlYWR5JywgcmVzdWx0LnJldmlldyk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5wdXNoKGDnu5Pmnpzlt7Lkv53lrZjvvIzkvYboh6rliqjmiZPlvIDpnaLmnb/lpLHotKXvvIzor7fku47mj5Lku7bkuK3miZPlvIDigJzlr7zlhaXnu5Pmnpzmo4Dmn6XigJ3vvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0JlZm9yZTtcclxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdBZnRlcjtcclxuICAgICAgICB9O1xyXG4gICAgICAgIC8vIGJ1aWxkQXNzZXRzIG1heSBwcm9tb3RlIGEgY29udGFpbmVyIHRvIGEgbG9jYWwgc2FtZS1uYW1lIHJlc291cmNlLlxyXG4gICAgICAgIC8vIENvbXBpbGUgYWZ0ZXIgdGhhdCBwcm9tb3Rpb24gc28gYXNzZXRzIGFuZCBTY2VuZU5vZGVTcGVjIHNoYXJlIHRoZVxyXG4gICAgICAgIC8vIGV4YWN0IHNhbWUgZmluYWwgcGxhbi5cclxuICAgICAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKGRvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IGZvbnRzID0gYXdhaXQgcmVzb2x2ZUZvbnRzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBjb25zdCBzb3VyY2VSb290RnJhbWVzID0gZG9jdW1lbnQucm9vdHMubWFwKG5vZGVGcmFtZSk7XHJcbiAgICAgICAgY29uc3QgbXVsdGlwbGVSb290cyA9IGRvY3VtZW50LnJvb3RzLmxlbmd0aCA+IDE7XHJcbiAgICAgICAgY29uc3QgYXJyYW5nZWRXaWR0aCA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyBzb3VyY2VSb290RnJhbWVzLnJlZHVjZSgodG90YWwsIGZyYW1lKSA9PiB0b3RhbCArIGZyYW1lLndpZHRoLCAwKVxyXG4gICAgICAgICAgICAgICAgKyBNYXRoLm1heCgwLCBzb3VyY2VSb290RnJhbWVzLmxlbmd0aCAtIDEpICogMTYwXHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXT8ud2lkdGggPz8gMDtcclxuICAgICAgICBjb25zdCByb290RnJhbWUgPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgeDogMCxcclxuICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogYXJyYW5nZWRXaWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogTWF0aC5tYXgoMCwgLi4uc291cmNlUm9vdEZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0gPz8geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICAgICAgbGV0IHJvb3RDdXJzb3IgPSAwO1xyXG4gICAgICAgIC8vIOe7hOS7tue6p+WQjOatpe+8muWPquacieWNleiKgueCuemTvuaOpeOAgeS4lOagueiKgueCueehruWunuaYr+e7hOS7tu+8iOaIluWunuS+i++8ieaXtuWQr+eUqOOAglxyXG4gICAgICAgIC8vIEZyYW1lIOmTvuaOpeS/neaMgeWOn+acieihjOS4uu+8jOS4jeeUn+aIkOagh+iusOOAgeS4jemineWkluWIm+W7uumhueebruiEmuacrOOAglxyXG4gICAgICAgIGNvbnN0IHN5bmNDb250ZXh0ID0gc3luY01vZGUgPyB7IGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXkgfSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCByb290cyA9IGRvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgICAgIC5tYXAoKG5vZGUsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzcGVjID0gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIDAsXHJcbiAgICAgICAgICAgICAgICAgICAgc3luY0NvbnRleHQsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMgJiYgbXVsdGlwbGVSb290cykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMuZnJhbWUgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IHJvb3RDdXJzb3IsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgICByb290Q3Vyc29yICs9IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoICsgMTYwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNwZWM7XHJcbiAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKG5vZGUpOiBub2RlIGlzIFNjZW5lTm9kZVNwZWMgPT4gbm9kZSAhPT0gbnVsbCk7XHJcbiAgICAgICAgaWYgKCFyb290cy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInpgInkuK3ku7vkvZXlj6/lr7zlhaXoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHN5bmNDb250ZXh0KSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhc3NlcnRVbmlxdWVTeW5jT3duZXJzaGlwKGNvbGxlY3RTeW5jTWFya2VyU3BlY3Mocm9vdHMpKTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5ZCM5q2l5qCH6K6w5omA5pyJ5p2D5qCh6aqM5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHNvdXJjZU5vZGVJZCA9IGRvY3VtZW50LnNvdXJjZU5vZGVJZDtcclxuICAgICAgICBpZiAoc291cmNlTm9kZUlkICYmIHJvb3RzLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJXcml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcclxuICAgICAgICAgICAgYXdhaXQgcHJlZmFiV3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWVOYW1lID0gcm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQucm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYlVybCA9IGBkYjovL2Fzc2V0cy8ke3ByZWZhYldyaXRlci5mb2xkZXJ9LyR7c2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKX0ucHJlZmFiYDtcclxuICAgICAgICAgICAgaWYgKHN5bmNDb250ZXh0KSB7XHJcbiAgICAgICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhbHVlOiAwLjAyLFxyXG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjlh4blpIfnu4Tku7blkIzmraXmoIforrDohJrmnKzigKYnLFxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzY3JpcHQgPSBhd2FpdCBlbnN1cmVTeW5jTWFya2VyU2NyaXB0KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2NyaXB0LnJlYXNvbikge1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goc2NyaXB0LnJlYXNvbik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDAuMDUsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAn5q2j5Zyo5Yib5bu65oiW5omT5byA55uu5qCHIFByZWZhYuKApicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYih7XHJcbiAgICAgICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJOYW1lOiBmcmFtZU5hbWUsXHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgc291cmNlTm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgICAgICAgICBza2lwU3luY05vZGVJZHMsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBpZiAocmVzdWx0LnN5bmNNYXJrZXJXYXJuaW5nKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5wdXNoKGDnu4Tku7blkIzmraXmoIforrDmnKrlhpnlhaXvvJoke3Jlc3VsdC5zeW5jTWFya2VyV2FybmluZ31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgICAgIC8vIFByZWZhYiB1cGRhdGVzIHBlcnNpc3QgYnkgUHJlZmFiSW5mby5maWxlSWQgaW4gdGhlIGFzc2V0IG1ldGE7XHJcbiAgICAgICAgICAgIC8vIHJ1bnRpbWUgbm9kZSBVVUlEcyBhcmUgc2Vzc2lvbi1vbmx5IGFuZCBtdXN0IG5ldmVyIGJlIHJldXNlZCBoZXJlLlxyXG4gICAgICAgICAgICBkZWxldGUgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV07XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfe+8jOW3suaJk+W8gOmihOWItuS9kyAke3ByZWZhYlVybH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgcmV2aWV3SWQ6IHJldmlld1JlY29yZGVyLmlkLFxyXG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgcm9vdE5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGltcG9ydFNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxyXG4gICAgICAgICAgICBleGlzdGluZ01hcDogbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPz8ge30sXHJcbiAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLjEsIG1lc3NhZ2U6ICfmraPlnKjmnoTlu7ogQ29jb3Mg6IqC54K55qCR4oCmJyB9KTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA9IHJlc3VsdC5ub2RlTWFwO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ25vZGUnLCByZXN1bHQucm9vdFV1aWQpO1xyXG4gICAgICAgIGlmIChpbXBvcnRTZXR0aW5ncy5hdXRvU2F2ZSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRyYWNlLmRvbmUoKTtcclxuICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWPlua2iOOAgicgfSk7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5pON5L2c5bey5Y+W5raI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIHRyYWNlLmV2ZW50KCflkI7lj7Dku7vliqHlt7Lph4rmlL4nKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TWNwUGx1Z2luU3RhdGUoKSB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2ZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcclxuICAgICAgICBzZXR0aW5nczogYXdhaXQgZ2V0U2V0dGluZ3MoKSxcclxuICAgICAgICBkb2N1bWVudDogZG9jdW1lbnQgPyB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlczogYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSxcclxuICAgICAgICB9IDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBsdWdpblN0YXRlKCkge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5hd2FpdCBnZXRNY3BQbHVnaW5TdGF0ZSgpLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5YgRmlnbWEg5paH5Lu24oCmJyB9KTtcclxuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0gcGFyc2VkLm5vZGVJZFxyXG4gICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxyXG4gICAgICAgICAgICA6IGF3YWl0IGFwaS5nZXRGaWxlKHBhcnNlZC5maWxlS2V5KTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKFxyXG4gICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGNvbnN0IG5vZGVPdmVycmlkZXMgPSBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiBg5bey6K+75Y+WICR7ZG9jdW1lbnQuZmlsZU5hbWV9YCB9KTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBmb250QXNzZXRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIH07XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24sIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXSk6IFByb21pc2U8QmF0Y2hEb2N1bWVudER0bz4ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LCBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICBmb250QXNzZXRzOiBmb250QXNzZXRzID8/IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICAgICAgbm9kZU92ZXJyaWRlczogKGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSkpLmZpbHRlcigoaXRlbSkgPT4gZG9jdW1lbnQubm9kZUJ5SWQuaGFzKGl0ZW0uaWQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVCYXRjaFNvdXJjZShzb3VyY2VVcmw6IHN0cmluZyk6IFByb21pc2U8QmF0Y2hTb3VyY2VSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgIGlmICghcGFyc2VkLm5vZGVJZCkge1xyXG4gICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoJ+aVtOS7veaWh+S7tuivt+WNleeLrOWvvOWFpe+8m+ivt+WFiOenu+mZpOaJuemHj+eVjOmdouWIl+ihqO+8jOaIluS9v+eUqCBTZWN0aW9uIC8gRnJhbWUg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsKTtcclxuICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiAnZmlsZScsIHNvdXJjZVVybCwgaXRlbXM6IFtdLCBhZGRlZDogMCwgZHVwbGljYXRlczogMCwgZG9jdW1lbnQgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5blubbor4bliKsgU2VjdGlvbiAvIEZyYW1l4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpO1xyXG4gICAgICAgIGNvbnN0IHBhcnNlZERvY3VtZW50ID0gcGFyc2VEb2N1bWVudChhd2FpdCBhcGkuZ2V0Tm9kZShwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCksXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpO1xyXG4gICAgICAgIGNvbnN0IHJvb3QgPSBwYXJzZWREb2N1bWVudC5yb290c1swXTtcclxuICAgICAgICBjb25zdCBmb250QXNzZXRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgICAgICBpZiAocm9vdC50eXBlICE9PSAnU0VDVElPTicgJiYgcm9vdC50eXBlICE9PSAnRlJBTUUnKSB7XHJcbiAgICAgICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplKSB0aHJvdyBuZXcgRXJyb3IoJ+aJuemHj+WIl+ihqOWPquaOpeWPlyBTZWN0aW9uIOaIliBGcmFtZe+8m+WFtuS7luiKgueCueivt+a4heepuuWIl+ihqOWQjuWNleeLrOWvvOWFpeOAgicpO1xyXG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKHBhcnNlZERvY3VtZW50KTtcclxuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICBhd2FpdCBwYXRjaFNldHRpbmdzKHsgc291cmNlVXJsIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiAnbm9kZScsIHNvdXJjZVVybCwgaXRlbXM6IFtdLCBhZGRlZDogMCwgZHVwbGljYXRlczogMCxcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGRvY3VtZW50LCBmb250QXNzZXRzKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmcmFtZXMgPSBjb2xsZWN0U2VjdGlvbkZyYW1lcyhyb290KTtcclxuICAgICAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign6L+Z5LiqIFNlY3Rpb24g5LiL5rKh5pyJ5Y+v54us56uL5a+85YWl55qE5aSW5bGCIEZyYW1l44CCJyk7XHJcbiAgICAgICAgY29uc3QgcHJlcGFyZWQ6IEFycmF5PHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4gPSBbXTtcclxuICAgICAgICBsZXQgZHVwbGljYXRlcyA9IDA7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBmcmFtZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaWQgPSBmaWdtYUZyYW1lU291cmNlSGFzaChwYXJzZWQuZmlsZUtleSwgZnJhbWUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGJhdGNoRG9jdW1lbnRzLmdldChpZCk7XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICAgICAgICAgICAgZHVwbGljYXRlcyArPSAxO1xyXG4gICAgICAgICAgICAgICAgcHJlcGFyZWQucHVzaCh7IC4uLmV4aXN0aW5nLCBpdGVtOiB7IC4uLmV4aXN0aW5nLml0ZW0sXHJcbiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZXhpc3RpbmcuZG9jdW1lbnQsIGZvbnRBc3NldHMpIH0gfSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKGZyYW1lRG9jdW1lbnQocGFyc2VkRG9jdW1lbnQsIGZyYW1lKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW06IEJhdGNoRnJhbWVJdGVtID0ge1xyXG4gICAgICAgICAgICAgICAgaWQsIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIHJvb3RJZDogZnJhbWUuaWQsIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICAgICAgbmFtZTogZnJhbWUubmFtZSwgZW5hYmxlZDogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIC4uLihyb290LnR5cGUgPT09ICdTRUNUSU9OJyA/IHsgc2VjdGlvbk5hbWU6IHJvb3QubmFtZSB9IDoge30pLFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQsIGZvbnRBc3NldHMpLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBwcmVwYXJlZC5wdXNoKHsgaXRlbSwgZG9jdW1lbnQgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFkZGVkID0gcHJlcGFyZWQubGVuZ3RoIC0gZHVwbGljYXRlcztcclxuICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuc2l6ZSArIGFkZGVkID4gTUFYX0JBVENIX0lURU1TKSB0aHJvdyBuZXcgRXJyb3IoJ+acrOaJueacgOWkmua3u+WKoCAnICsgTUFYX0JBVENIX0lURU1TICsgJyDkuKrnlYzpnaLvvIzor7fliIbmibnlr7zlhaXjgIInKTtcclxuICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBwcmVwYXJlZCkgYmF0Y2hEb2N1bWVudHMuc2V0KGVudHJ5Lml0ZW0uaWQsIGVudHJ5KTtcclxuICAgICAgICBhd2FpdCBwYXRjaFNldHRpbmdzKHsgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiAn5bey5re75YqgICcgKyBhZGRlZCArICcg5Liq55WM6Z2iJ1xyXG4gICAgICAgICAgICArIChkdXBsaWNhdGVzID8gJ++8jCcgKyBkdXBsaWNhdGVzICsgJyDkuKrlt7LlnKjliJfooagnIDogJycpICsgJ+OAgicgfSk7XHJcbiAgICAgICAgcmV0dXJuIHsgc291cmNlVHlwZTogcm9vdC50eXBlID09PSAnU0VDVElPTicgPyAnc2VjdGlvbicgOiAnZnJhbWUnLCBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIGl0ZW1zOiBwcmVwYXJlZC5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSwgYWRkZWQsIGR1cGxpY2F0ZXMgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQgPyAnY2FuY2VsbGVkJyA6ICdlcnJvcicsIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFjdGl2YXRlQmF0Y2hJdGVtKGlkOiBzdHJpbmcpOiBQcm9taXNlPEJhdGNoRG9jdW1lbnREdG8+IHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IGJhdGNoRG9jdW1lbnRzLmdldChpZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSkgdGhyb3cgbmV3IEVycm9yKCfor6XnlYzpnaLlt7LlpLHmlYjvvIzor7fph43mlrDmt7vliqDpk77mjqXjgIInKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZW50cnkuZG9jdW1lbnQpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZW50cnkuZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVudHJ5Lml0ZW0uZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICByZXR1cm4gZG9jdW1lbnQ7XHJcbiAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxufVxyXG5cclxuZnVuY3Rpb24gc3luY0JhdGNoSXRlbXMoaXRlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgZW5hYmxlZDogYm9vbGVhbiB9Pik6IHsgaXRlbXM6IEJhdGNoRnJhbWVJdGVtW10gfSB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3ku7vliqHlrozmiJDlkI7lho3kv67mlLnnlYzpnaLliJfooajjgIInKTtcclxuICAgIGlmICghQXJyYXkuaXNBcnJheShpdGVtcykgfHwgaXRlbXMubGVuZ3RoID4gTUFYX0JBVENIX0lURU1TKSB0aHJvdyBuZXcgRXJyb3IoJ+aJuemHj+eVjOmdouWIl+ihqOaXoOaViOOAgicpO1xyXG4gICAgY29uc3QgbmV4dCA9IG5ldyBNYXA8c3RyaW5nLCB7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBkb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIH0+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IGl0ZW0gJiYgYmF0Y2hEb2N1bWVudHMuZ2V0KGl0ZW0uaWQpO1xyXG4gICAgICAgIGlmICghZW50cnkgfHwgdHlwZW9mIGl0ZW0uZW5hYmxlZCAhPT0gJ2Jvb2xlYW4nIHx8IG5leHQuaGFzKGl0ZW0uaWQpKSB0aHJvdyBuZXcgRXJyb3IoJ+eVjOmdouWIl+ihqOW3sui/h+acn+aIluWMheWQq+mHjeWkjemhue+8jOivt+mHjeaWsOivu+WPluOAgicpO1xyXG4gICAgICAgIG5leHQuc2V0KGl0ZW0uaWQsIHsgLi4uZW50cnksIGl0ZW06IHsgLi4uZW50cnkuaXRlbSwgZW5hYmxlZDogaXRlbS5lbmFibGVkIH0gfSk7XHJcbiAgICB9XHJcbiAgICBiYXRjaERvY3VtZW50cy5jbGVhcigpO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIGVudHJ5XSBvZiBuZXh0KSBiYXRjaERvY3VtZW50cy5zZXQoaWQsIGVudHJ5KTtcclxuICAgIHJldHVybiB7IGl0ZW1zOiBbLi4uYmF0Y2hEb2N1bWVudHMudmFsdWVzKCldLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldEJhdGNoU3RhdGUoKTogUHJvbWlzZTxCYXRjaFN0YXRlPiB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2gpIHJldHVybiB7XHJcbiAgICAgICAgaXRlbXM6IFsuLi5iYXRjaERvY3VtZW50cy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSksXHJcbiAgICAgICAgbGFzdFJlc3VsdDogbGFzdEJhdGNoUmVzdWx0LCBydW5uaW5nOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSxcclxuICAgIH07XHJcbiAgICBjb25zdCBmb250cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICBjb25zdCBpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaERvY3VtZW50cy52YWx1ZXMoKSkge1xyXG4gICAgICAgIGl0ZW1zLnB1c2goeyAuLi5lbnRyeS5pdGVtLCBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhlbnRyeS5kb2N1bWVudCwgZm9udHMpIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgaXRlbXMsIGxhc3RSZXN1bHQ6IGxhc3RCYXRjaFJlc3VsdCwgLi4uKGFjdGl2ZUJhdGNoID8geyBydW5uaW5nOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSB9IDoge30pIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhdGNoKHJlcXVlc3Q6IEJhdGNoSW1wb3J0UmVxdWVzdCk6IFByb21pc2U8QmF0Y2hJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyIHx8IGFwcGx5aW5nSW1wb3J0UmV2aWV3IHx8IHJvdW5kdHJpcENvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJ5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ44CCJyk7XHJcbiAgICBpZiAoIXJlcXVlc3QgfHwgIUFycmF5LmlzQXJyYXkocmVxdWVzdC5pdGVtcykgfHwgIXJlcXVlc3QuaXRlbXMubGVuZ3RoIHx8IHJlcXVlc3QuaXRlbXMubGVuZ3RoID4gTUFYX0JBVENIX0lURU1TKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7foh7PlsJHpgInmi6nkuIDkuKrmnInmlYjnmoTlvoXlr7zlhaXnlYzpnaLjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgdmlzaWJsZUl0ZW1zID0gcmVxdWVzdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVyc1xyXG4gICAgICAgIHx8IGJhdGNoRG9jdW1lbnRzLmdldChpdGVtPy5pZCk/LmRvY3VtZW50LnJvb3RzWzBdPy52aXNpYmxlICE9PSBmYWxzZSk7XHJcbiAgICBpZiAoIXZpc2libGVJdGVtcy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcign5bey5YWz6Zet6ZqQ6JeP5Zu+5bGC5a+85YWl77yM5omA6YCJ55WM6Z2i5Z2H5bey6ZqQ6JeP77yb6K+36YCJ5oup5Y+v6KeB55WM6Z2i5oiW5byA5ZCv5a+85YWl6ZqQ6JeP5Zu+5bGC44CCJyk7XHJcbiAgICBjb25zdCBlbnRyaWVzID0gdmlzaWJsZUl0ZW1zLm1hcCgoaXRlbSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkuaXRlbS5lbmFibGVkIHx8ICFBcnJheS5pc0FycmF5KGl0ZW0ub3ZlcnJpZGVzKSkgdGhyb3cgbmV3IEVycm9yKCflvoXlr7zlhaXnlYzpnaLlt7LlpLHmlYjmiJbmnKrli77pgInvvIzor7fph43mlrDor7vlj5bjgIInKTtcclxuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSBpdGVtLm92ZXJyaWRlcy5tYXAoKG92ZXJyaWRlKSA9PiAoeyAuLi5vdmVycmlkZSB9KSk7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IGVudHJ5LmRvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKG92ZXJyaWRlcywgZW50cnkuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9ucy5nZXQocm9vdC5pZCk/LmFjdGlvbiA9PT0gJ2lnbm9yZScpIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lml0ZW0ubmFtZSArICfigJ3moLnoioLngrnlt7Llv73nlaXvvIzor7flj5bmtojor6XnlYzpnaLli77pgInmiJbmgaLlpI3moLnoioLngrnnrZbnlaXjgIInKTtcclxuICAgICAgICBjb25zdCBuYW1lID0gZGVjaXNpb25zLmdldChyb290LmlkKT8ubmFtZSB8fCByb290Lm5hbWU7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZW50cnksIG92ZXJyaWRlcywgbmFtZSB9O1xyXG4gICAgfSk7XHJcbiAgICBhc3NlcnRCYXRjaFRhcmdldHMoZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgbmFtZTogZW50cnkubmFtZSB9KSkpO1xyXG4gICAgY29uc3QgcnVuOiBCYXRjaFJ1biA9IHtcclxuICAgICAgICBpZDogcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdoZXgnKSwgaW5kZXg6IDAsIHN0b3BSZXF1ZXN0ZWQ6IGZhbHNlLFxyXG4gICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBuYW1lOiBlbnRyeS5uYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsLCBzdGF0dXM6ICdwZW5kaW5nJyB9KSksXHJcbiAgICB9O1xyXG4gICAgYWN0aXZlQmF0Y2ggPSBydW47XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIGVudHJ5Lml0ZW0uZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA9IGVudHJ5Lm92ZXJyaWRlcztcclxuICAgIGNvbnN0IHByZXZpb3VzRG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGNvbnN0IHByZXZpb3VzUmVzdWx0ID0gcmVxdWVzdC5wcmVzZXJ2ZVJlc3VsdHMgPyBsYXN0QmF0Y2hSZXN1bHQgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCBjb21wbGV0ZWRSZXN1bHQgPSAoKTogQmF0Y2hJbXBvcnRSZXN1bHQgPT4ge1xyXG4gICAgICAgIGNvbnN0IG1lcmdlZCA9IG5ldyBNYXA8c3RyaW5nLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQ+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHByZXZpb3VzUmVzdWx0Py5pdGVtcyA/PyBbXSkge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hEb2N1bWVudHMuaGFzKGl0ZW0uaWQpKSBtZXJnZWQuc2V0KGl0ZW0uaWQsIHsgLi4uaXRlbSB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJ1bi5pdGVtcykgbWVyZ2VkLnNldChpdGVtLmlkLCB7IC4uLml0ZW0gfSk7XHJcbiAgICAgICAgY29uc3QgaXRlbXMgPSBbLi4ubWVyZ2VkLnZhbHVlcygpXTtcclxuICAgICAgICByZXR1cm4geyBpZDogcnVuLmlkLCBpdGVtcywgc3RvcHBlZDogcnVuLnN0b3BSZXF1ZXN0ZWQsXHJcbiAgICAgICAgICAgIGNvbXBsZXRlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoLFxyXG4gICAgICAgICAgICB0b3RhbDogaXRlbXMubGVuZ3RoIH07XHJcbiAgICB9O1xyXG4gICAgdHJ5IHtcclxuICAgICAgICAvLyBDaGVjayBldmVyeSBkZXN0aW5hdGlvbiBiZWZvcmUgdGhlIGZpcnN0IGltYWdlL3ByZWZhYiB3cml0ZS5cclxuICAgICAgICBjb25zdCBmb2xkZXIgPSBuZXcgQXNzZXRXcml0ZXIoc2V0dGluZ3MucHJlZmFiRm9sZGVyKS5mb2xkZXI7XHJcbiAgICAgICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSAnZGI6Ly9hc3NldHMvJyArIGZvbGRlciArICcvJyArIHNhbml0aXplQXNzZXROYW1lKGVudHJ5Lm5hbWUpICsgJy5wcmVmYWInO1xyXG4gICAgICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIWluZm8pIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBlbnRyeS5pdGVtLmlkXHJcbiAgICAgICAgICAgICAgICB8fCAoYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gJiYgYmluZGluZ3NbZW50cnkuaXRlbS5pZF0gIT09IGluZm8udXVpZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign4oCcJyArIGVudHJ5Lm5hbWUgKyAn4oCd55qEIFByZWZhYiDot6/lvoTlt7Looqvlhbbku5bmnaXmupDljaDnlKjvvIzor7fmlLnlkI3miJbosIPmlbTovpPlh7rnm67lvZXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGxldGVkUmVzdWx0KCk7XHJcbiAgICAgICAgICAgIGxhc3RCYXRjaFJlc3VsdCA9IHJlc3VsdDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWBnOatou+8jOWwmuacquW8gOWni+S7u+S9leeVjOmdouOAgicsIGJhdGNoOiB7IC4uLmJhdGNoUHJvZ3Jlc3MocnVuKSwgcmVzdWx0IH0gfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZShyZXF1ZXN0LnByZXNlcnZlUmVzdWx0cyA/IHsgcHJlc2VydmVIaXN0b3J5OiB0cnVlIH0gOiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBlbnRyaWVzLmxlbmd0aDsgaW5kZXgrKykge1xyXG4gICAgICAgICAgICBpZiAocnVuLnN0b3BSZXF1ZXN0ZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICBydW4uaW5kZXggPSBpbmRleDtcclxuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBlbnRyaWVzW2luZGV4XTtcclxuICAgICAgICAgICAgY29uc3Qgcm93ID0gcnVuLml0ZW1zW2luZGV4XTtcclxuICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdydW5uaW5nJztcclxuICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcclxuICAgICAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5a+85YWlICcgKyAoaW5kZXggKyAxKSArICcvJyArIGVudHJpZXMubGVuZ3RoICsgJ++8micgKyBlbnRyeS5uYW1lIH0pO1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGVyZm9ybUltcG9ydCh7IG92ZXJyaWRlczogZW50cnkub3ZlcnJpZGVzLFxyXG4gICAgICAgICAgICAgICAgICAgIHNldHRpbmdzOiB7IC4uLnNldHRpbmdzLCBzb3VyY2VVcmw6IGVudHJ5Lml0ZW0uc291cmNlVXJsIH0gfSwgcnVuLmlkLFxyXG4gICAgICAgICAgICAgICAgeyBkb2N1bWVudDogZW50cnkuZG9jdW1lbnQsIHByZXNlcnZlUmV2aWV3czogdHJ1ZSwgc2lsZW50UmV2aWV3OiB0cnVlIH0pO1xyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihyb3csIHsgc3RhdHVzOiAnc3VjY2VzcycsIHByZWZhYlVybDogcmVzdWx0LnByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICBjcmVhdGVkOiByZXN1bHQuY3JlYXRlZCwgdXBkYXRlZDogcmVzdWx0LnVwZGF0ZWQsIHdhcm5pbmdzOiByZXN1bHQud2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJlc3VsdC5yZXZpZXc/LmlkIH0pO1xyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdzdWNjZXNzJztcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIGxldCB1bnNhZmUgPSBCb29sZWFuKChlcnJvciBhcyB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KT8ucmVxdWlyZXNBdHRlbnRpb24pO1xyXG4gICAgICAgICAgICAgICAgdHJ5IHsgaWYgKGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykpIHVuc2FmZSA9IHRydWU7IH1cclxuICAgICAgICAgICAgICAgIGNhdGNoIHsgdW5zYWZlID0gdHJ1ZTsgfVxyXG4gICAgICAgICAgICAgICAgcm93LnN0YXR1cyA9ICdmYWlsZWQnO1xyXG4gICAgICAgICAgICAgICAgcm93LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJztcclxuICAgICAgICAgICAgICAgIGlmICh1bnNhZmUpIHtcclxuICAgICAgICAgICAgICAgICAgICByb3cucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgICAgICAgICAgICAgIHJvdy5lcnJvciArPSAnIOW9k+WJjee8lui+keaIluS/neWtmOeKtuaAgemcgOimgeajgOafpe+8jOW3suaaguWBnOWQjue7reeVjOmdou+8m+ehruiupOebruagh+WSjOS/neWtmOeKtuaAgeWQjuWGjemHjeivleOAgic7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAodW5zYWZlIHx8IHJlcXVlc3QuZmFpbHVyZVBvbGljeSA9PT0gJ3N0b3AnKSBydW4uc3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogZW50cnkubmFtZSArICfvvJonICsgKHJvdy5zdGF0dXMgPT09ICdzdWNjZXNzJyA/ICflt7Lkv53lrZgnIDogJ+Wksei0pScpIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXN1bHQgPSBjb21wbGV0ZWRSZXN1bHQoKTtcclxuICAgICAgICBsYXN0QmF0Y2hSZXN1bHQgPSByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdmFsdWU6IDEsIG1lc3NhZ2U6IHJlc3VsdC5zdG9wcGVkID8gJ+acrOaJueW3suWBnOatou+8jOW3suWujOaIkOmhueS/neeVmeOAgicgOiAn5pys5om55a+85YWl57uT5p2f44CCJyxcclxuICAgICAgICAgICAgYmF0Y2g6IHsgLi4uYmF0Y2hQcm9ncmVzcyhydW4pLCByZXN1bHQgfSB9KTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2ggPT09IHJ1bikgYWN0aXZlQmF0Y2ggPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gcHJldmlvdXNEb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN0b3BJbXBvcnRCYXRjaCgpOiB7IGFjY2VwdGVkOiBib29sZWFuIH0ge1xyXG4gICAgaWYgKCFhY3RpdmVCYXRjaCkgcmV0dXJuIHsgYWNjZXB0ZWQ6IGZhbHNlIH07XHJcbiAgICBhY3RpdmVCYXRjaC5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W9k+WJjeeVjOmdouWujOaIkOS/neWtmOWQjuWBnOatou+8jOWQjue7reeVjOmdouS4jeS8muW8gOWni+OAgicgfSk7XHJcbiAgICByZXR1cm4geyBhY2NlcHRlZDogdHJ1ZSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50Py5ub2RlQnlJZC5nZXQobm9kZUlkKTtcclxuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgIDEsXHJcbiAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgZ2V0SW1wb3J0UmV2aWV3KGlkPzogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLmdldChpZCk7IH0sXHJcbiAgICByZXNvbHZlQmF0Y2hTb3VyY2UsXHJcbiAgICBhY3RpdmF0ZUJhdGNoSXRlbSxcclxuICAgIHN5bmNCYXRjaEl0ZW1zLFxyXG4gICAgZ2V0QmF0Y2hTdGF0ZSxcclxuICAgIGltcG9ydEJhdGNoLFxyXG4gICAgc3RvcEltcG9ydEJhdGNoLFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3UHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcpIHsgcmV0dXJuIGltcG9ydFJldmlld3MucHJldmlldyhpZCwgYXNzZXRJZCk7IH0sXHJcbiAgICBhc3luYyBhcHBseUltcG9ydFJldmlldyhpZDogc3RyaW5nLCByZW1vdmVkSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5a+85YWl5oiWIEZpZ21hIOmihOiniOWujOaIkOOAgicpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gdHJ1ZTtcclxuICAgICAgICB0cnkgeyByZXR1cm4gYXdhaXQgaW1wb3J0UmV2aWV3cy5hcHBseShpZCwgcmVtb3ZlZElkcyk7IH1cclxuICAgICAgICBmaW5hbGx5IHsgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3U291cmNlUHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcsIG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5pON5L2c5a6M5oiQ5ZCO5YaN5Yqg6L295p2l5rqQ6aKE6KeI44CCJyk7XHJcbiAgICAgICAgY29uc3QgeyBmaWxlS2V5LCBub2RlIH0gPSBpbXBvcnRSZXZpZXdzLnNvdXJjZShpZCwgYXNzZXRJZCwgbm9kZUlkKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcclxuICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsbHNbaW1hZ2VSZWZdKSByZXR1cm4geyB1cmw6IGZpbGxzW2ltYWdlUmVmXSwgbm90ZTogJ0ZpZ21hIOWOn+Wbvu+8iOacquWQiOaIkOiKgueCueaViOaenO+8iScgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmICghdXJsc1tub2RlLmlkXSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDmnKrov5Tlm57pooTop4jvvIzpmpDol4/miJblpI3mnYLmlYjmnpzoioLngrnlj6/og73ml6Dms5XljZXni6zmuLLmn5PjgIInKTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGUuaWRdLCBub3RlOiAnRmlnbWEg5b2T5YmN6IqC54K55riy5p+T77yI6ZqQ6JeP56WW5YWI5Y+v6IO95L2/6aKE6KeI6YCP5piO77yJJyB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIG9wZW5QYW5lbCgpIHtcclxuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFBsdWdpblN0YXRlKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNldFRva2VuKHZhbHVlOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuc2V0KHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgY2xlYXJUb2tlbigpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkudmVyaWZ5KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleTogdW5rbm93biwgb3ZlcnJpZGVzOiB1bmtub3duLCBzY29wZUlkczogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZ2V0Tm9kZVByZXZpZXcobm9kZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc3luY1ByZXZpZXcoKSB7XHJcbiAgICAgICAgcmV0dXJuIHByZXZpZXdDb21wb25lbnRTeW5jKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcERldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5kZXRlY3Qoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wcmV2aWV3KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFBhaXIocGFpclRva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wYWlyKHBhaXJUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwQXBwbHkocHJldmlld1Rva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcclxuICAgICAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCkge1xyXG4gICAgICAgIHJldHVybiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QpO1xyXG4gICAgfSxcclxuXHJcbiAgICBjYW5jZWxJbXBvcnQoKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoKSByZXR1cm4gc3RvcEltcG9ydEJhdGNoKCk7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydE1jcEJyaWRnZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XHJcblxyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxyXG4gICAgICAgIGlzSW1wb3J0QnVzeTogKCkgPT4gYWN0aXZlQmF0Y2ggIT09IG51bGwgfHwgYWN0aXZlQ29udHJvbGxlciAhPT0gbnVsbCB8fCByb3VuZHRyaXBDb250cm9sbGVyICE9PSBudWxsLFxyXG4gICAgICAgIGdldFN0YXRlOiBnZXRNY3BQbHVnaW5TdGF0ZSxcclxuICAgICAgICBmZXRjaERvY3VtZW50OiBmZXRjaEZpZ21hRG9jdW1lbnQsXHJcbiAgICAgICAgZ2V0UHJldmlldzogZ2V0Tm9kZVByZXZpZXcsXG4gICAgICAgIHN5bmNQcmV2aWV3OiAoKSA9PiBwcmV2aWV3Q29tcG9uZW50U3luYygpLFxyXG4gICAgICAgIHNhdmVTZXR0aW5ncyxcclxuICAgICAgICBwYXRjaFNldHRpbmdzLFxyXG4gICAgICAgIHNhdmVOb2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIHBhdGNoTm9kZU5hbWVzLFxyXG4gICAgICAgIGltcG9ydFNlbGVjdGlvbjogKHJlcXVlc3QsIG9wZXJhdGlvbklkKSA9PiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QsIG9wZXJhdGlvbklkKSxcclxuICAgICAgICBjYW5jZWxJbXBvcnQ6IChvcGVyYXRpb25JZCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIWFjdGl2ZUNvbnRyb2xsZXIgfHwgYWN0aXZlT3BlcmF0aW9uT3duZXIgIT09IG9wZXJhdGlvbklkKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIuYWJvcnQoKTtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYnJpZGdlID0gbmV3IE1jcEJyaWRnZVNlcnZlcih7XHJcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgcGx1Z2luVmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICBwbHVnaW5JbnN0YW5jZUlkLFxyXG4gICAgICAgIGludm9rZTogKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpID0+IGFwaS5pbnZva2UobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCksXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLnN0YXJ0KCk7XHJcbiAgICAgICAgbWNwQXBpID0gYXBpO1xyXG4gICAgICAgIG1jcEJyaWRnZSA9IGJyaWRnZTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLmNsb3NlKCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBGaWdtYSBJbXBvcnRlciBNQ1AgQnJpZGdlIOWQr+WKqOWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyhFZGl0b3IuUHJvamVjdC5wYXRoLCBlZGl0b3JSZWltcG9ydGVyKTtcclxuICAgICAgICBjb25zdCBhY3RpdmUgPSByZWNvdmVyZWQuZmlsdGVyKChyZXN1bHQpID0+IHJlc3VsdC5zdGF0dXMgPT09ICdhY3RpdmUtb3duZXInKTtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBhY3RpdmUubGVuZ3RoXHJcbiAgICAgICAgICAgID8gYOajgOa1i+WIsCAke2FjdGl2ZS5sZW5ndGh9IOS4quS7jeeUsea0u+WKqOi/m+eoi+aMgeacieeahCBSb3VuZC10cmlwIOS6i+WKoe+8jOaaguaXtuemgeatoiBQYWlyL0FwcGx544CCYFxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGBSb3VuZC10cmlwIOWQr+WKqOaBouWkjeWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0YXJ0TWNwQnJpZGdlKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2gpIGFjdGl2ZUJhdGNoLnN0b3BSZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgYmF0Y2hEb2N1bWVudHMuY2xlYXIoKTtcclxuICAgIGxhc3RCYXRjaFJlc3VsdCA9IHVuZGVmaW5lZDtcclxuICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZSgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xyXG4gICAgYWN0aXZlRG9jdW1lbnQgPSBudWxsO1xyXG4gICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgY29uc3QgYnJpZGdlID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICB2b2lkIGJyaWRnZT8uY2xvc2UoKS5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBGaWdtYSBJbXBvcnRlciBNQ1AgQnJpZGdlIOWFs+mXreWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gKTtcclxuICAgIH0pO1xyXG59XHJcbiJdfQ==