'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const bundlePath = join(__dirname, '..', 'mcp-dist', 'server.js');
const { McpBridgeClient, sendBridgeRequest } = require(bundlePath);
const { McpBridgeServer } = require('../dist/mcp-bridge/server');

test('bundled stdio server initializes, lists the allowlisted tools, and returns actionable offline errors', {
    timeout: 15_000,
}, async () => {
    const unmatchedProject = join(tmpdir(), `figma-importer-no-project-${randomUUID()}`);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bundlePath, '--project', unmatchedProject],
        stderr: 'pipe',
    });
    transport.stderr?.resume();
    const client = new Client({
        name: 'figma-importer-mcp-test-client',
        version: '1.0.0',
    });

    try {
        await client.connect(transport);
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map((tool) => tool.name), [
            'figma_importer_get_status',
            'figma_importer_fetch_document',
            'figma_importer_list_nodes',
            'figma_importer_get_preview',
            'figma_importer_update_settings',
            'figma_importer_update_nodes',
            'figma_importer_rename_nodes',
            'figma_importer_import',
            'figma_importer_cancel_import',
        ]);
        assert.equal(listed.tools.some((tool) => /round.?trip/i.test(tool.name)), false);
        for (const tool of listed.tools) {
            assert.equal(
                tool.annotations?.openWorldHint,
                false,
                `${tool.name} 不应请求浏览器/open-world 权限`,
            );
        }

        const status = await client.callTool({
            name: 'figma_importer_get_status',
            arguments: {},
        });
        assert.equal(status.isError, true);
        assert.match(status.content[0].text, /COCOS_(?:NOT_RUNNING|PROJECT_NOT_FOUND)/);
        assert.match(status.content[0].text, /(?:Cocos Creator|--project)/);
    } finally {
        await client.close();
    }
});

test('automatic discovery stays pinned to the first selected Cocos project', async () => {
    const projectA = join(tmpdir(), `figma-importer-project-a-${randomUUID()}`);
    const projectB = join(tmpdir(), `figma-importer-project-b-${randomUUID()}`);
    const descriptor = (projectPath, suffix) => ({
        v: 1,
        pid: 12345,
        projectPath,
        projectHash: `hash-${suffix}`,
        endpoint: `endpoint-${suffix}`,
        authToken: `token-${suffix}`,
        pluginVersion: '1.0.45',
        pluginInstanceId: `instance-${suffix}`,
        startedAt: new Date().toISOString(),
    });
    let descriptors = [descriptor(projectA, 'a')];
    let requests = 0;
    const client = new McpBridgeClient({
        readDescriptors: async () => descriptors,
        isProcessRunning: () => true,
        request: async (selected) => {
            requests += 1;
            if (requests === 1) return { projectPath: selected.projectPath };
            const error = new Error('simulated connection failure');
            error.code = 'BRIDGE_CONNECTION_FAILED';
            throw error;
        },
    });

    assert.deepEqual(await client.call('getStatus', {}), { projectPath: projectA });
    descriptors = [descriptor(projectB, 'b')];
    await assert.rejects(client.call('getStatus', {}), (error) => error.code === 'BRIDGE_CONNECTION_FAILED');
    await assert.rejects(client.call('getStatus', {}), (error) => error.code === 'COCOS_PROJECT_NOT_FOUND');
    assert.equal(requests, 2);
});

test('SDK cancellation closes the Bridge call and reaches the Cocos invocation signal', async () => {
    const projectPath = join(tmpdir(), `figma-importer-abort-${randomUUID()}`);
    let invocationStarted = false;
    let signalAborted = false;
    const bridge = new McpBridgeServer({
        projectPath,
        pluginVersion: '1.0.45',
        pluginInstanceId: `abort-${randomUUID()}`,
        invoke(_method, _params, signal) {
            invocationStarted = true;
            return new Promise((resolve) => {
                signal.addEventListener('abort', () => {
                    signalAborted = true;
                    resolve({ cancelled: true });
                }, { once: true });
            });
        },
    });
    try {
        const descriptor = await bridge.start();
        const controller = new AbortController();
        const pending = sendBridgeRequest(descriptor, 'getStatus', {}, 30_000, controller.signal);
        while (!invocationStarted) {
            await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        }
        controller.abort();
        await assert.rejects(pending, (error) => error.code === 'CANCELLED');
        for (let count = 0; count < 20 && !signalAborted; count += 1) {
            await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        }
        assert.equal(signalAborted, true);
    } finally {
        await bridge.close();
    }
});
