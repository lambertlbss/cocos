'use strict';

const { builtinModules } = require('module');
const { existsSync, readFileSync, readdirSync, statSync } = require('fs');
const { dirname, extname, join, normalize, resolve } = require('path');
const { spawnSync } = require('child_process');

const projectRoot = resolve(__dirname, '..');
const packagePath = join(projectRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const failures = [];
const hostModules = new Set(['cc', 'electron']);

function relativeToProject(filePath) {
    return normalize(filePath.slice(projectRoot.length + 1)).replace(/\\/g, '/');
}

function resolveModuleEntry(entry) {
    const absolute = resolve(projectRoot, entry);
    const candidates = [
        absolute,
        `${absolute}.js`,
        join(absolute, 'index.js'),
    ];
    return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function requireEntry(label, entry) {
    if (typeof entry !== 'string' || !entry.trim()) {
        failures.push(`${label} 未声明有效入口`);
        return;
    }
    if (!resolveModuleEntry(entry)) {
        failures.push(`${label} 缺少构建产物：${entry}`);
    }
}

function requireFile(label, filePath) {
    if (!existsSync(join(projectRoot, filePath))) {
        failures.push(`${label} 缺少运行文件：${filePath}`);
    }
}

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = join(directory, entry.name);
        return entry.isDirectory() ? walk(absolute) : [absolute];
    });
}

function localRequireExists(fromFile, specifier) {
    const absolute = resolve(dirname(fromFile), specifier);
    return [absolute, `${absolute}.js`, `${absolute}.json`, join(absolute, 'index.js')]
        .some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function isBuiltin(specifier) {
    const root = specifier.replace(/^node:/, '').split('/')[0];
    return builtinModules.includes(specifier)
        || builtinModules.includes(root)
        || hostModules.has(specifier);
}

function smokeLoadEntries() {
    const previousEditor = global.Editor;
    global.Editor = {
        App: { path: projectRoot },
        Panel: {
            define(value) { return value; },
            open() {},
        },
    };
    try {
        const main = require(resolve(projectRoot, packageJson.main));
        if (typeof main.methods?.openPanel !== 'function') {
            failures.push('主进程已加载，但没有导出 methods.openPanel');
        }
        const scene = require(resolve(projectRoot, packageJson.contributions.scene.script));
        if (typeof scene.methods?.importDocument !== 'function') {
            failures.push('Scene Script 已加载，但没有导出 methods.importDocument');
        }
        for (const [name, panel] of Object.entries(packageJson.panels ?? {})) {
            const entry = resolveModuleEntry(panel.main);
            if (entry) {
                const loaded = require(entry);
                if (typeof loaded.ready !== 'function') {
                    failures.push(`面板 ${name} 已加载，但没有导出 ready`);
                }
            }
        }
    } catch (error) {
        failures.push(`Cocos 入口冒烟加载失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        global.Editor = previousEditor;
    }
}

requireEntry('主进程', packageJson.main);
requireEntry('Scene Script', packageJson.contributions?.scene?.script);
for (const [name, panel] of Object.entries(packageJson.panels ?? {})) {
    requireEntry(`面板 ${name}`, panel.main);
}
requireFile('面板模板', 'static/template/default/index.html');
requireFile('面板样式', 'static/style/default/index.css');
requireFile('中文语言包', 'i18n/zh.js');
requireFile('英文语言包', 'i18n/en.js');

const distRoot = join(projectRoot, 'dist');
if (!existsSync(distRoot)) {
    failures.push('缺少 dist 目录');
} else {
    const javascriptFiles = walk(distRoot).filter((filePath) => extname(filePath) === '.js');
    const requirePattern = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const filePath of javascriptFiles) {
        const source = readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(requirePattern)) {
            const specifier = match[1];
            if (specifier.startsWith('.')) {
                if (!localRequireExists(filePath, specifier)) {
                    failures.push(`${relativeToProject(filePath)} 引用了缺失的本地模块：${specifier}`);
                }
            } else if (!isBuiltin(specifier)) {
                failures.push(`${relativeToProject(filePath)} 仍依赖未随插件分发的模块：${specifier}`);
            }
        }
    }

    const gitCheck = spawnSync('git', ['check-ignore', '--quiet', '--', 'dist/main.js'], {
        cwd: projectRoot,
        shell: false,
    });
    if (gitCheck.status === 0) {
        failures.push('dist 仍被 Git 忽略，仓库下载后将缺少构建产物');
    }
}

if (!failures.length) {
    smokeLoadEntries();
}

if (failures.length) {
    for (const failure of failures) {
        console.error(`- ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log('分发检查通过：Cocos 主进程、Scene、面板及运行时模块均可直接加载。');
}
