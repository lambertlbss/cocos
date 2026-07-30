'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gradientSvg } = require('../dist/importer/svg');

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
