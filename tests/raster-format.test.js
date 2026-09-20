'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { deflateSync } = require('node:zlib');
const { PNG } = require('pngjs');
const { prepareNewRaster, JPEG_QUALITY } = require('../dist/importer/raster-format');
const { AssetWriter } = require('../dist/importer/assets');

const JPEG = Buffer.from([255, 216, 255, 224, 255, 217]);
function png(alpha = 255) {
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    image.data[15] = alpha;
    return PNG.sync.write(image);
}

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const header = Buffer.alloc(4), tail = Buffer.alloc(4);
    header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, tail]);
}

function specialPng(depth, colorType, raw, extras = []) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
    header[8] = depth; header[9] = colorType;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), ...extras, chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

test('fully opaque RGBA and RGB PNGs become JPG bytes', () => {
    for (const source of [png(), specialPng(8, 2, [0, 255, 0, 128])]) {
        const result = prepareNewRaster(source, (bytes) => { assert.equal(bytes, source); return JPEG; });
        assert.equal(result.extension, 'jpg');
        assert.equal(result.contents, JPEG);
    }
});

for (const alpha of [0, 1, 128, 254]) test(`one pixel with alpha=${alpha} preserves original PNG`, () => {
    const source = png(alpha);
    const result = prepareNewRaster(source, () => assert.fail('must not encode transparent images'));
    assert.equal(result.extension, 'png');
    assert.equal(result.contents, source);
});

test('16-bit alpha low bits are not rounded away', () => {
    for (const alpha of [65534, 65535]) {
        const source = specialPng(16, 6, [0, 255, 255, 0, 0, 0, 0, alpha >> 8, alpha & 255]);
        assert.equal(prepareNewRaster(source, () => JPEG).extension, alpha === 65535 ? 'jpg' : 'png');
    }
});

test('palette transparency and one-bit grayscale are interpreted correctly', () => {
    for (const alpha of [128, 255]) {
        const source = specialPng(1, 3, [0, 0], [chunk('PLTE', Buffer.from([255, 0, 0])), chunk('tRNS', Buffer.from([alpha]))]);
        assert.equal(prepareNewRaster(source, () => JPEG).extension, alpha === 255 ? 'jpg' : 'png');
    }
    assert.equal(prepareNewRaster(specialPng(1, 0, [0, 0]), () => JPEG).extension, 'jpg');
    const transparentRgb = specialPng(8, 2, [0, 255, 0, 0], [chunk('tRNS', Buffer.from([0, 255, 0, 0, 0, 0]))]);
    assert.equal(prepareNewRaster(transparentRgb, () => JPEG).extension, 'png');
});

test('conversion failure retains PNG and existing JPEG is not re-encoded', (t) => {
    t.mock.method(console, 'warn', () => {});
    const source = png();
    for (const encode of [() => { throw new Error('codec'); }, () => Buffer.from('bad')]) {
        assert.equal(prepareNewRaster(source, encode).contents, source);
    }
    assert.equal(prepareNewRaster(JPEG, () => assert.fail()).contents, JPEG);
    const corrupt = source.subarray(0, 40);
    assert.equal(prepareNewRaster(corrupt, () => assert.fail()).contents, corrupt);
});

function writerFixture(t) {
    const stored = new Map(), writes = [], records = [];
    const originalEditor = global.Editor;
    t.after(() => { global.Editor = originalEditor; });
    const originalLoad = Module._load;
    t.mock.method(Module, '_load', function (name, ...args) {
        if (name === 'electron') return { nativeImage: { createFromBuffer(bytes) {
            assert.ok(PNG.sync.read(bytes).width > 0);
            return { isEmpty: () => false, toJPEG(quality) { assert.equal(quality, 95); assert.equal(quality, JPEG_QUALITY); return JPEG; } };
        } } };
        return originalLoad.call(this, name, ...args);
    });
    const info = (url) => ({ uuid: url, url, imported: true, invalid: false,
        subAssets: { frame: { importer: 'sprite-frame', uuid: `${url}@frame` } } });
    global.Editor = { Message: { async request(channel, method, ...args) {
        const [url, bytes] = args;
        if (method === 'query-asset-info') return stored.has(url) ? info(url) : null;
        if (method === 'query-asset-meta') return { subMetas: { frame: { importer: 'sprite-frame', userData: {} } } };
        if (method === 'create-asset' || method === 'save-asset') { stored.set(url, bytes); writes.push([method, url, bytes]); return info(url); }
        assert.fail(`unexpected ${method}`);
    } } };
    const writer = new AssetWriter('figma-importer', async (...args) => records.push(args));
    return { writer, stored, writes, records };
}

test('new opaque assets use JPG URL, review records and UUID; restore writes the same file', async (t) => {
    const f = writerFixture(t), requested = 'db://assets/figma-importer/Panel.png';
    const result = await f.writer.write(requested, png());
    assert.equal(result.url, requested.replace('.png', '.jpg'));
    assert.equal(result.uuid, `${result.url}@frame`);
    assert.equal(f.stored.get(result.url), JPEG);
    assert.equal(f.stored.has(requested), false);
    assert.deepEqual(f.records, [[result.url, false]]);
    const restored = await f.writer.write(requested, png());
    assert.equal(restored.uuid, result.uuid);
    assert.equal(f.writes[1][0], 'save-asset');
    assert.equal(f.stored.size, 1);
    assert.deepEqual(f.records[1], [result.url, true]);
});

test('new transparent PNG stays PNG; existing PNG is not migrated', async (t) => {
    const f = writerFixture(t), url = 'db://assets/figma-importer/Panel.png';
    const source = png(254);
    assert.equal((await f.writer.write(url, source)).url, url);
    assert.equal(f.stored.get(url), source);
    const opaque = png();
    assert.equal((await f.writer.write(url, opaque)).url, url);
    assert.equal(f.stored.get(url), opaque);
    assert.equal(f.stored.size, 1);
});

test('a forced JPG refresh preserves its UUID and records overwrite, not creation', async (t) => {
    const f = writerFixture(t), url = 'db://assets/figma-importer/Panel.jpg';
    f.stored.set(url, JPEG);
    const result = await f.writer.write(url.replace('.jpg', '.png'), png());
    assert.equal(result.url, url);
    assert.equal(result.uuid, `${url}@frame`);
    assert.deepEqual(f.records, [[url, true]]);
    assert.equal(f.writes[0][0], 'save-asset');
    assert.equal(f.stored.size, 1);
});

test('existing JPG/JPEG lookup is read-only and explicit extension wins', async (t) => {
    const f = writerFixture(t), base = 'db://assets/figma-importer/Panel';
    f.stored.set(`${base}.jpeg`, JPEG);
    assert.equal((await f.writer.existingRaster(`${base}.png`)).url, `${base}.jpeg`);
    f.stored.set(`${base}.jpg`, JPEG); f.stored.set(`${base}.png`, png());
    assert.equal((await f.writer.existingRaster(`${base}.png`, false, 'Panel.JPG')).url, `${base}.jpg`);
    assert.equal(f.writes.length, 0);
    assert.equal(f.records.length, 0);
});
