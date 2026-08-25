'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    clampImageScale,
    imageFillPath,
    imageFillUrlsFromResponse,
} = require('../dist/figma/client');

test('builds the Figma original image-fill endpoint instead of the node render endpoint', () => {
    assert.equal(
        imageFillPath('file/key + 中文'),
        '/v1/files/file%2Fkey%20%2B%20%E4%B8%AD%E6%96%87/images',
    );
});

test('uses the same bounded raster scale for tile keys and Figma render requests', () => {
    assert.equal(clampImageScale(0.1), 0.25);
    assert.equal(clampImageScale(1.5), 1.5);
    assert.equal(clampImageScale(8), 4);
});

test('accepts the documented image-fill response envelope and a direct compatibility shape', () => {
    const images = { source: 'https://example.com/source.png' };

    assert.deepEqual(imageFillUrlsFromResponse({ meta: { images } }), images);
    assert.deepEqual(imageFillUrlsFromResponse({ images }), images);
    assert.deepEqual(imageFillUrlsFromResponse({}), {});
});
