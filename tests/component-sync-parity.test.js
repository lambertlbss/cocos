'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNode } = require('../dist/figma/parser');
const { compileImportPlan, resolveAutomaticMergeDecisions } = require('../dist/figma/import-planner');
const { applyLocalParentPromotion, makeSpec } = require('../dist/main');

const FILE_KEY = 'VxeomJZczEotAMsETIlXWl';

/**
 * 改动预检与真实导入必须产出同一棵节点计划。
 * 这里复现双方共用的两步：本地素材父层提升 + 自动折叠/收口，然后编译计划并建 Spec。
 */
function buildSpecs(roots, decisions, nodeById) {
    const resolved = resolveAutomaticMergeDecisions(roots, decisions);
    decisions.clear();
    resolved.forEach((value, key) => decisions.set(key, value));
    const plans = compileImportPlan(roots, decisions);
    return roots
        .map((node) => makeSpec(
            node,
            node.absoluteBoundingBox,
            decisions,
            plans,
            nodeById,
            new Map(),
            new Map(),
            true,
            0,
            { fileKey: FILE_KEY },
        ))
        .filter(Boolean);
}

function collectIds(specs, acc = []) {
    for (const spec of specs) {
        acc.push(spec.figmaId);
        collectIds(spec.children, acc);
    }
    return acc;
}

function scene() {
    const child = parseNode({
        id: '1:2',
        name: 'Group 91',
        type: 'RECTANGLE',
        visible: true,
        children: [],
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
        fills: [{ type: 'IMAGE', imageRef: 'ref-1', scaleMode: 'FILL' }],
    });
    const root = parseNode({
        id: '1:1',
        name: 'panel_view',
        type: 'FRAME',
        visible: true,
        children: [
            {
                id: '1:2',
                name: 'Group 91',
                type: 'RECTANGLE',
                visible: true,
                children: [],
                absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
                fills: [{ type: 'IMAGE', imageRef: 'ref-1', scaleMode: 'FILL' }],
            },
        ],
        absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
    });
    assert.ok(root && child);
    const nodeById = new Map([
        [root.id, root],
        [child.id, root.children[0]],
    ]);
    const decisions = new Map([
        [root.id, { action: 'generate', kind: 'node', nineSlice: false }],
        [root.children[0].id, { action: 'generate', kind: 'sprite', nineSlice: false }],
    ]);
    return { root, nodeById, decisions };
}

test('without a local match the child layer stays in the plan', () => {
    const { root, nodeById, decisions } = scene();
    const ids = collectIds(buildSpecs([root], decisions, nodeById));
    assert.deepEqual(ids.sort(), ['1:1', '1:2']);
});

test('with a local match the child is absorbed, so preview and import agree', async () => {
    const { root, nodeById, decisions } = scene();
    // 真实导入在 buildAssets 里、预检在 previewComponentSync 里调用同一个函数。
    await applyLocalParentPromotion(
        [root],
        decisions,
        async (node) => node.name === 'panel_view',
        () => false,
    );
    const specs = buildSpecs([root], decisions, nodeById);
    const ids = collectIds(specs);
    assert.deepEqual(ids, ['1:1'], 'absorbed child must not appear as a new node');
    assert.equal(specs[0].action, 'render');
});
