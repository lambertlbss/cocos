'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    analyzeTree,
    inferAction,
    inferCocosLayoutMode,
    inferKind,
    hasManualExport,
    isNamedSliceGroup,
    isPatchCandidate,
    isStructuredNodeName,
    isVectorNode,
    shouldRenderMessySubtree,
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
    assert.equal(isVectorNode(node({ type: 'RECTANGLE' })), true);
    assert.equal(inferAction(node({ type: 'RECTANGLE' })), 'render');
    assert.equal(inferAction(node({ type: 'ELLIPSE' })), 'render');
    assert.equal(inferKind(node({ overflowDirection: 'VERTICAL_SCROLLING' })), 'scrollView');
    assert.equal(inferKind(node({ name: 'Primary Button' })), 'button');
    assert.equal(inferKind(node({ layoutMode: 'HORIZONTAL' })), 'layout');
    assert.equal(inferKind(node({})), 'node');
    assert.equal(inferKind(node({ name: 'common_btn_close' })), 'button');
    assert.equal(inferKind(node({ name: 'scroll_rewards' })), 'node');
    assert.equal(inferKind(node({ name: 'list_rewards' })), 'node');
    assert.equal(inferKind(node({ overflowDirection: 'vertical_scrolling' })), 'scrollView');
    assert.equal(inferKind(node({ overflowDirection: 'none' })), 'node');
    assert.equal(inferKind(node({ overflowDirection: 'UNKNOWN' })), 'node');
});

test('treats manual Figma Export as an explicit PNG whole-layer boundary', () => {
    const exportSettings = [{
        format: 'PDF',
        suffix: '-print',
        constraint: { type: 'WIDTH', value: 512 },
    }];
    const structuredRoot = node({
        name: 'panel_export',
        exportSettings,
        children: [{
            id: 'export:1',
            name: 'panel_content',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }],
    });
    const [rootTree] = analyzeTree([structuredRoot]);

    assert.equal(hasManualExport(structuredRoot), true);
    assert.equal(inferAction(structuredRoot), 'render');
    assert.equal(rootTree.action, 'render');
    assert.equal(rootTree.renderSubtree, true);
    assert.match(rootTree.warning, /Figma Export.*PNG 整层/);

    const scrollHost = node({
        name: 'panel_host',
        children: [{
            id: 'export:2',
            name: 'scroll_rewards',
            type: 'FRAME',
            overflowDirection: 'VERTICAL_SCROLLING',
            exportSettings,
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            children: [{
                id: 'export:3',
                name: 'panel_content',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 200 },
            }],
        }],
    });
    const scrollTree = analyzeTree([scrollHost])[0].children[0];
    assert.equal(scrollTree.kind, 'scrollView');
    assert.equal(scrollTree.action, 'render');
    assert.equal(scrollTree.renderSubtree, true);
    assert.match(scrollTree.warning, /PNG 整层/);

    const hidden = node({
        visible: false,
        exportSettings,
        children: [{
            id: 'export:4',
            name: 'panel_content',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }],
    });
    const [hiddenTree] = analyzeTree([hidden]);
    assert.equal(inferAction(hidden), 'ignore');
    assert.equal(hiddenTree.action, 'ignore');
    assert.equal(hiddenTree.renderSubtree, false);
    assert.equal(hiddenTree.warning, undefined);

    const exportedText = node({
        type: 'TEXT',
        characters: 'Editable text',
        exportSettings,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
    });
    const [textTree] = analyzeTree([exportedText]);
    assert.equal(hasManualExport(exportedText), true);
    assert.equal(inferAction(exportedText), 'generate');
    assert.equal(textTree.action, 'generate');
    assert.equal(textTree.renderSubtree, false);

    const emptyExport = node({
        name: 'panel_plain',
        exportSettings: [],
        children: [{
            id: 'export:5',
            name: 'panel_content',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        }],
    });
    const [emptyTree] = analyzeTree([emptyExport]);
    assert.equal(hasManualExport(emptyExport), false);
    assert.equal(inferAction(emptyExport), 'generate');
    assert.equal(emptyTree.action, 'generate');
    assert.equal(emptyTree.renderSubtree, false);
});

test('does not mistake ordinary list-named layout containers for ScrollViews', () => {
    assert.equal(inferKind(node({
        name: 'panel_listcontainer',
        clipsContent: false,
        overflowDirection: 'NONE',
    })), 'node');
    assert.equal(inferKind(node({
        name: 'list_tabs',
        type: 'INSTANCE',
        clipsContent: false,
        overflowDirection: 'NONE',
        layoutMode: 'HORIZONTAL',
    })), 'layout');
    assert.equal(inferKind(node({
        name: 'panel_list',
        clipsContent: true,
        overflowDirection: 'NONE',
        layoutMode: 'HORIZONTAL',
        children: [{
            id: '1:2',
            name: 'panel_header',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
        }],
    })), 'layout');
});

test('does not infer ScrollView from clipping, overflow geometry, or a scroll-like name', () => {
    assert.equal(inferKind(node({
        name: 'scroll_rewards',
        clipsContent: true,
        overflowDirection: 'NONE',
        children: [{
            id: '1:2',
            name: 'Reward items',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 160 },
        }],
    })), 'node');
});

test('recognizes only strict multi-segment snake_case as a structured node name', () => {
    for (const name of ['img_hongbao_bg_mini', 'panel_list', 'icon_01', 'UI_panel_bg']) {
        assert.equal(isStructuredNodeName(name), true, name);
    }
    for (const name of [
        'Group 91',
        'Frame 92',
        'Ellipse 5',
        '减去顶层',
        'img',
        'img__bg',
        '_img_bg',
        'img_bg_',
        'img-bg',
        ' img_bg',
    ]) {
        assert.equal(isStructuredNodeName(name), false, name);
    }
});

test('renders the nearest non-root structured boundary when its visible direct children are messy', () => {
    const root = node({
        name: 'panel_root',
        children: [{
            id: '11:1',
            name: 'img_hongbao_bg_mini',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 80 },
            children: [{
                id: '11:2',
                name: 'Group 91',
                type: 'GROUP',
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 80 },
                children: [{
                    id: '11:3',
                    name: 'Ellipse 5',
                    type: 'ELLIPSE',
                    absoluteBoundingBox: { x: 10, y: 10, width: 20, height: 20 },
                }],
            }],
        }],
    });
    const [tree] = analyzeTree([root]);
    const assetBoundary = tree.children[0];

    assert.equal(tree.action, 'generate');
    assert.equal(tree.renderSubtree, false);
    assert.equal(shouldRenderMessySubtree(root, true), false);
    assert.equal(assetBoundary.action, 'render');
    assert.equal(assetBoundary.renderSubtree, true);
    assert.match(assetBoundary.warning, /PNG 整层/);
});

test('does not flatten structured, hidden-noise, root, or explicit ScrollView containers', () => {
    const hiddenNoise = node({
        name: 'panel_content',
        children: [
            {
                id: '12:1',
                name: 'Group 91',
                visible: false,
                type: 'GROUP',
                absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
            },
            {
                id: '12:2',
                name: 'icon_reward',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
            },
        ],
    });
    const rootMess = node({
        name: 'img_root_bg',
        children: [{
            id: '12:3',
            name: 'Group 91',
            type: 'GROUP',
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        }],
    });
    const scroll = node({
        name: 'list_rewards',
        overflowDirection: 'VERTICAL_SCROLLING',
        children: [{
            id: '12:4',
            name: 'Group 91',
            type: 'GROUP',
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        }],
    });

    assert.equal(shouldRenderMessySubtree(hiddenNoise, false), false);
    assert.equal(shouldRenderMessySubtree(rootMess, true), false);
    assert.equal(shouldRenderMessySubtree(scroll, false), false);
    assert.equal(analyzeTree([rootMess])[0].action, 'generate');
});

test('warns when Figma auto-wrapping cannot be reproduced by Label NONE', () => {
    const [automatic] = analyzeTree([node({
        type: 'TEXT',
        characters: '这段文字没有手动换行',
        absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 44 },
        style: { fontSize: 16, lineHeightPx: 18, textAutoResize: 'HEIGHT' },
    })]);
    const [explicit] = analyzeTree([node({
        type: 'TEXT',
        characters: '第一行\n第二行',
        absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 44 },
        style: { fontSize: 16, lineHeightPx: 18, textAutoResize: 'HEIGHT' },
    })]);

    assert.match(automatic.warning, /NONE.*手动换行/);
    assert.equal(explicit.warning, undefined);
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

test('automatically renders parents containing three or nine Rectangle-named children as one PNG', () => {
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
        assert.equal(inferAction(candidate), 'render');
        assert.equal(isPatchCandidate(candidate), true);
        const [tree] = analyzeTree([candidate]);
        assert.equal(tree.action, 'render');
        assert.equal(tree.renderSubtree, true);
        assert.match(tree.warning, /PNG 整层/);
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

test('keeps hidden named three- and nine-slice groups ignored', () => {
    for (const count of [3, 9]) {
        const candidate = node({
            visible: false,
            children: Array.from({ length: count }, (_, index) => ({
                id: `hidden-${count}:${index}`,
                name: index === 0 ? 'Rectangle' : `Rectangle ${index}`,
                type: 'RECTANGLE',
                absoluteBoundingBox: { x: index * 10, y: 0, width: 10, height: 10 },
            })),
        });
        const [tree] = analyzeTree([candidate]);

        assert.equal(isNamedSliceGroup(candidate), true);
        assert.equal(inferAction(candidate), 'ignore');
        assert.equal(tree.action, 'ignore');
        assert.equal(tree.renderSubtree, false);
        assert.equal(tree.warning, undefined);
    }
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
