'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { createConnection } = require('node:net');
const { tmpdir } = require('node:os');
const { isAbsolute, join, relative, resolve } = require('node:path');
const {
    mcpBridgeDescriptorPath,
} = require('../dist/mcp-bridge/discovery');
const {
    MCP_BRIDGE_PROTOCOL_VERSION,
} = require('../dist/mcp-bridge/protocol');
const { McpBridgeServer } = require('../dist/mcp-bridge/server');

const IO_TIMEOUT_MS = 3000;

function openSocket(endpoint) {
    return new Promise((resolveSocket, reject) => {
        const socket = createConnection(endpoint);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ${endpoint}`));
        }, IO_TIMEOUT_MS);
        const onError = (error) => {
            clearTimeout(timer);
            reject(error);
        };
        socket.once('error', onError);
        socket.once('connect', () => {
            clearTimeout(timer);
            socket.off('error', onError);
            // Keep later transport errors from becoming uncaught while a test cleans up.
            socket.on('error', () => {});
            resolveSocket(socket);
        });
    });
}

function collectJsonLines(socket, expectedCount, onResponse) {
    return new Promise((resolveResponses, reject) => {
        let buffer = '';
        const responses = [];
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${expectedCount} Bridge responses`));
        }, IO_TIMEOUT_MS);

        const cleanup = () => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('close', onClose);
            socket.off('error', onError);
        };
        const fail = (error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => fail(new Error('Bridge socket closed before all responses arrived'));
        const onError = (error) => fail(error);
        const onData = (chunk) => {
            buffer += chunk.toString('utf8');
            let boundary = buffer.indexOf('\n');
            while (boundary >= 0) {
                const line = buffer.slice(0, boundary).trim();
                buffer = buffer.slice(boundary + 1);
                boundary = buffer.indexOf('\n');
                if (!line) continue;
                let response;
                try {
                    response = JSON.parse(line);
                } catch (error) {
                    fail(error);
                    return;
                }
                responses.push(response);
                try {
                    onResponse?.(response, responses);
                } catch (error) {
                    fail(error);
                    return;
                }
                if (responses.length === expectedCount) {
                    cleanup();
                    resolveResponses(responses);
                    return;
                }
            }
        };

        socket.on('data', onData);
        socket.once('close', onClose);
        socket.once('error', onError);
    });
}

function requestLine(descriptor, id, method, params, authToken = descriptor.authToken) {
    return JSON.stringify({
        v: MCP_BRIDGE_PROTOCOL_VERSION,
        id,
        authToken,
        method,
        params,
    });
}

async function removeTemporaryProject(projectPath) {
    const temporaryRoot = resolve(tmpdir());
    const target = resolve(projectPath);
    const childPath = relative(temporaryRoot, target);
    assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath));
    await rm(target, { recursive: true, force: true });
}

test('handles fragmented and coalesced JSONL requests while correlating asynchronous responses by id', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'figma-importer-mcp-jsonl-'));
    let releaseSlowRequest;
    const slowRequest = new Promise((resolveSlowRequest) => {
        releaseSlowRequest = resolveSlowRequest;
    });
    const invocations = [];
    const bridge = new McpBridgeServer({
        projectPath,
        pluginVersion: 'test-version',
        pluginInstanceId: 'jsonl-test',
        async invoke(method, params) {
            invocations.push([method, params]);
            if (params.waitForFastResponse) await slowRequest;
            return { method, params };
        },
    });
    let socket;
    try {
        const descriptor = await bridge.start();
        socket = await openSocket(descriptor.endpoint);
        const slowLine = requestLine(descriptor, 'slow-id', 'getStatus', {
            waitForFastResponse: true,
        });
        const fastLine = requestLine(descriptor, 'fast-id', 'cancelImport', {
            reason: 'test',
        });
        const splitAt = Math.floor(slowLine.length / 2);
        const responsesPromise = collectJsonLines(socket, 2, (_response, responses) => {
            if (responses.length === 1) releaseSlowRequest();
        });

        socket.write(slowLine.slice(0, splitAt));
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        socket.write(`${slowLine.slice(splitAt)}\n${fastLine}\n`);

        const responses = await responsesPromise;
        assert.deepEqual(responses.map((response) => response.id), ['fast-id', 'slow-id']);
        assert.deepEqual(responses.map((response) => response.ok), [true, true]);
        assert.equal(responses[0].result.method, 'cancelImport');
        assert.equal(responses[1].result.method, 'getStatus');
        assert.deepEqual(invocations.map(([method]) => method), ['getStatus', 'cancelImport']);
    } finally {
        releaseSlowRequest?.();
        socket?.destroy();
        await bridge.close();
        await removeTemporaryProject(projectPath);
    }
});

test('authenticates requests and rejects methods outside the Bridge allowlist without invoking the host', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'figma-importer-mcp-auth-'));
    const invocations = [];
    const bridge = new McpBridgeServer({
        projectPath,
        pluginVersion: 'test-version',
        pluginInstanceId: 'auth-test',
        async invoke(method, params) {
            invocations.push([method, params]);
            return { accepted: true };
        },
    });
    let socket;
    try {
        const descriptor = await bridge.start();
        socket = await openSocket(descriptor.endpoint);
        const replacement = descriptor.authToken.endsWith('A') ? 'B' : 'A';
        const wrongToken = `${descriptor.authToken.slice(0, -1)}${replacement}`;
        const responsesPromise = collectJsonLines(socket, 3);

        socket.write([
            requestLine(descriptor, 'unauthorized-id', 'getStatus', {}, wrongToken),
            requestLine(descriptor, 'not-allowed-id', 'runShellCommand', {}),
            requestLine(descriptor, 'allowed-id', 'getStatus', { source: 'test' }),
            '',
        ].join('\n'));

        const responses = await responsesPromise;
        const unauthorized = responses.find((response) => response.id === 'unauthorized-id');
        const invalidMethod = responses.find((response) => response.error?.code === 'INVALID_REQUEST');
        const allowed = responses.find((response) => response.id === 'allowed-id');

        assert.equal(unauthorized.ok, false);
        assert.equal(unauthorized.error.code, 'BRIDGE_UNAUTHORIZED');
        assert.equal(invalidMethod.ok, false);
        assert.equal(allowed.ok, true);
        assert.deepEqual(allowed.result, { accepted: true });
        assert.deepEqual(invocations, [['getStatus', { source: 'test' }]]);
    } finally {
        socket?.destroy();
        await bridge.close();
        await removeTemporaryProject(projectPath);
    }
});

test('publishes one stable session descriptor and removes discovery and transport state on close', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'figma-importer-mcp-lifecycle-'));
    const bridge = new McpBridgeServer({
        projectPath,
        pluginVersion: '1.2.3-test',
        pluginInstanceId: 'lifecycle-test',
        async invoke() {
            return null;
        },
    });
    let socket;
    let closed = false;
    try {
        const descriptor = await bridge.start();
        const repeatedStart = await bridge.start();
        const descriptorPath = mcpBridgeDescriptorPath(
            descriptor.projectHash,
            descriptor.pid,
            descriptor.pluginInstanceId,
        );
        const persisted = JSON.parse(await readFile(descriptorPath, 'utf8'));

        assert.deepEqual(repeatedStart, descriptor);
        assert.deepEqual(persisted, descriptor);
        assert.equal(persisted.projectPath, resolve(projectPath));
        assert.equal(persisted.pluginVersion, '1.2.3-test');
        assert.equal(persisted.pluginInstanceId, 'lifecycle-test');
        assert.match(persisted.authToken, /^[A-Za-z0-9_-]{40,}$/);
        socket = await openSocket(descriptor.endpoint);

        socket.destroy();
        socket = undefined;
        await bridge.close();
        closed = true;

        await assert.rejects(readFile(descriptorPath, 'utf8'), { code: 'ENOENT' });
        await assert.rejects(async () => {
            const reopenedSocket = await openSocket(descriptor.endpoint);
            reopenedSocket.destroy();
        });
        await bridge.close();
    } finally {
        socket?.destroy();
        if (!closed) await bridge.close();
        await removeTemporaryProject(projectPath);
    }
});
