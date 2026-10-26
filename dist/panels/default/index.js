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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQTJGO0FBRTNGLGtEQUEwRDtBQUUxRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCwrREFBeUU7QUFDekUsbUNBVWlCO0FBbUVqQixJQUFJLFNBQVMsR0FBUSxJQUFJLENBQUM7QUFDMUIsSUFBSSxpQkFBaUIsR0FBNkIsSUFBSSxDQUFDO0FBQ3ZELElBQUksUUFBUSxHQUF5QixJQUFJLENBQUM7QUFDMUMsSUFBSSxtQkFBbUIsR0FBd0IsSUFBSSxDQUFDO0FBQ3BELElBQUksaUJBQWlCLEdBQUcsS0FBSyxDQUFDO0FBQzlCLElBQUksVUFBVSxHQUF5QyxJQUFJLENBQUM7QUFDNUQsSUFBSSxzQkFBc0IsR0FBeUMsSUFBSSxDQUFDO0FBQ3hFLElBQUksb0JBQW9CLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUM1RCxJQUFJLHFCQUF5QyxDQUFDO0FBQzlDLElBQUksa0JBQXNDLENBQUM7QUFHM0MsSUFBSSxVQUFVLEdBQXNCLEVBQUUsQ0FBQztBQUN2QyxJQUFJLGFBQWlDLENBQUM7QUFDdEMsSUFBSSxXQUEwQyxDQUFDO0FBQy9DLElBQUksYUFBd0MsQ0FBQztBQUM3QyxJQUFJLGFBQWEsR0FBa0IsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBQ3JELElBQUksY0FBdUIsQ0FBQztBQUM1QixJQUFJLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUMvQixJQUFJLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUMvQixJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUM7QUFDeEIsSUFBSSxlQUFlLEdBQXFCLE9BQU8sQ0FBQyxPQUFPLEVB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TSxFQUFFLFNBQVMsRUFBRSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFNBQVMsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ25LLGFBQWEsR0FBRyxTQUFTLENBQUM7UUFBQyxtQkFBbUIsR0FBRyxJQUFJLENBQUM7UUFDdEQsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsR0FBRyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsQ0FBQSxFQUFBLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDM0UsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsR0FBRyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsT0FBTyxtQ0FBSSxDQUFDLENBQUMsQ0FBQSxFQUFBLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDM0UsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLFFBQVEsQ0FBQyxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxXQUFDLE9BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSxtQ0FBSSxFQUFFLENBQUEsRUFBQSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ2xHLFNBQVMsQ0FBQyxXQUFXLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxDQUFDLENBQUMsTUFBTSxTQUFTLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxNQUFNLEtBQUssUUFBUSxDQUFDLENB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QUcsRUFBRSxDQUFDO1FBQUMsYUFBYSxHQUFHLFNBQVMsQ0FBQztRQUFDLFdBQVcsR0FBRyxTQUFTLENBQUM7UUFBQyxhQUFhLEdBQUcsU0FBUyxDQUFDO1FBQy9GLGtCQUFrQixHQUFHLEtBQUssQ0FBQztRQUFDLGNBQWMsR0FBRyxTQUFTLENBQUM7UUFBQyxhQUFhLEdBQUcsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQUMsZUFBZSxFQUFFLENBQUM7UUFDN0csZUFBZSxHQUFHLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNwQyxTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ3JCLENBQUM7Q0FDSixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uLy4uLy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IEltcG9ydFJldmlld1BhbmVsIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3JztcclxuaW1wb3J0IHsgUGFuZWxXb3JrZmxvdywgdHlwZSBCYXRjaFdvcmtmbG93Q29udGV4dCwgdHlwZSBXb3JrZmxvd1Jlc3VsdCB9IGZyb20gJy4vd29ya2Zsb3cnO1xyXG5pbXBvcnQgdHlwZSB7IEJhdGNoRnJhbWVJdGVtLCBCYXRjaEltcG9ydEl0ZW1SZXN1bHQsIEJhdGNoSW1wb3J0UmVzdWx0LCBCYXRjaFByb2dyZXNzLCBCYXRjaFNvdXJjZVJlc3VsdCwgQmF0Y2hTdGF0ZSB9IGZyb20gJy4uLy4uL2JhdGNoLXR5cGVzJztcclxuaW1wb3J0IHsgc2FuaXRpemVBc3NldE5hbWUgfSBmcm9tICcuLi8uLi9pbXBvcnRlci9hc3NldHMnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydFJldmlldyB9IGZyb20gJy4uLy4uL2ltcG9ydC1yZXZpZXctbW9kZWwnO1xyXG5pbXBvcnQgeyBmaW5kRm9udEFzc2V0LCB0eXBlIEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgbm9ybWFsaXplSW1wb3J0QWN0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi4vLi4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHsgbm9ybWFsaXplRmlnbWFTbGljZURlY2lzaW9uIH0gZnJvbSAnLi4vLi4vZmlnbWEvaW1wb3J0LXBsYW5uZXInO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IGltcG9ydFJldmlld1BhbmVsOiBJbXBvcnRSZXZpZXdQYW5lbCB8IG51bGwgPSBudWxsO1xyXG5sZXQgd29ya2Zsb3c6IFBhbmVsV29ya2Zsb3cgfCBudWxsID0gbnVsbDtcclxubGV0IHBlbmRpbmdJbXBvcnRSZXZpZXc6IEltcG9ydFJldmlldyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZm9yY2VEb2N1bWVudFJlYWQgPSBmYWxzZTtcclxubGV0IHRvYXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBpbXBvcnRCdXR0b25SZXNldFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHJvdW5kdHJpcFByZXZpZXdUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgcm91bmR0cmlwUGFpclRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbnR5cGUgRnJhbWVFZGl0b3JTdGF0ZSA9IFBpY2s8UGFuZWxTdGF0ZSwgJ2RvY3VtZW50JyB8ICdwcmVmZXJyZWRBY3Rpb25zJyB8ICdhY3Rpb25zJyB8ICdraW5kcycgfCAncGF0Y2hlcycgfCAnZXhwbGljaXRJZHMnIHwgJ25hbWVzJyB8ICdyZW5hbWVkSWRzJyB8ICdkZWZhdWx0cycgfCAnY29sbGFwc2VkJyB8ICdzdXBwcmVzc2VkJyB8ICdzZWxlY3RlZElkJyB8ICdzZWFyY2gnPiAmIHsgdHJlZVNjcm9sbDogbnVtYmVyOyBwcmVzZXQ/OiBzdHJpbmcgfTtcclxuaW50ZXJmYWNlIEZyYW1lRWRpdG9ySXRlbSB7IGl0ZW06IEJhdGNoRnJhbWVJdGVtOyBlZGl0b3I/OiBGcmFtZUVkaXRvclN0YXRlOyBjb25maWd1cmVkOiBib29sZWFuIH1cclxubGV0IGJhdGNoSXRlbXM6IEZyYW1lRWRpdG9ySXRlbVtdID0gW107XHJcbmxldCBhY3RpdmVCYXRjaElkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbmxldCBiYXRjaFJlc3VsdDogQmF0Y2hJbXBvcnRSZXN1bHQgfCB1bmRlZmluZWQ7XHJcbmxldCBiYXRjaFByb2dyZXNzOiBCYXRjaFByb2dyZXNzIHwgdW5kZWZpbmVkO1xyXG5sZXQgYmF0Y2hTeW5jVGFzazogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgYmF0Y2hTeW5jRXJyb3I6IHVua25vd247XHJcbmxldCBiYXRjaEltcG9ydFBlbmRpbmcgPSBmYWxzZTtcclxubGV0IGJhdGNoU3RvcFJlcXVlc3RlZCA9IGZhbHNlO1xyXG5sZXQgcHJldmlld1JldmlzaW9uID0gMDtcclxubGV0IHByZXZpZXdSZWFkVGFzazogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgYmF0Y2hSZWNvdmVyeVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5cclxuY29uc3Qgc3RhdGU6IFBhbmVsU3RhdGUgPSB7XHJcbiAgICBkb2N1bWVudDogbnVsbCxcclxuICAgIHNldHRpbmdzOiB7XHJcbiAgICAgICAgc291cmNlVXJsOiAnJyxcclxuICAgICAgICBhc3NldEZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyJyxcclxuICAgICAgICBwcmVmYWJGb2xkZXI6ICdmaWdtYS1pbXBvcnRlci9wcmVmYWJzJyxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogW10sXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogJycsXHJcbiAgICAgICAgc2NhbGU6IDEsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IHRydWUsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZmFsc2UsXHJcbiAgICAgICAgYXV0b1NhdmU6IGZhbHNlLFxyXG4gICAgICAgIGZvbnRNYXA6IHt9LFxyXG4gICAgfSxcclxuICAgIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoKSxcclxuICAgIGFjdGlvbnM6IG5ldyBNYXAoKSxcclxuICAgIGtpbmRzOiBuZXcgTWFwKCksXHJcbiAgICBwYXRjaGVzOiBuZXcgU2V0KCksXHJcbiAgICBleHBsaWNpdElkczogbmV3IFNldCgpLFxyXG4gICAgbmFtZXM6IG5ldyBNYXAoKSxcclxuICAgIHJlbmFtZWRJZHM6IG5ldyBTZXQoKSxcclxuICAgIGRlZmF1bHRzOiBuZXcgTWFwKCksXHJcbiAgICBjb2xsYXBzZWQ6IG5ldyBTZXQoKSxcclxuICAgIHN1cHByZXNzZWQ6IG5ldyBTZXQoKSxcclxuICAgIHNlYXJjaDogJycsXHJcbiAgICBidXN5OiBmYWxzZSxcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiB0cnVlLFxyXG4gICAgZm9udEFzc2V0czogW10sXHJcbn07XHJcblxyXG5mdW5jdGlvbiBzZWxlY3RlZEZyYW1lcygpOiBGcmFtZUVkaXRvckl0ZW1bXSB7IHJldHVybiBiYXRjaEl0ZW1zLmZpbHRlcigoeyBpdGVtIH0pID0+IGl0ZW0uZW5hYmxlZCk7IH1cclxuXHJcbmZ1bmN0aW9uIGVkaXRvclNuYXBzaG90KCk6IEZyYW1lRWRpdG9yU3RhdGUge1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBkb2N1bWVudDogc3RhdGUuZG9jdW1lbnQsXHJcbiAgICAgICAgcHJlZmVycmVkQWN0aW9uczogbmV3IE1hcChzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zKSwgYWN0aW9uczogbmV3IE1hcChzdGF0ZS5hY3Rpb25zKSxcclxuICAgICAgICBraW5kczogbmV3IE1hcChzdGF0ZS5raW5kcyksIHBhdGNoZXM6IG5ldyBTZXQoc3RhdGUucGF0Y2hlcyksIGV4cGxpY2l0SWRzOiBuZXcgU2V0KHN0YXRlLmV4cGxpY2l0SWRzKSxcclxuICAgICAgICBuYW1lczogbmV3IE1hcChzdGF0ZS5uYW1lcyksIHJlbmFtZWRJZHM6IG5ldyBTZXQoc3RhdGUucmVuYW1lZElkcyksIGRlZmF1bHRzOiBuZXcgTWFwKHN0YXRlLmRlZmF1bHRzKSxcclxuICAgICAgICBjb2xsYXBzZWQ6IG5ldyBTZXQoc3RhdGUuY29sbGFwc2VkKSwgc3VwcHJlc3NlZDogbmV3IFNldChzdGF0ZS5zdXBwcmVzc2VkKSxcclxuICAgICAgICBzZWxlY3RlZElkOiBzdGF0ZS5zZWxlY3RlZElkLCBzZWFyY2g6IHN0YXRlLnNlYXJjaCwgdHJlZVNjcm9sbDogZWxlbWVudCgnI3RyZWUnKS5zY3JvbGxUb3AsXHJcbiAgICAgICAgcHJlc2V0OiBBcnJheS5mcm9tKHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpKS5maW5kKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QuY29udGFpbnMoJ2FjdGl2ZScpKT8uZGF0YXNldC5wcmVzZXQsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbml0aWFsRnJhbWVFZGl0b3IoZG9jdW1lbnQ6IERvY3VtZW50RHRvKTogRnJhbWVFZGl0b3JTdGF0ZSB7XHJcbiAgICBjb25zdCBlZGl0b3I6IEZyYW1lRWRpdG9yU3RhdGUgPSB7XHJcbiAgICAgICAgZG9jdW1lbnQsIHByZWZlcnJlZEFjdGlvbnM6IG5ldyBNYXAoKSwgYWN0aW9uczogbmV3IE1hcCgpLCBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgICAgIHBhdGNoZXM6IGRlZmF1bHROaW5lU2xpY2VJZHMoZG9jdW1lbnQudHJlZSksIGV4cGxpY2l0SWRzOiBuZXcgU2V0KCksIG5hbWVzOiBuZXcgTWFwKCksIHJlbmFtZWRJZHM6IG5ldyBTZXQoKSxcclxuICAgICAgICBkZWZhdWx0czogbmV3IE1hcCgpLCBjb2xsYXBzZWQ6IG5ldyBTZXQoKSwgc3VwcHJlc3NlZDogbmV3IFNldCgpLCBzZWxlY3RlZElkOiBkb2N1bWVudC50cmVlWzBdPy5pZCxcclxuICAgICAgICBzZWFyY2g6ICcnLCB0cmVlU2Nyb2xsOiAwLCBwcmVzZXQ6ICdzbWFydCcsXHJcbiAgICB9O1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIGZsYXR0ZW4oZG9jdW1lbnQudHJlZSkpIHtcclxuICAgICAgICBjb25zdCBhY3Rpb24gPSBzbWFydEFjdGlvbkZvck5vZGUobm9kZSk7XHJcbiAgICAgICAgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7IGVkaXRvci5raW5kcy5zZXQobm9kZS5pZCwgbm9kZS5raW5kKTtcclxuICAgICAgICBlZGl0b3IuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7IGVkaXRvci5uYW1lcy5zZXQobm9kZS5pZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7IGlmICghbm9kZSkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUob3ZlcnJpZGUubmFtZSk7XHJcbiAgICAgICAgaWYgKG5hbWUgJiYgbmFtZSAhPT0gbm9kZS5uYW1lKSB7IGVkaXRvci5uYW1lcy5zZXQobm9kZS5pZCwgbmFtZSk7IGVkaXRvci5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTsgfVxyXG4gICAgICAgIGlmIChvdmVycmlkZS5leHBsaWNpdCkge1xyXG4gICAgICAgICAgICBlZGl0b3IucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBvdmVycmlkZS5hY3Rpb24pKTsgZWRpdG9yLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUucGF0Y2hDYW5kaWRhdGUpIGVkaXRvci5wYXRjaGVzLmFkZChub2RlLmlkKTsgZWxzZSBlZGl0b3IucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIGVkaXRvci5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7IGVkaXRvci5wcmVzZXQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoZG9jdW1lbnQudHJlZSwgZWRpdG9yLnByZWZlcnJlZEFjdGlvbnMsIGVkaXRvci5wYXRjaGVzLCBlZGl0b3IuZXhwbGljaXRJZHMsIGVkaXRvci5yZW5hbWVkSWRzKTtcclxuICAgIGVkaXRvci5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7IGVkaXRvci5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbiAgICByZXR1cm4gZWRpdG9yO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1lbWJlckFjdGl2ZUZyYW1lKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYWN0aXZlID0gYmF0Y2hJdGVtcy5maW5kKCh7IGl0ZW0gfSkgPT4gaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCk7XHJcbiAgICBpZiAoYWN0aXZlKSBhY3RpdmUuZWRpdG9yID0gZWRpdG9yU25hcHNob3QoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZnJhbWVOYW1lKGVudHJ5OiBGcmFtZUVkaXRvckl0ZW0pOiBzdHJpbmcge1xyXG4gICAgY29uc3QgZWRpdG9yID0gZW50cnkuaXRlbS5pZCA9PT0gYWN0aXZlQmF0Y2hJZCA/IHN0YXRlIDogZW50cnkuZWRpdG9yO1xyXG4gICAgcmV0dXJuIGVkaXRvcj8ubmFtZXMuZ2V0KGVudHJ5Lml0ZW0ucm9vdElkKSA/PyBlbnRyeS5pdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXM/LmZpbmQoKG92ZXJyaWRlKSA9PiBvdmVycmlkZS5pZCA9PT0gZW50cnkuaXRlbS5yb290SWQpPy5uYW1lID8/IGVudHJ5Lml0ZW0ubmFtZTtcclxufVxyXG5cclxuZnVuY3Rpb24gYmF0Y2hDb25mbGljdHMoKTogU2V0PHN0cmluZz4ge1xyXG4gICAgY29uc3QgbmFtZXMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XHJcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNlbGVjdGVkRnJhbWVzKCkpIHtcclxuICAgICAgICBjb25zdCBrZXkgPSBzYW5pdGl6ZUFzc2V0TmFtZShmcmFtZU5hbWUoZW50cnkpKS50b0xvY2FsZUxvd2VyQ2FzZSgpO1xyXG4gICAgICAgIG5hbWVzLnNldChrZXksIFsuLi4obmFtZXMuZ2V0KGtleSkgPz8gW10pLCBlbnRyeS5pdGVtLmlkXSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbmV3IFNldChBcnJheS5mcm9tKG5hbWVzLnZhbHVlcygpKS5maWx0ZXIoKGlkcykgPT4gaWRzLmxlbmd0aCA+IDEpLmZsYXQoKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQ29udGV4dCgpOiBCYXRjaFdvcmtmbG93Q29udGV4dCB8IHVuZGVmaW5lZCB7XHJcbiAgICBpZiAoIWJhdGNoSXRlbXMubGVuZ3RoKSByZXR1cm4gdW5kZWZpbmVkO1xyXG4gICAgbGV0IG5vZGVzID0gMDtcclxuICAgIGxldCBzZWxlY3RlZE5vZGVzID0gMDtcclxuICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc2VsZWN0ZWRGcmFtZXMoKSkge1xyXG4gICAgICAgIGNvbnN0IGVkaXRvciA9IGVudHJ5Lml0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQgPyBzdGF0ZSA6IGVudHJ5LmVkaXRvcjtcclxuICAgICAgICBjb25zdCBhbGwgPSBmbGF0dGVuKGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgbm9kZXMgKz0gYWxsLmxlbmd0aDtcclxuICAgICAgICBzZWxlY3RlZE5vZGVzICs9IGFsbC5maWx0ZXIoKG5vZGUpID0+IChlZGl0b3I/LmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKSAhPT0gJ2lnbm9yZScpLmxlbmd0aDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgY291bnQ6IHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoLCB0b3RhbDogYmF0Y2hJdGVtcy5sZW5ndGgsIG5vZGVzLCBzZWxlY3RlZE5vZGVzLFxyXG4gICAgICAgIGNvbmZsaWN0czogYmF0Y2hDb25mbGljdHMoKS5zaXplID4gMCxcclxuICAgICAgICAuLi4oYmF0Y2hSZXN1bHQgPyB7IHJlc3VsdDoge1xyXG4gICAgICAgICAgICBzdWNjZXNzOiBiYXRjaFJlc3VsdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnc3VjY2VzcycpLmxlbmd0aCxcclxuICAgICAgICAgICAgZmFpbGVkOiBiYXRjaFJlc3VsdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RoLFxyXG4gICAgICAgICAgICBwZW5kaW5nOiBiYXRjaFJlc3VsdC5pdGVtcy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAncGVuZGluZycpLmxlbmd0aCxcclxuICAgICAgICAgICAgc3RvcHBlZDogYmF0Y2hSZXN1bHQuc3RvcHBlZCxcclxuICAgICAgICB9IH0gOiB7fSksXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXRjaEZvbnRzKCk6IHN0cmluZ1tdIHtcclxuICAgIHJldHVybiBiYXRjaEl0ZW1zLmxlbmd0aCA/IEFycmF5LmZyb20obmV3IFNldChzZWxlY3RlZEZyYW1lcygpLmZsYXRNYXAoKHsgaXRlbSB9KSA9PiBpdGVtLmRvY3VtZW50LmZvbnRzKSkpIDogc3RhdGUuZG9jdW1lbnQ/LmZvbnRzID8/IFtdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzeW5jQmF0Y2hJdGVtcygpOiB2b2lkIHtcclxuICAgIGNvbnN0IGl0ZW1zID0gYmF0Y2hJdGVtcy5tYXAoKHsgaXRlbSB9KSA9PiAoeyBpZDogaXRlbS5pZCwgZW5hYmxlZDogaXRlbS5lbmFibGVkIH0pKTtcclxuICAgIGNvbnN0IHByZWNlZGluZ1ByZXZpZXcgPSBwcmV2aWV3UmVhZFRhc2s7XHJcbiAgICBiYXRjaFN5bmNUYXNrID0gYmF0Y2hTeW5jVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IHByZWNlZGluZ1ByZXZpZXcuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBhd2FpdCByZXF1ZXN0KCdzeW5jLWJhdGNoLWl0ZW1zJywgaXRlbXMpO1xyXG4gICAgICAgIGJhdGNoU3luY0Vycm9yID0gdW5kZWZpbmVkO1xyXG4gICAgfSkuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgYmF0Y2hTeW5jRXJyb3IgPSBlcnJvcjtcclxuICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn55WM6Z2i5YiX6KGo5L+d5a2Y5aSx6LSl77yM6K+36YeN6K+V44CCJyksIHRydWUpO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoRWxlbWVudDxLIGV4dGVuZHMga2V5b2YgSFRNTEVsZW1lbnRUYWdOYW1lTWFwPih0YWc6IEssIHRleHQgPSAnJywgY2xhc3NOYW1lID0gJycpOiBIVE1MRWxlbWVudFRhZ05hbWVNYXBbS10ge1xyXG4gICAgY29uc3QgdmFsdWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XHJcbiAgICB2YWx1ZS50ZXh0Q29udGVudCA9IHRleHQ7XHJcbiAgICB2YWx1ZS5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJhdGNoQnV0dG9uKHRleHQ6IHN0cmluZywgYWN0aW9uOiAoKSA9PiB2b2lkLCBjbGFzc05hbWUgPSAndGV4dC1idXR0b24nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gYmF0Y2hFbGVtZW50KCdidXR0b24nLCB0ZXh0LCBjbGFzc05hbWUpO1xyXG4gICAgYnV0dG9uLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICBidXR0b24ub25jbGljayA9IGFjdGlvbjtcclxuICAgIHJldHVybiBidXR0b247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckJhdGNoKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZW5hYmxlZCA9IGJhdGNoSXRlbXMubGVuZ3RoID4gMDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1zb3VyY2UtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtZnJhbWUtcmVnaW9uJykuaGlkZGVuID0gIWVuYWJsZWQ7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LXJlZ2lvbicpLmhpZGRlbiA9ICFlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1yZWdpb24nKS5oaWRkZW4gPSAhZW5hYmxlZCB8fCAoIWJhdGNoUmVzdWx0ICYmICFiYXRjaFByb2dyZXNzKTtcclxuICAgIGNvbnN0IGdlbmVyaWNSZXZpZXcgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5yZXN1bHQtcmV2aWV3Jyk7XHJcbiAgICBpZiAoZ2VuZXJpY1JldmlldykgZ2VuZXJpY1Jldmlldy5oaWRkZW4gPSBlbmFibGVkO1xyXG4gICAgZWxlbWVudCgnI3ByZXNldC1zY29wZScpLnRleHRDb250ZW50ID0gZW5hYmxlZCA/ICfku4XkvZznlKjkuo7lvZPliY3nlYzpnaInIDogJ+S9nOeUqOS6juWFqOmDqOiKgueCuSc7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtc2VsZWN0ZWQtY291bnQnKS50ZXh0Q29udGVudCA9IGDlt7LpgIkgJHtzZWxlY3RlZEZyYW1lcygpLmxlbmd0aH0gLyAke2JhdGNoSXRlbXMubGVuZ3RofWA7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2JhdGNoLXRvZ2dsZS1hbGwnKS50ZXh0Q29udGVudCA9IHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoID09PSBiYXRjaEl0ZW1zLmxlbmd0aCA/ICflj5bmtojlhajpgIknIDogJ+WFqOmAiSc7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2JhdGNoLXNvdXJjZS1saXN0Jyk7XHJcbiAgICBjb25zdCB0YWJzID0gZWxlbWVudCgnI2JhdGNoLWZyYW1lLXRhYnMnKTtcclxuICAgIGNvbnN0IHRhcmdldHMgPSBlbGVtZW50KCcjYmF0Y2gtdGFyZ2V0LWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7IHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7IHRhcmdldHMucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBjb25mbGljdHMgPSBiYXRjaENvbmZsaWN0cygpO1xyXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBiYXRjaEl0ZW1zKSB7XHJcbiAgICAgICAgY29uc3QgeyBpdGVtIH0gPSBlbnRyeTtcclxuICAgICAgICBjb25zdCByb3cgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCBgYmF0Y2gtaXRlbSR7aXRlbS5lbmFibGVkID8gJycgOiAnIGlzLWRpc2FibGVkJ31gKTtcclxuICAgICAgICBjb25zdCBjaGVja2VkID0gYmF0Y2hFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgICAgIGNoZWNrZWQudHlwZSA9ICdjaGVja2JveCc7IGNoZWNrZWQuY2hlY2tlZCA9IGl0ZW0uZW5hYmxlZDsgY2hlY2tlZC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3k7XHJcbiAgICAgICAgY2hlY2tlZC5kYXRhc2V0LmJhdGNoQ2hlY2tlZCA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgY2hlY2tlZC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBg5a+85YWlICR7ZnJhbWVOYW1lKGVudHJ5KX1gKTtcclxuICAgICAgICBjaGVja2VkLm9uY2hhbmdlID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgICAgICBpdGVtLmVuYWJsZWQgPSBjaGVja2VkLmNoZWNrZWQ7XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7XHJcbiAgICAgICAgICAgIHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgICAgICAgICBpZiAoYWN0aXZlQmF0Y2hJZCA9PT0gaXRlbS5pZCAmJiAhaXRlbS5lbmFibGVkICYmIHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSB2b2lkIGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWRGcmFtZXMoKVswXS5pdGVtLmlkKTtcclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IGNvcHkgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1jb3B5Jyk7XHJcbiAgICAgICAgY29uc3QgdGl0bGUgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS10aXRsZScpO1xyXG4gICAgICAgIHRpdGxlLmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBmcmFtZU5hbWUoZW50cnkpKSwgYmF0Y2hFbGVtZW50KCdzcGFuJywgZW50cnkuY29uZmlndXJlZCA/ICflt7LphY3nva4nIDogJ+aZuuiDvem7mOiupCcsIGBiYWRnZSR7ZW50cnkuY29uZmlndXJlZCA/ICcnIDogJyBzdWJ0bGUnfWApKTtcclxuICAgICAgICBpZiAoY29uZmxpY3RzLmhhcyhpdGVtLmlkKSkgdGl0bGUuYXBwZW5kKGJhdGNoRWxlbWVudCgnc3BhbicsICflkI3np7DlhrLnqoEnLCAnYmF0Y2gtc3RhdHVzLWZhaWxlZCcpKTtcclxuICAgICAgICBjb3B5LmFwcGVuZCh0aXRsZSwgYmF0Y2hFbGVtZW50KCdkaXYnLCBgJHtpdGVtLnNlY3Rpb25OYW1lID8gYCR7aXRlbS5zZWN0aW9uTmFtZX0gLyBgIDogJyd9JHtpdGVtLmRvY3VtZW50LmZpbGVOYW1lfSDCtyAke2ZsYXR0ZW4oaXRlbS5kb2N1bWVudC50cmVlKS5sZW5ndGh9IOiKgueCuWAsICdiYXRjaC1pdGVtLW1ldGEnKSk7XHJcbiAgICAgICAgY29uc3QgYWN0aW9ucyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWFjdGlvbnMnKTtcclxuICAgICAgICBjb25zdCBjb25maWd1cmUgPSBiYXRjaEJ1dHRvbign6LCD5pW06IqC54K5JywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoIWl0ZW0uZW5hYmxlZCkgeyBpdGVtLmVuYWJsZWQgPSB0cnVlOyBzeW5jQmF0Y2hJdGVtcygpOyB9XHJcbiAgICAgICAgICAgIHZvaWQgYWN0aXZhdGVGcmFtZShpdGVtLmlkLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBjb25maWd1cmUuZGF0YXNldC5iYXRjaENvbmZpZ3VyZSA9IGl0ZW0uaWQ7XHJcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gYmF0Y2hCdXR0b24oJ8OXJywgKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgICAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICAgICAgICAgIGJhdGNoSXRlbXMgPSBiYXRjaEl0ZW1zLmZpbHRlcigoY2FuZGlkYXRlKSA9PiBjYW5kaWRhdGUuaXRlbS5pZCAhPT0gaXRlbS5pZCk7XHJcbiAgICAgICAgICAgIGlmIChhY3RpdmVCYXRjaElkID09PSBpdGVtLmlkKSB7XHJcbiAgICAgICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICAgICAgaWYgKHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoKSB2b2lkIGFjdGl2YXRlRnJhbWUoc2VsZWN0ZWRGcmFtZXMoKVswXS5pdGVtLmlkKTtcclxuICAgICAgICAgICAgICAgIGVsc2UgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB2b2lkIGFjdGl2YXRlRnJhbWUoYmF0Y2hJdGVtc1swXS5pdGVtLmlkKTtcclxuICAgICAgICAgICAgICAgIGVsc2UgeyBzdGF0ZS5kb2N1bWVudCA9IG51bGw7IHJlbmRlclRyZWUoKTsgd29ya2Zsb3c/LmJhdGNoUmVhZHkoKTsgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7IHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgICAgIH0sICdpY29uLWJ1dHRvbicpO1xyXG4gICAgICAgIHJlbW92ZS5kYXRhc2V0LmJhdGNoUmVtb3ZlID0gaXRlbS5pZDsgcmVtb3ZlLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGDnp7vpmaQgJHtmcmFtZU5hbWUoZW50cnkpfWApO1xyXG4gICAgICAgIGFjdGlvbnMuYXBwZW5kKGNvbmZpZ3VyZSwgcmVtb3ZlKTsgcm93LmFwcGVuZChjaGVja2VkLCBjb3B5LCBhY3Rpb25zKTsgbGlzdC5hcHBlbmQocm93KTtcclxuICAgICAgICBpZiAoIWl0ZW0uZW5hYmxlZCkgY29udGludWU7XHJcbiAgICAgICAgY29uc3QgdGFiID0gYmF0Y2hCdXR0b24oJycsICgpID0+IHsgdm9pZCBhY3RpdmF0ZUZyYW1lKGl0ZW0uaWQpOyB9LCAnYmF0Y2gtZnJhbWUtdGFiJyk7XHJcbiAgICAgICAgdGFiLmRhdGFzZXQuYmF0Y2hGcmFtZSA9IGl0ZW0uaWQ7IHRhYi5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndGFiJyk7IHRhYi5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLCBTdHJpbmcoYWN0aXZlQmF0Y2hJZCA9PT0gaXRlbS5pZCkpO1xyXG4gICAgICAgIHRhYi5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzdHJvbmcnLCBmcmFtZU5hbWUoZW50cnkpKSwgYmF0Y2hFbGVtZW50KCdzbWFsbCcsIGVudHJ5LmNvbmZpZ3VyZWQgPyAn5bey6YWN572uIMK3IOiHquWKqOS/neeVmScgOiAn5pm66IO96buY6K6kJykpO1xyXG4gICAgICAgIHRhYnMuYXBwZW5kKHRhYik7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYmF0Y2hFbGVtZW50KCdsYWJlbCcsICcnLCBgYmF0Y2gtdGFyZ2V0LXJvdyR7Y29uZmxpY3RzLmhhcyhpdGVtLmlkKSA/ICcgaXMtY29uZmxpY3QnIDogJyd9YCk7XHJcbiAgICAgICAgdGFyZ2V0LmFwcGVuZChiYXRjaEVsZW1lbnQoJ3NwYW4nLCBpdGVtLm5hbWUpKTtcclxuICAgICAgICBjb25zdCBuYW1lID0gYmF0Y2hFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgICAgIG5hbWUudHlwZSA9ICd0ZXh0JzsgbmFtZS52YWx1ZSA9IGZyYW1lTmFtZShlbnRyeSk7IG5hbWUuZGlzYWJsZWQgPSBzdGF0ZS5idXN5OyBuYW1lLmRhdGFzZXQuYmF0Y2hOYW1lID0gaXRlbS5pZDtcclxuICAgICAgICBuYW1lLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke2l0ZW0ubmFtZX0g55qEIFByZWZhYiDlkI3np7BgKTtcclxuICAgICAgICBuYW1lLnRpdGxlID0gYGFzc2V0cy8ke2VsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWV9LyR7c2FuaXRpemVBc3NldE5hbWUoZnJhbWVOYW1lKGVudHJ5KSl9LnByZWZhYmA7XHJcbiAgICAgICAgbmFtZS5vbmNoYW5nZSA9ICgpID0+IHsgdm9pZCByZW5hbWVGcmFtZShlbnRyeSwgbmFtZS52YWx1ZSk7IH07XHJcbiAgICAgICAgdGFyZ2V0LmFwcGVuZChuYW1lKTsgdGFyZ2V0cy5hcHBlbmQodGFyZ2V0KTtcclxuICAgIH1cclxuICAgIGNvbnN0IGFjdGl2ZSA9IGJhdGNoSXRlbXMuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpO1xyXG4gICAgZWxlbWVudCgnI2JhdGNoLWFjdGl2ZS1uYW1lJykudGV4dENvbnRlbnQgPSBhY3RpdmUgPyBg5q2j5Zyo6LCD5pW077yaJHtmcmFtZU5hbWUoYWN0aXZlKX1gIDogJ+mAieaLqeS4gOS4queVjOmdouW8gOWni+iwg+aVtCc7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtYWN0aXZlLXN0YXR1cycpLnRleHRDb250ZW50ID0gYWN0aXZlPy5jb25maWd1cmVkID8gJ+S/ruaUueW3suS/neeVmScgOiAn5rK/55So5pm66IO96buY6K6kJztcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1jb25mbGljdHMnKS5oaWRkZW4gPSBjb25mbGljdHMuc2l6ZSA9PT0gMDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1jb25mbGljdHMnKS50ZXh0Q29udGVudCA9IGDmnIkgJHtjb25mbGljdHMuc2l6ZX0g5Liq55WM6Z2i55qEIFByZWZhYiDmlofku7blkI3ph43lpI3vvIjlv73nlaXlpKflsI/lhpnvvInjgILor7fmlLnlkI3lkI7lvIDlp4vlr7zlhaXjgIJgO1xyXG4gICAgcmVuZGVyQmF0Y2hSZXN1bHRzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckJhdGNoUmVzdWx0cygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHJvd3MgPSBiYXRjaFByb2dyZXNzPy5pdGVtcyA/PyBiYXRjaFJlc3VsdD8uaXRlbXMgPz8gW107XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2JhdGNoLXJlc3VsdC1saXN0Jyk7IGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2Ygcm93cykge1xyXG4gICAgICAgIGNvbnN0IHJvdyA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtJyk7XHJcbiAgICAgICAgY29uc3QgY29weSA9IGJhdGNoRWxlbWVudCgnZGl2JywgJycsICdiYXRjaC1pdGVtLWNvcHknKTtcclxuICAgICAgICBjb3B5LmFwcGVuZChiYXRjaEVsZW1lbnQoJ2RpdicsIGl0ZW0ubmFtZSwgJ2JhdGNoLWl0ZW0tdGl0bGUnKSwgYmF0Y2hFbGVtZW50KCdkaXYnLCBpdGVtLmVycm9yID8/IGl0ZW0ucHJlZmFiVXJsID8/IGl0ZW0ud2FybmluZ3M/LmpvaW4oJ++8mycpID8/IChpdGVtLnN0YXR1cyA9PT0gJ3BlbmRpbmcnID8gJ+etieW+hee7p+e7reWvvOWFpScgOiAnJyksICdiYXRjaC1pdGVtLW1ldGEnKSk7XHJcbiAgICAgICAgY29uc3Qgc3RhdHVzID0geyBwZW5kaW5nOiAn5pyq5a6M5oiQJywgcnVubmluZzogJ+ato+WcqOWvvOWFpScsIHN1Y2Nlc3M6ICflt7LlrozmiJAnLCBmYWlsZWQ6ICflpLHotKUnIH1baXRlbS5zdGF0dXNdO1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbnMgPSBiYXRjaEVsZW1lbnQoJ2RpdicsICcnLCAnYmF0Y2gtaXRlbS1hY3Rpb25zJyk7XHJcbiAgICAgICAgYWN0aW9ucy5hcHBlbmQoYmF0Y2hFbGVtZW50KCdzcGFuJywgc3RhdHVzLCBgYmF0Y2gtc3RhdHVzLSR7aXRlbS5zdGF0dXN9YCkpO1xyXG4gICAgICAgIGlmIChpdGVtLnJldmlld0lkIHx8IGl0ZW0ucmV2aWV3KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJldmlldyA9IGJhdGNoQnV0dG9uKCfmo4Dmn6Xnu5PmnpwnLCAoKSA9PiB7IHZvaWQgb3BlbkJhdGNoUmV2aWV3KGl0ZW0pOyB9KTtcclxuICAgICAgICAgICAgcmV2aWV3LmRhdGFzZXQuYmF0Y2hSZXZpZXcgPSBpdGVtLmlkOyBhY3Rpb25zLmFwcGVuZChyZXZpZXcpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByb3cuYXBwZW5kKGNvcHksIGFjdGlvbnMpOyBsaXN0LmFwcGVuZChyb3cpO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc3VjY2VzcyA9IHJvd3MuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGg7XHJcbiAgICBjb25zdCBmYWlsZWQgPSByb3dzLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdmYWlsZWQnKS5sZW5ndGg7XHJcbiAgICBjb25zdCBwZW5kaW5nID0gcm93cy5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAncGVuZGluZycpLmxlbmd0aDtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1yZXN1bHQtY291bnQnKS50ZXh0Q29udGVudCA9IGAke3N1Y2Nlc3N9IC8gJHtyb3dzLmxlbmd0aH0g5bey5a6M5oiQYDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjYmF0Y2gtcmV0cnktZmFpbGVkJykuaGlkZGVuID0gIWZhaWxlZCB8fCBzdGF0ZS5idXN5O1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNiYXRjaC1yZXN1bWUtcGVuZGluZycpLmhpZGRlbiA9ICFwZW5kaW5nIHx8IHN0YXRlLmJ1c3k7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHJvd3Muc29tZSgoaXRlbSkgPT4gaXRlbS5yZXF1aXJlc0F0dGVudGlvbilcclxuICAgICAgICA/ICfpg6jliIbpobnnmoTkv53lrZjnirbmgIHpnIDopoHmo4Dmn6XjgILor7flhYjlnKggQ29jb3Mg56Gu6K6k5b2T5YmN55uu5qCH5LiO5L+d5a2Y54q25oCB77yM5YaN6YeN6K+V5oiW57un57ut44CCJ1xyXG4gICAgICAgIDogJ+eCueWHu+avj+S4gOmhueeahOKAnOajgOafpee7k+aenOKAneafpeeci+WvueW6lOaKpeWRiu+8m+mHjeivleWSjOe7p+e7reS8mui3s+i/h+W3suWujOaIkOmhueOAgic7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG9wZW5CYXRjaFJldmlldyhpdGVtOiBCYXRjaEltcG9ydEl0ZW1SZXN1bHQpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlld0lkID0gaXRlbS5yZXZpZXdJZCA/PyBpdGVtLnJldmlldz8uaWQ7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcmV2aWV3SWQgPyBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycsIHJldmlld0lkKSA6IG51bGw7XHJcbiAgICAgICAgaWYgKCFyZXZpZXcpIHRocm93IG5ldyBFcnJvcign6K+l6aG55qOA5p+l5oql5ZGK5bey6L+H5pyf77yM6K+36YeN5paw5a+85YWl5ZCO5p+l55yL44CCJyk7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7IHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfor7vlj5bmo4Dmn6Xnu5PmnpzlpLHotKXjgIInKSwgdHJ1ZSk7IH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gYWN0aXZhdGVGcmFtZShpZDogc3RyaW5nLCBuYXZpZ2F0ZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgY29uc3QgZW50cnkgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBpZCk7XHJcbiAgICBpZiAoIWVudHJ5KSByZXR1cm47XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2hJZCA9PT0gaWQgJiYgc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICBpZiAobmF2aWdhdGUpIHdvcmtmbG93Py5uYXZpZ2F0ZSgyKTtcclxuICAgICAgICByZW5kZXJCYXRjaCgpOyB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICAgICAgaWYgKG5hdmlnYXRlICYmIHN0YXRlLnNlbGVjdGVkSWQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKTsgaWYgKHNlbGVjdGVkKSB2b2lkIHByZXZpZXcoc2VsZWN0ZWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBvbGRJZCA9IGFjdGl2ZUJhdGNoSWQ7XHJcbiAgICBjb25zdCBvbGRFZGl0b3IgPSBlZGl0b3JTbmFwc2hvdCgpO1xyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpOyBpZiAoc2V0dGluZ3MpIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICBwcmV2aWV3UmV2aXNpb24rKztcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGJhdGNoU3luY1Rhc2s7XHJcbiAgICAgICAgYXdhaXQgcHJldmlld1JlYWRUYXNrLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgaWYgKGJhdGNoU3luY0Vycm9yKSB0aHJvdyBiYXRjaFN5bmNFcnJvcjtcclxuICAgICAgICBjb25zdCBsb2FkZWQgPSBhd2FpdCByZXF1ZXN0PERvY3VtZW50RHRvPignYWN0aXZhdGUtYmF0Y2gtaXRlbScsIGlkKTtcclxuICAgICAgICBhY3RpdmVCYXRjaElkID0gaWQ7XHJcbiAgICAgICAgaWYgKGVudHJ5LmVkaXRvcikgT2JqZWN0LmFzc2lnbihzdGF0ZSwgZW50cnkuZWRpdG9yKTtcclxuICAgICAgICBlbHNlIGluaXRpYWxpemVEb2N1bWVudChsb2FkZWQgPz8gZW50cnkuaXRlbS5kb2N1bWVudCwgZmFsc2UpO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN0cmVlLXNlYXJjaCcpLnZhbHVlID0gc3RhdGUuc2VhcmNoO1xyXG4gICAgICAgIGVsZW1lbnQoJyNmaWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IHN0YXRlLmRvY3VtZW50Py5maWxlTmFtZSA/PyAnJztcclxuICAgICAgICBlbGVtZW50KCcjcHJldmlldy1zdGFnZScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hhcy1pbWFnZScsICdpcy1sb2FkaW5nJyk7XHJcbiAgICAgICAgZWxlbWVudCgnI3ByZXZpZXctaW1hZ2UnKS5yZW1vdmVBdHRyaWJ1dGUoJ3NyYycpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNwcmV2aWV3LW1ldGEnKS50ZXh0Q29udGVudCA9ICfpgInmi6noioLngrnmn6XnnIvpooTop4gnO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICBlbGVtZW50KCcjdHJlZScpLnNjcm9sbFRvcCA9IGVudHJ5LmVkaXRvcj8udHJlZVNjcm9sbCA/PyAwO1xyXG4gICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gKGVudHJ5LmVkaXRvcj8ucHJlc2V0ID8/ICdzbWFydCcpKSk7XHJcbiAgICAgICAgcmVuZGVyRm9udE1hcCgpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBhY3RpdmVCYXRjaElkID0gb2xkSWQ7IE9iamVjdC5hc3NpZ24oc3RhdGUsIG9sZEVkaXRvcik7XHJcbiAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+WIh+aNoueVjOmdouWksei0pe+8jOivt+mHjeivleOAgicpLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7IHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICBpZiAobmF2aWdhdGUgJiYgYWN0aXZlQmF0Y2hJZCA9PT0gaWQpIHdvcmtmbG93Py5uYXZpZ2F0ZSgyKTtcclxuICAgICAgICBpZiAoYWN0aXZlQmF0Y2hJZCA9PT0gaWQgJiYgd29ya2Zsb3c/LnN0ZXAgPT09IDIgJiYgc3RhdGUuc2VsZWN0ZWRJZCkge1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGZpbmROb2RlKHN0YXRlLnNlbGVjdGVkSWQpOyBpZiAoc2VsZWN0ZWQpIHZvaWQgcHJldmlldyhzZWxlY3RlZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiByZW5hbWVGcmFtZShlbnRyeTogRnJhbWVFZGl0b3JJdGVtLCB2YWx1ZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgY29uc3QgbmFtZSA9IHNhbml0aXplTm9kZU5hbWUodmFsdWUpO1xyXG4gICAgaWYgKCFuYW1lKSB7IHNob3dUb2FzdCgnUHJlZmFiIOWQjeensOS4jeiDveS4uuepuuOAgicsIHRydWUpOyByZW5kZXJCYXRjaCgpOyByZXR1cm47IH1cclxuICAgIGF3YWl0IGFjdGl2YXRlRnJhbWUoZW50cnkuaXRlbS5pZCk7XHJcbiAgICBpZiAoYWN0aXZlQmF0Y2hJZCAhPT0gZW50cnkuaXRlbS5pZCkgcmV0dXJuO1xyXG4gICAgc3RhdGUubmFtZXMuc2V0KGVudHJ5Lml0ZW0ucm9vdElkLCBuYW1lKTtcclxuICAgIGlmIChuYW1lID09PSBlbnRyeS5pdGVtLm5hbWUpIHN0YXRlLnJlbmFtZWRJZHMuZGVsZXRlKGVudHJ5Lml0ZW0ucm9vdElkKTsgZWxzZSBzdGF0ZS5yZW5hbWVkSWRzLmFkZChlbnRyeS5pdGVtLnJvb3RJZCk7XHJcbiAgICBlbnRyeS5jb25maWd1cmVkID0gdHJ1ZTtcclxuICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyVHJlZSgpOyByZW5kZXJCYXRjaCgpOyB1cGRhdGVTdW1tYXJ5KCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvb3QoKTogSFRNTEVsZW1lbnQge1xyXG4gICAgcmV0dXJuIHBhbmVsSG9zdC4kLmFwcCBhcyBIVE1MRWxlbWVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gZWxlbWVudDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQ+KHNlbGVjdG9yOiBzdHJpbmcpOiBUIHtcclxuICAgIGNvbnN0IHZhbHVlID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpO1xyXG4gICAgaWYgKCF2YWx1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUGFuZWwgZWxlbWVudCBub3QgZm91bmQ6ICR7c2VsZWN0b3J9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlcXVlc3Q8VD4obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pOiBQcm9taXNlPFQ+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KHBhY2thZ2VKU09OLm5hbWUsIG1lc3NhZ2UsIC4uLmFyZ3MpIGFzIFQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNob3dUb2FzdChtZXNzYWdlOiBzdHJpbmcsIGVycm9yID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRvYXN0ID0gZWxlbWVudDxIVE1MRGl2RWxlbWVudD4oJyN0b2FzdCcpO1xyXG4gICAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7XHJcbiAgICBjb25zdCBjcmVkZW50aWFsRGlhbG9nID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8SFRNTERpYWxvZ0VsZW1lbnQ+KCcjY3JlZGVudGlhbC1kaWFsb2cnKTtcclxuICAgIGNvbnN0IGNyZWRlbnRpYWxTdGF0dXMgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJyNjcmVkZW50aWFsLXN0YXR1cycpO1xyXG4gICAgaWYgKGNyZWRlbnRpYWxEaWFsb2c/Lm9wZW4gJiYgY3JlZGVudGlhbFN0YXR1cykge1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMuaGlkZGVuID0gZmFsc2U7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIH1cclxuICAgIGlmICh0b2FzdFRpbWVyKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRvYXN0VGltZXIpO1xyXG4gICAgfVxyXG4gICAgdG9hc3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3QuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpLCAzNDAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duLCBmYWxsYmFjazogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIGVycm9yLm1lc3NhZ2UpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3IubWVzc2FnZTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnICYmIGVycm9yLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvcjtcclxuICAgIH1cclxuICAgIGlmIChlcnJvciAmJiB0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnICYmICdtZXNzYWdlJyBpbiBlcnJvclxyXG4gICAgICAgICYmIHR5cGVvZiAoZXJyb3IgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9KS5tZXNzYWdlID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIHJldHVybiAoZXJyb3IgYXMgeyBtZXNzYWdlOiBzdHJpbmcgfSkubWVzc2FnZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxsYmFjaztcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0Q29ubmVjdGlvbih2YXVsdDoge1xyXG4gICAgaGFzVG9rZW46IGJvb2xlYW47XHJcbiAgICBwZXJzaXN0ZW50OiBib29sZWFuO1xyXG4gICAgYmFja2VuZDogc3RyaW5nO1xyXG4gICAgd2FybmluZz86IHN0cmluZztcclxufSk6IHZvaWQge1xyXG4gICAgY29uc3QgcGlsbCA9IGVsZW1lbnQoJyNjb25uZWN0aW9uLXBpbGwnKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb25saW5lJywgdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vZmZsaW5lJywgIXZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIGVsZW1lbnQoJyNjb25uZWN0aW9uLWxhYmVsJykudGV4dENvbnRlbnQgPSB2YXVsdC5oYXNUb2tlbiA/ICflh63mja7lsLHnu6onIDogJ+acqui/nuaOpSc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtYmFkZ2UnKS50ZXh0Q29udGVudCA9IHZhdWx0LnBlcnNpc3RlbnQgPyAn57O757uf5Yqg5a+GJyA6ICfkvJror53lrZjlgqgnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHZhdWx0Lndhcm5pbmdcclxuICAgICAgICA/PyAodmF1bHQucGVyc2lzdGVudCA/IGDnlLEgJHt2YXVsdC5iYWNrZW5kfSDliqDlr4bvvIzpobnnm67kuK3ku4Xkv53lrZjpnZ7mlY/mhJ/orr7nva5gIDogJ1Rva2VuIOS4jeWGmeWFpemhueebruaWh+S7ticpO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjdmVyaWZ5LXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjY2xlYXItdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbiAgICB3b3JrZmxvdz8uc2V0Q29ubmVjdGlvbih2YXVsdC5oYXNUb2tlbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW4obm9kZXM6IFRyZWVOb2RlRHRvW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2Rlcy5mbGF0TWFwKChub2RlKSA9PiBbbm9kZSwgLi4uZmxhdHRlbihub2RlLmNoaWxkcmVuKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kTm9kZShpZDogc3RyaW5nLCBub2RlcyA9IHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdKTogVHJlZU5vZGVEdG8gfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuaWQgPT09IGlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZCA9IGZpbmROb2RlKGlkLCBub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICBpZiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckZvbnRNYXAoKTogdm9pZCB7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBmYW1pbGllcyA9IGJhdGNoRm9udHMoKTtcclxuICAgIGlmICghZmFtaWxpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDlkI7vvIzov5nph4zkvJrliJflh7rmo4DmtYvliLDnmoTlrZfkvZPjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZm9udEFzc2V0cy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSBpcy13YXJuaW5nJztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfpobnnm64gYXNzZXRzIOWGheayoeacieajgOa1i+WIsCAudHRmIC8gLm90ZiAvIC5mbnQgLyAud29mZiDlrZfkvZPotYTmupDjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBmYW1pbHkgb2YgZmFtaWxpZXMpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICByb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXJvdyc7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIHNvdXJjZS5jbGFzc05hbWUgPSAnZm9udC1tYXAtc291cmNlJztcclxuICAgICAgICBzb3VyY2UudGV4dENvbnRlbnQgPSBmYW1pbHk7XHJcbiAgICAgICAgc291cmNlLnRpdGxlID0gZmFtaWx5O1xyXG4gICAgICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIGFycm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1hcnJvdyc7XHJcbiAgICAgICAgYXJyb3cudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgICAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgICAgICBzZWxlY3QuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNlbGVjdCc7XHJcbiAgICAgICAgc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseSA9IGZhbWlseTtcclxuICAgICAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7ZmFtaWx5fSDmmKDlsITlrZfkvZNgKTtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKCcnLCAn5LiN5pig5bCE77yI5L2/55So6buY6K6k5a2X5L2T77yJJykpO1xyXG4gICAgICAgIGNvbnN0IGF1dG9tYXRpYyA9IGZpbmRGb250QXNzZXQoZmFtaWx5LCBzdGF0ZS5mb250QXNzZXRzKTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHN0YXRlLnNldHRpbmdzLmZvbnRNYXBbZmFtaWx5XSA/PyBhdXRvbWF0aWM/LnVybCA/PyAnJztcclxuICAgICAgICBmb3IgKGNvbnN0IGFzc2V0IG9mIHN0YXRlLmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IG9wdGlvbihhc3NldC51cmwsIGAke2Fzc2V0Lm5hbWV9IMK3ICR7YXNzZXQucmVsYXRpdmVQYXRofWApO1xyXG4gICAgICAgICAgICBpdGVtLnNlbGVjdGVkID0gYXNzZXQudXJsID09PSBzZWxlY3RlZDtcclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGl0ZW0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZWxlY3QudmFsdWUgPSBzZWxlY3RlZDtcclxuICAgICAgICByb3cuYXBwZW5kKHNvdXJjZSwgYXJyb3csIHNlbGVjdCk7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlQWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IHVua25vd24pOiBJbXBvcnRBY3Rpb24ge1xyXG4gICAgcmV0dXJuIG5vcm1hbGl6ZUZpZ21hU2xpY2VEZWNpc2lvbih7IGFjdGlvbjogbm9ybWFsaXplSW1wb3J0QWN0aW9uKGFjdGlvbiksIGtpbmQ6IG5vZGUua2luZCwgbmluZVNsaWNlOiBmYWxzZSB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKS5hY3Rpb247XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXRpYWxpemVEb2N1bWVudChkb2N1bWVudDogRG9jdW1lbnREdG8sIG5hdmlnYXRlID0gdHJ1ZSk6IHZvaWQge1xyXG4gICAgc3RhdGUuZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmtpbmRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgc3RhdGUubmFtZXMuY2xlYXIoKTtcclxuICAgIHN0YXRlLnJlbmFtZWRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmRlZmF1bHRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5jb2xsYXBzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnN1cHByZXNzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBkb2N1bWVudC50cmVlWzBdPy5pZDtcclxuICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIGZsYXR0ZW4oZG9jdW1lbnQudHJlZSkpIHtcclxuICAgICAgICBjb25zdCBhY3Rpb24gPSBzbWFydEFjdGlvbkZvck5vZGUobm9kZSk7XHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgYWN0aW9uKTtcclxuICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgbm9kZS5raW5kKTtcclxuICAgICAgICBzdGF0ZS5kZWZhdWx0cy5zZXQobm9kZS5pZCwgeyBhY3Rpb24sIGtpbmQ6IG5vZGUua2luZCB9KTtcclxuICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxuICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBvdmVycmlkZSBvZiBkb2N1bWVudC5ub2RlT3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKG92ZXJyaWRlLmlkLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChjdXN0b21OYW1lICYmIGN1c3RvbU5hbWUgIT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgY3VzdG9tTmFtZSk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBvdmVycmlkZS5hY3Rpb24pKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG92ZXJyaWRlLmtpbmQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoXHJcbiAgICAgICAgICAgICdhY3RpdmUnLFxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5zaXplID09PSAwICYmIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gJ3NtYXJ0JyxcclxuICAgICAgICApO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZmlsZS1uYW1lJykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBkb2N1bWVudC5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50KCcjZm9udC1oaW50JykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5mb250cy5sZW5ndGhcclxuICAgICAgICA/IGDmo4DmtYvliLDvvJoke2RvY3VtZW50LmZvbnRzLmpvaW4oJ+OAgScpfWBcclxuICAgICAgICA6ICflvZPliY3mlofku7blsJrmnKrlj5HnjrDlrZfkvZPjgIInO1xyXG4gICAgcmVuZGVyRm9udE1hcCgpO1xyXG4gICAgcmVuZGVyVHJlZSh0cnVlKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIGlmIChuYXZpZ2F0ZSkgd29ya2Zsb3c/LmRvY3VtZW50UmVhZHkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlTZXR0aW5ncyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiB2b2lkIHtcclxuICAgIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gc2V0dGluZ3Muc291cmNlVXJsO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlID0gc2V0dGluZ3MuYXNzZXRGb2xkZXI7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlID0gc2V0dGluZ3MucHJlZmFiRm9sZGVyO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZUZvbGRlcnMgPSBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVycz8ubGVuZ3RoXHJcbiAgICAgICAgPyBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlclxyXG4gICAgICAgICAgICA/IFtzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICBpbnB1dC52YWx1ZSA9IGxvY2FsUmVzb3VyY2VGb2xkZXJzW2luZGV4XSA/PyAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9IGxvY2FsUmVzb3VyY2VGb2xkZXJzW2luZGV4XSA/PyAnJztcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlID0gU3RyaW5nKHNldHRpbmdzLnNjYWxlKTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN1cGRhdGUtZXhpc3RpbmcnKS5jaGVja2VkID0gc2V0dGluZ3MudXBkYXRlRXhpc3Rpbmc7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcmVmcmVzaC1hc3NldHMnKS5jaGVja2VkID0gc2V0dGluZ3MucmVmcmVzaEFzc2V0cztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhdXRvLXNhdmUnKS5jaGVja2VkID0gc2V0dGluZ3MuYXV0b1NhdmU7XHJcbiAgICB1cGRhdGVUYXJnZXRIaW50KCk7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlYWRTZXR0aW5ncyhzaG93RXJyb3IgPSB0cnVlKTogSW1wb3J0U2V0dGluZ3MgfCBudWxsIHtcclxuICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLnN0YXRlLnNldHRpbmdzLmZvbnRNYXAgfTtcclxuICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIGJhdGNoRm9udHMoKSkgZGVsZXRlIGZvbnRNYXBbZmFtaWx5XTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PignW2RhdGEtZm9udC1mYW1pbHldJykuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XHJcbiAgICAgICAgY29uc3QgZmFtaWx5ID0gc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseT8udHJpbSgpO1xyXG4gICAgICAgIGlmIChmYW1pbHkgJiYgc2VsZWN0LnZhbHVlKSB7XHJcbiAgICAgICAgICAgIGZvbnRNYXBbZmFtaWx5XSA9IHNlbGVjdC52YWx1ZTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHNjYWxlID0gTnVtYmVyKGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlKTtcclxuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHNjYWxlKSB8fCBzY2FsZSA8IDAuMjUgfHwgc2NhbGUgPiA0KSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+WvvOWFpeWAjeeOh+W/hemhu+WcqCAwLjI1IOWIsCA0IOS5i+mXtOOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGFzc2V0Rm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghYXNzZXRGb2xkZXIpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36YCJ5oup6aG555uuIGFzc2V0cyDkuIvnmoTotYTmupDovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmVmYWJGb2xkZXIgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghcHJlZmFiRm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemihOWItuS9k+i+k+WHuuebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgc291cmNlVXJsOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBhc3NldEZvbGRlcixcclxuICAgICAgICBwcmVmYWJGb2xkZXIsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IEFycmF5LmZyb20oeyBsZW5ndGg6IDMgfSwgKF8sIGluZGV4KSA9PlxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWUudHJpbSgpLFxyXG4gICAgICAgICksXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcjogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2xvY2FsLXJlc291cmNlLWZvbGRlci0wJykudmFsdWUudHJpbSgpLFxyXG4gICAgICAgIHNjYWxlLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdXBkYXRlLWV4aXN0aW5nJykuY2hlY2tlZCxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcmVmcmVzaC1hc3NldHMnKS5jaGVja2VkLFxyXG4gICAgICAgIGF1dG9TYXZlOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXV0by1zYXZlJykuY2hlY2tlZCxcclxuICAgICAgICBmb250TWFwLFxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QnVzeSh2YWx1ZTogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgdmFsdWUgPSB2YWx1ZSB8fCBCb29sZWFuKHdvcmtmbG93Py5wZW5kaW5nKTtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIC8vIENhcHR1cmUgZWRpdGFibGUgY29udHJvbCBzdGF0ZXMgYmVmb3JlIHRoZSBleGlzdGluZyBidXR0b24gbG9jayBjaGFuZ2VzIHRoZW0uXHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjc2F2ZS10b2tlbicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stYXNzZXQtZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1wcmVmYWItZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWRldGVjdCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZSA9PT0gJyc7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWhpZGRlbicsICF2YWx1ZSk7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbiAgICBpZiAoIXZhbHVlKSByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNldFJvdW5kdHJpcFRva2VucygpOiB2b2lkIHtcclxuICAgIHJvdW5kdHJpcFByZXZpZXdUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHVuZGVmaW5lZDtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHRydWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcm91bmR0cmlwU291cmNlKCk6IHN0cmluZyB8IG51bGwge1xyXG4gICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXNvdXJjZSkge1xyXG4gICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIOaWh+S7tuaIluiKgueCuemTvuaOpeOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNvdXJjZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyUm91bmR0cmlwUHJldmlldyhwcmV2aWV3OiBSb3VuZHRyaXBQcmV2aWV3RHRvKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSBwcmV2aWV3LnByZXZpZXdUb2tlbjtcclxuICAgIHJvdW5kdHJpcFBhaXJUb2tlbiA9IHByZXZpZXcucGFpclRva2VuO1xyXG4gICAgY29uc3QgbGluZXMgPSBbXHJcbiAgICAgICAgYOebruagh++8miR7cHJldmlldy5hc3NldFVybH1gLFxyXG4gICAgICAgIGBQcmVmYWLvvJoke3ByZXZpZXcucHJlZmFiVXVpZH1gLFxyXG4gICAgICAgIGBTdXJmYWNl77yaJHtwcmV2aWV3LnN1cmZhY2VJZH0gwrcgRmlnbWEgJHtwcmV2aWV3LmZpZ21hVmVyc2lvbn0gwrcgTGVkZ2VyICR7cHJldmlldy5sZWRnZXJHZW5lcmF0aW9ufWAsXHJcbiAgICAgICAgYOWwhuS/ruaUuSAke3ByZXZpZXcucGxhbi5hcHBseS5sZW5ndGh9IOmhuSDCtyDkv53nlZkgQ29jb3MgJHtwcmV2aWV3LnBsYW4ucHJlc2VydmVDb2Nvcy5sZW5ndGh9IOmhuSDCtyDlt7LmlLbmlZsgJHtwcmV2aWV3LnBsYW4uY29udmVyZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBg5Yay56qBICR7cHJldmlldy5wbGFuLmNvbmZsaWN0cy5sZW5ndGh9IOmhuSDCtyDkuI3mlK/mjIEgJHtwcmV2aWV3LnBsYW4udW5zdXBwb3J0ZWQubGVuZ3RofSDpobkgwrcg5Y+q6K+75pyq5pS5ICR7cHJldmlldy5wbGFuLnJlYWRvbmx5VW5jaGFuZ2VkLmxlbmd0aH0g6aG5YCxcclxuICAgICAgICBwcmV2aWV3LnBhaXJSZXF1aXJlZFxyXG4gICAgICAgICAgICA/IHByZXZpZXcucGFpckVsaWdpYmxlID8gJ+mmluasoeS9v+eUqO+8muivgeaNruS4gOiHtO+8jOivt+WFiOehruiupOmFjeWvuSBTdXJmYWNl77yI5Y+q5YaZIGxlZGdlcu+8jOS4jeaUuSBQcmVmYWLvvInjgIInIDogJ+mmluasoeS9v+eUqO+8mlBhaXIg6K+B5o2u5LiN5LiA6Ie077yM6ZyA5LuO5b2T5YmNIFByZWZhYiDph43mlrDlr7zlh7rjgIInXHJcbiAgICAgICAgICAgIDogcHJldmlldy5ibG9ja2Vycy5sZW5ndGggPyBg6Zi75pat77yaJHtwcmV2aWV3LmJsb2NrZXJzLmpvaW4oJywgJyl9YCA6ICfpooTop4jpgJrov4fvvIzlj6/ljp/lrZDlupTnlKjmlbTkuKrkuI3lj6/lj5jorqHliJLjgIInLFxyXG4gICAgXTtcclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gbGluZXMuam9pbignXFxuJyk7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVRhcmdldEhpbnQoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgZWxlbWVudCgnI2FjdGlvbi1ub3RlJykudGV4dENvbnRlbnQgPSAn5Li76L+b56iL5LiO6Z2i5p2/54mI5pys5LiN5LiA6Ie077yM6ZyA6KaB5a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3InO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWIsOW9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K55LiL77ybRnJhbWUg6ZO+5o6l5bCG6Ieq5Yqo5Yib5bu65bm25omT5byA6aKE5Yi25L2TJztcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRJbXBvcnRCdXR0b24oKTogdm9pZCB7XHJcbiAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgYnV0dG9uLnRpdGxlID0gJ+WvvOWFpeWIsOW9k+WJjeaJk+W8gOWcuuaZr+aIlumihOWItuS9kyc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+W8gOWni+WvvOWFpSc7XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcwJSc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGltcG9ydFByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogbnVtYmVyIHtcclxuICAgIGNvbnN0IHZhbHVlID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgZXZlbnQudmFsdWUpKTtcclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycpIHtcclxuICAgICAgICByZXR1cm4gMC4wNSArIHZhbHVlICogMC41NTtcclxuICAgIH1cclxuICAgIGlmIChldmVudC5waGFzZSA9PT0gJ3NjZW5lJykge1xyXG4gICAgICAgIHJldHVybiAwLjYgKyB2YWx1ZSAqIDAuMzg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZXZlbnQucGhhc2UgPT09ICdkb25lJyA/IDEgOiAwO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xyXG4gICAgaWYgKGV2ZW50LmJhdGNoICYmIGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IGV2ZW50LmJhdGNoO1xyXG4gICAgICAgIGNvbnN0IGN1cnJlbnRSb3cgPSBldmVudC5iYXRjaC5pdGVtcy5maW5kKChpdGVtKSA9PiBpdGVtLmlkID09PSBldmVudC5iYXRjaCEuaXRlbUlkKTtcclxuICAgICAgICBjb25zdCBjdXJyZW50ID0gY3VycmVudFJvdz8uc3RhdHVzID09PSAncnVubmluZycgPyBpbXBvcnRQcm9ncmVzcyhldmVudCkgOiAwO1xyXG4gICAgICAgIGV2ZW50ID0ge1xyXG4gICAgICAgICAgICAuLi5ldmVudCxcclxuICAgICAgICAgICAgdmFsdWU6IE1hdGgubWluKDEsIChldmVudC5iYXRjaC5jb21wbGV0ZWQgKyBjdXJyZW50KSAvIE1hdGgubWF4KDEsIGV2ZW50LmJhdGNoLnRvdGFsKSksXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6IGAke2V2ZW50LmJhdGNoLmluZGV4fSAvICR7ZXZlbnQuYmF0Y2gudG90YWx9IMK3ICR7ZXZlbnQuYmF0Y2gubmFtZX0gwrcgJHtldmVudC5tZXNzYWdlfWAsXHJcbiAgICAgICAgfTtcclxuICAgICAgICByZW5kZXJCYXRjaFJlc3VsdHMoKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkgc2V0QnVzeSh0cnVlKTtcclxuICAgIHdvcmtmbG93Py5wcm9ncmVzcyhldmVudCk7XHJcbiAgICBjb25zdCByZWdpb24gPSBlbGVtZW50KCcjcHJvZ3Jlc3MtcmVnaW9uJyk7XHJcbiAgICBjb25zdCBidXN5ID0gWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtYnVzeScsIGJ1c3kpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWVycm9yJywgZXZlbnQucGhhc2UgPT09ICdlcnJvcicpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQodmFsdWUgKiAxMDApfSVgO1xyXG4gICAgKGVsZW1lbnQoJyNwcm9ncmVzcy1iYXInKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHt2YWx1ZSAqIDEwMH0lYDtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgY29uc3QgaW1wb3J0aW5nID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnO1xyXG4gICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcik7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoaW1wb3J0aW5nKSB7XHJcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBldmVudC5iYXRjaCA/IHZhbHVlIDogaW1wb3J0UHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1ydW5uaW5nJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXN1Y2Nlc3MnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uc2V0QXR0cmlidXRlKCdhcmlhLWJ1c3knLCAndHJ1ZScpO1xyXG4gICAgICAgIGJ1dHRvbi50aXRsZSA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJyA/ICflh4blpIfotYTmupAnIDogJ+aehOW7uuiKgueCuSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZChwcm9ncmVzcyAqIDEwMCl9JWA7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gYCR7cHJvZ3Jlc3MgKiAxMDB9JWA7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXlrozmiJAnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICcxMDAlJztcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMTAwJSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE0MDApO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2Vycm9yJyB8fCBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcpIHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJyA/ICflt7Llj5bmtognIDogJ+WvvOWFpeWksei0pSc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+mHjeivlSc7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IHNldFRpbWVvdXQocmVzZXRJbXBvcnRCdXR0b24sIDE4MDApO1xyXG4gICAgfVxyXG4gICAgaWYgKFsnZG9uZScsICdlcnJvcicsICdjYW5jZWxsZWQnLCAnaWRsZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnZG9uZScgJiYgIXdvcmtmbG93Py5wZW5kaW5nICYmIHBlbmRpbmdJbXBvcnRSZXZpZXcpIHtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSBwZW5kaW5nSW1wb3J0UmV2aWV3O1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LmJhdGNoPy5yZXN1bHQgJiYgIWJhdGNoSW1wb3J0UGVuZGluZyAmJiBiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgIGlmIChiYXRjaFJlY292ZXJ5VGltZXIpIGNsZWFyVGltZW91dChiYXRjaFJlY292ZXJ5VGltZXIpO1xyXG4gICAgICAgIHdvcmtmbG93Py5lbmQoKTsgc2V0QnVzeShmYWxzZSk7IGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oZXZlbnQuYmF0Y2gucmVzdWx0KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10pO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLFxyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMsXHJcbiAgICApO1xyXG4gICAgc3RhdGUuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zO1xyXG4gICAgc3RhdGUuc3VwcHJlc3NlZCA9IGVmZmVjdGl2ZS5zdXBwcmVzc2VkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRBY3Rpb24obm9kZTogVHJlZU5vZGVEdG8sIGFjdGlvbjogSW1wb3J0QWN0aW9uKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBzYWZlQWN0aW9uKG5vZGUsIGFjdGlvbikpO1xyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlZmZlY3RpdmVOb2RlTmFtZShub2RlOiBUcmVlTm9kZUR0byk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc3RhdGUubmFtZXMuZ2V0KG5vZGUuaWQpID8/IG5vZGUubmFtZTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXhwbGljaXRPdmVycmlkZXMoKTogSW1wb3J0T3ZlcnJpZGVbXSB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSlcclxuICAgICAgICAuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkgfHwgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkpXHJcbiAgICAgICAgLm1hcCgobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCByZW5hbWVkID0gc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIHJldHVybiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgICAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIC4uLihyZW5hbWVkID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgICAgICAgICB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdE5vZGVPdmVycmlkZXMoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUtleSA9IHN0YXRlLmRvY3VtZW50LmZpbGVLZXk7XHJcbiAgICBjb25zdCBhY3RpdmUgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKTtcclxuICAgIGlmIChhY3RpdmUpIHsgYWN0aXZlLmNvbmZpZ3VyZWQgPSB0cnVlOyByZW1lbWJlckFjdGl2ZUZyYW1lKCk7IHJlbmRlckJhdGNoKCk7IH1cclxuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGV4cGxpY2l0T3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub2RlLmlkKTtcclxuICAgIC8vIFNlcmlhbGl6ZSB3cml0ZXMgc28gYSBzbG93ZXIgZWFybGllciByZXF1ZXN0IGNhbiBuZXZlciBvdmVyd3JpdGUgYSBuZXdlclxyXG4gICAgLy8gc3RyYXRlZ3kgc25hcHNob3QgYWZ0ZXIgcmFwaWQgc2VsZWN0IGNoYW5nZXMuXHJcbiAgICBub2RlT3ZlcnJpZGVTYXZlVGFzayA9IG5vZGVPdmVycmlkZVNhdmVUYXNrXHJcbiAgICAgICAgLmNhdGNoKCgpID0+IHVuZGVmaW5lZClcclxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3Q8SW1wb3J0T3ZlcnJpZGVbXT4oJ3NhdmUtbm9kZS1vdmVycmlkZXMnLCBmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+iKgueCueetlueVpeS/neWtmOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF0Y2hlcyhub2RlOiBUcmVlTm9kZUR0byk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhheXN0YWNrID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9ICR7bm9kZS5uYW1lfSAke25vZGUudHlwZX0gJHtub2RlLmlkfWAudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChoYXlzdGFjay5pbmNsdWRlcyhzdGF0ZS5zZWFyY2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKG1hdGNoZXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb24odmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEhUTUxPcHRpb25FbGVtZW50IHtcclxuICAgIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgIGl0ZW0udmFsdWUgPSB2YWx1ZTtcclxuICAgIGl0ZW0udGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYWtlU2VsZWN0KFxyXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogc3RyaW5nLFxyXG4gICAgaXRlbXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+LFxyXG4gICAgbGFiZWw6IHN0cmluZyxcclxuKTogSFRNTFNlbGVjdEVsZW1lbnQge1xyXG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICBzZWxlY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGxhYmVsKTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgdGV4dF0gb2YgaXRlbXMpIHtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKGtleSwgdGV4dCkpO1xyXG4gICAgfVxyXG4gICAgc2VsZWN0LnZhbHVlID0gdmFsdWU7XHJcbiAgICByZXR1cm4gc2VsZWN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBlbmRUcmVlTm9kZShjb250YWluZXI6IEhUTUxFbGVtZW50LCBub2RlOiBUcmVlTm9kZUR0bywgZGVwdGg6IG51bWJlcik6IHZvaWQge1xyXG4gICAgaWYgKCFtYXRjaGVzKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICByb3cuY2xhc3NOYW1lID0gYHRyZWUtcm93JHtzdGF0ZS5zZWxlY3RlZElkID09PSBub2RlLmlkID8gJyBpcy1zZWxlY3RlZCcgOiAnJ31gO1xyXG4gICAgcm93LmRhdGFzZXQubm9kZUlkID0gbm9kZS5pZDtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndHJlZWl0ZW0nKTtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGV2ZWwnLCBTdHJpbmcoZGVwdGggKyAxKSk7XHJcblxyXG4gICAgY29uc3QgbWFpbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWFpbi5jbGFzc05hbWUgPSAnbm9kZS1tYWluJztcclxuICAgIG1haW4uc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTtcclxuICAgIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgICBjb2xsYXBzZS5jbGFzc05hbWUgPSBgY29sbGFwc2Uke25vZGUuY2hpbGRyZW4ubGVuZ3RoID8gJycgOiAnIGlzLWxlYWYnfWA7XHJcbiAgICBjb2xsYXBzZS50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBjb2xsYXBzZS5kYXRhc2V0LmNvbGxhcHNlID0gbm9kZS5pZDtcclxuICAgIGNvbGxhcHNlLnRleHRDb250ZW50ID0gc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICfigLonIDogJ+KMhCc7XHJcbiAgICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+WxleW8gCcgOiAn5oqY5Y+gJyk7XHJcbiAgICBjb25zdCBkb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBkb3QuY2xhc3NOYW1lID0gYHR5cGUtZG90ICR7XHJcbiAgICAgICAgbm9kZS50eXBlID09PSAnVEVYVCcgPyAndGV4dCdcclxuICAgICAgICAgICAgOiBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAndmVjdG9yJ1xyXG4gICAgICAgICAgICAgICAgOiBub2RlLnR5cGUuaW5jbHVkZXMoJ0NPTVBPTkVOVCcpIHx8IG5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJyA/ICdjb21wb25lbnQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xyXG4gICAgfWA7XHJcbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBjb3B5LmNsYXNzTmFtZSA9ICdub2RlLWNvcHknO1xyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gYG5vZGUtbmFtZSR7c3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyAnIGlzLXJlbmFtZWQnIDogJyd9YDtcclxuICAgIG5hbWUudGV4dENvbnRlbnQgPSBkaXNwbGF5TmFtZTtcclxuICAgIGNvbnN0IHN0cmF0ZWd5U3VtbWFyeSA9IHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUobm9kZSwgc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpKTtcclxuICAgIG5hbWUudGl0bGUgPSBbXHJcbiAgICAgICAgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV9YCA6ICfpgInmi6noioLngrnvvIzlnKjlj7Pkvqfkv67mlLnlr7zlhaXoioLngrnlkI0nLFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkud2FybmluZyxcclxuICAgIF1cclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmpvaW4oJyDCtyAnKTtcclxuICAgIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1ldGEuY2xhc3NOYW1lID0gJ25vZGUtbWV0YSc7XHJcbiAgICBtZXRhLnRleHRDb250ZW50ID0gYCR7bm9kZS50eXBlfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb3B5LmFwcGVuZChuYW1lLCBtZXRhKTtcclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kpIHtcclxuICAgICAgICBjb25zdCBzdHJhdGVneSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHN0cmF0ZWd5LmNsYXNzTmFtZSA9ICdub2RlLXN0cmF0ZWd5JztcclxuICAgICAgICBzdHJhdGVneS50ZXh0Q29udGVudCA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBzdHJhdGVneS50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHN0cmF0ZWd5KTtcclxuICAgIH1cclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkud2FybmluZykge1xyXG4gICAgICAgIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICB3YXJuaW5nLmNsYXNzTmFtZSA9ICdub2RlLXdhcm5pbmcnO1xyXG4gICAgICAgIHdhcm5pbmcudGV4dENvbnRlbnQgPSBg4pqgICR7c3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmd9YDtcclxuICAgICAgICB3YXJuaW5nLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmc7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZCh3YXJuaW5nKTtcclxuICAgIH1cclxuICAgIHJvdy5jbGFzc0xpc3QudG9nZ2xlKCdoYXMtZGV0YWlsJywgQm9vbGVhbihzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpKTtcclxuICAgIG1haW4uYXBwZW5kKGNvbGxhcHNlLCBkb3QsIGNvcHkpO1xyXG5cclxuICAgIGNvbnN0IGFjdGlvbkJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgYWN0aW9uQmFkZ2UuY2xhc3NOYW1lID0gJ25vZGUtYWN0aW9uLWJhZGdlJztcclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBhY3Rpb25CYWRnZS50ZXh0Q29udGVudCA9IGFjdGlvbk9wdGlvbnNGb3JOb2RlKG5vZGUpLmZpbmQoKFt2YWx1ZV0pID0+IHZhbHVlID09PSBzZWxlY3RlZEFjdGlvbik/LlsxXSA/PyBzZWxlY3RlZEFjdGlvbjtcclxuICAgIGFjdGlvbkJhZGdlLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5IHx8IGFjdGlvbkJhZGdlLnRleHRDb250ZW50O1xyXG4gICAgcm93LmFwcGVuZChtYWluLCBhY3Rpb25CYWRnZSk7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuXHJcbiAgICBpZiAoIXN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgfHwgc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyLCBjaGlsZCwgZGVwdGggKyAxKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk6IHZvaWQge1xyXG4gICAgY29uc3QgY29udGFpbmVyID0gZWxlbWVudCgnI25vZGUtcHJvcGVydGllcycpO1xyXG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3Qgbm9kZSA9IHN0YXRlLnNlbGVjdGVkSWQgPyBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKSA6IHVuZGVmaW5lZDtcclxuICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdpbnNwZWN0b3ItZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+mAieaLqeiKgueCue+8jOafpeeci+mihOiniOW5tuiwg+aVtOWvvOWFpeiuvue9ruOAgic7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgZmllbGQgPSAobGFiZWw6IHN0cmluZywgY29udHJvbDogSFRNTEVsZW1lbnQpOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xyXG4gICAgICAgIHJvdy5jbGFzc05hbWUgPSAnZmllbGQnO1xyXG4gICAgICAgIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgaGVhZGluZy50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgICAgIHJvdy5hcHBlbmQoaGVhZGluZywgY29udHJvbCk7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJvdyk7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBuYW1lLnR5cGUgPSAndGV4dCc7XHJcbiAgICBuYW1lLmNsYXNzTmFtZSA9ICdub2RlLW5hbWUtaW5wdXQnO1xyXG4gICAgbmFtZS52YWx1ZSA9IGRpc3BsYXlOYW1lO1xyXG4gICAgbmFtZS5tYXhMZW5ndGggPSA5NjtcclxuICAgIG5hbWUuc3BlbGxjaGVjayA9IGZhbHNlO1xyXG4gICAgbmFtZS5kYXRhc2V0Lm5hbWVGb3IgPSBub2RlLmlkO1xyXG4gICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtub2RlLm5hbWV9IOWvvOWFpeiKgueCueWQjWApO1xyXG4gICAgbmFtZS50aXRsZSA9IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX3vvJtFbnRlciDkv53lrZjvvIxFc2Mg5Y+W5raIYDtcclxuICAgIG5hbWUuZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeiKgueCueWQjScsIG5hbWUpO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBjb25zdCBhY3Rpb25PcHRpb25zID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSk7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdhY3Rpb24tc2VsZWN0JyxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBhY3Rpb25PcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDlr7zlhaXmlrnlvI9gLFxyXG4gICAgKTtcclxuICAgIGFjdGlvbi5kYXRhc2V0LmFjdGlvbkZvciA9IG5vZGUuaWQ7XHJcbiAgICBhY3Rpb24uZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeaWueW8jycsIGFjdGlvbik7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRLaW5kID0gc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZDtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICBub2RlLFxyXG4gICAgICAgIHNlbGVjdGVkS2luZCxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBraW5kT3B0aW9ucyA9IGtpbmRPcHRpb25zRm9yQWN0aW9uKHNlbGVjdGVkQWN0aW9uKTtcclxuICAgIGNvbnN0IGtpbmQgPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdraW5kLXNlbGVjdCcsXHJcbiAgICAgICAgZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBraW5kT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g6IqC54K557G75Z6LYCxcclxuICAgICk7XHJcbiAgICBraW5kLmRhdGFzZXQua2luZEZvciA9IG5vZGUuaWQ7XHJcbiAgICBraW5kLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGZpZWxkKCfoioLngrnnsbvlnosnLCBraW5kKTtcclxuXHJcbiAgICBjb25zdCBwYXRjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICBwYXRjaC5jbGFzc05hbWUgPSAndG9nZ2xlLXJvdyBwYXRjaC10b2dnbGUnO1xyXG4gICAgcGF0Y2gudGl0bGUgPSBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgPyAnRmlnbWEg5YiG54mH5LyY5YWI77ya5oyJIEZpZ21hIOWOn+Wni+i+ueeVjOWvvOWFpe+8jOS4jeiDveWFs+mXre+8m+S7jeWPr+W/veeVpeaVtOS4quiKgueCuSdcclxuICAgICAgICA6ICfor6XoioLngrnkuI3mmK/mnInmlYjnmoQgRmlnbWEg5YiG54mHJztcclxuICAgIGNvbnN0IHBhdGNoSW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgcGF0Y2hJbnB1dC50eXBlID0gJ2NoZWNrYm94JztcclxuICAgIHBhdGNoSW5wdXQuZGF0YXNldC5wYXRjaEZvciA9IG5vZGUuaWQ7XHJcbiAgICBwYXRjaElucHV0LmNoZWNrZWQgPSBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKTtcclxuICAgIHBhdGNoSW5wdXQuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgY29uc3QgcGF0Y2hJY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgcGF0Y2hJY29uLnRleHRDb250ZW50ID0gbm9kZS5wYXRjaENhbmRpZGF0ZVxyXG4gICAgICAgID8gbm9kZS5zbGljZU1vZGUgPT09ICduaW5lJyA/ICdGaWdtYSDkuZ3lrqsgwrcg5LyY5YWI5ZCv55SoJyA6IG5vZGUuc2xpY2VNb2RlID8gJ0ZpZ21hIOS4ieWuqyDCtyDkvJjlhYjlkK/nlKgnIDogJ0ZpZ21hIOS4iSAvIOS5neWuqyDCtyDkvJjlhYjlkK/nlKgnXHJcbiAgICAgICAgOiAn5YiH54mHIMK3IOmdnuWAmemAieiKgueCuSc7XHJcbiAgICBwYXRjaC5hcHBlbmQocGF0Y2hJbnB1dCwgcGF0Y2hJY29uKTtcclxuICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChwYXRjaCk7XHJcbiAgICBjb25zdCBzdW1tYXJ5ID0gc3RyYXRlZ3lTdW1tYXJ5Rm9yTm9kZShub2RlLCBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkpO1xyXG4gICAgY29uc3Qgbm90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbm90ZS5jbGFzc05hbWUgPSAnbm9kZS1pbnNwZWN0b3Itbm90ZSc7XHJcbiAgICBmb3IgKGNvbnN0IHRleHQgb2YgW3N1bW1hcnkuc3RyYXRlZ3ksIGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gLCBzdW1tYXJ5Lndhcm5pbmddKSB7XHJcbiAgICAgICAgaWYgKCF0ZXh0KSBjb250aW51ZTtcclxuICAgICAgICBjb25zdCBwYXJhZ3JhcGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgcGFyYWdyYXBoLnRleHRDb250ZW50ID0gdGV4dDtcclxuICAgICAgICBpZiAodGV4dCA9PT0gc3VtbWFyeS53YXJuaW5nKSBwYXJhZ3JhcGguY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgbm90ZS5hcHBlbmRDaGlsZChwYXJhZ3JhcGgpO1xyXG4gICAgfVxyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKG5vdGUpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJUcmVlKHJlc2V0U2Nyb2xsID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRyZWUgPSBlbGVtZW50KCcjdHJlZScpO1xyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsKHRyZWUsICgpID0+IHtcclxuICAgICAgICB0cmVlLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2VtcHR5LXN0YXRlJztcclxuICAgICAgICAgICAgY29uc3QgZ2x5cGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgICAgIGdseXBoLmNsYXNzTmFtZSA9ICdlbXB0eS1nbHlwaCc7XHJcbiAgICAgICAgICAgIGdseXBoLnRleHRDb250ZW50ID0gJ+KGsyc7XHJcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XHJcbiAgICAgICAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ+i/mOayoeacieiKgueCuSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOmTvuaOpeWQju+8jOWPr+mAkOWxgumAieaLqeeUn+aIkOOAgVBORyDmlbTlsYLmiJbmm7TmlrDjgIInO1xyXG4gICAgICAgICAgICBlbXB0eS5hcHBlbmQoZ2x5cGgsIHRpdGxlLCBib2R5KTtcclxuICAgICAgICAgICAgdHJlZS5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQudHJlZS5mb3JFYWNoKChub2RlKSA9PiBhcHBlbmRUcmVlTm9kZSh0cmVlLCBub2RlLCAwKSk7XHJcbiAgICB9LCByZXNldFNjcm9sbCk7XHJcbiAgICByZW5kZXJOb2RlUHJvcGVydGllcygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KCk6IHZvaWQge1xyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7IHJlbWVtYmVyQWN0aXZlRnJhbWUoKTsgcmVuZGVyQmF0Y2goKTsgfVxyXG4gICAgY29uc3Qgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudCA/IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkgOiBbXTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gbm9kZXMuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSAhPT0gJ2lnbm9yZScpO1xyXG4gICAgZWxlbWVudCgnI25vZGUtY291bnQnKS50ZXh0Q29udGVudCA9IGAke25vZGVzLmxlbmd0aH0g6IqC54K5YDtcclxuICAgIGVsZW1lbnQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICA/IGAke3NlbGVjdGVkLmxlbmd0aH0gLyAke25vZGVzLmxlbmd0aH0g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYFxyXG4gICAgICAgIDogJ+etieW+heiuvuiuoeaVsOaNric7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3lcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc2VsZWN0ZWQubGVuZ3RoXHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3KG5vZGU6IFRyZWVOb2RlRHRvKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBub2RlLmlkO1xyXG4gICAgY29uc3QgcmV2aXNpb24gPSArK3ByZXZpZXdSZXZpc2lvbjtcclxuICAgIGNvbnN0IGZyYW1lSWQgPSBhY3RpdmVCYXRjaElkO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvbnN0IHN0YWdlID0gZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKTtcclxuICAgIGNvbnN0IGltYWdlID0gZWxlbWVudDxIVE1MSW1hZ2VFbGVtZW50PignI3ByZXZpZXctaW1hZ2UnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2lzLWxvYWRpbmcnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2hhcy1pbWFnZScpO1xyXG4gICAgaW1hZ2UucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcHJlY2VkaW5nU3luYyA9IGJhdGNoU3luY1Rhc2s7XHJcbiAgICAgICAgY29uc3QgcmVhZCA9IHByZXZpZXdSZWFkVGFzay5jYXRjaCgoKSA9PiB1bmRlZmluZWQpLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBhd2FpdCBwcmVjZWRpbmdTeW5jO1xyXG4gICAgICAgICAgICBpZiAocHJldmlld1JldmlzaW9uICE9PSByZXZpc2lvbiB8fCBmcmFtZUlkICE9PSBhY3RpdmVCYXRjaElkKSByZXR1cm4gbnVsbDtcclxuICAgICAgICAgICAgcmV0dXJuIHJlcXVlc3Q8eyB1cmw6IHN0cmluZyB9PignZ2V0LXByZXZpZXcnLCBub2RlLmlkKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBwcmV2aWV3UmVhZFRhc2sgPSByZWFkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVhZDtcclxuICAgICAgICBpZiAoIXJlc3VsdCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChzdGF0ZS5zZWxlY3RlZElkICE9PSBub2RlLmlkIHx8IHByZXZpZXdSZXZpc2lvbiAhPT0gcmV2aXNpb24gfHwgZnJhbWVJZCAhPT0gYWN0aXZlQmF0Y2hJZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6aKE6KeI5Zu+54mH5Yqg6L295aSx6LSl44CCJykpO1xyXG4gICAgICAgICAgICBpbWFnZS5zcmMgPSByZXN1bHQudXJsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChwcmV2aWV3UmV2aXNpb24gPT09IHJldmlzaW9uKSBzdGFnZS5jbGFzc0xpc3QuYWRkKCdoYXMtaW1hZ2UnKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpooTop4jlpLHotKXjgIInLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgaWYgKHByZXZpZXdSZXZpc2lvbiA9PT0gcmV2aXNpb24pIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLWxvYWRpbmcnKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlQcmVzZXQobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxsID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgIGlmIChuYW1lID09PSAnc21hcnQnKSB7XHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gc3RhdGUuZGVmYXVsdHMuZ2V0KG5vZGUuaWQpITtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgb3JpZ2luYWwuYWN0aW9uKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmtpbmQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobmFtZSA9PT0gJ2VkaXRhYmxlJykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3JlbmRlcicgOiAnZ2VuZXJhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyAnZ2VuZXJhdGUnXHJcbiAgICAgICAgICAgICAgICA6ICdyZW5kZXInKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IG5hbWUpO1xyXG4gICAgfSk7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRUb1NjZW5lKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHdvcmtmbG93ICYmIHdvcmtmbG93LnN0ZXAgIT09IDMpIHJldHVybjtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+aJqeWxleS4u+i/m+eoi+S7jeaYr+aXp+eJiO+8jOivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCB8fCBzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoKTtcclxuICAgIGlmICghc2V0dGluZ3MpIHtcclxuICAgICAgICB3b3JrZmxvdz8uZmFpbCgn6K+35qOA5p+l5a+85YWl5YCN546H5LiO6L6T5Ye655uu5b2V77yM5L+u5q2j5ZCO5YaN5qyh5a+85YWl44CCJyk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7XHJcbiAgICAgICAgYXdhaXQgaW1wb3J0QmF0Y2hGcmFtZXMoc2V0dGluZ3MpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24sXHJcbiAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgfSwgbm9kZS5wYXRjaENhbmRpZGF0ZSkpO1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTtcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlh4blpIflr7zlhaXigKYnIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PFdvcmtmbG93UmVzdWx0PihcclxuICAgICAgICAgICAgJ2ltcG9ydC1zZWxlY3Rpb24nLFxyXG4gICAgICAgICAgICB7IG92ZXJyaWRlcywgc2V0dGluZ3MgfSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrTm90ZSA9IHJlc3VsdD8ud2FybmluZ3M/Lmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDvvJske3Jlc3VsdC53YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrvvIjor6bop4Hnu5Pmnpzmo4Dmn6XvvIlgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZShyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHJlc3VsdC5yZXZpZXcgPz8gcGVuZGluZ0ltcG9ydFJldmlldztcclxuICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogd29ya2Zsb3c/LmNhbmNlbGxlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsIG1lc3NhZ2UgfSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpO1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gbWVyZ2VCYXRjaEl0ZW1zKGl0ZW1zOiBCYXRjaEZyYW1lSXRlbVtdKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcclxuICAgICAgICBjb25zdCBwcmV2aW91cyA9IGJhdGNoSXRlbXMuZmluZCgoZW50cnkpID0+IGVudHJ5Lml0ZW0uaWQgPT09IGl0ZW0uaWQpO1xyXG4gICAgICAgIGlmIChwcmV2aW91cykgcHJldmlvdXMuaXRlbSA9IHsgLi4uaXRlbSwgZW5hYmxlZDogcHJldmlvdXMuaXRlbS5lbmFibGVkIH07XHJcbiAgICAgICAgZWxzZSBiYXRjaEl0ZW1zLnB1c2goeyBpdGVtLCBlZGl0b3I6IGluaXRpYWxGcmFtZUVkaXRvcihpdGVtLmRvY3VtZW50KSwgY29uZmlndXJlZDogQm9vbGVhbihpdGVtLmRvY3VtZW50Lm5vZGVPdmVycmlkZXM/Lmxlbmd0aCkgfSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlYWRCYXRjaFNvdXJjZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICBpZiAod29ya2Zsb3cgJiYgIXdvcmtmbG93LmNyZWRlbnRpYWxzUmVhZHkpIHsgd29ya2Zsb3cub3BlbkNyZWRlbnRpYWxzKCk7IHJldHVybjsgfVxyXG4gICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXNvdXJjZSkgeyBzaG93VG9hc3QoJ+ivt+eymOi0tCBGaWdtYSBTZWN0aW9uIOaIliBGcmFtZSDpk77mjqXjgIInLCB0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICByZW1lbWJlckFjdGl2ZUZyYW1lKCk7XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7IGlmIChzZXR0aW5ncykgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIHdvcmtmbG93Py5iZWdpbignZmV0Y2gnKTsgc2V0QnVzeSh0cnVlKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdmZXRjaCcsIHZhbHVlOiAwLjA1LCBtZXNzYWdlOiAn5q2j5Zyo6K+75Y+W5bm26K+G5YirIEZpZ21hIOeVjOmdouKApicgfSk7XHJcbiAgICBsZXQgYWN0aXZhdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYmF0Y2hTeW5jVGFzaztcclxuICAgICAgICBhd2FpdCBwcmV2aWV3UmVhZFRhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBpZiAoYmF0Y2hTeW5jRXJyb3IpIHRocm93IGJhdGNoU3luY0Vycm9yO1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8QmF0Y2hTb3VyY2VSZXN1bHQ+KCdyZXNvbHZlLWJhdGNoLXNvdXJjZScsIHNvdXJjZSk7XHJcbiAgICAgICAgaWYgKHJlc3VsdC5kb2N1bWVudCAmJiAhcmVzdWx0Lml0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBiYXRjaEl0ZW1zID0gW107IGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7IGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzeW5jQmF0Y2hJdGVtcygpO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gcmVzdWx0LmRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KHJlc3VsdC5kb2N1bWVudCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgbWVyZ2VCYXRjaEl0ZW1zKHJlc3VsdC5pdGVtcyk7XHJcbiAgICAgICAgICAgIGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gQXJyYXkuZnJvbShuZXcgTWFwKGJhdGNoSXRlbXMuZmxhdE1hcCgoeyBpdGVtIH0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBbXSkubWFwKChmb250KSA9PiBbZm9udC51cmwsIGZvbnRdKSkudmFsdWVzKCkpO1xyXG4gICAgICAgICAgICBhY3RpdmF0ZSA9IHNlbGVjdGVkRnJhbWVzKCkuZmluZCgoeyBpdGVtIH0pID0+IGl0ZW0uaWQgPT09IGFjdGl2ZUJhdGNoSWQpPy5pdGVtLmlkID8/IHNlbGVjdGVkRnJhbWVzKClbMF0/Lml0ZW0uaWQgPz8gYmF0Y2hJdGVtc1swXT8uaXRlbS5pZDtcclxuICAgICAgICAgICAgYWN0aXZlQmF0Y2hJZCA9IHVuZGVmaW5lZDtcclxuICAgICAgICAgICAgc3luY0JhdGNoSXRlbXMoKTtcclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uYmF0Y2hSZWFkeSgpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOW3sua3u+WKoCAke3Jlc3VsdC5hZGRlZH0g5Liq55WM6Z2iJHtyZXN1bHQuZHVwbGljYXRlcyA/IGDvvIzot7Pov4cgJHtyZXN1bHQuZHVwbGljYXRlc30g5Liq6YeN5aSN6aG5YCA6ICcnfeOAgmApO1xyXG4gICAgICAgIH1cclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluWksei0peOAgicpO1xyXG4gICAgICAgIGlmICghd29ya2Zsb3c/LmNhbmNlbGxlZCkgd29ya2Zsb3c/LmZhaWwobWVzc2FnZSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KHdvcmtmbG93Py5jYW5jZWxsZWQgPyAn6K+75Y+W5bey5Y+W5raI77yM6YWN572u5bey5L+d55WZ44CCJyA6IG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICBpZiAoYWN0aXZhdGUpIGF3YWl0IGFjdGl2YXRlRnJhbWUoYWN0aXZhdGUpO1xyXG4gICAgICAgIHJlbmRlckJhdGNoKCk7IHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gb3ZlcnJpZGVzRm9yRnJhbWUoZW50cnk6IEZyYW1lRWRpdG9ySXRlbSk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgY29uc3QgZWRpdG9yID0gZW50cnkuZWRpdG9yID8/IGluaXRpYWxGcmFtZUVkaXRvcihlbnRyeS5pdGVtLmRvY3VtZW50KTtcclxuICAgIHJldHVybiBmbGF0dGVuKGVudHJ5Lml0ZW0uZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub3JtYWxpemVGaWdtYVNsaWNlRGVjaXNpb24oe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLCBhY3Rpb246IGVkaXRvci5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbiwga2luZDogZWRpdG9yLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBlZGl0b3IucGF0Y2hlcy5oYXMobm9kZS5pZCksIGV4cGxpY2l0OiBlZGl0b3IuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIC4uLihlZGl0b3IucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVkaXRvci5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lIH0gOiB7fSksXHJcbiAgICB9LCBub2RlLnBhdGNoQ2FuZGlkYXRlKSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydEJhdGNoRnJhbWVzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncywgaWRzPzogU2V0PHN0cmluZz4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5IHx8IGJhdGNoSW1wb3J0UGVuZGluZykgcmV0dXJuO1xyXG4gICAgcmVtZW1iZXJBY3RpdmVGcmFtZSgpO1xyXG4gICAgY29uc3QgZW50cmllcyA9IHNlbGVjdGVkRnJhbWVzKCkuZmlsdGVyKCh7IGl0ZW0gfSkgPT4gIWlkcyB8fCBpZHMuaGFzKGl0ZW0uaWQpKTtcclxuICAgIGlmICghZW50cmllcy5sZW5ndGgpIHsgc2hvd1RvYXN0KCfor7flhYjli77pgInopoHlr7zlhaXnmoTnlYzpnaLjgIInLCB0cnVlKTsgcmV0dXJuOyB9XHJcbiAgICBpZiAoYmF0Y2hDb25mbGljdHMoKS5zaXplKSB7IHdvcmtmbG93Py5mYWlsKCflrZjlnKjph43lpI3nmoQgUHJlZmFiIOaWh+S7tuWQje+8jOivt+WFiOWcqOa4heWNleS4reaUueWQjeOAgicpOyByZXR1cm47IH1cclxuICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IHRydWU7IGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7IGJhdGNoU3RvcFJlcXVlc3RlZCA9IGZhbHNlO1xyXG4gICAgY29uc3QgcHJldmlvdXMgPSBiYXRjaFJlc3VsdDtcclxuICAgIHdvcmtmbG93Py5iZWdpbignaW1wb3J0Jyk7IHNldEJ1c3kodHJ1ZSk7IHJlbmRlckJhdGNoKCk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6IGDlh4blpIflr7zlhaUgJHtlbnRyaWVzLmxlbmd0aH0g5Liq55WM6Z2i4oCmYCB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgYmF0Y2hTeW5jVGFzaztcclxuICAgICAgICBhd2FpdCBwcmV2aWV3UmVhZFRhc2suY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgICAgICBpZiAoYmF0Y2hTeW5jRXJyb3IpIHRocm93IGJhdGNoU3luY0Vycm9yO1xyXG4gICAgICAgIGF3YWl0IG5vZGVPdmVycmlkZVNhdmVUYXNrO1xyXG4gICAgICAgIGlmIChiYXRjaFN0b3BSZXF1ZXN0ZWQpIHtcclxuICAgICAgICAgICAgY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbih7IGlkOiAnc3RvcHBlZC1iZWZvcmUtc3RhcnQnLCBzdG9wcGVkOiB0cnVlLCBjb21wbGV0ZWQ6IDAsIHRvdGFsOiBlbnRyaWVzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgIGl0ZW1zOiBlbnRyaWVzLm1hcCgoeyBpdGVtIH0pID0+ICh7IGlkOiBpdGVtLmlkLCBuYW1lOiBpdGVtLm5hbWUsIHNvdXJjZVVybDogaXRlbS5zb3VyY2VVcmwsIHN0YXR1czogJ3BlbmRpbmcnIH0pKSB9KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PEJhdGNoSW1wb3J0UmVzdWx0PignaW1wb3J0LWJhdGNoJywge1xyXG4gICAgICAgICAgICBpdGVtczogZW50cmllcy5tYXAoKGVudHJ5KSA9PiAoeyBpZDogZW50cnkuaXRlbS5pZCwgb3ZlcnJpZGVzOiBvdmVycmlkZXNGb3JGcmFtZShlbnRyeSkgfSkpLCBzZXR0aW5ncyxcclxuICAgICAgICAgICAgZmFpbHVyZVBvbGljeTogJ2NvbnRpbnVlJywgcHJlc2VydmVSZXN1bHRzOiBCb29sZWFuKGlkcyksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgY29uc3QgbWVyZ2VkID0gaWRzICYmIHByZXZpb3VzID8gcHJldmlvdXMuaXRlbXMubWFwKChpdGVtKSA9PiByZXN1bHQuaXRlbXMuZmluZCgobmV4dCkgPT4gbmV4dC5pZCA9PT0gaXRlbS5pZCkgPz8gaXRlbSkgOiByZXN1bHQuaXRlbXM7XHJcbiAgICAgICAgYmF0Y2hSZXN1bHQgPSB7IC4uLnJlc3VsdCwgaXRlbXM6IG1lcmdlZCwgdG90YWw6IG1lcmdlZC5sZW5ndGgsIGNvbXBsZXRlZDogbWVyZ2VkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09ICdzdWNjZXNzJyB8fCBpdGVtLnN0YXR1cyA9PT0gJ2ZhaWxlZCcpLmxlbmd0aCB9O1xyXG4gICAgICAgIGJhdGNoUHJvZ3Jlc3MgPSB1bmRlZmluZWQ7IHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIGNvbnN0IGNyZWF0ZWQgPSBtZXJnZWQucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLmNyZWF0ZWQgPz8gMCksIDApO1xyXG4gICAgICAgIGNvbnN0IHVwZGF0ZWQgPSBtZXJnZWQucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLnVwZGF0ZWQgPz8gMCksIDApO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7IGNyZWF0ZWQsIHVwZGF0ZWQsIHdhcm5pbmdzOiBtZXJnZWQuZmxhdE1hcCgoaXRlbSkgPT4gaXRlbS53YXJuaW5ncyA/PyBbXSkgfSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KGDmnKzmibnlrozmiJDvvJrmiJDlip8gJHttZXJnZWQuZmlsdGVyKChpdGVtKSA9PiBpdGVtLnN0YXR1cyA9PT0gJ3N1Y2Nlc3MnKS5sZW5ndGh9IOmhue+8jOWksei0pSAke21lcmdlZC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0uc3RhdHVzID09PSAnZmFpbGVkJykubGVuZ3RofSDpobnjgIJgKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+aJuemHj+WvvOWFpeWksei0peOAgicpO1xyXG4gICAgICAgIHdvcmtmbG93Py5mYWlsKG1lc3NhZ2UpOyBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IGZhbHNlOyB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpOyByZW5kZXJCYXRjaCgpOyB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJldHJ5QmF0Y2goc3RhdHVzOiAnZmFpbGVkJyB8ICdwZW5kaW5nJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kgfHwgIWJhdGNoUmVzdWx0KSByZXR1cm47XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncygpOyBpZiAoIXNldHRpbmdzKSByZXR1cm47XHJcbiAgICBjb25zdCBpZHMgPSBuZXcgU2V0KGJhdGNoUmVzdWx0Lml0ZW1zLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5zdGF0dXMgPT09IHN0YXR1cykubWFwKChpdGVtKSA9PiBpdGVtLmlkKSk7XHJcbiAgICBhd2FpdCBpbXBvcnRCYXRjaEZyYW1lcyhzZXR0aW5ncywgaWRzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29tcGxldGVCYXRjaFByZXNlbnRhdGlvbihyZXN1bHQ6IEJhdGNoSW1wb3J0UmVzdWx0KTogdm9pZCB7XHJcbiAgICBiYXRjaFJlc3VsdCA9IHJlc3VsdDsgYmF0Y2hQcm9ncmVzcyA9IHVuZGVmaW5lZDtcclxuICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7XHJcbiAgICAgICAgY3JlYXRlZDogcmVzdWx0Lml0ZW1zLnJlZHVjZSgoc3VtLCBpdGVtKSA9PiBzdW0gKyAoaXRlbS5jcmVhdGVkID8/IDApLCAwKSxcclxuICAgICAgICB1cGRhdGVkOiByZXN1bHQuaXRlbXMucmVkdWNlKChzdW0sIGl0ZW0pID0+IHN1bSArIChpdGVtLnVwZGF0ZWQgPz8gMCksIDApLFxyXG4gICAgICAgIHdhcm5pbmdzOiByZXN1bHQuaXRlbXMuZmxhdE1hcCgoaXRlbSkgPT4gaXRlbS53YXJuaW5ncyA/PyBbXSksXHJcbiAgICB9KTtcclxuICAgIHJlbmRlckJhdGNoKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhdGNoUmVzdG9yZWRCYXRjaCgpOiB2b2lkIHtcclxuICAgIGJhdGNoUmVjb3ZlcnlUaW1lciA9IHNldFRpbWVvdXQoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcGFuZWxIb3N0KSByZXR1cm47XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVjb3ZlcmVkID0gYXdhaXQgcmVxdWVzdDxCYXRjaFN0YXRlPignZ2V0LWJhdGNoLXN0YXRlJyk7XHJcbiAgICAgICAgICAgIGlmIChyZWNvdmVyZWQucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgYmF0Y2hQcm9ncmVzcyA9IHJlY292ZXJlZC5ydW5uaW5nOyByZW5kZXJCYXRjaFJlc3VsdHMoKTsgd2F0Y2hSZXN0b3JlZEJhdGNoKCk7IHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB3b3JrZmxvdz8uZW5kKCk7IHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAocmVjb3ZlcmVkLmxhc3RSZXN1bHQpIGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24ocmVjb3ZlcmVkLmxhc3RSZXN1bHQpO1xyXG4gICAgICAgICAgICBlbHNlIHdvcmtmbG93Py5mYWlsKCflkI7lj7Dmibnph4/ku7vliqHlt7Lnu4/nu5PmnZ/vvIzor7fmo4Dmn6UgQ29jb3Mg5Lit55qE5a+85YWl57uT5p6c44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3c/LmVuZCgpOyBzZXRCdXN5KGZhbHNlKTsgd29ya2Zsb3c/LmZhaWwoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5ZCO5Y+w5om56YeP5Lu75Yqh5aSx6LSl44CCJykpO1xyXG4gICAgICAgIH1cclxuICAgIH0sIDgwMCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIG9wZW5JbXBvcnRSZXZpZXcodGFiOiAnYXNzZXRzJyB8ICdub2RlcycgfCAnc291cmNlJyA9ICdhc3NldHMnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXZpZXcgPSBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycpO1xyXG4gICAgICAgIGlmIChyZXZpZXcpIHtcclxuICAgICAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgICAgICAgICAgY29uc3QgaW5kZXggPSBbJ2Fzc2V0cycsICdub2RlcycsICdzb3VyY2UnXS5pbmRleE9mKHRhYik7XHJcbiAgICAgICAgICAgIGlmIChpbmRleCA+IDApIGVsZW1lbnQoJyNpbXBvcnQtcmV2aWV3LWRpYWxvZycpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcucmV2aWV3LXRhYnMgYnV0dG9uJylbaW5kZXhdPy5jbGljaygpO1xyXG4gICAgICAgIH0gZWxzZSBzaG93VG9hc3QoJ+acrOasoeaPkuS7tuS8muivneWwmuaXoOWvvOWFpeajgOafpee7k+aenO+8jOivt+WFiOWujOaIkOS4gOasoeWvvOWFpeOAgicpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluajgOafpee7k+aenOWksei0peOAgicpLCB0cnVlKTsgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBiaW5kRXZlbnRzKCk6IHZvaWQge1xyXG4gICAgZWxlbWVudCgnI29wZW4taW1wb3J0LXJldmlldycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4geyB2b2lkIG9wZW5JbXBvcnRSZXZpZXcoKTsgfSk7XHJcbiAgICBlbGVtZW50KCcjc2F2ZS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3Rva2VuLWlucHV0Jyk7XHJcbiAgICAgICAgaWYgKCFpbnB1dC52YWx1ZS50cmltKCkpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEgVG9rZW7jgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBsZXQgc2F2ZWQgPSBmYWxzZTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdzZXQtdG9rZW4nLCBpbnB1dC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgICAgICBzYXZlZCA9IHRydWU7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCh2YXVsdC5wZXJzaXN0ZW50ID8gJ1Rva2VuIOW3sueUseezu+e7n+WKoOWvhuS/neWtmOOAgicgOiAnVG9rZW4g5bey5L+d5a2Y5Yiw5pys5qyh5Lya6K+d44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+S/neWtmOWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2F2ZWQpIHdvcmtmbG93Py5jbG9zZUNyZWRlbnRpYWxzKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3ZlcmlmeS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGhhbmRsZTogc3RyaW5nIH0+KCd2ZXJpZnktdG9rZW4nKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDov57mjqXmiJDlip8gwrcgJHtyZXN1bHQuaGFuZGxlfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfov57mjqXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjY2xlYXItdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55PignY2xlYXItdG9rZW4nKTtcclxuICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICBzaG93VG9hc3QoJ+W3sua4hemZpOS/neWtmOeahCBGaWdtYSDlh63mja7jgIInKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtZGV0ZWN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgZGV0ZWN0ZWQgPSBhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcERldGVjdER0bz4oJ3JvdW5kdHJpcC1kZXRlY3QnLCBzb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3QgPSBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290Jyk7XHJcbiAgICAgICAgICAgIHNlbGVjdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIGRldGVjdGVkLm1hbmFnZWRSb290cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICAgICAgICAgICAgICBvcHRpb24udmFsdWUgPSByb290Lm5vZGVJZDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IHJvb3QuZXJyb3JcclxuICAgICAgICAgICAgICAgICAgICA/IGAke3Jvb3QubmFtZX0gwrcg5Y2P6K6u5o2f5Z2PYFxyXG4gICAgICAgICAgICAgICAgICAgIDogYCR7cm9vdC5uYW1lfSDCtyAke3Jvb3QucHJlZmFiVXVpZCA/PyAn5pyq55+lIFByZWZhYid9YDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi5kaXNhYmxlZCA9IEJvb2xlYW4ocm9vdC5lcnJvcik7XHJcbiAgICAgICAgICAgICAgICBzZWxlY3QuYXBwZW5kKG9wdGlvbik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2VsZWN0LnZhbHVlID0gZGV0ZWN0ZWQuc2VsZWN0ZWRSb290SWRcclxuICAgICAgICAgICAgICAgID8/IGRldGVjdGVkLm1hbmFnZWRSb290cy5maW5kKChyb290KSA9PiAhcm9vdC5lcnJvcik/Lm5vZGVJZFxyXG4gICAgICAgICAgICAgICAgPz8gJyc7XHJcbiAgICAgICAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IGRldGVjdGVkLm1hbmFnZWRSb290cy5sZW5ndGggPT09IDA7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7ZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aH0g5LiqIG1hbmFnZWQgcm9vdCDCtyBGaWdtYSAke2RldGVjdGVkLmZpZ21hVmVyc2lvbn3jgILpgInmi6nnm67moIflkI7nlJ/miJDlj6ror7vpooTop4jjgIJgXHJcbiAgICAgICAgICAgICAgICA6ICfmnKrmo4DmtYvliLAgbWFuYWdlZCByb29044CCJztcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDmo4DmtYvlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1yb290JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcHJldmlldycpLmRpc2FibGVkID1cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcHJldmlldycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IHJvdW5kdHJpcFNvdXJjZSgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RJZCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZTtcclxuICAgICAgICBpZiAoIXNvdXJjZSB8fCAhcm9vdElkKSByZXR1cm47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJlbmRlclJvdW5kdHJpcFByZXZpZXcoYXdhaXQgcmVxdWVzdDxSb3VuZHRyaXBQcmV2aWV3RHRvPigncm91bmR0cmlwLXByZXZpZXcnLCBzb3VyY2UsIHJvb3RJZCkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOmihOiniOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXBhaXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFBhaXJUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYWlyZWQgPSBhd2FpdCByZXF1ZXN0PHsgZ2VuZXJhdGlvbjogbnVtYmVyOyBiYXNlbGluZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLXBhaXInLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOmFjeWvueWujOaIkCDCtyBMZWRnZXIgZ2VuZXJhdGlvbiAke3BhaXJlZC5nZW5lcmF0aW9ufVxcbkJhc2VsaW5lICR7cGFpcmVkLmJhc2VsaW5lSGFzaH1cXG7or7fph43mlrDnlJ/miJDlj5jmm7TpooTop4jjgIJgO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ1N1cmZhY2Ug5bey6YWN5a+577yb5pyq5L+u5pS5IFByZWZhYuOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIFBhaXIg5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtYXBwbHknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFByZXZpZXdUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcmVxdWVzdDx7IHR4bklkOiBzdHJpbmc7IHByZWZhYlBvc3RpbWFnZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLWFwcGx5JywgdG9rZW4pO1xyXG4gICAgICAgICAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGDkuovliqHlt7Lmj5DkuqQgwrcgJHtyZWNlaXB0LnR4bklkfVxcblBvc3RpbWFnZSAke3JlY2VpcHQucHJlZmFiUG9zdGltYWdlSGFzaH1cXG7or7fph43mlrDpooTop4jku6Xnoa7orqQgMCBwYXRjaOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnUm91bmQtdHJpcCDlt7Lljp/lrZDlupTnlKjliLDljp8gUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg5bqU55So5aSx6LSl77yM5LqL5Yqh5bey5Zue5rua44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiByZXF1ZXN0KCdyb3VuZHRyaXAtY2FuY2VsJykpO1xyXG5cclxuICAgIGVsZW1lbnQoJyNmZXRjaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZm9yY2VSZWFkID0gZm9yY2VEb2N1bWVudFJlYWQ7XHJcbiAgICAgICAgZm9yY2VEb2N1bWVudFJlYWQgPSBmYWxzZTtcclxuICAgICAgICBpZiAod29ya2Zsb3cgJiYgIXdvcmtmbG93LmNyZWRlbnRpYWxzUmVhZHkpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3cub3BlbkNyZWRlbnRpYWxzKCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoICYmICFmb3JjZVJlYWQpIHtcclxuICAgICAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzZWxlY3RlZEZyYW1lcygpO1xyXG4gICAgICAgICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgcmV0dXJuO1xyXG4gICAgICAgICAgICBhd2FpdCBhY3RpdmF0ZUZyYW1lKHNlbGVjdGVkLnNvbWUoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKSA/IGFjdGl2ZUJhdGNoSWQhIDogc2VsZWN0ZWRbMF0uaXRlbS5pZCwgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZvcmNlUmVhZCAmJiBiYXRjaEl0ZW1zLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBjb25zdCBhY3RpdmUgPSBiYXRjaEl0ZW1zLmZpbmQoKHsgaXRlbSB9KSA9PiBpdGVtLmlkID09PSBhY3RpdmVCYXRjaElkKTtcclxuICAgICAgICAgICAgaWYgKGFjdGl2ZSkgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IGFjdGl2ZS5pdGVtLnNvdXJjZVVybDtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFmb3JjZVJlYWQgJiYgd29ya2Zsb3c/LnNvdXJjZVVuY2hhbmdlZCgpKSB7XHJcbiAgICAgICAgICAgIHdvcmtmbG93Lm5hdmlnYXRlKDIpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHJlYWRCYXRjaFNvdXJjZSgpO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjYWRkLWJhdGNoLXNvdXJjZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgcmVhZEJhdGNoU291cmNlKTtcclxuICAgIGVsZW1lbnQoJyNiYXRjaC1lZGl0LWxpc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHdvcmtmbG93Py5uYXZpZ2F0ZSgxKSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtdG9nZ2xlLWFsbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgZW5hYmxlZCA9IHNlbGVjdGVkRnJhbWVzKCkubGVuZ3RoICE9PSBiYXRjaEl0ZW1zLmxlbmd0aDtcclxuICAgICAgICBiYXRjaEl0ZW1zLmZvckVhY2goKHsgaXRlbSB9KSA9PiB7IGl0ZW0uZW5hYmxlZCA9IGVuYWJsZWQ7IH0pO1xyXG4gICAgICAgIHN5bmNCYXRjaEl0ZW1zKCk7IHJlbmRlckJhdGNoKCk7IHJlbmRlckZvbnRNYXAoKTsgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmV0cnktZmFpbGVkJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiByZXRyeUJhdGNoKCdmYWlsZWQnKSk7XHJcbiAgICBlbGVtZW50KCcjYmF0Y2gtcmVzdW1lLXBlbmRpbmcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJldHJ5QmF0Y2goJ3BlbmRpbmcnKSk7XHJcbiAgICBlbGVtZW50KCcjcmVmcmVzaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgZm9yY2VEb2N1bWVudFJlYWQgPSB0cnVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5jbGljaygpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2FkZC1iYXRjaC1zb3VyY2UnKS5jbGljaygpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlc2V0Um91bmR0cmlwVG9rZW5zKTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLWFzc2V0LWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stYXNzZXQtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi1hOa6kOWwhuWGmeWFpSBhc3NldHMvJHtyZXN1bHQuZm9sZGVyfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6notYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLXByZWZhYi1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1wcmVmYWItZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDpooTliLbkvZPlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6aKE5Yi25L2T55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQoYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcu+8jOWGjemAieaLqeacrOWcsOi1hOa6kOebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgICAgIGluZGV4LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDlt7LlkK/nlKjmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqeacrOWcsOi1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBlbGVtZW50KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9ICcnO1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2hvd1RvYXN0KGDlt7LmuIXpmaTmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaW1wb3J0VG9TY2VuZSk7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChiYXRjaEltcG9ydFBlbmRpbmcpIGJhdGNoU3RvcFJlcXVlc3RlZCA9IHRydWU7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNhbmNlbFJlcXVlc3RlZCgpO1xyXG4gICAgICAgIHRyeSB7IGF3YWl0IHJlcXVlc3QoYmF0Y2hJbXBvcnRQZW5kaW5nID8gJ3N0b3AtaW1wb3J0LWJhdGNoJyA6ICdjYW5jZWwtaW1wb3J0Jyk7IH1cclxuICAgICAgICBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+WPlua2iOivt+axguWksei0pe+8jOivt+eojeWQjumHjeivleOAgicpO1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uY2FuY2VsUmVxdWVzdEZhaWxlZChtZXNzYWdlKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KG1lc3NhZ2UsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN0cmVlLXNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgc3RhdGUuc2VhcmNoID0gKGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS52YWx1ZS50cmltKCkudG9Mb3dlckNhc2UoKTtcclxuICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdHJlZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgY29sbGFwc2VJZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtY29sbGFwc2VdJyk/LmRhdGFzZXQuY29sbGFwc2U7XHJcbiAgICAgICAgaWYgKGNvbGxhcHNlSWQpIHtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLmNvbGxhcHNlZC5oYXMoY29sbGFwc2VJZCkpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5kZWxldGUoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5jb2xsYXBzZWQuYWRkKGNvbGxhcHNlSWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGFyZ2V0LmNsb3Nlc3QoJ3NlbGVjdCwgbGFiZWwsIGlucHV0LCB0ZXh0YXJlYScpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tkYXRhLW5vZGUtaWRdJyk/LmRhdGFzZXQubm9kZUlkO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpZCA/IGZpbmROb2RlKGlkKSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICB2b2lkIHByZXZpZXcobm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MU2VsZWN0RWxlbWVudDtcclxuICAgICAgICBpZiAoIXRhcmdldC5kYXRhc2V0Lm5hbWVGb3IgJiYgIXRhcmdldC5kYXRhc2V0LmFjdGlvbkZvciAmJiAhdGFyZ2V0LmRhdGFzZXQua2luZEZvciAmJiAhdGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpIHJldHVybjtcclxuICAgICAgICBpZiAodGFyZ2V0LmRhdGFzZXQubmFtZUZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQubmFtZUZvcik7XHJcbiAgICAgICAgICAgIGlmICghbm9kZSkgcmV0dXJuO1xyXG4gICAgICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZSh0YXJnZXQudmFsdWUpO1xyXG4gICAgICAgICAgICBpZiAoIWN1c3RvbU5hbWUpIHtcclxuICAgICAgICAgICAgICAgIHRhcmdldC52YWx1ZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICAgICAgc2hvd1RvYXN0KCfoioLngrnlkI3kuI3og73kuLrnqbrjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgY3VzdG9tTmFtZSk7XHJcbiAgICAgICAgICAgIGlmIChjdXN0b21OYW1lID09PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3Qoc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZClcclxuICAgICAgICAgICAgICAgID8gYOiKgueCueWwhuS7peKAnCR7Y3VzdG9tTmFtZX3igJ3lr7zlhaXjgIJgXHJcbiAgICAgICAgICAgICAgICA6ICflt7LmgaLlpI0gRmlnbWEg5Y6f6IqC54K55ZCN44CCJyk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcik7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBhY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uICE9PSAncmVuZGVyJyAmJiAhbm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgc2V0QWN0aW9uKG5vZGUsIGFjdGlvbik7XHJcbiAgICAgICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uID09PSAncmVuZGVyJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNob3dUb2FzdChg4oCcJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX3igJ3lsIbkvZzkuLrmlbTlsYLlr7zlhaXvvIwke2Rlc2NlbmRhbnRzKG5vZGUpLmxlbmd0aH0g5Liq5a2Q6IqC54K55LiN5Lya5Y2V54us55Sf5oiQ44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5raW5kRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldCh0YXJnZXQuZGF0YXNldC5raW5kRm9yLCB0YXJnZXQudmFsdWUgYXMgTm9kZUtpbmQpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQua2luZEZvcik7XHJcbiAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpO1xyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikge1xyXG4gICAgICAgICAgICAvLyBBbHNvIHJlamVjdCBhIHN0YWxlIHBhbmVsL3Byb2dyYW1tYXRpYyBhdHRlbXB0IHRvIGRpc2FibGUgYSB2YWxpZFxyXG4gICAgICAgICAgICAvLyBGaWdtYSBkZWZpbml0aW9uOyB0aGUgc291cmNlIGRlY2lzaW9uIGlzIHNoYXJlZCB3aXRoIHRoZSBpbXBvcnRlci5cclxuICAgICAgICAgICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIGlmIChmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik/LnBhdGNoQ2FuZGlkYXRlKSBzaG93VG9hc3QoJ0ZpZ21hIOWIhueJh+S8mOWFiO+8jOS4jeiDveWFs+mXre+8m+WPr+WcqOWvvOWFpeaWueW8j+S4reW/veeVpeaVtOS4quiKgueCueOAgicpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGlkID0gdGFyZ2V0LmRhdGFzZXQubmFtZUZvcjtcclxuICAgICAgICBpZiAoIWlkKSByZXR1cm47XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgICAgICB0YXJnZXQuYmx1cigpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoZXZlbnQua2V5ID09PSAnRXNjYXBlJykge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoaWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlQcmVzZXQoYnV0dG9uLmRhdGFzZXQucHJlc2V0ID8/ICdzbWFydCcpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50PihcclxuICAgICAgICAnI3NjYWxlLCAjYXNzZXQtZm9sZGVyLCAjcHJlZmFiLWZvbGRlciwgI2xvY2FsLXJlc291cmNlLWZvbGRlciwgI3VwZGF0ZS1leGlzdGluZywgI3JlZnJlc2gtYXNzZXRzLCAjYXV0by1zYXZlJyxcclxuICAgICkuZm9yRWFjaCgoY29udHJvbCkgPT4ge1xyXG4gICAgICAgIGNvbnRyb2wuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZm9udC1tYXAtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gRWRpdG9yLlBhbmVsLmRlZmluZSh7XHJcbiAgICBsaXN0ZW5lcnM6IHtcclxuICAgICAgICBzaG93KCkge30sXHJcbiAgICAgICAgaGlkZSgpIHt9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGY4JyksXHJcbiAgICBzdHlsZTogcmVhZEZpbGVTeW5jKGpvaW4oX19kaXJuYW1lLCAnLi4vLi4vLi4vc3RhdGljL3N0eWxlL2RlZmF1bHQvaW5kZXguY3NzJyksICd1dGY4JyksXHJcbiAgICAkOiB7XHJcbiAgICAgICAgYXBwOiAnI2FwcCcsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge1xyXG4gICAgICAgIG9uSW1wb3J0UmV2aWV3UmVhZHkocmV2aWV3OiBJbXBvcnRSZXZpZXcpIHtcclxuICAgICAgICAgICAgaWYgKGJhdGNoSXRlbXMubGVuZ3RoKSB7IHdvcmtmbG93Py5yZW1lbWJlclJldmlldygpOyByZXR1cm47IH1cclxuICAgICAgICAgICAgaWYgKHN0YXRlLmJ1c3kgfHwgd29ya2Zsb3c/LnBlbmRpbmcpIHtcclxuICAgICAgICAgICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSByZXZpZXc7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb25Qcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCkge1xyXG4gICAgICAgICAgICB1cGRhdGVQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgfSxcclxuICAgIH0sXHJcbiAgICBhc3luYyByZWFkeSgpIHtcclxuICAgICAgICBwYW5lbEhvc3QgPSB0aGlzO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbmV3IEltcG9ydFJldmlld1BhbmVsKHJvb3QoKSwgcmVxdWVzdCwgc2V0QnVzeSk7XHJcbiAgICAgICAgd29ya2Zsb3cgPSBuZXcgUGFuZWxXb3JrZmxvdyhyb290KCksICgpID0+ICh7IC4uLnN0YXRlLCBiYXRjaDogYmF0Y2hDb250ZXh0KCkgfSksICh0YWIpID0+IHsgdm9pZCBvcGVuSW1wb3J0UmV2aWV3KHRhYik7IH0pO1xyXG4gICAgICAgIGJpbmRFdmVudHMoKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpbml0aWFsID0gYXdhaXQgcmVxdWVzdDx7XHJcbiAgICAgICAgICAgICAgICB2ZXJzaW9uPzogc3RyaW5nO1xyXG4gICAgICAgICAgICAgICAgdmF1bHQ6IGFueTtcclxuICAgICAgICAgICAgICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncztcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICAgICAgICAgIH0+KCdnZXQtc3RhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUucnVudGltZUNvbXBhdGlibGUgPSBpbml0aWFsLnZlcnNpb24gPT09IHBhY2thZ2VKU09OLnZlcnNpb247XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBpbml0aWFsLmZvbnRBc3NldHMgPz8gW107XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24oaW5pdGlhbC52YXVsdCk7XHJcbiAgICAgICAgICAgIGFwcGx5U2V0dGluZ3MoaW5pdGlhbC5zZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIGlmIChpbml0aWFsLmRvY3VtZW50KSB7XHJcbiAgICAgICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQoaW5pdGlhbC5kb2N1bWVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgYmF0Y2ggPSBhd2FpdCByZXF1ZXN0PEJhdGNoU3RhdGUgfCB1bmRlZmluZWQ+KCdnZXQtYmF0Y2gtc3RhdGUnKTtcclxuICAgICAgICAgICAgaWYgKGJhdGNoPy5pdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgIG1lcmdlQmF0Y2hJdGVtcyhiYXRjaC5pdGVtcyk7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gQXJyYXkuZnJvbShuZXcgTWFwKGJhdGNoLml0ZW1zLmZsYXRNYXAoKGl0ZW0pID0+IGl0ZW0uZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBbXSkubWFwKChmb250KSA9PiBbZm9udC51cmwsIGZvbnRdKSkudmFsdWVzKCkpO1xyXG4gICAgICAgICAgICAgICAgd29ya2Zsb3cuYmF0Y2hSZWFkeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aXZlID0gc2VsZWN0ZWRGcmFtZXMoKVswXSA/PyBiYXRjaEl0ZW1zWzBdO1xyXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoLnJ1bm5pbmcpIHtcclxuICAgICAgICAgICAgICAgICAgICBhY3RpdmVCYXRjaElkID0gYWN0aXZlLml0ZW0uaWQ7XHJcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmFzc2lnbihzdGF0ZSwgYWN0aXZlLmVkaXRvcik7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVuZGVyVHJlZSgpOyByZW5kZXJGb250TWFwKCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2UgYXdhaXQgYWN0aXZhdGVGcmFtZShhY3RpdmUuaXRlbS5pZCk7XHJcbiAgICAgICAgICAgICAgICByZW5kZXJCYXRjaCgpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoLmxhc3RSZXN1bHQpIGNvbXBsZXRlQmF0Y2hQcmVzZW50YXRpb24oYmF0Y2gubGFzdFJlc3VsdCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2gucnVubmluZykge1xyXG4gICAgICAgICAgICAgICAgICAgIGJhdGNoUHJvZ3Jlc3MgPSBiYXRjaC5ydW5uaW5nOyB3b3JrZmxvdy5iZWdpbignaW1wb3J0Jyk7IHNldEJ1c3kodHJ1ZSk7IHdhdGNoUmVzdG9yZWRCYXRjaCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+ivt+mHjeWQryBDb2Nvcyc7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oa7JztcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn5qOA5rWL5Yiw5pen54mI5Li76L+b56iL5LuN5Zyo6L+Q6KGM77ya6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIC8vIFJlcGxheSBwZXJzaXN0ZWQgaW4tbWVtb3J5IHJlcG9ydCBpZiBjb21wbGV0aW9uIHByZWNlZGVkIHBhbmVsIHJlYWRpbmVzcy5cclxuICAgICAgICAgICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgICAgICAgICBpZiAocmV2aWV3KSB3b3JrZmxvdy5yZW1lbWJlclJldmlldygpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJldmlldyAmJiAhcmV2aWV3LmNvbmZpcm1lZCAmJiAhYmF0Y2hJdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgICAgICAgICB3b3JrZmxvdy5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WIneWni+WMluWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcbiAgICBiZWZvcmVDbG9zZSgpIHt9LFxyXG4gICAgY2xvc2UoKSB7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/LmRpc3Bvc2UoKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG51bGw7XHJcbiAgICAgICAgd29ya2Zsb3cgPSBudWxsO1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIGlmICh0b2FzdFRpbWVyKSBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7XHJcbiAgICAgICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpZiAoYmF0Y2hSZWNvdmVyeVRpbWVyKSBjbGVhclRpbWVvdXQoYmF0Y2hSZWNvdmVyeVRpbWVyKTtcclxuICAgICAgICBiYXRjaEl0ZW1zID0gW107IGFjdGl2ZUJhdGNoSWQgPSB1bmRlZmluZWQ7IGJhdGNoUmVzdWx0ID0gdW5kZWZpbmVkOyBiYXRjaFByb2dyZXNzID0gdW5kZWZpbmVkO1xyXG4gICAgICAgIGJhdGNoSW1wb3J0UGVuZGluZyA9IGZhbHNlOyBiYXRjaFN5bmNFcnJvciA9IHVuZGVmaW5lZDsgYmF0Y2hTeW5jVGFzayA9IFByb21pc2UucmVzb2x2ZSgpOyBwcmV2aWV3UmV2aXNpb24rKztcclxuICAgICAgICBwcmV2aWV3UmVhZFRhc2sgPSBQcm9taXNlLnJlc29sdmUoKTtcclxuICAgICAgICBwYW5lbEhvc3QgPSBudWxsO1xyXG4gICAgfSxcclxufSk7XHJcbiJdfQ==