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
const realAssetExisting = AssetWriter.prototype.existing;

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
    const localBytes = bitmap(12, 12);
    const localMeta = Buffer.from(JSON.stringify({ uuid: 'local-image-uuid', userData: { artistSetting: true },
        subMetas: { frame: { uuid: asset.uuid, importer: 'sprite-frame', userData: {
            trimType: 'none', borderLeft: options.sliced === false ? 0 : 1,
            borderRight: options.sliced === false ? 0 : 2, borderTop: options.sliced === false ? 0 : 3,
            borderBottom: options.sliced === false ? 0 : 4,
        } } } }));
    const localPath = join(options.outputOnly ? outputFolder : folder, `Panel.${extension}`);
    writeFileSync(localPath, localBytes);
    writeFileSync(`${localPath}.meta`, localMeta);
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
        notes, fullPng, localBytes, localMeta, localPath, folder, outputFolder, project, localAssets };
}

for (const extension of ['jpg', 'JPEG']) test(`a designated local ${extension} retains its UUID despite Figma slicing, rename and refresh`, async (t) => {
    const f = setup(t, { extension, refresh: true });
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
    for (const refresh of [false, true]) test(`${mode} explicitly selected local SpriteFrame keeps its UUID and original insets (refresh=${refresh})`, async (t) => {
        const f = setup(t, { mode, refresh });
        const result = await f.run();
        assert.equal(result.assets.get('panel'), f.asset);
        assert.deepEqual(f.lookups, [f.asset.url]);
        assert.equal(f.writes.length, 0);
        assert.equal(f.exports.length, 0);
        assert.equal(f.downloads.length, 0);
        assert.equal(f.cacheReads.length, 0);
        assert.equal(f.bindings.length, 1, 'slice children are not independently imported');
        assert.equal(f.bindings[0][2], 'local');
        assert.deepEqual(readFileSync(f.localPath), f.localBytes);
        assert.deepEqual(readFileSync(`${f.localPath}.meta`), f.localMeta);
        assert.ok(!f.notes.some((note) => /使用 Figma 原始画布/.test(note[2])), 'a reused library resource is never reported as generated');
    });
    for (const refresh of [false, true]) test(`${mode} without a designated local match generates Figma pixels and original insets (refresh=${refresh})`, async (t) => {
        const f = setup(t, { mode, refresh });
        const result = await f.run({ localResourceFolders: [] });
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

test('an explicitly selected local resource without borders is reused unchanged with a clear warning', async (t) => {
    const f = setup(t, { sliced: false });
    const result = await f.run();
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.asset.sliced, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /未配置九宫边距/);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(readFileSync(`${f.localPath}.meta`), f.localMeta);
});

for (const sliced of [false, true]) test(`Figma slices replace old output pixels/borders in place (old sliced=${sliced})`, async (t) => {
    const f = setup(t, { outputOnly: true, sliced });
    await f.run({ localResourceFolders: [] });
    await f.run({ localResourceFolders: [] });
    assert.equal(f.writes.length, 2, 'each import reconstructs from the full source rather than trusting old output insets');
    assert.equal(f.exports.length, 0, 'the complete source cache avoids repeated network rendering');
    assert.ok(f.writes.every((item) => item.url === f.asset.url));
    assert.deepEqual(f.lookups, []);
    assert.ok(f.bindings.every((binding) => binding[1].uuid === f.asset.uuid));
});

test('an old compact texture in the cache is rejected as a full slice source and re-exported', async (t) => {
    const f = setup(t);
    f.cached.set('panel', bitmap(44, 44));
    await f.run({ localResourceFolders: [] });
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
    const result = await f.run({ localResourceFolders: [] }, [ordinary, f.node]);
    assert.deepEqual(f.exports.flatMap((item) => item.ids), ['panel']);
    assert.equal(f.downloads.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(result.assets.get(ordinary.id), result.assets.get(f.node.id));
    assert.equal(result.assets.get(ordinary.id).sliced, true);
});

test('same-name PNG, IMAGE and gradient share the explicitly selected local slice without a write', async (t) => {
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
    assert.equal(f.writes.length, 0);
    assert.equal(f.exports.length, 0);
    assert.equal(f.cacheReads.length, 0, 'no download or gradient preparation is needed');
    assert.equal(f.lookups.length, 1);
    assert.equal(result.assets.get(f.node.id), f.asset);
    assert.equal(result.assets.get(image.id), result.assets.get(f.node.id));
    assert.equal(result.assets.get(gradient.id), result.assets.get(f.node.id));
});

test('conflicting same-name slices retain the first valid Figma definition and explain the choice', async (t) => {
    const f = setup(t);
    const other = sliceNode('horizontal', 'other-panel');
    const result = await f.run({ localResourceFolders: [] }, [f.node, other]);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].borders, { left: 20, right: 20, top: 20, bottom: 20 });
    assert.equal(result.assets.get(other.id), result.assets.get(f.node.id));
    assert.match(result.warnings.join(';'), /同名三\/九宫定义不同.*首个有效/);
});

test('the first designated library remains authoritative when the output is another search directory', async (t) => {
    const f = setup(t);
    const sourceMeta = Buffer.from('{"uuid":"shared-original","artistSetting":true}');
    writeFileSync(`${f.localPath}.meta`, sourceMeta);
    writeFileSync(join(f.outputFolder, 'Panel.png'), Buffer.from('previous unminimized output'));
    const result = await f.run({ localResourceFolders: [f.folder, f.outputFolder] });
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.lookups, [f.asset.url]);
    assert.equal(f.exports.length, 0);
    assert.deepEqual(readFileSync(f.localPath), f.localBytes);
    assert.deepEqual(readFileSync(`${f.localPath}.meta`), sourceMeta);
});

test('a parent assets search directory directly reuses a nested local match', async (t) => {
    const f = setup(t);
    const sourceMeta = Buffer.from('{"uuid":"sibling-material","keepOriginal":true}');
    writeFileSync(`${f.localPath}.meta`, sourceMeta);
    const result = await f.run({ localResourceFolders: [join(f.project, 'assets')] });
    assert.equal(result.assets.get('panel'), f.asset);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.lookups, [f.asset.url]);
    assert.deepEqual(readFileSync(f.localPath), f.localBytes);
    assert.deepEqual(readFileSync(`${f.localPath}.meta`), sourceMeta);
});

test('a real SpriteFrame lookup retains local PNG, Meta and UUID even when output points at that library', async (t) => {
    const f = setup(t);
    const url = 'db://assets/shared/Panel.png';
    const imageUuid = 'existing-image-uuid';
    const info = { uuid: imageUuid, url, imported: true, invalid: false, importer: 'image', type: 'cc.ImageAsset',
        subAssets: { frame: { uuid: f.asset.uuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
    let meta = { uuid: imageUuid, importer: 'image', userData: { type: 'sprite-frame', custom: 'keep-me' },
        subMetas: { frame: { uuid: f.asset.uuid, importer: 'sprite-frame', userData: {
            trimType: 'auto', borderLeft: 1, borderRight: 1, borderTop: 1, borderBottom: 1,
        } } } };
    writeFileSync(`${f.localPath}.meta`, JSON.stringify(meta));
    const sibling = join(f.outputFolder, 'Other.png');
    const siblingBytes = Buffer.from('outside the explicitly selected output');
    const siblingMeta = Buffer.from('{"uuid":"untouched-material","artistSetting":true}');
    writeFileSync(sibling, siblingBytes); writeFileSync(`${sibling}.meta`, siblingMeta);
    const originalImage = readFileSync(f.localPath);
    const originalMeta = readFileSync(`${f.localPath}.meta`);
    t.mock.method(AssetWriter.prototype, 'existing', realAssetExisting);
    global.Editor.Message.request = async (channel, method, ...args) => {
        assert.equal(channel, 'asset-db');
        if (method === 'query-asset-info') return args[0] === url || args[0] === imageUuid ? info : null;
        if (method === 'query-asset-meta') {
            assert.equal(args[0], imageUuid); return JSON.parse(JSON.stringify(meta));
        }
        assert.fail(`a designated local SpriteFrame must remain read-only: ${method}`);
    };
    const result = await f.run({ assetFolder: 'shared', localResourceFolders: [f.folder] });
    assert.equal(result.assets.get('panel').url, url);
    assert.equal(result.assets.get('panel').uuid, f.asset.uuid);
    assert.equal(result.assets.get('panel').sliced, true);
    assert.deepEqual(readFileSync(f.localPath), originalImage);
    assert.deepEqual(readFileSync(`${f.localPath}.meta`), originalMeta);
    assert.deepEqual(meta.subMetas.frame.userData, { trimType: 'auto', borderLeft: 1,
        borderRight: 1, borderTop: 1, borderBottom: 1 });
    assert.equal(meta.userData.custom, 'keep-me');
    assert.equal(meta.uuid, imageUuid);
    assert.equal(meta.subMetas.frame.uuid, f.asset.uuid);
    assert.equal(f.writes.length, 0);
    assert.deepEqual(readFileSync(sibling), siblingBytes);
    assert.deepEqual(readFileSync(`${sibling}.meta`), siblingMeta);
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

test('a valid Figma slice with an unregistered designated local SpriteFrame does not silently create a replacement', async (t) => {
    const f = setup(t, { unready: true });
    await assert.rejects(f.run(), /尚无可用 SpriteFrame.*不会另建副本/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.exports.length, 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.cacheReads.length, 0);
});

const tiledNode = (id, scale = 0.5, kind = 'IMAGE') => parseNode({ id, name: 'Panel', type: 'RECTANGLE',
    absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 30 },
    fills: [kind === 'PATTERN' ? { type: 'PATTERN', sourceNodeId: `source-${id}`, scalingFactor: scale }
        : { type: 'IMAGE', imageRef: `ref-${id}`, scaleMode: 'TILE', scalingFactor: scale }] });

for (const refresh of [false, true]) test(`Tiled nodes share the designated local UUID with per-instance periods and unchanged PNG/Meta (refresh=${refresh})`, async (t) => {
    const f = setup(t, { refresh });
    const first = tiledNode('tile-a', 0.5), second = tiledNode('tile-b', 1.25, 'PATTERN');
    const result = await f.run({}, [first, second]);
    const a = result.assets.get(first.id), b = result.assets.get(second.id);
    assert.equal(a.uuid, f.asset.uuid);
    assert.equal(b.uuid, f.asset.uuid);
    assert.equal(a.tiled, true); assert.equal(b.tiled, true);
    assert.equal(a.sliced, false); assert.equal(b.sliced, false);
    assert.equal(a.tileScale, 1, 'global 2x multiplied by the first 0.5x paint period');
    assert.equal(b.tileScale, 2.5, 'the second node retains its own global 2x * 1.25x paint period');
    assert.equal(f.asset.sliced, true, 'per-instance Tiled flags never alter the shared base descriptor');
    assert.equal(f.asset.tileScale, undefined);
    assert.deepEqual(f.lookups, [f.asset.url], 'same-name Tiled sources query the existing frame once');
    assert.equal(f.writes.length, 0); assert.equal(f.exports.length, 0);
    assert.equal(f.downloads.length, 0); assert.equal(f.cacheReads.length, 0);
    assert.ok(f.bindings.every((binding) => binding[2] === 'local'));
    assert.deepEqual(readFileSync(f.localPath), f.localBytes);
    assert.deepEqual(readFileSync(`${f.localPath}.meta`), f.localMeta);
});

test('an unready designated local Tiled SpriteFrame fails without downloads or generated variants', async (t) => {
    const f = setup(t, { unready: true });
    await assert.rejects(f.run({}, [tiledNode('unready-tile')]), /尚无可用 SpriteFrame.*不会另建副本/);
    assert.equal(f.writes.length, 0); assert.equal(f.exports.length, 0); assert.equal(f.downloads.length, 0);
});

test('an external Tiled bitmap is imported rather than pretending to have a reusable project UUID', async (t) => {
    const f = setup(t);
    const externalFolder = join(f.project, 'external-library');
    mkdirSync(externalFolder);
    writeFileSync(join(externalFolder, 'Panel.png'), bitmap(8, 6));
    const generated = [];
    t.mock.method(AssetWriter.prototype, 'resolve', async (url, bytes, options) => {
        generated.push({ url, bytes, options });
        return { uuid: 'external-imported-frame', url, sliced: false, tiled: true };
    });
    const tile = tiledNode('external-pattern', 1.25, 'PATTERN');
    const result = await f.run({ localResourceFolders: [externalFolder] }, [tile]);
    assert.equal(generated.length, 1);
    assert.match(generated[0].url, /^db:\/\/assets\/figma-importer\/Panel__tile_/);
    const png = PNG.sync.read(generated[0].bytes);
    assert.deepEqual([png.width, png.height], [20, 15], 'unscaled external pixels are multiplied by global 2x * paint 1.25x once');
    assert.equal(generated[0].options.tiled, true);
    assert.equal(result.assets.get(tile.id).uuid, 'external-imported-frame');
    assert.equal(result.assets.get(tile.id).tileScale, 1, 'the imported texture already contains the requested tile period');
    assert.equal(f.exports.length, 0); assert.equal(f.downloads.length, 0);
    assert.equal(f.lookups.length, 0, 'an external file cannot claim a project SpriteFrame UUID');
});

test('Tiled sources without a designated local match keep the generated raster path and unit node period', async (t) => {
    const f = setup(t);
    const generated = [];
    t.mock.method(AssetWriter.prototype, 'existingForSource', async () => null);
    t.mock.method(FigmaClient.prototype, 'getImageFillUrls', async () => ({ 'ref-generated-tile': 'fixture-tiled-original' }));
    t.mock.method(AssetWriter.prototype, 'resolve', async (url, bytes, options) => {
        generated.push({ url, bytes, options });
        return { uuid: 'figma-generated-tile', url, sliced: false, tiled: true };
    });
    const tile = tiledNode('generated-tile', 0.5);
    const result = await f.run({ localResourceFolders: [] }, [tile]);
    assert.equal(generated.length, 1);
    assert.deepEqual(f.downloads, ['fixture-tiled-original']);
    assert.match(generated[0].url, /Panel__tile_/);
    assert.equal(generated[0].options.tiled, true);
    assert.equal(result.assets.get(tile.id).tileScale, 1);
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
