'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hiddenLayerIds } = require('../dist/import-visibility');

test('hidden layers are included by default and source visibility is never changed', () => {
    const roots = [{ id: 'hidden', visible: false, children: [{ id: 'child', visible: true, children: [] }] }];
    const original = JSON.stringify(roots);
    assert.deepEqual([...hiddenLayerIds(roots)], []);
    assert.deepEqual([...hiddenLayerIds(roots, true)], []);
    assert.equal(JSON.stringify(roots), original);
});

test('excluding hidden layers marks the complete subtree even when descendants are locally visible', () => {
    const roots = [{ id: 'root', visible: true, children: [
        { id: 'hidden', visible: false, children: [
            { id: 'visible-child', visible: true, children: [{ id: 'grandchild', children: [] }] },
            { id: 'hidden-child', visible: false, children: [] },
        ] },
        { id: 'visible-sibling', visible: true, children: [] },
    ] }];
    const original = JSON.stringify(roots);
    assert.deepEqual([...hiddenLayerIds(roots, false)], ['hidden', 'visible-child', 'grandchild', 'hidden-child']);
    assert.equal(JSON.stringify(roots), original);
});

test('zero opacity, missing visibility, and hidden paints do not mean a hidden layer', () => {
    const roots = [{ id: 'root', children: [
        { id: 'transparent', visible: true, opacity: 0, children: [] },
        { id: 'hidden-paint', visible: true, fills: [{ visible: false }], children: [] },
        { id: 'missing-visibility', children: [] },
    ] }];
    assert.deepEqual([...hiddenLayerIds(roots, false)], []);
});
