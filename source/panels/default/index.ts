import { readFileSync } from 'fs';
import { join } from 'path';
import packageJSON from '../../../package.json';
import { findFontAsset, type FontAssetOption } from '../../importer/fonts';
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
}

interface PanelState {
    document: DocumentDto | null;
    settings: ImportSettings;
    actions: Map<string, ImportAction>;
    kinds: Map<string, NodeKind>;
    patches: Set<string>;
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
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let importButtonResetTimer: ReturnType<typeof setTimeout> | null = null;

const VECTOR_NODE_TYPES = new Set([
    'VECTOR',
    'BOOLEAN_OPERATION',
    'STAR',
    'LINE',
    'REGULAR_POLYGON',
]);

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
        fontMap: {},
    },
    actions: new Map(),
    kinds: new Map(),
    patches: new Set(),
    defaults: new Map(),
    collapsed: new Set(),
    suppressed: new Set(),
    search: '',
    busy: false,
    runtimeCompatible: true,
    fontAssets: [],
};

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

function isVectorNodeType(type: string): boolean {
    return VECTOR_NODE_TYPES.has(type);
}

function renderFontMap(): void {
    const list = element('#font-map-list');
    list.replaceChildren();
    const families = state.document?.fonts ?? [];
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
        const selected = state.settings.fontMap[family] ?? automatic?.url ?? '';
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

function safeAction(_node: TreeNodeDto, action: ImportAction): ImportAction {
    return action === 'svg' ? 'render' : action;
}

function initializeDocument(document: DocumentDto): void {
    state.document = document;
    state.actions.clear();
    state.kinds.clear();
    state.patches.clear();
    state.defaults.clear();
    state.collapsed.clear();
    state.suppressed.clear();
    for (const node of flatten(document.tree)) {
        const inferred = safeAction(node, node.action);
        const action = node.children.length && terminal(inferred) && inferred !== 'merge'
            ? 'generate'
            : inferred;
        state.actions.set(node.id, action);
        state.kinds.set(node.id, node.kind);
        state.defaults.set(node.id, { action, kind: node.kind });
    }
    for (const node of flatten(document.tree)) {
        if (state.actions.get(node.id) === 'merge' && !state.suppressed.has(node.id)) {
            setAction(node, 'merge');
        }
    }
    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.classList.toggle('active', button.dataset.preset === 'smart');
    });
    element('#file-name').textContent = document.fileName;
    element<HTMLInputElement>('#source-url').value = document.sourceUrl;
    element('#font-hint').textContent = document.fonts.length
        ? `检测到：${document.fonts.join('、')}`
        : '当前文件尚未发现字体。';
    renderFontMap();
    renderTree();
    updateSummary();
}

function applySettings(settings: ImportSettings): void {
    state.settings = settings;
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
    updateTargetHint();
    renderFontMap();
}

function readSettings(showError = true): ImportSettings | null {
    const fontMap: Record<string, string> = { ...state.settings.fontMap };
    if (state.document) {
        for (const family of state.document.fonts) {
            delete fontMap[family];
        }
    }
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
        fontMap,
    };
}

function setBusy(value: boolean): void {
    state.busy = value;
    element<HTMLButtonElement>('#fetch-document').disabled = value;
    element<HTMLButtonElement>('#save-token').disabled = value;
    element<HTMLButtonElement>('#pick-asset-folder').disabled = value;
    element<HTMLButtonElement>('#pick-prefab-folder').disabled = value;
    for (let index = 0; index < 3; index += 1) {
        element<HTMLButtonElement>(`#pick-local-resource-folder-${index}`).disabled = value;
        element<HTMLButtonElement>(`#clear-local-resource-folder-${index}`).disabled = value;
    }
    element<HTMLButtonElement>('#import-button').disabled = value
        || !state.document
        || !state.runtimeCompatible;
    element('#cancel-import').classList.toggle('is-hidden', !value);
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
    element('#import-button-label').textContent = '导入到场景';
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
        const progress = importProgress(event);
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
}

function terminal(action: ImportAction): boolean {
    return action === 'render' || action === 'svg' || action === 'merge' || action === 'transform';
}

function descendants(node: TreeNodeDto): TreeNodeDto[] {
    return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function setAction(node: TreeNodeDto, action: ImportAction): void {
    action = safeAction(node, action);
    state.actions.set(node.id, action);
    if (terminal(action)) {
        for (const child of descendants(node)) {
            if (!state.suppressed.has(child.id)) {
                state.suppressed.add(child.id);
            }
            state.actions.set(child.id, 'ignore');
        }
    } else if (action === 'generate') {
        for (const child of descendants(node)) {
            if (state.suppressed.delete(child.id)) {
                state.actions.set(child.id, state.defaults.get(child.id)?.action ?? 'generate');
            }
        }
    }
}

function matches(node: TreeNodeDto): boolean {
    if (!state.search) {
        return true;
    }
    const haystack = `${node.name} ${node.type} ${node.id}`.toLowerCase();
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
            : node.type.includes('VECTOR') ? 'vector'
                : node.type.includes('COMPONENT') || node.type === 'INSTANCE' ? 'component'
                    : ''
    }`;
    const copy = document.createElement('div');
    copy.className = 'node-copy';
    const name = document.createElement('div');
    name.className = 'node-name';
    name.textContent = node.name;
    name.title = node.warning ? `${node.name} · ${node.warning}` : node.name;
    const meta = document.createElement('div');
    meta.className = 'node-meta';
    meta.textContent = `${node.type} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    copy.append(name, meta);
    main.append(collapse, dot, copy);

    const actionOptions: Array<[string, string]> = [
        ['ignore', '忽略'],
        ['generate', '生成'],
        ['render', 'PNG 整层'],
        ['merge', '合并子树'],
        ['transform', '更新'],
    ];
    const action = makeSelect(
        'action-select',
        safeAction(node, state.actions.get(node.id) ?? node.action),
        actionOptions,
        `${node.name} 导入方式`,
    );
    action.dataset.actionFor = node.id;

    const kind = makeSelect('kind-select', state.kinds.get(node.id) ?? node.kind, [
        ['auto', '自动'],
        ['node', 'Node'],
        ['sprite', 'Sprite'],
        ['label', 'Label'],
        ['button', 'Button'],
        ['scrollView', 'ScrollView'],
        ['layout', 'Layout'],
    ], `${node.name} 节点类型`);
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

function renderTree(): void {
    const tree = element('#tree');
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
        body.textContent = '读取 Figma 链接后，可逐层选择生成、渲染、SVG 或更新。';
        empty.append(glyph, title, body);
        tree.appendChild(empty);
        return;
    }
    state.document.tree.forEach((node) => appendTreeNode(tree, node, 0));
}

function updateSummary(): void {
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
}

async function preview(node: TreeNodeDto): Promise<void> {
    if (state.busy) {
        return;
    }
    state.selectedId = node.id;
    renderTree();
    element('#preview-meta').textContent = `${node.name} · ${Math.round(node.width)}×${Math.round(node.height)}`;
    const stage = element('#preview-stage');
    const image = element<HTMLImageElement>('#preview-image');
    stage.classList.add('is-loading');
    stage.classList.remove('has-image');
    image.removeAttribute('src');
    try {
        const result = await request<{ url: string }>('get-preview', node.id);
        if (state.selectedId !== node.id) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('预览图片加载失败。'));
            image.src = result.url;
        });
        stage.classList.add('has-image');
    } catch (error) {
        showToast(error instanceof Error ? error.message : '预览失败。', true);
    } finally {
        stage.classList.remove('is-loading');
    }
}

function applyPreset(name: string): void {
    if (!state.document) {
        return;
    }
    const all = flatten(state.document.tree);
    state.suppressed.clear();
    if (name === 'smart') {
        for (const node of all) {
            const original = state.defaults.get(node.id)!;
            state.actions.set(node.id, node.children.length && original.action !== 'merge'
                ? 'generate'
                : safeAction(node, original.action));
            state.kinds.set(node.id, original.kind);
        }
        for (const node of all) {
            if (state.actions.get(node.id) === 'merge' && !state.suppressed.has(node.id)) {
                setAction(node, 'merge');
            }
        }
    } else if (name === 'editable') {
        for (const node of all) {
            state.actions.set(node.id, isVectorNodeType(node.type) ? 'render' : 'generate');
        }
    } else {
        for (const node of all) {
            state.actions.set(node.id, !node.visible
                ? 'ignore'
                : node.children.length
                    ? 'generate'
                    : 'render');
        }
    }
    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.classList.toggle('active', button.dataset.preset === name);
    });
    renderTree();
    updateSummary();
}

async function importToScene(): Promise<void> {
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
    const overrides: ImportOverride[] = flatten(state.document.tree).map((node) => ({
        id: node.id,
        action: state.actions.get(node.id) ?? node.action,
        kind: state.kinds.get(node.id) ?? node.kind,
        nineSlice: state.patches.has(node.id),
    }));
    setBusy(true);
    updateProgress({ phase: 'assets', value: 0, message: '正在准备导入…' });
    try {
        const result = await request<{ prefabUrl?: string }>('import-selection', { overrides, settings });
        showToast(result?.prefabUrl
            ? `导入完成，已创建预制体：${result.prefabUrl}`
            : '导入完成，已在场景中选中根节点。');
    } catch (error) {
        const message = errorMessage(error, '导入失败。');
        updateProgress({ phase: 'error', value: 0, message });
        showToast(message, true);
    } finally {
        setBusy(false);
    }
}

function bindEvents(): void {
    element('#save-token').addEventListener('click', async () => {
        const input = element<HTMLInputElement>('#token-input');
        if (!input.value.trim()) {
            showToast('请输入 Figma Token。', true);
            return;
        }
        setBusy(true);
        try {
            const vault = await request<any>('set-token', input.value);
            input.value = '';
            setConnection(vault);
            showToast(vault.persistent ? 'Token 已由系统加密保存。' : 'Token 已保存到本次会话。');
        } catch (error) {
            showToast(error instanceof Error ? error.message : '保存失败。', true);
        } finally {
            setBusy(false);
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

    element('#fetch-document').addEventListener('click', async () => {
        const source = element<HTMLInputElement>('#source-url').value.trim();
        if (!source) {
            showToast('请输入 Figma 文件或节点链接。', true);
            return;
        }
        setBusy(true);
        updateProgress({ phase: 'fetch', value: 0.05, message: '正在连接 Figma…' });
        try {
            const document = await request<DocumentDto>('fetch-document', source);
            state.fontAssets = document.fontAssets ?? state.fontAssets;
            initializeDocument(document);
        } catch (error) {
            showToast(error instanceof Error ? error.message : '读取失败。', true);
        } finally {
            setBusy(false);
        }
    });

    element<HTMLInputElement>('#source-url').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            element<HTMLButtonElement>('#fetch-document').click();
        }
    });
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
                await request('save-settings', settings);
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
                await request('save-settings', settings);
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
                await request('save-settings', settings);
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
            await request('save-settings', settings);
        }
        showToast(`已清除本地同名资源目录 ${index + 1}。`);
        });
    }
    element('#import-button').addEventListener('click', importToScene);
    element('#cancel-import').addEventListener('click', () => request('cancel-import'));

    element<HTMLInputElement>('#tree-search').addEventListener('input', (event) => {
        state.search = (event.target as HTMLInputElement).value.trim().toLowerCase();
        renderTree();
    });

    element('#tree').addEventListener('click', (event) => {
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
        if (target.closest('select, label')) {
            return;
        }
        const id = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        const node = id ? findNode(id) : undefined;
        if (node) {
            void preview(node);
        }
    });

    element('#tree').addEventListener('change', (event) => {
        const target = event.target as HTMLInputElement | HTMLSelectElement;
        if (target.dataset.actionFor) {
            const node = findNode(target.dataset.actionFor);
            if (node) {
                const action = target.value as ImportAction;
                setAction(node, action);
                root().querySelectorAll<HTMLElement>('[data-preset]')
                    .forEach((button) => button.classList.remove('active'));
                if (terminal(action) && node.children.length) {
                    showToast(`“${node.name}”将作为整层导入，${descendants(node).length} 个子节点不会单独生成。`);
                }
                renderTree();
            }
        } else if (target.dataset.kindFor) {
            state.kinds.set(target.dataset.kindFor, target.value as NodeKind);
        } else if (target.dataset.patchFor) {
            if ((target as HTMLInputElement).checked) {
                state.patches.add(target.dataset.patchFor);
                const node = findNode(target.dataset.patchFor);
                if (node) {
                    setAction(node, 'render');
                }
            } else {
                state.patches.delete(target.dataset.patchFor);
            }
            renderTree();
        }
        updateSummary();
    });

    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.addEventListener('click', () => applyPreset(button.dataset.preset ?? 'smart'));
    });

    root().querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '#scale, #asset-folder, #prefab-folder, #local-resource-folder, #update-existing, #refresh-assets, #auto-save',
    ).forEach((control) => {
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
        show() {},
        hide() {},
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf8'),
    $: {
        app: '#app',
    },
    methods: {
        onProgress(event: ProgressEvent) {
            updateProgress(event);
        },
    },
    async ready() {
        panelHost = this;
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
            if (!state.runtimeCompatible) {
                updateSummary();
                const button = element<HTMLButtonElement>('#import-button');
                button.classList.add('is-error');
                element('#import-button-label').textContent = '请重启 Cocos';
                element('#import-button-percent').textContent = '↻';
                showToast('检测到旧版主进程仍在运行：请保存项目并完整重启 Cocos Creator。', true);
            }
        } catch (error) {
            showToast(error instanceof Error ? error.message : '初始化失败。', true);
        }
    },
    beforeClose() {},
    close() {
        panelHost = null;
    },
});
