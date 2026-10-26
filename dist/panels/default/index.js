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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQTJGO0FBRTNGLGtEQUEwRDtBQUUxRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCwrREFBeUU7QUFDekUsK0RBQXlEO0FBQ3pELG1DQVVpQjtBQW1FakIsSUFBSSxTQUFTLEdBQVEsSUFBSSxDQUFDO0FBQzFCLElBQUksaUJBQWlCLEdBQTZCLElBQUksQ0FBQztBQUN2RCxJQUFJLFFBQVEsR0FBeUIsSUFBSSxDQUFDO0FBQzFDLElBQUksbUJBQW1CLEdBQXdCLElBQUksQ0FBQztBQUNwRCxJQUFJLGlCQUFpQixHQUFHLEtBQUssQ0FBQztBQUM5QixJQUFJLFVBQVUsR0FBeUMsSUFBSSxDQUFDO0FBQzVELElBQUksc0JBQXNCLEdBQXlDLElBQUksQ0FBQztBQUN4RSxJQUFJLG9CQUFvQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDNUQsSUFBSSxxQkFBeUMsQ0FBQztBQUM5QyxJQUFJLGtCQUFzQyxDQUFDO0FBRzNDLElBQUksVUFBVSxHQUFzQixFQUFFLENBQUM7QUFDdkMsSUFBSSxhQUFpQyxDQUFDO0FBQ3RDLElBQUksV0FBMEMsQ0FBQztBQUMvQyxJQUFJLGFBQXdDLENBQUM7QUFDN0MsSUFBSSxhQUFhLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUNyRCxJQUFJLGNBQXVCLENBQUM7QUFDNUIsSUFBSSxrQkFBa0IsR0FBRyxLQUFLLENBQUM7QUFDL0IsSUFBSSxrQkFBa0IsR0FBRyxLQUFLLENBQUM7QUFDL0IsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO0FBQ3hCLElBQUksZUFBZSxHQUFxQixPQUFP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LEdBQUcsR0FBRyxJQUFJLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsTUFBQSxNQUFNLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDLG1DQUFJLElBQUksQ0FBQSxFQUFBLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQztRQUN2SSxXQUFXLEdBQUcsRUFBRSxHQUFHLE1BQU0sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ25LLGFBQWEsR0FBRyxTQUFTLENBQUM7UUFBQyxtQkFBbUIsR0FBRyxJQUFJLENBQUM7UUFDdEQsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsR0FBRyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsQ0FBQSxFQUFBLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDM0UsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsR0FBRyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsQ0FBQSxFQUFBLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDM0UsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLFFBQVEsQ0FB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QUFHLFNBQVMsQ0FBQztRQUFDLGFBQWEsR0FBRyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7UUFBQyxlQUFlLEVBQUUsQ0FBQztRQUM3RyxlQUFlLEdBQUcsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ3BDLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFDckIsQ0FBQztDQUNKLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vLi4vLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UGFuZWwgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBQYW5lbFdvcmtmbG93LCB0eXBlIEJhdGNoV29ya2Zsb3dDb250ZXh0LCB0eXBlIFdvcmtmbG93UmVzdWx0IH0gZnJvbSAnLi93b3JrZmxvdyc7XHJcbmltcG9ydCB0eXBlIHsgQmF0Y2hGcmFtZUl0ZW0sIEJhdGNoSW1wb3J0SXRlbVJlc3VsdCwgQmF0Y2hJbXBvcnRSZXN1bHQsIEJhdGNoUHJvZ3Jlc3MsIEJhdGNoU291cmNlUmVzdWx0LCBCYXRjaFN0YXRlIH0gZnJvbSAnLi4vLi4vYmF0Y2gtdHlwZXMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZUFzc2V0TmFtZSB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2Fzc2V0cyc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi4vLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGZpbmRGb250QXNzZXQsIHR5cGUgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuLi8uLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuLi8uLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24gfSBmcm9tICcuLi8uLi9maWdtYS9pbXBvcnQtcGxhbm5lcic7XHJcbmltcG9ydCB7IGhpZGRlbkxheWVySWRzIH0gZnJvbSAnLi4vLi4vaW1wb3J0LXZpc2liaWxpdHknO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IGltcG9ydFJldmlld1BhbmVsOiBJbXBvcnRSZXZpZXdQYW5lbCB8IG51bGwgPSBudWxsO1xyXG5sZXQgd29ya2Zsb3c6IFBhbmVsV29ya2Zsb3cgfCBudWxsID0gbnVsbDtcclxubGV0IHBlbmRpbmdJbXBvcnRSZXZpZXc6IEltcG9ydFJldmlldyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZm9yY2VEb2N1bWVudFJlYWQgPSBmYWxzZTtcclxubGV0IHRvYXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBpbXBvcnRCdXR0b25SZXNldFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHJvdW5kdHJpcFByZXZpZXdUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgcm91bmR0cmlwUGFpclRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbnR5cGUgRnJhbWVFZGl0b3JTdGF0ZSA9IFBpY2s8UGFuZWxTdGF0ZSwgJ2RvY3VtZW50JyB8ICdwcmVmZXJyZWRBY3Rpb25zJyB8ICdhY3Rpb25zJyB8ICdraW5kcycgfCAncGF0Y2hlcycgfCAnZXhwbGljaXRJZHMnIHwgJ25hbWVzJyB8ICdyZW5hbWVkSWRzJyB8ICdkZWZhdWx0cycgfCAnY29sbGFwc2VkJyB8ICdzdXBwcmVzc2VkJyB8ICdzZWxlY3RlZElkJyB8ICdzZWFyY2gnPiAmIHsgdHJlZVNjcm9sbDogbnVtYmVyOyBwcmVzZXQ/OiBzdHJpbmcgfTtcclxuaW50ZXJmYWNlIEZyYW1lRWRpdG9ySXRlbSB7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBlZGl0b3I/OiBGcmFtZUVkaXRvclN0YXRlOyBjb25maWd1cmVkOiBib29sZWFuIH1cclxubGV0IGJhdGNoSXRlbXM6IEZyYW1lRWRpdG9ySXRlbVtdID0gW107XHJcbmxldCBhY3RpdmVCYXRjaElkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbmxldCBiYXRjaFJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQgfCB1bmRlZmluZWQ7XHJcbmxldCBiYXRjaFByb2dyZXNzOiBCYXRjaFByb2dyZXNzIHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hTeW5jVGFzazogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgYmF0Y2hTeW5jRXJyb3I6IHVua25vd247XHJcbmxldCBiYXRjaEltcG9ydFBlbmRpbmcgPSBmYWxzZTtcclxubGV0IGJhdGNoU3RvcFJlcXVlc3RlZCA9IGZhbHNlO1xyXG5sZXQgcHJldmlld1JldmlzaW9uID0gMDtcclxubGV0IHByZXZpZXdSZWFkVGFzazogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgYmF0Y2hSZWNvdmVyeVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5cclxuY29uc3Qgc3RhdGU6IFBhbmVsU3RhdGUgPSB7XHJcbiAgICBkb2N1bWVudDogbnVsbCxcclxuICAgIHNldHRpbmdzOiB7XHJcbiAgICAgICAgc291cmNlVXJsOiAnJyxcclxuICAgICAgICBhc3NldEZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyJyxcclxuICAgICAgICBwcmVmYWJGb2xkZXI6ICdmaWdtYS1pbXBvcnRlci9wcmVmYWJzJyxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogW10sXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogJycsXHJcbiAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZmFsc2UsXHJcbiAgICAgICAgYXV0b1NhdmU6IGZhbHNlLFxyXG4gICAgICAgIGltcG9ydEhpZGRlbkxheWVyczogdHJ1ZSxcclxuICAgICAgICBmb250TWFwOiB7fSxcclxuICAgIH0sXHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBhY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgcGF0Y2hlczogbmV3IFNldCgpLFxyXG4gICAgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSxcclxuICAgIG5hbWVzOiBuZXcgTWFwKCksXHJcbiAgICByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICBkZWZhdWx0czogbmV3IE1hcCgpLFxyXG4gICAgY29sbGFwc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzdXBwcmVzc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzZWFyY2g6ICcnLFxyXG4gICAgYnVzeTogZmFsc2UsXHJcbiAgICBydW50aW1lQ29tcGF0aWJsZTogdHJ1ZSxcclxuICAgIGZvbnRBc3NldHM6IFtdLFxyXG59O1xyXG5cclxuZnVuY3Rpb24gaWdub3JlZEhpZGRlbkZyYW1lKGVudHJ5OiBGcmFtZUVkaXRvckl0ZW0pOiBib29sZWFuIHtcclxuICAgIHJldHVybiBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgPT09IGZhbHNlICYmIGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZVswXT8udmlzaWJsZSA9PT0gZmFsc2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGF2YWlsYWJsZUZyYW1lcygpOiBGcmFtZUVkaXRvckl0ZW1bXSB7IHJldHVybiBiYXRjaEl0ZW1zLmZpbHRlcigoZW50cnkpID0+ICFpZ25vcmVkSGlkZGVuRnJhbWUoZW50cnkpKTsgfVxyXG5cclxuZnVuY3Rpb24gc2VsZWN0ZWRGcmFtZXMoKTogRnJhbWVFZGl0b3JJdGVtW10geyByZXR1cm4gYXZhaWxhYmxlRnJhbWVzKCkuZmlsdGVyKCh7IGl0ZW0gfSkgPT4gaXRlbS5lbmFibGVkKTsgfVxyXG5cclxuZnVuY3Rpb24gZWRpdG9yU25hcHNob3QoKTogRnJhbWVFZGl0b3JTdGF0ZSB7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGRvY3VtZW50OiBzdGF0ZS5kb2N1bWVudCxcclxuICAgICAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKHN0YXRlLnByZWZlcnJlZEFjdGlvbnMpLCBhY3Rpb25zOiBuZXcgTWFwKHN0YXRlLmFjdGlvbnMpLFxyXG4gICAgICAgIGtpbmRzOiBuZXcgTWFwKHN0YXRlLmtpbmRzKSwgcGF0Y2hlczogbmV3IFNldChzdGF0ZS5wYXRjaGVzKSwgZXhwbGljaXRJZHM6IG5ldyBTZXQoc3RhdGUuZXhwbGljaXRJZHMpLFxyXG4gICAgICAgIG5hbWVzOiBuZXcgTWFwKHN0YXRlLm5hbWVzKSwgcmVuYW1lZElkczogbmV3IFNldChzdGF0ZS5yZW5hbWVkSWRzKSwgZGVmYXVsdHM6IG5ldyBNYXAoc3RhdGUuZGVmYXVsdHMpLFxyXG4gICAgICAgIGNvbGxhcHNlZDogbmV3IFNldChzdGF0ZS5jb2xsYXBzZWQpLCBzdXBwcmVzc2VkOiBuZXcgU2V0KHN0YXRlLnN1cHByZXNzZWQpLFxyXG4gICAgICAgIHNlbGVjdGVkSWQ6IHN0YXRlLnNlbGVjdGVkSWQsIHNlYXJjaDogc3RhdGUuc2VhcmNoLCB0cmVlU2Nyb2xsOiBlbGVtZW50KCcjdHJlZScpLnNjcm9sbFRvcCxcclxuICAgICAgICBwcmVzZXQ6IEFycmF5LmZyb20ocm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykpLmZpbmQoKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5jb250YWlucygnYWN0aXZlJykpPy5kYXRhc2V0LnByZXNldCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXRpYWxGcmFtZUVkaXRvcihkb2N1bWVudDogRG9jdW1lbnREdG8pOiBGcmFtZUVkaXRvclN0YXRlIHtcclxuICAgIGNvbnN0IGVkaXRvcjogRnJhbWVFZGl0b3JTdGF0ZSA9IHtcclxuICAgICAgICBkb2N1bWVudCwgcHJlZmVycmVkQWN0aW9uczogbmV3IE1hcCgpLCBhY3Rpb25zOiBuZXcgTWFwKCksIGtpbmRzOiBuZXcgTWFwKCksXHJcbiAgICAgICAgcGF0Y2hlczogZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKSwgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSwgbmFtZXM6IG5ldyBNYXAoKSwgcmVuYW1lZElkczogbmV3IFNldCgpLFxyXG4gICAgICAgIGRlZmF1bHRzOiBuZXcgTWFwKCksIGNvbGxhcHNlZDogbmV3IFNldCgpLCBzdXBwcmVzc2VkOiBuZXcgU2V0KCksIHNlbGVjdGVkSWQ6IGRvY3VtZW50LnRyZWVbMF0/LmlkLFxyXG4gICAgICAgIHNlYXJjaDogJycsIHRyZWVTY3JvbGw6IDAsIHByZXNldDogJ3NtYXJ0JyxcclxuICAgIH07XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZmxhdHRlbihkb2N1bWVudC50cmVlKSkge1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKTtcclxuICAgICAgICBlZGl0b3IucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgYWN0aW9uKTsgZWRpdG9yLmtpbmRzLnNldChub2RlLmlkLCBub2RlLmtpbmQpO1xyXG4gICAgICAgIGVkaXRvci5kZWZhdWx0cy5zZXQobm9kZS5pZCwgeyBhY3Rpb24sIGtpbmQ6IG5vZGUua2luZCB9KTsgZWRpdG9yLm5hbWVzLnNldChub2RlLmlkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBvdmVycmlkZSBvZiBkb2N1bWVudC5ub2RlT3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKG92ZXJyaWRlLmlkLCBkb2N1bWVudC50cmVlKTsgaWYgKCFub2RlKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAobmFtZSAmJiBuYW1lICE9PSBub2RlLm5hbWUpIHsgZWRpdG9yLm5hbWVzLnNldChub2RlLmlkLCBuYW1lKTsgZWRpdG9yLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpOyB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0KSB7XHJcbiAgICAgICAgICAgIGVkaXRvci5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBzYWZlQWN0aW9uKG5vZGUsIG92ZXJyaWRlLmFjdGlvbikpOyBlZGl0b3Iua2luZHMuc2V0KG5vZGUuaWQsIG92ZXJyaWRlLmtpbmQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkgZWRpdG9yLnBhdGNoZXMuYWRkKG5vZGUuaWQpOyBlbHNlIGVkaXRvci5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgZWRpdG9yLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTsgZWRpdG9yLnByZXNldCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBlZmZlY3RpdmUgPSByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyhkb2N1bWVudC50cmVlLCBlZGl0b3IucHJlZmVycmVkQWN0aW9ucywgZWRpdG9yLnBhdGNoZXMsIGVkaXRvci5leHBsaWNpdElkcywgZWRpdG9yLnJlbmFtZWRJZHMsXHJcbiAgICAgICAgc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSk7XHJcbiAgICBlZGl0b3IuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zOyBlZGl0b3Iuc3VwcHJlc3NlZCA9IGVmZmVjdGl2ZS5zdXBwcmVzc2VkO1xyXG4gICAgcmV0dXJuIGVkaXRvcjtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtZW1iZXJBY3RpdmVGcmFtZSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgaWYgKGFjdGl2ZSkgYWN0aXZlLmVkaXRvciA9IGVkaXRvclNuYXBzaG90KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZyYW1lTmFtZShlbnRyeTogRnJhbWVFZGl0b3JJdGVtKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IGVkaXRvciA9IGVudHJ5Lml0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQgPyBzdGF0ZSA6IGVudHJ5LmVkaXRvcjtcclxuICAgIHJldHVybiBlZGl0b3I/Lm5hbWVzLmdldChlbnRyeS5pdGVtLnJvb3RJZCkgPz8gZW50cnkuaXRlbS5kb2N1bWVudC5ub2RlT3ZlcnJpZGVzPy5maW5kKChvdmVycmlkZSkgPT4gb3ZlcnJpZGUuaWQgPT09IGVudHJ5Lml0ZW0ucm9vdElkKT8ubmFtZSA/PyBlbnRyeS5pdGVtLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQ29uZmxpY3RzKCk6IFNldDxzdHJpbmc+IHtcclxuICAgIGNvbnN0IG5hbWVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBzZWxlY3RlZEZyYW1lcygpKSB7XHJcbiAgICAgICAgY29uc3Qga2V5ID0gc2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKGVudHJ5KSkudG9Mb2NhbGVMb3dlckNhc2UoKTtcclxuICAgICAgICBuYW1lcy5zZXQoa2V5LCBbLi4uKG5hbWVzLmdldChrZXkpID8/IFtdKSwgZW50cnkuaXRlbS5pZF0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5ldyBTZXQoQXJyYXkuZnJvbShuYW1lcy52YWx1ZXMoKSkuZmlsdGVyKChpZHMpID0+IGlkcy5sZW5ndGggPiAxKS5mbGF0KCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaENvbnRleHQoKTogQmF0Y2hXb3JrZmxvd0NvbnRleHQgfCB1bmRlZmluZWQge1xyXG4gICAgaWYgKCFiYXRjaEl0ZW1zLmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIGxldCBub2RlcyA9IDA7XHJcbiAgICBsZXQgc2VsZWN0ZWROb2RlcyA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNlbGVjdGVkRnJhbWVzKCkpIHtcclxuICAgICAgICBjb25zdCBlZGl0b3IgPSBlbnRyeS5pdGVtLmlkID09PSBhY3RpdmVCYXRjaElkID8gc3RhdGUgOiBlbnRyeS5lZGl0b3I7XHJcbiAgICAgICAgY29uc3QgYWxsID0gZmxhdHRlbihlbnRyeS5pdGVtLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIG5vZGVzICs9IGFsbC5sZW5ndGg7XHJcbiAgICAgICAgc2VsZWN0ZWROb2RlcyArPSBhbGwuZmlsdGVyKChub2RlKSA9PiAoZWRpdG9yPy5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbikgIT09ICdpZ25vcmUnKS5sZW5ndGg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIGNvdW50OiBzZWxlY3RlZEZyYW1lcygpLmxlbmd0aCwgdG90YWw6IGF2YWlsYWJsZUZyYW1lcygpLmxlbmd0aCwgbm9kZXMsIHNlbGVjdGVkTm9kZXMsXHJcbiAgICAgICAgY29uZmxpY3RzOiBiYXRjaENvbmZsaWN0cygpLnNpemUgPiAwLFxyXG4gICAgICAgIC4uLihiYXRjaFJlc3VsdCA/IHsgcmVzdWx0OiB7XHJcbiAgICAgICAgICAgIHN1Y2Nlc3M6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJykubGVuZ3RoLFxyXG4gICAgICAgICAgICBmYWlsZWQ6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGgsXHJcbiAgICAgICAgICAgIHBlbmRpbmc6IGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdwZW5kaW5nJykubGVuZ3RoLFxyXG4gICAgICAgICAgICBzdG9wcGVkOiBiYXRjaFJlc3VsdC5zdG9wcGVkLFxyXG4gICAgICAgIH0gfSA6IHt9KSxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoRm9udHMoKTogc3RyaW5nW10ge1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSByZXR1cm4gQXJyYXkuZnJvbShuZXcgU2V0KHNlbGVjdGVkRnJhbWVzKCkuZmxhdE1hcCgoeyBpdGVtIH0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udHMpKSk7XHJcbiAgICBpZiAoc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzID09PSBmYWxzZSAmJiBzdGF0ZS5kb2N1bWVudD8udHJlZS5ldmVyeSgobm9kZSkgPT4gbm9kZS52aXNpYmxlID09PSBmYWxzZSkpIHJldHVybiBbXTtcclxuICAgIHJldHVybiBzdGF0ZS5kb2N1bWVudD8uZm9udHMgPz8gW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN5bmNCYXRjaEl0ZW1zKHByZWNlZGluZ1ByZXZpZXc6IFByb21pc2U8dW5rbm93bj4gPSBwcmV2aWV3UmVhZFRhc2spOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGl0ZW1zID0gYmF0Y2hJdGVtcy5tYXAoKHsgaXRlbSB9KSA9PiAoeyBpZDogaXRlbS5pZCwgZW5hYmxlZDogaXRlbS5lbmFibGVkIH0pKTtcclxuICAgIGJhdGNoU3luY1Rhc2sgPSBiYXRjaFN5bmNUYXNrLmNhdGNoKCgpID0+IHVuZGVmaW5lZCkudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgcHJlY2VkaW5nUHJldmlldy5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gICAgICAgIGF3YWl0IHJlcXVlc3QoJ3N5bmMtYmF0Y2gtaXRlbXMnLCBpdGVtcyk7XHJcbiAgICAgICAgYmF0Y2hTeW5jRXJyb3IgPSB1bmRlZmluZWQ7XHJcbiAgICB9KS5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICBiYXRjaFN5bmNFcnJvciA9IGVycm9yO1xyXG4gICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfnlYzpnaLliJfooajkv53lrZjlpLHotKXvvIzor7fph43or5XjgIInKSwgdHJ1ZSk7XHJcbiAgICB9KTtcclxuICAgIHJldHVybiBiYXRjaFN5bmNUYXNrO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yQmF0Y2hMaXN0UmVhZHkoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAvLyBTbmFwc2hvdCBib3RoIGRlcGVuZGVuY2llcyBiZWZvcmUgd2FpdGluZy4gTGF0ZXIgcHJldmlld3MgbWF5IHRoZW1zZWx2ZXNcclxuICAgIC8vIHdhaXQgZm9yIGEgbmV3bHkgcXVldWVkIHN5bmMsIHNvIG5ldmVyIG1ha2UgdGhhdCBzeW5jIGRlcGVuZCBvbiB0aGVtLlxyXG4gICAgY29uc3QgcHJlY2VkaW5nU3luYyA9IGJhdGNoU3luY1Rhc2s7XHJcbiAgICBjb25zdCBwcmVjZWRpbmdQcmV2aWV3ID0gcHJldmlld1JlYWRUYXNrO1xyXG4gICAgYXdhaXQgcHJlY2VkaW5nU3luYztcclxuICAgIGF3YWl0IHByZWNlZGluZ1ByZXZpZXcuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIGlmIChiYXRjaFN5bmNFcnJvcikge1xyXG4gICAgICAgIGNvbnN0IHByZXZpb3VzTWVzc2FnZSA9IGVycm9yTWVzc2FnZShiYXRjaFN5bmNFcnJvciwgJ+eVjOmdouWIl+ihqOS/neWtmOWksei0pe+8jOivt+mHjeivleOAgicpO1xyXG4gICAgICAgIC8vIEEgZmFpbGVkIHNhdmUgbGVhdmVzIHRoZSBvcHRpbWlzdGljIGxpc3QgdW5jb25maXJtZWQuIFJldHJ5IGl0cyBsYXRlc3RcclxuICAgICAgICAvLyBjb250ZW50cyBvbmNlOyBvbmx5IGEgc3VjY2Vzc2Z1bCBiYWNrZW5kIGFja25vd2xlZGdlbWVudCBjbGVhcnMgaXQuXHJcbiAgICAgICAgYXdhaXQgc3luY0JhdGNoSXRlbXMocHJlY2VkaW5nUHJldmlldyk7XHJcbiAgICAgICAgaWYgKGJhdGNoU3luY0Vycm9yKSB0aHJvdyBiYXRjaFN5bmNFcnJvcjtcclxuICAgICAgICBpZiAoZWxlbWVudCgnI3dvcmtmbG93LWVycm9yLW1lc3NhZ2UnKS50ZXh0Q29udGVudCA9PT0gcHJldmlvdXNNZXNzYWdlKSB3b3JrZmxvdz8uY2xlYXJFcnJvcigpO1xyXG4gICAgICAgIGlmIChlbGVtZW50KCcjdG9hc3QnKS50ZXh0Q29udGVudCA9PT0gcHJldmlvdXNNZXNzYWdlKSBzaG93VG9hc3QoJ+eVjOmdouWIl+ihqOW3suWQjOatpe+8jOWPr+S7pee7p+e7reOAgicpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaEVsZW1lbnQ8SyBleHRlbmRzIGtleW9mIEhUTUxFbGVtZW50VGFnTmFtZU1hcD4odGFnOiBLLCB0ZXh0ID0gJycsIGNsYXNzTmFtZSA9ICcnKTogSFRNTEVsZW1lbnRUYWdOYW1lTWFwW0tdIHtcclxuICAgIGNvbnN0IHZhbHVlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xyXG4gICAgdmFsdWUudGV4dENvbnRlbnQgPSB0ZXh0O1xyXG4gICAgdmFsdWUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgcmV0dXJuIHZhbHVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaEJ1dHRvbih0ZXh0OiBzdHJpbmcsIGFjdGlvbjogKCkgPT4gdm9pZCwgY2xhc3NOYW1lID0gJ3RleHQtYnV0dG9uJyk6IEhUTUxCdXR0b25FbGVtZW50IHtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGJhdGNoRWxlbWVudCgnYnV0dG9uJywgdGV4dCwgY2xhc3NOYW1lKTtcclxuICAgIGJ1dHRvbi50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBidXR0b24uZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgYnV0dG9uLm9uY2xpY2sgPSBhY3Rpb247XHJcbiAgICByZXR1cm4gYnV0dG9uO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJCYXRjaCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGVuYWJsZWQgPSBiYXRjaEl0ZW1zLmxlbmd0aCA+IDA7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtc291cmNlLXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWZyYW1lLXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXRhcmdldC1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQgfHwgKCFiYXRjaFJlc3VsdCAmJiAhYmF0Y2hQcm9ncmVzcyk7XHJcbiAgICBjb25zdCBnZW5lcmljUmV2aWV3ID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcucmVzdWx0LXJldmlldycpO1xyXG4gICAgaWYgKGdlbmVyaWNSZXZpZXcpIGdlbmVyaWNSZXZpZXcuaGlkZGVuID0gZW5hYmxlZDtcclxuICAgIGVsZW1lbnQoJyNwcmVzZXQtc2NvcGUnKS50ZXh0Q29udGVudCA9IGVuYWJsZWQgPyAn5LuF5L2c55So5LqO5b2T5YmN55WM6Z2iJyA6ICfkvZznlKjkuo7lhajpg6joioLngrknO1xyXG4gICAgY29uc3QgYXZhaWxhYmxlID0gYXZhaWxhYmxlRnJhbWVzKCk7XHJcbiAgICBjb25zdCBoaWRkZW5Db3VudCA9IGJhdGNoSXRlbXMubGVuZ3RoIC0gYXZhaWxhYmxlLmxlbmd0aDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1zZWxlY3RlZC1jb3VudCcpLnRleHRDb250ZW50ID0gYOW3sumAiSAke3NlbGVjdGVkRnJhbWVzKCkubGVuZ3RofSAvICR7YXZhaWxhYmxlLmxlbmd0aH1gXHJcbiAgICAgICAgKyAoaGlkZGVuQ291bnQgPyBgIMK3ICR7aGlkZGVuQ291bnR9IOS4qumakOiXj+eVjOmdouacrOasoeW/veeVpWAgOiAnJyk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXRvZ2dsZS1hbGwnKS50ZXh0Q29udGVudCA9IGF2YWlsYWJsZS5sZW5ndGggJiYgc2VsZWN0ZWRGcmFtZXMoKS5sZW5ndGggPT09IGF2YWlsYWJsZS5sZW5ndGggPyAn5Y+W5raI5YWo6YCJJyA6ICflhajpgIknO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNiYXRjaC10b2dnbGUtYWxsJykuZGlzYWJsZWQgPSBzdGF0ZS5idXN5IHx8IGF2YWlsYWJsZS5sZW5ndGggPT09IDA7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2JhdGNoLXNvdXJjZS1saXN0Jyk7XHJcbiAgICBjb25zdCB0YWJzID0gZWxlbWVudCgnI2JhdGNoLWZyYW1lLXRhYnMnKTtcclxuICAgIGNvbnN0IHRhcmdldHMgPSBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7IHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7IHRhcmdldHMucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBjb25mbGljdHMgPSBiYXRjaENvbmZsaWN0cygpO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaEl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgeyBpdGVtIH0gPSBlbnRyeTtcclxuICAgICAgICBjb25zdCBoaWRkZW5JZ25vcmVkID0gaWdub3JlZEhpZGRlbkZyYW1lKGVudHJ5KTtcclxuICAgICAgICBjb25zdCByb3cgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCBgYmF0Y2gtaXRlbSR7aXRlbS5lbmFibGVkICYmICFoaWRkZW5JZ25vcmVkID8gJycgOiAnIGlzLWRpc2FibGVkJ31gKTtcclxuICAgICAgICBjb25zdCBjaGVja2VkID0gYmF0Y2hFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgICAgIGNoZWNrZWQudHlwZSA9ICdjaGVja2JveCc7IGNoZWNrZWQuY2hlY2tlZCA9IGl0ZW0uZW5hYmxlZCAmJiAhaGlkZGVuSWdub3JlZDsgY2hlY2tlZC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3kgfHwgaGlkZGVuSWdub3JlZDtcclxuICAgICAgICBjaGVja2VkLmRhdGFzZXQuYmF0Y2hDaGVja2VkID0gaXRlbS5pZDtcclxuICAgICAgICBjaGVja2VkLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGDlr7zlhaUgJHtmcmFtZU5hbWUoZW50cnkpfWApO1xyXG4gICAgICAgIGNoZWNrZWQub25jaGFuZ2UgPSAoKSA9PiB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5idXN5IHx8IGhpZGRlbklnbm9yZWQpIHJldHVybjtcclxuICAgICAgICAgICAgaXRlbS5lbmFibGVkID0gY2hlY2tlZC5jaGVja2VkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICByZW5kZXJCYXRjaCgpOyByZW5kZXJGb250TWFwKCk7IHdvcmtmbG93Py5yZW5kZXIoKTtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZUJhdGNoSWQgPT09IGl0ZW0uaWQgJiYgIWl0ZW0uZW5hYmxlZCAmJiBzZWxlY3RlZEZyYW1lcygpLmxlbmd0aCkgdm9pZCBhY3RpdmF0ZUZyYW1lKHNlbGVjdGVkRnJhbWVzKClbMF0uaXRlbS5pZCk7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCBjb3B5ID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tY29weScpO1xyXG4gICAgICAgIGNvbnN0IHRpdGxlID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tdGl0bGUnKTtcclxuICAgICAgICB0aXRsZS5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzcGFuJywgZnJhbWVOYW1lKGVudHJ5KSksIGJhdGNoRWxlbWVudCgnc3BhbicsIGVudHJ5LmNvbmZpZ3VyZWQgPyAn5bey6YWN572uJyA6ICfmmbrog73pu5jorqQnLCBgYmFkZ2Uke2VudHJ5LmNvbmZpZ3VyZWQgPyAnJyA6ICcgc3VidGxlJ31gKSk7XHJcbiAgICAgICAgaWYgKGhpZGRlbklnbm9yZWQpIHRpdGxlLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCAn6ZqQ6JePIMK3IOacrOasoeW/veeVpScsICdiYWRnZSBzdWJ0bGUnKSk7XHJcbiAgICAgICAgaWYgKGNvbmZsaWN0cy5oYXMoaXRlbS5pZCkpIHRpdGxlLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCAn5ZCN56ew5Yay56qBJywgJ2JhdGNoLXN0YXR1cy1mYWlsZWQnKSk7XHJcbiAgICAgICAgY29weS5hcHBlbmQodGl0bGUsIGJhdGNoRWxlbWVudCgnZGl2JywgYCR7aXRlbS5zZWN0aW9uTmFtZSA/IGAke2l0ZW0uc2VjdGlvbk5hbWV9IC8gYCA6ICcnfSR7aXRlbS5kb2N1bWVudC5maWxlTmFtZX0gwrcgJHtmbGF0dGVuKGl0ZW0uZG9jdW1lbnQudHJlZSkubGVuZ3RofSDoioLngrlgLCAnYmF0Y2gtaXRlbS1tZXRhJykpO1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbnMgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1hY3Rpb25zJyk7XHJcbiAgICAgICAgY29uc3QgY29uZmlndXJlID0gYmF0Y2hCdXR0b24oaGlkZGVuSWdub3JlZCA/ICflhYHorrjlr7zlhaXpmpDol4/lm77lsYInIDogJ+iwg+aVtOiKgueCuScsICgpID0+IHtcclxuICAgICAgICAgICAgaWYgKGhpZGRlbklnbm9yZWQpIHsgdm9pZCBzZXRJbXBvcnRIaWRkZW5MYXllcnModHJ1ZSk7IHJldHVybjsgfVxyXG4gICAgICAgICAgICBpZiAoIWl0ZW0uZW5hYmxlZCkgeyBpdGVtLmVuYWJsZWQgPSB0cnVlOyBzeW5jQmF0Y2hJdGVtcygpOyB9XHJcbiAgICAgICAgICAgIHZvaWQgYWN0aXZhdGVGcmFtZShpdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoaGlkZGVuSWdub3JlZCkgY29uZmlndXJlLnRpdGxlID0gJ+S7heS/ruaUueWvvOWFpemAiemhue+8jOS4jeaUueWPmCBGaWdtYSDlm77lsYLnmoTmmL7pmpDvvJvlt7LmnIkgUHJlZmFiIOS4jeS8muWIoOmZpCc7XHJcbiAgICAgICAgY29uZmlndXJlLmRhdGFzZXQuYmF0Y2hDb25maWd1cmUgPSBpdGVtLmlkO1xyXG4gICAgICAgIGNvbnN0IHJlbW92ZSA9IGJhdGNoQnV0dG9uKCfDlycsICgpID0+IHtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICAgICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgICAgICAgICBiYXRjaEl0ZW1zID0gYmF0Y2hJdGVtcy5maWx0ZXIoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLml0ZW0uaWQgIT09IGl0ZW0uaWQpO1xyXG4gICAgICAgICAgICBsZXQgbmV4dElkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkKSB7XHJcbiAgICAgICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSBuZXh0SWQgPSBzZWxlY3RlZEZyYW1lcygpWzBdLml0ZW0uaWQ7XHJcbiAgICAgICAgICAgICAgICBlbHNlIGlmIChiYXRjaEl0ZW1zLmxlbmd0aCkgbmV4dElkID0gYmF0Y2hJdGVtc1swXS5pdGVtLmlkO1xyXG4gICAgICAgICAgICAgICAgZWxzZSB7IHN0YXRlLmRvY3VtZW50ID0gbnVsbDsgcmVuZGVyVHJlZSgpOyB3b3JrZmxvdz8uYmF0Y2hSZWFkeSgpOyB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTtcclxuICAgICAgICAgICAgaWYgKG5leHRJZCkgdm9pZCBhY3RpdmF0ZUZyYW1lKG5leHRJZCk7XHJcbiAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgICAgIH0sICdpY29uLWJ1dHRvbicpO1xyXG4gICAgICAgIHJlbW92ZS5kYXRhc2V0LmJhdGNoUmVtb3ZlID0gaXRlbS5pZDsgcmVtb3ZlLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGDnp7vpmaQgJHtmcmFtZU5hbWUoZW50cnkpfWApO1xyXG4gICAgICAgIGFjdGlvbnMuYXBwZW5kKGNvbmZpZ3VyZSwgcmVtb3ZlKTsgcm93LmFwcGVuZChjaGVja2VkLCBjb3B5LCBhY3Rpb25zKTsgbGlzdC5hcHBlbmQocm93KTtcclxuICAgICAgICBpZiAoIWl0ZW0uZW5hYmxlZCB8fCBoaWRkZW5JZ25vcmVkKSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCB0YWIgPSBiYXRjaEJ1dHRvbignJywgKCkgPT4geyB2b2lkIGFjdGl2YXRlRnJhbWUoaXRlbS5pZCk7IH0sICdiYXRjaC1mcmFtZS10YWInKTtcclxuICAgICAgICB0YWIuZGF0YXNldC5iYXRjaEZyYW1lID0gaXRlbS5pZDsgdGFiLnNldEF0dHJpYnV0ZSgncm9sZScsICd0YWInKTsgdGFiLnNldEF0dHJpYnV0ZSgnYXJpYS1zZWxlY3RlZCcsIFN0cmluZyhhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkKSk7XHJcbiAgICAgICAgdGFiLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3N0cm9uZycsIGZyYW1lTmFtZShlbnRyeSkpLCBiYXRjaEVsZW1lbnQoJ3NtYWxsJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4gwrcg6Ieq5Yqo5L+d55WZJyA6ICfmmbrog73pu5jorqQnKSk7XHJcbiAgICAgICAgdGFicy5hcHBlbmQodGFiKTtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBiYXRjaEVsZW1lbnQoJ2xhYmVsJywgJycsIGBiYXRjaC10YXJnZXQtcm93JHtjb25mbGljdHMuaGFzKGl0ZW0uaWQpID8gJyBpcy1jb25mbGljdCcgOiAnJ31gKTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsIGl0ZW0ubmFtZSkpO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSBiYXRjaEVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICAgICAgbmFtZS50eXBlID0gJ3RleHQnOyBuYW1lLnZhbHVlID0gZnJhbWVOYW1lKGVudHJ5KTsgbmFtZS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7IG5hbWUuZGF0YXNldC5iYXRjaE5hbWUgPSBpdGVtLmlkO1xyXG4gICAgICAgIG5hbWUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7aXRlbS5uYW1lfSDnmoQgUHJlZmFiIOWQjeensGApO1xyXG4gICAgICAgIG5hbWUudGl0bGUgPSBgYXNzZXRzLyR7ZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZX0vJHtzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUoZW50cnkpKX0ucHJlZmFiYDtcclxuICAgICAgICBuYW1lLm9uY2hhbmdlID0gKCkgPT4geyB2b2lkIHJlbmFtZUZyYW1lKGVudHJ5LCBuYW1lLnZhbHVlKTsgfTtcclxuICAgICAgICB0YXJnZXQuYXBwZW5kKG5hbWUpOyB0YXJnZXRzLmFwcGVuZCh0YXJnZXQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtYWN0aXZlLW5hbWUnKS50ZXh0Q29udGVudCA9IGFjdGl2ZSA/IGDmraPlnKjosIPmlbTvvJoke2ZyYW1lTmFtZShhY3RpdmUpfWAgOiAn6YCJ5oup5LiA5Liq55WM6Z2i5byA5aeL6LCD5pW0JztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1hY3RpdmUtc3RhdHVzJykudGV4dENvbnRlbnQgPSBhY3RpdmUgJiYgaWdub3JlZEhpZGRlbkZyYW1lKGFjdGl2ZSkgPyAn6ZqQ6JePIMK3IOacrOasoeW/veeVpSdcclxuICAgICAgICA6IGFjdGl2ZT8uY29uZmlndXJlZCA/ICfkv67mlLnlt7Lkv53nlZknIDogJ+ayv+eUqOaZuuiDvem7mOiupCc7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtY29uZmxpY3RzJykuaGlkZGVuID0gY29uZmxpY3RzLnNpemUgPT09IDA7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtY29uZmxpY3RzJykudGV4dENvbnRlbnQgPSBg5pyJICR7Y29uZmxpY3RzLnNpemV9IOS4queVjOmdoueahCBQcmVmYWIg5paH5Lu25ZCN6YeN5aSN77yI5b+955Wl5aSn5bCP5YaZ77yJ44CC6K+35pS55ZCN5ZCO5byA5aeL5a+85YWl44CCYDtcclxuICAgIHJlbmRlckJhdGNoUmVzdWx0cygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJCYXRjaFJlc3VsdHMoKTogdm9pZCB7XHJcbiAgICBjb25zdCByb3dzID0gYmF0Y2hQcm9ncmVzcz8uaXRlbXMgPz8gYmF0Y2hSZXN1bHQ/Lml0ZW1zID8/IFtdO1xyXG4gICAgY29uc3QgbGlzdCA9IGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtbGlzdCcpOyBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHJvd3MpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbScpO1xyXG4gICAgICAgIGNvbnN0IGNvcHkgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1jb3B5Jyk7XHJcbiAgICAgICAgY29weS5hcHBlbmQoYmF0Y2hFbGVtZW50KCdkaXYnLCBpdGVtLm5hbWUsICdiYXRjaC1pdGVtLXRpdGxlJyksIGJhdGNoRWxlbWVudCgnZGl2JywgaXRlbS5lcnJvciA/PyBpdGVtLnByZWZhYlVybCA/PyBpdGVtLndhcm5pbmdzPy5qb2luKCfvvJsnKSA/PyAoaXRlbS5zdGF0dXMgPT09ICdwZW5kaW5nJyA/ICfnrYnlvoXnu6fnu63lr7zlhaUnIDogJycpLCAnYmF0Y2gtaXRlbS1tZXRhJykpO1xyXG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IHsgcGVuZGluZzogJ+acquWujOaIkCcsIHJ1bm5pbmc6ICfmraPlnKjlr7zlhaUnLCBzdWNjZXNzOiAn5bey5a6M5oiQJywgZmFpbGVkOiAn5aSx6LSlJyB9W2l0ZW0uc3RhdHVzXTtcclxuICAgICAgICBjb25zdCBhY3Rpb25zID0gYmF0Y2hFbGVtZW50KCdkaXYnLCAnJywgJ2JhdGNoLWl0ZW0tYWN0aW9ucycpO1xyXG4gICAgICAgIGFjdGlvbnMuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsIHN0YXR1cywgYGJhdGNoLXN0YXR1cy0ke2l0ZW0uc3RhdHVzfWApKTtcclxuICAgICAgICBpZiAoaXRlbS5yZXZpZXdJZCB8fCBpdGVtLnJldmlldykge1xyXG4gICAgICAgICAgICBjb25zdCByZXZpZXcgPSBiYXRjaEJ1dHRvbign5qOA5p+l57uT5p6cJywgKCkgPT4geyB2b2lkIG9wZW5CYXRjaFJldmlldyhpdGVtKTsgfSk7XHJcbiAgICAgICAgICAgIHJldmlldy5kYXRhc2V0LmJhdGNoUmV2aWV3ID0gaXRlbS5pZDsgYWN0aW9ucy5hcHBlbmQocmV2aWV3KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcm93LmFwcGVuZChjb3B5LCBhY3Rpb25zKTsgbGlzdC5hcHBlbmQocm93KTtcclxuICAgIH1cclxuICAgIGNvbnN0IHN1Y2Nlc3MgPSByb3dzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJykubGVuZ3RoO1xyXG4gICAgY29uc3QgZmFpbGVkID0gcm93cy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoO1xyXG4gICAgY29uc3QgcGVuZGluZyA9IHJvd3MuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3BlbmRpbmcnKS5sZW5ndGg7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LWNvdW50JykudGV4dENvbnRlbnQgPSBgJHtzdWNjZXNzfSAvICR7cm93cy5sZW5ndGh9IOW3suWujOaIkGA7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXJldHJ5LWZhaWxlZCcpLmhpZGRlbiA9ICFmYWlsZWQgfHwgc3RhdGUuYnVzeTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYmF0Y2gtcmVzdW1lLXBlbmRpbmcnKS5oaWRkZW4gPSAhcGVuZGluZyB8fCBzdGF0ZS5idXN5O1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1ub3RlJykudGV4dENvbnRlbnQgPSByb3dzLnNvbWUoKGl0ZW0pID0+IGl0ZW0ucmVxdWlyZXNBdHRlbnRpb24pXHJcbiAgICAgICAgPyAn6YOo5YiG6aG555qE5L+d5a2Y54q25oCB6ZyA6KaB5qOA5p+l44CC6K+35YWI5ZyoIENvY29zIOehruiupOW9k+WJjeebruagh+S4juS/neWtmOeKtuaAge+8jOWGjemHjeivleaIlue7p+e7reOAgidcclxuICAgICAgICA6ICfngrnlh7vmr4/kuIDpobnnmoTigJzmo4Dmn6Xnu5PmnpzigJ3mn6XnnIvlr7nlupTmiqXlkYrvvJvph43or5Xlkoznu6fnu63kvJrot7Pov4flt7LlrozmiJDpobnjgIInO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBvcGVuQmF0Y2hSZXZpZXcoaXRlbTogQmF0Y2hJbXBvcnRJdGVtUmVzdWx0KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXZpZXdJZCA9IGl0ZW0ucmV2aWV3SWQgPz8gaXRlbS5yZXZpZXc/LmlkO1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHJldmlld0lkID8gYXdhaXQgcmVxdWVzdDxJbXBvcnRSZXZpZXcgfCBudWxsPignZ2V0LWltcG9ydC1yZXZpZXcnLCByZXZpZXdJZCkgOiBudWxsO1xyXG4gICAgICAgIGlmICghcmV2aWV3KSB0aHJvdyBuZXcgRXJyb3IoJ+ivpemhueajgOafpeaKpeWRiuW3sui/h+acn++8jOivt+mHjeaWsOWvvOWFpeWQjuafpeeci+OAgicpO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5qOA5p+l57uT5p6c5aSx6LSl44CCJyksIHRydWUpOyB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGFjdGl2YXRlRnJhbWUoaWQ6IHN0cmluZywgbmF2aWdhdGUgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIGNvbnN0IGVudHJ5ID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gaWQpO1xyXG4gICAgaWYgKCFlbnRyeSkgcmV0dXJuO1xyXG4gICAgY29uc3QgYWxyZWFkeUFjdGl2ZSA9IGFjdGl2ZUJhdGNoSWQgPT09IGlkICYmIHN0YXRlLmRvY3VtZW50O1xyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3Qgb2xkSWQgPSBhY3RpdmVCYXRjaElkO1xyXG4gICAgY29uc3Qgb2xkRWRpdG9yID0gZWRpdG9yU25hcHNob3QoKTtcclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTsgaWYgKHNldHRpbmdzKSBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgcHJldmlld1JldmlzaW9uKys7XHJcbiAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yQmF0Y2hMaXN0UmVhZHkoKTtcclxuICAgICAgICBjb25zdCBsb2FkZWQgPSBhbHJlYWR5QWN0aXZlID8gc3RhdGUuZG9jdW1lbnQgOiBhd2FpdCByZXF1ZXN0PERvY3VtZW50RHRvPignYWN0aXZhdGUtYmF0Y2gtaXRlbScsIGlkKTtcclxuICAgICAgICBpZiAoIWFscmVhZHlBY3RpdmUgJiYgbG9hZGVkPy5mb250QXNzZXRzKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBsb2FkZWQuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgZW50cnkuaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID0gbG9hZGVkLmZvbnRBc3NldHM7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBpZDtcclxuICAgICAgICBpZiAoZW50cnkuZWRpdG9yKSB7IE9iamVjdC5hc3NpZ24oc3RhdGUsIGVudHJ5LmVkaXRvcik7IHJlY29uY2lsZUFjdGlvbnMoKTsgfVxyXG4gICAgICAgIGVsc2UgaW5pdGlhbGl6ZURvY3VtZW50KGxvYWRlZCA/PyBlbnRyeS5pdGVtLmRvY3VtZW50LCBmYWxzZSk7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykudmFsdWUgPSBzdGF0ZS5zZWFyY2g7XHJcbiAgICAgICAgZWxlbWVudCgnI2ZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnQ/LmZpbGVOYW1lID8/ICcnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNwcmV2aWV3LXN0YWdlJykuY2xhc3NMaXN0LnJlbW92ZSgnaGFzLWltYWdlJywgJ2lzLWxvYWRpbmcnKTtcclxuICAgICAgICBlbGVtZW50KCcjcHJldmlldy1pbWFnZScpLnJlbW92ZUF0dHJpYnV0ZSgnc3JjJyk7XHJcbiAgICAgICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gJ+mAieaLqeiKgueCueafpeeci+mihOiniCc7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgIGVsZW1lbnQoJyN0cmVlJykuc2Nyb2xsVG9wID0gZW50cnkuZWRpdG9yPy50cmVlU2Nyb2xsID8/IDA7XHJcbiAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAoZW50cnkuZWRpdG9yPy5wcmVzZXQgPz8gJ3NtYXJ0JykpKTtcclxuICAgICAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBvbGRJZDsgT2JqZWN0LmFzc2lnbihzdGF0ZSwgb2xkRWRpdG9yKTtcclxuICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn5YiH5o2i55WM6Z2i5aSx6LSl77yM6K+36YeN6K+V44CCJyksIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTsgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgIGlmIChuYXZpZ2F0ZSAmJiBhY3RpdmVCYXRjaElkID09PSBpZCkgd29ya2Zsb3c/Lm5hdmlnYXRlKDIpO1xyXG4gICAgICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpZCAmJiB3b3JrZmxvdz8uc3RlcCA9PT0gMiAmJiBzdGF0ZS5zZWxlY3RlZElkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gZmluZE5vZGUoc3RhdGUuc2VsZWN0ZWRJZCk7IGlmIChzZWxlY3RlZCkgdm9pZCBwcmV2aWV3KHNlbGVjdGVkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlbmFtZUZyYW1lKGVudHJ5OiBGcmFtZUVkaXRvckl0ZW0sIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVOb2RlTmFtZSh2YWx1ZSk7XHJcbiAgICBpZiAoIW5hbWUpIHsgc2hvd1RvYXN0KCdQcmVmYWIg5ZCN56ew5LiN6IO95Li656m644CCJywgdHJ1ZSk7IHJlbmRlckJhdGNoKCk7IHJldHVybjsgfVxyXG4gICAgYXdhaXQgYWN0aXZhdGVGcmFtZShlbnRyeS5pdGVtLmlkKTtcclxuICAgIGlmIChhY3RpdmVCYXRjaElkICE9PSBlbnRyeS5pdGVtLmlkKSByZXR1cm47XHJcbiAgICBzdGF0ZS5uYW1lcy5zZXQoZW50cnkuaXRlbS5yb290SWQsIG5hbWUpO1xyXG4gICAgaWYgKG5hbWUgPT09IGVudHJ5Lml0ZW0ubmFtZSkgc3RhdGUucmVuYW1lZElkcy5kZWxldGUoZW50cnkuaXRlbS5yb290SWQpOyBlbHNlIHN0YXRlLnJlbmFtZWRJZHMuYWRkKGVudHJ5Lml0ZW0ucm9vdElkKTtcclxuICAgIGVudHJ5LmNvbmZpZ3VyZWQgPSB0cnVlO1xyXG4gICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTsgcmVtZW1iZXJBY3RpdmVGcmFtZSgpOyByZW5kZXJUcmVlKCk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcm9vdCgpOiBIVE1MRWxlbWVudCB7XHJcbiAgICByZXR1cm4gcGFuZWxIb3N0LiQuYXBwIGFzIEhUTUxFbGVtZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbGVtZW50PFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oc2VsZWN0b3I6IHN0cmluZyk6IFQge1xyXG4gICAgY29uc3QgdmFsdWUgPSByb290KCkucXVlcnlTZWxlY3RvcjxUPihzZWxlY3Rvcik7XHJcbiAgICBpZiAoIXZhbHVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQYW5lbCBlbGVtZW50IG5vdCBmb3VuZDogJHtzZWxlY3Rvcn1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVxdWVzdDxUPihtZXNzYWdlOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8VD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QocGFja2FnZUpTT04ubmFtZSwgbWVzc2FnZSwgLi4uYXJncykgYXMgVDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2hvd1RvYXN0KG1lc3NhZ2U6IHN0cmluZywgZXJyb3IgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdG9hc3QgPSBlbGVtZW50PEhUTUxEaXZFbGVtZW50PignI3RvYXN0Jyk7XHJcbiAgICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcclxuICAgIGNvbnN0IGNyZWRlbnRpYWxEaWFsb2cgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRGlhbG9nRWxlbWVudD4oJyNjcmVkZW50aWFsLWRpYWxvZycpO1xyXG4gICAgY29uc3QgY3JlZGVudGlhbFN0YXR1cyA9IHJvb3QoKS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignI2NyZWRlbnRpYWwtc3RhdHVzJyk7XHJcbiAgICBpZiAoY3JlZGVudGlhbERpYWxvZz8ub3BlbiAmJiBjcmVkZW50aWFsU3RhdHVzKSB7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy5oaWRkZW4gPSBmYWxzZTtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgICAgICBjcmVkZW50aWFsU3RhdHVzLmNsYXNzTGlzdC50b2dnbGUoJ2Vycm9yJywgZXJyb3IpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRvYXN0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7XHJcbiAgICB9XHJcbiAgICB0b2FzdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB0b2FzdC5jbGFzc0xpc3QucmVtb3ZlKCdzaG93JyksIDM0MDApO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24sIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyb3IubWVzc2FnZSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvci5tZXNzYWdlO1xyXG4gICAgfVxyXG4gICAgaWYgKHR5cGVvZiBlcnJvciA9PT0gJ3N0cmluZycgJiYgZXJyb3IudHJpbSgpKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yO1xyXG4gICAgfVxyXG4gICAgaWYgKGVycm9yICYmIHR5cGVvZiBlcnJvciA9PT0gJ29iamVjdCcgJiYgJ21lc3NhZ2UnIGluIGVycm9yXHJcbiAgICAgICAgJiYgdHlwZW9mIChlcnJvciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH0pLm1lc3NhZ2UgPT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgcmV0dXJuIChlcnJvciBhcyB7IG1lc3NhZ2U6IHN0cmluZyB9KS5tZXNzYWdlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbGxiYWNrO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRDb25uZWN0aW9uKHZhdWx0OiB7XHJcbiAgICBoYXNUb2tlbjogYm9vbGVhbjtcclxuICAgIHBlcnNpc3RlbnQ6IGJvb2xlYW47XHJcbiAgICBiYWNrZW5kOiBzdHJpbmc7XHJcbiAgICB3YXJuaW5nPzogc3RyaW5nO1xyXG59KTogdm9pZCB7XHJcbiAgICBjb25zdCBwaWxsID0gZWxlbWVudCgnI2Nvbm5lY3Rpb24tcGlsbCcpO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vbmxpbmUnLCB2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9mZmxpbmUnLCAhdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgZWxlbWVudCgnI2Nvbm5lY3Rpb24tbGFiZWwnKS50ZXh0Q29udGVudCA9IHZhdWx0Lmhhc1Rva2VuID8gJ+WHreaNruWwsee7qicgOiAn5pyq6L+e5o6lJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1iYWRnZScpLnRleHRDb250ZW50ID0gdmF1bHQucGVyc2lzdGVudCA/ICfns7vnu5/liqDlr4YnIDogJ+S8muivneWtmOWCqCc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtbm90ZScpLnRleHRDb250ZW50ID0gdmF1bHQud2FybmluZ1xyXG4gICAgICAgID8/ICh2YXVsdC5wZXJzaXN0ZW50ID8gYOeUsSAke3ZhdWx0LmJhY2tlbmR9IOWKoOWvhu+8jOmhueebruS4reS7heS/neWtmOmdnuaVj+aEn+iuvue9rmAgOiAnVG9rZW4g5LiN5YaZ5YWl6aG555uu5paH5Lu2Jyk7XHJcbiAgICAoZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyN2ZXJpZnktdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbiAgICAoZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjbGVhci10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIHdvcmtmbG93Py5zZXRDb25uZWN0aW9uKHZhdWx0Lmhhc1Rva2VuKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmxhdHRlbihub2RlczogVHJlZU5vZGVEdG9bXSk6IFRyZWVOb2RlRHRvW10ge1xyXG4gICAgcmV0dXJuIG5vZGVzLmZsYXRNYXAoKG5vZGUpID0+IFtub2RlLCAuLi5mbGF0dGVuKG5vZGUuY2hpbGRyZW4pXSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmROb2RlKGlkOiBzdHJpbmcsIG5vZGVzID0gc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10pOiBUcmVlTm9kZUR0byB8IHVuZGVmaW5lZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcclxuICAgICAgICBpZiAobm9kZS5pZCA9PT0gaWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5vZGU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNoaWxkID0gZmluZE5vZGUoaWQsIG5vZGUuY2hpbGRyZW4pO1xyXG4gICAgICAgIGlmIChjaGlsZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gY2hpbGQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyRm9udE1hcCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGxpc3QgPSBlbGVtZW50KCcjZm9udC1tYXAtbGlzdCcpO1xyXG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgIGNvbnN0IGZhbWlsaWVzID0gYmF0Y2hGb250cygpO1xyXG4gICAgaWYgKCFmYW1pbGllcy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOWQju+8jOi/memHjOS8muWIl+WHuuajgOa1i+WIsOeahOWtl+S9k+OAgic7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5mb250QXNzZXRzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5IGlzLXdhcm5pbmcnO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+mhueebriBhc3NldHMg5YaF5rKh5pyJ5qOA5rWL5YiwIC50dGYgLyAub3RmIC8gLmZudCAvIC53b2ZmIOWtl+S9k+i1hOa6kOOAgic7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGZhbWlseSBvZiBmYW1pbGllcykge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtcm93JztcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgc291cmNlLmNsYXNzTmFtZSA9ICdmb250LW1hcC1zb3VyY2UnO1xyXG4gICAgICAgIHNvdXJjZS50ZXh0Q29udGVudCA9IGZhbWlseTtcclxuICAgICAgICBzb3VyY2UudGl0bGUgPSBmYW1pbHk7XHJcbiAgICAgICAgY29uc3QgYXJyb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgYXJyb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWFycm93JztcclxuICAgICAgICBhcnJvdy50ZXh0Q29udGVudCA9ICfihpInO1xyXG4gICAgICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xyXG4gICAgICAgIHNlbGVjdC5jbGFzc05hbWUgPSAnZm9udC1tYXAtc2VsZWN0JztcclxuICAgICAgICBzZWxlY3QuZGF0YXNldC5mb250RmFtaWx5ID0gZmFtaWx5O1xyXG4gICAgICAgIHNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtmYW1pbHl9IOaYoOWwhOWtl+S9k2ApO1xyXG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24oJycsICfkuI3mmKDlsITvvIjkvb/nlKjpu5jorqTlrZfkvZPvvIknKSk7XHJcbiAgICAgICAgY29uc3QgYXV0b21hdGljID0gZmluZEZvbnRBc3NldChmYW1pbHksIHN0YXRlLmZvbnRBc3NldHMpO1xyXG4gICAgICAgIGNvbnN0IGhhc01hcHBpbmcgPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoc3RhdGUuc2V0dGluZ3MuZm9udE1hcCwgZmFtaWx5KTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGhhc01hcHBpbmcgPyBzdGF0ZS5zZXR0aW5ncy5mb250TWFwW2ZhbWlseV0gOiBhdXRvbWF0aWM/LnVybCA/PyAnJztcclxuICAgICAgICBpZiAoc2VsZWN0ZWQgJiYgIXN0YXRlLmZvbnRBc3NldHMuc29tZSgoYXNzZXQpID0+IGFzc2V0LnVybCA9PT0gc2VsZWN0ZWQpKSB7XHJcbiAgICAgICAgICAgIC8vIEFzc2lnbmluZyBhbiB1bm1hdGNoZWQgc2VsZWN0LnZhbHVlIGJlY29tZXMgZW1wdHkgaW4gdGhlIHJlYWxcclxuICAgICAgICAgICAgLy8gcmVuZGVyZXIuIEtlZXAgdGhlIHBlcnNpc3RlZCByZWZlcmVuY2Ugd2hpbGUgQXNzZXREQiBpcyBpbmRleGluZy5cclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbihzZWxlY3RlZCwgYOW3suS/neWtmO+8iOi1hOa6kOaaguacquWwsee7qu+8iSDCtyAke3NlbGVjdGVkfWApKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZm9yIChjb25zdCBhc3NldCBvZiBzdGF0ZS5mb250QXNzZXRzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSBvcHRpb24oYXNzZXQudXJsLCBgJHthc3NldC5uYW1lfSDCtyAke2Fzc2V0LnJlbGF0aXZlUGF0aH1gKTtcclxuICAgICAgICAgICAgaXRlbS5zZWxlY3RlZCA9IGFzc2V0LnVybCA9PT0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChpdGVtKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgcm93LmFwcGVuZChzb3VyY2UsIGFycm93LCBzZWxlY3QpO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZUFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiB1bmtub3duKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIHJldHVybiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oeyBhY3Rpb246IG5vcm1hbGl6ZUltcG9ydEFjdGlvbihhY3Rpb24pLCBraW5kOiBub2RlLmtpbmQsIG5pbmVTbGljZTogZmFsc2UgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSkuYWN0aW9uO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbml0aWFsaXplRG9jdW1lbnQoZG9jdW1lbnQ6IERvY3VtZW50RHRvLCBuYXZpZ2F0ZSA9IHRydWUpOiB2b2lkIHtcclxuICAgIHN0YXRlLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5raW5kcy5jbGVhcigpO1xyXG4gICAgc3RhdGUucGF0Y2hlcy5jbGVhcigpO1xyXG4gICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLm5hbWVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5yZW5hbWVkSWRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5kZWZhdWx0cy5jbGVhcigpO1xyXG4gICAgc3RhdGUuY29sbGFwc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gZG9jdW1lbnQudHJlZVswXT8uaWQ7XHJcbiAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7XHJcbiAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgc3RhdGUuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7XHJcbiAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKTtcclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAoY3VzdG9tTmFtZSAmJiBjdXN0b21OYW1lICE9PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0ID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUucGF0Y2hDYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKFxyXG4gICAgICAgICAgICAnYWN0aXZlJyxcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuc2l6ZSA9PT0gMCAmJiBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09ICdzbWFydCcsXHJcbiAgICAgICAgKTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2ZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gZG9jdW1lbnQuc291cmNlVXJsO1xyXG4gICAgZWxlbWVudCgnI2ZvbnQtaGludCcpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZm9udHMubGVuZ3RoXHJcbiAgICAgICAgPyBg5qOA5rWL5Yiw77yaJHtkb2N1bWVudC5mb250cy5qb2luKCfjgIEnKX1gXHJcbiAgICAgICAgOiAn5b2T5YmN5paH5Lu25bCa5pyq5Y+R546w5a2X5L2T44CCJztcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIHJlbmRlclRyZWUodHJ1ZSk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBpZiAobmF2aWdhdGUpIHdvcmtmbG93Py5kb2N1bWVudFJlYWR5KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5U2V0dGluZ3Moc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHsgLi4uc2V0dGluZ3MsIGZvbnRNYXA6IHsgLi4uc2V0dGluZ3MuZm9udE1hcCB9LCBpbXBvcnRIaWRkZW5MYXllcnM6IHNldHRpbmdzLmltcG9ydEhpZGRlbkxheWVycyAhPT0gZmFsc2UgfTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNpbXBvcnQtaGlkZGVuLWxheWVycycpLmNoZWNrZWQgPSBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnM7XHJcbiAgICB1cGRhdGVUYXJnZXRIaW50KCk7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlYWRTZXR0aW5ncyhzaG93RXJyb3IgPSB0cnVlKTogSW1wb3J0U2V0dGluZ3MgfCBudWxsIHtcclxuICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLnN0YXRlLnNldHRpbmdzLmZvbnRNYXAgfTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PignW2RhdGEtZm9udC1mYW1pbHldJykuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XHJcbiAgICAgICAgY29uc3QgZmFtaWx5ID0gc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseT8udHJpbSgpO1xyXG4gICAgICAgIGlmIChmYW1pbHkgJiYgc2VsZWN0LnZhbHVlKSB7XHJcbiAgICAgICAgICAgIGZvbnRNYXBbZmFtaWx5XSA9IHNlbGVjdC52YWx1ZTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNjYWxlID0gTnVtYmVyKGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlKTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHNjYWxlKSB8fCBzY2FsZSA8IDAuMjUgfHwgc2NhbGUgPiA0KSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+WvvOWFpeWAjeeOh+W/hemhu+WcqCAwLjI1IOWIsCA0IOS5i+mXtOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGFzc2V0Rm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghYXNzZXRGb2xkZXIpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36YCJ5oup6aG555uuIGFzc2V0cyDkuIvnmoTotYTmupDovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmVmYWJGb2xkZXIgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghcHJlZmFiRm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemihOWItuS9k+i+k+WHuuebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBhc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IEFycmF5LmZyb20oeyBsZW5ndGg6IDMgfSwgKF8sIGluZGV4KSA9PlxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWUudHJpbSgpLFxyXG4gICAgICAgICksXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2xvY2FsLXJlc291cmNlLWZvbGRlci0wJykudmFsdWUudHJpbSgpLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdXBkYXRlLWV4aXN0aW5nJykuY2hlY2tlZCxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcmVmcmVzaC1hc3NldHMnKS5jaGVja2VkLFxyXG4gICAgICAgIGF1dG9TYXZlOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXV0by1zYXZlJykuY2hlY2tlZCxcclxuICAgICAgICBpbXBvcnRIaWRkZW5MYXllcnM6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNpbXBvcnQtaGlkZGVuLWxheWVycycpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHBlcnNpc3RQYW5lbFNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnNldHRpbmdzLCBmb250TWFwOiB7IC4uLnNldHRpbmdzLmZvbnRNYXAgfSB9O1xyXG4gICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHN0YXRlLnNldHRpbmdzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QnVzeSh2YWx1ZTogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgdmFsdWUgPSB2YWx1ZSB8fCBCb29sZWFuKHdvcmtmbG93Py5wZW5kaW5nKTtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIC8vIENhcHR1cmUgZWRpdGFibGUgY29udHJvbCBzdGF0ZXMgYmVmb3JlIHRoZSBleGlzdGluZyBidXR0b24gbG9jayBjaGFuZ2VzIHRoZW0uXHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjc2F2ZS10b2tlbicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stYXNzZXQtZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1wcmVmYWItZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWRldGVjdCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZSA9PT0gJyc7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWhpZGRlbicsICF2YWx1ZSk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBpZiAoIXZhbHVlKSByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNldFJvdW5kdHJpcFRva2VucygpOiB2b2lkIHtcclxuICAgIHJvdW5kdHJpcFByZXZpZXdUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcm91bmR0cmlwU291cmNlKCk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXNvdXJjZSkge1xyXG4gICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIOaWh+S7tuaIluiKgueCuemTvuaOpeOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyUm91bmR0cmlwUHJldmlldyhwcmV2aWV3OiBSb3VuZHRyaXBQcmV2aWV3RHRvKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSBwcmV2aWV3LnByZXZpZXdUb2tlbjtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHByZXZpZXcucGFpclRva2VuO1xyXG4gICAgY29uc3QgbGluZXMgPSBbXHJcbiAgICAgICAgYOebruagh++8miR7cHJldmlldy5hc3NldFVybH1gLFxyXG4gICAgICAgIGBQcmVmYWLvvJoke3ByZXZpZXcucHJlZmFiVXVpZH1gLFxyXG4gICAgICAgIGBTdXJmYWNl77yaJHtwcmV2aWV3LnN1cmZhY2VJZH0gwrcgRmlnbWEgJHtwcmV2aWV3LmZpZ21hVmVyc2lvbn0gwrcgTGVkZ2VyICR7cHJldmlldy5sZWRnZXJHZW5lcmF0aW9ufWAsXHJcbiAgICAgICAgYOWwhuS/ruaUuSAke3ByZXZpZXcucGxhbi5hcHBseS5sZW5ndGh9IOmhuSDCtyDkv53nlZkgQ29jb3MgJHtwcmV2aWV3LnBsYW4ucHJlc2VydmVDb2Nvcy5sZW5ndGh9IOmhuSDCtyDlt7LmlLbmlZsgJHtwcmV2aWV3LnBsYW4uY29udmVyZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBg5Yay56qBICR7cHJldmlldy5wbGFuLmNvbmZsaWN0cy5sZW5ndGh9IOmhuSDCtyDkuI3mlK/mjIEgJHtwcmV2aWV3LnBsYW4udW5zdXBwb3J0ZWQubGVuZ3RofSDpobkgwrcg5Y+q6K+75pyq5pS5ICR7cHJldmlldy5wbGFuLnJlYWRvbmx5VW5jaGFuZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBwcmV2aWV3LnBhaXJSZXF1aXJlZFxyXG4gICAgICAgICAgICA/IHByZXZpZXcucGFpckVsaWdpYmxlID8gJ+mmluasoeS9v+eUqO+8muivgeaNruS4gOiHtO+8jOivt+WFiOehruiupOmFjeWvuSBTdXJmYWNl77yI5Y+q5YaZIGxlZGdlcu+8jOS4jeaUuSBQcmVmYWLvvInjgIInIDogJ+mmluasoeS9v+eUqO+8mlBhaXIg6K+B5o2u5LiN5LiA6Ie077yM6ZyA5LuO5b2T5YmNIFByZWZhYiDph43mlrDlr7zlh7rjgIInXHJcbiAgICAgICAgICAgIDogcHJldmlldy5ibG9ja2Vycy5sZW5ndGggPyBg6Zi75pat77yaJHtwcmV2aWV3LmJsb2NrZXJzLmpvaW4oJywgJyl9YCA6ICfpooTop4jpgJrov4fvvIzlj6/ljp/lrZDlupTnlKjmlbTkuKrkuI3lj6/lj5jorqHliJLjgIInLFxyXG4gICAgXTtcclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gbGluZXMuam9pbignXFxuJyk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVRhcmdldEhpbnQoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgZWxlbWVudCgnI2FjdGlvbi1ub3RlJykudGV4dENvbnRlbnQgPSAn5Li76L+b56iL5LiO6Z2i5p2/54mI5pys5LiN5LiA6Ie077yM6ZyA6KaB5a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3InO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWIsOW9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K55LiL77ybRnJhbWUg6ZO+5o6l5bCG6Ieq5Yqo5Yib5bu65bm25omT5byA6aKE5Yi25L2TJztcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRJbXBvcnRCdXR0b24oKTogdm9pZCB7XHJcbiAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgYnV0dG9uLnRpdGxlID0gJ+WvvOWFpeWIsOW9k+WJjeaJk+W8gOWcuuaZr+aIlumihOWItuS9kyc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+W8gOWni+WvvOWFpSc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcwJSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGltcG9ydFByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHZhbHVlID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgZXZlbnQudmFsdWUpKTtcclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycpIHtcclxuICAgICAgICByZXR1cm4gMC4wNSArIHZhbHVlICogMC41NTtcclxuICAgIH1cclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ3NjZW5lJykge1xyXG4gICAgICAgIHJldHVybiAwLjYgKyB2YWx1ZSAqIDAuMzg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZXZlbnQucGhhc2UgPT09ICdkb25lJyA/IDEgOiAwO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgaWYgKGV2ZW50LmJhdGNoICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGV2ZW50LmJhdGNoO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSb3cgPSBldmVudC5iYXRjaC5pdGVtcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBldmVudC5iYXRjaCEuaXRlbUlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gY3VycmVudFJvdz8uc3RhdHVzID09PSAncnVubmluZycgPyBpbXBvcnRQcm9ncmVzcyhldmVudCkgOiAwO1xyXG4gICAgICAgIGV2ZW50ID0ge1xyXG4gICAgICAgICAgICAuLi5ldmVudCxcclxuICAgICAgICAgICAgdmFsdWU6IE1hdGgubWluKDEsIChldmVudC5iYXRjaC5jb21wbGV0ZWQgKyBjdXJyZW50KSAvIE1hdGgubWF4KDEsIGV2ZW50LmJhdGNoLnRvdGFsKSksXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGAke2V2ZW50LmJhdGNoLmluZGV4fSAvICR7ZXZlbnQuYmF0Y2gudG90YWx9IMK3ICR7ZXZlbnQuYmF0Y2gubmFtZX0gwrcgJHtldmVudC5tZXNzYWdlfWAsXHJcbiAgICAgICAgfTtcclxuICAgICAgICByZW5kZXJCYXRjaFJlc3VsdHMoKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkgc2V0QnVzeSh0cnVlKTtcclxuICAgIHdvcmtmbG93Py5wcm9ncmVzcyhldmVudCk7XHJcbiAgICBjb25zdCByZWdpb24gPSBlbGVtZW50KCcjcHJvZ3Jlc3MtcmVnaW9uJyk7XHJcbiAgICBjb25zdCBidXN5ID0gWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtYnVzeScsIGJ1c3kpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWVycm9yJywgZXZlbnQucGhhc2UgPT09ICdlcnJvcicpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQodmFsdWUgKiAxMDApfSVgO1xyXG4gICAgKGVsZW1lbnQoJyNwcm9ncmVzcy1iYXInKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHt2YWx1ZSAqIDEwMH0lYDtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgY29uc3QgaW1wb3J0aW5nID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnO1xyXG4gICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcik7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoaW1wb3J0aW5nKSB7XHJcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBldmVudC5iYXRjaCA/IHZhbHVlIDogaW1wb3J0UHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1ydW5uaW5nJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCAndHJ1ZScpO1xyXG4gICAgICAgIGJ1dHRvbi50aXRsZSA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJyA/ICflh4blpIfotYTmupAnIDogJ+aehOW7uuiKgueCuSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9JWA7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gYCR7cHJvZ3Jlc3MgKiAxMDB9JWA7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXlrozmiJAnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICcxMDAlJztcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMTAwJSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE0MDApO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2Vycm9yJyB8fCBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJyA/ICflt7Llj5bmtognIDogJ+WvvOWFpeWksei0pSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+mHjeivlSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE4MDApO1xyXG4gICAgfVxyXG4gICAgaWYgKFsnZG9uZScsICdlcnJvcicsICdjYW5jZWxsZWQnLCAnaWRsZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScgJiYgIXdvcmtmbG93Py5wZW5kaW5nICYmIHBlbmRpbmdJbXBvcnRSZXZpZXcpIHtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSBwZW5kaW5nSW1wb3J0UmV2aWV3O1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LmJhdGNoPy5yZXN1bHQgJiYgIWJhdGNoSW1wb3J0UGVuZGluZyAmJiBiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oZXZlbnQuYmF0Y2gucmVzdWx0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLFxyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMsXHJcbiAgICAgICAgc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSxcclxuICAgICk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlY29uY2lsZUJhdGNoVmlzaWJpbGl0eSgpOiB2b2lkIHtcclxuICAgIHJlbWVtYmVyQWN0aXZlRnJhbWUoKTtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgYmF0Y2hJdGVtcykge1xyXG4gICAgICAgIGlmICghZW50cnkuZWRpdG9yPy5kb2N1bWVudCkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgZWRpdG9yID0gZW50cnkuZWRpdG9yO1xyXG4gICAgICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKGVkaXRvci5kb2N1bWVudCEudHJlZSwgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMsXHJcbiAgICAgICAgICAgIGVkaXRvci5wYXRjaGVzLCBlZGl0b3IuZXhwbGljaXRJZHMsIGVkaXRvci5yZW5hbWVkSWRzLCBzdGF0ZS5zZXR0aW5ncy5pbXBvcnRIaWRkZW5MYXllcnMgIT09IGZhbHNlKTtcclxuICAgICAgICBlZGl0b3IuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zO1xyXG4gICAgICAgIGVkaXRvci5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNldEltcG9ydEhpZGRlbkxheWVycyhlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2ltcG9ydC1oaWRkZW4tbGF5ZXJzJykuY2hlY2tlZCA9IGVuYWJsZWQ7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSkgPz8geyAuLi5zdGF0ZS5zZXR0aW5ncywgaW1wb3J0SGlkZGVuTGF5ZXJzOiBlbmFibGVkIH07XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgcmVjb25jaWxlQmF0Y2hWaXNpYmlsaXR5KCk7XHJcbiAgICByZW5kZXJUcmVlKCk7IHJlbmRlckZvbnRNYXAoKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgYXdhaXQgcGVyc2lzdFBhbmVsU2V0dGluZ3Moc2V0dGluZ3MpO1xyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBpZiAoYWN0aXZlICYmIGlnbm9yZWRIaWRkZW5GcmFtZShhY3RpdmUpICYmIHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSBhd2FpdCBhY3RpdmF0ZUZyYW1lKHNlbGVjdGVkRnJhbWVzKClbMF0uaXRlbS5pZCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiBJbXBvcnRBY3Rpb24pOiB2b2lkIHtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgYWN0aW9uKSk7XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGU6IFRyZWVOb2RlRHRvKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzdGF0ZS5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleHBsaWNpdE92ZXJyaWRlcygpOiBJbXBvcnRPdmVycmlkZVtdIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKVxyXG4gICAgICAgIC5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSlcclxuICAgICAgICAubWFwKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbmFtZWQgPSBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKTtcclxuICAgICAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogc3RhdGUucHJlZmVycmVkQWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgLi4uKHJlbmFtZWQgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICAgICAgICAgIH0sIG5vZGUucGF0Y2hDYW5kaWRhdGUpO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlS2V5ID0gc3RhdGUuZG9jdW1lbnQuZmlsZUtleTtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgaWYgKGFjdGl2ZSkgeyBhY3RpdmUuY29uZmlndXJlZCA9IHRydWU7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyQmF0Y2goKTsgfVxyXG4gICAgY29uc3Qgb3ZlcnJpZGVzID0gZXhwbGljaXRPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IHNjb3BlSWRzID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+IG5vZGUuaWQpO1xyXG4gICAgLy8gU2VyaWFsaXplIHdyaXRlcyBzbyBhIHNsb3dlciBlYXJsaWVyIHJlcXVlc3QgY2FuIG5ldmVyIG92ZXJ3cml0ZSBhIG5ld2VyXHJcbiAgICAvLyBzdHJhdGVneSBzbmFwc2hvdCBhZnRlciByYXBpZCBzZWxlY3QgY2hhbmdlcy5cclxuICAgIG5vZGVPdmVycmlkZVNhdmVUYXNrID0gbm9kZU92ZXJyaWRlU2F2ZVRhc2tcclxuICAgICAgICAuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKVxyXG4gICAgICAgIC50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdDxJbXBvcnRPdmVycmlkZVtdPignc2F2ZS1ub2RlLW92ZXJyaWRlcycsIGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgICAgIH0pXHJcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6IqC54K5562W55Wl5L+d5a2Y5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYXRjaGVzKG5vZGU6IFRyZWVOb2RlRHRvKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIXN0YXRlLnNlYXJjaCkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGF5c3RhY2sgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gJHtub2RlLm5hbWV9ICR7bm9kZS50eXBlfSAke25vZGUuaWR9YC50b0xvd2VyQ2FzZSgpO1xyXG4gICAgaWYgKGhheXN0YWNrLmluY2x1ZGVzKHN0YXRlLnNlYXJjaCkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUobWF0Y2hlcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9wdGlvbih2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogSFRNTE9wdGlvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xyXG4gICAgaXRlbS52YWx1ZSA9IHZhbHVlO1xyXG4gICAgaXRlbS50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgcmV0dXJuIGl0ZW07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1ha2VTZWxlY3QoXHJcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcclxuICAgIHZhbHVlOiBzdHJpbmcsXHJcbiAgICBpdGVtczogQXJyYXk8W3N0cmluZywgc3RyaW5nXT4sXHJcbiAgICBsYWJlbDogc3RyaW5nLFxyXG4pOiBIVE1MU2VsZWN0RWxlbWVudCB7XHJcbiAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgIHNlbGVjdC5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgbGFiZWwpO1xyXG4gICAgZm9yIChjb25zdCBba2V5LCB0ZXh0XSBvZiBpdGVtcykge1xyXG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24oa2V5LCB0ZXh0KSk7XHJcbiAgICB9XHJcbiAgICBzZWxlY3QudmFsdWUgPSB2YWx1ZTtcclxuICAgIHJldHVybiBzZWxlY3Q7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGVuZFRyZWVOb2RlKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIG5vZGU6IFRyZWVOb2RlRHRvLCBkZXB0aDogbnVtYmVyKTogdm9pZCB7XHJcbiAgICBpZiAoIW1hdGNoZXMobm9kZSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIHJvdy5jbGFzc05hbWUgPSBgdHJlZS1yb3cke3N0YXRlLnNlbGVjdGVkSWQgPT09IG5vZGUuaWQgPyAnIGlzLXNlbGVjdGVkJyA6ICcnfWA7XHJcbiAgICByb3cuZGF0YXNldC5ub2RlSWQgPSBub2RlLmlkO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgncm9sZScsICd0cmVlaXRlbScpO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgnYXJpYS1sZXZlbCcsIFN0cmluZyhkZXB0aCArIDEpKTtcclxuXHJcbiAgICBjb25zdCBtYWluID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBtYWluLmNsYXNzTmFtZSA9ICdub2RlLW1haW4nO1xyXG4gICAgbWFpbi5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhkZXB0aCkpO1xyXG4gICAgY29uc3QgY29sbGFwc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcclxuICAgIGNvbGxhcHNlLmNsYXNzTmFtZSA9IGBjb2xsYXBzZSR7bm9kZS5jaGlsZHJlbi5sZW5ndGggPyAnJyA6ICcgaXMtbGVhZid9YDtcclxuICAgIGNvbGxhcHNlLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGNvbGxhcHNlLmRhdGFzZXQuY29sbGFwc2UgPSBub2RlLmlkO1xyXG4gICAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+KAuicgOiAn4oyEJztcclxuICAgIGNvbGxhcHNlLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIHN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgPyAn5bGV5byAJyA6ICfmipjlj6AnKTtcclxuICAgIGNvbnN0IGRvdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIGRvdC5jbGFzc05hbWUgPSBgdHlwZS1kb3QgJHtcclxuICAgICAgICBub2RlLnR5cGUgPT09ICdURVhUJyA/ICd0ZXh0J1xyXG4gICAgICAgICAgICA6IGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICd2ZWN0b3InXHJcbiAgICAgICAgICAgICAgICA6IG5vZGUudHlwZS5pbmNsdWRlcygnQ09NUE9ORU5UJykgfHwgbm9kZS50eXBlID09PSAnSU5TVEFOQ0UnID8gJ2NvbXBvbmVudCdcclxuICAgICAgICAgICAgICAgICAgICA6ICcnXHJcbiAgICB9YDtcclxuICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIGNvcHkuY2xhc3NOYW1lID0gJ25vZGUtY29weSc7XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbmFtZS5jbGFzc05hbWUgPSBgbm9kZS1uYW1lJHtzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/ICcgaXMtcmVuYW1lZCcgOiAnJ31gO1xyXG4gICAgbmFtZS50ZXh0Q29udGVudCA9IGRpc3BsYXlOYW1lO1xyXG4gICAgY29uc3Qgc3RyYXRlZ3lTdW1tYXJ5ID0gc3RyYXRlZ3lTdW1tYXJ5Rm9yTm9kZShub2RlLCBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkpO1xyXG4gICAgbmFtZS50aXRsZSA9IFtcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gIDogJ+mAieaLqeiKgueCue+8jOWcqOWPs+S+p+S/ruaUueWvvOWFpeiKgueCueWQjScsXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5LFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nLFxyXG4gICAgXVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuam9pbignIMK3ICcpO1xyXG4gICAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbm9kZS1tZXRhJztcclxuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtub2RlLnR5cGV9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvcHkuYXBwZW5kKG5hbWUsIG1ldGEpO1xyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSkge1xyXG4gICAgICAgIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgc3RyYXRlZ3kuY2xhc3NOYW1lID0gJ25vZGUtc3RyYXRlZ3knO1xyXG4gICAgICAgIHN0cmF0ZWd5LnRleHRDb250ZW50ID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIHN0cmF0ZWd5LnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQoc3RyYXRlZ3kpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSB7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHdhcm5pbmcuY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgd2FybmluZy50ZXh0Q29udGVudCA9IGDimqAgJHtzdHJhdGVneVN1bW1hcnkud2FybmluZ31gO1xyXG4gICAgICAgIHdhcm5pbmcudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkud2FybmluZztcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHdhcm5pbmcpO1xyXG4gICAgfVxyXG4gICAgcm93LmNsYXNzTGlzdC50b2dnbGUoJ2hhcy1kZXRhaWwnLCBCb29sZWFuKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSB8fCBzdHJhdGVneVN1bW1hcnkud2FybmluZykpO1xyXG4gICAgbWFpbi5hcHBlbmQoY29sbGFwc2UsIGRvdCwgY29weSk7XHJcblxyXG4gICAgY29uc3QgYWN0aW9uQmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBhY3Rpb25CYWRnZS5jbGFzc05hbWUgPSAnbm9kZS1hY3Rpb24tYmFkZ2UnO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGFjdGlvbkJhZGdlLnRleHRDb250ZW50ID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSkuZmluZCgoW3ZhbHVlXSkgPT4gdmFsdWUgPT09IHNlbGVjdGVkQWN0aW9uKT8uWzFdID8/IHNlbGVjdGVkQWN0aW9uO1xyXG4gICAgYWN0aW9uQmFkZ2UudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgYWN0aW9uQmFkZ2UudGV4dENvbnRlbnQ7XHJcbiAgICByb3cuYXBwZW5kKG1haW4sIGFjdGlvbkJhZGdlKTtcclxuICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChyb3cpO1xyXG5cclxuICAgIGlmICghc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiBhcHBlbmRUcmVlTm9kZShjb250YWluZXIsIGNoaWxkLCBkZXB0aCArIDEpKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyTm9kZVByb3BlcnRpZXMoKTogdm9pZCB7XHJcbiAgICBjb25zdCBjb250YWluZXIgPSBlbGVtZW50KCcjbm9kZS1wcm9wZXJ0aWVzJyk7XHJcbiAgICBjb250YWluZXIucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBub2RlID0gc3RhdGUuc2VsZWN0ZWRJZCA/IGZpbmROb2RlKHN0YXRlLnNlbGVjdGVkSWQpIDogdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2luc3BlY3Rvci1lbXB0eSc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6YCJ5oup6IqC54K577yM5p+l55yL6aKE6KeI5bm26LCD5pW05a+85YWl6K6+572u44CCJztcclxuICAgICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGRpc3BsYXlOYW1lID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICBjb25zdCBmaWVsZCA9IChsYWJlbDogc3RyaW5nLCBjb250cm9sOiBIVE1MRWxlbWVudCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmaWVsZCc7XHJcbiAgICAgICAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBoZWFkaW5nLnRleHRDb250ZW50ID0gbGFiZWw7XHJcbiAgICAgICAgcm93LmFwcGVuZChoZWFkaW5nLCBjb250cm9sKTtcclxuICAgICAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcclxuICAgIG5hbWUudHlwZSA9ICd0ZXh0JztcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gJ25vZGUtbmFtZS1pbnB1dCc7XHJcbiAgICBuYW1lLnZhbHVlID0gZGlzcGxheU5hbWU7XHJcbiAgICBuYW1lLm1heExlbmd0aCA9IDk2O1xyXG4gICAgbmFtZS5zcGVsbGNoZWNrID0gZmFsc2U7XHJcbiAgICBuYW1lLmRhdGFzZXQubmFtZUZvciA9IG5vZGUuaWQ7XHJcbiAgICBuYW1lLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke25vZGUubmFtZX0g5a+85YWl6IqC54K55ZCNYCk7XHJcbiAgICBuYW1lLnRpdGxlID0gYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfe+8m0VudGVyIOS/neWtmO+8jEVzYyDlj5bmtohgO1xyXG4gICAgbmFtZS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBmaWVsZCgn5a+85YWl6IqC54K55ZCNJywgbmFtZSk7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGNvbnN0IGFjdGlvbk9wdGlvbnMgPSBhY3Rpb25PcHRpb25zRm9yTm9kZShub2RlKTtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2FjdGlvbi1zZWxlY3QnLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIGFjdGlvbk9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOWvvOWFpeaWueW8j2AsXHJcbiAgICApO1xyXG4gICAgYWN0aW9uLmRhdGFzZXQuYWN0aW9uRm9yID0gbm9kZS5pZDtcclxuICAgIGFjdGlvbi5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBmaWVsZCgn5a+85YWl5pa55byPJywgYWN0aW9uKTtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEtpbmQgPSBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGVmZmVjdGl2ZUtpbmRGb3JOb2RlKFxyXG4gICAgICAgIG5vZGUsXHJcbiAgICAgICAgc2VsZWN0ZWRLaW5kLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGtpbmRPcHRpb25zID0ga2luZE9wdGlvbnNGb3JBY3Rpb24oc2VsZWN0ZWRBY3Rpb24pO1xyXG4gICAgY29uc3Qga2luZCA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2tpbmQtc2VsZWN0JyxcclxuICAgICAgICBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGtpbmRPcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDoioLngrnnsbvlnotgLFxyXG4gICAgKTtcclxuICAgIGtpbmQuZGF0YXNldC5raW5kRm9yID0gbm9kZS5pZDtcclxuICAgIGtpbmQuZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+iKgueCueexu+WeiycsIGtpbmQpO1xyXG5cclxuICAgIGNvbnN0IHBhdGNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcclxuICAgIHBhdGNoLmNsYXNzTmFtZSA9ICd0b2dnbGUtcm93IHBhdGNoLXRvZ2dsZSc7XHJcbiAgICBwYXRjaC50aXRsZSA9IG5vZGUucGF0Y2hDYW5kaWRhdGVcclxuICAgICAgICA/ICdGaWdtYSDliIbniYfkvJjlhYjvvJrmjIkgRmlnbWEg5Y6f5aeL6L6555WM5a+85YWl77yM5LiN6IO95YWz6Zet77yb5LuN5Y+v5b+955Wl5pW05Liq6IqC54K5J1xyXG4gICAgICAgIDogJ+ivpeiKgueCueS4jeaYr+acieaViOeahCBGaWdtYSDliIbniYcnO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICBjb25zdCBwYXRjaEljb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBwYXRjaEljb24udGV4dENvbnRlbnQgPSBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgPyBub2RlLnNsaWNlTW9kZSA9PT0gJ25pbmUnID8gJ0ZpZ21hIOS5neWuqyDCtyDkvJjlhYjlkK/nlKgnIDogbm9kZS5zbGljZU1vZGUgPyAnRmlnbWEg5LiJ5a6rIMK3IOS8mOWFiOWQr+eUqCcgOiAnRmlnbWEg5LiJIC8g5Lmd5a6rIMK3IOS8mOWFiOWQr+eUqCdcclxuICAgICAgICA6ICfliIfniYcgwrcg6Z2e5YCZ6YCJ6IqC54K5JztcclxuICAgIHBhdGNoLmFwcGVuZChwYXRjaElucHV0LCBwYXRjaEljb24pO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHBhdGNoKTtcclxuICAgIGNvbnN0IHN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBjb25zdCBub3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBub3RlLmNsYXNzTmFtZSA9ICdub2RlLWluc3BlY3Rvci1ub3RlJztcclxuICAgIGNvbnN0IGhpZGRlbklnbm9yZWQgPSBoaWRkZW5MYXllcklkcyhzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSwgc3RhdGUuc2V0dGluZ3MuaW1wb3J0SGlkZGVuTGF5ZXJzICE9PSBmYWxzZSkuaGFzKG5vZGUuaWQpO1xyXG4gICAgZm9yIChjb25zdCB0ZXh0IG9mIFtoaWRkZW5JZ25vcmVkID8gJ+makOiXj+WbvuWxgiDCtyDmnKzmrKHlv73nlaXvvIjlkKvlhbblrZDmoJHvvInvvJvlvIDlkK/igJzlr7zlhaXpmpDol4/lm77lsYLigJ3lj6/mgaLlpI3ljp/nrZbnlaUnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIHN1bW1hcnkuc3RyYXRlZ3ksIGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gLCBzdW1tYXJ5Lndhcm5pbmddKSB7XHJcbiAgICAgICAgaWYgKCF0ZXh0KSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBwYXJhZ3JhcGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgcGFyYWdyYXBoLnRleHRDb250ZW50ID0gdGV4dDtcclxuICAgICAgICBpZiAodGV4dCA9PT0gc3VtbWFyeS53YXJuaW5nKSBwYXJhZ3JhcGguY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgbm90ZS5hcHBlbmRDaGlsZChwYXJhZ3JhcGgpO1xyXG4gICAgfVxyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKG5vdGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJUcmVlKHJlc2V0U2Nyb2xsID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRyZWUgPSBlbGVtZW50KCcjdHJlZScpO1xyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsKHRyZWUsICgpID0+IHtcclxuICAgICAgICB0cmVlLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2VtcHR5LXN0YXRlJztcclxuICAgICAgICAgICAgY29uc3QgZ2x5cGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgICAgIGdseXBoLmNsYXNzTmFtZSA9ICdlbXB0eS1nbHlwaCc7XHJcbiAgICAgICAgICAgIGdseXBoLnRleHRDb250ZW50ID0gJ+KGsyc7XHJcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XHJcbiAgICAgICAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ+i/mOayoeacieiKgueCuSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOmTvuaOpeWQju+8jOWPr+mAkOWxgumAieaLqeeUn+aIkOOAgVBORyDmlbTlsYLmiJbmm7TmlrDjgIInO1xyXG4gICAgICAgICAgICBlbXB0eS5hcHBlbmQoZ2x5cGgsIHRpdGxlLCBib2R5KTtcclxuICAgICAgICAgICAgdHJlZS5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQudHJlZS5mb3JFYWNoKChub2RlKSA9PiBhcHBlbmRUcmVlTm9kZSh0cmVlLCBub2RlLCAwKSk7XHJcbiAgICB9LCByZXNldFNjcm9sbCk7XHJcbiAgICByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KCk6IHZvaWQge1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyQmF0Y2goKTsgfVxyXG4gICAgY29uc3Qgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudCA/IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkgOiBbXTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gbm9kZXMuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSAhPT0gJ2lnbm9yZScpO1xyXG4gICAgZWxlbWVudCgnI25vZGUtY291bnQnKS50ZXh0Q29udGVudCA9IGAke25vZGVzLmxlbmd0aH0g6IqC54K5YDtcclxuICAgIGVsZW1lbnQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICA/IGAke3NlbGVjdGVkLmxlbmd0aH0gLyAke25vZGVzLmxlbmd0aH0g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYFxyXG4gICAgICAgIDogJ+etieW+heiuvuiuoeaVsOaNric7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3lcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc2VsZWN0ZWQubGVuZ3RoXHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3KG5vZGU6IFRyZWVOb2RlRHRvKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBub2RlLmlkO1xyXG4gICAgY29uc3QgcmV2aXNpb24gPSArK3ByZXZpZXdSZXZpc2lvbjtcclxuICAgIGNvbnN0IGZyYW1lSWQgPSBhY3RpdmVCYXRjaElkO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvbnN0IHN0YWdlID0gZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKTtcclxuICAgIGNvbnN0IGltYWdlID0gZWxlbWVudDxIVE1MSW1hZ2VFbGVtZW50PignI3ByZXZpZXctaW1hZ2UnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2lzLWxvYWRpbmcnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2hhcy1pbWFnZScpO1xyXG4gICAgaW1hZ2UucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcHJlY2VkaW5nU3luYyA9IGJhdGNoU3luY1Rhc2s7XHJcbiAgICAgICAgY29uc3QgcmVhZCA9IHByZXZpZXdSZWFkVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVjZWRpbmdTeW5jO1xyXG4gICAgICAgICAgICBpZiAocHJldmlld1JldmlzaW9uICE9PSByZXZpc2lvbiB8fCBmcmFtZUlkICE9PSBhY3RpdmVCYXRjaElkKSByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgcmV0dXJuIHJlcXVlc3Q8eyB1cmw6IHN0cmluZyB9PignZ2V0LXByZXZpZXcnLCBub2RlLmlkKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBwcmV2aWV3UmVhZFRhc2sgPSByZWFkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVhZDtcclxuICAgICAgICBpZiAoIXJlc3VsdCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChzdGF0ZS5zZWxlY3RlZElkICE9PSBub2RlLmlkIHx8IHByZXZpZXdSZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgZnJhbWVJZCAhPT0gYWN0aXZlQmF0Y2hJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6aKE6KeI5Zu+54mH5Yqg6L295aSx6LSl44CCJykpO1xyXG4gICAgICAgICAgICBpbWFnZS5zcmMgPSByZXN1bHQudXJsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gPT09IHJldmlzaW9uKSBzdGFnZS5jbGFzc0xpc3QuYWRkKCdoYXMtaW1hZ2UnKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpooTop4jlpLHotKXjgIInLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLWxvYWRpbmcnKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlQcmVzZXQobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxsID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgIGlmIChuYW1lID09PSAnc21hcnQnKSB7XHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gc3RhdGUuZGVmYXVsdHMuZ2V0KG5vZGUuaWQpITtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgb3JpZ2luYWwuYWN0aW9uKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmtpbmQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobmFtZSA9PT0gJ2VkaXRhYmxlJykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3JlbmRlcicgOiAnZ2VuZXJhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyAnZ2VuZXJhdGUnXHJcbiAgICAgICAgICAgICAgICA6ICdyZW5kZXInKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IG5hbWUpO1xyXG4gICAgfSk7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRUb1NjZW5lKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHdvcmtmbG93ICYmIHdvcmtmbG93LnN0ZXAgIT09IDMpIHJldHVybjtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+aJqeWxleS4u+i/m+eoi+S7jeaYr+aXp+eJiO+8jOivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCB8fCBzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoKTtcclxuICAgIGlmICghc2V0dGluZ3MpIHtcclxuICAgICAgICB3b3JrZmxvdz8uZmFpbCgn6K+35qOA5p+l5a+85YWl5YCN546H5LiO6L6T5Ye655uu5b2V77yM5L+u5q2j5ZCO5YaN5qyh5a+85YWl44CCJyk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHJlY29uY2lsZUJhdGNoVmlzaWJpbGl0eSgpO1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYXdhaXQgaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3MpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24sXHJcbiAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSkpO1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTtcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlh4blpIflr7zlhaXigKYnIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PFdvcmtmbG93UmVzdWx0PihcclxuICAgICAgICAgICAgJ2ltcG9ydC1zZWxlY3Rpb24nLFxyXG4gICAgICAgICAgICB7IG92ZXJyaWRlcywgc2V0dGluZ3MgfSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrTm90ZSA9IHJlc3VsdD8ud2FybmluZ3M/Lmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDvvJske3Jlc3VsdC53YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrvvIjor6bop4Hnu5Pmnpzmo4Dmn6XvvIlgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZShyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHJlc3VsdC5yZXZpZXcgPz8gcGVuZGluZ0ltcG9ydFJldmlldztcclxuICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogd29ya2Zsb3c/LmNhbmNlbGxlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsIG1lc3NhZ2UgfSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpO1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VCYXRjaEl0ZW1zKGl0ZW1zOiBCYXRjaEZyYW1lSXRlbVtdKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJhdGNoSXRlbXMuZmluZCgoZW50cnkpID0+IGVudHJ5Lml0ZW0uaWQgPT09IGl0ZW0uaWQpO1xyXG4gICAgICAgIGlmIChwcmV2aW91cykgcHJldmlvdXMuaXRlbSA9IHsgLi4uaXRlbSwgZW5hYmxlZDogcHJldmlvdXMuaXRlbS5lbmFibGVkIH07XHJcbiAgICAgICAgZWxzZSBiYXRjaEl0ZW1zLnB1c2goeyBpdGVtLCBlZGl0b3I6IGluaXRpYWxGcmFtZUVkaXRvcihpdGVtLmRvY3VtZW50KSwgY29uZmlndXJlZDogQm9vbGVhbihpdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXM/Lmxlbmd0aCkgfSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlYWRCYXRjaFNvdXJjZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBpZiAod29ya2Zsb3cgJiYgIXdvcmtmbG93LmNyZWRlbnRpYWxzUmVhZHkpIHsgd29ya2Zsb3cub3BlbkNyZWRlbnRpYWxzKCk7IHJldHVybjsgfVxyXG4gICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXNvdXJjZSkgeyBzaG93VG9hc3QoJ+ivt+eymOi0tCBGaWdtYSBTZWN0aW9uIOaIliBGcmFtZSDpk77mjqXjgIInLCB0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7IGlmIChzZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHdvcmtmbG93Py5iZWdpbignZmV0Y2gnKTsgc2V0QnVzeSh0cnVlKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjA1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+W5bm26K+G5YirIEZpZ21hIOeVjOmdouKApicgfSk7XHJcbiAgICBsZXQgYWN0aXZhdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvckJhdGNoTGlzdFJlYWR5KCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDxCYXRjaFNvdXJjZVJlc3VsdD4oJ3Jlc29sdmUtYmF0Y2gtc291cmNlJywgc291cmNlKTtcclxuICAgICAgICBpZiAocmVzdWx0LmRvY3VtZW50ICYmICFyZXN1bHQuaXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgIGJhdGNoSXRlbXMgPSBbXTsgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDsgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSByZXN1bHQuZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBzdGF0ZS5mb250QXNzZXRzO1xyXG4gICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQocmVzdWx0LmRvY3VtZW50KTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBtZXJnZUJhdGNoSXRlbXMocmVzdWx0Lml0ZW1zKTtcclxuICAgICAgICAgICAgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBBcnJheS5mcm9tKG5ldyBNYXAoYmF0Y2hJdGVtcy5mbGF0TWFwKCh7IGl0ZW0gfSkgPT4gaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID8/IFtdKS5tYXAoKGZvbnQpID0+IFtmb250LnVybCwgZm9udF0pKS52YWx1ZXMoKSk7XHJcbiAgICAgICAgICAgIGFjdGl2YXRlID0gc2VsZWN0ZWRGcmFtZXMoKS5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk/Lml0ZW0uaWQgPz8gc2VsZWN0ZWRGcmFtZXMoKVswXT8uaXRlbS5pZCA/PyBiYXRjaEl0ZW1zWzBdPy5pdGVtLmlkO1xyXG4gICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gJyc7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5iYXRjaFJlYWR5KCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg5bey5re75YqgICR7cmVzdWx0LmFkZGVkfSDkuKrnlYzpnaIke3Jlc3VsdC5kdXBsaWNhdGVzID8gYO+8jOi3s+i/hyAke3Jlc3VsdC5kdXBsaWNhdGVzfSDkuKrph43lpI3poblgIDogJyd944CCYCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5aSx6LSl44CCJyk7XHJcbiAgICAgICAgaWYgKCF3b3JrZmxvdz8uY2FuY2VsbGVkKSB3b3JrZmxvdz8uZmFpbChtZXNzYWdlKTtcclxuICAgICAgICBzaG93VG9hc3Qod29ya2Zsb3c/LmNhbmNlbGxlZCA/ICfor7vlj5blt7Llj5bmtojvvIzphY3nva7lt7Lkv53nlZnjgIInIDogbWVzc2FnZSwgIXdvcmtmbG93Py5jYW5jZWxsZWQpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIGlmIChhY3RpdmF0ZSkgYXdhaXQgYWN0aXZhdGVGcmFtZShhY3RpdmF0ZSk7XHJcbiAgICAgICAgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBvdmVycmlkZXNGb3JGcmFtZShlbnRyeTogRnJhbWVFZGl0b3JJdGVtKTogSW1wb3J0T3ZlcnJpZGVbXSB7XHJcbiAgICBjb25zdCBlZGl0b3IgPSBlbnRyeS5lZGl0b3IgPz8gaW5pdGlhbEZyYW1lRWRpdG9yKGVudHJ5Lml0ZW0uZG9jdW1lbnQpO1xyXG4gICAgcmV0dXJuIGZsYXR0ZW4oZW50cnkuaXRlbS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+IG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsIGFjdGlvbjogZWRpdG9yLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uLCBraW5kOiBlZGl0b3Iua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IGVkaXRvci5wYXRjaGVzLmhhcyhub2RlLmlkKSwgZXhwbGljaXQ6IGVkaXRvci5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKGVkaXRvci5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IHsgbmFtZTogZWRpdG9yLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWUgfSA6IHt9KSxcclxuICAgIH0sIG5vZGUucGF0Y2hDYW5kaWRhdGUpKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzLCBpZHM/OiBTZXQ8c3RyaW5nPik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kgfHwgYmF0Y2hJbXBvcnRQZW5kaW5nKSByZXR1cm47XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgcmVjb25jaWxlQmF0Y2hWaXNpYmlsaXR5KCk7XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBlbnRyaWVzID0gc2VsZWN0ZWRGcmFtZXMoKS5maWx0ZXIoKHsgaXRlbSB9KSA9PiAhaWRzIHx8IGlkcy5oYXMoaXRlbS5pZCkpO1xyXG4gICAgaWYgKCFlbnRyaWVzLmxlbmd0aCkgeyBzaG93VG9hc3QoJ+ivt+WFiOWLvumAieimgeWvvOWFpeeahOeVjOmdouOAgicsIHRydWUpOyByZXR1cm47IH1cclxuICAgIGlmIChiYXRjaENvbmZsaWN0cygpLnNpemUpIHsgd29ya2Zsb3c/LmZhaWwoJ+WtmOWcqOmHjeWkjeeahCBQcmVmYWIg5paH5Lu25ZCN77yM6K+35YWI5Zyo5riF5Y2V5Lit5pS55ZCN44CCJyk7IHJldHVybjsgfVxyXG4gICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gdHJ1ZTsgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDsgYmF0Y2hTdG9wUmVxdWVzdGVkID0gZmFsc2U7XHJcbiAgICBjb25zdCBwcmV2aW91cyA9IGJhdGNoUmVzdWx0O1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTsgc2V0QnVzeSh0cnVlKTsgcmVuZGVyQmF0Y2goKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogYOWHhuWkh+WvvOWFpSAke2VudHJpZXMubGVuZ3RofSDkuKrnlYzpnaLigKZgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yQmF0Y2hMaXN0UmVhZHkoKTtcclxuICAgICAgICBhd2FpdCBub2RlT3ZlcnJpZGVTYXZlVGFzaztcclxuICAgICAgICBpZiAoYmF0Y2hTdG9wUmVxdWVzdGVkKSB7XHJcbiAgICAgICAgICAgIGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oeyBpZDogJ3N0b3BwZWQtYmVmb3JlLXN0YXJ0Jywgc3RvcHBlZDogdHJ1ZSwgY29tcGxldGVkOiAwLCB0b3RhbDogZW50cmllcy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICBpdGVtczogZW50cmllcy5tYXAoKHsgaXRlbSB9KSA9PiAoeyBpZDogaXRlbS5pZCwgbmFtZTogaXRlbS5uYW1lLCBzb3VyY2VVcmw6IGl0ZW0uc291cmNlVXJsLCBzdGF0dXM6ICdwZW5kaW5nJyB9KSkgfSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDxCYXRjaEltcG9ydFJlc3VsdD4oJ2ltcG9ydC1iYXRjaCcsIHtcclxuICAgICAgICAgICAgaXRlbXM6IGVudHJpZXMubWFwKChlbnRyeSkgPT4gKHsgaWQ6IGVudHJ5Lml0ZW0uaWQsIG92ZXJyaWRlczogb3ZlcnJpZGVzRm9yRnJhbWUoZW50cnkpIH0pKSwgc2V0dGluZ3MsXHJcbiAgICAgICAgICAgIGZhaWx1cmVQb2xpY3k6ICdjb250aW51ZScsIHByZXNlcnZlUmVzdWx0czogQm9vbGVhbihpZHMpLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGNvbnN0IG1lcmdlZCA9IGlkcyAmJiBwcmV2aW91cyA/IHByZXZpb3VzLml0ZW1zLm1hcCgoaXRlbSkgPT4gcmVzdWx0Lml0ZW1zLmZpbmQoKG5leHQpID0+IG5leHQuaWQgPT09IGl0ZW0uaWQpID8/IGl0ZW0pIDogcmVzdWx0Lml0ZW1zO1xyXG4gICAgICAgIGJhdGNoUmVzdWx0ID0geyAuLi5yZXN1bHQsIGl0ZW1zOiBtZXJnZWQsIHRvdGFsOiBtZXJnZWQubGVuZ3RoLCBjb21wbGV0ZWQ6IG1lcmdlZC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycgfHwgaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGggfTtcclxuICAgICAgICBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkOyBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICBjb25zdCBjcmVhdGVkID0gbWVyZ2VkLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyAoaXRlbS5jcmVhdGVkID8/IDApLCAwKTtcclxuICAgICAgICBjb25zdCB1cGRhdGVkID0gbWVyZ2VkLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyAoaXRlbS51cGRhdGVkID8/IDApLCAwKTtcclxuICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUoeyBjcmVhdGVkLCB1cGRhdGVkLCB3YXJuaW5nczogbWVyZ2VkLmZsYXRNYXAoKGl0ZW0pID0+IGl0ZW0ud2FybmluZ3MgPz8gW10pIH0pO1xyXG4gICAgICAgIHNob3dUb2FzdChg5pys5om55a6M5oiQ77ya5oiQ5YqfICR7bWVyZ2VkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJykubGVuZ3RofSDpobnvvIzlpLHotKUgJHttZXJnZWQuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aH0g6aG544CCYCk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICfmibnph4/lr7zlhaXlpLHotKXjgIInKTtcclxuICAgICAgICB3b3JrZmxvdz8uZmFpbChtZXNzYWdlKTsgc2hvd1RvYXN0KG1lc3NhZ2UsIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBiYXRjaEltcG9ydFBlbmRpbmcgPSBmYWxzZTsgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTsgcmVuZGVyQmF0Y2goKTsgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZXRyeUJhdGNoKHN0YXR1czogJ2ZhaWxlZCcgfCAncGVuZGluZycpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5IHx8ICFiYXRjaFJlc3VsdCkgcmV0dXJuO1xyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoKTsgaWYgKCFzZXR0aW5ncykgcmV0dXJuO1xyXG4gICAgY29uc3QgaWRzID0gbmV3IFNldChiYXRjaFJlc3VsdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSBzdGF0dXMpLm1hcCgoaXRlbSkgPT4gaXRlbS5pZCkpO1xyXG4gICAgYXdhaXQgaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3MsIGlkcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24ocmVzdWx0OiBCYXRjaEltcG9ydFJlc3VsdCk6IHZvaWQge1xyXG4gICAgYmF0Y2hSZXN1bHQgPSByZXN1bHQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICB3b3JrZmxvdz8uY29tcGxldGUoe1xyXG4gICAgICAgIGNyZWF0ZWQ6IHJlc3VsdC5pdGVtcy5yZWR1Y2UoKHN1bSwgaXRlbSkgPT4gc3VtICsgKGl0ZW0uY3JlYXRlZCA/PyAwKSwgMCksXHJcbiAgICAgICAgdXBkYXRlZDogcmVzdWx0Lml0ZW1zLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyAoaXRlbS51cGRhdGVkID8/IDApLCAwKSxcclxuICAgICAgICB3YXJuaW5nczogcmVzdWx0Lml0ZW1zLmZsYXRNYXAoKGl0ZW0pID0+IGl0ZW0ud2FybmluZ3MgPz8gW10pLFxyXG4gICAgfSk7XHJcbiAgICByZW5kZXJCYXRjaCgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB3YXRjaFJlc3RvcmVkQmF0Y2goKTogdm9pZCB7XHJcbiAgICBiYXRjaFJlY292ZXJ5VGltZXIgPSBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXBhbmVsSG9zdCkgcmV0dXJuO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY292ZXJlZCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTdGF0ZT4oJ2dldC1iYXRjaC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBpZiAocmVjb3ZlcmVkLnJ1bm5pbmcpIHtcclxuICAgICAgICAgICAgICAgIGJhdGNoUHJvZ3Jlc3MgPSByZWNvdmVyZWQucnVubmluZzsgcmVuZGVyQmF0Y2hSZXN1bHRzKCk7IHdhdGNoUmVzdG9yZWRCYXRjaCgpOyByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHJlY292ZXJlZC5sYXN0UmVzdWx0KSBjb21wbGV0ZUJhdGNoUHJlc2VudGF0aW9uKHJlY292ZXJlZC5sYXN0UmVzdWx0KTtcclxuICAgICAgICAgICAgZWxzZSB3b3JrZmxvdz8uZmFpbCgn5ZCO5Y+w5om56YeP5Lu75Yqh5bey57uP57uT5p2f77yM6K+35qOA5p+lIENvY29zIOS4reeahOWvvOWFpee7k+aenOOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IHdvcmtmbG93Py5mYWlsKGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluWQjuWPsOaJuemHj+S7u+WKoeWksei0peOAgicpKTtcclxuICAgICAgICB9XHJcbiAgICB9LCA4MDApO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBvcGVuSW1wb3J0UmV2aWV3KHRhYjogJ2Fzc2V0cycgfCAnbm9kZXMnIHwgJ3NvdXJjZScgPSAnYXNzZXRzJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gYXdhaXQgcmVxdWVzdDxJbXBvcnRSZXZpZXcgfCBudWxsPignZ2V0LWltcG9ydC1yZXZpZXcnKTtcclxuICAgICAgICBpZiAocmV2aWV3KSB7XHJcbiAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgICAgIGNvbnN0IGluZGV4ID0gWydhc3NldHMnLCAnbm9kZXMnLCAnc291cmNlJ10uaW5kZXhPZih0YWIpO1xyXG4gICAgICAgICAgICBpZiAoaW5kZXggPiAwKSBlbGVtZW50KCcjaW1wb3J0LXJldmlldy1kaWFsb2cnKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PignLnJldmlldy10YWJzIGJ1dHRvbicpW2luZGV4XT8uY2xpY2soKTtcclxuICAgICAgICB9IGVsc2Ugc2hvd1RvYXN0KCfmnKzmrKHmj5Lku7bkvJror53lsJrml6Dlr7zlhaXmo4Dmn6Xnu5PmnpzvvIzor7flhYjlrozmiJDkuIDmrKHlr7zlhaXjgIInKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7IHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5bmo4Dmn6Xnu5PmnpzlpLHotKXjgIInKSwgdHJ1ZSk7IH1cclxufVxyXG5cclxuZnVuY3Rpb24gYmluZEV2ZW50cygpOiB2b2lkIHtcclxuICAgIGVsZW1lbnQoJyNvcGVuLWltcG9ydC1yZXZpZXcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgdm9pZCBvcGVuSW1wb3J0UmV2aWV3KCk7IH0pO1xyXG4gICAgZWxlbWVudCgnI3NhdmUtdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN0b2tlbi1pbnB1dCcpO1xyXG4gICAgICAgIGlmICghaW5wdXQudmFsdWUudHJpbSgpKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIFRva2Vu44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IHNhdmVkID0gZmFsc2U7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55Pignc2V0LXRva2VuJywgaW5wdXQudmFsdWUpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICAgICAgc2F2ZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QodmF1bHQucGVyc2lzdGVudCA/ICdUb2tlbiDlt7LnlLHns7vnu5/liqDlr4bkv53lrZjjgIInIDogJ1Rva2VuIOW3suS/neWtmOWIsOacrOasoeS8muivneOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfkv53lrZjlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNhdmVkKSB3b3JrZmxvdz8uY2xvc2VDcmVkZW50aWFscygpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN2ZXJpZnktdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBoYW5kbGU6IHN0cmluZyB9PigndmVyaWZ5LXRva2VuJyk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6L+e5o6l5oiQ5YqfIMK3ICR7cmVzdWx0LmhhbmRsZX1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6L+e5o6l5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2NsZWFyLXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdmF1bHQgPSBhd2FpdCByZXF1ZXN0PGFueT4oJ2NsZWFyLXRva2VuJyk7XHJcbiAgICAgICAgc2V0Q29ubmVjdGlvbih2YXVsdCk7XHJcbiAgICAgICAgc2hvd1RvYXN0KCflt7LmuIXpmaTkv53lrZjnmoQgRmlnbWEg5Yet5o2u44CCJyk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLWRldGVjdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IHJvdW5kdHJpcFNvdXJjZSgpO1xyXG4gICAgICAgIGlmICghc291cmNlKSByZXR1cm47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRldGVjdGVkID0gYXdhaXQgcmVxdWVzdDxSb3VuZHRyaXBEZXRlY3REdG8+KCdyb3VuZHRyaXAtZGV0ZWN0Jywgc291cmNlKTtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpO1xyXG4gICAgICAgICAgICBzZWxlY3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3Qgcm9vdCBvZiBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnZhbHVlID0gcm9vdC5ub2RlSWQ7XHJcbiAgICAgICAgICAgICAgICBvcHRpb24udGV4dENvbnRlbnQgPSByb290LmVycm9yXHJcbiAgICAgICAgICAgICAgICAgICAgPyBgJHtyb290Lm5hbWV9IMK3IOWNj+iuruaNn+Wdj2BcclxuICAgICAgICAgICAgICAgICAgICA6IGAke3Jvb3QubmFtZX0gwrcgJHtyb290LnByZWZhYlV1aWQgPz8gJ+acquefpSBQcmVmYWInfWA7XHJcbiAgICAgICAgICAgICAgICBvcHRpb24uZGlzYWJsZWQgPSBCb29sZWFuKHJvb3QuZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgc2VsZWN0LmFwcGVuZChvcHRpb24pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNlbGVjdC52YWx1ZSA9IGRldGVjdGVkLnNlbGVjdGVkUm9vdElkXHJcbiAgICAgICAgICAgICAgICA/PyBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMuZmluZCgocm9vdCkgPT4gIXJvb3QuZXJyb3IpPy5ub2RlSWRcclxuICAgICAgICAgICAgICAgID8/ICcnO1xyXG4gICAgICAgICAgICBzZWxlY3QuZGlzYWJsZWQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoID09PSAwO1xyXG4gICAgICAgICAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGRldGVjdGVkLm1hbmFnZWRSb290cy5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gYOajgOa1i+WIsCAke2RldGVjdGVkLm1hbmFnZWRSb290cy5sZW5ndGh9IOS4qiBtYW5hZ2VkIHJvb3QgwrcgRmlnbWEgJHtkZXRlY3RlZC5maWdtYVZlcnNpb25944CC6YCJ5oup55uu5qCH5ZCO55Sf5oiQ5Y+q6K+76aKE6KeI44CCYFxyXG4gICAgICAgICAgICAgICAgOiAn5pyq5qOA5rWL5YiwIG1hbmFnZWQgcm9vdOOAgic7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg5qOA5rWL5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcm9vdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXByZXZpZXcnKS5kaXNhYmxlZCA9XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZSA9PT0gJyc7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXByZXZpZXcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBjb25zdCByb290SWQgPSBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWU7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UgfHwgIXJvb3RJZCkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZW5kZXJSb3VuZHRyaXBQcmV2aWV3KGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwUHJldmlld0R0bz4oJ3JvdW5kdHJpcC1wcmV2aWV3Jywgc291cmNlLCByb290SWQpKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDpooTop4jlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wYWlyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFyb3VuZHRyaXBQYWlyVG9rZW4pIHJldHVybjtcclxuICAgICAgICBjb25zdCB0b2tlbiA9IHJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcGFpcmVkID0gYXdhaXQgcmVxdWVzdDx7IGdlbmVyYXRpb246IG51bWJlcjsgYmFzZWxpbmVIYXNoOiBzdHJpbmcgfT4oJ3JvdW5kdHJpcC1wYWlyJywgdG9rZW4pO1xyXG4gICAgICAgICAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGDphY3lr7nlrozmiJAgwrcgTGVkZ2VyIGdlbmVyYXRpb24gJHtwYWlyZWQuZ2VuZXJhdGlvbn1cXG5CYXNlbGluZSAke3BhaXJlZC5iYXNlbGluZUhhc2h9XFxu6K+36YeN5paw55Sf5oiQ5Y+Y5pu06aKE6KeI44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdTdXJmYWNlIOW3sumFjeWvue+8m+acquS/ruaUuSBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCBQYWlyIOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLWFwcGx5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFyb3VuZHRyaXBQcmV2aWV3VG9rZW4pIHJldHVybjtcclxuICAgICAgICBjb25zdCB0b2tlbiA9IHJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IHJlcXVlc3Q8eyB0eG5JZDogc3RyaW5nOyBwcmVmYWJQb3N0aW1hZ2VIYXNoOiBzdHJpbmcgfT4oJ3JvdW5kdHJpcC1hcHBseScsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg5LqL5Yqh5bey5o+Q5LqkIMK3ICR7cmVjZWlwdC50eG5JZH1cXG5Qb3N0aW1hZ2UgJHtyZWNlaXB0LnByZWZhYlBvc3RpbWFnZUhhc2h9XFxu6K+36YeN5paw6aKE6KeI5Lul56Gu6K6kIDAgcGF0Y2jjgIJgO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ1JvdW5kLXRyaXAg5bey5Y6f5a2Q5bqU55So5Yiw5Y6fIFByZWZhYuOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOW6lOeUqOWksei0pe+8jOS6i+WKoeW3suWbnua7muOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLWNhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmVxdWVzdCgncm91bmR0cmlwLWNhbmNlbCcpKTtcclxuXHJcbiAgICBlbGVtZW50KCcjZmV0Y2gtZG9jdW1lbnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGZvcmNlUmVhZCA9IGZvcmNlRG9jdW1lbnRSZWFkO1xyXG4gICAgICAgIGZvcmNlRG9jdW1lbnRSZWFkID0gZmFsc2U7XHJcbiAgICAgICAgaWYgKHdvcmtmbG93ICYmICF3b3JrZmxvdy5jcmVkZW50aWFsc1JlYWR5KSB7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Lm9wZW5DcmVkZW50aWFscygpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChiYXRjaEl0ZW1zLmxlbmd0aCAmJiAhZm9yY2VSZWFkKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gc2VsZWN0ZWRGcmFtZXMoKTtcclxuICAgICAgICAgICAgaWYgKCFzZWxlY3RlZC5sZW5ndGgpIHJldHVybjtcclxuICAgICAgICAgICAgYXdhaXQgYWN0aXZhdGVGcmFtZShzZWxlY3RlZC5zb21lKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCkgPyBhY3RpdmVCYXRjaElkISA6IHNlbGVjdGVkWzBdLml0ZW0uaWQsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChmb3JjZVJlYWQgJiYgYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmUpIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBhY3RpdmUuaXRlbS5zb3VyY2VVcmw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghZm9yY2VSZWFkICYmIHdvcmtmbG93Py5zb3VyY2VVbmNoYW5nZWQoKSkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdy5uYXZpZ2F0ZSgyKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCByZWFkQmF0Y2hTb3VyY2UoKTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2FkZC1iYXRjaC1zb3VyY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIHJlYWRCYXRjaFNvdXJjZSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtZWRpdC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB3b3JrZmxvdz8ubmF2aWdhdGUoMSkpO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXRvZ2dsZS1hbGwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IGF2YWlsYWJsZUZyYW1lcygpO1xyXG4gICAgICAgIGNvbnN0IGVuYWJsZWQgPSBzZWxlY3RlZEZyYW1lcygpLmxlbmd0aCAhPT0gYXZhaWxhYmxlLmxlbmd0aDtcclxuICAgICAgICBhdmFpbGFibGUuZm9yRWFjaCgoeyBpdGVtIH0pID0+IHsgaXRlbS5lbmFibGVkID0gZW5hYmxlZDsgfSk7XHJcbiAgICAgICAgc3luY0JhdGNoSXRlbXMoKTsgcmVuZGVyQmF0Y2goKTsgcmVuZGVyRm9udE1hcCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXRyeS1mYWlsZWQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJldHJ5QmF0Y2goJ2ZhaWxlZCcpKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bWUtcGVuZGluZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmV0cnlCYXRjaCgncGVuZGluZycpKTtcclxuICAgIGVsZW1lbnQoJyNyZWZyZXNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IHRydWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpLmNsaWNrKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYWRkLWJhdGNoLXNvdXJjZScpLmNsaWNrKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgcmVzZXRSb3VuZHRyaXBUb2tlbnMpO1xyXG4gICAgZWxlbWVudCgnI3BpY2stYXNzZXQtZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1hc3NldC1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDotYTmupDlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjcGljay1wcmVmYWItZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stcHJlZmFiLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDpooTliLbkvZPlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6aKE5Yi25L2T55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQoYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcu+8jOWGjemAieaLqeacrOWcsOi1hOa6kOebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgICAgIGluZGV4LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHBlcnNpc3RQYW5lbFNldHRpbmdzKHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3suWQr+eUqOacrOWcsOWQjOWQjei1hOa6kOebruW9lSAke2luZGV4ICsgMX3jgIJgKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup5pys5Zyw6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGVsZW1lbnQoYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gJyc7XHJcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNob3dUb2FzdChg5bey5riF6Zmk5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGltcG9ydFRvU2NlbmUpO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBpZiAoYmF0Y2hJbXBvcnRQZW5kaW5nKSBiYXRjaFN0b3BSZXF1ZXN0ZWQgPSB0cnVlO1xyXG4gICAgICAgIHdvcmtmbG93Py5jYW5jZWxSZXF1ZXN0ZWQoKTtcclxuICAgICAgICB0cnkgeyBhd2FpdCByZXF1ZXN0KGJhdGNoSW1wb3J0UGVuZGluZyA/ICdzdG9wLWltcG9ydC1iYXRjaCcgOiAnY2FuY2VsLWltcG9ydCcpOyB9XHJcbiAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICflj5bmtojor7fmsYLlpLHotKXvvIzor7fnqI3lkI7ph43or5XjgIInKTtcclxuICAgICAgICAgICAgd29ya2Zsb3c/LmNhbmNlbFJlcXVlc3RGYWlsZWQobWVzc2FnZSk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChldmVudCkgPT4ge1xyXG4gICAgICAgIHN0YXRlLnNlYXJjaCA9IChldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGNvbGxhcHNlSWQgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvbGxhcHNlXScpPy5kYXRhc2V0LmNvbGxhcHNlO1xyXG4gICAgICAgIGlmIChjb2xsYXBzZUlkKSB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5jb2xsYXBzZWQuaGFzKGNvbGxhcHNlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5jb2xsYXBzZWQuZGVsZXRlKGNvbGxhcHNlSWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmFkZChjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KCdzZWxlY3QsIGxhYmVsLCBpbnB1dCwgdGV4dGFyZWEnKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1ub2RlLWlkXScpPy5kYXRhc2V0Lm5vZGVJZDtcclxuICAgICAgICBjb25zdCBub2RlID0gaWQgPyBmaW5kTm9kZShpZCkgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgdm9pZCBwcmV2aWV3KG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQ7XHJcbiAgICAgICAgaWYgKCF0YXJnZXQuZGF0YXNldC5uYW1lRm9yICYmICF0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IgJiYgIXRhcmdldC5kYXRhc2V0LmtpbmRGb3IgJiYgIXRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSByZXR1cm47XHJcbiAgICAgICAgaWYgKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybjtcclxuICAgICAgICAgICAgY29uc3QgY3VzdG9tTmFtZSA9IHNhbml0aXplTm9kZU5hbWUodGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgaWYgKCFjdXN0b21OYW1lKSB7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn6IqC54K55ZCN5LiN6IO95Li656m644CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoY3VzdG9tTmFtZSA9PT0gbm9kZS5uYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpXHJcbiAgICAgICAgICAgICAgICA/IGDoioLngrnlsIbku6XigJwke2N1c3RvbU5hbWV94oCd5a+85YWl44CCYFxyXG4gICAgICAgICAgICAgICAgOiAn5bey5oGi5aSNIEZpZ21hIOWOn+iKgueCueWQjeOAgicpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCB0YXJnZXQudmFsdWUpO1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGFjdGlvbiAhPT0gJ3JlbmRlcicgJiYgIW5vZGUucGF0Y2hDYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHNldEFjdGlvbihub2RlLCBhY3Rpb24pO1xyXG4gICAgICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgICAgICAuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGFjdGlvbiA9PT0gJ3JlbmRlcicgJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICBzaG93VG9hc3QoYOKAnCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl94oCd5bCG5L2c5Li65pW05bGC5a+85YWl77yMJHtkZXNjZW5kYW50cyhub2RlKS5sZW5ndGh9IOS4quWtkOiKgueCueS4jeS8muWNleeLrOeUn+aIkOOAgmApO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQua2luZEZvcikge1xyXG4gICAgICAgICAgICBzdGF0ZS5raW5kcy5zZXQodGFyZ2V0LmRhdGFzZXQua2luZEZvciwgdGFyZ2V0LnZhbHVlIGFzIE5vZGVLaW5kKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpO1xyXG4gICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpIHtcclxuICAgICAgICAgICAgLy8gQWxzbyByZWplY3QgYSBzdGFsZSBwYW5lbC9wcm9ncmFtbWF0aWMgYXR0ZW1wdCB0byBkaXNhYmxlIGEgdmFsaWRcclxuICAgICAgICAgICAgLy8gRmlnbWEgZGVmaW5pdGlvbjsgdGhlIHNvdXJjZSBkZWNpc2lvbiBpcyBzaGFyZWQgd2l0aCB0aGUgaW1wb3J0ZXIuXHJcbiAgICAgICAgICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICBpZiAoZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpPy5wYXRjaENhbmRpZGF0ZSkgc2hvd1RvYXN0KCdGaWdtYSDliIbniYfkvJjlhYjvvIzkuI3og73lhbPpl63vvJvlj6/lnKjlr7zlhaXmlrnlvI/kuK3lv73nlaXmlbTkuKroioLngrnjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudDtcclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5kYXRhc2V0Lm5hbWVGb3I7XHJcbiAgICAgICAgaWYgKCFpZCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChldmVudC5rZXkgPT09ICdFbnRlcicpIHtcclxuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGlkKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHRhcmdldC52YWx1ZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICB0YXJnZXQuYmx1cigpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFwcGx5UHJlc2V0KGJ1dHRvbi5kYXRhc2V0LnByZXNldCA/PyAnc21hcnQnKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWhpZGRlbi1sYXllcnMnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgc2V0SW1wb3J0SGlkZGVuTGF5ZXJzKGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNpbXBvcnQtaGlkZGVuLWxheWVycycpLmNoZWNrZWQpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFxyXG4gICAgICAgICcjc2NhbGUsICNhc3NldC1mb2xkZXIsICNwcmVmYWItZm9sZGVyLCAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLCAjdXBkYXRlLWV4aXN0aW5nLCAjcmVmcmVzaC1hc3NldHMsICNhdXRvLXNhdmUnLFxyXG4gICAgKS5mb3JFYWNoKChjb250cm9sKSA9PiB7XHJcbiAgICAgICAgY29udHJvbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCBzZWxlY3QgPSBldmVudC50YXJnZXQgYXMgSFRNTFNlbGVjdEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgZmFtaWx5ID0gc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseT8udHJpbSgpO1xyXG4gICAgICAgIGlmICghZmFtaWx5KSByZXR1cm47XHJcbiAgICAgICAgLy8gQW4gZW1wdHkgc3RyaW5nIHJlY29yZHMgYW4gZXhwbGljaXQgb3B0LW91dCBmcm9tIGF1dG9tYXRpYyBtYXRjaGluZy5cclxuICAgICAgICAvLyBVbnJlbmRlcmVkIGZhbWlsaWVzIGFuZCB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSBhc3NldHMgc3RheSBpbnRhY3QuXHJcbiAgICAgICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnN0YXRlLnNldHRpbmdzLCBmb250TWFwOiB7IC4uLnN0YXRlLnNldHRpbmdzLmZvbnRNYXAsIFtmYW1pbHldOiBzZWxlY3QudmFsdWUgfSB9O1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKSA/PyBzdGF0ZS5zZXR0aW5ncztcclxuICAgICAgICBhd2FpdCBwZXJzaXN0UGFuZWxTZXR0aW5ncyhzZXR0aW5ncyk7XHJcbiAgICB9KTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcclxuICAgIGxpc3RlbmVyczoge1xyXG4gICAgICAgIHNob3coKSB7fSxcclxuICAgICAgICBoaWRlKCkge30sXHJcbiAgICB9LFxyXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0ZjgnKSxcclxuICAgIHN0eWxlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKSwgJ3V0ZjgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBhcHA6ICcjYXBwJyxcclxuICAgIH0sXHJcbiAgICBtZXRob2RzOiB7XHJcbiAgICAgICAgb25JbXBvcnRSZXZpZXdSZWFkeShyZXZpZXc6IEltcG9ydFJldmlldykge1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2hJdGVtcy5sZW5ndGgpIHsgd29ya2Zsb3c/LnJlbWVtYmVyUmV2aWV3KCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSB8fCB3b3JrZmxvdz8ucGVuZGluZykge1xyXG4gICAgICAgICAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IHJldmlldztcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB3b3JrZmxvdz8uY29tcGxldGUoeyByZXZpZXcgfSk7XHJcbiAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgfSxcclxuICAgICAgICBvblByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KSB7XHJcbiAgICAgICAgICAgIHVwZGF0ZVByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICB9LFxyXG4gICAgfSxcclxuICAgIGFzeW5jIHJlYWR5KCkge1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IHRoaXM7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWwgPSBuZXcgSW1wb3J0UmV2aWV3UGFuZWwocm9vdCgpLCByZXF1ZXN0LCBzZXRCdXN5KTtcclxuICAgICAgICB3b3JrZmxvdyA9IG5ldyBQYW5lbFdvcmtmbG93KHJvb3QoKSwgKCkgPT4gKHsgLi4uc3RhdGUsIGJhdGNoOiBiYXRjaENvbnRleHQoKSB9KSwgKHRhYikgPT4geyB2b2lkIG9wZW5JbXBvcnRSZXZpZXcodGFiKTsgfSk7XHJcbiAgICAgICAgYmluZEV2ZW50cygpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGluaXRpYWwgPSBhd2FpdCByZXF1ZXN0PHtcclxuICAgICAgICAgICAgICAgIHZlcnNpb24/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICB2YXVsdDogYW55O1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IERvY3VtZW50RHRvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgICAgICAgICAgfT4oJ2dldC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSA9IGluaXRpYWwudmVyc2lvbiA9PT0gcGFja2FnZUpTT04udmVyc2lvbjtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGluaXRpYWwuZm9udEFzc2V0cyA/PyBbXTtcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbihpbml0aWFsLnZhdWx0KTtcclxuICAgICAgICAgICAgYXBwbHlTZXR0aW5ncyhpbml0aWFsLnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluaXRpYWwuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgICAgIGluaXRpYWxpemVEb2N1bWVudChpbml0aWFsLmRvY3VtZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBiYXRjaCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTdGF0ZSB8IHVuZGVmaW5lZD4oJ2dldC1iYXRjaC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBpZiAoYmF0Y2g/Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKGJhdGNoLml0ZW1zKTtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBBcnJheS5mcm9tKG5ldyBNYXAoYmF0Y2guaXRlbXMuZmxhdE1hcCgoaXRlbSkgPT4gaXRlbS5kb2N1bWVudC5mb250QXNzZXRzID8/IFtdKS5tYXAoKGZvbnQpID0+IFtmb250LnVybCwgZm9udF0pKS52YWx1ZXMoKSk7XHJcbiAgICAgICAgICAgICAgICB3b3JrZmxvdy5iYXRjaFJlYWR5KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBzZWxlY3RlZEZyYW1lcygpWzBdID8/IGJhdGNoSXRlbXNbMF07XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGFjdGl2ZUJhdGNoSWQgPSBhY3RpdmUuaXRlbS5pZDtcclxuICAgICAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKHN0YXRlLCBhY3RpdmUuZWRpdG9yKTtcclxuICAgICAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7IHJlbmRlckZvbnRNYXAoKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSBhd2FpdCBhY3RpdmF0ZUZyYW1lKGFjdGl2ZS5pdGVtLmlkKTtcclxuICAgICAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gubGFzdFJlc3VsdCkgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihiYXRjaC5sYXN0UmVzdWx0KTtcclxuICAgICAgICAgICAgICAgIGlmIChiYXRjaC5ydW5uaW5nKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGJhdGNoLnJ1bm5pbmc7IHdvcmtmbG93LmJlZ2luKCdpbXBvcnQnKTsgc2V0QnVzeSh0cnVlKTsgd2F0Y2hSZXN0b3JlZEJhdGNoKCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICAgICAgICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn6K+36YeN5ZCvIENvY29zJztcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihrsnO1xyXG4gICAgICAgICAgICAgICAgc2hvd1RvYXN0KCfmo4DmtYvliLDml6fniYjkuLvov5vnqIvku43lnKjov5DooYzvvJror7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgLy8gUmVwbGF5IHBlcnNpc3RlZCBpbi1tZW1vcnkgcmVwb3J0IGlmIGNvbXBsZXRpb24gcHJlY2VkZWQgcGFuZWwgcmVhZGluZXNzLlxyXG4gICAgICAgICAgICAgICAgY29uc3QgcmV2aWV3ID0gYXdhaXQgcmVxdWVzdDxJbXBvcnRSZXZpZXcgfCBudWxsPignZ2V0LWltcG9ydC1yZXZpZXcnKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXZpZXcpIHdvcmtmbG93LnJlbWVtYmVyUmV2aWV3KCk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmV2aWV3ICYmICFyZXZpZXcuY29uZmlybWVkICYmICFiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHdvcmtmbG93LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5Yid5aeL5YyW5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSxcclxuICAgIGJlZm9yZUNsb3NlKCkge30sXHJcbiAgICBjbG9zZSgpIHtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8uZGlzcG9zZSgpO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbnVsbDtcclxuICAgICAgICB3b3JrZmxvdyA9IG51bGw7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgaWYgKHRvYXN0VGltZXIpIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgICAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikgY2xlYXJUaW1lb3V0KGltcG9ydEJ1dHRvblJlc2V0VGltZXIpO1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIGJhdGNoSXRlbXMgPSBbXTsgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDsgYmF0Y2hSZXN1bHQgPSB1bmRlZmluZWQ7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgYmF0Y2hJbXBvcnRQZW5kaW5nID0gZmFsc2U7IGJhdGNoU3luY0Vycm9yID0gdW5kZWZpbmVkOyBiYXRjaFN5bmNUYXNrID0gUHJvbWlzZS5yZXNvbHZlKCk7IHByZXZpZXdSZXZpc2lvbisrO1xyXG4gICAgICAgIHByZXZpZXdSZWFkVGFzayA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19