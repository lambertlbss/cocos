'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { join, relative, resolve, isAbsolute } = require('node:path');
const { tmpdir } = require('node:os');
const { PNG } = require('pngjs');
const { buildAssets, makeSpec, decisionMap } = require('../dist/main');
const { parseNode } = require('../dist/figma/parser');
const { analyzeTree } = require('../dist/figma/analyzer');
const { compileImportPlan } = require('../dist/figma/import-planner');
const { AssetWriter } = require('../dist/importer/assets');
const { LocalAssetCache } = require('../dist/importer/cache');
const { FigmaClient } = require('../dist/figma/client');
const { TokenVault } = require('../dist/security/token-vault');
const { DEFAULT_SETTINGS } = require('../dist/types');

const box = { x: 0, y: 0, width: 20, height: 10 };
const solid = { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } };
const pngNode = (id, visible = true, opacity = 1) => ({ id, name: id, type: 'RECTANGLE', visible, opacity,
    absoluteBoundingBox: box, fills: [solid], effects: [{ type: 'DROP_SHADOW', visible: true }] });
const hiddenSources = () => [
    pngNode('hidden-png', false),
    { id: 'hidden-image', name: 'hidden-image', type: 'RECTANGLE', visible: false,
        absoluteBoundingBox: box, fills: [{ type: 'IMAGE', imageRef: 'hidden-image-ref', scaleMode: 'FILL' }] },
    { id: 'hidden-tiled', name: 'hidden-tiled', type: 'RECTANGLE', visible: false,
        absoluteBoundingBox: box, fills: [{ type: 'IMAGE', imageRef: 'hidden-tiled-ref', scaleMode: 'TILE', scalingFactor: 1 }] },
    { id: 'hidden-gradient', name: 'hidden-gradient', type: 'FRAME', visible: false,
        absoluteBoundingBox: box, fills: [{ type: 'GRADIENT_LINEAR',
            gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
            gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
                { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }],
        children: [{ id: 'hidden-gradient-text', name: 'Title', type: 'TEXT', visible: true,
            absoluteBoundingBox: box, characters: 'Still hidden by its parent' }] },
    { id: 'hidden-parent', name: 'panel_hidden', type: 'FRAME', visible: false,
        absoluteBoundingBox: box, children: [pngNode('visible-child-inside-hidden-parent')] },
];

function fixture(t, children, rootVisible = true) {
    const project = mkdtempSync(join(tmpdir(), 'figma-hidden-import-'));
    mkdirSync(join(project, 'assets'), { recursive: true });
    mkdirSync(join(project, 'temp'), { recursive: true });
    const previousEditor = global.Editor;
    global.Editor = { Project: { path: project, tmpDir: join(project, 'temp') }, Message: { send() {} } };
    t.after(() => {
        global.Editor = previousEditor;
        const suffix = relative(resolve(tmpdir()), resolve(project));
        assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix));
        rmSync(project, { recursive: true, force: true });
    });
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});
    const root = parseNode({ id: 'root', name: 'panel_root', type: 'FRAME', visible: rootVisible,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 80 }, children });
    const tree = analyzeTree([root]);
    const nodeById = new Map();
    const visit = (node) => { nodeById.set(node.id, node); node.children.forEach(visit); };
    visit(root);
    const document = { fileKey: 'hidden-layer-file', fileName: 'Hidden layers', roots: [root], tree, nodeById };
    const before = structuredClone(root);
    const image = new PNG({ width: 20, height: 10 });
    image.data.fill(255);
    const contents = PNG.sync.write(image);
    const exports = [], downloads = [], writes = [], tiles = [], bindings = [];
    let fillRequests = 0;
    t.mock.method(AssetWriter.prototype, 'initialize', async () => {});
    t.mock.method(AssetWriter.prototype, 'existingForSource', async () => null);
    t.mock.method(AssetWriter.prototype, 'existing', async () => null);
    t.mock.method(AssetWriter.prototype, 'write', async (url, bytes, borders) => {
        writes.push({ url, bytes, borders }); return { uuid: url, url, sliced: false };
    });
    t.mock.method(AssetWriter.prototype, 'resolve', async (url, bytes, options) => {
        tiles.push({ url, bytes, options }); return { uuid: url, url, sliced: false, tiled: true };
    });
    t.mock.method(LocalAssetCache.prototype, 'initialize', async () => {});
    t.mock.method(LocalAssetCache.prototype, 'read', async () => null);
    t.mock.method(LocalAssetCache.prototype, 'write', async () => {});
    t.mock.method(TokenVault.prototype, 'get', async () => 'fixture-token');
    t.mock.method(FigmaClient.prototype, 'getImageUrls', async (_fileKey, ids) => {
        exports.push(...ids); return Object.fromEntries(ids.map((id) => [id, `fixture-png:${id}`]));
    });
    t.mock.method(FigmaClient.prototype, 'getImageFillUrls', async () => {
        fillRequests++;
        return { 'hidden-image-ref': 'fixture-fill:hidden-image', 'hidden-tiled-ref': 'fixture-fill:hidden-tiled' };
    });
    t.mock.method(FigmaClient.prototype, 'download', async (url) => { downloads.push(url); return contents; });
    const run = async (importHiddenLayers) => {
        const settings = { ...DEFAULT_SETTINGS, scale: 1, localResourceFolders: [] };
        if (importHiddenLayers === undefined) delete settings.importHiddenLayers;
        else settings.importHiddenLayers = importHiddenLayers;
        const decisions = decisionMap([], tree);
        const result = await buildAssets(document, decisions, settings, {
            bind(node, asset) { bindings.push({ id: node.id, asset }); }, beforeWrite() {}, note() {},
        });
        const plans = compileImportPlan(document.roots, decisions);
        const spec = makeSpec(root, undefined, decisions, plans, nodeById, result.assets, new Map(), true);
        assert.deepEqual(root, before, 'the source Figma tree retains all visibility and node data');
        assert.deepEqual(tree, analyzeTree([root]), 'source tree DTOs are not pruned or rewritten');
        return { ...result, spec };
    };
    return { run, exports, downloads, writes, tiles, bindings, fillRequests: () => fillRequests };
}

function indexSpecs(root) {
    const result = new Map();
    const visit = (node) => { if (!node) return; result.set(node.figmaId, node); node.children.forEach(visit); };
    visit(root);
    return result;
}

test('disabling hidden layers excludes hidden PNG, IMAGE, Tiled, gradients and visible descendants from assets and SceneSpec', async (t) => {
    const f = fixture(t, hiddenSources());
    const result = await f.run(false);
    assert.equal(result.assets.size, 0);
    assert.deepEqual(f.exports, []);
    assert.deepEqual(f.downloads, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.tiles, []);
    assert.deepEqual(f.bindings, []);
    assert.equal(f.fillRequests(), 0);
    assert.deepEqual([...indexSpecs(result.spec).keys()], ['root']);
});

test('disabled hidden layers preserve visible siblings and their resource generation', async (t) => {
    const f = fixture(t, [...hiddenSources(), pngNode('visible-sibling')]);
    const result = await f.run(false);
    assert.deepEqual(f.exports, ['visible-sibling']);
    assert.deepEqual(f.downloads, ['fixture-png:visible-sibling']);
    assert.equal(f.writes.length, 1);
    assert.equal(f.tiles.length, 0);
    assert.equal(f.fillRequests(), 0);
    assert.deepEqual([...result.assets.keys()], ['visible-sibling']);
    assert.deepEqual([...indexSpecs(result.spec).keys()], ['root', 'visible-sibling']);
});

for (const enabled of [true, undefined]) {
    test(`hidden layers remain inactive imported nodes and prepare every resource path (setting=${enabled ?? 'missing'})`, async (t) => {
        const f = fixture(t, hiddenSources());
        const result = await f.run(enabled);
        assert.deepEqual(new Set(f.exports), new Set(['hidden-png', 'visible-child-inside-hidden-parent']));
        assert.equal(f.fillRequests(), 2, 'Tiled and ordinary IMAGE both prepare their source');
        assert.equal(f.downloads.length, 4);
        assert.equal(f.tiles.length, 1);
        assert.equal(f.writes.length, 4, 'PNG, ordinary IMAGE and gradient resources are retained');
        assert.equal(result.assets.size, 5);
        const specs = indexSpecs(result.spec);
        for (const id of ['hidden-png', 'hidden-image', 'hidden-tiled', 'hidden-gradient', 'hidden-parent']) {
            assert.equal(specs.get(id).visible, false, `${id} remains Inactive`);
        }
        assert.equal(specs.get('visible-child-inside-hidden-parent').visible, true,
            'a visible child stays structurally present beneath its inactive parent');
        assert.equal(specs.get('hidden-tiled').sprite.tiled, true);
    });
}

test('opacity zero is not treated as a hidden layer when hidden import is disabled', async (t) => {
    const f = fixture(t, [pngNode('transparent-but-visible', true, 0)]);
    const result = await f.run(false);
    assert.deepEqual(f.exports, ['transparent-but-visible']);
    assert.equal(f.writes.length, 1);
    const spec = indexSpecs(result.spec).get('transparent-but-visible');
    assert.equal(spec.visible, true);
    assert.equal(spec.opacity, 0);
});

test('a disabled hidden root yields no resources or SceneSpec even when its child is marked visible', async (t) => {
    const f = fixture(t, [pngNode('visible-child')], false);
    const result = await f.run(false);
    assert.equal(result.spec, null);
    assert.equal(result.assets.size, 0);
    assert.equal(f.exports.length, 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.writes.length, 0);
});
