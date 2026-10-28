"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FigmaImporterMcpApi = void 0;
exports.indexTree = indexTree;
const crypto_1 = require("crypto");
const path_1 = require("path");
const import_actions_1 = require("./import-actions");
const url_1 = require("./figma/url");
const node_name_1 = require("./node-name");
const model_1 = require("./panels/default/model");
const protocol_1 = require("./mcp-bridge/protocol");
function publicSettings(settings) {
    return {
        sourceUrl: settings.sourceUrl,
        assetFolder: settings.assetFolder,
        prefabFolder: settings.prefabFolder,
        scale: settings.scale,
        updateExisting: settings.updateExisting,
        refreshAssets: settings.refreshAssets,
        autoSave: settings.autoSave,
        importHiddenLayers: settings.importHiddenLayers !== false,
        fontMap: { ...settings.fontMap },
    };
}
const IMPORT_ACTIONS = new Set(['ignore', 'generate', 'render', 'transform']);
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
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new protocol_1.McpBridgeError('INVALID_REQUEST', '工具参数必须是对象。');
    }
    return value;
}
function requiredString(value, label, maxLength = 2048) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new protocol_1.McpBridgeError('INVALID_REQUEST', `${label} 不能为空。`);
    }
    const result = value.trim();
    if (result.length > maxLength) {
        throw new protocol_1.McpBridgeError('INVALID_REQUEST', `${label} 超过 ${maxLength} 字符限制。`);
    }
    return result;
}
function optionalStringArray(value, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new protocol_1.McpBridgeError('INVALID_REQUEST', `${label} 必须是字符串数组。`);
    }
    return value;
}
function boundedInteger(value, fallback, min, max, label) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new protocol_1.McpBridgeError('INVALID_REQUEST', `${label} 必须是 ${min}–${max} 之间的整数。`);
    }
    return value;
}
function encodeCursor(sessionId, revision, offset, queryHash) {
    return Buffer.from(JSON.stringify({ sessionId, revision, offset, queryHash }), 'utf8').toString('base64url');
}
function decodeCursor(value, sessionId, revision, queryHash) {
    if (value === undefined || value === null || value === '')
        return 0;
    if (typeof value !== 'string' || value.length > 512) {
        throw new protocol_1.McpBridgeError('INVALID_CURSOR', '分页 cursor 无效。');
    }
    try {
        const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (decoded.sessionId !== sessionId || decoded.revision !== revision || decoded.queryHash !== queryHash
            || typeof decoded.offset !== 'number' || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
            throw new Error('cursor mismatch');
        }
        return decoded.offset;
    }
    catch {
        throw new protocol_1.McpBridgeError('INVALID_CURSOR', '分页 cursor 已失效，请从第一页重新查询。');
    }
}
function stableHash(value) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function settingsFingerprint(settings) {
    return {
        sourceUrl: settings.sourceUrl,
        assetFolder: settings.assetFolder,
        prefabFolder: settings.prefabFolder,
        localResourceFolders: [...settings.localResourceFolders],
        scale: settings.scale,
        updateExisting: settings.updateExisting,
        refreshAssets: settings.refreshAssets,
        autoSave: settings.autoSave,
        importHiddenLayers: settings.importHiddenLayers !== false,
        fontMap: Object.entries(settings.fontMap).sort(([left], [right]) => left.localeCompare(right)),
    };
}
function importRequestFingerprint(document, settings, overrides) {
    return stableHash({
        fileKey: document.fileKey,
        sourceUrl: document.sourceUrl,
        settings: settingsFingerprint(settings),
        overrides: overrides.map((item) => {
            var _a;
            return ({
                id: item.id,
                action: item.action,
                kind: item.kind,
                nineSlice: item.nineSlice,
                explicit: item.explicit === true,
                name: (_a = item.name) !== null && _a !== void 0 ? _a : null,
            });
        }),
    });
}
function safeRelativeAssetFolder(value, label) {
    const folder = requiredString(value, label, 256).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if ((0, path_1.isAbsolute)(folder) || folder.startsWith('/') || folder.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new protocol_1.McpBridgeError('INVALID_SETTINGS', `${label} 必须是 assets 下的相对子目录。`);
    }
    return folder;
}
function indexTree(roots) {
    const result = [];
    const visit = (node, parentNodeId, depth, path) => {
        const nextPath = [...path, node.name];
        result.push({ node, parentNodeId, depth, path: nextPath });
        node.children.forEach((child) => visit(child, node.id, depth + 1, nextPath));
    };
    roots.forEach((root) => visit(root, undefined, 0, []));
    return result;
}
function defaultOverride(node) {
    return {
        id: node.id,
        action: (0, model_1.smartActionForNode)(node),
        kind: node.kind,
        nineSlice: node.patchCandidate,
        explicit: false,
    };
}
function overrideMap(document) {
    return new Map(document.nodeOverrides.map((item) => [item.id, { ...item }]));
}
function resolvedImportOverrides(document, settings) {
    const nodes = indexTree(document.tree).map((item) => item.node);
    const saved = overrideMap(document);
    const preferredActions = new Map();
    const forcedRenderIds = new Set();
    for (const node of nodes) {
        const current = saved.get(node.id);
        preferredActions.set(node.id, (current === null || current === void 0 ? void 0 : current.explicit) === true ? (0, import_actions_1.normalizeImportAction)(current.action) : (0, model_1.smartActionForNode)(node));
        const nineSlice = (current === null || current === void 0 ? void 0 : current.explicit) === true ? current.nineSlice : node.patchCandidate;
        if (nineSlice && node.patchCandidate)
            forcedRenderIds.add(node.id);
    }
    const effective = (0, model_1.resolveEffectiveActions)(document.tree, preferredActions, forcedRenderIds, undefined, undefined, settings.importHiddenLayers !== false);
    return nodes.map((node) => {
        var _a;
        const current = saved.get(node.id);
        return {
            id: node.id,
            action: (_a = effective.actions.get(node.id)) !== null && _a !== void 0 ? _a : (0, model_1.smartActionForNode)(node),
            kind: (current === null || current === void 0 ? void 0 : current.explicit) === true ? current.kind : node.kind,
            nineSlice: (current === null || current === void 0 ? void 0 : current.explicit) === true ? current.nineSlice : node.patchCandidate,
            explicit: (current === null || current === void 0 ? void 0 : current.explicit) === true,
            ...((current === null || current === void 0 ? void 0 : current.name) ? { name: current.name } : {}),
        };
    });
}
function summarizeImportResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { completed: true };
    }
    const result = value;
    const summary = { completed: true };
    if (result.review && typeof result.review === 'object')
        summary.reviewAvailable = true;
    if (typeof result.created === 'number' && Number.isFinite(result.created))
        summary.created = result.created;
    if (typeof result.updated === 'number' && Number.isFinite(result.updated))
        summary.updated = result.updated;
    if (typeof result.prefabUrl === 'string')
        summary.prefabUrl = result.prefabUrl;
    if (typeof result.temporaryRoot === 'boolean')
        summary.temporaryRoot = result.temporaryRoot;
    if (Array.isArray(result.warnings)) {
        summary.warnings = result.warnings
            .filter((item) => typeof item === 'string')
            .slice(0, 100)
            .map((item) => item.slice(0, 512));
    }
    return summary;
}
class FigmaImporterMcpApi {
    constructor(host) {
        this.host = host;
        this.session = null;
        this.activeImport = null;
        this.importCancellationRequested = false;
        this.completedImports = new Map();
        this.settingsWriteQueue = Promise.resolve();
    }
    async invoke(method, params, signal) {
        switch (method) {
            case 'getStatus': return this.getStatus();
            case 'fetchDocument': return this.fetchDocument(params);
            case 'listNodes': return this.listNodes(params);
            case 'getPreview': return this.getPreview(params);
            case 'syncPreview': return this.syncPreview(params);
            case 'updateSettings': return this.updateSettings(params);
            case 'updateNodes': return this.updateNodes(params);
            case 'renameNodes': return this.renameNodes(params);
            case 'importDocument': return this.importDocument(params, signal);
            case 'cancelImport': return this.cancelImport(params);
            default: throw new protocol_1.McpBridgeError('METHOD_NOT_ALLOWED', '该 Bridge 方法未开放。');
        }
    }
    async getStatus() {
        var _a, _b;
        const state = await this.host.getState();
        const sessionValid = Boolean(this.session
            && this.session.hostRevision === this.host.getDocumentRevision()
            && ((_a = state.document) === null || _a === void 0 ? void 0 : _a.fileKey) === this.session.fileKey);
        return {
            connected: true,
            pluginVersion: state.version,
            creatorVersion: this.host.creatorVersion,
            projectPath: this.host.projectPath,
            token: {
                configured: state.vault.hasToken,
                persistent: state.vault.persistent,
                backend: state.vault.backend,
                ...(state.vault.warning ? { warning: state.vault.warning } : {}),
            },
            settings: publicSettings(state.settings),
            busy: this.activeImport !== null || this.host.isImportBusy(),
            document: state.document ? {
                fileName: state.document.fileName,
                sourceUrl: state.document.sourceUrl,
                nodeCount: indexTree(state.document.tree).length,
                documentSessionId: sessionValid ? (_b = this.session) === null || _b === void 0 ? void 0 : _b.id : undefined,
            } : null,
        };
    }
    async fetchDocument(params) {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', '当前已有操作正在执行，请等待或先取消。', true);
        }
        const input = record(params);
        const sourceUrl = requiredString(input.sourceUrl, 'sourceUrl');
        const state = await this.host.getState();
        if (!state.vault.hasToken) {
            throw new protocol_1.McpBridgeError('TOKEN_NOT_CONFIGURED', '尚未配置 Figma Personal Access Token。');
        }
        try {
            (0, url_1.parseFigmaSource)(sourceUrl);
        }
        catch {
            throw new protocol_1.McpBridgeError('INVALID_FIGMA_SOURCE', '仅支持有效的 figma.com 文件、设计、原型或 FigJam 链接。');
        }
        const document = await this.host.fetchDocument(sourceUrl);
        const id = (0, crypto_1.randomBytes)(18).toString('base64url');
        this.session = {
            id,
            hostRevision: this.host.getDocumentRevision(),
            revision: 0,
            fileKey: document.fileKey,
            sourceUrl: document.sourceUrl,
            rootIds: new Set(document.tree.map((node) => node.id)),
        };
        return {
            documentSessionId: id,
            fileName: document.fileName,
            sourceUrl: document.sourceUrl,
            nodeCount: indexTree(document.tree).length,
            fonts: document.fonts,
            roots: document.tree.map((node) => ({
                nodeId: node.id,
                name: node.name,
                type: node.type,
                width: node.width,
                height: node.height,
                childCount: node.children.length,
            })),
        };
    }
    async currentDocument(params) {
        const sessionId = requiredString(params.documentSessionId, 'documentSessionId', 256);
        const session = this.session;
        if (!session || session.id !== sessionId || session.hostRevision !== this.host.getDocumentRevision()) {
            throw new protocol_1.McpBridgeError('STALE_DOCUMENT_SESSION', '文档会话已失效，请重新读取 Figma 链接。');
        }
        const state = await this.host.getState();
        const document = state.document;
        if (!document || document.fileKey !== session.fileKey || document.sourceUrl !== session.sourceUrl) {
            throw new protocol_1.McpBridgeError('STALE_DOCUMENT_SESSION', '当前插件文档已变化，请重新读取 Figma 链接。');
        }
        return { session, document, state };
    }
    async syncPreview(params) {
        await this.currentDocument(record(params));
        return this.host.syncPreview();
    }
    async listNodes(params) {
        var _a;
        const input = record(params);
        const { session, document, state } = await this.currentDocument(input);
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item]));
        const rootNodeId = typeof input.rootNodeId === 'string' && input.rootNodeId.trim()
            ? input.rootNodeId.trim()
            : undefined;
        const rootItem = rootNodeId ? byId.get(rootNodeId) : undefined;
        if (rootNodeId && !rootItem)
            throw new protocol_1.McpBridgeError('NODE_NOT_FOUND', `节点 ${rootNodeId} 不存在。`);
        const maxDepth = boundedInteger(input.depth, 8, 0, 32, 'depth');
        const limit = boundedInteger(input.limit, 50, 1, 200, 'limit');
        const search = typeof input.search === 'string' ? input.search.trim().toLocaleLowerCase() : '';
        const types = optionalStringArray(input.types, 'types');
        const actions = optionalStringArray(input.actions, 'actions');
        const kinds = optionalStringArray(input.kinds, 'kinds');
        const warningOnly = input.warningOnly === true;
        const overrides = overrideMap(document);
        const preferredActions = new Map();
        const forcedRenderIds = new Set();
        for (const item of all) {
            const saved = overrides.get(item.node.id);
            const preferred = (saved === null || saved === void 0 ? void 0 : saved.explicit) === true
                ? (0, import_actions_1.normalizeImportAction)(saved.action)
                : (0, model_1.smartActionForNode)(item.node);
            preferredActions.set(item.node.id, preferred);
            const nineSlice = (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? saved.nineSlice : item.node.patchCandidate;
            if (nineSlice && item.node.patchCandidate) {
                forcedRenderIds.add(item.node.id);
            }
        }
        const effective = (0, model_1.resolveEffectiveActions)(document.tree, preferredActions, forcedRenderIds, undefined, undefined, state.settings.importHiddenLayers !== false);
        const rootDepth = (_a = rootItem === null || rootItem === void 0 ? void 0 : rootItem.depth) !== null && _a !== void 0 ? _a : 0;
        const descendants = rootItem
            ? new Set(indexTree([rootItem.node]).map((item) => item.node.id))
            : null;
        const candidates = all.filter((item) => {
            var _a, _b;
            if (descendants && !descendants.has(item.node.id))
                return false;
            if (item.depth - rootDepth > maxDepth)
                return false;
            const saved = overrides.get(item.node.id);
            const cocosName = (_a = saved === null || saved === void 0 ? void 0 : saved.name) !== null && _a !== void 0 ? _a : item.node.name;
            const action = (_b = effective.actions.get(item.node.id)) !== null && _b !== void 0 ? _b : (0, model_1.smartActionForNode)(item.node);
            const kind = (0, model_1.effectiveKindForNode)(item.node, (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? saved.kind : item.node.kind, action, (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? saved.nineSlice : item.node.patchCandidate);
            if (search && !`${item.node.name}\n${cocosName}\n${item.path.join('/')}`.toLocaleLowerCase().includes(search))
                return false;
            if (types && !types.includes(item.node.type))
                return false;
            if (actions && !actions.includes(action))
                return false;
            if (kinds && !kinds.includes(kind))
                return false;
            if (warningOnly && !item.node.warning)
                return false;
            return true;
        });
        const queryHash = stableHash({
            rootNodeId: rootNodeId !== null && rootNodeId !== void 0 ? rootNodeId : null,
            search,
            types: types ? [...types].sort() : null,
            actions: actions ? [...actions].sort() : null,
            kinds: kinds ? [...kinds].sort() : null,
            warningOnly,
            importHiddenLayers: state.settings.importHiddenLayers !== false,
            depth: maxDepth,
            limit,
            overrides: [...document.nodeOverrides]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((item) => {
                var _a;
                return ({
                    id: item.id,
                    action: item.action,
                    kind: item.kind,
                    nineSlice: item.nineSlice,
                    explicit: item.explicit === true,
                    name: (_a = item.name) !== null && _a !== void 0 ? _a : null,
                });
            }),
        });
        const offset = decodeCursor(input.cursor, session.id, session.revision, queryHash);
        const page = candidates.slice(offset, offset + limit);
        const nodes = page.map((item) => {
            var _a, _b, _c;
            const saved = overrides.get(item.node.id);
            const preferredAction = (_a = preferredActions.get(item.node.id)) !== null && _a !== void 0 ? _a : (0, model_1.smartActionForNode)(item.node);
            const action = (_b = effective.actions.get(item.node.id)) !== null && _b !== void 0 ? _b : preferredAction;
            const nineSlice = (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? saved.nineSlice : item.node.patchCandidate;
            return {
                nodeId: item.node.id,
                parentNodeId: item.parentNodeId,
                depth: item.depth - rootDepth,
                path: item.path.join('/'),
                figmaName: item.node.name,
                cocosName: (_c = saved === null || saved === void 0 ? void 0 : saved.name) !== null && _c !== void 0 ? _c : item.node.name,
                renamed: Boolean((saved === null || saved === void 0 ? void 0 : saved.name) && saved.name !== item.node.name),
                type: item.node.type,
                visible: item.node.visible,
                width: item.node.width,
                height: item.node.height,
                childCount: item.node.children.length,
                preferredAction,
                action,
                kind: (0, model_1.effectiveKindForNode)(item.node, (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? saved.kind : item.node.kind, action, nineSlice),
                nineSlice,
                explicit: (saved === null || saved === void 0 ? void 0 : saved.explicit) === true,
                suppressed: effective.suppressed.has(item.node.id),
                patchCandidate: item.node.patchCandidate,
                sliceMode: item.node.sliceMode,
                reason: (saved === null || saved === void 0 ? void 0 : saved.explicit) === true ? 'user-override' : item.node.reason,
                fold: (saved === null || saved === void 0 ? void 0 : saved.explicit) === true || Boolean(saved === null || saved === void 0 ? void 0 : saved.name) ? undefined : item.node.fold,
                warning: item.node.warning,
            };
        });
        const nextOffset = offset + page.length;
        return {
            totalCount: candidates.length,
            count: nodes.length,
            nodes,
            hasMore: nextOffset < candidates.length,
            nextCursor: nextOffset < candidates.length
                ? encodeCursor(session.id, session.revision, nextOffset, queryHash)
                : undefined,
        };
    }
    async getPreview(params) {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', '当前已有操作正在执行，请等待或先取消。', true);
        }
        const input = record(params);
        const { document } = await this.currentDocument(input);
        const nodeId = requiredString(input.nodeId, 'nodeId', 256);
        if (!indexTree(document.tree).some((item) => item.node.id === nodeId)) {
            throw new protocol_1.McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
        }
        return this.host.getPreview(nodeId);
    }
    buildSettings(document, state, value) {
        const patch = record(value);
        const allowedKeys = new Set([
            'assetFolder',
            'prefabFolder',
            'scale',
            'updateExisting',
            'refreshAssets',
            'autoSave',
            'importHiddenLayers',
            'fontMap',
        ]);
        const keys = Object.keys(patch);
        if (!keys.length || keys.some((key) => !allowedKeys.has(key))) {
            throw new protocol_1.McpBridgeError('INVALID_SETTINGS', 'settings 必须包含至少一个受支持的设置字段。');
        }
        const normalized = { sourceUrl: document.sourceUrl };
        const settings = {
            ...state.settings,
            sourceUrl: document.sourceUrl,
        };
        if (patch.assetFolder !== undefined) {
            settings.assetFolder = safeRelativeAssetFolder(patch.assetFolder, 'assetFolder');
            normalized.assetFolder = settings.assetFolder;
        }
        if (patch.prefabFolder !== undefined) {
            settings.prefabFolder = safeRelativeAssetFolder(patch.prefabFolder, 'prefabFolder');
            normalized.prefabFolder = settings.prefabFolder;
        }
        if (patch.scale !== undefined) {
            if (typeof patch.scale !== 'number' || !Number.isFinite(patch.scale) || patch.scale < 0.25 || patch.scale > 4) {
                throw new protocol_1.McpBridgeError('INVALID_SETTINGS', 'scale 必须是 0.25–4 之间的数字。');
            }
            settings.scale = patch.scale;
            normalized.scale = patch.scale;
        }
        for (const key of ['updateExisting', 'refreshAssets', 'autoSave', 'importHiddenLayers']) {
            if (patch[key] !== undefined) {
                if (typeof patch[key] !== 'boolean')
                    throw new protocol_1.McpBridgeError('INVALID_SETTINGS', `${key} 必须是布尔值。`);
                settings[key] = patch[key];
                normalized[key] = patch[key];
            }
        }
        if (patch.fontMap !== undefined) {
            if (!patch.fontMap || typeof patch.fontMap !== 'object' || Array.isArray(patch.fontMap)) {
                throw new protocol_1.McpBridgeError('INVALID_SETTINGS', 'fontMap 必须是对象。');
            }
            const fontMap = {};
            for (const [font, url] of Object.entries(patch.fontMap)) {
                if (!font.trim() || typeof url !== 'string' || (url && !url.startsWith('db://assets/'))) {
                    throw new protocol_1.McpBridgeError('INVALID_SETTINGS', 'fontMap 只能引用 db://assets 下的字体资源。');
                }
                fontMap[font.trim()] = url.trim();
            }
            settings.fontMap = fontMap;
            normalized.fontMap = fontMap;
        }
        return { patch: normalized, settings };
    }
    applySettings(params, incrementRevision = true) {
        const input = record(params);
        const operation = async () => {
            const { session, document, state } = await this.currentDocument(input);
            const built = this.buildSettings(document, state, input.settings);
            const saved = this.host.patchSettings
                ? await this.host.patchSettings(built.patch)
                : await this.host.saveSettings(built.settings);
            if (incrementRevision)
                session.revision += 1;
            return saved;
        };
        const result = this.settingsWriteQueue.then(operation);
        this.settingsWriteQueue = result.then(() => undefined, () => undefined);
        return result;
    }
    async updateSettings(params) {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', '导入执行期间不能修改设置。', true);
        }
        return publicSettings(await this.applySettings(params));
    }
    async renameNodes(params) {
        var _a;
        if (this.activeImport || this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', '导入执行期间不能修改节点名称。', true);
        }
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
        if (!Array.isArray(input.renames) || !input.renames.length || input.renames.length > 500) {
            throw new protocol_1.McpBridgeError('INVALID_REQUEST', 'renames 必须包含 1–500 个改名项。');
        }
        const allowRootRename = input.allowRootRename === true;
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item.node]));
        const saved = overrideMap(document);
        const seen = new Set();
        const values = [];
        const patches = [];
        const updated = [];
        for (const raw of input.renames) {
            const item = record(raw);
            const nodeId = requiredString(item.nodeId, 'nodeId', 256);
            if (seen.has(nodeId))
                throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 重复出现。`);
            seen.add(nodeId);
            const node = byId.get(nodeId);
            if (!node)
                throw new protocol_1.McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
            if (session.rootIds.has(nodeId) && !allowRootRename) {
                throw new protocol_1.McpBridgeError('ROOT_RENAME_REQUIRES_CONFIRMATION', `节点 ${nodeId} 是导入根；改名会改变链接 Frame 的 Prefab 文件名，请设置 allowRootRename=true 明确确认。`);
            }
            const current = { ...((_a = saved.get(nodeId)) !== null && _a !== void 0 ? _a : defaultOverride(node)) };
            let cocosName = node.name;
            if (item.name === null) {
                delete current.name;
                patches.push({ id: nodeId, name: null, fallback: current });
            }
            else {
                const name = (0, node_name_1.sanitizeNodeName)(item.name);
                if (!name)
                    throw new protocol_1.McpBridgeError('INVALID_NODE_NAME', `节点 ${nodeId} 的名称清洗后为空。`);
                current.name = name;
                cocosName = name;
                patches.push({ id: nodeId, name, fallback: current });
            }
            values.push(current);
            updated.push({
                nodeId,
                figmaName: node.name,
                cocosName,
                reset: item.name === null,
                warning: session.rootIds.has(nodeId)
                    ? '根节点改名会改变链接 Frame 的 Prefab 文件名。'
                    : '改名节点会保留为独立 Cocos 节点，可能阻止视觉包装层折叠。',
            });
        }
        if (this.host.patchNodeNames) {
            await this.host.patchNodeNames(document.fileKey, patches);
        }
        else {
            await this.host.saveNodeOverrides(document.fileKey, values, [...seen]);
        }
        session.revision += 1;
        return { updated };
    }
    async updateNodes(params) {
        var _a;
        if (this.activeImport || this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', '导入执行期间不能修改节点策略。', true);
        }
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
        if (!Array.isArray(input.updates) || !input.updates.length || input.updates.length > 500) {
            throw new protocol_1.McpBridgeError('INVALID_REQUEST', 'updates 必须包含 1–500 个节点设置。');
        }
        const allowRootRename = input.allowRootRename === true;
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item.node]));
        const saved = overrideMap(document);
        const seen = new Set();
        const values = [];
        for (const raw of input.updates) {
            const item = record(raw);
            const nodeId = requiredString(item.nodeId, 'nodeId', 256);
            if (seen.has(nodeId))
                throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 重复出现。`);
            seen.add(nodeId);
            const node = byId.get(nodeId);
            if (!node)
                throw new protocol_1.McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
            const current = { ...((_a = saved.get(nodeId)) !== null && _a !== void 0 ? _a : defaultOverride(node)) };
            let strategyChanged = false;
            if (item.action !== undefined) {
                if (!IMPORT_ACTIONS.has(item.action))
                    throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 action 无效。`);
                current.action = item.action;
                strategyChanged = true;
            }
            if (item.kind !== undefined) {
                if (!NODE_KINDS.has(item.kind))
                    throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 kind 无效。`);
                current.kind = item.kind;
                strategyChanged = true;
            }
            if (item.nineSlice !== undefined) {
                if (typeof item.nineSlice !== 'boolean')
                    throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 nineSlice 必须是布尔值。`);
                current.nineSlice = item.nineSlice;
                strategyChanged = true;
            }
            if (item.name !== undefined) {
                if (session.rootIds.has(nodeId) && !allowRootRename) {
                    throw new protocol_1.McpBridgeError('ROOT_RENAME_REQUIRES_CONFIRMATION', `节点 ${nodeId} 是导入根，请明确允许根节点改名。`);
                }
                if (item.name === null)
                    delete current.name;
                else {
                    const name = (0, node_name_1.sanitizeNodeName)(item.name);
                    if (!name)
                        throw new protocol_1.McpBridgeError('INVALID_NODE_NAME', `节点 ${nodeId} 的名称清洗后为空。`);
                    current.name = name;
                }
            }
            if (!strategyChanged && item.name === undefined) {
                throw new protocol_1.McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 没有提供任何修改。`);
            }
            if (strategyChanged)
                current.explicit = true;
            values.push(current);
        }
        const persisted = await this.host.saveNodeOverrides(document.fileKey, values, [...seen]);
        session.revision += 1;
        return { updated: persisted };
    }
    async importDocument(params, signal) {
        var _a, _b;
        const input = record(params);
        const { session, document, state } = await this.currentDocument(input);
        const operationId = requiredString(input.operationId, 'operationId', 128);
        if (operationId.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
            throw new protocol_1.McpBridgeError('INVALID_REQUEST', 'operationId 至少 8 个字符，且只能包含字母、数字、点、下划线、冒号和连字符。');
        }
        if (input.confirm !== true) {
            throw new protocol_1.McpBridgeError('CONFIRMATION_REQUIRED', '导入会修改 Cocos 项目；请设置 confirm=true 明确确认。');
        }
        const projectedSettings = input.settings === undefined
            ? state.settings
            : this.buildSettings(document, state, input.settings).settings;
        const projectedOverrides = resolvedImportOverrides(document, projectedSettings);
        const requestFingerprint = importRequestFingerprint(document, projectedSettings, projectedOverrides);
        const completed = this.completedImports.get(operationId);
        if (completed) {
            if (completed.documentSessionId !== session.id
                || completed.requestFingerprint !== requestFingerprint) {
                throw new protocol_1.McpBridgeError('OPERATION_ID_CONFLICT', '该 operationId 已用于不同的文档、设置或节点策略。请为新导入生成新的 operationId。');
            }
            return completed.response;
        }
        if (this.activeImport) {
            if (this.activeImport.operationId === operationId
                && this.activeImport.documentSessionId === session.id
                && this.activeImport.requestFingerprint === requestFingerprint) {
                throw new protocol_1.McpBridgeError('OPERATION_IN_PROGRESS', '该 operationId 的导入仍在执行，请等待原调用返回。', true);
            }
            if (this.activeImport.operationId === operationId) {
                throw new protocol_1.McpBridgeError('OPERATION_ID_CONFLICT', '该 operationId 当前绑定的是另一组导入参数。');
            }
            throw new protocol_1.McpBridgeError('BUSY', '当前已有导入正在执行。', true);
        }
        if (this.host.isImportBusy()) {
            throw new protocol_1.McpBridgeError('BUSY', 'Cocos 插件当前有其他操作正在执行。', true);
        }
        if (signal === null || signal === void 0 ? void 0 : signal.aborted)
            throw new protocol_1.McpBridgeError('CANCELLED', 'MCP 调用已取消，导入尚未开始。');
        this.activeImport = {
            operationId,
            documentSessionId: session.id,
            requestFingerprint,
        };
        this.importCancellationRequested = false;
        const cancelForSignal = () => {
            const active = this.activeImport;
            if (!active || active.operationId !== operationId || active.documentSessionId !== session.id)
                return;
            this.importCancellationRequested = true;
            this.host.cancelImport(operationId);
        };
        signal === null || signal === void 0 ? void 0 : signal.addEventListener('abort', cancelForSignal, { once: true });
        try {
            if (input.settings !== undefined) {
                await this.applySettings({
                    documentSessionId: input.documentSessionId,
                    settings: input.settings,
                }, false);
            }
            const latest = await this.host.getState();
            if (this.importCancellationRequested) {
                throw new protocol_1.McpBridgeError('CANCELLED', '导入已取消。');
            }
            if (session.hostRevision !== this.host.getDocumentRevision()
                || ((_a = latest.document) === null || _a === void 0 ? void 0 : _a.fileKey) !== document.fileKey
                || latest.document.sourceUrl !== document.sourceUrl) {
                throw new protocol_1.McpBridgeError('STALE_DOCUMENT_SESSION', '导入前文档已变化，请重新读取 Figma 链接。');
            }
            if (this.host.isImportBusy()) {
                throw new protocol_1.McpBridgeError('BUSY', 'Cocos 插件在导入准备期间启动了其他操作，请等待后重试同一 operationId。', true);
            }
            const overrides = resolvedImportOverrides(latest.document, latest.settings);
            const latestFingerprint = importRequestFingerprint(latest.document, latest.settings, overrides);
            if (latestFingerprint !== requestFingerprint) {
                throw new protocol_1.McpBridgeError('STALE_OPERATION_REQUEST', '导入准备期间设置或节点策略发生变化；本次没有执行导入。请复查后重试同一 operationId。', true);
            }
            try {
                const result = summarizeImportResult(await this.host.importSelection({ overrides, settings: latest.settings }, operationId));
                const response = {
                    operationId,
                    result,
                    ...(this.importCancellationRequested ? {
                        cancellationWarning: '已收到取消请求，但 Cocos 的不可中断步骤已经完成；本次导入结果有效，请勿重试。',
                    } : {}),
                };
                this.completedImports.set(operationId, {
                    operationId,
                    documentSessionId: session.id,
                    requestFingerprint,
                    response,
                });
                while (this.completedImports.size > 32) {
                    const oldest = this.completedImports.keys().next().value;
                    if (!oldest)
                        break;
                    this.completedImports.delete(oldest);
                }
                return response;
            }
            catch (error) {
                if (this.importCancellationRequested) {
                    throw new protocol_1.McpBridgeError('CANCELLED', '取消请求已发送；资源或 Scene 的不可中断步骤可能已完成。请先检查 Cocos 当前结果，再决定是否使用新的 operationId 重试。');
                }
                throw error;
            }
        }
        finally {
            signal === null || signal === void 0 ? void 0 : signal.removeEventListener('abort', cancelForSignal);
            if (((_b = this.activeImport) === null || _b === void 0 ? void 0 : _b.operationId) === operationId)
                this.activeImport = null;
            this.importCancellationRequested = false;
        }
    }
    cancelImport(params) {
        const input = record(params);
        const documentSessionId = requiredString(input.documentSessionId, 'documentSessionId', 256);
        const operationId = requiredString(input.operationId, 'operationId', 128);
        if (operationId.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
            throw new protocol_1.McpBridgeError('INVALID_REQUEST', 'operationId 格式无效。');
        }
        const active = this.activeImport;
        if (!active || active.operationId !== operationId || active.documentSessionId !== documentSessionId) {
            const completed = this.completedImports.get(operationId);
            return {
                cancellationRequested: false,
                operationId,
                reason: (completed === null || completed === void 0 ? void 0 : completed.documentSessionId) === documentSessionId
                    ? 'ALREADY_COMPLETED'
                    : 'OPERATION_NOT_FOUND',
            };
        }
        this.importCancellationRequested = true;
        const interruptSignalSent = this.host.cancelImport(operationId);
        return {
            cancellationRequested: true,
            operationId,
            interruptSignalSent,
            guaranteed: false,
        };
    }
}
exports.FigmaImporterMcpApi = FigmaImporterMcpApi;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tY3AtYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQTBOQSw4QkFTQztBQW5PRCxtQ0FBaUQ7QUFDakQsK0JBQWtDO0FBQ2xDLHFEQUF5RDtBQUN6RCxxQ0FBK0M7QUFDL0MsMkNBQStDO0FBQy9DLGtEQUlnQztBQUNoQyxvREFBNkU7QUF5RTdFLFNBQVMsY0FBYyxDQUFDLFFBQXdCO0lBQzVDLE9BQU87UUFDSCxTQUFTLEVBQUUsUUFBUSxDQUFDLFNBQVM7UUFDN0IsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXO1FBQ2pDLFlBQVksRUFBRSxRQUFRLENBQUMsWUFBWTtRQUNuQyxLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQUs7UUFDckIsY0FBYyxFQUFFLFFBQVEsQ0FBQyxjQUFjO1FBQ3ZDLGFBQWEsRUFBRSxRQUFRLENBQUMsYUFBYTtRQUNyQyxRQUFRLEVBQUUsUUFBUSxDQUFDLFFBQVE7UUFDM0Isa0JBQWtCLEVBQUUsUUFBUSxDQUFDLGtCQUFrQixLQUFLLEtBQUs7UUFDekQsT0FBTyxFQUFFLEVBQUUsR0FBRyxRQUFRLENBQUMsT0FBTyxFQUFFO0tBQ25DLENBQUM7QUFDTixDQUFDO0FBU0QsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQWUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzVGLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFXO0lBQ2pDLE1BQU07SUFDTixNQUFNO0lBQ04sUUFBUTtJQUNSLE9BQU87SUFDUCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFlBQVk7SUFDWixRQUFRO0NBQ1gsQ0FBQyxDQUFDO0FBRUgsU0FBUyxNQUFNLENBQUMsS0FBYztJQUMxQixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtB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QUFLO2dCQUM1QixXQUFXO2dCQUNYLE1BQU0sRUFBRSxDQUFBLFNBQVMsYUFBVCxTQUFTLHVCQUFULFNBQVMsQ0FBRSxpQkFBaUIsTUFBSyxpQkFBaUI7b0JBQ3RELENBQUMsQ0FBQyxtQkFBbUI7b0JBQ3JCLENBQUMsQ0FBQyxxQkFBcUI7YUFDOUIsQ0FBQztRQUNOLENBQUM7UUFDRCxJQUFJLENBQUMsMkJBQTJCLEdBQUcsSUFBSSxDQUFDO1FBQ3hDLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDaEUsT0FBTztZQUNILHFCQUFxQixFQUFFLElBQUk7WUFDM0IsV0FBVztZQUNYLG1CQUFtQjtZQUNuQixVQUFVLEVBQUUsS0FBSztTQUNwQixDQUFDO0lBQ04sQ0FBQztDQUNKO0FBcG1CRCxrREFvbUJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlSGFzaCwgcmFuZG9tQnl0ZXMgfSBmcm9tICdjcnlwdG8nO1xyXG5pbXBvcnQgeyBpc0Fic29sdXRlIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IG5vcm1hbGl6ZUltcG9ydEFjdGlvbiB9IGZyb20gJy4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgeyBwYXJzZUZpZ21hU291cmNlIH0gZnJvbSAnLi9maWdtYS91cmwnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQge1xyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxufSBmcm9tICcuL3BhbmVscy9kZWZhdWx0L21vZGVsJztcclxuaW1wb3J0IHsgTWNwQnJpZGdlRXJyb3IsIHR5cGUgTWNwQnJpZGdlTWV0aG9kIH0gZnJvbSAnLi9tY3AtYnJpZGdlL3Byb3RvY29sJztcclxuaW1wb3J0IHR5cGUge1xyXG4gICAgSW1wb3J0QWN0aW9uLFxyXG4gICAgSW1wb3J0T3ZlcnJpZGUsXHJcbiAgICBJbXBvcnRSZXF1ZXN0LFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFRyZWVOb2RlRHRvLFxyXG59IGZyb20gJy4vdHlwZXMnO1xyXG5cclxuaW50ZXJmYWNlIFBsdWdpbkRvY3VtZW50RHRvIHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIGZpbGVOYW1lOiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHRyZWU6IFRyZWVOb2RlRHRvW107XHJcbiAgICBmb250czogc3RyaW5nW107XHJcbiAgICBub2RlT3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGx1Z2luU3RhdGVEdG8ge1xyXG4gICAgdmVyc2lvbjogc3RyaW5nO1xyXG4gICAgdmF1bHQ6IHtcclxuICAgICAgICBoYXNUb2tlbjogYm9vbGVhbjtcclxuICAgICAgICBwZXJzaXN0ZW50OiBib29sZWFuO1xyXG4gICAgICAgIGJhY2tlbmQ6IHN0cmluZztcclxuICAgICAgICB3YXJuaW5nPzogc3RyaW5nO1xyXG4gICAgfTtcclxuICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncztcclxuICAgIGRvY3VtZW50OiBQbHVnaW5Eb2N1bWVudER0byB8IG51bGw7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTWNwQXBpSG9zdCB7XHJcbiAgICBwcm9qZWN0UGF0aDogc3RyaW5nO1xyXG4gICAgY3JlYXRvclZlcnNpb246IHN0cmluZztcclxuICAgIGdldERvY3VtZW50UmV2aXNpb24oKTogbnVtYmVyO1xyXG4gICAgaXNJbXBvcnRCdXN5KCk6IGJvb2xlYW47XHJcbiAgICBnZXRTdGF0ZSgpOiBQcm9taXNlPFBsdWdpblN0YXRlRHRvPjtcclxuICAgIGZldGNoRG9jdW1lbnQoc291cmNlVXJsOiBzdHJpbmcpOiBQcm9taXNlPFBsdWdpbkRvY3VtZW50RHRvPjtcclxuICAgIGdldFByZXZpZXcobm9kZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgdXJsOiBzdHJpbmcgfT47XG4gICAgc3luY1ByZXZpZXcoKTogUHJvbWlzZTx1bmtub3duPjtcclxuICAgIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+O1xyXG4gICAgcGF0Y2hTZXR0aW5ncz8odmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz47XHJcbiAgICBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPjtcclxuICAgIHBhdGNoTm9kZU5hbWVzPyhmaWxlS2V5OiBzdHJpbmcsIHBhdGNoZXM6IE1jcE5vZGVOYW1lUGF0Y2hbXSk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT47XHJcbiAgICBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uSWQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj47XHJcbiAgICBjYW5jZWxJbXBvcnQob3BlcmF0aW9uSWQ6IHN0cmluZyk6IGJvb2xlYW47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTWNwTm9kZU5hbWVQYXRjaCB7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgbmFtZTogc3RyaW5nIHwgbnVsbDtcclxuICAgIGZhbGxiYWNrOiBJbXBvcnRPdmVycmlkZTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFjdGl2ZU1jcERvY3VtZW50IHtcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBob3N0UmV2aXNpb246IG51bWJlcjtcclxuICAgIHJldmlzaW9uOiBudW1iZXI7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHJvb3RJZHM6IFNldDxzdHJpbmc+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQWN0aXZlTWNwSW1wb3J0IHtcclxuICAgIG9wZXJhdGlvbklkOiBzdHJpbmc7XHJcbiAgICBkb2N1bWVudFNlc3Npb25JZDogc3RyaW5nO1xyXG4gICAgcmVxdWVzdEZpbmdlcnByaW50OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBDb21wbGV0ZWRNY3BJbXBvcnQgZXh0ZW5kcyBBY3RpdmVNY3BJbXBvcnQge1xyXG4gICAgcmVzcG9uc2U6IHVua25vd247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHB1YmxpY1NldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBzZXR0aW5ncy5zb3VyY2VVcmwsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHNldHRpbmdzLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogc2V0dGluZ3MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIHNjYWxlOiBzZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogc2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogc2V0dGluZ3MucmVmcmVzaEFzc2V0cyxcclxuICAgICAgICBhdXRvU2F2ZTogc2V0dGluZ3MuYXV0b1NhdmUsXHJcbiAgICAgICAgaW1wb3J0SGlkZGVuTGF5ZXJzOiBzZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlLFxyXG4gICAgICAgIGZvbnRNYXA6IHsgLi4uc2V0dGluZ3MuZm9udE1hcCB9LFxyXG4gICAgfTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkVHJlZU5vZGUge1xyXG4gICAgbm9kZTogVHJlZU5vZGVEdG87XHJcbiAgICBwYXJlbnROb2RlSWQ/OiBzdHJpbmc7XHJcbiAgICBkZXB0aDogbnVtYmVyO1xyXG4gICAgcGF0aDogc3RyaW5nW107XHJcbn1cclxuXHJcbmNvbnN0IElNUE9SVF9BQ1RJT05TID0gbmV3IFNldDxJbXBvcnRBY3Rpb24+KFsnaWdub3JlJywgJ2dlbmVyYXRlJywgJ3JlbmRlcicsICd0cmFuc2Zvcm0nXSk7XHJcbmNvbnN0IE5PREVfS0lORFMgPSBuZXcgU2V0PE5vZGVLaW5kPihbXHJcbiAgICAnYXV0bycsXHJcbiAgICAnbm9kZScsXHJcbiAgICAnc3ByaXRlJyxcclxuICAgICdsYWJlbCcsXHJcbiAgICAncmljaFRleHQnLFxyXG4gICAgJ2J1dHRvbicsXHJcbiAgICAnc2Nyb2xsVmlldycsXHJcbiAgICAnbGF5b3V0JyxcclxuXSk7XHJcblxyXG5mdW5jdGlvbiByZWNvcmQodmFsdWU6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsICflt6Xlhbflj4LmlbDlv4XpobvmmK/lr7nosaHjgIInKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWlyZWRTdHJpbmcodmFsdWU6IHVua25vd24sIGxhYmVsOiBzdHJpbmcsIG1heExlbmd0aCA9IDIwNDgpOiBzdHJpbmcge1xyXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgIXZhbHVlLnRyaW0oKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYCR7bGFiZWx9IOS4jeiDveS4uuepuuOAgmApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0ID0gdmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKHJlc3VsdC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGAke2xhYmVsfSDotoXov4cgJHttYXhMZW5ndGh9IOWtl+espumZkOWItuOAgmApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuZnVuY3Rpb24gb3B0aW9uYWxTdHJpbmdBcnJheSh2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZyk6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcclxuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSB8fCB2YWx1ZS5zb21lKChpdGVtKSA9PiB0eXBlb2YgaXRlbSAhPT0gJ3N0cmluZycpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBgJHtsYWJlbH0g5b+F6aG75piv5a2X56ym5Liy5pWw57uE44CCYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWUgYXMgc3RyaW5nW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJvdW5kZWRJbnRlZ2VyKHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIsIGxhYmVsOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxsYmFjaztcclxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IG1pbiB8fCB2YWx1ZSA+IG1heCkge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYCR7bGFiZWx9IOW/hemhu+aYryAke21pbn3igJMke21heH0g5LmL6Ze055qE5pW05pWw44CCYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuY29kZUN1cnNvcihzZXNzaW9uSWQ6IHN0cmluZywgcmV2aXNpb246IG51bWJlciwgb2Zmc2V0OiBudW1iZXIsIHF1ZXJ5SGFzaDogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBCdWZmZXIuZnJvbShKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25JZCwgcmV2aXNpb24sIG9mZnNldCwgcXVlcnlIYXNoIH0pLCAndXRmOCcpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVjb2RlQ3Vyc29yKHZhbHVlOiB1bmtub3duLCBzZXNzaW9uSWQ6IHN0cmluZywgcmV2aXNpb246IG51bWJlciwgcXVlcnlIYXNoOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09ICcnKSByZXR1cm4gMDtcclxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8IHZhbHVlLmxlbmd0aCA+IDUxMikge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9DVVJTT1InLCAn5YiG6aG1IGN1cnNvciDml6DmlYjjgIInKTtcclxuICAgIH1cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgZGVjb2RlZCA9IEpTT04ucGFyc2UoQnVmZmVyLmZyb20odmFsdWUsICdiYXNlNjR1cmwnKS50b1N0cmluZygndXRmOCcpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgICBpZiAoZGVjb2RlZC5zZXNzaW9uSWQgIT09IHNlc3Npb25JZCB8fCBkZWNvZGVkLnJldmlzaW9uICE9PSByZXZpc2lvbiB8fCBkZWNvZGVkLnF1ZXJ5SGFzaCAhPT0gcXVlcnlIYXNoXHJcbiAgICAgICAgICAgIHx8IHR5cGVvZiBkZWNvZGVkLm9mZnNldCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIoZGVjb2RlZC5vZmZzZXQpIHx8IGRlY29kZWQub2Zmc2V0IDwgMCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ2N1cnNvciBtaXNtYXRjaCcpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gZGVjb2RlZC5vZmZzZXQ7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfQ1VSU09SJywgJ+WIhumhtSBjdXJzb3Ig5bey5aSx5pWI77yM6K+35LuO56ys5LiA6aG16YeN5paw5p+l6K+i44CCJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN0YWJsZUhhc2godmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShKU09OLnN0cmluZ2lmeSh2YWx1ZSksICd1dGY4JykuZGlnZXN0KCdoZXgnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0dGluZ3NGaW5nZXJwcmludChzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogc2V0dGluZ3Muc291cmNlVXJsLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiBzZXR0aW5ncy5hc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXI6IHNldHRpbmdzLnByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogWy4uLnNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXSxcclxuICAgICAgICBzY2FsZTogc2V0dGluZ3Muc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IHNldHRpbmdzLnJlZnJlc2hBc3NldHMsXHJcbiAgICAgICAgYXV0b1NhdmU6IHNldHRpbmdzLmF1dG9TYXZlLFxyXG4gICAgICAgIGltcG9ydEhpZGRlbkxheWVyczogc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSxcclxuICAgICAgICBmb250TWFwOiBPYmplY3QuZW50cmllcyhzZXR0aW5ncy5mb250TWFwKS5zb3J0KChbbGVmdF0sIFtyaWdodF0pID0+IGxlZnQubG9jYWxlQ29tcGFyZShyaWdodCkpLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW1wb3J0UmVxdWVzdEZpbmdlcnByaW50KFxyXG4gICAgZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvLFxyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLFxyXG4gICAgb3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdLFxyXG4pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0YWJsZUhhc2goe1xyXG4gICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHNldHRpbmdzRmluZ2VycHJpbnQoc2V0dGluZ3MpLFxyXG4gICAgICAgIG92ZXJyaWRlczogb3ZlcnJpZGVzLm1hcCgoaXRlbSkgPT4gKHtcclxuICAgICAgICAgICAgaWQ6IGl0ZW0uaWQsXHJcbiAgICAgICAgICAgIGFjdGlvbjogaXRlbS5hY3Rpb24sXHJcbiAgICAgICAgICAgIGtpbmQ6IGl0ZW0ua2luZCxcclxuICAgICAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSxcclxuICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgIG5hbWU6IGl0ZW0ubmFtZSA/PyBudWxsLFxyXG4gICAgICAgIH0pKSxcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlUmVsYXRpdmVBc3NldEZvbGRlcih2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBmb2xkZXIgPSByZXF1aXJlZFN0cmluZyh2YWx1ZSwgbGFiZWwsIDI1NikucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15cXC5cXC8vLCAnJykucmVwbGFjZSgvXFwvKyQvLCAnJyk7XHJcbiAgICBpZiAoaXNBYnNvbHV0ZShmb2xkZXIpIHx8IGZvbGRlci5zdGFydHNXaXRoKCcvJykgfHwgZm9sZGVyLnNwbGl0KCcvJykuc29tZSgocGFydCkgPT4gIXBhcnQgfHwgcGFydCA9PT0gJy4nIHx8IHBhcnQgPT09ICcuLicpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1NFVFRJTkdTJywgYCR7bGFiZWx9IOW/hemhu+aYryBhc3NldHMg5LiL55qE55u45a+55a2Q55uu5b2V44CCYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm9sZGVyO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5kZXhUcmVlKHJvb3RzOiBUcmVlTm9kZUR0b1tdKTogSW5kZXhlZFRyZWVOb2RlW10ge1xyXG4gICAgY29uc3QgcmVzdWx0OiBJbmRleGVkVHJlZU5vZGVbXSA9IFtdO1xyXG4gICAgY29uc3QgdmlzaXQgPSAobm9kZTogVHJlZU5vZGVEdG8sIHBhcmVudE5vZGVJZDogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXB0aDogbnVtYmVyLCBwYXRoOiBzdHJpbmdbXSkgPT4ge1xyXG4gICAgICAgIGNvbnN0IG5leHRQYXRoID0gWy4uLnBhdGgsIG5vZGUubmFtZV07XHJcbiAgICAgICAgcmVzdWx0LnB1c2goeyBub2RlLCBwYXJlbnROb2RlSWQsIGRlcHRoLCBwYXRoOiBuZXh0UGF0aCB9KTtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiB2aXNpdChjaGlsZCwgbm9kZS5pZCwgZGVwdGggKyAxLCBuZXh0UGF0aCkpO1xyXG4gICAgfTtcclxuICAgIHJvb3RzLmZvckVhY2goKHJvb3QpID0+IHZpc2l0KHJvb3QsIHVuZGVmaW5lZCwgMCwgW10pKTtcclxuICAgIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlZmF1bHRPdmVycmlkZShub2RlOiBUcmVlTm9kZUR0byk6IEltcG9ydE92ZXJyaWRlIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgYWN0aW9uOiBzbWFydEFjdGlvbkZvck5vZGUobm9kZSksXHJcbiAgICAgICAga2luZDogbm9kZS5raW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICBleHBsaWNpdDogZmFsc2UsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBvdmVycmlkZU1hcChkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG8pOiBNYXA8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4ge1xyXG4gICAgcmV0dXJuIG5ldyBNYXAoZG9jdW1lbnQubm9kZU92ZXJyaWRlcy5tYXAoKGl0ZW0pID0+IFtpdGVtLmlkLCB7IC4uLml0ZW0gfV0pKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzb2x2ZWRJbXBvcnRPdmVycmlkZXMoZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvLCBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBJbXBvcnRPdmVycmlkZVtdIHtcclxuICAgIGNvbnN0IG5vZGVzID0gaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlKTtcclxuICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVNYXAoZG9jdW1lbnQpO1xyXG4gICAgY29uc3QgcHJlZmVycmVkQWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+KCk7XHJcbiAgICBjb25zdCBmb3JjZWRSZW5kZXJJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBzYXZlZC5nZXQobm9kZS5pZCk7XHJcbiAgICAgICAgcHJlZmVycmVkQWN0aW9ucy5zZXQoXHJcbiAgICAgICAgICAgIG5vZGUuaWQsXHJcbiAgICAgICAgICAgIGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlID8gbm9ybWFsaXplSW1wb3J0QWN0aW9uKGN1cnJlbnQuYWN0aW9uKSA6IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IG5pbmVTbGljZSA9IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlID8gY3VycmVudC5uaW5lU2xpY2UgOiBub2RlLnBhdGNoQ2FuZGlkYXRlO1xyXG4gICAgICAgIGlmIChuaW5lU2xpY2UgJiYgbm9kZS5wYXRjaENhbmRpZGF0ZSkgZm9yY2VkUmVuZGVySWRzLmFkZChub2RlLmlkKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGRvY3VtZW50LnRyZWUsIHByZWZlcnJlZEFjdGlvbnMsIGZvcmNlZFJlbmRlcklkcyxcclxuICAgICAgICB1bmRlZmluZWQsIHVuZGVmaW5lZCwgc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSk7XHJcbiAgICByZXR1cm4gbm9kZXMubWFwKChub2RlKSA9PiB7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHNhdmVkLmdldChub2RlLmlkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgYWN0aW9uOiBlZmZlY3RpdmUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgICAgICBraW5kOiBjdXJyZW50Py5leHBsaWNpdCA9PT0gdHJ1ZSA/IGN1cnJlbnQua2luZCA6IG5vZGUua2luZCxcclxuICAgICAgICAgICAgbmluZVNsaWNlOiBjdXJyZW50Py5leHBsaWNpdCA9PT0gdHJ1ZSA/IGN1cnJlbnQubmluZVNsaWNlIDogbm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgZXhwbGljaXQ6IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICAuLi4oY3VycmVudD8ubmFtZSA/IHsgbmFtZTogY3VycmVudC5uYW1lIH0gOiB7fSksXHJcbiAgICAgICAgfTtcclxuICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzdW1tYXJpemVJbXBvcnRSZXN1bHQodmFsdWU6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XHJcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcclxuICAgICAgICByZXR1cm4geyBjb21wbGV0ZWQ6IHRydWUgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlc3VsdCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgY29uc3Qgc3VtbWFyeTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGNvbXBsZXRlZDogdHJ1ZSB9O1xyXG4gICAgaWYgKHJlc3VsdC5yZXZpZXcgJiYgdHlwZW9mIHJlc3VsdC5yZXZpZXcgPT09ICdvYmplY3QnKSBzdW1tYXJ5LnJldmlld0F2YWlsYWJsZSA9IHRydWU7XHJcbiAgICBpZiAodHlwZW9mIHJlc3VsdC5jcmVhdGVkID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUocmVzdWx0LmNyZWF0ZWQpKSBzdW1tYXJ5LmNyZWF0ZWQgPSByZXN1bHQuY3JlYXRlZDtcclxuICAgIGlmICh0eXBlb2YgcmVzdWx0LnVwZGF0ZWQgPT09ICdudW1iZXInICYmIE51bWJlci5pc0Zpbml0ZShyZXN1bHQudXBkYXRlZCkpIHN1bW1hcnkudXBkYXRlZCA9IHJlc3VsdC51cGRhdGVkO1xyXG4gICAgaWYgKHR5cGVvZiByZXN1bHQucHJlZmFiVXJsID09PSAnc3RyaW5nJykgc3VtbWFyeS5wcmVmYWJVcmwgPSByZXN1bHQucHJlZmFiVXJsO1xyXG4gICAgaWYgKHR5cGVvZiByZXN1bHQudGVtcG9yYXJ5Um9vdCA9PT0gJ2Jvb2xlYW4nKSBzdW1tYXJ5LnRlbXBvcmFyeVJvb3QgPSByZXN1bHQudGVtcG9yYXJ5Um9vdDtcclxuICAgIGlmIChBcnJheS5pc0FycmF5KHJlc3VsdC53YXJuaW5ncykpIHtcclxuICAgICAgICBzdW1tYXJ5Lndhcm5pbmdzID0gcmVzdWx0Lndhcm5pbmdzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiB0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5zbGljZSgwLCAxMDApXHJcbiAgICAgICAgICAgIC5tYXAoKGl0ZW0pID0+IGl0ZW0uc2xpY2UoMCwgNTEyKSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc3VtbWFyeTtcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEZpZ21hSW1wb3J0ZXJNY3BBcGkge1xyXG4gICAgcHJpdmF0ZSBzZXNzaW9uOiBBY3RpdmVNY3BEb2N1bWVudCB8IG51bGwgPSBudWxsO1xyXG4gICAgcHJpdmF0ZSBhY3RpdmVJbXBvcnQ6IEFjdGl2ZU1jcEltcG9ydCB8IG51bGwgPSBudWxsO1xyXG4gICAgcHJpdmF0ZSBpbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSBmYWxzZTtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgY29tcGxldGVkSW1wb3J0cyA9IG5ldyBNYXA8c3RyaW5nLCBDb21wbGV0ZWRNY3BJbXBvcnQ+KCk7XHJcbiAgICBwcml2YXRlIHNldHRpbmdzV3JpdGVRdWV1ZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5cclxuICAgIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgaG9zdDogTWNwQXBpSG9zdCkge31cclxuXHJcbiAgICBhc3luYyBpbnZva2UobWV0aG9kOiBNY3BCcmlkZ2VNZXRob2QsIHBhcmFtczogdW5rbm93biwgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPHVua25vd24+IHtcclxuICAgICAgICBzd2l0Y2ggKG1ldGhvZCkge1xyXG4gICAgICAgICAgICBjYXNlICdnZXRTdGF0dXMnOiByZXR1cm4gdGhpcy5nZXRTdGF0dXMoKTtcclxuICAgICAgICAgICAgY2FzZSAnZmV0Y2hEb2N1bWVudCc6IHJldHVybiB0aGlzLmZldGNoRG9jdW1lbnQocGFyYW1zKTtcclxuICAgICAgICAgICAgY2FzZSAnbGlzdE5vZGVzJzogcmV0dXJuIHRoaXMubGlzdE5vZGVzKHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGNhc2UgJ2dldFByZXZpZXcnOiByZXR1cm4gdGhpcy5nZXRQcmV2aWV3KHBhcmFtcyk7XG4gICAgICAgICAgICBjYXNlICdzeW5jUHJldmlldyc6IHJldHVybiB0aGlzLnN5bmNQcmV2aWV3KHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVNldHRpbmdzJzogcmV0dXJuIHRoaXMudXBkYXRlU2V0dGluZ3MocGFyYW1zKTtcclxuICAgICAgICAgICAgY2FzZSAndXBkYXRlTm9kZXMnOiByZXR1cm4gdGhpcy51cGRhdGVOb2RlcyhwYXJhbXMpO1xyXG4gICAgICAgICAgICBjYXNlICdyZW5hbWVOb2Rlcyc6IHJldHVybiB0aGlzLnJlbmFtZU5vZGVzKHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGNhc2UgJ2ltcG9ydERvY3VtZW50JzogcmV0dXJuIHRoaXMuaW1wb3J0RG9jdW1lbnQocGFyYW1zLCBzaWduYWwpO1xyXG4gICAgICAgICAgICBjYXNlICdjYW5jZWxJbXBvcnQnOiByZXR1cm4gdGhpcy5jYW5jZWxJbXBvcnQocGFyYW1zKTtcclxuICAgICAgICAgICAgZGVmYXVsdDogdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdNRVRIT0RfTk9UX0FMTE9XRUQnLCAn6K+lIEJyaWRnZSDmlrnms5XmnKrlvIDmlL7jgIInKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBnZXRTdGF0dXMoKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCB0aGlzLmhvc3QuZ2V0U3RhdGUoKTtcclxuICAgICAgICBjb25zdCBzZXNzaW9uVmFsaWQgPSBCb29sZWFuKHRoaXMuc2Vzc2lvblxyXG4gICAgICAgICAgICAmJiB0aGlzLnNlc3Npb24uaG9zdFJldmlzaW9uID09PSB0aGlzLmhvc3QuZ2V0RG9jdW1lbnRSZXZpc2lvbigpXHJcbiAgICAgICAgICAgICYmIHN0YXRlLmRvY3VtZW50Py5maWxlS2V5ID09PSB0aGlzLnNlc3Npb24uZmlsZUtleSk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgY29ubmVjdGVkOiB0cnVlLFxyXG4gICAgICAgICAgICBwbHVnaW5WZXJzaW9uOiBzdGF0ZS52ZXJzaW9uLFxyXG4gICAgICAgICAgICBjcmVhdG9yVmVyc2lvbjogdGhpcy5ob3N0LmNyZWF0b3JWZXJzaW9uLFxyXG4gICAgICAgICAgICBwcm9qZWN0UGF0aDogdGhpcy5ob3N0LnByb2plY3RQYXRoLFxyXG4gICAgICAgICAgICB0b2tlbjoge1xyXG4gICAgICAgICAgICAgICAgY29uZmlndXJlZDogc3RhdGUudmF1bHQuaGFzVG9rZW4sXHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0ZW50OiBzdGF0ZS52YXVsdC5wZXJzaXN0ZW50LFxyXG4gICAgICAgICAgICAgICAgYmFja2VuZDogc3RhdGUudmF1bHQuYmFja2VuZCxcclxuICAgICAgICAgICAgICAgIC4uLihzdGF0ZS52YXVsdC53YXJuaW5nID8geyB3YXJuaW5nOiBzdGF0ZS52YXVsdC53YXJuaW5nIH0gOiB7fSksXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIHNldHRpbmdzOiBwdWJsaWNTZXR0aW5ncyhzdGF0ZS5zZXR0aW5ncyksXHJcbiAgICAgICAgICAgIGJ1c3k6IHRoaXMuYWN0aXZlSW1wb3J0ICE9PSBudWxsIHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSxcclxuICAgICAgICAgICAgZG9jdW1lbnQ6IHN0YXRlLmRvY3VtZW50ID8ge1xyXG4gICAgICAgICAgICAgICAgZmlsZU5hbWU6IHN0YXRlLmRvY3VtZW50LmZpbGVOYW1lLFxyXG4gICAgICAgICAgICAgICAgc291cmNlVXJsOiBzdGF0ZS5kb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgICAgICBub2RlQ291bnQ6IGluZGV4VHJlZShzdGF0ZS5kb2N1bWVudC50cmVlKS5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogc2Vzc2lvblZhbGlkID8gdGhpcy5zZXNzaW9uPy5pZCA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgICAgfSA6IG51bGwsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIGZldGNoRG9jdW1lbnQocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0JVU1knLCAn5b2T5YmN5bey5pyJ5pON5L2c5q2j5Zyo5omn6KGM77yM6K+3562J5b6F5oiW5YWI5Y+W5raI44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3Qgc291cmNlVXJsID0gcmVxdWlyZWRTdHJpbmcoaW5wdXQuc291cmNlVXJsLCAnc291cmNlVXJsJyk7XHJcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCB0aGlzLmhvc3QuZ2V0U3RhdGUoKTtcclxuICAgICAgICBpZiAoIXN0YXRlLnZhdWx0Lmhhc1Rva2VuKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignVE9LRU5fTk9UX0NPTkZJR1VSRUQnLCAn5bCa5pyq6YWN572uIEZpZ21hIFBlcnNvbmFsIEFjY2VzcyBUb2tlbuOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBwYXJzZUZpZ21hU291cmNlKHNvdXJjZVVybCk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9GSUdNQV9TT1VSQ0UnLCAn5LuF5pSv5oyB5pyJ5pWI55qEIGZpZ21hLmNvbSDmlofku7bjgIHorr7orqHjgIHljp/lnovmiJYgRmlnSmFtIOmTvuaOpeOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IGF3YWl0IHRoaXMuaG9zdC5mZXRjaERvY3VtZW50KHNvdXJjZVVybCk7XHJcbiAgICAgICAgY29uc3QgaWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG4gICAgICAgIHRoaXMuc2Vzc2lvbiA9IHtcclxuICAgICAgICAgICAgaWQsXHJcbiAgICAgICAgICAgIGhvc3RSZXZpc2lvbjogdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKSxcclxuICAgICAgICAgICAgcmV2aXNpb246IDAsXHJcbiAgICAgICAgICAgIGZpbGVLZXk6IGRvY3VtZW50LmZpbGVLZXksXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICByb290SWRzOiBuZXcgU2V0KGRvY3VtZW50LnRyZWUubWFwKChub2RlKSA9PiBub2RlLmlkKSksXHJcbiAgICAgICAgfTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogaWQsXHJcbiAgICAgICAgICAgIGZpbGVOYW1lOiBkb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXHJcbiAgICAgICAgICAgIG5vZGVDb3VudDogaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLmxlbmd0aCxcclxuICAgICAgICAgICAgZm9udHM6IGRvY3VtZW50LmZvbnRzLFxyXG4gICAgICAgICAgICByb290czogZG9jdW1lbnQudHJlZS5tYXAoKG5vZGUpID0+ICh7XHJcbiAgICAgICAgICAgICAgICBub2RlSWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBuYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICB0eXBlOiBub2RlLnR5cGUsXHJcbiAgICAgICAgICAgICAgICB3aWR0aDogbm9kZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogbm9kZS5oZWlnaHQsXHJcbiAgICAgICAgICAgICAgICBjaGlsZENvdW50OiBub2RlLmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgfSkpLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBjdXJyZW50RG9jdW1lbnQocGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8eyBzZXNzaW9uOiBBY3RpdmVNY3BEb2N1bWVudDsgZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvOyBzdGF0ZTogUGx1Z2luU3RhdGVEdG8gfT4ge1xyXG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHJlcXVpcmVkU3RyaW5nKHBhcmFtcy5kb2N1bWVudFNlc3Npb25JZCwgJ2RvY3VtZW50U2Vzc2lvbklkJywgMjU2KTtcclxuICAgICAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5zZXNzaW9uO1xyXG4gICAgICAgIGlmICghc2Vzc2lvbiB8fCBzZXNzaW9uLmlkICE9PSBzZXNzaW9uSWQgfHwgc2Vzc2lvbi5ob3N0UmV2aXNpb24gIT09IHRoaXMuaG9zdC5nZXREb2N1bWVudFJldmlzaW9uKCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdTVEFMRV9ET0NVTUVOVF9TRVNTSU9OJywgJ+aWh+aho+S8muivneW3suWkseaViO+8jOivt+mHjeaWsOivu+WPliBGaWdtYSDpk77mjqXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCB0aGlzLmhvc3QuZ2V0U3RhdGUoKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudCA9IHN0YXRlLmRvY3VtZW50O1xyXG4gICAgICAgIGlmICghZG9jdW1lbnQgfHwgZG9jdW1lbnQuZmlsZUtleSAhPT0gc2Vzc2lvbi5maWxlS2V5IHx8IGRvY3VtZW50LnNvdXJjZVVybCAhPT0gc2Vzc2lvbi5zb3VyY2VVcmwpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdTVEFMRV9ET0NVTUVOVF9TRVNTSU9OJywgJ+W9k+WJjeaPkuS7tuaWh+aho+W3suWPmOWMlu+8jOivt+mHjeaWsOivu+WPliBGaWdtYSDpk77mjqXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgc2Vzc2lvbiwgZG9jdW1lbnQsIHN0YXRlIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBzeW5jUHJldmlldyhwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQocmVjb3JkKHBhcmFtcykpO1xuICAgICAgICByZXR1cm4gdGhpcy5ob3N0LnN5bmNQcmV2aWV3KCk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBhc3luYyBsaXN0Tm9kZXMocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSByZWNvcmQocGFyYW1zKTtcclxuICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xyXG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCBieUlkID0gbmV3IE1hcChhbGwubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtXSkpO1xyXG4gICAgICAgIGNvbnN0IHJvb3ROb2RlSWQgPSB0eXBlb2YgaW5wdXQucm9vdE5vZGVJZCA9PT0gJ3N0cmluZycgJiYgaW5wdXQucm9vdE5vZGVJZC50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5yb290Tm9kZUlkLnRyaW0oKVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCByb290SXRlbSA9IHJvb3ROb2RlSWQgPyBieUlkLmdldChyb290Tm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocm9vdE5vZGVJZCAmJiAhcm9vdEl0ZW0pIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTk9ERV9OT1RfRk9VTkQnLCBg6IqC54K5ICR7cm9vdE5vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgY29uc3QgbWF4RGVwdGggPSBib3VuZGVkSW50ZWdlcihpbnB1dC5kZXB0aCwgOCwgMCwgMzIsICdkZXB0aCcpO1xyXG4gICAgICAgIGNvbnN0IGxpbWl0ID0gYm91bmRlZEludGVnZXIoaW5wdXQubGltaXQsIDUwLCAxLCAyMDAsICdsaW1pdCcpO1xyXG4gICAgICAgIGNvbnN0IHNlYXJjaCA9IHR5cGVvZiBpbnB1dC5zZWFyY2ggPT09ICdzdHJpbmcnID8gaW5wdXQuc2VhcmNoLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgpIDogJyc7XHJcbiAgICAgICAgY29uc3QgdHlwZXMgPSBvcHRpb25hbFN0cmluZ0FycmF5KGlucHV0LnR5cGVzLCAndHlwZXMnKTtcclxuICAgICAgICBjb25zdCBhY3Rpb25zID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC5hY3Rpb25zLCAnYWN0aW9ucycpO1xyXG4gICAgICAgIGNvbnN0IGtpbmRzID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC5raW5kcywgJ2tpbmRzJyk7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZ09ubHkgPSBpbnB1dC53YXJuaW5nT25seSA9PT0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSBvdmVycmlkZU1hcChkb2N1bWVudCk7XHJcbiAgICAgICAgY29uc3QgcHJlZmVycmVkQWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+KCk7XHJcbiAgICAgICAgY29uc3QgZm9yY2VkUmVuZGVySWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlcy5nZXQoaXRlbS5ub2RlLmlkKTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmVycmVkID0gc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgICAgICAgICA/IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzYXZlZC5hY3Rpb24pXHJcbiAgICAgICAgICAgICAgICA6IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBwcmVmZXJyZWRBY3Rpb25zLnNldChcclxuICAgICAgICAgICAgICAgIGl0ZW0ubm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZlcnJlZCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgbmluZVNsaWNlID0gc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQubmluZVNsaWNlIDogaXRlbS5ub2RlLnBhdGNoQ2FuZGlkYXRlO1xyXG4gICAgICAgICAgICBpZiAobmluZVNsaWNlICYmIGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgZm9yY2VkUmVuZGVySWRzLmFkZChpdGVtLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGRvY3VtZW50LnRyZWUsIHByZWZlcnJlZEFjdGlvbnMsIGZvcmNlZFJlbmRlcklkcyxcclxuICAgICAgICAgICAgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHN0YXRlLnNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UpO1xyXG4gICAgICAgIGNvbnN0IHJvb3REZXB0aCA9IHJvb3RJdGVtPy5kZXB0aCA/PyAwO1xyXG4gICAgICAgIGNvbnN0IGRlc2NlbmRhbnRzID0gcm9vdEl0ZW1cclxuICAgICAgICAgICAgPyBuZXcgU2V0KGluZGV4VHJlZShbcm9vdEl0ZW0ubm9kZV0pLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSlcclxuICAgICAgICAgICAgOiBudWxsO1xyXG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhbGwuZmlsdGVyKChpdGVtKSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChkZXNjZW5kYW50cyAmJiAhZGVzY2VuZGFudHMuaGFzKGl0ZW0ubm9kZS5pZCkpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uZGVwdGggLSByb290RGVwdGggPiBtYXhEZXB0aCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlcy5nZXQoaXRlbS5ub2RlLmlkKTtcclxuICAgICAgICAgICAgY29uc3QgY29jb3NOYW1lID0gc2F2ZWQ/Lm5hbWUgPz8gaXRlbS5ub2RlLm5hbWU7XHJcbiAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IGVmZmVjdGl2ZS5hY3Rpb25zLmdldChpdGVtLm5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBraW5kID0gZWZmZWN0aXZlS2luZEZvck5vZGUoXHJcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICBzYXZlZD8uZXhwbGljaXQgPT09IHRydWUgPyBzYXZlZC5raW5kIDogaXRlbS5ub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAgICAgICAgICBzYXZlZD8uZXhwbGljaXQgPT09IHRydWUgPyBzYXZlZC5uaW5lU2xpY2UgOiBpdGVtLm5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmIChzZWFyY2ggJiYgIWAke2l0ZW0ubm9kZS5uYW1lfVxcbiR7Y29jb3NOYW1lfVxcbiR7aXRlbS5wYXRoLmpvaW4oJy8nKX1gLnRvTG9jYWxlTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBpZiAodHlwZXMgJiYgIXR5cGVzLmluY2x1ZGVzKGl0ZW0ubm9kZS50eXBlKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBpZiAoYWN0aW9ucyAmJiAhYWN0aW9ucy5pbmNsdWRlcyhhY3Rpb24pKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGlmIChraW5kcyAmJiAha2luZHMuaW5jbHVkZXMoa2luZCkpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgaWYgKHdhcm5pbmdPbmx5ICYmICFpdGVtLm5vZGUud2FybmluZykgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBxdWVyeUhhc2ggPSBzdGFibGVIYXNoKHtcclxuICAgICAgICAgICAgcm9vdE5vZGVJZDogcm9vdE5vZGVJZCA/PyBudWxsLFxyXG4gICAgICAgICAgICBzZWFyY2gsXHJcbiAgICAgICAgICAgIHR5cGVzOiB0eXBlcyA/IFsuLi50eXBlc10uc29ydCgpIDogbnVsbCxcclxuICAgICAgICAgICAgYWN0aW9uczogYWN0aW9ucyA/IFsuLi5hY3Rpb25zXS5zb3J0KCkgOiBudWxsLFxyXG4gICAgICAgICAgICBraW5kczoga2luZHMgPyBbLi4ua2luZHNdLnNvcnQoKSA6IG51bGwsXHJcbiAgICAgICAgICAgIHdhcm5pbmdPbmx5LFxyXG4gICAgICAgICAgICBpbXBvcnRIaWRkZW5MYXllcnM6IHN0YXRlLnNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UsXHJcbiAgICAgICAgICAgIGRlcHRoOiBtYXhEZXB0aCxcclxuICAgICAgICAgICAgbGltaXQsXHJcbiAgICAgICAgICAgIG92ZXJyaWRlczogWy4uLmRvY3VtZW50Lm5vZGVPdmVycmlkZXNdXHJcbiAgICAgICAgICAgICAgICAuc29ydCgobGVmdCwgcmlnaHQpID0+IGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdodC5pZCkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChpdGVtKSA9PiAoe1xyXG4gICAgICAgICAgICAgICAgICAgIGlkOiBpdGVtLmlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFjdGlvbjogaXRlbS5hY3Rpb24sXHJcbiAgICAgICAgICAgICAgICAgICAga2luZDogaXRlbS5raW5kLFxyXG4gICAgICAgICAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lID8/IG51bGwsXHJcbiAgICAgICAgICAgICAgICB9KSksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3Qgb2Zmc2V0ID0gZGVjb2RlQ3Vyc29yKGlucHV0LmN1cnNvciwgc2Vzc2lvbi5pZCwgc2Vzc2lvbi5yZXZpc2lvbiwgcXVlcnlIYXNoKTtcclxuICAgICAgICBjb25zdCBwYWdlID0gY2FuZGlkYXRlcy5zbGljZShvZmZzZXQsIG9mZnNldCArIGxpbWl0KTtcclxuICAgICAgICBjb25zdCBub2RlcyA9IHBhZ2UubWFwKChpdGVtKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVzLmdldChpdGVtLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmZXJyZWRBY3Rpb24gPSBwcmVmZXJyZWRBY3Rpb25zLmdldChpdGVtLm5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBhY3Rpb24gPSBlZmZlY3RpdmUuYWN0aW9ucy5nZXQoaXRlbS5ub2RlLmlkKSA/PyBwcmVmZXJyZWRBY3Rpb247XHJcbiAgICAgICAgICAgIGNvbnN0IG5pbmVTbGljZSA9IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSA/IHNhdmVkLm5pbmVTbGljZSA6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogaXRlbS5ub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFyZW50Tm9kZUlkOiBpdGVtLnBhcmVudE5vZGVJZCxcclxuICAgICAgICAgICAgICAgIGRlcHRoOiBpdGVtLmRlcHRoIC0gcm9vdERlcHRoLFxyXG4gICAgICAgICAgICAgICAgcGF0aDogaXRlbS5wYXRoLmpvaW4oJy8nKSxcclxuICAgICAgICAgICAgICAgIGZpZ21hTmFtZTogaXRlbS5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWU6IHNhdmVkPy5uYW1lID8/IGl0ZW0ubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgcmVuYW1lZDogQm9vbGVhbihzYXZlZD8ubmFtZSAmJiBzYXZlZC5uYW1lICE9PSBpdGVtLm5vZGUubmFtZSksXHJcbiAgICAgICAgICAgICAgICB0eXBlOiBpdGVtLm5vZGUudHlwZSxcclxuICAgICAgICAgICAgICAgIHZpc2libGU6IGl0ZW0ubm9kZS52aXNpYmxlLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGl0ZW0ubm9kZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogaXRlbS5ub2RlLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGNoaWxkQ291bnQ6IGl0ZW0ubm9kZS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICBwcmVmZXJyZWRBY3Rpb24sXHJcbiAgICAgICAgICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAgICAgICAgICBraW5kOiBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQua2luZCA6IGl0ZW0ubm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgICAgIGFjdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBuaW5lU2xpY2UsXHJcbiAgICAgICAgICAgICAgICApLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgICAgIHN1cHByZXNzZWQ6IGVmZmVjdGl2ZS5zdXBwcmVzc2VkLmhhcyhpdGVtLm5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgcGF0Y2hDYW5kaWRhdGU6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIHNsaWNlTW9kZTogaXRlbS5ub2RlLnNsaWNlTW9kZSxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gJ3VzZXItb3ZlcnJpZGUnIDogaXRlbS5ub2RlLnJlYXNvbixcclxuICAgICAgICAgICAgICAgIGZvbGQ6IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSB8fCBCb29sZWFuKHNhdmVkPy5uYW1lKSA/IHVuZGVmaW5lZCA6IGl0ZW0ubm9kZS5mb2xkLFxyXG4gICAgICAgICAgICAgICAgd2FybmluZzogaXRlbS5ub2RlLndhcm5pbmcsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgbmV4dE9mZnNldCA9IG9mZnNldCArIHBhZ2UubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHRvdGFsQ291bnQ6IGNhbmRpZGF0ZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBjb3VudDogbm9kZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBub2RlcyxcclxuICAgICAgICAgICAgaGFzTW9yZTogbmV4dE9mZnNldCA8IGNhbmRpZGF0ZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBuZXh0Q3Vyc29yOiBuZXh0T2Zmc2V0IDwgY2FuZGlkYXRlcy5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gZW5jb2RlQ3Vyc29yKHNlc3Npb24uaWQsIHNlc3Npb24ucmV2aXNpb24sIG5leHRPZmZzZXQsIHF1ZXJ5SGFzaClcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBnZXRQcmV2aWV3KHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heaIluWFiOWPlua2iOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IHsgZG9jdW1lbnQgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcclxuICAgICAgICBjb25zdCBub2RlSWQgPSByZXF1aXJlZFN0cmluZyhpbnB1dC5ub2RlSWQsICdub2RlSWQnLCAyNTYpO1xyXG4gICAgICAgIGlmICghaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLnNvbWUoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCA9PT0gbm9kZUlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ05PREVfTk9UX0ZPVU5EJywgYOiKgueCuSAke25vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzLmhvc3QuZ2V0UHJldmlldyhub2RlSWQpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYnVpbGRTZXR0aW5ncyhcclxuICAgICAgICBkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG8sXHJcbiAgICAgICAgc3RhdGU6IFBsdWdpblN0YXRlRHRvLFxyXG4gICAgICAgIHZhbHVlOiB1bmtub3duLFxyXG4gICAgKTogeyBwYXRjaDogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz47IHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyB9IHtcclxuICAgICAgICBjb25zdCBwYXRjaCA9IHJlY29yZCh2YWx1ZSk7XHJcbiAgICAgICAgY29uc3QgYWxsb3dlZEtleXMgPSBuZXcgU2V0KFtcclxuICAgICAgICAgICAgJ2Fzc2V0Rm9sZGVyJyxcclxuICAgICAgICAgICAgJ3ByZWZhYkZvbGRlcicsXHJcbiAgICAgICAgICAgICdzY2FsZScsXHJcbiAgICAgICAgICAgICd1cGRhdGVFeGlzdGluZycsXHJcbiAgICAgICAgICAgICdyZWZyZXNoQXNzZXRzJyxcclxuICAgICAgICAgICAgJ2F1dG9TYXZlJyxcclxuICAgICAgICAgICAgJ2ltcG9ydEhpZGRlbkxheWVycycsXHJcbiAgICAgICAgICAgICdmb250TWFwJyxcclxuICAgICAgICBdKTtcclxuICAgICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMocGF0Y2gpO1xyXG4gICAgICAgIGlmICgha2V5cy5sZW5ndGggfHwga2V5cy5zb21lKChrZXkpID0+ICFhbGxvd2VkS2V5cy5oYXMoa2V5KSkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1NFVFRJTkdTJywgJ3NldHRpbmdzIOW/hemhu+WMheWQq+iHs+WwkeS4gOS4quWPl+aUr+aMgeeahOiuvue9ruWtl+auteOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub3JtYWxpemVkOiBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPiA9IHsgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwgfTtcclxuICAgICAgICBjb25zdCBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MgPSB7XHJcbiAgICAgICAgICAgIC4uLnN0YXRlLnNldHRpbmdzLFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICB9O1xyXG4gICAgICAgIGlmIChwYXRjaC5hc3NldEZvbGRlciAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIHNldHRpbmdzLmFzc2V0Rm9sZGVyID0gc2FmZVJlbGF0aXZlQXNzZXRGb2xkZXIocGF0Y2guYXNzZXRGb2xkZXIsICdhc3NldEZvbGRlcicpO1xyXG4gICAgICAgICAgICBub3JtYWxpemVkLmFzc2V0Rm9sZGVyID0gc2V0dGluZ3MuYXNzZXRGb2xkZXI7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChwYXRjaC5wcmVmYWJGb2xkZXIgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICBzZXR0aW5ncy5wcmVmYWJGb2xkZXIgPSBzYWZlUmVsYXRpdmVBc3NldEZvbGRlcihwYXRjaC5wcmVmYWJGb2xkZXIsICdwcmVmYWJGb2xkZXInKTtcclxuICAgICAgICAgICAgbm9ybWFsaXplZC5wcmVmYWJGb2xkZXIgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChwYXRjaC5zY2FsZSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIGlmICh0eXBlb2YgcGF0Y2guc2NhbGUgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNGaW5pdGUocGF0Y2guc2NhbGUpIHx8IHBhdGNoLnNjYWxlIDwgMC4yNSB8fCBwYXRjaC5zY2FsZSA+IDQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsICdzY2FsZSDlv4XpobvmmK8gMC4yNeKAkzQg5LmL6Ze055qE5pWw5a2X44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2V0dGluZ3Muc2NhbGUgPSBwYXRjaC5zY2FsZTtcclxuICAgICAgICAgICAgbm9ybWFsaXplZC5zY2FsZSA9IHBhdGNoLnNjYWxlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBbJ3VwZGF0ZUV4aXN0aW5nJywgJ3JlZnJlc2hBc3NldHMnLCAnYXV0b1NhdmUnLCAnaW1wb3J0SGlkZGVuTGF5ZXJzJ10gYXMgY29uc3QpIHtcclxuICAgICAgICAgICAgaWYgKHBhdGNoW2tleV0gIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBwYXRjaFtrZXldICE9PSAnYm9vbGVhbicpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsIGAke2tleX0g5b+F6aG75piv5biD5bCU5YC844CCYCk7XHJcbiAgICAgICAgICAgICAgICBzZXR0aW5nc1trZXldID0gcGF0Y2hba2V5XTtcclxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRba2V5XSA9IHBhdGNoW2tleV07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHBhdGNoLmZvbnRNYXAgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICBpZiAoIXBhdGNoLmZvbnRNYXAgfHwgdHlwZW9mIHBhdGNoLmZvbnRNYXAgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGF0Y2guZm9udE1hcCkpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsICdmb250TWFwIOW/hemhu+aYr+WvueixoeOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBbZm9udCwgdXJsXSBvZiBPYmplY3QuZW50cmllcyhwYXRjaC5mb250TWFwIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xyXG4gICAgICAgICAgICAgICAgaWYgKCFmb250LnRyaW0oKSB8fCB0eXBlb2YgdXJsICE9PSAnc3RyaW5nJyB8fCAodXJsICYmICF1cmwuc3RhcnRzV2l0aCgnZGI6Ly9hc3NldHMvJykpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1NFVFRJTkdTJywgJ2ZvbnRNYXAg5Y+q6IO95byV55SoIGRiOi8vYXNzZXRzIOS4i+eahOWtl+S9k+i1hOa6kOOAgicpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgZm9udE1hcFtmb250LnRyaW0oKV0gPSB1cmwudHJpbSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNldHRpbmdzLmZvbnRNYXAgPSBmb250TWFwO1xyXG4gICAgICAgICAgICBub3JtYWxpemVkLmZvbnRNYXAgPSBmb250TWFwO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBwYXRjaDogbm9ybWFsaXplZCwgc2V0dGluZ3MgfTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFwcGx5U2V0dGluZ3MocGFyYW1zOiB1bmtub3duLCBpbmNyZW1lbnRSZXZpc2lvbiA9IHRydWUpOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSByZWNvcmQocGFyYW1zKTtcclxuICAgICAgICBjb25zdCBvcGVyYXRpb24gPSBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHsgc2Vzc2lvbiwgZG9jdW1lbnQsIHN0YXRlIH0gPSBhd2FpdCB0aGlzLmN1cnJlbnREb2N1bWVudChpbnB1dCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGJ1aWx0ID0gdGhpcy5idWlsZFNldHRpbmdzKGRvY3VtZW50LCBzdGF0ZSwgaW5wdXQuc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHRoaXMuaG9zdC5wYXRjaFNldHRpbmdzXHJcbiAgICAgICAgICAgICAgICA/IGF3YWl0IHRoaXMuaG9zdC5wYXRjaFNldHRpbmdzKGJ1aWx0LnBhdGNoKVxyXG4gICAgICAgICAgICAgICAgOiBhd2FpdCB0aGlzLmhvc3Quc2F2ZVNldHRpbmdzKGJ1aWx0LnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluY3JlbWVudFJldmlzaW9uKSBzZXNzaW9uLnJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgICAgIHJldHVybiBzYXZlZDtcclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuc2V0dGluZ3NXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcclxuICAgICAgICB0aGlzLnNldHRpbmdzV3JpdGVRdWV1ZSA9IHJlc3VsdC50aGVuKCgpID0+IHVuZGVmaW5lZCwgKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgdXBkYXRlU2V0dGluZ3MocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0JVU1knLCAn5a+85YWl5omn6KGM5pyf6Ze05LiN6IO95L+u5pS56K6+572u44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBwdWJsaWNTZXR0aW5ncyhhd2FpdCB0aGlzLmFwcGx5U2V0dGluZ3MocGFyYW1zKSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyByZW5hbWVOb2RlcyhwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcclxuICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQgfHwgdGhpcy5ob3N0LmlzSW1wb3J0QnVzeSgpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICflr7zlhaXmiafooYzmnJ/pl7TkuI3og73kv67mlLnoioLngrnlkI3np7DjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSByZWNvcmQocGFyYW1zKTtcclxuICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50IH0gPSBhd2FpdCB0aGlzLmN1cnJlbnREb2N1bWVudChpbnB1dCk7XHJcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LnJlbmFtZXMpIHx8ICFpbnB1dC5yZW5hbWVzLmxlbmd0aCB8fCBpbnB1dC5yZW5hbWVzLmxlbmd0aCA+IDUwMCkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsICdyZW5hbWVzIOW/hemhu+WMheWQqyAx4oCTNTAwIOS4quaUueWQjemhueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBhbGxvd1Jvb3RSZW5hbWUgPSBpbnB1dC5hbGxvd1Jvb3RSZW5hbWUgPT09IHRydWU7XHJcbiAgICAgICAgY29uc3QgYWxsID0gaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGNvbnN0IGJ5SWQgPSBuZXcgTWFwKGFsbC5tYXAoKGl0ZW0pID0+IFtpdGVtLm5vZGUuaWQsIGl0ZW0ubm9kZV0pKTtcclxuICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlTWFwKGRvY3VtZW50KTtcclxuICAgICAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgY29uc3QgdmFsdWVzOiBJbXBvcnRPdmVycmlkZVtdID0gW107XHJcbiAgICAgICAgY29uc3QgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdID0gW107XHJcbiAgICAgICAgY29uc3QgdXBkYXRlZDogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCByYXcgb2YgaW5wdXQucmVuYW1lcykge1xyXG4gICAgICAgICAgICBjb25zdCBpdGVtID0gcmVjb3JkKHJhdyk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGVJZCA9IHJlcXVpcmVkU3RyaW5nKGl0ZW0ubm9kZUlkLCAnbm9kZUlkJywgMjU2KTtcclxuICAgICAgICAgICAgaWYgKHNlZW4uaGFzKG5vZGVJZCkpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g6YeN5aSN5Ye6546w44CCYCk7XHJcbiAgICAgICAgICAgIHNlZW4uYWRkKG5vZGVJZCk7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBieUlkLmdldChub2RlSWQpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTk9ERV9OT1RfRk9VTkQnLCBg6IqC54K5ICR7bm9kZUlkfSDkuI3lrZjlnKjjgIJgKTtcclxuICAgICAgICAgICAgaWYgKHNlc3Npb24ucm9vdElkcy5oYXMobm9kZUlkKSAmJiAhYWxsb3dSb290UmVuYW1lKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgJ1JPT1RfUkVOQU1FX1JFUVVJUkVTX0NPTkZJUk1BVElPTicsXHJcbiAgICAgICAgICAgICAgICAgICAgYOiKgueCuSAke25vZGVJZH0g5piv5a+85YWl5qC577yb5pS55ZCN5Lya5pS55Y+Y6ZO+5o6lIEZyYW1lIOeahCBQcmVmYWIg5paH5Lu25ZCN77yM6K+36K6+572uIGFsbG93Um9vdFJlbmFtZT10cnVlIOaYjuehruehruiupOOAgmAsXHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzYXZlZC5nZXQobm9kZUlkKSA/PyBkZWZhdWx0T3ZlcnJpZGUobm9kZSkpIH07XHJcbiAgICAgICAgICAgIGxldCBjb2Nvc05hbWUgPSBub2RlLm5hbWU7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLm5hbWUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50Lm5hbWU7XHJcbiAgICAgICAgICAgICAgICBwYXRjaGVzLnB1c2goeyBpZDogbm9kZUlkLCBuYW1lOiBudWxsLCBmYWxsYmFjazogY3VycmVudCB9KTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoIW5hbWUpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9OT0RFX05BTUUnLCBg6IqC54K5ICR7bm9kZUlkfSDnmoTlkI3np7DmuIXmtJflkI7kuLrnqbrjgIJgKTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWUgPSBuYW1lO1xyXG4gICAgICAgICAgICAgICAgcGF0Y2hlcy5wdXNoKHsgaWQ6IG5vZGVJZCwgbmFtZSwgZmFsbGJhY2s6IGN1cnJlbnQgfSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdmFsdWVzLnB1c2goY3VycmVudCk7XHJcbiAgICAgICAgICAgIHVwZGF0ZWQucHVzaCh7XHJcbiAgICAgICAgICAgICAgICBub2RlSWQsXHJcbiAgICAgICAgICAgICAgICBmaWdtYU5hbWU6IG5vZGUubmFtZSxcclxuICAgICAgICAgICAgICAgIGNvY29zTmFtZSxcclxuICAgICAgICAgICAgICAgIHJlc2V0OiBpdGVtLm5hbWUgPT09IG51bGwsXHJcbiAgICAgICAgICAgICAgICB3YXJuaW5nOiBzZXNzaW9uLnJvb3RJZHMuaGFzKG5vZGVJZClcclxuICAgICAgICAgICAgICAgICAgICA/ICfmoLnoioLngrnmlLnlkI3kvJrmlLnlj5jpk77mjqUgRnJhbWUg55qEIFByZWZhYiDmlofku7blkI3jgIInXHJcbiAgICAgICAgICAgICAgICAgICAgOiAn5pS55ZCN6IqC54K55Lya5L+d55WZ5Li654us56uLIENvY29zIOiKgueCue+8jOWPr+iDvemYu+atouinhuinieWMheijheWxguaKmOWPoOOAgicsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGhpcy5ob3N0LnBhdGNoTm9kZU5hbWVzKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuaG9zdC5wYXRjaE5vZGVOYW1lcyhkb2N1bWVudC5maWxlS2V5LCBwYXRjaGVzKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmhvc3Quc2F2ZU5vZGVPdmVycmlkZXMoZG9jdW1lbnQuZmlsZUtleSwgdmFsdWVzLCBbLi4uc2Vlbl0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXNzaW9uLnJldmlzaW9uICs9IDE7XHJcbiAgICAgICAgcmV0dXJuIHsgdXBkYXRlZCB9O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgdXBkYXRlTm9kZXMocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0JVU1knLCAn5a+85YWl5omn6KGM5pyf6Ze05LiN6IO95L+u5pS56IqC54K5562W55Wl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3QgeyBzZXNzaW9uLCBkb2N1bWVudCB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xyXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShpbnB1dC51cGRhdGVzKSB8fCAhaW5wdXQudXBkYXRlcy5sZW5ndGggfHwgaW5wdXQudXBkYXRlcy5sZW5ndGggPiA1MDApIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAndXBkYXRlcyDlv4XpobvljIXlkKsgMeKAkzUwMCDkuKroioLngrnorr7nva7jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYWxsb3dSb290UmVuYW1lID0gaW5wdXQuYWxsb3dSb290UmVuYW1lID09PSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCBieUlkID0gbmV3IE1hcChhbGwubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGVdKSk7XHJcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBvdmVycmlkZU1hcChkb2N1bWVudCk7XHJcbiAgICAgICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IHZhbHVlczogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgcmF3IG9mIGlucHV0LnVwZGF0ZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHJlY29yZChyYXcpO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlSWQgPSByZXF1aXJlZFN0cmluZyhpdGVtLm5vZGVJZCwgJ25vZGVJZCcsIDI1Nik7XHJcbiAgICAgICAgICAgIGlmIChzZWVuLmhhcyhub2RlSWQpKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGDoioLngrkgJHtub2RlSWR9IOmHjeWkjeWHuueOsOOAgmApO1xyXG4gICAgICAgICAgICBzZWVuLmFkZChub2RlSWQpO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gYnlJZC5nZXQobm9kZUlkKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ05PREVfTk9UX0ZPVU5EJywgYOiKgueCuSAke25vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzYXZlZC5nZXQobm9kZUlkKSA/PyBkZWZhdWx0T3ZlcnJpZGUobm9kZSkpIH07XHJcbiAgICAgICAgICAgIGxldCBzdHJhdGVneUNoYW5nZWQgPSBmYWxzZTtcclxuICAgICAgICAgICAgaWYgKGl0ZW0uYWN0aW9uICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIGlmICghSU1QT1JUX0FDVElPTlMuaGFzKGl0ZW0uYWN0aW9uIGFzIEltcG9ydEFjdGlvbikpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g55qEIGFjdGlvbiDml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQuYWN0aW9uID0gaXRlbS5hY3Rpb24gYXMgSW1wb3J0QWN0aW9uO1xyXG4gICAgICAgICAgICAgICAgc3RyYXRlZ3lDaGFuZ2VkID0gdHJ1ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoaXRlbS5raW5kICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIGlmICghTk9ERV9LSU5EUy5oYXMoaXRlbS5raW5kIGFzIE5vZGVLaW5kKSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBg6IqC54K5ICR7bm9kZUlkfSDnmoQga2luZCDml6DmlYjjgIJgKTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQua2luZCA9IGl0ZW0ua2luZCBhcyBOb2RlS2luZDtcclxuICAgICAgICAgICAgICAgIHN0cmF0ZWd5Q2hhbmdlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGl0ZW0ubmluZVNsaWNlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaXRlbS5uaW5lU2xpY2UgIT09ICdib29sZWFuJykgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBg6IqC54K5ICR7bm9kZUlkfSDnmoQgbmluZVNsaWNlIOW/hemhu+aYr+W4g+WwlOWAvOOAgmApO1xyXG4gICAgICAgICAgICAgICAgY3VycmVudC5uaW5lU2xpY2UgPSBpdGVtLm5pbmVTbGljZTtcclxuICAgICAgICAgICAgICAgIHN0cmF0ZWd5Q2hhbmdlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGl0ZW0ubmFtZSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2Vzc2lvbi5yb290SWRzLmhhcyhub2RlSWQpICYmICFhbGxvd1Jvb3RSZW5hbWUpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ1JPT1RfUkVOQU1FX1JFUVVJUkVTX0NPTkZJUk1BVElPTicsIGDoioLngrkgJHtub2RlSWR9IOaYr+WvvOWFpeague+8jOivt+aYjuehruWFgeiuuOagueiKgueCueaUueWQjeOAgmApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ubmFtZSA9PT0gbnVsbCkgZGVsZXRlIGN1cnJlbnQubmFtZTtcclxuICAgICAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfTk9ERV9OQU1FJywgYOiKgueCuSAke25vZGVJZH0g55qE5ZCN56ew5riF5rSX5ZCO5Li656m644CCYCk7XHJcbiAgICAgICAgICAgICAgICAgICAgY3VycmVudC5uYW1lID0gbmFtZTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXN0cmF0ZWd5Q2hhbmdlZCAmJiBpdGVtLm5hbWUgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBg6IqC54K5ICR7bm9kZUlkfSDmsqHmnInmj5Dkvpvku7vkvZXkv67mlLnjgIJgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoc3RyYXRlZ3lDaGFuZ2VkKSBjdXJyZW50LmV4cGxpY2l0ID0gdHJ1ZTtcclxuICAgICAgICAgICAgdmFsdWVzLnB1c2goY3VycmVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZCA9IGF3YWl0IHRoaXMuaG9zdC5zYXZlTm9kZU92ZXJyaWRlcyhkb2N1bWVudC5maWxlS2V5LCB2YWx1ZXMsIFsuLi5zZWVuXSk7XHJcbiAgICAgICAgc2Vzc2lvbi5yZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIHJldHVybiB7IHVwZGF0ZWQ6IHBlcnNpc3RlZCB9O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgaW1wb3J0RG9jdW1lbnQocGFyYW1zOiB1bmtub3duLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3QgeyBzZXNzaW9uLCBkb2N1bWVudCwgc3RhdGUgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcclxuICAgICAgICBjb25zdCBvcGVyYXRpb25JZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0Lm9wZXJhdGlvbklkLCAnb3BlcmF0aW9uSWQnLCAxMjgpO1xyXG4gICAgICAgIGlmIChvcGVyYXRpb25JZC5sZW5ndGggPCA4IHx8ICEvXltBLVphLXowLTkuXzotXSskLy50ZXN0KG9wZXJhdGlvbklkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsICdvcGVyYXRpb25JZCDoh7PlsJEgOCDkuKrlrZfnrKbvvIzkuJTlj6rog73ljIXlkKvlrZfmr43jgIHmlbDlrZfjgIHngrnjgIHkuIvliJLnur/jgIHlhpLlj7flkozov57lrZfnrKbjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGlucHV0LmNvbmZpcm0gIT09IHRydWUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdDT05GSVJNQVRJT05fUkVRVUlSRUQnLCAn5a+85YWl5Lya5L+u5pS5IENvY29zIOmhueebru+8m+ivt+iuvue9riBjb25maXJtPXRydWUg5piO56Gu56Gu6K6k44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHByb2plY3RlZFNldHRpbmdzID0gaW5wdXQuc2V0dGluZ3MgPT09IHVuZGVmaW5lZFxyXG4gICAgICAgICAgICA/IHN0YXRlLnNldHRpbmdzXHJcbiAgICAgICAgICAgIDogdGhpcy5idWlsZFNldHRpbmdzKGRvY3VtZW50LCBzdGF0ZSwgaW5wdXQuc2V0dGluZ3MpLnNldHRpbmdzO1xyXG4gICAgICAgIGNvbnN0IHByb2plY3RlZE92ZXJyaWRlcyA9IHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGRvY3VtZW50LCBwcm9qZWN0ZWRTZXR0aW5ncyk7XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdEZpbmdlcnByaW50ID0gaW1wb3J0UmVxdWVzdEZpbmdlcnByaW50KGRvY3VtZW50LCBwcm9qZWN0ZWRTZXR0aW5ncywgcHJvamVjdGVkT3ZlcnJpZGVzKTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZWQgPSB0aGlzLmNvbXBsZXRlZEltcG9ydHMuZ2V0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICBpZiAoY29tcGxldGVkKSB7XHJcbiAgICAgICAgICAgIGlmIChjb21wbGV0ZWQuZG9jdW1lbnRTZXNzaW9uSWQgIT09IHNlc3Npb24uaWRcclxuICAgICAgICAgICAgICAgIHx8IGNvbXBsZXRlZC5yZXF1ZXN0RmluZ2VycHJpbnQgIT09IHJlcXVlc3RGaW5nZXJwcmludCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdPUEVSQVRJT05fSURfQ09ORkxJQ1QnLCAn6K+lIG9wZXJhdGlvbklkIOW3sueUqOS6juS4jeWQjOeahOaWh+aho+OAgeiuvue9ruaIluiKgueCueetlueVpeOAguivt+S4uuaWsOWvvOWFpeeUn+aIkOaWsOeahCBvcGVyYXRpb25JZOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiBjb21wbGV0ZWQucmVzcG9uc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCkge1xyXG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQub3BlcmF0aW9uSWQgPT09IG9wZXJhdGlvbklkXHJcbiAgICAgICAgICAgICAgICAmJiB0aGlzLmFjdGl2ZUltcG9ydC5kb2N1bWVudFNlc3Npb25JZCA9PT0gc2Vzc2lvbi5pZFxyXG4gICAgICAgICAgICAgICAgJiYgdGhpcy5hY3RpdmVJbXBvcnQucmVxdWVzdEZpbmdlcnByaW50ID09PSByZXF1ZXN0RmluZ2VycHJpbnQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignT1BFUkFUSU9OX0lOX1BST0dSRVNTJywgJ+ivpSBvcGVyYXRpb25JZCDnmoTlr7zlhaXku43lnKjmiafooYzvvIzor7fnrYnlvoXljp/osIPnlKjov5Tlm57jgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQub3BlcmF0aW9uSWQgPT09IG9wZXJhdGlvbklkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ09QRVJBVElPTl9JRF9DT05GTElDVCcsICfor6Ugb3BlcmF0aW9uSWQg5b2T5YmN57uR5a6a55qE5piv5Y+m5LiA57uE5a+85YWl5Y+C5pWw44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieWvvOWFpeato+WcqOaJp+ihjOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGhpcy5ob3N0LmlzSW1wb3J0QnVzeSgpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICdDb2NvcyDmj5Lku7blvZPliY3mnInlhbbku5bmk43kvZzmraPlnKjmiafooYzjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdDQU5DRUxMRUQnLCAnTUNQIOiwg+eUqOW3suWPlua2iO+8jOWvvOWFpeWwmuacquW8gOWni+OAgicpO1xyXG4gICAgICAgIHRoaXMuYWN0aXZlSW1wb3J0ID0ge1xyXG4gICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IHNlc3Npb24uaWQsXHJcbiAgICAgICAgICAgIHJlcXVlc3RGaW5nZXJwcmludCxcclxuICAgICAgICB9O1xyXG4gICAgICAgIHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gZmFsc2U7XHJcbiAgICAgICAgY29uc3QgY2FuY2VsRm9yU2lnbmFsID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSB0aGlzLmFjdGl2ZUltcG9ydDtcclxuICAgICAgICAgICAgaWYgKCFhY3RpdmUgfHwgYWN0aXZlLm9wZXJhdGlvbklkICE9PSBvcGVyYXRpb25JZCB8fCBhY3RpdmUuZG9jdW1lbnRTZXNzaW9uSWQgIT09IHNlc3Npb24uaWQpIHJldHVybjtcclxuICAgICAgICAgICAgdGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB0aGlzLmhvc3QuY2FuY2VsSW1wb3J0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxGb3JTaWduYWwsIHsgb25jZTogdHJ1ZSB9KTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBpZiAoaW5wdXQuc2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHBseVNldHRpbmdzKHtcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogaW5wdXQuZG9jdW1lbnRTZXNzaW9uSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgc2V0dGluZ3M6IGlucHV0LnNldHRpbmdzLFxyXG4gICAgICAgICAgICAgICAgfSwgZmFsc2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMuaG9zdC5nZXRTdGF0ZSgpO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQ0FOQ0VMTEVEJywgJ+WvvOWFpeW3suWPlua2iOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChzZXNzaW9uLmhvc3RSZXZpc2lvbiAhPT0gdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKVxyXG4gICAgICAgICAgICAgICAgfHwgbGF0ZXN0LmRvY3VtZW50Py5maWxlS2V5ICE9PSBkb2N1bWVudC5maWxlS2V5XHJcbiAgICAgICAgICAgICAgICB8fCBsYXRlc3QuZG9jdW1lbnQuc291cmNlVXJsICE9PSBkb2N1bWVudC5zb3VyY2VVcmwpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignU1RBTEVfRE9DVU1FTlRfU0VTU0lPTicsICflr7zlhaXliY3mlofmoaPlt7Llj5jljJbvvIzor7fph43mlrDor7vlj5YgRmlnbWEg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ0NvY29zIOaPkuS7tuWcqOWvvOWFpeWHhuWkh+acn+mXtOWQr+WKqOS6huWFtuS7luaTjeS9nO+8jOivt+etieW+heWQjumHjeivleWQjOS4gCBvcGVyYXRpb25JZOOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGxhdGVzdC5kb2N1bWVudCwgbGF0ZXN0LnNldHRpbmdzKTtcclxuICAgICAgICAgICAgY29uc3QgbGF0ZXN0RmluZ2VycHJpbnQgPSBpbXBvcnRSZXF1ZXN0RmluZ2VycHJpbnQobGF0ZXN0LmRvY3VtZW50LCBsYXRlc3Quc2V0dGluZ3MsIG92ZXJyaWRlcyk7XHJcbiAgICAgICAgICAgIGlmIChsYXRlc3RGaW5nZXJwcmludCAhPT0gcmVxdWVzdEZpbmdlcnByaW50KSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgJ1NUQUxFX09QRVJBVElPTl9SRVFVRVNUJyxcclxuICAgICAgICAgICAgICAgICAgICAn5a+85YWl5YeG5aSH5pyf6Ze06K6+572u5oiW6IqC54K5562W55Wl5Y+R55Sf5Y+Y5YyW77yb5pys5qyh5rKh5pyJ5omn6KGM5a+85YWl44CC6K+35aSN5p+l5ZCO6YeN6K+V5ZCM5LiAIG9wZXJhdGlvbklk44CCJyxcclxuICAgICAgICAgICAgICAgICAgICB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gc3VtbWFyaXplSW1wb3J0UmVzdWx0KGF3YWl0IHRoaXMuaG9zdC5pbXBvcnRTZWxlY3Rpb24oXHJcbiAgICAgICAgICAgICAgICAgICAgeyBvdmVycmlkZXMsIHNldHRpbmdzOiBsYXRlc3Quc2V0dGluZ3MgfSxcclxuICAgICAgICAgICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgICAgICkpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgb3BlcmF0aW9uSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0LFxyXG4gICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCA/IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgY2FuY2VsbGF0aW9uV2FybmluZzogJ+W3suaUtuWIsOWPlua2iOivt+axgu+8jOS9hiBDb2NvcyDnmoTkuI3lj6/kuK3mlq3mraXpqqTlt7Lnu4/lrozmiJDvvJvmnKzmrKHlr7zlhaXnu5PmnpzmnInmlYjvvIzor7fli7/ph43or5XjgIInLFxyXG4gICAgICAgICAgICAgICAgICAgIH0gOiB7fSksXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgdGhpcy5jb21wbGV0ZWRJbXBvcnRzLnNldChvcGVyYXRpb25JZCwge1xyXG4gICAgICAgICAgICAgICAgICAgIG9wZXJhdGlvbklkLFxyXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50U2Vzc2lvbklkOiBzZXNzaW9uLmlkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlcXVlc3RGaW5nZXJwcmludCxcclxuICAgICAgICAgICAgICAgICAgICByZXNwb25zZSxcclxuICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgd2hpbGUgKHRoaXMuY29tcGxldGVkSW1wb3J0cy5zaXplID4gMzIpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBvbGRlc3QgPSB0aGlzLmNvbXBsZXRlZEltcG9ydHMua2V5cygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvbGRlc3QpIGJyZWFrO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuY29tcGxldGVkSW1wb3J0cy5kZWxldGUob2xkZXN0KTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcclxuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIGlmICh0aGlzLmltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcihcclxuICAgICAgICAgICAgICAgICAgICAgICAgJ0NBTkNFTExFRCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICflj5bmtojor7fmsYLlt7Llj5HpgIHvvJvotYTmupDmiJYgU2NlbmUg55qE5LiN5Y+v5Lit5pat5q2l6aqk5Y+v6IO95bey5a6M5oiQ44CC6K+35YWI5qOA5p+lIENvY29zIOW9k+WJjee7k+aenO+8jOWGjeWGs+WumuaYr+WQpuS9v+eUqOaWsOeahCBvcGVyYXRpb25JZCDph43or5XjgIInLFxyXG4gICAgICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxGb3JTaWduYWwpO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQ/Lm9wZXJhdGlvbklkID09PSBvcGVyYXRpb25JZCkgdGhpcy5hY3RpdmVJbXBvcnQgPSBudWxsO1xyXG4gICAgICAgICAgICB0aGlzLmltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGNhbmNlbEltcG9ydChwYXJhbXM6IHVua25vd24pOiB1bmtub3duIHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50U2Vzc2lvbklkID0gcmVxdWlyZWRTdHJpbmcoaW5wdXQuZG9jdW1lbnRTZXNzaW9uSWQsICdkb2N1bWVudFNlc3Npb25JZCcsIDI1Nik7XHJcbiAgICAgICAgY29uc3Qgb3BlcmF0aW9uSWQgPSByZXF1aXJlZFN0cmluZyhpbnB1dC5vcGVyYXRpb25JZCwgJ29wZXJhdGlvbklkJywgMTI4KTtcclxuICAgICAgICBpZiAob3BlcmF0aW9uSWQubGVuZ3RoIDwgOCB8fCAhL15bQS1aYS16MC05Ll86LV0rJC8udGVzdChvcGVyYXRpb25JZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAnb3BlcmF0aW9uSWQg5qC85byP5peg5pWI44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFjdGl2ZSA9IHRoaXMuYWN0aXZlSW1wb3J0O1xyXG4gICAgICAgIGlmICghYWN0aXZlIHx8IGFjdGl2ZS5vcGVyYXRpb25JZCAhPT0gb3BlcmF0aW9uSWQgfHwgYWN0aXZlLmRvY3VtZW50U2Vzc2lvbklkICE9PSBkb2N1bWVudFNlc3Npb25JZCkge1xyXG4gICAgICAgICAgICBjb25zdCBjb21wbGV0ZWQgPSB0aGlzLmNvbXBsZXRlZEltcG9ydHMuZ2V0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGNhbmNlbGxhdGlvblJlcXVlc3RlZDogZmFsc2UsXHJcbiAgICAgICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogY29tcGxldGVkPy5kb2N1bWVudFNlc3Npb25JZCA9PT0gZG9jdW1lbnRTZXNzaW9uSWRcclxuICAgICAgICAgICAgICAgICAgICA/ICdBTFJFQURZX0NPTVBMRVRFRCdcclxuICAgICAgICAgICAgICAgICAgICA6ICdPUEVSQVRJT05fTk9UX0ZPVU5EJyxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IGludGVycnVwdFNpZ25hbFNlbnQgPSB0aGlzLmhvc3QuY2FuY2VsSW1wb3J0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICBjYW5jZWxsYXRpb25SZXF1ZXN0ZWQ6IHRydWUsXHJcbiAgICAgICAgICAgIG9wZXJhdGlvbklkLFxyXG4gICAgICAgICAgICBpbnRlcnJ1cHRTaWduYWxTZW50LFxyXG4gICAgICAgICAgICBndWFyYW50ZWVkOiBmYWxzZSxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG59XHJcbiJdfQ==