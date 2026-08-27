'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const projectProfile = new Map();
global.Editor = {
    Profile: {
        async getProject(packageName, key) {
            return projectProfile.get(`${packageName}:${key}`);
        },
        async setProject(packageName, key, value) {
            projectProfile.set(`${packageName}:${key}`, value);
        },
    },
};

const { decisionMap, methods } = require('../dist/main');

test('enables recognized slice decisions by default and preserves an explicit opt-out', () => {
    const tree = [{
        id: 'slice:1',
        name: 'img_yushi_line',
        type: 'FRAME',
        visible: true,
        width: 437,
        height: 294,
        action: 'render',
        kind: 'sprite',
        renderSubtree: true,
        patchCandidate: true,
        children: [],
    }];

    assert.equal(decisionMap([], tree).get('slice:1').nineSlice, true);
    assert.equal(decisionMap([{
        id: 'slice:1',
        action: 'render',
        kind: 'sprite',
        nineSlice: false,
        explicit: true,
    }], tree).get('slice:1').nineSlice, false);
});

test('persists only explicit, sanitized node strategy overrides by Figma file key', async () => {
    const saved = await methods.saveNodeOverrides('file-key', [
        {
            id: '410:5000',
            action: 'ignore',
            kind: 'node',
            nineSlice: false,
            explicit: true,
        },
        {
            id: '410:5001',
            action: 'unknown-action',
            kind: 'unknown-kind',
            nineSlice: 1,
        },
        { action: 'render', kind: 'sprite' },
    ], ['410:5000', '410:5001']);

    assert.deepEqual(saved, [
        {
            id: '410:5000',
            action: 'ignore',
            kind: 'node',
            nineSlice: false,
            explicit: true,
        },
        {
            id: '410:5001',
            action: 'generate',
            kind: 'auto',
            nineSlice: false,
            explicit: true,
        },
    ]);
    const stored = projectProfile.get('figma-importer-cocos:nodeOverrides');
    assert.deepEqual(Object.keys(stored), ['file-key']);
    assert.equal(stored['file-key']['410:5000'].action, 'ignore');

    assert.deepEqual(await methods.saveNodeOverrides(
        'file-key',
        [],
        ['410:5000', '410:5001'],
    ), []);
    assert.deepEqual(projectProfile.get('figma-importer-cocos:nodeOverrides'), {});
});

test('replaces only the current linked-frame scope within the same Figma file', async () => {
    await methods.saveNodeOverrides('shared-file', [{
        id: 'frame-a:text',
        action: 'generate',
        kind: 'richText',
        nineSlice: false,
    }], ['frame-a', 'frame-a:text']);
    await methods.saveNodeOverrides('shared-file', [{
        id: 'frame-b:image',
        action: 'ignore',
        kind: 'sprite',
        nineSlice: false,
    }], ['frame-b', 'frame-b:image']);

    let stored = projectProfile.get('figma-importer-cocos:nodeOverrides')['shared-file'];
    assert.equal(stored['frame-a:text'].kind, 'richText');
    assert.equal(stored['frame-b:image'].action, 'ignore');

    await methods.saveNodeOverrides('shared-file', [], ['frame-b', 'frame-b:image']);
    stored = projectProfile.get('figma-importer-cocos:nodeOverrides')['shared-file'];
    assert.equal(stored['frame-a:text'].kind, 'richText');
    assert.equal(stored['frame-b:image'], undefined);
});

test('persists a sanitized rename without turning it into a strategy override', async () => {
    const saved = await methods.saveNodeOverrides('rename-file', [{
        id: '410:rename',
        name: '  btn/close\nprimary  ',
        action: 'generate',
        kind: 'auto',
        nineSlice: false,
        explicit: false,
    }], ['410:rename']);

    assert.deepEqual(saved, [{
        id: '410:rename',
        action: 'generate',
        kind: 'auto',
        nineSlice: false,
        explicit: false,
        name: 'btn close primary',
    }]);
    const stored = projectProfile.get('figma-importer-cocos:nodeOverrides');
    assert.equal(stored['rename-file']['410:rename'].name, 'btn close primary');

    assert.deepEqual(await methods.saveNodeOverrides('rename-file', [{
        id: '410:rename',
        name: ' /\\\n ',
        action: 'generate',
        kind: 'auto',
        nineSlice: false,
        explicit: false,
    }], ['410:rename']), []);
    assert.equal(projectProfile.get('figma-importer-cocos:nodeOverrides')['rename-file'], undefined);
});

test('rejects override persistence without a Figma file key', async () => {
    await assert.rejects(
        methods.saveNodeOverrides('', [], ['410:5000']),
        /fileKey/,
    );
    await assert.rejects(
        methods.saveNodeOverrides('file-key', [], []),
        /导入范围/,
    );
});
