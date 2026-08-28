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
    state.patches = (0, model_1.defaultNineSliceIds)(document.tree);
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
    patch.title = node.sliceMode
        ? `启用${node.sliceMode === 'nine' ? '九宫格' : '三宫格'}切片`
        : node.patchCandidate
            ? '启用自动识别的三/九宫格切片'
            : '该节点不是自动识别的切片候选';
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxnREFBMkU7QUFDM0UseURBQTZEO0FBQzdELCtDQUFtRDtBQUNuRCxtQ0FVaUI7QUFtRWpCLElBQUksU0FBUyxHQUFRLElBQUksQ0FBQztBQUMxQixJQUFJLFVBQVUsR0FBeUMsSUFBSSxDQUFDO0FBQzVELElBQUksc0JBQXNCLEdBQXlDLElBQUksQ0FBQztBQUN4RSxJQUFJLG9CQUFvQixHQUFrQixPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFDNUQsSUFBSSxxQkFBeUMsQ0FBQztBQUM5QyxJQUFJLGtCQUFzQyxDQUFDO0FBRTNDLE1BQU0sS0FBSyxHQUFlO0lBQ3RCLFFBQVEsRUFBRSxJQUFJO0lBQ2QsUUFBUSxFQUFFO1FBQ04sU0FBUyxFQUFFLEVBQUU7UUFDYixXQUFXLEVBQUUsZ0JBQWdCO1FBQzdCLFlBQVksRUFBRSx3QkFBd0I7UUFDdEMsb0JBQW9CLEVBQUUsRUFBRTtRQUN4QixtQkFBbUIsRUFBRSxFQUFFO1FBQ3ZCLEtBQUssRUFBRSxDQUFDO1FBQ1IsY0FBYyxFQUFFLElBQUk7UUFDcEIsYUFBYSxFQUFFLEtBQUs7UUFDcEIsUUFBUSxFQUFFLEtBQUs7UUFDZixPQUFPLEVBQUUsRUFBRTtLQUNkO0lBQ0QsZ0JBQWdCLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDM0IsT0FBTyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ2xCLEtBQUssRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNoQixPQUFPLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDbEIsV0FBVyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ3RCLEtBQUssRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNoQixVQUFVLEVBQUUsSUFBSSxHQUFH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QUMsQ0FBQztRQUN2RSxDQUFDO0lBQ0wsQ0FBQztJQUNELFdBQVcsS0FBSSxDQUFDO0lBQ2hCLEtBQUs7UUFDRCxTQUFTLEdBQUcsSUFBSSxDQUFDO0lBQ3JCLENBQUM7Q0FDSixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHBhY2thZ2VKU09OIGZyb20gJy4uLy4uLy4uL3BhY2thZ2UuanNvbic7XHJcbmltcG9ydCB7IGZpbmRGb250QXNzZXQsIHR5cGUgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuLi8uLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuLi8uLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IHRvYXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBpbXBvcnRCdXR0b25SZXNldFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5sZXQgbm9kZU92ZXJyaWRlU2F2ZVRhc2s6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxubGV0IHJvdW5kdHJpcFByZXZpZXdUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG5sZXQgcm91bmR0cmlwUGFpclRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcblxyXG5jb25zdCBzdGF0ZTogUGFuZWxTdGF0ZSA9IHtcclxuICAgIGRvY3VtZW50OiBudWxsLFxyXG4gICAgc2V0dGluZ3M6IHtcclxuICAgICAgICBzb3VyY2VVcmw6ICcnLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXInLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcjogJ2ZpZ21hLWltcG9ydGVyL3ByZWZhYnMnLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBbXSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiAnJyxcclxuICAgICAgICBzY2FsZTogMSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogdHJ1ZSxcclxuICAgICAgICByZWZyZXNoQXNzZXRzOiBmYWxzZSxcclxuICAgICAgICBhdXRvU2F2ZTogZmFsc2UsXHJcbiAgICAgICAgZm9udE1hcDoge30sXHJcbiAgICB9LFxyXG4gICAgcHJlZmVycmVkQWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAgYWN0aW9uczogbmV3IE1hcCgpLFxyXG4gICAga2luZHM6IG5ldyBNYXAoKSxcclxuICAgIHBhdGNoZXM6IG5ldyBTZXQoKSxcclxuICAgIGV4cGxpY2l0SWRzOiBuZXcgU2V0KCksXHJcbiAgICBuYW1lczogbmV3IE1hcCgpLFxyXG4gICAgcmVuYW1lZElkczogbmV3IFNldCgpLFxyXG4gICAgZGVmYXVsdHM6IG5ldyBNYXAoKSxcclxuICAgIGNvbGxhcHNlZDogbmV3IFNldCgpLFxyXG4gICAgc3VwcHJlc3NlZDogbmV3IFNldCgpLFxyXG4gICAgc2VhcmNoOiAnJyxcclxuICAgIGJ1c3k6IGZhbHNlLFxyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IHRydWUsXHJcbiAgICBmb250QXNzZXRzOiBbXSxcclxufTtcclxuXHJcbmZ1bmN0aW9uIHJvb3QoKTogSFRNTEVsZW1lbnQge1xyXG4gICAgcmV0dXJuIHBhbmVsSG9zdC4kLmFwcCBhcyBIVE1MRWxlbWVudDtcclxufVxyXG5cclxuZnVuY3Rpb24gZWxlbWVudDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQ+KHNlbGVjdG9yOiBzdHJpbmcpOiBUIHtcclxuICAgIGNvbnN0IHZhbHVlID0gcm9vdCgpLnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpO1xyXG4gICAgaWYgKCF2YWx1ZSkge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgUGFuZWwgZWxlbWVudCBub3QgZm91bmQ6ICR7c2VsZWN0b3J9YCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdmFsdWU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJlcXVlc3Q8VD4obWVzc2FnZTogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pOiBQcm9taXNlPFQ+IHtcclxuICAgIHJldHVybiBhd2FpdCBFZGl0b3IuTWVzc2FnZS5yZXF1ZXN0KHBhY2thZ2VKU09OLm5hbWUsIG1lc3NhZ2UsIC4uLmFyZ3MpIGFzIFQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNob3dUb2FzdChtZXNzYWdlOiBzdHJpbmcsIGVycm9yID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRvYXN0ID0gZWxlbWVudDxIVE1MRGl2RWxlbWVudD4oJyN0b2FzdCcpO1xyXG4gICAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xyXG4gICAgdG9hc3QuY2xhc3NMaXN0LnRvZ2dsZSgnZXJyb3InLCBlcnJvcik7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QuYWRkKCdzaG93Jyk7XHJcbiAgICBpZiAodG9hc3RUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0b2FzdFRpbWVyKTtcclxuICAgIH1cclxuICAgIHRvYXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoJ3Nob3cnKSwgMzQwMCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93biwgZmFsbGJhY2s6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5tZXNzYWdlKSB7XHJcbiAgICAgICAgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICBpZiAodHlwZW9mIGVycm9yID09PSAnc3RyaW5nJyAmJiBlcnJvci50cmltKCkpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3I7XHJcbiAgICB9XHJcbiAgICBpZiAoZXJyb3IgJiYgdHlwZW9mIGVycm9yID09PSAnb2JqZWN0JyAmJiAnbWVzc2FnZScgaW4gZXJyb3JcclxuICAgICAgICAmJiB0eXBlb2YgKGVycm9yIGFzIHsgbWVzc2FnZT86IHVua25vd24gfSkubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcclxuICAgICAgICByZXR1cm4gKGVycm9yIGFzIHsgbWVzc2FnZTogc3RyaW5nIH0pLm1lc3NhZ2U7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsbGJhY2s7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldENvbm5lY3Rpb24odmF1bHQ6IHtcclxuICAgIGhhc1Rva2VuOiBib29sZWFuO1xyXG4gICAgcGVyc2lzdGVudDogYm9vbGVhbjtcclxuICAgIGJhY2tlbmQ6IHN0cmluZztcclxuICAgIHdhcm5pbmc/OiBzdHJpbmc7XHJcbn0pOiB2b2lkIHtcclxuICAgIGNvbnN0IHBpbGwgPSBlbGVtZW50KCcjY29ubmVjdGlvbi1waWxsJyk7XHJcbiAgICBwaWxsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLW9ubGluZScsIHZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb2ZmbGluZScsICF2YXVsdC5oYXNUb2tlbik7XHJcbiAgICBlbGVtZW50KCcjY29ubmVjdGlvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gdmF1bHQuaGFzVG9rZW4gPyAn5Yet5o2u5bCx57uqJyA6ICfmnKrov57mjqUnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LWJhZGdlJykudGV4dENvbnRlbnQgPSB2YXVsdC5wZXJzaXN0ZW50ID8gJ+ezu+e7n+WKoOWvhicgOiAn5Lya6K+d5a2Y5YKoJztcclxuICAgIGVsZW1lbnQoJyN2YXVsdC1ub3RlJykudGV4dENvbnRlbnQgPSB2YXVsdC53YXJuaW5nXHJcbiAgICAgICAgPz8gKHZhdWx0LnBlcnNpc3RlbnQgPyBg55SxICR7dmF1bHQuYmFja2VuZH0g5Yqg5a+G77yM6aG555uu5Lit5LuF5L+d5a2Y6Z2e5pWP5oSf6K6+572uYCA6ICdUb2tlbiDkuI3lhpnlhaXpobnnm67mlofku7YnKTtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpKS5kaXNhYmxlZCA9ICF2YXVsdC5oYXNUb2tlbjtcclxuICAgIChlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2NsZWFyLXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmbGF0dGVuKG5vZGVzOiBUcmVlTm9kZUR0b1tdKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZXMuZmxhdE1hcCgobm9kZSkgPT4gW25vZGUsIC4uLmZsYXR0ZW4obm9kZS5jaGlsZHJlbildKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZmluZE5vZGUoaWQ6IHN0cmluZywgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudD8udHJlZSA/PyBbXSk6IFRyZWVOb2RlRHRvIHwgdW5kZWZpbmVkIHtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xyXG4gICAgICAgIGlmIChub2RlLmlkID09PSBpZCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbm9kZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hpbGQgPSBmaW5kTm9kZShpZCwgbm9kZS5jaGlsZHJlbik7XHJcbiAgICAgICAgaWYgKGNoaWxkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBjaGlsZDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJGb250TWFwKCk6IHZvaWQge1xyXG4gICAgY29uc3QgbGlzdCA9IGVsZW1lbnQoJyNmb250LW1hcC1saXN0Jyk7XHJcbiAgICBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgY29uc3QgZmFtaWxpZXMgPSBzdGF0ZS5kb2N1bWVudD8uZm9udHMgPz8gW107XHJcbiAgICBpZiAoIWZhbWlsaWVzLmxlbmd0aCkge1xyXG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLWVtcHR5JztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg5ZCO77yM6L+Z6YeM5Lya5YiX5Ye65qOA5rWL5Yiw55qE5a2X5L2T44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmZvbnRBc3NldHMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHkgaXMtd2FybmluZyc7XHJcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSAn6aG555uuIGFzc2V0cyDlhoXmsqHmnInmo4DmtYvliLAgLnR0ZiAvIC5vdGYgLyAuZm50IC8gLndvZmYg5a2X5L2T6LWE5rqQ44CCJztcclxuICAgICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIGZhbWlsaWVzKSB7XHJcbiAgICAgICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgcm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1yb3cnO1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBzb3VyY2UuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNvdXJjZSc7XHJcbiAgICAgICAgc291cmNlLnRleHRDb250ZW50ID0gZmFtaWx5O1xyXG4gICAgICAgIHNvdXJjZS50aXRsZSA9IGZhbWlseTtcclxuICAgICAgICBjb25zdCBhcnJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICBhcnJvdy5jbGFzc05hbWUgPSAnZm9udC1tYXAtYXJyb3cnO1xyXG4gICAgICAgIGFycm93LnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICAgICAgc2VsZWN0LmNsYXNzTmFtZSA9ICdmb250LW1hcC1zZWxlY3QnO1xyXG4gICAgICAgIHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHkgPSBmYW1pbHk7XHJcbiAgICAgICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke2ZhbWlseX0g5pig5bCE5a2X5L2TYCk7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbignJywgJ+S4jeaYoOWwhO+8iOS9v+eUqOm7mOiupOWtl+S9k++8iScpKTtcclxuICAgICAgICBjb25zdCBhdXRvbWF0aWMgPSBmaW5kRm9udEFzc2V0KGZhbWlseSwgc3RhdGUuZm9udEFzc2V0cyk7XHJcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS5zZXR0aW5ncy5mb250TWFwW2ZhbWlseV0gPz8gYXV0b21hdGljPy51cmwgPz8gJyc7XHJcbiAgICAgICAgZm9yIChjb25zdCBhc3NldCBvZiBzdGF0ZS5mb250QXNzZXRzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGl0ZW0gPSBvcHRpb24oYXNzZXQudXJsLCBgJHthc3NldC5uYW1lfSDCtyAke2Fzc2V0LnJlbGF0aXZlUGF0aH1gKTtcclxuICAgICAgICAgICAgaXRlbS5zZWxlY3RlZCA9IGFzc2V0LnVybCA9PT0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChpdGVtKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2VsZWN0LnZhbHVlID0gc2VsZWN0ZWQ7XHJcbiAgICAgICAgcm93LmFwcGVuZChzb3VyY2UsIGFycm93LCBzZWxlY3QpO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQocm93KTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gc2FmZUFjdGlvbihfbm9kZTogVHJlZU5vZGVEdG8sIGFjdGlvbjogdW5rbm93bik6IEltcG9ydEFjdGlvbiB7XHJcbiAgICByZXR1cm4gbm9ybWFsaXplSW1wb3J0QWN0aW9uKGFjdGlvbik7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluaXRpYWxpemVEb2N1bWVudChkb2N1bWVudDogRG9jdW1lbnREdG8pOiB2b2lkIHtcclxuICAgIHN0YXRlLmRvY3VtZW50ID0gZG9jdW1lbnQ7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5raW5kcy5jbGVhcigpO1xyXG4gICAgc3RhdGUucGF0Y2hlcy5jbGVhcigpO1xyXG4gICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLm5hbWVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5yZW5hbWVkSWRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5kZWZhdWx0cy5jbGVhcigpO1xyXG4gICAgc3RhdGUuY29sbGFwc2VkLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkLmNsZWFyKCk7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgZmxhdHRlbihkb2N1bWVudC50cmVlKSkge1xyXG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKTtcclxuICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBhY3Rpb24pO1xyXG4gICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBub2RlLmtpbmQpO1xyXG4gICAgICAgIHN0YXRlLmRlZmF1bHRzLnNldChub2RlLmlkLCB7IGFjdGlvbiwga2luZDogbm9kZS5raW5kIH0pO1xyXG4gICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBub2RlLm5hbWUpO1xyXG4gICAgfVxyXG4gICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoZG9jdW1lbnQudHJlZSk7XHJcbiAgICBmb3IgKGNvbnN0IG92ZXJyaWRlIG9mIGRvY3VtZW50Lm5vZGVPdmVycmlkZXMgPz8gW10pIHtcclxuICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUob3ZlcnJpZGUuaWQsIGRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGlmICghbm9kZSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY3VzdG9tTmFtZSA9IHNhbml0aXplTm9kZU5hbWUob3ZlcnJpZGUubmFtZSk7XHJcbiAgICAgICAgaWYgKGN1c3RvbU5hbWUgJiYgY3VzdG9tTmFtZSAhPT0gbm9kZS5uYW1lKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChvdmVycmlkZS5leHBsaWNpdCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBzYWZlQWN0aW9uKG5vZGUsIG92ZXJyaWRlLmFjdGlvbikpO1xyXG4gICAgICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgb3ZlcnJpZGUua2luZCk7XHJcbiAgICAgICAgICAgIGlmIChvdmVycmlkZS5uaW5lU2xpY2UgJiYgbm9kZS5wYXRjaENhbmRpZGF0ZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoXHJcbiAgICAgICAgICAgICdhY3RpdmUnLFxyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5zaXplID09PSAwICYmIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gJ3NtYXJ0JyxcclxuICAgICAgICApO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZmlsZS1uYW1lJykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5maWxlTmFtZTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBkb2N1bWVudC5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50KCcjZm9udC1oaW50JykudGV4dENvbnRlbnQgPSBkb2N1bWVudC5mb250cy5sZW5ndGhcclxuICAgICAgICA/IGDmo4DmtYvliLDvvJoke2RvY3VtZW50LmZvbnRzLmpvaW4oJ+OAgScpfWBcclxuICAgICAgICA6ICflvZPliY3mlofku7blsJrmnKrlj5HnjrDlrZfkvZPjgIInO1xyXG4gICAgcmVuZGVyRm9udE1hcCgpO1xyXG4gICAgcmVuZGVyVHJlZSh0cnVlKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlTZXR0aW5ncyhzZXR0aW5nczogSW1wb3J0U2V0dGluZ3MpOiB2b2lkIHtcclxuICAgIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlID0gc2V0dGluZ3Muc291cmNlVXJsO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlID0gc2V0dGluZ3MuYXNzZXRGb2xkZXI7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpLnZhbHVlID0gc2V0dGluZ3MucHJlZmFiRm9sZGVyO1xyXG4gICAgY29uc3QgbG9jYWxSZXNvdXJjZUZvbGRlcnMgPSBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVycz8ubGVuZ3RoXHJcbiAgICAgICAgPyBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyc1xyXG4gICAgICAgIDogc2V0dGluZ3MubG9jYWxSZXNvdXJjZUZvbGRlclxyXG4gICAgICAgICAgICA/IFtzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICBpbnB1dC52YWx1ZSA9IGxvY2FsUmVzb3VyY2VGb2xkZXJzW2luZGV4XSA/PyAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9IGxvY2FsUmVzb3VyY2VGb2xkZXJzW2luZGV4XSA/PyAnJztcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlID0gU3RyaW5nKHNldHRpbmdzLnNjYWxlKTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN1cGRhdGUtZXhpc3RpbmcnKS5jaGVja2VkID0gc2V0dGluZ3MudXBkYXRlRXhpc3Rpbmc7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcmVmcmVzaC1hc3NldHMnKS5jaGVja2VkID0gc2V0dGluZ3MucmVmcmVzaEFzc2V0cztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhdXRvLXNhdmUnKS5jaGVja2VkID0gc2V0dGluZ3MuYXV0b1NhdmU7XHJcbiAgICB1cGRhdGVUYXJnZXRIaW50KCk7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlYWRTZXR0aW5ncyhzaG93RXJyb3IgPSB0cnVlKTogSW1wb3J0U2V0dGluZ3MgfCBudWxsIHtcclxuICAgIGNvbnN0IGZvbnRNYXA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLnN0YXRlLnNldHRpbmdzLmZvbnRNYXAgfTtcclxuICAgIGlmIChzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZmFtaWx5IG9mIHN0YXRlLmRvY3VtZW50LmZvbnRzKSB7XHJcbiAgICAgICAgICAgIGRlbGV0ZSBmb250TWFwW2ZhbWlseV07XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KCdbZGF0YS1mb250LWZhbWlseV0nKS5mb3JFYWNoKChzZWxlY3QpID0+IHtcclxuICAgICAgICBjb25zdCBmYW1pbHkgPSBzZWxlY3QuZGF0YXNldC5mb250RmFtaWx5Py50cmltKCk7XHJcbiAgICAgICAgaWYgKGZhbWlseSAmJiBzZWxlY3QudmFsdWUpIHtcclxuICAgICAgICAgICAgZm9udE1hcFtmYW1pbHldID0gc2VsZWN0LnZhbHVlO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgY29uc3Qgc2NhbGUgPSBOdW1iZXIoZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUpO1xyXG4gICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2NhbGUpIHx8IHNjYWxlIDwgMC4yNSB8fCBzY2FsZSA+IDQpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn5a+85YWl5YCN546H5b+F6aG75ZyoIDAuMjUg5YiwIDQg5LmL6Ze044CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYXNzZXRGb2xkZXIgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFhc3NldEZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npobnnm64gYXNzZXRzIOS4i+eahOi1hOa6kOi+k+WHuuebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IHByZWZhYkZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFwcmVmYWJGb2xkZXIpIHtcclxuICAgICAgICBpZiAoc2hvd0Vycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36YCJ5oup6aKE5Yi25L2T6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzb3VyY2VVcmw6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpLFxyXG4gICAgICAgIGFzc2V0Rm9sZGVyLFxyXG4gICAgICAgIHByZWZhYkZvbGRlcixcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyczogQXJyYXkuZnJvbSh7IGxlbmd0aDogMyB9LCAoXywgaW5kZXgpID0+XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgKSxcclxuICAgICAgICBsb2NhbFJlc291cmNlRm9sZGVyOiBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLTAnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgc2NhbGUsXHJcbiAgICAgICAgdXBkYXRlRXhpc3Rpbmc6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN1cGRhdGUtZXhpc3RpbmcnKS5jaGVja2VkLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQsXHJcbiAgICAgICAgYXV0b1NhdmU6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhdXRvLXNhdmUnKS5jaGVja2VkLFxyXG4gICAgICAgIGZvbnRNYXAsXHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRCdXN5KHZhbHVlOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5idXN5ID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjc2F2ZS10b2tlbicpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3BpY2stYXNzZXQtZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1wcmVmYWItZm9sZGVyJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWRldGVjdCcpLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZSA9PT0gJyc7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB2YWx1ZSB8fCAhcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIH1cclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gdmFsdWVcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWhpZGRlbicsICF2YWx1ZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gdW5kZWZpbmVkO1xyXG4gICAgcm91bmR0cmlwUGFpclRva2VuID0gdW5kZWZpbmVkO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gdHJ1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiByb3VuZHRyaXBTb3VyY2UoKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgICBjb25zdCBzb3VyY2UgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKTtcclxuICAgIGlmICghc291cmNlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEg5paH5Lu25oiW6IqC54K56ZO+5o6l44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc291cmNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJSb3VuZHRyaXBQcmV2aWV3KHByZXZpZXc6IFJvdW5kdHJpcFByZXZpZXdEdG8pOiB2b2lkIHtcclxuICAgIHJvdW5kdHJpcFByZXZpZXdUb2tlbiA9IHByZXZpZXcucHJldmlld1Rva2VuO1xyXG4gICAgcm91bmR0cmlwUGFpclRva2VuID0gcHJldmlldy5wYWlyVG9rZW47XHJcbiAgICBjb25zdCBsaW5lcyA9IFtcclxuICAgICAgICBg55uu5qCH77yaJHtwcmV2aWV3LmFzc2V0VXJsfWAsXHJcbiAgICAgICAgYFByZWZhYu+8miR7cHJldmlldy5wcmVmYWJVdWlkfWAsXHJcbiAgICAgICAgYFN1cmZhY2XvvJoke3ByZXZpZXcuc3VyZmFjZUlkfSDCtyBGaWdtYSAke3ByZXZpZXcuZmlnbWFWZXJzaW9ufSDCtyBMZWRnZXIgJHtwcmV2aWV3LmxlZGdlckdlbmVyYXRpb259YCxcclxuICAgICAgICBg5bCG5L+u5pS5ICR7cHJldmlldy5wbGFuLmFwcGx5Lmxlbmd0aH0g6aG5IMK3IOS/neeVmSBDb2NvcyAke3ByZXZpZXcucGxhbi5wcmVzZXJ2ZUNvY29zLmxlbmd0aH0g6aG5IMK3IOW3suaUtuaVmyAke3ByZXZpZXcucGxhbi5jb252ZXJnZWQubGVuZ3RofSDpoblgLFxyXG4gICAgICAgIGDlhrLnqoEgJHtwcmV2aWV3LnBsYW4uY29uZmxpY3RzLmxlbmd0aH0g6aG5IMK3IOS4jeaUr+aMgSAke3ByZXZpZXcucGxhbi51bnN1cHBvcnRlZC5sZW5ndGh9IOmhuSDCtyDlj6ror7vmnKrmlLkgJHtwcmV2aWV3LnBsYW4ucmVhZG9ubHlVbmNoYW5nZWQubGVuZ3RofSDpoblgLFxyXG4gICAgICAgIHByZXZpZXcucGFpclJlcXVpcmVkXHJcbiAgICAgICAgICAgID8gcHJldmlldy5wYWlyRWxpZ2libGUgPyAn6aaW5qyh5L2/55So77ya6K+B5o2u5LiA6Ie077yM6K+35YWI56Gu6K6k6YWN5a+5IFN1cmZhY2XvvIjlj6rlhpkgbGVkZ2Vy77yM5LiN5pS5IFByZWZhYu+8ieOAgicgOiAn6aaW5qyh5L2/55So77yaUGFpciDor4Hmja7kuI3kuIDoh7TvvIzpnIDku47lvZPliY0gUHJlZmFiIOmHjeaWsOWvvOWHuuOAgidcclxuICAgICAgICAgICAgOiBwcmV2aWV3LmJsb2NrZXJzLmxlbmd0aCA/IGDpmLvmlq3vvJoke3ByZXZpZXcuYmxvY2tlcnMuam9pbignLCAnKX1gIDogJ+mihOiniOmAmui/h++8jOWPr+WOn+WtkOW6lOeUqOaVtOS4quS4jeWPr+WPmOiuoeWIkuOAgicsXHJcbiAgICBdO1xyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBsaW5lcy5qb2luKCdcXG4nKTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlVGFyZ2V0SGludCgpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICfkuLvov5vnqIvkuI7pnaLmnb/niYjmnKzkuI3kuIDoh7TvvIzpnIDopoHlrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcic7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2FjdGlvbi1ub3RlJykudGV4dENvbnRlbnQgPSAn5a+85YWl5Yiw5b2T5YmN5Zy65pmvIENhbnZhcyDmoLnoioLngrnkuIvvvJtGcmFtZSDpk77mjqXlsIboh6rliqjliJvlu7rlubbmiZPlvIDpooTliLbkvZMnO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXNldEltcG9ydEJ1dHRvbigpOiB2b2lkIHtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycsICdpcy1lcnJvcicpO1xyXG4gICAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1idXN5Jyk7XHJcbiAgICBidXR0b24udGl0bGUgPSAn5a+85YWl5Yiw5b2T5YmN5omT5byA5Zy65pmv5oiW6aKE5Yi25L2TJztcclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5a+85YWl5Yiw5Zy65pmvJztcclxuICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihpInO1xyXG4gICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzAlJztcclxufVxyXG5cclxuZnVuY3Rpb24gaW1wb3J0UHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiBudW1iZXIge1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnYXNzZXRzJykge1xyXG4gICAgICAgIHJldHVybiAwLjA1ICsgdmFsdWUgKiAwLjU1O1xyXG4gICAgfVxyXG4gICAgaWYgKGV2ZW50LnBoYXNlID09PSAnc2NlbmUnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuNiArIHZhbHVlICogMC4zODtcclxuICAgIH1cclxuICAgIHJldHVybiBldmVudC5waGFzZSA9PT0gJ2RvbmUnID8gMSA6IDA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVByb2dyZXNzKGV2ZW50OiBQcm9ncmVzc0V2ZW50KTogdm9pZCB7XHJcbiAgICBjb25zdCByZWdpb24gPSBlbGVtZW50KCcjcHJvZ3Jlc3MtcmVnaW9uJyk7XHJcbiAgICBjb25zdCBidXN5ID0gWydmZXRjaCcsICdhc3NldHMnLCAnc2NlbmUnXS5pbmNsdWRlcyhldmVudC5waGFzZSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtYnVzeScsIGJ1c3kpO1xyXG4gICAgcmVnaW9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWVycm9yJywgZXZlbnQucGhhc2UgPT09ICdlcnJvcicpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgY29uc3QgdmFsdWUgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCBldmVudC52YWx1ZSkpO1xyXG4gICAgZWxlbWVudCgnI3Byb2dyZXNzLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQodmFsdWUgKiAxMDApfSVgO1xyXG4gICAgKGVsZW1lbnQoJyNwcm9ncmVzcy1iYXInKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHt2YWx1ZSAqIDEwMH0lYDtcclxuICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgY29uc3QgaW1wb3J0aW5nID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnO1xyXG4gICAgaWYgKGltcG9ydEJ1dHRvblJlc2V0VGltZXIpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcik7XHJcbiAgICAgICAgaW1wb3J0QnV0dG9uUmVzZXRUaW1lciA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoaW1wb3J0aW5nKSB7XHJcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBpbXBvcnRQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXJ1bm5pbmcnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtc3VjY2VzcycsICdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoJ2FyaWEtYnVzeScsICd0cnVlJyk7XHJcbiAgICAgICAgYnV0dG9uLnRpdGxlID0gZXZlbnQubWVzc2FnZTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdhc3NldHMnID8gJ+WHhuWkh+i1hOa6kCcgOiAn5p6E5bu66IqC54K5JztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSBgJHtNYXRoLnJvdW5kKHByb2dyZXNzICogMTAwKX0lYDtcclxuICAgICAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSBgJHtwcm9ncmVzcyAqIDEwMH0lYDtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdkb25lJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWujOaIkCc7XHJcbiAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJzEwMCUnO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9ICcxMDAlJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTQwMCk7XHJcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnBoYXNlID09PSAnZXJyb3InIHx8IGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJykge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1ydW5uaW5nJywgJ2lzLXN1Y2Nlc3MnKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnID8gJ+W3suWPlua2iCcgOiAn5a+85YWl5aSx6LSlJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn6YeN6K+VJztcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gc2V0VGltZW91dChyZXNldEltcG9ydEJ1dHRvbiwgMTgwMCk7XHJcbiAgICB9XHJcbiAgICBpZiAoWydkb25lJywgJ2Vycm9yJywgJ2NhbmNlbGxlZCcsICdpZGxlJ10uaW5jbHVkZXMoZXZlbnQucGhhc2UpKSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc2NlbmRhbnRzKG5vZGU6IFRyZWVOb2RlRHRvKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5mbGF0TWFwKChjaGlsZCkgPT4gW2NoaWxkLCAuLi5kZXNjZW5kYW50cyhjaGlsZCldKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVjb25jaWxlQWN0aW9ucygpOiB2b2lkIHtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZSA9IHJlc29sdmVFZmZlY3RpdmVBY3Rpb25zKFxyXG4gICAgICAgIHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdLFxyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMsXHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyxcclxuICAgICk7XHJcbiAgICBzdGF0ZS5hY3Rpb25zID0gZWZmZWN0aXZlLmFjdGlvbnM7XHJcbiAgICBzdGF0ZS5zdXBwcmVzc2VkID0gZWZmZWN0aXZlLnN1cHByZXNzZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEFjdGlvbihub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiBJbXBvcnRBY3Rpb24pOiB2b2lkIHtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgYWN0aW9uKSk7XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGU6IFRyZWVOb2RlRHRvKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBzdGF0ZS5uYW1lcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5uYW1lO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleHBsaWNpdE92ZXJyaWRlcygpOiBJbXBvcnRPdmVycmlkZVtdIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKVxyXG4gICAgICAgIC5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSlcclxuICAgICAgICAubWFwKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlbmFtZWQgPSBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgICAgICAgICAgYWN0aW9uOiBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLmdldChub2RlLmlkKSA/PyBzbWFydEFjdGlvbkZvck5vZGUobm9kZSksXHJcbiAgICAgICAgICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgICAgICAgICAgbmluZVNsaWNlOiBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICAuLi4ocmVuYW1lZCA/IHsgbmFtZTogZWZmZWN0aXZlTm9kZU5hbWUobm9kZSkgfSA6IHt9KSxcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdE5vZGVPdmVycmlkZXMoKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZUtleSA9IHN0YXRlLmRvY3VtZW50LmZpbGVLZXk7XHJcbiAgICBjb25zdCBvdmVycmlkZXMgPSBleHBsaWNpdE92ZXJyaWRlcygpO1xyXG4gICAgY29uc3Qgc2NvcGVJZHMgPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpLm1hcCgobm9kZSkgPT4gbm9kZS5pZCk7XHJcbiAgICAvLyBTZXJpYWxpemUgd3JpdGVzIHNvIGEgc2xvd2VyIGVhcmxpZXIgcmVxdWVzdCBjYW4gbmV2ZXIgb3ZlcndyaXRlIGEgbmV3ZXJcclxuICAgIC8vIHN0cmF0ZWd5IHNuYXBzaG90IGFmdGVyIHJhcGlkIHNlbGVjdCBjaGFuZ2VzLlxyXG4gICAgbm9kZU92ZXJyaWRlU2F2ZVRhc2sgPSBub2RlT3ZlcnJpZGVTYXZlVGFza1xyXG4gICAgICAgIC5jYXRjaCgoKSA9PiB1bmRlZmluZWQpXHJcbiAgICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBhd2FpdCByZXF1ZXN0PEltcG9ydE92ZXJyaWRlW10+KCdzYXZlLW5vZGUtb3ZlcnJpZGVzJywgZmlsZUtleSwgb3ZlcnJpZGVzLCBzY29wZUlkcyk7XHJcbiAgICAgICAgfSlcclxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICfoioLngrnnrZbnlaXkv53lrZjlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1hdGNoZXMobm9kZTogVHJlZU5vZGVEdG8pOiBib29sZWFuIHtcclxuICAgIGlmICghc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICBjb25zdCBoYXlzdGFjayA9IGAke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfSAke25vZGUubmFtZX0gJHtub2RlLnR5cGV9ICR7bm9kZS5pZH1gLnRvTG93ZXJDYXNlKCk7XHJcbiAgICBpZiAoaGF5c3RhY2suaW5jbHVkZXMoc3RhdGUuc2VhcmNoKSkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIG5vZGUuY2hpbGRyZW4uc29tZShtYXRjaGVzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gb3B0aW9uKHZhbHVlOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpOiBIVE1MT3B0aW9uRWxlbWVudCB7XHJcbiAgICBjb25zdCBpdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICBpdGVtLnZhbHVlID0gdmFsdWU7XHJcbiAgICBpdGVtLnRleHRDb250ZW50ID0gbGFiZWw7XHJcbiAgICByZXR1cm4gaXRlbTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWFrZVNlbGVjdChcclxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxyXG4gICAgdmFsdWU6IHN0cmluZyxcclxuICAgIGl0ZW1zOiBBcnJheTxbc3RyaW5nLCBzdHJpbmddPixcclxuICAgIGxhYmVsOiBzdHJpbmcsXHJcbik6IEhUTUxTZWxlY3RFbGVtZW50IHtcclxuICAgIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NlbGVjdCcpO1xyXG4gICAgc2VsZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcclxuICAgIHNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBsYWJlbCk7XHJcbiAgICBmb3IgKGNvbnN0IFtrZXksIHRleHRdIG9mIGl0ZW1zKSB7XHJcbiAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbihrZXksIHRleHQpKTtcclxuICAgIH1cclxuICAgIHNlbGVjdC52YWx1ZSA9IHZhbHVlO1xyXG4gICAgcmV0dXJuIHNlbGVjdDtcclxufVxyXG5cclxuZnVuY3Rpb24gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgbm9kZTogVHJlZU5vZGVEdG8sIGRlcHRoOiBudW1iZXIpOiB2b2lkIHtcclxuICAgIGlmICghbWF0Y2hlcyhub2RlKSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgcm93LmNsYXNzTmFtZSA9IGB0cmVlLXJvdyR7c3RhdGUuc2VsZWN0ZWRJZCA9PT0gbm9kZS5pZCA/ICcgaXMtc2VsZWN0ZWQnIDogJyd9YDtcclxuICAgIHJvdy5kYXRhc2V0Lm5vZGVJZCA9IG5vZGUuaWQ7XHJcbiAgICByb3cuc2V0QXR0cmlidXRlKCdyb2xlJywgJ3RyZWVpdGVtJyk7XHJcbiAgICByb3cuc2V0QXR0cmlidXRlKCdhcmlhLWxldmVsJywgU3RyaW5nKGRlcHRoICsgMSkpO1xyXG5cclxuICAgIGNvbnN0IG1haW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1haW4uY2xhc3NOYW1lID0gJ25vZGUtbWFpbic7XHJcbiAgICBtYWluLnN0eWxlLnNldFByb3BlcnR5KCctLWRlcHRoJywgU3RyaW5nKGRlcHRoKSk7XHJcbiAgICBjb25zdCBjb2xsYXBzZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xyXG4gICAgY29sbGFwc2UuY2xhc3NOYW1lID0gYGNvbGxhcHNlJHtub2RlLmNoaWxkcmVuLmxlbmd0aCA/ICcnIDogJyBpcy1sZWFmJ31gO1xyXG4gICAgY29sbGFwc2UudHlwZSA9ICdidXR0b24nO1xyXG4gICAgY29sbGFwc2UuZGF0YXNldC5jb2xsYXBzZSA9IG5vZGUuaWQ7XHJcbiAgICBjb2xsYXBzZS50ZXh0Q29udGVudCA9IHN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgPyAn4oC6JyA6ICfijIQnO1xyXG4gICAgY29sbGFwc2Uuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICflsZXlvIAnIDogJ+aKmOWPoCcpO1xyXG4gICAgY29uc3QgZG90ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgZG90LmNsYXNzTmFtZSA9IGB0eXBlLWRvdCAke1xyXG4gICAgICAgIG5vZGUudHlwZSA9PT0gJ1RFWFQnID8gJ3RleHQnXHJcbiAgICAgICAgICAgIDogaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3ZlY3RvcidcclxuICAgICAgICAgICAgICAgIDogbm9kZS50eXBlLmluY2x1ZGVzKCdDT01QT05FTlQnKSB8fCBub2RlLnR5cGUgPT09ICdJTlNUQU5DRScgPyAnY29tcG9uZW50J1xyXG4gICAgICAgICAgICAgICAgICAgIDogJydcclxuICAgIH1gO1xyXG4gICAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgY29weS5jbGFzc05hbWUgPSAnbm9kZS1jb3B5JztcclxuICAgIGNvbnN0IGRpc3BsYXlOYW1lID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcclxuICAgIG5hbWUudHlwZSA9ICd0ZXh0JztcclxuICAgIG5hbWUuY2xhc3NOYW1lID0gYG5vZGUtbmFtZS1pbnB1dCR7c3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyAnIGlzLXJlbmFtZWQnIDogJyd9YDtcclxuICAgIG5hbWUudmFsdWUgPSBkaXNwbGF5TmFtZTtcclxuICAgIG5hbWUubWF4TGVuZ3RoID0gOTY7XHJcbiAgICBuYW1lLnNwZWxsY2hlY2sgPSBmYWxzZTtcclxuICAgIG5hbWUuZGF0YXNldC5uYW1lRm9yID0gbm9kZS5pZDtcclxuICAgIG5hbWUuc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7bm9kZS5uYW1lfSDlr7zlhaXoioLngrnlkI1gKTtcclxuICAgIGNvbnN0IHN0cmF0ZWd5U3VtbWFyeSA9IHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUobm9kZSwgc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpKTtcclxuICAgIG5hbWUudGl0bGUgPSBbXHJcbiAgICAgICAgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyBgRmlnbWEg5Y6f5ZCN77yaJHtub2RlLm5hbWV9YCA6ICfngrnlh7vkv67mlLnlr7zlhaXoioLngrnlkI0nLFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkud2FybmluZyxcclxuICAgIF1cclxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXHJcbiAgICAgICAgLmpvaW4oJyDCtyAnKTtcclxuICAgIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIG1ldGEuY2xhc3NOYW1lID0gJ25vZGUtbWV0YSc7XHJcbiAgICBtZXRhLnRleHRDb250ZW50ID0gYCR7bm9kZS50eXBlfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb3B5LmFwcGVuZChuYW1lLCBtZXRhKTtcclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kpIHtcclxuICAgICAgICBjb25zdCBzdHJhdGVneSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHN0cmF0ZWd5LmNsYXNzTmFtZSA9ICdub2RlLXN0cmF0ZWd5JztcclxuICAgICAgICBzdHJhdGVneS50ZXh0Q29udGVudCA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBzdHJhdGVneS50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneTtcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHN0cmF0ZWd5KTtcclxuICAgIH1cclxuICAgIGlmIChzdHJhdGVneVN1bW1hcnkud2FybmluZykge1xyXG4gICAgICAgIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICB3YXJuaW5nLmNsYXNzTmFtZSA9ICdub2RlLXdhcm5pbmcnO1xyXG4gICAgICAgIHdhcm5pbmcudGV4dENvbnRlbnQgPSBg4pqgICR7c3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmd9YDtcclxuICAgICAgICB3YXJuaW5nLnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmc7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZCh3YXJuaW5nKTtcclxuICAgIH1cclxuICAgIHJvdy5jbGFzc0xpc3QudG9nZ2xlKCdoYXMtZGV0YWlsJywgQm9vbGVhbihzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3kgfHwgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpKTtcclxuICAgIG1haW4uYXBwZW5kKGNvbGxhcHNlLCBkb3QsIGNvcHkpO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkQWN0aW9uID0gc2FmZUFjdGlvbihub2RlLCBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbik7XHJcbiAgICBjb25zdCBhY3Rpb25PcHRpb25zID0gYWN0aW9uT3B0aW9uc0Zvck5vZGUobm9kZSk7XHJcbiAgICBjb25zdCBhY3Rpb24gPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdhY3Rpb24tc2VsZWN0JyxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBhY3Rpb25PcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDlr7zlhaXmlrnlvI9gLFxyXG4gICAgKTtcclxuICAgIGFjdGlvbi5kYXRhc2V0LmFjdGlvbkZvciA9IG5vZGUuaWQ7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRLaW5kID0gc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZDtcclxuICAgIGNvbnN0IGVmZmVjdGl2ZUtpbmQgPSBlZmZlY3RpdmVLaW5kRm9yTm9kZShcclxuICAgICAgICBub2RlLFxyXG4gICAgICAgIHNlbGVjdGVkS2luZCxcclxuICAgICAgICBzZWxlY3RlZEFjdGlvbixcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICk7XHJcbiAgICBjb25zdCBraW5kT3B0aW9ucyA9IGtpbmRPcHRpb25zRm9yQWN0aW9uKHNlbGVjdGVkQWN0aW9uKTtcclxuICAgIGNvbnN0IGtpbmQgPSBtYWtlU2VsZWN0KFxyXG4gICAgICAgICdraW5kLXNlbGVjdCcsXHJcbiAgICAgICAgZWZmZWN0aXZlS2luZCxcclxuICAgICAgICBraW5kT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g6IqC54K557G75Z6LYCxcclxuICAgICk7XHJcbiAgICBraW5kLmRhdGFzZXQua2luZEZvciA9IG5vZGUuaWQ7XHJcblxyXG4gICAgY29uc3QgcGF0Y2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdsYWJlbCcpO1xyXG4gICAgcGF0Y2guY2xhc3NOYW1lID0gJ3BhdGNoLXRvZ2dsZSc7XHJcbiAgICBwYXRjaC50aXRsZSA9IG5vZGUuc2xpY2VNb2RlXHJcbiAgICAgICAgPyBg5ZCv55SoJHtub2RlLnNsaWNlTW9kZSA9PT0gJ25pbmUnID8gJ+S5neWuq+agvCcgOiAn5LiJ5a6r5qC8J33liIfniYdgXHJcbiAgICAgICAgOiBub2RlLnBhdGNoQ2FuZGlkYXRlXHJcbiAgICAgICAgICAgID8gJ+WQr+eUqOiHquWKqOivhuWIq+eahOS4iS/kuZ3lrqvmoLzliIfniYcnXHJcbiAgICAgICAgICAgIDogJ+ivpeiKgueCueS4jeaYr+iHquWKqOivhuWIq+eahOWIh+eJh+WAmemAiSc7XHJcbiAgICBjb25zdCBwYXRjaElucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW5wdXQnKTtcclxuICAgIHBhdGNoSW5wdXQudHlwZSA9ICdjaGVja2JveCc7XHJcbiAgICBwYXRjaElucHV0LmRhdGFzZXQucGF0Y2hGb3IgPSBub2RlLmlkO1xyXG4gICAgcGF0Y2hJbnB1dC5jaGVja2VkID0gc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCk7XHJcbiAgICBwYXRjaElucHV0LmRpc2FibGVkID0gIW5vZGUucGF0Y2hDYW5kaWRhdGU7XHJcbiAgICBjb25zdCBwYXRjaEljb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBwYXRjaEljb24udGV4dENvbnRlbnQgPSAn4pamJztcclxuICAgIHBhdGNoLmFwcGVuZChwYXRjaElucHV0LCBwYXRjaEljb24pO1xyXG4gICAgcm93LmFwcGVuZChtYWluLCBhY3Rpb24sIGtpbmQsIHBhdGNoKTtcclxuICAgIGNvbnRhaW5lci5hcHBlbmRDaGlsZChyb3cpO1xyXG5cclxuICAgIGlmICghc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSB8fCBzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICBub2RlLmNoaWxkcmVuLmZvckVhY2goKGNoaWxkKSA9PiBhcHBlbmRUcmVlTm9kZShjb250YWluZXIsIGNoaWxkLCBkZXB0aCArIDEpKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyVHJlZShyZXNldFNjcm9sbCA9IGZhbHNlKTogdm9pZCB7XHJcbiAgICBjb25zdCB0cmVlID0gZWxlbWVudCgnI3RyZWUnKTtcclxuICAgIHJlcmVuZGVyUHJlc2VydmluZ1Njcm9sbCh0cmVlLCAoKSA9PiB7XHJcbiAgICAgICAgdHJlZS5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdlbXB0eS1zdGF0ZSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGdseXBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgICAgICBnbHlwaC5jbGFzc05hbWUgPSAnZW1wdHktZ2x5cGgnO1xyXG4gICAgICAgICAgICBnbHlwaC50ZXh0Q29udGVudCA9ICfihrMnO1xyXG4gICAgICAgICAgICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0cm9uZycpO1xyXG4gICAgICAgICAgICB0aXRsZS50ZXh0Q29udGVudCA9ICfov5jmsqHmnInoioLngrknO1xyXG4gICAgICAgICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgncCcpO1xyXG4gICAgICAgICAgICBib2R5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDpk77mjqXlkI7vvIzlj6/pgJDlsYLpgInmi6nnlJ/miJDjgIFQTkcg5pW05bGC5oiW5pu05paw44CCJztcclxuICAgICAgICAgICAgZW1wdHkuYXBwZW5kKGdseXBoLCB0aXRsZSwgYm9keSk7XHJcbiAgICAgICAgICAgIHRyZWUuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHN0YXRlLmRvY3VtZW50LnRyZWUuZm9yRWFjaCgobm9kZSkgPT4gYXBwZW5kVHJlZU5vZGUodHJlZSwgbm9kZSwgMCkpO1xyXG4gICAgfSwgcmVzZXRTY3JvbGwpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgbm9kZXMgPSBzdGF0ZS5kb2N1bWVudCA/IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkgOiBbXTtcclxuICAgIGNvbnN0IHNlbGVjdGVkID0gbm9kZXMuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSAhPT0gJ2lnbm9yZScpO1xyXG4gICAgZWxlbWVudCgnI25vZGUtY291bnQnKS50ZXh0Q29udGVudCA9IGAke25vZGVzLmxlbmd0aH0g6IqC54K5YDtcclxuICAgIGVsZW1lbnQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICA/IGAke3NlbGVjdGVkLmxlbmd0aH0gLyAke25vZGVzLmxlbmd0aH0g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYFxyXG4gICAgICAgIDogJ+etieW+heiuvuiuoeaVsOaNric7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKS5kaXNhYmxlZCA9IHN0YXRlLmJ1c3lcclxuICAgICAgICB8fCAhc3RhdGUuZG9jdW1lbnRcclxuICAgICAgICB8fCAhc2VsZWN0ZWQubGVuZ3RoXHJcbiAgICAgICAgfHwgIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwcmV2aWV3KG5vZGU6IFRyZWVOb2RlRHRvKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHN0YXRlLnNlbGVjdGVkSWQgPSBub2RlLmlkO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgZWxlbWVudCgnI3ByZXZpZXctbWV0YScpLnRleHRDb250ZW50ID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvbnN0IHN0YWdlID0gZWxlbWVudCgnI3ByZXZpZXctc3RhZ2UnKTtcclxuICAgIGNvbnN0IGltYWdlID0gZWxlbWVudDxIVE1MSW1hZ2VFbGVtZW50PignI3ByZXZpZXctaW1hZ2UnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2lzLWxvYWRpbmcnKTtcclxuICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2hhcy1pbWFnZScpO1xyXG4gICAgaW1hZ2UucmVtb3ZlQXR0cmlidXRlKCdzcmMnKTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IHVybDogc3RyaW5nIH0+KCdnZXQtcHJldmlldycsIG5vZGUuaWQpO1xyXG4gICAgICAgIGlmIChzdGF0ZS5zZWxlY3RlZElkICE9PSBub2RlLmlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICAgICAgICBpbWFnZS5vbmxvYWQgPSAoKSA9PiByZXNvbHZlKCk7XHJcbiAgICAgICAgICAgIGltYWdlLm9uZXJyb3IgPSAoKSA9PiByZWplY3QobmV3IEVycm9yKCfpooTop4jlm77niYfliqDovb3lpLHotKXjgIInKSk7XHJcbiAgICAgICAgICAgIGltYWdlLnNyYyA9IHJlc3VsdC51cmw7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgc3RhZ2UuY2xhc3NMaXN0LmFkZCgnaGFzLWltYWdlJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpooTop4jlpLHotKXjgIInLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgc3RhZ2UuY2xhc3NMaXN0LnJlbW92ZSgnaXMtbG9hZGluZycpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVByZXNldChuYW1lOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBhbGwgPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgaWYgKG5hbWUgPT09ICdzbWFydCcpIHtcclxuICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMgPSBkZWZhdWx0TmluZVNsaWNlSWRzKHN0YXRlLmRvY3VtZW50LnRyZWUpO1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgY29uc3Qgb3JpZ2luYWwgPSBzdGF0ZS5kZWZhdWx0cy5nZXQobm9kZS5pZCkhO1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBvcmlnaW5hbC5hY3Rpb24pO1xyXG4gICAgICAgICAgICBzdGF0ZS5raW5kcy5zZXQobm9kZS5pZCwgb3JpZ2luYWwua2luZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIGlmIChuYW1lID09PSAnZWRpdGFibGUnKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAncmVuZGVyJyA6ICdnZW5lcmF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG5vZGUuY2hpbGRyZW4ubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/ICdnZW5lcmF0ZSdcclxuICAgICAgICAgICAgICAgIDogJ3JlbmRlcicpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2FjdGl2ZScsIGJ1dHRvbi5kYXRhc2V0LnByZXNldCA9PT0gbmFtZSk7XHJcbiAgICB9KTtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGltcG9ydFRvU2NlbmUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KCfmianlsZXkuLvov5vnqIvku43mmK/ml6fniYjvvIzor7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQgfHwgc3RhdGUuYnVzeSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKCk7XHJcbiAgICBpZiAoIXNldHRpbmdzKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgb3ZlcnJpZGVzOiBJbXBvcnRPdmVycmlkZVtdID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+ICh7XHJcbiAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgYWN0aW9uOiBzdGF0ZS5hY3Rpb25zLmdldChub2RlLmlkKSA/PyBub2RlLmFjdGlvbixcclxuICAgICAgICBraW5kOiBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kLFxyXG4gICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAuLi4oc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICB9KSk7XHJcbiAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2Fzc2V0cycsIHZhbHVlOiAwLCBtZXNzYWdlOiAn5q2j5Zyo5YeG5aSH5a+85YWl4oCmJyB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IHByZWZhYlVybD86IHN0cmluZyB9PignaW1wb3J0LXNlbGVjdGlvbicsIHsgb3ZlcnJpZGVzLCBzZXR0aW5ncyB9KTtcclxuICAgICAgICBzaG93VG9hc3QocmVzdWx0Py5wcmVmYWJVcmxcclxuICAgICAgICAgICAgPyBg5a+85YWl5a6M5oiQ77yM5bey5Yib5bu66aKE5Yi25L2T77yaJHtyZXN1bHQucHJlZmFiVXJsfWBcclxuICAgICAgICAgICAgOiAn5a+85YWl5a6M5oiQ77yM5bey5Zyo5Zy65pmv5Lit6YCJ5Lit5qC56IqC54K544CCJyk7XHJcbiAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2UoZXJyb3IsICflr7zlhaXlpLHotKXjgIInKTtcclxuICAgICAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZXJyb3InLCB2YWx1ZTogMCwgbWVzc2FnZSB9KTtcclxuICAgICAgICBzaG93VG9hc3QobWVzc2FnZSwgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBiaW5kRXZlbnRzKCk6IHZvaWQge1xyXG4gICAgZWxlbWVudCgnI3NhdmUtdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyN0b2tlbi1pbnB1dCcpO1xyXG4gICAgICAgIGlmICghaW5wdXQudmFsdWUudHJpbSgpKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIFRva2Vu44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55Pignc2V0LXRva2VuJywgaW5wdXQudmFsdWUpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9ICcnO1xyXG4gICAgICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHZhdWx0LnBlcnNpc3RlbnQgPyAnVG9rZW4g5bey55Sx57O757uf5Yqg5a+G5L+d5a2Y44CCJyA6ICdUb2tlbiDlt7Lkv53lrZjliLDmnKzmrKHkvJror53jgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn5L+d5a2Y5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3ZlcmlmeS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGhhbmRsZTogc3RyaW5nIH0+KCd2ZXJpZnktdG9rZW4nKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDov57mjqXmiJDlip8gwrcgJHtyZXN1bHQuaGFuZGxlfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfov57mjqXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjY2xlYXItdG9rZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB2YXVsdCA9IGF3YWl0IHJlcXVlc3Q8YW55PignY2xlYXItdG9rZW4nKTtcclxuICAgICAgICBzZXRDb25uZWN0aW9uKHZhdWx0KTtcclxuICAgICAgICBzaG93VG9hc3QoJ+W3sua4hemZpOS/neWtmOeahCBGaWdtYSDlh63mja7jgIInKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtZGV0ZWN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgZGV0ZWN0ZWQgPSBhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcERldGVjdER0bz4oJ3JvdW5kdHJpcC1kZXRlY3QnLCBzb3VyY2UpO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3QgPSBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290Jyk7XHJcbiAgICAgICAgICAgIHNlbGVjdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCByb290IG9mIGRldGVjdGVkLm1hbmFnZWRSb290cykge1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7XHJcbiAgICAgICAgICAgICAgICBvcHRpb24udmFsdWUgPSByb290Lm5vZGVJZDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IHJvb3QuZXJyb3JcclxuICAgICAgICAgICAgICAgICAgICA/IGAke3Jvb3QubmFtZX0gwrcg5Y2P6K6u5o2f5Z2PYFxyXG4gICAgICAgICAgICAgICAgICAgIDogYCR7cm9vdC5uYW1lfSDCtyAke3Jvb3QucHJlZmFiVXVpZCA/PyAn5pyq55+lIFByZWZhYid9YDtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi5kaXNhYmxlZCA9IEJvb2xlYW4ocm9vdC5lcnJvcik7XHJcbiAgICAgICAgICAgICAgICBzZWxlY3QuYXBwZW5kKG9wdGlvbik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2VsZWN0LnZhbHVlID0gZGV0ZWN0ZWQuc2VsZWN0ZWRSb290SWRcclxuICAgICAgICAgICAgICAgID8/IGRldGVjdGVkLm1hbmFnZWRSb290cy5maW5kKChyb290KSA9PiAhcm9vdC5lcnJvcik/Lm5vZGVJZFxyXG4gICAgICAgICAgICAgICAgPz8gJyc7XHJcbiAgICAgICAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IGRldGVjdGVkLm1hbmFnZWRSb290cy5sZW5ndGggPT09IDA7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyBg5qOA5rWL5YiwICR7ZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aH0g5LiqIG1hbmFnZWQgcm9vdCDCtyBGaWdtYSAke2RldGVjdGVkLmZpZ21hVmVyc2lvbn3jgILpgInmi6nnm67moIflkI7nlJ/miJDlj6ror7vpooTop4jjgIJgXHJcbiAgICAgICAgICAgICAgICA6ICfmnKrmo4DmtYvliLAgbWFuYWdlZCByb29044CCJztcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDmo4DmtYvlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1yb290JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcHJldmlldycpLmRpc2FibGVkID1cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcHJldmlldycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IHJvdW5kdHJpcFNvdXJjZSgpO1xyXG4gICAgICAgIGNvbnN0IHJvb3RJZCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKS52YWx1ZTtcclxuICAgICAgICBpZiAoIXNvdXJjZSB8fCAhcm9vdElkKSByZXR1cm47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIHJlbmRlclJvdW5kdHJpcFByZXZpZXcoYXdhaXQgcmVxdWVzdDxSb3VuZHRyaXBQcmV2aWV3RHRvPigncm91bmR0cmlwLXByZXZpZXcnLCBzb3VyY2UsIHJvb3RJZCkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOmihOiniOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXBhaXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFBhaXJUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUGFpclRva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYWlyZWQgPSBhd2FpdCByZXF1ZXN0PHsgZ2VuZXJhdGlvbjogbnVtYmVyOyBiYXNlbGluZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLXBhaXInLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOmFjeWvueWujOaIkCDCtyBMZWRnZXIgZ2VuZXJhdGlvbiAke3BhaXJlZC5nZW5lcmF0aW9ufVxcbkJhc2VsaW5lICR7cGFpcmVkLmJhc2VsaW5lSGFzaH1cXG7or7fph43mlrDnlJ/miJDlj5jmm7TpooTop4jjgIJgO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ1N1cmZhY2Ug5bey6YWN5a+577yb5pyq5L+u5pS5IFByZWZhYuOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIFBhaXIg5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtYXBwbHknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXJvdW5kdHJpcFByZXZpZXdUb2tlbikgcmV0dXJuO1xyXG4gICAgICAgIGNvbnN0IHRva2VuID0gcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcmVxdWVzdDx7IHR4bklkOiBzdHJpbmc7IHByZWZhYlBvc3RpbWFnZUhhc2g6IHN0cmluZyB9Pigncm91bmR0cmlwLWFwcGx5JywgdG9rZW4pO1xyXG4gICAgICAgICAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGDkuovliqHlt7Lmj5DkuqQgwrcgJHtyZWNlaXB0LnR4bklkfVxcblBvc3RpbWFnZSAke3JlY2VpcHQucHJlZmFiUG9zdGltYWdlSGFzaH1cXG7or7fph43mlrDpooTop4jku6Xnoa7orqQgMCBwYXRjaOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnUm91bmQtdHJpcCDlt7Lljp/lrZDlupTnlKjliLDljp8gUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg5bqU55So5aSx6LSl77yM5LqL5Yqh5bey5Zue5rua44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiByZXF1ZXN0KCdyb3VuZHRyaXAtY2FuY2VsJykpO1xyXG5cclxuICAgIGVsZW1lbnQoJyNmZXRjaC1kb2N1bWVudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgICAgIGlmICghc291cmNlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+36L6T5YWlIEZpZ21hIOaWh+S7tuaIluiKgueCuemTvuaOpeOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoeyBwaGFzZTogJ2ZldGNoJywgdmFsdWU6IDAuMDUsIG1lc3NhZ2U6ICfmraPlnKjov57mjqUgRmlnbWHigKYnIH0pO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50ID0gYXdhaXQgcmVxdWVzdDxEb2N1bWVudER0bz4oJ2ZldGNoLWRvY3VtZW50Jywgc291cmNlKTtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGRvY3VtZW50LmZvbnRBc3NldHMgPz8gc3RhdGUuZm9udEFzc2V0cztcclxuICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50KTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6K+75Y+W5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50JykuY2xpY2soKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCByZXNldFJvdW5kdHJpcFRva2Vucyk7XHJcbiAgICBlbGVtZW50KCcjcGljay1hc3NldC1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmc7IGFic29sdXRlUGF0aDogc3RyaW5nIH0gfCBudWxsPihcclxuICAgICAgICAgICAgICAgICdwaWNrLWFzc2V0LWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2Fzc2V0LWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDotYTmupDlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6LWE5rqQ55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjcGljay1wcmVmYWItZm9sZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgY3VycmVudCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stcHJlZmFiLWZvbGRlcicsXHJcbiAgICAgICAgICAgICAgICBjdXJyZW50LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5hYnNvbHV0ZVBhdGg7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg6aKE5Yi25L2T5bCG5YaZ5YWlIGFzc2V0cy8ke3Jlc3VsdC5mb2xkZXJ9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqemihOWItuS9k+ebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IDM7IGluZGV4ICs9IDEpIHtcclxuICAgICAgICBlbGVtZW50KGAjcGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgn6K+35YWI5L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LvvIzlho3pgInmi6nmnKzlnLDotYTmupDnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlO1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgZm9sZGVyOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stbG9jYWwtcmVzb3VyY2UtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICAgICBpbmRleCxcclxuICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oYCNsb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKTtcclxuICAgICAgICAgICAgaW5wdXQudmFsdWUgPSByZXN1bHQuZm9sZGVyO1xyXG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChg5bey5ZCv55So5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6nmnKzlnLDotYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgZWxlbWVudChgI2NsZWFyLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgaW5wdXQudGl0bGUgPSAnJztcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNob3dUb2FzdChg5bey5riF6Zmk5pys5Zyw5ZCM5ZCN6LWE5rqQ55uu5b2VICR7aW5kZXggKyAxfeOAgmApO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGltcG9ydFRvU2NlbmUpO1xyXG4gICAgZWxlbWVudCgnI2NhbmNlbC1pbXBvcnQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ2NhbmNlbC1pbXBvcnQnKSk7XHJcblxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3RyZWUtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBzdGF0ZS5zZWFyY2ggPSAoZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgY29sbGFwc2VJZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtY29sbGFwc2VdJyk/LmRhdGFzZXQuY29sbGFwc2U7XHJcbiAgICAgICAgaWYgKGNvbGxhcHNlSWQpIHtcclxuICAgICAgICAgICAgaWYgKHN0YXRlLmNvbGxhcHNlZC5oYXMoY29sbGFwc2VJZCkpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5kZWxldGUoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5jb2xsYXBzZWQuYWRkKGNvbGxhcHNlSWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodGFyZ2V0LmNsb3Nlc3QoJ3NlbGVjdCwgbGFiZWwsIGlucHV0LCB0ZXh0YXJlYScpKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tkYXRhLW5vZGUtaWRdJyk/LmRhdGFzZXQubm9kZUlkO1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBpZCA/IGZpbmROb2RlKGlkKSA6IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICB2b2lkIHByZXZpZXcobm9kZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50O1xyXG4gICAgICAgIGlmICh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5uYW1lRm9yKTtcclxuICAgICAgICAgICAgaWYgKCFub2RlKSByZXR1cm47XHJcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbU5hbWUgPSBzYW5pdGl6ZU5vZGVOYW1lKHRhcmdldC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlmICghY3VzdG9tTmFtZSkge1xyXG4gICAgICAgICAgICAgICAgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+iKgueCueWQjeS4jeiDveS4uuepuuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLm5hbWVzLnNldChub2RlLmlkLCBjdXN0b21OYW1lKTtcclxuICAgICAgICAgICAgaWYgKGN1c3RvbU5hbWUgPT09IG5vZGUubmFtZSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucmVuYW1lZElkcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKVxyXG4gICAgICAgICAgICAgICAgPyBg6IqC54K55bCG5Lul4oCcJHtjdXN0b21OYW1lfeKAneWvvOWFpeOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+W3suaBouWkjSBGaWdtYSDljp/oioLngrnlkI3jgIInKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmFjdGlvbkZvcikge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKTtcclxuICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGFjdGlvbiA9IHRhcmdldC52YWx1ZSBhcyBJbXBvcnRBY3Rpb247XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uICE9PSAncmVuZGVyJykge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgc2V0QWN0aW9uKG5vZGUsIGFjdGlvbik7XHJcbiAgICAgICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgICAgICBpZiAoYWN0aW9uID09PSAncmVuZGVyJyAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNob3dUb2FzdChg4oCcJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX3igJ3lsIbkvZzkuLrmlbTlsYLlr7zlhaXvvIwke2Rlc2NlbmRhbnRzKG5vZGUpLmxlbmd0aH0g5Liq5a2Q6IqC54K55LiN5Lya5Y2V54us55Sf5oiQ44CCYCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgICAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5raW5kRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldCh0YXJnZXQuZGF0YXNldC5raW5kRm9yLCB0YXJnZXQudmFsdWUgYXMgTm9kZUtpbmQpO1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQua2luZEZvcik7XHJcbiAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAuZm9yRWFjaCgoYnV0dG9uKSA9PiBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJykpO1xyXG4gICAgICAgICAgICByZW5kZXJUcmVlKCk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmICh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcikge1xyXG4gICAgICAgICAgICBzdGF0ZS5leHBsaWNpdElkcy5hZGQodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICBpZiAoKHRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50KS5jaGVja2VkKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgaWYgKG5vZGUpIHtcclxuICAgICAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgJ3JlbmRlcicpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUodGFyZ2V0LmRhdGFzZXQucGF0Y2hGb3IpO1xyXG4gICAgICAgICAgICAgICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyN0cmVlJykuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50O1xyXG4gICAgICAgIGNvbnN0IGlkID0gdGFyZ2V0LmRhdGFzZXQubmFtZUZvcjtcclxuICAgICAgICBpZiAoIWlkKSByZXR1cm47XHJcbiAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xyXG4gICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgICAgICB0YXJnZXQuYmx1cigpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoZXZlbnQua2V5ID09PSAnRXNjYXBlJykge1xyXG4gICAgICAgICAgICBjb25zdCBub2RlID0gZmluZE5vZGUoaWQpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkgdGFyZ2V0LnZhbHVlID0gZWZmZWN0aXZlTm9kZU5hbWUobm9kZSk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gYXBwbHlQcmVzZXQoYnV0dG9uLmRhdGFzZXQucHJlc2V0ID8/ICdzbWFydCcpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50PihcclxuICAgICAgICAnI3NjYWxlLCAjYXNzZXQtZm9sZGVyLCAjcHJlZmFiLWZvbGRlciwgI2xvY2FsLXJlc291cmNlLWZvbGRlciwgI3VwZGF0ZS1leGlzdGluZywgI3JlZnJlc2gtYXNzZXRzLCAjYXV0by1zYXZlJyxcclxuICAgICkuZm9yRWFjaCgoY29udHJvbCkgPT4ge1xyXG4gICAgICAgIGNvbnRyb2wuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjZm9udC1tYXAtbGlzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnNldHRpbmdzID0gc2V0dGluZ3M7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbn1cclxuXHJcbm1vZHVsZS5leHBvcnRzID0gRWRpdG9yLlBhbmVsLmRlZmluZSh7XHJcbiAgICBsaXN0ZW5lcnM6IHtcclxuICAgICAgICBzaG93KCkge30sXHJcbiAgICAgICAgaGlkZSgpIHt9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGY4JyksXHJcbiAgICBzdHlsZTogcmVhZEZpbGVTeW5jKGpvaW4oX19kaXJuYW1lLCAnLi4vLi4vLi4vc3RhdGljL3N0eWxlL2RlZmF1bHQvaW5kZXguY3NzJyksICd1dGY4JyksXHJcbiAgICAkOiB7XHJcbiAgICAgICAgYXBwOiAnI2FwcCcsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge1xyXG4gICAgICAgIG9uUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpIHtcclxuICAgICAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcmVhZHkoKSB7XHJcbiAgICAgICAgcGFuZWxIb3N0ID0gdGhpcztcclxuICAgICAgICBiaW5kRXZlbnRzKCk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgaW5pdGlhbCA9IGF3YWl0IHJlcXVlc3Q8e1xyXG4gICAgICAgICAgICAgICAgdmVyc2lvbj86IHN0cmluZztcclxuICAgICAgICAgICAgICAgIHZhdWx0OiBhbnk7XHJcbiAgICAgICAgICAgICAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICAgICAgICAgICAgICBkb2N1bWVudDogRG9jdW1lbnREdG8gfCBudWxsO1xyXG4gICAgICAgICAgICAgICAgZm9udEFzc2V0cz86IEZvbnRBc3NldE9wdGlvbltdO1xyXG4gICAgICAgICAgICB9PignZ2V0LXN0YXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlID0gaW5pdGlhbC52ZXJzaW9uID09PSBwYWNrYWdlSlNPTi52ZXJzaW9uO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gaW5pdGlhbC5mb250QXNzZXRzID8/IFtdO1xyXG4gICAgICAgICAgICBzZXRDb25uZWN0aW9uKGluaXRpYWwudmF1bHQpO1xyXG4gICAgICAgICAgICBhcHBseVNldHRpbmdzKGluaXRpYWwuc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICBpZiAoaW5pdGlhbC5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICAgICAgaW5pdGlhbGl6ZURvY3VtZW50KGluaXRpYWwuZG9jdW1lbnQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgICAgIHVwZGF0ZVN1bW1hcnkoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpO1xyXG4gICAgICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5hZGQoJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1sYWJlbCcpLnRleHRDb250ZW50ID0gJ+ivt+mHjeWQryBDb2Nvcyc7XHJcbiAgICAgICAgICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAn4oa7JztcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn5qOA5rWL5Yiw5pen54mI5Li76L+b56iL5LuN5Zyo6L+Q6KGM77ya6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfliJ3lp4vljJblpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG4gICAgYmVmb3JlQ2xvc2UoKSB7fSxcclxuICAgIGNsb3NlKCkge1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19