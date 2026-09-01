import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpBridgeError } from '../../source/mcp-bridge/protocol';

function nextStepForCode(code: string): string | undefined {
    switch (code) {
        case 'COCOS_NOT_RUNNING':
            return '打开目标 Cocos Creator 项目，并确认 Figma Importer 扩展已启用。';
        case 'COCOS_PROJECT_NOT_FOUND':
        case 'MULTIPLE_COCOS_PROJECTS':
            return '在 MCP 配置的 args 中添加 --project 和目标 Cocos 项目绝对路径。';
        case 'BRIDGE_CONNECTION_FAILED':
        case 'BRIDGE_CONNECTION_CLOSED':
        case 'BRIDGE_TIMEOUT':
            return '确认 Creator 仍在运行并重试一次；若插件刚重载且仍失败，再重启当前 MCP 进程。';
        case 'TOKEN_NOT_CONFIGURED':
            return '打开一次 Figma Importer 面板，保存并验证 Figma Personal Access Token。之后面板可以关闭。';
        case 'STALE_DOCUMENT_SESSION':
        case 'INVALID_CURSOR':
            return '重新调用 figma_importer_fetch_document，并使用新的 documentSessionId。';
        case 'CONFIRMATION_REQUIRED':
            return '确认导入目标后，重新调用并设置 confirm=true。';
        case 'ROOT_RENAME_REQUIRES_CONFIRMATION':
            return '确认 Prefab 文件名变化后，设置 allowRootRename=true。';
        case 'BUSY':
            return '等待当前操作完成；仅当你持有对应 documentSessionId 和 operationId 时才调用取消工具。';
        case 'STALE_OPERATION_REQUEST':
            return '重新检查当前设置和节点策略，然后用同一个 operationId 重试。';
        case 'OPERATION_ID_CONFLICT':
            return '为这组新文档、设置或节点策略生成一个新的 operationId。';
        default:
            return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function successToolResult(
    value: unknown,
    outputSchema: z.ZodType,
): CallToolResult {
    const parsed = outputSchema.safeParse(value);
    if (!parsed.success || !isRecord(parsed.data)) {
        throw new McpBridgeError(
            'BRIDGE_INVALID_RESULT',
            'Cocos Bridge 返回的数据与 MCP 工具输出协议不匹配。请确认插件和 MCP Server 来自同一版本。',
            false,
        );
    }
    const structuredContent = parsed.data;
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
        }],
        structuredContent,
    };
}

export function errorToolResult(error: unknown): CallToolResult {
    if (!(error instanceof McpBridgeError)) {
        console.error('Figma Importer MCP 内部错误：', error);
    }
    const bridgeError = error instanceof McpBridgeError
        ? error
        : new McpBridgeError(
            'MCP_INTERNAL_ERROR',
            'MCP Server 内部错误，请查看本地日志。',
        );
    const nextStep = nextStepForCode(bridgeError.code);
    return {
        isError: true,
        content: [{
            type: 'text',
            text: [
                `${bridgeError.code}: ${bridgeError.message}`,
                ...(nextStep ? [`下一步：${nextStep}`] : []),
                ...(bridgeError.retryable ? ['该错误可以重试。'] : []),
            ].join('\n'),
        }],
    };
}
