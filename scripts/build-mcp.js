'use strict';

const { builtinModules } = require('module');
const { chmodSync, readFileSync } = require('fs');
const { join, resolve } = require('path');
const esbuild = require('esbuild');

const projectRoot = resolve(__dirname, '..');
const outputFile = join(projectRoot, 'mcp-dist', 'server.js');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
]);

async function main() {
    const result = await esbuild.build({
        absWorkingDir: projectRoot,
        entryPoints: ['mcp/src/server.ts'],
        outfile: outputFile,
        bundle: true,
        platform: 'node',
        target: ['node18'],
        format: 'cjs',
        packages: 'bundle',
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
        define: {
            __FIGMA_IMPORTER_VERSION__: JSON.stringify(packageJson.version),
        },
        banner: { js: '#!/usr/bin/env node' },
        metafile: true,
        logLevel: 'info',
    });
    const unresolved = Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((item) => item.external && !builtins.has(item.path));
    if (unresolved.length) {
        throw new Error(`MCP 单文件仍含外部依赖：${unresolved.map((item) => item.path).join(', ')}`);
    }
    chmodSync(outputFile, 0o755);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
