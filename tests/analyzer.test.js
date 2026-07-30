'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAction, inferKind, isPatchCandidate } = require('../dist/figma/analyzer');
const { parseNode } = require('../dist/figma/parser');

function node(value) {
    const parsed = parseNode({
        id: '1:1',
        name: 'Node',
        type: 'FRAME',
        visible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        ...value,
    });
    assert.ok(parsed);
    return parsed;
}

test('chooses editable Cocos components where fidelity is safe', () => {
    assert.equal(inferAction(node({ type: 'TEXT', characters: 'Text' })), 'generate');
    assert.equal(inferAction(node({ type: 'VECTOR' })), 'svg');
    assert.equal(inferKind(node({ overflowDirection: 'VERTICAL_SCROLLING' })), 'scroll');
    assert.equal(inferKind(node({ name: 'Primary Button' })), 'button');
});

test('renders image fills and effects for visual fidelity', () => {
    assert.equal(inferAction(node({
        fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    })), 'render');
    assert.equal(inferAction(node({
        effects: [{ type: 'DROP_SHADOW', visible: true }],
    })), 'render');
});

test('detects three- and nine-slice candidates without enabling them automatically', () => {
    const candidate = node({
        children: [0, 1, 2].map((index) => ({
            id: `2:${index}`,
            name: 'slice',
            type: 'RECTANGLE',
            absoluteBoundingBox: { x: index * 10, y: 0, width: 10, height: 10 },
        })),
    });
    assert.equal(isPatchCandidate(candidate), true);
});
