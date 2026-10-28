'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { syncMarkersEnabled } = require('../dist/main');

test('every single-node link source uses sync markers', () => {
    // Frame / Group / Component / Instance 等任意单节点链接。
    assert.equal(syncMarkersEnabled('1:2', 1), true);
    assert.equal(syncMarkersEnabled('164:4754', 1), true);
});

test('whole-file imports and multi-root sources keep the old behaviour', () => {
    assert.equal(syncMarkersEnabled(undefined, 1), false, '整份文件导入没有 sourceNodeId');
    assert.equal(syncMarkersEnabled(undefined, 3), false);
    assert.equal(syncMarkersEnabled('1:2', 2), false, '多根来源不生成标记');
    assert.equal(syncMarkersEnabled('', 1), false);
});
