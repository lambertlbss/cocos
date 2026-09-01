export const MCP_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const MCP_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024;
export const MCP_BRIDGE_SESSION_PREFIX = 'figma-importer-cocos';

export const MCP_BRIDGE_METHODS = [
    'getStatus',
    'fetchDocument',
    'listNodes',
    'getPreview',
    'updateSettings',
    'updateNodes',
    'renameNodes',
    'importDocument',
    'cancelImport',
] as const;

export type McpBridgeMethod = typeof MCP_BRIDGE_METHODS[number];

export interface McpBridgeRequest {
    v: typeof MCP_BRIDGE_PROTOCOL_VERSION;
    id: string;
    authToken: string;
    method: McpBridgeMethod;
    params: unknown;
}

export interface McpBridgeErrorData {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
}

export type McpBridgeResponse = {
    v: typeof MCP_BRIDGE_PROTOCOL_VERSION;
    id: string;
    ok: true;
    result: unknown;
} | {
    v: typeof MCP_BRIDGE_PROTOCOL_VERSION;
    id: string;
    ok: false;
    error: McpBridgeErrorData;
};

export interface McpBridgeSessionDescriptor {
    v: typeof MCP_BRIDGE_PROTOCOL_VERSION;
    pid: number;
    projectPath: string;
    projectHash: string;
    endpoint: string;
    authToken: string;
    pluginVersion: string;
    pluginInstanceId: string;
    startedAt: string;
}

export class McpBridgeError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable = false,
        readonly details?: unknown,
    ) {
        super(message);
        this.name = 'McpBridgeError';
    }
}

export function isMcpBridgeMethod(value: unknown): value is McpBridgeMethod {
    return typeof value === 'string'
        && (MCP_BRIDGE_METHODS as readonly string[]).includes(value);
}
