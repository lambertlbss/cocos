'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { readFileSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { join, dirname, relative, resolve, isAbsolute } = require('node:path');
const { tmpdir } = require('node:os');
const { FigmaClient } = require('../dist/figma/client');
const { TokenVault } = require('../dist/security/token-vault');
const { AssetWriter } = require('../dist/importer/assets');
const { FigmaImporterMcpApi } = require('../dist/mcp-api');
const { RoundtripService } = require('../dist/roundtrip/service');
const { parseFigmaSource } = require('../dist/figma/url');
const { createPrefabSyncRecord, figmaFrameSourceHash } = require('../dist/importer/prefab-sync');
const { DEFAULT_SETTINGS } = require('../dist/types');

const FILE = 'BatchFile12345';
const OTHER = 'OtherFile12345';
const link = (nodeId, file = FILE) => `https://www.figma.com/design/${file}/Screens?node-id=${nodeId.replace(/:/g, '-')}`;
const frame = (id, name, children = []) => ({ id, name, type: 'FRAME', children,
    absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 480 } });
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

/** Compile a fresh main-process module per test, with hooks only in the test copy.
 * Keep the real public methods, source parsing, task queue and import orchestration;
 * replace only remote I/O and the already-covered Creator Prefab transaction.
 */
function fixture(t) {
    const project = mkdtempSync(join(tmpdir(), 'figma-batch-main-'));
    mkdirSync(join(project, 'assets'), { recursive: true });
    mkdirSync(join(project, 'temp'), { recursive: true });
    const previousEditor = global.Editor;
    const profile = new Map();
    const messages = [];
    let dirty = false;
    let dirtyFailure = false;
    let markerScriptCreated = false;
    global.Editor = {
        Project: { path: project, tmpDir: join(project, 'temp') },
        Profile: {
            async getProject(_packageName, key) { return profile.get(key); },
            async setProject(_packageName, key, value) { profile.set(key, value); },
        },
        Message: {
            send(_packageName, method, payload) { messages.push({ method, payload: JSON.parse(JSON.stringify(payload)) }); },
            async request(channel, method, ...args) {
                if (channel === 'scene' && method === 'query-dirty') {
                    if (dirtyFailure) throw new Error('scene state unavailable');
                    return dirty;
                }
                // Frame 链接现在也生成同步标记脚本：模拟它的创建与就绪查询。
                if (channel === 'asset-db' && method === 'query-asset-info') {
                    return markerScriptCreated && String(args[0] ?? '').includes('FigmaSyncNode.ts')
                        ? { uuid: 'marker-script-uuid' }
                        : null;
                }
                if (channel === 'asset-db' && method === 'create-asset') {
                    markerScriptCreated = true;
                    return { uuid: 'marker-script-uuid' };
                }
                if (channel === 'asset-db' && method === 'save-asset') return null;
                if (channel === 'asset-db' && method === 'query-asset-meta') return null;
                throw new Error(`Unexpected Creator request: ${channel}/${method}`);
            },
        },
        Selection: { select() {}, clear() {} },
        Panel: { async open() {} },
        App: { version: '3.8.7' },
    };
    t.after(() => {
        global.Editor = previousEditor;
        const suffix = relative(resolve(tmpdir()), resolve(project));
        assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix));
        rmSync(project, { recursive: true, force: true });
    });
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});
    t.mock.method(TokenVault.prototype, 'get', async () => 'test-token');
    t.mock.method(TokenVault.prototype, 'initialize', async () => {});
    t.mock.method(TokenVault.prototype, 'status', () => ({ hasToken: true, persistent: false, backend: 'test' }));
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});

    const home = frame('20:1', 'Home', [frame('20:11', 'Button internals')]);
    const bag = frame('20:2', 'Bag');
    const shop = frame('20:3', 'Shop');
    const section = { id: '10:1', name: 'Screens', type: 'SECTION', children: [home,
        { id: '10:2', name: 'More Screens', type: 'SECTION', children: [bag, shop] }] };
    const nodes = new Map([['10:1', section], [home.id, home], [bag.id, bag], [shop.id, shop]]);
    const requests = [];
    const previews = [];
    let sourceBlock;
    t.mock.method(FigmaClient.prototype, 'getNode', async (fileKey, nodeId) => {
        requests.push({ fileKey, nodeId });
        if (sourceBlock) await sourceBlock.promise;
        const document = nodes.get(nodeId);
        assert.ok(document, `fixture includes requested Figma node ${nodeId}`);
        return { name: `File ${fileKey}`, nodes: { [nodeId]: { document } } };
    });
    t.mock.method(FigmaClient.prototype, 'getFile', async (fileKey) => ({ name: `File ${fileKey}`,
        document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', type: 'CANVAS', children: [section] }] } }));
    t.mock.method(FigmaClient.prototype, 'getImageUrls', async (fileKey, ids) => {
        previews.push({ fileKey, ids });
        return Object.fromEntries(ids.map((id) => [id, `https://fixture.test/${fileKey}/${id}.png`]));
    });

    const path = require.resolve('../dist/main');
    const isolated = new Module(path, module);
    isolated.filename = path;
    isolated.paths = Module._nodeModulePaths(dirname(path));
    isolated._compile(`${readFileSync(path, 'utf8')}\nexports.__batchTest = {
        setAssetBuilder(fn) { buildAssets = fn; },
        setLinkedImporter(fn) { importLinkedFramePrefab = fn; },
        setFonts(fn) { resolveFonts = fn; },
        linkedImporter: importLinkedFramePrefab,
        setPrefabPreparation(fn) { prepareLinkedFramePrefab = fn; },
        setPrefabOpen(fn) { waitForOpenedPrefab = fn; },
        setPrefabAssertion(fn) { assertOpenedPrefab = fn; },
        activeDocument() { return activeDocument; },
        revision() { return documentRevision; },
        busy() { return activeController !== null; },
        getMcpState: getMcpPluginState,
        performImport(request, owner) { return performImport(request, owner); },
    };\n`, path);
    const { methods, __batchTest: hooks } = isolated.exports;
    hooks.setAssetBuilder(async () => ({ assets: new Map(), warnings: [] }));
    hooks.setFonts(async () => new Map());
    const imports = [];
    let handler = async () => ({});
    hooks.setLinkedImporter(async (args) => {
        imports.push(args);
        return { rootUuid: `root-${args.sourceNodeId}`, nodeMap: {}, created: 1, updated: 0,
            prefabUrl: args.prefabUrl, ...await handler(args) };
    });
    const request = (items, failurePolicy = 'continue') => ({
        items: items.map((item) => ({ id: item.id, overrides: [] })),
        settings: { ...DEFAULT_SETTINGS }, failurePolicy,
    });
    return { methods, hooks, requests, previews, imports, messages, profile, nodes, request,
        setImporter(fn) { handler = fn; }, setDirty(value) { dirty = value; },
        failDirty() { dirtyFailure = true; }, blockSource(value) { sourceBlock = value; } };
}

test('main resolves section screens as frame sources and deduplicates direct links with file isolation', async (t) => {
    const f = fixture(t);
    const section = await f.methods.resolveBatchSource(link('10:1'));
    assert.equal(section.sourceType, 'section');
    assert.equal(section.added, 3);
    let items = (await f.methods.getBatchState()).items;
    assert.deepEqual(items.map((item) => item.rootId), ['20:1', '20:2', '20:3']);
    assert.ok(items.every((item) => item.document.tree.length === 1));
    assert.ok(items.every((item) => parseFigmaSource(item.sourceUrl).nodeId === item.rootId));
    assert.ok(items.every((item) => item.sectionName === 'Screens'));
    const originalId = items[0].id;
    const duplicate = await f.methods.resolveBatchSource(link('20:1'));
    assert.equal(duplicate.added, 0);
    assert.equal(duplicate.duplicates, 1);
    assert.equal((await f.methods.getBatchState()).items.length, 3);
    await f.methods.resolveBatchSource(link('20:1', OTHER));
    items = (await f.methods.getBatchState()).items;
    assert.equal(items.length, 4);
    assert.equal(items[0].id, originalId);
    assert.notEqual(items[0].id, items[3].id);
    assert.equal(items[3].fileKey, OTHER);
});

test('main activation changes source preview document and sync preserves enabled order/removes items', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    const document = await f.methods.activateBatchItem(items[1].id);
    assert.equal(document.tree[0].id, '20:2');
    assert.equal(f.hooks.activeDocument().sourceNodeId, '20:2');
    await f.methods.getPreview('20:2');
    assert.deepEqual(f.previews.at(-1), { fileKey: FILE, ids: ['20:2'] });
    await assert.rejects(f.methods.getPreview('20:1'), /不存在/);
    await f.methods.activateBatchItem(items[0].id);
    await f.methods.getPreview('20:1');
    assert.deepEqual(f.previews.at(-1), { fileKey: FILE, ids: ['20:1'] });
    await f.methods.syncBatchItems([{ id: items[2].id, enabled: false }, { id: items[0].id, enabled: true }]);
    assert.deepEqual((await f.methods.getBatchState()).items.map(({ id, enabled }) => ({ id, enabled })),
        [{ id: items[2].id, enabled: false }, { id: items[0].id, enabled: true }]);
    await assert.rejects(async () => f.methods.activateBatchItem(items[1].id), /过期|不存在|重新添加/);
});

test('main source resolution excludes overlapping Figma operations and recovers when the first finishes', async (t) => {
    const f = fixture(t);
    const blocked = deferred();
    f.blockSource(blocked);
    const pending = f.methods.resolveBatchSource(link('20:1'));
    try {
        await assert.rejects(f.methods.resolveBatchSource(link('20:2')), /正在|当前|完成/);
        await assert.rejects(f.methods.fetchDocument(link('20:3')), /正在|当前|完成/);
        await assert.rejects(f.methods.roundtripDetect(link('20:1')), /正在|当前|完成/);
    } finally { blocked.resolve(); }
    await pending;
    assert.equal(f.requests.length, 1);
    assert.equal((await f.methods.resolveBatchSource(link('20:2'))).added, 1);
});

test('main rejects stale items and conflicting effective root names before importing any prefab', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    const stale = f.request(items);
    stale.items[1].id = 'expired-item';
    await assert.rejects(f.methods.importBatch(stale), /过期|失效|不存在|重新添加/);
    const collision = f.request(items);
    for (const [index, item] of collision.items.entries()) item.overrides = [{
        id: items[index].rootId, name: 'Same Output', action: 'generate', kind: 'node', nineSlice: false, explicit: true,
    }];
    await assert.rejects(f.methods.importBatch(collision), /输出名称冲突/);
    assert.equal(f.imports.length, 0);
    assert.equal((await f.methods.getBatchState()).running, undefined);
});

test('batch hidden-layer filtering imports only visible roots while retaining the original source list', async (t) => {
    const f = fixture(t);
    f.nodes.get('20:2').visible = false;
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    assert.equal(items.length, 3);
    const request = f.request(items);
    request.settings.importHiddenLayers = false;
    const result = await f.methods.importBatch(request);
    assert.deepEqual(f.imports.map((item) => item.sourceNodeId), ['20:1', '20:3']);
    assert.equal(result.total, 2);
    assert.equal(result.completed, 2);
    assert.equal((await f.methods.getBatchState()).items.length, 3, 'filtering must not remove source entries');
    assert.equal(f.nodes.get('20:2').visible, false);
});

test('an all-hidden batch is rejected before any prefab import when hidden layers are disabled', async (t) => {
    const f = fixture(t);
    for (const id of ['20:1', '20:2', '20:3']) f.nodes.get(id).visible = false;
    await f.methods.resolveBatchSource(link('10:1'));
    const request = f.request((await f.methods.getBatchState()).items);
    request.settings.importHiddenLayers = false;
    await assert.rejects(f.methods.importBatch(request), /均已隐藏|没有.*可见/);
    assert.equal(f.imports.length, 0);
    assert.equal((await f.methods.getBatchState()).running, undefined);
});

for (const importHiddenLayers of [true, undefined]) {
    test(`a batch keeps hidden prefab roots when hidden import is ${importHiddenLayers ?? 'missing from legacy settings'}`, async (t) => {
        const f = fixture(t);
        for (const id of ['20:1', '20:2', '20:3']) f.nodes.get(id).visible = false;
        await f.methods.resolveBatchSource(link('10:1'));
        const request = f.request((await f.methods.getBatchState()).items);
        if (importHiddenLayers === undefined) delete request.settings.importHiddenLayers;
        else request.settings.importHiddenLayers = importHiddenLayers;
        const result = await f.methods.importBatch(request);
        assert.equal(result.total, 3);
        assert.deepEqual(f.imports.map((item) => item.sourceNodeId), ['20:1', '20:2', '20:3']);
        assert.ok(f.imports.every((item) => item.roots[0].visible === false));
    });
}

test('main imports screens serially, locks changes while running, and retains every completed result', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    const started = deferred();
    const release = deferred();
    let concurrent = 0;
    let maximum = 0;
    f.setImporter(async (args) => {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        if (args.sourceNodeId === '20:1') { started.resolve(); await release.promise; }
        concurrent--;
        return {};
    });
    const pending = f.methods.importBatch(f.request(items));
    await Promise.race([started.promise, pending.then(() => { throw new Error('Batch ended before importing its first prefab'); })]);
    try {
        assert.equal(f.imports.length, 1);
        await assert.rejects(f.methods.resolveBatchSource(link('20:1')), /批量|正在|当前/);
        await assert.rejects(async () => f.methods.activateBatchItem(items[1].id), /批量|正在|当前/);
        await assert.rejects(async () => f.methods.syncBatchItems([]), /批量|正在|当前/);
        await assert.rejects(f.methods.importSelection({ settings: DEFAULT_SETTINGS, overrides: [] }), /批量|正在|当前/);
        for (const method of ['roundtripDetect', 'roundtripPreview', 'roundtripPair', 'roundtripApply']) {
            await assert.rejects(f.methods[method](link('20:1')), /批量|正在|当前/);
        }
    } finally { release.resolve(); }
    const result = await pending;
    assert.equal(maximum, 1);
    assert.deepEqual(f.imports.map((item) => item.sourceNodeId), ['20:1', '20:2', '20:3']);
    assert.equal(result.completed, 3);
    assert.equal(result.stopped, false);
    assert.ok(result.items.every((item) => item.status === 'success'));
    assert.equal(new Set(result.items.map((item) => item.reviewId)).size, 3);
    assert.ok(result.items.every((item) => item.reviewId));
    assert.deepEqual((await f.methods.getBatchState()).lastResult, result);
    const historical = await f.methods.getImportReview(result.items[0].reviewId);
    assert.equal(historical.id, result.items[0].reviewId);
    assert.ok(historical.readOnlyReason);
    assert.equal((await f.methods.getImportReview()).id, result.items[2].reviewId);
});

test('main prevents a batch and ordinary Figma operations from overlapping an active roundtrip', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    await f.methods.activateBatchItem(items[0].id);
    const started = deferred();
    const release = deferred();
    t.mock.method(RoundtripService.prototype, 'detect', async () => {
        started.resolve(); await release.promise; return { detected: true };
    });
    const pending = f.methods.roundtripDetect(link('20:1'));
    await Promise.race([started.promise, pending.then(() => { throw new Error('Roundtrip ended before fixture started'); })]);
    try {
        await assert.rejects(f.methods.importBatch(f.request(items)), /Round.trip|往返|当前|正在/i);
        await assert.rejects(f.methods.importSelection({ settings: DEFAULT_SETTINGS, overrides: [] }), /Round.trip|往返|当前|正在/i);
        await assert.rejects(f.methods.resolveBatchSource(link('20:1')), /Round.trip|往返|当前|正在/i);
        await assert.rejects(f.methods.activateBatchItem(items[1].id), /Round.trip|往返|当前|正在/i);
        await assert.rejects(f.methods.getPreview('20:1'), /Round.trip|往返|当前|正在/i);
        assert.equal(f.imports.length, 0);
    } finally { release.resolve(); }
    assert.deepEqual(await pending, { detected: true });
    assert.equal((await f.methods.activateBatchItem(items[1].id)).tree[0].id, '20:2');
});

test('main ordinary failure can continue or stop without losing completed item outcomes', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    f.setImporter(async (args) => {
        if (args.sourceNodeId === '20:2') throw new Error('fixture import failed');
        return {};
    });
    const continued = await f.methods.importBatch(f.request(items));
    assert.deepEqual(continued.items.map((item) => item.status), ['success', 'failed', 'success']);
    assert.match(continued.items[1].error, /fixture import failed/);
    assert.equal(Boolean(continued.items[1].requiresAttention), false);
    assert.equal(continued.stopped, false);
    const stopped = await f.methods.importBatch(f.request(items, 'stop'));
    assert.deepEqual(stopped.items.map((item) => item.status), ['success', 'failed', 'pending']);
    assert.equal(stopped.stopped, true);
    assert.deepEqual((await f.methods.getBatchState()).lastResult, stopped);
});

test('main retry merges its subset into the full result and preserves previous successful reports', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    f.setImporter(async (args) => {
        if (args.sourceNodeId === '20:2') throw new Error('temporary network problem');
        return {};
    });
    const first = await f.methods.importBatch(f.request(items));
    assert.deepEqual(first.items.map((item) => item.status), ['success', 'failed', 'success']);
    f.setImporter(async () => ({}));
    const retried = await f.methods.importBatch({ ...f.request([items[1]]), preserveResults: true });
    assert.equal(retried.total, 3);
    assert.equal(retried.completed, 3);
    assert.deepEqual(retried.items.map((item) => item.id), items.map((item) => item.id));
    assert.deepEqual(retried.items.map((item) => item.status), ['success', 'success', 'success']);
    assert.equal(retried.items[0].reviewId, first.items[0].reviewId);
    assert.equal(retried.items[2].reviewId, first.items[2].reviewId);
    assert.ok(retried.items[1].reviewId);
    assert.equal(retried.items[1].error, undefined);
    assert.deepEqual(f.imports.map((item) => item.sourceNodeId), ['20:1', '20:2', '20:3', '20:2']);
    assert.deepEqual((await f.methods.getBatchState()).lastResult, retried);
    const previousReport = await f.methods.getImportReview(first.items[0].reviewId);
    assert.ok(previousReport, 'a successful original item keeps its report after retrying a different screen');
    assert.ok(previousReport.readOnlyReason);
});

test('main stop request finishes the active prefab and leaves later screens pending', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const items = (await f.methods.getBatchState()).items;
    const started = deferred();
    const release = deferred();
    f.setImporter(async () => { started.resolve(); await release.promise; return {}; });
    const pending = f.methods.importBatch(f.request(items));
    await Promise.race([started.promise, pending.then(() => { throw new Error('Batch ended before importing its first prefab'); })]);
    try { await f.methods.stopImportBatch(); }
    finally { release.resolve(); }
    const result = await pending;
    assert.deepEqual(result.items.map((item) => item.status), ['success', 'pending', 'pending']);
    assert.equal(result.completed, 1);
    assert.equal(result.stopped, true);
    assert.equal(f.imports.length, 1);
});

for (const problem of ['ambiguous-save', 'dirty-target', 'dirty-query-unavailable']) {
    test(`main stops after ${problem} even when ordinary failures are configured to continue`, async (t) => {
        const f = fixture(t);
        await f.methods.resolveBatchSource(link('10:1'));
        const items = (await f.methods.getBatchState()).items;
        f.setImporter(async () => {
            if (problem === 'dirty-target') f.setDirty(true);
            if (problem === 'dirty-query-unavailable') f.failDirty();
            const error = new Error(problem);
            if (problem === 'ambiguous-save') error.requiresAttention = true;
            throw error;
        });
        const result = await f.methods.importBatch(f.request(items));
        assert.deepEqual(result.items.map((item) => item.status), ['failed', 'pending', 'pending']);
        assert.equal(result.items[0].requiresAttention, true);
        assert.equal(result.stopped, true);
        assert.equal(f.imports.length, 1);
    });
}

for (const failure of ['save-timeout', 'rollback-failed']) {
    test(`the real Prefab transaction marks ${failure} as requiring attention`, async (t) => {
        const f = fixture(t);
        const rootFileId = 'rootFile1234';
        const transformFileId = 'transformFile1234';
        const record = createPrefabSyncRecord(figmaFrameSourceHash(FILE, '20:1'), '20:1', rootFileId, transformFileId);
        f.hooks.setPrefabPreparation(async () => ({
            info: { uuid: 'prefab-uuid', url: 'db://assets/prefabs/Home.prefab' }, record,
        }));
        f.hooks.setPrefabOpen(async () => {});
        f.hooks.setPrefabAssertion(async () => {});
        const calls = [];
        t.mock.method(global.Editor.Message, 'request', async (channel, method) => {
            calls.push({ channel, method });
            if (method === 'query-dirty') return false;
            if (method === 'snapshot') return;
            if (method === 'execute-scene-script') {
                if (failure === 'rollback-failed') throw new Error('scene import failed');
                return { prefabSync: { nodeFileIds: { '20:1': rootFileId },
                    managedNodeFileIds: [rootFileId], managedComponentFileIds: [transformFileId], managedHelperFileIds: [] } };
            }
            if (method === 'save-scene') throw new Error('save IPC timeout');
            if (method === 'snapshot-abort') throw new Error('rollback IPC timeout');
            throw new Error(`Unexpected Creator request: ${channel}/${method}`);
        });
        await assert.rejects(f.hooks.linkedImporter({
            reviewId: 'review', prefabUrl: 'db://assets/prefabs/Home.prefab', prefabName: 'Home',
            fileKey: FILE, sourceNodeId: '20:1', rootFrame: { x: 0, y: 0, width: 320, height: 480 }, scale: 1,
            roots: [{ figmaId: '20:1', children: [] }],
        }), (error) => {
            assert.equal(error.requiresAttention, true);
            assert.match(error.message, failure === 'save-timeout' ? /save IPC timeout/ : /scene import failed/);
            return true;
        });
        assert.equal(calls.some((call) => call.method === 'save-scene'), failure === 'save-timeout');
        assert.equal(calls.some((call) => call.method === 'snapshot-abort'), failure === 'rollback-failed');
    });
}

test('main keeps single frame import and MCP document sessions compatible after adding batch entries', async (t) => {
    const f = fixture(t);
    await f.methods.resolveBatchSource(link('10:1'));
    const api = new FigmaImporterMcpApi({
        projectPath: global.Editor.Project.path, creatorVersion: '3.8.7',
        getDocumentRevision: f.hooks.revision, isImportBusy: f.hooks.busy,
        getState: f.hooks.getMcpState, fetchDocument: f.methods.fetchDocument,
        getPreview: f.methods.getPreview, saveSettings: f.methods.saveSettings,
        saveNodeOverrides: f.methods.saveNodeOverrides,
        importSelection: f.hooks.performImport,
        cancelImport: () => false,
    });
    const session = await api.invoke('fetchDocument', { sourceUrl: link('20:2') });
    assert.ok(session.documentSessionId);
    const result = await api.invoke('importDocument', {
        documentSessionId: session.documentSessionId, operationId: 'single-batch-compat', confirm: true,
    });
    assert.equal(result.result.completed, true);
    assert.equal(result.result.created, 1);
    assert.equal(result.result.reviewAvailable, true);
    assert.deepEqual(f.imports.map((item) => item.sourceNodeId), ['20:2']);
    assert.equal((await f.methods.getBatchState()).items.length, 3);
});
