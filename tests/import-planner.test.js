'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAction, inferKind } = require('../dist/figma/analyzer');
const {
    annotateTreeWithImportPlan,
    compileImportPlan,
    importPlanReasonText,
    semanticRoleForNode,
} = require('../dist/figma/import-planner');
const { parseNode } = require('../dist/figma/parser');
const { makeSpec, subtreeHasExplicitOverride } = require('../dist/main');

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

function decisionsFor(roots, explicit = {}) {
    const result = new Map();
    const visit = (item) => {
        result.set(item.id, {
            action: inferAction(item),
            kind: inferKind(item),
            nineSlice: false,
            explicit: false,
            ...(explicit[item.id] ?? {}),
        });
        item.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

function planForChild(child, explicit = {}) {
    const root = node({
        id: `root:${child.id}`,
        name: 'PopupRoot',
        absoluteBoundingBox: { x: 0, y: 0, width: 640, height: 1136 },
        children: [child],
    });
    return compileImportPlan([root], decisionsFor([root], explicit)).get(child.id);
}

function indexNodes(roots) {
    const result = new Map();
    const visit = (item) => {
        result.set(item.id, item);
        item.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

function slicedChild(id, name, frame = { x: 0, y: 0, width: 100, height: 100 }) {
    return {
        id,
        name,
        type: 'FRAME',
        absoluteBoundingBox: frame,
        children: Array.from({ length: 9 }, (_, index) => ({
            id: `${id}:${index}`,
            name: index === 0 ? 'Rectangle' : `Rectangle ${index}`,
            type: 'RECTANGLE',
            absoluteBoundingBox: {
                x: frame.x + (index % 3) * frame.width / 3,
                y: frame.y + Math.floor(index / 3) * frame.height / 3,
                width: frame.width / 3,
                height: frame.height / 3,
            },
        })),
    };
}

test('classifies stable project naming roles', () => {
    assert.equal(semanticRoleForNode({ name: 'panel_view' }), 'panel');
    assert.equal(semanticRoleForNode({ name: 'btn_sure' }), 'button');
    assert.equal(semanticRoleForNode({ name: 'img_bg' }), 'image');
    assert.equal(semanticRoleForNode({ name: 'txt_title' }), 'text');
    assert.equal(semanticRoleForNode({ name: 'view' }), 'view');
    assert.equal(semanticRoleForNode({ name: 'content' }), 'content');
    assert.equal(semanticRoleForNode({ name: 'anything' }, true), 'root');
});

test('folds one sliced image child into its img parent and aliases the full source subtree', () => {
    const image = node({
        id: '2:0',
        name: 'img_bg',
        children: [slicedChild('2:1', 'img_bj_xiaotc_a')],
    });
    const plan = planForChild(image);

    assert.equal(plan.fold.kind, 'single-image');
    assert.equal(plan.fold.sourceNodeId, '2:1');
    assert.equal(plan.kind, 'sprite');
    assert.equal(plan.reason, 'single-image-fold');
    assert.equal(plan.fold.absorbedNodeIds.length, 10);
});

test('keeps a renamed child as an independent Cocos node instead of folding it away', () => {
    const image = node({
        id: '2:rename-parent',
        name: 'img_bg',
        children: [slicedChild('2:rename-child', 'img_bj_xiaotc_a')],
    });
    const root = node({
        id: '2:rename-root',
        name: 'PopupRoot',
        children: [image],
    });
    const decisions = decisionsFor([root], {
        '2:rename-child': { name: 'img_custom_bg', explicit: false },
    });
    const plan = compileImportPlan([root], decisions).get(image.id);

    assert.equal(plan.fold, undefined);
    assert.equal(subtreeHasExplicitOverride(image, decisions), true);
});

test('writes a custom name into SceneNodeSpec without changing the original Figma node', () => {
    const root = node({ id: 'name:root', name: 'OriginalFrame' });
    const decisions = decisionsFor([root], {
        'name:root': { name: 'PopupGuildPacket', explicit: false },
    });
    const plans = compileImportPlan([root], decisions);
    const spec = makeSpec(
        root,
        root.absoluteBoundingBox,
        decisions,
        plans,
        indexNodes([root]),
        new Map(),
        new Map(),
    );

    assert.equal(spec.name, 'PopupGuildPacket');
    assert.equal(root.name, 'OriginalFrame');
});

test('keeps hidden containers and their descendants in Scene specs with inactive state', () => {
    const hiddenPanel = node({
        id: 'hidden:panel',
        name: 'panel_hidden',
        visible: false,
        children: [{
            id: 'hidden:text',
            name: 'txt_title',
            type: 'TEXT',
            visible: true,
            characters: '稍后显示',
            absoluteBoundingBox: { x: 20, y: 20, width: 100, height: 24 },
        }],
    });
    const root = node({
        id: 'hidden:root',
        name: 'PopupRoot',
        children: [hiddenPanel],
    });
    const decisions = decisionsFor([root]);
    const plans = compileImportPlan([root], decisions);
    const spec = makeSpec(
        root,
        root.absoluteBoundingBox,
        decisions,
        plans,
        indexNodes([root]),
        new Map(),
        new Map(),
        true,
    );

    assert.equal(plans.get(hiddenPanel.id).reason, 'semantic-container');
    assert.equal(spec.children.length, 1);
    assert.equal(spec.children[0].visible, false);
    assert.equal(spec.children[0].children.length, 1);
    assert.equal(spec.children[0].children[0].visible, true);
    assert.equal(spec.children[0].children[0].kind, 'label');
});

test('does not fold a hidden visual source into a visible host', () => {
    const image = node({
        id: 'hidden-fold:host',
        name: 'img_reward',
        children: [{
            ...slicedChild('hidden-fold:source', 'common_reward'),
            visible: false,
        }],
    });
    const plan = planForChild(image);

    assert.equal(plan.fold, undefined);
});

test('folds one geometrically equivalent TEXT child into its txt parent', () => {
    const text = node({
        id: '3:0',
        name: 'txt_title',
        absoluteBoundingBox: { x: 10, y: 10, width: 108, height: 42 },
        children: [{
            id: '3:1',
            name: '规则详情',
            type: 'TEXT',
            characters: '规则详情',
            absoluteBoundingBox: { x: 10, y: 10, width: 108, height: 42 },
        }],
    });
    const plan = planForChild(text);

    assert.equal(plan.fold.kind, 'single-text');
    assert.equal(plan.kind, 'label');
    assert.deepEqual(plan.fold.absorbedNodeIds, ['3:1']);
});

test('promotes a full-size first background onto a button and retains other children', () => {
    const buttonNode = node({
        id: '4:0',
        name: 'btn_sure',
        absoluteBoundingBox: { x: 0, y: 0, width: 170, height: 60 },
        children: [
            slicedChild('4:1', 'common_btn_tyanniu_01', { x: 0, y: 0, width: 170, height: 60 }),
            {
                id: '4:2',
                name: 'txt_btns_0',
                type: 'FRAME',
                absoluteBoundingBox: { x: 30, y: 14, width: 110, height: 32 },
                children: [{
                    id: '4:3',
                    name: '确定',
                    type: 'TEXT',
                    characters: '确定',
                    absoluteBoundingBox: { x: 30, y: 14, width: 110, height: 32 },
                }],
            },
        ],
    });
    const outer = node({
        id: '4:root',
        name: 'PopupRoot',
        absoluteBoundingBox: { x: 0, y: 0, width: 640, height: 1136 },
        children: [buttonNode],
    });
    const plans = compileImportPlan([outer], decisionsFor([outer]));
    const button = plans.get(buttonNode.id);
    const label = plans.get('4:2');

    assert.equal(button.fold.kind, 'background');
    assert.equal(button.kind, 'button');
    assert.equal(button.fold.sourceNodeId, '4:1');
    assert.equal(label.fold.kind, 'single-text');
});

test('builds folded SceneNodeSpecs from the same plan and child resource references', () => {
    const buttonNode = node({
        id: 'spec:button',
        name: 'btn_sure',
        absoluteBoundingBox: { x: 20, y: 30, width: 170, height: 60 },
        children: [
            slicedChild(
                'spec:bg',
                'common_btn_tyanniu_01',
                { x: 20, y: 30, width: 170, height: 60 },
            ),
            {
                id: 'spec:txt-wrapper',
                name: 'txt_btns_0',
                type: 'FRAME',
                absoluteBoundingBox: { x: 50, y: 44, width: 110, height: 32 },
                children: [{
                    id: 'spec:text',
                    name: '确定',
                    type: 'TEXT',
                    characters: '确定',
                    style: { fontFamily: 'Game Font', fontSize: 22, lineHeightPx: 28 },
                    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
                    absoluteBoundingBox: { x: 50, y: 44, width: 110, height: 32 },
                }],
            },
        ],
    });
    const root = node({
        id: 'spec:root',
        name: 'PopupRoot',
        absoluteBoundingBox: { x: 0, y: 0, width: 640, height: 1136 },
        children: [buttonNode],
    });
    const decisions = decisionsFor([root]);
    const plans = compileImportPlan([root], decisions);
    const asset = { uuid: 'button-frame', url: 'db://assets/button.png', sliced: true };
    const spec = makeSpec(
        buttonNode,
        root.absoluteBoundingBox,
        decisions,
        plans,
        indexNodes([root]),
        new Map([['spec:bg', asset]]),
        new Map([['Game Font', 'font-uuid']]),
    );

    assert.equal(spec.name, 'btn_sure');
    assert.equal(spec.kind, 'button');
    assert.equal(spec.sprite, asset);
    assert.equal(spec.flattenBoundary, false);
    assert.ok(spec.aliasFigmaIds.includes('spec:bg'));
    assert.equal(spec.children.length, 1);
    assert.equal(spec.children[0].name, 'txt_btns_0');
    assert.equal(spec.children[0].kind, 'label');
    assert.equal(spec.children[0].characters, '确定');
    assert.equal(spec.children[0].fontUuid, 'font-uuid');
    assert.equal(spec.children[0].children.length, 0);
    assert.equal(spec.children[0].flattenBoundary, true);
    assert.deepEqual(spec.children[0].aliasFigmaIds, ['spec:text']);
});

test('preserves the folded image source type and composed opacity', () => {
    const image = node({
        id: 'spec:image',
        name: 'img_avatar',
        opacity: 0.8,
        children: [{
            id: 'spec:ellipse',
            name: 'avatar_pattern',
            type: 'ELLIPSE',
            opacity: 0.5,
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            fills: [{
                type: 'IMAGE',
                scaleMode: 'TILE',
                imageRef: 'avatar-image',
            }],
        }],
    });
    const root = node({
        id: 'spec:image-root',
        name: 'PopupRoot',
        children: [image],
    });
    const decisions = decisionsFor([root]);
    const plans = compileImportPlan([root], decisions);
    const asset = {
        uuid: 'avatar-frame',
        url: 'db://assets/avatar.png',
        tiled: true,
    };
    const spec = makeSpec(
        image,
        root.absoluteBoundingBox,
        decisions,
        plans,
        indexNodes([root]),
        new Map([['spec:ellipse', asset]]),
        new Map(),
    );

    assert.equal(spec.figmaType, 'ELLIPSE');
    assert.equal(spec.opacity, 0.4);
    assert.equal(spec.sprite, asset);
});

test('does not fold when transforms, parent visuals, runtime behavior, or manual overrides conflict', () => {
    const cases = [
        node({
            id: 'guard:visual',
            name: 'img_visual',
            fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
            children: [slicedChild('guard:visual:child', 'asset')],
        }),
        node({
            id: 'guard:clip',
            name: 'img_clip',
            clipsContent: true,
            children: [slicedChild('guard:clip:child', 'asset')],
        }),
        node({
            id: 'guard:bounds',
            name: 'img_bounds',
            children: [slicedChild(
                'guard:bounds:child',
                'asset',
                { x: 0.5, y: 0, width: 99.5, height: 100 },
            )],
        }),
        node({
            id: 'guard:transform',
            name: 'img_transform',
            relativeTransform: [[1, 0, 0], [0, 1, 0]],
            children: [{
                ...slicedChild('guard:transform:child', 'asset'),
                relativeTransform: [[-1, 0, 100], [0, 1, 0]],
            }],
        }),
    ];
    for (const child of cases) {
        assert.equal(planForChild(child).fold, undefined);
    }

    const explicitRoot = node({
        id: 'guard:explicit',
        name: 'txt_title',
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 30 },
        children: [{
            id: 'guard:explicit:text',
            name: 'title',
            type: 'TEXT',
            characters: 'title',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 30 },
        }],
    });
    assert.equal(planForChild(explicitRoot, {
        'guard:explicit': { explicit: true },
    }).fold, undefined);

    const paddedText = node({
        id: 'guard:padded-text',
        name: 'txt_padded',
        children: [{
            id: 'guard:padded-text:child',
            name: 'title',
            type: 'TEXT',
            characters: 'title',
            absoluteBoundingBox: { x: 10, y: 5, width: 80, height: 30 },
        }],
    });
    assert.equal(planForChild(paddedText).fold, undefined);

    const unknownTextBounds = node({
        id: 'guard:unknown-text',
        name: 'txt_unknown',
        children: [{
            id: 'guard:unknown-text:child',
            name: 'title',
            type: 'TEXT',
            characters: 'title',
        }],
    });
    assert.equal(planForChild(unknownTextBounds).fold, undefined);

    const slicedWithExplicitDescendant = node({
        id: 'guard:descendant',
        name: 'img_descendant',
        children: [slicedChild('guard:descendant:child', 'asset')],
    });
    assert.equal(planForChild(slicedWithExplicitDescendant, {
        'guard:descendant:child:4': { explicit: true, action: 'ignore' },
    }).fold, undefined);

    const buttonWithProtectedBackground = node({
        id: 'guard:button',
        name: 'btn_guard',
        children: [
            slicedChild('guard:button:bg', 'asset'),
            {
                id: 'guard:button:label',
                name: 'txt_label',
                type: 'TEXT',
                characters: '确定',
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            },
        ],
    });
    assert.equal(planForChild(buttonWithProtectedBackground, {
        'guard:button:bg:2': { explicit: true, action: 'ignore' },
    }).fold, undefined);

    const translucentButtonBackground = node({
        id: 'guard:button-opacity',
        name: 'btn_opacity',
        children: [
            {
                ...slicedChild('guard:button-opacity:bg', 'asset'),
                opacity: 0.5,
            },
            {
                id: 'guard:button-opacity:label',
                name: 'txt_label',
                type: 'TEXT',
                characters: '确定',
                absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
            },
        ],
    });
    assert.equal(planForChild(translucentButtonBackground).fold, undefined);

    const explicitRichText = planForChild(explicitRoot, {
        'guard:explicit': { explicit: true, kind: 'richText' },
    });
    assert.equal(explicitRichText.fold.kind, 'single-text');
    assert.equal(explicitRichText.kind, 'richText');
});

test('keeps panel_view as a semantic container and exposes a visible strategy reason', () => {
    const root = node({
        name: 'PopupInstructionView',
        children: [{
            id: '5:1',
            name: 'panel_view',
            type: 'FRAME',
            absoluteBoundingBox: { x: 0, y: 0, width: 530, height: 388 },
            children: [{
                id: '5:2',
                name: 'Ellipse 1',
                type: 'ELLIPSE',
                absoluteBoundingBox: { x: 20, y: 80, width: 163, height: 154 },
            }],
        }],
    });
    const decisions = decisionsFor([root]);
    const plans = compileImportPlan([root], decisions);
    const panel = plans.get('5:1');

    assert.equal(panel.fold, undefined);
    assert.equal(panel.reason, 'semantic-container');
    assert.equal(importPlanReasonText(panel.reason), '保留 Cocos 运行时语义容器');

    const tree = [{
        id: root.id,
        name: root.name,
        type: root.type,
        visible: true,
        width: 100,
        height: 100,
        action: 'generate',
        kind: 'node',
        patchCandidate: false,
        children: [{
            id: '5:1',
            name: 'panel_view',
            type: 'FRAME',
            visible: true,
            width: 530,
            height: 388,
            action: 'generate',
            kind: 'node',
            patchCandidate: false,
            children: [],
        }],
    }];
    assert.equal(annotateTreeWithImportPlan(tree, plans)[0].children[0].reason, 'semantic-container');
});

test('protects descendant overrides from local same-name parent promotion', () => {
    const parent = node({
        id: 'local:parent',
        name: 'img_local_parent',
        children: [slicedChild('local:child', 'asset')],
    });
    const decisions = decisionsFor([parent], {
        'local:child:3': { explicit: true, action: 'ignore' },
    });

    assert.equal(subtreeHasExplicitOverride(parent, decisions), true);
    decisions.get('local:child:3').explicit = false;
    assert.equal(subtreeHasExplicitOverride(parent, decisions), false);
    decisions.get('local:child:3').name = 'renamed_piece';
    assert.equal(subtreeHasExplicitOverride(parent, decisions), true);
    delete decisions.get('local:child:3').name;
    decisions.get(parent.id).name = 'renamed_parent';
    assert.equal(subtreeHasExplicitOverride(parent, decisions), true);
    assert.equal(subtreeHasExplicitOverride(parent, decisions, false), false);
});
