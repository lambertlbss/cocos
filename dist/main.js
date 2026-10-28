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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQWdoQkEsd0RBZ0JDO0FBOEJELGtDQTJCQztBQUVELGdFQVNDO0FBTUQsOERBZ0NDO0FBNkZELHdDQXFDQztBQW1FRCxrQ0F1dkJDO0FBeUNELDRCQWtIQztBQXVnREQsb0JBYUM7QUFFRCx3QkFnQkM7QUF2d0dELCtCQUE4RTtBQUM5RSwyQkFBZ0M7QUFDaEMsbUNBQXFDO0FBQ3JDLCtDQUFnRTtBQUNoRSwwQ0FBZ0Q7QUFDaEQsbUVBQTBDO0FBQzFDLDJDQUE4RTtBQUM5RSwrQ0FXMEI7QUFDMUIsMkNBQStDO0FBQy9DLDJEQUtnQztBQUNoQyxpREFBeUU7QUFDekUsNkNBQXVFO0FBQ3ZFLHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsd0RBS2dDO0FBQ2hDLG9FQUFvRTtBQUNwRSwwREFLaUM7QUFDakMsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHNEQUF1RDtBQUN2RCwyREFBcUQ7QUFDckQsNERBQWlEO0FBQ2pELG9EQUEwRjtBQUMxRixzREFBMkQ7QUFDM0Qsd0RBY2dDO0FBQ2hDLHdEQUFvRDtBQUNwRCx1Q0FBdUU7QUFDdkUsZ0RBQXNEO0FBQ3RELGlEQUF1RDtBQUN2RCxtREFBc0U7QUFDdEUseURBQTJEO0FBQzNELG1DQW1CaUI7QUFDakIsMkNBQStDO0FBQy9DLDREQUFxRjtBQUNyRiw4RUFBeUU7QUFFekUsaURBQXlGO0FBTXpGLE1BQU0sS0FBSyxHQUFHLElBQUksd0JBQVUsQ0FBQyxzQkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQy9DLE1BQU0sYUFBYSxHQUFHLElBQUksbUNBQW1CLEVBQUUsQ0FBQztBQUNoRCxJQUFJLG9CQUFvQixHQUFHLEtBQUssQ0FBQztBQUNqQyxJQUFJLGNBQWMsR0FBMkIsSUFBSSxDQUFDO0FBQ2xELElBQUks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QyxDQUFDO0lBQzVDLENBQUM7SUFDRCxNQUFNLGNBQWMsRUFBRSxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFnQixNQUFNO0lBQ2xCLElBQUksV0FBVztRQUFFLFdBQVcsQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDO0lBQ2xELGNBQWMsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUN2QixlQUFlLEdBQUcsU0FBUyxDQUFDO0lBQzVCLGFBQWEsQ0FBQyxVQUFVLEVBQUUsQ0FBQztJQUMzQixnQkFBZ0IsYUFBaEIsZ0JBQWdCLHVCQUFoQixnQkFBZ0IsQ0FBRSxLQUFLLEVBQUUsQ0FBQztJQUMxQixnQkFBZ0IsR0FBRyxJQUFJLENBQUM7SUFDeEIsb0JBQW9CLEdBQUcsSUFBSSxDQUFDO0lBQzVCLGNBQWMsR0FBRyxJQUFJLENBQUM7SUFDdEIsZ0JBQWdCLElBQUksQ0FBQyxDQUFDO0lBQ3RCLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQztJQUN6QixTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ2pCLE1BQU0sR0FBRyxJQUFJLENBQUM7SUFDZCxLQUFLLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLEtBQUssR0FBRyxLQUFLLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRTtRQUNqQyxPQUFPLENBQUMsS0FBSyxDQUFDLGtDQUFrQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQ3ZHLENBQUMsQ0FBQyxDQUFBLENBQUM7QUFDUCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgYmFzZW5hbWUsIGV4dG5hbWUsIGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnY3J5cHRvJztcclxuaW1wb3J0IHsgZGlhZ25vc3RpY1N0YXJ0LCBkaWFnbm9zdGljVGFzayB9IGZyb20gJy4vZGlhZ25vc3RpY3MnO1xyXG5pbXBvcnQgeyByZWFkRmlsZSwgcmVhZGRpciB9IGZyb20gJ2ZzL3Byb21pc2VzJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEZpZ21hQ2xpZW50LCBDYW5jZWxsZWRFcnJvciwgY2xhbXBJbWFnZVNjYWxlIH0gZnJvbSAnLi9maWdtYS9jbGllbnQnO1xyXG5pbXBvcnQge1xyXG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcclxuICAgIGluZmVyQWN0aW9uLFxyXG4gICAgaW5mZXJDb2Nvc0xheW91dE1vZGUsXHJcbiAgICBpbmZlcktpbmQsXHJcbiAgICBpc1BhdGNoQ2FuZGlkYXRlLFxyXG4gICAgaXNOYW1lZFNsaWNlR3JvdXAsXHJcbiAgICBpc1ZlY3Rvck5vZGUsXHJcbiAgICBuYXRpdmVUaWxlZFBhaW50U291cmNlLFxyXG4gICAgcGxhaW5JbWFnZVNvdXJjZVJlZixcclxuICAgIHR5cGUgVGlsZWRQYWludFNvdXJjZSxcclxufSBmcm9tICcuL2ZpZ21hL2FuYWx5emVyJztcclxuaW1wb3J0IHsgcGFyc2VEb2N1bWVudCB9IGZyb20gJy4vZmlnbWEvcGFyc2VyJztcclxuaW1wb3J0IHtcclxuICAgIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuLFxyXG4gICAgY29tcGlsZUltcG9ydFBsYW4sXHJcbiAgICBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24sXHJcbiAgICByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMsXHJcbn0gZnJvbSAnLi9maWdtYS9pbXBvcnQtcGxhbm5lcic7XHJcbmltcG9ydCB7IGFuYWx5emVNYXNrVGludCwgdmVyaWZ5V2hpdGVBbHBoYVBuZyB9IGZyb20gJy4vZmlnbWEvbWFzay10aW50JztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCwgdHlwZSBTbGljZUFuYWx5c2lzIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgU1lOQ19NQVJLRVJfU0NSSVBUX1VSTCxcclxuICAgIGFzc2VydFVuaXF1ZVN5bmNPd25lcnNoaXAsXHJcbiAgICBjcmVhdGVTeW5jTWFya2VyLFxyXG4gICAgdHlwZSBTeW5jTWFya2VyU3BlYyxcclxufSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtbWFya2VyJztcclxuaW1wb3J0IHsgcGxhblN5bmNNYXJrZXJTY3JpcHQgfSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtbWFya2VyLWFzc2V0JztcclxuaW1wb3J0IHtcclxuICAgIGVtcHR5U3luY1ByZXZpZXdTdW1tYXJ5LFxyXG4gICAgcGxhblN5bmNQcmV2aWV3LFxyXG4gICAgcmVhZFByZWZhYlN5bmNNYXJrZXJzLFxyXG4gICAgdHlwZSBTeW5jUHJldmlld1Jlc3VsdCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3N5bmMtcHJldmlldyc7XHJcbmltcG9ydCB7XHJcbiAgICBBc3NldFdyaXRlcixcclxuICAgIFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TLFxyXG4gICAgZGV0ZWN0SW1hZ2VFeHRlbnNpb24sXHJcbiAgICByZXNvbHZlQXNzZXRVdWlkLFxyXG4gICAgc2FuaXRpemVBc3NldE5hbWUsXHJcbiAgICB0eXBlIFJhc3RlckltYWdlRXh0ZW5zaW9uLFxyXG59IGZyb20gJy4vaW1wb3J0ZXIvYXNzZXRzJztcclxuaW1wb3J0IHsgTG9jYWxBc3NldENhY2hlLCB0eXBlIENhY2hlRW50cnlLZXkgfSBmcm9tICcuL2ltcG9ydGVyL2NhY2hlJztcclxuaW1wb3J0IHR5cGUgeyBGb250QXNzZXRPcHRpb24gfSBmcm9tICcuL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgTG9jYWxSZXNvdXJjZUxpYnJhcnkgfSBmcm9tICcuL2ltcG9ydGVyL2xvY2FsLXJlc291cmNlcyc7XHJcbmltcG9ydCB7IGdyYWRpZW50UG5nIH0gZnJvbSAnLi9pbXBvcnRlci9zdmcnO1xyXG5pbXBvcnQgeyB3cml0ZVNsaWNlZFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc2xpY2VkLXBuZyc7XHJcbmltcG9ydCB7IGhpZGRlbkxheWVySWRzIH0gZnJvbSAnLi9pbXBvcnQtdmlzaWJpbGl0eSc7XHJcbmltcG9ydCB7IGlzUG5nIH0gZnJvbSAnLi9pbXBvcnRlci9yYXN0ZXItZm9ybWF0JztcclxuaW1wb3J0IHsgcGl4ZWxTaXplZFRpbGVBc3NldCwgcmFzdGVyaXplVGlsZSwgdGlsZWRSYXN0ZXJLZXkgfSBmcm9tICcuL2ltcG9ydGVyL3RpbGVkLXBuZyc7XHJcbmltcG9ydCB7IHJhc3Rlcml6ZUltYWdlRmlsbCB9IGZyb20gJy4vaW1wb3J0ZXIvaW1hZ2UtZmlsbCc7XHJcbmltcG9ydCB7XHJcbiAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMsXHJcbiAgICBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbixcclxuICAgIGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBjb2xsZWN0UHJlZmFiQ29tcG9uZW50RmlsZUlkcyxcclxuICAgIGZpZ21hRnJhbWVTb3VyY2VIYXNoLFxyXG4gICAgbWVyZ2VQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxyXG4gICAgcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZCxcclxuICAgIHJlYWRQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcmV0YWluUHJlZmFiU3luY0VudHJpZXMsXHJcbiAgICByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZSxcclxuICAgIHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgdHlwZSBQcmVmYWJTeW5jUmVjb3JkLFxyXG59IGZyb20gJy4vaW1wb3J0ZXIvcHJlZmFiLXN5bmMnO1xyXG5pbXBvcnQgeyBUb2tlblZhdWx0IH0gZnJvbSAnLi9zZWN1cml0eS90b2tlbi12YXVsdCc7XHJcbmltcG9ydCB7IEZpZ21hSW1wb3J0ZXJNY3BBcGksIHR5cGUgTWNwTm9kZU5hbWVQYXRjaCB9IGZyb20gJy4vbWNwLWFwaSc7XHJcbmltcG9ydCB7IE1jcEJyaWRnZVNlcnZlciB9IGZyb20gJy4vbWNwLWJyaWRnZS9zZXJ2ZXInO1xyXG5pbXBvcnQgeyBSb3VuZHRyaXBTZXJ2aWNlIH0gZnJvbSAnLi9yb3VuZHRyaXAvc2VydmljZSc7XHJcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcclxuaW1wb3J0IHsgZWRpdG9yUmVpbXBvcnRlciB9IGZyb20gJy4vcm91bmR0cmlwL3RyYW5zYWN0aW9uJztcclxuaW1wb3J0IHtcclxuICAgIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgICB0eXBlIERvY3VtZW50U2Vzc2lvbixcclxuICAgIHR5cGUgRmlnbWFOb2RlLFxyXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXHJcbiAgICB0eXBlIEltcG9ydERlY2lzaW9uLFxyXG4gICAgdHlwZSBJbXBvcnRPdmVycmlkZSxcclxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcclxuICAgIHR5cGUgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICB0eXBlIE5vZGVLaW5kLFxyXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcclxuICAgIHR5cGUgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgdHlwZSBQcm9ncmVzc0V2ZW50LFxyXG4gICAgdHlwZSBSZWN0LFxyXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHlwZSBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICB0eXBlIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdSZWNvcmRlciwgSW1wb3J0UmV2aWV3U2VydmljZSB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB7IGZpbmFsaXplSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3LWZpbmFsaXplJztcclxuaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcsIFJldmlld1NjZW5lIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3LW1vZGVsJztcclxuaW1wb3J0IHsgYXNzZXJ0QmF0Y2hUYXJnZXRzLCBjb2xsZWN0U2VjdGlvbkZyYW1lcywgZnJhbWVEb2N1bWVudCB9IGZyb20gJy4vYmF0Y2gtaW1wb3J0JztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgQmF0Y2hEb2N1bWVudER0bywgQmF0Y2hGcmFtZUl0ZW0sIEJhdGNoSW1wb3J0SXRlbVJlc3VsdCwgQmF0Y2hJbXBvcnRSZXF1ZXN0LFxyXG4gICAgQmF0Y2hJbXBvcnRSZXN1bHQsIEJhdGNoUHJvZ3Jlc3MsIEJhdGNoU291cmNlUmVzdWx0LCBCYXRjaFN0YXRlLFxyXG59IGZyb20gJy4vYmF0Y2gtdHlwZXMnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxuY29uc3QgaW1wb3J0UmV2aWV3cyA9IG5ldyBJbXBvcnRSZXZpZXdTZXJ2aWNlKCk7XHJcbmxldCBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlO1xyXG5sZXQgYWN0aXZlRG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVPcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IHNldHRpbmdzQ2FjaGU6IEltcG9ydFNldHRpbmdzIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZG9jdW1lbnRSZXZpc2lvbiA9IDA7XHJcbmxldCBtY3BCcmlkZ2U6IE1jcEJyaWRnZVNlcnZlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgbWNwQXBpOiBGaWdtYUltcG9ydGVyTWNwQXBpIHwgbnVsbCA9IG51bGw7XHJcbmNvbnN0IHBsdWdpbkluc3RhbmNlSWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG5sZXQgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgc2V0dGluZ3NXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmNvbnN0IE1BWF9CQVRDSF9JVEVNUyA9IDEwMDtcclxuY29uc3QgYmF0Y2hEb2N1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgeyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PigpO1xyXG5pbnRlcmZhY2UgQmF0Y2hSdW4ge1xyXG4gICAgaWQ6IHN0cmluZztcclxuICAgIGl0ZW1zOiBCYXRjaEltcG9ydEl0ZW1SZXN1bHRbXTtcclxuICAgIGluZGV4OiBudW1iZXI7XHJcbiAgICBzdG9wUmVxdWVzdGVkOiBib29sZWFuO1xyXG59XHJcbmxldCBhY3RpdmVCYXRjaDogQmF0Y2hSdW4gfCBudWxsID0gbnVsbDtcclxubGV0IGxhc3RCYXRjaFJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQgfCB1bmRlZmluZWQ7XHJcblxyXG50eXBlIERlY2lzaW9uID0gSW1wb3J0RGVjaXNpb247XHJcblxyXG5pbnRlcmZhY2UgVGlsZWRBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUmF3SW1hZ2VBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgaW1hZ2VSZWY6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICByZXZpZXdJZD86IHN0cmluZztcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIC8qKiDmnKrli77pgInoioLngrnlnKggUHJlZmFiIOS4reW3suacieeahCBmaWxlSWTvvJvmuIXnkIbml6foioLngrnml7blv4Xpobvkv53nlZnjgIIgKi9cclxuICAgIHJldGFpbk5vZGVGaWxlSWRzPzogc3RyaW5nW107XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRSZXN1bHQge1xyXG4gICAgcmV2aWV3QmVmb3JlPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXdBZnRlcj86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3PzogSW1wb3J0UmV2aWV3O1xyXG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIHByZWZhYlN5bmM/OiBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlO1xyXG4gICAgLyoqIOagh+iusOe7hOS7tuiEmuacrOWwmuacque8luivkeWujOaIkOaXtueahOmZjee6p+ivtOaYju+8m+WvvOWFpeacrOi6q+e7p+e7reaIkOWKn+OAgiAqL1xyXG4gICAgc3luY01hcmtlcldhcm5pbmc/OiBzdHJpbmc7XHJcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQXNzZXRCdWlsZFJlc3VsdCB7XHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz47XHJcbiAgICB3YXJuaW5nczogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJBc3NldEluZm8ge1xyXG4gICAgdXVpZDogc3RyaW5nO1xyXG4gICAgdXJsOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlcjogc3RyaW5nO1xyXG4gICAgdHlwZTogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZWQ6IGJvb2xlYW47XHJcbiAgICBpbnZhbGlkOiBib29sZWFuO1xyXG4gICAgaXNEaXJlY3Rvcnk/OiBib29sZWFuO1xyXG4gICAgcmVhZG9ubHk/OiBib29sZWFuO1xyXG4gICAgcmVkaXJlY3Q/OiB1bmtub3duO1xyXG59XHJcblxyXG5jb25zdCBGT05UX0VYVEVOU0lPTlMgPSBuZXcgU2V0KFsnLnR0ZicsICcub3RmJywgJy5mbnQnLCAnLndvZmYnLCAnLndvZmYyJ10pO1xyXG5jb25zdCBOT0RFX0tJTkRTID0gbmV3IFNldDxOb2RlS2luZD4oW1xyXG4gICAgJ2F1dG8nLFxyXG4gICAgJ25vZGUnLFxyXG4gICAgJ3Nwcml0ZScsXHJcbiAgICAnbGFiZWwnLFxyXG4gICAgJ3JpY2hUZXh0JyxcclxuICAgICdidXR0b24nLFxyXG4gICAgJ3Njcm9sbFZpZXcnLFxyXG4gICAgJ2xheW91dCcsXHJcbl0pO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gbGlzdEZvbnRBc3NldHMoKTogUHJvbWlzZTxGb250QXNzZXRPcHRpb25bXT4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgZm9udHM6IEZvbnRBc3NldE9wdGlvbltdID0gW107XHJcbiAgICBhc3luYyBmdW5jdGlvbiB2aXNpdChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGxldCBlbnRyaWVzO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKGZvbGRlciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ25vZGVfbW9kdWxlcycgfHwgZW50cnkubmFtZSA9PT0gJ2xpYnJhcnknIHx8IGVudHJ5Lm5hbWUgPT09ICd0ZW1wJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGZvbGRlciwgZW50cnkubmFtZSk7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB2aXNpdChmaWxlUGF0aCk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIUZPTlRfRVhURU5TSU9OUy5oYXMoZXh0bmFtZShlbnRyeS5uYW1lKS50b0xvd2VyQ2FzZSgpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIGZpbGVQYXRoKS5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbiAgICAgICAgICAgIGZvbnRzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoZW50cnkubmFtZSwgZXh0bmFtZShlbnRyeS5uYW1lKSksXHJcbiAgICAgICAgICAgICAgICB1cmw6IGBkYjovL2Fzc2V0cy8ke3BhdGh9YCxcclxuICAgICAgICAgICAgICAgIHJlbGF0aXZlUGF0aDogcGF0aCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgYXdhaXQgdmlzaXQoYXNzZXRzUm9vdCk7XHJcbiAgICByZXR1cm4gZm9udHMuc29ydCgoYSwgYikgPT4gYS5yZWxhdGl2ZVBhdGgubG9jYWxlQ29tcGFyZShiLnJlbGF0aXZlUGF0aCwgJ3poLUNOJykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0UHJvZ3Jlc3MocHJvZ3Jlc3M6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ3Byb2dyZXNzJywge1xyXG4gICAgICAgIC4uLnByb2dyZXNzLFxyXG4gICAgICAgIC4uLihhY3RpdmVCYXRjaCAmJiAhcHJvZ3Jlc3MuYmF0Y2ggPyB7IGJhdGNoOiBiYXRjaFByb2dyZXNzKGFjdGl2ZUJhdGNoKSB9IDoge30pLFxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoUHJvZ3Jlc3MocnVuOiBCYXRjaFJ1bik6IEJhdGNoUHJvZ3Jlc3Mge1xyXG4gICAgY29uc3QgY3VycmVudCA9IHJ1bi5pdGVtc1tNYXRoLm1pbihydW4uaW5kZXgsIHJ1bi5pdGVtcy5sZW5ndGggLSAxKV07XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGJhdGNoSWQ6IHJ1bi5pZCwgaXRlbUlkOiBjdXJyZW50Py5pZCA/PyAnJywgbmFtZTogY3VycmVudD8ubmFtZSA/PyAnJyxcclxuICAgICAgICBpbmRleDogTWF0aC5taW4ocnVuLmluZGV4ICsgMSwgcnVuLml0ZW1zLmxlbmd0aCksIHRvdGFsOiBydW4uaXRlbXMubGVuZ3RoLFxyXG4gICAgICAgIGNvbXBsZXRlZDogcnVuLml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJyB8fCBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCxcclxuICAgICAgICBzdG9wUmVxdWVzdGVkOiBydW4uc3RvcFJlcXVlc3RlZCxcclxuICAgICAgICBpdGVtczogcnVuLml0ZW1zLm1hcCgoaXRlbSkgPT4gKHsgLi4uaXRlbSB9KSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0Q2FjaGVGb2xkZXIoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBqb2luKEVkaXRvci5Qcm9qZWN0LnRtcERpciwgcGFja2FnZUpTT04ubmFtZSwgJ2Fzc2V0LWNhY2hlJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IEltcG9ydFNldHRpbmdzIHtcclxuICAgIGNvbnN0IGlucHV0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRTZXR0aW5ncz5cclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgaW5wdXQuc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpbnB1dC5zY2FsZSlcclxuICAgICAgICA/IE1hdGgubWF4KDAuMjUsIE1hdGgubWluKDQsIGlucHV0LnNjYWxlKSlcclxuICAgICAgICA6IERFRkFVTFRfU0VUVElOR1Muc2NhbGU7XHJcbiAgICBjb25zdCBmb250TWFwID0gaW5wdXQuZm9udE1hcCAmJiB0eXBlb2YgaW5wdXQuZm9udE1hcCA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhpbnB1dC5mb250TWFwKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChba2V5LCBpdGVtXSkgPT4ga2V5LnRyaW0oKSAmJiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGl0ZW1dKSA9PiBba2V5LnRyaW0oKSwgaXRlbS50cmltKCldKSlcclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3QgcmF3TG9jYWxGb2xkZXJzID0gQXJyYXkuaXNBcnJheShpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVycylcclxuICAgICAgICA/IGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiB0eXBlb2YgaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlciA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgPyBbaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcl1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VGb2xkZXJzID0gcmF3TG9jYWxGb2xkZXJzXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyKTogZm9sZGVyIGlzIHN0cmluZyA9PiB0eXBlb2YgZm9sZGVyID09PSAnc3RyaW5nJylcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlciwgaW5kZXgsIGZvbGRlcnMpID0+IGZvbGRlcnMuaW5kZXhPZihmb2xkZXIpID09PSBpbmRleClcclxuICAgICAgICAuc2xpY2UoMCwgMyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogdHlwZW9mIGlucHV0LnNvdXJjZVVybCA9PT0gJ3N0cmluZycgPyBpbnB1dC5zb3VyY2VVcmwudHJpbSgpIDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHR5cGVvZiBpbnB1dC5hc3NldEZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5hc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXI6IHR5cGVvZiBpbnB1dC5wcmVmYWJGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5wcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnMsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogbG9jYWxSZXNvdXJjZUZvbGRlcnNbMF0gPz8gJycsXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGlucHV0LnVwZGF0ZUV4aXN0aW5nICE9PSBmYWxzZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBpbnB1dC5yZWZyZXNoQXNzZXRzID09PSB0cnVlLFxyXG4gICAgICAgIGltcG9ydEhpZGRlbkxheWVyczogaW5wdXQuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSxcclxuICAgICAgICBhdXRvU2F2ZTogaW5wdXQuYXV0b1NhdmUgPT09IHRydWUsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzVW5sb2NrZWQoKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgaWYgKHNldHRpbmdzQ2FjaGUpIHtcclxuICAgICAgICByZXR1cm4gc2V0dGluZ3NDYWNoZTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCAncHJvamVjdCcpO1xyXG4gICAgc2V0dGluZ3NDYWNoZSA9IHNhZmVTZXR0aW5ncyhzYXZlZCk7XHJcbiAgICByZXR1cm4gc2V0dGluZ3NDYWNoZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3MoKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgYXdhaXQgc2V0dGluZ3NXcml0ZVF1ZXVlO1xyXG4gICAgcmV0dXJuIGdldFNldHRpbmdzVW5sb2NrZWQoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2l0aFNldHRpbmdzV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gc2V0dGluZ3NXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcclxuICAgIHNldHRpbmdzV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgbmV4dCA9IHNhZmVTZXR0aW5ncyh2YWx1ZSk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCBuZXh0LCAncHJvamVjdCcpO1xyXG4gICAgICAgIHNldHRpbmdzQ2FjaGUgPSBuZXh0O1xyXG4gICAgICAgIHJldHVybiBuZXh0O1xyXG4gICAgfSkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIHdpdGhTZXR0aW5nc1dyaXRlTG9jaygoKSA9PiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYXRjaFNldHRpbmdzKHZhbHVlOiBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbiAgICAgICAgcmV0dXJuIHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHsgLi4uY3VycmVudCwgLi4udmFsdWUgfSk7XHJcbiAgICB9KTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gY2xpZW50KHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQgPSBhY3RpdmVDb250cm9sbGVyPy5zaWduYWwpOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB7XHJcbiAgICByZXR1cm4gbmV3IEZpZ21hQ2xpZW50KGF3YWl0IHZhdWx0LmdldCgpLCBzaWduYWwpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByb3VuZHRyaXBTZXJ2aWNlKHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTxSb3VuZHRyaXBTZXJ2aWNlPiB7XHJcbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xyXG4gICAgcmV0dXJuIG5ldyBSb3VuZHRyaXBTZXJ2aWNlKHtcclxuICAgICAgICBjbGllbnQ6IGF3YWl0IGNsaWVudChzaWduYWwpLFxyXG4gICAgICAgIHByb2plY3RSb290OiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk6IEFib3J0Q29udHJvbGxlciB7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2ggfHwgYWN0aXZlQ29udHJvbGxlciB8fCBhcHBseWluZ0ltcG9ydFJldmlldykgdGhyb3cgbmV3IEVycm9yKCflr7zlhaXmiJbnu5PmnpzosIPmlbTmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDlkI7lho3mk43kvZwgUm91bmQtdHJpcOOAgicpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgcm91bmR0cmlwQ29udHJvbGxlciA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luT3BlcmF0aW9uKG93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IEFib3J0Q29udHJvbGxlciB7XHJcbiAgICBpZiAoYXBwbHlpbmdJbXBvcnRSZXZpZXcpIHRocm93IG5ldyBFcnJvcign5q2j5Zyo56Gu6K6k5a+85YWl5ZCO55qE6LWE5rqQ6LCD5pW077yM6K+356iN5YCZ44CCJyk7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCdSb3VuZC10cmlwIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoICYmIG93bmVyICE9PSBhY3RpdmVCYXRjaC5pZCkgdGhyb3cgbmV3IEVycm9yKCfmibnph4/lr7zlhaXmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblgZzmraLlkI7nu63ku7vliqHjgIInKTtcclxuICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnIkgRmlnbWEg5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YWI5Y+W5raI44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG93bmVyO1xyXG4gICAgcmV0dXJuIGNvbnRyb2xsZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIpOiB2b2lkIHtcclxuICAgIGlmIChhY3RpdmVDb250cm9sbGVyID09PSBjb250cm9sbGVyKSB7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICAgICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShzZWxlY3RlZFBhdGgpO1xyXG4gICAgY29uc3QgZm9sZGVyID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgaWYgKCFmb2xkZXIgfHwgZm9sZGVyID09PSAnLicgfHwgZm9sZGVyLnN0YXJ0c1dpdGgoJy4uJykgfHwgaXNBYnNvbHV0ZShmb2xkZXIpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfotYTmupDovpPlh7rnm67lvZXlv4XpobvmmK/pobnnm64gYXNzZXRzIOS4i+eahOWtkOaWh+S7tuWkueOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2V0RGF0YWJhc2VVcmwoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKGZpbGVQYXRoKTtcclxuICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBjb25zdCBvdXRzaWRlID0gcGF0aCA9PT0gJy4uJ1xyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi4vJylcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uXFxcXCcpXHJcbiAgICAgICAgfHwgaXNBYnNvbHV0ZShwYXRoKTtcclxuICAgIGlmICghcGF0aCB8fCBwYXRoID09PSAnLicgfHwgb3V0c2lkZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3BhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpfWA7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqSBGaWdtYSDlr7zlhaXotYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6npooTliLbkvZPovpPlh7rnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24sIF9pbmRleCA9IDApOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJyA/IGN1cnJlbnQudHJpbSgpIDogJyc7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgaXNBYnNvbHV0ZShjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgID8gY3VycmVudEZvbGRlclxyXG4gICAgICAgIDogcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6nmnKzlnLDlkIzlkI3otYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsaWJyYXJ5ID0gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KHNlbGVjdGVkKTtcclxuICAgIHJldHVybiB7IGZvbGRlcjogbGlicmFyeS5yb290IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVuaW9uRnJhbWUobm9kZXM6IEZpZ21hTm9kZVtdKTogUmVjdCB7XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2Rlcy5tYXAobm9kZUZyYW1lKS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgUmVjdCA9PiBCb29sZWFuKHZhbHVlKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCB4ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLngpKTtcclxuICAgIGNvbnN0IHkgPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSkpO1xyXG4gICAgY29uc3QgcmlnaHQgPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoKSk7XHJcbiAgICBjb25zdCBib3R0b20gPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCkpO1xyXG4gICAgcmV0dXJuIHsgeCwgeSwgd2lkdGg6IHJpZ2h0IC0geCwgaGVpZ2h0OiBib3R0b20gLSB5IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHtcclxuICAgIGlmIChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuaW9uRnJhbWUobm9kZS5jaGlsZHJlbik7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbn1cclxuXHJcbmNvbnN0IFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OID0gMC41O1xyXG5cclxuLyoqXHJcbiAqIE9ubHkgZXhwYW5kIHJhc3RlcnMgd2hvc2UgdmlzaWJsZSBwaXhlbHMgZXNjYXBlIHRoZSBnZW9tZXRyaWMgZnJhbWUuIEFcclxuICogcmVuZGVyIGZyYW1lIGNvbnRhaW5lZCBpbnNpZGUgdGhlIGdlb21ldHJ5IG9mdGVuIHJlcHJlc2VudHMgaW50ZW50aW9uYWxcclxuICogdHJhbnNwYXJlbnQgcGFkZGluZyBhbmQgbXVzdCBrZWVwIHRoZSBsZWdhY3kgZml4ZWQtY2FudmFzIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGdlb21ldHJ5ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcmVuZGVyID0gbm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcztcclxuICAgIGlmICghZ2VvbWV0cnkgfHwgIXJlbmRlciB8fCByZW5kZXIud2lkdGggPD0gMCB8fCByZW5kZXIuaGVpZ2h0IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZ2VvbWV0cnlSaWdodCA9IGdlb21ldHJ5LnggKyBnZW9tZXRyeS53aWR0aDtcclxuICAgIGNvbnN0IGdlb21ldHJ5Qm90dG9tID0gZ2VvbWV0cnkueSArIGdlb21ldHJ5LmhlaWdodDtcclxuICAgIGNvbnN0IHJlbmRlclJpZ2h0ID0gcmVuZGVyLnggKyByZW5kZXIud2lkdGg7XHJcbiAgICBjb25zdCByZW5kZXJCb3R0b20gPSByZW5kZXIueSArIHJlbmRlci5oZWlnaHQ7XHJcbiAgICByZXR1cm4gcmVuZGVyLnggPCBnZW9tZXRyeS54IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXIueSA8IGdlb21ldHJ5LnkgLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlclJpZ2h0ID4gZ2VvbWV0cnlSaWdodCArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyQm90dG9tID4gZ2VvbWV0cnlCb3R0b20gKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgID8gcmVuZGVyXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvcm5lclJhZGlpKG5vZGU6IEZpZ21hTm9kZSk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdIHtcclxuICAgIGlmIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpPy5sZW5ndGggPT09IDQpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJhZGl1cyA9IG5vZGUuY29ybmVyUmFkaXVzID8/IDA7XHJcbiAgICByZXR1cm4gW3JhZGl1cywgcmFkaXVzLCByYWRpdXMsIHJhZGl1c107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBEZWNpc2lvbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogaW5mZXJBY3Rpb24obm9kZSksXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXNQYXRjaENhbmRpZGF0ZShub2RlKSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWNpc2lvbkZvck5vZGUobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPik6IERlY2lzaW9uIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb247XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkZWNpc2lvbk1hcChvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10sIHRyZWU6IFRyZWVOb2RlRHRvW10pOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4ge1xyXG4gICAgY29uc3QgZGVjaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIERlY2lzaW9uPigpO1xyXG4gICAgY29uc3QgZmlnbWFTbGljZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IGFkZERlZmF1bHRzID0gKG5vZGVzOiBUcmVlTm9kZUR0b1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGlmIChub2RlLnBhdGNoQ2FuZGlkYXRlKSBmaWdtYVNsaWNlcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgICAgICAgICAgfSwgQm9vbGVhbihub2RlLnBhdGNoQ2FuZGlkYXRlKSkpO1xyXG4gICAgICAgICAgICBhZGREZWZhdWx0cyhub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgYWRkRGVmYXVsdHModHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgICAgICBkZWNpc2lvbnMuc2V0KGl0ZW0uaWQsIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICAgICAga2luZDogTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kKSA/IGl0ZW0ua2luZCA6ICdhdXRvJyxcclxuICAgICAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSxcclxuICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICAgICAgfSwgZmlnbWFTbGljZXMuaGFzKGl0ZW0uaWQpKSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb25zO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4gICAgaW5jbHVkZU5vZGVOYW1lID0gdHJ1ZSxcclxuKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCk7XHJcbiAgICByZXR1cm4gZGVjaXNpb24/LmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgfHwgKGluY2x1ZGVOb2RlTmFtZSAmJiBCb29sZWFuKGRlY2lzaW9uPy5uYW1lKSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShjaGlsZCwgZGVjaXNpb25zKSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDmnKzlnLDlkIzlkI3ntKDmnZDmiorniLblrrnlmajmlbTkvZPmj5DljYfkuLogUE5HIOaVtOWxgu+8muivpeeItuWuueWZqOeahOWtkOWxguS4jeWGjeWNleeLrOW7uuiKgueCueOAglxyXG4gKiDlr7zlhaXkuI5cIuaUueWKqOmihOajgFwi5YWx55So6L+Z5q616KeE5YiZ77yM6YG/5YWN6aKE5qOA5oqK6KKr5ZC45pS255qE5a2Q5bGC5oql5oiQXCLmlrDlop5cIuOAglxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGx5TG9jYWxQYXJlbnRQcm9tb3Rpb24oXHJcbiAgICByb290czogcmVhZG9ubHkgRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIG1hdGNoZXNMb2NhbDogKG5vZGU6IEZpZ21hTm9kZSkgPT4gUHJvbWlzZTxib29sZWFuPixcclxuICAgIHByb3RlY3RlZERlc2NlbmRhbnQ6IChub2RlOiBGaWdtYU5vZGUpID0+IGJvb2xlYW4sXHJcbiAgICBoYXNBc3NldDogKG5vZGVJZDogc3RyaW5nKSA9PiBib29sZWFuID0gKCkgPT4gZmFsc2UsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcHJvbW90ZSA9IGFzeW5jIChub2RlOiBGaWdtYU5vZGUpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICBpZiAoaGFzQXNzZXQobm9kZS5pZCkgfHwgYW5hbHl6ZU1hc2tUaW50KG5vZGUpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uICE9PSAnZ2VuZXJhdGUnKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICAgICAgLy8g6YeN5ZG95ZCN5LiN5pS55Y+Y6LWE5rqQ5Yy56YWN77yb5Y+q5pyJ6Ieq6Lqr5oiW5ZCO5Luj55qE5pi+5byP562W55Wl6KaG55uW5omN6Zi75q2i5o+Q5Y2H77yMXHJcbiAgICAgICAgICAgIC8vIOWQpuWImeiiq+WQuOaUtueahOWQjuS7o+S8mumdmem7mOa2iOWkseOAglxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcclxuICAgICAgICAgICAgLy8g5ZCM5ZCN56WW5YWI5LiN6IO95oiQ5Li65oq55o6J54us56uL5YiH54mH6LWE5rqQ5oiW6JKZ54mI6KGo56S655qE55CG55Sx44CCXHJcbiAgICAgICAgICAgICYmICFwcm90ZWN0ZWREZXNjZW5kYW50KG5vZGUpXHJcbiAgICAgICAgICAgIC8vIOeItui1hOa6kOaXoOazleihqOi+vueLrOeri+eahOmakOiXj+WQjuS7o++8jOi/meenjei+ueeVjOW/hemhu+S/neeVmeWxgue6p+OAglxyXG4gICAgICAgICAgICAmJiAhaGFzSGlkZGVuRGVzY2VuZGFudChub2RlKVxyXG4gICAgICAgICAgICAmJiBhd2FpdCBtYXRjaGVzTG9jYWwobm9kZSkpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKG5vZGUuY2hpbGRyZW4ubWFwKHByb21vdGUpKTtcclxuICAgIH07XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChyb290cy5tYXAocHJvbW90ZSkpO1xyXG59XHJcblxyXG50eXBlIFN0b3JlZE5vZGVPdmVycmlkZXMgPSBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4+O1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpOiBQcm9taXNlPFN0b3JlZE5vZGVPdmVycmlkZXM+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFN0b3JlZE5vZGVPdmVycmlkZXMgOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2tJZCA9ICcnKTogSW1wb3J0T3ZlcnJpZGUgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBpdGVtID0gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRPdmVycmlkZT47XHJcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyAmJiBpdGVtLmlkID8gaXRlbS5pZCA6IGZhbGxiYWNrSWQ7XHJcbiAgICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgaXRlbS5raW5kID09PSAnc3RyaW5nJyAmJiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpXHJcbiAgICAgICAgPyBpdGVtLmtpbmQgYXMgTm9kZUtpbmRcclxuICAgICAgICA6ICdhdXRvJztcclxuICAgIGNvbnN0IGV4cGxpY2l0ID0gaXRlbS5leHBsaWNpdCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgaWYgKCFleHBsaWNpdCAmJiAhbmFtZSkgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkLFxyXG4gICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UgPT09IHRydWUsXHJcbiAgICAgICAgZXhwbGljaXQsXHJcbiAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG5vZGVPdmVycmlkZXNGb3IoZmlsZUtleTogc3RyaW5nKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSAoYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpKVtmaWxlS2V5XSA/PyB7fTtcclxuICAgIGNvbnN0IHJlc3VsdDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzdG9yZWQpKSB7XHJcbiAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUodmFsdWUsIGlkKTtcclxuICAgICAgICBpZiAoc2FmZSkgcmVzdWx0LnB1c2goc2FmZSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBpZiAodHlwZW9mIGZpbGVLZXkgIT09ICdzdHJpbmcnIHx8ICFmaWxlS2V5LnRyaW0oKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW1zID0gQXJyYXkuaXNBcnJheSh2YWx1ZXMpID8gdmFsdWVzIDogW107XHJcbiAgICBjb25zdCBzYWZlSXRlbXMgPSBpdGVtc1xyXG4gICAgICAgIC5tYXAoKGl0ZW0pID0+IHNhZmVOb2RlT3ZlcnJpZGUoaXRlbSkpXHJcbiAgICAgICAgLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgSW1wb3J0T3ZlcnJpZGUgPT4gQm9vbGVhbihpdGVtKSk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgKEFycmF5LmlzQXJyYXkoc2NvcGVWYWx1ZXMpID8gc2NvcGVWYWx1ZXMgOiBzYWZlSXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLmlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBCb29sZWFuKGlkKSksXHJcbiAgICApO1xyXG4gICAgaWYgKCFzY29wZUlkcy5zaXplKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJHlvZPliY3lr7zlhaXojIPlm7TjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjb3BlZEl0ZW1zID0gc2FmZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2NvcGVJZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICBmb3IgKGNvbnN0IGlkIG9mIHNjb3BlSWRzKSB7XHJcbiAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHNjb3BlZEl0ZW1zKSB7XHJcbiAgICAgICAgY3VycmVudFtpdGVtLmlkXSA9IGl0ZW07XHJcbiAgICB9XHJcbiAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSB7XHJcbiAgICAgICAgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2NvcGVkSXRlbXM7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKFxyXG4gICAgICAgICgpID0+IHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoZmlsZUtleSwgdmFsdWVzLCBzY29wZVZhbHVlcyksXHJcbiAgICApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcGF0Y2hOb2RlTmFtZXMoZmlsZUtleTogc3RyaW5nLCBwYXRjaGVzOiBNY3BOb2RlTmFtZVBhdGNoW10pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIWZpbGVLZXkudHJpbSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkOiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBwYXRjaCBvZiBwYXRjaGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIHBhdGNoLmlkID09PSAnc3RyaW5nJyA/IHBhdGNoLmlkLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgICAgICBpZiAoIWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBub2RlSWTjgIInKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBzYWZlTm9kZU92ZXJyaWRlKGN1cnJlbnRbaWRdLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZhbGxiYWNrID0gc2FmZU5vZGVPdmVycmlkZShwYXRjaC5mYWxsYmFjaywgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBuZXh0ID0gZXhpc3RpbmcgPyB7IC4uLmV4aXN0aW5nIH0gOiBmYWxsYmFjayA/IHsgLi4uZmFsbGJhY2sgfSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbmV4dCAmJiBwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIW5leHQpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOe8uuWwkeacieaViOm7mOiupOetlueVpeOAgmApO1xyXG4gICAgICAgICAgICBpZiAocGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIG5leHQubmFtZTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHBhdGNoLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnmoTlkI3np7Dml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIG5leHQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUobmV4dCwgaWQpO1xyXG4gICAgICAgICAgICBpZiAoc2FmZSkge1xyXG4gICAgICAgICAgICAgICAgY3VycmVudFtpZF0gPSBzYWZlO1xyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVkLnB1c2goc2FmZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgICAgICBlbHNlIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdGVkO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFubm90YXRlRG9jdW1lbnRQbGFuKHNlc3Npb246IERvY3VtZW50U2Vzc2lvbik6IERvY3VtZW50U2Vzc2lvbiB7XHJcbiAgICBjb25zdCBkZWZhdWx0cyA9IGRlY2lzaW9uTWFwKFtdLCBzZXNzaW9uLnRyZWUpO1xyXG4gICAgc2Vzc2lvbi50cmVlID0gYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4oXHJcbiAgICAgICAgc2Vzc2lvbi50cmVlLFxyXG4gICAgICAgIGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlZmF1bHRzKSxcclxuICAgICk7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdEFzc2V0UmVxdWVzdHMoXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIHByZXBhcmVkOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldCgpLFxyXG4pOiB7IHBuZzogRmlnbWFOb2RlW107IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdOyByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W107IGdyYWRpZW50czogRmlnbWFOb2RlW10gfSB7XHJcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCBncmFkaWVudHM6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGFuY2VzdG9yc1Zpc2libGU6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBpZiAocHJlcGFyZWQuaGFzKG5vZGUuaWQpKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZWZmZWN0aXZlbHlWaXNpYmxlID0gYW5jZXN0b3JzVmlzaWJsZSAmJiBub2RlLnZpc2libGUgIT09IGZhbHNlICYmIG5vZGUub3BhY2l0eSA+IDA7XHJcbiAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlKSB7XHJcbiAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChzb3VyY2UpIHtcclxuICAgICAgICAgICAgICAgIHRpbGVkLnB1c2goeyBub2RlLCBzb3VyY2UgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaGUgc2FtZSBwbGFpbiBJTUFHRSBzb3VyY2UgYW5kIGNlbnRlcmVkIGNyb3AgcGF0aCBzZXJ2ZSBib3RoXHJcbiAgICAgICAgICAgICAgICAvLyB2aXNpYmlsaXR5IHN0YXRlczsgd2hvbGUtbm9kZSBleHBvcnRzIGNhbiBiYWtlIGRpZmZlcmVudCBhbHBoYS5cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJhd0ltYWdlcy5wdXNoKHsgbm9kZSwgaW1hZ2VSZWYgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEFzc2V0cyhcclxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4gICAgcmV2aWV3OiBJbXBvcnRSZXZpZXdSZWNvcmRlcixcclxuICAgIG9wdGlvbnM6IHsgcmVnZW5lcmF0ZU5vZGVJZHM/OiBSZWFkb25seVNldDxzdHJpbmc+IH0gPSB7fSxcclxuKTogUHJvbWlzZTxBc3NldEJ1aWxkUmVzdWx0PiB7XHJcbiAgICBjb25zdCBoaWRkZW4gPSBoaWRkZW5MYXllcklkcyhzZXNzaW9uLnJvb3RzLCBpbXBvcnRTZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlKTtcclxuICAgIGNvbnN0IGFwcGx5VmlzaWJpbGl0eSA9IChub2RlOiBGaWdtYU5vZGUpOiB2b2lkID0+IHtcclxuICAgICAgICBpZiAoaGlkZGVuLmhhcyhub2RlLmlkKSkgZGVjaXNpb25zLnNldChub2RlLmlkLCB7XHJcbiAgICAgICAgICAgIC4uLihkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKSksIGFjdGlvbjogJ2lnbm9yZScsIG5pbmVTbGljZTogZmFsc2UsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKGFwcGx5VmlzaWJpbGl0eSk7XHJcbiAgICB9O1xyXG4gICAgc2Vzc2lvbi5yb290cy5mb3JFYWNoKGFwcGx5VmlzaWJpbGl0eSk7XHJcbiAgICBjb25zdCByZXNvbHZlZERlY2lzaW9ucyA9IHJlc29sdmVBdXRvbWF0aWNNZXJnZURlY2lzaW9ucyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICByZXNvbHZlZERlY2lzaW9ucy5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHdyaXRlU3RhdGVzID0gbmV3IE1hcDxzdHJpbmcsIGJvb2xlYW4+KCk7XHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIsIGFzeW5jICh1cmwsIGV4aXN0ZWQpID0+IHtcclxuICAgICAgICBhd2FpdCByZXZpZXcuYmVmb3JlV3JpdGUodXJsLCBleGlzdGVkKTtcclxuICAgICAgICB3cml0ZVN0YXRlcy5zZXQodXJsLCBleGlzdGVkKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICAvLyBJbmRleCBleGlzdGluZyBuYW1lcyBvbmNlOyBuZXcgcmVzb3VyY2VzIGFyZSBzaGFyZWQgYnkgbmFtZSBiZWxvdy5cclxuICAgIGNvbnN0IG91dHB1dFBhdGggPSBqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnLCB3cml0ZXIuZm9sZGVyKTtcclxuICAgIGNvbnN0IG91dHB1dFJlc291cmNlcyA9IGV4aXN0c1N5bmMob3V0cHV0UGF0aCkgPyBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkob3V0cHV0UGF0aCkgOiBudWxsO1xyXG4gICAgYXdhaXQgb3V0cHV0UmVzb3VyY2VzPy5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgLy8gVGhlIHByb2plY3QgY29udHJhY3QgaXMgc2FtZSBuYW1lID0gc2FtZSByZXNvdXJjZS4gU2hhcmUgYWNyb3NzIHJlbmRlcixcclxuICAgIC8vIElNQUdFIGFuZCBncmFkaWVudCBwYXRocyBiZWZvcmUgZG93bmxvYWRpbmcgb3IgY29tcGFyaW5nIGFueSBwaXhlbHMuXHJcbiAgICBjb25zdCBzaGFyZWRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgY29uc3QgcmVzb3VyY2VLZXkgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB3cml0ZXIuYnVpbGRVcmwobm9kZS5uYW1lLCAnJywgJ3BuZycsIGltcG9ydFNldHRpbmdzLnNjYWxlKVxyXG4gICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgIGNvbnN0IHdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBub3RlID0gKGFjdGlvbjogTm9uTnVsbGFibGU8SW1wb3J0UmV2aWV3WydkZWNpc2lvbnMnXT5bbnVtYmVyXVsnYWN0aW9uJ10sIG5hbWU6IHN0cmluZywgcmVhc29uOiBzdHJpbmcsIHVybD86IHN0cmluZykgPT5cclxuICAgICAgICByZXZpZXcubm90ZT8uKGFjdGlvbiwgbmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgY29uc3Qgbm90ZVdyaXRlID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMpID0+IG5vdGUod3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybCkgPyAndXBkYXRlZCcgOiAnY3JlYXRlZCcsXHJcbiAgICAgICAgYmFzZW5hbWUoYXNzZXQudXJsKSwgd3JpdGVTdGF0ZXMuZ2V0KGFzc2V0LnVybClcclxuICAgICAgICAgICAgPyAn5YaZ5YWl5ZCM5ZCN6L6T5Ye66LWE5rqQ77yM5L+d55WZ5Y6fIFVVSUQnXHJcbiAgICAgICAgICAgIDogJ+aMieWQjeensOWvvOWFpeS4gOS7vei1hOa6kO+8jOWQjOWQjeiKgueCueebtOaOpeWFseeUqCcsIGFzc2V0LnVybCk7XHJcbiAgICBjb25zdCBub2RlU291cmNlS2V5ID0gKG5vZGU6IEZpZ21hTm9kZSwgdmFyaWFudCA9ICdyYXN0ZXItdjInKSA9PlxyXG4gICAgICAgIEpTT04uc3RyaW5naWZ5KFtzZXNzaW9uLmZpbGVLZXksIG5vZGUuaWQsIGltcG9ydFNldHRpbmdzLnNjYWxlLCB2YXJpYW50XSk7XHJcbiAgICBjb25zdCBncm91cFNvdXJjZUtleSA9IChhc3NldEtleTogc3RyaW5nKSA9PiBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCAndGlsZS12MicsIGFzc2V0S2V5XSk7XHJcbiAgICBjb25zdCBpbWFnZURldGFpbHMgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgbGV0IGxlYWYgPSBub2RlLCBpbm5lck9wYWNpdHkgPSAxO1xyXG4gICAgICAgIHdoaWxlIChsZWFmLmNoaWxkcmVuLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBsZWFmID0gbGVhZi5jaGlsZHJlblswXTtcclxuICAgICAgICAgICAgaW5uZXJPcGFjaXR5ICo9IGxlYWYub3BhY2l0eTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgbGVhZiwgaW5uZXJPcGFjaXR5IH07XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZE91dHB1dCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpID0+IHtcclxuICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgJiYgb3V0cHV0UmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgb3V0cHV0UmVzb3VyY2VzLmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICBpZiAobWF0Y2gpIHJldHVybiB7IC4uLm1hdGNoLCBzb3VyY2U6ICdleGlzdGluZycgYXMgY29uc3QgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgZmluZExvY2FsID0gYXN5bmMgKG5hbWU6IHN0cmluZywgaW5jbHVkZU91dHB1dCA9IHRydWUsIG5vZGVJZD86IHN0cmluZykgPT4ge1xyXG4gICAgICAgIC8vIOe7hOS7tuWQjOatpe+8muWPquacieWDj+e0oOaMh+e6ueWIpOWumuS4ulwi5Zu+54mH5bey5Y+Y5YyWXCLnmoToioLngrnmiY3ot7Pov4fmnKzlnLDntKDmnZDlpI3nlKjvvJtcclxuICAgICAgICAvLyDmsqHlj5jljJbnmoToioLngrnnu6fnu63lvJXnlKjpobnnm67ph4znmoTlkIzlkI3ntKDmnZDvvIzkuI3nlJ/miJDph43lpI3lm77niYfjgIJcclxuICAgICAgICBpZiAobm9kZUlkICYmIG9wdGlvbnMucmVnZW5lcmF0ZU5vZGVJZHM/Lmhhcyhub2RlSWQpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICAvLyBEaXJlY3Rvcnkgb3JkZXIsIGV4dGVuc2lvbiBwcmVmZXJlbmNlIGFuZCByb290LWJlZm9yZS1zdWJmb2xkZXJcclxuICAgICAgICAgICAgLy8gb3JkZXJpbmcgYXJlIHRoZSBleGlzdGluZyB1c2VyLWRlY2xhcmVkIG5hbWUgbWFwcGluZyBjb250cmFjdC5cclxuICAgICAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4geyAuLi5tYXRjaCwgc291cmNlOiAnbG9jYWwnIGFzIGNvbnN0IH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBpbmNsdWRlT3V0cHV0ID8gZmluZE91dHB1dChuYW1lKSA6IG51bGw7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgcHJlcGFyZU1hc2sgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nIHx8IGRlY2lzaW9uLm5pbmVTbGljZSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGFuYWx5c2lzID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpO1xyXG4gICAgICAgIGlmIChhbmFseXNpcyAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSkpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBraW5kOiAnc3ByaXRlJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgbGV0IHJlYXNvbiA9IGFuYWx5c2lzLnJlYXNvbjtcclxuICAgICAgICAgICAgaWYgKGFuYWx5c2lzLmNhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgeyBtYXNrLCB0aW50IH0gPSBhbmFseXNpcy5jYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChtYXNrLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBsb2NhbFVybCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybClcclxuICAgICAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShub2RlU291cmNlS2V5KG1hc2spLCB7IHRpbGVkOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICAgIC8vIFZlcmlmeSB0aGUgYnl0ZXMgb2YgdGhlIHJlZmVyZW5jZWQgYXNzZXQsIG5ldmVyIGFuIHVucmVsYXRlZFxyXG4gICAgICAgICAgICAgICAgLy8gc2FtZS1uYW1lIGZpbGUgZnJvbSBhIHByb2plY3QtZXh0ZXJuYWwgbGlicmFyeSBkaXJlY3RvcnkuXHJcbiAgICAgICAgICAgICAgICBjb25zdCBieXRlcyA9IGxvY2FsVXJsICYmIGFzc2V0ID8gbWF0Y2ghLmNvbnRlbnRzXHJcbiAgICAgICAgICAgICAgICAgICAgOiBhc3NldCA/IGF3YWl0IHJlYWRGaWxlKGpvaW4oRWRpdG9yLlByb2plY3QucGF0aCwgYXNzZXQudXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSkpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYnl0ZXMgPyB2ZXJpZnlXaGl0ZUFscGhhUG5nKGJ5dGVzKSA6IHsgdmFsaWQ6IGZhbHNlLCByZWFzb246ICfmsqHmnInlj6/pqozor4HnmoTmnKzlnLDnmb3oibLlupXlm74nIH07XHJcbiAgICAgICAgICAgICAgICByZWFzb24gPSB2ZXJpZmllZC5yZWFzb247XHJcbiAgICAgICAgICAgICAgICBpZiAoYXNzZXQgJiYgdmVyaWZpZWQudmFsaWQpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCB0aW50ZWQgPSB7IC4uLmFzc2V0LCB0aW50IH07XHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCB0aW50ZWQpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldmlldy5iaW5kKG5vZGUsIHRpbnRlZCwgbWF0Y2g/LnNvdXJjZSA/PyAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgICAgICBub3RlKCd0aW50ZWQnLCBub2RlLm5hbWUsIGAke2FuYWx5c2lzLnJlYXNvbn3vvJske3ZlcmlmaWVkLnJlYXNvbn3vvJvmsr/nlKjljp8gVVVJRCDkuI7kuZ3lrqvlj4LmlbDvvIzpgI/mmI7luqbku4XorqHnrpfkuIDmrKFgLCBhc3NldC51cmwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGUubmFtZSwgYCR7cmVhc29ufe+8m+S9v+eUqCBGaWdtYSDlrozmlbTokpnniYjlkIjmiJDvvIzkuI3kv67mlLnlhbHkuqvlupXlm75gKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykgcmV0dXJuO1xyXG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikgYXdhaXQgcHJlcGFyZU1hc2soY2hpbGQpO1xyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgcm9vdCBvZiBzZXNzaW9uLnJvb3RzKSBhd2FpdCBwcmVwYXJlTWFzayhyb290KTtcclxuICAgIGNvbnN0IHByb3RlY3RlZERlc2NlbmRhbnQgPSAobm9kZTogRmlnbWFOb2RlKTogYm9vbGVhbiA9PiBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY2hpbGREZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShjaGlsZCwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoY2hpbGREZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIEJvb2xlYW4oY2hpbGQuaXNNYXNrIHx8IGNoaWxkLmNoaWxkcmVuLnNvbWUoKHBhcnQpID0+IHBhcnQuaXNNYXNrKVxyXG4gICAgICAgICAgICB8fCBhc3NldHMuaGFzKGNoaWxkLmlkKSB8fCBjaGlsZERlY2lzaW9uLm5pbmVTbGljZSB8fCBpc05hbWVkU2xpY2VHcm91cChjaGlsZCkgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZCkpXHJcbiAgICAgICAgICAgIHx8IChjaGlsZERlY2lzaW9uLmFjdGlvbiAhPT0gJ3JlbmRlcicgJiYgcHJvdGVjdGVkRGVzY2VuZGFudChjaGlsZCkpO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBhcHBseUxvY2FsUGFyZW50UHJvbW90aW9uKFxyXG4gICAgICAgIHNlc3Npb24ucm9vdHMsXHJcbiAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgIGFzeW5jIChub2RlKSA9PiBCb29sZWFuKGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlLCBub2RlLmlkKSksXHJcbiAgICAgICAgcHJvdGVjdGVkRGVzY2VuZGFudCxcclxuICAgICAgICAobm9kZUlkKSA9PiBhc3NldHMuaGFzKG5vZGVJZCksXHJcbiAgICApO1xyXG4gICAgY29uc3QgZmluYWxEZWNpc2lvbnMgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xyXG4gICAgZmluYWxEZWNpc2lvbnMuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XHJcbiAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCBhY3RpdmVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IGFjdGl2ZUJvdW5kYXJ5ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybjtcclxuICAgICAgICBhY3RpdmVJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIGlmIChpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbikgfHwgZGVjaXNpb24ubmluZVNsaWNlIHx8IGFzc2V0cy5oYXMobm9kZS5pZCkpIHJldHVybjtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goYWN0aXZlQm91bmRhcnkpO1xyXG4gICAgfTtcclxuICAgIHNlc3Npb24ucm9vdHMuZm9yRWFjaChhY3RpdmVCb3VuZGFyeSk7XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgcGxhbl0gb2YgcGxhbnMpIHtcclxuICAgICAgICBpZiAoIWFjdGl2ZUlkcy5oYXMoaWQpKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBub2RlID0gc2Vzc2lvbi5ub2RlQnlJZD8uZ2V0KGlkKTtcclxuICAgICAgICBpZiAocGxhbi5yZWFzb24gPT09ICdwcmVmaXgtbWVyZ2UnKSBub3RlKCdtZXJnZWQnLCBub2RlPy5uYW1lID8/IGlkLFxyXG4gICAgICAgICAgICBwbGFuLndhcm5pbmcgPz8gJ2ljb25fL2ltZ18g5pyA5aSW5bGC6LWE5rqQ6L6555WM77yM5oyJ5b2T5YmN5pi+6ZqQ5ZCI5oiQ77yM5L+d55WZ54i26IqC54K55Yeg5L2V5LiO6YCP5piO5bqmJyk7XHJcbiAgICAgICAgZWxzZSBpZiAocGxhbi53YXJuaW5nKSB7XHJcbiAgICAgICAgICAgIHdhcm5pbmdzLmFkZChgJHtub2RlPy5uYW1lID8/IGlkfe+8miR7cGxhbi53YXJuaW5nfWApO1xyXG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGU/Lm5hbWUgPz8gaWQsIHBsYW4ud2FybmluZyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgcmVxdWVzdHMgPSBjb2xsZWN0QXNzZXRSZXF1ZXN0cyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMsIG5ldyBTZXQoYXNzZXRzLmtleXMoKSkpO1xyXG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoXHJcbiAgICAgICAgKyByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoICsgcmVxdWVzdHMuZ3JhZGllbnRzLmxlbmd0aDtcclxuICAgIGxldCBjb21wbGV0ZWQgPSAwO1xyXG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgZ2V0QXBpID0gKCkgPT4ge1xyXG4gICAgICAgIGFwaVByb21pc2UgPz89IGRpYWdub3N0aWNUYXNrKCflh4blpIcgRmlnbWEg5a6i5oi356uvJywgdW5kZWZpbmVkLCAoKSA9PiBjbGllbnQoKSk7XHJcbiAgICAgICAgcmV0dXJuIGFwaVByb21pc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGNvbXBsZXRlQXNzZXQgPSAoXHJcbiAgICAgICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnIHwgJ2dlbmVyYXRlZCcgPSAnZmlnbWEnLFxyXG4gICAgKSA9PiB7XHJcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XHJcbiAgICAgICAgcmV2aWV3LmJpbmQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgaWYgKHNvdXJjZSA9PT0gJ2xvY2FsJyB8fCBzb3VyY2UgPT09ICdleGlzdGluZycpIG5vdGUoJ3JldXNlZCcsIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgc291cmNlID09PSAnbG9jYWwnID8gJ+eUqOaIt+aMh+WumuacrOWcsOebruW9leeahOWQjOWQjeaYoOWwhO+8jOS/neeVmeWOnyBTcHJpdGVGcmFtZSBVVUlEIOS4juWIh+eJh+WPguaVsCdcclxuICAgICAgICAgICAgICAgIDogJ+aMieW3suaciei1hOa6kOaIluacrOaJueWQjOWQjei1hOa6kOWkjeeUqOWOnyBTcHJpdGVGcmFtZe+8jOS/neeVmSBVVUlEIOS4juWOn+WIh+eJh+WPguaVsCcsIGFzc2V0LnVybCk7XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xyXG4gICAgICAgICAgICA/ICflpI3nlKjmnKzlnLDotYTmupAnXHJcbiAgICAgICAgICAgIDogc291cmNlID09PSAnZXhpc3RpbmcnXHJcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXHJcbiAgICAgICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2dlbmVyYXRlZCdcclxuICAgICAgICAgICAgICAgICAgICA/ICfnlJ/miJDmuJDlj5gnXHJcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHt2ZXJifSAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1RpbGVkID0gYXN5bmMgKGl0ZW1zOiBUaWxlZEFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxuICAgICAgICAgICAgc291cmNlS2V5OiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGFzc2V0S2V5OiBzdHJpbmc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBQZW5kaW5nVGlsZSBleHRlbmRzIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcclxuICAgICAgICAgICAgc291cmNlVHlwZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgICAgICBzb3VyY2VSZW5kZXJTY2FsZT86IG51bWJlcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdGVkU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBpbXBvcnRTZXR0aW5ncy5zY2FsZSAqIHNvdXJjZS5zY2FsZTtcclxuICAgICAgICBjb25zdCByZW5kZXJTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IHNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgID8gY2xhbXBJbWFnZVNjYWxlKHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpXHJcbiAgICAgICAgICAgIDogMTtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgVGlsZUdyb3VwPigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgeyBub2RlLCBzb3VyY2UgfSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2VLZXkgPSBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBzb3VyY2Uua2luZCxcclxuICAgICAgICAgICAgICAgIGlkOiBzb3VyY2UuaWQsXHJcbiAgICAgICAgICAgICAgICBwYWludFNjYWxlOiBzb3VyY2Uuc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByZW5kZXJTY2FsZTogcmVuZGVyU2NhbGUoc291cmNlKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0S2V5ID0gdGlsZWRSYXN0ZXJLZXkoc291cmNlS2V5LCByZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwobm9kZS5uYW1lLCBhc3NldEtleSwgJ3BuZycpXHJcbiAgICAgICAgICAgICAgICAubm9ybWFsaXplKCdORktDJylcclxuICAgICAgICAgICAgICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlLCBub2RlczogW10sIHNvdXJjZSwgc291cmNlS2V5LCBhc3NldEtleSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogUGVuZGluZ1RpbGVbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IG5hbWVkTG9jYWxUaWxlcyA9IG5ldyBNYXA8c3RyaW5nLCB7XHJcbiAgICAgICAgICAgIG1hdGNoOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGZpbmRMb2NhbD4+O1xyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjIHwgbnVsbDtcclxuICAgICAgICB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbmFtZUtleSA9IHJlc291cmNlS2V5KGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBsZXQgbG9jYWwgPSBuYW1lZExvY2FsVGlsZXMuZ2V0KG5hbWVLZXkpO1xyXG4gICAgICAgICAgICBpZiAoIWxvY2FsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChncm91cC5ub2RlLm5hbWUsIGZhbHNlLCBncm91cC5ub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGlmIChsb2NhbFVybCAmJiAhYXNzZXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5pys5Zyw6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM6K+35YWI5ZyoIENvY29zIOS4reWujOaIkOi1hOa6kOWvvOWFpeWQjumHjeivle+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICBsb2NhbCA9IHsgbWF0Y2gsIGFzc2V0IH07XHJcbiAgICAgICAgICAgICAgICBuYW1lZExvY2FsVGlsZXMuc2V0KG5hbWVLZXksIGxvY2FsKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobG9jYWwuYXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIC8vIFRpbGluZyBhbmQgaXRzIHBlcmlvZCBiZWxvbmcgdG8gdGhpcyBub2RlLCBub3QgdGhlIHNoYXJlZFxyXG4gICAgICAgICAgICAgICAgLy8gU3ByaXRlRnJhbWUgTWV0YS4gS2VlcCB0aGUgb3JpZ2luYWwgVVVJRCBhbmQgcGl4ZWxzIGludGFjdC5cclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHsgLi4ubG9jYWwuYXNzZXQsIHNsaWNlZDogZmFsc2UsIHRpbGVkOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIHRpbGVTY2FsZTogcmVxdWVzdGVkU2NhbGUoZ3JvdXAuc291cmNlKSB9LCAnbG9jYWwnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbC5tYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgLy8gQW4gZXh0ZXJuYWwgYml0bWFwIGhhcyBubyBwcm9qZWN0IFVVSUQuIEltcG9ydCBpdCB0aHJvdWdoXHJcbiAgICAgICAgICAgICAgICAvLyB0aGUgZXhpc3RpbmcgZ2VuZXJhdGVkLXRpbGUgcGF0aCwgd2l0aCBpdHMgdW5zY2FsZWQgcGl4ZWxzLlxyXG4gICAgICAgICAgICAgICAgcGVuZGluZy5wdXNoKHsgLi4uZ3JvdXAsIGNvbnRlbnRzOiBsb2NhbC5tYXRjaC5jb250ZW50cyxcclxuICAgICAgICAgICAgICAgICAgICBleHRlbnNpb246IGRldGVjdEltYWdlRXh0ZW5zaW9uKGxvY2FsLm1hdGNoLmNvbnRlbnRzKSwgc291cmNlVHlwZTogJ2xvY2FsJywgc291cmNlUmVuZGVyU2NhbGU6IDEgfSk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdBc3NldDogU3ByaXRlQXNzZXRTcGVjIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZXhpc3RpbmdBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShncm91cFNvdXJjZUtleShncm91cC5hc3NldEtleSksIHsgdGlsZWQ6IHRydWUgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHBpeGVsU2l6ZWRUaWxlQXNzZXQoZXhpc3RpbmdBc3NldCksICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZEV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBbJ3BuZyddXHJcbiAgICAgICAgICAgICAgICAgICAgOiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUztcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoZ3JvdXAuc291cmNlKSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gY2FjaGVkO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyxcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogY2FjaGVkRXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVyblVybHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nIHwgbnVsbD4oKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJlbW90ZUl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNvdXJjZS5raW5kICE9PSAnc291cmNlLW5vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzY2FsZSA9IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGlkcy5hZGQoaXRlbS5zb3VyY2UuaWQpO1xyXG4gICAgICAgICAgICBwYXR0ZXJuc0J5U2NhbGUuc2V0KHNjYWxlLCBpZHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IFtzY2FsZSwgaWRzXSBvZiBwYXR0ZXJuc0J5U2NhbGUpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShpZHMpLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbaWQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXModXJscykpIHtcclxuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcclxuICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gbmVlZHNJbWFnZUZpbGxzXHJcbiAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSlcclxuICAgICAgICAgICAgOiB7fTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkID0gKHVybDogc3RyaW5nLCBub2RlTGFiZWw6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQodXJsKTtcclxuICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQodXJsLCBub2RlTGFiZWwpKTtcclxuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gdGFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2l0ZW0uc291cmNlLmlkfTpzY2FsZToke3JlbmRlclNjYWxlKGl0ZW0uc291cmNlKX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIClcclxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYElNQUdFIOWhq+WFhSAke2l0ZW0uc291cmNlLmlkfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5Dkvpske2xhYmVsfe+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7aXRlbS5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+W5s+mTuui1hOa6kOaMieWunumZheWwuuWvuOeUn+aIkCcsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgIGxldCByYXN0ZXI6IFJldHVyblR5cGU8dHlwZW9mIHJhc3Rlcml6ZVRpbGU+O1xyXG4gICAgICAgICAgICB0cnkgeyByYXN0ZXIgPSByYXN0ZXJpemVUaWxlKGNvbnRlbnRzLCByZXF1ZXN0ZWRTY2FsZShpdGVtLnNvdXJjZSksIGl0ZW0uc291cmNlUmVuZGVyU2NhbGUgPz8gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpKTsgfVxyXG4gICAgICAgICAgICBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlubPpk7rotYTmupDigJwke2l0ZW0ubm9kZS5uYW1lfeKAneaXoOazleaMieWunumZheWwuuWvuOeUn+aIkO+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChyYXN0ZXIucm91bmRlZCkgd2FybmluZ3MuYWRkKGDlubPpk7rotYTmupDigJwke2l0ZW0ubm9kZS5uYW1lfeKAneeahOaYvuekuuWwuuWvuOW3suWPluaVtOS4uiAke3Jhc3Rlci53aWR0aH3DlyR7cmFzdGVyLmhlaWdodH0g5YOP57Sg77yI5pyA5bCPIDHvvInvvIzoioLngrkgU2NhbGUg5L+d5oyBIDHjgIJgKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwoaXRlbS5ub2RlLm5hbWUsIGl0ZW0uYXNzZXRLZXksICdwbmcnKTtcclxuICAgICAgICAgICAgY29tcGxldGVHcm91cChcclxuICAgICAgICAgICAgICAgIGl0ZW0ubm9kZXMsXHJcbiAgICAgICAgICAgICAgICBwaXhlbFNpemVkVGlsZUFzc2V0KGF3YWl0IHdyaXRlci5yZXNvbHZlKHVybCwgcmFzdGVyLmNvbnRlbnRzLCB7IHNvdXJjZUtleTogZ3JvdXBTb3VyY2VLZXkoaXRlbS5hc3NldEtleSksIHRpbGVkOiB0cnVlIH0pKSxcclxuICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlVHlwZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgdHJhY2UuZG9uZSh7IHNvdXJjZVdpZHRoOiByYXN0ZXIuc291cmNlV2lkdGgsIHNvdXJjZUhlaWdodDogcmFzdGVyLnNvdXJjZUhlaWdodCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiByYXN0ZXIud2lkdGgsIGhlaWdodDogcmFzdGVyLmhlaWdodCwgdGlsZVNjYWxlOiAxIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1JlbW90ZSA9IGFzeW5jIChub2RlczogRmlnbWFOb2RlW10pID0+IHtcclxuICAgICAgICBpZiAoIW5vZGVzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZvcm1hdCA9ICdwbmcnIGFzIGNvbnN0O1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHVybDogc3RyaW5nOyBub2RlczogRmlnbWFOb2RlW10gfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9YCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSByZXNvdXJjZUtleShub2RlKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBBcnJheTx7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICB1cmw6IHN0cmluZztcclxuICAgICAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfTtcclxuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XHJcbiAgICAgICAgICAgIHJlbmRlckZyYW1lPzogUmVjdDtcclxuICAgICAgICAgICAga2V5OiBDYWNoZUVudHJ5S2V5O1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfT4gPSBbXTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vIEEgZGVjbGFyZWQgRmlnbWEgc2xpY2Ugb3ducyB0aGlzIHNhbWUtbmFtZSByZXNvdXJjZSBldmVuIHdoZW4gYW5cclxuICAgICAgICAgICAgLy8gb3JkaW5hcnkgUE5HIHdhcyBlbmNvdW50ZXJlZCBmaXJzdC4gSU1BR0UgYW5kIGdyYWRpZW50IHN0YWdlc1xyXG4gICAgICAgICAgICAvLyBydW4gbGF0ZXIgYW5kIHNoYXJlIHRoaXMgc2luZ2xlIGdlbmVyYXRlZCByZXN1bHQuXHJcbiAgICAgICAgICAgIGNvbnN0IHNsaWNlZFNvdXJjZXMgPSBncm91cGVkTm9kZXMuZmxhdE1hcCgoY2FuZGlkYXRlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZGVjaXNpb25Gb3JOb2RlKGNhbmRpZGF0ZSwgZGVjaXNpb25zKS5hY3Rpb24gPT09ICdpZ25vcmUnKSByZXR1cm4gW107XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhbmFseXNpcyA9IGFuYWx5emVTbGljZUdyaWQoY2FuZGlkYXRlKTtcclxuICAgICAgICAgICAgICAgIHJldHVybiBhbmFseXNpcyA/IFt7IG5vZGU6IGNhbmRpZGF0ZSwgYW5hbHlzaXMgfV0gOiBbXTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkU2xpY2UgPSBzbGljZWRTb3VyY2VzWzBdO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gc2VsZWN0ZWRTbGljZT8ubm9kZSA/PyBncm91cGVkTm9kZXNbMF07XHJcbiAgICAgICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBzZWxlY3RlZFNsaWNlPy5hbmFseXNpcyA/PyAoZGVjaXNpb24ubmluZVNsaWNlID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKSA6IG51bGwpO1xyXG4gICAgICAgICAgICBjb25zdCByZXVzZUFzc2V0ID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsIHNvdXJjZTogJ2xvY2FsJyB8ICdleGlzdGluZycpID0+IHtcclxuICAgICAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGFzc2V0KTtcclxuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIWFzc2V0LnNsaWNlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneW3suebtOaOpeW8leeUqOWQjOWQjei1hOa6kO+8jOS9huivpSBTcHJpdGVGcmFtZSDmnKrphY3nva7kuZ3lrqvovrnot53vvIzmmoLmjInmma7pgJogU3ByaXRlIOaYvuekuu+8m+ivt+WcqOWOn+i1hOa6kOS4reiuvue9rui+uei3ne+8miR7YXNzZXQudXJsfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cGVkTm9kZXMsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBjb25zdCBzaGFyZWQgPSBzbGljZUFuYWx5c2lzID8gdW5kZWZpbmVkIDogc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmIChzaGFyZWQpIHtcclxuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQoc2hhcmVkLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsTWF0Y2ggPSBhbmFseXplTWFza1RpbnQobm9kZSkgJiYgIXNsaWNlQW5hbHlzaXMgPyBudWxsIDogYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UsIG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAvLyBBbiBleHBsaWNpdGx5IGRlc2lnbmF0ZWQgbG9jYWwgU3ByaXRlRnJhbWUgb3ducyBpdHMgcGl4ZWxzIGFuZFxyXG4gICAgICAgICAgICAvLyBpbnNldHMuIFJldXNlIGl0IHJlYWQtb25seSwgZXZlbiB3aGVuIEZpZ21hIGRlZmluZXMgYSBzbGljZSBvclxyXG4gICAgICAgICAgICAvLyByZWZyZXNoIGlzIHJlcXVlc3RlZDsgc291cmNlIGluc2V0cyBjYW5ub3QgYmUgYXBwbGllZCB0byBhblxyXG4gICAgICAgICAgICAvLyB1bmtub3duIG9yIGFscmVhZHktY29tcGFjdGVkIGxvY2FsIGNhbnZhcy5cclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBsb2NhbE1hdGNoXHJcbiAgICAgICAgICAgICAgICA/IGFzc2V0RGF0YWJhc2VVcmwobG9jYWxNYXRjaC5wYXRoKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGxvY2FsQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQobG9jYWxBc3NldCwgbG9jYWxNYXRjaCEuc291cmNlKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbFVybCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3mnKzlnLDotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzor7flhYjlnKggQ29jb3Mg5Lit5a6M5oiQ6LWE5rqQ5a+85YWl5bm26K6+572u5Li6IFNwcml0ZUZyYW1lIOWQjumHjeivle+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhc2xpY2VBbmFseXNpcyAmJiAhbG9jYWxNYXRjaCAmJiAhYW5hbHl6ZU1hc2tUaW50KG5vZGUpID8gYXdhaXQgZmluZE91dHB1dChub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lZEFzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKTtcclxuICAgICAgICAgICAgICAgIGlmICghbmFtZWRBc3NldCkgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XHJcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KG5hbWVkQXNzZXQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHNlbGVjdGVkU2xpY2UgJiYgIWxvY2FsTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHNoYXBlID0gKGVudHJ5OiB0eXBlb2Ygc2VsZWN0ZWRTbGljZSkgPT4gSlNPTi5zdHJpbmdpZnkoeyBtb2RlOiBlbnRyeS5hbmFseXNpcy5tb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGJvcmRlcnM6IGVudHJ5LmFuYWx5c2lzLmJvcmRlcnMsIGZyYW1lOiBlbnRyeS5ub2RlLmFic29sdXRlQm91bmRpbmdCb3ggJiYge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogZW50cnkubm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94LndpZHRoLCBoZWlnaHQ6IGVudHJ5Lm5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveC5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICAgICAgfSB9KTtcclxuICAgICAgICAgICAgICAgIGlmIChzbGljZWRTb3VyY2VzLnNsaWNlKDEpLnNvbWUoKGVudHJ5KSA9PiBzaGFwZShlbnRyeSkgIT09IHNoYXBlKHNlbGVjdGVkU2xpY2UpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGDlkIzlkI3kuIkv5Lmd5a6r5a6a5LmJ5LiN5ZCM77yM5rK/55So6aaW5Liq5pyJ5pWIIEZpZ21hIOWIh+eJh+KAnCR7bm9kZS5uYW1lfeKAneeahOWOn+Wni+eUu+W4g+S4jui+uei3ne+8jOS7heeUn+aIkOS4gOS7vei1hOa6kGA7XHJcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKHJlYXNvbik7XHJcbiAgICAgICAgICAgICAgICAgICAgbm90ZSgnbWVyZ2VkJywgbm9kZS5uYW1lLCByZWFzb24sIHVybCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBub3RlKCdtZXJnZWQnLCBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgJ0ZpZ21hIOS4iS/kuZ3lrqvlrprkuYnkvJjlhYjvvJrkvb/nlKggRmlnbWEg5Y6f5aeL55S75biD5LiO6L656Led55Sf5oiQ6L6T5Ye66LWE5rqQ77yM5LiN5rK/55So5pyq5oyH5a6a6L6T5Ye66LWE5rqQ55qE5pen6L656LedJywgdXJsKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlICYmICFzbGljZUFuYWx5c2lzKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3ml6Dms5XorqHnrpfov57nu63liIfniYfovrnnlYzvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGJvcmRlcnMgPSBzbGljZUFuYWx5c2lzPy5ib3JkZXJzO1xyXG4gICAgICAgICAgICAvLyBOZXcgc2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlXHJcbiAgICAgICAgICAgIC8vIHRoZWlyIGdlbmVyYXRlZCBib3JkZXJzIHVzZSB0aGF0IGNvb3JkaW5hdGUgc3BhY2UuXHJcbiAgICAgICAgICAgIGNvbnN0IHJlbmRlckZyYW1lID0gYm9yZGVycyA/IHVuZGVmaW5lZCA6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleTogQ2FjaGVFbnRyeUtleSA9IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHZhcmlhbnQ6IHJlbmRlckZyYW1lID8gJ3Zpc3VhbC1vdmVyZmxvdy12MScgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGxldCBjYWNoZWQgPSBsb2NhbE1hdGNoIHx8IGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHNcclxuICAgICAgICAgICAgICAgID8gbnVsbFxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCBjYWNoZS5yZWFkKGtleSk7XHJcbiAgICAgICAgICAgIGlmIChzbGljZUFuYWx5c2lzICYmIGNhY2hlZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3ghO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaXNGdWxsQ2FudmFzID0gaXNQbmcoY2FjaGVkKSAmJiBjYWNoZWQubGVuZ3RoID49IDI0XHJcbiAgICAgICAgICAgICAgICAgICAgJiYgY2FjaGVkLnRvU3RyaW5nKCdhc2NpaScsIDEyLCAxNikgPT09ICdJSERSJ1xyXG4gICAgICAgICAgICAgICAgICAgICYmIE1hdGguYWJzKGNhY2hlZC5yZWFkVUludDMyQkUoMTYpIC0gZnJhbWUud2lkdGggKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSkgPD0gMVxyXG4gICAgICAgICAgICAgICAgICAgICYmIE1hdGguYWJzKGNhY2hlZC5yZWFkVUludDMyQkUoMjApIC0gZnJhbWUuaGVpZ2h0ICogaW1wb3J0U2V0dGluZ3Muc2NhbGUpIDw9IDE7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWlzRnVsbENhbnZhcykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNhY2hlZCA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlLm5hbWUsICfnvJPlrZjkuI3mmK8gRmlnbWEg5a6M5pW055S75biD77yM6YeN5paw5a+85Ye65Y6f5aeLIFBORyDlkI7lho3lupTnlKjkuIkv5Lmd5a6r6L656LedJywgdXJsKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIG5vZGVzOiBncm91cGVkTm9kZXMsXHJcbiAgICAgICAgICAgICAgICB1cmw6IGxvY2FsTWF0Y2ggJiYgZGV0ZWN0SW1hZ2VFeHRlbnNpb24obG9jYWxNYXRjaC5jb250ZW50cykgPT09ICdqcGcnXHJcbiAgICAgICAgICAgICAgICAgICAgPyB1cmwucmVwbGFjZSgvXFwucG5nJC9pLCAnLmpwZycpIDogdXJsLFxyXG4gICAgICAgICAgICAgICAgYm9yZGVycyxcclxuICAgICAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM6IHNsaWNlQW5hbHlzaXMgPz8gdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyRnJhbWU6IGxvY2FsTWF0Y2ggPyB1bmRlZmluZWQgOiByZW5kZXJGcmFtZSxcclxuICAgICAgICAgICAgICAgIGtleSxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzOiBsb2NhbE1hdGNoPy5jb250ZW50cyA/PyBjYWNoZWQsXHJcbiAgICAgICAgICAgICAgICBzb3VyY2U6IGxvY2FsTWF0Y2ggPyAnbG9jYWwnIDogY2FjaGVkID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB1cmxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPiA9IHt9O1xyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHVzZUFic29sdXRlQm91bmRzIG9mIFt0cnVlLCBmYWxzZV0pIHtcclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSByZW1vdGVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzID8gIWl0ZW0ucmVuZGVyRnJhbWUgOiBCb29sZWFuKGl0ZW0ucmVuZGVyRnJhbWUpXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgICAgICBpZiAoIWJhdGNoLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih1cmxzLCBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGJhdGNoLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMsXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZnJvbUVudHJpZXMoYmF0Y2gubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGUubmFtZV0pKSxcclxuICAgICAgICAgICAgKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gdXJsc1tpdGVtLm5vZGUuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDvea4suafk+iKgueCue+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKGl0ZW0ua2V5LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgbGV0IGFzc2V0OiBTcHJpdGVBc3NldFNwZWM7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNsaWNlQW5hbHlzaXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCfkuIkv5Lmd5a6r6LWE5rqQ5pyA5bCP5YyWJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdyaXRlU2xpY2VkUG5nKHdyaXRlciwgaXRlbS51cmwsIGNvbnRlbnRzLCBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zbGljZUFuYWx5c2lzLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IHJlc3VsdC5hc3NldDtcclxuICAgICAgICAgICAgICAgIHRyYWNlLmRvbmUocmVzdWx0Lm9wdGltaXphdGlvbik7XHJcbiAgICAgICAgICAgICAgICBub3RlKGFzc2V0LnNsaWNlRmFsbGJhY2sgPyAnZmFsbGJhY2snIDogJ21lcmdlZCcsIGl0ZW0ubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGDkuIkv5Lmd5a6r77yaJHtyZXN1bHQub3B0aW1pemF0aW9uLnJlYXNvbiA/PyByZXN1bHQub3B0aW1pemF0aW9uLnN0YXR1c31gLCBhc3NldC51cmwpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUoaXRlbS51cmwsIGNvbnRlbnRzLCBpdGVtLmJvcmRlcnMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG5vdGVXcml0ZShhc3NldCk7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkoaXRlbS5ub2RlKSwgYXNzZXQpO1xyXG4gICAgICAgICAgICBpZiAoYXNzZXQuc2xpY2VGYWxsYmFjaykge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtpdGVtLm5vZGUubmFtZX3igJ3liIfniYforr7nva7lpLHotKXvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpe+8miR7YXNzZXQuc2xpY2VGYWxsYmFja31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGl0ZW0ubm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgZ3JvdXBlZE5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5yZW5kZXJGcmFtZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IHsgLi4uYXNzZXQsIHJlbmRlckZyYW1lOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKGdyb3VwZWROb2RlKSA/PyBpdGVtLnJlbmRlckZyYW1lIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBhc3NldCxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSYXdJbWFnZXMgPSBhc3luYyAoaXRlbXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10pID0+IHtcclxuICAgICAgICBpZiAoIWl0ZW1zLmxlbmd0aCkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IG5vZGU6IEZpZ21hTm9kZTsgbm9kZXM6IEZpZ21hTm9kZVtdOyBpbWFnZVJlZjogc3RyaW5nIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHJlc291cmNlS2V5KGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZTogaXRlbS5ub2RlLCBub2RlczogW10sIGltYWdlUmVmOiBpdGVtLmltYWdlUmVmIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2goaXRlbS5ub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxldCBpbWFnZUZpbGxVcmxzUHJvbWlzZTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUltYWdlcyA9IChub2RlczogRmlnbWFOb2RlW10sIGJhc2U6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2V4aXN0aW5nJyB8ICdjYWNoZScgfCAnZmlnbWEnKSA9PiB7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZXNbMF0pLCBiYXNlKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IGlubmVyT3BhY2l0eSB9ID0gaW1hZ2VEZXRhaWxzKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBpbm5lck9wYWNpdHkgPCAxID8geyAuLi5iYXNlLCB0aW50OiB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IGlubmVyT3BhY2l0eSB9IH0gOiBiYXNlO1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgY29uc3Qgc2hhcmVkID0gc2hhcmVkQXNzZXRzLmdldChyZXNvdXJjZUtleShncm91cC5ub2RlKSk7XHJcbiAgICAgICAgICAgIGlmIChzaGFyZWQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlSW1hZ2VzKGdyb3VwLm5vZGVzLCBzaGFyZWQsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgeyBsZWFmIH0gPSBpbWFnZURldGFpbHMoZ3JvdXAubm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgZmluZExvY2FsKGdyb3VwLm5vZGUubmFtZSwgZmFsc2UsIGdyb3VwLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBsb2NhbFVybCA9IG1hdGNoID8gYXNzZXREYXRhYmFzZVVybChtYXRjaC5wYXRoKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChsb2NhbFVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhsb2NhbFVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWxvY2FsQXNzZXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5pys5Zyw6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlSW1hZ2VzKGdyb3VwLm5vZGVzLCBsb2NhbEFzc2V0LCBtYXRjaCEuc291cmNlKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIW1hdGNoID8gYXdhaXQgZmluZE91dHB1dChncm91cC5ub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBuYW1lZE91dHB1dCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmcpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlSW1hZ2VzKGdyb3VwLm5vZGVzLCBleGlzdGluZywgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgbGV0IHNvdXJjZTogJ2NhY2hlJyB8ICdmaWdtYScgPSAnY2FjaGUnO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGNhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBjYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWltYWdlRmlsbFVybHNQcm9taXNlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaW1hZ2VGaWxsVXJsc1Byb21pc2UgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSkpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IGF3YWl0IGltYWdlRmlsbFVybHNQcm9taXNlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gaW1hZ2VGaWxsVXJsc1tncm91cC5pbWFnZVJlZl07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95o+Q5L6b6ZqQ6JeP5Zu+54mH5aGr5YWF77yaJHtncm91cC5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQocmVtb3RlVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZChyZW1vdGVVcmwsIGAke2dyb3VwLm5vZGUubmFtZX0gKCR7Z3JvdXAubm9kZS5pZH0pYCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQocmVtb3RlVXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgdGFzaztcclxuICAgICAgICAgICAgICAgIHNvdXJjZSA9ICdmaWdtYSc7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZXh0ZW5zaW9uID8/PSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGwgPSBsZWFmLmZpbGxzLmZpbmQoKHBhaW50KSA9PiBwYWludC52aXNpYmxlICE9PSBmYWxzZSAmJiBwYWludC50eXBlID09PSAnSU1BR0UnKTtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUoZ3JvdXAubm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJhc3RlciA9IHJhc3Rlcml6ZUltYWdlRmlsbChjb250ZW50cywgZmlsbD8uc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnRklUJyA/ICdGSVQnIDogJ0ZJTEwnLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUud2lkdGgsIGZyYW1lLmhlaWdodCwgaW1wb3J0U2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OmltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIHJhc3Rlcik7XHJcbiAgICAgICAgICAgIG5vdGVXcml0ZShyZXNvbHZlZCk7XHJcbiAgICAgICAgICAgIGlmIChncm91cC5ub2RlLmNoaWxkcmVuLmxlbmd0aCkgbm90ZSgnbWVyZ2VkJywgZ3JvdXAubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgJ+aZrumAmiBJTUFHRSDlnKjpmpDol4/lkozmmL7npLrnirbmgIHkvb/nlKjnm7jlkIzkuK3lv4Poo4HliIcv6YCC6YWN77yb5rqQ5Zu+57yT5a2Y5L+d55WZ5Y6f5aeL5YOP57Sg77yM6IqC54K56YCP5piO5bqm5Y2V54us5bqU55SoJywgcmVzb2x2ZWQudXJsKTtcclxuICAgICAgICAgICAgY29tcGxldGVJbWFnZXMoZ3JvdXAubm9kZXMsIHJlc29sdmVkLCBzb3VyY2UpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+W5s+mTuui1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnRpbGVkLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzVGlsZWQocmVxdWVzdHMudGlsZWQpKTtcclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIcgUE5HIOi1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnBuZy5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1JlbW90ZShyZXF1ZXN0cy5wbmcpKTtcclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIfljp/lp4sgSU1BR0Ug5aGr5YWF6LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMucmF3SW1hZ2VzLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzUmF3SW1hZ2VzKHJlcXVlc3RzLnJhd0ltYWdlcykpO1xyXG5cclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiByZXF1ZXN0cy5ncmFkaWVudHMpIHtcclxuICAgICAgICBjb25zdCBzaGFyZWQgPSBzaGFyZWRBc3NldHMuZ2V0KHJlc291cmNlS2V5KG5vZGUpKTtcclxuICAgICAgICBpZiAoc2hhcmVkKSB7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgc2hhcmVkLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5hbWVkID0gYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UsIG5vZGUuaWQpO1xyXG4gICAgICAgIGNvbnN0IG5hbWVkVXJsID0gbmFtZWQgPyBhc3NldERhdGFiYXNlVXJsKG5hbWVkLnBhdGgpIDogbnVsbDtcclxuICAgICAgICBpZiAobmFtZWRVcmwpIHtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobmFtZWRVcmwpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRVcmx9YCk7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGV4aXN0aW5nKTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBleGlzdGluZywgbmFtZWQhLnNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuYW1lZE91dHB1dCA9ICFuYW1lZCA/IGF3YWl0IGZpbmRPdXRwdXQobm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGFzc2V0RGF0YWJhc2VVcmwobmFtZWRPdXRwdXQucGF0aCkhKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZykgdGhyb3cgbmV3IEVycm9yKGDlkIzlkI3lt7LmnInotYTmupDlsJrml6Dlj6/nlKggU3ByaXRlRnJhbWXvvIzkuI3kvJrlj6blu7rlia/mnKzvvJoke25hbWVkT3V0cHV0LnBhdGh9YCk7XHJcbiAgICAgICAgICAgIHNoYXJlZEFzc2V0cy5zZXQocmVzb3VyY2VLZXkobm9kZSksIGV4aXN0aW5nKTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBleGlzdGluZywgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgY29uc3QgcG5nID0gZnJhbWUgJiYgZmlsbFxyXG4gICAgICAgICAgICA/IGdyYWRpZW50UG5nKFxyXG4gICAgICAgICAgICAgICAgZnJhbWUud2lkdGgsXHJcbiAgICAgICAgICAgICAgICBmcmFtZS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICBmaWxsLFxyXG4gICAgICAgICAgICAgICAgY29ybmVyUmFkaWkobm9kZSksXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKHBuZykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH06Z3JhZGllbnRgLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBwbmcpO1xyXG4gICAgICAgICAgICBub3RlV3JpdGUoYXNzZXQpO1xyXG4gICAgICAgICAgICBzaGFyZWRBc3NldHMuc2V0KHJlc291cmNlS2V5KG5vZGUpLCBhc3NldCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsICdnZW5lcmF0ZWQnKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg55Sf5oiQ5riQ5Y+YICR7Y29tcGxldGVkfS8ke3RvdGFsfSDCtyAke25vZGUubmFtZX1gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBldmVudCBvZiB3cml0ZXIuZXZlbnRzKSBub3RlKGV2ZW50LmFjdGlvbiwgYmFzZW5hbWUoZXZlbnQudXJsKSwgZXZlbnQucmVhc29uLCBldmVudC51cmwpO1xyXG4gICAgcmV0dXJuIHsgYXNzZXRzLCB3YXJuaW5nczogWy4uLndhcm5pbmdzXSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlRm9udHMoc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogUHJvbWlzZTxNYXA8c3RyaW5nLCBzdHJpbmc+PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xyXG4gICAgZm9yIChjb25zdCBbZmFtaWx5LCB1cmxdIG9mIE9iamVjdC5lbnRyaWVzKHNldHRpbmdzLmZvbnRNYXApKSB7XHJcbiAgICAgICAgaWYgKCF1cmwpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCByZXNvbHZlQXNzZXRVdWlkKHVybCk7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChmYW1pbHksIHV1aWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluZmVycmVkTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbmF0aXZlTW9kZSA9IGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpO1xyXG4gICAgaWYgKG5hdGl2ZU1vZGUpIHtcclxuICAgICAgICByZXR1cm4gbmF0aXZlTW9kZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZS5jaGlsZHJlblxyXG4gICAgICAgIC5tYXAoKGNoaWxkKSA9PiBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgIC5maWx0ZXIoKGZyYW1lKTogZnJhbWUgaXMgUmVjdCA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIGNvbnN0IGNlbnRlcnNYID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCAvIDIpO1xyXG4gICAgY29uc3QgY2VudGVyc1kgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCAvIDIpO1xyXG4gICAgY29uc3Qgc3ByZWFkWCA9IE1hdGgubWF4KC4uLmNlbnRlcnNYKSAtIE1hdGgubWluKC4uLmNlbnRlcnNYKTtcclxuICAgIGNvbnN0IHNwcmVhZFkgPSBNYXRoLm1heCguLi5jZW50ZXJzWSkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWSk7XHJcbiAgICBpZiAoc3ByZWFkWSA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdIT1JJWk9OVEFMJztcclxuICAgIH1cclxuICAgIGlmIChzcHJlYWRYIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIHJldHVybiAnR1JJRCc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtYWtlU3BlYyhcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwbGFuczogUmVhZG9ubHlNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4sXHJcbiAgICBub2RlQnlJZDogUmVhZG9ubHlNYXA8c3RyaW5nLCBGaWdtYU5vZGU+LFxyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+LFxyXG4gICAgZm9udHM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBpc1Jvb3QgPSBmYWxzZSxcclxuICAgIHBhcmVudFdvcmxkUm90YXRpb24gPSAwLFxyXG4gICAgc3luYz86IHsgZmlsZUtleTogc3RyaW5nIH0sXHJcbik6IFNjZW5lTm9kZVNwZWMgfCBudWxsIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUobm9kZSk7XHJcbiAgICBjb25zdCBwbGFuID0gcGxhbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgY29uc3QgZm9sZCA9IHBsYW4/LmZvbGQ7XHJcbiAgICBjb25zdCBmb2xkU291cmNlID0gZm9sZCA/IG5vZGVCeUlkLmdldChmb2xkLnNvdXJjZU5vZGVJZCkgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCB0ZXh0U291cmNlID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCB2aXN1YWxTb3VyY2UgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCByZXNvbHZlZEtpbmQgPSBkZWNpc2lvbi5raW5kID09PSAnYXV0bycgPyBpbmZlcktpbmQobm9kZSkgOiBkZWNpc2lvbi5raW5kO1xyXG4gICAgY29uc3QgcGxhbm5lZEtpbmQgPSBwbGFuPy5raW5kID8/IHJlc29sdmVkS2luZDtcclxuICAgIGNvbnN0IGJpdG1hcFRlcm1pbmFsID0gZGVjaXNpb24ubmluZVNsaWNlIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcic7XHJcbiAgICBjb25zdCB0ZXJtaW5hbCA9IGJpdG1hcFRlcm1pbmFsIHx8IGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKTtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHBsYW5uZWRLaW5kLCBkZWNpc2lvbi5hY3Rpb24sIGRlY2lzaW9uLm5pbmVTbGljZSk7XHJcbiAgICBjb25zdCBzcHJpdGVTb3VyY2VJZCA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnXHJcbiAgICAgICAgPyBmb2xkLnNvdXJjZU5vZGVJZFxyXG4gICAgICAgIDogbm9kZS5pZDtcclxuICAgIGNvbnN0IHNwcml0ZUFzc2V0ID0gYXNzZXRzLmdldChzcHJpdGVTb3VyY2VJZCk7XHJcbiAgICBjb25zdCBhYnNvcmJlZERpcmVjdElkcyA9IG5ldyBTZXQoZm9sZCA/IFtmb2xkLnNvdXJjZU5vZGVJZF0gOiBbXSk7XHJcbiAgICBjb25zdCBmdWxsRm9sZCA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtaW1hZ2UnIHx8IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCc7XHJcbiAgICBjb25zdCB3b3JsZFJvdGF0aW9uID0gcGFyZW50V29ybGRSb3RhdGlvbiArIG5vZGUucm90YXRpb247XHJcbiAgICAvLyDmipjlj6DliLDmnKzoioLngrnnmoTlrZDlsYIgaWQg5LiOIGFsaWFzRmlnbWFJZHMg5LiA6Ie077yb5qCH6K6w5Y+q6K6w5b2V6IGa5ZCI6Lqr5Lu977yMXHJcbiAgICAvLyDkuI3or5Xlm77kuLrmipjlj6DlrZDlsYLljZXni6zlu7roioLngrnjgIJcclxuICAgIGNvbnN0IHN5bmNNYXJrZXI6IFN5bmNNYXJrZXJTcGVjIHwgdW5kZWZpbmVkID0gc3luY1xyXG4gICAgICAgID8gY3JlYXRlU3luY01hcmtlcih7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IHN5bmMuZmlsZUtleSxcclxuICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgYWxpYXNOb2RlSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMgPz8gW10sXHJcbiAgICAgICAgfSlcclxuICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZmlnbWFJZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBkZWNpc2lvbi5uYW1lID8/IG5vZGUubmFtZSxcclxuICAgICAgICBmaWdtYVR5cGU6IHZpc3VhbFNvdXJjZS50eXBlLFxyXG4gICAgICAgIGFjdGlvbjogZGVjaXNpb24uYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgcGFyZW50RnJhbWUsXHJcbiAgICAgICAgaW50cmluc2ljU2l6ZTogbm9kZS5zaXplLFxyXG4gICAgICAgIGlzUm9vdCxcclxuICAgICAgICByb3RhdGlvbjogbm9kZS5yb3RhdGlvbixcclxuICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgIG9wYWNpdHk6IGZvbGRTb3VyY2UgJiYgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyBub2RlLm9wYWNpdHkgKiBmb2xkU291cmNlLm9wYWNpdHlcclxuICAgICAgICAgICAgOiBub2RlLm9wYWNpdHksXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQsXHJcbiAgICAgICAgY29ybmVyUmFkaWk6IGNvcm5lclJhZGlpKHZpc3VhbFNvdXJjZSksXHJcbiAgICAgICAgZmlsbHM6IHRleHRTb3VyY2UuZmlsbHMsXHJcbiAgICAgICAgc3Ryb2tlczogdGV4dFNvdXJjZS5zdHJva2VzLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogdGV4dFNvdXJjZS5zdHJva2VXZWlnaHQsXHJcbiAgICAgICAgY2hhcmFjdGVyczogdGV4dFNvdXJjZS5jaGFyYWN0ZXJzLFxyXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFNvdXJjZS5zdHlsZSxcclxuICAgICAgICBsYXlvdXQ6IHtcclxuICAgICAgICAgICAgbW9kZTogZWZmZWN0aXZlS2luZCA9PT0gJ2xheW91dCcgfHwgZWZmZWN0aXZlS2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgICAgICA/IGluZmVycmVkTGF5b3V0TW9kZShub2RlKVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIHNvdXJjZU1vZGU6IG5vZGUubGF5b3V0TW9kZSxcclxuICAgICAgICAgICAgd3JhcDogbm9kZS5sYXlvdXRXcmFwLFxyXG4gICAgICAgICAgICBwcmltYXJ5QWxpZ246IG5vZGUucHJpbWFyeUF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBjb3VudGVyQWxpZ246IG5vZGUuY291bnRlckF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBwcmltYXJ5U2l6aW5nOiBub2RlLnByaW1hcnlBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgY291bnRlclNpemluZzogbm9kZS5jb3VudGVyQXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGl0ZW1TcGFjaW5nOiBub2RlLml0ZW1TcGFjaW5nLFxyXG4gICAgICAgICAgICBjb3VudGVyU3BhY2luZzogbm9kZS5jb3VudGVyQXhpc1NwYWNpbmcsXHJcbiAgICAgICAgICAgIHBhZGRpbmdMZWZ0OiBub2RlLnBhZGRpbmdMZWZ0LFxyXG4gICAgICAgICAgICBwYWRkaW5nUmlnaHQ6IG5vZGUucGFkZGluZ1JpZ2h0LFxyXG4gICAgICAgICAgICBwYWRkaW5nVG9wOiBub2RlLnBhZGRpbmdUb3AsXHJcbiAgICAgICAgICAgIHBhZGRpbmdCb3R0b206IG5vZGUucGFkZGluZ0JvdHRvbSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIG92ZXJmbG93RGlyZWN0aW9uOiBub2RlLm92ZXJmbG93RGlyZWN0aW9uLFxyXG4gICAgICAgIGNvbnN0cmFpbnRzOiBub2RlLmNvbnN0cmFpbnRzLFxyXG4gICAgICAgIHJlbGF0aXZlVHJhbnNmb3JtOiBub2RlLnJlbGF0aXZlVHJhbnNmb3JtLFxyXG4gICAgICAgIHNwcml0ZTogc3ByaXRlQXNzZXQsXHJcbiAgICAgICAgZm9udFV1aWQ6IHRleHRTb3VyY2Uuc3R5bGU/LmZvbnRGYW1pbHkgPyBmb250cy5nZXQodGV4dFNvdXJjZS5zdHlsZS5mb250RmFtaWx5KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMsXHJcbiAgICAgICAgZmxhdHRlbkJvdW5kYXJ5OiBiaXRtYXBUZXJtaW5hbCB8fCBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IHRydWVcclxuICAgICAgICAgICAgOiBmb2xkPy5raW5kID09PSAnYmFja2dyb3VuZCdcclxuICAgICAgICAgICAgICAgID8gZmFsc2VcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHBsYW5SZWFzb246IHBsYW4/LnJlYXNvbixcclxuICAgICAgICBzeW5jTWFya2VyLFxyXG4gICAgICAgIGNoaWxkcmVuOiB0ZXJtaW5hbFxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogbm9kZS5jaGlsZHJlblxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+ICFhYnNvcmJlZERpcmVjdElkcy5oYXMoY2hpbGQuaWQpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLFxyXG4gICAgICAgICAgICAgICAgICAgIGZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBzeW5jLFxyXG4gICAgICAgICAgICAgICAgKSlcclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKTogY2hpbGQgaXMgU2NlbmVOb2RlU3BlYyA9PiBjaGlsZCAhPT0gbnVsbCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlTWFwcygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnID8gc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4gOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29jb3NGaWxlSWQoKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGdlbmVyYXRlZCA9IEVkaXRvci5VdGlscz8uVVVJRD8uZ2VuZXJhdGU/Lih0cnVlKTtcclxuICAgIHJldHVybiB0eXBlb2YgZ2VuZXJhdGVkID09PSAnc3RyaW5nJyAmJiBnZW5lcmF0ZWQubGVuZ3RoID4gMFxyXG4gICAgICAgID8gZ2VuZXJhdGVkXHJcbiAgICAgICAgOiByYW5kb21CeXRlcygxNikudG9TdHJpbmcoJ2Jhc2U2NCcpLnJlcGxhY2UoLz0rJC9nLCAnJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5UHJlZmFiQXNzZXQodXJsT3JVdWlkOiBzdHJpbmcpOiBQcm9taXNlPFByZWZhYkFzc2V0SW5mbyB8IG51bGw+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LWluZm8nLFxyXG4gICAgICAgIHVybE9yVXVpZCxcclxuICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0UHJlZmFiQXNzZXQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBleHBlY3RlZDogeyB1dWlkPzogc3RyaW5nOyB1cmw/OiBzdHJpbmcgfSA9IHt9LFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChpbmZvLmludmFsaWQgfHwgaW5mby5pbXBvcnRlZCAhPT0gdHJ1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWwmuacquWujOaIkOWvvOWFpe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5pbXBvcnRlciAhPT0gJ3ByZWZhYicgfHwgaW5mby50eXBlICE9PSAnY2MuUHJlZmFiJyB8fCBpbmZvLmlzRGlyZWN0b3J5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfotYTmupDkuI3mmK/lj6/nvJbovpHnmoQgQ29jb3MgUHJlZmFi77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLnJlYWRvbmx5IHx8IGluZm8ucmVkaXJlY3QpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg5Li65Y+q6K+75oiW6YeN5a6a5ZCR6LWE5rqQ77yM5LiN6IO95a6J5YWo5pu05paw77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChleHBlY3RlZC51dWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWQudXVpZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5qCh6aqM5aSx6LSl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChleHBlY3RlZC51cmwgJiYgaW5mby51cmwgIT09IGV4cGVjdGVkLnVybCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOi3r+W+hOagoemqjOWksei0pe+8muacn+acmyAke2V4cGVjdGVkLnVybH3vvIzlrp7pmYUgJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclByZWZhYkFzc2V0KHVybDogc3RyaW5nLCBleHBlY3RlZFV1aWQ/OiBzdHJpbmcpOiBQcm9taXNlPFByZWZhYkFzc2V0SW5mbz4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcclxuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xyXG4gICAgICAgIGlmIChpbmZvPy5pbnZhbGlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29jb3MgUHJlZmFiIOi1hOa6kOWvvOWFpeWksei0pe+8miR7dXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaW5mbz8uaW1wb3J0ZWQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgaWYgKGV4cGVjdGVkVXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkVXVpZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDlnKjlr7zlhaXmnJ/pl7Tlj5HnlJ/lj5jljJbvvJoke3VybH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhc3NlcnRQcmVmYWJBc3NldChpbmZvLCB7IHV1aWQ6IGV4cGVjdGVkVXVpZCwgdXJsIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gaW5mbztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOetieW+hSBDb2NvcyBQcmVmYWIg6LWE5rqQ5bCx57uq6LaF5pe277yaJHt1cmx9YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5UHJlZmFiTWV0YSh1dWlkOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XHJcbiAgICBjb25zdCBtZXRhID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1tZXRhJyxcclxuICAgICAgICB1dWlkLFxyXG4gICAgKTtcclxuICAgIGlmICghbWV0YSB8fCB0eXBlb2YgbWV0YSAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleivu+WPliBQcmVmYWIgTWV0Ye+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbHVlID0gbWV0YSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgaWYgKHZhbHVlLnV1aWQgIT09IHV1aWQgfHwgdmFsdWUuaW1wb3J0ZXIgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgTWV0YSDkuI7nm67moIfotYTmupDkuI3ljLnphY3vvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkRpc2tQYXRoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vJykpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVUkwg5peg5pWI77yaJHt1cmx9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCB1cmwuc2xpY2UoJ2RiOi8vJy5sZW5ndGgpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclN5bmNNYXJrZXJTY3JpcHQodXJsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMTVfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3F1ZXJ5LWFzc2V0LWluZm8nLCB1cmwpIGFzIHtcclxuICAgICAgICAgICAgdXVpZD86IHN0cmluZztcclxuICAgICAgICB9IHwgbnVsbDtcclxuICAgICAgICBpZiAodHlwZW9mIGluZm8/LnV1aWQgPT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEwMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3Mg5a+85YWl57uE5Lu25ZCM5q2l5qCH6K6w6ISa5pys6LaF5pe277yaJHt1cmx9YCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiDnu4Tku7blkIzmraXpnIDopoHlnKjpobnnm67ph4zmnInkuIDkuKrmnoHlsI/nmoTmoIforrDnu4Tku7bohJrmnKzjgILpppbmrKHlr7zlhaXml7bnlJ/miJDvvIxcclxuICog5LmL5ZCO5q+P5qyh5a+85YWl5qCh6aqM77yb6KKr5YW25LuW6ISa5pys5Y2g55So5pe2IGZhaWwtY2xvc2Vk77yM6KKr5oiq5pat5oiW5pS55pen5pe26YeN5bu644CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVTeW5jTWFya2VyU2NyaXB0KCk6IFByb21pc2U8eyBhY3Rpb246IHN0cmluZzsgcmVhc29uPzogc3RyaW5nIH0+IHtcclxuICAgIGNvbnN0IHVybCA9IFNZTkNfTUFSS0VSX1NDUklQVF9VUkw7XHJcbiAgICBsZXQgZXhpc3Rpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBleGlzdGluZyA9IGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKHVybCksICd1dGY4Jyk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICBleGlzdGluZyA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwbGFuID0gcGxhblN5bmNNYXJrZXJTY3JpcHQoZXhpc3RpbmcpO1xyXG4gICAgaWYgKHBsYW4uYWN0aW9uID09PSAncmVqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihwbGFuLnJlYXNvbik7XHJcbiAgICB9XHJcbiAgICBpZiAocGxhbi5hY3Rpb24gPT09ICdrZWVwJykge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JTeW5jTWFya2VyU2NyaXB0KHVybCk7XHJcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiAna2VlcCcgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdxdWVyeS1hc3NldC1pbmZvJywgdXJsKSBhcyB7XHJcbiAgICAgICAgdXVpZD86IHN0cmluZztcclxuICAgIH0gfCBudWxsO1xyXG4gICAgaWYgKCFpbmZvKSB7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ2NyZWF0ZS1hc3NldCcsIHVybCwgcGxhbi5jb250ZW50LCB7XHJcbiAgICAgICAgICAgIG92ZXJ3cml0ZTogZmFsc2UsXHJcbiAgICAgICAgICAgIHJlbmFtZTogZmFsc2UsXHJcbiAgICAgICAgfSkgYXMgeyB1dWlkPzogc3RyaW5nIH0gfCBudWxsO1xyXG4gICAgICAgIGlmICghY3JlYXRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWIm+W7uue7hOS7tuWQjOatpeagh+iusOiEmuacrO+8miR7dXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnc2F2ZS1hc3NldCcsIHVybCwgcGxhbi5jb250ZW50KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHdhaXRGb3JTeW5jTWFya2VyU2NyaXB0KHVybCk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogcGxhbi5hY3Rpb24sXHJcbiAgICAgICAgcmVhc29uOiBwbGFuLmFjdGlvbiA9PT0gJ3Jld3JpdGUnID8gcGxhbi5yZWFzb24gOiB1bmRlZmluZWQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2xsZWN0U3luY01hcmtlclNwZWNzKHNwZWNzOiByZWFkb25seSBTY2VuZU5vZGVTcGVjW10pOiBTeW5jTWFya2VyU3BlY1tdIHtcclxuICAgIGNvbnN0IG1hcmtlcnM6IFN5bmNNYXJrZXJTcGVjW10gPSBbXTtcclxuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGVzOiByZWFkb25seSBTY2VuZU5vZGVTcGVjW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgaWYgKG5vZGUuc3luY01hcmtlcikge1xyXG4gICAgICAgICAgICAgICAgbWFya2Vycy5wdXNoKG5vZGUuc3luY01hcmtlcik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdmlzaXQobm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIHZpc2l0KHNwZWNzKTtcclxuICAgIHJldHVybiBtYXJrZXJzO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICApO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmcsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgY3VycmVudERpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgaWYgKGN1cnJlbnREaXJ0eSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcclxuICAgIH1cclxuICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnb3Blbi1hc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgICAgICAgICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gc3RhdGUucmVhc29uID8/IGxhc3RSZWFzb247XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOaJk+W8gOebruaghyBQcmVmYWIg6LaF5pe277yaJHtsYXN0UmVhc29ufWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRPcGVuZWRQcmVmYWIocHJlZmFiVXVpZDogc3RyaW5nLCByb290RmlsZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTY2VuZVNhdmVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBkaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoIWRpcnR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCfnrYnlvoUgUHJlZmFiIOS/neWtmOWujOaIkOi2heaXtuOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQcmVmYWJCaW5kaW5ncygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCBwcmVmYWJVdWlkXSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHByZWZhYlV1aWQgIT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8ICFwcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcsIHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgaWYgKCFiaW5kaW5nc1tzb3VyY2VIYXNoXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywge1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8ICFyYXdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIChyYXcgYXMgeyBwcmVmYWJVdWlkPzogdW5rbm93biB9KS5wcmVmYWJVdWlkICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoe1xyXG4gICAgICAgICAgICB1c2VyRGF0YToge1xyXG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leadpea6kOS4jeS4gOiHtO+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IChyYXcgYXMgeyBwcmVmYWJVdWlkOiBzdHJpbmcgfSkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQZW5kaW5nUHJlZmFiU3luYyhcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHZhbHVlOiB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0gfCBudWxsLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcclxuICAgIGlmICh2YWx1ZSkge1xyXG4gICAgICAgIHBlbmRpbmdbc291cmNlSGFzaF0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbc291cmNlSGFzaF07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgIHBlbmRpbmcsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gdmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbik6IFByb21pc2U8eyBtZXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+IHtcclxuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICBsZXQgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICBpZiAoIXJlY29yZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYFByZWZhYiDnvLrlsJEgRmlnbWEg5p2l5rqQ6K6w5b2V77yM5peg5rOV56Gu6K6k5piv5ZCm5Y+v5a6J5YWo6KaG55uW77yaJHtpbmZvLnVybH3jgILor7flhYjnp7vliqjmiJbph43lkb3lkI3or6XotYTmupDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDmnaXoh6rlj6bkuIDkuKogRmlnbWEgRnJhbWXvvIzlt7Lmi5Lnu53opobnm5bvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBpZiAocGVuZGluZykge1xyXG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5qOA5rWL5Yiw5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7TnmoTlvoXmgaLlpI3lkIzmraXorrDlvZXvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcGVuZGluZy5yZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3ZlcmVkIHx8IEpTT04uc3RyaW5naWZ5KHJlY292ZXJlZCkgIT09IEpTT04uc3RyaW5naWZ5KHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVjb3JkID0gcmVjb3ZlcmVkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bkuI7lvZPliY3lj4rlvoXmgaLlpI3nmoTlkIzmraXorrDlvZXpg73kuI3kuIDoh7TvvIzlt7LlgZzmraLoh6rliqjmgaLlpI3jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBtZXRhLCByZWNvcmQgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBsZXQgbGFzdEVycm9yOiB1bmtub3duO1xyXG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0ICs9IDEpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflhpnlhaXliY0gUHJlZmFiIOadpea6kOiusOW9leS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWQjuagoemqjOS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcclxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTUwKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGxhc3RFcnJvciA6IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWksei0peOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZyxcclxuICAgIHJvb3RGcmFtZTogUmVjdCxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHNvdXJjZVJvb3RJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHtcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgY29uc3QgYm91bmRVdWlkID0gYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xyXG4gICAgICAgID8gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwZW5kaW5nLnByZWZhYlV1aWQpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgICAgICBwZW5kaW5nPy5wcmVmYWJVdWlkLFxyXG4gICAgICAgIGJvdW5kVXVpZCxcclxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcclxuICAgICk7XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhclBlbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyQmluZGluZykge1xyXG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gdGFyZ2V0UGxhbi50YXJnZXRVdWlkO1xyXG4gICAgaWYgKHRhcmdldFV1aWQpIHtcclxuICAgICAgICBsZXQgdGFyZ2V0SW5mbyA9IHBlbmRpbmdJbmZvPy51dWlkID09PSB0YXJnZXRVdWlkXHJcbiAgICAgICAgICAgID8gcGVuZGluZ0luZm9cclxuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xyXG4gICAgICAgICAgICBpZiAoYmluZGluZ3Nbc291cmNlSGFzaF0gPT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgaWYgKHBlbmRpbmc/LnByZWZhYlV1aWQgPT09IHRhcmdldFV1aWQgJiYgYm91bmRVdWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSByZWNvdmVyeSBpZGVudGl0eSBiZWZvcmUgdmVyaWZpZWRQcmVmYWJSZWNvcmQgbWF5XHJcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcclxuICAgICAgICAgICAgICAgIC8vIGFibGUgdG8gbG9jYXRlIHRoZSBleGFjdCBQcmVmYWIgYnkgVVVJRCBvbiB0aGUgbmV4dCBhdHRlbXB0LlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKHRhcmdldEluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0SW5mby51cmwgIT09IHByZWZhYlVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoY29uZmxpY3QgJiYgY29uZmxpY3QudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3ZlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mby51cmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW92ZWQgfHwgbW92ZWQudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGluZm86IHRhcmdldEluZm8sXHJcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCByb290RmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCByb290VHJhbnNmb3JtRmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXHJcbiAgICAgICAgICAgIHByZWZhYk5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnY3JlYXRlLWFzc2V0JyxcclxuICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICBzZWVkLFxyXG4gICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu6IFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgY3JlYXRlZC51dWlkKTtcclxuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcclxuICAgICAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICAgICAgc291cmNlUm9vdElkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShuZXh0TWV0YSwgbnVsbCwgMiksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgaW5mbyxcclxuICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaW5mbyxcclxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKGFyZ3M6IHtcclxuICAgIHJldmlld0lkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZztcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHNvdXJjZU5vZGVJZDogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbiAgICAvKiog5pyq5Yu+6YCJ55qE6IqC54K577ya5L+d55WZ5a6D5Lus5ZyoIFByZWZhYiDph4znmoTnjrDmnInoioLngrnvvIzkuI3lj4LkuI7mnKzmrKHmuIXnkIbjgIIgKi9cclxuICAgIHNraXBTeW5jTm9kZUlkcz86IFJlYWRvbmx5U2V0PHN0cmluZz47XHJcbn0pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBzb3VyY2VIYXNoID0gZmlnbWFGcmFtZVNvdXJjZUhhc2goYXJncy5maWxlS2V5LCBhcmdzLnNvdXJjZU5vZGVJZCk7XHJcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgICAgICBhcmdzLnByZWZhYlVybCxcclxuICAgICAgICBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICB4OiBhcmdzLnJvb3RGcmFtZS54ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgeTogYXJncy5yb290RnJhbWUueSAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHdpZHRoOiBhcmdzLnJvb3RGcmFtZS53aWR0aCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIGhlaWdodDogYXJncy5yb290RnJhbWUuaGVpZ2h0ICogYXJncy5zY2FsZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgYXJncy5yb290c1swXS5maWdtYUlkLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGV4aXN0aW5nTm9kZUZpbGVJZHMgPSByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyhcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQsXHJcbiAgICAgICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKGFyZ3Mucm9vdHMpLFxyXG4gICAgKTtcclxuICAgIC8vIOacquWLvumAieeahOiKgueCueWcqOacrOasoeiuoeWIkumHjOS4jeWtmOWcqO+8jOS9huWug+S7rOS7jeWxnuS6juWPl+euoeiKgueCue+8muaKiuW3suefpSBmaWxlSWQg5Lyg57uZXHJcbiAgICAvLyBTY2VuZSDkvZzkuLrkv53nlZnpm4blkIjvvIzpgb/lhY1cIuWIoOmZpFwi5YiG5pSv5oqK5a6D5Lus5riF5o6J44CCXHJcbiAgICBjb25zdCByZXRhaW5Ob2RlRmlsZUlkcyA9IGFyZ3Muc2tpcFN5bmNOb2RlSWRzPy5zaXplXHJcbiAgICAgICAgPyBPYmplY3QudmFsdWVzKHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKHByZXBhcmVkLnJlY29yZCwgYXJncy5za2lwU3luY05vZGVJZHMpKVxyXG4gICAgICAgIDogW107XHJcbiAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgcmV2aWV3SWQ6IGFyZ3MucmV2aWV3SWQsXHJcbiAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgZmlsZUtleTogYXJncy5maWxlS2V5LFxyXG4gICAgICAgIHJvb3ROYW1lOiBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAgcm9vdEZyYW1lOiBhcmdzLnJvb3RGcmFtZSxcclxuICAgICAgICBzY2FsZTogYXJncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICBleGlzdGluZ01hcDoge30sXHJcbiAgICAgICAgcHJlZmFiVXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICByZXRhaW5Ob2RlRmlsZUlkcyxcclxuICAgICAgICByb290czogYXJncy5yb290cyxcclxuICAgICAgICBwcmVmYWJDb250ZXh0OiB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZDogcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkSGVscGVyRmlsZUlkcyxcclxuICAgICAgICB9LFxyXG4gICAgfTtcclxuICAgIGxldCBzbmFwc2hvdFN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIGxldCBzYXZlQXR0ZW1wdGVkID0gZmFsc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5QmVmb3JlSW1wb3J0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmIChkaXJ0eUJlZm9yZUltcG9ydCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ebruaghyBQcmVmYWIg5pyJ5pyq5L+d5a2Y55qE5omL5bel5L+u5pS577yM6K+35YWI5L+d5a2Y5ZCO5YaN5omn6KGMIEZpZ21hIOWinumHj+WvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIHNuYXBzaG90U3RhcnRlZCA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGlmICghcmVzdWx0LnByZWZhYlN5bmMpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5pyq6L+U5ZueIGZpbGVJZCDorrDlvZXvvIzlt7LlgZzmraLkv53lrZjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmV4dFJlY29yZCA9IHJlY29yZFByZWZhYlN5bmNDYXB0dXJlKHByZXBhcmVkLnJlY29yZCwgcmVzdWx0LnByZWZhYlN5bmMpO1xyXG4gICAgICAgIC8vIOacquWLvumAieeahOiKgueCueS4jeWcqOacrOasoemHjeW7uue7k+aenOmHjO+8jOS/neeVmeWug+S7rOWOn+acieeahCBmaWxlSWQg5pig5bCE44CCXHJcbiAgICAgICAgY29uc3QgcmV0YWluZWRSZWNvcmQgPSBhcmdzLnNraXBTeW5jTm9kZUlkcz8uc2l6ZVxyXG4gICAgICAgICAgICA/IHJldGFpblByZWZhYlN5bmNFbnRyaWVzKHByZXBhcmVkLnJlY29yZCwgbmV4dFJlY29yZCwgYXJncy5za2lwU3luY05vZGVJZHMpXHJcbiAgICAgICAgICAgIDogbmV4dFJlY29yZDtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkOiByZXRhaW5lZFJlY29yZCxcclxuICAgICAgICB9KTtcclxuICAgICAgICBhd2FpdCBhc3NlcnRPcGVuZWRQcmVmYWIocHJlcGFyZWQuaW5mby51dWlkLCBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgLy8gT25jZSB0aGUgc2F2ZSByZXF1ZXN0IGlzIHNlbnQgaXRzIHJlc3VsdCBpcyBhbWJpZ3VvdXMgdW50aWwgdGhlXHJcbiAgICAgICAgLy8gcGVyc2lzdGVkIFByZWZhYiBpcyB2ZXJpZmllZC4gRG8gbm90IHJvbGwgdGhlIGluLW1lbW9yeSBQcmVmYWIgYmFja1xyXG4gICAgICAgIC8vIG9uIGFuIElQQyB0aW1lb3V0OiB0aGUgZGlzayB3cml0ZSBtYXkgYWxyZWFkeSBoYXZlIGNvbXBsZXRlZC5cclxuICAgICAgICBzYXZlQXR0ZW1wdGVkID0gdHJ1ZTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclNjZW5lU2F2ZWQoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCwgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoY3VycmVudEluZm8sIHJldGFpbmVkUmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bmnKrljIXlkKvmnKzmrKHlkIzmraXnlJ/miJDnmoTlhajpg6ggZmlsZUlk77yM5bey5YGc5q2i5pu05pawIE1ldGHjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8g5pyq5Yu+6YCJ6IqC54K555qE57uE5Lu277yIVUlUcmFuc2Zvcm3jgIHmoIforrDnrYnvvInku43lsZ7mj5Lku7bmiYDmnInvvJrku47kv53lrZjlkI7nmoRcclxuICAgICAgICAvLyBQcmVmYWIg6YeM6K+75Zue5a6D5Lus55qEIGZpbGVJZCDlubblkIjlubbov5vorrDlvZXvvIzlkKbliJnkuIvmrKHph43mlrDli77pgInkvJrooqvlvZLlsZ7moKHpqozmi6bkuIvjgIJcclxuICAgICAgICBsZXQgZmluYWxSZWNvcmQgPSByZXRhaW5lZFJlY29yZDtcclxuICAgICAgICBpZiAoYXJncy5za2lwU3luY05vZGVJZHM/LnNpemUpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2tpcHBlZEZpbGVJZHMgPSBPYmplY3QudmFsdWVzKFxyXG4gICAgICAgICAgICAgICAgcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMocHJlcGFyZWQucmVjb3JkLCBhcmdzLnNraXBTeW5jTm9kZUlkcyksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChza2lwcGVkRmlsZUlkcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4dHJhcyA9IGNvbGxlY3RQcmVmYWJDb21wb25lbnRGaWxlSWRzKFxyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGN1cnJlbnRJbmZvLnVybCkpLFxyXG4gICAgICAgICAgICAgICAgICAgIHNraXBwZWRGaWxlSWRzLFxyXG4gICAgICAgICAgICAgICAgKS5maWx0ZXIoKGZpbGVJZCkgPT4gIXJldGFpbmVkUmVjb3JkLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzLmluY2x1ZGVzKGZpbGVJZCkpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGV4dHJhcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBmaW5hbFJlY29yZCA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgLi4ucmV0YWluZWRSZWNvcmQsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5yZXRhaW5lZFJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLmV4dHJhcyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgXS5zb3J0KCksXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXJyZW50TWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShjdXJyZW50SW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50UmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoY3VycmVudE1ldGEpO1xyXG4gICAgICAgIGlmICghY3VycmVudFJlY29yZCB8fCBjdXJyZW50UmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5Zyo5L+d5a2Y5pyf6Ze05Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5o+Q5Lqk44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIHsgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLCByZWNvcmQ6IGZpbmFsUmVjb3JkIH0pO1xyXG4gICAgICAgIGF3YWl0IHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoY3VycmVudEluZm8sIHNvdXJjZUhhc2gsIGZpbmFsUmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwpO1xyXG4gICAgICAgIGlmICghdmVyaWZpZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI4gUHJlZmFiIFVVSUQg5qCh6aqM5aSx6LSl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFzc2VydFByZWZhYkFzc2V0KHZlcmlmaWVkLCB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgdXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXN1bHQucHJlZmFiVXJsID0gcHJlcGFyZWQuaW5mby51cmw7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHNuYXBzaG90U3RhcnRlZCAmJiAhc2F2ZUF0dGVtcHRlZCkge1xyXG4gICAgICAgICAgICB0cnkgeyBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdC1hYm9ydCcpOyB9XHJcbiAgICAgICAgICAgIGNhdGNoIHtcclxuICAgICAgICAgICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSAoZXJyb3IgYXMgRXJyb3IgJiB7IHJlcXVpcmVzQXR0ZW50aW9uPzogYm9vbGVhbiB9KS5yZXF1aXJlc0F0dGVudGlvbiA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNhdmVBdHRlbXB0ZWQgJiYgZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgKGVycm9yIGFzIEVycm9yICYgeyByZXF1aXJlc0F0dGVudGlvbj86IGJvb2xlYW4gfSkucmVxdWlyZXNBdHRlbnRpb24gPSB0cnVlO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICog57uE5Lu25ZCM5q2l6aKE5qOA77ya5Y+q6K+755uu5qCHIFByZWZhYiDkuI7lvZPliY0gRmlnbWEg6K6h5YiS44CCXHJcbiAqIOS4jeS4i+i9veWbvueJh+OAgeS4jeaJk+W8gCBQcmVmYWLjgIHkuI3lhpnlhaXku7vkvZXmlofku7bvvIzlj6/lnKjnlKjmiLfngrnlh7vlr7zlhaXliY3lj43lpI3osIPnlKjjgIJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXZpZXdDb21wb25lbnRTeW5jKCk6IFByb21pc2U8U3luY1ByZXZpZXdSZXN1bHQ+IHtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBpZiAoIWRvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoIWRvY3VtZW50LnNvdXJjZU5vZGVJZCB8fCBkb2N1bWVudC5yb290cy5sZW5ndGggIT09IDEpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WPquacieWNleS4quiKgueCuemTvuaOpeaJjeiDvemihOiniOe7hOS7tuWQjOatpeOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgaWYgKHJvb3QudHlwZSAhPT0gJ0NPTVBPTkVOVCcgJiYgcm9vdC50eXBlICE9PSAnSU5TVEFOQ0UnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDlvZPliY3moLnoioLngrnmmK8gJHtyb290LnR5cGV977yM5Y+q5pyJ57uE5Lu277yIQ09NUE9ORU5UL0lOU1RBTkNF77yJ6ZO+5o6l5pSv5oyB57uE5Lu25ZCM5q2l44CCYCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAvLyBBc3NldFdyaXRlciDmnoTpgKDlh73mlbDlj6rop4TojIPljJbnm67lvZXvvIzkuI3kvJrliJvlu7rmlofku7blpLnjgIJcclxuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBBc3NldFdyaXRlcihzZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7d3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShyb290Lm5hbWUpfS5wcmVmYWJgO1xyXG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIHJldHVybiB7IHRhcmdldFVybDogcHJlZmFiVXJsLCBleGlzdHM6IGZhbHNlLCAuLi5lbXB0eVN5bmNQcmV2aWV3U3VtbWFyeSgpIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmV2aW91cyA9IHJlYWRQcmVmYWJTeW5jTWFya2Vycyhhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aChwcmVmYWJVcmwpKSk7XHJcbiAgICBjb25zdCBvdmVycmlkZXMgPSBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpO1xyXG4gICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAob3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcclxuICAgIC8vIOS4juecn+WunuWvvOWFpeS/neaMgeS4gOiHtOeahOesrOS4gOatpe+8muacrOWcsOWQjOWQjee0oOadkOWRveS4reaXtuaKiueItuWuueWZqOaVtOS9k+aPkOWNh+S4uuaVtOWxguOAglxyXG4gICAgY29uc3QgbG9jYWxMaWJyYXJpZXMgPSBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4ge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShmb2xkZXIpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSlcclxuICAgICAgICAuZmlsdGVyKChsaWJyYXJ5KTogbGlicmFyeSBpcyBMb2NhbFJlc291cmNlTGlicmFyeSA9PiBsaWJyYXJ5ICE9PSBudWxsKTtcclxuICAgIGlmIChsb2NhbExpYnJhcmllcy5sZW5ndGgpIHtcclxuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbExpYnJhcmllcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICAgICAgY29uc3QgcHJvdGVjdGVkUHJldmlldyA9IChub2RlOiBGaWdtYU5vZGUpOiBib29sZWFuID0+IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgY2hpbGREZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShjaGlsZCwgZGVjaXNpb25zKTtcclxuICAgICAgICAgICAgaWYgKGNoaWxkRGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICByZXR1cm4gQm9vbGVhbihjaGlsZC5pc01hc2sgfHwgY2hpbGQuY2hpbGRyZW4uc29tZSgocGFydCkgPT4gcGFydC5pc01hc2spXHJcbiAgICAgICAgICAgICAgICB8fCBjaGlsZERlY2lzaW9uLm5pbmVTbGljZSB8fCBpc05hbWVkU2xpY2VHcm91cChjaGlsZCkgfHwgaXNQYXRjaENhbmRpZGF0ZShjaGlsZCkpXHJcbiAgICAgICAgICAgICAgICB8fCAoY2hpbGREZWNpc2lvbi5hY3Rpb24gIT09ICdyZW5kZXInICYmIHByb3RlY3RlZFByZXZpZXcoY2hpbGQpKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBhd2FpdCBhcHBseUxvY2FsUGFyZW50UHJvbW90aW9uKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5yb290cyxcclxuICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICBhc3luYyAobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsTGlicmFyaWVzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGF3YWl0IGxpYnJhcnkuZmluZChub2RlLm5hbWUsICdwbmcnKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIHByb3RlY3RlZFByZXZpZXcsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxuICAgIC8vIOS4juecn+WunuWvvOWFpeS/neaMgeS4gOiHtOeahOesrOS6jOatpe+8muiHquWKqOaKmOWPoC/mlLblj6PlhrPlrprnlJ/mlYjlkI7lho3nvJbor5HorqHliJLjgIJcclxuICAgIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zKGRvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgZGVjaXNpb25zLmNsZWFyKCk7XHJcbiAgICByZXNvbHZlZC5mb3JFYWNoKCh2YWx1ZSwga2V5KSA9PiBkZWNpc2lvbnMuc2V0KGtleSwgdmFsdWUpKTtcclxuICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCByb290RnJhbWUgPSBub2RlRnJhbWUocm9vdCk7XHJcbiAgICBjb25zdCBzcGVjcyA9IGRvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgLm1hcCgobm9kZSkgPT4gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgZG9jdW1lbnQubm9kZUJ5SWQsXHJcbiAgICAgICAgICAgIG5ldyBNYXAoKSxcclxuICAgICAgICAgICAgbmV3IE1hcCgpLFxyXG4gICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAwLFxyXG4gICAgICAgICAgICB7IGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXkgfSxcclxuICAgICAgICApKVxyXG4gICAgICAgIC5maWx0ZXIoKHNwZWMpOiBzcGVjIGlzIFNjZW5lTm9kZVNwZWMgPT4gc3BlYyAhPT0gbnVsbCk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHRhcmdldFVybDogcHJlZmFiVXJsLFxyXG4gICAgICAgIGV4aXN0czogdHJ1ZSxcclxuICAgICAgICBwcmVmYWJVdWlkOiBpbmZvLnV1aWQsXHJcbiAgICAgICAgLi4ucGxhblN5bmNQcmV2aWV3KHByZXZpb3VzLCBzcGVjcywgeyBzY2FsZTogc2V0dGluZ3Muc2NhbGUgfSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtSW1wb3J0KHJlcXVlc3Q6IEltcG9ydFJlcXVlc3QsIG9wZXJhdGlvbk93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCwgb3B0aW9uczoge1xyXG4gICAgZG9jdW1lbnQ/OiBEb2N1bWVudFNlc3Npb247IHByZXNlcnZlUmV2aWV3cz86IGJvb2xlYW47IHNpbGVudFJldmlldz86IGJvb2xlYW47XHJcbn0gPSB7fSk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gb3B0aW9ucy5kb2N1bWVudCA/PyBhY3RpdmVEb2N1bWVudDtcclxuICAgIGlmICghZG9jdW1lbnQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+WFiOivu+WPliBGaWdtYSDmlofku7bjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGltcG9ydFNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKG9wZXJhdGlvbk93bmVyKTtcclxuICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCflr7zlhaXku7vliqEnLCB7IHJvb3RzOiBkb2N1bWVudC5yb290cy5tYXAoKG5vZGUpID0+ICh7IGlkOiBub2RlLmlkLCBuYW1lOiBub2RlLm5hbWUgfSkpIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfliIbmnpDlubblh4blpIfotYTmupDigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKHJlcXVlc3Qub3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICAvLyDmlLnliqjmuIXljZXph4zmnKrli77pgInnmoToioLngrnvvJrmnKzmrKHmjIlcIuW/veeVpVwi5aSE55CG77yM5pei5LiN5pu05paw5Lmf5LiN5Yib5bu677yb5a6D5Lus55qE5pen5qCH6K6wXHJcbiAgICAgICAgLy8g5LiN5Lya6KKr6YeN5YaZ77yM5Zug5q2k5LiL5qyh5a+85YWl5LuN5Lya5L2c5Li65b6F5pu05paw6aG55Ye6546w44CCXHJcbiAgICAgICAgY29uc3Qgc2tpcFN5bmNOb2RlSWRzID0gbmV3IFNldCgocmVxdWVzdC5za2lwU3luY05vZGVJZHMgPz8gW10pXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZC50cmltKCkpKVxyXG4gICAgICAgICAgICAubWFwKChpZCkgPT4gaWQudHJpbSgpLnJlcGxhY2UoLy0vZywgJzonKSkpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZUlkIG9mIHNraXBTeW5jTm9kZUlkcykge1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGVJZCwge1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiAnaWdub3JlJyxcclxuICAgICAgICAgICAgICAgIGtpbmQ6ICdhdXRvJyxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogdHJ1ZSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJldmlld0RvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKG9wdGlvbnMucHJlc2VydmVSZXZpZXdzID8geyBwcmVzZXJ2ZUhpc3Rvcnk6IHRydWUgfSA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3UmVjb3JkZXIgPSBuZXcgSW1wb3J0UmV2aWV3UmVjb3JkZXIoKTtcclxuICAgICAgICAvLyDnu4Tku7blkIzmraXvvIjljZXoioLngrkgQ09NUE9ORU5UL0lOU1RBTkNFIOmTvuaOpe+8ie+8muWFiOeUqOWDj+e0oOaMh+e6ueeul+WHuuWTquS6m+iKgueCueeahFxyXG4gICAgICAgIC8vIOWbvueJh+WGheWuueehruWunuWPmOS6hu+8jOWPquaciei/meS6m+iKgueCueWcqOi1hOa6kOWHhuWkh+mYtuautei3s+i/h+acrOWcsOWQjOWQjee0oOadkOWkjeeUqOOAglxyXG4gICAgICAgIGNvbnN0IHN5bmNSb290Q2FuZGlkYXRlID0gZG9jdW1lbnQuc291cmNlTm9kZUlkICYmIGRvY3VtZW50LnJvb3RzLmxlbmd0aCA9PT0gMVxyXG4gICAgICAgICAgICA/IGRvY3VtZW50LnJvb3RzWzBdXHJcbiAgICAgICAgICAgIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IHN5bmNNb2RlID0gQm9vbGVhbihzeW5jUm9vdENhbmRpZGF0ZVxyXG4gICAgICAgICAgICAmJiAoc3luY1Jvb3RDYW5kaWRhdGUudHlwZSA9PT0gJ0NPTVBPTkVOVCcgfHwgc3luY1Jvb3RDYW5kaWRhdGUudHlwZSA9PT0gJ0lOU1RBTkNFJykpO1xyXG4gICAgICAgIGxldCByZWdlbmVyYXRlTm9kZUlkczogUmVhZG9ubHlTZXQ8c3RyaW5nPiB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAoc3luY01vZGUgJiYgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcHJlZmFiV3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLnByZWZhYkZvbGRlcik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBwcmVmYWJVcmwgPSBgZGI6Ly9hc3NldHMvJHtwcmVmYWJXcml0ZXIuZm9sZGVyfS9gXHJcbiAgICAgICAgICAgICAgICAgICAgKyBgJHtzYW5pdGl6ZUFzc2V0TmFtZShkb2N1bWVudC5yb290c1swXS5uYW1lKX0ucHJlZmFiYDtcclxuICAgICAgICAgICAgICAgIGlmIChhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCkpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IHJlYWRQcmVmYWJTeW5jTWFya2Vycyhhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aChwcmVmYWJVcmwpKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByZXZpb3VzLnNpemUpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgc3RhbGUgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBiZWZvcmUgPSBwcmV2aW91cy5nZXQobm9kZS5pZC5yZXBsYWNlKC8tL2csICc6JykpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZnJlc2ggPSBjcmVhdGVTeW5jTWFya2VyKHsgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgbm9kZSB9KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHBpeGVsQ29tcGFyYWJsZSA9IHR5cGVvZiBiZWZvcmU/LnBpeGVsSGFzaCA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAmJiB0eXBlb2YgZnJlc2gucGl4ZWxIYXNoID09PSAnc3RyaW5nJztcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNoYW5nZWQgPSBiZWZvcmVcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IHBpeGVsQ29tcGFyYWJsZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGJlZm9yZS5waXhlbEhhc2ggIT09IGZyZXNoLnBpeGVsSGFzaFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IGJlZm9yZS5zdWJ0cmVlSGFzaCAhPT0gZnJlc2guc3VidHJlZUhhc2hcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoY2hhbmdlZCkgc3RhbGUuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQucm9vdHMuZm9yRWFjaCh2aXNpdCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2VuZXJhdGVOb2RlSWRzID0gc3RhbGU7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgICAgIC8vIOmihOajgOWksei0peS4jemYu+aWreWvvOWFpe+8mumAgOWbnlwi5omA5pyJ6IqC54K56YO95oyJ546w5pyJ6KeE5YiZ5aSE55CGXCLjgIJcclxuICAgICAgICAgICAgICAgIHJlZ2VuZXJhdGVOb2RlSWRzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGJ1aWx0QXNzZXRzID0gYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WFqOmDqOi1hOa6kCcsIHVuZGVmaW5lZCwgKCkgPT4gYnVpbGRBc3NldHMoXHJcbiAgICAgICAgICAgIGRvY3VtZW50LFxyXG4gICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLFxyXG4gICAgICAgICAgICByZXZpZXdSZWNvcmRlcixcclxuICAgICAgICAgICAgeyByZWdlbmVyYXRlTm9kZUlkcyB9LFxyXG4gICAgICAgICkpO1xyXG4gICAgICAgIGNvbnN0IHsgYXNzZXRzLCB3YXJuaW5ncyB9ID0gYnVpbHRBc3NldHM7XHJcbiAgICAgICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIGNvbnN0IGF0dGFjaFJldmlldyA9IGFzeW5jIChyZXN1bHQ6IFNjZW5lSW1wb3J0UmVzdWx0KSA9PiB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5yZXZpZXcgPSBhd2FpdCBmaW5hbGl6ZUltcG9ydFJldmlldyhpbXBvcnRSZXZpZXdzLCByZXZpZXdSZWNvcmRlciwgcmV2aWV3RG9jdW1lbnQsXHJcbiAgICAgICAgICAgICAgICByZXN1bHQucmV2aWV3QmVmb3JlLCByZXN1bHQucmV2aWV3QWZ0ZXIsIHJlc3VsdC5wcmVmYWJVcmwsIHdhcm5pbmdzLFxyXG4gICAgICAgICAgICAgICAgYXN5bmMgKCkgPT4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSwgbWV0aG9kOiAncmVmcmVzaFJldmlld0FmdGVyJywgYXJnczogW3sgaWQ6IHJldmlld1JlY29yZGVyLmlkIH1dLFxyXG4gICAgICAgICAgICAgICAgfSkgYXMgUmV2aWV3U2NlbmUpO1xyXG4gICAgICAgICAgICAvLyBBbHNvIGNvdmVyIG1hbnVhbCBpbXBvcnRzIHdob3NlIHBhbmVsIHdhcyBjbG9zZWQgd2hpbGUgaW1wb3J0aW5nLlxyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMuc2lsZW50UmV2aWV3KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XHJcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdBZnRlcjtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgICAgICAgICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ2ltcG9ydC1yZXZpZXctcmVhZHknLCByZXN1bHQucmV2aWV3KTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOe7k+aenOW3suS/neWtmO+8jOS9huiHquWKqOaJk+W8gOmdouadv+Wksei0pe+8jOivt+S7juaPkuS7tuS4reaJk+W8gOKAnOWvvOWFpee7k+aenOajgOafpeKAne+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QmVmb3JlO1xyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgLy8gYnVpbGRBc3NldHMgbWF5IHByb21vdGUgYSBjb250YWluZXIgdG8gYSBsb2NhbCBzYW1lLW5hbWUgcmVzb3VyY2UuXHJcbiAgICAgICAgLy8gQ29tcGlsZSBhZnRlciB0aGF0IHByb21vdGlvbiBzbyBhc3NldHMgYW5kIFNjZW5lTm9kZVNwZWMgc2hhcmUgdGhlXHJcbiAgICAgICAgLy8gZXhhY3Qgc2FtZSBmaW5hbCBwbGFuLlxyXG4gICAgICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgY29uc3QgZm9udHMgPSBhd2FpdCByZXNvbHZlRm9udHMoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZVJvb3RGcmFtZXMgPSBkb2N1bWVudC5yb290cy5tYXAobm9kZUZyYW1lKTtcclxuICAgICAgICBjb25zdCBtdWx0aXBsZVJvb3RzID0gZG9jdW1lbnQucm9vdHMubGVuZ3RoID4gMTtcclxuICAgICAgICBjb25zdCBhcnJhbmdlZFdpZHRoID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHNvdXJjZVJvb3RGcmFtZXMucmVkdWNlKCh0b3RhbCwgZnJhbWUpID0+IHRvdGFsICsgZnJhbWUud2lkdGgsIDApXHJcbiAgICAgICAgICAgICAgICArIE1hdGgubWF4KDAsIHNvdXJjZVJvb3RGcmFtZXMubGVuZ3RoIC0gMSkgKiAxNjBcclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdPy53aWR0aCA/PyAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RGcmFtZSA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICB4OiAwLFxyXG4gICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiBhcnJhbmdlZFdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCgwLCAuLi5zb3VyY2VSb290RnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLmhlaWdodCkpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXSA/PyB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgICAgICBsZXQgcm9vdEN1cnNvciA9IDA7XHJcbiAgICAgICAgLy8g57uE5Lu257qn5ZCM5q2l77ya5Y+q5pyJ5Y2V6IqC54K56ZO+5o6l44CB5LiU5qC56IqC54K556Gu5a6e5piv57uE5Lu277yI5oiW5a6e5L6L77yJ5pe25ZCv55So44CCXHJcbiAgICAgICAgLy8gRnJhbWUg6ZO+5o6l5L+d5oyB5Y6f5pyJ6KGM5Li677yM5LiN55Sf5oiQ5qCH6K6w44CB5LiN6aKd5aSW5Yib5bu66aG555uu6ISa5pys44CCXHJcbiAgICAgICAgY29uc3Qgc3luY0NvbnRleHQgPSBzeW5jTW9kZSA/IHsgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSB9IDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gZG9jdW1lbnQucm9vdHNcclxuICAgICAgICAgICAgLm1hcCgobm9kZSwgaW5kZXgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHNwZWMgPSBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQubm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgMCxcclxuICAgICAgICAgICAgICAgICAgICBzeW5jQ29udGV4dCxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5mcmFtZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogcm9vdEN1cnNvcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDdXJzb3IgKz0gc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGggKyAxNjA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigobm9kZSk6IG5vZGUgaXMgU2NlbmVOb2RlU3BlYyA9PiBub2RlICE9PSBudWxsKTtcclxuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeaciemAieS4reS7u+S9leWPr+WvvOWFpeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3luY0NvbnRleHQpIHtcclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGFzc2VydFVuaXF1ZVN5bmNPd25lcnNoaXAoY29sbGVjdFN5bmNNYXJrZXJTcGVjcyhyb290cykpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflkIzmraXmoIforrDmiYDmnInmnYPmoKHpqozlpLHotKXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgc291cmNlTm9kZUlkID0gZG9jdW1lbnQuc291cmNlTm9kZUlkO1xyXG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVmYWJXcml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5yb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xyXG4gICAgICAgICAgICBpZiAoc3luY0NvbnRleHQpIHtcclxuICAgICAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICAgICAgdmFsdWU6IDAuMDIsXHJcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZTogJ+ato+WcqOWHhuWkh+e7hOS7tuWQjOatpeagh+iusOiEmuacrOKApicsXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHNjcmlwdCA9IGF3YWl0IGVuc3VyZVN5bmNNYXJrZXJTY3JpcHQoKTtcclxuICAgICAgICAgICAgICAgIGlmIChzY3JpcHQucmVhc29uKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChzY3JpcHQucmVhc29uKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMC4wNSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKHtcclxuICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgIHByZWZhYk5hbWU6IGZyYW1lTmFtZSxcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VOb2RlSWQsXHJcbiAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgICAgIHNraXBTeW5jTm9kZUlkcyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGlmIChyZXN1bHQuc3luY01hcmtlcldhcm5pbmcpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOe7hOS7tuWQjOatpeagh+iusOacquWGmeWFpe+8miR7cmVzdWx0LnN5bmNNYXJrZXJXYXJuaW5nfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICAgICAgLy8gUHJlZmFiIHVwZGF0ZXMgcGVyc2lzdCBieSBQcmVmYWJJbmZvLmZpbGVJZCBpbiB0aGUgYXNzZXQgbWV0YTtcclxuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR977yM5bey5omT5byA6aKE5Yi25L2TICR7cHJlZmFiVXJsfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICByb290TmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB1cGRhdGVFeGlzdGluZzogaW1wb3J0U2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTWFwOiBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA/PyB7fSxcclxuICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgfTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDAuMSwgbWVzc2FnZTogJ+ato+WcqOaehOW7uiBDb2NvcyDoioLngrnmoJHigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID0gcmVzdWx0Lm5vZGVNYXA7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnbm9kZScsIHJlc3VsdC5yb290VXVpZCk7XHJcbiAgICAgICAgaWYgKGltcG9ydFNldHRpbmdzLmF1dG9TYXZlKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdHJhY2UuZG9uZSgpO1xyXG4gICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgQ2FuY2VsbGVkRXJyb3IgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5Y+W5raI44CCJyB9KTtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmk43kvZzlt7Llj5bmtojjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflr7zlhaXlpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgdHJhY2UuZXZlbnQoJ+WQjuWPsOS7u+WKoeW3sumHiuaUvicpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRNY3BQbHVnaW5TdGF0ZSgpIHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgdmF1bHQ6IHZhdWx0LnN0YXR1cygpLFxyXG4gICAgICAgIHNldHRpbmdzOiBhd2FpdCBnZXRTZXR0aW5ncygpLFxyXG4gICAgICAgIGRvY3VtZW50OiBkb2N1bWVudCA/IHtcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpLFxyXG4gICAgICAgIH0gOiBudWxsLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGx1Z2luU3RhdGUoKSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLmF3YWl0IGdldE1jcFBsdWdpblN0YXRlKCksXHJcbiAgICAgICAgZm9udEFzc2V0czogYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPliBGaWdtYSDmlofku7bigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXJzZWQubm9kZUlkXHJcbiAgICAgICAgICAgID8gYXdhaXQgYXBpLmdldE5vZGUocGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpXHJcbiAgICAgICAgICAgIDogYXdhaXQgYXBpLmdldEZpbGUocGFyc2VkLmZpbGVLZXkpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oXHJcbiAgICAgICAgICAgIHBhcnNlRG9jdW1lbnQocGF5bG9hZCwgc291cmNlVXJsLCBwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoeyAuLi5jdXJyZW50LCBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgY29uc3QgZm9udEFzc2V0cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZU92ZXJyaWRlcyA9IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSk7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6IGDlt7Lor7vlj5YgJHtkb2N1bWVudC5maWxlTmFtZX1gIH0pO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsLFxyXG4gICAgICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLFxyXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgIGZvbnRBc3NldHMsXHJcbiAgICAgICAgICAgIG5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiwgZm9udEFzc2V0cz86IEZvbnRBc3NldE9wdGlvbltdKTogUHJvbWlzZTxCYXRjaERvY3VtZW50RHRvPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSwgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGZvbnRBc3NldHMgPz8gYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgICAgICBub2RlT3ZlcnJpZGVzOiAoYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSkuZmlsdGVyKChpdGVtKSA9PiBkb2N1bWVudC5ub2RlQnlJZC5oYXMoaXRlbS5pZCkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJhdGNoU291cmNlKHNvdXJjZVVybDogc3RyaW5nKTogUHJvbWlzZTxCYXRjaFNvdXJjZVJlc3VsdD4ge1xyXG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgaWYgKCFwYXJzZWQubm9kZUlkKSB7XHJcbiAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUpIHRocm93IG5ldyBFcnJvcign5pW05Lu95paH5Lu26K+35Y2V54us5a+85YWl77yb6K+35YWI56e76Zmk5om56YeP55WM6Z2i5YiX6KGo77yM5oiW5L2/55SoIFNlY3Rpb24gLyBGcmFtZSDpk77mjqXjgIInKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6ICdmaWxlJywgc291cmNlVXJsLCBpdGVtczogW10sIGFkZGVkOiAwLCBkdXBsaWNhdGVzOiAwLCBkb2N1bWVudCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPluW5tuivhuWIqyBTZWN0aW9uIC8gRnJhbWXigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCk7XHJcbiAgICAgICAgY29uc3QgcGFyc2VkRG9jdW1lbnQgPSBwYXJzZURvY3VtZW50KGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcclxuICAgICAgICAgICAgc291cmNlVXJsLCBwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdCA9IHBhcnNlZERvY3VtZW50LnJvb3RzWzBdO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGlmIChyb290LnR5cGUgIT09ICdTRUNUSU9OJyAmJiByb290LnR5cGUgIT09ICdGUkFNRScpIHtcclxuICAgICAgICAgICAgaWYgKGJhdGNoRG9jdW1lbnRzLnNpemUpIHRocm93IG5ldyBFcnJvcign5om56YeP5YiX6KGo5Y+q5o6l5Y+XIFNlY3Rpb24g5oiWIEZyYW1l77yb5YW25LuW6IqC54K56K+35riF56m65YiX6KGo5ZCO5Y2V54us5a+85YWl44CCJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4ocGFyc2VkRG9jdW1lbnQpO1xyXG4gICAgICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgICAgIGF3YWl0IHBhdGNoU2V0dGluZ3MoeyBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHNvdXJjZVR5cGU6ICdub2RlJywgc291cmNlVXJsLCBpdGVtczogW10sIGFkZGVkOiAwLCBkdXBsaWNhdGVzOiAwLFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IGF3YWl0IGJhdGNoRG9jdW1lbnREdG8oZG9jdW1lbnQsIGZvbnRBc3NldHMpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGZyYW1lcyA9IGNvbGxlY3RTZWN0aW9uRnJhbWVzKHJvb3QpO1xyXG4gICAgICAgIGlmICghZnJhbWVzLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCfov5nkuKogU2VjdGlvbiDkuIvmsqHmnInlj6/ni6znq4vlr7zlhaXnmoTlpJblsYIgRnJhbWXjgIInKTtcclxuICAgICAgICBjb25zdCBwcmVwYXJlZDogQXJyYXk8eyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB9PiA9IFtdO1xyXG4gICAgICAgIGxldCBkdXBsaWNhdGVzID0gMDtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIGZyYW1lcykge1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKHBhcnNlZC5maWxlS2V5LCBmcmFtZS5pZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gYmF0Y2hEb2N1bWVudHMuZ2V0KGlkKTtcclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBkdXBsaWNhdGVzICs9IDE7XHJcbiAgICAgICAgICAgICAgICBwcmVwYXJlZC5wdXNoKHsgLi4uZXhpc3RpbmcsIGl0ZW06IHsgLi4uZXhpc3RpbmcuaXRlbSxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhleGlzdGluZy5kb2N1bWVudCwgZm9udEFzc2V0cykgfSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oZnJhbWVEb2N1bWVudChwYXJzZWREb2N1bWVudCwgZnJhbWUpKTtcclxuICAgICAgICAgICAgY29uc3QgaXRlbTogQmF0Y2hGcmFtZUl0ZW0gPSB7XHJcbiAgICAgICAgICAgICAgICBpZCwgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSwgcm9vdElkOiBmcmFtZS5pZCwgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgICAgICBuYW1lOiBmcmFtZS5uYW1lLCBlbmFibGVkOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgLi4uKHJvb3QudHlwZSA9PT0gJ1NFQ1RJT04nID8geyBzZWN0aW9uTmFtZTogcm9vdC5uYW1lIH0gOiB7fSksXHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogYXdhaXQgYmF0Y2hEb2N1bWVudER0byhkb2N1bWVudCwgZm9udEFzc2V0cyksXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIHByZXBhcmVkLnB1c2goeyBpdGVtLCBkb2N1bWVudCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYWRkZWQgPSBwcmVwYXJlZC5sZW5ndGggLSBkdXBsaWNhdGVzO1xyXG4gICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5zaXplICsgYWRkZWQgPiBNQVhfQkFUQ0hfSVRFTVMpIHRocm93IG5ldyBFcnJvcign5pys5om55pyA5aSa5re75YqgICcgKyBNQVhfQkFUQ0hfSVRFTVMgKyAnIOS4queVjOmdou+8jOivt+WIhuaJueWvvOWFpeOAgicpO1xyXG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHByZXBhcmVkKSBiYXRjaERvY3VtZW50cy5zZXQoZW50cnkuaXRlbS5pZCwgZW50cnkpO1xyXG4gICAgICAgIGF3YWl0IHBhdGNoU2V0dGluZ3MoeyBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6ICflt7Lmt7vliqAgJyArIGFkZGVkICsgJyDkuKrnlYzpnaInXHJcbiAgICAgICAgICAgICsgKGR1cGxpY2F0ZXMgPyAn77yMJyArIGR1cGxpY2F0ZXMgKyAnIOS4quW3suWcqOWIl+ihqCcgOiAnJykgKyAn44CCJyB9KTtcclxuICAgICAgICByZXR1cm4geyBzb3VyY2VUeXBlOiByb290LnR5cGUgPT09ICdTRUNUSU9OJyA/ICdzZWN0aW9uJyA6ICdmcmFtZScsIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgaXRlbXM6IHByZXBhcmVkLm1hcCgoZW50cnkpID0+IGVudHJ5Lml0ZW0pLCBhZGRlZCwgZHVwbGljYXRlcyB9O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYWN0aXZhdGVCYXRjaEl0ZW0oaWQ6IHN0cmluZyk6IFByb21pc2U8QmF0Y2hEb2N1bWVudER0bz4ge1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gYmF0Y2hEb2N1bWVudHMuZ2V0KGlkKTtcclxuICAgICAgICBpZiAoIWVudHJ5KSB0aHJvdyBuZXcgRXJyb3IoJ+ivpeeVjOmdouW3suWkseaViO+8jOivt+mHjeaWsOa3u+WKoOmTvuaOpeOAgicpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgYmF0Y2hEb2N1bWVudER0byhlbnRyeS5kb2N1bWVudCk7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBlbnRyeS5kb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgZW50cnkuaXRlbS5kb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIHJldHVybiBkb2N1bWVudDtcclxuICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzeW5jQmF0Y2hJdGVtcyhpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBlbmFibGVkOiBib29sZWFuIH0+KTogeyBpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSB9IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCB8fCBhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeS7u+WKoeWujOaIkOWQjuWGjeS/ruaUueeVjOmdouWIl+ihqOOAgicpO1xyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGl0ZW1zKSB8fCBpdGVtcy5sZW5ndGggPiBNQVhfQkFUQ0hfSVRFTVMpIHRocm93IG5ldyBFcnJvcign5om56YeP55WM6Z2i5YiX6KGo5peg5pWI44CCJyk7XHJcbiAgICBjb25zdCBuZXh0ID0gbmV3IE1hcDxzdHJpbmcsIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfT4oKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgIGNvbnN0IGVudHJ5ID0gaXRlbSAmJiBiYXRjaERvY3VtZW50cy5nZXQoaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgaXRlbS5lbmFibGVkICE9PSAnYm9vbGVhbicgfHwgbmV4dC5oYXMoaXRlbS5pZCkpIHRocm93IG5ldyBFcnJvcign55WM6Z2i5YiX6KGo5bey6L+H5pyf5oiW5YyF5ZCr6YeN5aSN6aG577yM6K+36YeN5paw6K+75Y+W44CCJyk7XHJcbiAgICAgICAgbmV4dC5zZXQoaXRlbS5pZCwgeyAuLi5lbnRyeSwgaXRlbTogeyAuLi5lbnRyeS5pdGVtLCBlbmFibGVkOiBpdGVtLmVuYWJsZWQgfSB9KTtcclxuICAgIH1cclxuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgZW50cnldIG9mIG5leHQpIGJhdGNoRG9jdW1lbnRzLnNldChpZCwgZW50cnkpO1xyXG4gICAgcmV0dXJuIHsgaXRlbXM6IFsuLi5iYXRjaERvY3VtZW50cy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gZW50cnkuaXRlbSkgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0QmF0Y2hTdGF0ZSgpOiBQcm9taXNlPEJhdGNoU3RhdGU+IHtcclxuICAgIGlmIChhY3RpdmVCYXRjaCkgcmV0dXJuIHtcclxuICAgICAgICBpdGVtczogWy4uLmJhdGNoRG9jdW1lbnRzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiBlbnRyeS5pdGVtKSxcclxuICAgICAgICBsYXN0UmVzdWx0OiBsYXN0QmF0Y2hSZXN1bHQsIHJ1bm5pbmc6IGJhdGNoUHJvZ3Jlc3MoYWN0aXZlQmF0Y2gpLFxyXG4gICAgfTtcclxuICAgIGNvbnN0IGZvbnRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgIGNvbnN0IGl0ZW1zOiBCYXRjaEZyYW1lSXRlbVtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGJhdGNoRG9jdW1lbnRzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgaXRlbXMucHVzaCh7IC4uLmVudHJ5Lml0ZW0sIGRvY3VtZW50OiBhd2FpdCBiYXRjaERvY3VtZW50RHRvKGVudHJ5LmRvY3VtZW50LCBmb250cykgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBpdGVtcywgbGFzdFJlc3VsdDogbGFzdEJhdGNoUmVzdWx0LCAuLi4oYWN0aXZlQmF0Y2ggPyB7IHJ1bm5pbmc6IGJhdGNoUHJvZ3Jlc3MoYWN0aXZlQmF0Y2gpIH0gOiB7fSkgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmF0Y2gocmVxdWVzdDogQmF0Y2hJbXBvcnRSZXF1ZXN0KTogUHJvbWlzZTxCYXRjaEltcG9ydFJlc3VsdD4ge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoIHx8IGFjdGl2ZUNvbnRyb2xsZXIgfHwgYXBwbHlpbmdJbXBvcnRSZXZpZXcgfHwgcm91bmR0cmlwQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnInmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDjgIInKTtcclxuICAgIGlmICghcmVxdWVzdCB8fCAhQXJyYXkuaXNBcnJheShyZXF1ZXN0Lml0ZW1zKSB8fCAhcmVxdWVzdC5pdGVtcy5sZW5ndGggfHwgcmVxdWVzdC5pdGVtcy5sZW5ndGggPiBNQVhfQkFUQ0hfSVRFTVMpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+iHs+WwkemAieaLqeS4gOS4quacieaViOeahOW+heWvvOWFpeeVjOmdouOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSBzYWZlU2V0dGluZ3MocmVxdWVzdC5zZXR0aW5ncyk7XHJcbiAgICBjb25zdCB2aXNpYmxlSXRlbXMgPSByZXF1ZXN0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzXHJcbiAgICAgICAgfHwgYmF0Y2hEb2N1bWVudHMuZ2V0KGl0ZW0/LmlkKT8uZG9jdW1lbnQucm9vdHNbMF0/LnZpc2libGUgIT09IGZhbHNlKTtcclxuICAgIGlmICghdmlzaWJsZUl0ZW1zLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCflt7LlhbPpl63pmpDol4/lm77lsYLlr7zlhaXvvIzmiYDpgInnlYzpnaLlnYflt7LpmpDol4/vvJvor7fpgInmi6nlj6/op4HnlYzpnaLmiJblvIDlkK/lr7zlhaXpmpDol4/lm77lsYLjgIInKTtcclxuICAgIGNvbnN0IGVudHJpZXMgPSB2aXNpYmxlSXRlbXMubWFwKChpdGVtKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZW50cnkgPSBpdGVtICYmIGJhdGNoRG9jdW1lbnRzLmdldChpdGVtLmlkKTtcclxuICAgICAgICBpZiAoIWVudHJ5IHx8ICFlbnRyeS5pdGVtLmVuYWJsZWQgfHwgIUFycmF5LmlzQXJyYXkoaXRlbS5vdmVycmlkZXMpKSB0aHJvdyBuZXcgRXJyb3IoJ+W+heWvvOWFpeeVjOmdouW3suWkseaViOaIluacquWLvumAie+8jOivt+mHjeaWsOivu+WPluOAgicpO1xyXG4gICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IGl0ZW0ub3ZlcnJpZGVzLm1hcCgob3ZlcnJpZGUpID0+ICh7IC4uLm92ZXJyaWRlIH0pKTtcclxuICAgICAgICBjb25zdCByb290ID0gZW50cnkuZG9jdW1lbnQucm9vdHNbMF07XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAob3ZlcnJpZGVzLCBlbnRyeS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBpZiAoZGVjaXNpb25zLmdldChyb290LmlkKT8uYWN0aW9uID09PSAnaWdub3JlJykgdGhyb3cgbmV3IEVycm9yKCfigJwnICsgZW50cnkuaXRlbS5uYW1lICsgJ+KAneagueiKgueCueW3suW/veeVpe+8jOivt+WPlua2iOivpeeVjOmdouWLvumAieaIluaBouWkjeagueiKgueCueetlueVpeOAgicpO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBkZWNpc2lvbnMuZ2V0KHJvb3QuaWQpPy5uYW1lIHx8IHJvb3QubmFtZTtcclxuICAgICAgICByZXR1cm4geyAuLi5lbnRyeSwgb3ZlcnJpZGVzLCBuYW1lIH07XHJcbiAgICB9KTtcclxuICAgIGFzc2VydEJhdGNoVGFyZ2V0cyhlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBuYW1lOiBlbnRyeS5uYW1lIH0pKSk7XHJcbiAgICBjb25zdCBydW46IEJhdGNoUnVuID0ge1xyXG4gICAgICAgIGlkOiByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2hleCcpLCBpbmRleDogMCwgc3RvcFJlcXVlc3RlZDogZmFsc2UsXHJcbiAgICAgICAgaXRlbXM6IGVudHJpZXMubWFwKChlbnRyeSkgPT4gKHsgaWQ6IGVudHJ5Lml0ZW0uaWQsIG5hbWU6IGVudHJ5Lm5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZW50cnkuaXRlbS5zb3VyY2VVcmwsIHN0YXR1czogJ3BlbmRpbmcnIH0pKSxcclxuICAgIH07XHJcbiAgICBhY3RpdmVCYXRjaCA9IHJ1bjtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykgZW50cnkuaXRlbS5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzID0gZW50cnkub3ZlcnJpZGVzO1xyXG4gICAgY29uc3QgcHJldmlvdXNEb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3QgcHJldmlvdXNSZXN1bHQgPSByZXF1ZXN0LnByZXNlcnZlUmVzdWx0cyA/IGxhc3RCYXRjaFJlc3VsdCA6IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IGNvbXBsZXRlZFJlc3VsdCA9ICgpOiBCYXRjaEltcG9ydFJlc3VsdCA9PiB7XHJcbiAgICAgICAgY29uc3QgbWVyZ2VkID0gbmV3IE1hcDxzdHJpbmcsIEJhdGNoSW1wb3J0SXRlbVJlc3VsdD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcHJldmlvdXNSZXN1bHQ/Lml0ZW1zID8/IFtdKSB7XHJcbiAgICAgICAgICAgIGlmIChiYXRjaERvY3VtZW50cy5oYXMoaXRlbS5pZCkpIG1lcmdlZC5zZXQoaXRlbS5pZCwgeyAuLi5pdGVtIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcnVuLml0ZW1zKSBtZXJnZWQuc2V0KGl0ZW0uaWQsIHsgLi4uaXRlbSB9KTtcclxuICAgICAgICBjb25zdCBpdGVtcyA9IFsuLi5tZXJnZWQudmFsdWVzKCldO1xyXG4gICAgICAgIHJldHVybiB7IGlkOiBydW4uaWQsIGl0ZW1zLCBzdG9wcGVkOiBydW4uc3RvcFJlcXVlc3RlZCxcclxuICAgICAgICAgICAgY29tcGxldGVkOiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHRvdGFsOiBpdGVtcy5sZW5ndGggfTtcclxuICAgIH07XHJcbiAgICB0cnkge1xyXG4gICAgICAgIC8vIENoZWNrIGV2ZXJ5IGRlc3RpbmF0aW9uIGJlZm9yZSB0aGUgZmlyc3QgaW1hZ2UvcHJlZmFiIHdyaXRlLlxyXG4gICAgICAgIGNvbnN0IGZvbGRlciA9IG5ldyBBc3NldFdyaXRlcihzZXR0aW5ncy5wcmVmYWJGb2xkZXIpLmZvbGRlcjtcclxuICAgICAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9ICdkYjovL2Fzc2V0cy8nICsgZm9sZGVyICsgJy8nICsgc2FuaXRpemVBc3NldE5hbWUoZW50cnkubmFtZSkgKyAnLnByZWZhYic7XHJcbiAgICAgICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgICAgIGlmICghaW5mbykgY29udGludWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLnNvdXJjZUhhc2ggIT09IGVudHJ5Lml0ZW0uaWRcclxuICAgICAgICAgICAgICAgIHx8IChiaW5kaW5nc1tlbnRyeS5pdGVtLmlkXSAmJiBiaW5kaW5nc1tlbnRyeS5pdGVtLmlkXSAhPT0gaW5mby51dWlkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfigJwnICsgZW50cnkubmFtZSArICfigJ3nmoQgUHJlZmFiIOi3r+W+hOW3suiiq+WFtuS7luadpea6kOWNoOeUqO+8jOivt+aUueWQjeaIluiwg+aVtOi+k+WHuuebruW9leOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChydW4uc3RvcFJlcXVlc3RlZCkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBjb21wbGV0ZWRSZXN1bHQoKTtcclxuICAgICAgICAgICAgbGFzdEJhdGNoUmVzdWx0ID0gcmVzdWx0O1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5YGc5q2i77yM5bCa5pyq5byA5aeL5Lu75L2V55WM6Z2i44CCJywgYmF0Y2g6IHsgLi4uYmF0Y2hQcm9ncmVzcyhydW4pLCByZXN1bHQgfSB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKHJlcXVlc3QucHJlc2VydmVSZXN1bHRzID8geyBwcmVzZXJ2ZUhpc3Rvcnk6IHRydWUgfSA6IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGVudHJpZXMubGVuZ3RoOyBpbmRleCsrKSB7XHJcbiAgICAgICAgICAgIGlmIChydW4uc3RvcFJlcXVlc3RlZCkgYnJlYWs7XHJcbiAgICAgICAgICAgIHJ1bi5pbmRleCA9IGluZGV4O1xyXG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGVudHJpZXNbaW5kZXhdO1xyXG4gICAgICAgICAgICBjb25zdCByb3cgPSBydW4uaXRlbXNbaW5kZXhdO1xyXG4gICAgICAgICAgICByb3cuc3RhdHVzID0gJ3J1bm5pbmcnO1xyXG4gICAgICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGVudHJ5LmRvY3VtZW50O1xyXG4gICAgICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlr7zlhaUgJyArIChpbmRleCArIDEpICsgJy8nICsgZW50cmllcy5sZW5ndGggKyAn77yaJyArIGVudHJ5Lm5hbWUgfSk7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwZXJmb3JtSW1wb3J0KHsgb3ZlcnJpZGVzOiBlbnRyeS5vdmVycmlkZXMsXHJcbiAgICAgICAgICAgICAgICAgICAgc2V0dGluZ3M6IHsgLi4uc2V0dGluZ3MsIHNvdXJjZVVybDogZW50cnkuaXRlbS5zb3VyY2VVcmwgfSB9LCBydW4uaWQsXHJcbiAgICAgICAgICAgICAgICB7IGRvY3VtZW50OiBlbnRyeS5kb2N1bWVudCwgcHJlc2VydmVSZXZpZXdzOiB0cnVlLCBzaWxlbnRSZXZpZXc6IHRydWUgfSk7XHJcbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKHJvdywgeyBzdGF0dXM6ICdzdWNjZXNzJywgcHJlZmFiVXJsOiByZXN1bHQucHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgICAgIGNyZWF0ZWQ6IHJlc3VsdC5jcmVhdGVkLCB1cGRhdGVkOiByZXN1bHQudXBkYXRlZCwgd2FybmluZ3M6IHJlc3VsdC53YXJuaW5ncyxcclxuICAgICAgICAgICAgICAgICAgICByZXZpZXdJZDogcmVzdWx0LnJldmlldz8uaWQgfSk7XHJcbiAgICAgICAgICAgICAgICByb3cuc3RhdHVzID0gJ3N1Y2Nlc3MnO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgbGV0IHVuc2FmZSA9IEJvb2xlYW4oKGVycm9yIGFzIHsgcmVxdWlyZXNBdHRlbnRpb24/OiBib29sZWFuIH0pPy5yZXF1aXJlc0F0dGVudGlvbik7XHJcbiAgICAgICAgICAgICAgICB0cnkgeyBpZiAoYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSkgdW5zYWZlID0gdHJ1ZTsgfVxyXG4gICAgICAgICAgICAgICAgY2F0Y2ggeyB1bnNhZmUgPSB0cnVlOyB9XHJcbiAgICAgICAgICAgICAgICByb3cuc3RhdHVzID0gJ2ZhaWxlZCc7XHJcbiAgICAgICAgICAgICAgICByb3cuZXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflr7zlhaXlpLHotKXjgIInO1xyXG4gICAgICAgICAgICAgICAgaWYgKHVuc2FmZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJvdy5yZXF1aXJlc0F0dGVudGlvbiA9IHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgcm93LmVycm9yICs9ICcg5b2T5YmN57yW6L6R5oiW5L+d5a2Y54q25oCB6ZyA6KaB5qOA5p+l77yM5bey5pqC5YGc5ZCO57ut55WM6Z2i77yb56Gu6K6k55uu5qCH5ZKM5L+d5a2Y54q25oCB5ZCO5YaN6YeN6K+V44CCJztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICh1bnNhZmUgfHwgcmVxdWVzdC5mYWlsdXJlUG9saWN5ID09PSAnc3RvcCcpIHJ1bi5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBlbnRyeS5uYW1lICsgJ++8micgKyAocm93LnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnID8gJ+W3suS/neWtmCcgOiAn5aSx6LSlJykgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGNvbXBsZXRlZFJlc3VsdCgpO1xyXG4gICAgICAgIGxhc3RCYXRjaFJlc3VsdCA9IHJlc3VsdDtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2RvbmUnLCB2YWx1ZTogMSwgbWVzc2FnZTogcmVzdWx0LnN0b3BwZWQgPyAn5pys5om55bey5YGc5q2i77yM5bey5a6M5oiQ6aG55L+d55WZ44CCJyA6ICfmnKzmibnlr7zlhaXnu5PmnZ/jgIInLFxyXG4gICAgICAgICAgICBiYXRjaDogeyAuLi5iYXRjaFByb2dyZXNzKHJ1biksIHJlc3VsdCB9IH0pO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGlmIChhY3RpdmVCYXRjaCA9PT0gcnVuKSBhY3RpdmVCYXRjaCA9IG51bGw7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBwcmV2aW91c0RvY3VtZW50O1xyXG4gICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc3RvcEltcG9ydEJhdGNoKCk6IHsgYWNjZXB0ZWQ6IGJvb2xlYW4gfSB7XHJcbiAgICBpZiAoIWFjdGl2ZUJhdGNoKSByZXR1cm4geyBhY2NlcHRlZDogZmFsc2UgfTtcclxuICAgIGFjdGl2ZUJhdGNoLnN0b3BSZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5b2T5YmN55WM6Z2i5a6M5oiQ5L+d5a2Y5ZCO5YGc5q2i77yM5ZCO57ut55WM6Z2i5LiN5Lya5byA5aeL44CCJyB9KTtcclxuICAgIHJldHVybiB7IGFjY2VwdGVkOiB0cnVlIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVQcmV2aWV3KG5vZGVJZDogc3RyaW5nKTogUHJvbWlzZTx7IHVybDogc3RyaW5nIH0+IHtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBjb25zdCBub2RlID0gZG9jdW1lbnQ/Lm5vZGVCeUlkLmdldChub2RlSWQpO1xyXG4gICAgaWYgKCFkb2N1bWVudCB8fCAhbm9kZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6aKE6KeI6IqC54K55LiN5a2Y5Zyo44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgIGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIFtub2RlSWRdLFxyXG4gICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgMSxcclxuICAgICAgICAgICAgIW92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBpZiAoIXVybHNbbm9kZUlkXSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleeUn+aIkOiKgueCuemihOiniOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZUlkXSB9O1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzOiBSZWNvcmQ8c3RyaW5nLCAoLi4uYXJnczogYW55W10pID0+IGFueT4gPSB7XHJcbiAgICBnZXRJbXBvcnRSZXZpZXcoaWQ/OiBzdHJpbmcpIHsgcmV0dXJuIGltcG9ydFJldmlld3MuZ2V0KGlkKTsgfSxcclxuICAgIHJlc29sdmVCYXRjaFNvdXJjZSxcclxuICAgIGFjdGl2YXRlQmF0Y2hJdGVtLFxyXG4gICAgc3luY0JhdGNoSXRlbXMsXHJcbiAgICBnZXRCYXRjaFN0YXRlLFxyXG4gICAgaW1wb3J0QmF0Y2gsXHJcbiAgICBzdG9wSW1wb3J0QmF0Y2gsXHJcbiAgICBhc3luYyBnZXRJbXBvcnRSZXZpZXdQcmV2aWV3KGlkOiBzdHJpbmcsIGFzc2V0SWQ6IHN0cmluZykgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5wcmV2aWV3KGlkLCBhc3NldElkKTsgfSxcclxuICAgIGFzeW5jIGFwcGx5SW1wb3J0UmV2aWV3KGlkOiBzdHJpbmcsIHJlbW92ZWRJZHM6IHVua25vd24pIHtcclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3lr7zlhaXmiJYgRmlnbWEg6aKE6KeI5a6M5oiQ44CCJyk7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSB0cnVlO1xyXG4gICAgICAgIHRyeSB7IHJldHVybiBhd2FpdCBpbXBvcnRSZXZpZXdzLmFwcGx5KGlkLCByZW1vdmVkSWRzKTsgfVxyXG4gICAgICAgIGZpbmFsbHkgeyBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlOyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxuICAgIH0sXHJcbiAgICBhc3luYyBnZXRJbXBvcnRSZXZpZXdTb3VyY2VQcmV2aWV3KGlkOiBzdHJpbmcsIGFzc2V0SWQ6IHN0cmluZywgbm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3mk43kvZzlrozmiJDlkI7lho3liqDovb3mnaXmupDpooTop4jjgIInKTtcclxuICAgICAgICBjb25zdCB7IGZpbGVLZXksIG5vZGUgfSA9IGltcG9ydFJldmlld3Muc291cmNlKGlkLCBhc3NldElkLCBub2RlSWQpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudCgpO1xyXG4gICAgICAgICAgICBjb25zdCBpbWFnZVJlZiA9IHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsbHMgPSBhd2FpdCBhcGkuZ2V0SW1hZ2VGaWxsVXJscyhmaWxlS2V5KTtcclxuICAgICAgICAgICAgICAgIGlmIChmaWxsc1tpbWFnZVJlZl0pIHJldHVybiB7IHVybDogZmlsbHNbaW1hZ2VSZWZdLCBub3RlOiAnRmlnbWEg5Y6f5Zu+77yI5pyq5ZCI5oiQ6IqC54K55pWI5p6c77yJJyB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCBhcGkuZ2V0SW1hZ2VVcmxzKGZpbGVLZXksIFtub2RlLmlkXSwgJ3BuZycsIDEsICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpKTtcclxuICAgICAgICAgICAgaWYgKCF1cmxzW25vZGUuaWRdKSB0aHJvdyBuZXcgRXJyb3IoJ0ZpZ21hIOacqui/lOWbnumihOiniO+8jOmakOiXj+aIluWkjeadguaViOaenOiKgueCueWPr+iDveaXoOazleWNleeLrOa4suafk+OAgicpO1xyXG4gICAgICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZS5pZF0sIG5vdGU6ICdGaWdtYSDlvZPliY3oioLngrnmuLLmn5PvvIjpmpDol4/npZblhYjlj6/og73kvb/pooTop4jpgI/mmI7vvIknIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgb3BlblBhbmVsKCkge1xyXG4gICAgICAgIEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRTdGF0ZSgpIHtcclxuICAgICAgICByZXR1cm4gZ2V0UGx1Z2luU3RhdGUoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2V0VG9rZW4odmFsdWU6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiB2YXVsdC5zZXQodmFsdWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBjbGVhclRva2VuKCkge1xyXG4gICAgICAgIHJldHVybiB2YXVsdC5jbGVhcigpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyB2ZXJpZnlUb2tlbigpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpZGVudGl0eSA9IGF3YWl0IChhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpKS52ZXJpZnkoKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG9rOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgaGFuZGxlOiBpZGVudGl0eS5oYW5kbGUgfHwgJ0ZpZ21hIFVzZXInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQ2FjaGVGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZmV0Y2hEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiBnZXROb2RlUHJldmlldyhub2RlSWQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzeW5jUHJldmlldygpIHtcclxuICAgICAgICByZXR1cm4gcHJldmlld0NvbXBvbmVudFN5bmMoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwRGV0ZWN0KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmRldGVjdChzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQcmV2aWV3KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnByZXZpZXcoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUGFpcihwYWlyVG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmFwcGx5KHByZXZpZXdUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgcm91bmR0cmlwQ2FuY2VsKCkge1xyXG4gICAgICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGNhbmNlbEltcG9ydCgpIHtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2gpIHJldHVybiBzdG9wSW1wb3J0QmF0Y2goKTtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxufTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0TWNwQnJpZGdlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIGlmIChwcmV2aW91cykgYXdhaXQgcHJldmlvdXMuY2xvc2UoKTtcclxuXHJcbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xyXG4gICAgY29uc3QgYXBpID0gbmV3IEZpZ21hSW1wb3J0ZXJNY3BBcGkoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxyXG4gICAgICAgIGdldERvY3VtZW50UmV2aXNpb246ICgpID0+IGRvY3VtZW50UmV2aXNpb24sXHJcbiAgICAgICAgaXNJbXBvcnRCdXN5OiAoKSA9PiBhY3RpdmVCYXRjaCAhPT0gbnVsbCB8fCBhY3RpdmVDb250cm9sbGVyICE9PSBudWxsIHx8IHJvdW5kdHJpcENvbnRyb2xsZXIgIT09IG51bGwsXHJcbiAgICAgICAgZ2V0U3RhdGU6IGdldE1jcFBsdWdpblN0YXRlLFxyXG4gICAgICAgIGZldGNoRG9jdW1lbnQ6IGZldGNoRmlnbWFEb2N1bWVudCxcclxuICAgICAgICBnZXRQcmV2aWV3OiBnZXROb2RlUHJldmlldyxcclxuICAgICAgICBzYXZlU2V0dGluZ3MsXHJcbiAgICAgICAgcGF0Y2hTZXR0aW5ncyxcclxuICAgICAgICBzYXZlTm9kZU92ZXJyaWRlcyxcclxuICAgICAgICBwYXRjaE5vZGVOYW1lcyxcclxuICAgICAgICBpbXBvcnRTZWxlY3Rpb246IChyZXF1ZXN0LCBvcGVyYXRpb25JZCkgPT4gcGVyZm9ybUltcG9ydChyZXF1ZXN0LCBvcGVyYXRpb25JZCksXHJcbiAgICAgICAgY2FuY2VsSW1wb3J0OiAob3BlcmF0aW9uSWQpID0+IHtcclxuICAgICAgICAgICAgaWYgKCFhY3RpdmVDb250cm9sbGVyIHx8IGFjdGl2ZU9wZXJhdGlvbk93bmVyICE9PSBvcGVyYXRpb25JZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBhY3RpdmVDb250cm9sbGVyLmFib3J0KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG5ldyBNY3BCcmlkZ2VTZXJ2ZXIoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIHBsdWdpblZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgcGx1Z2luSW5zdGFuY2VJZCxcclxuICAgICAgICBpbnZva2U6IChtZXRob2QsIHBhcmFtcywgc2lnbmFsKSA9PiBhcGkuaW52b2tlKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpLFxyXG4gICAgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5zdGFydCgpO1xyXG4gICAgICAgIG1jcEFwaSA9IGFwaTtcclxuICAgICAgICBtY3BCcmlkZ2UgPSBicmlkZ2U7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5jbG9zZSgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlkK/liqjlpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMoRWRpdG9yLlByb2plY3QucGF0aCwgZWRpdG9yUmVpbXBvcnRlcik7XHJcbiAgICAgICAgY29uc3QgYWN0aXZlID0gcmVjb3ZlcmVkLmZpbHRlcigocmVzdWx0KSA9PiByZXN1bHQuc3RhdHVzID09PSAnYWN0aXZlLW93bmVyJyk7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDmo4DmtYvliLAgJHthY3RpdmUubGVuZ3RofSDkuKrku43nlLHmtLvliqjov5vnqIvmjIHmnInnmoQgUm91bmQtdHJpcCDkuovliqHvvIzmmoLml7bnpoHmraIgUGFpci9BcHBseeOAgmBcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBgUm91bmQtdHJpcCDlkK/liqjmgaLlpI3lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGFydE1jcEJyaWRnZSgpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoKSBhY3RpdmVCYXRjaC5zdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgIGJhdGNoRG9jdW1lbnRzLmNsZWFyKCk7XHJcbiAgICBsYXN0QmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7XHJcbiAgICBpbXBvcnRSZXZpZXdzLmludmFsaWRhdGUoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIGFjdGl2ZURvY3VtZW50ID0gbnVsbDtcclxuICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG1jcEJyaWRnZTtcclxuICAgIG1jcEJyaWRnZSA9IG51bGw7XHJcbiAgICBtY3BBcGkgPSBudWxsO1xyXG4gICAgdm9pZCBicmlkZ2U/LmNsb3NlKCkuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlhbPpl63lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9KTtcclxufVxyXG4iXX0=