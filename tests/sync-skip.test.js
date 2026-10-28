'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
