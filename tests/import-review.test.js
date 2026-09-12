'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { diffReviewNodes, validateRemovalSelection } = require('../dist/import-review-model');
const { ImportReviewRecorder, ImportReviewService } = require('../dist/importer/import-review');
const { captureReviewScene, registerSceneReview, prepareReviewRemoval, finishReviewRemoval } = require('../dist/import-review-scene');

function node(id, overrides = {}) {
    return { id, uuid: id, name: id, parentId: null, order: 0, depth: 0, active: true, geometry: [0, 0, 0, 24, 16],
        figmaIds: [id], components: [], ...overrides };
}
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
