"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const package_json_1 = __importDefault(require("../../../package.json"));
const import_review_1 = require("./import-review");
const fonts_1 = require("../../importer/fonts");
const import_actions_1 = require("../../import-actions");
const node_name_1 = require("../../node-name");
const model_1 = require("./model");
let panelHost = null;
let importReviewPanel = null;
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
    var _a;
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
        const fallbackNote = ((_a = result === null || result === void 0 ? void 0 : result.warnings) === null || _a === void 0 ? void 0 : _a.length)
            ? `；${result.warnings.length} 条导入/收尾提示（详见结果检查）`
            : '';
        showToast((result === null || result === void 0 ? void 0 : result.prefabUrl)
            ? `导入完成，已创建预制体：${result.prefabUrl}${fallbackNote}`
            : `导入完成，已在场景中选中根节点${fallbackNote}。`);
        if (result.review)
            importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(result.review);
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
    element('#open-import-review').addEventListener('click', async () => {
        if (state.busy)
            return;
        try {
            const review = await request('get-import-review');
            if (review)
                importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
            else
                showToast('本次插件会话尚无导入检查结果，请先完成一次导入。');
        }
        catch (error) {
            showToast(errorMessage(error, '读取检查结果失败。'), true);
        }
    });
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
        onImportReviewReady(review) {
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
                if (review && !review.confirmed)
                    importReviewPanel === null || importReviewPanel === void 0 ? void 0 : importReviewPanel.open(review);
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
        panelHost = null;
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFFcEQsZ0RBQTJFO0FBQzNFLHlEQUE2RDtBQUM3RCwrQ0FBbUQ7QUFDbkQsbUNBVWlCO0FBbUVqQixJQUFJLFNBQVMsR0FBUSxJQUFJLENBQUM7QUFDMUIsSUFBSSxpQkFBaUIsR0FBNkIsSUFBSSxDQUFDO0FBQ3ZELElBQUksVUFBVSxHQUF5QyxJQUFJLENBQUM7QUFDNUQsSUFBSSxzQkFBc0IsR0FBeUMsSUFBSSxDQUFDO0FBQ3hFLElBQUksb0JBQW9CLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUM1RCxJQUFJLHFCQUF5QyxDQUFDO0FBQzlDLElBQUksa0JBQXNDLENBQUM7QUFFM0MsTUFBTSxLQUFLLEdBQWU7SUFDdEIsUUFBUSxFQUFFLElBQUk7SUFDZCxRQUFRLEVBQUU7UUFDTixTQUFTLEVBQUUsRUFBRTtRQUNiLFdBQVcsRUFBRSxnQkFBZ0I7UUFDN0IsWUFBWSxFQUFFLHdCQUF3QjtRQUN0QyxvQkFBb0IsRUFBRSxFQUFFO1FBQ3hCLG1CQUFtQixFQUFFLEVBQUU7UUFDdkIsS0FBSyxFQUFFLENBQUM7UUFDUixjQUFjLEVBQUUsSUFBSTtRQUNwQixhQUFhLEVBQUUsS0FBSztRQUNwQixRQUFRLEVBQUUsS0FBSztRQUNmLE9BQU8sRUFBRSxFQUFFO0tBQ2Q7SUFDRCxnQkFBZ0IsRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUMzQixPQUFPLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDbEIsS0FBSyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ2hCLE9BQU8sRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNsQixXQUFXLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDdEIsS0FB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LE9BQU8sQ0FBc0IsbUJBQW1CLENBQUMsQ0FBQztnQkFDdkUsSUFBSSxNQUFNLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUztvQkFBRSxpQkFBaUIsYUFBakIsaUJBQWlCLHVCQUFqQixpQkFBaUIsQ0FBRSxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7WUFDckUsQ0FBQztRQUNMLENBQUM7UUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1lBQ2IsU0FBUyxDQUFDLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUN2RSxDQUFDO0lBQ0wsQ0FBQztJQUNELFdBQVcsS0FBSSxDQUFDO0lBQ2hCLEtBQUs7UUFDRCxpQkFBaUIsYUFBakIsaUJBQWlCLHVCQUFqQixpQkFBaUIsQ0FBRSxPQUFPLEVBQUUsQ0FBQztRQUM3QixpQkFBaUIsR0FBRyxJQUFJLENBQUM7UUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNyQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi8uLi8uLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdQYW5lbCB9IGZyb20gJy4vaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi4vLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGZpbmRGb250QXNzZXQsIHR5cGUgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuLi8uLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuLi8uLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IGltcG9ydFJldmlld1BhbmVsOiBJbXBvcnRSZXZpZXdQYW5lbCB8IG51bGwgPSBudWxsO1xyXG5sZXQgdG9hc3RUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxubGV0IGltcG9ydEJ1dHRvblJlc2V0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBub2RlT3ZlcnJpZGVTYXZlVGFzazogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgcm91bmR0cmlwUHJldmlld1Rva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbmxldCByb3VuZHRyaXBQYWlyVG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuXHJcbmNvbnN0IHN0YXRlOiBQYW5lbFN0YXRlID0ge1xyXG4gICAgZG9jdW1lbnQ6IG51bGwsXHJcbiAgICBzZXR0aW5nczoge1xyXG4gICAgICAgIHNvdXJjZVVybDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6ICdmaWdtYS1pbXBvcnRlcicsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXIvcHJlZmFicycsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IFtdLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6ICcnLFxyXG4gICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGZhbHNlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBmYWxzZSxcclxuICAgICAgICBmb250TWFwOiB7fSxcclxuICAgIH0sXHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBhY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgcGF0Y2hlczogbmV3IFNldCgpLFxyXG4gICAgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSxcclxuICAgIG5hbWVzOiBuZXcgTWFwKCksXHJcbiAgICByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICBkZWZhdWx0czogbmV3IE1hcCgpLFxyXG4gICAgY29sbGFwc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzdXBwcmVzc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzZWFyY2g6ICcnLFxyXG4gICAgYnVzeTogZmFsc2UsXHJcbiAgICBydW50aW1lQ29tcGF0aWJsZTogdHJ1ZSxcclxuICAgIGZvbnRBc3NldHM6IFtdLFxyXG59O1xyXG5cclxuZnVuY3Rpb24gcm9vdCgpOiBIVE1MRWxlbWVudCB7XHJcbiAgICByZXR1cm4gcGFuZWxIb3N0LiQuYXBwIGFzIEhUTUxFbGVtZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbGVtZW50PFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oc2VsZWN0b3I6IHN0cmluZyk6IFQge1xyXG4gICAgY29uc3QgdmFsdWUgPSByb290KCkucXVlcnlTZWxlY3RvcjxUPihzZWxlY3Rvcik7XHJcbiAgICBpZiAoIXZhbHVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQYW5lbCBlbGVtZW50IG5vdCBmb3VuZDogJHtzZWxlY3Rvcn1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVxdWVzdDxUPihtZXNzYWdlOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8VD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QocGFja2FnZUpTT04ubmFtZSwgbWVzc2FnZSwgLi4uYXJncykgYXMgVDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2hvd1RvYXN0KG1lc3NhZ2U6IHN0cmluZywgZXJyb3IgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdG9hc3QgPSBlbGVtZW50PEhUTUxEaXZFbGVtZW50PignI3RvYXN0Jyk7XHJcbiAgICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcclxuICAgIGlmICh0b2FzdFRpbWVyKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRvYXN0VGltZXIpO1xyXG4gICAgfVxyXG4gICAgdG9hc3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3QuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpLCAzNDAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duLCBmYWxsYmFjazogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIGVycm9yLm1lc3NhZ2UpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3IubWVzc2FnZTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnICYmIGVycm9yLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvcjtcclxuICAgIH1cclxuICAgIGlmIChlcnJvciAmJiB0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnICYmICdtZXNzYWdlJyBpbiBlcnJvclxyXG4gICAgICAgICYmIHR5cGVvZiAoZXJyb3IgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9KS5tZXNzYWdlID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIHJldHVybiAoZXJyb3IgYXMgeyBtZXNzYWdlOiBzdHJpbmcgfSkubWVzc2FnZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxsYmFjaztcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0Q29ubmVjdGlvbih2YXVsdDoge1xyXG4gICAgaGFzVG9rZW46IGJvb2xlYW47XHJcbiAgICBwZXJzaXN0ZW50OiBib29sZWFuO1xyXG4gICAgYmFja2VuZDogc3RyaW5nO1xyXG4gICAgd2FybmluZz86IHN0cmluZztcclxufSk6IHZvaWQge1xyXG4gICAgY29uc3QgcGlsbCA9IGVsZW1lbnQoJyNjb25uZWN0aW9uLXBpbGwnKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb25saW5lJywgdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vZmZsaW5lJywgIXZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIGVsZW1lbnQoJyNjb25uZWN0aW9uLWxhYmVsJykudGV4dENvbnRlbnQgPSB2YXVsdC5oYXNUb2tlbiA/ICflh63mja7lsLHnu6onIDogJ+acqui/nuaOpSc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtYmFkZ2UnKS50ZXh0Q29udGVudCA9IHZhdWx0LnBlcnNpc3RlbnQgPyAn57O757uf5Yqg5a+GJyA6ICfkvJror53lrZjlgqgnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHZhdWx0Lndhcm5pbmdcclxuICAgICAgICA/PyAodmF1bHQucGVyc2lzdGVudCA/IGDnlLEgJHt2YXVsdC5iYWNrZW5kfSDliqDlr4bvvIzpobnnm67kuK3ku4Xkv53lrZjpnZ7mlY/mhJ/orr7nva5gIDogJ1Rva2VuIOS4jeWGmeWFpemhueebruaWh+S7ticpO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjdmVyaWZ5LXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjY2xlYXItdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW4obm9kZXM6IFRyZWVOb2RlRHRvW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2Rlcy5mbGF0TWFwKChub2RlKSA9PiBbbm9kZSwgLi4uZmxhdHRlbihub2RlLmNoaWxkcmVuKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kTm9kZShpZDogc3RyaW5nLCBub2RlcyA9IHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdKTogVHJlZU5vZGVEdG8gfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuaWQgPT09IGlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZCA9IGZpbmROb2RlKGlkLCBub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICBpZiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckZvbnRNYXAoKTogdm9pZCB7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBmYW1pbGllcyA9IHN0YXRlLmRvY3VtZW50Py5mb250cyA/PyBbXTtcclxuICAgIGlmICghZmFtaWxpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDlkI7vvIzov5nph4zkvJrliJflh7rmo4DmtYvliLDnmoTlrZfkvZPjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZm9udEFzc2V0cy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSBpcy13YXJuaW5nJztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfpobnnm64gYXNzZXRzIOWGheayoeacieajgOa1i+WIsCAudHRmIC8gLm90ZiAvIC5mbnQgLyAud29mZiDlrZfkvZPotYTmupDjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBmYW1pbHkgb2YgZmFtaWxpZXMpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICByb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXJvdyc7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIHNvdXJjZS5jbGFzc05hbWUgPSAnZm9udC1tYXAtc291cmNlJztcclxuICAgICAgICBzb3VyY2UudGV4dENvbnRlbnQgPSBmYW1pbHk7XHJcbiAgICAgICAgc291cmNlLnRpdGxlID0gZmFtaWx5O1xyXG4gICAgICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIGFycm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1hcnJvdyc7XHJcbiAgICAgICAgYXJyb3cudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgICAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgICAgICBzZWxlY3QuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNlbGVjdCc7XHJcbiAgICAgICAgc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseSA9IGZhbWlseTtcclxuICAgICAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7ZmFtaWx5fSDmmKDlsITlrZfkvZNgKTtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKCcnLCAn5LiN5pig5bCE77yI5L2/55So6buY6K6k5a2X5L2T77yJJykpO1xyXG4gICAgICAgIGNvbnN0IGF1dG9tYXRpYyA9IGZpbmRGb250QXNzZXQoZmFtaWx5LCBzdGF0ZS5mb250QXNzZXRzKTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHN0YXRlLnNldHRpbmdzLmZvbnRNYXBbZmFtaWx5XSA/PyBhdXRvbWF0aWM/LnVybCA/PyAnJztcclxuICAgICAgICBmb3IgKGNvbnN0IGFzc2V0IG9mIHN0YXRlLmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IG9wdGlvbihhc3NldC51cmwsIGAke2Fzc2V0Lm5hbWV9IMK3ICR7YXNzZXQucmVsYXRpdmVQYXRofWApO1xyXG4gICAgICAgICAgICBpdGVtLnNlbGVjdGVkID0gYXNzZXQudXJsID09PSBzZWxlY3RlZDtcclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGl0ZW0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZWxlY3QudmFsdWUgPSBzZWxlY3RlZDtcclxuICAgICAgICByb3cuYXBwZW5kKHNvdXJjZSwgYXJyb3csIHNlbGVjdCk7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlQWN0aW9uKF9ub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiB1bmtub3duKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIHJldHVybiBub3JtYWxpemVJbXBvcnRBY3Rpb24oYWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50OiBEb2N1bWVudER0byk6IHZvaWQge1xyXG4gICAgc3RhdGUuZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmtpbmRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgc3RhdGUubmFtZXMuY2xlYXIoKTtcclxuICAgIHN0YXRlLnJlbmFtZWRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmRlZmF1bHRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5jb2xsYXBzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnN1cHByZXNzZWQuY2xlYXIoKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7XHJcbiAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgc3RhdGUuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7XHJcbiAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKTtcclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAoY3VzdG9tTmFtZSAmJiBjdXN0b21OYW1lICE9PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0ID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG92ZXJyaWRlLm5pbmVTbGljZSAmJiBub2RlLnBhdGNoQ2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZShcclxuICAgICAgICAgICAgJ2FjdGl2ZScsXHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLnNpemUgPT09IDAgJiYgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAnc21hcnQnLFxyXG4gICAgICAgICk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmaWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IGRvY3VtZW50LnNvdXJjZVVybDtcclxuICAgIGVsZW1lbnQoJyNmb250LWhpbnQnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZvbnRzLmxlbmd0aFxyXG4gICAgICAgID8gYOajgOa1i+WIsO+8miR7ZG9jdW1lbnQuZm9udHMuam9pbign44CBJyl9YFxyXG4gICAgICAgIDogJ+W9k+WJjeaWh+S7tuWwmuacquWPkeeOsOWtl+S9k+OAgic7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICByZW5kZXJUcmVlKHRydWUpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IHZvaWQge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIHVwZGF0ZVRhcmdldEhpbnQoKTtcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVhZFNldHRpbmdzKHNob3dFcnJvciA9IHRydWUpOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwge1xyXG4gICAgY29uc3QgZm9udE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uc3RhdGUuc2V0dGluZ3MuZm9udE1hcCB9O1xyXG4gICAgaWYgKHN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBmYW1pbHkgb2Ygc3RhdGUuZG9jdW1lbnQuZm9udHMpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGZvbnRNYXBbZmFtaWx5XTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoZmFtaWx5ICYmIHNlbGVjdC52YWx1ZSkge1xyXG4gICAgICAgICAgICBmb250TWFwW2ZhbWlseV0gPSBzZWxlY3QudmFsdWU7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzY2FsZSA9IE51bWJlcihlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPCAwLjI1IHx8IHNjYWxlID4gNCkge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCflr7zlhaXlgI3njoflv4XpobvlnKggMC4yNSDliLAgNCDkuYvpl7TjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhc3NldEZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWFzc2V0Rm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemhueebriBhc3NldHMg5LiL55qE6LWE5rqQ6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJlZmFiRm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXByZWZhYkZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npooTliLbkvZPovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzIH0sIChfLCBpbmRleCkgPT5cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICApLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNsb2NhbC1yZXNvdXJjZS1mb2xkZXItMCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCxcclxuICAgICAgICBhdXRvU2F2ZTogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEJ1c3kodmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNzYXZlLXRva2VuJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1hc3NldC1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLXByZWZhYi1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtZGV0ZWN0JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXByZXZpZXcnKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaGlkZGVuJywgIXZhbHVlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvdW5kdHJpcFNvdXJjZSgpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSDmlofku7bmiJboioLngrnpk77mjqXjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBzb3VyY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclJvdW5kdHJpcFByZXZpZXcocHJldmlldzogUm91bmR0cmlwUHJldmlld0R0byk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gcHJldmlldy5wcmV2aWV3VG9rZW47XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSBwcmV2aWV3LnBhaXJUb2tlbjtcclxuICAgIGNvbnN0IGxpbmVzID0gW1xyXG4gICAgICAgIGDnm67moIfvvJoke3ByZXZpZXcuYXNzZXRVcmx9YCxcclxuICAgICAgICBgUHJlZmFi77yaJHtwcmV2aWV3LnByZWZhYlV1aWR9YCxcclxuICAgICAgICBgU3VyZmFjZe+8miR7cHJldmlldy5zdXJmYWNlSWR9IMK3IEZpZ21hICR7cHJldmlldy5maWdtYVZlcnNpb259IMK3IExlZGdlciAke3ByZXZpZXcubGVkZ2VyR2VuZXJhdGlvbn1gLFxyXG4gICAgICAgIGDlsIbkv67mlLkgJHtwcmV2aWV3LnBsYW4uYXBwbHkubGVuZ3RofSDpobkgwrcg5L+d55WZIENvY29zICR7cHJldmlldy5wbGFuLnByZXNlcnZlQ29jb3MubGVuZ3RofSDpobkgwrcg5bey5pS25pWbICR7cHJldmlldy5wbGFuLmNvbnZlcmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgYOWGsueqgSAke3ByZXZpZXcucGxhbi5jb25mbGljdHMubGVuZ3RofSDpobkgwrcg5LiN5pSv5oyBICR7cHJldmlldy5wbGFuLnVuc3VwcG9ydGVkLmxlbmd0aH0g6aG5IMK3IOWPquivu+acquaUuSAke3ByZXZpZXcucGxhbi5yZWFkb25seVVuY2hhbmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgcHJldmlldy5wYWlyUmVxdWlyZWRcclxuICAgICAgICAgICAgPyBwcmV2aWV3LnBhaXJFbGlnaWJsZSA/ICfpppbmrKHkvb/nlKjvvJror4Hmja7kuIDoh7TvvIzor7flhYjnoa7orqTphY3lr7kgU3VyZmFjZe+8iOWPquWGmSBsZWRnZXLvvIzkuI3mlLkgUHJlZmFi77yJ44CCJyA6ICfpppbmrKHkvb/nlKjvvJpQYWlyIOivgeaNruS4jeS4gOiHtO+8jOmcgOS7juW9k+WJjSBQcmVmYWIg6YeN5paw5a+85Ye644CCJ1xyXG4gICAgICAgICAgICA6IHByZXZpZXcuYmxvY2tlcnMubGVuZ3RoID8gYOmYu+aWre+8miR7cHJldmlldy5ibG9ja2Vycy5qb2luKCcsICcpfWAgOiAn6aKE6KeI6YCa6L+H77yM5Y+v5Y6f5a2Q5bqU55So5pW05Liq5LiN5Y+v5Y+Y6K6h5YiS44CCJyxcclxuICAgIF07XHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVUYXJnZXRIaW50KCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOmcgOimgeWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9yJztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlvZPliY3lnLrmma8gQ2FudmFzIOagueiKgueCueS4i++8m0ZyYW1lIOmTvuaOpeWwhuiHquWKqOWIm+W7uuW5tuaJk+W8gOmihOWItuS9kyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0SW1wb3J0QnV0dG9uKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgIGJ1dHRvbi50aXRsZSA9ICflr7zlhaXliLDlvZPliY3miZPlvIDlnLrmma/miJbpooTliLbkvZMnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlnLrmma8nO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMCUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbXBvcnRQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuMDUgKyB2YWx1ZSAqIDAuNTU7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdzY2VuZScpIHtcclxuICAgICAgICByZXR1cm4gMC42ICsgdmFsdWUgKiAwLjM4O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGV2ZW50LnBoYXNlID09PSAnZG9uZScgPyAxIDogMDtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHJlZ2lvbiA9IGVsZW1lbnQoJyNwcm9ncmVzcy1yZWdpb24nKTtcclxuICAgIGNvbnN0IGJ1c3kgPSBbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKTtcclxuICAgIHJlZ2lvbi5jbGFzc0xpc3QudG9nZ2xlKCdpcy1idXN5JywgYnVzeSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtZXJyb3InLCBldmVudC5waGFzZSA9PT0gJ2Vycm9yJyk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZCh2YWx1ZSAqIDEwMCl9JWA7XHJcbiAgICAoZWxlbWVudCgnI3Byb2dyZXNzLWJhcicpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3ZhbHVlICogMTAwfSVgO1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBjb25zdCBpbXBvcnRpbmcgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgfHwgZXZlbnQucGhhc2UgPT09ICdzY2VuZSc7XHJcbiAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gbnVsbDtcclxuICAgIH1cclxuICAgIGlmIChpbXBvcnRpbmcpIHtcclxuICAgICAgICBjb25zdCBwcm9ncmVzcyA9IGltcG9ydFByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtcnVubmluZycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZSgnYXJpYS1idXN5JywgJ3RydWUnKTtcclxuICAgICAgICBidXR0b24udGl0bGUgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgPyAn5YeG5aSH6LWE5rqQJyA6ICfmnoTlu7roioLngrknO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApfSVgO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3Byb2dyZXNzICogMTAwfSVgO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2RvbmUnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5a+85YWl5a6M5oiQJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAnMTAwJSc7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzEwMCUnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxNDAwKTtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicgfHwgZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcgPyAn5bey5Y+W5raIJyA6ICflr7zlhaXlpLHotKUnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfph43or5UnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxODAwKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2RvbmUnLCAnZXJyb3InLCAnY2FuY2VsbGVkJywgJ2lkbGUnXS5pbmNsdWRlcyhldmVudC5waGFzZSkpIHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLFxyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMsXHJcbiAgICApO1xyXG4gICAgc3RhdGUuYWN0aW9ucyA9IGVmZmVjdGl2ZS5hY3Rpb25zO1xyXG4gICAgc3RhdGUuc3VwcHJlc3NlZCA9IGVmZmVjdGl2ZS5zdXBwcmVzc2VkO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXRBY3Rpb24obm9kZTogVHJlZU5vZGVEdG8sIGFjdGlvbjogSW1wb3J0QWN0aW9uKTogdm9pZCB7XHJcbiAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBzYWZlQWN0aW9uKG5vZGUsIGFjdGlvbikpO1xyXG4gICAgcmVjb25jaWxlQWN0aW9ucygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlZmZlY3RpdmVOb2RlTmFtZShub2RlOiBUcmVlTm9kZUR0byk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gc3RhdGUubmFtZXMuZ2V0KG5vZGUuaWQpID8/IG5vZGUubmFtZTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXhwbGljaXRPdmVycmlkZXMoKTogSW1wb3J0T3ZlcnJpZGVbXSB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSlcclxuICAgICAgICAuZmlsdGVyKChub2RlKSA9PiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkgfHwgc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCkpXHJcbiAgICAgICAgLm1hcCgobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCByZW5hbWVkID0gc3RhdGUucmVuYW1lZElkcy5oYXMobm9kZS5pZCk7XHJcbiAgICAgICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICAgICAgICAgIGFjdGlvbjogc3RhdGUucHJlZmVycmVkQWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpLFxyXG4gICAgICAgICAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICAgICAgICAgIG5pbmVTbGljZTogc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgICAgICAgICBleHBsaWNpdDogc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgLi4uKHJlbmFtZWQgPyB7IG5hbWU6IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpIH0gOiB7fSksXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGVLZXkgPSBzdGF0ZS5kb2N1bWVudC5maWxlS2V5O1xyXG4gICAgY29uc3Qgb3ZlcnJpZGVzID0gZXhwbGljaXRPdmVycmlkZXMoKTtcclxuICAgIGNvbnN0IHNjb3BlSWRzID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKS5tYXAoKG5vZGUpID0+IG5vZGUuaWQpO1xyXG4gICAgLy8gU2VyaWFsaXplIHdyaXRlcyBzbyBhIHNsb3dlciBlYXJsaWVyIHJlcXVlc3QgY2FuIG5ldmVyIG92ZXJ3cml0ZSBhIG5ld2VyXHJcbiAgICAvLyBzdHJhdGVneSBzbmFwc2hvdCBhZnRlciByYXBpZCBzZWxlY3QgY2hhbmdlcy5cclxuICAgIG5vZGVPdmVycmlkZVNhdmVUYXNrID0gbm9kZU92ZXJyaWRlU2F2ZVRhc2tcclxuICAgICAgICAuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKVxyXG4gICAgICAgIC50aGVuKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdDxJbXBvcnRPdmVycmlkZVtdPignc2F2ZS1ub2RlLW92ZXJyaWRlcycsIGZpbGVLZXksIG92ZXJyaWRlcywgc2NvcGVJZHMpO1xyXG4gICAgICAgIH0pXHJcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAn6IqC54K5562W55Wl5L+d5a2Y5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYXRjaGVzKG5vZGU6IFRyZWVOb2RlRHRvKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIXN0YXRlLnNlYXJjaCkge1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaGF5c3RhY2sgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gJHtub2RlLm5hbWV9ICR7bm9kZS50eXBlfSAke25vZGUuaWR9YC50b0xvd2VyQ2FzZSgpO1xyXG4gICAgaWYgKGhheXN0YWNrLmluY2x1ZGVzKHN0YXRlLnNlYXJjaCkpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLnNvbWUobWF0Y2hlcyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9wdGlvbih2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nKTogSFRNTE9wdGlvbkVsZW1lbnQge1xyXG4gICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpO1xyXG4gICAgaXRlbS52YWx1ZSA9IHZhbHVlO1xyXG4gICAgaXRlbS50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgcmV0dXJuIGl0ZW07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG1ha2VTZWxlY3QoXHJcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcclxuICAgIHZhbHVlOiBzdHJpbmcsXHJcbiAgICBpdGVtczogQXJyYXk8W3N0cmluZywgc3RyaW5nXT4sXHJcbiAgICBsYWJlbDogc3RyaW5nLFxyXG4pOiBIVE1MU2VsZWN0RWxlbWVudCB7XHJcbiAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgIHNlbGVjdC5jbGFzc05hbWUgPSBjbGFzc05hbWU7XHJcbiAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgbGFiZWwpO1xyXG4gICAgZm9yIChjb25zdCBba2V5LCB0ZXh0XSBvZiBpdGVtcykge1xyXG4gICAgICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24oa2V5LCB0ZXh0KSk7XHJcbiAgICB9XHJcbiAgICBzZWxlY3QudmFsdWUgPSB2YWx1ZTtcclxuICAgIHJldHVybiBzZWxlY3Q7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGVuZFRyZWVOb2RlKGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIG5vZGU6IFRyZWVOb2RlRHRvLCBkZXB0aDogbnVtYmVyKTogdm9pZCB7XHJcbiAgICBpZiAoIW1hdGNoZXMobm9kZSkpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIHJvdy5jbGFzc05hbWUgPSBgdHJlZS1yb3cke3N0YXRlLnNlbGVjdGVkSWQgPT09IG5vZGUuaWQgPyAnIGlzLXNlbGVjdGVkJyA6ICcnfWA7XHJcbiAgICByb3cuZGF0YXNldC5ub2RlSWQgPSBub2RlLmlkO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgncm9sZScsICd0cmVlaXRlbScpO1xyXG4gICAgcm93LnNldEF0dHJpYnV0ZSgnYXJpYS1sZXZlbCcsIFN0cmluZyhkZXB0aCArIDEpKTtcclxuXHJcbiAgICBjb25zdCBtYWluID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBtYWluLmNsYXNzTmFtZSA9ICdub2RlLW1haW4nO1xyXG4gICAgbWFpbi5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1kZXB0aCcsIFN0cmluZyhkZXB0aCkpO1xyXG4gICAgY29uc3QgY29sbGFwc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtcclxuICAgIGNvbGxhcHNlLmNsYXNzTmFtZSA9IGBjb2xsYXBzZSR7bm9kZS5jaGlsZHJlbi5sZW5ndGggPyAnJyA6ICcgaXMtbGVhZid9YDtcclxuICAgIGNvbGxhcHNlLnR5cGUgPSAnYnV0dG9uJztcclxuICAgIGNvbGxhcHNlLmRhdGFzZXQuY29sbGFwc2UgPSBub2RlLmlkO1xyXG4gICAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+KAuicgOiAn4oyEJztcclxuICAgIGNvbGxhcHNlLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIHN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgPyAn5bGV5byAJyA6ICfmipjlj6AnKTtcclxuICAgIGNvbnN0IGRvdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIGRvdC5jbGFzc05hbWUgPSBgdHlwZS1kb3QgJHtcclxuICAgICAgICBub2RlLnR5cGUgPT09ICdURVhUJyA/ICd0ZXh0J1xyXG4gICAgICAgICAgICA6IGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICd2ZWN0b3InXHJcbiAgICAgICAgICAgICAgICA6IG5vZGUudHlwZS5pbmNsdWRlcygnQ09NUE9ORU5UJykgfHwgbm9kZS50eXBlID09PSAnSU5TVEFOQ0UnID8gJ2NvbXBvbmVudCdcclxuICAgICAgICAgICAgICAgICAgICA6ICcnXHJcbiAgICB9YDtcclxuICAgIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgIGNvcHkuY2xhc3NOYW1lID0gJ25vZGUtY29weSc7XHJcbiAgICBjb25zdCBkaXNwbGF5TmFtZSA9IGVmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpO1xyXG4gICAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBuYW1lLnR5cGUgPSAndGV4dCc7XHJcbiAgICBuYW1lLmNsYXNzTmFtZSA9IGBub2RlLW5hbWUtaW5wdXQke3N0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8gJyBpcy1yZW5hbWVkJyA6ICcnfWA7XHJcbiAgICBuYW1lLnZhbHVlID0gZGlzcGxheU5hbWU7XHJcbiAgICBuYW1lLm1heExlbmd0aCA9IDk2O1xyXG4gICAgbmFtZS5zcGVsbGNoZWNrID0gZmFsc2U7XHJcbiAgICBuYW1lLmRhdGFzZXQubmFtZUZvciA9IG5vZGUuaWQ7XHJcbiAgICBuYW1lLnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGAke25vZGUubmFtZX0g5a+85YWl6IqC54K55ZCNYCk7XHJcbiAgICBjb25zdCBzdHJhdGVneVN1bW1hcnkgPSBzdHJhdGVneVN1bW1hcnlGb3JOb2RlKG5vZGUsIHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSk7XHJcbiAgICBuYW1lLnRpdGxlID0gW1xyXG4gICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8gYEZpZ21hIOWOn+WQje+8miR7bm9kZS5uYW1lfWAgOiAn54K55Ye75L+u5pS55a+85YWl6IqC54K55ZCNJyxcclxuICAgICAgICBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3ksXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcsXHJcbiAgICBdXHJcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKVxyXG4gICAgICAgIC5qb2luKCcgwrcgJyk7XHJcbiAgICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBtZXRhLmNsYXNzTmFtZSA9ICdub2RlLW1ldGEnO1xyXG4gICAgbWV0YS50ZXh0Q29udGVudCA9IGAke25vZGUudHlwZX0gwrcgJHtNYXRoLnJvdW5kKG5vZGUud2lkdGgpfcOXJHtNYXRoLnJvdW5kKG5vZGUuaGVpZ2h0KX1gO1xyXG4gICAgY29weS5hcHBlbmQobmFtZSwgbWV0YSk7XHJcbiAgICBpZiAoc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5KSB7XHJcbiAgICAgICAgY29uc3Qgc3RyYXRlZ3kgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBzdHJhdGVneS5jbGFzc05hbWUgPSAnbm9kZS1zdHJhdGVneSc7XHJcbiAgICAgICAgc3RyYXRlZ3kudGV4dENvbnRlbnQgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3k7XHJcbiAgICAgICAgc3RyYXRlZ3kudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkuc3RyYXRlZ3k7XHJcbiAgICAgICAgY29weS5hcHBlbmRDaGlsZChzdHJhdGVneSk7XHJcbiAgICB9XHJcbiAgICBpZiAoc3RyYXRlZ3lTdW1tYXJ5Lndhcm5pbmcpIHtcclxuICAgICAgICBjb25zdCB3YXJuaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgd2FybmluZy5jbGFzc05hbWUgPSAnbm9kZS13YXJuaW5nJztcclxuICAgICAgICB3YXJuaW5nLnRleHRDb250ZW50ID0gYOKaoCAke3N0cmF0ZWd5U3VtbWFyeS53YXJuaW5nfWA7XHJcbiAgICAgICAgd2FybmluZy50aXRsZSA9IHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nO1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQod2FybmluZyk7XHJcbiAgICB9XHJcbiAgICByb3cuY2xhc3NMaXN0LnRvZ2dsZSgnaGFzLWRldGFpbCcsIEJvb2xlYW4oc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5IHx8IHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSk7XHJcbiAgICBtYWluLmFwcGVuZChjb2xsYXBzZSwgZG90LCBjb3B5KTtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEFjdGlvbiA9IHNhZmVBY3Rpb24obm9kZSwgc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24pO1xyXG4gICAgY29uc3QgYWN0aW9uT3B0aW9ucyA9IGFjdGlvbk9wdGlvbnNGb3JOb2RlKG5vZGUpO1xyXG4gICAgY29uc3QgYWN0aW9uID0gbWFrZVNlbGVjdChcclxuICAgICAgICAnYWN0aW9uLXNlbGVjdCcsXHJcbiAgICAgICAgc2VsZWN0ZWRBY3Rpb24sXHJcbiAgICAgICAgYWN0aW9uT3B0aW9ucyxcclxuICAgICAgICBgJHtkaXNwbGF5TmFtZX0g5a+85YWl5pa55byPYCxcclxuICAgICk7XHJcbiAgICBhY3Rpb24uZGF0YXNldC5hY3Rpb25Gb3IgPSBub2RlLmlkO1xyXG5cclxuICAgIGNvbnN0IHNlbGVjdGVkS2luZCA9IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQ7XHJcbiAgICBjb25zdCBlZmZlY3RpdmVLaW5kID0gZWZmZWN0aXZlS2luZEZvck5vZGUoXHJcbiAgICAgICAgbm9kZSxcclxuICAgICAgICBzZWxlY3RlZEtpbmQsXHJcbiAgICAgICAgc2VsZWN0ZWRBY3Rpb24sXHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcy5oYXMobm9kZS5pZCksXHJcbiAgICApO1xyXG4gICAgY29uc3Qga2luZE9wdGlvbnMgPSBraW5kT3B0aW9uc0ZvckFjdGlvbihzZWxlY3RlZEFjdGlvbik7XHJcbiAgICBjb25zdCBraW5kID0gbWFrZVNlbGVjdChcclxuICAgICAgICAna2luZC1zZWxlY3QnLFxyXG4gICAgICAgIGVmZmVjdGl2ZUtpbmQsXHJcbiAgICAgICAga2luZE9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOiKgueCueexu+Wei2AsXHJcbiAgICApO1xyXG4gICAga2luZC5kYXRhc2V0LmtpbmRGb3IgPSBub2RlLmlkO1xyXG5cclxuICAgIGNvbnN0IHBhdGNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGFiZWwnKTtcclxuICAgIHBhdGNoLmNsYXNzTmFtZSA9ICdwYXRjaC10b2dnbGUnO1xyXG4gICAgcGF0Y2gudGl0bGUgPSBub2RlLnNsaWNlTW9kZVxyXG4gICAgICAgID8gYOWQr+eUqCR7bm9kZS5zbGljZU1vZGUgPT09ICduaW5lJyA/ICfkuZ3lrqvmoLwnIDogJ+S4ieWuq+agvCd95YiH54mHYFxyXG4gICAgICAgIDogbm9kZS5wYXRjaENhbmRpZGF0ZVxyXG4gICAgICAgICAgICA/ICflkK/nlKjoh6rliqjor4bliKvnmoTkuIkv5Lmd5a6r5qC85YiH54mHJ1xyXG4gICAgICAgICAgICA6ICfor6XoioLngrnkuI3mmK/oh6rliqjor4bliKvnmoTliIfniYflgJnpgIknO1xyXG4gICAgY29uc3QgcGF0Y2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2lucHV0Jyk7XHJcbiAgICBwYXRjaElucHV0LnR5cGUgPSAnY2hlY2tib3gnO1xyXG4gICAgcGF0Y2hJbnB1dC5kYXRhc2V0LnBhdGNoRm9yID0gbm9kZS5pZDtcclxuICAgIHBhdGNoSW5wdXQuY2hlY2tlZCA9IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpO1xyXG4gICAgcGF0Y2hJbnB1dC5kaXNhYmxlZCA9ICFub2RlLnBhdGNoQ2FuZGlkYXRlO1xyXG4gICAgY29uc3QgcGF0Y2hJY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgcGF0Y2hJY29uLnRleHRDb250ZW50ID0gJ+KWpic7XHJcbiAgICBwYXRjaC5hcHBlbmQocGF0Y2hJbnB1dCwgcGF0Y2hJY29uKTtcclxuICAgIHJvdy5hcHBlbmQobWFpbiwgYWN0aW9uLCBraW5kLCBwYXRjaCk7XHJcbiAgICBjb250YWluZXIuYXBwZW5kQ2hpbGQocm93KTtcclxuXHJcbiAgICBpZiAoIXN0YXRlLmNvbGxhcHNlZC5oYXMobm9kZS5pZCkgfHwgc3RhdGUuc2VhcmNoKSB7XHJcbiAgICAgICAgbm9kZS5jaGlsZHJlbi5mb3JFYWNoKChjaGlsZCkgPT4gYXBwZW5kVHJlZU5vZGUoY29udGFpbmVyLCBjaGlsZCwgZGVwdGggKyAxKSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclRyZWUocmVzZXRTY3JvbGwgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdHJlZSA9IGVsZW1lbnQoJyN0cmVlJyk7XHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwodHJlZSwgKCkgPT4ge1xyXG4gICAgICAgIHRyZWUucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZW1wdHktc3RhdGUnO1xyXG4gICAgICAgICAgICBjb25zdCBnbHlwaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgICAgICAgICAgZ2x5cGguY2xhc3NOYW1lID0gJ2VtcHR5LWdseXBoJztcclxuICAgICAgICAgICAgZ2x5cGgudGV4dENvbnRlbnQgPSAn4oazJztcclxuICAgICAgICAgICAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtcclxuICAgICAgICAgICAgdGl0bGUudGV4dENvbnRlbnQgPSAn6L+Y5rKh5pyJ6IqC54K5JztcclxuICAgICAgICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3AnKTtcclxuICAgICAgICAgICAgYm9keS50ZXh0Q29udGVudCA9ICfor7vlj5YgRmlnbWEg6ZO+5o6l5ZCO77yM5Y+v6YCQ5bGC6YCJ5oup55Sf5oiQ44CBUE5HIOaVtOWxguaIluabtOaWsOOAgic7XHJcbiAgICAgICAgICAgIGVtcHR5LmFwcGVuZChnbHlwaCwgdGl0bGUsIGJvZHkpO1xyXG4gICAgICAgICAgICB0cmVlLmFwcGVuZENoaWxkKGVtcHR5KTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzdGF0ZS5kb2N1bWVudC50cmVlLmZvckVhY2goKG5vZGUpID0+IGFwcGVuZFRyZWVOb2RlKHRyZWUsIG5vZGUsIDApKTtcclxuICAgIH0sIHJlc2V0U2Nyb2xsKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IG5vZGVzID0gc3RhdGUuZG9jdW1lbnQgPyBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpIDogW107XHJcbiAgICBjb25zdCBzZWxlY3RlZCA9IG5vZGVzLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgIT09ICdpZ25vcmUnKTtcclxuICAgIGVsZW1lbnQoJyNub2RlLWNvdW50JykudGV4dENvbnRlbnQgPSBgJHtub2Rlcy5sZW5ndGh9IOiKgueCuWA7XHJcbiAgICBlbGVtZW50KCcjc2VsZWN0aW9uLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IHN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgPyBgJHtzZWxlY3RlZC5sZW5ndGh9IC8gJHtub2Rlcy5sZW5ndGh9IOS4quiKgueCueWwhuWPguS4juWvvOWFpWBcclxuICAgICAgICA6ICfnrYnlvoXorr7orqHmlbDmja4nO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSBzdGF0ZS5idXN5XHJcbiAgICAgICAgfHwgIXN0YXRlLmRvY3VtZW50XHJcbiAgICAgICAgfHwgIXNlbGVjdGVkLmxlbmd0aFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcHJldmlldyhub2RlOiBUcmVlTm9kZUR0byk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKHN0YXRlLmJ1c3kpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5zZWxlY3RlZElkID0gbm9kZS5pZDtcclxuICAgIHJlbmRlclRyZWUoKTtcclxuICAgIGVsZW1lbnQoJyNwcmV2aWV3LW1ldGEnKS50ZXh0Q29udGVudCA9IGAke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfSDCtyAke01hdGgucm91bmQobm9kZS53aWR0aCl9w5cke01hdGgucm91bmQobm9kZS5oZWlnaHQpfWA7XHJcbiAgICBjb25zdCBzdGFnZSA9IGVsZW1lbnQoJyNwcmV2aWV3LXN0YWdlJyk7XHJcbiAgICBjb25zdCBpbWFnZSA9IGVsZW1lbnQ8SFRNTEltYWdlRWxlbWVudD4oJyNwcmV2aWV3LWltYWdlJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QuYWRkKCdpcy1sb2FkaW5nJyk7XHJcbiAgICBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdoYXMtaW1hZ2UnKTtcclxuICAgIGltYWdlLnJlbW92ZUF0dHJpYnV0ZSgnc3JjJyk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyB1cmw6IHN0cmluZyB9PignZ2V0LXByZXZpZXcnLCBub2RlLmlkKTtcclxuICAgICAgICBpZiAoc3RhdGUuc2VsZWN0ZWRJZCAhPT0gbm9kZS5pZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgICAgICAgaW1hZ2Uub25sb2FkID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgICAgICBpbWFnZS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KG5ldyBFcnJvcign6aKE6KeI5Zu+54mH5Yqg6L295aSx6LSl44CCJykpO1xyXG4gICAgICAgICAgICBpbWFnZS5zcmMgPSByZXN1bHQudXJsO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHN0YWdlLmNsYXNzTGlzdC5hZGQoJ2hhcy1pbWFnZScpO1xyXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6aKE6KeI5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHN0YWdlLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLWxvYWRpbmcnKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gYXBwbHlQcmVzZXQobmFtZTogc3RyaW5nKTogdm9pZCB7XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgYWxsID0gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgIGlmIChuYW1lID09PSAnc21hcnQnKSB7XHJcbiAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuY2xlYXIoKTtcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhzdGF0ZS5kb2N1bWVudC50cmVlKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gc3RhdGUuZGVmYXVsdHMuZ2V0KG5vZGUuaWQpITtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgb3JpZ2luYWwuYWN0aW9uKTtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmtpbmQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSBpZiAobmFtZSA9PT0gJ2VkaXRhYmxlJykge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgaXNWZWN0b3JOb2RlVHlwZShub2RlLnR5cGUpID8gJ3JlbmRlcicgOiAnZ2VuZXJhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBzdGF0ZS5wcmVmZXJyZWRBY3Rpb25zLnNldChub2RlLmlkLCBub2RlLmNoaWxkcmVuLmxlbmd0aFxyXG4gICAgICAgICAgICAgICAgPyAnZ2VuZXJhdGUnXHJcbiAgICAgICAgICAgICAgICA6ICdyZW5kZXInKTtcclxuICAgICAgICAgICAgc3RhdGUuZXhwbGljaXRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxuICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCBidXR0b24uZGF0YXNldC5wcmVzZXQgPT09IG5hbWUpO1xyXG4gICAgfSk7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRUb1NjZW5lKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIHNob3dUb2FzdCgn5omp5bGV5Li76L+b56iL5LuN5piv5pen54mI77yM6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIXN0YXRlLmRvY3VtZW50IHx8IHN0YXRlLmJ1c3kpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncygpO1xyXG4gICAgaWYgKCFzZXR0aW5ncykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG92ZXJyaWRlczogSW1wb3J0T3ZlcnJpZGVbXSA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiAoe1xyXG4gICAgICAgIGlkOiBub2RlLmlkLFxyXG4gICAgICAgIGFjdGlvbjogc3RhdGUuYWN0aW9ucy5nZXQobm9kZS5pZCkgPz8gbm9kZS5hY3Rpb24sXHJcbiAgICAgICAga2luZDogc3RhdGUua2luZHMuZ2V0KG5vZGUuaWQpID8/IG5vZGUua2luZCxcclxuICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIGV4cGxpY2l0OiBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCksXHJcbiAgICAgICAgLi4uKHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgfSkpO1xyXG4gICAgc2V0QnVzeSh0cnVlKTtcclxuICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdhc3NldHMnLCB2YWx1ZTogMCwgbWVzc2FnZTogJ+ato+WcqOWHhuWkh+WvvOWFpeKApicgfSk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBwcmVmYWJVcmw/OiBzdHJpbmc7IHdhcm5pbmdzPzogc3RyaW5nW107IHJldmlldz86IEltcG9ydFJldmlldyB9PihcclxuICAgICAgICAgICAgJ2ltcG9ydC1zZWxlY3Rpb24nLFxyXG4gICAgICAgICAgICB7IG92ZXJyaWRlcywgc2V0dGluZ3MgfSxcclxuICAgICAgICApO1xyXG4gICAgICAgIGNvbnN0IGZhbGxiYWNrTm90ZSA9IHJlc3VsdD8ud2FybmluZ3M/Lmxlbmd0aFxyXG4gICAgICAgICAgICA/IGDvvJske3Jlc3VsdC53YXJuaW5ncy5sZW5ndGh9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrvvIjor6bop4Hnu5Pmnpzmo4Dmn6XvvIlgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIGlmIChyZXN1bHQucmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXN1bHQucmV2aWV3KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+WvvOWFpeWksei0peOAgicpO1xyXG4gICAgICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdlcnJvcicsIHZhbHVlOiAwLCBtZXNzYWdlIH0pO1xyXG4gICAgICAgIHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXZpZXcgPSBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycpO1xyXG4gICAgICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluajgOafpee7k+aenOWksei0peOAgicpLCB0cnVlKTsgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjc2F2ZS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3Rva2VuLWlucHV0Jyk7XHJcbiAgICAgICAgaWYgKCFpbnB1dC52YWx1ZS50cmltKCkpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEgVG9rZW7jgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdzZXQtdG9rZW4nLCBpbnB1dC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QodmF1bHQucGVyc2lzdGVudCA/ICdUb2tlbiDlt7LnlLHns7vnu5/liqDlr4bkv53lrZjjgIInIDogJ1Rva2VuIOW3suS/neWtmOWIsOacrOasoeS8muivneOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfkv53lrZjlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEg5paH5Lu25oiW6IqC54K56ZO+5o6l44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4wNSwgbWVzc2FnZTogJ+ato+WcqOi/nuaOpSBGaWdtYeKApicgfSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCByZXF1ZXN0PERvY3VtZW50RHRvPignZmV0Y2gtZG9jdW1lbnQnLCBzb3VyY2UpO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBzdGF0ZS5mb250QXNzZXRzO1xyXG4gICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQoZG9jdW1lbnQpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5jbGljaygpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlc2V0Um91bmR0cmlwVG9rZW5zKTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLWFzc2V0LWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stYXNzZXQtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi1hOa6kOWwhuWGmeWFpSBhc3NldHMvJHtyZXN1bHQuZm9sZGVyfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6notYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLXByZWZhYi1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1wcmVmYWItZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDpooTliLbkvZPlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6aKE5Yi25L2T55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQoYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcu+8jOWGjemAieaLqeacrOWcsOi1hOa6kOebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgICAgIGluZGV4LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDlt7LlkK/nlKjmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqeacrOWcsOi1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBlbGVtZW50KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9ICcnO1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2hvd1RvYXN0KGDlt7LmuIXpmaTmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaW1wb3J0VG9TY2VuZSk7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmVxdWVzdCgnY2FuY2VsLWltcG9ydCcpKTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChldmVudCkgPT4ge1xyXG4gICAgICAgIHN0YXRlLnNlYXJjaCA9IChldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBjb2xsYXBzZUlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2xsYXBzZV0nKT8uZGF0YXNldC5jb2xsYXBzZTtcclxuICAgICAgICBpZiAoY29sbGFwc2VJZCkge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkLmhhcyhjb2xsYXBzZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmRlbGV0ZShjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5hZGQoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuY2xvc2VzdCgnc2VsZWN0LCBsYWJlbCwgaW5wdXQsIHRleHRhcmVhJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtbm9kZS1pZF0nKT8uZGF0YXNldC5ub2RlSWQ7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGlkID8gZmluZE5vZGUoaWQpIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHZvaWQgcHJldmlldyhub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdHJlZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQ7XHJcbiAgICAgICAgaWYgKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybjtcclxuICAgICAgICAgICAgY29uc3QgY3VzdG9tTmFtZSA9IHNhbml0aXplTm9kZU5hbWUodGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgaWYgKCFjdXN0b21OYW1lKSB7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn6IqC54K55ZCN5LiN6IO95Li656m644CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoY3VzdG9tTmFtZSA9PT0gbm9kZS5uYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpXHJcbiAgICAgICAgICAgICAgICA/IGDoioLngrnlsIbku6XigJwke2N1c3RvbU5hbWV94oCd5a+85YWl44CCYFxyXG4gICAgICAgICAgICAgICAgOiAn5bey5oGi5aSNIEZpZ21hIOWOn+iKgueCueWQjeOAgicpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aW9uID0gdGFyZ2V0LnZhbHVlIGFzIEltcG9ydEFjdGlvbjtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gIT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgYWN0aW9uKTtcclxuICAgICAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdyZW5kZXInICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGDigJwke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfeKAneWwhuS9nOS4uuaVtOWxguWvvOWFpe+8jCR7ZGVzY2VuZGFudHMobm9kZSkubGVuZ3RofSDkuKrlrZDoioLngrnkuI3kvJrljZXni6znlJ/miJDjgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpIHtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KHRhcmdldC5kYXRhc2V0LmtpbmRGb3IsIHRhcmdldC52YWx1ZSBhcyBOb2RlS2luZCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5raW5kRm9yKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgIGlmICgodGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEFjdGlvbihub2RlLCAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuZGF0YXNldC5uYW1lRm9yO1xyXG4gICAgICAgIGlmICghaWQpIHJldHVybjtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseVByZXNldChidXR0b24uZGF0YXNldC5wcmVzZXQgPz8gJ3NtYXJ0JykpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFxyXG4gICAgICAgICcjc2NhbGUsICNhc3NldC1mb2xkZXIsICNwcmVmYWItZm9sZGVyLCAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLCAjdXBkYXRlLWV4aXN0aW5nLCAjcmVmcmVzaC1hc3NldHMsICNhdXRvLXNhdmUnLFxyXG4gICAgKS5mb3JFYWNoKChjb250cm9sKSA9PiB7XHJcbiAgICAgICAgY29udHJvbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmb250LW1hcC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcclxuICAgIGxpc3RlbmVyczoge1xyXG4gICAgICAgIHNob3coKSB7fSxcclxuICAgICAgICBoaWRlKCkge30sXHJcbiAgICB9LFxyXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0ZjgnKSxcclxuICAgIHN0eWxlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKSwgJ3V0ZjgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBhcHA6ICcjYXBwJyxcclxuICAgIH0sXHJcbiAgICBtZXRob2RzOiB7XHJcbiAgICAgICAgb25JbXBvcnRSZXZpZXdSZWFkeShyZXZpZXc6IEltcG9ydFJldmlldykge1xyXG4gICAgICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgb25Qcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCkge1xyXG4gICAgICAgICAgICB1cGRhdGVQcm9ncmVzcyhldmVudCk7XHJcbiAgICAgICAgfSxcclxuICAgIH0sXHJcbiAgICBhc3luYyByZWFkeSgpIHtcclxuICAgICAgICBwYW5lbEhvc3QgPSB0aGlzO1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsID0gbmV3IEltcG9ydFJldmlld1BhbmVsKHJvb3QoKSwgcmVxdWVzdCwgc2V0QnVzeSk7XHJcbiAgICAgICAgYmluZEV2ZW50cygpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGluaXRpYWwgPSBhd2FpdCByZXF1ZXN0PHtcclxuICAgICAgICAgICAgICAgIHZlcnNpb24/OiBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICB2YXVsdDogYW55O1xyXG4gICAgICAgICAgICAgICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgICAgICAgICAgICAgZG9jdW1lbnQ6IERvY3VtZW50RHRvIHwgbnVsbDtcclxuICAgICAgICAgICAgICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgICAgICAgICAgfT4oJ2dldC1zdGF0ZScpO1xyXG4gICAgICAgICAgICBzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSA9IGluaXRpYWwudmVyc2lvbiA9PT0gcGFja2FnZUpTT04udmVyc2lvbjtcclxuICAgICAgICAgICAgc3RhdGUuZm9udEFzc2V0cyA9IGluaXRpYWwuZm9udEFzc2V0cyA/PyBbXTtcclxuICAgICAgICAgICAgc2V0Q29ubmVjdGlvbihpbml0aWFsLnZhdWx0KTtcclxuICAgICAgICAgICAgYXBwbHlTZXR0aW5ncyhpbml0aWFsLnNldHRpbmdzKTtcclxuICAgICAgICAgICAgaWYgKGluaXRpYWwuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgICAgIGluaXRpYWxpemVEb2N1bWVudChpbml0aWFsLmRvY3VtZW50KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXN0YXRlLnJ1bnRpbWVDb21wYXRpYmxlKSB7XHJcbiAgICAgICAgICAgICAgICB1cGRhdGVTdW1tYXJ5KCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBidXR0b24gPSBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgICAgICAgICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgICAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICfor7fph43lkK8gQ29jb3MnO1xyXG4gICAgICAgICAgICAgICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGuyc7XHJcbiAgICAgICAgICAgICAgICBzaG93VG9hc3QoJ+ajgOa1i+WIsOaXp+eJiOS4u+i/m+eoi+S7jeWcqOi/kOihjO+8muivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAvLyBSZXBsYXkgcGVyc2lzdGVkIGluLW1lbW9yeSByZXBvcnQgaWYgY29tcGxldGlvbiBwcmVjZWRlZCBwYW5lbCByZWFkaW5lc3MuXHJcbiAgICAgICAgICAgICAgICBjb25zdCByZXZpZXcgPSBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycpO1xyXG4gICAgICAgICAgICAgICAgaWYgKHJldmlldyAmJiAhcmV2aWV3LmNvbmZpcm1lZCkgaW1wb3J0UmV2aWV3UGFuZWw/Lm9wZW4ocmV2aWV3KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfliJ3lp4vljJblpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG4gICAgYmVmb3JlQ2xvc2UoKSB7fSxcclxuICAgIGNsb3NlKCkge1xyXG4gICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5kaXNwb3NlKCk7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWwgPSBudWxsO1xyXG4gICAgICAgIHBhbmVsSG9zdCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19