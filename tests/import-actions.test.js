'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    blocksDescendants,
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} = require('../dist/import-actions');
const {
    actionOptionsForNode,
    effectiveKindForNode,
    kindOptionsForAction,
    rerenderPreservingScroll,
    resolveEffectiveActions,
    smartActionForNode,
    strategySummaryForNode,
} = require('../dist/panels/default/model');

function treeNode(overrides = {}) {
    return {
        id: overrides.id ?? '1:1',
        name: overrides.name ?? 'img_reward_bg',
        type: overrides.type ?? 'FRAME',
        visible: true,
        width: 100,
        height: 80,
        action: overrides.action ?? 'generate',
        kind: overrides.kind ?? 'node',
        renderSubtree: overrides.renderSubtree ?? false,
        patchCandidate: false,
        reason: overrides.reason,
        fold: overrides.fold,
        absorbedNodeIds: overrides.absorbedNodeIds,
        warning: overrides.warning,
        children: overrides.children ?? [],
    };
}

test('normalizes legacy merge and svg actions to the single PNG render action', () => {
    assert.equal(normalizeImportAction('merge'), 'render');
    assert.equal(normalizeImportAction('svg'), 'render');
    assert.equal(normalizeImportAction('render'), 'render');
    assert.equal(normalizeImportAction('unknown'), 'generate');
    assert.equal(isTerminalAction('merge'), true);
    assert.equal(isTerminalAction('render'), true);
    assert.equal(isTerminalAction('generate'), false);
    assert.equal(blocksDescendants('ignore'), true);
    assert.equal(blocksDescendants('generate'), false);
    assert.equal(kindForImportAction('scrollView', 'render'), 'sprite');
    assert.equal(kindForImportAction('layout', 'render'), 'sprite');
    assert.equal(kindForImportAction('button', 'render'), 'button');
});

test('keeps the node-list scroll position while strategy changes rerender the tree', () => {
    const tree = { scrollTop: 360, scrollLeft: 18 };

    rerenderPreservingScroll(tree, () => {
        tree.scrollTop = 0;
        tree.scrollLeft = 0;
    });
    assert.deepEqual(tree, { scrollTop: 360, scrollLeft: 18 });

    rerenderPreservingScroll(tree, () => {
        tree.scrollTop = 120;
        tree.scrollLeft = 6;
    }, true);
    assert.deepEqual(tree, { scrollTop: 0, scrollLeft: 0 });
});

test('smart mode preserves only explicitly recommended container PNG subtrees', () => {
    const child = treeNode({ id: '1:2', name: 'Group 91' });
    assert.equal(smartActionForNode(treeNode({
        action: 'render',
        renderSubtree: true,
        children: [child],
    })), 'render');
    assert.equal(smartActionForNode(treeNode({
        action: 'render',
        renderSubtree: false,
        children: [child],
    })), 'generate');
    assert.equal(smartActionForNode(treeNode({
        action: 'merge',
        children: [child],
    })), 'render');
});

test('panel exposes PNG whole-layer without a duplicate merge-subtree option', () => {
    const containerOptions = actionOptionsForNode(treeNode());
    assert.deepEqual(containerOptions.map(([value]) => value), [
        'ignore',
        'generate',
        'render',
        'transform',
    ]);
    assert.equal(containerOptions.find(([value]) => value === 'render')[1], 'PNG 整层');

    const vectorOptions = actionOptionsForNode(treeNode({ type: 'ELLIPSE' }));
    assert.equal(vectorOptions.find(([value]) => value === 'render')[1], 'PNG Sprite');

    const autoButton = treeNode({ name: 'common_btn_close', kind: 'button' });
    assert.equal(effectiveKindForNode(autoButton, 'auto', 'render'), 'button');
    assert.equal(effectiveKindForNode(autoButton, 'auto', 'generate'), 'button');
});

test('panel exposes RichText only for editable node actions', () => {
    const editableKinds = kindOptionsForAction('generate');
    assert.ok(editableKinds.some(([value, label]) => value === 'richText' && label === 'RichText'));
    assert.equal(kindOptionsForAction('render').some(([value]) => value === 'richText'), false);
});

test('builds visible strategy and separate warning summaries for folded nodes', () => {
    const summary = strategySummaryForNode(treeNode({
        reason: 'background-promotion',
        fold: 'background',
        absorbedNodeIds: ['1:2', '1:3'],
        warning: '背景含有不支持的混合模式',
    }));

    assert.match(summary.strategy, /背景可提升到父节点/);
    assert.match(summary.strategy, /提升背景子层/);
    assert.match(summary.strategy, /吸收 2 个子层/);
    assert.equal(summary.warning, '背景含有不支持的混合模式');

    assert.deepEqual(strategySummaryForNode(treeNode({
        reason: 'single-image-fold',
        fold: 'single-image',
        absorbedNodeIds: ['1:2'],
    }), true), {
        strategy: '用户显式覆盖',
        warning: undefined,
    });

    assert.deepEqual(strategySummaryForNode(treeNode()), {
        strategy: undefined,
        warning: undefined,
    });
});

test('restores nested PNG boundaries and keeps their descendants suppressed', () => {
    const leaf = treeNode({ id: '1:3', name: 'Ellipse 5', type: 'ELLIPSE' });
    const inner = treeNode({
        id: '1:2',
        name: 'img_reward_icon',
        action: 'render',
        renderSubtree: true,
        children: [leaf],
    });
    const outer = treeNode({
        id: '1:1',
        name: 'img_reward_panel',
        action: 'render',
        renderSubtree: true,
        children: [inner],
    });
    const preferred = new Map([
        [outer.id, 'render'],
        [inner.id, 'render'],
        [leaf.id, 'render'],
    ]);

    let effective = resolveEffectiveActions([outer], preferred);
    assert.equal(effective.actions.get(inner.id), 'ignore');
    assert.equal(effective.actions.get(leaf.id), 'ignore');

    preferred.set(outer.id, 'generate');
    effective = resolveEffectiveActions([outer], preferred);
    assert.equal(effective.actions.get(outer.id), 'generate');
    assert.equal(effective.actions.get(inner.id), 'render');
    assert.equal(effective.actions.get(leaf.id), 'ignore');
    assert.equal(effective.suppressed.has(inner.id), false);
    assert.equal(effective.suppressed.has(leaf.id), true);

    const patched = resolveEffectiveActions(
        [outer],
        new Map([
            [outer.id, 'generate'],
            [inner.id, 'generate'],
            [leaf.id, 'render'],
        ]),
        new Set([outer.id]),
    );
    assert.equal(patched.actions.get(outer.id), 'render');
    assert.equal(patched.actions.get(inner.id), 'ignore');
    assert.equal(patched.actions.get(leaf.id), 'ignore');

    const ignored = resolveEffectiveActions(
        [outer],
        new Map([
            [outer.id, 'ignore'],
            [inner.id, 'generate'],
            [leaf.id, 'render'],
        ]),
    );
    assert.equal(ignored.actions.get(outer.id), 'ignore');
    assert.equal(ignored.actions.get(inner.id), 'ignore');
    assert.equal(ignored.actions.get(leaf.id), 'ignore');
});
