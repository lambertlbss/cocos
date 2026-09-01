'use strict';

const { rmSync } = require('fs');
const { basename, dirname, join, resolve } = require('path');

const projectRoot = resolve(__dirname, '..');
const outputRoots = [
    resolve(projectRoot, 'dist'),
    resolve(projectRoot, 'mcp-dist'),
];

for (const outputRoot of outputRoots) {
    if (dirname(outputRoot) !== projectRoot || !['dist', 'mcp-dist'].includes(basename(outputRoot))) {
        throw new Error(`拒绝清理非项目构建目录：${outputRoot}`);
    }
    rmSync(outputRoot, { recursive: true, force: true });
}
