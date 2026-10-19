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
    var _a, _b, _c, _d;
    const list = element('#font-map-list');
    list.replaceChildren();
    const families = (_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.fonts) !== null && _b !== void 0 ? _b : [];
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
        const selected = (_d = (_c = state.settings.fontMap[family]) !== null && _c !== void 0 ? _c : automatic === null || automatic === void 0 ? void 0 : automatic.url) !== null && _d !== void 0 ? _d : '';
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
function initializeDocument(document) {
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
    if (state.document) {
        for (const family of state.document.fonts) {
            delete fontMap[family];
        }
    }
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
        const progress = importProgress(event);
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
    renderTree();
    element('#preview-meta').textContent = `${effectiveNodeName(node)} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    const stage = element('#preview-stage');
    const image = element('#preview-image');
    stage.classList.add('is-loading');
    stage.classList.remove('has-image');
    image.removeAttribute('src');
    try {
        const result = await request('get-preview', node.id);
        if (state.selectedId !== node.id) {
            return;
        }
        await new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('预览图片加载失败。'));
            image.src = result.url;
        });
        stage.classList.add('has-image');
    }
    catch (error) {
        showToast(error instanceof Error ? error.message : '预览失败。', true);
    }
    finally {
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
        var _a;
        if (state.busy)
            return;
        const forceRead = forceDocumentRead;
        forceDocumentRead = false;
        if (workflow && !workflow.credentialsReady) {
            workflow.openCredentials();
            return;
        }
        if (!forceRead && (workflow === null || workflow === void 0 ? void 0 : workflow.sourceUnchanged())) {
            workflow.navigate(2);
            return;
        }
        const source = element('#source-url').value.trim();
        if (!source) {
            showToast('请输入 Figma 文件或节点链接。', true);
            return;
        }
        workflow === null || workflow === void 0 ? void 0 : workflow.begin('fetch');
        setBusy(true);
        updateProgress({ phase: 'fetch', value: 0.05, message: '正在连接 Figma…' });
        try {
            const document = await request('fetch-document', source);
            state.fontAssets = (_a = document.fontAssets) !== null && _a !== void 0 ? _a : state.fontAssets;
            initializeDocument(document);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '读取失败。';
            if (!(workflow === null || workflow === void 0 ? void 0 : workflow.cancelled))
                workflow === null || workflow === void 0 ? void 0 : workflow.fail(message);
            showToast((workflow === null || workflow === void 0 ? void 0 : workflow.cancelled) ? '读取已取消，配置已保留。' : message, !(workflow === null || workflow === void 0 ? void 0 : workflow.cancelled));
        }
        finally {
            workflow === null || workflow === void 0 ? void 0 : workflow.end();
            setBusy(false);
            updateSummary();
        }
    });
    element('#refresh-document').addEventListener('click', () => {
        if (state.busy)
            return;
        forceDocumentRead = true;
        element('#fetch-document').click();
    });
    element('#source-url').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            element('#fetch-document').click();
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
        workflow === null || workflow === void 0 ? void 0 : workflow.cancelRequested();
        try {
            await request('cancel-import');
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
        var _a;
        panelHost = this;
        importReviewPanel = new import_review_1.ImportReviewPanel(root(), request, setBusy);
        workflow = new workflow_1.PanelWorkflow(root(), () => state, (tab) => { void openImportReview(tab); });
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
                if (review && !review.confirmed) {
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
        panelHost = null;
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFDcEQseUNBQWdFO0FBRWhFLGdEQUEyRTtBQUMzRSx5REFBNkQ7QUFDN0QsK0NBQW1EO0FBQ25ELG1DQVVpQjtBQW1FakIsSUFBSSxTQUFTLEdBQVEsSUFBSSxDQUFDO0FBQzFCLElBQUksaUJBQWlCLEdBQTZCLElBQUksQ0FBQztBQUN2RCxJQUFJLFFBQVEsR0FBeUIsSUFBSSxDQUFDO0FBQzFDLElBQUksbUJBQW1CLEdBQXdCLElBQUksQ0FBQztBQUNwRCxJQUFJLGlCQUFpQixHQUFHLEtBQUssQ0FBQztBQUM5QixJQUFJLFVBQVUsR0FBeUMsSUFBSSxDQUFDO0FBQzVELElBQUksc0JBQXNCLEdBQXlDLElBQUksQ0FBQztBQUN4RSxJQUFJLG9CQUFvQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDNUQsSUFBSSxxQkFBeUMsQ0FBQztBQUM5QyxJQUFJLGtCQUFzQyxDQUFDO0FBRTNDLE1BQU0sS0FBSyxHQUFlO0lBQ3RCLFFBQVEsRUFBRSxJQUFJO0lBQ2QsUUFBUSxFQUFFO1FBQ04sU0FBUyxFQUFFLEVBQUU7UUFDYixXQUFXLEVBQUUsZ0JBQWdCO1FBQzdCLFlBQVksRUFBRSx3QkFBd0I7UUFDdEMsb0JBQW9CLEVBQUUsRUFBRTtRQUN4QixtQkFBbUIsRUFBRSxFQUFFO1FBQ3ZCLEtBQUssRUFBRSxDQUFDO1FBQ1IsY0FBYyxFQUFFLElBQUk7UUFDcEIsYUFBYSxFQUFFLEtBQUs7UUFDcEIsUUFBUSxFQUFFLEtBQUs7UUFDZixPQUFPLEVBQUUsRUFBRTtLQUNkO0lBQ0QsZ0JBQWdCLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDM0IsT0FBTyxFQUFFLElBQUks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QUNiLFNBQVMsQ0FBQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDdkUsQ0FBQztJQUNMLENBQUM7SUFDRCxXQUFXLEtBQUksQ0FBQztJQUNoQixLQUFLO1FBQ0QsaUJBQWlCLGFBQWpCLGlCQUFpQix1QkFBakIsaUJBQWlCLENBQUUsT0FBTyxFQUFFLENBQUM7UUFDN0IsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1FBQ3pCLFFBQVEsR0FBRyxJQUFJLENBQUM7UUFDaEIsbUJBQW1CLEdBQUcsSUFBSSxDQUFDO1FBQzNCLElBQUksVUFBVTtZQUFFLFlBQVksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUN6QyxJQUFJLHNCQUFzQjtZQUFFLFlBQVksQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO1FBQ2pFLFNBQVMsR0FBRyxJQUFJLENBQUM7SUFDckIsQ0FBQztDQUNKLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ3BhdGgnO1xyXG5pbXBvcnQgcGFja2FnZUpTT04gZnJvbSAnLi4vLi4vLi4vcGFja2FnZS5qc29uJztcclxuaW1wb3J0IHsgSW1wb3J0UmV2aWV3UGFuZWwgfSBmcm9tICcuL2ltcG9ydC1yZXZpZXcnO1xyXG5pbXBvcnQgeyBQYW5lbFdvcmtmbG93LCB0eXBlIFdvcmtmbG93UmVzdWx0IH0gZnJvbSAnLi93b3JrZmxvdyc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi4vLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGZpbmRGb250QXNzZXQsIHR5cGUgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuLi8uLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuLi8uLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IGltcG9ydFJldmlld1BhbmVsOiBJbXBvcnRSZXZpZXdQYW5lbCB8IG51bGwgPSBudWxsO1xyXG5sZXQgd29ya2Zsb3c6IFBhbmVsV29ya2Zsb3cgfCBudWxsID0gbnVsbDtcclxubGV0IHBlbmRpbmdJbXBvcnRSZXZpZXc6IEltcG9ydFJldmlldyB8IG51bGwgPSBudWxsO1xyXG5sZXQgZm9yY2VEb2N1bWVudFJlYWQgPSBmYWxzZTtcclxubGV0IHRvYXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBpbXBvcnRCdXR0b25SZXNldFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHJvdW5kdHJpcFByZXZpZXdUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgcm91bmR0cmlwUGFpclRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcblxyXG5jb25zdCBzdGF0ZTogUGFuZWxTdGF0ZSA9IHtcclxuICAgIGRvY3VtZW50OiBudWxsLFxyXG4gICAgc2V0dGluZ3M6IHtcclxuICAgICAgICBzb3VyY2VVcmw6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXInLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyL3ByZWZhYnMnLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBbXSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiAnJyxcclxuICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBmYWxzZSxcclxuICAgICAgICBhdXRvU2F2ZTogZmFsc2UsXHJcbiAgICAgICAgZm9udE1hcDoge30sXHJcbiAgICB9LFxyXG4gICAgcHJlZmVycmVkQWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAgYWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAga2luZHM6IG5ldyBNYXAoKSxcclxuICAgIHBhdGNoZXM6IG5ldyBTZXQoKSxcclxuICAgIGV4cGxpY2l0SWRzOiBuZXcgU2V0KCksXHJcbiAgICBuYW1lczogbmV3IE1hcCgpLFxyXG4gICAgcmVuYW1lZElkczogbmV3IFNldCgpLFxyXG4gICAgZGVmYXVsdHM6IG5ldyBNYXAoKSxcclxuICAgIGNvbGxhcHNlZDogbmV3IFNldCgpLFxyXG4gICAgc3VwcHJlc3NlZDogbmV3IFNldCgpLFxyXG4gICAgc2VhcmNoOiAnJyxcclxuICAgIGJ1c3k6IGZhbHNlLFxyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IHRydWUsXHJcbiAgICBmb250QXNzZXRzOiBbXSxcclxufTtcclxuXHJcbmZ1bmN0aW9uIHJvb3QoKTogSFRNTEVsZW1lbnQge1xyXG4gICAgcmV0dXJuIHBhbmVsSG9zdC4kLmFwcCBhcyBIVE1MRWxlbWVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gZWxlbWVudDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQ+KHNlbGVjdG9yOiBzdHJpbmcpOiBUIHtcclxuICAgIGNvbnN0IHZhbHVlID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpO1xyXG4gICAgaWYgKCF2YWx1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUGFuZWwgZWxlbWVudCBub3QgZm91bmQ6ICR7c2VsZWN0b3J9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlcXVlc3Q8VD4obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pOiBQcm9taXNlPFQ+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KHBhY2thZ2VKU09OLm5hbWUsIG1lc3NhZ2UsIC4uLmFyZ3MpIGFzIFQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNob3dUb2FzdChtZXNzYWdlOiBzdHJpbmcsIGVycm9yID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRvYXN0ID0gZWxlbWVudDxIVE1MRGl2RWxlbWVudD4oJyN0b2FzdCcpO1xyXG4gICAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7XHJcbiAgICBjb25zdCBjcmVkZW50aWFsRGlhbG9nID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8SFRNTERpYWxvZ0VsZW1lbnQ+KCcjY3JlZGVudGlhbC1kaWFsb2cnKTtcclxuICAgIGNvbnN0IGNyZWRlbnRpYWxTdGF0dXMgPSByb290KCkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJyNjcmVkZW50aWFsLXN0YXR1cycpO1xyXG4gICAgaWYgKGNyZWRlbnRpYWxEaWFsb2c/Lm9wZW4gJiYgY3JlZGVudGlhbFN0YXR1cykge1xyXG4gICAgICAgIGNyZWRlbnRpYWxTdGF0dXMuaGlkZGVuID0gZmFsc2U7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICAgICAgY3JlZGVudGlhbFN0YXR1cy5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIH1cclxuICAgIGlmICh0b2FzdFRpbWVyKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRvYXN0VGltZXIpO1xyXG4gICAgfVxyXG4gICAgdG9hc3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3QuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpLCAzNDAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duLCBmYWxsYmFjazogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIGVycm9yLm1lc3NhZ2UpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3IubWVzc2FnZTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnICYmIGVycm9yLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvcjtcclxuICAgIH1cclxuICAgIGlmIChlcnJvciAmJiB0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnICYmICdtZXNzYWdlJyBpbiBlcnJvclxyXG4gICAgICAgICYmIHR5cGVvZiAoZXJyb3IgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9KS5tZXNzYWdlID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIHJldHVybiAoZXJyb3IgYXMgeyBtZXNzYWdlOiBzdHJpbmcgfSkubWVzc2FnZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxsYmFjaztcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0Q29ubmVjdGlvbih2YXVsdDoge1xyXG4gICAgaGFzVG9rZW46IGJvb2xlYW47XHJcbiAgICBwZXJzaXN0ZW50OiBib29sZWFuO1xyXG4gICAgYmFja2VuZDogc3RyaW5nO1xyXG4gICAgd2FybmluZz86IHN0cmluZztcclxufSk6IHZvaWQge1xyXG4gICAgY29uc3QgcGlsbCA9IGVsZW1lbnQoJyNjb25uZWN0aW9uLXBpbGwnKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb25saW5lJywgdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vZmZsaW5lJywgIXZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIGVsZW1lbnQoJyNjb25uZWN0aW9uLWxhYmVsJykudGV4dENvbnRlbnQgPSB2YXVsdC5oYXNUb2tlbiA/ICflh63mja7lsLHnu6onIDogJ+acqui/nuaOpSc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtYmFkZ2UnKS50ZXh0Q29udGVudCA9IHZhdWx0LnBlcnNpc3RlbnQgPyAn57O757uf5Yqg5a+GJyA6ICfkvJror53lrZjlgqgnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHZhdWx0Lndhcm5pbmdcclxuICAgICAgICA/PyAodmF1bHQucGVyc2lzdGVudCA/IGDnlLEgJHt2YXVsdC5iYWNrZW5kfSDliqDlr4bvvIzpobnnm67kuK3ku4Xkv53lrZjpnZ7mlY/mhJ/orr7nva5gIDogJ1Rva2VuIOS4jeWGmeWFpemhueebruaWh+S7ticpO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjdmVyaWZ5LXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjY2xlYXItdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbiAgICB3b3JrZmxvdz8uc2V0Q29ubmVjdGlvbih2YXVsdC5oYXNUb2tlbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW4obm9kZXM6IFRyZWVOb2RlRHRvW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2Rlcy5mbGF0TWFwKChub2RlKSA9PiBbbm9kZSwgLi4uZmxhdHRlbihub2RlLmNoaWxkcmVuKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kTm9kZShpZDogc3RyaW5nLCBub2RlcyA9IHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdKTogVHJlZU5vZGVEdG8gfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuaWQgPT09IGlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZCA9IGZpbmROb2RlKGlkLCBub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICBpZiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckZvbnRNYXAoKTogdm9pZCB7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBmYW1pbGllcyA9IHN0YXRlLmRvY3VtZW50Py5mb250cyA/PyBbXTtcclxuICAgIGlmICghZmFtaWxpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDlkI7vvIzov5nph4zkvJrliJflh7rmo4DmtYvliLDnmoTlrZfkvZPjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZm9udEFzc2V0cy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSBpcy13YXJuaW5nJztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfpobnnm64gYXNzZXRzIOWGheayoeacieajgOa1i+WIsCAudHRmIC8gLm90ZiAvIC5mbnQgLyAud29mZiDlrZfkvZPotYTmupDjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBmYW1pbHkgb2YgZmFtaWxpZXMpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICByb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXJvdyc7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIHNvdXJjZS5jbGFzc05hbWUgPSAnZm9udC1tYXAtc291cmNlJztcclxuICAgICAgICBzb3VyY2UudGV4dENvbnRlbnQgPSBmYW1pbHk7XHJcbiAgICAgICAgc291cmNlLnRpdGxlID0gZmFtaWx5O1xyXG4gICAgICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIGFycm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1hcnJvdyc7XHJcbiAgICAgICAgYXJyb3cudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgICAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgICAgICBzZWxlY3QuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNlbGVjdCc7XHJcbiAgICAgICAgc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseSA9IGZhbWlseTtcclxuICAgICAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7ZmFtaWx5fSDmmKDlsITlrZfkvZNgKTtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKCcnLCAn5LiN5pig5bCE77yI5L2/55So6buY6K6k5a2X5L2T77yJJykpO1xyXG4gICAgICAgIGNvbnN0IGF1dG9tYXRpYyA9IGZpbmRGb250QXNzZXQoZmFtaWx5LCBzdGF0ZS5mb250QXNzZXRzKTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHN0YXRlLnNldHRpbmdzLmZvbnRNYXBbZmFtaWx5XSA/PyBhdXRvbWF0aWM/LnVybCA/PyAnJztcclxuICAgICAgICBmb3IgKGNvbnN0IGFzc2V0IG9mIHN0YXRlLmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IG9wdGlvbihhc3NldC51cmwsIGAke2Fzc2V0Lm5hbWV9IMK3ICR7YXNzZXQucmVsYXRpdmVQYXRofWApO1xyXG4gICAgICAgICAgICBpdGVtLnNlbGVjdGVkID0gYXNzZXQudXJsID09PSBzZWxlY3RlZDtcclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGl0ZW0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZWxlY3QudmFsdWUgPSBzZWxlY3RlZDtcclxuICAgICAgICByb3cuYXBwZW5kKHNvdXJjZSwgYXJyb3csIHNlbGVjdCk7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlQWN0aW9uKF9ub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiB1bmtub3duKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIHJldHVybiBub3JtYWxpemVJbXBvcnRBY3Rpb24oYWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50OiBEb2N1bWVudER0byk6IHZvaWQge1xyXG4gICAgc3RhdGUuZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmtpbmRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgc3RhdGUubmFtZXMuY2xlYXIoKTtcclxuICAgIHN0YXRlLnJlbmFtZWRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmRlZmF1bHRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5jb2xsYXBzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnN1cHByZXNzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBkb2N1bWVudC50cmVlWzBdPy5pZDtcclxuICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIGZsYXR0ZW4oZG9jdW1lbnQudHJlZSkpIHtcclxuICAgICAgICBjb25zdCBhY3Rpb24gPSBzbWFydEFjdGlvbkZvck5vZGUobm9kZSk7XHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgYWN0aW9uKTtcclxuICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgbm9kZS5raW5kKTtcclxuICAgICAgICBzdGF0ZS5kZWZhdWx0cy5zZXQobm9kZS5pZCwgeyBhY3Rpb24sIGtpbmQ6IG5vZGUua2luZCB9KTtcclxuICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgbm9kZS5uYW1lKTtcclxuICAgIH1cclxuICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKGRvY3VtZW50LnRyZWUpO1xyXG4gICAgZm9yIChjb25zdCBvdmVycmlkZSBvZiBkb2N1bWVudC5ub2RlT3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKG92ZXJyaWRlLmlkLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChjdXN0b21OYW1lICYmIGN1c3RvbU5hbWUgIT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgY3VzdG9tTmFtZSk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBvdmVycmlkZS5hY3Rpb24pKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG92ZXJyaWRlLmtpbmQpO1xyXG4gICAgICAgICAgICBpZiAob3ZlcnJpZGUubmluZVNsaWNlICYmIG5vZGUucGF0Y2hDYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKFxyXG4gICAgICAgICAgICAnYWN0aXZlJyxcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuc2l6ZSA9PT0gMCAmJiBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09ICdzbWFydCcsXHJcbiAgICAgICAgKTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2ZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZmlsZU5hbWU7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gZG9jdW1lbnQuc291cmNlVXJsO1xyXG4gICAgZWxlbWVudCgnI2ZvbnQtaGludCcpLnRleHRDb250ZW50ID0gZG9jdW1lbnQuZm9udHMubGVuZ3RoXHJcbiAgICAgICAgPyBg5qOA5rWL5Yiw77yaJHtkb2N1bWVudC5mb250cy5qb2luKCfjgIEnKX1gXHJcbiAgICAgICAgOiAn5b2T5YmN5paH5Lu25bCa5pyq5Y+R546w5a2X5L2T44CCJztcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIHJlbmRlclRyZWUodHJ1ZSk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICB3b3JrZmxvdz8uZG9jdW1lbnRSZWFkeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IHZvaWQge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIHVwZGF0ZVRhcmdldEhpbnQoKTtcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxuICAgIHdvcmtmbG93Py5yZW5kZXIoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVhZFNldHRpbmdzKHNob3dFcnJvciA9IHRydWUpOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwge1xyXG4gICAgY29uc3QgZm9udE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uc3RhdGUuc2V0dGluZ3MuZm9udE1hcCB9O1xyXG4gICAgaWYgKHN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBmYW1pbHkgb2Ygc3RhdGUuZG9jdW1lbnQuZm9udHMpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGZvbnRNYXBbZmFtaWx5XTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoZmFtaWx5ICYmIHNlbGVjdC52YWx1ZSkge1xyXG4gICAgICAgICAgICBmb250TWFwW2ZhbWlseV0gPSBzZWxlY3QudmFsdWU7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzY2FsZSA9IE51bWJlcihlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPCAwLjI1IHx8IHNjYWxlID4gNCkge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCflr7zlhaXlgI3njoflv4XpobvlnKggMC4yNSDliLAgNCDkuYvpl7TjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhc3NldEZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWFzc2V0Rm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemhueebriBhc3NldHMg5LiL55qE6LWE5rqQ6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJlZmFiRm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXByZWZhYkZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npooTliLbkvZPovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzIH0sIChfLCBpbmRleCkgPT5cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICApLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNsb2NhbC1yZXNvdXJjZS1mb2xkZXItMCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCxcclxuICAgICAgICBhdXRvU2F2ZTogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEJ1c3kodmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIHZhbHVlID0gdmFsdWUgfHwgQm9vbGVhbih3b3JrZmxvdz8ucGVuZGluZyk7XHJcbiAgICBzdGF0ZS5idXN5ID0gdmFsdWU7XHJcbiAgICAvLyBDYXB0dXJlIGVkaXRhYmxlIGNvbnRyb2wgc3RhdGVzIGJlZm9yZSB0aGUgZXhpc3RpbmcgYnV0dG9uIGxvY2sgY2hhbmdlcyB0aGVtLlxyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3NhdmUtdG9rZW4nKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLWFzc2V0LWZvbGRlcicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stcHJlZmFiLWZvbGRlcicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1kZXRlY3QnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcHJldmlldycpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PihgI3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PihgI2NsZWFyLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgIXN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5jbGFzc0xpc3QudG9nZ2xlKCdpcy1oaWRkZW4nLCAhdmFsdWUpO1xyXG4gICAgd29ya2Zsb3c/LnJlbmRlcigpO1xyXG4gICAgaWYgKCF2YWx1ZSkgcmVuZGVyTm9kZVByb3BlcnRpZXMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvdW5kdHJpcFNvdXJjZSgpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSDmlofku7bmiJboioLngrnpk77mjqXjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBzb3VyY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclJvdW5kdHJpcFByZXZpZXcocHJldmlldzogUm91bmR0cmlwUHJldmlld0R0byk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gcHJldmlldy5wcmV2aWV3VG9rZW47XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSBwcmV2aWV3LnBhaXJUb2tlbjtcclxuICAgIGNvbnN0IGxpbmVzID0gW1xyXG4gICAgICAgIGDnm67moIfvvJoke3ByZXZpZXcuYXNzZXRVcmx9YCxcclxuICAgICAgICBgUHJlZmFi77yaJHtwcmV2aWV3LnByZWZhYlV1aWR9YCxcclxuICAgICAgICBgU3VyZmFjZe+8miR7cHJldmlldy5zdXJmYWNlSWR9IMK3IEZpZ21hICR7cHJldmlldy5maWdtYVZlcnNpb259IMK3IExlZGdlciAke3ByZXZpZXcubGVkZ2VyR2VuZXJhdGlvbn1gLFxyXG4gICAgICAgIGDlsIbkv67mlLkgJHtwcmV2aWV3LnBsYW4uYXBwbHkubGVuZ3RofSDpobkgwrcg5L+d55WZIENvY29zICR7cHJldmlldy5wbGFuLnByZXNlcnZlQ29jb3MubGVuZ3RofSDpobkgwrcg5bey5pS25pWbICR7cHJldmlldy5wbGFuLmNvbnZlcmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgYOWGsueqgSAke3ByZXZpZXcucGxhbi5jb25mbGljdHMubGVuZ3RofSDpobkgwrcg5LiN5pSv5oyBICR7cHJldmlldy5wbGFuLnVuc3VwcG9ydGVkLmxlbmd0aH0g6aG5IMK3IOWPquivu+acquaUuSAke3ByZXZpZXcucGxhbi5yZWFkb25seVVuY2hhbmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgcHJldmlldy5wYWlyUmVxdWlyZWRcclxuICAgICAgICAgICAgPyBwcmV2aWV3LnBhaXJFbGlnaWJsZSA/ICfpppbmrKHkvb/nlKjvvJror4Hmja7kuIDoh7TvvIzor7flhYjnoa7orqTphY3lr7kgU3VyZmFjZe+8iOWPquWGmSBsZWRnZXLvvIzkuI3mlLkgUHJlZmFi77yJ44CCJyA6ICfpppbmrKHkvb/nlKjvvJpQYWlyIOivgeaNruS4jeS4gOiHtO+8jOmcgOS7juW9k+WJjSBQcmVmYWIg6YeN5paw5a+85Ye644CCJ1xyXG4gICAgICAgICAgICA6IHByZXZpZXcuYmxvY2tlcnMubGVuZ3RoID8gYOmYu+aWre+8miR7cHJldmlldy5ibG9ja2Vycy5qb2luKCcsICcpfWAgOiAn6aKE6KeI6YCa6L+H77yM5Y+v5Y6f5a2Q5bqU55So5pW05Liq5LiN5Y+v5Y+Y6K6h5YiS44CCJyxcclxuICAgIF07XHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVUYXJnZXRIaW50KCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOmcgOimgeWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9yJztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlvZPliY3lnLrmma8gQ2FudmFzIOagueiKgueCueS4i++8m0ZyYW1lIOmTvuaOpeWwhuiHquWKqOWIm+W7uuW5tuaJk+W8gOmihOWItuS9kyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0SW1wb3J0QnV0dG9uKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgIGJ1dHRvbi50aXRsZSA9ICflr7zlhaXliLDlvZPliY3miZPlvIDlnLrmma/miJbpooTliLbkvZMnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflvIDlp4vlr7zlhaUnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMCUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbXBvcnRQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuMDUgKyB2YWx1ZSAqIDAuNTU7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdzY2VuZScpIHtcclxuICAgICAgICByZXR1cm4gMC42ICsgdmFsdWUgKiAwLjM4O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGV2ZW50LnBoYXNlID09PSAnZG9uZScgPyAxIDogMDtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIGlmIChbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKSkgc2V0QnVzeSh0cnVlKTtcclxuICAgIHdvcmtmbG93Py5wcm9ncmVzcyhldmVudCk7XHJcbiAgICBjb25zdCByZWdpb24gPSBlbGVtZW50KCcjcHJvZ3Jlc3MtcmVnaW9uJyk7XHJcbiAgICBjb25zdCBidXN5ID0gWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtYnVzeScsIGJ1c3kpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWVycm9yJywgZXZlbnQucGhhc2UgPT09ICdlcnJvcicpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQodmFsdWUgKiAxMDApfSVgO1xyXG4gICAgKGVsZW1lbnQoJyNwcm9ncmVzcy1iYXInKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHt2YWx1ZSAqIDEwMH0lYDtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgY29uc3QgaW1wb3J0aW5nID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnO1xyXG4gICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcik7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoaW1wb3J0aW5nKSB7XHJcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBpbXBvcnRQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXJ1bm5pbmcnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtc3VjY2VzcycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoJ2FyaWEtYnVzeScsICd0cnVlJyk7XHJcbiAgICAgICAgYnV0dG9uLnRpdGxlID0gZXZlbnQubWVzc2FnZTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnID8gJ+WHhuWkh+i1hOa6kCcgOiAn5p6E5bu66IqC54K5JztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSBgJHtNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKX0lYDtcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHtwcm9ncmVzcyAqIDEwMH0lYDtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdkb25lJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWujOaIkCc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJzEwMCUnO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcxMDAlJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTQwMCk7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZXJyb3InIHx8IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnID8gJ+W3suWPlua2iCcgOiAn5a+85YWl5aSx6LSlJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn6YeN6K+VJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTgwMCk7XHJcbiAgICB9XHJcbiAgICBpZiAoWydkb25lJywgJ2Vycm9yJywgJ2NhbmNlbGxlZCcsICdpZGxlJ10uaW5jbHVkZXMoZXZlbnQucGhhc2UpKSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdkb25lJyAmJiAhd29ya2Zsb3c/LnBlbmRpbmcgJiYgcGVuZGluZ0ltcG9ydFJldmlldykge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHBlbmRpbmdJbXBvcnRSZXZpZXc7XHJcbiAgICAgICAgcGVuZGluZ0ltcG9ydFJldmlldyA9IG51bGw7XHJcbiAgICAgICAgd29ya2Zsb3c/LmNvbXBsZXRlKHsgcmV2aWV3IH0pO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2NlbmRhbnRzKG5vZGU6IFRyZWVOb2RlRHRvKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5mbGF0TWFwKChjaGlsZCkgPT4gW2NoaWxkLCAuLi5kZXNjZW5kYW50cyhjaGlsZCldKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVjb25jaWxlQWN0aW9ucygpOiB2b2lkIHtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKFxyXG4gICAgICAgIHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdLFxyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMsXHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyxcclxuICAgICAgICBzdGF0ZS5leHBsaWNpdElkcyxcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLFxyXG4gICAgKTtcclxuICAgIHN0YXRlLmFjdGlvbnMgPSBlZmZlY3RpdmUuYWN0aW9ucztcclxuICAgIHN0YXRlLnN1cHByZXNzZWQgPSBlZmZlY3RpdmUuc3VwcHJlc3NlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IEltcG9ydEFjdGlvbik6IHZvaWQge1xyXG4gICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBhY3Rpb24pKTtcclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0aXZlTm9kZU5hbWUobm9kZTogVHJlZU5vZGVEdG8pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0YXRlLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4cGxpY2l0T3ZlcnJpZGVzKCk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpXHJcbiAgICAgICAgLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpKVxyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVuYW1lZCA9IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIC4uLihyZW5hbWVkID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlS2V5ID0gc3RhdGUuZG9jdW1lbnQuZmlsZUtleTtcclxuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGV4cGxpY2l0T3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub2RlLmlkKTtcclxuICAgIC8vIFNlcmlhbGl6ZSB3cml0ZXMgc28gYSBzbG93ZXIgZWFybGllciByZXF1ZXN0IGNhbiBuZXZlciBvdmVyd3JpdGUgYSBuZXdlclxyXG4gICAgLy8gc3RyYXRlZ3kgc25hcHNob3QgYWZ0ZXIgcmFwaWQgc2VsZWN0IGNoYW5nZXMuXHJcbiAgICBub2RlT3ZlcnJpZGVTYXZlVGFzayA9IG5vZGVPdmVycmlkZVNhdmVUYXNrXHJcbiAgICAgICAgLmNhdGNoKCgpID0+IHVuZGVmaW5lZClcclxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3Q8SW1wb3J0T3ZlcnJpZGVbXT4oJ3NhdmUtbm9kZS1vdmVycmlkZXMnLCBmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+iKgueCueetlueVpeS/neWtmOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF0Y2hlcyhub2RlOiBUcmVlTm9kZUR0byk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhheXN0YWNrID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9ICR7bm9kZS5uYW1lfSAke25vZGUudHlwZX0gJHtub2RlLmlkfWAudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChoYXlzdGFjay5pbmNsdWRlcyhzdGF0ZS5zZWFyY2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKG1hdGNoZXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb24odmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEhUTUxPcHRpb25FbGVtZW50IHtcclxuICAgIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgIGl0ZW0udmFsdWUgPSB2YWx1ZTtcclxuICAgIGl0ZW0udGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYWtlU2VsZWN0KFxyXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogc3RyaW5nLFxyXG4gICAgaXRlbXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+LFxyXG4gICAgbGFiZWw6IHN0cmluZyxcclxuKTogSFRNTFNlbGVjdEVsZW1lbnQge1xyXG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICBzZWxlY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGxhYmVsKTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgdGV4dF0gb2YgaXRlbXMpIHtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKGtleSwgdGV4dCkpO1xyXG4gICAgfVxyXG4gICAgc2VsZWN0LnZhbHVlID0gdmFsdWU7XHJcbiAgICByZXR1cm4gc2VsZWN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBlbmRUcmVlTm9kZShjb250YWluZXI6IEhUTUxFbGVtZW50LCBub2RlOiBUcmVlTm9kZUR0bywgZGVwdGg6IG51bWJlcik6IHZvaWQge1xyXG4gICAgaWYgKCFtYXRjaGVzKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICByb3cuY2xhc3NOYW1lID0gYHRyZWUtcm93JHtzdGF0ZS5zZWxlY3RlZElkID09PSBub2RlLmlkID8gJyBpcy1zZWxlY3RlZCcgOiAnJ31gO1xyXG4gICAgcm93LmRhdGFzZXQubm9kZUlkID0gbm9kZS5pZDtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndHJlZWl0ZW0nKTtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGV2ZWwnLCBTdHJpbmcoZGVwdGggKyAxKSk7XHJcblxyXG4gICAgY29uc3QgbWFpbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWFpbi5jbGFzc05hbWUgPSAnbm9kZS1tYWluJztcclxuICAgIG1haW4uc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTtcclxuICAgIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgICBjb2xsYXBzZS5jbGFzc05hbWUgPSBgY29sbGFwc2Uke25vZGUuY2hpbGRyZW4ubGVuZ3RoID8gJycgOiAnIGlzLWxlYWYnfWA7XHJcbiAgICBjb2xsYXBzZS50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBjb2xsYXBzZS5kYXRhc2V0LmNvbGxhcHNlID0gbm9kZS5pZDtcclxuICAgIGNvbGxhcHNlLnRleHRDb250ZW50ID0gc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICfigLonIDogJ+KMhCc7XHJcbiAgICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+WxleW8gCcgOiAn5oqY5Y+gJyk7XHJcbiAgICBjb25zdCBkb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBkb3QuY2xhc3NOYW1lID0gYHR5cGUtZG90ICR7XHJcbiAgICAgICAgbm9kZS50eXBlID09PSAnVEVYVCcgPyAndGV4dCdcclxuICAgICAgICAgICAgOiBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAndmVjdG9yJ1xyXG4gICAgICAgICAgICAgICAgOiBub2RlLnR5cGUuaW5jbHVkZXMoJ0NPTVBPTkVOVCcpIHx8IG5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJyA/ICdjb21wb25lbnQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xyXG4gICAgfWA7XHJcbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBjb3B5LmNsYXNzTmFtZSA9ICdub2RlLWNvcHknO1xyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gYG5vZGUtbmFtZSR7c3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyAnIGlzLXJlbmFtZWQnIDogJyd9YDtcclxuICAgIG5hbWUudGV4dENvbnRlbnQgPSBkaXNwbGF5TmFtZTtcclxuICAgIGNvbnN0IHN0cmF0ZWd5U3VtbWFyeSA9IHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUobm9kZSwgc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpKTtcclxuICAgIG5hbWUudGl0bGUgPSBbXHJcbiAgICAgICAgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV9YCA6ICfpgInmi6noioLngrnvvIzlnKjlj7Pkvqfkv67mlLnlr7zlhaXoioLngrnlkI0nLFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkud2FybmluZyxcclxuICAgIF1cclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmpvaW4oJyDCtyAnKTtcclxuICAgIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1ldGEuY2xhc3NOYW1lID0gJ25vZGUtbWV0YSc7XHJcbiAgICBtZXRhLnRleHRDb250ZW50ID0gYCR7bm9kZS50eXBlfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb3B5LmFwcGVuZChuYW1lLCBtZXRhKTtcclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kpIHtcclxuICAgICAgICBjb25zdCBzdHJhdGVneSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHN0cmF0ZWd5LmNsYXNzTmFtZSA9ICdub2RlLXN0cmF0ZWd5JztcclxuICAgICAgICBzdHJhdGVneS50ZXh0Q29udGVudCA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBzdHJhdGVneS50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHN0cmF0ZWd5KTtcclxuICAgIH1cclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkud2FybmluZykge1xyXG4gICAgICAgIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICB3YXJuaW5nLmNsYXNzTmFtZSA9ICdub2RlLXdhcm5pbmcnO1xyXG4gICAgICAgIHdhcm5pbmcudGV4dENvbnRlbnQgPSBg4pqgICR7c3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmd9YDtcclxuICAgICAgICB3YXJuaW5nLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmc7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZCh3YXJuaW5nKTtcclxuICAgIH1cclxuICAgIHJvdy5jbGFzc0xpc3QudG9nZ2xlKCdoYXMtZGV0YWlsJywgQm9vbGVhbihzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpKTtcclxuICAgIG1haW4uYXBwZW5kKGNvbGxhcHNlLCBkb3QsIGNvcHkpO1xyXG5cclxuICAgIGNvbnN0IGFjdGlvbkJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgYWN0aW9uQmFkZ2UuY2xhc3NOYW1lID0gJ25vZGUtYWN0aW9uLWJhZGdlJztcclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBhY3Rpb25CYWRnZS50ZXh0Q29udGVudCA9IGFjdGlvbk9wdGlvbnNGb3JOb2RlKG5vZGUpLmZpbmQoKFt2YWx1ZV0pID0+IHZhbHVlID09PSBzZWxlY3RlZEFjdGlvbik/LlsxXSA/PyBzZWxlY3RlZEFjdGlvbjtcclxuICAgIGFjdGlvbkJhZGdlLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5IHx8IGFjdGlvbkJhZGdlLnRleHRDb250ZW50O1xyXG4gICAgcm93LmFwcGVuZChtYWluLCBhY3Rpb25CYWRnZSk7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuXHJcbiAgICBpZiAoIXN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgfHwgc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyLCBjaGlsZCwgZGVwdGggKyAxKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk6IHZvaWQge1xyXG4gICAgY29uc3QgY29udGFpbmVyID0gZWxlbWVudCgnI25vZGUtcHJvcGVydGllcycpO1xyXG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3Qgbm9kZSA9IHN0YXRlLnNlbGVjdGVkSWQgPyBmaW5kTm9kZShzdGF0ZS5zZWxlY3RlZElkKSA6IHVuZGVmaW5lZDtcclxuICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdpbnNwZWN0b3ItZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+mAieaLqeiKgueCue+8jOafpeeci+mihOiniOW5tuiwg+aVtOWvvOWFpeiuvue9ruOAgic7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgZmllbGQgPSAobGFiZWw6IHN0cmluZywgY29udHJvbDogSFRNTEVsZW1lbnQpOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xyXG4gICAgICAgIHJvdy5jbGFzc05hbWUgPSAnZmllbGQnO1xyXG4gICAgICAgIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgaGVhZGluZy50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgICAgIHJvdy5hcHBlbmQoaGVhZGluZywgY29udHJvbCk7XHJcbiAgICAgICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJvdyk7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBuYW1lLnR5cGUgPSAndGV4dCc7XHJcbiAgICBuYW1lLmNsYXNzTmFtZSA9ICdub2RlLW5hbWUtaW5wdXQnO1xyXG4gICAgbmFtZS52YWx1ZSA9IGRpc3BsYXlOYW1lO1xyXG4gICAgbmFtZS5tYXhMZW5ndGggPSA5NjtcclxuICAgIG5hbWUuc3BlbGxjaGVjayA9IGZhbHNlO1xyXG4gICAgbmFtZS5kYXRhc2V0Lm5hbWVGb3IgPSBub2RlLmlkO1xyXG4gICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtub2RlLm5hbWV9IOWvvOWFpeiKgueCueWQjWApO1xyXG4gICAgbmFtZS50aXRsZSA9IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX3vvJtFbnRlciDkv53lrZjvvIxFc2Mg5Y+W5raIYDtcclxuICAgIG5hbWUuZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeiKgueCueWQjScsIG5hbWUpO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBjb25zdCBhY3Rpb25PcHRpb25zID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSk7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdhY3Rpb24tc2VsZWN0JyxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBhY3Rpb25PcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDlr7zlhaXmlrnlvI9gLFxyXG4gICAgKTtcclxuICAgIGFjdGlvbi5kYXRhc2V0LmFjdGlvbkZvciA9IG5vZGUuaWQ7XHJcbiAgICBhY3Rpb24uZGlzYWJsZWQgPSBzdGF0ZS5idXN5O1xyXG4gICAgZmllbGQoJ+WvvOWFpeaWueW8jycsIGFjdGlvbik7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRLaW5kID0gc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZDtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICBub2RlLFxyXG4gICAgICAgIHNlbGVjdGVkS2luZCxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBraW5kT3B0aW9ucyA9IGtpbmRPcHRpb25zRm9yQWN0aW9uKHNlbGVjdGVkQWN0aW9uKTtcclxuICAgIGNvbnN0IGtpbmQgPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdraW5kLXNlbGVjdCcsXHJcbiAgICAgICAgZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBraW5kT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g6IqC54K557G75Z6LYCxcclxuICAgICk7XHJcbiAgICBraW5kLmRhdGFzZXQua2luZEZvciA9IG5vZGUuaWQ7XHJcbiAgICBraW5kLmRpc2FibGVkID0gc3RhdGUuYnVzeTtcclxuICAgIGZpZWxkKCfoioLngrnnsbvlnosnLCBraW5kKTtcclxuXHJcbiAgICBjb25zdCBwYXRjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICBwYXRjaC5jbGFzc05hbWUgPSAndG9nZ2xlLXJvdyBwYXRjaC10b2dnbGUnO1xyXG4gICAgcGF0Y2gudGl0bGUgPSBub2RlLnNsaWNlTW9kZVxyXG4gICAgICAgID8gYOWQr+eUqCR7bm9kZS5zbGljZU1vZGUgPT09ICduaW5lJyA/ICfkuZ3lrqvmoLwnIDogJ+S4ieWuq+agvCd95YiH54mHYFxyXG4gICAgICAgIDogbm9kZS5wYXRjaENhbmRpZGF0ZVxyXG4gICAgICAgICAgICA/ICflkK/nlKjoh6rliqjor4bliKvnmoTkuIkv5Lmd5a6r5qC85YiH54mHJ1xyXG4gICAgICAgICAgICA6ICfor6XoioLngrnkuI3mmK/oh6rliqjor4bliKvnmoTliIfniYflgJnpgIknO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9IHN0YXRlLmJ1c3kgfHwgIW5vZGUucGF0Y2hDYW5kaWRhdGU7XHJcbiAgICBjb25zdCBwYXRjaEljb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBwYXRjaEljb24udGV4dENvbnRlbnQgPSBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgPyBub2RlLnNsaWNlTW9kZSA9PT0gJ25pbmUnID8gJ+WQr+eUqOS5neWuq+WIh+eJhycgOiBub2RlLnNsaWNlTW9kZSA/ICflkK/nlKjkuInlrqvliIfniYcnIDogJ+WQr+eUqOS4iSAvIOS5neWuq+WIh+eJhydcclxuICAgICAgICA6ICfliIfniYcgwrcg6Z2e5YCZ6YCJ6IqC54K5JztcclxuICAgIHBhdGNoLmFwcGVuZChwYXRjaElucHV0LCBwYXRjaEljb24pO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHBhdGNoKTtcclxuICAgIGNvbnN0IHN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBjb25zdCBub3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBub3RlLmNsYXNzTmFtZSA9ICdub2RlLWluc3BlY3Rvci1ub3RlJztcclxuICAgIGZvciAoY29uc3QgdGV4dCBvZiBbc3VtbWFyeS5zdHJhdGVneSwgYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfWAsIHN1bW1hcnkud2FybmluZ10pIHtcclxuICAgICAgICBpZiAoIXRleHQpIGNvbnRpbnVlO1xyXG4gICAgICAgIGNvbnN0IHBhcmFncmFwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICBwYXJhZ3JhcGgudGV4dENvbnRlbnQgPSB0ZXh0O1xyXG4gICAgICAgIGlmICh0ZXh0ID09PSBzdW1tYXJ5Lndhcm5pbmcpIHBhcmFncmFwaC5jbGFzc05hbWUgPSAnbm9kZS13YXJuaW5nJztcclxuICAgICAgICBub3RlLmFwcGVuZENoaWxkKHBhcmFncmFwaCk7XHJcbiAgICB9XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQobm90ZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclRyZWUocmVzZXRTY3JvbGwgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdHJlZSA9IGVsZW1lbnQoJyN0cmVlJyk7XHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwodHJlZSwgKCkgPT4ge1xyXG4gICAgICAgIHRyZWUucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZW1wdHktc3RhdGUnO1xyXG4gICAgICAgICAgICBjb25zdCBnbHlwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICAgICAgZ2x5cGguY2xhc3NOYW1lID0gJ2VtcHR5LWdseXBoJztcclxuICAgICAgICAgICAgZ2x5cGgudGV4dENvbnRlbnQgPSAn4oazJztcclxuICAgICAgICAgICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcclxuICAgICAgICAgICAgdGl0bGUudGV4dENvbnRlbnQgPSAn6L+Y5rKh5pyJ6IqC54K5JztcclxuICAgICAgICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICAgICAgYm9keS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg6ZO+5o6l5ZCO77yM5Y+v6YCQ5bGC6YCJ5oup55Sf5oiQ44CBUE5HIOaVtOWxguaIluabtOaWsOOAgic7XHJcbiAgICAgICAgICAgIGVtcHR5LmFwcGVuZChnbHlwaCwgdGl0bGUsIGJvZHkpO1xyXG4gICAgICAgICAgICB0cmVlLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzdGF0ZS5kb2N1bWVudC50cmVlLmZvckVhY2goKG5vZGUpID0+IGFwcGVuZFRyZWVOb2RlKHRyZWUsIG5vZGUsIDApKTtcclxuICAgIH0sIHJlc2V0U2Nyb2xsKTtcclxuICAgIHJlbmRlck5vZGVQcm9wZXJ0aWVzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoKTogdm9pZCB7XHJcbiAgICBjb25zdCBub2RlcyA9IHN0YXRlLmRvY3VtZW50ID8gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKSA6IFtdO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBub2Rlcy5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpICE9PSAnaWdub3JlJyk7XHJcbiAgICBlbGVtZW50KCcjbm9kZS1jb3VudCcpLnRleHRDb250ZW50ID0gYCR7bm9kZXMubGVuZ3RofSDoioLngrlgO1xyXG4gICAgZWxlbWVudCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgID8gYCR7c2VsZWN0ZWQubGVuZ3RofSAvICR7bm9kZXMubGVuZ3RofSDkuKroioLngrnlsIblj4LkuI7lr7zlhaVgXHJcbiAgICAgICAgOiAn562J5b6F6K6+6K6h5pWw5o2uJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gc3RhdGUuYnVzeVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzZWxlY3RlZC5sZW5ndGhcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICB3b3JrZmxvdz8ucmVuZGVyKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXZpZXcobm9kZTogVHJlZU5vZGVEdG8pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc3RhdGUuc2VsZWN0ZWRJZCA9IG5vZGUuaWQ7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICBlbGVtZW50KCcjcHJldmlldy1tZXRhJykudGV4dENvbnRlbnQgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gwrcgJHtNYXRoLnJvdW5kKG5vZGUud2lkdGgpfcOXJHtNYXRoLnJvdW5kKG5vZGUuaGVpZ2h0KX1gO1xyXG4gICAgY29uc3Qgc3RhZ2UgPSBlbGVtZW50KCcjcHJldmlldy1zdGFnZScpO1xyXG4gICAgY29uc3QgaW1hZ2UgPSBlbGVtZW50PEhUTUxJbWFnZUVsZW1lbnQ+KCcjcHJldmlldy1pbWFnZScpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LmFkZCgnaXMtbG9hZGluZycpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LnJlbW92ZSgnaGFzLWltYWdlJyk7XHJcbiAgICBpbWFnZS5yZW1vdmVBdHRyaWJ1dGUoJ3NyYycpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgdXJsOiBzdHJpbmcgfT4oJ2dldC1wcmV2aWV3Jywgbm9kZS5pZCk7XHJcbiAgICAgICAgaWYgKHN0YXRlLnNlbGVjdGVkSWQgIT09IG5vZGUuaWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgICAgIGltYWdlLm9ubG9hZCA9ICgpID0+IHJlc29sdmUoKTtcclxuICAgICAgICAgICAgaW1hZ2Uub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ+mihOiniOWbvueJh+WKoOi9veWksei0peOAgicpKTtcclxuICAgICAgICAgICAgaW1hZ2Uuc3JjID0gcmVzdWx0LnVybDtcclxuICAgICAgICB9KTtcclxuICAgICAgICBzdGFnZS5jbGFzc0xpc3QuYWRkKCdoYXMtaW1hZ2UnKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mihOiniOWksei0peOAgicsIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdpcy1sb2FkaW5nJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5UHJlc2V0KG5hbWU6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGFsbCA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICBpZiAobmFtZSA9PT0gJ3NtYXJ0Jykge1xyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmNsZWFyKCk7XHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IHN0YXRlLmRlZmF1bHRzLmdldChub2RlLmlkKSE7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmFjdGlvbik7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvcmlnaW5hbC5raW5kKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG5hbWUgPT09ICdlZGl0YWJsZScpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICdyZW5kZXInIDogJ2dlbmVyYXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgbm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICAgICAgICAgOiAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSBuYW1lKTtcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0VG9TY2VuZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICh3b3JrZmxvdyAmJiB3b3JrZmxvdy5zdGVwICE9PSAzKSByZXR1cm47XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfmianlsZXkuLvov5vnqIvku43mmK/ml6fniYjvvIzor7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQgfHwgc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7XHJcbiAgICBpZiAoIXNldHRpbmdzKSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmZhaWwoJ+ivt+ajgOafpeWvvOWFpeWAjeeOh+S4jui+k+WHuuebruW9le+8jOS/ruato+WQjuWGjeasoeWvvOWFpeOAgicpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiAoe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24sXHJcbiAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgfSkpO1xyXG4gICAgd29ya2Zsb3c/LmJlZ2luKCdpbXBvcnQnKTtcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlh4blpIflr7zlhaXigKYnIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PFdvcmtmbG93UmVzdWx0PihcclxuICAgICAgICAgICAgJ2ltcG9ydC1zZWxlY3Rpb24nLFxyXG4gICAgICAgICAgICB7IG92ZXJyaWRlcywgc2V0dGluZ3MgfSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrTm90ZSA9IHJlc3VsdD8ud2FybmluZ3M/Lmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDvvJske3Jlc3VsdC53YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrvvIjor6bop4Hnu5Pmnpzmo4Dmn6XvvIlgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZShyZXN1bHQpO1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IHJlc3VsdC5yZXZpZXcgPz8gcGVuZGluZ0ltcG9ydFJldmlldztcclxuICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gbnVsbDtcclxuICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3JNZXNzYWdlKGVycm9yLCAn5a+85YWl5aSx6LSl44CCJyk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogd29ya2Zsb3c/LmNhbmNlbGxlZCA/ICdjYW5jZWxsZWQnIDogJ2Vycm9yJywgdmFsdWU6IDAsIG1lc3NhZ2UgfSk7XHJcbiAgICAgICAgc2hvd1RvYXN0KG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgd29ya2Zsb3c/LmVuZCgpO1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH1cclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gb3BlbkltcG9ydFJldmlldyh0YWI6ICdhc3NldHMnIHwgJ25vZGVzJyB8ICdzb3VyY2UnID0gJ2Fzc2V0cycpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJldmlldyA9IGF3YWl0IHJlcXVlc3Q8SW1wb3J0UmV2aWV3IHwgbnVsbD4oJ2dldC1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgaWYgKHJldmlldykge1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBjb25zdCBpbmRleCA9IFsnYXNzZXRzJywgJ25vZGVzJywgJ3NvdXJjZSddLmluZGV4T2YodGFiKTtcclxuICAgICAgICAgICAgaWYgKGluZGV4ID4gMCkgZWxlbWVudCgnI2ltcG9ydC1yZXZpZXctZGlhbG9nJykucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJy5yZXZpZXctdGFicyBidXR0b24nKVtpbmRleF0/LmNsaWNrKCk7XHJcbiAgICAgICAgfSBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikgeyBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6K+75Y+W5qOA5p+l57uT5p6c5aSx6LSl44CCJyksIHRydWUpOyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7IHZvaWQgb3BlbkltcG9ydFJldmlldygpOyB9KTtcclxuICAgIGVsZW1lbnQoJyNzYXZlLXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdG9rZW4taW5wdXQnKTtcclxuICAgICAgICBpZiAoIWlucHV0LnZhbHVlLnRyaW0oKSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSBUb2tlbuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBzYXZlZCA9IGZhbHNlO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgdmF1bHQgPSBhd2FpdCByZXF1ZXN0PGFueT4oJ3NldC10b2tlbicsIGlucHV0LnZhbHVlKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbih2YXVsdCk7XHJcbiAgICAgICAgICAgIHNhdmVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzYXZlZCkgd29ya2Zsb3c/LmNsb3NlQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICBjb25zdCBmb3JjZVJlYWQgPSBmb3JjZURvY3VtZW50UmVhZDtcclxuICAgICAgICBmb3JjZURvY3VtZW50UmVhZCA9IGZhbHNlO1xyXG4gICAgICAgIGlmICh3b3JrZmxvdyAmJiAhd29ya2Zsb3cuY3JlZGVudGlhbHNSZWFkeSkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdy5vcGVuQ3JlZGVudGlhbHMoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIWZvcmNlUmVhZCAmJiB3b3JrZmxvdz8uc291cmNlVW5jaGFuZ2VkKCkpIHtcclxuICAgICAgICAgICAgd29ya2Zsb3cubmF2aWdhdGUoMik7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEg5paH5Lu25oiW6IqC54K56ZO+5o6l44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgd29ya2Zsb3c/LmJlZ2luKCdmZXRjaCcpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMDUsIG1lc3NhZ2U6ICfmraPlnKjov57mjqUgRmlnbWHigKYnIH0pO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgcmVxdWVzdDxEb2N1bWVudER0bz4oJ2ZldGNoLWRvY3VtZW50Jywgc291cmNlKTtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50KTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJztcclxuICAgICAgICAgICAgaWYgKCF3b3JrZmxvdz8uY2FuY2VsbGVkKSB3b3JrZmxvdz8uZmFpbChtZXNzYWdlKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHdvcmtmbG93Py5jYW5jZWxsZWQgPyAn6K+75Y+W5bey5Y+W5raI77yM6YWN572u5bey5L+d55WZ44CCJyA6IG1lc3NhZ2UsICF3b3JrZmxvdz8uY2FuY2VsbGVkKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICB3b3JrZmxvdz8uZW5kKCk7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgICAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjcmVmcmVzaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgZm9yY2VEb2N1bWVudFJlYWQgPSB0cnVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5jbGljaygpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuY2xpY2soKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCByZXNldFJvdW5kdHJpcFRva2Vucyk7XHJcbiAgICBlbGVtZW50KCcjcGljay1hc3NldC1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLWFzc2V0LWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDotYTmupDlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjcGljay1wcmVmYWItZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stcHJlZmFiLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6aKE5Yi25L2T5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqemihOWItuS9k+ebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LvvIzlho3pgInmi6nmnKzlnLDotYTmupDnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICAgICBpbmRleCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg5bey5ZCv55So5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6nmnKzlnLDotYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgZWxlbWVudChgI2NsZWFyLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgaW5wdXQudGl0bGUgPSAnJztcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNob3dUb2FzdChg5bey5riF6Zmk5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGltcG9ydFRvU2NlbmUpO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICB3b3JrZmxvdz8uY2FuY2VsUmVxdWVzdGVkKCk7XHJcbiAgICAgICAgdHJ5IHsgYXdhaXQgcmVxdWVzdCgnY2FuY2VsLWltcG9ydCcpOyB9XHJcbiAgICAgICAgY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICflj5bmtojor7fmsYLlpLHotKXvvIzor7fnqI3lkI7ph43or5XjgIInKTtcclxuICAgICAgICAgICAgd29ya2Zsb3c/LmNhbmNlbFJlcXVlc3RGYWlsZWQobWVzc2FnZSk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChldmVudCkgPT4ge1xyXG4gICAgICAgIHN0YXRlLnNlYXJjaCA9IChldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGlmIChzdGF0ZS5idXN5KSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGNvbGxhcHNlSWQgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvbGxhcHNlXScpPy5kYXRhc2V0LmNvbGxhcHNlO1xyXG4gICAgICAgIGlmIChjb2xsYXBzZUlkKSB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5jb2xsYXBzZWQuaGFzKGNvbGxhcHNlSWQpKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5jb2xsYXBzZWQuZGVsZXRlKGNvbGxhcHNlSWQpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmFkZChjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KCdzZWxlY3QsIGxhYmVsLCBpbnB1dCwgdGV4dGFyZWEnKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1ub2RlLWlkXScpPy5kYXRhc2V0Lm5vZGVJZDtcclxuICAgICAgICBjb25zdCBub2RlID0gaWQgPyBmaW5kTm9kZShpZCkgOiB1bmRlZmluZWQ7XHJcbiAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgdm9pZCBwcmV2aWV3KG5vZGUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoc3RhdGUuYnVzeSkgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQ7XHJcbiAgICAgICAgaWYgKCF0YXJnZXQuZGF0YXNldC5uYW1lRm9yICYmICF0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IgJiYgIXRhcmdldC5kYXRhc2V0LmtpbmRGb3IgJiYgIXRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSByZXR1cm47XHJcbiAgICAgICAgaWYgKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybjtcclxuICAgICAgICAgICAgY29uc3QgY3VzdG9tTmFtZSA9IHNhbml0aXplTm9kZU5hbWUodGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgaWYgKCFjdXN0b21OYW1lKSB7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn6IqC54K55ZCN5LiN6IO95Li656m644CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoY3VzdG9tTmFtZSA9PT0gbm9kZS5uYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpXHJcbiAgICAgICAgICAgICAgICA/IGDoioLngrnlsIbku6XigJwke2N1c3RvbU5hbWV94oCd5a+85YWl44CCYFxyXG4gICAgICAgICAgICAgICAgOiAn5bey5oGi5aSNIEZpZ21hIOWOn+iKgueCueWQjeOAgicpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aW9uID0gdGFyZ2V0LnZhbHVlIGFzIEltcG9ydEFjdGlvbjtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gIT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgYWN0aW9uKTtcclxuICAgICAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdyZW5kZXInICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGDigJwke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfeKAneWwhuS9nOS4uuaVtOWxguWvvOWFpe+8jCR7ZGVzY2VuZGFudHMobm9kZSkubGVuZ3RofSDkuKrlrZDoioLngrnkuI3kvJrljZXni6znlJ/miJDjgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpIHtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KHRhcmdldC5kYXRhc2V0LmtpbmRGb3IsIHRhcmdldC52YWx1ZSBhcyBOb2RlS2luZCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5raW5kRm9yKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgIGlmICgodGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEFjdGlvbihub2RlLCAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudDtcclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5kYXRhc2V0Lm5hbWVGb3I7XHJcbiAgICAgICAgaWYgKCFpZCkgcmV0dXJuO1xyXG4gICAgICAgIGlmIChldmVudC5rZXkgPT09ICdFbnRlcicpIHtcclxuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKGlkKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHRhcmdldC52YWx1ZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgICAgICAgICB0YXJnZXQuYmx1cigpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IGFwcGx5UHJlc2V0KGJ1dHRvbi5kYXRhc2V0LnByZXNldCA/PyAnc21hcnQnKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudD4oXHJcbiAgICAgICAgJyNzY2FsZSwgI2Fzc2V0LWZvbGRlciwgI3ByZWZhYi1mb2xkZXIsICNsb2NhbC1yZXNvdXJjZS1mb2xkZXIsICN1cGRhdGUtZXhpc3RpbmcsICNyZWZyZXNoLWFzc2V0cywgI2F1dG8tc2F2ZScsXHJcbiAgICApLmZvckVhY2goKGNvbnRyb2wpID0+IHtcclxuICAgICAgICBjb250cm9sLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgIH0pO1xyXG4gICAgZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICBzdGF0ZS5zZXR0aW5ncyA9IHNldHRpbmdzO1xyXG4gICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG59XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IEVkaXRvci5QYW5lbC5kZWZpbmUoe1xyXG4gICAgbGlzdGVuZXJzOiB7XHJcbiAgICAgICAgc2hvdygpIHt9LFxyXG4gICAgICAgIGhpZGUoKSB7fSxcclxuICAgIH0sXHJcbiAgICB0ZW1wbGF0ZTogcmVhZEZpbGVTeW5jKGpvaW4oX19kaXJuYW1lLCAnLi4vLi4vLi4vc3RhdGljL3RlbXBsYXRlL2RlZmF1bHQvaW5kZXguaHRtbCcpLCAndXRmOCcpLFxyXG4gICAgc3R5bGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy9zdHlsZS9kZWZhdWx0L2luZGV4LmNzcycpLCAndXRmOCcpLFxyXG4gICAgJDoge1xyXG4gICAgICAgIGFwcDogJyNhcHAnLFxyXG4gICAgfSxcclxuICAgIG1ldGhvZHM6IHtcclxuICAgICAgICBvbkltcG9ydFJldmlld1JlYWR5KHJldmlldzogSW1wb3J0UmV2aWV3KSB7XHJcbiAgICAgICAgICAgIGlmIChzdGF0ZS5idXN5IHx8IHdvcmtmbG93Py5wZW5kaW5nKSB7XHJcbiAgICAgICAgICAgICAgICBwZW5kaW5nSW1wb3J0UmV2aWV3ID0gcmV2aWV3O1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHdvcmtmbG93Py5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgICAgICB9LFxyXG4gICAgICAgIG9uUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpIHtcclxuICAgICAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcmVhZHkoKSB7XHJcbiAgICAgICAgcGFuZWxIb3N0ID0gdGhpcztcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG5ldyBJbXBvcnRSZXZpZXdQYW5lbChyb290KCksIHJlcXVlc3QsIHNldEJ1c3kpO1xyXG4gICAgICAgIHdvcmtmbG93ID0gbmV3IFBhbmVsV29ya2Zsb3cocm9vdCgpLCAoKSA9PiBzdGF0ZSwgKHRhYikgPT4geyB2b2lkIG9wZW5JbXBvcnRSZXZpZXcodGFiKTsgfSk7XHJcbiAgICAgICAgYmluZEV2ZW50cygpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGluaXRpYWwgPSBhd2FpdCByZXF1ZXN0PHtcclxuICAgICAgICAgICAgICAgIHZlcnNpb24/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICB2YXVsdDogYW55O1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IERvY3VtZW50RHRvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgICAgICAgICAgfT4oJ2dldC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSA9IGluaXRpYWwudmVyc2lvbiA9PT0gcGFja2FnZUpTT04udmVyc2lvbjtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGluaXRpYWwuZm9udEFzc2V0cyA/PyBbXTtcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbihpbml0aWFsLnZhdWx0KTtcclxuICAgICAgICAgICAgYXBwbHlTZXR0aW5ncyhpbml0aWFsLnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluaXRpYWwuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgICAgIGluaXRpYWxpemVEb2N1bWVudChpbml0aWFsLmRvY3VtZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgICAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgICAgICAgICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgICAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICfor7fph43lkK8gQ29jb3MnO1xyXG4gICAgICAgICAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGuyc7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+ajgOa1i+WIsOaXp+eJiOS4u+i/m+eoi+S7jeWcqOi/kOihjO+8muivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBSZXBsYXkgcGVyc2lzdGVkIGluLW1lbW9yeSByZXBvcnQgaWYgY29tcGxldGlvbiBwcmVjZWRlZCBwYW5lbCByZWFkaW5lc3MuXHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXZpZXcgPSBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJldmlldykgd29ya2Zsb3cucmVtZW1iZXJSZXZpZXcoKTtcclxuICAgICAgICAgICAgICAgIGlmIChyZXZpZXcgJiYgIXJldmlldy5jb25maXJtZWQpIHtcclxuICAgICAgICAgICAgICAgICAgICB3b3JrZmxvdy5jb21wbGV0ZSh7IHJldmlldyB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WIneWni+WMluWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcbiAgICBiZWZvcmVDbG9zZSgpIHt9LFxyXG4gICAgY2xvc2UoKSB7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/LmRpc3Bvc2UoKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG51bGw7XHJcbiAgICAgICAgd29ya2Zsb3cgPSBudWxsO1xyXG4gICAgICAgIHBlbmRpbmdJbXBvcnRSZXZpZXcgPSBudWxsO1xyXG4gICAgICAgIGlmICh0b2FzdFRpbWVyKSBjbGVhclRpbWVvdXQodG9hc3RUaW1lcik7XHJcbiAgICAgICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBwYW5lbEhvc3QgPSBudWxsO1xyXG4gICAgfSxcclxufSk7XHJcbiJdfQ==