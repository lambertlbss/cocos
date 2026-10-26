'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSectionFrames, frameSourceUrl, frameDocument, assertBatchTargets } = require('../dist/batch-import');
const { parseNode, parseDocument } = require('../dist/figma/parser');
const { parseFigmaSource } = require('../dist/figma/url');

const source = 'https://www.figma.com/design/FileKey123456/UI?node-id=1-1&t=token';
const rawFrame = (id, name, children = [], extra = {}) => ({ id, name, type: 'FRAME', children, ...extra });

test('section discovery keeps Figma order and stops at outer frames', () => {
    const section = parseNode({ id: '1:1', name: 'Screens', type: 'SECTION', children: [
        rawFrame('2:1', 'Home', [rawFrame('2:2', 'Button')]),
        { id: '3:1', type: 'SECTION', children: [
            { id: '3:2', type: 'GROUP', children: [rawFrame('3:3', 'Bag')] },
            rawFrame('4:1', 'Shop'),
        ] },
        rawFrame('2:1', 'Duplicate Home'),
    ] });
    const original = JSON.stringify(section);
    assert.deepEqual(collectSectionFrames(section).map((frame) => frame.name), ['Home', 'Bag', 'Shop']);
    assert.equal(JSON.stringify(section), original);
});

test('section discovery includes hidden screens and excludes component, instance, and other descendants', () => {
    const section = parseNode({ id: '1:1', type: 'SECTION', children: [
        rawFrame('2:1', 'Hidden', [], { visible: false }),
        { id: '3:1', type: 'COMPONENT', children: [rawFrame('3:2', 'Component internals')] },
        { id: '4:1', type: 'INSTANCE', children: [rawFrame('4:2', 'Instance internals')] },
        { id: '5:1', type: 'COMPONENT_SET', children: [rawFrame('5:2', 'Variants')] },
        { id: '6:1', type: 'CANVAS', children: [rawFrame('6:2', 'Not in a section or group')] },
        { id: '7:1', type: 'GROUP', visible: false, children: [rawFrame('7:2', 'Hidden group screen')] },
    ] });
    assert.deepEqual(collectSectionFrames(section).map((frame) => frame.id), ['2:1', '7:2']);
    assert.equal(collectSectionFrames(section)[0].visible, false);
    assert.equal(collectSectionFrames(section)[1].visible, false, 'hidden Group visibility survives frame extraction');
});

test('nested hidden Section and Group ancestors become inactive frame roots without mutating the source', () => {
    const section = parseNode({ id: 'outer', type: 'SECTION', children: [
        { id: 'hidden-section', type: 'SECTION', visible: false, children: [
            { id: 'visible-group', type: 'GROUP', visible: true, children: [
                rawFrame('nested-frame', 'Nested', [rawFrame('layout', 'Layout')]),
            ] },
        ] },
        rawFrame('visible-frame', 'Visible'),
    ] });
    const original = JSON.stringify(section);
    const originalFrame = section.children[0].children[0].children[0];
    const extracted = collectSectionFrames(section);
    assert.deepEqual(extracted.map(frame => [frame.id, frame.visible]), [['nested-frame', false], ['visible-frame', true]]);
    assert.notEqual(extracted[0], originalFrame, 'inherited visibility belongs to a derived frame root');
    assert.equal(extracted[0].children, originalFrame.children, 'the original subtree and IDs are retained');
    assert.equal(extracted[1], section.children[1], 'visible frames need no clone');
    assert.equal(JSON.stringify(section), original);
});

test('an extracted hidden-ancestor frame session retains its source identity and inactive tree state', () => {
    const section = { id: 'hidden-root', type: 'SECTION', visible: false, children: [
        rawFrame('screen', 'Hidden screen', [{ id: 'title', type: 'TEXT', style: { fontFamily: 'Inter' } }]),
    ] };
    const document = parseDocument({ name: 'UI', nodes: { 'hidden-root': { document: section } } },
        source, 'FileKey123456', 'hidden-root');
    const original = JSON.stringify({ roots: document.roots, tree: document.tree });
    const [frame] = collectSectionFrames(document.roots[0]);
    const session = frameDocument(document, frame);
    assert.equal(session.sourceNodeId, 'screen');
    assert.equal(parseFigmaSource(session.sourceUrl).nodeId, 'screen');
    assert.equal(session.roots[0].visible, false);
    assert.equal(session.tree[0].visible, false);
    assert.match(session.tree[0].warning, /隐藏.*Inactive/);
    assert.deepEqual([...session.nodeById.keys()], ['screen', 'title']);
    assert.equal(document.nodeById.get('screen').visible, true);
    assert.equal(JSON.stringify({ roots: document.roots, tree: document.tree }), original);
});

test('a section screen and a directly linked frame have equivalent source identity', () => {
    const sectionFrameUrl = frameSourceUrl(source, '2:3');
    const directFrameUrl = frameSourceUrl('https://www.figma.com/design/FileKey123456/UI?node-id=2-3&t=token', '2:3');
    assert.equal(sectionFrameUrl, directFrameUrl);
    assert.deepEqual(parseFigmaSource(sectionFrameUrl), { fileKey: 'FileKey123456', nodeId: '2:3' });
    const url = new URL(sectionFrameUrl);
    assert.equal(url.hostname, 'www.figma.com');
    assert.equal(url.pathname, '/design/FileKey123456/UI');
    assert.equal(url.searchParams.get('t'), 'token');
    assert.equal(url.searchParams.getAll('node-id').length, 1);
    assert.deepEqual(parseFigmaSource(frameSourceUrl('FileKey123456', '2:3')),
        { fileKey: 'FileKey123456', nodeId: '2:3' });
    assert.notEqual(parseFigmaSource(frameSourceUrl(source, '2:3')).fileKey,
        parseFigmaSource(frameSourceUrl(source.replace('FileKey123456', 'AnotherFile12345'), '2:3')).fileKey);
});

test('frame sessions isolate subtree, tree analysis, fonts, and frame source', () => {
    const section = { id: '1:1', type: 'SECTION', children: [
        rawFrame('2:1', 'Home', [
            { id: '2:2', type: 'TEXT', style: { fontFamily: 'Inter' } },
            { id: '2:3', type: 'TEXT', style: { fontFamily: 'Arial' } },
            { id: '2:4', type: 'TEXT', style: { fontFamily: 'Inter' } },
        ]),
        rawFrame('3:1', 'Bag', [{ id: '3:2', type: 'TEXT', style: { fontFamily: 'Other' } }]),
    ] };
    const document = parseDocument({ name: 'UI', nodes: { '1:1': { document: section } } }, source, 'FileKey123456', '1:1');
    const original = JSON.stringify({ roots: document.roots, tree: document.tree, fonts: document.fonts });
    const home = frameDocument(document, document.nodeById.get('2:1'));
    const bag = frameDocument(document, document.nodeById.get('3:1'));
    assert.deepEqual(home.roots.map((frame) => frame.id), ['2:1']);
    assert.deepEqual([...home.nodeById.keys()], ['2:1', '2:2', '2:3', '2:4']);
    assert.deepEqual(home.fonts, ['Arial', 'Inter']);
    assert.deepEqual(bag.fonts, ['Other']);
    assert.equal(home.sourceNodeId, '2:1');
    assert.equal(parseFigmaSource(home.sourceUrl).nodeId, '2:1');
    assert.equal(home.fileKey, document.fileKey);
    assert.equal(home.fileName, document.fileName);
    assert.equal(home.tree[0].id, '2:1');
    assert.equal(home.tree[0].action, 'generate');
    assert.equal(JSON.stringify({ roots: document.roots, tree: document.tree, fonts: document.fonts }), original);
    home.tree[0].name = 'Edited tree';
    assert.notEqual(document.tree[0].name, 'Edited tree');
});

test('batch targets reject missing selections or identity without leaking identifiers', () => {
    assert.throws(() => assertBatchTargets([]), /至少选择/);
    assert.throws(() => assertBatchTargets([{ id: ' ', name: 'Home' }]), /Home.*缺少界面标识/);
    const secretId = 'FileKey123456:2:1';
    assert.throws(() => assertBatchTargets([{ id: secretId, name: 'Home' }, { id: secretId, name: 'Bag' }]), (error) => {
        assert.match(error.message, /Home.*Bag.*重复/);
        assert.equal(error.message.includes(secretId), false);
        return true;
    });
    assert.doesNotThrow(() => assertBatchTargets([{ id: 'file-a:2:1', name: 'Home' }, { id: 'file-b:2:1', name: 'Bag' }]));
});

test('batch target collision checks use sanitized names, Unicode, Windows casing, truncation, and trailing dots', () => {
    for (const [left, right] of [
        ['Home', 'home'], [' Home. ', 'Home'], ['按钮/关闭', '按钮:关闭'],
        ['Ｈｏｍｅ', 'Home'], ['a'.repeat(72) + 'one', 'a'.repeat(72) + 'two'],
        ['a'.repeat(71) + '.x', 'a'.repeat(71)],
    ]) {
        assert.throws(() => assertBatchTargets([{ id: 'left', name: left }, { id: 'right', name: right }]), /输出名称冲突/);
    }
});

test('batch target names reject empty, illegal-only, and Windows device names', () => {
    for (const name of ['', ' ', '...', '\t', '<>:"/\\|?*#%', 'CON', 'con.txt', 'AUX', 'NUL', 'PRN', 'COM1', 'lpt9', 'ＣＯＮ', 'COM¹']) {
        assert.throws(() => assertBatchTargets([{ id: 'screen', name }]), /名称无效|系统保留名称/);
    }
    assert.doesNotThrow(() => assertBatchTargets([{ id: 'home', name: '主页' }, { id: 'shop', name: 'CONSOLE' }, { id: 'bag', name: 'COM10' }]));
});
