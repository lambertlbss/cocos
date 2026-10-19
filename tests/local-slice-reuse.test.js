'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve, relative, isAbsolute } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { buildAssets } = require('../dist/main');
const { parseNode } = require('../dist/figma/parser');
const { AssetWriter } = require('../dist/importer/assets');
const { LocalResourceLibrary } = require('../dist/importer/local-resources');
const { LocalAssetCache } = require('../dist/importer/cache');
const { DEFAULT_SETTINGS } = require('../dist/types');

function sliceNode(mode = 'nine') {
    const rows = mode === 'horizontal' ? 1 : 3;
    const cols = mode === 'vertical' ? 1 : 3;
    const children = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) children.push({
        id: `piece-${y}-${x}`, name: `Rectangle ${y}-${x}`, type: 'RECTANGLE', visible: true,
        absoluteBoundingBox: { x: x * 10, y: y * 10, width: 10, height: 10 },
    });
    return parseNode({ id: 'panel', name: 'Panel', type: 'FRAME', visible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: cols * 10, height: rows * 10 }, children });
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
    writeFileSync(join(options.outputOnly ? outputFolder : folder, `Panel.${extension}`),
        Buffer.from('preexisting bitmap: must never be compacted'));
    const bindings = [];
    const lookups = [];
    const localAssets = new Map([[asset.url, asset]]);
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});
    t.mock.method(LocalAssetCache.prototype, 'initialize', async () => {});
    t.mock.method(AssetWriter.prototype, 'existingForSource', async (sourceKey) => {
        assert.deepEqual(JSON.parse(sourceKey).slice(0, 2), ['file', 'panel']);
        return null;
    });
    t.mock.method(AssetWriter.prototype, 'resolve', async () => assert.fail('must not create or rewrite an image'));
    t.mock.method(AssetWriter.prototype, 'existing', async (url, tiled) => {
        assert.equal(tiled, undefined, 'do not rewrite local metadata');
        lookups.push(url);
        if (localAssets.has(url) && !options.unready) return localAssets.get(url);
        if (options.outputOnly) return null;
        assert.fail(`unexpected fallback lookup: ${url}`);
    });
    t.mock.method(AssetWriter.prototype, 'write', async () => assert.fail('must not create or rewrite an image'));
    t.mock.method(LocalAssetCache.prototype, 'read', async () => assert.fail('must not use download cache'));
    t.mock.method(LocalAssetCache.prototype, 'write', async () => assert.fail('must not download/cache a replacement'));
    const node = sliceNode(options.mode);
    if (options.invalidGrid) node.children = [];
    const decisions = new Map([['panel', { action: 'render', kind: 'sprite', nineSlice: true,
        explicit: true, name: 'RenamedPanel' }]]);
    const run = (settings = {}) => buildAssets({ fileKey: 'file', roots: [node] }, decisions, {
        ...DEFAULT_SETTINGS, scale: 2, refreshAssets: Boolean(options.refresh), localResourceFolders: [folder],
        ...settings,
    }, { bind(...args) { bindings.push(args); }, beforeWrite() { assert.fail('must not record generated assets'); } });
    return { run, asset, bindings, lookups, folder, outputFolder, project, localAssets };
}

for (const extension of ['jpg', 'JPEG']) test(`local ${extension} reuses original UUID despite Cocos rename and refresh`, async (t) => {
    const f = setup(t, { extension, refresh: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(f.lookups, [f.asset.url]);
});

test('reimport finds the previously generated JPG without downloading PNG', async (t) => {
    const f = setup(t, { extension: 'jpg', outputOnly: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.bindings[0][2], 'existing');
});

for (const mode of ['nine', 'horizontal', 'vertical']) {
    for (const refresh of [false, true]) test(`${mode} reuses local UUID before slice compaction (refresh=${refresh})`, async (t) => {
        const f = setup(t, { mode, refresh });
        const result = await f.run();
        assert.equal(result.assets.get('panel'), f.asset);
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(f.lookups, [f.asset.url]);
        assert.equal(f.bindings.length, 1, 'slice children are not independently imported');
        assert.equal(f.bindings[0][2], 'local');
    });
}

test('local slice borders work even when Figma slice geometry cannot be inferred', async (t) => {
    const f = setup(t, { invalidGrid: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(result.warnings, []);
});

test('local resource without borders is still reused unchanged with a warning', async (t) => {
    const f = setup(t, { sliced: false });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.asset.sliced, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /未配置九宫边距/);
});

test('existing output slice resource is reused on repeated import without refresh', async (t) => {
    const f = setup(t, { outputOnly: true });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.bindings[0][2], 'existing');
    assert.deepEqual(f.lookups, [f.asset.url], 'an output file present before this import is found by its original name');
});

test('same-name files in one local library retain root-before-nested priority even with different pixels', async (t) => {
    const f = setup(t);
    const nested = join(f.folder, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'Panel.png'), Buffer.from('different nested bitmap: lower original priority'));
    const lower = { uuid: 'lower-nested-slice', url: 'db://assets/shared/nested/Panel.png', sliced: true };
    f.localAssets.set(lower.url, lower);

    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.deepEqual(f.lookups, [f.asset.url]);
});

test('declared local directory order wins over different same-name candidates and an existing output snapshot', async (t) => {
    const f = setup(t);
    const secondFolder = join(f.project, 'assets', 'second-shared');
    mkdirSync(secondFolder);
    writeFileSync(join(secondFolder, 'Panel.png'), Buffer.from('second library bitmap: original ordering decides'));
    const second = { uuid: 'second-library-slice', url: 'db://assets/second-shared/Panel.png', sliced: true };
    f.localAssets.set(second.url, second);
    writeFileSync(join(f.outputFolder, 'Panel.png'), Buffer.from('lower-priority preexisting output bitmap'));
    const output = { uuid: 'existing-output-slice', url: 'db://assets/figma-importer/Panel.png', sliced: true };
    f.localAssets.set(output.url, output);

    const firstOrder = await f.run({ localResourceFolders: [f.folder, secondFolder] });
    const secondOrder = await f.run({ localResourceFolders: [secondFolder, f.folder] });
    assert.equal(firstOrder.assets.get('panel'), f.asset);
    assert.equal(secondOrder.assets.get('panel'), second);
    assert.deepEqual(f.lookups, [f.asset.url, second.url]);
    assert.ok(f.bindings.every((binding) => binding[2] === 'local'));
});

test('unregistered local SpriteFrame reports an error rather than creating a duplicate', async (t) => {
    const f = setup(t, { unready: true });
    // Preserve a real missing-asset result instead of the default unexpected-lookup guard.
    t.mock.method(AssetWriter.prototype, 'existing', async () => null);
    await assert.rejects(f.run(), /尚无可用 SpriteFrame.*不会另建副本/);
    assert.deepEqual(f.bindings, []);
});

test('without a local or existing asset, cached full PNG still follows slice generation', async (t) => {
    const { PNG } = require('pngjs');
    const f = setup(t);
    const image = new PNG({ width: 60, height: 60 });
    image.data.fill(255);
    const contents = PNG.sync.write(image);
    t.mock.method(LocalResourceLibrary.prototype, 'find', async () => null);
    t.mock.method(AssetWriter.prototype, 'existing', async () => null);
    t.mock.method(LocalAssetCache.prototype, 'read', async () => contents);
    const writes = [];
    t.mock.method(AssetWriter.prototype, 'write', async (url, bytes, borders) => {
        writes.push({ url, bytes, borders });
        return { uuid: 'new-sliced-frame', url, sliced: true };
    });
    const result = await f.run();
    assert.equal(result.assets.get('panel').uuid, 'new-sliced-frame');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, 'db://assets/figma-importer/Panel.png');
    assert.deepEqual(writes[0].borders, { left: 20, right: 20, top: 20, bottom: 20 });
    const compact = PNG.sync.read(writes[0].bytes);
    assert.equal(compact.width, 44);
    assert.equal(compact.height, 44);
    assert.equal(f.bindings[0][2], 'cache');
});
