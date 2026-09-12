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
        const tileAsset = (asset, source) => ({
            ...asset,
            tiled: true,
            tileScale: requestedScale(source) / renderScale(source),
        });
        const groups = new Map();
        for (const { node, source } of items) {
            const sourceKey = JSON.stringify({
                fileKey: session.fileKey,
                kind: source.kind,
                id: source.id,
                paintScale: source.scale,
                renderScale: renderScale(source),
            });
            const key = writer.buildTiledUrl(node.name, sourceKey, 'png')
                .normalize('NFKC')
                .toLocaleLowerCase('en-US');
            const group = (_a = groups.get(key)) !== null && _a !== void 0 ? _a : { node, nodes: [], source, sourceKey };
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
                for (const extension of assets_1.RASTER_IMAGE_EXTENSIONS) {
                    existingAsset = await writer.existing(writer.buildTiledUrl(group.node.name, group.sourceKey, extension), true);
                    if (existingAsset) {
                        break;
                    }
                }
            }
            if (existingAsset) {
                completeGroup(group.nodes, tileAsset(existingAsset, group.source), 'existing');
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
            const url = writer.buildTiledUrl(item.node.name, item.sourceKey, extension);
            completeGroup(item.nodes, tileAsset(await writer.write(url, contents, undefined, true), item.source), item.sourceType);
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
            const sliceAnalysis = decision.nineSlice && format === 'png'
                ? (0, slicing_1.analyzeSliceGrid)(node)
                : null;
            if (decision.nineSlice && !sliceAnalysis) {
                warnings.add(`三/九宫节点“${node.name}”无法计算连续切片边界，已临时作为 PNG 整层导入`);
            }
            const borders = sliceAnalysis === null || sliceAnalysis === void 0 ? void 0 : sliceAnalysis.borders;
            // Sliced assets retain their exact geometric canvas because their
            // border metadata is expressed in that coordinate space.
            const renderFrame = borders ? undefined : overflowingRenderFrame(node);
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, format);
                if (localMatch) {
                    break;
                }
            }
            const localUrl = localMatch && !borders
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                completeGroup(groupedNodes, localAsset, 'local');
                continue;
            }
            const existing = !importSettings.refreshAssets ? await writer.existing(url) : null;
            if (!localMatch && existing && !borders && !renderFrame) {
                completeGroup(groupedNodes, existing, 'existing');
                continue;
            }
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
            if (result.reviewBefore && result.reviewAfter) {
                try {
                    result.reviewAfter = await Editor.Message.request('scene', 'execute-scene-script', {
                        name: package_json_1.default.name, method: 'refreshReviewAfter', args: [{ id: reviewRecorder.id }],
                    });
                    result.review = await importReviews.complete(reviewRecorder, reviewDocument, result.reviewBefore, result.reviewAfter, result.prefabUrl, warnings);
                    if (operationOwner)
                        Editor.Message.send(package_json_1.default.name, 'import-review-ready', result.review);
                }
                catch (error) {
                    warnings.push(`导入已完成，但结果检查生成失败：${error.message}`);
                }
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
                message: `完成：新建 ${result.created}，更新 ${result.updated}，已打开预制体 ${prefabUrl}${warnings.length ? `；${warnings.length} 个三/九宫已降级为 PNG 整层` : ''}`,
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
            message: `完成：新建 ${result.created}，更新 ${result.updated}${warnings.length ? `；${warnings.length} 个三/九宫已降级为 PNG 整层` : ''}`,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQW1kQSx3REFnQkM7QUE4QkQsa0NBeUJDO0FBRUQsZ0VBU0M7QUE2RkQsd0NBcUNDO0FBZ25CRCw0QkFzR0M7QUEyL0JELG9CQWFDO0FBRUQsd0JBWUM7QUFuNUVELCtCQUE4RTtBQUM5RSwyQkFBZ0M7QUFDaEMsbUNBQXFDO0FBQ3JDLCtDQUFnRTtBQUNoRSwwQ0FBZ0Q7QUFDaEQsbUVBQTBDO0FBQzFDLDJDQUE4RTtBQUM5RSwrQ0FVMEI7QUFDMUIsMkNBQStDO0FBQy9DLDJEQUdnQztBQUNoQyw2Q0FBdUU7QUFDdkUscUNBQStDO0FBQy9DLHFEQUkwQjtBQUMxQiw4Q0FPMkI7QUFDM0IsNENBQXVFO0FBRXZFLGdFQUFrRTtBQUNsRSx3Q0FBNkM7QUFDN0Msc0RBQXVEO0FBQ3ZELHdEQVlnQztBQUNoQyx3REFBb0Q7QUFDcEQsdUNBQXVFO0FBQ3ZFLGdEQUFzRDtBQUN0RCxpREFBdUQ7QUFDdkQsbURBQXNFO0FBQ3RFLHlEQUEyRDtBQUMzRCxtQ0FtQmlCO0FBQ2pCLDJDQUErQztBQUMvQyw0REFBcUY7QUFHckYsTUFBTSxLQUFLLEdBQUcsSUFBSSx3QkFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsTUFBTSxhQUFhLEdBQUcsSUFBSSxtQ0FBbUIsRUFBRSxDQUFDO0FBQ2hELElBQUksb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0FBQ2pDLElBQUksY0FBYyxHQUEyQixJQUFJLENBQUM7QUFDbEQsSUFBSSxnQkFBZ0IsR0FBMkIsSUFBSSxDQUFDO0FBQ3BELElBQUksb0JBQW9CLEdBQWtCLElBQUksQ0FBQztBQUMvQyxJQUFJLG1CQUFtQixHQUEyQixJQUFJLENBQUM7QUFDdkQsSUFBSSxhQUFhLEdBQTBCLElBQUksQ0FBQztBQUNoRCxJQUFJLHdCQUF3QixHQUFrQixJQUFJLENBQUM7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QUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBaUIsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBQ3JGLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDakIsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUMvQyxDQUFDO0lBQ0QsTUFBTSxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3RELE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN0RCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN4RSxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUMxRSxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO0FBQzFELENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxJQUFlO0lBQzlCLElBQUksSUFBSSxD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ZixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLHdCQUF3QixHQUFHLHFCQUFxQixLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNsRyxPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELE1BQU0sY0FBYyxFQUFFLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQWdCLE1BQU07SUFDbEIsZ0JBQWdCLGFBQWhCLGdCQUFnQix1QkFBaEIsZ0JBQWdCLENBQUUsS0FBSyxFQUFFLENBQUM7SUFDMUIsZ0JBQWdCLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLG9CQUFvQixHQUFHLElBQUksQ0FBQztJQUM1QixjQUFjLEdBQUcsSUFBSSxDQUFDO0lBQ3RCLGdCQUFnQixJQUFJLENBQUMsQ0FBQztJQUN0QixNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7SUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNqQixNQUFNLEdBQUcsSUFBSSxDQUFDO0lBQ2QsS0FBSyxDQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxLQUFLLEdBQUcsS0FBSyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7UUFDakMsT0FBTyxDQUFDLEtBQUssQ0FBQyxrQ0FBa0MsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQztJQUN2RyxDQUFDLENBQUMsQ0FBQSxDQUFDO0FBQ1AsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGJhc2VuYW1lLCBleHRuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGRpYWdub3N0aWNTdGFydCwgZGlhZ25vc3RpY1Rhc2sgfSBmcm9tICcuL2RpYWdub3N0aWNzJztcclxuaW1wb3J0IHsgcmVhZEZpbGUsIHJlYWRkaXIgfSBmcm9tICdmcy9wcm9taXNlcyc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBGaWdtYUNsaWVudCwgQ2FuY2VsbGVkRXJyb3IsIGNsYW1wSW1hZ2VTY2FsZSB9IGZyb20gJy4vZmlnbWEvY2xpZW50JztcclxuaW1wb3J0IHtcclxuICAgIGhhc0hpZGRlbkRlc2NlbmRhbnQsXHJcbiAgICBpbmZlckFjdGlvbixcclxuICAgIGluZmVyQ29jb3NMYXlvdXRNb2RlLFxyXG4gICAgaW5mZXJLaW5kLFxyXG4gICAgaXNQYXRjaENhbmRpZGF0ZSxcclxuICAgIGlzVmVjdG9yTm9kZSxcclxuICAgIG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2UsXHJcbiAgICBwbGFpbkltYWdlU291cmNlUmVmLFxyXG4gICAgdHlwZSBUaWxlZFBhaW50U291cmNlLFxyXG59IGZyb20gJy4vZmlnbWEvYW5hbHl6ZXInO1xyXG5pbXBvcnQgeyBwYXJzZURvY3VtZW50IH0gZnJvbSAnLi9maWdtYS9wYXJzZXInO1xyXG5pbXBvcnQge1xyXG4gICAgYW5ub3RhdGVUcmVlV2l0aEltcG9ydFBsYW4sXHJcbiAgICBjb21waWxlSW1wb3J0UGxhbixcclxufSBmcm9tICcuL2ZpZ21hL2ltcG9ydC1wbGFubmVyJztcclxuaW1wb3J0IHsgYW5hbHl6ZVNsaWNlR3JpZCwgdHlwZSBTbGljZUFuYWx5c2lzIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7XHJcbiAgICBpc1Rlcm1pbmFsQWN0aW9uLFxyXG4gICAga2luZEZvckltcG9ydEFjdGlvbixcclxuICAgIG5vcm1hbGl6ZUltcG9ydEFjdGlvbixcclxufSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHtcclxuICAgIEFzc2V0V3JpdGVyLFxyXG4gICAgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMsXHJcbiAgICBkZXRlY3RJbWFnZUV4dGVuc2lvbixcclxuICAgIHJlc29sdmVBc3NldFV1aWQsXHJcbiAgICBzYW5pdGl6ZUFzc2V0TmFtZSxcclxuICAgIHR5cGUgUmFzdGVySW1hZ2VFeHRlbnNpb24sXHJcbn0gZnJvbSAnLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgeyBMb2NhbEFzc2V0Q2FjaGUsIHR5cGUgQ2FjaGVFbnRyeUtleSB9IGZyb20gJy4vaW1wb3J0ZXIvY2FjaGUnO1xyXG5pbXBvcnQgdHlwZSB7IEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBMb2NhbFJlc291cmNlTGlicmFyeSB9IGZyb20gJy4vaW1wb3J0ZXIvbG9jYWwtcmVzb3VyY2VzJztcclxuaW1wb3J0IHsgZ3JhZGllbnRQbmcgfSBmcm9tICcuL2ltcG9ydGVyL3N2Zyc7XG5pbXBvcnQgeyB3cml0ZVNsaWNlZFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc2xpY2VkLXBuZyc7XG5pbXBvcnQge1xyXG4gICAgY29sbGVjdFNjZW5lU3BlY0ZpZ21hSWRzLFxyXG4gICAgY3JlYXRlTWluaW1hbFByZWZhYkpzb24sXHJcbiAgICBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgZmlnbWFGcmFtZVNvdXJjZUhhc2gsXHJcbiAgICBtZXJnZVByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICBwbGFuUHJlZmFiUmVjb3ZlcnlUYXJnZXQsXHJcbiAgICBwcmVmYWJKc29uQ29udGFpbnNTeW5jUmVjb3JkLFxyXG4gICAgcmVhZFByZWZhYlN5bmNSZWNvcmQsXHJcbiAgICByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZSxcclxuICAgIHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgdHlwZSBQcmVmYWJTeW5jUmVjb3JkLFxyXG59IGZyb20gJy4vaW1wb3J0ZXIvcHJlZmFiLXN5bmMnO1xyXG5pbXBvcnQgeyBUb2tlblZhdWx0IH0gZnJvbSAnLi9zZWN1cml0eS90b2tlbi12YXVsdCc7XHJcbmltcG9ydCB7IEZpZ21hSW1wb3J0ZXJNY3BBcGksIHR5cGUgTWNwTm9kZU5hbWVQYXRjaCB9IGZyb20gJy4vbWNwLWFwaSc7XHJcbmltcG9ydCB7IE1jcEJyaWRnZVNlcnZlciB9IGZyb20gJy4vbWNwLWJyaWRnZS9zZXJ2ZXInO1xyXG5pbXBvcnQgeyBSb3VuZHRyaXBTZXJ2aWNlIH0gZnJvbSAnLi9yb3VuZHRyaXAvc2VydmljZSc7XHJcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcclxuaW1wb3J0IHsgZWRpdG9yUmVpbXBvcnRlciB9IGZyb20gJy4vcm91bmR0cmlwL3RyYW5zYWN0aW9uJztcclxuaW1wb3J0IHtcclxuICAgIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgICB0eXBlIERvY3VtZW50U2Vzc2lvbixcclxuICAgIHR5cGUgRmlnbWFOb2RlLFxyXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXHJcbiAgICB0eXBlIEltcG9ydERlY2lzaW9uLFxyXG4gICAgdHlwZSBJbXBvcnRPdmVycmlkZSxcclxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcclxuICAgIHR5cGUgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICB0eXBlIE5vZGVLaW5kLFxyXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcclxuICAgIHR5cGUgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgdHlwZSBQcm9ncmVzc0V2ZW50LFxyXG4gICAgdHlwZSBSZWN0LFxyXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHlwZSBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICB0eXBlIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdSZWNvcmRlciwgSW1wb3J0UmV2aWV3U2VydmljZSB9IGZyb20gJy4vaW1wb3J0ZXIvaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3LCBSZXZpZXdTY2VuZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcblxyXG5jb25zdCB2YXVsdCA9IG5ldyBUb2tlblZhdWx0KHBhY2thZ2VKU09OLm5hbWUpO1xyXG5jb25zdCBpbXBvcnRSZXZpZXdzID0gbmV3IEltcG9ydFJldmlld1NlcnZpY2UoKTtcclxubGV0IGFwcGx5aW5nSW1wb3J0UmV2aWV3ID0gZmFsc2U7XHJcbmxldCBhY3RpdmVEb2N1bWVudDogRG9jdW1lbnRTZXNzaW9uIHwgbnVsbCA9IG51bGw7XHJcbmxldCBhY3RpdmVDb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZU9wZXJhdGlvbk93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcENvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgc2V0dGluZ3NDYWNoZTogSW1wb3J0U2V0dGluZ3MgfCBudWxsID0gbnVsbDtcclxubGV0IHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbmxldCBkb2N1bWVudFJldmlzaW9uID0gMDtcclxubGV0IG1jcEJyaWRnZTogTWNwQnJpZGdlU2VydmVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBtY3BBcGk6IEZpZ21hSW1wb3J0ZXJNY3BBcGkgfCBudWxsID0gbnVsbDtcclxuY29uc3QgcGx1Z2luSW5zdGFuY2VJZCA9IHJhbmRvbUJ5dGVzKDE4KS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbmxldCBub2RlT3ZlcnJpZGVXcml0ZVF1ZXVlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCBzZXR0aW5nc1dyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuXHJcbnR5cGUgRGVjaXNpb24gPSBJbXBvcnREZWNpc2lvbjtcclxuXHJcbmludGVyZmFjZSBUaWxlZEFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSYXdJbWFnZUFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBpbWFnZVJlZjogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHJldmlld0lkPzogc3RyaW5nO1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJldmlld0JlZm9yZT86IFJldmlld1NjZW5lO1xyXG4gICAgcmV2aWV3QWZ0ZXI/OiBSZXZpZXdTY2VuZTtcclxuICAgIHJldmlldz86IEltcG9ydFJldmlldztcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxuICAgIHdhcm5pbmdzPzogc3RyaW5nW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBBc3NldEJ1aWxkUmVzdWx0IHtcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPjtcclxuICAgIHdhcm5pbmdzOiBzdHJpbmdbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFByZWZhYkFzc2V0SW5mbyB7XHJcbiAgICB1dWlkOiBzdHJpbmc7XHJcbiAgICB1cmw6IHN0cmluZztcclxuICAgIGltcG9ydGVyOiBzdHJpbmc7XHJcbiAgICB0eXBlOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlZDogYm9vbGVhbjtcclxuICAgIGludmFsaWQ6IGJvb2xlYW47XHJcbiAgICBpc0RpcmVjdG9yeT86IGJvb2xlYW47XHJcbiAgICByZWFkb25seT86IGJvb2xlYW47XHJcbiAgICByZWRpcmVjdD86IHVua25vd247XHJcbn1cclxuXHJcbmNvbnN0IEZPTlRfRVhURU5TSU9OUyA9IG5ldyBTZXQoWycudHRmJywgJy5vdGYnLCAnLmZudCcsICcud29mZicsICcud29mZjInXSk7XHJcbmNvbnN0IE5PREVfS0lORFMgPSBuZXcgU2V0PE5vZGVLaW5kPihbXHJcbiAgICAnYXV0bycsXHJcbiAgICAnbm9kZScsXHJcbiAgICAnc3ByaXRlJyxcclxuICAgICdsYWJlbCcsXHJcbiAgICAncmljaFRleHQnLFxyXG4gICAgJ2J1dHRvbicsXHJcbiAgICAnc2Nyb2xsVmlldycsXHJcbiAgICAnbGF5b3V0JyxcclxuXSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBsaXN0Rm9udEFzc2V0cygpOiBQcm9taXNlPEZvbnRBc3NldE9wdGlvbltdPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBmb250czogRm9udEFzc2V0T3B0aW9uW10gPSBbXTtcclxuICAgIGFzeW5jIGZ1bmN0aW9uIHZpc2l0KGZvbGRlcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgbGV0IGVudHJpZXM7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZW50cmllcyA9IGF3YWl0IHJlYWRkaXIoZm9sZGVyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnbm9kZV9tb2R1bGVzJyB8fCBlbnRyeS5uYW1lID09PSAnbGlicmFyeScgfHwgZW50cnkubmFtZSA9PT0gJ3RlbXAnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZm9sZGVyLCBlbnRyeS5uYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHZpc2l0KGZpbGVQYXRoKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghRk9OVF9FWFRFTlNJT05TLmhhcyhleHRuYW1lKGVudHJ5Lm5hbWUpLnRvTG93ZXJDYXNlKCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgZmlsZVBhdGgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuICAgICAgICAgICAgZm9udHMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShlbnRyeS5uYW1lLCBleHRuYW1lKGVudHJ5Lm5hbWUpKSxcclxuICAgICAgICAgICAgICAgIHVybDogYGRiOi8vYXNzZXRzLyR7cGF0aH1gLFxyXG4gICAgICAgICAgICAgICAgcmVsYXRpdmVQYXRoOiBwYXRoLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBhd2FpdCB2aXNpdChhc3NldHNSb290KTtcclxuICAgIHJldHVybiBmb250cy5zb3J0KChhLCBiKSA9PiBhLnJlbGF0aXZlUGF0aC5sb2NhbGVDb21wYXJlKGIucmVsYXRpdmVQYXRoLCAnemgtQ04nKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVtaXRQcm9ncmVzcyhwcm9ncmVzczogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAncHJvZ3Jlc3MnLCBwcm9ncmVzcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHRDYWNoZUZvbGRlcigpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oRWRpdG9yLlByb2plY3QudG1wRGlyLCBwYWNrYWdlSlNPTi5uYW1lLCAnYXNzZXQtY2FjaGUnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogSW1wb3J0U2V0dGluZ3Mge1xyXG4gICAgY29uc3QgaW5wdXQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyB2YWx1ZSBhcyBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPlxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCBzY2FsZSA9IHR5cGVvZiBpbnB1dC5zY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGlucHV0LnNjYWxlKVxyXG4gICAgICAgID8gTWF0aC5tYXgoMC4yNSwgTWF0aC5taW4oNCwgaW5wdXQuc2NhbGUpKVxyXG4gICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5zY2FsZTtcclxuICAgIGNvbnN0IGZvbnRNYXAgPSBpbnB1dC5mb250TWFwICYmIHR5cGVvZiBpbnB1dC5mb250TWFwID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGlucHV0LmZvbnRNYXApXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKFtrZXksIGl0ZW1dKSA9PiBrZXkudHJpbSgpICYmIHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJylcclxuICAgICAgICAgICAgLm1hcCgoW2tleSwgaXRlbV0pID0+IFtrZXkudHJpbSgpLCBpdGVtLnRyaW0oKV0pKVxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCByYXdMb2NhbEZvbGRlcnMgPSBBcnJheS5pc0FycmF5KGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzKVxyXG4gICAgICAgID8gaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICA6IHR5cGVvZiBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICA/IFtpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyXVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZUZvbGRlcnMgPSByYXdMb2NhbEZvbGRlcnNcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIpOiBmb2xkZXIgaXMgc3RyaW5nID0+IHR5cGVvZiBmb2xkZXIgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gZm9sZGVyLnRyaW0oKSlcclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyLCBpbmRleCwgZm9sZGVycykgPT4gZm9sZGVycy5pbmRleE9mKGZvbGRlcikgPT09IGluZGV4KVxyXG4gICAgICAgIC5zbGljZSgwLCAzKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiB0eXBlb2YgaW5wdXQuc291cmNlVXJsID09PSAnc3RyaW5nJyA/IGlucHV0LnNvdXJjZVVybC50cmltKCkgOiAnJyxcclxuICAgICAgICBhc3NldEZvbGRlcjogdHlwZW9mIGlucHV0LmFzc2V0Rm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogdHlwZW9mIGlucHV0LnByZWZhYkZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVycyxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiBsb2NhbFJlc291cmNlRm9sZGVyc1swXSA/PyAnJyxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogaW5wdXQudXBkYXRlRXhpc3RpbmcgIT09IGZhbHNlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGlucHV0LnJlZnJlc2hBc3NldHMgPT09IHRydWUsXHJcbiAgICAgICAgYXV0b1NhdmU6IGlucHV0LmF1dG9TYXZlID09PSB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5nc1VubG9ja2VkKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGlmIChzZXR0aW5nc0NhY2hlKSB7XHJcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgJ3Byb2plY3QnKTtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGF3YWl0IHNldHRpbmdzV3JpdGVRdWV1ZTtcclxuICAgIHJldHVybiBnZXRTZXR0aW5nc1VubG9ja2VkKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdpdGhTZXR0aW5nc1dyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IHNldHRpbmdzV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICBzZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSBzYWZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgbmV4dCwgJ3Byb2plY3QnKTtcclxuICAgICAgICBzZXR0aW5nc0NhY2hlID0gbmV4dDtcclxuICAgICAgICByZXR1cm4gbmV4dDtcclxuICAgIH0pKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHJldHVybiB3aXRoU2V0dGluZ3NXcml0ZUxvY2soKCkgPT4gcGVyc2lzdFNldHRpbmdzVW5sb2NrZWQodmFsdWUpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGF0Y2hTZXR0aW5ncyh2YWx1ZTogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz4pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICByZXR1cm4gd2l0aFNldHRpbmdzV3JpdGVMb2NrKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3NVbmxvY2tlZCgpO1xyXG4gICAgICAgIHJldHVybiBwZXJzaXN0U2V0dGluZ3NVbmxvY2tlZCh7IC4uLmN1cnJlbnQsIC4uLnZhbHVlIH0pO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWVudChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkID0gYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsKTogUHJvbWlzZTxGaWdtYUNsaWVudD4ge1xyXG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIHJldHVybiBuZXcgUm91bmR0cmlwU2VydmljZSh7XHJcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcclxuICAgICAgICBwcm9qZWN0Um9vdDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgcm91bmR0cmlwQ29udHJvbGxlciA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luT3BlcmF0aW9uKG93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IEFib3J0Q29udHJvbGxlciB7XG4gICAgaWYgKGFwcGx5aW5nSW1wb3J0UmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ato+WcqOehruiupOWvvOWFpeWQjueahOi1hOa6kOiwg+aVtO+8jOivt+eojeWAmeOAgicpO1xuICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3lt7LmnIkgRmlnbWEg5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5a6M5oiQ5oiW5YWI5Y+W5raI44CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG93bmVyO1xyXG4gICAgcmV0dXJuIGNvbnRyb2xsZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIpOiB2b2lkIHtcclxuICAgIGlmIChhY3RpdmVDb250cm9sbGVyID09PSBjb250cm9sbGVyKSB7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICAgICAgYWN0aXZlT3BlcmF0aW9uT3duZXIgPSBudWxsO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShzZWxlY3RlZFBhdGgpO1xyXG4gICAgY29uc3QgZm9sZGVyID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgaWYgKCFmb2xkZXIgfHwgZm9sZGVyID09PSAnLicgfHwgZm9sZGVyLnN0YXJ0c1dpdGgoJy4uJykgfHwgaXNBYnNvbHV0ZShmb2xkZXIpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfotYTmupDovpPlh7rnm67lvZXlv4XpobvmmK/pobnnm64gYXNzZXRzIOS4i+eahOWtkOaWh+S7tuWkueOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2V0RGF0YWJhc2VVcmwoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKGZpbGVQYXRoKTtcclxuICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBjb25zdCBvdXRzaWRlID0gcGF0aCA9PT0gJy4uJ1xyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi4vJylcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uXFxcXCcpXHJcbiAgICAgICAgfHwgaXNBYnNvbHV0ZShwYXRoKTtcclxuICAgIGlmICghcGF0aCB8fCBwYXRoID09PSAnLicgfHwgb3V0c2lkZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3BhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpfWA7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqSBGaWdtYSDlr7zlhaXotYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6npooTliLbkvZPovpPlh7rnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24sIF9pbmRleCA9IDApOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJyA/IGN1cnJlbnQudHJpbSgpIDogJyc7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgaXNBYnNvbHV0ZShjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgID8gY3VycmVudEZvbGRlclxyXG4gICAgICAgIDogcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6nmnKzlnLDlkIzlkI3otYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsaWJyYXJ5ID0gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KHNlbGVjdGVkKTtcclxuICAgIHJldHVybiB7IGZvbGRlcjogbGlicmFyeS5yb290IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVuaW9uRnJhbWUobm9kZXM6IEZpZ21hTm9kZVtdKTogUmVjdCB7XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2Rlcy5tYXAobm9kZUZyYW1lKS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgUmVjdCA9PiBCb29sZWFuKHZhbHVlKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCB4ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLngpKTtcclxuICAgIGNvbnN0IHkgPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSkpO1xyXG4gICAgY29uc3QgcmlnaHQgPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoKSk7XHJcbiAgICBjb25zdCBib3R0b20gPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCkpO1xyXG4gICAgcmV0dXJuIHsgeCwgeSwgd2lkdGg6IHJpZ2h0IC0geCwgaGVpZ2h0OiBib3R0b20gLSB5IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHtcclxuICAgIGlmIChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuaW9uRnJhbWUobm9kZS5jaGlsZHJlbik7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbn1cclxuXHJcbmNvbnN0IFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OID0gMC41O1xyXG5cclxuLyoqXHJcbiAqIE9ubHkgZXhwYW5kIHJhc3RlcnMgd2hvc2UgdmlzaWJsZSBwaXhlbHMgZXNjYXBlIHRoZSBnZW9tZXRyaWMgZnJhbWUuIEFcclxuICogcmVuZGVyIGZyYW1lIGNvbnRhaW5lZCBpbnNpZGUgdGhlIGdlb21ldHJ5IG9mdGVuIHJlcHJlc2VudHMgaW50ZW50aW9uYWxcclxuICogdHJhbnNwYXJlbnQgcGFkZGluZyBhbmQgbXVzdCBrZWVwIHRoZSBsZWdhY3kgZml4ZWQtY2FudmFzIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGdlb21ldHJ5ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcmVuZGVyID0gbm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcztcclxuICAgIGlmICghZ2VvbWV0cnkgfHwgIXJlbmRlciB8fCByZW5kZXIud2lkdGggPD0gMCB8fCByZW5kZXIuaGVpZ2h0IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZ2VvbWV0cnlSaWdodCA9IGdlb21ldHJ5LnggKyBnZW9tZXRyeS53aWR0aDtcclxuICAgIGNvbnN0IGdlb21ldHJ5Qm90dG9tID0gZ2VvbWV0cnkueSArIGdlb21ldHJ5LmhlaWdodDtcclxuICAgIGNvbnN0IHJlbmRlclJpZ2h0ID0gcmVuZGVyLnggKyByZW5kZXIud2lkdGg7XHJcbiAgICBjb25zdCByZW5kZXJCb3R0b20gPSByZW5kZXIueSArIHJlbmRlci5oZWlnaHQ7XHJcbiAgICByZXR1cm4gcmVuZGVyLnggPCBnZW9tZXRyeS54IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXIueSA8IGdlb21ldHJ5LnkgLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlclJpZ2h0ID4gZ2VvbWV0cnlSaWdodCArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyQm90dG9tID4gZ2VvbWV0cnlCb3R0b20gKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgID8gcmVuZGVyXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvcm5lclJhZGlpKG5vZGU6IEZpZ21hTm9kZSk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdIHtcclxuICAgIGlmIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpPy5sZW5ndGggPT09IDQpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJhZGl1cyA9IG5vZGUuY29ybmVyUmFkaXVzID8/IDA7XHJcbiAgICByZXR1cm4gW3JhZGl1cywgcmFkaXVzLCByYWRpdXMsIHJhZGl1c107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBEZWNpc2lvbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogaW5mZXJBY3Rpb24obm9kZSksXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXNQYXRjaENhbmRpZGF0ZShub2RlKSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWNpc2lvbkZvck5vZGUobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPik6IERlY2lzaW9uIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb247XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkZWNpc2lvbk1hcChvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10sIHRyZWU6IFRyZWVOb2RlRHRvW10pOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4ge1xyXG4gICAgY29uc3QgZGVjaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIERlY2lzaW9uPigpO1xyXG4gICAgY29uc3QgYWRkRGVmYXVsdHMgPSAobm9kZXM6IFRyZWVOb2RlRHRvW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7XHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihub2RlLmFjdGlvbiksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBhZGREZWZhdWx0cyhub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgYWRkRGVmYXVsdHModHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgICAgICBkZWNpc2lvbnMuc2V0KGl0ZW0uaWQsIHtcclxuICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgICAgICBraW5kOiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQpID8gaXRlbS5raW5kIDogJ2F1dG8nLFxyXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxyXG4gICAgICAgICAgICBleHBsaWNpdDogaXRlbS5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbnM7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbiAgICBpbmNsdWRlTm9kZU5hbWUgPSB0cnVlLFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKTtcclxuICAgIHJldHVybiBkZWNpc2lvbj8uZXhwbGljaXQgPT09IHRydWVcclxuICAgICAgICB8fCAoaW5jbHVkZU5vZGVOYW1lICYmIEJvb2xlYW4oZGVjaXNpb24/Lm5hbWUpKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxudHlwZSBTdG9yZWROb2RlT3ZlcnJpZGVzID0gUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+PjtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTogUHJvbWlzZTxTdG9yZWROb2RlT3ZlcnJpZGVzPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgaXRlbSA9IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0T3ZlcnJpZGU+O1xyXG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xyXG4gICAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBraW5kID0gdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgJiYgTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKVxyXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXHJcbiAgICAgICAgOiAnYXV0byc7XHJcbiAgICBjb25zdCBleHBsaWNpdCA9IGl0ZW0uZXhwbGljaXQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgIGlmICghZXhwbGljaXQgJiYgIW5hbWUpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZCxcclxuICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxyXG4gICAgICAgIGV4cGxpY2l0LFxyXG4gICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgY29uc3Qgc3RvcmVkID0gKGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKSlbZmlsZUtleV0gPz8ge307XHJcbiAgICBjb25zdCByZXN1bHQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xyXG4gICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlLCBpZCk7XHJcbiAgICAgICAgaWYgKHNhZmUpIHJlc3VsdC5wdXNoKHNhZmUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jazxUPihvcGVyYXRpb246ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5vZGVPdmVycmlkZVdyaXRlUXVldWUudGhlbihvcGVyYXRpb24pO1xyXG4gICAgbm9kZU92ZXJyaWRlV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNhdmVOb2RlT3ZlcnJpZGVzVW5sb2NrZWQoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xyXG4gICAgY29uc3Qgc2FmZUl0ZW1zID0gaXRlbXNcclxuICAgICAgICAubWFwKChpdGVtKSA9PiBzYWZlTm9kZU92ZXJyaWRlKGl0ZW0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgIChBcnJheS5pc0FycmF5KHNjb3BlVmFsdWVzKSA/IHNjb3BlVmFsdWVzIDogc2FmZUl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxyXG4gICAgKTtcclxuICAgIGlmICghc2NvcGVJZHMuc2l6ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY29wZWRJdGVtcyA9IHNhZmVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNjb3BlSWRzLmhhcyhpdGVtLmlkKSk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgZm9yIChjb25zdCBpZCBvZiBzY29wZUlkcykge1xyXG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzY29wZWRJdGVtcykge1xyXG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xyXG4gICAgfVxyXG4gICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkge1xyXG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNjb3BlZEl0ZW1zO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYXZlTm9kZU92ZXJyaWRlcyhcclxuICAgIGZpbGVLZXk6IHVua25vd24sXHJcbiAgICB2YWx1ZXM6IHVua25vd24sXHJcbiAgICBzY29wZVZhbHVlczogdW5rbm93bixcclxuKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhcclxuICAgICAgICAoKSA9PiBzYXZlTm9kZU92ZXJyaWRlc1VubG9ja2VkKGZpbGVLZXksIHZhbHVlcywgc2NvcGVWYWx1ZXMpLFxyXG4gICAgKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBhdGNoTm9kZU5hbWVzKGZpbGVLZXk6IHN0cmluZywgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPiB7XHJcbiAgICByZXR1cm4gd2l0aE5vZGVPdmVycmlkZVdyaXRlTG9jayhhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFmaWxlS2V5LnRyaW0oKSkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgRmlnbWEgZmlsZUtleeOAgicpO1xyXG4gICAgICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZDogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgcGF0Y2ggb2YgcGF0Y2hlcykge1xyXG4gICAgICAgICAgICBjb25zdCBpZCA9IHR5cGVvZiBwYXRjaC5pZCA9PT0gJ3N0cmluZycgPyBwYXRjaC5pZC50cmltKCkgOiAnJztcclxuICAgICAgICAgICAgaWYgKCFpZCkgdGhyb3cgbmV3IEVycm9yKCfml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJrnvLrlsJEgbm9kZUlk44CCJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gc2FmZU5vZGVPdmVycmlkZShjdXJyZW50W2lkXSwgaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBmYWxsYmFjayA9IHNhZmVOb2RlT3ZlcnJpZGUocGF0Y2guZmFsbGJhY2ssIGlkKTtcclxuICAgICAgICAgICAgY29uc3QgbmV4dCA9IGV4aXN0aW5nID8geyAuLi5leGlzdGluZyB9IDogZmFsbGJhY2sgPyB7IC4uLmZhbGxiYWNrIH0gOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIW5leHQgJiYgcGF0Y2gubmFtZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFuZXh0KSB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleS/neWtmOiKgueCueWQjeensO+8muiKgueCuSAke2lkfSDnvLrlsJHmnInmlYjpu5jorqTnrZbnlaXjgIJgKTtcclxuICAgICAgICAgICAgaWYgKHBhdGNoLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBuZXh0Lm5hbWU7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShwYXRjaC5uYW1lKTtcclxuICAgICAgICAgICAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xkv53lrZjoioLngrnlkI3np7DvvJroioLngrkgJHtpZH0g55qE5ZCN56ew5peg5pWI44CCYCk7XHJcbiAgICAgICAgICAgICAgICBuZXh0Lm5hbWUgPSBuYW1lO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKG5leHQsIGlkKTtcclxuICAgICAgICAgICAgaWYgKHNhZmUpIHtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnRbaWRdID0gc2FmZTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3RlZC5wdXNoKHNhZmUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgZGVsZXRlIGN1cnJlbnRbaWRdO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhjdXJyZW50KS5sZW5ndGgpIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICAgICAgZWxzZSBkZWxldGUgc3RvcmVkW2ZpbGVLZXldO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCBzdG9yZWQsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIHBlcnNpc3RlZDtcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xyXG4gICAgY29uc3QgZGVmYXVsdHMgPSBkZWNpc2lvbk1hcChbXSwgc2Vzc2lvbi50cmVlKTtcclxuICAgIHNlc3Npb24udHJlZSA9IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgICAgIHNlc3Npb24udHJlZSxcclxuICAgICAgICBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWZhdWx0cyksXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbik6IHsgcG5nOiBGaWdtYU5vZGVbXTsgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W107IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXTsgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSB9IHtcclxuICAgIGNvbnN0IHBuZzogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IGdyYWRpZW50czogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IEZpZ21hTm9kZSwgYW5jZXN0b3JzVmlzaWJsZTogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBlZmZlY3RpdmVseVZpc2libGUgPSBhbmNlc3RvcnNWaXNpYmxlICYmIG5vZGUudmlzaWJsZSAhPT0gZmFsc2UgJiYgbm9kZS5vcGFjaXR5ID4gMDtcclxuICAgICAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UpIHtcclxuICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgICAgICAgICAgaWYgKHNvdXJjZSkge1xyXG4gICAgICAgICAgICAgICAgdGlsZWQucHVzaCh7IG5vZGUsIHNvdXJjZSB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gZWZmZWN0aXZlbHlWaXNpYmxlID8gdW5kZWZpbmVkIDogcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJhd0ltYWdlcy5wdXNoKHsgbm9kZSwgaW1hZ2VSZWYgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkQXNzZXRzKFxyXG4gICAgc2Vzc2lvbjogRG9jdW1lbnRTZXNzaW9uLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBpbXBvcnRTZXR0aW5nczogSW1wb3J0U2V0dGluZ3MsXHJcbiAgICByZXZpZXc6IEltcG9ydFJldmlld1JlY29yZGVyLFxyXG4pOiBQcm9taXNlPEFzc2V0QnVpbGRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5hc3NldEZvbGRlciwgKHVybCwgZXhpc3RlZCkgPT4gcmV2aWV3LmJlZm9yZVdyaXRlKHVybCwgZXhpc3RlZCkpO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICBjb25zdCBwcm9tb3RlTG9jYWxQYXJlbnRzID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgICAgICAvLyBSZW5hbWluZyB0aGlzIGNvbnRhaW5lciBkb2VzIG5vdCBjaGFuZ2UgcmVzb3VyY2UgbWF0Y2hpbmc7IG9ubHlcclxuICAgICAgICAgICAgLy8gYSBzdHJhdGVneSBvdmVycmlkZSBvbiBpdHNlbGYgb3IgYW55IG92ZXJyaWRlIGJlbG93IGl0IGJsb2Nrc1xyXG4gICAgICAgICAgICAvLyBwcm9tb3Rpb24gYmVjYXVzZSBkZXNjZW5kYW50cyB3b3VsZCBvdGhlcndpc2UgZGlzYXBwZWFyLlxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcclxuICAgICAgICAgICAgLy8gQSBsb2NhbCBwYXJlbnQgcmVzb3VyY2UgY2Fubm90IHJlcHJlc2VudCBpbmRlcGVuZGVudGx5IGluYWN0aXZlXHJcbiAgICAgICAgICAgIC8vIGRlc2NlbmRhbnRzLiBLZWVwIHRoZSBoaWVyYXJjaHkgd2hlbmV2ZXIgc3VjaCBhIGJvdW5kYXJ5IGV4aXN0cy5cclxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgbGV0IGxvY2FsTWF0Y2ggPSBudWxsO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgICAgIGxvY2FsTWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobm9kZS5uYW1lLCAncG5nJyk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobm9kZS5jaGlsZHJlbi5tYXAocHJvbW90ZUxvY2FsUGFyZW50cykpO1xyXG4gICAgfTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKHNlc3Npb24ucm9vdHMubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIGNvbnN0IHJlcXVlc3RzID0gY29sbGVjdEFzc2V0UmVxdWVzdHMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IGFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XHJcbiAgICBjb25zdCB3YXJuaW5ncyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoXHJcbiAgICAgICAgKyByZXF1ZXN0cy5yYXdJbWFnZXMubGVuZ3RoICsgcmVxdWVzdHMuZ3JhZGllbnRzLmxlbmd0aDtcclxuICAgIGxldCBjb21wbGV0ZWQgPSAwO1xyXG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgZ2V0QXBpID0gKCkgPT4ge1xyXG4gICAgICAgIGFwaVByb21pc2UgPz89IGRpYWdub3N0aWNUYXNrKCflh4blpIcgRmlnbWEg5a6i5oi356uvJywgdW5kZWZpbmVkLCAoKSA9PiBjbGllbnQoKSk7XHJcbiAgICAgICAgcmV0dXJuIGFwaVByb21pc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGNvbXBsZXRlQXNzZXQgPSAoXHJcbiAgICAgICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnIHwgJ2dlbmVyYXRlZCcgPSAnZmlnbWEnLFxyXG4gICAgKSA9PiB7XHJcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XHJcbiAgICAgICAgcmV2aWV3LmJpbmQobm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xyXG4gICAgICAgICAgICA/ICflpI3nlKjmnKzlnLDotYTmupAnXHJcbiAgICAgICAgICAgIDogc291cmNlID09PSAnZXhpc3RpbmcnXHJcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXHJcbiAgICAgICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2dlbmVyYXRlZCdcclxuICAgICAgICAgICAgICAgICAgICA/ICfnlJ/miJDmuJDlj5gnXHJcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHt2ZXJifSAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1RpbGVkID0gYXN5bmMgKGl0ZW1zOiBUaWxlZEFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxuICAgICAgICAgICAgc291cmNlS2V5OiBzdHJpbmc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBQZW5kaW5nVGlsZSBleHRlbmRzIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcclxuICAgICAgICAgICAgc291cmNlVHlwZTogJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XHJcbiAgICAgICAgY29uc3QgcmVuZGVyU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBzb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICA/IGNsYW1wSW1hZ2VTY2FsZShyZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKVxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgY29uc3QgdGlsZUFzc2V0ID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSk6IFNwcml0ZUFzc2V0U3BlYyA9PiAoe1xyXG4gICAgICAgICAgICAuLi5hc3NldCxcclxuICAgICAgICAgICAgdGlsZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIHRpbGVTY2FsZTogcmVxdWVzdGVkU2NhbGUoc291cmNlKSAvIHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFRpbGVHcm91cD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgbm9kZSwgc291cmNlIH0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAga2luZDogc291cmNlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFpbnRTY2FsZTogc291cmNlLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyU2NhbGU6IHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChub2RlLm5hbWUsIHNvdXJjZUtleSwgJ3BuZycpXHJcbiAgICAgICAgICAgICAgICAubm9ybWFsaXplKCdORktDJylcclxuICAgICAgICAgICAgICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlLCBub2RlczogW10sIHNvdXJjZSwgc291cmNlS2V5IH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZ0Fzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGV4dGVuc2lvbiBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdyaXRlci5idWlsZFRpbGVkVXJsKGdyb3VwLm5vZGUubmFtZSwgZ3JvdXAuc291cmNlS2V5LCBleHRlbnNpb24pLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0Fzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwLm5vZGVzLCB0aWxlQXNzZXQoZXhpc3RpbmdBc3NldCwgZ3JvdXAuc291cmNlKSwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgY2FjaGVkRXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRlbnNpb25zOiByZWFkb25seSBSYXN0ZXJJbWFnZUV4dGVuc2lvbltdID0gZ3JvdXAuc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IFsncG5nJ11cclxuICAgICAgICAgICAgICAgICAgICA6IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TO1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBleHRlbnNpb24gb2YgZXh0ZW5zaW9ucykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtncm91cC5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShncm91cC5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWNoZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBjYWNoZWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlZEV4dGVuc2lvbiA9IGV4dGVuc2lvbjtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAuLi5ncm91cCxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBjYWNoZWRFeHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VUeXBlOiBjb250ZW50cyA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuVXJscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5zQnlTY2FsZSA9IG5ldyBNYXA8bnVtYmVyLCBTZXQ8c3RyaW5nPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmVtb3RlSXRlbXMpIHtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc291cmNlLmtpbmQgIT09ICdzb3VyY2Utbm9kZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBpZHMgPSBwYXR0ZXJuc0J5U2NhbGUuZ2V0KHNjYWxlKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgaWRzLmFkZChpdGVtLnNvdXJjZS5pZCk7XHJcbiAgICAgICAgICAgIHBhdHRlcm5zQnlTY2FsZS5zZXQoc2NhbGUsIGlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgW3NjYWxlLCBpZHNdIG9mIHBhdHRlcm5zQnlTY2FsZSkge1xyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBBcnJheS5mcm9tKGlkcyksXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtpZCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyh1cmxzKSkge1xyXG4gICAgICAgICAgICAgICAgcGF0dGVyblVybHMuc2V0KGAke2lkfTpzY2FsZToke3NjYWxlfWAsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmVlZHNJbWFnZUZpbGxzID0gcmVtb3RlSXRlbXMuc29tZSgoaXRlbSkgPT4gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ2ltYWdlLXJlZicpO1xyXG4gICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBuZWVkc0ltYWdlRmlsbHNcclxuICAgICAgICAgICAgPyBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KVxyXG4gICAgICAgICAgICA6IHt9O1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWQgPSAodXJsOiBzdHJpbmcsIG5vZGVMYWJlbDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZCh1cmwsIG5vZGVMYWJlbCkpO1xyXG4gICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldCh1cmwsIHRhc2spO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB0YXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uID0gaXRlbS5leHRlbnNpb247XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IHBhdHRlcm5VcmxzLmdldChcclxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7aXRlbS5zb3VyY2UuaWR9OnNjYWxlOiR7cmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgICAgICAgIDogaW1hZ2VGaWxsVXJsc1tpdGVtLnNvdXJjZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGBQQVRURVJOIOa6kOiKgueCuSAke2l0ZW0uc291cmNlLmlkfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBgSU1BR0Ug5aGr5YWFICR7aXRlbS5zb3VyY2UuaWR9YDtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+myR7bGFiZWx977yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgZG93bmxvYWQocmVtb3RlVXJsLCBgJHtpdGVtLm5vZGUubmFtZX0gKCR7aXRlbS5ub2RlLmlkfSlgKTtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdwbmcnXHJcbiAgICAgICAgICAgICAgICAgICAgOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtpdGVtLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFleHRlbnNpb24pIHtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChpdGVtLm5vZGUubmFtZSwgaXRlbS5zb3VyY2VLZXksIGV4dGVuc2lvbik7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgdGlsZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzLCB1bmRlZmluZWQsIHRydWUpLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlLFxyXG4gICAgICAgICAgICAgICAgKSxcclxuICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlVHlwZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSZW1vdGUgPSBhc3luYyAobm9kZXM6IEZpZ21hTm9kZVtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFub2Rlcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmb3JtYXQgPSAncG5nJyBhcyBjb25zdDtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyB1cmw6IHN0cmluZzsgbm9kZXM6IEZpZ21hTm9kZVtdIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfWAsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gdXJsLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IHVybCwgbm9kZXM6IFtdIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IEFycmF5PHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHVybDogc3RyaW5nO1xyXG4gICAgICAgICAgICBib3JkZXJzPzogeyBsZWZ0OiBudW1iZXI7IHJpZ2h0OiBudW1iZXI7IHRvcDogbnVtYmVyOyBib3R0b206IG51bWJlciB9O1xuICAgICAgICAgICAgc2xpY2VBbmFseXNpcz86IFNsaWNlQW5hbHlzaXM7XG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XHJcbiAgICAgICAgICAgIGtleTogQ2FjaGVFbnRyeUtleTtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH0+ID0gW107XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgeyB1cmwsIG5vZGVzOiBncm91cGVkTm9kZXMgfSBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZ3JvdXBlZE5vZGVzWzBdO1xyXG4gICAgICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBzbGljZUFuYWx5c2lzID0gZGVjaXNpb24ubmluZVNsaWNlICYmIGZvcm1hdCA9PT0gJ3BuZydcclxuICAgICAgICAgICAgICAgID8gYW5hbHl6ZVNsaWNlR3JpZChub2RlKVxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhc2xpY2VBbmFseXNpcykge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtub2RlLm5hbWV94oCd5peg5rOV6K6h566X6L+e57ut5YiH54mH6L6555WM77yM5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaVgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBib3JkZXJzID0gc2xpY2VBbmFseXNpcz8uYm9yZGVycztcclxuICAgICAgICAgICAgLy8gU2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlIHRoZWlyXHJcbiAgICAgICAgICAgIC8vIGJvcmRlciBtZXRhZGF0YSBpcyBleHByZXNzZWQgaW4gdGhhdCBjb29yZGluYXRlIHNwYWNlLlxyXG4gICAgICAgICAgICBjb25zdCByZW5kZXJGcmFtZSA9IGJvcmRlcnMgPyB1bmRlZmluZWQgOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICBsZXQgbG9jYWxNYXRjaCA9IG51bGw7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbFJlc291cmNlcykge1xyXG4gICAgICAgICAgICAgICAgbG9jYWxNYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChub2RlLm5hbWUsIGZvcm1hdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbG9jYWxNYXRjaCAmJiAhYm9yZGVyc1xyXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcclxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgbG9jYWxBc3NldCwgJ2xvY2FsJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9ICFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKHVybCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWxvY2FsTWF0Y2ggJiYgZXhpc3RpbmcgJiYgIWJvcmRlcnMgJiYgIXJlbmRlckZyYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qga2V5OiBDYWNoZUVudHJ5S2V5ID0ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdmFyaWFudDogcmVuZGVyRnJhbWUgPyAndmlzdWFsLW92ZXJmbG93LXYxJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gbG9jYWxNYXRjaCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgY2FjaGUucmVhZChrZXkpO1xyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIG5vZGVzOiBncm91cGVkTm9kZXMsXHJcbiAgICAgICAgICAgICAgICB1cmwsXHJcbiAgICAgICAgICAgICAgICBib3JkZXJzLFxuICAgICAgICAgICAgICAgIHNsaWNlQW5hbHlzaXM6IHNsaWNlQW5hbHlzaXMgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIHJlbmRlckZyYW1lOiBsb2NhbE1hdGNoID8gdW5kZWZpbmVkIDogcmVuZGVyRnJhbWUsXHJcbiAgICAgICAgICAgICAgICBrZXksXHJcbiAgICAgICAgICAgICAgICBjb250ZW50czogbG9jYWxNYXRjaD8uY29udGVudHMgPz8gY2FjaGVkLFxyXG4gICAgICAgICAgICAgICAgc291cmNlOiBsb2NhbE1hdGNoID8gJ2xvY2FsJyA6IGNhY2hlZCA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdXJsczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4gPSB7fTtcclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgZm9yIChjb25zdCB1c2VBYnNvbHV0ZUJvdW5kcyBvZiBbdHJ1ZSwgZmFsc2VdKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGJhdGNoID0gcmVtb3RlSXRlbXMuZmlsdGVyKChpdGVtKSA9PiAoXHJcbiAgICAgICAgICAgICAgICB1c2VBYnNvbHV0ZUJvdW5kcyA/ICFpdGVtLnJlbmRlckZyYW1lIDogQm9vbGVhbihpdGVtLnJlbmRlckZyYW1lKVxyXG4gICAgICAgICAgICApKTtcclxuICAgICAgICAgICAgaWYgKCFiYXRjaC5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odXJscywgYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBiYXRjaC5tYXAoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzLFxyXG4gICAgICAgICAgICAgICAgT2JqZWN0LmZyb21FbnRyaWVzKGJhdGNoLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlLm5hbWVdKSksXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IHVybHNbaXRlbS5ub2RlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73muLLmn5PoioLngrnvvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCwgYCR7aXRlbS5ub2RlLm5hbWV9ICgke2l0ZW0ubm9kZS5pZH0pYCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZShpdGVtLmtleSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBhc3NldDogU3ByaXRlQXNzZXRTcGVjO1xuICAgICAgICAgICAgaWYgKGl0ZW0uc2xpY2VBbmFseXNpcykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRyYWNlID0gZGlhZ25vc3RpY1N0YXJ0KCfkuIkv5Lmd5a6r6LWE5rqQ5pyA5bCP5YyWJywgeyBub2RlOiBpdGVtLm5vZGUubmFtZSB9KTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB3cml0ZVNsaWNlZFBuZyh3cml0ZXIsIGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ub2RlLFxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNsaWNlQW5hbHlzaXMsIGltcG9ydFNldHRpbmdzLnNjYWxlKTtcbiAgICAgICAgICAgICAgICBhc3NldCA9IHJlc3VsdC5hc3NldDtcbiAgICAgICAgICAgICAgICB0cmFjZS5kb25lKHJlc3VsdC5vcHRpbWl6YXRpb24pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoYXNzZXQuc2xpY2VGYWxsYmFjaykge1xyXG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtpdGVtLm5vZGUubmFtZX3igJ3liIfniYforr7nva7lpLHotKXvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpe+8miR7YXNzZXQuc2xpY2VGYWxsYmFja31gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGl0ZW0ubm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgZ3JvdXBlZE5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgaXRlbS5yZW5kZXJGcmFtZVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IHsgLi4uYXNzZXQsIHJlbmRlckZyYW1lOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKGdyb3VwZWROb2RlKSA/PyBpdGVtLnJlbmRlckZyYW1lIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBhc3NldCxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSYXdJbWFnZXMgPSBhc3luYyAoaXRlbXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10pID0+IHtcclxuICAgICAgICBpZiAoIWl0ZW1zLmxlbmd0aCkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCB7IG5vZGU6IEZpZ21hTm9kZTsgbm9kZXM6IEZpZ21hTm9kZVtdOyBpbWFnZVJlZjogc3RyaW5nIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IGAke2l0ZW0ubm9kZS5uYW1lLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpfVxcMCR7aXRlbS5pbWFnZVJlZn1gO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IG5vZGU6IGl0ZW0ubm9kZSwgbm9kZXM6IFtdLCBpbWFnZVJlZjogaXRlbS5pbWFnZVJlZiB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgaW1hZ2VGaWxsVXJsc1Byb21pc2U6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nIHwgbnVsbD4+IHwgdW5kZWZpbmVkO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGxldCBzb3VyY2U6ICdjYWNoZScgfCAnZmlnbWEnID0gJ2NhY2hlJztcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgY2FjaGUucmVhZCh7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgbm9kZUlkOiBgaW1hZ2UtcmVmOiR7Z3JvdXAuaW1hZ2VSZWZ9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBjYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50OiAnc291cmNlLWltYWdlLXYxJyxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gY2FuZGlkYXRlO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgaWYgKCFpbWFnZUZpbGxVcmxzUHJvbWlzZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGltYWdlRmlsbFVybHNQcm9taXNlID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZ2V0SW1hZ2VGaWxsVXJscyhzZXNzaW9uLmZpbGVLZXkpKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBhd2FpdCBpbWFnZUZpbGxVcmxzUHJvbWlzZTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGltYWdlRmlsbFVybHNbZ3JvdXAuaW1hZ2VSZWZdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+m+makOiXj+WbvueJh+Whq+WFhe+8miR7Z3JvdXAubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHJlbW90ZVVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXNrID0gZ2V0QXBpKCkudGhlbigoYXBpKSA9PiBhcGkuZG93bmxvYWQocmVtb3RlVXJsLCBgJHtncm91cC5ub2RlLm5hbWV9ICgke2dyb3VwLm5vZGUuaWR9KWApKTtcclxuICAgICAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHJlbW90ZVVybCwgdGFzayk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IHRhc2s7XHJcbiAgICAgICAgICAgICAgICBzb3VyY2UgPSAnZmlnbWEnO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbiA/Pz0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OmltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAxLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGdyb3VwLm5vZGVzKSBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+W5s+mTuui1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnRpbGVkLmxlbmd0aCB9LCAoKSA9PiBwcm9jZXNzVGlsZWQocmVxdWVzdHMudGlsZWQpKTtcclxuICAgIGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIcgUE5HIOi1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnBuZy5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1JlbW90ZShyZXF1ZXN0cy5wbmcpKTtcclxuICAgIC8vIFJ1biBhZnRlciB3aG9sZS1ub2RlIHJlbmRlcnMgc28gYSBjb3JyZWN0IHZpc2liaWxpdHktaW5kZXBlbmRlbnQgc291cmNlXHJcbiAgICAvLyBpbWFnZSB3aW5zIGlmIGJvdGggcGF0aHMgc2hhcmUgdGhlIHNhbWUgbGVnYWN5IGFzc2V0IGZpbGVuYW1lLlxyXG4gICAgYXdhaXQgZGlhZ25vc3RpY1Rhc2soJ+WHhuWkh+makOiXj+WbvueJh+i1hOa6kCcsIHsgY291bnQ6IHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggfSwgKCkgPT4gcHJvY2Vzc1Jhd0ltYWdlcyhyZXF1ZXN0cy5yYXdJbWFnZXMpKTtcclxuXHJcbiAgICBjb25zdCBncmFkaWVudEFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcmVxdWVzdHMuZ3JhZGllbnRzKSB7XHJcbiAgICAgICAgY29uc3QgZnJhbWUgPSBub2RlLmFic29sdXRlQm91bmRpbmdCb3g7XHJcbiAgICAgICAgY29uc3QgZmlsbCA9IG5vZGUuZmlsbHMuZmluZCgoaXRlbSkgPT4gaXRlbS52aXNpYmxlICE9PSBmYWxzZSAmJiBpdGVtLnR5cGUuc3RhcnRzV2l0aCgnR1JBRElFTlRfJykpO1xyXG4gICAgICAgIGNvbnN0IHBuZyA9IGZyYW1lICYmIGZpbGxcclxuICAgICAgICAgICAgPyBncmFkaWVudFBuZyhcclxuICAgICAgICAgICAgICAgIGZyYW1lLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgZnJhbWUuaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgZmlsbCxcclxuICAgICAgICAgICAgICAgIGNvcm5lclJhZGlpKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIClcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGlmIChwbmcpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVXJsKFxyXG4gICAgICAgICAgICAgICAgbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgYCR7c2Vzc2lvbi5maWxlS2V5fToke25vZGUuaWR9OmdyYWRpZW50YCxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyYWRpZW50S2V5ID0gdXJsLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBmaXJzdEFzc2V0ID0gZ3JhZGllbnRBc3NldHMuZ2V0KGdyYWRpZW50S2V5KTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBmaXJzdEFzc2V0IHx8IGltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHNcclxuICAgICAgICAgICAgICAgID8gbnVsbFxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCB3cml0ZXIuZXhpc3RpbmcodXJsKTtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBmaXJzdEFzc2V0ID8/IGV4aXN0aW5nID8/IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIHBuZyk7XHJcbiAgICAgICAgICAgIGdyYWRpZW50QXNzZXRzLnNldChncmFkaWVudEtleSwgYXNzZXQpO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCBmaXJzdEFzc2V0IHx8IGV4aXN0aW5nID8gJ2V4aXN0aW5nJyA6ICdnZW5lcmF0ZWQnKTtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg55Sf5oiQ5riQ5Y+YICR7Y29tcGxldGVkfS8ke3RvdGFsfSDCtyAke25vZGUubmFtZX1gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgYXNzZXRzLCB3YXJuaW5nczogWy4uLndhcm5pbmdzXSB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlRm9udHMoc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogUHJvbWlzZTxNYXA8c3RyaW5nLCBzdHJpbmc+PiB7XHJcbiAgICBjb25zdCByZXN1bHQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xyXG4gICAgZm9yIChjb25zdCBbZmFtaWx5LCB1cmxdIG9mIE9iamVjdC5lbnRyaWVzKHNldHRpbmdzLmZvbnRNYXApKSB7XHJcbiAgICAgICAgY29uc3QgdXVpZCA9IGF3YWl0IHJlc29sdmVBc3NldFV1aWQodXJsKTtcclxuICAgICAgICBpZiAodXVpZCkge1xyXG4gICAgICAgICAgICByZXN1bHQuc2V0KGZhbWlseSwgdXVpZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGU6IEZpZ21hTm9kZSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XHJcbiAgICBjb25zdCBuYXRpdmVNb2RlID0gaW5mZXJDb2Nvc0xheW91dE1vZGUobm9kZSk7XHJcbiAgICBpZiAobmF0aXZlTW9kZSkge1xyXG4gICAgICAgIHJldHVybiBuYXRpdmVNb2RlO1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUubGF5b3V0TW9kZSAmJiBub2RlLmxheW91dE1vZGUgIT09ICdOT05FJykge1xyXG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICB9XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2RlLmNoaWxkcmVuXHJcbiAgICAgICAgLm1hcCgoY2hpbGQpID0+IGNoaWxkLmFic29sdXRlQm91bmRpbmdCb3gpXHJcbiAgICAgICAgLmZpbHRlcigoZnJhbWUpOiBmcmFtZSBpcyBSZWN0ID0+IEJvb2xlYW4oZnJhbWUpKTtcclxuICAgIGlmICghZnJhbWVzLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiAnVkVSVElDQUwnO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY2VudGVyc1ggPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoIC8gMik7XHJcbiAgICBjb25zdCBjZW50ZXJzWSA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS55ICsgZnJhbWUuaGVpZ2h0IC8gMik7XHJcbiAgICBjb25zdCBzcHJlYWRYID0gTWF0aC5tYXgoLi4uY2VudGVyc1gpIC0gTWF0aC5taW4oLi4uY2VudGVyc1gpO1xyXG4gICAgY29uc3Qgc3ByZWFkWSA9IE1hdGgubWF4KC4uLmNlbnRlcnNZKSAtIE1hdGgubWluKC4uLmNlbnRlcnNZKTtcclxuICAgIGlmIChzcHJlYWRZIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ0hPUklaT05UQUwnO1xyXG4gICAgfVxyXG4gICAgaWYgKHNwcmVhZFggPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnVkVSVElDQUwnO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICdHUklEJztcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VTcGVjKFxyXG4gICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgcGFyZW50RnJhbWU6IFJlY3QgfCB1bmRlZmluZWQsXHJcbiAgICBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPixcclxuICAgIHBsYW5zOiBSZWFkb25seU1hcDxzdHJpbmcsIE5vZGVJbXBvcnRQbGFuPixcclxuICAgIG5vZGVCeUlkOiBSZWFkb25seU1hcDxzdHJpbmcsIEZpZ21hTm9kZT4sXHJcbiAgICBhc3NldHM6IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4sXHJcbiAgICBmb250czogTWFwPHN0cmluZywgc3RyaW5nPixcclxuICAgIGlzUm9vdCA9IGZhbHNlLFxyXG4gICAgcGFyZW50V29ybGRSb3RhdGlvbiA9IDAsXHJcbik6IFNjZW5lTm9kZVNwZWMgfCBudWxsIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUobm9kZSk7XHJcbiAgICBjb25zdCBwbGFuID0gcGxhbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgY29uc3QgZm9sZCA9IHBsYW4/LmZvbGQ7XHJcbiAgICBjb25zdCBmb2xkU291cmNlID0gZm9sZCA/IG5vZGVCeUlkLmdldChmb2xkLnNvdXJjZU5vZGVJZCkgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCB0ZXh0U291cmNlID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCB2aXN1YWxTb3VyY2UgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCByZXNvbHZlZEtpbmQgPSBkZWNpc2lvbi5raW5kID09PSAnYXV0bycgPyBpbmZlcktpbmQobm9kZSkgOiBkZWNpc2lvbi5raW5kO1xyXG4gICAgY29uc3QgcGxhbm5lZEtpbmQgPSBwbGFuPy5raW5kID8/IHJlc29sdmVkS2luZDtcclxuICAgIGNvbnN0IGJpdG1hcFRlcm1pbmFsID0gZGVjaXNpb24ubmluZVNsaWNlIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcic7XHJcbiAgICBjb25zdCB0ZXJtaW5hbCA9IGJpdG1hcFRlcm1pbmFsIHx8IGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKTtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHBsYW5uZWRLaW5kLCBkZWNpc2lvbi5hY3Rpb24sIGRlY2lzaW9uLm5pbmVTbGljZSk7XHJcbiAgICBjb25zdCBzcHJpdGVTb3VyY2VJZCA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnXHJcbiAgICAgICAgPyBmb2xkLnNvdXJjZU5vZGVJZFxyXG4gICAgICAgIDogbm9kZS5pZDtcclxuICAgIGNvbnN0IHNwcml0ZUFzc2V0ID0gYXNzZXRzLmdldChzcHJpdGVTb3VyY2VJZCk7XHJcbiAgICBjb25zdCBhYnNvcmJlZERpcmVjdElkcyA9IG5ldyBTZXQoZm9sZCA/IFtmb2xkLnNvdXJjZU5vZGVJZF0gOiBbXSk7XHJcbiAgICBjb25zdCBmdWxsRm9sZCA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtaW1hZ2UnIHx8IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCc7XHJcbiAgICBjb25zdCB3b3JsZFJvdGF0aW9uID0gcGFyZW50V29ybGRSb3RhdGlvbiArIG5vZGUucm90YXRpb247XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpZ21hSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgbmFtZTogZGVjaXNpb24ubmFtZSA/PyBub2RlLm5hbWUsXHJcbiAgICAgICAgZmlnbWFUeXBlOiB2aXN1YWxTb3VyY2UudHlwZSxcclxuICAgICAgICBhY3Rpb246IGRlY2lzaW9uLmFjdGlvbixcclxuICAgICAgICBraW5kOiBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGZyYW1lLFxyXG4gICAgICAgIHBhcmVudEZyYW1lLFxyXG4gICAgICAgIGludHJpbnNpY1NpemU6IG5vZGUuc2l6ZSxcclxuICAgICAgICBpc1Jvb3QsXHJcbiAgICAgICAgcm90YXRpb246IG5vZGUucm90YXRpb24sXHJcbiAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICBvcGFjaXR5OiBmb2xkU291cmNlICYmIGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gbm9kZS5vcGFjaXR5ICogZm9sZFNvdXJjZS5vcGFjaXR5XHJcbiAgICAgICAgICAgIDogbm9kZS5vcGFjaXR5LFxyXG4gICAgICAgIHZpc2libGU6IG5vZGUudmlzaWJsZSxcclxuICAgICAgICBjbGlwc0NvbnRlbnQ6IG5vZGUuY2xpcHNDb250ZW50LFxyXG4gICAgICAgIGNvcm5lclJhZGlpOiBjb3JuZXJSYWRpaSh2aXN1YWxTb3VyY2UpLFxyXG4gICAgICAgIGZpbGxzOiB0ZXh0U291cmNlLmZpbGxzLFxyXG4gICAgICAgIHN0cm9rZXM6IHRleHRTb3VyY2Uuc3Ryb2tlcyxcclxuICAgICAgICBzdHJva2VXZWlnaHQ6IHRleHRTb3VyY2Uuc3Ryb2tlV2VpZ2h0LFxyXG4gICAgICAgIGNoYXJhY3RlcnM6IHRleHRTb3VyY2UuY2hhcmFjdGVycyxcclxuICAgICAgICB0ZXh0U3R5bGU6IHRleHRTb3VyY2Uuc3R5bGUsXHJcbiAgICAgICAgbGF5b3V0OiB7XHJcbiAgICAgICAgICAgIG1vZGU6IGVmZmVjdGl2ZUtpbmQgPT09ICdsYXlvdXQnIHx8IGVmZmVjdGl2ZUtpbmQgPT09ICdzY3JvbGxWaWV3J1xyXG4gICAgICAgICAgICAgICAgPyBpbmZlcnJlZExheW91dE1vZGUobm9kZSlcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICBzb3VyY2VNb2RlOiBub2RlLmxheW91dE1vZGUsXHJcbiAgICAgICAgICAgIHdyYXA6IG5vZGUubGF5b3V0V3JhcCxcclxuICAgICAgICAgICAgcHJpbWFyeUFsaWduOiBub2RlLnByaW1hcnlBeGlzQWxpZ25JdGVtcyxcclxuICAgICAgICAgICAgY291bnRlckFsaWduOiBub2RlLmNvdW50ZXJBeGlzQWxpZ25JdGVtcyxcclxuICAgICAgICAgICAgcHJpbWFyeVNpemluZzogbm9kZS5wcmltYXJ5QXhpc1NpemluZ01vZGUsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTaXppbmc6IG5vZGUuY291bnRlckF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBpdGVtU3BhY2luZzogbm9kZS5pdGVtU3BhY2luZyxcclxuICAgICAgICAgICAgY291bnRlclNwYWNpbmc6IG5vZGUuY291bnRlckF4aXNTcGFjaW5nLFxyXG4gICAgICAgICAgICBwYWRkaW5nTGVmdDogbm9kZS5wYWRkaW5nTGVmdCxcclxuICAgICAgICAgICAgcGFkZGluZ1JpZ2h0OiBub2RlLnBhZGRpbmdSaWdodCxcclxuICAgICAgICAgICAgcGFkZGluZ1RvcDogbm9kZS5wYWRkaW5nVG9wLFxyXG4gICAgICAgICAgICBwYWRkaW5nQm90dG9tOiBub2RlLnBhZGRpbmdCb3R0b20sXHJcbiAgICAgICAgfSxcclxuICAgICAgICBvdmVyZmxvd0RpcmVjdGlvbjogbm9kZS5vdmVyZmxvd0RpcmVjdGlvbixcclxuICAgICAgICBjb25zdHJhaW50czogbm9kZS5jb25zdHJhaW50cyxcclxuICAgICAgICByZWxhdGl2ZVRyYW5zZm9ybTogbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybSxcclxuICAgICAgICBzcHJpdGU6IHNwcml0ZUFzc2V0LFxyXG4gICAgICAgIGZvbnRVdWlkOiB0ZXh0U291cmNlLnN0eWxlPy5mb250RmFtaWx5ID8gZm9udHMuZ2V0KHRleHRTb3VyY2Uuc3R5bGUuZm9udEZhbWlseSkgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgYWxpYXNGaWdtYUlkczogZm9sZD8uYWJzb3JiZWROb2RlSWRzLFxyXG4gICAgICAgIGZsYXR0ZW5Cb3VuZGFyeTogYml0bWFwVGVybWluYWwgfHwgZnVsbEZvbGRcclxuICAgICAgICAgICAgPyB0cnVlXHJcbiAgICAgICAgICAgIDogZm9sZD8ua2luZCA9PT0gJ2JhY2tncm91bmQnXHJcbiAgICAgICAgICAgICAgICA/IGZhbHNlXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICBwbGFuUmVhc29uOiBwbGFuPy5yZWFzb24sXHJcbiAgICAgICAgY2hpbGRyZW46IHRlcm1pbmFsXHJcbiAgICAgICAgICAgID8gW11cclxuICAgICAgICAgICAgOiBub2RlLmNoaWxkcmVuXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCkgPT4gIWFic29yYmVkRGlyZWN0SWRzLmhhcyhjaGlsZC5pZCkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChjaGlsZCkgPT4gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgY2hpbGQsXHJcbiAgICAgICAgICAgICAgICAgICAgZnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICBmYWxzZSxcclxuICAgICAgICAgICAgICAgICAgICB3b3JsZFJvdGF0aW9uLFxyXG4gICAgICAgICAgICAgICAgKSlcclxuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoaWxkKTogY2hpbGQgaXMgU2NlbmVOb2RlU3BlYyA9PiBjaGlsZCAhPT0gbnVsbCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlTWFwcygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnID8gc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4gOiB7fTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29jb3NGaWxlSWQoKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGdlbmVyYXRlZCA9IEVkaXRvci5VdGlscz8uVVVJRD8uZ2VuZXJhdGU/Lih0cnVlKTtcclxuICAgIHJldHVybiB0eXBlb2YgZ2VuZXJhdGVkID09PSAnc3RyaW5nJyAmJiBnZW5lcmF0ZWQubGVuZ3RoID4gMFxyXG4gICAgICAgID8gZ2VuZXJhdGVkXHJcbiAgICAgICAgOiByYW5kb21CeXRlcygxNikudG9TdHJpbmcoJ2Jhc2U2NCcpLnJlcGxhY2UoLz0rJC9nLCAnJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5UHJlZmFiQXNzZXQodXJsT3JVdWlkOiBzdHJpbmcpOiBQcm9taXNlPFByZWZhYkFzc2V0SW5mbyB8IG51bGw+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LWluZm8nLFxyXG4gICAgICAgIHVybE9yVXVpZCxcclxuICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gYXNzZXJ0UHJlZmFiQXNzZXQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBleHBlY3RlZDogeyB1dWlkPzogc3RyaW5nOyB1cmw/OiBzdHJpbmcgfSA9IHt9LFxyXG4pOiB2b2lkIHtcclxuICAgIGlmIChpbmZvLmludmFsaWQgfHwgaW5mby5pbXBvcnRlZCAhPT0gdHJ1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOWwmuacquWujOaIkOWvvOWFpe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5pbXBvcnRlciAhPT0gJ3ByZWZhYicgfHwgaW5mby50eXBlICE9PSAnY2MuUHJlZmFiJyB8fCBpbmZvLmlzRGlyZWN0b3J5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIfotYTmupDkuI3mmK/lj6/nvJbovpHnmoQgQ29jb3MgUHJlZmFi77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLnJlYWRvbmx5IHx8IGluZm8ucmVkaXJlY3QpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg5Li65Y+q6K+75oiW6YeN5a6a5ZCR6LWE5rqQ77yM5LiN6IO95a6J5YWo5pu05paw77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChleHBlY3RlZC51dWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWQudXVpZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5qCh6aqM5aSx6LSl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChleHBlY3RlZC51cmwgJiYgaW5mby51cmwgIT09IGV4cGVjdGVkLnVybCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOi3r+W+hOagoemqjOWksei0pe+8muacn+acmyAke2V4cGVjdGVkLnVybH3vvIzlrp7pmYUgJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclByZWZhYkFzc2V0KHVybDogc3RyaW5nLCBleHBlY3RlZFV1aWQ/OiBzdHJpbmcpOiBQcm9taXNlPFByZWZhYkFzc2V0SW5mbz4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcclxuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh1cmwpO1xyXG4gICAgICAgIGlmIChpbmZvPy5pbnZhbGlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29jb3MgUHJlZmFiIOi1hOa6kOWvvOWFpeWksei0pe+8miR7dXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaW5mbz8uaW1wb3J0ZWQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgaWYgKGV4cGVjdGVkVXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkVXVpZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDlnKjlr7zlhaXmnJ/pl7Tlj5HnlJ/lj5jljJbvvJoke3VybH1gKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhc3NlcnRQcmVmYWJBc3NldChpbmZvLCB7IHV1aWQ6IGV4cGVjdGVkVXVpZCwgdXJsIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4gaW5mbztcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOetieW+hSBDb2NvcyBQcmVmYWIg6LWE5rqQ5bCx57uq6LaF5pe277yaJHt1cmx9YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHF1ZXJ5UHJlZmFiTWV0YSh1dWlkOiBzdHJpbmcpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XHJcbiAgICBjb25zdCBtZXRhID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1tZXRhJyxcclxuICAgICAgICB1dWlkLFxyXG4gICAgKTtcclxuICAgIGlmICghbWV0YSB8fCB0eXBlb2YgbWV0YSAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleivu+WPliBQcmVmYWIgTWV0Ye+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHZhbHVlID0gbWV0YSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgaWYgKHZhbHVlLnV1aWQgIT09IHV1aWQgfHwgdmFsdWUuaW1wb3J0ZXIgIT09ICdwcmVmYWInKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgTWV0YSDkuI7nm67moIfotYTmupDkuI3ljLnphY3vvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHByZWZhYkRpc2tQYXRoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmICghdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vJykpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVUkwg5peg5pWI77yaJHt1cmx9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCB1cmwuc2xpY2UoJ2RiOi8vJy5sZW5ndGgpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHJldHVybiBwcmVmYWJKc29uQ29udGFpbnNTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBhd2FpdCByZWFkRmlsZShwcmVmYWJEaXNrUGF0aChpbmZvLnVybCkpLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nLFxyXG4gICAgcm9vdEZpbGVJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGN1cnJlbnREaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgIGlmIChjdXJyZW50RGlydHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+W9k+WJjeaJk+W8gOeahOWcuuaZr+aIliBQcmVmYWIg5pyJ5pyq5L+d5a2Y5L+u5pS577yb5Li66YG/5YWN6Kem5Y+R5L+d5a2Y6K+i6Zeu77yM6K+35YWI5omL5bel5L+d5a2Y5oiW6L+Y5Y6f5ZCO5YaN5a+85YWl44CCJyk7XHJcbiAgICB9XHJcbiAgICBFZGl0b3IuU2VsZWN0aW9uLmNsZWFyKCdub2RlJyk7XHJcbiAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVmYWJVdWlkKTtcclxuICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ29wZW4tYXNzZXQnLCBwcmVmYWJVdWlkKTtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgbGV0IGxhc3RSZWFzb24gPSAnQ3JlYXRvciDlsJrmnKrov5Tlm54gUHJlZmFiIOe8lui+keeKtuaAgSc7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAzMF8wMDApIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICAgICAgICAgIGFyZ3M6IFt7IHByZWZhYlV1aWQsIHJvb3RGaWxlSWQgfV0sXHJcbiAgICAgICAgICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IHN0YXRlLnJlYXNvbiA/PyBsYXN0UmVhc29uO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDmiZPlvIDnm67moIcgUHJlZmFiIOi2heaXtu+8miR7bGFzdFJlYXNvbn1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYXNzZXJ0T3BlbmVkUHJlZmFiKHByZWZhYlV1aWQ6IHN0cmluZywgcm9vdEZpbGVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgIGFyZ3M6IFt7IHByZWZhYlV1aWQsIHJvb3RGaWxlSWQgfV0sXHJcbiAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICBpZiAoIXN0YXRlLnJlYWR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOe8lui+keS4iuS4i+aWh+W3suWPmOWMlu+8miR7c3RhdGUucmVhc29uID8/ICfmnKrnn6Xljp/lm6AnfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yU2NlbmVTYXZlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMTVfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgZGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICAgICAgaWYgKCFkaXJ0eSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcign562J5b6FIFByZWZhYiDkv53lrZjlrozmiJDotoXml7bjgIInKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UHJlZmFiQmluZGluZ3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcHJlZmFiVXVpZF0gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiBwcmVmYWJVdWlkICE9PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICB8fCAhcHJlZmFiVXVpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDnu5HlrprorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0W3NvdXJjZUhhc2hdID0gcHJlZmFiVXVpZDtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nLCBwcmVmYWJVdWlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGJpbmRpbmdzW3NvdXJjZUhhc2hdID0gcHJlZmFiVXVpZDtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGlmICghYmluZGluZ3Nbc291cmNlSGFzaF0pIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBkZWxldGUgYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBlbmRpbmdQcmVmYWJTeW5jcygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHtcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwZW5kaW5nUHJlZmFiU3luY1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCByYXddIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCAhcmF3XHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiByYXcgIT09ICdvYmplY3QnXHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiAocmF3IGFzIHsgcHJlZmFiVXVpZD86IHVua25vd24gfSkucHJlZmFiVXVpZCAhPT0gJ3N0cmluZycpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKHtcclxuICAgICAgICAgICAgdXNlckRhdGE6IHtcclxuICAgICAgICAgICAgICAgIGZpZ21hSW1wb3J0ZXI6IChyYXcgYXMgeyByZWNvcmQ/OiB1bmtub3duIH0pLnJlY29yZCxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoIXJlY29yZCB8fCByZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXmnaXmupDkuI3kuIDoh7TvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmVzdWx0W3NvdXJjZUhhc2hdID0ge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiAocmF3IGFzIHsgcHJlZmFiVXVpZDogc3RyaW5nIH0pLnByZWZhYlV1aWQsXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UGVuZGluZ1ByZWZhYlN5bmMoXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9IHwgbnVsbCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBwZW5kaW5nID0gYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk7XHJcbiAgICBpZiAodmFsdWUpIHtcclxuICAgICAgICBwZW5kaW5nW3NvdXJjZUhhc2hdID0gdmFsdWU7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBwZW5kaW5nW3NvdXJjZUhhc2hdO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwZW5kaW5nUHJlZmFiU3luY1YxJyxcclxuICAgICAgICBwZW5kaW5nLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHsgbWV0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiB7XHJcbiAgICBsZXQgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgbGV0IHJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgaWYgKCFyZWNvcmQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgIGBQcmVmYWIg57y65bCRIEZpZ21hIOadpea6kOiusOW9le+8jOaXoOazleehruiupOaYr+WQpuWPr+WuieWFqOimhueblu+8miR7aW5mby51cmx944CC6K+35YWI56e75Yqo5oiW6YeN5ZG95ZCN6K+l6LWE5rqQ44CCYCxcclxuICAgICAgICApO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5p2l6Ieq5Y+m5LiA5LiqIEZpZ21hIEZyYW1l77yM5bey5ouS57ud6KaG55uW77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgaWYgKHBlbmRpbmcpIHtcclxuICAgICAgICBpZiAocGVuZGluZy5wcmVmYWJVdWlkICE9PSBpbmZvLnV1aWQgfHwgcGVuZGluZy5yZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ajgOa1i+WIsOS4juebruaghyBQcmVmYWIg5LiN5LiA6Ie055qE5b6F5oGi5aSN5ZCM5q2l6K6w5b2V77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGluZm8sIHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHBlbmRpbmcucmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgICAgICAgICBpZiAoIXJlY292ZXJlZCB8fCBKU09OLnN0cmluZ2lmeShyZWNvdmVyZWQpICE9PSBKU09OLnN0cmluZ2lmeShwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeiusOW9leiHquWKqOaBouWkjeWksei0peOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlY29yZCA9IHJlY292ZXJlZDtcclxuICAgICAgICB9IGVsc2UgaWYgKCFhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGluZm8sIHJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25LiO5b2T5YmN5Y+K5b6F5oGi5aSN55qE5ZCM5q2l6K6w5b2V6YO95LiN5LiA6Ie077yM5bey5YGc5q2i6Ieq5Yqo5oGi5aSN44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgbWV0YSwgcmVjb3JkIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdyaXRlVmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgbGV0IGxhc3RFcnJvcjogdW5rbm93bjtcclxuICAgIGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDwgMzsgYXR0ZW1wdCArPSAxKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKG1ldGEpO1xyXG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nIHx8IGV4aXN0aW5nLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5YaZ5YWl5YmNIFByZWZhYiDmnaXmupDorrDlvZXkuI3kuIDoh7TjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3Qgc2F2ZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKSk7XHJcbiAgICAgICAgICAgIGlmICghc2F2ZWQgfHwgSlNPTi5zdHJpbmdpZnkoc2F2ZWQpICE9PSBKU09OLnN0cmluZ2lmeShyZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlhpnlhaXlkI7moKHpqozkuI3kuIDoh7TjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdEVycm9yID0gZXJyb3I7XHJcbiAgICAgICAgICAgIGlmIChhdHRlbXB0IDwgMikge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDE1MCkpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgdGhyb3cgbGFzdEVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBsYXN0RXJyb3IgOiBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlhpnlhaXlpLHotKXjgIInKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmcsXHJcbiAgICByb290RnJhbWU6IFJlY3QsXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbiAgICBzb3VyY2VSb290SWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7XHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm87XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+IHtcclxuICAgIGNvbnN0IGJpbmRpbmdzID0gYXdhaXQgZ2V0UHJlZmFiQmluZGluZ3MoKTtcclxuICAgIGNvbnN0IGJvdW5kVXVpZCA9IGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nSW5mbyA9IHBlbmRpbmdcclxuICAgICAgICA/IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocGVuZGluZy5wcmVmYWJVdWlkKVxyXG4gICAgICAgIDogbnVsbDtcclxuICAgIGNvbnN0IHRhcmdldFBsYW4gPSBwbGFuUHJlZmFiUmVjb3ZlcnlUYXJnZXQoXHJcbiAgICAgICAgcGVuZGluZz8ucHJlZmFiVXVpZCxcclxuICAgICAgICBib3VuZFV1aWQsXHJcbiAgICAgICAgQm9vbGVhbihwZW5kaW5nSW5mbyksXHJcbiAgICApO1xyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJQZW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhckJpbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGFyZ2V0VXVpZCA9IHRhcmdldFBsYW4udGFyZ2V0VXVpZDtcclxuICAgIGlmICh0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgbGV0IHRhcmdldEluZm8gPSBwZW5kaW5nSW5mbz8udXVpZCA9PT0gdGFyZ2V0VXVpZFxyXG4gICAgICAgICAgICA/IHBlbmRpbmdJbmZvXHJcbiAgICAgICAgICAgIDogYXdhaXQgcXVlcnlQcmVmYWJBc3NldCh0YXJnZXRVdWlkKTtcclxuICAgICAgICBpZiAoIXRhcmdldEluZm8pIHtcclxuICAgICAgICAgICAgaWYgKGJpbmRpbmdzW3NvdXJjZUhhc2hdID09PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldCh0YXJnZXRJbmZvLnVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgIGlmIChwZW5kaW5nPy5wcmVmYWJVdWlkID09PSB0YXJnZXRVdWlkICYmIGJvdW5kVXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgLy8gUGVyc2lzdCB0aGUgcmVjb3ZlcnkgaWRlbnRpdHkgYmVmb3JlIHZlcmlmaWVkUHJlZmFiUmVjb3JkIG1heVxyXG4gICAgICAgICAgICAgICAgLy8gY29tbWl0IGFuZCBjbGVhciBwZW5kaW5nLiBBIGxhdGVyIG1vdmUgZmFpbHVyZSBtdXN0IHN0aWxsIGJlXHJcbiAgICAgICAgICAgICAgICAvLyBhYmxlIHRvIGxvY2F0ZSB0aGUgZXhhY3QgUHJlZmFiIGJ5IFVVSUQgb24gdGhlIG5leHQgYXR0ZW1wdC5cclxuICAgICAgICAgICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZCh0YXJnZXRJbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgaWYgKHRhcmdldEluZm8udXJsICE9PSBwcmVmYWJVcmwpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbmZsaWN0ID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVmYWJVcmwpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvbmZsaWN0ICYmIGNvbmZsaWN0LnV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGBGaWdtYSBGcmFtZSDlr7nlupTnmoQgUHJlZmFiIOmcgOimgeenu+WKqOWIsCAke3ByZWZhYlVybH3vvIzkvYbnm67moIfot6/lvoTlt7Looqvlhbbku5botYTmupDljaDnlKjjgIJgLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoIWNvbmZsaWN0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbW92ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAnbW92ZS1hc3NldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8udXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICAgICAgICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoIW1vdmVkIHx8IG1vdmVkLnV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XlnKjkv53nlZkgVVVJRCDnmoTliY3mj5DkuIvnp7vliqggUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBpbmZvOiB0YXJnZXRJbmZvLFxyXG4gICAgICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGxldCBpbmZvID0gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwcmVmYWJVcmwpO1xyXG4gICAgaWYgKCFpbmZvKSB7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZpbGVJZCA9IGNvY29zRmlsZUlkKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdFRyYW5zZm9ybUZpbGVJZCA9IGNvY29zRmlsZUlkKCk7XHJcbiAgICAgICAgY29uc3Qgc2VlZCA9IGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uKFxyXG4gICAgICAgICAgICBwcmVmYWJOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBjcmVhdGVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgJ2NyZWF0ZS1hc3NldCcsXHJcbiAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgc2VlZCxcclxuICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgIGlmICghY3JlYXRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWIm+W7uiBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGNyZWF0ZWQudXVpZCk7XHJcbiAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IHJlY29yZCA9IGNyZWF0ZVByZWZhYlN5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIHNvdXJjZUhhc2gsXHJcbiAgICAgICAgICAgIHNvdXJjZVJvb3RJZCxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IG5leHRNZXRhID0gbWVyZ2VQcmVmYWJTeW5jUmVjb3JkKG1ldGEsIHJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkobmV4dE1ldGEsIG51bGwsIDIpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQoaW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGluZm8sXHJcbiAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQoaW5mbywgc291cmNlSGFzaCk7XHJcbiAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGluZm8sXHJcbiAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRMaW5rZWRGcmFtZVByZWZhYihhcmdzOiB7XHJcbiAgICByZXZpZXdJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBzb3VyY2VOb2RlSWQ6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59KTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3Qgc291cmNlSGFzaCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKGFyZ3MuZmlsZUtleSwgYXJncy5zb3VyY2VOb2RlSWQpO1xyXG4gICAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICAgICAgYXJncy5wcmVmYWJVcmwsXHJcbiAgICAgICAgYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgeDogYXJncy5yb290RnJhbWUueCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHk6IGFyZ3Mucm9vdEZyYW1lLnkgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB3aWR0aDogYXJncy5yb290RnJhbWUud2lkdGggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICBoZWlnaHQ6IGFyZ3Mucm9vdEZyYW1lLmhlaWdodCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgIGFyZ3Mucm9vdHNbMF0uZmlnbWFJZCxcclxuICAgICk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICk7XHJcbiAgICBjb25zdCBleGlzdGluZ05vZGVGaWxlSWRzID0gcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMoXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLFxyXG4gICAgICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyhhcmdzLnJvb3RzKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgcmV2aWV3SWQ6IGFyZ3MucmV2aWV3SWQsXHJcbiAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgZmlsZUtleTogYXJncy5maWxlS2V5LFxyXG4gICAgICAgIHJvb3ROYW1lOiBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAgcm9vdEZyYW1lOiBhcmdzLnJvb3RGcmFtZSxcclxuICAgICAgICBzY2FsZTogYXJncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICBleGlzdGluZ01hcDoge30sXHJcbiAgICAgICAgcHJlZmFiVXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICByb290czogYXJncy5yb290cyxcclxuICAgICAgICBwcmVmYWJDb250ZXh0OiB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZDogcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkSGVscGVyRmlsZUlkcyxcclxuICAgICAgICB9LFxyXG4gICAgfTtcclxuICAgIGxldCBzbmFwc2hvdFN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIGxldCBzYXZlQXR0ZW1wdGVkID0gZmFsc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5QmVmb3JlSW1wb3J0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmIChkaXJ0eUJlZm9yZUltcG9ydCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ebruaghyBQcmVmYWIg5pyJ5pyq5L+d5a2Y55qE5omL5bel5L+u5pS577yM6K+35YWI5L+d5a2Y5ZCO5YaN5omn6KGMIEZpZ21hIOWinumHj+WvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIHNuYXBzaG90U3RhcnRlZCA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGlmICghcmVzdWx0LnByZWZhYlN5bmMpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5pyq6L+U5ZueIGZpbGVJZCDorrDlvZXvvIzlt7LlgZzmraLkv53lrZjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmV4dFJlY29yZCA9IHJlY29yZFByZWZhYlN5bmNDYXB0dXJlKHByZXBhcmVkLnJlY29yZCwgcmVzdWx0LnByZWZhYlN5bmMpO1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICByZWNvcmQ6IG5leHRSZWNvcmQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgYXdhaXQgYXNzZXJ0T3BlbmVkUHJlZmFiKHByZXBhcmVkLmluZm8udXVpZCwgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQpO1xyXG4gICAgICAgIC8vIE9uY2UgdGhlIHNhdmUgcmVxdWVzdCBpcyBzZW50IGl0cyByZXN1bHQgaXMgYW1iaWd1b3VzIHVudGlsIHRoZVxyXG4gICAgICAgIC8vIHBlcnNpc3RlZCBQcmVmYWIgaXMgdmVyaWZpZWQuIERvIG5vdCByb2xsIHRoZSBpbi1tZW1vcnkgUHJlZmFiIGJhY2tcclxuICAgICAgICAvLyBvbiBhbiBJUEMgdGltZW91dDogdGhlIGRpc2sgd3JpdGUgbWF5IGFscmVhZHkgaGF2ZSBjb21wbGV0ZWQuXHJcbiAgICAgICAgc2F2ZUF0dGVtcHRlZCA9IHRydWU7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JTY2VuZVNhdmVkKCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgaWYgKCFhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGN1cnJlbnRJbmZvLCBuZXh0UmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bmnKrljIXlkKvmnKzmrKHlkIzmraXnlJ/miJDnmoTlhajpg6ggZmlsZUlk77yM5bey5YGc5q2i5pu05pawIE1ldGHjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY3VycmVudE1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoY3VycmVudEluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudFJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGN1cnJlbnRNZXRhKTtcclxuICAgICAgICBpZiAoIWN1cnJlbnRSZWNvcmQgfHwgY3VycmVudFJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWcqOS/neWtmOacn+mXtOWPkeeUn+WPmOWMlu+8jOW3suaLkue7neaPkOS6pOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKGN1cnJlbnRJbmZvLCBzb3VyY2VIYXNoLCBuZXh0UmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwpO1xyXG4gICAgICAgIGlmICghdmVyaWZpZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI4gUHJlZmFiIFVVSUQg5qCh6aqM5aSx6LSl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFzc2VydFByZWZhYkFzc2V0KHZlcmlmaWVkLCB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgdXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXN1bHQucHJlZmFiVXJsID0gcHJlcGFyZWQuaW5mby51cmw7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHNuYXBzaG90U3RhcnRlZCAmJiAhc2F2ZUF0dGVtcHRlZCkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdC1hYm9ydCcpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtSW1wb3J0KHJlcXVlc3Q6IEltcG9ydFJlcXVlc3QsIG9wZXJhdGlvbk93bmVyOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IGRvY3VtZW50ID0gYWN0aXZlRG9jdW1lbnQ7XHJcbiAgICBpZiAoIWRvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbXBvcnRTZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbihvcGVyYXRpb25Pd25lcik7XHJcbiAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydCgn5a+85YWl5Lu75YqhJywgeyByb290czogZG9jdW1lbnQucm9vdHMubWFwKChub2RlKSA9PiAoeyBpZDogbm9kZS5pZCwgbmFtZTogbm9kZS5uYW1lIH0pKSB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5YiG5p6Q5bm25YeG5aSH6LWE5rqQ4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChyZXF1ZXN0Lm92ZXJyaWRlcywgZG9jdW1lbnQudHJlZSk7XG4gICAgICAgIGNvbnN0IHJldmlld0RvY3VtZW50ID0gZG9jdW1lbnQ7XG4gICAgICAgIGltcG9ydFJldmlld3MuaW52YWxpZGF0ZSgpO1xuICAgICAgICBjb25zdCByZXZpZXdSZWNvcmRlciA9IG5ldyBJbXBvcnRSZXZpZXdSZWNvcmRlcigpO1xuICAgICAgICBjb25zdCBidWlsdEFzc2V0cyA9IGF3YWl0IGRpYWdub3N0aWNUYXNrKCflh4blpIflhajpg6jotYTmupAnLCB1bmRlZmluZWQsICgpID0+IGJ1aWxkQXNzZXRzKGRvY3VtZW50LCBkZWNpc2lvbnMsIGltcG9ydFNldHRpbmdzLCByZXZpZXdSZWNvcmRlcikpO1xuICAgICAgICBjb25zdCB7IGFzc2V0cywgd2FybmluZ3MgfSA9IGJ1aWx0QXNzZXRzO1xyXG4gICAgICAgIGNvbnN0IGF0dGFjaFJldmlldyA9IGFzeW5jIChyZXN1bHQ6IFNjZW5lSW1wb3J0UmVzdWx0KSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChyZXN1bHQucmV2aWV3QmVmb3JlICYmIHJlc3VsdC5yZXZpZXdBZnRlcikge1xyXG4gICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICByZXN1bHQucmV2aWV3QWZ0ZXIgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSwgbWV0aG9kOiAncmVmcmVzaFJldmlld0FmdGVyJywgYXJnczogW3sgaWQ6IHJldmlld1JlY29yZGVyLmlkIH1dLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pIGFzIFJldmlld1NjZW5lO1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdC5yZXZpZXcgPSBhd2FpdCBpbXBvcnRSZXZpZXdzLmNvbXBsZXRlKHJldmlld1JlY29yZGVyLCByZXZpZXdEb2N1bWVudCxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc3VsdC5yZXZpZXdCZWZvcmUsIHJlc3VsdC5yZXZpZXdBZnRlciwgcmVzdWx0LnByZWZhYlVybCwgd2FybmluZ3MpO1xuICAgICAgICAgICAgICAgICAgICBpZiAob3BlcmF0aW9uT3duZXIpIEVkaXRvci5NZXNzYWdlLnNlbmQocGFja2FnZUpTT04ubmFtZSwgJ2ltcG9ydC1yZXZpZXctcmVhZHknLCByZXN1bHQucmV2aWV3KTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYOWvvOWFpeW3suWujOaIkO+8jOS9hue7k+aenOajgOafpeeUn+aIkOWksei0pe+8miR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQucmV2aWV3QmVmb3JlO1xyXG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0LnJldmlld0FmdGVyO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgLy8gYnVpbGRBc3NldHMgbWF5IHByb21vdGUgYSBjb250YWluZXIgdG8gYSBsb2NhbCBzYW1lLW5hbWUgcmVzb3VyY2UuXHJcbiAgICAgICAgLy8gQ29tcGlsZSBhZnRlciB0aGF0IHByb21vdGlvbiBzbyBhc3NldHMgYW5kIFNjZW5lTm9kZVNwZWMgc2hhcmUgdGhlXHJcbiAgICAgICAgLy8gZXhhY3Qgc2FtZSBmaW5hbCBwbGFuLlxyXG4gICAgICAgIGNvbnN0IHBsYW5zID0gY29tcGlsZUltcG9ydFBsYW4oZG9jdW1lbnQucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgY29uc3QgZm9udHMgPSBhd2FpdCByZXNvbHZlRm9udHMoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZVJvb3RGcmFtZXMgPSBkb2N1bWVudC5yb290cy5tYXAobm9kZUZyYW1lKTtcclxuICAgICAgICBjb25zdCBtdWx0aXBsZVJvb3RzID0gZG9jdW1lbnQucm9vdHMubGVuZ3RoID4gMTtcclxuICAgICAgICBjb25zdCBhcnJhbmdlZFdpZHRoID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHNvdXJjZVJvb3RGcmFtZXMucmVkdWNlKCh0b3RhbCwgZnJhbWUpID0+IHRvdGFsICsgZnJhbWUud2lkdGgsIDApXHJcbiAgICAgICAgICAgICAgICArIE1hdGgubWF4KDAsIHNvdXJjZVJvb3RGcmFtZXMubGVuZ3RoIC0gMSkgKiAxNjBcclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdPy53aWR0aCA/PyAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RGcmFtZSA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyB7XHJcbiAgICAgICAgICAgICAgICB4OiAwLFxyXG4gICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgIHdpZHRoOiBhcnJhbmdlZFdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBNYXRoLm1heCgwLCAuLi5zb3VyY2VSb290RnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLmhlaWdodCkpLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXSA/PyB7IHg6IDAsIHk6IDAsIHdpZHRoOiAwLCBoZWlnaHQ6IDAgfTtcclxuICAgICAgICBsZXQgcm9vdEN1cnNvciA9IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdHMgPSBkb2N1bWVudC5yb290c1xyXG4gICAgICAgICAgICAubWFwKChub2RlLCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgc3BlYyA9IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5ub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5mcmFtZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogcm9vdEN1cnNvcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDdXJzb3IgKz0gc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGggKyAxNjA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigobm9kZSk6IG5vZGUgaXMgU2NlbmVOb2RlU3BlYyA9PiBub2RlICE9PSBudWxsKTtcclxuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeaciemAieS4reS7u+S9leWPr+WvvOWFpeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgc291cmNlTm9kZUlkID0gZG9jdW1lbnQuc291cmNlTm9kZUlkO1xyXG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVmYWJXcml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5yb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMC4wNSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKHtcclxuICAgICAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgIHByZWZhYk5hbWU6IGZyYW1lTmFtZSxcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VOb2RlSWQsXHJcbiAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICAgICAgLy8gUHJlZmFiIHVwZGF0ZXMgcGVyc2lzdCBieSBQcmVmYWJJbmZvLmZpbGVJZCBpbiB0aGUgYXNzZXQgbWV0YTtcclxuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBub2RlTWFwc1tkb2N1bWVudC5maWxlS2V5XTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICAgICAgYXdhaXQgYXR0YWNoUmV2aWV3KHJlc3VsdCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbmFsUmVzdWx0ID0gd2FybmluZ3MubGVuZ3RoID8geyAuLi5yZXN1bHQsIHdhcm5pbmdzIH0gOiByZXN1bHQ7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxyXG4gICAgICAgICAgICAgICAgdmFsdWU6IDEsXHJcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR977yM5bey5omT5byA6aKE5Yi25L2TICR7cHJlZmFiVXJsfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDkuKrkuIkv5Lmd5a6r5bey6ZmN57qn5Li6IFBORyDmlbTlsYJgIDogJyd9YCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgICAgIHJldmlld0lkOiByZXZpZXdSZWNvcmRlci5pZCxcclxuICAgICAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIHJvb3ROYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbXBvcnRTZXR0aW5ncy51cGRhdGVFeGlzdGluZyxcclxuICAgICAgICAgICAgZXhpc3RpbmdNYXA6IG5vZGVNYXBzW2RvY3VtZW50LmZpbGVLZXldID8/IHt9LFxyXG4gICAgICAgICAgICByb290cyxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMC4xLCBtZXNzYWdlOiAn5q2j5Zyo5p6E5bu6IENvY29zIOiKgueCueagkeKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgbm9kZU1hcHNbZG9jdW1lbnQuZmlsZUtleV0gPSByZXN1bHQubm9kZU1hcDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdub2RlJywgcmVzdWx0LnJvb3RVdWlkKTtcclxuICAgICAgICBpZiAoaW1wb3J0U2V0dGluZ3MuYXV0b1NhdmUpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBhdHRhY2hSZXZpZXcocmVzdWx0KTtcclxuICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOS4quS4iS/kuZ3lrqvlt7LpmY3nuqfkuLogUE5HIOaVtOWxgmAgOiAnJ31gLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRyYWNlLmRvbmUoKTtcclxuICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHRyYWNlLmZhaWwoZXJyb3IpO1xyXG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdjYW5jZWxsZWQnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+W3suWPlua2iOOAgicgfSk7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5pON5L2c5bey5Y+W5raI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5a+85YWl5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIHRyYWNlLmV2ZW50KCflkI7lj7Dku7vliqHlt7Lph4rmlL4nKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TWNwUGx1Z2luU3RhdGUoKSB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICB2ZXJzaW9uOiBwYWNrYWdlSlNPTi52ZXJzaW9uLFxyXG4gICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcclxuICAgICAgICBzZXR0aW5nczogYXdhaXQgZ2V0U2V0dGluZ3MoKSxcclxuICAgICAgICBkb2N1bWVudDogZG9jdW1lbnQgPyB7XHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIHRyZWU6IGRvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgbm9kZU92ZXJyaWRlczogYXdhaXQgbm9kZU92ZXJyaWRlc0Zvcihkb2N1bWVudC5maWxlS2V5KSxcclxuICAgICAgICB9IDogbnVsbCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBsdWdpblN0YXRlKCkge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICAuLi5hd2FpdCBnZXRNY3BQbHVnaW5TdGF0ZSgpLFxyXG4gICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBmZXRjaEZpZ21hRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMTUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5YgRmlnbWEg5paH5Lu24oCmJyB9KTtcclxuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKTtcclxuICAgICAgICBjb25zdCBwYXlsb2FkID0gcGFyc2VkLm5vZGVJZFxyXG4gICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxyXG4gICAgICAgICAgICA6IGF3YWl0IGFwaS5nZXRGaWxlKHBhcnNlZC5maWxlS2V5KTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKFxyXG4gICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xyXG4gICAgICAgIGNvbnN0IGZvbnRBc3NldHMgPSBhd2FpdCBsaXN0Rm9udEFzc2V0cygpO1xyXG4gICAgICAgIGNvbnN0IG5vZGVPdmVycmlkZXMgPSBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGRvY3VtZW50LmZpbGVLZXkpO1xyXG4gICAgICAgIGFjdGl2ZURvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICAgICAgZG9jdW1lbnRSZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnaWRsZScsIHZhbHVlOiAxLCBtZXNzYWdlOiBg5bey6K+75Y+WICR7ZG9jdW1lbnQuZmlsZU5hbWV9YCB9KTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgdHJlZTogZG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICBmb250QXNzZXRzLFxyXG4gICAgICAgICAgICBub2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIH07XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZXJyb3InLFxyXG4gICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXROb2RlUHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PiB7XHJcbiAgICBjb25zdCBkb2N1bWVudCA9IGFjdGl2ZURvY3VtZW50O1xyXG4gICAgY29uc3Qgbm9kZSA9IGRvY3VtZW50Py5ub2RlQnlJZC5nZXQobm9kZUlkKTtcclxuICAgIGlmICghZG9jdW1lbnQgfHwgIW5vZGUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgY29udHJvbGxlciA9IGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KGNvbnRyb2xsZXIuc2lnbmFsKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgIDEsXHJcbiAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgaWYgKCF1cmxzW25vZGVJZF0pIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGVJZF0gfTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgZ2V0SW1wb3J0UmV2aWV3KCkgeyByZXR1cm4gaW1wb3J0UmV2aWV3cy5nZXQoKTsgfSxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1ByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nKSB7IHJldHVybiBpbXBvcnRSZXZpZXdzLnByZXZpZXcoaWQsIGFzc2V0SWQpOyB9LFxyXG4gICAgYXN5bmMgYXBwbHlJbXBvcnRSZXZpZXcoaWQ6IHN0cmluZywgcmVtb3ZlZElkczogdW5rbm93bikge1xuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcikgdGhyb3cgbmV3IEVycm9yKCfor7fnrYnlvoXlvZPliY3lr7zlhaXmiJYgRmlnbWEg6aKE6KeI5a6M5oiQ44CCJyk7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xuICAgICAgICBhcHBseWluZ0ltcG9ydFJldmlldyA9IHRydWU7XG4gICAgICAgIHRyeSB7IHJldHVybiBhd2FpdCBpbXBvcnRSZXZpZXdzLmFwcGx5KGlkLCByZW1vdmVkSWRzKTsgfVxuICAgICAgICBmaW5hbGx5IHsgYXBwbHlpbmdJbXBvcnRSZXZpZXcgPSBmYWxzZTsgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpOyB9XG4gICAgfSxcclxuICAgIGFzeW5jIGdldEltcG9ydFJldmlld1NvdXJjZVByZXZpZXcoaWQ6IHN0cmluZywgYXNzZXRJZDogc3RyaW5nLCBub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyKSB0aHJvdyBuZXcgRXJyb3IoJ+ivt+etieW+heW9k+WJjeaTjeS9nOWujOaIkOWQjuWGjeWKoOi9veadpea6kOmihOiniOOAgicpO1xyXG4gICAgICAgIGNvbnN0IHsgZmlsZUtleSwgbm9kZSB9ID0gaW1wb3J0UmV2aWV3cy5zb3VyY2UoaWQsIGFzc2V0SWQsIG5vZGVJZCk7XG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBhcGkgPSBhd2FpdCBjbGllbnQoKTtcclxuICAgICAgICAgICAgY29uc3QgaW1hZ2VSZWYgPSBwbGFpbkltYWdlU291cmNlUmVmKG5vZGUpO1xyXG4gICAgICAgICAgICBpZiAoaW1hZ2VSZWYpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGZpbGxzID0gYXdhaXQgYXBpLmdldEltYWdlRmlsbFVybHMoZmlsZUtleSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoZmlsbHNbaW1hZ2VSZWZdKSByZXR1cm4geyB1cmw6IGZpbGxzW2ltYWdlUmVmXSwgbm90ZTogJ0ZpZ21hIOWOn+Wbvu+8iOacquWQiOaIkOiKgueCueaViOaenO+8iScgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgYXBpLmdldEltYWdlVXJscyhmaWxlS2V5LCBbbm9kZS5pZF0sICdwbmcnLCAxLCAhb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlKSk7XHJcbiAgICAgICAgICAgIGlmICghdXJsc1tub2RlLmlkXSkgdGhyb3cgbmV3IEVycm9yKCdGaWdtYSDmnKrov5Tlm57pooTop4jvvIzpmpDol4/miJblpI3mnYLmlYjmnpzoioLngrnlj6/og73ml6Dms5XljZXni6zmuLLmn5PjgIInKTtcclxuICAgICAgICAgICAgcmV0dXJuIHsgdXJsOiB1cmxzW25vZGUuaWRdLCBub3RlOiAnRmlnbWEg5b2T5YmN6IqC54K55riy5p+T77yI6ZqQ6JeP56WW5YWI5Y+v6IO95L2/6aKE6KeI6YCP5piO77yJJyB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7IGZpbmlzaE9wZXJhdGlvbihjb250cm9sbGVyKTsgfVxuICAgIH0sXHJcbiAgICBvcGVuUGFuZWwoKSB7XHJcbiAgICAgICAgRWRpdG9yLlBhbmVsLm9wZW4ocGFja2FnZUpTT04ubmFtZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFN0YXRlKCkge1xyXG4gICAgICAgIHJldHVybiBnZXRQbHVnaW5TdGF0ZSgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzZXRUb2tlbih2YWx1ZTogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LnNldCh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGNsZWFyVG9rZW4oKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LmNsZWFyKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHZlcmlmeVRva2VuKCkge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGlkZW50aXR5ID0gYXdhaXQgKGF3YWl0IGNsaWVudChjb250cm9sbGVyLnNpZ25hbCkpLnZlcmlmeSgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBoYW5kbGU6IGlkZW50aXR5LmhhbmRsZSB8fCAnRmlnbWEgVXNlcicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVTZXR0aW5ncyh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXk6IHVua25vd24sIG92ZXJyaWRlczogdW5rbm93biwgc2NvcGVJZHM6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleSwgb3ZlcnJpZGVzLCBzY29wZUlkcyk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tBc3NldEZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja1ByZWZhYkZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tDYWNoZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBmZXRjaERvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGZldGNoRmlnbWFEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRQcmV2aWV3KG5vZGVJZDogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIGdldE5vZGVQcmV2aWV3KG5vZGVJZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcERldGVjdChzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5kZXRlY3Qoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUHJldmlldyhzb3VyY2VVcmw6IHN0cmluZywgZXhwbGljaXRSb290SWQ/OiBzdHJpbmcpIHtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wcmV2aWV3KHNvdXJjZVVybCwgZXhwbGljaXRSb290SWQpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHJvdW5kdHJpcFBhaXIocGFpclRva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5wYWlyKHBhaXJUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwQXBwbHkocHJldmlld1Rva2VuOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKSB0aHJvdyBuZXcgRXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgICAgICBjb25zdCBjb250cm9sbGVyID0gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgKGF3YWl0IHJvdW5kdHJpcFNlcnZpY2UoY29udHJvbGxlci5zaWduYWwpKS5hcHBseShwcmV2aWV3VG9rZW4pO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaFJvdW5kdHJpcE9wZXJhdGlvbihjb250cm9sbGVyKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHJvdW5kdHJpcENhbmNlbCgpIHtcclxuICAgICAgICByb3VuZHRyaXBDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCkge1xyXG4gICAgICAgIHJldHVybiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QpO1xyXG4gICAgfSxcclxuXHJcbiAgICBjYW5jZWxJbXBvcnQoKSB7XHJcbiAgICAgICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydE1jcEJyaWRnZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHByZXZpb3VzID0gbWNwQnJpZGdlO1xyXG4gICAgbWNwQnJpZGdlID0gbnVsbDtcclxuICAgIG1jcEFwaSA9IG51bGw7XHJcbiAgICBpZiAocHJldmlvdXMpIGF3YWl0IHByZXZpb3VzLmNsb3NlKCk7XHJcblxyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIGNvbnN0IGFwaSA9IG5ldyBGaWdtYUltcG9ydGVyTWNwQXBpKHtcclxuICAgICAgICBwcm9qZWN0UGF0aDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgICAgICBnZXREb2N1bWVudFJldmlzaW9uOiAoKSA9PiBkb2N1bWVudFJldmlzaW9uLFxyXG4gICAgICAgIGlzSW1wb3J0QnVzeTogKCkgPT4gYWN0aXZlQ29udHJvbGxlciAhPT0gbnVsbCxcclxuICAgICAgICBnZXRTdGF0ZTogZ2V0TWNwUGx1Z2luU3RhdGUsXHJcbiAgICAgICAgZmV0Y2hEb2N1bWVudDogZmV0Y2hGaWdtYURvY3VtZW50LFxyXG4gICAgICAgIGdldFByZXZpZXc6IGdldE5vZGVQcmV2aWV3LFxyXG4gICAgICAgIHNhdmVTZXR0aW5ncyxcclxuICAgICAgICBwYXRjaFNldHRpbmdzLFxyXG4gICAgICAgIHNhdmVOb2RlT3ZlcnJpZGVzLFxyXG4gICAgICAgIHBhdGNoTm9kZU5hbWVzLFxyXG4gICAgICAgIGltcG9ydFNlbGVjdGlvbjogKHJlcXVlc3QsIG9wZXJhdGlvbklkKSA9PiBwZXJmb3JtSW1wb3J0KHJlcXVlc3QsIG9wZXJhdGlvbklkKSxcclxuICAgICAgICBjYW5jZWxJbXBvcnQ6IChvcGVyYXRpb25JZCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIWFjdGl2ZUNvbnRyb2xsZXIgfHwgYWN0aXZlT3BlcmF0aW9uT3duZXIgIT09IG9wZXJhdGlvbklkKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGFjdGl2ZUNvbnRyb2xsZXIuYWJvcnQoKTtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgY29uc3QgYnJpZGdlID0gbmV3IE1jcEJyaWRnZVNlcnZlcih7XHJcbiAgICAgICAgcHJvamVjdFBhdGg6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgcGx1Z2luVmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICBwbHVnaW5JbnN0YW5jZUlkLFxyXG4gICAgICAgIGludm9rZTogKG1ldGhvZCwgcGFyYW1zLCBzaWduYWwpID0+IGFwaS5pbnZva2UobWV0aG9kLCBwYXJhbXMsIHNpZ25hbCksXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLnN0YXJ0KCk7XHJcbiAgICAgICAgbWNwQXBpID0gYXBpO1xyXG4gICAgICAgIG1jcEJyaWRnZSA9IGJyaWRnZTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYXdhaXQgYnJpZGdlLmNsb3NlKCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zb2xlLmVycm9yKGBGaWdtYSBJbXBvcnRlciBNQ1AgQnJpZGdlIOWQr+WKqOWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyhFZGl0b3IuUHJvamVjdC5wYXRoLCBlZGl0b3JSZWltcG9ydGVyKTtcclxuICAgICAgICBjb25zdCBhY3RpdmUgPSByZWNvdmVyZWQuZmlsdGVyKChyZXN1bHQpID0+IHJlc3VsdC5zdGF0dXMgPT09ICdhY3RpdmUtb3duZXInKTtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBhY3RpdmUubGVuZ3RoXHJcbiAgICAgICAgICAgID8gYOajgOa1i+WIsCAke2FjdGl2ZS5sZW5ndGh9IOS4quS7jeeUsea0u+WKqOi/m+eoi+aMgeacieeahCBSb3VuZC10cmlwIOS6i+WKoe+8jOaaguaXtuemgeatoiBQYWlyL0FwcGx544CCYFxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlciA9IGBSb3VuZC10cmlwIOWQr+WKqOaBouWkjeWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5pyq55+l6ZSZ6K+vJ31gO1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3Iocm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyKTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0YXJ0TWNwQnJpZGdlKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVPcGVyYXRpb25Pd25lciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbiAgICBkb2N1bWVudFJldmlzaW9uICs9IDE7XHJcbiAgICBjb25zdCBicmlkZ2UgPSBtY3BCcmlkZ2U7XHJcbiAgICBtY3BCcmlkZ2UgPSBudWxsO1xyXG4gICAgbWNwQXBpID0gbnVsbDtcclxuICAgIHZvaWQgYnJpZGdlPy5jbG9zZSgpLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoYEZpZ21hIEltcG9ydGVyIE1DUCBCcmlkZ2Ug5YWz6Zet5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfmnKrnn6XplJnor68nfWApO1xyXG4gICAgfSk7XHJcbn1cclxuIl19