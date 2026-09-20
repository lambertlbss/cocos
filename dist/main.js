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
const slicing_1 = require("./figma/slicing");
const url_1 = require("./figma/url");
const import_actions_1 = require("./import-actions");
const assets_1 = require("./importer/assets");
const cache_1 = require("./importer/cache");
const local_resources_1 = require("./importer/local-resources");
const svg_1 = require("./importer/svg");
const sliced_png_1 = require("./importer/sliced-png");
const tiled_png_1 = require("./importer/tiled-png");
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
function collectAssetRequests(roots, decisions) {
    const png = [];
    const tiled = [];
    const rawImages = [];
    const gradients = [];
    const visit = (node, ancestorsVisible) => {
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
            const source = (0, analyzer_1.nativeTiledPaintSource)(node);
            if (source) {
                tiled.push({ node, source });
            }
            else {
                const imageRef = effectivelyVisible ? undefined : (0, analyzer_1.plainImageSourceRef)(node);
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
    var _a;
    const writer = new assets_1.AssetWriter(importSettings.assetFolder, (url, existed) => review.beforeWrite(url, existed));
    await writer.initialize();
    const cache = new cache_1.LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new local_resources_1.LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    const promoteLocalParents = async (node) => {
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
            && !(0, analyzer_1.hasHiddenDescendant)(node)) {
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
    const assets = new Map();
    const warnings = new Set();
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
                existingAsset = await writer.existingRaster(writer.buildTiledUrl(group.node.name, group.assetKey, 'png'), true);
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
            completeGroup(item.nodes, (0, tiled_png_1.pixelSizedTileAsset)(await writer.write(url, raster.contents, undefined, true)), item.sourceType);
            trace.done({ sourceWidth: raster.sourceWidth, sourceHeight: raster.sourceHeight,
                width: raster.width, height: raster.height, tileScale: 1 });
        }
    };
    const processRemote = async (nodes) => {
        var _a, _b, _c, _d;
        if (!nodes.length) {
            return;
        }
        const format = 'png';
        const groups = new Map();
        for (const node of nodes) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}`, format, importSettings.scale);
            const key = url.normalize('NFKC').toLocaleLowerCase('en-US');
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
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, format);
                if (localMatch) {
                    break;
                }
            }
            // Project-local SpriteFrames own their pixels and slice borders.
            // Reuse their UUID before any slice analysis, compaction or refresh.
            const localUrl = localMatch
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                reuseAsset(localAsset, 'local');
                continue;
            }
            if (localUrl) {
                throw new Error(`同名本地资源尚无可用 SpriteFrame，请先在 Cocos 中完成资源导入并设置为 SpriteFrame 后重试，不会另建副本：${localUrl}`);
            }
            const existing = !importSettings.refreshAssets ? await writer.existingRaster(url, false, node.name) : null;
            if (!localMatch && existing && (decision.nineSlice || !overflowingRenderFrame(node))) {
                reuseAsset(existing, 'existing');
                continue;
            }
            const sliceAnalysis = decision.nineSlice && format === 'png'
                ? (0, slicing_1.analyzeSliceGrid)(node)
                : null;
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
            let asset;
            if (item.sliceAnalysis) {
                const trace = (0, diagnostics_1.diagnosticStart)('三/九宫资源最小化', { node: item.node.name });
                const result = await (0, sliced_png_1.writeSlicedPng)(writer, item.url, contents, item.node, item.sliceAnalysis, importSettings.scale);
                asset = result.asset;
                trace.done(result.optimization);
            }
            else {
                asset = await writer.write(item.url, contents, item.borders);
            }
            if (asset.sliceFallback) {
                warnings.add(`三/九宫节点“${item.node.name}”切片设置失败，已临时作为 PNG 整层导入：${asset.sliceFallback}`);
            }
            for (const groupedNode of item.nodes) {
                completeAsset(groupedNode, item.renderFrame
                    ? { ...asset, renderFrame: (_d = overflowingRenderFrame(groupedNode)) !== null && _d !== void 0 ? _d : item.renderFrame }
                    : asset, item.source);
            }
        }
    };
    const processRawImages = async (items) => {
        var _a;
        if (!items.length)
            return;
        const groups = new Map();
        for (const item of items) {
            const key = `${item.node.name.normalize('NFKC').toLocaleLowerCase('en-US')}\0${item.imageRef}`;
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { node: item.node, nodes: [], imageRef: item.imageRef };
            group.nodes.push(item.node);
            groups.set(key, group);
        }
        let imageFillUrlsPromise;
        const downloads = new Map();
        for (const group of groups.values()) {
            if (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)
                throw new client_1.CancelledError();
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
            const url = writer.buildUrl(group.node.name, `${session.fileKey}:image-ref:${group.imageRef}`, extension, 1);
            const asset = await writer.write(url, contents);
            for (const node of group.nodes)
                completeAsset(node, asset, source);
        }
    };
    await (0, diagnostics_1.diagnosticTask)('准备平铺资源', { count: requests.tiled.length }, () => processTiled(requests.tiled));
    await (0, diagnostics_1.diagnosticTask)('准备 PNG 资源', { count: requests.png.length }, () => processRemote(requests.png));
    // Run after whole-node renders so a correct visibility-independent source
    // image wins if both paths share the same legacy asset filename.
    await (0, diagnostics_1.diagnosticTask)('准备隐藏图片资源', { count: requests.rawImages.length }, () => processRawImages(requests.rawImages));
    const gradientAssets = new Map();
    for (const node of requests.gradients) {
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const png = frame && fill
            ? (0, svg_1.gradientPng)(frame.width, frame.height, fill, cornerRadii(node), importSettings.scale)
            : null;
        if (png) {
            const url = writer.buildUrl(node.name, `${session.fileKey}:${node.id}:gradient`, 'png', importSettings.scale);
            const gradientKey = url.normalize('NFKC').toLocaleLowerCase('en-US');
            const firstAsset = gradientAssets.get(gradientKey);
            const existing = firstAsset || importSettings.refreshAssets
                ? null
                : await writer.existingRaster(url);
            const asset = (_a = firstAsset !== null && firstAsset !== void 0 ? firstAsset : existing) !== null && _a !== void 0 ? _a : await writer.write(url, png);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXFkQSx3REFnQkM7QUE4QkQsa0NBeUJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBK0RELGtDQWloQkM7QUF3Q0QsNEJBc0dDO0FBMi9CRCxvQkFhQztBQUVELHdCQVlDO0FBNzVFRCwrQkFBOEU7QUFDOUUsMkJBQWdDO0FBQ2hDLG1DQUFxQztBQUNyQywrQ0FBZ0U7QUFDaEUsMENBQWdEO0FBQ2hELG1FQUEwQztBQUMxQywyQ0FBOEU7QUFDOUUsK0NBVTBCO0FBQzFCLDJDQUErQztBQUMvQywyREFHZ0M7QUFDaEMsNkNBQXVFO0FBQ3ZFLHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHNEQUF1RDtBQUN2RCxvREFBMEY7QUFDMUYsd0RBWWdDO0FBQ2hDLHdEQUFvRDtBQUNwRCx1Q0FBdUU7QUFDdkUsZ0RBQXNEO0FBQ3RELGlEQUF1RDtBQUN2RCxtREFBc0U7QUFDdEUseURBQTJEO0FBQzNELG1DQW1CaUI7QUFDakIsMkNBQStDO0FBQy9DLDREQUFxRjtBQUNyRiw4RUFBeUU7QUFHekUsTUFBTSxLQUFLLEdBQUcsSUFBSSx3QkFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsTUFBTSxhQUFhLEdBQUcsSUFBSSxtQ0FBbUIsRUFBRSxDQUFDO0FBQ2hELElBQUksb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0FBQ2pDLElBQUksY0FBYyxHQUEyQixJQUFJLENBQUM7QUFDbEQsSUFBSSxnQkFBZ0IsR0FBMkIsSUFBSSxDQUFDO0FBQ3BELElBQUksb0JBQW9CLEdBQWtCLElBQUksQ0FBQztBQUMvQyxJQUFJLG1CQUFtQixHQUEyQixJQUFJLENBQUM7QUFDdkQsSUFBSSxhQUFhLEdBQTBCLElBQUks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QU0sR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBaUIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JGLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDakIsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUMvQyxDQUFDO0lBQ0QsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN4RSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUMxRSxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO0FBQzFELENBQUM7QUFF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LENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIgfSBmcm9tICdmcy9wcm9taXNlcyc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcclxuaW1wb3J0IHtcclxuICAgIGhhc0hpZGRlbkRlc2NlbmRhbnQsXHJcbiAgICBpbmZlckFjdGlvbixcclxuICAgIGluZmVyQ29jb3NMYXlvdXRNb2RlLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcclxuICAgIGlzVmVjdG9yTm9kZSxcclxuICAgIG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2UsXHJcbiAgICBwbGFpbkltYWdlU291cmNlUmVmLFxyXG4gICAgdHlwZSBUaWxlZFBhaW50U291cmNlLFxyXG59IGZyb20gJy4vZmlnbWEvYW5hbHl6ZXInO1xyXG5pbXBvcnQgeyBwYXJzZURvY3VtZW50IH0gZnJvbSAnLi9maWdtYS9wYXJzZXInO1xyXG5pbXBvcnQge1xyXG4gICAgYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4sXHJcbiAgICBjb21waWxlSW1wb3J0UGxhbixcclxufSBmcm9tICcuL2ZpZ21hL2ltcG9ydC1wbGFubmVyJztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCwgdHlwZSBTbGljZUFuYWx5c2lzIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgQXNzZXRXcml0ZXIsXHJcbiAgICBSQVNURVJfSU1BR0VfRVhURU5TSU9OUyxcclxuICAgIGRldGVjdEltYWdlRXh0ZW5zaW9uLFxyXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcclxuICAgIHNhbml0aXplQXNzZXROYW1lLFxyXG4gICAgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbixcclxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB7IExvY2FsQXNzZXRDYWNoZSwgdHlwZSBDYWNoZUVudHJ5S2V5IH0gZnJvbSAnLi9pbXBvcnRlci9jYWNoZSc7XHJcbmltcG9ydCB0eXBlIHsgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBncmFkaWVudFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc3ZnJztcclxuaW1wb3J0IHsgd3JpdGVTbGljZWRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3NsaWNlZC1wbmcnO1xyXG5pbXBvcnQgeyBwaXhlbFNpemVkVGlsZUFzc2V0LCByYXN0ZXJpemVUaWxlLCB0aWxlZFJhc3RlcktleSB9IGZyb20gJy4vaW1wb3J0ZXIvdGlsZWQtcG5nJztcclxuaW1wb3J0IHtcclxuICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyxcclxuICAgIGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uLFxyXG4gICAgY3JlYXRlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIGZpZ21hRnJhbWVTb3VyY2VIYXNoLFxyXG4gICAgbWVyZ2VQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxyXG4gICAgcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZCxcclxuICAgIHJlYWRQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXHJcbiAgICByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgIHR5cGUgUHJlZmFiU3luY1JlY29yZCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcclxuaW1wb3J0IHsgVG9rZW5WYXVsdCB9IGZyb20gJy4vc2VjdXJpdHkvdG9rZW4tdmF1bHQnO1xyXG5pbXBvcnQgeyBGaWdtYUltcG9ydGVyTWNwQXBpLCB0eXBlIE1jcE5vZGVOYW1lUGF0Y2ggfSBmcm9tICcuL21jcC1hcGknO1xyXG5pbXBvcnQgeyBNY3BCcmlkZ2VTZXJ2ZXIgfSBmcm9tICcuL21jcC1icmlkZ2Uvc2VydmVyJztcclxuaW1wb3J0IHsgUm91bmR0cmlwU2VydmljZSB9IGZyb20gJy4vcm91bmR0cmlwL3NlcnZpY2UnO1xyXG5pbXBvcnQgeyByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMgfSBmcm9tICcuL3JvdW5kdHJpcC9yZWNvdmVyeSc7XHJcbmltcG9ydCB7IGVkaXRvclJlaW1wb3J0ZXIgfSBmcm9tICcuL3JvdW5kdHJpcC90cmFuc2FjdGlvbic7XHJcbmltcG9ydCB7XHJcbiAgICBERUZBVUxUX1NFVFRJTkdTLFxyXG4gICAgdHlwZSBEb2N1bWVudFNlc3Npb24sXHJcbiAgICB0eXBlIEZpZ21hTm9kZSxcclxuICAgIHR5cGUgSW1wb3J0QWN0aW9uLFxyXG4gICAgdHlwZSBJbXBvcnREZWNpc2lvbixcclxuICAgIHR5cGUgSW1wb3J0T3ZlcnJpZGUsXHJcbiAgICB0eXBlIEltcG9ydFJlcXVlc3QsXHJcbiAgICB0eXBlIEltcG9ydFNldHRpbmdzLFxyXG4gICAgdHlwZSBOb2RlS2luZCxcclxuICAgIHR5cGUgTm9kZUltcG9ydFBsYW4sXHJcbiAgICB0eXBlIFByZWZhYkVkaXRpbmdTdGF0ZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZSxcclxuICAgIHR5cGUgUHJlZmFiU2NlbmVTeW5jQ29udGV4dCxcclxuICAgIHR5cGUgUHJvZ3Jlc3NFdmVudCxcclxuICAgIHR5cGUgUmVjdCxcclxuICAgIHR5cGUgU2NlbmVOb2RlU3BlYyxcclxuICAgIHR5cGUgU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgdHlwZSBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UmVjb3JkZXIsIEltcG9ydFJldmlld1NlcnZpY2UgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBmaW5hbGl6ZUltcG9ydFJldmlldyB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldy1maW5hbGl6ZSc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3LCBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcblxyXG5jb25zdCB2YXVsdCA9IG5ldyBUb2tlblZhdWx0KHBhY2thZ2VKU09OLm5hbWUpO1xyXG5jb25zdCBpbXBvcnRSZXZpZXdzID0gbmV3IEltcG9ydFJldmlld1NlcnZpY2UoKTtcclxubGV0IGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gZmFsc2U7XHJcbmxldCBhY3RpdmVEb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZU9wZXJhdGlvbk93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgc2V0dGluZ3NDYWNoZTogSW1wb3J0U2V0dGluZ3MgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCBkb2N1bWVudFJldmlzaW9uID0gMDtcclxubGV0IG1jcEJyaWRnZTogTWNwQnJpZGdlU2VydmVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBtY3BBcGk6IEZpZ21hSW1wb3J0ZXJNY3BBcGkgfCBudWxsID0gbnVsbDtcclxuY29uc3QgcGx1Z2luSW5zdGFuY2VJZCA9IHJhbmRvbUJ5dGVzKDE4KS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbmxldCBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCBzZXR0aW5nc1dyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuXHJcbnR5cGUgRGVjaXNpb24gPSBJbXBvcnREZWNpc2lvbjtcclxuXHJcbmludGVyZmFjZSBUaWxlZEFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSYXdJbWFnZUFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBpbWFnZVJlZjogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHJldmlld0lkPzogc3RyaW5nO1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJldmlld0JlZm9yZT86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3QWZ0ZXI/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlldz86IEltcG9ydFJldmlldztcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxuICAgIHdhcm5pbmdzPzogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBBc3NldEJ1aWxkUmVzdWx0IHtcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPjtcclxuICAgIHdhcm5pbmdzOiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFByZWZhYkFzc2V0SW5mbyB7XHJcbiAgICB1dWlkOiBzdHJpbmc7XHJcbiAgICB1cmw6IHN0cmluZztcclxuICAgIGltcG9ydGVyOiBzdHJpbmc7XHJcbiAgICB0eXBlOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlZDogYm9vbGVhbjtcclxuICAgIGludmFsaWQ6IGJvb2xlYW47XHJcbiAgICBpc0RpcmVjdG9yeT86IGJvb2xlYW47XHJcbiAgICByZWFkb25seT86IGJvb2xlYW47XHJcbiAgICByZWRpcmVjdD86IHVua25vd247XHJcbn1cclxuXHJcbmNvbnN0IEZPTlRfRVhURU5TSU9OUyA9IG5ldyBTZXQoWycudHRmJywgJy5vdGYnLCAnLmZudCcsICcud29mZicsICcud29mZjInXSk7XHJcbmNvbnN0IE5PREVfS0lORFMgPSBuZXcgU2V0PE5vZGVLaW5kPihbXHJcbiAgICAnYXV0bycsXHJcbiAgICAnbm9kZScsXHJcbiAgICAnc3ByaXRlJyxcclxuICAgICdsYWJlbCcsXHJcbiAgICAncmljaFRleHQnLFxyXG4gICAgJ2J1dHRvbicsXHJcbiAgICAnc2Nyb2xsVmlldycsXHJcbiAgICAnbGF5b3V0JyxcclxuXSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBsaXN0Rm9udEFzc2V0cygpOiBQcm9taXNlPEZvbnRBc3NldE9wdGlvbltdPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBmb250czogRm9udEFzc2V0T3B0aW9uW10gPSBbXTtcclxuICAgIGFzeW5jIGZ1bmN0aW9uIHZpc2l0KGZvbGRlcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgbGV0IGVudHJpZXM7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZW50cmllcyA9IGF3YWl0IHJlYWRkaXIoZm9sZGVyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnbm9kZV9tb2R1bGVzJyB8fCBlbnRyeS5uYW1lID09PSAnbGlicmFyeScgfHwgZW50cnkubmFtZSA9PT0gJ3RlbXAnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZm9sZGVyLCBlbnRyeS5uYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHZpc2l0KGZpbGVQYXRoKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghRk9OVF9FWFRFTlNJT05TLmhhcyhleHRuYW1lKGVudHJ5Lm5hbWUpLnRvTG93ZXJDYXNlKCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgZmlsZVBhdGgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuICAgICAgICAgICAgZm9udHMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShlbnRyeS5uYW1lLCBleHRuYW1lKGVudHJ5Lm5hbWUpKSxcclxuICAgICAgICAgICAgICAgIHVybDogYGRiOi8vYXNzZXRzLyR7cGF0aH1gLFxyXG4gICAgICAgICAgICAgICAgcmVsYXRpdmVQYXRoOiBwYXRoLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBhd2FpdCB2aXNpdChhc3NldHNSb290KTtcclxuICAgIHJldHVybiBmb250cy5zb3J0KChhLCBiKSA9PiBhLnJlbGF0aXZlUGF0aC5sb2NhbGVDb21wYXJlKGIucmVsYXRpdmVQYXRoLCAnemgtQ04nKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVtaXRQcm9ncmVzcyhwcm9ncmVzczogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAncHJvZ3Jlc3MnLCBwcm9ncmVzcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHRDYWNoZUZvbGRlcigpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oRWRpdG9yLlByb2plY3QudG1wRGlyLCBwYWNrYWdlSlNPTi5uYW1lLCAnYXNzZXQtY2FjaGUnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogSW1wb3J0U2V0dGluZ3Mge1xyXG4gICAgY29uc3QgaW5wdXQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyB2YWx1ZSBhcyBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPlxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCBzY2FsZSA9IHR5cGVvZiBpbnB1dC5zY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGlucHV0LnNjYWxlKVxyXG4gICAgICAgID8gTWF0aC5tYXgoMC4yNSwgTWF0aC5taW4oNCwgaW5wdXQuc2NhbGUpKVxyXG4gICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5zY2FsZTtcclxuICAgIGNvbnN0IGZvbnRNYXAgPSBpbnB1dC5mb250TWFwICYmIHR5cGVvZiBpbnB1dC5mb250TWFwID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGlucHV0LmZvbnRNYXApXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKFtrZXksIGl0ZW1dKSA9PiBrZXkudHJpbSgpICYmIHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJylcclxuICAgICAgICAgICAgLm1hcCgoW2tleSwgaXRlbV0pID0+IFtrZXkudHJpbSgpLCBpdGVtLnRyaW0oKV0pKVxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCByYXdMb2NhbEZvbGRlcnMgPSBBcnJheS5pc0FycmF5KGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzKVxyXG4gICAgICAgID8gaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICA6IHR5cGVvZiBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICA/IFtpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyXVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZUZvbGRlcnMgPSByYXdMb2NhbEZvbGRlcnNcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIpOiBmb2xkZXIgaXMgc3RyaW5nID0+IHR5cGVvZiBmb2xkZXIgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gZm9sZGVyLnRyaW0oKSlcclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyLCBpbmRleCwgZm9sZGVycykgPT4gZm9sZGVycy5pbmRleE9mKGZvbGRlcikgPT09IGluZGV4KVxyXG4gICAgICAgIC5zbGljZSgwLCAzKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiB0eXBlb2YgaW5wdXQuc291cmNlVXJsID09PSAnc3RyaW5nJyA/IGlucHV0LnNvdXJjZVVybC50cmltKCkgOiAnJyxcclxuICAgICAgICBhc3NldEZvbGRlcjogdHlwZW9mIGlucHV0LmFzc2V0Rm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogdHlwZW9mIGlucHV0LnByZWZhYkZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVycyxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiBsb2NhbFJlc291cmNlRm9sZGVyc1swXSA/PyAnJyxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogaW5wdXQudXBkYXRlRXhpc3RpbmcgIT09IGZhbHNlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGlucHV0LnJlZnJlc2hBc3NldHMgPT09IHRydWUsXHJcbiAgICAgICAgYXV0b1NhdmU6IGlucHV0LmF1dG9TYXZlID09PSB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5nc1VubG9ja2VkKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGlmIChzZXR0aW5nc0NhY2hlKSB7XHJcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgJ3Byb2plY3QnKTtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGF3YWl0IHNldHRpbmdzV3JpdGVRdWV1ZTtcclxuICAgIHJldHVybiBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhTZXR0aW5nc1dyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHNldHRpbmdzV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBzZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSBzYWZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgbmV4dCwgJ3Byb2plY3QnKTtcclxuICAgICAgICBzZXR0aW5nc0NhY2hlID0gbmV4dDtcclxuICAgICAgICByZXR1cm4gbmV4dDtcclxuICAgIH0pKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soKCkgPT4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGF0Y2hTZXR0aW5ncyh2YWx1ZTogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz4pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh7IC4uLmN1cnJlbnQsIC4uLnZhbHVlIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWVudChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkID0gYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsKTogUHJvbWlzZTxGaWdtYUNsaWVudD4ge1xyXG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIHJldHVybiBuZXcgUm91bmR0cmlwU2VydmljZSh7XHJcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcclxuICAgICAgICBwcm9qZWN0Um9vdDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgcm91bmR0cmlwQ29udHJvbGxlciA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luT3BlcmF0aW9uKG93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IEFib3J0Q29udHJvbGxlciB7XHJcbiAgICBpZiAoYXBwbHlpbmdJbXBvcnRSZXZpZXcpIHRocm93IG5ldyBFcnJvcign5q2j5Zyo56Gu6K6k5a+85YWl5ZCO55qE6LWE5rqQ6LCD5pW077yM6K+356iN5YCZ44CCJyk7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5bey5pyJIEZpZ21hIOaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heWujOaIkOaIluWFiOWPlua2iOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBjb250cm9sbGVyO1xyXG4gICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBvd25lcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAoYWN0aXZlQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikge1xyXG4gICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG4gICAgICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoc2VsZWN0ZWRQYXRoKTtcclxuICAgIGNvbnN0IGZvbGRlciA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGlmICghZm9sZGVyIHx8IGZvbGRlciA9PT0gJy4nIHx8IGZvbGRlci5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUoZm9sZGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6LWE5rqQ6L6T5Ye655uu5b2V5b+F6aG75piv6aG555uuIGFzc2V0cyDkuIvnmoTlrZDmlofku7blpLnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NldERhdGFiYXNlVXJsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShmaWxlUGF0aCk7XHJcbiAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgY29uc3Qgb3V0c2lkZSA9IHBhdGggPT09ICcuLidcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uLycpXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLlxcXFwnKVxyXG4gICAgICAgIHx8IGlzQWJzb2x1dGUocGF0aCk7XHJcbiAgICBpZiAoIXBhdGggfHwgcGF0aCA9PT0gJy4nIHx8IG91dHNpZGUpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBgZGI6Ly9hc3NldHMvJHtwYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKX1gO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6kgRmlnbWEg5a+85YWl6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duLCBfaW5kZXggPSAwKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZycgPyBjdXJyZW50LnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBjdXJyZW50Rm9sZGVyICYmIGlzQWJzb2x1dGUoY3VycmVudEZvbGRlcilcclxuICAgICAgICA/IGN1cnJlbnRGb2xkZXJcclxuICAgICAgICA6IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGlicmFyeSA9IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShzZWxlY3RlZCk7XHJcbiAgICByZXR1cm4geyBmb2xkZXI6IGxpYnJhcnkucm9vdCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiB1bmlvbkZyYW1lKG5vZGVzOiBGaWdtYU5vZGVbXSk6IFJlY3Qge1xyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZXMubWFwKG5vZGVGcmFtZSkuZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIFJlY3QgPT4gQm9vbGVhbih2YWx1ZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgeCA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54KSk7XHJcbiAgICBjb25zdCB5ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkpKTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCkpO1xyXG4gICAgY29uc3QgYm90dG9tID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQpKTtcclxuICAgIHJldHVybiB7IHgsIHksIHdpZHRoOiByaWdodCAtIHgsIGhlaWdodDogYm90dG9tIC0geSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB7XHJcbiAgICBpZiAobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB1bmlvbkZyYW1lKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG59XHJcblxyXG5jb25zdCBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTiA9IDAuNTtcclxuXHJcbi8qKlxyXG4gKiBPbmx5IGV4cGFuZCByYXN0ZXJzIHdob3NlIHZpc2libGUgcGl4ZWxzIGVzY2FwZSB0aGUgZ2VvbWV0cmljIGZyYW1lLiBBXHJcbiAqIHJlbmRlciBmcmFtZSBjb250YWluZWQgaW5zaWRlIHRoZSBnZW9tZXRyeSBvZnRlbiByZXByZXNlbnRzIGludGVudGlvbmFsXHJcbiAqIHRyYW5zcGFyZW50IHBhZGRpbmcgYW5kIG11c3Qga2VlcCB0aGUgbGVnYWN5IGZpeGVkLWNhbnZhcyBwYXRoLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBnZW9tZXRyeSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIGNvbnN0IHJlbmRlciA9IG5vZGUuYWJzb2x1dGVSZW5kZXJCb3VuZHM7XHJcbiAgICBpZiAoIWdlb21ldHJ5IHx8ICFyZW5kZXIgfHwgcmVuZGVyLndpZHRoIDw9IDAgfHwgcmVuZGVyLmhlaWdodCA8PSAwKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGdlb21ldHJ5UmlnaHQgPSBnZW9tZXRyeS54ICsgZ2VvbWV0cnkud2lkdGg7XHJcbiAgICBjb25zdCBnZW9tZXRyeUJvdHRvbSA9IGdlb21ldHJ5LnkgKyBnZW9tZXRyeS5oZWlnaHQ7XHJcbiAgICBjb25zdCByZW5kZXJSaWdodCA9IHJlbmRlci54ICsgcmVuZGVyLndpZHRoO1xyXG4gICAgY29uc3QgcmVuZGVyQm90dG9tID0gcmVuZGVyLnkgKyByZW5kZXIuaGVpZ2h0O1xyXG4gICAgcmV0dXJuIHJlbmRlci54IDwgZ2VvbWV0cnkueCAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyLnkgPCBnZW9tZXRyeS55IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJSaWdodCA+IGdlb21ldHJ5UmlnaHQgKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlckJvdHRvbSA+IGdlb21ldHJ5Qm90dG9tICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICA/IHJlbmRlclxyXG4gICAgICAgIDogdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3JuZXJSYWRpaShub2RlOiBGaWdtYU5vZGUpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XHJcbiAgICBpZiAobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaT8ubGVuZ3RoID09PSA0KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XHJcbiAgICB9XHJcbiAgICBjb25zdCByYWRpdXMgPSBub2RlLmNvcm5lclJhZGl1cyA/PyAwO1xyXG4gICAgcmV0dXJuIFtyYWRpdXMsIHJhZGl1cywgcmFkaXVzLCByYWRpdXNdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0RGVjaXNpb24obm9kZTogRmlnbWFOb2RlKTogRGVjaXNpb24ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IGluZmVyQWN0aW9uKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICBuaW5lU2xpY2U6IGlzUGF0Y2hDYW5kaWRhdGUobm9kZSksXHJcbiAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVjaXNpb25Gb3JOb2RlKG5vZGU6IEZpZ21hTm9kZSwgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4pOiBEZWNpc2lvbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAnZ2VuZXJhdGUnLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICBpZiAoaXNWZWN0b3JOb2RlKG5vZGUpICYmIGRlY2lzaW9uLmFjdGlvbiAhPT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4geyAuLi5kZWNpc2lvbiwgYWN0aW9uOiAncmVuZGVyJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9uO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZGVjaXNpb25NYXAob3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdLCB0cmVlOiBUcmVlTm9kZUR0b1tdKTogTWFwPHN0cmluZywgRGVjaXNpb24+IHtcclxuICAgIGNvbnN0IGRlY2lzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBEZWNpc2lvbj4oKTtcclxuICAgIGNvbnN0IGFkZERlZmF1bHRzID0gKG5vZGVzOiBUcmVlTm9kZUR0b1tdKSA9PiB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGRlY2lzaW9ucy5zZXQobm9kZS5pZCwge1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24obm9kZS5hY3Rpb24pLFxyXG4gICAgICAgICAgICAgICAga2luZDogbm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBub2RlLnBhdGNoQ2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgYWRkRGVmYXVsdHMobm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuICAgIGFkZERlZmF1bHRzKHRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIG92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICAgICAgZGVjaXNpb25zLnNldChpdGVtLmlkLCB7XHJcbiAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICAgICAga2luZDogTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kKSA/IGl0ZW0ua2luZCA6ICdhdXRvJyxcclxuICAgICAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSxcclxuICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb25zO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBkZWNpc2lvbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgSW1wb3J0RGVjaXNpb24+LFxyXG4gICAgaW5jbHVkZU5vZGVOYW1lID0gdHJ1ZSxcclxuKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCk7XHJcbiAgICByZXR1cm4gZGVjaXNpb24/LmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgfHwgKGluY2x1ZGVOb2RlTmFtZSAmJiBCb29sZWFuKGRlY2lzaW9uPy5uYW1lKSlcclxuICAgICAgICB8fCBub2RlLmNoaWxkcmVuLnNvbWUoKGNoaWxkKSA9PiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShjaGlsZCwgZGVjaXNpb25zKSk7XHJcbn1cclxuXHJcbnR5cGUgU3RvcmVkTm9kZU92ZXJyaWRlcyA9IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIEltcG9ydE92ZXJyaWRlPj47XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk6IFByb21pc2U8U3RvcmVkTm9kZU92ZXJyaWRlcz4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnID8gc2F2ZWQgYXMgU3RvcmVkTm9kZU92ZXJyaWRlcyA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlOiB1bmtub3duLCBmYWxsYmFja0lkID0gJycpOiBJbXBvcnRPdmVycmlkZSB8IG51bGwge1xyXG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGl0ZW0gPSB2YWx1ZSBhcyBQYXJ0aWFsPEltcG9ydE92ZXJyaWRlPjtcclxuICAgIGNvbnN0IGlkID0gdHlwZW9mIGl0ZW0uaWQgPT09ICdzdHJpbmcnICYmIGl0ZW0uaWQgPyBpdGVtLmlkIDogZmFsbGJhY2tJZDtcclxuICAgIGlmICghaWQpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3Qga2luZCA9IHR5cGVvZiBpdGVtLmtpbmQgPT09ICdzdHJpbmcnICYmIE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCBhcyBOb2RlS2luZClcclxuICAgICAgICA/IGl0ZW0ua2luZCBhcyBOb2RlS2luZFxyXG4gICAgICAgIDogJ2F1dG8nO1xyXG4gICAgY29uc3QgZXhwbGljaXQgPSBpdGVtLmV4cGxpY2l0ID09PSBmYWxzZSA/IGZhbHNlIDogdHJ1ZTtcclxuICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICBpZiAoIWV4cGxpY2l0ICYmICFuYW1lKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQsXHJcbiAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgIGtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSA9PT0gdHJ1ZSxcclxuICAgICAgICBleHBsaWNpdCxcclxuICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gbm9kZU92ZXJyaWRlc0ZvcihmaWxlS2V5OiBzdHJpbmcpOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIGNvbnN0IHN0b3JlZCA9IChhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCkpW2ZpbGVLZXldID8/IHt9O1xyXG4gICAgY29uc3QgcmVzdWx0OiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IFtpZCwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHN0b3JlZCkpIHtcclxuICAgICAgICBjb25zdCBzYWZlID0gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZSwgaWQpO1xyXG4gICAgICAgIGlmIChzYWZlKSByZXN1bHQucHVzaChzYWZlKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcclxuICAgIG5vZGVPdmVycmlkZVdyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIGlmICh0eXBlb2YgZmlsZUtleSAhPT0gJ3N0cmluZycgfHwgIWZpbGVLZXkudHJpbSgpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaXRlbXMgPSBBcnJheS5pc0FycmF5KHZhbHVlcykgPyB2YWx1ZXMgOiBbXTtcclxuICAgIGNvbnN0IHNhZmVJdGVtcyA9IGl0ZW1zXHJcbiAgICAgICAgLm1hcCgoaXRlbSkgPT4gc2FmZU5vZGVPdmVycmlkZShpdGVtKSlcclxuICAgICAgICAuZmlsdGVyKChpdGVtKTogaXRlbSBpcyBJbXBvcnRPdmVycmlkZSA9PiBCb29sZWFuKGl0ZW0pKTtcclxuICAgIGNvbnN0IHNjb3BlSWRzID0gbmV3IFNldChcclxuICAgICAgICAoQXJyYXkuaXNBcnJheShzY29wZVZhbHVlcykgPyBzY29wZVZhbHVlcyA6IHNhZmVJdGVtcy5tYXAoKGl0ZW0pID0+IGl0ZW0uaWQpKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIEJvb2xlYW4oaWQpKSxcclxuICAgICk7XHJcbiAgICBpZiAoIXNjb3BlSWRzLnNpemUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkeW9k+WJjeWvvOWFpeiMg+WbtOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2NvcGVkSXRlbXMgPSBzYWZlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiBzY29wZUlkcy5oYXMoaXRlbS5pZCkpO1xyXG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcclxuICAgIGZvciAoY29uc3QgaWQgb2Ygc2NvcGVJZHMpIHtcclxuICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygc2NvcGVkSXRlbXMpIHtcclxuICAgICAgICBjdXJyZW50W2l0ZW0uaWRdID0gaXRlbTtcclxuICAgIH1cclxuICAgIGlmIChPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGgpIHtcclxuICAgICAgICBzdG9yZWRbZmlsZUtleV0gPSBjdXJyZW50O1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzY29wZWRJdGVtcztcclxufVxyXG5cclxuZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXMoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soXHJcbiAgICAgICAgKCkgPT4gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChmaWxlS2V5LCB2YWx1ZXMsIHNjb3BlVmFsdWVzKSxcclxuICAgICk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXRjaE5vZGVOYW1lcyhmaWxlS2V5OiBzdHJpbmcsIHBhdGNoZXM6IE1jcE5vZGVOYW1lUGF0Y2hbXSk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgcmV0dXJuIHdpdGhOb2RlT3ZlcnJpZGVXcml0ZUxvY2soYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghZmlsZUtleS50cmltKCkpIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgICAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHsgLi4uKHN0b3JlZFtmaWxlS2V5XSA/PyB7fSkgfTtcclxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHBhdGNoIG9mIHBhdGNoZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaWQgPSB0eXBlb2YgcGF0Y2guaWQgPT09ICdzdHJpbmcnID8gcGF0Y2guaWQudHJpbSgpIDogJyc7XHJcbiAgICAgICAgICAgIGlmICghaWQpIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya57y65bCRIG5vZGVJZOOAgicpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHNhZmVOb2RlT3ZlcnJpZGUoY3VycmVudFtpZF0sIGlkKTtcclxuICAgICAgICAgICAgY29uc3QgZmFsbGJhY2sgPSBzYWZlTm9kZU92ZXJyaWRlKHBhdGNoLmZhbGxiYWNrLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5leHQgPSBleGlzdGluZyA/IHsgLi4uZXhpc3RpbmcgfSA6IGZhbGxiYWNrID8geyAuLi5mYWxsYmFjayB9IDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFuZXh0ICYmIHBhdGNoLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghbmV4dCkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g57y65bCR5pyJ5pWI6buY6K6k562W55Wl44CCYCk7XHJcbiAgICAgICAgICAgIGlmIChwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgbmV4dC5uYW1lO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUocGF0Y2gubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5hbWUpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOeahOWQjeensOaXoOaViOOAgmApO1xyXG4gICAgICAgICAgICAgICAgbmV4dC5uYW1lID0gbmFtZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzYWZlID0gc2FmZU5vZGVPdmVycmlkZShuZXh0LCBpZCk7XHJcbiAgICAgICAgICAgIGlmIChzYWZlKSB7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50W2lkXSA9IHNhZmU7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0ZWQucHVzaChzYWZlKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSBzdG9yZWRbZmlsZUtleV0gPSBjdXJyZW50O1xyXG4gICAgICAgIGVsc2UgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0ZWQ7XHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYW5ub3RhdGVEb2N1bWVudFBsYW4oc2Vzc2lvbjogRG9jdW1lbnRTZXNzaW9uKTogRG9jdW1lbnRTZXNzaW9uIHtcclxuICAgIGNvbnN0IGRlZmF1bHRzID0gZGVjaXNpb25NYXAoW10sIHNlc3Npb24udHJlZSk7XHJcbiAgICBzZXNzaW9uLnRyZWUgPSBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbihcclxuICAgICAgICBzZXNzaW9uLnRyZWUsXHJcbiAgICAgICAgY29tcGlsZUltcG9ydFBsYW4oc2Vzc2lvbi5yb290cywgZGVmYXVsdHMpLFxyXG4gICAgKTtcclxuICAgIHJldHVybiBzZXNzaW9uO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2xsZWN0QXNzZXRSZXF1ZXN0cyhcclxuICAgIHJvb3RzOiBGaWdtYU5vZGVbXSxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4pOiB7IHBuZzogRmlnbWFOb2RlW107IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdOyByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W107IGdyYWRpZW50czogRmlnbWFOb2RlW10gfSB7XHJcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCBncmFkaWVudHM6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBGaWdtYU5vZGUsIGFuY2VzdG9yc1Zpc2libGU6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZWZmZWN0aXZlbHlWaXNpYmxlID0gYW5jZXN0b3JzVmlzaWJsZSAmJiBub2RlLnZpc2libGUgIT09IGZhbHNlICYmIG5vZGUub3BhY2l0eSA+IDA7XHJcbiAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ1RFWFQnKSB7XHJcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24ubmluZVNsaWNlKSB7XHJcbiAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2Uobm9kZSk7XHJcbiAgICAgICAgICAgIGlmIChzb3VyY2UpIHtcclxuICAgICAgICAgICAgICAgIHRpbGVkLnB1c2goeyBub2RlLCBzb3VyY2UgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZVJlZiA9IGVmZmVjdGl2ZWx5VmlzaWJsZSA/IHVuZGVmaW5lZCA6IHBsYWluSW1hZ2VTb3VyY2VSZWYobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgICAgICByYXdJbWFnZXMucHVzaCh7IG5vZGUsIGltYWdlUmVmIH0pO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdnZW5lcmF0ZScpIHtcclxuICAgICAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgICAgICBpZiAoZmlsbCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZ3JhZGllbnRzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBlZmZlY3RpdmVseVZpc2libGUpKTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB0cnVlKSk7XHJcbiAgICByZXR1cm4geyBwbmcsIHRpbGVkLCByYXdJbWFnZXMsIGdyYWRpZW50cyB9O1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRBc3NldHMoXG4gICAgc2Vzc2lvbjogRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBpbXBvcnRTZXR0aW5nczogSW1wb3J0U2V0dGluZ3MsXHJcbiAgICByZXZpZXc6IEltcG9ydFJldmlld1JlY29yZGVyLFxyXG4pOiBQcm9taXNlPEFzc2V0QnVpbGRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5hc3NldEZvbGRlciwgKHVybCwgZXhpc3RlZCkgPT4gcmV2aWV3LmJlZm9yZVdyaXRlKHVybCwgZXhpc3RlZCkpO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICBjb25zdCBwcm9tb3RlTG9jYWxQYXJlbnRzID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgICAgICAvLyBSZW5hbWluZyB0aGlzIGNvbnRhaW5lciBkb2VzIG5vdCBjaGFuZ2UgcmVzb3VyY2UgbWF0Y2hpbmc7IG9ubHlcclxuICAgICAgICAgICAgLy8gYSBzdHJhdGVneSBvdmVycmlkZSBvbiBpdHNlbGYgb3IgYW55IG92ZXJyaWRlIGJlbG93IGl0IGJsb2Nrc1xyXG4gICAgICAgICAgICAvLyBwcm9tb3Rpb24gYmVjYXVzZSBkZXNjZW5kYW50cyB3b3VsZCBvdGhlcndpc2UgZGlzYXBwZWFyLlxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcclxuICAgICAgICAgICAgLy8gQSBsb2NhbCBwYXJlbnQgcmVzb3VyY2UgY2Fubm90IHJlcHJlc2VudCBpbmRlcGVuZGVudGx5IGluYWN0aXZlXHJcbiAgICAgICAgICAgIC8vIGRlc2NlbmRhbnRzLiBLZWVwIHRoZSBoaWVyYXJjaHkgd2hlbmV2ZXIgc3VjaCBhIGJvdW5kYXJ5IGV4aXN0cy5cclxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgbGV0IGxvY2FsTWF0Y2ggPSBudWxsO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgICAgIGxvY2FsTWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobm9kZS5uYW1lLCAncG5nJyk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobm9kZS5jaGlsZHJlbi5tYXAocHJvbW90ZUxvY2FsUGFyZW50cykpO1xyXG4gICAgfTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKHNlc3Npb24ucm9vdHMubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIGNvbnN0IHJlcXVlc3RzID0gY29sbGVjdEFzc2V0UmVxdWVzdHMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IGFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XHJcbiAgICBjb25zdCB3YXJuaW5ncyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoXHJcbiAgICAgICAgKyByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoICsgcmVxdWVzdHMuZ3JhZGllbnRzLmxlbmd0aDtcclxuICAgIGxldCBjb21wbGV0ZWQgPSAwO1xyXG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgZ2V0QXBpID0gKCkgPT4ge1xyXG4gICAgICAgIGFwaVByb21pc2UgPz89IGRpYWdub3N0aWNUYXNrKCflh4blpIcgRmlnbWEg5a6i5oi356uvJywgdW5kZWZpbmVkLCAoKSA9PiBjbGllbnQoKSk7XHJcbiAgICAgICAgcmV0dXJuIGFwaVByb21pc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGNvbXBsZXRlQXNzZXQgPSAoXHJcbiAgICAgICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnIHwgJ2dlbmVyYXRlZCcgPSAnZmlnbWEnLFxyXG4gICAgKSA9PiB7XHJcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XHJcbiAgICAgICAgcmV2aWV3LmJpbmQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xyXG4gICAgICAgICAgICA/ICflpI3nlKjmnKzlnLDotYTmupAnXHJcbiAgICAgICAgICAgIDogc291cmNlID09PSAnZXhpc3RpbmcnXHJcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXHJcbiAgICAgICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2dlbmVyYXRlZCdcclxuICAgICAgICAgICAgICAgICAgICA/ICfnlJ/miJDmuJDlj5gnXHJcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHt2ZXJifSAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1RpbGVkID0gYXN5bmMgKGl0ZW1zOiBUaWxlZEFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxuICAgICAgICAgICAgc291cmNlS2V5OiBzdHJpbmc7XHJcbiAgICAgICAgICAgIGFzc2V0S2V5OiBzdHJpbmc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBQZW5kaW5nVGlsZSBleHRlbmRzIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcclxuICAgICAgICAgICAgc291cmNlVHlwZTogJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XHJcbiAgICAgICAgY29uc3QgcmVuZGVyU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBzb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICA/IGNsYW1wSW1hZ2VTY2FsZShyZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKVxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFRpbGVHcm91cD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgbm9kZSwgc291cmNlIH0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAga2luZDogc291cmNlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFpbnRTY2FsZTogc291cmNlLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyU2NhbGU6IHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldEtleSA9IHRpbGVkUmFzdGVyS2V5KHNvdXJjZUtleSwgcmVxdWVzdGVkU2NhbGUoc291cmNlKSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHdyaXRlci5idWlsZFRpbGVkVXJsKG5vZGUubmFtZSwgYXNzZXRLZXksICdwbmcnKVxyXG4gICAgICAgICAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpXHJcbiAgICAgICAgICAgICAgICAudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZSwgbm9kZXM6IFtdLCBzb3VyY2UsIHNvdXJjZUtleSwgYXNzZXRLZXkgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgcGVuZGluZzogUGVuZGluZ1RpbGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGV4aXN0aW5nQXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGV4aXN0aW5nQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmdSYXN0ZXIod3JpdGVyLmJ1aWxkVGlsZWRVcmwoZ3JvdXAubm9kZS5uYW1lLCBncm91cC5hc3NldEtleSwgJ3BuZycpLCB0cnVlKTtcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHBpeGVsU2l6ZWRUaWxlQXNzZXQoZXhpc3RpbmdBc3NldCksICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZEV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBbJ3BuZyddXHJcbiAgICAgICAgICAgICAgICAgICAgOiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUztcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoZ3JvdXAuc291cmNlKSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gY2FjaGVkO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyxcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogY2FjaGVkRXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVyblVybHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nIHwgbnVsbD4oKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJlbW90ZUl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNvdXJjZS5raW5kICE9PSAnc291cmNlLW5vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzY2FsZSA9IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGlkcy5hZGQoaXRlbS5zb3VyY2UuaWQpO1xyXG4gICAgICAgICAgICBwYXR0ZXJuc0J5U2NhbGUuc2V0KHNjYWxlLCBpZHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IFtzY2FsZSwgaWRzXSBvZiBwYXR0ZXJuc0J5U2NhbGUpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShpZHMpLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbaWQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXModXJscykpIHtcclxuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcclxuICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gbmVlZHNJbWFnZUZpbGxzXHJcbiAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSlcclxuICAgICAgICAgICAgOiB7fTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkID0gKHVybDogc3RyaW5nLCBub2RlTGFiZWw6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQodXJsKTtcclxuICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQodXJsLCBub2RlTGFiZWwpKTtcclxuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gdGFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2l0ZW0uc291cmNlLmlkfTpzY2FsZToke3JlbmRlclNjYWxlKGl0ZW0uc291cmNlKX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIClcclxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYElNQUdFIOWhq+WFhSAke2l0ZW0uc291cmNlLmlkfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5Dkvpske2xhYmVsfe+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7aXRlbS5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+W5s+mTuui1hOa6kOaMieWunumZheWwuuWvuOeUn+aIkCcsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgIGxldCByYXN0ZXI6IFJldHVyblR5cGU8dHlwZW9mIHJhc3Rlcml6ZVRpbGU+O1xyXG4gICAgICAgICAgICB0cnkgeyByYXN0ZXIgPSByYXN0ZXJpemVUaWxlKGNvbnRlbnRzLCByZXF1ZXN0ZWRTY2FsZShpdGVtLnNvdXJjZSksIHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSk7IH1cclxuICAgICAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3ml6Dms5XmjInlrp7pmYXlsLrlr7jnlJ/miJDvvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmFzdGVyLnJvdW5kZWQpIHdhcm5pbmdzLmFkZChg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3nmoTmmL7npLrlsLrlr7jlt7Llj5bmlbTkuLogJHtyYXN0ZXIud2lkdGh9w5cke3Jhc3Rlci5oZWlnaHR9IOWDj+e0oO+8iOacgOWwjyAx77yJ77yM6IqC54K5IFNjYWxlIOS/neaMgSAx44CCYCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFRpbGVkVXJsKGl0ZW0ubm9kZS5uYW1lLCBpdGVtLmFzc2V0S2V5LCAncG5nJyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgcGl4ZWxTaXplZFRpbGVBc3NldChhd2FpdCB3cml0ZXIud3JpdGUodXJsLCByYXN0ZXIuY29udGVudHMsIHVuZGVmaW5lZCwgdHJ1ZSkpLFxyXG4gICAgICAgICAgICAgICAgaXRlbS5zb3VyY2VUeXBlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB0cmFjZS5kb25lKHsgc291cmNlV2lkdGg6IHJhc3Rlci5zb3VyY2VXaWR0aCwgc291cmNlSGVpZ2h0OiByYXN0ZXIuc291cmNlSGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IHJhc3Rlci53aWR0aCwgaGVpZ2h0OiByYXN0ZXIuaGVpZ2h0LCB0aWxlU2NhbGU6IDEgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmVtb3RlID0gYXN5bmMgKG5vZGVzOiBGaWdtYU5vZGVbXSkgPT4ge1xyXG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgdXJsOiBzdHJpbmc7IG5vZGVzOiBGaWdtYU5vZGVbXSB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH1gLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBBcnJheTx7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICB1cmw6IHN0cmluZztcclxuICAgICAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfTtcclxuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XHJcbiAgICAgICAgICAgIHJlbmRlckZyYW1lPzogUmVjdDtcclxuICAgICAgICAgICAga2V5OiBDYWNoZUVudHJ5S2V5O1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfT4gPSBbXTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBub2RlID0gZ3JvdXBlZE5vZGVzWzBdO1xuICAgICAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHJldXNlQXNzZXQgPSAoYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYywgc291cmNlOiAnbG9jYWwnIHwgJ2V4aXN0aW5nJykgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIWFzc2V0LnNsaWNlZCkge1xuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3lt7Lnm7TmjqXlvJXnlKjlkIzlkI3otYTmupDvvIzkvYbor6UgU3ByaXRlRnJhbWUg5pyq6YWN572u5Lmd5a6r6L656Led77yM5pqC5oyJ5pmu6YCaIFNwcml0ZSDmmL7npLrvvJvor7flnKjljp/otYTmupDkuK3orr7nva7ovrnot53vvJoke2Fzc2V0LnVybH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cGVkTm9kZXMsIGFzc2V0LCBzb3VyY2UpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGxldCBsb2NhbE1hdGNoID0gbnVsbDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbFJlc291cmNlcykge1xyXG4gICAgICAgICAgICAgICAgbG9jYWxNYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChub2RlLm5hbWUsIGZvcm1hdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vIFByb2plY3QtbG9jYWwgU3ByaXRlRnJhbWVzIG93biB0aGVpciBwaXhlbHMgYW5kIHNsaWNlIGJvcmRlcnMuXG4gICAgICAgICAgICAvLyBSZXVzZSB0aGVpciBVVUlEIGJlZm9yZSBhbnkgc2xpY2UgYW5hbHlzaXMsIGNvbXBhY3Rpb24gb3IgcmVmcmVzaC5cbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbG9jYWxNYXRjaFxuICAgICAgICAgICAgICAgID8gYXNzZXREYXRhYmFzZVVybChsb2NhbE1hdGNoLnBhdGgpXG4gICAgICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XG4gICAgICAgICAgICBpZiAobG9jYWxBc3NldCkge1xuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQobG9jYWxBc3NldCwgJ2xvY2FsJyk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlubborr7nva7kuLogU3ByaXRlRnJhbWUg5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmdSYXN0ZXIodXJsLCBmYWxzZSwgbm9kZS5uYW1lKSA6IG51bGw7XG4gICAgICAgICAgICBpZiAoIWxvY2FsTWF0Y2ggJiYgZXhpc3RpbmcgJiYgKGRlY2lzaW9uLm5pbmVTbGljZSB8fCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSkpIHtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBkZWNpc2lvbi5uaW5lU2xpY2UgJiYgZm9ybWF0ID09PSAncG5nJ1xuICAgICAgICAgICAgICAgID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxuICAgICAgICAgICAgICAgIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIXNsaWNlQW5hbHlzaXMpIHtcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3ml6Dms5XorqHnrpfov57nu63liIfniYfovrnnlYzvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYm9yZGVycyA9IHNsaWNlQW5hbHlzaXM/LmJvcmRlcnM7XG4gICAgICAgICAgICAvLyBOZXcgc2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlXG4gICAgICAgICAgICAvLyB0aGVpciBnZW5lcmF0ZWQgYm9yZGVycyB1c2UgdGhhdCBjb29yZGluYXRlIHNwYWNlLlxuICAgICAgICAgICAgY29uc3QgcmVuZGVyRnJhbWUgPSBib3JkZXJzID8gdW5kZWZpbmVkIDogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGtleTogQ2FjaGVFbnRyeUtleSA9IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHZhcmlhbnQ6IHJlbmRlckZyYW1lID8gJ3Zpc3VhbC1vdmVyZmxvdy12MScgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGxvY2FsTWF0Y2ggfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGNhY2hlLnJlYWQoa2V5KTtcclxuICAgICAgICAgICAgcGVuZGluZy5wdXNoKHtcbiAgICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICAgIG5vZGVzOiBncm91cGVkTm9kZXMsXG4gICAgICAgICAgICAgICAgdXJsOiBsb2NhbE1hdGNoICYmIGRldGVjdEltYWdlRXh0ZW5zaW9uKGxvY2FsTWF0Y2guY29udGVudHMpID09PSAnanBnJ1xuICAgICAgICAgICAgICAgICAgICA/IHVybC5yZXBsYWNlKC9cXC5wbmckL2ksICcuanBnJykgOiB1cmwsXG4gICAgICAgICAgICAgICAgYm9yZGVycyxcclxuICAgICAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM6IHNsaWNlQW5hbHlzaXMgPz8gdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyRnJhbWU6IGxvY2FsTWF0Y2ggPyB1bmRlZmluZWQgOiByZW5kZXJGcmFtZSxcclxuICAgICAgICAgICAgICAgIGtleSxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzOiBsb2NhbE1hdGNoPy5jb250ZW50cyA/PyBjYWNoZWQsXHJcbiAgICAgICAgICAgICAgICBzb3VyY2U6IGxvY2FsTWF0Y2ggPyAnbG9jYWwnIDogY2FjaGVkID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB1cmxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPiA9IHt9O1xyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHVzZUFic29sdXRlQm91bmRzIG9mIFt0cnVlLCBmYWxzZV0pIHtcclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSByZW1vdGVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzID8gIWl0ZW0ucmVuZGVyRnJhbWUgOiBCb29sZWFuKGl0ZW0ucmVuZGVyRnJhbWUpXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgICAgICBpZiAoIWJhdGNoLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih1cmxzLCBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGJhdGNoLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMsXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZnJvbUVudHJpZXMoYmF0Y2gubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGUubmFtZV0pKSxcclxuICAgICAgICAgICAgKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gdXJsc1tpdGVtLm5vZGUuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDvea4suafk+iKgueCue+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKGl0ZW0ua2V5LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGFzc2V0OiBTcHJpdGVBc3NldFNwZWM7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNsaWNlQW5hbHlzaXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCfkuIkv5Lmd5a6r6LWE5rqQ5pyA5bCP5YyWJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdyaXRlU2xpY2VkUG5nKHdyaXRlciwgaXRlbS51cmwsIGNvbnRlbnRzLCBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zbGljZUFuYWx5c2lzLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IHJlc3VsdC5hc3NldDtcclxuICAgICAgICAgICAgICAgIHRyYWNlLmRvbmUocmVzdWx0Lm9wdGltaXphdGlvbik7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5YiH54mH6K6+572u5aSx6LSl77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaXvvJoke2Fzc2V0LnNsaWNlRmFsbGJhY2t9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGdyb3VwZWROb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7IC4uLmFzc2V0LCByZW5kZXJGcmFtZTogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShncm91cGVkTm9kZSkgPz8gaXRlbS5yZW5kZXJGcmFtZSB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyBub2RlOiBGaWdtYU5vZGU7IG5vZGVzOiBGaWdtYU5vZGVbXTsgaW1hZ2VSZWY6IHN0cmluZyB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSBgJHtpdGVtLm5vZGUubmFtZS5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKX1cXDAke2l0ZW0uaW1hZ2VSZWZ9YDtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlOiBpdGVtLm5vZGUsIG5vZGVzOiBbXSwgaW1hZ2VSZWY6IGl0ZW0uaW1hZ2VSZWYgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGltYWdlRmlsbFVybHNQcm9taXNlOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+PiB8IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBsZXQgc291cmNlOiAnY2FjaGUnIHwgJ2ZpZ21hJyA9ICdjYWNoZSc7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogY2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGNhbmRpZGF0ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGlmICghaW1hZ2VGaWxsVXJsc1Byb21pc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICBpbWFnZUZpbGxVcmxzUHJvbWlzZSA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gYXdhaXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpbWFnZUZpbGxVcmxzW2dyb3VwLmltYWdlUmVmXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5DkvpvpmpDol4/lm77niYfloavlhYXvvJoke2dyb3VwLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldChyZW1vdGVVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7Z3JvdXAubm9kZS5uYW1lfSAoJHtncm91cC5ub2RlLmlkfSlgKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldChyZW1vdGVVcmwsIHRhc2spO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCB0YXNrO1xyXG4gICAgICAgICAgICAgICAgc291cmNlID0gJ2ZpZ21hJztcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBleHRlbnNpb24gPz89IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgZ3JvdXAubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fTppbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgMSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBncm91cC5ub2RlcykgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflubPpk7rotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy50aWxlZC5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1RpbGVkKHJlcXVlc3RzLnRpbGVkKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSHIFBORyDotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5wbmcubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKSk7XHJcbiAgICAvLyBSdW4gYWZ0ZXIgd2hvbGUtbm9kZSByZW5kZXJzIHNvIGEgY29ycmVjdCB2aXNpYmlsaXR5LWluZGVwZW5kZW50IHNvdXJjZVxyXG4gICAgLy8gaW1hZ2Ugd2lucyBpZiBib3RoIHBhdGhzIHNoYXJlIHRoZSBzYW1lIGxlZ2FjeSBhc3NldCBmaWxlbmFtZS5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIfpmpDol4/lm77niYfotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XHJcblxyXG4gICAgY29uc3QgZ3JhZGllbnRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXHJcbiAgICAgICAgICAgID8gZ3JhZGllbnRQbmcoXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGZpbGwsXHJcbiAgICAgICAgICAgICAgICBjb3JuZXJSYWRpaShub2RlKSxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAocG5nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBncmFkaWVudEtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZmlyc3RBc3NldCA9IGdyYWRpZW50QXNzZXRzLmdldChncmFkaWVudEtleSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZmlyc3RBc3NldCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgd3JpdGVyLmV4aXN0aW5nUmFzdGVyKHVybCk7XG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGZpcnN0QXNzZXQgPz8gZXhpc3RpbmcgPz8gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcG5nKTtcclxuICAgICAgICAgICAgZ3JhZGllbnRBc3NldHMuc2V0KGdyYWRpZW50S2V5LCBhc3NldCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIGZpcnN0QXNzZXQgfHwgZXhpc3RpbmcgPyAnZXhpc3RpbmcnIDogJ2dlbmVyYXRlZCcpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDnlJ/miJDmuJDlj5ggJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmYW1pbHksIHVybF0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgcmVzb2x2ZUFzc2V0VXVpZCh1cmwpO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQoZmFtaWx5LCB1dWlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlcnJlZExheW91dE1vZGUobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IG5hdGl2ZU1vZGUgPSBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKTtcclxuICAgIGlmIChuYXRpdmVNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIG5hdGl2ZU1vZGU7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIFJlY3QgPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcclxuICAgIGNvbnN0IGNlbnRlcnNZID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQgLyAyKTtcclxuICAgIGNvbnN0IHNwcmVhZFggPSBNYXRoLm1heCguLi5jZW50ZXJzWCkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWCk7XHJcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xyXG4gICAgaWYgKHNwcmVhZFkgPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnSE9SSVpPTlRBTCc7XHJcbiAgICB9XHJcbiAgICBpZiAoc3ByZWFkWCA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ0dSSUQnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFrZVNwZWMoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcGxhbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+LFxyXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPixcclxuICAgIGZvbnRzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbiAgICBwYXJlbnRXb3JsZFJvdGF0aW9uID0gMCxcclxuKTogU2NlbmVOb2RlU3BlYyB8IG51bGwge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZSA9IG5vZGVGcmFtZShub2RlKTtcclxuICAgIGNvbnN0IHBsYW4gPSBwbGFucy5nZXQobm9kZS5pZCk7XHJcbiAgICBjb25zdCBmb2xkID0gcGxhbj8uZm9sZDtcclxuICAgIGNvbnN0IGZvbGRTb3VyY2UgPSBmb2xkID8gbm9kZUJ5SWQuZ2V0KGZvbGQuc291cmNlTm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgIGNvbnN0IHRleHRTb3VyY2UgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHZpc3VhbFNvdXJjZSA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnICYmIGZvbGRTb3VyY2UgPyBmb2xkU291cmNlIDogbm9kZTtcclxuICAgIGNvbnN0IHJlc29sdmVkS2luZCA9IGRlY2lzaW9uLmtpbmQgPT09ICdhdXRvJyA/IGluZmVyS2luZChub2RlKSA6IGRlY2lzaW9uLmtpbmQ7XHJcbiAgICBjb25zdCBwbGFubmVkS2luZCA9IHBsYW4/LmtpbmQgPz8gcmVzb2x2ZWRLaW5kO1xyXG4gICAgY29uc3QgYml0bWFwVGVybWluYWwgPSBkZWNpc2lvbi5uaW5lU2xpY2UgfHwgZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJztcclxuICAgIGNvbnN0IHRlcm1pbmFsID0gYml0bWFwVGVybWluYWwgfHwgaXNUZXJtaW5hbEFjdGlvbihkZWNpc2lvbi5hY3Rpb24pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGtpbmRGb3JJbXBvcnRBY3Rpb24ocGxhbm5lZEtpbmQsIGRlY2lzaW9uLmFjdGlvbiwgZGVjaXNpb24ubmluZVNsaWNlKTtcclxuICAgIGNvbnN0IHNwcml0ZVNvdXJjZUlkID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCdcclxuICAgICAgICA/IGZvbGQuc291cmNlTm9kZUlkXHJcbiAgICAgICAgOiBub2RlLmlkO1xyXG4gICAgY29uc3Qgc3ByaXRlQXNzZXQgPSBhc3NldHMuZ2V0KHNwcml0ZVNvdXJjZUlkKTtcclxuICAgIGNvbnN0IGFic29yYmVkRGlyZWN0SWRzID0gbmV3IFNldChmb2xkID8gW2ZvbGQuc291cmNlTm9kZUlkXSA6IFtdKTtcclxuICAgIGNvbnN0IGZ1bGxGb2xkID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS1pbWFnZScgfHwgZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JztcclxuICAgIGNvbnN0IHdvcmxkUm90YXRpb24gPSBwYXJlbnRXb3JsZFJvdGF0aW9uICsgbm9kZS5yb3RhdGlvbjtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZmlnbWFJZDogbm9kZS5pZCxcclxuICAgICAgICBuYW1lOiBkZWNpc2lvbi5uYW1lID8/IG5vZGUubmFtZSxcclxuICAgICAgICBmaWdtYVR5cGU6IHZpc3VhbFNvdXJjZS50eXBlLFxyXG4gICAgICAgIGFjdGlvbjogZGVjaXNpb24uYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgcGFyZW50RnJhbWUsXHJcbiAgICAgICAgaW50cmluc2ljU2l6ZTogbm9kZS5zaXplLFxyXG4gICAgICAgIGlzUm9vdCxcclxuICAgICAgICByb3RhdGlvbjogbm9kZS5yb3RhdGlvbixcclxuICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgIG9wYWNpdHk6IGZvbGRTb3VyY2UgJiYgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyBub2RlLm9wYWNpdHkgKiBmb2xkU291cmNlLm9wYWNpdHlcclxuICAgICAgICAgICAgOiBub2RlLm9wYWNpdHksXHJcbiAgICAgICAgdmlzaWJsZTogbm9kZS52aXNpYmxlLFxyXG4gICAgICAgIGNsaXBzQ29udGVudDogbm9kZS5jbGlwc0NvbnRlbnQsXHJcbiAgICAgICAgY29ybmVyUmFkaWk6IGNvcm5lclJhZGlpKHZpc3VhbFNvdXJjZSksXHJcbiAgICAgICAgZmlsbHM6IHRleHRTb3VyY2UuZmlsbHMsXHJcbiAgICAgICAgc3Ryb2tlczogdGV4dFNvdXJjZS5zdHJva2VzLFxyXG4gICAgICAgIHN0cm9rZVdlaWdodDogdGV4dFNvdXJjZS5zdHJva2VXZWlnaHQsXHJcbiAgICAgICAgY2hhcmFjdGVyczogdGV4dFNvdXJjZS5jaGFyYWN0ZXJzLFxyXG4gICAgICAgIHRleHRTdHlsZTogdGV4dFNvdXJjZS5zdHlsZSxcclxuICAgICAgICBsYXlvdXQ6IHtcclxuICAgICAgICAgICAgbW9kZTogZWZmZWN0aXZlS2luZCA9PT0gJ2xheW91dCcgfHwgZWZmZWN0aXZlS2luZCA9PT0gJ3Njcm9sbFZpZXcnXHJcbiAgICAgICAgICAgICAgICA/IGluZmVycmVkTGF5b3V0TW9kZShub2RlKVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIHNvdXJjZU1vZGU6IG5vZGUubGF5b3V0TW9kZSxcclxuICAgICAgICAgICAgd3JhcDogbm9kZS5sYXlvdXRXcmFwLFxyXG4gICAgICAgICAgICBwcmltYXJ5QWxpZ246IG5vZGUucHJpbWFyeUF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBjb3VudGVyQWxpZ246IG5vZGUuY291bnRlckF4aXNBbGlnbkl0ZW1zLFxyXG4gICAgICAgICAgICBwcmltYXJ5U2l6aW5nOiBub2RlLnByaW1hcnlBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgY291bnRlclNpemluZzogbm9kZS5jb3VudGVyQXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGl0ZW1TcGFjaW5nOiBub2RlLml0ZW1TcGFjaW5nLFxyXG4gICAgICAgICAgICBjb3VudGVyU3BhY2luZzogbm9kZS5jb3VudGVyQXhpc1NwYWNpbmcsXHJcbiAgICAgICAgICAgIHBhZGRpbmdMZWZ0OiBub2RlLnBhZGRpbmdMZWZ0LFxyXG4gICAgICAgICAgICBwYWRkaW5nUmlnaHQ6IG5vZGUucGFkZGluZ1JpZ2h0LFxyXG4gICAgICAgICAgICBwYWRkaW5nVG9wOiBub2RlLnBhZGRpbmdUb3AsXHJcbiAgICAgICAgICAgIHBhZGRpbmdCb3R0b206IG5vZGUucGFkZGluZ0JvdHRvbSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIG92ZXJmbG93RGlyZWN0aW9uOiBub2RlLm92ZXJmbG93RGlyZWN0aW9uLFxyXG4gICAgICAgIGNvbnN0cmFpbnRzOiBub2RlLmNvbnN0cmFpbnRzLFxyXG4gICAgICAgIHJlbGF0aXZlVHJhbnNmb3JtOiBub2RlLnJlbGF0aXZlVHJhbnNmb3JtLFxyXG4gICAgICAgIHNwcml0ZTogc3ByaXRlQXNzZXQsXHJcbiAgICAgICAgZm9udFV1aWQ6IHRleHRTb3VyY2Uuc3R5bGU/LmZvbnRGYW1pbHkgPyBmb250cy5nZXQodGV4dFNvdXJjZS5zdHlsZS5mb250RmFtaWx5KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICBhbGlhc0ZpZ21hSWRzOiBmb2xkPy5hYnNvcmJlZE5vZGVJZHMsXHJcbiAgICAgICAgZmxhdHRlbkJvdW5kYXJ5OiBiaXRtYXBUZXJtaW5hbCB8fCBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IHRydWVcclxuICAgICAgICAgICAgOiBmb2xkPy5raW5kID09PSAnYmFja2dyb3VuZCdcclxuICAgICAgICAgICAgICAgID8gZmFsc2VcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHBsYW5SZWFzb246IHBsYW4/LnJlYXNvbixcclxuICAgICAgICBjaGlsZHJlbjogdGVybWluYWxcclxuICAgICAgICAgICAgPyBbXVxyXG4gICAgICAgICAgICA6IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKSA9PiAhYWJzb3JiZWREaXJlY3RJZHMuaGFzKGNoaWxkLmlkKSlcclxuICAgICAgICAgICAgICAgIC5tYXAoKGNoaWxkKSA9PiBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBjaGlsZCxcclxuICAgICAgICAgICAgICAgICAgICBmcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgICAgICAgICApKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpOiBjaGlsZCBpcyBTY2VuZU5vZGVTcGVjID0+IGNoaWxkICE9PSBudWxsKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVNYXBzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2Nvc0ZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gRWRpdG9yLlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXHJcbiAgICAgICAgPyBnZW5lcmF0ZWRcclxuICAgICAgICA6IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnYmFzZTY0JykucmVwbGFjZSgvPSskL2csICcnKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJBc3NldCh1cmxPclV1aWQ6IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtaW5mbycsXHJcbiAgICAgICAgdXJsT3JVdWlkLFxyXG4gICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRQcmVmYWJBc3NldChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGluZm8uaW52YWxpZCB8fCBpbmZvLmltcG9ydGVkICE9PSB0cnVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLmltcG9ydGVyICE9PSAncHJlZmFiJyB8fCBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInIHx8IGluZm8uaXNEaXJlY3RvcnkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8ucmVhZG9ubHkgfHwgaW5mby5yZWRpcmVjdCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZC51dWlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnVybCAmJiBpbmZvLnVybCAhPT0gZXhwZWN0ZWQudXJsKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yUHJlZmFiQXNzZXQodXJsOiBzdHJpbmcsIGV4cGVjdGVkVXVpZD86IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbmZvPy5pbXBvcnRlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOWcqOWvvOWFpeacn+mXtOWPkeeUn+WPmOWMlu+8miR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIFByZWZhYiDotYTmupDlsLHnu6rotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJNZXRhKHV1aWQ6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgIHV1aWQsXHJcbiAgICApO1xyXG4gICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSBtZXRhIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBNZXRhIOS4juebruagh+i1hOa6kOS4jeWMuemFje+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVSTCDml6DmlYjvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICApO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmcsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgY3VycmVudERpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgaWYgKGN1cnJlbnREaXJ0eSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcclxuICAgIH1cclxuICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnb3Blbi1hc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgICAgICAgICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gc3RhdGUucmVhc29uID8/IGxhc3RSZWFzb247XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOaJk+W8gOebruaghyBQcmVmYWIg6LaF5pe277yaJHtsYXN0UmVhc29ufWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRPcGVuZWRQcmVmYWIocHJlZmFiVXVpZDogc3RyaW5nLCByb290RmlsZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTY2VuZVNhdmVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBkaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoIWRpcnR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCfnrYnlvoUgUHJlZmFiIOS/neWtmOWujOaIkOi2heaXtuOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQcmVmYWJCaW5kaW5ncygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCBwcmVmYWJVdWlkXSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHByZWZhYlV1aWQgIT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8ICFwcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcsIHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgaWYgKCFiaW5kaW5nc1tzb3VyY2VIYXNoXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywge1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8ICFyYXdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIChyYXcgYXMgeyBwcmVmYWJVdWlkPzogdW5rbm93biB9KS5wcmVmYWJVdWlkICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoe1xyXG4gICAgICAgICAgICB1c2VyRGF0YToge1xyXG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leadpea6kOS4jeS4gOiHtO+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IChyYXcgYXMgeyBwcmVmYWJVdWlkOiBzdHJpbmcgfSkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQZW5kaW5nUHJlZmFiU3luYyhcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHZhbHVlOiB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0gfCBudWxsLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcclxuICAgIGlmICh2YWx1ZSkge1xyXG4gICAgICAgIHBlbmRpbmdbc291cmNlSGFzaF0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbc291cmNlSGFzaF07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgIHBlbmRpbmcsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gdmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbik6IFByb21pc2U8eyBtZXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+IHtcclxuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICBsZXQgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICBpZiAoIXJlY29yZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYFByZWZhYiDnvLrlsJEgRmlnbWEg5p2l5rqQ6K6w5b2V77yM5peg5rOV56Gu6K6k5piv5ZCm5Y+v5a6J5YWo6KaG55uW77yaJHtpbmZvLnVybH3jgILor7flhYjnp7vliqjmiJbph43lkb3lkI3or6XotYTmupDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDmnaXoh6rlj6bkuIDkuKogRmlnbWEgRnJhbWXvvIzlt7Lmi5Lnu53opobnm5bvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBpZiAocGVuZGluZykge1xyXG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5qOA5rWL5Yiw5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7TnmoTlvoXmgaLlpI3lkIzmraXorrDlvZXvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcGVuZGluZy5yZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3ZlcmVkIHx8IEpTT04uc3RyaW5naWZ5KHJlY292ZXJlZCkgIT09IEpTT04uc3RyaW5naWZ5KHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVjb3JkID0gcmVjb3ZlcmVkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bkuI7lvZPliY3lj4rlvoXmgaLlpI3nmoTlkIzmraXorrDlvZXpg73kuI3kuIDoh7TvvIzlt7LlgZzmraLoh6rliqjmgaLlpI3jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBtZXRhLCByZWNvcmQgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBsZXQgbGFzdEVycm9yOiB1bmtub3duO1xyXG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0ICs9IDEpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflhpnlhaXliY0gUHJlZmFiIOadpea6kOiusOW9leS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWQjuagoemqjOS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcclxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTUwKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGxhc3RFcnJvciA6IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWksei0peOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZyxcclxuICAgIHJvb3RGcmFtZTogUmVjdCxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHNvdXJjZVJvb3RJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHtcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgY29uc3QgYm91bmRVdWlkID0gYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xyXG4gICAgICAgID8gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwZW5kaW5nLnByZWZhYlV1aWQpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgICAgICBwZW5kaW5nPy5wcmVmYWJVdWlkLFxyXG4gICAgICAgIGJvdW5kVXVpZCxcclxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcclxuICAgICk7XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhclBlbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyQmluZGluZykge1xyXG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gdGFyZ2V0UGxhbi50YXJnZXRVdWlkO1xyXG4gICAgaWYgKHRhcmdldFV1aWQpIHtcclxuICAgICAgICBsZXQgdGFyZ2V0SW5mbyA9IHBlbmRpbmdJbmZvPy51dWlkID09PSB0YXJnZXRVdWlkXHJcbiAgICAgICAgICAgID8gcGVuZGluZ0luZm9cclxuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xyXG4gICAgICAgICAgICBpZiAoYmluZGluZ3Nbc291cmNlSGFzaF0gPT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgaWYgKHBlbmRpbmc/LnByZWZhYlV1aWQgPT09IHRhcmdldFV1aWQgJiYgYm91bmRVdWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSByZWNvdmVyeSBpZGVudGl0eSBiZWZvcmUgdmVyaWZpZWRQcmVmYWJSZWNvcmQgbWF5XHJcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcclxuICAgICAgICAgICAgICAgIC8vIGFibGUgdG8gbG9jYXRlIHRoZSBleGFjdCBQcmVmYWIgYnkgVVVJRCBvbiB0aGUgbmV4dCBhdHRlbXB0LlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKHRhcmdldEluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0SW5mby51cmwgIT09IHByZWZhYlVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoY29uZmxpY3QgJiYgY29uZmxpY3QudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3ZlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mby51cmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW92ZWQgfHwgbW92ZWQudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGluZm86IHRhcmdldEluZm8sXHJcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCByb290RmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCByb290VHJhbnNmb3JtRmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXHJcbiAgICAgICAgICAgIHByZWZhYk5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnY3JlYXRlLWFzc2V0JyxcclxuICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICBzZWVkLFxyXG4gICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu6IFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgY3JlYXRlZC51dWlkKTtcclxuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcclxuICAgICAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICAgICAgc291cmNlUm9vdElkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShuZXh0TWV0YSwgbnVsbCwgMiksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgaW5mbyxcclxuICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaW5mbyxcclxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKGFyZ3M6IHtcclxuICAgIHJldmlld0lkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZztcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHNvdXJjZU5vZGVJZDogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn0pOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBzb3VyY2VIYXNoID0gZmlnbWFGcmFtZVNvdXJjZUhhc2goYXJncy5maWxlS2V5LCBhcmdzLnNvdXJjZU5vZGVJZCk7XHJcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgICAgICBhcmdzLnByZWZhYlVybCxcclxuICAgICAgICBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICB4OiBhcmdzLnJvb3RGcmFtZS54ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgeTogYXJncy5yb290RnJhbWUueSAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHdpZHRoOiBhcmdzLnJvb3RGcmFtZS53aWR0aCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIGhlaWdodDogYXJncy5yb290RnJhbWUuaGVpZ2h0ICogYXJncy5zY2FsZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgYXJncy5yb290c1swXS5maWdtYUlkLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGV4aXN0aW5nTm9kZUZpbGVJZHMgPSByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyhcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQsXHJcbiAgICAgICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzKGFyZ3Mucm9vdHMpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICByZXZpZXdJZDogYXJncy5yZXZpZXdJZCxcclxuICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBmaWxlS2V5OiBhcmdzLmZpbGVLZXksXHJcbiAgICAgICAgcm9vdE5hbWU6IGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICByb290RnJhbWU6IGFyZ3Mucm9vdEZyYW1lLFxyXG4gICAgICAgIHNjYWxlOiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIGV4aXN0aW5nTWFwOiB7fSxcclxuICAgICAgICBwcmVmYWJVcmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHJvb3RzOiBhcmdzLnJvb3RzLFxyXG4gICAgICAgIHByZWZhYkNvbnRleHQ6IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkOiBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgZXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZE5vZGVGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZE5vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkQ29tcG9uZW50RmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRDb21wb25lbnRGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkSGVscGVyRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWRIZWxwZXJGaWxlSWRzLFxyXG4gICAgICAgIH0sXHJcbiAgICB9O1xyXG4gICAgbGV0IHNuYXBzaG90U3RhcnRlZCA9IGZhbHNlO1xyXG4gICAgbGV0IHNhdmVBdHRlbXB0ZWQgPSBmYWxzZTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgZGlydHlCZWZvcmVJbXBvcnQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICAgICAgaWYgKGRpcnR5QmVmb3JlSW1wb3J0KSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign55uu5qCHIFByZWZhYiDmnInmnKrkv53lrZjnmoTmiYvlt6Xkv67mlLnvvIzor7flhYjkv53lrZjlkI7lho3miafooYwgRmlnbWEg5aKe6YeP5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgc25hcHNob3RTdGFydGVkID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgaWYgKCFyZXN1bHQucHJlZmFiU3luYykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXmnKrov5Tlm54gZmlsZUlkIOiusOW9le+8jOW3suWBnOatouS/neWtmOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBuZXh0UmVjb3JkID0gcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUocHJlcGFyZWQucmVjb3JkLCByZXN1bHQucHJlZmFiU3luYyk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZDogbmV4dFJlY29yZCxcclxuICAgICAgICB9KTtcclxuICAgICAgICBhd2FpdCBhc3NlcnRPcGVuZWRQcmVmYWIocHJlcGFyZWQuaW5mby51dWlkLCBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCk7XHJcbiAgICAgICAgLy8gT25jZSB0aGUgc2F2ZSByZXF1ZXN0IGlzIHNlbnQgaXRzIHJlc3VsdCBpcyBhbWJpZ3VvdXMgdW50aWwgdGhlXHJcbiAgICAgICAgLy8gcGVyc2lzdGVkIFByZWZhYiBpcyB2ZXJpZmllZC4gRG8gbm90IHJvbGwgdGhlIGluLW1lbW9yeSBQcmVmYWIgYmFja1xyXG4gICAgICAgIC8vIG9uIGFuIElQQyB0aW1lb3V0OiB0aGUgZGlzayB3cml0ZSBtYXkgYWxyZWFkeSBoYXZlIGNvbXBsZXRlZC5cclxuICAgICAgICBzYXZlQXR0ZW1wdGVkID0gdHJ1ZTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvclNjZW5lU2F2ZWQoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCwgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoY3VycmVudEluZm8sIG5leHRSZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuacquWMheWQq+acrOasoeWQjOatpeeUn+aIkOeahOWFqOmDqCBmaWxlSWTvvIzlt7LlgZzmraLmm7TmlrAgTWV0YeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXJyZW50TWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShjdXJyZW50SW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50UmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoY3VycmVudE1ldGEpO1xyXG4gICAgICAgIGlmICghY3VycmVudFJlY29yZCB8fCBjdXJyZW50UmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5Zyo5L+d5a2Y5pyf6Ze05Y+R55Sf5Y+Y5YyW77yM5bey5ouS57ud5o+Q5Lqk44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoY3VycmVudEluZm8sIHNvdXJjZUhhc2gsIG5leHRSZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVwYXJlZC5pbmZvLnVybCk7XHJcbiAgICAgICAgaWYgKCF2ZXJpZmllZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+S/neWtmOWQjiBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQodmVyaWZpZWQsIHtcclxuICAgICAgICAgICAgdXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICB1cmw6IHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJlc3VsdC5wcmVmYWJVcmwgPSBwcmVwYXJlZC5pbmZvLnVybDtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLmNsZWFyKCdub2RlJyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlcGFyZWQuaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBpZiAoc25hcHNob3RTdGFydGVkICYmICFzYXZlQXR0ZW1wdGVkKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90LWFib3J0JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcmZvcm1JbXBvcnQocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uT3duZXI6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3QgZG9jdW1lbnQgPSBhY3RpdmVEb2N1bWVudDtcclxuICAgIGlmICghZG9jdW1lbnQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ivt+WFiOivu+WPliBGaWdtYSDmlofku7bjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGltcG9ydFNldHRpbmdzID0gc2FmZVNldHRpbmdzKHJlcXVlc3Quc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKG9wZXJhdGlvbk93bmVyKTtcclxuICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCflr7zlhaXku7vliqEnLCB7IHJvb3RzOiBkb2N1bWVudC5yb290cy5tYXAoKG5vZGUpID0+ICh7IGlkOiBub2RlLmlkLCBuYW1lOiBub2RlLm5hbWUgfSkpIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfliIbmnpDlubblh4blpIfotYTmupDigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9ucyA9IGRlY2lzaW9uTWFwKHJlcXVlc3Qub3ZlcnJpZGVzLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCByZXZpZXdEb2N1bWVudCA9IGRvY3VtZW50O1xyXG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZSgpO1xyXG4gICAgICAgIGNvbnN0IHJldmlld1JlY29yZGVyID0gbmV3IEltcG9ydFJldmlld1JlY29yZGVyKCk7XHJcbiAgICAgICAgY29uc3QgYnVpbHRBc3NldHMgPSBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSH5YWo6YOo6LWE5rqQJywgdW5kZWZpbmVkLCAoKSA9PiBidWlsZEFzc2V0cyhkb2N1bWVudCwgZGVjaXNpb25zLCBpbXBvcnRTZXR0aW5ncywgcmV2aWV3UmVjb3JkZXIpKTtcclxuICAgICAgICBjb25zdCB7IGFzc2V0cywgd2FybmluZ3MgfSA9IGJ1aWx0QXNzZXRzO1xyXG4gICAgICAgIGNvbnN0IGF0dGFjaFJldmlldyA9IGFzeW5jIChyZXN1bHQ6IFNjZW5lSW1wb3J0UmVzdWx0KSA9PiB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5yZXZpZXcgPSBhd2FpdCBmaW5hbGl6ZUltcG9ydFJldmlldyhpbXBvcnRSZXZpZXdzLCByZXZpZXdSZWNvcmRlciwgcmV2aWV3RG9jdW1lbnQsXHJcbiAgICAgICAgICAgICAgICByZXN1bHQucmV2aWV3QmVmb3JlLCByZXN1bHQucmV2aWV3QWZ0ZXIsIHJlc3VsdC5wcmVmYWJVcmwsIHdhcm5pbmdzLFxyXG4gICAgICAgICAgICAgICAgYXN5bmMgKCkgPT4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSwgbWV0aG9kOiAncmVmcmVzaFJldmlld0FmdGVyJywgYXJnczogW3sgaWQ6IHJldmlld1JlY29yZGVyLmlkIH1dLFxyXG4gICAgICAgICAgICAgICAgfSkgYXMgUmV2aWV3U2NlbmUpO1xyXG4gICAgICAgICAgICAvLyBBbHNvIGNvdmVyIG1hbnVhbCBpbXBvcnRzIHdob3NlIHBhbmVsIHdhcyBjbG9zZWQgd2hpbGUgaW1wb3J0aW5nLlxyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLm9wZW4ocGFja2FnZUpTT04ubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdpbXBvcnQtcmV2aWV3LXJlYWR5JywgcmVzdWx0LnJldmlldyk7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5wdXNoKGDnu5Pmnpzlt7Lkv53lrZjvvIzkvYboh6rliqjmiZPlvIDpnaLmnb/lpLHotKXvvIzor7fku47mj5Lku7bkuK3miZPlvIDigJzlr7zlhaXnu5Pmnpzmo4Dmn6XigJ3vvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0JlZm9yZTtcclxuICAgICAgICAgICAgZGVsZXRlIHJlc3VsdC5yZXZpZXdBZnRlcjtcclxuICAgICAgICB9O1xyXG4gICAgICAgIC8vIGJ1aWxkQXNzZXRzIG1heSBwcm9tb3RlIGEgY29udGFpbmVyIHRvIGEgbG9jYWwgc2FtZS1uYW1lIHJlc291cmNlLlxyXG4gICAgICAgIC8vIENvbXBpbGUgYWZ0ZXIgdGhhdCBwcm9tb3Rpb24gc28gYXNzZXRzIGFuZCBTY2VuZU5vZGVTcGVjIHNoYXJlIHRoZVxyXG4gICAgICAgIC8vIGV4YWN0IHNhbWUgZmluYWwgcGxhbi5cclxuICAgICAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKGRvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IGZvbnRzID0gYXdhaXQgcmVzb2x2ZUZvbnRzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBjb25zdCBzb3VyY2VSb290RnJhbWVzID0gZG9jdW1lbnQucm9vdHMubWFwKG5vZGVGcmFtZSk7XHJcbiAgICAgICAgY29uc3QgbXVsdGlwbGVSb290cyA9IGRvY3VtZW50LnJvb3RzLmxlbmd0aCA+IDE7XHJcbiAgICAgICAgY29uc3QgYXJyYW5nZWRXaWR0aCA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyBzb3VyY2VSb290RnJhbWVzLnJlZHVjZSgodG90YWwsIGZyYW1lKSA9PiB0b3RhbCArIGZyYW1lLndpZHRoLCAwKVxyXG4gICAgICAgICAgICAgICAgKyBNYXRoLm1heCgwLCBzb3VyY2VSb290RnJhbWVzLmxlbmd0aCAtIDEpICogMTYwXHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXT8ud2lkdGggPz8gMDtcclxuICAgICAgICBjb25zdCByb290RnJhbWUgPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgeDogMCxcclxuICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogYXJyYW5nZWRXaWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogTWF0aC5tYXgoMCwgLi4uc291cmNlUm9vdEZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0gPz8geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICAgICAgbGV0IHJvb3RDdXJzb3IgPSAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gZG9jdW1lbnQucm9vdHNcclxuICAgICAgICAgICAgLm1hcCgobm9kZSwgaW5kZXgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHNwZWMgPSBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQubm9kZUJ5SWQsXHJcbiAgICAgICAgICAgICAgICAgICAgYXNzZXRzLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvbnRzLFxyXG4gICAgICAgICAgICAgICAgICAgIHRydWUsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNwZWMgJiYgbXVsdGlwbGVSb290cykge1xyXG4gICAgICAgICAgICAgICAgICAgIHNwZWMuZnJhbWUgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IHJvb3RDdXJzb3IsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdpZHRoOiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiBzb3VyY2VSb290RnJhbWVzW2luZGV4XS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgICByb290Q3Vyc29yICs9IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoICsgMTYwO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNwZWM7XHJcbiAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKG5vZGUpOiBub2RlIGlzIFNjZW5lTm9kZVNwZWMgPT4gbm9kZSAhPT0gbnVsbCk7XHJcbiAgICAgICAgaWYgKCFyb290cy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmsqHmnInpgInkuK3ku7vkvZXlj6/lr7zlhaXoioLngrnjgIInKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHNvdXJjZU5vZGVJZCA9IGRvY3VtZW50LnNvdXJjZU5vZGVJZDtcclxuICAgICAgICBpZiAoc291cmNlTm9kZUlkICYmIHJvb3RzLmxlbmd0aCA9PT0gMSkge1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJXcml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MucHJlZmFiRm9sZGVyKTtcclxuICAgICAgICAgICAgYXdhaXQgcHJlZmFiV3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgICAgICAgICAgY29uc3QgZnJhbWVOYW1lID0gcm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQucm9vdHNbMF0/Lm5hbWU/LnRyaW0oKVxyXG4gICAgICAgICAgICAgICAgfHwgZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYlVybCA9IGBkYjovL2Fzc2V0cy8ke3ByZWZhYldyaXRlci5mb2xkZXJ9LyR7c2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKX0ucHJlZmFiYDtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnc2NlbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDAuMDUsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiAn5q2j5Zyo5Yib5bu65oiW5omT5byA55uu5qCHIFByZWZhYuKApicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYih7XHJcbiAgICAgICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICBwcmVmYWJOYW1lOiBmcmFtZU5hbWUsXHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgc291cmNlTm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgICAgIC8vIFByZWZhYiB1cGRhdGVzIHBlcnNpc3QgYnkgUHJlZmFiSW5mby5maWxlSWQgaW4gdGhlIGFzc2V0IG1ldGE7XHJcbiAgICAgICAgICAgIC8vIHJ1bnRpbWUgbm9kZSBVVUlEcyBhcmUgc2Vzc2lvbi1vbmx5IGFuZCBtdXN0IG5ldmVyIGJlIHJldXNlZCBoZXJlLlxyXG4gICAgICAgICAgICBkZWxldGUgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV07XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfe+8jOW3suaJk+W8gOmihOWItuS9kyAke3ByZWZhYlVybH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGZpbmFsUmVzdWx0O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgcmV2aWV3SWQ6IHJldmlld1JlY29yZGVyLmlkLFxyXG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgcm9vdE5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGltcG9ydFNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxyXG4gICAgICAgICAgICBleGlzdGluZ01hcDogbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPz8ge30sXHJcbiAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLjEsIG1lc3NhZ2U6ICfmraPlnKjmnoTlu7ogQ29jb3Mg6IqC54K55qCR4oCmJyB9KTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA9IHJlc3VsdC5ub2RlTWFwO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ25vZGUnLCByZXN1bHQucm9vdFV1aWQpO1xyXG4gICAgICAgIGlmIChpbXBvcnRTZXR0aW5ncy5hdXRvU2F2ZSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IGF0dGFjaFJldmlldyhyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcclxuICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH0ke3dhcm5pbmdzLmxlbmd0aCA/IGDvvJske3dhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekumAgOiAnJ31gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRyYWNlLmRvbmUoKTtcclxuICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWPlua2iOOAgicgfSk7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5pON5L2c5bey5Y+W5raI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIHRyYWNlLmV2ZW50KCflkI7lj7Dku7vliqHlt7Lph4rmlL4nKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TWNwUGx1Z2luU3RhdGUoKSB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2ZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcclxuICAgICAgICBzZXR0aW5nczogYXdhaXQgZ2V0U2V0dGluZ3MoKSxcclxuICAgICAgICBkb2N1bWVudDogZG9jdW1lbnQgPyB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlczogYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSxcclxuICAgICAgICB9IDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBsdWdpblN0YXRlKCkge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5hd2FpdCBnZXRNY3BQbHVnaW5TdGF0ZSgpLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5YgRmlnbWEg5paH5Lu24oCmJyB9KTtcclxuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0gcGFyc2VkLm5vZGVJZFxyXG4gICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxyXG4gICAgICAgICAgICA6IGF3YWl0IGFwaS5nZXRGaWxlKHBhcnNlZC5maWxlS2V5KTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKFxyXG4gICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGNvbnN0IG5vZGVPdmVycmlkZXMgPSBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiBg5bey6K+75Y+WICR7ZG9jdW1lbnQuZmlsZU5hbWV9YCB9KTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBmb250QXNzZXRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIH07XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50Py5ub2RlQnlJZC5nZXQobm9kZUlkKTtcclxuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgIDEsXHJcbiAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgZ2V0SW1wb3J0UmV2aWV3KCkgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5nZXQoKTsgfSxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1ByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLnByZXZpZXcoaWQsIGFzc2V0SWQpOyB9LFxyXG4gICAgYXN5bmMgYXBwbHlJbXBvcnRSZXZpZXcoaWQ6IHN0cmluZywgcmVtb3ZlZElkczogdW5rbm93bikge1xyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeWvvOWFpeaIliBGaWdtYSDpooTop4jlrozmiJDjgIInKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICBhcHBseWluZ0ltcG9ydFJldmlldyA9IHRydWU7XHJcbiAgICAgICAgdHJ5IHsgcmV0dXJuIGF3YWl0IGltcG9ydFJldmlld3MuYXBwbHkoaWQsIHJlbW92ZWRJZHMpOyB9XHJcbiAgICAgICAgZmluYWxseSB7IGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gZmFsc2U7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1NvdXJjZVByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nLCBub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeaTjeS9nOWujOaIkOWQjuWGjeWKoOi9veadpea6kOmihOiniOOAgicpO1xyXG4gICAgICAgIGNvbnN0IHsgZmlsZUtleSwgbm9kZSB9ID0gaW1wb3J0UmV2aWV3cy5zb3VyY2UoaWQsIGFzc2V0SWQsIG5vZGVJZCk7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgaWYgKGltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBmaWxscyA9IGF3YWl0IGFwaS5nZXRJbWFnZUZpbGxVcmxzKGZpbGVLZXkpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGZpbGxzW2ltYWdlUmVmXSkgcmV0dXJuIHsgdXJsOiBmaWxsc1tpbWFnZVJlZl0sIG5vdGU6ICdGaWdtYSDljp/lm77vvIjmnKrlkIjmiJDoioLngrnmlYjmnpzvvIknIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IGFwaS5nZXRJbWFnZVVybHMoZmlsZUtleSwgW25vZGUuaWRdLCAncG5nJywgMSwgIW92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSkpO1xyXG4gICAgICAgICAgICBpZiAoIXVybHNbbm9kZS5pZF0pIHRocm93IG5ldyBFcnJvcignRmlnbWEg5pyq6L+U5Zue6aKE6KeI77yM6ZqQ6JeP5oiW5aSN5p2C5pWI5p6c6IqC54K55Y+v6IO95peg5rOV5Y2V54us5riy5p+T44CCJyk7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHVybDogdXJsc1tub2RlLmlkXSwgbm90ZTogJ0ZpZ21hIOW9k+WJjeiKgueCuea4suafk++8iOmakOiXj+elluWFiOWPr+iDveS9v+mihOiniOmAj+aYju+8iScgfTtcclxuICAgICAgICB9IGZpbmFsbHkgeyBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7IH1cclxuICAgIH0sXHJcbiAgICBvcGVuUGFuZWwoKSB7XHJcbiAgICAgICAgRWRpdG9yLlBhbmVsLm9wZW4ocGFja2FnZUpTT04ubmFtZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFN0YXRlKCkge1xyXG4gICAgICAgIHJldHVybiBnZXRQbHVnaW5TdGF0ZSgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzZXRUb2tlbih2YWx1ZTogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LnNldCh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGNsZWFyVG9rZW4oKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LmNsZWFyKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHZlcmlmeVRva2VuKCkge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkZW50aXR5ID0gYXdhaXQgKGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCkpLnZlcmlmeSgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBoYW5kbGU6IGlkZW50aXR5LmhhbmRsZSB8fCAnRmlnbWEgVXNlcicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVTZXR0aW5ncyh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXk6IHVua25vd24sIG92ZXJyaWRlczogdW5rbm93biwgc2NvcGVJZHM6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleSwgb3ZlcnJpZGVzLCBzY29wZUlkcyk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tBc3NldEZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tDYWNoZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBmZXRjaERvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRQcmV2aWV3KG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldE5vZGVQcmV2aWV3KG5vZGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcERldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5kZXRlY3Qoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wcmV2aWV3KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFBhaXIocGFpclRva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wYWlyKHBhaXJUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwQXBwbHkocHJldmlld1Rva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcclxuICAgICAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCkge1xyXG4gICAgICAgIHJldHVybiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QpO1xyXG4gICAgfSxcclxuXHJcbiAgICBjYW5jZWxJbXBvcnQoKSB7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydE1jcEJyaWRnZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XHJcblxyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxyXG4gICAgICAgIGlzSW1wb3J0QnVzeTogKCkgPT4gYWN0aXZlQ29udHJvbGxlciAhPT0gbnVsbCxcclxuICAgICAgICBnZXRTdGF0ZTogZ2V0TWNwUGx1Z2luU3RhdGUsXHJcbiAgICAgICAgZmV0Y2hEb2N1bWVudDogZmV0Y2hGaWdtYURvY3VtZW50LFxyXG4gICAgICAgIGdldFByZXZpZXc6IGdldE5vZGVQcmV2aWV3LFxyXG4gICAgICAgIHNhdmVTZXR0aW5ncyxcclxuICAgICAgICBwYXRjaFNldHRpbmdzLFxyXG4gICAgICAgIHNhdmVOb2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIHBhdGNoTm9kZU5hbWVzLFxyXG4gICAgICAgIGltcG9ydFNlbGVjdGlvbjogKHJlcXVlc3QsIG9wZXJhdGlvbklkKSA9PiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QsIG9wZXJhdGlvbklkKSxcclxuICAgICAgICBjYW5jZWxJbXBvcnQ6IChvcGVyYXRpb25JZCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIWFjdGl2ZUNvbnRyb2xsZXIgfHwgYWN0aXZlT3BlcmF0aW9uT3duZXIgIT09IG9wZXJhdGlvbklkKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIuYWJvcnQoKTtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYnJpZGdlID0gbmV3IE1jcEJyaWRnZVNlcnZlcih7XHJcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgcGx1Z2luVmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICBwbHVnaW5JbnN0YW5jZUlkLFxyXG4gICAgICAgIGludm9rZTogKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpID0+IGFwaS5pbnZva2UobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCksXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLnN0YXJ0KCk7XHJcbiAgICAgICAgbWNwQXBpID0gYXBpO1xyXG4gICAgICAgIG1jcEJyaWRnZSA9IGJyaWRnZTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLmNsb3NlKCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBGaWdtYSBJbXBvcnRlciBNQ1AgQnJpZGdlIOWQr+WKqOWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyhFZGl0b3IuUHJvamVjdC5wYXRoLCBlZGl0b3JSZWltcG9ydGVyKTtcclxuICAgICAgICBjb25zdCBhY3RpdmUgPSByZWNvdmVyZWQuZmlsdGVyKChyZXN1bHQpID0+IHJlc3VsdC5zdGF0dXMgPT09ICdhY3RpdmUtb3duZXInKTtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBhY3RpdmUubGVuZ3RoXHJcbiAgICAgICAgICAgID8gYOajgOa1i+WIsCAke2FjdGl2ZS5sZW5ndGh9IOS4quS7jeeUsea0u+WKqOi/m+eoi+aMgeacieeahCBSb3VuZC10cmlwIOS6i+WKoe+8jOaaguaXtuemgeatoiBQYWlyL0FwcGx544CCYFxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGBSb3VuZC10cmlwIOWQr+WKqOaBouWkjeWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0YXJ0TWNwQnJpZGdlKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbiAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIHZvaWQgYnJpZGdlPy5jbG9zZSgpLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5YWz6Zet5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfSk7XHJcbn1cclxuIl19