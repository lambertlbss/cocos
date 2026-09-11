'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { LocalPrefabLibrary, matchLocalPrefabs, samePrefabSize } = require('../dist/importer/local-prefabs');

async function fixture(t) {
    const path = await mkdtemp(join(tmpdir(), 'figma-prefab-match-'));
    await mkdir(join(path, 'assets'));
    t.after(() => rm(path, { recursive: true, force: true }));
    const add = async (file, uuid, width = 100, height = 80, dependencies = []) => {
        await mkdir(join(path, 'assets', file, '..'), { recursive: true });
        const data = [
            { __type__: 'cc.Prefab', data: { __id__: 1 } },
            { __type__: 'cc.Node', _name: 'AuthoredRoot', _components: [{ __id__: 2 }],
                _lscale: { x: 1, y: 1, z: 1 }, _lrot: { x: 0, y: 0, z: 0, w: 1 } },
            { __type__: 'cc.UITransform', _contentSize: { width, height } },
            ...dependencies.map((id) => ({ __uuid__: id })),
        ];
        await writeFile(join(path, 'assets', file), JSON.stringify(data));
        await writeFile(join(path, 'assets', file + '.meta'), JSON.stringify({ importer: 'prefab', uuid }));
    };
    return { path, add };
}

test('Prefab matching compares rounded imported dimensions, not fuzzy proportions', () => {
    assert.equal(samePrefabSize(100.001, 79.999, { width: 100, height: 80 }), true);
    assert.equal(samePrefabSize(100.02, 80, { width: 100, height: 80 }), false);
    assert.equal(samePrefabSize(0, 0, { width: 0, height: 0 }), false);
});

test('only registered same-name same-size Prefabs match; roots retain authored names', async (t) => {
    const { path, add } = await fixture(t);
    await add('widgets/Card.prefab', 'card');
    await add('other/Card.prefab', 'small', 60, 80);
    const library = new LocalPrefabLibrary(path);
    await library.initialize();
    assert.deepEqual(await library.find('Card', 100, 80, new Set()), {
        uuid: 'card', url: 'db://assets/widgets/Card.prefab', width: 100, height: 80,
    });
    assert.equal(await library.find('RenamedCard', 100, 80, new Set()), null);
    assert.equal(await library.find('Card', 101, 80, new Set()), null);
});

test('ambiguous same-name and same-size resources fail instead of picking arbitrarily', async (t) => {
    const { path, add } = await fixture(t);
    await add('a/Card.prefab', 'a'); await add('b/Card.prefab', 'b');
    const library = new LocalPrefabLibrary(path); await library.initialize();
    await assert.rejects(library.find('Card', 100, 80, new Set()), /多个同名同尺寸/);
});

test('excludes output path/UUID, indirect back-references and dependency cycles', async (t) => {
    const { path, add } = await fixture(t);
    await add('A.prefab', 'a', 100, 80, ['b']);
    await add('B.prefab', 'b', 100, 80, ['target']);
    await add('C.prefab', 'c', 100, 80, ['d']);
    await add('D.prefab', 'd', 100, 80, ['c']);
    const library = new LocalPrefabLibrary(path); await library.initialize();
    assert.equal(await library.find('A', 100, 80, new Set(['target'])), null);
    assert.equal(await library.find('B', 100, 80, new Set(['db://assets/B.prefab'])), null);
    assert.equal(await library.find('B', 100, 80, new Set(['b'])), null);
    assert.equal(await library.find('C', 100, 80, new Set()), null);
});

test('root asset ownership is allowed but real self-references are rejected', async (t) => {
    const { path, add } = await fixture(t);
    for (const name of ['Owned', 'Recursive']) {
        await add(name + '.prefab', name);
        const file = join(path, 'assets', name + '.prefab');
        const data = JSON.parse(await readFile(file, 'utf8'));
        data[1]._prefab = { __id__: 3 };
        data.push({ __type__: 'cc.PrefabInfo', asset: { __uuid__: name } });
        if (name === 'Recursive') data.push({ __type__: 'cc.PrefabInfo', asset: { __uuid__: name } });
        await writeFile(file, JSON.stringify(data));
    }
    const library = new LocalPrefabLibrary(path); await library.initialize();
    assert.equal((await library.find('Owned', 100, 80, new Set())).uuid, 'Owned');
    assert.equal(await library.find('Recursive', 100, 80, new Set()), null);
});

test('matching uses original names and imported scale, cuts descendants, preserves ancestors', async () => {
    const root = { id: 'root', name: 'Root', type: 'FRAME', children: [
        { id: 'card', name: 'Card', type: 'FRAME', size: { width: 50, height: 40 }, children: [
            { id: 'image', name: 'LargeDownload', type: 'FRAME', children: [] },
        ] },
    ] };
    const decisions = new Map(['root', 'card', 'image'].map(id => [id, {
        action: 'render', kind: 'sprite', explicit: false, nineSlice: false, name: 'Renamed',
    }]));
    const calls = [];
    await matchLocalPrefabs([root], decisions, { async find(name, w, h) {
        calls.push([name, w, h]); return { uuid: 'card', url: 'db://assets/Card.prefab', width: w, height: h };
    } }, 2, new Set());
    assert.deepEqual(calls, [['Card', 100, 80]]);
    assert.equal(decisions.get('card').prefab.uuid, 'card');
    assert.equal(decisions.get('root').action, 'generate');
    assert.equal(decisions.get('root').prefab, undefined);
});

test('ignored/transform nodes and explicit flattened ancestors are not traversed', async () => {
    for (const action of ['ignore', 'transform', 'render']) {
        const root = { id: 'root', type: 'FRAME', children: [{ id: 'card', name: 'Card', type: 'FRAME', children: [] }] };
        const decisions = new Map([['root', { action, explicit: true }]]);
        await matchLocalPrefabs([root], decisions, { find() { assert.fail('must not search'); } }, 1, new Set());
    }
});
