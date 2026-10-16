'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { PNG } = require('pngjs');
const { rasterizeImageFill } = require('../dist/importer/image-fill');

function png(width, height, pixel = () => [40, 120, 200, 255], gamma) {
    const image = new PNG({ width, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        image.data.set(pixel(x, y), (y * width + x) * 4);
    }
    if (gamma) image.gamma = gamma;
    return PNG.sync.write(image);
}

function pixel(image, x, y) {
    return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4)];
}

function electron(t, image) {
    const load = Module._load;
    t.mock.method(Module, '_load', function (name, parent, isMain) {
        if (name === 'electron') return { nativeImage: { createFromBuffer: image } };
        return load.call(this, name, parent, isMain);
    });
}

for (const mode of ['FILL', 'FIT']) test(`${mode} preserves validated original PNG bytes at the exact target size`, () => {
    const source = png(4, 2, (x, y) => [x * 40, y * 80, 20, 64 + x * 40]);
    const before = Buffer.from(source);
    assert.equal(rasterizeImageFill(source, mode, 2, 1, 2), source);
    assert.deepEqual(source, before);
});

test('FILL crops the horizontal center of a wide image without squeezing its geometry', () => {
    const source = png(4, 2, (x, y) => [x * 50, y * 100, 20, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FILL', 2, 2, 1));
    assert.deepEqual([result.width, result.height], [2, 2]);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        assert.deepEqual(pixel(result, x, y), [(x + 1) * 50, y * 100, 20, 255]);
    }
});

test('FILL crops the vertical center of a tall image', () => {
    const source = png(2, 4, (x, y) => [x * 50, y * 50, 20, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FILL', 2, 2, 1));
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        assert.deepEqual(pixel(result, x, y), [x * 50, (y + 1) * 50, 20, 255]);
    }
});

test('FIT centers wide images with transparent top and bottom margins', () => {
    const source = png(4, 2, (x, y) => [x * 50, y * 100, 20, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FIT', 4, 4, 1));
    for (let x = 0; x < 4; x++) {
        assert.deepEqual(pixel(result, x, 0), [0, 0, 0, 0]);
        assert.deepEqual(pixel(result, x, 3), [0, 0, 0, 0]);
        assert.deepEqual(pixel(result, x, 1), [x * 50, 0, 20, 255]);
        assert.deepEqual(pixel(result, x, 2), [x * 50, 100, 20, 255]);
    }
});

test('FIT centers tall images with transparent left and right margins', () => {
    const source = png(2, 4, (x, y) => [x * 50, y * 50, 20, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FIT', 4, 4, 1));
    for (let y = 0; y < 4; y++) {
        assert.deepEqual(pixel(result, 0, y), [0, 0, 0, 0]);
        assert.deepEqual(pixel(result, 3, y), [0, 0, 0, 0]);
        assert.deepEqual(pixel(result, 1, y), [0, y * 50, 20, 255]);
        assert.deepEqual(pixel(result, 2, y), [50, y * 50, 20, 255]);
    }
});

test('FIT accounts for fractional image coverage at the letterbox edge', () => {
    const source = png(3, 2, () => [40, 200, 80, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FIT', 4, 4, 1));
    assert.deepEqual(pixel(result, 1, 0), [40, 200, 80, 85]);
    assert.deepEqual(pixel(result, 1, 1), [40, 200, 80, 255]);
    assert.deepEqual(pixel(result, 1, 2), [40, 200, 80, 255]);
    assert.deepEqual(pixel(result, 1, 3), [40, 200, 80, 85]);
});

test('upsampling clamps opposite image edges rather than wrapping colors like a tile', () => {
    const source = png(2, 1, (x) => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FILL', 4, 2, 1));
    assert.deepEqual(pixel(result, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(result, 1, 0), [191, 0, 64, 255]);
    assert.deepEqual(pixel(result, 2, 0), [64, 0, 191, 255]);
    assert.deepEqual(pixel(result, 3, 0), [0, 0, 255, 255]);
});

test('premultiplied alpha sampling keeps transparent RGB out of semi-transparent edges', () => {
    const resize = (hidden) => rasterizeImageFill(png(2, 1, (x) => x === 0 ? [255, 0, 0, 255] : [...hidden, 0]), 'FILL', 4, 2, 1);
    const result = PNG.sync.read(resize([0, 0, 0]));
    assert.deepEqual(pixel(result, 1, 0), [255, 0, 0, 191]);
    assert.deepEqual(pixel(result, 2, 0), [255, 0, 0, 64]);
    assert.deepEqual(pixel(result, 3, 0), [0, 0, 0, 0]);
    assert.deepEqual(resize([0, 0, 255]), resize([0, 0, 0]));
});

test('reduction averages full pixel coverage and preserves existing source alpha', () => {
    const source = png(2, 2, (x) => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]);
    const result = PNG.sync.read(rasterizeImageFill(source, 'FIT', 1, 1, 1));
    assert.deepEqual([...result.data], [255, 0, 0, 128]);
    const half = PNG.sync.read(rasterizeImageFill(png(1, 1, () => [80, 140, 220, 128]), 'FILL', 2, 2, 1));
    assert.deepEqual(pixel(half, 0, 0), [80, 140, 220, 128], 'node opacity is not part of source resampling');
});

test('scale is applied once, fractional output dimensions round consistently, and source bytes stay unchanged', () => {
    const source = png(6, 4);
    const copy = Buffer.from(source);
    const first = rasterizeImageFill(source, 'FIT', 3, 2, 1.5);
    const result = PNG.sync.read(first);
    assert.deepEqual([result.width, result.height], [5, 3]);
    assert.deepEqual(first, rasterizeImageFill(source, 'FIT', 3, 2, 1.5));
    assert.deepEqual(source, copy);
    const small = PNG.sync.read(rasterizeImageFill(source, 'FILL', 0.1, 0.2, 0.1));
    assert.deepEqual([small.width, small.height], [1, 1]);
});

test('PNG color interpretation metadata survives rasterization', () => {
    const result = rasterizeImageFill(png(4, 2, undefined, 0.45455), 'FILL', 2, 2, 1);
    assert.equal(PNG.sync.read(result).gamma, 0.45455);
});

test('non-PNG raster input uses Creator nativeImage and returns a PNG at node dimensions', (t) => {
    const jpeg = Buffer.from([255, 216, 255, 224]);
    const converted = png(2, 1);
    let decodes = 0;
    electron(t, (contents) => {
        assert.equal(contents, jpeg);
        decodes += 1;
        return { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }), toPNG: () => converted };
    });
    const output = PNG.sync.read(rasterizeImageFill(jpeg, 'FIT', 4, 4, 1));
    assert.equal(decodes, 1);
    assert.deepEqual([output.width, output.height], [4, 4]);
    assert.deepEqual(pixel(output, 0, 0), [0, 0, 0, 0]);
});

test('unsupported native images fail instead of returning unprocessed source bytes', (t) => {
    electron(t, () => ({ isEmpty: () => true }));
    assert.throws(() => rasterizeImageFill(Buffer.from('unsupported'), 'FILL', 2, 2, 1), /无法解码/);
});

test('oversized native images are rejected before PNG allocation', (t) => {
    electron(t, () => ({ isEmpty: () => false, getSize: () => ({ width: 9000, height: 2 }),
        toPNG() { assert.fail('oversized image must not be encoded'); } }));
    assert.throws(() => rasterizeImageFill(Buffer.from('native'), 'FILL', 2, 2, 1), /安全处理/);
});

test('invalid modes, dimensions and unsafe source/target sizes fail explicitly', () => {
    const source = png(4, 2);
    assert.throws(() => rasterizeImageFill(source, 'CROP', 2, 2, 1), /FILL\/FIT/);
    for (const invalid of [0, -1, NaN, Infinity]) {
        assert.throws(() => rasterizeImageFill(source, 'FILL', invalid, 2, 1), /有限正数/);
        assert.throws(() => rasterizeImageFill(source, 'FILL', 2, invalid, 1), /有限正数/);
        assert.throws(() => rasterizeImageFill(source, 'FILL', 2, 2, invalid), /有限正数/);
    }
    for (const [width, height, scale] of [[8193, 1, 1], [8192, 2049, 1], [2, 2, 5000], [Number.MAX_VALUE, 2, 2]]) {
        assert.throws(() => rasterizeImageFill(source, 'FIT', width, height, scale), /安全处理/);
    }
    const huge = Buffer.from(source);
    huge.writeUInt32BE(9000, 16);
    assert.throws(() => rasterizeImageFill(huge, 'FILL', 2, 2, 1), /安全处理/);
    assert.throws(() => rasterizeImageFill(Buffer.alloc(0), 'FILL', 2, 2, 1), /为空/);
});

test('damaged, high-depth and animated PNGs never masquerade as successful rasterizations', () => {
    const source = png(4, 2);
    assert.throws(() => rasterizeImageFill(source.subarray(0, -12), 'FILL', 2, 2, 1), /不完整/);
    const corrupt = Buffer.from(source);
    corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => rasterizeImageFill(corrupt, 'FILL', 4, 2, 1));
    const deep = Buffer.from(source);
    deep[24] = 16;
    assert.throws(() => rasterizeImageFill(deep, 'FILL', 2, 2, 1), /高位深/);
    const animation = Buffer.alloc(12);
    animation.write('acTL', 4, 'ascii');
    const animated = Buffer.concat([source.subarray(0, 33), animation, source.subarray(33)]);
    assert.throws(() => rasterizeImageFill(animated, 'FILL', 2, 2, 1), /动画/);
    assert.throws(() => rasterizeImageFill(Buffer.concat([source, Buffer.from('extra')]), 'FILL', 2, 2, 1), /额外数据/);
});
