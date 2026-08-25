'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, parseNode } = require('../dist/figma/parser');

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
