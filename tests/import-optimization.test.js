'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { tmpdir } = require('node:os');
const { PNG } = require('pngjs');
const { buildAssets } = require('../dist/main');
const { parseNode } = require('../dist/figma/parser');
const { FigmaClient, CancelledError } = require('../dist/figma/client');
const { AssetWriter } = require('../dist/importer/assets');
const { TokenVault } = require('../dist/security/token-vault');
const { DEFAULT_SETTINGS } = require('../dist/types');
const { inferAction, inferKind, isPatchCandidate } = require('../dist/figma/analyzer');

function bitmap(red, green = 80, blue = 160) {
    const image = new PNG({ width: 20, height: 10 });
    for (let index = 0; index < image.data.length; index += 4) {
        image.data.set([red, green, blue, 255], index);
    }
    return PNG.sync.write(image);
}

function imageNode(id, visible = true, name = 'Shared') {
    return parseNode({ id, name, type: 'RECTANGLE', visible,
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 },
        fills: [{ type: 'IMAGE', imageRef: `ref-${id}`, scaleMode: 'FILL' }] });
}

function session(roots) {
    const nodeById = new Map();
    const visit = (node) => { nodeById.set(node.id, node); node.children.forEach(visit); };
    roots.forEach(visit);
    return { fileKey: 'integration-file', roots, nodeById };
}

function renderDecisions(nodes) {
    return new Map(nodes.map((node) => [node.id,
        { action: 'render', kind: 'sprite', nineSlice: false, explicit: true }]));
}

function fixture(t) {
    const project = mkdtempSync(join(tmpdir(), 'figma-import-optimization-'));
    const localFolder = join(project, 'assets', 'shared');
    const outputFolder = join(project, 'assets', DEFAULT_SETTINGS.assetFolder);
    mkdirSync(localFolder, { recursive: true });
    mkdirSync(outputFolder, { recursive: true });
    mkdirSync(join(project, 'temp'), { recursive: true });
    const originalEditor = global.Editor;
    global.Editor = { Project: { path: project, tmpDir: join(project, 'temp') }, Message: { send() {} } };
    t.after(() => {
        global.Editor = originalEditor;
        const suffix = relative(resolve(tmpdir()), resolve(project));
        assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'cleanup stays inside the temporary directory');
        rmSync(project, { recursive: true, force: true });
    });
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});

    const exports = [], downloads = [], writes = [], lookups = [], existing = [], bindings = [], notes = [];
    const exportBytes = new Map(), fillBytes = new Map(), localAssets = new Map();
    const assetsByName = new Map();
    let fillRequests = 0;
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});
    t.mock.method(AssetWriter.prototype, 'existingForSource', async (sourceKey, options) => {
        lookups.push({ sourceKey, options });
        return null;
    });
    t.mock.method(AssetWriter.prototype, 'existing', async (url) => {
        existing.push(url);
        assert.ok(localAssets.has(url), `only registered local or output snapshot resources may be reused: ${url}`);
        return localAssets.get(url);
    });
    const writeAsset = async (url, contents, borders) => {
        writes.push({ url, contents: Buffer.from(contents), borders });
        let asset = assetsByName.get(url);
        if (!asset) {
            asset = { uuid: `written-${assetsByName.size + 1}`, url, sliced: false };
            assetsByName.set(url, asset);
        }
        return asset;
    };
    t.mock.method(AssetWriter.prototype, 'write', writeAsset);
    t.mock.method(AssetWriter.prototype, 'resolve', async () => assert.fail('same-name resources must not compare source identity or contents'));
    t.mock.method(TokenVault.prototype, 'get', async () => 'test-token');
    t.mock.method(FigmaClient.prototype, 'getImageUrls', async (fileKey, ids, format, scale) => {
        exports.push({ fileKey, ids: [...ids], format, scale });
        return Object.fromEntries(ids.map((id) => [id, `test-render:${id}`]));
    });
    t.mock.method(FigmaClient.prototype, 'getImageFillUrls', async () => {
        fillRequests += 1;
        return Object.fromEntries([...fillBytes.keys()].map((ref) => [ref, `test-fill:${ref}`]));
    });
    t.mock.method(FigmaClient.prototype, 'download', async (url) => {
        downloads.push(url);
        const contents = url.startsWith('test-render:')
            ? exportBytes.get(url.slice('test-render:'.length))
            : fillBytes.get(url.slice('test-fill:'.length));
        assert.ok(contents, `fixture has bytes for ${url}`);
        return contents;
    });
    const run = (nodes, decisions = renderDecisions(nodes), settings = {}) => buildAssets(session(nodes), decisions, {
        ...DEFAULT_SETTINGS, scale: 1, localResourceFolders: [localFolder], ...settings,
    }, {
        bind(node, asset, source) { bindings.push({ id: node.id, asset, source }); },
        async beforeWrite() { assert.fail('mock resolver does not mutate the asset database'); },
        note(action, name, reason, url) { notes.push({ action, name, reason, url }); },
    });
    return { run, localFolder, outputFolder, exportBytes, fillBytes, localAssets, exports, downloads, writes,
        lookups, existing, bindings, notes, writeAsset, fillRequests: () => fillRequests };
}

for (const identicalPixels of [false, true]) {
    test(`same-name rendered nodes export and write only the first node (unused second pixels identical: ${identicalPixels})`, async (t) => {
        const f = fixture(t);
        const a = imageNode('A'), b = imageNode('B');
        // Effects require Figma's complete render path; plain IMAGE uses the
        // visibility-independent fill path tested separately below.
        a.effects = [{ type: 'DROP_SHADOW', visible: true }];
        b.effects = [{ type: 'DROP_SHADOW', visible: true }];
        f.exportBytes.set(a.id, bitmap(20));
        f.exportBytes.set(b.id, identicalPixels ? f.exportBytes.get(a.id) : bitmap(230));
        const result = await f.run([a, b]);
        assert.deepEqual(f.exports.flatMap((item) => item.ids), ['A']);
        assert.equal(f.downloads.length, 1);
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.lookups, [], 'no project-wide source/content validation');
        assert.equal(result.assets.get(a.id), result.assets.get(b.id));
        assert.equal(result.assets.size, 2);
        assert.deepEqual(f.existing, [], 'no preexisting same-name resource exists in this import');
    });
}

for (const hiddenFirst of [true, false]) {
    test(`plain IMAGE uses identical center-cropped source pixels and identity when visibility changes (hidden first: ${hiddenFirst})`, async (t) => {
        const f = fixture(t);
        const source = new PNG({ width: 40, height: 10 });
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
            source.data.set(x < 10 ? [255, 0, 0, 255] : x >= 30 ? [0, 0, 255, 255] : [0, 200, 0, 255],
                (y * source.width + x) * 4);
        }
        f.fillBytes.set('ref-stable-node', PNG.sync.write(source));
        const first = await f.run([imageNode('stable-node', !hiddenFirst)]);
        const second = await f.run([imageNode('stable-node', hiddenFirst)]);
        assert.equal(f.exports.length, 0, 'visible and hidden plain IMAGE both use the original fill source');
        assert.equal(f.fillRequests(), 1);
        assert.equal(f.downloads.length, 1, 'the original fill pixels are cached across the visibility change');
        assert.equal(f.writes.length, 2);
        assert.equal(f.writes[0].url, f.writes[1].url);
        assert.deepEqual(f.writes[0].contents, f.writes[1].contents);
        const cropped = PNG.sync.read(f.writes[0].contents);
        assert.equal(cropped.width, 20);
        assert.equal(cropped.height, 10);
        for (let offset = 0; offset < cropped.data.length; offset += 4) {
            assert.deepEqual([...cropped.data.subarray(offset, offset + 4)], [0, 200, 0, 255],
                'FILL crops the red/blue outside stripes instead of stretching the source');
        }
        assert.equal(first.assets.get('stable-node').uuid, second.assets.get('stable-node').uuid);
        assert.equal(f.bindings.length, 2);
    });
}

test('hidden IMAGE restores explicit local resource priority before cache or remote source download', async (t) => {
    const f = fixture(t);
    const node = imageNode('hidden', false);
    const url = 'db://assets/shared/Shared.png';
    const asset = { uuid: 'local-original-frame', url, sliced: true };
    writeFileSync(join(f.localFolder, 'Shared.png'), bitmap(90));
    f.localAssets.set(url, asset);
    const result = await f.run([node]);
    assert.equal(result.assets.get(node.id), asset);
    assert.deepEqual(f.existing, [url]);
    assert.equal(f.writes.length, 0);
    assert.equal(f.exports.length, 0);
    assert.equal(f.fillRequests(), 0);
    assert.deepEqual(f.downloads, []);
    assert.equal(f.bindings[0].source, 'local');
});

test('same-name generated gradients share the first generated resource without comparing contents', async (t) => {
    const f = fixture(t);
    const gradient = (id, color) => parseNode({ id, name: 'Shared Gradient', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 },
        fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
            gradientStops: [{ position: 0, color }, { position: 1, color: { r: 1, g: 1, b: 1 } }] }],
        children: [{ id: `${id}-text`, name: 'Text', type: 'TEXT', characters: 'Editable',
            absoluteBoundingBox: { x: 1, y: 1, width: 8, height: 4 } }],
    });
    const a = gradient('gradient-A', { r: 1, g: 0, b: 0 });
    const b = gradient('gradient-B', { r: 0, g: 0, b: 1 });
    const decisions = new Map([a, b].map((node) => [node.id,
        { action: 'generate', kind: 'node', nineSlice: false, explicit: true }]));
    const result = await f.run([a, b], decisions);
    assert.equal(f.writes.length, 1);
    assert.equal(result.assets.get(a.id), result.assets.get(b.id));
    assert.deepEqual(f.lookups, []);
    assert.deepEqual(f.downloads, []);
});

for (const interruption of [false, true]) {
    test(`a failed import propagates ${interruption ? 'cancellation' : 'a write error'} and retry writes the cached source without a partial binding`, async (t) => {
        const f = fixture(t);
        const node = imageNode('retry-node');
        f.fillBytes.set('ref-retry-node', bitmap(140));
        const failure = interruption ? new CancelledError() : new Error('simulated asset write failure');
        let attempts = 0;
        t.mock.method(AssetWriter.prototype, 'write', async (...args) => {
            attempts += 1;
            if (attempts === 1) throw failure;
            return f.writeAsset(...args);
        });
        await assert.rejects(f.run([node]), (error) => error === failure);
        assert.deepEqual(f.bindings, [], 'failure must not be reported as a bound asset');
        const result = await f.run([node]);
        assert.equal(attempts, 2);
        assert.equal(f.downloads.length, 1, 'retry reuses original downloaded bytes safely');
        assert.equal(f.exports.length, 0);
        assert.equal(f.fillRequests(), 1);
        assert.equal(f.bindings.length, 1);
        assert.equal(result.assets.get(node.id), f.bindings[0].asset);
        assert.equal(f.writes[0].url, 'db://assets/figma-importer/Shared.png');
    });
}

function automaticDecisions(roots) {
    const decisions = new Map();
    const visit = (node) => {
        decisions.set(node.id, { action: inferAction(node), kind: inferKind(node),
            nineSlice: isPatchCandidate(node), explicit: false });
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return decisions;
}

function maskedResource(id = 'protected-mask') {
    const frame = { x: 0, y: 0, width: 20, height: 10 };
    return parseNode({ id, name: 'icon_masked', type: 'GROUP', absoluteBoundingBox: frame,
        children: [{ id: `${id}:mask`, name: 'common_mask_base', type: 'RECTANGLE',
            isMask: true, maskType: 'ALPHA', absoluteBoundingBox: frame,
            fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] },
        { id: `${id}:cover`, name: 'color', type: 'RECTANGLE', absoluteBoundingBox: frame,
            fills: [{ type: 'SOLID', color: { r: 208 / 255, g: 157 / 255, b: 105 / 255 } }] }],
    });
}

function registerLocal(f, name, asset, contents = bitmap(255, 255, 255)) {
    writeFileSync(join(f.localFolder, `${name}.png`), contents);
    const url = `db://assets/shared/${name}.png`;
    f.localAssets.set(url, { url, ...asset });
    return f.localAssets.get(url);
}

test('preexisting same-name resource takes priority over different IMAGE leaf FILL/FIT configurations', async (t) => {
    const f = fixture(t);
    const wrapper = (id, mode) => parseNode({ id, name: 'Shared', type: 'INSTANCE',
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, children: [
            { id: `${id}:leaf`, name: 'Leaf', type: 'RECTANGLE',
                absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 },
                fills: [{ type: 'IMAGE', imageRef: 'same-leaf-ref', scaleMode: mode }] },
        ] });
    const a = wrapper('fill-wrapper', 'FILL'), b = wrapper('fit-wrapper', 'FIT');
    const asset = registerLocal(f, 'Shared', { uuid: 'original-wrapper-local', sliced: false });
    const result = await f.run([a, b]);
    assert.deepEqual(f.existing, [asset.url]);
    assert.equal(result.assets.get(a.id), asset);
    assert.equal(result.assets.get(b.id), asset);
    assert.equal(f.writes.length, 0);
    assert.equal(f.fillRequests(), 0);
    assert.deepEqual(f.exports, []);
    assert.deepEqual(f.downloads, []);
});

test('local IMAGE wrapper applies child opacity only to its own Sprite instance', async (t) => {
    const f = fixture(t);
    const source = imageNode('opacity-leaf');
    source.opacity = 0.5;
    const wrapper = parseNode({ id: 'opacity-wrapper', name: 'Shared', type: 'INSTANCE',
        absoluteBoundingBox: source.absoluteBoundingBox, children: [source] });
    const base = registerLocal(f, 'Shared', { uuid: 'shared-opacity-base', sliced: true });
    const result = await f.run([wrapper]);
    assert.equal(result.assets.get(wrapper.id).uuid, base.uuid);
    assert.deepEqual(result.assets.get(wrapper.id).tint, { r: 1, g: 1, b: 1, a: 0.5 });
    assert.equal(base.tint, undefined);
    assert.equal(f.writes.length, 0);
});

test('a non-prefix same-name local ancestor cannot absorb an independent slice inside a prefix resource', async (t) => {
    const f = fixture(t);
    const slice = parseNode({ id: 'protected-slice', name: 'common_slice_base', type: 'FRAME',
        absoluteBoundingBox: { x: 2, y: 1, width: 15, height: 6 },
        children: [0, 1, 2].map((index) => ({ id: `protected-slice:${index}`, name: `Rectangle ${index}`,
            type: 'RECTANGLE', absoluteBoundingBox: { x: 2 + index * 5, y: 1, width: 5, height: 6 },
            fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] })),
    });
    const root = parseNode({ id: 'protected-parent', name: 'panel_local_ancestor', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 },
        children: [{ id: 'protected-prefix', name: 'img_card', type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, children: [slice,
                { id: 'protected-label', name: 'txt_count', type: 'TEXT', characters: '12',
                    absoluteBoundingBox: { x: 10, y: 0, width: 8, height: 4 } }] }],
    });
    registerLocal(f, root.name, { uuid: 'unused-parent-frame', sliced: false });
    const asset = registerLocal(f, slice.name, { uuid: 'independent-slice-frame', sliced: true });
    const libraryPath = join(f.localFolder, `${slice.name}.png`);
    const libraryBefore = readFileSync(libraryPath);
    const source = new PNG({ width: 15, height: 6 });
    source.data.fill(255);
    f.exportBytes.set(slice.id, PNG.sync.write(source));
    t.mock.method(AssetWriter.prototype, 'write', async (...args) => ({ ...await f.writeAsset(...args), sliced: true }));
    const decisions = automaticDecisions([root]);
    const result = await f.run([root], decisions);

    assert.equal(decisions.get(root.id).action, 'generate');
    assert.equal(decisions.get('protected-prefix').action, 'generate');
    assert.notEqual(result.assets.get(slice.id).uuid, asset.uuid, 'Figma slice definition creates its own output instead of taking library borders');
    assert.equal(result.assets.get(slice.id).sliced, true);
    assert.equal(result.assets.has(root.id), false);
    assert.deepEqual(f.existing, []);
    assert.deepEqual(f.exports.flatMap((item) => item.ids), [slice.id]);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].url, 'db://assets/figma-importer/common_slice_base.png');
    assert.deepEqual(f.writes[0].borders, { left: 5, right: 5, top: 0, bottom: 0 });
    assert.deepEqual([PNG.sync.read(f.writes[0].contents).width, PNG.sync.read(f.writes[0].contents).height], [12, 6]);
    assert.deepEqual(readFileSync(libraryPath), libraryBefore, 'the designated library retains its exact original pixels');
    assert.ok(f.notes.some((note) => note.action === 'fallback' && note.name === 'img_card' && /九宫/.test(note.reason)));
    assert.ok(!f.notes.some((note) => note.name === root.name && note.action === 'reused'));
});

test('a non-prefix same-name local ancestor cannot hide a prepared mask or report its unused resource', async (t) => {
    const f = fixture(t);
    const mask = maskedResource();
    const root = parseNode({ id: 'mask-parent', name: 'panel_mask_ancestor', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, children: [mask] });
    registerLocal(f, root.name, { uuid: 'unused-mask-parent', sliced: false });
    const base = registerLocal(f, 'common_mask_base', { uuid: 'original-white-frame', sliced: true });
    const decisions = automaticDecisions([root]);
    const result = await f.run([root], decisions);

    assert.equal(decisions.get(root.id).action, 'generate');
    assert.equal(result.assets.size, 1);
    assert.equal(result.assets.get(mask.id).uuid, base.uuid);
    assert.deepEqual(result.assets.get(mask.id).tint, { r: 208 / 255, g: 157 / 255, b: 105 / 255, a: 1 });
    assert.deepEqual(f.bindings.map((binding) => binding.id), [mask.id]);
    assert.deepEqual(f.exports, []);
    assert.deepEqual(f.writes, []);
    assert.ok(f.notes.some((note) => note.action === 'tinted' && note.name === mask.name));
    assert.ok(f.notes.every((note) => note.name === mask.name), 'only the actual outer mask boundary is reported');
});

test('an explicit transform ancestor prepares no descendant resources, tint or merge decisions', async (t) => {
    const f = fixture(t);
    const mask = maskedResource('transform-mask');
    const root = parseNode({ id: 'transform-root', name: 'panel_update', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, children: [
            { id: 'transform-icon', name: 'icon_badge', type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 },
                children: [imageNode('transform-image')] }, mask,
        ] });
    registerLocal(f, 'common_mask_base', { uuid: 'unused-transform-base', sliced: true });
    const decisions = automaticDecisions([root]);
    decisions.set(root.id, { action: 'transform', kind: 'node', nineSlice: false, explicit: true });
    const result = await f.run([root], decisions);

    assert.equal(result.assets.size, 0);
    assert.deepEqual(f.exports, []);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.existing, []);
    assert.deepEqual(f.bindings, []);
    assert.deepEqual(f.notes, []);
});

test('an external same-name white PNG cannot validate a different colored source asset for tint', async (t) => {
    const f = fixture(t);
    const mask = maskedResource('external-mask');
    const externalFolder = resolve(f.localFolder, '..', '..', 'external-library');
    mkdirSync(externalFolder);
    writeFileSync(join(externalFolder, 'common_mask_base.png'), bitmap(255, 255, 255));
    writeFileSync(join(f.localFolder, 'cached-colored.png'), bitmap(100, 80, 40));
    const coloredAsset = { uuid: 'mapped-colored-source', url: 'db://assets/shared/cached-colored.png', sliced: true };
    t.mock.method(AssetWriter.prototype, 'existingForSource', async (sourceKey, options) => {
        f.lookups.push({ sourceKey, options });
        return JSON.parse(sourceKey)[1] === `${mask.id}:mask` ? coloredAsset : null;
    });
    f.exportBytes.set(mask.id, bitmap(208, 157, 105));
    const result = await f.run([mask], automaticDecisions([mask]), { localResourceFolders: [externalFolder] });

    assert.equal(result.assets.get(mask.id).tint, undefined);
    assert.notEqual(result.assets.get(mask.id).uuid, coloredAsset.uuid);
    assert.deepEqual(f.bindings.map((binding) => binding.id), [mask.id]);
    assert.ok(f.notes.some((note) => note.action === 'fallback' && /底图含非白 RGB/.test(note.reason)));
    assert.ok(!f.notes.some((note) => note.action === 'tinted'));
    assert.equal(f.writes.length, 1, 'the correct complete mask composition is resolved instead');
});

for (const alias of [false, true]) {
    test(`preexisting same-name resource wins for different IMAGE references through ${alias ? 'space/underscore filename aliases' : 'a repeated Figma name'}`, async (t) => {
        const f = fixture(t);
        const a = imageNode('local-collision-A', true, alias ? 'Shared Asset' : 'Shared');
        const b = imageNode('local-collision-B', false, alias ? 'Shared_Asset' : 'Shared');
        const localName = alias ? 'Shared_Asset' : 'Shared';
        const local = registerLocal(f, localName, { uuid: 'original-local-candidate', sliced: false }, bitmap(70));
        const result = await f.run([a, b]);

        assert.deepEqual(f.existing, alias ? [local.url, local.url] : [local.url]);
        assert.equal(result.assets.get(a.id), local);
        assert.equal(result.assets.get(b.id), local);
        assert.equal(f.exports.length, 0);
        assert.equal(f.fillRequests(), 0);
        assert.equal(f.downloads.length, 0);
        assert.equal(f.writes.length, 0);
        assert.ok(f.bindings.every((binding) => binding.source === 'local'));
        assert.ok(!f.notes.some((note) => /同一本地文件/.test(note.reason)));
    });
}

test('identical IMAGE reference and geometry retain declared local name reuse across visibility changes', async (t) => {
    const f = fixture(t);
    const a = imageNode('equivalent-A', true);
    const b = imageNode('equivalent-B', false);
    b.fills[0].imageRef = a.fills[0].imageRef;
    const local = registerLocal(f, 'Shared', { uuid: 'compatible-local-frame', sliced: true }, bitmap(90));
    const result = await f.run([a, b]);

    assert.equal(result.assets.get(a.id), local);
    assert.equal(result.assets.get(b.id), local);
    assert.deepEqual(f.existing, [local.url]);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.exports, []);
    assert.equal(f.fillRequests(), 0);
    assert.deepEqual(f.downloads, []);
    assert.equal(f.notes.filter((note) => note.action === 'reused').length, 2);
    assert.ok(!f.notes.some((note) => /同一本地文件/.test(note.reason)));
});

test('preexisting same-name SpriteFrame retains its UUID for different IMAGE target geometry', async (t) => {
    const f = fixture(t);
    const a = imageNode('geometry-A');
    const b = imageNode('geometry-B');
    b.fills[0].imageRef = a.fills[0].imageRef;
    b.absoluteBoundingBox.width = 10;
    const local = registerLocal(f, 'Shared', { uuid: 'existing-geometry-frame', sliced: false });
    const result = await f.run([a, b]);

    assert.deepEqual(f.existing, [local.url]);
    assert.equal(f.fillRequests(), 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(result.assets.get(a.id), local);
    assert.equal(result.assets.get(b.id), local);
    assert.ok(!f.notes.some((note) => /同一本地文件/.test(note.reason)));
});

test('whole-node PNG and raw IMAGE share the first same-name resource without downloading the second source', async (t) => {
    const f = fixture(t);
    const rendered = imageNode('mixed-render');
    rendered.effects = [{ type: 'DROP_SHADOW', visible: true }];
    const raw = imageNode('mixed-raw', false);
    f.exportBytes.set(rendered.id, bitmap(30));
    f.fillBytes.set(raw.fills[0].imageRef, bitmap(220));
    t.mock.method(AssetWriter.prototype, 'write', async (url, contents, borders) => {
        const asset = await f.writeAsset(url, contents, borders);
        const path = join(f.outputFolder, url.split('/').pop());
        writeFileSync(path, contents);
        f.localAssets.set(url, asset);
        return asset;
    });
    const result = await f.run([rendered, raw]);

    assert.deepEqual(f.exports.flatMap((entry) => entry.ids), [rendered.id]);
    assert.equal(f.fillRequests(), 0);
    assert.equal(f.downloads.length, 1);
    assert.deepEqual(f.existing, []);
    assert.equal(f.writes.length, 1);
    assert.equal(result.assets.get(rendered.id), result.assets.get(raw.id));
});

for (const plain of [false, true]) {
    test(`a preimport output resource keeps its original UUID for ${plain ? 'plain raw IMAGE' : 'whole-node PNG'} without network`, async (t) => {
        const f = fixture(t);
        const node = imageNode(`preexisting-${plain}`);
        if (!plain) node.effects = [{ type: 'DROP_SHADOW', visible: true }];
        const asset = { uuid: 'preexisting-output-frame', url: 'db://assets/figma-importer/Shared.png', sliced: true };
        writeFileSync(join(f.outputFolder, 'Shared.png'), bitmap(90));
        f.localAssets.set(asset.url, asset);
        const result = await f.run([node]);

        assert.equal(result.assets.get(node.id), asset);
        assert.deepEqual(f.existing, [asset.url]);
        assert.equal(f.writes.length, 0);
        assert.deepEqual(f.exports, []);
        assert.deepEqual(f.downloads, []);
        assert.equal(f.fillRequests(), 0);
        assert.equal(f.bindings[0].source, 'existing');
    });
}

for (const plain of [false, true]) {
    test(`same-name output wins without consulting legacy source variants (raw IMAGE: ${plain})`, async (t) => {
        const f = fixture(t);
        const a = imageNode('history-A'), b = imageNode('history-B');
        if (!plain) {
            a.effects = [{ type: 'DROP_SHADOW', visible: true }];
            b.effects = [{ type: 'DROP_SHADOW', visible: true }];
        }
        const asset = { uuid: 'original-output-frame', url: 'db://assets/figma-importer/Shared.png', sliced: true };
        writeFileSync(join(f.outputFolder, 'Shared.png'), bitmap(90));
        f.localAssets.set(asset.url, asset);
        t.mock.method(AssetWriter.prototype, 'existingForSource', async () => assert.fail('name reuse must not inspect legacy source variants'));
        const result = await f.run([a, b]);
        assert.equal(result.assets.get(a.id), asset);
        assert.equal(result.assets.get(b.id), asset);
        assert.equal(f.writes.length, 0);
        assert.deepEqual(f.exports, []);
        assert.deepEqual(f.downloads, []);
    });
}

for (const refresh of [false, true]) {
    test(`same-name IMAGE downloads and writes once while keeping each instance opacity (refresh: ${refresh})`, async (t) => {
        const f = fixture(t);
        const wrapper = (id, opacity, width, visible) => parseNode({ id, name: 'Shared', type: 'INSTANCE', visible,
            absoluteBoundingBox: { x: 0, y: 0, width, height: 10 }, children: [{
                id: `${id}:leaf`, name: 'Leaf', type: 'RECTANGLE', opacity,
                absoluteBoundingBox: { x: 0, y: 0, width, height: 10 },
                fills: [{ type: 'IMAGE', imageRef: 'shared-image-ref', scaleMode: 'FILL' }],
            }] });
        const a = wrapper('same-A', 0.25, 20, true), b = wrapper('same-B', 0.75, 10, false);
        f.fillBytes.set('shared-image-ref', bitmap(120));
        const result = await f.run([a, b], renderDecisions([a, b]), { refreshAssets: refresh });
        assert.equal(f.fillRequests(), 1);
        assert.equal(f.downloads.length, 1);
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.lookups, []);
        assert.equal(result.assets.get(a.id).uuid, result.assets.get(b.id).uuid);
        assert.equal(result.assets.get(a.id).tint.a, 0.25);
        assert.equal(result.assets.get(b.id).tint.a, 0.75);
    });
}
