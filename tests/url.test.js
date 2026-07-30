'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFigmaSource, normalizeNodeId } = require('../dist/figma/url');

test('parses modern Figma design URLs and normalizes node ids', () => {
    assert.deepEqual(
        parseFigmaSource('https://www.figma.com/design/AbCdEf123456/Checkout?node-id=12-34'),
        { fileKey: 'AbCdEf123456', nodeId: '12:34' },
    );
});

test('supports file URLs and raw file keys', () => {
    assert.deepEqual(
        parseFigmaSource('https://figma.com/file/LongFileKey123/Name'),
        { fileKey: 'LongFileKey123', nodeId: undefined },
    );
    assert.deepEqual(parseFigmaSource('LongFileKey123'), { fileKey: 'LongFileKey123' });
});

test('rejects non-Figma hosts and malformed sources', () => {
    assert.throws(() => parseFigmaSource('https://example.com/design/key/name'), /figma\.com/);
    assert.throws(() => parseFigmaSource(''), /请输入/);
    assert.equal(normalizeNodeId('1%3A2'), '1:2');
});
