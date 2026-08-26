'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
    PREFAB_SYNC_KIND,
    PREFAB_SYNC_SCHEMA,
    createMinimalPrefabJson,
    createPrefabSyncRecord,
    figmaFrameSourceHash,
    figmaNodeIdentityKey,
    mergePrefabSyncRecord,
    planPrefabRecoveryTarget,
    prefabJsonContainsSyncRecord,
    readPrefabSyncRecord,
    recordPrefabSyncCapture,
    resolveExistingNodeFileIds,
} = require('../dist/importer/prefab-sync');

const FILE_KEY = 'SensitiveFigmaFileKey123';
const ROOT_NODE_ID = '410:4756';
const CHILD_NODE_ID = '410:4757';
const ROOT_FILE_ID = 'root-file-id';
const ROOT_TRANSFORM_FILE_ID = 'root-transform-id';
const CHILD_FILE_ID = 'child-file-id';

function initialRecord() {
    return createPrefabSyncRecord(
        figmaFrameSourceHash(FILE_KEY, ROOT_NODE_ID),
        ROOT_NODE_ID,
        ROOT_FILE_ID,
        ROOT_TRANSFORM_FILE_ID,
    );
}

test('hashes the Figma Frame source without leaking the file key or raw node id', () => {
    const sourceHash = figmaFrameSourceHash(FILE_KEY, '410-4756');

    assert.match(sourceHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(sourceHash, figmaFrameSourceHash(FILE_KEY, ROOT_NODE_ID));
    assert.equal(sourceHash.includes(FILE_KEY), false);
    assert.equal(sourceHash.includes('410-4756'), false);
    assert.equal(sourceHash.includes(ROOT_NODE_ID), false);
});

test('merges the sync record into meta without dropping unrelated fields', () => {
    const source = {
        ver: '1.0.0',
        importer: 'prefab',
        imported: true,
        userData: {
            compressionType: 'normal',
            customTool: { enabled: true },
        },
        subMetas: { retained: { uuid: 'existing-sub-meta' } },
    };
    const record = initialRecord();
    const merged = mergePrefabSyncRecord(source, record);

    assert.equal(merged.ver, source.ver);
    assert.equal(merged.importer, source.importer);
    assert.equal(merged.imported, true);
    assert.deepEqual(merged.subMetas, source.subMetas);
    assert.equal(merged.userData.compressionType, 'normal');
    assert.deepEqual(merged.userData.customTool, { enabled: true });
    assert.deepEqual(merged.userData.figmaImporter, record);
    assert.equal(source.userData.figmaImporter, undefined);
});

test('fails closed when an existing sync source record is malformed', () => {
    const valid = initialRecord();
    const malformedRecords = [
        'plaintext-source-record',
        { ...valid, schema: PREFAB_SYNC_SCHEMA + 1 },
        { ...valid, kind: 'another-kind' },
        { ...valid, sourceHash: `${FILE_KEY}:${ROOT_NODE_ID}` },
        { ...valid, nodeFileIds: { [ROOT_NODE_ID]: ROOT_FILE_ID } },
        { ...valid, managedNodeFileIds: [] },
    ];

    for (const figmaImporter of malformedRecords) {
        assert.throws(
            () => readPrefabSyncRecord({ userData: { figmaImporter } }),
            /figmaImporter|来源|指纹|fileId|所有权|版本|类型|节点/,
        );
    }
    assert.equal(readPrefabSyncRecord({ userData: { unrelated: true } }), null);
});

test('creates a five-entry Cocos Prefab with stable root and component fileIds', () => {
    const prefab = JSON.parse(createMinimalPrefabJson(
        'Popup/Instruction\\View',
        { x: 12, y: 34, width: 640, height: 1136 },
        ROOT_FILE_ID,
        ROOT_TRANSFORM_FILE_ID,
    ));

    assert.equal(prefab.length, 5);
    assert.deepEqual(prefab.map((entry) => entry.__type__), [
        'cc.Prefab',
        'cc.Node',
        'cc.UITransform',
        'cc.CompPrefabInfo',
        'cc.PrefabInfo',
    ]);
    assert.equal(prefab[0].data.__id__, 1);
    assert.equal(prefab[1]._name, 'Popup Instruction View');
    assert.deepEqual(prefab[1]._components, [{ __id__: 2 }]);
    assert.equal(prefab[1]._prefab.__id__, 4);
    assert.equal(prefab[2].node.__id__, 1);
    assert.equal(prefab[2].__prefab.__id__, 3);
    assert.deepEqual(prefab[2]._contentSize, {
        __type__: 'cc.Size',
        width: 640,
        height: 1136,
    });
    assert.deepEqual(prefab[2]._anchorPoint, { __type__: 'cc.Vec2', x: 0.5, y: 0.5 });
    assert.equal(prefab[3].fileId, ROOT_TRANSFORM_FILE_ID);
    assert.equal(prefab[4].root.__id__, 1);
    assert.equal(prefab[4].asset.__id__, 0);
    assert.equal(prefab[4].fileId, ROOT_FILE_ID);
});

test('stores captured Figma node identities only as hashes in prefab meta', () => {
    const captured = recordPrefabSyncCapture(initialRecord(), {
        nodeFileIds: {
            '410-4756': ROOT_FILE_ID,
            [CHILD_NODE_ID]: CHILD_FILE_ID,
        },
        managedNodeFileIds: [CHILD_FILE_ID, ROOT_FILE_ID, CHILD_FILE_ID],
        managedComponentFileIds: ['child-transform-id', ROOT_TRANSFORM_FILE_ID],
        managedHelperFileIds: ['generated-helper-id'],
    });
    const metaText = JSON.stringify(mergePrefabSyncRecord({ userData: {} }, captured));

    assert.equal(metaText.includes(FILE_KEY), false);
    assert.equal(metaText.includes('410-4756'), false);
    assert.equal(metaText.includes(ROOT_NODE_ID), false);
    assert.equal(metaText.includes(CHILD_NODE_ID), false);
    assert.deepEqual(Object.keys(captured.nodeFileIds).sort(), [
        figmaNodeIdentityKey(captured.sourceHash, ROOT_NODE_ID),
        figmaNodeIdentityKey(captured.sourceHash, CHILD_NODE_ID),
    ].sort());
    assert.deepEqual(captured.managedNodeFileIds, [CHILD_FILE_ID, ROOT_FILE_ID].sort());
});

test('reads existing hashed node mappings and resolves their Cocos fileIds', () => {
    const captured = recordPrefabSyncCapture(initialRecord(), {
        nodeFileIds: {
            [ROOT_NODE_ID]: ROOT_FILE_ID,
            [CHILD_NODE_ID]: CHILD_FILE_ID,
        },
        managedNodeFileIds: [ROOT_FILE_ID, CHILD_FILE_ID],
        managedComponentFileIds: [ROOT_TRANSFORM_FILE_ID],
        managedHelperFileIds: [],
    });
    const parsed = readPrefabSyncRecord(mergePrefabSyncRecord({
        userData: { retained: 'value' },
    }, captured));

    assert.ok(parsed);
    assert.equal(parsed.schema, PREFAB_SYNC_SCHEMA);
    assert.equal(parsed.kind, PREFAB_SYNC_KIND);
    assert.equal(parsed.rootFileId, ROOT_FILE_ID);
    assert.deepEqual(resolveExistingNodeFileIds(parsed, [
        '410-4756',
        CHILD_NODE_ID,
        '999:999',
    ]), {
        [ROOT_NODE_ID]: ROOT_FILE_ID,
        [CHILD_NODE_ID]: CHILD_FILE_ID,
    });
});

test('verifies that persisted Prefab bytes contain every managed fileId', () => {
    const seed = createMinimalPrefabJson(
        'Frame',
        { x: 0, y: 0, width: 100, height: 80 },
        ROOT_FILE_ID,
        ROOT_TRANSFORM_FILE_ID,
    );
    assert.equal(prefabJsonContainsSyncRecord(seed, initialRecord()), true);

    const captured = recordPrefabSyncCapture(initialRecord(), {
        nodeFileIds: {
            [ROOT_NODE_ID]: ROOT_FILE_ID,
            [CHILD_NODE_ID]: CHILD_FILE_ID,
        },
        managedNodeFileIds: [ROOT_FILE_ID, CHILD_FILE_ID],
        managedComponentFileIds: [ROOT_TRANSFORM_FILE_ID, 'child-transform-id'],
        managedHelperFileIds: ['generated-helper-id'],
    });
    assert.equal(prefabJsonContainsSyncRecord(seed, captured), false);

    const complete = JSON.parse(seed);
    complete.push(
        { __type__: 'cc.PrefabInfo', fileId: CHILD_FILE_ID },
        { __type__: 'cc.PrefabInfo', fileId: 'generated-helper-id' },
        { __type__: 'cc.CompPrefabInfo', fileId: 'child-transform-id' },
        { __type__: 'cc.PrefabInstance', fileId: 'nested-prefab-instance-id' },
    );
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(complete), captured), true);
    complete.push({ __type__: 'cc.PrefabInfo', fileId: CHILD_FILE_ID });
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(complete), captured), false);
});

test('prioritizes pending Prefab identity and clears only a missing recovery target', () => {
    assert.deepEqual(planPrefabRecoveryTarget('pending-uuid', 'bound-uuid', true), {
        targetUuid: 'pending-uuid',
        clearPending: false,
        clearBinding: false,
    });
    assert.deepEqual(planPrefabRecoveryTarget('missing-uuid', 'missing-uuid', false), {
        targetUuid: undefined,
        clearPending: true,
        clearBinding: true,
    });
    assert.deepEqual(planPrefabRecoveryTarget('missing-uuid', 'valid-bound-uuid', false), {
        targetUuid: 'valid-bound-uuid',
        clearPending: true,
        clearBinding: false,
    });
    assert.deepEqual(planPrefabRecoveryTarget(undefined, 'bound-uuid', false), {
        targetUuid: 'bound-uuid',
        clearPending: false,
        clearBinding: false,
    });
});

test('retains pending Prefab recovery state when save outcome is ambiguous', () => {
    const mainSource = readFileSync(join(__dirname, '..', 'source', 'main.ts'), 'utf8');
    assert.match(mainSource, /snapshotStarted\s*&&\s*!saveAttempted/);
    assert.doesNotMatch(mainSource, /snapshotStarted\s*&&\s*!sceneSaved/);
    assert.doesNotMatch(mainSource, /pendingStored\s*&&\s*!sceneSaved/);
    assert.doesNotMatch(
        mainSource,
        /snapshot-abort'[\s\S]{0,300}setPendingPrefabSync\(sourceHash,\s*null\)/,
    );
});
