"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const package_json_1 = __importDefault(require("../../../package.json"));
const fonts_1 = require("../../importer/fonts");
const import_actions_1 = require("../../import-actions");
const node_name_1 = require("../../node-name");
const model_1 = require("./model");
let panelHost = null;
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
    var _a;
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
    for (const node of flatten(document.tree)) {
        const action = (0, model_1.smartActionForNode)(node);
        state.preferredActions.set(node.id, action);
        state.kinds.set(node.id, node.kind);
        state.defaults.set(node.id, { action, kind: node.kind });
        state.names.set(node.id, node.name);
    }
    for (const override of (_a = document.nodeOverrides) !== null && _a !== void 0 ? _a : []) {
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
    state.busy = value;
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
    element('#import-button-label').textContent = '导入到场景';
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
}
function descendants(node) {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
}
function reconcileActions() {
    var _a, _b;
    const effective = (0, model_1.resolveEffectiveActions)((_b = (_a = state.document) === null || _a === void 0 ? void 0 : _a.tree) !== null && _b !== void 0 ? _b : [], state.preferredActions, state.patches);
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
    var _a, _b;
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
    const name = document.createElement('input');
    name.type = 'text';
    name.className = `node-name-input${state.renamedIds.has(node.id) ? ' is-renamed' : ''}`;
    name.value = displayName;
    name.maxLength = 96;
    name.spellcheck = false;
    name.dataset.nameFor = node.id;
    name.setAttribute('aria-label', `${node.name} 导入节点名`);
    const strategySummary = (0, model_1.strategySummaryForNode)(node, state.explicitIds.has(node.id));
    name.title = [
        state.renamedIds.has(node.id) ? `Figma 原名：${node.name}` : '点击修改导入节点名',
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
    const selectedAction = safeAction(node, (_a = state.actions.get(node.id)) !== null && _a !== void 0 ? _a : node.action);
    const actionOptions = (0, model_1.actionOptionsForNode)(node);
    const action = makeSelect('action-select', selectedAction, actionOptions, `${displayName} 导入方式`);
    action.dataset.actionFor = node.id;
    const selectedKind = (_b = state.kinds.get(node.id)) !== null && _b !== void 0 ? _b : node.kind;
    const effectiveKind = (0, model_1.effectiveKindForNode)(node, selectedKind, selectedAction, state.patches.has(node.id));
    const kindOptions = (0, model_1.kindOptionsForAction)(selectedAction);
    const kind = makeSelect('kind-select', effectiveKind, kindOptions, `${displayName} 节点类型`);
    kind.dataset.kindFor = node.id;
    const patch = document.createElement('label');
    patch.className = 'patch-toggle';
    patch.title = node.patchCandidate ? '启用九宫格/三宫格切片' : '该节点不是自动识别的切片候选';
    const patchInput = document.createElement('input');
    patchInput.type = 'checkbox';
    patchInput.dataset.patchFor = node.id;
    patchInput.checked = state.patches.has(node.id);
    patchInput.disabled = !node.patchCandidate;
    const patchIcon = document.createElement('span');
    patchIcon.textContent = '▦';
    patch.append(patchInput, patchIcon);
    row.append(main, action, kind, patch);
    container.appendChild(row);
    if (!state.collapsed.has(node.id) || state.search) {
        node.children.forEach((child) => appendTreeNode(container, child, depth + 1));
    }
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
        state.patches.clear();
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
    if (!state.runtimeCompatible) {
        showToast('扩展主进程仍是旧版，请保存项目并完整重启 Cocos Creator。', true);
        return;
    }
    if (!state.document || state.busy) {
        return;
    }
    const settings = readSettings();
    if (!settings) {
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
    setBusy(true);
    updateProgress({ phase: 'assets', value: 0, message: '正在准备导入…' });
    try {
        const result = await request('import-selection', { overrides, settings });
        showToast((result === null || result === void 0 ? void 0 : result.prefabUrl)
            ? `导入完成，已创建预制体：${result.prefabUrl}`
            : '导入完成，已在场景中选中根节点。');
    }
    catch (error) {
        const message = errorMessage(error, '导入失败。');
        updateProgress({ phase: 'error', value: 0, message });
        showToast(message, true);
    }
    finally {
        setBusy(false);
    }
}
function bindEvents() {
    element('#save-token').addEventListener('click', async () => {
        const input = element('#token-input');
        if (!input.value.trim()) {
            showToast('请输入 Figma Token。', true);
            return;
        }
        setBusy(true);
        try {
            const vault = await request('set-token', input.value);
            input.value = '';
            setConnection(vault);
            showToast(vault.persistent ? 'Token 已由系统加密保存。' : 'Token 已保存到本次会话。');
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '保存失败。', true);
        }
        finally {
            setBusy(false);
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
        const source = element('#source-url').value.trim();
        if (!source) {
            showToast('请输入 Figma 文件或节点链接。', true);
            return;
        }
        setBusy(true);
        updateProgress({ phase: 'fetch', value: 0.05, message: '正在连接 Figma…' });
        try {
            const document = await request('fetch-document', source);
            state.fontAssets = (_a = document.fontAssets) !== null && _a !== void 0 ? _a : state.fontAssets;
            initializeDocument(document);
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '读取失败。', true);
        }
        finally {
            setBusy(false);
        }
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
    element('#cancel-import').addEventListener('click', () => request('cancel-import'));
    element('#tree-search').addEventListener('input', (event) => {
        state.search = event.target.value.trim().toLowerCase();
        renderTree();
    });
    element('#tree').addEventListener('click', (event) => {
        var _a, _b;
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
    element('#tree').addEventListener('change', (event) => {
        const target = event.target;
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
    element('#tree').addEventListener('keydown', (event) => {
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
        onProgress(event) {
            updateProgress(event);
        },
    },
    async ready() {
        var _a;
        panelHost = this;
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
        }
        catch (error) {
            showToast(error instanceof Error ? error.message : '初始化失败。', true);
        }
    },
    beforeClose() { },
    close() {
        panelHost = null;
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCxtQ0FTaUI7QUFtRWpCLElBQUksU0FBUyxHQUFRLElBQUksQ0FBQztBQUMxQixJQUFJLFVBQVUsR0FBeUMsSUFBSSxDQUFDO0FBQzVELElBQUksc0JBQXNCLEdBQXlDLElBQUksQ0FBQztBQUN4RSxJQUFJLG9CQUFvQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDNUQsSUFBSSxxQkFBeUMsQ0FBQztBQUM5QyxJQUFJLGtCQUFzQyxDQUFDO0FBRTNDLE1BQU0sS0FBSyxHQUFlO0lBQ3RCLFFBQVEsRUFBRSxJQUFJO0lBQ2QsUUFBUSxFQUFFO1FBQ04sU0FBUyxFQUFFLEVBQUU7UUFDYixXQUFXLEVBQUUsZ0JBQWdCO1FBQzdCLFlBQVksRUFBRSx3QkFBd0I7UUFDdEMsb0JBQW9CLEVBQUUsRUFBRTtRQUN4QixtQkFBbUIsRUFBRSxFQUFFO1FBQ3ZCLEtBQUssRUFBRSxDQUFDO1FBQ1IsY0FBYyxFQUFFLElBQUk7UUFDcEIsYUFBYSxFQUFFLEtBQUs7UUFDcEIsUUFBUSxFQUFFLEtBQUs7UUFDZixPQUFPLEVBQUUsRUFBRTtLQUNkO0lBQ0QsZ0JBQWdCLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDM0IsT0FBTyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ2xCLEtBQUssRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNoQixPQUFPLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDbEIsV0FBVyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ3RCLEtBQUssRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNoQixVQUFVLEVBQUUsSUFBSSxHQUFH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QzdCLGFBQWEsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7WUFDaEMsSUFBSSxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ25CLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUN6QyxDQUFDO1lBQ0QsSUFBSSxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO2dCQUMzQixhQUFhLEVBQUUsQ0FBQztnQkFDaEIsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFvQixnQkFBZ0IsQ0FBQyxDQUFDO2dCQUM1RCxNQUFNLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQztnQkFDakMsT0FBTyxDQUFDLHNCQUFzQixDQUFDLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztnQkFDMUQsT0FBTyxDQUFDLHdCQUF3QixDQUFDLENBQUMsV0FBVyxHQUFHLEdBQUcsQ0FBQztnQkFDcEQsU0FBUyxDQUFDLHdDQUF3QyxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzlELENBQUM7UUFDTCxDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNiLFNBQVMsQ0FBQyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDdkUsQ0FBQztJQUNMLENBQUM7SUFDRCxXQUFXLEtBQUksQ0FBQztJQUNoQixLQUFLO1FBQ0QsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNyQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi8uLi8uLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBmaW5kRm9udEFzc2V0LCB0eXBlIEZvbnRBc3NldE9wdGlvbiB9IGZyb20gJy4uLy4uL2ltcG9ydGVyL2ZvbnRzJztcclxuaW1wb3J0IHsgbm9ybWFsaXplSW1wb3J0QWN0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0LWFjdGlvbnMnO1xyXG5pbXBvcnQgeyBzYW5pdGl6ZU5vZGVOYW1lIH0gZnJvbSAnLi4vLi4vbm9kZS1uYW1lJztcclxuaW1wb3J0IHtcclxuICAgIGFjdGlvbk9wdGlvbnNGb3JOb2RlLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IHRvYXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBpbXBvcnRCdXR0b25SZXNldFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHJvdW5kdHJpcFByZXZpZXdUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgcm91bmR0cmlwUGFpclRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcblxyXG5jb25zdCBzdGF0ZTogUGFuZWxTdGF0ZSA9IHtcclxuICAgIGRvY3VtZW50OiBudWxsLFxyXG4gICAgc2V0dGluZ3M6IHtcclxuICAgICAgICBzb3VyY2VVcmw6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXInLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyL3ByZWZhYnMnLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBbXSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiAnJyxcclxuICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBmYWxzZSxcclxuICAgICAgICBhdXRvU2F2ZTogZmFsc2UsXHJcbiAgICAgICAgZm9udE1hcDoge30sXHJcbiAgICB9LFxyXG4gICAgcHJlZmVycmVkQWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAgYWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAga2luZHM6IG5ldyBNYXAoKSxcclxuICAgIHBhdGNoZXM6IG5ldyBTZXQoKSxcclxuICAgIGV4cGxpY2l0SWRzOiBuZXcgU2V0KCksXHJcbiAgICBuYW1lczogbmV3IE1hcCgpLFxyXG4gICAgcmVuYW1lZElkczogbmV3IFNldCgpLFxyXG4gICAgZGVmYXVsdHM6IG5ldyBNYXAoKSxcclxuICAgIGNvbGxhcHNlZDogbmV3IFNldCgpLFxyXG4gICAgc3VwcHJlc3NlZDogbmV3IFNldCgpLFxyXG4gICAgc2VhcmNoOiAnJyxcclxuICAgIGJ1c3k6IGZhbHNlLFxyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IHRydWUsXHJcbiAgICBmb250QXNzZXRzOiBbXSxcclxufTtcclxuXHJcbmZ1bmN0aW9uIHJvb3QoKTogSFRNTEVsZW1lbnQge1xyXG4gICAgcmV0dXJuIHBhbmVsSG9zdC4kLmFwcCBhcyBIVE1MRWxlbWVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gZWxlbWVudDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQ+KHNlbGVjdG9yOiBzdHJpbmcpOiBUIHtcclxuICAgIGNvbnN0IHZhbHVlID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpO1xyXG4gICAgaWYgKCF2YWx1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUGFuZWwgZWxlbWVudCBub3QgZm91bmQ6ICR7c2VsZWN0b3J9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlcXVlc3Q8VD4obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pOiBQcm9taXNlPFQ+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KHBhY2thZ2VKU09OLm5hbWUsIG1lc3NhZ2UsIC4uLmFyZ3MpIGFzIFQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNob3dUb2FzdChtZXNzYWdlOiBzdHJpbmcsIGVycm9yID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRvYXN0ID0gZWxlbWVudDxIVE1MRGl2RWxlbWVudD4oJyN0b2FzdCcpO1xyXG4gICAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7XHJcbiAgICBpZiAodG9hc3RUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgIH1cclxuICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKSwgMzQwMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93biwgZmFsbGJhY2s6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5tZXNzYWdlKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIGVycm9yID09PSAnc3RyaW5nJyAmJiBlcnJvci50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3I7XHJcbiAgICB9XHJcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0JyAmJiAnbWVzc2FnZScgaW4gZXJyb3JcclxuICAgICAgICAmJiB0eXBlb2YgKGVycm9yIGFzIHsgbWVzc2FnZT86IHVua25vd24gfSkubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICByZXR1cm4gKGVycm9yIGFzIHsgbWVzc2FnZTogc3RyaW5nIH0pLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsbGJhY2s7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldENvbm5lY3Rpb24odmF1bHQ6IHtcclxuICAgIGhhc1Rva2VuOiBib29sZWFuO1xyXG4gICAgcGVyc2lzdGVudDogYm9vbGVhbjtcclxuICAgIGJhY2tlbmQ6IHN0cmluZztcclxuICAgIHdhcm5pbmc/OiBzdHJpbmc7XHJcbn0pOiB2b2lkIHtcclxuICAgIGNvbnN0IHBpbGwgPSBlbGVtZW50KCcjY29ubmVjdGlvbi1waWxsJyk7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9ubGluZScsIHZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb2ZmbGluZScsICF2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBlbGVtZW50KCcjY29ubmVjdGlvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gdmF1bHQuaGFzVG9rZW4gPyAn5Yet5o2u5bCx57uqJyA6ICfmnKrov57mjqUnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LWJhZGdlJykudGV4dENvbnRlbnQgPSB2YXVsdC5wZXJzaXN0ZW50ID8gJ+ezu+e7n+WKoOWvhicgOiAn5Lya6K+d5a2Y5YKoJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1ub3RlJykudGV4dENvbnRlbnQgPSB2YXVsdC53YXJuaW5nXHJcbiAgICAgICAgPz8gKHZhdWx0LnBlcnNpc3RlbnQgPyBg55SxICR7dmF1bHQuYmFja2VuZH0g5Yqg5a+G77yM6aG555uu5Lit5LuF5L+d5a2Y6Z2e5pWP5oSf6K6+572uYCA6ICdUb2tlbiDkuI3lhpnlhaXpobnnm67mlofku7YnKTtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2NsZWFyLXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuKG5vZGVzOiBUcmVlTm9kZUR0b1tdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZXMuZmxhdE1hcCgobm9kZSkgPT4gW25vZGUsIC4uLmZsYXR0ZW4obm9kZS5jaGlsZHJlbildKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZE5vZGUoaWQ6IHN0cmluZywgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSk6IFRyZWVOb2RlRHRvIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgIGlmIChub2RlLmlkID09PSBpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBmaW5kTm9kZShpZCwgbm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgaWYgKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJGb250TWFwKCk6IHZvaWQge1xyXG4gICAgY29uc3QgbGlzdCA9IGVsZW1lbnQoJyNmb250LW1hcC1saXN0Jyk7XHJcbiAgICBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3QgZmFtaWxpZXMgPSBzdGF0ZS5kb2N1bWVudD8uZm9udHMgPz8gW107XHJcbiAgICBpZiAoIWZhbWlsaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5JztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg5ZCO77yM6L+Z6YeM5Lya5YiX5Ye65qOA5rWL5Yiw55qE5a2X5L2T44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmZvbnRBc3NldHMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHkgaXMtd2FybmluZyc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6aG555uuIGFzc2V0cyDlhoXmsqHmnInmo4DmtYvliLAgLnR0ZiAvIC5vdGYgLyAuZm50IC8gLndvZmYg5a2X5L2T6LWE5rqQ44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIGZhbWlsaWVzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1yb3cnO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBzb3VyY2UuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNvdXJjZSc7XHJcbiAgICAgICAgc291cmNlLnRleHRDb250ZW50ID0gZmFtaWx5O1xyXG4gICAgICAgIHNvdXJjZS50aXRsZSA9IGZhbWlseTtcclxuICAgICAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBhcnJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtYXJyb3cnO1xyXG4gICAgICAgIGFycm93LnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICAgICAgc2VsZWN0LmNsYXNzTmFtZSA9ICdmb250LW1hcC1zZWxlY3QnO1xyXG4gICAgICAgIHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHkgPSBmYW1pbHk7XHJcbiAgICAgICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke2ZhbWlseX0g5pig5bCE5a2X5L2TYCk7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbignJywgJ+S4jeaYoOWwhO+8iOS9v+eUqOm7mOiupOWtl+S9k++8iScpKTtcclxuICAgICAgICBjb25zdCBhdXRvbWF0aWMgPSBmaW5kRm9udEFzc2V0KGZhbWlseSwgc3RhdGUuZm9udEFzc2V0cyk7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS5zZXR0aW5ncy5mb250TWFwW2ZhbWlseV0gPz8gYXV0b21hdGljPy51cmwgPz8gJyc7XHJcbiAgICAgICAgZm9yIChjb25zdCBhc3NldCBvZiBzdGF0ZS5mb250QXNzZXRzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSBvcHRpb24oYXNzZXQudXJsLCBgJHthc3NldC5uYW1lfSDCtyAke2Fzc2V0LnJlbGF0aXZlUGF0aH1gKTtcclxuICAgICAgICAgICAgaXRlbS5zZWxlY3RlZCA9IGFzc2V0LnVybCA9PT0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChpdGVtKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgcm93LmFwcGVuZChzb3VyY2UsIGFycm93LCBzZWxlY3QpO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZUFjdGlvbihfbm9kZTogVHJlZU5vZGVEdG8sIGFjdGlvbjogdW5rbm93bik6IEltcG9ydEFjdGlvbiB7XHJcbiAgICByZXR1cm4gbm9ybWFsaXplSW1wb3J0QWN0aW9uKGFjdGlvbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXRpYWxpemVEb2N1bWVudChkb2N1bWVudDogRG9jdW1lbnREdG8pOiB2b2lkIHtcclxuICAgIHN0YXRlLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5raW5kcy5jbGVhcigpO1xyXG4gICAgc3RhdGUucGF0Y2hlcy5jbGVhcigpO1xyXG4gICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLm5hbWVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5yZW5hbWVkSWRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5kZWZhdWx0cy5jbGVhcigpO1xyXG4gICAgc3RhdGUuY29sbGFwc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkLmNsZWFyKCk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZmxhdHRlbihkb2N1bWVudC50cmVlKSkge1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKTtcclxuICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBhY3Rpb24pO1xyXG4gICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBub2RlLmtpbmQpO1xyXG4gICAgICAgIHN0YXRlLmRlZmF1bHRzLnNldChub2RlLmlkLCB7IGFjdGlvbiwga2luZDogbm9kZS5raW5kIH0pO1xyXG4gICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBvdmVycmlkZSBvZiBkb2N1bWVudC5ub2RlT3ZlcnJpZGVzID8/IFtdKSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKG92ZXJyaWRlLmlkLCBkb2N1bWVudC50cmVlKTtcclxuICAgICAgICBpZiAoIW5vZGUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKG92ZXJyaWRlLm5hbWUpO1xyXG4gICAgICAgIGlmIChjdXN0b21OYW1lICYmIGN1c3RvbU5hbWUgIT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICBzdGF0ZS5uYW1lcy5zZXQobm9kZS5pZCwgY3VzdG9tTmFtZSk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAob3ZlcnJpZGUuZXhwbGljaXQgPT09IHRydWUpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBvdmVycmlkZS5hY3Rpb24pKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG92ZXJyaWRlLmtpbmQpO1xyXG4gICAgICAgICAgICBpZiAob3ZlcnJpZGUubmluZVNsaWNlICYmIG5vZGUucGF0Y2hDYW5kaWRhdGUpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZShcclxuICAgICAgICAgICAgJ2FjdGl2ZScsXHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLnNpemUgPT09IDAgJiYgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAnc21hcnQnLFxyXG4gICAgICAgICk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmaWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IGRvY3VtZW50LnNvdXJjZVVybDtcclxuICAgIGVsZW1lbnQoJyNmb250LWhpbnQnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZvbnRzLmxlbmd0aFxyXG4gICAgICAgID8gYOajgOa1i+WIsO+8miR7ZG9jdW1lbnQuZm9udHMuam9pbign44CBJyl9YFxyXG4gICAgICAgIDogJ+W9k+WJjeaWh+S7tuWwmuacquWPkeeOsOWtl+S9k+OAgic7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICByZW5kZXJUcmVlKHRydWUpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IHZvaWQge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIHVwZGF0ZVRhcmdldEhpbnQoKTtcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVhZFNldHRpbmdzKHNob3dFcnJvciA9IHRydWUpOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwge1xyXG4gICAgY29uc3QgZm9udE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uc3RhdGUuc2V0dGluZ3MuZm9udE1hcCB9O1xyXG4gICAgaWYgKHN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBmYW1pbHkgb2Ygc3RhdGUuZG9jdW1lbnQuZm9udHMpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGZvbnRNYXBbZmFtaWx5XTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoZmFtaWx5ICYmIHNlbGVjdC52YWx1ZSkge1xyXG4gICAgICAgICAgICBmb250TWFwW2ZhbWlseV0gPSBzZWxlY3QudmFsdWU7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzY2FsZSA9IE51bWJlcihlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPCAwLjI1IHx8IHNjYWxlID4gNCkge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCflr7zlhaXlgI3njoflv4XpobvlnKggMC4yNSDliLAgNCDkuYvpl7TjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhc3NldEZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWFzc2V0Rm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemhueebriBhc3NldHMg5LiL55qE6LWE5rqQ6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJlZmFiRm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXByZWZhYkZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npooTliLbkvZPovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzIH0sIChfLCBpbmRleCkgPT5cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICApLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNsb2NhbC1yZXNvdXJjZS1mb2xkZXItMCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCxcclxuICAgICAgICBhdXRvU2F2ZTogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEJ1c3kodmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNzYXZlLXRva2VuJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1hc3NldC1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLXByZWZhYi1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtZGV0ZWN0JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXByZXZpZXcnKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaGlkZGVuJywgIXZhbHVlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvdW5kdHJpcFNvdXJjZSgpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSDmlofku7bmiJboioLngrnpk77mjqXjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBzb3VyY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclJvdW5kdHJpcFByZXZpZXcocHJldmlldzogUm91bmR0cmlwUHJldmlld0R0byk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gcHJldmlldy5wcmV2aWV3VG9rZW47XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSBwcmV2aWV3LnBhaXJUb2tlbjtcclxuICAgIGNvbnN0IGxpbmVzID0gW1xyXG4gICAgICAgIGDnm67moIfvvJoke3ByZXZpZXcuYXNzZXRVcmx9YCxcclxuICAgICAgICBgUHJlZmFi77yaJHtwcmV2aWV3LnByZWZhYlV1aWR9YCxcclxuICAgICAgICBgU3VyZmFjZe+8miR7cHJldmlldy5zdXJmYWNlSWR9IMK3IEZpZ21hICR7cHJldmlldy5maWdtYVZlcnNpb259IMK3IExlZGdlciAke3ByZXZpZXcubGVkZ2VyR2VuZXJhdGlvbn1gLFxyXG4gICAgICAgIGDlsIbkv67mlLkgJHtwcmV2aWV3LnBsYW4uYXBwbHkubGVuZ3RofSDpobkgwrcg5L+d55WZIENvY29zICR7cHJldmlldy5wbGFuLnByZXNlcnZlQ29jb3MubGVuZ3RofSDpobkgwrcg5bey5pS25pWbICR7cHJldmlldy5wbGFuLmNvbnZlcmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgYOWGsueqgSAke3ByZXZpZXcucGxhbi5jb25mbGljdHMubGVuZ3RofSDpobkgwrcg5LiN5pSv5oyBICR7cHJldmlldy5wbGFuLnVuc3VwcG9ydGVkLmxlbmd0aH0g6aG5IMK3IOWPquivu+acquaUuSAke3ByZXZpZXcucGxhbi5yZWFkb25seVVuY2hhbmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgcHJldmlldy5wYWlyUmVxdWlyZWRcclxuICAgICAgICAgICAgPyBwcmV2aWV3LnBhaXJFbGlnaWJsZSA/ICfpppbmrKHkvb/nlKjvvJror4Hmja7kuIDoh7TvvIzor7flhYjnoa7orqTphY3lr7kgU3VyZmFjZe+8iOWPquWGmSBsZWRnZXLvvIzkuI3mlLkgUHJlZmFi77yJ44CCJyA6ICfpppbmrKHkvb/nlKjvvJpQYWlyIOivgeaNruS4jeS4gOiHtO+8jOmcgOS7juW9k+WJjSBQcmVmYWIg6YeN5paw5a+85Ye644CCJ1xyXG4gICAgICAgICAgICA6IHByZXZpZXcuYmxvY2tlcnMubGVuZ3RoID8gYOmYu+aWre+8miR7cHJldmlldy5ibG9ja2Vycy5qb2luKCcsICcpfWAgOiAn6aKE6KeI6YCa6L+H77yM5Y+v5Y6f5a2Q5bqU55So5pW05Liq5LiN5Y+v5Y+Y6K6h5YiS44CCJyxcclxuICAgIF07XHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVUYXJnZXRIaW50KCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOmcgOimgeWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9yJztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlvZPliY3lnLrmma8gQ2FudmFzIOagueiKgueCueS4i++8m0ZyYW1lIOmTvuaOpeWwhuiHquWKqOWIm+W7uuW5tuaJk+W8gOmihOWItuS9kyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0SW1wb3J0QnV0dG9uKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgIGJ1dHRvbi50aXRsZSA9ICflr7zlhaXliLDlvZPliY3miZPlvIDlnLrmma/miJbpooTliLbkvZMnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlnLrmma8nO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMCUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbXBvcnRQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuMDUgKyB2YWx1ZSAqIDAuNTU7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdzY2VuZScpIHtcclxuICAgICAgICByZXR1cm4gMC42ICsgdmFsdWUgKiAwLjM4O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGV2ZW50LnBoYXNlID09PSAnZG9uZScgPyAxIDogMDtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHJlZ2lvbiA9IGVsZW1lbnQoJyNwcm9ncmVzcy1yZWdpb24nKTtcclxuICAgIGNvbnN0IGJ1c3kgPSBbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKTtcclxuICAgIHJlZ2lvbi5jbGFzc0xpc3QudG9nZ2xlKCdpcy1idXN5JywgYnVzeSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtZXJyb3InLCBldmVudC5waGFzZSA9PT0gJ2Vycm9yJyk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZCh2YWx1ZSAqIDEwMCl9JWA7XHJcbiAgICAoZWxlbWVudCgnI3Byb2dyZXNzLWJhcicpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3ZhbHVlICogMTAwfSVgO1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBjb25zdCBpbXBvcnRpbmcgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgfHwgZXZlbnQucGhhc2UgPT09ICdzY2VuZSc7XHJcbiAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gbnVsbDtcclxuICAgIH1cclxuICAgIGlmIChpbXBvcnRpbmcpIHtcclxuICAgICAgICBjb25zdCBwcm9ncmVzcyA9IGltcG9ydFByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtcnVubmluZycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZSgnYXJpYS1idXN5JywgJ3RydWUnKTtcclxuICAgICAgICBidXR0b24udGl0bGUgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgPyAn5YeG5aSH6LWE5rqQJyA6ICfmnoTlu7roioLngrknO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApfSVgO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3Byb2dyZXNzICogMTAwfSVgO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2RvbmUnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5a+85YWl5a6M5oiQJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAnMTAwJSc7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzEwMCUnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxNDAwKTtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicgfHwgZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcgPyAn5bey5Y+W5raIJyA6ICflr7zlhaXlpLHotKUnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfph43or5UnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxODAwKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2RvbmUnLCAnZXJyb3InLCAnY2FuY2VsbGVkJywgJ2lkbGUnXS5pbmNsdWRlcyhldmVudC5waGFzZSkpIHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgKTtcclxuICAgIHN0YXRlLmFjdGlvbnMgPSBlZmZlY3RpdmUuYWN0aW9ucztcclxuICAgIHN0YXRlLnN1cHByZXNzZWQgPSBlZmZlY3RpdmUuc3VwcHJlc3NlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IEltcG9ydEFjdGlvbik6IHZvaWQge1xyXG4gICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBhY3Rpb24pKTtcclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0aXZlTm9kZU5hbWUobm9kZTogVHJlZU5vZGVEdG8pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0YXRlLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4cGxpY2l0T3ZlcnJpZGVzKCk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpXHJcbiAgICAgICAgLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpKVxyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVuYW1lZCA9IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIC4uLihyZW5hbWVkID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlS2V5ID0gc3RhdGUuZG9jdW1lbnQuZmlsZUtleTtcclxuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGV4cGxpY2l0T3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub2RlLmlkKTtcclxuICAgIC8vIFNlcmlhbGl6ZSB3cml0ZXMgc28gYSBzbG93ZXIgZWFybGllciByZXF1ZXN0IGNhbiBuZXZlciBvdmVyd3JpdGUgYSBuZXdlclxyXG4gICAgLy8gc3RyYXRlZ3kgc25hcHNob3QgYWZ0ZXIgcmFwaWQgc2VsZWN0IGNoYW5nZXMuXHJcbiAgICBub2RlT3ZlcnJpZGVTYXZlVGFzayA9IG5vZGVPdmVycmlkZVNhdmVUYXNrXHJcbiAgICAgICAgLmNhdGNoKCgpID0+IHVuZGVmaW5lZClcclxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3Q8SW1wb3J0T3ZlcnJpZGVbXT4oJ3NhdmUtbm9kZS1vdmVycmlkZXMnLCBmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+iKgueCueetlueVpeS/neWtmOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF0Y2hlcyhub2RlOiBUcmVlTm9kZUR0byk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhheXN0YWNrID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9ICR7bm9kZS5uYW1lfSAke25vZGUudHlwZX0gJHtub2RlLmlkfWAudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChoYXlzdGFjay5pbmNsdWRlcyhzdGF0ZS5zZWFyY2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKG1hdGNoZXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb24odmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEhUTUxPcHRpb25FbGVtZW50IHtcclxuICAgIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgIGl0ZW0udmFsdWUgPSB2YWx1ZTtcclxuICAgIGl0ZW0udGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYWtlU2VsZWN0KFxyXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogc3RyaW5nLFxyXG4gICAgaXRlbXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+LFxyXG4gICAgbGFiZWw6IHN0cmluZyxcclxuKTogSFRNTFNlbGVjdEVsZW1lbnQge1xyXG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICBzZWxlY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGxhYmVsKTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgdGV4dF0gb2YgaXRlbXMpIHtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKGtleSwgdGV4dCkpO1xyXG4gICAgfVxyXG4gICAgc2VsZWN0LnZhbHVlID0gdmFsdWU7XHJcbiAgICByZXR1cm4gc2VsZWN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBlbmRUcmVlTm9kZShjb250YWluZXI6IEhUTUxFbGVtZW50LCBub2RlOiBUcmVlTm9kZUR0bywgZGVwdGg6IG51bWJlcik6IHZvaWQge1xyXG4gICAgaWYgKCFtYXRjaGVzKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICByb3cuY2xhc3NOYW1lID0gYHRyZWUtcm93JHtzdGF0ZS5zZWxlY3RlZElkID09PSBub2RlLmlkID8gJyBpcy1zZWxlY3RlZCcgOiAnJ31gO1xyXG4gICAgcm93LmRhdGFzZXQubm9kZUlkID0gbm9kZS5pZDtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndHJlZWl0ZW0nKTtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGV2ZWwnLCBTdHJpbmcoZGVwdGggKyAxKSk7XHJcblxyXG4gICAgY29uc3QgbWFpbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWFpbi5jbGFzc05hbWUgPSAnbm9kZS1tYWluJztcclxuICAgIG1haW4uc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTtcclxuICAgIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgICBjb2xsYXBzZS5jbGFzc05hbWUgPSBgY29sbGFwc2Uke25vZGUuY2hpbGRyZW4ubGVuZ3RoID8gJycgOiAnIGlzLWxlYWYnfWA7XHJcbiAgICBjb2xsYXBzZS50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBjb2xsYXBzZS5kYXRhc2V0LmNvbGxhcHNlID0gbm9kZS5pZDtcclxuICAgIGNvbGxhcHNlLnRleHRDb250ZW50ID0gc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICfigLonIDogJ+KMhCc7XHJcbiAgICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+WxleW8gCcgOiAn5oqY5Y+gJyk7XHJcbiAgICBjb25zdCBkb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBkb3QuY2xhc3NOYW1lID0gYHR5cGUtZG90ICR7XHJcbiAgICAgICAgbm9kZS50eXBlID09PSAnVEVYVCcgPyAndGV4dCdcclxuICAgICAgICAgICAgOiBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAndmVjdG9yJ1xyXG4gICAgICAgICAgICAgICAgOiBub2RlLnR5cGUuaW5jbHVkZXMoJ0NPTVBPTkVOVCcpIHx8IG5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJyA/ICdjb21wb25lbnQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xyXG4gICAgfWA7XHJcbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBjb3B5LmNsYXNzTmFtZSA9ICdub2RlLWNvcHknO1xyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgbmFtZS50eXBlID0gJ3RleHQnO1xyXG4gICAgbmFtZS5jbGFzc05hbWUgPSBgbm9kZS1uYW1lLWlucHV0JHtzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/ICcgaXMtcmVuYW1lZCcgOiAnJ31gO1xyXG4gICAgbmFtZS52YWx1ZSA9IGRpc3BsYXlOYW1lO1xyXG4gICAgbmFtZS5tYXhMZW5ndGggPSA5NjtcclxuICAgIG5hbWUuc3BlbGxjaGVjayA9IGZhbHNlO1xyXG4gICAgbmFtZS5kYXRhc2V0Lm5hbWVGb3IgPSBub2RlLmlkO1xyXG4gICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtub2RlLm5hbWV9IOWvvOWFpeiKgueCueWQjWApO1xyXG4gICAgY29uc3Qgc3RyYXRlZ3lTdW1tYXJ5ID0gc3RyYXRlZ3lTdW1tYXJ5Rm9yTm9kZShub2RlLCBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkpO1xyXG4gICAgbmFtZS50aXRsZSA9IFtcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gIDogJ+eCueWHu+S/ruaUueWvvOWFpeiKgueCueWQjScsXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5LFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nLFxyXG4gICAgXVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuam9pbignIMK3ICcpO1xyXG4gICAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbm9kZS1tZXRhJztcclxuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtub2RlLnR5cGV9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvcHkuYXBwZW5kKG5hbWUsIG1ldGEpO1xyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSkge1xyXG4gICAgICAgIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgc3RyYXRlZ3kuY2xhc3NOYW1lID0gJ25vZGUtc3RyYXRlZ3knO1xyXG4gICAgICAgIHN0cmF0ZWd5LnRleHRDb250ZW50ID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIHN0cmF0ZWd5LnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQoc3RyYXRlZ3kpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSB7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHdhcm5pbmcuY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgd2FybmluZy50ZXh0Q29udGVudCA9IGDimqAgJHtzdHJhdGVneVN1bW1hcnkud2FybmluZ31gO1xyXG4gICAgICAgIHdhcm5pbmcudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkud2FybmluZztcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHdhcm5pbmcpO1xyXG4gICAgfVxyXG4gICAgcm93LmNsYXNzTGlzdC50b2dnbGUoJ2hhcy1kZXRhaWwnLCBCb29sZWFuKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSB8fCBzdHJhdGVneVN1bW1hcnkud2FybmluZykpO1xyXG4gICAgbWFpbi5hcHBlbmQoY29sbGFwc2UsIGRvdCwgY29weSk7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGNvbnN0IGFjdGlvbk9wdGlvbnMgPSBhY3Rpb25PcHRpb25zRm9yTm9kZShub2RlKTtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2FjdGlvbi1zZWxlY3QnLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIGFjdGlvbk9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOWvvOWFpeaWueW8j2AsXHJcbiAgICApO1xyXG4gICAgYWN0aW9uLmRhdGFzZXQuYWN0aW9uRm9yID0gbm9kZS5pZDtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEtpbmQgPSBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGVmZmVjdGl2ZUtpbmRGb3JOb2RlKFxyXG4gICAgICAgIG5vZGUsXHJcbiAgICAgICAgc2VsZWN0ZWRLaW5kLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGtpbmRPcHRpb25zID0ga2luZE9wdGlvbnNGb3JBY3Rpb24oc2VsZWN0ZWRBY3Rpb24pO1xyXG4gICAgY29uc3Qga2luZCA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2tpbmQtc2VsZWN0JyxcclxuICAgICAgICBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGtpbmRPcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDoioLngrnnsbvlnotgLFxyXG4gICAgKTtcclxuICAgIGtpbmQuZGF0YXNldC5raW5kRm9yID0gbm9kZS5pZDtcclxuXHJcbiAgICBjb25zdCBwYXRjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICBwYXRjaC5jbGFzc05hbWUgPSAncGF0Y2gtdG9nZ2xlJztcclxuICAgIHBhdGNoLnRpdGxlID0gbm9kZS5wYXRjaENhbmRpZGF0ZSA/ICflkK/nlKjkuZ3lrqvmoLwv5LiJ5a6r5qC85YiH54mHJyA6ICfor6XoioLngrnkuI3mmK/oh6rliqjor4bliKvnmoTliIfniYflgJnpgIknO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9ICFub2RlLnBhdGNoQ2FuZGlkYXRlO1xyXG4gICAgY29uc3QgcGF0Y2hJY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgcGF0Y2hJY29uLnRleHRDb250ZW50ID0gJ+KWpic7XHJcbiAgICBwYXRjaC5hcHBlbmQocGF0Y2hJbnB1dCwgcGF0Y2hJY29uKTtcclxuICAgIHJvdy5hcHBlbmQobWFpbiwgYWN0aW9uLCBraW5kLCBwYXRjaCk7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuXHJcbiAgICBpZiAoIXN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgfHwgc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyLCBjaGlsZCwgZGVwdGggKyAxKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclRyZWUocmVzZXRTY3JvbGwgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdHJlZSA9IGVsZW1lbnQoJyN0cmVlJyk7XHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwodHJlZSwgKCkgPT4ge1xyXG4gICAgICAgIHRyZWUucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZW1wdHktc3RhdGUnO1xyXG4gICAgICAgICAgICBjb25zdCBnbHlwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICAgICAgZ2x5cGguY2xhc3NOYW1lID0gJ2VtcHR5LWdseXBoJztcclxuICAgICAgICAgICAgZ2x5cGgudGV4dENvbnRlbnQgPSAn4oazJztcclxuICAgICAgICAgICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcclxuICAgICAgICAgICAgdGl0bGUudGV4dENvbnRlbnQgPSAn6L+Y5rKh5pyJ6IqC54K5JztcclxuICAgICAgICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICAgICAgYm9keS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg6ZO+5o6l5ZCO77yM5Y+v6YCQ5bGC6YCJ5oup55Sf5oiQ44CBUE5HIOaVtOWxguaIluabtOaWsOOAgic7XHJcbiAgICAgICAgICAgIGVtcHR5LmFwcGVuZChnbHlwaCwgdGl0bGUsIGJvZHkpO1xyXG4gICAgICAgICAgICB0cmVlLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzdGF0ZS5kb2N1bWVudC50cmVlLmZvckVhY2goKG5vZGUpID0+IGFwcGVuZFRyZWVOb2RlKHRyZWUsIG5vZGUsIDApKTtcclxuICAgIH0sIHJlc2V0U2Nyb2xsKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IG5vZGVzID0gc3RhdGUuZG9jdW1lbnQgPyBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpIDogW107XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IG5vZGVzLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgIT09ICdpZ25vcmUnKTtcclxuICAgIGVsZW1lbnQoJyNub2RlLWNvdW50JykudGV4dENvbnRlbnQgPSBgJHtub2Rlcy5sZW5ndGh9IOiKgueCuWA7XHJcbiAgICBlbGVtZW50KCcjc2VsZWN0aW9uLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IHN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgPyBgJHtzZWxlY3RlZC5sZW5ndGh9IC8gJHtub2Rlcy5sZW5ndGh9IOS4quiKgueCueWwhuWPguS4juWvvOWFpWBcclxuICAgICAgICA6ICfnrYnlvoXorr7orqHmlbDmja4nO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSBzdGF0ZS5idXN5XHJcbiAgICAgICAgfHwgIXN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgfHwgIXNlbGVjdGVkLmxlbmd0aFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcHJldmlldyhub2RlOiBUcmVlTm9kZUR0byk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gbm9kZS5pZDtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIGVsZW1lbnQoJyNwcmV2aWV3LW1ldGEnKS50ZXh0Q29udGVudCA9IGAke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb25zdCBzdGFnZSA9IGVsZW1lbnQoJyNwcmV2aWV3LXN0YWdlJyk7XHJcbiAgICBjb25zdCBpbWFnZSA9IGVsZW1lbnQ8SFRNTEltYWdlRWxlbWVudD4oJyNwcmV2aWV3LWltYWdlJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QuYWRkKCdpcy1sb2FkaW5nJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdoYXMtaW1hZ2UnKTtcclxuICAgIGltYWdlLnJlbW92ZUF0dHJpYnV0ZSgnc3JjJyk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyB1cmw6IHN0cmluZyB9PignZ2V0LXByZXZpZXcnLCBub2RlLmlkKTtcclxuICAgICAgICBpZiAoc3RhdGUuc2VsZWN0ZWRJZCAhPT0gbm9kZS5pZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6aKE6KeI5Zu+54mH5Yqg6L295aSx6LSl44CCJykpO1xyXG4gICAgICAgICAgICBpbWFnZS5zcmMgPSByZXN1bHQudXJsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2hhcy1pbWFnZScpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6aKE6KeI5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLWxvYWRpbmcnKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlQcmVzZXQobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxsID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgIGlmIChuYW1lID09PSAnc21hcnQnKSB7XHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IHN0YXRlLmRlZmF1bHRzLmdldChub2RlLmlkKSE7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmFjdGlvbik7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvcmlnaW5hbC5raW5kKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG5hbWUgPT09ICdlZGl0YWJsZScpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICdyZW5kZXInIDogJ2dlbmVyYXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBub2RlLmNoaWxkcmVuLmxlbmd0aFxuICAgICAgICAgICAgICAgID8gJ2dlbmVyYXRlJ1xuICAgICAgICAgICAgICAgIDogJ3JlbmRlcicpO1xuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xuICAgICAgICB9XG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gbmFtZSk7XHJcbiAgICB9KTtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydFRvU2NlbmUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfmianlsZXkuLvov5vnqIvku43mmK/ml6fniYjvvIzor7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQgfHwgc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7XHJcbiAgICBpZiAoIXNldHRpbmdzKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+ICh7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgYWN0aW9uOiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbixcclxuICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAuLi4oc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICB9KSk7XHJcbiAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5YeG5aSH5a+85YWl4oCmJyB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IHByZWZhYlVybD86IHN0cmluZyB9PignaW1wb3J0LXNlbGVjdGlvbicsIHsgb3ZlcnJpZGVzLCBzZXR0aW5ncyB9KTtcclxuICAgICAgICBzaG93VG9hc3QocmVzdWx0Py5wcmVmYWJVcmxcclxuICAgICAgICAgICAgPyBg5a+85YWl5a6M5oiQ77yM5bey5Yib5bu66aKE5Yi25L2T77yaJHtyZXN1bHQucHJlZmFiVXJsfWBcclxuICAgICAgICAgICAgOiAn5a+85YWl5a6M5oiQ77yM5bey5Zyo5Zy65pmv5Lit6YCJ5Lit5qC56IqC54K544CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICflr7zlhaXlpLHotKXjgIInKTtcclxuICAgICAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZXJyb3InLCB2YWx1ZTogMCwgbWVzc2FnZSB9KTtcclxuICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBiaW5kRXZlbnRzKCk6IHZvaWQge1xyXG4gICAgZWxlbWVudCgnI3NhdmUtdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN0b2tlbi1pbnB1dCcpO1xyXG4gICAgICAgIGlmICghaW5wdXQudmFsdWUudHJpbSgpKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIFRva2Vu44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55Pignc2V0LXRva2VuJywgaW5wdXQudmFsdWUpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3ZlcmlmeS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGhhbmRsZTogc3RyaW5nIH0+KCd2ZXJpZnktdG9rZW4nKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDov57mjqXmiJDlip8gwrcgJHtyZXN1bHQuaGFuZGxlfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfov57mjqXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjY2xlYXItdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55PignY2xlYXItdG9rZW4nKTtcclxuICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICBzaG93VG9hc3QoJ+W3sua4hemZpOS/neWtmOeahCBGaWdtYSDlh63mja7jgIInKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtZGV0ZWN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgZGV0ZWN0ZWQgPSBhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcERldGVjdER0bz4oJ3JvdW5kdHJpcC1kZXRlY3QnLCBzb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3QgPSBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290Jyk7XHJcbiAgICAgICAgICAgIHNlbGVjdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIGRldGVjdGVkLm1hbmFnZWRSb290cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICAgICAgICAgICAgICBvcHRpb24udmFsdWUgPSByb290Lm5vZGVJZDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IHJvb3QuZXJyb3JcclxuICAgICAgICAgICAgICAgICAgICA/IGAke3Jvb3QubmFtZX0gwrcg5Y2P6K6u5o2f5Z2PYFxyXG4gICAgICAgICAgICAgICAgICAgIDogYCR7cm9vdC5uYW1lfSDCtyAke3Jvb3QucHJlZmFiVXVpZCA/PyAn5pyq55+lIFByZWZhYid9YDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi5kaXNhYmxlZCA9IEJvb2xlYW4ocm9vdC5lcnJvcik7XHJcbiAgICAgICAgICAgICAgICBzZWxlY3QuYXBwZW5kKG9wdGlvbik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2VsZWN0LnZhbHVlID0gZGV0ZWN0ZWQuc2VsZWN0ZWRSb290SWRcclxuICAgICAgICAgICAgICAgID8/IGRldGVjdGVkLm1hbmFnZWRSb290cy5maW5kKChyb290KSA9PiAhcm9vdC5lcnJvcik/Lm5vZGVJZFxyXG4gICAgICAgICAgICAgICAgPz8gJyc7XHJcbiAgICAgICAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IGRldGVjdGVkLm1hbmFnZWRSb290cy5sZW5ndGggPT09IDA7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7ZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aH0g5LiqIG1hbmFnZWQgcm9vdCDCtyBGaWdtYSAke2RldGVjdGVkLmZpZ21hVmVyc2lvbn3jgILpgInmi6nnm67moIflkI7nlJ/miJDlj6ror7vpooTop4jjgIJgXHJcbiAgICAgICAgICAgICAgICA6ICfmnKrmo4DmtYvliLAgbWFuYWdlZCByb29044CCJztcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDmo4DmtYvlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1yb290JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcHJldmlldycpLmRpc2FibGVkID1cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcHJldmlldycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IHJvdW5kdHJpcFNvdXJjZSgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RJZCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZTtcclxuICAgICAgICBpZiAoIXNvdXJjZSB8fCAhcm9vdElkKSByZXR1cm47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJlbmRlclJvdW5kdHJpcFByZXZpZXcoYXdhaXQgcmVxdWVzdDxSb3VuZHRyaXBQcmV2aWV3RHRvPigncm91bmR0cmlwLXByZXZpZXcnLCBzb3VyY2UsIHJvb3RJZCkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOmihOiniOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXBhaXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFBhaXJUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYWlyZWQgPSBhd2FpdCByZXF1ZXN0PHsgZ2VuZXJhdGlvbjogbnVtYmVyOyBiYXNlbGluZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLXBhaXInLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOmFjeWvueWujOaIkCDCtyBMZWRnZXIgZ2VuZXJhdGlvbiAke3BhaXJlZC5nZW5lcmF0aW9ufVxcbkJhc2VsaW5lICR7cGFpcmVkLmJhc2VsaW5lSGFzaH1cXG7or7fph43mlrDnlJ/miJDlj5jmm7TpooTop4jjgIJgO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ1N1cmZhY2Ug5bey6YWN5a+577yb5pyq5L+u5pS5IFByZWZhYuOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIFBhaXIg5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtYXBwbHknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFByZXZpZXdUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcmVxdWVzdDx7IHR4bklkOiBzdHJpbmc7IHByZWZhYlBvc3RpbWFnZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLWFwcGx5JywgdG9rZW4pO1xyXG4gICAgICAgICAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGDkuovliqHlt7Lmj5DkuqQgwrcgJHtyZWNlaXB0LnR4bklkfVxcblBvc3RpbWFnZSAke3JlY2VpcHQucHJlZmFiUG9zdGltYWdlSGFzaH1cXG7or7fph43mlrDpooTop4jku6Xnoa7orqQgMCBwYXRjaOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnUm91bmQtdHJpcCDlt7Lljp/lrZDlupTnlKjliLDljp8gUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg5bqU55So5aSx6LSl77yM5LqL5Yqh5bey5Zue5rua44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiByZXF1ZXN0KCdyb3VuZHRyaXAtY2FuY2VsJykpO1xyXG5cclxuICAgIGVsZW1lbnQoJyNmZXRjaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgICAgIGlmICghc291cmNlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIOaWh+S7tuaIluiKgueCuemTvuaOpeOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMDUsIG1lc3NhZ2U6ICfmraPlnKjov57mjqUgRmlnbWHigKYnIH0pO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgcmVxdWVzdDxEb2N1bWVudER0bz4oJ2ZldGNoLWRvY3VtZW50Jywgc291cmNlKTtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50KTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuY2xpY2soKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCByZXNldFJvdW5kdHJpcFRva2Vucyk7XHJcbiAgICBlbGVtZW50KCcjcGljay1hc3NldC1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLWFzc2V0LWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDotYTmupDlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjcGljay1wcmVmYWItZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stcHJlZmFiLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6aKE5Yi25L2T5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqemihOWItuS9k+ebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LvvIzlho3pgInmi6nmnKzlnLDotYTmupDnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICAgICBpbmRleCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg5bey5ZCv55So5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6nmnKzlnLDotYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgZWxlbWVudChgI2NsZWFyLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgaW5wdXQudGl0bGUgPSAnJztcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNob3dUb2FzdChg5bey5riF6Zmk5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGltcG9ydFRvU2NlbmUpO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ2NhbmNlbC1pbXBvcnQnKSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBzdGF0ZS5zZWFyY2ggPSAoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgY29sbGFwc2VJZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtY29sbGFwc2VdJyk/LmRhdGFzZXQuY29sbGFwc2U7XHJcbiAgICAgICAgaWYgKGNvbGxhcHNlSWQpIHtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLmNvbGxhcHNlZC5oYXMoY29sbGFwc2VJZCkpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5kZWxldGUoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5jb2xsYXBzZWQuYWRkKGNvbGxhcHNlSWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGFyZ2V0LmNsb3Nlc3QoJ3NlbGVjdCwgbGFiZWwsIGlucHV0LCB0ZXh0YXJlYScpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tkYXRhLW5vZGUtaWRdJyk/LmRhdGFzZXQubm9kZUlkO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpZCA/IGZpbmROb2RlKGlkKSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICB2b2lkIHByZXZpZXcobm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGlmICh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XHJcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlmICghY3VzdG9tTmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+iKgueCueWQjeS4jeiDveS4uuepuuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgaWYgKGN1c3RvbU5hbWUgPT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKVxyXG4gICAgICAgICAgICAgICAgPyBg6IqC54K55bCG5Lul4oCcJHtjdXN0b21OYW1lfeKAneWvvOWFpeOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+W3suaBouWkjSBGaWdtYSDljp/oioLngrnlkI3jgIInKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHRhcmdldC52YWx1ZSBhcyBJbXBvcnRBY3Rpb247XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uICE9PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgc2V0QWN0aW9uKG5vZGUsIGFjdGlvbik7XHJcbiAgICAgICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uID09PSAncmVuZGVyJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNob3dUb2FzdChg4oCcJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX3igJ3lsIbkvZzkuLrmlbTlsYLlr7zlhaXvvIwke2Rlc2NlbmRhbnRzKG5vZGUpLmxlbmd0aH0g5Liq5a2Q6IqC54K55LiN5Lya5Y2V54us55Sf5oiQ44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5raW5kRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldCh0YXJnZXQuZGF0YXNldC5raW5kRm9yLCB0YXJnZXQudmFsdWUgYXMgTm9kZUtpbmQpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQua2luZEZvcik7XHJcbiAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpO1xyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikge1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICBpZiAoKHRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgJ3JlbmRlcicpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGlkID0gdGFyZ2V0LmRhdGFzZXQubmFtZUZvcjtcclxuICAgICAgICBpZiAoIWlkKSByZXR1cm47XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgICAgICB0YXJnZXQuYmx1cigpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoZXZlbnQua2V5ID09PSAnRXNjYXBlJykge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoaWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlQcmVzZXQoYnV0dG9uLmRhdGFzZXQucHJlc2V0ID8/ICdzbWFydCcpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50PihcclxuICAgICAgICAnI3NjYWxlLCAjYXNzZXQtZm9sZGVyLCAjcHJlZmFiLWZvbGRlciwgI2xvY2FsLXJlc291cmNlLWZvbGRlciwgI3VwZGF0ZS1leGlzdGluZywgI3JlZnJlc2gtYXNzZXRzLCAjYXV0by1zYXZlJyxcclxuICAgICkuZm9yRWFjaCgoY29udHJvbCkgPT4ge1xyXG4gICAgICAgIGNvbnRyb2wuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZm9udC1tYXAtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gRWRpdG9yLlBhbmVsLmRlZmluZSh7XHJcbiAgICBsaXN0ZW5lcnM6IHtcclxuICAgICAgICBzaG93KCkge30sXHJcbiAgICAgICAgaGlkZSgpIHt9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGY4JyksXHJcbiAgICBzdHlsZTogcmVhZEZpbGVTeW5jKGpvaW4oX19kaXJuYW1lLCAnLi4vLi4vLi4vc3RhdGljL3N0eWxlL2RlZmF1bHQvaW5kZXguY3NzJyksICd1dGY4JyksXHJcbiAgICAkOiB7XHJcbiAgICAgICAgYXBwOiAnI2FwcCcsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge1xyXG4gICAgICAgIG9uUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpIHtcclxuICAgICAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcmVhZHkoKSB7XHJcbiAgICAgICAgcGFuZWxIb3N0ID0gdGhpcztcclxuICAgICAgICBiaW5kRXZlbnRzKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaW5pdGlhbCA9IGF3YWl0IHJlcXVlc3Q8e1xyXG4gICAgICAgICAgICAgICAgdmVyc2lvbj86IHN0cmluZztcclxuICAgICAgICAgICAgICAgIHZhdWx0OiBhbnk7XHJcbiAgICAgICAgICAgICAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogRG9jdW1lbnREdG8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgZm9udEFzc2V0cz86IEZvbnRBc3NldE9wdGlvbltdO1xyXG4gICAgICAgICAgICB9PignZ2V0LXN0YXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlID0gaW5pdGlhbC52ZXJzaW9uID09PSBwYWNrYWdlSlNPTi52ZXJzaW9uO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gaW5pdGlhbC5mb250QXNzZXRzID8/IFtdO1xyXG4gICAgICAgICAgICBzZXRDb25uZWN0aW9uKGluaXRpYWwudmF1bHQpO1xyXG4gICAgICAgICAgICBhcHBseVNldHRpbmdzKGluaXRpYWwuc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICBpZiAoaW5pdGlhbC5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KGluaXRpYWwuZG9jdW1lbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+ivt+mHjeWQryBDb2Nvcyc7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oa7JztcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn5qOA5rWL5Yiw5pen54mI5Li76L+b56iL5LuN5Zyo6L+Q6KGM77ya6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfliJ3lp4vljJblpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG4gICAgYmVmb3JlQ2xvc2UoKSB7fSxcclxuICAgIGNsb3NlKCkge1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19