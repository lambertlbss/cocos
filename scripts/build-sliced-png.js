'use strict';

const { buildSync } = require('esbuild');
const { readFileSync } = require('fs');
const { dirname, join, resolve } = require('path');

const root = resolve(__dirname, '..');
const license = readFileSync(join(dirname(require.resolve('pngjs/package.json')), 'LICENSE'), 'utf8');
// Ship the codec with the extension: Creator users do not need node_modules.
buildSync({
    absWorkingDir: root,
    entryPoints: ['source/importer/sliced-png.ts'],
    outfile: 'dist/importer/sliced-png.js',
    bundle: true,
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    sourcemap: 'inline',
    banner: { js: `/*! Bundled pngjs 7.0.0\n${license.replace(/\*\//g, '* /')}\n*/` },
});
