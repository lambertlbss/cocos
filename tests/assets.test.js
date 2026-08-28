'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AssetWriter,
    detectImageExtension,
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

test('uses isolated stable asset URLs for native tile sources', () => {
    const writer = new AssetWriter('figma-importer');
    const first = writer.buildTiledUrl('Ellipse 1.png', 'source-node:410:4755:scale:1', 'png');
    const repeated = writer.buildTiledUrl('Ellipse 1.png', 'source-node:410:4755:scale:1', 'png');
    const different = writer.buildTiledUrl('Ellipse 1.png', 'source-node:999:1:scale:1', 'png');
    const otherFile = writer.buildTiledUrl('Ellipse 1.png', 'file-b:source-node:410:4755:scale:1', 'png');
    const otherScale = writer.buildTiledUrl('Ellipse 1.png', 'file-a:source-node:410:4755:scale:2', 'png');

    assert.equal(first, repeated);
    assert.notEqual(first, 'db://assets/figma-importer/Ellipse 1.png');
    assert.notEqual(first, different);
    assert.notEqual(otherFile, otherScale);
    assert.match(first, /^db:\/\/assets\/figma-importer\/Ellipse 1__tile_[0-9a-f]{10}\.png$/);
});

test('detects original image-fill formats from file signatures', () => {
    assert.equal(detectImageExtension(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])), 'png');
    assert.equal(detectImageExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
    assert.equal(detectImageExtension(Buffer.from('RIFF0000WEBP', 'ascii')), 'webp');
    assert.equal(detectImageExtension(Buffer.from('GIF89a', 'ascii')), 'gif');
    assert.equal(detectImageExtension(Buffer.from([0x42, 0x4d, 0, 0])), 'bmp');
    assert.throws(() => detectImageExtension(Buffer.from('unknown')), /无法识别/);
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

test('writes and verifies SpriteFrame borders before reporting a sliced asset', async () => {
    const url = 'db://assets/figma-importer/img_yushi_line.png';
    const info = {
        uuid: 'image-uuid',
        url,
        importer: 'image',
        type: 'cc.ImageAsset',
        imported: true,
        invalid: false,
        subAssets: {
            spriteFrame: {
                uuid: 'sprite-frame-uuid',
                url: `${url}/spriteFrame`,
                importer: 'sprite-frame',
                type: 'cc.SpriteFrame',
                imported: true,
                invalid: false,
            },
        },
    };
    const meta = {
        uuid: info.uuid,
        subMetas: {
            spriteFrame: {
                importer: 'sprite-frame',
                uuid: 'sprite-frame-uuid',
                userData: {
                    trimType: 'auto',
                    borderLeft: 0,
                    borderRight: 0,
                    borderTop: 0,
                    borderBottom: 0,
                },
            },
        },
    };
    const calls = [];
    const previousEditor = global.Editor;
    global.Editor = {
        Message: {
            async request(channel, method, ...args) {
                calls.push([channel, method, ...args]);
                if (method === 'query-asset-info') return info;
                if (method === 'query-asset-meta') return meta;
                return undefined;
            },
        },
    };
    try {
        const asset = await new AssetWriter('figma-importer').write(
            url,
            Buffer.from('png'),
            { left: 24.4, right: 18.6, top: 0, bottom: 0 },
        );

        assert.equal(asset.sliced, true);
        assert.equal(meta.subMetas.spriteFrame.userData.trimType, 'none');
        assert.equal(meta.subMetas.spriteFrame.userData.borderLeft, 24);
        assert.equal(meta.subMetas.spriteFrame.userData.borderRight, 19);
        assert.ok(calls.some(([, method]) => method === 'save-asset-meta'));
        assert.ok(calls.some(([, method]) => method === 'reimport-asset'));
        assert.ok(calls.filter(([, method]) => method === 'query-asset-meta').length >= 2);
    } finally {
        global.Editor = previousEditor;
    }
});

test('converts a newly imported Texture into a SpriteFrame and preserves tiled settings', async () => {
    const url = 'db://assets/figma-importer/new-texture.png';
    const textureInfo = {
        uuid: 'image-uuid',
        url,
        importer: 'image',
        type: 'cc.ImageAsset',
        imported: true,
        invalid: false,
        subAssets: {
            texture: {
                uuid: 'texture-uuid',
                url: `${url}/texture`,
                importer: 'texture',
                type: 'cc.Texture2D',
                imported: true,
                invalid: false,
            },
        },
    };
    const spriteFrame = {
        uuid: 'sprite-frame-uuid',
        url: `${url}/spriteFrame`,
        importer: 'sprite-frame',
        type: 'cc.SpriteFrame',
        imported: true,
        invalid: false,
    };
    const meta = {
        uuid: textureInfo.uuid,
        userData: { type: 'texture' },
        subMetas: {
            texture: {
                importer: 'texture',
                uuid: 'texture-uuid',
                userData: {},
            },
        },
    };
    let reimported = false;
    const calls = [];
    const previousEditor = global.Editor;
    global.Editor = {
        Message: {
            async request(channel, method, ...args) {
                calls.push([channel, method, ...args]);
                if (method === 'query-asset-info') {
                    return reimported
                        ? { ...textureInfo, subAssets: { ...textureInfo.subAssets, spriteFrame } }
                        : textureInfo;
                }
                if (method === 'query-asset-meta') return meta;
                if (method === 'reimport-asset') {
                    reimported = true;
                    meta.subMetas.spriteFrame ??= {
                        importer: 'sprite-frame',
                        uuid: spriteFrame.uuid,
                        userData: {},
                    };
                }
                return undefined;
            },
        },
    };
    try {
        const asset = await new AssetWriter('figma-importer').write(
            url,
            Buffer.from('png'),
            undefined,
            true,
        );

        assert.equal(meta.userData.type, 'sprite-frame');
        assert.equal(asset.uuid, spriteFrame.uuid);
        assert.equal(asset.tiled, true);
        assert.equal(meta.subMetas.spriteFrame.userData.trimType, 'none');
        assert.equal(meta.subMetas.spriteFrame.userData.packable, false);
        assert.equal(meta.subMetas.spriteFrame.userData.borderLeft, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderRight, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderTop, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderBottom, 0);
        assert.ok(calls.some(([, method]) => method === 'save-asset-meta'));
        assert.ok(calls.some(([, method]) => method === 'reimport-asset'));
    } finally {
        global.Editor = previousEditor;
    }
});

test('disables trimming and atlas packing for an existing tiled SpriteFrame', async () => {
    const url = 'db://assets/figma-importer/Ellipse 1__tile_deadbeef00.png';
    const info = {
        uuid: 'image-uuid',
        url,
        importer: 'image',
        type: 'cc.ImageAsset',
        imported: true,
        invalid: false,
        subAssets: {
            spriteFrame: {
                uuid: 'sprite-frame-uuid',
                url: `${url}/spriteFrame`,
                importer: 'sprite-frame',
                type: 'cc.SpriteFrame',
                imported: true,
                invalid: false,
            },
        },
    };
    const meta = {
        uuid: info.uuid,
        subMetas: {
            spriteFrame: {
                importer: 'sprite-frame',
                uuid: 'sprite-frame-uuid',
                userData: {
                    trimType: 'auto',
                    packable: true,
                    borderLeft: 8,
                    borderRight: 8,
                    borderTop: 8,
                    borderBottom: 8,
                },
            },
        },
    };
    const calls = [];
    const previousEditor = global.Editor;
    global.Editor = {
        Message: {
            async request(channel, method, ...args) {
                calls.push([channel, method, ...args]);
                if (method === 'query-asset-info') return info;
                if (method === 'query-asset-meta') return meta;
                return undefined;
            },
        },
    };
    try {
        const asset = await new AssetWriter('figma-importer').existing(url, true);

        assert.equal(asset.uuid, 'sprite-frame-uuid');
        assert.equal(asset.tiled, true);
        assert.equal(meta.subMetas.spriteFrame.userData.trimType, 'none');
        assert.equal(meta.subMetas.spriteFrame.userData.packable, false);
        assert.equal(meta.subMetas.spriteFrame.userData.borderLeft, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderRight, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderTop, 0);
        assert.equal(meta.subMetas.spriteFrame.userData.borderBottom, 0);
        assert.ok(calls.some(([, method]) => method === 'save-asset-meta'));
        assert.ok(calls.some(([, method]) => method === 'reimport-asset'));
    } finally {
        global.Editor = previousEditor;
    }
});
