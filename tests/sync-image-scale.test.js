'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNode } = require('../dist/figma/parser');
const {
    compareSyncMarker,
    createSyncMarker,
    syncPixelHash,
} = require('../dist/importer/sync-marker');

const FILE_KEY = 'VxeomJZczEotAMsETIlXWl';

/**
 * Figma 的 Scale 工具会同时缩放节点尺寸、并把填充里的裁切矩阵按比例改写。
 * 这类等比缩放不应该被判成"图片变了"。
 */
function imageNode({ width, height, transform, imageRef = 'ref-1' }) {
    const parsed = parseNode({
        id: '1:2',
        name: 'img_icon',
        type: 'RECTANGLE',
        visible: true,
        children: [],
        absoluteBoundingBox: { x: 0, y: 0, width, height },
        fills: [{
            type: 'IMAGE',
            imageRef,
            scaleMode: 'CROP',
            imageTransform: transform,
        }],
    });
    assert.ok(parsed);
    return parsed;
}

test('scaling an image fill rewrites its crop matrix but keeps the pixel fingerprint', () => {
    const before = imageNode({
        width: 100,
        height: 100,
        transform: [[1, 0, 0], [0, 1, 0]],
    });
    const scaled = imageNode({
        width: 200,
        height: 200,
        transform: [[2, 0, 0], [0, 2, 0]],
    });
    assert.equal(syncPixelHash(before), syncPixelHash(scaled));
    assert.equal(compareSyncMarker(
        createSyncMarker({ fileKey: FILE_KEY, node: before }),
        createSyncMarker({ fileKey: FILE_KEY, node: scaled }),
    ).assetStale, false);
});

test('a real crop change still changes the pixel fingerprint', () => {
    const before = imageNode({
        width: 100,
        height: 100,
        transform: [[1, 0, 0], [0, 1, 0]],
    });
    const cropped = imageNode({
        width: 100,
        height: 100,
        transform: [[1, 0, 0.25], [0, 1, 0]],
    });
    assert.notEqual(syncPixelHash(before), syncPixelHash(cropped));
});
