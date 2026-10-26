'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    blocksDescendants,
    isTerminalAction,
    kindForImportAction,
    isMergedResourceName,
    normalizeImportAction,
} = require('../dist/import-actions');
const {
    actionOptionsForNode,
    defaultNineSliceIds,
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
        visible: overrides.visible ?? true,
        width: 100,
        height: 80,
        action: overrides.action ?? 'generate',
        kind: overrides.kind ?? 'node',
        renderSubtree: overrides.renderSubtree ?? false,
        patchCandidate: overrides.patchCandidate ?? false,
        sliceMode: overrides.sliceMode,
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

test('recognizes only icon_ and img_ as default merge resource prefixes', () => {
    for (const name of ['icon_reward', 'IMG_reward', ' img_背景 ']) {
        assert.equal(isMergedResourceName(name), true, name);
    }
    for (const name of ['image_reward', 'bg_reward', 'my_icon_reward', 'icon', 'img_', 'img-reward']) {
        assert.equal(isMergedResourceName(name), false, name);
    }
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

test('smart mode enables every recognized three- and nine-slice candidate', () => {
    const horizontal = treeNode({
        id: 'slice:horizontal',
        patchCandidate: true,
        sliceMode: 'horizontal',
    });
    const namedOnly = treeNode({
        id: 'slice:named-only',
        patchCandidate: true,
    });
    const nine = treeNode({
        id: 'slice:nine',
        patchCandidate: true,
        sliceMode: 'nine',
    });
    const root = treeNode({
        id: 'root',
        children: [horizontal, namedOnly, nine],
    });

    assert.deepEqual(
        [...defaultNineSliceIds([root])].sort(),
        ['slice:horizontal', 'slice:named-only', 'slice:nine'],
    );
});

test('Figma slice definitions lock their own render strategy without bypassing ignore boundaries', () => {
    const leaf = treeNode({ id: 'slice:part', type: 'RECTANGLE', action: 'render' });
    const sliced = treeNode({ id: 'slice:defined', patchCandidate: true, sliceMode: 'nine', children: [leaf] });
    for (const preferred of ['generate', 'render', 'transform']) {
        assert.equal(smartActionForNode({ ...sliced, action: preferred }), 'render');
        const effective = resolveEffectiveActions([sliced], new Map([[sliced.id, preferred]]), new Set(), new Set([sliced.id]));
        assert.equal(effective.actions.get(sliced.id), 'render');
        assert.equal(effective.actions.get(leaf.id), 'ignore');
        assert.equal(effectiveKindForNode(sliced, 'layout', preferred, false), 'sprite');
        assert.equal(effectiveKindForNode(sliced, 'button', preferred, false), 'button');
    }
    assert.deepEqual(actionOptionsForNode(sliced).map(([value]) => value), ['ignore', 'render']);
    assert.match(strategySummaryForNode(sliced, true).strategy, /Figma 分片优先.*Figma 原始边界/);
    const ownIgnore = resolveEffectiveActions([sliced], new Map([[sliced.id, 'ignore']]), new Set([sliced.id]));
    assert.equal(ownIgnore.actions.get(sliced.id), 'ignore');
    const parent = treeNode({ id: 'slice:parent', children: [sliced] });
    for (const action of ['ignore', 'render']) {
        const effective = resolveEffectiveActions([parent], new Map([[parent.id, action]]), new Set([sliced.id]), new Set([parent.id]));
        assert.equal(effective.actions.get(parent.id), action);
        assert.equal(effective.actions.get(sliced.id), 'ignore');
    }
    const invalid = treeNode({ action: 'generate', patchCandidate: false });
    assert.equal(resolveEffectiveActions([invalid], new Map([[invalid.id, 'transform']])).actions.get(invalid.id), 'transform');
});

test('hidden nodes keep their normal smart actions and do not suppress generated descendants', () => {
    const child = treeNode({
        id: 'hidden:child',
        visible: false,
        type: 'TEXT',
        action: 'generate',
        kind: 'label',
    });
    const parent = treeNode({
        id: 'hidden:parent',
        visible: false,
        action: 'generate',
        children: [child],
    });

    assert.equal(smartActionForNode(parent), 'generate');
    assert.equal(smartActionForNode(child), 'generate');
    const effective = resolveEffectiveActions([parent], new Map());
    assert.equal(effective.actions.get(parent.id), 'generate');
    assert.equal(effective.actions.get(child.id), 'generate');
    assert.equal(effective.suppressed.size, 0);
});

test('excluding hidden layers overrides explicit strategies and Figma slices for the full hidden subtree', () => {
    const leaf = treeNode({ id: 'visibility:leaf', visible: true, action: 'render' });
    const hiddenSlice = treeNode({ id: 'visibility:slice', visible: false, patchCandidate: true,
        sliceMode: 'nine', children: [leaf] });
    const sibling = treeNode({ id: 'visibility:sibling', visible: true, action: 'generate' });
    const root = treeNode({ id: 'visibility:root', children: [hiddenSlice, sibling] });
    const preferred = new Map([[hiddenSlice.id, 'render'], [leaf.id, 'generate'], [sibling.id, 'generate']]);
    const forced = new Set([hiddenSlice.id]);
    const explicit = new Set([hiddenSlice.id, leaf.id]);
    const before = [...preferred];
    const effective = resolveEffectiveActions([root], preferred, forced, explicit, new Set(), false);
    assert.equal(effective.actions.get(hiddenSlice.id), 'ignore');
    assert.equal(effective.actions.get(leaf.id), 'ignore');
    assert.equal(effective.actions.get(sibling.id), 'generate');
    assert.deepEqual([...effective.suppressed], [hiddenSlice.id, leaf.id]);
    assert.deepEqual([...preferred], before, 'the setting must not overwrite saved per-node choices');
});

test('re-enabling hidden imports restores previous choices while explicit ignore still applies', () => {
    const visibleChild = treeNode({ id: 'visibility:visible-child', visible: true, action: 'generate' });
    const hidden = treeNode({ id: 'visibility:parent', visible: false, children: [visibleChild] });
    const ignored = treeNode({ id: 'visibility:ignored', visible: false, children: [] });
    const preferred = new Map([[hidden.id, 'generate'], [visibleChild.id, 'generate'], [ignored.id, 'ignore']]);
    const off = resolveEffectiveActions([hidden, ignored], preferred, new Set(), new Set(), new Set(), false);
    assert.equal(off.actions.get(hidden.id), 'ignore');
    assert.equal(off.actions.get(visibleChild.id), 'ignore');
    const on = resolveEffectiveActions([hidden, ignored], preferred, new Set(), new Set(), new Set(), true);
    assert.equal(on.actions.get(hidden.id), 'generate');
    assert.equal(on.actions.get(visibleChild.id), 'generate');
    assert.equal(on.actions.get(ignored.id), 'ignore');
    assert.equal(on.suppressed.size, 0);
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

test('panel default prefix merges match descendant override and slice protections', () => {
    const leaf = treeNode({ id: 'prefix:leaf', name: 'vector', type: 'VECTOR', action: 'render' });
    const inner = treeNode({
        id: 'prefix:inner', name: 'icon_badge', action: 'render', renderSubtree: true,
        reason: 'prefix-merge', children: [leaf],
    });
    const outer = treeNode({
        id: 'prefix:outer', name: 'img_card', action: 'render', renderSubtree: true,
        reason: 'prefix-merge', children: [inner],
    });
    const preferred = new Map([[outer.id, 'render'], [inner.id, 'generate'], [leaf.id, 'render']]);
    const automatic = resolveEffectiveActions([outer], preferred);
    assert.equal(automatic.actions.get(inner.id), 'ignore');
    assert.equal(automatic.actions.get(leaf.id), 'ignore');

    const manualChild = resolveEffectiveActions([outer], preferred, new Set(), new Set([inner.id]));
    assert.equal(manualChild.actions.get(outer.id), 'generate');
    assert.equal(manualChild.actions.get(inner.id), 'generate');
    assert.equal(manualChild.actions.get(leaf.id), 'render');
    assert.equal(manualChild.suppressed.size, 0);

    const renamedChild = resolveEffectiveActions([outer], preferred, new Set(), new Set(), new Set([inner.id]));
    assert.equal(renamedChild.actions.get(outer.id), 'generate');
    assert.equal(renamedChild.actions.get(inner.id), 'generate');
    const renamedParent = resolveEffectiveActions([outer], preferred, new Set(), new Set([inner.id]), new Set([outer.id]));
    assert.equal(renamedParent.actions.get(outer.id), 'generate', 'renaming the parent does not override its strategy');

    const manualParent = resolveEffectiveActions([outer], preferred, new Set(), new Set([outer.id, inner.id]));
    assert.equal(manualParent.actions.get(outer.id), 'render');
    assert.equal(manualParent.actions.get(inner.id), 'ignore');

    const slicedChild = resolveEffectiveActions([outer], preferred, new Set([inner.id]));
    assert.equal(slicedChild.actions.get(outer.id), 'generate');
    assert.equal(slicedChild.actions.get(inner.id), 'render');
    assert.equal(slicedChild.actions.get(leaf.id), 'ignore');

    const ownSlice = resolveEffectiveActions([outer], preferred, new Set([outer.id, inner.id]));
    assert.equal(ownSlice.actions.get(outer.id), 'render');
    assert.equal(ownSlice.actions.get(inner.id), 'ignore');
});
