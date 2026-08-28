"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.overflowingRenderFrame = overflowingRenderFrame;
exports.decisionMap = decisionMap;
exports.subtreeHasExplicitOverride = subtreeHasExplicitOverride;
exports.makeSpec = makeSpec;
exports.load = load;
exports.unload = unload;
const path_1 = require("path");
const fs_1 = require("fs");
const crypto_1 = require("crypto");
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
const prefab_sync_1 = require("./importer/prefab-sync");
const token_vault_1 = require("./security/token-vault");
const service_1 = require("./roundtrip/service");
const recovery_1 = require("./roundtrip/recovery");
const transaction_1 = require("./roundtrip/transaction");
const types_1 = require("./types");
const node_name_1 = require("./node-name");
const vault = new token_vault_1.TokenVault(package_json_1.default.name);
let activeDocument = null;
let activeController = null;
let roundtripController = null;
let settingsCache = null;
let roundtripRecoveryBlocker = null;
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
async function getSettings() {
    if (settingsCache) {
        return settingsCache;
    }
    const saved = await Editor.Profile.getProject(package_json_1.default.name, 'settings', 'project');
    settingsCache = safeSettings(saved);
    return settingsCache;
}
async function saveSettings(value) {
    settingsCache = safeSettings(value);
    await Editor.Profile.setProject(package_json_1.default.name, 'settings', settingsCache, 'project');
    return settingsCache;
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
function beginOperation() {
    activeController === null || activeController === void 0 ? void 0 : activeController.abort();
    activeController = new AbortController();
}
function finishOperation() {
    activeController = null;
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
async function saveNodeOverrides(fileKey, values, scopeValues) {
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
async function buildAssets(session, decisions, importSettings) {
    var _a;
    const writer = new assets_1.AssetWriter(importSettings.assetFolder);
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
        apiPromise !== null && apiPromise !== void 0 ? apiPromise : (apiPromise = client());
        return apiPromise;
    };
    const completeAsset = (node, asset, source = 'figma') => {
        assets.set(node.id, asset);
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
        const download = (url) => {
            let task = downloads.get(url);
            if (!task) {
                task = getApi().then((api) => api.download(url));
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
                contents = await download(remoteUrl);
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
                ? (0, slicing_1.analyzeSliceGrid)(node, importSettings.scale)
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
            Object.assign(urls, await (await getApi()).getImageUrls(session.fileKey, batch.map((item) => item.node.id), format, importSettings.scale, useAbsoluteBounds));
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
                contents = await (await getApi()).download(remoteUrl);
                await cache.write(item.key, contents);
            }
            const asset = await writer.write(item.url, contents, item.borders);
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
                    task = getApi().then((api) => api.download(remoteUrl));
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
    await processTiled(requests.tiled);
    await processRemote(requests.png);
    // Run after whole-node renders so a correct visibility-independent source
    // image wins if both paths share the same legacy asset filename.
    await processRawImages(requests.rawImages);
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
async function performImport(request) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!activeDocument) {
        throw new Error('请先读取 Figma 文件。');
    }
    const importSettings = safeSettings(request.settings);
    await saveSettings(importSettings);
    beginOperation();
    try {
        emitProgress({ phase: 'assets', value: 0, message: '分析并准备资源…' });
        const decisions = decisionMap(request.overrides, activeDocument.tree);
        const builtAssets = await buildAssets(activeDocument, decisions, importSettings);
        const { assets, warnings } = builtAssets;
        // buildAssets may promote a container to a local same-name resource.
        // Compile after that promotion so assets and SceneNodeSpec share the
        // exact same final plan.
        const plans = (0, import_planner_1.compileImportPlan)(activeDocument.roots, decisions);
        const fonts = await resolveFonts(importSettings);
        const sourceRootFrames = activeDocument.roots.map(nodeFrame);
        const multipleRoots = activeDocument.roots.length > 1;
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
        const roots = activeDocument.roots
            .map((node, index) => {
            const spec = makeSpec(node, rootFrame, decisions, plans, activeDocument.nodeById, assets, fonts, true);
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
        const sourceNodeId = activeDocument.sourceNodeId;
        if (sourceNodeId && roots.length === 1) {
            const prefabWriter = new assets_1.AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = ((_e = (_d = roots[0]) === null || _d === void 0 ? void 0 : _d.name) === null || _e === void 0 ? void 0 : _e.trim())
                || ((_g = (_f = activeDocument.roots[0]) === null || _f === void 0 ? void 0 : _f.name) === null || _g === void 0 ? void 0 : _g.trim())
                || activeDocument.fileName;
            const prefabUrl = `db://assets/${prefabWriter.folder}/${(0, assets_1.sanitizeAssetName)(frameName)}.prefab`;
            emitProgress({
                phase: 'scene',
                value: 0.05,
                message: '正在创建或打开目标 Prefab…',
            });
            const result = await importLinkedFramePrefab({
                prefabUrl,
                prefabName: frameName,
                fileKey: activeDocument.fileKey,
                sourceNodeId,
                rootFrame,
                scale: importSettings.scale,
                roots,
            });
            const nodeMaps = await getNodeMaps();
            // Prefab updates persist by PrefabInfo.fileId in the asset meta;
            // runtime node UUIDs are session-only and must never be reused here.
            delete nodeMaps[activeDocument.fileKey];
            await Editor.Profile.setProject(package_json_1.default.name, 'nodeMaps', nodeMaps, 'project');
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
            packageName: package_json_1.default.name,
            fileKey: activeDocument.fileKey,
            rootName: activeDocument.fileName,
            rootFrame,
            scale: importSettings.scale,
            updateExisting: importSettings.updateExisting,
            existingMap: (_h = nodeMaps[activeDocument.fileKey]) !== null && _h !== void 0 ? _h : {},
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: package_json_1.default.name,
            method: 'importDocument',
            args: [payload],
        });
        await Editor.Message.request('scene', 'snapshot');
        nodeMaps[activeDocument.fileKey] = result.nodeMap;
        await Editor.Profile.setProject(package_json_1.default.name, 'nodeMaps', nodeMaps, 'project');
        Editor.Selection.select('node', result.rootUuid);
        if (importSettings.autoSave) {
            await Editor.Message.request('scene', 'save-scene');
        }
        const finalResult = warnings.length ? { ...result, warnings } : result;
        emitProgress({
            phase: 'done',
            value: 1,
            message: `完成：新建 ${result.created}，更新 ${result.updated}${warnings.length ? `；${warnings.length} 个三/九宫已降级为 PNG 整层` : ''}`,
        });
        return finalResult;
    }
    catch (error) {
        if (error instanceof client_1.CancelledError || (activeController === null || activeController === void 0 ? void 0 : activeController.signal.aborted)) {
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
        finishOperation();
    }
}
exports.methods = {
    openPanel() {
        Editor.Panel.open(package_json_1.default.name);
    },
    async getState() {
        await vault.initialize();
        return {
            version: package_json_1.default.version,
            vault: vault.status(),
            settings: await getSettings(),
            fontAssets: await listFontAssets(),
            document: activeDocument ? {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl: activeDocument.sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
                nodeOverrides: await nodeOverridesFor(activeDocument.fileKey),
            } : null,
        };
    },
    async setToken(value) {
        return vault.set(value);
    },
    async clearToken() {
        return vault.clear();
    },
    async verifyToken() {
        beginOperation();
        try {
            const identity = await (await client()).verify();
            return {
                ok: true,
                handle: identity.handle || 'Figma User',
            };
        }
        finally {
            finishOperation();
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
        beginOperation();
        try {
            emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取 Figma 文件…' });
            const parsed = (0, url_1.parseFigmaSource)(sourceUrl);
            const api = await client();
            const payload = parsed.nodeId
                ? await api.getNode(parsed.fileKey, parsed.nodeId)
                : await api.getFile(parsed.fileKey);
            activeDocument = annotateDocumentPlan((0, parser_1.parseDocument)(payload, sourceUrl, parsed.fileKey, parsed.nodeId));
            const current = await getSettings();
            await saveSettings({ ...current, sourceUrl });
            emitProgress({ phase: 'idle', value: 1, message: `已读取 ${activeDocument.fileName}` });
            return {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
                fontAssets: await listFontAssets(),
                nodeOverrides: await nodeOverridesFor(activeDocument.fileKey),
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
            finishOperation();
        }
    },
    async getPreview(nodeId) {
        const node = activeDocument === null || activeDocument === void 0 ? void 0 : activeDocument.nodeById.get(nodeId);
        if (!activeDocument || !node) {
            throw new Error('预览节点不存在。');
        }
        beginOperation();
        try {
            const urls = await (await client()).getImageUrls(activeDocument.fileKey, [nodeId], 'png', 1, !overflowingRenderFrame(node));
            if (!urls[nodeId]) {
                throw new Error('无法生成节点预览。');
            }
            return { url: urls[nodeId] };
        }
        finally {
            finishOperation();
        }
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
}
function unload() {
    activeController === null || activeController === void 0 ? void 0 : activeController.abort();
    activeController = null;
    activeDocument = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQThaQSx3REFnQkM7QUE4QkQsa0NBeUJDO0FBRUQsZ0VBU0M7QUE2cUJELDRCQXNHQztBQWs0QkQsb0JBWUM7QUFFRCx3QkFJQztBQXZwRUQsK0JBQThFO0FBQzlFLDJCQUFnQztBQUNoQyxtQ0FBcUM7QUFDckMsMENBQWdEO0FBQ2hELG1FQUEwQztBQUMxQywyQ0FBOEU7QUFDOUUsK0NBVTBCO0FBQzFCLDJDQUErQztBQUMvQywyREFHZ0M7QUFDaEMsNkNBQW1EO0FBQ25ELHFDQUErQztBQUMvQyxxREFJMEI7QUFDMUIsOENBTzJCO0FBQzNCLDRDQUF1RTtBQUV2RSxnRUFBa0U7QUFDbEUsd0NBQTZDO0FBQzdDLHdEQVlnQztBQUNoQyx3REFBb0Q7QUFDcEQsaURBQXVEO0FBQ3ZELG1EQUFzRTtBQUN0RSx5REFBMkQ7QUFDM0QsbUNBbUJpQjtBQUNqQiwyQ0FBK0M7QUFFL0MsTUFBTSxLQUFLLEdBQUcsSUFBSSx3QkFBVSxDQUFDLHNCQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsSUFBSSxjQUFjLEdBQTJCLElBQUksQ0FBQztBQUNsRCxJQUFJLGdCQUFnQixHQUEyQixJQUFJLENBQUM7QUFDcEQsSUFBSSxtQkFBbUIsR0FBMkIsSUFBSSxDQUFDO0FBQ3ZELElBQUksYUFBYSxHQUEwQixJQUFJLENBQUM7QUFDaEQsSUFBSSx3QkFBd0IsR0FBa0IsSUFBSSxDQUFDO0FBd0RuRCxNQUFNLGVBQWUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLE9BQU8sRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQzdFLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFXO0lBQ2pDLE1BQU07SUFDTixNQUFNO0lBQ04sUUFBUTtJQUNSLE9BQU87SUFDUCxVQUFV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QyxDQUFDLE9BQU8sTUFBTSxDQUFDLE1BQU0sNENBQTRDO1lBQ2xFLENBQUMsQ0FBQyxJQUFJLENBQUM7SUFDZixDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNiLHdCQUF3QixHQUFHLHFCQUFxQixLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNsRyxPQUFPLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLENBQUM7SUFDNUMsQ0FBQztBQUNMLENBQUM7QUFFRCxTQUFnQixNQUFNO0lBQ2xCLGdCQUFnQixhQUFoQixnQkFBZ0IsdUJBQWhCLGdCQUFnQixDQUFFLEtBQUssRUFBRSxDQUFDO0lBQzFCLGdCQUFnQixHQUFHLElBQUksQ0FBQztJQUN4QixjQUFjLEdBQUcsSUFBSSxDQUFDO0FBQzFCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBiYXNlbmFtZSwgZXh0bmFtZSwgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUgfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdjcnlwdG8nO1xyXG5pbXBvcnQgeyByZWFkRmlsZSwgcmVhZGRpciB9IGZyb20gJ2ZzL3Byb21pc2VzJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEZpZ21hQ2xpZW50LCBDYW5jZWxsZWRFcnJvciwgY2xhbXBJbWFnZVNjYWxlIH0gZnJvbSAnLi9maWdtYS9jbGllbnQnO1xyXG5pbXBvcnQge1xyXG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcclxuICAgIGluZmVyQWN0aW9uLFxyXG4gICAgaW5mZXJDb2Nvc0xheW91dE1vZGUsXHJcbiAgICBpbmZlcktpbmQsXHJcbiAgICBpc1BhdGNoQ2FuZGlkYXRlLFxyXG4gICAgaXNWZWN0b3JOb2RlLFxyXG4gICAgbmF0aXZlVGlsZWRQYWludFNvdXJjZSxcclxuICAgIHBsYWluSW1hZ2VTb3VyY2VSZWYsXHJcbiAgICB0eXBlIFRpbGVkUGFpbnRTb3VyY2UsXHJcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XHJcbmltcG9ydCB7IHBhcnNlRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hL3BhcnNlcic7XHJcbmltcG9ydCB7XHJcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcclxuICAgIGNvbXBpbGVJbXBvcnRQbGFuLFxyXG59IGZyb20gJy4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBhbmFseXplU2xpY2VHcmlkIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgQXNzZXRXcml0ZXIsXHJcbiAgICBSQVNURVJfSU1BR0VfRVhURU5TSU9OUyxcclxuICAgIGRldGVjdEltYWdlRXh0ZW5zaW9uLFxyXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcclxuICAgIHNhbml0aXplQXNzZXROYW1lLFxyXG4gICAgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbixcclxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB7IExvY2FsQXNzZXRDYWNoZSwgdHlwZSBDYWNoZUVudHJ5S2V5IH0gZnJvbSAnLi9pbXBvcnRlci9jYWNoZSc7XHJcbmltcG9ydCB0eXBlIHsgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBncmFkaWVudFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc3ZnJztcclxuaW1wb3J0IHtcclxuICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyxcclxuICAgIGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uLFxyXG4gICAgY3JlYXRlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIGZpZ21hRnJhbWVTb3VyY2VIYXNoLFxyXG4gICAgbWVyZ2VQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxyXG4gICAgcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZCxcclxuICAgIHJlYWRQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXHJcbiAgICByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgIHR5cGUgUHJlZmFiU3luY1JlY29yZCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcclxuaW1wb3J0IHsgVG9rZW5WYXVsdCB9IGZyb20gJy4vc2VjdXJpdHkvdG9rZW4tdmF1bHQnO1xyXG5pbXBvcnQgeyBSb3VuZHRyaXBTZXJ2aWNlIH0gZnJvbSAnLi9yb3VuZHRyaXAvc2VydmljZSc7XHJcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcclxuaW1wb3J0IHsgZWRpdG9yUmVpbXBvcnRlciB9IGZyb20gJy4vcm91bmR0cmlwL3RyYW5zYWN0aW9uJztcclxuaW1wb3J0IHtcclxuICAgIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgICB0eXBlIERvY3VtZW50U2Vzc2lvbixcclxuICAgIHR5cGUgRmlnbWFOb2RlLFxyXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXHJcbiAgICB0eXBlIEltcG9ydERlY2lzaW9uLFxyXG4gICAgdHlwZSBJbXBvcnRPdmVycmlkZSxcclxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcclxuICAgIHR5cGUgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICB0eXBlIE5vZGVLaW5kLFxyXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcclxuICAgIHR5cGUgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgdHlwZSBQcm9ncmVzc0V2ZW50LFxyXG4gICAgdHlwZSBSZWN0LFxyXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHlwZSBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICB0eXBlIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxubGV0IGFjdGl2ZURvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZUNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBzZXR0aW5nc0NhY2hlOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuXHJcbnR5cGUgRGVjaXNpb24gPSBJbXBvcnREZWNpc2lvbjtcclxuXHJcbmludGVyZmFjZSBUaWxlZEFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSYXdJbWFnZUFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBpbWFnZVJlZjogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgU2NlbmVJbXBvcnRQYXlsb2FkIHtcclxuICAgIHBhY2thZ2VOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICByb290TmFtZTogc3RyaW5nO1xyXG4gICAgcm9vdEZyYW1lOiBSZWN0O1xyXG4gICAgc2NhbGU6IG51bWJlcjtcclxuICAgIHVwZGF0ZUV4aXN0aW5nOiBib29sZWFuO1xyXG4gICAgZXhpc3RpbmdNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBjZW50ZXJJbkNhbnZhcz86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJDb250ZXh0PzogUHJlZmFiU2NlbmVTeW5jQ29udGV4dDtcclxuICAgIHJvb3RzOiBTY2VuZU5vZGVTcGVjW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFJlc3VsdCB7XG4gICAgcm9vdFV1aWQ6IHN0cmluZztcclxuICAgIG5vZGVNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgICBjcmVhdGVkOiBudW1iZXI7XHJcbiAgICB1cGRhdGVkOiBudW1iZXI7XHJcbiAgICB0ZW1wb3JhcnlSb290PzogYm9vbGVhbjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xufVxuXG5pbnRlcmZhY2UgQXNzZXRCdWlsZFJlc3VsdCB7XG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+O1xuICAgIHdhcm5pbmdzOiBzdHJpbmdbXTtcbn1cblxyXG5pbnRlcmZhY2UgUHJlZmFiQXNzZXRJbmZvIHtcclxuICAgIHV1aWQ6IHN0cmluZztcclxuICAgIHVybDogc3RyaW5nO1xyXG4gICAgaW1wb3J0ZXI6IHN0cmluZztcclxuICAgIHR5cGU6IHN0cmluZztcclxuICAgIGltcG9ydGVkOiBib29sZWFuO1xyXG4gICAgaW52YWxpZDogYm9vbGVhbjtcclxuICAgIGlzRGlyZWN0b3J5PzogYm9vbGVhbjtcclxuICAgIHJlYWRvbmx5PzogYm9vbGVhbjtcclxuICAgIHJlZGlyZWN0PzogdW5rbm93bjtcclxufVxyXG5cclxuY29uc3QgRk9OVF9FWFRFTlNJT05TID0gbmV3IFNldChbJy50dGYnLCAnLm90ZicsICcuZm50JywgJy53b2ZmJywgJy53b2ZmMiddKTtcclxuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcclxuICAgICdhdXRvJyxcclxuICAgICdub2RlJyxcclxuICAgICdzcHJpdGUnLFxyXG4gICAgJ2xhYmVsJyxcclxuICAgICdyaWNoVGV4dCcsXHJcbiAgICAnYnV0dG9uJyxcclxuICAgICdzY3JvbGxWaWV3JyxcclxuICAgICdsYXlvdXQnLFxyXG5dKTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGxpc3RGb250QXNzZXRzKCk6IFByb21pc2U8Rm9udEFzc2V0T3B0aW9uW10+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGZvbnRzOiBGb250QXNzZXRPcHRpb25bXSA9IFtdO1xyXG4gICAgYXN5bmMgZnVuY3Rpb24gdmlzaXQoZm9sZGVyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBsZXQgZW50cmllcztcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBlbnRyaWVzID0gYXdhaXQgcmVhZGRpcihmb2xkZXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcclxuICAgICAgICAgICAgaWYgKGVudHJ5Lm5hbWUgPT09ICdub2RlX21vZHVsZXMnIHx8IGVudHJ5Lm5hbWUgPT09ICdsaWJyYXJ5JyB8fCBlbnRyeS5uYW1lID09PSAndGVtcCcpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihmb2xkZXIsIGVudHJ5Lm5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdmlzaXQoZmlsZVBhdGgpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFGT05UX0VYVEVOU0lPTlMuaGFzKGV4dG5hbWUoZW50cnkubmFtZSkudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBmaWxlUGF0aCkucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG4gICAgICAgICAgICBmb250cy5wdXNoKHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IGJhc2VuYW1lKGVudHJ5Lm5hbWUsIGV4dG5hbWUoZW50cnkubmFtZSkpLFxyXG4gICAgICAgICAgICAgICAgdXJsOiBgZGI6Ly9hc3NldHMvJHtwYXRofWAsXHJcbiAgICAgICAgICAgICAgICByZWxhdGl2ZVBhdGg6IHBhdGgsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGF3YWl0IHZpc2l0KGFzc2V0c1Jvb3QpO1xyXG4gICAgcmV0dXJuIGZvbnRzLnNvcnQoKGEsIGIpID0+IGEucmVsYXRpdmVQYXRoLmxvY2FsZUNvbXBhcmUoYi5yZWxhdGl2ZVBhdGgsICd6aC1DTicpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW1pdFByb2dyZXNzKHByb2dyZXNzOiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBFZGl0b3IuTWVzc2FnZS5zZW5kKHBhY2thZ2VKU09OLm5hbWUsICdwcm9ncmVzcycsIHByb2dyZXNzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVmYXVsdENhY2hlRm9sZGVyKCk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihFZGl0b3IuUHJvamVjdC50bXBEaXIsIHBhY2thZ2VKU09OLm5hbWUsICdhc3NldC1jYWNoZScpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBJbXBvcnRTZXR0aW5ncyB7XHJcbiAgICBjb25zdCBpbnB1dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCdcclxuICAgICAgICA/IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+XHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHNjYWxlID0gdHlwZW9mIGlucHV0LnNjYWxlID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUoaW5wdXQuc2NhbGUpXHJcbiAgICAgICAgPyBNYXRoLm1heCgwLjI1LCBNYXRoLm1pbig0LCBpbnB1dC5zY2FsZSkpXHJcbiAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnNjYWxlO1xyXG4gICAgY29uc3QgZm9udE1hcCA9IGlucHV0LmZvbnRNYXAgJiYgdHlwZW9mIGlucHV0LmZvbnRNYXAgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoaW5wdXQuZm9udE1hcClcclxuICAgICAgICAgICAgLmZpbHRlcigoW2tleSwgaXRlbV0pID0+IGtleS50cmltKCkgJiYgdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAubWFwKChba2V5LCBpdGVtXSkgPT4gW2tleS50cmltKCksIGl0ZW0udHJpbSgpXSkpXHJcbiAgICAgICAgOiB7fTtcclxuICAgIGNvbnN0IHJhd0xvY2FsRm9sZGVycyA9IEFycmF5LmlzQXJyYXkoaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnMpXHJcbiAgICAgICAgPyBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogdHlwZW9mIGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXIgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgID8gW2lucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHJhd0xvY2FsRm9sZGVyc1xyXG4gICAgICAgIC5maWx0ZXIoKGZvbGRlcik6IGZvbGRlciBpcyBzdHJpbmcgPT4gdHlwZW9mIGZvbGRlciA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBmb2xkZXIudHJpbSgpKVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIsIGluZGV4LCBmb2xkZXJzKSA9PiBmb2xkZXJzLmluZGV4T2YoZm9sZGVyKSA9PT0gaW5kZXgpXHJcbiAgICAgICAgLnNsaWNlKDAsIDMpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IHR5cGVvZiBpbnB1dC5zb3VyY2VVcmwgPT09ICdzdHJpbmcnID8gaW5wdXQuc291cmNlVXJsLnRyaW0oKSA6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiB0eXBlb2YgaW5wdXQuYXNzZXRGb2xkZXIgPT09ICdzdHJpbmcnICYmIGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LmFzc2V0Rm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MuYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiB0eXBlb2YgaW5wdXQucHJlZmFiRm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5wcmVmYWJGb2xkZXIudHJpbSgpXHJcbiAgICAgICAgICAgID8gaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA6IERFRkFVTFRfU0VUVElOR1MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGxvY2FsUmVzb3VyY2VGb2xkZXJzWzBdID8/ICcnLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbnB1dC51cGRhdGVFeGlzdGluZyAhPT0gZmFsc2UsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogaW5wdXQucmVmcmVzaEFzc2V0cyA9PT0gdHJ1ZSxcclxuICAgICAgICBhdXRvU2F2ZTogaW5wdXQuYXV0b1NhdmUgPT09IHRydWUsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFNldHRpbmdzKCk6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIGlmIChzZXR0aW5nc0NhY2hlKSB7XHJcbiAgICAgICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgJ3Byb2plY3QnKTtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3Moc2F2ZWQpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+IHtcclxuICAgIHNldHRpbmdzQ2FjaGUgPSBzYWZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnc2V0dGluZ3MnLCBzZXR0aW5nc0NhY2hlLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNldHRpbmdzQ2FjaGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGNsaWVudChzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkID0gYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsKTogUHJvbWlzZTxGaWdtYUNsaWVudD4ge1xyXG4gICAgcmV0dXJuIG5ldyBGaWdtYUNsaWVudChhd2FpdCB2YXVsdC5nZXQoKSwgc2lnbmFsKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcm91bmR0cmlwU2VydmljZShzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8Um91bmR0cmlwU2VydmljZT4ge1xyXG4gICAgY29uc3QgY3JlYXRvclZlcnNpb24gPSAoRWRpdG9yLkFwcCBhcyB1bmtub3duIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9KS52ZXJzaW9uID8/ICd1bmtub3duJztcclxuICAgIHJldHVybiBuZXcgUm91bmR0cmlwU2VydmljZSh7XHJcbiAgICAgICAgY2xpZW50OiBhd2FpdCBjbGllbnQoc2lnbmFsKSxcclxuICAgICAgICBwcm9qZWN0Um9vdDogRWRpdG9yLlByb2plY3QucGF0aCxcclxuICAgICAgICBjcmVhdG9yVmVyc2lvbixcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpOiBBYm9ydENvbnRyb2xsZXIge1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICByb3VuZHRyaXBDb250cm9sbGVyID0gY29udHJvbGxlcjtcclxuICAgIHJldHVybiBjb250cm9sbGVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyKTogdm9pZCB7XHJcbiAgICBpZiAocm91bmR0cmlwQ29udHJvbGxlciA9PT0gY29udHJvbGxlcikgcm91bmR0cmlwQ29udHJvbGxlciA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJlZ2luT3BlcmF0aW9uKCk6IHZvaWQge1xyXG4gICAgYWN0aXZlQ29udHJvbGxlcj8uYWJvcnQoKTtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaE9wZXJhdGlvbigpOiB2b2lkIHtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWxhdGl2ZUFzc2V0Rm9sZGVyKHNlbGVjdGVkUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShzZWxlY3RlZFBhdGgpO1xyXG4gICAgY29uc3QgZm9sZGVyID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgaWYgKCFmb2xkZXIgfHwgZm9sZGVyID09PSAnLicgfHwgZm9sZGVyLnN0YXJ0c1dpdGgoJy4uJykgfHwgaXNBYnNvbHV0ZShmb2xkZXIpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfotYTmupDovpPlh7rnm67lvZXlv4XpobvmmK/pobnnm64gYXNzZXRzIOS4i+eahOWtkOaWh+S7tuWkueOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2V0RGF0YWJhc2VVcmwoZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSByZXNvbHZlKGZpbGVQYXRoKTtcclxuICAgIGNvbnN0IHBhdGggPSByZWxhdGl2ZShhc3NldHNSb290LCBzZWxlY3RlZCk7XHJcbiAgICBjb25zdCBvdXRzaWRlID0gcGF0aCA9PT0gJy4uJ1xyXG4gICAgICAgIHx8IHBhdGguc3RhcnRzV2l0aCgnLi4vJylcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uXFxcXCcpXHJcbiAgICAgICAgfHwgaXNBYnNvbHV0ZShwYXRoKTtcclxuICAgIGlmICghcGF0aCB8fCBwYXRoID09PSAnLicgfHwgb3V0c2lkZSkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGBkYjovL2Fzc2V0cy8ke3BhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpfWA7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tBc3NldEZvbGRlcihjdXJyZW50OiB1bmtub3duKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxuICAgIGFic29sdXRlUGF0aDogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgYXNzZXRzUm9vdCA9IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJ1xyXG4gICAgICAgID8gY3VycmVudC50cmltKCkucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15hc3NldHNcXC8rLywgJycpXHJcbiAgICAgICAgOiAnJztcclxuICAgIGNvbnN0IHByZWZlcnJlZFBhdGggPSBjdXJyZW50Rm9sZGVyICYmICFjdXJyZW50Rm9sZGVyLnN0YXJ0c1dpdGgoJy4uJylcclxuICAgICAgICA/IHJlc29sdmUoYXNzZXRzUm9vdCwgY3VycmVudEZvbGRlcilcclxuICAgICAgICA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGV4aXN0c1N5bmMocHJlZmVycmVkUGF0aCkgPyBwcmVmZXJyZWRQYXRoIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5EaWFsb2cuc2VsZWN0KHtcclxuICAgICAgICB0aXRsZTogJ+mAieaLqSBGaWdtYSDlr7zlhaXotYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6npooTliLbkvZPovpPlh7rnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZvbGRlcjogcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZCksXHJcbiAgICAgICAgYWJzb2x1dGVQYXRoOiByZXNvbHZlKHNlbGVjdGVkKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24sIF9pbmRleCA9IDApOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG59IHwgbnVsbD4ge1xyXG4gICAgY29uc3QgY3VycmVudEZvbGRlciA9IHR5cGVvZiBjdXJyZW50ID09PSAnc3RyaW5nJyA/IGN1cnJlbnQudHJpbSgpIDogJyc7XHJcbiAgICBjb25zdCBpbml0aWFsUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgaXNBYnNvbHV0ZShjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgID8gY3VycmVudEZvbGRlclxyXG4gICAgICAgIDogcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6nmnKzlnLDlkIzlkI3otYTmupDnm67lvZUnLFxyXG4gICAgICAgIHBhdGg6IGluaXRpYWxQYXRoLFxyXG4gICAgICAgIHR5cGU6ICdkaXJlY3RvcnknLFxyXG4gICAgICAgIGJ1dHRvbjogJ+mAieaLqeebruW9lScsXHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzdWx0LmZpbGVQYXRoc1swXTtcclxuICAgIGlmIChyZXN1bHQuY2FuY2VsZWQgfHwgIXNlbGVjdGVkKSB7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsaWJyYXJ5ID0gbmV3IExvY2FsUmVzb3VyY2VMaWJyYXJ5KHNlbGVjdGVkKTtcclxuICAgIHJldHVybiB7IGZvbGRlcjogbGlicmFyeS5yb290IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVuaW9uRnJhbWUobm9kZXM6IEZpZ21hTm9kZVtdKTogUmVjdCB7XHJcbiAgICBjb25zdCBmcmFtZXMgPSBub2Rlcy5tYXAobm9kZUZyYW1lKS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgUmVjdCA9PiBCb29sZWFuKHZhbHVlKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICB9XHJcbiAgICBjb25zdCB4ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLngpKTtcclxuICAgIGNvbnN0IHkgPSBNYXRoLm1pbiguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSkpO1xyXG4gICAgY29uc3QgcmlnaHQgPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueCArIGZyYW1lLndpZHRoKSk7XHJcbiAgICBjb25zdCBib3R0b20gPSBNYXRoLm1heCguLi5mcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCkpO1xyXG4gICAgcmV0dXJuIHsgeCwgeSwgd2lkdGg6IHJpZ2h0IC0geCwgaGVpZ2h0OiBib3R0b20gLSB5IH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vZGVGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHtcclxuICAgIGlmIChub2RlLmFic29sdXRlQm91bmRpbmdCb3gpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgfVxyXG4gICAgaWYgKG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuaW9uRnJhbWUobm9kZS5jaGlsZHJlbik7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbn1cclxuXHJcbmNvbnN0IFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OID0gMC41O1xyXG5cclxuLyoqXHJcbiAqIE9ubHkgZXhwYW5kIHJhc3RlcnMgd2hvc2UgdmlzaWJsZSBwaXhlbHMgZXNjYXBlIHRoZSBnZW9tZXRyaWMgZnJhbWUuIEFcclxuICogcmVuZGVyIGZyYW1lIGNvbnRhaW5lZCBpbnNpZGUgdGhlIGdlb21ldHJ5IG9mdGVuIHJlcHJlc2VudHMgaW50ZW50aW9uYWxcclxuICogdHJhbnNwYXJlbnQgcGFkZGluZyBhbmQgbXVzdCBrZWVwIHRoZSBsZWdhY3kgZml4ZWQtY2FudmFzIHBhdGguXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3ZlcmZsb3dpbmdSZW5kZXJGcmFtZShub2RlOiBGaWdtYU5vZGUpOiBSZWN0IHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IGdlb21ldHJ5ID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgY29uc3QgcmVuZGVyID0gbm9kZS5hYnNvbHV0ZVJlbmRlckJvdW5kcztcclxuICAgIGlmICghZ2VvbWV0cnkgfHwgIXJlbmRlciB8fCByZW5kZXIud2lkdGggPD0gMCB8fCByZW5kZXIuaGVpZ2h0IDw9IDApIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZ2VvbWV0cnlSaWdodCA9IGdlb21ldHJ5LnggKyBnZW9tZXRyeS53aWR0aDtcclxuICAgIGNvbnN0IGdlb21ldHJ5Qm90dG9tID0gZ2VvbWV0cnkueSArIGdlb21ldHJ5LmhlaWdodDtcclxuICAgIGNvbnN0IHJlbmRlclJpZ2h0ID0gcmVuZGVyLnggKyByZW5kZXIud2lkdGg7XHJcbiAgICBjb25zdCByZW5kZXJCb3R0b20gPSByZW5kZXIueSArIHJlbmRlci5oZWlnaHQ7XHJcbiAgICByZXR1cm4gcmVuZGVyLnggPCBnZW9tZXRyeS54IC0gUkVOREVSX09WRVJGTE9XX0VQU0lMT05cclxuICAgICAgICB8fCByZW5kZXIueSA8IGdlb21ldHJ5LnkgLSBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgIHx8IHJlbmRlclJpZ2h0ID4gZ2VvbWV0cnlSaWdodCArIFJFTkRFUl9PVkVSRkxPV19FUFNJTE9OXHJcbiAgICAgICAgfHwgcmVuZGVyQm90dG9tID4gZ2VvbWV0cnlCb3R0b20gKyBSRU5ERVJfT1ZFUkZMT1dfRVBTSUxPTlxyXG4gICAgICAgID8gcmVuZGVyXHJcbiAgICAgICAgOiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvcm5lclJhZGlpKG5vZGU6IEZpZ21hTm9kZSk6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdIHtcclxuICAgIGlmIChub2RlLnJlY3RhbmdsZUNvcm5lclJhZGlpPy5sZW5ndGggPT09IDQpIHtcclxuICAgICAgICByZXR1cm4gbm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaSBhcyBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJhZGl1cyA9IG5vZGUuY29ybmVyUmFkaXVzID8/IDA7XHJcbiAgICByZXR1cm4gW3JhZGl1cywgcmFkaXVzLCByYWRpdXMsIHJhZGl1c107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHREZWNpc2lvbihub2RlOiBGaWdtYU5vZGUpOiBEZWNpc2lvbiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGFjdGlvbjogaW5mZXJBY3Rpb24obm9kZSksXHJcbiAgICAgICAga2luZDogaW5mZXJLaW5kKG5vZGUpLFxyXG4gICAgICAgIG5pbmVTbGljZTogaXNQYXRjaENhbmRpZGF0ZShub2RlKSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWNpc2lvbkZvck5vZGUobm9kZTogRmlnbWFOb2RlLCBkZWNpc2lvbnM6IE1hcDxzdHJpbmcsIERlY2lzaW9uPik6IERlY2lzaW9uIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdnZW5lcmF0ZScsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIGlmIChpc1ZlY3Rvck5vZGUobm9kZSkgJiYgZGVjaXNpb24uYWN0aW9uICE9PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZGVjaXNpb247XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBkZWNpc2lvbk1hcChvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10sIHRyZWU6IFRyZWVOb2RlRHRvW10pOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4ge1xyXG4gICAgY29uc3QgZGVjaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIERlY2lzaW9uPigpO1xyXG4gICAgY29uc3QgYWRkRGVmYXVsdHMgPSAobm9kZXM6IFRyZWVOb2RlRHRvW10pID0+IHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7XHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihub2RlLmFjdGlvbiksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBhZGREZWZhdWx0cyhub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgYWRkRGVmYXVsdHModHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgICAgICBkZWNpc2lvbnMuc2V0KGl0ZW0uaWQsIHtcclxuICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgICAgICBraW5kOiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQpID8gaXRlbS5raW5kIDogJ2F1dG8nLFxyXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxyXG4gICAgICAgICAgICBleHBsaWNpdDogaXRlbS5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbnM7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbiAgICBpbmNsdWRlTm9kZU5hbWUgPSB0cnVlLFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKTtcclxuICAgIHJldHVybiBkZWNpc2lvbj8uZXhwbGljaXQgPT09IHRydWVcclxuICAgICAgICB8fCAoaW5jbHVkZU5vZGVOYW1lICYmIEJvb2xlYW4oZGVjaXNpb24/Lm5hbWUpKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxudHlwZSBTdG9yZWROb2RlT3ZlcnJpZGVzID0gUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+PjtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTogUHJvbWlzZTxTdG9yZWROb2RlT3ZlcnJpZGVzPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgaXRlbSA9IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0T3ZlcnJpZGU+O1xyXG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xyXG4gICAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBraW5kID0gdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgJiYgTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKVxyXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXHJcbiAgICAgICAgOiAnYXV0byc7XHJcbiAgICBjb25zdCBleHBsaWNpdCA9IGl0ZW0uZXhwbGljaXQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgIGlmICghZXhwbGljaXQgJiYgIW5hbWUpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZCxcclxuICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxyXG4gICAgICAgIGV4cGxpY2l0LFxyXG4gICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgY29uc3Qgc3RvcmVkID0gKGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKSlbZmlsZUtleV0gPz8ge307XHJcbiAgICBjb25zdCByZXN1bHQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xyXG4gICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlLCBpZCk7XHJcbiAgICAgICAgaWYgKHNhZmUpIHJlc3VsdC5wdXNoKHNhZmUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXMoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xyXG4gICAgY29uc3Qgc2FmZUl0ZW1zID0gaXRlbXNcclxuICAgICAgICAubWFwKChpdGVtKSA9PiBzYWZlTm9kZU92ZXJyaWRlKGl0ZW0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgIChBcnJheS5pc0FycmF5KHNjb3BlVmFsdWVzKSA/IHNjb3BlVmFsdWVzIDogc2FmZUl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxyXG4gICAgKTtcclxuICAgIGlmICghc2NvcGVJZHMuc2l6ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY29wZWRJdGVtcyA9IHNhZmVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNjb3BlSWRzLmhhcyhpdGVtLmlkKSk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgZm9yIChjb25zdCBpZCBvZiBzY29wZUlkcykge1xyXG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzY29wZWRJdGVtcykge1xyXG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xyXG4gICAgfVxyXG4gICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkge1xyXG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNjb3BlZEl0ZW1zO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xyXG4gICAgY29uc3QgZGVmYXVsdHMgPSBkZWNpc2lvbk1hcChbXSwgc2Vzc2lvbi50cmVlKTtcclxuICAgIHNlc3Npb24udHJlZSA9IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgICAgIHNlc3Npb24udHJlZSxcclxuICAgICAgICBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWZhdWx0cyksXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbik6IHsgcG5nOiBGaWdtYU5vZGVbXTsgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W107IHJhd0ltYWdlczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXTsgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSB9IHtcclxuICAgIGNvbnN0IHBuZzogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHRpbGVkOiBUaWxlZEFzc2V0UmVxdWVzdFtdID0gW107XHJcbiAgICBjb25zdCByYXdJbWFnZXM6IFJhd0ltYWdlQXNzZXRSZXF1ZXN0W10gPSBbXTtcclxuICAgIGNvbnN0IGdyYWRpZW50czogRmlnbWFOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IEZpZ21hTm9kZSwgYW5jZXN0b3JzVmlzaWJsZTogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBlZmZlY3RpdmVseVZpc2libGUgPSBhbmNlc3RvcnNWaXNpYmxlICYmIG5vZGUudmlzaWJsZSAhPT0gZmFsc2UgJiYgbm9kZS5vcGFjaXR5ID4gMDtcclxuICAgICAgICBpZiAobm9kZS50eXBlID09PSAnVEVYVCcpIHtcclxuICAgICAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UpIHtcclxuICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgICAgICAgICAgaWYgKHNvdXJjZSkge1xyXG4gICAgICAgICAgICAgICAgdGlsZWQucHVzaCh7IG5vZGUsIHNvdXJjZSB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlUmVmID0gZWZmZWN0aXZlbHlWaXNpYmxlID8gdW5kZWZpbmVkIDogcGxhaW5JbWFnZVNvdXJjZVJlZihub2RlKTtcclxuICAgICAgICAgICAgICAgIGlmIChpbWFnZVJlZikge1xyXG4gICAgICAgICAgICAgICAgICAgIHJhd0ltYWdlcy5wdXNoKHsgbm9kZSwgaW1hZ2VSZWYgfSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIGVmZmVjdGl2ZWx5VmlzaWJsZSkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHRydWUpKTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIHJhd0ltYWdlcywgZ3JhZGllbnRzIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkQXNzZXRzKFxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4pOiBQcm9taXNlPEFzc2V0QnVpbGRSZXN1bHQ+IHtcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQXNzZXRXcml0ZXIoaW1wb3J0U2V0dGluZ3MuYXNzZXRGb2xkZXIpO1xyXG4gICAgYXdhaXQgd3JpdGVyLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGNhY2hlID0gbmV3IExvY2FsQXNzZXRDYWNoZShkZWZhdWx0Q2FjaGVGb2xkZXIoKSk7XHJcbiAgICBhd2FpdCBjYWNoZS5pbml0aWFsaXplKCk7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlcyA9IGltcG9ydFNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgLm1hcCgoZm9sZGVyKSA9PiBuZXcgTG9jYWxSZXNvdXJjZUxpYnJhcnkoZm9sZGVyKSk7XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChsb2NhbFJlc291cmNlcy5tYXAoKGxpYnJhcnkpID0+IGxpYnJhcnkuaW5pdGlhbGl6ZSgpKSk7XHJcbiAgICBjb25zdCBwcm9tb3RlTG9jYWxQYXJlbnRzID0gYXN5bmMgKG5vZGU6IEZpZ21hTm9kZSk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgJiYgbm9kZS50eXBlICE9PSAnVEVYVCdcclxuICAgICAgICAgICAgJiYgIWRlY2lzaW9uLm5pbmVTbGljZVxyXG4gICAgICAgICAgICAvLyBSZW5hbWluZyB0aGlzIGNvbnRhaW5lciBkb2VzIG5vdCBjaGFuZ2UgcmVzb3VyY2UgbWF0Y2hpbmc7IG9ubHlcclxuICAgICAgICAgICAgLy8gYSBzdHJhdGVneSBvdmVycmlkZSBvbiBpdHNlbGYgb3IgYW55IG92ZXJyaWRlIGJlbG93IGl0IGJsb2Nrc1xyXG4gICAgICAgICAgICAvLyBwcm9tb3Rpb24gYmVjYXVzZSBkZXNjZW5kYW50cyB3b3VsZCBvdGhlcndpc2UgZGlzYXBwZWFyLlxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcclxuICAgICAgICAgICAgLy8gQSBsb2NhbCBwYXJlbnQgcmVzb3VyY2UgY2Fubm90IHJlcHJlc2VudCBpbmRlcGVuZGVudGx5IGluYWN0aXZlXHJcbiAgICAgICAgICAgIC8vIGRlc2NlbmRhbnRzLiBLZWVwIHRoZSBoaWVyYXJjaHkgd2hlbmV2ZXIgc3VjaCBhIGJvdW5kYXJ5IGV4aXN0cy5cclxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSkpIHtcclxuICAgICAgICAgICAgbGV0IGxvY2FsTWF0Y2ggPSBudWxsO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGxpYnJhcnkgb2YgbG9jYWxSZXNvdXJjZXMpIHtcclxuICAgICAgICAgICAgICAgIGxvY2FsTWF0Y2ggPSBhd2FpdCBsaWJyYXJ5LmZpbmQobm9kZS5uYW1lLCAncG5nJyk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwobm9kZS5jaGlsZHJlbi5tYXAocHJvbW90ZUxvY2FsUGFyZW50cykpO1xyXG4gICAgfTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKHNlc3Npb24ucm9vdHMubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIGNvbnN0IHJlcXVlc3RzID0gY29sbGVjdEFzc2V0UmVxdWVzdHMoc2Vzc2lvbi5yb290cywgZGVjaXNpb25zKTtcclxuICAgIGNvbnN0IGFzc2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+KCk7XG4gICAgY29uc3Qgd2FybmluZ3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBjb25zdCB0b3RhbCA9IHJlcXVlc3RzLnBuZy5sZW5ndGggKyByZXF1ZXN0cy50aWxlZC5sZW5ndGhcclxuICAgICAgICArIHJlcXVlc3RzLnJhd0ltYWdlcy5sZW5ndGggKyByZXF1ZXN0cy5ncmFkaWVudHMubGVuZ3RoO1xyXG4gICAgbGV0IGNvbXBsZXRlZCA9IDA7XHJcbiAgICBsZXQgYXBpUHJvbWlzZTogUHJvbWlzZTxGaWdtYUNsaWVudD4gfCBudWxsID0gbnVsbDtcclxuXHJcbiAgICBjb25zdCBnZXRBcGkgPSAoKSA9PiB7XHJcbiAgICAgICAgYXBpUHJvbWlzZSA/Pz0gY2xpZW50KCk7XHJcbiAgICAgICAgcmV0dXJuIGFwaVByb21pc2U7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IGNvbXBsZXRlQXNzZXQgPSAoXHJcbiAgICAgICAgbm9kZTogRmlnbWFOb2RlLFxyXG4gICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnIHwgJ2dlbmVyYXRlZCcgPSAnZmlnbWEnLFxyXG4gICAgKSA9PiB7XHJcbiAgICAgICAgYXNzZXRzLnNldChub2RlLmlkLCBhc3NldCk7XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgY29uc3QgdmVyYiA9IHNvdXJjZSA9PT0gJ2xvY2FsJ1xyXG4gICAgICAgICAgICA/ICflpI3nlKjmnKzlnLDotYTmupAnXHJcbiAgICAgICAgICAgIDogc291cmNlID09PSAnZXhpc3RpbmcnXHJcbiAgICAgICAgICAgICAgICA/ICflpI3nlKjlt7LmnInotYTmupAnXHJcbiAgICAgICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2dlbmVyYXRlZCdcclxuICAgICAgICAgICAgICAgICAgICA/ICfnlJ/miJDmuJDlj5gnXHJcbiAgICAgICAgICAgICAgICA6ICflr7zlhaXotYTmupAnO1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnYXNzZXRzJyxcclxuICAgICAgICAgICAgdmFsdWU6IHRvdGFsID8gY29tcGxldGVkIC8gdG90YWwgOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHt2ZXJifSAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1RpbGVkID0gYXN5bmMgKGl0ZW1zOiBUaWxlZEFzc2V0UmVxdWVzdFtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgVGlsZUdyb3VwIHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZTtcclxuICAgICAgICAgICAgc291cmNlS2V5OiBzdHJpbmc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGludGVyZmFjZSBQZW5kaW5nVGlsZSBleHRlbmRzIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsO1xyXG4gICAgICAgICAgICBleHRlbnNpb24/OiBSYXN0ZXJJbWFnZUV4dGVuc2lvbjtcclxuICAgICAgICAgICAgc291cmNlVHlwZTogJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlcXVlc3RlZFNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gaW1wb3J0U2V0dGluZ3Muc2NhbGUgKiBzb3VyY2Uuc2NhbGU7XHJcbiAgICAgICAgY29uc3QgcmVuZGVyU2NhbGUgPSAoc291cmNlOiBUaWxlZFBhaW50U291cmNlKSA9PiBzb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICA/IGNsYW1wSW1hZ2VTY2FsZShyZXF1ZXN0ZWRTY2FsZShzb3VyY2UpKVxyXG4gICAgICAgICAgICA6IDE7XHJcbiAgICAgICAgY29uc3QgdGlsZUFzc2V0ID0gKGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsIHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSk6IFNwcml0ZUFzc2V0U3BlYyA9PiAoe1xyXG4gICAgICAgICAgICAuLi5hc3NldCxcclxuICAgICAgICAgICAgdGlsZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIHRpbGVTY2FsZTogcmVxdWVzdGVkU2NhbGUoc291cmNlKSAvIHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIFRpbGVHcm91cD4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHsgbm9kZSwgc291cmNlIH0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlS2V5ID0gSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAga2luZDogc291cmNlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBpZDogc291cmNlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFpbnRTY2FsZTogc291cmNlLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyU2NhbGU6IHJlbmRlclNjYWxlKHNvdXJjZSksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBrZXkgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChub2RlLm5hbWUsIHNvdXJjZUtleSwgJ3BuZycpXHJcbiAgICAgICAgICAgICAgICAubm9ybWFsaXplKCdORktDJylcclxuICAgICAgICAgICAgICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyBub2RlLCBub2RlczogW10sIHNvdXJjZSwgc291cmNlS2V5IH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNvbXBsZXRlR3JvdXAgPSAoXHJcbiAgICAgICAgICAgIGdyb3VwZWROb2RlczogRmlnbWFOb2RlW10sXHJcbiAgICAgICAgICAgIGFzc2V0OiBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IFBlbmRpbmdUaWxlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBleGlzdGluZ0Fzc2V0OiBTcHJpdGVBc3NldFNwZWMgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGV4dGVuc2lvbiBvZiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUykge1xyXG4gICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nQXNzZXQgPSBhd2FpdCB3cml0ZXIuZXhpc3RpbmcoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHdyaXRlci5idWlsZFRpbGVkVXJsKGdyb3VwLm5vZGUubmFtZSwgZ3JvdXAuc291cmNlS2V5LCBleHRlbnNpb24pLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChleGlzdGluZ0Fzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwLm5vZGVzLCB0aWxlQXNzZXQoZXhpc3RpbmdBc3NldCwgZ3JvdXAuc291cmNlKSwgJ2V4aXN0aW5nJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgY2FjaGVkRXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKCFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBleHRlbnNpb25zOiByZWFkb25seSBSYXN0ZXJJbWFnZUV4dGVuc2lvbltdID0gZ3JvdXAuc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IFsncG5nJ11cclxuICAgICAgICAgICAgICAgICAgICA6IFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TO1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBleHRlbnNpb24gb2YgZXh0ZW5zaW9ucykge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGNhY2hlLnJlYWQoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWxlS2V5OiBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtncm91cC5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZm9ybWF0OiBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShncm91cC5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjYWNoZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBjYWNoZWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlZEV4dGVuc2lvbiA9IGV4dGVuc2lvbjtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHBlbmRpbmcucHVzaCh7XHJcbiAgICAgICAgICAgICAgICAuLi5ncm91cCxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzLFxyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uOiBjYWNoZWRFeHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VUeXBlOiBjb250ZW50cyA/ICdjYWNoZScgOiAnZmlnbWEnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuVXJscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCBudWxsPigpO1xyXG4gICAgICAgIGNvbnN0IHBhdHRlcm5zQnlTY2FsZSA9IG5ldyBNYXA8bnVtYmVyLCBTZXQ8c3RyaW5nPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmVtb3RlSXRlbXMpIHtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uc291cmNlLmtpbmQgIT09ICdzb3VyY2Utbm9kZScpIHtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHNjYWxlID0gcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBpZHMgPSBwYXR0ZXJuc0J5U2NhbGUuZ2V0KHNjYWxlKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICAgICAgaWRzLmFkZChpdGVtLnNvdXJjZS5pZCk7XHJcbiAgICAgICAgICAgIHBhdHRlcm5zQnlTY2FsZS5zZXQoc2NhbGUsIGlkcyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3QgW3NjYWxlLCBpZHNdIG9mIHBhdHRlcm5zQnlTY2FsZSkge1xyXG4gICAgICAgICAgICBjb25zdCB1cmxzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZVVybHMoXHJcbiAgICAgICAgICAgICAgICBzZXNzaW9uLmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBBcnJheS5mcm9tKGlkcyksXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIHNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IFtpZCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyh1cmxzKSkge1xyXG4gICAgICAgICAgICAgICAgcGF0dGVyblVybHMuc2V0KGAke2lkfTpzY2FsZToke3NjYWxlfWAsIHVybCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmVlZHNJbWFnZUZpbGxzID0gcmVtb3RlSXRlbXMuc29tZSgoaXRlbSkgPT4gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ2ltYWdlLXJlZicpO1xyXG4gICAgICAgIGNvbnN0IGltYWdlRmlsbFVybHMgPSBuZWVkc0ltYWdlRmlsbHNcclxuICAgICAgICAgICAgPyBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlRmlsbFVybHMoc2Vzc2lvbi5maWxlS2V5KVxyXG4gICAgICAgICAgICA6IHt9O1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPEJ1ZmZlcj4+KCk7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWQgPSAodXJsOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgbGV0IHRhc2sgPSBkb3dubG9hZHMuZ2V0KHVybCk7XHJcbiAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgdGFzayA9IGdldEFwaSgpLnRoZW4oKGFwaSkgPT4gYXBpLmRvd25sb2FkKHVybCkpO1xyXG4gICAgICAgICAgICAgICAgZG93bmxvYWRzLnNldCh1cmwsIHRhc2spO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB0YXNrO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uID0gaXRlbS5leHRlbnNpb247XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/IHBhdHRlcm5VcmxzLmdldChcclxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7aXRlbS5zb3VyY2UuaWR9OnNjYWxlOiR7cmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICAgICAgICAgIDogaW1hZ2VGaWxsVXJsc1tpdGVtLnNvdXJjZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gaXRlbS5zb3VyY2Uua2luZCA9PT0gJ3NvdXJjZS1ub2RlJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA/IGBQQVRURVJOIOa6kOiKgueCuSAke2l0ZW0uc291cmNlLmlkfWBcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBgSU1BR0Ug5aGr5YWFICR7aXRlbS5zb3VyY2UuaWR9YDtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZ21hIOacquiDveaPkOS+myR7bGFiZWx977yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgZG93bmxvYWQocmVtb3RlVXJsKTtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICA/ICdwbmcnXHJcbiAgICAgICAgICAgICAgICAgICAgOiBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZSh7XHJcbiAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgIG5vZGVJZDogYHRpbGU6JHtpdGVtLnNvdXJjZUtleX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiByZW5kZXJTY2FsZShpdGVtLnNvdXJjZSksXHJcbiAgICAgICAgICAgICAgICB9LCBjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFleHRlbnNpb24pIHtcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbiA9IGRldGVjdEltYWdlRXh0ZW5zaW9uKGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRUaWxlZFVybChpdGVtLm5vZGUubmFtZSwgaXRlbS5zb3VyY2VLZXksIGV4dGVuc2lvbik7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGVzLFxyXG4gICAgICAgICAgICAgICAgdGlsZUFzc2V0KFxyXG4gICAgICAgICAgICAgICAgICAgIGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzLCB1bmRlZmluZWQsIHRydWUpLFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlLFxyXG4gICAgICAgICAgICAgICAgKSxcclxuICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlVHlwZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NSZW1vdGUgPSBhc3luYyAobm9kZXM6IEZpZ21hTm9kZVtdKSA9PiB7XHJcbiAgICAgICAgaWYgKCFub2Rlcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmb3JtYXQgPSAncG5nJyBhcyBjb25zdDtcclxuICAgICAgICBjb25zdCBncm91cHMgPSBuZXcgTWFwPHN0cmluZywgeyB1cmw6IHN0cmluZzsgbm9kZXM6IEZpZ21hTm9kZVtdIH0+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfWAsXHJcbiAgICAgICAgICAgICAgICBmb3JtYXQsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gdXJsLm5vcm1hbGl6ZSgnTkZLQycpLnRvTG9jYWxlTG93ZXJDYXNlKCdlbi1VUycpO1xyXG4gICAgICAgICAgICBjb25zdCBncm91cCA9IGdyb3Vwcy5nZXQoa2V5KSA/PyB7IHVybCwgbm9kZXM6IFtdIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIGdyb3Vwcy5zZXQoa2V5LCBncm91cCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBlbmRpbmc6IEFycmF5PHtcclxuICAgICAgICAgICAgbm9kZTogRmlnbWFOb2RlO1xyXG4gICAgICAgICAgICBub2RlczogRmlnbWFOb2RlW107XHJcbiAgICAgICAgICAgIHVybDogc3RyaW5nO1xyXG4gICAgICAgICAgICBib3JkZXJzPzogeyBsZWZ0OiBudW1iZXI7IHJpZ2h0OiBudW1iZXI7IHRvcDogbnVtYmVyOyBib3R0b206IG51bWJlciB9O1xyXG4gICAgICAgICAgICByZW5kZXJGcmFtZT86IFJlY3Q7XHJcbiAgICAgICAgICAgIGtleTogQ2FjaGVFbnRyeUtleTtcclxuICAgICAgICAgICAgY29udGVudHM6IEJ1ZmZlciB8IG51bGw7XHJcbiAgICAgICAgICAgIHNvdXJjZTogJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH0+ID0gW107XHJcbiAgICAgICAgY29uc3QgY29tcGxldGVHcm91cCA9IChcclxuICAgICAgICAgICAgZ3JvdXBlZE5vZGVzOiBGaWdtYU5vZGVbXSxcclxuICAgICAgICAgICAgYXNzZXQ6IFNwcml0ZUFzc2V0U3BlYyxcclxuICAgICAgICAgICAgc291cmNlOiAnZXhpc3RpbmcnIHwgJ2xvY2FsJyB8ICdjYWNoZScgfCAnZmlnbWEnLFxyXG4gICAgICAgICkgPT4ge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGdyb3VwZWROb2RlIG9mIGdyb3VwZWROb2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChncm91cGVkTm9kZSwgYXNzZXQsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgeyB1cmwsIG5vZGVzOiBncm91cGVkTm9kZXMgfSBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZ3JvdXBlZE5vZGVzWzBdO1xyXG4gICAgICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9ucy5nZXQobm9kZS5pZCkgPz8gZGVmYXVsdERlY2lzaW9uKG5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBzbGljZUFuYWx5c2lzID0gZGVjaXNpb24ubmluZVNsaWNlICYmIGZvcm1hdCA9PT0gJ3BuZydcbiAgICAgICAgICAgICAgICA/IGFuYWx5emVTbGljZUdyaWQobm9kZSwgaW1wb3J0U2V0dGluZ3Muc2NhbGUpXG4gICAgICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgICAgaWYgKGRlY2lzaW9uLm5pbmVTbGljZSAmJiAhc2xpY2VBbmFseXNpcykge1xuICAgICAgICAgICAgICAgIHdhcm5pbmdzLmFkZChg5LiJL+S5neWuq+iKgueCueKAnCR7bm9kZS5uYW1lfeKAneaXoOazleiuoeeul+i/nue7reWIh+eJh+i+ueeVjO+8jOW3suS4tOaXtuS9nOS4uiBQTkcg5pW05bGC5a+85YWlYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBib3JkZXJzID0gc2xpY2VBbmFseXNpcz8uYm9yZGVycztcclxuICAgICAgICAgICAgLy8gU2xpY2VkIGFzc2V0cyByZXRhaW4gdGhlaXIgZXhhY3QgZ2VvbWV0cmljIGNhbnZhcyBiZWNhdXNlIHRoZWlyXHJcbiAgICAgICAgICAgIC8vIGJvcmRlciBtZXRhZGF0YSBpcyBleHByZXNzZWQgaW4gdGhhdCBjb29yZGluYXRlIHNwYWNlLlxyXG4gICAgICAgICAgICBjb25zdCByZW5kZXJGcmFtZSA9IGJvcmRlcnMgPyB1bmRlZmluZWQgOiBvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICBsZXQgbG9jYWxNYXRjaCA9IG51bGw7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgbGlicmFyeSBvZiBsb2NhbFJlc291cmNlcykge1xyXG4gICAgICAgICAgICAgICAgbG9jYWxNYXRjaCA9IGF3YWl0IGxpYnJhcnkuZmluZChub2RlLm5hbWUsIGZvcm1hdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxvY2FsVXJsID0gbG9jYWxNYXRjaCAmJiAhYm9yZGVyc1xyXG4gICAgICAgICAgICAgICAgPyBhc3NldERhdGFiYXNlVXJsKGxvY2FsTWF0Y2gucGF0aClcclxuICAgICAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICAgICAgY29uc3QgbG9jYWxBc3NldCA9IGxvY2FsVXJsID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKGxvY2FsVXJsKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChsb2NhbEFzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgbG9jYWxBc3NldCwgJ2xvY2FsJyk7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9ICFpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzID8gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKHVybCkgOiBudWxsO1xyXG4gICAgICAgICAgICBpZiAoIWxvY2FsTWF0Y2ggJiYgZXhpc3RpbmcgJiYgIWJvcmRlcnMgJiYgIXJlbmRlckZyYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUdyb3VwKGdyb3VwZWROb2RlcywgZXhpc3RpbmcsICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3Qga2V5OiBDYWNoZUVudHJ5S2V5ID0ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgc2NhbGU6IGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdmFyaWFudDogcmVuZGVyRnJhbWUgPyAndmlzdWFsLW92ZXJmbG93LXYxJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gbG9jYWxNYXRjaCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgY2FjaGUucmVhZChrZXkpO1xyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIG5vZGVzOiBncm91cGVkTm9kZXMsXHJcbiAgICAgICAgICAgICAgICB1cmwsXHJcbiAgICAgICAgICAgICAgICBib3JkZXJzLFxyXG4gICAgICAgICAgICAgICAgcmVuZGVyRnJhbWU6IGxvY2FsTWF0Y2ggPyB1bmRlZmluZWQgOiByZW5kZXJGcmFtZSxcclxuICAgICAgICAgICAgICAgIGtleSxcclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzOiBsb2NhbE1hdGNoPy5jb250ZW50cyA/PyBjYWNoZWQsXHJcbiAgICAgICAgICAgICAgICBzb3VyY2U6IGxvY2FsTWF0Y2ggPyAnbG9jYWwnIDogY2FjaGVkID8gJ2NhY2hlJyA6ICdmaWdtYScsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB1cmxzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPiA9IHt9O1xyXG4gICAgICAgIGNvbnN0IHJlbW90ZUl0ZW1zID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKTtcclxuICAgICAgICBmb3IgKGNvbnN0IHVzZUFic29sdXRlQm91bmRzIG9mIFt0cnVlLCBmYWxzZV0pIHtcclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSByZW1vdGVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IChcclxuICAgICAgICAgICAgICAgIHVzZUFic29sdXRlQm91bmRzID8gIWl0ZW0ucmVuZGVyRnJhbWUgOiBCb29sZWFuKGl0ZW0ucmVuZGVyRnJhbWUpXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgICAgICBpZiAoIWJhdGNoLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih1cmxzLCBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGJhdGNoLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICAgICAgdXNlQWJzb2x1dGVCb3VuZHMsXHJcbiAgICAgICAgICAgICkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZykge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxldCBjb250ZW50cyA9IGl0ZW0uY29udGVudHM7XHJcbiAgICAgICAgICAgIGlmICghY29udGVudHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlbW90ZVVybCA9IHVybHNbaXRlbS5ub2RlLmlkXTtcclxuICAgICAgICAgICAgICAgIGlmICghcmVtb3RlVXJsKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73muLLmn5PoioLngrnvvJoke2l0ZW0ubm9kZS5uYW1lfWApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCAoYXdhaXQgZ2V0QXBpKCkpLmRvd25sb2FkKHJlbW90ZVVybCk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBjYWNoZS53cml0ZShpdGVtLmtleSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgd3JpdGVyLndyaXRlKGl0ZW0udXJsLCBjb250ZW50cywgaXRlbS5ib3JkZXJzKTtcbiAgICAgICAgICAgIGlmIChhc3NldC5zbGljZUZhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgd2FybmluZ3MuYWRkKGDkuIkv5Lmd5a6r6IqC54K54oCcJHtpdGVtLm5vZGUubmFtZX3igJ3liIfniYforr7nva7lpLHotKXvvIzlt7LkuLTml7bkvZzkuLogUE5HIOaVtOWxguWvvOWFpe+8miR7YXNzZXQuc2xpY2VGYWxsYmFja31gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgaXRlbS5ub2Rlcykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVBc3NldChcclxuICAgICAgICAgICAgICAgICAgICBncm91cGVkTm9kZSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnJlbmRlckZyYW1lXHJcbiAgICAgICAgICAgICAgICAgICAgICAgID8geyAuLi5hc3NldCwgcmVuZGVyRnJhbWU6IG92ZXJmbG93aW5nUmVuZGVyRnJhbWUoZ3JvdXBlZE5vZGUpID8/IGl0ZW0ucmVuZGVyRnJhbWUgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGFzc2V0LFxyXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcHJvY2Vzc1Jhd0ltYWdlcyA9IGFzeW5jIChpdGVtczogUmF3SW1hZ2VBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgbm9kZTogRmlnbWFOb2RlOyBub2RlczogRmlnbWFOb2RlW107IGltYWdlUmVmOiBzdHJpbmcgfT4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gYCR7aXRlbS5ub2RlLm5hbWUubm9ybWFsaXplKCdORktDJykudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyl9XFwwJHtpdGVtLmltYWdlUmVmfWA7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZTogaXRlbS5ub2RlLCBub2RlczogW10sIGltYWdlUmVmOiBpdGVtLmltYWdlUmVmIH07XHJcbiAgICAgICAgICAgIGdyb3VwLm5vZGVzLnB1c2goaXRlbS5ub2RlKTtcclxuICAgICAgICAgICAgZ3JvdXBzLnNldChrZXksIGdyb3VwKTtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGxldCBpbWFnZUZpbGxVcmxzUHJvbWlzZTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBudWxsPj4gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgY29uc3QgZG93bmxvYWRzID0gbmV3IE1hcDxzdHJpbmcsIFByb21pc2U8QnVmZmVyPj4oKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICBsZXQgY29udGVudHM6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgICAgICBsZXQgZXh0ZW5zaW9uOiBSYXN0ZXJJbWFnZUV4dGVuc2lvbiB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgbGV0IHNvdXJjZTogJ2NhY2hlJyB8ICdmaWdtYScgPSAnY2FjaGUnO1xyXG4gICAgICAgICAgICBpZiAoIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMpIHtcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIFJBU1RFUl9JTUFHRV9FWFRFTlNJT05TKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29udGVudHMgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGNhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb250ZW50cykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBjYW5kaWRhdGU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIWltYWdlRmlsbFVybHNQcm9taXNlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaW1hZ2VGaWxsVXJsc1Byb21pc2UgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSkpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1hZ2VGaWxsVXJscyA9IGF3YWl0IGltYWdlRmlsbFVybHNQcm9taXNlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVtb3RlVXJsID0gaW1hZ2VGaWxsVXJsc1tncm91cC5pbWFnZVJlZl07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95o+Q5L6b6ZqQ6JeP5Zu+54mH5aGr5YWF77yaJHtncm91cC5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBsZXQgdGFzayA9IGRvd25sb2Fkcy5nZXQocmVtb3RlVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmICghdGFzaykge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZChyZW1vdGVVcmwpKTtcclxuICAgICAgICAgICAgICAgICAgICBkb3dubG9hZHMuc2V0KHJlbW90ZVVybCwgdGFzayk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IHRhc2s7XHJcbiAgICAgICAgICAgICAgICBzb3VyY2UgPSAnZmlnbWEnO1xyXG4gICAgICAgICAgICAgICAgZXh0ZW5zaW9uID0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGBpbWFnZS1yZWY6JHtncm91cC5pbWFnZVJlZn1gLFxyXG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ6ICdzb3VyY2UtaW1hZ2UtdjEnLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGV4dGVuc2lvbiA/Pz0gZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBncm91cC5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OmltYWdlLXJlZjoke2dyb3VwLmltYWdlUmVmfWAsXHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24sXHJcbiAgICAgICAgICAgICAgICAxLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGF3YWl0IHdyaXRlci53cml0ZSh1cmwsIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGdyb3VwLm5vZGVzKSBjb21wbGV0ZUFzc2V0KG5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgYXdhaXQgcHJvY2Vzc1RpbGVkKHJlcXVlc3RzLnRpbGVkKTtcclxuICAgIGF3YWl0IHByb2Nlc3NSZW1vdGUocmVxdWVzdHMucG5nKTtcclxuICAgIC8vIFJ1biBhZnRlciB3aG9sZS1ub2RlIHJlbmRlcnMgc28gYSBjb3JyZWN0IHZpc2liaWxpdHktaW5kZXBlbmRlbnQgc291cmNlXHJcbiAgICAvLyBpbWFnZSB3aW5zIGlmIGJvdGggcGF0aHMgc2hhcmUgdGhlIHNhbWUgbGVnYWN5IGFzc2V0IGZpbGVuYW1lLlxyXG4gICAgYXdhaXQgcHJvY2Vzc1Jhd0ltYWdlcyhyZXF1ZXN0cy5yYXdJbWFnZXMpO1xyXG5cclxuICAgIGNvbnN0IGdyYWRpZW50QXNzZXRzID0gbmV3IE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4oKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiByZXF1ZXN0cy5ncmFkaWVudHMpIHtcclxuICAgICAgICBjb25zdCBmcmFtZSA9IG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgY29uc3QgcG5nID0gZnJhbWUgJiYgZmlsbFxyXG4gICAgICAgICAgICA/IGdyYWRpZW50UG5nKFxyXG4gICAgICAgICAgICAgICAgZnJhbWUud2lkdGgsXHJcbiAgICAgICAgICAgICAgICBmcmFtZS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICBmaWxsLFxyXG4gICAgICAgICAgICAgICAgY29ybmVyUmFkaWkobm9kZSksXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgaWYgKHBuZykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH06Z3JhZGllbnRgLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JhZGllbnRLZXkgPSB1cmwubm9ybWFsaXplKCdORktDJykudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZpcnN0QXNzZXQgPSBncmFkaWVudEFzc2V0cy5nZXQoZ3JhZGllbnRLZXkpO1xyXG4gICAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGZpcnN0QXNzZXQgfHwgaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0c1xyXG4gICAgICAgICAgICAgICAgPyBudWxsXHJcbiAgICAgICAgICAgICAgICA6IGF3YWl0IHdyaXRlci5leGlzdGluZyh1cmwpO1xyXG4gICAgICAgICAgICBjb25zdCBhc3NldCA9IGZpcnN0QXNzZXQgPz8gZXhpc3RpbmcgPz8gYXdhaXQgd3JpdGVyLndyaXRlKHVybCwgcG5nKTtcclxuICAgICAgICAgICAgZ3JhZGllbnRBc3NldHMuc2V0KGdyYWRpZW50S2V5LCBhc3NldCk7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQobm9kZSwgYXNzZXQsIGZpcnN0QXNzZXQgfHwgZXhpc3RpbmcgPyAnZXhpc3RpbmcnIDogJ2dlbmVyYXRlZCcpO1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29tcGxldGVkICs9IDE7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdhc3NldHMnLFxyXG4gICAgICAgICAgICB2YWx1ZTogdG90YWwgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDEsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGDnlJ/miJDmuJDlj5ggJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBhc3NldHMsIHdhcm5pbmdzOiBbLi4ud2FybmluZ3NdIH07XG59XG5cclxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUZvbnRzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8TWFwPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3QgW2ZhbWlseSwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKSkge1xyXG4gICAgICAgIGNvbnN0IHV1aWQgPSBhd2FpdCByZXNvbHZlQXNzZXRVdWlkKHVybCk7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgcmVzdWx0LnNldChmYW1pbHksIHV1aWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluZmVycmVkTGF5b3V0TW9kZShub2RlOiBGaWdtYU5vZGUpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xyXG4gICAgY29uc3QgbmF0aXZlTW9kZSA9IGluZmVyQ29jb3NMYXlvdXRNb2RlKG5vZGUpO1xyXG4gICAgaWYgKG5hdGl2ZU1vZGUpIHtcclxuICAgICAgICByZXR1cm4gbmF0aXZlTW9kZTtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpIHtcclxuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZS5jaGlsZHJlblxyXG4gICAgICAgIC5tYXAoKGNoaWxkKSA9PiBjaGlsZC5hYnNvbHV0ZUJvdW5kaW5nQm94KVxyXG4gICAgICAgIC5maWx0ZXIoKGZyYW1lKTogZnJhbWUgaXMgUmVjdCA9PiBCb29sZWFuKGZyYW1lKSk7XHJcbiAgICBpZiAoIWZyYW1lcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIGNvbnN0IGNlbnRlcnNYID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCAvIDIpO1xyXG4gICAgY29uc3QgY2VudGVyc1kgPSBmcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUueSArIGZyYW1lLmhlaWdodCAvIDIpO1xyXG4gICAgY29uc3Qgc3ByZWFkWCA9IE1hdGgubWF4KC4uLmNlbnRlcnNYKSAtIE1hdGgubWluKC4uLmNlbnRlcnNYKTtcclxuICAgIGNvbnN0IHNwcmVhZFkgPSBNYXRoLm1heCguLi5jZW50ZXJzWSkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWSk7XHJcbiAgICBpZiAoc3ByZWFkWSA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdIT1JJWk9OVEFMJztcclxuICAgIH1cclxuICAgIGlmIChzcHJlYWRYIDw9IDIpIHtcclxuICAgICAgICByZXR1cm4gJ1ZFUlRJQ0FMJztcclxuICAgIH1cclxuICAgIHJldHVybiAnR1JJRCc7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtYWtlU3BlYyhcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIHBhcmVudEZyYW1lOiBSZWN0IHwgdW5kZWZpbmVkLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbiAgICBwbGFuczogUmVhZG9ubHlNYXA8c3RyaW5nLCBOb2RlSW1wb3J0UGxhbj4sXHJcbiAgICBub2RlQnlJZDogUmVhZG9ubHlNYXA8c3RyaW5nLCBGaWdtYU5vZGU+LFxyXG4gICAgYXNzZXRzOiBNYXA8c3RyaW5nLCBTcHJpdGVBc3NldFNwZWM+LFxyXG4gICAgZm9udHM6IE1hcDxzdHJpbmcsIHN0cmluZz4sXHJcbiAgICBpc1Jvb3QgPSBmYWxzZSxcclxuICAgIHBhcmVudFdvcmxkUm90YXRpb24gPSAwLFxyXG4pOiBTY2VuZU5vZGVTcGVjIHwgbnVsbCB7XHJcbiAgICBjb25zdCBkZWNpc2lvbiA9IGRlY2lzaW9uRm9yTm9kZShub2RlLCBkZWNpc2lvbnMpO1xyXG4gICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2lnbm9yZScpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lID0gbm9kZUZyYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgcGxhbiA9IHBsYW5zLmdldChub2RlLmlkKTtcclxuICAgIGNvbnN0IGZvbGQgPSBwbGFuPy5mb2xkO1xyXG4gICAgY29uc3QgZm9sZFNvdXJjZSA9IGZvbGQgPyBub2RlQnlJZC5nZXQoZm9sZC5zb3VyY2VOb2RlSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgY29uc3QgdGV4dFNvdXJjZSA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgdmlzdWFsU291cmNlID0gZm9sZCAmJiBmb2xkLmtpbmQgIT09ICdzaW5nbGUtdGV4dCcgJiYgZm9sZFNvdXJjZSA/IGZvbGRTb3VyY2UgOiBub2RlO1xyXG4gICAgY29uc3QgcmVzb2x2ZWRLaW5kID0gZGVjaXNpb24ua2luZCA9PT0gJ2F1dG8nID8gaW5mZXJLaW5kKG5vZGUpIDogZGVjaXNpb24ua2luZDtcclxuICAgIGNvbnN0IHBsYW5uZWRLaW5kID0gcGxhbj8ua2luZCA/PyByZXNvbHZlZEtpbmQ7XHJcbiAgICBjb25zdCBiaXRtYXBUZXJtaW5hbCA9IGRlY2lzaW9uLm5pbmVTbGljZSB8fCBkZWNpc2lvbi5hY3Rpb24gPT09ICdyZW5kZXInO1xyXG4gICAgY29uc3QgdGVybWluYWwgPSBiaXRtYXBUZXJtaW5hbCB8fCBpc1Rlcm1pbmFsQWN0aW9uKGRlY2lzaW9uLmFjdGlvbik7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0ga2luZEZvckltcG9ydEFjdGlvbihwbGFubmVkS2luZCwgZGVjaXNpb24uYWN0aW9uLCBkZWNpc2lvbi5uaW5lU2xpY2UpO1xyXG4gICAgY29uc3Qgc3ByaXRlU291cmNlSWQgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0J1xyXG4gICAgICAgID8gZm9sZC5zb3VyY2VOb2RlSWRcclxuICAgICAgICA6IG5vZGUuaWQ7XHJcbiAgICBjb25zdCBzcHJpdGVBc3NldCA9IGFzc2V0cy5nZXQoc3ByaXRlU291cmNlSWQpO1xyXG4gICAgY29uc3QgYWJzb3JiZWREaXJlY3RJZHMgPSBuZXcgU2V0KGZvbGQgPyBbZm9sZC5zb3VyY2VOb2RlSWRdIDogW10pO1xyXG4gICAgY29uc3QgZnVsbEZvbGQgPSBmb2xkPy5raW5kID09PSAnc2luZ2xlLWltYWdlJyB8fCBmb2xkPy5raW5kID09PSAnc2luZ2xlLXRleHQnO1xyXG4gICAgY29uc3Qgd29ybGRSb3RhdGlvbiA9IHBhcmVudFdvcmxkUm90YXRpb24gKyBub2RlLnJvdGF0aW9uO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmaWdtYUlkOiBub2RlLmlkLFxyXG4gICAgICAgIG5hbWU6IGRlY2lzaW9uLm5hbWUgPz8gbm9kZS5uYW1lLFxyXG4gICAgICAgIGZpZ21hVHlwZTogdmlzdWFsU291cmNlLnR5cGUsXHJcbiAgICAgICAgYWN0aW9uOiBkZWNpc2lvbi5hY3Rpb24sXHJcbiAgICAgICAga2luZDogZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBmcmFtZSxcclxuICAgICAgICBwYXJlbnRGcmFtZSxcclxuICAgICAgICBpbnRyaW5zaWNTaXplOiBub2RlLnNpemUsXHJcbiAgICAgICAgaXNSb290LFxyXG4gICAgICAgIHJvdGF0aW9uOiBub2RlLnJvdGF0aW9uLFxyXG4gICAgICAgIHdvcmxkUm90YXRpb24sXHJcbiAgICAgICAgb3BhY2l0eTogZm9sZFNvdXJjZSAmJiBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IG5vZGUub3BhY2l0eSAqIGZvbGRTb3VyY2Uub3BhY2l0eVxyXG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCxcclxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcclxuICAgICAgICBmaWxsczogdGV4dFNvdXJjZS5maWxscyxcclxuICAgICAgICBzdHJva2VzOiB0ZXh0U291cmNlLnN0cm9rZXMsXHJcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0ZXh0U291cmNlLmNoYXJhY3RlcnMsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0U291cmNlLnN0eWxlLFxyXG4gICAgICAgIGxheW91dDoge1xyXG4gICAgICAgICAgICBtb2RlOiBlZmZlY3RpdmVLaW5kID09PSAnbGF5b3V0JyB8fCBlZmZlY3RpdmVLaW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgICAgID8gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgc291cmNlTW9kZTogbm9kZS5sYXlvdXRNb2RlLFxyXG4gICAgICAgICAgICB3cmFwOiBub2RlLmxheW91dFdyYXAsXHJcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIGNvdW50ZXJBbGlnbjogbm9kZS5jb3VudGVyQXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIHByaW1hcnlTaXppbmc6IG5vZGUucHJpbWFyeUF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgaXRlbVNwYWNpbmc6IG5vZGUuaXRlbVNwYWNpbmcsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTcGFjaW5nOiBub2RlLmNvdW50ZXJBeGlzU3BhY2luZyxcclxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdSaWdodDogbm9kZS5wYWRkaW5nUmlnaHQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdUb3A6IG5vZGUucGFkZGluZ1RvcCxcclxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb3ZlcmZsb3dEaXJlY3Rpb246IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24sXHJcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXHJcbiAgICAgICAgcmVsYXRpdmVUcmFuc2Zvcm06IG5vZGUucmVsYXRpdmVUcmFuc2Zvcm0sXHJcbiAgICAgICAgc3ByaXRlOiBzcHJpdGVBc3NldCxcclxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICBmbGF0dGVuQm91bmRhcnk6IGJpdG1hcFRlcm1pbmFsIHx8IGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gdHJ1ZVxyXG4gICAgICAgICAgICA6IGZvbGQ/LmtpbmQgPT09ICdiYWNrZ3JvdW5kJ1xyXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgcGxhblJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgIGNoaWxkcmVuOiB0ZXJtaW5hbFxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogbm9kZS5jaGlsZHJlblxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+ICFhYnNvcmJlZERpcmVjdElkcy5oYXMoY2hpbGQuaWQpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLFxyXG4gICAgICAgICAgICAgICAgICAgIGZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXHJcbiAgICAgICAgICAgICAgICAgICAgd29ybGRSb3RhdGlvbixcclxuICAgICAgICAgICAgICAgICkpXHJcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChjaGlsZCk6IGNoaWxkIGlzIFNjZW5lTm9kZVNwZWMgPT4gY2hpbGQgIT09IG51bGwpLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZU1hcHMoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsICdwcm9qZWN0Jyk7XHJcbiAgICByZXR1cm4gc2F2ZWQgJiYgdHlwZW9mIHNhdmVkID09PSAnb2JqZWN0JyA/IHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvY29zRmlsZUlkKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBnZW5lcmF0ZWQgPSBFZGl0b3IuVXRpbHM/LlVVSUQ/LmdlbmVyYXRlPy4odHJ1ZSk7XHJcbiAgICByZXR1cm4gdHlwZW9mIGdlbmVyYXRlZCA9PT0gJ3N0cmluZycgJiYgZ2VuZXJhdGVkLmxlbmd0aCA+IDBcclxuICAgICAgICA/IGdlbmVyYXRlZFxyXG4gICAgICAgIDogcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjQnKS5yZXBsYWNlKC89KyQvZywgJycpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYkFzc2V0KHVybE9yVXVpZDogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8gfCBudWxsPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICdxdWVyeS1hc3NldC1pbmZvJyxcclxuICAgICAgICB1cmxPclV1aWQsXHJcbiAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFzc2VydFByZWZhYkFzc2V0KFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgZXhwZWN0ZWQ6IHsgdXVpZD86IHN0cmluZzsgdXJsPzogc3RyaW5nIH0gPSB7fSxcclxuKTogdm9pZCB7XHJcbiAgICBpZiAoaW5mby5pbnZhbGlkIHx8IGluZm8uaW1wb3J0ZWQgIT09IHRydWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDlsJrmnKrlrozmiJDlr7zlhaXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8uaW1wb3J0ZXIgIT09ICdwcmVmYWInIHx8IGluZm8udHlwZSAhPT0gJ2NjLlByZWZhYicgfHwgaW5mby5pc0RpcmVjdG9yeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCH6LWE5rqQ5LiN5piv5Y+v57yW6L6R55qEIENvY29zIFByZWZhYu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoaW5mby5yZWFkb25seSB8fCBpbmZvLnJlZGlyZWN0KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDnm67moIcgUHJlZmFiIOS4uuWPquivu+aIlumHjeWumuWQkei1hOa6kO+8jOS4jeiDveWuieWFqOabtOaWsO+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXVpZCAmJiBpbmZvLnV1aWQgIT09IGV4cGVjdGVkLnV1aWQpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOagoemqjOWksei0pe+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXhwZWN0ZWQudXJsICYmIGluZm8udXJsICE9PSBleHBlY3RlZC51cmwpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDot6/lvoTmoKHpqozlpLHotKXvvJrmnJ/mnJsgJHtleHBlY3RlZC51cmx977yM5a6e6ZmFICR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JQcmVmYWJBc3NldCh1cmw6IHN0cmluZywgZXhwZWN0ZWRVdWlkPzogc3RyaW5nKTogUHJvbWlzZTxQcmVmYWJBc3NldEluZm8+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodXJsKTtcclxuICAgICAgICBpZiAoaW5mbz8uaW52YWxpZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvY29zIFByZWZhYiDotYTmupDlr7zlhaXlpLHotKXvvJoke3VybH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGluZm8/LmltcG9ydGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIGlmIChleHBlY3RlZFV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVVSUQg5Zyo5a+85YWl5pyf6Ze05Y+R55Sf5Y+Y5YyW77yaJHt1cmx9YCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXNzZXJ0UHJlZmFiQXNzZXQoaW5mbywgeyB1dWlkOiBleHBlY3RlZFV1aWQsIHVybCB9KTtcclxuICAgICAgICAgICAgcmV0dXJuIGluZm87XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGDnrYnlvoUgQ29jb3MgUHJlZmFiIOi1hOa6kOWwsee7qui2heaXtu+8miR7dXJsfWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBxdWVyeVByZWZhYk1ldGEodXVpZDogc3RyaW5nKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xyXG4gICAgY29uc3QgbWV0YSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtbWV0YScsXHJcbiAgICAgICAgdXVpZCxcclxuICAgICk7XHJcbiAgICBpZiAoIW1ldGEgfHwgdHlwZW9mIG1ldGEgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5Xor7vlj5YgUHJlZmFiIE1ldGHvvJoke3V1aWR9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB2YWx1ZSA9IG1ldGEgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgIGlmICh2YWx1ZS51dWlkICE9PSB1dWlkIHx8IHZhbHVlLmltcG9ydGVyICE9PSAncHJlZmFiJykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIE1ldGEg5LiO55uu5qCH6LWE5rqQ5LiN5Yy56YWN77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwcmVmYWJEaXNrUGF0aCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoIXVybC5zdGFydHNXaXRoKCdkYjovLycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVJMIOaXoOaViO+8miR7dXJsfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgdXJsLnNsaWNlKCdkYjovLycubGVuZ3RoKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQsXHJcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICByZXR1cm4gcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZChcclxuICAgICAgICAgICAgYXdhaXQgcmVhZEZpbGUocHJlZmFiRGlza1BhdGgoaW5mby51cmwpKSxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgICk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPcGVuZWRQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYlV1aWQ6IHN0cmluZyxcclxuICAgIHJvb3RGaWxlSWQ6IHN0cmluZyxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBjdXJyZW50RGlydHkgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdxdWVyeS1kaXJ0eScpIGFzIGJvb2xlYW47XHJcbiAgICBpZiAoY3VycmVudERpcnR5KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflvZPliY3miZPlvIDnmoTlnLrmma/miJYgUHJlZmFiIOacieacquS/neWtmOS/ruaUue+8m+S4uumBv+WFjeinpuWPkeS/neWtmOivoumXru+8jOivt+WFiOaJi+W3peS/neWtmOaIlui/mOWOn+WQjuWGjeWvvOWFpeOAgicpO1xyXG4gICAgfVxyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ2Fzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdvcGVuLWFzc2V0JywgcHJlZmFiVXVpZCk7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGxldCBsYXN0UmVhc29uID0gJ0NyZWF0b3Ig5bCa5pyq6L+U5ZueIFByZWZhYiDnvJbovpHnirbmgIEnO1xyXG4gICAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgMzBfMDAwKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgICAgICAgICB9KSBhcyBQcmVmYWJFZGl0aW5nU3RhdGU7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RSZWFzb24gPSBzdGF0ZS5yZWFzb24gPz8gbGFzdFJlYXNvbjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg5omT5byA55uu5qCHIFByZWZhYiDotoXml7bvvJoke2xhc3RSZWFzb259YCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFzc2VydE9wZW5lZFByZWZhYihwcmVmYWJVdWlkOiBzdHJpbmcsIHJvb3RGaWxlSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIG1ldGhvZDogJ2luc3BlY3RQcmVmYWJDb250ZXh0JyxcclxuICAgICAgICBhcmdzOiBbeyBwcmVmYWJVdWlkLCByb290RmlsZUlkIH1dLFxyXG4gICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgaWYgKCFzdGF0ZS5yZWFkeSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDnvJbovpHkuIrkuIvmloflt7Llj5jljJbvvJoke3N0YXRlLnJlYXNvbiA/PyAn5pyq55+l5Y6f5ZugJ31gKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvclNjZW5lU2F2ZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDE1XzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmICghZGlydHkpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ+etieW+hSBQcmVmYWIg5L+d5a2Y5a6M5oiQ6LaF5pe244CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFByZWZhYkJpbmRpbmdzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHByZWZhYlV1aWRdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgIGlmICghL15zaGEyNTY6WzAtOWEtZl17NjR9JC8udGVzdChzb3VyY2VIYXNoKVxyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcHJlZmFiVXVpZCAhPT0gJ3N0cmluZydcclxuICAgICAgICAgICAgfHwgIXByZWZhYlV1aWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ57uR5a6a6K6w5b2V5bey5o2f5Z2P77yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZywgcHJlZmFiVXVpZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBiaW5kaW5nc1tzb3VyY2VIYXNoXSA9IHByZWZhYlV1aWQ7XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3ByZWZhYkJpbmRpbmdzVjEnLFxyXG4gICAgICAgIGJpbmRpbmdzLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBpZiAoIWJpbmRpbmdzW3NvdXJjZUhhc2hdKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZGVsZXRlIGJpbmRpbmdzW3NvdXJjZUhhc2hdO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQ7XHJcbn0+PiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxuICAgIGlmICghc2F2ZWQgfHwgdHlwZW9mIHNhdmVkICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHJldHVybiB7fTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgeyBwcmVmYWJVdWlkOiBzdHJpbmc7IHJlY29yZDogUHJlZmFiU3luY1JlY29yZCB9PiA9IHt9O1xyXG4gICAgZm9yIChjb25zdCBbc291cmNlSGFzaCwgcmF3XSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgIXJhd1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgcmF3ICE9PSAnb2JqZWN0J1xyXG4gICAgICAgICAgICB8fCB0eXBlb2YgKHJhdyBhcyB7IHByZWZhYlV1aWQ/OiB1bmtub3duIH0pLnByZWZhYlV1aWQgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZCh7XHJcbiAgICAgICAgICAgIHVzZXJEYXRhOiB7XHJcbiAgICAgICAgICAgICAgICBmaWdtYUltcG9ydGVyOiAocmF3IGFzIHsgcmVjb3JkPzogdW5rbm93biB9KS5yZWNvcmQsXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyZWNvcmQgfHwgcmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5b6F5oGi5aSN5ZCM5q2l6K6w5b2V5p2l5rqQ5LiN5LiA6Ie077yM5bey5YGc5q2i5a+85YWl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlc3VsdFtzb3VyY2VIYXNoXSA9IHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogKHJhdyBhcyB7IHByZWZhYlV1aWQ6IHN0cmluZyB9KS5wcmVmYWJVdWlkLFxyXG4gICAgICAgICAgICByZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldFBlbmRpbmdQcmVmYWJTeW5jKFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfSB8IG51bGwsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcGVuZGluZyA9IGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpO1xyXG4gICAgaWYgKHZhbHVlKSB7XHJcbiAgICAgICAgcGVuZGluZ1tzb3VyY2VIYXNoXSA9IHZhbHVlO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBkZWxldGUgcGVuZGluZ1tzb3VyY2VIYXNoXTtcclxuICAgIH1cclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncGVuZGluZ1ByZWZhYlN5bmNWMScsXHJcbiAgICAgICAgcGVuZGluZyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB2ZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuKTogUHJvbWlzZTx7IG1ldGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4ge1xyXG4gICAgbGV0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgIGxldCByZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgIGlmICghcmVjb3JkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICBgUHJlZmFiIOe8uuWwkSBGaWdtYSDmnaXmupDorrDlvZXvvIzml6Dms5Xnoa7orqTmmK/lkKblj6/lronlhajopobnm5bvvJoke2luZm8udXJsfeOAguivt+WFiOenu+WKqOaIlumHjeWRveWQjeivpei1hOa6kOOAgmAsXHJcbiAgICAgICAgKTtcclxuICAgIH1cclxuICAgIGlmIChyZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIOadpeiHquWPpuS4gOS4qiBGaWdtYSBGcmFtZe+8jOW3suaLkue7neimhueblu+8miR7aW5mby51cmx9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGlmIChwZW5kaW5nKSB7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcucHJlZmFiVXVpZCAhPT0gaW5mby51dWlkIHx8IHBlbmRpbmcucmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmo4DmtYvliLDkuI7nm67moIcgUHJlZmFiIOS4jeS4gOiHtOeahOW+heaBouWkjeWQjOatpeiusOW9le+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCBwZW5kaW5nLnJlY29yZCkpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCBwZW5kaW5nLnJlY29yZCksIG51bGwsIDIpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChpbmZvLnVybCwgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgbWV0YSA9IGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFyZWNvdmVyZWQgfHwgSlNPTi5zdHJpbmdpZnkocmVjb3ZlcmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlop7ph4/lkIzmraXorrDlvZXoh6rliqjmgaLlpI3lpLHotKXjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZWNvcmQgPSByZWNvdmVyZWQ7XHJcbiAgICAgICAgfSBlbHNlIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChpbmZvLCByZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOaWh+S7tuS4juW9k+WJjeWPiuW+heaBouWkjeeahOWQjOatpeiusOW9lemDveS4jeS4gOiHtO+8jOW3suWBnOatouiHquWKqOaBouWkjeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IG1ldGEsIHJlY29yZCB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGxldCBsYXN0RXJyb3I6IHVua25vd247XHJcbiAgICBmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8IDM7IGF0dGVtcHQgKz0gMSkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSByZWFkUHJlZmFiU3luY1JlY29yZChtZXRhKTtcclxuICAgICAgICAgICAgaWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+WGmeWFpeWJjSBQcmVmYWIg5p2l5rqQ6K6w5b2V5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgICAgIGluZm8udXVpZCxcclxuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCkpO1xyXG4gICAgICAgICAgICBpZiAoIXNhdmVkIHx8IEpTT04uc3RyaW5naWZ5KHNhdmVkKSAhPT0gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5ZCO5qCh6aqM5LiN5LiA6Ie044CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGxhc3RFcnJvciA9IGVycm9yO1xyXG4gICAgICAgICAgICBpZiAoYXR0ZW1wdCA8IDIpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxNTApKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHRocm93IGxhc3RFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbGFzdEVycm9yIDogbmV3IEVycm9yKCdQcmVmYWIg5p2l5rqQ6K6w5b2V5YaZ5YWl5aSx6LSl44CCJyk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXBhcmVMaW5rZWRGcmFtZVByZWZhYihcclxuICAgIHByZWZhYlVybDogc3RyaW5nLFxyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nLFxyXG4gICAgcm9vdEZyYW1lOiBSZWN0LFxyXG4gICAgc291cmNlSGFzaDogc3RyaW5nLFxyXG4gICAgc291cmNlUm9vdElkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8e1xyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59PiB7XHJcbiAgICBjb25zdCBiaW5kaW5ncyA9IGF3YWl0IGdldFByZWZhYkJpbmRpbmdzKCk7XHJcbiAgICBjb25zdCBib3VuZFV1aWQgPSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSAoYXdhaXQgZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCkpW3NvdXJjZUhhc2hdO1xyXG4gICAgY29uc3QgcGVuZGluZ0luZm8gPSBwZW5kaW5nXHJcbiAgICAgICAgPyBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHBlbmRpbmcucHJlZmFiVXVpZClcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBjb25zdCB0YXJnZXRQbGFuID0gcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0KFxyXG4gICAgICAgIHBlbmRpbmc/LnByZWZhYlV1aWQsXHJcbiAgICAgICAgYm91bmRVdWlkLFxyXG4gICAgICAgIEJvb2xlYW4ocGVuZGluZ0luZm8pLFxyXG4gICAgKTtcclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyUGVuZGluZykge1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIG51bGwpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRhcmdldFBsYW4uY2xlYXJCaW5kaW5nKSB7XHJcbiAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHRhcmdldFV1aWQgPSB0YXJnZXRQbGFuLnRhcmdldFV1aWQ7XHJcbiAgICBpZiAodGFyZ2V0VXVpZCkge1xyXG4gICAgICAgIGxldCB0YXJnZXRJbmZvID0gcGVuZGluZ0luZm8/LnV1aWQgPT09IHRhcmdldFV1aWRcclxuICAgICAgICAgICAgPyBwZW5kaW5nSW5mb1xyXG4gICAgICAgICAgICA6IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQodGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgaWYgKCF0YXJnZXRJbmZvKSB7XHJcbiAgICAgICAgICAgIGlmIChiaW5kaW5nc1tzb3VyY2VIYXNoXSA9PT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVtb3ZlUHJlZmFiQmluZGluZyhzb3VyY2VIYXNoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQodGFyZ2V0SW5mby51cmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICBpZiAocGVuZGluZz8ucHJlZmFiVXVpZCA9PT0gdGFyZ2V0VXVpZCAmJiBib3VuZFV1aWQgIT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIC8vIFBlcnNpc3QgdGhlIHJlY292ZXJ5IGlkZW50aXR5IGJlZm9yZSB2ZXJpZmllZFByZWZhYlJlY29yZCBtYXlcclxuICAgICAgICAgICAgICAgIC8vIGNvbW1pdCBhbmQgY2xlYXIgcGVuZGluZy4gQSBsYXRlciBtb3ZlIGZhaWx1cmUgbXVzdCBzdGlsbCBiZVxyXG4gICAgICAgICAgICAgICAgLy8gYWJsZSB0byBsb2NhdGUgdGhlIGV4YWN0IFByZWZhYiBieSBVVUlEIG9uIHRoZSBuZXh0IGF0dGVtcHQuXHJcbiAgICAgICAgICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IHZlcmlmaWVkID0gYXdhaXQgdmVyaWZpZWRQcmVmYWJSZWNvcmQodGFyZ2V0SW5mbywgc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIGlmICh0YXJnZXRJbmZvLnVybCAhPT0gcHJlZmFiVXJsKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBjb25mbGljdCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgICAgICAgICAgICAgIGlmIChjb25mbGljdCAmJiBjb25mbGljdC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBgRmlnbWEgRnJhbWUg5a+55bqU55qEIFByZWZhYiDpnIDopoHnp7vliqjliLAgJHtwcmVmYWJVcmx977yM5L2G55uu5qCH6Lev5b6E5bey6KKr5YW25LuW6LWE5rqQ5Y2g55So44CCYCxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKCFjb25mbGljdCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1vdmVkID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ21vdmUtYXNzZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvLnVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICAgICAgICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFtb3ZlZCB8fCBtb3ZlZC51dWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Zyo5L+d55WZIFVVSUQg55qE5YmN5o+Q5LiL56e75YqoIFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaW5mbzogdGFyZ2V0SW5mbyxcclxuICAgICAgICAgICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgaW5mbyA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlZmFiVXJsKTtcclxuICAgIGlmICghaW5mbykge1xyXG4gICAgICAgIGNvbnN0IHJvb3RGaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RUcmFuc2Zvcm1GaWxlSWQgPSBjb2Nvc0ZpbGVJZCgpO1xyXG4gICAgICAgIGNvbnN0IHNlZWQgPSBjcmVhdGVNaW5pbWFsUHJlZmFiSnNvbihcclxuICAgICAgICAgICAgcHJlZmFiTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdjcmVhdGUtYXNzZXQnLFxyXG4gICAgICAgICAgICBwcmVmYWJVcmwsXHJcbiAgICAgICAgICAgIHNlZWQsXHJcbiAgICAgICAgICAgIHsgb3ZlcndyaXRlOiBmYWxzZSwgcmVuYW1lOiBmYWxzZSB9LFxyXG4gICAgICAgICkgYXMgUHJlZmFiQXNzZXRJbmZvIHwgbnVsbDtcclxuICAgICAgICBpZiAoIWNyZWF0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGDml6Dms5XliJvlu7ogUHJlZmFi77yaJHtwcmVmYWJVcmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBjcmVhdGVkLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCByZWNvcmQgPSBjcmVhdGVQcmVmYWJTeW5jUmVjb3JkKFxyXG4gICAgICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgICAgICBzb3VyY2VSb290SWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIHJvb3RUcmFuc2Zvcm1GaWxlSWQsXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBuZXh0TWV0YSA9IG1lcmdlUHJlZmFiU3luY1JlY29yZChtZXRhLCByZWNvcmQpO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICdzYXZlLWFzc2V0LW1ldGEnLFxyXG4gICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KG5leHRNZXRhLCBudWxsLCAyKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgaW5mby51dWlkKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpbmZvLFxyXG4gICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG4gICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKGluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCBpbmZvLnV1aWQpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpbmZvLFxyXG4gICAgICAgIHJlY29yZDogdmVyaWZpZWQucmVjb3JkLFxyXG4gICAgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoYXJnczoge1xyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJOYW1lOiBzdHJpbmc7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBzb3VyY2VOb2RlSWQ6IHN0cmluZztcclxuICAgIHJvb3RGcmFtZTogUmVjdDtcclxuICAgIHNjYWxlOiBudW1iZXI7XHJcbiAgICByb290czogU2NlbmVOb2RlU3BlY1tdO1xyXG59KTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgY29uc3Qgc291cmNlSGFzaCA9IGZpZ21hRnJhbWVTb3VyY2VIYXNoKGFyZ3MuZmlsZUtleSwgYXJncy5zb3VyY2VOb2RlSWQpO1xyXG4gICAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICAgICAgYXJncy5wcmVmYWJVcmwsXHJcbiAgICAgICAgYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHtcclxuICAgICAgICAgICAgeDogYXJncy5yb290RnJhbWUueCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHk6IGFyZ3Mucm9vdEZyYW1lLnkgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB3aWR0aDogYXJncy5yb290RnJhbWUud2lkdGggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICBoZWlnaHQ6IGFyZ3Mucm9vdEZyYW1lLmhlaWdodCAqIGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBzb3VyY2VIYXNoLFxyXG4gICAgICAgIGFyZ3Mucm9vdHNbMF0uZmlnbWFJZCxcclxuICAgICk7XHJcbiAgICBhd2FpdCB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXJsLFxyXG4gICAgICAgIHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICBwcmVwYXJlZC5yZWNvcmQucm9vdEZpbGVJZCxcclxuICAgICk7XHJcbiAgICBjb25zdCBleGlzdGluZ05vZGVGaWxlSWRzID0gcmVzb2x2ZUV4aXN0aW5nTm9kZUZpbGVJZHMoXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLFxyXG4gICAgICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyhhcmdzLnJvb3RzKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBwYXlsb2FkOiBTY2VuZUltcG9ydFBheWxvYWQgPSB7XHJcbiAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgZmlsZUtleTogYXJncy5maWxlS2V5LFxyXG4gICAgICAgIHJvb3ROYW1lOiBhcmdzLnByZWZhYk5hbWUsXHJcbiAgICAgICAgcm9vdEZyYW1lOiBhcmdzLnJvb3RGcmFtZSxcclxuICAgICAgICBzY2FsZTogYXJncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICBleGlzdGluZ01hcDoge30sXHJcbiAgICAgICAgcHJlZmFiVXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICByb290czogYXJncy5yb290cyxcclxuICAgICAgICBwcmVmYWJDb250ZXh0OiB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZDogcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICAgICAgICAgIGV4aXN0aW5nTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWROb2RlRmlsZUlkczogcHJlcGFyZWQucmVjb3JkLm1hbmFnZWROb2RlRmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZENvbXBvbmVudEZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkQ29tcG9uZW50RmlsZUlkcyxcclxuICAgICAgICAgICAgbWFuYWdlZEhlbHBlckZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkSGVscGVyRmlsZUlkcyxcclxuICAgICAgICB9LFxyXG4gICAgfTtcclxuICAgIGxldCBzbmFwc2hvdFN0YXJ0ZWQgPSBmYWxzZTtcclxuICAgIGxldCBzYXZlQXR0ZW1wdGVkID0gZmFsc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IGRpcnR5QmVmb3JlSW1wb3J0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgICAgIGlmIChkaXJ0eUJlZm9yZUltcG9ydCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ebruaghyBQcmVmYWIg5pyJ5pyq5L+d5a2Y55qE5omL5bel5L+u5pS577yM6K+35YWI5L+d5a2Y5ZCO5YaN5omn6KGMIEZpZ21hIOWinumHj+WvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdCcpO1xyXG4gICAgICAgIHNuYXBzaG90U3RhcnRlZCA9IHRydWU7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGlmICghcmVzdWx0LnByZWZhYlN5bmMpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l5pyq6L+U5ZueIGZpbGVJZCDorrDlvZXvvIzlt7LlgZzmraLkv53lrZjjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgbmV4dFJlY29yZCA9IHJlY29yZFByZWZhYlN5bmNDYXB0dXJlKHByZXBhcmVkLnJlY29yZCwgcmVzdWx0LnByZWZhYlN5bmMpO1xyXG4gICAgICAgIGF3YWl0IHNldFBlbmRpbmdQcmVmYWJTeW5jKHNvdXJjZUhhc2gsIHtcclxuICAgICAgICAgICAgcHJlZmFiVXVpZDogcHJlcGFyZWQuaW5mby51dWlkLFxyXG4gICAgICAgICAgICByZWNvcmQ6IG5leHRSZWNvcmQsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgYXdhaXQgYXNzZXJ0T3BlbmVkUHJlZmFiKHByZXBhcmVkLmluZm8udXVpZCwgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQpO1xyXG4gICAgICAgIC8vIE9uY2UgdGhlIHNhdmUgcmVxdWVzdCBpcyBzZW50IGl0cyByZXN1bHQgaXMgYW1iaWd1b3VzIHVudGlsIHRoZVxyXG4gICAgICAgIC8vIHBlcnNpc3RlZCBQcmVmYWIgaXMgdmVyaWZpZWQuIERvIG5vdCByb2xsIHRoZSBpbi1tZW1vcnkgUHJlZmFiIGJhY2tcclxuICAgICAgICAvLyBvbiBhbiBJUEMgdGltZW91dDogdGhlIGRpc2sgd3JpdGUgbWF5IGFscmVhZHkgaGF2ZSBjb21wbGV0ZWQuXHJcbiAgICAgICAgc2F2ZUF0dGVtcHRlZCA9IHRydWU7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JTY2VuZVNhdmVkKCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudEluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgaWYgKCFhd2FpdCBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKGN1cnJlbnRJbmZvLCBuZXh0UmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bmnKrljIXlkKvmnKzmrKHlkIzmraXnlJ/miJDnmoTlhajpg6ggZmlsZUlk77yM5bey5YGc5q2i5pu05pawIE1ldGHjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY3VycmVudE1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoY3VycmVudEluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudFJlY29yZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGN1cnJlbnRNZXRhKTtcclxuICAgICAgICBpZiAoIWN1cnJlbnRSZWNvcmQgfHwgY3VycmVudFJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWcqOS/neWtmOacn+mXtOWPkeeUn+WPmOWMlu+8jOW3suaLkue7neaPkOS6pOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCB3cml0ZVZlcmlmaWVkUHJlZmFiUmVjb3JkKGN1cnJlbnRJbmZvLCBzb3VyY2VIYXNoLCBuZXh0UmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHF1ZXJ5UHJlZmFiQXNzZXQocHJlcGFyZWQuaW5mby51cmwpO1xyXG4gICAgICAgIGlmICghdmVyaWZpZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfkv53lrZjlkI4gUHJlZmFiIFVVSUQg5qCh6aqM5aSx6LSl44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFzc2VydFByZWZhYkFzc2V0KHZlcmlmaWVkLCB7XHJcbiAgICAgICAgICAgIHV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgdXJsOiBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXN1bHQucHJlZmFiVXJsID0gcHJlcGFyZWQuaW5mby51cmw7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5jbGVhcignbm9kZScpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZXBhcmVkLmluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHNuYXBzaG90U3RhcnRlZCAmJiAhc2F2ZUF0dGVtcHRlZCkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzbmFwc2hvdC1hYm9ydCcpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwZXJmb3JtSW1wb3J0KHJlcXVlc3Q6IEltcG9ydFJlcXVlc3QpOiBQcm9taXNlPFNjZW5lSW1wb3J0UmVzdWx0PiB7XHJcbiAgICBpZiAoIWFjdGl2ZURvY3VtZW50KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfor7flhYjor7vlj5YgRmlnbWEg5paH5Lu244CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbXBvcnRTZXR0aW5ncyA9IHNhZmVTZXR0aW5ncyhyZXF1ZXN0LnNldHRpbmdzKTtcclxuICAgIGF3YWl0IHNhdmVTZXR0aW5ncyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5YiG5p6Q5bm25YeG5aSH6LWE5rqQ4oCmJyB9KTtcclxuICAgICAgICBjb25zdCBkZWNpc2lvbnMgPSBkZWNpc2lvbk1hcChyZXF1ZXN0Lm92ZXJyaWRlcywgYWN0aXZlRG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgY29uc3QgYnVpbHRBc3NldHMgPSBhd2FpdCBidWlsZEFzc2V0cyhhY3RpdmVEb2N1bWVudCwgZGVjaXNpb25zLCBpbXBvcnRTZXR0aW5ncyk7XG4gICAgICAgIGNvbnN0IHsgYXNzZXRzLCB3YXJuaW5ncyB9ID0gYnVpbHRBc3NldHM7XG4gICAgICAgIC8vIGJ1aWxkQXNzZXRzIG1heSBwcm9tb3RlIGEgY29udGFpbmVyIHRvIGEgbG9jYWwgc2FtZS1uYW1lIHJlc291cmNlLlxyXG4gICAgICAgIC8vIENvbXBpbGUgYWZ0ZXIgdGhhdCBwcm9tb3Rpb24gc28gYXNzZXRzIGFuZCBTY2VuZU5vZGVTcGVjIHNoYXJlIHRoZVxyXG4gICAgICAgIC8vIGV4YWN0IHNhbWUgZmluYWwgcGxhbi5cclxuICAgICAgICBjb25zdCBwbGFucyA9IGNvbXBpbGVJbXBvcnRQbGFuKGFjdGl2ZURvY3VtZW50LnJvb3RzLCBkZWNpc2lvbnMpO1xyXG4gICAgICAgIGNvbnN0IGZvbnRzID0gYXdhaXQgcmVzb2x2ZUZvbnRzKGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICBjb25zdCBzb3VyY2VSb290RnJhbWVzID0gYWN0aXZlRG9jdW1lbnQucm9vdHMubWFwKG5vZGVGcmFtZSk7XHJcbiAgICAgICAgY29uc3QgbXVsdGlwbGVSb290cyA9IGFjdGl2ZURvY3VtZW50LnJvb3RzLmxlbmd0aCA+IDE7XHJcbiAgICAgICAgY29uc3QgYXJyYW5nZWRXaWR0aCA9IG11bHRpcGxlUm9vdHNcclxuICAgICAgICAgICAgPyBzb3VyY2VSb290RnJhbWVzLnJlZHVjZSgodG90YWwsIGZyYW1lKSA9PiB0b3RhbCArIGZyYW1lLndpZHRoLCAwKVxyXG4gICAgICAgICAgICAgICAgKyBNYXRoLm1heCgwLCBzb3VyY2VSb290RnJhbWVzLmxlbmd0aCAtIDEpICogMTYwXHJcbiAgICAgICAgICAgIDogc291cmNlUm9vdEZyYW1lc1swXT8ud2lkdGggPz8gMDtcclxuICAgICAgICBjb25zdCByb290RnJhbWUgPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8ge1xyXG4gICAgICAgICAgICAgICAgeDogMCxcclxuICAgICAgICAgICAgICAgIHk6IDAsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogYXJyYW5nZWRXaWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogTWF0aC5tYXgoMCwgLi4uc291cmNlUm9vdEZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS5oZWlnaHQpKSxcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0gPz8geyB4OiAwLCB5OiAwLCB3aWR0aDogMCwgaGVpZ2h0OiAwIH07XHJcbiAgICAgICAgbGV0IHJvb3RDdXJzb3IgPSAwO1xyXG4gICAgICAgIGNvbnN0IHJvb3RzID0gYWN0aXZlRG9jdW1lbnQucm9vdHNcclxuICAgICAgICAgICAgLm1hcCgobm9kZSwgaW5kZXgpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHNwZWMgPSBtYWtlU3BlYyhcclxuICAgICAgICAgICAgICAgICAgICBub2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBkZWNpc2lvbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgcGxhbnMsXHJcbiAgICAgICAgICAgICAgICAgICAgYWN0aXZlRG9jdW1lbnQhLm5vZGVCeUlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFzc2V0cyxcclxuICAgICAgICAgICAgICAgICAgICBmb250cyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIGlmIChzcGVjICYmIG11bHRpcGxlUm9vdHMpIHtcclxuICAgICAgICAgICAgICAgICAgICBzcGVjLmZyYW1lID0ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB4OiByb290Q3Vyc29yLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB3aWR0aDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogc291cmNlUm9vdEZyYW1lc1tpbmRleF0uaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgcm9vdEN1cnNvciArPSBzb3VyY2VSb290RnJhbWVzW2luZGV4XS53aWR0aCArIDE2MDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiBzcGVjO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuZmlsdGVyKChub2RlKTogbm9kZSBpcyBTY2VuZU5vZGVTcGVjID0+IG5vZGUgIT09IG51bGwpO1xyXG4gICAgICAgIGlmICghcm9vdHMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5rKh5pyJ6YCJ5Lit5Lu75L2V5Y+v5a+85YWl6IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBzb3VyY2VOb2RlSWQgPSBhY3RpdmVEb2N1bWVudC5zb3VyY2VOb2RlSWQ7XHJcbiAgICAgICAgaWYgKHNvdXJjZU5vZGVJZCAmJiByb290cy5sZW5ndGggPT09IDEpIHtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiV3JpdGVyID0gbmV3IEFzc2V0V3JpdGVyKGltcG9ydFNldHRpbmdzLnByZWZhYkZvbGRlcik7XHJcbiAgICAgICAgICAgIGF3YWl0IHByZWZhYldyaXRlci5pbml0aWFsaXplKCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lTmFtZSA9IHJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGFjdGl2ZURvY3VtZW50LnJvb3RzWzBdPy5uYW1lPy50cmltKClcclxuICAgICAgICAgICAgICAgIHx8IGFjdGl2ZURvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmYWJVcmwgPSBgZGI6Ly9hc3NldHMvJHtwcmVmYWJXcml0ZXIuZm9sZGVyfS8ke3Nhbml0aXplQXNzZXROYW1lKGZyYW1lTmFtZSl9LnByZWZhYmA7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ3NjZW5lJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAwLjA1LFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogJ+ato+WcqOWIm+W7uuaIluaJk+W8gOebruaghyBQcmVmYWLigKYnLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW1wb3J0TGlua2VkRnJhbWVQcmVmYWIoe1xyXG4gICAgICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICAgICAgcHJlZmFiTmFtZTogZnJhbWVOYW1lLFxyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogYWN0aXZlRG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZU5vZGVJZCxcclxuICAgICAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgICAgICAvLyBQcmVmYWIgdXBkYXRlcyBwZXJzaXN0IGJ5IFByZWZhYkluZm8uZmlsZUlkIGluIHRoZSBhc3NldCBtZXRhO1xyXG4gICAgICAgICAgICAvLyBydW50aW1lIG5vZGUgVVVJRHMgYXJlIHNlc3Npb24tb25seSBhbmQgbXVzdCBuZXZlciBiZSByZXVzZWQgaGVyZS5cclxuICAgICAgICAgICAgZGVsZXRlIG5vZGVNYXBzW2FjdGl2ZURvY3VtZW50LmZpbGVLZXldO1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2RvbmUnLFxuICAgICAgICAgICAgICAgIHZhbHVlOiAxLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH3vvIzlt7LmiZPlvIDpooTliLbkvZMgJHtwcmVmYWJVcmx9JHt3YXJuaW5ncy5sZW5ndGggPyBg77ybJHt3YXJuaW5ncy5sZW5ndGh9IOS4quS4iS/kuZ3lrqvlt7LpmY3nuqfkuLogUE5HIOaVtOWxgmAgOiAnJ31gLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gZmluYWxSZXN1bHQ7XG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgbm9kZU1hcHMgPSBhd2FpdCBnZXROb2RlTWFwcygpO1xyXG4gICAgICAgIGNvbnN0IHBheWxvYWQ6IFNjZW5lSW1wb3J0UGF5bG9hZCA9IHtcclxuICAgICAgICAgICAgcGFja2FnZU5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGFjdGl2ZURvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIHJvb3ROYW1lOiBhY3RpdmVEb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgcm9vdEZyYW1lLFxyXG4gICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBpbXBvcnRTZXR0aW5ncy51cGRhdGVFeGlzdGluZyxcclxuICAgICAgICAgICAgZXhpc3RpbmdNYXA6IG5vZGVNYXBzW2FjdGl2ZURvY3VtZW50LmZpbGVLZXldID8/IHt9LFxyXG4gICAgICAgICAgICByb290cyxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnc2NlbmUnLCB2YWx1ZTogMC4xLCBtZXNzYWdlOiAn5q2j5Zyo5p6E5bu6IENvY29zIOiKgueCueagkeKApicgfSk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgICAgIG1ldGhvZDogJ2ltcG9ydERvY3VtZW50JyxcclxuICAgICAgICAgICAgYXJnczogW3BheWxvYWRdLFxyXG4gICAgICAgIH0pIGFzIFNjZW5lSW1wb3J0UmVzdWx0O1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NuYXBzaG90Jyk7XHJcbiAgICAgICAgbm9kZU1hcHNbYWN0aXZlRG9jdW1lbnQuZmlsZUtleV0gPSByZXN1bHQubm9kZU1hcDtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlTWFwcycsIG5vZGVNYXBzLCAncHJvamVjdCcpO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdub2RlJywgcmVzdWx0LnJvb3RVdWlkKTtcclxuICAgICAgICBpZiAoaW1wb3J0U2V0dGluZ3MuYXV0b1NhdmUpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc2F2ZS1zY2VuZScpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBmaW5hbFJlc3VsdCA9IHdhcm5pbmdzLmxlbmd0aCA/IHsgLi4ucmVzdWx0LCB3YXJuaW5ncyB9IDogcmVzdWx0O1xuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xuICAgICAgICAgICAgcGhhc2U6ICdkb25lJyxcbiAgICAgICAgICAgIHZhbHVlOiAxLFxuICAgICAgICAgICAgbWVzc2FnZTogYOWujOaIkO+8muaWsOW7uiAke3Jlc3VsdC5jcmVhdGVkfe+8jOabtOaWsCAke3Jlc3VsdC51cGRhdGVkfSR7d2FybmluZ3MubGVuZ3RoID8gYO+8myR7d2FybmluZ3MubGVuZ3RofSDkuKrkuIkv5Lmd5a6r5bey6ZmN57qn5Li6IFBORyDmlbTlsYJgIDogJyd9YCxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBmaW5hbFJlc3VsdDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIENhbmNlbGxlZEVycm9yIHx8IGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnY2FuY2VsbGVkJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICflt7Llj5bmtojjgIInIH0pO1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aTjeS9nOW3suWPlua2iOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgdmFsdWU6IDAsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WvvOWFpeWksei0peOAgicsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGZpbmlzaE9wZXJhdGlvbigpO1xyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgY29uc3QgbWV0aG9kczogUmVjb3JkPHN0cmluZywgKC4uLmFyZ3M6IGFueVtdKSA9PiBhbnk+ID0ge1xyXG4gICAgb3BlblBhbmVsKCkge1xyXG4gICAgICAgIEVkaXRvci5QYW5lbC5vcGVuKHBhY2thZ2VKU09OLm5hbWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBnZXRTdGF0ZSgpIHtcclxuICAgICAgICBhd2FpdCB2YXVsdC5pbml0aWFsaXplKCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgdmVyc2lvbjogcGFja2FnZUpTT04udmVyc2lvbixcclxuICAgICAgICAgICAgdmF1bHQ6IHZhdWx0LnN0YXR1cygpLFxyXG4gICAgICAgICAgICBzZXR0aW5nczogYXdhaXQgZ2V0U2V0dGluZ3MoKSxcclxuICAgICAgICAgICAgZm9udEFzc2V0czogYXdhaXQgbGlzdEZvbnRBc3NldHMoKSxcclxuICAgICAgICAgICAgZG9jdW1lbnQ6IGFjdGl2ZURvY3VtZW50ID8ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogYWN0aXZlRG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGZpbGVOYW1lOiBhY3RpdmVEb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZVVybDogYWN0aXZlRG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICAgICAgdHJlZTogYWN0aXZlRG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgICAgIGZvbnRzOiBhY3RpdmVEb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgICAgIG5vZGVPdmVycmlkZXM6IGF3YWl0IG5vZGVPdmVycmlkZXNGb3IoYWN0aXZlRG9jdW1lbnQuZmlsZUtleSksXHJcbiAgICAgICAgICAgIH0gOiBudWxsLFxyXG4gICAgICAgIH07XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNldFRva2VuKHZhbHVlOiBzdHJpbmcpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuc2V0KHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgY2xlYXJUb2tlbigpIHtcclxuICAgICAgICByZXR1cm4gdmF1bHQuY2xlYXIoKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgdmVyaWZ5VG9rZW4oKSB7XHJcbiAgICAgICAgYmVnaW5PcGVyYXRpb24oKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpZGVudGl0eSA9IGF3YWl0IChhd2FpdCBjbGllbnQoKSkudmVyaWZ5KCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBvazogdHJ1ZSxcclxuICAgICAgICAgICAgICAgIGhhbmRsZTogaWRlbnRpdHkuaGFuZGxlIHx8ICdGaWdtYSBVc2VyJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlU2V0dGluZ3ModmFsdWUpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHNhdmVOb2RlT3ZlcnJpZGVzKGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHBpY2tQcmVmYWJGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duKSB7XHJcbiAgICAgICAgcmV0dXJuIHBpY2tMb2NhbFJlc291cmNlRm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrQ2FjaGVGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZmV0Y2hEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZykge1xyXG4gICAgICAgIGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjE1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+WIEZpZ21hIOaWh+S7tuKApicgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlRmlnbWFTb3VyY2Uoc291cmNlVXJsKTtcclxuICAgICAgICAgICAgY29uc3QgYXBpID0gYXdhaXQgY2xpZW50KCk7XHJcbiAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBwYXJzZWQubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/IGF3YWl0IGFwaS5nZXROb2RlKHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKVxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCBhcGkuZ2V0RmlsZShwYXJzZWQuZmlsZUtleSk7XHJcbiAgICAgICAgICAgIGFjdGl2ZURvY3VtZW50ID0gYW5ub3RhdGVEb2N1bWVudFBsYW4oXHJcbiAgICAgICAgICAgICAgICBwYXJzZURvY3VtZW50KHBheWxvYWQsIHNvdXJjZVVybCwgcGFyc2VkLmZpbGVLZXksIHBhcnNlZC5ub2RlSWQpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcclxuICAgICAgICAgICAgYXdhaXQgc2F2ZVNldHRpbmdzKHsgLi4uY3VycmVudCwgc291cmNlVXJsIH0pO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2lkbGUnLCB2YWx1ZTogMSwgbWVzc2FnZTogYOW3suivu+WPliAke2FjdGl2ZURvY3VtZW50LmZpbGVOYW1lfWAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBmaWxlS2V5OiBhY3RpdmVEb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgZmlsZU5hbWU6IGFjdGl2ZURvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVXJsLFxyXG4gICAgICAgICAgICAgICAgdHJlZTogYWN0aXZlRG9jdW1lbnQudHJlZSxcclxuICAgICAgICAgICAgICAgIGZvbnRzOiBhY3RpdmVEb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICAgICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGFjdGl2ZURvY3VtZW50LmZpbGVLZXkpLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgICBwaGFzZTogJ2Vycm9yJyxcclxuICAgICAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaE9wZXJhdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBhY3RpdmVEb2N1bWVudD8ubm9kZUJ5SWQuZ2V0KG5vZGVJZCk7XHJcbiAgICAgICAgaWYgKCFhY3RpdmVEb2N1bWVudCB8fCAhbm9kZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KCkpLmdldEltYWdlVXJscyhcclxuICAgICAgICAgICAgICAgIGFjdGl2ZURvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBbbm9kZUlkXSxcclxuICAgICAgICAgICAgICAgICdwbmcnLFxyXG4gICAgICAgICAgICAgICAgMSxcclxuICAgICAgICAgICAgICAgICFvdmVyZmxvd2luZ1JlbmRlckZyYW1lKG5vZGUpLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXVybHNbbm9kZUlkXSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZUlkXSB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaE9wZXJhdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwRGV0ZWN0KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmRldGVjdChzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQcmV2aWV3KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnByZXZpZXcoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUGFpcihwYWlyVG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmFwcGx5KHByZXZpZXdUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgcm91bmR0cmlwQ2FuY2VsKCkge1xyXG4gICAgICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGNhbmNlbEltcG9ydCgpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxufTtcclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMoRWRpdG9yLlByb2plY3QucGF0aCwgZWRpdG9yUmVpbXBvcnRlcik7XHJcbiAgICAgICAgY29uc3QgYWN0aXZlID0gcmVjb3ZlcmVkLmZpbHRlcigocmVzdWx0KSA9PiByZXN1bHQuc3RhdHVzID09PSAnYWN0aXZlLW93bmVyJyk7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDmo4DmtYvliLAgJHthY3RpdmUubGVuZ3RofSDkuKrku43nlLHmtLvliqjov5vnqIvmjIHmnInnmoQgUm91bmQtdHJpcCDkuovliqHvvIzmmoLml7bnpoHmraIgUGFpci9BcHBseeOAgmBcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBgUm91bmQtdHJpcCDlkK/liqjmgaLlpI3lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbn1cclxuIl19