'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { canonicalStringify, sha256 } = require('../dist/roundtrip/canonical-json');
const { projectCocosPrefab, readCocosPrefabByUuid } = require('../dist/roundtrip/cocos-reader');
const { createSyncId } = require('../dist/roundtrip/protocol');

const PREFAB_UUID = '01234567-89ab-cdef-0123-456789abcdef';

function prefabFixture() {
    return [
        { __type__: 'cc.Prefab', _uuid: PREFAB_UUID, data: { __id__: 1 } },
        {
            __type__: 'cc.Node',
            _name: 'Root',
            _parent: null,
            _children: [{ __id__: 2 }],
            _components: [{ __id__: 5 }],
            _prefab: { __id__: 3 },
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            __type__: 'cc.Node',
            _name: 'Child',
            _parent: { __id__: 1 },
            _children: [],
            _components: [{ __id__: 7 }, { __id__: 9 }, { __id__: 11 }],
            _prefab: { __id__: 4 },
            _lpos: { x: 10, y: 20, z: 3 },
        },
        { __type__: 'cc.PrefabInfo', fileId: 'root-file-id' },
        { __type__: 'cc.PrefabInfo', fileId: 'child-file-id' },
        {
            __type__: 'cc.UITransform',
            _contentSize: { width: 200, height: 100 },
            _anchorPoint: { x: 0.5, y: 0.5 },
            __prefab: { __id__: 6 },
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'root-transform' },
        {
            __type__: 'cc.UITransform',
            _contentSize: { width: 100, height: 40 },
            _anchorPoint: { x: 0.25, y: 0.75 },
            __prefab: { __id__: 8 },
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'child-transform' },
        {
            __type__: 'cc.Sprite',
            _spriteFrame: { __uuid__: 'fedcba98-7654-3210-fedc-ba9876543210@f9941' },
            _type: 0,
            _sizeMode: 0,
            __prefab: { __id__: 10 },
        },
        { __type__: 'cc.CompPrefabInfo', fileId: 'child-sprite' },
        { __type__: 'ExampleScript', enabled: true, score: 7 },
    ];
}

function geometry(parentSyncId = null) {
    return {
        mappingVersion: 1,
        sourceAnchor: { x: 0.5, y: 0.5 },
        sourceScale: { x: 1, y: 1 },
        figmaBaselineLocalRect: { x: 0, y: 0, width: 1, height: 1 },
        parentSyncId,
        figmaBaselineRelativeTransform: [[1, 0, 0], [0, 1, 0]],
        dependencySyncIds: [],
        dependencyHash: `sha256:${'0'.repeat(64)}`,
    };
}

function baseline() {
    const rootLocator = {
        ownerPrefabUuid: PREFAB_UUID,
        sourcePrefabUuid: PREFAB_UUID,
        instanceChain: [],
        nodeFileId: 'root-file-id',
    };
    const childLocator = { ...rootLocator, nodeFileId: 'child-file-id' };
    const rootSyncId = createSyncId(rootLocator);
    const childSyncId = createSyncId(childLocator);
    return [{
        syncId: rootSyncId,
        locator: rootLocator,
        componentLocators: {
            uiTransform: { strategy: 'comp-prefab-file-id', componentType: 'cc.UITransform', fileId: 'root-transform' },
        },
        cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
        position: { x: 0, y: 0 },
        contentSize: { width: 200, height: 100 },
        editable: ['contentSize.wh'],
        geometry: geometry(),
    }, {
        syncId: childSyncId,
        locator: childLocator,
        componentLocators: {
            uiTransform: { strategy: 'comp-prefab-file-id', componentType: 'cc.UITransform', fileId: 'child-transform' },
            sprite: { strategy: 'comp-prefab-file-id', componentType: 'cc.Sprite', fileId: 'child-sprite' },
        },
        cocosStructure: { parentNodeFileId: 'root-file-id', siblingIndex: 0 },
        position: { x: 10, y: 20 },
        contentSize: { width: 100, height: 40 },
        spriteFrameUuid: 'fedcba98-7654-3210-fedc-ba9876543210@f9941',
        editable: ['position.xy', 'contentSize.wh', 'spriteFrame.uuid'],
        geometry: geometry(rootSyncId),
    }];
}

function bytes(value) {
    return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

const metaBytes = bytes({ uuid: PREFAB_UUID, importer: 'prefab' });

test('Cocos reader resolves stable node/component identities and projects B/C leaves', () => {
    const projection = projectCocosPrefab(bytes(prefabFixture()), metaBytes, baseline(), PREFAB_UUID);
    assert.equal(projection.nodes.length, 2);
    assert.deepEqual(projection.nodes[1], {
        syncId: baseline()[1].syncId,
        position: { x: 10, y: 20 },
        contentSize: { width: 100, height: 40 },
        spriteFrameUuid: 'fedcba98-7654-3210-fedc-ba9876543210@f9941',
    });
});

test('Cocos reader keeps nested readonly nodes static without claiming a direct fileId', () => {
    const nodes = baseline();
    const nestedLocator = {
        ownerPrefabUuid: PREFAB_UUID,
        sourcePrefabUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        instanceChain: [{ instanceNodeFileId: 'instance-a', sourcePrefabUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
        nodeFileId: 'nested-file-id',
    };
    nodes.push({
        ...nodes[1],
        syncId: createSyncId(nestedLocator),
        locator: nestedLocator,
        componentLocators: {},
        cocosStructure: { parentNodeFileId: 'child-file-id', siblingIndex: 0 },
        editable: [],
    });
    const projection = projectCocosPrefab(bytes(prefabFixture()), metaBytes, nodes, PREFAB_UUID);
    assert.deepEqual(projection.nodes[2].position, nodes[2].position);
});

test('preserve projection ignores only writable leaves and catches script drift', () => {
    const original = prefabFixture();
    const first = projectCocosPrefab(bytes(original), metaBytes, baseline(), PREFAB_UUID);
    const writableOnly = prefabFixture();
    writableOnly[2]._lpos.x = 999;
    writableOnly[7]._contentSize.width = 321;
    writableOnly[9]._spriteFrame = { __uuid__: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@f9941' };
    const second = projectCocosPrefab(bytes(writableOnly), metaBytes, baseline(), PREFAB_UUID);
    assert.equal(second.preserveProjectionHash, first.preserveProjectionHash);

    const scriptDrift = prefabFixture();
    scriptDrift[11].score = 8;
    const third = projectCocosPrefab(bytes(scriptDrift), metaBytes, baseline(), PREFAB_UUID);
    assert.notEqual(third.preserveProjectionHash, first.preserveProjectionHash);
});

test('unique component locator enforces the exporter masked fingerprint', () => {
    const fixture = prefabFixture();
    delete fixture[7].__prefab;
    const masked = JSON.parse(JSON.stringify(fixture[7]));
    masked._contentSize = '__ROUNDTRIP_EDITABLE__';
    const nodes = baseline();
    nodes[1].componentLocators.uiTransform = {
        strategy: 'unique-component-type',
        componentType: 'cc.UITransform',
        baselineFingerprint: sha256(canonicalStringify(masked)),
    };
    assert.doesNotThrow(() => projectCocosPrefab(bytes(fixture), metaBytes, nodes, PREFAB_UUID));
    fixture[7]._anchorPoint.x = 0.75;
    assert.throws(() => projectCocosPrefab(bytes(fixture), metaBytes, nodes, PREFAB_UUID), /fingerprint/);
});

test('AssetDB resolver reads exact bytes only from a contained writable Prefab', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'figma-cocos-reader-'));
    try {
        const folder = join(projectRoot, 'assets', 'ui');
        await mkdir(folder, { recursive: true });
        const prefabPath = join(folder, 'fixture.prefab');
        await writeFile(prefabPath, bytes(prefabFixture()));
        await writeFile(`${prefabPath}.meta`, metaBytes);
        const result = await readCocosPrefabByUuid({
            projectRoot,
            prefabUuid: PREFAB_UUID,
            baseline: baseline(),
            assetDb: {
                queryAssetInfo: async () => ({
                    uuid: PREFAB_UUID,
                    url: 'db://assets/ui/fixture.prefab',
                    importer: 'prefab',
                    type: 'cc.Prefab',
                    imported: true,
                    invalid: false,
                }),
            },
        });
        assert.equal(result.assetUrl, 'db://assets/ui/fixture.prefab');
        assert.equal(result.prefabPath, resolve(prefabPath));
        assert.deepEqual(result.prefabBytes, bytes(prefabFixture()));
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});
