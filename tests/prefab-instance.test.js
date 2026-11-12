'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configurePrefabAttachment, ownedPrefabAttachment, rememberPrefabAttachment,
    removeOwnedPrefabAttachment } = require('../dist/prefab-instance');

function carrierFixture(t) {
    const carrier = { name: 'Carrier', uuid: 'carrier', children: [] };
    let count = 0;
    const calls = [];
    const previous = global.cce;
    global.cce = { SceneFacadeManager: { async createNode(options) {
        calls.push(options);
        const node = { uuid: `native-${++count}`, parent: carrier, children: [], active: true,
            position: { x: 7, y: 9, z: 0 },
            setPosition(x, y, z) { this.position = { x, y, z }; },
            removeFromParent() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; },
            destroy() { this.destroyed = true; } };
        node._prefab = { root: node, asset: { uuid: options.assetUuid }, fileId: 'source-file',
            instance: { fileId: `native-instance-${count}` } };
        carrier.children.push(node);
        return node.uuid;
    } } };
    t.after(() => { global.cce = previous; });
    return { carrier, calls };
}

test('scene-only attachment ownership survives repeated imports and can be restored only from exact evidence', async (t) => {
    const f = carrierFixture(t);
    await configurePrefabAttachment(f.carrier, { uuid: 'native-asset' });
    assert.equal(f.calls[0].autoAdaptToCreate, false);
    const instance = f.carrier.children[0]; const attachment = ownedPrefabAttachment(f.carrier);
    await configurePrefabAttachment(f.carrier, { uuid: 'NATIVE-ASSET' });
    assert.equal(f.calls.length, 1); assert.equal(f.carrier.children[0], instance);
    const reopened = { ...f.carrier, uuid: 'reopened-carrier' };
    f.carrier.children = []; instance.parent = reopened;
    await assert.rejects(configurePrefabAttachment(reopened, { uuid: 'native-asset' }), /来源未知/);
    assert.throws(() => rememberPrefabAttachment(reopened, { ...attachment, instanceFileId: 'wrong-instance' }), /链接已丢失/);
    assert.equal(rememberPrefabAttachment(reopened, attachment), instance);
    await configurePrefabAttachment(reopened, { uuid: 'native-asset' });
    assert.equal(f.calls.length, 1);
    removeOwnedPrefabAttachment(reopened);
    assert.equal(instance.destroyed, true); assert.equal(ownedPrefabAttachment(reopened), undefined);
});

test('creator API is mandatory and a returned preexisting child is never destroyed or adopted', async (t) => {
    const f = carrierFixture(t);
    global.cce.SceneFacadeManager.createNode = undefined;
    await assert.rejects(configurePrefabAttachment(f.carrier, { uuid: 'native-asset' }), /API 不可用/);
    assert.equal(f.carrier.children.length, 0);
    const manual = { uuid: 'manual', parent: f.carrier, destroyed: false,
        removeFromParent() { throw new Error('must not remove manual node'); }, destroy() { this.destroyed = true; } };
    f.carrier.children.push(manual);
    global.cce.SceneFacadeManager.createNode = async () => manual.uuid;
    await assert.rejects(configurePrefabAttachment(f.carrier, { uuid: 'native-asset' }), /原生链接/);
    assert.equal(manual.destroyed, false); assert.equal(manual.parent, f.carrier);
});

test('failure after editor creation cleans only the new linked child and retains the old instance', async (t) => {
    const f = carrierFixture(t);
    await configurePrefabAttachment(f.carrier, { uuid: 'native-asset' });
    const previous = f.carrier.children[0];
    const create = global.cce.SceneFacadeManager.createNode;
    global.cce.SceneFacadeManager.createNode = async options => { await create(options); throw new Error('creation finalization failed'); };
    await assert.rejects(configurePrefabAttachment(f.carrier, { uuid: 'replacement' }), /finalization failed/);
    assert.deepEqual(f.carrier.children, [previous]);
    assert.equal(previous.destroyed, undefined);
    assert.equal(ownedPrefabAttachment(f.carrier).assetUuid, 'native-asset');
});
