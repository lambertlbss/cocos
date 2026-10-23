"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const package_json_1 = __importDefault(require("../../../package.json"));
const import_review_1 = require("./import-review");
const workflow_1 = require("./workflow");
const assets_1 = require("../../importer/assets");
const fonts_1 = require("../../importer/fonts");
const import_actions_1 = require("../../import-actions");
const node_name_1 = require("../../node-name");
const model_1 = require("./model");
let panelHost = null;
let importReviewPanel = null;
let workflow = null;
let pendingImportReview = null;
let forceDocumentRead = false;
let toastTimer = null;
let importButtonResetTimer = null;
let nodeOverrideSaveTask = Promise.resolve();
let roundtripPreviewToken;
let roundtripPairToken;
let batchItems = [];
let activeBatchId;
let batchResult;
let batchProgress;
let batchSyncTask = Promise.resolve();
let batchSyncError;
let batchImportPending = false;
let batchStopRequested = false;
let previewRevision = 0;
let previewReadTask = Promise.resolve();
let batchRecoveryTimer = null;
const state = {
    document: null,
    settings: {
        sourceUrl: '',
        assetFolder: 'figma-importer',
        prefabFolder: 'figma-importer/prefabs',
        localResourceFolders: [],
        localResourceFolder: '',
        scale: 1,
        updateExisting: true,
        refreshAssets: false,
        autoSave: false,
        fontMap: {},
    },
    preferredActions: new Map(),
    actions: new Map(),
    kinds: new Map(),
    patches: new Set(),
    explicitIds: new Set(),
    names: new Map(),
    renamedIds: new Set(),
    defaults: new Map(),
    collapsed: new Set(),
    suppressed: new Set(),
    search: '',
    busy: false,
    runtimeCompatible: true,
    fontAssets: [],
};
function selectedFrames() { return batchItems.filter(({ item }) => item.enabled); }
function editorSnapshot() {
    var _a;
    return {
        document: state.document,
        preferredActions: new Map(state.preferredActions), actions: new Map(state.actions),
        kinds: new Map(state.kinds), patches: new Set(state.patches), explicitIds: new Set(state.explicitIds),
        names: new Map(state.names), renamedIds: new Set(state.renamedIds), defaults: new Map(state.defaults),
        collapsed: new Set(state.collapsed), suppressed: new Set(state.suppressed),
        selectedId: state.selectedId, search: state.search, treeScroll: element('#tree').scrollTop,
        preset: (_a = Array.from(root().querySelectorAll('[data-preset]')).find((button) => button.classList.contains('active'))) === null || _a === void 0 ? void 0 : _a.dataset.preset,
    };
}
function initialFrameEditor(document) {
    var _a, _b;
    const editor = {
        document, preferredActions: new Map(), actions: new Map(), kinds: new Map(),
        patches: (0, model_1.defaultNineSliceIds)(document.tree), explicitIds: new Set(), names: new Map(), renamedIds: new Set(),
        defaults: new Map(), collapsed: new Set(), suppressed: new Set(), selectedId: (_a = document.tree[0]) === null || _a === void 0 ? void 0 : _a.id,
        search: '', treeScroll: 0, preset: 'smart',
    };
    for (const node of flatten(document.tree)) {
        const action = (0, model_1.smartActionForNode)(node);
        editor.preferredActions.set(node.id, action);
        editor.kinds.set(node.id, node.kind);
        editor.defaults.set(node.id, { action, kind: node.kind });
        editor.names.set(node.id, node.name);
    }
    for (const override of (_b = document.nodeOverrides) !== null && _b !== void 0 ? _b : []) {
        const node = findNode(override.id, document.tree);
        if (!node)
            continue;
        const name = (0, node_name_1.sanitizeNodeName)(override.name);
        if (name && name !== node.name) {
            editor.names.set(node.id, name);
            editor.renamedIds.add(node.id);
        }
        if (override.explicit) {
            editor.preferredActions.set(node.id, safeAction(node, override.action));
            editor.kinds.set(node.id, override.kind);
            if (override.nineSlice && node.patchCandidate)
                editor.patches.add(node.id);
            else
                editor.patches.delete(node.id);
            editor.explicitIds.add(node.id);
            editor.preset = undefined;
        }
    }
    const effective = (0, model_1.resolveEffectiveActions)(document.tree, editor.preferredActions, editor.patches, editor.explicitIds, editor.renamedIds);
    editor.actions = effective.actions;
    editor.suppressed = effective.suppressed;
    return editor;
}
function rememberActiveFrame() {
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active)
        active.editor = editorSnapshot();
}
function frameName(entry) {
    var _a, _b, _c, _d;
    const editor = entry.item.id === activeBatchId ? state : entry.editor;
    return (_d = (_a = editor === null || editor === void 0 ? void 0 : editor.names.get(entry.item.rootId)) !== null && _a !== void 0 ? _a : (_c = (_b = entry.item.document.nodeOverrides) === null || _b === void 0 ? void 0 : _b.find((override) => override.id === entry.item.rootId)) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : entry.item.name;
}
function batchConflicts() {
    var _a;
    const names = new Map();
    for (const entry of selectedFrames()) {
        const key = (0, assets_1.sanitizeAssetName)(frameName(entry)).toLocaleLowerCase();
        names.set(key, [...((_a = names.get(key)) !== null && _a !== void 0 ? _a : []), entry.item.id]);
    }
    return new Set(Array.from(names.values()).filter((ids) => ids.length > 1).flat());
}
function batchContext() {
    if (!batchItems.length)
        return undefined;
    let nodes = 0;
    let selectedNodes = 0;
    for (const entry of selectedFrames()) {
        const editor = entry.item.id === activeBatchId ? state : entry.editor;
        const all = flatten(entry.item.document.tree);
        nodes += all.length;
        selectedNodes += all.filter((node) => { var _a; return ((_a = editor === null || editor === void 0 ? void 0 : editor.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action) !== 'ignore'; }).length;
    }
    return {
        count: selectedFrames().length, total: batchItems.length, nodes, selectedNodes,
        conflicts: batchConflicts().size > 0,
        ...(batchResult ? { result: {
                success: batchResult.items.filter((item) => item.status === 'success').length,
                failed: batchResult.items.filter((item) => item.status === 'failed').length,
                pending: batchResult.items.filter((item) => item.status === 'pending').length,
                stopped: batchResult.stopped,
            } } : {}),
    };
}
function batchFonts() {
    var _a, _b;
    return batchItems.length ? Array.from(new Set(selectedFrames().flatMap(({ item }) => item.document.fonts))) : (_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.fonts) !== null && _b !== void 0 ? _b : [];
}
function syncBatchItems() {
    const items = batchItems.map(({ item }) => ({ id: item.id, enabled: item.enabled }));
    const precedingPreview = previewReadTask;
    batchSyncTask = batchSyncTask.catch(() => undefined).then(async () => {
        await precedingPreview.catch(() => undefined);
        await request('sync-batch-items', items);
        batchSyncError = undefined;
    }).catch((error) => {
        batchSyncError = error;
        showToast(errorMessage(error, '界面列表保存失败，请重试。'), true);
    });
}
function batchElement(tag, text = '', className = '') {
    const value = document.createElement(tag);
    value.textContent = text;
    value.className = className;
    return value;
}
function batchButton(text, action, className = 'text-button') {
    const button = batchElement('button', text, className);
    button.type = 'button';
    button.disabled = state.busy;
    button.onclick = action;
    return button;
}
function renderBatch() {
    const enabled = batchItems.length > 0;
    element('#batch-source-region').hidden = !enabled;
    element('#batch-frame-region').hidden = !enabled;
    element('#batch-target-region').hidden = !enabled;
    element('#batch-result-region').hidden = !enabled || (!batchResult && !batchProgress);
    const genericReview = root().querySelector('.result-review');
    if (genericReview)
        genericReview.hidden = enabled;
    element('#preset-scope').textContent = enabled ? '仅作用于当前界面' : '作用于全部节点';
    element('#batch-selected-count').textContent = `已选 ${selectedFrames().length} / ${batchItems.length}`;
    element('#batch-toggle-all').textContent = selectedFrames().length === batchItems.length ? '取消全选' : '全选';
    const list = element('#batch-source-list');
    const tabs = element('#batch-frame-tabs');
    const targets = element('#batch-target-list');
    list.replaceChildren();
    tabs.replaceChildren();
    targets.replaceChildren();
    const conflicts = batchConflicts();
    for (const entry of batchItems) {
        const { item } = entry;
        const row = batchElement('div', '', `batch-item${item.enabled ? '' : ' is-disabled'}`);
        const checked = batchElement('input');
        checked.type = 'checkbox';
        checked.checked = item.enabled;
        checked.disabled = state.busy;
        checked.dataset.batchChecked = item.id;
        checked.setAttribute('aria-label', `导入 ${frameName(entry)}`);
        checked.onchange = () => {
            if (state.busy)
                return;
            item.enabled = checked.checked;
            syncBatchItems();
            renderBatch();
            renderFontMap();
            workflow === null || workflow === void 0 ? void 0 : workflow.render();
            if (activeBatchId === item.id && !item.enabled && selectedFrames().length)
                void activateFrame(selectedFrames()[0].item.id);
        };
        const copy = batchElement('div', '', 'batch-item-copy');
        const title = batchElement('div', '', 'batch-item-title');
        title.append(batchElement('span', frameName(entry)), batchElement('span', entry.configured ? '已配置' : '智能默认', `badge${entry.configured ? '' : ' subtle'}`));
        if (conflicts.has(item.id))
            title.append(batchElement('span', '名称冲突', 'batch-status-failed'));
        copy.append(title, batchElement('div', `${item.sectionName ? `${item.sectionName} / ` : ''}${item.document.fileName} · ${flatten(item.document.tree).length} 节点`, 'batch-item-meta'));
        const actions = batchElement('div', '', 'batch-item-actions');
        const configure = batchButton('调整节点', () => {
            if (!item.enabled) {
                item.enabled = true;
                syncBatchItems();
            }
            void activateFrame(item.id, true);
        });
        configure.dataset.batchConfigure = item.id;
        const remove = batchButton('×', () => {
            if (state.busy)
                return;
            rememberActiveFrame();
            batchItems = batchItems.filter((candidate) => candidate.item.id !== item.id);
            if (activeBatchId === item.id) {
                activeBatchId = undefined;
                if (selectedFrames().length)
                    void activateFrame(selectedFrames()[0].item.id);
                else if (batchItems.length)
                    void activateFrame(batchItems[0].item.id);
                else {
                    state.document = null;
                    renderTree();
                    workflow === null || workflow === void 0 ? void 0 : workflow.batchReady();
                }
            }
            syncBatchItems();
            renderBatch();
            renderFontMap();
            workflow === null || workflow === void 0 ? void 0 : workflow.render();
        }, 'icon-button');
        remove.dataset.batchRemove = item.id;
        remove.setAttribute('aria-label', `移除 ${frameName(entry)}`);
        actions.append(configure, remove);
        row.append(checked, copy, actions);
        list.append(row);
        if (!item.enabled)
            continue;
        const tab = batchButton('', () => { void activateFrame(item.id); }, 'batch-frame-tab');
        tab.dataset.batchFrame = item.id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(activeBatchId === item.id));
        tab.append(batchElement('strong', frameName(entry)), batchElement('small', entry.configured ? '已配置 · 自动保留' : '智能默认'));
        tabs.append(tab);
        const target = batchElement('label', '', `batch-target-row${conflicts.has(item.id) ? ' is-conflict' : ''}`);
        target.append(batchElement('span', item.name));
        const name = batchElement('input');
        name.type = 'text';
        name.value = frameName(entry);
        name.disabled = state.busy;
        name.dataset.batchName = item.id;
        name.setAttribute('aria-label', `${item.name} 的 Prefab 名称`);
        name.title = `assets/${element('#prefab-folder').value}/${(0, assets_1.sanitizeAssetName)(frameName(entry))}.prefab`;
        name.onchange = () => { void renameFrame(entry, name.value); };
        target.append(name);
        targets.append(target);
    }
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    element('#batch-active-name').textContent = active ? `正在调整：${frameName(active)}` : '选择一个界面开始调整';
    element('#batch-active-status').textContent = (active === null || active === void 0 ? void 0 : active.configured) ? '修改已保留' : '沿用智能默认';
    element('#batch-conflicts').hidden = conflicts.size === 0;
    element('#batch-conflicts').textContent = `有 ${conflicts.size} 个界面的 Prefab 文件名重复（忽略大小写）。请改名后开始导入。`;
    renderBatchResults();
}
function renderBatchResults() {
    var _a, _b, _c, _d, _e, _f;
    const rows = (_b = (_a = batchProgress === null || batchProgress === void 0 ? void 0 : batchProgress.items) !== null && _a !== void 0 ? _a : batchResult === null || batchResult === void 0 ? void 0 : batchResult.items) !== null && _b !== void 0 ? _b : [];
    const list = element('#batch-result-list');
    list.replaceChildren();
    for (const item of rows) {
        const row = batchElement('div', '', 'batch-item');
        const copy = batchElement('div', '', 'batch-item-copy');
        copy.append(batchElement('div', item.name, 'batch-item-title'), batchElement('div', (_f = (_d = (_c = item.error) !== null && _c !== void 0 ? _c : item.prefabUrl) !== null && _d !== void 0 ? _d : (_e = item.warnings) === null || _e === void 0 ? void 0 : _e.join('；')) !== null && _f !== void 0 ? _f : (item.status === 'pending' ? '等待继续导入' : ''), 'batch-item-meta'));
        const status = { pending: '未完成', running: '正在导入', success: '已完成', failed: '失败' }[item.status];
        const actions = batchElement('div', '', 'batch-item-actions');
        actions.append(batchElement('span', status, `batch-status-${item.status}`));
        if (item.reviewId || item.review) {
            const review = batchButton('检查结果', () => { void openBatchReview(item); });
            review.dataset.batchReview = item.id;
            actions.append(review);
        }
        row.append(copy, actions);
        list.append(row);
    }
    const success = rows.filter((item) => item.status === 'success').length;
    const failed = rows.filter((item) => item.status === 'failed').length;
    const pending = rows.filter((item) => item.status === 'pending').length;
    element('#batch-result-count').textContent = `${success} / ${rows.length} 已完成`;
    element('#batch-retry-failed').hidden = !failed || state.busy;
    element('#batch-resume-pending').hidden = !pending || state.busy;
    element('#batch-result-note').textContent = rows.some((item) => item.requiresAttention)
        ? '部分项的保存状态需要检查。请先在 Cocos 确认当前目标与保存状态，再重试或继续。'
        : '点击每一项的“检查结果”查看对应报告；重试和继续会跳过已完成项。';
}
async function openBatchReview(item) {
    var _a, _b;
    if (state.busy)
        return;
    try {
        const reviewId = (_a = item.reviewId) !== null && _a !== void 0 ? _a : (_b = item.review) === null || _b === void 0 ? void 0 : _b.id;
        const review = reviewId ? await request('get-import-review', reviewId) : null;
        if (!review)
            throw new Error('该项检查报告已过期，请重新导入后查看。');
        importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
    }
    catch (error) {
        showToast(errorMessage(error, '读取检查结果失败。'), true);
    }
}
async function activateFrame(id, navigate = false) {
    var _a, _b, _c, _d;
    if (state.busy)
        return;
    const entry = batchItems.find(({ item }) => item.id === id);
    if (!entry)
        return;
    if (activeBatchId === id && state.document) {
        if (navigate)
            workflow === null || workflow === void 0 ? void 0 : workflow.navigate(2);
        renderBatch();
        workflow === null || workflow === void 0 ? void 0 : workflow.render();
        if (navigate && state.selectedId) {
            const selected = findNode(state.selectedId);
            if (selected)
                void preview(selected);
        }
        return;
    }
    rememberActiveFrame();
    const oldId = activeBatchId;
    const oldEditor = editorSnapshot();
    const settings = readSettings(false);
    if (settings)
        state.settings = settings;
    previewRevision++;
    setBusy(true);
    try {
        await batchSyncTask;
        await previewReadTask.catch(() => undefined);
        if (batchSyncError)
            throw batchSyncError;
        const loaded = await request('activate-batch-item', id);
        activeBatchId = id;
        if (entry.editor)
            Object.assign(state, entry.editor);
        else
            initializeDocument(loaded !== null && loaded !== void 0 ? loaded : entry.item.document, false);
        element('#tree-search').value = state.search;
        element('#file-name').textContent = (_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.fileName) !== null && _b !== void 0 ? _b : '';
        element('#preview-stage').classList.remove('has-image', 'is-loading');
        element('#preview-image').removeAttribute('src');
        element('#preview-meta').textContent = '选择节点查看预览';
        renderTree();
        element('#tree').scrollTop = (_d = (_c = entry.editor) === null || _c === void 0 ? void 0 : _c.treeScroll) !== null && _d !== void 0 ? _d : 0;
        root().querySelectorAll('[data-preset]').forEach((button) => { var _a, _b; return button.classList.toggle('active', button.dataset.preset === ((_b = (_a = entry.editor) === null || _a === void 0 ? void 0 : _a.preset) !== null && _b !== void 0 ? _b : 'smart')); });
        renderFontMap();
    }
    catch (error) {
        activeBatchId = oldId;
        Object.assign(state, oldEditor);
        showToast(errorMessage(error, '切换界面失败，请重试。'), true);
    }
    finally {
        setBusy(false);
        renderBatch();
        updateSummary();
        if (navigate && activeBatchId === id)
            workflow === null || workflow === void 0 ? void 0 : workflow.navigate(2);
        if (activeBatchId === id && (workflow === null || workflow === void 0 ? void 0 : workflow.step) === 2 && state.selectedId) {
            const selected = findNode(state.selectedId);
            if (selected)
                void preview(selected);
        }
    }
}
async function renameFrame(entry, value) {
    if (state.busy)
        return;
    const name = (0, node_name_1.sanitizeNodeName)(value);
    if (!name) {
        showToast('Prefab 名称不能为空。', true);
        renderBatch();
        return;
    }
    await activateFrame(entry.item.id);
    if (activeBatchId !== entry.item.id)
        return;
    state.names.set(entry.item.rootId, name);
    if (name === entry.item.name)
        state.renamedIds.delete(entry.item.rootId);
    else
        state.renamedIds.add(entry.item.rootId);
    entry.configured = true;
    persistNodeOverrides();
    rememberActiveFrame();
    renderTree();
    renderBatch();
    updateSummary();
}
function root() {
    return panelHost.$.app;
}
function element(selector) {
    const value = root().querySelector(selector);
    if (!value) {
        throw new Error(`Panel element not found: ${selector}`);
    }
    return value;
}
async function request(message, ...args) {
    return await Editor.Message.request(package_json_1.default.name, message, ...args);
}
function showToast(message, error = false) {
    const toast = element('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    const credentialDialog = root().querySelector('#credential-dialog');
    const credentialStatus = root().querySelector('#credential-status');
    if ((credentialDialog === null || credentialDialog === void 0 ? void 0 : credentialDialog.open) && credentialStatus) {
        credentialStatus.hidden = false;
        credentialStatus.textContent = message;
        credentialStatus.classList.toggle('error', error);
    }
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
}
function errorMessage(error, fallback) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    if (error && typeof error === 'object' && 'message' in error
        && typeof error.message === 'string') {
        return error.message;
    }
    return fallback;
}
function setConnection(vault) {
    var _a;
    const pill = element('#connection-pill');
    pill.classList.toggle('is-online', vault.hasToken);
    pill.classList.toggle('is-offline', !vault.hasToken);
    element('#connection-label').textContent = vault.hasToken ? '凭据就绪' : '未连接';
    element('#vault-badge').textContent = vault.persistent ? '系统加密' : '会话存储';
    element('#vault-note').textContent = (_a = vault.warning) !== null && _a !== void 0 ? _a : (vault.persistent ? `由 ${vault.backend} 加密，项目中仅保存非敏感设置` : 'Token 不写入项目文件');
    (element('#verify-token')).disabled = !vault.hasToken;
    (element('#clear-token')).disabled = !vault.hasToken;
    workflow === null || workflow === void 0 ? void 0 : workflow.setConnection(vault.hasToken);
}
function flatten(nodes) {
    return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
function findNode(id, nodes) {
    var _a, _b;
    if (nodes === void 0) { nodes = (_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.tree) !== null && _b !== void 0 ? _b : []; }
    for (const node of nodes) {
        if (node.id === id) {
            return node;
        }
        const child = findNode(id, node.children);
        if (child) {
            return child;
        }
    }
    return undefined;
}
function renderFontMap() {
    var _a, _b;
    const list = element('#font-map-list');
    list.replaceChildren();
    const families = batchFonts();
    if (!families.length) {
        const empty = document.createElement('div');
        empty.className = 'font-map-empty';
        empty.textContent = '读取 Figma 后，这里会列出检测到的字体。';
        list.appendChild(empty);
        return;
    }
    if (!state.fontAssets.length) {
        const empty = document.createElement('div');
        empty.className = 'font-map-empty is-warning';
        empty.textContent = '项目 assets 内没有检测到 .ttf / .otf / .fnt / .woff 字体资源。';
        list.appendChild(empty);
    }
    for (const family of families) {
        const row = document.createElement('div');
        row.className = 'font-map-row';
        const source = document.createElement('span');
        source.className = 'font-map-source';
        source.textContent = family;
        source.title = family;
        const arrow = document.createElement('span');
        arrow.className = 'font-map-arrow';
        arrow.textContent = '→';
        const select = document.createElement('select');
        select.className = 'font-map-select';
        select.dataset.fontFamily = family;
        select.setAttribute('aria-label', `${family} 映射字体`);
        select.appendChild(option('', '不映射（使用默认字体）'));
        const automatic = (0, fonts_1.findFontAsset)(family, state.fontAssets);
        const selected = (_b = (_a = state.settings.fontMap[family]) !== null && _a !== void 0 ? _a : automatic === null || automatic === void 0 ? void 0 : automatic.url) !== null && _b !== void 0 ? _b : '';
        for (const asset of state.fontAssets) {
            const item = option(asset.url, `${asset.name} · ${asset.relativePath}`);
            item.selected = asset.url === selected;
            select.appendChild(item);
        }
        select.value = selected;
        row.append(source, arrow, select);
        list.appendChild(row);
    }
}
function safeAction(_node, action) {
    return (0, import_actions_1.normalizeImportAction)(action);
}
function initializeDocument(document, navigate = true) {
    var _a, _b;
    state.document = document;
    state.preferredActions.clear();
    state.actions.clear();
    state.kinds.clear();
    state.patches.clear();
    state.explicitIds.clear();
    state.names.clear();
    state.renamedIds.clear();
    state.defaults.clear();
    state.collapsed.clear();
    state.suppressed.clear();
    state.selectedId = (_a = document.tree[0]) === null || _a === void 0 ? void 0 : _a.id;
    pendingImportReview = null;
    for (const node of flatten(document.tree)) {
        const action = (0, model_1.smartActionForNode)(node);
        state.preferredActions.set(node.id, action);
        state.kinds.set(node.id, node.kind);
        state.defaults.set(node.id, { action, kind: node.kind });
        state.names.set(node.id, node.name);
    }
    state.patches = (0, model_1.defaultNineSliceIds)(document.tree);
    for (const override of (_b = document.nodeOverrides) !== null && _b !== void 0 ? _b : []) {
        const node = findNode(override.id, document.tree);
        if (!node) {
            continue;
        }
        const customName = (0, node_name_1.sanitizeNodeName)(override.name);
        if (customName && customName !== node.name) {
            state.names.set(node.id, customName);
            state.renamedIds.add(node.id);
        }
        if (override.explicit === true) {
            state.preferredActions.set(node.id, safeAction(node, override.action));
            state.kinds.set(node.id, override.kind);
            if (override.nineSlice && node.patchCandidate) {
                state.patches.add(node.id);
            }
            else {
                state.patches.delete(node.id);
            }
            state.explicitIds.add(node.id);
        }
    }
    reconcileActions();
    root().querySelectorAll('[data-preset]').forEach((button) => {
        button.classList.toggle('active', state.explicitIds.size === 0 && button.dataset.preset === 'smart');
    });
    element('#file-name').textContent = document.fileName;
    element('#source-url').value = document.sourceUrl;
    element('#font-hint').textContent = document.fonts.length
        ? `检测到：${document.fonts.join('、')}`
        : '当前文件尚未发现字体。';
    renderFontMap();
    renderTree(true);
    updateSummary();
    if (navigate)
        workflow === null || workflow === void 0 ? void 0 : workflow.documentReady();
}
function applySettings(settings) {
    var _a, _b, _c;
    state.settings = settings;
    element('#source-url').value = settings.sourceUrl;
    element('#asset-folder').value = settings.assetFolder;
    element('#prefab-folder').value = settings.prefabFolder;
    const localResourceFolders = ((_a = settings.localResourceFolders) === null || _a === void 0 ? void 0 : _a.length)
        ? settings.localResourceFolders
        : settings.localResourceFolder
            ? [settings.localResourceFolder]
            : [];
    for (let index = 0; index < 3; index += 1) {
        const input = element(`#local-resource-folder-${index}`);
        input.value = (_b = localResourceFolders[index]) !== null && _b !== void 0 ? _b : '';
        input.title = (_c = localResourceFolders[index]) !== null && _c !== void 0 ? _c : '';
    }
    element('#scale').value = String(settings.scale);
    element('#update-existing').checked = settings.updateExisting;
    element('#refresh-assets').checked = settings.refreshAssets;
    element('#auto-save').checked = settings.autoSave;
    updateTargetHint();
    renderFontMap();
    workflow === null || workflow === void 0 ? void 0 : workflow.render();
}
function readSettings(showError = true) {
    const fontMap = { ...state.settings.fontMap };
    for (const family of batchFonts())
        delete fontMap[family];
    root().querySelectorAll('[data-font-family]').forEach((select) => {
        var _a;
        const family = (_a = select.dataset.fontFamily) === null || _a === void 0 ? void 0 : _a.trim();
        if (family && select.value) {
            fontMap[family] = select.value;
        }
    });
    const scale = Number(element('#scale').value);
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) {
        if (showError) {
            showToast('导入倍率必须在 0.25 到 4 之间。', true);
        }
        return null;
    }
    const assetFolder = element('#asset-folder').value.trim();
    if (!assetFolder) {
        if (showError) {
            showToast('请选择项目 assets 下的资源输出目录。', true);
        }
        return null;
    }
    const prefabFolder = element('#prefab-folder').value.trim();
    if (!prefabFolder) {
        if (showError) {
            showToast('请选择预制体输出目录。', true);
        }
        return null;
    }
    return {
        sourceUrl: element('#source-url').value.trim(),
        assetFolder,
        prefabFolder,
        localResourceFolders: Array.from({ length: 3 }, (_, index) => element(`#local-resource-folder-${index}`).value.trim()),
        localResourceFolder: element('#local-resource-folder-0').value.trim(),
        scale,
        updateExisting: element('#update-existing').checked,
        refreshAssets: element('#refresh-assets').checked,
        autoSave: element('#auto-save').checked,
        fontMap,
    };
}
function setBusy(value) {
    value = value || Boolean(workflow === null || workflow === void 0 ? void 0 : workflow.pending);
    state.busy = value;
    // Capture editable control states before the existing button lock changes them.
    workflow === null || workflow === void 0 ? void 0 : workflow.render();
    element('#fetch-document').disabled = value;
    element('#save-token').disabled = value;
    element('#pick-asset-folder').disabled = value;
    element('#pick-prefab-folder').disabled = value;
    element('#roundtrip-detect').disabled = value;
    element('#roundtrip-preview').disabled = value
        || element('#roundtrip-root').value === '';
    element('#roundtrip-pair').disabled = value || !roundtripPairToken;
    element('#roundtrip-apply').disabled = value || !roundtripPreviewToken;
    for (let index = 0; index < 3; index += 1) {
        element(`#pick-local-resource-folder-${index}`).disabled = value;
        element(`#clear-local-resource-folder-${index}`).disabled = value;
    }
    element('#import-button').disabled = value
        || !state.document
        || !state.runtimeCompatible;
    element('#cancel-import').classList.toggle('is-hidden', !value);
    workflow === null || workflow === void 0 ? void 0 : workflow.render();
    if (!value)
        renderNodeProperties();
}
function resetRoundtripTokens() {
    roundtripPreviewToken = undefined;
    roundtripPairToken = undefined;
    element('#roundtrip-pair').disabled = true;
    element('#roundtrip-apply').disabled = true;
}
function roundtripSource() {
    const source = element('#source-url').value.trim();
    if (!source) {
        showToast('请输入 Figma 文件或节点链接。', true);
        return null;
    }
    return source;
}
function renderRoundtripPreview(preview) {
    roundtripPreviewToken = preview.previewToken;
    roundtripPairToken = preview.pairToken;
    const lines = [
        `目标：${preview.assetUrl}`,
        `Prefab：${preview.prefabUuid}`,
        `Surface：${preview.surfaceId} · Figma ${preview.figmaVersion} · Ledger ${preview.ledgerGeneration}`,
        `将修改 ${preview.plan.apply.length} 项 · 保留 Cocos ${preview.plan.preserveCocos.length} 项 · 已收敛 ${preview.plan.converged.length} 项`,
        `冲突 ${preview.plan.conflicts.length} 项 · 不支持 ${preview.plan.unsupported.length} 项 · 只读未改 ${preview.plan.readonlyUnchanged.length} 项`,
        preview.pairRequired
            ? preview.pairEligible ? '首次使用：证据一致，请先确认配对 Surface（只写 ledger，不改 Prefab）。' : '首次使用：Pair 证据不一致，需从当前 Prefab 重新导出。'
            : preview.blockers.length ? `阻断：${preview.blockers.join(', ')}` : '预览通过，可原子应用整个不可变计划。',
    ];
    element('#roundtrip-summary').textContent = lines.join('\n');
    element('#roundtrip-pair').disabled = !roundtripPairToken;
    element('#roundtrip-apply').disabled = !roundtripPreviewToken;
}
function updateTargetHint() {
    if (!state.runtimeCompatible) {
        element('#action-note').textContent = '主进程与面板版本不一致，需要完整重启 Cocos Creator';
        return;
    }
    element('#action-note').textContent = '导入到当前场景 Canvas 根节点下；Frame 链接将自动创建并打开预制体';
}
function resetImportButton() {
    const button = element('#import-button');
    button.classList.remove('is-running', 'is-success', 'is-error');
    button.removeAttribute('aria-busy');
    button.title = '导入到当前打开场景或预制体';
    element('#import-button-label').textContent = '开始导入';
    element('#import-button-percent').textContent = '→';
    element('#import-button-progress').style.width = '0%';
}
function importProgress(event) {
    const value = Math.max(0, Math.min(1, event.value));
    if (event.phase === 'assets') {
        return 0.05 + value * 0.55;
    }
    if (event.phase === 'scene') {
        return 0.6 + value * 0.38;
    }
    return event.phase === 'done' ? 1 : 0;
}
function updateProgress(event) {
    var _a;
    if (event.batch && batchItems.length) {
        batchProgress = event.batch;
        const currentRow = event.batch.items.find((item) => item.id === event.batch.itemId);
        const current = (currentRow === null || currentRow === void 0 ? void 0 : currentRow.status) === 'running' ? importProgress(event) : 0;
        event = {
            ...event,
            value: Math.min(1, (event.batch.completed + current) / Math.max(1, event.batch.total)),
            message: `${event.batch.index} / ${event.batch.total} · ${event.batch.name} · ${event.message}`,
        };
        renderBatchResults();
    }
    if (['fetch', 'assets', 'scene'].includes(event.phase))
        setBusy(true);
    workflow === null || workflow === void 0 ? void 0 : workflow.progress(event);
    const region = element('#progress-region');
    const busy = ['fetch', 'assets', 'scene'].includes(event.phase);
    region.classList.toggle('is-busy', busy);
    region.classList.toggle('is-error', event.phase === 'error');
    element('#progress-label').textContent = event.message;
    const value = Math.max(0, Math.min(1, event.value));
    element('#progress-percent').textContent = `${Math.round(value * 100)}%`;
    element('#progress-bar').style.width = `${value * 100}%`;
    const button = element('#import-button');
    const importing = event.phase === 'assets' || event.phase === 'scene';
    if (importButtonResetTimer) {
        clearTimeout(importButtonResetTimer);
        importButtonResetTimer = null;
    }
    if (importing) {
        const progress = event.batch ? value : importProgress(event);
        button.classList.add('is-running');
        button.classList.remove('is-success', 'is-error');
        button.setAttribute('aria-busy', 'true');
        button.title = event.message;
        element('#import-button-label').textContent = event.phase === 'assets' ? '准备资源' : '构建节点';
        element('#import-button-percent').textContent = `${Math.round(progress * 100)}%`;
        element('#import-button-progress').style.width = `${progress * 100}%`;
    }
    else if (event.phase === 'done') {
        button.classList.remove('is-running', 'is-error');
        button.classList.add('is-success');
        button.removeAttribute('aria-busy');
        element('#import-button-label').textContent = '导入完成';
        element('#import-button-percent').textContent = '100%';
        element('#import-button-progress').style.width = '100%';
        importButtonResetTimer = setTimeout(resetImportButton, 1400);
    }
    else if (event.phase === 'error' || event.phase === 'cancelled') {
        button.classList.remove('is-running', 'is-success');
        button.classList.add('is-error');
        button.removeAttribute('aria-busy');
        element('#import-button-label').textContent = event.phase === 'cancelled' ? '已取消' : '导入失败';
        element('#import-button-percent').textContent = '重试';
        importButtonResetTimer = setTimeout(resetImportButton, 1800);
    }
    if (['done', 'error', 'cancelled', 'idle'].includes(event.phase)) {
        setBusy(false);
    }
    if (event.phase === 'done' && !(workflow === null || workflow === void 0 ? void 0 : workflow.pending) && pendingImportReview) {
        const review = pendingImportReview;
        pendingImportReview = null;
        workflow === null || workflow === void 0 ? void 0 : workflow.complete({ review });
        importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
    }
    if (((_a = event.batch) === null || _a === void 0 ? void 0 : _a.result) && !batchImportPending && batchItems.length) {
        if (batchRecoveryTimer)
            clearTimeout(batchRecoveryTimer);
        workflow === null || workflow === void 0 ? void 0 : workflow.end();
        setBusy(false);
        completeBatchPresentation(event.batch.result);
    }
}
function descendants(node) {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
}
function reconcileActions() {
    var _a, _b;
    const effective = (0, model_1.resolveEffectiveActions)((_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.tree) !== null && _b !== void 0 ? _b : [], state.preferredActions, state.patches, state.explicitIds, state.renamedIds);
    state.actions = effective.actions;
    state.suppressed = effective.suppressed;
}
function setAction(node, action) {
    state.preferredActions.set(node.id, safeAction(node, action));
    reconcileActions();
}
function effectiveNodeName(node) {
    var _a;
    return (_a = state.names.get(node.id)) !== null && _a !== void 0 ? _a : node.name;
}
function explicitOverrides() {
    if (!state.document) {
        return [];
    }
    return flatten(state.document.tree)
        .filter((node) => state.explicitIds.has(node.id) || state.renamedIds.has(node.id))
        .map((node) => {
        var _a, _b;
        const renamed = state.renamedIds.has(node.id);
        return {
            id: node.id,
            action: (_a = state.preferredActions.get(node.id)) !== null && _a !== void 0 ? _a : (0, model_1.smartActionForNode)(node),
            kind: (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: state.patches.has(node.id),
            explicit: state.explicitIds.has(node.id),
            ...(renamed ? { name: effectiveNodeName(node) } : {}),
        };
    });
}
function persistNodeOverrides() {
    if (!state.document) {
        return;
    }
    const fileKey = state.document.fileKey;
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active) {
        active.configured = true;
        rememberActiveFrame();
        renderBatch();
    }
    const overrides = explicitOverrides();
    const scopeIds = flatten(state.document.tree).map((node) => node.id);
    // Serialize writes so a slower earlier request can never overwrite a newer
    // strategy snapshot after rapid select changes.
    nodeOverrideSaveTask = nodeOverrideSaveTask
        .catch(() => undefined)
        .then(async () => {
        await request('save-node-overrides', fileKey, overrides, scopeIds);
    })
        .catch((error) => {
        showToast(errorMessage(error, '节点策略保存失败。'), true);
    });
}
function matches(node) {
    if (!state.search) {
        return true;
    }
    const haystack = `${effectiveNodeName(node)} ${node.name} ${node.type} ${node.id}`.toLowerCase();
    if (haystack.includes(state.search)) {
        return true;
    }
    return node.children.some(matches);
}
function option(value, label) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
}
function makeSelect(className, value, items, label) {
    const select = document.createElement('select');
    select.className = className;
    select.setAttribute('aria-label', label);
    for (const [key, text] of items) {
        select.appendChild(option(key, text));
    }
    select.value = value;
    return select;
}
function appendTreeNode(container, node, depth) {
    var _a, _b, _c;
    if (!matches(node)) {
        return;
    }
    const row = document.createElement('div');
    row.className = `tree-row${state.selectedId === node.id ? ' is-selected' : ''}`;
    row.dataset.nodeId = node.id;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    const main = document.createElement('div');
    main.className = 'node-main';
    main.style.setProperty('--depth', String(depth));
    const collapse = document.createElement('button');
    collapse.className = `collapse${node.children.length ? '' : ' is-leaf'}`;
    collapse.type = 'button';
    collapse.dataset.collapse = node.id;
    collapse.textContent = state.collapsed.has(node.id) ? '›' : '⌄';
    collapse.setAttribute('aria-label', state.collapsed.has(node.id) ? '展开' : '折叠');
    const dot = document.createElement('span');
    dot.className = `type-dot ${node.type === 'TEXT' ? 'text'
        : (0, model_1.isVectorNodeType)(node.type) ? 'vector'
            : node.type.includes('COMPONENT') || node.type === 'INSTANCE' ? 'component'
                : ''}`;
    const copy = document.createElement('div');
    copy.className = 'node-copy';
    const displayName = effectiveNodeName(node);
    const name = document.createElement('div');
    name.className = `node-name${state.renamedIds.has(node.id) ? ' is-renamed' : ''}`;
    name.textContent = displayName;
    const strategySummary = (0, model_1.strategySummaryForNode)(node, state.explicitIds.has(node.id));
    name.title = [
        state.renamedIds.has(node.id) ? `Figma 原名：${node.name}` : '选择节点，在右侧修改导入节点名',
        strategySummary.strategy,
        strategySummary.warning,
    ]
        .filter(Boolean)
        .join(' · ');
    const meta = document.createElement('div');
    meta.className = 'node-meta';
    meta.textContent = `${node.type} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    copy.append(name, meta);
    if (strategySummary.strategy) {
        const strategy = document.createElement('div');
        strategy.className = 'node-strategy';
        strategy.textContent = strategySummary.strategy;
        strategy.title = strategySummary.strategy;
        copy.appendChild(strategy);
    }
    if (strategySummary.warning) {
        const warning = document.createElement('div');
        warning.className = 'node-warning';
        warning.textContent = `⚠ ${strategySummary.warning}`;
        warning.title = strategySummary.warning;
        copy.appendChild(warning);
    }
    row.classList.toggle('has-detail', Boolean(strategySummary.strategy || strategySummary.warning));
    main.append(collapse, dot, copy);
    const actionBadge = document.createElement('span');
    actionBadge.className = 'node-action-badge';
    const selectedAction = safeAction(node, (_a = state.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action);
    actionBadge.textContent = (_c = (_b = (0, model_1.actionOptionsForNode)(node).find(([value]) => value === selectedAction)) === null || _b === void 0 ? void 0 : _b[1]) !== null && _c !== void 0 ? _c : selectedAction;
    actionBadge.title = strategySummary.strategy || actionBadge.textContent;
    row.append(main, actionBadge);
    container.appendChild(row);
    if (!state.collapsed.has(node.id) || state.search) {
        node.children.forEach((child) => appendTreeNode(container, child, depth + 1));
    }
}
function renderNodeProperties() {
    var _a, _b;
    const container = element('#node-properties');
    container.replaceChildren();
    const node = state.selectedId ? findNode(state.selectedId) : undefined;
    if (!node) {
        const empty = document.createElement('p');
        empty.className = 'inspector-empty';
        empty.textContent = '选择节点，查看预览并调整导入设置。';
        container.appendChild(empty);
        return;
    }
    const displayName = effectiveNodeName(node);
    const field = (label, control) => {
        const row = document.createElement('label');
        row.className = 'field';
        const heading = document.createElement('span');
        heading.textContent = label;
        row.append(heading, control);
        container.appendChild(row);
    };
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'node-name-input';
    name.value = displayName;
    name.maxLength = 96;
    name.spellcheck = false;
    name.dataset.nameFor = node.id;
    name.setAttribute('aria-label', `${node.name} 导入节点名`);
    name.title = `Figma 原名：${node.name}；Enter 保存，Esc 取消`;
    name.disabled = state.busy;
    field('导入节点名', name);
    const selectedAction = safeAction(node, (_a = state.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action);
    const actionOptions = (0, model_1.actionOptionsForNode)(node);
    const action = makeSelect('action-select', selectedAction, actionOptions, `${displayName} 导入方式`);
    action.dataset.actionFor = node.id;
    action.disabled = state.busy;
    field('导入方式', action);
    const selectedKind = (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind;
    const effectiveKind = (0, model_1.effectiveKindForNode)(node, selectedKind, selectedAction, state.patches.has(node.id));
    const kindOptions = (0, model_1.kindOptionsForAction)(selectedAction);
    const kind = makeSelect('kind-select', effectiveKind, kindOptions, `${displayName} 节点类型`);
    kind.dataset.kindFor = node.id;
    kind.disabled = state.busy;
    field('节点类型', kind);
    const patch = document.createElement('label');
    patch.className = 'toggle-row patch-toggle';
    patch.title = node.sliceMode
        ? `启用${node.sliceMode === 'nine' ? '九宫格' : '三宫格'}切片`
        : node.patchCandidate
            ? '启用自动识别的三/九宫格切片'
            : '该节点不是自动识别的切片候选';
    const patchInput = document.createElement('input');
    patchInput.type = 'checkbox';
    patchInput.dataset.patchFor = node.id;
    patchInput.checked = state.patches.has(node.id);
    patchInput.disabled = state.busy || !node.patchCandidate;
    const patchIcon = document.createElement('span');
    patchIcon.textContent = node.patchCandidate
        ? node.sliceMode === 'nine' ? '启用九宫切片' : node.sliceMode ? '启用三宫切片' : '启用三 / 九宫切片'
        : '切片 · 非候选节点';
    patch.append(patchInput, patchIcon);
    container.appendChild(patch);
    const summary = (0, model_1.strategySummaryForNode)(node, state.explicitIds.has(node.id));
    const note = document.createElement('div');
    note.className = 'node-inspector-note';
    for (const text of [summary.strategy, `Figma 原名：${node.name}`, summary.warning]) {
        if (!text)
            continue;
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        if (text === summary.warning)
            paragraph.className = 'node-warning';
        note.appendChild(paragraph);
    }
    container.appendChild(note);
}
function renderTree(resetScroll = false) {
    const tree = element('#tree');
    (0, model_1.rerenderPreservingScroll)(tree, () => {
        tree.replaceChildren();
        if (!state.document) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const glyph = document.createElement('span');
            glyph.className = 'empty-glyph';
            glyph.textContent = '↳';
            const title = document.createElement('strong');
            title.textContent = '还没有节点';
            const body = document.createElement('p');
            body.textContent = '读取 Figma 链接后，可逐层选择生成、PNG 整层或更新。';
            empty.append(glyph, title, body);
            tree.appendChild(empty);
            return;
        }
        state.document.tree.forEach((node) => appendTreeNode(tree, node, 0));
    }, resetScroll);
    renderNodeProperties();
}
function updateSummary() {
    if (batchItems.length) {
        rememberActiveFrame();
        renderBatch();
    }
    const nodes = state.document ? flatten(state.document.tree) : [];
    const selected = nodes.filter((node) => state.actions.get(node.id) !== 'ignore');
    element('#node-count').textContent = `${nodes.length} 节点`;
    element('#selection-summary').textContent = state.document
        ? `${selected.length} / ${nodes.length} 个节点将参与导入`
        : '等待设计数据';
    element('#import-button').disabled = state.busy
        || !state.document
        || !selected.length
        || !state.runtimeCompatible;
    workflow === null || workflow === void 0 ? void 0 : workflow.render();
}
async function preview(node) {
    if (state.busy) {
        return;
    }
    state.selectedId = node.id;
    const revision = ++previewRevision;
    const frameId = activeBatchId;
    renderTree();
    element('#preview-meta').textContent = `${effectiveNodeName(node)} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    const stage = element('#preview-stage');
    const image = element('#preview-image');
    stage.classList.add('is-loading');
    stage.classList.remove('has-image');
    image.removeAttribute('src');
    try {
        const precedingSync = batchSyncTask;
        const read = previewReadTask.catch(() => undefined).then(async () => {
            await precedingSync;
            if (previewRevision !== revision || frameId !== activeBatchId)
                return null;
            return request('get-preview', node.id);
        });
        previewReadTask = read.catch(() => undefined);
        const result = await read;
        if (!result)
            return;
        if (state.selectedId !== node.id || previewRevision !== revision || frameId !== activeBatchId) {
            return;
        }
        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('预览图片加载失败。'));
            image.src = result.url;
        });
        if (previewRevision === revision)
            stage.classList.add('has-image');
    }
    catch (error) {
        if (previewRevision === revision)
            showToast(error instanceof Error ? error.message : '预览失败。', true);
    }
    finally {
        if (previewRevision === revision)
            stage.classList.remove('is-loading');
    }
}
function applyPreset(name) {
    if (!state.document) {
        return;
    }
    const all = flatten(state.document.tree);
    if (name === 'smart') {
        state.explicitIds.clear();
        state.patches = (0, model_1.defaultNineSliceIds)(state.document.tree);
        for (const node of all) {
            const original = state.defaults.get(node.id);
            state.preferredActions.set(node.id, original.action);
            state.kinds.set(node.id, original.kind);
        }
    }
    else if (name === 'editable') {
        for (const node of all) {
            state.preferredActions.set(node.id, (0, model_1.isVectorNodeType)(node.type) ? 'render' : 'generate');
            state.explicitIds.add(node.id);
        }
    }
    else {
        for (const node of all) {
            state.preferredActions.set(node.id, node.children.length
                ? 'generate'
                : 'render');
            state.explicitIds.add(node.id);
        }
    }
    reconcileActions();
    root().querySelectorAll('[data-preset]').forEach((button) => {
        button.classList.toggle('active', button.dataset.preset === name);
    });
    renderTree();
    updateSummary();
    persistNodeOverrides();
}
async function importToScene() {
    var _a, _b;
    if (workflow && workflow.step !== 3)
        return;
    if (!state.runtimeCompatible) {
        showToast('扩展主进程仍是旧版，请保存项目并完整重启 Cocos Creator。', true);
        return;
    }
    if (!state.document || state.busy) {
        return;
    }
    const settings = readSettings();
    if (!settings) {
        workflow === null || workflow === void 0 ? void 0 : workflow.fail('请检查导入倍率与输出目录，修正后再次导入。');
        return;
    }
    if (batchItems.length) {
        await importBatchFrames(settings);
        return;
    }
    const overrides = flatten(state.document.tree).map((node) => {
        var _a, _b;
        return ({
            id: node.id,
            action: (_a = state.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action,
            kind: (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: state.patches.has(node.id),
            explicit: state.explicitIds.has(node.id),
            ...(state.renamedIds.has(node.id) ? { name: effectiveNodeName(node) } : {}),
        });
    });
    workflow === null || workflow === void 0 ? void 0 : workflow.begin('import');
    setBusy(true);
    updateProgress({ phase: 'assets', value: 0, message: '正在准备导入…' });
    try {
        const result = await request('import-selection', { overrides, settings });
        const fallbackNote = ((_a = result === null || result === void 0 ? void 0 : result.warnings) === null || _a === void 0 ? void 0 : _a.length)
            ? `；${result.warnings.length} 条导入/收尾提示（详见结果检查）`
            : '';
        showToast((result === null || result === void 0 ? void 0 : result.prefabUrl)
            ? `导入完成，已创建预制体：${result.prefabUrl}${fallbackNote}`
            : `导入完成，已在场景中选中根节点${fallbackNote}。`);
        workflow === null || workflow === void 0 ? void 0 : workflow.complete(result);
        const review = (_b = result.review) !== null && _b !== void 0 ? _b : pendingImportReview;
        pendingImportReview = null;
        if (review)
            importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
    }
    catch (error) {
        const message = errorMessage(error, '导入失败。');
        updateProgress({ phase: (workflow === null || workflow === void 0 ? void 0 : workflow.cancelled) ? 'cancelled' : 'error', value: 0, message });
        showToast(message, !(workflow === null || workflow === void 0 ? void 0 : workflow.cancelled));
    }
    finally {
        workflow === null || workflow === void 0 ? void 0 : workflow.end();
        setBusy(false);
        updateSummary();
    }
}
function mergeBatchItems(items) {
    var _a;
    for (const item of items) {
        const previous = batchItems.find((entry) => entry.item.id === item.id);
        if (previous)
            previous.item = { ...item, enabled: previous.item.enabled };
        else
            batchItems.push({ item, editor: initialFrameEditor(item.document), configured: Boolean((_a = item.document.nodeOverrides) === null || _a === void 0 ? void 0 : _a.length) });
    }
}
async function readBatchSource() {
    var _a, _b, _c, _d, _e, _f;
    if (state.busy)
        return;
    if (workflow && !workflow.credentialsReady) {
        workflow.openCredentials();
        return;
    }
    const source = element('#source-url').value.trim();
    if (!source) {
        showToast('请粘贴 Figma Section 或 Frame 链接。', true);
        return;
    }
    rememberActiveFrame();
    const settings = readSettings(false);
    if (settings)
        state.settings = settings;
    workflow === null || workflow === void 0 ? void 0 : workflow.begin('fetch');
    setBusy(true);
    updateProgress({ phase: 'fetch', value: 0.05, message: '正在读取并识别 Figma 界面…' });
    let activate;
    try {
        await batchSyncTask;
        await previewReadTask.catch(() => undefined);
        if (batchSyncError)
            throw batchSyncError;
        const result = await request('resolve-batch-source', source);
        if (result.document && !result.items.length) {
            batchItems = [];
            activeBatchId = undefined;
            batchResult = undefined;
            batchProgress = undefined;
            syncBatchItems();
            state.fontAssets = (_a = result.document.fontAssets) !== null && _a !== void 0 ? _a : state.fontAssets;
            initializeDocument(result.document);
        }
        else {
            mergeBatchItems(result.items);
            batchResult = undefined;
            batchProgress = undefined;
            state.fontAssets = Array.from(new Map(batchItems.flatMap(({ item }) => { var _a; return (_a = item.document.fontAssets) !== null && _a !== void 0 ? _a : []; }).map((font) => [font.url, font])).values());
            activate = (_e = (_c = (_b = selectedFrames().find(({ item }) => item.id === activeBatchId)) === null || _b === void 0 ? void 0 : _b.item.id) !== null && _c !== void 0 ? _c : (_d = selectedFrames()[0]) === null || _d === void 0 ? void 0 : _d.item.id) !== null && _e !== void 0 ? _e : (_f = batchItems[0]) === null || _f === void 0 ? void 0 : _f.item.id;
            activeBatchId = undefined;
            syncBatchItems();
            element('#source-url').value = '';
            workflow === null || workflow === void 0 ? void 0 : workflow.batchReady();
            showToast(`已添加 ${result.added} 个界面${result.duplicates ? `，跳过 ${result.duplicates} 个重复项` : ''}。`);
        }
    }
    catch (error) {
        const message = errorMessage(error, '读取失败。');
        if (!(workflow === null || workflow === void 0 ? void 0 : workflow.cancelled))
            workflow === null || workflow === void 0 ? void 0 : workflow.fail(message);
        showToast((workflow === null || workflow === void 0 ? void 0 : workflow.cancelled) ? '读取已取消，配置已保留。' : message, !(workflow === null || workflow === void 0 ? void 0 : workflow.cancelled));
    }
    finally {
        workflow === null || workflow === void 0 ? void 0 : workflow.end();
        setBusy(false);
        if (activate)
            await activateFrame(activate);
        renderBatch();
        updateSummary();
    }
}
function overridesForFrame(entry) {
    var _a;
    const editor = (_a = entry.editor) !== null && _a !== void 0 ? _a : initialFrameEditor(entry.item.document);
    return flatten(entry.item.document.tree).map((node) => {
        var _a, _b, _c;
        return ({
            id: node.id, action: (_a = editor.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action, kind: (_b = editor.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: editor.patches.has(node.id), explicit: editor.explicitIds.has(node.id),
            ...(editor.renamedIds.has(node.id) ? { name: (_c = editor.names.get(node.id)) !== null && _c !== void 0 ? _c : node.name } : {}),
        });
    });
}
async function importBatchFrames(settings, ids) {
    if (state.busy || batchImportPending)
        return;
    rememberActiveFrame();
    const entries = selectedFrames().filter(({ item }) => !ids || ids.has(item.id));
    if (!entries.length) {
        showToast('请先勾选要导入的界面。', true);
        return;
    }
    if (batchConflicts().size) {
        workflow === null || workflow === void 0 ? void 0 : workflow.fail('存在重复的 Prefab 文件名，请先在清单中改名。');
        return;
    }
    batchImportPending = true;
    batchProgress = undefined;
    batchStopRequested = false;
    const previous = batchResult;
    workflow === null || workflow === void 0 ? void 0 : workflow.begin('import');
    setBusy(true);
    renderBatch();
    updateProgress({ phase: 'assets', value: 0, message: `准备导入 ${entries.length} 个界面…` });
    try {
        await batchSyncTask;
        await previewReadTask.catch(() => undefined);
        if (batchSyncError)
            throw batchSyncError;
        await nodeOverrideSaveTask;
        if (batchStopRequested) {
            completeBatchPresentation({ id: 'stopped-before-start', stopped: true, completed: 0, total: entries.length,
                items: entries.map(({ item }) => ({ id: item.id, name: item.name, sourceUrl: item.sourceUrl, status: 'pending' })) });
            return;
        }
        const result = await request('import-batch', {
            items: entries.map((entry) => ({ id: entry.item.id, overrides: overridesForFrame(entry) })), settings,
            failurePolicy: 'continue', preserveResults: Boolean(ids),
        });
        const merged = ids && previous ? previous.items.map((item) => { var _a; return (_a = result.items.find((next) => next.id === item.id)) !== null && _a !== void 0 ? _a : item; }) : result.items;
        batchResult = { ...result, items: merged, total: merged.length, completed: merged.filter((item) => item.status === 'success' || item.status === 'failed').length };
        batchProgress = undefined;
        pendingImportReview = null;
        const created = merged.reduce((sum, item) => { var _a; return sum + ((_a = item.created) !== null && _a !== void 0 ? _a : 0); }, 0);
        const updated = merged.reduce((sum, item) => { var _a; return sum + ((_a = item.updated) !== null && _a !== void 0 ? _a : 0); }, 0);
        workflow === null || workflow === void 0 ? void 0 : workflow.complete({ created, updated, warnings: merged.flatMap((item) => { var _a; return (_a = item.warnings) !== null && _a !== void 0 ? _a : []; }) });
        showToast(`本批完成：成功 ${merged.filter((item) => item.status === 'success').length} 项，失败 ${merged.filter((item) => item.status === 'failed').length} 项。`);
    }
    catch (error) {
        const message = errorMessage(error, '批量导入失败。');
        workflow === null || workflow === void 0 ? void 0 : workflow.fail(message);
        showToast(message, true);
    }
    finally {
        batchImportPending = false;
        workflow === null || workflow === void 0 ? void 0 : workflow.end();
        setBusy(false);
        renderBatch();
        updateSummary();
    }
}
async function retryBatch(status) {
    if (state.busy || !batchResult)
        return;
    const settings = readSettings();
    if (!settings)
        return;
    const ids = new Set(batchResult.items.filter((item) => item.status === status).map((item) => item.id));
    await importBatchFrames(settings, ids);
}
function completeBatchPresentation(result) {
    batchResult = result;
    batchProgress = undefined;
    workflow === null || workflow === void 0 ? void 0 : workflow.complete({
        created: result.items.reduce((sum, item) => { var _a; return sum + ((_a = item.created) !== null && _a !== void 0 ? _a : 0); }, 0),
        updated: result.items.reduce((sum, item) => { var _a; return sum + ((_a = item.updated) !== null && _a !== void 0 ? _a : 0); }, 0),
        warnings: result.items.flatMap((item) => { var _a; return (_a = item.warnings) !== null && _a !== void 0 ? _a : []; }),
    });
    renderBatch();
}
function watchRestoredBatch() {
    batchRecoveryTimer = setTimeout(async () => {
        if (!panelHost)
            return;
        try {
            const recovered = await request('get-batch-state');
            if (recovered.running) {
                batchProgress = recovered.running;
                renderBatchResults();
                watchRestoredBatch();
                return;
            }
            workflow === null || workflow === void 0 ? void 0 : workflow.end();
            setBusy(false);
            if (recovered.lastResult)
                completeBatchPresentation(recovered.lastResult);
            else
                workflow === null || workflow === void 0 ? void 0 : workflow.fail('后台批量任务已经结束，请检查 Cocos 中的导入结果。');
        }
        catch (error) {
            workflow === null || workflow === void 0 ? void 0 : workflow.end();
            setBusy(false);
            workflow === null || workflow === void 0 ? void 0 : workflow.fail(errorMessage(error, '读取后台批量任务失败。'));
        }
    }, 800);
}
async function openImportReview(tab = 'assets') {
    var _a;
    if (state.busy)
        return;
    try {
        const review = await request('get-import-review');
        if (review) {
            importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
            const index = ['assets', 'nodes', 'source'].indexOf(tab);
            if (index > 0)
                (_a = element('#import-review-dialog').querySelectorAll('.review-tabs button')[index]) === null || _a === void 0 ? void 0 : _a.click();
        }
        else
            showToast('本次插件会话尚无导入检查结果，请先完成一次导入。');
    }
    catch (error) {
        showToast(errorMessage(error, '读取检查结果失败。'), true);
    }
}
function bindEvents() {
    element('#open-import-review').addEventListener('click', () => { void openImportReview(); });
    element('#save-token').addEventListener('click', async () => {
        const input = element('#token-input');
        if (!input.value.trim()) {
            showToast('请输入 Figma Token。', true);
            return;
        }
        let saved = false;
        setBusy(true);
        try {
            const vault = await request('set-token', input.value);
            input.value = '';
            setConnection(vault);
            saved = true;
            showToast(vault.persistent ? 'Token 已由系统加密保存。' : 'Token 已保存到本次会话。');
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '保存失败。', true);
        }
        finally {
            setBusy(false);
            if (saved)
                workflow === null || workflow === void 0 ? void 0 : workflow.closeCredentials();
        }
    });
    element('#verify-token').addEventListener('click', async () => {
        setBusy(true);
        try {
            const result = await request('verify-token');
            showToast(`连接成功 · ${result.handle}`);
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '连接失败。', true);
        }
        finally {
            setBusy(false);
        }
    });
    element('#clear-token').addEventListener('click', async () => {
        const vault = await request('clear-token');
        setConnection(vault);
        showToast('已清除保存的 Figma 凭据。');
    });
    element('#roundtrip-detect').addEventListener('click', async () => {
        var _a, _b, _c, _d;
        const source = roundtripSource();
        if (!source)
            return;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const detected = await request('roundtrip-detect', source);
            const select = element('#roundtrip-root');
            select.replaceChildren();
            for (const root of detected.managedRoots) {
                const option = document.createElement('option');
                option.value = root.nodeId;
                option.textContent = root.error
                    ? `${root.name} · 协议损坏`
                    : `${root.name} · ${(_a = root.prefabUuid) !== null && _a !== void 0 ? _a : '未知 Prefab'}`;
                option.disabled = Boolean(root.error);
                select.append(option);
            }
            select.value = (_d = (_b = detected.selectedRootId) !== null && _b !== void 0 ? _b : (_c = detected.managedRoots.find((root) => !root.error)) === null || _c === void 0 ? void 0 : _c.nodeId) !== null && _d !== void 0 ? _d : '';
            select.disabled = detected.managedRoots.length === 0;
            element('#roundtrip-summary').textContent = detected.managedRoots.length
                ? `检测到 ${detected.managedRoots.length} 个 managed root · Figma ${detected.figmaVersion}。选择目标后生成只读预览。`
                : '未检测到 managed root。';
        }
        catch (error) {
            showToast(errorMessage(error, 'Round-trip 检测失败。'), true);
        }
        finally {
            setBusy(false);
        }
    });
    element('#roundtrip-root').addEventListener('change', () => {
        resetRoundtripTokens();
        element('#roundtrip-preview').disabled =
            element('#roundtrip-root').value === '';
    });
    element('#roundtrip-preview').addEventListener('click', async () => {
        const source = roundtripSource();
        const rootId = element('#roundtrip-root').value;
        if (!source || !rootId)
            return;
        resetRoundtripTokens();
        setBusy(true);
        try {
            renderRoundtripPreview(await request('roundtrip-preview', source, rootId));
        }
        catch (error) {
            showToast(errorMessage(error, 'Round-trip 预览失败。'), true);
        }
        finally {
            setBusy(false);
        }
    });
    element('#roundtrip-pair').addEventListener('click', async () => {
        if (!roundtripPairToken)
            return;
        const token = roundtripPairToken;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const paired = await request('roundtrip-pair', token);
            element('#roundtrip-summary').textContent = `配对完成 · Ledger generation ${paired.generation}\nBaseline ${paired.baselineHash}\n请重新生成变更预览。`;
            showToast('Surface 已配对；未修改 Prefab。');
        }
        catch (error) {
            showToast(errorMessage(error, 'Round-trip Pair 失败。'), true);
        }
        finally {
            setBusy(false);
        }
    });
    element('#roundtrip-apply').addEventListener('click', async () => {
        if (!roundtripPreviewToken)
            return;
        const token = roundtripPreviewToken;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const receipt = await request('roundtrip-apply', token);
            element('#roundtrip-summary').textContent = `事务已提交 · ${receipt.txnId}\nPostimage ${receipt.prefabPostimageHash}\n请重新预览以确认 0 patch。`;
            showToast('Round-trip 已原子应用到原 Prefab。');
        }
        catch (error) {
            showToast(errorMessage(error, 'Round-trip 应用失败，事务已回滚。'), true);
        }
        finally {
            setBusy(false);
        }
    });
    element('#roundtrip-cancel').addEventListener('click', () => request('roundtrip-cancel'));
    element('#fetch-document').addEventListener('click', async () => {
        if (state.busy)
            return;
        const forceRead = forceDocumentRead;
        forceDocumentRead = false;
        if (workflow && !workflow.credentialsReady) {
            workflow.openCredentials();
            return;
        }
        if (batchItems.length && !forceRead) {
            const selected = selectedFrames();
            if (!selected.length)
                return;
            await activateFrame(selected.some(({ item }) => item.id === activeBatchId) ? activeBatchId : selected[0].item.id, true);
            return;
        }
        if (forceRead && batchItems.length) {
            const active = batchItems.find(({ item }) => item.id === activeBatchId);
            if (active)
                element('#source-url').value = active.item.sourceUrl;
        }
        if (!forceRead && (workflow === null || workflow === void 0 ? void 0 : workflow.sourceUnchanged())) {
            workflow.navigate(2);
            return;
        }
        await readBatchSource();
    });
    element('#add-batch-source').addEventListener('click', readBatchSource);
    element('#batch-edit-list').addEventListener('click', () => workflow === null || workflow === void 0 ? void 0 : workflow.navigate(1));
    element('#batch-toggle-all').addEventListener('click', () => {
        if (state.busy)
            return;
        const enabled = selectedFrames().length !== batchItems.length;
        batchItems.forEach(({ item }) => { item.enabled = enabled; });
        syncBatchItems();
        renderBatch();
        renderFontMap();
        workflow === null || workflow === void 0 ? void 0 : workflow.render();
    });
    element('#batch-retry-failed').addEventListener('click', () => retryBatch('failed'));
    element('#batch-resume-pending').addEventListener('click', () => retryBatch('pending'));
    element('#refresh-document').addEventListener('click', () => {
        if (state.busy)
            return;
        forceDocumentRead = true;
        element('#fetch-document').click();
    });
    element('#source-url').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            element('#add-batch-source').click();
        }
    });
    element('#source-url').addEventListener('input', resetRoundtripTokens);
    element('#pick-asset-folder').addEventListener('click', async () => {
        try {
            const current = element('#asset-folder').value;
            const result = await request('pick-asset-folder', current);
            if (!result) {
                return;
            }
            const input = element('#asset-folder');
            input.value = result.folder;
            input.title = result.absolutePath;
            const settings = readSettings(false);
            if (settings) {
                await request('save-settings', settings);
            }
            showToast(`资源将写入 assets/${result.folder}`);
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '选择资源目录失败。', true);
        }
    });
    element('#pick-prefab-folder').addEventListener('click', async () => {
        try {
            const current = element('#prefab-folder').value;
            const result = await request('pick-prefab-folder', current);
            if (!result) {
                return;
            }
            const input = element('#prefab-folder');
            input.value = result.folder;
            input.title = result.absolutePath;
            const settings = readSettings(false);
            if (settings) {
                await request('save-settings', settings);
            }
            showToast(`预制体将写入 assets/${result.folder}`);
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '选择预制体目录失败。', true);
        }
    });
    for (let index = 0; index < 3; index += 1) {
        element(`#pick-local-resource-folder-${index}`).addEventListener('click', async () => {
            if (!state.runtimeCompatible) {
                showToast('请先保存项目并完整重启 Cocos Creator，再选择本地资源目录。', true);
                return;
            }
            try {
                const current = element(`#local-resource-folder-${index}`).value;
                const result = await request('pick-local-resource-folder', current, index);
                if (!result) {
                    return;
                }
                const input = element(`#local-resource-folder-${index}`);
                input.value = result.folder;
                input.title = result.folder;
                const settings = readSettings(false);
                if (settings) {
                    await request('save-settings', settings);
                }
                showToast(`已启用本地同名资源目录 ${index + 1}。`);
            }
            catch (error) {
                showToast(error instanceof Error ? error.message : '选择本地资源目录失败。', true);
            }
        });
        element(`#clear-local-resource-folder-${index}`).addEventListener('click', async () => {
            if (!state.runtimeCompatible) {
                showToast('请先保存项目并完整重启 Cocos Creator。', true);
                return;
            }
            const input = element(`#local-resource-folder-${index}`);
            input.value = '';
            input.title = '';
            const settings = readSettings(false);
            if (settings) {
                await request('save-settings', settings);
            }
            showToast(`已清除本地同名资源目录 ${index + 1}。`);
        });
    }
    element('#import-button').addEventListener('click', importToScene);
    element('#cancel-import').addEventListener('click', async () => {
        if (!state.busy)
            return;
        if (batchImportPending)
            batchStopRequested = true;
        workflow === null || workflow === void 0 ? void 0 : workflow.cancelRequested();
        try {
            await request(batchImportPending ? 'stop-import-batch' : 'cancel-import');
        }
        catch (error) {
            const message = errorMessage(error, '取消请求失败，请稍后重试。');
            workflow === null || workflow === void 0 ? void 0 : workflow.cancelRequestFailed(message);
            showToast(message, true);
        }
    });
    element('#tree-search').addEventListener('input', (event) => {
        state.search = event.target.value.trim().toLowerCase();
        renderTree();
    });
    element('#tree').addEventListener('click', (event) => {
        var _a, _b;
        if (state.busy)
            return;
        const target = event.target;
        const collapseId = (_a = target.closest('[data-collapse]')) === null || _a === void 0 ? void 0 : _a.dataset.collapse;
        if (collapseId) {
            if (state.collapsed.has(collapseId)) {
                state.collapsed.delete(collapseId);
            }
            else {
                state.collapsed.add(collapseId);
            }
            renderTree();
            return;
        }
        if (target.closest('select, label, input, textarea')) {
            return;
        }
        const id = (_b = target.closest('[data-node-id]')) === null || _b === void 0 ? void 0 : _b.dataset.nodeId;
        const node = id ? findNode(id) : undefined;
        if (node) {
            void preview(node);
        }
    });
    root().addEventListener('change', (event) => {
        if (state.busy)
            return;
        const target = event.target;
        if (!target.dataset.nameFor && !target.dataset.actionFor && !target.dataset.kindFor && !target.dataset.patchFor)
            return;
        if (target.dataset.nameFor) {
            const node = findNode(target.dataset.nameFor);
            if (!node)
                return;
            const customName = (0, node_name_1.sanitizeNodeName)(target.value);
            if (!customName) {
                target.value = effectiveNodeName(node);
                showToast('节点名不能为空。', true);
                return;
            }
            state.names.set(node.id, customName);
            if (customName === node.name) {
                state.renamedIds.delete(node.id);
            }
            else {
                state.renamedIds.add(node.id);
            }
            renderTree();
            persistNodeOverrides();
            showToast(state.renamedIds.has(node.id)
                ? `节点将以“${customName}”导入。`
                : '已恢复 Figma 原节点名。');
        }
        else if (target.dataset.actionFor) {
            const node = findNode(target.dataset.actionFor);
            if (node) {
                const action = target.value;
                state.explicitIds.add(node.id);
                if (action !== 'render') {
                    state.patches.delete(node.id);
                }
                setAction(node, action);
                root().querySelectorAll('[data-preset]')
                    .forEach((button) => button.classList.remove('active'));
                if (action === 'render' && node.children.length) {
                    showToast(`“${effectiveNodeName(node)}”将作为整层导入，${descendants(node).length} 个子节点不会单独生成。`);
                }
                renderTree();
                persistNodeOverrides();
            }
        }
        else if (target.dataset.kindFor) {
            state.kinds.set(target.dataset.kindFor, target.value);
            state.explicitIds.add(target.dataset.kindFor);
            root().querySelectorAll('[data-preset]')
                .forEach((button) => button.classList.remove('active'));
            renderTree();
            persistNodeOverrides();
        }
        else if (target.dataset.patchFor) {
            state.explicitIds.add(target.dataset.patchFor);
            if (target.checked) {
                state.patches.add(target.dataset.patchFor);
                const node = findNode(target.dataset.patchFor);
                if (node) {
                    setAction(node, 'render');
                }
            }
            else {
                state.patches.delete(target.dataset.patchFor);
                reconcileActions();
            }
            renderTree();
            root().querySelectorAll('[data-preset]')
                .forEach((button) => button.classList.remove('active'));
            persistNodeOverrides();
        }
        updateSummary();
    });
    root().addEventListener('keydown', (event) => {
        const target = event.target;
        const id = target.dataset.nameFor;
        if (!id)
            return;
        if (event.key === 'Enter') {
            event.preventDefault();
            target.blur();
        }
        else if (event.key === 'Escape') {
            const node = findNode(id);
            if (node)
                target.value = effectiveNodeName(node);
            target.blur();
        }
    });
    root().querySelectorAll('[data-preset]').forEach((button) => {
        button.addEventListener('click', () => { var _a; return applyPreset((_a = button.dataset.preset) !== null && _a !== void 0 ? _a : 'smart'); });
    });
    root().querySelectorAll('#scale, #asset-folder, #prefab-folder, #local-resource-folder, #update-existing, #refresh-assets, #auto-save').forEach((control) => {
        control.addEventListener('change', async () => {
            const settings = readSettings(false);
            if (settings) {
                await request('save-settings', settings);
            }
        });
    });
    element('#font-map-list').addEventListener('change', async () => {
        const settings = readSettings(false);
        if (settings) {
            state.settings = settings;
            await request('save-settings', settings);
        }
    });
}
module.exports = Editor.Panel.define({
    listeners: {
        show() { },
        hide() { },
    },
    template: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/template/default/index.html'), 'utf8'),
    style: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/style/default/index.css'), 'utf8'),
    $: {
        app: '#app',
    },
    methods: {
        onImportReviewReady(review) {
            if (batchItems.length) {
                workflow === null || workflow === void 0 ? void 0 : workflow.rememberReview();
                return;
            }
            if (state.busy || (workflow === null || workflow === void 0 ? void 0 : workflow.pending)) {
                pendingImportReview = review;
                return;
            }
            workflow === null || workflow === void 0 ? void 0 : workflow.complete({ review });
            importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
        },
        onProgress(event) {
            updateProgress(event);
        },
    },
    async ready() {
        var _a, _b;
        panelHost = this;
        importReviewPanel = new import_review_1.ImportReviewPanel(root(), request, setBusy);
        workflow = new workflow_1.PanelWorkflow(root(), () => ({ ...state, batch: batchContext() }), (tab) => { void openImportReview(tab); });
        bindEvents();
        try {
            const initial = await request('get-state');
            state.runtimeCompatible = initial.version === package_json_1.default.version;
            state.fontAssets = (_a = initial.fontAssets) !== null && _a !== void 0 ? _a : [];
            setConnection(initial.vault);
            applySettings(initial.settings);
            if (initial.document) {
                initializeDocument(initial.document);
            }
            const batch = await request('get-batch-state');
            if (batch === null || batch === void 0 ? void 0 : batch.items.length) {
                mergeBatchItems(batch.items);
                state.fontAssets = Array.from(new Map(batch.items.flatMap((item) => { var _a; return (_a = item.document.fontAssets) !== null && _a !== void 0 ? _a : []; }).map((font) => [font.url, font])).values());
                workflow.batchReady();
                const active = (_b = selectedFrames()[0]) !== null && _b !== void 0 ? _b : batchItems[0];
                if (batch.running) {
                    activeBatchId = active.item.id;
                    Object.assign(state, active.editor);
                    renderTree();
                    renderFontMap();
                }
                else
                    await activateFrame(active.item.id);
                renderBatch();
                if (batch.lastResult)
                    completeBatchPresentation(batch.lastResult);
                if (batch.running) {
                    batchProgress = batch.running;
                    workflow.begin('import');
                    setBusy(true);
                    watchRestoredBatch();
                }
            }
            if (!state.runtimeCompatible) {
                updateSummary();
                const button = element('#import-button');
                button.classList.add('is-error');
                element('#import-button-label').textContent = '请重启 Cocos';
                element('#import-button-percent').textContent = '↻';
                showToast('检测到旧版主进程仍在运行：请保存项目并完整重启 Cocos Creator。', true);
            }
            else {
                // Replay persisted in-memory report if completion preceded panel readiness.
                const review = await request('get-import-review');
                if (review)
                    workflow.rememberReview();
                if (review && !review.confirmed && !batchItems.length) {
                    workflow.complete({ review });
                    importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
                }
            }
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '初始化失败。', true);
        }
    },
    beforeClose() { },
    close() {
        importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.dispose();
        importReviewPanel = null;
        workflow = null;
        pendingImportReview = null;
        if (toastTimer)
            clearTimeout(toastTimer);
        if (importButtonResetTimer)
            clearTimeout(importButtonResetTimer);
        if (batchRecoveryTimer)
            clearTimeout(batchRecoveryTimer);
        batchItems = [];
        activeBatchId = undefined;
        batchResult = undefined;
        batchProgress = undefined;
        batchImportPending = false;
        batchSyncError = undefined;
        batchSyncTask = Promise.resolve();
        previewRevision++;
        previewReadTask = Promise.resolve();
        panelHost = null;
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQTJGO0FBRTNGLGtEQUEwRDtBQUUxRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCxtQ0FVaUI7QUFtRWpCLElBQUksU0FBUyxHQUFRLElBQUksQ0FBQztBQUMxQixJQUFJLGlCQUFpQixHQUE2QixJQUFJLENBQUM7QUFDdkQsSUFBSSxRQUFRLEdBQXlCLElBQUksQ0FBQztBQUMxQyxJQUFJLG1CQUFtQixHQUF3QixJQUFJLENBQUM7QUFDcEQsSUFBSSxpQkFBaUIsR0FBRyxLQUFLLENBQUM7QUFDOUIsSUFBSSxVQUFVLEdBQXlDLElBQUksQ0FBQztBQUM1RCxJQUFJLHNCQUFzQixHQUF5QyxJQUFJLENBQUM7QUFDeEUsSUFBSSxvQkFBb0IsR0FBa0IsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQzVELElBQUkscUJBQXlDLENBQUM7QUFDOUMsSUFBSSxrQkFBc0MsQ0FBQztBQUczQyxJQUFJLFVBQVUsR0FBc0IsRUFBRSxDQUFDO0FBQ3ZDLElBQUksYUFBaUMsQ0FBQztBQUN0QyxJQUFJLFdBQTBDLENBQUM7QUFDL0MsSUFBSSxhQUF3QyxDQUFDO0FBQzdDLElBQUksYUFBYSxHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDckQsSUFBSSxjQUF1QixDQUFDO0FBQzVCLElBQUksa0JBQWtCLEdBQUcsS0FBSyxDQUFDO0FBQy9CLElBQUksa0JBQWtCLEdBQUcsS0FBSyxDQUFDO0FBQy9CLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQztBQUN4QixJQUFJLGVBQWUsR0FBcUIsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQzFE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RSxPQUFPLEVBQUUsQ0FBQztRQUM3QixpQkFBaUIsR0FBRyxJQUFJLENBQUM7UUFDekIsUUFBUSxHQUFHLElBQUksQ0FBQztRQUNoQixtQkFBbUIsR0FBRyxJQUFJLENBQUM7UUFDM0IsSUFBSSxVQUFVO1lBQUUsWUFBWSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQ3pDLElBQUksc0JBQXNCO1lBQUUsWUFBWSxDQUFDLHNCQUFzQixDQUFDLENBQUM7UUFDakUsSUFBSSxrQkFBa0I7WUFBRSxZQUFZLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUN6RCxVQUFVLEdBQUcsRUFBRSxDQUFDO1FBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQztRQUFDLFdBQVcsR0FBRyxTQUFTLENBQUM7UUFBQyxhQUFhLEdBQUcsU0FBUyxDQUFDO1FBQy9GLGtCQUFrQixHQUFHLEtBQUssQ0FBQztRQUFDLGNBQWMsR0FBRyxTQUFTLENBQUM7UUFBQyxhQUFhLEdBQUcsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQUMsZUFBZSxFQUFFLENBQUM7UUFDN0csZUFBZSxHQUFHLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNwQyxTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ3JCLENBQUM7Q0FDSixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uLy4uLy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEltcG9ydFJldmlld1BhbmVsIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3JztcclxuaW1wb3J0IHsgUGFuZWxXb3JrZmxvdywgdHlwZSBCYXRjaFdvcmtmbG93Q29udGV4dCwgdHlwZSBXb3JrZmxvd1Jlc3VsdCB9IGZyb20gJy4vd29ya2Zsb3cnO1xyXG5pbXBvcnQgdHlwZSB7IEJhdGNoRnJhbWVJdGVtLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQsIEJhdGNoSW1wb3J0UmVzdWx0LCBCYXRjaFByb2dyZXNzLCBCYXRjaFNvdXJjZVJlc3VsdCwgQmF0Y2hTdGF0ZSB9IGZyb20gJy4uLy4uL2JhdGNoLXR5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVBc3NldE5hbWUgfSBmcm9tICcuLi8uLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldyB9IGZyb20gJy4uLy4uL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5pbXBvcnQgeyBmaW5kRm9udEFzc2V0LCB0eXBlIEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgbm9ybWFsaXplSW1wb3J0QWN0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi4vLi4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHtcclxuICAgIGFjdGlvbk9wdGlvbnNGb3JOb2RlLFxyXG4gICAgZGVmYXVsdE5pbmVTbGljZUlkcyxcclxuICAgIGVmZmVjdGl2ZUtpbmRGb3JOb2RlLFxyXG4gICAgaXNWZWN0b3JOb2RlVHlwZSxcclxuICAgIGtpbmRPcHRpb25zRm9yQWN0aW9uLFxyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsLFxyXG4gICAgcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMsXHJcbiAgICBzbWFydEFjdGlvbkZvck5vZGUsXHJcbiAgICBzdHJhdGVneVN1bW1hcnlGb3JOb2RlLFxyXG59IGZyb20gJy4vbW9kZWwnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBJbXBvcnRBY3Rpb24sXHJcbiAgICBJbXBvcnRPdmVycmlkZSxcclxuICAgIEltcG9ydFNldHRpbmdzLFxyXG4gICAgTm9kZUtpbmQsXHJcbiAgICBQcm9ncmVzc0V2ZW50LFxyXG4gICAgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuaW50ZXJmYWNlIERvY3VtZW50RHRvIHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIGZpbGVOYW1lOiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHRyZWU6IFRyZWVOb2RlRHRvW107XHJcbiAgICBmb250czogc3RyaW5nW107XHJcbiAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICBub2RlT3ZlcnJpZGVzPzogSW1wb3J0T3ZlcnJpZGVbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFJvdW5kdHJpcERldGVjdER0byB7XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIG1hbmFnZWRSb290czogQXJyYXk8eyBub2RlSWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwcmVmYWJVdWlkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PjtcclxuICAgIHNlbGVjdGVkUm9vdElkPzogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwUHJldmlld0R0byB7XHJcbiAgICBwcmV2aWV3VG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyVG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyUmVxdWlyZWQ6IGJvb2xlYW47XHJcbiAgICBwYWlyRWxpZ2libGU6IGJvb2xlYW47XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIHN1cmZhY2VJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgYXNzZXRVcmw6IHN0cmluZztcclxuICAgIGxlZGdlckdlbmVyYXRpb246IG51bWJlcjtcclxuICAgIGJsb2NrZXJzOiBzdHJpbmdbXTtcclxuICAgIHBsYW46IHtcclxuICAgICAgICBhcHBseTogdW5rbm93bltdO1xyXG4gICAgICAgIHByZXNlcnZlQ29jb3M6IHVua25vd25bXTtcclxuICAgICAgICBjb252ZXJnZWQ6IHVua25vd25bXTtcclxuICAgICAgICBjb25mbGljdHM6IHVua25vd25bXTtcclxuICAgICAgICB1bnN1cHBvcnRlZDogdW5rbm93bltdO1xyXG4gICAgICAgIHJlYWRvbmx5VW5jaGFuZ2VkOiB1bmtub3duW107XHJcbiAgICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGFuZWxTdGF0ZSB7XHJcbiAgICBkb2N1bWVudDogRG9jdW1lbnREdG8gfCBudWxsO1xyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgcHJlZmVycmVkQWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGFjdGlvbnM6IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj47XHJcbiAgICBraW5kczogTWFwPHN0cmluZywgTm9kZUtpbmQ+O1xyXG4gICAgcGF0Y2hlczogU2V0PHN0cmluZz47XHJcbiAgICBleHBsaWNpdElkczogU2V0PHN0cmluZz47XHJcbiAgICBuYW1lczogTWFwPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHJlbmFtZWRJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgZGVmYXVsdHM6IE1hcDxzdHJpbmcsIHsgYWN0aW9uOiBJbXBvcnRBY3Rpb247IGtpbmQ6IE5vZGVLaW5kIH0+O1xyXG4gICAgY29sbGFwc2VkOiBTZXQ8c3RyaW5nPjtcclxuICAgIHN1cHByZXNzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc2VsZWN0ZWRJZD86IHN0cmluZztcclxuICAgIHNlYXJjaDogc3RyaW5nO1xyXG4gICAgYnVzeTogYm9vbGVhbjtcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiBib29sZWFuO1xyXG4gICAgZm9udEFzc2V0czogRm9udEFzc2V0T3B0aW9uW107XHJcbn1cclxuXHJcbmxldCBwYW5lbEhvc3Q6IGFueSA9IG51bGw7XHJcbmxldCBpbXBvcnRSZXZpZXdQYW5lbDogSW1wb3J0UmV2aWV3UGFuZWwgfCBudWxsID0gbnVsbDtcclxubGV0IHdvcmtmbG93OiBQYW5lbFdvcmtmbG93IHwgbnVsbCA9IG51bGw7XHJcbmxldCBwZW5kaW5nSW1wb3J0UmV2aWV3OiBJbXBvcnRSZXZpZXcgfCBudWxsID0gbnVsbDtcclxubGV0IGZvcmNlRG9jdW1lbnRSZWFkID0gZmFsc2U7XHJcbmxldCB0b2FzdFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgaW1wb3J0QnV0dG9uUmVzZXRUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxubGV0IG5vZGVPdmVycmlkZVNhdmVUYXNrOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCByb3VuZHRyaXBQcmV2aWV3VG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcclxubGV0IHJvdW5kdHJpcFBhaXJUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG50eXBlIEZyYW1lRWRpdG9yU3RhdGUgPSBQaWNrPFBhbmVsU3RhdGUsICdkb2N1bWVudCcgfCAncHJlZmVycmVkQWN0aW9ucycgfCAnYWN0aW9ucycgfCAna2luZHMnIHwgJ3BhdGNoZXMnIHwgJ2V4cGxpY2l0SWRzJyB8ICduYW1lcycgfCAncmVuYW1lZElkcycgfCAnZGVmYXVsdHMnIHwgJ2NvbGxhcHNlZCcgfCAnc3VwcHJlc3NlZCcgfCAnc2VsZWN0ZWRJZCcgfCAnc2VhcmNoJz4gJiB7IHRyZWVTY3JvbGw6IG51bWJlcjsgcHJlc2V0Pzogc3RyaW5nIH07XHJcbmludGVyZmFjZSBGcmFtZUVkaXRvckl0ZW0geyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZWRpdG9yPzogRnJhbWVFZGl0b3JTdGF0ZTsgY29uZmlndXJlZDogYm9vbGVhbiB9XHJcbmxldCBiYXRjaEl0ZW1zOiBGcmFtZUVkaXRvckl0ZW1bXSA9IFtdO1xyXG5sZXQgYWN0aXZlQmF0Y2hJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hSZXN1bHQ6IEJhdGNoSW1wb3J0UmVzdWx0IHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hQcm9ncmVzczogQmF0Y2hQcm9ncmVzcyB8IHVuZGVmaW5lZDtcclxubGV0IGJhdGNoU3luY1Rhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IGJhdGNoU3luY0Vycm9yOiB1bmtub3duO1xyXG5sZXQgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7XHJcbmxldCBiYXRjaFN0b3BSZXF1ZXN0ZWQgPSBmYWxzZTtcclxubGV0IHByZXZpZXdSZXZpc2lvbiA9IDA7XHJcbmxldCBwcmV2aWV3UmVhZFRhc2s6IFByb21pc2U8dW5rbm93bj4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IGJhdGNoUmVjb3ZlcnlUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxuXHJcbmNvbnN0IHN0YXRlOiBQYW5lbFN0YXRlID0ge1xyXG4gICAgZG9jdW1lbnQ6IG51bGwsXHJcbiAgICBzZXR0aW5nczoge1xyXG4gICAgICAgIHNvdXJjZVVybDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6ICdmaWdtYS1pbXBvcnRlcicsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXIvcHJlZmFicycsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IFtdLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6ICcnLFxyXG4gICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGZhbHNlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBmYWxzZSxcclxuICAgICAgICBmb250TWFwOiB7fSxcclxuICAgIH0sXHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBhY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgcGF0Y2hlczogbmV3IFNldCgpLFxyXG4gICAgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSxcclxuICAgIG5hbWVzOiBuZXcgTWFwKCksXHJcbiAgICByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICBkZWZhdWx0czogbmV3IE1hcCgpLFxyXG4gICAgY29sbGFwc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzdXBwcmVzc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzZWFyY2g6ICcnLFxyXG4gICAgYnVzeTogZmFsc2UsXHJcbiAgICBydW50aW1lQ29tcGF0aWJsZTogdHJ1ZSxcclxuICAgIGZvbnRBc3NldHM6IFtdLFxyXG59O1xyXG5cclxuZnVuY3Rpb24gc2VsZWN0ZWRGcmFtZXMoKTogRnJhbWVFZGl0b3JJdGVtW10geyByZXR1cm4gYmF0Y2hJdGVtcy5maWx0ZXIoKHsgaXRlbSB9KSA9PiBpdGVtLmVuYWJsZWQpOyB9XHJcblxyXG5mdW5jdGlvbiBlZGl0b3JTbmFwc2hvdCgpOiBGcmFtZUVkaXRvclN0YXRlIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZG9jdW1lbnQ6IHN0YXRlLmRvY3VtZW50LFxyXG4gICAgICAgIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoc3RhdGUucHJlZmVycmVkQWN0aW9ucyksIGFjdGlvbnM6IG5ldyBNYXAoc3RhdGUuYWN0aW9ucyksXHJcbiAgICAgICAga2luZHM6IG5ldyBNYXAoc3RhdGUua2luZHMpLCBwYXRjaGVzOiBuZXcgU2V0KHN0YXRlLnBhdGNoZXMpLCBleHBsaWNpdElkczogbmV3IFNldChzdGF0ZS5leHBsaWNpdElkcyksXHJcbiAgICAgICAgbmFtZXM6IG5ldyBNYXAoc3RhdGUubmFtZXMpLCByZW5hbWVkSWRzOiBuZXcgU2V0KHN0YXRlLnJlbmFtZWRJZHMpLCBkZWZhdWx0czogbmV3IE1hcChzdGF0ZS5kZWZhdWx0cyksXHJcbiAgICAgICAgY29sbGFwc2VkOiBuZXcgU2V0KHN0YXRlLmNvbGxhcHNlZCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoc3RhdGUuc3VwcHJlc3NlZCksXHJcbiAgICAgICAgc2VsZWN0ZWRJZDogc3RhdGUuc2VsZWN0ZWRJZCwgc2VhcmNoOiBzdGF0ZS5zZWFyY2gsIHRyZWVTY3JvbGw6IGVsZW1lbnQoJyN0cmVlJykuc2Nyb2xsVG9wLFxyXG4gICAgICAgIHByZXNldDogQXJyYXkuZnJvbShyb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKSkuZmluZCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LmNvbnRhaW5zKCdhY3RpdmUnKSk/LmRhdGFzZXQucHJlc2V0LFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbEZyYW1lRWRpdG9yKGRvY3VtZW50OiBEb2N1bWVudER0byk6IEZyYW1lRWRpdG9yU3RhdGUge1xyXG4gICAgY29uc3QgZWRpdG9yOiBGcmFtZUVkaXRvclN0YXRlID0ge1xyXG4gICAgICAgIGRvY3VtZW50LCBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksIGFjdGlvbnM6IG5ldyBNYXAoKSwga2luZHM6IG5ldyBNYXAoKSxcclxuICAgICAgICBwYXRjaGVzOiBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpLCBleHBsaWNpdElkczogbmV3IFNldCgpLCBuYW1lczogbmV3IE1hcCgpLCByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgZGVmYXVsdHM6IG5ldyBNYXAoKSwgY29sbGFwc2VkOiBuZXcgU2V0KCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoKSwgc2VsZWN0ZWRJZDogZG9jdW1lbnQudHJlZVswXT8uaWQsXHJcbiAgICAgICAgc2VhcmNoOiAnJywgdHJlZVNjcm9sbDogMCwgcHJlc2V0OiAnc21hcnQnLFxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBhY3Rpb24pOyBlZGl0b3Iua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgZWRpdG9yLmRlZmF1bHRzLnNldChub2RlLmlkLCB7IGFjdGlvbiwga2luZDogbm9kZS5raW5kIH0pOyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IG92ZXJyaWRlIG9mIGRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUob3ZlcnJpZGUuaWQsIGRvY3VtZW50LnRyZWUpOyBpZiAoIW5vZGUpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChuYW1lICYmIG5hbWUgIT09IG5vZGUubmFtZSkgeyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5hbWUpOyBlZGl0b3IucmVuYW1lZElkcy5hZGQobm9kZS5pZCk7IH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQpIHtcclxuICAgICAgICAgICAgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7IGVkaXRvci5raW5kcy5zZXQobm9kZS5pZCwgb3ZlcnJpZGUua2luZCk7XHJcbiAgICAgICAgICAgIGlmIChvdmVycmlkZS5uaW5lU2xpY2UgJiYgbm9kZS5wYXRjaENhbmRpZGF0ZSkgZWRpdG9yLnBhdGNoZXMuYWRkKG5vZGUuaWQpOyBlbHNlIGVkaXRvci5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgZWRpdG9yLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTsgZWRpdG9yLnByZXNldCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBlZmZlY3RpdmUgPSByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyhkb2N1bWVudC50cmVlLCBlZGl0b3IucHJlZmVycmVkQWN0aW9ucywgZWRpdG9yLnBhdGNoZXMsIGVkaXRvci5leHBsaWNpdElkcywgZWRpdG9yLnJlbmFtZWRJZHMpO1xyXG4gICAgZWRpdG9yLmFjdGlvbnMgPSBlZmZlY3RpdmUuYWN0aW9uczsgZWRpdG9yLnN1cHByZXNzZWQgPSBlZmZlY3RpdmUuc3VwcHJlc3NlZDtcclxuICAgIHJldHVybiBlZGl0b3I7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTogdm9pZCB7XHJcbiAgICBjb25zdCBhY3RpdmUgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKTtcclxuICAgIGlmIChhY3RpdmUpIGFjdGl2ZS5lZGl0b3IgPSBlZGl0b3JTbmFwc2hvdCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmcmFtZU5hbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBlZGl0b3IgPSBlbnRyeS5pdGVtLmlkID09PSBhY3RpdmVCYXRjaElkID8gc3RhdGUgOiBlbnRyeS5lZGl0b3I7XHJcbiAgICByZXR1cm4gZWRpdG9yPy5uYW1lcy5nZXQoZW50cnkuaXRlbS5yb290SWQpID8/IGVudHJ5Lml0ZW0uZG9jdW1lbnQubm9kZU92ZXJyaWRlcz8uZmluZCgob3ZlcnJpZGUpID0+IG92ZXJyaWRlLmlkID09PSBlbnRyeS5pdGVtLnJvb3RJZCk/Lm5hbWUgPz8gZW50cnkuaXRlbS5uYW1lO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaENvbmZsaWN0cygpOiBTZXQ8c3RyaW5nPiB7XHJcbiAgICBjb25zdCBuYW1lcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc2VsZWN0ZWRGcmFtZXMoKSkge1xyXG4gICAgICAgIGNvbnN0IGtleSA9IHNhbml0aXplQXNzZXROYW1lKGZyYW1lTmFtZShlbnRyeSkpLnRvTG9jYWxlTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgbmFtZXMuc2V0KGtleSwgWy4uLihuYW1lcy5nZXQoa2V5KSA/PyBbXSksIGVudHJ5Lml0ZW0uaWRdKTtcclxuICAgIH1cclxuICAgIHJldHVybiBuZXcgU2V0KEFycmF5LmZyb20obmFtZXMudmFsdWVzKCkpLmZpbHRlcigoaWRzKSA9PiBpZHMubGVuZ3RoID4gMSkuZmxhdCgpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hDb250ZXh0KCk6IEJhdGNoV29ya2Zsb3dDb250ZXh0IHwgdW5kZWZpbmVkIHtcclxuICAgIGlmICghYmF0Y2hJdGVtcy5sZW5ndGgpIHJldHVybiB1bmRlZmluZWQ7XHJcbiAgICBsZXQgbm9kZXMgPSAwO1xyXG4gICAgbGV0IHNlbGVjdGVkTm9kZXMgPSAwO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBzZWxlY3RlZEZyYW1lcygpKSB7XHJcbiAgICAgICAgY29uc3QgZWRpdG9yID0gZW50cnkuaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCA/IHN0YXRlIDogZW50cnkuZWRpdG9yO1xyXG4gICAgICAgIGNvbnN0IGFsbCA9IGZsYXR0ZW4oZW50cnkuaXRlbS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBub2RlcyArPSBhbGwubGVuZ3RoO1xyXG4gICAgICAgIHNlbGVjdGVkTm9kZXMgKz0gYWxsLmZpbHRlcigobm9kZSkgPT4gKGVkaXRvcj8uYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24pICE9PSAnaWdub3JlJykubGVuZ3RoO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBjb3VudDogc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGgsIHRvdGFsOiBiYXRjaEl0ZW1zLmxlbmd0aCwgbm9kZXMsIHNlbGVjdGVkTm9kZXMsXHJcbiAgICAgICAgY29uZmxpY3RzOiBiYXRjaENvbmZsaWN0cygpLnNpemUgPiAwLFxyXG4gICAgICAgIC4uLihiYXRjaFJlc3VsdCA/IHsgcmVzdWx0OiB7XHJcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJykubGVuZ3RoLFxyXG4gICAgICAgICAgICBmYWlsZWQ6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHBlbmRpbmc6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdwZW5kaW5nJykubGVuZ3RoLFxyXG4gICAgICAgICAgICBzdG9wcGVkOiBiYXRjaFJlc3VsdC5zdG9wcGVkLFxyXG4gICAgICAgIH0gfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoRm9udHMoKTogc3RyaW5nW10ge1xyXG4gICAgcmV0dXJuIGJhdGNoSXRlbXMubGVuZ3RoID8gQXJyYXkuZnJvbShuZXcgU2V0KHNlbGVjdGVkRnJhbWVzKCkuZmxhdE1hcCgoeyBpdGVtIH0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udHMpKSkgOiBzdGF0ZS5kb2N1bWVudD8uZm9udHMgPz8gW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN5bmNCYXRjaEl0ZW1zKCk6IHZvaWQge1xyXG4gICAgY29uc3QgaXRlbXMgPSBiYXRjaEl0ZW1zLm1hcCgoeyBpdGVtIH0pID0+ICh7IGlkOiBpdGVtLmlkLCBlbmFibGVkOiBpdGVtLmVuYWJsZWQgfSkpO1xyXG4gICAgY29uc3QgcHJlY2VkaW5nUHJldmlldyA9IHByZXZpZXdSZWFkVGFzaztcclxuICAgIGJhdGNoU3luY1Rhc2sgPSBiYXRjaFN5bmNUYXNrLmNhdGNoKCgpID0+IHVuZGVmaW5lZCkudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgcHJlY2VkaW5nUHJldmlldy5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGF3YWl0IHJlcXVlc3QoJ3N5bmMtYmF0Y2gtaXRlbXMnLCBpdGVtcyk7XHJcbiAgICAgICAgYmF0Y2hTeW5jRXJyb3IgPSB1bmRlZmluZWQ7XHJcbiAgICB9KS5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICBiYXRjaFN5bmNFcnJvciA9IGVycm9yO1xyXG4gICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfnlYzpnaLliJfooajkv53lrZjlpLHotKXvvIzor7fph43or5XjgIInKSwgdHJ1ZSk7XHJcbiAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hFbGVtZW50PEsgZXh0ZW5kcyBrZXlvZiBIVE1MRWxlbWVudFRhZ05hbWVNYXA+KHRhZzogSywgdGV4dCA9ICcnLCBjbGFzc05hbWUgPSAnJyk6IEhUTUxFbGVtZW50VGFnTmFtZU1hcFtLXSB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQodGFnKTtcclxuICAgIHZhbHVlLnRleHRDb250ZW50ID0gdGV4dDtcclxuICAgIHZhbHVlLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hCdXR0b24odGV4dDogc3RyaW5nLCBhY3Rpb246ICgpID0+IHZvaWQsIGNsYXNzTmFtZSA9ICd0ZXh0LWJ1dHRvbicpOiBIVE1MQnV0dG9uRWxlbWVudCB7XHJcbiAgICBjb25zdCBidXR0b24gPSBiYXRjaEVsZW1lbnQoJ2J1dHRvbicsIHRleHQsIGNsYXNzTmFtZSk7XHJcbiAgICBidXR0b24udHlwZSA9ICdidXR0b24nO1xyXG4gICAgYnV0dG9uLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGJ1dHRvbi5vbmNsaWNrID0gYWN0aW9uO1xyXG4gICAgcmV0dXJuIGJ1dHRvbjtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyQmF0Y2goKTogdm9pZCB7XHJcbiAgICBjb25zdCBlbmFibGVkID0gYmF0Y2hJdGVtcy5sZW5ndGggPiAwO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXNvdXJjZS1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1mcmFtZS1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC10YXJnZXQtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkIHx8ICghYmF0Y2hSZXN1bHQgJiYgIWJhdGNoUHJvZ3Jlc3MpO1xyXG4gICAgY29uc3QgZ2VuZXJpY1JldmlldyA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnJlc3VsdC1yZXZpZXcnKTtcclxuICAgIGlmIChnZW5lcmljUmV2aWV3KSBnZW5lcmljUmV2aWV3LmhpZGRlbiA9IGVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjcHJlc2V0LXNjb3BlJykudGV4dENvbnRlbnQgPSBlbmFibGVkID8gJ+S7heS9nOeUqOS6juW9k+WJjeeVjOmdoicgOiAn5L2c55So5LqO5YWo6YOo6IqC54K5JztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1zZWxlY3RlZC1jb3VudCcpLnRleHRDb250ZW50ID0gYOW3sumAiSAke3NlbGVjdGVkRnJhbWVzKCkubGVuZ3RofSAvICR7YmF0Y2hJdGVtcy5sZW5ndGh9YDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYmF0Y2gtdG9nZ2xlLWFsbCcpLnRleHRDb250ZW50ID0gc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGggPT09IGJhdGNoSXRlbXMubGVuZ3RoID8gJ+WPlua2iOWFqOmAiScgOiAn5YWo6YCJJztcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjYmF0Y2gtc291cmNlLWxpc3QnKTtcclxuICAgIGNvbnN0IHRhYnMgPSBlbGVtZW50KCcjYmF0Y2gtZnJhbWUtdGFicycpO1xyXG4gICAgY29uc3QgdGFyZ2V0cyA9IGVsZW1lbnQoJyNiYXRjaC10YXJnZXQtbGlzdCcpO1xyXG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTsgdGFicy5yZXBsYWNlQ2hpbGRyZW4oKTsgdGFyZ2V0cy5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGNvbnN0IGNvbmZsaWN0cyA9IGJhdGNoQ29uZmxpY3RzKCk7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGJhdGNoSXRlbXMpIHtcclxuICAgICAgICBjb25zdCB7IGl0ZW0gfSA9IGVudHJ5O1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsIGBiYXRjaC1pdGVtJHtpdGVtLmVuYWJsZWQgPyAnJyA6ICcgaXMtZGlzYWJsZWQnfWApO1xyXG4gICAgICAgIGNvbnN0IGNoZWNrZWQgPSBiYXRjaEVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICAgICAgY2hlY2tlZC50eXBlID0gJ2NoZWNrYm94JzsgY2hlY2tlZC5jaGVja2VkID0gaXRlbS5lbmFibGVkOyBjaGVja2VkLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgICAgICBjaGVja2VkLmRhdGFzZXQuYmF0Y2hDaGVja2VkID0gaXRlbS5pZDtcclxuICAgICAgICBjaGVja2VkLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGDlr7zlhaUgJHtmcmFtZU5hbWUoZW50cnkpfWApO1xyXG4gICAgICAgIGNoZWNrZWQub25jaGFuZ2UgPSAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgICAgIGl0ZW0uZW5hYmxlZCA9IGNoZWNrZWQuY2hlY2tlZDtcclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTtcclxuICAgICAgICAgICAgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkICYmICFpdGVtLmVuYWJsZWQgJiYgc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGgpIHZvaWQgYWN0aXZhdGVGcmFtZShzZWxlY3RlZEZyYW1lcygpWzBdLml0ZW0uaWQpO1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgY29uc3QgY29weSA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWNvcHknKTtcclxuICAgICAgICBjb25zdCB0aXRsZSA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLXRpdGxlJyk7XHJcbiAgICAgICAgdGl0bGUuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsIGZyYW1lTmFtZShlbnRyeSkpLCBiYXRjaEVsZW1lbnQoJ3NwYW4nLCBlbnRyeS5jb25maWd1cmVkID8gJ+W3sumFjee9ricgOiAn5pm66IO96buY6K6kJywgYGJhZGdlJHtlbnRyeS5jb25maWd1cmVkID8gJycgOiAnIHN1YnRsZSd9YCkpO1xyXG4gICAgICAgIGlmIChjb25mbGljdHMuaGFzKGl0ZW0uaWQpKSB0aXRsZS5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzcGFuJywgJ+WQjeensOWGsueqgScsICdiYXRjaC1zdGF0dXMtZmFpbGVkJykpO1xyXG4gICAgICAgIGNvcHkuYXBwZW5kKHRpdGxlLCBiYXRjaEVsZW1lbnQoJ2RpdicsIGAke2l0ZW0uc2VjdGlvbk5hbWUgPyBgJHtpdGVtLnNlY3Rpb25OYW1lfSAvIGAgOiAnJ30ke2l0ZW0uZG9jdW1lbnQuZmlsZU5hbWV9IMK3ICR7ZmxhdHRlbihpdGVtLmRvY3VtZW50LnRyZWUpLmxlbmd0aH0g6IqC54K5YCwgJ2JhdGNoLWl0ZW0tbWV0YScpKTtcclxuICAgICAgICBjb25zdCBhY3Rpb25zID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tYWN0aW9ucycpO1xyXG4gICAgICAgIGNvbnN0IGNvbmZpZ3VyZSA9IGJhdGNoQnV0dG9uKCfosIPmlbToioLngrknLCAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmICghaXRlbS5lbmFibGVkKSB7IGl0ZW0uZW5hYmxlZCA9IHRydWU7IHN5bmNCYXRjaEl0ZW1zKCk7IH1cclxuICAgICAgICAgICAgdm9pZCBhY3RpdmF0ZUZyYW1lKGl0ZW0uaWQsIHRydWUpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbmZpZ3VyZS5kYXRhc2V0LmJhdGNoQ29uZmlndXJlID0gaXRlbS5pZDtcclxuICAgICAgICBjb25zdCByZW1vdmUgPSBiYXRjaEJ1dHRvbignw5cnLCAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgICAgICAgICAgYmF0Y2hJdGVtcyA9IGJhdGNoSXRlbXMuZmlsdGVyKChjYW5kaWRhdGUpID0+IGNhbmRpZGF0ZS5pdGVtLmlkICE9PSBpdGVtLmlkKTtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGl0ZW0uaWQpIHtcclxuICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGgpIHZvaWQgYWN0aXZhdGVGcmFtZShzZWxlY3RlZEZyYW1lcygpWzBdLml0ZW0uaWQpO1xyXG4gICAgICAgICAgICAgICAgZWxzZSBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHZvaWQgYWN0aXZhdGVGcmFtZShiYXRjaEl0ZW1zWzBdLml0ZW0uaWQpO1xyXG4gICAgICAgICAgICAgICAgZWxzZSB7IHN0YXRlLmRvY3VtZW50ID0gbnVsbDsgcmVuZGVyVHJlZSgpOyB3b3JrZmxvdz8uYmF0Y2hSZWFkeSgpOyB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTsgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICAgICAgfSwgJ2ljb24tYnV0dG9uJyk7XHJcbiAgICAgICAgcmVtb3ZlLmRhdGFzZXQuYmF0Y2hSZW1vdmUgPSBpdGVtLmlkOyByZW1vdmUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYOenu+mZpCAke2ZyYW1lTmFtZShlbnRyeSl9YCk7XHJcbiAgICAgICAgYWN0aW9ucy5hcHBlbmQoY29uZmlndXJlLCByZW1vdmUpOyByb3cuYXBwZW5kKGNoZWNrZWQsIGNvcHksIGFjdGlvbnMpOyBsaXN0LmFwcGVuZChyb3cpO1xyXG4gICAgICAgIGlmICghaXRlbS5lbmFibGVkKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCB0YWIgPSBiYXRjaEJ1dHRvbignJywgKCkgPT4geyB2b2lkIGFjdGl2YXRlRnJhbWUoaXRlbS5pZCk7IH0sICdiYXRjaC1mcmFtZS10YWInKTtcclxuICAgICAgICB0YWIuZGF0YXNldC5iYXRjaEZyYW1lID0gaXRlbS5pZDsgdGFiLnNldEF0dHJpYnV0ZSgncm9sZScsICd0YWInKTsgdGFiLnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsIFN0cmluZyhhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkKSk7XHJcbiAgICAgICAgdGFiLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3N0cm9uZycsIGZyYW1lTmFtZShlbnRyeSkpLCBiYXRjaEVsZW1lbnQoJ3NtYWxsJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4gwrcg6Ieq5Yqo5L+d55WZJyA6ICfmmbrog73pu5jorqQnKSk7XHJcbiAgICAgICAgdGFicy5hcHBlbmQodGFiKTtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBiYXRjaEVsZW1lbnQoJ2xhYmVsJywgJycsIGBiYXRjaC10YXJnZXQtcm93JHtjb25mbGljdHMuaGFzKGl0ZW0uaWQpID8gJyBpcy1jb25mbGljdCcgOiAnJ31gKTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsIGl0ZW0ubmFtZSkpO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBiYXRjaEVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICAgICAgbmFtZS50eXBlID0gJ3RleHQnOyBuYW1lLnZhbHVlID0gZnJhbWVOYW1lKGVudHJ5KTsgbmFtZS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7IG5hbWUuZGF0YXNldC5iYXRjaE5hbWUgPSBpdGVtLmlkO1xyXG4gICAgICAgIG5hbWUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7aXRlbS5uYW1lfSDnmoQgUHJlZmFiIOWQjeensGApO1xyXG4gICAgICAgIG5hbWUudGl0bGUgPSBgYXNzZXRzLyR7ZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZX0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUoZW50cnkpKX0ucHJlZmFiYDtcclxuICAgICAgICBuYW1lLm9uY2hhbmdlID0gKCkgPT4geyB2b2lkIHJlbmFtZUZyYW1lKGVudHJ5LCBuYW1lLnZhbHVlKTsgfTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKG5hbWUpOyB0YXJnZXRzLmFwcGVuZCh0YXJnZXQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtYWN0aXZlLW5hbWUnKS50ZXh0Q29udGVudCA9IGFjdGl2ZSA/IGDmraPlnKjosIPmlbTvvJoke2ZyYW1lTmFtZShhY3RpdmUpfWAgOiAn6YCJ5oup5LiA5Liq55WM6Z2i5byA5aeL6LCD5pW0JztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1hY3RpdmUtc3RhdHVzJykudGV4dENvbnRlbnQgPSBhY3RpdmU/LmNvbmZpZ3VyZWQgPyAn5L+u5pS55bey5L+d55WZJyA6ICfmsr/nlKjmmbrog73pu5jorqQnO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWNvbmZsaWN0cycpLmhpZGRlbiA9IGNvbmZsaWN0cy5zaXplID09PSAwO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWNvbmZsaWN0cycpLnRleHRDb250ZW50ID0gYOaciSAke2NvbmZsaWN0cy5zaXplfSDkuKrnlYzpnaLnmoQgUHJlZmFiIOaWh+S7tuWQjemHjeWkje+8iOW/veeVpeWkp+Wwj+WGme+8ieOAguivt+aUueWQjeWQjuW8gOWni+WvvOWFpeOAgmA7XHJcbiAgICByZW5kZXJCYXRjaFJlc3VsdHMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyQmF0Y2hSZXN1bHRzKCk6IHZvaWQge1xyXG4gICAgY29uc3Qgcm93cyA9IGJhdGNoUHJvZ3Jlc3M/Lml0ZW1zID8/IGJhdGNoUmVzdWx0Py5pdGVtcyA/PyBbXTtcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LWxpc3QnKTsgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiByb3dzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0nKTtcclxuICAgICAgICBjb25zdCBjb3B5ID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tY29weScpO1xyXG4gICAgICAgIGNvcHkuYXBwZW5kKGJhdGNoRWxlbWVudCgnZGl2JywgaXRlbS5uYW1lLCAnYmF0Y2gtaXRlbS10aXRsZScpLCBiYXRjaEVsZW1lbnQoJ2RpdicsIGl0ZW0uZXJyb3IgPz8gaXRlbS5wcmVmYWJVcmwgPz8gaXRlbS53YXJuaW5ncz8uam9pbign77ybJykgPz8gKGl0ZW0uc3RhdHVzID09PSAncGVuZGluZycgPyAn562J5b6F57un57ut5a+85YWlJyA6ICcnKSwgJ2JhdGNoLWl0ZW0tbWV0YScpKTtcclxuICAgICAgICBjb25zdCBzdGF0dXMgPSB7IHBlbmRpbmc6ICfmnKrlrozmiJAnLCBydW5uaW5nOiAn5q2j5Zyo5a+85YWlJywgc3VjY2VzczogJ+W3suWujOaIkCcsIGZhaWxlZDogJ+Wksei0pScgfVtpdGVtLnN0YXR1c107XHJcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWFjdGlvbnMnKTtcclxuICAgICAgICBhY3Rpb25zLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBzdGF0dXMsIGBiYXRjaC1zdGF0dXMtJHtpdGVtLnN0YXR1c31gKSk7XHJcbiAgICAgICAgaWYgKGl0ZW0ucmV2aWV3SWQgfHwgaXRlbS5yZXZpZXcpIHtcclxuICAgICAgICAgICAgY29uc3QgcmV2aWV3ID0gYmF0Y2hCdXR0b24oJ+ajgOafpee7k+aenCcsICgpID0+IHsgdm9pZCBvcGVuQmF0Y2hSZXZpZXcoaXRlbSk7IH0pO1xyXG4gICAgICAgICAgICByZXZpZXcuZGF0YXNldC5iYXRjaFJldmlldyA9IGl0ZW0uaWQ7IGFjdGlvbnMuYXBwZW5kKHJldmlldyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJvdy5hcHBlbmQoY29weSwgYWN0aW9ucyk7IGxpc3QuYXBwZW5kKHJvdyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdWNjZXNzID0gcm93cy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aDtcclxuICAgIGNvbnN0IGZhaWxlZCA9IHJvd3MuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aDtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSByb3dzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdwZW5kaW5nJykubGVuZ3RoO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1jb3VudCcpLnRleHRDb250ZW50ID0gYCR7c3VjY2Vzc30gLyAke3Jvd3MubGVuZ3RofSDlt7LlrozmiJBgO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNiYXRjaC1yZXRyeS1mYWlsZWQnKS5oaWRkZW4gPSAhZmFpbGVkIHx8IHN0YXRlLmJ1c3k7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXJlc3VtZS1wZW5kaW5nJykuaGlkZGVuID0gIXBlbmRpbmcgfHwgc3RhdGUuYnVzeTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtbm90ZScpLnRleHRDb250ZW50ID0gcm93cy5zb21lKChpdGVtKSA9PiBpdGVtLnJlcXVpcmVzQXR0ZW50aW9uKVxyXG4gICAgICAgID8gJ+mDqOWIhumhueeahOS/neWtmOeKtuaAgemcgOimgeajgOafpeOAguivt+WFiOWcqCBDb2NvcyDnoa7orqTlvZPliY3nm67moIfkuI7kv53lrZjnirbmgIHvvIzlho3ph43or5XmiJbnu6fnu63jgIInXHJcbiAgICAgICAgOiAn54K55Ye75q+P5LiA6aG555qE4oCc5qOA5p+l57uT5p6c4oCd5p+l55yL5a+55bqU5oql5ZGK77yb6YeN6K+V5ZKM57un57ut5Lya6Lez6L+H5bey5a6M5oiQ6aG544CCJztcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkJhdGNoUmV2aWV3KGl0ZW06IEJhdGNoSW1wb3J0SXRlbVJlc3VsdCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3SWQgPSBpdGVtLnJldmlld0lkID8/IGl0ZW0ucmV2aWV3Py5pZDtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSByZXZpZXdJZCA/IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3JywgcmV2aWV3SWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIXJldmlldykgdGhyb3cgbmV3IEVycm9yKCfor6Xpobnmo4Dmn6XmiqXlkYrlt7Lov4fmnJ/vvIzor7fph43mlrDlr7zlhaXlkI7mn6XnnIvjgIInKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluajgOafpee7k+aenOWksei0peOAgicpLCB0cnVlKTsgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhY3RpdmF0ZUZyYW1lKGlkOiBzdHJpbmcsIG5hdmlnYXRlID0gZmFsc2UpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBjb25zdCBlbnRyeSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGlkKTtcclxuICAgIGlmICghZW50cnkpIHJldHVybjtcclxuICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpZCAmJiBzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIGlmIChuYXZpZ2F0ZSkgd29ya2Zsb3c/Lm5hdmlnYXRlKDIpO1xyXG4gICAgICAgIHJlbmRlckJhdGNoKCk7IHdvcmtmbG93Py5yZW5kZXIoKTtcclxuICAgICAgICBpZiAobmF2aWdhdGUgJiYgc3RhdGUuc2VsZWN0ZWRJZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGZpbmROb2RlKHN0YXRlLnNlbGVjdGVkSWQpOyBpZiAoc2VsZWN0ZWQpIHZvaWQgcHJldmlldyhzZWxlY3RlZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgIGNvbnN0IG9sZElkID0gYWN0aXZlQmF0Y2hJZDtcclxuICAgIGNvbnN0IG9sZEVkaXRvciA9IGVkaXRvclNuYXBzaG90KCk7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7IGlmIChzZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHByZXZpZXdSZXZpc2lvbisrO1xyXG4gICAgc2V0QnVzeSh0cnVlKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYmF0Y2hTeW5jVGFzaztcclxuICAgICAgICBhd2FpdCBwcmV2aWV3UmVhZFRhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBpZiAoYmF0Y2hTeW5jRXJyb3IpIHRocm93IGJhdGNoU3luY0Vycm9yO1xyXG4gICAgICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IHJlcXVlc3Q8RG9jdW1lbnREdG8+KCdhY3RpdmF0ZS1iYXRjaC1pdGVtJywgaWQpO1xyXG4gICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBpZDtcclxuICAgICAgICBpZiAoZW50cnkuZWRpdG9yKSBPYmplY3QuYXNzaWduKHN0YXRlLCBlbnRyeS5lZGl0b3IpO1xyXG4gICAgICAgIGVsc2UgaW5pdGlhbGl6ZURvY3VtZW50KGxvYWRlZCA/PyBlbnRyeS5pdGVtLmRvY3VtZW50LCBmYWxzZSk7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykudmFsdWUgPSBzdGF0ZS5zZWFyY2g7XHJcbiAgICAgICAgZWxlbWVudCgnI2ZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnQ/LmZpbGVOYW1lID8/ICcnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNwcmV2aWV3LXN0YWdlJykuY2xhc3NMaXN0LnJlbW92ZSgnaGFzLWltYWdlJywgJ2lzLWxvYWRpbmcnKTtcclxuICAgICAgICBlbGVtZW50KCcjcHJldmlldy1pbWFnZScpLnJlbW92ZUF0dHJpYnV0ZSgnc3JjJyk7XHJcbiAgICAgICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gJ+mAieaLqeiKgueCueafpeeci+mihOiniCc7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgIGVsZW1lbnQoJyN0cmVlJykuc2Nyb2xsVG9wID0gZW50cnkuZWRpdG9yPy50cmVlU2Nyb2xsID8/IDA7XHJcbiAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAoZW50cnkuZWRpdG9yPy5wcmVzZXQgPz8gJ3NtYXJ0JykpKTtcclxuICAgICAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBvbGRJZDsgT2JqZWN0LmFzc2lnbihzdGF0ZSwgb2xkRWRpdG9yKTtcclxuICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn5YiH5o2i55WM6Z2i5aSx6LSl77yM6K+36YeN6K+V44CCJyksIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTsgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgIGlmIChuYXZpZ2F0ZSAmJiBhY3RpdmVCYXRjaElkID09PSBpZCkgd29ya2Zsb3c/Lm5hdmlnYXRlKDIpO1xyXG4gICAgICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpZCAmJiB3b3JrZmxvdz8uc3RlcCA9PT0gMiAmJiBzdGF0ZS5zZWxlY3RlZElkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZmluZE5vZGUoc3RhdGUuc2VsZWN0ZWRJZCk7IGlmIChzZWxlY3RlZCkgdm9pZCBwcmV2aWV3KHNlbGVjdGVkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbmFtZUZyYW1lKGVudHJ5OiBGcmFtZUVkaXRvckl0ZW0sIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZSh2YWx1ZSk7XHJcbiAgICBpZiAoIW5hbWUpIHsgc2hvd1RvYXN0KCdQcmVmYWIg5ZCN56ew5LiN6IO95Li656m644CCJywgdHJ1ZSk7IHJlbmRlckJhdGNoKCk7IHJldHVybjsgfVxyXG4gICAgYXdhaXQgYWN0aXZhdGVGcmFtZShlbnRyeS5pdGVtLmlkKTtcclxuICAgIGlmIChhY3RpdmVCYXRjaElkICE9PSBlbnRyeS5pdGVtLmlkKSByZXR1cm47XHJcbiAgICBzdGF0ZS5uYW1lcy5zZXQoZW50cnkuaXRlbS5yb290SWQsIG5hbWUpO1xyXG4gICAgaWYgKG5hbWUgPT09IGVudHJ5Lml0ZW0ubmFtZSkgc3RhdGUucmVuYW1lZElkcy5kZWxldGUoZW50cnkuaXRlbS5yb290SWQpOyBlbHNlIHN0YXRlLnJlbmFtZWRJZHMuYWRkKGVudHJ5Lml0ZW0ucm9vdElkKTtcclxuICAgIGVudHJ5LmNvbmZpZ3VyZWQgPSB0cnVlO1xyXG4gICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTsgcmVtZW1iZXJBY3RpdmVGcmFtZSgpOyByZW5kZXJUcmVlKCk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcm9vdCgpOiBIVE1MRWxlbWVudCB7XHJcbiAgICByZXR1cm4gcGFuZWxIb3N0LiQuYXBwIGFzIEhUTUxFbGVtZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbGVtZW50PFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oc2VsZWN0b3I6IHN0cmluZyk6IFQge1xyXG4gICAgY29uc3QgdmFsdWUgPSByb290KCkucXVlcnlTZWxlY3RvcjxUPihzZWxlY3Rvcik7XHJcbiAgICBpZiAoIXZhbHVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQYW5lbCBlbGVtZW50IG5vdCBmb3VuZDogJHtzZWxlY3Rvcn1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVxdWVzdDxUPihtZXNzYWdlOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8VD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QocGFja2FnZUpTT04ubmFtZSwgbWVzc2FnZSwgLi4uYXJncykgYXMgVDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2hvd1RvYXN0KG1lc3NhZ2U6IHN0cmluZywgZXJyb3IgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdG9hc3QgPSBlbGVtZW50PEhUTUxEaXZFbGVtZW50PignI3RvYXN0Jyk7XHJcbiAgICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcclxuICAgIGNvbnN0IGNyZWRlbnRpYWxEaWFsb2cgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRGlhbG9nRWxlbWVudD4oJyNjcmVkZW50aWFsLWRpYWxvZycpO1xyXG4gICAgY29uc3QgY3JlZGVudGlhbFN0YXR1cyA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignI2NyZWRlbnRpYWwtc3RhdHVzJyk7XHJcbiAgICBpZiAoY3JlZGVudGlhbERpYWxvZz8ub3BlbiAmJiBjcmVkZW50aWFsU3RhdHVzKSB7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy5oaWRkZW4gPSBmYWxzZTtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgZXJyb3IpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRvYXN0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7XHJcbiAgICB9XHJcbiAgICB0b2FzdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0b2FzdC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JyksIDM0MDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24sIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyb3IubWVzc2FnZSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvci5tZXNzYWdlO1xyXG4gICAgfVxyXG4gICAgaWYgKHR5cGVvZiBlcnJvciA9PT0gJ3N0cmluZycgJiYgZXJyb3IudHJpbSgpKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yO1xyXG4gICAgfVxyXG4gICAgaWYgKGVycm9yICYmIHR5cGVvZiBlcnJvciA9PT0gJ29iamVjdCcgJiYgJ21lc3NhZ2UnIGluIGVycm9yXHJcbiAgICAgICAgJiYgdHlwZW9mIChlcnJvciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH0pLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgcmV0dXJuIChlcnJvciBhcyB7IG1lc3NhZ2U6IHN0cmluZyB9KS5tZXNzYWdlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbGxiYWNrO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRDb25uZWN0aW9uKHZhdWx0OiB7XHJcbiAgICBoYXNUb2tlbjogYm9vbGVhbjtcclxuICAgIHBlcnNpc3RlbnQ6IGJvb2xlYW47XHJcbiAgICBiYWNrZW5kOiBzdHJpbmc7XHJcbiAgICB3YXJuaW5nPzogc3RyaW5nO1xyXG59KTogdm9pZCB7XHJcbiAgICBjb25zdCBwaWxsID0gZWxlbWVudCgnI2Nvbm5lY3Rpb24tcGlsbCcpO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vbmxpbmUnLCB2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9mZmxpbmUnLCAhdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgZWxlbWVudCgnI2Nvbm5lY3Rpb24tbGFiZWwnKS50ZXh0Q29udGVudCA9IHZhdWx0Lmhhc1Rva2VuID8gJ+WHreaNruWwsee7qicgOiAn5pyq6L+e5o6lJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1iYWRnZScpLnRleHRDb250ZW50ID0gdmF1bHQucGVyc2lzdGVudCA/ICfns7vnu5/liqDlr4YnIDogJ+S8muivneWtmOWCqCc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtbm90ZScpLnRleHRDb250ZW50ID0gdmF1bHQud2FybmluZ1xyXG4gICAgICAgID8/ICh2YXVsdC5wZXJzaXN0ZW50ID8gYOeUsSAke3ZhdWx0LmJhY2tlbmR9IOWKoOWvhu+8jOmhueebruS4reS7heS/neWtmOmdnuaVj+aEn+iuvue9rmAgOiAnVG9rZW4g5LiN5YaZ5YWl6aG555uu5paH5Lu2Jyk7XHJcbiAgICAoZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyN2ZXJpZnktdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbiAgICAoZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjbGVhci10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIHdvcmtmbG93Py5zZXRDb25uZWN0aW9uKHZhdWx0Lmhhc1Rva2VuKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbihub2RlczogVHJlZU5vZGVEdG9bXSk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIG5vZGVzLmZsYXRNYXAoKG5vZGUpID0+IFtub2RlLCAuLi5mbGF0dGVuKG5vZGUuY2hpbGRyZW4pXSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmROb2RlKGlkOiBzdHJpbmcsIG5vZGVzID0gc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10pOiBUcmVlTm9kZUR0byB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICBpZiAobm9kZS5pZCA9PT0gaWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5vZGU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gZmluZE5vZGUoaWQsIG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIGlmIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyRm9udE1hcCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjZm9udC1tYXAtbGlzdCcpO1xyXG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGNvbnN0IGZhbWlsaWVzID0gYmF0Y2hGb250cygpO1xyXG4gICAgaWYgKCFmYW1pbGllcy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOWQju+8jOi/memHjOS8muWIl+WHuuajgOa1i+WIsOeahOWtl+S9k+OAgic7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5mb250QXNzZXRzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5IGlzLXdhcm5pbmcnO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+mhueebriBhc3NldHMg5YaF5rKh5pyJ5qOA5rWL5YiwIC50dGYgLyAub3RmIC8gLmZudCAvIC53b2ZmIOWtl+S9k+i1hOa6kOOAgic7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGZhbWlseSBvZiBmYW1pbGllcykge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtcm93JztcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgc291cmNlLmNsYXNzTmFtZSA9ICdmb250LW1hcC1zb3VyY2UnO1xyXG4gICAgICAgIHNvdXJjZS50ZXh0Q29udGVudCA9IGZhbWlseTtcclxuICAgICAgICBzb3VyY2UudGl0bGUgPSBmYW1pbHk7XHJcbiAgICAgICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgYXJyb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWFycm93JztcclxuICAgICAgICBhcnJvdy50ZXh0Q29udGVudCA9ICfihpInO1xyXG4gICAgICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xyXG4gICAgICAgIHNlbGVjdC5jbGFzc05hbWUgPSAnZm9udC1tYXAtc2VsZWN0JztcclxuICAgICAgICBzZWxlY3QuZGF0YXNldC5mb250RmFtaWx5ID0gZmFtaWx5O1xyXG4gICAgICAgIHNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtmYW1pbHl9IOaYoOWwhOWtl+S9k2ApO1xyXG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24oJycsICfkuI3mmKDlsITvvIjkvb/nlKjpu5jorqTlrZfkvZPvvIknKSk7XHJcbiAgICAgICAgY29uc3QgYXV0b21hdGljID0gZmluZEZvbnRBc3NldChmYW1pbHksIHN0YXRlLmZvbnRBc3NldHMpO1xyXG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gc3RhdGUuc2V0dGluZ3MuZm9udE1hcFtmYW1pbHldID8/IGF1dG9tYXRpYz8udXJsID8/ICcnO1xyXG4gICAgICAgIGZvciAoY29uc3QgYXNzZXQgb2Ygc3RhdGUuZm9udEFzc2V0cykge1xyXG4gICAgICAgICAgICBjb25zdCBpdGVtID0gb3B0aW9uKGFzc2V0LnVybCwgYCR7YXNzZXQubmFtZX0gwrcgJHthc3NldC5yZWxhdGl2ZVBhdGh9YCk7XHJcbiAgICAgICAgICAgIGl0ZW0uc2VsZWN0ZWQgPSBhc3NldC51cmwgPT09IHNlbGVjdGVkO1xyXG4gICAgICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQoaXRlbSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlbGVjdC52YWx1ZSA9IHNlbGVjdGVkO1xyXG4gICAgICAgIHJvdy5hcHBlbmQoc291cmNlLCBhcnJvdywgc2VsZWN0KTtcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKHJvdyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhZmVBY3Rpb24oX25vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IHVua25vd24pOiBJbXBvcnRBY3Rpb24ge1xyXG4gICAgcmV0dXJuIG5vcm1hbGl6ZUltcG9ydEFjdGlvbihhY3Rpb24pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbml0aWFsaXplRG9jdW1lbnQoZG9jdW1lbnQ6IERvY3VtZW50RHRvLCBuYXZpZ2F0ZSA9IHRydWUpOiB2b2lkIHtcclxuICAgIHN0YXRlLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5raW5kcy5jbGVhcigpO1xyXG4gICAgc3RhdGUucGF0Y2hlcy5jbGVhcigpO1xyXG4gICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLm5hbWVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5yZW5hbWVkSWRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5kZWZhdWx0cy5jbGVhcigpO1xyXG4gICAgc3RhdGUuY29sbGFwc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gZG9jdW1lbnQudHJlZVswXT8uaWQ7XHJcbiAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7XHJcbiAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgc3RhdGUuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7XHJcbiAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKTtcclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAoY3VzdG9tTmFtZSAmJiBjdXN0b21OYW1lICE9PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0ID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG92ZXJyaWRlLm5pbmVTbGljZSAmJiBub2RlLnBhdGNoQ2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZShcclxuICAgICAgICAgICAgJ2FjdGl2ZScsXHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLnNpemUgPT09IDAgJiYgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAnc21hcnQnLFxyXG4gICAgICAgICk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmaWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IGRvY3VtZW50LnNvdXJjZVVybDtcclxuICAgIGVsZW1lbnQoJyNmb250LWhpbnQnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZvbnRzLmxlbmd0aFxyXG4gICAgICAgID8gYOajgOa1i+WIsO+8miR7ZG9jdW1lbnQuZm9udHMuam9pbign44CBJyl9YFxyXG4gICAgICAgIDogJ+W9k+WJjeaWh+S7tuWwmuacquWPkeeOsOWtl+S9k+OAgic7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICByZW5kZXJUcmVlKHRydWUpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgaWYgKG5hdmlnYXRlKSB3b3JrZmxvdz8uZG9jdW1lbnRSZWFkeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IHZvaWQge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIHVwZGF0ZVRhcmdldEhpbnQoKTtcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIHdvcmtmbG93Py5yZW5kZXIoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVhZFNldHRpbmdzKHNob3dFcnJvciA9IHRydWUpOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwge1xyXG4gICAgY29uc3QgZm9udE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uc3RhdGUuc2V0dGluZ3MuZm9udE1hcCB9O1xyXG4gICAgZm9yIChjb25zdCBmYW1pbHkgb2YgYmF0Y2hGb250cygpKSBkZWxldGUgZm9udE1hcFtmYW1pbHldO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdbZGF0YS1mb250LWZhbWlseV0nKS5mb3JFYWNoKChzZWxlY3QpID0+IHtcclxuICAgICAgICBjb25zdCBmYW1pbHkgPSBzZWxlY3QuZGF0YXNldC5mb250RmFtaWx5Py50cmltKCk7XHJcbiAgICAgICAgaWYgKGZhbWlseSAmJiBzZWxlY3QudmFsdWUpIHtcclxuICAgICAgICAgICAgZm9udE1hcFtmYW1pbHldID0gc2VsZWN0LnZhbHVlO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2NhbGUgPSBOdW1iZXIoZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUpO1xyXG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2NhbGUpIHx8IHNjYWxlIDwgMC4yNSB8fCBzY2FsZSA+IDQpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn5a+85YWl5YCN546H5b+F6aG75ZyoIDAuMjUg5YiwIDQg5LmL6Ze044CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYXNzZXRGb2xkZXIgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFhc3NldEZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npobnnm64gYXNzZXRzIOS4i+eahOi1hOa6kOi+k+WHuuebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHByZWZhYkZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFwcmVmYWJGb2xkZXIpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogQXJyYXkuZnJvbSh7IGxlbmd0aDogMyB9LCAoXywgaW5kZXgpID0+XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgKSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLTAnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN1cGRhdGUtZXhpc3RpbmcnKS5jaGVja2VkLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQsXHJcbiAgICAgICAgYXV0b1NhdmU6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhdXRvLXNhdmUnKS5jaGVja2VkLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRCdXN5KHZhbHVlOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICB2YWx1ZSA9IHZhbHVlIHx8IEJvb2xlYW4od29ya2Zsb3c/LnBlbmRpbmcpO1xyXG4gICAgc3RhdGUuYnVzeSA9IHZhbHVlO1xyXG4gICAgLy8gQ2FwdHVyZSBlZGl0YWJsZSBjb250cm9sIHN0YXRlcyBiZWZvcmUgdGhlIGV4aXN0aW5nIGJ1dHRvbiBsb2NrIGNoYW5nZXMgdGhlbS5cclxuICAgIHdvcmtmbG93Py5yZW5kZXIoKTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNzYXZlLXRva2VuJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1hc3NldC1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLXByZWZhYi1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtZGV0ZWN0JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXByZXZpZXcnKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaGlkZGVuJywgIXZhbHVlKTtcclxuICAgIHdvcmtmbG93Py5yZW5kZXIoKTtcclxuICAgIGlmICghdmFsdWUpIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gdW5kZWZpbmVkO1xyXG4gICAgcm91bmR0cmlwUGFpclRva2VuID0gdW5kZWZpbmVkO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gdHJ1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiByb3VuZHRyaXBTb3VyY2UoKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghc291cmNlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEg5paH5Lu25oiW6IqC54K56ZO+5o6l44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJSb3VuZHRyaXBQcmV2aWV3KHByZXZpZXc6IFJvdW5kdHJpcFByZXZpZXdEdG8pOiB2b2lkIHtcclxuICAgIHJvdW5kdHJpcFByZXZpZXdUb2tlbiA9IHByZXZpZXcucHJldmlld1Rva2VuO1xyXG4gICAgcm91bmR0cmlwUGFpclRva2VuID0gcHJldmlldy5wYWlyVG9rZW47XHJcbiAgICBjb25zdCBsaW5lcyA9IFtcclxuICAgICAgICBg55uu5qCH77yaJHtwcmV2aWV3LmFzc2V0VXJsfWAsXHJcbiAgICAgICAgYFByZWZhYu+8miR7cHJldmlldy5wcmVmYWJVdWlkfWAsXHJcbiAgICAgICAgYFN1cmZhY2XvvJoke3ByZXZpZXcuc3VyZmFjZUlkfSDCtyBGaWdtYSAke3ByZXZpZXcuZmlnbWFWZXJzaW9ufSDCtyBMZWRnZXIgJHtwcmV2aWV3LmxlZGdlckdlbmVyYXRpb259YCxcclxuICAgICAgICBg5bCG5L+u5pS5ICR7cHJldmlldy5wbGFuLmFwcGx5Lmxlbmd0aH0g6aG5IMK3IOS/neeVmSBDb2NvcyAke3ByZXZpZXcucGxhbi5wcmVzZXJ2ZUNvY29zLmxlbmd0aH0g6aG5IMK3IOW3suaUtuaVmyAke3ByZXZpZXcucGxhbi5jb252ZXJnZWQubGVuZ3RofSDpoblgLFxyXG4gICAgICAgIGDlhrLnqoEgJHtwcmV2aWV3LnBsYW4uY29uZmxpY3RzLmxlbmd0aH0g6aG5IMK3IOS4jeaUr+aMgSAke3ByZXZpZXcucGxhbi51bnN1cHBvcnRlZC5sZW5ndGh9IOmhuSDCtyDlj6ror7vmnKrmlLkgJHtwcmV2aWV3LnBsYW4ucmVhZG9ubHlVbmNoYW5nZWQubGVuZ3RofSDpoblgLFxyXG4gICAgICAgIHByZXZpZXcucGFpclJlcXVpcmVkXHJcbiAgICAgICAgICAgID8gcHJldmlldy5wYWlyRWxpZ2libGUgPyAn6aaW5qyh5L2/55So77ya6K+B5o2u5LiA6Ie077yM6K+35YWI56Gu6K6k6YWN5a+5IFN1cmZhY2XvvIjlj6rlhpkgbGVkZ2Vy77yM5LiN5pS5IFByZWZhYu+8ieOAgicgOiAn6aaW5qyh5L2/55So77yaUGFpciDor4Hmja7kuI3kuIDoh7TvvIzpnIDku47lvZPliY0gUHJlZmFiIOmHjeaWsOWvvOWHuuOAgidcclxuICAgICAgICAgICAgOiBwcmV2aWV3LmJsb2NrZXJzLmxlbmd0aCA/IGDpmLvmlq3vvJoke3ByZXZpZXcuYmxvY2tlcnMuam9pbignLCAnKX1gIDogJ+mihOiniOmAmui/h++8jOWPr+WOn+WtkOW6lOeUqOaVtOS4quS4jeWPr+WPmOiuoeWIkuOAgicsXHJcbiAgICBdO1xyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBsaW5lcy5qb2luKCdcXG4nKTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlVGFyZ2V0SGludCgpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICfkuLvov5vnqIvkuI7pnaLmnb/niYjmnKzkuI3kuIDoh7TvvIzpnIDopoHlrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcic7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2FjdGlvbi1ub3RlJykudGV4dENvbnRlbnQgPSAn5a+85YWl5Yiw5b2T5YmN5Zy65pmvIENhbnZhcyDmoLnoioLngrnkuIvvvJtGcmFtZSDpk77mjqXlsIboh6rliqjliJvlu7rlubbmiZPlvIDpooTliLbkvZMnO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNldEltcG9ydEJ1dHRvbigpOiB2b2lkIHtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycsICdpcy1lcnJvcicpO1xyXG4gICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICBidXR0b24udGl0bGUgPSAn5a+85YWl5Yiw5b2T5YmN5omT5byA5Zy65pmv5oiW6aKE5Yi25L2TJztcclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5byA5aeL5a+85YWlJztcclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihpInO1xyXG4gICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzAlJztcclxufVxyXG5cclxuZnVuY3Rpb24gaW1wb3J0UHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiBudW1iZXIge1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJykge1xyXG4gICAgICAgIHJldHVybiAwLjA1ICsgdmFsdWUgKiAwLjU1O1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnc2NlbmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuNiArIHZhbHVlICogMC4zODtcclxuICAgIH1cclxuICAgIHJldHVybiBldmVudC5waGFzZSA9PT0gJ2RvbmUnID8gMSA6IDA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBpZiAoZXZlbnQuYmF0Y2ggJiYgYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICBiYXRjaFByb2dyZXNzID0gZXZlbnQuYmF0Y2g7XHJcbiAgICAgICAgY29uc3QgY3VycmVudFJvdyA9IGV2ZW50LmJhdGNoLml0ZW1zLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IGV2ZW50LmJhdGNoIS5pdGVtSWQpO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnQgPSBjdXJyZW50Um93Py5zdGF0dXMgPT09ICdydW5uaW5nJyA/IGltcG9ydFByb2dyZXNzKGV2ZW50KSA6IDA7XHJcbiAgICAgICAgZXZlbnQgPSB7XHJcbiAgICAgICAgICAgIC4uLmV2ZW50LFxyXG4gICAgICAgICAgICB2YWx1ZTogTWF0aC5taW4oMSwgKGV2ZW50LmJhdGNoLmNvbXBsZXRlZCArIGN1cnJlbnQpIC8gTWF0aC5tYXgoMSwgZXZlbnQuYmF0Y2gudG90YWwpKSxcclxuICAgICAgICAgICAgbWVzc2FnZTogYCR7ZXZlbnQuYmF0Y2guaW5kZXh9IC8gJHtldmVudC5iYXRjaC50b3RhbH0gwrcgJHtldmVudC5iYXRjaC5uYW1lfSDCtyAke2V2ZW50Lm1lc3NhZ2V9YCxcclxuICAgICAgICB9O1xyXG4gICAgICAgIHJlbmRlckJhdGNoUmVzdWx0cygpO1xyXG4gICAgfVxyXG4gICAgaWYgKFsnZmV0Y2gnLCAnYXNzZXRzJywgJ3NjZW5lJ10uaW5jbHVkZXMoZXZlbnQucGhhc2UpKSBzZXRCdXN5KHRydWUpO1xyXG4gICAgd29ya2Zsb3c/LnByb2dyZXNzKGV2ZW50KTtcclxuICAgIGNvbnN0IHJlZ2lvbiA9IGVsZW1lbnQoJyNwcm9ncmVzcy1yZWdpb24nKTtcclxuICAgIGNvbnN0IGJ1c3kgPSBbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKTtcclxuICAgIHJlZ2lvbi5jbGFzc0xpc3QudG9nZ2xlKCdpcy1idXN5JywgYnVzeSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtZXJyb3InLCBldmVudC5waGFzZSA9PT0gJ2Vycm9yJyk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZCh2YWx1ZSAqIDEwMCl9JWA7XHJcbiAgICAoZWxlbWVudCgnI3Byb2dyZXNzLWJhcicpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3ZhbHVlICogMTAwfSVgO1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBjb25zdCBpbXBvcnRpbmcgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgfHwgZXZlbnQucGhhc2UgPT09ICdzY2VuZSc7XHJcbiAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gbnVsbDtcclxuICAgIH1cclxuICAgIGlmIChpbXBvcnRpbmcpIHtcclxuICAgICAgICBjb25zdCBwcm9ncmVzcyA9IGV2ZW50LmJhdGNoID8gdmFsdWUgOiBpbXBvcnRQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXJ1bm5pbmcnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtc3VjY2VzcycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoJ2FyaWEtYnVzeScsICd0cnVlJyk7XHJcbiAgICAgICAgYnV0dG9uLnRpdGxlID0gZXZlbnQubWVzc2FnZTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnID8gJ+WHhuWkh+i1hOa6kCcgOiAn5p6E5bu66IqC54K5JztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSBgJHtNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKX0lYDtcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHtwcm9ncmVzcyAqIDEwMH0lYDtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdkb25lJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWujOaIkCc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJzEwMCUnO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcxMDAlJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTQwMCk7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZXJyb3InIHx8IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnID8gJ+W3suWPlua2iCcgOiAn5a+85YWl5aSx6LSlJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn6YeN6K+VJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTgwMCk7XHJcbiAgICB9XHJcbiAgICBpZiAoWydkb25lJywgJ2Vycm9yJywgJ2NhbmNlbGxlZCcsICdpZGxlJ10uaW5jbHVkZXMoZXZlbnQucGhhc2UpKSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdkb25lJyAmJiAhd29ya2Zsb3c/LnBlbmRpbmcgJiYgcGVuZGluZ0ltcG9ydFJldmlldykge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHBlbmRpbmdJbXBvcnRSZXZpZXc7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQuYmF0Y2g/LnJlc3VsdCAmJiAhYmF0Y2hJbXBvcnRQZW5kaW5nICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgaWYgKGJhdGNoUmVjb3ZlcnlUaW1lcikgY2xlYXJUaW1lb3V0KGJhdGNoUmVjb3ZlcnlUaW1lcik7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTsgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihldmVudC5iYXRjaC5yZXN1bHQpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZXNjZW5kYW50cyhub2RlOiBUcmVlTm9kZUR0byk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uZmxhdE1hcCgoY2hpbGQpID0+IFtjaGlsZCwgLi4uZGVzY2VuZGFudHMoY2hpbGQpXSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlY29uY2lsZUFjdGlvbnMoKTogdm9pZCB7XHJcbiAgICBjb25zdCBlZmZlY3RpdmUgPSByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyhcclxuICAgICAgICBzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSxcclxuICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLFxyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMsXHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMsXHJcbiAgICAgICAgc3RhdGUucmVuYW1lZElkcyxcclxuICAgICk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiBJbXBvcnRBY3Rpb24pOiB2b2lkIHtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgYWN0aW9uKSk7XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGU6IFRyZWVOb2RlRHRvKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzdGF0ZS5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleHBsaWNpdE92ZXJyaWRlcygpOiBJbXBvcnRPdmVycmlkZVtdIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKVxyXG4gICAgICAgIC5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSlcclxuICAgICAgICAubWFwKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbmFtZWQgPSBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmdldChub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUobm9kZSksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICAuLi4ocmVuYW1lZCA/IHsgbmFtZTogZWZmZWN0aXZlTm9kZU5hbWUobm9kZSkgfSA6IHt9KSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdE5vZGVPdmVycmlkZXMoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUtleSA9IHN0YXRlLmRvY3VtZW50LmZpbGVLZXk7XHJcbiAgICBjb25zdCBhY3RpdmUgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKTtcclxuICAgIGlmIChhY3RpdmUpIHsgYWN0aXZlLmNvbmZpZ3VyZWQgPSB0cnVlOyByZW1lbWJlckFjdGl2ZUZyYW1lKCk7IHJlbmRlckJhdGNoKCk7IH1cclxuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGV4cGxpY2l0T3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub2RlLmlkKTtcclxuICAgIC8vIFNlcmlhbGl6ZSB3cml0ZXMgc28gYSBzbG93ZXIgZWFybGllciByZXF1ZXN0IGNhbiBuZXZlciBvdmVyd3JpdGUgYSBuZXdlclxyXG4gICAgLy8gc3RyYXRlZ3kgc25hcHNob3QgYWZ0ZXIgcmFwaWQgc2VsZWN0IGNoYW5nZXMuXHJcbiAgICBub2RlT3ZlcnJpZGVTYXZlVGFzayA9IG5vZGVPdmVycmlkZVNhdmVUYXNrXHJcbiAgICAgICAgLmNhdGNoKCgpID0+IHVuZGVmaW5lZClcclxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3Q8SW1wb3J0T3ZlcnJpZGVbXT4oJ3NhdmUtbm9kZS1vdmVycmlkZXMnLCBmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+iKgueCueetlueVpeS/neWtmOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF0Y2hlcyhub2RlOiBUcmVlTm9kZUR0byk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhheXN0YWNrID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9ICR7bm9kZS5uYW1lfSAke25vZGUudHlwZX0gJHtub2RlLmlkfWAudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChoYXlzdGFjay5pbmNsdWRlcyhzdGF0ZS5zZWFyY2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKG1hdGNoZXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb24odmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEhUTUxPcHRpb25FbGVtZW50IHtcclxuICAgIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgIGl0ZW0udmFsdWUgPSB2YWx1ZTtcclxuICAgIGl0ZW0udGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYWtlU2VsZWN0KFxyXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogc3RyaW5nLFxyXG4gICAgaXRlbXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+LFxyXG4gICAgbGFiZWw6IHN0cmluZyxcclxuKTogSFRNTFNlbGVjdEVsZW1lbnQge1xyXG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICBzZWxlY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGxhYmVsKTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgdGV4dF0gb2YgaXRlbXMpIHtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKGtleSwgdGV4dCkpO1xyXG4gICAgfVxyXG4gICAgc2VsZWN0LnZhbHVlID0gdmFsdWU7XHJcbiAgICByZXR1cm4gc2VsZWN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBlbmRUcmVlTm9kZShjb250YWluZXI6IEhUTUxFbGVtZW50LCBub2RlOiBUcmVlTm9kZUR0bywgZGVwdGg6IG51bWJlcik6IHZvaWQge1xyXG4gICAgaWYgKCFtYXRjaGVzKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICByb3cuY2xhc3NOYW1lID0gYHRyZWUtcm93JHtzdGF0ZS5zZWxlY3RlZElkID09PSBub2RlLmlkID8gJyBpcy1zZWxlY3RlZCcgOiAnJ31gO1xyXG4gICAgcm93LmRhdGFzZXQubm9kZUlkID0gbm9kZS5pZDtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndHJlZWl0ZW0nKTtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGV2ZWwnLCBTdHJpbmcoZGVwdGggKyAxKSk7XHJcblxyXG4gICAgY29uc3QgbWFpbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWFpbi5jbGFzc05hbWUgPSAnbm9kZS1tYWluJztcclxuICAgIG1haW4uc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTtcclxuICAgIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgICBjb2xsYXBzZS5jbGFzc05hbWUgPSBgY29sbGFwc2Uke25vZGUuY2hpbGRyZW4ubGVuZ3RoID8gJycgOiAnIGlzLWxlYWYnfWA7XHJcbiAgICBjb2xsYXBzZS50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBjb2xsYXBzZS5kYXRhc2V0LmNvbGxhcHNlID0gbm9kZS5pZDtcclxuICAgIGNvbGxhcHNlLnRleHRDb250ZW50ID0gc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICfigLonIDogJ+KMhCc7XHJcbiAgICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+WxleW8gCcgOiAn5oqY5Y+gJyk7XHJcbiAgICBjb25zdCBkb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBkb3QuY2xhc3NOYW1lID0gYHR5cGUtZG90ICR7XHJcbiAgICAgICAgbm9kZS50eXBlID09PSAnVEVYVCcgPyAndGV4dCdcclxuICAgICAgICAgICAgOiBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAndmVjdG9yJ1xyXG4gICAgICAgICAgICAgICAgOiBub2RlLnR5cGUuaW5jbHVkZXMoJ0NPTVBPTkVOVCcpIHx8IG5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJyA/ICdjb21wb25lbnQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xyXG4gICAgfWA7XHJcbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBjb3B5LmNsYXNzTmFtZSA9ICdub2RlLWNvcHknO1xyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gYG5vZGUtbmFtZSR7c3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyAnIGlzLXJlbmFtZWQnIDogJyd9YDtcclxuICAgIG5hbWUudGV4dENvbnRlbnQgPSBkaXNwbGF5TmFtZTtcclxuICAgIGNvbnN0IHN0cmF0ZWd5U3VtbWFyeSA9IHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUobm9kZSwgc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpKTtcclxuICAgIG5hbWUudGl0bGUgPSBbXHJcbiAgICAgICAgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV9YCA6ICfpgInmi6noioLngrnvvIzlnKjlj7Pkvqfkv67mlLnlr7zlhaXoioLngrnlkI0nLFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkud2FybmluZyxcclxuICAgIF1cclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmpvaW4oJyDCtyAnKTtcclxuICAgIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1ldGEuY2xhc3NOYW1lID0gJ25vZGUtbWV0YSc7XHJcbiAgICBtZXRhLnRleHRDb250ZW50ID0gYCR7bm9kZS50eXBlfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb3B5LmFwcGVuZChuYW1lLCBtZXRhKTtcclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kpIHtcclxuICAgICAgICBjb25zdCBzdHJhdGVneSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHN0cmF0ZWd5LmNsYXNzTmFtZSA9ICdub2RlLXN0cmF0ZWd5JztcclxuICAgICAgICBzdHJhdGVneS50ZXh0Q29udGVudCA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBzdHJhdGVneS50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHN0cmF0ZWd5KTtcclxuICAgIH1cclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkud2FybmluZykge1xyXG4gICAgICAgIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICB3YXJuaW5nLmNsYXNzTmFtZSA9ICdub2RlLXdhcm5pbmcnO1xyXG4gICAgICAgIHdhcm5pbmcudGV4dENvbnRlbnQgPSBg4pqgICR7c3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmd9YDtcclxuICAgICAgICB3YXJuaW5nLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmc7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZCh3YXJuaW5nKTtcclxuICAgIH1cclxuICAgIHJvdy5jbGFzc0xpc3QudG9nZ2xlKCdoYXMtZGV0YWlsJywgQm9vbGVhbihzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpKTtcclxuICAgIG1haW4uYXBwZW5kKGNvbGxhcHNlLCBkb3QsIGNvcHkpO1xyXG5cclxuICAgIGNvbnN0IGFjdGlvbkJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgYWN0aW9uQmFkZ2UuY2xhc3NOYW1lID0gJ25vZGUtYWN0aW9uLWJhZGdlJztcclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBhY3Rpb25CYWRnZS50ZXh0Q29udGVudCA9IGFjdGlvbk9wdGlvbnNGb3JOb2RlKG5vZGUpLmZpbmQoKFt2YWx1ZV0pID0+IHZhbHVlID09PSBzZWxlY3RlZEFjdGlvbik/LlsxXSA/PyBzZWxlY3RlZEFjdGlvbjtcclxuICAgIGFjdGlvbkJhZGdlLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5IHx8IGFjdGlvbkJhZGdlLnRleHRDb250ZW50O1xyXG4gICAgcm93LmFwcGVuZChtYWluLCBhY3Rpb25CYWRnZSk7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuXHJcbiAgICBpZiAoIXN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgfHwgc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyLCBjaGlsZCwgZGVwdGggKyAxKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk6IHZvaWQge1xyXG4gICAgY29uc3QgY29udGFpbmVyID0gZWxlbWVudCgnI25vZGUtcHJvcGVydGllcycpO1xyXG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3Qgbm9kZSA9IHN0YXRlLnNlbGVjdGVkSWQgPyBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKSA6IHVuZGVmaW5lZDtcclxuICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdpbnNwZWN0b3ItZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+mAieaLqeiKgueCue+8jOafpeeci+mihOiniOW5tuiwg+aVtOWvvOWFpeiuvue9ruOAgic7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgZmllbGQgPSAobGFiZWw6IHN0cmluZywgY29udHJvbDogSFRNTEVsZW1lbnQpOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xyXG4gICAgICAgIHJvdy5jbGFzc05hbWUgPSAnZmllbGQnO1xyXG4gICAgICAgIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgaGVhZGluZy50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgICAgIHJvdy5hcHBlbmQoaGVhZGluZywgY29udHJvbCk7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJvdyk7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBuYW1lLnR5cGUgPSAndGV4dCc7XHJcbiAgICBuYW1lLmNsYXNzTmFtZSA9ICdub2RlLW5hbWUtaW5wdXQnO1xyXG4gICAgbmFtZS52YWx1ZSA9IGRpc3BsYXlOYW1lO1xyXG4gICAgbmFtZS5tYXhMZW5ndGggPSA5NjtcclxuICAgIG5hbWUuc3BlbGxjaGVjayA9IGZhbHNlO1xyXG4gICAgbmFtZS5kYXRhc2V0Lm5hbWVGb3IgPSBub2RlLmlkO1xyXG4gICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtub2RlLm5hbWV9IOWvvOWFpeiKgueCueWQjWApO1xyXG4gICAgbmFtZS50aXRsZSA9IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX3vvJtFbnRlciDkv53lrZjvvIxFc2Mg5Y+W5raIYDtcclxuICAgIG5hbWUuZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeiKgueCueWQjScsIG5hbWUpO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBjb25zdCBhY3Rpb25PcHRpb25zID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSk7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdhY3Rpb24tc2VsZWN0JyxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBhY3Rpb25PcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDlr7zlhaXmlrnlvI9gLFxyXG4gICAgKTtcclxuICAgIGFjdGlvbi5kYXRhc2V0LmFjdGlvbkZvciA9IG5vZGUuaWQ7XHJcbiAgICBhY3Rpb24uZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeaWueW8jycsIGFjdGlvbik7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRLaW5kID0gc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZDtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICBub2RlLFxyXG4gICAgICAgIHNlbGVjdGVkS2luZCxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBraW5kT3B0aW9ucyA9IGtpbmRPcHRpb25zRm9yQWN0aW9uKHNlbGVjdGVkQWN0aW9uKTtcclxuICAgIGNvbnN0IGtpbmQgPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdraW5kLXNlbGVjdCcsXHJcbiAgICAgICAgZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBraW5kT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g6IqC54K557G75Z6LYCxcclxuICAgICk7XHJcbiAgICBraW5kLmRhdGFzZXQua2luZEZvciA9IG5vZGUuaWQ7XHJcbiAgICBraW5kLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGZpZWxkKCfoioLngrnnsbvlnosnLCBraW5kKTtcclxuXHJcbiAgICBjb25zdCBwYXRjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICBwYXRjaC5jbGFzc05hbWUgPSAndG9nZ2xlLXJvdyBwYXRjaC10b2dnbGUnO1xyXG4gICAgcGF0Y2gudGl0bGUgPSBub2RlLnNsaWNlTW9kZVxyXG4gICAgICAgID8gYOWQr+eUqCR7bm9kZS5zbGljZU1vZGUgPT09ICduaW5lJyA/ICfkuZ3lrqvmoLwnIDogJ+S4ieWuq+agvCd95YiH54mHYFxyXG4gICAgICAgIDogbm9kZS5wYXRjaENhbmRpZGF0ZVxyXG4gICAgICAgICAgICA/ICflkK/nlKjoh6rliqjor4bliKvnmoTkuIkv5Lmd5a6r5qC85YiH54mHJ1xyXG4gICAgICAgICAgICA6ICfor6XoioLngrnkuI3mmK/oh6rliqjor4bliKvnmoTliIfniYflgJnpgIknO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3kgfHwgIW5vZGUucGF0Y2hDYW5kaWRhdGU7XHJcbiAgICBjb25zdCBwYXRjaEljb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBwYXRjaEljb24udGV4dENvbnRlbnQgPSBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgPyBub2RlLnNsaWNlTW9kZSA9PT0gJ25pbmUnID8gJ+WQr+eUqOS5neWuq+WIh+eJhycgOiBub2RlLnNsaWNlTW9kZSA/ICflkK/nlKjkuInlrqvliIfniYcnIDogJ+WQr+eUqOS4iSAvIOS5neWuq+WIh+eJhydcclxuICAgICAgICA6ICfliIfniYcgwrcg6Z2e5YCZ6YCJ6IqC54K5JztcclxuICAgIHBhdGNoLmFwcGVuZChwYXRjaElucHV0LCBwYXRjaEljb24pO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHBhdGNoKTtcclxuICAgIGNvbnN0IHN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBjb25zdCBub3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBub3RlLmNsYXNzTmFtZSA9ICdub2RlLWluc3BlY3Rvci1ub3RlJztcclxuICAgIGZvciAoY29uc3QgdGV4dCBvZiBbc3VtbWFyeS5zdHJhdGVneSwgYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfWAsIHN1bW1hcnkud2FybmluZ10pIHtcclxuICAgICAgICBpZiAoIXRleHQpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IHBhcmFncmFwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICBwYXJhZ3JhcGgudGV4dENvbnRlbnQgPSB0ZXh0O1xyXG4gICAgICAgIGlmICh0ZXh0ID09PSBzdW1tYXJ5Lndhcm5pbmcpIHBhcmFncmFwaC5jbGFzc05hbWUgPSAnbm9kZS13YXJuaW5nJztcclxuICAgICAgICBub3RlLmFwcGVuZENoaWxkKHBhcmFncmFwaCk7XHJcbiAgICB9XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQobm90ZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclRyZWUocmVzZXRTY3JvbGwgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdHJlZSA9IGVsZW1lbnQoJyN0cmVlJyk7XHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwodHJlZSwgKCkgPT4ge1xyXG4gICAgICAgIHRyZWUucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZW1wdHktc3RhdGUnO1xyXG4gICAgICAgICAgICBjb25zdCBnbHlwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICAgICAgZ2x5cGguY2xhc3NOYW1lID0gJ2VtcHR5LWdseXBoJztcclxuICAgICAgICAgICAgZ2x5cGgudGV4dENvbnRlbnQgPSAn4oazJztcclxuICAgICAgICAgICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcclxuICAgICAgICAgICAgdGl0bGUudGV4dENvbnRlbnQgPSAn6L+Y5rKh5pyJ6IqC54K5JztcclxuICAgICAgICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICAgICAgYm9keS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg6ZO+5o6l5ZCO77yM5Y+v6YCQ5bGC6YCJ5oup55Sf5oiQ44CBUE5HIOaVtOWxguaIluabtOaWsOOAgic7XHJcbiAgICAgICAgICAgIGVtcHR5LmFwcGVuZChnbHlwaCwgdGl0bGUsIGJvZHkpO1xyXG4gICAgICAgICAgICB0cmVlLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzdGF0ZS5kb2N1bWVudC50cmVlLmZvckVhY2goKG5vZGUpID0+IGFwcGVuZFRyZWVOb2RlKHRyZWUsIG5vZGUsIDApKTtcclxuICAgIH0sIHJlc2V0U2Nyb2xsKTtcclxuICAgIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoKTogdm9pZCB7XHJcbiAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHsgcmVtZW1iZXJBY3RpdmVGcmFtZSgpOyByZW5kZXJCYXRjaCgpOyB9XHJcbiAgICBjb25zdCBub2RlcyA9IHN0YXRlLmRvY3VtZW50ID8gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKSA6IFtdO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBub2Rlcy5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpICE9PSAnaWdub3JlJyk7XHJcbiAgICBlbGVtZW50KCcjbm9kZS1jb3VudCcpLnRleHRDb250ZW50ID0gYCR7bm9kZXMubGVuZ3RofSDoioLngrlgO1xyXG4gICAgZWxlbWVudCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgID8gYCR7c2VsZWN0ZWQubGVuZ3RofSAvICR7bm9kZXMubGVuZ3RofSDkuKroioLngrnlsIblj4LkuI7lr7zlhaVgXHJcbiAgICAgICAgOiAn562J5b6F6K6+6K6h5pWw5o2uJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gc3RhdGUuYnVzeVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzZWxlY3RlZC5sZW5ndGhcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXZpZXcobm9kZTogVHJlZU5vZGVEdG8pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc3RhdGUuc2VsZWN0ZWRJZCA9IG5vZGUuaWQ7XHJcbiAgICBjb25zdCByZXZpc2lvbiA9ICsrcHJldmlld1JldmlzaW9uO1xyXG4gICAgY29uc3QgZnJhbWVJZCA9IGFjdGl2ZUJhdGNoSWQ7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICBlbGVtZW50KCcjcHJldmlldy1tZXRhJykudGV4dENvbnRlbnQgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gwrcgJHtNYXRoLnJvdW5kKG5vZGUud2lkdGgpfcOXJHtNYXRoLnJvdW5kKG5vZGUuaGVpZ2h0KX1gO1xyXG4gICAgY29uc3Qgc3RhZ2UgPSBlbGVtZW50KCcjcHJldmlldy1zdGFnZScpO1xyXG4gICAgY29uc3QgaW1hZ2UgPSBlbGVtZW50PEhUTUxJbWFnZUVsZW1lbnQ+KCcjcHJldmlldy1pbWFnZScpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LmFkZCgnaXMtbG9hZGluZycpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LnJlbW92ZSgnaGFzLWltYWdlJyk7XHJcbiAgICBpbWFnZS5yZW1vdmVBdHRyaWJ1dGUoJ3NyYycpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBwcmVjZWRpbmdTeW5jID0gYmF0Y2hTeW5jVGFzaztcclxuICAgICAgICBjb25zdCByZWFkID0gcHJldmlld1JlYWRUYXNrLmNhdGNoKCgpID0+IHVuZGVmaW5lZCkudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHByZWNlZGluZ1N5bmM7XHJcbiAgICAgICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGZyYW1lSWQgIT09IGFjdGl2ZUJhdGNoSWQpIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICByZXR1cm4gcmVxdWVzdDx7IHVybDogc3RyaW5nIH0+KCdnZXQtcHJldmlldycsIG5vZGUuaWQpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHByZXZpZXdSZWFkVGFzayA9IHJlYWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWFkO1xyXG4gICAgICAgIGlmICghcmVzdWx0KSByZXR1cm47XHJcbiAgICAgICAgaWYgKHN0YXRlLnNlbGVjdGVkSWQgIT09IG5vZGUuaWQgfHwgcHJldmlld1JldmlzaW9uICE9PSByZXZpc2lvbiB8fCBmcmFtZUlkICE9PSBhY3RpdmVCYXRjaElkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICAgICAgICBpbWFnZS5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKCk7XHJcbiAgICAgICAgICAgIGltYWdlLm9uZXJyb3IgPSAoKSA9PiByZWplY3QobmV3IEVycm9yKCfpooTop4jlm77niYfliqDovb3lpLHotKXjgIInKSk7XHJcbiAgICAgICAgICAgIGltYWdlLnNyYyA9IHJlc3VsdC51cmw7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2hhcy1pbWFnZScpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBpZiAocHJldmlld1JldmlzaW9uID09PSByZXZpc2lvbikgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mihOiniOWksei0peOAgicsIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBpZiAocHJldmlld1JldmlzaW9uID09PSByZXZpc2lvbikgc3RhZ2UuY2xhc3NMaXN0LnJlbW92ZSgnaXMtbG9hZGluZycpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVByZXNldChuYW1lOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBhbGwgPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgaWYgKG5hbWUgPT09ICdzbWFydCcpIHtcclxuICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKHN0YXRlLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgY29uc3Qgb3JpZ2luYWwgPSBzdGF0ZS5kZWZhdWx0cy5nZXQobm9kZS5pZCkhO1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBvcmlnaW5hbC5hY3Rpb24pO1xyXG4gICAgICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgb3JpZ2luYWwua2luZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChuYW1lID09PSAnZWRpdGFibGUnKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAncmVuZGVyJyA6ICdnZW5lcmF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/ICdnZW5lcmF0ZSdcclxuICAgICAgICAgICAgICAgIDogJ3JlbmRlcicpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gbmFtZSk7XHJcbiAgICB9KTtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydFRvU2NlbmUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAod29ya2Zsb3cgJiYgd29ya2Zsb3cuc3RlcCAhPT0gMykgcmV0dXJuO1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIHNob3dUb2FzdCgn5omp5bGV5Li76L+b56iL5LuN5piv5pen54mI77yM6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50IHx8IHN0YXRlLmJ1c3kpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncygpO1xyXG4gICAgaWYgKCFzZXR0aW5ncykge1xyXG4gICAgICAgIHdvcmtmbG93Py5mYWlsKCfor7fmo4Dmn6Xlr7zlhaXlgI3njofkuI7ovpPlh7rnm67lvZXvvIzkv67mraPlkI7lho3mrKHlr7zlhaXjgIInKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICBhd2FpdCBpbXBvcnRCYXRjaEZyYW1lcyhzZXR0aW5ncyk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+ICh7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgYWN0aW9uOiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbixcclxuICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAuLi4oc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICB9KSk7XHJcbiAgICB3b3JrZmxvdz8uYmVnaW4oJ2ltcG9ydCcpO1xyXG4gICAgc2V0QnVzeSh0cnVlKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+ato+WcqOWHhuWkh+WvvOWFpeKApicgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8V29ya2Zsb3dSZXN1bHQ+KFxyXG4gICAgICAgICAgICAnaW1wb3J0LXNlbGVjdGlvbicsXHJcbiAgICAgICAgICAgIHsgb3ZlcnJpZGVzLCBzZXR0aW5ncyB9LFxyXG4gICAgICAgICk7XHJcbiAgICAgICAgY29uc3QgZmFsbGJhY2tOb3RlID0gcmVzdWx0Py53YXJuaW5ncz8ubGVuZ3RoXHJcbiAgICAgICAgICAgID8gYO+8myR7cmVzdWx0Lndhcm5pbmdzLmxlbmd0aH0g5p2h5a+85YWlL+aUtuWwvuaPkOekuu+8iOivpuingee7k+aenOajgOafpe+8iWBcclxuICAgICAgICAgICAgOiAnJztcclxuICAgICAgICBzaG93VG9hc3QocmVzdWx0Py5wcmVmYWJVcmxcclxuICAgICAgICAgICAgPyBg5a+85YWl5a6M5oiQ77yM5bey5Yib5bu66aKE5Yi25L2T77yaJHtyZXN1bHQucHJlZmFiVXJsfSR7ZmFsbGJhY2tOb3RlfWBcclxuICAgICAgICAgICAgOiBg5a+85YWl5a6M5oiQ77yM5bey5Zyo5Zy65pmv5Lit6YCJ5Lit5qC56IqC54K5JHtmYWxsYmFja05vdGV944CCYCk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHJlc3VsdCk7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcmVzdWx0LnJldmlldyA/PyBwZW5kaW5nSW1wb3J0UmV2aWV3O1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIGlmIChyZXZpZXcpIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICflr7zlhaXlpLHotKXjgIInKTtcclxuICAgICAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiB3b3JrZmxvdz8uY2FuY2VsbGVkID8gJ2NhbmNlbGxlZCcgOiAnZXJyb3InLCB2YWx1ZTogMCwgbWVzc2FnZSB9KTtcclxuICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgIXdvcmtmbG93Py5jYW5jZWxsZWQpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICB3b3JrZmxvdz8uZW5kKCk7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBtZXJnZUJhdGNoSXRlbXMoaXRlbXM6IEJhdGNoRnJhbWVJdGVtW10pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzID0gYmF0Y2hJdGVtcy5maW5kKChlbnRyeSkgPT4gZW50cnkuaXRlbS5pZCA9PT0gaXRlbS5pZCk7XHJcbiAgICAgICAgaWYgKHByZXZpb3VzKSBwcmV2aW91cy5pdGVtID0geyAuLi5pdGVtLCBlbmFibGVkOiBwcmV2aW91cy5pdGVtLmVuYWJsZWQgfTtcclxuICAgICAgICBlbHNlIGJhdGNoSXRlbXMucHVzaCh7IGl0ZW0sIGVkaXRvcjogaW5pdGlhbEZyYW1lRWRpdG9yKGl0ZW0uZG9jdW1lbnQpLCBjb25maWd1cmVkOiBCb29sZWFuKGl0ZW0uZG9jdW1lbnQubm9kZU92ZXJyaWRlcz8ubGVuZ3RoKSB9KTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVhZEJhdGNoU291cmNlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIGlmICh3b3JrZmxvdyAmJiAhd29ya2Zsb3cuY3JlZGVudGlhbHNSZWFkeSkgeyB3b3JrZmxvdy5vcGVuQ3JlZGVudGlhbHMoKTsgcmV0dXJuOyB9XHJcbiAgICBjb25zdCBzb3VyY2UgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghc291cmNlKSB7IHNob3dUb2FzdCgn6K+357KY6LS0IEZpZ21hIFNlY3Rpb24g5oiWIEZyYW1lIOmTvuaOpeOAgicsIHRydWUpOyByZXR1cm47IH1cclxuICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTsgaWYgKHNldHRpbmdzKSBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdmZXRjaCcpOyBzZXRCdXN5KHRydWUpO1xyXG4gICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMDUsIG1lc3NhZ2U6ICfmraPlnKjor7vlj5blubbor4bliKsgRmlnbWEg55WM6Z2i4oCmJyB9KTtcclxuICAgIGxldCBhY3RpdmF0ZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBiYXRjaFN5bmNUYXNrO1xyXG4gICAgICAgIGF3YWl0IHByZXZpZXdSZWFkVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGlmIChiYXRjaFN5bmNFcnJvcikgdGhyb3cgYmF0Y2hTeW5jRXJyb3I7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDxCYXRjaFNvdXJjZVJlc3VsdD4oJ3Jlc29sdmUtYmF0Y2gtc291cmNlJywgc291cmNlKTtcclxuICAgICAgICBpZiAocmVzdWx0LmRvY3VtZW50ICYmICFyZXN1bHQuaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGJhdGNoSXRlbXMgPSBbXTsgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDsgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSByZXN1bHQuZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBzdGF0ZS5mb250QXNzZXRzO1xyXG4gICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQocmVzdWx0LmRvY3VtZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBtZXJnZUJhdGNoSXRlbXMocmVzdWx0Lml0ZW1zKTtcclxuICAgICAgICAgICAgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBBcnJheS5mcm9tKG5ldyBNYXAoYmF0Y2hJdGVtcy5mbGF0TWFwKCh7IGl0ZW0gfSkgPT4gaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID8/IFtdKS5tYXAoKGZvbnQpID0+IFtmb250LnVybCwgZm9udF0pKS52YWx1ZXMoKSk7XHJcbiAgICAgICAgICAgIGFjdGl2YXRlID0gc2VsZWN0ZWRGcmFtZXMoKS5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk/Lml0ZW0uaWQgPz8gc2VsZWN0ZWRGcmFtZXMoKVswXT8uaXRlbS5pZCA/PyBiYXRjaEl0ZW1zWzBdPy5pdGVtLmlkO1xyXG4gICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gJyc7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5iYXRjaFJlYWR5KCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg5bey5re75YqgICR7cmVzdWx0LmFkZGVkfSDkuKrnlYzpnaIke3Jlc3VsdC5kdXBsaWNhdGVzID8gYO+8jOi3s+i/hyAke3Jlc3VsdC5kdXBsaWNhdGVzfSDkuKrph43lpI3poblgIDogJyd944CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5aSx6LSl44CCJyk7XHJcbiAgICAgICAgaWYgKCF3b3JrZmxvdz8uY2FuY2VsbGVkKSB3b3JrZmxvdz8uZmFpbChtZXNzYWdlKTtcclxuICAgICAgICBzaG93VG9hc3Qod29ya2Zsb3c/LmNhbmNlbGxlZCA/ICfor7vlj5blt7Llj5bmtojvvIzphY3nva7lt7Lkv53nlZnjgIInIDogbWVzc2FnZSwgIXdvcmtmbG93Py5jYW5jZWxsZWQpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIGlmIChhY3RpdmF0ZSkgYXdhaXQgYWN0aXZhdGVGcmFtZShhY3RpdmF0ZSk7XHJcbiAgICAgICAgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBvdmVycmlkZXNGb3JGcmFtZShlbnRyeTogRnJhbWVFZGl0b3JJdGVtKTogSW1wb3J0T3ZlcnJpZGVbXSB7XHJcbiAgICBjb25zdCBlZGl0b3IgPSBlbnRyeS5lZGl0b3IgPz8gaW5pdGlhbEZyYW1lRWRpdG9yKGVudHJ5Lml0ZW0uZG9jdW1lbnQpO1xyXG4gICAgcmV0dXJuIGZsYXR0ZW4oZW50cnkuaXRlbS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+ICh7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsIGFjdGlvbjogZWRpdG9yLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uLCBraW5kOiBlZGl0b3Iua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGVkaXRvci5wYXRjaGVzLmhhcyhub2RlLmlkKSwgZXhwbGljaXQ6IGVkaXRvci5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKGVkaXRvci5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IHsgbmFtZTogZWRpdG9yLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWUgfSA6IHt9KSxcclxuICAgIH0pKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLCBpZHM/OiBTZXQ8c3RyaW5nPik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kgfHwgYmF0Y2hJbXBvcnRQZW5kaW5nKSByZXR1cm47XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBlbnRyaWVzID0gc2VsZWN0ZWRGcmFtZXMoKS5maWx0ZXIoKHsgaXRlbSB9KSA9PiAhaWRzIHx8IGlkcy5oYXMoaXRlbS5pZCkpO1xyXG4gICAgaWYgKCFlbnRyaWVzLmxlbmd0aCkgeyBzaG93VG9hc3QoJ+ivt+WFiOWLvumAieimgeWvvOWFpeeahOeVjOmdouOAgicsIHRydWUpOyByZXR1cm47IH1cclxuICAgIGlmIChiYXRjaENvbmZsaWN0cygpLnNpemUpIHsgd29ya2Zsb3c/LmZhaWwoJ+WtmOWcqOmHjeWkjeeahCBQcmVmYWIg5paH5Lu25ZCN77yM6K+35YWI5Zyo5riF5Y2V5Lit5pS55ZCN44CCJyk7IHJldHVybjsgfVxyXG4gICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gdHJ1ZTsgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDsgYmF0Y2hTdG9wUmVxdWVzdGVkID0gZmFsc2U7XHJcbiAgICBjb25zdCBwcmV2aW91cyA9IGJhdGNoUmVzdWx0O1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTsgc2V0QnVzeSh0cnVlKTsgcmVuZGVyQmF0Y2goKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogYOWHhuWkh+WvvOWFpSAke2VudHJpZXMubGVuZ3RofSDkuKrnlYzpnaLigKZgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBiYXRjaFN5bmNUYXNrO1xyXG4gICAgICAgIGF3YWl0IHByZXZpZXdSZWFkVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGlmIChiYXRjaFN5bmNFcnJvcikgdGhyb3cgYmF0Y2hTeW5jRXJyb3I7XHJcbiAgICAgICAgYXdhaXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s7XHJcbiAgICAgICAgaWYgKGJhdGNoU3RvcFJlcXVlc3RlZCkge1xyXG4gICAgICAgICAgICBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHsgaWQ6ICdzdG9wcGVkLWJlZm9yZS1zdGFydCcsIHN0b3BwZWQ6IHRydWUsIGNvbXBsZXRlZDogMCwgdG90YWw6IGVudHJpZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgaXRlbXM6IGVudHJpZXMubWFwKCh7IGl0ZW0gfSkgPT4gKHsgaWQ6IGl0ZW0uaWQsIG5hbWU6IGl0ZW0ubmFtZSwgc291cmNlVXJsOiBpdGVtLnNvdXJjZVVybCwgc3RhdHVzOiAncGVuZGluZycgfSkpIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hJbXBvcnRSZXN1bHQ+KCdpbXBvcnQtYmF0Y2gnLCB7XHJcbiAgICAgICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBvdmVycmlkZXM6IG92ZXJyaWRlc0ZvckZyYW1lKGVudHJ5KSB9KSksIHNldHRpbmdzLFxyXG4gICAgICAgICAgICBmYWlsdXJlUG9saWN5OiAnY29udGludWUnLCBwcmVzZXJ2ZVJlc3VsdHM6IEJvb2xlYW4oaWRzKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBtZXJnZWQgPSBpZHMgJiYgcHJldmlvdXMgPyBwcmV2aW91cy5pdGVtcy5tYXAoKGl0ZW0pID0+IHJlc3VsdC5pdGVtcy5maW5kKChuZXh0KSA9PiBuZXh0LmlkID09PSBpdGVtLmlkKSA/PyBpdGVtKSA6IHJlc3VsdC5pdGVtcztcclxuICAgICAgICBiYXRjaFJlc3VsdCA9IHsgLi4ucmVzdWx0LCBpdGVtczogbWVyZ2VkLCB0b3RhbDogbWVyZ2VkLmxlbmd0aCwgY29tcGxldGVkOiBtZXJnZWQuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoIH07XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDsgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0uY3JlYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgY29uc3QgdXBkYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgY3JlYXRlZCwgdXBkYXRlZCwgd2FybmluZ3M6IG1lcmdlZC5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSB9KTtcclxuICAgICAgICBzaG93VG9hc3QoYOacrOaJueWujOaIkO+8muaIkOWKnyAke21lcmdlZC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aH0g6aG577yM5aSx6LSlICR7bWVyZ2VkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGh9IOmhueOAgmApO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5om56YeP5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7IHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmV0cnlCYXRjaChzdGF0dXM6ICdmYWlsZWQnIHwgJ3BlbmRpbmcnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSB8fCAhYmF0Y2hSZXN1bHQpIHJldHVybjtcclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7IGlmICghc2V0dGluZ3MpIHJldHVybjtcclxuICAgIGNvbnN0IGlkcyA9IG5ldyBTZXQoYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gc3RhdHVzKS5tYXAoKGl0ZW0pID0+IGl0ZW0uaWQpKTtcclxuICAgIGF3YWl0IGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzLCBpZHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQpOiB2b2lkIHtcclxuICAgIGJhdGNoUmVzdWx0ID0gcmVzdWx0OyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgd29ya2Zsb3c/LmNvbXBsZXRlKHtcclxuICAgICAgICBjcmVhdGVkOiByZXN1bHQuaXRlbXMucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLmNyZWF0ZWQgPz8gMCksIDApLFxyXG4gICAgICAgIHVwZGF0ZWQ6IHJlc3VsdC5pdGVtcy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCksXHJcbiAgICAgICAgd2FybmluZ3M6IHJlc3VsdC5pdGVtcy5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSxcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyQmF0Y2goKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2F0Y2hSZXN0b3JlZEJhdGNoKCk6IHZvaWQge1xyXG4gICAgYmF0Y2hSZWNvdmVyeVRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFwYW5lbEhvc3QpIHJldHVybjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZXF1ZXN0PEJhdGNoU3RhdGU+KCdnZXQtYmF0Y2gtc3RhdGUnKTtcclxuICAgICAgICAgICAgaWYgKHJlY292ZXJlZC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICBiYXRjaFByb2dyZXNzID0gcmVjb3ZlcmVkLnJ1bm5pbmc7IHJlbmRlckJhdGNoUmVzdWx0cygpOyB3YXRjaFJlc3RvcmVkQmF0Y2goKTsgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChyZWNvdmVyZWQubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihyZWNvdmVyZWQubGFzdFJlc3VsdCk7XHJcbiAgICAgICAgICAgIGVsc2Ugd29ya2Zsb3c/LmZhaWwoJ+WQjuWPsOaJuemHj+S7u+WKoeW3sue7j+e7k+adn++8jOivt+ajgOafpSBDb2NvcyDkuK3nmoTlr7zlhaXnu5PmnpzjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpOyB3b3JrZmxvdz8uZmFpbChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5blkI7lj7Dmibnph4/ku7vliqHlpLHotKXjgIInKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSwgODAwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkltcG9ydFJldmlldyh0YWI6ICdhc3NldHMnIHwgJ25vZGVzJyB8ICdzb3VyY2UnID0gJ2Fzc2V0cycpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgaWYgKHJldmlldykge1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmRleCA9IFsnYXNzZXRzJywgJ25vZGVzJywgJ3NvdXJjZSddLmluZGV4T2YodGFiKTtcclxuICAgICAgICAgICAgaWYgKGluZGV4ID4gMCkgZWxlbWVudCgnI2ltcG9ydC1yZXZpZXctZGlhbG9nJykucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJy5yZXZpZXctdGFicyBidXR0b24nKVtpbmRleF0/LmNsaWNrKCk7XHJcbiAgICAgICAgfSBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5qOA5p+l57uT5p6c5aSx6LSl44CCJyksIHRydWUpOyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IHZvaWQgb3BlbkltcG9ydFJldmlldygpOyB9KTtcclxuICAgIGVsZW1lbnQoJyNzYXZlLXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdG9rZW4taW5wdXQnKTtcclxuICAgICAgICBpZiAoIWlucHV0LnZhbHVlLnRyaW0oKSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSBUb2tlbuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBzYXZlZCA9IGZhbHNlO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgdmF1bHQgPSBhd2FpdCByZXF1ZXN0PGFueT4oJ3NldC10b2tlbicsIGlucHV0LnZhbHVlKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbih2YXVsdCk7XHJcbiAgICAgICAgICAgIHNhdmVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzYXZlZCkgd29ya2Zsb3c/LmNsb3NlQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBmb3JjZVJlYWQgPSBmb3JjZURvY3VtZW50UmVhZDtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IGZhbHNlO1xyXG4gICAgICAgIGlmICh3b3JrZmxvdyAmJiAhd29ya2Zsb3cuY3JlZGVudGlhbHNSZWFkeSkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdy5vcGVuQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGggJiYgIWZvcmNlUmVhZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHNlbGVjdGVkRnJhbWVzKCk7XHJcbiAgICAgICAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgICAgIGF3YWl0IGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWQuc29tZSgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpID8gYWN0aXZlQmF0Y2hJZCEgOiBzZWxlY3RlZFswXS5pdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZm9yY2VSZWFkICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlKSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gYWN0aXZlLml0ZW0uc291cmNlVXJsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWZvcmNlUmVhZCAmJiB3b3JrZmxvdz8uc291cmNlVW5jaGFuZ2VkKCkpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3cubmF2aWdhdGUoMik7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgcmVhZEJhdGNoU291cmNlKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNhZGQtYmF0Y2gtc291cmNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZWFkQmF0Y2hTb3VyY2UpO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWVkaXQtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gd29ya2Zsb3c/Lm5hdmlnYXRlKDEpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC10b2dnbGUtYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBlbmFibGVkID0gc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGggIT09IGJhdGNoSXRlbXMubGVuZ3RoO1xyXG4gICAgICAgIGJhdGNoSXRlbXMuZm9yRWFjaCgoeyBpdGVtIH0pID0+IHsgaXRlbS5lbmFibGVkID0gZW5hYmxlZDsgfSk7XHJcbiAgICAgICAgc3luY0JhdGNoSXRlbXMoKTsgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXRyeS1mYWlsZWQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJldHJ5QmF0Y2goJ2ZhaWxlZCcpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bWUtcGVuZGluZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmV0cnlCYXRjaCgncGVuZGluZycpKTtcclxuICAgIGVsZW1lbnQoJyNyZWZyZXNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IHRydWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpLmNsaWNrKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYWRkLWJhdGNoLXNvdXJjZScpLmNsaWNrKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcmVzZXRSb3VuZHRyaXBUb2tlbnMpO1xyXG4gICAgZWxlbWVudCgnI3BpY2stYXNzZXQtZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1hc3NldC1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6LWE5rqQ5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqei1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI3BpY2stcHJlZmFiLWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLXByZWZhYi1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOmihOWItuS9k+WwhuWGmeWFpSBhc3NldHMvJHtyZXN1bHQuZm9sZGVyfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6npooTliLbkvZPnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudChgI3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y77yM5YaN6YCJ5oup5pys5Zyw6LWE5rqQ55uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICAgICAgaW5kZXgsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3suWQr+eUqOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup5pys5Zyw6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGVsZW1lbnQoYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gJyc7XHJcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzaG93VG9hc3QoYOW3sua4hemZpOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBpbXBvcnRUb1NjZW5lKTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgaWYgKGJhdGNoSW1wb3J0UGVuZGluZykgYmF0Y2hTdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgICAgICB3b3JrZmxvdz8uY2FuY2VsUmVxdWVzdGVkKCk7XHJcbiAgICAgICAgdHJ5IHsgYXdhaXQgcmVxdWVzdChiYXRjaEltcG9ydFBlbmRpbmcgPyAnc3RvcC1pbXBvcnQtYmF0Y2gnIDogJ2NhbmNlbC1pbXBvcnQnKTsgfVxyXG4gICAgICAgIGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5Y+W5raI6K+35rGC5aSx6LSl77yM6K+356iN5ZCO6YeN6K+V44CCJyk7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5jYW5jZWxSZXF1ZXN0RmFpbGVkKG1lc3NhZ2UpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBzdGF0ZS5zZWFyY2ggPSAoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBjb2xsYXBzZUlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2xsYXBzZV0nKT8uZGF0YXNldC5jb2xsYXBzZTtcclxuICAgICAgICBpZiAoY29sbGFwc2VJZCkge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkLmhhcyhjb2xsYXBzZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmRlbGV0ZShjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5hZGQoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuY2xvc2VzdCgnc2VsZWN0LCBsYWJlbCwgaW5wdXQsIHRleHRhcmVhJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtbm9kZS1pZF0nKT8uZGF0YXNldC5ub2RlSWQ7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGlkID8gZmluZE5vZGUoaWQpIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHZvaWQgcHJldmlldyhub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGlmICghdGFyZ2V0LmRhdGFzZXQubmFtZUZvciAmJiAhdGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yICYmICF0YXJnZXQuZGF0YXNldC5raW5kRm9yICYmICF0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikgcmV0dXJuO1xyXG4gICAgICAgIGlmICh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XHJcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlmICghY3VzdG9tTmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+iKgueCueWQjeS4jeiDveS4uuepuuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgaWYgKGN1c3RvbU5hbWUgPT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKVxyXG4gICAgICAgICAgICAgICAgPyBg6IqC54K55bCG5Lul4oCcJHtjdXN0b21OYW1lfeKAneWvvOWFpeOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+W3suaBouWkjSBGaWdtYSDljp/oioLngrnlkI3jgIInKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHRhcmdldC52YWx1ZSBhcyBJbXBvcnRBY3Rpb247XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uICE9PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgc2V0QWN0aW9uKG5vZGUsIGFjdGlvbik7XHJcbiAgICAgICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uID09PSAncmVuZGVyJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNob3dUb2FzdChg4oCcJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX3igJ3lsIbkvZzkuLrmlbTlsYLlr7zlhaXvvIwke2Rlc2NlbmRhbnRzKG5vZGUpLmxlbmd0aH0g5Liq5a2Q6IqC54K55LiN5Lya5Y2V54us55Sf5oiQ44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5raW5kRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldCh0YXJnZXQuZGF0YXNldC5raW5kRm9yLCB0YXJnZXQudmFsdWUgYXMgTm9kZUtpbmQpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQua2luZEZvcik7XHJcbiAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpO1xyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikge1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICBpZiAoKHRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgJ3JlbmRlcicpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuZGF0YXNldC5uYW1lRm9yO1xyXG4gICAgICAgIGlmICghaWQpIHJldHVybjtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseVByZXNldChidXR0b24uZGF0YXNldC5wcmVzZXQgPz8gJ3NtYXJ0JykpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFxyXG4gICAgICAgICcjc2NhbGUsICNhc3NldC1mb2xkZXIsICNwcmVmYWItZm9sZGVyLCAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLCAjdXBkYXRlLWV4aXN0aW5nLCAjcmVmcmVzaC1hc3NldHMsICNhdXRvLXNhdmUnLFxyXG4gICAgKS5mb3JFYWNoKChjb250cm9sKSA9PiB7XHJcbiAgICAgICAgY29udHJvbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmb250LW1hcC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcclxuICAgIGxpc3RlbmVyczoge1xyXG4gICAgICAgIHNob3coKSB7fSxcclxuICAgICAgICBoaWRlKCkge30sXHJcbiAgICB9LFxyXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0ZjgnKSxcclxuICAgIHN0eWxlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKSwgJ3V0ZjgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBhcHA6ICcjYXBwJyxcclxuICAgIH0sXHJcbiAgICBtZXRob2RzOiB7XHJcbiAgICAgICAgb25JbXBvcnRSZXZpZXdSZWFkeShyZXZpZXc6IEltcG9ydFJldmlldykge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHsgd29ya2Zsb3c/LnJlbWVtYmVyUmV2aWV3KCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSB8fCB3b3JrZmxvdz8ucGVuZGluZykge1xyXG4gICAgICAgICAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IHJldmlldztcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUoeyByZXZpZXcgfSk7XHJcbiAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBvblByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KSB7XHJcbiAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICB9LFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJlYWR5KCkge1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IHRoaXM7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWwgPSBuZXcgSW1wb3J0UmV2aWV3UGFuZWwocm9vdCgpLCByZXF1ZXN0LCBzZXRCdXN5KTtcclxuICAgICAgICB3b3JrZmxvdyA9IG5ldyBQYW5lbFdvcmtmbG93KHJvb3QoKSwgKCkgPT4gKHsgLi4uc3RhdGUsIGJhdGNoOiBiYXRjaENvbnRleHQoKSB9KSwgKHRhYikgPT4geyB2b2lkIG9wZW5JbXBvcnRSZXZpZXcodGFiKTsgfSk7XHJcbiAgICAgICAgYmluZEV2ZW50cygpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGluaXRpYWwgPSBhd2FpdCByZXF1ZXN0PHtcclxuICAgICAgICAgICAgICAgIHZlcnNpb24/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICB2YXVsdDogYW55O1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IERvY3VtZW50RHRvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgICAgICAgICAgfT4oJ2dldC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSA9IGluaXRpYWwudmVyc2lvbiA9PT0gcGFja2FnZUpTT04udmVyc2lvbjtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGluaXRpYWwuZm9udEFzc2V0cyA/PyBbXTtcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbihpbml0aWFsLnZhdWx0KTtcclxuICAgICAgICAgICAgYXBwbHlTZXR0aW5ncyhpbml0aWFsLnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluaXRpYWwuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgICAgIGluaXRpYWxpemVEb2N1bWVudChpbml0aWFsLmRvY3VtZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBiYXRjaCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTdGF0ZSB8IHVuZGVmaW5lZD4oJ2dldC1iYXRjaC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2g/Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKGJhdGNoLml0ZW1zKTtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBBcnJheS5mcm9tKG5ldyBNYXAoYmF0Y2guaXRlbXMuZmxhdE1hcCgoaXRlbSkgPT4gaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID8/IFtdKS5tYXAoKGZvbnQpID0+IFtmb250LnVybCwgZm9udF0pKS52YWx1ZXMoKSk7XHJcbiAgICAgICAgICAgICAgICB3b3JrZmxvdy5iYXRjaFJlYWR5KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBzZWxlY3RlZEZyYW1lcygpWzBdID8/IGJhdGNoSXRlbXNbMF07XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBhY3RpdmUuaXRlbS5pZDtcclxuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKHN0YXRlLCBhY3RpdmUuZWRpdG9yKTtcclxuICAgICAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7IHJlbmRlckZvbnRNYXAoKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBhd2FpdCBhY3RpdmF0ZUZyYW1lKGFjdGl2ZS5pdGVtLmlkKTtcclxuICAgICAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihiYXRjaC5sYXN0UmVzdWx0KTtcclxuICAgICAgICAgICAgICAgIGlmIChiYXRjaC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGJhdGNoLnJ1bm5pbmc7IHdvcmtmbG93LmJlZ2luKCdpbXBvcnQnKTsgc2V0QnVzeSh0cnVlKTsgd2F0Y2hSZXN0b3JlZEJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICAgICAgICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn6K+36YeN5ZCvIENvY29zJztcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihrsnO1xyXG4gICAgICAgICAgICAgICAgc2hvd1RvYXN0KCfmo4DmtYvliLDml6fniYjkuLvov5vnqIvku43lnKjov5DooYzvvJror7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gUmVwbGF5IHBlcnNpc3RlZCBpbi1tZW1vcnkgcmVwb3J0IGlmIGNvbXBsZXRpb24gcHJlY2VkZWQgcGFuZWwgcmVhZGluZXNzLlxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmV2aWV3ID0gYXdhaXQgcmVxdWVzdDxJbXBvcnRSZXZpZXcgfCBudWxsPignZ2V0LWltcG9ydC1yZXZpZXcnKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXZpZXcpIHdvcmtmbG93LnJlbWVtYmVyUmV2aWV3KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmV2aWV3ICYmICFyZXZpZXcuY29uZmlybWVkICYmICFiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHdvcmtmbG93LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5Yid5aeL5YyW5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuICAgIGJlZm9yZUNsb3NlKCkge30sXHJcbiAgICBjbG9zZSgpIHtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8uZGlzcG9zZSgpO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbnVsbDtcclxuICAgICAgICB3b3JrZmxvdyA9IG51bGw7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgaWYgKHRvYXN0VGltZXIpIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgICAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikgY2xlYXJUaW1lb3V0KGltcG9ydEJ1dHRvblJlc2V0VGltZXIpO1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIGJhdGNoSXRlbXMgPSBbXTsgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDsgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IGJhdGNoU3luY0Vycm9yID0gdW5kZWZpbmVkOyBiYXRjaFN5bmNUYXNrID0gUHJvbWlzZS5yZXNvbHZlKCk7IHByZXZpZXdSZXZpc2lvbisrO1xyXG4gICAgICAgIHByZXZpZXdSZWFkVGFzayA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19