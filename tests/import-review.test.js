'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { compareSavedReviewScene, diffReviewNodes, validateRemovalSelection } = require('../dist/import-review-model');
const { ImportReviewRecorder, ImportReviewService, buildReviewSourceTree } = require('../dist/importer/import-review');
const { finalizeImportReview } = require('../dist/importer/import-review-finalize');
const { captureReviewScene, registerSceneReview, prepareReviewRemoval, finishReviewRemoval, refreshReviewAfter } = require('../dist/import-review-scene');

function node(id, overrides = {}) {
    return { id, uuid: id, name: id, parentId: null, order: 0, depth: 0, active: true, geometry: [0, 0, 0, 24, 16],
        figmaIds: [id], components: [], ...overrides };
}

function sliceSourceFixture(mode = 'nine') {
    const rows = mode === 'horizontal' ? 1 : 3;
    const cols = mode === 'vertical' ? 1 : 3;
    const parent = { id: 'panel', name: 'FigmaPanel', type: 'INSTANCE', visible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: cols * 10, height: rows * 10 }, children: [] };
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) parent.children.push({
        id: `piece-${y}-${x}`, name: `node_bg_${y}_${x}`, type: 'RECTANGLE', visible: true,
        absoluteBoundingBox: { x: x * 10, y: y * 10, width: 10, height: 10 }, children: [],
    });
    const asset = { uuid: 'panel-frame', url: 'db://assets/panel.png', sliced: true };
    const bindings = new Map([['panel', { node: parent, asset, source: 'figma' }]]);
    const target = node('cocos-panel', { name: 'CocosPanel', figmaIds: ['panel'], components: [
        { id: 'sprite', type: 'cc.Sprite', managed: true, properties: { type: 1, spriteFrame: asset.uuid } },
    ] });
    const after = { nodes: [target], rootUuid: target.uuid, targetUuid: 'prefab', mode: 'prefab' };
    return { parent, asset, bindings, target, after };
}

for (const mode of ['nine', 'horizontal', 'vertical']) {
    test(`source tree labels actual ${mode} slice pieces with their merged parent`, () => {
        const f = sliceSourceFixture(mode);
        const tree = buildReviewSourceTree([f.parent], f, f.after);
        assert.equal(tree[0].sliceMerge, undefined);
        assert.equal(tree.length, mode === 'nine' ? 10 : 4);
        for (const piece of tree.slice(1)) assert.deepEqual(piece.sliceMerge,
            { mode, sourceId: 'panel', targetName: 'CocosPanel' });
    });
}

test('ignored/plain PNG/tiled/failed slice imports are not mislabeled as nine-slice merges', () => {
    for (const reason of ['ignored', 'plain', 'tiled', 'fallback', 'simple', 'different-frame', 'invalid-grid']) {
        const f = sliceSourceFixture();
        if (reason === 'ignored') f.after.nodes = [];
        if (reason === 'plain') f.asset.sliced = false;
        if (reason === 'tiled') f.asset.tiled = true;
        if (reason === 'fallback') f.asset.sliceFallback = 'meta failure';
        if (reason === 'simple') f.target.components[0].properties.type = 0;
        if (reason === 'different-frame') f.target.components[0].properties.spriteFrame = 'other';
        if (reason === 'invalid-grid') f.parent.children[0].absoluteBoundingBox.width = 5;
        assert.ok(buildReviewSourceTree([f.parent], f, f.after).every((row) => !row.sliceMerge), reason);
    }
});

test('independently imported and invisible descendants do not inherit a false slice explanation', () => {
    const f = sliceSourceFixture();
    const independent = f.parent.children[0];
    independent.children.push({ id: 'unmapped-child', name: 'UnmappedChild', type: 'RECTANGLE', visible: true, children: [] });
    f.after.nodes.push(node('independent', { figmaIds: [independent.id] }));
    f.parent.children.push({ id: 'hidden', name: 'HiddenNoise', type: 'RECTANGLE', visible: false, children: [] });
    const tree = buildReviewSourceTree([f.parent], f, f.after);
    for (const id of [independent.id, 'unmapped-child', 'hidden']) assert.equal(tree.find((row) => row.id === id).sliceMerge, undefined);
    assert.equal(tree.find((row) => row.id === f.parent.children[1].id).sliceMerge.mode, 'nine');
});
test('review compares stable identities, rename, reparent, geometry and component references', () => {
    const before = [node('keep'), node('change'), node('remove')];
    const after = [node('keep'), node('change', { name: '<new>', parentId: 'keep', geometry: [1, 2],
        components: [{ id: 'sprite', type: 'Sprite', managed: true, properties: { spriteFrame: 'new-uuid' } }] }), node('add')];
    const changes = diffReviewNodes(before, after);
    assert.deepEqual(changes.map((row) => row.status), ['unchanged', 'changed', 'added', 'removed']);
    assert.deepEqual(changes[1].fields, ['名称', '父节点', '位置/尺寸/旋转', '组件/属性/资源引用']);
});
test('removal selection rejects existing assets, forged URLs and consumed reports', () => {
    const review = { confirmed: false, assets: [{ id: 'new', state: 'new', canRemove: true },
        { id: 'old', state: 'reused', canRemove: false }] };
    assert.equal(validateRemovalSelection(review, ['new', 'new']).length, 1);
    assert.throws(() => validateRemovalSelection(review, ['old']), /只能删除/);
    assert.throws(() => validateRemovalSelection(review, ['db:\/\/assets\/elsewhere.png']), /只能删除/);
    assert.throws(() => validateRemovalSelection({ ...review, confirmed: true }, ['new']), /已确认/);
});

async function fixture(t, options = {}) {
    const project = await fs.mkdtemp(join(tmpdir(), 'cocos-import-review-test-'));
    await fs.mkdir(join(project, 'assets', 'images'), { recursive: true });
    const previous = global.Editor;
    global.Editor = { Project: { path: project } };
    t.after(async () => { global.Editor = previous; await fs.rm(project, { recursive: true, force: true }); });
    const url = 'db://assets/images/new.png';
    const path = join(project, 'assets', 'images', 'new.png');
    const recorder = new ImportReviewRecorder();
    if (options.existed) await fs.writeFile(path, 'previous-image');
    await recorder.beforeWrite(url, Boolean(options.existed));
    await fs.writeFile(path, 'new-image');
    await fs.writeFile(`${path}.meta`, JSON.stringify({ uuid: 'image', subMetas: { sprite: { uuid: 'sprite' }, texture: { uuid: 'texture' } } }));
    await fs.writeFile(join(project, 'assets', 'target.prefab'), JSON.stringify([{ __uuid__: 'sprite' }]));
    const source = { id: 'figma', name: 'original', type: 'RECTANGLE', visible: true, children: [] };
    recorder.bind(source, { uuid: 'sprite', url }, options.existed ? 'cache' : 'figma');
    recorder.bind({ ...source, id: 'figma2' }, { uuid: 'sprite', url }, 'cache');
    const snapshot = { rootUuid: 'root', targetUuid: 'target', mode: 'prefab', nodes: [node('root', {
        components: [{ id: 'comp', type: 'Sprite', managed: true, properties: { spriteFrame: 'sprite' } }],
    })] };
    const calls = [];
    let deleted = false;
    let detached = false;
    let failSave = Boolean(options.failSave);
    let saves = 0;
    const service = new ImportReviewService(async (method, value) => {
        calls.push(['asset', method, value]);
        if (method === 'query-asset-info') {
            if (value === 'target') return { uuid: 'target', url: 'db://assets/target.prefab' };
            if (value === 'foreign') return { uuid: 'foreign', url: 'db://assets/other.prefab' };
            return deleted ? null : { uuid: 'image', url };
        }
        if (method === 'query-asset-users') return options.foreign ? ['foreign'] : ['target'];
        if (method === 'delete-asset') {
            if (options.failDelete) throw new Error('disk locked');
            deleted = true; await fs.unlink(path); await fs.unlink(`${path}.meta`); return {};
        }
    }, async (method, payload) => {
        calls.push(['scene', method, payload]);
        if (method === 'execute-scene-script') {
            if (payload.method === 'prepareReviewRemoval' && payload.args[0].detach) detached = true;
            if (payload.method === 'finishReviewRemoval' && payload.args[0].restore) detached = false;
            return { ...snapshot, nodes: [node('root', { components: [{ id: 'comp', type: 'Sprite', managed: true,
                properties: { spriteFrame: detached ? null : 'sprite' } }] })] };
        }
        if (method === 'save-scene') {
            saves++;
            if (options.failSaveSecond && saves === 2) throw new Error('detach save failed');
            if (failSave) { failSave = false; throw new Error('save failed'); }
            await fs.writeFile(join(project, 'assets', 'target.prefab'), JSON.stringify([{ __uuid__: detached ? null : 'sprite' }]));
        }
        if (method === 'query-dirty') return false;
    });
    const report = await service.complete(recorder, { fileName: 'Test', fileKey: 'file', roots: [source],
        nodeById: new Map([['figma', source]]) }, { ...snapshot, nodes: [] }, snapshot, 'db://assets/target.prefab');
    return { project, recorder, service, report, path, url, calls, isDetached: () => detached };
}
test('journal groups actual shared consumers and distinguishes overwrite from new files', async (t) => {
    const f = await fixture(t, { existed: true });
    assert.equal(f.report.assets.length, 1);
    assert.equal(f.report.assets[0].state, 'updated');
    assert.equal(f.report.assets[0].canRemove, false);
    assert.deepEqual(f.report.assets[0].figmaIds, ['figma', 'figma2']);
    assert.deepEqual(f.report.assets[0].nodeNames, ['root']);
    assert.equal(f.calls.some((call) => ['delete-asset', 'save-scene'].includes(call[1])), false);
});
test('confirm without deselection performs no scene or asset mutation', async (t) => {
    const f = await fixture(t); f.calls.length = 0;
    await f.service.apply(f.report.id, []);
    assert.equal(f.calls.length, 0);
    assert.equal((await fs.readFile(f.path)).toString(), 'new-image');
});
test('confirmed deletion backs up exact bytes then detaches and saves before deleting only the new asset', async (t) => {
    const f = await fixture(t); f.calls.length = 0;
    const result = await f.service.apply(f.report.id, [f.url]);
    assert.equal(result.assets[0].state, 'deleted');
    assert.equal(result.after.nodes[0].components[0].properties.spriteFrame, null);
    assert.equal(result.after.nodes.length, 1);
    assert.equal((await fs.readFile(join(result.backupFolder, '0.image'))).toString(), 'new-image');
    assert.match((await fs.readFile(join(result.backupFolder, 'target-before.json'))).toString(), /sprite/);
    assert.ok(f.calls.findIndex((call) => call[1] === 'save-scene') < f.calls.findIndex((call) => call[1] === 'delete-asset'));
    await assert.rejects(fs.stat(f.path), { code: 'ENOENT' });
});
test('external project references block cleanup before detaching anything', async (t) => {
    const f = await fixture(t, { foreign: true });
    await assert.rejects(f.service.apply(f.report.id, [f.url]), /其他资源引用/);
    assert.equal(f.isDetached(), false);
    assert.equal(f.calls.some((call) => call[1] === 'delete-asset'), false);
});
test('changed bytes and stale review ids cannot authorize deletion', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.service.apply('stale-id', [f.url]), /已过期/);
    await fs.writeFile(f.path, 'user-change');
    await assert.rejects(f.service.apply(f.report.id, [f.url]), /已被修改/);
    assert.equal(f.isDetached(), false);
});
test('failed target save restores references and keeps files', async (t) => {
    const f = await fixture(t, { failSave: true });
    await assert.rejects(f.service.apply(f.report.id, [f.url]), /save failed/);
    assert.equal(f.isDetached(), false);
    assert.equal(f.calls.some((call) => call[1] === 'delete-asset'), false);
    assert.match((await fs.readFile(join(f.project, 'assets', 'target.prefab'))).toString(), /sprite/);
});
test('failure while saving detached references restores the imported target from live slots', async (t) => {
    const f = await fixture(t, { failSaveSecond: true });
    await assert.rejects(f.service.apply(f.report.id, [f.url]), /detach save failed/);
    assert.equal(f.isDetached(), false);
    assert.equal(f.calls.some((call) => call[1] === 'delete-asset'), false);
    assert.match((await fs.readFile(join(f.project, 'assets', 'target.prefab'))).toString(), /sprite/);
});
test('a deletion failure leaves the file and reports that its node reference was removed', async (t) => {
    const f = await fixture(t, { failDelete: true });
    const result = await f.service.apply(f.report.id, [f.url]);
    assert.equal(result.assets[0].state, 'new');
    assert.deepEqual(result.assets[0].nodeNames, []);
    assert.equal(f.isDetached(), true);
    assert.match(result.warnings[0], /删除失败并保留/);
    assert.equal((await fs.stat(f.path)).isFile(), true);
});

class Node {
    constructor(name) { this.name = name; this.uuid = name; this.children = []; this.components = []; this.active = true;
        this.position = { x: 1, y: 2, z: 0 }; this.ui = { width: 24, height: 16, setContentSize(w, h) { this.width = w; this.height = h; } }; }
    getComponent() { return this.ui; }
    add(child) { child.parent = this; this.children.push(child); return child; }
}
class Sprite {
    constructor(node) { this.node = node; this.uuid = `${node.name}-sprite`; this._spriteFrame = { _uuid: 'sprite' }; }
    get spriteFrame() { return this._spriteFrame; }
    set spriteFrame(value) { this._spriteFrame = value; this.node.ui.setContentSize(0, 0); }
}
function sceneFixture(t) {
    const scene = new Node('scene'); const root = scene.add(new Node('root')); const child = root.add(new Node('child'));
    const sprite = new Sprite(child); child.components.push(sprite);
    const cc = { Node, Sprite, UITransform: class {}, director: { getScene: () => scene } };
    const previous = global.cce;
    global.cce = { SceneFacadeManager: { queryCurrentSceneUuid: () => 'target', queryMode: () => 'prefab' } };
    t.after(() => { global.cce = previous; });
    const snapshot = registerSceneReview('review', root, cc, { figma: child.uuid }, [sprite.uuid]);
    return { scene, root, child, sprite, cc, snapshot };
}

test('review refresh uses verified Prefab identity instead of transient facade identity', (t) => {
    const f = sceneFixture(t);
    global.cce.SceneFacadeManager.queryCurrentSceneUuid = () => 'previous-target';
    registerSceneReview('review', f.root, f.cc, { figma: f.child.uuid }, [f.sprite.uuid],
        { targetUuid: 'target', mode: 'prefab' });
    global.cce.SceneFacadeManager.queryCurrentSceneUuid = () => 'target';
    assert.equal(refreshReviewAfter({ id: 'review' }).targetUuid, 'target');
    prepareReviewRemoval({ id: 'review', uuids: ['sprite'] });
});

test('review refresh accepts equivalent UUID forms but rejects actual target and content changes', (t) => {
    const f = sceneFixture(t);
    global.cce.SceneFacadeManager.queryCurrentSceneUuid = () => 'AA000000-0000-0000-0000-000000000000';
    registerSceneReview('review', f.root, f.cc, {}, [],
        { targetUuid: 'aaAAAAAAAAAAAAAAAAAAAA', mode: 'prefab' });
    refreshReviewAfter({ id: 'review' });
    f.child.name = 'user changed';
    assert.throws(() => refreshReviewAfter({ id: 'review' }), /内容已变化/);
    global.cce.SceneFacadeManager.queryCurrentSceneUuid = () => 'other';
    assert.throws(() => refreshReviewAfter({ id: 'review' }), /已切换/);
});

test('review can rebind a saved/reloaded Prefab only with matching stable structure and components', (t) => {
    const f = sceneFixture(t);
    f.root._prefab = { fileId: 'root-file' }; f.child._prefab = { fileId: 'child-file' };
    f.sprite.__prefab = { fileId: 'sprite-file' };
    registerSceneReview('review', f.root, f.cc, { figma: f.child.uuid }, ['sprite-file']);
    const scene = new Node('reloaded-scene'); const root = scene.add(new Node('root'));
    const child = root.add(new Node('child')); const sprite = new Sprite(child); child.components.push(sprite);
    root.uuid = 'new-root'; child.uuid = 'new-child'; sprite.uuid = 'new-sprite';
    root._prefab = { fileId: 'root-file' }; child._prefab = { fileId: 'child-file' };
    sprite.__prefab = { fileId: 'sprite-file' };
    f.cc.director.getScene = () => scene; global.cce.Scene = { rootNode: root };
    root._prefab.fileId = 'foreign-root';
    assert.throws(() => refreshReviewAfter({ id: 'review' }), /根节点/);
    root._prefab.fileId = 'root-file'; child.name = 'edited';
    assert.throws(() => refreshReviewAfter({ id: 'review' }), /内容已变化/);
    child.name = 'child'; child.ui.height = 25.75;
    const after = refreshReviewAfter({ id: 'review' });
    assert.equal(after.rootUuid, 'new-root');
    assert.deepEqual(after.nodes[1].figmaIds, ['figma']);
    assert.equal(after.saveAdjustments.count, 1);
    assert.equal(after.nodes[1].geometry[4], 25.75);
    prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true });
    assert.equal(sprite.spriteFrame, null);
    assert.equal(child.ui.height, 25.75);
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
});

test('review finalization retries transient validation and keeps cleanup enabled on recovery', async (t) => {
    const f = await fixture(t);
    let attempts = 0; let waits = 0;
    const report = await finalizeImportReview(f.service, f.recorder, { fileName: 'Test', roots: [] },
        f.report.before, f.report.after, f.report.targetUrl, [], async () => {
            if (++attempts < 3) throw new Error('target loading');
            return f.report.after;
        }, async () => { waits++; });
    assert.equal(attempts, 3); assert.equal(waits, 2);
    assert.equal(report.readOnlyReason, undefined); assert.equal(report.assets[0].canRemove, true);
});

test('save finalization adopts deferred geometry without writing to nodes; cleanup retains saved size', (t) => {
    const f = sceneFixture(t);
    f.child.ui.width = 36.125; f.child.ui.height = 18.5;
    f.child.position.y = 3;
    const after = refreshReviewAfter({ id: 'review' });
    assert.equal(after.saveAdjustments.count, 3);
    assert.match(after.saveAdjustments.details.join(';'), /child.*宽度.*24 → 36.125/);
    assert.equal(after.nodes[1].geometry[3], 36.125);
    assert.equal(f.child.position.y, 3);
    prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true });
    assert.equal(f.sprite.spriteFrame, null);
    assert.equal(f.child.ui.width, 36.125); assert.equal(f.child.ui.height, 18.5);
    finishReviewRemoval({ id: 'review', restore: true });
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
    assert.equal(f.child.ui.width, 36.125);
});

test('accepting save-time geometry never relaxes edits after report creation', (t) => {
    const f = sceneFixture(t);
    f.child.ui.width = 30;
    refreshReviewAfter({ id: 'review' });
    f.child.ui.width = 31;
    assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true }), /发生变化/);
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
});

test('accepted save adjustments do not bypass live custom or outside-root resource references', (t) => {
    const f = sceneFixture(t);
    f.child.ui.height = 20;
    refreshReviewAfter({ id: 'review' });
    const other = f.scene.add(new Node('outside-root'));
    other.components.push({ node: other, nested: [{ image: { _uuid: 'sprite' } }] });
    assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true }), /其他组件或属性引用/);
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
});

test('save boundary compares stable component identity, not component/property enumeration order', (t) => {
    const f = sceneFixture(t);
    f.child.components.push({ uuid: 'layout', enabled: true, spacingX: 0 });
    const before = captureReviewScene(f.root, f.cc);
    const after = JSON.parse(JSON.stringify(before));
    after.nodes.reverse();
    for (const n of after.nodes) {
        n.uuid += '-reloaded';
        n.components.reverse();
        for (const c of n.components) c.properties = Object.fromEntries(Object.entries(c.properties).reverse());
    }
    assert.deepEqual(compareSavedReviewScene(before, after), { issues: [], adjustments: { count: 0, details: [] } });
});

test('equivalent asset UUIDs are accepted but different SpriteFrame subassets are rejected', (t) => {
    const f = sceneFixture(t);
    f.sprite._spriteFrame._uuid = 'aaAAAAAAAAAAAAAAAAAAAA@f9941';
    registerSceneReview('review', f.root, f.cc, { figma: f.child.uuid }, [f.sprite.uuid]);
    f.sprite._spriteFrame._uuid = 'AA000000-0000-0000-0000-000000000000@f9941';
    refreshReviewAfter({ id: 'review' });
    prepareReviewRemoval({ id: 'review', uuids: ['aaAAAAAAAAAAAAAAAAAAAA@f9941'], detach: true });
    assert.equal(f.sprite.spriteFrame, null);
    finishReviewRemoval({ id: 'review', restore: true });
    f.sprite._spriteFrame._uuid = 'aa000000-0000-0000-0000-000000000000@another';
    assert.throws(() => refreshReviewAfter({ id: 'review' }), /child.*spriteFrame（资源引用）.*another/);
});

test('equivalent UUID encoding in an outside-root reference still blocks deletion', (t) => {
    const f = sceneFixture(t);
    f.sprite._spriteFrame._uuid = 'aaAAAAAAAAAAAAAAAAAAAA@f9941';
    registerSceneReview('review', f.root, f.cc, { figma: f.child.uuid }, [f.sprite.uuid]);
    const other = f.scene.add(new Node('outside'));
    other.components.push({ node: other, reference: { _uuid: 'AA000000-0000-0000-0000-000000000000@f9941' } });
    refreshReviewAfter({ id: 'review' });
    assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['aaAAAAAAAAAAAAAAAAAAAA@f9941'], detach: true }), /其他组件或属性引用/);
    assert.equal(f.sprite.spriteFrame._uuid, 'aaAAAAAAAAAAAAAAAAAAAA@f9941');
});

test('resource reassignment or loss is never adopted as normal save-time changes', (t) => {
    const f = sceneFixture(t);
    f.child.ui.width = 30;
    for (const value of [{ _uuid: 'other-image' }, null]) {
        f.sprite._spriteFrame = value;
        assert.throws(() => refreshReviewAfter({ id: 'review' }), /child.*Sprite.*spriteFrame（资源引用）/);
        assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true }), /发生变化/);
        assert.equal(f.sprite.spriteFrame, value);
    }
});

test('save validation blocks structural, ownership and non-geometric component changes with specifics', (t) => {
    const f = sceneFixture(t);
    const before = captureReviewScene(f.root, f.cc, { figma: f.child.uuid }, [f.sprite.uuid]);
    const cases = [
        [a => { a.nodes.pop(); }, /child.*删除/],
        [a => { a.nodes.push(node('added')); }, /新增节点.*added/],
        [a => { a.nodes[1].parentId = 'elsewhere'; }, /parentId/],
        [a => { a.nodes[1].order++; }, /order/],
        [a => { a.nodes[1].active = false; }, /active/],
        [a => { a.nodes[1].figmaIds = ['foreign']; }, /Figma 映射/],
        [a => { a.nodes[1].components = []; }, /Sprite.*移除/],
        [a => { a.nodes[1].components[0].id = 'replacement'; }, /标识改变/],
        [a => { a.nodes[1].components[0].managed = false; }, /管理归属/],
        [a => { a.nodes[1].components[0].type = 'Custom'; }, /类型/],
        [a => { a.nodes[1].components[0].properties.type = 2; }, /\.type/],
        [a => { a.nodes[1].components[0].properties.string = 'changed'; }, /\.string/],
        [a => { a.nodes[1].components[0].properties.enabled = false; }, /\.enabled/],
        [a => { a.nodes.push(a.nodes[1]); }, /重复/],
        [a => { a.nodes[1].components.push(a.nodes[1].components[0]); }, /重复/],
    ];
    for (const [mutate, expected] of cases) {
        const after = JSON.parse(JSON.stringify(before));
        after.nodes[1].geometry[3]++;
        mutate(after);
        assert.match(compareSavedReviewScene(before, after).issues.join(';'), expected);
    }
});

test('save geometry notices are bounded and invalid geometry is not silently adopted', (t) => {
    const f = sceneFixture(t);
    const before = captureReviewScene(f.root, f.cc);
    const after = JSON.parse(JSON.stringify(before));
    after.nodes.forEach(n => { n.geometry = n.geometry.map(v => v + 1); });
    const result = compareSavedReviewScene(before, after);
    assert.equal(result.issues.length, 0);
    assert.equal(result.adjustments.count, 24);
    assert.equal(result.adjustments.details.length, 5);
    after.nodes[1].geometry[3] = NaN;
    assert.match(compareSavedReviewScene(before, after).issues.join(';'), /几何数据无效/);
});

test('full report uses saved geometry and exposes save adjustments without disabling cleanup', async (t) => {
    const f = await fixture(t);
    const after = JSON.parse(JSON.stringify(f.report.after));
    after.nodes[0].geometry[3] = 30;
    after.saveAdjustments = { count: 1, details: ['节点 child 宽度：24 → 30'] };
    const report = await finalizeImportReview(f.service, f.recorder, { fileName: 'Test', roots: [] },
        f.report.before, f.report.after, f.report.targetUrl, [], async () => after, async () => {});
    assert.equal(report.readOnlyReason, undefined);
    assert.equal(report.assets[0].canRemove, true);
    assert.equal(report.after.nodes[0].geometry[3], 30);
    assert.match(report.warnings.join(';'), /保存收尾已同步 1 项.*24 → 30/);
});

test('failed review validation retains a viewable report and backend forbids all confirmation', async (t) => {
    const f = await fixture(t); f.calls.length = 0;
    const report = await finalizeImportReview(f.service, f.recorder, { fileName: 'Test', roots: [] },
        f.report.before, f.report.after, f.report.targetUrl, [], async () => { throw new Error('target switched'); }, async () => {});
    assert.match(report.readOnlyReason, /target switched/);
    assert.equal(f.service.get(), report); assert.equal(report.assets.length, 1);
    assert.equal(report.assets[0].canRemove, false);
    await assert.rejects(f.service.apply(report.id, []), /仅供查看/);
    await assert.rejects(f.service.apply(report.id, [report.assets[0].id]), /仅供查看/);
    assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(f.path, 'utf8'), 'new-image');
});

test('complete-report failure and missing snapshots both yield cached read-only reports', async (t) => {
    const f = await fixture(t); const complete = f.service.complete.bind(f.service);
    f.service.complete = (...args) => {
        if (!args[6]) throw new Error('analysis unavailable');
        return complete(...args);
    };
    const document = { fileName: 'Test', roots: [] };
    const report = await finalizeImportReview(f.service, f.recorder, document,
        f.report.before, f.report.after, undefined, [], async () => f.report.after);
    assert.match(report.readOnlyReason, /analysis unavailable/);
    const missing = await finalizeImportReview(f.service, f.recorder, document,
        undefined, undefined, undefined, [], async () => { throw new Error('must not refresh'); });
    assert.match(missing.readOnlyReason, /快照不完整/); assert.equal(missing.after.nodes.length, 0);
    assert.equal(f.service.get(), missing);
});
test('scene detach keeps nodes, transforms and components intact and can restore', (t) => {
    const f = sceneFixture(t);
    prepareReviewRemoval({ id: 'review', uuids: ['sprite'] });
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
    prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true });
    assert.equal(f.sprite.spriteFrame, null);
    assert.equal(f.child.ui.width, 24); assert.equal(f.child.ui.height, 16);
    assert.equal(f.child.components.length, 1); assert.equal(f.root.children.length, 1);
    finishReviewRemoval({ id: 'review', restore: true });
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
    assert.equal(f.child.ui.width, 24);
});
test('scene rejects a changed target tree and custom references outside the import root', (t) => {
    const f = sceneFixture(t);
    f.child.name = 'user rename';
    assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['sprite'] }), /发生变化/);
    f.child.name = 'child';
    const other = f.scene.add(new Node('other'));
    other.components.push({ node: other, nested: [{ asset: { _uuid: 'sprite' } }] });
    assert.throws(() => prepareReviewRemoval({ id: 'review', uuids: ['sprite'], detach: true }), /其他组件或属性引用/);
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
});
test('scene capture includes inactive children, component properties and Figma aliases', (t) => {
    const f = sceneFixture(t); f.child.active = false;
    const result = captureReviewScene(f.root, f.cc, { a: 'child', b: 'child' }, [f.sprite.uuid]);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.nodes[1].active, false);
    assert.deepEqual(result.nodes[1].figmaIds, ['a', 'b']);
    assert.equal(result.nodes[1].components[0].managed, true);
    assert.equal(result.nodes[1].components[0].properties.spriteFrame, 'sprite');
});

test('Mask snapshots never touch deprecated getters during capture, registration or refresh', (t) => {
    const f = sceneFixture(t);
    let legacyReads = 0;
    class Mask {
        constructor(renderer) {
            this.type = 2; this.inverted = true; this.alphaThreshold = 0.35; this.segments = 64;
            this.uuid = 'mask'; this.enabled = true; this.subComp = renderer;
        }
    }
    for (const key of ['color', 'spriteFrame', 'sizeMode', 'opacity']) {
        Object.defineProperty(Mask.prototype, key, { get() {
            legacyReads++; throw new Error(`deprecated Mask.${key}`);
        } });
    }
    f.cc.Mask = Mask;
    const mask = Object.freeze(new Mask(f.sprite));
    f.child.components.push(mask);
    const before = captureReviewScene(f.root, f.cc);
    registerSceneReview('mask-review', f.root, f.cc, {}, []);
    const after = refreshReviewAfter({ id: 'mask-review' });
    assert.equal(legacyReads, 0);
    assert.deepEqual(after, before);
    const recorded = after.nodes[1].components.find((component) => component.id === 'mask');
    assert.deepEqual(recorded.properties, { enabled: true, type: 2, inverted: true,
        alphaThreshold: 0.35, segments: 64, spriteFrame: 'sprite' });
    assert.equal(Object.hasOwn(recorded.properties, 'color'), false);
    assert.equal(mask.subComp, f.sprite);
    assert.equal(f.sprite.spriteFrame._uuid, 'sprite');
    assert.equal(f.child.ui.width, 24);
});

test('rectangular/graphics masks are recorded without requiring a Sprite or legacy frame getter', (t) => {
    const f = sceneFixture(t);
    class Mask {
        constructor() { this.type = 0; this.inverted = false; this.alphaThreshold = 0.1; this.segments = 64; }
        get color() { throw new Error('Mask color read'); }
        get spriteFrame() { throw new Error('Mask spriteFrame read'); }
    }
    f.cc.Mask = Mask;
    f.child.components.push(new Mask());
    const result = captureReviewScene(f.root, f.cc);
    const properties = result.nodes[1].components[1].properties;
    assert.equal(properties.type, 0);
    assert.equal(properties.inverted, false);
    assert.equal(Object.hasOwn(properties, 'spriteFrame'), false);
});

test('supported rendering colors are read once and color changes still appear in the diff', (t) => {
    const f = sceneFixture(t);
    let reads = 0;
    let color = { r: 10, g: 20, b: 30, a: 128 };
    const instances = [];
    for (const name of ['Sprite', 'Label', 'RichText', 'Graphics']) {
        const Base = name === 'Sprite' ? Sprite : class {};
        const Class = class extends Base { get color() { reads++; return color; } };
        f.cc[name] = Class;
        const component = new Class(f.child);
        component.uuid = name;
        if (name === 'Graphics') {
            component.fillColor = { r: 40, g: 50, b: 60, a: 255 };
            component.strokeColor = { r: 70, g: 80, b: 90, a: 255 };
        }
        instances.push(component);
    }
    f.child.components = instances;
    const before = captureReviewScene(f.root, f.cc);
    assert.equal(reads, 4);
    for (const component of before.nodes[1].components) assert.equal(component.properties.color, '10,20,30,128');
    assert.equal(before.nodes[1].components[3].properties.fillColor, '40,50,60,255');
    assert.equal(before.nodes[1].components[3].properties.strokeColor, '70,80,90,255');
    color = { r: 255, g: 0, b: 0, a: 255 };
    const after = captureReviewScene(f.root, f.cc);
    assert.equal(reads, 8);
    const diff = diffReviewNodes(before.nodes, after.nodes);
    assert.equal(diff[1].status, 'changed');
    assert.ok(diff[1].fields.includes('组件/属性/资源引用'));
});

test('custom components with a color getter are not probed as renderers', (t) => {
    const f = sceneFixture(t);
    class CustomComponent { get color() { throw new Error('custom getter must not be called'); } }
    f.child.components.push(new CustomComponent());
    const result = captureReviewScene(f.root, f.cc);
    assert.equal(Object.hasOwn(result.nodes[1].components[1].properties, 'color'), false);
});

test('shared resource removal clears all managed sprites including inactive tiled helpers', (t) => {
    const f = sceneFixture(t);
    const helper = f.root.add(new Node('__FigmaTiledSprite'));
    helper.active = false;
    const tiled = new Sprite(helper); tiled.uuid = 'tiled-sprite'; tiled.type = 2; tiled.sizeMode = 0;
    helper.components.push(tiled);
    registerSceneReview('shared', f.root, f.cc, { first: f.child.uuid }, [f.sprite.uuid, tiled.uuid]);
    prepareReviewRemoval({ id: 'shared', uuids: ['sprite'], detach: true });
    const after = finishReviewRemoval({ id: 'shared' });
    assert.equal(f.sprite.spriteFrame, null); assert.equal(tiled.spriteFrame, null);
    assert.equal(after.nodes.length, 3);
    assert.equal(tiled.type, 2); assert.equal(tiled.sizeMode, 0);
    assert.equal(helper.active, false); assert.equal(helper.ui.width, 24);
});
