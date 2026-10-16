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
    Editor.Message.send(package_json_1.default.name, 'progress', progress);
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
    const addDefaults = (nodes) => {
        for (const node of nodes) {
            decisions.set(node.id, {
                action: (0, import_actions_1.normalizeImportAction)(node.action),
                kind: node.kind,
                nineSlice: node.patchCandidate,
                explicit: false,
            });
            addDefaults(node.children);
        }
    };
    addDefaults(tree);
    for (const item of overrides !== null && overrides !== void 0 ? overrides : []) {
        const name = (0, node_name_1.sanitizeNodeName)(item.name);
        decisions.set(item.id, {
            action: (0, import_actions_1.normalizeImportAction)(item.action),
            kind: NODE_KINDS.has(item.kind) ? item.kind : 'auto',
            nineSlice: item.nineSlice,
            explicit: item.explicit === true,
            ...(name ? { name } : {}),
        });
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
    var _a, _b, _c, _d, _e, _f;
    const resolvedDecisions = (0, import_planner_1.resolveAutomaticMergeDecisions)(session.roots, decisions);
    decisions.clear();
    resolvedDecisions.forEach((value, key) => decisions.set(key, value));
    const writer = new assets_1.AssetWriter(importSettings.assetFolder, (url, existed) => review.beforeWrite(url, existed));
    await writer.initialize();
    const cache = new cache_1.LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new local_resources_1.LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    // Capture names before any image writes. An image created by this import
    // must still be compared by content when a later same-name source arrives.
    const outputPath = (0, path_1.join)(Editor.Project.path, 'assets', writer.folder);
    const outputResources = (0, fs_1.existsSync)(outputPath) ? new local_resources_1.LocalResourceLibrary(outputPath) : null;
    await (outputResources === null || outputResources === void 0 ? void 0 : outputResources.initialize());
    const assets = new Map();
    const warnings = new Set();
    const note = (action, name, reason, url) => { var _a; return (_a = review.note) === null || _a === void 0 ? void 0 : _a.call(review, action, name, reason, url); };
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
                : '按已有资源名称或历史来源映射复用原 SpriteFrame，保留 UUID 与原切片参数', asset.url);
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
        var _a, _b, _c, _d, _e;
        if (!nodes.length) {
            return;
        }
        const format = 'png';
        const groups = new Map();
        for (const node of nodes) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}`, format, importSettings.scale);
            // A name is a user-facing label, never proof of equal rendered pixels.
            const key = `${session.fileKey}:${node.id}:${importSettings.scale}`;
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
            const node = groupedNodes[0];
            const decision = (_b = decisions.get(node.id)) !== null && _b !== void 0 ? _b : defaultDecision(node);
            const reuseAsset = (asset, source) => {
                if (decision.nineSlice && !asset.sliced) {
                    warnings.add(`三/九宫节点“${node.name}”已直接引用同名资源，但该 SpriteFrame 未配置九宫边距，暂按普通 Sprite 显示；请在原资源中设置边距：${asset.url}`);
                }
                completeGroup(groupedNodes, asset, source);
            };
            const localMatch = (0, mask_tint_1.analyzeMaskTint)(node) ? null : await findLocal(node.name, false);
            // Project-local SpriteFrames own their pixels and slice borders.
            // Reuse their UUID before any slice analysis, compaction or refresh.
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
            const sliceAnalysis = decision.nineSlice && format === 'png'
                ? (0, slicing_1.analyzeSliceGrid)(node)
                : null;
            const lookupBorders = sliceAnalysis ? {
                left: Math.round(sliceAnalysis.borders.left * importSettings.scale),
                right: Math.round(sliceAnalysis.borders.right * importSettings.scale),
                top: Math.round(sliceAnalysis.borders.top * importSettings.scale),
                bottom: Math.round(sliceAnalysis.borders.bottom * importSettings.scale),
            } : undefined;
            const existing = !importSettings.refreshAssets ? await writer.existingForSource(nodeSourceKey(node), { tiled: false, sliced: Boolean(sliceAnalysis), borders: lookupBorders }) : null;
            if (!localMatch && existing && (decision.nineSlice || !overflowingRenderFrame(node))) {
                reuseAsset(existing, 'existing');
                continue;
            }
            const namedOutput = !localMatch && !existing && !(0, mask_tint_1.analyzeMaskTint)(node) ? await findOutput(node.name) : null;
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
            const cached = localMatch || importSettings.refreshAssets
                ? null
                : await cache.read(key);
            pending.push({
                node,
                nodes: groupedNodes,
                url: localMatch && (0, assets_1.detectImageExtension)(localMatch.contents) === 'jpg'
                    ? url.replace(/\.png$/i, '.jpg') : url,
                borders,
                sliceAnalysis: sliceAnalysis !== null && sliceAnalysis !== void 0 ? sliceAnalysis : undefined,
                renderFrame: localMatch ? undefined : renderFrame,
                key,
                contents: (_c = localMatch === null || localMatch === void 0 ? void 0 : localMatch.contents) !== null && _c !== void 0 ? _c : cached,
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
                const result = await (0, sliced_png_1.writeSlicedPng)({ write: (url, bytes, borders) => writer.resolve(url, bytes, { sourceKey: nodeSourceKey(item.node), borders }) }, item.url, contents, item.node, item.sliceAnalysis, importSettings.scale);
                asset = result.asset;
                trace.done(result.optimization);
                note(asset.sliceFallback ? 'fallback' : 'merged', item.node.name, `三/九宫：${(_d = result.optimization.reason) !== null && _d !== void 0 ? _d : result.optimization.status}`, asset.url);
            }
            else {
                asset = await writer.resolve(item.url, contents, { sourceKey: nodeSourceKey(item.node), borders: item.borders });
            }
            if (asset.sliceFallback) {
                warnings.add(`三/九宫节点“${item.node.name}”切片设置失败，已临时作为 PNG 整层导入：${asset.sliceFallback}`);
            }
            for (const groupedNode of item.nodes) {
                completeAsset(groupedNode, item.renderFrame
                    ? { ...asset, renderFrame: (_e = overflowingRenderFrame(groupedNode)) !== null && _e !== void 0 ? _e : item.renderFrame }
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
            const key = item.node.id;
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { node: item.node, nodes: [], imageRef: item.imageRef };
            group.nodes.push(item.node);
            groups.set(key, group);
        }
        let imageFillUrlsPromise;
        const downloads = new Map();
        for (const group of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)
                throw new client_1.CancelledError();
            const { leaf, innerOpacity } = imageDetails(group.node);
            const match = await findLocal(group.node.name, false);
            const localUrl = match ? assetDatabaseUrl(match.path) : null;
            if (localUrl) {
                const localAsset = await writer.existing(localUrl);
                if (!localAsset)
                    throw new Error(`同名本地资源尚无可用 SpriteFrame，不会另建副本：${localUrl}`);
                const instanceAsset = innerOpacity < 1
                    ? { ...localAsset, tint: { r: 1, g: 1, b: 1, a: innerOpacity } } : localAsset;
                for (const node of group.nodes)
                    completeAsset(node, instanceAsset, match.source);
                continue;
            }
            const mapped = !match && !importSettings.refreshAssets
                ? await writer.existingForSource(nodeSourceKey(group.node, 'image-fill-v1'), { tiled: false, sliced: false }) : null;
            const namedOutput = !match && !mapped ? await findOutput(group.node.name) : null;
            const existing = mapped !== null && mapped !== void 0 ? mapped : (namedOutput ? await writer.existing(assetDatabaseUrl(namedOutput.path)) : null);
            if (existing) {
                const instanceAsset = innerOpacity < 1
                    ? { ...existing, tint: { r: 1, g: 1, b: 1, a: innerOpacity } } : existing;
                for (const node of group.nodes)
                    completeAsset(node, instanceAsset, 'existing');
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
            const resolved = await writer.resolve(url, raster, { sourceKey: nodeSourceKey(group.node, 'image-fill-v1') });
            const asset = innerOpacity < 1 ? { ...resolved, tint: { r: 1, g: 1, b: 1, a: innerOpacity } } : resolved;
            if (group.node.children.length)
                note('merged', group.node.name, '普通 IMAGE 在隐藏和显示状态使用相同中心裁切/适配；源图缓存保留原始像素，节点透明度单独应用', asset.url);
            for (const node of group.nodes)
                completeAsset(node, asset, source);
        }
    };
    await (0, diagnostics_1.diagnosticTask)('准备平铺资源', { count: requests.tiled.length }, () => processTiled(requests.tiled));
    await (0, diagnostics_1.diagnosticTask)('准备 PNG 资源', { count: requests.png.length }, () => processRemote(requests.png));
    await (0, diagnostics_1.diagnosticTask)('准备原始 IMAGE 填充资源', { count: requests.rawImages.length }, () => processRawImages(requests.rawImages));
    const gradientAssets = new Map();
    for (const node of requests.gradients) {
        const named = await findLocal(node.name, false);
        const namedUrl = named ? assetDatabaseUrl(named.path) : null;
        if (namedUrl) {
            const existing = await writer.existing(namedUrl);
            if (!existing)
                throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedUrl}`);
            completeAsset(node, existing, named.source);
            continue;
        }
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const png = frame && fill
            ? (0, svg_1.gradientPng)(frame.width, frame.height, fill, cornerRadii(node), importSettings.scale)
            : null;
        if (png) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}:gradient`, 'png', importSettings.scale);
            const gradientKey = nodeSourceKey(node, 'gradient-v2');
            const firstAsset = gradientAssets.get(gradientKey);
            let existing = firstAsset || importSettings.refreshAssets
                ? null
                : await writer.existingForSource(gradientKey, { sliced: false, tiled: false });
            const namedOutput = !firstAsset && !existing ? await findOutput(node.name) : null;
            if (namedOutput) {
                existing = await writer.existing(assetDatabaseUrl(namedOutput.path));
                if (!existing)
                    throw new Error(`同名已有资源尚无可用 SpriteFrame，不会另建副本：${namedOutput.path}`);
            }
            const asset = (_f = firstAsset !== null && firstAsset !== void 0 ? firstAsset : existing) !== null && _f !== void 0 ? _f : await writer.resolve(url, png, { sourceKey: gradientKey });
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
            await Editor.Message.request('scene', 'snapshot-abort').catch(() => undefined);
        }
        throw error;
    }
}
async function performImport(request, operationOwner = null) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const document = activeDocument;
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
        importReviews.invalidate();
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
            : (_b = (_a = sourceRootFrames[0]) === null || _a === void 0 ? void 0 : _a.width) !== null && _b !== void 0 ? _b : 0;
        const rootFrame = multipleRoots
            ? {
                x: 0,
                y: 0,
                width: arrangedWidth,
                height: Math.max(0, ...sourceRootFrames.map((frame) => frame.height)),
            }
            : (_c = sourceRootFrames[0]) !== null && _c !== void 0 ? _c : { x: 0, y: 0, width: 0, height: 0 };
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
            const frameName = ((_e = (_d = roots[0]) === null || _d === void 0 ? void 0 : _d.name) === null || _e === void 0 ? void 0 : _e.trim())
                || ((_g = (_f = document.roots[0]) === null || _f === void 0 ? void 0 : _f.name) === null || _g === void 0 ? void 0 : _g.trim())
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
            existingMap: (_h = nodeMaps[document.fileKey]) !== null && _h !== void 0 ? _h : {},
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
    getImportReview() { return importReviews.get(); },
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
        isImportBusy: () => activeController !== null,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXlkQSx3REFnQkM7QUE4QkQsa0NBeUJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBbUVELGtDQThxQkM7QUF3Q0QsNEJBc0dDO0FBNC9CRCxvQkFhQztBQUVELHdCQVlDO0FBbmtGRCwrQkFBOEU7QUFDOUUsMkJBQWdDO0FBQ2hDLG1DQUFxQztBQUNyQywrQ0FBZ0U7QUFDaEUsMENBQWdEO0FBQ2hELG1FQUEwQztBQUMxQywyQ0FBOEU7QUFDOUUsK0NBVzBCO0FBQzFCLDJDQUErQztBQUMvQywyREFJZ0M7QUFDaEMsaURBQXlFO0FBQ3pFLDZDQUF1RTtBQUN2RSxxQ0FBK0M7QUFDL0MscURBSTBCO0FBQzFCLDhDQU8yQjtBQUMzQiw0Q0FBdUU7QUFFdkUsZ0VBQWtFO0FBQ2xFLHdDQUE2QztBQUM3QyxzREFBdUQ7QUFDdkQsb0RBQTBGO0FBQzFGLHNEQUEyRDtBQUMzRCx3REFZZ0M7QUFDaEMsd0RBQW9EO0FBQ3BELHVDQUF1RTtBQUN2RSxnREFBc0Q7QUFDdEQsaURBQXVEO0FBQ3ZELG1EQUFzRTtBQUN0RSx5REFBMkQ7QUFDM0QsbUNBbUJpQjtBQUNqQiwyQ0FBK0M7QUFDL0MsNERBQXFGO0FBQ3JGLDhFQUF5RTtBQUd6RSxNQUFNLEtBQUssR0FBRyxJQUFJLHdCQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMvQyxNQUFNLGFBQWEsR0FBRyxJQUFJLG1DQUFtQixFQUFFLENBQUM7QUFDaEQsSUFBSSxvQkFBb0IsR0FBRyxLQUFLLENBQUM7QUFDakMsSUFBSSxjQUFjLEdBQTJCLElBQUksQ0FBQztBQUNsRCxJQUFJLGdCQUFnQixHQUEyQixJQUFJLENBQUM7QUFDcEQsSUFBSSxvQkFBb0IsR0FBa0IsSUFBSSxDQUFDO0FBQy9DLElBQUksbUJBQW1CLEdBQTJCLElBQUksQ0FBQztB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T0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNsRyxPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELE1BQU0sY0FBYyxFQUFFLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQWdCLE1BQU07SUFDbEIsZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsS0FBSyxFQUFFLENBQUM7SUFDMUIsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLG9CQUFvQixHQUFHLElBQUksQ0FBQztJQUM1QixjQUFjLEdBQUcsSUFBSSxDQUFDO0lBQ3RCLGdCQUFnQixJQUFJLENBQUMsQ0FBQztJQUN0QixNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsS0FBSyxDQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDakMsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIgfSBmcm9tICdmcy9wcm9taXNlcyc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcclxuaW1wb3J0IHtcclxuICAgIGhhc0hpZGRlbkRlc2NlbmRhbnQsXHJcbiAgICBpbmZlckFjdGlvbixcclxuICAgIGluZmVyQ29jb3NMYXlvdXRNb2RlLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcclxuICAgIGlzTmFtZWRTbGljZUdyb3VwLFxyXG4gICAgaXNWZWN0b3JOb2RlLFxyXG4gICAgbmF0aXZlVGlsZWRQYWludFNvdXJjZSxcclxuICAgIHBsYWluSW1hZ2VTb3VyY2VSZWYsXHJcbiAgICB0eXBlIFRpbGVkUGFpbnRTb3VyY2UsXHJcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XHJcbmltcG9ydCB7IHBhcnNlRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hL3BhcnNlcic7XHJcbmltcG9ydCB7XHJcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcclxuICAgIGNvbXBpbGVJbXBvcnRQbGFuLFxyXG4gICAgcmVzb2x2ZUF1dG9tYXRpY01lcmdlRGVjaXNpb25zLFxyXG59IGZyb20gJy4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBhbmFseXplTWFza1RpbnQsIHZlcmlmeVdoaXRlQWxwaGFQbmcgfSBmcm9tICcuL2ZpZ21hL21hc2stdGludCc7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQsIHR5cGUgU2xpY2VBbmFseXNpcyB9IGZyb20gJy4vZmlnbWEvc2xpY2luZyc7XHJcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHtcclxuICAgIEFzc2V0V3JpdGVyLFxyXG4gICAgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMsXHJcbiAgICBkZXRlY3RJbWFnZUV4dGVuc2lvbixcclxuICAgIHJlc29sdmVBc3NldFV1aWQsXHJcbiAgICBzYW5pdGl6ZUFzc2V0TmFtZSxcclxuICAgIHR5cGUgUmFzdGVySW1hZ2VFeHRlbnNpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgeyBMb2NhbEFzc2V0Q2FjaGUsIHR5cGUgQ2FjaGVFbnRyeUtleSB9IGZyb20gJy4vaW1wb3J0ZXIvY2FjaGUnO1xyXG5pbXBvcnQgdHlwZSB7IEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBMb2NhbFJlc291cmNlTGlicmFyeSB9IGZyb20gJy4vaW1wb3J0ZXIvbG9jYWwtcmVzb3VyY2VzJztcclxuaW1wb3J0IHsgZ3JhZGllbnRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3N2Zyc7XHJcbmltcG9ydCB7IHdyaXRlU2xpY2VkUG5nIH0gZnJvbSAnLi9pbXBvcnRlci9zbGljZWQtcG5nJztcclxuaW1wb3J0IHsgcGl4ZWxTaXplZFRpbGVBc3NldCwgcmFzdGVyaXplVGlsZSwgdGlsZWRSYXN0ZXJLZXkgfSBmcm9tICcuL2ltcG9ydGVyL3RpbGVkLXBuZyc7XHJcbmltcG9ydCB7IHJhc3Rlcml6ZUltYWdlRmlsbCB9IGZyb20gJy4vaW1wb3J0ZXIvaW1hZ2UtZmlsbCc7XHJcbmltcG9ydCB7XHJcbiAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMsXHJcbiAgICBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbixcclxuICAgIGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBmaWdtYUZyYW1lU291cmNlSGFzaCxcclxuICAgIG1lcmdlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldCxcclxuICAgIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQsXHJcbiAgICByZWFkUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHJlY29yZFByZWZhYlN5bmNDYXB0dXJlLFxyXG4gICAgcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICB0eXBlIFByZWZhYlN5bmNSZWNvcmQsXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9wcmVmYWItc3luYyc7XHJcbmltcG9ydCB7IFRva2VuVmF1bHQgfSBmcm9tICcuL3NlY3VyaXR5L3Rva2VuLXZhdWx0JztcclxuaW1wb3J0IHsgRmlnbWFJbXBvcnRlck1jcEFwaSwgdHlwZSBNY3BOb2RlTmFtZVBhdGNoIH0gZnJvbSAnLi9tY3AtYXBpJztcclxuaW1wb3J0IHsgTWNwQnJpZGdlU2VydmVyIH0gZnJvbSAnLi9tY3AtYnJpZGdlL3NlcnZlcic7XHJcbmltcG9ydCB7IFJvdW5kdHJpcFNlcnZpY2UgfSBmcm9tICcuL3JvdW5kdHJpcC9zZXJ2aWNlJztcclxuaW1wb3J0IHsgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zIH0gZnJvbSAnLi9yb3VuZHRyaXAvcmVjb3ZlcnknO1xyXG5pbXBvcnQgeyBlZGl0b3JSZWltcG9ydGVyIH0gZnJvbSAnLi9yb3VuZHRyaXAvdHJhbnNhY3Rpb24nO1xyXG5pbXBvcnQge1xyXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcclxuICAgIHR5cGUgRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgdHlwZSBGaWdtYU5vZGUsXHJcbiAgICB0eXBlIEltcG9ydEFjdGlvbixcclxuICAgIHR5cGUgSW1wb3J0RGVjaXNpb24sXHJcbiAgICB0eXBlIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgdHlwZSBJbXBvcnRSZXF1ZXN0LFxyXG4gICAgdHlwZSBJbXBvcnRTZXR0aW5ncyxcclxuICAgIHR5cGUgTm9kZUtpbmQsXHJcbiAgICB0eXBlIE5vZGVJbXBvcnRQbGFuLFxyXG4gICAgdHlwZSBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NhcHR1cmUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICB0eXBlIFByb2dyZXNzRXZlbnQsXHJcbiAgICB0eXBlIFJlY3QsXHJcbiAgICB0eXBlIFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0eXBlIFNwcml0ZUFzc2V0U3BlYyxcclxuICAgIHR5cGUgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuL25vZGUtbmFtZSc7XHJcbmltcG9ydCB7IEltcG9ydFJldmlld1JlY29yZGVyLCBJbXBvcnRSZXZpZXdTZXJ2aWNlIH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3JztcclxuaW1wb3J0IHsgZmluYWxpemVJbXBvcnRSZXZpZXcgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXctZmluYWxpemUnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldywgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxuY29uc3QgaW1wb3J0UmV2aWV3cyA9IG5ldyBJbXBvcnRSZXZpZXdTZXJ2aWNlKCk7XHJcbmxldCBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlO1xyXG5sZXQgYWN0aXZlRG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVPcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IHNldHRpbmdzQ2FjaGU6IEltcG9ydFNldHRpbmdzIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZG9jdW1lbnRSZXZpc2lvbiA9IDA7XHJcbmxldCBtY3BCcmlkZ2U6IE1jcEJyaWRnZVNlcnZlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgbWNwQXBpOiBGaWdtYUltcG9ydGVyTWNwQXBpIHwgbnVsbCA9IG51bGw7XHJcbmNvbnN0IHBsdWdpbkluc3RhbmNlSWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG5sZXQgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgc2V0dGluZ3NXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcblxyXG50eXBlIERlY2lzaW9uID0gSW1wb3J0RGVjaXNpb247XHJcblxyXG5pbnRlcmZhY2UgVGlsZWRBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUmF3SW1hZ2VBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgaW1hZ2VSZWY6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICByZXZpZXdJZD86IHN0cmluZztcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XHJcbiAgICByZXZpZXdCZWZvcmU/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlld0FmdGVyPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXc/OiBJbXBvcnRSZXZpZXc7XHJcbiAgICByb290VXVpZDogc3RyaW5nO1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIGNyZWF0ZWQ6IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ6IG51bWJlcjtcclxuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgcHJlZmFiU3luYz86IFByZWZhYlNjZW5lU3luY0NhcHR1cmU7XHJcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQXNzZXRCdWlsZFJlc3VsdCB7XHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz47XHJcbiAgICB3YXJuaW5nczogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJBc3NldEluZm8ge1xyXG4gICAgdXVpZDogc3RyaW5nO1xyXG4gICAgdXJsOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlcjogc3RyaW5nO1xyXG4gICAgdHlwZTogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZWQ6IGJvb2xlYW47XHJcbiAgICBpbnZhbGlkOiBib29sZWFuO1xyXG4gICAgaXNEaXJlY3Rvcnk/OiBib29sZWFuO1xyXG4gICAgcmVhZG9ubHk/OiBib29sZWFuO1xyXG4gICAgcmVkaXJlY3Q/OiB1bmtub3duO1xyXG59XHJcblxyXG5jb25zdCBGT05UX0VYVEVOU0lPTlMgPSBuZXcgU2V0KFsnLnR0ZicsICcub3RmJywgJy5mbnQnLCAnLndvZmYnLCAnLndvZmYyJ10pO1xyXG5jb25zdCBOT0RFX0tJTkRTID0gbmV3IFNldDxOb2RlS2luZD4oW1xyXG4gICAgJ2F1dG8nLFxyXG4gICAgJ25vZGUnLFxyXG4gICAgJ3Nwcml0ZScsXHJcbiAgICAnbGFiZWwnLFxyXG4gICAgJ3JpY2hUZXh0JyxcclxuICAgICdidXR0b24nLFxyXG4gICAgJ3Njcm9sbFZpZXcnLFxyXG4gICAgJ2xheW91dCcsXHJcbl0pO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gbGlzdEZvbnRBc3NldHMoKTogUHJvbWlzZTxGb250QXNzZXRPcHRpb25bXT4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgZm9udHM6IEZvbnRBc3NldE9wdGlvbltdID0gW107XHJcbiAgICBhc3luYyBmdW5jdGlvbiB2aXNpdChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGxldCBlbnRyaWVzO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKGZvbGRlciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ25vZGVfbW9kdWxlcycgfHwgZW50cnkubmFtZSA9PT0gJ2xpYnJhcnknIHx8IGVudHJ5Lm5hbWUgPT09ICd0ZW1wJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGZvbGRlciwgZW50cnkubmFtZSk7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB2aXNpdChmaWxlUGF0aCk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIUZPTlRfRVhURU5TSU9OUy5oYXMoZXh0bmFtZShlbnRyeS5uYW1lKS50b0xvd2VyQ2FzZSgpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIGZpbGVQYXRoKS5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbiAgICAgICAgICAgIGZvbnRzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoZW50cnkubmFtZSwgZXh0bmFtZShlbnRyeS5uYW1lKSksXHJcbiAgICAgICAgICAgICAgICB1cmw6IGBkYjovL2Fzc2V0cy8ke3BhdGh9YCxcclxuICAgICAgICAgICAgICAgIHJlbGF0aXZlUGF0aDogcGF0aCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgYXdhaXQgdmlzaXQoYXNzZXRzUm9vdCk7XHJcbiAgICByZXR1cm4gZm9udHMuc29ydCgoYSwgYikgPT4gYS5yZWxhdGl2ZVBhdGgubG9jYWxlQ29tcGFyZShiLnJlbGF0aXZlUGF0aCwgJ3poLUNOJykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0UHJvZ3Jlc3MocHJvZ3Jlc3M6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ3Byb2dyZXNzJywgcHJvZ3Jlc3MpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0Q2FjaGVGb2xkZXIoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBqb2luKEVkaXRvci5Qcm9qZWN0LnRtcERpciwgcGFja2FnZUpTT04ubmFtZSwgJ2Fzc2V0LWNhY2hlJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IEltcG9ydFNldHRpbmdzIHtcclxuICAgIGNvbnN0IGlucHV0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRTZXR0aW5ncz5cclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgaW5wdXQuc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpbnB1dC5zY2FsZSlcclxuICAgICAgICA/IE1hdGgubWF4KDAuMjUsIE1hdGgubWluKDQsIGlucHV0LnNjYWxlKSlcclxuICAgICAgICA6IERFRkFVTFRfU0VUVElOR1Muc2NhbGU7XHJcbiAgICBjb25zdCBmb250TWFwID0gaW5wdXQuZm9udE1hcCAmJiB0eXBlb2YgaW5wdXQuZm9udE1hcCA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhpbnB1dC5mb250TWFwKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChba2V5LCBpdGVtXSkgPT4ga2V5LnRyaW0oKSAmJiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGl0ZW1dKSA9PiBba2V5LnRyaW0oKSwgaXRlbS50cmltKCldKSlcclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3QgcmF3TG9jYWxGb2xkZXJzID0gQXJyYXkuaXNBcnJheShpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVycylcclxuICAgICAgICA/IGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiB0eXBlb2YgaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlciA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgPyBbaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcl1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VGb2xkZXJzID0gcmF3TG9jYWxGb2xkZXJzXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyKTogZm9sZGVyIGlzIHN0cmluZyA9PiB0eXBlb2YgZm9sZGVyID09PSAnc3RyaW5nJylcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlciwgaW5kZXgsIGZvbGRlcnMpID0+IGZvbGRlcnMuaW5kZXhPZihmb2xkZXIpID09PSBpbmRleClcclxuICAgICAgICAuc2xpY2UoMCwgMyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogdHlwZW9mIGlucHV0LnNvdXJjZVVybCA9PT0gJ3N0cmluZycgPyBpbnB1dC5zb3VyY2VVcmwudHJpbSgpIDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHR5cGVvZiBpbnB1dC5hc3NldEZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5hc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXI6IHR5cGVvZiBpbnB1dC5wcmVmYWJGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5wcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnMsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogbG9jYWxSZXNvdXJjZUZvbGRlcnNbMF0gPz8gJycsXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGlucHV0LnVwZGF0ZUV4aXN0aW5nICE9PSBmYWxzZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBpbnB1dC5yZWZyZXNoQXNzZXRzID09PSB0cnVlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBpbnB1dC5hdXRvU2F2ZSA9PT0gdHJ1ZSxcclxuICAgICAgICBmb250TWFwLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBpZiAoc2V0dGluZ3NDYWNoZSkge1xyXG4gICAgICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsICdwcm9qZWN0Jyk7XHJcbiAgICBzZXR0aW5nc0NhY2hlID0gc2FmZVNldHRpbmdzKHNhdmVkKTtcclxuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBhd2FpdCBzZXR0aW5nc1dyaXRlUXVldWU7XHJcbiAgICByZXR1cm4gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoU2V0dGluZ3NXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBzZXR0aW5nc1dyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgc2V0dGluZ3NXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBuZXh0ID0gc2FmZVNldHRpbmdzKHZhbHVlKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsIG5leHQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgc2V0dGluZ3NDYWNoZSA9IG5leHQ7XHJcbiAgICAgICAgcmV0dXJuIG5leHQ7XHJcbiAgICB9KSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKCgpID0+IHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhdGNoU2V0dGluZ3ModmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIHdpdGhTZXR0aW5nc1dyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzVW5sb2NrZWQoKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQoeyAuLi5jdXJyZW50LCAuLi52YWx1ZSB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjbGllbnQoc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCA9IGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbCk6IFByb21pc2U8RmlnbWFDbGllbnQ+IHtcclxuICAgIHJldHVybiBuZXcgRmlnbWFDbGllbnQoYXdhaXQgdmF1bHQuZ2V0KCksIHNpZ25hbCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJvdW5kdHJpcFNlcnZpY2Uoc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPFJvdW5kdHJpcFNlcnZpY2U+IHtcclxuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XHJcbiAgICByZXR1cm4gbmV3IFJvdW5kdHJpcFNlcnZpY2Uoe1xyXG4gICAgICAgIGNsaWVudDogYXdhaXQgY2xpZW50KHNpZ25hbCksXHJcbiAgICAgICAgcHJvamVjdFJvb3Q6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgY3JlYXRvclZlcnNpb24sXHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTogQWJvcnRDb250cm9sbGVyIHtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbihvd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ato+WcqOehruiupOWvvOWFpeWQjueahOi1hOa6kOiwg+aVtO+8jOivt+eojeWAmeOAgicpO1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeW3suaciSBGaWdtYSDmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblhYjlj5bmtojjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gb3duZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgICAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWRQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKHNlbGVjdGVkUGF0aCk7XHJcbiAgICBjb25zdCBmb2xkZXIgPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBpZiAoIWZvbGRlciB8fCBmb2xkZXIgPT09ICcuJyB8fCBmb2xkZXIuc3RhcnRzV2l0aCgnLi4nKSB8fCBpc0Fic29sdXRlKGZvbGRlcikpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOi+k+WHuuebruW9leW/hemhu+aYr+mhueebriBhc3NldHMg5LiL55qE5a2Q5paH5Lu25aS544CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXREYXRhYmFzZVVybChmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoZmlsZVBhdGgpO1xyXG4gICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGNvbnN0IG91dHNpZGUgPSBwYXRoID09PSAnLi4nXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLi8nKVxyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi5cXFxcJylcclxuICAgICAgICB8fCBpc0Fic29sdXRlKHBhdGgpO1xyXG4gICAgaWYgKCFwYXRoIHx8IHBhdGggPT09ICcuJyB8fCBvdXRzaWRlKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gYGRiOi8vYXNzZXRzLyR7cGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyl9YDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oupIEZpZ21hIOWvvOWFpei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqemihOWItuS9k+i+k+WHuuebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93biwgX2luZGV4ID0gMCk6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnID8gY3VycmVudC50cmltKCkgOiAnJztcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gY3VycmVudEZvbGRlciAmJiBpc0Fic29sdXRlKGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgPyBjdXJyZW50Rm9sZGVyXHJcbiAgICAgICAgOiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqeacrOWcsOWQjOWQjei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGxpYnJhcnkgPSBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoc2VsZWN0ZWQpO1xyXG4gICAgcmV0dXJuIHsgZm9sZGVyOiBsaWJyYXJ5LnJvb3QgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5pb25GcmFtZShub2RlczogRmlnbWFOb2RlW10pOiBSZWN0IHtcclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGVzLm1hcChub2RlRnJhbWUpLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBSZWN0ID0+IEJvb2xlYW4odmFsdWUpKTtcclxuICAgIGlmICghZnJhbWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHggPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCkpO1xyXG4gICAgY29uc3QgeSA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55KSk7XHJcbiAgICBjb25zdCByaWdodCA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGgpKTtcclxuICAgIGNvbnN0IGJvdHRvbSA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0KSk7XHJcbiAgICByZXR1cm4geyB4LCB5LCB3aWR0aDogcmlnaHQgLSB4LCBoZWlnaHQ6IGJvdHRvbSAtIHkgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3Qge1xyXG4gICAgaWYgKG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gdW5pb25GcmFtZShub2RlLmNoaWxkcmVuKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxufVxyXG5cclxuY29uc3QgUkVOREVSX09WRVJGTE9XX0VQU0lMT04gPSAwLjU7XHJcblxyXG4vKipcclxuICogT25seSBleHBhbmQgcmFzdGVycyB3aG9zZSB2aXNpYmxlIHBpeGVscyBlc2NhcGUgdGhlIGdlb21ldHJpYyBmcmFtZS4gQVxyXG4gKiByZW5kZXIgZnJhbWUgY29udGFpbmVkIGluc2lkZSB0aGUgZ2VvbWV0cnkgb2Z0ZW4gcmVwcmVzZW50cyBpbnRlbnRpb25hbFxyXG4gKiB0cmFuc3BhcmVudCBwYWRkaW5nIGFuZCBtdXN0IGtlZXAgdGhlIGxlZ2FjeSBmaXhlZC1jYW52YXMgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3QgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgZ2VvbWV0cnkgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBjb25zdCByZW5kZXIgPSBub2RlLmFic29sdXRlUmVuZGVyQm91bmRzO1xyXG4gICAgaWYgKCFnZW9tZXRyeSB8fCAhcmVuZGVyIHx8IHJlbmRlci53aWR0aCA8PSAwIHx8IHJlbmRlci5oZWlnaHQgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBnZW9tZXRyeVJpZ2h0ID0gZ2VvbWV0cnkueCArIGdlb21ldHJ5LndpZHRoO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlCb3R0b20gPSBnZW9tZXRyeS55ICsgZ2VvbWV0cnkuaGVpZ2h0O1xyXG4gICAgY29uc3QgcmVuZGVyUmlnaHQgPSByZW5kZXIueCArIHJlbmRlci53aWR0aDtcclxuICAgIGNvbnN0IHJlbmRlckJvdHRvbSA9IHJlbmRlci55ICsgcmVuZGVyLmhlaWdodDtcclxuICAgIHJldHVybiByZW5kZXIueCA8IGdlb21ldHJ5LnggLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlci55IDwgZ2VvbWV0cnkueSAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyUmlnaHQgPiBnZW9tZXRyeVJpZ2h0ICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJCb3R0b20gPiBnZW9tZXRyeUJvdHRvbSArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgPyByZW5kZXJcclxuICAgICAgICA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29ybmVyUmFkaWkobm9kZTogRmlnbWFOb2RlKTogW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl0ge1xyXG4gICAgaWYgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWk/Lmxlbmd0aCA9PT0gNCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpIGFzIFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmFkaXVzID0gbm9kZS5jb3JuZXJSYWRpdXMgPz8gMDtcclxuICAgIHJldHVybiBbcmFkaXVzLCByYWRpdXMsIHJhZGl1cywgcmFkaXVzXTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdERlY2lzaW9uKG5vZGU6IEZpZ21hTm9kZSk6IERlY2lzaW9uIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgYWN0aW9uOiBpbmZlckFjdGlvbihub2RlKSxcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgbmluZVNsaWNlOiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlY2lzaW9uRm9yTm9kZShub2RlOiBGaWdtYU5vZGUsIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+KTogRGVjaXNpb24ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lzaW9uTWFwKG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSwgdHJlZTogVHJlZU5vZGVEdG9bXSk6IE1hcDxzdHJpbmcsIERlY2lzaW9uPiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRGVjaXNpb24+KCk7XHJcbiAgICBjb25zdCBhZGREZWZhdWx0cyA9IChub2RlczogVHJlZU5vZGVEdG9bXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGFkZERlZmF1bHRzKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBhZGREZWZhdWx0cyh0cmVlKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBvdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgICAgIGRlY2lzaW9ucy5zZXQoaXRlbS5pZCwge1xyXG4gICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAgICAgIGtpbmQ6IE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCkgPyBpdGVtLmtpbmQgOiAnYXV0bycsXHJcbiAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9ucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuICAgIGluY2x1ZGVOb2RlTmFtZSA9IHRydWUsXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgcmV0dXJuIGRlY2lzaW9uPy5leHBsaWNpdCA9PT0gdHJ1ZVxyXG4gICAgICAgIHx8IChpbmNsdWRlTm9kZU5hbWUgJiYgQm9vbGVhbihkZWNpc2lvbj8ubmFtZSkpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG50eXBlIFN0b3JlZE5vZGVPdmVycmlkZXMgPSBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4+O1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpOiBQcm9taXNlPFN0b3JlZE5vZGVPdmVycmlkZXM+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFN0b3JlZE5vZGVPdmVycmlkZXMgOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2tJZCA9ICcnKTogSW1wb3J0T3ZlcnJpZGUgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBpdGVtID0gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRPdmVycmlkZT47XHJcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyAmJiBpdGVtLmlkID8gaXRlbS5pZCA6IGZhbGxiYWNrSWQ7XHJcbiAgICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgaXRlbS5raW5kID09PSAnc3RyaW5nJyAmJiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpXHJcbiAgICAgICAgPyBpdGVtLmtpbmQgYXMgTm9kZUtpbmRcclxuICAgICAgICA6ICdhdXRvJztcclxuICAgIGNvbnN0IGV4cGxpY2l0ID0gaXRlbS5leHBsaWNpdCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgaWYgKCFleHBsaWNpdCAmJiAhbmFtZSkgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkLFxyXG4gICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UgPT09IHRydWUsXHJcbiAgICAgICAgZXhwbGljaXQsXHJcbiAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG5vZGVPdmVycmlkZXNGb3IoZmlsZUtleTogc3RyaW5nKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSAoYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpKVtmaWxlS2V5XSA/PyB7fTtcclxuICAgIGNvbnN0IHJlc3VsdDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzdG9yZWQpKSB7XHJcbiAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUodmFsdWUsIGlkKTtcclxuICAgICAgICBpZiAoc2FmZSkgcmVzdWx0LnB1c2goc2FmZSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBpZiAodHlwZW9mIGZpbGVLZXkgIT09ICdzdHJpbmcnIHx8ICFmaWxlS2V5LnRyaW0oKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW1zID0gQXJyYXkuaXNBcnJheSh2YWx1ZXMpID8gdmFsdWVzIDogW107XHJcbiAgICBjb25zdCBzYWZlSXRlbXMgPSBpdGVtc1xyXG4gICAgICAgIC5tYXAoKGl0ZW0pID0+IHNhZmVOb2RlT3ZlcnJpZGUoaXRlbSkpXHJcbiAgICAgICAgLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgSW1wb3J0T3ZlcnJpZGUgPT4gQm9vbGVhbihpdGVtKSk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgKEFycmF5LmlzQXJyYXkoc2NvcGVWYWx1ZXMpID8gc2NvcGVWYWx1ZXMgOiBzYWZlSXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLmlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBCb29sZWFuKGlkKSksXHJcbiAgICApO1xyXG4gICAgaWYgKCFzY29wZUlkcy5zaXplKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJHlvZPliY3lr7zlhaXojIPlm7TjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjb3BlZEl0ZW1zID0gc2FmZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2NvcGVJZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICBmb3IgKGNvbnN0IGlkIG9mIHNjb3BlSWRzKSB7XHJcbiAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHNjb3BlZEl0ZW1zKSB7XHJcbiAgICAgICAgY3VycmVudFtpdGVtLmlkXSA9IGl0ZW07XHJcbiAgICB9XHJcbiAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSB7XHJcbiAgICAgICAgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2NvcGVkSXRlbXM7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKFxyXG4gICAgICAgICgpID0+IHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoZmlsZUtleSwgdmFsdWVzLCBzY29wZVZhbHVlcyksXHJcbiAgICApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcGF0Y2hOb2RlTmFtZXMoZmlsZUtleTogc3RyaW5nLCBwYXRjaGVzOiBNY3BOb2RlTmFtZVBhdGNoW10pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIWZpbGVLZXkudHJpbSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkOiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBwYXRjaCBvZiBwYXRjaGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIHBhdGNoLmlkID09PSAnc3RyaW5nJyA/IHBhdGNoLmlkLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgICAgICBpZiAoIWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBub2RlSWTjgIInKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBzYWZlTm9kZU92ZXJyaWRlKGN1cnJlbnRbaWRdLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZhbGxiYWNrID0gc2FmZU5vZGVPdmVycmlkZShwYXRjaC5mYWxsYmFjaywgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBuZXh0ID0gZXhpc3RpbmcgPyB7IC4uLmV4aXN0aW5nIH0gOiBmYWxsYmFjayA/IHsgLi4uZmFsbGJhY2sgfSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbmV4dCAmJiBwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIW5leHQpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOe8uuWwkeacieaViOm7mOiupOetlueVpeOAgmApO1xyXG4gICAgICAgICAgICBpZiAocGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIG5leHQubmFtZTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHBhdGNoLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnmoTlkI3np7Dml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIG5leHQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUobmV4dCwgaWQpO1xyXG4gICAgICAgICAgICBpZiAoc2FmZSkge1xyXG4gICAgICAgICAgICAgICAgY3VycmVudFtpZF0gPSBzYWZlO1xyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVkLnB1c2goc2FmZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgICAgICBlbHNlIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdGVkO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFubm90YXRlRG9jdW1lbnRQbGFuKHNlc3Npb246IERvY3VtZW50U2Vzc2lvbik6IERvY3VtZW50U2Vzc2lvbiB7XHJcbiAgICBjb25zdCBkZWZhdWx0cyA9IGRlY2lzaW9uTWFwKFtdLCBzZXNzaW9uLnRyZWUpO1xyXG4gICAgc2Vzc2lvbi50cmVlID0gYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4oXHJcbiAgICAgICAgc2Vzc2lvbi50cmVlLFxyXG4gICAgICAgIGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlZmF1bHRzKSxcclxuICAgICk7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdEFzc2V0UmVxdWVzdHMoXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIHByZXBhcmVkOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldCgpLFxyXG4pOiB7IHBuZzogRmlnbWFOb2RlW107IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdOyByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W107IGdyYWRpZW50czogRmlnbWFOb2RlW10gfSB7XHJcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCBncmFkaWVudHM6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGFuY2VzdG9yc1Zpc2libGU6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBpZiAocHJlcGFyZWQuaGFzKG5vZGUuaWQpKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJyB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICd0cmFuc2Zvcm0nKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZWZmZWN0aXZlbHlWaXNpYmxlID0gYW5jZXN0b3JzVmlzaWJsZSAmJiBub2RlLnZpc2libGUgIT09IGZhbHNlICYmIG5vZGUub3BhY2l0eSA+IDA7XHJcbiAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlKSB7XHJcbiAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChzb3VyY2UpIHtcclxuICAgICAgICAgICAgICAgIHRpbGVkLnB1c2goeyBub2RlLCBzb3VyY2UgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBUaGUgc2FtZSBwbGFpbiBJTUFHRSBzb3VyY2UgYW5kIGNlbnRlcmVkIGNyb3AgcGF0aCBzZXJ2ZSBib3RoXHJcbiAgICAgICAgICAgICAgICAvLyB2aXNpYmlsaXR5IHN0YXRlczsgd2hvbGUtbm9kZSBleHBvcnRzIGNhbiBiYWtlIGRpZmZlcmVudCBhbHBoYS5cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJhd0ltYWdlcy5wdXNoKHsgbm9kZSwgaW1hZ2VSZWYgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEFzc2V0cyhcbiAgICBzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIGltcG9ydFNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyxcclxuICAgIHJldmlldzogSW1wb3J0UmV2aWV3UmVjb3JkZXIsXHJcbik6IFByb21pc2U8QXNzZXRCdWlsZFJlc3VsdD4ge1xyXG4gICAgY29uc3QgcmVzb2x2ZWREZWNpc2lvbnMgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xyXG4gICAgcmVzb2x2ZWREZWNpc2lvbnMuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIsICh1cmwsIGV4aXN0ZWQpID0+IHJldmlldy5iZWZvcmVXcml0ZSh1cmwsIGV4aXN0ZWQpKTtcclxuICAgIGF3YWl0IHdyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBjYWNoZSA9IG5ldyBMb2NhbEFzc2V0Q2FjaGUoZGVmYXVsdENhY2hlRm9sZGVyKCkpO1xyXG4gICAgYXdhaXQgY2FjaGUuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZXMgPSBpbXBvcnRTZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KGZvbGRlcikpO1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwobG9jYWxSZXNvdXJjZXMubWFwKChsaWJyYXJ5KSA9PiBsaWJyYXJ5LmluaXRpYWxpemUoKSkpO1xyXG4gICAgLy8gQ2FwdHVyZSBuYW1lcyBiZWZvcmUgYW55IGltYWdlIHdyaXRlcy4gQW4gaW1hZ2UgY3JlYXRlZCBieSB0aGlzIGltcG9ydFxyXG4gICAgLy8gbXVzdCBzdGlsbCBiZSBjb21wYXJlZCBieSBjb250ZW50IHdoZW4gYSBsYXRlciBzYW1lLW5hbWUgc291cmNlIGFycml2ZXMuXHJcbiAgICBjb25zdCBvdXRwdXRQYXRoID0gam9pbihFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJywgd3JpdGVyLmZvbGRlcik7XHJcbiAgICBjb25zdCBvdXRwdXRSZXNvdXJjZXMgPSBleGlzdHNTeW5jKG91dHB1dFBhdGgpID8gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KG91dHB1dFBhdGgpIDogbnVsbDtcclxuICAgIGF3YWl0IG91dHB1dFJlc291cmNlcz8uaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgYXNzZXRzID0gbmV3IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4oKTtcclxuICAgIGNvbnN0IHdhcm5pbmdzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBjb25zdCBub3RlID0gKGFjdGlvbjogTm9uTnVsbGFibGU8SW1wb3J0UmV2aWV3WydkZWNpc2lvbnMnXT5bbnVtYmVyXVsnYWN0aW9uJ10sIG5hbWU6IHN0cmluZywgcmVhc29uOiBzdHJpbmcsIHVybD86IHN0cmluZykgPT5cclxuICAgICAgICByZXZpZXcubm90ZT8uKGFjdGlvbiwgbmFtZSwgcmVhc29uLCB1cmwpO1xyXG4gICAgY29uc3Qgbm9kZVNvdXJjZUtleSA9IChub2RlOiBGaWdtYU5vZGUsIHZhcmlhbnQgPSAncmFzdGVyLXYyJykgPT5cclxuICAgICAgICBKU09OLnN0cmluZ2lmeShbc2Vzc2lvbi5maWxlS2V5LCBub2RlLmlkLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSwgdmFyaWFudF0pO1xyXG4gICAgY29uc3QgZ3JvdXBTb3VyY2VLZXkgPSAoYXNzZXRLZXk6IHN0cmluZykgPT4gSlNPTi5zdHJpbmdpZnkoW3Nlc3Npb24uZmlsZUtleSwgJ3RpbGUtdjInLCBhc3NldEtleV0pO1xyXG4gICAgY29uc3QgaW1hZ2VEZXRhaWxzID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xyXG4gICAgICAgIGxldCBsZWFmID0gbm9kZSwgaW5uZXJPcGFjaXR5ID0gMTtcclxuICAgICAgICB3aGlsZSAobGVhZi5jaGlsZHJlbi5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICAgICAgbGVhZiA9IGxlYWYuY2hpbGRyZW5bMF07XHJcbiAgICAgICAgICAgIGlubmVyT3BhY2l0eSAqPSBsZWFmLm9wYWNpdHk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGxlYWYsIGlubmVyT3BhY2l0eSB9O1xyXG4gICAgfTtcclxuICAgIGNvbnN0IGZpbmRPdXRwdXQgPSBhc3luYyAobmFtZTogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzICYmIG91dHB1dFJlc291cmNlcykge1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IG91dHB1dFJlc291cmNlcy5maW5kKG5hbWUsICdwbmcnKTtcclxuICAgICAgICAgICAgaWYgKG1hdGNoKSByZXR1cm4geyAuLi5tYXRjaCwgc291cmNlOiAnZXhpc3RpbmcnIGFzIGNvbnN0IH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfTtcclxuICAgIGNvbnN0IGZpbmRMb2NhbCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGluY2x1ZGVPdXRwdXQgPSB0cnVlKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoID0gYXdhaXQgbGlicmFyeS5maW5kKG5hbWUsICdwbmcnKTtcclxuICAgICAgICAgICAgLy8gRGlyZWN0b3J5IG9yZGVyLCBleHRlbnNpb24gcHJlZmVyZW5jZSBhbmQgcm9vdC1iZWZvcmUtc3ViZm9sZGVyXHJcbiAgICAgICAgICAgIC8vIG9yZGVyaW5nIGFyZSB0aGUgZXhpc3RpbmcgdXNlci1kZWNsYXJlZCBuYW1lIG1hcHBpbmcgY29udHJhY3QuXHJcbiAgICAgICAgICAgIGlmIChtYXRjaCkgcmV0dXJuIHsgLi4ubWF0Y2gsIHNvdXJjZTogJ2xvY2FsJyBhcyBjb25zdCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gaW5jbHVkZU91dHB1dCA/IGZpbmRPdXRwdXQobmFtZSkgOiBudWxsO1xyXG4gICAgfTtcclxuICAgIGNvbnN0IHByZXBhcmVNYXNrID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScgfHwgZGVjaXNpb24uYWN0aW9uID09PSAndHJhbnNmb3JtJyB8fCBkZWNpc2lvbi5uaW5lU2xpY2UpIHJldHVybjtcclxuICAgICAgICBjb25zdCBhbmFseXNpcyA9IGFuYWx5emVNYXNrVGludChub2RlKTtcclxuICAgICAgICBpZiAoYW5hbHlzaXMgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpKSB7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgeyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywga2luZDogJ3Nwcml0ZScsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgIGxldCByZWFzb24gPSBhbmFseXNpcy5yZWFzb247XHJcbiAgICAgICAgICAgIGlmIChhbmFseXNpcy5jYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgbWFzaywgdGludCB9ID0gYW5hbHlzaXMuY2FuZGlkYXRlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbWF0Y2ggPSBhd2FpdCBmaW5kTG9jYWwobWFzay5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbWF0Y2ggPyBhc3NldERhdGFiYXNlVXJsKG1hdGNoLnBhdGgpIDogbnVsbDtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpXHJcbiAgICAgICAgICAgICAgICAgICAgOiBhd2FpdCB3cml0ZXIuZXhpc3RpbmdGb3JTb3VyY2Uobm9kZVNvdXJjZUtleShtYXNrKSwgeyB0aWxlZDogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICAvLyBWZXJpZnkgdGhlIGJ5dGVzIG9mIHRoZSByZWZlcmVuY2VkIGFzc2V0LCBuZXZlciBhbiB1bnJlbGF0ZWRcclxuICAgICAgICAgICAgICAgIC8vIHNhbWUtbmFtZSBmaWxlIGZyb20gYSBwcm9qZWN0LWV4dGVybmFsIGxpYnJhcnkgZGlyZWN0b3J5LlxyXG4gICAgICAgICAgICAgICAgY29uc3QgYnl0ZXMgPSBsb2NhbFVybCAmJiBhc3NldCA/IG1hdGNoIS5jb250ZW50c1xyXG4gICAgICAgICAgICAgICAgICAgIDogYXNzZXQgPyBhd2FpdCByZWFkRmlsZShqb2luKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGFzc2V0LnVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpKSA6IG51bGw7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGJ5dGVzID8gdmVyaWZ5V2hpdGVBbHBoYVBuZyhieXRlcykgOiB7IHZhbGlkOiBmYWxzZSwgcmVhc29uOiAn5rKh5pyJ5Y+v6aqM6K+B55qE5pys5Zyw55m96Imy5bqV5Zu+JyB9O1xyXG4gICAgICAgICAgICAgICAgcmVhc29uID0gdmVyaWZpZWQucmVhc29uO1xyXG4gICAgICAgICAgICAgICAgaWYgKGFzc2V0ICYmIHZlcmlmaWVkLnZhbGlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdGludGVkID0geyAuLi5hc3NldCwgdGludCB9O1xyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgdGludGVkKTtcclxuICAgICAgICAgICAgICAgICAgICByZXZpZXcuYmluZChub2RlLCB0aW50ZWQsIG1hdGNoPy5zb3VyY2UgPz8gJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICAgICAgbm90ZSgndGludGVkJywgbm9kZS5uYW1lLCBgJHthbmFseXNpcy5yZWFzb25977ybJHt2ZXJpZmllZC5yZWFzb25977yb5rK/55So5Y6fIFVVSUQg5LiO5Lmd5a6r5Y+C5pWw77yM6YCP5piO5bqm5LuF6K6h566X5LiA5qyhYCwgYXNzZXQudXJsKTtcclxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbm90ZSgnZmFsbGJhY2snLCBub2RlLm5hbWUsIGAke3JlYXNvbn3vvJvkvb/nlKggRmlnbWEg5a6M5pW06JKZ54mI5ZCI5oiQ77yM5LiN5L+u5pS55YWx5Lqr5bqV5Zu+YCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHJldHVybjtcclxuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIGF3YWl0IHByZXBhcmVNYXNrKGNoaWxkKTtcclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IHJvb3Qgb2Ygc2Vzc2lvbi5yb290cykgYXdhaXQgcHJlcGFyZU1hc2socm9vdCk7XHJcbiAgICBjb25zdCBwcm90ZWN0ZWREZXNjZW5kYW50ID0gKG5vZGU6IEZpZ21hTm9kZSk6IGJvb2xlYW4gPT4gbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGNoaWxkRGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUoY2hpbGQsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGNoaWxkRGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIHJldHVybiBCb29sZWFuKGNoaWxkLmlzTWFzayB8fCBjaGlsZC5jaGlsZHJlbi5zb21lKChwYXJ0KSA9PiBwYXJ0LmlzTWFzaylcclxuICAgICAgICAgICAgfHwgYXNzZXRzLmhhcyhjaGlsZC5pZCkgfHwgY2hpbGREZWNpc2lvbi5uaW5lU2xpY2UgfHwgaXNOYW1lZFNsaWNlR3JvdXAoY2hpbGQpIHx8IGlzUGF0Y2hDYW5kaWRhdGUoY2hpbGQpKVxyXG4gICAgICAgICAgICB8fCAoY2hpbGREZWNpc2lvbi5hY3Rpb24gIT09ICdyZW5kZXInICYmIHByb3RlY3RlZERlc2NlbmRhbnQoY2hpbGQpKTtcclxuICAgIH0pO1xyXG4gICAgY29uc3QgcHJvbW90ZUxvY2FsUGFyZW50cyA9IGFzeW5jIChub2RlOiBGaWdtYU5vZGUpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICBpZiAoYXNzZXRzLmhhcyhub2RlLmlkKSB8fCBhbmFseXplTWFza1RpbnQobm9kZSkpIHJldHVybjtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gIT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgICAgICAvLyBSZW5hbWluZyB0aGlzIGNvbnRhaW5lciBkb2VzIG5vdCBjaGFuZ2UgcmVzb3VyY2UgbWF0Y2hpbmc7IG9ubHlcclxuICAgICAgICAgICAgLy8gYSBzdHJhdGVneSBvdmVycmlkZSBvbiBpdHNlbGYgb3IgYW55IG92ZXJyaWRlIGJlbG93IGl0IGJsb2Nrc1xyXG4gICAgICAgICAgICAvLyBwcm9tb3Rpb24gYmVjYXVzZSBkZXNjZW5kYW50cyB3b3VsZCBvdGhlcndpc2UgZGlzYXBwZWFyLlxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcclxuICAgICAgICAgICAgLy8gQSBzYW1lLW5hbWUgYW5jZXN0b3IgaXMgbm90IHBlcm1pc3Npb24gdG8gZXJhc2UgaW5kZXBlbmRlbnQgc2xpY2VcclxuICAgICAgICAgICAgLy8gcmVzb3VyY2VzIG9yIGEgdmVyaWZpZWQvZmFsbGJhY2sgbWFzayByZXByZXNlbnRhdGlvbiBiZWxvdyBpdC5cclxuICAgICAgICAgICAgJiYgIXByb3RlY3RlZERlc2NlbmRhbnQobm9kZSlcclxuICAgICAgICAgICAgLy8gQSBsb2NhbCBwYXJlbnQgcmVzb3VyY2UgY2Fubm90IHJlcHJlc2VudCBpbmRlcGVuZGVudGx5IGluYWN0aXZlXHJcbiAgICAgICAgICAgIC8vIGRlc2NlbmRhbnRzLiBLZWVwIHRoZSBoaWVyYXJjaHkgd2hlbmV2ZXIgc3VjaCBhIGJvdW5kYXJ5IGV4aXN0cy5cclxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxNYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKGxvY2FsTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwgeyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChub2RlLmNoaWxkcmVuLm1hcChwcm9tb3RlTG9jYWxQYXJlbnRzKSk7XHJcbiAgICB9O1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoc2Vzc2lvbi5yb290cy5tYXAocHJvbW90ZUxvY2FsUGFyZW50cykpO1xyXG4gICAgY29uc3QgZmluYWxEZWNpc2lvbnMgPSByZXNvbHZlQXV0b21hdGljTWVyZ2VEZWNpc2lvbnMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGRlY2lzaW9ucy5jbGVhcigpO1xyXG4gICAgZmluYWxEZWNpc2lvbnMuZm9yRWFjaCgodmFsdWUsIGtleSkgPT4gZGVjaXNpb25zLnNldChrZXksIHZhbHVlKSk7XHJcbiAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCBhY3RpdmVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IGFjdGl2ZUJvdW5kYXJ5ID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHJldHVybjtcclxuICAgICAgICBhY3RpdmVJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIGlmIChpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbikgfHwgZGVjaXNpb24ubmluZVNsaWNlIHx8IGFzc2V0cy5oYXMobm9kZS5pZCkpIHJldHVybjtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goYWN0aXZlQm91bmRhcnkpO1xyXG4gICAgfTtcclxuICAgIHNlc3Npb24ucm9vdHMuZm9yRWFjaChhY3RpdmVCb3VuZGFyeSk7XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgcGxhbl0gb2YgcGxhbnMpIHtcclxuICAgICAgICBpZiAoIWFjdGl2ZUlkcy5oYXMoaWQpKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBub2RlID0gc2Vzc2lvbi5ub2RlQnlJZD8uZ2V0KGlkKTtcclxuICAgICAgICBpZiAocGxhbi5yZWFzb24gPT09ICdwcmVmaXgtbWVyZ2UnKSBub3RlKCdtZXJnZWQnLCBub2RlPy5uYW1lID8/IGlkLFxyXG4gICAgICAgICAgICBwbGFuLndhcm5pbmcgPz8gJ2ljb25fL2ltZ18g5pyA5aSW5bGC6LWE5rqQ6L6555WM77yM5oyJ5b2T5YmN5pi+6ZqQ5ZCI5oiQ77yM5L+d55WZ54i26IqC54K55Yeg5L2V5LiO6YCP5piO5bqmJyk7XHJcbiAgICAgICAgZWxzZSBpZiAocGxhbi53YXJuaW5nKSB7XHJcbiAgICAgICAgICAgIHdhcm5pbmdzLmFkZChgJHtub2RlPy5uYW1lID8/IGlkfe+8miR7cGxhbi53YXJuaW5nfWApO1xyXG4gICAgICAgICAgICBub3RlKCdmYWxsYmFjaycsIG5vZGU/Lm5hbWUgPz8gaWQsIHBsYW4ud2FybmluZyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgcmVxdWVzdHMgPSBjb2xsZWN0QXNzZXRSZXF1ZXN0cyhzZXNzaW9uLnJvb3RzLCBkZWNpc2lvbnMsIG5ldyBTZXQoYXNzZXRzLmtleXMoKSkpO1xyXG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoXHJcbiAgICAgICAgKyByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoICsgcmVxdWVzdHMuZ3JhZGllbnRzLmxlbmd0aDtcclxuICAgIGxldCBjb21wbGV0ZWQgPSAwO1xyXG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgZ2V0QXBpID0gKCkgPT4ge1xyXG4gICAgICAgIGFwaVByb21pc2UgPz89IGRpYWdub3N0aWNUYXNrKCflh4blpIcgRmlnbWEg5a6i5oi356uvJywgdW5kZWZpbmVkLCAoKSA9PiBjbGllbnQoKSk7XHJcbiAgICAgICAgcmV0dXJuIGFwaVByb21pc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGNvbXBsZXRlQXNzZXQgPSAoXHJcbiAgICAgICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnIHwgJ2dlbmVyYXRlZCcgPSAnZmlnbWEnLFxyXG4gICAgKSA9PiB7XHJcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XHJcbiAgICAgICAgcmV2aWV3LmJpbmQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgaWYgKHNvdXJjZSA9PT0gJ2xvY2FsJyB8fCBzb3VyY2UgPT09ICdleGlzdGluZycpIG5vdGUoJ3JldXNlZCcsIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgc291cmNlID09PSAnbG9jYWwnID8gJ+eUqOaIt+aMh+WumuacrOWcsOebruW9leeahOWQjOWQjeaYoOWwhO+8jOS/neeVmeWOnyBTcHJpdGVGcmFtZSBVVUlEIOS4juWIh+eJh+WPguaVsCdcclxuICAgICAgICAgICAgICAgIDogJ+aMieW3suaciei1hOa6kOWQjeensOaIluWOhuWPsuadpea6kOaYoOWwhOWkjeeUqOWOnyBTcHJpdGVGcmFtZe+8jOS/neeVmSBVVUlEIOS4juWOn+WIh+eJh+WPguaVsCcsIGFzc2V0LnVybCk7XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xyXG4gICAgICAgICAgICA/ICflpI3nlKjmnKzlnLDotYTmupAnXHJcbiAgICAgICAgICAgIDogc291cmNlID09PSAnZXhpc3RpbmcnXHJcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXHJcbiAgICAgICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2dlbmVyYXRlZCdcclxuICAgICAgICAgICAgICAgICAgICA/ICfnlJ/miJDmuJDlj5gnXHJcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHt2ZXJifSAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1RpbGVkID0gYXN5bmMgKGl0ZW1zOiBUaWxlZEFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxuICAgICAgICAgICAgc291cmNlS2V5OiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGFzc2V0S2V5OiBzdHJpbmc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBQZW5kaW5nVGlsZSBleHRlbmRzIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcclxuICAgICAgICAgICAgc291cmNlVHlwZTogJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XHJcbiAgICAgICAgY29uc3QgcmVuZGVyU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBzb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICA/IGNsYW1wSW1hZ2VTY2FsZShyZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKVxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFRpbGVHcm91cD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgbm9kZSwgc291cmNlIH0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAga2luZDogc291cmNlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFpbnRTY2FsZTogc291cmNlLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyU2NhbGU6IHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldEtleSA9IHRpbGVkUmFzdGVyS2V5KHNvdXJjZUtleSwgcmVxdWVzdGVkU2NhbGUoc291cmNlKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHdyaXRlci5idWlsZFRpbGVkVXJsKG5vZGUubmFtZSwgYXNzZXRLZXksICdwbmcnKVxyXG4gICAgICAgICAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpXHJcbiAgICAgICAgICAgICAgICAudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZSwgbm9kZXM6IFtdLCBzb3VyY2UsIHNvdXJjZUtleSwgYXNzZXRLZXkgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogUGVuZGluZ1RpbGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGV4aXN0aW5nQXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGV4aXN0aW5nQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmdGb3JTb3VyY2UoZ3JvdXBTb3VyY2VLZXkoZ3JvdXAuYXNzZXRLZXkpLCB7IHRpbGVkOiB0cnVlIH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0Fzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwLm5vZGVzLCBwaXhlbFNpemVkVGlsZUFzc2V0KGV4aXN0aW5nQXNzZXQpLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBjYWNoZWRFeHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGV4dGVuc2lvbnM6IHJlYWRvbmx5IFJhc3RlckltYWdlRXh0ZW5zaW9uW10gPSBncm91cC5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gWydwbmcnXVxyXG4gICAgICAgICAgICAgICAgICAgIDogUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlM7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGV4dGVuc2lvbiBvZiBleHRlbnNpb25zKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gYXdhaXQgY2FjaGUucmVhZCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgdGlsZToke2dyb3VwLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IHJlbmRlclNjYWxlKGdyb3VwLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNhY2hlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGNhY2hlZDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGVkRXh0ZW5zaW9uID0gZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcGVuZGluZy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIC4uLmdyb3VwLFxyXG4gICAgICAgICAgICAgICAgY29udGVudHMsXHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb246IGNhY2hlZEV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgIHNvdXJjZVR5cGU6IGNvbnRlbnRzID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgcmVtb3RlSXRlbXMgPSBwZW5kaW5nLmZpbHRlcigoaXRlbSkgPT4gIWl0ZW0uY29udGVudHMpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5VcmxzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVybnNCeVNjYWxlID0gbmV3IE1hcDxudW1iZXIsIFNldDxzdHJpbmc+PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiByZW1vdGVJdGVtcykge1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5zb3VyY2Uua2luZCAhPT0gJ3NvdXJjZS1ub2RlJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2NhbGUgPSByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkcyA9IHBhdHRlcm5zQnlTY2FsZS5nZXQoc2NhbGUpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgICAgICBpZHMuYWRkKGl0ZW0uc291cmNlLmlkKTtcclxuICAgICAgICAgICAgcGF0dGVybnNCeVNjYWxlLnNldChzY2FsZSwgaWRzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBbc2NhbGUsIGlkc10gb2YgcGF0dGVybnNCeVNjYWxlKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIEFycmF5LmZyb20oaWRzKSxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2lkLCB1cmxdIG9mIE9iamVjdC5lbnRyaWVzKHVybHMpKSB7XHJcbiAgICAgICAgICAgICAgICBwYXR0ZXJuVXJscy5zZXQoYCR7aWR9OnNjYWxlOiR7c2NhbGV9YCwgdXJsKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuZWVkc0ltYWdlRmlsbHMgPSByZW1vdGVJdGVtcy5zb21lKChpdGVtKSA9PiBpdGVtLnNvdXJjZS5raW5kID09PSAnaW1hZ2UtcmVmJyk7XHJcbiAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IG5lZWRzSW1hZ2VGaWxsc1xyXG4gICAgICAgICAgICA/IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VGaWxsVXJscyhzZXNzaW9uLmZpbGVLZXkpXHJcbiAgICAgICAgICAgIDoge307XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZCA9ICh1cmw6IHN0cmluZywgbm9kZUxhYmVsOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHVybCk7XHJcbiAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHVybCwgbm9kZUxhYmVsKSk7XHJcbiAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHVybCwgdGFzayk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHRhc2s7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb24gPSBpdGVtLmV4dGVuc2lvbjtcclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gcGF0dGVyblVybHMuZ2V0KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgJHtpdGVtLnNvdXJjZS5pZH06c2NhbGU6JHtyZW5kZXJTY2FsZShpdGVtLnNvdXJjZSl9YCxcclxuICAgICAgICAgICAgICAgICAgICApXHJcbiAgICAgICAgICAgICAgICAgICAgOiBpbWFnZUZpbGxVcmxzW2l0ZW0uc291cmNlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8gYFBBVFRFUk4g5rqQ6IqC54K5ICR7aXRlbS5zb3VyY2UuaWR9YFxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGBJTUFHRSDloavlhYUgJHtpdGVtLnNvdXJjZS5pZH1gO1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95o+Q5L6bJHtsYWJlbH3vvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBkb3dubG9hZChyZW1vdGVVcmwsIGAke2l0ZW0ubm9kZS5uYW1lfSAoJHtpdGVtLm5vZGUuaWR9KWApO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgID8gJ3BuZydcclxuICAgICAgICAgICAgICAgICAgICA6IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgdGlsZToke2l0ZW0uc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgc2NhbGU6IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIWV4dGVuc2lvbikge1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCflubPpk7rotYTmupDmjInlrp7pmYXlsLrlr7jnlJ/miJAnLCB7IG5vZGU6IGl0ZW0ubm9kZS5uYW1lIH0pO1xyXG4gICAgICAgICAgICBsZXQgcmFzdGVyOiBSZXR1cm5UeXBlPHR5cGVvZiByYXN0ZXJpemVUaWxlPjtcclxuICAgICAgICAgICAgdHJ5IHsgcmFzdGVyID0gcmFzdGVyaXplVGlsZShjb250ZW50cywgcmVxdWVzdGVkU2NhbGUoaXRlbS5zb3VyY2UpLCByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSkpOyB9XHJcbiAgICAgICAgICAgIGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOW5s+mTuui1hOa6kOKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5peg5rOV5oyJ5a6e6ZmF5bC65a+455Sf5oiQ77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJhc3Rlci5yb3VuZGVkKSB3YXJuaW5ncy5hZGQoYOW5s+mTuui1hOa6kOKAnCR7aXRlbS5ub2RlLm5hbWV94oCd55qE5pi+56S65bC65a+45bey5Y+W5pW05Li6ICR7cmFzdGVyLndpZHRofcOXJHtyYXN0ZXIuaGVpZ2h0fSDlg4/ntKDvvIjmnIDlsI8gMe+8ie+8jOiKgueCuSBTY2FsZSDkv53mjIEgMeOAgmApO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChpdGVtLm5vZGUubmFtZSwgaXRlbS5hc3NldEtleSwgJ3BuZycpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUdyb3VwKFxyXG4gICAgICAgICAgICAgICAgaXRlbS5ub2RlcyxcclxuICAgICAgICAgICAgICAgIHBpeGVsU2l6ZWRUaWxlQXNzZXQoYXdhaXQgd3JpdGVyLnJlc29sdmUodXJsLCByYXN0ZXIuY29udGVudHMsIHsgc291cmNlS2V5OiBncm91cFNvdXJjZUtleShpdGVtLmFzc2V0S2V5KSwgdGlsZWQ6IHRydWUgfSkpLFxyXG4gICAgICAgICAgICAgICAgaXRlbS5zb3VyY2VUeXBlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB0cmFjZS5kb25lKHsgc291cmNlV2lkdGg6IHJhc3Rlci5zb3VyY2VXaWR0aCwgc291cmNlSGVpZ2h0OiByYXN0ZXIuc291cmNlSGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IHJhc3Rlci53aWR0aCwgaGVpZ2h0OiByYXN0ZXIuaGVpZ2h0LCB0aWxlU2NhbGU6IDEgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmVtb3RlID0gYXN5bmMgKG5vZGVzOiBGaWdtYU5vZGVbXSkgPT4ge1xyXG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgdXJsOiBzdHJpbmc7IG5vZGVzOiBGaWdtYU5vZGVbXSB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH1gLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIC8vIEEgbmFtZSBpcyBhIHVzZXItZmFjaW5nIGxhYmVsLCBuZXZlciBwcm9vZiBvZiBlcXVhbCByZW5kZXJlZCBwaXhlbHMuXHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfToke2ltcG9ydFNldHRpbmdzLnNjYWxlfWA7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgdXJsLCBub2RlczogW10gfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogQXJyYXk8e1xyXG4gICAgICAgICAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICAgICAgICAgIG5vZGVzOiBGaWdtYU5vZGVbXTtcclxuICAgICAgICAgICAgdXJsOiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGJvcmRlcnM/OiB7IGxlZnQ6IG51bWJlcjsgcmlnaHQ6IG51bWJlcjsgdG9wOiBudW1iZXI7IGJvdHRvbTogbnVtYmVyIH07XHJcbiAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM/OiBTbGljZUFuYWx5c2lzO1xyXG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XHJcbiAgICAgICAgICAgIGtleTogQ2FjaGVFbnRyeUtleTtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH0+ID0gW107XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgeyB1cmwsIG5vZGVzOiBncm91cGVkTm9kZXMgfSBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGdyb3VwZWROb2Rlc1swXTtcbiAgICAgICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XG4gICAgICAgICAgICBjb25zdCByZXVzZUFzc2V0ID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsIHNvdXJjZTogJ2xvY2FsJyB8ICdleGlzdGluZycpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlICYmICFhc3NldC5zbGljZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5bey55u05o6l5byV55So5ZCM5ZCN6LWE5rqQ77yM5L2G6K+lIFNwcml0ZUZyYW1lIOacqumFjee9ruS5neWuq+i+uei3ne+8jOaaguaMieaZrumAmiBTcHJpdGUg5pi+56S677yb6K+35Zyo5Y6f6LWE5rqQ5Lit6K6+572u6L656Led77yaJHthc3NldC51cmx9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXBlZE5vZGVzLCBhc3NldCwgc291cmNlKTtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBsb2NhbE1hdGNoID0gYW5hbHl6ZU1hc2tUaW50KG5vZGUpID8gbnVsbCA6IGF3YWl0IGZpbmRMb2NhbChub2RlLm5hbWUsIGZhbHNlKTtcclxuICAgICAgICAgICAgLy8gUHJvamVjdC1sb2NhbCBTcHJpdGVGcmFtZXMgb3duIHRoZWlyIHBpeGVscyBhbmQgc2xpY2UgYm9yZGVycy5cbiAgICAgICAgICAgIC8vIFJldXNlIHRoZWlyIFVVSUQgYmVmb3JlIGFueSBzbGljZSBhbmFseXNpcywgY29tcGFjdGlvbiBvciByZWZyZXNoLlxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBsb2NhbE1hdGNoXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcbiAgICAgICAgICAgICAgICA6IG51bGw7XG4gICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XG4gICAgICAgICAgICAgICAgcmV1c2VBc3NldChsb2NhbEFzc2V0LCBsb2NhbE1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlubborr7nva7kuLogU3ByaXRlRnJhbWUg5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBkZWNpc2lvbi5uaW5lU2xpY2UgJiYgZm9ybWF0ID09PSAncG5nJ1xyXG4gICAgICAgICAgICAgICAgPyBhbmFseXplU2xpY2VHcmlkKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgICAgIGNvbnN0IGxvb2t1cEJvcmRlcnMgPSBzbGljZUFuYWx5c2lzID8ge1xyXG4gICAgICAgICAgICAgICAgbGVmdDogTWF0aC5yb3VuZChzbGljZUFuYWx5c2lzLmJvcmRlcnMubGVmdCAqIGltcG9ydFNldHRpbmdzLnNjYWxlKSxcclxuICAgICAgICAgICAgICAgIHJpZ2h0OiBNYXRoLnJvdW5kKHNsaWNlQW5hbHlzaXMuYm9yZGVycy5yaWdodCAqIGltcG9ydFNldHRpbmdzLnNjYWxlKSxcclxuICAgICAgICAgICAgICAgIHRvcDogTWF0aC5yb3VuZChzbGljZUFuYWx5c2lzLmJvcmRlcnMudG9wICogaW1wb3J0U2V0dGluZ3Muc2NhbGUpLFxyXG4gICAgICAgICAgICAgICAgYm90dG9tOiBNYXRoLnJvdW5kKHNsaWNlQW5hbHlzaXMuYm9yZGVycy5ib3R0b20gKiBpbXBvcnRTZXR0aW5ncy5zY2FsZSksXHJcbiAgICAgICAgICAgIH0gOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmdGb3JTb3VyY2Uobm9kZVNvdXJjZUtleShub2RlKSxcclxuICAgICAgICAgICAgICAgIHsgdGlsZWQ6IGZhbHNlLCBzbGljZWQ6IEJvb2xlYW4oc2xpY2VBbmFseXNpcyksIGJvcmRlcnM6IGxvb2t1cEJvcmRlcnMgfSkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWxvY2FsTWF0Y2ggJiYgZXhpc3RpbmcgJiYgKGRlY2lzaW9uLm5pbmVTbGljZSB8fCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSkpIHtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIWxvY2FsTWF0Y2ggJiYgIWV4aXN0aW5nICYmICFhbmFseXplTWFza1RpbnQobm9kZSkgPyBhd2FpdCBmaW5kT3V0cHV0KG5vZGUubmFtZSkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWVkQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoYXNzZXREYXRhYmFzZVVybChuYW1lZE91dHB1dC5wYXRoKSEpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lZEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQobmFtZWRBc3NldCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlICYmICFzbGljZUFuYWx5c2lzKSB7XG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5peg5rOV6K6h566X6L+e57ut5YiH54mH6L6555WM77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaVgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGJvcmRlcnMgPSBzbGljZUFuYWx5c2lzPy5ib3JkZXJzO1xuICAgICAgICAgICAgLy8gTmV3IHNsaWNlZCBhc3NldHMgcmV0YWluIHRoZWlyIGV4YWN0IGdlb21ldHJpYyBjYW52YXMgYmVjYXVzZVxuICAgICAgICAgICAgLy8gdGhlaXIgZ2VuZXJhdGVkIGJvcmRlcnMgdXNlIHRoYXQgY29vcmRpbmF0ZSBzcGFjZS5cbiAgICAgICAgICAgIGNvbnN0IHJlbmRlckZyYW1lID0gYm9yZGVycyA/IHVuZGVmaW5lZCA6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSk7XG4gICAgICAgICAgICBjb25zdCBrZXk6IENhY2hlRW50cnlLZXkgPSB7XHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBub2RlSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICB2YXJpYW50OiByZW5kZXJGcmFtZSA/ICd2aXN1YWwtb3ZlcmZsb3ctdjEnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBsb2NhbE1hdGNoIHx8IGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHNcclxuICAgICAgICAgICAgICAgID8gbnVsbFxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCBjYWNoZS5yZWFkKGtleSk7XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XG4gICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICBub2RlczogZ3JvdXBlZE5vZGVzLFxuICAgICAgICAgICAgICAgIHVybDogbG9jYWxNYXRjaCAmJiBkZXRlY3RJbWFnZUV4dGVuc2lvbihsb2NhbE1hdGNoLmNvbnRlbnRzKSA9PT0gJ2pwZydcbiAgICAgICAgICAgICAgICAgICAgPyB1cmwucmVwbGFjZSgvXFwucG5nJC9pLCAnLmpwZycpIDogdXJsLFxuICAgICAgICAgICAgICAgIGJvcmRlcnMsXHJcbiAgICAgICAgICAgICAgICBzbGljZUFuYWx5c2lzOiBzbGljZUFuYWx5c2lzID8/IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgICAgIHJlbmRlckZyYW1lOiBsb2NhbE1hdGNoID8gdW5kZWZpbmVkIDogcmVuZGVyRnJhbWUsXHJcbiAgICAgICAgICAgICAgICBrZXksXHJcbiAgICAgICAgICAgICAgICBjb250ZW50czogbG9jYWxNYXRjaD8uY29udGVudHMgPz8gY2FjaGVkLFxyXG4gICAgICAgICAgICAgICAgc291cmNlOiBsb2NhbE1hdGNoID8gJ2xvY2FsJyA6IGNhY2hlZCA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdXJsczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4gPSB7fTtcclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgZm9yIChjb25zdCB1c2VBYnNvbHV0ZUJvdW5kcyBvZiBbdHJ1ZSwgZmFsc2VdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGJhdGNoID0gcmVtb3RlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiAoXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyA/ICFpdGVtLnJlbmRlckZyYW1lIDogQm9vbGVhbihpdGVtLnJlbmRlckZyYW1lKVxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICAgICAgaWYgKCFiYXRjaC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odXJscywgYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBiYXRjaC5tYXAoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzLFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmZyb21FbnRyaWVzKGJhdGNoLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlLm5hbWVdKSksXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IHVybHNbaXRlbS5ub2RlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73muLLmn5PoioLngrnvvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZShpdGVtLmtleSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGxldCBhc3NldDogU3ByaXRlQXNzZXRTcGVjO1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5zbGljZUFuYWx5c2lzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5LiJL+S5neWuq+i1hOa6kOacgOWwj+WMlicsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB3cml0ZVNsaWNlZFBuZyh7IHdyaXRlOiAodXJsLCBieXRlcywgYm9yZGVycykgPT4gd3JpdGVyLnJlc29sdmUodXJsLCBieXRlcyxcclxuICAgICAgICAgICAgICAgICAgICB7IHNvdXJjZUtleTogbm9kZVNvdXJjZUtleShpdGVtLm5vZGUpLCBib3JkZXJzIH0pIH0sIGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc2xpY2VBbmFseXNpcywgaW1wb3J0U2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgICAgICAgICAgICAgYXNzZXQgPSByZXN1bHQuYXNzZXQ7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5kb25lKHJlc3VsdC5vcHRpbWl6YXRpb24pO1xyXG4gICAgICAgICAgICAgICAgbm90ZShhc3NldC5zbGljZUZhbGxiYWNrID8gJ2ZhbGxiYWNrJyA6ICdtZXJnZWQnLCBpdGVtLm5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBg5LiJL+S5neWuq++8miR7cmVzdWx0Lm9wdGltaXphdGlvbi5yZWFzb24gPz8gcmVzdWx0Lm9wdGltaXphdGlvbi5zdGF0dXN9YCwgYXNzZXQudXJsKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGFzc2V0ID0gYXdhaXQgd3JpdGVyLnJlc29sdmUoaXRlbS51cmwsIGNvbnRlbnRzLCB7IHNvdXJjZUtleTogbm9kZVNvdXJjZUtleShpdGVtLm5vZGUpLCBib3JkZXJzOiBpdGVtLmJvcmRlcnMgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5YiH54mH6K6+572u5aSx6LSl77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaXvvJoke2Fzc2V0LnNsaWNlRmFsbGJhY2t9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGdyb3VwZWROb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7IC4uLmFzc2V0LCByZW5kZXJGcmFtZTogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShncm91cGVkTm9kZSkgPz8gaXRlbS5yZW5kZXJGcmFtZSB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyBub2RlOiBGaWdtYU5vZGU7IG5vZGVzOiBGaWdtYU5vZGVbXTsgaW1hZ2VSZWY6IHN0cmluZyB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSBpdGVtLm5vZGUuaWQ7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZTogaXRlbS5ub2RlLCBub2RlczogW10sIGltYWdlUmVmOiBpdGVtLmltYWdlUmVmIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2goaXRlbS5ub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxldCBpbWFnZUZpbGxVcmxzUHJvbWlzZTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBjb25zdCB7IGxlYWYsIGlubmVyT3BhY2l0eSB9ID0gaW1hZ2VEZXRhaWxzKGdyb3VwLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBtYXRjaCA9IGF3YWl0IGZpbmRMb2NhbChncm91cC5ub2RlLm5hbWUsIGZhbHNlKTtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBtYXRjaCA/IGFzc2V0RGF0YWJhc2VVcmwobWF0Y2gucGF0aCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxvY2FsQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFsb2NhbEFzc2V0KSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bG9jYWxVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbnN0YW5jZUFzc2V0ID0gaW5uZXJPcGFjaXR5IDwgMVxyXG4gICAgICAgICAgICAgICAgICAgID8geyAuLi5sb2NhbEFzc2V0LCB0aW50OiB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IGlubmVyT3BhY2l0eSB9IH0gOiBsb2NhbEFzc2V0O1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGdyb3VwLm5vZGVzKSBjb21wbGV0ZUFzc2V0KG5vZGUsIGluc3RhbmNlQXNzZXQsIG1hdGNoIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbWFwcGVkID0gIW1hdGNoICYmICFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShub2RlU291cmNlS2V5KGdyb3VwLm5vZGUsICdpbWFnZS1maWxsLXYxJyksIHsgdGlsZWQ6IGZhbHNlLCBzbGljZWQ6IGZhbHNlIH0pIDogbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgbmFtZWRPdXRwdXQgPSAhbWF0Y2ggJiYgIW1hcHBlZCA/IGF3YWl0IGZpbmRPdXRwdXQoZ3JvdXAubm9kZS5uYW1lKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gbWFwcGVkID8/IChuYW1lZE91dHB1dCA/IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISkgOiBudWxsKTtcclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbnN0YW5jZUFzc2V0ID0gaW5uZXJPcGFjaXR5IDwgMVxyXG4gICAgICAgICAgICAgICAgICAgID8geyAuLi5leGlzdGluZywgdGludDogeyByOiAxLCBnOiAxLCBiOiAxLCBhOiBpbm5lck9wYWNpdHkgfSB9IDogZXhpc3Rpbmc7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZ3JvdXAubm9kZXMpIGNvbXBsZXRlQXNzZXQobm9kZSwgaW5zdGFuY2VBc3NldCwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobmFtZWRPdXRwdXQpIHRocm93IG5ldyBFcnJvcihg5ZCM5ZCN5bey5pyJ6LWE5rqQ5bCa5peg5Y+v55SoIFNwcml0ZUZyYW1l77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtuYW1lZE91dHB1dC5wYXRofWApO1xyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgbGV0IHNvdXJjZTogJ2NhY2hlJyB8ICdmaWdtYScgPSAnY2FjaGUnO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGNhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBjYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWltYWdlRmlsbFVybHNQcm9taXNlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaW1hZ2VGaWxsVXJsc1Byb21pc2UgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSkpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IGF3YWl0IGltYWdlRmlsbFVybHNQcm9taXNlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gaW1hZ2VGaWxsVXJsc1tncm91cC5pbWFnZVJlZl07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95o+Q5L6b6ZqQ6JeP5Zu+54mH5aGr5YWF77yaJHtncm91cC5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQocmVtb3RlVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZChyZW1vdGVVcmwsIGAke2dyb3VwLm5vZGUubmFtZX0gKCR7Z3JvdXAubm9kZS5pZH0pYCkpO1xyXG4gICAgICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQocmVtb3RlVXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgdGFzaztcclxuICAgICAgICAgICAgICAgIHNvdXJjZSA9ICdmaWdtYSc7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZXh0ZW5zaW9uID8/PSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGwgPSBsZWFmLmZpbGxzLmZpbmQoKHBhaW50KSA9PiBwYWludC52aXNpYmxlICE9PSBmYWxzZSAmJiBwYWludC50eXBlID09PSAnSU1BR0UnKTtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUoZ3JvdXAubm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJhc3RlciA9IHJhc3Rlcml6ZUltYWdlRmlsbChjb250ZW50cywgZmlsbD8uc2NhbGVNb2RlPy50b1VwcGVyQ2FzZSgpID09PSAnRklUJyA/ICdGSVQnIDogJ0ZJTEwnLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUud2lkdGgsIGZyYW1lLmhlaWdodCwgaW1wb3J0U2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OmltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHdyaXRlci5yZXNvbHZlKHVybCwgcmFzdGVyLCB7IHNvdXJjZUtleTogbm9kZVNvdXJjZUtleShncm91cC5ub2RlLCAnaW1hZ2UtZmlsbC12MScpIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGlubmVyT3BhY2l0eSA8IDEgPyB7IC4uLnJlc29sdmVkLCB0aW50OiB7IHI6IDEsIGc6IDEsIGI6IDEsIGE6IGlubmVyT3BhY2l0eSB9IH0gOiByZXNvbHZlZDtcclxuICAgICAgICAgICAgaWYgKGdyb3VwLm5vZGUuY2hpbGRyZW4ubGVuZ3RoKSBub3RlKCdtZXJnZWQnLCBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICAn5pmu6YCaIElNQUdFIOWcqOmakOiXj+WSjOaYvuekuueKtuaAgeS9v+eUqOebuOWQjOS4reW/g+ijgeWIhy/pgILphY3vvJvmupDlm77nvJPlrZjkv53nlZnljp/lp4vlg4/ntKDvvIzoioLngrnpgI/mmI7luqbljZXni6zlupTnlKgnLCBhc3NldC51cmwpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZ3JvdXAubm9kZXMpIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5bmz6ZO66LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMudGlsZWQubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NUaWxlZChyZXF1ZXN0cy50aWxlZCkpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkhyBQTkcg6LWE5rqQJywgeyBjb3VudDogcmVxdWVzdHMucG5nLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzUmVtb3RlKHJlcXVlc3RzLnBuZykpO1xyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+WOn+WniyBJTUFHRSDloavlhYXotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XHJcblxyXG4gICAgY29uc3QgZ3JhZGllbnRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IG5hbWVkID0gYXdhaXQgZmluZExvY2FsKG5vZGUubmFtZSwgZmFsc2UpO1xyXG4gICAgICAgIGNvbnN0IG5hbWVkVXJsID0gbmFtZWQgPyBhc3NldERhdGFiYXNlVXJsKG5hbWVkLnBhdGgpIDogbnVsbDtcclxuICAgICAgICBpZiAobmFtZWRVcmwpIHtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobmFtZWRVcmwpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRVcmx9YCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgZXhpc3RpbmcsIG5hbWVkIS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgIGNvbnN0IHBuZyA9IGZyYW1lICYmIGZpbGxcclxuICAgICAgICAgICAgPyBncmFkaWVudFBuZyhcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUuaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgZmlsbCxcclxuICAgICAgICAgICAgICAgIGNvcm5lclJhZGlpKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChwbmcpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9OmdyYWRpZW50YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyYWRpZW50S2V5ID0gbm9kZVNvdXJjZUtleShub2RlLCAnZ3JhZGllbnQtdjInKTtcclxuICAgICAgICAgICAgY29uc3QgZmlyc3RBc3NldCA9IGdyYWRpZW50QXNzZXRzLmdldChncmFkaWVudEtleSk7XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZyA9IGZpcnN0QXNzZXQgfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZ0ZvclNvdXJjZShncmFkaWVudEtleSwgeyBzbGljZWQ6IGZhbHNlLCB0aWxlZDogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5hbWVkT3V0cHV0ID0gIWZpcnN0QXNzZXQgJiYgIWV4aXN0aW5nID8gYXdhaXQgZmluZE91dHB1dChub2RlLm5hbWUpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKG5hbWVkT3V0cHV0KSB7XHJcbiAgICAgICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHdyaXRlci5leGlzdGluZyhhc3NldERhdGFiYXNlVXJsKG5hbWVkT3V0cHV0LnBhdGgpISk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeW3suaciei1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOS4jeS8muWPpuW7uuWJr+acrO+8miR7bmFtZWRPdXRwdXQucGF0aH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGZpcnN0QXNzZXQgPz8gZXhpc3RpbmcgPz8gYXdhaXQgd3JpdGVyLnJlc29sdmUodXJsLCBwbmcsIHsgc291cmNlS2V5OiBncmFkaWVudEtleSB9KTtcclxuICAgICAgICAgICAgZ3JhZGllbnRBc3NldHMuc2V0KGdyYWRpZW50S2V5LCBhc3NldCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIGZpcnN0QXNzZXQgfHwgZXhpc3RpbmcgPyAnZXhpc3RpbmcnIDogJ2dlbmVyYXRlZCcpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDnlJ/miJDmuJDlj5ggJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGV2ZW50IG9mIHdyaXRlci5ldmVudHMpIG5vdGUoZXZlbnQuYWN0aW9uLCBiYXNlbmFtZShldmVudC51cmwpLCBldmVudC5yZWFzb24sIGV2ZW50LnVybCk7XHJcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmYW1pbHksIHVybF0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgcmVzb2x2ZUFzc2V0VXVpZCh1cmwpO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQoZmFtaWx5LCB1dWlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlcnJlZExheW91dE1vZGUobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IG5hdGl2ZU1vZGUgPSBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKTtcclxuICAgIGlmIChuYXRpdmVNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIG5hdGl2ZU1vZGU7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIFJlY3QgPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcclxuICAgIGNvbnN0IGNlbnRlcnNZID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQgLyAyKTtcclxuICAgIGNvbnN0IHNwcmVhZFggPSBNYXRoLm1heCguLi5jZW50ZXJzWCkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWCk7XHJcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xyXG4gICAgaWYgKHNwcmVhZFkgPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnSE9SSVpPTlRBTCc7XHJcbiAgICB9XHJcbiAgICBpZiAoc3ByZWFkWCA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ0dSSUQnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFrZVNwZWMoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcGxhbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+LFxyXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPixcclxuICAgIGZvbnRzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbiAgICBwYXJlbnRXb3JsZFJvdGF0aW9uID0gMCxcclxuKTogU2NlbmVOb2RlU3BlYyB8IG51bGwge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShub2RlKTtcclxuICAgIGNvbnN0IHBsYW4gPSBwbGFucy5nZXQobm9kZS5pZCk7XHJcbiAgICBjb25zdCBmb2xkID0gcGxhbj8uZm9sZDtcclxuICAgIGNvbnN0IGZvbGRTb3VyY2UgPSBmb2xkID8gbm9kZUJ5SWQuZ2V0KGZvbGQuc291cmNlTm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IHRleHRTb3VyY2UgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHZpc3VhbFNvdXJjZSA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHJlc29sdmVkS2luZCA9IGRlY2lzaW9uLmtpbmQgPT09ICdhdXRvJyA/IGluZmVyS2luZChub2RlKSA6IGRlY2lzaW9uLmtpbmQ7XHJcbiAgICBjb25zdCBwbGFubmVkS2luZCA9IHBsYW4/LmtpbmQgPz8gcmVzb2x2ZWRLaW5kO1xyXG4gICAgY29uc3QgYml0bWFwVGVybWluYWwgPSBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJztcclxuICAgIGNvbnN0IHRlcm1pbmFsID0gYml0bWFwVGVybWluYWwgfHwgaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24ocGxhbm5lZEtpbmQsIGRlY2lzaW9uLmFjdGlvbiwgZGVjaXNpb24ubmluZVNsaWNlKTtcclxuICAgIGNvbnN0IHNwcml0ZVNvdXJjZUlkID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCdcclxuICAgICAgICA/IGZvbGQuc291cmNlTm9kZUlkXHJcbiAgICAgICAgOiBub2RlLmlkO1xyXG4gICAgY29uc3Qgc3ByaXRlQXNzZXQgPSBhc3NldHMuZ2V0KHNwcml0ZVNvdXJjZUlkKTtcclxuICAgIGNvbnN0IGFic29yYmVkRGlyZWN0SWRzID0gbmV3IFNldChmb2xkID8gW2ZvbGQuc291cmNlTm9kZUlkXSA6IFtdKTtcclxuICAgIGNvbnN0IGZ1bGxGb2xkID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS1pbWFnZScgfHwgZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JztcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBwYXJlbnRXb3JsZFJvdGF0aW9uICsgbm9kZS5yb3RhdGlvbjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZmlnbWFJZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBkZWNpc2lvbi5uYW1lID8/IG5vZGUubmFtZSxcclxuICAgICAgICBmaWdtYVR5cGU6IHZpc3VhbFNvdXJjZS50eXBlLFxyXG4gICAgICAgIGFjdGlvbjogZGVjaXNpb24uYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgcGFyZW50RnJhbWUsXHJcbiAgICAgICAgaW50cmluc2ljU2l6ZTogbm9kZS5zaXplLFxyXG4gICAgICAgIGlzUm9vdCxcclxuICAgICAgICByb3RhdGlvbjogbm9kZS5yb3RhdGlvbixcclxuICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgIG9wYWNpdHk6IGZvbGRTb3VyY2UgJiYgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyBub2RlLm9wYWNpdHkgKiBmb2xkU291cmNlLm9wYWNpdHlcclxuICAgICAgICAgICAgOiBub2RlLm9wYWNpdHksXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQsXHJcbiAgICAgICAgY29ybmVyUmFkaWk6IGNvcm5lclJhZGlpKHZpc3VhbFNvdXJjZSksXHJcbiAgICAgICAgZmlsbHM6IHRleHRTb3VyY2UuZmlsbHMsXHJcbiAgICAgICAgc3Ryb2tlczogdGV4dFNvdXJjZS5zdHJva2VzLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogdGV4dFNvdXJjZS5zdHJva2VXZWlnaHQsXHJcbiAgICAgICAgY2hhcmFjdGVyczogdGV4dFNvdXJjZS5jaGFyYWN0ZXJzLFxyXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFNvdXJjZS5zdHlsZSxcclxuICAgICAgICBsYXlvdXQ6IHtcclxuICAgICAgICAgICAgbW9kZTogZWZmZWN0aXZlS2luZCA9PT0gJ2xheW91dCcgfHwgZWZmZWN0aXZlS2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgICAgICA/IGluZmVycmVkTGF5b3V0TW9kZShub2RlKVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIHNvdXJjZU1vZGU6IG5vZGUubGF5b3V0TW9kZSxcclxuICAgICAgICAgICAgd3JhcDogbm9kZS5sYXlvdXRXcmFwLFxyXG4gICAgICAgICAgICBwcmltYXJ5QWxpZ246IG5vZGUucHJpbWFyeUF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBjb3VudGVyQWxpZ246IG5vZGUuY291bnRlckF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBwcmltYXJ5U2l6aW5nOiBub2RlLnByaW1hcnlBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgY291bnRlclNpemluZzogbm9kZS5jb3VudGVyQXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGl0ZW1TcGFjaW5nOiBub2RlLml0ZW1TcGFjaW5nLFxyXG4gICAgICAgICAgICBjb3VudGVyU3BhY2luZzogbm9kZS5jb3VudGVyQXhpc1NwYWNpbmcsXHJcbiAgICAgICAgICAgIHBhZGRpbmdMZWZ0OiBub2RlLnBhZGRpbmdMZWZ0LFxyXG4gICAgICAgICAgICBwYWRkaW5nUmlnaHQ6IG5vZGUucGFkZGluZ1JpZ2h0LFxyXG4gICAgICAgICAgICBwYWRkaW5nVG9wOiBub2RlLnBhZGRpbmdUb3AsXHJcbiAgICAgICAgICAgIHBhZGRpbmdCb3R0b206IG5vZGUucGFkZGluZ0JvdHRvbSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIG92ZXJmbG93RGlyZWN0aW9uOiBub2RlLm92ZXJmbG93RGlyZWN0aW9uLFxyXG4gICAgICAgIGNvbnN0cmFpbnRzOiBub2RlLmNvbnN0cmFpbnRzLFxyXG4gICAgICAgIHJlbGF0aXZlVHJhbnNmb3JtOiBub2RlLnJlbGF0aXZlVHJhbnNmb3JtLFxyXG4gICAgICAgIHNwcml0ZTogc3ByaXRlQXNzZXQsXHJcbiAgICAgICAgZm9udFV1aWQ6IHRleHRTb3VyY2Uuc3R5bGU/LmZvbnRGYW1pbHkgPyBmb250cy5nZXQodGV4dFNvdXJjZS5zdHlsZS5mb250RmFtaWx5KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMsXHJcbiAgICAgICAgZmxhdHRlbkJvdW5kYXJ5OiBiaXRtYXBUZXJtaW5hbCB8fCBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IHRydWVcclxuICAgICAgICAgICAgOiBmb2xkPy5raW5kID09PSAnYmFja2dyb3VuZCdcclxuICAgICAgICAgICAgICAgID8gZmFsc2VcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHBsYW5SZWFzb246IHBsYW4/LnJlYXNvbixcclxuICAgICAgICBjaGlsZHJlbjogdGVybWluYWxcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKSA9PiAhYWJzb3JiZWREaXJlY3RJZHMuaGFzKGNoaWxkLmlkKSlcclxuICAgICAgICAgICAgICAgIC5tYXAoKGNoaWxkKSA9PiBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZCxcclxuICAgICAgICAgICAgICAgICAgICBmcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgICAgICAgICApKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpOiBjaGlsZCBpcyBTY2VuZU5vZGVTcGVjID0+IGNoaWxkICE9PSBudWxsKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVNYXBzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2Nvc0ZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gRWRpdG9yLlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXHJcbiAgICAgICAgPyBnZW5lcmF0ZWRcclxuICAgICAgICA6IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnYmFzZTY0JykucmVwbGFjZSgvPSskL2csICcnKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJBc3NldCh1cmxPclV1aWQ6IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtaW5mbycsXHJcbiAgICAgICAgdXJsT3JVdWlkLFxyXG4gICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRQcmVmYWJBc3NldChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGluZm8uaW52YWxpZCB8fCBpbmZvLmltcG9ydGVkICE9PSB0cnVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLmltcG9ydGVyICE9PSAncHJlZmFiJyB8fCBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInIHx8IGluZm8uaXNEaXJlY3RvcnkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8ucmVhZG9ubHkgfHwgaW5mby5yZWRpcmVjdCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZC51dWlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnVybCAmJiBpbmZvLnVybCAhPT0gZXhwZWN0ZWQudXJsKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yUHJlZmFiQXNzZXQodXJsOiBzdHJpbmcsIGV4cGVjdGVkVXVpZD86IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbmZvPy5pbXBvcnRlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOWcqOWvvOWFpeacn+mXtOWPkeeUn+WPmOWMlu+8miR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIFByZWZhYiDotYTmupDlsLHnu6rotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJNZXRhKHV1aWQ6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgIHV1aWQsXHJcbiAgICApO1xyXG4gICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSBtZXRhIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBNZXRhIOS4juebruagh+i1hOa6kOS4jeWMuemFje+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVSTCDml6DmlYjvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICApO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmcsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgY3VycmVudERpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgaWYgKGN1cnJlbnREaXJ0eSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcclxuICAgIH1cclxuICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnb3Blbi1hc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgICAgICAgICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gc3RhdGUucmVhc29uID8/IGxhc3RSZWFzb247XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOaJk+W8gOebruaghyBQcmVmYWIg6LaF5pe277yaJHtsYXN0UmVhc29ufWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRPcGVuZWRQcmVmYWIocHJlZmFiVXVpZDogc3RyaW5nLCByb290RmlsZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTY2VuZVNhdmVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBkaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoIWRpcnR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCfnrYnlvoUgUHJlZmFiIOS/neWtmOWujOaIkOi2heaXtuOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQcmVmYWJCaW5kaW5ncygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCBwcmVmYWJVdWlkXSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHByZWZhYlV1aWQgIT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8ICFwcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcsIHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgaWYgKCFiaW5kaW5nc1tzb3VyY2VIYXNoXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywge1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8ICFyYXdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIChyYXcgYXMgeyBwcmVmYWJVdWlkPzogdW5rbm93biB9KS5wcmVmYWJVdWlkICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoe1xyXG4gICAgICAgICAgICB1c2VyRGF0YToge1xyXG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leadpea6kOS4jeS4gOiHtO+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IChyYXcgYXMgeyBwcmVmYWJVdWlkOiBzdHJpbmcgfSkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQZW5kaW5nUHJlZmFiU3luYyhcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHZhbHVlOiB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0gfCBudWxsLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcclxuICAgIGlmICh2YWx1ZSkge1xyXG4gICAgICAgIHBlbmRpbmdbc291cmNlSGFzaF0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbc291cmNlSGFzaF07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgIHBlbmRpbmcsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gdmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbik6IFByb21pc2U8eyBtZXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+IHtcclxuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICBsZXQgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICBpZiAoIXJlY29yZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYFByZWZhYiDnvLrlsJEgRmlnbWEg5p2l5rqQ6K6w5b2V77yM5peg5rOV56Gu6K6k5piv5ZCm5Y+v5a6J5YWo6KaG55uW77yaJHtpbmZvLnVybH3jgILor7flhYjnp7vliqjmiJbph43lkb3lkI3or6XotYTmupDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDmnaXoh6rlj6bkuIDkuKogRmlnbWEgRnJhbWXvvIzlt7Lmi5Lnu53opobnm5bvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBpZiAocGVuZGluZykge1xyXG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5qOA5rWL5Yiw5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7TnmoTlvoXmgaLlpI3lkIzmraXorrDlvZXvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcGVuZGluZy5yZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3ZlcmVkIHx8IEpTT04uc3RyaW5naWZ5KHJlY292ZXJlZCkgIT09IEpTT04uc3RyaW5naWZ5KHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVjb3JkID0gcmVjb3ZlcmVkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bkuI7lvZPliY3lj4rlvoXmgaLlpI3nmoTlkIzmraXorrDlvZXpg73kuI3kuIDoh7TvvIzlt7LlgZzmraLoh6rliqjmgaLlpI3jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBtZXRhLCByZWNvcmQgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBsZXQgbGFzdEVycm9yOiB1bmtub3duO1xyXG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0ICs9IDEpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflhpnlhaXliY0gUHJlZmFiIOadpea6kOiusOW9leS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWQjuagoemqjOS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcclxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTUwKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGxhc3RFcnJvciA6IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWksei0peOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZyxcclxuICAgIHJvb3RGcmFtZTogUmVjdCxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHNvdXJjZVJvb3RJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHtcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgY29uc3QgYm91bmRVdWlkID0gYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xyXG4gICAgICAgID8gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwZW5kaW5nLnByZWZhYlV1aWQpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgICAgICBwZW5kaW5nPy5wcmVmYWJVdWlkLFxyXG4gICAgICAgIGJvdW5kVXVpZCxcclxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcclxuICAgICk7XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhclBlbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyQmluZGluZykge1xyXG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gdGFyZ2V0UGxhbi50YXJnZXRVdWlkO1xyXG4gICAgaWYgKHRhcmdldFV1aWQpIHtcclxuICAgICAgICBsZXQgdGFyZ2V0SW5mbyA9IHBlbmRpbmdJbmZvPy51dWlkID09PSB0YXJnZXRVdWlkXHJcbiAgICAgICAgICAgID8gcGVuZGluZ0luZm9cclxuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xyXG4gICAgICAgICAgICBpZiAoYmluZGluZ3Nbc291cmNlSGFzaF0gPT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgaWYgKHBlbmRpbmc/LnByZWZhYlV1aWQgPT09IHRhcmdldFV1aWQgJiYgYm91bmRVdWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSByZWNvdmVyeSBpZGVudGl0eSBiZWZvcmUgdmVyaWZpZWRQcmVmYWJSZWNvcmQgbWF5XHJcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcclxuICAgICAgICAgICAgICAgIC8vIGFibGUgdG8gbG9jYXRlIHRoZSBleGFjdCBQcmVmYWIgYnkgVVVJRCBvbiB0aGUgbmV4dCBhdHRlbXB0LlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKHRhcmdldEluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0SW5mby51cmwgIT09IHByZWZhYlVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoY29uZmxpY3QgJiYgY29uZmxpY3QudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3ZlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mby51cmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW92ZWQgfHwgbW92ZWQudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGluZm86IHRhcmdldEluZm8sXHJcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCByb290RmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCByb290VHJhbnNmb3JtRmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXHJcbiAgICAgICAgICAgIHByZWZhYk5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnY3JlYXRlLWFzc2V0JyxcclxuICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICBzZWVkLFxyXG4gICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu6IFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgY3JlYXRlZC51dWlkKTtcclxuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcclxuICAgICAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICAgICAgc291cmNlUm9vdElkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShuZXh0TWV0YSwgbnVsbCwgMiksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgaW5mbyxcclxuICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaW5mbyxcclxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKGFyZ3M6IHtcclxuICAgIHJldmlld0lkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZztcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHNvdXJjZU5vZGVJZDogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn0pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBzb3VyY2VIYXNoID0gZmlnbWFGcmFtZVNvdXJjZUhhc2goYXJncy5maWxlS2V5LCBhcmdzLnNvdXJjZU5vZGVJZCk7XHJcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgICAgICBhcmdzLnByZWZhYlVybCxcclxuICAgICAgICBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICB4OiBhcmdzLnJvb3RGcmFtZS54ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgeTogYXJncy5yb290RnJhbWUueSAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHdpZHRoOiBhcmdzLnJvb3RGcmFtZS53aWR0aCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIGhlaWdodDogYXJncy5yb290RnJhbWUuaGVpZ2h0ICogYXJncy5zY2FsZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgYXJncy5yb290c1swXS5maWdtYUlkLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGV4aXN0aW5nTm9kZUZpbGVJZHMgPSByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyhcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQsXHJcbiAgICAgICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKGFyZ3Mucm9vdHMpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICByZXZpZXdJZDogYXJncy5yZXZpZXdJZCxcclxuICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBmaWxlS2V5OiBhcmdzLmZpbGVLZXksXHJcbiAgICAgICAgcm9vdE5hbWU6IGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICByb290RnJhbWU6IGFyZ3Mucm9vdEZyYW1lLFxyXG4gICAgICAgIHNjYWxlOiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIGV4aXN0aW5nTWFwOiB7fSxcclxuICAgICAgICBwcmVmYWJVcmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHJvb3RzOiBhcmdzLnJvb3RzLFxyXG4gICAgICAgIHByZWZhYkNvbnRleHQ6IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkOiBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgZXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZE5vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRIZWxwZXJGaWxlSWRzLFxyXG4gICAgICAgIH0sXHJcbiAgICB9O1xyXG4gICAgbGV0IHNuYXBzaG90U3RhcnRlZCA9IGZhbHNlO1xyXG4gICAgbGV0IHNhdmVBdHRlbXB0ZWQgPSBmYWxzZTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgZGlydHlCZWZvcmVJbXBvcnQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICAgICAgaWYgKGRpcnR5QmVmb3JlSW1wb3J0KSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign55uu5qCHIFByZWZhYiDmnInmnKrkv53lrZjnmoTmiYvlt6Xkv67mlLnvvIzor7flhYjkv53lrZjlkI7lho3miafooYwgRmlnbWEg5aKe6YeP5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgc25hcHNob3RTdGFydGVkID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgaWYgKCFyZXN1bHQucHJlZmFiU3luYykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXmnKrov5Tlm54gZmlsZUlkIOiusOW9le+8jOW3suWBnOatouS/neWtmOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuZXh0UmVjb3JkID0gcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUocHJlcGFyZWQucmVjb3JkLCByZXN1bHQucHJlZmFiU3luYyk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZDogbmV4dFJlY29yZCxcclxuICAgICAgICB9KTtcclxuICAgICAgICBhd2FpdCBhc3NlcnRPcGVuZWRQcmVmYWIocHJlcGFyZWQuaW5mby51dWlkLCBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgLy8gT25jZSB0aGUgc2F2ZSByZXF1ZXN0IGlzIHNlbnQgaXRzIHJlc3VsdCBpcyBhbWJpZ3VvdXMgdW50aWwgdGhlXHJcbiAgICAgICAgLy8gcGVyc2lzdGVkIFByZWZhYiBpcyB2ZXJpZmllZC4gRG8gbm90IHJvbGwgdGhlIGluLW1lbW9yeSBQcmVmYWIgYmFja1xyXG4gICAgICAgIC8vIG9uIGFuIElQQyB0aW1lb3V0OiB0aGUgZGlzayB3cml0ZSBtYXkgYWxyZWFkeSBoYXZlIGNvbXBsZXRlZC5cclxuICAgICAgICBzYXZlQXR0ZW1wdGVkID0gdHJ1ZTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclNjZW5lU2F2ZWQoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCwgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoY3VycmVudEluZm8sIG5leHRSZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuacquWMheWQq+acrOasoeWQjOatpeeUn+aIkOeahOWFqOmDqCBmaWxlSWTvvIzlt7LlgZzmraLmm7TmlrAgTWV0YeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXJyZW50TWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShjdXJyZW50SW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50UmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoY3VycmVudE1ldGEpO1xyXG4gICAgICAgIGlmICghY3VycmVudFJlY29yZCB8fCBjdXJyZW50UmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5Zyo5L+d5a2Y5pyf6Ze05Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5o+Q5Lqk44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoY3VycmVudEluZm8sIHNvdXJjZUhhc2gsIG5leHRSZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCk7XHJcbiAgICAgICAgaWYgKCF2ZXJpZmllZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjiBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQodmVyaWZpZWQsIHtcclxuICAgICAgICAgICAgdXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICB1cmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlc3VsdC5wcmVmYWJVcmwgPSBwcmVwYXJlZC5pbmZvLnVybDtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLmNsZWFyKCdub2RlJyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBpZiAoc25hcHNob3RTdGFydGVkICYmICFzYXZlQXR0ZW1wdGVkKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90LWFib3J0JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1JbXBvcnQocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGlmICghZG9jdW1lbnQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+WFiOivu+WPliBGaWdtYSDmlofku7bjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGltcG9ydFNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKG9wZXJhdGlvbk93bmVyKTtcclxuICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCflr7zlhaXku7vliqEnLCB7IHJvb3RzOiBkb2N1bWVudC5yb290cy5tYXAoKG5vZGUpID0+ICh7IGlkOiBub2RlLmlkLCBuYW1lOiBub2RlLm5hbWUgfSkpIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfliIbmnpDlubblh4blpIfotYTmupDigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKHJlcXVlc3Qub3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCByZXZpZXdEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZSgpO1xyXG4gICAgICAgIGNvbnN0IHJldmlld1JlY29yZGVyID0gbmV3IEltcG9ydFJldmlld1JlY29yZGVyKCk7XHJcbiAgICAgICAgY29uc3QgYnVpbHRBc3NldHMgPSBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5YWo6YOo6LWE5rqQJywgdW5kZWZpbmVkLCAoKSA9PiBidWlsZEFzc2V0cyhkb2N1bWVudCwgZGVjaXNpb25zLCBpbXBvcnRTZXR0aW5ncywgcmV2aWV3UmVjb3JkZXIpKTtcclxuICAgICAgICBjb25zdCB7IGFzc2V0cywgd2FybmluZ3MgfSA9IGJ1aWx0QXNzZXRzO1xyXG4gICAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICBjb25zdCBhdHRhY2hSZXZpZXcgPSBhc3luYyAocmVzdWx0OiBTY2VuZUltcG9ydFJlc3VsdCkgPT4ge1xyXG4gICAgICAgICAgICByZXN1bHQucmV2aWV3ID0gYXdhaXQgZmluYWxpemVJbXBvcnRSZXZpZXcoaW1wb3J0UmV2aWV3cywgcmV2aWV3UmVjb3JkZXIsIHJldmlld0RvY3VtZW50LFxyXG4gICAgICAgICAgICAgICAgcmVzdWx0LnJldmlld0JlZm9yZSwgcmVzdWx0LnJldmlld0FmdGVyLCByZXN1bHQucHJlZmFiVXJsLCB3YXJuaW5ncyxcclxuICAgICAgICAgICAgICAgIGFzeW5jICgpID0+IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsIG1ldGhvZDogJ3JlZnJlc2hSZXZpZXdBZnRlcicsIGFyZ3M6IFt7IGlkOiByZXZpZXdSZWNvcmRlci5pZCB9XSxcclxuICAgICAgICAgICAgICAgIH0pIGFzIFJldmlld1NjZW5lKTtcclxuICAgICAgICAgICAgLy8gQWxzbyBjb3ZlciBtYW51YWwgaW1wb3J0cyB3aG9zZSBwYW5lbCB3YXMgY2xvc2VkIHdoaWxlIGltcG9ydGluZy5cclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAnaW1wb3J0LXJldmlldy1yZWFkeScsIHJlc3VsdC5yZXZpZXcpO1xyXG4gICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MucHVzaChg57uT5p6c5bey5L+d5a2Y77yM5L2G6Ieq5Yqo5omT5byA6Z2i5p2/5aSx6LSl77yM6K+35LuO5o+S5Lu25Lit5omT5byA4oCc5a+85YWl57uT5p6c5qOA5p+l4oCd77yaJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdCZWZvcmU7XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QWZ0ZXI7XHJcbiAgICAgICAgfTtcclxuICAgICAgICAvLyBidWlsZEFzc2V0cyBtYXkgcHJvbW90ZSBhIGNvbnRhaW5lciB0byBhIGxvY2FsIHNhbWUtbmFtZSByZXNvdXJjZS5cclxuICAgICAgICAvLyBDb21waWxlIGFmdGVyIHRoYXQgcHJvbW90aW9uIHNvIGFzc2V0cyBhbmQgU2NlbmVOb2RlU3BlYyBzaGFyZSB0aGVcclxuICAgICAgICAvLyBleGFjdCBzYW1lIGZpbmFsIHBsYW4uXHJcbiAgICAgICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihkb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCBmb250cyA9IGF3YWl0IHJlc29sdmVGb250cyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlUm9vdEZyYW1lcyA9IGRvY3VtZW50LnJvb3RzLm1hcChub2RlRnJhbWUpO1xyXG4gICAgICAgIGNvbnN0IG11bHRpcGxlUm9vdHMgPSBkb2N1bWVudC5yb290cy5sZW5ndGggPiAxO1xyXG4gICAgICAgIGNvbnN0IGFycmFuZ2VkV2lkdGggPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8gc291cmNlUm9vdEZyYW1lcy5yZWR1Y2UoKHRvdGFsLCBmcmFtZSkgPT4gdG90YWwgKyBmcmFtZS53aWR0aCwgMClcclxuICAgICAgICAgICAgICAgICsgTWF0aC5tYXgoMCwgc291cmNlUm9vdEZyYW1lcy5sZW5ndGggLSAxKSAqIDE2MFxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0/LndpZHRoID8/IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZyYW1lID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHg6IDAsXHJcbiAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGFycmFuZ2VkV2lkdGgsXHJcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IE1hdGgubWF4KDAsIC4uLnNvdXJjZVJvb3RGcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KSksXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdID8/IHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgICAgIGxldCByb290Q3Vyc29yID0gMDtcclxuICAgICAgICBjb25zdCByb290cyA9IGRvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgICAgIC5tYXAoKG5vZGUsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzcGVjID0gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50Lm5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjICYmIG11bHRpcGxlUm9vdHMpIHtcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmZyYW1lID0ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB4OiByb290Q3Vyc29yLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0uaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEN1cnNvciArPSBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCArIDE2MDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBzcGVjO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuZmlsdGVyKChub2RlKTogbm9kZSBpcyBTY2VuZU5vZGVTcGVjID0+IG5vZGUgIT09IG51bGwpO1xyXG4gICAgICAgIGlmICghcm9vdHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ6YCJ5Lit5Lu75L2V5Y+v5a+85YWl6IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBzb3VyY2VOb2RlSWQgPSBkb2N1bWVudC5zb3VyY2VOb2RlSWQ7XHJcbiAgICAgICAgaWYgKHNvdXJjZU5vZGVJZCAmJiByb290cy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiV3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLnByZWZhYkZvbGRlcik7XHJcbiAgICAgICAgICAgIGF3YWl0IHByZWZhYldyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lTmFtZSA9IHJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGRvY3VtZW50LnJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJVcmwgPSBgZGI6Ly9hc3NldHMvJHtwcmVmYWJXcml0ZXIuZm9sZGVyfS8ke3Nhbml0aXplQXNzZXROYW1lKGZyYW1lTmFtZSl9LnByZWZhYmA7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ3NjZW5lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAwLjA1LFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ+ato+WcqOWIm+W7uuaIluaJk+W8gOebruaghyBQcmVmYWLigKYnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoe1xyXG4gICAgICAgICAgICAgICAgcmV2aWV3SWQ6IHJldmlld1JlY29yZGVyLmlkLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiTmFtZTogZnJhbWVOYW1lLFxyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZU5vZGVJZCxcclxuICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgICAgICAvLyBQcmVmYWIgdXBkYXRlcyBwZXJzaXN0IGJ5IFByZWZhYkluZm8uZmlsZUlkIGluIHRoZSBhc3NldCBtZXRhO1xyXG4gICAgICAgICAgICAvLyBydW50aW1lIG5vZGUgVVVJRHMgYXJlIHNlc3Npb24tb25seSBhbmQgbXVzdCBuZXZlciBiZSByZXVzZWQgaGVyZS5cclxuICAgICAgICAgICAgZGVsZXRlIG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcclxuICAgICAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH3vvIzlt7LmiZPlvIDpooTliLbkvZMgJHtwcmVmYWJVcmx9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLpgIDogJyd9YCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIHJvb3ROYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbXBvcnRTZXR0aW5ncy51cGRhdGVFeGlzdGluZyxcclxuICAgICAgICAgICAgZXhpc3RpbmdNYXA6IG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID8/IHt9LFxyXG4gICAgICAgICAgICByb290cyxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMC4xLCBtZXNzYWdlOiAn5q2j5Zyo5p6E5bu6IENvY29zIOiKgueCueagkeKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPSByZXN1bHQubm9kZU1hcDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdub2RlJywgcmVzdWx0LnJvb3RVdWlkKTtcclxuICAgICAgICBpZiAoaW1wb3J0U2V0dGluZ3MuYXV0b1NhdmUpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcclxuICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLpgIDogJyd9YCxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0cmFjZS5kb25lKCk7XHJcbiAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBDYW5jZWxsZWRFcnJvciB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnY2FuY2VsbGVkJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflt7Llj5bmtojjgIInIH0pO1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aTjeS9nOW3suWPlua2iOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgicsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB0cmFjZS5ldmVudCgn5ZCO5Y+w5Lu75Yqh5bey6YeK5pS+Jyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE1jcFBsdWdpblN0YXRlKCkge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgdmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICB2YXVsdDogdmF1bHQuc3RhdHVzKCksXHJcbiAgICAgICAgc2V0dGluZ3M6IGF3YWl0IGdldFNldHRpbmdzKCksXHJcbiAgICAgICAgZG9jdW1lbnQ6IGRvY3VtZW50ID8ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLFxyXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgIG5vZGVPdmVycmlkZXM6IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSksXHJcbiAgICAgICAgfSA6IG51bGwsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQbHVnaW5TdGF0ZSgpIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgLi4uYXdhaXQgZ2V0TWNwUGx1Z2luU3RhdGUoKSxcclxuICAgICAgICBmb250QXNzZXRzOiBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjE1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+WIEZpZ21hIOaWh+S7tuKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IHBhcnNlZC5ub2RlSWRcclxuICAgICAgICAgICAgPyBhd2FpdCBhcGkuZ2V0Tm9kZShwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZClcclxuICAgICAgICAgICAgOiBhd2FpdCBhcGkuZ2V0RmlsZShwYXJzZWQuZmlsZUtleSk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhbm5vdGF0ZURvY3VtZW50UGxhbihcclxuICAgICAgICAgICAgcGFyc2VEb2N1bWVudChwYXlsb2FkLCBzb3VyY2VVcmwsIHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBnZXRTZXR0aW5ncygpO1xyXG4gICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyh7IC4uLmN1cnJlbnQsIHNvdXJjZVVybCB9KTtcclxuICAgICAgICBjb25zdCBmb250QXNzZXRzID0gYXdhaXQgbGlzdEZvbnRBc3NldHMoKTtcclxuICAgICAgICBjb25zdCBub2RlT3ZlcnJpZGVzID0gYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KTtcclxuICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2lkbGUnLCB2YWx1ZTogMSwgbWVzc2FnZTogYOW3suivu+WPliAke2RvY3VtZW50LmZpbGVOYW1lfWAgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgZm9udEFzc2V0cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlcyxcclxuICAgICAgICB9O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZVByZXZpZXcobm9kZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgdXJsOiBzdHJpbmcgfT4ge1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGNvbnN0IG5vZGUgPSBkb2N1bWVudD8ubm9kZUJ5SWQuZ2V0KG5vZGVJZCk7XHJcbiAgICBpZiAoIWRvY3VtZW50IHx8ICFub2RlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfpooTop4joioLngrnkuI3lrZjlnKjjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgW25vZGVJZF0sXHJcbiAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAxLFxyXG4gICAgICAgICAgICAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGlmICghdXJsc1tub2RlSWRdKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV55Sf5oiQ6IqC54K56aKE6KeI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IHVybDogdXJsc1tub2RlSWRdIH07XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IFJlY29yZDxzdHJpbmcsICguLi5hcmdzOiBhbnlbXSkgPT4gYW55PiA9IHtcclxuICAgIGdldEltcG9ydFJldmlldygpIHsgcmV0dXJuIGltcG9ydFJldmlld3MuZ2V0KCk7IH0sXHJcbiAgICBhc3luYyBnZXRJbXBvcnRSZXZpZXdQcmV2aWV3KGlkOiBzdHJpbmcsIGFzc2V0SWQ6IHN0cmluZykgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5wcmV2aWV3KGlkLCBhc3NldElkKTsgfSxcclxuICAgIGFzeW5jIGFwcGx5SW1wb3J0UmV2aWV3KGlkOiBzdHJpbmcsIHJlbW92ZWRJZHM6IHVua25vd24pIHtcclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3lr7zlhaXmiJYgRmlnbWEg6aKE6KeI5a6M5oiQ44CCJyk7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSB0cnVlO1xyXG4gICAgICAgIHRyeSB7IHJldHVybiBhd2FpdCBpbXBvcnRSZXZpZXdzLmFwcGx5KGlkLCByZW1vdmVkSWRzKTsgfVxyXG4gICAgICAgIGZpbmFsbHkgeyBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlOyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxuICAgIH0sXHJcbiAgICBhc3luYyBnZXRJbXBvcnRSZXZpZXdTb3VyY2VQcmV2aWV3KGlkOiBzdHJpbmcsIGFzc2V0SWQ6IHN0cmluZywgbm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3mk43kvZzlrozmiJDlkI7lho3liqDovb3mnaXmupDpooTop4jjgIInKTtcclxuICAgICAgICBjb25zdCB7IGZpbGVLZXksIG5vZGUgfSA9IGltcG9ydFJldmlld3Muc291cmNlKGlkLCBhc3NldElkLCBub2RlSWQpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudCgpO1xyXG4gICAgICAgICAgICBjb25zdCBpbWFnZVJlZiA9IHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZmlsbHMgPSBhd2FpdCBhcGkuZ2V0SW1hZ2VGaWxsVXJscyhmaWxlS2V5KTtcclxuICAgICAgICAgICAgICAgIGlmIChmaWxsc1tpbWFnZVJlZl0pIHJldHVybiB7IHVybDogZmlsbHNbaW1hZ2VSZWZdLCBub3RlOiAnRmlnbWEg5Y6f5Zu+77yI5pyq5ZCI5oiQ6IqC54K55pWI5p6c77yJJyB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCBhcGkuZ2V0SW1hZ2VVcmxzKGZpbGVLZXksIFtub2RlLmlkXSwgJ3BuZycsIDEsICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpKTtcclxuICAgICAgICAgICAgaWYgKCF1cmxzW25vZGUuaWRdKSB0aHJvdyBuZXcgRXJyb3IoJ0ZpZ21hIOacqui/lOWbnumihOiniO+8jOmakOiXj+aIluWkjeadguaViOaenOiKgueCueWPr+iDveaXoOazleWNleeLrOa4suafk+OAgicpO1xyXG4gICAgICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZS5pZF0sIG5vdGU6ICdGaWdtYSDlvZPliY3oioLngrnmuLLmn5PvvIjpmpDol4/npZblhYjlj6/og73kvb/pooTop4jpgI/mmI7vvIknIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgb3BlblBhbmVsKCkge1xyXG4gICAgICAgIEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRTdGF0ZSgpIHtcclxuICAgICAgICByZXR1cm4gZ2V0UGx1Z2luU3RhdGUoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2V0VG9rZW4odmFsdWU6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiB2YXVsdC5zZXQodmFsdWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBjbGVhclRva2VuKCkge1xyXG4gICAgICAgIHJldHVybiB2YXVsdC5jbGVhcigpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyB2ZXJpZnlUb2tlbigpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpZGVudGl0eSA9IGF3YWl0IChhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpKS52ZXJpZnkoKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG9rOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgaGFuZGxlOiBpZGVudGl0eS5oYW5kbGUgfHwgJ0ZpZ21hIFVzZXInLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQ2FjaGVGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZmV0Y2hEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIHJldHVybiBnZXROb2RlUHJldmlldyhub2RlSWQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBEZXRlY3Qoc291cmNlVXJsOiBzdHJpbmcsIGV4cGxpY2l0Um9vdElkPzogc3RyaW5nKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkuZGV0ZWN0KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFByZXZpZXcoc291cmNlVXJsOiBzdHJpbmcsIGV4cGxpY2l0Um9vdElkPzogc3RyaW5nKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkucHJldmlldyhzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQYWlyKHBhaXJUb2tlbjogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcikgdGhyb3cgbmV3IEVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkucGFpcihwYWlyVG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcEFwcGx5KHByZXZpZXdUb2tlbjogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcikgdGhyb3cgbmV3IEVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luUm91bmR0cmlwT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IChhd2FpdCByb3VuZHRyaXBTZXJ2aWNlKGNvbnRyb2xsZXIuc2lnbmFsKSkuYXBwbHkocHJldmlld1Rva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICByb3VuZHRyaXBDYW5jZWwoKSB7XHJcbiAgICAgICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgaW1wb3J0U2VsZWN0aW9uKHJlcXVlc3Q6IEltcG9ydFJlcXVlc3QpIHtcclxuICAgICAgICByZXR1cm4gcGVyZm9ybUltcG9ydChyZXF1ZXN0KTtcclxuICAgIH0sXHJcblxyXG4gICAgY2FuY2VsSW1wb3J0KCkge1xyXG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG59O1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gc3RhcnRNY3BCcmlkZ2UoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBwcmV2aW91cyA9IG1jcEJyaWRnZTtcclxuICAgIG1jcEJyaWRnZSA9IG51bGw7XHJcbiAgICBtY3BBcGkgPSBudWxsO1xyXG4gICAgaWYgKHByZXZpb3VzKSBhd2FpdCBwcmV2aW91cy5jbG9zZSgpO1xyXG5cclxuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XHJcbiAgICBjb25zdCBhcGkgPSBuZXcgRmlnbWFJbXBvcnRlck1jcEFwaSh7XHJcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgY3JlYXRvclZlcnNpb24sXHJcbiAgICAgICAgZ2V0RG9jdW1lbnRSZXZpc2lvbjogKCkgPT4gZG9jdW1lbnRSZXZpc2lvbixcclxuICAgICAgICBpc0ltcG9ydEJ1c3k6ICgpID0+IGFjdGl2ZUNvbnRyb2xsZXIgIT09IG51bGwsXHJcbiAgICAgICAgZ2V0U3RhdGU6IGdldE1jcFBsdWdpblN0YXRlLFxyXG4gICAgICAgIGZldGNoRG9jdW1lbnQ6IGZldGNoRmlnbWFEb2N1bWVudCxcclxuICAgICAgICBnZXRQcmV2aWV3OiBnZXROb2RlUHJldmlldyxcclxuICAgICAgICBzYXZlU2V0dGluZ3MsXHJcbiAgICAgICAgcGF0Y2hTZXR0aW5ncyxcclxuICAgICAgICBzYXZlTm9kZU92ZXJyaWRlcyxcclxuICAgICAgICBwYXRjaE5vZGVOYW1lcyxcclxuICAgICAgICBpbXBvcnRTZWxlY3Rpb246IChyZXF1ZXN0LCBvcGVyYXRpb25JZCkgPT4gcGVyZm9ybUltcG9ydChyZXF1ZXN0LCBvcGVyYXRpb25JZCksXHJcbiAgICAgICAgY2FuY2VsSW1wb3J0OiAob3BlcmF0aW9uSWQpID0+IHtcclxuICAgICAgICAgICAgaWYgKCFhY3RpdmVDb250cm9sbGVyIHx8IGFjdGl2ZU9wZXJhdGlvbk93bmVyICE9PSBvcGVyYXRpb25JZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBhY3RpdmVDb250cm9sbGVyLmFib3J0KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG5ldyBNY3BCcmlkZ2VTZXJ2ZXIoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIHBsdWdpblZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgcGx1Z2luSW5zdGFuY2VJZCxcclxuICAgICAgICBpbnZva2U6IChtZXRob2QsIHBhcmFtcywgc2lnbmFsKSA9PiBhcGkuaW52b2tlKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpLFxyXG4gICAgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5zdGFydCgpO1xyXG4gICAgICAgIG1jcEFwaSA9IGFwaTtcclxuICAgICAgICBtY3BCcmlkZ2UgPSBicmlkZ2U7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGF3YWl0IGJyaWRnZS5jbG9zZSgpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlkK/liqjlpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMoRWRpdG9yLlByb2plY3QucGF0aCwgZWRpdG9yUmVpbXBvcnRlcik7XHJcbiAgICAgICAgY29uc3QgYWN0aXZlID0gcmVjb3ZlcmVkLmZpbHRlcigocmVzdWx0KSA9PiByZXN1bHQuc3RhdHVzID09PSAnYWN0aXZlLW93bmVyJyk7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDmo4DmtYvliLAgJHthY3RpdmUubGVuZ3RofSDkuKrku43nlLHmtLvliqjov5vnqIvmjIHmnInnmoQgUm91bmQtdHJpcCDkuovliqHvvIzmmoLml7bnpoHmraIgUGFpci9BcHBseeOAgmBcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBgUm91bmQtdHJpcCDlkK/liqjmgaLlpI3lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGFydE1jcEJyaWRnZSgpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCk6IHZvaWQge1xyXG4gICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xyXG4gICAgYWN0aXZlRG9jdW1lbnQgPSBudWxsO1xyXG4gICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgY29uc3QgYnJpZGdlID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICB2b2lkIGJyaWRnZT8uY2xvc2UoKS5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBGaWdtYSBJbXBvcnRlciBNQ1AgQnJpZGdlIOWFs+mXreWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gKTtcclxuICAgIH0pO1xyXG59XHJcbiJdfQ==