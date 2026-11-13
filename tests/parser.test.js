'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, parseNode } = require('../dist/figma/parser');

test('preserves typed component origin metadata from full file and selected node responses', () => {
    const components = { '20:1': { key: ' local-key ', remote: false, name: 'Local' },
        '20:2': { key: 'remote-key', remote: true }, invalid: null };
    const root = { id: '1:1', type: 'FRAME', children: [{ id: '1:2', type: 'INSTANCE', componentId: '20:2' }] };
    const full = parseDocument({ components, document: { children: [root] } }, 'url', 'File');
    assert.deepEqual(full.components, { '20:1': { key: 'local-key', remote: false },
        '20:2': { key: 'remote-key', remote: true } });
    const selected = parseDocument({ components, nodes: { '1:1': { document: root,
        components: { '20:2': { remote: true }, '20:3': { key: 'entry-key', remote: false } },
    } } }, 'url', 'File', '1:1');
    assert.deepEqual(selected.components, { ...full.components, '20:3': { key: 'entry-key', remote: false } });
    assert.equal(selected.nodeById.get('1:2').componentId, '20:2');
    assert.equal(components['20:1'].key, ' local-key ', 'normalization does not mutate the REST payload');
    selected.components['20:1'].key = 'Changed';
    assert.equal(full.components['20:1'].key, 'local-key');
});

test('reads only the current node typed prefab component parameter and trims its value', () => {
    const instance = parseNode({ id: 'prefab:instance', type: 'INSTANCE', name: 'Button',
        componentProperties: { 'prefab#123:456': { type: 'TEXT', value: '  CommonButton  ' } },
        children: [{ id: 'prefab:text', type: 'TEXT', name: 'prefab', characters: 'WrongPrefab' }] });
    assert.equal(instance.prefabName, 'CommonButton');
    assert.equal(instance.children[0].prefabName, undefined);
    assert.equal(parseNode({ id: 'plain:key', type: 'INSTANCE',
        componentProperties: { prefab: { type: 'TEXT', value: 'PlainButton' } } }).prefabName, 'PlainButton');
    const parent = parseNode({ id: 'prefab:parent', type: 'FRAME', children: [{
        id: 'prefab:child', type: 'INSTANCE',
        componentProperties: { prefab: { type: 'TEXT', value: 'ChildOnly' } },
    }] });
    assert.equal(parent.prefabName, undefined);
    assert.equal(parent.children[0].prefabName, 'ChildOnly');
});

test('reads prefab defaults only from component definitions and honors an empty actual value', () => {
    for (const type of ['COMPONENT', 'COMPONENT_SET']) {
        const definition = { id: `prefab:${type}`, type,
            componentPropertyDefinitions: { 'prefab#1:2': { type: 'TEXT', defaultValue: 'DefaultButton' } } };
        assert.equal(parseNode(definition).prefabName, 'DefaultButton');
        assert.equal(parseNode({ ...definition,
            componentProperties: { 'prefab#1:2': { type: 'TEXT', value: 'ActualButton' } } }).prefabName, 'ActualButton');
        assert.equal(parseNode({ ...definition,
            componentProperties: { 'prefab#1:2': { type: 'TEXT', value: '  ' } } }).prefabName, undefined);
    }
    assert.equal(parseNode({ id: 'prefab:empty-instance', type: 'INSTANCE',
        componentProperties: { prefab: { type: 'TEXT', value: '' } },
        componentPropertyDefinitions: { prefab: { type: 'TEXT', defaultValue: 'DoNotInherit' } },
    }).prefabName, undefined);
    assert.equal(parseNode({ id: 'prefab:default-instance', type: 'INSTANCE',
        componentPropertyDefinitions: { prefab: { type: 'TEXT', defaultValue: 'DoNotInherit' } },
    }).prefabName, undefined);
});

test('ignores untyped, non-TEXT and similarly named prefab parameters', () => {
    for (const property of [{ type: 'BOOLEAN', value: true }, { type: 'VARIANT', value: 'Button' },
        { type: 'INSTANCE_SWAP', value: 'Button' }, { value: 'Button' }, { type: 'TEXT', value: 42 }]) {
        assert.equal(parseNode({ id: 'prefab:wrong-type', type: 'INSTANCE',
            componentProperties: { prefab: property } }).prefabName, undefined);
    }
    for (const key of ['prefabs', 'Prefab', 'prefab#abc', 'prefab#1:2:3', 'notprefab#1:2']) {
        assert.equal(parseNode({ id: 'prefab:wrong-name', type: 'INSTANCE',
            componentProperties: { [key]: { type: 'TEXT', value: 'Button' } } }).prefabName, undefined);
    }
    assert.equal(parseNode({ id: 'prefab:ordinary-text', name: 'prefab', type: 'TEXT', characters: 'Button' }).prefabName, undefined);
});

test('rejects conflicting prefab parameter values instead of choosing by property order', () => {
    const properties = { 'prefab#1:1': { type: 'TEXT', value: 'ButtonA' },
        'prefab#1:2': { type: 'TEXT', value: 'ButtonB' } };
    assert.throws(() => parseNode({ id: 'prefab:conflict', type: 'INSTANCE', name: 'Conflicted',
        componentProperties: properties }), /Conflicted.*冲突.*prefab/);
    assert.throws(() => parseNode({ id: 'prefab:empty-conflict', type: 'INSTANCE',
        componentProperties: { ...properties, 'prefab#1:2': { type: 'TEXT', value: '' } } }), /冲突/);
    assert.equal(parseNode({ id: 'prefab:same', type: 'INSTANCE',
        componentProperties: { ...properties, 'prefab#1:2': { type: 'TEXT', value: ' ButtonA ' } } }).prefabName, 'ButtonA');
});

test('parses every Figma page instead of silently using the first page', () => {
    const payload = {
        name: 'All Pages',
        document: {
            children: [
                {
                    id: '0:1',
                    name: 'Page A',
                    type: 'CANVAS',
                    children: [{
                        id: '1:1',
                        name: 'Title',
                        type: 'TEXT',
                        characters: 'Hello',
                        style: { fontFamily: 'Inter', fontSize: 24 },
                        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 30 },
                    }],
                },
                {
                    id: '0:2',
                    name: 'Page B',
                    type: 'CANVAS',
                    children: [{
                        id: '2:1',
                        name: 'Body',
                        type: 'TEXT',
                        characters: 'World',
                        style: { fontFamily: 'Noto Sans', fontSize: 16 },
                        absoluteBoundingBox: { x: 0, y: 50, width: 160, height: 24 },
                    }],
                },
            ],
        },
    };
    const session = parseDocument(payload, 'https://figma.com/file/LongFileKey123/X', 'LongFileKey123');
    assert.equal(session.roots.length, 2);
    assert.equal(session.nodeById.size, 4);
    assert.deepEqual(session.fonts, ['Inter', 'Noto Sans']);
});

test('guards missing bounds and sorts gradient stops', () => {
    const node = parseNode({
        id: '1:2',
        name: 'Gradient',
        type: 'RECTANGLE',
        fills: [{
            type: 'GRADIENT_LINEAR',
            gradientStops: [
                { position: 1, color: { r: 1, g: 1, b: 1 } },
                { position: 0, color: { r: 0, g: 0, b: 0 } },
            ],
        }],
    });
    assert.ok(node);
    assert.equal(node.absoluteBoundingBox, undefined);
    assert.deepEqual(node.fills[0].gradientStops.map((stop) => stop.position), [0, 1]);
});

test('preserves Figma visual render bounds separately from geometric bounds', () => {
    const node = parseNode({
        id: '433:7481',
        name: 'Outlined rectangle',
        type: 'RECTANGLE',
        absoluteBoundingBox: { x: 100, y: 200, width: 145.7827, height: 129.503 },
        absoluteRenderBounds: { x: 98.82885, y: 198.829, width: 148.125, height: 131.845 },
    });

    assert.ok(node);
    assert.deepEqual(node.absoluteRenderBounds, {
        x: 98.82885,
        y: 198.829,
        width: 148.125,
        height: 131.845,
    });
});

test('converts Figma REST radians and transform matrices to Cocos degrees', () => {
    const node = parseNode({
        id: '231:46119',
        name: 'common_xian_01',
        type: 'RECTANGLE',
        rotation: Math.PI,
        size: { x: 68, y: 17 },
        relativeTransform: [
            [-1, 0, 396],
            [0, -1, 58.5],
        ],
        absoluteBoundingBox: { x: 328, y: 41.5, width: 68, height: 17 },
    });

    assert.ok(node);
    assert.equal(node.rotation, 180);
    assert.deepEqual(node.size, { width: 68, height: 17 });
});

test('preserves Figma PATTERN paint source and native tiling settings', () => {
    const node = parseNode({
        id: '410:4754',
        name: 'Ellipse 1',
        type: 'ELLIPSE',
        fills: [{
            type: 'PATTERN',
            sourceNodeId: '410:4755',
            tileType: 'RECTANGULAR',
            scalingFactor: 1,
            spacing: { x: 0, y: 0 },
            horizontalAlignment: 'START',
            verticalAlignment: 'START',
        }],
    });

    assert.ok(node);
    assert.deepEqual(node.fills[0], {
        type: 'PATTERN',
        visible: true,
        opacity: 1,
        blendMode: undefined,
        color: undefined,
        imageRef: undefined,
        scaleMode: undefined,
        rotation: undefined,
        sourceNodeId: '410:4755',
        tileType: 'RECTANGULAR',
        scalingFactor: 1,
        spacing: { x: 0, y: 0 },
        horizontalAlignment: 'START',
        verticalAlignment: 'START',
        gradientHandlePositions: [],
        gradientStops: [],
    });
});

test('preserves ellipse arc data so partial and hollow ellipses can avoid native masks', () => {
    const node = parseNode({
        id: '410:4757',
        name: 'Arc',
        type: 'ELLIPSE',
        arcData: {
            startingAngle: 0,
            endingAngle: Math.PI,
            innerRadius: 0.5,
        },
    });

    assert.ok(node);
    assert.deepEqual(node.arcData, {
        startingAngle: 0,
        endingAngle: Math.PI,
        innerRadius: 0.5,
    });
});

test('records manual Figma Export presence without retaining unused format metadata', () => {
    const exported = parseNode({
        id: '2:1',
        name: 'Exported frame',
        type: 'FRAME',
        exportSettings: [{
            format: 'SVG',
            suffix: '@2x',
            constraint: { type: 'SCALE', value: 2 },
        }],
    });
    const empty = parseNode({
        id: '2:2',
        name: 'Empty export settings',
        type: 'FRAME',
        exportSettings: [],
    });
    const malformed = parseNode({
        id: '2:3',
        name: 'Malformed export settings',
        type: 'FRAME',
        exportSettings: { format: 'PNG' },
    });

    assert.ok(exported);
    assert.ok(empty);
    assert.ok(malformed);
    assert.equal(exported.hasExportSettings, true);
    assert.equal(empty.hasExportSettings, false);
    assert.equal(malformed.hasExportSettings, false);
    assert.equal(Object.hasOwn(exported, 'exportSettings'), false);
});
