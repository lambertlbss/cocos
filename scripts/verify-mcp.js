'use strict';

const { mkdtempSync, readFileSync, readdirSync, rmSync, copyFileSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const { basename, dirname, join, resolve } = require('path');
const { spawnSync } = require('child_process');

const projectRoot = resolve(__dirname, '..');
const outputRoot = resolve(projectRoot, 'mcp-dist');
const outputFile = join(outputRoot, 'server.js');
const failures = [];

function runNode(args, cwd = projectRoot, timeout = 15_000) {
    return spawnSync(process.execPath, args, {
        cwd,
        shell: false,
        encoding: 'utf8',
        timeout,
    });
}

if (!existsSync(outputFile)) {
    failures.push('缺少 mcp-dist/server.js');
} else {
    const entries = readdirSync(outputRoot);
    if (entries.length !== 1 || entries[0] !== 'server.js') {
        failures.push(`mcp-dist 只能包含 server.js，当前为：${entries.join(', ')}`);
    }
    const syntax = runNode(['--check', outputFile]);
    if (syntax.status !== 0) failures.push(`MCP bundle 语法检查失败：${syntax.stderr.trim()}`);

    const help = runNode([outputFile, '--help']);
    if (help.status !== 0 || !help.stdout.includes('Figma Importer')) {
        failures.push(`MCP --help 失败：${(help.stderr || help.stdout).trim()}`);
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), 'figma-importer-mcp-verify-'));
    try {
        const temporaryBundle = join(temporaryRoot, 'server.js');
        copyFileSync(outputFile, temporaryBundle);
        const smoke = runNode([
            '-e',
            "const api=require('./server.js');const ok=typeof api.createMcpServer==='function'&&typeof api.createBridgeClient==='function';process.stdout.write(ok?'ok':'bad');process.exitCode=ok?0:1;",
        ], temporaryRoot);
        if (smoke.status !== 0 || smoke.stdout !== 'ok') {
            failures.push(`MCP 单文件脱离仓库加载失败：${(smoke.stderr || smoke.stdout).trim()}`);
        }
    } finally {
        if (dirname(temporaryRoot) === tmpdir() && basename(temporaryRoot).startsWith('figma-importer-mcp-verify-')) {
            rmSync(temporaryRoot, { recursive: true, force: true });
        }
    }

    const source = readFileSync(outputFile, 'utf8');
    if (!source.startsWith('#!/usr/bin/env node')) failures.push('MCP bundle 缺少 Node shebang');
    const forbiddenSymbols = [
        'roundtrip',
        'Round-trip',
        'setToken',
        'set-token',
        'clearToken',
        'clear-token',
        'verifyToken',
        'verify-token',
        'pickLocalResourceFolder',
        'pick-local-resource-folder',
        'roundtripDetect',
        'roundtripPreview',
        'roundtripPair',
        'roundtripApply',
        'roundtripCancel',
    ];
    const leakedSymbols = forbiddenSymbols.filter((symbol) => source.includes(symbol));
    if (leakedSymbols.length) {
        failures.push(`MCP bundle 包含未开放能力符号：${leakedSymbols.join(', ')}`);
    }

    const protocolSmoke = runNode(['--test', 'tests/mcp-server.test.js'], projectRoot, 30_000);
    if (protocolSmoke.status !== 0) {
        failures.push(`MCP initialize/tools/list 协议检查失败：${(protocolSmoke.stderr || protocolSmoke.stdout).trim()}`);
    }
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', 'mcp-dist/server.js'], {
        cwd: projectRoot,
        shell: false,
    });
    if (ignored.status === 0) failures.push('mcp-dist/server.js 被 Git 忽略，无法随插件分发');
}

if (failures.length) {
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
} else {
    console.log('MCP 分发检查通过：单文件 bundle 可脱离 node_modules 加载。');
}
