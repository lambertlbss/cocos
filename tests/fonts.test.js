'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findFontAsset, normalizeFontName } = require('../dist/importer/fonts');

test('normalizes font names and automatically matches project assets', () => {
    assert.equal(normalizeFontName('Noto Sans SC'), 'notosanssc');
    const assets = [
        { name: 'NotoSansSC', url: 'db://assets/fonts/NotoSansSC.ttf', relativePath: 'fonts/NotoSansSC.ttf' },
        { name: 'SourceHanSans', url: 'db://assets/fonts/SourceHanSans.otf', relativePath: 'fonts/SourceHanSans.otf' },
    ];
    assert.equal(findFontAsset('Noto Sans SC', assets).url, assets[0].url);
    assert.equal(findFontAsset('Source Han Sans', assets).url, assets[1].url);
    assert.equal(findFontAsset('Unknown Font', assets), undefined);
});
