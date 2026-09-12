'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { rasterizeTile, tiledRasterKey, pixelSizedTileAsset } = require('../dist/importer/tiled-png');
const { AssetWriter } = require('../dist/importer/assets');

function png(width, height, color = [120, 80, 40, 255]) {
    const image = new PNG({ width, height });
    for (let i = 0; i < image.data.length; i += 4) image.data.set(color, i);
    return PNG.sync.write(image);
}

test('IMAGE tile bakes Figma 50% into 13x14 PNG pixels and unit-scale asset', () => {
    const source = png(26, 28), copy = Buffer.from(source);
    const result = rasterizeTile(source, 0.5);
    const image = PNG.sync.read(result.contents);
    assert.deepEqual([image.width, image.height], [13, 14]);
    assert.deepEqual([...image.data.subarray(0, 4)], [120, 80, 40, 255]);
    assert.equal(result.rounded, false);
    assert.deepEqual(source, copy);
    const old = { uuid: 'frame', url: 'db://assets/tile.png', sliced: true, tileScale: 0.5 };
    assert.deepEqual(pixelSizedTileAsset(old), { ...old, tiled: true, sliced: false, tileScale: 1 });
    assert.equal(old.tileScale, 0.5);
});

test('PATTERN exports already at requested scale are not scaled twice', () => {
    const rendered = png(13, 14);
    const result = rasterizeTile(rendered, 0.5, 0.5);
    assert.equal(result.contents, rendered);
    assert.deepEqual([result.width, result.height], [13, 14]);
    const clamped = rasterizeTile(png(26, 28), 0.25, 0.5);
    assert.deepEqual([clamped.width, clamped.height], [13, 14]);
});

test('global import scale is baked into pixels; fractional sizes round to nearest pixel', () => {
    const original = png(26, 28);
    const doubledImport = rasterizeTile(original, 0.5 * 2);
    assert.equal(doubledImport.contents, original);
    const fractional = rasterizeTile(png(27, 29), 0.5);
    assert.deepEqual([fractional.width, fractional.height, fractional.rounded], [14, 15, true]);
    const tiny = rasterizeTile(original, 0.001);
    assert.deepEqual([tiny.width, tiny.height, tiny.rounded], [1, 1, true]);
});

test('resampling averages coverage with premultiplied alpha, not hidden RGB', () => {
    const source = new PNG({ width: 2, height: 2 });
    source.data.set([255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0]);
    const result = rasterizeTile(PNG.sync.write(source), 0.5);
    assert.deepEqual([...PNG.sync.read(result.contents).data], [255, 0, 0, 128]);
});

test('upsampling handles periodic tile edges and preserves solid transparent images', () => {
    const result = rasterizeTile(png(2, 2, [0, 0, 0, 0]), 2);
    assert.deepEqual([result.width, result.height], [4, 4]);
    assert.ok(PNG.sync.read(result.contents).data.every(v => v === 0));
    const solid = rasterizeTile(png(1, 1, [40, 70, 90, 255]), 3);
    assert.deepEqual([...PNG.sync.read(solid.contents).data], Array(9).fill([40, 70, 90, 255]).flat());
});

test('new output identities isolate legacy assets and different import scales', () => {
    const sourceKey = JSON.stringify({ kind: 'image-ref', id: 'image', paintScale: 0.5, renderScale: 1 });
    const writer = new AssetWriter('figma-importer');
    const oldUrl = writer.buildTiledUrl('panel', sourceKey, 'png');
    const url = scale => writer.buildTiledUrl('panel', tiledRasterKey(sourceKey, scale), 'png');
    assert.notEqual(url(0.5), oldUrl);
    assert.notEqual(url(0.5), url(1));
    assert.equal(url(0.5), url(0.5));
    // The same raw cache data can be reused without cumulative shrinking.
    const source = png(26, 28);
    assert.deepEqual(rasterizeTile(source, 0.5).contents, rasterizeTile(source, 0.5).contents);
});

test('PNG color metadata survives resizing', () => {
    const source = new PNG({ width: 26, height: 28 });
    source.gamma = 0.45455;
    const result = rasterizeTile(PNG.sync.write(source), 0.5);
    assert.equal(PNG.sync.read(result.contents).gamma, 0.45455);
});

test('non-PNG source decodes once into PNG and follows the same sizing policy', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]); let calls = 0;
    const result = rasterizeTile(jpeg, 0.5, 1, bytes => {
        assert.equal(bytes, jpeg); calls++; return png(26, 28);
    });
    assert.equal(calls, 1);
    assert.deepEqual([result.width, result.height], [13, 14]);
    assert.equal(result.contents.toString('ascii', 1, 4), 'PNG');
});

test('invalid scales, oversized images and damaged PNG fail instead of reverting to node scaling', () => {
    const source = png(26, 28);
    for (const scale of [0, -1, Infinity, NaN]) {
        assert.throws(() => rasterizeTile(source, scale), /倍率/);
        assert.throws(() => tiledRasterKey('source', scale), /倍率/);
    }
    assert.throws(() => rasterizeTile(source, 1, 0), /倍率/);
    assert.throws(() => rasterizeTile(source, 10000), /安全处理/);
    assert.throws(() => rasterizeTile(source.subarray(0, 35), 0.5), /有效/);
    const huge = Buffer.from(source); huge.writeUInt32BE(9000, 16);
    assert.throws(() => rasterizeTile(huge, 0.5), /安全处理/);
});
