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
const import_planner_1 = require("../../figma/import-planner");
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
            if (node.patchCandidate)
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
function syncBatchItems(precedingPreview = previewReadTask) {
    const items = batchItems.map(({ item }) => ({ id: item.id, enabled: item.enabled }));
    batchSyncTask = batchSyncTask.catch(() => undefined).then(async () => {
        await precedingPreview.catch(() => undefined);
        await request('sync-batch-items', items);
        batchSyncError = undefined;
    }).catch((error) => {
        batchSyncError = error;
        showToast(errorMessage(error, '界面列表保存失败，请重试。'), true);
    });
    return batchSyncTask;
}
async function waitForBatchListReady() {
    // Snapshot both dependencies before waiting. Later previews may themselves
    // wait for a newly queued sync, so never make that sync depend on them.
    const precedingSync = batchSyncTask;
    const precedingPreview = previewReadTask;
    await precedingSync;
    await precedingPreview.catch(() => undefined);
    if (batchSyncError) {
        const previousMessage = errorMessage(batchSyncError, '界面列表保存失败，请重试。');
        // A failed save leaves the optimistic list unconfirmed. Retry its latest
        // contents once; only a successful backend acknowledgement clears it.
        await syncBatchItems(precedingPreview);
        if (batchSyncError)
            throw batchSyncError;
        if (element('#workflow-error-message').textContent === previousMessage)
            workflow === null || workflow === void 0 ? void 0 : workflow.clearError();
        if (element('#toast').textContent === previousMessage)
            showToast('界面列表已同步，可以继续。');
    }
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
            let nextId;
            if (activeBatchId === item.id) {
                activeBatchId = undefined;
                if (selectedFrames().length)
                    nextId = selectedFrames()[0].item.id;
                else if (batchItems.length)
                    nextId = batchItems[0].item.id;
                else {
                    state.document = null;
                    renderTree();
                    workflow === null || workflow === void 0 ? void 0 : workflow.batchReady();
                }
            }
            syncBatchItems();
            if (nextId)
                void activateFrame(nextId);
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
    const alreadyActive = activeBatchId === id && state.document;
    rememberActiveFrame();
    const oldId = activeBatchId;
    const oldEditor = editorSnapshot();
    const settings = readSettings(false);
    if (settings)
        state.settings = settings;
    previewRevision++;
    setBusy(true);
    try {
        await waitForBatchListReady();
        const loaded = alreadyActive ? state.document : await request('activate-batch-item', id);
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
function safeAction(node, action) {
    return (0, import_planner_1.normalizeFigmaSliceDecision)({ action: (0, import_actions_1.normalizeImportAction)(action), kind: node.kind, nineSlice: false }, node.patchCandidate).action;
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
            if (node.patchCandidate) {
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
    var _a, _b, _c, _d;
    state.patches = (0, model_1.defaultNineSliceIds)((_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.tree) !== null && _b !== void 0 ? _b : []);
    const effective = (0, model_1.resolveEffectiveActions)((_d = (_c = state.document) === null || _c === void 0 ? void 0 : _c.tree) !== null && _d !== void 0 ? _d : [], state.preferredActions, state.patches, state.explicitIds, state.renamedIds);
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
        return (0, import_planner_1.normalizeFigmaSliceDecision)({
            id: node.id,
            action: (_a = state.preferredActions.get(node.id)) !== null && _a !== void 0 ? _a : (0, model_1.smartActionForNode)(node),
            kind: (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: state.patches.has(node.id),
            explicit: state.explicitIds.has(node.id),
            ...(renamed ? { name: effectiveNodeName(node) } : {}),
        }, node.patchCandidate);
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
    patch.title = node.patchCandidate
        ? 'Figma 分片优先：按 Figma 原始边界导入，不能关闭；仍可忽略整个节点'
        : '该节点不是有效的 Figma 分片';
    const patchInput = document.createElement('input');
    patchInput.type = 'checkbox';
    patchInput.dataset.patchFor = node.id;
    patchInput.checked = state.patches.has(node.id);
    patchInput.disabled = true;
    const patchIcon = document.createElement('span');
    patchIcon.textContent = node.patchCandidate
        ? node.sliceMode === 'nine' ? 'Figma 九宫 · 优先启用' : node.sliceMode ? 'Figma 三宫 · 优先启用' : 'Figma 三 / 九宫 · 优先启用'
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
        return (0, import_planner_1.normalizeFigmaSliceDecision)({
            id: node.id,
            action: (_a = state.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action,
            kind: (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: state.patches.has(node.id),
            explicit: state.explicitIds.has(node.id),
            ...(state.renamedIds.has(node.id) ? { name: effectiveNodeName(node) } : {}),
        }, node.patchCandidate);
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
        await waitForBatchListReady();
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
        return (0, import_planner_1.normalizeFigmaSliceDecision)({
            id: node.id, action: (_a = editor.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action, kind: (_b = editor.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind,
            nineSlice: editor.patches.has(node.id), explicit: editor.explicitIds.has(node.id),
            ...(editor.renamedIds.has(node.id) ? { name: (_c = editor.names.get(node.id)) !== null && _c !== void 0 ? _c : node.name } : {}),
        }, node.patchCandidate);
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
        await waitForBatchListReady();
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
        var _a;
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
                const action = safeAction(node, target.value);
                state.explicitIds.add(node.id);
                if (action !== 'render' && !node.patchCandidate) {
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
            // Also reject a stale panel/programmatic attempt to disable a valid
            // Figma definition; the source decision is shared with the importer.
            reconcileActions();
            renderTree();
            if ((_a = findNode(target.dataset.patchFor)) === null || _a === void 0 ? void 0 : _a.patchCandidate)
                showToast('Figma 分片优先，不能关闭；可在导入方式中忽略整个节点。');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQTJGO0FBRTNGLGtEQUEwRDtBQUUxRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCwrREFBeUU7QUFDekUsbUNBVWlCO0FBbUVqQixJQUFJLFNBQVMsR0FBUSxJQUFJLENBQUM7QUFDMUIsSUFBSSxpQkFBaUIsR0FBNkIsSUFBSSxDQUFDO0FBQ3ZELElBQUksUUFBUSxHQUF5QixJQUFJLENBQUM7QUFDMUMsSUFBSSxtQkFBbUIsR0FBd0IsSUFBSSxDQUFDO0FBQ3BELElBQUksaUJBQWlCLEdBQUcsS0FBSyxDQUFDO0FBQzlCLElBQUksVUFBVSxHQUF5QyxJQUFJLENBQUM7QUFDNUQsSUFBSSxzQkFBc0IsR0FBeUMsSUFBSSxDQUFDO0FBQ3hFLElBQUksb0JBQW9CLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUM1RCxJQUFJLHFCQUF5QyxDQUFDO0FBQzlDLElBQUksa0JBQXNDLENBQUM7QUFHM0MsSUFBSSxVQUFVLEdBQXNCLEVBQUUsQ0FBQztBQUN2QyxJQUFJLGFBQWlDLENBQUM7QUFDdEMsSUFBSSxXQUEwQyxDQUFDO0FBQy9DLElBQUksYUFBd0MsQ0FBQztBQUM3QyxJQUFJLGFBQWEsR0FBa0IsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQ3JELElBQUksY0FBdUIsQ0FBQztBQUM1QixJQUFJLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUMvQixJQUFJLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUMvQixJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUM7QUFDeEIsSUFBSSxlQUFlLEdBQXFCLE9BQU8sQ0FBQyxPQUFPLEVB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QU0sQ0FBQyxLQUFLLENBQUM7UUFDdkksV0FBVyxHQUFHLEVBQUUsR0FBRyxNQUFNLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLE1BQU0sRUFBRSxTQUFTLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztRQUNuSyxhQUFhLEdBQUcsU0FBUyxDQUFDO1FBQUMsbUJBQW1CLEdBQUcsSUFBSSxDQUFDO1FBQ3RELE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEVBQUUsV0FBQyxPQUFBLEdBQUcsR0FBRyxDQUFDLE1BQUEsSUFBSSxDQUFDLE9BQU8sbUNBQUksQ0FBQyxDQUFDLENBQUEsRUFBQSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzNFLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLEVBQUUsV0FBQyxPQUFBLEdBQUcsR0FBRyxDQUFDLE1BQUEsSUFBSSxDQUFDLE9BQU8sbUNBQUksQ0FBQyxDQUFDLENBQUEsRUFBQSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzNFLFFBQVEsYUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxRQUFRLENBQUMsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsV0FBQyxPQUFBLE1BQUEsSUFBSSxDQUFDLFFBQVEsbUNBQUksRUFBRSxDQUFBLEVBQUEsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNsRyxTQUFTLENBQUMsV0FBVyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMs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QjtZQUFFLFlBQVksQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO1FBQ2pFLElBQUksa0JBQWtCO1lBQUUsWUFBWSxDQUFDLGtCQUFrQixDQUFDLENBQUM7UUFDekQsVUFBVSxHQUFHLEVBQUUsQ0FBQztRQUFDLGFBQWEsR0FBRyxTQUFTLENBQUM7UUFBQyxXQUFXLEdBQUcsU0FBUyxDQUFDO1FBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQztRQUMvRixrQkFBa0IsR0FBRyxLQUFLLENBQUM7UUFBQyxjQUFjLEdBQUcsU0FBUyxDQUFDO1FBQUMsYUFBYSxHQUFHLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUFDLGVBQWUsRUFBRSxDQUFDO1FBQzdHLGVBQWUsR0FBRyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDcEMsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNyQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi8uLi8uLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdQYW5lbCB9IGZyb20gJy4vaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB7IFBhbmVsV29ya2Zsb3csIHR5cGUgQmF0Y2hXb3JrZmxvd0NvbnRleHQsIHR5cGUgV29ya2Zsb3dSZXN1bHQgfSBmcm9tICcuL3dvcmtmbG93JztcclxuaW1wb3J0IHR5cGUgeyBCYXRjaEZyYW1lSXRlbSwgQmF0Y2hJbXBvcnRJdGVtUmVzdWx0LCBCYXRjaEltcG9ydFJlc3VsdCwgQmF0Y2hQcm9ncmVzcywgQmF0Y2hTb3VyY2VSZXN1bHQsIEJhdGNoU3RhdGUgfSBmcm9tICcuLi8uLi9iYXRjaC10eXBlcyc7XHJcbmltcG9ydCB7IHNhbml0aXplQXNzZXROYW1lIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvYXNzZXRzJztcclxuaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcgfSBmcm9tICcuLi8uLi9pbXBvcnQtcmV2aWV3LW1vZGVsJztcclxuaW1wb3J0IHsgZmluZEZvbnRBc3NldCwgdHlwZSBGb250QXNzZXRPcHRpb24gfSBmcm9tICcuLi8uLi9pbXBvcnRlci9mb250cyc7XHJcbmltcG9ydCB7IG5vcm1hbGl6ZUltcG9ydEFjdGlvbiB9IGZyb20gJy4uLy4uL2ltcG9ydC1hY3Rpb25zJztcclxuaW1wb3J0IHsgc2FuaXRpemVOb2RlTmFtZSB9IGZyb20gJy4uLy4uL25vZGUtbmFtZSc7XHJcbmltcG9ydCB7IG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbiB9IGZyb20gJy4uLy4uL2ZpZ21hL2ltcG9ydC1wbGFubmVyJztcclxuaW1wb3J0IHtcclxuICAgIGFjdGlvbk9wdGlvbnNGb3JOb2RlLFxyXG4gICAgZGVmYXVsdE5pbmVTbGljZUlkcyxcclxuICAgIGVmZmVjdGl2ZUtpbmRGb3JOb2RlLFxyXG4gICAgaXNWZWN0b3JOb2RlVHlwZSxcclxuICAgIGtpbmRPcHRpb25zRm9yQWN0aW9uLFxyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsLFxyXG4gICAgcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMsXHJcbiAgICBzbWFydEFjdGlvbkZvck5vZGUsXHJcbiAgICBzdHJhdGVneVN1bW1hcnlGb3JOb2RlLFxyXG59IGZyb20gJy4vbW9kZWwnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBJbXBvcnRBY3Rpb24sXHJcbiAgICBJbXBvcnRPdmVycmlkZSxcclxuICAgIEltcG9ydFNldHRpbmdzLFxyXG4gICAgTm9kZUtpbmQsXHJcbiAgICBQcm9ncmVzc0V2ZW50LFxyXG4gICAgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuaW50ZXJmYWNlIERvY3VtZW50RHRvIHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIGZpbGVOYW1lOiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHRyZWU6IFRyZWVOb2RlRHRvW107XHJcbiAgICBmb250czogc3RyaW5nW107XHJcbiAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICBub2RlT3ZlcnJpZGVzPzogSW1wb3J0T3ZlcnJpZGVbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFJvdW5kdHJpcERldGVjdER0byB7XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIG1hbmFnZWRSb290czogQXJyYXk8eyBub2RlSWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwcmVmYWJVdWlkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PjtcclxuICAgIHNlbGVjdGVkUm9vdElkPzogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwUHJldmlld0R0byB7XHJcbiAgICBwcmV2aWV3VG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyVG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyUmVxdWlyZWQ6IGJvb2xlYW47XHJcbiAgICBwYWlyRWxpZ2libGU6IGJvb2xlYW47XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIHN1cmZhY2VJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgYXNzZXRVcmw6IHN0cmluZztcclxuICAgIGxlZGdlckdlbmVyYXRpb246IG51bWJlcjtcclxuICAgIGJsb2NrZXJzOiBzdHJpbmdbXTtcclxuICAgIHBsYW46IHtcclxuICAgICAgICBhcHBseTogdW5rbm93bltdO1xyXG4gICAgICAgIHByZXNlcnZlQ29jb3M6IHVua25vd25bXTtcclxuICAgICAgICBjb252ZXJnZWQ6IHVua25vd25bXTtcclxuICAgICAgICBjb25mbGljdHM6IHVua25vd25bXTtcclxuICAgICAgICB1bnN1cHBvcnRlZDogdW5rbm93bltdO1xyXG4gICAgICAgIHJlYWRvbmx5VW5jaGFuZ2VkOiB1bmtub3duW107XHJcbiAgICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGFuZWxTdGF0ZSB7XHJcbiAgICBkb2N1bWVudDogRG9jdW1lbnREdG8gfCBudWxsO1xyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgcHJlZmVycmVkQWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGFjdGlvbnM6IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj47XHJcbiAgICBraW5kczogTWFwPHN0cmluZywgTm9kZUtpbmQ+O1xyXG4gICAgcGF0Y2hlczogU2V0PHN0cmluZz47XHJcbiAgICBleHBsaWNpdElkczogU2V0PHN0cmluZz47XHJcbiAgICBuYW1lczogTWFwPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHJlbmFtZWRJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgZGVmYXVsdHM6IE1hcDxzdHJpbmcsIHsgYWN0aW9uOiBJbXBvcnRBY3Rpb247IGtpbmQ6IE5vZGVLaW5kIH0+O1xyXG4gICAgY29sbGFwc2VkOiBTZXQ8c3RyaW5nPjtcclxuICAgIHN1cHByZXNzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc2VsZWN0ZWRJZD86IHN0cmluZztcclxuICAgIHNlYXJjaDogc3RyaW5nO1xyXG4gICAgYnVzeTogYm9vbGVhbjtcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiBib29sZWFuO1xyXG4gICAgZm9udEFzc2V0czogRm9udEFzc2V0T3B0aW9uW107XHJcbn1cclxuXHJcbmxldCBwYW5lbEhvc3Q6IGFueSA9IG51bGw7XHJcbmxldCBpbXBvcnRSZXZpZXdQYW5lbDogSW1wb3J0UmV2aWV3UGFuZWwgfCBudWxsID0gbnVsbDtcclxubGV0IHdvcmtmbG93OiBQYW5lbFdvcmtmbG93IHwgbnVsbCA9IG51bGw7XHJcbmxldCBwZW5kaW5nSW1wb3J0UmV2aWV3OiBJbXBvcnRSZXZpZXcgfCBudWxsID0gbnVsbDtcclxubGV0IGZvcmNlRG9jdW1lbnRSZWFkID0gZmFsc2U7XHJcbmxldCB0b2FzdFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgaW1wb3J0QnV0dG9uUmVzZXRUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxubGV0IG5vZGVPdmVycmlkZVNhdmVUYXNrOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCByb3VuZHRyaXBQcmV2aWV3VG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcclxubGV0IHJvdW5kdHJpcFBhaXJUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG50eXBlIEZyYW1lRWRpdG9yU3RhdGUgPSBQaWNrPFBhbmVsU3RhdGUsICdkb2N1bWVudCcgfCAncHJlZmVycmVkQWN0aW9ucycgfCAnYWN0aW9ucycgfCAna2luZHMnIHwgJ3BhdGNoZXMnIHwgJ2V4cGxpY2l0SWRzJyB8ICduYW1lcycgfCAncmVuYW1lZElkcycgfCAnZGVmYXVsdHMnIHwgJ2NvbGxhcHNlZCcgfCAnc3VwcHJlc3NlZCcgfCAnc2VsZWN0ZWRJZCcgfCAnc2VhcmNoJz4gJiB7IHRyZWVTY3JvbGw6IG51bWJlcjsgcHJlc2V0Pzogc3RyaW5nIH07XHJcbmludGVyZmFjZSBGcmFtZUVkaXRvckl0ZW0geyBpdGVtOiBCYXRjaEZyYW1lSXRlbTsgZWRpdG9yPzogRnJhbWVFZGl0b3JTdGF0ZTsgY29uZmlndXJlZDogYm9vbGVhbiB9XHJcbmxldCBiYXRjaEl0ZW1zOiBGcmFtZUVkaXRvckl0ZW1bXSA9IFtdO1xyXG5sZXQgYWN0aXZlQmF0Y2hJZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hSZXN1bHQ6IEJhdGNoSW1wb3J0UmVzdWx0IHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hQcm9ncmVzczogQmF0Y2hQcm9ncmVzcyB8IHVuZGVmaW5lZDtcclxubGV0IGJhdGNoU3luY1Rhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IGJhdGNoU3luY0Vycm9yOiB1bmtub3duO1xyXG5sZXQgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7XHJcbmxldCBiYXRjaFN0b3BSZXF1ZXN0ZWQgPSBmYWxzZTtcclxubGV0IHByZXZpZXdSZXZpc2lvbiA9IDA7XHJcbmxldCBwcmV2aWV3UmVhZFRhc2s6IFByb21pc2U8dW5rbm93bj4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IGJhdGNoUmVjb3ZlcnlUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxuXHJcbmNvbnN0IHN0YXRlOiBQYW5lbFN0YXRlID0ge1xyXG4gICAgZG9jdW1lbnQ6IG51bGwsXHJcbiAgICBzZXR0aW5nczoge1xyXG4gICAgICAgIHNvdXJjZVVybDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6ICdmaWdtYS1pbXBvcnRlcicsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXIvcHJlZmFicycsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IFtdLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6ICcnLFxyXG4gICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGZhbHNlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBmYWxzZSxcclxuICAgICAgICBmb250TWFwOiB7fSxcclxuICAgIH0sXHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBhY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgcGF0Y2hlczogbmV3IFNldCgpLFxyXG4gICAgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSxcclxuICAgIG5hbWVzOiBuZXcgTWFwKCksXHJcbiAgICByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICBkZWZhdWx0czogbmV3IE1hcCgpLFxyXG4gICAgY29sbGFwc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzdXBwcmVzc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzZWFyY2g6ICcnLFxyXG4gICAgYnVzeTogZmFsc2UsXHJcbiAgICBydW50aW1lQ29tcGF0aWJsZTogdHJ1ZSxcclxuICAgIGZvbnRBc3NldHM6IFtdLFxyXG59O1xyXG5cclxuZnVuY3Rpb24gc2VsZWN0ZWRGcmFtZXMoKTogRnJhbWVFZGl0b3JJdGVtW10geyByZXR1cm4gYmF0Y2hJdGVtcy5maWx0ZXIoKHsgaXRlbSB9KSA9PiBpdGVtLmVuYWJsZWQpOyB9XHJcblxyXG5mdW5jdGlvbiBlZGl0b3JTbmFwc2hvdCgpOiBGcmFtZUVkaXRvclN0YXRlIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZG9jdW1lbnQ6IHN0YXRlLmRvY3VtZW50LFxyXG4gICAgICAgIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoc3RhdGUucHJlZmVycmVkQWN0aW9ucyksIGFjdGlvbnM6IG5ldyBNYXAoc3RhdGUuYWN0aW9ucyksXHJcbiAgICAgICAga2luZHM6IG5ldyBNYXAoc3RhdGUua2luZHMpLCBwYXRjaGVzOiBuZXcgU2V0KHN0YXRlLnBhdGNoZXMpLCBleHBsaWNpdElkczogbmV3IFNldChzdGF0ZS5leHBsaWNpdElkcyksXHJcbiAgICAgICAgbmFtZXM6IG5ldyBNYXAoc3RhdGUubmFtZXMpLCByZW5hbWVkSWRzOiBuZXcgU2V0KHN0YXRlLnJlbmFtZWRJZHMpLCBkZWZhdWx0czogbmV3IE1hcChzdGF0ZS5kZWZhdWx0cyksXHJcbiAgICAgICAgY29sbGFwc2VkOiBuZXcgU2V0KHN0YXRlLmNvbGxhcHNlZCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoc3RhdGUuc3VwcHJlc3NlZCksXHJcbiAgICAgICAgc2VsZWN0ZWRJZDogc3RhdGUuc2VsZWN0ZWRJZCwgc2VhcmNoOiBzdGF0ZS5zZWFyY2gsIHRyZWVTY3JvbGw6IGVsZW1lbnQoJyN0cmVlJykuc2Nyb2xsVG9wLFxyXG4gICAgICAgIHByZXNldDogQXJyYXkuZnJvbShyb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKSkuZmluZCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LmNvbnRhaW5zKCdhY3RpdmUnKSk/LmRhdGFzZXQucHJlc2V0LFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbEZyYW1lRWRpdG9yKGRvY3VtZW50OiBEb2N1bWVudER0byk6IEZyYW1lRWRpdG9yU3RhdGUge1xyXG4gICAgY29uc3QgZWRpdG9yOiBGcmFtZUVkaXRvclN0YXRlID0ge1xyXG4gICAgICAgIGRvY3VtZW50LCBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksIGFjdGlvbnM6IG5ldyBNYXAoKSwga2luZHM6IG5ldyBNYXAoKSxcclxuICAgICAgICBwYXRjaGVzOiBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpLCBleHBsaWNpdElkczogbmV3IFNldCgpLCBuYW1lczogbmV3IE1hcCgpLCByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgZGVmYXVsdHM6IG5ldyBNYXAoKSwgY29sbGFwc2VkOiBuZXcgU2V0KCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoKSwgc2VsZWN0ZWRJZDogZG9jdW1lbnQudHJlZVswXT8uaWQsXHJcbiAgICAgICAgc2VhcmNoOiAnJywgdHJlZVNjcm9sbDogMCwgcHJlc2V0OiAnc21hcnQnLFxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBhY3Rpb24pOyBlZGl0b3Iua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgZWRpdG9yLmRlZmF1bHRzLnNldChub2RlLmlkLCB7IGFjdGlvbiwga2luZDogbm9kZS5raW5kIH0pOyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IG92ZXJyaWRlIG9mIGRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUob3ZlcnJpZGUuaWQsIGRvY3VtZW50LnRyZWUpOyBpZiAoIW5vZGUpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChuYW1lICYmIG5hbWUgIT09IG5vZGUubmFtZSkgeyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5hbWUpOyBlZGl0b3IucmVuYW1lZElkcy5hZGQobm9kZS5pZCk7IH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQpIHtcclxuICAgICAgICAgICAgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7IGVkaXRvci5raW5kcy5zZXQobm9kZS5pZCwgb3ZlcnJpZGUua2luZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlLnBhdGNoQ2FuZGlkYXRlKSBlZGl0b3IucGF0Y2hlcy5hZGQobm9kZS5pZCk7IGVsc2UgZWRpdG9yLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICBlZGl0b3IuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpOyBlZGl0b3IucHJlc2V0ID0gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGRvY3VtZW50LnRyZWUsIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLCBlZGl0b3IucGF0Y2hlcywgZWRpdG9yLmV4cGxpY2l0SWRzLCBlZGl0b3IucmVuYW1lZElkcyk7XHJcbiAgICBlZGl0b3IuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zOyBlZGl0b3Iuc3VwcHJlc3NlZCA9IGVmZmVjdGl2ZS5zdXBwcmVzc2VkO1xyXG4gICAgcmV0dXJuIGVkaXRvcjtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtZW1iZXJBY3RpdmVGcmFtZSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgaWYgKGFjdGl2ZSkgYWN0aXZlLmVkaXRvciA9IGVkaXRvclNuYXBzaG90KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lTmFtZShlbnRyeTogRnJhbWVFZGl0b3JJdGVtKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGVkaXRvciA9IGVudHJ5Lml0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQgPyBzdGF0ZSA6IGVudHJ5LmVkaXRvcjtcclxuICAgIHJldHVybiBlZGl0b3I/Lm5hbWVzLmdldChlbnRyeS5pdGVtLnJvb3RJZCkgPz8gZW50cnkuaXRlbS5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzPy5maW5kKChvdmVycmlkZSkgPT4gb3ZlcnJpZGUuaWQgPT09IGVudHJ5Lml0ZW0ucm9vdElkKT8ubmFtZSA/PyBlbnRyeS5pdGVtLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQ29uZmxpY3RzKCk6IFNldDxzdHJpbmc+IHtcclxuICAgIGNvbnN0IG5hbWVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBzZWxlY3RlZEZyYW1lcygpKSB7XHJcbiAgICAgICAgY29uc3Qga2V5ID0gc2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKGVudHJ5KSkudG9Mb2NhbGVMb3dlckNhc2UoKTtcclxuICAgICAgICBuYW1lcy5zZXQoa2V5LCBbLi4uKG5hbWVzLmdldChrZXkpID8/IFtdKSwgZW50cnkuaXRlbS5pZF0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5ldyBTZXQoQXJyYXkuZnJvbShuYW1lcy52YWx1ZXMoKSkuZmlsdGVyKChpZHMpID0+IGlkcy5sZW5ndGggPiAxKS5mbGF0KCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaENvbnRleHQoKTogQmF0Y2hXb3JrZmxvd0NvbnRleHQgfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKCFiYXRjaEl0ZW1zLmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGxldCBub2RlcyA9IDA7XHJcbiAgICBsZXQgc2VsZWN0ZWROb2RlcyA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNlbGVjdGVkRnJhbWVzKCkpIHtcclxuICAgICAgICBjb25zdCBlZGl0b3IgPSBlbnRyeS5pdGVtLmlkID09PSBhY3RpdmVCYXRjaElkID8gc3RhdGUgOiBlbnRyeS5lZGl0b3I7XHJcbiAgICAgICAgY29uc3QgYWxsID0gZmxhdHRlbihlbnRyeS5pdGVtLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIG5vZGVzICs9IGFsbC5sZW5ndGg7XHJcbiAgICAgICAgc2VsZWN0ZWROb2RlcyArPSBhbGwuZmlsdGVyKChub2RlKSA9PiAoZWRpdG9yPy5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbikgIT09ICdpZ25vcmUnKS5sZW5ndGg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGNvdW50OiBzZWxlY3RlZEZyYW1lcygpLmxlbmd0aCwgdG90YWw6IGJhdGNoSXRlbXMubGVuZ3RoLCBub2Rlcywgc2VsZWN0ZWROb2RlcyxcclxuICAgICAgICBjb25mbGljdHM6IGJhdGNoQ29uZmxpY3RzKCkuc2l6ZSA+IDAsXHJcbiAgICAgICAgLi4uKGJhdGNoUmVzdWx0ID8geyByZXN1bHQ6IHtcclxuICAgICAgICAgICAgc3VjY2VzczogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIGZhaWxlZDogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCxcclxuICAgICAgICAgICAgcGVuZGluZzogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3BlbmRpbmcnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHN0b3BwZWQ6IGJhdGNoUmVzdWx0LnN0b3BwZWQsXHJcbiAgICAgICAgfSB9IDoge30pLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hGb250cygpOiBzdHJpbmdbXSB7XHJcbiAgICByZXR1cm4gYmF0Y2hJdGVtcy5sZW5ndGggPyBBcnJheS5mcm9tKG5ldyBTZXQoc2VsZWN0ZWRGcmFtZXMoKS5mbGF0TWFwKCh7IGl0ZW0gfSkgPT4gaXRlbS5kb2N1bWVudC5mb250cykpKSA6IHN0YXRlLmRvY3VtZW50Py5mb250cyA/PyBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3luY0JhdGNoSXRlbXMocHJlY2VkaW5nUHJldmlldzogUHJvbWlzZTx1bmtub3duPiA9IHByZXZpZXdSZWFkVGFzayk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgaXRlbXMgPSBiYXRjaEl0ZW1zLm1hcCgoeyBpdGVtIH0pID0+ICh7IGlkOiBpdGVtLmlkLCBlbmFibGVkOiBpdGVtLmVuYWJsZWQgfSkpO1xyXG4gICAgYmF0Y2hTeW5jVGFzayA9IGJhdGNoU3luY1Rhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKS50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBwcmVjZWRpbmdQcmV2aWV3LmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgYXdhaXQgcmVxdWVzdCgnc3luYy1iYXRjaC1pdGVtcycsIGl0ZW1zKTtcclxuICAgICAgICBiYXRjaFN5bmNFcnJvciA9IHVuZGVmaW5lZDtcclxuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGJhdGNoU3luY0Vycm9yID0gZXJyb3I7XHJcbiAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+eVjOmdouWIl+ihqOS/neWtmOWksei0pe+8jOivt+mHjeivleOAgicpLCB0cnVlKTtcclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIGJhdGNoU3luY1Rhc2s7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JCYXRjaExpc3RSZWFkeSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIC8vIFNuYXBzaG90IGJvdGggZGVwZW5kZW5jaWVzIGJlZm9yZSB3YWl0aW5nLiBMYXRlciBwcmV2aWV3cyBtYXkgdGhlbXNlbHZlc1xyXG4gICAgLy8gd2FpdCBmb3IgYSBuZXdseSBxdWV1ZWQgc3luYywgc28gbmV2ZXIgbWFrZSB0aGF0IHN5bmMgZGVwZW5kIG9uIHRoZW0uXHJcbiAgICBjb25zdCBwcmVjZWRpbmdTeW5jID0gYmF0Y2hTeW5jVGFzaztcclxuICAgIGNvbnN0IHByZWNlZGluZ1ByZXZpZXcgPSBwcmV2aWV3UmVhZFRhc2s7XHJcbiAgICBhd2FpdCBwcmVjZWRpbmdTeW5jO1xyXG4gICAgYXdhaXQgcHJlY2VkaW5nUHJldmlldy5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgaWYgKGJhdGNoU3luY0Vycm9yKSB7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNZXNzYWdlID0gZXJyb3JNZXNzYWdlKGJhdGNoU3luY0Vycm9yLCAn55WM6Z2i5YiX6KGo5L+d5a2Y5aSx6LSl77yM6K+36YeN6K+V44CCJyk7XHJcbiAgICAgICAgLy8gQSBmYWlsZWQgc2F2ZSBsZWF2ZXMgdGhlIG9wdGltaXN0aWMgbGlzdCB1bmNvbmZpcm1lZC4gUmV0cnkgaXRzIGxhdGVzdFxyXG4gICAgICAgIC8vIGNvbnRlbnRzIG9uY2U7IG9ubHkgYSBzdWNjZXNzZnVsIGJhY2tlbmQgYWNrbm93bGVkZ2VtZW50IGNsZWFycyBpdC5cclxuICAgICAgICBhd2FpdCBzeW5jQmF0Y2hJdGVtcyhwcmVjZWRpbmdQcmV2aWV3KTtcclxuICAgICAgICBpZiAoYmF0Y2hTeW5jRXJyb3IpIHRocm93IGJhdGNoU3luY0Vycm9yO1xyXG4gICAgICAgIGlmIChlbGVtZW50KCcjd29ya2Zsb3ctZXJyb3ItbWVzc2FnZScpLnRleHRDb250ZW50ID09PSBwcmV2aW91c01lc3NhZ2UpIHdvcmtmbG93Py5jbGVhckVycm9yKCk7XHJcbiAgICAgICAgaWYgKGVsZW1lbnQoJyN0b2FzdCcpLnRleHRDb250ZW50ID09PSBwcmV2aW91c01lc3NhZ2UpIHNob3dUb2FzdCgn55WM6Z2i5YiX6KGo5bey5ZCM5q2l77yM5Y+v5Lul57un57ut44CCJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoRWxlbWVudDxLIGV4dGVuZHMga2V5b2YgSFRNTEVsZW1lbnRUYWdOYW1lTWFwPih0YWc6IEssIHRleHQgPSAnJywgY2xhc3NOYW1lID0gJycpOiBIVE1MRWxlbWVudFRhZ05hbWVNYXBbS10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XHJcbiAgICB2YWx1ZS50ZXh0Q29udGVudCA9IHRleHQ7XHJcbiAgICB2YWx1ZS5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQnV0dG9uKHRleHQ6IHN0cmluZywgYWN0aW9uOiAoKSA9PiB2b2lkLCBjbGFzc05hbWUgPSAndGV4dC1idXR0b24nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gYmF0Y2hFbGVtZW50KCdidXR0b24nLCB0ZXh0LCBjbGFzc05hbWUpO1xyXG4gICAgYnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBidXR0b24ub25jbGljayA9IGFjdGlvbjtcclxuICAgIHJldHVybiBidXR0b247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckJhdGNoKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZW5hYmxlZCA9IGJhdGNoSXRlbXMubGVuZ3RoID4gMDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1zb3VyY2UtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtZnJhbWUtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZCB8fCAoIWJhdGNoUmVzdWx0ICYmICFiYXRjaFByb2dyZXNzKTtcclxuICAgIGNvbnN0IGdlbmVyaWNSZXZpZXcgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5yZXN1bHQtcmV2aWV3Jyk7XHJcbiAgICBpZiAoZ2VuZXJpY1JldmlldykgZ2VuZXJpY1Jldmlldy5oaWRkZW4gPSBlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI3ByZXNldC1zY29wZScpLnRleHRDb250ZW50ID0gZW5hYmxlZCA/ICfku4XkvZznlKjkuo7lvZPliY3nlYzpnaInIDogJ+S9nOeUqOS6juWFqOmDqOiKgueCuSc7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtc2VsZWN0ZWQtY291bnQnKS50ZXh0Q29udGVudCA9IGDlt7LpgIkgJHtzZWxlY3RlZEZyYW1lcygpLmxlbmd0aH0gLyAke2JhdGNoSXRlbXMubGVuZ3RofWA7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXRvZ2dsZS1hbGwnKS50ZXh0Q29udGVudCA9IHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoID09PSBiYXRjaEl0ZW1zLmxlbmd0aCA/ICflj5bmtojlhajpgIknIDogJ+WFqOmAiSc7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2JhdGNoLXNvdXJjZS1saXN0Jyk7XHJcbiAgICBjb25zdCB0YWJzID0gZWxlbWVudCgnI2JhdGNoLWZyYW1lLXRhYnMnKTtcclxuICAgIGNvbnN0IHRhcmdldHMgPSBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7IHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7IHRhcmdldHMucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBjb25mbGljdHMgPSBiYXRjaENvbmZsaWN0cygpO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaEl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgeyBpdGVtIH0gPSBlbnRyeTtcclxuICAgICAgICBjb25zdCByb3cgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCBgYmF0Y2gtaXRlbSR7aXRlbS5lbmFibGVkID8gJycgOiAnIGlzLWRpc2FibGVkJ31gKTtcclxuICAgICAgICBjb25zdCBjaGVja2VkID0gYmF0Y2hFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgICAgIGNoZWNrZWQudHlwZSA9ICdjaGVja2JveCc7IGNoZWNrZWQuY2hlY2tlZCA9IGl0ZW0uZW5hYmxlZDsgY2hlY2tlZC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICAgICAgY2hlY2tlZC5kYXRhc2V0LmJhdGNoQ2hlY2tlZCA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgY2hlY2tlZC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBg5a+85YWlICR7ZnJhbWVOYW1lKGVudHJ5KX1gKTtcclxuICAgICAgICBjaGVja2VkLm9uY2hhbmdlID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgICAgICBpdGVtLmVuYWJsZWQgPSBjaGVja2VkLmNoZWNrZWQ7XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7XHJcbiAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQmF0Y2hJZCA9PT0gaXRlbS5pZCAmJiAhaXRlbS5lbmFibGVkICYmIHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSB2b2lkIGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWRGcmFtZXMoKVswXS5pdGVtLmlkKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IGNvcHkgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1jb3B5Jyk7XHJcbiAgICAgICAgY29uc3QgdGl0bGUgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS10aXRsZScpO1xyXG4gICAgICAgIHRpdGxlLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBmcmFtZU5hbWUoZW50cnkpKSwgYmF0Y2hFbGVtZW50KCdzcGFuJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4nIDogJ+aZuuiDvem7mOiupCcsIGBiYWRnZSR7ZW50cnkuY29uZmlndXJlZCA/ICcnIDogJyBzdWJ0bGUnfWApKTtcclxuICAgICAgICBpZiAoY29uZmxpY3RzLmhhcyhpdGVtLmlkKSkgdGl0bGUuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsICflkI3np7DlhrLnqoEnLCAnYmF0Y2gtc3RhdHVzLWZhaWxlZCcpKTtcclxuICAgICAgICBjb3B5LmFwcGVuZCh0aXRsZSwgYmF0Y2hFbGVtZW50KCdkaXYnLCBgJHtpdGVtLnNlY3Rpb25OYW1lID8gYCR7aXRlbS5zZWN0aW9uTmFtZX0gLyBgIDogJyd9JHtpdGVtLmRvY3VtZW50LmZpbGVOYW1lfSDCtyAke2ZsYXR0ZW4oaXRlbS5kb2N1bWVudC50cmVlKS5sZW5ndGh9IOiKgueCuWAsICdiYXRjaC1pdGVtLW1ldGEnKSk7XHJcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWFjdGlvbnMnKTtcclxuICAgICAgICBjb25zdCBjb25maWd1cmUgPSBiYXRjaEJ1dHRvbign6LCD5pW06IqC54K5JywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIWl0ZW0uZW5hYmxlZCkgeyBpdGVtLmVuYWJsZWQgPSB0cnVlOyBzeW5jQmF0Y2hJdGVtcygpOyB9XHJcbiAgICAgICAgICAgIHZvaWQgYWN0aXZhdGVGcmFtZShpdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25maWd1cmUuZGF0YXNldC5iYXRjaENvbmZpZ3VyZSA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gYmF0Y2hCdXR0b24oJ8OXJywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgICAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICAgICAgICAgIGJhdGNoSXRlbXMgPSBiYXRjaEl0ZW1zLmZpbHRlcigoY2FuZGlkYXRlKSA9PiBjYW5kaWRhdGUuaXRlbS5pZCAhPT0gaXRlbS5pZCk7XHJcbiAgICAgICAgICAgIGxldCBuZXh0SWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGl0ZW0uaWQpIHtcclxuICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGgpIG5leHRJZCA9IHNlbGVjdGVkRnJhbWVzKClbMF0uaXRlbS5pZDtcclxuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSBuZXh0SWQgPSBiYXRjaEl0ZW1zWzBdLml0ZW0uaWQ7XHJcbiAgICAgICAgICAgICAgICBlbHNlIHsgc3RhdGUuZG9jdW1lbnQgPSBudWxsOyByZW5kZXJUcmVlKCk7IHdvcmtmbG93Py5iYXRjaFJlYWR5KCk7IH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBpZiAobmV4dElkKSB2b2lkIGFjdGl2YXRlRnJhbWUobmV4dElkKTtcclxuICAgICAgICAgICAgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICAgICAgfSwgJ2ljb24tYnV0dG9uJyk7XHJcbiAgICAgICAgcmVtb3ZlLmRhdGFzZXQuYmF0Y2hSZW1vdmUgPSBpdGVtLmlkOyByZW1vdmUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYOenu+mZpCAke2ZyYW1lTmFtZShlbnRyeSl9YCk7XHJcbiAgICAgICAgYWN0aW9ucy5hcHBlbmQoY29uZmlndXJlLCByZW1vdmUpOyByb3cuYXBwZW5kKGNoZWNrZWQsIGNvcHksIGFjdGlvbnMpOyBsaXN0LmFwcGVuZChyb3cpO1xyXG4gICAgICAgIGlmICghaXRlbS5lbmFibGVkKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCB0YWIgPSBiYXRjaEJ1dHRvbignJywgKCkgPT4geyB2b2lkIGFjdGl2YXRlRnJhbWUoaXRlbS5pZCk7IH0sICdiYXRjaC1mcmFtZS10YWInKTtcclxuICAgICAgICB0YWIuZGF0YXNldC5iYXRjaEZyYW1lID0gaXRlbS5pZDsgdGFiLnNldEF0dHJpYnV0ZSgncm9sZScsICd0YWInKTsgdGFiLnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsIFN0cmluZyhhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkKSk7XHJcbiAgICAgICAgdGFiLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3N0cm9uZycsIGZyYW1lTmFtZShlbnRyeSkpLCBiYXRjaEVsZW1lbnQoJ3NtYWxsJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4gwrcg6Ieq5Yqo5L+d55WZJyA6ICfmmbrog73pu5jorqQnKSk7XHJcbiAgICAgICAgdGFicy5hcHBlbmQodGFiKTtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBiYXRjaEVsZW1lbnQoJ2xhYmVsJywgJycsIGBiYXRjaC10YXJnZXQtcm93JHtjb25mbGljdHMuaGFzKGl0ZW0uaWQpID8gJyBpcy1jb25mbGljdCcgOiAnJ31gKTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsIGl0ZW0ubmFtZSkpO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBiYXRjaEVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICAgICAgbmFtZS50eXBlID0gJ3RleHQnOyBuYW1lLnZhbHVlID0gZnJhbWVOYW1lKGVudHJ5KTsgbmFtZS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7IG5hbWUuZGF0YXNldC5iYXRjaE5hbWUgPSBpdGVtLmlkO1xyXG4gICAgICAgIG5hbWUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7aXRlbS5uYW1lfSDnmoQgUHJlZmFiIOWQjeensGApO1xyXG4gICAgICAgIG5hbWUudGl0bGUgPSBgYXNzZXRzLyR7ZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZX0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUoZW50cnkpKX0ucHJlZmFiYDtcclxuICAgICAgICBuYW1lLm9uY2hhbmdlID0gKCkgPT4geyB2b2lkIHJlbmFtZUZyYW1lKGVudHJ5LCBuYW1lLnZhbHVlKTsgfTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKG5hbWUpOyB0YXJnZXRzLmFwcGVuZCh0YXJnZXQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtYWN0aXZlLW5hbWUnKS50ZXh0Q29udGVudCA9IGFjdGl2ZSA/IGDmraPlnKjosIPmlbTvvJoke2ZyYW1lTmFtZShhY3RpdmUpfWAgOiAn6YCJ5oup5LiA5Liq55WM6Z2i5byA5aeL6LCD5pW0JztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1hY3RpdmUtc3RhdHVzJykudGV4dENvbnRlbnQgPSBhY3RpdmU/LmNvbmZpZ3VyZWQgPyAn5L+u5pS55bey5L+d55WZJyA6ICfmsr/nlKjmmbrog73pu5jorqQnO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWNvbmZsaWN0cycpLmhpZGRlbiA9IGNvbmZsaWN0cy5zaXplID09PSAwO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWNvbmZsaWN0cycpLnRleHRDb250ZW50ID0gYOaciSAke2NvbmZsaWN0cy5zaXplfSDkuKrnlYzpnaLnmoQgUHJlZmFiIOaWh+S7tuWQjemHjeWkje+8iOW/veeVpeWkp+Wwj+WGme+8ieOAguivt+aUueWQjeWQjuW8gOWni+WvvOWFpeOAgmA7XHJcbiAgICByZW5kZXJCYXRjaFJlc3VsdHMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyQmF0Y2hSZXN1bHRzKCk6IHZvaWQge1xyXG4gICAgY29uc3Qgcm93cyA9IGJhdGNoUHJvZ3Jlc3M/Lml0ZW1zID8/IGJhdGNoUmVzdWx0Py5pdGVtcyA/PyBbXTtcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LWxpc3QnKTsgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGZvciAoY29uc3QgaXRlbSBvZiByb3dzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0nKTtcclxuICAgICAgICBjb25zdCBjb3B5ID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tY29weScpO1xyXG4gICAgICAgIGNvcHkuYXBwZW5kKGJhdGNoRWxlbWVudCgnZGl2JywgaXRlbS5uYW1lLCAnYmF0Y2gtaXRlbS10aXRsZScpLCBiYXRjaEVsZW1lbnQoJ2RpdicsIGl0ZW0uZXJyb3IgPz8gaXRlbS5wcmVmYWJVcmwgPz8gaXRlbS53YXJuaW5ncz8uam9pbign77ybJykgPz8gKGl0ZW0uc3RhdHVzID09PSAncGVuZGluZycgPyAn562J5b6F57un57ut5a+85YWlJyA6ICcnKSwgJ2JhdGNoLWl0ZW0tbWV0YScpKTtcclxuICAgICAgICBjb25zdCBzdGF0dXMgPSB7IHBlbmRpbmc6ICfmnKrlrozmiJAnLCBydW5uaW5nOiAn5q2j5Zyo5a+85YWlJywgc3VjY2VzczogJ+W3suWujOaIkCcsIGZhaWxlZDogJ+Wksei0pScgfVtpdGVtLnN0YXR1c107XHJcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWFjdGlvbnMnKTtcclxuICAgICAgICBhY3Rpb25zLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBzdGF0dXMsIGBiYXRjaC1zdGF0dXMtJHtpdGVtLnN0YXR1c31gKSk7XHJcbiAgICAgICAgaWYgKGl0ZW0ucmV2aWV3SWQgfHwgaXRlbS5yZXZpZXcpIHtcclxuICAgICAgICAgICAgY29uc3QgcmV2aWV3ID0gYmF0Y2hCdXR0b24oJ+ajgOafpee7k+aenCcsICgpID0+IHsgdm9pZCBvcGVuQmF0Y2hSZXZpZXcoaXRlbSk7IH0pO1xyXG4gICAgICAgICAgICByZXZpZXcuZGF0YXNldC5iYXRjaFJldmlldyA9IGl0ZW0uaWQ7IGFjdGlvbnMuYXBwZW5kKHJldmlldyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJvdy5hcHBlbmQoY29weSwgYWN0aW9ucyk7IGxpc3QuYXBwZW5kKHJvdyk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBzdWNjZXNzID0gcm93cy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aDtcclxuICAgIGNvbnN0IGZhaWxlZCA9IHJvd3MuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aDtcclxuICAgIGNvbnN0IHBlbmRpbmcgPSByb3dzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdwZW5kaW5nJykubGVuZ3RoO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1jb3VudCcpLnRleHRDb250ZW50ID0gYCR7c3VjY2Vzc30gLyAke3Jvd3MubGVuZ3RofSDlt7LlrozmiJBgO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNiYXRjaC1yZXRyeS1mYWlsZWQnKS5oaWRkZW4gPSAhZmFpbGVkIHx8IHN0YXRlLmJ1c3k7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXJlc3VtZS1wZW5kaW5nJykuaGlkZGVuID0gIXBlbmRpbmcgfHwgc3RhdGUuYnVzeTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtbm90ZScpLnRleHRDb250ZW50ID0gcm93cy5zb21lKChpdGVtKSA9PiBpdGVtLnJlcXVpcmVzQXR0ZW50aW9uKVxyXG4gICAgICAgID8gJ+mDqOWIhumhueeahOS/neWtmOeKtuaAgemcgOimgeajgOafpeOAguivt+WFiOWcqCBDb2NvcyDnoa7orqTlvZPliY3nm67moIfkuI7kv53lrZjnirbmgIHvvIzlho3ph43or5XmiJbnu6fnu63jgIInXHJcbiAgICAgICAgOiAn54K55Ye75q+P5LiA6aG555qE4oCc5qOA5p+l57uT5p6c4oCd5p+l55yL5a+55bqU5oql5ZGK77yb6YeN6K+V5ZKM57un57ut5Lya6Lez6L+H5bey5a6M5oiQ6aG544CCJztcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkJhdGNoUmV2aWV3KGl0ZW06IEJhdGNoSW1wb3J0SXRlbVJlc3VsdCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3SWQgPSBpdGVtLnJldmlld0lkID8/IGl0ZW0ucmV2aWV3Py5pZDtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSByZXZpZXdJZCA/IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3JywgcmV2aWV3SWQpIDogbnVsbDtcclxuICAgICAgICBpZiAoIXJldmlldykgdGhyb3cgbmV3IEVycm9yKCfor6Xpobnmo4Dmn6XmiqXlkYrlt7Lov4fmnJ/vvIzor7fph43mlrDlr7zlhaXlkI7mn6XnnIvjgIInKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluajgOafpee7k+aenOWksei0peOAgicpLCB0cnVlKTsgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBhY3RpdmF0ZUZyYW1lKGlkOiBzdHJpbmcsIG5hdmlnYXRlID0gZmFsc2UpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBjb25zdCBlbnRyeSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGlkKTtcclxuICAgIGlmICghZW50cnkpIHJldHVybjtcclxuICAgIGNvbnN0IGFscmVhZHlBY3RpdmUgPSBhY3RpdmVCYXRjaElkID09PSBpZCAmJiBzdGF0ZS5kb2N1bWVudDtcclxuICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgIGNvbnN0IG9sZElkID0gYWN0aXZlQmF0Y2hJZDtcclxuICAgIGNvbnN0IG9sZEVkaXRvciA9IGVkaXRvclNuYXBzaG90KCk7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7IGlmIChzZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHByZXZpZXdSZXZpc2lvbisrO1xyXG4gICAgc2V0QnVzeSh0cnVlKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvckJhdGNoTGlzdFJlYWR5KCk7XHJcbiAgICAgICAgY29uc3QgbG9hZGVkID0gYWxyZWFkeUFjdGl2ZSA/IHN0YXRlLmRvY3VtZW50IDogYXdhaXQgcmVxdWVzdDxEb2N1bWVudER0bz4oJ2FjdGl2YXRlLWJhdGNoLWl0ZW0nLCBpZCk7XHJcbiAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IGlkO1xyXG4gICAgICAgIGlmIChlbnRyeS5lZGl0b3IpIE9iamVjdC5hc3NpZ24oc3RhdGUsIGVudHJ5LmVkaXRvcik7XHJcbiAgICAgICAgZWxzZSBpbml0aWFsaXplRG9jdW1lbnQobG9hZGVkID8/IGVudHJ5Lml0ZW0uZG9jdW1lbnQsIGZhbHNlKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS52YWx1ZSA9IHN0YXRlLnNlYXJjaDtcclxuICAgICAgICBlbGVtZW50KCcjZmlsZS1uYW1lJykudGV4dENvbnRlbnQgPSBzdGF0ZS5kb2N1bWVudD8uZmlsZU5hbWUgPz8gJyc7XHJcbiAgICAgICAgZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKS5jbGFzc0xpc3QucmVtb3ZlKCdoYXMtaW1hZ2UnLCAnaXMtbG9hZGluZycpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNwcmV2aWV3LWltYWdlJykucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgICAgICBlbGVtZW50KCcjcHJldmlldy1tZXRhJykudGV4dENvbnRlbnQgPSAn6YCJ5oup6IqC54K55p+l55yL6aKE6KeIJztcclxuICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgZWxlbWVudCgnI3RyZWUnKS5zY3JvbGxUb3AgPSBlbnRyeS5lZGl0b3I/LnRyZWVTY3JvbGwgPz8gMDtcclxuICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IChlbnRyeS5lZGl0b3I/LnByZXNldCA/PyAnc21hcnQnKSkpO1xyXG4gICAgICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IG9sZElkOyBPYmplY3QuYXNzaWduKHN0YXRlLCBvbGRFZGl0b3IpO1xyXG4gICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfliIfmjaLnlYzpnaLlpLHotKXvvIzor7fph43or5XjgIInKSwgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpOyByZW5kZXJCYXRjaCgpOyB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICAgICAgaWYgKG5hdmlnYXRlICYmIGFjdGl2ZUJhdGNoSWQgPT09IGlkKSB3b3JrZmxvdz8ubmF2aWdhdGUoMik7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGlkICYmIHdvcmtmbG93Py5zdGVwID09PSAyICYmIHN0YXRlLnNlbGVjdGVkSWQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKTsgaWYgKHNlbGVjdGVkKSB2b2lkIHByZXZpZXcoc2VsZWN0ZWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVuYW1lRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSwgdmFsdWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHZhbHVlKTtcclxuICAgIGlmICghbmFtZSkgeyBzaG93VG9hc3QoJ1ByZWZhYiDlkI3np7DkuI3og73kuLrnqbrjgIInLCB0cnVlKTsgcmVuZGVyQmF0Y2goKTsgcmV0dXJuOyB9XHJcbiAgICBhd2FpdCBhY3RpdmF0ZUZyYW1lKGVudHJ5Lml0ZW0uaWQpO1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoSWQgIT09IGVudHJ5Lml0ZW0uaWQpIHJldHVybjtcclxuICAgIHN0YXRlLm5hbWVzLnNldChlbnRyeS5pdGVtLnJvb3RJZCwgbmFtZSk7XHJcbiAgICBpZiAobmFtZSA9PT0gZW50cnkuaXRlbS5uYW1lKSBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShlbnRyeS5pdGVtLnJvb3RJZCk7IGVsc2Ugc3RhdGUucmVuYW1lZElkcy5hZGQoZW50cnkuaXRlbS5yb290SWQpO1xyXG4gICAgZW50cnkuY29uZmlndXJlZCA9IHRydWU7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOyByZW1lbWJlckFjdGl2ZUZyYW1lKCk7IHJlbmRlclRyZWUoKTsgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByb290KCk6IEhUTUxFbGVtZW50IHtcclxuICAgIHJldHVybiBwYW5lbEhvc3QuJC5hcHAgYXMgSFRNTEVsZW1lbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVsZW1lbnQ8VCBleHRlbmRzIEhUTUxFbGVtZW50PihzZWxlY3Rvcjogc3RyaW5nKTogVCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPFQ+KHNlbGVjdG9yKTtcclxuICAgIGlmICghdmFsdWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBhbmVsIGVsZW1lbnQgbm90IGZvdW5kOiAke3NlbGVjdG9yfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0PFQ+KG1lc3NhZ2U6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKTogUHJvbWlzZTxUPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChwYWNrYWdlSlNPTi5uYW1lLCBtZXNzYWdlLCAuLi5hcmdzKSBhcyBUO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaG93VG9hc3QobWVzc2FnZTogc3RyaW5nLCBlcnJvciA9IGZhbHNlKTogdm9pZCB7XHJcbiAgICBjb25zdCB0b2FzdCA9IGVsZW1lbnQ8SFRNTERpdkVsZW1lbnQ+KCcjdG9hc3QnKTtcclxuICAgIHRvYXN0LnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgZXJyb3IpO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LmFkZCgnc2hvdycpO1xyXG4gICAgY29uc3QgY3JlZGVudGlhbERpYWxvZyA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPEhUTUxEaWFsb2dFbGVtZW50PignI2NyZWRlbnRpYWwtZGlhbG9nJyk7XHJcbiAgICBjb25zdCBjcmVkZW50aWFsU3RhdHVzID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcjY3JlZGVudGlhbC1zdGF0dXMnKTtcclxuICAgIGlmIChjcmVkZW50aWFsRGlhbG9nPy5vcGVuICYmIGNyZWRlbnRpYWxTdGF0dXMpIHtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLmhpZGRlbiA9IGZhbHNlO1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB9XHJcbiAgICBpZiAodG9hc3RUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgIH1cclxuICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKSwgMzQwMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93biwgZmFsbGJhY2s6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5tZXNzYWdlKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIGVycm9yID09PSAnc3RyaW5nJyAmJiBlcnJvci50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3I7XHJcbiAgICB9XHJcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0JyAmJiAnbWVzc2FnZScgaW4gZXJyb3JcclxuICAgICAgICAmJiB0eXBlb2YgKGVycm9yIGFzIHsgbWVzc2FnZT86IHVua25vd24gfSkubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICByZXR1cm4gKGVycm9yIGFzIHsgbWVzc2FnZTogc3RyaW5nIH0pLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsbGJhY2s7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldENvbm5lY3Rpb24odmF1bHQ6IHtcclxuICAgIGhhc1Rva2VuOiBib29sZWFuO1xyXG4gICAgcGVyc2lzdGVudDogYm9vbGVhbjtcclxuICAgIGJhY2tlbmQ6IHN0cmluZztcclxuICAgIHdhcm5pbmc/OiBzdHJpbmc7XHJcbn0pOiB2b2lkIHtcclxuICAgIGNvbnN0IHBpbGwgPSBlbGVtZW50KCcjY29ubmVjdGlvbi1waWxsJyk7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9ubGluZScsIHZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb2ZmbGluZScsICF2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBlbGVtZW50KCcjY29ubmVjdGlvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gdmF1bHQuaGFzVG9rZW4gPyAn5Yet5o2u5bCx57uqJyA6ICfmnKrov57mjqUnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LWJhZGdlJykudGV4dENvbnRlbnQgPSB2YXVsdC5wZXJzaXN0ZW50ID8gJ+ezu+e7n+WKoOWvhicgOiAn5Lya6K+d5a2Y5YKoJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1ub3RlJykudGV4dENvbnRlbnQgPSB2YXVsdC53YXJuaW5nXHJcbiAgICAgICAgPz8gKHZhdWx0LnBlcnNpc3RlbnQgPyBg55SxICR7dmF1bHQuYmFja2VuZH0g5Yqg5a+G77yM6aG555uu5Lit5LuF5L+d5a2Y6Z2e5pWP5oSf6K6+572uYCA6ICdUb2tlbiDkuI3lhpnlhaXpobnnm67mlofku7YnKTtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2NsZWFyLXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgd29ya2Zsb3c/LnNldENvbm5lY3Rpb24odmF1bHQuaGFzVG9rZW4pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuKG5vZGVzOiBUcmVlTm9kZUR0b1tdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZXMuZmxhdE1hcCgobm9kZSkgPT4gW25vZGUsIC4uLmZsYXR0ZW4obm9kZS5jaGlsZHJlbildKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZE5vZGUoaWQ6IHN0cmluZywgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSk6IFRyZWVOb2RlRHRvIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgIGlmIChub2RlLmlkID09PSBpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBmaW5kTm9kZShpZCwgbm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgaWYgKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJGb250TWFwKCk6IHZvaWQge1xyXG4gICAgY29uc3QgbGlzdCA9IGVsZW1lbnQoJyNmb250LW1hcC1saXN0Jyk7XHJcbiAgICBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3QgZmFtaWxpZXMgPSBiYXRjaEZvbnRzKCk7XHJcbiAgICBpZiAoIWZhbWlsaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5JztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg5ZCO77yM6L+Z6YeM5Lya5YiX5Ye65qOA5rWL5Yiw55qE5a2X5L2T44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmZvbnRBc3NldHMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHkgaXMtd2FybmluZyc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6aG555uuIGFzc2V0cyDlhoXmsqHmnInmo4DmtYvliLAgLnR0ZiAvIC5vdGYgLyAuZm50IC8gLndvZmYg5a2X5L2T6LWE5rqQ44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIGZhbWlsaWVzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1yb3cnO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBzb3VyY2UuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNvdXJjZSc7XHJcbiAgICAgICAgc291cmNlLnRleHRDb250ZW50ID0gZmFtaWx5O1xyXG4gICAgICAgIHNvdXJjZS50aXRsZSA9IGZhbWlseTtcclxuICAgICAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBhcnJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtYXJyb3cnO1xyXG4gICAgICAgIGFycm93LnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICAgICAgc2VsZWN0LmNsYXNzTmFtZSA9ICdmb250LW1hcC1zZWxlY3QnO1xyXG4gICAgICAgIHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHkgPSBmYW1pbHk7XHJcbiAgICAgICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke2ZhbWlseX0g5pig5bCE5a2X5L2TYCk7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbignJywgJ+S4jeaYoOWwhO+8iOS9v+eUqOm7mOiupOWtl+S9k++8iScpKTtcclxuICAgICAgICBjb25zdCBhdXRvbWF0aWMgPSBmaW5kRm9udEFzc2V0KGZhbWlseSwgc3RhdGUuZm9udEFzc2V0cyk7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS5zZXR0aW5ncy5mb250TWFwW2ZhbWlseV0gPz8gYXV0b21hdGljPy51cmwgPz8gJyc7XHJcbiAgICAgICAgZm9yIChjb25zdCBhc3NldCBvZiBzdGF0ZS5mb250QXNzZXRzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSBvcHRpb24oYXNzZXQudXJsLCBgJHthc3NldC5uYW1lfSDCtyAke2Fzc2V0LnJlbGF0aXZlUGF0aH1gKTtcclxuICAgICAgICAgICAgaXRlbS5zZWxlY3RlZCA9IGFzc2V0LnVybCA9PT0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChpdGVtKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgcm93LmFwcGVuZChzb3VyY2UsIGFycm93LCBzZWxlY3QpO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZUFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiB1bmtub3duKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIHJldHVybiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oeyBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihhY3Rpb24pLCBraW5kOiBub2RlLmtpbmQsIG5pbmVTbGljZTogZmFsc2UgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSkuYWN0aW9uO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbml0aWFsaXplRG9jdW1lbnQoZG9jdW1lbnQ6IERvY3VtZW50RHRvLCBuYXZpZ2F0ZSA9IHRydWUpOiB2b2lkIHtcclxuICAgIHN0YXRlLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5raW5kcy5jbGVhcigpO1xyXG4gICAgc3RhdGUucGF0Y2hlcy5jbGVhcigpO1xyXG4gICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLm5hbWVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5yZW5hbWVkSWRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5kZWZhdWx0cy5jbGVhcigpO1xyXG4gICAgc3RhdGUuY29sbGFwc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gZG9jdW1lbnQudHJlZVswXT8uaWQ7XHJcbiAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7XHJcbiAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgc3RhdGUuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7XHJcbiAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKTtcclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAoY3VzdG9tTmFtZSAmJiBjdXN0b21OYW1lICE9PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0ID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUucGF0Y2hDYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKFxyXG4gICAgICAgICAgICAnYWN0aXZlJyxcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuc2l6ZSA9PT0gMCAmJiBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09ICdzbWFydCcsXHJcbiAgICAgICAgKTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2ZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gZG9jdW1lbnQuc291cmNlVXJsO1xyXG4gICAgZWxlbWVudCgnI2ZvbnQtaGludCcpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZm9udHMubGVuZ3RoXHJcbiAgICAgICAgPyBg5qOA5rWL5Yiw77yaJHtkb2N1bWVudC5mb250cy5qb2luKCfjgIEnKX1gXHJcbiAgICAgICAgOiAn5b2T5YmN5paH5Lu25bCa5pyq5Y+R546w5a2X5L2T44CCJztcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIHJlbmRlclRyZWUodHJ1ZSk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBpZiAobmF2aWdhdGUpIHdvcmtmbG93Py5kb2N1bWVudFJlYWR5KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5U2V0dGluZ3Moc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IHNldHRpbmdzLnNvdXJjZVVybDtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZSA9IHNldHRpbmdzLmFzc2V0Rm9sZGVyO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZSA9IHNldHRpbmdzLnByZWZhYkZvbGRlcjtcclxuICAgIGNvbnN0IGxvY2FsUmVzb3VyY2VGb2xkZXJzID0gc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnM/Lmxlbmd0aFxyXG4gICAgICAgID8gc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcnNcclxuICAgICAgICA6IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJcclxuICAgICAgICAgICAgPyBbc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlcl1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgaW5wdXQudmFsdWUgPSBsb2NhbFJlc291cmNlRm9sZGVyc1tpbmRleF0gPz8gJyc7XHJcbiAgICAgICAgaW5wdXQudGl0bGUgPSBsb2NhbFJlc291cmNlRm9sZGVyc1tpbmRleF0gPz8gJyc7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSA9IFN0cmluZyhzZXR0aW5ncy5zY2FsZSk7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdXBkYXRlLWV4aXN0aW5nJykuY2hlY2tlZCA9IHNldHRpbmdzLnVwZGF0ZUV4aXN0aW5nO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCA9IHNldHRpbmdzLnJlZnJlc2hBc3NldHM7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXV0by1zYXZlJykuY2hlY2tlZCA9IHNldHRpbmdzLmF1dG9TYXZlO1xyXG4gICAgdXBkYXRlVGFyZ2V0SGludCgpO1xyXG4gICAgcmVuZGVyRm9udE1hcCgpO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWFkU2V0dGluZ3Moc2hvd0Vycm9yID0gdHJ1ZSk6IEltcG9ydFNldHRpbmdzIHwgbnVsbCB7XHJcbiAgICBjb25zdCBmb250TWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi5zdGF0ZS5zZXR0aW5ncy5mb250TWFwIH07XHJcbiAgICBmb3IgKGNvbnN0IGZhbWlseSBvZiBiYXRjaEZvbnRzKCkpIGRlbGV0ZSBmb250TWFwW2ZhbWlseV07XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoZmFtaWx5ICYmIHNlbGVjdC52YWx1ZSkge1xyXG4gICAgICAgICAgICBmb250TWFwW2ZhbWlseV0gPSBzZWxlY3QudmFsdWU7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzY2FsZSA9IE51bWJlcihlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPCAwLjI1IHx8IHNjYWxlID4gNCkge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCflr7zlhaXlgI3njoflv4XpobvlnKggMC4yNSDliLAgNCDkuYvpl7TjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhc3NldEZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWFzc2V0Rm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemhueebriBhc3NldHMg5LiL55qE6LWE5rqQ6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJlZmFiRm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXByZWZhYkZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npooTliLbkvZPovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzIH0sIChfLCBpbmRleCkgPT5cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICApLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNsb2NhbC1yZXNvdXJjZS1mb2xkZXItMCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCxcclxuICAgICAgICBhdXRvU2F2ZTogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEJ1c3kodmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIHZhbHVlID0gdmFsdWUgfHwgQm9vbGVhbih3b3JrZmxvdz8ucGVuZGluZyk7XHJcbiAgICBzdGF0ZS5idXN5ID0gdmFsdWU7XHJcbiAgICAvLyBDYXB0dXJlIGVkaXRhYmxlIGNvbnRyb2wgc3RhdGVzIGJlZm9yZSB0aGUgZXhpc3RpbmcgYnV0dG9uIGxvY2sgY2hhbmdlcyB0aGVtLlxyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3NhdmUtdG9rZW4nKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLWFzc2V0LWZvbGRlcicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stcHJlZmFiLWZvbGRlcicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1kZXRlY3QnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcHJldmlldycpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PihgI3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PihgI2NsZWFyLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgIXN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5jbGFzc0xpc3QudG9nZ2xlKCdpcy1oaWRkZW4nLCAhdmFsdWUpO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgaWYgKCF2YWx1ZSkgcmVuZGVyTm9kZVByb3BlcnRpZXMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvdW5kdHJpcFNvdXJjZSgpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSDmlofku7bmiJboioLngrnpk77mjqXjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBzb3VyY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclJvdW5kdHJpcFByZXZpZXcocHJldmlldzogUm91bmR0cmlwUHJldmlld0R0byk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gcHJldmlldy5wcmV2aWV3VG9rZW47XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSBwcmV2aWV3LnBhaXJUb2tlbjtcclxuICAgIGNvbnN0IGxpbmVzID0gW1xyXG4gICAgICAgIGDnm67moIfvvJoke3ByZXZpZXcuYXNzZXRVcmx9YCxcclxuICAgICAgICBgUHJlZmFi77yaJHtwcmV2aWV3LnByZWZhYlV1aWR9YCxcclxuICAgICAgICBgU3VyZmFjZe+8miR7cHJldmlldy5zdXJmYWNlSWR9IMK3IEZpZ21hICR7cHJldmlldy5maWdtYVZlcnNpb259IMK3IExlZGdlciAke3ByZXZpZXcubGVkZ2VyR2VuZXJhdGlvbn1gLFxyXG4gICAgICAgIGDlsIbkv67mlLkgJHtwcmV2aWV3LnBsYW4uYXBwbHkubGVuZ3RofSDpobkgwrcg5L+d55WZIENvY29zICR7cHJldmlldy5wbGFuLnByZXNlcnZlQ29jb3MubGVuZ3RofSDpobkgwrcg5bey5pS25pWbICR7cHJldmlldy5wbGFuLmNvbnZlcmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgYOWGsueqgSAke3ByZXZpZXcucGxhbi5jb25mbGljdHMubGVuZ3RofSDpobkgwrcg5LiN5pSv5oyBICR7cHJldmlldy5wbGFuLnVuc3VwcG9ydGVkLmxlbmd0aH0g6aG5IMK3IOWPquivu+acquaUuSAke3ByZXZpZXcucGxhbi5yZWFkb25seVVuY2hhbmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgcHJldmlldy5wYWlyUmVxdWlyZWRcclxuICAgICAgICAgICAgPyBwcmV2aWV3LnBhaXJFbGlnaWJsZSA/ICfpppbmrKHkvb/nlKjvvJror4Hmja7kuIDoh7TvvIzor7flhYjnoa7orqTphY3lr7kgU3VyZmFjZe+8iOWPquWGmSBsZWRnZXLvvIzkuI3mlLkgUHJlZmFi77yJ44CCJyA6ICfpppbmrKHkvb/nlKjvvJpQYWlyIOivgeaNruS4jeS4gOiHtO+8jOmcgOS7juW9k+WJjSBQcmVmYWIg6YeN5paw5a+85Ye644CCJ1xyXG4gICAgICAgICAgICA6IHByZXZpZXcuYmxvY2tlcnMubGVuZ3RoID8gYOmYu+aWre+8miR7cHJldmlldy5ibG9ja2Vycy5qb2luKCcsICcpfWAgOiAn6aKE6KeI6YCa6L+H77yM5Y+v5Y6f5a2Q5bqU55So5pW05Liq5LiN5Y+v5Y+Y6K6h5YiS44CCJyxcclxuICAgIF07XHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVUYXJnZXRIaW50KCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOmcgOimgeWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9yJztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlvZPliY3lnLrmma8gQ2FudmFzIOagueiKgueCueS4i++8m0ZyYW1lIOmTvuaOpeWwhuiHquWKqOWIm+W7uuW5tuaJk+W8gOmihOWItuS9kyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0SW1wb3J0QnV0dG9uKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgIGJ1dHRvbi50aXRsZSA9ICflr7zlhaXliLDlvZPliY3miZPlvIDlnLrmma/miJbpooTliLbkvZMnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflvIDlp4vlr7zlhaUnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMCUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbXBvcnRQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuMDUgKyB2YWx1ZSAqIDAuNTU7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdzY2VuZScpIHtcclxuICAgICAgICByZXR1cm4gMC42ICsgdmFsdWUgKiAwLjM4O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGV2ZW50LnBoYXNlID09PSAnZG9uZScgPyAxIDogMDtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIGlmIChldmVudC5iYXRjaCAmJiBiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgIGJhdGNoUHJvZ3Jlc3MgPSBldmVudC5iYXRjaDtcclxuICAgICAgICBjb25zdCBjdXJyZW50Um93ID0gZXZlbnQuYmF0Y2guaXRlbXMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gZXZlbnQuYmF0Y2ghLml0ZW1JZCk7XHJcbiAgICAgICAgY29uc3QgY3VycmVudCA9IGN1cnJlbnRSb3c/LnN0YXR1cyA9PT0gJ3J1bm5pbmcnID8gaW1wb3J0UHJvZ3Jlc3MoZXZlbnQpIDogMDtcclxuICAgICAgICBldmVudCA9IHtcclxuICAgICAgICAgICAgLi4uZXZlbnQsXHJcbiAgICAgICAgICAgIHZhbHVlOiBNYXRoLm1pbigxLCAoZXZlbnQuYmF0Y2guY29tcGxldGVkICsgY3VycmVudCkgLyBNYXRoLm1heCgxLCBldmVudC5iYXRjaC50b3RhbCkpLFxyXG4gICAgICAgICAgICBtZXNzYWdlOiBgJHtldmVudC5iYXRjaC5pbmRleH0gLyAke2V2ZW50LmJhdGNoLnRvdGFsfSDCtyAke2V2ZW50LmJhdGNoLm5hbWV9IMK3ICR7ZXZlbnQubWVzc2FnZX1gLFxyXG4gICAgICAgIH07XHJcbiAgICAgICAgcmVuZGVyQmF0Y2hSZXN1bHRzKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSkpIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB3b3JrZmxvdz8ucHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgY29uc3QgcmVnaW9uID0gZWxlbWVudCgnI3Byb2dyZXNzLXJlZ2lvbicpO1xyXG4gICAgY29uc3QgYnVzeSA9IFsnZmV0Y2gnLCAnYXNzZXRzJywgJ3NjZW5lJ10uaW5jbHVkZXMoZXZlbnQucGhhc2UpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWJ1c3knLCBidXN5KTtcclxuICAgIHJlZ2lvbi5jbGFzc0xpc3QudG9nZ2xlKCdpcy1lcnJvcicsIGV2ZW50LnBoYXNlID09PSAnZXJyb3InKTtcclxuICAgIGVsZW1lbnQoJyNwcm9ncmVzcy1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQubWVzc2FnZTtcclxuICAgIGNvbnN0IHZhbHVlID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgZXZlbnQudmFsdWUpKTtcclxuICAgIGVsZW1lbnQoJyNwcm9ncmVzcy1wZXJjZW50JykudGV4dENvbnRlbnQgPSBgJHtNYXRoLnJvdW5kKHZhbHVlICogMTAwKX0lYDtcclxuICAgIChlbGVtZW50KCcjcHJvZ3Jlc3MtYmFyJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gYCR7dmFsdWUgKiAxMDB9JWA7XHJcbiAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgIGNvbnN0IGltcG9ydGluZyA9IGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJyB8fCBldmVudC5waGFzZSA9PT0gJ3NjZW5lJztcclxuICAgIGlmIChpbXBvcnRCdXR0b25SZXNldFRpbWVyKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KGltcG9ydEJ1dHRvblJlc2V0VGltZXIpO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgaWYgKGltcG9ydGluZykge1xyXG4gICAgICAgIGNvbnN0IHByb2dyZXNzID0gZXZlbnQuYmF0Y2ggPyB2YWx1ZSA6IGltcG9ydFByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtcnVubmluZycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZSgnYXJpYS1idXN5JywgJ3RydWUnKTtcclxuICAgICAgICBidXR0b24udGl0bGUgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgPyAn5YeG5aSH6LWE5rqQJyA6ICfmnoTlu7roioLngrknO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApfSVgO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3Byb2dyZXNzICogMTAwfSVgO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2RvbmUnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5a+85YWl5a6M5oiQJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAnMTAwJSc7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzEwMCUnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxNDAwKTtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicgfHwgZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcgPyAn5bey5Y+W5raIJyA6ICflr7zlhaXlpLHotKUnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfph43or5UnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxODAwKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2RvbmUnLCAnZXJyb3InLCAnY2FuY2VsbGVkJywgJ2lkbGUnXS5pbmNsdWRlcyhldmVudC5waGFzZSkpIHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgIH1cclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ2RvbmUnICYmICF3b3JrZmxvdz8ucGVuZGluZyAmJiBwZW5kaW5nSW1wb3J0UmV2aWV3KSB7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcGVuZGluZ0ltcG9ydFJldmlldztcclxuICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUoeyByZXZpZXcgfSk7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgIH1cclxuICAgIGlmIChldmVudC5iYXRjaD8ucmVzdWx0ICYmICFiYXRjaEltcG9ydFBlbmRpbmcgJiYgYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICBpZiAoYmF0Y2hSZWNvdmVyeVRpbWVyKSBjbGVhclRpbWVvdXQoYmF0Y2hSZWNvdmVyeVRpbWVyKTtcclxuICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpOyBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKGV2ZW50LmJhdGNoLnJlc3VsdCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2NlbmRhbnRzKG5vZGU6IFRyZWVOb2RlRHRvKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5mbGF0TWFwKChjaGlsZCkgPT4gW2NoaWxkLCAuLi5kZXNjZW5kYW50cyhjaGlsZCldKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVjb25jaWxlQWN0aW9ucygpOiB2b2lkIHtcclxuICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdKTtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKFxyXG4gICAgICAgIHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdLFxyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMsXHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyxcclxuICAgICAgICBzdGF0ZS5leHBsaWNpdElkcyxcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLFxyXG4gICAgKTtcclxuICAgIHN0YXRlLmFjdGlvbnMgPSBlZmZlY3RpdmUuYWN0aW9ucztcclxuICAgIHN0YXRlLnN1cHByZXNzZWQgPSBlZmZlY3RpdmUuc3VwcHJlc3NlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IEltcG9ydEFjdGlvbik6IHZvaWQge1xyXG4gICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBhY3Rpb24pKTtcclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0aXZlTm9kZU5hbWUobm9kZTogVHJlZU5vZGVEdG8pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0YXRlLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4cGxpY2l0T3ZlcnJpZGVzKCk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpXHJcbiAgICAgICAgLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpKVxyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVuYW1lZCA9IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICByZXR1cm4gbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcclxuICAgICAgICAgICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmdldChub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUobm9kZSksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICAuLi4ocmVuYW1lZCA/IHsgbmFtZTogZWZmZWN0aXZlTm9kZU5hbWUobm9kZSkgfSA6IHt9KSxcclxuICAgICAgICAgICAgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSk7XHJcbiAgICAgICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVLZXkgPSBzdGF0ZS5kb2N1bWVudC5maWxlS2V5O1xyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBpZiAoYWN0aXZlKSB7IGFjdGl2ZS5jb25maWd1cmVkID0gdHJ1ZTsgcmVtZW1iZXJBY3RpdmVGcmFtZSgpOyByZW5kZXJCYXRjaCgpOyB9XHJcbiAgICBjb25zdCBvdmVycmlkZXMgPSBleHBsaWNpdE92ZXJyaWRlcygpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpLm1hcCgobm9kZSkgPT4gbm9kZS5pZCk7XHJcbiAgICAvLyBTZXJpYWxpemUgd3JpdGVzIHNvIGEgc2xvd2VyIGVhcmxpZXIgcmVxdWVzdCBjYW4gbmV2ZXIgb3ZlcndyaXRlIGEgbmV3ZXJcclxuICAgIC8vIHN0cmF0ZWd5IHNuYXBzaG90IGFmdGVyIHJhcGlkIHNlbGVjdCBjaGFuZ2VzLlxyXG4gICAgbm9kZU92ZXJyaWRlU2F2ZVRhc2sgPSBub2RlT3ZlcnJpZGVTYXZlVGFza1xyXG4gICAgICAgIC5jYXRjaCgoKSA9PiB1bmRlZmluZWQpXHJcbiAgICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBhd2FpdCByZXF1ZXN0PEltcG9ydE92ZXJyaWRlW10+KCdzYXZlLW5vZGUtb3ZlcnJpZGVzJywgZmlsZUtleSwgb3ZlcnJpZGVzLCBzY29wZUlkcyk7XHJcbiAgICAgICAgfSlcclxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfoioLngrnnrZbnlaXkv53lrZjlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1hdGNoZXMobm9kZTogVHJlZU5vZGVEdG8pOiBib29sZWFuIHtcclxuICAgIGlmICghc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoYXlzdGFjayA9IGAke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfSAke25vZGUubmFtZX0gJHtub2RlLnR5cGV9ICR7bm9kZS5pZH1gLnRvTG93ZXJDYXNlKCk7XHJcbiAgICBpZiAoaGF5c3RhY2suaW5jbHVkZXMoc3RhdGUuc2VhcmNoKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShtYXRjaGVzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gb3B0aW9uKHZhbHVlOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpOiBIVE1MT3B0aW9uRWxlbWVudCB7XHJcbiAgICBjb25zdCBpdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICBpdGVtLnZhbHVlID0gdmFsdWU7XHJcbiAgICBpdGVtLnRleHRDb250ZW50ID0gbGFiZWw7XHJcbiAgICByZXR1cm4gaXRlbTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWFrZVNlbGVjdChcclxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHN0cmluZyxcclxuICAgIGl0ZW1zOiBBcnJheTxbc3RyaW5nLCBzdHJpbmddPixcclxuICAgIGxhYmVsOiBzdHJpbmcsXHJcbik6IEhUTUxTZWxlY3RFbGVtZW50IHtcclxuICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xyXG4gICAgc2VsZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcclxuICAgIHNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBsYWJlbCk7XHJcbiAgICBmb3IgKGNvbnN0IFtrZXksIHRleHRdIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbihrZXksIHRleHQpKTtcclxuICAgIH1cclxuICAgIHNlbGVjdC52YWx1ZSA9IHZhbHVlO1xyXG4gICAgcmV0dXJuIHNlbGVjdDtcclxufVxyXG5cclxuZnVuY3Rpb24gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgbm9kZTogVHJlZU5vZGVEdG8sIGRlcHRoOiBudW1iZXIpOiB2b2lkIHtcclxuICAgIGlmICghbWF0Y2hlcyhub2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgcm93LmNsYXNzTmFtZSA9IGB0cmVlLXJvdyR7c3RhdGUuc2VsZWN0ZWRJZCA9PT0gbm9kZS5pZCA/ICcgaXMtc2VsZWN0ZWQnIDogJyd9YDtcclxuICAgIHJvdy5kYXRhc2V0Lm5vZGVJZCA9IG5vZGUuaWQ7XHJcbiAgICByb3cuc2V0QXR0cmlidXRlKCdyb2xlJywgJ3RyZWVpdGVtJyk7XHJcbiAgICByb3cuc2V0QXR0cmlidXRlKCdhcmlhLWxldmVsJywgU3RyaW5nKGRlcHRoICsgMSkpO1xyXG5cclxuICAgIGNvbnN0IG1haW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1haW4uY2xhc3NOYW1lID0gJ25vZGUtbWFpbic7XHJcbiAgICBtYWluLnN0eWxlLnNldFByb3BlcnR5KCctLWRlcHRoJywgU3RyaW5nKGRlcHRoKSk7XHJcbiAgICBjb25zdCBjb2xsYXBzZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xyXG4gICAgY29sbGFwc2UuY2xhc3NOYW1lID0gYGNvbGxhcHNlJHtub2RlLmNoaWxkcmVuLmxlbmd0aCA/ICcnIDogJyBpcy1sZWFmJ31gO1xyXG4gICAgY29sbGFwc2UudHlwZSA9ICdidXR0b24nO1xyXG4gICAgY29sbGFwc2UuZGF0YXNldC5jb2xsYXBzZSA9IG5vZGUuaWQ7XHJcbiAgICBjb2xsYXBzZS50ZXh0Q29udGVudCA9IHN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgPyAn4oC6JyA6ICfijIQnO1xyXG4gICAgY29sbGFwc2Uuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICflsZXlvIAnIDogJ+aKmOWPoCcpO1xyXG4gICAgY29uc3QgZG90ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgZG90LmNsYXNzTmFtZSA9IGB0eXBlLWRvdCAke1xyXG4gICAgICAgIG5vZGUudHlwZSA9PT0gJ1RFWFQnID8gJ3RleHQnXHJcbiAgICAgICAgICAgIDogaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3ZlY3RvcidcclxuICAgICAgICAgICAgICAgIDogbm9kZS50eXBlLmluY2x1ZGVzKCdDT01QT05FTlQnKSB8fCBub2RlLnR5cGUgPT09ICdJTlNUQU5DRScgPyAnY29tcG9uZW50J1xyXG4gICAgICAgICAgICAgICAgICAgIDogJydcclxuICAgIH1gO1xyXG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgY29weS5jbGFzc05hbWUgPSAnbm9kZS1jb3B5JztcclxuICAgIGNvbnN0IGRpc3BsYXlOYW1lID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBuYW1lLmNsYXNzTmFtZSA9IGBub2RlLW5hbWUke3N0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8gJyBpcy1yZW5hbWVkJyA6ICcnfWA7XHJcbiAgICBuYW1lLnRleHRDb250ZW50ID0gZGlzcGxheU5hbWU7XHJcbiAgICBjb25zdCBzdHJhdGVneVN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBuYW1lLnRpdGxlID0gW1xyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8gYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfWAgOiAn6YCJ5oup6IqC54K577yM5Zyo5Y+z5L6n5L+u5pS55a+85YWl6IqC54K55ZCNJyxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3ksXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcsXHJcbiAgICBdXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5qb2luKCcgwrcgJyk7XHJcbiAgICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBtZXRhLmNsYXNzTmFtZSA9ICdub2RlLW1ldGEnO1xyXG4gICAgbWV0YS50ZXh0Q29udGVudCA9IGAke25vZGUudHlwZX0gwrcgJHtNYXRoLnJvdW5kKG5vZGUud2lkdGgpfcOXJHtNYXRoLnJvdW5kKG5vZGUuaGVpZ2h0KX1gO1xyXG4gICAgY29weS5hcHBlbmQobmFtZSwgbWV0YSk7XHJcbiAgICBpZiAoc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5KSB7XHJcbiAgICAgICAgY29uc3Qgc3RyYXRlZ3kgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBzdHJhdGVneS5jbGFzc05hbWUgPSAnbm9kZS1zdHJhdGVneSc7XHJcbiAgICAgICAgc3RyYXRlZ3kudGV4dENvbnRlbnQgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3k7XHJcbiAgICAgICAgc3RyYXRlZ3kudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3k7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZChzdHJhdGVneSk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpIHtcclxuICAgICAgICBjb25zdCB3YXJuaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgd2FybmluZy5jbGFzc05hbWUgPSAnbm9kZS13YXJuaW5nJztcclxuICAgICAgICB3YXJuaW5nLnRleHRDb250ZW50ID0gYOKaoCAke3N0cmF0ZWd5U3VtbWFyeS53YXJuaW5nfWA7XHJcbiAgICAgICAgd2FybmluZy50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nO1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQod2FybmluZyk7XHJcbiAgICB9XHJcbiAgICByb3cuY2xhc3NMaXN0LnRvZ2dsZSgnaGFzLWRldGFpbCcsIEJvb2xlYW4oc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5IHx8IHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSk7XHJcbiAgICBtYWluLmFwcGVuZChjb2xsYXBzZSwgZG90LCBjb3B5KTtcclxuXHJcbiAgICBjb25zdCBhY3Rpb25CYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIGFjdGlvbkJhZGdlLmNsYXNzTmFtZSA9ICdub2RlLWFjdGlvbi1iYWRnZSc7XHJcbiAgICBjb25zdCBzZWxlY3RlZEFjdGlvbiA9IHNhZmVBY3Rpb24obm9kZSwgc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24pO1xyXG4gICAgYWN0aW9uQmFkZ2UudGV4dENvbnRlbnQgPSBhY3Rpb25PcHRpb25zRm9yTm9kZShub2RlKS5maW5kKChbdmFsdWVdKSA9PiB2YWx1ZSA9PT0gc2VsZWN0ZWRBY3Rpb24pPy5bMV0gPz8gc2VsZWN0ZWRBY3Rpb247XHJcbiAgICBhY3Rpb25CYWRnZS50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSB8fCBhY3Rpb25CYWRnZS50ZXh0Q29udGVudDtcclxuICAgIHJvdy5hcHBlbmQobWFpbiwgYWN0aW9uQmFkZ2UpO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJvdyk7XHJcblxyXG4gICAgaWYgKCFzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnNlYXJjaCkge1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IGFwcGVuZFRyZWVOb2RlKGNvbnRhaW5lciwgY2hpbGQsIGRlcHRoICsgMSkpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJOb2RlUHJvcGVydGllcygpOiB2b2lkIHtcclxuICAgIGNvbnN0IGNvbnRhaW5lciA9IGVsZW1lbnQoJyNub2RlLXByb3BlcnRpZXMnKTtcclxuICAgIGNvbnRhaW5lci5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGNvbnN0IG5vZGUgPSBzdGF0ZS5zZWxlY3RlZElkID8gZmluZE5vZGUoc3RhdGUuc2VsZWN0ZWRJZCkgOiB1bmRlZmluZWQ7XHJcbiAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnaW5zcGVjdG9yLWVtcHR5JztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfpgInmi6noioLngrnvvIzmn6XnnIvpooTop4jlubbosIPmlbTlr7zlhaXorr7nva7jgIInO1xyXG4gICAgICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IGZpZWxkID0gKGxhYmVsOiBzdHJpbmcsIGNvbnRyb2w6IEhUTUxFbGVtZW50KTogdm9pZCA9PiB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcclxuICAgICAgICByb3cuY2xhc3NOYW1lID0gJ2ZpZWxkJztcclxuICAgICAgICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIGhlYWRpbmcudGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgICAgICByb3cuYXBwZW5kKGhlYWRpbmcsIGNvbnRyb2wpO1xyXG4gICAgICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgbmFtZS50eXBlID0gJ3RleHQnO1xyXG4gICAgbmFtZS5jbGFzc05hbWUgPSAnbm9kZS1uYW1lLWlucHV0JztcclxuICAgIG5hbWUudmFsdWUgPSBkaXNwbGF5TmFtZTtcclxuICAgIG5hbWUubWF4TGVuZ3RoID0gOTY7XHJcbiAgICBuYW1lLnNwZWxsY2hlY2sgPSBmYWxzZTtcclxuICAgIG5hbWUuZGF0YXNldC5uYW1lRm9yID0gbm9kZS5pZDtcclxuICAgIG5hbWUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7bm9kZS5uYW1lfSDlr7zlhaXoioLngrnlkI1gKTtcclxuICAgIG5hbWUudGl0bGUgPSBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV977ybRW50ZXIg5L+d5a2Y77yMRXNjIOWPlua2iGA7XHJcbiAgICBuYW1lLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGZpZWxkKCflr7zlhaXoioLngrnlkI0nLCBuYW1lKTtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEFjdGlvbiA9IHNhZmVBY3Rpb24obm9kZSwgc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24pO1xyXG4gICAgY29uc3QgYWN0aW9uT3B0aW9ucyA9IGFjdGlvbk9wdGlvbnNGb3JOb2RlKG5vZGUpO1xyXG4gICAgY29uc3QgYWN0aW9uID0gbWFrZVNlbGVjdChcclxuICAgICAgICAnYWN0aW9uLXNlbGVjdCcsXHJcbiAgICAgICAgc2VsZWN0ZWRBY3Rpb24sXHJcbiAgICAgICAgYWN0aW9uT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g5a+85YWl5pa55byPYCxcclxuICAgICk7XHJcbiAgICBhY3Rpb24uZGF0YXNldC5hY3Rpb25Gb3IgPSBub2RlLmlkO1xyXG4gICAgYWN0aW9uLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGZpZWxkKCflr7zlhaXmlrnlvI8nLCBhY3Rpb24pO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkS2luZCA9IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQ7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0gZWZmZWN0aXZlS2luZEZvck5vZGUoXHJcbiAgICAgICAgbm9kZSxcclxuICAgICAgICBzZWxlY3RlZEtpbmQsXHJcbiAgICAgICAgc2VsZWN0ZWRBY3Rpb24sXHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICApO1xyXG4gICAgY29uc3Qga2luZE9wdGlvbnMgPSBraW5kT3B0aW9uc0ZvckFjdGlvbihzZWxlY3RlZEFjdGlvbik7XHJcbiAgICBjb25zdCBraW5kID0gbWFrZVNlbGVjdChcclxuICAgICAgICAna2luZC1zZWxlY3QnLFxyXG4gICAgICAgIGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAga2luZE9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOiKgueCueexu+Wei2AsXHJcbiAgICApO1xyXG4gICAga2luZC5kYXRhc2V0LmtpbmRGb3IgPSBub2RlLmlkO1xyXG4gICAga2luZC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBmaWVsZCgn6IqC54K557G75Z6LJywga2luZCk7XHJcblxyXG4gICAgY29uc3QgcGF0Y2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xyXG4gICAgcGF0Y2guY2xhc3NOYW1lID0gJ3RvZ2dsZS1yb3cgcGF0Y2gtdG9nZ2xlJztcclxuICAgIHBhdGNoLnRpdGxlID0gbm9kZS5wYXRjaENhbmRpZGF0ZVxyXG4gICAgICAgID8gJ0ZpZ21hIOWIhueJh+S8mOWFiO+8muaMiSBGaWdtYSDljp/lp4vovrnnlYzlr7zlhaXvvIzkuI3og73lhbPpl63vvJvku43lj6/lv73nlaXmlbTkuKroioLngrknXHJcbiAgICAgICAgOiAn6K+l6IqC54K55LiN5piv5pyJ5pWI55qEIEZpZ21hIOWIhueJhyc7XHJcbiAgICBjb25zdCBwYXRjaElucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcclxuICAgIHBhdGNoSW5wdXQudHlwZSA9ICdjaGVja2JveCc7XHJcbiAgICBwYXRjaElucHV0LmRhdGFzZXQucGF0Y2hGb3IgPSBub2RlLmlkO1xyXG4gICAgcGF0Y2hJbnB1dC5jaGVja2VkID0gc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCk7XHJcbiAgICBwYXRjaElucHV0LmRpc2FibGVkID0gdHJ1ZTtcclxuICAgIGNvbnN0IHBhdGNoSWNvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIHBhdGNoSWNvbi50ZXh0Q29udGVudCA9IG5vZGUucGF0Y2hDYW5kaWRhdGVcclxuICAgICAgICA/IG5vZGUuc2xpY2VNb2RlID09PSAnbmluZScgPyAnRmlnbWEg5Lmd5a6rIMK3IOS8mOWFiOWQr+eUqCcgOiBub2RlLnNsaWNlTW9kZSA/ICdGaWdtYSDkuInlrqsgwrcg5LyY5YWI5ZCv55SoJyA6ICdGaWdtYSDkuIkgLyDkuZ3lrqsgwrcg5LyY5YWI5ZCv55SoJ1xyXG4gICAgICAgIDogJ+WIh+eJhyDCtyDpnZ7lgJnpgInoioLngrknO1xyXG4gICAgcGF0Y2guYXBwZW5kKHBhdGNoSW5wdXQsIHBhdGNoSWNvbik7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocGF0Y2gpO1xyXG4gICAgY29uc3Qgc3VtbWFyeSA9IHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUobm9kZSwgc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpKTtcclxuICAgIGNvbnN0IG5vdGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG5vdGUuY2xhc3NOYW1lID0gJ25vZGUtaW5zcGVjdG9yLW5vdGUnO1xyXG4gICAgZm9yIChjb25zdCB0ZXh0IG9mIFtzdW1tYXJ5LnN0cmF0ZWd5LCBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV9YCwgc3VtbWFyeS53YXJuaW5nXSkge1xyXG4gICAgICAgIGlmICghdGV4dCkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgcGFyYWdyYXBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgIHBhcmFncmFwaC50ZXh0Q29udGVudCA9IHRleHQ7XHJcbiAgICAgICAgaWYgKHRleHQgPT09IHN1bW1hcnkud2FybmluZykgcGFyYWdyYXBoLmNsYXNzTmFtZSA9ICdub2RlLXdhcm5pbmcnO1xyXG4gICAgICAgIG5vdGUuYXBwZW5kQ2hpbGQocGFyYWdyYXBoKTtcclxuICAgIH1cclxuICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChub3RlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyVHJlZShyZXNldFNjcm9sbCA9IGZhbHNlKTogdm9pZCB7XHJcbiAgICBjb25zdCB0cmVlID0gZWxlbWVudCgnI3RyZWUnKTtcclxuICAgIHJlcmVuZGVyUHJlc2VydmluZ1Njcm9sbCh0cmVlLCAoKSA9PiB7XHJcbiAgICAgICAgdHJlZS5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdlbXB0eS1zdGF0ZSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGdseXBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgICAgICBnbHlwaC5jbGFzc05hbWUgPSAnZW1wdHktZ2x5cGgnO1xyXG4gICAgICAgICAgICBnbHlwaC50ZXh0Q29udGVudCA9ICfihrMnO1xyXG4gICAgICAgICAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0cm9uZycpO1xyXG4gICAgICAgICAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfov5jmsqHmnInoioLngrknO1xyXG4gICAgICAgICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgICAgICBib2R5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDpk77mjqXlkI7vvIzlj6/pgJDlsYLpgInmi6nnlJ/miJDjgIFQTkcg5pW05bGC5oiW5pu05paw44CCJztcclxuICAgICAgICAgICAgZW1wdHkuYXBwZW5kKGdseXBoLCB0aXRsZSwgYm9keSk7XHJcbiAgICAgICAgICAgIHRyZWUuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHN0YXRlLmRvY3VtZW50LnRyZWUuZm9yRWFjaCgobm9kZSkgPT4gYXBwZW5kVHJlZU5vZGUodHJlZSwgbm9kZSwgMCkpO1xyXG4gICAgfSwgcmVzZXRTY3JvbGwpO1xyXG4gICAgcmVuZGVyTm9kZVByb3BlcnRpZXMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeSgpOiB2b2lkIHtcclxuICAgIGlmIChiYXRjaEl0ZW1zLmxlbmd0aCkgeyByZW1lbWJlckFjdGl2ZUZyYW1lKCk7IHJlbmRlckJhdGNoKCk7IH1cclxuICAgIGNvbnN0IG5vZGVzID0gc3RhdGUuZG9jdW1lbnQgPyBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpIDogW107XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IG5vZGVzLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgIT09ICdpZ25vcmUnKTtcclxuICAgIGVsZW1lbnQoJyNub2RlLWNvdW50JykudGV4dENvbnRlbnQgPSBgJHtub2Rlcy5sZW5ndGh9IOiKgueCuWA7XHJcbiAgICBlbGVtZW50KCcjc2VsZWN0aW9uLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IHN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgPyBgJHtzZWxlY3RlZC5sZW5ndGh9IC8gJHtub2Rlcy5sZW5ndGh9IOS4quiKgueCueWwhuWPguS4juWvvOWFpWBcclxuICAgICAgICA6ICfnrYnlvoXorr7orqHmlbDmja4nO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSBzdGF0ZS5idXN5XHJcbiAgICAgICAgfHwgIXN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgfHwgIXNlbGVjdGVkLmxlbmd0aFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxuICAgIHdvcmtmbG93Py5yZW5kZXIoKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcHJldmlldyhub2RlOiBUcmVlTm9kZUR0byk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gbm9kZS5pZDtcclxuICAgIGNvbnN0IHJldmlzaW9uID0gKytwcmV2aWV3UmV2aXNpb247XHJcbiAgICBjb25zdCBmcmFtZUlkID0gYWN0aXZlQmF0Y2hJZDtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIGVsZW1lbnQoJyNwcmV2aWV3LW1ldGEnKS50ZXh0Q29udGVudCA9IGAke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb25zdCBzdGFnZSA9IGVsZW1lbnQoJyNwcmV2aWV3LXN0YWdlJyk7XHJcbiAgICBjb25zdCBpbWFnZSA9IGVsZW1lbnQ8SFRNTEltYWdlRWxlbWVudD4oJyNwcmV2aWV3LWltYWdlJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QuYWRkKCdpcy1sb2FkaW5nJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdoYXMtaW1hZ2UnKTtcclxuICAgIGltYWdlLnJlbW92ZUF0dHJpYnV0ZSgnc3JjJyk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHByZWNlZGluZ1N5bmMgPSBiYXRjaFN5bmNUYXNrO1xyXG4gICAgICAgIGNvbnN0IHJlYWQgPSBwcmV2aWV3UmVhZFRhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKS50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgYXdhaXQgcHJlY2VkaW5nU3luYztcclxuICAgICAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgZnJhbWVJZCAhPT0gYWN0aXZlQmF0Y2hJZCkgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgICAgIHJldHVybiByZXF1ZXN0PHsgdXJsOiBzdHJpbmcgfT4oJ2dldC1wcmV2aWV3Jywgbm9kZS5pZCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcHJldmlld1JlYWRUYXNrID0gcmVhZC5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlYWQ7XHJcbiAgICAgICAgaWYgKCFyZXN1bHQpIHJldHVybjtcclxuICAgICAgICBpZiAoc3RhdGUuc2VsZWN0ZWRJZCAhPT0gbm9kZS5pZCB8fCBwcmV2aWV3UmV2aXNpb24gIT09IHJldmlzaW9uIHx8IGZyYW1lSWQgIT09IGFjdGl2ZUJhdGNoSWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgICAgIGltYWdlLm9ubG9hZCA9ICgpID0+IHJlc29sdmUoKTtcclxuICAgICAgICAgICAgaW1hZ2Uub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ+mihOiniOWbvueJh+WKoOi9veWksei0peOAgicpKTtcclxuICAgICAgICAgICAgaW1hZ2Uuc3JjID0gcmVzdWx0LnVybDtcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAocHJldmlld1JldmlzaW9uID09PSByZXZpc2lvbikgc3RhZ2UuY2xhc3NMaXN0LmFkZCgnaGFzLWltYWdlJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gPT09IHJldmlzaW9uKSBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6aKE6KeI5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gPT09IHJldmlzaW9uKSBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdpcy1sb2FkaW5nJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5UHJlc2V0KG5hbWU6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGFsbCA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICBpZiAobmFtZSA9PT0gJ3NtYXJ0Jykge1xyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmNsZWFyKCk7XHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IHN0YXRlLmRlZmF1bHRzLmdldChub2RlLmlkKSE7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmFjdGlvbik7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvcmlnaW5hbC5raW5kKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG5hbWUgPT09ICdlZGl0YWJsZScpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICdyZW5kZXInIDogJ2dlbmVyYXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgbm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICAgICAgICAgOiAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSBuYW1lKTtcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0VG9TY2VuZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICh3b3JrZmxvdyAmJiB3b3JrZmxvdy5zdGVwICE9PSAzKSByZXR1cm47XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfmianlsZXkuLvov5vnqIvku43mmK/ml6fniYjvvIzor7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQgfHwgc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7XHJcbiAgICBpZiAoIXNldHRpbmdzKSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmZhaWwoJ+ivt+ajgOafpeWvvOWFpeWAjeeOh+S4jui+k+WHuuebruW9le+8jOS/ruato+WQjuWGjeasoeWvvOWFpeOAgicpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgIGF3YWl0IGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10gPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpLm1hcCgobm9kZSkgPT4gbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uKHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBhY3Rpb246IHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICBleHBsaWNpdDogc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIC4uLihzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IHsgbmFtZTogZWZmZWN0aXZlTm9kZU5hbWUobm9kZSkgfSA6IHt9KSxcclxuICAgIH0sIG5vZGUucGF0Y2hDYW5kaWRhdGUpKTtcclxuICAgIHdvcmtmbG93Py5iZWdpbignaW1wb3J0Jyk7XHJcbiAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5YeG5aSH5a+85YWl4oCmJyB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDxXb3JrZmxvd1Jlc3VsdD4oXHJcbiAgICAgICAgICAgICdpbXBvcnQtc2VsZWN0aW9uJyxcclxuICAgICAgICAgICAgeyBvdmVycmlkZXMsIHNldHRpbmdzIH0sXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBmYWxsYmFja05vdGUgPSByZXN1bHQ/Lndhcm5pbmdzPy5sZW5ndGhcclxuICAgICAgICAgICAgPyBg77ybJHtyZXN1bHQud2FybmluZ3MubGVuZ3RofSDmnaHlr7zlhaUv5pS25bC+5o+Q56S677yI6K+m6KeB57uT5p6c5qOA5p+l77yJYFxyXG4gICAgICAgICAgICA6ICcnO1xyXG4gICAgICAgIHNob3dUb2FzdChyZXN1bHQ/LnByZWZhYlVybFxyXG4gICAgICAgICAgICA/IGDlr7zlhaXlrozmiJDvvIzlt7LliJvlu7rpooTliLbkvZPvvJoke3Jlc3VsdC5wcmVmYWJVcmx9JHtmYWxsYmFja05vdGV9YFxyXG4gICAgICAgICAgICA6IGDlr7zlhaXlrozmiJDvvIzlt7LlnKjlnLrmma/kuK3pgInkuK3moLnoioLngrkke2ZhbGxiYWNrTm90ZX3jgIJgKTtcclxuICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUocmVzdWx0KTtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSByZXN1bHQucmV2aWV3ID8/IHBlbmRpbmdJbXBvcnRSZXZpZXc7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgaWYgKHJldmlldykgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+WvvOWFpeWksei0peOAgicpO1xyXG4gICAgICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6IHdvcmtmbG93Py5jYW5jZWxsZWQgPyAnY2FuY2VsbGVkJyA6ICdlcnJvcicsIHZhbHVlOiAwLCBtZXNzYWdlIH0pO1xyXG4gICAgICAgIHNob3dUb2FzdChtZXNzYWdlLCAhd29ya2Zsb3c/LmNhbmNlbGxlZCk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHdvcmtmbG93Py5lbmQoKTtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1lcmdlQmF0Y2hJdGVtcyhpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSk6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXMgPSBiYXRjaEl0ZW1zLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pdGVtLmlkID09PSBpdGVtLmlkKTtcclxuICAgICAgICBpZiAocHJldmlvdXMpIHByZXZpb3VzLml0ZW0gPSB7IC4uLml0ZW0sIGVuYWJsZWQ6IHByZXZpb3VzLml0ZW0uZW5hYmxlZCB9O1xyXG4gICAgICAgIGVsc2UgYmF0Y2hJdGVtcy5wdXNoKHsgaXRlbSwgZWRpdG9yOiBpbml0aWFsRnJhbWVFZGl0b3IoaXRlbS5kb2N1bWVudCksIGNvbmZpZ3VyZWQ6IEJvb2xlYW4oaXRlbS5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzPy5sZW5ndGgpIH0pO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQmF0Y2hTb3VyY2UoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgaWYgKHdvcmtmbG93ICYmICF3b3JrZmxvdy5jcmVkZW50aWFsc1JlYWR5KSB7IHdvcmtmbG93Lm9wZW5DcmVkZW50aWFscygpOyByZXR1cm47IH1cclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHsgc2hvd1RvYXN0KCfor7fnspjotLQgRmlnbWEgU2VjdGlvbiDmiJYgRnJhbWUg6ZO+5o6l44CCJywgdHJ1ZSk7IHJldHVybjsgfVxyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpOyBpZiAoc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICB3b3JrZmxvdz8uYmVnaW4oJ2ZldGNoJyk7IHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4wNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPluW5tuivhuWIqyBGaWdtYSDnlYzpnaLigKYnIH0pO1xyXG4gICAgbGV0IGFjdGl2YXRlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JCYXRjaExpc3RSZWFkeSgpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTb3VyY2VSZXN1bHQ+KCdyZXNvbHZlLWJhdGNoLXNvdXJjZScsIHNvdXJjZSk7XHJcbiAgICAgICAgaWYgKHJlc3VsdC5kb2N1bWVudCAmJiAhcmVzdWx0Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBiYXRjaEl0ZW1zID0gW107IGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7IGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gcmVzdWx0LmRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KHJlc3VsdC5kb2N1bWVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKHJlc3VsdC5pdGVtcyk7XHJcbiAgICAgICAgICAgIGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gQXJyYXkuZnJvbShuZXcgTWFwKGJhdGNoSXRlbXMuZmxhdE1hcCgoeyBpdGVtIH0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBbXSkubWFwKChmb250KSA9PiBbZm9udC51cmwsIGZvbnRdKSkudmFsdWVzKCkpO1xyXG4gICAgICAgICAgICBhY3RpdmF0ZSA9IHNlbGVjdGVkRnJhbWVzKCkuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpPy5pdGVtLmlkID8/IHNlbGVjdGVkRnJhbWVzKClbMF0/Lml0ZW0uaWQgPz8gYmF0Y2hJdGVtc1swXT8uaXRlbS5pZDtcclxuICAgICAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTtcclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uYmF0Y2hSZWFkeSgpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3sua3u+WKoCAke3Jlc3VsdC5hZGRlZH0g5Liq55WM6Z2iJHtyZXN1bHQuZHVwbGljYXRlcyA/IGDvvIzot7Pov4cgJHtyZXN1bHQuZHVwbGljYXRlc30g5Liq6YeN5aSN6aG5YCA6ICcnfeOAgmApO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluWksei0peOAgicpO1xyXG4gICAgICAgIGlmICghd29ya2Zsb3c/LmNhbmNlbGxlZCkgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KHdvcmtmbG93Py5jYW5jZWxsZWQgPyAn6K+75Y+W5bey5Y+W5raI77yM6YWN572u5bey5L+d55WZ44CCJyA6IG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICBpZiAoYWN0aXZhdGUpIGF3YWl0IGFjdGl2YXRlRnJhbWUoYWN0aXZhdGUpO1xyXG4gICAgICAgIHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gb3ZlcnJpZGVzRm9yRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgY29uc3QgZWRpdG9yID0gZW50cnkuZWRpdG9yID8/IGluaXRpYWxGcmFtZUVkaXRvcihlbnRyeS5pdGVtLmRvY3VtZW50KTtcclxuICAgIHJldHVybiBmbGF0dGVuKGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLCBhY3Rpb246IGVkaXRvci5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbiwga2luZDogZWRpdG9yLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBlZGl0b3IucGF0Y2hlcy5oYXMobm9kZS5pZCksIGV4cGxpY2l0OiBlZGl0b3IuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIC4uLihlZGl0b3IucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVkaXRvci5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lIH0gOiB7fSksXHJcbiAgICB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncywgaWRzPzogU2V0PHN0cmluZz4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5IHx8IGJhdGNoSW1wb3J0UGVuZGluZykgcmV0dXJuO1xyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3QgZW50cmllcyA9IHNlbGVjdGVkRnJhbWVzKCkuZmlsdGVyKCh7IGl0ZW0gfSkgPT4gIWlkcyB8fCBpZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGlmICghZW50cmllcy5sZW5ndGgpIHsgc2hvd1RvYXN0KCfor7flhYjli77pgInopoHlr7zlhaXnmoTnlYzpnaLjgIInLCB0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICBpZiAoYmF0Y2hDb25mbGljdHMoKS5zaXplKSB7IHdvcmtmbG93Py5mYWlsKCflrZjlnKjph43lpI3nmoQgUHJlZmFiIOaWh+S7tuWQje+8jOivt+WFiOWcqOa4heWNleS4reaUueWQjeOAgicpOyByZXR1cm47IH1cclxuICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IHRydWU7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7IGJhdGNoU3RvcFJlcXVlc3RlZCA9IGZhbHNlO1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBiYXRjaFJlc3VsdDtcclxuICAgIHdvcmtmbG93Py5iZWdpbignaW1wb3J0Jyk7IHNldEJ1c3kodHJ1ZSk7IHJlbmRlckJhdGNoKCk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6IGDlh4blpIflr7zlhaUgJHtlbnRyaWVzLmxlbmd0aH0g5Liq55WM6Z2i4oCmYCB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvckJhdGNoTGlzdFJlYWR5KCk7XHJcbiAgICAgICAgYXdhaXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s7XHJcbiAgICAgICAgaWYgKGJhdGNoU3RvcFJlcXVlc3RlZCkge1xyXG4gICAgICAgICAgICBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHsgaWQ6ICdzdG9wcGVkLWJlZm9yZS1zdGFydCcsIHN0b3BwZWQ6IHRydWUsIGNvbXBsZXRlZDogMCwgdG90YWw6IGVudHJpZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgaXRlbXM6IGVudHJpZXMubWFwKCh7IGl0ZW0gfSkgPT4gKHsgaWQ6IGl0ZW0uaWQsIG5hbWU6IGl0ZW0ubmFtZSwgc291cmNlVXJsOiBpdGVtLnNvdXJjZVVybCwgc3RhdHVzOiAncGVuZGluZycgfSkpIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hJbXBvcnRSZXN1bHQ+KCdpbXBvcnQtYmF0Y2gnLCB7XHJcbiAgICAgICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBvdmVycmlkZXM6IG92ZXJyaWRlc0ZvckZyYW1lKGVudHJ5KSB9KSksIHNldHRpbmdzLFxyXG4gICAgICAgICAgICBmYWlsdXJlUG9saWN5OiAnY29udGludWUnLCBwcmVzZXJ2ZVJlc3VsdHM6IEJvb2xlYW4oaWRzKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBtZXJnZWQgPSBpZHMgJiYgcHJldmlvdXMgPyBwcmV2aW91cy5pdGVtcy5tYXAoKGl0ZW0pID0+IHJlc3VsdC5pdGVtcy5maW5kKChuZXh0KSA9PiBuZXh0LmlkID09PSBpdGVtLmlkKSA/PyBpdGVtKSA6IHJlc3VsdC5pdGVtcztcclxuICAgICAgICBiYXRjaFJlc3VsdCA9IHsgLi4ucmVzdWx0LCBpdGVtczogbWVyZ2VkLCB0b3RhbDogbWVyZ2VkLmxlbmd0aCwgY29tcGxldGVkOiBtZXJnZWQuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoIH07XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDsgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0uY3JlYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgY29uc3QgdXBkYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgY3JlYXRlZCwgdXBkYXRlZCwgd2FybmluZ3M6IG1lcmdlZC5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSB9KTtcclxuICAgICAgICBzaG93VG9hc3QoYOacrOaJueWujOaIkO+8muaIkOWKnyAke21lcmdlZC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aH0g6aG577yM5aSx6LSlICR7bWVyZ2VkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGh9IOmhueOAgmApO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5om56YeP5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7IHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmV0cnlCYXRjaChzdGF0dXM6ICdmYWlsZWQnIHwgJ3BlbmRpbmcnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSB8fCAhYmF0Y2hSZXN1bHQpIHJldHVybjtcclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7IGlmICghc2V0dGluZ3MpIHJldHVybjtcclxuICAgIGNvbnN0IGlkcyA9IG5ldyBTZXQoYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gc3RhdHVzKS5tYXAoKGl0ZW0pID0+IGl0ZW0uaWQpKTtcclxuICAgIGF3YWl0IGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzLCBpZHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQpOiB2b2lkIHtcclxuICAgIGJhdGNoUmVzdWx0ID0gcmVzdWx0OyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgd29ya2Zsb3c/LmNvbXBsZXRlKHtcclxuICAgICAgICBjcmVhdGVkOiByZXN1bHQuaXRlbXMucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLmNyZWF0ZWQgPz8gMCksIDApLFxyXG4gICAgICAgIHVwZGF0ZWQ6IHJlc3VsdC5pdGVtcy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCksXHJcbiAgICAgICAgd2FybmluZ3M6IHJlc3VsdC5pdGVtcy5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSxcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyQmF0Y2goKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2F0Y2hSZXN0b3JlZEJhdGNoKCk6IHZvaWQge1xyXG4gICAgYmF0Y2hSZWNvdmVyeVRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFwYW5lbEhvc3QpIHJldHVybjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZXF1ZXN0PEJhdGNoU3RhdGU+KCdnZXQtYmF0Y2gtc3RhdGUnKTtcclxuICAgICAgICAgICAgaWYgKHJlY292ZXJlZC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICBiYXRjaFByb2dyZXNzID0gcmVjb3ZlcmVkLnJ1bm5pbmc7IHJlbmRlckJhdGNoUmVzdWx0cygpOyB3YXRjaFJlc3RvcmVkQmF0Y2goKTsgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChyZWNvdmVyZWQubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihyZWNvdmVyZWQubGFzdFJlc3VsdCk7XHJcbiAgICAgICAgICAgIGVsc2Ugd29ya2Zsb3c/LmZhaWwoJ+WQjuWPsOaJuemHj+S7u+WKoeW3sue7j+e7k+adn++8jOivt+ajgOafpSBDb2NvcyDkuK3nmoTlr7zlhaXnu5PmnpzjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpOyB3b3JrZmxvdz8uZmFpbChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5blkI7lj7Dmibnph4/ku7vliqHlpLHotKXjgIInKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSwgODAwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkltcG9ydFJldmlldyh0YWI6ICdhc3NldHMnIHwgJ25vZGVzJyB8ICdzb3VyY2UnID0gJ2Fzc2V0cycpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgaWYgKHJldmlldykge1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmRleCA9IFsnYXNzZXRzJywgJ25vZGVzJywgJ3NvdXJjZSddLmluZGV4T2YodGFiKTtcclxuICAgICAgICAgICAgaWYgKGluZGV4ID4gMCkgZWxlbWVudCgnI2ltcG9ydC1yZXZpZXctZGlhbG9nJykucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJy5yZXZpZXctdGFicyBidXR0b24nKVtpbmRleF0/LmNsaWNrKCk7XHJcbiAgICAgICAgfSBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5qOA5p+l57uT5p6c5aSx6LSl44CCJyksIHRydWUpOyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IHZvaWQgb3BlbkltcG9ydFJldmlldygpOyB9KTtcclxuICAgIGVsZW1lbnQoJyNzYXZlLXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdG9rZW4taW5wdXQnKTtcclxuICAgICAgICBpZiAoIWlucHV0LnZhbHVlLnRyaW0oKSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSBUb2tlbuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBzYXZlZCA9IGZhbHNlO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgdmF1bHQgPSBhd2FpdCByZXF1ZXN0PGFueT4oJ3NldC10b2tlbicsIGlucHV0LnZhbHVlKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbih2YXVsdCk7XHJcbiAgICAgICAgICAgIHNhdmVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzYXZlZCkgd29ya2Zsb3c/LmNsb3NlQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBmb3JjZVJlYWQgPSBmb3JjZURvY3VtZW50UmVhZDtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IGZhbHNlO1xyXG4gICAgICAgIGlmICh3b3JrZmxvdyAmJiAhd29ya2Zsb3cuY3JlZGVudGlhbHNSZWFkeSkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdy5vcGVuQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGggJiYgIWZvcmNlUmVhZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHNlbGVjdGVkRnJhbWVzKCk7XHJcbiAgICAgICAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgICAgIGF3YWl0IGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWQuc29tZSgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpID8gYWN0aXZlQmF0Y2hJZCEgOiBzZWxlY3RlZFswXS5pdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZm9yY2VSZWFkICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlKSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gYWN0aXZlLml0ZW0uc291cmNlVXJsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWZvcmNlUmVhZCAmJiB3b3JrZmxvdz8uc291cmNlVW5jaGFuZ2VkKCkpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3cubmF2aWdhdGUoMik7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgcmVhZEJhdGNoU291cmNlKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNhZGQtYmF0Y2gtc291cmNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZWFkQmF0Y2hTb3VyY2UpO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWVkaXQtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gd29ya2Zsb3c/Lm5hdmlnYXRlKDEpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC10b2dnbGUtYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBlbmFibGVkID0gc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGggIT09IGJhdGNoSXRlbXMubGVuZ3RoO1xyXG4gICAgICAgIGJhdGNoSXRlbXMuZm9yRWFjaCgoeyBpdGVtIH0pID0+IHsgaXRlbS5lbmFibGVkID0gZW5hYmxlZDsgfSk7XHJcbiAgICAgICAgc3luY0JhdGNoSXRlbXMoKTsgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXRyeS1mYWlsZWQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJldHJ5QmF0Y2goJ2ZhaWxlZCcpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bWUtcGVuZGluZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmV0cnlCYXRjaCgncGVuZGluZycpKTtcclxuICAgIGVsZW1lbnQoJyNyZWZyZXNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IHRydWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpLmNsaWNrKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYWRkLWJhdGNoLXNvdXJjZScpLmNsaWNrKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcmVzZXRSb3VuZHRyaXBUb2tlbnMpO1xyXG4gICAgZWxlbWVudCgnI3BpY2stYXNzZXQtZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1hc3NldC1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6LWE5rqQ5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqei1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI3BpY2stcHJlZmFiLWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLXByZWZhYi1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOmihOWItuS9k+WwhuWGmeWFpSBhc3NldHMvJHtyZXN1bHQuZm9sZGVyfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6npooTliLbkvZPnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudChgI3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y77yM5YaN6YCJ5oup5pys5Zyw6LWE5rqQ55uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICAgICAgaW5kZXgsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3suWQr+eUqOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup5pys5Zyw6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGVsZW1lbnQoYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gJyc7XHJcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzaG93VG9hc3QoYOW3sua4hemZpOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBpbXBvcnRUb1NjZW5lKTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgaWYgKGJhdGNoSW1wb3J0UGVuZGluZykgYmF0Y2hTdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgICAgICB3b3JrZmxvdz8uY2FuY2VsUmVxdWVzdGVkKCk7XHJcbiAgICAgICAgdHJ5IHsgYXdhaXQgcmVxdWVzdChiYXRjaEltcG9ydFBlbmRpbmcgPyAnc3RvcC1pbXBvcnQtYmF0Y2gnIDogJ2NhbmNlbC1pbXBvcnQnKTsgfVxyXG4gICAgICAgIGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5Y+W5raI6K+35rGC5aSx6LSl77yM6K+356iN5ZCO6YeN6K+V44CCJyk7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5jYW5jZWxSZXF1ZXN0RmFpbGVkKG1lc3NhZ2UpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBzdGF0ZS5zZWFyY2ggPSAoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBjb2xsYXBzZUlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2xsYXBzZV0nKT8uZGF0YXNldC5jb2xsYXBzZTtcclxuICAgICAgICBpZiAoY29sbGFwc2VJZCkge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkLmhhcyhjb2xsYXBzZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmRlbGV0ZShjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5hZGQoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuY2xvc2VzdCgnc2VsZWN0LCBsYWJlbCwgaW5wdXQsIHRleHRhcmVhJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtbm9kZS1pZF0nKT8uZGF0YXNldC5ub2RlSWQ7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGlkID8gZmluZE5vZGUoaWQpIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHZvaWQgcHJldmlldyhub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGlmICghdGFyZ2V0LmRhdGFzZXQubmFtZUZvciAmJiAhdGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yICYmICF0YXJnZXQuZGF0YXNldC5raW5kRm9yICYmICF0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikgcmV0dXJuO1xyXG4gICAgICAgIGlmICh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XHJcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlmICghY3VzdG9tTmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+iKgueCueWQjeS4jeiDveS4uuepuuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgaWYgKGN1c3RvbU5hbWUgPT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKVxyXG4gICAgICAgICAgICAgICAgPyBg6IqC54K55bCG5Lul4oCcJHtjdXN0b21OYW1lfeKAneWvvOWFpeOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+W3suaBouWkjSBGaWdtYSDljp/oioLngrnlkI3jgIInKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHNhZmVBY3Rpb24obm9kZSwgdGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gIT09ICdyZW5kZXInICYmICFub2RlLnBhdGNoQ2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgYWN0aW9uKTtcclxuICAgICAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdyZW5kZXInICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGDigJwke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfeKAneWwhuS9nOS4uuaVtOWxguWvvOWFpe+8jCR7ZGVzY2VuZGFudHMobm9kZSkubGVuZ3RofSDkuKrlrZDoioLngrnkuI3kvJrljZXni6znlJ/miJDjgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpIHtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KHRhcmdldC5kYXRhc2V0LmtpbmRGb3IsIHRhcmdldC52YWx1ZSBhcyBOb2RlS2luZCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5raW5kRm9yKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSB7XHJcbiAgICAgICAgICAgIC8vIEFsc28gcmVqZWN0IGEgc3RhbGUgcGFuZWwvcHJvZ3JhbW1hdGljIGF0dGVtcHQgdG8gZGlzYWJsZSBhIHZhbGlkXHJcbiAgICAgICAgICAgIC8vIEZpZ21hIGRlZmluaXRpb247IHRoZSBzb3VyY2UgZGVjaXNpb24gaXMgc2hhcmVkIHdpdGggdGhlIGltcG9ydGVyLlxyXG4gICAgICAgICAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgaWYgKGZpbmROb2RlKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKT8ucGF0Y2hDYW5kaWRhdGUpIHNob3dUb2FzdCgnRmlnbWEg5YiG54mH5LyY5YWI77yM5LiN6IO95YWz6Zet77yb5Y+v5Zyo5a+85YWl5pa55byP5Lit5b+955Wl5pW05Liq6IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuZGF0YXNldC5uYW1lRm9yO1xyXG4gICAgICAgIGlmICghaWQpIHJldHVybjtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseVByZXNldChidXR0b24uZGF0YXNldC5wcmVzZXQgPz8gJ3NtYXJ0JykpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFxyXG4gICAgICAgICcjc2NhbGUsICNhc3NldC1mb2xkZXIsICNwcmVmYWItZm9sZGVyLCAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLCAjdXBkYXRlLWV4aXN0aW5nLCAjcmVmcmVzaC1hc3NldHMsICNhdXRvLXNhdmUnLFxyXG4gICAgKS5mb3JFYWNoKChjb250cm9sKSA9PiB7XHJcbiAgICAgICAgY29udHJvbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmb250LW1hcC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcclxuICAgIGxpc3RlbmVyczoge1xyXG4gICAgICAgIHNob3coKSB7fSxcclxuICAgICAgICBoaWRlKCkge30sXHJcbiAgICB9LFxyXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0ZjgnKSxcclxuICAgIHN0eWxlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKSwgJ3V0ZjgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBhcHA6ICcjYXBwJyxcclxuICAgIH0sXHJcbiAgICBtZXRob2RzOiB7XHJcbiAgICAgICAgb25JbXBvcnRSZXZpZXdSZWFkeShyZXZpZXc6IEltcG9ydFJldmlldykge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHsgd29ya2Zsb3c/LnJlbWVtYmVyUmV2aWV3KCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSB8fCB3b3JrZmxvdz8ucGVuZGluZykge1xyXG4gICAgICAgICAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IHJldmlldztcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUoeyByZXZpZXcgfSk7XHJcbiAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBvblByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KSB7XHJcbiAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICB9LFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJlYWR5KCkge1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IHRoaXM7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWwgPSBuZXcgSW1wb3J0UmV2aWV3UGFuZWwocm9vdCgpLCByZXF1ZXN0LCBzZXRCdXN5KTtcclxuICAgICAgICB3b3JrZmxvdyA9IG5ldyBQYW5lbFdvcmtmbG93KHJvb3QoKSwgKCkgPT4gKHsgLi4uc3RhdGUsIGJhdGNoOiBiYXRjaENvbnRleHQoKSB9KSwgKHRhYikgPT4geyB2b2lkIG9wZW5JbXBvcnRSZXZpZXcodGFiKTsgfSk7XHJcbiAgICAgICAgYmluZEV2ZW50cygpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGluaXRpYWwgPSBhd2FpdCByZXF1ZXN0PHtcclxuICAgICAgICAgICAgICAgIHZlcnNpb24/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICB2YXVsdDogYW55O1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IERvY3VtZW50RHRvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgICAgICAgICAgfT4oJ2dldC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSA9IGluaXRpYWwudmVyc2lvbiA9PT0gcGFja2FnZUpTT04udmVyc2lvbjtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGluaXRpYWwuZm9udEFzc2V0cyA/PyBbXTtcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbihpbml0aWFsLnZhdWx0KTtcclxuICAgICAgICAgICAgYXBwbHlTZXR0aW5ncyhpbml0aWFsLnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluaXRpYWwuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgICAgIGluaXRpYWxpemVEb2N1bWVudChpbml0aWFsLmRvY3VtZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBiYXRjaCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTdGF0ZSB8IHVuZGVmaW5lZD4oJ2dldC1iYXRjaC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2g/Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKGJhdGNoLml0ZW1zKTtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBBcnJheS5mcm9tKG5ldyBNYXAoYmF0Y2guaXRlbXMuZmxhdE1hcCgoaXRlbSkgPT4gaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID8/IFtdKS5tYXAoKGZvbnQpID0+IFtmb250LnVybCwgZm9udF0pKS52YWx1ZXMoKSk7XHJcbiAgICAgICAgICAgICAgICB3b3JrZmxvdy5iYXRjaFJlYWR5KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBzZWxlY3RlZEZyYW1lcygpWzBdID8/IGJhdGNoSXRlbXNbMF07XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBhY3RpdmUuaXRlbS5pZDtcclxuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKHN0YXRlLCBhY3RpdmUuZWRpdG9yKTtcclxuICAgICAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7IHJlbmRlckZvbnRNYXAoKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBhd2FpdCBhY3RpdmF0ZUZyYW1lKGFjdGl2ZS5pdGVtLmlkKTtcclxuICAgICAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihiYXRjaC5sYXN0UmVzdWx0KTtcclxuICAgICAgICAgICAgICAgIGlmIChiYXRjaC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGJhdGNoLnJ1bm5pbmc7IHdvcmtmbG93LmJlZ2luKCdpbXBvcnQnKTsgc2V0QnVzeSh0cnVlKTsgd2F0Y2hSZXN0b3JlZEJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICAgICAgICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn6K+36YeN5ZCvIENvY29zJztcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihrsnO1xyXG4gICAgICAgICAgICAgICAgc2hvd1RvYXN0KCfmo4DmtYvliLDml6fniYjkuLvov5vnqIvku43lnKjov5DooYzvvJror7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gUmVwbGF5IHBlcnNpc3RlZCBpbi1tZW1vcnkgcmVwb3J0IGlmIGNvbXBsZXRpb24gcHJlY2VkZWQgcGFuZWwgcmVhZGluZXNzLlxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmV2aWV3ID0gYXdhaXQgcmVxdWVzdDxJbXBvcnRSZXZpZXcgfCBudWxsPignZ2V0LWltcG9ydC1yZXZpZXcnKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXZpZXcpIHdvcmtmbG93LnJlbWVtYmVyUmV2aWV3KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmV2aWV3ICYmICFyZXZpZXcuY29uZmlybWVkICYmICFiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHdvcmtmbG93LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5Yid5aeL5YyW5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuICAgIGJlZm9yZUNsb3NlKCkge30sXHJcbiAgICBjbG9zZSgpIHtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8uZGlzcG9zZSgpO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbnVsbDtcclxuICAgICAgICB3b3JrZmxvdyA9IG51bGw7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgaWYgKHRvYXN0VGltZXIpIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgICAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikgY2xlYXJUaW1lb3V0KGltcG9ydEJ1dHRvblJlc2V0VGltZXIpO1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIGJhdGNoSXRlbXMgPSBbXTsgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDsgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IGJhdGNoU3luY0Vycm9yID0gdW5kZWZpbmVkOyBiYXRjaFN5bmNUYXNrID0gUHJvbWlzZS5yZXNvbHZlKCk7IHByZXZpZXdSZXZpc2lvbisrO1xyXG4gICAgICAgIHByZXZpZXdSZWFkVGFzayA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19