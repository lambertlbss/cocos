'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { PNG } = require('pngjs');
const { buildAssets } = require('../dist/main');
const { parseNode } = require('../dist/figma/parser');
const { FigmaClient } = require('../dist/figma/client');
const { AssetWriter } = require('../dist/importer/assets');
const { LocalResourceLibrary } = require('../dist/importer/local-resources');
const { LocalAssetCache } = require('../dist/importer/cache');
const { TokenVault } = require('../dist/security/token-vault');
const { DEFAULT_SETTINGS } = require('../dist/types');

function sliceNode(mode = 'nine', id = 'panel') {
    const rows = mode === 'horizontal' ? 1 : 3;
    const cols = mode === 'vertical' ? 1 : 3;
    const children = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) children.push({
        id: `${id}-piece-${y}-${x}`, name: `Rectangle ${y}-${x}`, type: 'RECTANGLE', visible: true,
        absoluteBoundingBox: { x: x * 10, y: y * 10, width: 10, height: 10 },
    });
    return parseNode({ id, name: 'Panel', type: 'FRAME', visible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: cols * 10, height: rows * 10 }, children });
}

function bitmap(width, height) {
    const image = new PNG({ width, height });
    image.data.fill(255);
    return PNG.sync.write(image);
}

function setup(t, options = {}) {
    const project = mkdtempSync(join(tmpdir(), 'figma-local-slice-reuse-'));
    const folder = join(project, 'assets', 'shared');
    const outputFolder = join(project, 'assets', DEFAULT_SETTINGS.assetFolder);
    mkdirSync(folder, { recursive: true });
    mkdirSync(outputFolder, { recursive: true });
    mkdirSync(join(project, 'temp'), { recursive: true });
    const extension = options.extension ?? 'png';
    const localUrl = `db://assets/shared/Panel.${extension}`;
    const outputUrl = `db://assets/figma-importer/Panel.${extension}`;
    const asset = { uuid: 'original-sprite-frame', url: options.outputOnly ? outputUrl : localUrl,
        sliced: options.sliced !== false };
    const originalEditor = global.Editor;
    global.Editor = { Project: { path: project, tmpDir: join(project, 'temp') }, Message: { send() {} } };
    t.after(() => {
        global.Editor = originalEditor;
        const suffix = relative(resolve(tmpdir()), resolve(project));
        assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix), 'cleanup stays inside the temporary directory');
        rmSync(project, { recursive: true, force: true });
    });
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});
    const localBytes = Buffer.from('preexisting bitmap: must never be used as the full Figma slice source');
    const localPath = join(options.outputOnly ? outputFolder : folder, `Panel.${extension}`);
    writeFileSync(localPath, localBytes);
    const bindings = [], lookups = [], writes = [], exports = [], downloads = [], cacheReads = [], cacheWrites = [], notes = [];
    const localAssets = new Map([[asset.url, asset]]);
    const node = sliceNode(options.mode);
    if (options.invalidGrid) node.children = [];
    const fullPng = bitmap(node.absoluteBoundingBox.width * 2, node.absoluteBoundingBox.height * 2);
    const cached = new Map([[node.id, fullPng]]);
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});
    t.mock.method(LocalAssetCache.prototype, 'initialize', async () => {});
    t.mock.method(AssetWriter.prototype, 'existingForSource', async () => assert.fail('ordinary resources do not use source-variant lookups'));
    t.mock.method(AssetWriter.prototype, 'resolve', async () => assert.fail('same-name Figma slices do not create source variants'));
    t.mock.method(AssetWriter.prototype, 'existing', async (url, tiled) => {
        assert.equal(tiled, undefined, 'do not rewrite local metadata');
        lookups.push(url);
        return options.unready ? null : localAssets.get(url) ?? null;
    });
    const outputAsset = { uuid: options.outputOnly ? asset.uuid : 'generated-frame',
        url: options.outputOnly ? outputUrl : 'db://assets/figma-importer/Panel.png', sliced: true };
    t.mock.method(AssetWriter.prototype, 'write', async (url, bytes, borders) => {
        assert.ok(url.startsWith('db://assets/figma-importer/'), 'never overwrite the designated source library');
        writes.push({ url, bytes, borders });
        return outputAsset;
    });
    t.mock.method(LocalAssetCache.prototype, 'read', async (key) => { cacheReads.push(key); return cached.get(key.nodeId) ?? null; });
    t.mock.method(LocalAssetCache.prototype, 'write', async (key, contents) => {
        cacheWrites.push({ key, contents }); cached.set(key.nodeId, contents);
    });
    t.mock.method(TokenVault.prototype, 'get', async () => 'test-token');
    t.mock.method(FigmaClient.prototype, 'getImageUrls', async (fileKey, ids, format, scale, useAbsoluteBounds) => {
        exports.push({ fileKey, ids, format, scale, useAbsoluteBounds });
        return Object.fromEntries(ids.map((id) => [id, `fixture-render:${id}`]));
    });
    t.mock.method(FigmaClient.prototype, 'getImageFillUrls', async () => assert.fail('same-name IMAGE must share the Figma slice result'));
    t.mock.method(FigmaClient.prototype, 'download', async (url) => { downloads.push(url); return fullPng; });
    const decision = { action: 'render', kind: 'sprite', nineSlice: true, explicit: true, name: 'RenamedPanel' };
    const run = (settings = {}, roots = [node], overrides, fileKey = 'file') => {
        const decisions = overrides ?? new Map(roots.map((root) => [root.id,
            root === node ? { ...decision } : { action: 'render', kind: 'sprite', nineSlice: false, explicit: true }]));
        const nodeById = new Map();
        const visit = (item) => { nodeById.set(item.id, item); item.children.forEach(visit); };
        roots.forEach(visit);
        return buildAssets({ fileKey, roots, nodeById }, decisions, {
            ...DEFAULT_SETTINGS, scale: 2, refreshAssets: Boolean(options.refresh), localResourceFolders: [folder], ...settings,
        }, { bind(...args) { bindings.push(args); }, beforeWrite() {}, note(...args) { notes.push(args); } });
    };
    return { run, node, asset, outputAsset, bindings, lookups, writes, exports, downloads, cacheReads, cacheWrites, cached,
        notes, fullPng, localBytes, localPath, folder, outputFolder, project, localAssets };
}

for (const extension of ['jpg', 'JPEG']) test(`ordinary local ${extension} retains its UUID despite Cocos rename and refresh`, async (t) => {
    const f = setup(t, { extension, refresh: true, invalidGrid: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(f.lookups, [f.asset.url]);
    assert.equal(f.writes.length, 0);
    assert.equal(f.exports.length, 0);
});

test('without valid Figma geometry, repeated imports still reuse generated JPGs', async (t) => {
    const f = setup(t, { extension: 'jpg', outputOnly: true, invalidGrid: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.bindings[0][2], 'existing');
    assert.equal(f.writes.length, 0);
});

for (const mode of ['nine', 'horizontal', 'vertical']) {
    for (const refresh of [false, true]) test(`${mode} Figma geometry overrides local borders without touching the library (refresh=${refresh})`, async (t) => {
        const f = setup(t, { mode, refresh });
        const result = await f.run();
        assert.equal(result.assets.get('panel'), f.outputAsset);
        assert.notEqual(result.assets.get('panel').uuid, f.asset.uuid);
        assert.deepEqual(f.lookups, []);
        assert.equal(f.writes.length, 1);
        assert.deepEqual(f.writes[0].borders, mode === 'horizontal'
            ? { left: 20, right: 20, top: 0, bottom: 0 } : mode === 'vertical'
                ? { left: 0, right: 0, top: 20, bottom: 20 } : { left: 20, right: 20, top: 20, bottom: 20 });
        assert.deepEqual([PNG.sync.read(f.writes[0].bytes).width, PNG.sync.read(f.writes[0].bytes).height],
            mode === 'horizontal' ? [44, 20] : mode === 'vertical' ? [20, 44] : [44, 44]);
        assert.deepEqual(readFileSync(f.localPath), f.localBytes);
        assert.equal(f.bindings.length, 1, 'slice children are not independently imported');
        assert.equal(f.bindings[0][2], refresh ? 'figma' : 'cache');
        assert.equal(f.exports.length, refresh ? 1 : 0);
        if (refresh) {
            assert.equal(f.exports[0].useAbsoluteBounds, true);
            assert.deepEqual(f.cacheWrites[0].contents, f.fullPng, 'cache always keeps the complete source');
        }
    });
}

test('local slice borders remain available when Figma has no valid geometry', async (t) => {
    const f = setup(t, { invalidGrid: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(result.warnings, []);
});

test('local resource without borders is reused unchanged only when Figma has no valid slice definition', async (t) => {
    const f = setup(t, { sliced: false, invalidGrid: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.asset.sliced, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /未配置九宫边距/);
});

for (const sliced of [false, true]) test(`Figma slices replace old output pixels/borders in place (old sliced=${sliced})`, async (t) => {
    const f = setup(t, { outputOnly: true, sliced });
    await f.run();
    await f.run();
    assert.equal(f.writes.length, 2, 'each import reconstructs from the full source rather than trusting old output insets');
    assert.equal(f.exports.length, 0, 'the complete source cache avoids repeated network rendering');
    assert.ok(f.writes.every((item) => item.url === f.asset.url));
    assert.deepEqual(f.lookups, []);
    assert.ok(f.bindings.every((binding) => binding[1].uuid === f.asset.uuid));
});

test('an old compact texture in the cache is rejected as a full slice source and re-exported', async (t) => {
    const f = setup(t);
    f.cached.set('panel', bitmap(44, 44));
    await f.run();
    assert.equal(f.exports.length, 1);
    assert.deepEqual(f.exports[0].ids, ['panel']);
    assert.equal(f.exports[0].useAbsoluteBounds, true);
    assert.equal(f.downloads.length, 1);
    assert.deepEqual(f.cacheWrites[0].contents, f.fullPng);
    assert.equal(f.writes.length, 1);
    assert.ok(f.notes.some((note) => /缓存不是 Figma 完整画布/.test(note[2])));
});

test('ordinary PNG first, later same-name Figma slice exports and writes only the slice source', async (t) => {
    const f = setup(t, { refresh: true });
    const ordinary = parseNode({ id: 'ordinary', name: 'Panel', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 30 }, effects: [{ type: 'DROP_SHADOW' }] });
    const result = await f.run({}, [ordinary, f.node]);
    assert.deepEqual(f.exports.flatMap((item) => item.ids), ['panel']);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(result.assets.get(ordinary.id), result.assets.get(f.node.id));
    assert.equal(result.assets.get(ordinary.id).sliced, true);
});

test('same-name IMAGE and generated gradient share the slice even when encountered first', async (t) => {
    const f = setup(t);
    const image = parseNode({ id: 'image', name: 'Panel', type: 'RECTANGLE',
        absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 30 },
        fills: [{ type: 'IMAGE', imageRef: 'ordinary-fill', scaleMode: 'FILL' }] });
    const gradient = parseNode({ id: 'gradient', name: 'Panel', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 30 },
        fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
            gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
                { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }],
        children: [{ id: 'text', name: 'Title', type: 'TEXT', characters: 'Text' }] });
    const decisions = new Map([
        ['panel', { action: 'render', kind: 'sprite', nineSlice: true, explicit: true }],
        ['image', { action: 'render', kind: 'sprite', nineSlice: false, explicit: true }],
        ['gradient', { action: 'generate', kind: 'node', nineSlice: false, explicit: true }],
        ['text', { action: 'generate', kind: 'label', nineSlice: false, explicit: true }],
    ]);
    const result = await f.run({}, [image, gradient, f.node], decisions);
    assert.equal(f.writes.length, 1);
    assert.equal(f.exports.length, 0);
    assert.equal(f.cacheReads.length, 1, 'no IMAGE download or gradient preparation is needed');
    assert.equal(result.assets.get(image.id), result.assets.get(f.node.id));
    assert.equal(result.assets.get(gradient.id), result.assets.get(f.node.id));
});

test('conflicting same-name slices retain the first valid Figma definition and explain the choice', async (t) => {
    const f = setup(t);
    const other = sliceNode('horizontal', 'other-panel');
    const result = await f.run({}, [f.node, other]);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].borders, { left: 20, right: 20, top: 20, bottom: 20 });
    assert.equal(result.assets.get(other.id), result.assets.get(f.node.id));
    assert.match(result.warnings.join(';'), /同名三\/九宫定义不同.*首个有效/);
});

test('a Figma slice never writes into a designated source library even when output overlaps it', async (t) => {
    const f = setup(t);
    await assert.rejects(f.run({ assetFolder: 'shared' }), /位于指定本地素材库.*调整输出目录/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.exports.length, 0);
    assert.deepEqual(readFileSync(f.localPath), f.localBytes);
});

test('ordinary same-name local files retain root-before-nested priority', async (t) => {
    const f = setup(t, { invalidGrid: true });
    const nested = join(f.folder, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'Panel.png'), Buffer.from('different nested bitmap: lower original priority'));
    f.localAssets.set('db://assets/shared/nested/Panel.png', { uuid: 'nested', url: 'db://assets/shared/nested/Panel.png', sliced: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(f.lookups, [f.asset.url]);
});

test('ordinary local directory order wins over other local candidates and existing output', async (t) => {
    const f = setup(t, { invalidGrid: true });
    const secondFolder = join(f.project, 'assets', 'second-shared');
    mkdirSync(secondFolder);
    writeFileSync(join(secondFolder, 'Panel.png'), Buffer.from('second library bitmap'));
    const second = { uuid: 'second-library', url: 'db://assets/second-shared/Panel.png', sliced: true };
    f.localAssets.set(second.url, second);
    writeFileSync(join(f.outputFolder, 'Panel.png'), Buffer.from('lower-priority output bitmap'));
    const firstOrder = await f.run({ localResourceFolders: [f.folder, secondFolder] });
    const secondOrder = await f.run({ localResourceFolders: [secondFolder, f.folder] });
    assert.equal(firstOrder.assets.get('panel'), f.asset);
    assert.equal(secondOrder.assets.get('panel'), second);
    assert.deepEqual(f.lookups, [f.asset.url, second.url]);
    assert.equal(f.writes.length, 0);
});

test('an ordinary unregistered local SpriteFrame still fails without creating a duplicate', async (t) => {
    const f = setup(t, { unready: true, invalidGrid: true });
    await assert.rejects(f.run(), /尚无可用 SpriteFrame.*不会另建副本/);
    assert.deepEqual(f.bindings, []);
    assert.equal(f.writes.length, 0);
});

test('cached full PNG follows Figma slicing even without any local or output match', async (t) => {
    const f = setup(t);
    t.mock.method(LocalResourceLibrary.prototype, 'find', async () => null);
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.outputAsset);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].borders, { left: 20, right: 20, top: 20, bottom: 20 });
    assert.equal(f.bindings[0][2], 'cache');
});
