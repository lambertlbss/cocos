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
/** Synthetic soft edge pixels just inside the original slice boundaries. The
 * remaining middle columns/rows are exactly equal, with no color tolerance.
 * Guards are physical pixels; slice analysis remains in Figma logical units.
 */
function boundaryFixture(guards, analysis = nine, scale = 1) {
    const width = 30 * scale, height = 20 * scale;
    const borders = Object.fromEntries(Object.entries(analysis.borders)
        .map(([side, value]) => [side, Math.round(value * scale)]));
    const sample = (position, length, before, after, leading = 0, trailing = 0, middle) => {
        if (position < before) return middle - 20 + position;
        if (position < before + leading) return middle - leading + position - before;
        if (position >= length - after) return middle + 20 + position - (length - after);
        if (position >= length - after - trailing) return middle + 1 + position - (length - after - trailing);
        return middle;
    };
    return encode(width, height, (x, y) => [
        sample(x, width, borders.left, borders.right, guards.left, guards.right, 100),
        sample(y, height, borders.top, borders.bottom, guards.top, guards.bottom, 120),
        90, 200,
    ]);
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

test('thin boundary transitions become fixed insets while the remaining center shrinks losslessly', () => {
    const contents = boundaryFixture({ left: 1, right: 2, top: 2, bottom: 1 });
    const before = Buffer.from(contents);
    const originalAnalysis = structuredClone(nine);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.status, 'compacted');
    assert.deepEqual(result.borders, { left: 4, right: 6, top: 4, bottom: 4 });
    assert.deepEqual([result.optimization.width, result.optimization.height], [12, 10]);
    assertReconstructs(contents, result);
    assert.deepEqual(contents, before, 'the full source and its cache must remain unchanged');
    assert.deepEqual(nine, originalAnalysis, 'analysis cannot acquire the compact texture insets');
});

for (const mode of ['horizontal', 'vertical']) {
    test(`${mode} three-slice preserves thin edge transitions only on its stretch axis`, () => {
        const horizontal = mode === 'horizontal';
        const analysis = { mode, borders: horizontal
            ? { left: 3, right: 4, top: 0, bottom: 0 }
            : { left: 0, right: 0, top: 2, bottom: 3 } };
        const guards = horizontal ? { left: 2, right: 1, top: 0, bottom: 0 }
            : { left: 0, right: 0, top: 1, bottom: 2 };
        const contents = boundaryFixture(guards, analysis);
        const result = compactSlicePng(contents, node(), analysis, 1);
        assert.equal(result.optimization.status, 'compacted');
        assert.deepEqual(result.borders, horizontal
            ? { left: 5, right: 5, top: 0, bottom: 0 }
            : { left: 0, right: 0, top: 3, bottom: 5 });
        assert.deepEqual([result.optimization.width, result.optimization.height], horizontal ? [12, 20] : [30, 10]);
        assertReconstructs(contents, result);
    });
}

test('2x boundary transition budget and expanded insets use physical pixels once', () => {
    const contents = boundaryFixture({ left: 4, right: 2, top: 3, bottom: 4 }, nine, 2);
    const result = compactSlicePng(contents, node(), nine, 2);
    assert.equal(result.optimization.status, 'compacted');
    assert.deepEqual(result.borders, { left: 10, right: 10, top: 7, bottom: 10 });
    assert.deepEqual([result.optimization.width, result.optimization.height], [24, 21]);
    assertReconstructs(contents, result);
});

for (const side of ['left', 'right', 'top', 'bottom']) {
    test(`a ${side} transition exceeding the edge budget blocks only that stretch axis`, () => {
        const guards = { left: 1, right: 1, top: 1, bottom: 1, [side]: 3 };
        const contents = boundaryFixture(guards);
        const result = compactSlicePng(contents, node(), nine, 1);
        const horizontalBlocked = side === 'left' || side === 'right';
        assert.equal(result.optimization.status, 'compacted');
        assert.deepEqual(result.borders, horizontalBlocked
            ? { left: 3, right: 4, top: 3, bottom: 4 }
            : { left: 4, right: 5, top: 2, bottom: 3 });
        assert.deepEqual([result.optimization.width, result.optimization.height], horizontalBlocked ? [30, 9] : [11, 20]);
        assertReconstructs(contents, result);
    });
}

for (const axis of ['horizontal', 'vertical']) {
    test(`thin inset transitions do not permit cropping a ${axis} center gradient`, () => {
        const image = PNG.sync.read(boundaryFixture({ left: 1, right: 1, top: 1, bottom: 1 }));
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            // Keep the other axis fully repeatable after its thin transition.
            const offset = (y * image.width + x) * 4;
            image.data[offset + (axis === 'horizontal' ? 0 : 1)] = (axis === 'horizontal' ? x : y) * 5;
        }
        const contents = PNG.sync.write(image);
        const result = compactSlicePng(contents, node(), nine, 1);
        assert.deepEqual([result.optimization.width, result.optimization.height], axis === 'horizontal' ? [30, 9] : [11, 20]);
        assert.deepEqual(result.borders, axis === 'horizontal'
            ? { left: 3, right: 4, top: 3, bottom: 4 }
            : { left: 4, right: 5, top: 2, bottom: 3 });
        assertReconstructs(contents, result);
    });
}

test('thin boundary transitions cannot hide a single different alpha pixel in the center', () => {
    const image = PNG.sync.read(boundaryFixture({ left: 1, right: 1, top: 1, bottom: 1 }));
    image.data[(10 * image.width + 12) * 4 + 3]--;
    const contents = PNG.sync.write(image);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.status, 'unchanged');
    assert.equal(result.contents, contents);
    assert.deepEqual(result.borders, nine.borders);
});

test('a one-level alpha fringe inside the inset is preserved as fixed edge pixels', () => {
    const contents = encode(30, 20, (x) => [50, 60, 70, x === nine.borders.left + 1 ? 199 : 200]);
    const result = compactSlicePng(contents, node(), nine, 1);
    assert.equal(result.optimization.status, 'compacted');
    assert.deepEqual(result.borders, { left: 5, right: 4, top: 2, bottom: 3 });
    assert.deepEqual([result.optimization.width, result.optimization.height], [11, 7]);
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

test('a white motif in the fixed left cap is preserved without copying into the stretch band', () => {
    const analysis = { mode: 'horizontal', borders: { left: 20, right: 14, top: 0, bottom: 0 } };
    const contents = encode(80, 28, (x, y) => {
        const motif = x >= 6 && x <= 14 && y >= 7 && y <= 20
            && (x <= 10 || y >= 12);
        return motif ? [255, 255, 255, 255] : [20, 110, 240, 255];
    });
    const result = compactSlicePng(contents, node(80, 28), analysis, 1);
    assert.equal(result.optimization.status, 'compacted');
    assert.equal(result.optimization.width, 36);
    assertReconstructs(contents, result);
    const image = PNG.sync.read(result.contents);
    for (const width of [80, 160, 240]) {
        for (let y = 0; y < image.height; y++) for (let x = 0; x < width; x++) {
            const sample = pixel(image, restoreAxis(x, width, image.width, 20, 14), y);
            if (x >= 20) assert.notEqual(sample[0], 255, `unexpected white at ${x},${y}, width ${width}`);
        }
    }
});

test('a white motif crossing the inset is never removed to make a smaller stretch band', () => {
    const analysis = { mode: 'horizontal', borders: { left: 8, right: 8, top: 0, bottom: 0 } };
    const contents = encode(80, 28, (x, y) => x >= 6 && x <= 14 && y >= 7 && y <= 20
        ? [255, 255, 255, 255] : [20, 110, 240, 255]);
    const result = compactSlicePng(contents, node(80, 28), analysis, 1);
    assert.equal(result.contents, contents);
    assert.equal(result.optimization.status, 'unchanged');
    assert.equal(result.sliceFallback, undefined, 'valid insets remain available; compaction cannot repair the design');
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

test('a mismatched export canvas clears stale insets instead of writing Figma-space borders', async () => {
    const contents = fixture();
    const calls = [];
    const result = await writeSlicedPng({ async write(url, data, borders) {
        calls.push({ url, data, borders });
        return { uuid: 'same-frame', url, sliced: true };
    } }, 'db://assets/panel.png', contents, node(40, 20), nine, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data, contents);
    assert.deepEqual(calls[0].borders, { left: 0, right: 0, top: 0, bottom: 0 });
    assert.equal(result.asset.uuid, 'same-frame');
    assert.equal(result.asset.sliced, false);
    assert.match(result.asset.sliceFallback, /尺寸与切片画布不匹配/);
    assert.equal(result.optimization.status, 'skipped');
});

test('invalid scale and invalid pixel insets never reach SpriteFrame metadata', async () => {
    const contents = fixture();
    for (const [analysis, scale] of [[nine, NaN], [nine, Infinity],
        [{ ...nine, borders: { ...nine.borders, left: NaN } }, 1],
        [{ ...nine, borders: { ...nine.borders, right: 30 } }, 1]]) {
        const calls = [];
        const result = await writeSlicedPng({ async write(url, data, borders) {
            calls.push({ data, borders });
            return { uuid: 'same-frame', url, sliced: false };
        } }, 'db://assets/panel.png', contents, node(), analysis, scale);
        assert.equal(calls[0].data, contents);
        assert.deepEqual(calls[0].borders, { left: 0, right: 0, top: 0, bottom: 0 });
        assert.equal(result.asset.sliced, false);
        assert.ok(result.asset.sliceFallback);
    }
});

test('full-image fallback still propagates failed writes', async () => {
    await assert.rejects(writeSlicedPng({ async write() { throw new Error('full PNG save failed'); } },
        'db://assets/panel.png', fixture(), node(40, 20), nine, 1), /full PNG save failed/);
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

test('expanded inset metadata failure restores the full image with its original insets', async () => {
    const contents = boundaryFixture({ left: 2, right: 2, top: 2, bottom: 2 });
    const calls = [];
    const result = await writeSlicedPng({ async write(url, data, borders) {
        calls.push({ data, borders: { ...borders } });
        return { uuid: 'same-frame', url, sliced: calls.length > 1,
            ...(calls.length === 1 ? { sliceFallback: 'cannot verify expanded insets' } : {}) };
    } }, 'db://assets/panel.png', contents, node(), nine, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].borders, { left: 5, right: 6, top: 4, bottom: 5 });
    assert.notEqual(calls[0].data, contents);
    assert.equal(calls[1].data, contents);
    assert.deepEqual(calls[1].borders, nine.borders);
    assert.equal(result.optimization.status, 'restored');
    assert.deepEqual([result.optimization.width, result.optimization.height], [30, 20]);
    assert.equal(result.asset.sliced, true);
});

test('expanded inset write failure restores original pixels and insets before propagating the error', async () => {
    const contents = boundaryFixture({ left: 2, right: 2, top: 2, bottom: 2 });
    const calls = [];
    await assert.rejects(writeSlicedPng({ async write(url, data, borders) {
        calls.push({ data, borders: { ...borders } });
        if (calls.length === 1) throw new Error('metadata readiness timeout');
        return { uuid: 'same-frame', url, sliced: true };
    } }, 'db://assets/panel.png', contents, node(), nine, 1), /metadata readiness timeout/);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].borders, { left: 5, right: 6, top: 4, bottom: 5 });
    assert.equal(calls[1].data, contents);
    assert.deepEqual(calls[1].borders, nine.borders);
});

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
    const cacheWrite = flow.indexOf('cache.write(item.key, contents)');
    const sliceWrite = flow.indexOf('await writeSlicedPng(');
    assert.ok(cacheWrite >= 0 && sliceWrite > cacheWrite);
    assert.match(flow, /if \(item.sliceAnalysis\)/);
    assert.match(flow, /else\s*\{\s*asset = await writer.write\(item.url, contents,/);
});
