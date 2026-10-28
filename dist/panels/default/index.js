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
const import_visibility_1 = require("../../import-visibility");
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
        importHiddenLayers: true,
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
function ignoredHiddenFrame(entry) {
    var _a;
    return state.settings.importHiddenLayers === false && ((_a = entry.item.document.tree[0]) === null || _a === void 0 ? void 0 : _a.visible) === false;
}
function availableFrames() { return batchItems.filter((entry) => !ignoredHiddenFrame(entry)); }
function selectedFrames() { return availableFrames().filter(({ item }) => item.enabled); }
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
    const effective = (0, model_1.resolveEffectiveActions)(document.tree, editor.preferredActions, editor.patches, editor.explicitIds, editor.renamedIds, state.settings.importHiddenLayers !== false);
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
        count: selectedFrames().length, total: availableFrames().length, nodes, selectedNodes,
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
    var _a, _b, _c;
    if (batchItems.length)
        return Array.from(new Set(selectedFrames().flatMap(({ item }) => item.document.fonts)));
    if (state.settings.importHiddenLayers === false && ((_a = state.document) === null || _a === void 0 ? void 0 : _a.tree.every((node) => node.visible === false)))
        return [];
    return (_c = (_b = state.document) === null || _b === void 0 ? void 0 : _b.fonts) !== null && _c !== void 0 ? _c : [];
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
    const available = availableFrames();
    const hiddenCount = batchItems.length - available.length;
    element('#batch-selected-count').textContent = `已选 ${selectedFrames().length} / ${available.length}`
        + (hiddenCount ? ` · ${hiddenCount} 个隐藏界面本次忽略` : '');
    element('#batch-toggle-all').textContent = available.length && selectedFrames().length === available.length ? '取消全选' : '全选';
    element('#batch-toggle-all').disabled = state.busy || available.length === 0;
    const list = element('#batch-source-list');
    const tabs = element('#batch-frame-tabs');
    const targets = element('#batch-target-list');
    list.replaceChildren();
    tabs.replaceChildren();
    targets.replaceChildren();
    const conflicts = batchConflicts();
    for (const entry of batchItems) {
        const { item } = entry;
        const hiddenIgnored = ignoredHiddenFrame(entry);
        const row = batchElement('div', '', `batch-item${item.enabled && !hiddenIgnored ? '' : ' is-disabled'}`);
        const checked = batchElement('input');
        checked.type = 'checkbox';
        checked.checked = item.enabled && !hiddenIgnored;
        checked.disabled = state.busy || hiddenIgnored;
        checked.dataset.batchChecked = item.id;
        checked.setAttribute('aria-label', `导入 ${frameName(entry)}`);
        checked.onchange = () => {
            if (state.busy || hiddenIgnored)
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
        if (hiddenIgnored)
            title.append(batchElement('span', '隐藏 · 本次忽略', 'badge subtle'));
        if (conflicts.has(item.id))
            title.append(batchElement('span', '名称冲突', 'batch-status-failed'));
        copy.append(title, batchElement('div', `${item.sectionName ? `${item.sectionName} / ` : ''}${item.document.fileName} · ${flatten(item.document.tree).length} 节点`, 'batch-item-meta'));
        const actions = batchElement('div', '', 'batch-item-actions');
        const configure = batchButton(hiddenIgnored ? '允许导入隐藏图层' : '调整节点', () => {
            if (hiddenIgnored) {
                void setImportHiddenLayers(true);
                return;
            }
            if (!item.enabled) {
                item.enabled = true;
                syncBatchItems();
            }
            void activateFrame(item.id, true);
        });
        if (hiddenIgnored)
            configure.title = '仅修改导入选项，不改变 Figma 图层的显隐；已有 Prefab 不会删除';
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
        if (!item.enabled || hiddenIgnored)
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
    element('#batch-active-status').textContent = active && ignoredHiddenFrame(active) ? '隐藏 · 本次忽略'
        : (active === null || active === void 0 ? void 0 : active.configured) ? '修改已保留' : '沿用智能默认';
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
        if (!alreadyActive && (loaded === null || loaded === void 0 ? void 0 : loaded.fontAssets)) {
            state.fontAssets = loaded.fontAssets;
            entry.item.document.fontAssets = loaded.fontAssets;
        }
        activeBatchId = id;
        if (entry.editor) {
            Object.assign(state, entry.editor);
            reconcileActions();
        }
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
/**
 * 组件同步预检。失败是正常情况（Frame 链接、文件链接、Prefab 尚不存在），
 * 静默清空即可，不影响导入本身。
 */
async function refreshSyncPreview() {
    if (!state.document) {
        state.syncPreview = undefined;
        workflow === null || workflow === void 0 ? void 0 : workflow.syncPreviewUpdated();
        return;
    }
    try {
        state.syncPreview = await request('sync-preview');
    }
    catch {
        state.syncPreview = undefined;
    }
    workflow === null || workflow === void 0 ? void 0 : workflow.syncPreviewUpdated();
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
    var _a;
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
        const hasMapping = Object.prototype.hasOwnProperty.call(state.settings.fontMap, family);
        const selected = hasMapping ? state.settings.fontMap[family] : (_a = automatic === null || automatic === void 0 ? void 0 : automatic.url) !== null && _a !== void 0 ? _a : '';
        if (selected && !state.fontAssets.some((asset) => asset.url === selected)) {
            // Assigning an unmatched select.value becomes empty in the real
            // renderer. Keep the persisted reference while AssetDB is indexing.
            select.appendChild(option(selected, `已保存（资源暂未就绪） · ${selected}`));
        }
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
    void refreshSyncPreview();
}
function applySettings(settings) {
    var _a, _b, _c;
    state.settings = { ...settings, fontMap: { ...settings.fontMap }, importHiddenLayers: settings.importHiddenLayers !== false };
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
    element('#import-hidden-layers').checked = state.settings.importHiddenLayers;
    updateTargetHint();
    renderFontMap();
    workflow === null || workflow === void 0 ? void 0 : workflow.render();
}
function readSettings(showError = true) {
    const fontMap = { ...state.settings.fontMap };
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
        importHiddenLayers: element('#import-hidden-layers').checked,
        fontMap,
    };
}
async function persistPanelSettings(settings) {
    state.settings = { ...settings, fontMap: { ...settings.fontMap } };
    await request('save-settings', state.settings);
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
    const effective = (0, model_1.resolveEffectiveActions)((_d = (_c = state.document) === null || _c === void 0 ? void 0 : _c.tree) !== null && _d !== void 0 ? _d : [], state.preferredActions, state.patches, state.explicitIds, state.renamedIds, state.settings.importHiddenLayers !== false);
    state.actions = effective.actions;
    state.suppressed = effective.suppressed;
}
function reconcileBatchVisibility() {
    var _a;
    rememberActiveFrame();
    for (const entry of batchItems) {
        if (!((_a = entry.editor) === null || _a === void 0 ? void 0 : _a.document))
            continue;
        const editor = entry.editor;
        const effective = (0, model_1.resolveEffectiveActions)(editor.document.tree, editor.preferredActions, editor.patches, editor.explicitIds, editor.renamedIds, state.settings.importHiddenLayers !== false);
        editor.actions = effective.actions;
        editor.suppressed = effective.suppressed;
    }
    reconcileActions();
    rememberActiveFrame();
}
async function setImportHiddenLayers(enabled) {
    var _a;
    if (state.busy)
        return;
    element('#import-hidden-layers').checked = enabled;
    const settings = (_a = readSettings(false)) !== null && _a !== void 0 ? _a : { ...state.settings, importHiddenLayers: enabled };
    state.settings = settings;
    reconcileBatchVisibility();
    renderTree();
    renderFontMap();
    updateSummary();
    await persistPanelSettings(settings);
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active && ignoredHiddenFrame(active) && selectedFrames().length)
        await activateFrame(selectedFrames()[0].item.id);
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
    var _a, _b, _c, _d;
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
    const hiddenIgnored = (0, import_visibility_1.hiddenLayerIds)((_d = (_c = state.document) === null || _c === void 0 ? void 0 : _c.tree) !== null && _d !== void 0 ? _d : [], state.settings.importHiddenLayers !== false).has(node.id);
    for (const text of [hiddenIgnored ? '隐藏图层 · 本次忽略（含其子树）；开启“导入隐藏图层”可恢复原策略' : undefined,
        summary.strategy, `Figma 原名：${node.name}`, summary.warning]) {
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
    var _a, _b, _c;
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
    state.settings = settings;
    reconcileBatchVisibility();
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
        const result = await request('import-selection', { overrides, settings, skipSyncNodeIds: (_a = workflow === null || workflow === void 0 ? void 0 : workflow.skippedSyncNodes) !== null && _a !== void 0 ? _a : [] });
        const fallbackNote = ((_b = result === null || result === void 0 ? void 0 : result.warnings) === null || _b === void 0 ? void 0 : _b.length)
            ? `；${result.warnings.length} 条导入/收尾提示（详见结果检查）`
            : '';
        showToast((result === null || result === void 0 ? void 0 : result.prefabUrl)
            ? `导入完成，已创建预制体：${result.prefabUrl}${fallbackNote}`
            : `导入完成，已在场景中选中根节点${fallbackNote}。`);
        workflow === null || workflow === void 0 ? void 0 : workflow.complete(result);
        const review = (_c = result.review) !== null && _c !== void 0 ? _c : pendingImportReview;
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
        // 导入后 Prefab 已经存在，刷新一次预检，下一次点开第 3 步就能看到差异。
        void refreshSyncPreview();
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
    state.settings = settings;
    reconcileBatchVisibility();
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
        const available = availableFrames();
        const enabled = selectedFrames().length !== available.length;
        available.forEach(({ item }) => { item.enabled = enabled; });
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
                await persistPanelSettings(settings);
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
                await persistPanelSettings(settings);
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
                    await persistPanelSettings(settings);
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
                await persistPanelSettings(settings);
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
    element('#import-hidden-layers').addEventListener('change', async () => {
        await setImportHiddenLayers(element('#import-hidden-layers').checked);
    });
    root().querySelectorAll('#scale, #asset-folder, #prefab-folder, #local-resource-folder, #update-existing, #refresh-assets, #auto-save').forEach((control) => {
        control.addEventListener('change', async () => {
            const settings = readSettings(false);
            if (settings) {
                await persistPanelSettings(settings);
            }
        });
    });
    element('#font-map-list').addEventListener('change', async (event) => {
        var _a, _b;
        const select = event.target;
        const family = (_a = select.dataset.fontFamily) === null || _a === void 0 ? void 0 : _a.trim();
        if (!family)
            return;
        // An empty string records an explicit opt-out from automatic matching.
        // Unrendered families and temporarily unavailable assets stay intact.
        state.settings = { ...state.settings, fontMap: { ...state.settings.fontMap, [family]: select.value } };
        const settings = (_b = readSettings(false)) !== null && _b !== void 0 ? _b : state.settings;
        await persistPanelSettings(settings);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQTJGO0FBRTNGLGtEQUEwRDtBQUcxRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCwrREFBeUU7QUFDekUsK0RBQXlEO0FBQ3pELG1DQVVpQjtBQXFFakIsSUFBSSxTQUFTLEdBQVEsSUFBSSxDQUFDO0FBQzFCLElBQUksaUJBQWlCLEdBQTZCLElBQUksQ0FBQztBQUN2RCxJQUFJLFFBQVEsR0FBeUIsSUFBSSxDQUFDO0FBQzFDLElBQUksbUJBQW1CLEdBQXdCLElBQUksQ0FBQztBQUNwRCxJQUFJLGlCQUFpQixHQUFHLEtBQUssQ0FBQztBQUM5QixJQUFJLFVBQVUsR0FBeUMsSUFBSSxDQUFDO0FBQzVELElBQUksc0JBQXNCLEdBQXlDLElBQUksQ0FBQztBQUN4RSxJQUFJLG9CQUFvQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDNUQsSUFBSSxxQkFBeUMsQ0FBQztBQUM5QyxJQUFJLGtCQUFzQyxDQUFDO0FBRzNDLElBQUksVUFBVSxHQUFzQixFQUFFLENBQUM7QUFDdkMsSUFBSSxhQUFpQyxDQUFDO0FBQ3RDLElBQUksV0FBMEMsQ0FBQztBQUMvQyxJQUFJLGFBQXdDLENBQUM7QUFDN0MsSUFBSSxhQUFhLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUNyRCxJQUFJLGNBQXVCLENBQUM7QUFDNUIsSUFBSSxrQkFBa0IsR0FBRyxLQUFLLENBQUM7QUFDL0IsSUFBSSxrQkFBa0IsR0FBRyxLQUFLLENBQUM7QUFDL0IsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO0FBQ3hCLElBQUksZUFBZSxHQUFxQixPQUFP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SyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3ZFLENBQUM7SUFDTCxDQUFDO0lBQ0QsV0FBVyxLQUFJLENBQUM7SUFDaEIsS0FBSztRQUNELGlCQUFpQixhQUFqQixpQkFBaUIsdUJBQWpCLGlCQUFpQixDQUFFLE9BQU8sRUFBRSxDQUFDO1FBQzdCLGlCQUFpQixHQUFHLElBQUksQ0FBQztRQUN6QixRQUFRLEdBQUcsSUFBSSxDQUFDO1FBQ2hCLG1CQUFtQixHQUFHLElBQUksQ0FBQztRQUMzQixJQUFJLFVBQVU7WUFBRSxZQUFZLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDekMsSUFBSSxzQkFBc0I7WUFBRSxZQUFZLENBQUMsc0JBQXNCLENBQUMsQ0FBQztRQUNqRSxJQUFJLGtCQUFrQjtZQUFFLFlBQVksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1FBQ3pELFVBQVUsR0FBRyxFQUFFLENBQUM7UUFBQyxhQUFhLEdBQUcsU0FBUyxDQUFDO1FBQUMsV0FBVyxHQUFHLFNBQVMsQ0FBQztRQUFDLGFBQWEsR0FBRyxTQUFTLENBQUM7UUFDL0Ysa0JBQWtCLEdBQUcsS0FBSyxDQUFDO1FBQUMsY0FBYyxHQUFHLFNBQVMsQ0FBQztRQUFDLGFBQWEsR0FBRyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7UUFBQyxlQUFlLEVBQUUsQ0FBQztRQUM3RyxlQUFlLEdBQUcsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BDLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFDckIsQ0FBQztDQUNKLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vLi4vLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UGFuZWwgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBQYW5lbFdvcmtmbG93LCB0eXBlIEJhdGNoV29ya2Zsb3dDb250ZXh0LCB0eXBlIFdvcmtmbG93UmVzdWx0IH0gZnJvbSAnLi93b3JrZmxvdyc7XHJcbmltcG9ydCB0eXBlIHsgQmF0Y2hGcmFtZUl0ZW0sIEJhdGNoSW1wb3J0SXRlbVJlc3VsdCwgQmF0Y2hJbXBvcnRSZXN1bHQsIEJhdGNoUHJvZ3Jlc3MsIEJhdGNoU291cmNlUmVzdWx0LCBCYXRjaFN0YXRlIH0gZnJvbSAnLi4vLi4vYmF0Y2gtdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZUFzc2V0TmFtZSB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB0eXBlIHsgU3luY1ByZXZpZXdSZXN1bHQgfSBmcm9tICcuLi8uLi9pbXBvcnRlci9zeW5jLXByZXZpZXcnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldyB9IGZyb20gJy4uLy4uL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5pbXBvcnQgeyBmaW5kRm9udEFzc2V0LCB0eXBlIEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgbm9ybWFsaXplSW1wb3J0QWN0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi4vLi4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uIH0gZnJvbSAnLi4vLi4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQgeyBoaWRkZW5MYXllcklkcyB9IGZyb20gJy4uLy4uL2ltcG9ydC12aXNpYmlsaXR5JztcclxuaW1wb3J0IHtcclxuICAgIGFjdGlvbk9wdGlvbnNGb3JOb2RlLFxyXG4gICAgZGVmYXVsdE5pbmVTbGljZUlkcyxcclxuICAgIGVmZmVjdGl2ZUtpbmRGb3JOb2RlLFxyXG4gICAgaXNWZWN0b3JOb2RlVHlwZSxcclxuICAgIGtpbmRPcHRpb25zRm9yQWN0aW9uLFxyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsLFxyXG4gICAgcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMsXHJcbiAgICBzbWFydEFjdGlvbkZvck5vZGUsXHJcbiAgICBzdHJhdGVneVN1bW1hcnlGb3JOb2RlLFxyXG59IGZyb20gJy4vbW9kZWwnO1xyXG5pbXBvcnQgdHlwZSB7XHJcbiAgICBJbXBvcnRBY3Rpb24sXHJcbiAgICBJbXBvcnRPdmVycmlkZSxcclxuICAgIEltcG9ydFNldHRpbmdzLFxyXG4gICAgTm9kZUtpbmQsXHJcbiAgICBQcm9ncmVzc0V2ZW50LFxyXG4gICAgVHJlZU5vZGVEdG8sXHJcbn0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuaW50ZXJmYWNlIERvY3VtZW50RHRvIHtcclxuICAgIGZpbGVLZXk6IHN0cmluZztcclxuICAgIGZpbGVOYW1lOiBzdHJpbmc7XHJcbiAgICBzb3VyY2VVcmw6IHN0cmluZztcclxuICAgIHRyZWU6IFRyZWVOb2RlRHRvW107XHJcbiAgICBmb250czogc3RyaW5nW107XHJcbiAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICBub2RlT3ZlcnJpZGVzPzogSW1wb3J0T3ZlcnJpZGVbXTtcclxufVxyXG5cclxuaW50ZXJmYWNlIFJvdW5kdHJpcERldGVjdER0byB7XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIG1hbmFnZWRSb290czogQXJyYXk8eyBub2RlSWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwcmVmYWJVdWlkPzogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PjtcclxuICAgIHNlbGVjdGVkUm9vdElkPzogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwUHJldmlld0R0byB7XHJcbiAgICBwcmV2aWV3VG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyVG9rZW4/OiBzdHJpbmc7XHJcbiAgICBwYWlyUmVxdWlyZWQ6IGJvb2xlYW47XHJcbiAgICBwYWlyRWxpZ2libGU6IGJvb2xlYW47XHJcbiAgICBmaWdtYVZlcnNpb246IHN0cmluZztcclxuICAgIHN1cmZhY2VJZDogc3RyaW5nO1xyXG4gICAgcHJlZmFiVXVpZDogc3RyaW5nO1xyXG4gICAgYXNzZXRVcmw6IHN0cmluZztcclxuICAgIGxlZGdlckdlbmVyYXRpb246IG51bWJlcjtcclxuICAgIGJsb2NrZXJzOiBzdHJpbmdbXTtcclxuICAgIHBsYW46IHtcclxuICAgICAgICBhcHBseTogdW5rbm93bltdO1xyXG4gICAgICAgIHByZXNlcnZlQ29jb3M6IHVua25vd25bXTtcclxuICAgICAgICBjb252ZXJnZWQ6IHVua25vd25bXTtcclxuICAgICAgICBjb25mbGljdHM6IHVua25vd25bXTtcclxuICAgICAgICB1bnN1cHBvcnRlZDogdW5rbm93bltdO1xyXG4gICAgICAgIHJlYWRvbmx5VW5jaGFuZ2VkOiB1bmtub3duW107XHJcbiAgICB9O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGFuZWxTdGF0ZSB7XHJcbiAgICBkb2N1bWVudDogRG9jdW1lbnREdG8gfCBudWxsO1xyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgcHJlZmVycmVkQWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGFjdGlvbnM6IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj47XHJcbiAgICBraW5kczogTWFwPHN0cmluZywgTm9kZUtpbmQ+O1xyXG4gICAgcGF0Y2hlczogU2V0PHN0cmluZz47XHJcbiAgICBleHBsaWNpdElkczogU2V0PHN0cmluZz47XHJcbiAgICBuYW1lczogTWFwPHN0cmluZywgc3RyaW5nPjtcclxuICAgIHJlbmFtZWRJZHM6IFNldDxzdHJpbmc+O1xyXG4gICAgZGVmYXVsdHM6IE1hcDxzdHJpbmcsIHsgYWN0aW9uOiBJbXBvcnRBY3Rpb247IGtpbmQ6IE5vZGVLaW5kIH0+O1xyXG4gICAgY29sbGFwc2VkOiBTZXQ8c3RyaW5nPjtcclxuICAgIHN1cHByZXNzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc2VsZWN0ZWRJZD86IHN0cmluZztcclxuICAgIHNlYXJjaDogc3RyaW5nO1xyXG4gICAgYnVzeTogYm9vbGVhbjtcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiBib29sZWFuO1xyXG4gICAgZm9udEFzc2V0czogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICAvKiog57uE5Lu25ZCM5q2l6aKE5qOA77yb5Y2V6IqC54K557uE5Lu26ZO+5o6l5omN5a2Y5Zyo44CCICovXHJcbiAgICBzeW5jUHJldmlldz86IFN5bmNQcmV2aWV3UmVzdWx0O1xyXG59XHJcblxyXG5sZXQgcGFuZWxIb3N0OiBhbnkgPSBudWxsO1xyXG5sZXQgaW1wb3J0UmV2aWV3UGFuZWw6IEltcG9ydFJldmlld1BhbmVsIHwgbnVsbCA9IG51bGw7XHJcbmxldCB3b3JrZmxvdzogUGFuZWxXb3JrZmxvdyB8IG51bGwgPSBudWxsO1xyXG5sZXQgcGVuZGluZ0ltcG9ydFJldmlldzogSW1wb3J0UmV2aWV3IHwgbnVsbCA9IG51bGw7XHJcbmxldCBmb3JjZURvY3VtZW50UmVhZCA9IGZhbHNlO1xyXG5sZXQgdG9hc3RUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxubGV0IGltcG9ydEJ1dHRvblJlc2V0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBub2RlT3ZlcnJpZGVTYXZlVGFzazogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgcm91bmR0cmlwUHJldmlld1Rva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbmxldCByb3VuZHRyaXBQYWlyVG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcclxudHlwZSBGcmFtZUVkaXRvclN0YXRlID0gUGljazxQYW5lbFN0YXRlLCAnZG9jdW1lbnQnIHwgJ3ByZWZlcnJlZEFjdGlvbnMnIHwgJ2FjdGlvbnMnIHwgJ2tpbmRzJyB8ICdwYXRjaGVzJyB8ICdleHBsaWNpdElkcycgfCAnbmFtZXMnIHwgJ3JlbmFtZWRJZHMnIHwgJ2RlZmF1bHRzJyB8ICdjb2xsYXBzZWQnIHwgJ3N1cHByZXNzZWQnIHwgJ3NlbGVjdGVkSWQnIHwgJ3NlYXJjaCc+ICYgeyB0cmVlU2Nyb2xsOiBudW1iZXI7IHByZXNldD86IHN0cmluZyB9O1xyXG5pbnRlcmZhY2UgRnJhbWVFZGl0b3JJdGVtIHsgaXRlbTogQmF0Y2hGcmFtZUl0ZW07IGVkaXRvcj86IEZyYW1lRWRpdG9yU3RhdGU7IGNvbmZpZ3VyZWQ6IGJvb2xlYW4gfVxyXG5sZXQgYmF0Y2hJdGVtczogRnJhbWVFZGl0b3JJdGVtW10gPSBbXTtcclxubGV0IGFjdGl2ZUJhdGNoSWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxubGV0IGJhdGNoUmVzdWx0OiBCYXRjaEltcG9ydFJlc3VsdCB8IHVuZGVmaW5lZDtcclxubGV0IGJhdGNoUHJvZ3Jlc3M6IEJhdGNoUHJvZ3Jlc3MgfCB1bmRlZmluZWQ7XHJcbmxldCBiYXRjaFN5bmNUYXNrOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCBiYXRjaFN5bmNFcnJvcjogdW5rbm93bjtcclxubGV0IGJhdGNoSW1wb3J0UGVuZGluZyA9IGZhbHNlO1xyXG5sZXQgYmF0Y2hTdG9wUmVxdWVzdGVkID0gZmFsc2U7XHJcbmxldCBwcmV2aWV3UmV2aXNpb24gPSAwO1xyXG5sZXQgcHJldmlld1JlYWRUYXNrOiBQcm9taXNlPHVua25vd24+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcbmxldCBiYXRjaFJlY292ZXJ5VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG5jb25zdCBzdGF0ZTogUGFuZWxTdGF0ZSA9IHtcclxuICAgIGRvY3VtZW50OiBudWxsLFxyXG4gICAgc2V0dGluZ3M6IHtcclxuICAgICAgICBzb3VyY2VVcmw6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXInLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyL3ByZWZhYnMnLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBbXSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiAnJyxcclxuICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBmYWxzZSxcclxuICAgICAgICBhdXRvU2F2ZTogZmFsc2UsXHJcbiAgICAgICAgaW1wb3J0SGlkZGVuTGF5ZXJzOiB0cnVlLFxyXG4gICAgICAgIGZvbnRNYXA6IHt9LFxyXG4gICAgfSxcclxuICAgIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoKSxcclxuICAgIGFjdGlvbnM6IG5ldyBNYXAoKSxcclxuICAgIGtpbmRzOiBuZXcgTWFwKCksXHJcbiAgICBwYXRjaGVzOiBuZXcgU2V0KCksXHJcbiAgICBleHBsaWNpdElkczogbmV3IFNldCgpLFxyXG4gICAgbmFtZXM6IG5ldyBNYXAoKSxcclxuICAgIHJlbmFtZWRJZHM6IG5ldyBTZXQoKSxcclxuICAgIGRlZmF1bHRzOiBuZXcgTWFwKCksXHJcbiAgICBjb2xsYXBzZWQ6IG5ldyBTZXQoKSxcclxuICAgIHN1cHByZXNzZWQ6IG5ldyBTZXQoKSxcclxuICAgIHNlYXJjaDogJycsXHJcbiAgICBidXN5OiBmYWxzZSxcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiB0cnVlLFxyXG4gICAgZm9udEFzc2V0czogW10sXHJcbn07XHJcblxyXG5mdW5jdGlvbiBpZ25vcmVkSGlkZGVuRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSk6IGJvb2xlYW4ge1xyXG4gICAgcmV0dXJuIHN0YXRlLnNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVycyA9PT0gZmFsc2UgJiYgZW50cnkuaXRlbS5kb2N1bWVudC50cmVlWzBdPy52aXNpYmxlID09PSBmYWxzZTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXZhaWxhYmxlRnJhbWVzKCk6IEZyYW1lRWRpdG9ySXRlbVtdIHsgcmV0dXJuIGJhdGNoSXRlbXMuZmlsdGVyKChlbnRyeSkgPT4gIWlnbm9yZWRIaWRkZW5GcmFtZShlbnRyeSkpOyB9XHJcblxyXG5mdW5jdGlvbiBzZWxlY3RlZEZyYW1lcygpOiBGcmFtZUVkaXRvckl0ZW1bXSB7IHJldHVybiBhdmFpbGFibGVGcmFtZXMoKS5maWx0ZXIoKHsgaXRlbSB9KSA9PiBpdGVtLmVuYWJsZWQpOyB9XHJcblxyXG5mdW5jdGlvbiBlZGl0b3JTbmFwc2hvdCgpOiBGcmFtZUVkaXRvclN0YXRlIHtcclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgZG9jdW1lbnQ6IHN0YXRlLmRvY3VtZW50LFxyXG4gICAgICAgIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoc3RhdGUucHJlZmVycmVkQWN0aW9ucyksIGFjdGlvbnM6IG5ldyBNYXAoc3RhdGUuYWN0aW9ucyksXHJcbiAgICAgICAga2luZHM6IG5ldyBNYXAoc3RhdGUua2luZHMpLCBwYXRjaGVzOiBuZXcgU2V0KHN0YXRlLnBhdGNoZXMpLCBleHBsaWNpdElkczogbmV3IFNldChzdGF0ZS5leHBsaWNpdElkcyksXHJcbiAgICAgICAgbmFtZXM6IG5ldyBNYXAoc3RhdGUubmFtZXMpLCByZW5hbWVkSWRzOiBuZXcgU2V0KHN0YXRlLnJlbmFtZWRJZHMpLCBkZWZhdWx0czogbmV3IE1hcChzdGF0ZS5kZWZhdWx0cyksXHJcbiAgICAgICAgY29sbGFwc2VkOiBuZXcgU2V0KHN0YXRlLmNvbGxhcHNlZCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoc3RhdGUuc3VwcHJlc3NlZCksXHJcbiAgICAgICAgc2VsZWN0ZWRJZDogc3RhdGUuc2VsZWN0ZWRJZCwgc2VhcmNoOiBzdGF0ZS5zZWFyY2gsIHRyZWVTY3JvbGw6IGVsZW1lbnQoJyN0cmVlJykuc2Nyb2xsVG9wLFxyXG4gICAgICAgIHByZXNldDogQXJyYXkuZnJvbShyb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKSkuZmluZCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LmNvbnRhaW5zKCdhY3RpdmUnKSk/LmRhdGFzZXQucHJlc2V0LFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbEZyYW1lRWRpdG9yKGRvY3VtZW50OiBEb2N1bWVudER0byk6IEZyYW1lRWRpdG9yU3RhdGUge1xyXG4gICAgY29uc3QgZWRpdG9yOiBGcmFtZUVkaXRvclN0YXRlID0ge1xyXG4gICAgICAgIGRvY3VtZW50LCBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksIGFjdGlvbnM6IG5ldyBNYXAoKSwga2luZHM6IG5ldyBNYXAoKSxcclxuICAgICAgICBwYXRjaGVzOiBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpLCBleHBsaWNpdElkczogbmV3IFNldCgpLCBuYW1lczogbmV3IE1hcCgpLCByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICAgICAgZGVmYXVsdHM6IG5ldyBNYXAoKSwgY29sbGFwc2VkOiBuZXcgU2V0KCksIHN1cHByZXNzZWQ6IG5ldyBTZXQoKSwgc2VsZWN0ZWRJZDogZG9jdW1lbnQudHJlZVswXT8uaWQsXHJcbiAgICAgICAgc2VhcmNoOiAnJywgdHJlZVNjcm9sbDogMCwgcHJlc2V0OiAnc21hcnQnLFxyXG4gICAgfTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBhY3Rpb24pOyBlZGl0b3Iua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgZWRpdG9yLmRlZmF1bHRzLnNldChub2RlLmlkLCB7IGFjdGlvbiwga2luZDogbm9kZS5raW5kIH0pOyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IG92ZXJyaWRlIG9mIGRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUob3ZlcnJpZGUuaWQsIGRvY3VtZW50LnRyZWUpOyBpZiAoIW5vZGUpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChuYW1lICYmIG5hbWUgIT09IG5vZGUubmFtZSkgeyBlZGl0b3IubmFtZXMuc2V0KG5vZGUuaWQsIG5hbWUpOyBlZGl0b3IucmVuYW1lZElkcy5hZGQobm9kZS5pZCk7IH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQpIHtcclxuICAgICAgICAgICAgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7IGVkaXRvci5raW5kcy5zZXQobm9kZS5pZCwgb3ZlcnJpZGUua2luZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlLnBhdGNoQ2FuZGlkYXRlKSBlZGl0b3IucGF0Y2hlcy5hZGQobm9kZS5pZCk7IGVsc2UgZWRpdG9yLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICBlZGl0b3IuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpOyBlZGl0b3IucHJlc2V0ID0gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGRvY3VtZW50LnRyZWUsIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLCBlZGl0b3IucGF0Y2hlcywgZWRpdG9yLmV4cGxpY2l0SWRzLCBlZGl0b3IucmVuYW1lZElkcyxcclxuICAgICAgICBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlKTtcclxuICAgIGVkaXRvci5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7IGVkaXRvci5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbiAgICByZXR1cm4gZWRpdG9yO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1lbWJlckFjdGl2ZUZyYW1lKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBpZiAoYWN0aXZlKSBhY3RpdmUuZWRpdG9yID0gZWRpdG9yU25hcHNob3QoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVOYW1lKGVudHJ5OiBGcmFtZUVkaXRvckl0ZW0pOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZWRpdG9yID0gZW50cnkuaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCA/IHN0YXRlIDogZW50cnkuZWRpdG9yO1xyXG4gICAgcmV0dXJuIGVkaXRvcj8ubmFtZXMuZ2V0KGVudHJ5Lml0ZW0ucm9vdElkKSA/PyBlbnRyeS5pdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXM/LmZpbmQoKG92ZXJyaWRlKSA9PiBvdmVycmlkZS5pZCA9PT0gZW50cnkuaXRlbS5yb290SWQpPy5uYW1lID8/IGVudHJ5Lml0ZW0ubmFtZTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hDb25mbGljdHMoKTogU2V0PHN0cmluZz4ge1xyXG4gICAgY29uc3QgbmFtZXMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNlbGVjdGVkRnJhbWVzKCkpIHtcclxuICAgICAgICBjb25zdCBrZXkgPSBzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUoZW50cnkpKS50b0xvY2FsZUxvd2VyQ2FzZSgpO1xyXG4gICAgICAgIG5hbWVzLnNldChrZXksIFsuLi4obmFtZXMuZ2V0KGtleSkgPz8gW10pLCBlbnRyeS5pdGVtLmlkXSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbmV3IFNldChBcnJheS5mcm9tKG5hbWVzLnZhbHVlcygpKS5maWx0ZXIoKGlkcykgPT4gaWRzLmxlbmd0aCA+IDEpLmZsYXQoKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQ29udGV4dCgpOiBCYXRjaFdvcmtmbG93Q29udGV4dCB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoIWJhdGNoSXRlbXMubGVuZ3RoKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgbGV0IG5vZGVzID0gMDtcclxuICAgIGxldCBzZWxlY3RlZE5vZGVzID0gMDtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc2VsZWN0ZWRGcmFtZXMoKSkge1xyXG4gICAgICAgIGNvbnN0IGVkaXRvciA9IGVudHJ5Lml0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQgPyBzdGF0ZSA6IGVudHJ5LmVkaXRvcjtcclxuICAgICAgICBjb25zdCBhbGwgPSBmbGF0dGVuKGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgbm9kZXMgKz0gYWxsLmxlbmd0aDtcclxuICAgICAgICBzZWxlY3RlZE5vZGVzICs9IGFsbC5maWx0ZXIoKG5vZGUpID0+IChlZGl0b3I/LmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKSAhPT0gJ2lnbm9yZScpLmxlbmd0aDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgY291bnQ6IHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoLCB0b3RhbDogYXZhaWxhYmxlRnJhbWVzKCkubGVuZ3RoLCBub2Rlcywgc2VsZWN0ZWROb2RlcyxcclxuICAgICAgICBjb25mbGljdHM6IGJhdGNoQ29uZmxpY3RzKCkuc2l6ZSA+IDAsXHJcbiAgICAgICAgLi4uKGJhdGNoUmVzdWx0ID8geyByZXN1bHQ6IHtcclxuICAgICAgICAgICAgc3VjY2VzczogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIGZhaWxlZDogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCxcclxuICAgICAgICAgICAgcGVuZGluZzogYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3BlbmRpbmcnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHN0b3BwZWQ6IGJhdGNoUmVzdWx0LnN0b3BwZWQsXHJcbiAgICAgICAgfSB9IDoge30pLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hGb250cygpOiBzdHJpbmdbXSB7XHJcbiAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHJldHVybiBBcnJheS5mcm9tKG5ldyBTZXQoc2VsZWN0ZWRGcmFtZXMoKS5mbGF0TWFwKCh7IGl0ZW0gfSkgPT4gaXRlbS5kb2N1bWVudC5mb250cykpKTtcclxuICAgIGlmIChzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgPT09IGZhbHNlICYmIHN0YXRlLmRvY3VtZW50Py50cmVlLmV2ZXJ5KChub2RlKSA9PiBub2RlLnZpc2libGUgPT09IGZhbHNlKSkgcmV0dXJuIFtdO1xyXG4gICAgcmV0dXJuIHN0YXRlLmRvY3VtZW50Py5mb250cyA/PyBbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gc3luY0JhdGNoSXRlbXMocHJlY2VkaW5nUHJldmlldzogUHJvbWlzZTx1bmtub3duPiA9IHByZXZpZXdSZWFkVGFzayk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgaXRlbXMgPSBiYXRjaEl0ZW1zLm1hcCgoeyBpdGVtIH0pID0+ICh7IGlkOiBpdGVtLmlkLCBlbmFibGVkOiBpdGVtLmVuYWJsZWQgfSkpO1xyXG4gICAgYmF0Y2hTeW5jVGFzayA9IGJhdGNoU3luY1Rhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKS50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBwcmVjZWRpbmdQcmV2aWV3LmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgYXdhaXQgcmVxdWVzdCgnc3luYy1iYXRjaC1pdGVtcycsIGl0ZW1zKTtcclxuICAgICAgICBiYXRjaFN5bmNFcnJvciA9IHVuZGVmaW5lZDtcclxuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgIGJhdGNoU3luY0Vycm9yID0gZXJyb3I7XHJcbiAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+eVjOmdouWIl+ihqOS/neWtmOWksei0pe+8jOivt+mHjeivleOAgicpLCB0cnVlKTtcclxuICAgIH0pO1xyXG4gICAgcmV0dXJuIGJhdGNoU3luY1Rhc2s7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JCYXRjaExpc3RSZWFkeSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIC8vIFNuYXBzaG90IGJvdGggZGVwZW5kZW5jaWVzIGJlZm9yZSB3YWl0aW5nLiBMYXRlciBwcmV2aWV3cyBtYXkgdGhlbXNlbHZlc1xyXG4gICAgLy8gd2FpdCBmb3IgYSBuZXdseSBxdWV1ZWQgc3luYywgc28gbmV2ZXIgbWFrZSB0aGF0IHN5bmMgZGVwZW5kIG9uIHRoZW0uXHJcbiAgICBjb25zdCBwcmVjZWRpbmdTeW5jID0gYmF0Y2hTeW5jVGFzaztcclxuICAgIGNvbnN0IHByZWNlZGluZ1ByZXZpZXcgPSBwcmV2aWV3UmVhZFRhc2s7XHJcbiAgICBhd2FpdCBwcmVjZWRpbmdTeW5jO1xyXG4gICAgYXdhaXQgcHJlY2VkaW5nUHJldmlldy5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgaWYgKGJhdGNoU3luY0Vycm9yKSB7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXNNZXNzYWdlID0gZXJyb3JNZXNzYWdlKGJhdGNoU3luY0Vycm9yLCAn55WM6Z2i5YiX6KGo5L+d5a2Y5aSx6LSl77yM6K+36YeN6K+V44CCJyk7XHJcbiAgICAgICAgLy8gQSBmYWlsZWQgc2F2ZSBsZWF2ZXMgdGhlIG9wdGltaXN0aWMgbGlzdCB1bmNvbmZpcm1lZC4gUmV0cnkgaXRzIGxhdGVzdFxyXG4gICAgICAgIC8vIGNvbnRlbnRzIG9uY2U7IG9ubHkgYSBzdWNjZXNzZnVsIGJhY2tlbmQgYWNrbm93bGVkZ2VtZW50IGNsZWFycyBpdC5cclxuICAgICAgICBhd2FpdCBzeW5jQmF0Y2hJdGVtcyhwcmVjZWRpbmdQcmV2aWV3KTtcclxuICAgICAgICBpZiAoYmF0Y2hTeW5jRXJyb3IpIHRocm93IGJhdGNoU3luY0Vycm9yO1xyXG4gICAgICAgIGlmIChlbGVtZW50KCcjd29ya2Zsb3ctZXJyb3ItbWVzc2FnZScpLnRleHRDb250ZW50ID09PSBwcmV2aW91c01lc3NhZ2UpIHdvcmtmbG93Py5jbGVhckVycm9yKCk7XHJcbiAgICAgICAgaWYgKGVsZW1lbnQoJyN0b2FzdCcpLnRleHRDb250ZW50ID09PSBwcmV2aW91c01lc3NhZ2UpIHNob3dUb2FzdCgn55WM6Z2i5YiX6KGo5bey5ZCM5q2l77yM5Y+v5Lul57un57ut44CCJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoRWxlbWVudDxLIGV4dGVuZHMga2V5b2YgSFRNTEVsZW1lbnRUYWdOYW1lTWFwPih0YWc6IEssIHRleHQgPSAnJywgY2xhc3NOYW1lID0gJycpOiBIVE1MRWxlbWVudFRhZ05hbWVNYXBbS10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XHJcbiAgICB2YWx1ZS50ZXh0Q29udGVudCA9IHRleHQ7XHJcbiAgICB2YWx1ZS5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQnV0dG9uKHRleHQ6IHN0cmluZywgYWN0aW9uOiAoKSA9PiB2b2lkLCBjbGFzc05hbWUgPSAndGV4dC1idXR0b24nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gYmF0Y2hFbGVtZW50KCdidXR0b24nLCB0ZXh0LCBjbGFzc05hbWUpO1xyXG4gICAgYnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBidXR0b24ub25jbGljayA9IGFjdGlvbjtcclxuICAgIHJldHVybiBidXR0b247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckJhdGNoKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZW5hYmxlZCA9IGJhdGNoSXRlbXMubGVuZ3RoID4gMDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1zb3VyY2UtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtZnJhbWUtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZCB8fCAoIWJhdGNoUmVzdWx0ICYmICFiYXRjaFByb2dyZXNzKTtcclxuICAgIGNvbnN0IGdlbmVyaWNSZXZpZXcgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5yZXN1bHQtcmV2aWV3Jyk7XHJcbiAgICBpZiAoZ2VuZXJpY1JldmlldykgZ2VuZXJpY1Jldmlldy5oaWRkZW4gPSBlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI3ByZXNldC1zY29wZScpLnRleHRDb250ZW50ID0gZW5hYmxlZCA/ICfku4XkvZznlKjkuo7lvZPliY3nlYzpnaInIDogJ+S9nOeUqOS6juWFqOmDqOiKgueCuSc7XHJcbiAgICBjb25zdCBhdmFpbGFibGUgPSBhdmFpbGFibGVGcmFtZXMoKTtcclxuICAgIGNvbnN0IGhpZGRlbkNvdW50ID0gYmF0Y2hJdGVtcy5sZW5ndGggLSBhdmFpbGFibGUubGVuZ3RoO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXNlbGVjdGVkLWNvdW50JykudGV4dENvbnRlbnQgPSBg5bey6YCJICR7c2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGh9IC8gJHthdmFpbGFibGUubGVuZ3RofWBcclxuICAgICAgICArIChoaWRkZW5Db3VudCA/IGAgwrcgJHtoaWRkZW5Db3VudH0g5Liq6ZqQ6JeP55WM6Z2i5pys5qyh5b+955WlYCA6ICcnKTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYmF0Y2gtdG9nZ2xlLWFsbCcpLnRleHRDb250ZW50ID0gYXZhaWxhYmxlLmxlbmd0aCAmJiBzZWxlY3RlZEZyYW1lcygpLmxlbmd0aCA9PT0gYXZhaWxhYmxlLmxlbmd0aCA/ICflj5bmtojlhajpgIknIDogJ+WFqOmAiSc7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXRvZ2dsZS1hbGwnKS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3kgfHwgYXZhaWxhYmxlLmxlbmd0aCA9PT0gMDtcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjYmF0Y2gtc291cmNlLWxpc3QnKTtcclxuICAgIGNvbnN0IHRhYnMgPSBlbGVtZW50KCcjYmF0Y2gtZnJhbWUtdGFicycpO1xyXG4gICAgY29uc3QgdGFyZ2V0cyA9IGVsZW1lbnQoJyNiYXRjaC10YXJnZXQtbGlzdCcpO1xyXG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTsgdGFicy5yZXBsYWNlQ2hpbGRyZW4oKTsgdGFyZ2V0cy5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGNvbnN0IGNvbmZsaWN0cyA9IGJhdGNoQ29uZmxpY3RzKCk7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGJhdGNoSXRlbXMpIHtcclxuICAgICAgICBjb25zdCB7IGl0ZW0gfSA9IGVudHJ5O1xyXG4gICAgICAgIGNvbnN0IGhpZGRlbklnbm9yZWQgPSBpZ25vcmVkSGlkZGVuRnJhbWUoZW50cnkpO1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsIGBiYXRjaC1pdGVtJHtpdGVtLmVuYWJsZWQgJiYgIWhpZGRlbklnbm9yZWQgPyAnJyA6ICcgaXMtZGlzYWJsZWQnfWApO1xyXG4gICAgICAgIGNvbnN0IGNoZWNrZWQgPSBiYXRjaEVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICAgICAgY2hlY2tlZC50eXBlID0gJ2NoZWNrYm94JzsgY2hlY2tlZC5jaGVja2VkID0gaXRlbS5lbmFibGVkICYmICFoaWRkZW5JZ25vcmVkOyBjaGVja2VkLmRpc2FibGVkID0gc3RhdGUuYnVzeSB8fCBoaWRkZW5JZ25vcmVkO1xyXG4gICAgICAgIGNoZWNrZWQuZGF0YXNldC5iYXRjaENoZWNrZWQgPSBpdGVtLmlkO1xyXG4gICAgICAgIGNoZWNrZWQuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYOWvvOWFpSAke2ZyYW1lTmFtZShlbnRyeSl9YCk7XHJcbiAgICAgICAgY2hlY2tlZC5vbmNoYW5nZSA9ICgpID0+IHtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLmJ1c3kgfHwgaGlkZGVuSWdub3JlZCkgcmV0dXJuO1xyXG4gICAgICAgICAgICBpdGVtLmVuYWJsZWQgPSBjaGVja2VkLmNoZWNrZWQ7XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7XHJcbiAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQmF0Y2hJZCA9PT0gaXRlbS5pZCAmJiAhaXRlbS5lbmFibGVkICYmIHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSB2b2lkIGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWRGcmFtZXMoKVswXS5pdGVtLmlkKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IGNvcHkgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1jb3B5Jyk7XHJcbiAgICAgICAgY29uc3QgdGl0bGUgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS10aXRsZScpO1xyXG4gICAgICAgIHRpdGxlLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBmcmFtZU5hbWUoZW50cnkpKSwgYmF0Y2hFbGVtZW50KCdzcGFuJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4nIDogJ+aZuuiDvem7mOiupCcsIGBiYWRnZSR7ZW50cnkuY29uZmlndXJlZCA/ICcnIDogJyBzdWJ0bGUnfWApKTtcclxuICAgICAgICBpZiAoaGlkZGVuSWdub3JlZCkgdGl0bGUuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsICfpmpDol48gwrcg5pys5qyh5b+955WlJywgJ2JhZGdlIHN1YnRsZScpKTtcclxuICAgICAgICBpZiAoY29uZmxpY3RzLmhhcyhpdGVtLmlkKSkgdGl0bGUuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsICflkI3np7DlhrLnqoEnLCAnYmF0Y2gtc3RhdHVzLWZhaWxlZCcpKTtcclxuICAgICAgICBjb3B5LmFwcGVuZCh0aXRsZSwgYmF0Y2hFbGVtZW50KCdkaXYnLCBgJHtpdGVtLnNlY3Rpb25OYW1lID8gYCR7aXRlbS5zZWN0aW9uTmFtZX0gLyBgIDogJyd9JHtpdGVtLmRvY3VtZW50LmZpbGVOYW1lfSDCtyAke2ZsYXR0ZW4oaXRlbS5kb2N1bWVudC50cmVlKS5sZW5ndGh9IOiKgueCuWAsICdiYXRjaC1pdGVtLW1ldGEnKSk7XHJcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWFjdGlvbnMnKTtcclxuICAgICAgICBjb25zdCBjb25maWd1cmUgPSBiYXRjaEJ1dHRvbihoaWRkZW5JZ25vcmVkID8gJ+WFgeiuuOWvvOWFpemakOiXj+WbvuWxgicgOiAn6LCD5pW06IqC54K5JywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoaGlkZGVuSWdub3JlZCkgeyB2b2lkIHNldEltcG9ydEhpZGRlbkxheWVycyh0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICAgICAgICAgIGlmICghaXRlbS5lbmFibGVkKSB7IGl0ZW0uZW5hYmxlZCA9IHRydWU7IHN5bmNCYXRjaEl0ZW1zKCk7IH1cclxuICAgICAgICAgICAgdm9pZCBhY3RpdmF0ZUZyYW1lKGl0ZW0uaWQsIHRydWUpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChoaWRkZW5JZ25vcmVkKSBjb25maWd1cmUudGl0bGUgPSAn5LuF5L+u5pS55a+85YWl6YCJ6aG577yM5LiN5pS55Y+YIEZpZ21hIOWbvuWxgueahOaYvumakO+8m+W3suaciSBQcmVmYWIg5LiN5Lya5Yig6ZmkJztcclxuICAgICAgICBjb25maWd1cmUuZGF0YXNldC5iYXRjaENvbmZpZ3VyZSA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gYmF0Y2hCdXR0b24oJ8OXJywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgICAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICAgICAgICAgIGJhdGNoSXRlbXMgPSBiYXRjaEl0ZW1zLmZpbHRlcigoY2FuZGlkYXRlKSA9PiBjYW5kaWRhdGUuaXRlbS5pZCAhPT0gaXRlbS5pZCk7XHJcbiAgICAgICAgICAgIGxldCBuZXh0SWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGl0ZW0uaWQpIHtcclxuICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGgpIG5leHRJZCA9IHNlbGVjdGVkRnJhbWVzKClbMF0uaXRlbS5pZDtcclxuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSBuZXh0SWQgPSBiYXRjaEl0ZW1zWzBdLml0ZW0uaWQ7XHJcbiAgICAgICAgICAgICAgICBlbHNlIHsgc3RhdGUuZG9jdW1lbnQgPSBudWxsOyByZW5kZXJUcmVlKCk7IHdvcmtmbG93Py5iYXRjaFJlYWR5KCk7IH1cclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBpZiAobmV4dElkKSB2b2lkIGFjdGl2YXRlRnJhbWUobmV4dElkKTtcclxuICAgICAgICAgICAgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICAgICAgfSwgJ2ljb24tYnV0dG9uJyk7XHJcbiAgICAgICAgcmVtb3ZlLmRhdGFzZXQuYmF0Y2hSZW1vdmUgPSBpdGVtLmlkOyByZW1vdmUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYOenu+mZpCAke2ZyYW1lTmFtZShlbnRyeSl9YCk7XHJcbiAgICAgICAgYWN0aW9ucy5hcHBlbmQoY29uZmlndXJlLCByZW1vdmUpOyByb3cuYXBwZW5kKGNoZWNrZWQsIGNvcHksIGFjdGlvbnMpOyBsaXN0LmFwcGVuZChyb3cpO1xyXG4gICAgICAgIGlmICghaXRlbS5lbmFibGVkIHx8IGhpZGRlbklnbm9yZWQpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IHRhYiA9IGJhdGNoQnV0dG9uKCcnLCAoKSA9PiB7IHZvaWQgYWN0aXZhdGVGcmFtZShpdGVtLmlkKTsgfSwgJ2JhdGNoLWZyYW1lLXRhYicpO1xyXG4gICAgICAgIHRhYi5kYXRhc2V0LmJhdGNoRnJhbWUgPSBpdGVtLmlkOyB0YWIuc2V0QXR0cmlidXRlKCdyb2xlJywgJ3RhYicpOyB0YWIuc2V0QXR0cmlidXRlKCdhcmlhLXNlbGVjdGVkJywgU3RyaW5nKGFjdGl2ZUJhdGNoSWQgPT09IGl0ZW0uaWQpKTtcclxuICAgICAgICB0YWIuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3Ryb25nJywgZnJhbWVOYW1lKGVudHJ5KSksIGJhdGNoRWxlbWVudCgnc21hbGwnLCBlbnRyeS5jb25maWd1cmVkID8gJ+W3sumFjee9riDCtyDoh6rliqjkv53nlZknIDogJ+aZuuiDvem7mOiupCcpKTtcclxuICAgICAgICB0YWJzLmFwcGVuZCh0YWIpO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGJhdGNoRWxlbWVudCgnbGFiZWwnLCAnJywgYGJhdGNoLXRhcmdldC1yb3cke2NvbmZsaWN0cy5oYXMoaXRlbS5pZCkgPyAnIGlzLWNvbmZsaWN0JyA6ICcnfWApO1xyXG4gICAgICAgIHRhcmdldC5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzcGFuJywgaXRlbS5uYW1lKSk7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IGJhdGNoRWxlbWVudCgnaW5wdXQnKTtcclxuICAgICAgICBuYW1lLnR5cGUgPSAndGV4dCc7IG5hbWUudmFsdWUgPSBmcmFtZU5hbWUoZW50cnkpOyBuYW1lLmRpc2FibGVkID0gc3RhdGUuYnVzeTsgbmFtZS5kYXRhc2V0LmJhdGNoTmFtZSA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtpdGVtLm5hbWV9IOeahCBQcmVmYWIg5ZCN56ewYCk7XHJcbiAgICAgICAgbmFtZS50aXRsZSA9IGBhc3NldHMvJHtlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlfS8ke3Nhbml0aXplQXNzZXROYW1lKGZyYW1lTmFtZShlbnRyeSkpfS5wcmVmYWJgO1xyXG4gICAgICAgIG5hbWUub25jaGFuZ2UgPSAoKSA9PiB7IHZvaWQgcmVuYW1lRnJhbWUoZW50cnksIG5hbWUudmFsdWUpOyB9O1xyXG4gICAgICAgIHRhcmdldC5hcHBlbmQobmFtZSk7IHRhcmdldHMuYXBwZW5kKHRhcmdldCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhY3RpdmUgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1hY3RpdmUtbmFtZScpLnRleHRDb250ZW50ID0gYWN0aXZlID8gYOato+WcqOiwg+aVtO+8miR7ZnJhbWVOYW1lKGFjdGl2ZSl9YCA6ICfpgInmi6nkuIDkuKrnlYzpnaLlvIDlp4vosIPmlbQnO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWFjdGl2ZS1zdGF0dXMnKS50ZXh0Q29udGVudCA9IGFjdGl2ZSAmJiBpZ25vcmVkSGlkZGVuRnJhbWUoYWN0aXZlKSA/ICfpmpDol48gwrcg5pys5qyh5b+955WlJ1xyXG4gICAgICAgIDogYWN0aXZlPy5jb25maWd1cmVkID8gJ+S/ruaUueW3suS/neeVmScgOiAn5rK/55So5pm66IO96buY6K6kJztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1jb25mbGljdHMnKS5oaWRkZW4gPSBjb25mbGljdHMuc2l6ZSA9PT0gMDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1jb25mbGljdHMnKS50ZXh0Q29udGVudCA9IGDmnIkgJHtjb25mbGljdHMuc2l6ZX0g5Liq55WM6Z2i55qEIFByZWZhYiDmlofku7blkI3ph43lpI3vvIjlv73nlaXlpKflsI/lhpnvvInjgILor7fmlLnlkI3lkI7lvIDlp4vlr7zlhaXjgIJgO1xyXG4gICAgcmVuZGVyQmF0Y2hSZXN1bHRzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckJhdGNoUmVzdWx0cygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHJvd3MgPSBiYXRjaFByb2dyZXNzPy5pdGVtcyA/PyBiYXRjaFJlc3VsdD8uaXRlbXMgPz8gW107XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1saXN0Jyk7IGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygcm93cykge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtJyk7XHJcbiAgICAgICAgY29uc3QgY29weSA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWNvcHknKTtcclxuICAgICAgICBjb3B5LmFwcGVuZChiYXRjaEVsZW1lbnQoJ2RpdicsIGl0ZW0ubmFtZSwgJ2JhdGNoLWl0ZW0tdGl0bGUnKSwgYmF0Y2hFbGVtZW50KCdkaXYnLCBpdGVtLmVycm9yID8/IGl0ZW0ucHJlZmFiVXJsID8/IGl0ZW0ud2FybmluZ3M/LmpvaW4oJ++8mycpID8/IChpdGVtLnN0YXR1cyA9PT0gJ3BlbmRpbmcnID8gJ+etieW+hee7p+e7reWvvOWFpScgOiAnJyksICdiYXRjaC1pdGVtLW1ldGEnKSk7XHJcbiAgICAgICAgY29uc3Qgc3RhdHVzID0geyBwZW5kaW5nOiAn5pyq5a6M5oiQJywgcnVubmluZzogJ+ato+WcqOWvvOWFpScsIHN1Y2Nlc3M6ICflt7LlrozmiJAnLCBmYWlsZWQ6ICflpLHotKUnIH1baXRlbS5zdGF0dXNdO1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbnMgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1hY3Rpb25zJyk7XHJcbiAgICAgICAgYWN0aW9ucy5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzcGFuJywgc3RhdHVzLCBgYmF0Y2gtc3RhdHVzLSR7aXRlbS5zdGF0dXN9YCkpO1xyXG4gICAgICAgIGlmIChpdGVtLnJldmlld0lkIHx8IGl0ZW0ucmV2aWV3KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJldmlldyA9IGJhdGNoQnV0dG9uKCfmo4Dmn6Xnu5PmnpwnLCAoKSA9PiB7IHZvaWQgb3BlbkJhdGNoUmV2aWV3KGl0ZW0pOyB9KTtcclxuICAgICAgICAgICAgcmV2aWV3LmRhdGFzZXQuYmF0Y2hSZXZpZXcgPSBpdGVtLmlkOyBhY3Rpb25zLmFwcGVuZChyZXZpZXcpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByb3cuYXBwZW5kKGNvcHksIGFjdGlvbnMpOyBsaXN0LmFwcGVuZChyb3cpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3VjY2VzcyA9IHJvd3MuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGg7XHJcbiAgICBjb25zdCBmYWlsZWQgPSByb3dzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGg7XHJcbiAgICBjb25zdCBwZW5kaW5nID0gcm93cy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAncGVuZGluZycpLmxlbmd0aDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtY291bnQnKS50ZXh0Q29udGVudCA9IGAke3N1Y2Nlc3N9IC8gJHtyb3dzLmxlbmd0aH0g5bey5a6M5oiQYDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYmF0Y2gtcmV0cnktZmFpbGVkJykuaGlkZGVuID0gIWZhaWxlZCB8fCBzdGF0ZS5idXN5O1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNiYXRjaC1yZXN1bWUtcGVuZGluZycpLmhpZGRlbiA9ICFwZW5kaW5nIHx8IHN0YXRlLmJ1c3k7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHJvd3Muc29tZSgoaXRlbSkgPT4gaXRlbS5yZXF1aXJlc0F0dGVudGlvbilcclxuICAgICAgICA/ICfpg6jliIbpobnnmoTkv53lrZjnirbmgIHpnIDopoHmo4Dmn6XjgILor7flhYjlnKggQ29jb3Mg56Gu6K6k5b2T5YmN55uu5qCH5LiO5L+d5a2Y54q25oCB77yM5YaN6YeN6K+V5oiW57un57ut44CCJ1xyXG4gICAgICAgIDogJ+eCueWHu+avj+S4gOmhueeahOKAnOajgOafpee7k+aenOKAneafpeeci+WvueW6lOaKpeWRiu+8m+mHjeivleWSjOe7p+e7reS8mui3s+i/h+W3suWujOaIkOmhueOAgic7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG9wZW5CYXRjaFJldmlldyhpdGVtOiBCYXRjaEltcG9ydEl0ZW1SZXN1bHQpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlld0lkID0gaXRlbS5yZXZpZXdJZCA/PyBpdGVtLnJldmlldz8uaWQ7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcmV2aWV3SWQgPyBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycsIHJldmlld0lkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFyZXZpZXcpIHRocm93IG5ldyBFcnJvcign6K+l6aG55qOA5p+l5oql5ZGK5bey6L+H5pyf77yM6K+36YeN5paw5a+85YWl5ZCO5p+l55yL44CCJyk7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7IHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5bmo4Dmn6Xnu5PmnpzlpLHotKXjgIInKSwgdHJ1ZSk7IH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYWN0aXZhdGVGcmFtZShpZDogc3RyaW5nLCBuYXZpZ2F0ZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgY29uc3QgZW50cnkgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBpZCk7XHJcbiAgICBpZiAoIWVudHJ5KSByZXR1cm47XHJcbiAgICBjb25zdCBhbHJlYWR5QWN0aXZlID0gYWN0aXZlQmF0Y2hJZCA9PT0gaWQgJiYgc3RhdGUuZG9jdW1lbnQ7XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBvbGRJZCA9IGFjdGl2ZUJhdGNoSWQ7XHJcbiAgICBjb25zdCBvbGRFZGl0b3IgPSBlZGl0b3JTbmFwc2hvdCgpO1xyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpOyBpZiAoc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICBwcmV2aWV3UmV2aXNpb24rKztcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JCYXRjaExpc3RSZWFkeSgpO1xyXG4gICAgICAgIGNvbnN0IGxvYWRlZCA9IGFscmVhZHlBY3RpdmUgPyBzdGF0ZS5kb2N1bWVudCA6IGF3YWl0IHJlcXVlc3Q8RG9jdW1lbnREdG8+KCdhY3RpdmF0ZS1iYXRjaC1pdGVtJywgaWQpO1xyXG4gICAgICAgIGlmICghYWxyZWFkeUFjdGl2ZSAmJiBsb2FkZWQ/LmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGxvYWRlZC5mb250QXNzZXRzO1xyXG4gICAgICAgICAgICBlbnRyeS5pdGVtLmRvY3VtZW50LmZvbnRBc3NldHMgPSBsb2FkZWQuZm9udEFzc2V0cztcclxuICAgICAgICB9XHJcbiAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IGlkO1xyXG4gICAgICAgIGlmIChlbnRyeS5lZGl0b3IpIHsgT2JqZWN0LmFzc2lnbihzdGF0ZSwgZW50cnkuZWRpdG9yKTsgcmVjb25jaWxlQWN0aW9ucygpOyB9XHJcbiAgICAgICAgZWxzZSBpbml0aWFsaXplRG9jdW1lbnQobG9hZGVkID8/IGVudHJ5Lml0ZW0uZG9jdW1lbnQsIGZhbHNlKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS52YWx1ZSA9IHN0YXRlLnNlYXJjaDtcclxuICAgICAgICBlbGVtZW50KCcjZmlsZS1uYW1lJykudGV4dENvbnRlbnQgPSBzdGF0ZS5kb2N1bWVudD8uZmlsZU5hbWUgPz8gJyc7XHJcbiAgICAgICAgZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKS5jbGFzc0xpc3QucmVtb3ZlKCdoYXMtaW1hZ2UnLCAnaXMtbG9hZGluZycpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNwcmV2aWV3LWltYWdlJykucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgICAgICBlbGVtZW50KCcjcHJldmlldy1tZXRhJykudGV4dENvbnRlbnQgPSAn6YCJ5oup6IqC54K55p+l55yL6aKE6KeIJztcclxuICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgZWxlbWVudCgnI3RyZWUnKS5zY3JvbGxUb3AgPSBlbnRyeS5lZGl0b3I/LnRyZWVTY3JvbGwgPz8gMDtcclxuICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IChlbnRyeS5lZGl0b3I/LnByZXNldCA/PyAnc21hcnQnKSkpO1xyXG4gICAgICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IG9sZElkOyBPYmplY3QuYXNzaWduKHN0YXRlLCBvbGRFZGl0b3IpO1xyXG4gICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfliIfmjaLnlYzpnaLlpLHotKXvvIzor7fph43or5XjgIInKSwgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpOyByZW5kZXJCYXRjaCgpOyB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICAgICAgaWYgKG5hdmlnYXRlICYmIGFjdGl2ZUJhdGNoSWQgPT09IGlkKSB3b3JrZmxvdz8ubmF2aWdhdGUoMik7XHJcbiAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGlkICYmIHdvcmtmbG93Py5zdGVwID09PSAyICYmIHN0YXRlLnNlbGVjdGVkSWQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKTsgaWYgKHNlbGVjdGVkKSB2b2lkIHByZXZpZXcoc2VsZWN0ZWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVuYW1lRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSwgdmFsdWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHZhbHVlKTtcclxuICAgIGlmICghbmFtZSkgeyBzaG93VG9hc3QoJ1ByZWZhYiDlkI3np7DkuI3og73kuLrnqbrjgIInLCB0cnVlKTsgcmVuZGVyQmF0Y2goKTsgcmV0dXJuOyB9XHJcbiAgICBhd2FpdCBhY3RpdmF0ZUZyYW1lKGVudHJ5Lml0ZW0uaWQpO1xyXG4gICAgaWYgKGFjdGl2ZUJhdGNoSWQgIT09IGVudHJ5Lml0ZW0uaWQpIHJldHVybjtcclxuICAgIHN0YXRlLm5hbWVzLnNldChlbnRyeS5pdGVtLnJvb3RJZCwgbmFtZSk7XHJcbiAgICBpZiAobmFtZSA9PT0gZW50cnkuaXRlbS5uYW1lKSBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShlbnRyeS5pdGVtLnJvb3RJZCk7IGVsc2Ugc3RhdGUucmVuYW1lZElkcy5hZGQoZW50cnkuaXRlbS5yb290SWQpO1xyXG4gICAgZW50cnkuY29uZmlndXJlZCA9IHRydWU7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOyByZW1lbWJlckFjdGl2ZUZyYW1lKCk7IHJlbmRlclRyZWUoKTsgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByb290KCk6IEhUTUxFbGVtZW50IHtcclxuICAgIHJldHVybiBwYW5lbEhvc3QuJC5hcHAgYXMgSFRNTEVsZW1lbnQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVsZW1lbnQ8VCBleHRlbmRzIEhUTUxFbGVtZW50PihzZWxlY3Rvcjogc3RyaW5nKTogVCB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPFQ+KHNlbGVjdG9yKTtcclxuICAgIGlmICghdmFsdWUpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFBhbmVsIGVsZW1lbnQgbm90IGZvdW5kOiAke3NlbGVjdG9yfWApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXF1ZXN0PFQ+KG1lc3NhZ2U6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKTogUHJvbWlzZTxUPiB7XHJcbiAgICByZXR1cm4gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdChwYWNrYWdlSlNPTi5uYW1lLCBtZXNzYWdlLCAuLi5hcmdzKSBhcyBUO1xyXG59XHJcblxyXG4vKipcclxuICog57uE5Lu25ZCM5q2l6aKE5qOA44CC5aSx6LSl5piv5q2j5bi45oOF5Ya177yIRnJhbWUg6ZO+5o6l44CB5paH5Lu26ZO+5o6l44CBUHJlZmFiIOWwmuS4jeWtmOWcqO+8ie+8jFxyXG4gKiDpnZnpu5jmuIXnqbrljbPlj6/vvIzkuI3lvbHlk43lr7zlhaXmnKzouqvjgIJcclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hTeW5jUHJldmlldygpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICBzdGF0ZS5zeW5jUHJldmlldyA9IHVuZGVmaW5lZDtcclxuICAgICAgICB3b3JrZmxvdz8uc3luY1ByZXZpZXdVcGRhdGVkKCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgdHJ5IHtcclxuICAgICAgICBzdGF0ZS5zeW5jUHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8U3luY1ByZXZpZXdSZXN1bHQ+KCdzeW5jLXByZXZpZXcnKTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIHN0YXRlLnN5bmNQcmV2aWV3ID0gdW5kZWZpbmVkO1xyXG4gICAgfVxyXG4gICAgd29ya2Zsb3c/LnN5bmNQcmV2aWV3VXBkYXRlZCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzaG93VG9hc3QobWVzc2FnZTogc3RyaW5nLCBlcnJvciA9IGZhbHNlKTogdm9pZCB7XHJcbiAgICBjb25zdCB0b2FzdCA9IGVsZW1lbnQ8SFRNTERpdkVsZW1lbnQ+KCcjdG9hc3QnKTtcclxuICAgIHRvYXN0LnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgZXJyb3IpO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LmFkZCgnc2hvdycpO1xyXG4gICAgY29uc3QgY3JlZGVudGlhbERpYWxvZyA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPEhUTUxEaWFsb2dFbGVtZW50PignI2NyZWRlbnRpYWwtZGlhbG9nJyk7XHJcbiAgICBjb25zdCBjcmVkZW50aWFsU3RhdHVzID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcjY3JlZGVudGlhbC1zdGF0dXMnKTtcclxuICAgIGlmIChjcmVkZW50aWFsRGlhbG9nPy5vcGVuICYmIGNyZWRlbnRpYWxTdGF0dXMpIHtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLmhpZGRlbiA9IGZhbHNlO1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB9XHJcbiAgICBpZiAodG9hc3RUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgIH1cclxuICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKSwgMzQwMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93biwgZmFsbGJhY2s6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5tZXNzYWdlKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIGVycm9yID09PSAnc3RyaW5nJyAmJiBlcnJvci50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3I7XHJcbiAgICB9XHJcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0JyAmJiAnbWVzc2FnZScgaW4gZXJyb3JcclxuICAgICAgICAmJiB0eXBlb2YgKGVycm9yIGFzIHsgbWVzc2FnZT86IHVua25vd24gfSkubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICByZXR1cm4gKGVycm9yIGFzIHsgbWVzc2FnZTogc3RyaW5nIH0pLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsbGJhY2s7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldENvbm5lY3Rpb24odmF1bHQ6IHtcclxuICAgIGhhc1Rva2VuOiBib29sZWFuO1xyXG4gICAgcGVyc2lzdGVudDogYm9vbGVhbjtcclxuICAgIGJhY2tlbmQ6IHN0cmluZztcclxuICAgIHdhcm5pbmc/OiBzdHJpbmc7XHJcbn0pOiB2b2lkIHtcclxuICAgIGNvbnN0IHBpbGwgPSBlbGVtZW50KCcjY29ubmVjdGlvbi1waWxsJyk7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9ubGluZScsIHZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb2ZmbGluZScsICF2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBlbGVtZW50KCcjY29ubmVjdGlvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gdmF1bHQuaGFzVG9rZW4gPyAn5Yet5o2u5bCx57uqJyA6ICfmnKrov57mjqUnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LWJhZGdlJykudGV4dENvbnRlbnQgPSB2YXVsdC5wZXJzaXN0ZW50ID8gJ+ezu+e7n+WKoOWvhicgOiAn5Lya6K+d5a2Y5YKoJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1ub3RlJykudGV4dENvbnRlbnQgPSB2YXVsdC53YXJuaW5nXHJcbiAgICAgICAgPz8gKHZhdWx0LnBlcnNpc3RlbnQgPyBg55SxICR7dmF1bHQuYmFja2VuZH0g5Yqg5a+G77yM6aG555uu5Lit5LuF5L+d5a2Y6Z2e5pWP5oSf6K6+572uYCA6ICdUb2tlbiDkuI3lhpnlhaXpobnnm67mlofku7YnKTtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2NsZWFyLXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgd29ya2Zsb3c/LnNldENvbm5lY3Rpb24odmF1bHQuaGFzVG9rZW4pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuKG5vZGVzOiBUcmVlTm9kZUR0b1tdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZXMuZmxhdE1hcCgobm9kZSkgPT4gW25vZGUsIC4uLmZsYXR0ZW4obm9kZS5jaGlsZHJlbildKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZE5vZGUoaWQ6IHN0cmluZywgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSk6IFRyZWVOb2RlRHRvIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgIGlmIChub2RlLmlkID09PSBpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBmaW5kTm9kZShpZCwgbm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgaWYgKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJGb250TWFwKCk6IHZvaWQge1xyXG4gICAgY29uc3QgbGlzdCA9IGVsZW1lbnQoJyNmb250LW1hcC1saXN0Jyk7XHJcbiAgICBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3QgZmFtaWxpZXMgPSBiYXRjaEZvbnRzKCk7XHJcbiAgICBpZiAoIWZhbWlsaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5JztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg5ZCO77yM6L+Z6YeM5Lya5YiX5Ye65qOA5rWL5Yiw55qE5a2X5L2T44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmZvbnRBc3NldHMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHkgaXMtd2FybmluZyc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6aG555uuIGFzc2V0cyDlhoXmsqHmnInmo4DmtYvliLAgLnR0ZiAvIC5vdGYgLyAuZm50IC8gLndvZmYg5a2X5L2T6LWE5rqQ44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIGZhbWlsaWVzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1yb3cnO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBzb3VyY2UuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNvdXJjZSc7XHJcbiAgICAgICAgc291cmNlLnRleHRDb250ZW50ID0gZmFtaWx5O1xyXG4gICAgICAgIHNvdXJjZS50aXRsZSA9IGZhbWlseTtcclxuICAgICAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBhcnJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtYXJyb3cnO1xyXG4gICAgICAgIGFycm93LnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICAgICAgc2VsZWN0LmNsYXNzTmFtZSA9ICdmb250LW1hcC1zZWxlY3QnO1xyXG4gICAgICAgIHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHkgPSBmYW1pbHk7XHJcbiAgICAgICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke2ZhbWlseX0g5pig5bCE5a2X5L2TYCk7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbignJywgJ+S4jeaYoOWwhO+8iOS9v+eUqOm7mOiupOWtl+S9k++8iScpKTtcclxuICAgICAgICBjb25zdCBhdXRvbWF0aWMgPSBmaW5kRm9udEFzc2V0KGZhbWlseSwgc3RhdGUuZm9udEFzc2V0cyk7XHJcbiAgICAgICAgY29uc3QgaGFzTWFwcGluZyA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChzdGF0ZS5zZXR0aW5ncy5mb250TWFwLCBmYW1pbHkpO1xyXG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gaGFzTWFwcGluZyA/IHN0YXRlLnNldHRpbmdzLmZvbnRNYXBbZmFtaWx5XSA6IGF1dG9tYXRpYz8udXJsID8/ICcnO1xyXG4gICAgICAgIGlmIChzZWxlY3RlZCAmJiAhc3RhdGUuZm9udEFzc2V0cy5zb21lKChhc3NldCkgPT4gYXNzZXQudXJsID09PSBzZWxlY3RlZCkpIHtcclxuICAgICAgICAgICAgLy8gQXNzaWduaW5nIGFuIHVubWF0Y2hlZCBzZWxlY3QudmFsdWUgYmVjb21lcyBlbXB0eSBpbiB0aGUgcmVhbFxyXG4gICAgICAgICAgICAvLyByZW5kZXJlci4gS2VlcCB0aGUgcGVyc2lzdGVkIHJlZmVyZW5jZSB3aGlsZSBBc3NldERCIGlzIGluZGV4aW5nLlxyXG4gICAgICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKHNlbGVjdGVkLCBg5bey5L+d5a2Y77yI6LWE5rqQ5pqC5pyq5bCx57uq77yJIMK3ICR7c2VsZWN0ZWR9YCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmb3IgKGNvbnN0IGFzc2V0IG9mIHN0YXRlLmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IG9wdGlvbihhc3NldC51cmwsIGAke2Fzc2V0Lm5hbWV9IMK3ICR7YXNzZXQucmVsYXRpdmVQYXRofWApO1xyXG4gICAgICAgICAgICBpdGVtLnNlbGVjdGVkID0gYXNzZXQudXJsID09PSBzZWxlY3RlZDtcclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGl0ZW0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZWxlY3QudmFsdWUgPSBzZWxlY3RlZDtcclxuICAgICAgICByb3cuYXBwZW5kKHNvdXJjZSwgYXJyb3csIHNlbGVjdCk7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlQWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IHVua25vd24pOiBJbXBvcnRBY3Rpb24ge1xyXG4gICAgcmV0dXJuIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7IGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGFjdGlvbiksIGtpbmQ6IG5vZGUua2luZCwgbmluZVNsaWNlOiBmYWxzZSB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKS5hY3Rpb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXRpYWxpemVEb2N1bWVudChkb2N1bWVudDogRG9jdW1lbnREdG8sIG5hdmlnYXRlID0gdHJ1ZSk6IHZvaWQge1xyXG4gICAgc3RhdGUuZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmtpbmRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgc3RhdGUubmFtZXMuY2xlYXIoKTtcclxuICAgIHN0YXRlLnJlbmFtZWRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmRlZmF1bHRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5jb2xsYXBzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnN1cHByZXNzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBkb2N1bWVudC50cmVlWzBdPy5pZDtcclxuICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIGZsYXR0ZW4oZG9jdW1lbnQudHJlZSkpIHtcclxuICAgICAgICBjb25zdCBhY3Rpb24gPSBzbWFydEFjdGlvbkZvck5vZGUobm9kZSk7XHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgYWN0aW9uKTtcclxuICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgbm9kZS5raW5kKTtcclxuICAgICAgICBzdGF0ZS5kZWZhdWx0cy5zZXQobm9kZS5pZCwgeyBhY3Rpb24sIGtpbmQ6IG5vZGUua2luZCB9KTtcclxuICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxuICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBvdmVycmlkZSBvZiBkb2N1bWVudC5ub2RlT3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKG92ZXJyaWRlLmlkLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChjdXN0b21OYW1lICYmIGN1c3RvbU5hbWUgIT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgY3VzdG9tTmFtZSk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBvdmVycmlkZS5hY3Rpb24pKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG92ZXJyaWRlLmtpbmQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoXHJcbiAgICAgICAgICAgICdhY3RpdmUnLFxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5zaXplID09PSAwICYmIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gJ3NtYXJ0JyxcclxuICAgICAgICApO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZmlsZS1uYW1lJykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBkb2N1bWVudC5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50KCcjZm9udC1oaW50JykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5mb250cy5sZW5ndGhcclxuICAgICAgICA/IGDmo4DmtYvliLDvvJoke2RvY3VtZW50LmZvbnRzLmpvaW4oJ+OAgScpfWBcclxuICAgICAgICA6ICflvZPliY3mlofku7blsJrmnKrlj5HnjrDlrZfkvZPjgIInO1xyXG4gICAgcmVuZGVyRm9udE1hcCgpO1xyXG4gICAgcmVuZGVyVHJlZSh0cnVlKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIGlmIChuYXZpZ2F0ZSkgd29ya2Zsb3c/LmRvY3VtZW50UmVhZHkoKTtcclxuICAgIHZvaWQgcmVmcmVzaFN5bmNQcmV2aWV3KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5U2V0dGluZ3Moc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHsgLi4uc2V0dGluZ3MsIGZvbnRNYXA6IHsgLi4uc2V0dGluZ3MuZm9udE1hcCB9LCBpbXBvcnRIaWRkZW5MYXllcnM6IHNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UgfTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNpbXBvcnQtaGlkZGVuLWxheWVycycpLmNoZWNrZWQgPSBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnM7XHJcbiAgICB1cGRhdGVUYXJnZXRIaW50KCk7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlYWRTZXR0aW5ncyhzaG93RXJyb3IgPSB0cnVlKTogSW1wb3J0U2V0dGluZ3MgfCBudWxsIHtcclxuICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLnN0YXRlLnNldHRpbmdzLmZvbnRNYXAgfTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PignW2RhdGEtZm9udC1mYW1pbHldJykuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XHJcbiAgICAgICAgY29uc3QgZmFtaWx5ID0gc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseT8udHJpbSgpO1xyXG4gICAgICAgIGlmIChmYW1pbHkgJiYgc2VsZWN0LnZhbHVlKSB7XHJcbiAgICAgICAgICAgIGZvbnRNYXBbZmFtaWx5XSA9IHNlbGVjdC52YWx1ZTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNjYWxlID0gTnVtYmVyKGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlKTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHNjYWxlKSB8fCBzY2FsZSA8IDAuMjUgfHwgc2NhbGUgPiA0KSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+WvvOWFpeWAjeeOh+W/hemhu+WcqCAwLjI1IOWIsCA0IOS5i+mXtOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGFzc2V0Rm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghYXNzZXRGb2xkZXIpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36YCJ5oup6aG555uuIGFzc2V0cyDkuIvnmoTotYTmupDovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmVmYWJGb2xkZXIgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghcHJlZmFiRm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemihOWItuS9k+i+k+WHuuebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBhc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IEFycmF5LmZyb20oeyBsZW5ndGg6IDMgfSwgKF8sIGluZGV4KSA9PlxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWUudHJpbSgpLFxyXG4gICAgICAgICksXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2xvY2FsLXJlc291cmNlLWZvbGRlci0wJykudmFsdWUudHJpbSgpLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdXBkYXRlLWV4aXN0aW5nJykuY2hlY2tlZCxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcmVmcmVzaC1hc3NldHMnKS5jaGVja2VkLFxyXG4gICAgICAgIGF1dG9TYXZlOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXV0by1zYXZlJykuY2hlY2tlZCxcclxuICAgICAgICBpbXBvcnRIaWRkZW5MYXllcnM6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNpbXBvcnQtaGlkZGVuLWxheWVycycpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcnNpc3RQYW5lbFNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnNldHRpbmdzLCBmb250TWFwOiB7IC4uLnNldHRpbmdzLmZvbnRNYXAgfSB9O1xyXG4gICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHN0YXRlLnNldHRpbmdzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QnVzeSh2YWx1ZTogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgdmFsdWUgPSB2YWx1ZSB8fCBCb29sZWFuKHdvcmtmbG93Py5wZW5kaW5nKTtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIC8vIENhcHR1cmUgZWRpdGFibGUgY29udHJvbCBzdGF0ZXMgYmVmb3JlIHRoZSBleGlzdGluZyBidXR0b24gbG9jayBjaGFuZ2VzIHRoZW0uXHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjc2F2ZS10b2tlbicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stYXNzZXQtZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1wcmVmYWItZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWRldGVjdCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZSA9PT0gJyc7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWhpZGRlbicsICF2YWx1ZSk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBpZiAoIXZhbHVlKSByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNldFJvdW5kdHJpcFRva2VucygpOiB2b2lkIHtcclxuICAgIHJvdW5kdHJpcFByZXZpZXdUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcm91bmR0cmlwU291cmNlKCk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXNvdXJjZSkge1xyXG4gICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIOaWh+S7tuaIluiKgueCuemTvuaOpeOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyUm91bmR0cmlwUHJldmlldyhwcmV2aWV3OiBSb3VuZHRyaXBQcmV2aWV3RHRvKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSBwcmV2aWV3LnByZXZpZXdUb2tlbjtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHByZXZpZXcucGFpclRva2VuO1xyXG4gICAgY29uc3QgbGluZXMgPSBbXHJcbiAgICAgICAgYOebruagh++8miR7cHJldmlldy5hc3NldFVybH1gLFxyXG4gICAgICAgIGBQcmVmYWLvvJoke3ByZXZpZXcucHJlZmFiVXVpZH1gLFxyXG4gICAgICAgIGBTdXJmYWNl77yaJHtwcmV2aWV3LnN1cmZhY2VJZH0gwrcgRmlnbWEgJHtwcmV2aWV3LmZpZ21hVmVyc2lvbn0gwrcgTGVkZ2VyICR7cHJldmlldy5sZWRnZXJHZW5lcmF0aW9ufWAsXHJcbiAgICAgICAgYOWwhuS/ruaUuSAke3ByZXZpZXcucGxhbi5hcHBseS5sZW5ndGh9IOmhuSDCtyDkv53nlZkgQ29jb3MgJHtwcmV2aWV3LnBsYW4ucHJlc2VydmVDb2Nvcy5sZW5ndGh9IOmhuSDCtyDlt7LmlLbmlZsgJHtwcmV2aWV3LnBsYW4uY29udmVyZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBg5Yay56qBICR7cHJldmlldy5wbGFuLmNvbmZsaWN0cy5sZW5ndGh9IOmhuSDCtyDkuI3mlK/mjIEgJHtwcmV2aWV3LnBsYW4udW5zdXBwb3J0ZWQubGVuZ3RofSDpobkgwrcg5Y+q6K+75pyq5pS5ICR7cHJldmlldy5wbGFuLnJlYWRvbmx5VW5jaGFuZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBwcmV2aWV3LnBhaXJSZXF1aXJlZFxyXG4gICAgICAgICAgICA/IHByZXZpZXcucGFpckVsaWdpYmxlID8gJ+mmluasoeS9v+eUqO+8muivgeaNruS4gOiHtO+8jOivt+WFiOehruiupOmFjeWvuSBTdXJmYWNl77yI5Y+q5YaZIGxlZGdlcu+8jOS4jeaUuSBQcmVmYWLvvInjgIInIDogJ+mmluasoeS9v+eUqO+8mlBhaXIg6K+B5o2u5LiN5LiA6Ie077yM6ZyA5LuO5b2T5YmNIFByZWZhYiDph43mlrDlr7zlh7rjgIInXHJcbiAgICAgICAgICAgIDogcHJldmlldy5ibG9ja2Vycy5sZW5ndGggPyBg6Zi75pat77yaJHtwcmV2aWV3LmJsb2NrZXJzLmpvaW4oJywgJyl9YCA6ICfpooTop4jpgJrov4fvvIzlj6/ljp/lrZDlupTnlKjmlbTkuKrkuI3lj6/lj5jorqHliJLjgIInLFxyXG4gICAgXTtcclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gbGluZXMuam9pbignXFxuJyk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVRhcmdldEhpbnQoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgZWxlbWVudCgnI2FjdGlvbi1ub3RlJykudGV4dENvbnRlbnQgPSAn5Li76L+b56iL5LiO6Z2i5p2/54mI5pys5LiN5LiA6Ie077yM6ZyA6KaB5a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3InO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWIsOW9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K55LiL77ybRnJhbWUg6ZO+5o6l5bCG6Ieq5Yqo5Yib5bu65bm25omT5byA6aKE5Yi25L2TJztcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRJbXBvcnRCdXR0b24oKTogdm9pZCB7XHJcbiAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgYnV0dG9uLnRpdGxlID0gJ+WvvOWFpeWIsOW9k+WJjeaJk+W8gOWcuuaZr+aIlumihOWItuS9kyc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+W8gOWni+WvvOWFpSc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcwJSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGltcG9ydFByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHZhbHVlID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgZXZlbnQudmFsdWUpKTtcclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycpIHtcclxuICAgICAgICByZXR1cm4gMC4wNSArIHZhbHVlICogMC41NTtcclxuICAgIH1cclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ3NjZW5lJykge1xyXG4gICAgICAgIHJldHVybiAwLjYgKyB2YWx1ZSAqIDAuMzg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZXZlbnQucGhhc2UgPT09ICdkb25lJyA/IDEgOiAwO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgaWYgKGV2ZW50LmJhdGNoICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGV2ZW50LmJhdGNoO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSb3cgPSBldmVudC5iYXRjaC5pdGVtcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBldmVudC5iYXRjaCEuaXRlbUlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gY3VycmVudFJvdz8uc3RhdHVzID09PSAncnVubmluZycgPyBpbXBvcnRQcm9ncmVzcyhldmVudCkgOiAwO1xyXG4gICAgICAgIGV2ZW50ID0ge1xyXG4gICAgICAgICAgICAuLi5ldmVudCxcclxuICAgICAgICAgICAgdmFsdWU6IE1hdGgubWluKDEsIChldmVudC5iYXRjaC5jb21wbGV0ZWQgKyBjdXJyZW50KSAvIE1hdGgubWF4KDEsIGV2ZW50LmJhdGNoLnRvdGFsKSksXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGAke2V2ZW50LmJhdGNoLmluZGV4fSAvICR7ZXZlbnQuYmF0Y2gudG90YWx9IMK3ICR7ZXZlbnQuYmF0Y2gubmFtZX0gwrcgJHtldmVudC5tZXNzYWdlfWAsXHJcbiAgICAgICAgfTtcclxuICAgICAgICByZW5kZXJCYXRjaFJlc3VsdHMoKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkgc2V0QnVzeSh0cnVlKTtcclxuICAgIHdvcmtmbG93Py5wcm9ncmVzcyhldmVudCk7XHJcbiAgICBjb25zdCByZWdpb24gPSBlbGVtZW50KCcjcHJvZ3Jlc3MtcmVnaW9uJyk7XHJcbiAgICBjb25zdCBidXN5ID0gWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtYnVzeScsIGJ1c3kpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWVycm9yJywgZXZlbnQucGhhc2UgPT09ICdlcnJvcicpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQodmFsdWUgKiAxMDApfSVgO1xyXG4gICAgKGVsZW1lbnQoJyNwcm9ncmVzcy1iYXInKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHt2YWx1ZSAqIDEwMH0lYDtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgY29uc3QgaW1wb3J0aW5nID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnO1xyXG4gICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcik7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoaW1wb3J0aW5nKSB7XHJcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBldmVudC5iYXRjaCA/IHZhbHVlIDogaW1wb3J0UHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1ydW5uaW5nJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCAndHJ1ZScpO1xyXG4gICAgICAgIGJ1dHRvbi50aXRsZSA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJyA/ICflh4blpIfotYTmupAnIDogJ+aehOW7uuiKgueCuSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9JWA7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gYCR7cHJvZ3Jlc3MgKiAxMDB9JWA7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXlrozmiJAnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICcxMDAlJztcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMTAwJSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE0MDApO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2Vycm9yJyB8fCBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJyA/ICflt7Llj5bmtognIDogJ+WvvOWFpeWksei0pSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+mHjeivlSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE4MDApO1xyXG4gICAgfVxyXG4gICAgaWYgKFsnZG9uZScsICdlcnJvcicsICdjYW5jZWxsZWQnLCAnaWRsZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScgJiYgIXdvcmtmbG93Py5wZW5kaW5nICYmIHBlbmRpbmdJbXBvcnRSZXZpZXcpIHtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSBwZW5kaW5nSW1wb3J0UmV2aWV3O1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LmJhdGNoPy5yZXN1bHQgJiYgIWJhdGNoSW1wb3J0UGVuZGluZyAmJiBiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oZXZlbnQuYmF0Y2gucmVzdWx0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLFxyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMsXHJcbiAgICAgICAgc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSxcclxuICAgICk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlY29uY2lsZUJhdGNoVmlzaWJpbGl0eSgpOiB2b2lkIHtcclxuICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgYmF0Y2hJdGVtcykge1xyXG4gICAgICAgIGlmICghZW50cnkuZWRpdG9yPy5kb2N1bWVudCkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgZWRpdG9yID0gZW50cnkuZWRpdG9yO1xyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGVkaXRvci5kb2N1bWVudCEudHJlZSwgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMsXHJcbiAgICAgICAgICAgIGVkaXRvci5wYXRjaGVzLCBlZGl0b3IuZXhwbGljaXRJZHMsIGVkaXRvci5yZW5hbWVkSWRzLCBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlKTtcclxuICAgICAgICBlZGl0b3IuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zO1xyXG4gICAgICAgIGVkaXRvci5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldEltcG9ydEhpZGRlbkxheWVycyhlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2ltcG9ydC1oaWRkZW4tbGF5ZXJzJykuY2hlY2tlZCA9IGVuYWJsZWQ7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSkgPz8geyAuLi5zdGF0ZS5zZXR0aW5ncywgaW1wb3J0SGlkZGVuTGF5ZXJzOiBlbmFibGVkIH07XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgcmVjb25jaWxlQmF0Y2hWaXNpYmlsaXR5KCk7XHJcbiAgICByZW5kZXJUcmVlKCk7IHJlbmRlckZvbnRNYXAoKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBpZiAoYWN0aXZlICYmIGlnbm9yZWRIaWRkZW5GcmFtZShhY3RpdmUpICYmIHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSBhd2FpdCBhY3RpdmF0ZUZyYW1lKHNlbGVjdGVkRnJhbWVzKClbMF0uaXRlbS5pZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiBJbXBvcnRBY3Rpb24pOiB2b2lkIHtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgYWN0aW9uKSk7XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGU6IFRyZWVOb2RlRHRvKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzdGF0ZS5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleHBsaWNpdE92ZXJyaWRlcygpOiBJbXBvcnRPdmVycmlkZVtdIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKVxyXG4gICAgICAgIC5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSlcclxuICAgICAgICAubWFwKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbmFtZWQgPSBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKTtcclxuICAgICAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogc3RhdGUucHJlZmVycmVkQWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgLi4uKHJlbmFtZWQgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICAgICAgICAgIH0sIG5vZGUucGF0Y2hDYW5kaWRhdGUpO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlS2V5ID0gc3RhdGUuZG9jdW1lbnQuZmlsZUtleTtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgaWYgKGFjdGl2ZSkgeyBhY3RpdmUuY29uZmlndXJlZCA9IHRydWU7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyQmF0Y2goKTsgfVxyXG4gICAgY29uc3Qgb3ZlcnJpZGVzID0gZXhwbGljaXRPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IHNjb3BlSWRzID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+IG5vZGUuaWQpO1xyXG4gICAgLy8gU2VyaWFsaXplIHdyaXRlcyBzbyBhIHNsb3dlciBlYXJsaWVyIHJlcXVlc3QgY2FuIG5ldmVyIG92ZXJ3cml0ZSBhIG5ld2VyXHJcbiAgICAvLyBzdHJhdGVneSBzbmFwc2hvdCBhZnRlciByYXBpZCBzZWxlY3QgY2hhbmdlcy5cclxuICAgIG5vZGVPdmVycmlkZVNhdmVUYXNrID0gbm9kZU92ZXJyaWRlU2F2ZVRhc2tcclxuICAgICAgICAuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKVxyXG4gICAgICAgIC50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdDxJbXBvcnRPdmVycmlkZVtdPignc2F2ZS1ub2RlLW92ZXJyaWRlcycsIGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgICAgIH0pXHJcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6IqC54K5562W55Wl5L+d5a2Y5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYXRjaGVzKG5vZGU6IFRyZWVOb2RlRHRvKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIXN0YXRlLnNlYXJjaCkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGF5c3RhY2sgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gJHtub2RlLm5hbWV9ICR7bm9kZS50eXBlfSAke25vZGUuaWR9YC50b0xvd2VyQ2FzZSgpO1xyXG4gICAgaWYgKGhheXN0YWNrLmluY2x1ZGVzKHN0YXRlLnNlYXJjaCkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUobWF0Y2hlcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9wdGlvbih2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogSFRNTE9wdGlvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xyXG4gICAgaXRlbS52YWx1ZSA9IHZhbHVlO1xyXG4gICAgaXRlbS50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgcmV0dXJuIGl0ZW07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1ha2VTZWxlY3QoXHJcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcclxuICAgIHZhbHVlOiBzdHJpbmcsXHJcbiAgICBpdGVtczogQXJyYXk8W3N0cmluZywgc3RyaW5nXT4sXHJcbiAgICBsYWJlbDogc3RyaW5nLFxyXG4pOiBIVE1MU2VsZWN0RWxlbWVudCB7XHJcbiAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgIHNlbGVjdC5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgbGFiZWwpO1xyXG4gICAgZm9yIChjb25zdCBba2V5LCB0ZXh0XSBvZiBpdGVtcykge1xyXG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24oa2V5LCB0ZXh0KSk7XHJcbiAgICB9XHJcbiAgICBzZWxlY3QudmFsdWUgPSB2YWx1ZTtcclxuICAgIHJldHVybiBzZWxlY3Q7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGVuZFRyZWVOb2RlKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIG5vZGU6IFRyZWVOb2RlRHRvLCBkZXB0aDogbnVtYmVyKTogdm9pZCB7XHJcbiAgICBpZiAoIW1hdGNoZXMobm9kZSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIHJvdy5jbGFzc05hbWUgPSBgdHJlZS1yb3cke3N0YXRlLnNlbGVjdGVkSWQgPT09IG5vZGUuaWQgPyAnIGlzLXNlbGVjdGVkJyA6ICcnfWA7XHJcbiAgICByb3cuZGF0YXNldC5ub2RlSWQgPSBub2RlLmlkO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgncm9sZScsICd0cmVlaXRlbScpO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgnYXJpYS1sZXZlbCcsIFN0cmluZyhkZXB0aCArIDEpKTtcclxuXHJcbiAgICBjb25zdCBtYWluID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBtYWluLmNsYXNzTmFtZSA9ICdub2RlLW1haW4nO1xyXG4gICAgbWFpbi5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhkZXB0aCkpO1xyXG4gICAgY29uc3QgY29sbGFwc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcclxuICAgIGNvbGxhcHNlLmNsYXNzTmFtZSA9IGBjb2xsYXBzZSR7bm9kZS5jaGlsZHJlbi5sZW5ndGggPyAnJyA6ICcgaXMtbGVhZid9YDtcclxuICAgIGNvbGxhcHNlLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGNvbGxhcHNlLmRhdGFzZXQuY29sbGFwc2UgPSBub2RlLmlkO1xyXG4gICAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+KAuicgOiAn4oyEJztcclxuICAgIGNvbGxhcHNlLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIHN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgPyAn5bGV5byAJyA6ICfmipjlj6AnKTtcclxuICAgIGNvbnN0IGRvdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIGRvdC5jbGFzc05hbWUgPSBgdHlwZS1kb3QgJHtcclxuICAgICAgICBub2RlLnR5cGUgPT09ICdURVhUJyA/ICd0ZXh0J1xyXG4gICAgICAgICAgICA6IGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICd2ZWN0b3InXHJcbiAgICAgICAgICAgICAgICA6IG5vZGUudHlwZS5pbmNsdWRlcygnQ09NUE9ORU5UJykgfHwgbm9kZS50eXBlID09PSAnSU5TVEFOQ0UnID8gJ2NvbXBvbmVudCdcclxuICAgICAgICAgICAgICAgICAgICA6ICcnXHJcbiAgICB9YDtcclxuICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIGNvcHkuY2xhc3NOYW1lID0gJ25vZGUtY29weSc7XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbmFtZS5jbGFzc05hbWUgPSBgbm9kZS1uYW1lJHtzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/ICcgaXMtcmVuYW1lZCcgOiAnJ31gO1xyXG4gICAgbmFtZS50ZXh0Q29udGVudCA9IGRpc3BsYXlOYW1lO1xyXG4gICAgY29uc3Qgc3RyYXRlZ3lTdW1tYXJ5ID0gc3RyYXRlZ3lTdW1tYXJ5Rm9yTm9kZShub2RlLCBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkpO1xyXG4gICAgbmFtZS50aXRsZSA9IFtcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gIDogJ+mAieaLqeiKgueCue+8jOWcqOWPs+S+p+S/ruaUueWvvOWFpeiKgueCueWQjScsXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5LFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nLFxyXG4gICAgXVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuam9pbignIMK3ICcpO1xyXG4gICAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbm9kZS1tZXRhJztcclxuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtub2RlLnR5cGV9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvcHkuYXBwZW5kKG5hbWUsIG1ldGEpO1xyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSkge1xyXG4gICAgICAgIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgc3RyYXRlZ3kuY2xhc3NOYW1lID0gJ25vZGUtc3RyYXRlZ3knO1xyXG4gICAgICAgIHN0cmF0ZWd5LnRleHRDb250ZW50ID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIHN0cmF0ZWd5LnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQoc3RyYXRlZ3kpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSB7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHdhcm5pbmcuY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgd2FybmluZy50ZXh0Q29udGVudCA9IGDimqAgJHtzdHJhdGVneVN1bW1hcnkud2FybmluZ31gO1xyXG4gICAgICAgIHdhcm5pbmcudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkud2FybmluZztcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHdhcm5pbmcpO1xyXG4gICAgfVxyXG4gICAgcm93LmNsYXNzTGlzdC50b2dnbGUoJ2hhcy1kZXRhaWwnLCBCb29sZWFuKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSB8fCBzdHJhdGVneVN1bW1hcnkud2FybmluZykpO1xyXG4gICAgbWFpbi5hcHBlbmQoY29sbGFwc2UsIGRvdCwgY29weSk7XHJcblxyXG4gICAgY29uc3QgYWN0aW9uQmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBhY3Rpb25CYWRnZS5jbGFzc05hbWUgPSAnbm9kZS1hY3Rpb24tYmFkZ2UnO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGFjdGlvbkJhZGdlLnRleHRDb250ZW50ID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSkuZmluZCgoW3ZhbHVlXSkgPT4gdmFsdWUgPT09IHNlbGVjdGVkQWN0aW9uKT8uWzFdID8/IHNlbGVjdGVkQWN0aW9uO1xyXG4gICAgYWN0aW9uQmFkZ2UudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgYWN0aW9uQmFkZ2UudGV4dENvbnRlbnQ7XHJcbiAgICByb3cuYXBwZW5kKG1haW4sIGFjdGlvbkJhZGdlKTtcclxuICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChyb3cpO1xyXG5cclxuICAgIGlmICghc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiBhcHBlbmRUcmVlTm9kZShjb250YWluZXIsIGNoaWxkLCBkZXB0aCArIDEpKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyTm9kZVByb3BlcnRpZXMoKTogdm9pZCB7XHJcbiAgICBjb25zdCBjb250YWluZXIgPSBlbGVtZW50KCcjbm9kZS1wcm9wZXJ0aWVzJyk7XHJcbiAgICBjb250YWluZXIucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBub2RlID0gc3RhdGUuc2VsZWN0ZWRJZCA/IGZpbmROb2RlKHN0YXRlLnNlbGVjdGVkSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2luc3BlY3Rvci1lbXB0eSc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6YCJ5oup6IqC54K577yM5p+l55yL6aKE6KeI5bm26LCD5pW05a+85YWl6K6+572u44CCJztcclxuICAgICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGRpc3BsYXlOYW1lID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICBjb25zdCBmaWVsZCA9IChsYWJlbDogc3RyaW5nLCBjb250cm9sOiBIVE1MRWxlbWVudCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmaWVsZCc7XHJcbiAgICAgICAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBoZWFkaW5nLnRleHRDb250ZW50ID0gbGFiZWw7XHJcbiAgICAgICAgcm93LmFwcGVuZChoZWFkaW5nLCBjb250cm9sKTtcclxuICAgICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcclxuICAgIG5hbWUudHlwZSA9ICd0ZXh0JztcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gJ25vZGUtbmFtZS1pbnB1dCc7XHJcbiAgICBuYW1lLnZhbHVlID0gZGlzcGxheU5hbWU7XHJcbiAgICBuYW1lLm1heExlbmd0aCA9IDk2O1xyXG4gICAgbmFtZS5zcGVsbGNoZWNrID0gZmFsc2U7XHJcbiAgICBuYW1lLmRhdGFzZXQubmFtZUZvciA9IG5vZGUuaWQ7XHJcbiAgICBuYW1lLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke25vZGUubmFtZX0g5a+85YWl6IqC54K55ZCNYCk7XHJcbiAgICBuYW1lLnRpdGxlID0gYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfe+8m0VudGVyIOS/neWtmO+8jEVzYyDlj5bmtohgO1xyXG4gICAgbmFtZS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBmaWVsZCgn5a+85YWl6IqC54K55ZCNJywgbmFtZSk7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGNvbnN0IGFjdGlvbk9wdGlvbnMgPSBhY3Rpb25PcHRpb25zRm9yTm9kZShub2RlKTtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2FjdGlvbi1zZWxlY3QnLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIGFjdGlvbk9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOWvvOWFpeaWueW8j2AsXHJcbiAgICApO1xyXG4gICAgYWN0aW9uLmRhdGFzZXQuYWN0aW9uRm9yID0gbm9kZS5pZDtcclxuICAgIGFjdGlvbi5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBmaWVsZCgn5a+85YWl5pa55byPJywgYWN0aW9uKTtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEtpbmQgPSBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGVmZmVjdGl2ZUtpbmRGb3JOb2RlKFxyXG4gICAgICAgIG5vZGUsXHJcbiAgICAgICAgc2VsZWN0ZWRLaW5kLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGtpbmRPcHRpb25zID0ga2luZE9wdGlvbnNGb3JBY3Rpb24oc2VsZWN0ZWRBY3Rpb24pO1xyXG4gICAgY29uc3Qga2luZCA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2tpbmQtc2VsZWN0JyxcclxuICAgICAgICBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGtpbmRPcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDoioLngrnnsbvlnotgLFxyXG4gICAgKTtcclxuICAgIGtpbmQuZGF0YXNldC5raW5kRm9yID0gbm9kZS5pZDtcclxuICAgIGtpbmQuZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+iKgueCueexu+WeiycsIGtpbmQpO1xyXG5cclxuICAgIGNvbnN0IHBhdGNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcclxuICAgIHBhdGNoLmNsYXNzTmFtZSA9ICd0b2dnbGUtcm93IHBhdGNoLXRvZ2dsZSc7XHJcbiAgICBwYXRjaC50aXRsZSA9IG5vZGUucGF0Y2hDYW5kaWRhdGVcclxuICAgICAgICA/ICdGaWdtYSDliIbniYfkvJjlhYjvvJrmjIkgRmlnbWEg5Y6f5aeL6L6555WM5a+85YWl77yM5LiN6IO95YWz6Zet77yb5LuN5Y+v5b+955Wl5pW05Liq6IqC54K5J1xyXG4gICAgICAgIDogJ+ivpeiKgueCueS4jeaYr+acieaViOeahCBGaWdtYSDliIbniYcnO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICBjb25zdCBwYXRjaEljb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBwYXRjaEljb24udGV4dENvbnRlbnQgPSBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgPyBub2RlLnNsaWNlTW9kZSA9PT0gJ25pbmUnID8gJ0ZpZ21hIOS5neWuqyDCtyDkvJjlhYjlkK/nlKgnIDogbm9kZS5zbGljZU1vZGUgPyAnRmlnbWEg5LiJ5a6rIMK3IOS8mOWFiOWQr+eUqCcgOiAnRmlnbWEg5LiJIC8g5Lmd5a6rIMK3IOS8mOWFiOWQr+eUqCdcclxuICAgICAgICA6ICfliIfniYcgwrcg6Z2e5YCZ6YCJ6IqC54K5JztcclxuICAgIHBhdGNoLmFwcGVuZChwYXRjaElucHV0LCBwYXRjaEljb24pO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHBhdGNoKTtcclxuICAgIGNvbnN0IHN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBjb25zdCBub3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBub3RlLmNsYXNzTmFtZSA9ICdub2RlLWluc3BlY3Rvci1ub3RlJztcclxuICAgIGNvbnN0IGhpZGRlbklnbm9yZWQgPSBoaWRkZW5MYXllcklkcyhzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSwgc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSkuaGFzKG5vZGUuaWQpO1xyXG4gICAgZm9yIChjb25zdCB0ZXh0IG9mIFtoaWRkZW5JZ25vcmVkID8gJ+makOiXj+WbvuWxgiDCtyDmnKzmrKHlv73nlaXvvIjlkKvlhbblrZDmoJHvvInvvJvlvIDlkK/igJzlr7zlhaXpmpDol4/lm77lsYLigJ3lj6/mgaLlpI3ljp/nrZbnlaUnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHN1bW1hcnkuc3RyYXRlZ3ksIGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gLCBzdW1tYXJ5Lndhcm5pbmddKSB7XHJcbiAgICAgICAgaWYgKCF0ZXh0KSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBwYXJhZ3JhcGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgcGFyYWdyYXBoLnRleHRDb250ZW50ID0gdGV4dDtcclxuICAgICAgICBpZiAodGV4dCA9PT0gc3VtbWFyeS53YXJuaW5nKSBwYXJhZ3JhcGguY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgbm90ZS5hcHBlbmRDaGlsZChwYXJhZ3JhcGgpO1xyXG4gICAgfVxyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKG5vdGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJUcmVlKHJlc2V0U2Nyb2xsID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRyZWUgPSBlbGVtZW50KCcjdHJlZScpO1xyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsKHRyZWUsICgpID0+IHtcclxuICAgICAgICB0cmVlLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2VtcHR5LXN0YXRlJztcclxuICAgICAgICAgICAgY29uc3QgZ2x5cGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgICAgIGdseXBoLmNsYXNzTmFtZSA9ICdlbXB0eS1nbHlwaCc7XHJcbiAgICAgICAgICAgIGdseXBoLnRleHRDb250ZW50ID0gJ+KGsyc7XHJcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XHJcbiAgICAgICAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ+i/mOayoeacieiKgueCuSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOmTvuaOpeWQju+8jOWPr+mAkOWxgumAieaLqeeUn+aIkOOAgVBORyDmlbTlsYLmiJbmm7TmlrDjgIInO1xyXG4gICAgICAgICAgICBlbXB0eS5hcHBlbmQoZ2x5cGgsIHRpdGxlLCBib2R5KTtcclxuICAgICAgICAgICAgdHJlZS5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQudHJlZS5mb3JFYWNoKChub2RlKSA9PiBhcHBlbmRUcmVlTm9kZSh0cmVlLCBub2RlLCAwKSk7XHJcbiAgICB9LCByZXNldFNjcm9sbCk7XHJcbiAgICByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KCk6IHZvaWQge1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyQmF0Y2goKTsgfVxyXG4gICAgY29uc3Qgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudCA/IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkgOiBbXTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gbm9kZXMuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSAhPT0gJ2lnbm9yZScpO1xyXG4gICAgZWxlbWVudCgnI25vZGUtY291bnQnKS50ZXh0Q29udGVudCA9IGAke25vZGVzLmxlbmd0aH0g6IqC54K5YDtcclxuICAgIGVsZW1lbnQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICA/IGAke3NlbGVjdGVkLmxlbmd0aH0gLyAke25vZGVzLmxlbmd0aH0g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYFxyXG4gICAgICAgIDogJ+etieW+heiuvuiuoeaVsOaNric7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3lcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc2VsZWN0ZWQubGVuZ3RoXHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3KG5vZGU6IFRyZWVOb2RlRHRvKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBub2RlLmlkO1xyXG4gICAgY29uc3QgcmV2aXNpb24gPSArK3ByZXZpZXdSZXZpc2lvbjtcclxuICAgIGNvbnN0IGZyYW1lSWQgPSBhY3RpdmVCYXRjaElkO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvbnN0IHN0YWdlID0gZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKTtcclxuICAgIGNvbnN0IGltYWdlID0gZWxlbWVudDxIVE1MSW1hZ2VFbGVtZW50PignI3ByZXZpZXctaW1hZ2UnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2lzLWxvYWRpbmcnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2hhcy1pbWFnZScpO1xyXG4gICAgaW1hZ2UucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcHJlY2VkaW5nU3luYyA9IGJhdGNoU3luY1Rhc2s7XHJcbiAgICAgICAgY29uc3QgcmVhZCA9IHByZXZpZXdSZWFkVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVjZWRpbmdTeW5jO1xyXG4gICAgICAgICAgICBpZiAocHJldmlld1JldmlzaW9uICE9PSByZXZpc2lvbiB8fCBmcmFtZUlkICE9PSBhY3RpdmVCYXRjaElkKSByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgcmV0dXJuIHJlcXVlc3Q8eyB1cmw6IHN0cmluZyB9PignZ2V0LXByZXZpZXcnLCBub2RlLmlkKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBwcmV2aWV3UmVhZFRhc2sgPSByZWFkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVhZDtcclxuICAgICAgICBpZiAoIXJlc3VsdCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChzdGF0ZS5zZWxlY3RlZElkICE9PSBub2RlLmlkIHx8IHByZXZpZXdSZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgZnJhbWVJZCAhPT0gYWN0aXZlQmF0Y2hJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6aKE6KeI5Zu+54mH5Yqg6L295aSx6LSl44CCJykpO1xyXG4gICAgICAgICAgICBpbWFnZS5zcmMgPSByZXN1bHQudXJsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gPT09IHJldmlzaW9uKSBzdGFnZS5jbGFzc0xpc3QuYWRkKCdoYXMtaW1hZ2UnKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpooTop4jlpLHotKXjgIInLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLWxvYWRpbmcnKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlQcmVzZXQobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxsID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgIGlmIChuYW1lID09PSAnc21hcnQnKSB7XHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gc3RhdGUuZGVmYXVsdHMuZ2V0KG5vZGUuaWQpITtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgb3JpZ2luYWwuYWN0aW9uKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmtpbmQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobmFtZSA9PT0gJ2VkaXRhYmxlJykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3JlbmRlcicgOiAnZ2VuZXJhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyAnZ2VuZXJhdGUnXHJcbiAgICAgICAgICAgICAgICA6ICdyZW5kZXInKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IG5hbWUpO1xyXG4gICAgfSk7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRUb1NjZW5lKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHdvcmtmbG93ICYmIHdvcmtmbG93LnN0ZXAgIT09IDMpIHJldHVybjtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+aJqeWxleS4u+i/m+eoi+S7jeaYr+aXp+eJiO+8jOivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCB8fCBzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoKTtcclxuICAgIGlmICghc2V0dGluZ3MpIHtcclxuICAgICAgICB3b3JrZmxvdz8uZmFpbCgn6K+35qOA5p+l5a+85YWl5YCN546H5LiO6L6T5Ye655uu5b2V77yM5L+u5q2j5ZCO5YaN5qyh5a+85YWl44CCJyk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHJlY29uY2lsZUJhdGNoVmlzaWJpbGl0eSgpO1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYXdhaXQgaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3MpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24sXHJcbiAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSkpO1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTtcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlh4blpIflr7zlhaXigKYnIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PFdvcmtmbG93UmVzdWx0PihcclxuICAgICAgICAgICAgJ2ltcG9ydC1zZWxlY3Rpb24nLFxyXG4gICAgICAgICAgICB7IG92ZXJyaWRlcywgc2V0dGluZ3MsIHNraXBTeW5jTm9kZUlkczogd29ya2Zsb3c/LnNraXBwZWRTeW5jTm9kZXMgPz8gW10gfSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrTm90ZSA9IHJlc3VsdD8ud2FybmluZ3M/Lmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDvvJske3Jlc3VsdC53YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrvvIjor6bop4Hnu5Pmnpzmo4Dmn6XvvIlgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZShyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHJlc3VsdC5yZXZpZXcgPz8gcGVuZGluZ0ltcG9ydFJldmlldztcclxuICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogd29ya2Zsb3c/LmNhbmNlbGxlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsIG1lc3NhZ2UgfSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpO1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICAvLyDlr7zlhaXlkI4gUHJlZmFiIOW3sue7j+WtmOWcqO+8jOWIt+aWsOS4gOasoemihOajgO+8jOS4i+S4gOasoeeCueW8gOesrCAzIOatpeWwseiDveeci+WIsOW3ruW8guOAglxyXG4gICAgICAgIHZvaWQgcmVmcmVzaFN5bmNQcmV2aWV3KCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1lcmdlQmF0Y2hJdGVtcyhpdGVtczogQmF0Y2hGcmFtZUl0ZW1bXSk6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgcHJldmlvdXMgPSBiYXRjaEl0ZW1zLmZpbmQoKGVudHJ5KSA9PiBlbnRyeS5pdGVtLmlkID09PSBpdGVtLmlkKTtcclxuICAgICAgICBpZiAocHJldmlvdXMpIHByZXZpb3VzLml0ZW0gPSB7IC4uLml0ZW0sIGVuYWJsZWQ6IHByZXZpb3VzLml0ZW0uZW5hYmxlZCB9O1xyXG4gICAgICAgIGVsc2UgYmF0Y2hJdGVtcy5wdXNoKHsgaXRlbSwgZWRpdG9yOiBpbml0aWFsRnJhbWVFZGl0b3IoaXRlbS5kb2N1bWVudCksIGNvbmZpZ3VyZWQ6IEJvb2xlYW4oaXRlbS5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzPy5sZW5ndGgpIH0pO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZWFkQmF0Y2hTb3VyY2UoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgaWYgKHdvcmtmbG93ICYmICF3b3JrZmxvdy5jcmVkZW50aWFsc1JlYWR5KSB7IHdvcmtmbG93Lm9wZW5DcmVkZW50aWFscygpOyByZXR1cm47IH1cclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHsgc2hvd1RvYXN0KCfor7fnspjotLQgRmlnbWEgU2VjdGlvbiDmiJYgRnJhbWUg6ZO+5o6l44CCJywgdHJ1ZSk7IHJldHVybjsgfVxyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpOyBpZiAoc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICB3b3JrZmxvdz8uYmVnaW4oJ2ZldGNoJyk7IHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4wNSwgbWVzc2FnZTogJ+ato+WcqOivu+WPluW5tuivhuWIqyBGaWdtYSDnlYzpnaLigKYnIH0pO1xyXG4gICAgbGV0IGFjdGl2YXRlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3JCYXRjaExpc3RSZWFkeSgpO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTb3VyY2VSZXN1bHQ+KCdyZXNvbHZlLWJhdGNoLXNvdXJjZScsIHNvdXJjZSk7XHJcbiAgICAgICAgaWYgKHJlc3VsdC5kb2N1bWVudCAmJiAhcmVzdWx0Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBiYXRjaEl0ZW1zID0gW107IGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7IGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gcmVzdWx0LmRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KHJlc3VsdC5kb2N1bWVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKHJlc3VsdC5pdGVtcyk7XHJcbiAgICAgICAgICAgIGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gQXJyYXkuZnJvbShuZXcgTWFwKGJhdGNoSXRlbXMuZmxhdE1hcCgoeyBpdGVtIH0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBbXSkubWFwKChmb250KSA9PiBbZm9udC51cmwsIGZvbnRdKSkudmFsdWVzKCkpO1xyXG4gICAgICAgICAgICBhY3RpdmF0ZSA9IHNlbGVjdGVkRnJhbWVzKCkuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpPy5pdGVtLmlkID8/IHNlbGVjdGVkRnJhbWVzKClbMF0/Lml0ZW0uaWQgPz8gYmF0Y2hJdGVtc1swXT8uaXRlbS5pZDtcclxuICAgICAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTtcclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uYmF0Y2hSZWFkeSgpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3sua3u+WKoCAke3Jlc3VsdC5hZGRlZH0g5Liq55WM6Z2iJHtyZXN1bHQuZHVwbGljYXRlcyA/IGDvvIzot7Pov4cgJHtyZXN1bHQuZHVwbGljYXRlc30g5Liq6YeN5aSN6aG5YCA6ICcnfeOAgmApO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluWksei0peOAgicpO1xyXG4gICAgICAgIGlmICghd29ya2Zsb3c/LmNhbmNlbGxlZCkgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KHdvcmtmbG93Py5jYW5jZWxsZWQgPyAn6K+75Y+W5bey5Y+W5raI77yM6YWN572u5bey5L+d55WZ44CCJyA6IG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICBpZiAoYWN0aXZhdGUpIGF3YWl0IGFjdGl2YXRlRnJhbWUoYWN0aXZhdGUpO1xyXG4gICAgICAgIHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gb3ZlcnJpZGVzRm9yRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgY29uc3QgZWRpdG9yID0gZW50cnkuZWRpdG9yID8/IGluaXRpYWxGcmFtZUVkaXRvcihlbnRyeS5pdGVtLmRvY3VtZW50KTtcclxuICAgIHJldHVybiBmbGF0dGVuKGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLCBhY3Rpb246IGVkaXRvci5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbiwga2luZDogZWRpdG9yLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBlZGl0b3IucGF0Y2hlcy5oYXMobm9kZS5pZCksIGV4cGxpY2l0OiBlZGl0b3IuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIC4uLihlZGl0b3IucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVkaXRvci5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lIH0gOiB7fSksXHJcbiAgICB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncywgaWRzPzogU2V0PHN0cmluZz4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5IHx8IGJhdGNoSW1wb3J0UGVuZGluZykgcmV0dXJuO1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHJlY29uY2lsZUJhdGNoVmlzaWJpbGl0eSgpO1xyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3QgZW50cmllcyA9IHNlbGVjdGVkRnJhbWVzKCkuZmlsdGVyKCh7IGl0ZW0gfSkgPT4gIWlkcyB8fCBpZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGlmICghZW50cmllcy5sZW5ndGgpIHsgc2hvd1RvYXN0KCfor7flhYjli77pgInopoHlr7zlhaXnmoTnlYzpnaLjgIInLCB0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICBpZiAoYmF0Y2hDb25mbGljdHMoKS5zaXplKSB7IHdvcmtmbG93Py5mYWlsKCflrZjlnKjph43lpI3nmoQgUHJlZmFiIOaWh+S7tuWQje+8jOivt+WFiOWcqOa4heWNleS4reaUueWQjeOAgicpOyByZXR1cm47IH1cclxuICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IHRydWU7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7IGJhdGNoU3RvcFJlcXVlc3RlZCA9IGZhbHNlO1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBiYXRjaFJlc3VsdDtcclxuICAgIHdvcmtmbG93Py5iZWdpbignaW1wb3J0Jyk7IHNldEJ1c3kodHJ1ZSk7IHJlbmRlckJhdGNoKCk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6IGDlh4blpIflr7zlhaUgJHtlbnRyaWVzLmxlbmd0aH0g5Liq55WM6Z2i4oCmYCB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvckJhdGNoTGlzdFJlYWR5KCk7XHJcbiAgICAgICAgYXdhaXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s7XHJcbiAgICAgICAgaWYgKGJhdGNoU3RvcFJlcXVlc3RlZCkge1xyXG4gICAgICAgICAgICBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHsgaWQ6ICdzdG9wcGVkLWJlZm9yZS1zdGFydCcsIHN0b3BwZWQ6IHRydWUsIGNvbXBsZXRlZDogMCwgdG90YWw6IGVudHJpZXMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgICAgaXRlbXM6IGVudHJpZXMubWFwKCh7IGl0ZW0gfSkgPT4gKHsgaWQ6IGl0ZW0uaWQsIG5hbWU6IGl0ZW0ubmFtZSwgc291cmNlVXJsOiBpdGVtLnNvdXJjZVVybCwgc3RhdHVzOiAncGVuZGluZycgfSkpIH0pO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hJbXBvcnRSZXN1bHQ+KCdpbXBvcnQtYmF0Y2gnLCB7XHJcbiAgICAgICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoZW50cnkpID0+ICh7IGlkOiBlbnRyeS5pdGVtLmlkLCBvdmVycmlkZXM6IG92ZXJyaWRlc0ZvckZyYW1lKGVudHJ5KSB9KSksIHNldHRpbmdzLFxyXG4gICAgICAgICAgICBmYWlsdXJlUG9saWN5OiAnY29udGludWUnLCBwcmVzZXJ2ZVJlc3VsdHM6IEJvb2xlYW4oaWRzKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25zdCBtZXJnZWQgPSBpZHMgJiYgcHJldmlvdXMgPyBwcmV2aW91cy5pdGVtcy5tYXAoKGl0ZW0pID0+IHJlc3VsdC5pdGVtcy5maW5kKChuZXh0KSA9PiBuZXh0LmlkID09PSBpdGVtLmlkKSA/PyBpdGVtKSA6IHJlc3VsdC5pdGVtcztcclxuICAgICAgICBiYXRjaFJlc3VsdCA9IHsgLi4ucmVzdWx0LCBpdGVtczogbWVyZ2VkLCB0b3RhbDogbWVyZ2VkLmxlbmd0aCwgY29tcGxldGVkOiBtZXJnZWQuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnIHx8IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoIH07XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDsgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0uY3JlYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgY29uc3QgdXBkYXRlZCA9IG1lcmdlZC5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgY3JlYXRlZCwgdXBkYXRlZCwgd2FybmluZ3M6IG1lcmdlZC5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSB9KTtcclxuICAgICAgICBzaG93VG9hc3QoYOacrOaJueWujOaIkO+8muaIkOWKnyAke21lcmdlZC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aH0g6aG577yM5aSx6LSlICR7bWVyZ2VkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGh9IOmhueOAgmApO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5om56YeP5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7IHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmV0cnlCYXRjaChzdGF0dXM6ICdmYWlsZWQnIHwgJ3BlbmRpbmcnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSB8fCAhYmF0Y2hSZXN1bHQpIHJldHVybjtcclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7IGlmICghc2V0dGluZ3MpIHJldHVybjtcclxuICAgIGNvbnN0IGlkcyA9IG5ldyBTZXQoYmF0Y2hSZXN1bHQuaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gc3RhdHVzKS5tYXAoKGl0ZW0pID0+IGl0ZW0uaWQpKTtcclxuICAgIGF3YWl0IGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzLCBpZHMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQpOiB2b2lkIHtcclxuICAgIGJhdGNoUmVzdWx0ID0gcmVzdWx0OyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgd29ya2Zsb3c/LmNvbXBsZXRlKHtcclxuICAgICAgICBjcmVhdGVkOiByZXN1bHQuaXRlbXMucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLmNyZWF0ZWQgPz8gMCksIDApLFxyXG4gICAgICAgIHVwZGF0ZWQ6IHJlc3VsdC5pdGVtcy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0udXBkYXRlZCA/PyAwKSwgMCksXHJcbiAgICAgICAgd2FybmluZ3M6IHJlc3VsdC5pdGVtcy5mbGF0TWFwKChpdGVtKSA9PiBpdGVtLndhcm5pbmdzID8/IFtdKSxcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyQmF0Y2goKTtcclxufVxyXG5cclxuZnVuY3Rpb24gd2F0Y2hSZXN0b3JlZEJhdGNoKCk6IHZvaWQge1xyXG4gICAgYmF0Y2hSZWNvdmVyeVRpbWVyID0gc2V0VGltZW91dChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFwYW5lbEhvc3QpIHJldHVybjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCByZXF1ZXN0PEJhdGNoU3RhdGU+KCdnZXQtYmF0Y2gtc3RhdGUnKTtcclxuICAgICAgICAgICAgaWYgKHJlY292ZXJlZC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICBiYXRjaFByb2dyZXNzID0gcmVjb3ZlcmVkLnJ1bm5pbmc7IHJlbmRlckJhdGNoUmVzdWx0cygpOyB3YXRjaFJlc3RvcmVkQmF0Y2goKTsgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChyZWNvdmVyZWQubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihyZWNvdmVyZWQubGFzdFJlc3VsdCk7XHJcbiAgICAgICAgICAgIGVsc2Ugd29ya2Zsb3c/LmZhaWwoJ+WQjuWPsOaJuemHj+S7u+WKoeW3sue7j+e7k+adn++8jOivt+ajgOafpSBDb2NvcyDkuK3nmoTlr7zlhaXnu5PmnpzjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpOyB3b3JrZmxvdz8uZmFpbChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5blkI7lj7Dmibnph4/ku7vliqHlpLHotKXjgIInKSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSwgODAwKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkltcG9ydFJldmlldyh0YWI6ICdhc3NldHMnIHwgJ25vZGVzJyB8ICdzb3VyY2UnID0gJ2Fzc2V0cycpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgaWYgKHJldmlldykge1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmRleCA9IFsnYXNzZXRzJywgJ25vZGVzJywgJ3NvdXJjZSddLmluZGV4T2YodGFiKTtcclxuICAgICAgICAgICAgaWYgKGluZGV4ID4gMCkgZWxlbWVudCgnI2ltcG9ydC1yZXZpZXctZGlhbG9nJykucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJy5yZXZpZXctdGFicyBidXR0b24nKVtpbmRleF0/LmNsaWNrKCk7XHJcbiAgICAgICAgfSBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5qOA5p+l57uT5p6c5aSx6LSl44CCJyksIHRydWUpOyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IHZvaWQgb3BlbkltcG9ydFJldmlldygpOyB9KTtcclxuICAgIGVsZW1lbnQoJyNzYXZlLXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdG9rZW4taW5wdXQnKTtcclxuICAgICAgICBpZiAoIWlucHV0LnZhbHVlLnRyaW0oKSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSBUb2tlbuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBzYXZlZCA9IGZhbHNlO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgdmF1bHQgPSBhd2FpdCByZXF1ZXN0PGFueT4oJ3NldC10b2tlbicsIGlucHV0LnZhbHVlKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbih2YXVsdCk7XHJcbiAgICAgICAgICAgIHNhdmVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzYXZlZCkgd29ya2Zsb3c/LmNsb3NlQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBmb3JjZVJlYWQgPSBmb3JjZURvY3VtZW50UmVhZDtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IGZhbHNlO1xyXG4gICAgICAgIGlmICh3b3JrZmxvdyAmJiAhd29ya2Zsb3cuY3JlZGVudGlhbHNSZWFkeSkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdy5vcGVuQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGggJiYgIWZvcmNlUmVhZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHNlbGVjdGVkRnJhbWVzKCk7XHJcbiAgICAgICAgICAgIGlmICghc2VsZWN0ZWQubGVuZ3RoKSByZXR1cm47XHJcbiAgICAgICAgICAgIGF3YWl0IGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWQuc29tZSgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpID8gYWN0aXZlQmF0Y2hJZCEgOiBzZWxlY3RlZFswXS5pdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZm9yY2VSZWFkICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlKSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gYWN0aXZlLml0ZW0uc291cmNlVXJsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWZvcmNlUmVhZCAmJiB3b3JrZmxvdz8uc291cmNlVW5jaGFuZ2VkKCkpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3cubmF2aWdhdGUoMik7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgcmVhZEJhdGNoU291cmNlKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNhZGQtYmF0Y2gtc291cmNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCByZWFkQmF0Y2hTb3VyY2UpO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWVkaXQtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gd29ya2Zsb3c/Lm5hdmlnYXRlKDEpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC10b2dnbGUtYWxsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBhdmFpbGFibGVGcmFtZXMoKTtcclxuICAgICAgICBjb25zdCBlbmFibGVkID0gc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGggIT09IGF2YWlsYWJsZS5sZW5ndGg7XHJcbiAgICAgICAgYXZhaWxhYmxlLmZvckVhY2goKHsgaXRlbSB9KSA9PiB7IGl0ZW0uZW5hYmxlZCA9IGVuYWJsZWQ7IH0pO1xyXG4gICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7IHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmV0cnktZmFpbGVkJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiByZXRyeUJhdGNoKCdmYWlsZWQnKSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdW1lLXBlbmRpbmcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJldHJ5QmF0Y2goJ3BlbmRpbmcnKSk7XHJcbiAgICBlbGVtZW50KCcjcmVmcmVzaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgZm9yY2VEb2N1bWVudFJlYWQgPSB0cnVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5jbGljaygpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2FkZC1iYXRjaC1zb3VyY2UnKS5jbGljaygpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlc2V0Um91bmR0cmlwVG9rZW5zKTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLWFzc2V0LWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stYXNzZXQtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6LWE5rqQ5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqei1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI3BpY2stcHJlZmFiLWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLXByZWZhYi1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6aKE5Yi25L2T5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqemihOWItuS9k+ebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LvvIzlho3pgInmi6nmnKzlnLDotYTmupDnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICAgICBpbmRleCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDlt7LlkK/nlKjmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqeacrOWcsOi1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBlbGVtZW50KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9ICcnO1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzaG93VG9hc3QoYOW3sua4hemZpOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBpbXBvcnRUb1NjZW5lKTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgaWYgKGJhdGNoSW1wb3J0UGVuZGluZykgYmF0Y2hTdG9wUmVxdWVzdGVkID0gdHJ1ZTtcclxuICAgICAgICB3b3JrZmxvdz8uY2FuY2VsUmVxdWVzdGVkKCk7XHJcbiAgICAgICAgdHJ5IHsgYXdhaXQgcmVxdWVzdChiYXRjaEltcG9ydFBlbmRpbmcgPyAnc3RvcC1pbXBvcnQtYmF0Y2gnIDogJ2NhbmNlbC1pbXBvcnQnKTsgfVxyXG4gICAgICAgIGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5Y+W5raI6K+35rGC5aSx6LSl77yM6K+356iN5ZCO6YeN6K+V44CCJyk7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5jYW5jZWxSZXF1ZXN0RmFpbGVkKG1lc3NhZ2UpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBzdGF0ZS5zZWFyY2ggPSAoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBjb2xsYXBzZUlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2xsYXBzZV0nKT8uZGF0YXNldC5jb2xsYXBzZTtcclxuICAgICAgICBpZiAoY29sbGFwc2VJZCkge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkLmhhcyhjb2xsYXBzZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmRlbGV0ZShjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5hZGQoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuY2xvc2VzdCgnc2VsZWN0LCBsYWJlbCwgaW5wdXQsIHRleHRhcmVhJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtbm9kZS1pZF0nKT8uZGF0YXNldC5ub2RlSWQ7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGlkID8gZmluZE5vZGUoaWQpIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHZvaWQgcHJldmlldyhub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGlmICghdGFyZ2V0LmRhdGFzZXQubmFtZUZvciAmJiAhdGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yICYmICF0YXJnZXQuZGF0YXNldC5raW5kRm9yICYmICF0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikgcmV0dXJuO1xyXG4gICAgICAgIGlmICh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XHJcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlmICghY3VzdG9tTmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+iKgueCueWQjeS4jeiDveS4uuepuuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgaWYgKGN1c3RvbU5hbWUgPT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKVxyXG4gICAgICAgICAgICAgICAgPyBg6IqC54K55bCG5Lul4oCcJHtjdXN0b21OYW1lfeKAneWvvOWFpeOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+W3suaBouWkjSBGaWdtYSDljp/oioLngrnlkI3jgIInKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHNhZmVBY3Rpb24obm9kZSwgdGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gIT09ICdyZW5kZXInICYmICFub2RlLnBhdGNoQ2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgYWN0aW9uKTtcclxuICAgICAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdyZW5kZXInICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGDigJwke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfeKAneWwhuS9nOS4uuaVtOWxguWvvOWFpe+8jCR7ZGVzY2VuZGFudHMobm9kZSkubGVuZ3RofSDkuKrlrZDoioLngrnkuI3kvJrljZXni6znlJ/miJDjgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpIHtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KHRhcmdldC5kYXRhc2V0LmtpbmRGb3IsIHRhcmdldC52YWx1ZSBhcyBOb2RlS2luZCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5raW5kRm9yKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSB7XHJcbiAgICAgICAgICAgIC8vIEFsc28gcmVqZWN0IGEgc3RhbGUgcGFuZWwvcHJvZ3JhbW1hdGljIGF0dGVtcHQgdG8gZGlzYWJsZSBhIHZhbGlkXHJcbiAgICAgICAgICAgIC8vIEZpZ21hIGRlZmluaXRpb247IHRoZSBzb3VyY2UgZGVjaXNpb24gaXMgc2hhcmVkIHdpdGggdGhlIGltcG9ydGVyLlxyXG4gICAgICAgICAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgaWYgKGZpbmROb2RlKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKT8ucGF0Y2hDYW5kaWRhdGUpIHNob3dUb2FzdCgnRmlnbWEg5YiG54mH5LyY5YWI77yM5LiN6IO95YWz6Zet77yb5Y+v5Zyo5a+85YWl5pa55byP5Lit5b+955Wl5pW05Liq6IqC54K544CCJyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuZGF0YXNldC5uYW1lRm9yO1xyXG4gICAgICAgIGlmICghaWQpIHJldHVybjtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseVByZXNldChidXR0b24uZGF0YXNldC5wcmVzZXQgPz8gJ3NtYXJ0JykpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1oaWRkZW4tbGF5ZXJzJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IHNldEltcG9ydEhpZGRlbkxheWVycyhlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjaW1wb3J0LWhpZGRlbi1sYXllcnMnKS5jaGVja2VkKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50PihcclxuICAgICAgICAnI3NjYWxlLCAjYXNzZXQtZm9sZGVyLCAjcHJlZmFiLWZvbGRlciwgI2xvY2FsLXJlc291cmNlLWZvbGRlciwgI3VwZGF0ZS1leGlzdGluZywgI3JlZnJlc2gtYXNzZXRzLCAjYXV0by1zYXZlJyxcclxuICAgICkuZm9yRWFjaCgoY29udHJvbCkgPT4ge1xyXG4gICAgICAgIGNvbnRyb2wuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmb250LW1hcC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoIWZhbWlseSkgcmV0dXJuO1xyXG4gICAgICAgIC8vIEFuIGVtcHR5IHN0cmluZyByZWNvcmRzIGFuIGV4cGxpY2l0IG9wdC1vdXQgZnJvbSBhdXRvbWF0aWMgbWF0Y2hpbmcuXHJcbiAgICAgICAgLy8gVW5yZW5kZXJlZCBmYW1pbGllcyBhbmQgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUgYXNzZXRzIHN0YXkgaW50YWN0LlxyXG4gICAgICAgIHN0YXRlLnNldHRpbmdzID0geyAuLi5zdGF0ZS5zZXR0aW5ncywgZm9udE1hcDogeyAuLi5zdGF0ZS5zZXR0aW5ncy5mb250TWFwLCBbZmFtaWx5XTogc2VsZWN0LnZhbHVlIH0gfTtcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSkgPz8gc3RhdGUuc2V0dGluZ3M7XHJcbiAgICAgICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gRWRpdG9yLlBhbmVsLmRlZmluZSh7XHJcbiAgICBsaXN0ZW5lcnM6IHtcclxuICAgICAgICBzaG93KCkge30sXHJcbiAgICAgICAgaGlkZSgpIHt9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGY4JyksXHJcbiAgICBzdHlsZTogcmVhZEZpbGVTeW5jKGpvaW4oX19kaXJuYW1lLCAnLi4vLi4vLi4vc3RhdGljL3N0eWxlL2RlZmF1bHQvaW5kZXguY3NzJyksICd1dGY4JyksXHJcbiAgICAkOiB7XHJcbiAgICAgICAgYXBwOiAnI2FwcCcsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge1xyXG4gICAgICAgIG9uSW1wb3J0UmV2aWV3UmVhZHkocmV2aWV3OiBJbXBvcnRSZXZpZXcpIHtcclxuICAgICAgICAgICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7IHdvcmtmbG93Py5yZW1lbWJlclJldmlldygpOyByZXR1cm47IH1cclxuICAgICAgICAgICAgaWYgKHN0YXRlLmJ1c3kgfHwgd29ya2Zsb3c/LnBlbmRpbmcpIHtcclxuICAgICAgICAgICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSByZXZpZXc7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb25Qcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCkge1xyXG4gICAgICAgICAgICB1cGRhdGVQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgfSxcclxuICAgIH0sXHJcbiAgICBhc3luYyByZWFkeSgpIHtcclxuICAgICAgICBwYW5lbEhvc3QgPSB0aGlzO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbmV3IEltcG9ydFJldmlld1BhbmVsKHJvb3QoKSwgcmVxdWVzdCwgc2V0QnVzeSk7XHJcbiAgICAgICAgd29ya2Zsb3cgPSBuZXcgUGFuZWxXb3JrZmxvdyhyb290KCksICgpID0+ICh7IC4uLnN0YXRlLCBiYXRjaDogYmF0Y2hDb250ZXh0KCkgfSksICh0YWIpID0+IHsgdm9pZCBvcGVuSW1wb3J0UmV2aWV3KHRhYik7IH0pO1xyXG4gICAgICAgIGJpbmRFdmVudHMoKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpbml0aWFsID0gYXdhaXQgcmVxdWVzdDx7XHJcbiAgICAgICAgICAgICAgICB2ZXJzaW9uPzogc3RyaW5nO1xyXG4gICAgICAgICAgICAgICAgdmF1bHQ6IGFueTtcclxuICAgICAgICAgICAgICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncztcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICAgICAgICAgIH0+KCdnZXQtc3RhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUucnVudGltZUNvbXBhdGlibGUgPSBpbml0aWFsLnZlcnNpb24gPT09IHBhY2thZ2VKU09OLnZlcnNpb247XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBpbml0aWFsLmZvbnRBc3NldHMgPz8gW107XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24oaW5pdGlhbC52YXVsdCk7XHJcbiAgICAgICAgICAgIGFwcGx5U2V0dGluZ3MoaW5pdGlhbC5zZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIGlmIChpbml0aWFsLmRvY3VtZW50KSB7XHJcbiAgICAgICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQoaW5pdGlhbC5kb2N1bWVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSBhd2FpdCByZXF1ZXN0PEJhdGNoU3RhdGUgfCB1bmRlZmluZWQ+KCdnZXQtYmF0Y2gtc3RhdGUnKTtcclxuICAgICAgICAgICAgaWYgKGJhdGNoPy5pdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIG1lcmdlQmF0Y2hJdGVtcyhiYXRjaC5pdGVtcyk7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gQXJyYXkuZnJvbShuZXcgTWFwKGJhdGNoLml0ZW1zLmZsYXRNYXAoKGl0ZW0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBbXSkubWFwKChmb250KSA9PiBbZm9udC51cmwsIGZvbnRdKSkudmFsdWVzKCkpO1xyXG4gICAgICAgICAgICAgICAgd29ya2Zsb3cuYmF0Y2hSZWFkeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aXZlID0gc2VsZWN0ZWRGcmFtZXMoKVswXSA/PyBiYXRjaEl0ZW1zWzBdO1xyXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoLnJ1bm5pbmcpIHtcclxuICAgICAgICAgICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gYWN0aXZlLml0ZW0uaWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihzdGF0ZSwgYWN0aXZlLmVkaXRvcik7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVuZGVyVHJlZSgpOyByZW5kZXJGb250TWFwKCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgYXdhaXQgYWN0aXZhdGVGcmFtZShhY3RpdmUuaXRlbS5pZCk7XHJcbiAgICAgICAgICAgICAgICByZW5kZXJCYXRjaCgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoLmxhc3RSZXN1bHQpIGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oYmF0Y2gubGFzdFJlc3VsdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGJhdGNoUHJvZ3Jlc3MgPSBiYXRjaC5ydW5uaW5nOyB3b3JrZmxvdy5iZWdpbignaW1wb3J0Jyk7IHNldEJ1c3kodHJ1ZSk7IHdhdGNoUmVzdG9yZWRCYXRjaCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+ivt+mHjeWQryBDb2Nvcyc7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oa7JztcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn5qOA5rWL5Yiw5pen54mI5Li76L+b56iL5LuN5Zyo6L+Q6KGM77ya6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIFJlcGxheSBwZXJzaXN0ZWQgaW4tbWVtb3J5IHJlcG9ydCBpZiBjb21wbGV0aW9uIHByZWNlZGVkIHBhbmVsIHJlYWRpbmVzcy5cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmV2aWV3KSB3b3JrZmxvdy5yZW1lbWJlclJldmlldygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJldmlldyAmJiAhcmV2aWV3LmNvbmZpcm1lZCAmJiAhYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICB3b3JrZmxvdy5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WIneWni+WMluWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcbiAgICBiZWZvcmVDbG9zZSgpIHt9LFxyXG4gICAgY2xvc2UoKSB7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/LmRpc3Bvc2UoKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG51bGw7XHJcbiAgICAgICAgd29ya2Zsb3cgPSBudWxsO1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIGlmICh0b2FzdFRpbWVyKSBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7XHJcbiAgICAgICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpZiAoYmF0Y2hSZWNvdmVyeVRpbWVyKSBjbGVhclRpbWVvdXQoYmF0Y2hSZWNvdmVyeVRpbWVyKTtcclxuICAgICAgICBiYXRjaEl0ZW1zID0gW107IGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7IGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IGZhbHNlOyBiYXRjaFN5bmNFcnJvciA9IHVuZGVmaW5lZDsgYmF0Y2hTeW5jVGFzayA9IFByb21pc2UucmVzb2x2ZSgpOyBwcmV2aWV3UmV2aXNpb24rKztcclxuICAgICAgICBwcmV2aWV3UmVhZFRhc2sgPSBQcm9taXNlLnJlc29sdmUoKTtcclxuICAgICAgICBwYW5lbEhvc3QgPSBudWxsO1xyXG4gICAgfSxcclxufSk7XHJcbiJdfQ==