'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const Module = require('node:module');
const { PNG } = require('pngjs');
const { compactSlicePng, writeSlicedPng } = require('../dist/importer/sliced-png');
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
        const rewritten = await new AssetWriter('figma-importer').write(url, Buffer.from('new png'));
        assert.equal(rewritten.sliced, true, 'rewriting without new borders must preserve slicing');
    } finally {
        global.Editor = previousEditor;
    }
});

test('falls back to a normal SpriteFrame when Cocos cannot persist sliced borders', async () => {
    const url = 'db://assets/figma-importer/invalid_slice.png';
    const info = {
        uuid: 'fallback-image-uuid',
        url,
        importer: 'image',
        type: 'cc.ImageAsset',
        imported: true,
        invalid: false,
        subAssets: {
            spriteFrame: {
                uuid: 'fallback-sprite-frame-uuid',
                url: `${url}/spriteFrame`,
                importer: 'sprite-frame',
                type: 'cc.SpriteFrame',
                imported: true,
                invalid: false,
            },
        },
    };
    const freshMeta = () => ({
        uuid: info.uuid,
        subMetas: {
            spriteFrame: {
                importer: 'sprite-frame',
                uuid: 'fallback-sprite-frame-uuid',
                userData: {
                    trimType: 'auto',
                    borderLeft: 0,
                    borderRight: 0,
                    borderTop: 0,
                    borderBottom: 0,
                },
            },
        },
    });
    const previousEditor = global.Editor;
    global.Editor = {
        Message: {
            async request(_channel, method) {
                if (method === 'query-asset-info') return info;
                if (method === 'query-asset-meta') return freshMeta();
                return undefined;
            },
        },
    };
    try {
        const asset = await new AssetWriter('figma-importer').write(
            url,
            Buffer.from('png'),
            { left: 10, right: 10, top: 6, bottom: 6 },
        );

        assert.equal(asset.uuid, 'fallback-sprite-frame-uuid');
        assert.equal(asset.sliced, false);
        assert.match(asset.sliceFallback, /未能写入或回读/);
    } finally {
        global.Editor = previousEditor;
    }
});

test('keeps the imported SpriteFrame when Cocos throws while saving sliced borders', async () => {
    const url = 'db://assets/figma-importer/rejected_slice.png';
    const info = {
        uuid: 'rejected-image-uuid',
        url,
        importer: 'image',
        type: 'cc.ImageAsset',
        imported: true,
        invalid: false,
        subAssets: {
            spriteFrame: {
                uuid: 'rejected-sprite-frame-uuid',
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
                uuid: 'rejected-sprite-frame-uuid',
                userData: {},
            },
        },
    };
    const previousEditor = global.Editor;
    global.Editor = {
        Message: {
            async request(_channel, method) {
                if (method === 'query-asset-info') return info;
                if (method === 'query-asset-meta') return meta;
                if (method === 'save-asset-meta') throw new Error('SpriteFrame Meta 被占用');
                return undefined;
            },
        },
    };
    try {
        const asset = await new AssetWriter('figma-importer').write(
            url,
            Buffer.from('png'),
            { left: 8, right: 8, top: 4, bottom: 4 },
        );

        assert.equal(asset.uuid, 'rejected-sprite-frame-uuid');
        assert.equal(asset.sliced, false);
        assert.match(asset.sliceFallback, /Meta 被占用/);
    } finally {
        global.Editor = previousEditor;
    }
});

test('stale nonzero borders or an unpersisted trim mode do not count as a verified slice', async () => {
    const previousEditor = global.Editor;
    const info = {
        uuid: 'image', url: 'db://assets/stale.png', importer: 'image', type: 'cc.ImageAsset', imported: true,
        subAssets: { frame: { uuid: 'frame', importer: 'sprite-frame', type: 'cc.SpriteFrame', imported: true } },
    };
    try {
        for (const stored of [
            { trimType: 'none', borderLeft: 1, borderRight: 1, borderTop: 1, borderBottom: 1 },
            { trimType: 'auto', borderLeft: 3, borderRight: 4, borderTop: 2, borderBottom: 3 },
        ]) {
            global.Editor = { Message: { async request(_channel, method) {
                if (method === 'query-asset-info') return info;
                if (method === 'query-asset-meta') return { subMetas: { frame: {
                    importer: 'sprite-frame', userData: { ...stored },
                } } };
            } } };
            const asset = await new AssetWriter('figma-importer').write(info.url, Buffer.from('png'),
                { left: 3, right: 4, top: 2, bottom: 3 });
            assert.equal(asset.sliced, false);
            assert.match(asset.sliceFallback, /未能写入或回读/);
        }
    } finally { global.Editor = previousEditor; }
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

async function withAssetDatabase(run) {
    const root = await mkdtemp(join(tmpdir(), 'figma-reuse-test-'));
    await mkdir(join(root, 'assets'));
    const entries = new Map();
    const hiddenUrls = new Set();
    const calls = [];
    let sequence = 0;
    let rejectIdentity = false;
    let rejectBorders = false;
    const previous = global.Editor;
    const diskPath = (url) => join(root, url.slice('db://'.length));
    const add = async (url, contents, borders = {}, identity) => {
        const uuid = `image-${++sequence}`;
        const frameUuid = `frame-${sequence}`;
        const info = { uuid, url, imported: true, invalid: false, importer: 'image', type: 'cc.ImageAsset',
            subAssets: { frame: { uuid: frameUuid, importer: 'sprite-frame', type: 'cc.SpriteFrame' } } };
        const meta = { uuid, userData: { type: 'sprite-frame', custom: 'preserve-me', ...(identity ? { figmaImporter: identity } : {}) },
            subMetas: { frame: { uuid: frameUuid, importer: 'sprite-frame', userData: {
                trimType: 'none', borderLeft: 0, borderRight: 0, borderTop: 0, borderBottom: 0, ...borders,
            } } } };
        await mkdir(dirname(diskPath(url)), { recursive: true });
        await writeFile(diskPath(url), contents);
        await writeFile(`${diskPath(url)}.meta`, JSON.stringify(meta));
        entries.set(url, { info, meta });
        return entries.get(url);
    };
    global.Editor = { Project: { path: root }, Message: { async request(_channel, method, ...args) {
        calls.push([method, ...args]);
        const entry = entries.get(args[0]) ?? [...entries.values()].find((item) => item.info.uuid === args[0]);
        if (method === 'query-asset-info') {
            if (hiddenUrls.has(args[0])) return null;
            return entry?.info ?? null;
        }
        if (method === 'query-asset-meta') return entry ? JSON.parse(JSON.stringify(entry.meta)) : null;
        if (method === 'create-asset') {
            assert.equal(entries.has(args[0]), false, 'must never overwrite existing files during create');
            assert.equal(args[2]?.overwrite, false);
            await add(args[0], args[1]);
        }
        if (method === 'save-asset') {
            assert.ok(entry, 'updates require an existing UUID');
            await writeFile(diskPath(args[0]), args[1]);
        }
        if (method === 'save-asset-meta') {
            const meta = JSON.parse(args[1]);
            if (rejectBorders && Object.values(meta.subMetas ?? {}).some((item) => item.importer === 'sprite-frame'
                && ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'].some((side) => item.userData?.[side] > 0))) {
                throw new Error('Cocos refused sliced borders');
            }
            if (rejectIdentity && meta.userData?.figmaImporter && !meta.userData.figmaImporter.pending) {
                rejectIdentity = false; throw new Error('interrupted identity commit');
            }
            entry.meta = meta;
            await writeFile(`${diskPath(entry.info.url)}.meta`, JSON.stringify(meta));
        }
    } } };
    try { await run({ root, entries, calls, hiddenUrls, add, diskPath, failIdentity: () => { rejectIdentity = true; },
        failBorders: () => { rejectBorders = true; } }); }
    finally {
        global.Editor = previous;
        assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
        await rm(root, { recursive: true, force: true });
    }
}

test('resource import is idempotent across writers and preserves persisted UUID/source identity', async () => {
    await withAssetDatabase(async ({ entries, calls }) => {
        const url = 'db://assets/imported/icon.png';
        const sourceKey = 'file-a:15:193:raster:1';
        const firstWriter = new AssetWriter('imported');
        const first = await firstWriter.resolve(url, Buffer.from('source-pixels'), { sourceKey });
        const secondWriter = new AssetWriter('imported');
        const lookup = await secondWriter.existingForSource(sourceKey, { tiled: false, sliced: false });
        const second = await secondWriter.resolve(url, Buffer.from('source-pixels'), { sourceKey });
        assert.equal(lookup.uuid, first.uuid);
        assert.equal(second.uuid, first.uuid);
        assert.equal(entries.size, 1);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 1);
        assert.equal(calls.filter(([method]) => method === 'save-asset').length, 0);
        const meta = entries.get(url).meta;
        assert.equal(meta.userData.custom, 'preserve-me');
        assert.equal(Object.keys(meta.userData.figmaImporter.sources).length, 1);
        assert.equal(JSON.stringify(meta).includes(sourceKey), false, 'persist hashes, not raw source IDs');
        assert.equal(secondWriter.events.at(-1).action, 'reused');
    });
});

test('hidden folder matches and incomplete AssetDB subAssets reuse the original SpriteFrame UUID', async () => {
    await withAssetDatabase(async ({ add, entries, hiddenUrls, calls }) => {
        const hidden = 'db://assets/.hidden/library/icon.png';
        const entry = await add(hidden, Buffer.from('same-pixels'));
        delete entry.info.subAssets;
        hiddenUrls.add(hidden);
        const writer = new AssetWriter('imported');
        const asset = await writer.resolve('db://assets/imported/icon.png', Buffer.from('same-pixels'), { sourceKey: 'file:hidden-icon' });
        assert.equal(asset.url, hidden);
        assert.equal(asset.uuid, entry.meta.subMetas.frame.uuid);
        assert.equal(entries.size, 1);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 0);
        assert.equal((await new AssetWriter('elsewhere').existingForSource('file:hidden-icon')).uuid, asset.uuid);
    });
});

test('same name with different contents or slice borders gets isolated stable variants', async () => {
    await withAssetDatabase(async ({ add, entries, diskPath }) => {
        const url = 'db://assets/imported/panel.png';
        const original = await add(url, Buffer.from('artist-pixels'), { borderLeft: 2, borderRight: 2 });
        const originalMeta = JSON.stringify(original.meta);
        const writer = new AssetWriter('imported');
        const otherPixels = await writer.resolve(url, Buffer.from('other-pixels'), { sourceKey: 'file:other' });
        const otherBorders = await writer.resolve(url, Buffer.from('artist-pixels'), { sourceKey: 'file:slice',
            borders: { left: 4, right: 4, top: 0, bottom: 0 } });
        assert.notEqual(otherPixels.uuid, original.meta.subMetas.frame.uuid);
        assert.notEqual(otherBorders.uuid, original.meta.subMetas.frame.uuid);
        assert.notEqual(otherPixels.uuid, otherBorders.uuid);
        assert.equal(JSON.stringify(original.meta), originalMeta, 'legacy Meta must not be overwritten');
        assert.equal((await readFile(diskPath(url))).toString(), 'artist-pixels');
        assert.equal((await new AssetWriter('imported').resolve(url, Buffer.from('other-pixels'), { sourceKey: 'file:other' })).uuid, otherPixels.uuid);
        assert.equal(entries.size, 3);
    });
});

test('concurrent imports share one creation and both persistent source bindings', async () => {
    await withAssetDatabase(async ({ entries, calls }) => {
        const url = 'db://assets/imported/icon.png';
        const [a, b] = await Promise.all([
            new AssetWriter('imported').resolve(url, Buffer.from('pixels'), { sourceKey: 'file:1' }),
            new AssetWriter('imported').resolve(url, Buffer.from('pixels'), { sourceKey: 'file:2' }),
        ]);
        assert.equal(a.uuid, b.uuid);
        assert.equal(entries.size, 1);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 1);
        assert.equal(Object.keys(entries.get(url).meta.userData.figmaImporter.sources).length, 2);
    });
});

test('exclusive source updates retain UUID while shared source changes leave other instances intact', async () => {
    await withAssetDatabase(async ({ entries, diskPath }) => {
        const writer = new AssetWriter('imported');
        const url = 'db://assets/imported/icon.png';
        const first = await writer.resolve(url, Buffer.from('v1'), { sourceKey: 'file:1' });
        const updated = await writer.resolve(url, Buffer.from('v2'), { sourceKey: 'file:1', refresh: true });
        assert.equal(updated.uuid, first.uuid);
        const shared = await writer.resolve(url, Buffer.from('v2'), { sourceKey: 'file:2' });
        assert.equal(shared.uuid, first.uuid);
        const changed = await writer.resolve(url, Buffer.from('v3'), { sourceKey: 'file:1', refresh: true });
        assert.notEqual(changed.uuid, first.uuid);
        assert.equal((await readFile(diskPath(url))).toString(), 'v2');
        assert.equal((await new AssetWriter('imported').existingForSource('file:2')).uuid, first.uuid);
        assert.equal((await new AssetWriter('imported').existingForSource('file:1')).uuid, changed.uuid);
        assert.equal(entries.size, 2);
    });
});

test('interrupted source binding retries without duplicate creation or replacing an existing Meta', async () => {
    await withAssetDatabase(async ({ entries, calls, failIdentity }) => {
        const url = 'db://assets/imported/icon.png';
        failIdentity();
        await assert.rejects(new AssetWriter('imported').resolve(url, Buffer.from('pixels'), { sourceKey: 'file:1' }), /interrupted identity commit/);
        const firstUuid = entries.get(url).meta.subMetas.frame.uuid;
        const retried = await new AssetWriter('imported').resolve(url, Buffer.from('pixels'), { sourceKey: 'file:1' });
        assert.equal(retried.uuid, firstUuid);
        assert.equal(entries.size, 1);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 1);
    });
});

test('physical files absent from AssetDB block creation and preserve bytes/meta', async () => {
    await withAssetDatabase(async ({ root, calls }) => {
        await mkdir(join(root, 'assets', 'imported'));
        const path = join(root, 'assets', 'imported', 'icon.png');
        await writeFile(path, 'not-indexed-yet');
        await writeFile(`${path}.meta`, JSON.stringify({ uuid: 'pending-uuid', userData: {}, subMetas: {} }));
        await assert.rejects(new AssetWriter('imported').resolve('db://assets/imported/icon.png', Buffer.from('new-pixels'),
            { sourceKey: 'file:1' }), /不会另建副本/);
        assert.equal((await readFile(path)).toString(), 'not-indexed-yet');
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 0);
    });
});

test('externally edited resources invalidate fast mappings without being overwritten', async () => {
    await withAssetDatabase(async ({ diskPath }) => {
        const url = 'db://assets/imported/icon.png';
        const first = await new AssetWriter('imported').resolve(url, Buffer.from('v1'), { sourceKey: 'file:1' });
        await writeFile(diskPath(url), 'artist-edit');
        const writer = new AssetWriter('imported');
        assert.equal(await writer.existingForSource('file:1'), null);
        const updated = await writer.resolve(url, Buffer.from('v2'), { sourceKey: 'file:1' });
        assert.notEqual(updated.uuid, first.uuid);
        assert.equal((await readFile(diskPath(url))).toString(), 'artist-edit');
    });
});

test('explicit zero borders clear stale slicing while absent borders preserve it', async () => {
    await withAssetDatabase(async ({ add, entries }) => {
        const url = 'db://assets/imported/panel.png';
        await add(url, Buffer.from('pixels'), { borderLeft: 4, borderRight: 4 });
        const writer = new AssetWriter('imported');
        assert.equal((await writer.write(url, Buffer.from('pixels'))).sliced, true);
        assert.equal((await writer.write(url, Buffer.from('pixels'), { left: 0, right: 0, top: 0, bottom: 0 })).sliced, false);
        assert.equal(entries.get(url).meta.subMetas.frame.userData.borderLeft, 0);
    });
});

test('hidden assets can update through their persisted UUID when URL queries omit them', async () => {
    await withAssetDatabase(async ({ hiddenUrls, entries }) => {
        const url = 'db://assets/.hidden/icon.png';
        const sourceKey = 'file:hidden';
        const first = await new AssetWriter('imported').resolve(url, Buffer.from('v1'), { sourceKey });
        hiddenUrls.add(url);
        delete entries.get(url).info.subAssets;
        const updated = await new AssetWriter('imported').resolve(url, Buffer.from('v2'), { sourceKey, refresh: true });
        assert.equal(updated.uuid, first.uuid);
        assert.equal(updated.url, url);
        assert.equal(entries.size, 1);
    });
});

test('tiled and ordinary resources do not share metadata even with identical name and bytes', async () => {
    await withAssetDatabase(async ({ entries }) => {
        const url = 'db://assets/imported/icon.png';
        const normal = await new AssetWriter('imported').resolve(url, Buffer.from('same'), { sourceKey: 'file:normal' });
        const tiled = await new AssetWriter('imported').resolve(url, Buffer.from('same'), { sourceKey: 'file:tile', tiled: true });
        assert.notEqual(normal.uuid, tiled.uuid);
        assert.equal(entries.get(url).meta.subMetas.frame.userData.packable, undefined);
        const writer = new AssetWriter('imported');
        assert.equal(await writer.existingForSource('file:tile', { tiled: false }), null);
        assert.equal((await writer.existingForSource('file:tile', { tiled: true })).uuid, tiled.uuid);
    });
});

test('source mapping revisions remain ordered when multiple imports finish in the same millisecond', async () => {
    const previousNow = Date.now;
    Date.now = () => 123456789;
    try {
        await withAssetDatabase(async () => {
            const url = 'db://assets/imported/icon.png';
            const writer = new AssetWriter('imported');
            await writer.resolve(url, Buffer.from('same'), { sourceKey: 'file:1' });
            await writer.resolve(url, Buffer.from('same'), { sourceKey: 'file:2' });
            const next = await writer.resolve(url, Buffer.from('next'), { sourceKey: 'file:1' });
            assert.equal((await new AssetWriter('imported').existingForSource('file:1')).uuid, next.uuid);
        });
    } finally { Date.now = previousNow; }
});

test('an exclusive source changing from sliced to ordinary keeps UUID and clears its old borders', async () => {
    await withAssetDatabase(async ({ entries }) => {
        const url = 'db://assets/imported/panel.png';
        const writer = new AssetWriter('imported');
        const sliced = await writer.resolve(url, Buffer.from('pixels'), { sourceKey: 'file:panel',
            borders: { left: 4, right: 4, top: 0, bottom: 0 } });
        assert.equal(sliced.sliced, true);
        const normal = await writer.resolve(url, Buffer.from('pixels'), { sourceKey: 'file:panel' });
        assert.equal(normal.uuid, sliced.uuid);
        assert.equal(normal.sliced, false);
        assert.equal(entries.get(url).meta.subMetas.frame.userData.borderLeft, 0);
        assert.equal((await new AssetWriter('imported').existingForSource('file:panel', { sliced: false })).uuid, normal.uuid);
    });
});

test('interrupted exclusive source updates retry in place and clear their pending journal', async () => {
    await withAssetDatabase(async ({ entries, calls, failIdentity, diskPath }) => {
        const url = 'db://assets/imported/icon.png';
        const sourceKey = 'file:1';
        const original = await new AssetWriter('imported').resolve(url, Buffer.from('v1'), { sourceKey });
        failIdentity();
        await assert.rejects(new AssetWriter('imported').resolve(url, Buffer.from('v2'), { sourceKey, refresh: true }), /interrupted identity commit/);
        assert.ok(entries.get(url).meta.userData.figmaImporter.pending);
        assert.equal((await readFile(diskPath(url))).toString(), 'v2');
        const writer = new AssetWriter('imported');
        assert.equal(await writer.existingForSource(sourceKey), null, 'pending updates must never be reused as successful imports');
        const retried = await writer.resolve(url, Buffer.from('v2'), { sourceKey });
        assert.equal(retried.uuid, original.uuid);
        assert.equal(entries.get(url).meta.userData.figmaImporter.pending, undefined);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 1);
    });
});

test('PNG to JPG conversion never overwrites an incompatible legacy JPG or redirects an alpha variant', async () => {
    const load = Module._load;
    const jpeg = Buffer.from([255, 216, 255, 224, 255, 217]);
    Module._load = function(name, ...args) {
        if (name === 'electron') return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toJPEG: () => jpeg }) } };
        return load.call(this, name, ...args);
    };
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    const opaque = PNG.sync.write(image);
    image.data[3] = 0;
    const transparent = PNG.sync.write(image);
    try {
        await withAssetDatabase(async ({ add, diskPath }) => {
            const originalUrl = 'db://assets/imported/panel.jpg';
            const original = Buffer.from([255, 216, 255, 225, 1, 217]);
            await add(originalUrl, original);
            const result = await new AssetWriter('imported').resolve('db://assets/imported/panel.png', opaque, { sourceKey: 'file:panel' });
            assert.notEqual(result.url, originalUrl);
            assert.match(result.url, /panel__[0-9a-f]+\.jpg$/);
            assert.deepEqual(await readFile(diskPath(originalUrl)), original);
            assert.equal((await new AssetWriter('imported').resolve('db://assets/imported/panel.png', opaque, { sourceKey: 'file:panel' })).uuid, result.uuid);
        });
        await withAssetDatabase(async ({ diskPath }) => {
            const writer = new AssetWriter('imported');
            const url = 'db://assets/imported/icon.png';
            const opaqueAsset = await writer.write(url, opaque);
            assert.match(opaqueAsset.url, /\.jpg$/);
            const alphaAsset = await writer.resolve(url, transparent, { sourceKey: 'file:alpha' });
            assert.equal(alphaAsset.url, url);
            assert.notEqual(alphaAsset.uuid, opaqueAsset.uuid);
            assert.deepEqual(await readFile(diskPath(opaqueAsset.url)), jpeg);
            assert.deepEqual(await readFile(diskPath(alphaAsset.url)), transparent);
        });
    } finally { Module._load = load; }
});

test('repeated sliced metadata failures restore full PNG through real resolve without new assets or UUID changes', async () => {
    await withAssetDatabase(async ({ entries, calls, diskPath, failBorders }) => {
        const url = 'db://assets/imported/panel.png';
        const sourceKey = 'file:panel:sliced';
        const analysis = { mode: 'nine', borders: { left: 3, right: 4, top: 2, bottom: 3 } };
        const node = { absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 20 }, rotation: 0,
            relativeTransform: [[1, 0, 0], [0, 1, 0]] };
        const image = new PNG({ width: 30, height: 20 });
        for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([50, 80, 150, 128], offset);
        const contents = PNG.sync.write(image);
        const compact = compactSlicePng(contents, node, analysis, 1);
        assert.equal(compact.optimization.status, 'compacted');
        assert.deepEqual([compact.optimization.width, compact.optimization.height], [9, 7]);
        failBorders();
        const results = [];
        for (let round = 0; round < 2; round++) {
            const writer = new AssetWriter('imported');
            const result = await writeSlicedPng({ write: (target, bytes, borders) => writer.resolve(target, bytes,
                { sourceKey, borders }) }, url, contents, node, analysis, 1);
            assert.equal(result.optimization.status, 'restored');
            assert.equal(result.asset.sliced, false);
            assert.match(result.asset.sliceFallback, /Cocos refused sliced borders/);
            const stored = await readFile(diskPath(result.asset.url));
            const png = PNG.sync.read(stored);
            assert.deepEqual([png.width, png.height], [30, 20], 'SIMPLE must use the full source canvas');
            assert.deepEqual(png.data, image.data);
            assert.equal(await writer.existingForSource(sourceKey, { sliced: true }), null);
            results.push(result.asset);
        }
        assert.equal(results[1].uuid, results[0].uuid);
        assert.equal(results[1].url, results[0].url);
        assert.equal(entries.size, 1);
        assert.equal(calls.filter(([method]) => method === 'create-asset').length, 1);
        assert.equal(entries.get(results[1].url).meta.userData.figmaImporter.pending, undefined);
        assert.equal(entries.get(results[1].url).meta.userData.figmaImporter.config, '["sprite",0,0,0,0]');
    });
});
