import { timingSafeEqual } from 'crypto';
import { createServer, type Server, type Socket } from 'net';
import {
    createMcpBridgeDescriptor,
    removeMcpBridgeDescriptor,
    writeMcpBridgeDescriptor,
} from './discovery';
import {
    isMcpBridgeMethod,
    MCP_BRIDGE_MAX_FRAME_BYTES,
    MCP_BRIDGE_PROTOCOL_VERSION,
    McpBridgeError,
    type McpBridgeRequest,
    type McpBridgeResponse,
    type McpBridgeSessionDescriptor,
    type McpBridgeMethod,
} from './protocol';

export type McpBridgeInvoker = (
    method: McpBridgeMethod,
    params: unknown,
    signal?: AbortSignal,
) => Promise<unknown>;

function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

function errorResponse(id: string, error: unknown): McpBridgeResponse {
    if (error instanceof McpBridgeError) {
        return {
            v: MCP_BRIDGE_PROTOCOL_VERSION,
            id,
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                ...(error.details === undefined ? {} : { details: error.details }),
            },
        };
    }
    return {
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id,
        ok: false,
        error: {
            code: 'COCOS_ERROR',
            message: 'Cocos 插件操作失败，请查看 Cocos Creator 日志。',
        },
    };
}

function writeResponse(socket: Socket, response: McpBridgeResponse): void {
    let frame = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(frame, 'utf8') > MCP_BRIDGE_MAX_FRAME_BYTES) {
        frame = `${JSON.stringify(errorResponse(response.id, new McpBridgeError(
            'FRAME_TOO_LARGE',
            `Bridge 响应超过 ${MCP_BRIDGE_MAX_FRAME_BYTES} 字节限制。请缩小查询范围。`,
        )))}\n`;
    }
    if (!socket.destroyed) socket.write(frame);
}

function parseRequest(line: string): McpBridgeRequest {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new McpBridgeError('INVALID_REQUEST', 'Bridge 请求不是有效 JSON。');
    }
    if (!value || typeof value !== 'object') {
        throw new McpBridgeError('INVALID_REQUEST', 'Bridge 请求必须是对象。');
    }
    const request = value as Partial<McpBridgeRequest>;
    if (request.v !== MCP_BRIDGE_PROTOCOL_VERSION
        || typeof request.id !== 'string' || !request.id || request.id.length > 128
        || typeof request.authToken !== 'string'
        || !isMcpBridgeMethod(request.method)) {
        throw new McpBridgeError('INVALID_REQUEST', 'Bridge 请求字段无效或协议版本不匹配。');
    }
    return request as McpBridgeRequest;
}

export class McpBridgeServer {
    private server: Server | null = null;
    private descriptor: McpBridgeSessionDescriptor | null = null;
    private readonly sockets = new Set<Socket>();

    constructor(private readonly options: {
        projectPath: string;
        pluginVersion: string;
        pluginInstanceId: string;
        invoke: McpBridgeInvoker;
    }) {}

    async start(): Promise<McpBridgeSessionDescriptor> {
        if (this.server && this.descriptor) return this.descriptor;
        const descriptor = createMcpBridgeDescriptor(this.options);
        await removeMcpBridgeDescriptor(descriptor);
        const server = createServer((socket) => this.accept(socket, descriptor));
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(descriptor.endpoint);
        });
        this.server = server;
        this.descriptor = descriptor;
        try {
            await writeMcpBridgeDescriptor(descriptor);
        } catch (error) {
            await this.close();
            throw error;
        }
        return descriptor;
    }

    private accept(socket: Socket, descriptor: McpBridgeSessionDescriptor): void {
        this.sockets.add(socket);
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            let boundary = buffer.indexOf('\n');
            while (boundary >= 0) {
                const line = buffer.slice(0, boundary).trim();
                buffer = buffer.slice(boundary + 1);
                if (Buffer.byteLength(line, 'utf8') > MCP_BRIDGE_MAX_FRAME_BYTES) {
                    socket.write(`${JSON.stringify(errorResponse('', new McpBridgeError(
                        'FRAME_TOO_LARGE',
                        `Bridge 请求超过 ${MCP_BRIDGE_MAX_FRAME_BYTES} 字节限制。`,
                    )))}\n`);
                    socket.destroy();
                    return;
                }
                if (line) void this.handleLine(socket, descriptor, line);
                boundary = buffer.indexOf('\n');
            }
            if (Buffer.byteLength(buffer, 'utf8') > MCP_BRIDGE_MAX_FRAME_BYTES) {
                socket.write(`${JSON.stringify(errorResponse('', new McpBridgeError(
                    'FRAME_TOO_LARGE',
                    `Bridge 请求超过 ${MCP_BRIDGE_MAX_FRAME_BYTES} 字节限制。`,
                )))}\n`);
                socket.destroy();
            }
        });
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => this.sockets.delete(socket));
    }

    private async handleLine(socket: Socket, descriptor: McpBridgeSessionDescriptor, line: string): Promise<void> {
        let id = '';
        const controller = new AbortController();
        const abort = () => controller.abort();
        socket.once('close', abort);
        socket.once('error', abort);
        try {
            const request = parseRequest(line);
            id = request.id;
            if (!safeEqual(request.authToken, descriptor.authToken)) {
                throw new McpBridgeError('BRIDGE_UNAUTHORIZED', 'Bridge 会话认证失败。');
            }
            const result = await this.options.invoke(request.method, request.params, controller.signal);
            const response: McpBridgeResponse = {
                v: MCP_BRIDGE_PROTOCOL_VERSION,
                id,
                ok: true,
                result,
            };
            writeResponse(socket, response);
        } catch (error) {
            if (!(error instanceof McpBridgeError)) {
                console.error('Figma Importer MCP Bridge 调用失败：', error);
            }
            writeResponse(socket, errorResponse(id, error));
        } finally {
            socket.off('close', abort);
            socket.off('error', abort);
        }
    }

    async close(): Promise<void> {
        const server = this.server;
        const descriptor = this.descriptor;
        this.server = null;
        this.descriptor = null;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (descriptor) await removeMcpBridgeDescriptor(descriptor);
    }
}
