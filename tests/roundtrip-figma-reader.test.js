'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { roundtripFilePath } = require('../dist/figma/client');
const {
    fetchRoundtripFile,
    indexRoundtripFile,
    managedRootIds,
    parseRoundtripSource,
    selectManagedRoot,
} = require('../dist/roundtrip/figma-reader');
const { readonlyVisualFingerprint, parseManagedDocument } = require('../dist/roundtrip/figma-projector');
const { canonicalStringify } = require('../dist/roundtrip/canonical-json');
const { forwardGeometry } = require('../dist/roundtrip/geometry');
const {
    baselineChunks,
    canonicalHeaderJson,
    createSyncId,
    createVisualId,
} = require('../dist/roundtrip/protocol');

test('round-trip REST path explicitly requests full shared plugin data', () => {
    const path = roundtripFilePath('A/B');
    assert.match(path, /^\/v1\/files\/A%2FB\?/);
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    assert.equal(query.get('plugin_data'), 'shared');
    assert.equal(query.get('geometry'), 'paths');
});

test('reader indexes the complete file and selects the unique ancestor root', async () => {
    const payload = JSON.parse(await readFile(
        resolve('tests/fixtures/roundtrip/rest/shared-plugin-data-file.json'),
        'utf8',
    ));
    const indexed = indexRoundtripFile(payload);
    assert.deepEqual(managedRootIds(indexed), ['1:1', '2:1']);
    assert.equal(selectManagedRoot(indexed, { descendantNodeId: '1:2' }).id, '1:1');
    assert.throws(() => selectManagedRoot(indexed), /多个 managed root/);
    await assert.doesNotReject(async () => {
        const fetched = await fetchRoundtripFile({ getRoundtripFile: async () => payload }, { fileKey: 'redacted' });
        assert.equal(fetched.version, '1234567890');
    });
});

test('reader rejects historical links, missing versions and duplicate node ids', () => {
    assert.throws(
        () => parseRoundtripSource('https://figma.com/design/AbCdEf123456/Test?version-id=42'),
        /当前版本/,
    );
    assert.throws(() => indexRoundtripFile({ document: { id: '0:0', type: 'DOCUMENT' } }), /version/);
    assert.throws(() => indexRoundtripFile({
        version: '1',
        document: {
            id: '0:0',
            type: 'DOCUMENT',
            children: [{ id: 'same', type: 'FRAME' }, { id: 'same', type: 'FRAME' }],
        },
    }), /重复 node id/);
});

function managedPayload() {
    const prefabUuid = '01234567-89ab-cdef-0123-456789abcdef';
    const locator = {
        ownerPrefabUuid: prefabUuid,
        sourcePrefabUuid: prefabUuid,
        instanceChain: [],
        nodeFileId: 'root-file-id',
    };
    const syncId = createSyncId(locator);
    const visualId = createVisualId('00000000-0000-4000-8000-000000000001');
    const projected = forwardGeometry({
        position: { x: 10, y: 20 },
        contentSize: { width: 100, height: 50 },
        anchor: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
    }, null);
    const frame = {
        id: '1:1',
        type: 'FRAME',
        relativeTransform: projected.relativeTransform,
        size: { x: projected.localRect.width, y: projected.localRect.height },
        fills: [],
        sharedPluginData: { cocosfigmabridge: {} },
    };
    const nodeMeta = {
        schemaVersion: 1,
        role: 'direct',
        visualId,
        syncId,
        editable: ['contentSize.wh'],
    };
    const baseline = {
        schemaVersion: 1,
        prefabUuid,
        nodes: [{
            syncId,
            locator,
            componentLocators: {
                uiTransform: {
                    strategy: 'comp-prefab-file-id',
                    componentType: 'cc.UITransform',
                    fileId: 'ui-root',
                },
            },
            cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
            position: { x: 10, y: 20 },
            contentSize: { width: 100, height: 50 },
            editable: ['contentSize.wh'],
            geometry: {
                mappingVersion: 1,
                sourceAnchor: { x: 0.5, y: 0.5 },
                sourceScale: { x: 1, y: 1 },
                figmaBaselineLocalRect: projected.localRect,
                parentSyncId: null,
                figmaBaselineRelativeTransform: projected.relativeTransform,
                dependencySyncIds: [],
                dependencyHash: `sha256:${'0'.repeat(64)}`,
            },
        }],
        visualManifest: [{
            visualId,
            role: 'direct',
            syncId,
            parentVisualId: null,
            siblingOrder: 0,
            figmaNodeType: 'FRAME',
            readonlyVisualFingerprint: readonlyVisualFingerprint(frame, false),
        }],
        resources: [],
    };
    const encoded = baselineChunks(baseline);
    const header = {
        schemaVersion: 1,
        surfaceId: '00000000-0000-4000-8000-000000000002',
        producer: { name: 'fixture', version: '0.9.0+roundtrip' },
        prefab: {
            uuid: prefabUuid,
            sourceHash: `sha256:${'1'.repeat(64)}`,
            metaSourceHash: `sha256:${'2'.repeat(64)}`,
        },
        baseline: {
            encoding: 'canonical-json',
            chunkKeys: encoded.chunkKeys,
            byteLength: encoded.byteLength,
            sha256: encoded.sha256,
        },
        capabilities: { editable: ['contentSize.wh'], nestedWrite: false, structureWrite: false },
        exportedAt: '2026-08-21T00:00:00.000Z',
    };
    frame.sharedPluginData.cocosfigmabridge['rt.header'] = canonicalHeaderJson(header);
    frame.sharedPluginData.cocosfigmabridge['rt.node'] = canonicalStringify(nodeMeta);
    encoded.chunkKeys.forEach((key, index) => {
        frame.sharedPluginData.cocosfigmabridge[key] = encoded.chunks[index];
    });
    return {
        version: 'fixture-version-1',
        document: { id: '0:0', type: 'DOCUMENT', children: [{ id: '0:1', type: 'CANVAS', children: [frame] }] },
    };
}

test('managed parser validates embedded baseline and projects current Figma geometry', () => {
    const payload = managedPayload();
    payload.document.children[0].children.unshift({ id: '0:2', type: 'FRAME' });
    const indexed = indexRoundtripFile(payload);
    const parsed = parseManagedDocument(indexed, selectManagedRoot(indexed));
    assert.equal(parsed.baseline.nodes.length, 1);
    assert.deepEqual(parsed.figmaProjection[0].position, { x: 10, y: 20 });
    assert.deepEqual(parsed.figmaProjection[0].contentSize, { width: 100, height: 50 });
});

test('managed parser fails closed on undeclared chunks and readonly visual drift', () => {
    const extra = managedPayload();
    const frame = extra.document.children[0].children[0];
    frame.sharedPluginData.cocosfigmabridge['rt.baseline.9999'] = 'damage';
    let indexed = indexRoundtripFile(extra);
    assert.throws(() => parseManagedDocument(indexed, selectManagedRoot(indexed)), /未声明/);

    const drift = managedPayload();
    drift.document.children[0].children[0].opacity = 0.5;
    indexed = indexRoundtripFile(drift);
    assert.throws(() => parseManagedDocument(indexed, selectManagedRoot(indexed)), /fingerprint/);
});

test('managed parser rejects resource binding without direct editable paint proof', () => {
    const payload = managedPayload();
    const frame = payload.document.children[0].children[0];
    const meta = JSON.parse(frame.sharedPluginData.cocosfigmabridge['rt.node']);
    frame.sharedPluginData.cocosfigmabridge['rt.resource'] = canonicalStringify({
        schemaVersion: 1,
        syncId: meta.syncId,
        componentLocatorRef: 'sprite',
        boundUuid: 'fedcba98-7654-3210-fedc-ba9876543210@f9941',
        intent: 'explicit-rebind',
        paintVisualId: meta.visualId,
        paintFingerprint: `sha256:${'0'.repeat(64)}`,
    });
    const indexed = indexRoundtripFile(payload);
    assert.throws(() => parseManagedDocument(indexed, selectManagedRoot(indexed)), /resource binding/);
});
