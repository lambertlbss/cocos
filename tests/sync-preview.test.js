'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    planSyncPreview,
    readPrefabSyncMarkers,
} = require('../dist/importer/sync-preview');

const VISUAL_A = 'sha256:' + 'a'.repeat(64);
const VISUAL_B = 'sha256:' + 'b'.repeat(64);
const SUBTREE_A = 'sha256:' + 'c'.repeat(64);
const SUBTREE_B = 'sha256:' + 'd'.repeat(64);
const ALIAS_A = 'sha256:' + 'e'.repeat(64);
const ALIAS_B = 'sha256:' + 'f'.repeat(64);

function prefabJson(entries) {
    const objects = [{ __type__: 'cc.Prefab' }];
    for (const entry of entries) {
        const nodeIndex = objects.length;
        objects.push({
            __type__: 'cc.Node',
            _name: entry.name,
            _active: entry.active !== false,
            _components: [{ __id__: nodeIndex + 1 }],
        });
        objects.push({
            __type__: 'cc.UITransform',
            _contentSize: { width: entry.width ?? 0, height: entry.height ?? 0 },
        });
        objects.push({
            __type__: '4fb75xk7ohLmJNs4Un1gT8X',
            node: { __id__: nodeIndex },
            figmaMarkerSchema: 1,
            figmaFileHash: 'sha256:' + '0'.repeat(64),
            figmaNodeId: entry.id,
            figmaAliasNodeIds: entry.aliases ?? '',
            figmaAliasHash: entry.aliasHash ?? ALIAS_A,
            figmaVisualHash: entry.visualHash ?? VISUAL_A,
            ...(entry.pixelHash ? { figmaPixelHash: entry.pixelHash } : {}),
            figmaSubtreeHash: entry.subtreeHash ?? SUBTREE_A,
        });
    }
    return JSON.stringify(objects);
}

function marker(overrides = {}) {
    return {
        schema: 1,
        figmaFileHash: 'sha256:' + '0'.repeat(64),
        figmaNodeId: '164:4718',
        aliasNodeIds: [],
        aliasHash: ALIAS_A,
        visualHash: VISUAL_A,
        subtreeHash: SUBTREE_A,
        ...overrides,
    };
}

function spec(overrides = {}) {
    return {
        figmaId: '164:4718',
        name: 'img_paiming_tiao1',
        figmaType: 'FRAME',
        action: 'generate',
        kind: 'node',
        frame: { x: 0, y: 0, width: 488, height: 104 },
        rotation: 0,
        opacity: 1,
        visible: true,
        clipsContent: false,
        cornerRadii: [0, 0, 0, 0],
        fills: [],
        strokes: [],
        strokeWeight: 0,
        syncMarker: marker(),
        children: [],
        ...overrides,
    };
}

test('reads markers by component fields without depending on the script uuid', () => {
    const map = readPrefabSyncMarkers(prefabJson([
        { id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104 },
        { id: '164-4719', name: 'txt_time', width: 62.28, height: 21.29, active: false },
    ]));
    assert.equal(map.size, 2);
    const root = map.get('164:4718');
    assert.equal(root.name, 'img_paiming_tiao1');
    assert.equal(root.active, true);
    assert.equal(root.width, 488);
    assert.equal(root.height, 104);
    assert.deepEqual(root.aliasNodeIds, []);
    assert.equal(map.get('164:4719').active, false);
});

test('rejects damaged prefab json instead of guessing', () => {
    assert.throws(() => readPrefabSyncMarkers('{ not json'), /不是有效 JSON/);
    assert.throws(() => readPrefabSyncMarkers('{"a":1}'), /结构无效/);
});

test('an untouched design reports no change', () => {
    const previous = readPrefabSyncMarkers(prefabJson([{ id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104 }]));
    const preview = planSyncPreview(previous, [spec()], { scale: 1 });
    assert.equal(preview.changed, 0);
    assert.equal(preview.added, 0);
    assert.equal(preview.removed, 0);
    assert.equal(preview.unchanged, 1);
    assert.equal(preview.assetStaleCount, 0);
    assert.deepEqual(preview.items, []);
});

test('a moved or restyled node is a visual change that needs a new image', () => {
    const previous = readPrefabSyncMarkers(prefabJson([{ id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104 }]));
    const preview = planSyncPreview(previous, [spec({ syncMarker: marker({ visualHash: VISUAL_B }) })], { scale: 1 });
    assert.equal(preview.changed, 1);
    assert.equal(preview.assetStaleCount, 1);
    const item = preview.items[0];
    assert.equal(item.status, 'changed');
    assert.deepEqual(item.fields, ['几何或外观']);
    assert.equal(item.assetStale, true);
});

test('a change inside a collapsed subtree is reported without touching the node itself', () => {
    const previous = readPrefabSyncMarkers(prefabJson([{ id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104 }]));
    const preview = planSyncPreview(previous, [spec({ syncMarker: marker({ subtreeHash: SUBTREE_B }) })], { scale: 1 });
    assert.equal(preview.changed, 1);
    assert.deepEqual(preview.items[0].fields, ['子层内容']);
    assert.equal(preview.items[0].assetStale, true);
});

test('a position-only change keeps the existing image', () => {
    const PIXEL = 'sha256:' + '9'.repeat(64);
    const previous = readPrefabSyncMarkers(prefabJson([{
        id: '164:4718',
        name: 'img_paiming_tiao1',
        width: 488,
        height: 104,
        visualHash: VISUAL_A,
        subtreeHash: SUBTREE_A,
        pixelHash: PIXEL,
    }]));
    const preview = planSyncPreview(previous, [spec({
        syncMarker: marker({ visualHash: VISUAL_B, subtreeHash: SUBTREE_B, pixelHash: PIXEL }),
    })], { scale: 1 });
    assert.equal(preview.changed, 1);
    assert.deepEqual(preview.items[0].fields, ['位置或尺寸']);
    assert.equal(preview.items[0].assetStale, false);
    assert.equal(preview.assetStaleCount, 0);
});

test('resizing a plain image node keeps the existing image', () => {
    const PIX = 'sha256:' + '4'.repeat(64);
    const previous = readPrefabSyncMarkers(prefabJson([{
        id: '164:4718',
        name: 'img_icon',
        width: 100,
        height: 100,
        visualHash: VISUAL_A,
        subtreeHash: SUBTREE_A,
        pixelHash: PIX,
    }]));
    const preview = planSyncPreview(previous, [spec({
        name: 'img_icon',
        frame: { x: 0, y: 0, width: 200, height: 100 },
        syncMarker: marker({ visualHash: VISUAL_B, subtreeHash: SUBTREE_A, pixelHash: PIX }),
    })], { scale: 1 });
    assert.deepEqual(preview.items[0].fields, ['位置或尺寸']);
    assert.equal(preview.items[0].assetStale, false);
    assert.equal(preview.assetStaleCount, 0);
});

test('a renamed node does not force a new image', () => {
    const previous = readPrefabSyncMarkers(prefabJson([{ id: '164:4718', name: 'img_old', width: 488, height: 104 }]));
    const preview = planSyncPreview(previous, [spec()], { scale: 1 });
    assert.equal(preview.changed, 1);
    assert.deepEqual(preview.items[0].fields, ['名称']);
    assert.equal(preview.items[0].assetStale, false);
});

test('visibility changes are reported, Cocos-side size differences are not', () => {
    const hidden = readPrefabSyncMarkers(prefabJson([
        { id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104, active: false },
    ]));
    assert.deepEqual(planSyncPreview(hidden, [spec()], { scale: 1 }).items[0].fields, ['显隐']);

    // Prefab 里是 Cocos 调整后的尺寸（Label 测字、本地素材尺寸），与 Figma 参考框不同，
    // 不能当成设计变化：没有任何指纹变化时不应上报。
    const smaller = readPrefabSyncMarkers(prefabJson([
        { id: '164:4718', name: 'img_paiming_tiao1', width: 400, height: 104 },
    ]));
    const resized = planSyncPreview(smaller, [spec()], { scale: 1 });
    assert.equal(resized.changed, 0);
    assert.equal(resized.unchanged, 1);
    assert.deepEqual(resized.items, []);
});

test('added and removed nodes are both reported', () => {
    const previous = readPrefabSyncMarkers(prefabJson([
        { id: '164:4718', name: 'img_paiming_tiao1', width: 488, height: 104 },
        { id: '164:4999', name: 'legacy_icon', width: 24, height: 24 },
    ]));
    const child = spec({
        figmaId: '164:4800',
        name: 'icon_new',
        frame: { x: 10, y: 10, width: 24, height: 24 },
        syncMarker: marker({ figmaNodeId: '164:4800' }),
    });
    const preview = planSyncPreview(previous, [spec({ children: [child] })], { scale: 1 });
    assert.equal(preview.added, 1);
    assert.equal(preview.removed, 1);
    assert.deepEqual(preview.items.map((item) => item.status).sort(), ['added', 'removed']);
    assert.equal(preview.total, 2);
});

test('specs without markers are counted instead of silently ignored', () => {
    const preview = planSyncPreview(new Map(), [spec({ syncMarker: undefined })], { scale: 1 });
    assert.equal(preview.missingMarkers, 1);
    assert.equal(preview.added, 0);
});

test('the import scale never turns Cocos-side sizes into design changes', () => {
    const previous = readPrefabSyncMarkers(prefabJson([
        { id: '164:4718', name: 'img_paiming_tiao1', width: 976, height: 208 },
    ]));
    assert.equal(planSyncPreview(previous, [spec()], { scale: 2 }).changed, 0);
    assert.equal(planSyncPreview(previous, [spec()], { scale: 1 }).changed, 0);
});

test('a folded sub-layer change is reported as a structure change', () => {
    const previous = readPrefabSyncMarkers(prefabJson([{
        id: '164:4718',
        name: 'img_paiming_tiao1',
        width: 488,
        height: 104,
        aliases: '164:4719',
        aliasHash: ALIAS_A,
    }]));
    const nextMarker = marker({ aliasNodeIds: ['164:4719', '164:4720'], aliasHash: ALIAS_B });
    const preview = planSyncPreview(previous, [spec({ syncMarker: nextMarker })], { scale: 1 });
    assert.deepEqual(preview.items[0].fields, ['折叠结构']);
    assert.equal(preview.items[0].assetStale, true);
});
