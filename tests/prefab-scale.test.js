'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planPrefabScale } = require('../dist/importer/prefab-scale');

function source(overrides = {}) {
    return { width: 100, height: 50, scale: { x: 1, y: 1, z: 1 }, ...overrides };
}

function assertRejected(input, ratio, importScale = 1) {
    const result = planPrefabScale(input, ratio, importScale);
    assert.equal(result.scale, undefined);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
}

test('Prefab scale applies only Figma instance-to-master multipliers despite unrelated engine dimensions', () => {
    const ratio = { x: 2, y: 2 };
    assert.deepEqual(planPrefabScale(source(), ratio), { scale: { x: 2, y: 2, z: 1 } });
    assert.deepEqual(planPrefabScale(source({ width: 640, height: 960 }), ratio), { scale: { x: 2, y: 2, z: 1 } });
    assert.deepEqual(planPrefabScale(source({ width: 1, height: 10000 }), ratio), { scale: { x: 2, y: 2, z: 1 } });
    assert.deepEqual(planPrefabScale(source(), { x: 0.25, y: 0.25 }), { scale: { x: 0.25, y: 0.25, z: 1 } });
    assert.deepEqual(planPrefabScale(source(), { x: 1, y: 1 }), { scale: { x: 1, y: 1, z: 1 } });
});

test('independent Figma XY multipliers preserve authored proportions without any ratio-matching gate', () => {
    const input = source({ scale: { x: 2, y: 3, z: 0.4 } });
    assert.deepEqual(planPrefabScale(input, { x: 2, y: 0.5 }), { scale: { x: 4, y: 1.5, z: 0.4 } });
    assert.deepEqual(planPrefabScale(input, { x: 1.001, y: 8 }), { scale: { x: 2.002, y: 24, z: 0.4 } });
    assert.deepEqual(planPrefabScale(input, { x: 2, y: 0.5 }, 0.25), { scale: { x: 1, y: 0.375, z: 0.4 } });
});

test('negative authored scales retain horizontal, vertical and double mirroring', () => {
    for (const signs of [[-1, 1], [1, -1], [-1, -1]]) {
        const input = source({ scale: { x: signs[0] * 2, y: signs[1] * 3, z: -2 } });
        assert.deepEqual(planPrefabScale(input, { x: 0.5, y: 2 }, 2),
            { scale: { x: signs[0] * 2, y: signs[1] * 12, z: -2 } });
    }
    assert.deepEqual(planPrefabScale(source({ scale: { x: 1, y: 1, z: 0 } }), { x: 2, y: 2 }),
        { scale: { x: 2, y: 2, z: 0 } });
});

test('repeated imports derive absolute scale from source without accumulation or input mutation', () => {
    const scale = Object.freeze({ x: 1.5, y: 0.75, z: 1 });
    const input = Object.freeze({ width: 72, height: 48, scale });
    const ratio = Object.freeze({ x: 2, y: 4 });
    const first = planPrefabScale(input, ratio, 0.5);
    assert.deepEqual(first.scale, { x: 1.5, y: 1.5, z: 1 });
    assert.deepEqual(planPrefabScale(input, ratio, 0.5), first);
    assert.deepEqual(planPrefabScale(input, { x: 1, y: 1 }).scale, scale);
    assert.equal(input.scale, scale);
    assert.deepEqual(input.scale, { x: 1.5, y: 0.75, z: 1 });
    assert.deepEqual(ratio, { x: 2, y: 4 });
});

test('engine UI dimensions are not read or validated when applying Figma multipliers', () => {
    const input = { scale: { x: 1, y: 2, z: 1 },
        get width() { throw new Error('must not consult engine width'); },
        get height() { throw new Error('must not consult engine height'); } };
    assert.deepEqual(planPrefabScale(input, { x: 3, y: 0.5 }), { scale: { x: 3, y: 1, z: 1 } });
    assert.deepEqual(planPrefabScale(source({ width: NaN, height: -1 }), { x: 2, y: 3 }),
        { scale: { x: 2, y: 3, z: 1 } });
});

test('invalid Figma multipliers, import factors and authored scales never produce a write plan', () => {
    for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
        assertRejected(source(), { x: invalid, y: 1 });
        assertRejected(source(), { x: 1, y: invalid });
        assertRejected(source(), { x: 1, y: 1 }, invalid);
    }
    for (const axis of ['x', 'y', 'z']) {
        for (const invalid of [NaN, Infinity, -Infinity]) {
            assertRejected(source({ scale: { x: 1, y: 1, z: 1, [axis]: invalid } }), { x: 1, y: 1 });
        }
    }
    for (const axis of ['x', 'y']) {
        assertRejected(source({ scale: { x: 1, y: 1, z: 1, [axis]: 0 } }), { x: 1, y: 1 });
        assertRejected(source({ scale: { x: 1, y: 1, z: 1, [axis]: -0 } }), { x: 1, y: 1 });
    }
    assertRejected(source(), undefined);
    assertRejected(source(), { x: 1 });
    assertRejected({ scale: undefined }, { x: 1, y: 1 });
});

test('overflow and underflow in either resulting XY scale are rejected before writing', () => {
    assertRejected(source({ scale: { x: Number.MAX_VALUE, y: 1, z: 1 } }), { x: 2, y: 1 });
    assertRejected(source({ scale: { x: 1, y: Number.MAX_VALUE, z: 1 } }), { x: 1, y: 2 });
    assertRejected(source(), { x: Number.MAX_VALUE, y: 1 }, 2);
    assertRejected(source(), { x: 1, y: Number.MAX_VALUE }, 2);
    assertRejected(source({ scale: { x: Number.MIN_VALUE, y: 1, z: 1 } }), { x: 0.5, y: 1 });
    assertRejected(source({ scale: { x: 1, y: Number.MIN_VALUE, z: 1 } }), { x: 1, y: 0.5 });
    assertRejected(source(), { x: Number.MIN_VALUE, y: 1 }, 0.5);
    assertRejected(source(), { x: 1, y: Number.MIN_VALUE }, 0.5);
});
