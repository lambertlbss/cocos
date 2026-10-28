'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    collectPrefabComponentFileIds,
    createPrefabSyncRecord,
    figmaNodeIdentityKey,
    readPrefabSyncRecord,
    recordPrefabSyncCapture,
    retainPrefabSyncEntries,
} = require('../dist/importer/prefab-sync');

const SOURCE_HASH = 'sha256:' + 'a'.repeat(64);
const FILE_ID = 'fileIdRoot0001';
const FILE_ID_TRANSFORM = 'fileIdTransform1';

function baseRecord() {
    return createPrefabSyncRecord(SOURCE_HASH, '1:1', FILE_ID, FILE_ID_TRANSFORM);
}

test('unchecked nodes keep their fileId mapping in the next record', () => {
    const previous = baseRecord();
    const skippedKey = figmaNodeIdentityKey(SOURCE_HASH, '1:20');
    const keptKey = figmaNodeIdentityKey(SOURCE_HASH, '1:30');
    const withNodes = {
        ...previous,
        nodeFileIds: {
            ...previous.nodeFileIds,
            [skippedKey]: 'fileIdSkipped01',
            [keptKey]: 'fileIdKept0001',
        },
        managedNodeFileIds: [...previous.managedNodeFileIds, 'fileIdSkipped01', 'fileIdKept0001'].sort(),
    };
    // 本次只重建了 1:30，1:20 因为未勾选而缺席。
    const next = recordPrefabSyncCapture(withNodes, {
        nodeFileIds: { '1:1': FILE_ID, '1:30': 'fileIdKept0001' },
        managedNodeFileIds: [FILE_ID, 'fileIdKept0001'],
        managedComponentFileIds: [FILE_ID_TRANSFORM],
        managedHelperFileIds: [],
    });
    assert.equal(next.nodeFileIds[skippedKey], undefined);

    const retained = retainPrefabSyncEntries(withNodes, next, ['1:20']);
    assert.equal(retained.nodeFileIds[skippedKey], 'fileIdSkipped01');
    assert.equal(retained.managedNodeFileIds.includes('fileIdSkipped01'), true);
    assert.equal(retained.nodeFileIds[keptKey], 'fileIdKept0001');
    assert.equal(retained.rootFileId, next.rootFileId);

    // 序列化后仍可被读取（写回 Meta 的路径不变）。
    assert.equal(readPrefabSyncRecord({ userData: { figmaImporter: retained } }).managedNodeFileIds
        .includes('fileIdSkipped01'), true);
});

test('retaining nothing returns the same record', () => {
    const previous = baseRecord();
    const next = recordPrefabSyncCapture(previous, {
        nodeFileIds: { '1:1': FILE_ID },
        managedNodeFileIds: [FILE_ID],
        managedComponentFileIds: [FILE_ID_TRANSFORM],
        managedHelperFileIds: [],
    });
    assert.equal(retainPrefabSyncEntries(previous, next, []), next);
    assert.equal(retainPrefabSyncEntries(previous, next, ['9:9']), next);
});

test('component fileIds of a retained node come back from the saved prefab', () => {
    const prefab = JSON.stringify([
        { __type__: 'cc.Prefab' },
        {
            __type__: 'cc.Node',
            _name: 'icon_phb_bang2',
            _components: [{ __id__: 2 }, { __id__: 4 }],
            _prefab: { __id__: 6 },
        },
        { __type__: 'cc.UITransform', __prefab: { __id__: 3 } },
        { __type__: 'cc.CompPrefabInfo', fileId: 'componentId001' },
        { __type__: 'marker', node: { __id__: 1 }, __prefab: { __id__: 5 } },
        { __type__: 'cc.CompPrefabInfo', fileId: 'componentId002' },
        { __type__: 'cc.PrefabInfo', fileId: 'nodeFileId001' },
        {
            __type__: 'cc.Node',
            _name: 'other',
            _components: [{ __id__: 8 }],
            _prefab: { __id__: 10 },
        },
        { __type__: 'cc.UITransform', __prefab: { __id__: 9 } },
        { __type__: 'cc.CompPrefabInfo', fileId: 'componentId003' },
        { __type__: 'cc.PrefabInfo', fileId: 'nodeFileId002' },
    ]);
    assert.deepEqual(collectPrefabComponentFileIds(prefab, ['nodeFileId001']), [
        'componentId001',
        'componentId002',
    ]);
    assert.deepEqual(collectPrefabComponentFileIds(prefab, ['nodeFileId002']), ['componentId003']);
    assert.deepEqual(collectPrefabComponentFileIds(prefab, []), []);
    assert.deepEqual(collectPrefabComponentFileIds(prefab, ['missing']), []);
    assert.deepEqual(collectPrefabComponentFileIds('not json', ['nodeFileId001']), []);
});
