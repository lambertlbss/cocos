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

test('accepts the sparse native nested instance saved and reopened by Creator 3.8.7', () => {
    const contents = readFileSync(join(__dirname, 'fixtures/prefab-reference/creator-3.8.7/host.prefab'), 'utf8');
    const entries = JSON.parse(contents);
    const info = entries.find(item => item.__type__ === 'cc.PrefabInfo' && item.instance);
    const instance = entries[info.instance.__id__];
    const record = createPrefabSyncRecord(figmaFrameSourceHash(FILE_KEY, '1:1'), '1:1',
        'host-root-file-id', 'host-ui-file-id');
    record.prefabInstances = { 'host-root-file-id': { assetUuid: info.asset.__uuid__, instanceFileId: instance.fileId } };
    assert.equal(prefabJsonContainsSyncRecord(contents, record), true);
    const sizeOverride = instance.propertyOverrides.map(ref => entries[ref.__id__])
        .find(item => item.propertyPath.includes('_contentSize'));
    assert.deepEqual(sizeOverride.value, { __type__: 'cc.Size', width: 200, height: 120 });
    assert.equal(entries[info.root.__id__]._name, undefined, 'Creator serializes linked roots sparsely');
    info.asset.__uuid__ = 'another-prefab';
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(entries), record), false);
});
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

test('schema 1 persists exact Prefab attachments and rejects unowned or duplicated identities', () => {
    const capture = { nodeFileIds: { [ROOT_NODE_ID]: ROOT_FILE_ID, [CHILD_NODE_ID]: CHILD_FILE_ID },
        managedNodeFileIds: [ROOT_FILE_ID, CHILD_FILE_ID], managedComponentFileIds: [ROOT_TRANSFORM_FILE_ID],
        managedHelperFileIds: [], prefabInstances: {
            [CHILD_FILE_ID]: { assetUuid: 'NESTED-PREFAB-UUID', instanceFileId: 'nested-instance-file' },
        } };
    const record = recordPrefabSyncCapture(initialRecord(), capture);
    assert.deepEqual(readPrefabSyncRecord(mergePrefabSyncRecord({}, record)), record);
    assert.equal(record.prefabInstances[CHILD_FILE_ID].assetUuid, 'nested-prefab-uuid');
    assert.equal(recordPrefabSyncCapture(record, { ...capture, prefabInstances: undefined }).prefabInstances, undefined);
    assert.equal(Object.hasOwn(initialRecord(), 'prefabInstances'), false);
    for (const prefabInstances of [
        { 'unowned-carrier': capture.prefabInstances[CHILD_FILE_ID] },
        { [CHILD_FILE_ID]: { assetUuid: '', instanceFileId: 'nested-instance-file' } },
        { [CHILD_FILE_ID]: { assetUuid: 'nested-prefab', instanceFileId: 'short' } },
        { [CHILD_FILE_ID]: capture.prefabInstances[CHILD_FILE_ID], [ROOT_FILE_ID]: capture.prefabInstances[CHILD_FILE_ID] },
    ]) {
        assert.throws(() => readPrefabSyncRecord(mergePrefabSyncRecord({}, { ...record, prefabInstances })), /实例|fileId/);
    }
});

test('saved Prefab audit namespaces nested source identities and verifies exact carrier links', () => {
    const data = JSON.parse(createMinimalPrefabJson('Frame', { width: 100, height: 80 }, ROOT_FILE_ID, ROOT_TRANSFORM_FILE_ID));
    data[1]._children = [];
    const attachmentMap = {};
    for (let i = 1; i <= 2; i++) {
        const carrierFileId = `carrier-file-id-${i}`;
        const carrierIndex = data.length;
        const nestedIndex = carrierIndex + 2;
        data[1]._children.push({ __id__: carrierIndex });
        data.push(
            { __type__: 'cc.Node', _prefab: { __id__: carrierIndex + 1 }, _children: [{ __id__: nestedIndex }] },
            { __type__: 'cc.PrefabInfo', fileId: carrierFileId, root: { __id__: 1 }, asset: { __id__: 0 } },
            { __type__: 'cc.Node', _prefab: { __id__: nestedIndex + 1 } },
            { __type__: 'cc.PrefabInfo', fileId: 'shared-source-root', root: { __id__: nestedIndex },
                asset: { __uuid__: 'nested-asset-uuid' }, instance: { __id__: nestedIndex + 2 } },
            { __type__: 'cc.PrefabInstance', fileId: `nested-instance-${i}` },
            { __type__: 'cc.Sprite', node: { __id__: nestedIndex }, __prefab: { __id__: nestedIndex + 4 } },
            { __type__: 'cc.CompPrefabInfo', fileId: 'shared-source-component' },
        );
        attachmentMap[carrierFileId] = { assetUuid: 'nested-asset-uuid', instanceFileId: `nested-instance-${i}` };
    }
    const record = { ...initialRecord(), managedNodeFileIds: [ROOT_FILE_ID, ...Object.keys(attachmentMap)],
        prefabInstances: attachmentMap };
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(data), record), true);
    const invalid = JSON.parse(JSON.stringify(data));
    invalid.find(entry => entry.__type__ === 'cc.PrefabInstance').fileId = 'tampered-instance';
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(invalid), record), false);
    const unlinked = JSON.parse(JSON.stringify(data));
    delete unlinked.find(entry => entry.asset?.__uuid__).asset;
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(unlinked), record), false);
    data.push({ __type__: 'cc.PrefabInfo', fileId: 'carrier-file-id-1' });
    assert.equal(prefabJsonContainsSyncRecord(JSON.stringify(data), record), false);
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
