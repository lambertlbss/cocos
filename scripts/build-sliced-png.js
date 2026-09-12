'use strict';

const { buildSync } = require('esbuild');
const { readFileSync } = require('fs');
const { dirname, join, resolve } = require('path');

const root = resolve(__dirname, '..');
const license = readFileSync(join(dirname(require.resolve('pngjs/package.json')), 'LICENSE'), 'utf8');
// Ship the codec with the extension: Creator users do not need node_modules.
for (const moduleName of ['sliced-png', 'tiled-png']) buildSync({
    absWorkingDir: root,
    entryPoints: [`source/importer/${moduleName}.ts`],
    outfile: `dist/importer/${moduleName}.js`,
    bundle: true,
    platform: 'node',
    external: ['electron'],
    target: 'node16',
    format: 'cjs',
    sourcemap: 'inline',
    banner: { js: `/*! Bundled pngjs 7.0.0\n${license.replace(/\*\//g, '* /')}\n*/` },
});
