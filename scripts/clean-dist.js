'use strict';

const { rmSync } = require('fs');
const { basename, dirname, join, resolve } = require('path');

const projectRoot = resolve(__dirname, '..');
const distRoot = resolve(projectRoot, 'dist');

if (dirname(distRoot) !== projectRoot || basename(distRoot) !== 'dist') {
    throw new Error(`拒绝清理非项目 dist 目录：${distRoot}`);
}

rmSync(distRoot, { recursive: true, force: true });
