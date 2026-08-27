"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
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
        nineSlice: false,
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
                nineSlice: false,
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
    const gradients = [];
    const visit = (node) => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') {
            return;
        }
        if (node.type === 'TEXT') {
            node.children.forEach(visit);
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
                png.push(node);
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
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return { png, tiled, gradients };
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
    const total = requests.png.length + requests.tiled.length + requests.gradients.length;
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
            const borders = decision.nineSlice && format === 'png'
                ? (_c = (0, slicing_1.analyzeSliceGrid)(node, importSettings.scale)) === null || _c === void 0 ? void 0 : _c.borders
                : undefined;
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
            if (!localMatch && existing && !borders) {
                completeGroup(groupedNodes, existing, 'existing');
                continue;
            }
            const key = {
                fileKey: session.fileKey,
                nodeId: node.id,
                format,
                scale: importSettings.scale,
            };
            const cached = localMatch || importSettings.refreshAssets
                ? null
                : await cache.read(key);
            pending.push({
                node,
                nodes: groupedNodes,
                url,
                borders,
                key,
                contents: (_d = localMatch === null || localMatch === void 0 ? void 0 : localMatch.contents) !== null && _d !== void 0 ? _d : cached,
                source: localMatch ? 'local' : cached ? 'cache' : 'figma',
            });
        }
        const remoteNodes = pending.filter((item) => !item.contents).map((item) => item.node);
        const urls = remoteNodes.length
            ? await (await getApi()).getImageUrls(session.fileKey, remoteNodes.map((node) => node.id), format, importSettings.scale)
            : {};
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
            completeGroup(item.nodes, await writer.write(item.url, contents, item.borders), item.source);
        }
    };
    await processTiled(requests.tiled);
    await processRemote(requests.png);
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
    return assets;
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
function makeSpec(node, parentFrame, decisions, plans, nodeById, assets, fonts, isRoot = false) {
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
                .map((child) => makeSpec(child, frame, decisions, plans, nodeById, assets, fonts, false))
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
        const assets = await buildAssets(activeDocument, decisions, importSettings);
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
            emitProgress({
                phase: 'done',
                value: 1,
                message: `完成：新建 ${result.created}，更新 ${result.updated}，已打开预制体 ${prefabUrl}`,
            });
            return result;
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
        emitProgress({
            phase: 'done',
            value: 1,
            message: `完成：新建 ${result.created}，更新 ${result.updated}`,
        });
        return result;
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
        if (!(activeDocument === null || activeDocument === void 0 ? void 0 : activeDocument.nodeById.has(nodeId))) {
            throw new Error('预览节点不存在。');
        }
        beginOperation();
        try {
            const urls = await (await client()).getImageUrls(activeDocument.fileKey, [nodeId], 'png', 1);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tYWluLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7OztBQXNhQSxrQ0F5QkM7QUFFRCxnRUFTQztBQWlrQkQsNEJBa0dDO0FBdzNCRCxvQkFZQztBQUVELHdCQUlDO0FBdi9ERCwrQkFBOEU7QUFDOUUsMkJBQWdDO0FBQ2hDLG1DQUFxQztBQUNyQywwQ0FBZ0Q7QUFDaEQsbUVBQTBDO0FBQzFDLDJDQUE4RTtBQUM5RSwrQ0FRMEI7QUFDMUIsMkNBQStDO0FBQy9DLDJEQUdnQztBQUNoQyw2Q0FBbUQ7QUFDbkQscUNBQStDO0FBQy9DLHFEQUkwQjtBQUMxQiw4Q0FPMkI7QUFDM0IsNENBQXVFO0FBRXZFLGdFQUFrRTtBQUNsRSx3Q0FBNkM7QUFDN0Msd0RBWWdDO0FBQ2hDLHdEQUFvRDtBQUNwRCxpREFBdUQ7QUFDdkQsbURBQXNFO0FBQ3RFLHlEQUEyRDtBQUMzRCxtQ0FtQmlCO0FBQ2pCLDJDQUErQztBQUUvQyxNQUFNLEtBQUssR0FBRyxJQUFJLHdCQUFVLENBQUMsc0JBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMvQyxJQUFJLGNBQWMsR0FBMkIsSUFBSSxDQUFDO0FBQ2xELElBQUksZ0JBQWdCLEdBQTJCLElBQUksQ0FBQztBQUNwRCxJQUFJLG1CQUFtQixHQUEyQixJQUFJLENBQUM7QUFDdkQsSUFBSSxhQUFhLEdBQTBCLElBQUksQ0FBQztBQUNoRCxJQUFJLHdCQUF3QixHQUFrQixJQUFJLENBQUM7QUE2Q25ELE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDN0UsTUFBTSxVQUFVLEdBQUcsSUFBSSxHQUFHLENBQVc7SUFDakMsTUFBTTtJQUNOLE1BQU07SUFDTixRQUFRO0lBQ1IsT0FBTztJQUNQLFVBQVU7SUFDVixRQUFRO0lB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LCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IHJlYWRGaWxlLCByZWFkZGlyIH0gZnJvbSAnZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgRmlnbWFDbGllbnQsIENhbmNlbGxlZEVycm9yLCBjbGFtcEltYWdlU2NhbGUgfSBmcm9tICcuL2ZpZ21hL2NsaWVudCc7XHJcbmltcG9ydCB7XG4gICAgaGFzSGlkZGVuRGVzY2VuZGFudCxcbiAgICBpbmZlckFjdGlvbixcbiAgICBpbmZlckNvY29zTGF5b3V0TW9kZSxcclxuICAgIGluZmVyS2luZCxcclxuICAgIGlzVmVjdG9yTm9kZSxcclxuICAgIG5hdGl2ZVRpbGVkUGFpbnRTb3VyY2UsXHJcbiAgICB0eXBlIFRpbGVkUGFpbnRTb3VyY2UsXHJcbn0gZnJvbSAnLi9maWdtYS9hbmFseXplcic7XHJcbmltcG9ydCB7IHBhcnNlRG9jdW1lbnQgfSBmcm9tICcuL2ZpZ21hL3BhcnNlcic7XHJcbmltcG9ydCB7XHJcbiAgICBhbm5vdGF0ZVRyZWVXaXRoSW1wb3J0UGxhbixcclxuICAgIGNvbXBpbGVJbXBvcnRQbGFuLFxyXG59IGZyb20gJy4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBhbmFseXplU2xpY2VHcmlkIH0gZnJvbSAnLi9maWdtYS9zbGljaW5nJztcclxuaW1wb3J0IHsgcGFyc2VGaWdtYVNvdXJjZSB9IGZyb20gJy4vZmlnbWEvdXJsJztcclxuaW1wb3J0IHtcclxuICAgIGlzVGVybWluYWxBY3Rpb24sXHJcbiAgICBraW5kRm9ySW1wb3J0QWN0aW9uLFxyXG4gICAgbm9ybWFsaXplSW1wb3J0QWN0aW9uLFxyXG59IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQge1xyXG4gICAgQXNzZXRXcml0ZXIsXHJcbiAgICBSQVNURVJfSU1BR0VfRVhURU5TSU9OUyxcclxuICAgIGRldGVjdEltYWdlRXh0ZW5zaW9uLFxyXG4gICAgcmVzb2x2ZUFzc2V0VXVpZCxcclxuICAgIHNhbml0aXplQXNzZXROYW1lLFxyXG4gICAgdHlwZSBSYXN0ZXJJbWFnZUV4dGVuc2lvbixcclxufSBmcm9tICcuL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB7IExvY2FsQXNzZXRDYWNoZSwgdHlwZSBDYWNoZUVudHJ5S2V5IH0gZnJvbSAnLi9pbXBvcnRlci9jYWNoZSc7XHJcbmltcG9ydCB0eXBlIHsgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IExvY2FsUmVzb3VyY2VMaWJyYXJ5IH0gZnJvbSAnLi9pbXBvcnRlci9sb2NhbC1yZXNvdXJjZXMnO1xyXG5pbXBvcnQgeyBncmFkaWVudFBuZyB9IGZyb20gJy4vaW1wb3J0ZXIvc3ZnJztcclxuaW1wb3J0IHtcclxuICAgIGNvbGxlY3RTY2VuZVNwZWNGaWdtYUlkcyxcclxuICAgIGNyZWF0ZU1pbmltYWxQcmVmYWJKc29uLFxyXG4gICAgY3JlYXRlUHJlZmFiU3luY1JlY29yZCxcclxuICAgIGZpZ21hRnJhbWVTb3VyY2VIYXNoLFxyXG4gICAgbWVyZ2VQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcGxhblByZWZhYlJlY292ZXJ5VGFyZ2V0LFxyXG4gICAgcHJlZmFiSnNvbkNvbnRhaW5zU3luY1JlY29yZCxcclxuICAgIHJlYWRQcmVmYWJTeW5jUmVjb3JkLFxyXG4gICAgcmVjb3JkUHJlZmFiU3luY0NhcHR1cmUsXHJcbiAgICByZXNvbHZlRXhpc3RpbmdOb2RlRmlsZUlkcyxcclxuICAgIHR5cGUgUHJlZmFiU3luY1JlY29yZCxcclxufSBmcm9tICcuL2ltcG9ydGVyL3ByZWZhYi1zeW5jJztcclxuaW1wb3J0IHsgVG9rZW5WYXVsdCB9IGZyb20gJy4vc2VjdXJpdHkvdG9rZW4tdmF1bHQnO1xyXG5pbXBvcnQgeyBSb3VuZHRyaXBTZXJ2aWNlIH0gZnJvbSAnLi9yb3VuZHRyaXAvc2VydmljZSc7XHJcbmltcG9ydCB7IHJlY292ZXJJbnRlcnJ1cHRlZFRyYW5zYWN0aW9ucyB9IGZyb20gJy4vcm91bmR0cmlwL3JlY292ZXJ5JztcclxuaW1wb3J0IHsgZWRpdG9yUmVpbXBvcnRlciB9IGZyb20gJy4vcm91bmR0cmlwL3RyYW5zYWN0aW9uJztcclxuaW1wb3J0IHtcclxuICAgIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgICB0eXBlIERvY3VtZW50U2Vzc2lvbixcclxuICAgIHR5cGUgRmlnbWFOb2RlLFxyXG4gICAgdHlwZSBJbXBvcnRBY3Rpb24sXHJcbiAgICB0eXBlIEltcG9ydERlY2lzaW9uLFxyXG4gICAgdHlwZSBJbXBvcnRPdmVycmlkZSxcclxuICAgIHR5cGUgSW1wb3J0UmVxdWVzdCxcclxuICAgIHR5cGUgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICB0eXBlIE5vZGVLaW5kLFxyXG4gICAgdHlwZSBOb2RlSW1wb3J0UGxhbixcclxuICAgIHR5cGUgUHJlZmFiRWRpdGluZ1N0YXRlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDYXB0dXJlLFxyXG4gICAgdHlwZSBQcmVmYWJTY2VuZVN5bmNDb250ZXh0LFxyXG4gICAgdHlwZSBQcm9ncmVzc0V2ZW50LFxyXG4gICAgdHlwZSBSZWN0LFxyXG4gICAgdHlwZSBTY2VuZU5vZGVTcGVjLFxyXG4gICAgdHlwZSBTcHJpdGVBc3NldFNwZWMsXHJcbiAgICB0eXBlIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5cclxuY29uc3QgdmF1bHQgPSBuZXcgVG9rZW5WYXVsdChwYWNrYWdlSlNPTi5uYW1lKTtcclxubGV0IGFjdGl2ZURvY3VtZW50OiBEb2N1bWVudFNlc3Npb24gfCBudWxsID0gbnVsbDtcclxubGV0IGFjdGl2ZUNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwQ29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbmxldCBzZXR0aW5nc0NhY2hlOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuXHJcbnR5cGUgRGVjaXNpb24gPSBJbXBvcnREZWNpc2lvbjtcclxuXHJcbmludGVyZmFjZSBUaWxlZEFzc2V0UmVxdWVzdCB7XHJcbiAgICBub2RlOiBGaWdtYU5vZGU7XHJcbiAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbn1cclxuXHJcbmludGVyZmFjZSBTY2VuZUltcG9ydFBheWxvYWQge1xyXG4gICAgcGFja2FnZU5hbWU6IHN0cmluZztcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIHJvb3ROYW1lOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgdXBkYXRlRXhpc3Rpbmc6IGJvb2xlYW47XHJcbiAgICBleGlzdGluZ01hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHByZWZhYlVybD86IHN0cmluZztcclxuICAgIGNlbnRlckluQ2FudmFzPzogYm9vbGVhbjtcclxuICAgIHByZWZhYkNvbnRleHQ/OiBQcmVmYWJTY2VuZVN5bmNDb250ZXh0O1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFNjZW5lSW1wb3J0UmVzdWx0IHtcclxuICAgIHJvb3RVdWlkOiBzdHJpbmc7XHJcbiAgICBub2RlTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgY3JlYXRlZDogbnVtYmVyO1xyXG4gICAgdXBkYXRlZDogbnVtYmVyO1xyXG4gICAgdGVtcG9yYXJ5Um9vdD86IGJvb2xlYW47XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICBwcmVmYWJTeW5jPzogUHJlZmFiU2NlbmVTeW5jQ2FwdHVyZTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFByZWZhYkFzc2V0SW5mbyB7XHJcbiAgICB1dWlkOiBzdHJpbmc7XHJcbiAgICB1cmw6IHN0cmluZztcclxuICAgIGltcG9ydGVyOiBzdHJpbmc7XHJcbiAgICB0eXBlOiBzdHJpbmc7XHJcbiAgICBpbXBvcnRlZDogYm9vbGVhbjtcclxuICAgIGludmFsaWQ6IGJvb2xlYW47XHJcbiAgICBpc0RpcmVjdG9yeT86IGJvb2xlYW47XHJcbiAgICByZWFkb25seT86IGJvb2xlYW47XHJcbiAgICByZWRpcmVjdD86IHVua25vd247XHJcbn1cclxuXHJcbmNvbnN0IEZPTlRfRVhURU5TSU9OUyA9IG5ldyBTZXQoWycudHRmJywgJy5vdGYnLCAnLmZudCcsICcud29mZicsICcud29mZjInXSk7XHJcbmNvbnN0IE5PREVfS0lORFMgPSBuZXcgU2V0PE5vZGVLaW5kPihbXHJcbiAgICAnYXV0bycsXHJcbiAgICAnbm9kZScsXHJcbiAgICAnc3ByaXRlJyxcclxuICAgICdsYWJlbCcsXHJcbiAgICAncmljaFRleHQnLFxyXG4gICAgJ2J1dHRvbicsXHJcbiAgICAnc2Nyb2xsVmlldycsXHJcbiAgICAnbGF5b3V0JyxcclxuXSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBsaXN0Rm9udEFzc2V0cygpOiBQcm9taXNlPEZvbnRBc3NldE9wdGlvbltdPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBmb250czogRm9udEFzc2V0T3B0aW9uW10gPSBbXTtcclxuICAgIGFzeW5jIGZ1bmN0aW9uIHZpc2l0KGZvbGRlcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgbGV0IGVudHJpZXM7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZW50cmllcyA9IGF3YWl0IHJlYWRkaXIoZm9sZGVyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XHJcbiAgICAgICAgICAgIGlmIChlbnRyeS5uYW1lID09PSAnbm9kZV9tb2R1bGVzJyB8fCBlbnRyeS5uYW1lID09PSAnbGlicmFyeScgfHwgZW50cnkubmFtZSA9PT0gJ3RlbXAnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZm9sZGVyLCBlbnRyeS5uYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHZpc2l0KGZpbGVQYXRoKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghRk9OVF9FWFRFTlNJT05TLmhhcyhleHRuYW1lKGVudHJ5Lm5hbWUpLnRvTG93ZXJDYXNlKCkpKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgZmlsZVBhdGgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuICAgICAgICAgICAgZm9udHMucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShlbnRyeS5uYW1lLCBleHRuYW1lKGVudHJ5Lm5hbWUpKSxcclxuICAgICAgICAgICAgICAgIHVybDogYGRiOi8vYXNzZXRzLyR7cGF0aH1gLFxyXG4gICAgICAgICAgICAgICAgcmVsYXRpdmVQYXRoOiBwYXRoLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBhd2FpdCB2aXNpdChhc3NldHNSb290KTtcclxuICAgIHJldHVybiBmb250cy5zb3J0KChhLCBiKSA9PiBhLnJlbGF0aXZlUGF0aC5sb2NhbGVDb21wYXJlKGIucmVsYXRpdmVQYXRoLCAnemgtQ04nKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVtaXRQcm9ncmVzcyhwcm9ncmVzczogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgRWRpdG9yLk1lc3NhZ2Uuc2VuZChwYWNrYWdlSlNPTi5uYW1lLCAncHJvZ3Jlc3MnLCBwcm9ncmVzcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHRDYWNoZUZvbGRlcigpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oRWRpdG9yLlByb2plY3QudG1wRGlyLCBwYWNrYWdlSlNPTi5uYW1lLCAnYXNzZXQtY2FjaGUnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZVNldHRpbmdzKHZhbHVlOiB1bmtub3duKTogSW1wb3J0U2V0dGluZ3Mge1xyXG4gICAgY29uc3QgaW5wdXQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnXHJcbiAgICAgICAgPyB2YWx1ZSBhcyBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPlxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCBzY2FsZSA9IHR5cGVvZiBpbnB1dC5zY2FsZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGlucHV0LnNjYWxlKVxyXG4gICAgICAgID8gTWF0aC5tYXgoMC4yNSwgTWF0aC5taW4oNCwgaW5wdXQuc2NhbGUpKVxyXG4gICAgICAgIDogREVGQVVMVF9TRVRUSU5HUy5zY2FsZTtcclxuICAgIGNvbnN0IGZvbnRNYXAgPSBpbnB1dC5mb250TWFwICYmIHR5cGVvZiBpbnB1dC5mb250TWFwID09PSAnb2JqZWN0J1xyXG4gICAgICAgID8gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGlucHV0LmZvbnRNYXApXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKFtrZXksIGl0ZW1dKSA9PiBrZXkudHJpbSgpICYmIHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJylcclxuICAgICAgICAgICAgLm1hcCgoW2tleSwgaXRlbV0pID0+IFtrZXkudHJpbSgpLCBpdGVtLnRyaW0oKV0pKVxyXG4gICAgICAgIDoge307XHJcbiAgICBjb25zdCByYXdMb2NhbEZvbGRlcnMgPSBBcnJheS5pc0FycmF5KGlucHV0LmxvY2FsUmVzb3VyY2VGb2xkZXJzKVxyXG4gICAgICAgID8gaW5wdXQubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICA6IHR5cGVvZiBpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICA/IFtpbnB1dC5sb2NhbFJlc291cmNlRm9sZGVyXVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZUZvbGRlcnMgPSByYXdMb2NhbEZvbGRlcnNcclxuICAgICAgICAuZmlsdGVyKChmb2xkZXIpOiBmb2xkZXIgaXMgc3RyaW5nID0+IHR5cGVvZiBmb2xkZXIgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgIC5tYXAoKGZvbGRlcikgPT4gZm9sZGVyLnRyaW0oKSlcclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmZpbHRlcigoZm9sZGVyLCBpbmRleCwgZm9sZGVycykgPT4gZm9sZGVycy5pbmRleE9mKGZvbGRlcikgPT09IGluZGV4KVxyXG4gICAgICAgIC5zbGljZSgwLCAzKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiB0eXBlb2YgaW5wdXQuc291cmNlVXJsID09PSAnc3RyaW5nJyA/IGlucHV0LnNvdXJjZVVybC50cmltKCkgOiAnJyxcclxuICAgICAgICBhc3NldEZvbGRlcjogdHlwZW9mIGlucHV0LmFzc2V0Rm9sZGVyID09PSAnc3RyaW5nJyAmJiBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5hc3NldEZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogdHlwZW9mIGlucHV0LnByZWZhYkZvbGRlciA9PT0gJ3N0cmluZycgJiYgaW5wdXQucHJlZmFiRm9sZGVyLnRyaW0oKVxyXG4gICAgICAgICAgICA/IGlucHV0LnByZWZhYkZvbGRlci50cmltKClcclxuICAgICAgICAgICAgOiBERUZBVUxUX1NFVFRJTkdTLnByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVycyxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiBsb2NhbFJlc291cmNlRm9sZGVyc1swXSA/PyAnJyxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogaW5wdXQudXBkYXRlRXhpc3RpbmcgIT09IGZhbHNlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGlucHV0LnJlZnJlc2hBc3NldHMgPT09IHRydWUsXHJcbiAgICAgICAgYXV0b1NhdmU6IGlucHV0LmF1dG9TYXZlID09PSB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBpZiAoc2V0dGluZ3NDYWNoZSkge1xyXG4gICAgICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdzZXR0aW5ncycsICdwcm9qZWN0Jyk7XHJcbiAgICBzZXR0aW5nc0NhY2hlID0gc2FmZVNldHRpbmdzKHNhdmVkKTtcclxuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICBzZXR0aW5nc0NhY2hlID0gc2FmZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ3NldHRpbmdzJywgc2V0dGluZ3NDYWNoZSwgJ3Byb2plY3QnKTtcclxuICAgIHJldHVybiBzZXR0aW5nc0NhY2hlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBjbGllbnQoc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCA9IGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbCk6IFByb21pc2U8RmlnbWFDbGllbnQ+IHtcclxuICAgIHJldHVybiBuZXcgRmlnbWFDbGllbnQoYXdhaXQgdmF1bHQuZ2V0KCksIHNpZ25hbCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJvdW5kdHJpcFNlcnZpY2Uoc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPFJvdW5kdHJpcFNlcnZpY2U+IHtcclxuICAgIGNvbnN0IGNyZWF0b3JWZXJzaW9uID0gKEVkaXRvci5BcHAgYXMgdW5rbm93biBhcyB7IHZlcnNpb24/OiBzdHJpbmcgfSkudmVyc2lvbiA/PyAndW5rbm93bic7XHJcbiAgICByZXR1cm4gbmV3IFJvdW5kdHJpcFNlcnZpY2Uoe1xyXG4gICAgICAgIGNsaWVudDogYXdhaXQgY2xpZW50KHNpZ25hbCksXHJcbiAgICAgICAgcHJvamVjdFJvb3Q6IEVkaXRvci5Qcm9qZWN0LnBhdGgsXHJcbiAgICAgICAgY3JlYXRvclZlcnNpb24sXHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmVnaW5Sb3VuZHRyaXBPcGVyYXRpb24oKTogQWJvcnRDb250cm9sbGVyIHtcclxuICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG4gICAgcm91bmR0cmlwQ29udHJvbGxlciA9IGNvbnRyb2xsZXI7XHJcbiAgICByZXR1cm4gY29udHJvbGxlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXI6IEFib3J0Q29udHJvbGxlcik6IHZvaWQge1xyXG4gICAgaWYgKHJvdW5kdHJpcENvbnRyb2xsZXIgPT09IGNvbnRyb2xsZXIpIHJvdW5kdHJpcENvbnRyb2xsZXIgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiZWdpbk9wZXJhdGlvbigpOiB2b2lkIHtcclxuICAgIGFjdGl2ZUNvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hPcGVyYXRpb24oKTogdm9pZCB7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyID0gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVsYXRpdmVBc3NldEZvbGRlcihzZWxlY3RlZFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc29sdmUoc2VsZWN0ZWRQYXRoKTtcclxuICAgIGNvbnN0IGZvbGRlciA9IHJlbGF0aXZlKGFzc2V0c1Jvb3QsIHNlbGVjdGVkKTtcclxuICAgIGlmICghZm9sZGVyIHx8IGZvbGRlciA9PT0gJy4nIHx8IGZvbGRlci5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUoZm9sZGVyKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6LWE5rqQ6L6T5Ye655uu5b2V5b+F6aG75piv6aG555uuIGFzc2V0cyDkuIvnmoTlrZDmlofku7blpLnjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NldERhdGFiYXNlVXJsKGZpbGVQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gcmVzb2x2ZShmaWxlUGF0aCk7XHJcbiAgICBjb25zdCBwYXRoID0gcmVsYXRpdmUoYXNzZXRzUm9vdCwgc2VsZWN0ZWQpO1xyXG4gICAgY29uc3Qgb3V0c2lkZSA9IHBhdGggPT09ICcuLidcclxuICAgICAgICB8fCBwYXRoLnN0YXJ0c1dpdGgoJy4uLycpXHJcbiAgICAgICAgfHwgcGF0aC5zdGFydHNXaXRoKCcuLlxcXFwnKVxyXG4gICAgICAgIHx8IGlzQWJzb2x1dGUocGF0aCk7XHJcbiAgICBpZiAoIXBhdGggfHwgcGF0aCA9PT0gJy4nIHx8IG91dHNpZGUpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBgZGI6Ly9hc3NldHMvJHtwYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKX1gO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrQXNzZXRGb2xkZXIoY3VycmVudDogdW5rbm93bik6IFByb21pc2U8e1xyXG4gICAgZm9sZGVyOiBzdHJpbmc7XHJcbiAgICBhYnNvbHV0ZVBhdGg6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGFzc2V0c1Jvb3QgPSByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsICdhc3NldHMnKTtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZydcclxuICAgICAgICA/IGN1cnJlbnQudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eYXNzZXRzXFwvKy8sICcnKVxyXG4gICAgICAgIDogJyc7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRQYXRoID0gY3VycmVudEZvbGRlciAmJiAhY3VycmVudEZvbGRlci5zdGFydHNXaXRoKCcuLicpXHJcbiAgICAgICAgPyByZXNvbHZlKGFzc2V0c1Jvb3QsIGN1cnJlbnRGb2xkZXIpXHJcbiAgICAgICAgOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBleGlzdHNTeW5jKHByZWZlcnJlZFBhdGgpID8gcHJlZmVycmVkUGF0aCA6IGFzc2V0c1Jvb3Q7XHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuRGlhbG9nLnNlbGVjdCh7XHJcbiAgICAgICAgdGl0bGU6ICfpgInmi6kgRmlnbWEg5a+85YWl6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pOiBQcm9taXNlPHtcclxuICAgIGZvbGRlcjogc3RyaW5nO1xyXG4gICAgYWJzb2x1dGVQYXRoOiBzdHJpbmc7XHJcbn0gfCBudWxsPiB7XHJcbiAgICBjb25zdCBhc3NldHNSb290ID0gcmVzb2x2ZShFZGl0b3IuUHJvamVjdC5wYXRoLCAnYXNzZXRzJyk7XHJcbiAgICBjb25zdCBjdXJyZW50Rm9sZGVyID0gdHlwZW9mIGN1cnJlbnQgPT09ICdzdHJpbmcnXHJcbiAgICAgICAgPyBjdXJyZW50LnRyaW0oKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXmFzc2V0c1xcLysvLCAnJylcclxuICAgICAgICA6ICcnO1xyXG4gICAgY29uc3QgcHJlZmVycmVkUGF0aCA9IGN1cnJlbnRGb2xkZXIgJiYgIWN1cnJlbnRGb2xkZXIuc3RhcnRzV2l0aCgnLi4nKVxyXG4gICAgICAgID8gcmVzb2x2ZShhc3NldHNSb290LCBjdXJyZW50Rm9sZGVyKVxyXG4gICAgICAgIDogYXNzZXRzUm9vdDtcclxuICAgIGNvbnN0IGluaXRpYWxQYXRoID0gZXhpc3RzU3luYyhwcmVmZXJyZWRQYXRoKSA/IHByZWZlcnJlZFBhdGggOiBhc3NldHNSb290O1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBmb2xkZXI6IHJlbGF0aXZlQXNzZXRGb2xkZXIoc2VsZWN0ZWQpLFxyXG4gICAgICAgIGFic29sdXRlUGF0aDogcmVzb2x2ZShzZWxlY3RlZCksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50OiB1bmtub3duLCBfaW5kZXggPSAwKTogUHJvbWlzZTx7XHJcbiAgICBmb2xkZXI6IHN0cmluZztcclxufSB8IG51bGw+IHtcclxuICAgIGNvbnN0IGN1cnJlbnRGb2xkZXIgPSB0eXBlb2YgY3VycmVudCA9PT0gJ3N0cmluZycgPyBjdXJyZW50LnRyaW0oKSA6ICcnO1xyXG4gICAgY29uc3QgaW5pdGlhbFBhdGggPSBjdXJyZW50Rm9sZGVyICYmIGlzQWJzb2x1dGUoY3VycmVudEZvbGRlcilcclxuICAgICAgICA/IGN1cnJlbnRGb2xkZXJcclxuICAgICAgICA6IHJlc29sdmUoRWRpdG9yLlByb2plY3QucGF0aCwgJ2Fzc2V0cycpO1xyXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgRWRpdG9yLkRpYWxvZy5zZWxlY3Qoe1xyXG4gICAgICAgIHRpdGxlOiAn6YCJ5oup5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VJyxcclxuICAgICAgICBwYXRoOiBpbml0aWFsUGF0aCxcclxuICAgICAgICB0eXBlOiAnZGlyZWN0b3J5JyxcclxuICAgICAgICBidXR0b246ICfpgInmi6nnm67lvZUnLFxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IHJlc3VsdC5maWxlUGF0aHNbMF07XHJcbiAgICBpZiAocmVzdWx0LmNhbmNlbGVkIHx8ICFzZWxlY3RlZCkge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGlicmFyeSA9IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShzZWxlY3RlZCk7XHJcbiAgICByZXR1cm4geyBmb2xkZXI6IGxpYnJhcnkucm9vdCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiB1bmlvbkZyYW1lKG5vZGVzOiBGaWdtYU5vZGVbXSk6IFJlY3Qge1xyXG4gICAgY29uc3QgZnJhbWVzID0gbm9kZXMubWFwKG5vZGVGcmFtZSkuZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIFJlY3QgPT4gQm9vbGVhbih2YWx1ZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgeCA9IE1hdGgubWluKC4uLmZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54KSk7XHJcbiAgICBjb25zdCB5ID0gTWF0aC5taW4oLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkpKTtcclxuICAgIGNvbnN0IHJpZ2h0ID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnggKyBmcmFtZS53aWR0aCkpO1xyXG4gICAgY29uc3QgYm90dG9tID0gTWF0aC5tYXgoLi4uZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQpKTtcclxuICAgIHJldHVybiB7IHgsIHksIHdpZHRoOiByaWdodCAtIHgsIGhlaWdodDogYm90dG9tIC0geSB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBub2RlRnJhbWUobm9kZTogRmlnbWFOb2RlKTogUmVjdCB7XHJcbiAgICBpZiAobm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUuYWJzb2x1dGVCb3VuZGluZ0JveDtcclxuICAgIH1cclxuICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgIHJldHVybiB1bmlvbkZyYW1lKG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb3JuZXJSYWRpaShub2RlOiBGaWdtYU5vZGUpOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXSB7XHJcbiAgICBpZiAobm9kZS5yZWN0YW5nbGVDb3JuZXJSYWRpaT8ubGVuZ3RoID09PSA0KSB7XHJcbiAgICAgICAgcmV0dXJuIG5vZGUucmVjdGFuZ2xlQ29ybmVyUmFkaWkgYXMgW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XHJcbiAgICB9XHJcbiAgICBjb25zdCByYWRpdXMgPSBub2RlLmNvcm5lclJhZGl1cyA/PyAwO1xyXG4gICAgcmV0dXJuIFtyYWRpdXMsIHJhZGl1cywgcmFkaXVzLCByYWRpdXNdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0RGVjaXNpb24obm9kZTogRmlnbWFOb2RlKTogRGVjaXNpb24ge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBhY3Rpb246IGluZmVyQWN0aW9uKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IGluZmVyS2luZChub2RlKSxcclxuICAgICAgICBuaW5lU2xpY2U6IGZhbHNlLFxyXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlY2lzaW9uRm9yTm9kZShub2RlOiBGaWdtYU5vZGUsIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+KTogRGVjaXNpb24ge1xyXG4gICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbnMuZ2V0KG5vZGUuaWQpID8/IGRlZmF1bHREZWNpc2lvbihub2RlKTtcclxuICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJyAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ2dlbmVyYXRlJywgbmluZVNsaWNlOiBmYWxzZSB9O1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVmVjdG9yTm9kZShub2RlKSAmJiBkZWNpc2lvbi5hY3Rpb24gIT09ICdpZ25vcmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgLi4uZGVjaXNpb24sIGFjdGlvbjogJ3JlbmRlcicsIG5pbmVTbGljZTogZmFsc2UgfTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGRlY2lzaW9uTWFwKG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSwgdHJlZTogVHJlZU5vZGVEdG9bXSk6IE1hcDxzdHJpbmcsIERlY2lzaW9uPiB7XHJcbiAgICBjb25zdCBkZWNpc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRGVjaXNpb24+KCk7XHJcbiAgICBjb25zdCBhZGREZWZhdWx0cyA9IChub2RlczogVHJlZU5vZGVEdG9bXSkgPT4ge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBkZWNpc2lvbnMuc2V0KG5vZGUuaWQsIHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKG5vZGUuYWN0aW9uKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBhZGREZWZhdWx0cyhub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgYWRkRGVmYXVsdHModHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygb3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgICAgICBkZWNpc2lvbnMuc2V0KGl0ZW0uaWQsIHtcclxuICAgICAgICAgICAgYWN0aW9uOiBub3JtYWxpemVJbXBvcnRBY3Rpb24oaXRlbS5hY3Rpb24pLFxyXG4gICAgICAgICAgICBraW5kOiBOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQpID8gaXRlbS5raW5kIDogJ2F1dG8nLFxyXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxyXG4gICAgICAgICAgICBleHBsaWNpdDogaXRlbS5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgLi4uKG5hbWUgPyB7IG5hbWUgfSA6IHt9KSxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiBkZWNpc2lvbnM7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdWJ0cmVlSGFzRXhwbGljaXRPdmVycmlkZShcclxuICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgIGRlY2lzaW9uczogUmVhZG9ubHlNYXA8c3RyaW5nLCBJbXBvcnREZWNpc2lvbj4sXHJcbiAgICBpbmNsdWRlTm9kZU5hbWUgPSB0cnVlLFxyXG4pOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKTtcclxuICAgIHJldHVybiBkZWNpc2lvbj8uZXhwbGljaXQgPT09IHRydWVcclxuICAgICAgICB8fCAoaW5jbHVkZU5vZGVOYW1lICYmIEJvb2xlYW4oZGVjaXNpb24/Lm5hbWUpKVxyXG4gICAgICAgIHx8IG5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IHN1YnRyZWVIYXNFeHBsaWNpdE92ZXJyaWRlKGNoaWxkLCBkZWNpc2lvbnMpKTtcclxufVxyXG5cclxudHlwZSBTdG9yZWROb2RlT3ZlcnJpZGVzID0gUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+PjtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKTogUHJvbWlzZTxTdG9yZWROb2RlT3ZlcnJpZGVzPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IEVkaXRvci5Qcm9maWxlLmdldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVPdmVycmlkZXMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBTdG9yZWROb2RlT3ZlcnJpZGVzIDoge307XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVOb2RlT3ZlcnJpZGUodmFsdWU6IHVua25vd24sIGZhbGxiYWNrSWQgPSAnJyk6IEltcG9ydE92ZXJyaWRlIHwgbnVsbCB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3QgaXRlbSA9IHZhbHVlIGFzIFBhcnRpYWw8SW1wb3J0T3ZlcnJpZGU+O1xyXG4gICAgY29uc3QgaWQgPSB0eXBlb2YgaXRlbS5pZCA9PT0gJ3N0cmluZycgJiYgaXRlbS5pZCA/IGl0ZW0uaWQgOiBmYWxsYmFja0lkO1xyXG4gICAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XHJcbiAgICBjb25zdCBraW5kID0gdHlwZW9mIGl0ZW0ua2luZCA9PT0gJ3N0cmluZycgJiYgTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKVxyXG4gICAgICAgID8gaXRlbS5raW5kIGFzIE5vZGVLaW5kXHJcbiAgICAgICAgOiAnYXV0byc7XHJcbiAgICBjb25zdCBleHBsaWNpdCA9IGl0ZW0uZXhwbGljaXQgPT09IGZhbHNlID8gZmFsc2UgOiB0cnVlO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcclxuICAgIGlmICghZXhwbGljaXQgJiYgIW5hbWUpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBpZCxcclxuICAgICAgICBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihpdGVtLmFjdGlvbiksXHJcbiAgICAgICAga2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlID09PSB0cnVlLFxyXG4gICAgICAgIGV4cGxpY2l0LFxyXG4gICAgICAgIC4uLihuYW1lID8geyBuYW1lIH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBub2RlT3ZlcnJpZGVzRm9yKGZpbGVLZXk6IHN0cmluZyk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgY29uc3Qgc3RvcmVkID0gKGF3YWl0IGdldFN0b3JlZE5vZGVPdmVycmlkZXMoKSlbZmlsZUtleV0gPz8ge307XHJcbiAgICBjb25zdCByZXN1bHQ6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgIGZvciAoY29uc3QgW2lkLCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmVkKSkge1xyXG4gICAgICAgIGNvbnN0IHNhZmUgPSBzYWZlTm9kZU92ZXJyaWRlKHZhbHVlLCBpZCk7XHJcbiAgICAgICAgaWYgKHNhZmUpIHJlc3VsdC5wdXNoKHNhZmUpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZU5vZGVPdmVycmlkZXMoXHJcbiAgICBmaWxlS2V5OiB1bmtub3duLFxyXG4gICAgdmFsdWVzOiB1bmtub3duLFxyXG4gICAgc2NvcGVWYWx1ZXM6IHVua25vd24sXHJcbik6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT4ge1xyXG4gICAgaWYgKHR5cGVvZiBmaWxlS2V5ICE9PSAnc3RyaW5nJyB8fCAhZmlsZUtleS50cmltKCkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+aXoOazleS/neWtmOiKgueCueetlueVpe+8mue8uuWwkSBGaWdtYSBmaWxlS2V544CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtcyA9IEFycmF5LmlzQXJyYXkodmFsdWVzKSA/IHZhbHVlcyA6IFtdO1xyXG4gICAgY29uc3Qgc2FmZUl0ZW1zID0gaXRlbXNcclxuICAgICAgICAubWFwKChpdGVtKSA9PiBzYWZlTm9kZU92ZXJyaWRlKGl0ZW0pKVxyXG4gICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIEltcG9ydE92ZXJyaWRlID0+IEJvb2xlYW4oaXRlbSkpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBuZXcgU2V0KFxyXG4gICAgICAgIChBcnJheS5pc0FycmF5KHNjb3BlVmFsdWVzKSA/IHNjb3BlVmFsdWVzIDogc2FmZUl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgQm9vbGVhbihpZCkpLFxyXG4gICAgKTtcclxuICAgIGlmICghc2NvcGVJZHMuc2l6ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5peg5rOV5L+d5a2Y6IqC54K5562W55Wl77ya57y65bCR5b2T5YmN5a+85YWl6IyD5Zu044CCJyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzY29wZWRJdGVtcyA9IHNhZmVJdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHNjb3BlSWRzLmhhcyhpdGVtLmlkKSk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBhd2FpdCBnZXRTdG9yZWROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc3RvcmVkW2ZpbGVLZXldID8/IHt9KSB9O1xyXG4gICAgZm9yIChjb25zdCBpZCBvZiBzY29wZUlkcykge1xyXG4gICAgICAgIGRlbGV0ZSBjdXJyZW50W2lkXTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzY29wZWRJdGVtcykge1xyXG4gICAgICAgIGN1cnJlbnRbaXRlbS5pZF0gPSBpdGVtO1xyXG4gICAgfVxyXG4gICAgaWYgKE9iamVjdC5rZXlzKGN1cnJlbnQpLmxlbmd0aCkge1xyXG4gICAgICAgIHN0b3JlZFtmaWxlS2V5XSA9IGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGRlbGV0ZSBzdG9yZWRbZmlsZUtleV07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KHBhY2thZ2VKU09OLm5hbWUsICdub2RlT3ZlcnJpZGVzJywgc3RvcmVkLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNjb3BlZEl0ZW1zO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhbm5vdGF0ZURvY3VtZW50UGxhbihzZXNzaW9uOiBEb2N1bWVudFNlc3Npb24pOiBEb2N1bWVudFNlc3Npb24ge1xyXG4gICAgY29uc3QgZGVmYXVsdHMgPSBkZWNpc2lvbk1hcChbXSwgc2Vzc2lvbi50cmVlKTtcclxuICAgIHNlc3Npb24udHJlZSA9IGFubm90YXRlVHJlZVdpdGhJbXBvcnRQbGFuKFxyXG4gICAgICAgIHNlc3Npb24udHJlZSxcclxuICAgICAgICBjb21waWxlSW1wb3J0UGxhbihzZXNzaW9uLnJvb3RzLCBkZWZhdWx0cyksXHJcbiAgICApO1xyXG4gICAgcmV0dXJuIHNlc3Npb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbGxlY3RBc3NldFJlcXVlc3RzKFxyXG4gICAgcm9vdHM6IEZpZ21hTm9kZVtdLFxyXG4gICAgZGVjaXNpb25zOiBNYXA8c3RyaW5nLCBEZWNpc2lvbj4sXHJcbik6IHsgcG5nOiBGaWdtYU5vZGVbXTsgdGlsZWQ6IFRpbGVkQXNzZXRSZXF1ZXN0W107IGdyYWRpZW50czogRmlnbWFOb2RlW10gfSB7XHJcbiAgICBjb25zdCBwbmc6IEZpZ21hTm9kZVtdID0gW107XHJcbiAgICBjb25zdCB0aWxlZDogVGlsZWRBc3NldFJlcXVlc3RbXSA9IFtdO1xyXG4gICAgY29uc3QgZ3JhZGllbnRzOiBGaWdtYU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogRmlnbWFOb2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdURVhUJykge1xyXG4gICAgICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2godmlzaXQpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChkZWNpc2lvbi5uaW5lU2xpY2UpIHtcclxuICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcicpIHtcclxuICAgICAgICAgICAgY29uc3Qgc291cmNlID0gbmF0aXZlVGlsZWRQYWludFNvdXJjZShub2RlKTtcclxuICAgICAgICAgICAgaWYgKHNvdXJjZSkge1xyXG4gICAgICAgICAgICAgICAgdGlsZWQucHVzaCh7IG5vZGUsIHNvdXJjZSB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHBuZy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGRlY2lzaW9uLmFjdGlvbiA9PT0gJ2dlbmVyYXRlJykge1xyXG4gICAgICAgICAgICBjb25zdCBmaWxsID0gbm9kZS5maWxscy5maW5kKChpdGVtKSA9PiBpdGVtLnZpc2libGUgIT09IGZhbHNlICYmIGl0ZW0udHlwZS5zdGFydHNXaXRoKCdHUkFESUVOVF8nKSk7XHJcbiAgICAgICAgICAgIGlmIChmaWxsKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBncmFkaWVudHMucHVzaChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcG5nLnB1c2gobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKHZpc2l0KTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKHZpc2l0KTtcclxuICAgIHJldHVybiB7IHBuZywgdGlsZWQsIGdyYWRpZW50cyB9O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBidWlsZEFzc2V0cyhcclxuICAgIHNlc3Npb246IERvY3VtZW50U2Vzc2lvbixcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgaW1wb3J0U2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4pOiBQcm9taXNlPE1hcDxzdHJpbmcsIFNwcml0ZUFzc2V0U3BlYz4+IHtcclxuICAgIGNvbnN0IHdyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5hc3NldEZvbGRlcik7XHJcbiAgICBhd2FpdCB3cml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgY29uc3QgY2FjaGUgPSBuZXcgTG9jYWxBc3NldENhY2hlKGRlZmF1bHRDYWNoZUZvbGRlcigpKTtcclxuICAgIGF3YWl0IGNhY2hlLmluaXRpYWxpemUoKTtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VzID0gaW1wb3J0U2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICAubWFwKChmb2xkZXIpID0+IG5ldyBMb2NhbFJlc291cmNlTGlicmFyeShmb2xkZXIpKTtcclxuICAgIGF3YWl0IFByb21pc2UuYWxsKGxvY2FsUmVzb3VyY2VzLm1hcCgobGlicmFyeSkgPT4gbGlicmFyeS5pbml0aWFsaXplKCkpKTtcclxuICAgIGNvbnN0IHByb21vdGVMb2NhbFBhcmVudHMgPSBhc3luYyAobm9kZTogRmlnbWFOb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb24gPSBkZWNpc2lvbkZvck5vZGUobm9kZSwgZGVjaXNpb25zKTtcclxuICAgICAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAmJiBub2RlLnR5cGUgIT09ICdURVhUJ1xyXG4gICAgICAgICAgICAvLyBSZW5hbWluZyB0aGlzIGNvbnRhaW5lciBkb2VzIG5vdCBjaGFuZ2UgcmVzb3VyY2UgbWF0Y2hpbmc7IG9ubHlcclxuICAgICAgICAgICAgLy8gYSBzdHJhdGVneSBvdmVycmlkZSBvbiBpdHNlbGYgb3IgYW55IG92ZXJyaWRlIGJlbG93IGl0IGJsb2Nrc1xyXG4gICAgICAgICAgICAvLyBwcm9tb3Rpb24gYmVjYXVzZSBkZXNjZW5kYW50cyB3b3VsZCBvdGhlcndpc2UgZGlzYXBwZWFyLlxyXG4gICAgICAgICAgICAmJiAhc3VidHJlZUhhc0V4cGxpY2l0T3ZlcnJpZGUobm9kZSwgZGVjaXNpb25zLCBmYWxzZSlcbiAgICAgICAgICAgIC8vIEEgbG9jYWwgcGFyZW50IHJlc291cmNlIGNhbm5vdCByZXByZXNlbnQgaW5kZXBlbmRlbnRseSBpbmFjdGl2ZVxuICAgICAgICAgICAgLy8gZGVzY2VuZGFudHMuIEtlZXAgdGhlIGhpZXJhcmNoeSB3aGVuZXZlciBzdWNoIGEgYm91bmRhcnkgZXhpc3RzLlxuICAgICAgICAgICAgJiYgIWhhc0hpZGRlbkRlc2NlbmRhbnQobm9kZSkpIHtcbiAgICAgICAgICAgIGxldCBsb2NhbE1hdGNoID0gbnVsbDtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgICAgICBsb2NhbE1hdGNoID0gYXdhaXQgbGlicmFyeS5maW5kKG5vZGUubmFtZSwgJ3BuZycpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsTWF0Y2gpIHtcclxuICAgICAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAobG9jYWxNYXRjaCkge1xyXG4gICAgICAgICAgICAgICAgZGVjaXNpb25zLnNldChub2RlLmlkLCB7IC4uLmRlY2lzaW9uLCBhY3Rpb246ICdyZW5kZXInLCBuaW5lU2xpY2U6IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IFByb21pc2UuYWxsKG5vZGUuY2hpbGRyZW4ubWFwKHByb21vdGVMb2NhbFBhcmVudHMpKTtcclxuICAgIH07XHJcbiAgICBhd2FpdCBQcm9taXNlLmFsbChzZXNzaW9uLnJvb3RzLm1hcChwcm9tb3RlTG9jYWxQYXJlbnRzKSk7XHJcbiAgICBjb25zdCByZXF1ZXN0cyA9IGNvbGxlY3RBc3NldFJlcXVlc3RzKHNlc3Npb24ucm9vdHMsIGRlY2lzaW9ucyk7XHJcbiAgICBjb25zdCBhc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgY29uc3QgdG90YWwgPSByZXF1ZXN0cy5wbmcubGVuZ3RoICsgcmVxdWVzdHMudGlsZWQubGVuZ3RoICsgcmVxdWVzdHMuZ3JhZGllbnRzLmxlbmd0aDtcclxuICAgIGxldCBjb21wbGV0ZWQgPSAwO1xyXG4gICAgbGV0IGFwaVByb21pc2U6IFByb21pc2U8RmlnbWFDbGllbnQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgZ2V0QXBpID0gKCkgPT4ge1xyXG4gICAgICAgIGFwaVByb21pc2UgPz89IGNsaWVudCgpO1xyXG4gICAgICAgIHJldHVybiBhcGlQcm9taXNlO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBjb21wbGV0ZUFzc2V0ID0gKFxyXG4gICAgICAgIG5vZGU6IEZpZ21hTm9kZSxcclxuICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgIHNvdXJjZTogJ2V4aXN0aW5nJyB8ICdsb2NhbCcgfCAnY2FjaGUnIHwgJ2ZpZ21hJyB8ICdnZW5lcmF0ZWQnID0gJ2ZpZ21hJyxcclxuICAgICkgPT4ge1xyXG4gICAgICAgIGFzc2V0cy5zZXQobm9kZS5pZCwgYXNzZXQpO1xyXG4gICAgICAgIGNvbXBsZXRlZCArPSAxO1xyXG4gICAgICAgIGNvbnN0IHZlcmIgPSBzb3VyY2UgPT09ICdsb2NhbCdcclxuICAgICAgICAgICAgPyAn5aSN55So5pys5Zyw6LWE5rqQJ1xyXG4gICAgICAgICAgICA6IHNvdXJjZSA9PT0gJ2V4aXN0aW5nJ1xyXG4gICAgICAgICAgICAgICAgPyAn5aSN55So5bey5pyJ6LWE5rqQJ1xyXG4gICAgICAgICAgICAgICAgOiBzb3VyY2UgPT09ICdnZW5lcmF0ZWQnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAn55Sf5oiQ5riQ5Y+YJ1xyXG4gICAgICAgICAgICAgICAgOiAn5a+85YWl6LWE5rqQJztcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYCR7dmVyYn0gJHtjb21wbGV0ZWR9LyR7dG90YWx9IMK3ICR7bm9kZS5uYW1lfWAsXHJcbiAgICAgICAgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHByb2Nlc3NUaWxlZCA9IGFzeW5jIChpdGVtczogVGlsZWRBc3NldFJlcXVlc3RbXSkgPT4ge1xyXG4gICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaW50ZXJmYWNlIFRpbGVHcm91cCB7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2U7XHJcbiAgICAgICAgICAgIHNvdXJjZUtleTogc3RyaW5nO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbnRlcmZhY2UgUGVuZGluZ1RpbGUgZXh0ZW5kcyBUaWxlR3JvdXAge1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgZXh0ZW5zaW9uPzogUmFzdGVySW1hZ2VFeHRlbnNpb247XHJcbiAgICAgICAgICAgIHNvdXJjZVR5cGU6ICdjYWNoZScgfCAnZmlnbWEnO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXF1ZXN0ZWRTY2FsZSA9IChzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpID0+IGltcG9ydFNldHRpbmdzLnNjYWxlICogc291cmNlLnNjYWxlO1xyXG4gICAgICAgIGNvbnN0IHJlbmRlclNjYWxlID0gKHNvdXJjZTogVGlsZWRQYWludFNvdXJjZSkgPT4gc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgPyBjbGFtcEltYWdlU2NhbGUocmVxdWVzdGVkU2NhbGUoc291cmNlKSlcclxuICAgICAgICAgICAgOiAxO1xyXG4gICAgICAgIGNvbnN0IHRpbGVBc3NldCA9IChhc3NldDogU3ByaXRlQXNzZXRTcGVjLCBzb3VyY2U6IFRpbGVkUGFpbnRTb3VyY2UpOiBTcHJpdGVBc3NldFNwZWMgPT4gKHtcclxuICAgICAgICAgICAgLi4uYXNzZXQsXHJcbiAgICAgICAgICAgIHRpbGVkOiB0cnVlLFxyXG4gICAgICAgICAgICB0aWxlU2NhbGU6IHJlcXVlc3RlZFNjYWxlKHNvdXJjZSkgLyByZW5kZXJTY2FsZShzb3VyY2UpLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IGdyb3VwcyA9IG5ldyBNYXA8c3RyaW5nLCBUaWxlR3JvdXA+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCB7IG5vZGUsIHNvdXJjZSB9IG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZUtleSA9IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHNvdXJjZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgaWQ6IHNvdXJjZS5pZCxcclxuICAgICAgICAgICAgICAgIHBhaW50U2NhbGU6IHNvdXJjZS5zY2FsZSxcclxuICAgICAgICAgICAgICAgIHJlbmRlclNjYWxlOiByZW5kZXJTY2FsZShzb3VyY2UpLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgY29uc3Qga2V5ID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwobm9kZS5uYW1lLCBzb3VyY2VLZXksICdwbmcnKVxyXG4gICAgICAgICAgICAgICAgLm5vcm1hbGl6ZSgnTkZLQycpXHJcbiAgICAgICAgICAgICAgICAudG9Mb2NhbGVMb3dlckNhc2UoJ2VuLVVTJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwID0gZ3JvdXBzLmdldChrZXkpID8/IHsgbm9kZSwgbm9kZXM6IFtdLCBzb3VyY2UsIHNvdXJjZUtleSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnY2FjaGUnIHwgJ2ZpZ21hJyxcclxuICAgICAgICApID0+IHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBncm91cGVkTm9kZSBvZiBncm91cGVkTm9kZXMpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlQXNzZXQoZ3JvdXBlZE5vZGUsIGFzc2V0LCBzb3VyY2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBQZW5kaW5nVGlsZVtdID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCBncm91cCBvZiBncm91cHMudmFsdWVzKCkpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdBc3NldDogU3ByaXRlQXNzZXRTcGVjIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBleHRlbnNpb24gb2YgUkFTVEVSX0lNQUdFX0VYVEVOU0lPTlMpIHtcclxuICAgICAgICAgICAgICAgICAgICBleGlzdGluZ0Fzc2V0ID0gYXdhaXQgd3JpdGVyLmV4aXN0aW5nKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB3cml0ZXIuYnVpbGRUaWxlZFVybChncm91cC5ub2RlLm5hbWUsIGdyb3VwLnNvdXJjZUtleSwgZXh0ZW5zaW9uKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ0Fzc2V0KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdBc3NldCkge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cC5ub2RlcywgdGlsZUFzc2V0KGV4aXN0aW5nQXNzZXQsIGdyb3VwLnNvdXJjZSksICdleGlzdGluZycpO1xyXG4gICAgICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgICAgICAgICAgbGV0IGNhY2hlZEV4dGVuc2lvbjogUmFzdGVySW1hZ2VFeHRlbnNpb24gfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmICghaW1wb3J0U2V0dGluZ3MucmVmcmVzaEFzc2V0cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgZXh0ZW5zaW9uczogcmVhZG9ubHkgUmFzdGVySW1hZ2VFeHRlbnNpb25bXSA9IGdyb3VwLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBbJ3BuZyddXHJcbiAgICAgICAgICAgICAgICAgICAgOiBSQVNURVJfSU1BR0VfRVhURU5TSU9OUztcclxuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgZXh0ZW5zaW9uIG9mIGV4dGVuc2lvbnMpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBjYWNoZS5yZWFkKHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZmlsZUtleTogc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7Z3JvdXAuc291cmNlS2V5fWAsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoZ3JvdXAuc291cmNlKSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoY2FjaGVkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gY2FjaGVkO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZWRFeHRlbnNpb24gPSBleHRlbnNpb247XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgLi4uZ3JvdXAsXHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyxcclxuICAgICAgICAgICAgICAgIGV4dGVuc2lvbjogY2FjaGVkRXh0ZW5zaW9uLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVHlwZTogY29udGVudHMgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCByZW1vdGVJdGVtcyA9IHBlbmRpbmcuZmlsdGVyKChpdGVtKSA9PiAhaXRlbS5jb250ZW50cyk7XHJcbiAgICAgICAgY29uc3QgcGF0dGVyblVybHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nIHwgbnVsbD4oKTtcclxuICAgICAgICBjb25zdCBwYXR0ZXJuc0J5U2NhbGUgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHJlbW90ZUl0ZW1zKSB7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLnNvdXJjZS5raW5kICE9PSAnc291cmNlLW5vZGUnKSB7XHJcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBzY2FsZSA9IHJlbmRlclNjYWxlKGl0ZW0uc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3QgaWRzID0gcGF0dGVybnNCeVNjYWxlLmdldChzY2FsZSkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgICAgIGlkcy5hZGQoaXRlbS5zb3VyY2UuaWQpO1xyXG4gICAgICAgICAgICBwYXR0ZXJuc0J5U2NhbGUuc2V0KHNjYWxlLCBpZHMpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IFtzY2FsZSwgaWRzXSBvZiBwYXR0ZXJuc0J5U2NhbGUpIHtcclxuICAgICAgICAgICAgY29uc3QgdXJscyA9IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgQXJyYXkuZnJvbShpZHMpLFxyXG4gICAgICAgICAgICAgICAgJ3BuZycsXHJcbiAgICAgICAgICAgICAgICBzY2FsZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbaWQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXModXJscykpIHtcclxuICAgICAgICAgICAgICAgIHBhdHRlcm5VcmxzLnNldChgJHtpZH06c2NhbGU6JHtzY2FsZX1gLCB1cmwpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5lZWRzSW1hZ2VGaWxscyA9IHJlbW90ZUl0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0uc291cmNlLmtpbmQgPT09ICdpbWFnZS1yZWYnKTtcclxuICAgICAgICBjb25zdCBpbWFnZUZpbGxVcmxzID0gbmVlZHNJbWFnZUZpbGxzXHJcbiAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5nZXRJbWFnZUZpbGxVcmxzKHNlc3Npb24uZmlsZUtleSlcclxuICAgICAgICAgICAgOiB7fTtcclxuICAgICAgICBjb25zdCBkb3dubG9hZHMgPSBuZXcgTWFwPHN0cmluZywgUHJvbWlzZTxCdWZmZXI+PigpO1xyXG4gICAgICAgIGNvbnN0IGRvd25sb2FkID0gKHVybDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgICAgIGxldCB0YXNrID0gZG93bmxvYWRzLmdldCh1cmwpO1xyXG4gICAgICAgICAgICBpZiAoIXRhc2spIHtcclxuICAgICAgICAgICAgICAgIHRhc2sgPSBnZXRBcGkoKS50aGVuKChhcGkpID0+IGFwaS5kb3dubG9hZCh1cmwpKTtcclxuICAgICAgICAgICAgICAgIGRvd25sb2Fkcy5zZXQodXJsLCB0YXNrKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gdGFzaztcclxuICAgICAgICB9O1xyXG4gICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nKSB7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgbGV0IGNvbnRlbnRzID0gaXRlbS5jb250ZW50cztcclxuICAgICAgICAgICAgbGV0IGV4dGVuc2lvbiA9IGl0ZW0uZXh0ZW5zaW9uO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyBwYXR0ZXJuVXJscy5nZXQoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2l0ZW0uc291cmNlLmlkfTpzY2FsZToke3JlbmRlclNjYWxlKGl0ZW0uc291cmNlKX1gLFxyXG4gICAgICAgICAgICAgICAgICAgIClcclxuICAgICAgICAgICAgICAgICAgICA6IGltYWdlRmlsbFVybHNbaXRlbS5zb3VyY2UuaWRdO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFyZW1vdGVVcmwpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0uc291cmNlLmtpbmQgPT09ICdzb3VyY2Utbm9kZSdcclxuICAgICAgICAgICAgICAgICAgICAgICAgPyBgUEFUVEVSTiDmupDoioLngrkgJHtpdGVtLnNvdXJjZS5pZH1gXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDogYElNQUdFIOWhq+WFhSAke2l0ZW0uc291cmNlLmlkfWA7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBGaWdtYSDmnKrog73mj5Dkvpske2xhYmVsfe+8miR7aXRlbS5ub2RlLm5hbWV9YCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBjb250ZW50cyA9IGF3YWl0IGRvd25sb2FkKHJlbW90ZVVybCk7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBpdGVtLnNvdXJjZS5raW5kID09PSAnc291cmNlLW5vZGUnXHJcbiAgICAgICAgICAgICAgICAgICAgPyAncG5nJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogZGV0ZWN0SW1hZ2VFeHRlbnNpb24oY29udGVudHMpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoe1xyXG4gICAgICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgICAgICBub2RlSWQ6IGB0aWxlOiR7aXRlbS5zb3VyY2VLZXl9YCxcclxuICAgICAgICAgICAgICAgICAgICBmb3JtYXQ6IGV4dGVuc2lvbixcclxuICAgICAgICAgICAgICAgICAgICBzY2FsZTogcmVuZGVyU2NhbGUoaXRlbS5zb3VyY2UpLFxyXG4gICAgICAgICAgICAgICAgfSwgY29udGVudHMpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghZXh0ZW5zaW9uKSB7XHJcbiAgICAgICAgICAgICAgICBleHRlbnNpb24gPSBkZXRlY3RJbWFnZUV4dGVuc2lvbihjb250ZW50cyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgdXJsID0gd3JpdGVyLmJ1aWxkVGlsZWRVcmwoaXRlbS5ub2RlLm5hbWUsIGl0ZW0uc291cmNlS2V5LCBleHRlbnNpb24pO1xyXG4gICAgICAgICAgICBjb21wbGV0ZUdyb3VwKFxyXG4gICAgICAgICAgICAgICAgaXRlbS5ub2RlcyxcclxuICAgICAgICAgICAgICAgIHRpbGVBc3NldChcclxuICAgICAgICAgICAgICAgICAgICBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBjb250ZW50cywgdW5kZWZpbmVkLCB0cnVlKSxcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZSxcclxuICAgICAgICAgICAgICAgICksXHJcbiAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZVR5cGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBwcm9jZXNzUmVtb3RlID0gYXN5bmMgKG5vZGVzOiBGaWdtYU5vZGVbXSkgPT4ge1xyXG4gICAgICAgIGlmICghbm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZm9ybWF0ID0gJ3BuZycgYXMgY29uc3Q7XHJcbiAgICAgICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcDxzdHJpbmcsIHsgdXJsOiBzdHJpbmc7IG5vZGVzOiBGaWdtYU5vZGVbXSB9PigpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgICAgICBjb25zdCB1cmwgPSB3cml0ZXIuYnVpbGRVcmwoXHJcbiAgICAgICAgICAgICAgICBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBgJHtzZXNzaW9uLmZpbGVLZXl9OiR7bm9kZS5pZH1gLFxyXG4gICAgICAgICAgICAgICAgZm9ybWF0LFxyXG4gICAgICAgICAgICAgICAgaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZ3JvdXAgPSBncm91cHMuZ2V0KGtleSkgPz8geyB1cmwsIG5vZGVzOiBbXSB9O1xyXG4gICAgICAgICAgICBncm91cC5ub2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgICAgICBncm91cHMuc2V0KGtleSwgZ3JvdXApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZW5kaW5nOiBBcnJheTx7XHJcbiAgICAgICAgICAgIG5vZGU6IEZpZ21hTm9kZTtcclxuICAgICAgICAgICAgbm9kZXM6IEZpZ21hTm9kZVtdO1xyXG4gICAgICAgICAgICB1cmw6IHN0cmluZztcclxuICAgICAgICAgICAgYm9yZGVycz86IHsgbGVmdDogbnVtYmVyOyByaWdodDogbnVtYmVyOyB0b3A6IG51bWJlcjsgYm90dG9tOiBudW1iZXIgfTtcclxuICAgICAgICAgICAga2V5OiBDYWNoZUVudHJ5S2V5O1xyXG4gICAgICAgICAgICBjb250ZW50czogQnVmZmVyIHwgbnVsbDtcclxuICAgICAgICAgICAgc291cmNlOiAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYSc7XHJcbiAgICAgICAgfT4gPSBbXTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZUdyb3VwID0gKFxyXG4gICAgICAgICAgICBncm91cGVkTm9kZXM6IEZpZ21hTm9kZVtdLFxyXG4gICAgICAgICAgICBhc3NldDogU3ByaXRlQXNzZXRTcGVjLFxyXG4gICAgICAgICAgICBzb3VyY2U6ICdleGlzdGluZycgfCAnbG9jYWwnIHwgJ2NhY2hlJyB8ICdmaWdtYScsXHJcbiAgICAgICAgKSA9PiB7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgZ3JvdXBlZE5vZGUgb2YgZ3JvdXBlZE5vZGVzKSB7XHJcbiAgICAgICAgICAgICAgICBjb21wbGV0ZUFzc2V0KGdyb3VwZWROb2RlLCBhc3NldCwgc291cmNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZm9yIChjb25zdCB7IHVybCwgbm9kZXM6IGdyb3VwZWROb2RlcyB9IG9mIGdyb3Vwcy52YWx1ZXMoKSkge1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBncm91cGVkTm9kZXNbMF07XHJcbiAgICAgICAgICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25zLmdldChub2RlLmlkKSA/PyBkZWZhdWx0RGVjaXNpb24obm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGJvcmRlcnMgPSBkZWNpc2lvbi5uaW5lU2xpY2UgJiYgZm9ybWF0ID09PSAncG5nJ1xyXG4gICAgICAgICAgICAgICAgPyBhbmFseXplU2xpY2VHcmlkKG5vZGUsIGltcG9ydFNldHRpbmdzLnNjYWxlKT8uYm9yZGVyc1xyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGxldCBsb2NhbE1hdGNoID0gbnVsbDtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBsaWJyYXJ5IG9mIGxvY2FsUmVzb3VyY2VzKSB7XHJcbiAgICAgICAgICAgICAgICBsb2NhbE1hdGNoID0gYXdhaXQgbGlicmFyeS5maW5kKG5vZGUubmFtZSwgZm9ybWF0KTtcclxuICAgICAgICAgICAgICAgIGlmIChsb2NhbE1hdGNoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgbG9jYWxVcmwgPSBsb2NhbE1hdGNoICYmICFib3JkZXJzXHJcbiAgICAgICAgICAgICAgICA/IGFzc2V0RGF0YWJhc2VVcmwobG9jYWxNYXRjaC5wYXRoKVxyXG4gICAgICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgICAgICBjb25zdCBsb2NhbEFzc2V0ID0gbG9jYWxVcmwgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcobG9jYWxVcmwpIDogbnVsbDtcclxuICAgICAgICAgICAgaWYgKGxvY2FsQXNzZXQpIHtcclxuICAgICAgICAgICAgICAgIGNvbXBsZXRlR3JvdXAoZ3JvdXBlZE5vZGVzLCBsb2NhbEFzc2V0LCAnbG9jYWwnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gIWltcG9ydFNldHRpbmdzLnJlZnJlc2hBc3NldHMgPyBhd2FpdCB3cml0ZXIuZXhpc3RpbmcodXJsKSA6IG51bGw7XHJcbiAgICAgICAgICAgIGlmICghbG9jYWxNYXRjaCAmJiBleGlzdGluZyAmJiAhYm9yZGVycykge1xyXG4gICAgICAgICAgICAgICAgY29tcGxldGVHcm91cChncm91cGVkTm9kZXMsIGV4aXN0aW5nLCAnZXhpc3RpbmcnKTtcclxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGtleTogQ2FjaGVFbnRyeUtleSA9IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IHNlc3Npb24uZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgY29uc3QgY2FjaGVkID0gbG9jYWxNYXRjaCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgY2FjaGUucmVhZChrZXkpO1xyXG4gICAgICAgICAgICBwZW5kaW5nLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgIG5vZGVzOiBncm91cGVkTm9kZXMsXHJcbiAgICAgICAgICAgICAgICB1cmwsXHJcbiAgICAgICAgICAgICAgICBib3JkZXJzLFxyXG4gICAgICAgICAgICAgICAga2V5LFxyXG4gICAgICAgICAgICAgICAgY29udGVudHM6IGxvY2FsTWF0Y2g/LmNvbnRlbnRzID8/IGNhY2hlZCxcclxuICAgICAgICAgICAgICAgIHNvdXJjZTogbG9jYWxNYXRjaCA/ICdsb2NhbCcgOiBjYWNoZWQgPyAnY2FjaGUnIDogJ2ZpZ21hJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlbW90ZU5vZGVzID0gcGVuZGluZy5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmNvbnRlbnRzKS5tYXAoKGl0ZW0pID0+IGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgY29uc3QgdXJscyA9IHJlbW90ZU5vZGVzLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGF3YWl0IChhd2FpdCBnZXRBcGkoKSkuZ2V0SW1hZ2VVcmxzKFxyXG4gICAgICAgICAgICAgICAgc2Vzc2lvbi5maWxlS2V5LFxyXG4gICAgICAgICAgICAgICAgcmVtb3RlTm9kZXMubWFwKChub2RlKSA9PiBub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGZvcm1hdCxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDoge307XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHBlbmRpbmcpIHtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQ2FuY2VsbGVkRXJyb3IoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsZXQgY29udGVudHMgPSBpdGVtLmNvbnRlbnRzO1xyXG4gICAgICAgICAgICBpZiAoIWNvbnRlbnRzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByZW1vdGVVcmwgPSB1cmxzW2l0ZW0ubm9kZS5pZF07XHJcbiAgICAgICAgICAgICAgICBpZiAoIXJlbW90ZVVybCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlnbWEg5pyq6IO95riy5p+T6IqC54K577yaJHtpdGVtLm5vZGUubmFtZX1gKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGNvbnRlbnRzID0gYXdhaXQgKGF3YWl0IGdldEFwaSgpKS5kb3dubG9hZChyZW1vdGVVcmwpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgY2FjaGUud3JpdGUoaXRlbS5rZXksIGNvbnRlbnRzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb21wbGV0ZUdyb3VwKFxyXG4gICAgICAgICAgICAgICAgaXRlbS5ub2RlcyxcclxuICAgICAgICAgICAgICAgIGF3YWl0IHdyaXRlci53cml0ZShpdGVtLnVybCwgY29udGVudHMsIGl0ZW0uYm9yZGVycyksXHJcbiAgICAgICAgICAgICAgICBpdGVtLnNvdXJjZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIGF3YWl0IHByb2Nlc3NUaWxlZChyZXF1ZXN0cy50aWxlZCk7XHJcbiAgICBhd2FpdCBwcm9jZXNzUmVtb3RlKHJlcXVlc3RzLnBuZyk7XHJcblxyXG4gICAgY29uc3QgZ3JhZGllbnRBc3NldHMgPSBuZXcgTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPigpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIHJlcXVlc3RzLmdyYWRpZW50cykge1xyXG4gICAgICAgIGNvbnN0IGZyYW1lID0gbm9kZS5hYnNvbHV0ZUJvdW5kaW5nQm94O1xyXG4gICAgICAgIGNvbnN0IGZpbGwgPSBub2RlLmZpbGxzLmZpbmQoKGl0ZW0pID0+IGl0ZW0udmlzaWJsZSAhPT0gZmFsc2UgJiYgaXRlbS50eXBlLnN0YXJ0c1dpdGgoJ0dSQURJRU5UXycpKTtcclxuICAgICAgICBjb25zdCBwbmcgPSBmcmFtZSAmJiBmaWxsXHJcbiAgICAgICAgICAgID8gZ3JhZGllbnRQbmcoXHJcbiAgICAgICAgICAgICAgICBmcmFtZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGZyYW1lLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGZpbGwsXHJcbiAgICAgICAgICAgICAgICBjb3JuZXJSYWRpaShub2RlKSxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApXHJcbiAgICAgICAgICAgIDogbnVsbDtcclxuICAgICAgICBpZiAocG5nKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IHdyaXRlci5idWlsZFVybChcclxuICAgICAgICAgICAgICAgIG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGAke3Nlc3Npb24uZmlsZUtleX06JHtub2RlLmlkfTpncmFkaWVudGAsXHJcbiAgICAgICAgICAgICAgICAncG5nJyxcclxuICAgICAgICAgICAgICAgIGltcG9ydFNldHRpbmdzLnNjYWxlLFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBjb25zdCBncmFkaWVudEtleSA9IHVybC5ub3JtYWxpemUoJ05GS0MnKS50b0xvY2FsZUxvd2VyQ2FzZSgnZW4tVVMnKTtcclxuICAgICAgICAgICAgY29uc3QgZmlyc3RBc3NldCA9IGdyYWRpZW50QXNzZXRzLmdldChncmFkaWVudEtleSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZmlyc3RBc3NldCB8fCBpbXBvcnRTZXR0aW5ncy5yZWZyZXNoQXNzZXRzXHJcbiAgICAgICAgICAgICAgICA/IG51bGxcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgd3JpdGVyLmV4aXN0aW5nKHVybCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFzc2V0ID0gZmlyc3RBc3NldCA/PyBleGlzdGluZyA/PyBhd2FpdCB3cml0ZXIud3JpdGUodXJsLCBwbmcpO1xyXG4gICAgICAgICAgICBncmFkaWVudEFzc2V0cy5zZXQoZ3JhZGllbnRLZXksIGFzc2V0KTtcclxuICAgICAgICAgICAgY29tcGxldGVBc3NldChub2RlLCBhc3NldCwgZmlyc3RBc3NldCB8fCBleGlzdGluZyA/ICdleGlzdGluZycgOiAnZ2VuZXJhdGVkJyk7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb21wbGV0ZWQgKz0gMTtcclxuICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICBwaGFzZTogJ2Fzc2V0cycsXHJcbiAgICAgICAgICAgIHZhbHVlOiB0b3RhbCA/IGNvbXBsZXRlZCAvIHRvdGFsIDogMSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYOeUn+aIkOa4kOWPmCAke2NvbXBsZXRlZH0vJHt0b3RhbH0gwrcgJHtub2RlLm5hbWV9YCxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiBhc3NldHM7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVGb250cyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHJlc3VsdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XHJcbiAgICBmb3IgKGNvbnN0IFtmYW1pbHksIHVybF0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkpIHtcclxuICAgICAgICBjb25zdCB1dWlkID0gYXdhaXQgcmVzb2x2ZUFzc2V0VXVpZCh1cmwpO1xyXG4gICAgICAgIGlmICh1dWlkKSB7XHJcbiAgICAgICAgICAgIHJlc3VsdC5zZXQoZmFtaWx5LCB1dWlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlcnJlZExheW91dE1vZGUobm9kZTogRmlnbWFOb2RlKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGNvbnN0IG5hdGl2ZU1vZGUgPSBpbmZlckNvY29zTGF5b3V0TW9kZShub2RlKTtcclxuICAgIGlmIChuYXRpdmVNb2RlKSB7XHJcbiAgICAgICAgcmV0dXJuIG5hdGl2ZU1vZGU7XHJcbiAgICB9XHJcbiAgICBpZiAobm9kZS5sYXlvdXRNb2RlICYmIG5vZGUubGF5b3V0TW9kZSAhPT0gJ05PTkUnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyYW1lcyA9IG5vZGUuY2hpbGRyZW5cclxuICAgICAgICAubWFwKChjaGlsZCkgPT4gY2hpbGQuYWJzb2x1dGVCb3VuZGluZ0JveClcclxuICAgICAgICAuZmlsdGVyKChmcmFtZSk6IGZyYW1lIGlzIFJlY3QgPT4gQm9vbGVhbihmcmFtZSkpO1xyXG4gICAgaWYgKCFmcmFtZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICBjb25zdCBjZW50ZXJzWCA9IGZyYW1lcy5tYXAoKGZyYW1lKSA9PiBmcmFtZS54ICsgZnJhbWUud2lkdGggLyAyKTtcclxuICAgIGNvbnN0IGNlbnRlcnNZID0gZnJhbWVzLm1hcCgoZnJhbWUpID0+IGZyYW1lLnkgKyBmcmFtZS5oZWlnaHQgLyAyKTtcclxuICAgIGNvbnN0IHNwcmVhZFggPSBNYXRoLm1heCguLi5jZW50ZXJzWCkgLSBNYXRoLm1pbiguLi5jZW50ZXJzWCk7XHJcbiAgICBjb25zdCBzcHJlYWRZID0gTWF0aC5tYXgoLi4uY2VudGVyc1kpIC0gTWF0aC5taW4oLi4uY2VudGVyc1kpO1xyXG4gICAgaWYgKHNwcmVhZFkgPD0gMikge1xyXG4gICAgICAgIHJldHVybiAnSE9SSVpPTlRBTCc7XHJcbiAgICB9XHJcbiAgICBpZiAoc3ByZWFkWCA8PSAyKSB7XHJcbiAgICAgICAgcmV0dXJuICdWRVJUSUNBTCc7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJ0dSSUQnO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbWFrZVNwZWMoXHJcbiAgICBub2RlOiBGaWdtYU5vZGUsXHJcbiAgICBwYXJlbnRGcmFtZTogUmVjdCB8IHVuZGVmaW5lZCxcclxuICAgIGRlY2lzaW9uczogTWFwPHN0cmluZywgRGVjaXNpb24+LFxyXG4gICAgcGxhbnM6IFJlYWRvbmx5TWFwPHN0cmluZywgTm9kZUltcG9ydFBsYW4+LFxyXG4gICAgbm9kZUJ5SWQ6IFJlYWRvbmx5TWFwPHN0cmluZywgRmlnbWFOb2RlPixcclxuICAgIGFzc2V0czogTWFwPHN0cmluZywgU3ByaXRlQXNzZXRTcGVjPixcclxuICAgIGZvbnRzOiBNYXA8c3RyaW5nLCBzdHJpbmc+LFxyXG4gICAgaXNSb290ID0gZmFsc2UsXHJcbik6IFNjZW5lTm9kZVNwZWMgfCBudWxsIHtcclxuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaXNpb25Gb3JOb2RlKG5vZGUsIGRlY2lzaW9ucyk7XHJcbiAgICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSAnaWdub3JlJykge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZnJhbWUgPSBub2RlRnJhbWUobm9kZSk7XHJcbiAgICBjb25zdCBwbGFuID0gcGxhbnMuZ2V0KG5vZGUuaWQpO1xyXG4gICAgY29uc3QgZm9sZCA9IHBsYW4/LmZvbGQ7XHJcbiAgICBjb25zdCBmb2xkU291cmNlID0gZm9sZCA/IG5vZGVCeUlkLmdldChmb2xkLnNvdXJjZU5vZGVJZCkgOiB1bmRlZmluZWQ7XHJcbiAgICBjb25zdCB0ZXh0U291cmNlID0gZm9sZD8ua2luZCA9PT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCB2aXN1YWxTb3VyY2UgPSBmb2xkICYmIGZvbGQua2luZCAhPT0gJ3NpbmdsZS10ZXh0JyAmJiBmb2xkU291cmNlID8gZm9sZFNvdXJjZSA6IG5vZGU7XHJcbiAgICBjb25zdCByZXNvbHZlZEtpbmQgPSBkZWNpc2lvbi5raW5kID09PSAnYXV0bycgPyBpbmZlcktpbmQobm9kZSkgOiBkZWNpc2lvbi5raW5kO1xyXG4gICAgY29uc3QgcGxhbm5lZEtpbmQgPSBwbGFuPy5raW5kID8/IHJlc29sdmVkS2luZDtcclxuICAgIGNvbnN0IGJpdG1hcFRlcm1pbmFsID0gZGVjaXNpb24ubmluZVNsaWNlIHx8IGRlY2lzaW9uLmFjdGlvbiA9PT0gJ3JlbmRlcic7XHJcbiAgICBjb25zdCB0ZXJtaW5hbCA9IGJpdG1hcFRlcm1pbmFsIHx8IGlzVGVybWluYWxBY3Rpb24oZGVjaXNpb24uYWN0aW9uKTtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBraW5kRm9ySW1wb3J0QWN0aW9uKHBsYW5uZWRLaW5kLCBkZWNpc2lvbi5hY3Rpb24sIGRlY2lzaW9uLm5pbmVTbGljZSk7XHJcbiAgICBjb25zdCBzcHJpdGVTb3VyY2VJZCA9IGZvbGQgJiYgZm9sZC5raW5kICE9PSAnc2luZ2xlLXRleHQnXHJcbiAgICAgICAgPyBmb2xkLnNvdXJjZU5vZGVJZFxyXG4gICAgICAgIDogbm9kZS5pZDtcclxuICAgIGNvbnN0IHNwcml0ZUFzc2V0ID0gYXNzZXRzLmdldChzcHJpdGVTb3VyY2VJZCk7XHJcbiAgICBjb25zdCBhYnNvcmJlZERpcmVjdElkcyA9IG5ldyBTZXQoZm9sZCA/IFtmb2xkLnNvdXJjZU5vZGVJZF0gOiBbXSk7XHJcbiAgICBjb25zdCBmdWxsRm9sZCA9IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtaW1hZ2UnIHx8IGZvbGQ/LmtpbmQgPT09ICdzaW5nbGUtdGV4dCc7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGZpZ21hSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgbmFtZTogZGVjaXNpb24ubmFtZSA/PyBub2RlLm5hbWUsXHJcbiAgICAgICAgZmlnbWFUeXBlOiB2aXN1YWxTb3VyY2UudHlwZSxcclxuICAgICAgICBhY3Rpb246IGRlY2lzaW9uLmFjdGlvbixcclxuICAgICAgICBraW5kOiBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGZyYW1lLFxyXG4gICAgICAgIHBhcmVudEZyYW1lLFxyXG4gICAgICAgIGludHJpbnNpY1NpemU6IG5vZGUuc2l6ZSxcclxuICAgICAgICBpc1Jvb3QsXHJcbiAgICAgICAgcm90YXRpb246IG5vZGUucm90YXRpb24sXHJcbiAgICAgICAgb3BhY2l0eTogZm9sZFNvdXJjZSAmJiBmdWxsRm9sZFxyXG4gICAgICAgICAgICA/IG5vZGUub3BhY2l0eSAqIGZvbGRTb3VyY2Uub3BhY2l0eVxyXG4gICAgICAgICAgICA6IG5vZGUub3BhY2l0eSxcclxuICAgICAgICB2aXNpYmxlOiBub2RlLnZpc2libGUsXHJcbiAgICAgICAgY2xpcHNDb250ZW50OiBub2RlLmNsaXBzQ29udGVudCxcclxuICAgICAgICBjb3JuZXJSYWRpaTogY29ybmVyUmFkaWkodmlzdWFsU291cmNlKSxcclxuICAgICAgICBmaWxsczogdGV4dFNvdXJjZS5maWxscyxcclxuICAgICAgICBzdHJva2VzOiB0ZXh0U291cmNlLnN0cm9rZXMsXHJcbiAgICAgICAgc3Ryb2tlV2VpZ2h0OiB0ZXh0U291cmNlLnN0cm9rZVdlaWdodCxcclxuICAgICAgICBjaGFyYWN0ZXJzOiB0ZXh0U291cmNlLmNoYXJhY3RlcnMsXHJcbiAgICAgICAgdGV4dFN0eWxlOiB0ZXh0U291cmNlLnN0eWxlLFxyXG4gICAgICAgIGxheW91dDoge1xyXG4gICAgICAgICAgICBtb2RlOiBlZmZlY3RpdmVLaW5kID09PSAnbGF5b3V0JyB8fCBlZmZlY3RpdmVLaW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgICAgID8gaW5mZXJyZWRMYXlvdXRNb2RlKG5vZGUpXHJcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgc291cmNlTW9kZTogbm9kZS5sYXlvdXRNb2RlLFxyXG4gICAgICAgICAgICB3cmFwOiBub2RlLmxheW91dFdyYXAsXHJcbiAgICAgICAgICAgIHByaW1hcnlBbGlnbjogbm9kZS5wcmltYXJ5QXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIGNvdW50ZXJBbGlnbjogbm9kZS5jb3VudGVyQXhpc0FsaWduSXRlbXMsXHJcbiAgICAgICAgICAgIHByaW1hcnlTaXppbmc6IG5vZGUucHJpbWFyeUF4aXNTaXppbmdNb2RlLFxyXG4gICAgICAgICAgICBjb3VudGVyU2l6aW5nOiBub2RlLmNvdW50ZXJBeGlzU2l6aW5nTW9kZSxcclxuICAgICAgICAgICAgaXRlbVNwYWNpbmc6IG5vZGUuaXRlbVNwYWNpbmcsXHJcbiAgICAgICAgICAgIGNvdW50ZXJTcGFjaW5nOiBub2RlLmNvdW50ZXJBeGlzU3BhY2luZyxcclxuICAgICAgICAgICAgcGFkZGluZ0xlZnQ6IG5vZGUucGFkZGluZ0xlZnQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdSaWdodDogbm9kZS5wYWRkaW5nUmlnaHQsXHJcbiAgICAgICAgICAgIHBhZGRpbmdUb3A6IG5vZGUucGFkZGluZ1RvcCxcclxuICAgICAgICAgICAgcGFkZGluZ0JvdHRvbTogbm9kZS5wYWRkaW5nQm90dG9tLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb3ZlcmZsb3dEaXJlY3Rpb246IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb24sXHJcbiAgICAgICAgY29uc3RyYWludHM6IG5vZGUuY29uc3RyYWludHMsXHJcbiAgICAgICAgcmVsYXRpdmVUcmFuc2Zvcm06IG5vZGUucmVsYXRpdmVUcmFuc2Zvcm0sXHJcbiAgICAgICAgc3ByaXRlOiBzcHJpdGVBc3NldCxcclxuICAgICAgICBmb250VXVpZDogdGV4dFNvdXJjZS5zdHlsZT8uZm9udEZhbWlseSA/IGZvbnRzLmdldCh0ZXh0U291cmNlLnN0eWxlLmZvbnRGYW1pbHkpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIGFsaWFzRmlnbWFJZHM6IGZvbGQ/LmFic29yYmVkTm9kZUlkcyxcclxuICAgICAgICBmbGF0dGVuQm91bmRhcnk6IGJpdG1hcFRlcm1pbmFsIHx8IGZ1bGxGb2xkXHJcbiAgICAgICAgICAgID8gdHJ1ZVxyXG4gICAgICAgICAgICA6IGZvbGQ/LmtpbmQgPT09ICdiYWNrZ3JvdW5kJ1xyXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxyXG4gICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgcGxhblJlYXNvbjogcGxhbj8ucmVhc29uLFxyXG4gICAgICAgIGNoaWxkcmVuOiB0ZXJtaW5hbFxyXG4gICAgICAgICAgICA/IFtdXHJcbiAgICAgICAgICAgIDogbm9kZS5jaGlsZHJlblxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpID0+ICFhYnNvcmJlZERpcmVjdElkcy5oYXMoY2hpbGQuaWQpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY2hpbGQpID0+IG1ha2VTcGVjKFxyXG4gICAgICAgICAgICAgICAgICAgIGNoaWxkLFxyXG4gICAgICAgICAgICAgICAgICAgIGZyYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIGRlY2lzaW9ucyxcclxuICAgICAgICAgICAgICAgICAgICBwbGFucyxcclxuICAgICAgICAgICAgICAgICAgICBub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZmFsc2UsXHJcbiAgICAgICAgICAgICAgICApKVxyXG4gICAgICAgICAgICAgICAgLmZpbHRlcigoY2hpbGQpOiBjaGlsZCBpcyBTY2VuZU5vZGVTcGVjID0+IGNoaWxkICE9PSBudWxsKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldE5vZGVNYXBzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCAncHJvamVjdCcpO1xyXG4gICAgcmV0dXJuIHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcgPyBzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA6IHt9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2Nvc0ZpbGVJZCgpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZ2VuZXJhdGVkID0gRWRpdG9yLlV0aWxzPy5VVUlEPy5nZW5lcmF0ZT8uKHRydWUpO1xyXG4gICAgcmV0dXJuIHR5cGVvZiBnZW5lcmF0ZWQgPT09ICdzdHJpbmcnICYmIGdlbmVyYXRlZC5sZW5ndGggPiAwXHJcbiAgICAgICAgPyBnZW5lcmF0ZWRcclxuICAgICAgICA6IHJhbmRvbUJ5dGVzKDE2KS50b1N0cmluZygnYmFzZTY0JykucmVwbGFjZSgvPSskL2csICcnKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJBc3NldCh1cmxPclV1aWQ6IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvIHwgbnVsbD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgJ2Fzc2V0LWRiJyxcclxuICAgICAgICAncXVlcnktYXNzZXQtaW5mbycsXHJcbiAgICAgICAgdXJsT3JVdWlkLFxyXG4gICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhc3NlcnRQcmVmYWJBc3NldChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIGV4cGVjdGVkOiB7IHV1aWQ/OiBzdHJpbmc7IHVybD86IHN0cmluZyB9ID0ge30sXHJcbik6IHZvaWQge1xyXG4gICAgaWYgKGluZm8uaW52YWxpZCB8fCBpbmZvLmltcG9ydGVkICE9PSB0cnVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg5bCa5pyq5a6M5oiQ5a+85YWl77yaJHtpbmZvLnVybH1gKTtcclxuICAgIH1cclxuICAgIGlmIChpbmZvLmltcG9ydGVyICE9PSAncHJlZmFiJyB8fCBpbmZvLnR5cGUgIT09ICdjYy5QcmVmYWInIHx8IGluZm8uaXNEaXJlY3RvcnkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruagh+i1hOa6kOS4jeaYr+WPr+e8lui+keeahCBDb2NvcyBQcmVmYWLvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGluZm8ucmVhZG9ubHkgfHwgaW5mby5yZWRpcmVjdCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg55uu5qCHIFByZWZhYiDkuLrlj6ror7vmiJbph43lrprlkJHotYTmupDvvIzkuI3og73lronlhajmm7TmlrDvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnV1aWQgJiYgaW5mby51dWlkICE9PSBleHBlY3RlZC51dWlkKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIgVVVJRCDmoKHpqozlpLHotKXvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgaWYgKGV4cGVjdGVkLnVybCAmJiBpbmZvLnVybCAhPT0gZXhwZWN0ZWQudXJsKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQcmVmYWIg6Lev5b6E5qCh6aqM5aSx6LSl77ya5pyf5pybICR7ZXhwZWN0ZWQudXJsfe+8jOWunumZhSAke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yUHJlZmFiQXNzZXQodXJsOiBzdHJpbmcsIGV4cGVjdGVkVXVpZD86IHN0cmluZyk6IFByb21pc2U8UHJlZmFiQXNzZXRJbmZvPiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHVybCk7XHJcbiAgICAgICAgaWYgKGluZm8/LmludmFsaWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2NvcyBQcmVmYWIg6LWE5rqQ5a+85YWl5aSx6LSl77yaJHt1cmx9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbmZvPy5pbXBvcnRlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBpZiAoZXhwZWN0ZWRVdWlkICYmIGluZm8udXVpZCAhPT0gZXhwZWN0ZWRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBVVUlEIOWcqOWvvOWFpeacn+mXtOWPkeeUn+WPmOWMlu+8miR7dXJsfWApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGFzc2VydFByZWZhYkFzc2V0KGluZm8sIHsgdXVpZDogZXhwZWN0ZWRVdWlkLCB1cmwgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiBpbmZvO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYWN0aXZlQ29udHJvbGxlcj8uc2lnbmFsLmFib3J0ZWQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IENhbmNlbGxlZEVycm9yKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlRGVsYXkpID0+IHNldFRpbWVvdXQocmVzb2x2ZURlbGF5LCAxMjApKTtcclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihg562J5b6FIENvY29zIFByZWZhYiDotYTmupDlsLHnu6rotoXml7bvvJoke3VybH1gKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcXVlcnlQcmVmYWJNZXRhKHV1aWQ6IHN0cmluZyk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcclxuICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgJ3F1ZXJ5LWFzc2V0LW1ldGEnLFxyXG4gICAgICAgIHV1aWQsXHJcbiAgICApO1xyXG4gICAgaWYgKCFtZXRhIHx8IHR5cGVvZiBtZXRhICE9PSAnb2JqZWN0Jykge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV6K+75Y+WIFByZWZhYiBNZXRh77yaJHt1dWlkfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdmFsdWUgPSBtZXRhIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBpZiAodmFsdWUudXVpZCAhPT0gdXVpZCB8fCB2YWx1ZS5pbXBvcnRlciAhPT0gJ3ByZWZhYicpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiBNZXRhIOS4juebruagh+i1hOa6kOS4jeWMuemFje+8miR7dXVpZH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcHJlZmFiRGlza1BhdGgodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnZGI6Ly8nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUHJlZmFiIFVSTCDml6DmlYjvvJoke3VybH1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXNvbHZlKEVkaXRvci5Qcm9qZWN0LnBhdGgsIHVybC5zbGljZSgnZGI6Ly8nLmxlbmd0aCkpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdG9yZWRQcmVmYWJNYXRjaGVzUmVjb3JkKFxyXG4gICAgaW5mbzogUHJlZmFiQXNzZXRJbmZvLFxyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkLFxyXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIHByZWZhYkpzb25Db250YWluc1N5bmNSZWNvcmQoXHJcbiAgICAgICAgICAgIGF3YWl0IHJlYWRGaWxlKHByZWZhYkRpc2tQYXRoKGluZm8udXJsKSksXHJcbiAgICAgICAgICAgIHJlY29yZCxcclxuICAgICAgICApO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yT3BlbmVkUHJlZmFiKFxyXG4gICAgcHJlZmFiVXJsOiBzdHJpbmcsXHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmcsXHJcbiAgICByb290RmlsZUlkOiBzdHJpbmcsXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgY3VycmVudERpcnR5ID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAncXVlcnktZGlydHknKSBhcyBib29sZWFuO1xyXG4gICAgaWYgKGN1cnJlbnREaXJ0eSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign5b2T5YmN5omT5byA55qE5Zy65pmv5oiWIFByZWZhYiDmnInmnKrkv53lrZjkv67mlLnvvJvkuLrpgb/lhY3op6blj5Hkv53lrZjor6Lpl67vvIzor7flhYjmiYvlt6Xkv53lrZjmiJbov5jljp/lkI7lho3lr7zlhaXjgIInKTtcclxuICAgIH1cclxuICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgIEVkaXRvci5TZWxlY3Rpb24uc2VsZWN0KCdhc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAnb3Blbi1hc3NldCcsIHByZWZhYlV1aWQpO1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBsZXQgbGFzdFJlYXNvbiA9ICdDcmVhdG9yIOWwmuacqui/lOWbniBQcmVmYWIg57yW6L6R54q25oCBJztcclxuICAgIHdoaWxlIChEYXRlLm5vdygpIC0gc3RhcnRlZCA8IDMwXzAwMCkge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICAgICAgbWV0aG9kOiAnaW5zcGVjdFByZWZhYkNvbnRleHQnLFxyXG4gICAgICAgICAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgICAgICAgICAgfSkgYXMgUHJlZmFiRWRpdGluZ1N0YXRlO1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUucmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0UmVhc29uID0gc3RhdGUucmVhc29uID8/IGxhc3RSZWFzb247XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgbGFzdFJlYXNvbiA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGFjdGl2ZUNvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBDYW5jZWxsZWRFcnJvcigpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTIwKSk7XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYOaJk+W8gOebruaghyBQcmVmYWIg6LaF5pe277yaJHtsYXN0UmVhc29ufWApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRPcGVuZWRQcmVmYWIocHJlZmFiVXVpZDogc3RyaW5nLCByb290RmlsZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICBtZXRob2Q6ICdpbnNwZWN0UHJlZmFiQ29udGV4dCcsXHJcbiAgICAgICAgYXJnczogW3sgcHJlZmFiVXVpZCwgcm9vdEZpbGVJZCB9XSxcclxuICAgIH0pIGFzIFByZWZhYkVkaXRpbmdTdGF0ZTtcclxuICAgIGlmICghc3RhdGUucmVhZHkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOebruaghyBQcmVmYWIg57yW6L6R5LiK5LiL5paH5bey5Y+Y5YyW77yaJHtzdGF0ZS5yZWFzb24gPz8gJ+acquefpeWOn+WboCd9YCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JTY2VuZVNhdmVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPCAxNV8wMDApIHtcclxuICAgICAgICBjb25zdCBkaXJ0eSA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoIWRpcnR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmVEZWxheSkgPT4gc2V0VGltZW91dChyZXNvbHZlRGVsYXksIDEyMCkpO1xyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCfnrYnlvoUgUHJlZmFiIOS/neWtmOWujOaIkOi2heaXtuOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBnZXRQcmVmYWJCaW5kaW5ncygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG4gICAgaWYgKCFzYXZlZCB8fCB0eXBlb2Ygc2F2ZWQgIT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgcmV0dXJuIHt9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICBmb3IgKGNvbnN0IFtzb3VyY2VIYXNoLCBwcmVmYWJVdWlkXSBvZiBPYmplY3QuZW50cmllcyhzYXZlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICBpZiAoIS9ec2hhMjU2OlswLTlhLWZdezY0fSQvLnRlc3Qoc291cmNlSGFzaClcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHByZWZhYlV1aWQgIT09ICdzdHJpbmcnXHJcbiAgICAgICAgICAgIHx8ICFwcmVmYWJVdWlkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOe7keWumuiusOW9leW3suaNn+Wdj++8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoOiBzdHJpbmcsIHByZWZhYlV1aWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgYmluZGluZ3Nbc291cmNlSGFzaF0gPSBwcmVmYWJVdWlkO1xyXG4gICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChcclxuICAgICAgICBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICdwcmVmYWJCaW5kaW5nc1YxJyxcclxuICAgICAgICBiaW5kaW5ncyxcclxuICAgICAgICAncHJvamVjdCcsXHJcbiAgICApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW1vdmVQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2g6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgaWYgKCFiaW5kaW5nc1tzb3VyY2VIYXNoXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBiaW5kaW5nc1tzb3VyY2VIYXNoXTtcclxuICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QoXHJcbiAgICAgICAgcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAncHJlZmFiQmluZGluZ3NWMScsXHJcbiAgICAgICAgYmluZGluZ3MsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGVuZGluZ1ByZWZhYlN5bmNzKCk6IFByb21pc2U8UmVjb3JkPHN0cmluZywge1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkO1xyXG59Pj4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgICdwcm9qZWN0JyxcclxuICAgICk7XHJcbiAgICBpZiAoIXNhdmVkIHx8IHR5cGVvZiBzYXZlZCAhPT0gJ29iamVjdCcpIHtcclxuICAgICAgICByZXR1cm4ge307XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHsgcHJlZmFiVXVpZDogc3RyaW5nOyByZWNvcmQ6IFByZWZhYlN5bmNSZWNvcmQgfT4gPSB7fTtcclxuICAgIGZvciAoY29uc3QgW3NvdXJjZUhhc2gsIHJhd10gb2YgT2JqZWN0LmVudHJpZXMoc2F2ZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XHJcbiAgICAgICAgaWYgKCEvXnNoYTI1NjpbMC05YS1mXXs2NH0kLy50ZXN0KHNvdXJjZUhhc2gpXHJcbiAgICAgICAgICAgIHx8ICFyYXdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIHJhdyAhPT0gJ29iamVjdCdcclxuICAgICAgICAgICAgfHwgdHlwZW9mIChyYXcgYXMgeyBwcmVmYWJVdWlkPzogdW5rbm93biB9KS5wcmVmYWJVdWlkICE9PSAnc3RyaW5nJykge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDlvoXmgaLlpI3lkIzmraXorrDlvZXlt7LmjZ/lnY/vvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQoe1xyXG4gICAgICAgICAgICB1c2VyRGF0YToge1xyXG4gICAgICAgICAgICAgICAgZmlnbWFJbXBvcnRlcjogKHJhdyBhcyB7IHJlY29yZD86IHVua25vd24gfSkucmVjb3JkLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOW+heaBouWkjeWQjOatpeiusOW9leadpea6kOS4jeS4gOiHtO+8jOW3suWBnOatouWvvOWFpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXN1bHRbc291cmNlSGFzaF0gPSB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IChyYXcgYXMgeyBwcmVmYWJVdWlkOiBzdHJpbmcgfSkucHJlZmFiVXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzZXRQZW5kaW5nUHJlZmFiU3luYyhcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHZhbHVlOiB7IHByZWZhYlV1aWQ6IHN0cmluZzsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0gfCBudWxsLFxyXG4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSBhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKTtcclxuICAgIGlmICh2YWx1ZSkge1xyXG4gICAgICAgIHBlbmRpbmdbc291cmNlSGFzaF0gPSB2YWx1ZTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbc291cmNlSGFzaF07XHJcbiAgICB9XHJcbiAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRQcm9qZWN0KFxyXG4gICAgICAgIHBhY2thZ2VKU09OLm5hbWUsXHJcbiAgICAgICAgJ3BlbmRpbmdQcmVmYWJTeW5jVjEnLFxyXG4gICAgICAgIHBlbmRpbmcsXHJcbiAgICAgICAgJ3Byb2plY3QnLFxyXG4gICAgKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gdmVyaWZpZWRQcmVmYWJSZWNvcmQoXHJcbiAgICBpbmZvOiBQcmVmYWJBc3NldEluZm8sXHJcbiAgICBzb3VyY2VIYXNoOiBzdHJpbmcsXHJcbik6IFByb21pc2U8eyBtZXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcmVjb3JkOiBQcmVmYWJTeW5jUmVjb3JkIH0+IHtcclxuICAgIGxldCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICBsZXQgcmVjb3JkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICBpZiAoIXJlY29yZCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgYFByZWZhYiDnvLrlsJEgRmlnbWEg5p2l5rqQ6K6w5b2V77yM5peg5rOV56Gu6K6k5piv5ZCm5Y+v5a6J5YWo6KaG55uW77yaJHtpbmZvLnVybH3jgILor7flhYjnp7vliqjmiJbph43lkb3lkI3or6XotYTmupDjgIJgLFxyXG4gICAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVjb3JkLnNvdXJjZUhhc2ggIT09IHNvdXJjZUhhc2gpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFByZWZhYiDmnaXoh6rlj6bkuIDkuKogRmlnbWEgRnJhbWXvvIzlt7Lmi5Lnu53opobnm5bvvJoke2luZm8udXJsfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcGVuZGluZyA9IChhd2FpdCBnZXRQZW5kaW5nUHJlZmFiU3luY3MoKSlbc291cmNlSGFzaF07XHJcbiAgICBpZiAocGVuZGluZykge1xyXG4gICAgICAgIGlmIChwZW5kaW5nLnByZWZhYlV1aWQgIT09IGluZm8udXVpZCB8fCBwZW5kaW5nLnJlY29yZC5zb3VyY2VIYXNoICE9PSBzb3VyY2VIYXNoKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5qOA5rWL5Yiw5LiO55uu5qCHIFByZWZhYiDkuI3kuIDoh7TnmoTlvoXmgaLlpI3lkIzmraXorrDlvZXvvIzlt7LlgZzmraLlr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcGVuZGluZy5yZWNvcmQpKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcGVuZGluZy5yZWNvcmQpLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnYXNzZXQtZGInLCAncmVpbXBvcnQtYXNzZXQnLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQoaW5mby51cmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIG1ldGEgPSBhd2FpdCBxdWVyeVByZWZhYk1ldGEoaW5mby51dWlkKTtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghcmVjb3ZlcmVkIHx8IEpTT04uc3RyaW5naWZ5KHJlY292ZXJlZCkgIT09IEpTT04uc3RyaW5naWZ5KHBlbmRpbmcucmVjb3JkKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5aKe6YeP5ZCM5q2l6K6w5b2V6Ieq5Yqo5oGi5aSN5aSx6LSl44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVjb3JkID0gcmVjb3ZlcmVkO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoIWF3YWl0IHN0b3JlZFByZWZhYk1hdGNoZXNSZWNvcmQoaW5mbywgcmVjb3JkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmlofku7bkuI7lvZPliY3lj4rlvoXmgaLlpI3nmoTlkIzmraXorrDlvZXpg73kuI3kuIDoh7TvvIzlt7LlgZzmraLoh6rliqjmgaLlpI3jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBtZXRhLCByZWNvcmQgfTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbyxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZCxcclxuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBsZXQgbGFzdEVycm9yOiB1bmtub3duO1xyXG4gICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0ICs9IDEpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZFByZWZhYlN5bmNSZWNvcmQobWV0YSk7XHJcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCflhpnlhaXliY0gUHJlZmFiIOadpea6kOiusOW9leS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAgICAgJ3NhdmUtYXNzZXQtbWV0YScsXHJcbiAgICAgICAgICAgICAgICBpbmZvLnV1aWQsXHJcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeShtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKSwgbnVsbCwgMiksXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2Fzc2V0LWRiJywgJ3JlaW1wb3J0LWFzc2V0JywgaW5mby51dWlkKTtcclxuICAgICAgICAgICAgYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KGluZm8udXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHJlYWRQcmVmYWJTeW5jUmVjb3JkKGF3YWl0IHF1ZXJ5UHJlZmFiTWV0YShpbmZvLnV1aWQpKTtcclxuICAgICAgICAgICAgaWYgKCFzYXZlZCB8fCBKU09OLnN0cmluZ2lmeShzYXZlZCkgIT09IEpTT04uc3RyaW5naWZ5KHJlY29yZCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWQjuagoemqjOS4jeS4gOiHtOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBsYXN0RXJyb3IgPSBlcnJvcjtcclxuICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZURlbGF5KSA9PiBzZXRUaW1lb3V0KHJlc29sdmVEZWxheSwgMTUwKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBsYXN0RXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGxhc3RFcnJvciA6IG5ldyBFcnJvcignUHJlZmFiIOadpea6kOiusOW9leWGmeWFpeWksei0peOAgicpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlTGlua2VkRnJhbWVQcmVmYWIoXHJcbiAgICBwcmVmYWJVcmw6IHN0cmluZyxcclxuICAgIHByZWZhYk5hbWU6IHN0cmluZyxcclxuICAgIHJvb3RGcmFtZTogUmVjdCxcclxuICAgIHNvdXJjZUhhc2g6IHN0cmluZyxcclxuICAgIHNvdXJjZVJvb3RJZDogc3RyaW5nLFxyXG4pOiBQcm9taXNlPHtcclxuICAgIGluZm86IFByZWZhYkFzc2V0SW5mbztcclxuICAgIHJlY29yZDogUHJlZmFiU3luY1JlY29yZDtcclxufT4ge1xyXG4gICAgY29uc3QgYmluZGluZ3MgPSBhd2FpdCBnZXRQcmVmYWJCaW5kaW5ncygpO1xyXG4gICAgY29uc3QgYm91bmRVdWlkID0gYmluZGluZ3Nbc291cmNlSGFzaF07XHJcbiAgICBjb25zdCBwZW5kaW5nID0gKGF3YWl0IGdldFBlbmRpbmdQcmVmYWJTeW5jcygpKVtzb3VyY2VIYXNoXTtcclxuICAgIGNvbnN0IHBlbmRpbmdJbmZvID0gcGVuZGluZ1xyXG4gICAgICAgID8gYXdhaXQgcXVlcnlQcmVmYWJBc3NldChwZW5kaW5nLnByZWZhYlV1aWQpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3QgdGFyZ2V0UGxhbiA9IHBsYW5QcmVmYWJSZWNvdmVyeVRhcmdldChcclxuICAgICAgICBwZW5kaW5nPy5wcmVmYWJVdWlkLFxyXG4gICAgICAgIGJvdW5kVXVpZCxcclxuICAgICAgICBCb29sZWFuKHBlbmRpbmdJbmZvKSxcclxuICAgICk7XHJcbiAgICBpZiAodGFyZ2V0UGxhbi5jbGVhclBlbmRpbmcpIHtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCBudWxsKTtcclxuICAgIH1cclxuICAgIGlmICh0YXJnZXRQbGFuLmNsZWFyQmluZGluZykge1xyXG4gICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0YXJnZXRVdWlkID0gdGFyZ2V0UGxhbi50YXJnZXRVdWlkO1xyXG4gICAgaWYgKHRhcmdldFV1aWQpIHtcclxuICAgICAgICBsZXQgdGFyZ2V0SW5mbyA9IHBlbmRpbmdJbmZvPy51dWlkID09PSB0YXJnZXRVdWlkXHJcbiAgICAgICAgICAgID8gcGVuZGluZ0luZm9cclxuICAgICAgICAgICAgOiBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHRhcmdldFV1aWQpO1xyXG4gICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xyXG4gICAgICAgICAgICBpZiAoYmluZGluZ3Nbc291cmNlSGFzaF0gPT09IHRhcmdldFV1aWQpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlbW92ZVByZWZhYkJpbmRpbmcoc291cmNlSGFzaCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHRhcmdldEluZm8udXJsLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgaWYgKHBlbmRpbmc/LnByZWZhYlV1aWQgPT09IHRhcmdldFV1aWQgJiYgYm91bmRVdWlkICE9PSB0YXJnZXRVdWlkKSB7XHJcbiAgICAgICAgICAgICAgICAvLyBQZXJzaXN0IHRoZSByZWNvdmVyeSBpZGVudGl0eSBiZWZvcmUgdmVyaWZpZWRQcmVmYWJSZWNvcmQgbWF5XHJcbiAgICAgICAgICAgICAgICAvLyBjb21taXQgYW5kIGNsZWFyIHBlbmRpbmcuIEEgbGF0ZXIgbW92ZSBmYWlsdXJlIG11c3Qgc3RpbGwgYmVcclxuICAgICAgICAgICAgICAgIC8vIGFibGUgdG8gbG9jYXRlIHRoZSBleGFjdCBQcmVmYWIgYnkgVVVJRCBvbiB0aGUgbmV4dCBhdHRlbXB0LlxyXG4gICAgICAgICAgICAgICAgYXdhaXQgc2V0UHJlZmFiQmluZGluZyhzb3VyY2VIYXNoLCB0YXJnZXRVdWlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHZlcmlmaWVkUHJlZmFiUmVjb3JkKHRhcmdldEluZm8sIHNvdXJjZUhhc2gpO1xyXG4gICAgICAgICAgICBpZiAodGFyZ2V0SW5mby51cmwgIT09IHByZWZhYlVybCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29uZmxpY3QgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoY29uZmxpY3QgJiYgY29uZmxpY3QudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgYEZpZ21hIEZyYW1lIOWvueW6lOeahCBQcmVmYWIg6ZyA6KaB56e75Yqo5YiwICR7cHJlZmFiVXJsfe+8jOS9huebruagh+i3r+W+hOW3suiiq+WFtuS7lui1hOa6kOWNoOeUqOOAgmAsXHJcbiAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmICghY29uZmxpY3QpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBtb3ZlZCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdhc3NldC1kYicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdtb3ZlLWFzc2V0JyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mby51cmwsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeyBvdmVyd3JpdGU6IGZhbHNlLCByZW5hbWU6IGZhbHNlIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgKSBhcyBQcmVmYWJBc3NldEluZm8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbW92ZWQgfHwgbW92ZWQudXVpZCAhPT0gdGFyZ2V0VXVpZCkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYOaXoOazleWcqOS/neeVmSBVVUlEIOeahOWJjeaPkOS4i+enu+WKqCBQcmVmYWLvvJoke3ByZWZhYlVybH1gKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0SW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIHRhcmdldFV1aWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICB0YXJnZXRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgdGFyZ2V0VXVpZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGluZm86IHRhcmdldEluZm8sXHJcbiAgICAgICAgICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgbGV0IGluZm8gPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZWZhYlVybCk7XHJcbiAgICBpZiAoIWluZm8pIHtcclxuICAgICAgICBjb25zdCByb290RmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCByb290VHJhbnNmb3JtRmlsZUlkID0gY29jb3NGaWxlSWQoKTtcclxuICAgICAgICBjb25zdCBzZWVkID0gY3JlYXRlTWluaW1hbFByZWZhYkpzb24oXHJcbiAgICAgICAgICAgIHByZWZhYk5hbWUsXHJcbiAgICAgICAgICAgIHJvb3RGcmFtZSxcclxuICAgICAgICAgICAgcm9vdEZpbGVJZCxcclxuICAgICAgICAgICAgcm9vdFRyYW5zZm9ybUZpbGVJZCxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnY3JlYXRlLWFzc2V0JyxcclxuICAgICAgICAgICAgcHJlZmFiVXJsLFxyXG4gICAgICAgICAgICBzZWVkLFxyXG4gICAgICAgICAgICB7IG92ZXJ3cml0ZTogZmFsc2UsIHJlbmFtZTogZmFsc2UgfSxcclxuICAgICAgICApIGFzIFByZWZhYkFzc2V0SW5mbyB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFjcmVhdGVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihg5peg5rOV5Yib5bu6IFByZWZhYu+8miR7cHJlZmFiVXJsfWApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZWZhYlVybCwgY3JlYXRlZC51dWlkKTtcclxuICAgICAgICBjb25zdCBtZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgcmVjb3JkID0gY3JlYXRlUHJlZmFiU3luY1JlY29yZChcclxuICAgICAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICAgICAgc291cmNlUm9vdElkLFxyXG4gICAgICAgICAgICByb290RmlsZUlkLFxyXG4gICAgICAgICAgICByb290VHJhbnNmb3JtRmlsZUlkLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmV4dE1ldGEgPSBtZXJnZVByZWZhYlN5bmNSZWNvcmQobWV0YSwgcmVjb3JkKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KFxyXG4gICAgICAgICAgICAnYXNzZXQtZGInLFxyXG4gICAgICAgICAgICAnc2F2ZS1hc3NldC1tZXRhJyxcclxuICAgICAgICAgICAgaW5mby51dWlkLFxyXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShuZXh0TWV0YSwgbnVsbCwgMiksXHJcbiAgICAgICAgKTtcclxuICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdhc3NldC1kYicsICdyZWltcG9ydC1hc3NldCcsIGluZm8udXVpZCk7XHJcbiAgICAgICAgaW5mbyA9IGF3YWl0IHdhaXRGb3JQcmVmYWJBc3NldChwcmVmYWJVcmwsIGluZm8udXVpZCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgICAgICBhd2FpdCBzZXRQcmVmYWJCaW5kaW5nKHNvdXJjZUhhc2gsIGluZm8udXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgaW5mbyxcclxuICAgICAgICAgICAgcmVjb3JkOiB2ZXJpZmllZC5yZWNvcmQsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuICAgIGluZm8gPSBhd2FpdCB3YWl0Rm9yUHJlZmFiQXNzZXQocHJlZmFiVXJsLCBpbmZvLnV1aWQpO1xyXG4gICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCB2ZXJpZmllZFByZWZhYlJlY29yZChpbmZvLCBzb3VyY2VIYXNoKTtcclxuICAgIGF3YWl0IHNldFByZWZhYkJpbmRpbmcoc291cmNlSGFzaCwgaW5mby51dWlkKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaW5mbyxcclxuICAgICAgICByZWNvcmQ6IHZlcmlmaWVkLnJlY29yZCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKGFyZ3M6IHtcclxuICAgIHByZWZhYlVybDogc3RyaW5nO1xyXG4gICAgcHJlZmFiTmFtZTogc3RyaW5nO1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgc291cmNlTm9kZUlkOiBzdHJpbmc7XHJcbiAgICByb290RnJhbWU6IFJlY3Q7XHJcbiAgICBzY2FsZTogbnVtYmVyO1xyXG4gICAgcm9vdHM6IFNjZW5lTm9kZVNwZWNbXTtcclxufSk6IFByb21pc2U8U2NlbmVJbXBvcnRSZXN1bHQ+IHtcclxuICAgIGNvbnN0IHNvdXJjZUhhc2ggPSBmaWdtYUZyYW1lU291cmNlSGFzaChhcmdzLmZpbGVLZXksIGFyZ3Muc291cmNlTm9kZUlkKTtcclxuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgcHJlcGFyZUxpbmtlZEZyYW1lUHJlZmFiKFxyXG4gICAgICAgIGFyZ3MucHJlZmFiVXJsLFxyXG4gICAgICAgIGFyZ3MucHJlZmFiTmFtZSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIHg6IGFyZ3Mucm9vdEZyYW1lLnggKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgICAgICB5OiBhcmdzLnJvb3RGcmFtZS55ICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgd2lkdGg6IGFyZ3Mucm9vdEZyYW1lLndpZHRoICogYXJncy5zY2FsZSxcclxuICAgICAgICAgICAgaGVpZ2h0OiBhcmdzLnJvb3RGcmFtZS5oZWlnaHQgKiBhcmdzLnNjYWxlLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAgc291cmNlSGFzaCxcclxuICAgICAgICBhcmdzLnJvb3RzWzBdLmZpZ21hSWQsXHJcbiAgICApO1xyXG4gICAgYXdhaXQgd2FpdEZvck9wZW5lZFByZWZhYihcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnVybCxcclxuICAgICAgICBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgcHJlcGFyZWQucmVjb3JkLnJvb3RGaWxlSWQsXHJcbiAgICApO1xyXG4gICAgY29uc3QgZXhpc3RpbmdOb2RlRmlsZUlkcyA9IHJlc29sdmVFeGlzdGluZ05vZGVGaWxlSWRzKFxyXG4gICAgICAgIHByZXBhcmVkLnJlY29yZCxcclxuICAgICAgICBjb2xsZWN0U2NlbmVTcGVjRmlnbWFJZHMoYXJncy5yb290cyksXHJcbiAgICApO1xyXG4gICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgIHBhY2thZ2VOYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgIGZpbGVLZXk6IGFyZ3MuZmlsZUtleSxcclxuICAgICAgICByb290TmFtZTogYXJncy5wcmVmYWJOYW1lLFxyXG4gICAgICAgIHJvb3RGcmFtZTogYXJncy5yb290RnJhbWUsXHJcbiAgICAgICAgc2NhbGU6IGFyZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgZXhpc3RpbmdNYXA6IHt9LFxyXG4gICAgICAgIHByZWZhYlVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgcm9vdHM6IGFyZ3Mucm9vdHMsXHJcbiAgICAgICAgcHJlZmFiQ29udGV4dDoge1xyXG4gICAgICAgICAgICBwcmVmYWJVdWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHJvb3RGaWxlSWQ6IHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkLFxyXG4gICAgICAgICAgICBleGlzdGluZ05vZGVGaWxlSWRzLFxyXG4gICAgICAgICAgICBtYW5hZ2VkTm9kZUZpbGVJZHM6IHByZXBhcmVkLnJlY29yZC5tYW5hZ2VkTm9kZUZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRDb21wb25lbnRGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZENvbXBvbmVudEZpbGVJZHMsXHJcbiAgICAgICAgICAgIG1hbmFnZWRIZWxwZXJGaWxlSWRzOiBwcmVwYXJlZC5yZWNvcmQubWFuYWdlZEhlbHBlckZpbGVJZHMsXHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbiAgICBsZXQgc25hcHNob3RTdGFydGVkID0gZmFsc2U7XHJcbiAgICBsZXQgc2F2ZUF0dGVtcHRlZCA9IGZhbHNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkaXJ0eUJlZm9yZUltcG9ydCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3F1ZXJ5LWRpcnR5JykgYXMgYm9vbGVhbjtcclxuICAgICAgICBpZiAoZGlydHlCZWZvcmVJbXBvcnQpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfnm67moIcgUHJlZmFiIOacieacquS/neWtmOeahOaJi+W3peS/ruaUue+8jOivt+WFiOS/neWtmOWQjuWGjeaJp+ihjCBGaWdtYSDlop7ph4/lr7zlhaXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBzbmFwc2hvdFN0YXJ0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBwYWNrYWdlSlNPTi5uYW1lLFxyXG4gICAgICAgICAgICBtZXRob2Q6ICdpbXBvcnREb2N1bWVudCcsXHJcbiAgICAgICAgICAgIGFyZ3M6IFtwYXlsb2FkXSxcclxuICAgICAgICB9KSBhcyBTY2VuZUltcG9ydFJlc3VsdDtcclxuICAgICAgICBpZiAoIXJlc3VsdC5wcmVmYWJTeW5jKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignUHJlZmFiIOWinumHj+WQjOatpeacqui/lOWbniBmaWxlSWQg6K6w5b2V77yM5bey5YGc5q2i5L+d5a2Y44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5leHRSZWNvcmQgPSByZWNvcmRQcmVmYWJTeW5jQ2FwdHVyZShwcmVwYXJlZC5yZWNvcmQsIHJlc3VsdC5wcmVmYWJTeW5jKTtcclxuICAgICAgICBhd2FpdCBzZXRQZW5kaW5nUHJlZmFiU3luYyhzb3VyY2VIYXNoLCB7XHJcbiAgICAgICAgICAgIHByZWZhYlV1aWQ6IHByZXBhcmVkLmluZm8udXVpZCxcclxuICAgICAgICAgICAgcmVjb3JkOiBuZXh0UmVjb3JkLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGF3YWl0IGFzc2VydE9wZW5lZFByZWZhYihwcmVwYXJlZC5pbmZvLnV1aWQsIHByZXBhcmVkLnJlY29yZC5yb290RmlsZUlkKTtcclxuICAgICAgICAvLyBPbmNlIHRoZSBzYXZlIHJlcXVlc3QgaXMgc2VudCBpdHMgcmVzdWx0IGlzIGFtYmlndW91cyB1bnRpbCB0aGVcclxuICAgICAgICAvLyBwZXJzaXN0ZWQgUHJlZmFiIGlzIHZlcmlmaWVkLiBEbyBub3Qgcm9sbCB0aGUgaW4tbWVtb3J5IFByZWZhYiBiYWNrXHJcbiAgICAgICAgLy8gb24gYW4gSVBDIHRpbWVvdXQ6IHRoZSBkaXNrIHdyaXRlIG1heSBhbHJlYWR5IGhhdmUgY29tcGxldGVkLlxyXG4gICAgICAgIHNhdmVBdHRlbXB0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ3NhdmUtc2NlbmUnKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yU2NlbmVTYXZlZCgpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRJbmZvID0gYXdhaXQgd2FpdEZvclByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIGlmICghYXdhaXQgc3RvcmVkUHJlZmFiTWF0Y2hlc1JlY29yZChjdXJyZW50SW5mbywgbmV4dFJlY29yZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdQcmVmYWIg5paH5Lu25pyq5YyF5ZCr5pys5qyh5ZCM5q2l55Sf5oiQ55qE5YWo6YOoIGZpbGVJZO+8jOW3suWBnOatouabtOaWsCBNZXRh44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRNZXRhID0gYXdhaXQgcXVlcnlQcmVmYWJNZXRhKGN1cnJlbnRJbmZvLnV1aWQpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSZWNvcmQgPSByZWFkUHJlZmFiU3luY1JlY29yZChjdXJyZW50TWV0YSk7XHJcbiAgICAgICAgaWYgKCFjdXJyZW50UmVjb3JkIHx8IGN1cnJlbnRSZWNvcmQuc291cmNlSGFzaCAhPT0gc291cmNlSGFzaCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1ByZWZhYiDmnaXmupDorrDlvZXlnKjkv53lrZjmnJ/pl7Tlj5HnlJ/lj5jljJbvvIzlt7Lmi5Lnu53mj5DkuqTjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgd3JpdGVWZXJpZmllZFByZWZhYlJlY29yZChjdXJyZW50SW5mbywgc291cmNlSGFzaCwgbmV4dFJlY29yZCk7XHJcbiAgICAgICAgYXdhaXQgc2V0UGVuZGluZ1ByZWZhYlN5bmMoc291cmNlSGFzaCwgbnVsbCk7XHJcbiAgICAgICAgY29uc3QgdmVyaWZpZWQgPSBhd2FpdCBxdWVyeVByZWZhYkFzc2V0KHByZXBhcmVkLmluZm8udXJsKTtcclxuICAgICAgICBpZiAoIXZlcmlmaWVkKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcign5L+d5a2Y5ZCOIFByZWZhYiBVVUlEIOagoemqjOWksei0peOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhc3NlcnRQcmVmYWJBc3NldCh2ZXJpZmllZCwge1xyXG4gICAgICAgICAgICB1dWlkOiBwcmVwYXJlZC5pbmZvLnV1aWQsXHJcbiAgICAgICAgICAgIHVybDogcHJlcGFyZWQuaW5mby51cmwsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmVzdWx0LnByZWZhYlVybCA9IHByZXBhcmVkLmluZm8udXJsO1xyXG4gICAgICAgIEVkaXRvci5TZWxlY3Rpb24uY2xlYXIoJ25vZGUnKTtcclxuICAgICAgICBFZGl0b3IuU2VsZWN0aW9uLnNlbGVjdCgnYXNzZXQnLCBwcmVwYXJlZC5pbmZvLnV1aWQpO1xyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChzbmFwc2hvdFN0YXJ0ZWQgJiYgIXNhdmVBdHRlbXB0ZWQpIHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QtYWJvcnQnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcGVyZm9ybUltcG9ydChyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KTogUHJvbWlzZTxTY2VuZUltcG9ydFJlc3VsdD4ge1xyXG4gICAgaWYgKCFhY3RpdmVEb2N1bWVudCkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcign6K+35YWI6K+75Y+WIEZpZ21hIOaWh+S7tuOAgicpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1wb3J0U2V0dGluZ3MgPSBzYWZlU2V0dGluZ3MocmVxdWVzdC5zZXR0aW5ncyk7XHJcbiAgICBhd2FpdCBzYXZlU2V0dGluZ3MoaW1wb3J0U2V0dGluZ3MpO1xyXG4gICAgYmVnaW5PcGVyYXRpb24oKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+WIhuaekOW5tuWHhuWkh+i1hOa6kOKApicgfSk7XHJcbiAgICAgICAgY29uc3QgZGVjaXNpb25zID0gZGVjaXNpb25NYXAocmVxdWVzdC5vdmVycmlkZXMsIGFjdGl2ZURvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGNvbnN0IGFzc2V0cyA9IGF3YWl0IGJ1aWxkQXNzZXRzKGFjdGl2ZURvY3VtZW50LCBkZWNpc2lvbnMsIGltcG9ydFNldHRpbmdzKTtcclxuICAgICAgICAvLyBidWlsZEFzc2V0cyBtYXkgcHJvbW90ZSBhIGNvbnRhaW5lciB0byBhIGxvY2FsIHNhbWUtbmFtZSByZXNvdXJjZS5cclxuICAgICAgICAvLyBDb21waWxlIGFmdGVyIHRoYXQgcHJvbW90aW9uIHNvIGFzc2V0cyBhbmQgU2NlbmVOb2RlU3BlYyBzaGFyZSB0aGVcclxuICAgICAgICAvLyBleGFjdCBzYW1lIGZpbmFsIHBsYW4uXHJcbiAgICAgICAgY29uc3QgcGxhbnMgPSBjb21waWxlSW1wb3J0UGxhbihhY3RpdmVEb2N1bWVudC5yb290cywgZGVjaXNpb25zKTtcclxuICAgICAgICBjb25zdCBmb250cyA9IGF3YWl0IHJlc29sdmVGb250cyhpbXBvcnRTZXR0aW5ncyk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlUm9vdEZyYW1lcyA9IGFjdGl2ZURvY3VtZW50LnJvb3RzLm1hcChub2RlRnJhbWUpO1xyXG4gICAgICAgIGNvbnN0IG11bHRpcGxlUm9vdHMgPSBhY3RpdmVEb2N1bWVudC5yb290cy5sZW5ndGggPiAxO1xyXG4gICAgICAgIGNvbnN0IGFycmFuZ2VkV2lkdGggPSBtdWx0aXBsZVJvb3RzXHJcbiAgICAgICAgICAgID8gc291cmNlUm9vdEZyYW1lcy5yZWR1Y2UoKHRvdGFsLCBmcmFtZSkgPT4gdG90YWwgKyBmcmFtZS53aWR0aCwgMClcclxuICAgICAgICAgICAgICAgICsgTWF0aC5tYXgoMCwgc291cmNlUm9vdEZyYW1lcy5sZW5ndGggLSAxKSAqIDE2MFxyXG4gICAgICAgICAgICA6IHNvdXJjZVJvb3RGcmFtZXNbMF0/LndpZHRoID8/IDA7XHJcbiAgICAgICAgY29uc3Qgcm9vdEZyYW1lID0gbXVsdGlwbGVSb290c1xyXG4gICAgICAgICAgICA/IHtcclxuICAgICAgICAgICAgICAgIHg6IDAsXHJcbiAgICAgICAgICAgICAgICB5OiAwLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGFycmFuZ2VkV2lkdGgsXHJcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IE1hdGgubWF4KDAsIC4uLnNvdXJjZVJvb3RGcmFtZXMubWFwKChmcmFtZSkgPT4gZnJhbWUuaGVpZ2h0KSksXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgOiBzb3VyY2VSb290RnJhbWVzWzBdID8/IHsgeDogMCwgeTogMCwgd2lkdGg6IDAsIGhlaWdodDogMCB9O1xyXG4gICAgICAgIGxldCByb290Q3Vyc29yID0gMDtcclxuICAgICAgICBjb25zdCByb290cyA9IGFjdGl2ZURvY3VtZW50LnJvb3RzXHJcbiAgICAgICAgICAgIC5tYXAoKG5vZGUsIGluZGV4KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBzcGVjID0gbWFrZVNwZWMoXHJcbiAgICAgICAgICAgICAgICAgICAgbm9kZSxcclxuICAgICAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgZGVjaXNpb25zLFxyXG4gICAgICAgICAgICAgICAgICAgIHBsYW5zLFxyXG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZURvY3VtZW50IS5ub2RlQnlJZCxcclxuICAgICAgICAgICAgICAgICAgICBhc3NldHMsXHJcbiAgICAgICAgICAgICAgICAgICAgZm9udHMsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICBpZiAoc3BlYyAmJiBtdWx0aXBsZVJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3BlYy5mcmFtZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogcm9vdEN1cnNvcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgeTogMCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2lkdGg6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLndpZHRoLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IHNvdXJjZVJvb3RGcmFtZXNbaW5kZXhdLmhlaWdodCxcclxuICAgICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDdXJzb3IgKz0gc291cmNlUm9vdEZyYW1lc1tpbmRleF0ud2lkdGggKyAxNjA7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gc3BlYztcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgLmZpbHRlcigobm9kZSk6IG5vZGUgaXMgU2NlbmVOb2RlU3BlYyA9PiBub2RlICE9PSBudWxsKTtcclxuICAgICAgICBpZiAoIXJvb3RzLmxlbmd0aCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+ayoeaciemAieS4reS7u+S9leWPr+WvvOWFpeiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3Qgc291cmNlTm9kZUlkID0gYWN0aXZlRG9jdW1lbnQuc291cmNlTm9kZUlkO1xyXG4gICAgICAgIGlmIChzb3VyY2VOb2RlSWQgJiYgcm9vdHMubGVuZ3RoID09PSAxKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHByZWZhYldyaXRlciA9IG5ldyBBc3NldFdyaXRlcihpbXBvcnRTZXR0aW5ncy5wcmVmYWJGb2xkZXIpO1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVmYWJXcml0ZXIuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgICAgICBjb25zdCBmcmFtZU5hbWUgPSByb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBhY3RpdmVEb2N1bWVudC5yb290c1swXT8ubmFtZT8udHJpbSgpXHJcbiAgICAgICAgICAgICAgICB8fCBhY3RpdmVEb2N1bWVudC5maWxlTmFtZTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmFiVXJsID0gYGRiOi8vYXNzZXRzLyR7cHJlZmFiV3JpdGVyLmZvbGRlcn0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUpfS5wcmVmYWJgO1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdzY2VuZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMC4wNSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6ICfmraPlnKjliJvlu7rmiJbmiZPlvIDnm67moIcgUHJlZmFi4oCmJyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGltcG9ydExpbmtlZEZyYW1lUHJlZmFiKHtcclxuICAgICAgICAgICAgICAgIHByZWZhYlVybCxcclxuICAgICAgICAgICAgICAgIHByZWZhYk5hbWU6IGZyYW1lTmFtZSxcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGFjdGl2ZURvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VOb2RlSWQsXHJcbiAgICAgICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgICAgICBzY2FsZTogaW1wb3J0U2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgICAgICAgICByb290cyxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVNYXBzID0gYXdhaXQgZ2V0Tm9kZU1hcHMoKTtcclxuICAgICAgICAgICAgLy8gUHJlZmFiIHVwZGF0ZXMgcGVyc2lzdCBieSBQcmVmYWJJbmZvLmZpbGVJZCBpbiB0aGUgYXNzZXQgbWV0YTtcclxuICAgICAgICAgICAgLy8gcnVudGltZSBub2RlIFVVSURzIGFyZSBzZXNzaW9uLW9ubHkgYW5kIG11c3QgbmV2ZXIgYmUgcmV1c2VkIGhlcmUuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBub2RlTWFwc1thY3RpdmVEb2N1bWVudC5maWxlS2V5XTtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0UHJvamVjdChwYWNrYWdlSlNPTi5uYW1lLCAnbm9kZU1hcHMnLCBub2RlTWFwcywgJ3Byb2plY3QnKTtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMSxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGDlrozmiJDvvJrmlrDlu7ogJHtyZXN1bHQuY3JlYXRlZH3vvIzmm7TmlrAgJHtyZXN1bHQudXBkYXRlZH3vvIzlt7LmiZPlvIDpooTliLbkvZMgJHtwcmVmYWJVcmx9YCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBub2RlTWFwcyA9IGF3YWl0IGdldE5vZGVNYXBzKCk7XHJcbiAgICAgICAgY29uc3QgcGF5bG9hZDogU2NlbmVJbXBvcnRQYXlsb2FkID0ge1xyXG4gICAgICAgICAgICBwYWNrYWdlTmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgZmlsZUtleTogYWN0aXZlRG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgcm9vdE5hbWU6IGFjdGl2ZURvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICByb290RnJhbWUsXHJcbiAgICAgICAgICAgIHNjYWxlOiBpbXBvcnRTZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGltcG9ydFNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxyXG4gICAgICAgICAgICBleGlzdGluZ01hcDogbm9kZU1hcHNbYWN0aXZlRG9jdW1lbnQuZmlsZUtleV0gPz8ge30sXHJcbiAgICAgICAgICAgIHJvb3RzLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdzY2VuZScsIHZhbHVlOiAwLjEsIG1lc3NhZ2U6ICfmraPlnKjmnoTlu7ogQ29jb3Mg6IqC54K55qCR4oCmJyB9KTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdleGVjdXRlLXNjZW5lLXNjcmlwdCcsIHtcclxuICAgICAgICAgICAgbmFtZTogcGFja2FnZUpTT04ubmFtZSxcclxuICAgICAgICAgICAgbWV0aG9kOiAnaW1wb3J0RG9jdW1lbnQnLFxyXG4gICAgICAgICAgICBhcmdzOiBbcGF5bG9hZF0sXHJcbiAgICAgICAgfSkgYXMgU2NlbmVJbXBvcnRSZXN1bHQ7XHJcbiAgICAgICAgYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnc25hcHNob3QnKTtcclxuICAgICAgICBub2RlTWFwc1thY3RpdmVEb2N1bWVudC5maWxlS2V5XSA9IHJlc3VsdC5ub2RlTWFwO1xyXG4gICAgICAgIGF3YWl0IEVkaXRvci5Qcm9maWxlLnNldFByb2plY3QocGFja2FnZUpTT04ubmFtZSwgJ25vZGVNYXBzJywgbm9kZU1hcHMsICdwcm9qZWN0Jyk7XHJcbiAgICAgICAgRWRpdG9yLlNlbGVjdGlvbi5zZWxlY3QoJ25vZGUnLCByZXN1bHQucm9vdFV1aWQpO1xyXG4gICAgICAgIGlmIChpbXBvcnRTZXR0aW5ncy5hdXRvU2F2ZSkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KCdzY2VuZScsICdzYXZlLXNjZW5lJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGVtaXRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgIHBoYXNlOiAnZG9uZScsXHJcbiAgICAgICAgICAgIHZhbHVlOiAxLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBg5a6M5oiQ77ya5paw5bu6ICR7cmVzdWx0LmNyZWF0ZWR977yM5pu05pawICR7cmVzdWx0LnVwZGF0ZWR9YCxcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBDYW5jZWxsZWRFcnJvciB8fCBhY3RpdmVDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3MoeyBwaGFzZTogJ2NhbmNlbGxlZCcsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5bey5Y+W5raI44CCJyB9KTtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfmk43kvZzlt7Llj5bmtojjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZW1pdFByb2dyZXNzKHtcclxuICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgIHZhbHVlOiAwLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICflr7zlhaXlpLHotKXjgIInLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRocm93IGVycm9yO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBmaW5pc2hPcGVyYXRpb24oKTtcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHM6IFJlY29yZDxzdHJpbmcsICguLi5hcmdzOiBhbnlbXSkgPT4gYW55PiA9IHtcclxuICAgIG9wZW5QYW5lbCgpIHtcclxuICAgICAgICBFZGl0b3IuUGFuZWwub3BlbihwYWNrYWdlSlNPTi5uYW1lKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgZ2V0U3RhdGUoKSB7XHJcbiAgICAgICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHZlcnNpb246IHBhY2thZ2VKU09OLnZlcnNpb24sXHJcbiAgICAgICAgICAgIHZhdWx0OiB2YXVsdC5zdGF0dXMoKSxcclxuICAgICAgICAgICAgc2V0dGluZ3M6IGF3YWl0IGdldFNldHRpbmdzKCksXHJcbiAgICAgICAgICAgIGZvbnRBc3NldHM6IGF3YWl0IGxpc3RGb250QXNzZXRzKCksXHJcbiAgICAgICAgICAgIGRvY3VtZW50OiBhY3RpdmVEb2N1bWVudCA/IHtcclxuICAgICAgICAgICAgICAgIGZpbGVLZXk6IGFjdGl2ZURvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgICAgICBmaWxlTmFtZTogYWN0aXZlRG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgICAgICBzb3VyY2VVcmw6IGFjdGl2ZURvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgICAgIHRyZWU6IGFjdGl2ZURvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgICAgICBmb250czogYWN0aXZlRG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgICAgICBub2RlT3ZlcnJpZGVzOiBhd2FpdCBub2RlT3ZlcnJpZGVzRm9yKGFjdGl2ZURvY3VtZW50LmZpbGVLZXkpLFxyXG4gICAgICAgICAgICB9IDogbnVsbCxcclxuICAgICAgICB9O1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzZXRUb2tlbih2YWx1ZTogc3RyaW5nKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LnNldCh2YWx1ZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGNsZWFyVG9rZW4oKSB7XHJcbiAgICAgICAgcmV0dXJuIHZhdWx0LmNsZWFyKCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIHZlcmlmeVRva2VuKCkge1xyXG4gICAgICAgIGJlZ2luT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaWRlbnRpdHkgPSBhd2FpdCAoYXdhaXQgY2xpZW50KCkpLnZlcmlmeSgpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgb2s6IHRydWUsXHJcbiAgICAgICAgICAgICAgICBoYW5kbGU6IGlkZW50aXR5LmhhbmRsZSB8fCAnRmlnbWEgVXNlcicsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoT3BlcmF0aW9uKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gc2F2ZVNldHRpbmdzKHZhbHVlKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgc2F2ZU5vZGVPdmVycmlkZXMoZmlsZUtleTogdW5rbm93biwgb3ZlcnJpZGVzOiB1bmtub3duLCBzY29wZUlkczogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0Fzc2V0Rm9sZGVyKGN1cnJlbnQpO1xyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyBwaWNrUHJlZmFiRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja1ByZWZhYkZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudDogdW5rbm93bikge1xyXG4gICAgICAgIHJldHVybiBwaWNrTG9jYWxSZXNvdXJjZUZvbGRlcihjdXJyZW50KTtcclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcGlja0NhY2hlRm9sZGVyKGN1cnJlbnQ6IHVua25vd24pIHtcclxuICAgICAgICByZXR1cm4gcGlja0xvY2FsUmVzb3VyY2VGb2xkZXIoY3VycmVudCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpIHtcclxuICAgICAgICBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGVtaXRQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4xNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPliBGaWdtYSDmlofku7bigKYnIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGFwaSA9IGF3YWl0IGNsaWVudCgpO1xyXG4gICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gcGFyc2VkLm5vZGVJZFxyXG4gICAgICAgICAgICAgICAgPyBhd2FpdCBhcGkuZ2V0Tm9kZShwYXJzZWQuZmlsZUtleSwgcGFyc2VkLm5vZGVJZClcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgYXBpLmdldEZpbGUocGFyc2VkLmZpbGVLZXkpO1xyXG4gICAgICAgICAgICBhY3RpdmVEb2N1bWVudCA9IGFubm90YXRlRG9jdW1lbnRQbGFuKFxyXG4gICAgICAgICAgICAgICAgcGFyc2VEb2N1bWVudChwYXlsb2FkLCBzb3VyY2VVcmwsIHBhcnNlZC5maWxlS2V5LCBwYXJzZWQubm9kZUlkKSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGdldFNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIGF3YWl0IHNhdmVTZXR0aW5ncyh7IC4uLmN1cnJlbnQsIHNvdXJjZVVybCB9KTtcclxuICAgICAgICAgICAgZW1pdFByb2dyZXNzKHsgcGhhc2U6ICdpZGxlJywgdmFsdWU6IDEsIG1lc3NhZ2U6IGDlt7Lor7vlj5YgJHthY3RpdmVEb2N1bWVudC5maWxlTmFtZX1gIH0pO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgZmlsZUtleTogYWN0aXZlRG9jdW1lbnQuZmlsZUtleSxcclxuICAgICAgICAgICAgICAgIGZpbGVOYW1lOiBhY3RpdmVEb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZVVybCxcclxuICAgICAgICAgICAgICAgIHRyZWU6IGFjdGl2ZURvY3VtZW50LnRyZWUsXHJcbiAgICAgICAgICAgICAgICBmb250czogYWN0aXZlRG9jdW1lbnQuZm9udHMsXHJcbiAgICAgICAgICAgICAgICBmb250QXNzZXRzOiBhd2FpdCBsaXN0Rm9udEFzc2V0cygpLFxyXG4gICAgICAgICAgICAgICAgbm9kZU92ZXJyaWRlczogYXdhaXQgbm9kZU92ZXJyaWRlc0ZvcihhY3RpdmVEb2N1bWVudC5maWxlS2V5KSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBlbWl0UHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgICAgcGhhc2U6ICdlcnJvcicsXHJcbiAgICAgICAgICAgICAgICB2YWx1ZTogMCxcclxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+ivu+WPluWksei0peOAgicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hPcGVyYXRpb24oKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpIHtcclxuICAgICAgICBpZiAoIWFjdGl2ZURvY3VtZW50Py5ub2RlQnlJZC5oYXMobm9kZUlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ+mihOiniOiKgueCueS4jeWtmOWcqOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBiZWdpbk9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybHMgPSBhd2FpdCAoYXdhaXQgY2xpZW50KCkpLmdldEltYWdlVXJscyhhY3RpdmVEb2N1bWVudC5maWxlS2V5LCBbbm9kZUlkXSwgJ3BuZycsIDEpO1xyXG4gICAgICAgICAgICBpZiAoIXVybHNbbm9kZUlkXSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCfml6Dms5XnlJ/miJDoioLngrnpooTop4jjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4geyB1cmw6IHVybHNbbm9kZUlkXSB9O1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIGZpbmlzaE9wZXJhdGlvbigpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwRGV0ZWN0KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmRldGVjdChzb3VyY2VVcmwsIGV4cGxpY2l0Um9vdElkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBQcmV2aWV3KHNvdXJjZVVybDogc3RyaW5nLCBleHBsaWNpdFJvb3RJZD86IHN0cmluZykge1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnByZXZpZXcoc291cmNlVXJsLCBleHBsaWNpdFJvb3RJZCk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgYXN5bmMgcm91bmR0cmlwUGFpcihwYWlyVG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLnBhaXIocGFpclRva2VuKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBmaW5pc2hSb3VuZHRyaXBPcGVyYXRpb24oY29udHJvbGxlcik7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuXHJcbiAgICBhc3luYyByb3VuZHRyaXBBcHBseShwcmV2aWV3VG9rZW46IHN0cmluZykge1xyXG4gICAgICAgIGlmIChyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpIHRocm93IG5ldyBFcnJvcihyb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIpO1xyXG4gICAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBiZWdpblJvdW5kdHJpcE9wZXJhdGlvbigpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCAoYXdhaXQgcm91bmR0cmlwU2VydmljZShjb250cm9sbGVyLnNpZ25hbCkpLmFwcGx5KHByZXZpZXdUb2tlbik7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgZmluaXNoUm91bmR0cmlwT3BlcmF0aW9uKGNvbnRyb2xsZXIpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgcm91bmR0cmlwQ2FuY2VsKCkge1xyXG4gICAgICAgIHJvdW5kdHJpcENvbnRyb2xsZXI/LmFib3J0KCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGFzeW5jIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIHBlcmZvcm1JbXBvcnQocmVxdWVzdCk7XHJcbiAgICB9LFxyXG5cclxuICAgIGNhbmNlbEltcG9ydCgpIHtcclxuICAgICAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgfSxcclxufTtcclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgdmF1bHQuaW5pdGlhbGl6ZSgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZWNvdmVySW50ZXJydXB0ZWRUcmFuc2FjdGlvbnMoRWRpdG9yLlByb2plY3QucGF0aCwgZWRpdG9yUmVpbXBvcnRlcik7XHJcbiAgICAgICAgY29uc3QgYWN0aXZlID0gcmVjb3ZlcmVkLmZpbHRlcigocmVzdWx0KSA9PiByZXN1bHQuc3RhdHVzID09PSAnYWN0aXZlLW93bmVyJyk7XHJcbiAgICAgICAgcm91bmR0cmlwUmVjb3ZlcnlCbG9ja2VyID0gYWN0aXZlLmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDmo4DmtYvliLAgJHthY3RpdmUubGVuZ3RofSDkuKrku43nlLHmtLvliqjov5vnqIvmjIHmnInnmoQgUm91bmQtdHJpcCDkuovliqHvvIzmmoLml7bnpoHmraIgUGFpci9BcHBseeOAgmBcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICByb3VuZHRyaXBSZWNvdmVyeUJsb2NrZXIgPSBgUm91bmQtdHJpcCDlkK/liqjmgaLlpI3lpLHotKXvvJoke2Vycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+acquefpemUmeivryd9YDtcclxuICAgICAgICBjb25zb2xlLmVycm9yKHJvdW5kdHJpcFJlY292ZXJ5QmxvY2tlcik7XHJcbiAgICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKTogdm9pZCB7XHJcbiAgICBhY3RpdmVDb250cm9sbGVyPy5hYm9ydCgpO1xyXG4gICAgYWN0aXZlQ29udHJvbGxlciA9IG51bGw7XHJcbiAgICBhY3RpdmVEb2N1bWVudCA9IG51bGw7XHJcbn1cclxuIl19