'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PNG } = require('pngjs');
const { compactSlicePng, writeSlicedPng } = require('../dist/importer/sliced-png');

const nine = { mode: 'nine', borders: { left: 3, right: 4, top: 2, bottom: 3 } };
const node = (width = 30, height = 20) => ({
    absoluteBoundingBox: { x: 125.25, y: -60.5, width, height }, rotation: 0,
    relativeTransform: [[1, 0, 125.25], [0, 1, -60.5]],
});
function encode(width, height, color, gamma) {
    const image = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) image.data.set(color(x, y), (y * width + x) * 4);
    }
    if (gamma) image.gamma = gamma;
    return PNG.sync.write(image);
}
function fixture(analysis = nine, scale = 1, width = 30, height = 20) {
    const { left, right, top, bottom } = analysis.borders;
    return encode(width * scale, height * scale, (x, y) => {
        // Independent fixed-pixel variation in corners and side bands; the
        // stretchable middle is exactly repeatable, with non-opaque alpha.
        const vx = x < left * scale ? x : x >= (width - right) * scale ? x - (width - right) * scale + 8 : 5;
        const vy = y < top * scale ? y : y >= (height - bottom) * scale ? y - (height - bottom) * scale + 12 : 7;
        return [vx * 10, vy * 10, 99, 200 + ((vx + vy) % 40)];
    });
}
function pixel(image, x, y) { return image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4); }
function restoreAxis(value, full, small, start, end) {
    if (full === small || value < start) return value;
    if (value >= full - end) return small - (full - value);
    return start + Math.min(small - start - end - 1,
        Math.floor((value - start) * (small - start - end) / (full - start - end)));
}
function assertReconstructs(original, compact) {
    const a = PNG.sync.read(original);
    const b = PNG.sync.read(compact.contents);
    const { left, right, top, bottom } = compact.borders;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            assert.deepEqual(pixel(b, restoreAxis(x, a.width, b.width, left, right),
                restoreAxis(y, a.height, b.height, top, bottom)), pixel(a, x, y), `pixel ${x},${y}`);
        }
    }
}

test('nine-slice shrinks only the middle and reconstructs every RGBA pixel', () => {
    const contents = fixture();
    const before = Buffer.from(contents);
    const spec = node();
    const geometry = structuredClone(spec);
    const result = compactSlicePng(contents, spec, nine, 1);
    assert.equal(result.optimization.status, 'compacted');
    assert.equal(result.optimization.width, 9);
    assert.equal(result.optimization.height, 7);
    assert.deepEqual(result.borders, nine.borders);
    assertReconstructs(contents, result);
    assert.deepEqual(contents, before);
    assert.deepEqual(spec, geometry);
});

for (const mode of ['horizontal', 'vertical']) {
    test(`${mode} three-slice shrinks only its stretch axis`, () => {
        const analysis = { mode, borders: mode === 'horizontal'
            ? { left: 3, right: 4, top: 0, bottom: 0 } : { left: 0, right: 0, top: 2, bottom: 3 } };
        const contents = fixture(analysis);
        const result = compactSlicePng(contents, node(), analysis, 1);
        assert.equal(result.optimization.width, mode === 'horizontal' ? 9 : 30);
        assert.equal(result.optimization.height, mode === 'vertical' ? 7 : 20);
        assertReconstructs(contents, result);
    });
}

test('2x export keeps four physical center pixels and scales borders once', () => {
    const contents = fixture(nine, 2);
    const result = compactSlicePng(contents, node(), nine, 2);
    assert.deepEqual([result.optimization.width, result.optimization.height], [18, 14]);
    assert.deepEqual(result.borders, { left: 6, right: 8, top: 4, bottom: 6 });
    assertReconstructs(contents, result);
});

test('fractional scale rounds borders once while retaining the original canvas', () => {
    const contents = encode(45, 30, () => [10, 20, 30, 128]);
    const result = compactSlicePng(contents, node(), nine, 1.5);
    assert.deepEqual(result.borders, { left: 5, right: 6, top: 3, bottom: 5 });
    assert.deepEqual([result.optimization.width, result.optimization.height], [14, 11]);
    assertReconstructs(contents, result);
});

test('downscale retains at least one physical center pixel', () => {
    const contents = encode(15, 10, () => [10, 20, 30, 128]);
    const result = compactSlicePng(contents, node(), nine, 0.5);
    assert.deepEqual([result.optimization.width, result.optimization.height], [5, 4]);
    assertReconstructs(contents, result);
});

test('an existing 1px or 2px middle band is never enlarged', () => {
    for (const keep of [1, 2]) {
        const width = nine.borders.left + nine.borders.right + keep;
        const height = nine.borders.top + nine.borders.bottom + keep;
        const contents = fixture(nine, 1, width, height);
        const result = compactSlicePng(contents, node(width, height), nine, 1);
        assert.equal(result.optimization.status, 'unchanged');
        assert.equal(result.contents, contents);
    }
});

test('non-repeating gradients and pattern details preserve the full PNG', () => {
    const contents = encode(30, 20, (x, y) => [x * 5, y * 5, (x + y) % 2 * 255, 255]);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.status, 'unchanged');
    assert.equal(result.contents, contents);
    assert.match(result.optimization.reason, /非重复像素/);
});

test('a gradient on one axis still permits safe compaction on the other', () => {
    const contents = encode(30, 20, (_x, y) => [50, y * 5, 90, 255]);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.deepEqual([result.optimization.width, result.optimization.height], [9, 20]);
    assertReconstructs(contents, result);
});

test('even a single changed alpha pixel prevents destructive center cropping', () => {
    const contents = encode(30, 20, (x, y) => [50, 60, 70, x === 12 && y === 10 ? 254 : 255]);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.contents, contents);
});

test('detail on the top edge prevents horizontal compaction, not only center detail', () => {
    const contents = encode(30, 20, (x, y) => [y === 0 ? x * 5 : 30, 60, 70, 255]);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.width, 30);
    assert.equal(result.optimization.height, 7);
    assertReconstructs(contents, result);
});

test('color gamma metadata is preserved rather than silently changing interpretation', () => {
    const contents = encode(30, 20, () => [70, 80, 90, 160], 0.45455);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.status, 'compacted');
    assert.equal(PNG.sync.read(result.contents).gamma, PNG.sync.read(contents).gamma);
    assertReconstructs(contents, result);
});

test('corrupt/non-PNG, large header and mismatched-size local images fail closed', () => {
    const good = fixture();
    const huge = Buffer.from(good);
    huge.writeUInt32BE(100000, 16);
    for (const contents of [Buffer.from('not a PNG'), good.subarray(0, good.length - 12), huge]) {
        const result = compactSlicePng(contents, node(), nine, 1);
        assert.equal(result.optimization.status, 'skipped');
        assert.equal(result.contents, contents);
    }
    const local = compactSlicePng(good, node(40, 20), nine, 1);
    assert.equal(local.contents, good);
    assert.match(local.optimization.reason, /尺寸/);
});

test('rotated, reflected and invalid-scale inputs are not cropped', () => {
    const contents = fixture();
    for (const spec of [{ ...node(), rotation: 15 }, { ...node(), rotation: NaN },
        { ...node(), relativeTransform: [[Infinity, 0, 0], [0, 1, 0]] },
        { ...node(), relativeTransform: [[-1, 0, 0], [0, 1, 0]] },
        { ...node(), relativeTransform: [[1, 0.1, 0], [0, 1, 0]] }]) {
        assert.equal(compactSlicePng(contents, spec, nine, 1).contents, contents);
    }
    for (const scale of [0, -1, NaN, Infinity]) {
        assert.equal(compactSlicePng(contents, node(), nine, scale).contents, contents);
    }
});

test('reprocessing the original cache is deterministic and a small local PNG is not cropped twice', () => {
    const contents = fixture();
    const first = compactSlicePng(contents, node(), nine, 1);
    const second = compactSlicePng(contents, node(), nine, 1);
    assert.deepEqual(first.contents, second.contents);
    const local = compactSlicePng(first.contents, node(), nine, 1);
    assert.equal(local.contents, first.contents);
    assert.deepEqual(local.borders, first.borders);
});

test('writer uses the compact PNG and correct pixel borders without changing asset identity', async () => {
    const calls = [];
    const writer = { async write(url, contents, borders) {
        calls.push({ url, contents, borders });
        return { uuid: 'same-frame', url, sliced: true };
    } };
    const result = await writeSlicedPng(writer, 'db://assets/panel.png', fixture(nine, 2), node(), nine, 2);
    assert.equal(calls.length, 1);
    assert.equal(PNG.sync.read(calls[0].contents).width, 18);
    assert.deepEqual(calls[0].borders, { left: 6, right: 8, top: 4, bottom: 6 });
    assert.equal(result.asset.uuid, 'same-frame');
    assert.equal(result.optimization.status, 'compacted');
});

for (const retrySucceeds of [false, true]) {
    test(`failed slice metadata restores the full image (retry success: ${retrySucceeds})`, async () => {
        const calls = [];
        const contents = fixture();
        const writer = { async write(url, data, borders) {
            calls.push({ url, data, borders });
            const sliced = calls.length === 2 && retrySucceeds;
            return { uuid: 'same-frame', url, sliced, sliceFallback: sliced ? undefined : 'border failure' };
        } };
        const result = await writeSlicedPng(writer, 'db://assets/panel.png', contents, node(), nine, 1);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].data, contents);
        assert.equal(result.asset.sliced, retrySucceeds);
        assert.equal(result.optimization.status, 'restored');
        assert.equal(result.optimization.width, 30);
        assert.equal(result.optimization.bytes, contents.length);
    });
}

test('writer failures are not reported as a successful import', async () => {
    await assert.rejects(writeSlicedPng({ write: async () => { throw new Error('disk failure'); } },
        'db://assets/panel.png', fixture(), node(), nine, 1), /disk failure/);
});

test('partial AssetDB failure restores original bytes but still reports the failure', async () => {
    const contents = fixture();
    const calls = [];
    const writer = { async write(url, data) {
        calls.push(data);
        if (calls.length === 1) throw new Error('readiness timeout after file save');
        return { url, sliced: true, uuid: 'same-frame' };
    } };
    await assert.rejects(writeSlicedPng(writer, 'db://assets/panel.png', contents, node(), nine, 1), /readiness timeout/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], contents);
});

test('high-bit-depth and special PNG data are preserved without decode/conversion', () => {
    const contents = fixture();
    const deep = Buffer.from(contents);
    deep[24] = 16;
    assert.equal(compactSlicePng(deep, node(), nine, 1).contents, deep);
    for (const name of ['acTL', 'sBIT']) {
        const chunk = Buffer.alloc(12);
        chunk.write(name, 4, 'ascii');
        const extended = Buffer.concat([contents.subarray(0, 33), chunk, contents.subarray(33)]);
        const result = compactSlicePng(extended, node(), nine, 1);
        assert.equal(result.contents, extended);
        assert.equal(result.optimization.status, 'skipped');
    }
});

test('remote import applies compaction after caching original bytes and only for recognized slices', () => {
    const main = readFileSync(join(__dirname, '../source/main.ts'), 'utf8');
    const start = main.indexOf('const processRemote =');
    const end = main.indexOf('const processRawImages =', start);
    const flow = main.substring(start, end);
    assert.match(flow, /analyzeSliceGrid\(node\)/);
    assert.ok(flow.indexOf('cache.write(item.key, contents)') < flow.indexOf('writeSlicedPng(writer'));
    assert.match(flow, /if \(item.sliceAnalysis\)/);
    assert.match(flow, /else\s*\{\s*asset = await writer.write\(item.url, contents, item.borders\)/);
});
