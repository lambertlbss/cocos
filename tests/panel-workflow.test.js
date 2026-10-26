'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createPanelDocument } = require('./helpers/panel-dom');
const packageJSON = require('../package.json');

const sourceA = 'https://www.figma.com/design/example?node-id=1-1';
const sourceB = 'https://www.figma.com/design/example?node-id=2-1';
const settings = () => ({
    sourceUrl: sourceA,
    assetFolder: 'ui/images',
    prefabFolder: 'ui/prefabs',
    localResourceFolders: ['C:/art/common', 'C:/art/icons', ''],
    localResourceFolder: 'C:/art/common',
    scale: 1.5,
    updateExisting: true,
    refreshAssets: false,
    autoSave: false,
    fontMap: { Inter: 'db://assets/fonts/Inter.ttf', Other: 'db://assets/fonts/Other.ttf' },
});
const fontAssets = [
    { name: 'Inter', url: 'db://assets/fonts/Inter.ttf', relativePath: 'fonts/Inter.ttf' },
    { name: 'Replacement', url: 'db://assets/fonts/Replacement.ttf', relativePath: 'fonts/Replacement.ttf' },
];
function design({ id = '1:1', sourceUrl = sourceA, fileName = 'First design' } = {}) {
    return {
        fileKey: 'example', fileName, sourceUrl, fonts: ['Inter'], fontAssets,
        tree: [{ id, name: 'Main', type: 'FRAME', width: 640, height: 480,
            visible: true, action: 'generate', kind: 'node', patchCandidate: false, children: [
                { id: `${id}:child`, name: 'Title', type: 'TEXT', width: 120, height: 30,
                    visible: true, action: 'generate', kind: 'label', patchCandidate: false, children: [] },
            ] }],
    };
}
function review(id) {
    const scene = { rootUuid: 'root', targetUuid: 'target', mode: 'scene', nodes: [] };
    return { id, createdAt: '2026-10-19T00:00:00Z', fileName: 'First design', assets: [],
        before: scene, after: scene, sourceTree: [], changes: [], warnings: [], confirmed: false };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() { for (let count = 0; count < 36; count++) await Promise.resolve(); }

async function panelFixture(t, options = {}) {
    const document = createPanelDocument(fs.readFileSync(path.resolve('static/template/default/index.html'), 'utf8'));
    const root = document.querySelector('#app');
    const requests = [];
    const reviews = [];
    const reviewTabs = [];
    const handlers = { ...options.handlers };
    const initial = {
        version: packageJSON.version,
        vault: { hasToken: true, persistent: true, backend: 'test vault' },
        settings: settings(),
        document: options.empty ? null : design(),
        fontAssets,
        ...options.initial,
    };
    const request = async (_name, message, ...args) => {
        requests.push({ message, args });
        if (handlers[message]) {
            const result = await handlers[message](...args);
            return message === 'resolve-batch-source' && result?.tree
                ? { sourceType: 'node', sourceUrl: result.sourceUrl, items: [], added: 0, duplicates: 0, document: result }
                : result;
        }
        if (message === 'get-state') return initial;
        if (message === 'get-import-review') return options.replayReview ?? null;
        if (message === 'resolve-batch-source') return { sourceType: 'node', sourceUrl: sourceA, items: [], added: 0, duplicates: 0, document: design() };
        if (message === 'get-preview') return { url: 'data:image/png;base64,AA==' };
        if (message === 'set-token' || message === 'clear-token') return initial.vault;
        if (message === 'verify-token') return { handle: 'test user' };
        if (message === 'save-node-overrides') return args[1];
        return undefined;
    };
    const compiled = path.resolve('dist/panels/default/index.js');
    const module = { exports: {} };
    const nativeRequire = createRequire(compiled);
    const timers = new Map();
    let nextTimer = 0;
    vm.runInNewContext(fs.readFileSync(compiled, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(compiled), __filename: compiled,
        require(name) {
            if (name === './import-review') return {
                ImportReviewPanel: class {
                    open(report) {
                        reviews.push(report);
                        const dialog = root.querySelector('#import-review-dialog');
                        const tabs = dialog.querySelector('.review-tabs');
                        tabs.replaceChildren();
                        for (const [key, text] of [['assets', '资源对比'], ['nodes', '导入前后节点'], ['source', 'Figma → Cocos']]) {
                            const button = document.createElement('button');
                            button.textContent = text;
                            button.onclick = () => reviewTabs.push(key);
                            tabs.appendChild(button);
                        }
                        dialog.showModal();
                    }
                    dispose() {}
                },
            };
            return nativeRequire(name);
        },
        Editor: { Panel: { define: (definition) => definition }, Message: { request } },
        document, console, URL, Error,
        setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        requestAnimationFrame(callback) { callback(); return 0; },
        cancelAnimationFrame() {},
        HTMLElement: Object, HTMLInputElement: Object, HTMLSelectElement: Object,
    }, { filename: compiled });
    const panel = module.exports;
    const host = { $: { app: root } };
    await panel.ready.call(host);
    t.after(() => panel.close.call(host));
    const get = (selector) => {
        const element = root.querySelector(selector);
        assert.ok(element, `Panel element exists: ${selector}`);
        return element;
    };
    const click = (selector) => get(selector).click();
    const step = () => Number(root.dataset.workflowStep);
    const calls = (message) => requests.filter((call) => call.message === message);
    const goToConfirm = async () => {
        assert.equal(step(), 2);
        await click('#workflow-next');
        assert.equal(step(), 3);
    };
    return { root, document, panel, host, requests, reviews, reviewTabs, handlers, get, click, step, calls, goToConfirm };
}

test('workflow gates future steps and importing until a design is read and settings are confirmed', async (t) => {
    const ui = await panelFixture(t, { empty: true });
    assert.equal(ui.step(), 1);
    for (const step of [2, 3, 4]) {
        assert.equal(ui.get(`[data-workflow-step="${step}"]`).disabled, true);
        await ui.click(`[data-workflow-step="${step}"]`);
        assert.equal(ui.step(), 1);
    }
    // Even a programmatically dispatched click must not bypass the workflow.
    await ui.get('#import-button').emit('click');
    assert.equal(ui.calls('import-selection').length, 0);

    await ui.click('#fetch-document');
    assert.equal(ui.calls('resolve-batch-source').length, 1);
    assert.equal(ui.step(), 2);
    assert.equal(ui.get('[data-workflow-panel="1"]').hidden, true);
    assert.equal(ui.get('[data-workflow-panel="2"]').hidden, false);
    assert.equal(ui.get('[data-workflow-step="3"]').disabled, true);
    await ui.get('#import-button').emit('click');
    assert.equal(ui.calls('import-selection').length, 0);
    await ui.goToConfirm();
    assert.equal(ui.get('#import-button').disabled, false);
    assert.equal(ui.get('#selection-summary').textContent, '2 / 2 个节点将参与导入');
    assert.equal(ui.calls('import-selection').length, 0);
});

test('freshly fetched inspector controls unlock while Figma slice definitions stay locked on', async (t) => {
    for (const patchCandidate of [false, true]) {
        const fetched = design();
        Object.assign(fetched.tree[0], { patchCandidate, sliceMode: patchCandidate ? 'nine' : undefined });
        const ui = await panelFixture(t, { empty: true, handlers: { 'resolve-batch-source': () => fetched } });
        assert.equal(ui.step(), 1);
        await ui.click('#fetch-document');
        assert.equal(ui.calls('resolve-batch-source').length, 1);
        assert.equal(ui.step(), 2);
        for (const attribute of ['name-for', 'action-for', 'kind-for']) {
            assert.equal(ui.get(`[data-${attribute}="1:1"]`).disabled, false,
                `${attribute} unlocks after a fresh read`);
        }
        const slice = ui.get('[data-patch-for="1:1"]');
        assert.equal(slice.disabled, true);
        assert.equal(slice.checked, patchCandidate);
    }
});

test('historical slice off settings and presets serialize the current Figma definition', async (t) => {
    const document = design();
    Object.assign(document.tree[0], { patchCandidate: true, sliceMode: 'nine', reason: 'slice-resource' });
    document.nodeOverrides = [{ id: '1:1', action: 'transform', kind: 'button', nineSlice: false, explicit: true }];
    const ui = await panelFixture(t, { initial: { document } });
    const assertSlice = () => {
        assert.equal(ui.get('[data-action-for="1:1"]').value, 'render');
        assert.equal(ui.get('[data-patch-for="1:1"]').checked, true);
        assert.equal(ui.get('[data-patch-for="1:1"]').disabled, true);
        assert.match(ui.get('.node-inspector-note').textContent, /Figma 分片优先/);
    };
    assertSlice();
    assert.equal(ui.get('[data-kind-for="1:1"]').value, 'button');
    const patch = ui.get('[data-patch-for="1:1"]'); patch.checked = false;
    await ui.root.emit('change', { target: patch }); assertSlice();
    for (const preset of ['editable', 'bitmap', 'smart']) {
        // The third preset may use another label; exercise its actual fallback branch.
        const button = preset === 'bitmap'
            ? [...ui.root.querySelectorAll('[data-preset]')].find((item) => !['editable', 'smart'].includes(item.dataset.preset))
            : ui.get(`[data-preset="${preset}"]`);
        assert.ok(button); await button.click(); await flush(); assertSlice();
    }
    const action = ui.get('[data-action-for="1:1"]'); action.value = 'ignore';
    await ui.root.emit('change', { target: action }); await flush();
    assert.equal(ui.get('[data-action-for="1:1"]').value, 'ignore');
    const savedIgnore = ui.calls('save-node-overrides').at(-1).args[1].find((item) => item.id === '1:1');
    assert.equal(savedIgnore.action, 'ignore');
    await ui.click('[data-preset="smart"]');
    await ui.goToConfirm(); await ui.click('#import-button'); await flush();
    const serialized = ui.calls('import-selection').at(-1).args[0].overrides.find((item) => item.id === '1:1');
    assert.equal(serialized.action, 'render');
    assert.equal(serialized.nineSlice, true);
});

test('back and forward keep directory, font, node strategy, rename and selection without backend calls', async (t) => {
    const ui = await panelFixture(t);
    assert.equal(ui.step(), 2);
    const node = ui.get('[data-node-id="1:1:child"]');
    await ui.get('#tree').emit('click', { target: node });
    await flush();
    const name = ui.get('[data-name-for="1:1:child"]');
    name.value = 'Custom_Title';
    await ui.root.emit('change', { target: name });
    const action = ui.get('[data-action-for="1:1:child"]');
    action.value = 'render';
    await ui.root.emit('change', { target: action });
    await flush();
    await ui.goToConfirm();
    ui.get('#asset-folder').value = 'custom/images';
    ui.get('#prefab-folder').value = 'custom/prefabs';
    ui.get('#local-resource-folder-1').value = 'C:/custom/icons';
    ui.get('#scale').value = '2';
    const font = ui.get('[data-font-family="Inter"]');
    font.value = fontAssets[1].url;
    await ui.get('#font-map-list').emit('change', { target: font });
    await flush();
    const requestCount = ui.requests.length;

    await ui.click('#workflow-back');
    assert.equal(ui.step(), 2);
    assert.equal(ui.get('[data-name-for="1:1:child"]').value, 'Custom_Title');
    assert.equal(ui.get('[data-action-for="1:1:child"]').value, 'render');
    assert.equal(ui.get('[data-node-id="1:1:child"]').classList.contains('is-selected'), true);
    await ui.click('#workflow-back');
    assert.equal(ui.step(), 1);
    await ui.click('#fetch-document');
    assert.equal(ui.step(), 2);
    await ui.goToConfirm();
    assert.equal(ui.get('#asset-folder').value, 'custom/images');
    assert.equal(ui.get('#prefab-folder').value, 'custom/prefabs');
    assert.equal(ui.get('#local-resource-folder-1').value, 'C:/custom/icons');
    assert.equal(ui.get('#scale').value, '2');
    assert.equal(ui.get('[data-font-family="Inter"]').value, fontAssets[1].url);
    assert.equal(ui.requests.length, requestCount);
});

test('changed source fetch preserves the old document on failure and saved settings on success', async (t) => {
    const ui = await panelFixture(t);
    await ui.goToConfirm();
    ui.get('#asset-folder').value = 'saved/images';
    ui.get('#prefab-folder').value = 'saved/prefabs';
    ui.get('#scale').value = '2.5';
    const font = ui.get('[data-font-family="Inter"]');
    font.value = fontAssets[1].url;
    await ui.get('#font-map-list').emit('change', { target: font });
    await ui.click('#change-source');
    assert.equal(ui.step(), 1);
    ui.get('#source-url').value = sourceB;
    await ui.get('#source-url').emit('input');
    assert.equal(ui.get('[data-workflow-step="2"]').disabled, true);
    assert.equal(ui.get('[data-workflow-step="3"]').disabled, true);
    await ui.get('[data-workflow-step="2"]').emit('click');
    assert.equal(ui.step(), 1);
    assert.equal(ui.calls('resolve-batch-source').length, 0);
    ui.get('#source-url').value = sourceA;
    await ui.get('#source-url').emit('input');
    assert.equal(ui.get('[data-workflow-step="2"]').disabled, false);
    await ui.click('[data-workflow-step="2"]');
    assert.equal(ui.step(), 2);
    await ui.click('#change-source');
    ui.get('#source-url').value = sourceB;
    await ui.get('#source-url').emit('input');
    ui.handlers['resolve-batch-source'] = () => { throw new Error('Figma read failed'); };
    await ui.click('#fetch-document');
    assert.equal(ui.step(), 1);
    assert.equal(ui.get('#file-name').textContent, 'First design');
    assert.ok(ui.get('[data-node-id="1:1"]'));
    assert.match(ui.get('#workflow-error-message').textContent, /Figma read failed/);

    ui.handlers['resolve-batch-source'] = () => design({ id: '2:1', sourceUrl: sourceB, fileName: 'Second design' });
    await ui.click('#fetch-document');
    assert.equal(ui.step(), 2);
    assert.equal(ui.get('#file-name').textContent, 'Second design');
    await ui.goToConfirm();
    assert.equal(ui.get('#asset-folder').value, 'saved/images');
    assert.equal(ui.get('#prefab-folder').value, 'saved/prefabs');
    assert.equal(ui.get('#scale').value, '2.5');
    assert.equal(ui.get('[data-font-family="Inter"]').value, fontAssets[1].url);
    assert.equal(ui.calls('import-selection').length, 0);
});

test('refresh deliberately rereads an unchanged source while ordinary continue reuses it', async (t) => {
    const ui = await panelFixture(t);
    await ui.click('#change-source');
    await ui.click('#fetch-document');
    assert.equal(ui.step(), 2);
    assert.equal(ui.calls('resolve-batch-source').length, 0);
    await ui.click('#change-source');
    await ui.click('#refresh-document');
    await flush();
    assert.equal(ui.step(), 2);
    assert.equal(ui.calls('resolve-batch-source').length, 1);
});

test('local import stays on confirmation and locked until its request settles, then opens results', async (t) => {
    const operation = deferred();
    const report = review('import-report');
    const ui = await panelFixture(t, { handlers: { 'import-selection': () => operation.promise } });
    await ui.goToConfirm();
    const importing = ui.click('#import-button');
    await flush();
    assert.equal(ui.calls('import-selection').length, 1);
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#workflow-back').disabled, true);
    assert.equal(ui.get('#import-button').disabled, true);
    ui.panel.methods.onProgress({ phase: 'done', value: 1, message: 'Backend finished' });
    ui.panel.methods.onImportReviewReady(report);
    await ui.get('#workflow-back').emit('click');
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#import-button').disabled, true);
    assert.equal(ui.reviews.length, 0);
    operation.resolve({ prefabUrl: 'db://assets/ui/prefabs/Main.prefab', warnings: [], review: report });
    await importing;
    assert.equal(ui.step(), 4);
    assert.equal(ui.reviews.at(-1), report);
    assert.equal(ui.calls('import-selection').length, 1);
    const payload = ui.calls('import-selection')[0].args[0];
    assert.equal(payload.settings.assetFolder, 'ui/images');
    assert.equal(payload.settings.fontMap.Inter, fontAssets[0].url);
    assert.equal(payload.settings.fontMap.Other, 'db://assets/fonts/Other.ttf');
    assert.equal(payload.overrides.length, 2);
    assert.equal(payload.overrides[0].id, '1:1');
});

test('import failure remains on confirmation and allows retry with the same settings', async (t) => {
    const ui = await panelFixture(t, { handlers: {
        'import-selection': () => { throw new Error('Import failed'); },
    } });
    await ui.goToConfirm();
    ui.get('#asset-folder').value = 'retry/images';
    await ui.click('#import-button');
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#import-button').disabled, false);
    assert.equal(ui.get('#asset-folder').value, 'retry/images');
    assert.match(ui.get('#workflow-error-message').textContent, /Import failed/);
    assert.equal(ui.reviews.length, 0);
    ui.handlers['import-selection'] = () => ({ warnings: [] });
    await ui.click('#import-button');
    assert.equal(ui.step(), 4);
    assert.equal(ui.calls('import-selection').length, 2);
    assert.equal(ui.calls('import-selection')[1].args[0].settings.assetFolder, 'retry/images');
});

test('cancellation request and progress do not unlock navigation before import settles', async (t) => {
    const operation = deferred();
    const ui = await panelFixture(t, { handlers: { 'import-selection': () => operation.promise } });
    await ui.goToConfirm();
    const importing = ui.click('#import-button');
    await flush();
    await ui.click('#cancel-import');
    assert.equal(ui.calls('cancel-import').length, 1);
    ui.panel.methods.onProgress({ phase: 'cancelled', value: 0, message: 'Cancelled' });
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#workflow-back').disabled, true);
    assert.equal(ui.get('#import-button').disabled, true);
    operation.reject(new Error('Cancelled'));
    await importing;
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#workflow-back').disabled, false);
    assert.equal(ui.get('#import-button').disabled, false);
    assert.equal(ui.reviews.length, 0);
});

test('fetch cancellation reported as backend error stays cancelled and preserves the existing design and settings', async (t) => {
    const operation = deferred();
    const ui = await panelFixture(t, { handlers: { 'resolve-batch-source': () => operation.promise } });
    await ui.goToConfirm();
    ui.get('#asset-folder').value = 'cancel/images';
    ui.get('#prefab-folder').value = 'cancel/prefabs';
    ui.get('#local-resource-folder-0').value = 'C:/cancel/resources';
    ui.get('#scale').value = '2';
    const font = ui.get('[data-font-family="Inter"]');
    font.value = fontAssets[1].url;
    await ui.get('#font-map-list').emit('change', { target: font });
    await ui.click('#change-source');
    ui.get('#source-url').value = sourceB;
    await ui.get('#source-url').emit('input');
    const fetching = ui.click('#fetch-document');
    await flush();
    await ui.click('#cancel-import');
    assert.equal(ui.calls('cancel-import').length, 1);
    // fetch-document currently emits phase=error when its request is aborted.
    ui.panel.methods.onProgress({ phase: 'error', value: 0, message: 'Request aborted' });
    assert.equal(ui.root.dataset.workflowBusy, 'true');
    assert.equal(ui.get('#workflow-error').hidden, true);
    assert.equal(ui.get('#workflow-footnote').hidden, false);
    assert.match(ui.get('#workflow-footnote').textContent, /已取消.*配置已保留/);
    operation.reject(new Error('Request aborted'));
    await fetching;
    assert.equal(ui.step(), 1);
    assert.equal(ui.root.dataset.workflowBusy, 'false');
    assert.equal(ui.get('#workflow-error').hidden, true);
    assert.equal(ui.get('#workflow-footnote').hidden, false);
    assert.equal(ui.get('#file-name').textContent, 'First design');
    assert.equal(ui.get('#asset-folder').value, 'cancel/images');
    assert.equal(ui.get('#prefab-folder').value, 'cancel/prefabs');
    assert.equal(ui.get('#local-resource-folder-0').value, 'C:/cancel/resources');
    assert.equal(ui.get('#scale').value, '2');
    assert.equal(ui.get('[data-font-family="Inter"]').value, fontAssets[1].url);
    assert.match(ui.get('#toast').textContent, /读取已取消.*配置已保留/);
    assert.equal(ui.get('#toast').classList.contains('error'), false);
    ui.handlers['resolve-batch-source'] = () => design({ id: '2:1', sourceUrl: sourceB });
    await ui.click('#fetch-document');
    assert.equal(ui.step(), 2);
    assert.equal(ui.get('#workflow-footnote').hidden, true);
    assert.equal(ui.get('#selection-summary').textContent, '2 / 2 个节点将参与导入');
});

test('credential dialog returns to the same step and keeps all panel inputs', async (t) => {
    const ui = await panelFixture(t);
    await ui.goToConfirm();
    ui.get('#prefab-folder').value = 'same/prefabs';
    const requestCount = ui.requests.length;
    await ui.click('#manage-credentials');
    assert.equal(ui.get('#credential-dialog').open, true);
    assert.equal(ui.step(), 3);
    await ui.click('#close-credentials');
    assert.equal(ui.get('#credential-dialog').open, false);
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#prefab-folder').value, 'same/prefabs');
    assert.equal(ui.requests.length, requestCount);
    await ui.click('#manage-credentials');
    ui.get('#token-input').value = 'test-token';
    await ui.click('#save-token');
    await ui.click('#verify-token');
    await ui.click('#close-credentials');
    assert.equal(ui.step(), 3);
    assert.equal(ui.get('#prefab-folder').value, 'same/prefabs');
    assert.equal(ui.get('#token-input').value, '');
    assert.equal(ui.calls('set-token')[0].args[0], 'test-token');
    assert.equal(ui.calls('verify-token').length, 1);
    assert.equal(ui.get('#pick-asset-folder').disabled, false);
    assert.equal(ui.get('#pick-prefab-folder').disabled, false);
    assert.equal(ui.get('#pick-local-resource-folder-0').disabled, false);
});

test('review notification, manual reopening and ready replay preserve existing automatic review behavior', async (t) => {
    const report = review('external-report');
    const ui = await panelFixture(t, { handlers: { 'get-import-review': () => null } });
    ui.panel.methods.onImportReviewReady(report);
    assert.equal(ui.step(), 4);
    assert.equal(ui.reviews.at(-1), report);
    ui.handlers['get-import-review'] = () => report;
    await ui.click('#open-import-review');
    assert.equal(ui.reviews.at(-1), report);
    await ui.click('[data-review-tab="nodes"]');
    await flush();
    assert.equal(ui.reviewTabs.at(-1), 'nodes');
    await ui.click('[data-review-tab="source"]');
    await flush();
    assert.equal(ui.reviewTabs.at(-1), 'source');
    assert.equal(ui.calls('import-selection').length, 0);
    const replay = await panelFixture(t, { replayReview: report });
    assert.equal(replay.step(), 4);
    assert.equal(replay.reviews.at(-1), report);
    assert.equal(replay.calls('import-selection').length, 0);
});

test('confirmed startup review stays closed but remains available from the header', async (t) => {
    const report = { ...review('confirmed-report'), confirmed: true };
    const ui = await panelFixture(t, { replayReview: report });
    assert.equal(ui.step(), 2);
    assert.equal(ui.reviews.length, 0);
    assert.equal(ui.get('#import-review-dialog').open, false);
    assert.equal(ui.get('#workflow-context').hidden, false);
    assert.equal(ui.get('#reopen-import-review').hidden, false);
    assert.equal(ui.get('#reopen-import-review').disabled, false);
    await ui.click('#reopen-import-review');
    await flush();
    assert.equal(ui.reviews.at(-1), report);
    assert.equal(ui.get('#import-review-dialog').open, true);
    assert.equal(ui.step(), 2);
    assert.equal(ui.calls('get-import-review').length, 2);
    assert.equal(ui.calls('import-selection').length, 0);
});

function frameItem(id, name, extra = {}) {
    const doc = design({ id, sourceUrl: `https://www.figma.com/design/example?node-id=${id.replace(':', '-')}`, fileName: 'Batch design' });
    doc.tree[0].name = name;
    return { id: `example/${id}`, fileKey: 'example', rootId: id, sourceUrl: doc.sourceUrl, name,
        enabled: true, sectionName: 'Main Section', document: doc, ...extra };
}

async function batchFixture(t, options = {}) {
    const items = options.items ?? [frameItem('1:1', 'Home_ui'), frameItem('2:1', 'Bag_ui')];
    const ui = await panelFixture(t, {
        empty: true,
        handlers: {
            'resolve-batch-source': () => ({ sourceType: 'section', sourceUrl: sourceA, items, added: items.length, duplicates: 0 }),
            'activate-batch-item': (id) => items.find((item) => item.id === id)?.document,
            'sync-batch-items': (next) => ({ items: next }),
            ...options.handlers,
        },
        ...options.fixture,
    });
    await ui.click('#add-batch-source');
    await flush();
    return { ...ui, items, async configure(id = items[0].id) {
        await ui.click(`[data-batch-configure="${id}"]`); await flush();
        assert.equal(ui.step(), 2);
    } };
}

test('batch restoration and frame switching retain Figma slices over historical off overrides', async (t) => {
    const first = frameItem('1:1', 'Home_ui'), second = frameItem('2:1', 'Bag_ui');
    for (const item of [first, second]) {
        Object.assign(item.document.tree[0], { patchCandidate: true, sliceMode: 'horizontal' });
        item.document.nodeOverrides = [{ id: item.rootId, action: 'generate', kind: 'button', nineSlice: false, explicit: true }];
    }
    const items = [first, second];
    const ui = await panelFixture(t, { empty: true, handlers: {
        'get-batch-state': () => ({ items }),
        'activate-batch-item': (id) => items.find((item) => item.id === id).document,
        'sync-batch-items': (next) => ({ items: next }),
        'import-batch': () => ({ id: 'slice-batch', stopped: false, completed: 0, total: 2, items: [] }),
    } });
    await ui.click(`[data-batch-configure="${first.id}"]`); await flush();
    for (const item of [second, first]) {
        await ui.click(`[data-batch-frame="${item.id}"]`); await flush();
        assert.equal(ui.get(`[data-patch-for="${item.rootId}"]`).checked, true);
        assert.equal(ui.get(`[data-patch-for="${item.rootId}"]`).disabled, true);
        assert.equal(ui.get(`[data-action-for="${item.rootId}"]`).value, 'render');
        assert.equal(ui.get(`[data-kind-for="${item.rootId}"]`).value, 'button');
    }
    await ui.goToConfirm(); await ui.click('#import-button'); await flush();
    const request = ui.calls('import-batch').at(-1).args[0];
    assert.equal(request.items.length, 2);
    for (const item of request.items) {
        const root = item.overrides.find((override) => ['1:1', '2:1'].includes(override.id));
        assert.equal(root.action, 'render'); assert.equal(root.nineSlice, true); assert.equal(root.kind, 'button');
    }
});

test('Section source stays on the frame list, appends unique frames and retains unchecked choices', async (t) => {
    const ui = await batchFixture(t);
    assert.equal(ui.step(), 1);
    assert.equal(ui.root.querySelectorAll('[data-batch-configure]').length, 2);
    assert.equal(ui.get('#batch-selected-count').textContent, '已选 2 / 2');
    const checked = ui.get(`[data-batch-checked="${ui.items[0].id}"]`);
    checked.checked = false; await checked.emit('change'); await flush();
    assert.equal(ui.get('#batch-selected-count').textContent, '已选 1 / 2');
    const third = frameItem('3:1', 'Shop_ui'); ui.items.push(third);
    ui.handlers['resolve-batch-source'] = () => ({ sourceType: 'frame', sourceUrl: third.sourceUrl,
        items: [ui.items[0], third], added: 1, duplicates: 1 });
    ui.get('#source-url').value = third.sourceUrl;
    await ui.click('#add-batch-source'); await flush();
    assert.equal(ui.root.querySelectorAll('[data-batch-configure]').length, 3);
    assert.equal(ui.get(`[data-batch-checked="${ui.items[0].id}"]`).checked, false);
    assert.match(ui.get('#toast').textContent, /跳过 1 个重复项/);
    assert.equal(ui.calls('import-batch').length, 0);
});

test('frame tabs preserve independent node names, strategy, node selection and search', async (t) => {
    const ui = await batchFixture(t);
    await ui.configure();
    const node = ui.get('[data-node-id="1:1:child"]');
    await ui.get('#tree').emit('click', { target: node }); await flush();
    const name = ui.get('[data-name-for="1:1:child"]'); name.value = 'Home_Title';
    await ui.root.emit('change', { target: name });
    const action = ui.get('[data-action-for="1:1:child"]'); action.value = 'render';
    await ui.root.emit('change', { target: action });
    ui.get('#tree-search').value = 'Home'; await ui.get('#tree-search').emit('input', { target: ui.get('#tree-search') });
    await ui.click(`[data-batch-frame="${ui.items[1].id}"]`); await flush();
    assert.equal(ui.get('#tree-search').value, '');
    assert.equal(ui.get('[data-name-for="2:1"]').value, 'Bag_ui');
    await ui.click(`[data-batch-frame="${ui.items[0].id}"]`); await flush();
    assert.equal(ui.get('#tree-search').value, 'home');
    assert.equal(ui.get('[data-name-for="1:1:child"]').value, 'Home_Title');
    assert.equal(ui.get('[data-action-for="1:1:child"]').value, 'render');
    assert.equal(ui.get('[data-node-id="1:1:child"]').classList.contains('is-selected'), true);
    assert.match(ui.get('#preset-scope').textContent, /当前界面/);
});

test('confirmation aggregates fonts and blocks filenames that collide after filesystem sanitization', async (t) => {
    const first = frameItem('1:1', 'Main?');
    const second = frameItem('2:1', 'main*');
    second.document.fonts = ['Other'];
    const ui = await batchFixture(t, { items: [first, second] });
    await ui.configure(); await ui.goToConfirm();
    assert.equal(ui.root.querySelectorAll('[data-font-family]').length, 2);
    assert.equal(ui.get('#batch-conflicts').hidden, false);
    assert.equal(ui.get('#import-button').disabled, true);
    const name = ui.get(`[data-batch-name="${second.id}"]`); name.value = 'Bag_ui';
    await name.emit('change'); await flush();
    assert.equal(ui.get('#batch-conflicts').hidden, true);
    assert.equal(ui.get('#import-button').disabled, false);
    assert.equal(ui.get(`[data-batch-name="${second.id}"]`).value, 'Bag_ui');
});

test('batch import locks frame switching, stops subsequent tasks and exposes per-item reports and retries', async (t) => {
    const operation = deferred();
    const first = frameItem('1:1', 'Home_ui'); const second = frameItem('2:1', 'Bag_ui');
    const report = review('home-review');
    const ui = await batchFixture(t, { items: [first, second], handlers: {
        'import-batch': () => operation.promise,
        'get-import-review': (id) => id === report.id ? report : null,
        'stop-import-batch': () => ({ accepted: true }),
    } });
    await ui.configure(); await ui.goToConfirm();
    const importing = ui.click('#import-button'); await flush();
    assert.equal(ui.calls('import-batch').length, 1);
    assert.equal(ui.get(`[data-batch-frame="${second.id}"]`).disabled, true);
    await ui.click('#cancel-import');
    assert.equal(ui.calls('stop-import-batch').length, 1);
    assert.equal(ui.calls('cancel-import').length, 0);
    assert.match(ui.get('#cancel-import').textContent, /当前项完成后停止/);
    ui.panel.methods.onImportReviewReady(report);
    assert.equal(ui.reviews.length, 0);
    operation.resolve({ id: 'batch-1', stopped: true, completed: 1, total: 2, items: [
        { id: first.id, name: first.name, sourceUrl: first.sourceUrl, status: 'success', created: 2, reviewId: report.id },
        { id: second.id, name: second.name, sourceUrl: second.sourceUrl, status: 'pending' },
    ] });
    await importing;
    assert.equal(ui.step(), 4);
    assert.match(ui.get('#result-title').textContent, /已停止/);
    assert.equal(ui.get('#batch-resume-pending').hidden, false);
    await ui.click(`[data-batch-review="${first.id}"]`); await flush();
    assert.equal(ui.reviews.at(-1), report);
    ui.handlers['import-batch'] = (payload) => ({ id: 'batch-2', stopped: false, completed: 1, total: 1,
        items: [{ id: payload.items[0].id, name: second.name, sourceUrl: second.sourceUrl, status: 'success', created: 3 }] });
    await ui.click('#batch-resume-pending'); await flush();
    assert.equal(ui.calls('import-batch')[1].args[0].items.length, 1);
    assert.equal(ui.calls('import-batch')[1].args[0].items[0].id, second.id);
    assert.match(ui.get('#result-summary').textContent, /成功 2 项/);
    assert.equal(ui.get('#result-created').textContent, '5');
});

test('removing frames persists the authoritative queue and unchecking every frame prevents import', async (t) => {
    const ui = await batchFixture(t);
    await ui.click(`[data-batch-remove="${ui.items[1].id}"]`); await flush();
    assert.equal(ui.root.querySelectorAll('[data-batch-configure]').length, 1);
    const synced = ui.calls('sync-batch-items').at(-1).args[0];
    assert.equal(synced.length, 1);
    assert.equal(synced[0].id, ui.items[0].id);
    await ui.click('#batch-toggle-all'); await flush();
    assert.equal(ui.get('#fetch-document').disabled, true);
    assert.equal(ui.get('#batch-selected-count').textContent, '已选 0 / 1');
    await ui.get('#import-button').emit('click');
    assert.equal(ui.calls('import-batch').length, 0);
});

test('removing the active frame saves its list before starting a slow next-frame activation', async (t) => {
    const first = frameItem('1:1', 'Home_ui'), second = frameItem('2:1', 'Bag_ui');
    const items = [first, second];
    const release = deferred();
    const trace = [];
    let activationBusy = false;
    const ui = await batchFixture(t, { items, handlers: {
        'activate-batch-item': async (id) => {
            trace.push(`activate:${id}`);
            if (id === second.id) {
                activationBusy = true;
                try { await release.promise; } finally { activationBusy = false; }
            }
            return items.find((item) => item.id === id).document;
        },
        'sync-batch-items': (next) => {
            trace.push(`sync:${next.map((item) => item.id).join(',')}`);
            if (activationBusy) throw new Error('请等待当前任务完成后再修改界面列表。');
            return { items: next };
        },
    } });
    await ui.configure(first.id); trace.length = 0;
    try {
        await ui.click(`[data-batch-remove="${first.id}"]`); await flush();
        assert.deepEqual(trace, [`sync:${second.id}`, `activate:${second.id}`]);
        assert.equal(activationBusy, true);
        assert.doesNotMatch(ui.get('#toast').textContent, /请等待当前任务完成/);
    } finally { release.resolve(); await flush(); }
    await ui.click(`[data-batch-configure="${second.id}"]`); await flush();
    assert.equal(ui.get('[data-name-for="2:1"]').value, second.name);
    assert.doesNotMatch(ui.get('#toast').textContent, /请等待当前任务完成/);
});

for (const consumer of ['configure', 'read-source', 'import']) {
    test(`${consumer} retries the latest list once after an earlier busy rejection has ended`, async (t) => {
        let taskBusy = false;
        const ui = await batchFixture(t, { handlers: {
            'sync-batch-items': (next) => {
                if (taskBusy) throw new Error('请等待当前任务完成后再修改界面列表。');
                return { items: next };
            },
            'import-batch': (request) => ({ id: 'recovered', stopped: false, completed: request.items.length,
                total: request.items.length, items: request.items.map((item) => ({ id: item.id, name: 'Home_ui',
                    sourceUrl: sourceA, status: 'success', created: 1 })) }),
        } });
        await ui.configure();
        taskBusy = true;
        const checked = ui.get(`[data-batch-checked="${ui.items[1].id}"]`);
        checked.checked = false; await checked.emit('change'); await flush();
        assert.match(ui.get('#toast').textContent, /请等待当前任务完成/);
        const failedSaveCount = ui.calls('sync-batch-items').length;
        taskBusy = false;
        if (consumer === 'configure') {
            await ui.click(`[data-batch-configure="${ui.items[0].id}"]`); await flush();
            assert.equal(ui.step(), 2);
        } else if (consumer === 'read-source') {
            const third = frameItem('3:1', 'Shop_ui');
            ui.handlers['resolve-batch-source'] = () => ({ sourceType: 'frame', sourceUrl: third.sourceUrl,
                items: [third], added: 1, duplicates: 0 });
            ui.handlers['activate-batch-item'] = (id) => [...ui.items, third].find((item) => item.id === id).document;
            ui.get('#source-url').value = third.sourceUrl;
            await ui.click('#add-batch-source'); await flush();
            assert.equal(ui.root.querySelectorAll('[data-batch-configure]').length, 3);
        } else {
            await ui.goToConfirm(); await ui.click('#import-button'); await flush();
            assert.equal(ui.calls('import-batch').length, 1);
            assert.equal(ui.calls('import-batch')[0].args[0].items.length, 1);
        }
        const retry = ui.calls('sync-batch-items')[failedSaveCount];
        assert.ok(retry, 'consuming the list must actually retry its failed save');
        assert.deepEqual(Array.from(retry.args[0], ({ id, enabled }) => ({ id, enabled })), [
            { id: ui.items[0].id, enabled: true }, { id: ui.items[1].id, enabled: false },
        ]);
        if (consumer !== 'read-source') assert.equal(ui.calls('sync-batch-items').length, failedSaveCount + 1);
        assert.doesNotMatch(ui.get('#toast').textContent, /请等待当前任务完成/);
    });
}

test('a failed retry still blocks import, then successful configuration clears only the recovered sync error', async (t) => {
    const busyMessage = '请等待当前任务完成后再修改界面列表。';
    let taskBusy = false;
    const ui = await batchFixture(t, { handlers: {
        'sync-batch-items': (next) => {
            if (taskBusy) throw new Error(busyMessage);
            return { items: next };
        },
    } });
    await ui.configure(); taskBusy = true;
    const checked = ui.get(`[data-batch-checked="${ui.items[1].id}"]`);
    checked.checked = false; await checked.emit('change'); await flush();
    const failedSaveCount = ui.calls('sync-batch-items').length;
    await ui.goToConfirm(); await ui.click('#import-button'); await flush();
    assert.equal(ui.calls('sync-batch-items').length, failedSaveCount + 1, 'only one retry per consuming operation');
    assert.equal(ui.calls('import-batch').length, 0);
    assert.equal(ui.get('#workflow-error').hidden, false);
    assert.equal(ui.get('#workflow-error-message').textContent, busyMessage);
    await flush();
    assert.equal(ui.calls('sync-batch-items').length, failedSaveCount + 1, 'no unbounded background retry loop');
    taskBusy = false;
    await ui.click(`[data-batch-configure="${ui.items[0].id}"]`); await flush();
    assert.equal(ui.calls('sync-batch-items').length, failedSaveCount + 2);
    assert.equal(ui.get('#workflow-error').hidden, true);
    assert.doesNotMatch(ui.get('#toast').textContent, /请等待当前任务完成/);

    ui.panel.methods.onProgress({ phase: 'error', value: 0, message: '另一项真实导入错误' });
    await ui.click(`[data-batch-configure="${ui.items[0].id}"]`); await flush();
    assert.equal(ui.get('#workflow-error-message').textContent, '另一项真实导入错误');
    assert.equal(ui.get('#workflow-error').hidden, false, 'a healthy sync must not erase unrelated errors');
});

test('previews and rapid list changes remain serial before import without a dependency cycle', async (t) => {
    const release = deferred();
    const trace = [];
    let previewCount = 0, activePreviews = 0, maximumPreviews = 0;
    const ui = await batchFixture(t, { handlers: {
        'get-preview': async () => {
            const index = ++previewCount;
            activePreviews++; maximumPreviews = Math.max(maximumPreviews, activePreviews);
            trace.push(`preview:${index}:start`);
            try { if (index === 1) await release.promise; }
            finally { activePreviews--; trace.push(`preview:${index}:end`); }
            return { url: 'data:image/png;base64,AA==' };
        },
        'sync-batch-items': (next) => {
            assert.equal(activePreviews, 0, 'list saves wait for earlier backend previews');
            trace.push(`sync:${next[1].enabled}`); return { items: next };
        },
        'import-batch': () => {
            assert.equal(activePreviews, 0);
            trace.push('import'); return { id: 'serial', stopped: false, completed: 0, total: 2, items: [] };
        },
    } });
    trace.length = 0;
    await ui.configure(); assert.equal(previewCount, 1);
    let checked = ui.get(`[data-batch-checked="${ui.items[1].id}"]`);
    checked.checked = false; await checked.emit('change');
    await ui.get('#tree').emit('click', { target: ui.get('[data-node-id="1:1:child"]') });
    checked = ui.get(`[data-batch-checked="${ui.items[1].id}"]`);
    checked.checked = true; await checked.emit('change');
    await ui.goToConfirm();
    const importing = ui.click('#import-button'); await flush();
    assert.equal(ui.calls('import-batch').length, 0);
    assert.deepEqual(trace, ['preview:1:start']);
    release.resolve(); await importing; await flush();
    assert.equal(maximumPreviews, 1);
    assert.deepEqual(trace, ['preview:1:start', 'preview:1:end', 'sync:false',
        'preview:2:start', 'preview:2:end', 'sync:true', 'import']);
    assert.equal(ui.calls('import-batch').length, 1);
});

test('rapid nonactive selection changes and removing every frame preserve the final authoritative list', async (t) => {
    const ui = await batchFixture(t);
    const start = ui.calls('sync-batch-items').length;
    for (const enabled of [false, true, false]) {
        const checked = ui.get(`[data-batch-checked="${ui.items[1].id}"]`);
        checked.checked = enabled; await checked.emit('change');
    }
    await flush();
    assert.deepEqual(ui.calls('sync-batch-items').slice(start).map((call) => call.args[0][1].enabled), [false, true, false]);
    await ui.click(`[data-batch-remove="${ui.items[1].id}"]`); await flush();
    await ui.click(`[data-batch-remove="${ui.items[0].id}"]`); await flush();
    assert.equal(ui.root.querySelectorAll('[data-batch-configure]').length, 0);
    assert.deepEqual(Array.from(ui.calls('sync-batch-items').at(-1).args[0]), []);
    assert.equal(ui.calls('import-batch').length, 0);
});

test('saved font URLs absent from the asset index remain selectable and survive unrelated saves and reopening', async (t) => {
    const missing = 'db://assets/fonts/CustomFont.ttf';
    let persisted = { ...settings(), fontMap: { Inter: missing, Other: 'db://assets/fonts/Other.ttf' } };
    const document = design(); document.fonts = ['Inter', 'Other'];
    const ui = await panelFixture(t, { initial: { settings: persisted, document, fontAssets: [] }, handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
    } });
    const inter = ui.get('[data-font-family="Inter"]');
    const savedOption = inter.options.find((item) => item.value === missing);
    assert.ok(savedOption, 'an unavailable saved URL needs an option or the browser resets select.value to empty');
    assert.match(savedOption.textContent, /已保存.*资源暂未就绪/);
    assert.equal(inter.value, missing);
    // Also defend against a stale renderer selection without treating it as a
    // user clear: only a font change event may record that explicit choice.
    inter.value = '';
    ui.get('#scale').value = '2'; await ui.get('#scale').emit('change');
    assert.deepEqual(persisted.fontMap, { Inter: missing, Other: 'db://assets/fonts/Other.ttf' });
    const reopened = await panelFixture(t, { initial: { settings: persisted, document, fontAssets: [] } });
    assert.equal(reopened.get('[data-font-family="Inter"]').value, missing);
    assert.equal(reopened.get('[data-font-family="Other"]').value, persisted.fontMap.Other);
});

test('explicit no-font mapping overrides automatic matching across rereads and reopening without clearing other families', async (t) => {
    let persisted = { ...settings(), fontMap: { Other: 'db://assets/fonts/Other.ttf', Unseen: 'db://assets/fonts/Unseen.otf' } };
    const ui = await panelFixture(t, { initial: { settings: persisted }, handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
        'resolve-batch-source': () => design(),
    } });
    const inter = ui.get('[data-font-family="Inter"]');
    assert.equal(inter.value, fontAssets[0].url, 'unconfigured fonts retain automatic name matching');
    inter.value = ''; await ui.get('#font-map-list').emit('change', { target: inter });
    assert.deepEqual(persisted.fontMap, { Other: 'db://assets/fonts/Other.ttf', Unseen: 'db://assets/fonts/Unseen.otf', Inter: '' });
    await ui.click('#refresh-document'); await flush();
    assert.equal(ui.get('[data-font-family="Inter"]').value, '');
    const reopened = await panelFixture(t, { initial: { settings: persisted } });
    assert.equal(reopened.get('[data-font-family="Inter"]').value, '');
    await reopened.goToConfirm(); await reopened.click('#import-button'); await flush();
    const imported = reopened.calls('import-selection').at(-1).args[0].settings.fontMap;
    assert.equal(imported.Inter, '');
    assert.equal(imported.Other, persisted.fontMap.Other);
    assert.equal(imported.Unseen, persisted.fontMap.Unseen);
});

test('changing documents keeps saved mappings for fonts that are no longer rendered', async (t) => {
    let persisted = settings();
    const ui = await panelFixture(t, { handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
    } });
    const inter = ui.get('[data-font-family="Inter"]'); inter.value = fontAssets[1].url;
    await ui.get('#font-map-list').emit('change', { target: inter });
    const second = design({ id: '2:1', sourceUrl: sourceB }); second.fonts = ['Other']; second.fontAssets = [];
    ui.handlers['resolve-batch-source'] = () => second;
    await ui.click('#change-source'); ui.get('#source-url').value = sourceB;
    await ui.get('#source-url').emit('input'); await ui.click('#fetch-document'); await flush();
    assert.equal(ui.root.querySelector('[data-font-family="Inter"]'), null);
    assert.equal(ui.get('[data-font-family="Other"]').value, 'db://assets/fonts/Other.ttf');
    const other = ui.get('[data-font-family="Other"]'); other.value = '';
    await ui.get('#font-map-list').emit('change', { target: other });
    assert.deepEqual(persisted.fontMap, { Inter: fontAssets[1].url, Other: '' });
    const reopened = await panelFixture(t, { initial: { settings: persisted } });
    assert.equal(reopened.get('[data-font-family="Inter"]').value, fontAssets[1].url);
});

test('Frame selection and a refreshed font index preserve explicit empty and unavailable mappings', async (t) => {
    const first = frameItem('1:1', 'Home_ui'), second = frameItem('2:1', 'Bag_ui');
    first.document.fonts = ['Inter']; second.document.fonts = ['Other'];
    first.document.fontAssets = []; second.document.fontAssets = [];
    const items = [first, second];
    let assetsReady = false;
    let persisted = { ...settings(), fontMap: { Inter: fontAssets[1].url, Other: 'db://assets/fonts/Other.ttf' } };
    const ui = await batchFixture(t, { items, fixture: { initial: { settings: persisted } }, handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
        'activate-batch-item': (id) => ({ ...items.find((item) => item.id === id).document,
            fontAssets: assetsReady ? fontAssets : [] }),
    } });
    await ui.configure();
    assert.equal(ui.get('[data-font-family="Inter"]').value, fontAssets[1].url);
    let checked = ui.get(`[data-batch-checked="${second.id}"]`);
    checked.checked = false; await checked.emit('change'); await flush();
    assert.equal(ui.root.querySelector('[data-font-family="Other"]'), null);
    const inter = ui.get('[data-font-family="Inter"]'); inter.value = '';
    await ui.get('#font-map-list').emit('change', { target: inter });
    assert.deepEqual(persisted.fontMap, { Inter: '', Other: 'db://assets/fonts/Other.ttf' });
    checked = ui.get(`[data-batch-checked="${second.id}"]`);
    checked.checked = true; await checked.emit('change'); await flush();
    assetsReady = true;
    await ui.click(`[data-batch-frame="${second.id}"]`); await flush();
    assert.equal(ui.get('[data-font-family="Inter"]').value, '');
    assert.ok(ui.get('[data-font-family="Inter"]').options.some((item) => item.value === fontAssets[1].url),
        'activation uses its fresh project font index');
    assert.equal(ui.get('[data-font-family="Other"]').value, persisted.fontMap.Other);
    await ui.click(`[data-batch-frame="${first.id}"]`); await flush();
    assert.equal(ui.get('[data-font-family="Inter"]').value, '');
    assert.equal(ui.get('[data-font-family="Other"]').value, persisted.fontMap.Other);
});

test('font edits persist using the last valid settings while an unrelated input is temporarily invalid', async (t) => {
    let persisted;
    const ui = await panelFixture(t, { handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
    } });
    ui.get('#asset-folder').value = 'changed/images'; await ui.get('#asset-folder').emit('change');
    ui.get('#scale').value = 'invalid';
    const inter = ui.get('[data-font-family="Inter"]'); inter.value = fontAssets[1].url;
    await ui.get('#font-map-list').emit('change', { target: inter });
    assert.equal(persisted.assetFolder, 'changed/images', 'font saving must not revert an already saved directory');
    assert.equal(persisted.scale, 1.5);
    assert.equal(persisted.fontMap.Inter, fontAssets[1].url);
    assert.equal(persisted.fontMap.Other, 'db://assets/fonts/Other.ttf');
});

test('hidden import defaults on for old settings and toggling it preserves manual node strategies and persisted mappings', async (t) => {
    const document = design();
    document.tree[0].children = [{ id: 'hidden:group', name: 'Hidden group', type: 'GROUP', width: 100, height: 80,
        visible: false, action: 'generate', kind: 'node', patchCandidate: false, children: [
            { id: 'hidden:leaf', name: 'Nested visible title', type: 'TEXT', width: 80, height: 20,
                visible: true, action: 'generate', kind: 'label', patchCandidate: false, children: [] },
        ] }];
    let persisted = settings();
    const ui = await panelFixture(t, { initial: { document }, handlers: {
        'save-settings': (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; },
        'import-selection': () => ({ created: 1, updated: 0 }),
    } });
    assert.equal(ui.get('#import-hidden-layers').checked, true);
    await ui.get('#tree').emit('click', { target: ui.get('[data-node-id="hidden:group"]') }); await flush();
    const action = ui.get('[data-action-for="hidden:group"]'); action.value = 'render';
    await ui.root.emit('change', { target: action }); await flush();
    const strategySaves = ui.calls('save-node-overrides').length;
    await ui.goToConfirm();
    const hidden = ui.get('#import-hidden-layers'); hidden.checked = false; await hidden.emit('change'); await flush();
    assert.equal(ui.get('[data-action-for="hidden:group"]').value, 'ignore');
    assert.match(ui.get('#node-properties').textContent, /隐藏图层.*本次忽略/);
    assert.equal(ui.get('#selection-summary').textContent, '1 / 3 个节点将参与导入');
    assert.equal(persisted.importHiddenLayers, false);
    assert.equal(persisted.fontMap.Inter, settings().fontMap.Inter);
    await ui.click('#import-button'); await flush();
    const excluded = ui.calls('import-selection')[0].args[0];
    assert.equal(excluded.settings.importHiddenLayers, false);
    assert.equal(excluded.overrides.find((item) => item.id === 'hidden:group').action, 'ignore');
    assert.equal(excluded.overrides.find((item) => item.id === 'hidden:leaf').action, 'ignore');
    await ui.click('#workflow-back'); await ui.goToConfirm();
    hidden.checked = true; await hidden.emit('change'); await flush();
    assert.equal(ui.get('[data-action-for="hidden:group"]').value, 'render');
    assert.equal(ui.get('#selection-summary').textContent, '2 / 3 个节点将参与导入');
    assert.equal(ui.calls('save-node-overrides').length, strategySaves, 'visibility is a derived filter, not a saved node strategy');
    await ui.click('#import-button'); await flush();
    const restored = ui.calls('import-selection')[1].args[0];
    assert.equal(restored.settings.importHiddenLayers, true);
    assert.equal(restored.overrides.find((item) => item.id === 'hidden:group').action, 'render');
    assert.equal(restored.overrides.find((item) => item.id === 'hidden:group').explicit, true);
    const reopened = await panelFixture(t, { initial: { document, settings: { ...persisted, importHiddenLayers: false } } });
    assert.equal(reopened.get('#import-hidden-layers').checked, false);
    assert.equal(reopened.get('#selection-summary').textContent, '1 / 3 个节点将参与导入');
});

test('hidden Frame roots are visible in the list but excluded from selection, conflicts, fonts and import requests', async (t) => {
    const first = frameItem('1:1', 'Same_ui'), second = frameItem('2:1', 'Same_ui');
    second.document.tree[0].visible = false; second.document.fonts = ['HiddenOnlyFont'];
    const ui = await batchFixture(t, { items: [first, second], fixture: { initial: {
        settings: { ...settings(), importHiddenLayers: false },
    } }, handlers: {
        'import-batch': (request) => ({ id: 'visible-only', stopped: false, completed: 1, total: 1,
            items: [{ id: request.items[0].id, name: first.name, sourceUrl: first.sourceUrl, status: 'success' }] }),
    } });
    assert.match(ui.get('#batch-selected-count').textContent, /已选 1 \/ 1.*1 个隐藏界面本次忽略/);
    assert.match(ui.get('#batch-source-list').textContent, /隐藏 · 本次忽略/);
    assert.equal(ui.get(`[data-batch-checked="${second.id}"]`).checked, false);
    assert.equal(ui.get(`[data-batch-checked="${second.id}"]`).disabled, true);
    assert.equal(ui.get(`[data-batch-remove="${second.id}"]`).disabled, false);
    assert.equal(ui.get('#batch-conflicts').hidden, true);
    assert.equal(ui.root.querySelector(`[data-batch-frame="${second.id}"]`), null);
    assert.equal(ui.root.querySelector('[data-font-family="HiddenOnlyFont"]'), null);
    await ui.click('#batch-toggle-all'); await flush();
    let synced = ui.calls('sync-batch-items').at(-1).args[0];
    assert.equal(synced.find((item) => item.id === first.id).enabled, false);
    assert.equal(synced.find((item) => item.id === second.id).enabled, true, 'filtering preserves the hidden Frame selection preference');
    await ui.click('#batch-toggle-all'); await flush();
    await ui.configure(first.id); await ui.goToConfirm();
    assert.equal(ui.root.querySelectorAll('[data-batch-name]').length, 1);
    await ui.click('#import-button'); await flush();
    const request = ui.calls('import-batch')[0].args[0];
    assert.equal(request.settings.importHiddenLayers, false);
    assert.deepEqual(Array.from(request.items, (item) => item.id), [first.id]);
    await ui.click('#workflow-back'); await ui.goToConfirm();
    const hidden = ui.get('#import-hidden-layers'); hidden.checked = true; await hidden.emit('change'); await flush();
    assert.equal(ui.get(`[data-batch-checked="${second.id}"]`).checked, true);
    assert.equal(ui.get('#batch-conflicts').hidden, false, 'reenabling hidden roots restores their real filename conflict');
    assert.ok(ui.get('[data-font-family="HiddenOnlyFont"]'));
});

test('visibility toggles recalculate cached Frame editors without replacing their manual preferences', async (t) => {
    const first = frameItem('1:1', 'Home_ui'), second = frameItem('2:1', 'Bag_ui');
    for (const item of [first, second]) {
        const child = item.document.tree[0].children[0]; child.visible = false; child.type = 'GROUP'; child.kind = 'node';
        item.document.nodeOverrides = [{ id: child.id, action: item === first ? 'render' : 'transform',
            kind: 'sprite', nineSlice: false, explicit: true }];
    }
    const ui = await batchFixture(t, { items: [first, second], fixture: { initial: {
        settings: { ...settings(), importHiddenLayers: false },
    } }, handlers: { 'import-batch': () => ({ id: 'derived', stopped: false, completed: 0, total: 2, items: [] }) } });
    await ui.configure(first.id);
    for (const item of [second, first]) {
        await ui.click(`[data-batch-frame="${item.id}"]`); await flush();
        await ui.get('#tree').emit('click', { target: ui.get(`[data-node-id="${item.rootId}:child"]`) }); await flush();
        assert.equal(ui.get(`[data-action-for="${item.rootId}:child"]`).value, 'ignore');
    }
    await ui.goToConfirm(); await ui.click('#import-button'); await flush();
    for (const item of ui.calls('import-batch')[0].args[0].items) {
        assert.equal(item.overrides.find((entry) => entry.id.endsWith(':child')).action, 'ignore');
    }
    await ui.click('#workflow-back'); await ui.goToConfirm();
    const hidden = ui.get('#import-hidden-layers'); hidden.checked = true; await hidden.emit('change'); await flush();
    await ui.click('#workflow-back');
    for (const item of [second, first]) {
        await ui.click(`[data-batch-frame="${item.id}"]`); await flush();
        await ui.get('#tree').emit('click', { target: ui.get(`[data-node-id="${item.rootId}:child"]`) }); await flush();
        assert.equal(ui.get(`[data-action-for="${item.rootId}:child"]`).value, item === first ? 'render' : 'transform');
    }
    assert.equal(ui.calls('save-node-overrides').length, 0);
});

test('an all-hidden batch can reenable the import option from its list without changing source visibility', async (t) => {
    const item = frameItem('1:1', 'Hidden_ui'); item.document.tree[0].visible = false;
    let persisted;
    const ui = await batchFixture(t, { items: [item], fixture: { initial: {
        settings: { ...settings(), importHiddenLayers: false },
    } }, handlers: { 'save-settings': (value) => { persisted = value; return value; } } });
    assert.equal(ui.step(), 1);
    assert.equal(ui.get('#fetch-document').disabled, true);
    assert.equal(ui.get('#batch-toggle-all').disabled, true);
    assert.match(ui.get('#batch-selected-count').textContent, /已选 0 \/ 0/);
    const allow = ui.get(`[data-batch-configure="${item.id}"]`);
    assert.equal(allow.textContent, '允许导入隐藏图层');
    assert.match(allow.title, /仅修改导入选项.*不改变 Figma 图层/);
    await allow.click(); await flush();
    assert.equal(persisted.importHiddenLayers, true);
    assert.equal(ui.get('#import-hidden-layers').checked, true);
    assert.equal(ui.get('#fetch-document').disabled, false);
    assert.equal(item.document.tree[0].visible, false);
    assert.equal(ui.calls('import-batch').length, 0);
    await ui.configure(item.id); await ui.goToConfirm();
    assert.equal(ui.get('#import-button').disabled, false);
});
