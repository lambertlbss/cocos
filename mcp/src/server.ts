import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAbsolute } from 'path';
import { McpBridgeClient, type BridgeInvoker } from './bridge-client';
import { registerFigmaImporterTools } from './tools';

declare const __FIGMA_IMPORTER_VERSION__: string;

export const MCP_SERVER_NAME = 'figma-importer-cocos-mcp-server';
export const MCP_SERVER_VERSION = __FIGMA_IMPORTER_VERSION__;

export interface FigmaImporterMcpServerOptions {
    bridge?: BridgeInvoker;
    projectPath?: string;
    timeoutMs?: number;
    version?: string;
}

export interface McpCliOptions {
    projectPath?: string;
    timeoutMs?: number;
    help: boolean;
}

export function createBridgeClient(options: ConstructorParameters<typeof McpBridgeClient>[0] = {}): McpBridgeClient {
    return new McpBridgeClient(options);
}

export function parseMcpCliOptions(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): McpCliOptions {
    let projectPath = environment.FIGMA_IMPORTER_COCOS_PROJECT?.trim() || undefined;
    let timeoutMs: number | undefined;
    let help = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            help = true;
            continue;
        }
        if (argument === '--project') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--project 需要一个项目绝对路径。');
            projectPath = value;
            index += 1;
            continue;
        }
        if (argument.startsWith('--project=')) {
            projectPath = argument.slice('--project='.length);
            if (!projectPath) throw new Error('--project 不能为空。');
            continue;
        }
        if (argument === '--timeout-ms') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) throw new Error('--timeout-ms 需要一个毫秒整数。');
            timeoutMs = Number(value);
            index += 1;
            continue;
        }
        if (argument.startsWith('--timeout-ms=')) {
            timeoutMs = Number(argument.slice('--timeout-ms='.length));
            continue;
        }
        throw new Error(`未知参数：${argument}`);
    }
    if (projectPath && !isAbsolute(projectPath)) {
        throw new Error('--project 必须是 Cocos 项目根目录的绝对路径。');
    }
    return { projectPath, timeoutMs, help };
}

export function createFigmaImporterMcpServer(options: FigmaImporterMcpServerOptions = {}): McpServer {
    const bridge = options.bridge ?? createBridgeClient({
        projectPath: options.projectPath,
        timeoutMs: options.timeoutMs,
    });
    const server = new McpServer({
        name: MCP_SERVER_NAME,
        version: options.version ?? MCP_SERVER_VERSION,
    });
    registerFigmaImporterTools(server, bridge);
    return server;
}

export const createMcpServer = createFigmaImporterMcpServer;

export function assertSupportedNodeVersion(version = process.versions.node): void {
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    if (!Number.isInteger(major) || major < 18) {
        throw new Error(`Figma Importer MCP Server 需要 Node.js 18 或更高版本，当前版本为 ${version}。`);
    }
}

function usage(): string {
    return [
        'Figma Importer Cocos MCP Server',
        '',
        '用法：node mcp-dist/server.js [--project <Cocos 项目绝对路径>] [--timeout-ms <毫秒>]',
        '',
        '--timeout-ms 用于普通调用；Figma 读取至少等待 120 秒，导入持续等待到完成或显式取消。',
        '环境变量：FIGMA_IMPORTER_COCOS_PROJECT 可设置默认项目路径。',
    ].join('\n');
}

export async function main(
    argv: readonly string[] = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    assertSupportedNodeVersion();
    const cli = parseMcpCliOptions(argv, environment);
    if (cli.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const server = createFigmaImporterMcpServer({
        projectPath: cli.projectPath,
        timeoutMs: cli.timeoutMs,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`${MCP_SERVER_NAME} ${MCP_SERVER_VERSION} 已通过 stdio 启动。\n`);

    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        void server.close().finally(() => {
            process.exitCode = 0;
        });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

export {
    McpBridgeClient,
    normalizeProjectPath,
    processIsRunning,
    selectBridgeSession,
    sendBridgeRequest,
    type BridgeInvoker,
    type McpBridgeClientOptions,
} from './bridge-client';
export {
    FIGMA_IMPORTER_TOOL_NAMES,
    createFigmaImporterToolHandlers,
    registerFigmaImporterTools,
    type FigmaImporterToolHandlers,
    type FigmaImporterToolName,
} from './tools';

if (require.main === module) {
    void main().catch((error: unknown) => {
        process.stderr.write(`MCP Server 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
