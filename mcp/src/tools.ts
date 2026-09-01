import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpBridgeMethod } from '../../source/mcp-bridge/protocol';
import type { BridgeInvoker } from './bridge-client';
import { errorToolResult, successToolResult } from './responses';
import {
    CancelImportInputSchema,
    CancelImportOutputSchema,
    FetchDocumentInputSchema,
    FetchDocumentOutputSchema,
    GetPreviewInputSchema,
    GetPreviewOutputSchema,
    GetStatusInputSchema,
    GetStatusOutputSchema,
    ImportDocumentInputSchema,
    ImportDocumentOutputSchema,
    ListNodesInputSchema,
    ListNodesOutputSchema,
    RenameNodesInputSchema,
    RenameNodesOutputSchema,
    UpdateNodesInputSchema,
    UpdateNodesOutputSchema,
    UpdateSettingsInputSchema,
    UpdateSettingsOutputSchema,
} from './schemas';

export const FIGMA_IMPORTER_TOOL_NAMES = [
    'figma_importer_get_status',
    'figma_importer_fetch_document',
    'figma_importer_list_nodes',
    'figma_importer_get_preview',
    'figma_importer_update_settings',
    'figma_importer_update_nodes',
    'figma_importer_rename_nodes',
    'figma_importer_import',
    'figma_importer_cancel_import',
] as const;

export type FigmaImporterToolName = typeof FIGMA_IMPORTER_TOOL_NAMES[number];

type Handler<Input> = (input: Input, extra?: { signal?: AbortSignal }) => Promise<CallToolResult>;

export interface FigmaImporterToolHandlers {
    figma_importer_get_status: Handler<z.infer<typeof GetStatusInputSchema>>;
    figma_importer_fetch_document: Handler<z.infer<typeof FetchDocumentInputSchema>>;
    figma_importer_list_nodes: Handler<z.infer<typeof ListNodesInputSchema>>;
    figma_importer_get_preview: Handler<z.infer<typeof GetPreviewInputSchema>>;
    figma_importer_update_settings: Handler<z.infer<typeof UpdateSettingsInputSchema>>;
    figma_importer_update_nodes: Handler<z.infer<typeof UpdateNodesInputSchema>>;
    figma_importer_rename_nodes: Handler<z.infer<typeof RenameNodesInputSchema>>;
    figma_importer_import: Handler<z.infer<typeof ImportDocumentInputSchema>>;
    figma_importer_cancel_import: Handler<z.infer<typeof CancelImportInputSchema>>;
}

async function invokeBridgeTool(
    bridge: BridgeInvoker,
    method: McpBridgeMethod,
    params: unknown,
    outputSchema: z.ZodType,
    signal?: AbortSignal,
): Promise<CallToolResult> {
    try {
        return successToolResult(await bridge.call(method, params, signal), outputSchema);
    } catch (error) {
        return errorToolResult(error);
    }
}

export function createFigmaImporterToolHandlers(bridge: BridgeInvoker): FigmaImporterToolHandlers {
    return {
        figma_importer_get_status: (input, extra) => invokeBridgeTool(bridge, 'getStatus', input, GetStatusOutputSchema, extra?.signal),
        figma_importer_fetch_document: (input, extra) => invokeBridgeTool(bridge, 'fetchDocument', input, FetchDocumentOutputSchema, extra?.signal),
        figma_importer_list_nodes: (input, extra) => invokeBridgeTool(bridge, 'listNodes', input, ListNodesOutputSchema, extra?.signal),
        figma_importer_get_preview: (input, extra) => invokeBridgeTool(bridge, 'getPreview', input, GetPreviewOutputSchema, extra?.signal),
        figma_importer_update_settings: (input, extra) => invokeBridgeTool(bridge, 'updateSettings', input, UpdateSettingsOutputSchema, extra?.signal),
        figma_importer_update_nodes: (input, extra) => invokeBridgeTool(bridge, 'updateNodes', input, UpdateNodesOutputSchema, extra?.signal),
        figma_importer_rename_nodes: (input, extra) => invokeBridgeTool(bridge, 'renameNodes', input, RenameNodesOutputSchema, extra?.signal),
        figma_importer_import: (input, extra) => invokeBridgeTool(bridge, 'importDocument', input, ImportDocumentOutputSchema, extra?.signal),
        figma_importer_cancel_import: (input, extra) => invokeBridgeTool(bridge, 'cancelImport', input, CancelImportOutputSchema, extra?.signal),
    };
}

const READ_ONLY_LOCAL: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

const READ_ONLY_FIXED_FIGMA_API: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // The Bridge calls the fixed Figma REST API with the token already stored
    // by the Cocos extension. It never opens or automates a browser.
    openWorldHint: false,
};

const FETCH_FIGMA_DOCUMENT: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

const IDEMPOTENT_LOCAL_WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

export function registerFigmaImporterTools(server: McpServer, bridge: BridgeInvoker): FigmaImporterToolHandlers {
    const handlers = createFigmaImporterToolHandlers(bridge);

    server.registerTool('figma_importer_get_status', {
        title: 'Get Figma Importer Status',
        description: '查询本地 Cocos Creator、Figma Importer 插件、Token、当前文档和导入忙碌状态。不会读取或返回 Token 明文。',
        inputSchema: GetStatusInputSchema,
        outputSchema: GetStatusOutputSchema,
        annotations: READ_ONLY_LOCAL,
    }, handlers.figma_importer_get_status);

    server.registerTool('figma_importer_fetch_document', {
        title: 'Fetch Figma Document',
        description: '通过 Cocos 插件和已配置的 API Token 直接读取 Figma 文件或指定 Frame，并创建后续工具所需的 documentSessionId；不会打开或控制浏览器。',
        inputSchema: FetchDocumentInputSchema,
        outputSchema: FetchDocumentOutputSchema,
        annotations: FETCH_FIGMA_DOCUMENT,
    }, handlers.figma_importer_fetch_document);

    server.registerTool('figma_importer_list_nodes', {
        title: 'List Figma Import Nodes',
        description: '分页搜索当前文档的节点，并返回 Figma/Cocos 名称、导入动作、组件类型、九宫状态、警告和折叠结果。',
        inputSchema: ListNodesInputSchema,
        outputSchema: ListNodesOutputSchema,
        annotations: READ_ONLY_LOCAL,
    }, handlers.figma_importer_list_nodes);

    server.registerTool('figma_importer_get_preview', {
        title: 'Get Figma Node Preview',
        description: '通过固定 Figma API 获取当前文档中一个节点的临时 PNG 预览 URL；不会打开或控制浏览器。',
        inputSchema: GetPreviewInputSchema,
        outputSchema: GetPreviewOutputSchema,
        annotations: READ_ONLY_FIXED_FIGMA_API,
    }, handlers.figma_importer_get_preview);

    server.registerTool('figma_importer_update_settings', {
        title: 'Update Import Settings',
        description: '更新当前文档的资源目录、Prefab 目录、倍率、更新策略、自动保存或字体映射。不会立即执行导入。',
        inputSchema: UpdateSettingsInputSchema,
        outputSchema: UpdateSettingsOutputSchema,
        annotations: IDEMPOTENT_LOCAL_WRITE,
    }, handlers.figma_importer_update_settings);

    server.registerTool('figma_importer_update_nodes', {
        title: 'Update Import Node Strategies',
        description: '批量修改节点的导入动作、Cocos 组件类型、九宫设置或名称覆盖。不会立即执行导入。',
        inputSchema: UpdateNodesInputSchema,
        outputSchema: UpdateNodesOutputSchema,
        annotations: IDEMPOTENT_LOCAL_WRITE,
    }, handlers.figma_importer_update_nodes);

    server.registerTool('figma_importer_rename_nodes', {
        title: 'Rename Cocos Nodes',
        description: '只批量修改导入后的 Cocos 节点名，不修改 Figma 原名、nodeId 或其他节点策略。传 null 可清除名称覆盖。',
        inputSchema: RenameNodesInputSchema,
        outputSchema: RenameNodesOutputSchema,
        annotations: IDEMPOTENT_LOCAL_WRITE,
    }, handlers.figma_importer_rename_nodes);

    server.registerTool('figma_importer_import', {
        title: 'Import Figma Document Into Cocos',
        description: '按当前设置和节点覆盖创建或更新 Cocos 资源与 Prefab。必须显式传 confirm=true 和唯一 operationId；调用超时后复查或重试时必须复用该 ID，避免重复导入。',
        inputSchema: ImportDocumentInputSchema,
        outputSchema: ImportDocumentOutputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, handlers.figma_importer_import);

    server.registerTool('figma_importer_cancel_import', {
        title: 'Cancel Active Figma Import',
        description: '按 documentSessionId 和 operationId 请求取消由本 MCP 发起的导入，不会取消面板或其他客户端的操作；不可中断的 Cocos 步骤可能仍会完成。',
        inputSchema: CancelImportInputSchema,
        outputSchema: CancelImportOutputSchema,
        annotations: IDEMPOTENT_LOCAL_WRITE,
    }, handlers.figma_importer_cancel_import);

    return handlers;
}
