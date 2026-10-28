'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    SYNC_MARKER_CLASS,
    SYNC_MARKER_SCHEMA,
    SYNC_MARKER_SCRIPT_SOURCE,
    SYNC_MARKER_SCRIPT_URL,
    assertUniqueSyncOwnership,
    compareSyncMarker,
    createSyncMarker,
    isSyncMarkerScript,
    markerFromComponentValues,
    markerToComponentValues,
    normalizeSyncNodeId,
    syncAliasHash,
    syncNeedsAssetRefresh,
    syncPixelHash,
    syncSubtreeHash,
    syncVisualHash,
} = require('../dist/importer/sync-marker');

const FILE_KEY = 'SensitiveFigmaFileKey123';

function node(overrides = {}) {
    return {
        id: '1:2',
        name: 'img_reward_bg',
        type: 'FRAME',
        visible: true,
        children: [],
        absoluteBoundingBox: { x: 10, y: 20, width: 300, height: 200 },
        rotation: 0,
        opacity: 1,
        clipsContent: false,
        fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1 }],
        strokes: [],
        strokeWeight: 0,
        effects: [],
        hasExportSettings: false,
        itemSpacing: 0,
        counterAxisSpacing: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        ...overrides,
    };
}

function child(id, overrides = {}) {
    return node({
        id,
        name: `layer_${id}`,
        absoluteBoundingBox: { x: 20, y: 30, width: 40, height: 40 },
        ...overrides,
    });
}

test('marks a Figma node with a hashed file key and a plain node id', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    assert.equal(marker.schema, SYNC_MARKER_SCHEMA);
    assert.equal(marker.figmaNodeId, '1:2');
    assert.match(marker.figmaFileHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(marker.visualHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(marker.subtreeHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(marker.aliasNodeIds, []);
    assert.equal(marker.aliasHash, syncAliasHash([]));
});

test('never serializes the plaintext Figma file key into the marker', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const values = markerToComponentValues(marker);
    const serialized = JSON.stringify([marker, values]);
    assert.equal(serialized.includes(FILE_KEY), false);
    assert.equal(serialized.includes('SensitiveFigmaFileKey'), false);
});

test('normalizes dashed node ids and keys the marker by the colon form', () => {
    assert.equal(normalizeSyncNodeId('410-5000'), '410:5000');
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node({ id: '410-5000' }) });
    assert.equal(marker.figmaNodeId, '410:5000');
});

test('fingerprints are stable across property insertion order', () => {
    const first = node();
    const second = {
        paddingBottom: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingLeft: 0,
        counterAxisSpacing: 0,
        itemSpacing: 0,
        hasExportSettings: false,
        effects: [],
        strokeWeight: 0,
        strokes: [],
        fills: [{ opacity: 1, color: { a: 1, b: 0, g: 0, r: 1 }, type: 'SOLID' }],
        clipsContent: false,
        opacity: 1,
        rotation: 0,
        absoluteBoundingBox: { height: 200, width: 300, y: 20, x: 10 },
        children: [],
        visible: true,
        type: 'FRAME',
        name: 'img_reward_bg',
        id: '1:2',
    };
    assert.equal(syncVisualHash(first), syncVisualHash(second));
    assert.equal(syncSubtreeHash(first), syncSubtreeHash(second));
});

test('ignores sub-micron float noise inside the 0.0001 px tolerance', () => {
    const before = node();
    const after = node({ absoluteBoundingBox: { x: 10.00001, y: 20, width: 300, height: 200 } });
    assert.equal(syncVisualHash(before), syncVisualHash(after));
});

test('detects a visual change on the node itself', () => {
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const after = createSyncMarker({
        fileKey: FILE_KEY,
        node: node({ fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1 }] }),
    });
    const comparison = compareSyncMarker(before, after);
    assert.equal(comparison.visualChanged, true);
    assert.equal(comparison.subtreeChanged, true);
    assert.equal(comparison.assetStale, true);
});

test('a child-only change leaves the parent visual hash alone but changes the subtree hash', () => {
    const before = createSyncMarker({
        fileKey: FILE_KEY,
        node: node({ children: [child('1:3')] }),
    });
    const moved = createSyncMarker({
        fileKey: FILE_KEY,
        node: node({ children: [child('1:3', { absoluteBoundingBox: { x: 24, y: 30, width: 40, height: 40 } })] }),
    });
    const comparison = compareSyncMarker(before, moved);
    assert.equal(comparison.visualChanged, false);
    assert.equal(comparison.subtreeChanged, true);
    assert.equal(comparison.assetStale, true);
});

test('an unchanged design produces no change at all', () => {
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node({ children: [child('1:3')] }) });
    const after = createSyncMarker({ fileKey: FILE_KEY, node: node({ children: [child('1:3')] }) });
    const comparison = compareSyncMarker(before, after);
    assert.deepEqual(comparison, {
        visualChanged: false,
        subtreeChanged: false,
        structureChanged: false,
        assetStale: false,
    });
});

test('aliases are deduplicated, sorted and never include the node itself', () => {
    const marker = createSyncMarker({
        fileKey: FILE_KEY,
        node: node(),
        aliasNodeIds: ['1-4', '1:3', '1:4', '1:2', ''],
    });
    assert.deepEqual(marker.aliasNodeIds, ['1:3', '1:4']);
    assert.equal(marker.aliasHash, syncAliasHash(['1:3', '1:4']));
});

test('removing a folded sub-layer registers as a structure change', () => {
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node(), aliasNodeIds: ['1:3', '1:4'] });
    const after = createSyncMarker({ fileKey: FILE_KEY, node: node(), aliasNodeIds: ['1:3'] });
    const comparison = compareSyncMarker(before, after);
    assert.equal(comparison.structureChanged, true);
    assert.equal(comparison.assetStale, true);
});

test('changing the source file marks the marker as stale', () => {
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const after = createSyncMarker({ fileKey: 'AnotherFileKey456', node: node() });
    const comparison = compareSyncMarker(before, after);
    assert.equal(comparison.assetStale, true);
});

test('asset refresh only applies to rasterized nodes with stale design', () => {
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const after = createSyncMarker({ fileKey: FILE_KEY, node: node({ absoluteBoundingBox: { x: 30, y: 20, width: 300, height: 200 } }) });
    const comparison = compareSyncMarker(before, after);
    assert.equal(syncNeedsAssetRefresh({ comparison, rasterized: true }), true);
    assert.equal(syncNeedsAssetRefresh({ comparison, rasterized: false }), false);
    assert.equal(syncNeedsAssetRefresh({
        comparison: compareSyncMarker(before, before),
        rasterized: true,
    }), false);
});

test('marker round-trips through Cocos component values', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node(), aliasNodeIds: ['1:3'] });
    const values = markerToComponentValues(marker);
    assert.equal(values.figmaNodeId, '1:2');
    assert.equal(values.figmaAliasNodeIds, '1:3');
    assert.deepEqual(markerFromComponentValues(values), marker);
});

test('corrupted or version-mismatched markers are rejected instead of guessed', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const values = markerToComponentValues(marker);
    assert.equal(markerFromComponentValues(null), null);
    assert.equal(markerFromComponentValues({}), null);
    assert.equal(markerFromComponentValues({ ...values, figmaMarkerSchema: 99 }), null);
    assert.equal(markerFromComponentValues({ ...values, figmaFileHash: 'not-a-hash' }), null);
    assert.equal(markerFromComponentValues({ ...values, figmaNodeId: '  ' }), null);
    assert.equal(markerFromComponentValues({ ...values, figmaVisualHash: 'sha256:zz' }), null);
    const missingAliasHash = markerFromComponentValues({ ...values, figmaAliasHash: '' });
    assert.deepEqual(missingAliasHash.aliasNodeIds, []);
    assert.equal(missingAliasHash.aliasHash, syncAliasHash([]));
});

test('one Figma node may only be owned by a single Cocos node', () => {
    const parent = createSyncMarker({ fileKey: FILE_KEY, node: node({ id: '1:2' }), aliasNodeIds: ['1:3'] });
    const other = createSyncMarker({ fileKey: FILE_KEY, node: node({ id: '1:4' }), aliasNodeIds: ['1:3'] });
    assert.throws(() => assertUniqueSyncOwnership([parent, other]), /同时被/);
    assert.doesNotThrow(() => assertUniqueSyncOwnership([parent]));
    const nested = createSyncMarker({ fileKey: FILE_KEY, node: node({ id: '1:3' }) });
    assert.throws(() => assertUniqueSyncOwnership([parent, nested]), /同时被/);
});

function arcNode(arcData) {
    return node({ type: 'ELLIPSE', arcData });
}

test('an arc sweep change is a pixel change even when the frame is identical', () => {
    const before = createSyncMarker({
        fileKey: FILE_KEY,
        node: arcNode({ startingAngle: 0, endingAngle: 3.14, innerRadius: 0.5 }),
    });
    const after = createSyncMarker({
        fileKey: FILE_KEY,
        node: arcNode({ startingAngle: 0, endingAngle: 4.71, innerRadius: 0.5 }),
    });
    const comparison = compareSyncMarker(before, after);
    assert.equal(comparison.visualChanged, true);
    assert.equal(comparison.assetStale, true);
});

test('an image crop transform change is a pixel change at the same imageRef', () => {
    const paint = (transform) => ([{
        type: 'IMAGE',
        imageRef: 'same-image-ref',
        scaleMode: 'CROP',
        imageTransform: transform,
    }]);
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node({ type: 'RECTANGLE', fills: paint([[1, 0, 0], [0, 1, 0]]) }) });
    const after = createSyncMarker({ fileKey: FILE_KEY, node: node({ type: 'RECTANGLE', fills: paint([[1.5, 0, 0], [0, 1, 0]]) }) });
    assert.equal(compareSyncMarker(before, after).visualChanged, true);
});

test('an image filter change is a pixel change', () => {
    const paint = (filters) => ([{ type: 'IMAGE', imageRef: 'ref', filters }]);
    const before = createSyncMarker({ fileKey: FILE_KEY, node: node({ type: 'RECTANGLE', fills: paint({ contrast: 1 }) }) });
    const after = createSyncMarker({ fileKey: FILE_KEY, node: node({ type: 'RECTANGLE', fills: paint({ contrast: 1.2 }) }) });
    assert.equal(compareSyncMarker(before, after).visualChanged, true);
});

test('the pixel hash ignores page position but keeps size, rotation and paint', () => {
    const base = node();
    const moved = node({ absoluteBoundingBox: { x: 310, y: 420, width: 300, height: 200 } });
    assert.equal(syncVisualHash(base) === syncVisualHash(moved), false);
    assert.equal(syncPixelHash(base), syncPixelHash(moved));

    const resized = node({ absoluteBoundingBox: { x: 10, y: 20, width: 301, height: 200 } });
    assert.equal(syncPixelHash(base) === syncPixelHash(resized), false);

    const restyled = node({ fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 1 }] });
    assert.equal(syncPixelHash(base) === syncPixelHash(restyled), false);
});

test('the marker round-trips the pixel hash', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    assert.match(marker.pixelHash, /^sha256:[0-9a-f]{64}$/);
    const parsed = markerFromComponentValues(markerToComponentValues(marker));
    assert.equal(parsed.pixelHash, marker.pixelHash);
});

test('an older marker without a pixel hash still parses', () => {
    const marker = createSyncMarker({ fileKey: FILE_KEY, node: node() });
    const values = markerToComponentValues(marker);
    delete values.figmaPixelHash;
    const parsed = markerFromComponentValues(values);
    assert.equal(parsed.pixelHash, undefined);
    assert.equal(parsed.visualHash, marker.visualHash);
});

test('the generated marker script is minimal, valid and detectable', () => {
    assert.equal(SYNC_MARKER_SCRIPT_URL, 'db://assets/figma-importer-runtime/FigmaSyncNode.ts');
    assert.equal(isSyncMarkerScript(SYNC_MARKER_SCRIPT_SOURCE), true);
    assert.match(SYNC_MARKER_SCRIPT_SOURCE, new RegExp(`@ccclass\\('${SYNC_MARKER_CLASS}'\\)`));
    assert.match(SYNC_MARKER_SCRIPT_SOURCE, /export class FigmaSyncNode extends Component/);
    // 生成脚本不能引入业务依赖，否则用户项目编译失败会连带打断导入。
    assert.equal(/from '(?!cc')[^']+'/.test(SYNC_MARKER_SCRIPT_SOURCE), false);
    assert.equal(SYNC_MARKER_SCRIPT_SOURCE.includes('figmaMarkerSchema'), true);
    assert.equal(isSyncMarkerScript(SYNC_MARKER_SCRIPT_SOURCE.replace('FigmaSyncNode extends', 'Other extends')), false);
});
