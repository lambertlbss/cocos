import { createHash, randomBytes } from 'crypto';
import { isAbsolute } from 'path';
import { normalizeImportAction } from './import-actions';
import { parseFigmaSource } from './figma/url';
import { sanitizeNodeName } from './node-name';
import {
    effectiveKindForNode,
    resolveEffectiveActions,
    smartActionForNode,
} from './panels/default/model';
import { McpBridgeError, type McpBridgeMethod } from './mcp-bridge/protocol';
import type {
    ImportAction,
    ImportOverride,
    ImportRequest,
    ImportSettings,
    NodeKind,
    TreeNodeDto,
} from './types';

interface PluginDocumentDto {
    fileKey: string;
    fileName: string;
    sourceUrl: string;
    tree: TreeNodeDto[];
    fonts: string[];
    nodeOverrides: ImportOverride[];
}

interface PluginStateDto {
    version: string;
    vault: {
        hasToken: boolean;
        persistent: boolean;
        backend: string;
        warning?: string;
    };
    settings: ImportSettings;
    document: PluginDocumentDto | null;
}

export interface McpApiHost {
    projectPath: string;
    creatorVersion: string;
    getDocumentRevision(): number;
    isImportBusy(): boolean;
    getState(): Promise<PluginStateDto>;
    fetchDocument(sourceUrl: string): Promise<PluginDocumentDto>;
    getPreview(nodeId: string): Promise<{ url: string }>;
    saveSettings(value: unknown): Promise<ImportSettings>;
    patchSettings?(value: Partial<ImportSettings>): Promise<ImportSettings>;
    saveNodeOverrides(fileKey: unknown, overrides: unknown, scopeIds: unknown): Promise<ImportOverride[]>;
    patchNodeNames?(fileKey: string, patches: McpNodeNamePatch[]): Promise<ImportOverride[]>;
    importSelection(request: ImportRequest, operationId: string): Promise<unknown>;
    cancelImport(operationId: string): boolean;
}

export interface McpNodeNamePatch {
    id: string;
    name: string | null;
    fallback: ImportOverride;
}

interface ActiveMcpDocument {
    id: string;
    hostRevision: number;
    revision: number;
    fileKey: string;
    sourceUrl: string;
    rootIds: Set<string>;
}

interface ActiveMcpImport {
    operationId: string;
    documentSessionId: string;
    requestFingerprint: string;
}

interface CompletedMcpImport extends ActiveMcpImport {
    response: unknown;
}

function publicSettings(settings: ImportSettings): Record<string, unknown> {
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

export interface IndexedTreeNode {
    node: TreeNodeDto;
    parentNodeId?: string;
    depth: number;
    path: string[];
}

const IMPORT_ACTIONS = new Set<ImportAction>(['ignore', 'generate', 'render', 'transform']);
const NODE_KINDS = new Set<NodeKind>([
    'auto',
    'node',
    'sprite',
    'label',
    'richText',
    'button',
    'scrollView',
    'layout',
]);

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new McpBridgeError('INVALID_REQUEST', '工具参数必须是对象。');
    }
    return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength = 2048): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new McpBridgeError('INVALID_REQUEST', `${label} 不能为空。`);
    }
    const result = value.trim();
    if (result.length > maxLength) {
        throw new McpBridgeError('INVALID_REQUEST', `${label} 超过 ${maxLength} 字符限制。`);
    }
    return result;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new McpBridgeError('INVALID_REQUEST', `${label} 必须是字符串数组。`);
    }
    return value as string[];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new McpBridgeError('INVALID_REQUEST', `${label} 必须是 ${min}–${max} 之间的整数。`);
    }
    return value;
}

function encodeCursor(sessionId: string, revision: number, offset: number, queryHash: string): string {
    return Buffer.from(JSON.stringify({ sessionId, revision, offset, queryHash }), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, sessionId: string, revision: number, queryHash: string): number {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value !== 'string' || value.length > 512) {
        throw new McpBridgeError('INVALID_CURSOR', '分页 cursor 无效。');
    }
    try {
        const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (decoded.sessionId !== sessionId || decoded.revision !== revision || decoded.queryHash !== queryHash
            || typeof decoded.offset !== 'number' || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
            throw new Error('cursor mismatch');
        }
        return decoded.offset;
    } catch {
        throw new McpBridgeError('INVALID_CURSOR', '分页 cursor 已失效，请从第一页重新查询。');
    }
}

function stableHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function settingsFingerprint(settings: ImportSettings): Record<string, unknown> {
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

function importRequestFingerprint(
    document: PluginDocumentDto,
    settings: ImportSettings,
    overrides: ImportOverride[],
): string {
    return stableHash({
        fileKey: document.fileKey,
        sourceUrl: document.sourceUrl,
        settings: settingsFingerprint(settings),
        overrides: overrides.map((item) => ({
            id: item.id,
            action: item.action,
            kind: item.kind,
            nineSlice: item.nineSlice,
            explicit: item.explicit === true,
            name: item.name ?? null,
        })),
    });
}

function safeRelativeAssetFolder(value: unknown, label: string): string {
    const folder = requiredString(value, label, 256).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (isAbsolute(folder) || folder.startsWith('/') || folder.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new McpBridgeError('INVALID_SETTINGS', `${label} 必须是 assets 下的相对子目录。`);
    }
    return folder;
}

export function indexTree(roots: TreeNodeDto[]): IndexedTreeNode[] {
    const result: IndexedTreeNode[] = [];
    const visit = (node: TreeNodeDto, parentNodeId: string | undefined, depth: number, path: string[]) => {
        const nextPath = [...path, node.name];
        result.push({ node, parentNodeId, depth, path: nextPath });
        node.children.forEach((child) => visit(child, node.id, depth + 1, nextPath));
    };
    roots.forEach((root) => visit(root, undefined, 0, []));
    return result;
}

function defaultOverride(node: TreeNodeDto): ImportOverride {
    return {
        id: node.id,
        action: smartActionForNode(node),
        kind: node.kind,
        nineSlice: node.patchCandidate,
        explicit: false,
    };
}

function overrideMap(document: PluginDocumentDto): Map<string, ImportOverride> {
    return new Map(document.nodeOverrides.map((item) => [item.id, { ...item }]));
}

function resolvedImportOverrides(document: PluginDocumentDto): ImportOverride[] {
    const nodes = indexTree(document.tree).map((item) => item.node);
    const saved = overrideMap(document);
    const preferredActions = new Map<string, ImportAction>();
    const forcedRenderIds = new Set<string>();
    for (const node of nodes) {
        const current = saved.get(node.id);
        preferredActions.set(
            node.id,
            current?.explicit === true ? normalizeImportAction(current.action) : smartActionForNode(node),
        );
        const nineSlice = current?.explicit === true ? current.nineSlice : node.patchCandidate;
        if (nineSlice && node.patchCandidate) forcedRenderIds.add(node.id);
    }
    const effective = resolveEffectiveActions(document.tree, preferredActions, forcedRenderIds);
    return nodes.map((node) => {
        const current = saved.get(node.id);
        return {
            id: node.id,
            action: effective.actions.get(node.id) ?? smartActionForNode(node),
            kind: current?.explicit === true ? current.kind : node.kind,
            nineSlice: current?.explicit === true ? current.nineSlice : node.patchCandidate,
            explicit: current?.explicit === true,
            ...(current?.name ? { name: current.name } : {}),
        };
    });
}

function summarizeImportResult(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { completed: true };
    }
    const result = value as Record<string, unknown>;
    const summary: Record<string, unknown> = { completed: true };
    if (typeof result.created === 'number' && Number.isFinite(result.created)) summary.created = result.created;
    if (typeof result.updated === 'number' && Number.isFinite(result.updated)) summary.updated = result.updated;
    if (typeof result.prefabUrl === 'string') summary.prefabUrl = result.prefabUrl;
    if (typeof result.temporaryRoot === 'boolean') summary.temporaryRoot = result.temporaryRoot;
    if (Array.isArray(result.warnings)) {
        summary.warnings = result.warnings
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 100)
            .map((item) => item.slice(0, 512));
    }
    return summary;
}

export class FigmaImporterMcpApi {
    private session: ActiveMcpDocument | null = null;
    private activeImport: ActiveMcpImport | null = null;
    private importCancellationRequested = false;
    private readonly completedImports = new Map<string, CompletedMcpImport>();
    private settingsWriteQueue: Promise<void> = Promise.resolve();

    constructor(private readonly host: McpApiHost) {}

    async invoke(method: McpBridgeMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
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
            default: throw new McpBridgeError('METHOD_NOT_ALLOWED', '该 Bridge 方法未开放。');
        }
    }

    private async getStatus(): Promise<unknown> {
        const state = await this.host.getState();
        const sessionValid = Boolean(this.session
            && this.session.hostRevision === this.host.getDocumentRevision()
            && state.document?.fileKey === this.session.fileKey);
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
                documentSessionId: sessionValid ? this.session?.id : undefined,
            } : null,
        };
    }

    private async fetchDocument(params: unknown): Promise<unknown> {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', '当前已有操作正在执行，请等待或先取消。', true);
        }
        const input = record(params);
        const sourceUrl = requiredString(input.sourceUrl, 'sourceUrl');
        const state = await this.host.getState();
        if (!state.vault.hasToken) {
            throw new McpBridgeError('TOKEN_NOT_CONFIGURED', '尚未配置 Figma Personal Access Token。');
        }
        try {
            parseFigmaSource(sourceUrl);
        } catch {
            throw new McpBridgeError('INVALID_FIGMA_SOURCE', '仅支持有效的 figma.com 文件、设计、原型或 FigJam 链接。');
        }
        const document = await this.host.fetchDocument(sourceUrl);
        const id = randomBytes(18).toString('base64url');
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

    private async currentDocument(params: Record<string, unknown>): Promise<{ session: ActiveMcpDocument; document: PluginDocumentDto; state: PluginStateDto }> {
        const sessionId = requiredString(params.documentSessionId, 'documentSessionId', 256);
        const session = this.session;
        if (!session || session.id !== sessionId || session.hostRevision !== this.host.getDocumentRevision()) {
            throw new McpBridgeError('STALE_DOCUMENT_SESSION', '文档会话已失效，请重新读取 Figma 链接。');
        }
        const state = await this.host.getState();
        const document = state.document;
        if (!document || document.fileKey !== session.fileKey || document.sourceUrl !== session.sourceUrl) {
            throw new McpBridgeError('STALE_DOCUMENT_SESSION', '当前插件文档已变化，请重新读取 Figma 链接。');
        }
        return { session, document, state };
    }

    private async listNodes(params: unknown): Promise<unknown> {
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item]));
        const rootNodeId = typeof input.rootNodeId === 'string' && input.rootNodeId.trim()
            ? input.rootNodeId.trim()
            : undefined;
        const rootItem = rootNodeId ? byId.get(rootNodeId) : undefined;
        if (rootNodeId && !rootItem) throw new McpBridgeError('NODE_NOT_FOUND', `节点 ${rootNodeId} 不存在。`);
        const maxDepth = boundedInteger(input.depth, 8, 0, 32, 'depth');
        const limit = boundedInteger(input.limit, 50, 1, 200, 'limit');
        const search = typeof input.search === 'string' ? input.search.trim().toLocaleLowerCase() : '';
        const types = optionalStringArray(input.types, 'types');
        const actions = optionalStringArray(input.actions, 'actions');
        const kinds = optionalStringArray(input.kinds, 'kinds');
        const warningOnly = input.warningOnly === true;
        const overrides = overrideMap(document);
        const preferredActions = new Map<string, ImportAction>();
        const forcedRenderIds = new Set<string>();
        for (const item of all) {
            const saved = overrides.get(item.node.id);
            const preferred = saved?.explicit === true
                ? normalizeImportAction(saved.action)
                : smartActionForNode(item.node);
            preferredActions.set(
                item.node.id,
                preferred,
            );
            const nineSlice = saved?.explicit === true ? saved.nineSlice : item.node.patchCandidate;
            if (nineSlice && item.node.patchCandidate) {
                forcedRenderIds.add(item.node.id);
            }
        }
        const effective = resolveEffectiveActions(document.tree, preferredActions, forcedRenderIds);
        const rootDepth = rootItem?.depth ?? 0;
        const descendants = rootItem
            ? new Set(indexTree([rootItem.node]).map((item) => item.node.id))
            : null;
        const candidates = all.filter((item) => {
            if (descendants && !descendants.has(item.node.id)) return false;
            if (item.depth - rootDepth > maxDepth) return false;
            const saved = overrides.get(item.node.id);
            const cocosName = saved?.name ?? item.node.name;
            const action = effective.actions.get(item.node.id) ?? smartActionForNode(item.node);
            const kind = effectiveKindForNode(
                item.node,
                saved?.explicit === true ? saved.kind : item.node.kind,
                action,
                saved?.explicit === true ? saved.nineSlice : item.node.patchCandidate,
            );
            if (search && !`${item.node.name}\n${cocosName}\n${item.path.join('/')}`.toLocaleLowerCase().includes(search)) return false;
            if (types && !types.includes(item.node.type)) return false;
            if (actions && !actions.includes(action)) return false;
            if (kinds && !kinds.includes(kind)) return false;
            if (warningOnly && !item.node.warning) return false;
            return true;
        });
        const queryHash = stableHash({
            rootNodeId: rootNodeId ?? null,
            search,
            types: types ? [...types].sort() : null,
            actions: actions ? [...actions].sort() : null,
            kinds: kinds ? [...kinds].sort() : null,
            warningOnly,
            depth: maxDepth,
            limit,
            overrides: [...document.nodeOverrides]
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((item) => ({
                    id: item.id,
                    action: item.action,
                    kind: item.kind,
                    nineSlice: item.nineSlice,
                    explicit: item.explicit === true,
                    name: item.name ?? null,
                })),
        });
        const offset = decodeCursor(input.cursor, session.id, session.revision, queryHash);
        const page = candidates.slice(offset, offset + limit);
        const nodes = page.map((item) => {
            const saved = overrides.get(item.node.id);
            const preferredAction = preferredActions.get(item.node.id) ?? smartActionForNode(item.node);
            const action = effective.actions.get(item.node.id) ?? preferredAction;
            const nineSlice = saved?.explicit === true ? saved.nineSlice : item.node.patchCandidate;
            return {
                nodeId: item.node.id,
                parentNodeId: item.parentNodeId,
                depth: item.depth - rootDepth,
                path: item.path.join('/'),
                figmaName: item.node.name,
                cocosName: saved?.name ?? item.node.name,
                renamed: Boolean(saved?.name && saved.name !== item.node.name),
                type: item.node.type,
                visible: item.node.visible,
                width: item.node.width,
                height: item.node.height,
                childCount: item.node.children.length,
                preferredAction,
                action,
                kind: effectiveKindForNode(
                    item.node,
                    saved?.explicit === true ? saved.kind : item.node.kind,
                    action,
                    nineSlice,
                ),
                nineSlice,
                explicit: saved?.explicit === true,
                suppressed: effective.suppressed.has(item.node.id),
                patchCandidate: item.node.patchCandidate,
                sliceMode: item.node.sliceMode,
                reason: saved?.explicit === true ? 'user-override' : item.node.reason,
                fold: saved?.explicit === true || Boolean(saved?.name) ? undefined : item.node.fold,
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

    private async getPreview(params: unknown): Promise<unknown> {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', '当前已有操作正在执行，请等待或先取消。', true);
        }
        const input = record(params);
        const { document } = await this.currentDocument(input);
        const nodeId = requiredString(input.nodeId, 'nodeId', 256);
        if (!indexTree(document.tree).some((item) => item.node.id === nodeId)) {
            throw new McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
        }
        return this.host.getPreview(nodeId);
    }

    private buildSettings(
        document: PluginDocumentDto,
        state: PluginStateDto,
        value: unknown,
    ): { patch: Partial<ImportSettings>; settings: ImportSettings } {
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
            throw new McpBridgeError('INVALID_SETTINGS', 'settings 必须包含至少一个受支持的设置字段。');
        }
        const normalized: Partial<ImportSettings> = { sourceUrl: document.sourceUrl };
        const settings: ImportSettings = {
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
                throw new McpBridgeError('INVALID_SETTINGS', 'scale 必须是 0.25–4 之间的数字。');
            }
            settings.scale = patch.scale;
            normalized.scale = patch.scale;
        }
        for (const key of ['updateExisting', 'refreshAssets', 'autoSave'] as const) {
            if (patch[key] !== undefined) {
                if (typeof patch[key] !== 'boolean') throw new McpBridgeError('INVALID_SETTINGS', `${key} 必须是布尔值。`);
                settings[key] = patch[key];
                normalized[key] = patch[key];
            }
        }
        if (patch.fontMap !== undefined) {
            if (!patch.fontMap || typeof patch.fontMap !== 'object' || Array.isArray(patch.fontMap)) {
                throw new McpBridgeError('INVALID_SETTINGS', 'fontMap 必须是对象。');
            }
            const fontMap: Record<string, string> = {};
            for (const [font, url] of Object.entries(patch.fontMap as Record<string, unknown>)) {
                if (!font.trim() || typeof url !== 'string' || (url && !url.startsWith('db://assets/'))) {
                    throw new McpBridgeError('INVALID_SETTINGS', 'fontMap 只能引用 db://assets 下的字体资源。');
                }
                fontMap[font.trim()] = url.trim();
            }
            settings.fontMap = fontMap;
            normalized.fontMap = fontMap;
        }
        return { patch: normalized, settings };
    }

    private applySettings(params: unknown, incrementRevision = true): Promise<ImportSettings> {
        const input = record(params);
        const operation = async () => {
            const { session, document, state } = await this.currentDocument(input);
            const built = this.buildSettings(document, state, input.settings);
            const saved = this.host.patchSettings
                ? await this.host.patchSettings(built.patch)
                : await this.host.saveSettings(built.settings);
            if (incrementRevision) session.revision += 1;
            return saved;
        };
        const result = this.settingsWriteQueue.then(operation);
        this.settingsWriteQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async updateSettings(params: unknown): Promise<unknown> {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', '导入执行期间不能修改设置。', true);
        }
        return publicSettings(await this.applySettings(params));
    }

    private async renameNodes(params: unknown): Promise<unknown> {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', '导入执行期间不能修改节点名称。', true);
        }
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
        if (!Array.isArray(input.renames) || !input.renames.length || input.renames.length > 500) {
            throw new McpBridgeError('INVALID_REQUEST', 'renames 必须包含 1–500 个改名项。');
        }
        const allowRootRename = input.allowRootRename === true;
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item.node]));
        const saved = overrideMap(document);
        const seen = new Set<string>();
        const values: ImportOverride[] = [];
        const patches: McpNodeNamePatch[] = [];
        const updated: Array<Record<string, unknown>> = [];
        for (const raw of input.renames) {
            const item = record(raw);
            const nodeId = requiredString(item.nodeId, 'nodeId', 256);
            if (seen.has(nodeId)) throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 重复出现。`);
            seen.add(nodeId);
            const node = byId.get(nodeId);
            if (!node) throw new McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
            if (session.rootIds.has(nodeId) && !allowRootRename) {
                throw new McpBridgeError(
                    'ROOT_RENAME_REQUIRES_CONFIRMATION',
                    `节点 ${nodeId} 是导入根；改名会改变链接 Frame 的 Prefab 文件名，请设置 allowRootRename=true 明确确认。`,
                );
            }
            const current = { ...(saved.get(nodeId) ?? defaultOverride(node)) };
            let cocosName = node.name;
            if (item.name === null) {
                delete current.name;
                patches.push({ id: nodeId, name: null, fallback: current });
            } else {
                const name = sanitizeNodeName(item.name);
                if (!name) throw new McpBridgeError('INVALID_NODE_NAME', `节点 ${nodeId} 的名称清洗后为空。`);
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
        } else {
            await this.host.saveNodeOverrides(document.fileKey, values, [...seen]);
        }
        session.revision += 1;
        return { updated };
    }

    private async updateNodes(params: unknown): Promise<unknown> {
        if (this.activeImport || this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', '导入执行期间不能修改节点策略。', true);
        }
        const input = record(params);
        const { session, document } = await this.currentDocument(input);
        if (!Array.isArray(input.updates) || !input.updates.length || input.updates.length > 500) {
            throw new McpBridgeError('INVALID_REQUEST', 'updates 必须包含 1–500 个节点设置。');
        }
        const allowRootRename = input.allowRootRename === true;
        const all = indexTree(document.tree);
        const byId = new Map(all.map((item) => [item.node.id, item.node]));
        const saved = overrideMap(document);
        const seen = new Set<string>();
        const values: ImportOverride[] = [];
        for (const raw of input.updates) {
            const item = record(raw);
            const nodeId = requiredString(item.nodeId, 'nodeId', 256);
            if (seen.has(nodeId)) throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 重复出现。`);
            seen.add(nodeId);
            const node = byId.get(nodeId);
            if (!node) throw new McpBridgeError('NODE_NOT_FOUND', `节点 ${nodeId} 不存在。`);
            const current = { ...(saved.get(nodeId) ?? defaultOverride(node)) };
            let strategyChanged = false;
            if (item.action !== undefined) {
                if (!IMPORT_ACTIONS.has(item.action as ImportAction)) throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 action 无效。`);
                current.action = item.action as ImportAction;
                strategyChanged = true;
            }
            if (item.kind !== undefined) {
                if (!NODE_KINDS.has(item.kind as NodeKind)) throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 kind 无效。`);
                current.kind = item.kind as NodeKind;
                strategyChanged = true;
            }
            if (item.nineSlice !== undefined) {
                if (typeof item.nineSlice !== 'boolean') throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 的 nineSlice 必须是布尔值。`);
                current.nineSlice = item.nineSlice;
                strategyChanged = true;
            }
            if (item.name !== undefined) {
                if (session.rootIds.has(nodeId) && !allowRootRename) {
                    throw new McpBridgeError('ROOT_RENAME_REQUIRES_CONFIRMATION', `节点 ${nodeId} 是导入根，请明确允许根节点改名。`);
                }
                if (item.name === null) delete current.name;
                else {
                    const name = sanitizeNodeName(item.name);
                    if (!name) throw new McpBridgeError('INVALID_NODE_NAME', `节点 ${nodeId} 的名称清洗后为空。`);
                    current.name = name;
                }
            }
            if (!strategyChanged && item.name === undefined) {
                throw new McpBridgeError('INVALID_REQUEST', `节点 ${nodeId} 没有提供任何修改。`);
            }
            if (strategyChanged) current.explicit = true;
            values.push(current);
        }
        const persisted = await this.host.saveNodeOverrides(document.fileKey, values, [...seen]);
        session.revision += 1;
        return { updated: persisted };
    }

    private async importDocument(params: unknown, signal?: AbortSignal): Promise<unknown> {
        const input = record(params);
        const { session, document, state } = await this.currentDocument(input);
        const operationId = requiredString(input.operationId, 'operationId', 128);
        if (operationId.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
            throw new McpBridgeError('INVALID_REQUEST', 'operationId 至少 8 个字符，且只能包含字母、数字、点、下划线、冒号和连字符。');
        }
        if (input.confirm !== true) {
            throw new McpBridgeError('CONFIRMATION_REQUIRED', '导入会修改 Cocos 项目；请设置 confirm=true 明确确认。');
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
                throw new McpBridgeError('OPERATION_ID_CONFLICT', '该 operationId 已用于不同的文档、设置或节点策略。请为新导入生成新的 operationId。');
            }
            return completed.response;
        }
        if (this.activeImport) {
            if (this.activeImport.operationId === operationId
                && this.activeImport.documentSessionId === session.id
                && this.activeImport.requestFingerprint === requestFingerprint) {
                throw new McpBridgeError('OPERATION_IN_PROGRESS', '该 operationId 的导入仍在执行，请等待原调用返回。', true);
            }
            if (this.activeImport.operationId === operationId) {
                throw new McpBridgeError('OPERATION_ID_CONFLICT', '该 operationId 当前绑定的是另一组导入参数。');
            }
            throw new McpBridgeError('BUSY', '当前已有导入正在执行。', true);
        }
        if (this.host.isImportBusy()) {
            throw new McpBridgeError('BUSY', 'Cocos 插件当前有其他操作正在执行。', true);
        }
        if (signal?.aborted) throw new McpBridgeError('CANCELLED', 'MCP 调用已取消，导入尚未开始。');
        this.activeImport = {
            operationId,
            documentSessionId: session.id,
            requestFingerprint,
        };
        this.importCancellationRequested = false;
        const cancelForSignal = () => {
            const active = this.activeImport;
            if (!active || active.operationId !== operationId || active.documentSessionId !== session.id) return;
            this.importCancellationRequested = true;
            this.host.cancelImport(operationId);
        };
        signal?.addEventListener('abort', cancelForSignal, { once: true });
        try {
            if (input.settings !== undefined) {
                await this.applySettings({
                    documentSessionId: input.documentSessionId,
                    settings: input.settings,
                }, false);
            }
            const latest = await this.host.getState();
            if (this.importCancellationRequested) {
                throw new McpBridgeError('CANCELLED', '导入已取消。');
            }
            if (session.hostRevision !== this.host.getDocumentRevision()
                || latest.document?.fileKey !== document.fileKey
                || latest.document.sourceUrl !== document.sourceUrl) {
                throw new McpBridgeError('STALE_DOCUMENT_SESSION', '导入前文档已变化，请重新读取 Figma 链接。');
            }
            if (this.host.isImportBusy()) {
                throw new McpBridgeError('BUSY', 'Cocos 插件在导入准备期间启动了其他操作，请等待后重试同一 operationId。', true);
            }
            const overrides = resolvedImportOverrides(latest.document);
            const latestFingerprint = importRequestFingerprint(latest.document, latest.settings, overrides);
            if (latestFingerprint !== requestFingerprint) {
                throw new McpBridgeError(
                    'STALE_OPERATION_REQUEST',
                    '导入准备期间设置或节点策略发生变化；本次没有执行导入。请复查后重试同一 operationId。',
                    true,
                );
            }
            try {
                const result = summarizeImportResult(await this.host.importSelection(
                    { overrides, settings: latest.settings },
                    operationId,
                ));
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
                    const oldest = this.completedImports.keys().next().value as string | undefined;
                    if (!oldest) break;
                    this.completedImports.delete(oldest);
                }
                return response;
            } catch (error) {
                if (this.importCancellationRequested) {
                    throw new McpBridgeError(
                        'CANCELLED',
                        '取消请求已发送；资源或 Scene 的不可中断步骤可能已完成。请先检查 Cocos 当前结果，再决定是否使用新的 operationId 重试。',
                    );
                }
                throw error;
            }
        } finally {
            signal?.removeEventListener('abort', cancelForSignal);
            if (this.activeImport?.operationId === operationId) this.activeImport = null;
            this.importCancellationRequested = false;
        }
    }

    private cancelImport(params: unknown): unknown {
        const input = record(params);
        const documentSessionId = requiredString(input.documentSessionId, 'documentSessionId', 256);
        const operationId = requiredString(input.operationId, 'operationId', 128);
        if (operationId.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
            throw new McpBridgeError('INVALID_REQUEST', 'operationId 格式无效。');
        }
        const active = this.activeImport;
        if (!active || active.operationId !== operationId || active.documentSessionId !== documentSessionId) {
            const completed = this.completedImports.get(operationId);
            return {
                cancellationRequested: false,
                operationId,
                reason: completed?.documentSessionId === documentSessionId
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
