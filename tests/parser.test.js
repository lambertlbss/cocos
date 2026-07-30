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
