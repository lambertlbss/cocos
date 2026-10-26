import { readFileSync } from 'fs';
import { join } from 'path';
import packageJSON from '../../../package.json';
import { ImportReviewPanel } from './import-review';
import { PanelWorkflow, type BatchWorkflowContext, type WorkflowResult } from './workflow';
import type { BatchFrameItem, BatchImportItemResult, BatchImportResult, BatchProgress, BatchSourceResult, BatchState } from '../../batch-types';
import { sanitizeAssetName } from '../../importer/assets';
import type { ImportReview } from '../../import-review-model';
import { findFontAsset, type FontAssetOption } from '../../importer/fonts';
import { normalizeImportAction } from '../../import-actions';
import { sanitizeNodeName } from '../../node-name';
import { normalizeFigmaSliceDecision } from '../../figma/import-planner';
import { hiddenLayerIds } from '../../import-visibility';
import {
    actionOptionsForNode,
    defaultNineSliceIds,
    effectiveKindForNode,
    isVectorNodeType,
    kindOptionsForAction,
    rerenderPreservingScroll,
    resolveEffectiveActions,
    smartActionForNode,
    strategySummaryForNode,
} from './model';
import type {
    ImportAction,
    ImportOverride,
    ImportSettings,
    NodeKind,
    ProgressEvent,
    TreeNodeDto,
} from '../../types';

interface DocumentDto {
    fileKey: string;
    fileName: string;
    sourceUrl: string;
    tree: TreeNodeDto[];
    fonts: string[];
    fontAssets?: FontAssetOption[];
    nodeOverrides?: ImportOverride[];
}

interface RoundtripDetectDto {
    figmaVersion: string;
    managedRoots: Array<{ nodeId: string; name: string; prefabUuid?: string; error?: string }>;
    selectedRootId?: string;
}

interface RoundtripPreviewDto {
    previewToken?: string;
    pairToken?: string;
    pairRequired: boolean;
    pairEligible: boolean;
    figmaVersion: string;
    surfaceId: string;
    prefabUuid: string;
    assetUrl: string;
    ledgerGeneration: number;
    blockers: string[];
    plan: {
        apply: unknown[];
        preserveCocos: unknown[];
        converged: unknown[];
        conflicts: unknown[];
        unsupported: unknown[];
        readonlyUnchanged: unknown[];
    };
}

interface PanelState {
    document: DocumentDto | null;
    settings: ImportSettings;
    preferredActions: Map<string, ImportAction>;
    actions: Map<string, ImportAction>;
    kinds: Map<string, NodeKind>;
    patches: Set<string>;
    explicitIds: Set<string>;
    names: Map<string, string>;
    renamedIds: Set<string>;
    defaults: Map<string, { action: ImportAction; kind: NodeKind }>;
    collapsed: Set<string>;
    suppressed: Set<string>;
    selectedId?: string;
    search: string;
    busy: boolean;
    runtimeCompatible: boolean;
    fontAssets: FontAssetOption[];
}

let panelHost: any = null;
let importReviewPanel: ImportReviewPanel | null = null;
let workflow: PanelWorkflow | null = null;
let pendingImportReview: ImportReview | null = null;
let forceDocumentRead = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let importButtonResetTimer: ReturnType<typeof setTimeout> | null = null;
let nodeOverrideSaveTask: Promise<void> = Promise.resolve();
let roundtripPreviewToken: string | undefined;
let roundtripPairToken: string | undefined;
type FrameEditorState = Pick<PanelState, 'document' | 'preferredActions' | 'actions' | 'kinds' | 'patches' | 'explicitIds' | 'names' | 'renamedIds' | 'defaults' | 'collapsed' | 'suppressed' | 'selectedId' | 'search'> & { treeScroll: number; preset?: string };
interface FrameEditorItem { item: BatchFrameItem; editor?: FrameEditorState; configured: boolean }
let batchItems: FrameEditorItem[] = [];
let activeBatchId: string | undefined;
let batchResult: BatchImportResult | undefined;
let batchProgress: BatchProgress | undefined;
let batchSyncTask: Promise<void> = Promise.resolve();
let batchSyncError: unknown;
let batchImportPending = false;
let batchStopRequested = false;
let previewRevision = 0;
let previewReadTask: Promise<unknown> = Promise.resolve();
let batchRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

const state: PanelState = {
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

function ignoredHiddenFrame(entry: FrameEditorItem): boolean {
    return state.settings.importHiddenLayers === false && entry.item.document.tree[0]?.visible === false;
}

function availableFrames(): FrameEditorItem[] { return batchItems.filter((entry) => !ignoredHiddenFrame(entry)); }

function selectedFrames(): FrameEditorItem[] { return availableFrames().filter(({ item }) => item.enabled); }

function editorSnapshot(): FrameEditorState {
    return {
        document: state.document,
        preferredActions: new Map(state.preferredActions), actions: new Map(state.actions),
        kinds: new Map(state.kinds), patches: new Set(state.patches), explicitIds: new Set(state.explicitIds),
        names: new Map(state.names), renamedIds: new Set(state.renamedIds), defaults: new Map(state.defaults),
        collapsed: new Set(state.collapsed), suppressed: new Set(state.suppressed),
        selectedId: state.selectedId, search: state.search, treeScroll: element('#tree').scrollTop,
        preset: Array.from(root().querySelectorAll<HTMLElement>('[data-preset]')).find((button) => button.classList.contains('active'))?.dataset.preset,
    };
}

function initialFrameEditor(document: DocumentDto): FrameEditorState {
    const editor: FrameEditorState = {
        document, preferredActions: new Map(), actions: new Map(), kinds: new Map(),
        patches: defaultNineSliceIds(document.tree), explicitIds: new Set(), names: new Map(), renamedIds: new Set(),
        defaults: new Map(), collapsed: new Set(), suppressed: new Set(), selectedId: document.tree[0]?.id,
        search: '', treeScroll: 0, preset: 'smart',
    };
    for (const node of flatten(document.tree)) {
        const action = smartActionForNode(node);
        editor.preferredActions.set(node.id, action); editor.kinds.set(node.id, node.kind);
        editor.defaults.set(node.id, { action, kind: node.kind }); editor.names.set(node.id, node.name);
    }
    for (const override of document.nodeOverrides ?? []) {
        const node = findNode(override.id, document.tree); if (!node) continue;
        const name = sanitizeNodeName(override.name);
        if (name && name !== node.name) { editor.names.set(node.id, name); editor.renamedIds.add(node.id); }
        if (override.explicit) {
            editor.preferredActions.set(node.id, safeAction(node, override.action)); editor.kinds.set(node.id, override.kind);
            if (node.patchCandidate) editor.patches.add(node.id); else editor.patches.delete(node.id);
            editor.explicitIds.add(node.id); editor.preset = undefined;
        }
    }
    const effective = resolveEffectiveActions(document.tree, editor.preferredActions, editor.patches, editor.explicitIds, editor.renamedIds,
        state.settings.importHiddenLayers !== false);
    editor.actions = effective.actions; editor.suppressed = effective.suppressed;
    return editor;
}

function rememberActiveFrame(): void {
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active) active.editor = editorSnapshot();
}

function frameName(entry: FrameEditorItem): string {
    const editor = entry.item.id === activeBatchId ? state : entry.editor;
    return editor?.names.get(entry.item.rootId) ?? entry.item.document.nodeOverrides?.find((override) => override.id === entry.item.rootId)?.name ?? entry.item.name;
}

function batchConflicts(): Set<string> {
    const names = new Map<string, string[]>();
    for (const entry of selectedFrames()) {
        const key = sanitizeAssetName(frameName(entry)).toLocaleLowerCase();
        names.set(key, [...(names.get(key) ?? []), entry.item.id]);
    }
    return new Set(Array.from(names.values()).filter((ids) => ids.length > 1).flat());
}

function batchContext(): BatchWorkflowContext | undefined {
    if (!batchItems.length) return undefined;
    let nodes = 0;
    let selectedNodes = 0;
    for (const entry of selectedFrames()) {
        const editor = entry.item.id === activeBatchId ? state : entry.editor;
        const all = flatten(entry.item.document.tree);
        nodes += all.length;
        selectedNodes += all.filter((node) => (editor?.actions.get(node.id) ?? node.action) !== 'ignore').length;
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

function batchFonts(): string[] {
    if (batchItems.length) return Array.from(new Set(selectedFrames().flatMap(({ item }) => item.document.fonts)));
    if (state.settings.importHiddenLayers === false && state.document?.tree.every((node) => node.visible === false)) return [];
    return state.document?.fonts ?? [];
}

function syncBatchItems(precedingPreview: Promise<unknown> = previewReadTask): Promise<void> {
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

async function waitForBatchListReady(): Promise<void> {
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
        if (batchSyncError) throw batchSyncError;
        if (element('#workflow-error-message').textContent === previousMessage) workflow?.clearError();
        if (element('#toast').textContent === previousMessage) showToast('界面列表已同步，可以继续。');
    }
}

function batchElement<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const value = document.createElement(tag);
    value.textContent = text;
    value.className = className;
    return value;
}

function batchButton(text: string, action: () => void, className = 'text-button'): HTMLButtonElement {
    const button = batchElement('button', text, className);
    button.type = 'button';
    button.disabled = state.busy;
    button.onclick = action;
    return button;
}

function renderBatch(): void {
    const enabled = batchItems.length > 0;
    element('#batch-source-region').hidden = !enabled;
    element('#batch-frame-region').hidden = !enabled;
    element('#batch-target-region').hidden = !enabled;
    element('#batch-result-region').hidden = !enabled || (!batchResult && !batchProgress);
    const genericReview = root().querySelector<HTMLElement>('.result-review');
    if (genericReview) genericReview.hidden = enabled;
    element('#preset-scope').textContent = enabled ? '仅作用于当前界面' : '作用于全部节点';
    const available = availableFrames();
    const hiddenCount = batchItems.length - available.length;
    element('#batch-selected-count').textContent = `已选 ${selectedFrames().length} / ${available.length}`
        + (hiddenCount ? ` · ${hiddenCount} 个隐藏界面本次忽略` : '');
    element<HTMLButtonElement>('#batch-toggle-all').textContent = available.length && selectedFrames().length === available.length ? '取消全选' : '全选';
    element<HTMLButtonElement>('#batch-toggle-all').disabled = state.busy || available.length === 0;
    const list = element('#batch-source-list');
    const tabs = element('#batch-frame-tabs');
    const targets = element('#batch-target-list');
    list.replaceChildren(); tabs.replaceChildren(); targets.replaceChildren();
    const conflicts = batchConflicts();
    for (const entry of batchItems) {
        const { item } = entry;
        const hiddenIgnored = ignoredHiddenFrame(entry);
        const row = batchElement('div', '', `batch-item${item.enabled && !hiddenIgnored ? '' : ' is-disabled'}`);
        const checked = batchElement('input');
        checked.type = 'checkbox'; checked.checked = item.enabled && !hiddenIgnored; checked.disabled = state.busy || hiddenIgnored;
        checked.dataset.batchChecked = item.id;
        checked.setAttribute('aria-label', `导入 ${frameName(entry)}`);
        checked.onchange = () => {
            if (state.busy || hiddenIgnored) return;
            item.enabled = checked.checked;
            syncBatchItems();
            renderBatch(); renderFontMap(); workflow?.render();
            if (activeBatchId === item.id && !item.enabled && selectedFrames().length) void activateFrame(selectedFrames()[0].item.id);
        };
        const copy = batchElement('div', '', 'batch-item-copy');
        const title = batchElement('div', '', 'batch-item-title');
        title.append(batchElement('span', frameName(entry)), batchElement('span', entry.configured ? '已配置' : '智能默认', `badge${entry.configured ? '' : ' subtle'}`));
        if (hiddenIgnored) title.append(batchElement('span', '隐藏 · 本次忽略', 'badge subtle'));
        if (conflicts.has(item.id)) title.append(batchElement('span', '名称冲突', 'batch-status-failed'));
        copy.append(title, batchElement('div', `${item.sectionName ? `${item.sectionName} / ` : ''}${item.document.fileName} · ${flatten(item.document.tree).length} 节点`, 'batch-item-meta'));
        const actions = batchElement('div', '', 'batch-item-actions');
        const configure = batchButton(hiddenIgnored ? '允许导入隐藏图层' : '调整节点', () => {
            if (hiddenIgnored) { void setImportHiddenLayers(true); return; }
            if (!item.enabled) { item.enabled = true; syncBatchItems(); }
            void activateFrame(item.id, true);
        });
        if (hiddenIgnored) configure.title = '仅修改导入选项，不改变 Figma 图层的显隐；已有 Prefab 不会删除';
        configure.dataset.batchConfigure = item.id;
        const remove = batchButton('×', () => {
            if (state.busy) return;
            rememberActiveFrame();
            batchItems = batchItems.filter((candidate) => candidate.item.id !== item.id);
            let nextId: string | undefined;
            if (activeBatchId === item.id) {
                activeBatchId = undefined;
                if (selectedFrames().length) nextId = selectedFrames()[0].item.id;
                else if (batchItems.length) nextId = batchItems[0].item.id;
                else { state.document = null; renderTree(); workflow?.batchReady(); }
            }
            syncBatchItems();
            if (nextId) void activateFrame(nextId);
            renderBatch(); renderFontMap(); workflow?.render();
        }, 'icon-button');
        remove.dataset.batchRemove = item.id; remove.setAttribute('aria-label', `移除 ${frameName(entry)}`);
        actions.append(configure, remove); row.append(checked, copy, actions); list.append(row);
        if (!item.enabled || hiddenIgnored) continue;
        const tab = batchButton('', () => { void activateFrame(item.id); }, 'batch-frame-tab');
        tab.dataset.batchFrame = item.id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(activeBatchId === item.id));
        tab.append(batchElement('strong', frameName(entry)), batchElement('small', entry.configured ? '已配置 · 自动保留' : '智能默认'));
        tabs.append(tab);
        const target = batchElement('label', '', `batch-target-row${conflicts.has(item.id) ? ' is-conflict' : ''}`);
        target.append(batchElement('span', item.name));
        const name = batchElement('input');
        name.type = 'text'; name.value = frameName(entry); name.disabled = state.busy; name.dataset.batchName = item.id;
        name.setAttribute('aria-label', `${item.name} 的 Prefab 名称`);
        name.title = `assets/${element<HTMLInputElement>('#prefab-folder').value}/${sanitizeAssetName(frameName(entry))}.prefab`;
        name.onchange = () => { void renameFrame(entry, name.value); };
        target.append(name); targets.append(target);
    }
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    element('#batch-active-name').textContent = active ? `正在调整：${frameName(active)}` : '选择一个界面开始调整';
    element('#batch-active-status').textContent = active && ignoredHiddenFrame(active) ? '隐藏 · 本次忽略'
        : active?.configured ? '修改已保留' : '沿用智能默认';
    element('#batch-conflicts').hidden = conflicts.size === 0;
    element('#batch-conflicts').textContent = `有 ${conflicts.size} 个界面的 Prefab 文件名重复（忽略大小写）。请改名后开始导入。`;
    renderBatchResults();
}

function renderBatchResults(): void {
    const rows = batchProgress?.items ?? batchResult?.items ?? [];
    const list = element('#batch-result-list'); list.replaceChildren();
    for (const item of rows) {
        const row = batchElement('div', '', 'batch-item');
        const copy = batchElement('div', '', 'batch-item-copy');
        copy.append(batchElement('div', item.name, 'batch-item-title'), batchElement('div', item.error ?? item.prefabUrl ?? item.warnings?.join('；') ?? (item.status === 'pending' ? '等待继续导入' : ''), 'batch-item-meta'));
        const status = { pending: '未完成', running: '正在导入', success: '已完成', failed: '失败' }[item.status];
        const actions = batchElement('div', '', 'batch-item-actions');
        actions.append(batchElement('span', status, `batch-status-${item.status}`));
        if (item.reviewId || item.review) {
            const review = batchButton('检查结果', () => { void openBatchReview(item); });
            review.dataset.batchReview = item.id; actions.append(review);
        }
        row.append(copy, actions); list.append(row);
    }
    const success = rows.filter((item) => item.status === 'success').length;
    const failed = rows.filter((item) => item.status === 'failed').length;
    const pending = rows.filter((item) => item.status === 'pending').length;
    element('#batch-result-count').textContent = `${success} / ${rows.length} 已完成`;
    element<HTMLButtonElement>('#batch-retry-failed').hidden = !failed || state.busy;
    element<HTMLButtonElement>('#batch-resume-pending').hidden = !pending || state.busy;
    element('#batch-result-note').textContent = rows.some((item) => item.requiresAttention)
        ? '部分项的保存状态需要检查。请先在 Cocos 确认当前目标与保存状态，再重试或继续。'
        : '点击每一项的“检查结果”查看对应报告；重试和继续会跳过已完成项。';
}

async function openBatchReview(item: BatchImportItemResult): Promise<void> {
    if (state.busy) return;
    try {
        const reviewId = item.reviewId ?? item.review?.id;
        const review = reviewId ? await request<ImportReview | null>('get-import-review', reviewId) : null;
        if (!review) throw new Error('该项检查报告已过期，请重新导入后查看。');
        importReviewPanel?.open(review);
    } catch (error) { showToast(errorMessage(error, '读取检查结果失败。'), true); }
}

async function activateFrame(id: string, navigate = false): Promise<void> {
    if (state.busy) return;
    const entry = batchItems.find(({ item }) => item.id === id);
    if (!entry) return;
    const alreadyActive = activeBatchId === id && state.document;
    rememberActiveFrame();
    const oldId = activeBatchId;
    const oldEditor = editorSnapshot();
    const settings = readSettings(false); if (settings) state.settings = settings;
    previewRevision++;
    setBusy(true);
    try {
        await waitForBatchListReady();
        const loaded = alreadyActive ? state.document : await request<DocumentDto>('activate-batch-item', id);
        if (!alreadyActive && loaded?.fontAssets) {
            state.fontAssets = loaded.fontAssets;
            entry.item.document.fontAssets = loaded.fontAssets;
        }
        activeBatchId = id;
        if (entry.editor) { Object.assign(state, entry.editor); reconcileActions(); }
        else initializeDocument(loaded ?? entry.item.document, false);
        element<HTMLInputElement>('#tree-search').value = state.search;
        element('#file-name').textContent = state.document?.fileName ?? '';
        element('#preview-stage').classList.remove('has-image', 'is-loading');
        element('#preview-image').removeAttribute('src');
        element('#preview-meta').textContent = '选择节点查看预览';
        renderTree();
        element('#tree').scrollTop = entry.editor?.treeScroll ?? 0;
        root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => button.classList.toggle('active', button.dataset.preset === (entry.editor?.preset ?? 'smart')));
        renderFontMap();
    } catch (error) {
        activeBatchId = oldId; Object.assign(state, oldEditor);
        showToast(errorMessage(error, '切换界面失败，请重试。'), true);
    } finally {
        setBusy(false); renderBatch(); updateSummary();
        if (navigate && activeBatchId === id) workflow?.navigate(2);
        if (activeBatchId === id && workflow?.step === 2 && state.selectedId) {
            const selected = findNode(state.selectedId); if (selected) void preview(selected);
        }
    }
}

async function renameFrame(entry: FrameEditorItem, value: string): Promise<void> {
    if (state.busy) return;
    const name = sanitizeNodeName(value);
    if (!name) { showToast('Prefab 名称不能为空。', true); renderBatch(); return; }
    await activateFrame(entry.item.id);
    if (activeBatchId !== entry.item.id) return;
    state.names.set(entry.item.rootId, name);
    if (name === entry.item.name) state.renamedIds.delete(entry.item.rootId); else state.renamedIds.add(entry.item.rootId);
    entry.configured = true;
    persistNodeOverrides(); rememberActiveFrame(); renderTree(); renderBatch(); updateSummary();
}

function root(): HTMLElement {
    return panelHost.$.app as HTMLElement;
}

function element<T extends HTMLElement>(selector: string): T {
    const value = root().querySelector<T>(selector);
    if (!value) {
        throw new Error(`Panel element not found: ${selector}`);
    }
    return value;
}

async function request<T>(message: string, ...args: unknown[]): Promise<T> {
    return await Editor.Message.request(packageJSON.name, message, ...args) as T;
}

function showToast(message: string, error = false): void {
    const toast = element<HTMLDivElement>('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    const credentialDialog = root().querySelector<HTMLDialogElement>('#credential-dialog');
    const credentialStatus = root().querySelector<HTMLElement>('#credential-status');
    if (credentialDialog?.open && credentialStatus) {
        credentialStatus.hidden = false;
        credentialStatus.textContent = message;
        credentialStatus.classList.toggle('error', error);
    }
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
        return error;
    }
    if (error && typeof error === 'object' && 'message' in error
        && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message;
    }
    return fallback;
}

function setConnection(vault: {
    hasToken: boolean;
    persistent: boolean;
    backend: string;
    warning?: string;
}): void {
    const pill = element('#connection-pill');
    pill.classList.toggle('is-online', vault.hasToken);
    pill.classList.toggle('is-offline', !vault.hasToken);
    element('#connection-label').textContent = vault.hasToken ? '凭据就绪' : '未连接';
    element('#vault-badge').textContent = vault.persistent ? '系统加密' : '会话存储';
    element('#vault-note').textContent = vault.warning
        ?? (vault.persistent ? `由 ${vault.backend} 加密，项目中仅保存非敏感设置` : 'Token 不写入项目文件');
    (element<HTMLButtonElement>('#verify-token')).disabled = !vault.hasToken;
    (element<HTMLButtonElement>('#clear-token')).disabled = !vault.hasToken;
    workflow?.setConnection(vault.hasToken);
}

function flatten(nodes: TreeNodeDto[]): TreeNodeDto[] {
    return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function findNode(id: string, nodes = state.document?.tree ?? []): TreeNodeDto | undefined {
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

function renderFontMap(): void {
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
        const automatic = findFontAsset(family, state.fontAssets);
        const hasMapping = Object.prototype.hasOwnProperty.call(state.settings.fontMap, family);
        const selected = hasMapping ? state.settings.fontMap[family] : automatic?.url ?? '';
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

function safeAction(node: TreeNodeDto, action: unknown): ImportAction {
    return normalizeFigmaSliceDecision({ action: normalizeImportAction(action), kind: node.kind, nineSlice: false }, node.patchCandidate).action;
}

function initializeDocument(document: DocumentDto, navigate = true): void {
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
    state.selectedId = document.tree[0]?.id;
    pendingImportReview = null;
    for (const node of flatten(document.tree)) {
        const action = smartActionForNode(node);
        state.preferredActions.set(node.id, action);
        state.kinds.set(node.id, node.kind);
        state.defaults.set(node.id, { action, kind: node.kind });
        state.names.set(node.id, node.name);
    }
    state.patches = defaultNineSliceIds(document.tree);
    for (const override of document.nodeOverrides ?? []) {
        const node = findNode(override.id, document.tree);
        if (!node) {
            continue;
        }
        const customName = sanitizeNodeName(override.name);
        if (customName && customName !== node.name) {
            state.names.set(node.id, customName);
            state.renamedIds.add(node.id);
        }
        if (override.explicit === true) {
            state.preferredActions.set(node.id, safeAction(node, override.action));
            state.kinds.set(node.id, override.kind);
            if (node.patchCandidate) {
                state.patches.add(node.id);
            } else {
                state.patches.delete(node.id);
            }
            state.explicitIds.add(node.id);
        }
    }
    reconcileActions();
    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.classList.toggle(
            'active',
            state.explicitIds.size === 0 && button.dataset.preset === 'smart',
        );
    });
    element('#file-name').textContent = document.fileName;
    element<HTMLInputElement>('#source-url').value = document.sourceUrl;
    element('#font-hint').textContent = document.fonts.length
        ? `检测到：${document.fonts.join('、')}`
        : '当前文件尚未发现字体。';
    renderFontMap();
    renderTree(true);
    updateSummary();
    if (navigate) workflow?.documentReady();
}

function applySettings(settings: ImportSettings): void {
    state.settings = { ...settings, fontMap: { ...settings.fontMap }, importHiddenLayers: settings.importHiddenLayers !== false };
    element<HTMLInputElement>('#source-url').value = settings.sourceUrl;
    element<HTMLInputElement>('#asset-folder').value = settings.assetFolder;
    element<HTMLInputElement>('#prefab-folder').value = settings.prefabFolder;
    const localResourceFolders = settings.localResourceFolders?.length
        ? settings.localResourceFolders
        : settings.localResourceFolder
            ? [settings.localResourceFolder]
            : [];
    for (let index = 0; index < 3; index += 1) {
        const input = element<HTMLInputElement>(`#local-resource-folder-${index}`);
        input.value = localResourceFolders[index] ?? '';
        input.title = localResourceFolders[index] ?? '';
    }
    element<HTMLInputElement>('#scale').value = String(settings.scale);
    element<HTMLInputElement>('#update-existing').checked = settings.updateExisting;
    element<HTMLInputElement>('#refresh-assets').checked = settings.refreshAssets;
    element<HTMLInputElement>('#auto-save').checked = settings.autoSave;
    element<HTMLInputElement>('#import-hidden-layers').checked = state.settings.importHiddenLayers;
    updateTargetHint();
    renderFontMap();
    workflow?.render();
}

function readSettings(showError = true): ImportSettings | null {
    const fontMap: Record<string, string> = { ...state.settings.fontMap };
    root().querySelectorAll<HTMLSelectElement>('[data-font-family]').forEach((select) => {
        const family = select.dataset.fontFamily?.trim();
        if (family && select.value) {
            fontMap[family] = select.value;
        }
    });
    const scale = Number(element<HTMLInputElement>('#scale').value);
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) {
        if (showError) {
            showToast('导入倍率必须在 0.25 到 4 之间。', true);
        }
        return null;
    }
    const assetFolder = element<HTMLInputElement>('#asset-folder').value.trim();
    if (!assetFolder) {
        if (showError) {
            showToast('请选择项目 assets 下的资源输出目录。', true);
        }
        return null;
    }
    const prefabFolder = element<HTMLInputElement>('#prefab-folder').value.trim();
    if (!prefabFolder) {
        if (showError) {
            showToast('请选择预制体输出目录。', true);
        }
        return null;
    }
    return {
        sourceUrl: element<HTMLInputElement>('#source-url').value.trim(),
        assetFolder,
        prefabFolder,
        localResourceFolders: Array.from({ length: 3 }, (_, index) =>
            element<HTMLInputElement>(`#local-resource-folder-${index}`).value.trim(),
        ),
        localResourceFolder: element<HTMLInputElement>('#local-resource-folder-0').value.trim(),
        scale,
        updateExisting: element<HTMLInputElement>('#update-existing').checked,
        refreshAssets: element<HTMLInputElement>('#refresh-assets').checked,
        autoSave: element<HTMLInputElement>('#auto-save').checked,
        importHiddenLayers: element<HTMLInputElement>('#import-hidden-layers').checked,
        fontMap,
    };
}

async function persistPanelSettings(settings: ImportSettings): Promise<void> {
    state.settings = { ...settings, fontMap: { ...settings.fontMap } };
    await request('save-settings', state.settings);
}

function setBusy(value: boolean): void {
    value = value || Boolean(workflow?.pending);
    state.busy = value;
    // Capture editable control states before the existing button lock changes them.
    workflow?.render();
    element<HTMLButtonElement>('#fetch-document').disabled = value;
    element<HTMLButtonElement>('#save-token').disabled = value;
    element<HTMLButtonElement>('#pick-asset-folder').disabled = value;
    element<HTMLButtonElement>('#pick-prefab-folder').disabled = value;
    element<HTMLButtonElement>('#roundtrip-detect').disabled = value;
    element<HTMLButtonElement>('#roundtrip-preview').disabled = value
        || element<HTMLSelectElement>('#roundtrip-root').value === '';
    element<HTMLButtonElement>('#roundtrip-pair').disabled = value || !roundtripPairToken;
    element<HTMLButtonElement>('#roundtrip-apply').disabled = value || !roundtripPreviewToken;
    for (let index = 0; index < 3; index += 1) {
        element<HTMLButtonElement>(`#pick-local-resource-folder-${index}`).disabled = value;
        element<HTMLButtonElement>(`#clear-local-resource-folder-${index}`).disabled = value;
    }
    element<HTMLButtonElement>('#import-button').disabled = value
        || !state.document
        || !state.runtimeCompatible;
    element('#cancel-import').classList.toggle('is-hidden', !value);
    workflow?.render();
    if (!value) renderNodeProperties();
}

function resetRoundtripTokens(): void {
    roundtripPreviewToken = undefined;
    roundtripPairToken = undefined;
    element<HTMLButtonElement>('#roundtrip-pair').disabled = true;
    element<HTMLButtonElement>('#roundtrip-apply').disabled = true;
}

function roundtripSource(): string | null {
    const source = element<HTMLInputElement>('#source-url').value.trim();
    if (!source) {
        showToast('请输入 Figma 文件或节点链接。', true);
        return null;
    }
    return source;
}

function renderRoundtripPreview(preview: RoundtripPreviewDto): void {
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
    element<HTMLButtonElement>('#roundtrip-pair').disabled = !roundtripPairToken;
    element<HTMLButtonElement>('#roundtrip-apply').disabled = !roundtripPreviewToken;
}

function updateTargetHint(): void {
    if (!state.runtimeCompatible) {
        element('#action-note').textContent = '主进程与面板版本不一致，需要完整重启 Cocos Creator';
        return;
    }
    element('#action-note').textContent = '导入到当前场景 Canvas 根节点下；Frame 链接将自动创建并打开预制体';
}

function resetImportButton(): void {
    const button = element<HTMLButtonElement>('#import-button');
    button.classList.remove('is-running', 'is-success', 'is-error');
    button.removeAttribute('aria-busy');
    button.title = '导入到当前打开场景或预制体';
    element('#import-button-label').textContent = '开始导入';
    element('#import-button-percent').textContent = '→';
    (element('#import-button-progress') as HTMLElement).style.width = '0%';
}

function importProgress(event: ProgressEvent): number {
    const value = Math.max(0, Math.min(1, event.value));
    if (event.phase === 'assets') {
        return 0.05 + value * 0.55;
    }
    if (event.phase === 'scene') {
        return 0.6 + value * 0.38;
    }
    return event.phase === 'done' ? 1 : 0;
}

function updateProgress(event: ProgressEvent): void {
    if (event.batch && batchItems.length) {
        batchProgress = event.batch;
        const currentRow = event.batch.items.find((item) => item.id === event.batch!.itemId);
        const current = currentRow?.status === 'running' ? importProgress(event) : 0;
        event = {
            ...event,
            value: Math.min(1, (event.batch.completed + current) / Math.max(1, event.batch.total)),
            message: `${event.batch.index} / ${event.batch.total} · ${event.batch.name} · ${event.message}`,
        };
        renderBatchResults();
    }
    if (['fetch', 'assets', 'scene'].includes(event.phase)) setBusy(true);
    workflow?.progress(event);
    const region = element('#progress-region');
    const busy = ['fetch', 'assets', 'scene'].includes(event.phase);
    region.classList.toggle('is-busy', busy);
    region.classList.toggle('is-error', event.phase === 'error');
    element('#progress-label').textContent = event.message;
    const value = Math.max(0, Math.min(1, event.value));
    element('#progress-percent').textContent = `${Math.round(value * 100)}%`;
    (element('#progress-bar') as HTMLElement).style.width = `${value * 100}%`;
    const button = element<HTMLButtonElement>('#import-button');
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
        (element('#import-button-progress') as HTMLElement).style.width = `${progress * 100}%`;
    } else if (event.phase === 'done') {
        button.classList.remove('is-running', 'is-error');
        button.classList.add('is-success');
        button.removeAttribute('aria-busy');
        element('#import-button-label').textContent = '导入完成';
        element('#import-button-percent').textContent = '100%';
        (element('#import-button-progress') as HTMLElement).style.width = '100%';
        importButtonResetTimer = setTimeout(resetImportButton, 1400);
    } else if (event.phase === 'error' || event.phase === 'cancelled') {
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
    if (event.phase === 'done' && !workflow?.pending && pendingImportReview) {
        const review = pendingImportReview;
        pendingImportReview = null;
        workflow?.complete({ review });
        importReviewPanel?.open(review);
    }
    if (event.batch?.result && !batchImportPending && batchItems.length) {
        if (batchRecoveryTimer) clearTimeout(batchRecoveryTimer);
        workflow?.end(); setBusy(false); completeBatchPresentation(event.batch.result);
    }
}

function descendants(node: TreeNodeDto): TreeNodeDto[] {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function reconcileActions(): void {
    state.patches = defaultNineSliceIds(state.document?.tree ?? []);
    const effective = resolveEffectiveActions(
        state.document?.tree ?? [],
        state.preferredActions,
        state.patches,
        state.explicitIds,
        state.renamedIds,
        state.settings.importHiddenLayers !== false,
    );
    state.actions = effective.actions;
    state.suppressed = effective.suppressed;
}

function reconcileBatchVisibility(): void {
    rememberActiveFrame();
    for (const entry of batchItems) {
        if (!entry.editor?.document) continue;
        const editor = entry.editor;
        const effective = resolveEffectiveActions(editor.document!.tree, editor.preferredActions,
            editor.patches, editor.explicitIds, editor.renamedIds, state.settings.importHiddenLayers !== false);
        editor.actions = effective.actions;
        editor.suppressed = effective.suppressed;
    }
    reconcileActions();
    rememberActiveFrame();
}

async function setImportHiddenLayers(enabled: boolean): Promise<void> {
    if (state.busy) return;
    element<HTMLInputElement>('#import-hidden-layers').checked = enabled;
    const settings = readSettings(false) ?? { ...state.settings, importHiddenLayers: enabled };
    state.settings = settings;
    reconcileBatchVisibility();
    renderTree(); renderFontMap(); updateSummary();
    await persistPanelSettings(settings);
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active && ignoredHiddenFrame(active) && selectedFrames().length) await activateFrame(selectedFrames()[0].item.id);
}

function setAction(node: TreeNodeDto, action: ImportAction): void {
    state.preferredActions.set(node.id, safeAction(node, action));
    reconcileActions();
}

function effectiveNodeName(node: TreeNodeDto): string {
    return state.names.get(node.id) ?? node.name;
}

function explicitOverrides(): ImportOverride[] {
    if (!state.document) {
        return [];
    }
    return flatten(state.document.tree)
        .filter((node) => state.explicitIds.has(node.id) || state.renamedIds.has(node.id))
        .map((node) => {
            const renamed = state.renamedIds.has(node.id);
            return normalizeFigmaSliceDecision({
                id: node.id,
                action: state.preferredActions.get(node.id) ?? smartActionForNode(node),
                kind: state.kinds.get(node.id) ?? node.kind,
                nineSlice: state.patches.has(node.id),
                explicit: state.explicitIds.has(node.id),
                ...(renamed ? { name: effectiveNodeName(node) } : {}),
            }, node.patchCandidate);
        });
}

function persistNodeOverrides(): void {
    if (!state.document) {
        return;
    }
    const fileKey = state.document.fileKey;
    const active = batchItems.find(({ item }) => item.id === activeBatchId);
    if (active) { active.configured = true; rememberActiveFrame(); renderBatch(); }
    const overrides = explicitOverrides();
    const scopeIds = flatten(state.document.tree).map((node) => node.id);
    // Serialize writes so a slower earlier request can never overwrite a newer
    // strategy snapshot after rapid select changes.
    nodeOverrideSaveTask = nodeOverrideSaveTask
        .catch(() => undefined)
        .then(async () => {
            await request<ImportOverride[]>('save-node-overrides', fileKey, overrides, scopeIds);
        })
        .catch((error) => {
            showToast(errorMessage(error, '节点策略保存失败。'), true);
        });
}

function matches(node: TreeNodeDto): boolean {
    if (!state.search) {
        return true;
    }
    const haystack = `${effectiveNodeName(node)} ${node.name} ${node.type} ${node.id}`.toLowerCase();
    if (haystack.includes(state.search)) {
        return true;
    }
    return node.children.some(matches);
}

function option(value: string, label: string): HTMLOptionElement {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
}

function makeSelect(
    className: string,
    value: string,
    items: Array<[string, string]>,
    label: string,
): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = className;
    select.setAttribute('aria-label', label);
    for (const [key, text] of items) {
        select.appendChild(option(key, text));
    }
    select.value = value;
    return select;
}

function appendTreeNode(container: HTMLElement, node: TreeNodeDto, depth: number): void {
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
    dot.className = `type-dot ${
        node.type === 'TEXT' ? 'text'
            : isVectorNodeType(node.type) ? 'vector'
                : node.type.includes('COMPONENT') || node.type === 'INSTANCE' ? 'component'
                    : ''
    }`;
    const copy = document.createElement('div');
    copy.className = 'node-copy';
    const displayName = effectiveNodeName(node);
    const name = document.createElement('div');
    name.className = `node-name${state.renamedIds.has(node.id) ? ' is-renamed' : ''}`;
    name.textContent = displayName;
    const strategySummary = strategySummaryForNode(node, state.explicitIds.has(node.id));
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
    const selectedAction = safeAction(node, state.actions.get(node.id) ?? node.action);
    actionBadge.textContent = actionOptionsForNode(node).find(([value]) => value === selectedAction)?.[1] ?? selectedAction;
    actionBadge.title = strategySummary.strategy || actionBadge.textContent;
    row.append(main, actionBadge);
    container.appendChild(row);

    if (!state.collapsed.has(node.id) || state.search) {
        node.children.forEach((child) => appendTreeNode(container, child, depth + 1));
    }
}

function renderNodeProperties(): void {
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
    const field = (label: string, control: HTMLElement): void => {
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

    const selectedAction = safeAction(node, state.actions.get(node.id) ?? node.action);
    const actionOptions = actionOptionsForNode(node);
    const action = makeSelect(
        'action-select',
        selectedAction,
        actionOptions,
        `${displayName} 导入方式`,
    );
    action.dataset.actionFor = node.id;
    action.disabled = state.busy;
    field('导入方式', action);

    const selectedKind = state.kinds.get(node.id) ?? node.kind;
    const effectiveKind = effectiveKindForNode(
        node,
        selectedKind,
        selectedAction,
        state.patches.has(node.id),
    );
    const kindOptions = kindOptionsForAction(selectedAction);
    const kind = makeSelect(
        'kind-select',
        effectiveKind,
        kindOptions,
        `${displayName} 节点类型`,
    );
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
    const summary = strategySummaryForNode(node, state.explicitIds.has(node.id));
    const note = document.createElement('div');
    note.className = 'node-inspector-note';
    const hiddenIgnored = hiddenLayerIds(state.document?.tree ?? [], state.settings.importHiddenLayers !== false).has(node.id);
    for (const text of [hiddenIgnored ? '隐藏图层 · 本次忽略（含其子树）；开启“导入隐藏图层”可恢复原策略' : undefined,
        summary.strategy, `Figma 原名：${node.name}`, summary.warning]) {
        if (!text) continue;
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        if (text === summary.warning) paragraph.className = 'node-warning';
        note.appendChild(paragraph);
    }
    container.appendChild(note);
}

function renderTree(resetScroll = false): void {
    const tree = element('#tree');
    rerenderPreservingScroll(tree, () => {
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

function updateSummary(): void {
    if (batchItems.length) { rememberActiveFrame(); renderBatch(); }
    const nodes = state.document ? flatten(state.document.tree) : [];
    const selected = nodes.filter((node) => state.actions.get(node.id) !== 'ignore');
    element('#node-count').textContent = `${nodes.length} 节点`;
    element('#selection-summary').textContent = state.document
        ? `${selected.length} / ${nodes.length} 个节点将参与导入`
        : '等待设计数据';
    element<HTMLButtonElement>('#import-button').disabled = state.busy
        || !state.document
        || !selected.length
        || !state.runtimeCompatible;
    workflow?.render();
}

async function preview(node: TreeNodeDto): Promise<void> {
    if (state.busy) {
        return;
    }
    state.selectedId = node.id;
    const revision = ++previewRevision;
    const frameId = activeBatchId;
    renderTree();
    element('#preview-meta').textContent = `${effectiveNodeName(node)} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    const stage = element('#preview-stage');
    const image = element<HTMLImageElement>('#preview-image');
    stage.classList.add('is-loading');
    stage.classList.remove('has-image');
    image.removeAttribute('src');
    try {
        const precedingSync = batchSyncTask;
        const read = previewReadTask.catch(() => undefined).then(async () => {
            await precedingSync;
            if (previewRevision !== revision || frameId !== activeBatchId) return null;
            return request<{ url: string }>('get-preview', node.id);
        });
        previewReadTask = read.catch(() => undefined);
        const result = await read;
        if (!result) return;
        if (state.selectedId !== node.id || previewRevision !== revision || frameId !== activeBatchId) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('预览图片加载失败。'));
            image.src = result.url;
        });
        if (previewRevision === revision) stage.classList.add('has-image');
    } catch (error) {
        if (previewRevision === revision) showToast(error instanceof Error ? error.message : '预览失败。', true);
    } finally {
        if (previewRevision === revision) stage.classList.remove('is-loading');
    }
}

function applyPreset(name: string): void {
    if (!state.document) {
        return;
    }
    const all = flatten(state.document.tree);
    if (name === 'smart') {
        state.explicitIds.clear();
        state.patches = defaultNineSliceIds(state.document.tree);
        for (const node of all) {
            const original = state.defaults.get(node.id)!;
            state.preferredActions.set(node.id, original.action);
            state.kinds.set(node.id, original.kind);
        }
    } else if (name === 'editable') {
        for (const node of all) {
            state.preferredActions.set(node.id, isVectorNodeType(node.type) ? 'render' : 'generate');
            state.explicitIds.add(node.id);
        }
    } else {
        for (const node of all) {
            state.preferredActions.set(node.id, node.children.length
                ? 'generate'
                : 'render');
            state.explicitIds.add(node.id);
        }
    }
    reconcileActions();
    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.classList.toggle('active', button.dataset.preset === name);
    });
    renderTree();
    updateSummary();
    persistNodeOverrides();
}

async function importToScene(): Promise<void> {
    if (workflow && workflow.step !== 3) return;
    if (!state.runtimeCompatible) {
        showToast('扩展主进程仍是旧版，请保存项目并完整重启 Cocos Creator。', true);
        return;
    }
    if (!state.document || state.busy) {
        return;
    }
    const settings = readSettings();
    if (!settings) {
        workflow?.fail('请检查导入倍率与输出目录，修正后再次导入。');
        return;
    }
    state.settings = settings;
    reconcileBatchVisibility();
    if (batchItems.length) {
        await importBatchFrames(settings);
        return;
    }
    const overrides: ImportOverride[] = flatten(state.document.tree).map((node) => normalizeFigmaSliceDecision({
        id: node.id,
        action: state.actions.get(node.id) ?? node.action,
        kind: state.kinds.get(node.id) ?? node.kind,
        nineSlice: state.patches.has(node.id),
        explicit: state.explicitIds.has(node.id),
        ...(state.renamedIds.has(node.id) ? { name: effectiveNodeName(node) } : {}),
    }, node.patchCandidate));
    workflow?.begin('import');
    setBusy(true);
    updateProgress({ phase: 'assets', value: 0, message: '正在准备导入…' });
    try {
        const result = await request<WorkflowResult>(
            'import-selection',
            { overrides, settings },
        );
        const fallbackNote = result?.warnings?.length
            ? `；${result.warnings.length} 条导入/收尾提示（详见结果检查）`
            : '';
        showToast(result?.prefabUrl
            ? `导入完成，已创建预制体：${result.prefabUrl}${fallbackNote}`
            : `导入完成，已在场景中选中根节点${fallbackNote}。`);
        workflow?.complete(result);
        const review = result.review ?? pendingImportReview;
        pendingImportReview = null;
        if (review) importReviewPanel?.open(review);
    } catch (error) {
        const message = errorMessage(error, '导入失败。');
        updateProgress({ phase: workflow?.cancelled ? 'cancelled' : 'error', value: 0, message });
        showToast(message, !workflow?.cancelled);
    } finally {
        workflow?.end();
        setBusy(false);
        updateSummary();
    }
}

function mergeBatchItems(items: BatchFrameItem[]): void {
    for (const item of items) {
        const previous = batchItems.find((entry) => entry.item.id === item.id);
        if (previous) previous.item = { ...item, enabled: previous.item.enabled };
        else batchItems.push({ item, editor: initialFrameEditor(item.document), configured: Boolean(item.document.nodeOverrides?.length) });
    }
}

async function readBatchSource(): Promise<void> {
    if (state.busy) return;
    if (workflow && !workflow.credentialsReady) { workflow.openCredentials(); return; }
    const source = element<HTMLInputElement>('#source-url').value.trim();
    if (!source) { showToast('请粘贴 Figma Section 或 Frame 链接。', true); return; }
    rememberActiveFrame();
    const settings = readSettings(false); if (settings) state.settings = settings;
    workflow?.begin('fetch'); setBusy(true);
    updateProgress({ phase: 'fetch', value: 0.05, message: '正在读取并识别 Figma 界面…' });
    let activate: string | undefined;
    try {
        await waitForBatchListReady();
        const result = await request<BatchSourceResult>('resolve-batch-source', source);
        if (result.document && !result.items.length) {
            batchItems = []; activeBatchId = undefined; batchResult = undefined; batchProgress = undefined;
            syncBatchItems();
            state.fontAssets = result.document.fontAssets ?? state.fontAssets;
            initializeDocument(result.document);
        } else {
            mergeBatchItems(result.items);
            batchResult = undefined; batchProgress = undefined;
            state.fontAssets = Array.from(new Map(batchItems.flatMap(({ item }) => item.document.fontAssets ?? []).map((font) => [font.url, font])).values());
            activate = selectedFrames().find(({ item }) => item.id === activeBatchId)?.item.id ?? selectedFrames()[0]?.item.id ?? batchItems[0]?.item.id;
            activeBatchId = undefined;
            syncBatchItems();
            element<HTMLInputElement>('#source-url').value = '';
            workflow?.batchReady();
            showToast(`已添加 ${result.added} 个界面${result.duplicates ? `，跳过 ${result.duplicates} 个重复项` : ''}。`);
        }
    } catch (error) {
        const message = errorMessage(error, '读取失败。');
        if (!workflow?.cancelled) workflow?.fail(message);
        showToast(workflow?.cancelled ? '读取已取消，配置已保留。' : message, !workflow?.cancelled);
    } finally {
        workflow?.end(); setBusy(false);
        if (activate) await activateFrame(activate);
        renderBatch(); updateSummary();
    }
}

function overridesForFrame(entry: FrameEditorItem): ImportOverride[] {
    const editor = entry.editor ?? initialFrameEditor(entry.item.document);
    return flatten(entry.item.document.tree).map((node) => normalizeFigmaSliceDecision({
        id: node.id, action: editor.actions.get(node.id) ?? node.action, kind: editor.kinds.get(node.id) ?? node.kind,
        nineSlice: editor.patches.has(node.id), explicit: editor.explicitIds.has(node.id),
        ...(editor.renamedIds.has(node.id) ? { name: editor.names.get(node.id) ?? node.name } : {}),
    }, node.patchCandidate));
}

async function importBatchFrames(settings: ImportSettings, ids?: Set<string>): Promise<void> {
    if (state.busy || batchImportPending) return;
    state.settings = settings;
    reconcileBatchVisibility();
    rememberActiveFrame();
    const entries = selectedFrames().filter(({ item }) => !ids || ids.has(item.id));
    if (!entries.length) { showToast('请先勾选要导入的界面。', true); return; }
    if (batchConflicts().size) { workflow?.fail('存在重复的 Prefab 文件名，请先在清单中改名。'); return; }
    batchImportPending = true; batchProgress = undefined; batchStopRequested = false;
    const previous = batchResult;
    workflow?.begin('import'); setBusy(true); renderBatch();
    updateProgress({ phase: 'assets', value: 0, message: `准备导入 ${entries.length} 个界面…` });
    try {
        await waitForBatchListReady();
        await nodeOverrideSaveTask;
        if (batchStopRequested) {
            completeBatchPresentation({ id: 'stopped-before-start', stopped: true, completed: 0, total: entries.length,
                items: entries.map(({ item }) => ({ id: item.id, name: item.name, sourceUrl: item.sourceUrl, status: 'pending' })) });
            return;
        }
        const result = await request<BatchImportResult>('import-batch', {
            items: entries.map((entry) => ({ id: entry.item.id, overrides: overridesForFrame(entry) })), settings,
            failurePolicy: 'continue', preserveResults: Boolean(ids),
        });
        const merged = ids && previous ? previous.items.map((item) => result.items.find((next) => next.id === item.id) ?? item) : result.items;
        batchResult = { ...result, items: merged, total: merged.length, completed: merged.filter((item) => item.status === 'success' || item.status === 'failed').length };
        batchProgress = undefined; pendingImportReview = null;
        const created = merged.reduce((sum, item) => sum + (item.created ?? 0), 0);
        const updated = merged.reduce((sum, item) => sum + (item.updated ?? 0), 0);
        workflow?.complete({ created, updated, warnings: merged.flatMap((item) => item.warnings ?? []) });
        showToast(`本批完成：成功 ${merged.filter((item) => item.status === 'success').length} 项，失败 ${merged.filter((item) => item.status === 'failed').length} 项。`);
    } catch (error) {
        const message = errorMessage(error, '批量导入失败。');
        workflow?.fail(message); showToast(message, true);
    } finally {
        batchImportPending = false; workflow?.end(); setBusy(false); renderBatch(); updateSummary();
    }
}

async function retryBatch(status: 'failed' | 'pending'): Promise<void> {
    if (state.busy || !batchResult) return;
    const settings = readSettings(); if (!settings) return;
    const ids = new Set(batchResult.items.filter((item) => item.status === status).map((item) => item.id));
    await importBatchFrames(settings, ids);
}

function completeBatchPresentation(result: BatchImportResult): void {
    batchResult = result; batchProgress = undefined;
    workflow?.complete({
        created: result.items.reduce((sum, item) => sum + (item.created ?? 0), 0),
        updated: result.items.reduce((sum, item) => sum + (item.updated ?? 0), 0),
        warnings: result.items.flatMap((item) => item.warnings ?? []),
    });
    renderBatch();
}

function watchRestoredBatch(): void {
    batchRecoveryTimer = setTimeout(async () => {
        if (!panelHost) return;
        try {
            const recovered = await request<BatchState>('get-batch-state');
            if (recovered.running) {
                batchProgress = recovered.running; renderBatchResults(); watchRestoredBatch(); return;
            }
            workflow?.end(); setBusy(false);
            if (recovered.lastResult) completeBatchPresentation(recovered.lastResult);
            else workflow?.fail('后台批量任务已经结束，请检查 Cocos 中的导入结果。');
        } catch (error) {
            workflow?.end(); setBusy(false); workflow?.fail(errorMessage(error, '读取后台批量任务失败。'));
        }
    }, 800);
}

async function openImportReview(tab: 'assets' | 'nodes' | 'source' = 'assets'): Promise<void> {
    if (state.busy) return;
    try {
        const review = await request<ImportReview | null>('get-import-review');
        if (review) {
            importReviewPanel?.open(review);
            const index = ['assets', 'nodes', 'source'].indexOf(tab);
            if (index > 0) element('#import-review-dialog').querySelectorAll<HTMLButtonElement>('.review-tabs button')[index]?.click();
        } else showToast('本次插件会话尚无导入检查结果，请先完成一次导入。');
    } catch (error) { showToast(errorMessage(error, '读取检查结果失败。'), true); }
}

function bindEvents(): void {
    element('#open-import-review').addEventListener('click', () => { void openImportReview(); });
    element('#save-token').addEventListener('click', async () => {
        const input = element<HTMLInputElement>('#token-input');
        if (!input.value.trim()) {
            showToast('请输入 Figma Token。', true);
            return;
        }
        let saved = false;
        setBusy(true);
        try {
            const vault = await request<any>('set-token', input.value);
            input.value = '';
            setConnection(vault);
            saved = true;
            showToast(vault.persistent ? 'Token 已由系统加密保存。' : 'Token 已保存到本次会话。');
        } catch (error) {
            showToast(error instanceof Error ? error.message : '保存失败。', true);
        } finally {
            setBusy(false);
            if (saved) workflow?.closeCredentials();
        }
    });

    element('#verify-token').addEventListener('click', async () => {
        setBusy(true);
        try {
            const result = await request<{ handle: string }>('verify-token');
            showToast(`连接成功 · ${result.handle}`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : '连接失败。', true);
        } finally {
            setBusy(false);
        }
    });

    element('#clear-token').addEventListener('click', async () => {
        const vault = await request<any>('clear-token');
        setConnection(vault);
        showToast('已清除保存的 Figma 凭据。');
    });

    element('#roundtrip-detect').addEventListener('click', async () => {
        const source = roundtripSource();
        if (!source) return;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const detected = await request<RoundtripDetectDto>('roundtrip-detect', source);
            const select = element<HTMLSelectElement>('#roundtrip-root');
            select.replaceChildren();
            for (const root of detected.managedRoots) {
                const option = document.createElement('option');
                option.value = root.nodeId;
                option.textContent = root.error
                    ? `${root.name} · 协议损坏`
                    : `${root.name} · ${root.prefabUuid ?? '未知 Prefab'}`;
                option.disabled = Boolean(root.error);
                select.append(option);
            }
            select.value = detected.selectedRootId
                ?? detected.managedRoots.find((root) => !root.error)?.nodeId
                ?? '';
            select.disabled = detected.managedRoots.length === 0;
            element('#roundtrip-summary').textContent = detected.managedRoots.length
                ? `检测到 ${detected.managedRoots.length} 个 managed root · Figma ${detected.figmaVersion}。选择目标后生成只读预览。`
                : '未检测到 managed root。';
        } catch (error) {
            showToast(errorMessage(error, 'Round-trip 检测失败。'), true);
        } finally {
            setBusy(false);
        }
    });

    element('#roundtrip-root').addEventListener('change', () => {
        resetRoundtripTokens();
        element<HTMLButtonElement>('#roundtrip-preview').disabled =
            element<HTMLSelectElement>('#roundtrip-root').value === '';
    });

    element('#roundtrip-preview').addEventListener('click', async () => {
        const source = roundtripSource();
        const rootId = element<HTMLSelectElement>('#roundtrip-root').value;
        if (!source || !rootId) return;
        resetRoundtripTokens();
        setBusy(true);
        try {
            renderRoundtripPreview(await request<RoundtripPreviewDto>('roundtrip-preview', source, rootId));
        } catch (error) {
            showToast(errorMessage(error, 'Round-trip 预览失败。'), true);
        } finally {
            setBusy(false);
        }
    });

    element('#roundtrip-pair').addEventListener('click', async () => {
        if (!roundtripPairToken) return;
        const token = roundtripPairToken;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const paired = await request<{ generation: number; baselineHash: string }>('roundtrip-pair', token);
            element('#roundtrip-summary').textContent = `配对完成 · Ledger generation ${paired.generation}\nBaseline ${paired.baselineHash}\n请重新生成变更预览。`;
            showToast('Surface 已配对；未修改 Prefab。');
        } catch (error) {
            showToast(errorMessage(error, 'Round-trip Pair 失败。'), true);
        } finally {
            setBusy(false);
        }
    });

    element('#roundtrip-apply').addEventListener('click', async () => {
        if (!roundtripPreviewToken) return;
        const token = roundtripPreviewToken;
        resetRoundtripTokens();
        setBusy(true);
        try {
            const receipt = await request<{ txnId: string; prefabPostimageHash: string }>('roundtrip-apply', token);
            element('#roundtrip-summary').textContent = `事务已提交 · ${receipt.txnId}\nPostimage ${receipt.prefabPostimageHash}\n请重新预览以确认 0 patch。`;
            showToast('Round-trip 已原子应用到原 Prefab。');
        } catch (error) {
            showToast(errorMessage(error, 'Round-trip 应用失败，事务已回滚。'), true);
        } finally {
            setBusy(false);
        }
    });

    element('#roundtrip-cancel').addEventListener('click', () => request('roundtrip-cancel'));

    element('#fetch-document').addEventListener('click', async () => {
        if (state.busy) return;
        const forceRead = forceDocumentRead;
        forceDocumentRead = false;
        if (workflow && !workflow.credentialsReady) {
            workflow.openCredentials();
            return;
        }
        if (batchItems.length && !forceRead) {
            const selected = selectedFrames();
            if (!selected.length) return;
            await activateFrame(selected.some(({ item }) => item.id === activeBatchId) ? activeBatchId! : selected[0].item.id, true);
            return;
        }
        if (forceRead && batchItems.length) {
            const active = batchItems.find(({ item }) => item.id === activeBatchId);
            if (active) element<HTMLInputElement>('#source-url').value = active.item.sourceUrl;
        }
        if (!forceRead && workflow?.sourceUnchanged()) {
            workflow.navigate(2);
            return;
        }
        await readBatchSource();
    });
    element('#add-batch-source').addEventListener('click', readBatchSource);
    element('#batch-edit-list').addEventListener('click', () => workflow?.navigate(1));
    element('#batch-toggle-all').addEventListener('click', () => {
        if (state.busy) return;
        const available = availableFrames();
        const enabled = selectedFrames().length !== available.length;
        available.forEach(({ item }) => { item.enabled = enabled; });
        syncBatchItems(); renderBatch(); renderFontMap(); workflow?.render();
    });
    element('#batch-retry-failed').addEventListener('click', () => retryBatch('failed'));
    element('#batch-resume-pending').addEventListener('click', () => retryBatch('pending'));
    element('#refresh-document').addEventListener('click', () => {
        if (state.busy) return;
        forceDocumentRead = true;
        element<HTMLButtonElement>('#fetch-document').click();
    });

    element<HTMLInputElement>('#source-url').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            element<HTMLButtonElement>('#add-batch-source').click();
        }
    });
    element<HTMLInputElement>('#source-url').addEventListener('input', resetRoundtripTokens);
    element('#pick-asset-folder').addEventListener('click', async () => {
        try {
            const current = element<HTMLInputElement>('#asset-folder').value;
            const result = await request<{ folder: string; absolutePath: string } | null>(
                'pick-asset-folder',
                current,
            );
            if (!result) {
                return;
            }
            const input = element<HTMLInputElement>('#asset-folder');
            input.value = result.folder;
            input.title = result.absolutePath;
            const settings = readSettings(false);
            if (settings) {
                await persistPanelSettings(settings);
            }
            showToast(`资源将写入 assets/${result.folder}`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : '选择资源目录失败。', true);
        }
    });
    element('#pick-prefab-folder').addEventListener('click', async () => {
        try {
            const current = element<HTMLInputElement>('#prefab-folder').value;
            const result = await request<{ folder: string; absolutePath: string } | null>(
                'pick-prefab-folder',
                current,
            );
            if (!result) {
                return;
            }
            const input = element<HTMLInputElement>('#prefab-folder');
            input.value = result.folder;
            input.title = result.absolutePath;
            const settings = readSettings(false);
            if (settings) {
                await persistPanelSettings(settings);
            }
            showToast(`预制体将写入 assets/${result.folder}`);
        } catch (error) {
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
            const current = element<HTMLInputElement>(`#local-resource-folder-${index}`).value;
            const result = await request<{ folder: string } | null>(
                'pick-local-resource-folder',
                current,
                index,
            );
            if (!result) {
                return;
            }
            const input = element<HTMLInputElement>(`#local-resource-folder-${index}`);
            input.value = result.folder;
            input.title = result.folder;
            const settings = readSettings(false);
            if (settings) {
                await persistPanelSettings(settings);
            }
            showToast(`已启用本地同名资源目录 ${index + 1}。`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : '选择本地资源目录失败。', true);
        }
        });
        element(`#clear-local-resource-folder-${index}`).addEventListener('click', async () => {
        if (!state.runtimeCompatible) {
            showToast('请先保存项目并完整重启 Cocos Creator。', true);
            return;
        }
        const input = element<HTMLInputElement>(`#local-resource-folder-${index}`);
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
        if (!state.busy) return;
        if (batchImportPending) batchStopRequested = true;
        workflow?.cancelRequested();
        try { await request(batchImportPending ? 'stop-import-batch' : 'cancel-import'); }
        catch (error) {
            const message = errorMessage(error, '取消请求失败，请稍后重试。');
            workflow?.cancelRequestFailed(message);
            showToast(message, true);
        }
    });

    element<HTMLInputElement>('#tree-search').addEventListener('input', (event) => {
        state.search = (event.target as HTMLInputElement).value.trim().toLowerCase();
        renderTree();
    });

    element('#tree').addEventListener('click', (event) => {
        if (state.busy) return;
        const target = event.target as HTMLElement;
        const collapseId = target.closest<HTMLElement>('[data-collapse]')?.dataset.collapse;
        if (collapseId) {
            if (state.collapsed.has(collapseId)) {
                state.collapsed.delete(collapseId);
            } else {
                state.collapsed.add(collapseId);
            }
            renderTree();
            return;
        }
        if (target.closest('select, label, input, textarea')) {
            return;
        }
        const id = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        const node = id ? findNode(id) : undefined;
        if (node) {
            void preview(node);
        }
    });

    root().addEventListener('change', (event) => {
        if (state.busy) return;
        const target = event.target as HTMLInputElement | HTMLSelectElement;
        if (!target.dataset.nameFor && !target.dataset.actionFor && !target.dataset.kindFor && !target.dataset.patchFor) return;
        if (target.dataset.nameFor) {
            const node = findNode(target.dataset.nameFor);
            if (!node) return;
            const customName = sanitizeNodeName(target.value);
            if (!customName) {
                target.value = effectiveNodeName(node);
                showToast('节点名不能为空。', true);
                return;
            }
            state.names.set(node.id, customName);
            if (customName === node.name) {
                state.renamedIds.delete(node.id);
            } else {
                state.renamedIds.add(node.id);
            }
            renderTree();
            persistNodeOverrides();
            showToast(state.renamedIds.has(node.id)
                ? `节点将以“${customName}”导入。`
                : '已恢复 Figma 原节点名。');
        } else if (target.dataset.actionFor) {
            const node = findNode(target.dataset.actionFor);
            if (node) {
                const action = safeAction(node, target.value);
                state.explicitIds.add(node.id);
                if (action !== 'render' && !node.patchCandidate) {
                    state.patches.delete(node.id);
                }
                setAction(node, action);
                root().querySelectorAll<HTMLElement>('[data-preset]')
                    .forEach((button) => button.classList.remove('active'));
                if (action === 'render' && node.children.length) {
                    showToast(`“${effectiveNodeName(node)}”将作为整层导入，${descendants(node).length} 个子节点不会单独生成。`);
                }
                renderTree();
                persistNodeOverrides();
            }
        } else if (target.dataset.kindFor) {
            state.kinds.set(target.dataset.kindFor, target.value as NodeKind);
            state.explicitIds.add(target.dataset.kindFor);
            root().querySelectorAll<HTMLElement>('[data-preset]')
                .forEach((button) => button.classList.remove('active'));
            renderTree();
            persistNodeOverrides();
        } else if (target.dataset.patchFor) {
            // Also reject a stale panel/programmatic attempt to disable a valid
            // Figma definition; the source decision is shared with the importer.
            reconcileActions();
            renderTree();
            if (findNode(target.dataset.patchFor)?.patchCandidate) showToast('Figma 分片优先，不能关闭；可在导入方式中忽略整个节点。');
        }
        updateSummary();
    });

    root().addEventListener('keydown', (event) => {
        const target = event.target as HTMLInputElement;
        const id = target.dataset.nameFor;
        if (!id) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            target.blur();
        } else if (event.key === 'Escape') {
            const node = findNode(id);
            if (node) target.value = effectiveNodeName(node);
            target.blur();
        }
    });

    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.addEventListener('click', () => applyPreset(button.dataset.preset ?? 'smart'));
    });

    element('#import-hidden-layers').addEventListener('change', async () => {
        await setImportHiddenLayers(element<HTMLInputElement>('#import-hidden-layers').checked);
    });

    root().querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '#scale, #asset-folder, #prefab-folder, #local-resource-folder, #update-existing, #refresh-assets, #auto-save',
    ).forEach((control) => {
        control.addEventListener('change', async () => {
            const settings = readSettings(false);
            if (settings) {
                await persistPanelSettings(settings);
            }
        });
    });
    element('#font-map-list').addEventListener('change', async (event) => {
        const select = event.target as HTMLSelectElement;
        const family = select.dataset.fontFamily?.trim();
        if (!family) return;
        // An empty string records an explicit opt-out from automatic matching.
        // Unrendered families and temporarily unavailable assets stay intact.
        state.settings = { ...state.settings, fontMap: { ...state.settings.fontMap, [family]: select.value } };
        const settings = readSettings(false) ?? state.settings;
        await persistPanelSettings(settings);
    });
}

module.exports = Editor.Panel.define({
    listeners: {
        show() {},
        hide() {},
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf8'),
    $: {
        app: '#app',
    },
    methods: {
        onImportReviewReady(review: ImportReview) {
            if (batchItems.length) { workflow?.rememberReview(); return; }
            if (state.busy || workflow?.pending) {
                pendingImportReview = review;
                return;
            }
            workflow?.complete({ review });
            importReviewPanel?.open(review);
        },
        onProgress(event: ProgressEvent) {
            updateProgress(event);
        },
    },
    async ready() {
        panelHost = this;
        importReviewPanel = new ImportReviewPanel(root(), request, setBusy);
        workflow = new PanelWorkflow(root(), () => ({ ...state, batch: batchContext() }), (tab) => { void openImportReview(tab); });
        bindEvents();
        try {
            const initial = await request<{
                version?: string;
                vault: any;
                settings: ImportSettings;
                document: DocumentDto | null;
                fontAssets?: FontAssetOption[];
            }>('get-state');
            state.runtimeCompatible = initial.version === packageJSON.version;
            state.fontAssets = initial.fontAssets ?? [];
            setConnection(initial.vault);
            applySettings(initial.settings);
            if (initial.document) {
                initializeDocument(initial.document);
            }
            const batch = await request<BatchState | undefined>('get-batch-state');
            if (batch?.items.length) {
                mergeBatchItems(batch.items);
                state.fontAssets = Array.from(new Map(batch.items.flatMap((item) => item.document.fontAssets ?? []).map((font) => [font.url, font])).values());
                workflow.batchReady();
                const active = selectedFrames()[0] ?? batchItems[0];
                if (batch.running) {
                    activeBatchId = active.item.id;
                    Object.assign(state, active.editor);
                    renderTree(); renderFontMap();
                } else await activateFrame(active.item.id);
                renderBatch();
                if (batch.lastResult) completeBatchPresentation(batch.lastResult);
                if (batch.running) {
                    batchProgress = batch.running; workflow.begin('import'); setBusy(true); watchRestoredBatch();
                }
            }
            if (!state.runtimeCompatible) {
                updateSummary();
                const button = element<HTMLButtonElement>('#import-button');
                button.classList.add('is-error');
                element('#import-button-label').textContent = '请重启 Cocos';
                element('#import-button-percent').textContent = '↻';
                showToast('检测到旧版主进程仍在运行：请保存项目并完整重启 Cocos Creator。', true);
            } else {
                // Replay persisted in-memory report if completion preceded panel readiness.
                const review = await request<ImportReview | null>('get-import-review');
                if (review) workflow.rememberReview();
                if (review && !review.confirmed && !batchItems.length) {
                    workflow.complete({ review });
                    importReviewPanel?.open(review);
                }
            }
        } catch (error) {
            showToast(error instanceof Error ? error.message : '初始化失败。', true);
        }
    },
    beforeClose() {},
    close() {
        importReviewPanel?.dispose();
        importReviewPanel = null;
        workflow = null;
        pendingImportReview = null;
        if (toastTimer) clearTimeout(toastTimer);
        if (importButtonResetTimer) clearTimeout(importButtonResetTimer);
        if (batchRecoveryTimer) clearTimeout(batchRecoveryTimer);
        batchItems = []; activeBatchId = undefined; batchResult = undefined; batchProgress = undefined;
        batchImportPending = false; batchSyncError = undefined; batchSyncTask = Promise.resolve(); previewRevision++;
        previewReadTask = Promise.resolve();
        panelHost = null;
    },
});
