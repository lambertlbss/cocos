'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { LocalResourceLibrary } = require('../dist/importer/local-resources');

async function withLibrary(run) {
    const root = await mkdtemp(join(tmpdir(), 'figma-importer-library-test-'));
    try {
        await run(root);
    } finally {
        const safeRoot = resolve(root);
        assert.equal(safeRoot.startsWith(resolve(tmpdir())), true);
        await rm(safeRoot, { recursive: true, force: true });
    }
}

test('recursively finds same-named local assets without case sensitivity', async () => {
    await withLibrary(async (root) => {
        const nested = join(root, 'ui', 'icons');
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, 'Button_Start.PNG'), Buffer.from('local-png'));

        const match = await new LocalResourceLibrary(root).find('Button Start', 'png');

        assert.equal(match?.path, join(nested, 'Button_Start.PNG'));
        assert.deepEqual(match?.contents, Buffer.from('local-png'));
    });
});

test('prefers a root-level match when nested folders contain the same filename', async () => {
    await withLibrary(async (root) => {
        const nested = join(root, 'legacy');
        await mkdir(nested);
        await writeFile(join(root, 'icon.svg'), '<svg>root</svg>');
        await writeFile(join(nested, 'icon.svg'), '<svg>nested</svg>');

        const match = await new LocalResourceLibrary(root).find('icon', 'svg');

        assert.equal(match?.path, join(root, 'icon.svg'));
        assert.equal(match?.contents.toString(), '<svg>root</svg>');
    });
});

test('uses the first deterministic match when folders contain duplicate names', async () => {
    await withLibrary(async (root) => {
        await mkdir(join(root, 'a'));
        await mkdir(join(root, 'b'));
        await writeFile(join(root, 'a', 'panel.png'), Buffer.from('a'));
        await writeFile(join(root, 'b', 'panel.png'), Buffer.from('b'));

        const match = await new LocalResourceLibrary(root).find('panel', 'png');

        assert.equal(match?.path, join(root, 'a', 'panel.png'));
        assert.deepEqual(match?.contents, Buffer.from('a'));
    });
});
