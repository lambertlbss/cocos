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
function resolvedImportOverrides(document) {
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
    const effective = (0, model_1.resolveEffectiveActions)(document.tree, preferredActions, forcedRenderIds);
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
    async listNodes(params) {
        var _a;
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
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
        const effective = (0, model_1.resolveEffectiveActions)(document.tree, preferredActions, forcedRenderIds);
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
        for (const key of ['updateExisting', 'refreshAssets', 'autoSave']) {
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
        const projectedOverrides = resolvedImportOverrides(document);
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
            const overrides = resolvedImportOverrides(latest.document);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tY3AtYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQXVOQSw4QkFTQztBQWhPRCxtQ0FBaUQ7QUFDakQsK0JBQWtDO0FBQ2xDLHFEQUF5RDtBQUN6RCxxQ0FBK0M7QUFDL0MsMkNBQStDO0FBQy9DLGtEQUlnQztBQUNoQyxvREFBNkU7QUF3RTdFLFNBQVMsY0FBYyxDQUFDLFFBQXdCO0lBQzVDLE9BQU87UUFDSCxTQUFTLEVBQUUsUUFBUSxDQUFDLFNBQVM7UUFDN0IsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXO1FBQ2pDLFlBQVksRUFBRSxRQUFRLENBQUMsWUFBWTtRQUNuQyxLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQUs7UUFDckIsY0FBYyxFQUFFLFFBQVEsQ0FBQyxjQUFjO1FBQ3ZDLGFBQWEsRUFBRSxRQUFRLENBQUMsYUFBYTtRQUNyQyxRQUFRLEVBQUUsUUFBUSxDQUFDLFFBQVE7UUFDM0IsT0FBTyxFQUFFLEVBQUUsR0FBRyxRQUFRLENBQUMsT0FBTyxFQUFFO0tBQ25DLENBQUM7QUFDTixDQUFDO0FBU0QsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQWUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzVGLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFXO0lBQ2pDLE1BQU07SUFDTixNQUFNO0lBQ04sUUFBUTtJQUNSLE9BQU87SUFDUCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFlBQVk7SUFDWixRQUFRO0NBQ1gsQ0FBQyxDQUFDO0FBRUgsU0FBUyxNQUFNLENBQUMsS0FBYztJQUMxQixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDOUQsTUFBTSxJQUFJLHlCQUFjLENBQUMs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Q0FBQyxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQztZQUNwRSxNQUFNLElBQUkseUJBQWMsQ0FBQyxpQkFBaUIsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBQ3JFLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQ2pDLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLFdBQVcsS0FBSyxXQUFXLElBQUksTUFBTSxDQUFDLGlCQUFpQixLQUFLLGlCQUFpQixFQUFFLENBQUM7WUFDbEcsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUN6RCxPQUFPO2dCQUNILHFCQUFxQixFQUFFLEtBQUs7Z0JBQzVCLFdBQVc7Z0JBQ1gsTUFBTSxFQUFFLENBQUEsU0FBUyxhQUFULFNBQVMsdUJBQVQsU0FBUyxDQUFFLGlCQUFpQixNQUFLLGlCQUFpQjtvQkFDdEQsQ0FBQyxDQUFDLG1CQUFtQjtvQkFDckIsQ0FBQyxDQUFDLHFCQUFxQjthQUM5QixDQUFDO1FBQ04sQ0FBQztRQUNELElBQUksQ0FBQywyQkFBMkIsR0FBRyxJQUFJLENBQUM7UUFDeEMsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUNoRSxPQUFPO1lBQ0gscUJBQXFCLEVBQUUsSUFBSTtZQUMzQixXQUFXO1lBQ1gsbUJBQW1CO1lBQ25CLFVBQVUsRUFBRSxLQUFLO1NBQ3BCLENBQUM7SUFDTixDQUFDO0NBQ0o7QUEzbEJELGtEQTJsQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoLCByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XHJcbmltcG9ydCB7IGlzQWJzb2x1dGUgfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHsgbm9ybWFsaXplSW1wb3J0QWN0aW9uIH0gZnJvbSAnLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuL25vZGUtbmFtZSc7XHJcbmltcG9ydCB7XHJcbiAgICBlZmZlY3RpdmVLaW5kRm9yTm9kZSxcclxuICAgIHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zLFxyXG4gICAgc21hcnRBY3Rpb25Gb3JOb2RlLFxyXG59IGZyb20gJy4vcGFuZWxzL2RlZmF1bHQvbW9kZWwnO1xyXG5pbXBvcnQgeyBNY3BCcmlkZ2VFcnJvciwgdHlwZSBNY3BCcmlkZ2VNZXRob2QgfSBmcm9tICcuL21jcC1icmlkZ2UvcHJvdG9jb2wnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBJbXBvcnRBY3Rpb24sXHJcbiAgICBJbXBvcnRPdmVycmlkZSxcclxuICAgIEltcG9ydFJlcXVlc3QsXHJcbiAgICBJbXBvcnRTZXR0aW5ncyxcclxuICAgIE5vZGVLaW5kLFxyXG4gICAgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgUGx1Z2luRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIG5vZGVPdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW107XHJcbn1cclxuXHJcbmludGVyZmFjZSBQbHVnaW5TdGF0ZUR0byB7XHJcbiAgICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgICB2YXVsdDoge1xyXG4gICAgICAgIGhhc1Rva2VuOiBib29sZWFuO1xyXG4gICAgICAgIHBlcnNpc3RlbnQ6IGJvb2xlYW47XHJcbiAgICAgICAgYmFja2VuZDogc3RyaW5nO1xyXG4gICAgICAgIHdhcm5pbmc/OiBzdHJpbmc7XHJcbiAgICB9O1xyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvIHwgbnVsbDtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBNY3BBcGlIb3N0IHtcclxuICAgIHByb2plY3RQYXRoOiBzdHJpbmc7XHJcbiAgICBjcmVhdG9yVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgZ2V0RG9jdW1lbnRSZXZpc2lvbigpOiBudW1iZXI7XHJcbiAgICBpc0ltcG9ydEJ1c3koKTogYm9vbGVhbjtcclxuICAgIGdldFN0YXRlKCk6IFByb21pc2U8UGx1Z2luU3RhdGVEdG8+O1xyXG4gICAgZmV0Y2hEb2N1bWVudChzb3VyY2VVcmw6IHN0cmluZyk6IFByb21pc2U8UGx1Z2luRG9jdW1lbnREdG8+O1xyXG4gICAgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PjtcclxuICAgIHNhdmVTZXR0aW5ncyh2YWx1ZTogdW5rbm93bik6IFByb21pc2U8SW1wb3J0U2V0dGluZ3M+O1xyXG4gICAgcGF0Y2hTZXR0aW5ncz8odmFsdWU6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+KTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz47XHJcbiAgICBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPjtcclxuICAgIHBhdGNoTm9kZU5hbWVzPyhmaWxlS2V5OiBzdHJpbmcsIHBhdGNoZXM6IE1jcE5vZGVOYW1lUGF0Y2hbXSk6IFByb21pc2U8SW1wb3J0T3ZlcnJpZGVbXT47XHJcbiAgICBpbXBvcnRTZWxlY3Rpb24ocmVxdWVzdDogSW1wb3J0UmVxdWVzdCwgb3BlcmF0aW9uSWQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj47XHJcbiAgICBjYW5jZWxJbXBvcnQob3BlcmF0aW9uSWQ6IHN0cmluZyk6IGJvb2xlYW47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTWNwTm9kZU5hbWVQYXRjaCB7XHJcbiAgICBpZDogc3RyaW5nO1xyXG4gICAgbmFtZTogc3RyaW5nIHwgbnVsbDtcclxuICAgIGZhbGxiYWNrOiBJbXBvcnRPdmVycmlkZTtcclxufVxyXG5cclxuaW50ZXJmYWNlIEFjdGl2ZU1jcERvY3VtZW50IHtcclxuICAgIGlkOiBzdHJpbmc7XHJcbiAgICBob3N0UmV2aXNpb246IG51bWJlcjtcclxuICAgIHJldmlzaW9uOiBudW1iZXI7XHJcbiAgICBmaWxlS2V5OiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHJvb3RJZHM6IFNldDxzdHJpbmc+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgQWN0aXZlTWNwSW1wb3J0IHtcclxuICAgIG9wZXJhdGlvbklkOiBzdHJpbmc7XHJcbiAgICBkb2N1bWVudFNlc3Npb25JZDogc3RyaW5nO1xyXG4gICAgcmVxdWVzdEZpbmdlcnByaW50OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBDb21wbGV0ZWRNY3BJbXBvcnQgZXh0ZW5kcyBBY3RpdmVNY3BJbXBvcnQge1xyXG4gICAgcmVzcG9uc2U6IHVua25vd247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHB1YmxpY1NldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBzZXR0aW5ncy5zb3VyY2VVcmwsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHNldHRpbmdzLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogc2V0dGluZ3MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIHNjYWxlOiBzZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogc2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogc2V0dGluZ3MucmVmcmVzaEFzc2V0cyxcclxuICAgICAgICBhdXRvU2F2ZTogc2V0dGluZ3MuYXV0b1NhdmUsXHJcbiAgICAgICAgZm9udE1hcDogeyAuLi5zZXR0aW5ncy5mb250TWFwIH0sXHJcbiAgICB9O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRUcmVlTm9kZSB7XHJcbiAgICBub2RlOiBUcmVlTm9kZUR0bztcclxuICAgIHBhcmVudE5vZGVJZD86IHN0cmluZztcclxuICAgIGRlcHRoOiBudW1iZXI7XHJcbiAgICBwYXRoOiBzdHJpbmdbXTtcclxufVxyXG5cclxuY29uc3QgSU1QT1JUX0FDVElPTlMgPSBuZXcgU2V0PEltcG9ydEFjdGlvbj4oWydpZ25vcmUnLCAnZ2VuZXJhdGUnLCAncmVuZGVyJywgJ3RyYW5zZm9ybSddKTtcclxuY29uc3QgTk9ERV9LSU5EUyA9IG5ldyBTZXQ8Tm9kZUtpbmQ+KFtcclxuICAgICdhdXRvJyxcclxuICAgICdub2RlJyxcclxuICAgICdzcHJpdGUnLFxyXG4gICAgJ2xhYmVsJyxcclxuICAgICdyaWNoVGV4dCcsXHJcbiAgICAnYnV0dG9uJyxcclxuICAgICdzY3JvbGxWaWV3JyxcclxuICAgICdsYXlvdXQnLFxyXG5dKTtcclxuXHJcbmZ1bmN0aW9uIHJlY29yZCh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgJ+W3peWFt+WPguaVsOW/hemhu+aYr+WvueixoeOAgicpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXF1aXJlZFN0cmluZyh2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZywgbWF4TGVuZ3RoID0gMjA0OCk6IHN0cmluZyB7XHJcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJyB8fCAhdmFsdWUudHJpbSgpKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBgJHtsYWJlbH0g5LiN6IO95Li656m644CCYCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCByZXN1bHQgPSB2YWx1ZS50cmltKCk7XHJcbiAgICBpZiAocmVzdWx0Lmxlbmd0aCA+IG1heExlbmd0aCkge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYCR7bGFiZWx9IOi2hei/hyAke21heExlbmd0aH0g5a2X56ym6ZmQ5Yi244CCYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb25hbFN0cmluZ0FycmF5KHZhbHVlOiB1bmtub3duLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpIHx8IHZhbHVlLnNvbWUoKGl0ZW0pID0+IHR5cGVvZiBpdGVtICE9PSAnc3RyaW5nJykpIHtcclxuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGAke2xhYmVsfSDlv4XpobvmmK/lrZfnrKbkuLLmlbDnu4TjgIJgKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZSBhcyBzdHJpbmdbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gYm91bmRlZEludGVnZXIodmFsdWU6IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlciwgbGFiZWw6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xyXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgbWluIHx8IHZhbHVlID4gbWF4KSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBgJHtsYWJlbH0g5b+F6aG75pivICR7bWlufeKAkyR7bWF4fSDkuYvpl7TnmoTmlbTmlbDjgIJgKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5jb2RlQ3Vyc29yKHNlc3Npb25JZDogc3RyaW5nLCByZXZpc2lvbjogbnVtYmVyLCBvZmZzZXQ6IG51bWJlciwgcXVlcnlIYXNoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIEJ1ZmZlci5mcm9tKEpTT04uc3RyaW5naWZ5KHsgc2Vzc2lvbklkLCByZXZpc2lvbiwgb2Zmc2V0LCBxdWVyeUhhc2ggfSksICd1dGY4JykudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWNvZGVDdXJzb3IodmFsdWU6IHVua25vd24sIHNlc3Npb25JZDogc3RyaW5nLCByZXZpc2lvbjogbnVtYmVyLCBxdWVyeUhhc2g6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gJycpIHJldHVybiAwO1xyXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgdmFsdWUubGVuZ3RoID4gNTEyKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX0NVUlNPUicsICfliIbpobUgY3Vyc29yIOaXoOaViOOAgicpO1xyXG4gICAgfVxyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBkZWNvZGVkID0gSlNPTi5wYXJzZShCdWZmZXIuZnJvbSh2YWx1ZSwgJ2Jhc2U2NHVybCcpLnRvU3RyaW5nKCd1dGY4JykpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgIGlmIChkZWNvZGVkLnNlc3Npb25JZCAhPT0gc2Vzc2lvbklkIHx8IGRlY29kZWQucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGRlY29kZWQucXVlcnlIYXNoICE9PSBxdWVyeUhhc2hcclxuICAgICAgICAgICAgfHwgdHlwZW9mIGRlY29kZWQub2Zmc2V0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcihkZWNvZGVkLm9mZnNldCkgfHwgZGVjb2RlZC5vZmZzZXQgPCAwKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignY3Vyc29yIG1pc21hdGNoJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBkZWNvZGVkLm9mZnNldDtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9DVVJTT1InLCAn5YiG6aG1IGN1cnNvciDlt7LlpLHmlYjvvIzor7fku47nrKzkuIDpobXph43mlrDmn6Xor6LjgIInKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc3RhYmxlSGFzaCh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKEpTT04uc3RyaW5naWZ5KHZhbHVlKSwgJ3V0ZjgnKS5kaWdlc3QoJ2hleCcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXR0aW5nc0ZpbmdlcnByaW50KHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBzZXR0aW5ncy5zb3VyY2VVcmwsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6IHNldHRpbmdzLmFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogc2V0dGluZ3MucHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBbLi4uc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNdLFxyXG4gICAgICAgIHNjYWxlOiBzZXR0aW5ncy5zY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogc2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogc2V0dGluZ3MucmVmcmVzaEFzc2V0cyxcclxuICAgICAgICBhdXRvU2F2ZTogc2V0dGluZ3MuYXV0b1NhdmUsXHJcbiAgICAgICAgZm9udE1hcDogT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkuc29ydCgoW2xlZnRdLCBbcmlnaHRdKSA9PiBsZWZ0LmxvY2FsZUNvbXBhcmUocmlnaHQpKSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGltcG9ydFJlcXVlc3RGaW5nZXJwcmludChcclxuICAgIGRvY3VtZW50OiBQbHVnaW5Eb2N1bWVudER0byxcclxuICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyxcclxuICAgIG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSxcclxuKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzdGFibGVIYXNoKHtcclxuICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgIHNldHRpbmdzOiBzZXR0aW5nc0ZpbmdlcnByaW50KHNldHRpbmdzKSxcclxuICAgICAgICBvdmVycmlkZXM6IG92ZXJyaWRlcy5tYXAoKGl0ZW0pID0+ICh7XHJcbiAgICAgICAgICAgIGlkOiBpdGVtLmlkLFxyXG4gICAgICAgICAgICBhY3Rpb246IGl0ZW0uYWN0aW9uLFxyXG4gICAgICAgICAgICBraW5kOiBpdGVtLmtpbmQsXHJcbiAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxyXG4gICAgICAgICAgICBuYW1lOiBpdGVtLm5hbWUgPz8gbnVsbCxcclxuICAgICAgICB9KSksXHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZVJlbGF0aXZlQXNzZXRGb2xkZXIodmFsdWU6IHVua25vd24sIGxhYmVsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZm9sZGVyID0gcmVxdWlyZWRTdHJpbmcodmFsdWUsIGxhYmVsLCAyNTYpLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eXFwuXFwvLywgJycpLnJlcGxhY2UoL1xcLyskLywgJycpO1xyXG4gICAgaWYgKGlzQWJzb2x1dGUoZm9sZGVyKSB8fCBmb2xkZXIuc3RhcnRzV2l0aCgnLycpIHx8IGZvbGRlci5zcGxpdCgnLycpLnNvbWUoKHBhcnQpID0+ICFwYXJ0IHx8IHBhcnQgPT09ICcuJyB8fCBwYXJ0ID09PSAnLi4nKSkge1xyXG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsIGAke2xhYmVsfSDlv4XpobvmmK8gYXNzZXRzIOS4i+eahOebuOWvueWtkOebruW9leOAgmApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZvbGRlcjtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluZGV4VHJlZShyb290czogVHJlZU5vZGVEdG9bXSk6IEluZGV4ZWRUcmVlTm9kZVtdIHtcclxuICAgIGNvbnN0IHJlc3VsdDogSW5kZXhlZFRyZWVOb2RlW10gPSBbXTtcclxuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IFRyZWVOb2RlRHRvLCBwYXJlbnROb2RlSWQ6IHN0cmluZyB8IHVuZGVmaW5lZCwgZGVwdGg6IG51bWJlciwgcGF0aDogc3RyaW5nW10pID0+IHtcclxuICAgICAgICBjb25zdCBuZXh0UGF0aCA9IFsuLi5wYXRoLCBub2RlLm5hbWVdO1xyXG4gICAgICAgIHJlc3VsdC5wdXNoKHsgbm9kZSwgcGFyZW50Tm9kZUlkLCBkZXB0aCwgcGF0aDogbmV4dFBhdGggfSk7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gdmlzaXQoY2hpbGQsIG5vZGUuaWQsIGRlcHRoICsgMSwgbmV4dFBhdGgpKTtcclxuICAgIH07XHJcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB1bmRlZmluZWQsIDAsIFtdKSk7XHJcbiAgICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBkZWZhdWx0T3ZlcnJpZGUobm9kZTogVHJlZU5vZGVEdG8pOiBJbXBvcnRPdmVycmlkZSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgIGtpbmQ6IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXHJcbiAgICAgICAgZXhwbGljaXQ6IGZhbHNlLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gb3ZlcnJpZGVNYXAoZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvKTogTWFwPHN0cmluZywgSW1wb3J0T3ZlcnJpZGU+IHtcclxuICAgIHJldHVybiBuZXcgTWFwKGRvY3VtZW50Lm5vZGVPdmVycmlkZXMubWFwKChpdGVtKSA9PiBbaXRlbS5pZCwgeyAuLi5pdGVtIH1dKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGRvY3VtZW50OiBQbHVnaW5Eb2N1bWVudER0byk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgY29uc3Qgbm9kZXMgPSBpbmRleFRyZWUoZG9jdW1lbnQudHJlZSkubWFwKChpdGVtKSA9PiBpdGVtLm5vZGUpO1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBvdmVycmlkZU1hcChkb2N1bWVudCk7XHJcbiAgICBjb25zdCBwcmVmZXJyZWRBY3Rpb25zID0gbmV3IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj4oKTtcclxuICAgIGNvbnN0IGZvcmNlZFJlbmRlcklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHNhdmVkLmdldChub2RlLmlkKTtcclxuICAgICAgICBwcmVmZXJyZWRBY3Rpb25zLnNldChcclxuICAgICAgICAgICAgbm9kZS5pZCxcclxuICAgICAgICAgICAgY3VycmVudD8uZXhwbGljaXQgPT09IHRydWUgPyBub3JtYWxpemVJbXBvcnRBY3Rpb24oY3VycmVudC5hY3Rpb24pIDogc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgbmluZVNsaWNlID0gY3VycmVudD8uZXhwbGljaXQgPT09IHRydWUgPyBjdXJyZW50Lm5pbmVTbGljZSA6IG5vZGUucGF0Y2hDYW5kaWRhdGU7XHJcbiAgICAgICAgaWYgKG5pbmVTbGljZSAmJiBub2RlLnBhdGNoQ2FuZGlkYXRlKSBmb3JjZWRSZW5kZXJJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoZG9jdW1lbnQudHJlZSwgcHJlZmVycmVkQWN0aW9ucywgZm9yY2VkUmVuZGVySWRzKTtcclxuICAgIHJldHVybiBub2Rlcy5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gc2F2ZWQuZ2V0KG5vZGUuaWQpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICBhY3Rpb246IGVmZmVjdGl2ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUobm9kZSksXHJcbiAgICAgICAgICAgIGtpbmQ6IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlID8gY3VycmVudC5raW5kIDogbm9kZS5raW5kLFxyXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlID8gY3VycmVudC5uaW5lU2xpY2UgOiBub2RlLnBhdGNoQ2FuZGlkYXRlLFxyXG4gICAgICAgICAgICBleHBsaWNpdDogY3VycmVudD8uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgIC4uLihjdXJyZW50Py5uYW1lID8geyBuYW1lOiBjdXJyZW50Lm5hbWUgfSA6IHt9KSxcclxuICAgICAgICB9O1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1bW1hcml6ZUltcG9ydFJlc3VsdCh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcclxuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xyXG4gICAgICAgIHJldHVybiB7IGNvbXBsZXRlZDogdHJ1ZSB9O1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVzdWx0ID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbiAgICBjb25zdCBzdW1tYXJ5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgY29tcGxldGVkOiB0cnVlIH07XG4gICAgaWYgKHJlc3VsdC5yZXZpZXcgJiYgdHlwZW9mIHJlc3VsdC5yZXZpZXcgPT09ICdvYmplY3QnKSBzdW1tYXJ5LnJldmlld0F2YWlsYWJsZSA9IHRydWU7XG4gICAgaWYgKHR5cGVvZiByZXN1bHQuY3JlYXRlZCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHJlc3VsdC5jcmVhdGVkKSkgc3VtbWFyeS5jcmVhdGVkID0gcmVzdWx0LmNyZWF0ZWQ7XHJcbiAgICBpZiAodHlwZW9mIHJlc3VsdC51cGRhdGVkID09PSAnbnVtYmVyJyAmJiBOdW1iZXIuaXNGaW5pdGUocmVzdWx0LnVwZGF0ZWQpKSBzdW1tYXJ5LnVwZGF0ZWQgPSByZXN1bHQudXBkYXRlZDtcclxuICAgIGlmICh0eXBlb2YgcmVzdWx0LnByZWZhYlVybCA9PT0gJ3N0cmluZycpIHN1bW1hcnkucHJlZmFiVXJsID0gcmVzdWx0LnByZWZhYlVybDtcclxuICAgIGlmICh0eXBlb2YgcmVzdWx0LnRlbXBvcmFyeVJvb3QgPT09ICdib29sZWFuJykgc3VtbWFyeS50ZW1wb3JhcnlSb290ID0gcmVzdWx0LnRlbXBvcmFyeVJvb3Q7XHJcbiAgICBpZiAoQXJyYXkuaXNBcnJheShyZXN1bHQud2FybmluZ3MpKSB7XHJcbiAgICAgICAgc3VtbWFyeS53YXJuaW5ncyA9IHJlc3VsdC53YXJuaW5nc1xyXG4gICAgICAgICAgICAuZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMTAwKVxyXG4gICAgICAgICAgICAubWFwKChpdGVtKSA9PiBpdGVtLnNsaWNlKDAsIDUxMikpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHN1bW1hcnk7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBGaWdtYUltcG9ydGVyTWNwQXBpIHtcclxuICAgIHByaXZhdGUgc2Vzc2lvbjogQWN0aXZlTWNwRG9jdW1lbnQgfCBudWxsID0gbnVsbDtcclxuICAgIHByaXZhdGUgYWN0aXZlSW1wb3J0OiBBY3RpdmVNY3BJbXBvcnQgfCBudWxsID0gbnVsbDtcclxuICAgIHByaXZhdGUgaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gZmFsc2U7XHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvbXBsZXRlZEltcG9ydHMgPSBuZXcgTWFwPHN0cmluZywgQ29tcGxldGVkTWNwSW1wb3J0PigpO1xyXG4gICAgcHJpdmF0ZSBzZXR0aW5nc1dyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuXHJcbiAgICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGhvc3Q6IE1jcEFwaUhvc3QpIHt9XHJcblxyXG4gICAgYXN5bmMgaW52b2tlKG1ldGhvZDogTWNwQnJpZGdlTWV0aG9kLCBwYXJhbXM6IHVua25vd24sIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgc3dpdGNoIChtZXRob2QpIHtcclxuICAgICAgICAgICAgY2FzZSAnZ2V0U3RhdHVzJzogcmV0dXJuIHRoaXMuZ2V0U3RhdHVzKCk7XHJcbiAgICAgICAgICAgIGNhc2UgJ2ZldGNoRG9jdW1lbnQnOiByZXR1cm4gdGhpcy5mZXRjaERvY3VtZW50KHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGNhc2UgJ2xpc3ROb2Rlcyc6IHJldHVybiB0aGlzLmxpc3ROb2RlcyhwYXJhbXMpO1xyXG4gICAgICAgICAgICBjYXNlICdnZXRQcmV2aWV3JzogcmV0dXJuIHRoaXMuZ2V0UHJldmlldyhwYXJhbXMpO1xyXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVTZXR0aW5ncyc6IHJldHVybiB0aGlzLnVwZGF0ZVNldHRpbmdzKHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZU5vZGVzJzogcmV0dXJuIHRoaXMudXBkYXRlTm9kZXMocGFyYW1zKTtcclxuICAgICAgICAgICAgY2FzZSAncmVuYW1lTm9kZXMnOiByZXR1cm4gdGhpcy5yZW5hbWVOb2RlcyhwYXJhbXMpO1xyXG4gICAgICAgICAgICBjYXNlICdpbXBvcnREb2N1bWVudCc6IHJldHVybiB0aGlzLmltcG9ydERvY3VtZW50KHBhcmFtcywgc2lnbmFsKTtcclxuICAgICAgICAgICAgY2FzZSAnY2FuY2VsSW1wb3J0JzogcmV0dXJuIHRoaXMuY2FuY2VsSW1wb3J0KHBhcmFtcyk7XHJcbiAgICAgICAgICAgIGRlZmF1bHQ6IHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTUVUSE9EX05PVF9BTExPV0VEJywgJ+ivpSBCcmlkZ2Ug5pa55rOV5pyq5byA5pS+44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgZ2V0U3RhdHVzKCk6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgdGhpcy5ob3N0LmdldFN0YXRlKCk7XHJcbiAgICAgICAgY29uc3Qgc2Vzc2lvblZhbGlkID0gQm9vbGVhbih0aGlzLnNlc3Npb25cclxuICAgICAgICAgICAgJiYgdGhpcy5zZXNzaW9uLmhvc3RSZXZpc2lvbiA9PT0gdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKVxyXG4gICAgICAgICAgICAmJiBzdGF0ZS5kb2N1bWVudD8uZmlsZUtleSA9PT0gdGhpcy5zZXNzaW9uLmZpbGVLZXkpO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIGNvbm5lY3RlZDogdHJ1ZSxcclxuICAgICAgICAgICAgcGx1Z2luVmVyc2lvbjogc3RhdGUudmVyc2lvbixcclxuICAgICAgICAgICAgY3JlYXRvclZlcnNpb246IHRoaXMuaG9zdC5jcmVhdG9yVmVyc2lvbixcclxuICAgICAgICAgICAgcHJvamVjdFBhdGg6IHRoaXMuaG9zdC5wcm9qZWN0UGF0aCxcclxuICAgICAgICAgICAgdG9rZW46IHtcclxuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZWQ6IHN0YXRlLnZhdWx0Lmhhc1Rva2VuLFxyXG4gICAgICAgICAgICAgICAgcGVyc2lzdGVudDogc3RhdGUudmF1bHQucGVyc2lzdGVudCxcclxuICAgICAgICAgICAgICAgIGJhY2tlbmQ6IHN0YXRlLnZhdWx0LmJhY2tlbmQsXHJcbiAgICAgICAgICAgICAgICAuLi4oc3RhdGUudmF1bHQud2FybmluZyA/IHsgd2FybmluZzogc3RhdGUudmF1bHQud2FybmluZyB9IDoge30pLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBzZXR0aW5nczogcHVibGljU2V0dGluZ3Moc3RhdGUuc2V0dGluZ3MpLFxyXG4gICAgICAgICAgICBidXN5OiB0aGlzLmFjdGl2ZUltcG9ydCAhPT0gbnVsbCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCksXHJcbiAgICAgICAgICAgIGRvY3VtZW50OiBzdGF0ZS5kb2N1bWVudCA/IHtcclxuICAgICAgICAgICAgICAgIGZpbGVOYW1lOiBzdGF0ZS5kb2N1bWVudC5maWxlTmFtZSxcclxuICAgICAgICAgICAgICAgIHNvdXJjZVVybDogc3RhdGUuZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICAgICAgbm9kZUNvdW50OiBpbmRleFRyZWUoc3RhdGUuZG9jdW1lbnQudHJlZSkubGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IHNlc3Npb25WYWxpZCA/IHRoaXMuc2Vzc2lvbj8uaWQgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgIH0gOiBudWxsLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBmZXRjaERvY3VtZW50KHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heaIluWFiOWPlua2iOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZVVybCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0LnNvdXJjZVVybCwgJ3NvdXJjZVVybCcpO1xyXG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgdGhpcy5ob3N0LmdldFN0YXRlKCk7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS52YXVsdC5oYXNUb2tlbikge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ1RPS0VOX05PVF9DT05GSUdVUkVEJywgJ+WwmuacqumFjee9riBGaWdtYSBQZXJzb25hbCBBY2Nlc3MgVG9rZW7jgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfRklHTUFfU09VUkNFJywgJ+S7heaUr+aMgeacieaViOeahCBmaWdtYS5jb20g5paH5Lu244CB6K6+6K6h44CB5Y6f5Z6L5oiWIEZpZ0phbSDpk77mjqXjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCB0aGlzLmhvc3QuZmV0Y2hEb2N1bWVudChzb3VyY2VVcmwpO1xyXG4gICAgICAgIGNvbnN0IGlkID0gcmFuZG9tQnl0ZXMoMTgpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgICAgICB0aGlzLnNlc3Npb24gPSB7XHJcbiAgICAgICAgICAgIGlkLFxyXG4gICAgICAgICAgICBob3N0UmV2aXNpb246IHRoaXMuaG9zdC5nZXREb2N1bWVudFJldmlzaW9uKCksXHJcbiAgICAgICAgICAgIHJldmlzaW9uOiAwLFxyXG4gICAgICAgICAgICBmaWxlS2V5OiBkb2N1bWVudC5maWxlS2V5LFxyXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcclxuICAgICAgICAgICAgcm9vdElkczogbmV3IFNldChkb2N1bWVudC50cmVlLm1hcCgobm9kZSkgPT4gbm9kZS5pZCkpLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IGlkLFxyXG4gICAgICAgICAgICBmaWxlTmFtZTogZG9jdW1lbnQuZmlsZU5hbWUsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgICAgICBub2RlQ291bnQ6IGluZGV4VHJlZShkb2N1bWVudC50cmVlKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIGZvbnRzOiBkb2N1bWVudC5mb250cyxcclxuICAgICAgICAgICAgcm9vdHM6IGRvY3VtZW50LnRyZWUubWFwKChub2RlKSA9PiAoe1xyXG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgbmFtZTogbm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgdHlwZTogbm9kZS50eXBlLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IG5vZGUud2lkdGgsXHJcbiAgICAgICAgICAgICAgICBoZWlnaHQ6IG5vZGUuaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgY2hpbGRDb3VudDogbm9kZS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgIH0pKSxcclxuICAgICAgICB9O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgY3VycmVudERvY3VtZW50KHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHsgc2Vzc2lvbjogQWN0aXZlTWNwRG9jdW1lbnQ7IGRvY3VtZW50OiBQbHVnaW5Eb2N1bWVudER0bzsgc3RhdGU6IFBsdWdpblN0YXRlRHRvIH0+IHtcclxuICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSByZXF1aXJlZFN0cmluZyhwYXJhbXMuZG9jdW1lbnRTZXNzaW9uSWQsICdkb2N1bWVudFNlc3Npb25JZCcsIDI1Nik7XHJcbiAgICAgICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuc2Vzc2lvbjtcclxuICAgICAgICBpZiAoIXNlc3Npb24gfHwgc2Vzc2lvbi5pZCAhPT0gc2Vzc2lvbklkIHx8IHNlc3Npb24uaG9zdFJldmlzaW9uICE9PSB0aGlzLmhvc3QuZ2V0RG9jdW1lbnRSZXZpc2lvbigpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignU1RBTEVfRE9DVU1FTlRfU0VTU0lPTicsICfmlofmoaPkvJror53lt7LlpLHmlYjvvIzor7fph43mlrDor7vlj5YgRmlnbWEg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgdGhpcy5ob3N0LmdldFN0YXRlKCk7XHJcbiAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBzdGF0ZS5kb2N1bWVudDtcclxuICAgICAgICBpZiAoIWRvY3VtZW50IHx8IGRvY3VtZW50LmZpbGVLZXkgIT09IHNlc3Npb24uZmlsZUtleSB8fCBkb2N1bWVudC5zb3VyY2VVcmwgIT09IHNlc3Npb24uc291cmNlVXJsKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignU1RBTEVfRE9DVU1FTlRfU0VTU0lPTicsICflvZPliY3mj5Lku7bmlofmoaPlt7Llj5jljJbvvIzor7fph43mlrDor7vlj5YgRmlnbWEg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgbGlzdE5vZGVzKHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3QgeyBzZXNzaW9uLCBkb2N1bWVudCB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xyXG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCBieUlkID0gbmV3IE1hcChhbGwubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtXSkpO1xyXG4gICAgICAgIGNvbnN0IHJvb3ROb2RlSWQgPSB0eXBlb2YgaW5wdXQucm9vdE5vZGVJZCA9PT0gJ3N0cmluZycgJiYgaW5wdXQucm9vdE5vZGVJZC50cmltKClcclxuICAgICAgICAgICAgPyBpbnB1dC5yb290Tm9kZUlkLnRyaW0oKVxyXG4gICAgICAgICAgICA6IHVuZGVmaW5lZDtcclxuICAgICAgICBjb25zdCByb290SXRlbSA9IHJvb3ROb2RlSWQgPyBieUlkLmdldChyb290Tm9kZUlkKSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocm9vdE5vZGVJZCAmJiAhcm9vdEl0ZW0pIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTk9ERV9OT1RfRk9VTkQnLCBg6IqC54K5ICR7cm9vdE5vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgY29uc3QgbWF4RGVwdGggPSBib3VuZGVkSW50ZWdlcihpbnB1dC5kZXB0aCwgOCwgMCwgMzIsICdkZXB0aCcpO1xyXG4gICAgICAgIGNvbnN0IGxpbWl0ID0gYm91bmRlZEludGVnZXIoaW5wdXQubGltaXQsIDUwLCAxLCAyMDAsICdsaW1pdCcpO1xyXG4gICAgICAgIGNvbnN0IHNlYXJjaCA9IHR5cGVvZiBpbnB1dC5zZWFyY2ggPT09ICdzdHJpbmcnID8gaW5wdXQuc2VhcmNoLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgpIDogJyc7XHJcbiAgICAgICAgY29uc3QgdHlwZXMgPSBvcHRpb25hbFN0cmluZ0FycmF5KGlucHV0LnR5cGVzLCAndHlwZXMnKTtcclxuICAgICAgICBjb25zdCBhY3Rpb25zID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC5hY3Rpb25zLCAnYWN0aW9ucycpO1xyXG4gICAgICAgIGNvbnN0IGtpbmRzID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC5raW5kcywgJ2tpbmRzJyk7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZ09ubHkgPSBpbnB1dC53YXJuaW5nT25seSA9PT0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBvdmVycmlkZXMgPSBvdmVycmlkZU1hcChkb2N1bWVudCk7XHJcbiAgICAgICAgY29uc3QgcHJlZmVycmVkQWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+KCk7XHJcbiAgICAgICAgY29uc3QgZm9yY2VkUmVuZGVySWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlcy5nZXQoaXRlbS5ub2RlLmlkKTtcclxuICAgICAgICAgICAgY29uc3QgcHJlZmVycmVkID0gc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlXHJcbiAgICAgICAgICAgICAgICA/IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihzYXZlZC5hY3Rpb24pXHJcbiAgICAgICAgICAgICAgICA6IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBwcmVmZXJyZWRBY3Rpb25zLnNldChcclxuICAgICAgICAgICAgICAgIGl0ZW0ubm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIHByZWZlcnJlZCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgY29uc3QgbmluZVNsaWNlID0gc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQubmluZVNsaWNlIDogaXRlbS5ub2RlLnBhdGNoQ2FuZGlkYXRlO1xyXG4gICAgICAgICAgICBpZiAobmluZVNsaWNlICYmIGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgZm9yY2VkUmVuZGVySWRzLmFkZChpdGVtLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGRvY3VtZW50LnRyZWUsIHByZWZlcnJlZEFjdGlvbnMsIGZvcmNlZFJlbmRlcklkcyk7XHJcbiAgICAgICAgY29uc3Qgcm9vdERlcHRoID0gcm9vdEl0ZW0/LmRlcHRoID8/IDA7XHJcbiAgICAgICAgY29uc3QgZGVzY2VuZGFudHMgPSByb290SXRlbVxyXG4gICAgICAgICAgICA/IG5ldyBTZXQoaW5kZXhUcmVlKFtyb290SXRlbS5ub2RlXSkubWFwKChpdGVtKSA9PiBpdGVtLm5vZGUuaWQpKVxyXG4gICAgICAgICAgICA6IG51bGw7XHJcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGFsbC5maWx0ZXIoKGl0ZW0pID0+IHtcclxuICAgICAgICAgICAgaWYgKGRlc2NlbmRhbnRzICYmICFkZXNjZW5kYW50cy5oYXMoaXRlbS5ub2RlLmlkKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5kZXB0aCAtIHJvb3REZXB0aCA+IG1heERlcHRoKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVzLmdldChpdGVtLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBjb2Nvc05hbWUgPSBzYXZlZD8ubmFtZSA/PyBpdGVtLm5vZGUubmFtZTtcclxuICAgICAgICAgICAgY29uc3QgYWN0aW9uID0gZWZmZWN0aXZlLmFjdGlvbnMuZ2V0KGl0ZW0ubm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKGl0ZW0ubm9kZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IGtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICAgICAgICAgIGl0ZW0ubm9kZSxcclxuICAgICAgICAgICAgICAgIHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSA/IHNhdmVkLmtpbmQgOiBpdGVtLm5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIGFjdGlvbixcclxuICAgICAgICAgICAgICAgIHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSA/IHNhdmVkLm5pbmVTbGljZSA6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKHNlYXJjaCAmJiAhYCR7aXRlbS5ub2RlLm5hbWV9XFxuJHtjb2Nvc05hbWV9XFxuJHtpdGVtLnBhdGguam9pbignLycpfWAudG9Mb2NhbGVMb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGlmICh0eXBlcyAmJiAhdHlwZXMuaW5jbHVkZXMoaXRlbS5ub2RlLnR5cGUpKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIGlmIChhY3Rpb25zICYmICFhY3Rpb25zLmluY2x1ZGVzKGFjdGlvbikpIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgaWYgKGtpbmRzICYmICFraW5kcy5pbmNsdWRlcyhraW5kKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICBpZiAod2FybmluZ09ubHkgJiYgIWl0ZW0ubm9kZS53YXJuaW5nKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IHF1ZXJ5SGFzaCA9IHN0YWJsZUhhc2goe1xyXG4gICAgICAgICAgICByb290Tm9kZUlkOiByb290Tm9kZUlkID8/IG51bGwsXHJcbiAgICAgICAgICAgIHNlYXJjaCxcclxuICAgICAgICAgICAgdHlwZXM6IHR5cGVzID8gWy4uLnR5cGVzXS5zb3J0KCkgOiBudWxsLFxyXG4gICAgICAgICAgICBhY3Rpb25zOiBhY3Rpb25zID8gWy4uLmFjdGlvbnNdLnNvcnQoKSA6IG51bGwsXHJcbiAgICAgICAgICAgIGtpbmRzOiBraW5kcyA/IFsuLi5raW5kc10uc29ydCgpIDogbnVsbCxcclxuICAgICAgICAgICAgd2FybmluZ09ubHksXHJcbiAgICAgICAgICAgIGRlcHRoOiBtYXhEZXB0aCxcclxuICAgICAgICAgICAgbGltaXQsXHJcbiAgICAgICAgICAgIG92ZXJyaWRlczogWy4uLmRvY3VtZW50Lm5vZGVPdmVycmlkZXNdXHJcbiAgICAgICAgICAgICAgICAuc29ydCgobGVmdCwgcmlnaHQpID0+IGxlZnQuaWQubG9jYWxlQ29tcGFyZShyaWdodC5pZCkpXHJcbiAgICAgICAgICAgICAgICAubWFwKChpdGVtKSA9PiAoe1xyXG4gICAgICAgICAgICAgICAgICAgIGlkOiBpdGVtLmlkLFxyXG4gICAgICAgICAgICAgICAgICAgIGFjdGlvbjogaXRlbS5hY3Rpb24sXHJcbiAgICAgICAgICAgICAgICAgICAga2luZDogaXRlbS5raW5kLFxyXG4gICAgICAgICAgICAgICAgICAgIG5pbmVTbGljZTogaXRlbS5uaW5lU2xpY2UsXHJcbiAgICAgICAgICAgICAgICAgICAgZXhwbGljaXQ6IGl0ZW0uZXhwbGljaXQgPT09IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lID8/IG51bGwsXHJcbiAgICAgICAgICAgICAgICB9KSksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3Qgb2Zmc2V0ID0gZGVjb2RlQ3Vyc29yKGlucHV0LmN1cnNvciwgc2Vzc2lvbi5pZCwgc2Vzc2lvbi5yZXZpc2lvbiwgcXVlcnlIYXNoKTtcclxuICAgICAgICBjb25zdCBwYWdlID0gY2FuZGlkYXRlcy5zbGljZShvZmZzZXQsIG9mZnNldCArIGxpbWl0KTtcclxuICAgICAgICBjb25zdCBub2RlcyA9IHBhZ2UubWFwKChpdGVtKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVzLmdldChpdGVtLm5vZGUuaWQpO1xyXG4gICAgICAgICAgICBjb25zdCBwcmVmZXJyZWRBY3Rpb24gPSBwcmVmZXJyZWRBY3Rpb25zLmdldChpdGVtLm5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xyXG4gICAgICAgICAgICBjb25zdCBhY3Rpb24gPSBlZmZlY3RpdmUuYWN0aW9ucy5nZXQoaXRlbS5ub2RlLmlkKSA/PyBwcmVmZXJyZWRBY3Rpb247XHJcbiAgICAgICAgICAgIGNvbnN0IG5pbmVTbGljZSA9IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSA/IHNhdmVkLm5pbmVTbGljZSA6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIG5vZGVJZDogaXRlbS5ub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgcGFyZW50Tm9kZUlkOiBpdGVtLnBhcmVudE5vZGVJZCxcclxuICAgICAgICAgICAgICAgIGRlcHRoOiBpdGVtLmRlcHRoIC0gcm9vdERlcHRoLFxyXG4gICAgICAgICAgICAgICAgcGF0aDogaXRlbS5wYXRoLmpvaW4oJy8nKSxcclxuICAgICAgICAgICAgICAgIGZpZ21hTmFtZTogaXRlbS5ub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWU6IHNhdmVkPy5uYW1lID8/IGl0ZW0ubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICAgICAgcmVuYW1lZDogQm9vbGVhbihzYXZlZD8ubmFtZSAmJiBzYXZlZC5uYW1lICE9PSBpdGVtLm5vZGUubmFtZSksXHJcbiAgICAgICAgICAgICAgICB0eXBlOiBpdGVtLm5vZGUudHlwZSxcclxuICAgICAgICAgICAgICAgIHZpc2libGU6IGl0ZW0ubm9kZS52aXNpYmxlLFxyXG4gICAgICAgICAgICAgICAgd2lkdGg6IGl0ZW0ubm9kZS53aWR0aCxcclxuICAgICAgICAgICAgICAgIGhlaWdodDogaXRlbS5ub2RlLmhlaWdodCxcclxuICAgICAgICAgICAgICAgIGNoaWxkQ291bnQ6IGl0ZW0ubm9kZS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICBwcmVmZXJyZWRBY3Rpb24sXHJcbiAgICAgICAgICAgICAgICBhY3Rpb24sXHJcbiAgICAgICAgICAgICAgICBraW5kOiBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICAgICAgICAgICAgICBpdGVtLm5vZGUsXHJcbiAgICAgICAgICAgICAgICAgICAgc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQua2luZCA6IGl0ZW0ubm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgICAgIGFjdGlvbixcclxuICAgICAgICAgICAgICAgICAgICBuaW5lU2xpY2UsXHJcbiAgICAgICAgICAgICAgICApLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSxcclxuICAgICAgICAgICAgICAgIHN1cHByZXNzZWQ6IGVmZmVjdGl2ZS5zdXBwcmVzc2VkLmhhcyhpdGVtLm5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgcGF0Y2hDYW5kaWRhdGU6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSxcclxuICAgICAgICAgICAgICAgIHNsaWNlTW9kZTogaXRlbS5ub2RlLnNsaWNlTW9kZSxcclxuICAgICAgICAgICAgICAgIHJlYXNvbjogc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gJ3VzZXItb3ZlcnJpZGUnIDogaXRlbS5ub2RlLnJlYXNvbixcclxuICAgICAgICAgICAgICAgIGZvbGQ6IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSB8fCBCb29sZWFuKHNhdmVkPy5uYW1lKSA/IHVuZGVmaW5lZCA6IGl0ZW0ubm9kZS5mb2xkLFxyXG4gICAgICAgICAgICAgICAgd2FybmluZzogaXRlbS5ub2RlLndhcm5pbmcsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgbmV4dE9mZnNldCA9IG9mZnNldCArIHBhZ2UubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgIHRvdGFsQ291bnQ6IGNhbmRpZGF0ZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBjb3VudDogbm9kZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBub2RlcyxcclxuICAgICAgICAgICAgaGFzTW9yZTogbmV4dE9mZnNldCA8IGNhbmRpZGF0ZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICBuZXh0Q3Vyc29yOiBuZXh0T2Zmc2V0IDwgY2FuZGlkYXRlcy5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gZW5jb2RlQ3Vyc29yKHNlc3Npb24uaWQsIHNlc3Npb24ucmV2aXNpb24sIG5leHRPZmZzZXQsIHF1ZXJ5SGFzaClcclxuICAgICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBnZXRQcmV2aWV3KHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heaIluWFiOWPlua2iOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IHsgZG9jdW1lbnQgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcclxuICAgICAgICBjb25zdCBub2RlSWQgPSByZXF1aXJlZFN0cmluZyhpbnB1dC5ub2RlSWQsICdub2RlSWQnLCAyNTYpO1xyXG4gICAgICAgIGlmICghaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLnNvbWUoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCA9PT0gbm9kZUlkKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ05PREVfTk9UX0ZPVU5EJywgYOiKgueCuSAke25vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzLmhvc3QuZ2V0UHJldmlldyhub2RlSWQpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYnVpbGRTZXR0aW5ncyhcclxuICAgICAgICBkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG8sXHJcbiAgICAgICAgc3RhdGU6IFBsdWdpblN0YXRlRHRvLFxyXG4gICAgICAgIHZhbHVlOiB1bmtub3duLFxyXG4gICAgKTogeyBwYXRjaDogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz47IHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyB9IHtcclxuICAgICAgICBjb25zdCBwYXRjaCA9IHJlY29yZCh2YWx1ZSk7XHJcbiAgICAgICAgY29uc3QgYWxsb3dlZEtleXMgPSBuZXcgU2V0KFtcclxuICAgICAgICAgICAgJ2Fzc2V0Rm9sZGVyJyxcclxuICAgICAgICAgICAgJ3ByZWZhYkZvbGRlcicsXHJcbiAgICAgICAgICAgICdzY2FsZScsXHJcbiAgICAgICAgICAgICd1cGRhdGVFeGlzdGluZycsXHJcbiAgICAgICAgICAgICdyZWZyZXNoQXNzZXRzJyxcclxuICAgICAgICAgICAgJ2F1dG9TYXZlJyxcclxuICAgICAgICAgICAgJ2ZvbnRNYXAnLFxyXG4gICAgICAgIF0pO1xyXG4gICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhwYXRjaCk7XHJcbiAgICAgICAgaWYgKCFrZXlzLmxlbmd0aCB8fCBrZXlzLnNvbWUoKGtleSkgPT4gIWFsbG93ZWRLZXlzLmhhcyhrZXkpKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfU0VUVElOR1MnLCAnc2V0dGluZ3Mg5b+F6aG75YyF5ZCr6Iez5bCR5LiA5Liq5Y+X5pSv5oyB55qE6K6+572u5a2X5q6144CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IG5vcm1hbGl6ZWQ6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+ID0geyBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCB9O1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyA9IHtcclxuICAgICAgICAgICAgLi4uc3RhdGUuc2V0dGluZ3MsXHJcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgaWYgKHBhdGNoLmFzc2V0Rm9sZGVyICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgc2V0dGluZ3MuYXNzZXRGb2xkZXIgPSBzYWZlUmVsYXRpdmVBc3NldEZvbGRlcihwYXRjaC5hc3NldEZvbGRlciwgJ2Fzc2V0Rm9sZGVyJyk7XHJcbiAgICAgICAgICAgIG5vcm1hbGl6ZWQuYXNzZXRGb2xkZXIgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHBhdGNoLnByZWZhYkZvbGRlciAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgIHNldHRpbmdzLnByZWZhYkZvbGRlciA9IHNhZmVSZWxhdGl2ZUFzc2V0Rm9sZGVyKHBhdGNoLnByZWZhYkZvbGRlciwgJ3ByZWZhYkZvbGRlcicpO1xyXG4gICAgICAgICAgICBub3JtYWxpemVkLnByZWZhYkZvbGRlciA9IHNldHRpbmdzLnByZWZhYkZvbGRlcjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHBhdGNoLnNjYWxlICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgaWYgKHR5cGVvZiBwYXRjaC5zY2FsZSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0Zpbml0ZShwYXRjaC5zY2FsZSkgfHwgcGF0Y2guc2NhbGUgPCAwLjI1IHx8IHBhdGNoLnNjYWxlID4gNCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1NFVFRJTkdTJywgJ3NjYWxlIOW/hemhu+aYryAwLjI14oCTNCDkuYvpl7TnmoTmlbDlrZfjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZXR0aW5ncy5zY2FsZSA9IHBhdGNoLnNjYWxlO1xyXG4gICAgICAgICAgICBub3JtYWxpemVkLnNjYWxlID0gcGF0Y2guc2NhbGU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsndXBkYXRlRXhpc3RpbmcnLCAncmVmcmVzaEFzc2V0cycsICdhdXRvU2F2ZSddIGFzIGNvbnN0KSB7XHJcbiAgICAgICAgICAgIGlmIChwYXRjaFtrZXldICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgcGF0Y2hba2V5XSAhPT0gJ2Jvb2xlYW4nKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfU0VUVElOR1MnLCBgJHtrZXl9IOW/hemhu+aYr+W4g+WwlOWAvOOAgmApO1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3Nba2V5XSA9IHBhdGNoW2tleV07XHJcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkW2tleV0gPSBwYXRjaFtrZXldO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChwYXRjaC5mb250TWFwICE9PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgaWYgKCFwYXRjaC5mb250TWFwIHx8IHR5cGVvZiBwYXRjaC5mb250TWFwICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KHBhdGNoLmZvbnRNYXApKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfU0VUVElOR1MnLCAnZm9udE1hcCDlv4XpobvmmK/lr7nosaHjgIInKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBmb250TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZvbnQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXMocGF0Y2guZm9udE1hcCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcclxuICAgICAgICAgICAgICAgIGlmICghZm9udC50cmltKCkgfHwgdHlwZW9mIHVybCAhPT0gJ3N0cmluZycgfHwgKHVybCAmJiAhdXJsLnN0YXJ0c1dpdGgoJ2RiOi8vYXNzZXRzLycpKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsICdmb250TWFwIOWPquiDveW8leeUqCBkYjovL2Fzc2V0cyDkuIvnmoTlrZfkvZPotYTmupDjgIInKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGZvbnRNYXBbZm9udC50cmltKCldID0gdXJsLnRyaW0oKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZXR0aW5ncy5mb250TWFwID0gZm9udE1hcDtcclxuICAgICAgICAgICAgbm9ybWFsaXplZC5mb250TWFwID0gZm9udE1hcDtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgcGF0Y2g6IG5vcm1hbGl6ZWQsIHNldHRpbmdzIH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhcHBseVNldHRpbmdzKHBhcmFtczogdW5rbm93biwgaW5jcmVtZW50UmV2aXNpb24gPSB0cnVlKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3Qgb3BlcmF0aW9uID0gYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xyXG4gICAgICAgICAgICBjb25zdCBidWlsdCA9IHRoaXMuYnVpbGRTZXR0aW5ncyhkb2N1bWVudCwgc3RhdGUsIGlucHV0LnNldHRpbmdzKTtcclxuICAgICAgICAgICAgY29uc3Qgc2F2ZWQgPSB0aGlzLmhvc3QucGF0Y2hTZXR0aW5nc1xyXG4gICAgICAgICAgICAgICAgPyBhd2FpdCB0aGlzLmhvc3QucGF0Y2hTZXR0aW5ncyhidWlsdC5wYXRjaClcclxuICAgICAgICAgICAgICAgIDogYXdhaXQgdGhpcy5ob3N0LnNhdmVTZXR0aW5ncyhidWlsdC5zZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIGlmIChpbmNyZW1lbnRSZXZpc2lvbikgc2Vzc2lvbi5yZXZpc2lvbiArPSAxO1xyXG4gICAgICAgICAgICByZXR1cm4gc2F2ZWQ7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSB0aGlzLnNldHRpbmdzV3JpdGVRdWV1ZS50aGVuKG9wZXJhdGlvbik7XHJcbiAgICAgICAgdGhpcy5zZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHVwZGF0ZVNldHRpbmdzKHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+WvvOWFpeaJp+ihjOacn+mXtOS4jeiDveS/ruaUueiuvue9ruOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gcHVibGljU2V0dGluZ3MoYXdhaXQgdGhpcy5hcHBseVNldHRpbmdzKHBhcmFtcykpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgcmVuYW1lTm9kZXMocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XHJcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0JVU1knLCAn5a+85YWl5omn6KGM5pyf6Ze05LiN6IO95L+u5pS56IqC54K55ZCN56ew44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XHJcbiAgICAgICAgY29uc3QgeyBzZXNzaW9uLCBkb2N1bWVudCB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xyXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShpbnB1dC5yZW5hbWVzKSB8fCAhaW5wdXQucmVuYW1lcy5sZW5ndGggfHwgaW5wdXQucmVuYW1lcy5sZW5ndGggPiA1MDApIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAncmVuYW1lcyDlv4XpobvljIXlkKsgMeKAkzUwMCDkuKrmlLnlkI3pobnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgYWxsb3dSb290UmVuYW1lID0gaW5wdXQuYWxsb3dSb290UmVuYW1lID09PSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBjb25zdCBieUlkID0gbmV3IE1hcChhbGwubWFwKChpdGVtKSA9PiBbaXRlbS5ub2RlLmlkLCBpdGVtLm5vZGVdKSk7XHJcbiAgICAgICAgY29uc3Qgc2F2ZWQgPSBvdmVycmlkZU1hcChkb2N1bWVudCk7XHJcbiAgICAgICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgICAgIGNvbnN0IHZhbHVlczogSW1wb3J0T3ZlcnJpZGVbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IHBhdGNoZXM6IE1jcE5vZGVOYW1lUGF0Y2hbXSA9IFtdO1xyXG4gICAgICAgIGNvbnN0IHVwZGF0ZWQ6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgcmF3IG9mIGlucHV0LnJlbmFtZXMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHJlY29yZChyYXcpO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlSWQgPSByZXF1aXJlZFN0cmluZyhpdGVtLm5vZGVJZCwgJ25vZGVJZCcsIDI1Nik7XHJcbiAgICAgICAgICAgIGlmIChzZWVuLmhhcyhub2RlSWQpKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGDoioLngrkgJHtub2RlSWR9IOmHjeWkjeWHuueOsOOAgmApO1xyXG4gICAgICAgICAgICBzZWVuLmFkZChub2RlSWQpO1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gYnlJZC5nZXQobm9kZUlkKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ05PREVfTk9UX0ZPVU5EJywgYOiKgueCuSAke25vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XHJcbiAgICAgICAgICAgIGlmIChzZXNzaW9uLnJvb3RJZHMuaGFzKG5vZGVJZCkgJiYgIWFsbG93Um9vdFJlbmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICdST09UX1JFTkFNRV9SRVFVSVJFU19DT05GSVJNQVRJT04nLFxyXG4gICAgICAgICAgICAgICAgICAgIGDoioLngrkgJHtub2RlSWR9IOaYr+WvvOWFpeague+8m+aUueWQjeS8muaUueWPmOmTvuaOpSBGcmFtZSDnmoQgUHJlZmFiIOaWh+S7tuWQje+8jOivt+iuvue9riBhbGxvd1Jvb3RSZW5hbWU9dHJ1ZSDmmI7noa7noa7orqTjgIJgLFxyXG4gICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc2F2ZWQuZ2V0KG5vZGVJZCkgPz8gZGVmYXVsdE92ZXJyaWRlKG5vZGUpKSB9O1xyXG4gICAgICAgICAgICBsZXQgY29jb3NOYW1lID0gbm9kZS5uYW1lO1xyXG4gICAgICAgICAgICBpZiAoaXRlbS5uYW1lID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBkZWxldGUgY3VycmVudC5uYW1lO1xyXG4gICAgICAgICAgICAgICAgcGF0Y2hlcy5wdXNoKHsgaWQ6IG5vZGVJZCwgbmFtZTogbnVsbCwgZmFsbGJhY2s6IGN1cnJlbnQgfSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfTk9ERV9OQU1FJywgYOiKgueCuSAke25vZGVJZH0g55qE5ZCN56ew5riF5rSX5ZCO5Li656m644CCYCk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50Lm5hbWUgPSBuYW1lO1xyXG4gICAgICAgICAgICAgICAgY29jb3NOYW1lID0gbmFtZTtcclxuICAgICAgICAgICAgICAgIHBhdGNoZXMucHVzaCh7IGlkOiBub2RlSWQsIG5hbWUsIGZhbGxiYWNrOiBjdXJyZW50IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGN1cnJlbnQpO1xyXG4gICAgICAgICAgICB1cGRhdGVkLnB1c2goe1xyXG4gICAgICAgICAgICAgICAgbm9kZUlkLFxyXG4gICAgICAgICAgICAgICAgZmlnbWFOYW1lOiBub2RlLm5hbWUsXHJcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWUsXHJcbiAgICAgICAgICAgICAgICByZXNldDogaXRlbS5uYW1lID09PSBudWxsLFxyXG4gICAgICAgICAgICAgICAgd2FybmluZzogc2Vzc2lvbi5yb290SWRzLmhhcyhub2RlSWQpXHJcbiAgICAgICAgICAgICAgICAgICAgPyAn5qC56IqC54K55pS55ZCN5Lya5pS55Y+Y6ZO+5o6lIEZyYW1lIOeahCBQcmVmYWIg5paH5Lu25ZCN44CCJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogJ+aUueWQjeiKgueCueS8muS/neeVmeS4uueLrOeriyBDb2NvcyDoioLngrnvvIzlj6/og73pmLvmraLop4bop4nljIXoo4XlsYLmipjlj6DjgIInLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRoaXMuaG9zdC5wYXRjaE5vZGVOYW1lcykge1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmhvc3QucGF0Y2hOb2RlTmFtZXMoZG9jdW1lbnQuZmlsZUtleSwgcGF0Y2hlcyk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5ob3N0LnNhdmVOb2RlT3ZlcnJpZGVzKGRvY3VtZW50LmZpbGVLZXksIHZhbHVlcywgWy4uLnNlZW5dKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2Vzc2lvbi5yZXZpc2lvbiArPSAxO1xyXG4gICAgICAgIHJldHVybiB7IHVwZGF0ZWQgfTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHVwZGF0ZU5vZGVzKHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+WvvOWFpeaJp+ihjOacn+mXtOS4jeiDveS/ruaUueiKgueCueetlueVpeOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IHsgc2Vzc2lvbiwgZG9jdW1lbnQgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcclxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQudXBkYXRlcykgfHwgIWlucHV0LnVwZGF0ZXMubGVuZ3RoIHx8IGlucHV0LnVwZGF0ZXMubGVuZ3RoID4gNTAwKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgJ3VwZGF0ZXMg5b+F6aG75YyF5ZCrIDHigJM1MDAg5Liq6IqC54K56K6+572u44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGFsbG93Um9vdFJlbmFtZSA9IGlucHV0LmFsbG93Um9vdFJlbmFtZSA9PT0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBhbGwgPSBpbmRleFRyZWUoZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgY29uc3QgYnlJZCA9IG5ldyBNYXAoYWxsLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlXSkpO1xyXG4gICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVNYXAoZG9jdW1lbnQpO1xyXG4gICAgICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgICAgICBjb25zdCB2YWx1ZXM6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHJhdyBvZiBpbnB1dC51cGRhdGVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSByZWNvcmQocmF3KTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZUlkID0gcmVxdWlyZWRTdHJpbmcoaXRlbS5ub2RlSWQsICdub2RlSWQnLCAyNTYpO1xyXG4gICAgICAgICAgICBpZiAoc2Vlbi5oYXMobm9kZUlkKSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBg6IqC54K5ICR7bm9kZUlkfSDph43lpI3lh7rnjrDjgIJgKTtcclxuICAgICAgICAgICAgc2Vlbi5hZGQobm9kZUlkKTtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGJ5SWQuZ2V0KG5vZGVJZCk7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdOT0RFX05PVF9GT1VORCcsIGDoioLngrkgJHtub2RlSWR9IOS4jeWtmOWcqOOAgmApO1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0geyAuLi4oc2F2ZWQuZ2V0KG5vZGVJZCkgPz8gZGVmYXVsdE92ZXJyaWRlKG5vZGUpKSB9O1xyXG4gICAgICAgICAgICBsZXQgc3RyYXRlZ3lDaGFuZ2VkID0gZmFsc2U7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLmFjdGlvbiAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIUlNUE9SVF9BQ1RJT05TLmhhcyhpdGVtLmFjdGlvbiBhcyBJbXBvcnRBY3Rpb24pKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGDoioLngrkgJHtub2RlSWR9IOeahCBhY3Rpb24g5peg5pWI44CCYCk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LmFjdGlvbiA9IGl0ZW0uYWN0aW9uIGFzIEltcG9ydEFjdGlvbjtcclxuICAgICAgICAgICAgICAgIHN0cmF0ZWd5Q2hhbmdlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKGl0ZW0ua2luZCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIU5PREVfS0lORFMuaGFzKGl0ZW0ua2luZCBhcyBOb2RlS2luZCkpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g55qEIGtpbmQg5peg5pWI44CCYCk7XHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LmtpbmQgPSBpdGVtLmtpbmQgYXMgTm9kZUtpbmQ7XHJcbiAgICAgICAgICAgICAgICBzdHJhdGVneUNoYW5nZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChpdGVtLm5pbmVTbGljZSAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGl0ZW0ubmluZVNsaWNlICE9PSAnYm9vbGVhbicpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g55qEIG5pbmVTbGljZSDlv4XpobvmmK/luIPlsJTlgLzjgIJgKTtcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQubmluZVNsaWNlID0gaXRlbS5uaW5lU2xpY2U7XHJcbiAgICAgICAgICAgICAgICBzdHJhdGVneUNoYW5nZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChpdGVtLm5hbWUgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKHNlc3Npb24ucm9vdElkcy5oYXMobm9kZUlkKSAmJiAhYWxsb3dSb290UmVuYW1lKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdST09UX1JFTkFNRV9SRVFVSVJFU19DT05GSVJNQVRJT04nLCBg6IqC54K5ICR7bm9kZUlkfSDmmK/lr7zlhaXmoLnvvIzor7fmmI7noa7lhYHorrjmoLnoioLngrnmlLnlkI3jgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChpdGVtLm5hbWUgPT09IG51bGwpIGRlbGV0ZSBjdXJyZW50Lm5hbWU7XHJcbiAgICAgICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShpdGVtLm5hbWUpO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghbmFtZSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX05PREVfTkFNRScsIGDoioLngrkgJHtub2RlSWR9IOeahOWQjeensOa4hea0l+WQjuS4uuepuuOAgmApO1xyXG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnQubmFtZSA9IG5hbWU7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFzdHJhdGVneUNoYW5nZWQgJiYgaXRlbS5uYW1lID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g5rKh5pyJ5o+Q5L6b5Lu75L2V5L+u5pS544CCYCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHN0cmF0ZWd5Q2hhbmdlZCkgY3VycmVudC5leHBsaWNpdCA9IHRydWU7XHJcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGN1cnJlbnQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSBhd2FpdCB0aGlzLmhvc3Quc2F2ZU5vZGVPdmVycmlkZXMoZG9jdW1lbnQuZmlsZUtleSwgdmFsdWVzLCBbLi4uc2Vlbl0pO1xyXG4gICAgICAgIHNlc3Npb24ucmV2aXNpb24gKz0gMTtcclxuICAgICAgICByZXR1cm4geyB1cGRhdGVkOiBwZXJzaXN0ZWQgfTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIGltcG9ydERvY3VtZW50KHBhcmFtczogdW5rbm93biwgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPHVua25vd24+IHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xyXG4gICAgICAgIGNvbnN0IHsgc2Vzc2lvbiwgZG9jdW1lbnQsIHN0YXRlIH0gPSBhd2FpdCB0aGlzLmN1cnJlbnREb2N1bWVudChpbnB1dCk7XHJcbiAgICAgICAgY29uc3Qgb3BlcmF0aW9uSWQgPSByZXF1aXJlZFN0cmluZyhpbnB1dC5vcGVyYXRpb25JZCwgJ29wZXJhdGlvbklkJywgMTI4KTtcclxuICAgICAgICBpZiAob3BlcmF0aW9uSWQubGVuZ3RoIDwgOCB8fCAhL15bQS1aYS16MC05Ll86LV0rJC8udGVzdChvcGVyYXRpb25JZCkpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAnb3BlcmF0aW9uSWQg6Iez5bCRIDgg5Liq5a2X56ym77yM5LiU5Y+q6IO95YyF5ZCr5a2X5q+N44CB5pWw5a2X44CB54K544CB5LiL5YiS57q/44CB5YaS5Y+35ZKM6L+e5a2X56ym44CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpbnB1dC5jb25maXJtICE9PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQ09ORklSTUFUSU9OX1JFUVVJUkVEJywgJ+WvvOWFpeS8muS/ruaUuSBDb2NvcyDpobnnm67vvJvor7forr7nva4gY29uZmlybT10cnVlIOaYjuehruehruiupOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwcm9qZWN0ZWRTZXR0aW5ncyA9IGlucHV0LnNldHRpbmdzID09PSB1bmRlZmluZWRcclxuICAgICAgICAgICAgPyBzdGF0ZS5zZXR0aW5nc1xyXG4gICAgICAgICAgICA6IHRoaXMuYnVpbGRTZXR0aW5ncyhkb2N1bWVudCwgc3RhdGUsIGlucHV0LnNldHRpbmdzKS5zZXR0aW5ncztcclxuICAgICAgICBjb25zdCBwcm9qZWN0ZWRPdmVycmlkZXMgPSByZXNvbHZlZEltcG9ydE92ZXJyaWRlcyhkb2N1bWVudCk7XHJcbiAgICAgICAgY29uc3QgcmVxdWVzdEZpbmdlcnByaW50ID0gaW1wb3J0UmVxdWVzdEZpbmdlcnByaW50KGRvY3VtZW50LCBwcm9qZWN0ZWRTZXR0aW5ncywgcHJvamVjdGVkT3ZlcnJpZGVzKTtcclxuICAgICAgICBjb25zdCBjb21wbGV0ZWQgPSB0aGlzLmNvbXBsZXRlZEltcG9ydHMuZ2V0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICBpZiAoY29tcGxldGVkKSB7XHJcbiAgICAgICAgICAgIGlmIChjb21wbGV0ZWQuZG9jdW1lbnRTZXNzaW9uSWQgIT09IHNlc3Npb24uaWRcclxuICAgICAgICAgICAgICAgIHx8IGNvbXBsZXRlZC5yZXF1ZXN0RmluZ2VycHJpbnQgIT09IHJlcXVlc3RGaW5nZXJwcmludCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdPUEVSQVRJT05fSURfQ09ORkxJQ1QnLCAn6K+lIG9wZXJhdGlvbklkIOW3sueUqOS6juS4jeWQjOeahOaWh+aho+OAgeiuvue9ruaIluiKgueCueetlueVpeOAguivt+S4uuaWsOWvvOWFpeeUn+aIkOaWsOeahCBvcGVyYXRpb25JZOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiBjb21wbGV0ZWQucmVzcG9uc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCkge1xyXG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQub3BlcmF0aW9uSWQgPT09IG9wZXJhdGlvbklkXHJcbiAgICAgICAgICAgICAgICAmJiB0aGlzLmFjdGl2ZUltcG9ydC5kb2N1bWVudFNlc3Npb25JZCA9PT0gc2Vzc2lvbi5pZFxyXG4gICAgICAgICAgICAgICAgJiYgdGhpcy5hY3RpdmVJbXBvcnQucmVxdWVzdEZpbmdlcnByaW50ID09PSByZXF1ZXN0RmluZ2VycHJpbnQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignT1BFUkFUSU9OX0lOX1BST0dSRVNTJywgJ+ivpSBvcGVyYXRpb25JZCDnmoTlr7zlhaXku43lnKjmiafooYzvvIzor7fnrYnlvoXljp/osIPnlKjov5Tlm57jgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQub3BlcmF0aW9uSWQgPT09IG9wZXJhdGlvbklkKSB7XHJcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ09QRVJBVElPTl9JRF9DT05GTElDVCcsICfor6Ugb3BlcmF0aW9uSWQg5b2T5YmN57uR5a6a55qE5piv5Y+m5LiA57uE5a+85YWl5Y+C5pWw44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieWvvOWFpeato+WcqOaJp+ihjOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGhpcy5ob3N0LmlzSW1wb3J0QnVzeSgpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICdDb2NvcyDmj5Lku7blvZPliY3mnInlhbbku5bmk43kvZzmraPlnKjmiafooYzjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdDQU5DRUxMRUQnLCAnTUNQIOiwg+eUqOW3suWPlua2iO+8jOWvvOWFpeWwmuacquW8gOWni+OAgicpO1xyXG4gICAgICAgIHRoaXMuYWN0aXZlSW1wb3J0ID0ge1xyXG4gICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IHNlc3Npb24uaWQsXHJcbiAgICAgICAgICAgIHJlcXVlc3RGaW5nZXJwcmludCxcclxuICAgICAgICB9O1xyXG4gICAgICAgIHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gZmFsc2U7XHJcbiAgICAgICAgY29uc3QgY2FuY2VsRm9yU2lnbmFsID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSB0aGlzLmFjdGl2ZUltcG9ydDtcclxuICAgICAgICAgICAgaWYgKCFhY3RpdmUgfHwgYWN0aXZlLm9wZXJhdGlvbklkICE9PSBvcGVyYXRpb25JZCB8fCBhY3RpdmUuZG9jdW1lbnRTZXNzaW9uSWQgIT09IHNlc3Npb24uaWQpIHJldHVybjtcclxuICAgICAgICAgICAgdGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB0aGlzLmhvc3QuY2FuY2VsSW1wb3J0KG9wZXJhdGlvbklkKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcignYWJvcnQnLCBjYW5jZWxGb3JTaWduYWwsIHsgb25jZTogdHJ1ZSB9KTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBpZiAoaW5wdXQuc2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hcHBseVNldHRpbmdzKHtcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogaW5wdXQuZG9jdW1lbnRTZXNzaW9uSWQsXHJcbiAgICAgICAgICAgICAgICAgICAgc2V0dGluZ3M6IGlucHV0LnNldHRpbmdzLFxyXG4gICAgICAgICAgICAgICAgfSwgZmFsc2UpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMuaG9zdC5nZXRTdGF0ZSgpO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQ0FOQ0VMTEVEJywgJ+WvvOWFpeW3suWPlua2iOOAgicpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChzZXNzaW9uLmhvc3RSZXZpc2lvbiAhPT0gdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKVxyXG4gICAgICAgICAgICAgICAgfHwgbGF0ZXN0LmRvY3VtZW50Py5maWxlS2V5ICE9PSBkb2N1bWVudC5maWxlS2V5XHJcbiAgICAgICAgICAgICAgICB8fCBsYXRlc3QuZG9jdW1lbnQuc291cmNlVXJsICE9PSBkb2N1bWVudC5zb3VyY2VVcmwpIHtcclxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignU1RBTEVfRE9DVU1FTlRfU0VTU0lPTicsICflr7zlhaXliY3mlofmoaPlt7Llj5jljJbvvIzor7fph43mlrDor7vlj5YgRmlnbWEg6ZO+5o6l44CCJyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ0NvY29zIOaPkuS7tuWcqOWvvOWFpeWHhuWkh+acn+mXtOWQr+WKqOS6huWFtuS7luaTjeS9nO+8jOivt+etieW+heWQjumHjeivleWQjOS4gCBvcGVyYXRpb25JZOOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGxhdGVzdC5kb2N1bWVudCk7XHJcbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdEZpbmdlcnByaW50ID0gaW1wb3J0UmVxdWVzdEZpbmdlcnByaW50KGxhdGVzdC5kb2N1bWVudCwgbGF0ZXN0LnNldHRpbmdzLCBvdmVycmlkZXMpO1xyXG4gICAgICAgICAgICBpZiAobGF0ZXN0RmluZ2VycHJpbnQgIT09IHJlcXVlc3RGaW5nZXJwcmludCkge1xyXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKFxyXG4gICAgICAgICAgICAgICAgICAgICdTVEFMRV9PUEVSQVRJT05fUkVRVUVTVCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ+WvvOWFpeWHhuWkh+acn+mXtOiuvue9ruaIluiKgueCueetlueVpeWPkeeUn+WPmOWMlu+8m+acrOasoeayoeacieaJp+ihjOWvvOWFpeOAguivt+WkjeafpeWQjumHjeivleWQjOS4gCBvcGVyYXRpb25JZOOAgicsXHJcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcclxuICAgICAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHN1bW1hcml6ZUltcG9ydFJlc3VsdChhd2FpdCB0aGlzLmhvc3QuaW1wb3J0U2VsZWN0aW9uKFxyXG4gICAgICAgICAgICAgICAgICAgIHsgb3ZlcnJpZGVzLCBzZXR0aW5nczogbGF0ZXN0LnNldHRpbmdzIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgb3BlcmF0aW9uSWQsXHJcbiAgICAgICAgICAgICAgICApKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0ge1xyXG4gICAgICAgICAgICAgICAgICAgIG9wZXJhdGlvbklkLFxyXG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdCxcclxuICAgICAgICAgICAgICAgICAgICAuLi4odGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPyB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbmNlbGxhdGlvbldhcm5pbmc6ICflt7LmlLbliLDlj5bmtojor7fmsYLvvIzkvYYgQ29jb3Mg55qE5LiN5Y+v5Lit5pat5q2l6aqk5bey57uP5a6M5oiQ77yb5pys5qyh5a+85YWl57uT5p6c5pyJ5pWI77yM6K+35Yu/6YeN6K+V44CCJyxcclxuICAgICAgICAgICAgICAgICAgICB9IDoge30pLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIHRoaXMuY29tcGxldGVkSW1wb3J0cy5zZXQob3BlcmF0aW9uSWQsIHtcclxuICAgICAgICAgICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogc2Vzc2lvbi5pZCxcclxuICAgICAgICAgICAgICAgICAgICByZXF1ZXN0RmluZ2VycHJpbnQsXHJcbiAgICAgICAgICAgICAgICAgICAgcmVzcG9uc2UsXHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgIHdoaWxlICh0aGlzLmNvbXBsZXRlZEltcG9ydHMuc2l6ZSA+IDMyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkZXN0ID0gdGhpcy5jb21wbGV0ZWRJbXBvcnRzLmtleXMoKS5uZXh0KCkudmFsdWUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgICAgIGlmICghb2xkZXN0KSBicmVhaztcclxuICAgICAgICAgICAgICAgICAgICB0aGlzLmNvbXBsZXRlZEltcG9ydHMuZGVsZXRlKG9sZGVzdCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICdDQU5DRUxMRUQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAn5Y+W5raI6K+35rGC5bey5Y+R6YCB77yb6LWE5rqQ5oiWIFNjZW5lIOeahOS4jeWPr+S4reaWreatpemqpOWPr+iDveW3suWujOaIkOOAguivt+WFiOajgOafpSBDb2NvcyDlvZPliY3nu5PmnpzvvIzlho3lhrPlrprmmK/lkKbkvb/nlKjmlrDnmoQgb3BlcmF0aW9uSWQg6YeN6K+V44CCJyxcclxuICAgICAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsRm9yU2lnbmFsKTtcclxuICAgICAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0Py5vcGVyYXRpb25JZCA9PT0gb3BlcmF0aW9uSWQpIHRoaXMuYWN0aXZlSW1wb3J0ID0gbnVsbDtcclxuICAgICAgICAgICAgdGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBjYW5jZWxJbXBvcnQocGFyYW1zOiB1bmtub3duKTogdW5rbm93biB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSByZWNvcmQocGFyYW1zKTtcclxuICAgICAgICBjb25zdCBkb2N1bWVudFNlc3Npb25JZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0LmRvY3VtZW50U2Vzc2lvbklkLCAnZG9jdW1lbnRTZXNzaW9uSWQnLCAyNTYpO1xyXG4gICAgICAgIGNvbnN0IG9wZXJhdGlvbklkID0gcmVxdWlyZWRTdHJpbmcoaW5wdXQub3BlcmF0aW9uSWQsICdvcGVyYXRpb25JZCcsIDEyOCk7XHJcbiAgICAgICAgaWYgKG9wZXJhdGlvbklkLmxlbmd0aCA8IDggfHwgIS9eW0EtWmEtejAtOS5fOi1dKyQvLnRlc3Qob3BlcmF0aW9uSWQpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgJ29wZXJhdGlvbklkIOagvOW8j+aXoOaViOOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBhY3RpdmUgPSB0aGlzLmFjdGl2ZUltcG9ydDtcclxuICAgICAgICBpZiAoIWFjdGl2ZSB8fCBhY3RpdmUub3BlcmF0aW9uSWQgIT09IG9wZXJhdGlvbklkIHx8IGFjdGl2ZS5kb2N1bWVudFNlc3Npb25JZCAhPT0gZG9jdW1lbnRTZXNzaW9uSWQpIHtcclxuICAgICAgICAgICAgY29uc3QgY29tcGxldGVkID0gdGhpcy5jb21wbGV0ZWRJbXBvcnRzLmdldChvcGVyYXRpb25JZCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBjYW5jZWxsYXRpb25SZXF1ZXN0ZWQ6IGZhbHNlLFxyXG4gICAgICAgICAgICAgICAgb3BlcmF0aW9uSWQsXHJcbiAgICAgICAgICAgICAgICByZWFzb246IGNvbXBsZXRlZD8uZG9jdW1lbnRTZXNzaW9uSWQgPT09IGRvY3VtZW50U2Vzc2lvbklkXHJcbiAgICAgICAgICAgICAgICAgICAgPyAnQUxSRUFEWV9DT01QTEVURUQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnT1BFUkFUSU9OX05PVF9GT1VORCcsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgICAgICBjb25zdCBpbnRlcnJ1cHRTaWduYWxTZW50ID0gdGhpcy5ob3N0LmNhbmNlbEltcG9ydChvcGVyYXRpb25JZCk7XHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgY2FuY2VsbGF0aW9uUmVxdWVzdGVkOiB0cnVlLFxyXG4gICAgICAgICAgICBvcGVyYXRpb25JZCxcclxuICAgICAgICAgICAgaW50ZXJydXB0U2lnbmFsU2VudCxcclxuICAgICAgICAgICAgZ3VhcmFudGVlZDogZmFsc2UsXHJcbiAgICAgICAgfTtcclxuICAgIH1cclxufVxyXG4iXX0=