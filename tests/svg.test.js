'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gradientPng, gradientSvg } = require('../dist/importer/svg');

test('generates deterministic scalable gradient assets', () => {
    const svg = gradientSvg(120, 60, {
        type: 'GRADIENT_LINEAR',
        opacity: 1,
        gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
        gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
    }, [8, 8, 8, 8]);
    assert.match(svg, /linearGradient/);
    assert.match(svg, /rx="8"/);
    assert.match(svg, /rgb\(255,0,0\)/);
    assert.match(svg, /stop-opacity="1\.0000"/);
});

test('rasterizes gradients to a Cocos-compatible PNG', () => {
    const png = gradientPng(12, 6, {
        type: 'GRADIENT_LINEAR',
        opacity: 1,
        gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
        gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
    }, [2, 2, 2, 2], 2);
    assert.ok(png);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 24);
    assert.equal(png.readUInt32BE(20), 12);
});
