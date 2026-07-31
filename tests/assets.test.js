'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AssetWriter,
    hasSlicedBorders,
    sanitizeAssetName,
} = require('../dist/importer/assets');

test('keeps readable Figma node names in imported asset URLs', () => {
    const writer = new AssetWriter('figma-importer');

    assert.equal(
        writer.buildUrl('我的红包', '15:193', 'png', 1),
        'db://assets/figma-importer/我的红包.png',
    );
    assert.equal(
        writer.buildUrl('Player Title.png', '15:194', 'png', 2),
        'db://assets/figma-importer/Player Title.png',
    );
    assert.equal(sanitizeAssetName('按钮/关闭:普通'), '按钮_关闭_普通');
});

test('maps duplicate node names to the same first-imported asset URL', () => {
    const writer = new AssetWriter('figma-importer');

    assert.equal(
        writer.buildUrl('Rectangle', '15:193', 'png', 1),
        writer.buildUrl('Rectangle', '99:42', 'png', 4),
    );
    assert.equal(
        writer.buildUrl('玩家五个字', '15:193', 'png', 1),
        'db://assets/figma-importer/玩家五个字.png',
    );
});

test('detects three- and nine-slice borders from an existing Cocos SpriteFrame', () => {
    const meta = {
        uuid: 'texture',
        subMetas: {
            spriteFrame: {
                importer: 'sprite-frame',
                uuid: 'sprite-frame',
                userData: {
                    borderLeft: 12,
                    borderRight: 8,
                    borderTop: 0,
                    borderBottom: 0,
                },
            },
        },
    };
    assert.equal(hasSlicedBorders(meta), true);
    assert.equal(hasSlicedBorders({
        ...meta,
        subMetas: {
            spriteFrame: {
                ...meta.subMetas.spriteFrame,
                userData: {
                    borderLeft: 0,
                    borderRight: 0,
                    borderTop: 0,
                    borderBottom: 0,
                },
            },
        },
    }), false);
});
