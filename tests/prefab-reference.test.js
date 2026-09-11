'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configurePrefabReference, referencedPrefabChild, removePrefabReference } = require('../dist/prefab-reference');

function fixture() {
    class Vec3 { constructor(x, y, z) { Object.assign(this, { x, y, z }); } clone() { return new Vec3(this.x, this.y, this.z); } }
    class UITransform {}
    class Prefab {}
    Prefab._utils = { TargetInfo: class {}, PropertyOverrideInfo: class {} };
    let next = 0;
    class Node {
        constructor(name = 'AuthoredRoot') { this.name = name; this.children = []; this.__editorExtras__ = {}; this.position = new Vec3(0, 0, 0); }
        addChild(child) { this.children.push(child); child.parent = this; }
        getComponent() { return { anchorPoint: { x: 0, y: 1 }, contentSize: { width: 100, height: 80 } }; }
        setPosition(value) { this.position = value; }
        removeFromParent() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
        destroy() { this.destroyed = true; }
    }
    const owner = new Node('FigmaWrapper');
    const cc = { Prefab, UITransform, Vec3, assetManager: { loadAny({ uuid }, callback) {
        const asset = new Prefab(); asset._uuid = uuid; asset.data = new Node(); callback(null, asset);
    } } };
    const cce = { Prefab: { createNodeFromPrefabAsset(asset) {
        const child = new Node();
        child._prefab = { asset, root: child, fileId: 'source-root', instance: {
            fileId: `instance-${++next}`, propertyOverrides: [], mountedChildren: [], mountedComponents: [], removedComponents: [],
        } };
        child.addChild(new Node('AuthoredContent'));
        return child;
    } } };
    return { owner, cc, cce };
}
const spec = { uuid: 'source-asset', url: 'db://assets/Widget.prefab', width: 100, height: 80 };

test('creates a linked instance, records anchor offset override, and reuses it after serialized ownership reload', async () => {
    const { owner, cc, cce } = fixture(); const previous = global.cce; global.cce = cce;
    try {
        await configurePrefabReference(owner, spec, cc);
        const child = referencedPrefabChild(owner);
        const content = child.children[0];
        assert.equal(child._prefab.asset._uuid, spec.uuid);
        assert.equal(child.name, 'AuthoredRoot');
        assert.deepEqual(child.position, new cc.Vec3(-50, 40, 0));
        assert.deepEqual(child._prefab.instance.propertyOverrides[0].targetInfo.localID, ['source-root']);
        assert.deepEqual(child._prefab.instance.propertyOverrides[0].propertyPath, ['_lpos']);
        owner.__editorExtras__ = JSON.parse(JSON.stringify(owner.__editorExtras__));
        await configurePrefabReference(owner, spec, cc);
        assert.equal(owner.children.length, 1);
        assert.equal(referencedPrefabChild(owner), child);
        assert.equal(child.children[0], content);
        assert.equal(child._prefab.instance.propertyOverrides.length, 1);
    } finally { global.cce = previous; }
});

test('reference swap/removal never changes the source asset; foreign sibling is preserved', async () => {
    const { owner, cc, cce } = fixture(); const previous = global.cce; global.cce = cce;
    try {
        await configurePrefabReference(owner, spec, cc);
        const old = referencedPrefabChild(owner); const originalAsset = old._prefab.asset;
        const manual = { name: 'Manual' }; owner.addChild(manual);
        await configurePrefabReference(owner, { ...spec, uuid: 'other' }, cc);
        assert.equal(old.destroyed, true);
        assert.equal(originalAsset._uuid, 'source-asset');
        assert.equal(referencedPrefabChild(owner)._prefab.asset._uuid, 'other');
        removePrefabReference(owner);
        assert.deepEqual(owner.children, [manual]);
        assert.equal(referencedPrefabChild(owner), null);
    } finally { global.cce = previous; }
});

test('a user override or replaced reference is protected from automatic cleanup', async () => {
    const { owner, cc, cce } = fixture(); const previous = global.cce; global.cce = cce;
    try {
        await configurePrefabReference(owner, spec, cc);
        const child = referencedPrefabChild(owner);
        child._prefab.instance.mountedComponents.push({ components: [{}] });
        assert.throws(() => removePrefabReference(owner), /手工修改/);
        await assert.rejects(configurePrefabReference(owner, { ...spec, uuid: 'other' }, cc), /手工修改/);
        assert.equal(owner.children[0], child);
        child._prefab.instance.fileId = 'manual-replacement';
        assert.throws(() => removePrefabReference(owner), /手工替换或丢失/);
    } finally { global.cce = previous; }
});

test('fails when editor API is absent or prefab dimensions change', async () => {
    const { owner, cc, cce } = fixture(); const previous = global.cce;
    try {
        global.cce = {};
        await assert.rejects(configurePrefabReference(owner, spec, cc), /创建 API 不可用/);
        global.cce = cce;
        await assert.rejects(configurePrefabReference(owner, { ...spec, width: 101 }, cc), /尺寸已变化/);
        assert.equal(owner.children.length, 0);
    } finally { global.cce = previous; }
});

test('missing override API does not remove an existing reference during replacement', async () => {
    const { owner, cc, cce } = fixture(); const previous = global.cce; global.cce = cce;
    try {
        await configurePrefabReference(owner, spec, cc);
        const child = referencedPrefabChild(owner);
        cc.Prefab._utils = null;
        await assert.rejects(configurePrefabReference(owner, { ...spec, uuid: 'other' }, cc), /属性覆盖 API 不可用/);
        assert.equal(referencedPrefabChild(owner), child);
        assert.equal(child.destroyed, undefined);
    } finally { global.cce = previous; }
});
