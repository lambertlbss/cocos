'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const canonical = require('../dist/roundtrip/canonical-json');
const geometry = require('../dist/roundtrip/geometry');
const protocol = require('../dist/roundtrip/protocol');

const locator = {
    ownerPrefabUuid: '01234567-89ab-cdef-0123-456789abcdef',
    sourcePrefabUuid: '01234567-89ab-cdef-0123-456789abcdef',
    instanceChain: [],
    nodeFileId: 'root-file-id',
};

function baseline() {
    const syncId = protocol.createSyncId(locator);
    return {
        schemaVersion: 1,
        prefabUuid: locator.ownerPrefabUuid,
        nodes: [{
            syncId,
            locator,
            componentLocators: {},
            cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
            position: { x: -0, y: 2.34565 },
            contentSize: { width: 320, height: 96 },
            editable: ['contentSize.wh', 'position.xy'],
            geometry: {
                mappingVersion: 1,
                sourceAnchor: { x: 0.5, y: 0.5 },
                sourceScale: { x: 1, y: 1 },
                figmaBaselineLocalRect: { x: 0, y: 0, width: 320, height: 96 },
                parentSyncId: null,
                figmaBaselineRelativeTransform: [[1, 0, 0], [0, 1, 0]],
                dependencySyncIds: [],
                dependencyHash: `sha256:${'0'.repeat(64)}`,
            },
        }],
        visualManifest: [{
            visualId: 'cfv1:00000000-0000-4000-8000-000000000001',
            role: 'direct',
            syncId,
            parentVisualId: null,
            siblingOrder: 0,
            figmaNodeType: 'FRAME',
            readonlyVisualFingerprint: `sha256:${'0'.repeat(64)}`,
        }],
        resources: [],
    };
}

function headerFor(input) {
    const encoded = protocol.baselineChunks(input);
    return {
        schemaVersion: 1,
        surfaceId: '00000000-0000-4000-8000-000000000002',
        producer: { name: 'cocos-prefab-to-figma-plugin', version: '0.9.0+roundtrip' },
        prefab: {
            uuid: locator.ownerPrefabUuid,
            sourceHash: `sha256:${'1'.repeat(64)}`,
            metaSourceHash: `sha256:${'2'.repeat(64)}`,
        },
        baseline: {
            encoding: 'canonical-json',
            chunkKeys: encoded.chunkKeys,
            byteLength: encoded.byteLength,
            sha256: encoded.sha256,
        },
        capabilities: {
            editable: ['position.xy', 'contentSize.wh'],
            nestedWrite: false,
            structureWrite: false,
        },
        exportedAt: '2026-08-21T00:00:00.000Z',
    };
}

test('frozen round-trip files match the exporter manifest byte-for-byte', async () => {
    const manifestPath = resolve('tests/fixtures/roundtrip/protocol-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of manifest.files) {
        const path = entry.path.startsWith('src/shared/')
            ? resolve('tests/fixtures/roundtrip/frozen', entry.path)
            : resolve(entry.path);
        const actual = `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
        assert.equal(actual, entry.sha256, entry.path);
    }
});

test('canonical JSON, SHA-256 and quantization match frozen vectors', async () => {
    assert.equal(
        canonical.canonicalStringify({ z: -0, a: '中文', nested: { y: 2, x: 1 } }),
        '{"a":"中文","nested":{"x":1,"y":2},"z":0}',
    );
    assert.throws(() => canonical.parseCanonicalJson('{"b":1,"a":2}'), /canonical/);
    const vectors = JSON.parse(await readFile(
        resolve('tests/fixtures/roundtrip/canonical/hash-vectors.json'),
        'utf8',
    ));
    for (const vector of vectors.sha256) {
        assert.equal(canonical.sha256(vector.utf8), vector.expected);
    }
    for (const vector of vectors.quantize4) {
        assert.equal(canonical.quantizeDecimal(vector.input), vector.expected);
    }
    assert.deepEqual(canonical.chunkUtf8('A😀中B', 4), ['A', '😀', '中B']);
});

test('protocol validates canonical baseline chunks and fails closed on damage', () => {
    const input = baseline();
    const encoded = protocol.baselineChunks(input);
    const header = headerFor(input);
    const chunks = new Map(encoded.chunkKeys.map((key, index) => [key, encoded.chunks[index]]));

    assert.deepEqual(protocol.decodeBaseline(header, chunks), JSON.parse(encoded.canonical));
    assert.match(protocol.createSyncId(locator), /^cfn1:[0-9a-f]{64}$/);
    assert.equal(protocol.parseRootHeader(protocol.canonicalHeaderJson(header)).surfaceId, header.surfaceId);
    chunks.set(encoded.chunkKeys[0], `${encoded.chunks[0]}x`);
    assert.throws(() => protocol.decodeBaseline(header, chunks), /byteLength|checksum/);
});

test('geometry v1 matches the frozen vector and inverts deterministic positive scales', async () => {
    const fixture = JSON.parse(await readFile(
        resolve('tests/fixtures/roundtrip/geometry/vectors.json'),
        'utf8',
    ));
    for (const vector of fixture.vectors) {
        assert.deepEqual(geometry.forwardGeometry(vector.node, vector.parent), vector.figma);
    }

    let state = 0xc0c05f1a;
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    for (let index = 0; index < 1000; index += 1) {
        const node = {
            position: { x: (next() - 0.5) * 2000, y: (next() - 0.5) * 2000 },
            contentSize: { width: next() * 800, height: next() * 800 },
            anchor: { x: next(), y: next() },
            scale: { x: 0.1 + next() * 3, y: 0.1 + next() * 3 },
        };
        const parent = {
            contentSize: { width: next() * 1200, height: next() * 1200 },
            anchor: { x: next(), y: next() },
        };
        const projected = geometry.forwardGeometry(node, parent);
        const inverted = geometry.inverseGeometry(projected, {
            mappingVersion: 1,
            ...projected,
            sourceAnchor: node.anchor,
            sourceScale: node.scale,
            parent,
            parentSyncId: null,
            dependencySyncIds: [],
            dependencyHash: `sha256:${'0'.repeat(64)}`,
        });
        assert.ok(Math.abs(inverted.position.x - node.position.x) <= 0.0001);
        assert.ok(Math.abs(inverted.position.y - node.position.y) <= 0.0001);
        assert.ok(Math.abs(inverted.contentSize.width - node.contentSize.width) <= 0.0001);
        assert.ok(Math.abs(inverted.contentSize.height - node.contentSize.height) <= 0.0001);
    }
});

test('Creator 3.8.7 imported Prefab/meta fixture keeps the stable write locators', async () => {
    const prefab = JSON.parse(await readFile(
        resolve('tests/fixtures/roundtrip/creator-3.8.7/roundtrip-fixture.prefab'),
        'utf8',
    ));
    const meta = JSON.parse(await readFile(
        resolve('tests/fixtures/roundtrip/creator-3.8.7/roundtrip-fixture.prefab.meta'),
        'utf8',
    ));

    assert.deepEqual(
        {
            ver: meta.ver,
            importer: meta.importer,
            imported: meta.imported,
            uuid: meta.uuid,
        },
        {
            ver: '1.1.50',
            importer: 'prefab',
            imported: true,
            uuid: '2d63d5c0-9a46-42ae-bda6-b17f784889cc',
        },
    );
    assert.equal(prefab[0].__type__, 'cc.Prefab');
    assert.equal(prefab[0].data.__id__, 1);
    assert.equal(prefab[3].__type__, 'cc.PrefabInfo');
    assert.equal(prefab[3].fileId, 'fixture-root-file-id');
});
