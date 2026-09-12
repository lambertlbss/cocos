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
            ? `；${result.warnings.length} 个三/九宫已临时作为 PNG 整层导入`
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLHlFQUFnRDtBQUNoRCxtREFBb0Q7QUFFcEQsZ0RBQTJFO0FBQzNFLHlEQUE2RDtBQUM3RCwrQ0FBbUQ7QUFDbkQsbUNBVWlCO0FBbUVqQixJQUFJLFNBQVMsR0FBUSxJQUFJLENBQUM7QUFDMUIsSUFBSSxpQkFBaUIsR0FBNkIsSUFBSSxDQUFDO0FBQ3ZELElBQUksVUFBVSxHQUF5QyxJQUFJLENBQUM7QUFDNUQsSUFBSSxzQkFBc0IsR0FBeUMsSUFBSSxDQUFDO0FBQ3hFLElBQUksb0JBQW9CLEdBQWtCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUM1RCxJQUFJLHFCQUF5QyxDQUFDO0FBQzlDLElBQUksa0JBQXNDLENBQUM7QUFFM0MsTUFBTSxLQUFLLEdBQWU7SUFDdEIsUUFBUSxFQUFFLElBQUk7SUFDZCxRQUFRLEVBQUU7UUFDTixTQUFTLEVBQUUsRUFBRTtRQUNiLFdBQVcsRUFBRSxnQkFBZ0I7UUFDN0IsWUFBWSxFQUFFLHdCQUF3QjtRQUN0QyxvQkFBb0IsRUFBRSxFQUFFO1FBQ3hCLG1CQUFtQixFQUFFLEVBQUU7UUFDdkIsS0FBSyxFQUFFLENBQUM7UUFDUixjQUFjLEVBQUUsSUFBSTtRQUNwQixhQUFhLEVBQUUsS0FBSztRQUNwQixRQUFRLEVBQUUsS0FBSztRQUNmLE9BQU8sRUFBRSxFQUFFO0tBQ2Q7SUFDRCxnQkFBZ0IsRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUMzQixPQUFPLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDbEIsS0FBSyxFQUFFLElBQUksR0FBRyxFQUFFO0lBQ2hCLE9BQU8sRUFBRSxJQUFJLEdBQUcsRUFBRTtJQUNsQixXQUFXLEVBQUUsSUFBSSxHQUFHLEVBQUU7SUFDdEIsS0FB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QUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUN2RSxDQUFDO0lBQ0wsQ0FBQztJQUNELFdBQVcsS0FBSSxDQUFDO0lBQ2hCLEtBQUs7UUFDRCxpQkFBaUIsYUFBakIsaUJBQWlCLHVCQUFqQixpQkFBaUIsQ0FBRSxPQUFPLEVBQUUsQ0FBQztRQUM3QixpQkFBaUIsR0FBRyxJQUFJLENBQUM7UUFDekIsU0FBUyxHQUFHLElBQUksQ0FBQztJQUNyQixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCBwYWNrYWdlSlNPTiBmcm9tICcuLi8uLi8uLi9wYWNrYWdlLmpzb24nO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdQYW5lbCB9IGZyb20gJy4vaW1wb3J0LXJldmlldyc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi4vLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB7IGZpbmRGb250QXNzZXQsIHR5cGUgRm9udEFzc2V0T3B0aW9uIH0gZnJvbSAnLi4vLi4vaW1wb3J0ZXIvZm9udHMnO1xyXG5pbXBvcnQgeyBub3JtYWxpemVJbXBvcnRBY3Rpb24gfSBmcm9tICcuLi8uLi9pbXBvcnQtYWN0aW9ucyc7XHJcbmltcG9ydCB7IHNhbml0aXplTm9kZU5hbWUgfSBmcm9tICcuLi8uLi9ub2RlLW5hbWUnO1xyXG5pbXBvcnQge1xyXG4gICAgYWN0aW9uT3B0aW9uc0Zvck5vZGUsXHJcbiAgICBkZWZhdWx0TmluZVNsaWNlSWRzLFxyXG4gICAgZWZmZWN0aXZlS2luZEZvck5vZGUsXHJcbiAgICBpc1ZlY3Rvck5vZGVUeXBlLFxyXG4gICAga2luZE9wdGlvbnNGb3JBY3Rpb24sXHJcbiAgICByZXJlbmRlclByZXNlcnZpbmdTY3JvbGwsXHJcbiAgICByZXNvbHZlRWZmZWN0aXZlQWN0aW9ucyxcclxuICAgIHNtYXJ0QWN0aW9uRm9yTm9kZSxcclxuICAgIHN0cmF0ZWd5U3VtbWFyeUZvck5vZGUsXHJcbn0gZnJvbSAnLi9tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHtcclxuICAgIEltcG9ydEFjdGlvbixcclxuICAgIEltcG9ydE92ZXJyaWRlLFxyXG4gICAgSW1wb3J0U2V0dGluZ3MsXHJcbiAgICBOb2RlS2luZCxcclxuICAgIFByb2dyZXNzRXZlbnQsXHJcbiAgICBUcmVlTm9kZUR0byxcclxufSBmcm9tICcuLi8uLi90eXBlcyc7XHJcblxyXG5pbnRlcmZhY2UgRG9jdW1lbnREdG8ge1xyXG4gICAgZmlsZUtleTogc3RyaW5nO1xyXG4gICAgZmlsZU5hbWU6IHN0cmluZztcclxuICAgIHNvdXJjZVVybDogc3RyaW5nO1xyXG4gICAgdHJlZTogVHJlZU5vZGVEdG9bXTtcclxuICAgIGZvbnRzOiBzdHJpbmdbXTtcclxuICAgIGZvbnRBc3NldHM/OiBGb250QXNzZXRPcHRpb25bXTtcclxuICAgIG5vZGVPdmVycmlkZXM/OiBJbXBvcnRPdmVycmlkZVtdO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUm91bmR0cmlwRGV0ZWN0RHRvIHtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgbWFuYWdlZFJvb3RzOiBBcnJheTx7IG5vZGVJZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHByZWZhYlV1aWQ/OiBzdHJpbmc7IGVycm9yPzogc3RyaW5nIH0+O1xyXG4gICAgc2VsZWN0ZWRSb290SWQ/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBSb3VuZHRyaXBQcmV2aWV3RHRvIHtcclxuICAgIHByZXZpZXdUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJUb2tlbj86IHN0cmluZztcclxuICAgIHBhaXJSZXF1aXJlZDogYm9vbGVhbjtcclxuICAgIHBhaXJFbGlnaWJsZTogYm9vbGVhbjtcclxuICAgIGZpZ21hVmVyc2lvbjogc3RyaW5nO1xyXG4gICAgc3VyZmFjZUlkOiBzdHJpbmc7XHJcbiAgICBwcmVmYWJVdWlkOiBzdHJpbmc7XHJcbiAgICBhc3NldFVybDogc3RyaW5nO1xyXG4gICAgbGVkZ2VyR2VuZXJhdGlvbjogbnVtYmVyO1xyXG4gICAgYmxvY2tlcnM6IHN0cmluZ1tdO1xyXG4gICAgcGxhbjoge1xyXG4gICAgICAgIGFwcGx5OiB1bmtub3duW107XHJcbiAgICAgICAgcHJlc2VydmVDb2NvczogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbnZlcmdlZDogdW5rbm93bltdO1xyXG4gICAgICAgIGNvbmZsaWN0czogdW5rbm93bltdO1xyXG4gICAgICAgIHVuc3VwcG9ydGVkOiB1bmtub3duW107XHJcbiAgICAgICAgcmVhZG9ubHlVbmNoYW5nZWQ6IHVua25vd25bXTtcclxuICAgIH07XHJcbn1cclxuXHJcbmludGVyZmFjZSBQYW5lbFN0YXRlIHtcclxuICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYWN0aW9uczogTWFwPHN0cmluZywgSW1wb3J0QWN0aW9uPjtcclxuICAgIGtpbmRzOiBNYXA8c3RyaW5nLCBOb2RlS2luZD47XHJcbiAgICBwYXRjaGVzOiBTZXQ8c3RyaW5nPjtcclxuICAgIGV4cGxpY2l0SWRzOiBTZXQ8c3RyaW5nPjtcclxuICAgIG5hbWVzOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xyXG4gICAgcmVuYW1lZElkczogU2V0PHN0cmluZz47XHJcbiAgICBkZWZhdWx0czogTWFwPHN0cmluZywgeyBhY3Rpb246IEltcG9ydEFjdGlvbjsga2luZDogTm9kZUtpbmQgfT47XHJcbiAgICBjb2xsYXBzZWQ6IFNldDxzdHJpbmc+O1xyXG4gICAgc3VwcHJlc3NlZDogU2V0PHN0cmluZz47XHJcbiAgICBzZWxlY3RlZElkPzogc3RyaW5nO1xyXG4gICAgc2VhcmNoOiBzdHJpbmc7XHJcbiAgICBidXN5OiBib29sZWFuO1xyXG4gICAgcnVudGltZUNvbXBhdGlibGU6IGJvb2xlYW47XHJcbiAgICBmb250QXNzZXRzOiBGb250QXNzZXRPcHRpb25bXTtcclxufVxyXG5cclxubGV0IHBhbmVsSG9zdDogYW55ID0gbnVsbDtcclxubGV0IGltcG9ydFJldmlld1BhbmVsOiBJbXBvcnRSZXZpZXdQYW5lbCB8IG51bGwgPSBudWxsO1xyXG5sZXQgdG9hc3RUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxubGV0IGltcG9ydEJ1dHRvblJlc2V0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcbmxldCBub2RlT3ZlcnJpZGVTYXZlVGFzazogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5sZXQgcm91bmR0cmlwUHJldmlld1Rva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbmxldCByb3VuZHRyaXBQYWlyVG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcclxuXHJcbmNvbnN0IHN0YXRlOiBQYW5lbFN0YXRlID0ge1xyXG4gICAgZG9jdW1lbnQ6IG51bGwsXHJcbiAgICBzZXR0aW5nczoge1xyXG4gICAgICAgIHNvdXJjZVVybDogJycsXHJcbiAgICAgICAgYXNzZXRGb2xkZXI6ICdmaWdtYS1pbXBvcnRlcicsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyOiAnZmlnbWEtaW1wb3J0ZXIvcHJlZmFicycsXHJcbiAgICAgICAgbG9jYWxSZXNvdXJjZUZvbGRlcnM6IFtdLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6ICcnLFxyXG4gICAgICAgIHNjYWxlOiAxLFxyXG4gICAgICAgIHVwZGF0ZUV4aXN0aW5nOiB0cnVlLFxyXG4gICAgICAgIHJlZnJlc2hBc3NldHM6IGZhbHNlLFxyXG4gICAgICAgIGF1dG9TYXZlOiBmYWxzZSxcclxuICAgICAgICBmb250TWFwOiB7fSxcclxuICAgIH0sXHJcbiAgICBwcmVmZXJyZWRBY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBhY3Rpb25zOiBuZXcgTWFwKCksXHJcbiAgICBraW5kczogbmV3IE1hcCgpLFxyXG4gICAgcGF0Y2hlczogbmV3IFNldCgpLFxyXG4gICAgZXhwbGljaXRJZHM6IG5ldyBTZXQoKSxcclxuICAgIG5hbWVzOiBuZXcgTWFwKCksXHJcbiAgICByZW5hbWVkSWRzOiBuZXcgU2V0KCksXHJcbiAgICBkZWZhdWx0czogbmV3IE1hcCgpLFxyXG4gICAgY29sbGFwc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzdXBwcmVzc2VkOiBuZXcgU2V0KCksXHJcbiAgICBzZWFyY2g6ICcnLFxyXG4gICAgYnVzeTogZmFsc2UsXHJcbiAgICBydW50aW1lQ29tcGF0aWJsZTogdHJ1ZSxcclxuICAgIGZvbnRBc3NldHM6IFtdLFxyXG59O1xyXG5cclxuZnVuY3Rpb24gcm9vdCgpOiBIVE1MRWxlbWVudCB7XHJcbiAgICByZXR1cm4gcGFuZWxIb3N0LiQuYXBwIGFzIEhUTUxFbGVtZW50O1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbGVtZW50PFQgZXh0ZW5kcyBIVE1MRWxlbWVudD4oc2VsZWN0b3I6IHN0cmluZyk6IFQge1xyXG4gICAgY29uc3QgdmFsdWUgPSByb290KCkucXVlcnlTZWxlY3RvcjxUPihzZWxlY3Rvcik7XHJcbiAgICBpZiAoIXZhbHVlKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBQYW5lbCBlbGVtZW50IG5vdCBmb3VuZDogJHtzZWxlY3Rvcn1gKTtcclxuICAgIH1cclxuICAgIHJldHVybiB2YWx1ZTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gcmVxdWVzdDxUPihtZXNzYWdlOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSk6IFByb21pc2U8VD4ge1xyXG4gICAgcmV0dXJuIGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QocGFja2FnZUpTT04ubmFtZSwgbWVzc2FnZSwgLi4uYXJncykgYXMgVDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2hvd1RvYXN0KG1lc3NhZ2U6IHN0cmluZywgZXJyb3IgPSBmYWxzZSk6IHZvaWQge1xyXG4gICAgY29uc3QgdG9hc3QgPSBlbGVtZW50PEhUTUxEaXZFbGVtZW50PignI3RvYXN0Jyk7XHJcbiAgICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XHJcbiAgICB0b2FzdC5jbGFzc0xpc3QudG9nZ2xlKCdlcnJvcicsIGVycm9yKTtcclxuICAgIHRvYXN0LmNsYXNzTGlzdC5hZGQoJ3Nob3cnKTtcclxuICAgIGlmICh0b2FzdFRpbWVyKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRvYXN0VGltZXIpO1xyXG4gICAgfVxyXG4gICAgdG9hc3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdG9hc3QuY2xhc3NMaXN0LnJlbW92ZSgnc2hvdycpLCAzNDAwKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duLCBmYWxsYmFjazogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIGVycm9yLm1lc3NhZ2UpIHtcclxuICAgICAgICByZXR1cm4gZXJyb3IubWVzc2FnZTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgZXJyb3IgPT09ICdzdHJpbmcnICYmIGVycm9yLnRyaW0oKSkge1xyXG4gICAgICAgIHJldHVybiBlcnJvcjtcclxuICAgIH1cclxuICAgIGlmIChlcnJvciAmJiB0eXBlb2YgZXJyb3IgPT09ICdvYmplY3QnICYmICdtZXNzYWdlJyBpbiBlcnJvclxyXG4gICAgICAgICYmIHR5cGVvZiAoZXJyb3IgYXMgeyBtZXNzYWdlPzogdW5rbm93biB9KS5tZXNzYWdlID09PSAnc3RyaW5nJykge1xyXG4gICAgICAgIHJldHVybiAoZXJyb3IgYXMgeyBtZXNzYWdlOiBzdHJpbmcgfSkubWVzc2FnZTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxsYmFjaztcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0Q29ubmVjdGlvbih2YXVsdDoge1xyXG4gICAgaGFzVG9rZW46IGJvb2xlYW47XHJcbiAgICBwZXJzaXN0ZW50OiBib29sZWFuO1xyXG4gICAgYmFja2VuZDogc3RyaW5nO1xyXG4gICAgd2FybmluZz86IHN0cmluZztcclxufSk6IHZvaWQge1xyXG4gICAgY29uc3QgcGlsbCA9IGVsZW1lbnQoJyNjb25uZWN0aW9uLXBpbGwnKTtcclxuICAgIHBpbGwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtb25saW5lJywgdmF1bHQuaGFzVG9rZW4pO1xyXG4gICAgcGlsbC5jbGFzc0xpc3QudG9nZ2xlKCdpcy1vZmZsaW5lJywgIXZhdWx0Lmhhc1Rva2VuKTtcclxuICAgIGVsZW1lbnQoJyNjb25uZWN0aW9uLWxhYmVsJykudGV4dENvbnRlbnQgPSB2YXVsdC5oYXNUb2tlbiA/ICflh63mja7lsLHnu6onIDogJ+acqui/nuaOpSc7XHJcbiAgICBlbGVtZW50KCcjdmF1bHQtYmFkZ2UnKS50ZXh0Q29udGVudCA9IHZhdWx0LnBlcnNpc3RlbnQgPyAn57O757uf5Yqg5a+GJyA6ICfkvJror53lrZjlgqgnO1xyXG4gICAgZWxlbWVudCgnI3ZhdWx0LW5vdGUnKS50ZXh0Q29udGVudCA9IHZhdWx0Lndhcm5pbmdcclxuICAgICAgICA/PyAodmF1bHQucGVyc2lzdGVudCA/IGDnlLEgJHt2YXVsdC5iYWNrZW5kfSDliqDlr4bvvIzpobnnm67kuK3ku4Xkv53lrZjpnZ7mlY/mhJ/orr7nva5gIDogJ1Rva2VuIOS4jeWGmeWFpemhueebruaWh+S7ticpO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjdmVyaWZ5LXRva2VuJykpLmRpc2FibGVkID0gIXZhdWx0Lmhhc1Rva2VuO1xyXG4gICAgKGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjY2xlYXItdG9rZW4nKSkuZGlzYWJsZWQgPSAhdmF1bHQuaGFzVG9rZW47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZsYXR0ZW4obm9kZXM6IFRyZWVOb2RlRHRvW10pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2Rlcy5mbGF0TWFwKChub2RlKSA9PiBbbm9kZSwgLi4uZmxhdHRlbihub2RlLmNoaWxkcmVuKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5kTm9kZShpZDogc3RyaW5nLCBub2RlcyA9IHN0YXRlLmRvY3VtZW50Py50cmVlID8/IFtdKTogVHJlZU5vZGVEdG8gfCB1bmRlZmluZWQge1xyXG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XHJcbiAgICAgICAgaWYgKG5vZGUuaWQgPT09IGlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBub2RlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGlsZCA9IGZpbmROb2RlKGlkLCBub2RlLmNoaWxkcmVuKTtcclxuICAgICAgICBpZiAoY2hpbGQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGNoaWxkO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckZvbnRNYXAoKTogdm9pZCB7XHJcbiAgICBjb25zdCBsaXN0ID0gZWxlbWVudCgnI2ZvbnQtbWFwLWxpc3QnKTtcclxuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XHJcbiAgICBjb25zdCBmYW1pbGllcyA9IHN0YXRlLmRvY3VtZW50Py5mb250cyA/PyBbXTtcclxuICAgIGlmICghZmFtaWxpZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICBlbXB0eS5jbGFzc05hbWUgPSAnZm9udC1tYXAtZW1wdHknO1xyXG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gJ+ivu+WPliBGaWdtYSDlkI7vvIzov5nph4zkvJrliJflh7rmo4DmtYvliLDnmoTlrZfkvZPjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghc3RhdGUuZm9udEFzc2V0cy5sZW5ndGgpIHtcclxuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIGVtcHR5LmNsYXNzTmFtZSA9ICdmb250LW1hcC1lbXB0eSBpcy13YXJuaW5nJztcclxuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9ICfpobnnm64gYXNzZXRzIOWGheayoeacieajgOa1i+WIsCAudHRmIC8gLm90ZiAvIC5mbnQgLyAud29mZiDlrZfkvZPotYTmupDjgIInO1xyXG4gICAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBmYW1pbHkgb2YgZmFtaWxpZXMpIHtcclxuICAgICAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICByb3cuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXJvdyc7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIHNvdXJjZS5jbGFzc05hbWUgPSAnZm9udC1tYXAtc291cmNlJztcclxuICAgICAgICBzb3VyY2UudGV4dENvbnRlbnQgPSBmYW1pbHk7XHJcbiAgICAgICAgc291cmNlLnRpdGxlID0gZmFtaWx5O1xyXG4gICAgICAgIGNvbnN0IGFycm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgIGFycm93LmNsYXNzTmFtZSA9ICdmb250LW1hcC1hcnJvdyc7XHJcbiAgICAgICAgYXJyb3cudGV4dENvbnRlbnQgPSAn4oaSJztcclxuICAgICAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzZWxlY3QnKTtcclxuICAgICAgICBzZWxlY3QuY2xhc3NOYW1lID0gJ2ZvbnQtbWFwLXNlbGVjdCc7XHJcbiAgICAgICAgc2VsZWN0LmRhdGFzZXQuZm9udEZhbWlseSA9IGZhbWlseTtcclxuICAgICAgICBzZWxlY3Quc2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJywgYCR7ZmFtaWx5fSDmmKDlsITlrZfkvZNgKTtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKCcnLCAn5LiN5pig5bCE77yI5L2/55So6buY6K6k5a2X5L2T77yJJykpO1xyXG4gICAgICAgIGNvbnN0IGF1dG9tYXRpYyA9IGZpbmRGb250QXNzZXQoZmFtaWx5LCBzdGF0ZS5mb250QXNzZXRzKTtcclxuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHN0YXRlLnNldHRpbmdzLmZvbnRNYXBbZmFtaWx5XSA/PyBhdXRvbWF0aWM/LnVybCA/PyAnJztcclxuICAgICAgICBmb3IgKGNvbnN0IGFzc2V0IG9mIHN0YXRlLmZvbnRBc3NldHMpIHtcclxuICAgICAgICAgICAgY29uc3QgaXRlbSA9IG9wdGlvbihhc3NldC51cmwsIGAke2Fzc2V0Lm5hbWV9IMK3ICR7YXNzZXQucmVsYXRpdmVQYXRofWApO1xyXG4gICAgICAgICAgICBpdGVtLnNlbGVjdGVkID0gYXNzZXQudXJsID09PSBzZWxlY3RlZDtcclxuICAgICAgICAgICAgc2VsZWN0LmFwcGVuZENoaWxkKGl0ZW0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZWxlY3QudmFsdWUgPSBzZWxlY3RlZDtcclxuICAgICAgICByb3cuYXBwZW5kKHNvdXJjZSwgYXJyb3csIHNlbGVjdCk7XHJcbiAgICAgICAgbGlzdC5hcHBlbmRDaGlsZChyb3cpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBzYWZlQWN0aW9uKF9ub2RlOiBUcmVlTm9kZUR0bywgYWN0aW9uOiB1bmtub3duKTogSW1wb3J0QWN0aW9uIHtcclxuICAgIHJldHVybiBub3JtYWxpemVJbXBvcnRBY3Rpb24oYWN0aW9uKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5pdGlhbGl6ZURvY3VtZW50KGRvY3VtZW50OiBEb2N1bWVudER0byk6IHZvaWQge1xyXG4gICAgc3RhdGUuZG9jdW1lbnQgPSBkb2N1bWVudDtcclxuICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmFjdGlvbnMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmtpbmRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5wYXRjaGVzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5leHBsaWNpdElkcy5jbGVhcigpO1xyXG4gICAgc3RhdGUubmFtZXMuY2xlYXIoKTtcclxuICAgIHN0YXRlLnJlbmFtZWRJZHMuY2xlYXIoKTtcclxuICAgIHN0YXRlLmRlZmF1bHRzLmNsZWFyKCk7XHJcbiAgICBzdGF0ZS5jb2xsYXBzZWQuY2xlYXIoKTtcclxuICAgIHN0YXRlLnN1cHByZXNzZWQuY2xlYXIoKTtcclxuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBmbGF0dGVuKGRvY3VtZW50LnRyZWUpKSB7XHJcbiAgICAgICAgY29uc3QgYWN0aW9uID0gc21hcnRBY3Rpb25Gb3JOb2RlKG5vZGUpO1xyXG4gICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGFjdGlvbik7XHJcbiAgICAgICAgc3RhdGUua2luZHMuc2V0KG5vZGUuaWQsIG5vZGUua2luZCk7XHJcbiAgICAgICAgc3RhdGUuZGVmYXVsdHMuc2V0KG5vZGUuaWQsIHsgYWN0aW9uLCBraW5kOiBub2RlLmtpbmQgfSk7XHJcbiAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIG5vZGUubmFtZSk7XHJcbiAgICB9XHJcbiAgICBzdGF0ZS5wYXRjaGVzID0gZGVmYXVsdE5pbmVTbGljZUlkcyhkb2N1bWVudC50cmVlKTtcclxuICAgIGZvciAoY29uc3Qgb3ZlcnJpZGUgb2YgZG9jdW1lbnQubm9kZU92ZXJyaWRlcyA/PyBbXSkge1xyXG4gICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShvdmVycmlkZS5pZCwgZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgaWYgKCFub2RlKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjdXN0b21OYW1lID0gc2FuaXRpemVOb2RlTmFtZShvdmVycmlkZS5uYW1lKTtcclxuICAgICAgICBpZiAoY3VzdG9tTmFtZSAmJiBjdXN0b21OYW1lICE9PSBub2RlLm5hbWUpIHtcclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKG92ZXJyaWRlLmV4cGxpY2l0ID09PSB0cnVlKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIHNhZmVBY3Rpb24obm9kZSwgb3ZlcnJpZGUuYWN0aW9uKSk7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvdmVycmlkZS5raW5kKTtcclxuICAgICAgICAgICAgaWYgKG92ZXJyaWRlLm5pbmVTbGljZSAmJiBub2RlLnBhdGNoQ2FuZGlkYXRlKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuZGVsZXRlKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZShcclxuICAgICAgICAgICAgJ2FjdGl2ZScsXHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLnNpemUgPT09IDAgJiYgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSAnc21hcnQnLFxyXG4gICAgICAgICk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmaWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZpbGVOYW1lO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZSA9IGRvY3VtZW50LnNvdXJjZVVybDtcclxuICAgIGVsZW1lbnQoJyNmb250LWhpbnQnKS50ZXh0Q29udGVudCA9IGRvY3VtZW50LmZvbnRzLmxlbmd0aFxyXG4gICAgICAgID8gYOajgOa1i+WIsO+8miR7ZG9jdW1lbnQuZm9udHMuam9pbign44CBJyl9YFxyXG4gICAgICAgIDogJ+W9k+WJjeaWh+S7tuWwmuacquWPkeeOsOWtl+S9k+OAgic7XHJcbiAgICByZW5kZXJGb250TWFwKCk7XHJcbiAgICByZW5kZXJUcmVlKHRydWUpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBseVNldHRpbmdzKHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncyk6IHZvaWQge1xyXG4gICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUgPSBzZXR0aW5ncy5zb3VyY2VVcmw7XHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5hc3NldEZvbGRlcjtcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUgPSBzZXR0aW5ncy5wcmVmYWJGb2xkZXI7XHJcbiAgICBjb25zdCBsb2NhbFJlc291cmNlRm9sZGVycyA9IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzPy5sZW5ndGhcclxuICAgICAgICA/IHNldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJzXHJcbiAgICAgICAgOiBzZXR0aW5ncy5sb2NhbFJlc291cmNlRm9sZGVyXHJcbiAgICAgICAgICAgID8gW3NldHRpbmdzLmxvY2FsUmVzb3VyY2VGb2xkZXJdXHJcbiAgICAgICAgICAgIDogW107XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgIGlucHV0LnZhbHVlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgICAgIGlucHV0LnRpdGxlID0gbG9jYWxSZXNvdXJjZUZvbGRlcnNbaW5kZXhdID8/ICcnO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWUgPSBTdHJpbmcoc2V0dGluZ3Muc2NhbGUpO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQgPSBzZXR0aW5ncy51cGRhdGVFeGlzdGluZztcclxuICAgIGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSBzZXR0aW5ncy5yZWZyZXNoQXNzZXRzO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQgPSBzZXR0aW5ncy5hdXRvU2F2ZTtcclxuICAgIHVwZGF0ZVRhcmdldEhpbnQoKTtcclxuICAgIHJlbmRlckZvbnRNYXAoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVhZFNldHRpbmdzKHNob3dFcnJvciA9IHRydWUpOiBJbXBvcnRTZXR0aW5ncyB8IG51bGwge1xyXG4gICAgY29uc3QgZm9udE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uc3RhdGUuc2V0dGluZ3MuZm9udE1hcCB9O1xyXG4gICAgaWYgKHN0YXRlLmRvY3VtZW50KSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBmYW1pbHkgb2Ygc3RhdGUuZG9jdW1lbnQuZm9udHMpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGZvbnRNYXBbZmFtaWx5XTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGZhbWlseSA9IHNlbGVjdC5kYXRhc2V0LmZvbnRGYW1pbHk/LnRyaW0oKTtcclxuICAgICAgICBpZiAoZmFtaWx5ICYmIHNlbGVjdC52YWx1ZSkge1xyXG4gICAgICAgICAgICBmb250TWFwW2ZhbWlseV0gPSBzZWxlY3QudmFsdWU7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBjb25zdCBzY2FsZSA9IE51bWJlcihlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc2NhbGUnKS52YWx1ZSk7XHJcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShzY2FsZSkgfHwgc2NhbGUgPCAwLjI1IHx8IHNjYWxlID4gNCkge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCflr7zlhaXlgI3njoflv4XpobvlnKggMC4yNSDliLAgNCDkuYvpl7TjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICBjb25zdCBhc3NldEZvbGRlciA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNhc3NldC1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIWFzc2V0Rm9sZGVyKSB7XHJcbiAgICAgICAgaWYgKHNob3dFcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+mAieaLqemhueebriBhc3NldHMg5LiL55qE6LWE5rqQ6L6T5Ye655uu5b2V44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcHJlZmFiRm9sZGVyID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XHJcbiAgICBpZiAoIXByZWZhYkZvbGRlcikge1xyXG4gICAgICAgIGlmIChzaG93RXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fpgInmi6npooTliLbkvZPovpPlh7rnm67lvZXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICAgIHNvdXJjZVVybDogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCksXHJcbiAgICAgICAgYXNzZXRGb2xkZXIsXHJcbiAgICAgICAgcHJlZmFiRm9sZGVyLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXJzOiBBcnJheS5mcm9tKHsgbGVuZ3RoOiAzIH0sIChfLCBpbmRleCkgPT5cclxuICAgICAgICAgICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICApLFxyXG4gICAgICAgIGxvY2FsUmVzb3VyY2VGb2xkZXI6IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNsb2NhbC1yZXNvdXJjZS1mb2xkZXItMCcpLnZhbHVlLnRyaW0oKSxcclxuICAgICAgICBzY2FsZSxcclxuICAgICAgICB1cGRhdGVFeGlzdGluZzogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3VwZGF0ZS1leGlzdGluZycpLmNoZWNrZWQsXHJcbiAgICAgICAgcmVmcmVzaEFzc2V0czogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3JlZnJlc2gtYXNzZXRzJykuY2hlY2tlZCxcclxuICAgICAgICBhdXRvU2F2ZTogZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI2F1dG8tc2F2ZScpLmNoZWNrZWQsXHJcbiAgICAgICAgZm9udE1hcCxcclxuICAgIH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldEJ1c3kodmFsdWU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIHN0YXRlLmJ1c3kgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNzYXZlLXRva2VuJykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcGljay1hc3NldC1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNwaWNrLXByZWZhYi1mb2xkZXInKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtZGV0ZWN0JykuZGlzYWJsZWQgPSB2YWx1ZTtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXByZXZpZXcnKS5kaXNhYmxlZCA9IHZhbHVlXHJcbiAgICAgICAgfHwgZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlID09PSAnJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLXBhaXInKS5kaXNhYmxlZCA9IHZhbHVlIHx8ICFyb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1hcHBseScpLmRpc2FibGVkID0gdmFsdWUgfHwgIXJvdW5kdHJpcFByZXZpZXdUb2tlbjtcclxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCAzOyBpbmRleCArPSAxKSB7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmRpc2FibGVkID0gdmFsdWU7XHJcbiAgICAgICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oYCNjbGVhci1sb2NhbC1yZXNvdXJjZS1mb2xkZXItJHtpbmRleH1gKS5kaXNhYmxlZCA9IHZhbHVlO1xyXG4gICAgfVxyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJykuZGlzYWJsZWQgPSB2YWx1ZVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZTtcclxuICAgIGVsZW1lbnQoJyNjYW5jZWwtaW1wb3J0JykuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaGlkZGVuJywgIXZhbHVlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTogdm9pZCB7XHJcbiAgICByb3VuZHRyaXBQcmV2aWV3VG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSB1bmRlZmluZWQ7XHJcbiAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wYWlyJykuZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtYXBwbHknKS5kaXNhYmxlZCA9IHRydWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJvdW5kdHJpcFNvdXJjZSgpOiBzdHJpbmcgfCBudWxsIHtcclxuICAgIGNvbnN0IHNvdXJjZSA9IGVsZW1lbnQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykudmFsdWUudHJpbSgpO1xyXG4gICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+ivt+i+k+WFpSBGaWdtYSDmlofku7bmiJboioLngrnpk77mjqXjgIInLCB0cnVlKTtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIHJldHVybiBzb3VyY2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlclJvdW5kdHJpcFByZXZpZXcocHJldmlldzogUm91bmR0cmlwUHJldmlld0R0byk6IHZvaWQge1xyXG4gICAgcm91bmR0cmlwUHJldmlld1Rva2VuID0gcHJldmlldy5wcmV2aWV3VG9rZW47XHJcbiAgICByb3VuZHRyaXBQYWlyVG9rZW4gPSBwcmV2aWV3LnBhaXJUb2tlbjtcclxuICAgIGNvbnN0IGxpbmVzID0gW1xyXG4gICAgICAgIGDnm67moIfvvJoke3ByZXZpZXcuYXNzZXRVcmx9YCxcclxuICAgICAgICBgUHJlZmFi77yaJHtwcmV2aWV3LnByZWZhYlV1aWR9YCxcclxuICAgICAgICBgU3VyZmFjZe+8miR7cHJldmlldy5zdXJmYWNlSWR9IMK3IEZpZ21hICR7cHJldmlldy5maWdtYVZlcnNpb259IMK3IExlZGdlciAke3ByZXZpZXcubGVkZ2VyR2VuZXJhdGlvbn1gLFxyXG4gICAgICAgIGDlsIbkv67mlLkgJHtwcmV2aWV3LnBsYW4uYXBwbHkubGVuZ3RofSDpobkgwrcg5L+d55WZIENvY29zICR7cHJldmlldy5wbGFuLnByZXNlcnZlQ29jb3MubGVuZ3RofSDpobkgwrcg5bey5pS25pWbICR7cHJldmlldy5wbGFuLmNvbnZlcmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgYOWGsueqgSAke3ByZXZpZXcucGxhbi5jb25mbGljdHMubGVuZ3RofSDpobkgwrcg5LiN5pSv5oyBICR7cHJldmlldy5wbGFuLnVuc3VwcG9ydGVkLmxlbmd0aH0g6aG5IMK3IOWPquivu+acquaUuSAke3ByZXZpZXcucGxhbi5yZWFkb25seVVuY2hhbmdlZC5sZW5ndGh9IOmhuWAsXHJcbiAgICAgICAgcHJldmlldy5wYWlyUmVxdWlyZWRcclxuICAgICAgICAgICAgPyBwcmV2aWV3LnBhaXJFbGlnaWJsZSA/ICfpppbmrKHkvb/nlKjvvJror4Hmja7kuIDoh7TvvIzor7flhYjnoa7orqTphY3lr7kgU3VyZmFjZe+8iOWPquWGmSBsZWRnZXLvvIzkuI3mlLkgUHJlZmFi77yJ44CCJyA6ICfpppbmrKHkvb/nlKjvvJpQYWlyIOivgeaNruS4jeS4gOiHtO+8jOmcgOS7juW9k+WJjSBQcmVmYWIg6YeN5paw5a+85Ye644CCJ1xyXG4gICAgICAgICAgICA6IHByZXZpZXcuYmxvY2tlcnMubGVuZ3RoID8gYOmYu+aWre+8miR7cHJldmlldy5ibG9ja2Vycy5qb2luKCcsICcpfWAgOiAn6aKE6KeI6YCa6L+H77yM5Y+v5Y6f5a2Q5bqU55So5pW05Liq5LiN5Y+v5Y+Y6K6h5YiS44CCJyxcclxuICAgIF07XHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xyXG4gICAgZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyb3VuZHRyaXAtcGFpcicpLmRpc2FibGVkID0gIXJvdW5kdHJpcFBhaXJUb2tlbjtcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcm91bmR0cmlwLWFwcGx5JykuZGlzYWJsZWQgPSAhcm91bmR0cmlwUHJldmlld1Rva2VuO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVUYXJnZXRIaW50KCk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgIGVsZW1lbnQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOmcgOimgeWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9yJztcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlvZPliY3lnLrmma8gQ2FudmFzIOagueiKgueCueS4i++8m0ZyYW1lIOmTvuaOpeWwhuiHquWKqOWIm+W7uuW5tuaJk+W8gOmihOWItuS9kyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc2V0SW1wb3J0QnV0dG9uKCk6IHZvaWQge1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBidXR0b24uY2xhc3NMaXN0LnJlbW92ZSgnaXMtcnVubmluZycsICdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWJ1c3knKTtcclxuICAgIGJ1dHRvbi50aXRsZSA9ICflr7zlhaXliLDlvZPliY3miZPlvIDlnLrmma/miJbpooTliLbkvZMnO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tbGFiZWwnKS50ZXh0Q29udGVudCA9ICflr7zlhaXliLDlnLrmma8nO1xyXG4gICAgZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcGVyY2VudCcpLnRleHRDb250ZW50ID0gJ+KGkic7XHJcbiAgICAoZWxlbWVudCgnI2ltcG9ydC1idXR0b24tcHJvZ3Jlc3MnKSBhcyBIVE1MRWxlbWVudCkuc3R5bGUud2lkdGggPSAnMCUnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbXBvcnRQcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IG51bWJlciB7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnKSB7XHJcbiAgICAgICAgcmV0dXJuIDAuMDUgKyB2YWx1ZSAqIDAuNTU7XHJcbiAgICB9XHJcbiAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdzY2VuZScpIHtcclxuICAgICAgICByZXR1cm4gMC42ICsgdmFsdWUgKiAwLjM4O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGV2ZW50LnBoYXNlID09PSAnZG9uZScgPyAxIDogMDtcclxufVxyXG5cclxuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHJlZ2lvbiA9IGVsZW1lbnQoJyNwcm9ncmVzcy1yZWdpb24nKTtcclxuICAgIGNvbnN0IGJ1c3kgPSBbJ2ZldGNoJywgJ2Fzc2V0cycsICdzY2VuZSddLmluY2x1ZGVzKGV2ZW50LnBoYXNlKTtcclxuICAgIHJlZ2lvbi5jbGFzc0xpc3QudG9nZ2xlKCdpcy1idXN5JywgYnVzeSk7XHJcbiAgICByZWdpb24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtZXJyb3InLCBldmVudC5waGFzZSA9PT0gJ2Vycm9yJyk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtbGFiZWwnKS50ZXh0Q29udGVudCA9IGV2ZW50Lm1lc3NhZ2U7XHJcbiAgICBjb25zdCB2YWx1ZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIGV2ZW50LnZhbHVlKSk7XHJcbiAgICBlbGVtZW50KCcjcHJvZ3Jlc3MtcGVyY2VudCcpLnRleHRDb250ZW50ID0gYCR7TWF0aC5yb3VuZCh2YWx1ZSAqIDEwMCl9JWA7XHJcbiAgICAoZWxlbWVudCgnI3Byb2dyZXNzLWJhcicpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3ZhbHVlICogMTAwfSVgO1xyXG4gICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICBjb25zdCBpbXBvcnRpbmcgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgfHwgZXZlbnQucGhhc2UgPT09ICdzY2VuZSc7XHJcbiAgICBpZiAoaW1wb3J0QnV0dG9uUmVzZXRUaW1lcikge1xyXG4gICAgICAgIGNsZWFyVGltZW91dChpbXBvcnRCdXR0b25SZXNldFRpbWVyKTtcclxuICAgICAgICBpbXBvcnRCdXR0b25SZXNldFRpbWVyID0gbnVsbDtcclxuICAgIH1cclxuICAgIGlmIChpbXBvcnRpbmcpIHtcclxuICAgICAgICBjb25zdCBwcm9ncmVzcyA9IGltcG9ydFByb2dyZXNzKGV2ZW50KTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtcnVubmluZycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdpcy1zdWNjZXNzJywgJ2lzLWVycm9yJyk7XHJcbiAgICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZSgnYXJpYS1idXN5JywgJ3RydWUnKTtcclxuICAgICAgICBidXR0b24udGl0bGUgPSBldmVudC5tZXNzYWdlO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2Fzc2V0cycgPyAn5YeG5aSH6LWE5rqQJyA6ICfmnoTlu7roioLngrknO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9IGAke01hdGgucm91bmQocHJvZ3Jlc3MgKiAxMDApfSVgO1xyXG4gICAgICAgIChlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wcm9ncmVzcycpIGFzIEhUTUxFbGVtZW50KS5zdHlsZS53aWR0aCA9IGAke3Byb2dyZXNzICogMTAwfSVgO1xyXG4gICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2RvbmUnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtZXJyb3InKTtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn5a+85YWl5a6M5oiQJztcclxuICAgICAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbi1wZXJjZW50JykudGV4dENvbnRlbnQgPSAnMTAwJSc7XHJcbiAgICAgICAgKGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXByb2dyZXNzJykgYXMgSFRNTEVsZW1lbnQpLnN0eWxlLndpZHRoID0gJzEwMCUnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxNDAwKTtcclxuICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicgfHwgZXZlbnQucGhhc2UgPT09ICdjYW5jZWxsZWQnKSB7XHJcbiAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2lzLXJ1bm5pbmcnLCAnaXMtc3VjY2VzcycpO1xyXG4gICAgICAgIGJ1dHRvbi5jbGFzc0xpc3QuYWRkKCdpcy1lcnJvcicpO1xyXG4gICAgICAgIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoJ2FyaWEtYnVzeScpO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSBldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcgPyAn5bey5Y+W5raIJyA6ICflr7zlhaXlpLHotKUnO1xyXG4gICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfph43or5UnO1xyXG4gICAgICAgIGltcG9ydEJ1dHRvblJlc2V0VGltZXIgPSBzZXRUaW1lb3V0KHJlc2V0SW1wb3J0QnV0dG9uLCAxODAwKTtcclxuICAgIH1cclxuICAgIGlmIChbJ2RvbmUnLCAnZXJyb3InLCAnY2FuY2VsbGVkJywgJ2lkbGUnXS5pbmNsdWRlcyhldmVudC5waGFzZSkpIHtcclxuICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZGVzY2VuZGFudHMobm9kZTogVHJlZU5vZGVEdG8pOiBUcmVlTm9kZUR0b1tdIHtcclxuICAgIHJldHVybiBub2RlLmNoaWxkcmVuLmZsYXRNYXAoKGNoaWxkKSA9PiBbY2hpbGQsIC4uLmRlc2NlbmRhbnRzKGNoaWxkKV0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZWNvbmNpbGVBY3Rpb25zKCk6IHZvaWQge1xyXG4gICAgY29uc3QgZWZmZWN0aXZlID0gcmVzb2x2ZUVmZmVjdGl2ZUFjdGlvbnMoXHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQ/LnRyZWUgPz8gW10sXHJcbiAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucyxcclxuICAgICAgICBzdGF0ZS5wYXRjaGVzLFxyXG4gICAgKTtcclxuICAgIHN0YXRlLmFjdGlvbnMgPSBlZmZlY3RpdmUuYWN0aW9ucztcclxuICAgIHN0YXRlLnN1cHByZXNzZWQgPSBlZmZlY3RpdmUuc3VwcHJlc3NlZDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0QWN0aW9uKG5vZGU6IFRyZWVOb2RlRHRvLCBhY3Rpb246IEltcG9ydEFjdGlvbik6IHZvaWQge1xyXG4gICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgc2FmZUFjdGlvbihub2RlLCBhY3Rpb24pKTtcclxuICAgIHJlY29uY2lsZUFjdGlvbnMoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZWZmZWN0aXZlTm9kZU5hbWUobm9kZTogVHJlZU5vZGVEdG8pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHN0YXRlLm5hbWVzLmdldChub2RlLmlkKSA/PyBub2RlLm5hbWU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4cGxpY2l0T3ZlcnJpZGVzKCk6IEltcG9ydE92ZXJyaWRlW10ge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpXHJcbiAgICAgICAgLmZpbHRlcigobm9kZSkgPT4gc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpKVxyXG4gICAgICAgIC5tYXAoKG5vZGUpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVuYW1lZCA9IHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgaWQ6IG5vZGUuaWQsXHJcbiAgICAgICAgICAgICAgICBhY3Rpb246IHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IHNtYXJ0QWN0aW9uRm9yTm9kZShub2RlKSxcclxuICAgICAgICAgICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgICAgICAgICBuaW5lU2xpY2U6IHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgICAgICAgICAgZXhwbGljaXQ6IHN0YXRlLmV4cGxpY2l0SWRzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICAgICAgICAgIC4uLihyZW5hbWVkID8geyBuYW1lOiBlZmZlY3RpdmVOb2RlTmFtZShub2RlKSB9IDoge30pLFxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwZXJzaXN0Tm9kZU92ZXJyaWRlcygpOiB2b2lkIHtcclxuICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlS2V5ID0gc3RhdGUuZG9jdW1lbnQuZmlsZUtleTtcclxuICAgIGNvbnN0IG92ZXJyaWRlcyA9IGV4cGxpY2l0T3ZlcnJpZGVzKCk7XHJcbiAgICBjb25zdCBzY29wZUlkcyA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSkubWFwKChub2RlKSA9PiBub2RlLmlkKTtcclxuICAgIC8vIFNlcmlhbGl6ZSB3cml0ZXMgc28gYSBzbG93ZXIgZWFybGllciByZXF1ZXN0IGNhbiBuZXZlciBvdmVyd3JpdGUgYSBuZXdlclxyXG4gICAgLy8gc3RyYXRlZ3kgc25hcHNob3QgYWZ0ZXIgcmFwaWQgc2VsZWN0IGNoYW5nZXMuXHJcbiAgICBub2RlT3ZlcnJpZGVTYXZlVGFzayA9IG5vZGVPdmVycmlkZVNhdmVUYXNrXHJcbiAgICAgICAgLmNhdGNoKCgpID0+IHVuZGVmaW5lZClcclxuICAgICAgICAudGhlbihhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGF3YWl0IHJlcXVlc3Q8SW1wb3J0T3ZlcnJpZGVbXT4oJ3NhdmUtbm9kZS1vdmVycmlkZXMnLCBmaWxlS2V5LCBvdmVycmlkZXMsIHNjb3BlSWRzKTtcclxuICAgICAgICB9KVxyXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+iKgueCueetlueVpeS/neWtmOWksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9KTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF0Y2hlcyhub2RlOiBUcmVlTm9kZUR0byk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKCFzdGF0ZS5zZWFyY2gpIHtcclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH1cclxuICAgIGNvbnN0IGhheXN0YWNrID0gYCR7ZWZmZWN0aXZlTm9kZU5hbWUobm9kZSl9ICR7bm9kZS5uYW1lfSAke25vZGUudHlwZX0gJHtub2RlLmlkfWAudG9Mb3dlckNhc2UoKTtcclxuICAgIGlmIChoYXlzdGFjay5pbmNsdWRlcyhzdGF0ZS5zZWFyY2gpKSB7XHJcbiAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbm9kZS5jaGlsZHJlbi5zb21lKG1hdGNoZXMpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvcHRpb24odmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEhUTUxPcHRpb25FbGVtZW50IHtcclxuICAgIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgIGl0ZW0udmFsdWUgPSB2YWx1ZTtcclxuICAgIGl0ZW0udGV4dENvbnRlbnQgPSBsYWJlbDtcclxuICAgIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG5mdW5jdGlvbiBtYWtlU2VsZWN0KFxyXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXHJcbiAgICB2YWx1ZTogc3RyaW5nLFxyXG4gICAgaXRlbXM6IEFycmF5PFtzdHJpbmcsIHN0cmluZ10+LFxyXG4gICAgbGFiZWw6IHN0cmluZyxcclxuKTogSFRNTFNlbGVjdEVsZW1lbnQge1xyXG4gICAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc2VsZWN0Jyk7XHJcbiAgICBzZWxlY3QuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xyXG4gICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGxhYmVsKTtcclxuICAgIGZvciAoY29uc3QgW2tleSwgdGV4dF0gb2YgaXRlbXMpIHtcclxuICAgICAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKGtleSwgdGV4dCkpO1xyXG4gICAgfVxyXG4gICAgc2VsZWN0LnZhbHVlID0gdmFsdWU7XHJcbiAgICByZXR1cm4gc2VsZWN0O1xyXG59XHJcblxyXG5mdW5jdGlvbiBhcHBlbmRUcmVlTm9kZShjb250YWluZXI6IEhUTUxFbGVtZW50LCBub2RlOiBUcmVlTm9kZUR0bywgZGVwdGg6IG51bWJlcik6IHZvaWQge1xyXG4gICAgaWYgKCFtYXRjaGVzKG5vZGUpKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICByb3cuY2xhc3NOYW1lID0gYHRyZWUtcm93JHtzdGF0ZS5zZWxlY3RlZElkID09PSBub2RlLmlkID8gJyBpcy1zZWxlY3RlZCcgOiAnJ31gO1xyXG4gICAgcm93LmRhdGFzZXQubm9kZUlkID0gbm9kZS5pZDtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ3JvbGUnLCAndHJlZWl0ZW0nKTtcclxuICAgIHJvdy5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGV2ZWwnLCBTdHJpbmcoZGVwdGggKyAxKSk7XHJcblxyXG4gICAgY29uc3QgbWFpbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWFpbi5jbGFzc05hbWUgPSAnbm9kZS1tYWluJztcclxuICAgIG1haW4uc3R5bGUuc2V0UHJvcGVydHkoJy0tZGVwdGgnLCBTdHJpbmcoZGVwdGgpKTtcclxuICAgIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7XHJcbiAgICBjb2xsYXBzZS5jbGFzc05hbWUgPSBgY29sbGFwc2Uke25vZGUuY2hpbGRyZW4ubGVuZ3RoID8gJycgOiAnIGlzLWxlYWYnfWA7XHJcbiAgICBjb2xsYXBzZS50eXBlID0gJ2J1dHRvbic7XHJcbiAgICBjb2xsYXBzZS5kYXRhc2V0LmNvbGxhcHNlID0gbm9kZS5pZDtcclxuICAgIGNvbGxhcHNlLnRleHRDb250ZW50ID0gc3RhdGUuY29sbGFwc2VkLmhhcyhub2RlLmlkKSA/ICfigLonIDogJ+KMhCc7XHJcbiAgICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpID8gJ+WxleW8gCcgOiAn5oqY5Y+gJyk7XHJcbiAgICBjb25zdCBkb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICBkb3QuY2xhc3NOYW1lID0gYHR5cGUtZG90ICR7XHJcbiAgICAgICAgbm9kZS50eXBlID09PSAnVEVYVCcgPyAndGV4dCdcclxuICAgICAgICAgICAgOiBpc1ZlY3Rvck5vZGVUeXBlKG5vZGUudHlwZSkgPyAndmVjdG9yJ1xyXG4gICAgICAgICAgICAgICAgOiBub2RlLnR5cGUuaW5jbHVkZXMoJ0NPTVBPTkVOVCcpIHx8IG5vZGUudHlwZSA9PT0gJ0lOU1RBTkNFJyA/ICdjb21wb25lbnQnXHJcbiAgICAgICAgICAgICAgICAgICAgOiAnJ1xyXG4gICAgfWA7XHJcbiAgICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICBjb3B5LmNsYXNzTmFtZSA9ICdub2RlLWNvcHknO1xyXG4gICAgY29uc3QgZGlzcGxheU5hbWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgbmFtZS50eXBlID0gJ3RleHQnO1xyXG4gICAgbmFtZS5jbGFzc05hbWUgPSBgbm9kZS1uYW1lLWlucHV0JHtzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/ICcgaXMtcmVuYW1lZCcgOiAnJ31gO1xyXG4gICAgbmFtZS52YWx1ZSA9IGRpc3BsYXlOYW1lO1xyXG4gICAgbmFtZS5tYXhMZW5ndGggPSA5NjtcclxuICAgIG5hbWUuc3BlbGxjaGVjayA9IGZhbHNlO1xyXG4gICAgbmFtZS5kYXRhc2V0Lm5hbWVGb3IgPSBub2RlLmlkO1xyXG4gICAgbmFtZS5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnLCBgJHtub2RlLm5hbWV9IOWvvOWFpeiKgueCueWQjWApO1xyXG4gICAgY29uc3Qgc3RyYXRlZ3lTdW1tYXJ5ID0gc3RyYXRlZ3lTdW1tYXJ5Rm9yTm9kZShub2RlLCBzdGF0ZS5leHBsaWNpdElkcy5oYXMobm9kZS5pZCkpO1xyXG4gICAgbmFtZS50aXRsZSA9IFtcclxuICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IGBGaWdtYSDljp/lkI3vvJoke25vZGUubmFtZX1gIDogJ+eCueWHu+S/ruaUueWvvOWFpeiKgueCueWQjScsXHJcbiAgICAgICAgc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5LFxyXG4gICAgICAgIHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nLFxyXG4gICAgXVxyXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcclxuICAgICAgICAuam9pbignIMK3ICcpO1xyXG4gICAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgbWV0YS5jbGFzc05hbWUgPSAnbm9kZS1tZXRhJztcclxuICAgIG1ldGEudGV4dENvbnRlbnQgPSBgJHtub2RlLnR5cGV9IMK3ICR7TWF0aC5yb3VuZChub2RlLndpZHRoKX3DlyR7TWF0aC5yb3VuZChub2RlLmhlaWdodCl9YDtcclxuICAgIGNvcHkuYXBwZW5kKG5hbWUsIG1ldGEpO1xyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSkge1xyXG4gICAgICAgIGNvbnN0IHN0cmF0ZWd5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XHJcbiAgICAgICAgc3RyYXRlZ3kuY2xhc3NOYW1lID0gJ25vZGUtc3RyYXRlZ3knO1xyXG4gICAgICAgIHN0cmF0ZWd5LnRleHRDb250ZW50ID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIHN0cmF0ZWd5LnRpdGxlID0gc3RyYXRlZ3lTdW1tYXJ5LnN0cmF0ZWd5O1xyXG4gICAgICAgIGNvcHkuYXBwZW5kQ2hpbGQoc3RyYXRlZ3kpO1xyXG4gICAgfVxyXG4gICAgaWYgKHN0cmF0ZWd5U3VtbWFyeS53YXJuaW5nKSB7XHJcbiAgICAgICAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xyXG4gICAgICAgIHdhcm5pbmcuY2xhc3NOYW1lID0gJ25vZGUtd2FybmluZyc7XHJcbiAgICAgICAgd2FybmluZy50ZXh0Q29udGVudCA9IGDimqAgJHtzdHJhdGVneVN1bW1hcnkud2FybmluZ31gO1xyXG4gICAgICAgIHdhcm5pbmcudGl0bGUgPSBzdHJhdGVneVN1bW1hcnkud2FybmluZztcclxuICAgICAgICBjb3B5LmFwcGVuZENoaWxkKHdhcm5pbmcpO1xyXG4gICAgfVxyXG4gICAgcm93LmNsYXNzTGlzdC50b2dnbGUoJ2hhcy1kZXRhaWwnLCBCb29sZWFuKHN0cmF0ZWd5U3VtbWFyeS5zdHJhdGVneSB8fCBzdHJhdGVneVN1bW1hcnkud2FybmluZykpO1xyXG4gICAgbWFpbi5hcHBlbmQoY29sbGFwc2UsIGRvdCwgY29weSk7XHJcblxyXG4gICAgY29uc3Qgc2VsZWN0ZWRBY3Rpb24gPSBzYWZlQWN0aW9uKG5vZGUsIHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uKTtcclxuICAgIGNvbnN0IGFjdGlvbk9wdGlvbnMgPSBhY3Rpb25PcHRpb25zRm9yTm9kZShub2RlKTtcclxuICAgIGNvbnN0IGFjdGlvbiA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2FjdGlvbi1zZWxlY3QnLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIGFjdGlvbk9wdGlvbnMsXHJcbiAgICAgICAgYCR7ZGlzcGxheU5hbWV9IOWvvOWFpeaWueW8j2AsXHJcbiAgICApO1xyXG4gICAgYWN0aW9uLmRhdGFzZXQuYWN0aW9uRm9yID0gbm9kZS5pZDtcclxuXHJcbiAgICBjb25zdCBzZWxlY3RlZEtpbmQgPSBzdGF0ZS5raW5kcy5nZXQobm9kZS5pZCkgPz8gbm9kZS5raW5kO1xyXG4gICAgY29uc3QgZWZmZWN0aXZlS2luZCA9IGVmZmVjdGl2ZUtpbmRGb3JOb2RlKFxyXG4gICAgICAgIG5vZGUsXHJcbiAgICAgICAgc2VsZWN0ZWRLaW5kLFxyXG4gICAgICAgIHNlbGVjdGVkQWN0aW9uLFxyXG4gICAgICAgIHN0YXRlLnBhdGNoZXMuaGFzKG5vZGUuaWQpLFxyXG4gICAgKTtcclxuICAgIGNvbnN0IGtpbmRPcHRpb25zID0ga2luZE9wdGlvbnNGb3JBY3Rpb24oc2VsZWN0ZWRBY3Rpb24pO1xyXG4gICAgY29uc3Qga2luZCA9IG1ha2VTZWxlY3QoXHJcbiAgICAgICAgJ2tpbmQtc2VsZWN0JyxcclxuICAgICAgICBlZmZlY3RpdmVLaW5kLFxyXG4gICAgICAgIGtpbmRPcHRpb25zLFxyXG4gICAgICAgIGAke2Rpc3BsYXlOYW1lfSDoioLngrnnsbvlnotgLFxyXG4gICAgKTtcclxuICAgIGtpbmQuZGF0YXNldC5raW5kRm9yID0gbm9kZS5pZDtcclxuXHJcbiAgICBjb25zdCBwYXRjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xhYmVsJyk7XHJcbiAgICBwYXRjaC5jbGFzc05hbWUgPSAncGF0Y2gtdG9nZ2xlJztcclxuICAgIHBhdGNoLnRpdGxlID0gbm9kZS5zbGljZU1vZGVcclxuICAgICAgICA/IGDlkK/nlKgke25vZGUuc2xpY2VNb2RlID09PSAnbmluZScgPyAn5Lmd5a6r5qC8JyA6ICfkuInlrqvmoLwnfeWIh+eJh2BcclxuICAgICAgICA6IG5vZGUucGF0Y2hDYW5kaWRhdGVcclxuICAgICAgICAgICAgPyAn5ZCv55So6Ieq5Yqo6K+G5Yir55qE5LiJL+S5neWuq+agvOWIh+eJhydcclxuICAgICAgICAgICAgOiAn6K+l6IqC54K55LiN5piv6Ieq5Yqo6K+G5Yir55qE5YiH54mH5YCZ6YCJJztcclxuICAgIGNvbnN0IHBhdGNoSW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgcGF0Y2hJbnB1dC50eXBlID0gJ2NoZWNrYm94JztcclxuICAgIHBhdGNoSW5wdXQuZGF0YXNldC5wYXRjaEZvciA9IG5vZGUuaWQ7XHJcbiAgICBwYXRjaElucHV0LmNoZWNrZWQgPSBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKTtcclxuICAgIHBhdGNoSW5wdXQuZGlzYWJsZWQgPSAhbm9kZS5wYXRjaENhbmRpZGF0ZTtcclxuICAgIGNvbnN0IHBhdGNoSWNvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTtcclxuICAgIHBhdGNoSWNvbi50ZXh0Q29udGVudCA9ICfilqYnO1xyXG4gICAgcGF0Y2guYXBwZW5kKHBhdGNoSW5wdXQsIHBhdGNoSWNvbik7XHJcbiAgICByb3cuYXBwZW5kKG1haW4sIGFjdGlvbiwga2luZCwgcGF0Y2gpO1xyXG4gICAgY29udGFpbmVyLmFwcGVuZENoaWxkKHJvdyk7XHJcblxyXG4gICAgaWYgKCFzdGF0ZS5jb2xsYXBzZWQuaGFzKG5vZGUuaWQpIHx8IHN0YXRlLnNlYXJjaCkge1xyXG4gICAgICAgIG5vZGUuY2hpbGRyZW4uZm9yRWFjaCgoY2hpbGQpID0+IGFwcGVuZFRyZWVOb2RlKGNvbnRhaW5lciwgY2hpbGQsIGRlcHRoICsgMSkpO1xyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJUcmVlKHJlc2V0U2Nyb2xsID0gZmFsc2UpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRyZWUgPSBlbGVtZW50KCcjdHJlZScpO1xyXG4gICAgcmVyZW5kZXJQcmVzZXJ2aW5nU2Nyb2xsKHRyZWUsICgpID0+IHtcclxuICAgICAgICB0cmVlLnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgIGlmICghc3RhdGUuZG9jdW1lbnQpIHtcclxuICAgICAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcclxuICAgICAgICAgICAgZW1wdHkuY2xhc3NOYW1lID0gJ2VtcHR5LXN0YXRlJztcclxuICAgICAgICAgICAgY29uc3QgZ2x5cGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XHJcbiAgICAgICAgICAgIGdseXBoLmNsYXNzTmFtZSA9ICdlbXB0eS1nbHlwaCc7XHJcbiAgICAgICAgICAgIGdseXBoLnRleHRDb250ZW50ID0gJ+KGsyc7XHJcbiAgICAgICAgICAgIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3Ryb25nJyk7XHJcbiAgICAgICAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gJ+i/mOayoeacieiKgueCuSc7XHJcbiAgICAgICAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdwJyk7XHJcbiAgICAgICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSAn6K+75Y+WIEZpZ21hIOmTvuaOpeWQju+8jOWPr+mAkOWxgumAieaLqeeUn+aIkOOAgVBORyDmlbTlsYLmiJbmm7TmlrDjgIInO1xyXG4gICAgICAgICAgICBlbXB0eS5hcHBlbmQoZ2x5cGgsIHRpdGxlLCBib2R5KTtcclxuICAgICAgICAgICAgdHJlZS5hcHBlbmRDaGlsZChlbXB0eSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc3RhdGUuZG9jdW1lbnQudHJlZS5mb3JFYWNoKChub2RlKSA9PiBhcHBlbmRUcmVlTm9kZSh0cmVlLCBub2RlLCAwKSk7XHJcbiAgICB9LCByZXNldFNjcm9sbCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoKTogdm9pZCB7XHJcbiAgICBjb25zdCBub2RlcyA9IHN0YXRlLmRvY3VtZW50ID8gZmxhdHRlbihzdGF0ZS5kb2N1bWVudC50cmVlKSA6IFtdO1xyXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBub2Rlcy5maWx0ZXIoKG5vZGUpID0+IHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpICE9PSAnaWdub3JlJyk7XHJcbiAgICBlbGVtZW50KCcjbm9kZS1jb3VudCcpLnRleHRDb250ZW50ID0gYCR7bm9kZXMubGVuZ3RofSDoioLngrlgO1xyXG4gICAgZWxlbWVudCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgID8gYCR7c2VsZWN0ZWQubGVuZ3RofSAvICR7bm9kZXMubGVuZ3RofSDkuKroioLngrnlsIblj4LkuI7lr7zlhaVgXHJcbiAgICAgICAgOiAn562J5b6F6K6+6K6h5pWw5o2uJztcclxuICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjaW1wb3J0LWJ1dHRvbicpLmRpc2FibGVkID0gc3RhdGUuYnVzeVxyXG4gICAgICAgIHx8ICFzdGF0ZS5kb2N1bWVudFxyXG4gICAgICAgIHx8ICFzZWxlY3RlZC5sZW5ndGhcclxuICAgICAgICB8fCAhc3RhdGUucnVudGltZUNvbXBhdGlibGU7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHByZXZpZXcobm9kZTogVHJlZU5vZGVEdG8pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmIChzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgc3RhdGUuc2VsZWN0ZWRJZCA9IG5vZGUuaWQ7XHJcbiAgICByZW5kZXJUcmVlKCk7XHJcbiAgICBlbGVtZW50KCcjcHJldmlldy1tZXRhJykudGV4dENvbnRlbnQgPSBgJHtlZmZlY3RpdmVOb2RlTmFtZShub2RlKX0gwrcgJHtNYXRoLnJvdW5kKG5vZGUud2lkdGgpfcOXJHtNYXRoLnJvdW5kKG5vZGUuaGVpZ2h0KX1gO1xyXG4gICAgY29uc3Qgc3RhZ2UgPSBlbGVtZW50KCcjcHJldmlldy1zdGFnZScpO1xyXG4gICAgY29uc3QgaW1hZ2UgPSBlbGVtZW50PEhUTUxJbWFnZUVsZW1lbnQ+KCcjcHJldmlldy1pbWFnZScpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LmFkZCgnaXMtbG9hZGluZycpO1xyXG4gICAgc3RhZ2UuY2xhc3NMaXN0LnJlbW92ZSgnaGFzLWltYWdlJyk7XHJcbiAgICBpbWFnZS5yZW1vdmVBdHRyaWJ1dGUoJ3NyYycpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgdXJsOiBzdHJpbmcgfT4oJ2dldC1wcmV2aWV3Jywgbm9kZS5pZCk7XHJcbiAgICAgICAgaWYgKHN0YXRlLnNlbGVjdGVkSWQgIT09IG5vZGUuaWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgICAgICAgIGltYWdlLm9ubG9hZCA9ICgpID0+IHJlc29sdmUoKTtcclxuICAgICAgICAgICAgaW1hZ2Uub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoJ+mihOiniOWbvueJh+WKoOi9veWksei0peOAgicpKTtcclxuICAgICAgICAgICAgaW1hZ2Uuc3JjID0gcmVzdWx0LnVybDtcclxuICAgICAgICB9KTtcclxuICAgICAgICBzdGFnZS5jbGFzc0xpc3QuYWRkKCdoYXMtaW1hZ2UnKTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mihOiniOWksei0peOAgicsIHRydWUpO1xyXG4gICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBzdGFnZS5jbGFzc0xpc3QucmVtb3ZlKCdpcy1sb2FkaW5nJyk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGFwcGx5UHJlc2V0KG5hbWU6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IGFsbCA9IGZsYXR0ZW4oc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICBpZiAobmFtZSA9PT0gJ3NtYXJ0Jykge1xyXG4gICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmNsZWFyKCk7XHJcbiAgICAgICAgc3RhdGUucGF0Y2hlcyA9IGRlZmF1bHROaW5lU2xpY2VJZHMoc3RhdGUuZG9jdW1lbnQudHJlZSk7XHJcbiAgICAgICAgZm9yIChjb25zdCBub2RlIG9mIGFsbCkge1xyXG4gICAgICAgICAgICBjb25zdCBvcmlnaW5hbCA9IHN0YXRlLmRlZmF1bHRzLmdldChub2RlLmlkKSE7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIG9yaWdpbmFsLmFjdGlvbik7XHJcbiAgICAgICAgICAgIHN0YXRlLmtpbmRzLnNldChub2RlLmlkLCBvcmlnaW5hbC5raW5kKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2UgaWYgKG5hbWUgPT09ICdlZGl0YWJsZScpIHtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgYWxsKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLnByZWZlcnJlZEFjdGlvbnMuc2V0KG5vZGUuaWQsIGlzVmVjdG9yTm9kZVR5cGUobm9kZS50eXBlKSA/ICdyZW5kZXInIDogJ2dlbmVyYXRlJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGZvciAoY29uc3Qgbm9kZSBvZiBhbGwpIHtcclxuICAgICAgICAgICAgc3RhdGUucHJlZmVycmVkQWN0aW9ucy5zZXQobm9kZS5pZCwgbm9kZS5jaGlsZHJlbi5sZW5ndGhcclxuICAgICAgICAgICAgICAgID8gJ2dlbmVyYXRlJ1xyXG4gICAgICAgICAgICAgICAgOiAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgYnV0dG9uLmRhdGFzZXQucHJlc2V0ID09PSBuYW1lKTtcclxuICAgIH0pO1xyXG4gICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxufVxyXG5cclxuYXN5bmMgZnVuY3Rpb24gaW1wb3J0VG9TY2VuZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICBzaG93VG9hc3QoJ+aJqeWxleS4u+i/m+eoi+S7jeaYr+aXp+eJiO+8jOivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKCFzdGF0ZS5kb2N1bWVudCB8fCBzdGF0ZS5idXN5KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoKTtcclxuICAgIGlmICghc2V0dGluZ3MpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBvdmVycmlkZXM6IEltcG9ydE92ZXJyaWRlW10gPSBmbGF0dGVuKHN0YXRlLmRvY3VtZW50LnRyZWUpLm1hcCgobm9kZSkgPT4gKHtcclxuICAgICAgICBpZDogbm9kZS5pZCxcclxuICAgICAgICBhY3Rpb246IHN0YXRlLmFjdGlvbnMuZ2V0KG5vZGUuaWQpID8/IG5vZGUuYWN0aW9uLFxyXG4gICAgICAgIGtpbmQ6IHN0YXRlLmtpbmRzLmdldChub2RlLmlkKSA/PyBub2RlLmtpbmQsXHJcbiAgICAgICAgbmluZVNsaWNlOiBzdGF0ZS5wYXRjaGVzLmhhcyhub2RlLmlkKSxcclxuICAgICAgICBleHBsaWNpdDogc3RhdGUuZXhwbGljaXRJZHMuaGFzKG5vZGUuaWQpLFxyXG4gICAgICAgIC4uLihzdGF0ZS5yZW5hbWVkSWRzLmhhcyhub2RlLmlkKSA/IHsgbmFtZTogZWZmZWN0aXZlTm9kZU5hbWUobm9kZSkgfSA6IHt9KSxcclxuICAgIH0pKTtcclxuICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnYXNzZXRzJywgdmFsdWU6IDAsIG1lc3NhZ2U6ICfmraPlnKjlh4blpIflr7zlhaXigKYnIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgcHJlZmFiVXJsPzogc3RyaW5nOyB3YXJuaW5ncz86IHN0cmluZ1tdOyByZXZpZXc/OiBJbXBvcnRSZXZpZXcgfT4oXHJcbiAgICAgICAgICAgICdpbXBvcnQtc2VsZWN0aW9uJyxcclxuICAgICAgICAgICAgeyBvdmVycmlkZXMsIHNldHRpbmdzIH0sXHJcbiAgICAgICAgKTtcclxuICAgICAgICBjb25zdCBmYWxsYmFja05vdGUgPSByZXN1bHQ/Lndhcm5pbmdzPy5sZW5ndGhcclxuICAgICAgICAgICAgPyBg77ybJHtyZXN1bHQud2FybmluZ3MubGVuZ3RofSDkuKrkuIkv5Lmd5a6r5bey5Li05pe25L2c5Li6IFBORyDmlbTlsYLlr7zlhaVgXHJcbiAgICAgICAgICAgIDogJyc7XHJcbiAgICAgICAgc2hvd1RvYXN0KHJlc3VsdD8ucHJlZmFiVXJsXHJcbiAgICAgICAgICAgID8gYOWvvOWFpeWujOaIkO+8jOW3suWIm+W7uumihOWItuS9k++8miR7cmVzdWx0LnByZWZhYlVybH0ke2ZhbGxiYWNrTm90ZX1gXHJcbiAgICAgICAgICAgIDogYOWvvOWFpeWujOaIkO+8jOW3suWcqOWcuuaZr+S4remAieS4reagueiKgueCuSR7ZmFsbGJhY2tOb3RlfeOAgmApO1xyXG4gICAgICAgIGlmIChyZXN1bHQucmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXN1bHQucmV2aWV3KTtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZShlcnJvciwgJ+WvvOWFpeWksei0peOAgicpO1xyXG4gICAgICAgIHVwZGF0ZVByb2dyZXNzKHsgcGhhc2U6ICdlcnJvcicsIHZhbHVlOiAwLCBtZXNzYWdlIH0pO1xyXG4gICAgICAgIHNob3dUb2FzdChtZXNzYWdlLCB0cnVlKTtcclxuICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMoKTogdm9pZCB7XHJcbiAgICBlbGVtZW50KCcjb3Blbi1pbXBvcnQtcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKHN0YXRlLmJ1c3kpIHJldHVybjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXZpZXcgPSBhd2FpdCByZXF1ZXN0PEltcG9ydFJldmlldyB8IG51bGw+KCdnZXQtaW1wb3J0LXJldmlldycpO1xyXG4gICAgICAgICAgICBpZiAocmV2aWV3KSBpbXBvcnRSZXZpZXdQYW5lbD8ub3BlbihyZXZpZXcpO1xyXG4gICAgICAgICAgICBlbHNlIHNob3dUb2FzdCgn5pys5qyh5o+S5Lu25Lya6K+d5bCa5peg5a+85YWl5qOA5p+l57uT5p6c77yM6K+35YWI5a6M5oiQ5LiA5qyh5a+85YWl44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHsgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ+ivu+WPluajgOafpee7k+aenOWksei0peOAgicpLCB0cnVlKTsgfVxyXG4gICAgfSk7XHJcbiAgICBlbGVtZW50KCcjc2F2ZS10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3Rva2VuLWlucHV0Jyk7XHJcbiAgICAgICAgaWYgKCFpbnB1dC52YWx1ZS50cmltKCkpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEgVG9rZW7jgIInLCB0cnVlKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdzZXQtdG9rZW4nLCBpbnB1dC52YWx1ZSk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gJyc7XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QodmF1bHQucGVyc2lzdGVudCA/ICdUb2tlbiDlt7LnlLHns7vnu5/liqDlr4bkv53lrZjjgIInIDogJ1Rva2VuIOW3suS/neWtmOWIsOacrOasoeS8muivneOAgicpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfkv53lrZjlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdmVyaWZ5LXRva2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXF1ZXN0PHsgaGFuZGxlOiBzdHJpbmcgfT4oJ3ZlcmlmeS10b2tlbicpO1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi/nuaOpeaIkOWKnyDCtyAke3Jlc3VsdC5oYW5kbGV9YCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+i/nuaOpeWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNjbGVhci10b2tlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHZhdWx0ID0gYXdhaXQgcmVxdWVzdDxhbnk+KCdjbGVhci10b2tlbicpO1xyXG4gICAgICAgIHNldENvbm5lY3Rpb24odmF1bHQpO1xyXG4gICAgICAgIHNob3dUb2FzdCgn5bey5riF6Zmk5L+d5a2Y55qEIEZpZ21hIOWHreaNruOAgicpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1kZXRlY3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBzb3VyY2UgPSByb3VuZHRyaXBTb3VyY2UoKTtcclxuICAgICAgICBpZiAoIXNvdXJjZSkgcmV0dXJuO1xyXG4gICAgICAgIHJlc2V0Um91bmR0cmlwVG9rZW5zKCk7XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBkZXRlY3RlZCA9IGF3YWl0IHJlcXVlc3Q8Um91bmR0cmlwRGV0ZWN0RHRvPigncm91bmR0cmlwLWRldGVjdCcsIHNvdXJjZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdCA9IGVsZW1lbnQ8SFRNTFNlbGVjdEVsZW1lbnQ+KCcjcm91bmR0cmlwLXJvb3QnKTtcclxuICAgICAgICAgICAgc2VsZWN0LnJlcGxhY2VDaGlsZHJlbigpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHJvb3Qgb2YgZGV0ZWN0ZWQubWFuYWdlZFJvb3RzKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTtcclxuICAgICAgICAgICAgICAgIG9wdGlvbi52YWx1ZSA9IHJvb3Qubm9kZUlkO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLnRleHRDb250ZW50ID0gcm9vdC5lcnJvclxyXG4gICAgICAgICAgICAgICAgICAgID8gYCR7cm9vdC5uYW1lfSDCtyDljY/orq7mjZ/lnY9gXHJcbiAgICAgICAgICAgICAgICAgICAgOiBgJHtyb290Lm5hbWV9IMK3ICR7cm9vdC5wcmVmYWJVdWlkID8/ICfmnKrnn6UgUHJlZmFiJ31gO1xyXG4gICAgICAgICAgICAgICAgb3B0aW9uLmRpc2FibGVkID0gQm9vbGVhbihyb290LmVycm9yKTtcclxuICAgICAgICAgICAgICAgIHNlbGVjdC5hcHBlbmQob3B0aW9uKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxlY3QudmFsdWUgPSBkZXRlY3RlZC5zZWxlY3RlZFJvb3RJZFxyXG4gICAgICAgICAgICAgICAgPz8gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmZpbmQoKHJvb3QpID0+ICFyb290LmVycm9yKT8ubm9kZUlkXHJcbiAgICAgICAgICAgICAgICA/PyAnJztcclxuICAgICAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZGV0ZWN0ZWQubWFuYWdlZFJvb3RzLmxlbmd0aCA9PT0gMDtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RoXHJcbiAgICAgICAgICAgICAgICA/IGDmo4DmtYvliLAgJHtkZXRlY3RlZC5tYW5hZ2VkUm9vdHMubGVuZ3RofSDkuKogbWFuYWdlZCByb290IMK3IEZpZ21hICR7ZGV0ZWN0ZWQuZmlnbWFWZXJzaW9ufeOAgumAieaLqeebruagh+WQjueUn+aIkOWPquivu+mihOiniOOAgmBcclxuICAgICAgICAgICAgICAgIDogJ+acquajgOa1i+WIsCBtYW5hZ2VkIHJvb3TjgIInO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvck1lc3NhZ2UoZXJyb3IsICdSb3VuZC10cmlwIOajgOa1i+Wksei0peOAgicpLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjcm91bmR0cmlwLXJvb3QnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB7XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBlbGVtZW50PEhUTUxCdXR0b25FbGVtZW50PignI3JvdW5kdHJpcC1wcmV2aWV3JykuZGlzYWJsZWQgPVxyXG4gICAgICAgICAgICBlbGVtZW50PEhUTUxTZWxlY3RFbGVtZW50PignI3JvdW5kdHJpcC1yb290JykudmFsdWUgPT09ICcnO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1wcmV2aWV3JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gcm91bmR0cmlwU291cmNlKCk7XHJcbiAgICAgICAgY29uc3Qgcm9vdElkID0gZWxlbWVudDxIVE1MU2VsZWN0RWxlbWVudD4oJyNyb3VuZHRyaXAtcm9vdCcpLnZhbHVlO1xyXG4gICAgICAgIGlmICghc291cmNlIHx8ICFyb290SWQpIHJldHVybjtcclxuICAgICAgICByZXNldFJvdW5kdHJpcFRva2VucygpO1xyXG4gICAgICAgIHNldEJ1c3kodHJ1ZSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgcmVuZGVyUm91bmR0cmlwUHJldmlldyhhd2FpdCByZXF1ZXN0PFJvdW5kdHJpcFByZXZpZXdEdG8+KCdyb3VuZHRyaXAtcHJldmlldycsIHNvdXJjZSwgcm9vdElkKSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAg6aKE6KeI5aSx6LSl44CCJyksIHRydWUpO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHNldEJ1c3koZmFsc2UpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtcGFpcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUGFpclRva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQYWlyVG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBhaXJlZCA9IGF3YWl0IHJlcXVlc3Q8eyBnZW5lcmF0aW9uOiBudW1iZXI7IGJhc2VsaW5lSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtcGFpcicsIHRva2VuKTtcclxuICAgICAgICAgICAgZWxlbWVudCgnI3JvdW5kdHJpcC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg6YWN5a+55a6M5oiQIMK3IExlZGdlciBnZW5lcmF0aW9uICR7cGFpcmVkLmdlbmVyYXRpb259XFxuQmFzZWxpbmUgJHtwYWlyZWQuYmFzZWxpbmVIYXNofVxcbuivt+mHjeaWsOeUn+aIkOWPmOabtOmihOiniOOAgmA7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdCgnU3VyZmFjZSDlt7LphY3lr7nvvJvmnKrkv67mlLkgUHJlZmFi44CCJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yTWVzc2FnZShlcnJvciwgJ1JvdW5kLXRyaXAgUGFpciDlpLHotKXjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1hcHBseScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghcm91bmR0cmlwUHJldmlld1Rva2VuKSByZXR1cm47XHJcbiAgICAgICAgY29uc3QgdG9rZW4gPSByb3VuZHRyaXBQcmV2aWV3VG9rZW47XHJcbiAgICAgICAgcmVzZXRSb3VuZHRyaXBUb2tlbnMoKTtcclxuICAgICAgICBzZXRCdXN5KHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlY2VpcHQgPSBhd2FpdCByZXF1ZXN0PHsgdHhuSWQ6IHN0cmluZzsgcHJlZmFiUG9zdGltYWdlSGFzaDogc3RyaW5nIH0+KCdyb3VuZHRyaXAtYXBwbHknLCB0b2tlbik7XHJcbiAgICAgICAgICAgIGVsZW1lbnQoJyNyb3VuZHRyaXAtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOS6i+WKoeW3suaPkOS6pCDCtyAke3JlY2VpcHQudHhuSWR9XFxuUG9zdGltYWdlICR7cmVjZWlwdC5wcmVmYWJQb3N0aW1hZ2VIYXNofVxcbuivt+mHjeaWsOmihOiniOS7peehruiupCAwIHBhdGNo44CCYDtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCdSb3VuZC10cmlwIOW3suWOn+WtkOW6lOeUqOWIsOWOnyBQcmVmYWLjgIInKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3JNZXNzYWdlKGVycm9yLCAnUm91bmQtdHJpcCDlupTnlKjlpLHotKXvvIzkuovliqHlt7Llm57mu5rjgIInKSwgdHJ1ZSk7XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgc2V0QnVzeShmYWxzZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3JvdW5kdHJpcC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHJlcXVlc3QoJ3JvdW5kdHJpcC1jYW5jZWwnKSk7XHJcblxyXG4gICAgZWxlbWVudCgnI2ZldGNoLWRvY3VtZW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgc291cmNlID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS52YWx1ZS50cmltKCk7XHJcbiAgICAgICAgaWYgKCFzb3VyY2UpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7fovpPlhaUgRmlnbWEg5paH5Lu25oiW6IqC54K56ZO+5o6l44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2V0QnVzeSh0cnVlKTtcclxuICAgICAgICB1cGRhdGVQcm9ncmVzcyh7IHBoYXNlOiAnZmV0Y2gnLCB2YWx1ZTogMC4wNSwgbWVzc2FnZTogJ+ato+WcqOi/nuaOpSBGaWdtYeKApicgfSk7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgZG9jdW1lbnQgPSBhd2FpdCByZXF1ZXN0PERvY3VtZW50RHRvPignZmV0Y2gtZG9jdW1lbnQnLCBzb3VyY2UpO1xyXG4gICAgICAgICAgICBzdGF0ZS5mb250QXNzZXRzID0gZG9jdW1lbnQuZm9udEFzc2V0cyA/PyBzdGF0ZS5mb250QXNzZXRzO1xyXG4gICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQoZG9jdW1lbnQpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfor7vlj5blpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICBzZXRCdXN5KGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCAoZXZlbnQpID0+IHtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGVsZW1lbnQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjZmV0Y2gtZG9jdW1lbnQnKS5jbGljaygpO1xyXG4gICAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIHJlc2V0Um91bmR0cmlwVG9rZW5zKTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLWFzc2V0LWZvbGRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJykudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZzsgYWJzb2x1dGVQYXRoOiBzdHJpbmcgfSB8IG51bGw+KFxyXG4gICAgICAgICAgICAgICAgJ3BpY2stYXNzZXQtZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjYXNzZXQtZm9sZGVyJyk7XHJcbiAgICAgICAgICAgIGlucHV0LnZhbHVlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSByZXN1bHQuYWJzb2x1dGVQYXRoO1xyXG4gICAgICAgICAgICBjb25zdCBzZXR0aW5ncyA9IHJlYWRTZXR0aW5ncyhmYWxzZSk7XHJcbiAgICAgICAgICAgIGlmIChzZXR0aW5ncykge1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzaG93VG9hc3QoYOi1hOa6kOWwhuWGmeWFpSBhc3NldHMvJHtyZXN1bHQuZm9sZGVyfWApO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIHNob3dUb2FzdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6ICfpgInmi6notYTmupDnm67lvZXlpLHotKXjgIInLCB0cnVlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNwaWNrLXByZWZhYi1mb2xkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZTtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVxdWVzdDx7IGZvbGRlcjogc3RyaW5nOyBhYnNvbHV0ZVBhdGg6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1wcmVmYWItZm9sZGVyJyxcclxuICAgICAgICAgICAgICAgIGN1cnJlbnQsXHJcbiAgICAgICAgICAgICk7XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjcHJlZmFiLWZvbGRlcicpO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmFic29sdXRlUGF0aDtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDpooTliLbkvZPlsIblhpnlhaUgYXNzZXRzLyR7cmVzdWx0LmZvbGRlcn1gKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAn6YCJ5oup6aKE5Yi25L2T55uu5b2V5aSx6LSl44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgMzsgaW5kZXggKz0gMSkge1xyXG4gICAgICAgIGVsZW1lbnQoYCNwaWNrLWxvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGlmICghc3RhdGUucnVudGltZUNvbXBhdGlibGUpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KCfor7flhYjkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcu+8jOWGjemAieaLqeacrOWcsOi1hOa6kOebruW9leOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWU7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcXVlc3Q8eyBmb2xkZXI6IHN0cmluZyB9IHwgbnVsbD4oXHJcbiAgICAgICAgICAgICAgICAncGljay1sb2NhbC1yZXNvdXJjZS1mb2xkZXInLFxyXG4gICAgICAgICAgICAgICAgY3VycmVudCxcclxuICAgICAgICAgICAgICAgIGluZGV4LFxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGNvbnN0IGlucHV0ID0gZWxlbWVudDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApO1xyXG4gICAgICAgICAgICBpbnB1dC52YWx1ZSA9IHJlc3VsdC5mb2xkZXI7XHJcbiAgICAgICAgICAgIGlucHV0LnRpdGxlID0gcmVzdWx0LmZvbGRlcjtcclxuICAgICAgICAgICAgY29uc3Qgc2V0dGluZ3MgPSByZWFkU2V0dGluZ3MoZmFsc2UpO1xyXG4gICAgICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcXVlc3QoJ3NhdmUtc2V0dGluZ3MnLCBzZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2hvd1RvYXN0KGDlt7LlkK/nlKjmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+mAieaLqeacrOWcsOi1hOa6kOebruW9leWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgICBlbGVtZW50KGAjY2xlYXItbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICBzaG93VG9hc3QoJ+ivt+WFiOS/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaW5wdXQgPSBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCk7XHJcbiAgICAgICAgaW5wdXQudmFsdWUgPSAnJztcclxuICAgICAgICBpbnB1dC50aXRsZSA9ICcnO1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2hvd1RvYXN0KGDlt7LmuIXpmaTmnKzlnLDlkIzlkI3otYTmupDnm67lvZUgJHtpbmRleCArIDF944CCYCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBlbGVtZW50KCcjaW1wb3J0LWJ1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaW1wb3J0VG9TY2VuZSk7XHJcbiAgICBlbGVtZW50KCcjY2FuY2VsLWltcG9ydCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gcmVxdWVzdCgnY2FuY2VsLWltcG9ydCcpKTtcclxuXHJcbiAgICBlbGVtZW50PEhUTUxJbnB1dEVsZW1lbnQ+KCcjdHJlZS1zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsIChldmVudCkgPT4ge1xyXG4gICAgICAgIHN0YXRlLnNlYXJjaCA9IChldmVudC50YXJnZXQgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XHJcbiAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICAgICAgICBjb25zdCBjb2xsYXBzZUlkID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2xsYXBzZV0nKT8uZGF0YXNldC5jb2xsYXBzZTtcclxuICAgICAgICBpZiAoY29sbGFwc2VJZCkge1xyXG4gICAgICAgICAgICBpZiAoc3RhdGUuY29sbGFwc2VkLmhhcyhjb2xsYXBzZUlkKSkge1xyXG4gICAgICAgICAgICAgICAgc3RhdGUuY29sbGFwc2VkLmRlbGV0ZShjb2xsYXBzZUlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmNvbGxhcHNlZC5hZGQoY29sbGFwc2VJZCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0YXJnZXQuY2xvc2VzdCgnc2VsZWN0LCBsYWJlbCwgaW5wdXQsIHRleHRhcmVhJykpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBpZCA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2RhdGEtbm9kZS1pZF0nKT8uZGF0YXNldC5ub2RlSWQ7XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IGlkID8gZmluZE5vZGUoaWQpIDogdW5kZWZpbmVkO1xyXG4gICAgICAgIGlmIChub2RlKSB7XHJcbiAgICAgICAgICAgIHZvaWQgcHJldmlldyhub2RlKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICBlbGVtZW50KCcjdHJlZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsIChldmVudCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQ7XHJcbiAgICAgICAgaWYgKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpIHtcclxuICAgICAgICAgICAgY29uc3Qgbm9kZSA9IGZpbmROb2RlKHRhcmdldC5kYXRhc2V0Lm5hbWVGb3IpO1xyXG4gICAgICAgICAgICBpZiAoIW5vZGUpIHJldHVybjtcclxuICAgICAgICAgICAgY29uc3QgY3VzdG9tTmFtZSA9IHNhbml0aXplTm9kZU5hbWUodGFyZ2V0LnZhbHVlKTtcclxuICAgICAgICAgICAgaWYgKCFjdXN0b21OYW1lKSB7XHJcbiAgICAgICAgICAgICAgICB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgICAgIHNob3dUb2FzdCgn6IqC54K55ZCN5LiN6IO95Li656m644CCJywgdHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc3RhdGUubmFtZXMuc2V0KG5vZGUuaWQsIGN1c3RvbU5hbWUpO1xyXG4gICAgICAgICAgICBpZiAoY3VzdG9tTmFtZSA9PT0gbm9kZS5uYW1lKSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5yZW5hbWVkSWRzLmRlbGV0ZShub2RlLmlkKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnJlbmFtZWRJZHMuYWRkKG5vZGUuaWQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KHN0YXRlLnJlbmFtZWRJZHMuaGFzKG5vZGUuaWQpXHJcbiAgICAgICAgICAgICAgICA/IGDoioLngrnlsIbku6XigJwke2N1c3RvbU5hbWV94oCd5a+85YWl44CCYFxyXG4gICAgICAgICAgICAgICAgOiAn5bey5oGi5aSNIEZpZ21hIOWOn+iKgueCueWQjeOAgicpO1xyXG4gICAgICAgIH0gZWxzZSBpZiAodGFyZ2V0LmRhdGFzZXQuYWN0aW9uRm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5hY3Rpb25Gb3IpO1xyXG4gICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYWN0aW9uID0gdGFyZ2V0LnZhbHVlIGFzIEltcG9ydEFjdGlvbjtcclxuICAgICAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZChub2RlLmlkKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gIT09ICdyZW5kZXInKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3RhdGUucGF0Y2hlcy5kZWxldGUobm9kZS5pZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBzZXRBY3Rpb24obm9kZSwgYWN0aW9uKTtcclxuICAgICAgICAgICAgICAgIHJvb3QoKS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtcHJlc2V0XScpXHJcbiAgICAgICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgICAgIGlmIChhY3Rpb24gPT09ICdyZW5kZXInICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2hvd1RvYXN0KGDigJwke2VmZmVjdGl2ZU5vZGVOYW1lKG5vZGUpfeKAneWwhuS9nOS4uuaVtOWxguWvvOWFpe+8jCR7ZGVzY2VuZGFudHMobm9kZSkubGVuZ3RofSDkuKrlrZDoioLngrnkuI3kvJrljZXni6znlJ/miJDjgIJgKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgICAgIHBlcnNpc3ROb2RlT3ZlcnJpZGVzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LmtpbmRGb3IpIHtcclxuICAgICAgICAgICAgc3RhdGUua2luZHMuc2V0KHRhcmdldC5kYXRhc2V0LmtpbmRGb3IsIHRhcmdldC52YWx1ZSBhcyBOb2RlS2luZCk7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5raW5kRm9yKTtcclxuICAgICAgICAgICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1wcmVzZXRdJylcclxuICAgICAgICAgICAgICAgIC5mb3JFYWNoKChidXR0b24pID0+IGJ1dHRvbi5jbGFzc0xpc3QucmVtb3ZlKCdhY3RpdmUnKSk7XHJcbiAgICAgICAgICAgIHJlbmRlclRyZWUoKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9IGVsc2UgaWYgKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKSB7XHJcbiAgICAgICAgICAgIHN0YXRlLmV4cGxpY2l0SWRzLmFkZCh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgIGlmICgodGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQpIHtcclxuICAgICAgICAgICAgICAgIHN0YXRlLnBhdGNoZXMuYWRkKHRhcmdldC5kYXRhc2V0LnBhdGNoRm9yKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICBpZiAobm9kZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHNldEFjdGlvbihub2RlLCAncmVuZGVyJyk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzdGF0ZS5wYXRjaGVzLmRlbGV0ZSh0YXJnZXQuZGF0YXNldC5wYXRjaEZvcik7XHJcbiAgICAgICAgICAgICAgICByZWNvbmNpbGVBY3Rpb25zKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgcmVuZGVyVHJlZSgpO1xyXG4gICAgICAgICAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKVxyXG4gICAgICAgICAgICAgICAgLmZvckVhY2goKGJ1dHRvbikgPT4gYnV0dG9uLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpKTtcclxuICAgICAgICAgICAgcGVyc2lzdE5vZGVPdmVycmlkZXMoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgZWxlbWVudCgnI3RyZWUnKS5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZXZlbnQudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQ7XHJcbiAgICAgICAgY29uc3QgaWQgPSB0YXJnZXQuZGF0YXNldC5uYW1lRm9yO1xyXG4gICAgICAgIGlmICghaWQpIHJldHVybjtcclxuICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInKSB7XHJcbiAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgICAgIHRhcmdldC5ibHVyKCk7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5vZGUgPSBmaW5kTm9kZShpZCk7XHJcbiAgICAgICAgICAgIGlmIChub2RlKSB0YXJnZXQudmFsdWUgPSBlZmZlY3RpdmVOb2RlTmFtZShub2RlKTtcclxuICAgICAgICAgICAgdGFyZ2V0LmJsdXIoKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICByb290KCkucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLXByZXNldF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiBhcHBseVByZXNldChidXR0b24uZGF0YXNldC5wcmVzZXQgPz8gJ3NtYXJ0JykpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcm9vdCgpLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxUZXh0QXJlYUVsZW1lbnQ+KFxyXG4gICAgICAgICcjc2NhbGUsICNhc3NldC1mb2xkZXIsICNwcmVmYWItZm9sZGVyLCAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLCAjdXBkYXRlLWV4aXN0aW5nLCAjcmVmcmVzaC1hc3NldHMsICNhdXRvLXNhdmUnLFxyXG4gICAgKS5mb3JFYWNoKChjb250cm9sKSA9PiB7XHJcbiAgICAgICAgY29udHJvbC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICAgICAgaWYgKHNldHRpbmdzKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXF1ZXN0KCdzYXZlLXNldHRpbmdzJywgc2V0dGluZ3MpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICB9KTtcclxuICAgIGVsZW1lbnQoJyNmb250LW1hcC1saXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVhZFNldHRpbmdzKGZhbHNlKTtcclxuICAgICAgICBpZiAoc2V0dGluZ3MpIHtcclxuICAgICAgICAgICAgc3RhdGUuc2V0dGluZ3MgPSBzZXR0aW5ncztcclxuICAgICAgICAgICAgYXdhaXQgcmVxdWVzdCgnc2F2ZS1zZXR0aW5ncycsIHNldHRpbmdzKTtcclxuICAgICAgICB9XHJcbiAgICB9KTtcclxufVxyXG5cclxubW9kdWxlLmV4cG9ydHMgPSBFZGl0b3IuUGFuZWwuZGVmaW5lKHtcclxuICAgIGxpc3RlbmVyczoge1xyXG4gICAgICAgIHNob3coKSB7fSxcclxuICAgICAgICBoaWRlKCkge30sXHJcbiAgICB9LFxyXG4gICAgdGVtcGxhdGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy90ZW1wbGF0ZS9kZWZhdWx0L2luZGV4Lmh0bWwnKSwgJ3V0ZjgnKSxcclxuICAgIHN0eWxlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvc3R5bGUvZGVmYXVsdC9pbmRleC5jc3MnKSwgJ3V0ZjgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBhcHA6ICcjYXBwJyxcclxuICAgIH0sXHJcbiAgICBtZXRob2RzOiB7XG4gICAgICAgIG9uSW1wb3J0UmV2aWV3UmVhZHkocmV2aWV3OiBJbXBvcnRSZXZpZXcpIHtcbiAgICAgICAgICAgIGltcG9ydFJldmlld1BhbmVsPy5vcGVuKHJldmlldyk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uUHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpIHtcclxuICAgICAgICAgICAgdXBkYXRlUHJvZ3Jlc3MoZXZlbnQpO1xyXG4gICAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAgYXN5bmMgcmVhZHkoKSB7XHJcbiAgICAgICAgcGFuZWxIb3N0ID0gdGhpcztcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG5ldyBJbXBvcnRSZXZpZXdQYW5lbChyb290KCksIHJlcXVlc3QsIHNldEJ1c3kpO1xyXG4gICAgICAgIGJpbmRFdmVudHMoKTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBpbml0aWFsID0gYXdhaXQgcmVxdWVzdDx7XHJcbiAgICAgICAgICAgICAgICB2ZXJzaW9uPzogc3RyaW5nO1xyXG4gICAgICAgICAgICAgICAgdmF1bHQ6IGFueTtcclxuICAgICAgICAgICAgICAgIHNldHRpbmdzOiBJbXBvcnRTZXR0aW5ncztcclxuICAgICAgICAgICAgICAgIGRvY3VtZW50OiBEb2N1bWVudER0byB8IG51bGw7XHJcbiAgICAgICAgICAgICAgICBmb250QXNzZXRzPzogRm9udEFzc2V0T3B0aW9uW107XHJcbiAgICAgICAgICAgIH0+KCdnZXQtc3RhdGUnKTtcclxuICAgICAgICAgICAgc3RhdGUucnVudGltZUNvbXBhdGlibGUgPSBpbml0aWFsLnZlcnNpb24gPT09IHBhY2thZ2VKU09OLnZlcnNpb247XHJcbiAgICAgICAgICAgIHN0YXRlLmZvbnRBc3NldHMgPSBpbml0aWFsLmZvbnRBc3NldHMgPz8gW107XHJcbiAgICAgICAgICAgIHNldENvbm5lY3Rpb24oaW5pdGlhbC52YXVsdCk7XHJcbiAgICAgICAgICAgIGFwcGx5U2V0dGluZ3MoaW5pdGlhbC5zZXR0aW5ncyk7XHJcbiAgICAgICAgICAgIGlmIChpbml0aWFsLmRvY3VtZW50KSB7XHJcbiAgICAgICAgICAgICAgICBpbml0aWFsaXplRG9jdW1lbnQoaW5pdGlhbC5kb2N1bWVudCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFzdGF0ZS5ydW50aW1lQ29tcGF0aWJsZSkge1xyXG4gICAgICAgICAgICAgICAgdXBkYXRlU3VtbWFyeSgpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYnV0dG9uID0gZWxlbWVudDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XHJcbiAgICAgICAgICAgICAgICBidXR0b24uY2xhc3NMaXN0LmFkZCgnaXMtZXJyb3InKTtcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLWxhYmVsJykudGV4dENvbnRlbnQgPSAn6K+36YeN5ZCvIENvY29zJztcclxuICAgICAgICAgICAgICAgIGVsZW1lbnQoJyNpbXBvcnQtYnV0dG9uLXBlcmNlbnQnKS50ZXh0Q29udGVudCA9ICfihrsnO1xyXG4gICAgICAgICAgICAgICAgc2hvd1RvYXN0KCfmo4DmtYvliLDml6fniYjkuLvov5vnqIvku43lnKjov5DooYzvvJror7fkv53lrZjpobnnm67lubblrozmlbTph43lkK8gQ29jb3MgQ3JlYXRvcuOAgicsIHRydWUpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgc2hvd1RvYXN0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ+WIneWni+WMluWksei0peOAgicsIHRydWUpO1xyXG4gICAgICAgIH1cclxuICAgIH0sXHJcbiAgICBiZWZvcmVDbG9zZSgpIHt9LFxyXG4gICAgY2xvc2UoKSB7XHJcbiAgICAgICAgaW1wb3J0UmV2aWV3UGFuZWw/LmRpc3Bvc2UoKTtcclxuICAgICAgICBpbXBvcnRSZXZpZXdQYW5lbCA9IG51bGw7XHJcbiAgICAgICAgcGFuZWxIb3N0ID0gbnVsbDtcclxuICAgIH0sXHJcbn0pO1xyXG4iXX0=