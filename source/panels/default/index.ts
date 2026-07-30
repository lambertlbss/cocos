import { readFileSync } from 'fs';
import { join } from 'path';
import packageJSON from '../../../package.json';
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
}

let panelHost: any = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const state: PanelState = {
    document: null,
    settings: {
        sourceUrl: '',
        assetFolder: 'figma-importer',
        scale: 1,
        updateExisting: true,
        refreshAssets: false,
        autoSave: false,
        useSelection: true,
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

function initializeDocument(document: DocumentDto): void {
    state.document = document;
    state.actions.clear();
    state.kinds.clear();
    state.patches.clear();
    state.defaults.clear();
    state.collapsed.clear();
    state.suppressed.clear();
    for (const node of flatten(document.tree)) {
        state.actions.set(node.id, node.action);
        state.kinds.set(node.id, node.kind);
        state.defaults.set(node.id, { action: node.action, kind: node.kind });
    }
    element('#file-name').textContent = document.fileName;
    element<HTMLInputElement>('#source-url').value = document.sourceUrl;
    element('#font-hint').textContent = document.fonts.length
        ? `检测到：${document.fonts.join('、')}`
        : '当前文件尚未发现字体。';
    renderTree();
    updateSummary();
}

function applySettings(settings: ImportSettings): void {
    state.settings = settings;
    element<HTMLInputElement>('#source-url').value = settings.sourceUrl;
    element<HTMLInputElement>('#asset-folder').value = settings.assetFolder;
    element<HTMLInputElement>('#scale').value = String(settings.scale);
    element<HTMLInputElement>('#update-existing').checked = settings.updateExisting;
    element<HTMLInputElement>('#refresh-assets').checked = settings.refreshAssets;
    element<HTMLInputElement>('#auto-save').checked = settings.autoSave;
    element<HTMLInputElement>('#use-selection').checked = settings.useSelection;
    element<HTMLTextAreaElement>('#font-map').value = Object.keys(settings.fontMap).length
        ? JSON.stringify(settings.fontMap, null, 2)
        : '';
}

function readSettings(showError = true): ImportSettings | null {
    let fontMap: Record<string, string> = {};
    const fontText = element<HTMLTextAreaElement>('#font-map').value.trim();
    if (fontText) {
        try {
            const parsed = JSON.parse(fontText) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                || Object.values(parsed).some((value) => typeof value !== 'string')) {
                throw new Error();
            }
            fontMap = parsed as Record<string, string>;
        } catch {
            if (showError) {
                showToast('字体映射必须是“字体名 → db:// 资源”的 JSON 对象。', true);
            }
            return null;
        }
    }
    const scale = Number(element<HTMLInputElement>('#scale').value);
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) {
        if (showError) {
            showToast('导入倍率必须在 0.25 到 4 之间。', true);
        }
        return null;
    }
    return {
        sourceUrl: element<HTMLInputElement>('#source-url').value.trim(),
        assetFolder: element<HTMLInputElement>('#asset-folder').value.trim(),
        scale,
        updateExisting: element<HTMLInputElement>('#update-existing').checked,
        refreshAssets: element<HTMLInputElement>('#refresh-assets').checked,
        autoSave: element<HTMLInputElement>('#auto-save').checked,
        useSelection: element<HTMLInputElement>('#use-selection').checked,
        fontMap,
    };
}

function setBusy(value: boolean): void {
    state.busy = value;
    element<HTMLButtonElement>('#fetch-document').disabled = value;
    element<HTMLButtonElement>('#save-token').disabled = value;
    element<HTMLButtonElement>('#import-button').disabled = value || !state.document;
    element('#cancel-import').classList.toggle('is-hidden', !value);
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

    const action = makeSelect('action-select', state.actions.get(node.id) ?? node.action, [
        ['ignore', '忽略'],
        ['generate', '生成'],
        ['render', 'PNG'],
        ['svg', 'SVG'],
        ['merge', '合并'],
        ['transform', '更新'],
    ], `${node.name} 导入方式`);
    action.dataset.actionFor = node.id;

    const kind = makeSelect('kind-select', state.kinds.get(node.id) ?? node.kind, [
        ['auto', '自动'],
        ['container', '容器'],
        ['label', '文本'],
        ['button', '按钮'],
        ['scroll', '滚动'],
        ['grid', '网格'],
        ['sprite', '精灵'],
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
    element<HTMLButtonElement>('#import-button').disabled = state.busy || !state.document || !selected.length;
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
            state.actions.set(node.id, original.action);
            state.kinds.set(node.id, original.kind);
        }
    } else if (name === 'editable') {
        for (const node of all) {
            state.actions.set(node.id, ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON']
                .includes(node.type) ? 'svg' : 'generate');
        }
    } else {
        for (const node of all) {
            state.actions.set(node.id, 'ignore');
        }
        for (const node of state.document.tree) {
            setAction(node, 'render');
        }
    }
    root().querySelectorAll<HTMLElement>('[data-preset]').forEach((button) => {
        button.classList.toggle('active', button.dataset.preset === name);
    });
    renderTree();
    updateSummary();
}

async function importToScene(): Promise<void> {
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
        await request('import-selection', { overrides, settings });
        showToast('导入完成，已在场景中选中根节点。');
    } catch (error) {
        showToast(error instanceof Error ? error.message : '导入失败。', true);
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
            initializeDocument(await request<DocumentDto>('fetch-document', source));
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
                setAction(node, target.value as ImportAction);
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
        '#scale, #asset-folder, #update-existing, #refresh-assets, #auto-save, #use-selection, #font-map',
    ).forEach((control) => {
        control.addEventListener('change', async () => {
            const settings = readSettings(false);
            if (settings) {
                await request('save-settings', settings);
            }
        });
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
                vault: any;
                settings: ImportSettings;
                document: DocumentDto | null;
            }>('get-state');
            setConnection(initial.vault);
            applySettings(initial.settings);
            if (initial.document) {
                initializeDocument(initial.document);
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
