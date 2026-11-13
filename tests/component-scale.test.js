'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNode, parseDocument } = require('../dist/figma/parser');
const { resolvePrefabComponentScales } = require('../dist/figma/component-scale');
const { CancelledError } = require('../dist/figma/client');
const { frameDocument } = require('../dist/batch-import');

function node(id, type, width, height, extra = {}) {
    return parseNode({ id, type, name: id, size: { x: width, y: height },
        absoluteBoundingBox: { x: 0, y: 0, width, height },
        componentProperties: { prefab: { type: 'TEXT', value: 'CommonItemIcon' } }, ...extra });
}

function documentWith(nodes, components) {
    const nodeById = new Map();
    const visit = (entry) => { nodeById.set(entry.id, entry); entry.children.forEach(visit); };
    nodes.forEach(visit);
    return { fileKey: 'CurrentFile', roots: nodes, nodeById, tree: [], fonts: [], components };
}

const noApi = () => ({ getNode: async () => assert.fail('mother is already in the source context'),
    getComponent: async () => assert.fail('local components do not need published metadata') });
const response = (component) => ({ nodes: { [component.id]: { document: { ...component,
    size: component.size ? { x: component.size.width, y: component.size.height } : undefined,
    rotation: component.rotation * Math.PI / 180,
} } } });

test('uses separate Figma instance-to-mother axis ratios without an engine-size baseline', async () => {
    const mother = node('mother', 'COMPONENT', 100, 40);
    const instance = node('instance', 'INSTANCE', 150, 20, { componentId: 'mother' });
    const children = instance.children;
    const document = documentWith([mother, instance]);
    await resolvePrefabComponentScales(document, [instance], noApi());
    assert.deepEqual(instance.prefabScale, { x: 1.5, y: 0.5 });
    assert.equal(instance.prefabScaleWarning, undefined);
    assert.equal(instance.children, children);
    assert.equal(document.nodeById.size, 2);
    assert.deepEqual(mother.size, { width: 100, height: 40 });
});

test('a COMPONENT or COMPONENT_SET reference uses the definition itself at ratio one', async () => {
    const definitions = ['COMPONENT', 'COMPONENT_SET'].map((type) => node(type, type, 100, 50));
    await resolvePrefabComponentScales(documentWith(definitions), definitions, noApi());
    for (const definition of definitions) assert.deepEqual(definition.prefabScale, { x: 1, y: 1 });
});

test('fetches an omitted same-file mother once and recomputes from fresh data on the next resolve', async () => {
    const first = node('a', 'INSTANCE', 200, 120, { componentId: 'mother' });
    const second = node('b', 'INSTANCE', 50, 30, { componentId: 'mother' });
    const document = documentWith([first, second]);
    const calls = [];
    let width = 100;
    const api = { ...noApi(), getNode: async (...args) => {
        calls.push(args); return response(node('mother', 'COMPONENT', width, 60));
    } };
    await resolvePrefabComponentScales(document, [first, second], api);
    assert.deepEqual(calls, [['CurrentFile', 'mother']]);
    assert.deepEqual(first.prefabScale, { x: 2, y: 2 });
    assert.deepEqual(second.prefabScale, { x: 0.5, y: 0.5 });
    width = 200;
    first.prefabScaleWarning = 'stale';
    await resolvePrefabComponentScales(document, [first], api);
    assert.equal(calls.length, 2);
    assert.deepEqual(first.prefabScale, { x: 1, y: 2 });
    assert.equal(first.prefabScaleWarning, undefined);
    assert.equal(document.nodeById.has('mother'), false, 'API reads do not expand the imported source tree');
});

test('remote component keys resolve the actual source file and never use an imported local copy', async () => {
    const localCopy = node('imported-copy', 'COMPONENT', 999, 999);
    const first = node('a', 'INSTANCE', 150, 100, { componentId: 'imported-copy' });
    const second = node('b', 'INSTANCE', 50, 25, { componentId: 'second-copy' });
    const document = documentWith([localCopy, first, second], {
        'imported-copy': { key: 'published-key', remote: true },
        'second-copy': { key: 'published-key', remote: true },
    });
    const componentCalls = [], nodeCalls = [];
    const api = { getComponent: async (key) => { componentCalls.push(key);
        return { meta: { key, file_key: 'ActualLibrary', node_id: 'actual-mother' } }; },
    getNode: async (...args) => { nodeCalls.push(args); return response(node('actual-mother', 'COMPONENT', 100, 50)); } };
    await resolvePrefabComponentScales(document, [first, second], api);
    assert.deepEqual(componentCalls, ['published-key']);
    assert.deepEqual(nodeCalls, [['ActualLibrary', 'actual-mother']]);
    assert.deepEqual(first.prefabScale, { x: 1.5, y: 2 });
    assert.deepEqual(second.prefabScale, { x: 0.5, y: 0.5 });
    assert.equal(localCopy.size.width, 999);
});

test('a frame session reuses detached mother geometry while keeping its imported tree isolated', async () => {
    const document = parseDocument({ document: { children: [{ id: 'page', type: 'CANVAS', children: [
        { id: 'screen', type: 'FRAME', children: [{ id: 'instance', type: 'INSTANCE', componentId: 'mother',
            size: { x: 250, y: 30 }, componentProperties: { prefab: { type: 'TEXT', value: 'Icon' } } }] },
        { id: 'mother', type: 'COMPONENT', size: { x: 100, y: 60 } },
    ] }] } }, 'https://figma.com/design/FileKey12345/UI', 'FileKey12345');
    const frame = frameDocument(document, document.nodeById.get('screen'));
    const instance = frame.nodeById.get('instance');
    await resolvePrefabComponentScales(frame, [instance], noApi());
    assert.deepEqual(instance.prefabScale, { x: 2.5, y: 0.5 });
    assert.deepEqual([...frame.nodeById.keys()], ['screen', 'instance']);
});

test('rotated instances and mothers use local sizes instead of their rotated bounding boxes', async () => {
    const mother = node('mother', 'COMPONENT', 100, 50, {
        rotation: Math.PI / 2, relativeTransform: [[0, -1, 0], [1, 0, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 100 },
    });
    const instance = node('instance', 'INSTANCE', 150, 100, { componentId: 'mother',
        relativeTransform: [[0, -1, 0], [1, 0, 0]],
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 150 },
    });
    await resolvePrefabComponentScales(documentWith([mother, instance]), [instance], noApi());
    assert.deepEqual(instance.prefabScale, { x: 1.5, y: 2 });
});

test('matrix axis lengths include local scale independently of rotation', async () => {
    const mother = node('mother', 'COMPONENT', 100, 50, { relativeTransform: [[2, 0, 0], [0, 1, 0]] });
    const instance = node('instance', 'INSTANCE', 100, 50, { componentId: 'mother',
        relativeTransform: [[0, -3, 0], [2, 0, 0]] });
    await resolvePrefabComponentScales(documentWith([mother, instance]), [instance], noApi());
    assert.deepEqual(instance.prefabScale, { x: 1, y: 3 });
});

test('zero-rotation bounding boxes are a fallback and their matrix scale is not counted twice', async () => {
    const mother = node('mother', 'COMPONENT', 100, 50, { size: undefined });
    const instance = node('instance', 'INSTANCE', 200, 150, { componentId: 'mother', size: undefined,
        relativeTransform: [[2, 0, 0], [0, 3, 0]] });
    await resolvePrefabComponentScales(documentWith([mother, instance]), [instance], noApi());
    assert.deepEqual(instance.prefabScale, { x: 2, y: 3 });
});

test('rotation without intrinsic size, zero size and skew warn instead of guessing a ratio', async () => {
    const mother = node('mother', 'COMPONENT', 100, 50);
    const instances = [
        node('rotated', 'INSTANCE', 100, 50, { componentId: 'mother', size: undefined, rotation: Math.PI / 4 }),
        node('zero', 'INSTANCE', 100, 50, { componentId: 'mother', size: { x: 0, y: 50 } }),
        node('skewed', 'INSTANCE', 100, 50, { componentId: 'mother', relativeTransform: [[1, 0.2, 0], [0, 1, 0]] }),
    ];
    for (const instance of instances) instance.prefabScale = { x: 99, y: 99 };
    await resolvePrefabComponentScales(documentWith([mother, ...instances]), instances, noApi());
    for (const instance of instances) {
        assert.equal(instance.prefabScale, undefined);
        assert.match(instance.prefabScaleWarning, /不猜测缩放/);
    }
    assert.match(instances[0].prefabScaleWarning, /旋转/);
    assert.match(instances[1].prefabScaleWarning, /零/);
    assert.match(instances[2].prefabScaleWarning, /斜切/);
    mother.size.width = 0;
    const valid = node('valid', 'INSTANCE', 100, 50, { componentId: 'mother' });
    await resolvePrefabComponentScales(documentWith([mother, valid]), [valid], noApi());
    assert.equal(valid.prefabScale, undefined);
    assert.match(valid.prefabScaleWarning, /零/);
});

test('missing component identity or a failed remote read warns per node and clears stale decisions', async () => {
    const missing = node('missing', 'INSTANCE', 100, 50);
    const remote = node('remote', 'INSTANCE', 100, 50, { componentId: 'remote-mother' });
    const valid = node('valid', 'COMPONENT', 100, 50);
    for (const entry of [missing, remote, valid]) { entry.prefabScale = { x: 12, y: 12 }; entry.prefabScaleWarning = 'old'; }
    const api = { ...noApi(), getComponent: async () => { throw new Error('secret-file-key: secret-node-id permission denied'); } };
    await resolvePrefabComponentScales(documentWith([missing, remote, valid], {
        'remote-mother': { remote: true, key: 'published' },
    }), [missing, remote, valid], api);
    assert.equal(missing.prefabScale, undefined);
    assert.match(missing.prefabScaleWarning, /母组件标识/);
    assert.equal(remote.prefabScale, undefined);
    assert.match(remote.prefabScaleWarning, /读取权限/);
    assert.equal(remote.prefabScaleWarning.includes('secret-'), false);
    assert.deepEqual(valid.prefabScale, { x: 1, y: 1 });
    assert.equal(valid.prefabScaleWarning, undefined);
});

test('remote references cannot fall back to a local clone when key or published source metadata is missing', async () => {
    const mother = node('mother', 'COMPONENT', 100, 50);
    const instance = node('instance', 'INSTANCE', 200, 100, { componentId: 'mother' });
    const document = documentWith([mother, instance], { mother: { remote: true } });
    await resolvePrefabComponentScales(document, [instance], noApi());
    assert.match(instance.prefabScaleWarning, /发布 key/);
    for (const metadata of [{}, { key: 'different', file_key: 'Library', node_id: 'real' }]) {
        document.components.mother.key = 'published';
        await resolvePrefabComponentScales(document, [instance], {
            ...noApi(), getComponent: async () => ({ meta: metadata }),
        });
        assert.equal(instance.prefabScale, undefined);
        assert.match(instance.prefabScaleWarning, /来源元数据无效/);
    }
});

test('failed same-file lookups are cached but unexpected response identities are never accepted', async () => {
    const instances = ['a', 'b'].map((id) => node(id, 'INSTANCE', 200, 100, { componentId: 'mother' }));
    let calls = 0;
    await resolvePrefabComponentScales(documentWith(instances), instances, {
        ...noApi(), getNode: async () => { calls++; return response(node('unrelated', 'COMPONENT', 100, 50)); },
    });
    assert.equal(calls, 1);
    for (const instance of instances) {
        assert.equal(instance.prefabScale, undefined);
        assert.match(instance.prefabScaleWarning, /身份一致/);
    }
});

test('a cancelled mother read still aborts the import and leaves old ratios cleared', async () => {
    const instance = node('instance', 'INSTANCE', 100, 50, { componentId: 'mother' });
    instance.prefabScale = { x: 9, y: 9 };
    const cancelled = new CancelledError();
    await assert.rejects(resolvePrefabComponentScales(documentWith([instance]), [instance], {
        ...noApi(), getNode: async () => { throw cancelled; },
    }), (error) => error === cancelled);
    assert.equal(instance.prefabScale, undefined);
    assert.equal(instance.prefabScaleWarning, undefined);
});

test('empty and removed-parameter selections do not cause mother-component network reads', async () => {
    const removed = node('removed', 'INSTANCE', 100, 50, { componentProperties: {} });
    removed.prefabScale = { x: 2, y: 2 }; removed.prefabScaleWarning = 'old';
    await resolvePrefabComponentScales(documentWith([removed]), [], noApi());
    await resolvePrefabComponentScales(documentWith([removed]), [removed], noApi());
    assert.equal(removed.prefabScale, undefined);
    assert.equal(removed.prefabScaleWarning, undefined);
});
