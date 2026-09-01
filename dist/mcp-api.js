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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NvdXJjZS9tY3AtYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQXVOQSw4QkFTQztBQWhPRCxtQ0FBaUQ7QUFDakQsK0JBQWtDO0FBQ2xDLHFEQUF5RDtBQUN6RCxxQ0FBK0M7QUFDL0MsMkNBQStDO0FBQy9DLGtEQUlnQztBQUNoQyxvREFBNkU7QUF3RTdFLFNBQVMsY0FBYyxDQUFDLFFBQXdCO0lBQzVDLE9BQU87UUFDSCxTQUFTLEVBQUUsUUFBUSxDQUFDLFNBQVM7UUFDN0IsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXO1FBQ2pDLFlBQVksRUFBRSxRQUFRLENBQUMsWUFBWTtRQUNuQyxLQUFLLEVBQUUsUUFBUSxDQUFDLEtBQUs7UUFDckIsY0FBYyxFQUFFLFFBQVEsQ0FBQyxjQUFjO1FBQ3ZDLGFBQWEsRUFBRSxRQUFRLENBQUMsYUFBYTtRQUNyQyxRQUFRLEVBQUUsUUFBUSxDQUFDLFFBQVE7UUFDM0IsT0FBTyxFQUFFLEVBQUUsR0FBRyxRQUFRLENBQUMsT0FBTyxFQUFFO0tBQ25DLENBQUM7QUFDTixDQUFDO0FBU0QsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLENBQWUsQ0FBQyxRQUFRLEVBQUUsVUFBVSxFQUFFLFFBQVEsRUFBRSxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzVGLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFXO0lBQ2pDLE1BQU07SUFDTixNQUFNO0lBQ04sUUFBUTtJQUNSLE9BQU87SUFDUCxVQUFVO0lBQ1YsUUFBUTtJQUNSLFlBQVk7SUFDWixRQUFRO0NBQ1gsQ0FBQyxDQUFDO0FBRUgsU0FBUyxNQUFNLENBQUMsS0FBYztJQUMxQixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDOUQsTUFBTSxJQUFJLHlCQUFjLENBQUMs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QyxDQUFDO1FBQ3JFLENBQUM7UUFDRCxNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDO1FBQ2pDLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLFdBQVcsS0FBSyxXQUFXLElBQUksTUFBTSxDQUFDLGlCQUFpQixLQUFLLGlCQUFpQixFQUFFLENBQUM7WUFDbEcsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUN6RCxPQUFPO2dCQUNILHFCQUFxQixFQUFFLEtBQUs7Z0JBQzVCLFdBQVc7Z0JBQ1gsTUFBTSxFQUFFLENBQUEsU0FBUyxhQUFULFNBQVMsdUJBQVQsU0FBUyxDQUFFLGlCQUFpQixNQUFLLGlCQUFpQjtvQkFDdEQsQ0FBQyxDQUFDLG1CQUFtQjtvQkFDckIsQ0FBQyxDQUFDLHFCQUFxQjthQUM5QixDQUFDO1FBQ04sQ0FBQztRQUNELElBQUksQ0FBQywyQkFBMkIsR0FBRyxJQUFJLENBQUM7UUFDeEMsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUNoRSxPQUFPO1lBQ0gscUJBQXFCLEVBQUUsSUFBSTtZQUMzQixXQUFXO1lBQ1gsbUJBQW1CO1lBQ25CLFVBQVUsRUFBRSxLQUFLO1NBQ3BCLENBQUM7SUFDTixDQUFDO0NBQ0o7QUEzbEJELGtEQTJsQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjcmVhdGVIYXNoLCByYW5kb21CeXRlcyB9IGZyb20gJ2NyeXB0byc7XG5pbXBvcnQgeyBpc0Fic29sdXRlIH0gZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuL2ltcG9ydC1hY3Rpb25zJztcbmltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuL2ZpZ21hL3VybCc7XG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi9ub2RlLW5hbWUnO1xuaW1wb3J0IHtcbiAgICBlZmZlY3RpdmVLaW5kRm9yTm9kZSxcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcbiAgICBzbWFydEFjdGlvbkZvck5vZGUsXG59IGZyb20gJy4vcGFuZWxzL2RlZmF1bHQvbW9kZWwnO1xuaW1wb3J0IHsgTWNwQnJpZGdlRXJyb3IsIHR5cGUgTWNwQnJpZGdlTWV0aG9kIH0gZnJvbSAnLi9tY3AtYnJpZGdlL3Byb3RvY29sJztcbmltcG9ydCB0eXBlIHtcbiAgICBJbXBvcnRBY3Rpb24sXG4gICAgSW1wb3J0T3ZlcnJpZGUsXG4gICAgSW1wb3J0UmVxdWVzdCxcbiAgICBJbXBvcnRTZXR0aW5ncyxcbiAgICBOb2RlS2luZCxcbiAgICBUcmVlTm9kZUR0byxcbn0gZnJvbSAnLi90eXBlcyc7XG5cbmludGVyZmFjZSBQbHVnaW5Eb2N1bWVudER0byB7XG4gICAgZmlsZUtleTogc3RyaW5nO1xuICAgIGZpbGVOYW1lOiBzdHJpbmc7XG4gICAgc291cmNlVXJsOiBzdHJpbmc7XG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcbiAgICBmb250czogc3RyaW5nW107XG4gICAgbm9kZU92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXTtcbn1cblxuaW50ZXJmYWNlIFBsdWdpblN0YXRlRHRvIHtcbiAgICB2ZXJzaW9uOiBzdHJpbmc7XG4gICAgdmF1bHQ6IHtcbiAgICAgICAgaGFzVG9rZW46IGJvb2xlYW47XG4gICAgICAgIHBlcnNpc3RlbnQ6IGJvb2xlYW47XG4gICAgICAgIGJhY2tlbmQ6IHN0cmluZztcbiAgICAgICAgd2FybmluZz86IHN0cmluZztcbiAgICB9O1xuICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncztcbiAgICBkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG8gfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1jcEFwaUhvc3Qge1xuICAgIHByb2plY3RQYXRoOiBzdHJpbmc7XG4gICAgY3JlYXRvclZlcnNpb246IHN0cmluZztcbiAgICBnZXREb2N1bWVudFJldmlzaW9uKCk6IG51bWJlcjtcbiAgICBpc0ltcG9ydEJ1c3koKTogYm9vbGVhbjtcbiAgICBnZXRTdGF0ZSgpOiBQcm9taXNlPFBsdWdpblN0YXRlRHRvPjtcbiAgICBmZXRjaERvY3VtZW50KHNvdXJjZVVybDogc3RyaW5nKTogUHJvbWlzZTxQbHVnaW5Eb2N1bWVudER0bz47XG4gICAgZ2V0UHJldmlldyhub2RlSWQ6IHN0cmluZyk6IFByb21pc2U8eyB1cmw6IHN0cmluZyB9PjtcbiAgICBzYXZlU2V0dGluZ3ModmFsdWU6IHVua25vd24pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPjtcbiAgICBwYXRjaFNldHRpbmdzPyh2YWx1ZTogUGFydGlhbDxJbXBvcnRTZXR0aW5ncz4pOiBQcm9taXNlPEltcG9ydFNldHRpbmdzPjtcbiAgICBzYXZlTm9kZU92ZXJyaWRlcyhmaWxlS2V5OiB1bmtub3duLCBvdmVycmlkZXM6IHVua25vd24sIHNjb3BlSWRzOiB1bmtub3duKTogUHJvbWlzZTxJbXBvcnRPdmVycmlkZVtdPjtcbiAgICBwYXRjaE5vZGVOYW1lcz8oZmlsZUtleTogc3RyaW5nLCBwYXRjaGVzOiBNY3BOb2RlTmFtZVBhdGNoW10pOiBQcm9taXNlPEltcG9ydE92ZXJyaWRlW10+O1xuICAgIGltcG9ydFNlbGVjdGlvbihyZXF1ZXN0OiBJbXBvcnRSZXF1ZXN0LCBvcGVyYXRpb25JZDogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPjtcbiAgICBjYW5jZWxJbXBvcnQob3BlcmF0aW9uSWQ6IHN0cmluZyk6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWNwTm9kZU5hbWVQYXRjaCB7XG4gICAgaWQ6IHN0cmluZztcbiAgICBuYW1lOiBzdHJpbmcgfCBudWxsO1xuICAgIGZhbGxiYWNrOiBJbXBvcnRPdmVycmlkZTtcbn1cblxuaW50ZXJmYWNlIEFjdGl2ZU1jcERvY3VtZW50IHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGhvc3RSZXZpc2lvbjogbnVtYmVyO1xuICAgIHJldmlzaW9uOiBudW1iZXI7XG4gICAgZmlsZUtleTogc3RyaW5nO1xuICAgIHNvdXJjZVVybDogc3RyaW5nO1xuICAgIHJvb3RJZHM6IFNldDxzdHJpbmc+O1xufVxuXG5pbnRlcmZhY2UgQWN0aXZlTWNwSW1wb3J0IHtcbiAgICBvcGVyYXRpb25JZDogc3RyaW5nO1xuICAgIGRvY3VtZW50U2Vzc2lvbklkOiBzdHJpbmc7XG4gICAgcmVxdWVzdEZpbmdlcnByaW50OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBDb21wbGV0ZWRNY3BJbXBvcnQgZXh0ZW5kcyBBY3RpdmVNY3BJbXBvcnQge1xuICAgIHJlc3BvbnNlOiB1bmtub3duO1xufVxuXG5mdW5jdGlvbiBwdWJsaWNTZXR0aW5ncyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc291cmNlVXJsOiBzZXR0aW5ncy5zb3VyY2VVcmwsXG4gICAgICAgIGFzc2V0Rm9sZGVyOiBzZXR0aW5ncy5hc3NldEZvbGRlcixcbiAgICAgICAgcHJlZmFiRm9sZGVyOiBzZXR0aW5ncy5wcmVmYWJGb2xkZXIsXG4gICAgICAgIHNjYWxlOiBzZXR0aW5ncy5zY2FsZSxcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nLFxuICAgICAgICByZWZyZXNoQXNzZXRzOiBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzLFxuICAgICAgICBhdXRvU2F2ZTogc2V0dGluZ3MuYXV0b1NhdmUsXG4gICAgICAgIGZvbnRNYXA6IHsgLi4uc2V0dGluZ3MuZm9udE1hcCB9LFxuICAgIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhlZFRyZWVOb2RlIHtcbiAgICBub2RlOiBUcmVlTm9kZUR0bztcbiAgICBwYXJlbnROb2RlSWQ/OiBzdHJpbmc7XG4gICAgZGVwdGg6IG51bWJlcjtcbiAgICBwYXRoOiBzdHJpbmdbXTtcbn1cblxuY29uc3QgSU1QT1JUX0FDVElPTlMgPSBuZXcgU2V0PEltcG9ydEFjdGlvbj4oWydpZ25vcmUnLCAnZ2VuZXJhdGUnLCAncmVuZGVyJywgJ3RyYW5zZm9ybSddKTtcbmNvbnN0IE5PREVfS0lORFMgPSBuZXcgU2V0PE5vZGVLaW5kPihbXG4gICAgJ2F1dG8nLFxuICAgICdub2RlJyxcbiAgICAnc3ByaXRlJyxcbiAgICAnbGFiZWwnLFxuICAgICdyaWNoVGV4dCcsXG4gICAgJ2J1dHRvbicsXG4gICAgJ3Njcm9sbFZpZXcnLFxuICAgICdsYXlvdXQnLFxuXSk7XG5cbmZ1bmN0aW9uIHJlY29yZCh2YWx1ZTogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAn5bel5YW35Y+C5pWw5b+F6aG75piv5a+56LGh44CCJyk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuZnVuY3Rpb24gcmVxdWlyZWRTdHJpbmcodmFsdWU6IHVua25vd24sIGxhYmVsOiBzdHJpbmcsIG1heExlbmd0aCA9IDIwNDgpOiBzdHJpbmcge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICF2YWx1ZS50cmltKCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBgJHtsYWJlbH0g5LiN6IO95Li656m644CCYCk7XG4gICAgfVxuICAgIGNvbnN0IHJlc3VsdCA9IHZhbHVlLnRyaW0oKTtcbiAgICBpZiAocmVzdWx0Lmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGAke2xhYmVsfSDotoXov4cgJHttYXhMZW5ndGh9IOWtl+espumZkOWItuOAgmApO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBvcHRpb25hbFN0cmluZ0FycmF5KHZhbHVlOiB1bmtub3duLCBsYWJlbDogc3RyaW5nKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgdmFsdWUuc29tZSgoaXRlbSkgPT4gdHlwZW9mIGl0ZW0gIT09ICdzdHJpbmcnKSkge1xuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGAke2xhYmVsfSDlv4XpobvmmK/lrZfnrKbkuLLmlbDnu4TjgIJgKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlIGFzIHN0cmluZ1tdO1xufVxuXG5mdW5jdGlvbiBib3VuZGVkSW50ZWdlcih2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBsYWJlbDogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IG1pbiB8fCB2YWx1ZSA+IG1heCkge1xuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGAke2xhYmVsfSDlv4XpobvmmK8gJHttaW594oCTJHttYXh9IOS5i+mXtOeahOaVtOaVsOOAgmApO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGVuY29kZUN1cnNvcihzZXNzaW9uSWQ6IHN0cmluZywgcmV2aXNpb246IG51bWJlciwgb2Zmc2V0OiBudW1iZXIsIHF1ZXJ5SGFzaDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uSWQsIHJldmlzaW9uLCBvZmZzZXQsIHF1ZXJ5SGFzaCB9KSwgJ3V0ZjgnKS50b1N0cmluZygnYmFzZTY0dXJsJyk7XG59XG5cbmZ1bmN0aW9uIGRlY29kZUN1cnNvcih2YWx1ZTogdW5rbm93biwgc2Vzc2lvbklkOiBzdHJpbmcsIHJldmlzaW9uOiBudW1iZXIsIHF1ZXJ5SGFzaDogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gJycpIHJldHVybiAwO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8IHZhbHVlLmxlbmd0aCA+IDUxMikge1xuICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfQ1VSU09SJywgJ+WIhumhtSBjdXJzb3Ig5peg5pWI44CCJyk7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGRlY29kZWQgPSBKU09OLnBhcnNlKEJ1ZmZlci5mcm9tKHZhbHVlLCAnYmFzZTY0dXJsJykudG9TdHJpbmcoJ3V0ZjgnKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgIGlmIChkZWNvZGVkLnNlc3Npb25JZCAhPT0gc2Vzc2lvbklkIHx8IGRlY29kZWQucmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGRlY29kZWQucXVlcnlIYXNoICE9PSBxdWVyeUhhc2hcbiAgICAgICAgICAgIHx8IHR5cGVvZiBkZWNvZGVkLm9mZnNldCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIoZGVjb2RlZC5vZmZzZXQpIHx8IGRlY29kZWQub2Zmc2V0IDwgMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdjdXJzb3IgbWlzbWF0Y2gnKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZGVjb2RlZC5vZmZzZXQ7XG4gICAgfSBjYXRjaCB7XG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9DVVJTT1InLCAn5YiG6aG1IGN1cnNvciDlt7LlpLHmlYjvvIzor7fku47nrKzkuIDpobXph43mlrDmn6Xor6LjgIInKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHN0YWJsZUhhc2godmFsdWU6IHVua25vd24pOiBzdHJpbmcge1xuICAgIHJldHVybiBjcmVhdGVIYXNoKCdzaGEyNTYnKS51cGRhdGUoSlNPTi5zdHJpbmdpZnkodmFsdWUpLCAndXRmOCcpLmRpZ2VzdCgnaGV4Jyk7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzRmluZ2VycHJpbnQoc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIHJldHVybiB7XG4gICAgICAgIHNvdXJjZVVybDogc2V0dGluZ3Muc291cmNlVXJsLFxuICAgICAgICBhc3NldEZvbGRlcjogc2V0dGluZ3MuYXNzZXRGb2xkZXIsXG4gICAgICAgIHByZWZhYkZvbGRlcjogc2V0dGluZ3MucHJlZmFiRm9sZGVyLFxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogWy4uLnNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXSxcbiAgICAgICAgc2NhbGU6IHNldHRpbmdzLnNjYWxlLFxuICAgICAgICB1cGRhdGVFeGlzdGluZzogc2V0dGluZ3MudXBkYXRlRXhpc3RpbmcsXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IHNldHRpbmdzLnJlZnJlc2hBc3NldHMsXG4gICAgICAgIGF1dG9TYXZlOiBzZXR0aW5ncy5hdXRvU2F2ZSxcbiAgICAgICAgZm9udE1hcDogT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MuZm9udE1hcCkuc29ydCgoW2xlZnRdLCBbcmlnaHRdKSA9PiBsZWZ0LmxvY2FsZUNvbXBhcmUocmlnaHQpKSxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBpbXBvcnRSZXF1ZXN0RmluZ2VycHJpbnQoXG4gICAgZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvLFxuICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyxcbiAgICBvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10sXG4pOiBzdHJpbmcge1xuICAgIHJldHVybiBzdGFibGVIYXNoKHtcbiAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcbiAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXG4gICAgICAgIHNldHRpbmdzOiBzZXR0aW5nc0ZpbmdlcnByaW50KHNldHRpbmdzKSxcbiAgICAgICAgb3ZlcnJpZGVzOiBvdmVycmlkZXMubWFwKChpdGVtKSA9PiAoe1xuICAgICAgICAgICAgaWQ6IGl0ZW0uaWQsXG4gICAgICAgICAgICBhY3Rpb246IGl0ZW0uYWN0aW9uLFxuICAgICAgICAgICAga2luZDogaXRlbS5raW5kLFxuICAgICAgICAgICAgbmluZVNsaWNlOiBpdGVtLm5pbmVTbGljZSxcbiAgICAgICAgICAgIGV4cGxpY2l0OiBpdGVtLmV4cGxpY2l0ID09PSB0cnVlLFxuICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lID8/IG51bGwsXG4gICAgICAgIH0pKSxcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZVJlbGF0aXZlQXNzZXRGb2xkZXIodmFsdWU6IHVua25vd24sIGxhYmVsOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGZvbGRlciA9IHJlcXVpcmVkU3RyaW5nKHZhbHVlLCBsYWJlbCwgMjU2KS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXlxcLlxcLy8sICcnKS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcbiAgICBpZiAoaXNBYnNvbHV0ZShmb2xkZXIpIHx8IGZvbGRlci5zdGFydHNXaXRoKCcvJykgfHwgZm9sZGVyLnNwbGl0KCcvJykuc29tZSgocGFydCkgPT4gIXBhcnQgfHwgcGFydCA9PT0gJy4nIHx8IHBhcnQgPT09ICcuLicpKSB7XG4gICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsIGAke2xhYmVsfSDlv4XpobvmmK8gYXNzZXRzIOS4i+eahOebuOWvueWtkOebruW9leOAgmApO1xuICAgIH1cbiAgICByZXR1cm4gZm9sZGVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5kZXhUcmVlKHJvb3RzOiBUcmVlTm9kZUR0b1tdKTogSW5kZXhlZFRyZWVOb2RlW10ge1xuICAgIGNvbnN0IHJlc3VsdDogSW5kZXhlZFRyZWVOb2RlW10gPSBbXTtcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBUcmVlTm9kZUR0bywgcGFyZW50Tm9kZUlkOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRlcHRoOiBudW1iZXIsIHBhdGg6IHN0cmluZ1tdKSA9PiB7XG4gICAgICAgIGNvbnN0IG5leHRQYXRoID0gWy4uLnBhdGgsIG5vZGUubmFtZV07XG4gICAgICAgIHJlc3VsdC5wdXNoKHsgbm9kZSwgcGFyZW50Tm9kZUlkLCBkZXB0aCwgcGF0aDogbmV4dFBhdGggfSk7XG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IHZpc2l0KGNoaWxkLCBub2RlLmlkLCBkZXB0aCArIDEsIG5leHRQYXRoKSk7XG4gICAgfTtcbiAgICByb290cy5mb3JFYWNoKChyb290KSA9PiB2aXNpdChyb290LCB1bmRlZmluZWQsIDAsIFtdKSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdE92ZXJyaWRlKG5vZGU6IFRyZWVOb2RlRHRvKTogSW1wb3J0T3ZlcnJpZGUge1xuICAgIHJldHVybiB7XG4gICAgICAgIGlkOiBub2RlLmlkLFxuICAgICAgICBhY3Rpb246IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcbiAgICAgICAga2luZDogbm9kZS5raW5kLFxuICAgICAgICBuaW5lU2xpY2U6IG5vZGUucGF0Y2hDYW5kaWRhdGUsXG4gICAgICAgIGV4cGxpY2l0OiBmYWxzZSxcbiAgICB9O1xufVxuXG5mdW5jdGlvbiBvdmVycmlkZU1hcChkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG8pOiBNYXA8c3RyaW5nLCBJbXBvcnRPdmVycmlkZT4ge1xuICAgIHJldHVybiBuZXcgTWFwKGRvY3VtZW50Lm5vZGVPdmVycmlkZXMubWFwKChpdGVtKSA9PiBbaXRlbS5pZCwgeyAuLi5pdGVtIH1dKSk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGRvY3VtZW50OiBQbHVnaW5Eb2N1bWVudER0byk6IEltcG9ydE92ZXJyaWRlW10ge1xuICAgIGNvbnN0IG5vZGVzID0gaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlKTtcbiAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlTWFwKGRvY3VtZW50KTtcbiAgICBjb25zdCBwcmVmZXJyZWRBY3Rpb25zID0gbmV3IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj4oKTtcbiAgICBjb25zdCBmb3JjZWRSZW5kZXJJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHNhdmVkLmdldChub2RlLmlkKTtcbiAgICAgICAgcHJlZmVycmVkQWN0aW9ucy5zZXQoXG4gICAgICAgICAgICBub2RlLmlkLFxuICAgICAgICAgICAgY3VycmVudD8uZXhwbGljaXQgPT09IHRydWUgPyBub3JtYWxpemVJbXBvcnRBY3Rpb24oY3VycmVudC5hY3Rpb24pIDogc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxuICAgICAgICApO1xuICAgICAgICBjb25zdCBuaW5lU2xpY2UgPSBjdXJyZW50Py5leHBsaWNpdCA9PT0gdHJ1ZSA/IGN1cnJlbnQubmluZVNsaWNlIDogbm9kZS5wYXRjaENhbmRpZGF0ZTtcbiAgICAgICAgaWYgKG5pbmVTbGljZSAmJiBub2RlLnBhdGNoQ2FuZGlkYXRlKSBmb3JjZWRSZW5kZXJJZHMuYWRkKG5vZGUuaWQpO1xuICAgIH1cbiAgICBjb25zdCBlZmZlY3RpdmUgPSByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyhkb2N1bWVudC50cmVlLCBwcmVmZXJyZWRBY3Rpb25zLCBmb3JjZWRSZW5kZXJJZHMpO1xuICAgIHJldHVybiBub2Rlcy5tYXAoKG5vZGUpID0+IHtcbiAgICAgICAgY29uc3QgY3VycmVudCA9IHNhdmVkLmdldChub2RlLmlkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGlkOiBub2RlLmlkLFxuICAgICAgICAgICAgYWN0aW9uOiBlZmZlY3RpdmUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxuICAgICAgICAgICAga2luZDogY3VycmVudD8uZXhwbGljaXQgPT09IHRydWUgPyBjdXJyZW50LmtpbmQgOiBub2RlLmtpbmQsXG4gICAgICAgICAgICBuaW5lU2xpY2U6IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlID8gY3VycmVudC5uaW5lU2xpY2UgOiBub2RlLnBhdGNoQ2FuZGlkYXRlLFxuICAgICAgICAgICAgZXhwbGljaXQ6IGN1cnJlbnQ/LmV4cGxpY2l0ID09PSB0cnVlLFxuICAgICAgICAgICAgLi4uKGN1cnJlbnQ/Lm5hbWUgPyB7IG5hbWU6IGN1cnJlbnQubmFtZSB9IDoge30pLFxuICAgICAgICB9O1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBzdW1tYXJpemVJbXBvcnRSZXN1bHQodmFsdWU6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHJldHVybiB7IGNvbXBsZXRlZDogdHJ1ZSB9O1xuICAgIH1cbiAgICBjb25zdCByZXN1bHQgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBzdW1tYXJ5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgY29tcGxldGVkOiB0cnVlIH07XG4gICAgaWYgKHR5cGVvZiByZXN1bHQuY3JlYXRlZCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHJlc3VsdC5jcmVhdGVkKSkgc3VtbWFyeS5jcmVhdGVkID0gcmVzdWx0LmNyZWF0ZWQ7XG4gICAgaWYgKHR5cGVvZiByZXN1bHQudXBkYXRlZCA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHJlc3VsdC51cGRhdGVkKSkgc3VtbWFyeS51cGRhdGVkID0gcmVzdWx0LnVwZGF0ZWQ7XG4gICAgaWYgKHR5cGVvZiByZXN1bHQucHJlZmFiVXJsID09PSAnc3RyaW5nJykgc3VtbWFyeS5wcmVmYWJVcmwgPSByZXN1bHQucHJlZmFiVXJsO1xuICAgIGlmICh0eXBlb2YgcmVzdWx0LnRlbXBvcmFyeVJvb3QgPT09ICdib29sZWFuJykgc3VtbWFyeS50ZW1wb3JhcnlSb290ID0gcmVzdWx0LnRlbXBvcmFyeVJvb3Q7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkocmVzdWx0Lndhcm5pbmdzKSkge1xuICAgICAgICBzdW1tYXJ5Lndhcm5pbmdzID0gcmVzdWx0Lndhcm5pbmdzXG4gICAgICAgICAgICAuZmlsdGVyKChpdGVtKTogaXRlbSBpcyBzdHJpbmcgPT4gdHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDEwMClcbiAgICAgICAgICAgIC5tYXAoKGl0ZW0pID0+IGl0ZW0uc2xpY2UoMCwgNTEyKSk7XG4gICAgfVxuICAgIHJldHVybiBzdW1tYXJ5O1xufVxuXG5leHBvcnQgY2xhc3MgRmlnbWFJbXBvcnRlck1jcEFwaSB7XG4gICAgcHJpdmF0ZSBzZXNzaW9uOiBBY3RpdmVNY3BEb2N1bWVudCB8IG51bGwgPSBudWxsO1xuICAgIHByaXZhdGUgYWN0aXZlSW1wb3J0OiBBY3RpdmVNY3BJbXBvcnQgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIGltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCA9IGZhbHNlO1xuICAgIHByaXZhdGUgcmVhZG9ubHkgY29tcGxldGVkSW1wb3J0cyA9IG5ldyBNYXA8c3RyaW5nLCBDb21wbGV0ZWRNY3BJbXBvcnQ+KCk7XG4gICAgcHJpdmF0ZSBzZXR0aW5nc1dyaXRlUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICAgIGNvbnN0cnVjdG9yKHByaXZhdGUgcmVhZG9ubHkgaG9zdDogTWNwQXBpSG9zdCkge31cblxuICAgIGFzeW5jIGludm9rZShtZXRob2Q6IE1jcEJyaWRnZU1ldGhvZCwgcGFyYW1zOiB1bmtub3duLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dW5rbm93bj4ge1xuICAgICAgICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgICAgICAgICAgY2FzZSAnZ2V0U3RhdHVzJzogcmV0dXJuIHRoaXMuZ2V0U3RhdHVzKCk7XG4gICAgICAgICAgICBjYXNlICdmZXRjaERvY3VtZW50JzogcmV0dXJuIHRoaXMuZmV0Y2hEb2N1bWVudChwYXJhbXMpO1xuICAgICAgICAgICAgY2FzZSAnbGlzdE5vZGVzJzogcmV0dXJuIHRoaXMubGlzdE5vZGVzKHBhcmFtcyk7XG4gICAgICAgICAgICBjYXNlICdnZXRQcmV2aWV3JzogcmV0dXJuIHRoaXMuZ2V0UHJldmlldyhwYXJhbXMpO1xuICAgICAgICAgICAgY2FzZSAndXBkYXRlU2V0dGluZ3MnOiByZXR1cm4gdGhpcy51cGRhdGVTZXR0aW5ncyhwYXJhbXMpO1xuICAgICAgICAgICAgY2FzZSAndXBkYXRlTm9kZXMnOiByZXR1cm4gdGhpcy51cGRhdGVOb2RlcyhwYXJhbXMpO1xuICAgICAgICAgICAgY2FzZSAncmVuYW1lTm9kZXMnOiByZXR1cm4gdGhpcy5yZW5hbWVOb2RlcyhwYXJhbXMpO1xuICAgICAgICAgICAgY2FzZSAnaW1wb3J0RG9jdW1lbnQnOiByZXR1cm4gdGhpcy5pbXBvcnREb2N1bWVudChwYXJhbXMsIHNpZ25hbCk7XG4gICAgICAgICAgICBjYXNlICdjYW5jZWxJbXBvcnQnOiByZXR1cm4gdGhpcy5jYW5jZWxJbXBvcnQocGFyYW1zKTtcbiAgICAgICAgICAgIGRlZmF1bHQ6IHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTUVUSE9EX05PVF9BTExPV0VEJywgJ+ivpSBCcmlkZ2Ug5pa55rOV5pyq5byA5pS+44CCJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBwcml2YXRlIGFzeW5jIGdldFN0YXR1cygpOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCB0aGlzLmhvc3QuZ2V0U3RhdGUoKTtcbiAgICAgICAgY29uc3Qgc2Vzc2lvblZhbGlkID0gQm9vbGVhbih0aGlzLnNlc3Npb25cbiAgICAgICAgICAgICYmIHRoaXMuc2Vzc2lvbi5ob3N0UmV2aXNpb24gPT09IHRoaXMuaG9zdC5nZXREb2N1bWVudFJldmlzaW9uKClcbiAgICAgICAgICAgICYmIHN0YXRlLmRvY3VtZW50Py5maWxlS2V5ID09PSB0aGlzLnNlc3Npb24uZmlsZUtleSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBjb25uZWN0ZWQ6IHRydWUsXG4gICAgICAgICAgICBwbHVnaW5WZXJzaW9uOiBzdGF0ZS52ZXJzaW9uLFxuICAgICAgICAgICAgY3JlYXRvclZlcnNpb246IHRoaXMuaG9zdC5jcmVhdG9yVmVyc2lvbixcbiAgICAgICAgICAgIHByb2plY3RQYXRoOiB0aGlzLmhvc3QucHJvamVjdFBhdGgsXG4gICAgICAgICAgICB0b2tlbjoge1xuICAgICAgICAgICAgICAgIGNvbmZpZ3VyZWQ6IHN0YXRlLnZhdWx0Lmhhc1Rva2VuLFxuICAgICAgICAgICAgICAgIHBlcnNpc3RlbnQ6IHN0YXRlLnZhdWx0LnBlcnNpc3RlbnQsXG4gICAgICAgICAgICAgICAgYmFja2VuZDogc3RhdGUudmF1bHQuYmFja2VuZCxcbiAgICAgICAgICAgICAgICAuLi4oc3RhdGUudmF1bHQud2FybmluZyA/IHsgd2FybmluZzogc3RhdGUudmF1bHQud2FybmluZyB9IDoge30pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHNldHRpbmdzOiBwdWJsaWNTZXR0aW5ncyhzdGF0ZS5zZXR0aW5ncyksXG4gICAgICAgICAgICBidXN5OiB0aGlzLmFjdGl2ZUltcG9ydCAhPT0gbnVsbCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCksXG4gICAgICAgICAgICBkb2N1bWVudDogc3RhdGUuZG9jdW1lbnQgPyB7XG4gICAgICAgICAgICAgICAgZmlsZU5hbWU6IHN0YXRlLmRvY3VtZW50LmZpbGVOYW1lLFxuICAgICAgICAgICAgICAgIHNvdXJjZVVybDogc3RhdGUuZG9jdW1lbnQuc291cmNlVXJsLFxuICAgICAgICAgICAgICAgIG5vZGVDb3VudDogaW5kZXhUcmVlKHN0YXRlLmRvY3VtZW50LnRyZWUpLmxlbmd0aCxcbiAgICAgICAgICAgICAgICBkb2N1bWVudFNlc3Npb25JZDogc2Vzc2lvblZhbGlkID8gdGhpcy5zZXNzaW9uPy5pZCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH0gOiBudWxsLFxuICAgICAgICB9O1xuICAgIH1cblxuICAgIHByaXZhdGUgYXN5bmMgZmV0Y2hEb2N1bWVudChwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+W9k+WJjeW3suacieaTjeS9nOato+WcqOaJp+ihjO+8jOivt+etieW+heaIluWFiOWPlua2iOOAgicsIHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XG4gICAgICAgIGNvbnN0IHNvdXJjZVVybCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0LnNvdXJjZVVybCwgJ3NvdXJjZVVybCcpO1xuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IHRoaXMuaG9zdC5nZXRTdGF0ZSgpO1xuICAgICAgICBpZiAoIXN0YXRlLnZhdWx0Lmhhc1Rva2VuKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ1RPS0VOX05PVF9DT05GSUdVUkVEJywgJ+WwmuacqumFjee9riBGaWdtYSBQZXJzb25hbCBBY2Nlc3MgVG9rZW7jgIInKTtcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcGFyc2VGaWdtYVNvdXJjZShzb3VyY2VVcmwpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9GSUdNQV9TT1VSQ0UnLCAn5LuF5pSv5oyB5pyJ5pWI55qEIGZpZ21hLmNvbSDmlofku7bjgIHorr7orqHjgIHljp/lnovmiJYgRmlnSmFtIOmTvuaOpeOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgdGhpcy5ob3N0LmZldGNoRG9jdW1lbnQoc291cmNlVXJsKTtcbiAgICAgICAgY29uc3QgaWQgPSByYW5kb21CeXRlcygxOCkudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgICAgICB0aGlzLnNlc3Npb24gPSB7XG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIGhvc3RSZXZpc2lvbjogdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKSxcbiAgICAgICAgICAgIHJldmlzaW9uOiAwLFxuICAgICAgICAgICAgZmlsZUtleTogZG9jdW1lbnQuZmlsZUtleSxcbiAgICAgICAgICAgIHNvdXJjZVVybDogZG9jdW1lbnQuc291cmNlVXJsLFxuICAgICAgICAgICAgcm9vdElkczogbmV3IFNldChkb2N1bWVudC50cmVlLm1hcCgobm9kZSkgPT4gbm9kZS5pZCkpLFxuICAgICAgICB9O1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IGlkLFxuICAgICAgICAgICAgZmlsZU5hbWU6IGRvY3VtZW50LmZpbGVOYW1lLFxuICAgICAgICAgICAgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwsXG4gICAgICAgICAgICBub2RlQ291bnQ6IGluZGV4VHJlZShkb2N1bWVudC50cmVlKS5sZW5ndGgsXG4gICAgICAgICAgICBmb250czogZG9jdW1lbnQuZm9udHMsXG4gICAgICAgICAgICByb290czogZG9jdW1lbnQudHJlZS5tYXAoKG5vZGUpID0+ICh7XG4gICAgICAgICAgICAgICAgbm9kZUlkOiBub2RlLmlkLFxuICAgICAgICAgICAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICB0eXBlOiBub2RlLnR5cGUsXG4gICAgICAgICAgICAgICAgd2lkdGg6IG5vZGUud2lkdGgsXG4gICAgICAgICAgICAgICAgaGVpZ2h0OiBub2RlLmhlaWdodCxcbiAgICAgICAgICAgICAgICBjaGlsZENvdW50OiBub2RlLmNoaWxkcmVuLmxlbmd0aCxcbiAgICAgICAgICAgIH0pKSxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBwcml2YXRlIGFzeW5jIGN1cnJlbnREb2N1bWVudChwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx7IHNlc3Npb246IEFjdGl2ZU1jcERvY3VtZW50OyBkb2N1bWVudDogUGx1Z2luRG9jdW1lbnREdG87IHN0YXRlOiBQbHVnaW5TdGF0ZUR0byB9PiB7XG4gICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHJlcXVpcmVkU3RyaW5nKHBhcmFtcy5kb2N1bWVudFNlc3Npb25JZCwgJ2RvY3VtZW50U2Vzc2lvbklkJywgMjU2KTtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbiA9IHRoaXMuc2Vzc2lvbjtcbiAgICAgICAgaWYgKCFzZXNzaW9uIHx8IHNlc3Npb24uaWQgIT09IHNlc3Npb25JZCB8fCBzZXNzaW9uLmhvc3RSZXZpc2lvbiAhPT0gdGhpcy5ob3N0LmdldERvY3VtZW50UmV2aXNpb24oKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdTVEFMRV9ET0NVTUVOVF9TRVNTSU9OJywgJ+aWh+aho+S8muivneW3suWkseaViO+8jOivt+mHjeaWsOivu+WPliBGaWdtYSDpk77mjqXjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IHRoaXMuaG9zdC5nZXRTdGF0ZSgpO1xuICAgICAgICBjb25zdCBkb2N1bWVudCA9IHN0YXRlLmRvY3VtZW50O1xuICAgICAgICBpZiAoIWRvY3VtZW50IHx8IGRvY3VtZW50LmZpbGVLZXkgIT09IHNlc3Npb24uZmlsZUtleSB8fCBkb2N1bWVudC5zb3VyY2VVcmwgIT09IHNlc3Npb24uc291cmNlVXJsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ1NUQUxFX0RPQ1VNRU5UX1NFU1NJT04nLCAn5b2T5YmN5o+S5Lu25paH5qGj5bey5Y+Y5YyW77yM6K+36YeN5paw6K+75Y+WIEZpZ21hIOmTvuaOpeOAgicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9O1xuICAgIH1cblxuICAgIHByaXZhdGUgYXN5bmMgbGlzdE5vZGVzKHBhcmFtczogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xuICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50IH0gPSBhd2FpdCB0aGlzLmN1cnJlbnREb2N1bWVudChpbnB1dCk7XG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcbiAgICAgICAgY29uc3QgYnlJZCA9IG5ldyBNYXAoYWxsLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbV0pKTtcbiAgICAgICAgY29uc3Qgcm9vdE5vZGVJZCA9IHR5cGVvZiBpbnB1dC5yb290Tm9kZUlkID09PSAnc3RyaW5nJyAmJiBpbnB1dC5yb290Tm9kZUlkLnRyaW0oKVxuICAgICAgICAgICAgPyBpbnB1dC5yb290Tm9kZUlkLnRyaW0oKVxuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IHJvb3RJdGVtID0gcm9vdE5vZGVJZCA/IGJ5SWQuZ2V0KHJvb3ROb2RlSWQpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAocm9vdE5vZGVJZCAmJiAhcm9vdEl0ZW0pIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTk9ERV9OT1RfRk9VTkQnLCBg6IqC54K5ICR7cm9vdE5vZGVJZH0g5LiN5a2Y5Zyo44CCYCk7XG4gICAgICAgIGNvbnN0IG1heERlcHRoID0gYm91bmRlZEludGVnZXIoaW5wdXQuZGVwdGgsIDgsIDAsIDMyLCAnZGVwdGgnKTtcbiAgICAgICAgY29uc3QgbGltaXQgPSBib3VuZGVkSW50ZWdlcihpbnB1dC5saW1pdCwgNTAsIDEsIDIwMCwgJ2xpbWl0Jyk7XG4gICAgICAgIGNvbnN0IHNlYXJjaCA9IHR5cGVvZiBpbnB1dC5zZWFyY2ggPT09ICdzdHJpbmcnID8gaW5wdXQuc2VhcmNoLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgpIDogJyc7XG4gICAgICAgIGNvbnN0IHR5cGVzID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC50eXBlcywgJ3R5cGVzJyk7XG4gICAgICAgIGNvbnN0IGFjdGlvbnMgPSBvcHRpb25hbFN0cmluZ0FycmF5KGlucHV0LmFjdGlvbnMsICdhY3Rpb25zJyk7XG4gICAgICAgIGNvbnN0IGtpbmRzID0gb3B0aW9uYWxTdHJpbmdBcnJheShpbnB1dC5raW5kcywgJ2tpbmRzJyk7XG4gICAgICAgIGNvbnN0IHdhcm5pbmdPbmx5ID0gaW5wdXQud2FybmluZ09ubHkgPT09IHRydWU7XG4gICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IG92ZXJyaWRlTWFwKGRvY3VtZW50KTtcbiAgICAgICAgY29uc3QgcHJlZmVycmVkQWN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+KCk7XG4gICAgICAgIGNvbnN0IGZvcmNlZFJlbmRlcklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgICAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgYWxsKSB7XG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlcy5nZXQoaXRlbS5ub2RlLmlkKTtcbiAgICAgICAgICAgIGNvbnN0IHByZWZlcnJlZCA9IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZVxuICAgICAgICAgICAgICAgID8gbm9ybWFsaXplSW1wb3J0QWN0aW9uKHNhdmVkLmFjdGlvbilcbiAgICAgICAgICAgICAgICA6IHNtYXJ0QWN0aW9uRm9yTm9kZShpdGVtLm5vZGUpO1xuICAgICAgICAgICAgcHJlZmVycmVkQWN0aW9ucy5zZXQoXG4gICAgICAgICAgICAgICAgaXRlbS5ub2RlLmlkLFxuICAgICAgICAgICAgICAgIHByZWZlcnJlZCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBjb25zdCBuaW5lU2xpY2UgPSBzYXZlZD8uZXhwbGljaXQgPT09IHRydWUgPyBzYXZlZC5uaW5lU2xpY2UgOiBpdGVtLm5vZGUucGF0Y2hDYW5kaWRhdGU7XG4gICAgICAgICAgICBpZiAobmluZVNsaWNlICYmIGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZSkge1xuICAgICAgICAgICAgICAgIGZvcmNlZFJlbmRlcklkcy5hZGQoaXRlbS5ub2RlLmlkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCBlZmZlY3RpdmUgPSByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyhkb2N1bWVudC50cmVlLCBwcmVmZXJyZWRBY3Rpb25zLCBmb3JjZWRSZW5kZXJJZHMpO1xuICAgICAgICBjb25zdCByb290RGVwdGggPSByb290SXRlbT8uZGVwdGggPz8gMDtcbiAgICAgICAgY29uc3QgZGVzY2VuZGFudHMgPSByb290SXRlbVxuICAgICAgICAgICAgPyBuZXcgU2V0KGluZGV4VHJlZShbcm9vdEl0ZW0ubm9kZV0pLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlLmlkKSlcbiAgICAgICAgICAgIDogbnVsbDtcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGFsbC5maWx0ZXIoKGl0ZW0pID0+IHtcbiAgICAgICAgICAgIGlmIChkZXNjZW5kYW50cyAmJiAhZGVzY2VuZGFudHMuaGFzKGl0ZW0ubm9kZS5pZCkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGlmIChpdGVtLmRlcHRoIC0gcm9vdERlcHRoID4gbWF4RGVwdGgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVzLmdldChpdGVtLm5vZGUuaWQpO1xuICAgICAgICAgICAgY29uc3QgY29jb3NOYW1lID0gc2F2ZWQ/Lm5hbWUgPz8gaXRlbS5ub2RlLm5hbWU7XG4gICAgICAgICAgICBjb25zdCBhY3Rpb24gPSBlZmZlY3RpdmUuYWN0aW9ucy5nZXQoaXRlbS5ub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUoaXRlbS5ub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcbiAgICAgICAgICAgICAgICBpdGVtLm5vZGUsXG4gICAgICAgICAgICAgICAgc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQua2luZCA6IGl0ZW0ubm9kZS5raW5kLFxuICAgICAgICAgICAgICAgIGFjdGlvbixcbiAgICAgICAgICAgICAgICBzYXZlZD8uZXhwbGljaXQgPT09IHRydWUgPyBzYXZlZC5uaW5lU2xpY2UgOiBpdGVtLm5vZGUucGF0Y2hDYW5kaWRhdGUsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHNlYXJjaCAmJiAhYCR7aXRlbS5ub2RlLm5hbWV9XFxuJHtjb2Nvc05hbWV9XFxuJHtpdGVtLnBhdGguam9pbignLycpfWAudG9Mb2NhbGVMb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICBpZiAodHlwZXMgJiYgIXR5cGVzLmluY2x1ZGVzKGl0ZW0ubm9kZS50eXBlKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKGFjdGlvbnMgJiYgIWFjdGlvbnMuaW5jbHVkZXMoYWN0aW9uKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKGtpbmRzICYmICFraW5kcy5pbmNsdWRlcyhraW5kKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgaWYgKHdhcm5pbmdPbmx5ICYmICFpdGVtLm5vZGUud2FybmluZykgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBxdWVyeUhhc2ggPSBzdGFibGVIYXNoKHtcbiAgICAgICAgICAgIHJvb3ROb2RlSWQ6IHJvb3ROb2RlSWQgPz8gbnVsbCxcbiAgICAgICAgICAgIHNlYXJjaCxcbiAgICAgICAgICAgIHR5cGVzOiB0eXBlcyA/IFsuLi50eXBlc10uc29ydCgpIDogbnVsbCxcbiAgICAgICAgICAgIGFjdGlvbnM6IGFjdGlvbnMgPyBbLi4uYWN0aW9uc10uc29ydCgpIDogbnVsbCxcbiAgICAgICAgICAgIGtpbmRzOiBraW5kcyA/IFsuLi5raW5kc10uc29ydCgpIDogbnVsbCxcbiAgICAgICAgICAgIHdhcm5pbmdPbmx5LFxuICAgICAgICAgICAgZGVwdGg6IG1heERlcHRoLFxuICAgICAgICAgICAgbGltaXQsXG4gICAgICAgICAgICBvdmVycmlkZXM6IFsuLi5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzXVxuICAgICAgICAgICAgICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gbGVmdC5pZC5sb2NhbGVDb21wYXJlKHJpZ2h0LmlkKSlcbiAgICAgICAgICAgICAgICAubWFwKChpdGVtKSA9PiAoe1xuICAgICAgICAgICAgICAgICAgICBpZDogaXRlbS5pZCxcbiAgICAgICAgICAgICAgICAgICAgYWN0aW9uOiBpdGVtLmFjdGlvbixcbiAgICAgICAgICAgICAgICAgICAga2luZDogaXRlbS5raW5kLFxuICAgICAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IGl0ZW0ubmluZVNsaWNlLFxuICAgICAgICAgICAgICAgICAgICBleHBsaWNpdDogaXRlbS5leHBsaWNpdCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgbmFtZTogaXRlbS5uYW1lID8/IG51bGwsXG4gICAgICAgICAgICAgICAgfSkpLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3Qgb2Zmc2V0ID0gZGVjb2RlQ3Vyc29yKGlucHV0LmN1cnNvciwgc2Vzc2lvbi5pZCwgc2Vzc2lvbi5yZXZpc2lvbiwgcXVlcnlIYXNoKTtcbiAgICAgICAgY29uc3QgcGFnZSA9IGNhbmRpZGF0ZXMuc2xpY2Uob2Zmc2V0LCBvZmZzZXQgKyBsaW1pdCk7XG4gICAgICAgIGNvbnN0IG5vZGVzID0gcGFnZS5tYXAoKGl0ZW0pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gb3ZlcnJpZGVzLmdldChpdGVtLm5vZGUuaWQpO1xuICAgICAgICAgICAgY29uc3QgcHJlZmVycmVkQWN0aW9uID0gcHJlZmVycmVkQWN0aW9ucy5nZXQoaXRlbS5ub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUoaXRlbS5ub2RlKTtcbiAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IGVmZmVjdGl2ZS5hY3Rpb25zLmdldChpdGVtLm5vZGUuaWQpID8/IHByZWZlcnJlZEFjdGlvbjtcbiAgICAgICAgICAgIGNvbnN0IG5pbmVTbGljZSA9IHNhdmVkPy5leHBsaWNpdCA9PT0gdHJ1ZSA/IHNhdmVkLm5pbmVTbGljZSA6IGl0ZW0ubm9kZS5wYXRjaENhbmRpZGF0ZTtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgbm9kZUlkOiBpdGVtLm5vZGUuaWQsXG4gICAgICAgICAgICAgICAgcGFyZW50Tm9kZUlkOiBpdGVtLnBhcmVudE5vZGVJZCxcbiAgICAgICAgICAgICAgICBkZXB0aDogaXRlbS5kZXB0aCAtIHJvb3REZXB0aCxcbiAgICAgICAgICAgICAgICBwYXRoOiBpdGVtLnBhdGguam9pbignLycpLFxuICAgICAgICAgICAgICAgIGZpZ21hTmFtZTogaXRlbS5ub2RlLm5hbWUsXG4gICAgICAgICAgICAgICAgY29jb3NOYW1lOiBzYXZlZD8ubmFtZSA/PyBpdGVtLm5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICByZW5hbWVkOiBCb29sZWFuKHNhdmVkPy5uYW1lICYmIHNhdmVkLm5hbWUgIT09IGl0ZW0ubm9kZS5uYW1lKSxcbiAgICAgICAgICAgICAgICB0eXBlOiBpdGVtLm5vZGUudHlwZSxcbiAgICAgICAgICAgICAgICB2aXNpYmxlOiBpdGVtLm5vZGUudmlzaWJsZSxcbiAgICAgICAgICAgICAgICB3aWR0aDogaXRlbS5ub2RlLndpZHRoLFxuICAgICAgICAgICAgICAgIGhlaWdodDogaXRlbS5ub2RlLmhlaWdodCxcbiAgICAgICAgICAgICAgICBjaGlsZENvdW50OiBpdGVtLm5vZGUuY2hpbGRyZW4ubGVuZ3RoLFxuICAgICAgICAgICAgICAgIHByZWZlcnJlZEFjdGlvbixcbiAgICAgICAgICAgICAgICBhY3Rpb24sXG4gICAgICAgICAgICAgICAga2luZDogZWZmZWN0aXZlS2luZEZvck5vZGUoXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0ubm9kZSxcbiAgICAgICAgICAgICAgICAgICAgc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gc2F2ZWQua2luZCA6IGl0ZW0ubm9kZS5raW5kLFxuICAgICAgICAgICAgICAgICAgICBhY3Rpb24sXG4gICAgICAgICAgICAgICAgICAgIG5pbmVTbGljZSxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIG5pbmVTbGljZSxcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlLFxuICAgICAgICAgICAgICAgIHN1cHByZXNzZWQ6IGVmZmVjdGl2ZS5zdXBwcmVzc2VkLmhhcyhpdGVtLm5vZGUuaWQpLFxuICAgICAgICAgICAgICAgIHBhdGNoQ2FuZGlkYXRlOiBpdGVtLm5vZGUucGF0Y2hDYW5kaWRhdGUsXG4gICAgICAgICAgICAgICAgc2xpY2VNb2RlOiBpdGVtLm5vZGUuc2xpY2VNb2RlLFxuICAgICAgICAgICAgICAgIHJlYXNvbjogc2F2ZWQ/LmV4cGxpY2l0ID09PSB0cnVlID8gJ3VzZXItb3ZlcnJpZGUnIDogaXRlbS5ub2RlLnJlYXNvbixcbiAgICAgICAgICAgICAgICBmb2xkOiBzYXZlZD8uZXhwbGljaXQgPT09IHRydWUgfHwgQm9vbGVhbihzYXZlZD8ubmFtZSkgPyB1bmRlZmluZWQgOiBpdGVtLm5vZGUuZm9sZCxcbiAgICAgICAgICAgICAgICB3YXJuaW5nOiBpdGVtLm5vZGUud2FybmluZyxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pO1xuICAgICAgICBjb25zdCBuZXh0T2Zmc2V0ID0gb2Zmc2V0ICsgcGFnZS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICB0b3RhbENvdW50OiBjYW5kaWRhdGVzLmxlbmd0aCxcbiAgICAgICAgICAgIGNvdW50OiBub2Rlcy5sZW5ndGgsXG4gICAgICAgICAgICBub2RlcyxcbiAgICAgICAgICAgIGhhc01vcmU6IG5leHRPZmZzZXQgPCBjYW5kaWRhdGVzLmxlbmd0aCxcbiAgICAgICAgICAgIG5leHRDdXJzb3I6IG5leHRPZmZzZXQgPCBjYW5kaWRhdGVzLmxlbmd0aFxuICAgICAgICAgICAgICAgID8gZW5jb2RlQ3Vyc29yKHNlc3Npb24uaWQsIHNlc3Npb24ucmV2aXNpb24sIG5leHRPZmZzZXQsIHF1ZXJ5SGFzaClcbiAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfTtcbiAgICB9XG5cbiAgICBwcml2YXRlIGFzeW5jIGdldFByZXZpZXcocGFyYW1zOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XG4gICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydCB8fCB0aGlzLmhvc3QuaXNJbXBvcnRCdXN5KCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICflvZPliY3lt7LmnInmk43kvZzmraPlnKjmiafooYzvvIzor7fnrYnlvoXmiJblhYjlj5bmtojjgIInLCB0cnVlKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xuICAgICAgICBjb25zdCB7IGRvY3VtZW50IH0gPSBhd2FpdCB0aGlzLmN1cnJlbnREb2N1bWVudChpbnB1dCk7XG4gICAgICAgIGNvbnN0IG5vZGVJZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0Lm5vZGVJZCwgJ25vZGVJZCcsIDI1Nik7XG4gICAgICAgIGlmICghaW5kZXhUcmVlKGRvY3VtZW50LnRyZWUpLnNvbWUoKGl0ZW0pID0+IGl0ZW0ubm9kZS5pZCA9PT0gbm9kZUlkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdOT0RFX05PVF9GT1VORCcsIGDoioLngrkgJHtub2RlSWR9IOS4jeWtmOWcqOOAgmApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmhvc3QuZ2V0UHJldmlldyhub2RlSWQpO1xuICAgIH1cblxuICAgIHByaXZhdGUgYnVpbGRTZXR0aW5ncyhcbiAgICAgICAgZG9jdW1lbnQ6IFBsdWdpbkRvY3VtZW50RHRvLFxuICAgICAgICBzdGF0ZTogUGx1Z2luU3RhdGVEdG8sXG4gICAgICAgIHZhbHVlOiB1bmtub3duLFxuICAgICk6IHsgcGF0Y2g6IFBhcnRpYWw8SW1wb3J0U2V0dGluZ3M+OyBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MgfSB7XG4gICAgICAgIGNvbnN0IHBhdGNoID0gcmVjb3JkKHZhbHVlKTtcbiAgICAgICAgY29uc3QgYWxsb3dlZEtleXMgPSBuZXcgU2V0KFtcbiAgICAgICAgICAgICdhc3NldEZvbGRlcicsXG4gICAgICAgICAgICAncHJlZmFiRm9sZGVyJyxcbiAgICAgICAgICAgICdzY2FsZScsXG4gICAgICAgICAgICAndXBkYXRlRXhpc3RpbmcnLFxuICAgICAgICAgICAgJ3JlZnJlc2hBc3NldHMnLFxuICAgICAgICAgICAgJ2F1dG9TYXZlJyxcbiAgICAgICAgICAgICdmb250TWFwJyxcbiAgICAgICAgXSk7XG4gICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhwYXRjaCk7XG4gICAgICAgIGlmICgha2V5cy5sZW5ndGggfHwga2V5cy5zb21lKChrZXkpID0+ICFhbGxvd2VkS2V5cy5oYXMoa2V5KSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsICdzZXR0aW5ncyDlv4XpobvljIXlkKvoh7PlsJHkuIDkuKrlj5fmlK/mjIHnmoTorr7nva7lrZfmrrXjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBub3JtYWxpemVkOiBQYXJ0aWFsPEltcG9ydFNldHRpbmdzPiA9IHsgc291cmNlVXJsOiBkb2N1bWVudC5zb3VyY2VVcmwgfTtcbiAgICAgICAgY29uc3Qgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzID0ge1xuICAgICAgICAgICAgLi4uc3RhdGUuc2V0dGluZ3MsXG4gICAgICAgICAgICBzb3VyY2VVcmw6IGRvY3VtZW50LnNvdXJjZVVybCxcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKHBhdGNoLmFzc2V0Rm9sZGVyICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHNldHRpbmdzLmFzc2V0Rm9sZGVyID0gc2FmZVJlbGF0aXZlQXNzZXRGb2xkZXIocGF0Y2guYXNzZXRGb2xkZXIsICdhc3NldEZvbGRlcicpO1xuICAgICAgICAgICAgbm9ybWFsaXplZC5hc3NldEZvbGRlciA9IHNldHRpbmdzLmFzc2V0Rm9sZGVyO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwYXRjaC5wcmVmYWJGb2xkZXIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgc2V0dGluZ3MucHJlZmFiRm9sZGVyID0gc2FmZVJlbGF0aXZlQXNzZXRGb2xkZXIocGF0Y2gucHJlZmFiRm9sZGVyLCAncHJlZmFiRm9sZGVyJyk7XG4gICAgICAgICAgICBub3JtYWxpemVkLnByZWZhYkZvbGRlciA9IHNldHRpbmdzLnByZWZhYkZvbGRlcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAocGF0Y2guc2NhbGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBwYXRjaC5zY2FsZSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0Zpbml0ZShwYXRjaC5zY2FsZSkgfHwgcGF0Y2guc2NhbGUgPCAwLjI1IHx8IHBhdGNoLnNjYWxlID4gNCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsICdzY2FsZSDlv4XpobvmmK8gMC4yNeKAkzQg5LmL6Ze055qE5pWw5a2X44CCJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXR0aW5ncy5zY2FsZSA9IHBhdGNoLnNjYWxlO1xuICAgICAgICAgICAgbm9ybWFsaXplZC5zY2FsZSA9IHBhdGNoLnNjYWxlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3Qga2V5IG9mIFsndXBkYXRlRXhpc3RpbmcnLCAncmVmcmVzaEFzc2V0cycsICdhdXRvU2F2ZSddIGFzIGNvbnN0KSB7XG4gICAgICAgICAgICBpZiAocGF0Y2hba2V5XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBwYXRjaFtrZXldICE9PSAnYm9vbGVhbicpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9TRVRUSU5HUycsIGAke2tleX0g5b+F6aG75piv5biD5bCU5YC844CCYCk7XG4gICAgICAgICAgICAgICAgc2V0dGluZ3Nba2V5XSA9IHBhdGNoW2tleV07XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZFtrZXldID0gcGF0Y2hba2V5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAocGF0Y2guZm9udE1hcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBpZiAoIXBhdGNoLmZvbnRNYXAgfHwgdHlwZW9mIHBhdGNoLmZvbnRNYXAgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGF0Y2guZm9udE1hcCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfU0VUVElOR1MnLCAnZm9udE1hcCDlv4XpobvmmK/lr7nosaHjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgW2ZvbnQsIHVybF0gb2YgT2JqZWN0LmVudHJpZXMocGF0Y2guZm9udE1hcCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWZvbnQudHJpbSgpIHx8IHR5cGVvZiB1cmwgIT09ICdzdHJpbmcnIHx8ICh1cmwgJiYgIXVybC5zdGFydHNXaXRoKCdkYjovL2Fzc2V0cy8nKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1NFVFRJTkdTJywgJ2ZvbnRNYXAg5Y+q6IO95byV55SoIGRiOi8vYXNzZXRzIOS4i+eahOWtl+S9k+i1hOa6kOOAgicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmb250TWFwW2ZvbnQudHJpbSgpXSA9IHVybC50cmltKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXR0aW5ncy5mb250TWFwID0gZm9udE1hcDtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWQuZm9udE1hcCA9IGZvbnRNYXA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgcGF0Y2g6IG5vcm1hbGl6ZWQsIHNldHRpbmdzIH07XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBhcHBseVNldHRpbmdzKHBhcmFtczogdW5rbm93biwgaW5jcmVtZW50UmV2aXNpb24gPSB0cnVlKTogUHJvbWlzZTxJbXBvcnRTZXR0aW5ncz4ge1xuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xuICAgICAgICBjb25zdCBvcGVyYXRpb24gPSBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xuICAgICAgICAgICAgY29uc3QgYnVpbHQgPSB0aGlzLmJ1aWxkU2V0dGluZ3MoZG9jdW1lbnQsIHN0YXRlLCBpbnB1dC5zZXR0aW5ncyk7XG4gICAgICAgICAgICBjb25zdCBzYXZlZCA9IHRoaXMuaG9zdC5wYXRjaFNldHRpbmdzXG4gICAgICAgICAgICAgICAgPyBhd2FpdCB0aGlzLmhvc3QucGF0Y2hTZXR0aW5ncyhidWlsdC5wYXRjaClcbiAgICAgICAgICAgICAgICA6IGF3YWl0IHRoaXMuaG9zdC5zYXZlU2V0dGluZ3MoYnVpbHQuc2V0dGluZ3MpO1xuICAgICAgICAgICAgaWYgKGluY3JlbWVudFJldmlzaW9uKSBzZXNzaW9uLnJldmlzaW9uICs9IDE7XG4gICAgICAgICAgICByZXR1cm4gc2F2ZWQ7XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuc2V0dGluZ3NXcml0ZVF1ZXVlLnRoZW4ob3BlcmF0aW9uKTtcbiAgICAgICAgdGhpcy5zZXR0aW5nc1dyaXRlUXVldWUgPSByZXN1bHQudGhlbigoKSA9PiB1bmRlZmluZWQsICgpID0+IHVuZGVmaW5lZCk7XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBhc3luYyB1cGRhdGVTZXR0aW5ncyhwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+WvvOWFpeaJp+ihjOacn+mXtOS4jeiDveS/ruaUueiuvue9ruOAgicsIHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBwdWJsaWNTZXR0aW5ncyhhd2FpdCB0aGlzLmFwcGx5U2V0dGluZ3MocGFyYW1zKSk7XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBhc3luYyByZW5hbWVOb2RlcyhwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+WvvOWFpeaJp+ihjOacn+mXtOS4jeiDveS/ruaUueiKgueCueWQjeensOOAgicsIHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XG4gICAgICAgIGNvbnN0IHsgc2Vzc2lvbiwgZG9jdW1lbnQgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LnJlbmFtZXMpIHx8ICFpbnB1dC5yZW5hbWVzLmxlbmd0aCB8fCBpbnB1dC5yZW5hbWVzLmxlbmd0aCA+IDUwMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAncmVuYW1lcyDlv4XpobvljIXlkKsgMeKAkzUwMCDkuKrmlLnlkI3pobnjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBhbGxvd1Jvb3RSZW5hbWUgPSBpbnB1dC5hbGxvd1Jvb3RSZW5hbWUgPT09IHRydWU7XG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcbiAgICAgICAgY29uc3QgYnlJZCA9IG5ldyBNYXAoYWxsLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlXSkpO1xuICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlTWFwKGRvY3VtZW50KTtcbiAgICAgICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgICAgICBjb25zdCB2YWx1ZXM6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcbiAgICAgICAgY29uc3QgcGF0Y2hlczogTWNwTm9kZU5hbWVQYXRjaFtdID0gW107XG4gICAgICAgIGNvbnN0IHVwZGF0ZWQ6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHJhdyBvZiBpbnB1dC5yZW5hbWVzKSB7XG4gICAgICAgICAgICBjb25zdCBpdGVtID0gcmVjb3JkKHJhdyk7XG4gICAgICAgICAgICBjb25zdCBub2RlSWQgPSByZXF1aXJlZFN0cmluZyhpdGVtLm5vZGVJZCwgJ25vZGVJZCcsIDI1Nik7XG4gICAgICAgICAgICBpZiAoc2Vlbi5oYXMobm9kZUlkKSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCBg6IqC54K5ICR7bm9kZUlkfSDph43lpI3lh7rnjrDjgIJgKTtcbiAgICAgICAgICAgIHNlZW4uYWRkKG5vZGVJZCk7XG4gICAgICAgICAgICBjb25zdCBub2RlID0gYnlJZC5nZXQobm9kZUlkKTtcbiAgICAgICAgICAgIGlmICghbm9kZSkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdOT0RFX05PVF9GT1VORCcsIGDoioLngrkgJHtub2RlSWR9IOS4jeWtmOWcqOOAgmApO1xuICAgICAgICAgICAgaWYgKHNlc3Npb24ucm9vdElkcy5oYXMobm9kZUlkKSAmJiAhYWxsb3dSb290UmVuYW1lKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKFxuICAgICAgICAgICAgICAgICAgICAnUk9PVF9SRU5BTUVfUkVRVUlSRVNfQ09ORklSTUFUSU9OJyxcbiAgICAgICAgICAgICAgICAgICAgYOiKgueCuSAke25vZGVJZH0g5piv5a+85YWl5qC577yb5pS55ZCN5Lya5pS55Y+Y6ZO+5o6lIEZyYW1lIOeahCBQcmVmYWIg5paH5Lu25ZCN77yM6K+36K6+572uIGFsbG93Um9vdFJlbmFtZT10cnVlIOaYjuehruehruiupOOAgmAsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzYXZlZC5nZXQobm9kZUlkKSA/PyBkZWZhdWx0T3ZlcnJpZGUobm9kZSkpIH07XG4gICAgICAgICAgICBsZXQgY29jb3NOYW1lID0gbm9kZS5uYW1lO1xuICAgICAgICAgICAgaWYgKGl0ZW0ubmFtZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBjdXJyZW50Lm5hbWU7XG4gICAgICAgICAgICAgICAgcGF0Y2hlcy5wdXNoKHsgaWQ6IG5vZGVJZCwgbmFtZTogbnVsbCwgZmFsbGJhY2s6IGN1cnJlbnQgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKGl0ZW0ubmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfTk9ERV9OQU1FJywgYOiKgueCuSAke25vZGVJZH0g55qE5ZCN56ew5riF5rSX5ZCO5Li656m644CCYCk7XG4gICAgICAgICAgICAgICAgY3VycmVudC5uYW1lID0gbmFtZTtcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWUgPSBuYW1lO1xuICAgICAgICAgICAgICAgIHBhdGNoZXMucHVzaCh7IGlkOiBub2RlSWQsIG5hbWUsIGZhbGxiYWNrOiBjdXJyZW50IH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFsdWVzLnB1c2goY3VycmVudCk7XG4gICAgICAgICAgICB1cGRhdGVkLnB1c2goe1xuICAgICAgICAgICAgICAgIG5vZGVJZCxcbiAgICAgICAgICAgICAgICBmaWdtYU5hbWU6IG5vZGUubmFtZSxcbiAgICAgICAgICAgICAgICBjb2Nvc05hbWUsXG4gICAgICAgICAgICAgICAgcmVzZXQ6IGl0ZW0ubmFtZSA9PT0gbnVsbCxcbiAgICAgICAgICAgICAgICB3YXJuaW5nOiBzZXNzaW9uLnJvb3RJZHMuaGFzKG5vZGVJZClcbiAgICAgICAgICAgICAgICAgICAgPyAn5qC56IqC54K55pS55ZCN5Lya5pS55Y+Y6ZO+5o6lIEZyYW1lIOeahCBQcmVmYWIg5paH5Lu25ZCN44CCJ1xuICAgICAgICAgICAgICAgICAgICA6ICfmlLnlkI3oioLngrnkvJrkv53nlZnkuLrni6znq4sgQ29jb3Mg6IqC54K577yM5Y+v6IO96Zi75q2i6KeG6KeJ5YyF6KOF5bGC5oqY5Y+g44CCJyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0aGlzLmhvc3QucGF0Y2hOb2RlTmFtZXMpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuaG9zdC5wYXRjaE5vZGVOYW1lcyhkb2N1bWVudC5maWxlS2V5LCBwYXRjaGVzKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuaG9zdC5zYXZlTm9kZU92ZXJyaWRlcyhkb2N1bWVudC5maWxlS2V5LCB2YWx1ZXMsIFsuLi5zZWVuXSk7XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbi5yZXZpc2lvbiArPSAxO1xuICAgICAgICByZXR1cm4geyB1cGRhdGVkIH07XG4gICAgfVxuXG4gICAgcHJpdmF0ZSBhc3luYyB1cGRhdGVOb2RlcyhwYXJhbXM6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0IHx8IHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdCVVNZJywgJ+WvvOWFpeaJp+ihjOacn+mXtOS4jeiDveS/ruaUueiKgueCueetlueVpeOAgicsIHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlucHV0ID0gcmVjb3JkKHBhcmFtcyk7XG4gICAgICAgIGNvbnN0IHsgc2Vzc2lvbiwgZG9jdW1lbnQgfSA9IGF3YWl0IHRoaXMuY3VycmVudERvY3VtZW50KGlucHV0KTtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0LnVwZGF0ZXMpIHx8ICFpbnB1dC51cGRhdGVzLmxlbmd0aCB8fCBpbnB1dC51cGRhdGVzLmxlbmd0aCA+IDUwMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdJTlZBTElEX1JFUVVFU1QnLCAndXBkYXRlcyDlv4XpobvljIXlkKsgMeKAkzUwMCDkuKroioLngrnorr7nva7jgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBhbGxvd1Jvb3RSZW5hbWUgPSBpbnB1dC5hbGxvd1Jvb3RSZW5hbWUgPT09IHRydWU7XG4gICAgICAgIGNvbnN0IGFsbCA9IGluZGV4VHJlZShkb2N1bWVudC50cmVlKTtcbiAgICAgICAgY29uc3QgYnlJZCA9IG5ldyBNYXAoYWxsLm1hcCgoaXRlbSkgPT4gW2l0ZW0ubm9kZS5pZCwgaXRlbS5ub2RlXSkpO1xuICAgICAgICBjb25zdCBzYXZlZCA9IG92ZXJyaWRlTWFwKGRvY3VtZW50KTtcbiAgICAgICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgICAgICBjb25zdCB2YWx1ZXM6IEltcG9ydE92ZXJyaWRlW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCByYXcgb2YgaW5wdXQudXBkYXRlcykge1xuICAgICAgICAgICAgY29uc3QgaXRlbSA9IHJlY29yZChyYXcpO1xuICAgICAgICAgICAgY29uc3Qgbm9kZUlkID0gcmVxdWlyZWRTdHJpbmcoaXRlbS5ub2RlSWQsICdub2RlSWQnLCAyNTYpO1xuICAgICAgICAgICAgaWYgKHNlZW4uaGFzKG5vZGVJZCkpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g6YeN5aSN5Ye6546w44CCYCk7XG4gICAgICAgICAgICBzZWVuLmFkZChub2RlSWQpO1xuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGJ5SWQuZ2V0KG5vZGVJZCk7XG4gICAgICAgICAgICBpZiAoIW5vZGUpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignTk9ERV9OT1RfRk9VTkQnLCBg6IqC54K5ICR7bm9kZUlkfSDkuI3lrZjlnKjjgIJgKTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSB7IC4uLihzYXZlZC5nZXQobm9kZUlkKSA/PyBkZWZhdWx0T3ZlcnJpZGUobm9kZSkpIH07XG4gICAgICAgICAgICBsZXQgc3RyYXRlZ3lDaGFuZ2VkID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAoaXRlbS5hY3Rpb24gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIGlmICghSU1QT1JUX0FDVElPTlMuaGFzKGl0ZW0uYWN0aW9uIGFzIEltcG9ydEFjdGlvbikpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g55qEIGFjdGlvbiDml6DmlYjjgIJgKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50LmFjdGlvbiA9IGl0ZW0uYWN0aW9uIGFzIEltcG9ydEFjdGlvbjtcbiAgICAgICAgICAgICAgICBzdHJhdGVneUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGl0ZW0ua2luZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFOT0RFX0tJTkRTLmhhcyhpdGVtLmtpbmQgYXMgTm9kZUtpbmQpKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGDoioLngrkgJHtub2RlSWR9IOeahCBraW5kIOaXoOaViOOAgmApO1xuICAgICAgICAgICAgICAgIGN1cnJlbnQua2luZCA9IGl0ZW0ua2luZCBhcyBOb2RlS2luZDtcbiAgICAgICAgICAgICAgICBzdHJhdGVneUNoYW5nZWQgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGl0ZW0ubmluZVNsaWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGl0ZW0ubmluZVNsaWNlICE9PSAnYm9vbGVhbicpIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgYOiKgueCuSAke25vZGVJZH0g55qEIG5pbmVTbGljZSDlv4XpobvmmK/luIPlsJTlgLzjgIJgKTtcbiAgICAgICAgICAgICAgICBjdXJyZW50Lm5pbmVTbGljZSA9IGl0ZW0ubmluZVNsaWNlO1xuICAgICAgICAgICAgICAgIHN0cmF0ZWd5Q2hhbmdlZCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXRlbS5uYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICBpZiAoc2Vzc2lvbi5yb290SWRzLmhhcyhub2RlSWQpICYmICFhbGxvd1Jvb3RSZW5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdST09UX1JFTkFNRV9SRVFVSVJFU19DT05GSVJNQVRJT04nLCBg6IqC54K5ICR7bm9kZUlkfSDmmK/lr7zlhaXmoLnvvIzor7fmmI7noa7lhYHorrjmoLnoioLngrnmlLnlkI3jgIJgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ubmFtZSA9PT0gbnVsbCkgZGVsZXRlIGN1cnJlbnQubmFtZTtcbiAgICAgICAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUoaXRlbS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFuYW1lKSB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfTk9ERV9OQU1FJywgYOiKgueCuSAke25vZGVJZH0g55qE5ZCN56ew5riF5rSX5ZCO5Li656m644CCYCk7XG4gICAgICAgICAgICAgICAgICAgIGN1cnJlbnQubmFtZSA9IG5hbWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFzdHJhdGVneUNoYW5nZWQgJiYgaXRlbS5uYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0lOVkFMSURfUkVRVUVTVCcsIGDoioLngrkgJHtub2RlSWR9IOayoeacieaPkOS+m+S7u+S9leS/ruaUueOAgmApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHN0cmF0ZWd5Q2hhbmdlZCkgY3VycmVudC5leHBsaWNpdCA9IHRydWU7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChjdXJyZW50KTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSBhd2FpdCB0aGlzLmhvc3Quc2F2ZU5vZGVPdmVycmlkZXMoZG9jdW1lbnQuZmlsZUtleSwgdmFsdWVzLCBbLi4uc2Vlbl0pO1xuICAgICAgICBzZXNzaW9uLnJldmlzaW9uICs9IDE7XG4gICAgICAgIHJldHVybiB7IHVwZGF0ZWQ6IHBlcnNpc3RlZCB9O1xuICAgIH1cblxuICAgIHByaXZhdGUgYXN5bmMgaW1wb3J0RG9jdW1lbnQocGFyYW1zOiB1bmtub3duLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dW5rbm93bj4ge1xuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xuICAgICAgICBjb25zdCB7IHNlc3Npb24sIGRvY3VtZW50LCBzdGF0ZSB9ID0gYXdhaXQgdGhpcy5jdXJyZW50RG9jdW1lbnQoaW5wdXQpO1xuICAgICAgICBjb25zdCBvcGVyYXRpb25JZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0Lm9wZXJhdGlvbklkLCAnb3BlcmF0aW9uSWQnLCAxMjgpO1xuICAgICAgICBpZiAob3BlcmF0aW9uSWQubGVuZ3RoIDwgOCB8fCAhL15bQS1aYS16MC05Ll86LV0rJC8udGVzdChvcGVyYXRpb25JZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgJ29wZXJhdGlvbklkIOiHs+WwkSA4IOS4quWtl+espu+8jOS4lOWPquiDveWMheWQq+Wtl+avjeOAgeaVsOWtl+OAgeeCueOAgeS4i+WIkue6v+OAgeWGkuWPt+WSjOi/nuWtl+espuOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChpbnB1dC5jb25maXJtICE9PSB0cnVlKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0NPTkZJUk1BVElPTl9SRVFVSVJFRCcsICflr7zlhaXkvJrkv67mlLkgQ29jb3Mg6aG555uu77yb6K+36K6+572uIGNvbmZpcm09dHJ1ZSDmmI7noa7noa7orqTjgIInKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwcm9qZWN0ZWRTZXR0aW5ncyA9IGlucHV0LnNldHRpbmdzID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgID8gc3RhdGUuc2V0dGluZ3NcbiAgICAgICAgICAgIDogdGhpcy5idWlsZFNldHRpbmdzKGRvY3VtZW50LCBzdGF0ZSwgaW5wdXQuc2V0dGluZ3MpLnNldHRpbmdzO1xuICAgICAgICBjb25zdCBwcm9qZWN0ZWRPdmVycmlkZXMgPSByZXNvbHZlZEltcG9ydE92ZXJyaWRlcyhkb2N1bWVudCk7XG4gICAgICAgIGNvbnN0IHJlcXVlc3RGaW5nZXJwcmludCA9IGltcG9ydFJlcXVlc3RGaW5nZXJwcmludChkb2N1bWVudCwgcHJvamVjdGVkU2V0dGluZ3MsIHByb2plY3RlZE92ZXJyaWRlcyk7XG4gICAgICAgIGNvbnN0IGNvbXBsZXRlZCA9IHRoaXMuY29tcGxldGVkSW1wb3J0cy5nZXQob3BlcmF0aW9uSWQpO1xuICAgICAgICBpZiAoY29tcGxldGVkKSB7XG4gICAgICAgICAgICBpZiAoY29tcGxldGVkLmRvY3VtZW50U2Vzc2lvbklkICE9PSBzZXNzaW9uLmlkXG4gICAgICAgICAgICAgICAgfHwgY29tcGxldGVkLnJlcXVlc3RGaW5nZXJwcmludCAhPT0gcmVxdWVzdEZpbmdlcnByaW50KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdPUEVSQVRJT05fSURfQ09ORkxJQ1QnLCAn6K+lIG9wZXJhdGlvbklkIOW3sueUqOS6juS4jeWQjOeahOaWh+aho+OAgeiuvue9ruaIluiKgueCueetlueVpeOAguivt+S4uuaWsOWvvOWFpeeUn+aIkOaWsOeahCBvcGVyYXRpb25JZOOAgicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBsZXRlZC5yZXNwb25zZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmFjdGl2ZUltcG9ydC5vcGVyYXRpb25JZCA9PT0gb3BlcmF0aW9uSWRcbiAgICAgICAgICAgICAgICAmJiB0aGlzLmFjdGl2ZUltcG9ydC5kb2N1bWVudFNlc3Npb25JZCA9PT0gc2Vzc2lvbi5pZFxuICAgICAgICAgICAgICAgICYmIHRoaXMuYWN0aXZlSW1wb3J0LnJlcXVlc3RGaW5nZXJwcmludCA9PT0gcmVxdWVzdEZpbmdlcnByaW50KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdPUEVSQVRJT05fSU5fUFJPR1JFU1MnLCAn6K+lIG9wZXJhdGlvbklkIOeahOWvvOWFpeS7jeWcqOaJp+ihjO+8jOivt+etieW+heWOn+iwg+eUqOi/lOWbnuOAgicsIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuYWN0aXZlSW1wb3J0Lm9wZXJhdGlvbklkID09PSBvcGVyYXRpb25JZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignT1BFUkFUSU9OX0lEX0NPTkZMSUNUJywgJ+ivpSBvcGVyYXRpb25JZCDlvZPliY3nu5HlrprnmoTmmK/lj6bkuIDnu4Tlr7zlhaXlj4LmlbDjgIInKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICflvZPliY3lt7LmnInlr7zlhaXmraPlnKjmiafooYzjgIInLCB0cnVlKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5ob3N0LmlzSW1wb3J0QnVzeSgpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ0JVU1knLCAnQ29jb3Mg5o+S5Lu25b2T5YmN5pyJ5YW25LuW5pON5L2c5q2j5Zyo5omn6KGM44CCJywgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdDQU5DRUxMRUQnLCAnTUNQIOiwg+eUqOW3suWPlua2iO+8jOWvvOWFpeWwmuacquW8gOWni+OAgicpO1xuICAgICAgICB0aGlzLmFjdGl2ZUltcG9ydCA9IHtcbiAgICAgICAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgICAgICAgZG9jdW1lbnRTZXNzaW9uSWQ6IHNlc3Npb24uaWQsXG4gICAgICAgICAgICByZXF1ZXN0RmluZ2VycHJpbnQsXG4gICAgICAgIH07XG4gICAgICAgIHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gZmFsc2U7XG4gICAgICAgIGNvbnN0IGNhbmNlbEZvclNpZ25hbCA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFjdGl2ZSA9IHRoaXMuYWN0aXZlSW1wb3J0O1xuICAgICAgICAgICAgaWYgKCFhY3RpdmUgfHwgYWN0aXZlLm9wZXJhdGlvbklkICE9PSBvcGVyYXRpb25JZCB8fCBhY3RpdmUuZG9jdW1lbnRTZXNzaW9uSWQgIT09IHNlc3Npb24uaWQpIHJldHVybjtcbiAgICAgICAgICAgIHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHRoaXMuaG9zdC5jYW5jZWxJbXBvcnQob3BlcmF0aW9uSWQpO1xuICAgICAgICB9O1xuICAgICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsRm9yU2lnbmFsLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBpZiAoaW5wdXQuc2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYXBwbHlTZXR0aW5ncyh7XG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50U2Vzc2lvbklkOiBpbnB1dC5kb2N1bWVudFNlc3Npb25JZCxcbiAgICAgICAgICAgICAgICAgICAgc2V0dGluZ3M6IGlucHV0LnNldHRpbmdzLFxuICAgICAgICAgICAgICAgIH0sIGZhbHNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IGF3YWl0IHRoaXMuaG9zdC5nZXRTdGF0ZSgpO1xuICAgICAgICAgICAgaWYgKHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKCdDQU5DRUxMRUQnLCAn5a+85YWl5bey5Y+W5raI44CCJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoc2Vzc2lvbi5ob3N0UmV2aXNpb24gIT09IHRoaXMuaG9zdC5nZXREb2N1bWVudFJldmlzaW9uKClcbiAgICAgICAgICAgICAgICB8fCBsYXRlc3QuZG9jdW1lbnQ/LmZpbGVLZXkgIT09IGRvY3VtZW50LmZpbGVLZXlcbiAgICAgICAgICAgICAgICB8fCBsYXRlc3QuZG9jdW1lbnQuc291cmNlVXJsICE9PSBkb2N1bWVudC5zb3VyY2VVcmwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgTWNwQnJpZGdlRXJyb3IoJ1NUQUxFX0RPQ1VNRU5UX1NFU1NJT04nLCAn5a+85YWl5YmN5paH5qGj5bey5Y+Y5YyW77yM6K+36YeN5paw6K+75Y+WIEZpZ21hIOmTvuaOpeOAgicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuaG9zdC5pc0ltcG9ydEJ1c3koKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignQlVTWScsICdDb2NvcyDmj5Lku7blnKjlr7zlhaXlh4blpIfmnJ/pl7TlkK/liqjkuoblhbbku5bmk43kvZzvvIzor7fnrYnlvoXlkI7ph43or5XlkIzkuIAgb3BlcmF0aW9uSWTjgIInLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IG92ZXJyaWRlcyA9IHJlc29sdmVkSW1wb3J0T3ZlcnJpZGVzKGxhdGVzdC5kb2N1bWVudCk7XG4gICAgICAgICAgICBjb25zdCBsYXRlc3RGaW5nZXJwcmludCA9IGltcG9ydFJlcXVlc3RGaW5nZXJwcmludChsYXRlc3QuZG9jdW1lbnQsIGxhdGVzdC5zZXR0aW5ncywgb3ZlcnJpZGVzKTtcbiAgICAgICAgICAgIGlmIChsYXRlc3RGaW5nZXJwcmludCAhPT0gcmVxdWVzdEZpbmdlcnByaW50KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE1jcEJyaWRnZUVycm9yKFxuICAgICAgICAgICAgICAgICAgICAnU1RBTEVfT1BFUkFUSU9OX1JFUVVFU1QnLFxuICAgICAgICAgICAgICAgICAgICAn5a+85YWl5YeG5aSH5pyf6Ze06K6+572u5oiW6IqC54K5562W55Wl5Y+R55Sf5Y+Y5YyW77yb5pys5qyh5rKh5pyJ5omn6KGM5a+85YWl44CC6K+35aSN5p+l5ZCO6YeN6K+V5ZCM5LiAIG9wZXJhdGlvbklk44CCJyxcbiAgICAgICAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBzdW1tYXJpemVJbXBvcnRSZXN1bHQoYXdhaXQgdGhpcy5ob3N0LmltcG9ydFNlbGVjdGlvbihcbiAgICAgICAgICAgICAgICAgICAgeyBvdmVycmlkZXMsIHNldHRpbmdzOiBsYXRlc3Quc2V0dGluZ3MgfSxcbiAgICAgICAgICAgICAgICAgICAgb3BlcmF0aW9uSWQsXG4gICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7XG4gICAgICAgICAgICAgICAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgICAgICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICAgICAgICAgIC4uLih0aGlzLmltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhbmNlbGxhdGlvbldhcm5pbmc6ICflt7LmlLbliLDlj5bmtojor7fmsYLvvIzkvYYgQ29jb3Mg55qE5LiN5Y+v5Lit5pat5q2l6aqk5bey57uP5a6M5oiQ77yb5pys5qyh5a+85YWl57uT5p6c5pyJ5pWI77yM6K+35Yu/6YeN6K+V44CCJyxcbiAgICAgICAgICAgICAgICAgICAgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIHRoaXMuY29tcGxldGVkSW1wb3J0cy5zZXQob3BlcmF0aW9uSWQsIHtcbiAgICAgICAgICAgICAgICAgICAgb3BlcmF0aW9uSWQsXG4gICAgICAgICAgICAgICAgICAgIGRvY3VtZW50U2Vzc2lvbklkOiBzZXNzaW9uLmlkLFxuICAgICAgICAgICAgICAgICAgICByZXF1ZXN0RmluZ2VycHJpbnQsXG4gICAgICAgICAgICAgICAgICAgIHJlc3BvbnNlLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHdoaWxlICh0aGlzLmNvbXBsZXRlZEltcG9ydHMuc2l6ZSA+IDMyKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9sZGVzdCA9IHRoaXMuY29tcGxldGVkSW1wb3J0cy5rZXlzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFvbGRlc3QpIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmNvbXBsZXRlZEltcG9ydHMuZGVsZXRlKG9sZGVzdCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMuaW1wb3J0Q2FuY2VsbGF0aW9uUmVxdWVzdGVkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgICdDQU5DRUxMRUQnLFxuICAgICAgICAgICAgICAgICAgICAgICAgJ+WPlua2iOivt+axguW3suWPkemAge+8m+i1hOa6kOaIliBTY2VuZSDnmoTkuI3lj6/kuK3mlq3mraXpqqTlj6/og73lt7LlrozmiJDjgILor7flhYjmo4Dmn6UgQ29jb3Mg5b2T5YmN57uT5p6c77yM5YaN5Yaz5a6a5piv5ZCm5L2/55So5paw55qEIG9wZXJhdGlvbklkIOmHjeivleOAgicsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbEZvclNpZ25hbCk7XG4gICAgICAgICAgICBpZiAodGhpcy5hY3RpdmVJbXBvcnQ/Lm9wZXJhdGlvbklkID09PSBvcGVyYXRpb25JZCkgdGhpcy5hY3RpdmVJbXBvcnQgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5pbXBvcnRDYW5jZWxsYXRpb25SZXF1ZXN0ZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHByaXZhdGUgY2FuY2VsSW1wb3J0KHBhcmFtczogdW5rbm93bik6IHVua25vd24ge1xuICAgICAgICBjb25zdCBpbnB1dCA9IHJlY29yZChwYXJhbXMpO1xuICAgICAgICBjb25zdCBkb2N1bWVudFNlc3Npb25JZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0LmRvY3VtZW50U2Vzc2lvbklkLCAnZG9jdW1lbnRTZXNzaW9uSWQnLCAyNTYpO1xuICAgICAgICBjb25zdCBvcGVyYXRpb25JZCA9IHJlcXVpcmVkU3RyaW5nKGlucHV0Lm9wZXJhdGlvbklkLCAnb3BlcmF0aW9uSWQnLCAxMjgpO1xuICAgICAgICBpZiAob3BlcmF0aW9uSWQubGVuZ3RoIDwgOCB8fCAhL15bQS1aYS16MC05Ll86LV0rJC8udGVzdChvcGVyYXRpb25JZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBNY3BCcmlkZ2VFcnJvcignSU5WQUxJRF9SRVFVRVNUJywgJ29wZXJhdGlvbklkIOagvOW8j+aXoOaViOOAgicpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGFjdGl2ZSA9IHRoaXMuYWN0aXZlSW1wb3J0O1xuICAgICAgICBpZiAoIWFjdGl2ZSB8fCBhY3RpdmUub3BlcmF0aW9uSWQgIT09IG9wZXJhdGlvbklkIHx8IGFjdGl2ZS5kb2N1bWVudFNlc3Npb25JZCAhPT0gZG9jdW1lbnRTZXNzaW9uSWQpIHtcbiAgICAgICAgICAgIGNvbnN0IGNvbXBsZXRlZCA9IHRoaXMuY29tcGxldGVkSW1wb3J0cy5nZXQob3BlcmF0aW9uSWQpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBjYW5jZWxsYXRpb25SZXF1ZXN0ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgICAgICAgICAgIHJlYXNvbjogY29tcGxldGVkPy5kb2N1bWVudFNlc3Npb25JZCA9PT0gZG9jdW1lbnRTZXNzaW9uSWRcbiAgICAgICAgICAgICAgICAgICAgPyAnQUxSRUFEWV9DT01QTEVURUQnXG4gICAgICAgICAgICAgICAgICAgIDogJ09QRVJBVElPTl9OT1RfRk9VTkQnLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLmltcG9ydENhbmNlbGxhdGlvblJlcXVlc3RlZCA9IHRydWU7XG4gICAgICAgIGNvbnN0IGludGVycnVwdFNpZ25hbFNlbnQgPSB0aGlzLmhvc3QuY2FuY2VsSW1wb3J0KG9wZXJhdGlvbklkKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNhbmNlbGxhdGlvblJlcXVlc3RlZDogdHJ1ZSxcbiAgICAgICAgICAgIG9wZXJhdGlvbklkLFxuICAgICAgICAgICAgaW50ZXJydXB0U2lnbmFsU2VudCxcbiAgICAgICAgICAgIGd1YXJhbnRlZWQ6IGZhbHNlLFxuICAgICAgICB9O1xuICAgIH1cbn1cbiJdfQ==