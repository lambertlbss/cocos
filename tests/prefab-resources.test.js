'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { collectPrefabReferences, resolvePrefabReferences } = require('../dist/importer/prefab-resources');

const UUID_A = '12345678-1234-5678-1234-567812345678';
const COMPRESSED_A = '12NFZ4EjRWeBI0VngSNFZ4';
const UUID_B = '22345678-1234-5678-1234-567812345678';
const UUID_C = '32345678-1234-5678-1234-567812345678';

function reference(id, prefabName, children = [], visible = true) {
    return { id, name: `Node ${id}`, prefabName, children, visible };
}

function prefabContents(uuid, dependencies = []) {
    return [
        { __type__: 'cc.Prefab', _uuid: uuid, data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'TemplateRoot', _prefab: { __id__: 2 } },
        { __type__: 'cc.PrefabInfo', asset: { __id__: 0 }, root: { __id__: 1 }, fileId: 'TemplateRootFileId' },
        ...dependencies.map((dependency) => ({
            __type__: 'cc.PrefabInfo', asset: { __uuid__: dependency }, fileId: 'NestedTemplateFileId',
        })),
    ];
}

async function fixture(t) {
    const projectPath = await mkdtemp(join(tmpdir(), 'figma-prefab-resources-'));
    const assetsPath = join(projectPath, 'assets');
    await mkdir(assetsPath);
    t.after(async () => {
        const withinTemp = relative(resolve(tmpdir()), resolve(projectPath));
        assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
        await rm(projectPath, { recursive: true, force: true });
    });
    const infos = new Map();
    const queries = [];
    const add = async (assetPath, uuid, contents = prefabContents(uuid), meta = true) => {
        const path = join(assetsPath, assetPath);
        const url = `db://assets/${assetPath.replace(/\\/g, '/')}`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
        if (meta) await writeFile(`${path}.meta`, JSON.stringify({ uuid, importer: 'prefab' }));
        infos.set(url, { uuid, url, imported: true, invalid: false, importer: 'prefab', type: 'cc.Prefab', isDirectory: false });
        return { path, url };
    };
    const options = {
        projectPath,
        queryAsset: async (url) => { queries.push(url); return infos.get(url) ?? null; },
    };
    return { projectPath, assetsPath, add, infos, queries, options };
}

test('no prefab references require no project access or AssetDB lookup', async () => {
    const inaccessibleOptions = new Proxy({}, { get() { throw new Error('empty lookup must not access options or I/O'); } });
    assert.equal((await resolvePrefabReferences([], inaccessibleOptions)).size, 0);
    assert.deepEqual(collectPrefabReferences([], () => { throw new Error('no nodes'); }), []);
});

test('collector honors hidden and ignored ancestors and only takes the outermost prefab binding', () => {
    const nested = reference('nested', 'Nested');
    const outer = reference('outer', 'Outer', [nested]);
    const hidden = reference('hidden-parent', undefined, [reference('hidden-child', 'Hidden')], false);
    const ignored = reference('ignored-parent', undefined, [reference('ignored-child', 'Ignored')]);
    const render = reference('render-parent', undefined, [reference('render-child', 'RenderedAway')]);
    const transform = reference('transform-parent', undefined, [reference('transform-child', 'TransformedAway')]);
    const sliced = reference('slice-parent', undefined, [reference('slice-child', 'SlicedAway')]);
    const decisions = new Map([
        ['ignored-parent', { action: 'ignore' }], ['render-parent', { action: 'render' }],
        ['transform-parent', { action: 'transform' }], ['slice-parent', { action: 'generate', nineSlice: true }],
    ]);
    const decision = (node) => ({ action: 'generate', kind: 'node', nineSlice: false, ...decisions.get(node.id) });
    const roots = [outer, hidden, ignored, render, transform, sliced];
    assert.deepEqual(collectPrefabReferences(roots, decision, false).map((node) => node.id), ['outer']);
    assert.deepEqual(collectPrefabReferences(roots, decision, true).map((node) => node.id), ['outer', 'hidden-child']);
    assert.equal(outer.children[0], nested, 'collection never prunes the original source tree');
});

test('collector lets a node own prefab parameter win over its render or transform action, except ignore', () => {
    const nodes = ['render', 'transform', 'ignore'].map((action) => reference(action, 'Asset'));
    const found = collectPrefabReferences(nodes, (node) => ({ action: node.id, kind: 'sprite', nineSlice: true }));
    assert.deepEqual(found.map((node) => node.id), ['render', 'transform']);
    assert.deepEqual(collectPrefabReferences([reference('blank', '  ')], () => ({
        action: 'generate', kind: 'node', nineSlice: false,
    })), []);
});

test('recursively finds a uniquely named prefab and binds each Figma ID without modifying source assets', async (t) => {
    const f = await fixture(t);
    const candidate = await f.add('ui/common/CommonButton.PREFAB', UUID_A);
    await writeFile(join(f.assetsPath, 'CommonButton.png'), 'not-a-prefab');
    const before = await readFile(candidate.path);
    const result = await resolvePrefabReferences([reference('figma:first', '  commonbutton.prefab  ')], f.options);
    assert.deepEqual([...result.keys()], ['figma:first']);
    assert.deepEqual(result.get('figma:first'), { name: 'CommonButton', uuid: UUID_A, url: candidate.url });
    assert.deepEqual(f.queries, [candidate.url]);
    assert.deepEqual(await readFile(candidate.path), before);
});

test('two Figma nodes sharing one prefab use the same verified identity and one AssetDB query', async (t) => {
    const f = await fixture(t);
    await f.add('ui/CommonButton.prefab', UUID_A);
    const result = await resolvePrefabReferences([
        reference('figma:a', 'CommonButton'), reference('figma:b', 'COMMONBUTTON.PREFAB'),
    ], f.options);
    assert.equal(result.size, 2);
    assert.equal(result.get('figma:a'), result.get('figma:b'));
    assert.equal(f.queries.length, 1);
});

test('compressed and full UUID identities match, while mismatched Meta and AssetDB identities fail', async (t) => {
    const f = await fixture(t);
    const candidate = await f.add('CommonButton.prefab', COMPRESSED_A);
    f.infos.set(candidate.url, { ...f.infos.get(candidate.url), uuid: UUID_A });
    assert.equal((await resolvePrefabReferences([reference('id', 'CommonButton')], f.options)).get('id').uuid, UUID_A);
    f.infos.set(candidate.url, { ...f.infos.get(candidate.url), uuid: UUID_B });
    await assert.rejects(resolvePrefabReferences([reference('id', 'CommonButton')], f.options), /身份不一致/);
});

test('ambiguous normalized prefab names fail instead of choosing the first folder', async (t) => {
    const f = await fixture(t);
    await f.add('a/CommonButton.prefab', UUID_A);
    await f.add('b/ＣｏｍｍｏｎＢｕｔｔｏｎ.PREFAB', UUID_B);
    await assert.rejects(resolvePrefabReferences([reference('id', 'commonbutton')], f.options), (error) => {
        assert.match(error.message, /多个同名资源/);
        assert.match(error.message, /a\/CommonButton/);
        assert.match(error.message, /b\/ＣｏｍｍｏｎＢｕｔｔｏｎ/);
        return true;
    });
    assert.equal(f.queries.length, 0, 'ambiguous selection never queries a preferred candidate');
});

test('missing prefab and a path supplied instead of a name fail preflight', async (t) => {
    const f = await fixture(t);
    await assert.rejects(resolvePrefabReferences([reference('id', 'NotFound')], f.options), /NotFound.*不存在/);
    for (const name of ['ui/Button', '..\\Button', '.prefab', 'Button\u0000']) {
        await assert.rejects(resolvePrefabReferences([reference('id', name)], f.options), /必须填写 Prefab 名称/);
    }
    assert.equal(f.queries.length, 0);
});

test('selected prefab must be imported, correctly typed and located at the verified AssetDB URL', async (t) => {
    const f = await fixture(t);
    const candidate = await f.add('Button.prefab', UUID_A);
    const ready = f.infos.get(candidate.url);
    for (const patch of [null, { uuid: '' }, { imported: false }, { invalid: true },
        { isDirectory: true }, { importer: 'image' }, { type: 'cc.SpriteFrame' },
        { redirect: { uuid: UUID_B } }, { url: 'db://assets/other.prefab' }]) {
        f.infos.set(candidate.url, patch === null ? null : { ...ready, ...patch });
        await assert.rejects(resolvePrefabReferences([reference('id', 'Button')], f.options), /尚未在 Cocos 中就绪或身份不一致/);
    }
});

test('real Creator local PrefabInfo asset references do not falsely become self-dependencies', async (t) => {
    const f = await fixture(t);
    const contents = JSON.parse(await readFile(join(__dirname, 'fixtures', 'creator387-project', 'assets', 'roundtrip-fixture.prefab'), 'utf8'));
    assert.deepEqual(contents.find((entry) => entry.__type__ === 'cc.PrefabInfo').asset, { __id__: 0 });
    await f.add('CommonItemIcon.prefab', UUID_A, contents);
    const resolved = await resolvePrefabReferences([reference('id', 'CommonItemIcon')], f.options);
    assert.equal(resolved.get('id').uuid, UUID_A);
});

test('custom script Prefab fields do not count as instantiated nested prefab dependencies', async (t) => {
    const f = await fixture(t);
    const contents = prefabContents(UUID_A);
    contents.push({ __type__: 'ExampleSpawner', selfTemplate: { __uuid__: COMPRESSED_A },
        deferredOutputTemplate: { __uuid__: UUID_B }, arbitraryAsset: { __uuid__: UUID_C } });
    await f.add('Template.prefab', UUID_A, contents);
    const output = await f.add('Output.prefab', UUID_B);
    const resolved = await resolvePrefabReferences([reference('id', 'Template')], {
        ...f.options, forbiddenUrls: [output.url],
    });
    assert.equal(resolved.get('id').uuid, UUID_A);
    assert.equal(f.queries.length, 1, 'script asset fields do not cause dependency imports or lookups');
});

test('a selected output prefab is rejected by URL or equivalent compressed UUID', async (t) => {
    const f = await fixture(t);
    const candidate = await f.add('Output.prefab', UUID_A);
    await assert.rejects(resolvePrefabReferences([reference('id', 'Output')], {
        ...f.options, forbiddenUrls: [candidate.url.toUpperCase()],
    }), /本次输出目标/);
    await assert.rejects(resolvePrefabReferences([reference('id', 'Output')], {
        ...f.options, forbiddenUuids: [COMPRESSED_A],
    }), /本次输出目标/);
});

test('a same-named import output is excluded so repeated root replacement still selects its original source', async (t) => {
    const f = await fixture(t);
    const source = await f.add('source/common/Icon.prefab', UUID_A);
    const output = await f.add('output/Icon.prefab', UUID_B);
    const result = await resolvePrefabReferences([reference('root', 'Icon')], {
        ...f.options, forbiddenUrls: [output.url],
    });
    assert.deepEqual(result.get('root'), { name: 'Icon', uuid: UUID_A, url: source.url });
    assert.deepEqual(f.queries, [source.url], 'the generated carrier is never queried as a replacement source');
});

test('a same-named output moved to an old path is excluded by its bound UUID', async (t) => {
    const f = await fixture(t);
    const source = await f.add('source/common/Icon.prefab', UUID_B);
    await f.add('previous-output-location/Icon.prefab', UUID_A);
    const result = await resolvePrefabReferences([reference('root', 'Icon')], {
        ...f.options, forbiddenUuids: [COMPRESSED_A],
    });
    assert.deepEqual(result.get('root'), { name: 'Icon', uuid: UUID_B, url: source.url });
    assert.deepEqual(f.queries, [source.url]);
});

test('excluded same-named output candidates remain indexed for nested dependency cycle protection', async (t) => {
    const f = await fixture(t);
    await f.add('source/common/Icon.prefab', UUID_A, prefabContents(UUID_A, [UUID_B]));
    const output = await f.add('output/Icon.prefab', UUID_B);
    await assert.rejects(resolvePrefabReferences([reference('root', 'Icon')], {
        ...f.options, forbiddenUrls: [output.url],
    }), /间接引用了本次输出目标/);
});

test('excluding one output never hides other same-named prefab sources in its directory', async (t) => {
    const f = await fixture(t);
    await f.add('source/common/Icon.prefab', UUID_A);
    const output = await f.add('output/Icon.prefab', UUID_B);
    const otherSource = await f.add('output/reusable/Icon.prefab', UUID_C);
    await assert.rejects(resolvePrefabReferences([reference('root', 'Icon')], {
        ...f.options, forbiddenUrls: [output.url],
    }), (error) => {
        assert.match(error.message, /多个同名资源/);
        assert.ok(error.message.includes(otherSource.url));
        return true;
    });
    assert.equal(f.queries.length, 0);
});

test('nested prefab dependency paths cannot lead back to this import output', async (t) => {
    const f = await fixture(t);
    await f.add('Template.prefab', UUID_A, prefabContents(UUID_A, [UUID_B]));
    await f.add('Inner.prefab', UUID_B, prefabContents(UUID_B, [UUID_C]));
    const output = await f.add('Output.prefab', UUID_C);
    await assert.rejects(resolvePrefabReferences([reference('id', 'Template')], {
        ...f.options, forbiddenUrls: [output.url],
    }), /间接引用了本次输出目标/);
});

test('direct and indirect prefab dependency cycles fail, including a ready asset without Meta', async (t) => {
    const direct = await fixture(t);
    await direct.add('Self.prefab', UUID_A, prefabContents(UUID_A, [COMPRESSED_A]));
    await assert.rejects(resolvePrefabReferences([reference('self', 'Self')], direct.options), /循环引用/);
    const withoutMeta = await fixture(t);
    await withoutMeta.add('SelfWithoutMeta.prefab', UUID_B, prefabContents(UUID_B, [UUID_B]), false);
    await assert.rejects(resolvePrefabReferences([reference('without-meta', 'SelfWithoutMeta')], withoutMeta.options), /循环引用/);
    const f = await fixture(t);
    await f.add('A.prefab', UUID_A, prefabContents(UUID_A, [UUID_B]));
    await f.add('B.prefab', UUID_B, prefabContents(UUID_B, [UUID_C]));
    await f.add('C.prefab', UUID_C, prefabContents(UUID_C, [UUID_A]));
    await assert.rejects(resolvePrefabReferences([reference('cycle', 'A')], f.options), /循环引用/);
});

test('shared acyclic dependencies and non-prefab resource UUIDs do not form false cycles', async (t) => {
    const f = await fixture(t);
    await f.add('A.prefab', UUID_A, prefabContents(UUID_A, [UUID_C, 'non-prefab-texture@f9941']));
    await f.add('B.prefab', UUID_B, prefabContents(UUID_B, [UUID_C]));
    await f.add('Shared.prefab', UUID_C);
    const result = await resolvePrefabReferences([reference('a', 'A'), reference('b', 'B')], f.options);
    assert.equal(result.size, 2);
});

test('unreadable prefab contents and cancelled preflight stop before producing bindings', async (t) => {
    const f = await fixture(t);
    await f.add('Broken.prefab', UUID_A, '{invalid-json');
    await assert.rejects(resolvePrefabReferences([reference('broken', 'Broken')], f.options), /无法读取 Prefab 内容/);
    await f.add('Broken.prefab', UUID_A, '{}');
    await assert.rejects(resolvePrefabReferences([reference('broken', 'Broken')], f.options), /Prefab 内容格式无效/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(resolvePrefabReferences([reference('cancelled', 'Broken')], {
        ...f.options, signal: controller.signal,
    }), { name: 'AbortError' });
});
