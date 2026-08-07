'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    inferAction,
    inferCocosLayoutMode,
    inferKind,
    isNamedSliceGroup,
    isPatchCandidate,
    isVectorNode,
} = require('../dist/figma/analyzer');
const { parseNode } = require('../dist/figma/parser');
const { analyzeSliceGrid } = require('../dist/figma/slicing');

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
    assert.equal(inferAction(node({
        type: 'TEXT',
        characters: 'Decorated text',
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 0, b: 0, a: 1 } }],
        effects: [{ type: 'DROP_SHADOW', visible: true, radius: 8 }],
    })), 'generate');
    assert.equal(inferAction(node({ type: 'VECTOR' })), 'render');
    assert.equal(isVectorNode(node({ type: 'BOOLEAN_OPERATION' })), true);
    assert.equal(isVectorNode(node({ type: 'RECTANGLE' })), false);
    assert.equal(inferKind(node({ overflowDirection: 'VERTICAL_SCROLLING' })), 'scrollView');
    assert.equal(inferKind(node({ name: 'Primary Button' })), 'button');
    assert.equal(inferKind(node({ layoutMode: 'HORIZONTAL' })), 'layout');
    assert.equal(inferKind(node({})), 'node');
    assert.equal(inferKind(node({ name: 'common_btn_close' })), 'button');
    assert.equal(inferKind(node({ name: 'list_rewards' })), 'scrollView');
});

test('uses Cocos Layout only when Figma auto-layout can be represented safely', () => {
    const uniformGrid = node({
        layoutMode: 'HORIZONTAL',
        layoutWrap: 'WRAP',
        children: [0, 1, 2].map((index) => ({
            id: `4:${index}`,
            name: `Card ${index}`,
            type: 'FRAME',
            absoluteBoundingBox: { x: index * 110, y: 0, width: 100, height: 80 },
        })),
    });
    assert.equal(inferCocosLayoutMode(uniformGrid), 'GRID');
    assert.equal(inferKind(uniformGrid), 'layout');

    const mixedWrap = node({
        layoutMode: 'HORIZONTAL',
        layoutWrap: 'WRAP',
        children: [
            {
                id: '5:1',
                name: 'Header',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 488, height: 50 },
            },
            {
                id: '5:2',
                name: 'Card',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 66, width: 152, height: 197 },
            },
        ],
    });
    assert.equal(inferCocosLayoutMode(mixedWrap), undefined);
    assert.equal(inferKind(mixedWrap), 'node');

    const absoluteChild = node({
        layoutMode: 'VERTICAL',
        children: [{
            id: '6:1',
            name: 'Background',
            type: 'RECTANGLE',
            layoutPositioning: 'ABSOLUTE',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }],
    });
    assert.equal(inferCocosLayoutMode(absoluteChild), undefined);
    assert.equal(inferKind(absoluteChild), 'node');
});

test('renders image fills and effects for visual fidelity', () => {
    assert.equal(inferAction(node({
        fills: [{ type: 'IMAGE', imageRef: 'ref' }],
    })), 'render');
    assert.equal(inferAction(node({
        effects: [{ type: 'DROP_SHADOW', visible: true }],
    })), 'render');
    assert.equal(inferAction(node({
        fills: [{ type: 'IMAGE', imageRef: 'background' }],
        children: [{
            id: '7:1',
            name: 'Editable content',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 20 },
        }],
    })), 'generate');
});

test('detects three- and nine-slice candidates without enabling them automatically', () => {
    const candidate = node({
        absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 10 },
        children: [0, 1, 2].map((index) => ({
            id: `2:${index}`,
            name: 'slice',
            type: 'RECTANGLE',
            absoluteBoundingBox: { x: index * 10, y: 0, width: 10, height: 10 },
        })),
    });
    assert.equal(isPatchCandidate(candidate), true);

    const arbitraryChildren = node({
        children: [0, 1, 2].map((index) => ({
            id: `3:${index}`,
            name: 'slice',
            type: 'RECTANGLE',
            absoluteBoundingBox: { x: index * 10, y: index * 10, width: 10, height: 10 },
        })),
    });
    assert.equal(isPatchCandidate(arbitraryChildren), false);
});

test('automatically merges parents containing three or nine Rectangle-named children', () => {
    for (const count of [3, 9]) {
        const candidate = node({
            children: Array.from({ length: count }, (_, index) => ({
                id: `${count}:${index}`,
                name: index === 0 ? 'Rectangle' : `Rectangle ${index}`,
                type: index === count - 1 ? 'INSTANCE' : 'RECTANGLE',
                absoluteBoundingBox: { x: index * 10, y: 0, width: 10, height: 10 },
            })),
        });
        assert.equal(isNamedSliceGroup(candidate), true);
        assert.equal(inferAction(candidate), 'merge');
        assert.equal(isPatchCandidate(candidate), true);
    }

    const unrelated = node({
        children: [0, 1, 2].map((index) => ({
            id: `10:${index}`,
            name: index === 2 ? 'Icon' : `Rectangle${index}`,
            type: 'RECTANGLE',
            absoluteBoundingBox: { x: index * 10, y: 0, width: 10, height: 10 },
        })),
    });
    assert.equal(isNamedSliceGroup(unrelated), false);
    assert.equal(inferAction(unrelated), 'generate');
});

test('derives asymmetric Cocos borders from a real nine-slice layout', () => {
    const widths = [132.5, 220.1, 183.4];
    const heights = [102.8, 791.6, 65.6];
    let id = 0;
    const children = [];
    let y = 0;
    for (const height of heights) {
        let x = 0;
        for (const width of widths) {
            children.push({
                id: `9:${id++}`,
                name: 'Rectangle',
                type: 'RECTANGLE',
                absoluteBoundingBox: { x, y, width, height },
            });
            x += width;
        }
        y += height;
    }
    const candidate = node({
        absoluteBoundingBox: { x: 0, y: 0, width: 536, height: 960 },
        children,
    });
    const analysis = analyzeSliceGrid(candidate);
    assert.ok(analysis);
    assert.equal(analysis.mode, 'nine');
    assert.ok(Math.abs(analysis.borders.left - 132.5) < 0.001);
    assert.ok(Math.abs(analysis.borders.right - 183.4) < 0.001);
    assert.ok(Math.abs(analysis.borders.top - 102.8) < 0.001);
    assert.ok(Math.abs(analysis.borders.bottom - 65.6) < 0.001);
});
