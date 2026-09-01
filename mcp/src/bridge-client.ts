import { randomUUID } from 'crypto';
import { createConnection } from 'net';
import { isAbsolute, resolve } from 'path';
import { readMcpBridgeDescriptors } from '../../source/mcp-bridge/discovery';
import {
    MCP_BRIDGE_MAX_FRAME_BYTES,
    MCP_BRIDGE_PROTOCOL_VERSION,
    McpBridgeError,
    type McpBridgeMethod,
    type McpBridgeRequest,
    type McpBridgeResponse,
    type McpBridgeSessionDescriptor,
} from '../../source/mcp-bridge/protocol';

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const DEFAULT_FIGMA_TIMEOUT_MS = 120_000;
const MIN_BRIDGE_TIMEOUT_MS = 250;
const MAX_BRIDGE_TIMEOUT_MS = 900_000;
const SESSION_FAILURE_CODES = new Set([
    'BRIDGE_CONNECTION_FAILED',
    'BRIDGE_CONNECTION_CLOSED',
    'BRIDGE_PROTOCOL_ERROR',
    'BRIDGE_UNAUTHORIZED',
]);

export interface BridgeInvoker {
    call(method: McpBridgeMethod, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface McpBridgeClientOptions {
    projectPath?: string;
    timeoutMs?: number;
    readDescriptors?: () => Promise<McpBridgeSessionDescriptor[]>;
    isProcessRunning?: (pid: number) => boolean;
    request?: typeof sendBridgeRequest;
}

export interface SafeBridgeSessionSummary {
    pid: number;
    projectPath: string;
    pluginVersion: string;
    pluginInstanceId: string;
    startedAt: string;
}

function safeSessionSummary(descriptor: McpBridgeSessionDescriptor): SafeBridgeSessionSummary {
    return {
        pid: descriptor.pid,
        projectPath: descriptor.projectPath,
        pluginVersion: descriptor.pluginVersion,
        pluginInstanceId: descriptor.pluginInstanceId,
        startedAt: descriptor.startedAt,
    };
}

export function normalizeProjectPath(projectPath: string, platform = process.platform): string {
    const normalized = resolve(projectPath);
    return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function processIsRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;
        return code === 'EPERM';
    }
}

export function selectBridgeSession(
    descriptors: readonly McpBridgeSessionDescriptor[],
    projectPath?: string,
    platform = process.platform,
): McpBridgeSessionDescriptor {
    const requestedProject = projectPath ? normalizeProjectPath(projectPath, platform) : undefined;
    const newestByProcessAndProject = new Map<string, McpBridgeSessionDescriptor>();
    for (const descriptor of descriptors) {
        const key = `${normalizeProjectPath(descriptor.projectPath, platform)}\0${descriptor.pid}`;
        const current = newestByProcessAndProject.get(key);
        if (!current || Date.parse(descriptor.startedAt) > Date.parse(current.startedAt)) {
            newestByProcessAndProject.set(key, descriptor);
        }
    }
    const liveSessions = [...newestByProcessAndProject.values()];
    const candidates = requestedProject
        ? liveSessions.filter((descriptor) => normalizeProjectPath(descriptor.projectPath, platform) === requestedProject)
        : liveSessions;

    if (!candidates.length) {
        if (requestedProject && liveSessions.length) {
            throw new McpBridgeError(
                'COCOS_PROJECT_NOT_FOUND',
                `未发现项目 ${resolve(projectPath as string)} 的 Figma Importer Bridge。`,
                false,
                { availableSessions: liveSessions.map(safeSessionSummary) },
            );
        }
        throw new McpBridgeError(
            'COCOS_NOT_RUNNING',
            '未发现正在运行的 Figma Importer 插件。请打开 Cocos Creator 项目并启用插件。',
            true,
        );
    }

    if (candidates.length > 1) {
        throw new McpBridgeError(
            'MULTIPLE_COCOS_PROJECTS',
            projectPath
                ? `项目 ${resolve(projectPath)} 同时存在多个 Creator Bridge，请关闭多余实例后重试。`
                : '发现多个正在运行的 Cocos Creator 项目，请使用 --project 指定项目绝对路径。',
            false,
            { availableSessions: candidates.map(safeSessionSummary) },
        );
    }

    return candidates[0];
}

function validatedTimeout(timeoutMs: number | undefined): number {
    const value = timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    if (!Number.isInteger(value) || value < MIN_BRIDGE_TIMEOUT_MS || value > MAX_BRIDGE_TIMEOUT_MS) {
        throw new McpBridgeError(
            'INVALID_CLIENT_OPTIONS',
            `Bridge timeout 必须是 ${MIN_BRIDGE_TIMEOUT_MS}–${MAX_BRIDGE_TIMEOUT_MS} 毫秒之间的整数。`,
        );
    }
    return value;
}

function timeoutForMethod(method: McpBridgeMethod, configuredTimeoutMs: number): number {
    if (method === 'importDocument') {
        // A local timeout after Cocos has started writing would make the result
        // ambiguous and invite a duplicate retry. Import stays connected until
        // it finishes or is cancelled through a separate Bridge request.
        return 0;
    }
    if (method === 'fetchDocument' || method === 'getPreview') {
        return Math.max(configuredTimeoutMs, DEFAULT_FIGMA_TIMEOUT_MS);
    }
    return configuredTimeoutMs;
}

function parseBridgeResponse(line: string, requestId: string): McpBridgeResponse {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new McpBridgeError('BRIDGE_PROTOCOL_ERROR', 'Cocos Bridge 返回了无效 JSON。', true);
    }
    if (!value || typeof value !== 'object') {
        throw new McpBridgeError('BRIDGE_PROTOCOL_ERROR', 'Cocos Bridge 响应不是对象。', true);
    }
    const response = value as Partial<McpBridgeResponse> & {
        error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    };
    if (response.v !== MCP_BRIDGE_PROTOCOL_VERSION || response.id !== requestId || typeof response.ok !== 'boolean') {
        throw new McpBridgeError('BRIDGE_PROTOCOL_ERROR', 'Cocos Bridge 响应字段无效或协议版本不匹配。', true);
    }
    if (!response.ok) {
        if (!response.error || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') {
            throw new McpBridgeError('BRIDGE_PROTOCOL_ERROR', 'Cocos Bridge 错误响应字段无效。', true);
        }
        throw new McpBridgeError(
            response.error.code,
            response.error.message,
            response.error.retryable === true,
            response.error.details,
        );
    }
    return response as McpBridgeResponse;
}

export async function sendBridgeRequest(
    descriptor: McpBridgeSessionDescriptor,
    method: McpBridgeMethod,
    params: unknown,
    timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<unknown> {
    if (signal?.aborted) throw new McpBridgeError('CANCELLED', 'MCP 工具调用已取消。');
    const request: McpBridgeRequest = {
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id: randomUUID(),
        authToken: descriptor.authToken,
        method,
        params,
    };
    let frame: string;
    try {
        frame = `${JSON.stringify(request)}\n`;
    } catch {
        throw new McpBridgeError('INVALID_REQUEST', '工具参数无法序列化为 Bridge 请求。');
    }
    if (Buffer.byteLength(frame, 'utf8') > MCP_BRIDGE_MAX_FRAME_BYTES) {
        throw new McpBridgeError(
            'FRAME_TOO_LARGE',
            `Bridge 请求超过 ${MCP_BRIDGE_MAX_FRAME_BYTES} 字节限制。请缩小批量操作。`,
        );
    }

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
        const socket = createConnection(descriptor.endpoint);
        socket.setEncoding('utf8');
        socket.setNoDelay(true);
        if (timeoutMs !== 0) socket.setTimeout(validatedTimeout(timeoutMs));
        let settled = false;
        let buffer = '';

        const settle = (error?: unknown, result?: unknown) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
            if (error !== undefined) rejectPromise(error);
            else resolvePromise(result);
        };
        const onAbort = () => settle(new McpBridgeError('CANCELLED', 'MCP 工具调用已取消。'));
        signal?.addEventListener('abort', onAbort, { once: true });

        socket.once('connect', () => socket.write(frame));
        socket.on('data', (chunk: string | Buffer) => {
            buffer += chunk.toString();
            if (Buffer.byteLength(buffer, 'utf8') > MCP_BRIDGE_MAX_FRAME_BYTES) {
                settle(new McpBridgeError(
                    'FRAME_TOO_LARGE',
                    `Cocos Bridge 响应超过 ${MCP_BRIDGE_MAX_FRAME_BYTES} 字节限制。`,
                ));
                return;
            }
            const boundary = buffer.indexOf('\n');
            if (boundary < 0) return;
            const line = buffer.slice(0, boundary).trim();
            if (!line) {
                settle(new McpBridgeError('BRIDGE_PROTOCOL_ERROR', 'Cocos Bridge 返回了空响应。', true));
                return;
            }
            try {
                const response = parseBridgeResponse(line, request.id);
                settle(undefined, response.ok ? response.result : undefined);
            } catch (error) {
                settle(error);
            }
        });
        socket.once('timeout', () => settle(new McpBridgeError(
            'BRIDGE_TIMEOUT',
            `Cocos Bridge 在 ${timeoutMs} 毫秒内没有响应。`,
            true,
        )));
        socket.once('error', (error) => settle(new McpBridgeError(
            'BRIDGE_CONNECTION_FAILED',
            '无法连接 Cocos Bridge。请确认目标 Creator 项目和插件仍在运行。',
            true,
        )));
        socket.once('close', () => {
            if (!settled) {
                settle(new McpBridgeError('BRIDGE_CONNECTION_CLOSED', 'Cocos Bridge 在返回结果前关闭了连接。', true));
            }
        });
    });
}

export class McpBridgeClient implements BridgeInvoker {
    private pinnedProjectPath?: string;
    private readonly timeoutMs: number;
    private readonly readDescriptors: () => Promise<McpBridgeSessionDescriptor[]>;
    private readonly isProcessRunning: (pid: number) => boolean;
    private readonly request: typeof sendBridgeRequest;
    private selectedSessionPromise?: Promise<McpBridgeSessionDescriptor>;

    constructor(options: McpBridgeClientOptions = {}) {
        if (options.projectPath && !isAbsolute(options.projectPath)) {
            throw new McpBridgeError('INVALID_CLIENT_OPTIONS', '--project 必须是 Cocos 项目根目录的绝对路径。');
        }
        this.pinnedProjectPath = options.projectPath ? resolve(options.projectPath) : undefined;
        this.timeoutMs = validatedTimeout(options.timeoutMs);
        this.readDescriptors = options.readDescriptors ?? readMcpBridgeDescriptors;
        this.isProcessRunning = options.isProcessRunning ?? processIsRunning;
        this.request = options.request ?? sendBridgeRequest;
    }

    async selectedSession(): Promise<McpBridgeSessionDescriptor> {
        if (!this.selectedSessionPromise) {
            this.selectedSessionPromise = this.discoverSession();
        }
        const pending = this.selectedSessionPromise;
        try {
            return await pending;
        } catch (error) {
            if (this.selectedSessionPromise === pending) this.selectedSessionPromise = undefined;
            throw error;
        }
    }

    private async discoverSession(): Promise<McpBridgeSessionDescriptor> {
        const descriptors = await this.readDescriptors();
        const live = descriptors.filter((descriptor) => this.isProcessRunning(descriptor.pid));
        const selected = selectBridgeSession(live, this.pinnedProjectPath);
        if (!this.pinnedProjectPath) this.pinnedProjectPath = resolve(selected.projectPath);
        return selected;
    }

    async call(method: McpBridgeMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
        const descriptor = await this.selectedSession();
        try {
            return await this.request(
                descriptor,
                method,
                params,
                timeoutForMethod(method, this.timeoutMs),
                signal,
            );
        } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error
                ? (error as { code?: unknown }).code
                : undefined;
            if (typeof code === 'string' && SESSION_FAILURE_CODES.has(code)) {
                this.selectedSessionPromise = undefined;
            }
            throw error;
        }
    }
}
