'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FigmaImporterMcpApi } = require('../dist/mcp-api');

function treeNode(value) {
    return {
        id: value.id,
        name: value.name,
        type: value.type ?? 'FRAME',
        visible: value.visible !== false,
        width: value.width ?? 100,
        height: value.height ?? 40,
        action: value.action ?? 'generate',
        kind: value.kind ?? 'node',
        patchCandidate: value.patchCandidate === true,
        children: value.children ?? [],
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.warning ? { warning: value.warning } : {}),
    };
}

function fixtureDocument(sourceUrl = 'https://www.figma.com/design/file-a?node-id=root') {
    const button = treeNode({
        id: 'btn',
        name: 'Close Button',
        kind: 'button',
        patchCandidate: true,
        warning: '按钮背景需要确认。',
    });
    const title = treeNode({
        id: 'title',
        name: 'Title Text',
        type: 'TEXT',
        kind: 'label',
    });
    const panel = treeNode({
        id: 'panel',
        name: 'Panel Controls',
        children: [button, title],
    });
    const decoration = treeNode({
        id: 'decoration',
        name: 'Decor Rectangle',
        type: 'RECTANGLE',
        action: 'render',
        kind: 'sprite',
    });
    const root = treeNode({
        id: 'root',
        name: 'Popup Original',
        width: 640,
        height: 1136,
        reason: 'root-structure',
        children: [panel, decoration],
    });
    return {
        fileKey: 'file-a',
        fileName: 'Popup',
        sourceUrl,
        tree: [root],
        fonts: ['Game Font'],
        nodeOverrides: [{
            id: 'btn',
            action: 'ignore',
            kind: 'sprite',
            nineSlice: true,
            explicit: true,
            name: 'btn_old',
        }, {
            id: 'decoration',
            action: 'generate',
            kind: 'node',
            nineSlice: false,
            explicit: false,
            name: 'img_decor',
        }],
    };
}

function defaultSettings(sourceUrl) {
    return {
        sourceUrl,
        assetFolder: 'figma-importer',
        prefabFolder: 'figma-prefabs',
        localResourceFolders: [],
        localResourceFolder: '',
        scale: 1,
        updateExisting: true,
        refreshAssets: false,
        autoSave: false,
        fontMap: {},
    };
}

function createHostFixture() {
    let revision = 0;
    let document = fixtureDocument();
    let settings = defaultSettings(document.sourceUrl);
    let busy = false;
    let tokenConfigured = true;
    const saveCalls = [];
    const importCalls = [];
    const cancelCalls = [];
    let importHandler = async () => ({
        created: 1,
        updated: 0,
        nodeMap: Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`node-${index}`, `uuid-${index}`])),
    });
    let cancelHandler = () => {};

    const host = {
        projectPath: 'C:\\projects\\game',
        creatorVersion: '3.8.7',
        getDocumentRevision() {
            return revision;
        },
        isImportBusy() {
            return busy;
        },
        async getState() {
            return {
                version: '1.0.45',
                vault: {
                    hasToken: tokenConfigured,
                    persistent: true,
                    backend: 'test',
                },
                settings,
                document,
            };
        },
        async fetchDocument(sourceUrl) {
            revision += 1;
            document = fixtureDocument(sourceUrl);
            settings = { ...settings, sourceUrl };
            return document;
        },
        async getPreview(nodeId) {
            return { url: `https://example.test/${nodeId}.png` };
        },
        async saveSettings(value) {
            settings = value;
            return settings;
        },
        async saveNodeOverrides(fileKey, overrides, scopeIds) {
            const savedValues = overrides.map((item) => ({ ...item }));
            const savedScope = [...scopeIds];
            saveCalls.push({ fileKey, overrides: savedValues, scopeIds: savedScope });

            const next = new Map(document.nodeOverrides.map((item) => [item.id, { ...item }]));
            for (const id of savedScope) next.delete(id);
            for (const item of savedValues) next.set(item.id, { ...item });
            document = { ...document, nodeOverrides: [...next.values()] };
            return savedValues;
        },
        async importSelection(request, operationId) {
            importCalls.push({ request, operationId });
            busy = true;
            try {
                return await importHandler(request, operationId);
            } finally {
                busy = false;
            }
        },
        cancelImport(operationId) {
            cancelCalls.push(operationId);
            if (!busy) return false;
            cancelHandler(operationId);
            return true;
        },
    };

    return {
        api: new FigmaImporterMcpApi(host),
        host,
        saveCalls,
        importCalls,
        cancelCalls,
        setBusy(value) {
            busy = value;
        },
        setTokenConfigured(value) {
            tokenConfigured = value;
        },
        mutateOverrides(value) {
            document = { ...document, nodeOverrides: value.map((item) => ({ ...item })) };
        },
        setImportHandler(value) {
            importHandler = value;
        },
        setCancelHandler(value) {
            cancelHandler = value;
        },
    };
}

async function fetchSession(api, suffix = 'one') {
    const result = await api.invoke('fetchDocument', {
        sourceUrl: `https://www.figma.com/design/file-a?node-id=root&view=${suffix}`,
    });
    assert.equal(typeof result.documentSessionId, 'string');
    assert.ok(result.documentSessionId.length > 10);
    return result.documentSessionId;
}

async function rejectsWithCode(operation, code) {
    await assert.rejects(operation, (error) => {
        assert.equal(error?.code, code);
        return true;
    });
}

test('document sessions bind stable pagination cursors and invalidate old sessions', async () => {
    const { api } = createHostFixture();
    const firstSession = await fetchSession(api, 'first');

    const firstPage = await api.invoke('listNodes', {
        documentSessionId: firstSession,
        limit: 2,
    });
    assert.deepEqual(firstPage.nodes.map((item) => item.nodeId), ['root', 'panel']);
    assert.equal(firstPage.totalCount, 5);
    assert.equal(firstPage.hasMore, true);
    assert.equal(typeof firstPage.nextCursor, 'string');

    const secondPage = await api.invoke('listNodes', {
        documentSessionId: firstSession,
        limit: 2,
        cursor: firstPage.nextCursor,
    });
    assert.deepEqual(secondPage.nodes.map((item) => item.nodeId), ['btn', 'title']);
    assert.equal(secondPage.hasMore, true);

    await rejectsWithCode(api.invoke('listNodes', {
        documentSessionId: firstSession,
        search: 'panel',
        limit: 2,
        cursor: firstPage.nextCursor,
    }), 'INVALID_CURSOR');

    const scoped = await api.invoke('listNodes', {
        documentSessionId: firstSession,
        rootNodeId: 'panel',
        depth: 1,
        limit: 10,
    });
    assert.deepEqual(scoped.nodes.map((item) => [item.nodeId, item.depth]), [
        ['panel', 0],
        ['btn', 1],
        ['title', 1],
    ]);
    const forcedNineSlice = scoped.nodes.find((item) => item.nodeId === 'btn');
    assert.equal(forcedNineSlice.preferredAction, 'ignore');
    assert.equal(forcedNineSlice.action, 'render');
    assert.equal(forcedNineSlice.nineSlice, true);

    const renamedSearch = await api.invoke('listNodes', {
        documentSessionId: firstSession,
        search: 'btn_old',
        limit: 10,
    });
    assert.deepEqual(renamedSearch.nodes.map((item) => item.nodeId), ['btn']);

    const secondSession = await fetchSession(api, 'second');
    assert.notEqual(secondSession, firstSession);
    await rejectsWithCode(api.invoke('listNodes', {
        documentSessionId: firstSession,
        limit: 2,
        cursor: firstPage.nextCursor,
    }), 'STALE_DOCUMENT_SESSION');
});

test('renaming invalidates old cursors and preserves every existing strategy field', async () => {
    const { api, saveCalls } = createHostFixture();
    const sessionId = await fetchSession(api);
    const page = await api.invoke('listNodes', {
        documentSessionId: sessionId,
        limit: 2,
    });

    const result = await api.invoke('renameNodes', {
        documentSessionId: sessionId,
        renames: [
            { nodeId: 'btn', name: '  btn/close\nprimary  ' },
            { nodeId: 'title', name: 'txt_title' },
        ],
    });

    assert.deepEqual(result.updated.map((item) => [item.nodeId, item.cocosName]), [
        ['btn', 'btn close primary'],
        ['title', 'txt_title'],
    ]);
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].fileKey, 'file-a');
    assert.deepEqual(saveCalls[0].scopeIds, ['btn', 'title']);
    assert.deepEqual(saveCalls[0].overrides, [
        {
            id: 'btn',
            action: 'ignore',
            kind: 'sprite',
            nineSlice: true,
            explicit: true,
            name: 'btn close primary',
        },
        {
            id: 'title',
            action: 'generate',
            kind: 'label',
            nineSlice: false,
            explicit: false,
            name: 'txt_title',
        },
    ]);

    await rejectsWithCode(api.invoke('listNodes', {
        documentSessionId: sessionId,
        cursor: page.nextCursor,
        limit: 2,
    }), 'INVALID_CURSOR');

    const current = await api.invoke('listNodes', {
        documentSessionId: sessionId,
        search: 'txt_title',
        limit: 10,
    });
    assert.equal(current.nodes[0].figmaName, 'Title Text');
    assert.equal(current.nodes[0].cocosName, 'txt_title');
    assert.equal(current.nodes[0].explicit, false);
});

test('out-of-band panel override writes invalidate MCP pagination cursors', async () => {
    const fixture = createHostFixture();
    const sessionId = await fetchSession(fixture.api);
    const firstPage = await fixture.api.invoke('listNodes', {
        documentSessionId: sessionId,
        limit: 2,
    });
    fixture.mutateOverrides([{
        id: 'title',
        action: 'render',
        kind: 'sprite',
        nineSlice: false,
        explicit: true,
    }]);
    await rejectsWithCode(fixture.api.invoke('listNodes', {
        documentSessionId: sessionId,
        limit: 2,
        cursor: firstPage.nextCursor,
    }), 'INVALID_CURSOR');
});

test('fetch rejects missing tokens and non-Figma URLs before invoking the host', async () => {
    const fixture = createHostFixture();
    fixture.setTokenConfigured(false);
    await rejectsWithCode(fixture.api.invoke('fetchDocument', {
        sourceUrl: 'https://www.figma.com/design/file-a',
    }), 'TOKEN_NOT_CONFIGURED');

    fixture.setTokenConfigured(true);
    await rejectsWithCode(fixture.api.invoke('fetchDocument', {
        sourceUrl: 'https://example.test/design/file-a',
    }), 'INVALID_FIGMA_SOURCE');
});

test('root renames require explicit confirmation before any profile write', async () => {
    const { api, saveCalls } = createHostFixture();
    const sessionId = await fetchSession(api);

    await rejectsWithCode(api.invoke('renameNodes', {
        documentSessionId: sessionId,
        renames: [{ nodeId: 'root', name: 'PopupRenamed' }],
    }), 'ROOT_RENAME_REQUIRES_CONFIRMATION');
    assert.equal(saveCalls.length, 0);

    const confirmed = await api.invoke('renameNodes', {
        documentSessionId: sessionId,
        allowRootRename: true,
        renames: [{ nodeId: 'root', name: 'PopupRenamed' }],
    });
    assert.equal(saveCalls.length, 1);
    assert.deepEqual(saveCalls[0].overrides, [{
        id: 'root',
        action: 'generate',
        kind: 'node',
        nineSlice: false,
        explicit: false,
        name: 'PopupRenamed',
    }]);
    assert.match(confirmed.updated[0].warning, /Prefab/);
});

test('imports recompute name-only defaults, return a bounded summary, and deduplicate operation ids', async () => {
    const { api, importCalls } = createHostFixture();
    const sessionId = await fetchSession(api);
    const input = {
        documentSessionId: sessionId,
        operationId: 'import-op-0001',
        confirm: true,
    };

    const first = await api.invoke('importDocument', input);
    assert.equal(importCalls.length, 1);
    assert.equal(importCalls[0].operationId, 'import-op-0001');
    const decoration = importCalls[0].request.overrides.find((item) => item.id === 'decoration');
    assert.deepEqual(decoration, {
        id: 'decoration',
        action: 'render',
        kind: 'sprite',
        nineSlice: false,
        explicit: false,
        name: 'img_decor',
    });
    assert.deepEqual(first, {
        operationId: 'import-op-0001',
        result: { completed: true, created: 1, updated: 0 },
    });
    assert.equal(JSON.stringify(first).includes('nodeMap'), false);

    const repeated = await api.invoke('importDocument', input);
    assert.deepEqual(repeated, first);
    assert.equal(importCalls.length, 1);

    await api.invoke('renameNodes', {
        documentSessionId: sessionId,
        renames: [{ nodeId: 'title', name: 'txt_changed_after_import' }],
    });
    await rejectsWithCode(api.invoke('importDocument', input), 'OPERATION_ID_CONFLICT');
    assert.equal(importCalls.length, 1);
});

test('cancel requires the matching MCP document and operation id', async () => {
    const fixture = createHostFixture();
    const sessionId = await fetchSession(fixture.api);
    let rejectImport;
    fixture.setImportHandler(() => new Promise((_resolve, reject) => {
        rejectImport = reject;
    }));
    fixture.setCancelHandler(() => rejectImport(new Error('host aborted')));

    const pending = fixture.api.invoke('importDocument', {
        documentSessionId: sessionId,
        operationId: 'import-op-0002',
        confirm: true,
    });
    const rejected = rejectsWithCode(pending, 'CANCELLED');
    while (!fixture.importCalls.length) {
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    }

    const wrong = await fixture.api.invoke('cancelImport', {
        documentSessionId: sessionId,
        operationId: 'import-op-wrong',
    });
    assert.equal(wrong.cancellationRequested, false);
    assert.equal(fixture.cancelCalls.length, 0);

    const matching = await fixture.api.invoke('cancelImport', {
        documentSessionId: sessionId,
        operationId: 'import-op-0002',
    });
    assert.deepEqual(matching, {
        cancellationRequested: true,
        operationId: 'import-op-0002',
        interruptSignalSent: true,
        guaranteed: false,
    });
    assert.deepEqual(fixture.cancelCalls, ['import-op-0002']);
    await rejected;
});
