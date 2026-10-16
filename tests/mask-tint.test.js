'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { parseNode } = require('../dist/figma/parser');
const { analyzeMaskTint, verifyWhiteAlphaPng } = require('../dist/figma/mask-tint');

function masked(options = {}) {
    const frame = { x: 10, y: 20, width: 100, height: 60 };
    return parseNode({ id: 'host', name: 'colored_component', type: 'GROUP', absoluteBoundingBox: frame, opacity: 0.4,
        children: [{ id: 'mask', name: 'common_bg_tanchu_10', type: 'INSTANCE', isMask: true, maskType: 'ALPHA',
            componentId: 'base-component', absoluteBoundingBox: frame,
            children: [{ id: 'image', type: 'RECTANGLE', absoluteBoundingBox: frame,
                fills: [{ type: 'IMAGE', imageRef: 'base-image', scaleMode: 'FILL' }] }], ...(options.mask ?? {}) },
        { id: 'cover', name: 'cover', type: 'RECTANGLE', absoluteBoundingBox: frame,
            fills: [{ type: 'SOLID', color: { r: 208 / 255, g: 157 / 255, b: 105 / 255, a: 1 } }], ...(options.cover ?? {}) }],
        ...(options.host ?? {}) });
}

function png(rgb = [255, 255, 255], alpha = 128) {
    const image = new PNG({ width: 3, height: 2 });
    for (let i = 0; i < image.data.length; i += 4) {
        image.data.set([...rgb, alpha], i);
    }
    image.data.set([12, 34, 56, 0], 0); // Invisible RGB must not reject an alpha contour.
    return PNG.sync.write(image);
}

test('retains actual Figma mask and component identity and maps D09D69 without host-opacity duplication', () => {
    const node = masked();
    const result = analyzeMaskTint(node);
    assert.equal(node.children[0].isMask, true);
    assert.equal(node.children[0].componentId, 'base-component');
    assert.deepEqual(result.candidate.tint, { r: 208 / 255, g: 157 / 255, b: 105 / 255, a: 1 });
    assert.equal(node.opacity, 0.4);
});

test('multiplies cover color alpha, fill alpha and cover opacity exactly once', () => {
    const result = analyzeMaskTint(masked({ cover: { opacity: 0.5,
        fills: [{ type: 'SOLID', opacity: 0.5, color: { r: 1, g: 0, b: 0, a: 0.5 } }] } }));
    assert.equal(result.candidate.tint.a, 0.125);
});

test('accepts only white RGB at every nontransparent pixel', () => {
    assert.equal(verifyWhiteAlphaPng(png()).valid, true);
    assert.equal(verifyWhiteAlphaPng(png([254, 255, 255])).valid, false);
    assert.equal(verifyWhiteAlphaPng(png([255, 255, 255], 0)).valid, false);
    assert.equal(verifyWhiteAlphaPng(Buffer.from('not PNG')).valid, false);
});

for (const [name, options] of [
    ['missing mask evidence', { mask: { maskType: undefined } }],
    ['luminance mask', { mask: { maskType: 'LUMINANCE' } }],
    ['partial mask opacity', { mask: { opacity: 0.5 } }],
    ['colored base', { mask: { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } }],
    ['mask effect', { mask: { effects: [{ type: 'DROP_SHADOW' }] } }],
    ['hidden cover', { cover: { visible: false } }],
    ['rounded cover', { cover: { cornerRadius: 10 } }],
    ['shifted cover', { cover: { absoluteBoundingBox: { x: 11, y: 20, width: 100, height: 60 } } }],
    ['multiply blend', { cover: { blendMode: 'MULTIPLY' } }],
]) test(`${name} conservatively requests full Figma composition`, () => {
    const result = analyzeMaskTint(masked(options));
    assert.equal(result.candidate, undefined);
    assert.ok(result.reason);
});

test('a group named mask without actual isMask is never used as tint evidence', () => {
    assert.equal(analyzeMaskTint(masked({ mask: { isMask: false, name: 'Mask' } })), undefined);
});

async function integration(t, options = {}) {
    const { buildAssets } = require('../dist/main');
    const { AssetWriter } = require('../dist/importer/assets');
    const { LocalResourceLibrary } = require('../dist/importer/local-resources');
    const { LocalAssetCache } = require('../dist/importer/cache');
    const { DEFAULT_SETTINGS } = require('../dist/types');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const previous = global.Editor;
    const project = join(tmpdir(), 'mask-tint-virtual');
    global.Editor = { Project: { path: project, tmpDir: join(project, 'temp') }, Message: { send() {} } };
    t.after(() => { global.Editor = previous; });
    const base = { uuid: 'shared-white-base', url: 'db://assets/shared/common_bg_tanchu_10.png', sliced: true };
    const notes = [], bindings = [], writes = [];
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});
    t.mock.method(LocalAssetCache.prototype, 'initialize', async () => {});
    t.mock.method(LocalResourceLibrary.prototype, 'initialize', async () => {});
    t.mock.method(LocalResourceLibrary.prototype, 'findAll', async () => []);
    t.mock.method(LocalResourceLibrary.prototype, 'find', async (name) => name === 'common_bg_tanchu_10'
        ? { path: join(project, 'assets/shared/common_bg_tanchu_10.png'), contents: options.colored ? png([100, 80, 40]) : png() } : null);
    t.mock.method(AssetWriter.prototype, 'existing', async () => base);
    t.mock.method(AssetWriter.prototype, 'existingRaster', async () => assert.fail('same-name lookup is not source identity'));
    t.mock.method(AssetWriter.prototype, 'existingForSource', async () => null);
    t.mock.method(LocalAssetCache.prototype, 'read', async () => png([208, 157, 105]));
    t.mock.method(AssetWriter.prototype, 'resolve', async (url, bytes, config) => {
        writes.push({ url, bytes, config }); return { uuid: 'composite', url, sliced: false };
    });
    const node = masked();
    const result = await buildAssets({ fileKey: 'file', roots: [node], nodeById: new Map([[node.id, node]]) },
        new Map(), { ...DEFAULT_SETTINGS, localResourceFolders: options.noLocal ? [] : [join(project, 'assets/shared')] },
        { beforeWrite: async () => {}, bind: (...args) => bindings.push(args), note: (...args) => notes.push(args) });
    return { result, base, notes, bindings, writes };
}

test('real mask reuses sliced base with instance tint without rewriting shared pixels or borders', async (t) => {
    const f = await integration(t);
    const asset = f.result.assets.get('host');
    assert.equal(asset.uuid, f.base.uuid);
    assert.equal(asset.sliced, true);
    assert.deepEqual(asset.tint, { r: 208 / 255, g: 157 / 255, b: 105 / 255, a: 1 });
    assert.equal(f.base.tint, undefined);
    assert.equal(f.writes.length, 0);
    assert.ok(f.notes.some(([action]) => action === 'tinted'));
    assert.equal(f.result.assets.size, 1);
});

test('colored base conservatively uses full composition and reports multiply-color risk', async (t) => {
    const f = await integration(t, { colored: true });
    assert.equal(f.result.assets.get('host').tint, undefined);
    assert.equal(f.result.assets.get('host').uuid, 'composite');
    assert.equal(f.writes.length, 1);
    assert.ok(f.notes.some(([action, , reason]) => action === 'fallback' && /乘色会偏暗/.test(reason)));
});

test('without explicit local mapping an unrelated same-name white alpha image is never selected', async (t) => {
    const f = await integration(t, { noLocal: true });
    assert.equal(f.result.assets.get('host').uuid, 'composite');
    assert.equal(f.writes.length, 1);
    assert.ok(f.notes.some(([action, , reason]) => action === 'fallback' && /没有可验证/.test(reason)));
});
