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

test('raster lookup supports JPG/JPEG and honors an explicit original-name extension', async () => {
    await withLibrary(async (root) => {
        await writeFile(join(root, 'Panel.JPG'), 'jpeg');
        await writeFile(join(root, 'Photo.JPEG'), 'jpeg');
        await writeFile(join(root, 'Panel.png'), 'png');
        const library = new LocalResourceLibrary(root);
        assert.equal((await library.find('Panel', 'png')).path, join(root, 'Panel.png'));
        assert.equal((await library.find('Panel.JPG', 'png')).path, join(root, 'Panel.JPG'));
        assert.equal((await library.find('Photo', 'png')).path, join(root, 'Photo.JPEG'));
        assert.equal(await library.find('Photo', 'svg'), null);
    });
});

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

test('findAll exposes different same-name candidates including hidden and library/temp folders', async () => {
    await withLibrary(async (root) => {
        for (const folder of ['.hidden', 'library', 'temp']) {
            await mkdir(join(root, folder));
            await writeFile(join(root, folder, 'icon.png'), folder);
        }
        const library = new LocalResourceLibrary(root);
        const [first, second] = await Promise.all([library.findAll('icon', 'png'), library.findAll('ICON', 'png')]);
        assert.equal(first.length, 3);
        assert.equal(second.length, 3);
        assert.equal(new Set(first.map((item) => item.path)).size, 3, 'concurrent initialization must not duplicate paths');
        assert.equal(new Set(first.map((item) => item.contents.toString())).size, 3);
    });
});

test('failed index initialization can retry without retaining a partial index', async () => {
    await withLibrary(async (root) => {
        const selected = join(root, 'not-created');
        const library = new LocalResourceLibrary(selected);
        await assert.rejects(library.initialize(), { code: 'ENOENT' });
        await mkdir(selected);
        await writeFile(join(selected, 'icon.png'), 'pixels');
        assert.equal((await library.findAll('icon', 'png')).length, 1);
    });
});
