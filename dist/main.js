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
                existingAsset = await writer.existing(writer.buildTiledUrl(group.node.name, group.assetKey, 'png'), true);
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
            const existing = !importSettings.refreshAssets ? await writer.existing(url) : null;
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
                url,
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
                : await writer.existing(url);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXFkQSx3REFnQkM7QUE4QkQsa0NBeUJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBK0RELGtDQWdoQkM7QUF3Q0QsNEJBc0dDO0FBMi9CRCxvQkFhQztBQUVELHdCQVlDO0FBNTVFRCwrQkFBOEU7QUFDOUUsMkJBQWdDO0FBQ2hDLG1DQUFxQztBQUNyQywrQ0FBZ0U7QUFDaEUsMENBQWdEO0FBQ2hELG1FQUEwQztBQUMxQywyQ0FBOEU7QUFDOUUsK0NBVTBCO0FBQzFCLDJDQUErQztBQUMvQywyREFHZ0M7QUFDaEMsNkNBQXVFO0FBQ3ZFLHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHNEQUF1RDtBQUN2RCxvREFBMEY7QUFDMUYsd0RBWWdDO0FBQ2hDLHdEQUFvRDtBQUNwRCx1Q0FBdUU7QUFDdkUsZ0RBQXNEO0FBQ3RELGlEQUF1RDtBQUN2RCxtREFBc0U7QUFDdEUseURBQTJEO0FBQzNELG1DQW1CaUI7QUFDakIsMkNBQStDO0FBQy9DLDREQUFxRjtBQUNyRiw4RUFBeUU7QUFHekUsTUFBTSxLQUFLLEdBQUcsSUFBSSx3QkFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsTUFBTSxhQUFhLEdBQUcsSUFBSSxtQ0FBbUIsRUFBRSxDQUFDO0FBQ2hELElBQUksb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0FBQ2pDLElBQUksY0FBYyxHQUEyQixJQUFJLENBQUM7QUFDbEQsSUFBSSxnQkFBZ0IsR0FBMkIsSUFBSSxDQUFDO0FBQ3BELElBQUksb0JBQW9CLEdBQWtCLElBQUksQ0FBQztBQUMvQyxJQUFJLG1CQUFtQixHQUEyQixJQUFJLENBQUM7QUFDdkQsSUFBSSxhQUFhLEdBQTBCLElBQUks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QU0sR0FBRyxLQUFLLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBaUIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JGLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDakIsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUMvQyxDQUFDO0lBQ0QsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN4RSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUMxRSxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO0FBQzFELENBQUM7QUFF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LENBQUMsQ0FBQyxPQUFPLE1BQU0sQ0FBQyxNQUFNLDRDQUE0QztZQUNsRSxDQUFDLENBQUMsSUFBSSxDQUFDO0lBQ2YsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDYix3QkFBd0IsR0FBRyxxQkFBcUIsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFDRCxNQUFNLGNBQWMsRUFBRSxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFnQixNQUFNO0lBQ2xCLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLEtBQUssRUFBRSxDQUFDO0lBQzFCLGdCQUFnQixHQUFHLElBQUksQ0FBQztJQUN4QixvQkFBb0IsR0FBRyxJQUFJLENBQUM7SUFDNUIsY0FBYyxHQUFHLElBQUksQ0FBQztJQUN0QixnQkFBZ0IsSUFBSSxDQUFDLENBQUM7SUFDdEIsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDO0lBQ3pCLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFDakIsTUFBTSxHQUFHLElBQUksQ0FBQztJQUNkLEtBQUssQ0FBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsS0FBSyxHQUFHLEtBQUssQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQ2pDLE9BQU8sQ0FBQyxLQUFLLENBQUMsa0NBQWtDLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDdkcsQ0FBQyxDQUFDLENBQUEsQ0FBQztBQUNQLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBiYXNlbmFtZSwgZXh0bmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUgfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdjcnlwdG8nO1xyXG5pbXBvcnQgeyBkaWFnbm9zdGljU3RhcnQsIGRpYWdub3N0aWNUYXNrIH0gZnJvbSAnLi9kaWFnbm9zdGljcyc7XHJcbmltcG9ydCB7IHJlYWRGaWxlLCByZWFkZGlyIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgRmlnbWFDbGllbnQsIENhbmNlbGxlZEVycm9yLCBjbGFtcEltYWdlU2NhbGUgfSBmcm9tICcuL2ZpZ21hL2NsaWVudCc7XHJcbmltcG9ydCB7XHJcbiAgICBoYXNIaWRkZW5EZXNjZW5kYW50LFxyXG4gICAgaW5mZXJBY3Rpb24sXHJcbiAgICBpbmZlckNvY29zTGF5b3V0TW9kZSxcclxuICAgIGluZmVyS2luZCxcclxuICAgIGlzUGF0Y2hDYW5kaWRhdGUsXHJcbiAgICBpc1ZlY3Rvck5vZGUsXHJcbiAgICBuYXRpdmVUaWxlZFBhaW50U291cmNlLFxyXG4gICAgcGxhaW5JbWFnZVNvdXJjZVJlZixcclxuICAgIHR5cGUgVGlsZWRQYWludFNvdXJjZSxcclxufSBmcm9tICcuL2ZpZ21hL2FuYWx5emVyJztcclxuaW1wb3J0IHsgcGFyc2VEb2N1bWVudCB9IGZyb20gJy4vZmlnbWEvcGFyc2VyJztcclxuaW1wb3J0IHtcclxuICAgIGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuLFxyXG4gICAgY29tcGlsZUltcG9ydFBsYW4sXHJcbn0gZnJvbSAnLi9maWdtYS9pbXBvcnQtcGxhbm5lcic7XHJcbmltcG9ydCB7IGFuYWx5emVTbGljZUdyaWQsIHR5cGUgU2xpY2VBbmFseXNpcyB9IGZyb20gJy4vZmlnbWEvc2xpY2luZyc7XHJcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHtcclxuICAgIEFzc2V0V3JpdGVyLFxyXG4gICAgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMsXHJcbiAgICBkZXRlY3RJbWFnZUV4dGVuc2lvbixcclxuICAgIHJlc29sdmVBc3NldFV1aWQsXHJcbiAgICBzYW5pdGl6ZUFzc2V0TmFtZSxcclxuICAgIHR5cGUgUmFzdGVySW1hZ2VFeHRlbnNpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgeyBMb2NhbEFzc2V0Q2FjaGUsIHR5cGUgQ2FjaGVFbnRyeUtleSB9IGZyb20gJy4vaW1wb3J0ZXIvY2FjaGUnO1xyXG5pbXBvcnQgdHlwZSB7IEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBMb2NhbFJlc291cmNlTGlicmFyeSB9IGZyb20gJy4vaW1wb3J0ZXIvbG9jYWwtcmVzb3VyY2VzJztcclxuaW1wb3J0IHsgZ3JhZGllbnRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3N2Zyc7XHJcbmltcG9ydCB7IHdyaXRlU2xpY2VkUG5nIH0gZnJvbSAnLi9pbXBvcnRlci9zbGljZWQtcG5nJztcclxuaW1wb3J0IHsgcGl4ZWxTaXplZFRpbGVBc3NldCwgcmFzdGVyaXplVGlsZSwgdGlsZWRSYXN0ZXJLZXkgfSBmcm9tICcuL2ltcG9ydGVyL3RpbGVkLXBuZyc7XHJcbmltcG9ydCB7XHJcbiAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMsXHJcbiAgICBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbixcclxuICAgIGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBmaWdtYUZyYW1lU291cmNlSGFzaCxcclxuICAgIG1lcmdlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldCxcclxuICAgIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQsXHJcbiAgICByZWFkUHJlZmFiU3luY1JlY29yZCxcclxuICAgIHJlY29yZFByZWZhYlN5bmNDYXB0dXJlLFxyXG4gICAgcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICB0eXBlIFByZWZhYlN5bmNSZWNvcmQsXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9wcmVmYWItc3luYyc7XHJcbmltcG9ydCB7IFRva2VuVmF1bHQgfSBmcm9tICcuL3NlY3VyaXR5L3Rva2VuLXZhdWx0JztcclxuaW1wb3J0IHsgRmlnbWFJbXBvcnRlck1jcEFwaSwgdHlwZSBNY3BOb2RlTmFtZVBhdGNoIH0gZnJvbSAnLi9tY3AtYXBpJztcclxuaW1wb3J0IHsgTWNwQnJpZGdlU2VydmVyIH0gZnJvbSAnLi9tY3AtYnJpZGdlL3NlcnZlcic7XHJcbmltcG9ydCB7IFJvdW5kdHJpcFNlcnZpY2UgfSBmcm9tICcuL3JvdW5kdHJpcC9zZXJ2aWNlJztcclxuaW1wb3J0IHsgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zIH0gZnJvbSAnLi9yb3VuZHRyaXAvcmVjb3ZlcnknO1xyXG5pbXBvcnQgeyBlZGl0b3JSZWltcG9ydGVyIH0gZnJvbSAnLi9yb3VuZHRyaXAvdHJhbnNhY3Rpb24nO1xyXG5pbXBvcnQge1xyXG4gICAgREVGQVVMVF9TRVRUSU5HUyxcclxuICAgIHR5cGUgRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgdHlwZSBGaWdtYU5vZGUsXHJcbiAgICB0eXBlIEltcG9ydEFjdGlvbixcclxuICAgIHR5cGUgSW1wb3J0RGVjaXNpb24sXHJcbiAgICB0eXBlIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgdHlwZSBJbXBvcnRSZXF1ZXN0LFxyXG4gICAgdHlwZSBJbXBvcnRTZXR0aW5ncyxcclxuICAgIHR5cGUgTm9kZUtpbmQsXHJcbiAgICB0eXBlIE5vZGVJbXBvcnRQbGFuLFxyXG4gICAgdHlwZSBQcmVmYWJFZGl0aW5nU3RhdGUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NhcHR1cmUsXHJcbiAgICB0eXBlIFByZWZhYlNjZW5lU3luY0NvbnRleHQsXHJcbiAgICB0eXBlIFByb2dyZXNzRXZlbnQsXHJcbiAgICB0eXBlIFJlY3QsXHJcbiAgICB0eXBlIFNjZW5lTm9kZVNwZWMsXHJcbiAgICB0eXBlIFNwcml0ZUFzc2V0U3BlYyxcclxuICAgIHR5cGUgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuL25vZGUtbmFtZSc7XHJcbmltcG9ydCB7IEltcG9ydFJldmlld1JlY29yZGVyLCBJbXBvcnRSZXZpZXdTZXJ2aWNlIH0gZnJvbSAnLi9pbXBvcnRlci9pbXBvcnQtcmV2aWV3JztcclxuaW1wb3J0IHsgZmluYWxpemVJbXBvcnRSZXZpZXcgfSBmcm9tICcuL2ltcG9ydGVyL2ltcG9ydC1yZXZpZXctZmluYWxpemUnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldywgUmV2aWV3U2NlbmUgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxuY29uc3QgaW1wb3J0UmV2aWV3cyA9IG5ldyBJbXBvcnRSZXZpZXdTZXJ2aWNlKCk7XHJcbmxldCBhcHBseWluZ0ltcG9ydFJldmlldyA9IGZhbHNlO1xyXG5sZXQgYWN0aXZlRG9jdW1lbnQ6IERvY3VtZW50U2Vzc2lvbiB8IG51bGwgPSBudWxsO1xyXG5sZXQgYWN0aXZlQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVPcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IHNldHRpbmdzQ2FjaGU6IEltcG9ydFNldHRpbmdzIHwgbnVsbCA9IG51bGw7XHJcbmxldCByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZG9jdW1lbnRSZXZpc2lvbiA9IDA7XHJcbmxldCBtY3BCcmlkZ2U6IE1jcEJyaWRnZVNlcnZlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgbWNwQXBpOiBGaWdtYUltcG9ydGVyTWNwQXBpIHwgbnVsbCA9IG51bGw7XHJcbmNvbnN0IHBsdWdpbkluc3RhbmNlSWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG5sZXQgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgc2V0dGluZ3NXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcblxyXG50eXBlIERlY2lzaW9uID0gSW1wb3J0RGVjaXNpb247XHJcblxyXG5pbnRlcmZhY2UgVGlsZWRBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgc291cmNlOiBUaWxlZFBhaW50U291cmNlO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUmF3SW1hZ2VBc3NldFJlcXVlc3Qge1xyXG4gICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgaW1hZ2VSZWY6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UGF5bG9hZCB7XHJcbiAgICByZXZpZXdJZD86IHN0cmluZztcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XHJcbiAgICByZXZpZXdCZWZvcmU/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlld0FmdGVyPzogUmV2aWV3U2NlbmU7XHJcbiAgICByZXZpZXc/OiBJbXBvcnRSZXZpZXc7XHJcbiAgICByb290VXVpZDogc3RyaW5nO1xyXG4gICAgbm9kZU1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIGNyZWF0ZWQ6IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ6IG51bWJlcjtcclxuICAgIHRlbXBvcmFyeVJvb3Q/OiBib29sZWFuO1xyXG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xyXG4gICAgcHJlZmFiU3luYz86IFByZWZhYlNjZW5lU3luY0NhcHR1cmU7XHJcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQXNzZXRCdWlsZFJlc3VsdCB7XHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz47XHJcbiAgICB3YXJuaW5nczogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBQcmVmYWJBc3NldEluZm8ge1xyXG4gICAgdXVpZDogc3RyaW5nO1xyXG4gICAgdXJsOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlcjogc3RyaW5nO1xyXG4gICAgdHlwZTogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZWQ6IGJvb2xlYW47XHJcbiAgICBpbnZhbGlkOiBib29sZWFuO1xyXG4gICAgaXNEaXJlY3Rvcnk/OiBib29sZWFuO1xyXG4gICAgcmVhZG9ubHk/OiBib29sZWFuO1xyXG4gICAgcmVkaXJlY3Q/OiB1bmtub3duO1xyXG59XHJcblxyXG5jb25zdCBGT05UX0VYVEVOU0lPTlMgPSBuZXcgU2V0KFsnLnR0ZicsICcub3RmJywgJy5mbnQnLCAnLndvZmYnLCAnLndvZmYyJ10pO1xyXG5jb25zdCBOT0RFX0tJTkRTID0gbmV3IFNldDxOb2RlS2luZD4oW1xyXG4gICAgJ2F1dG8nLFxyXG4gICAgJ25vZGUnLFxyXG4gICAgJ3Nwcml0ZScsXHJcbiAgICAnbGFiZWwnLFxyXG4gICAgJ3JpY2hUZXh0JyxcclxuICAgICdidXR0b24nLFxyXG4gICAgJ3Njcm9sbFZpZXcnLFxyXG4gICAgJ2xheW91dCcsXHJcbl0pO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gbGlzdEZvbnRBc3NldHMoKTogUHJvbWlzZTxGb250QXNzZXRPcHRpb25bXT4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgZm9udHM6IEZvbnRBc3NldE9wdGlvbltdID0gW107XHJcbiAgICBhc3luYyBmdW5jdGlvbiB2aXNpdChmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGxldCBlbnRyaWVzO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKGZvbGRlciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xyXG4gICAgICAgICAgICBpZiAoZW50cnkubmFtZSA9PT0gJ25vZGVfbW9kdWxlcycgfHwgZW50cnkubmFtZSA9PT0gJ2xpYnJhcnknIHx8IGVudHJ5Lm5hbWUgPT09ICd0ZW1wJykge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgZmlsZVBhdGggPSBqb2luKGZvbGRlciwgZW50cnkubmFtZSk7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB2aXNpdChmaWxlUGF0aCk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIUZPTlRfRVhURU5TSU9OUy5oYXMoZXh0bmFtZShlbnRyeS5uYW1lKS50b0xvd2VyQ2FzZSgpKSkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIGZpbGVQYXRoKS5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbiAgICAgICAgICAgIGZvbnRzLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbmFtZTogYmFzZW5hbWUoZW50cnkubmFtZSwgZXh0bmFtZShlbnRyeS5uYW1lKSksXHJcbiAgICAgICAgICAgICAgICB1cmw6IGBkYjovL2Fzc2V0cy8ke3BhdGh9YCxcclxuICAgICAgICAgICAgICAgIHJlbGF0aXZlUGF0aDogcGF0aCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgYXdhaXQgdmlzaXQoYXNzZXRzUm9vdCk7XHJcbiAgICByZXR1cm4gZm9udHMuc29ydCgoYSwgYikgPT4gYS5yZWxhdGl2ZVBhdGgubG9jYWxlQ29tcGFyZShiLnJlbGF0aXZlUGF0aCwgJ3poLUNOJykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbWl0UHJvZ3Jlc3MocHJvZ3Jlc3M6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ3Byb2dyZXNzJywgcHJvZ3Jlc3MpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0Q2FjaGVGb2xkZXIoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBqb2luKEVkaXRvci5Qcm9qZWN0LnRtcERpciwgcGFja2FnZUpTT04ubmFtZSwgJ2Fzc2V0LWNhY2hlJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IEltcG9ydFNldHRpbmdzIHtcclxuICAgIGNvbnN0IGlucHV0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRTZXR0aW5ncz5cclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3Qgc2NhbGUgPSB0eXBlb2YgaW5wdXQuc2NhbGUgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShpbnB1dC5zY2FsZSlcclxuICAgICAgICA/IE1hdGgubWF4KDAuMjUsIE1hdGgubWluKDQsIGlucHV0LnNjYWxlKSlcclxuICAgICAgICA6IERFRkFVTFRfU0VUVElOR1Muc2NhbGU7XHJcbiAgICBjb25zdCBmb250TWFwID0gaW5wdXQuZm9udE1hcCAmJiB0eXBlb2YgaW5wdXQuZm9udE1hcCA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhpbnB1dC5mb250TWFwKVxyXG4gICAgICAgICAgICAuZmlsdGVyKChba2V5LCBpdGVtXSkgPT4ga2V5LnRyaW0oKSAmJiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5tYXAoKFtrZXksIGl0ZW1dKSA9PiBba2V5LnRyaW0oKSwgaXRlbS50cmltKCldKSlcclxuICAgICAgICA6IHt9O1xyXG4gICAgY29uc3QgcmF3TG9jYWxGb2xkZXJzID0gQXJyYXkuaXNBcnJheShpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVycylcclxuICAgICAgICA/IGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiB0eXBlb2YgaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlciA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgPyBbaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcl1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VGb2xkZXJzID0gcmF3TG9jYWxGb2xkZXJzXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyKTogZm9sZGVyIGlzIHN0cmluZyA9PiB0eXBlb2YgZm9sZGVyID09PSAnc3RyaW5nJylcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IGZvbGRlci50cmltKCkpXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlciwgaW5kZXgsIGZvbGRlcnMpID0+IGZvbGRlcnMuaW5kZXhPZihmb2xkZXIpID09PSBpbmRleClcclxuICAgICAgICAuc2xpY2UoMCwgMyk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogdHlwZW9mIGlucHV0LnNvdXJjZVVybCA9PT0gJ3N0cmluZycgPyBpbnB1dC5zb3VyY2VVcmwudHJpbSgpIDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHR5cGVvZiBpbnB1dC5hc3NldEZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQuYXNzZXRGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5hc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXI6IHR5cGVvZiBpbnB1dC5wcmVmYWJGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5wcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnMsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogbG9jYWxSZXNvdXJjZUZvbGRlcnNbMF0gPz8gJycsXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGlucHV0LnVwZGF0ZUV4aXN0aW5nICE9PSBmYWxzZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBpbnB1dC5yZWZyZXNoQXNzZXRzID09PSB0cnVlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBpbnB1dC5hdXRvU2F2ZSA9PT0gdHJ1ZSxcclxuICAgICAgICBmb250TWFwLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBpZiAoc2V0dGluZ3NDYWNoZSkge1xyXG4gICAgICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsICdwcm9qZWN0Jyk7XHJcbiAgICBzZXR0aW5nc0NhY2hlID0gc2FmZVNldHRpbmdzKHNhdmVkKTtcclxuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBhd2FpdCBzZXR0aW5nc1dyaXRlUXVldWU7XHJcbiAgICByZXR1cm4gZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoU2V0dGluZ3NXcml0ZUxvY2s8VD4ob3BlcmF0aW9uOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBzZXR0aW5nc1dyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgc2V0dGluZ3NXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBuZXh0ID0gc2FmZVNldHRpbmdzKHZhbHVlKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsIG5leHQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgc2V0dGluZ3NDYWNoZSA9IG5leHQ7XHJcbiAgICAgICAgcmV0dXJuIG5leHQ7XHJcbiAgICB9KSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKCgpID0+IHBlcnNpc3RTZXR0aW5nc1VubG9ja2VkKHZhbHVlKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhdGNoU2V0dGluZ3ModmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgcmV0dXJuIHdpdGhTZXR0aW5nc1dyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzVW5sb2NrZWQoKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQoeyAuLi5jdXJyZW50LCAuLi52YWx1ZSB9KTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjbGllbnQoc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCA9IGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbCk6IFByb21pc2U8RmlnbWFDbGllbnQ+IHtcclxuICAgIHJldHVybiBuZXcgRmlnbWFDbGllbnQoYXdhaXQgdmF1bHQuZ2V0KCksIHNpZ25hbCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJvdW5kdHJpcFNlcnZpY2Uoc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPFJvdW5kdHJpcFNlcnZpY2U+IHtcclxuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XHJcbiAgICByZXR1cm4gbmV3IFJvdW5kdHJpcFNlcnZpY2Uoe1xyXG4gICAgICAgIGNsaWVudDogYXdhaXQgY2xpZW50KHNpZ25hbCksXHJcbiAgICAgICAgcHJvamVjdFJvb3Q6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgY3JlYXRvclZlcnNpb24sXHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTogQWJvcnRDb250cm9sbGVyIHtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbihvd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgaWYgKGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ato+WcqOehruiupOWvvOWFpeWQjueahOi1hOa6kOiwg+aVtO+8jOivt+eojeWAmeOAgicpO1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeW3suaciSBGaWdtYSDmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXlrozmiJDmiJblhYjlj5bmtojjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gb3duZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgICAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWRQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKHNlbGVjdGVkUGF0aCk7XHJcbiAgICBjb25zdCBmb2xkZXIgPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBpZiAoIWZvbGRlciB8fCBmb2xkZXIgPT09ICcuJyB8fCBmb2xkZXIuc3RhcnRzV2l0aCgnLi4nKSB8fCBpc0Fic29sdXRlKGZvbGRlcikpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+i1hOa6kOi+k+WHuuebruW9leW/hemhu+aYr+mhueebriBhc3NldHMg5LiL55qE5a2Q5paH5Lu25aS544CCJyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXREYXRhYmFzZVVybChmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoZmlsZVBhdGgpO1xyXG4gICAgY29uc3QgcGF0aCA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGNvbnN0IG91dHNpZGUgPSBwYXRoID09PSAnLi4nXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLi8nKVxyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi5cXFxcJylcclxuICAgICAgICB8fCBpc0Fic29sdXRlKHBhdGgpO1xyXG4gICAgaWYgKCFwYXRoIHx8IHBhdGggPT09ICcuJyB8fCBvdXRzaWRlKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gYGRiOi8vYXNzZXRzLyR7cGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyl9YDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oupIEZpZ21hIOWvvOWFpei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqemihOWItuS9k+i+k+WHuuebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZm9sZGVyOiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkKSxcclxuICAgICAgICBhYnNvbHV0ZVBhdGg6IHJlc29sdmUoc2VsZWN0ZWQpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93biwgX2luZGV4ID0gMCk6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnID8gY3VycmVudC50cmltKCkgOiAnJztcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gY3VycmVudEZvbGRlciAmJiBpc0Fic29sdXRlKGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgPyBjdXJyZW50Rm9sZGVyXHJcbiAgICAgICAgOiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqeacrOWcsOWQjOWQjei1hOa6kOebruW9lScsXHJcbiAgICAgICAgcGF0aDogaW5pdGlhbFBhdGgsXHJcbiAgICAgICAgdHlwZTogJ2RpcmVjdG9yeScsXHJcbiAgICAgICAgYnV0dG9uOiAn6YCJ5oup55uu5b2VJyxcclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXN1bHQuZmlsZVBhdGhzWzBdO1xyXG4gICAgaWYgKHJlc3VsdC5jYW5jZWxlZCB8fCAhc2VsZWN0ZWQpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGxpYnJhcnkgPSBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoc2VsZWN0ZWQpO1xyXG4gICAgcmV0dXJuIHsgZm9sZGVyOiBsaWJyYXJ5LnJvb3QgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5pb25GcmFtZShub2RlczogRmlnbWFOb2RlW10pOiBSZWN0IHtcclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGVzLm1hcChub2RlRnJhbWUpLmZpbHRlcigodmFsdWUpOiB2YWx1ZSBpcyBSZWN0ID0+IEJvb2xlYW4odmFsdWUpKTtcclxuICAgIGlmICghZnJhbWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHggPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCkpO1xyXG4gICAgY29uc3QgeSA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55KSk7XHJcbiAgICBjb25zdCByaWdodCA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGgpKTtcclxuICAgIGNvbnN0IGJvdHRvbSA9IE1hdGgubWF4KC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0KSk7XHJcbiAgICByZXR1cm4geyB4LCB5LCB3aWR0aDogcmlnaHQgLSB4LCBoZWlnaHQ6IGJvdHRvbSAtIHkgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9kZUZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3Qge1xyXG4gICAgaWYgKG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gdW5pb25GcmFtZShub2RlLmNoaWxkcmVuKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxufVxyXG5cclxuY29uc3QgUkVOREVSX09WRVJGTE9XX0VQU0lMT04gPSAwLjU7XHJcblxyXG4vKipcclxuICogT25seSBleHBhbmQgcmFzdGVycyB3aG9zZSB2aXNpYmxlIHBpeGVscyBlc2NhcGUgdGhlIGdlb21ldHJpYyBmcmFtZS4gQVxyXG4gKiByZW5kZXIgZnJhbWUgY29udGFpbmVkIGluc2lkZSB0aGUgZ2VvbWV0cnkgb2Z0ZW4gcmVwcmVzZW50cyBpbnRlbnRpb25hbFxyXG4gKiB0cmFuc3BhcmVudCBwYWRkaW5nIGFuZCBtdXN0IGtlZXAgdGhlIGxlZ2FjeSBmaXhlZC1jYW52YXMgcGF0aC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGU6IEZpZ21hTm9kZSk6IFJlY3QgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgZ2VvbWV0cnkgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICBjb25zdCByZW5kZXIgPSBub2RlLmFic29sdXRlUmVuZGVyQm91bmRzO1xyXG4gICAgaWYgKCFnZW9tZXRyeSB8fCAhcmVuZGVyIHx8IHJlbmRlci53aWR0aCA8PSAwIHx8IHJlbmRlci5oZWlnaHQgPD0gMCkge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBnZW9tZXRyeVJpZ2h0ID0gZ2VvbWV0cnkueCArIGdlb21ldHJ5LndpZHRoO1xyXG4gICAgY29uc3QgZ2VvbWV0cnlCb3R0b20gPSBnZW9tZXRyeS55ICsgZ2VvbWV0cnkuaGVpZ2h0O1xyXG4gICAgY29uc3QgcmVuZGVyUmlnaHQgPSByZW5kZXIueCArIHJlbmRlci53aWR0aDtcclxuICAgIGNvbnN0IHJlbmRlckJvdHRvbSA9IHJlbmRlci55ICsgcmVuZGVyLmhlaWdodDtcclxuICAgIHJldHVybiByZW5kZXIueCA8IGdlb21ldHJ5LnggLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlci55IDwgZ2VvbWV0cnkueSAtIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyUmlnaHQgPiBnZW9tZXRyeVJpZ2h0ICsgUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXJCb3R0b20gPiBnZW9tZXRyeUJvdHRvbSArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgPyByZW5kZXJcclxuICAgICAgICA6IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gY29ybmVyUmFkaWkobm9kZTogRmlnbWFOb2RlKTogW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl0ge1xyXG4gICAgaWYgKG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWk/Lmxlbmd0aCA9PT0gNCkge1xyXG4gICAgICAgIHJldHVybiBub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpIGFzIFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmFkaXVzID0gbm9kZS5jb3JuZXJSYWRpdXMgPz8gMDtcclxuICAgIHJldHVybiBbcmFkaXVzLCByYWRpdXMsIHJhZGl1cywgcmFkaXVzXTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdERlY2lzaW9uKG5vZGU6IEZpZ21hTm9kZSk6IERlY2lzaW9uIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgYWN0aW9uOiBpbmZlckFjdGlvbihub2RlKSxcclxuICAgICAgICBraW5kOiBpbmZlcktpbmQobm9kZSksXHJcbiAgICAgICAgbmluZVNsaWNlOiBpc1BhdGNoQ2FuZGlkYXRlKG5vZGUpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlY2lzaW9uRm9yTm9kZShub2RlOiBGaWdtYU5vZGUsIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+KTogRGVjaXNpb24ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lzaW9uTWFwKG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSwgdHJlZTogVHJlZU5vZGVEdG9bXSk6IE1hcDxzdHJpbmcsIERlY2lzaW9uPiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRGVjaXNpb24+KCk7XHJcbiAgICBjb25zdCBhZGREZWZhdWx0cyA9IChub2RlczogVHJlZU5vZGVEdG9bXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGFkZERlZmF1bHRzKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBhZGREZWZhdWx0cyh0cmVlKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBvdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgICAgIGRlY2lzaW9ucy5zZXQoaXRlbS5pZCwge1xyXG4gICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAgICAgIGtpbmQ6IE5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCkgPyBpdGVtLmtpbmQgOiAnYXV0bycsXHJcbiAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICAuLi4obmFtZSA/IHsgbmFtZSB9IDoge30pLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRlY2lzaW9ucztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgZGVjaXNpb25zOiBSZWFkb25seU1hcDxzdHJpbmcsIEltcG9ydERlY2lzaW9uPixcclxuICAgIGluY2x1ZGVOb2RlTmFtZSA9IHRydWUsXHJcbik6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgcmV0dXJuIGRlY2lzaW9uPy5leHBsaWNpdCA9PT0gdHJ1ZVxyXG4gICAgICAgIHx8IChpbmNsdWRlTm9kZU5hbWUgJiYgQm9vbGVhbihkZWNpc2lvbj8ubmFtZSkpXHJcbiAgICAgICAgfHwgbm9kZS5jaGlsZHJlbi5zb21lKChjaGlsZCkgPT4gc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUoY2hpbGQsIGRlY2lzaW9ucykpO1xyXG59XHJcblxyXG50eXBlIFN0b3JlZE5vZGVPdmVycmlkZXMgPSBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4+O1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpOiBQcm9taXNlPFN0b3JlZE5vZGVPdmVycmlkZXM+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFN0b3JlZE5vZGVPdmVycmlkZXMgOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZU5vZGVPdmVycmlkZSh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2tJZCA9ICcnKTogSW1wb3J0T3ZlcnJpZGUgfCBudWxsIHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBpdGVtID0gdmFsdWUgYXMgUGFydGlhbDxJbXBvcnRPdmVycmlkZT47XHJcbiAgICBjb25zdCBpZCA9IHR5cGVvZiBpdGVtLmlkID09PSAnc3RyaW5nJyAmJiBpdGVtLmlkID8gaXRlbS5pZCA6IGZhbGxiYWNrSWQ7XHJcbiAgICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGtpbmQgPSB0eXBlb2YgaXRlbS5raW5kID09PSAnc3RyaW5nJyAmJiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpXHJcbiAgICAgICAgPyBpdGVtLmtpbmQgYXMgTm9kZUtpbmRcclxuICAgICAgICA6ICdhdXRvJztcclxuICAgIGNvbnN0IGV4cGxpY2l0ID0gaXRlbS5leHBsaWNpdCA9PT0gZmFsc2UgPyBmYWxzZSA6IHRydWU7XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgaWYgKCFleHBsaWNpdCAmJiAhbmFtZSkgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkLFxyXG4gICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGl0ZW0uYWN0aW9uKSxcclxuICAgICAgICBraW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UgPT09IHRydWUsXHJcbiAgICAgICAgZXhwbGljaXQsXHJcbiAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG5vZGVPdmVycmlkZXNGb3IoZmlsZUtleTogc3RyaW5nKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBjb25zdCBzdG9yZWQgPSAoYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpKVtmaWxlS2V5XSA/PyB7fTtcclxuICAgIGNvbnN0IHJlc3VsdDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBbaWQsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzdG9yZWQpKSB7XHJcbiAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUodmFsdWUsIGlkKTtcclxuICAgICAgICBpZiAoc2FmZSkgcmVzdWx0LnB1c2goc2FmZSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrPFQ+KG9wZXJhdGlvbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlID0gcmVzdWx0LnRoZW4oKCkgPT4gdW5kZWZpbmVkLCAoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXNVbmxvY2tlZChcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICBpZiAodHlwZW9mIGZpbGVLZXkgIT09ICdzdHJpbmcnIHx8ICFmaWxlS2V5LnRyaW0oKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCRIEZpZ21hIGZpbGVLZXnjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW1zID0gQXJyYXkuaXNBcnJheSh2YWx1ZXMpID8gdmFsdWVzIDogW107XHJcbiAgICBjb25zdCBzYWZlSXRlbXMgPSBpdGVtc1xyXG4gICAgICAgIC5tYXAoKGl0ZW0pID0+IHNhZmVOb2RlT3ZlcnJpZGUoaXRlbSkpXHJcbiAgICAgICAgLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgSW1wb3J0T3ZlcnJpZGUgPT4gQm9vbGVhbihpdGVtKSk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IG5ldyBTZXQoXHJcbiAgICAgICAgKEFycmF5LmlzQXJyYXkoc2NvcGVWYWx1ZXMpID8gc2NvcGVWYWx1ZXMgOiBzYWZlSXRlbXMubWFwKChpdGVtKSA9PiBpdGVtLmlkKSlcclxuICAgICAgICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBCb29sZWFuKGlkKSksXHJcbiAgICApO1xyXG4gICAgaWYgKCFzY29wZUlkcy5zaXplKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnnrZbnlaXvvJrnvLrlsJHlvZPliY3lr7zlhaXojIPlm7TjgIInKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHNjb3BlZEl0ZW1zID0gc2FmZUl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gc2NvcGVJZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICBmb3IgKGNvbnN0IGlkIG9mIHNjb3BlSWRzKSB7XHJcbiAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHNjb3BlZEl0ZW1zKSB7XHJcbiAgICAgICAgY3VycmVudFtpdGVtLmlkXSA9IGl0ZW07XHJcbiAgICB9XHJcbiAgICBpZiAoT2JqZWN0LmtleXMoY3VycmVudCkubGVuZ3RoKSB7XHJcbiAgICAgICAgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHN0b3JlZFtmaWxlS2V5XTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2NvcGVkSXRlbXM7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzKFxyXG4gICAgZmlsZUtleTogdW5rbm93bixcclxuICAgIHZhbHVlczogdW5rbm93bixcclxuICAgIHNjb3BlVmFsdWVzOiB1bmtub3duLFxyXG4pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKFxyXG4gICAgICAgICgpID0+IHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoZmlsZUtleSwgdmFsdWVzLCBzY29wZVZhbHVlcyksXHJcbiAgICApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gcGF0Y2hOb2RlTmFtZXMoZmlsZUtleTogc3RyaW5nLCBwYXRjaGVzOiBNY3BOb2RlTmFtZVBhdGNoW10pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+IHtcclxuICAgIHJldHVybiB3aXRoTm9kZU92ZXJyaWRlV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIWZpbGVLZXkudHJpbSgpKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZ2V0U3RvcmVkTm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzdG9yZWRbZmlsZUtleV0gPz8ge30pIH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkOiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBwYXRjaCBvZiBwYXRjaGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkID0gdHlwZW9mIHBhdGNoLmlkID09PSAnc3RyaW5nJyA/IHBhdGNoLmlkLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgICAgICBpZiAoIWlkKSB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueWQjeensO+8mue8uuWwkSBub2RlSWTjgIInKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBzYWZlTm9kZU92ZXJyaWRlKGN1cnJlbnRbaWRdLCBpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZhbGxiYWNrID0gc2FmZU5vZGVPdmVycmlkZShwYXRjaC5mYWxsYmFjaywgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBuZXh0ID0gZXhpc3RpbmcgPyB7IC4uLmV4aXN0aW5nIH0gOiBmYWxsYmFjayA/IHsgLi4uZmFsbGJhY2sgfSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbmV4dCAmJiBwYXRjaC5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIW5leHQpIHRocm93IG5ldyBFcnJvcihg5peg5rOV5L+d5a2Y6IqC54K55ZCN56ew77ya6IqC54K5ICR7aWR9IOe8uuWwkeacieaViOm7mOiupOetlueVpeOAgmApO1xyXG4gICAgICAgICAgICBpZiAocGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIG5leHQubmFtZTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHBhdGNoLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnmoTlkI3np7Dml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIG5leHQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qgc2FmZSA9IHNhZmVOb2RlT3ZlcnJpZGUobmV4dCwgaWQpO1xyXG4gICAgICAgICAgICBpZiAoc2FmZSkge1xyXG4gICAgICAgICAgICAgICAgY3VycmVudFtpZF0gPSBzYWZlO1xyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVkLnB1c2goc2FmZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudFtpZF07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkgc3RvcmVkW2ZpbGVLZXldID0gY3VycmVudDtcclxuICAgICAgICBlbHNlIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU92ZXJyaWRlcycsIHN0b3JlZCwgJ3Byb2plY3QnKTtcclxuICAgICAgICByZXR1cm4gcGVyc2lzdGVkO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFubm90YXRlRG9jdW1lbnRQbGFuKHNlc3Npb246IERvY3VtZW50U2Vzc2lvbik6IERvY3VtZW50U2Vzc2lvbiB7XHJcbiAgICBjb25zdCBkZWZhdWx0cyA9IGRlY2lzaW9uTWFwKFtdLCBzZXNzaW9uLnRyZWUpO1xyXG4gICAgc2Vzc2lvbi50cmVlID0gYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4oXHJcbiAgICAgICAgc2Vzc2lvbi50cmVlLFxyXG4gICAgICAgIGNvbXBpbGVJbXBvcnRQbGFuKHNlc3Npb24ucm9vdHMsIGRlZmF1bHRzKSxcclxuICAgICk7XHJcbiAgICByZXR1cm4gc2Vzc2lvbjtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdEFzc2V0UmVxdWVzdHMoXHJcbiAgICByb290czogRmlnbWFOb2RlW10sXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuKTogeyBwbmc6IEZpZ21hTm9kZVtdOyB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXTsgcmF3SW1hZ2VzOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdOyBncmFkaWVudHM6IEZpZ21hTm9kZVtdIH0ge1xyXG4gICAgY29uc3QgcG5nOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlLCBhbmNlc3RvcnNWaXNpYmxlOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZWx5VmlzaWJsZSA9IGFuY2VzdG9yc1Zpc2libGUgJiYgbm9kZS52aXNpYmxlICE9PSBmYWxzZSAmJiBub2RlLm9wYWNpdHkgPiAwO1xyXG4gICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZWZmZWN0aXZlbHlWaXNpYmxlKSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSkge1xyXG4gICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICBjb25zdCBzb3VyY2UgPSBuYXRpdmVUaWxlZFBhaW50U291cmNlKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoc291cmNlKSB7XHJcbiAgICAgICAgICAgICAgICB0aWxlZC5wdXNoKHsgbm9kZSwgc291cmNlIH0pO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBlZmZlY3RpdmVseVZpc2libGUgPyB1bmRlZmluZWQgOiBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGltYWdlUmVmKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmF3SW1hZ2VzLnB1c2goeyBub2RlLCBpbWFnZVJlZiB9KTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnZ2VuZXJhdGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICAgICAgaWYgKGZpbGwpIHtcclxuICAgICAgICAgICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGdyYWRpZW50cy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBwbmcucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgZWZmZWN0aXZlbHlWaXNpYmxlKSk7XHJcbiAgICB9O1xyXG4gICAgcm9vdHMuZm9yRWFjaCgocm9vdCkgPT4gdmlzaXQocm9vdCwgdHJ1ZSkpO1xyXG4gICAgcmV0dXJuIHsgcG5nLCB0aWxlZCwgcmF3SW1hZ2VzLCBncmFkaWVudHMgfTtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkQXNzZXRzKFxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4gICAgcmV2aWV3OiBJbXBvcnRSZXZpZXdSZWNvcmRlcixcclxuKTogUHJvbWlzZTxBc3NldEJ1aWxkUmVzdWx0PiB7XHJcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIsICh1cmwsIGV4aXN0ZWQpID0+IHJldmlldy5iZWZvcmVXcml0ZSh1cmwsIGV4aXN0ZWQpKTtcclxuICAgIGF3YWl0IHdyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBjYWNoZSA9IG5ldyBMb2NhbEFzc2V0Q2FjaGUoZGVmYXVsdENhY2hlRm9sZGVyKCkpO1xyXG4gICAgYXdhaXQgY2FjaGUuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZXMgPSBpbXBvcnRTZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KGZvbGRlcikpO1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwobG9jYWxSZXNvdXJjZXMubWFwKChsaWJyYXJ5KSA9PiBsaWJyYXJ5LmluaXRpYWxpemUoKSkpO1xyXG4gICAgY29uc3QgcHJvbW90ZUxvY2FsUGFyZW50cyA9IGFzeW5jIChub2RlOiBGaWdtYU5vZGUpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgICAgICYmIG5vZGUudHlwZSAhPT0gJ1RFWFQnXHJcbiAgICAgICAgICAgICYmICFkZWNpc2lvbi5uaW5lU2xpY2VcclxuICAgICAgICAgICAgLy8gUmVuYW1pbmcgdGhpcyBjb250YWluZXIgZG9lcyBub3QgY2hhbmdlIHJlc291cmNlIG1hdGNoaW5nOyBvbmx5XHJcbiAgICAgICAgICAgIC8vIGEgc3RyYXRlZ3kgb3ZlcnJpZGUgb24gaXRzZWxmIG9yIGFueSBvdmVycmlkZSBiZWxvdyBpdCBibG9ja3NcclxuICAgICAgICAgICAgLy8gcHJvbW90aW9uIGJlY2F1c2UgZGVzY2VuZGFudHMgd291bGQgb3RoZXJ3aXNlIGRpc2FwcGVhci5cclxuICAgICAgICAgICAgJiYgIXN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKG5vZGUsIGRlY2lzaW9ucywgZmFsc2UpXHJcbiAgICAgICAgICAgIC8vIEEgbG9jYWwgcGFyZW50IHJlc291cmNlIGNhbm5vdCByZXByZXNlbnQgaW5kZXBlbmRlbnRseSBpbmFjdGl2ZVxyXG4gICAgICAgICAgICAvLyBkZXNjZW5kYW50cy4gS2VlcCB0aGUgaGllcmFyY2h5IHdoZW5ldmVyIHN1Y2ggYSBib3VuZGFyeSBleGlzdHMuXHJcbiAgICAgICAgICAgICYmICFoYXNIaWRkZW5EZXNjZW5kYW50KG5vZGUpKSB7XHJcbiAgICAgICAgICAgIGxldCBsb2NhbE1hdGNoID0gbnVsbDtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgICAgICBsb2NhbE1hdGNoID0gYXdhaXQgbGlicmFyeS5maW5kKG5vZGUubmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKG5vZGUuY2hpbGRyZW4ubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIH07XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChzZXNzaW9uLnJvb3RzLm1hcChwcm9tb3RlTG9jYWxQYXJlbnRzKSk7XHJcbiAgICBjb25zdCByZXF1ZXN0cyA9IGNvbGxlY3RBc3NldFJlcXVlc3RzKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgY29uc3Qgd2FybmluZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHRvdGFsID0gcmVxdWVzdHMucG5nLmxlbmd0aCArIHJlcXVlc3RzLnRpbGVkLmxlbmd0aFxyXG4gICAgICAgICsgcmVxdWVzdHMucmF3SW1hZ2VzLmxlbmd0aCArIHJlcXVlc3RzLmdyYWRpZW50cy5sZW5ndGg7XHJcbiAgICBsZXQgY29tcGxldGVkID0gMDtcclxuICAgIGxldCBhcGlQcm9taXNlOiBQcm9taXNlPEZpZ21hQ2xpZW50PiB8IG51bGwgPSBudWxsO1xyXG5cclxuICAgIGNvbnN0IGdldEFwaSA9ICgpID0+IHtcclxuICAgICAgICBhcGlQcm9taXNlID8/PSBkaWFnbm9zdGljVGFzaygn5YeG5aSHIEZpZ21hIOWuouaIt+errycsIHVuZGVmaW5lZCwgKCkgPT4gY2xpZW50KCkpO1xyXG4gICAgICAgIHJldHVybiBhcGlQcm9taXNlO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBjb21wbGV0ZUFzc2V0ID0gKFxyXG4gICAgICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyB8ICdnZW5lcmF0ZWQnID0gJ2ZpZ21hJyxcclxuICAgICkgPT4ge1xyXG4gICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgYXNzZXQpO1xyXG4gICAgICAgIHJldmlldy5iaW5kKG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGNvbnN0IHZlcmIgPSBzb3VyY2UgPT09ICdsb2NhbCdcclxuICAgICAgICAgICAgPyAn5aSN55So5pys5Zyw6LWE5rqQJ1xyXG4gICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJ1xyXG4gICAgICAgICAgICAgICAgPyAn5aSN55So5bey5pyJ6LWE5rqQJ1xyXG4gICAgICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdnZW5lcmF0ZWQnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAn55Sf5oiQ5riQ5Y+YJ1xyXG4gICAgICAgICAgICAgICAgOiAn5a+85YWl6LWE5rqQJztcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYCR7dmVyYn0gJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NUaWxlZCA9IGFzeW5jIChpdGVtczogVGlsZWRBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbiAgICAgICAgICAgIHNvdXJjZUtleTogc3RyaW5nO1xyXG4gICAgICAgICAgICBhc3NldEtleTogc3RyaW5nO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgUGVuZGluZ1RpbGUgZXh0ZW5kcyBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgZXh0ZW5zaW9uPzogUmFzdGVySW1hZ2VFeHRlbnNpb247XHJcbiAgICAgICAgICAgIHNvdXJjZVR5cGU6ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXF1ZXN0ZWRTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IGltcG9ydFNldHRpbmdzLnNjYWxlICogc291cmNlLnNjYWxlO1xyXG4gICAgICAgIGNvbnN0IHJlbmRlclNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgPyBjbGFtcEltYWdlU2NhbGUocmVxdWVzdGVkU2NhbGUoc291cmNlKSlcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBUaWxlR3JvdXA+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCB7IG5vZGUsIHNvdXJjZSB9IG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUtleSA9IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHNvdXJjZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgaWQ6IHNvdXJjZS5pZCxcclxuICAgICAgICAgICAgICAgIHBhaW50U2NhbGU6IHNvdXJjZS5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJlbmRlclNjYWxlOiByZW5kZXJTY2FsZShzb3VyY2UpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXRLZXkgPSB0aWxlZFJhc3RlcktleShzb3VyY2VLZXksIHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkpO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChub2RlLm5hbWUsIGFzc2V0S2V5LCAncG5nJylcclxuICAgICAgICAgICAgICAgIC5ub3JtYWxpemUoJ05GS0MnKVxyXG4gICAgICAgICAgICAgICAgLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGUsIG5vZGVzOiBbXSwgc291cmNlLCBzb3VyY2VLZXksIGFzc2V0S2V5IH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZ0Fzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBleGlzdGluZ0Fzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKHdyaXRlci5idWlsZFRpbGVkVXJsKGdyb3VwLm5vZGUubmFtZSwgZ3JvdXAuYXNzZXRLZXksICdwbmcnKSwgdHJ1ZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXAubm9kZXMsIHBpeGVsU2l6ZWRUaWxlQXNzZXQoZXhpc3RpbmdBc3NldCksICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZEV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBbJ3BuZyddXHJcbiAgICAgICAgICAgICAgICAgICAgOiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUztcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoZ3JvdXAuc291cmNlKSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gY2FjaGVkO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyxcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogY2FjaGVkRXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVyblVybHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nIHwgbnVsbD4oKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJlbW90ZUl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNvdXJjZS5raW5kICE9PSAnc291cmNlLW5vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzY2FsZSA9IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGlkcy5hZGQoaXRlbS5zb3VyY2UuaWQpO1xyXG4gICAgICAgICAgICBwYXR0ZXJuc0J5U2NhbGUuc2V0KHNjYWxlLCBpZHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IFtzY2FsZSwgaWRzXSBvZiBwYXR0ZXJuc0J5U2NhbGUpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShpZHMpLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbaWQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXModXJscykpIHtcclxuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcclxuICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gbmVlZHNJbWFnZUZpbGxzXHJcbiAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSlcclxuICAgICAgICAgICAgOiB7fTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkID0gKHVybDogc3RyaW5nLCBub2RlTGFiZWw6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQodXJsKTtcclxuICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQodXJsLCBub2RlTGFiZWwpKTtcclxuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gdGFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2l0ZW0uc291cmNlLmlkfTpzY2FsZToke3JlbmRlclNjYWxlKGl0ZW0uc291cmNlKX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIClcclxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYElNQUdFIOWhq+WFhSAke2l0ZW0uc291cmNlLmlkfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5Dkvpske2xhYmVsfe+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7aXRlbS5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+W5s+mTuui1hOa6kOaMieWunumZheWwuuWvuOeUn+aIkCcsIHsgbm9kZTogaXRlbS5ub2RlLm5hbWUgfSk7XHJcbiAgICAgICAgICAgIGxldCByYXN0ZXI6IFJldHVyblR5cGU8dHlwZW9mIHJhc3Rlcml6ZVRpbGU+O1xyXG4gICAgICAgICAgICB0cnkgeyByYXN0ZXIgPSByYXN0ZXJpemVUaWxlKGNvbnRlbnRzLCByZXF1ZXN0ZWRTY2FsZShpdGVtLnNvdXJjZSksIHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKSk7IH1cclxuICAgICAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICB0cmFjZS5mYWlsKGVycm9yKTtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3ml6Dms5XmjInlrp7pmYXlsLrlr7jnlJ/miJDvvJokeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAocmFzdGVyLnJvdW5kZWQpIHdhcm5pbmdzLmFkZChg5bmz6ZO66LWE5rqQ4oCcJHtpdGVtLm5vZGUubmFtZX3igJ3nmoTmmL7npLrlsLrlr7jlt7Llj5bmlbTkuLogJHtyYXN0ZXIud2lkdGh9w5cke3Jhc3Rlci5oZWlnaHR9IOWDj+e0oO+8iOacgOWwjyAx77yJ77yM6IqC54K5IFNjYWxlIOS/neaMgSAx44CCYCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFRpbGVkVXJsKGl0ZW0ubm9kZS5uYW1lLCBpdGVtLmFzc2V0S2V5LCAncG5nJyk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgcGl4ZWxTaXplZFRpbGVBc3NldChhd2FpdCB3cml0ZXIud3JpdGUodXJsLCByYXN0ZXIuY29udGVudHMsIHVuZGVmaW5lZCwgdHJ1ZSkpLFxyXG4gICAgICAgICAgICAgICAgaXRlbS5zb3VyY2VUeXBlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB0cmFjZS5kb25lKHsgc291cmNlV2lkdGg6IHJhc3Rlci5zb3VyY2VXaWR0aCwgc291cmNlSGVpZ2h0OiByYXN0ZXIuc291cmNlSGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IHJhc3Rlci53aWR0aCwgaGVpZ2h0OiByYXN0ZXIuaGVpZ2h0LCB0aWxlU2NhbGU6IDEgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmVtb3RlID0gYXN5bmMgKG5vZGVzOiBGaWdtYU5vZGVbXSkgPT4ge1xyXG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgdXJsOiBzdHJpbmc7IG5vZGVzOiBGaWdtYU5vZGVbXSB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH1gLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBBcnJheTx7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICB1cmw6IHN0cmluZztcclxuICAgICAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfTtcclxuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XHJcbiAgICAgICAgICAgIHJlbmRlckZyYW1lPzogUmVjdDtcclxuICAgICAgICAgICAga2V5OiBDYWNoZUVudHJ5S2V5O1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfT4gPSBbXTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBub2RlID0gZ3JvdXBlZE5vZGVzWzBdO1xuICAgICAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHJldXNlQXNzZXQgPSAoYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYywgc291cmNlOiAnbG9jYWwnIHwgJ2V4aXN0aW5nJykgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIWFzc2V0LnNsaWNlZCkge1xuICAgICAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3lt7Lnm7TmjqXlvJXnlKjlkIzlkI3otYTmupDvvIzkvYbor6UgU3ByaXRlRnJhbWUg5pyq6YWN572u5Lmd5a6r6L656Led77yM5pqC5oyJ5pmu6YCaIFNwcml0ZSDmmL7npLrvvJvor7flnKjljp/otYTmupDkuK3orr7nva7ovrnot53vvJoke2Fzc2V0LnVybH1gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cGVkTm9kZXMsIGFzc2V0LCBzb3VyY2UpO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGxldCBsb2NhbE1hdGNoID0gbnVsbDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbFJlc291cmNlcykge1xyXG4gICAgICAgICAgICAgICAgbG9jYWxNYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChub2RlLm5hbWUsIGZvcm1hdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIC8vIFByb2plY3QtbG9jYWwgU3ByaXRlRnJhbWVzIG93biB0aGVpciBwaXhlbHMgYW5kIHNsaWNlIGJvcmRlcnMuXG4gICAgICAgICAgICAvLyBSZXVzZSB0aGVpciBVVUlEIGJlZm9yZSBhbnkgc2xpY2UgYW5hbHlzaXMsIGNvbXBhY3Rpb24gb3IgcmVmcmVzaC5cbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbG9jYWxNYXRjaFxuICAgICAgICAgICAgICAgID8gYXNzZXREYXRhYmFzZVVybChsb2NhbE1hdGNoLnBhdGgpXG4gICAgICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XG4gICAgICAgICAgICBpZiAobG9jYWxBc3NldCkge1xuICAgICAgICAgICAgICAgIHJldXNlQXNzZXQobG9jYWxBc3NldCwgJ2xvY2FsJyk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAobG9jYWxVcmwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOWQjOWQjeacrOWcsOi1hOa6kOWwmuaXoOWPr+eUqCBTcHJpdGVGcmFtZe+8jOivt+WFiOWcqCBDb2NvcyDkuK3lrozmiJDotYTmupDlr7zlhaXlubborr7nva7kuLogU3ByaXRlRnJhbWUg5ZCO6YeN6K+V77yM5LiN5Lya5Y+m5bu65Ymv5pys77yaJHtsb2NhbFVybH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcodXJsKSA6IG51bGw7XG4gICAgICAgICAgICBpZiAoIWxvY2FsTWF0Y2ggJiYgZXhpc3RpbmcgJiYgKGRlY2lzaW9uLm5pbmVTbGljZSB8fCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSkpIHtcbiAgICAgICAgICAgICAgICByZXVzZUFzc2V0KGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHNsaWNlQW5hbHlzaXMgPSBkZWNpc2lvbi5uaW5lU2xpY2UgJiYgZm9ybWF0ID09PSAncG5nJ1xuICAgICAgICAgICAgICAgID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxuICAgICAgICAgICAgICAgIDogbnVsbDtcbiAgICAgICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UgJiYgIXNsaWNlQW5hbHlzaXMpIHtcbiAgICAgICAgICAgICAgICB3YXJuaW5ncy5hZGQoYOS4iS/kuZ3lrqvoioLngrnigJwke25vZGUubmFtZX3igJ3ml6Dms5XorqHnrpfov57nu63liIfniYfovrnnlYzvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYm9yZGVycyA9IHNsaWNlQW5hbHlzaXM/LmJvcmRlcnM7XG4gICAgICAgICAgICAvLyBOZXcgc2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlXG4gICAgICAgICAgICAvLyB0aGVpciBnZW5lcmF0ZWQgYm9yZGVycyB1c2UgdGhhdCBjb29yZGluYXRlIHNwYWNlLlxuICAgICAgICAgICAgY29uc3QgcmVuZGVyRnJhbWUgPSBib3JkZXJzID8gdW5kZWZpbmVkIDogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGtleTogQ2FjaGVFbnRyeUtleSA9IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHZhcmlhbnQ6IHJlbmRlckZyYW1lID8gJ3Zpc3VhbC1vdmVyZmxvdy12MScgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGxvY2FsTWF0Y2ggfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IGNhY2hlLnJlYWQoa2V5KTtcclxuICAgICAgICAgICAgcGVuZGluZy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICBub2RlczogZ3JvdXBlZE5vZGVzLFxyXG4gICAgICAgICAgICAgICAgdXJsLFxyXG4gICAgICAgICAgICAgICAgYm9yZGVycyxcclxuICAgICAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM6IHNsaWNlQW5hbHlzaXMgPz8gdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyRnJhbWU6IGxvY2FsTWF0Y2ggPyB1bmRlZmluZWQgOiByZW5kZXJGcmFtZSxcclxuICAgICAgICAgICAgICAgIGtleSxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzOiBsb2NhbE1hdGNoPy5jb250ZW50cyA/PyBjYWNoZWQsXHJcbiAgICAgICAgICAgICAgICBzb3VyY2U6IGxvY2FsTWF0Y2ggPyAnbG9jYWwnIDogY2FjaGVkID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB1cmxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPiA9IHt9O1xyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHVzZUFic29sdXRlQm91bmRzIG9mIFt0cnVlLCBmYWxzZV0pIHtcclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSByZW1vdGVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzID8gIWl0ZW0ucmVuZGVyRnJhbWUgOiBCb29sZWFuKGl0ZW0ucmVuZGVyRnJhbWUpXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgICAgICBpZiAoIWJhdGNoLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih1cmxzLCBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGJhdGNoLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMsXHJcbiAgICAgICAgICAgICAgICBPYmplY3QuZnJvbUVudHJpZXMoYmF0Y2gubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGUubmFtZV0pKSxcclxuICAgICAgICAgICAgKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gdXJsc1tpdGVtLm5vZGUuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDvea4suafk+iKgueCue+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKGl0ZW0ua2V5LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGFzc2V0OiBTcHJpdGVBc3NldFNwZWM7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNsaWNlQW5hbHlzaXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCfkuIkv5Lmd5a6r6LWE5rqQ5pyA5bCP5YyWJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdyaXRlU2xpY2VkUG5nKHdyaXRlciwgaXRlbS51cmwsIGNvbnRlbnRzLCBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zbGljZUFuYWx5c2lzLCBpbXBvcnRTZXR0aW5ncy5zY2FsZSk7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IHJlc3VsdC5hc3NldDtcclxuICAgICAgICAgICAgICAgIHRyYWNlLmRvbmUocmVzdWx0Lm9wdGltaXphdGlvbik7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGFzc2V0LnNsaWNlRmFsbGJhY2spIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7aXRlbS5ub2RlLm5hbWV94oCd5YiH54mH6K6+572u5aSx6LSl77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaXvvJoke2Fzc2V0LnNsaWNlRmFsbGJhY2t9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBpdGVtLm5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGdyb3VwZWROb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ucmVuZGVyRnJhbWVcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyB7IC4uLmFzc2V0LCByZW5kZXJGcmFtZTogb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShncm91cGVkTm9kZSkgPz8gaXRlbS5yZW5kZXJGcmFtZSB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYXNzZXQsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5zb3VyY2UsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmF3SW1hZ2VzID0gYXN5bmMgKGl0ZW1zOiBSYXdJbWFnZUFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyBub2RlOiBGaWdtYU5vZGU7IG5vZGVzOiBGaWdtYU5vZGVbXTsgaW1hZ2VSZWY6IHN0cmluZyB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSBgJHtpdGVtLm5vZGUubmFtZS5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKX1cXDAke2l0ZW0uaW1hZ2VSZWZ9YDtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlOiBpdGVtLm5vZGUsIG5vZGVzOiBbXSwgaW1hZ2VSZWY6IGl0ZW0uaW1hZ2VSZWYgfTtcclxuICAgICAgICAgICAgZ3JvdXAubm9kZXMucHVzaChpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGltYWdlRmlsbFVybHNQcm9taXNlOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bGw+PiB8IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzLnZhbHVlcygpKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50czogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGxldCBleHRlbnNpb246IFJhc3RlckltYWdlRXh0ZW5zaW9uIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBsZXQgc291cmNlOiAnY2FjaGUnIHwgJ2ZpZ21hJyA9ICdjYWNoZSc7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYGltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogY2FuZGlkYXRlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudDogJ3NvdXJjZS1pbWFnZS12MScsXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGNhbmRpZGF0ZTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGlmICghaW1hZ2VGaWxsVXJsc1Byb21pc2UpIHtcclxuICAgICAgICAgICAgICAgICAgICBpbWFnZUZpbGxVcmxzUHJvbWlzZSA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gYXdhaXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpbWFnZUZpbGxVcmxzW2dyb3VwLmltYWdlUmVmXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5DkvpvpmpDol4/lm77niYfloavlhYXvvJoke2dyb3VwLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldChyZW1vdGVVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0YXNrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7Z3JvdXAubm9kZS5uYW1lfSAoJHtncm91cC5ub2RlLmlkfSlgKSk7XHJcbiAgICAgICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldChyZW1vdGVVcmwsIHRhc2spO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCB0YXNrO1xyXG4gICAgICAgICAgICAgICAgc291cmNlID0gJ2ZpZ21hJztcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgICAgIGF3YWl0IGNhY2hlLndyaXRlKHtcclxuICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgIH0sIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBleHRlbnNpb24gPz89IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgZ3JvdXAubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fTppbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgMSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBncm91cC5ub2RlcykgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflubPpk7rotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy50aWxlZC5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1RpbGVkKHJlcXVlc3RzLnRpbGVkKSk7XHJcbiAgICBhd2FpdCBkaWFnbm9zdGljVGFzaygn5YeG5aSHIFBORyDotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5wbmcubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKSk7XHJcbiAgICAvLyBSdW4gYWZ0ZXIgd2hvbGUtbm9kZSByZW5kZXJzIHNvIGEgY29ycmVjdCB2aXNpYmlsaXR5LWluZGVwZW5kZW50IHNvdXJjZVxyXG4gICAgLy8gaW1hZ2Ugd2lucyBpZiBib3RoIHBhdGhzIHNoYXJlIHRoZSBzYW1lIGxlZ2FjeSBhc3NldCBmaWxlbmFtZS5cclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIfpmpDol4/lm77niYfotYTmupAnLCB7IGNvdW50OiByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoIH0sICgpID0+IHByb2Nlc3NSYXdJbWFnZXMocmVxdWVzdHMucmF3SW1hZ2VzKSk7XHJcblxyXG4gICAgY29uc3QgZ3JhZGllbnRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXHJcbiAgICAgICAgICAgID8gZ3JhZGllbnRQbmcoXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGZpbGwsXHJcbiAgICAgICAgICAgICAgICBjb3JuZXJSYWRpaShub2RlKSxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAocG5nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBncmFkaWVudEtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZmlyc3RBc3NldCA9IGdyYWRpZW50QXNzZXRzLmdldChncmFkaWVudEtleSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZmlyc3RBc3NldCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgd3JpdGVyLmV4aXN0aW5nKHVybCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gZmlyc3RBc3NldCA/PyBleGlzdGluZyA/PyBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBwbmcpO1xyXG4gICAgICAgICAgICBncmFkaWVudEFzc2V0cy5zZXQoZ3JhZGllbnRLZXksIGFzc2V0KTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgZmlyc3RBc3NldCB8fCBleGlzdGluZyA/ICdleGlzdGluZycgOiAnZ2VuZXJhdGVkJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOeUn+aIkOa4kOWPmCAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IGFzc2V0cywgd2FybmluZ3M6IFsuLi53YXJuaW5nc10gfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUZvbnRzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8TWFwPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZhbWlseSwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCByZXNvbHZlQXNzZXRVdWlkKHVybCk7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChmYW1pbHksIHV1aWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluZmVycmVkTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbmF0aXZlTW9kZSA9IGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpO1xyXG4gICAgaWYgKG5hdGl2ZU1vZGUpIHtcclxuICAgICAgICByZXR1cm4gbmF0aXZlTW9kZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZS5jaGlsZHJlblxyXG4gICAgICAgIC5tYXAoKGNoaWxkKSA9PiBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgIC5maWx0ZXIoKGZyYW1lKTogZnJhbWUgaXMgUmVjdCA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIGNvbnN0IGNlbnRlcnNYID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCAvIDIpO1xyXG4gICAgY29uc3QgY2VudGVyc1kgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCAvIDIpO1xyXG4gICAgY29uc3Qgc3ByZWFkWCA9IE1hdGgubWF4KC4uLmNlbnRlcnNYKSAtIE1hdGgubWluKC4uLmNlbnRlcnNYKTtcclxuICAgIGNvbnN0IHNwcmVhZFkgPSBNYXRoLm1heCguLi5jZW50ZXJzWSkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWSk7XHJcbiAgICBpZiAoc3ByZWFkWSA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdIT1JJWk9OVEFMJztcclxuICAgIH1cclxuICAgIGlmIChzcHJlYWRYIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIHJldHVybiAnR1JJRCc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtYWtlU3BlYyhcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwbGFuczogUmVhZG9ubHlNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4sXHJcbiAgICBub2RlQnlJZDogUmVhZG9ubHlNYXA8c3RyaW5nLCBGaWdtYU5vZGU+LFxyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+LFxyXG4gICAgZm9udHM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBpc1Jvb3QgPSBmYWxzZSxcclxuICAgIHBhcmVudFdvcmxkUm90YXRpb24gPSAwLFxyXG4pOiBTY2VuZU5vZGVTcGVjIHwgbnVsbCB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgcGxhbiA9IHBsYW5zLmdldChub2RlLmlkKTtcclxuICAgIGNvbnN0IGZvbGQgPSBwbGFuPy5mb2xkO1xyXG4gICAgY29uc3QgZm9sZFNvdXJjZSA9IGZvbGQgPyBub2RlQnlJZC5nZXQoZm9sZC5zb3VyY2VOb2RlSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgdGV4dFNvdXJjZSA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgdmlzdWFsU291cmNlID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgcmVzb2x2ZWRLaW5kID0gZGVjaXNpb24ua2luZCA9PT0gJ2F1dG8nID8gaW5mZXJLaW5kKG5vZGUpIDogZGVjaXNpb24ua2luZDtcclxuICAgIGNvbnN0IHBsYW5uZWRLaW5kID0gcGxhbj8ua2luZCA/PyByZXNvbHZlZEtpbmQ7XHJcbiAgICBjb25zdCBiaXRtYXBUZXJtaW5hbCA9IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInO1xyXG4gICAgY29uc3QgdGVybWluYWwgPSBiaXRtYXBUZXJtaW5hbCB8fCBpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbik7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0ga2luZEZvckltcG9ydEFjdGlvbihwbGFubmVkS2luZCwgZGVjaXNpb24uYWN0aW9uLCBkZWNpc2lvbi5uaW5lU2xpY2UpO1xyXG4gICAgY29uc3Qgc3ByaXRlU291cmNlSWQgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0J1xyXG4gICAgICAgID8gZm9sZC5zb3VyY2VOb2RlSWRcclxuICAgICAgICA6IG5vZGUuaWQ7XHJcbiAgICBjb25zdCBzcHJpdGVBc3NldCA9IGFzc2V0cy5nZXQoc3ByaXRlU291cmNlSWQpO1xyXG4gICAgY29uc3QgYWJzb3JiZWREaXJlY3RJZHMgPSBuZXcgU2V0KGZvbGQgPyBbZm9sZC5zb3VyY2VOb2RlSWRdIDogW10pO1xyXG4gICAgY29uc3QgZnVsbEZvbGQgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLWltYWdlJyB8fCBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IHBhcmVudFdvcmxkUm90YXRpb24gKyBub2RlLnJvdGF0aW9uO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYUlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IGRlY2lzaW9uLm5hbWUgPz8gbm9kZS5uYW1lLFxyXG4gICAgICAgIGZpZ21hVHlwZTogdmlzdWFsU291cmNlLnR5cGUsXHJcbiAgICAgICAgYWN0aW9uOiBkZWNpc2lvbi5hY3Rpb24sXHJcbiAgICAgICAga2luZDogZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBmcmFtZSxcclxuICAgICAgICBwYXJlbnRGcmFtZSxcclxuICAgICAgICBpbnRyaW5zaWNTaXplOiBub2RlLnNpemUsXHJcbiAgICAgICAgaXNSb290LFxyXG4gICAgICAgIHJvdGF0aW9uOiBub2RlLnJvdGF0aW9uLFxyXG4gICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgb3BhY2l0eTogZm9sZFNvdXJjZSAmJiBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IG5vZGUub3BhY2l0eSAqIGZvbGRTb3VyY2Uub3BhY2l0eVxyXG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCxcclxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcclxuICAgICAgICBmaWxsczogdGV4dFNvdXJjZS5maWxscyxcclxuICAgICAgICBzdHJva2VzOiB0ZXh0U291cmNlLnN0cm9rZXMsXHJcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0ZXh0U291cmNlLmNoYXJhY3RlcnMsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0U291cmNlLnN0eWxlLFxyXG4gICAgICAgIGxheW91dDoge1xyXG4gICAgICAgICAgICBtb2RlOiBlZmZlY3RpdmVLaW5kID09PSAnbGF5b3V0JyB8fCBlZmZlY3RpdmVLaW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgICAgID8gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgc291cmNlTW9kZTogbm9kZS5sYXlvdXRNb2RlLFxyXG4gICAgICAgICAgICB3cmFwOiBub2RlLmxheW91dFdyYXAsXHJcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIGNvdW50ZXJBbGlnbjogbm9kZS5jb3VudGVyQXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIHByaW1hcnlTaXppbmc6IG5vZGUucHJpbWFyeUF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgaXRlbVNwYWNpbmc6IG5vZGUuaXRlbVNwYWNpbmcsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTcGFjaW5nOiBub2RlLmNvdW50ZXJBeGlzU3BhY2luZyxcclxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdSaWdodDogbm9kZS5wYWRkaW5nUmlnaHQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdUb3A6IG5vZGUucGFkZGluZ1RvcCxcclxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb3ZlcmZsb3dEaXJlY3Rpb246IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24sXHJcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXHJcbiAgICAgICAgcmVsYXRpdmVUcmFuc2Zvcm06IG5vZGUucmVsYXRpdmVUcmFuc2Zvcm0sXHJcbiAgICAgICAgc3ByaXRlOiBzcHJpdGVBc3NldCxcclxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICBmbGF0dGVuQm91bmRhcnk6IGJpdG1hcFRlcm1pbmFsIHx8IGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gdHJ1ZVxyXG4gICAgICAgICAgICA6IGZvbGQ/LmtpbmQgPT09ICdiYWNrZ3JvdW5kJ1xyXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgcGxhblJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgIGNoaWxkcmVuOiB0ZXJtaW5hbFxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogbm9kZS5jaGlsZHJlblxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+ICFhYnNvcmJlZERpcmVjdElkcy5oYXMoY2hpbGQuaWQpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLFxyXG4gICAgICAgICAgICAgICAgICAgIGZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICAgICAgICAgICkpXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCk6IGNoaWxkIGlzIFNjZW5lTm9kZVNwZWMgPT4gY2hpbGQgIT09IG51bGwpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZU1hcHMoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvY29zRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBFZGl0b3IuVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICByZXR1cm4gdHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDBcclxuICAgICAgICA/IGdlbmVyYXRlZFxyXG4gICAgICAgIDogcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjQnKS5yZXBsYWNlKC89KyQvZywgJycpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYkFzc2V0KHVybE9yVXVpZDogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8gfCBudWxsPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcclxuICAgICAgICB1cmxPclV1aWQsXHJcbiAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydFByZWZhYkFzc2V0KFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgZXhwZWN0ZWQ6IHsgdXVpZD86IHN0cmluZzsgdXJsPzogc3RyaW5nIH0gPSB7fSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoaW5mby5pbnZhbGlkIHx8IGluZm8uaW1wb3J0ZWQgIT09IHRydWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlsJrmnKrlrozmiJDlr7zlhaXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8uaW1wb3J0ZXIgIT09ICdwcmVmYWInIHx8IGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicgfHwgaW5mby5pc0RpcmVjdG9yeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCH6LWE5rqQ5LiN5piv5Y+v57yW6L6R55qEIENvY29zIFByZWZhYu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5yZWFkb25seSB8fCBpbmZvLnJlZGlyZWN0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOS4uuWPquivu+aIlumHjeWumuWQkei1hOa6kO+8jOS4jeiDveWuieWFqOabtOaWsO+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkLnV1aWQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOagoemqjOWksei0pe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXJsICYmIGluZm8udXJsICE9PSBleHBlY3RlZC51cmwpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDot6/lvoTmoKHpqozlpLHotKXvvJrmnJ/mnJsgJHtleHBlY3RlZC51cmx977yM5a6e6ZmFICR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JQcmVmYWJBc3NldCh1cmw6IHN0cmluZywgZXhwZWN0ZWRVdWlkPzogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodXJsKTtcclxuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvY29zIFByZWZhYiDotYTmupDlr7zlhaXlpLHotKXvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGluZm8/LmltcG9ydGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIGlmIChleHBlY3RlZFV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5Zyo5a+85YWl5pyf6Ze05Y+R55Sf5Y+Y5YyW77yaJHt1cmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQoaW5mbywgeyB1dWlkOiBleHBlY3RlZFV1aWQsIHVybCB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGluZm87XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3MgUHJlZmFiIOi1hOa6kOWwsee7qui2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYk1ldGEodXVpZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xyXG4gICAgY29uc3QgbWV0YSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgdXVpZCxcclxuICAgICk7XHJcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xor7vlj5YgUHJlZmFiIE1ldGHvvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IG1ldGEgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgIGlmICh2YWx1ZS51dWlkICE9PSB1dWlkIHx8IHZhbHVlLmltcG9ydGVyICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIE1ldGEg5LiO55uu5qCH6LWE5rqQ5LiN5Yy56YWN77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJEaXNrUGF0aCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVJMIOaXoOaViO+8miR7dXJsfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgdXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZChcclxuICAgICAgICAgICAgYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgoaW5mby51cmwpKSxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgICk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZyxcclxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBjdXJyZW50RGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICBpZiAoY3VycmVudERpcnR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3miZPlvIDnmoTlnLrmma/miJYgUHJlZmFiIOacieacquS/neWtmOS/ruaUue+8m+S4uumBv+WFjeinpuWPkeS/neWtmOivoumXru+8jOivt+WFiOaJi+W3peS/neWtmOaIlui/mOWOn+WQjuWGjeWvvOWFpeOAgicpO1xyXG4gICAgfVxyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdvcGVuLWFzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGxldCBsYXN0UmVhc29uID0gJ0NyZWF0b3Ig5bCa5pyq6L+U5ZueIFByZWZhYiDnvJbovpHnirbmgIEnO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgICAgICAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBzdGF0ZS5yZWFzb24gPz8gbGFzdFJlYXNvbjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg5omT5byA55uu5qCHIFByZWZhYiDotoXml7bvvJoke2xhc3RSZWFzb259YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFzc2VydE9wZW5lZFByZWZhYihwcmVmYWJVdWlkOiBzdHJpbmcsIHJvb3RGaWxlSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDnvJbovpHkuIrkuIvmloflt7Llj5jljJbvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjZW5lU2F2ZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDE1XzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmICghZGlydHkpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ+etieW+hSBQcmVmYWIg5L+d5a2Y5a6M5oiQ6LaF5pe244CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFByZWZhYkJpbmRpbmdzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHByZWZhYlV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcHJlZmFiVXVpZCAhPT0gJ3N0cmluZydcclxuICAgICAgICAgICAgfHwgIXByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ57uR5a6a6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZywgcHJlZmFiVXVpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBiaW5kaW5nc1tzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBpZiAoIWJpbmRpbmdzW3NvdXJjZUhhc2hdKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVsZXRlIGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgIXJhd1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0J1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgKHJhdyBhcyB7IHByZWZhYlV1aWQ/OiB1bmtub3duIH0pLnByZWZhYlV1aWQgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZCh7XHJcbiAgICAgICAgICAgIHVzZXJEYXRhOiB7XHJcbiAgICAgICAgICAgICAgICBmaWdtYUltcG9ydGVyOiAocmF3IGFzIHsgcmVjb3JkPzogdW5rbm93biB9KS5yZWNvcmQsXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5p2l5rqQ5LiN5LiA6Ie077yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogKHJhdyBhcyB7IHByZWZhYlV1aWQ6IHN0cmluZyB9KS5wcmVmYWJVdWlkLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFBlbmRpbmdQcmVmYWJTeW5jKFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfSB8IG51bGwsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcGVuZGluZyA9IGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpO1xyXG4gICAgaWYgKHZhbHVlKSB7XHJcbiAgICAgICAgcGVuZGluZ1tzb3VyY2VIYXNoXSA9IHZhbHVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgcGVuZGluZ1tzb3VyY2VIYXNoXTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgcGVuZGluZyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB2ZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7IG1ldGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4ge1xyXG4gICAgbGV0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgIGxldCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgIGlmICghcmVjb3JkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBgUHJlZmFiIOe8uuWwkSBGaWdtYSDmnaXmupDorrDlvZXvvIzml6Dms5Xnoa7orqTmmK/lkKblj6/lronlhajopobnm5bvvJoke2luZm8udXJsfeOAguivt+WFiOenu+WKqOaIlumHjeWRveWQjeivpei1hOa6kOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxuICAgIGlmIChyZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOadpeiHquWPpuS4gOS4qiBGaWdtYSBGcmFtZe+8jOW3suaLkue7neimhueblu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGlmIChwZW5kaW5nKSB7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcucHJlZmFiVXVpZCAhPT0gaW5mby51dWlkIHx8IHBlbmRpbmcucmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmo4DmtYvliLDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtOeahOW+heaBouWkjeWQjOatpeiusOW9le+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCBwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCBwZW5kaW5nLnJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFyZWNvdmVyZWQgfHwgSlNPTi5zdHJpbmdpZnkocmVjb3ZlcmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXorrDlvZXoh6rliqjmgaLlpI3lpLHotKXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZWNvcmQgPSByZWNvdmVyZWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCByZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuS4juW9k+WJjeWPiuW+heaBouWkjeeahOWQjOatpeiusOW9lemDveS4jeS4gOiHtO+8jOW3suWBnOatouiHquWKqOaBouWkjeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IG1ldGEsIHJlY29yZCB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGxldCBsYXN0RXJyb3I6IHVua25vd247XHJcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8IDM7IGF0dGVtcHQgKz0gMSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WGmeWFpeWJjSBQcmVmYWIg5p2l5rqQ6K6w5b2V5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xyXG4gICAgICAgICAgICBpZiAoIXNhdmVkIHx8IEpTT04uc3RyaW5naWZ5KHNhdmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5ZCO5qCh6aqM5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xyXG4gICAgICAgICAgICBpZiAoYXR0ZW1wdCA8IDIpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxNTApKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IGxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbGFzdEVycm9yIDogbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5aSx6LSl44CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nLFxyXG4gICAgcm9vdEZyYW1lOiBSZWN0LFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgc291cmNlUm9vdElkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8e1xyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59PiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBjb25zdCBib3VuZFV1aWQgPSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZ0luZm8gPSBwZW5kaW5nXHJcbiAgICAgICAgPyBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHBlbmRpbmcucHJlZmFiVXVpZClcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBjb25zdCB0YXJnZXRQbGFuID0gcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0KFxyXG4gICAgICAgIHBlbmRpbmc/LnByZWZhYlV1aWQsXHJcbiAgICAgICAgYm91bmRVdWlkLFxyXG4gICAgICAgIEJvb2xlYW4ocGVuZGluZ0luZm8pLFxyXG4gICAgKTtcclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyUGVuZGluZykge1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJCaW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSB0YXJnZXRQbGFuLnRhcmdldFV1aWQ7XHJcbiAgICBpZiAodGFyZ2V0VXVpZCkge1xyXG4gICAgICAgIGxldCB0YXJnZXRJbmZvID0gcGVuZGluZ0luZm8/LnV1aWQgPT09IHRhcmdldFV1aWRcclxuICAgICAgICAgICAgPyBwZW5kaW5nSW5mb1xyXG4gICAgICAgICAgICA6IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgaWYgKCF0YXJnZXRJbmZvKSB7XHJcbiAgICAgICAgICAgIGlmIChiaW5kaW5nc1tzb3VyY2VIYXNoXSA9PT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQodGFyZ2V0SW5mby51cmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICBpZiAocGVuZGluZz8ucHJlZmFiVXVpZCA9PT0gdGFyZ2V0VXVpZCAmJiBib3VuZFV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIHJlY292ZXJ5IGlkZW50aXR5IGJlZm9yZSB2ZXJpZmllZFByZWZhYlJlY29yZCBtYXlcclxuICAgICAgICAgICAgICAgIC8vIGNvbW1pdCBhbmQgY2xlYXIgcGVuZGluZy4gQSBsYXRlciBtb3ZlIGZhaWx1cmUgbXVzdCBzdGlsbCBiZVxyXG4gICAgICAgICAgICAgICAgLy8gYWJsZSB0byBsb2NhdGUgdGhlIGV4YWN0IFByZWZhYiBieSBVVUlEIG9uIHRoZSBuZXh0IGF0dGVtcHQuXHJcbiAgICAgICAgICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQodGFyZ2V0SW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIGlmICh0YXJnZXRJbmZvLnVybCAhPT0gcHJlZmFiVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb25mbGljdCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmIChjb25mbGljdCAmJiBjb25mbGljdC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmlnbWEgRnJhbWUg5a+55bqU55qEIFByZWZhYiDpnIDopoHnp7vliqjliLAgJHtwcmVmYWJVcmx977yM5L2G55uu5qCH6Lev5b6E5bey6KKr5YW25LuW6LWE5rqQ5Y2g55So44CCYCxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFjb25mbGljdCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vdmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ21vdmUtYXNzZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvLnVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICAgICAgICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3ZlZCB8fCBtb3ZlZC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Zyo5L+d55WZIFVVSUQg55qE5YmN5o+Q5LiL56e75YqoIFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaW5mbzogdGFyZ2V0SW5mbyxcclxuICAgICAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm1GaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHNlZWQgPSBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbihcclxuICAgICAgICAgICAgcHJlZmFiTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdjcmVhdGUtYXNzZXQnLFxyXG4gICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgIHNlZWQsXHJcbiAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7ogUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBjcmVhdGVkLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCByZWNvcmQgPSBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgICAgICBzb3VyY2VSb290SWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBuZXh0TWV0YSA9IG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG5leHRNZXRhLCBudWxsLCAyKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpbmZvLFxyXG4gICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpbmZvLFxyXG4gICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoYXJnczoge1xyXG4gICAgcmV2aWV3SWQ6IHN0cmluZztcclxuICAgIHByZWZhYlVybDogc3RyaW5nO1xyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgc291cmNlTm9kZUlkOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufSk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHNvdXJjZUhhc2ggPSBmaWdtYUZyYW1lU291cmNlSGFzaChhcmdzLmZpbGVLZXksIGFyZ3Muc291cmNlTm9kZUlkKTtcclxuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgICAgIGFyZ3MucHJlZmFiVXJsLFxyXG4gICAgICAgIGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIHg6IGFyZ3Mucm9vdEZyYW1lLnggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB5OiBhcmdzLnJvb3RGcmFtZS55ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgd2lkdGg6IGFyZ3Mucm9vdEZyYW1lLndpZHRoICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgaGVpZ2h0OiBhcmdzLnJvb3RGcmFtZS5oZWlnaHQgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICBhcmdzLnJvb3RzWzBdLmZpZ21hSWQsXHJcbiAgICApO1xyXG4gICAgYXdhaXQgd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICApO1xyXG4gICAgY29uc3QgZXhpc3RpbmdOb2RlRmlsZUlkcyA9IHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZCxcclxuICAgICAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMoYXJncy5yb290cyksXHJcbiAgICApO1xyXG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgIHJldmlld0lkOiBhcmdzLnJldmlld0lkLFxyXG4gICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcclxuICAgICAgICByb290TmFtZTogYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHJvb3RGcmFtZTogYXJncy5yb290RnJhbWUsXHJcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgZXhpc3RpbmdNYXA6IHt9LFxyXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcm9vdHM6IGFyZ3Mucm9vdHMsXHJcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQ6IHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XHJcbiAgICBsZXQgc2F2ZUF0dGVtcHRlZCA9IGZhbHNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoZGlydHlCZWZvcmVJbXBvcnQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnm67moIcgUHJlZmFiIOacieacquS/neWtmOeahOaJi+W3peS/ruaUue+8jOivt+WFiOS/neWtmOWQjuWGjeaJp+ihjCBGaWdtYSDlop7ph4/lr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBzbmFwc2hvdFN0YXJ0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBpZiAoIXJlc3VsdC5wcmVmYWJTeW5jKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5leHRSZWNvcmQgPSByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShwcmVwYXJlZC5yZWNvcmQsIHJlc3VsdC5wcmVmYWJTeW5jKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkOiBuZXh0UmVjb3JkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGF3YWl0IGFzc2VydE9wZW5lZFByZWZhYihwcmVwYXJlZC5pbmZvLnV1aWQsIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkKTtcclxuICAgICAgICAvLyBPbmNlIHRoZSBzYXZlIHJlcXVlc3QgaXMgc2VudCBpdHMgcmVzdWx0IGlzIGFtYmlndW91cyB1bnRpbCB0aGVcclxuICAgICAgICAvLyBwZXJzaXN0ZWQgUHJlZmFiIGlzIHZlcmlmaWVkLiBEbyBub3Qgcm9sbCB0aGUgaW4tbWVtb3J5IFByZWZhYiBiYWNrXHJcbiAgICAgICAgLy8gb24gYW4gSVBDIHRpbWVvdXQ6IHRoZSBkaXNrIHdyaXRlIG1heSBhbHJlYWR5IGhhdmUgY29tcGxldGVkLlxyXG4gICAgICAgIHNhdmVBdHRlbXB0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yU2NlbmVTYXZlZCgpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChjdXJyZW50SW5mbywgbmV4dFJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25pyq5YyF5ZCr5pys5qyh5ZCM5q2l55Sf5oiQ55qE5YWo6YOoIGZpbGVJZO+8jOW3suWBnOatouabtOaWsCBNZXRh44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRNZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGN1cnJlbnRJbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChjdXJyZW50TWV0YSk7XHJcbiAgICAgICAgaWYgKCFjdXJyZW50UmVjb3JkIHx8IGN1cnJlbnRSZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlnKjkv53lrZjmnJ/pl7Tlj5HnlJ/lj5jljJbvvIzlt7Lmi5Lnu53mj5DkuqTjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChjdXJyZW50SW5mbywgc291cmNlSGFzaCwgbmV4dFJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsKTtcclxuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCOIFByZWZhYiBVVUlEIOagoemqjOWksei0peOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xyXG4gICAgICAgICAgICB1dWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzdWx0LnByZWZhYlVybCA9IHByZXBhcmVkLmluZm8udXJsO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QtYWJvcnQnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybUltcG9ydChyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0LCBvcGVyYXRpb25Pd25lcjogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgaWYgKCFkb2N1bWVudCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1wb3J0U2V0dGluZ3MgPSBzYWZlU2V0dGluZ3MocmVxdWVzdC5zZXR0aW5ncyk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24ob3BlcmF0aW9uT3duZXIpO1xyXG4gICAgY29uc3QgdHJhY2UgPSBkaWFnbm9zdGljU3RhcnQoJ+WvvOWFpeS7u+WKoScsIHsgcm9vdHM6IGRvY3VtZW50LnJvb3RzLm1hcCgobm9kZSkgPT4gKHsgaWQ6IG5vZGUuaWQsIG5hbWU6IG5vZGUubmFtZSB9KSkgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+WIhuaekOW5tuWHhuWkh+i1hOa6kOKApicgfSk7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAocmVxdWVzdC5vdmVycmlkZXMsIGRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGNvbnN0IHJldmlld0RvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3cy5pbnZhbGlkYXRlKCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3UmVjb3JkZXIgPSBuZXcgSW1wb3J0UmV2aWV3UmVjb3JkZXIoKTtcclxuICAgICAgICBjb25zdCBidWlsdEFzc2V0cyA9IGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflhajpg6jotYTmupAnLCB1bmRlZmluZWQsICgpID0+IGJ1aWxkQXNzZXRzKGRvY3VtZW50LCBkZWNpc2lvbnMsIGltcG9ydFNldHRpbmdzLCByZXZpZXdSZWNvcmRlcikpO1xyXG4gICAgICAgIGNvbnN0IHsgYXNzZXRzLCB3YXJuaW5ncyB9ID0gYnVpbHRBc3NldHM7XHJcbiAgICAgICAgY29uc3QgYXR0YWNoUmV2aWV3ID0gYXN5bmMgKHJlc3VsdDogU2NlbmVJbXBvcnRSZXN1bHQpID0+IHtcclxuICAgICAgICAgICAgcmVzdWx0LnJldmlldyA9IGF3YWl0IGZpbmFsaXplSW1wb3J0UmV2aWV3KGltcG9ydFJldmlld3MsIHJldmlld1JlY29yZGVyLCByZXZpZXdEb2N1bWVudCxcclxuICAgICAgICAgICAgICAgIHJlc3VsdC5yZXZpZXdCZWZvcmUsIHJlc3VsdC5yZXZpZXdBZnRlciwgcmVzdWx0LnByZWZhYlVybCwgd2FybmluZ3MsXHJcbiAgICAgICAgICAgICAgICBhc3luYyAoKSA9PiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLCBtZXRob2Q6ICdyZWZyZXNoUmV2aWV3QWZ0ZXInLCBhcmdzOiBbeyBpZDogcmV2aWV3UmVjb3JkZXIuaWQgfV0sXHJcbiAgICAgICAgICAgICAgICB9KSBhcyBSZXZpZXdTY2VuZSk7XHJcbiAgICAgICAgICAgIC8vIEFsc28gY292ZXIgbWFudWFsIGltcG9ydHMgd2hvc2UgcGFuZWwgd2FzIGNsb3NlZCB3aGlsZSBpbXBvcnRpbmcuXHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgICAgICAgICAgICAgIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ2ltcG9ydC1yZXZpZXctcmVhZHknLCByZXN1bHQucmV2aWV3KTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOe7k+aenOW3suS/neWtmO+8jOS9huiHquWKqOaJk+W8gOmdouadv+Wksei0pe+8jOivt+S7juaPkuS7tuS4reaJk+W8gOKAnOWvvOWFpee7k+aenOajgOafpeKAne+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QmVmb3JlO1xyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgLy8gYnVpbGRBc3NldHMgbWF5IHByb21vdGUgYSBjb250YWluZXIgdG8gYSBsb2NhbCBzYW1lLW5hbWUgcmVzb3VyY2UuXHJcbiAgICAgICAgLy8gQ29tcGlsZSBhZnRlciB0aGF0IHByb21vdGlvbiBzbyBhc3NldHMgYW5kIFNjZW5lTm9kZVNwZWMgc2hhcmUgdGhlXHJcbiAgICAgICAgLy8gZXhhY3Qgc2FtZSBmaW5hbCBwbGFuLlxyXG4gICAgICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgY29uc3QgZm9udHMgPSBhd2FpdCByZXNvbHZlRm9udHMoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZVJvb3RGcmFtZXMgPSBkb2N1bWVudC5yb290cy5tYXAobm9kZUZyYW1lKTtcclxuICAgICAgICBjb25zdCBtdWx0aXBsZVJvb3RzID0gZG9jdW1lbnQucm9vdHMubGVuZ3RoID4gMTtcclxuICAgICAgICBjb25zdCBhcnJhbmdlZFdpZHRoID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHNvdXJjZVJvb3RGcmFtZXMucmVkdWNlKCh0b3RhbCwgZnJhbWUpID0+IHRvdGFsICsgZnJhbWUud2lkdGgsIDApXHJcbiAgICAgICAgICAgICAgICArIE1hdGgubWF4KDAsIHNvdXJjZVJvb3RGcmFtZXMubGVuZ3RoIC0gMSkgKiAxNjBcclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdPy53aWR0aCA/PyAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RGcmFtZSA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICB4OiAwLFxyXG4gICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiBhcnJhbmdlZFdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCgwLCAuLi5zb3VyY2VSb290RnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLmhlaWdodCkpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXSA/PyB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgICAgICBsZXQgcm9vdEN1cnNvciA9IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBkb2N1bWVudC5yb290c1xyXG4gICAgICAgICAgICAubWFwKChub2RlLCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc3BlYyA9IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5ub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5mcmFtZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogcm9vdEN1cnNvcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDdXJzb3IgKz0gc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGggKyAxNjA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigobm9kZSk6IG5vZGUgaXMgU2NlbmVOb2RlU3BlYyA9PiBub2RlICE9PSBudWxsKTtcclxuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeaciemAieS4reS7u+S9leWPr+WvvOWFpeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgc291cmNlTm9kZUlkID0gZG9jdW1lbnQuc291cmNlTm9kZUlkO1xyXG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVmYWJXcml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5yb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMC4wNSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKHtcclxuICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgIHByZWZhYk5hbWU6IGZyYW1lTmFtZSxcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VOb2RlSWQsXHJcbiAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICAgICAgLy8gUHJlZmFiIHVwZGF0ZXMgcGVyc2lzdCBieSBQcmVmYWJJbmZvLmZpbGVJZCBpbiB0aGUgYXNzZXQgbWV0YTtcclxuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR977yM5bey5omT5byA6aKE5Yi25L2TICR7cHJlZmFiVXJsfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgICAgICByZXZpZXdJZDogcmV2aWV3UmVjb3JkZXIuaWQsXHJcbiAgICAgICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICByb290TmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB1cGRhdGVFeGlzdGluZzogaW1wb3J0U2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTWFwOiBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XSA/PyB7fSxcclxuICAgICAgICAgICAgcm9vdHMsXHJcbiAgICAgICAgfTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ3NjZW5lJywgdmFsdWU6IDAuMSwgbWVzc2FnZTogJ+ato+WcqOaehOW7uiBDb2NvcyDoioLngrnmoJHigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID0gcmVzdWx0Lm5vZGVNYXA7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnbm9kZScsIHJlc3VsdC5yb290VXVpZCk7XHJcbiAgICAgICAgaWYgKGltcG9ydFNldHRpbmdzLmF1dG9TYXZlKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgY29uc3QgZmluYWxSZXN1bHQgPSB3YXJuaW5ncy5sZW5ndGggPyB7IC4uLnJlc3VsdCwgd2FybmluZ3MgfSA6IHJlc3VsdDtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S6YCA6ICcnfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdHJhY2UuZG9uZSgpO1xyXG4gICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgQ2FuY2VsbGVkRXJyb3IgfHwgY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5Y+W5raI44CCJyB9KTtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmk43kvZzlt7Llj5bmtojjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflr7zlhaXlpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgdHJhY2UuZXZlbnQoJ+WQjuWPsOS7u+WKoeW3sumHiuaUvicpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRNY3BQbHVnaW5TdGF0ZSgpIHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgdmF1bHQ6IHZhdWx0LnN0YXR1cygpLFxyXG4gICAgICAgIHNldHRpbmdzOiBhd2FpdCBnZXRTZXR0aW5ncygpLFxyXG4gICAgICAgIGRvY3VtZW50OiBkb2N1bWVudCA/IHtcclxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpLFxyXG4gICAgICAgIH0gOiBudWxsLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGx1Z2luU3RhdGUoKSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIC4uLmF3YWl0IGdldE1jcFBsdWdpblN0YXRlKCksXHJcbiAgICAgICAgZm9udEFzc2V0czogYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPliBGaWdtYSDmlofku7bigKYnIH0pO1xyXG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXJzZWQubm9kZUlkXHJcbiAgICAgICAgICAgID8gYXdhaXQgYXBpLmdldE5vZGUocGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpXHJcbiAgICAgICAgICAgIDogYXdhaXQgYXBpLmdldEZpbGUocGFyc2VkLmZpbGVLZXkpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oXHJcbiAgICAgICAgICAgIHBhcnNlRG9jdW1lbnQocGF5bG9hZCwgc291cmNlVXJsLCBwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZCksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcclxuICAgICAgICBhd2FpdCBzYXZlU2V0dGluZ3MoeyAuLi5jdXJyZW50LCBzb3VyY2VVcmwgfSk7XHJcbiAgICAgICAgY29uc3QgZm9udEFzc2V0cyA9IGF3YWl0IGxpc3RGb250QXNzZXRzKCk7XHJcbiAgICAgICAgY29uc3Qgbm9kZU92ZXJyaWRlcyA9IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoZG9jdW1lbnQuZmlsZUtleSk7XHJcbiAgICAgICAgYWN0aXZlRG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgICAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6IGDlt7Lor7vlj5YgJHtkb2N1bWVudC5maWxlTmFtZX1gIH0pO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsLFxyXG4gICAgICAgICAgICB0cmVlOiBkb2N1bWVudC50cmVlLFxyXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgIGZvbnRBc3NldHMsXHJcbiAgICAgICAgICAgIG5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgfTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVQcmV2aWV3KG5vZGVJZDogc3RyaW5nKTogUHJvbWlzZTx7IHVybDogc3RyaW5nIH0+IHtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBjb25zdCBub2RlID0gZG9jdW1lbnQ/Lm5vZGVCeUlkLmdldChub2RlSWQpO1xyXG4gICAgaWYgKCFkb2N1bWVudCB8fCAhbm9kZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6aKE6KeI6IqC54K55LiN5a2Y5Zyo44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBjbGllbnQoY29udHJvbGxlci5zaWduYWwpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgIGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIFtub2RlSWRdLFxyXG4gICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgMSxcclxuICAgICAgICAgICAgIW92ZXJmbG93aW5nUmVuZGVyRnJhbWUobm9kZSksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBpZiAoIXVybHNbbm9kZUlkXSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleeUn+aIkOiKgueCuemihOiniOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZUlkXSB9O1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBtZXRob2RzOiBSZWNvcmQ8c3RyaW5nLCAoLi4uYXJnczogYW55W10pID0+IGFueT4gPSB7XHJcbiAgICBnZXRJbXBvcnRSZXZpZXcoKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLmdldCgpOyB9LFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3UHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcpIHsgcmV0dXJuIGltcG9ydFJldmlld3MucHJldmlldyhpZCwgYXNzZXRJZCk7IH0sXHJcbiAgICBhc3luYyBhcHBseUltcG9ydFJldmlldyhpZDogc3RyaW5nLCByZW1vdmVkSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5a+85YWl5oiWIEZpZ21hIOmihOiniOWujOaIkOOAgicpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gdHJ1ZTtcclxuICAgICAgICB0cnkgeyByZXR1cm4gYXdhaXQgaW1wb3J0UmV2aWV3cy5hcHBseShpZCwgcmVtb3ZlZElkcyk7IH1cclxuICAgICAgICBmaW5hbGx5IHsgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XHJcbiAgICB9LFxyXG4gICAgYXN5bmMgZ2V0SW1wb3J0UmV2aWV3U291cmNlUHJldmlldyhpZDogc3RyaW5nLCBhc3NldElkOiBzdHJpbmcsIG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXIpIHRocm93IG5ldyBFcnJvcign6K+3562J5b6F5b2T5YmN5pON5L2c5a6M5oiQ5ZCO5YaN5Yqg6L295p2l5rqQ6aKE6KeI44CCJyk7XHJcbiAgICAgICAgY29uc3QgeyBmaWxlS2V5LCBub2RlIH0gPSBpbXBvcnRSZXZpZXdzLnNvdXJjZShpZCwgYXNzZXRJZCwgbm9kZUlkKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcclxuICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsbHNbaW1hZ2VSZWZdKSByZXR1cm4geyB1cmw6IGZpbGxzW2ltYWdlUmVmXSwgbm90ZTogJ0ZpZ21hIOWOn+Wbvu+8iOacquWQiOaIkOiKgueCueaViOaenO+8iScgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmICghdXJsc1tub2RlLmlkXSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDmnKrov5Tlm57pooTop4jvvIzpmpDol4/miJblpI3mnYLmlYjmnpzoioLngrnlj6/og73ml6Dms5XljZXni6zmuLLmn5PjgIInKTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGUuaWRdLCBub3RlOiAnRmlnbWEg5b2T5YmN6IqC54K55riy5p+T77yI6ZqQ6JeP56WW5YWI5Y+v6IO95L2/6aKE6KeI6YCP5piO77yJJyB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxyXG4gICAgfSxcclxuICAgIG9wZW5QYW5lbCgpIHtcclxuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFBsdWdpblN0YXRlKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNldFRva2VuKHZhbHVlOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuc2V0KHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgY2xlYXJUb2tlbigpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XHJcbiAgICAgICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkudmVyaWZ5KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleTogdW5rbm93biwgb3ZlcnJpZGVzOiB1bmtub3duLCBzY29wZUlkczogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZmV0Y2hGaWdtYURvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gZ2V0Tm9kZVByZXZpZXcobm9kZUlkKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwRGV0ZWN0KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmRldGVjdChzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQcmV2aWV3KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnByZXZpZXcoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUGFpcihwYWlyVG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmFwcGx5KHByZXZpZXdUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgcm91bmR0cmlwQ2FuY2VsKCkge1xyXG4gICAgICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGNhbmNlbEltcG9ydCgpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxufTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0TWNwQnJpZGdlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIGlmIChwcmV2aW91cykgYXdhaXQgcHJldmlvdXMuY2xvc2UoKTtcclxuXHJcbiAgICBjb25zdCBjcmVhdG9yVmVyc2lvbiA9IChFZGl0b3IuQXBwIGFzIHVua25vd24gYXMgeyB2ZXJzaW9uPzogc3RyaW5nIH0pLnZlcnNpb24gPz8gJ3Vua25vd24nO1xyXG4gICAgY29uc3QgYXBpID0gbmV3IEZpZ21hSW1wb3J0ZXJNY3BBcGkoe1xyXG4gICAgICAgIHByb2plY3RQYXRoOiBFZGl0b3IuUHJvamVjdC5wYXRoLFxyXG4gICAgICAgIGNyZWF0b3JWZXJzaW9uLFxyXG4gICAgICAgIGdldERvY3VtZW50UmV2aXNpb246ICgpID0+IGRvY3VtZW50UmV2aXNpb24sXHJcbiAgICAgICAgaXNJbXBvcnRCdXN5OiAoKSA9PiBhY3RpdmVDb250cm9sbGVyICE9PSBudWxsLFxyXG4gICAgICAgIGdldFN0YXRlOiBnZXRNY3BQbHVnaW5TdGF0ZSxcclxuICAgICAgICBmZXRjaERvY3VtZW50OiBmZXRjaEZpZ21hRG9jdW1lbnQsXHJcbiAgICAgICAgZ2V0UHJldmlldzogZ2V0Tm9kZVByZXZpZXcsXHJcbiAgICAgICAgc2F2ZVNldHRpbmdzLFxyXG4gICAgICAgIHBhdGNoU2V0dGluZ3MsXHJcbiAgICAgICAgc2F2ZU5vZGVPdmVycmlkZXMsXHJcbiAgICAgICAgcGF0Y2hOb2RlTmFtZXMsXHJcbiAgICAgICAgaW1wb3J0U2VsZWN0aW9uOiAocmVxdWVzdCwgb3BlcmF0aW9uSWQpID0+IHBlcmZvcm1JbXBvcnQocmVxdWVzdCwgb3BlcmF0aW9uSWQpLFxyXG4gICAgICAgIGNhbmNlbEltcG9ydDogKG9wZXJhdGlvbklkKSA9PiB7XHJcbiAgICAgICAgICAgIGlmICghYWN0aXZlQ29udHJvbGxlciB8fCBhY3RpdmVPcGVyYXRpb25Pd25lciAhPT0gb3BlcmF0aW9uSWQpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgYWN0aXZlQ29udHJvbGxlci5hYm9ydCgpO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBuZXcgTWNwQnJpZGdlU2VydmVyKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBwbHVnaW5WZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHBsdWdpbkluc3RhbmNlSWQsXHJcbiAgICAgICAgaW52b2tlOiAobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCkgPT4gYXBpLmludm9rZShtZXRob2QsIHBhcmFtcywgc2lnbmFsKSxcclxuICAgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBicmlkZ2Uuc3RhcnQoKTtcclxuICAgICAgICBtY3BBcGkgPSBhcGk7XHJcbiAgICAgICAgbWNwQnJpZGdlID0gYnJpZGdlO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBhd2FpdCBicmlkZ2UuY2xvc2UoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5ZCv5Yqo5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGF3YWl0IHZhdWx0LmluaXRpYWxpemUoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gYXdhaXQgcmVjb3ZlckludGVycnVwdGVkVHJhbnNhY3Rpb25zKEVkaXRvci5Qcm9qZWN0LnBhdGgsIGVkaXRvclJlaW1wb3J0ZXIpO1xyXG4gICAgICAgIGNvbnN0IGFjdGl2ZSA9IHJlY292ZXJlZC5maWx0ZXIoKHJlc3VsdCkgPT4gcmVzdWx0LnN0YXR1cyA9PT0gJ2FjdGl2ZS1vd25lcicpO1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGFjdGl2ZS5sZW5ndGhcclxuICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7YWN0aXZlLmxlbmd0aH0g5Liq5LuN55Sx5rS75Yqo6L+b56iL5oyB5pyJ55qEIFJvdW5kLXRyaXAg5LqL5Yqh77yM5pqC5pe256aB5q2iIFBhaXIvQXBwbHnjgIJgXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYFJvdW5kLXRyaXAg5ZCv5Yqo5oGi5aSN5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWA7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RhcnRNY3BCcmlkZ2UoKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHVubG9hZCgpOiB2b2lkIHtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxuICAgIGFjdGl2ZU9wZXJhdGlvbk93bmVyID0gbnVsbDtcclxuICAgIGFjdGl2ZURvY3VtZW50ID0gbnVsbDtcclxuICAgIGRvY3VtZW50UmV2aXNpb24gKz0gMTtcclxuICAgIGNvbnN0IGJyaWRnZSA9IG1jcEJyaWRnZTtcclxuICAgIG1jcEJyaWRnZSA9IG51bGw7XHJcbiAgICBtY3BBcGkgPSBudWxsO1xyXG4gICAgdm9pZCBicmlkZ2U/LmNsb3NlKCkuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgY29uc29sZS5lcnJvcihgRmlnbWEgSW1wb3J0ZXIgTUNQIEJyaWRnZSDlhbPpl63lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YCk7XHJcbiAgICB9KTtcclxufVxyXG4iXX0=