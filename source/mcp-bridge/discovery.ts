import { createHash, randomBytes } from 'crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
    MCP_BRIDGE_PROTOCOL_VERSION,
    MCP_BRIDGE_SESSION_PREFIX,
    type McpBridgeSessionDescriptor,
} from './protocol';

export function mcpBridgeSessionDirectory(): string {
    return join(tmpdir(), `${MCP_BRIDGE_SESSION_PREFIX}-mcp`);
}

export function mcpProjectHash(projectPath: string): string {
    const normalized = process.platform === 'win32'
        ? resolve(projectPath).toLowerCase()
        : resolve(projectPath);
    return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function mcpPluginInstanceHash(pluginInstanceId: string): string {
    return createHash('sha256').update(pluginInstanceId, 'utf8').digest('hex').slice(0, 12);
}

export function mcpBridgeEndpoint(
    projectHash: string,
    pid = process.pid,
    pluginInstanceId?: string,
): string {
    const instanceSuffix = pluginInstanceId ? `-${mcpPluginInstanceHash(pluginInstanceId)}` : '';
    const name = `${MCP_BRIDGE_SESSION_PREFIX}-${projectHash}-${pid}${instanceSuffix}`;
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\${name}`
        : join(tmpdir(), `${name}.sock`);
}

export function mcpBridgeDescriptorPath(
    projectHash: string,
    pid = process.pid,
    pluginInstanceId?: string,
): string {
    const instanceSuffix = pluginInstanceId ? `-${mcpPluginInstanceHash(pluginInstanceId)}` : '';
    return join(mcpBridgeSessionDirectory(), `${projectHash}-${pid}${instanceSuffix}.json`);
}

export function createMcpBridgeDescriptor(options: {
    projectPath: string;
    pluginVersion: string;
    pluginInstanceId: string;
    pid?: number;
}): McpBridgeSessionDescriptor {
    const pid = options.pid ?? process.pid;
    const projectPath = resolve(options.projectPath);
    const projectHash = mcpProjectHash(projectPath);
    return {
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        pid,
        projectPath,
        projectHash,
        endpoint: mcpBridgeEndpoint(projectHash, pid, options.pluginInstanceId),
        authToken: randomBytes(32).toString('base64url'),
        pluginVersion: options.pluginVersion,
        pluginInstanceId: options.pluginInstanceId,
        startedAt: new Date().toISOString(),
    };
}

export async function writeMcpBridgeDescriptor(descriptor: McpBridgeSessionDescriptor): Promise<string> {
    const directory = mcpBridgeSessionDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const path = mcpBridgeDescriptorPath(
        descriptor.projectHash,
        descriptor.pid,
        descriptor.pluginInstanceId,
    );
    const temporaryPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await writeFile(temporaryPath, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
        if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
        await rm(path, { force: true });
        await rename(temporaryPath, path);
        if (process.platform !== 'win32') await chmod(path, 0o600);
    } finally {
        await rm(temporaryPath, { force: true });
    }
    return path;
}

export async function removeMcpBridgeDescriptor(descriptor: McpBridgeSessionDescriptor): Promise<void> {
    await rm(mcpBridgeDescriptorPath(
        descriptor.projectHash,
        descriptor.pid,
        descriptor.pluginInstanceId,
    ), { force: true });
    if (process.platform !== 'win32') {
        await rm(descriptor.endpoint, { force: true });
    }
}

export async function readMcpBridgeDescriptors(): Promise<McpBridgeSessionDescriptor[]> {
    let names: string[];
    try {
        names = await readdir(mcpBridgeSessionDirectory());
    } catch {
        return [];
    }
    const descriptors: McpBridgeSessionDescriptor[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            const raw = JSON.parse(await readFile(join(mcpBridgeSessionDirectory(), name), 'utf8')) as Partial<McpBridgeSessionDescriptor>;
            if (raw.v !== MCP_BRIDGE_PROTOCOL_VERSION
                || typeof raw.pid !== 'number'
                || typeof raw.projectPath !== 'string'
                || typeof raw.projectHash !== 'string'
                || typeof raw.endpoint !== 'string'
                || typeof raw.authToken !== 'string'
                || typeof raw.pluginVersion !== 'string'
                || typeof raw.pluginInstanceId !== 'string'
                || typeof raw.startedAt !== 'string') {
                continue;
            }
            const expectedHash = mcpProjectHash(raw.projectPath);
            const expectedName = `${expectedHash}-${raw.pid}-${mcpPluginInstanceHash(raw.pluginInstanceId)}.json`;
            if (raw.projectHash !== expectedHash
                || name !== expectedName
                || raw.endpoint !== mcpBridgeEndpoint(expectedHash, raw.pid, raw.pluginInstanceId)
                || !Number.isFinite(Date.parse(raw.startedAt))) {
                continue;
            }
            descriptors.push(raw as McpBridgeSessionDescriptor);
        } catch {
            // Ignore corrupt or concurrently removed descriptors.
        }
    }
    return descriptors;
}
