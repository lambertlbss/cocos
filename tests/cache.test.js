'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { LocalAssetCache } = require('../dist/importer/cache');

test('stores downloaded assets under hashed keys without leaking identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'figma-importer-cache-test-'));
    try {
        const cache = new LocalAssetCache(root);
        await cache.initialize();
        const key = {
            fileKey: 'VisibleFigmaFileKey',
            nodeId: '15:193',
            format: 'png',
            scale: 2,
        };
        const target = cache.pathFor(key);
        const visualTarget = cache.pathFor({ ...key, variant: 'visual-overflow-v1' });
        assert.equal(target.includes(key.fileKey), false);
        assert.equal(target.includes(key.nodeId), false);
        assert.notEqual(visualTarget, target);
        await cache.write(key, Buffer.from('asset-bytes'));
        assert.deepEqual(await cache.read(key), Buffer.from('asset-bytes'));
    } finally {
        const safeRoot = resolve(root);
        assert.equal(safeRoot.startsWith(resolve(tmpdir())), true);
        await rm(safeRoot, { recursive: true, force: true });
    }
});
