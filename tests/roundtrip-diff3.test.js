'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiff3Plan } = require('../dist/roundtrip/diff3');
const { createSyncId } = require('../dist/roundtrip/protocol');

function fixture(editable = ['position.xy', 'contentSize.wh']) {
    const locator = {
        ownerPrefabUuid: '01234567-89ab-cdef-0123-456789abcdef',
        sourcePrefabUuid: '01234567-89ab-cdef-0123-456789abcdef',
        instanceChain: [],
        nodeFileId: 'node-a',
    };
    const syncId = createSyncId(locator);
    const baseline = {
        syncId,
        locator,
        componentLocators: {
            uiTransform: { strategy: 'comp-prefab-file-id', componentType: 'cc.UITransform', fileId: 'ui-a' },
        },
        cocosStructure: { parentNodeFileId: null, siblingIndex: 0 },
        position: { x: 10, y: 20 },
        contentSize: { width: 100, height: 50 },
        editable,
        geometry: {
            mappingVersion: 1,
            sourceAnchor: { x: 0.5, y: 0.5 },
            sourceScale: { x: 1, y: 1 },
            figmaBaselineLocalRect: { x: -40, y: -5, width: 100, height: 50 },
            parentSyncId: null,
            figmaBaselineRelativeTransform: [[1, 0, -40], [0, 1, -5]],
            dependencySyncIds: [],
            dependencyHash: `sha256:${'0'.repeat(64)}`,
        },
    };
    const state = (overrides = {}) => ({
        syncId,
        position: { ...baseline.position },
        contentSize: { ...baseline.contentSize },
        ...overrides,
    });
    return { baseline, state };
}

test('Diff3 converges equal states with no patch', () => {
    const { baseline, state } = fixture();
    const plan = createDiff3Plan({ baseline: [baseline], figma: [state()], cocos: [state()] });
    assert.equal(plan.apply.length, 0);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.unsupported.length, 0);
    assert.equal(plan.converged.length, 4);
});

test('Diff3 applies Figma-only leaves and preserves the other Cocos axis', () => {
    const { baseline, state } = fixture();
    const plan = createDiff3Plan({
        baseline: [baseline],
        figma: [state({ position: { x: 15.12345, y: 20 } })],
        cocos: [state({ position: { x: 10, y: 25 } })],
    });
    assert.deepEqual(plan.apply, [{
        kind: 'set-position-xy',
        syncId: baseline.syncId,
        nodeFileId: 'node-a',
        from: { x: 10, y: 25 },
        to: { x: 15.1235, y: 25 },
    }]);
    assert.deepEqual(plan.applyLeaves.map((entry) => entry.field), ['position.x']);
    assert.ok(plan.preserveCocos.some((entry) => entry.field === 'position.y'));
});

test('Diff3 preserves Cocos-only changes and conflicts when both sides diverge', () => {
    const { baseline, state } = fixture();
    const preserved = createDiff3Plan({
        baseline: [baseline],
        figma: [state()],
        cocos: [state({ contentSize: { width: 120, height: 50 } })],
    });
    assert.equal(preserved.apply.length, 0);
    assert.ok(preserved.preserveCocos.some((entry) => entry.field === 'contentSize.width'));

    const conflict = createDiff3Plan({
        baseline: [baseline],
        figma: [state({ position: { x: 11, y: 20 } })],
        cocos: [state({ position: { x: 12, y: 20 } })],
    });
    assert.equal(conflict.apply.length, 0);
    assert.deepEqual(conflict.conflicts.map((entry) => entry.field), ['position.x']);
});

test('Diff3 reports readonly edits as unsupported but readonly no-op as static', () => {
    const { baseline, state } = fixture([]);
    const noOp = createDiff3Plan({ baseline: [baseline], figma: [state()], cocos: [state()] });
    assert.equal(noOp.readonlyUnchanged.length, 4);
    assert.equal(noOp.unsupported.length, 0);

    const changed = createDiff3Plan({
        baseline: [baseline],
        figma: [state({ position: { x: 11, y: 20 } })],
        cocos: [state()],
    });
    assert.deepEqual(changed.unsupported.map((entry) => entry.field), ['position.x']);
});

test('Diff3 becomes a no-op after applying its result', () => {
    const { baseline, state } = fixture();
    const first = createDiff3Plan({
        baseline: [baseline],
        figma: [state({ contentSize: { width: 111, height: 55 } })],
        cocos: [state()],
    });
    assert.equal(first.apply.length, 1);
    const second = createDiff3Plan({
        baseline: [baseline],
        figma: [state({ contentSize: { width: 111, height: 55 } })],
        cocos: [state({ contentSize: { width: 111, height: 55 } })],
    });
    assert.equal(second.apply.length, 0);
    assert.equal(second.conflicts.length, 0);
    assert.equal(second.converged.filter((entry) => entry.field.startsWith('contentSize.')).length, 2);
});
