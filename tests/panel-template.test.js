'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

test('keeps the Round-trip panel feature disabled without removing its implementation', () => {
    const template = readFileSync(
        resolve('static/template/default/index.html'),
        'utf8',
    );
    const style = readFileSync(
        resolve('static/style/default/index.css'),
        'utf8',
    );

    assert.match(template, /class="card roundtrip-card" data-feature-enabled="false" hidden inert aria-hidden="true"/);
    assert.match(style, /\.roundtrip-card\[data-feature-enabled="false"\]\s*\{\s*display:\s*none\s*!important;/);
    assert.match(template, /id="roundtrip-detect"/);
    assert.match(template, /id="roundtrip-apply"/);
});
