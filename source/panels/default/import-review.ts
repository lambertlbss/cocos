import type { ImportReview, ReviewAsset, ReviewNode, ReviewNodeChange } from '../../import-review-model';

type Request = <T>(message: string, ...args: any[]) => Promise<T>;
const assetLabels = { new: '本次新建', updated: '覆盖已有', reused: '引用已有', deleted: '已删除' };
const sourceLabels: Record<string, string> = { local: '本地同名资源', existing: '项目已有资源', cache: '下载缓存', figma: 'Figma', generated: '插件生成' };
const changeLabels = { added: '新增', removed: '删除', changed: '修改', unchanged: '未变' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}
function button(text: string, action: () => void, className = 'button ghost compact'): HTMLButtonElement {
    const node = el('button', text, className);
    node.type = 'button';
    node.onclick = action;
    return node;
}
const errorText = (error: any) => error?.message || String(error);

export class ImportReviewPanel {
    private report?: ImportReview;
    private removed = new Set<string>();
    private selected = '';
    private tab: 'assets' | 'nodes' | 'source' = 'assets';
    private query = '';
    private filter = 'all';
    private page = 0;
    private onlyChanges = true;
    private busy = false;
    private previewRevision = 0;
    private readonly dialog: HTMLDialogElement;
    private readonly content: HTMLElement;
    private readonly summary: HTMLElement;
    private readonly footer: HTMLElement;
    private readonly errors: HTMLElement;
    private readonly tabs: HTMLElement;

    constructor(root: HTMLElement, private request: Request, private setBusy: (busy: boolean) => void) {
        this.dialog = root.querySelector('#import-review-dialog')!;
        this.content = this.dialog.querySelector('.review-content')!;
        this.summary = this.dialog.querySelector('.review-summary')!;
        this.footer = this.dialog.querySelector('.review-footer')!;
        this.errors = this.dialog.querySelector('.review-errors')!;
        this.tabs = this.dialog.querySelector('.review-tabs')!;
        this.dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            if (!this.busy) this.close();
        });
        this.dialog.querySelector('.review-close')!.addEventListener('click', () => this.close());
    }

    open(report: ImportReview): void {
        // Response, ready replay and notification can carry the same report.
        if (this.dialog.open && this.report?.id === report.id) return;
        this.report = report;
        this.removed.clear();
        this.selected = report.assets[0]?.id ?? '';
        this.tab = 'assets';
        this.query = '';
        this.filter = 'all';
        this.page = 0;
        this.errors.textContent = '';
        this.render();
        if (!this.dialog.open) this.dialog.showModal();
    }
    private close(): void {
        if (this.busy) return;
        this.removed.clear();
        this.previewRevision++;
        this.dialog.close();
    }
    dispose(): void { this.previewRevision++; this.dialog.close(); }

    private renderFooter(): void {
        const report = this.report!;
        this.footer.replaceChildren();
        const note = el('div', report.readOnlyReason ? '本次结果仅供查看，资源清理已禁用。' : report.confirmed ? '修改已确认。' : this.removed.size
            ? `待删除 ${this.removed.size} 项：确定后解除引用、保存当前目标并删除文件，节点保留。`
            : '所有新资源默认保留。取消勾选只标记待删除，关闭窗口放弃本次勾选。');
        if (report.backupFolder) note.append(el('small', `恢复备份：${report.backupFolder}`));
        const actions = el('div', '', 'review-footer-actions');
        const close = button(report.confirmed ? '关闭' : '暂不修改', () => this.close());
        close.disabled = this.busy;
        const apply = button(this.busy ? '正在确认…' : '确定修改', () => { void this.apply(); }, 'button primary');
        apply.disabled = this.busy || report.confirmed || Boolean(report.readOnlyReason);
        actions.append(close, apply);
        this.footer.append(note, actions);
    }

    private render(): void {
        const report = this.report!;
        this.previewRevision++;
        const count = (state: ReviewAsset['state']) => report.assets.filter((asset) => asset.state === state).length;
        const changed = report.changes.filter((node) => node.status !== 'unchanged').length;
        this.summary.textContent = `${report.fileName} · 新建 ${count('new')} · 覆盖 ${count('updated')} · 复用 ${count('reused')} · 节点变化 ${changed}`;
        this.summary.title = report.targetUrl ?? '当前场景';
        this.tabs.replaceChildren();
        for (const [key, label] of [['assets', '资源对比'], ['nodes', '导入前后节点'], ['source', 'Figma → Cocos']] as const) {
            const tab = button(label, () => { this.tab = key; this.page = 0; this.render(); });
            tab.classList.toggle('active', this.tab === key);
            tab.setAttribute('aria-pressed', String(this.tab === key));
            tab.disabled = this.busy;
            this.tabs.append(tab);
        }
        this.content.replaceChildren();
        if (report.readOnlyReason) {
            const notice = el('p', `只读结果：${report.readOnlyReason}`, 'review-readonly');
            notice.setAttribute('role', 'status');
            this.content.append(notice);
        }
        if (report.warnings.length) {
            const details = el('details', '', 'review-warnings');
            details.append(el('summary', `${report.warnings.length} 条导入/收尾提示`));
            for (const warning of report.warnings) details.append(el('p', warning));
            this.content.append(details);
        }
        if (this.tab === 'assets') this.renderAssets();
        else if (this.tab === 'nodes') this.renderNodes();
        else this.renderSource();
        this.renderFooter();
    }

    private pager(total: number, size: number, redraw: () => void): HTMLElement {
        const pages = Math.max(1, Math.ceil(total / size));
        this.page = Math.min(this.page, pages - 1);
        const row = el('div', '', 'review-pager');
        const prev = button('上一页', () => { this.page--; redraw(); });
        const next = button('下一页', () => { this.page++; redraw(); });
        prev.disabled = this.page === 0 || this.busy;
        next.disabled = this.page + 1 >= pages || this.busy;
        row.append(prev, el('span', `${this.page + 1} / ${pages} · ${total} 项`), next);
        return row;
    }

    private renderAssets(): void {
        const controls = el('div', '', 'review-controls');
        const search = el('input');
        search.type = 'search'; search.placeholder = '搜索资源或引用节点'; search.value = this.query;
        search.setAttribute('aria-label', '搜索资源或引用节点');
        const filter = el('select');
        filter.setAttribute('aria-label', '资源状态筛选');
        for (const [value, label] of [['all', '全部资源'], ['new', '本次新建'], ['reused', '引用已有'], ['updated', '覆盖已有'], ['pending', '待删除']]) {
            const option = el('option', label); option.value = value; filter.append(option);
        }
        filter.value = this.filter;
        filter.onchange = () => { this.filter = filter.value; this.page = 0; this.render(); };
        let timer: ReturnType<typeof setTimeout>;
        search.oninput = () => {
            this.query = search.value; this.page = 0;
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (!search.isConnected) return;
                const start = search.selectionStart;
                this.render();
                const replacement = this.content.querySelector<HTMLInputElement>('input[type=search]');
                replacement?.focus();
                if (start !== null) replacement?.setSelectionRange(start, start);
            }, 180);
        };
        const retain = button('全部保留', () => { this.removed.clear(); this.render(); });
        retain.disabled = this.busy || this.report!.confirmed || Boolean(this.report!.readOnlyReason);
        controls.append(search, filter, retain);
        this.content.append(controls);
        const matches = this.report!.assets.filter((asset) =>
            (this.filter === 'all' || this.filter === asset.state || (this.filter === 'pending' && this.removed.has(asset.id)))
            && `${asset.name} ${asset.url} ${asset.nodeNames.join(' ')}`.toLowerCase().includes(this.query.toLowerCase()));
        const pager = this.pager(matches.length, 50, () => this.render());
        const layout = el('div', '', 'review-resource-layout');
        const list = el('div', '', 'review-resource-list');
        const detail = el('div', '', 'review-resource-detail');
        for (const asset of matches.slice(this.page * 50, this.page * 50 + 50)) {
            const row = el('div', '', `review-resource-row ${asset.state}${this.removed.has(asset.id) ? ' pending' : ''}`);
            row.classList.toggle('selected', asset.id === this.selected);
            const checkbox = el('input'); checkbox.type = 'checkbox';
            checkbox.checked = asset.state !== 'deleted' && !this.removed.has(asset.id);
            checkbox.disabled = !asset.canRemove || this.busy || this.report!.confirmed || Boolean(this.report!.readOnlyReason);
            checkbox.setAttribute('aria-label', `保留 ${asset.name}`);
            checkbox.title = asset.reason || (asset.canRemove ? '取消勾选：确定修改后删除本次新建资源' : '已有资源仅供查看');
            checkbox.onchange = () => {
                if (checkbox.checked) this.removed.delete(asset.id); else this.removed.add(asset.id);
                row.classList.toggle('pending', !checkbox.checked);
                this.renderFooter();
            };
            const select = button('', () => {
                if (this.selected === asset.id) return;
                this.selected = asset.id;
                // Keep the live list, its scroll offset, checkbox state and
                // keyboard focus. Only the selection and right detail change.
                for (const item of Array.from(list.children)) {
                    const selected = item === row;
                    item.classList.toggle('selected', selected);
                    item.querySelector('.review-resource-select')?.setAttribute('aria-pressed', String(selected));
                }
                this.previewRevision++;
                detail.replaceChildren();
                this.renderAssetDetail(asset, detail);
            }, 'review-resource-select');
            select.setAttribute('aria-pressed', String(asset.id === this.selected));
            select.append(el('strong', asset.name), el('span', `${assetLabels[asset.state]} · ${asset.nodeNames.length} 个节点引用`));
            select.title = asset.url;
            row.append(checkbox, select);
            list.append(row);
        }
        if (!matches.length) list.append(el('p', '没有符合条件的资源。', 'review-empty'));
        layout.append(list, detail);
        this.content.append(layout, pager);
        const asset = this.report!.assets.find((item) => item.id === this.selected);
        if (asset) this.renderAssetDetail(asset, detail);
    }

    private renderAssetDetail(asset: ReviewAsset, host: HTMLElement): void {
        host.append(el('h3', asset.name), el('p', asset.url, 'review-path'),
            el('p', `${assetLabels[asset.state]} · 来源：${asset.sources.map((source) => sourceLabels[source] ?? source).join(' / ')}`));
        if (asset.reason) host.append(el('p', asset.reason, 'review-warning'));
        const figures = el('div', '', 'review-images');
        const actual = this.imageCell('实际引用图片'); figures.append(actual.box);
        const prior = asset.hasBefore ? this.imageCell('覆盖前图片') : null;
        host.append(figures);
        const revision = this.previewRevision;
        void this.request<{ before?: string; after?: string }>('get-import-review-preview', this.report!.id, asset.id)
            .then((preview) => {
                if (revision !== this.previewRevision) return;
                actual.load(preview.after);
                prior?.load(preview.before);
            }).catch((error) => { if (revision === this.previewRevision) actual.note.textContent = errorText(error); });
        const sourceSelect = el('select');
        sourceSelect.setAttribute('aria-label', '选择用于图片对比的 Figma 图层');
        for (const id of asset.figmaIds) {
            const name = this.report!.sourceTree.find((node) => node.id === id)?.name ?? id;
            const option = el('option', `${name} (${id})`); option.value = id; sourceSelect.append(option);
        }
        const source = this.imageCell('Figma 来源图片（按需加载）');
        figures.append(source.box);
        if (prior) host.append(prior.box);
        const compare = button('加载 Figma 图片对比', () => {
            compare.disabled = true; source.note.textContent = '正在读取 Figma…';
            void this.request<{ url: string; note: string }>('get-import-review-source-preview', this.report!.id, asset.id, sourceSelect.value)
                .then((result) => { if (revision === this.previewRevision) { source.load(result.url); source.note.textContent = result.note; } })
                .catch((error) => { if (revision === this.previewRevision) source.note.textContent = errorText(error); })
                .finally(() => { compare.disabled = false; });
        });
        if (asset.figmaIds.length) {
            host.append(sourceSelect, compare);
        }
        host.append(el('h4', '引用节点'));
        const consumers = this.report!.after.nodes.filter((node) => node.components.some((component) =>
            Object.values(component.properties).includes(asset.uuid)));
        if (!consumers.length) host.append(el('p', '没有节点引用此资源。'));
        for (const node of consumers) {
            const ancestor: string[] = [node.name];
            let parent = node.parentId;
            const seen = new Set<string>();
            while (parent && !seen.has(parent)) {
                seen.add(parent);
                const found = this.report!.after.nodes.find((item) => item.id === parent);
                if (!found) break;
                ancestor.unshift(found.name); parent = found.parentId;
            }
            host.append(el('p', ancestor.join(' / '), 'review-path'));
        }
        if (asset.state !== 'deleted') host.append(button('在资源面板中定位', () => {
            // Selection.select adds to the existing selection in Creator.
            // Locate replaces only the asset selection, never scene nodes.
            Editor.Selection.clear('asset');
            Editor.Selection.select('asset', asset.uuid);
        }));
    }

    private imageCell(label: string) {
        const box = el('figure', '', 'review-image');
        const caption = el('figcaption', label);
        const viewport = el('div', '', 'review-checker');
        const note = el('small', '尚未加载');
        box.append(caption, viewport, note);
        return { box, note, load: (url?: string) => {
            viewport.replaceChildren();
            if (!url) { note.textContent = '暂无可用预览'; return; }
            const img = el('img'); img.alt = label;
            img.onload = () => { note.textContent = `${img.naturalWidth} × ${img.naturalHeight}（预览尺寸）`; };
            img.onerror = () => { note.textContent = '预览加载失败'; };
            img.src = url; viewport.append(img); note.textContent = '';
        } };
    }

    private renderNodes(): void {
        const controls = el('label', '', 'review-controls');
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = this.onlyChanges;
        checkbox.onchange = () => { this.onlyChanges = checkbox.checked; this.page = 0; this.render(); };
        controls.append(checkbox, el('span', '只显示有变化的节点（点击节点查看组件与属性）'));
        this.content.append(controls);
        const changes = this.report!.changes.filter((node) => !this.onlyChanges || node.status !== 'unchanged');
        const pager = this.pager(changes.length, 100, () => this.render());
        const table = el('div', '', 'review-tree-table');
        const header = el('div', '', 'review-tree-row review-tree-header');
        header.append(el('span', '导入前'), el('span', '导入后')); table.append(header);
        const details = el('div', '', 'review-node-detail');
        for (const change of changes.slice(this.page * 100, this.page * 100 + 100)) {
            const row = el('div', '', `review-tree-row ${change.status}`);
            row.append(this.treeCell(change.before, change, details), this.treeCell(change.after, change, details));
            table.append(row);
        }
        if (!changes.length) table.append(el('p', '本次导入没有节点变化。', 'review-empty'));
        this.content.append(table, pager, details);
    }

    private treeCell(node: ReviewNode | undefined, change: ReviewNodeChange, detail: HTMLElement): HTMLElement {
        const cell = button('', () => {
            detail.replaceChildren(el('h3', `${changeLabels[change.status]} · ${change.after?.name ?? change.before?.name}`),
                el('p', change.fields.join('、') || '节点无变化'));
            const columns = el('div', '', 'review-component-columns');
            for (const [label, snapshot] of [['导入前', change.before], ['导入后', change.after]] as const) {
                const column = el('section'); column.append(el('h4', label));
                if (snapshot) {
                    column.append(el('p', `父节点：${snapshot.parentId ?? '根'} · 同级顺序 ${snapshot.order + 1}`),
                        el('p', `位置 ${snapshot.geometry.slice(0, 3).join(', ')} · 尺寸 ${snapshot.geometry.slice(3, 5).join(' × ')}`));
                    for (const component of snapshot.components) {
                        const item = el('details');
                        item.append(el('summary', `${component.type}${component.managed ? ' · 插件挂载/管理' : ' · 已有/其他'}`));
                        for (const [key, value] of Object.entries(component.properties)) item.append(el('div', `${key}: ${value ?? '无'}`, 'review-path'));
                        column.append(item);
                    }
                } else column.append(el('p', '—'));
                columns.append(column);
            }
            detail.append(columns);
            detail.scrollIntoView({ block: 'nearest' });
        }, 'review-tree-cell');
        if (node) {
            cell.style.paddingLeft = `${8 + Math.min(node.depth, 12) * 12}px`;
            cell.append(el('span', `${changeLabels[change.status]} · ${node.name}${node.active ? '' : '（隐藏）'}`),
                el('small', node.components.map((component) => component.type.replace(/^cc\./, '')).join(' · ')));
            cell.title = change.fields.join('、') || '无变化';
        } else cell.textContent = '—';
        return cell;
    }

    private renderSource(): void {
        this.content.append(el('p', '左侧保留 Figma 原始层级；右侧展示实际导入/合并结果及组件，插件辅助节点见“导入前后节点”。', 'review-hint'));
        const nodes = this.report!.sourceTree;
        const pager = this.pager(nodes.length, 100, () => this.render());
        const table = el('div', '', 'review-tree-table');
        const header = el('div', '', 'review-tree-row review-tree-header');
        header.append(el('span', 'Figma 原始节点'), el('span', 'Cocos 对应节点 / 组件')); table.append(header);
        for (const source of nodes.slice(this.page * 100, this.page * 100 + 100)) {
            const target = this.report!.after.nodes.find((node) => node.figmaIds.includes(source.id));
            const mapped = target && (target.figmaIds.length > 1 || target.name !== source.name || target.depth !== source.depth);
            const row = el('div', '', `review-tree-row ${!target || mapped ? 'changed' : 'unchanged'}`);
            const left = el('div', `${source.name}${source.visible ? '' : '（隐藏）'}`, 'review-tree-cell');
            left.style.paddingLeft = `${8 + Math.min(source.depth, 12) * 12}px`;
            left.append(el('small', `${source.type} · ${source.id}`));
            const merge = source.sliceMerge;
            const right = el('div', target ? `${mapped ? '映射/合并 → ' : ''}${target.name}`
                : merge ? `${merge.mode === 'nine' ? '九宫' : '三宫'}合并 → ${merge.targetName}`
                    : '未独立导入（忽略或整层 PNG 收口）', 'review-tree-cell');
            if (target) right.append(el('small', target.components.map((component) => component.type).join(' · ')));
            else if (merge) right.append(el('small', '作为父资源的切片组成部分导入，不单独生成 Cocos 节点。'));
            row.append(left, right); table.append(row);
        }
        this.content.append(table, pager);
    }

    private async apply(): Promise<void> {
        if (this.busy || this.report!.confirmed || this.report!.readOnlyReason) return;
        this.busy = true; this.setBusy(true); this.errors.textContent = ''; this.render();
        try {
            this.report = await this.request<ImportReview>('apply-import-review', this.report!.id, [...this.removed]);
            this.removed.clear();
        } catch (error) { this.errors.textContent = errorText(error); }
        finally { this.busy = false; this.setBusy(false); this.render(); }
    }
}
