'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { compactSlicePng } = require('../dist/importer/sliced-png');

function source(width, height) {
    const image = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            image.data[offset] = x * 20;
            image.data[offset + 1] = y * 20;
            image.data[offset + 2] = 200;
            image.data[offset + 3] = 255;
        }
    }
    return PNG.sync.write(image);
}

function node(width, height) {
    return {
        id: '1:1', name: 'img_panel', type: 'FRAME', visible: true, children: [],
        absoluteBoundingBox: { x: 0, y: 0, width, height }, rotation: 0,
        opacity: 1, clipsContent: false, fills: [], strokes: [], strokeWeight: 0,
        effects: [], hasExportSettings: false, itemSpacing: 0, counterAxisSpacing: 0,
        paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0,
    };
}

function pixel(image, x, y) {
    return Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
}

test('compacts a horizontal three-slice PNG and preserves fixed edge pixels', () => {
    const contents = source(10, 4);
    const result = compactSlicePng(contents, node(10, 4), {
        mode: 'horizontal', borders: { left: 2, right: 3, top: 0, bottom: 0 },
    }, 1);
    assert.ok(result);
    const image = PNG.sync.read(result.contents);
    assert.equal(image.width, 7);
    assert.equal(image.height, 4);
    assert.deepEqual(result.borders, { left: 2, right: 3, top: 0, bottom: 0 });
    assert.deepEqual(pixel(image, 0, 3), [0, 60, 200, 255]);
    assert.deepEqual(pixel(image, 6, 3), [180, 60, 200, 255]);
});

test('compacts a nine-slice PNG to a two-pixel logical center at scale one', () => {
    const contents = source(10, 9);
    const result = compactSlicePng(contents, node(10, 9), {
        mode: 'nine', borders: { left: 2, right: 3, top: 1, bottom: 2 },
    }, 1);
    assert.ok(result);
    const image = PNG.sync.read(result.contents);
    assert.equal(image.width, 7);
    assert.equal(image.height, 5);
    assert.deepEqual(result.borders, { left: 2, right: 3, top: 1, bottom: 2 });
    assert.deepEqual(pixel(image, 0, 0), [0, 0, 200, 255]);
    assert.deepEqual(pixel(image, 6, 4), [180, 160, 200, 255]);
});

test('retains two logical pixels in the stretchable center at high-resolution export', () => {
    const result = compactSlicePng(source(20, 8), node(10, 4), {
        mode: 'horizontal', borders: { left: 2, right: 3, top: 0, bottom: 0 },
    }, 2);
    assert.ok(result);
    const image = PNG.sync.read(result.contents);
    assert.equal(image.width, 14);
    assert.deepEqual(result.borders, { left: 4, right: 6, top: 0, bottom: 0 });
});

test('rejects rotated slice nodes rather than producing an offset texture', () => {
    const rotated = node(10, 4);
    rotated.rotation = 15;
    assert.equal(compactSlicePng(source(10, 4), rotated, {
        mode: 'horizontal', borders: { left: 2, right: 3, top: 0, bottom: 0 },
    }, 1), null);
});
