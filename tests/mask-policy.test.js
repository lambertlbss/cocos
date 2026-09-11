'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldGenerateMask, setMaskShapeSafely } = require('../dist/mask-policy');

const container = {
    action: 'generate', kind: 'node', figmaType: 'FRAME',
    clipsContent: true, children: [{}],
};

for (const [name, overrides, target, shouldMask, reason, maskType = null] of [
    ['root', { isRoot: true }, 'node', false, 'import-root'],
    ['unclipped frame', { clipsContent: false }, 'node', false, 'clip-content-disabled'],
    ['empty decoration', { children: [] }, 'node', false, 'no-children'],
    ['flattened PNG', { action: 'render' }, 'node', false, 'not-generated-container'],
    ['sprite', { sprite: { tiled: true } }, 'node', false, 'rasterized-node'],
    ['transform', { action: 'transform' }, 'node', false, 'not-generated-container'],
    ['text', { figmaType: 'TEXT' }, 'node', false, 'not-container'],
    ['explicit container', {}, 'node', true, 'explicit-clip-content', 'rectangle'],
    ['ellipse', { figmaType: 'ELLIPSE' }, 'node', true, 'explicit-clip-content', 'ellipse'],
    ['scroll owner', { kind: 'scrollView' }, 'node', false, 'delegated-to-scroll-view'],
    ['root scroll viewport', { isRoot: true, kind: 'scrollView', clipsContent: false }, 'scroll-view', true, 'scroll-view-viewport', 'rectangle'],
    ['flattened scroll', { kind: 'scrollView', action: 'render' }, 'scroll-view', false, 'not-generated-scroll-view'],
    ['ellipse image helper', { isRoot: true, action: 'render', figmaType: 'ELLIPSE', sprite: { tiled: true }, children: [] }, 'tiled-helper', true, 'tiled-ellipse-shape', 'ellipse'],
]) {
    test(`Mask policy: ${name}`, () => {
        assert.deepEqual(shouldGenerateMask({ ...container, ...overrides }, target), {
            shouldMask, reason, maskType,
        });
    });
}

function unloadedMask(type = 0, inverted = false) {
    return {
        _type: type, _inverted: inverted, subComp: null,
        get type() { return this._type; },
        set type(_) { throw new Error('type setter must not initialize hidden renderers'); },
        get inverted() { return this._inverted; },
        set inverted(_) { throw new Error("Cannot set properties of null (setting 'stencilStage')"); },
    };
}

test('Mask defaults skip unsafe identical setters before onLoad', () => {
    const mask = unloadedMask();
    setMaskShapeSafely(mask, 0);
    assert.equal(mask.subComp, null);
});

test('Mask serialized shape/inversion are configured without activating a hidden renderer', () => {
    const mask = unloadedMask(0, true);
    setMaskShapeSafely(mask, 1);
    assert.equal(mask._type, 1);
    assert.equal(mask._inverted, false);
    assert.equal(mask.subComp, null);
});

test('initialized Masks use public setters only for changed values', () => {
    const changes = [];
    const mask = {
        _type: 0, _inverted: true, subComp: {},
        get type() { return this._type; },
        set type(value) { changes.push('type'); this._type = value; },
        get inverted() { return this._inverted; },
        set inverted(value) { changes.push('inverted'); this._inverted = value; },
    };
    setMaskShapeSafely(mask, 1);
    setMaskShapeSafely(mask, 1);
    assert.deepEqual(changes, ['type', 'inverted']);
});

test('unknown uninitialized engine layout fails explicitly instead of swallowing errors', () => {
    assert.throws(() => setMaskShapeSafely({ type: 0, inverted: true, subComp: null }, 1), /引擎字段不兼容/);
});
