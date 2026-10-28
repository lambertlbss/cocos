"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PanelWorkflow = void 0;
const url_1 = require("../../figma/url");
/** Presentation state only. Import requests and project settings remain owned by the panel. */
class PanelWorkflow {
    constructor(host, context, openReview) {
        var _a;
        this.host = host;
        this.context = context;
        this.openReview = openReview;
        this.step = 1;
        this.pending = null;
        this.cancelled = false;
        this.unlocked = 1;
        this.hasToken = false;
        this.cancelling = false;
        this.error = '';
        this.result = null;
        this.reviewAvailable = false;
        this.autoRefreshApplied = false;
        /** 改动清单里取消勾选的节点；导入时连同其子层一起跳过。 */
        this.skippedSyncNodeIds = new Set();
        this.operationControls = [];
        host.querySelectorAll('[data-workflow-step]').forEach((button) => {
            button.addEventListener('click', () => this.navigate(Number(button.dataset.workflowStep)));
        });
        this.get('#workflow-back').addEventListener('click', () => this.navigate(this.step === 4 ? 2 : (this.step - 1)));
        this.get('#change-source').addEventListener('click', () => this.navigate(1));
        this.get('#reopen-import-review').addEventListener('click', () => { if (!this.locked)
            this.openReview('assets'); });
        this.get('#workflow-next').addEventListener('click', () => {
            if (this.locked || !this.context().document || this.selectedCount() === 0)
                return;
            this.unlocked = Math.max(3, this.unlocked);
            this.navigate(3);
        });
        (_a = this.host.querySelector('#sync-toggle-all')) === null || _a === void 0 ? void 0 : _a.addEventListener('click', () => {
            const sync = this.context().syncPreview;
            const items = (sync === null || sync === void 0 ? void 0 : sync.exists) ? sync.items : [];
            if (!items.length)
                return;
            if (this.skippedSyncNodeIds.size === 0) {
                items.forEach((item) => this.skippedSyncNodeIds.add(item.nodeId));
            }
            else {
                this.skippedSyncNodeIds.clear();
            }
            this.render();
        });
        this.get('#manage-credentials').addEventListener('click', () => this.openCredentials());
        this.get('#configure-credentials').addEventListener('click', () => this.openCredentials());
        this.get('#close-credentials').addEventListener('click', () => this.closeCredentials());
        this.get('#credential-dialog').addEventListener('cancel', (event) => {
            if (this.locked)
                event.preventDefault();
        });
        this.get('#dismiss-workflow-error').addEventListener('click', () => { this.error = ''; this.render(); });
        this.get('#source-url').addEventListener('input', () => this.render());
        host.querySelectorAll('[data-review-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                if (!this.locked)
                    this.openReview(button.dataset.reviewTab);
            });
        });
        host.addEventListener('change', () => this.render());
        this.render();
    }
    get(selector) {
        return this.host.querySelector(selector);
    }
    get locked() { return this.context().busy || this.pending !== null; }
    get credentialsReady() { return this.hasToken; }
    nodes() {
        var _a, _b;
        const flatten = (items) => items.flatMap((node) => [node, ...flatten(node.children)]);
        return flatten((_b = (_a = this.context().document) === null || _a === void 0 ? void 0 : _a.tree) !== null && _b !== void 0 ? _b : []);
    }
    selectedCount() {
        if (this.context().batch)
            return this.context().batch.selectedNodes;
        return this.nodes().filter((node) => this.context().actions.get(node.id) !== 'ignore').length;
    }
    prefabTarget() {
        const document = this.context().document;
        if (!document || document.tree.length !== 1)
            return false;
        try {
            return Boolean((0, url_1.parseFigmaSource)(document.sourceUrl).nodeId);
        }
        catch {
            return false;
        }
    }
    sourceUnchanged() {
        if (this.context().batch)
            return this.context().batch.count > 0;
        return Boolean(this.context().document)
            && this.get('#source-url').value.trim() === this.context().document.sourceUrl.trim();
    }
    setConnection(hasToken) {
        this.hasToken = hasToken;
        this.render();
    }
    openCredentials() {
        if (this.locked)
            return;
        const dialog = this.get('#credential-dialog');
        if (!dialog.open)
            dialog.showModal();
        this.get('#token-input').focus();
    }
    closeCredentials() {
        if (this.locked)
            return;
        this.get('#credential-dialog').close();
    }
    navigate(step) {
        var _a;
        if (this.locked || step < 1 || step > this.unlocked || (step > 1 && !this.sourceUnchanged()))
            return;
        this.step = step;
        this.render();
        (_a = this.host.querySelector(`[data-workflow-panel="${step}"] h2`)) === null || _a === void 0 ? void 0 : _a.focus();
    }
    documentReady() {
        this.unlocked = 2;
        this.result = null;
        this.error = '';
        this.step = 2;
        this.autoRefreshApplied = false;
        this.render();
    }
    batchReady() {
        this.unlocked = 2;
        this.result = null;
        this.error = '';
        this.step = 1;
        this.render();
    }
    /**
     * 组件同步预检结果到达后刷新第 3 步文案。
     * 只有检测到图片过期时才自动勾选"更新资源"，用户手动取消后不会被再次覆盖。
     */
    syncPreviewUpdated() {
        const sync = this.context().syncPreview;
        if ((sync === null || sync === void 0 ? void 0 : sync.exists) && sync.assetStaleCount > 0 && !this.autoRefreshApplied) {
            this.autoRefreshApplied = true;
            this.get('#refresh-assets').checked = true;
        }
        this.render();
    }
    begin(operation) {
        this.pending = operation;
        this.cancelled = false;
        this.cancelling = false;
        this.error = '';
        if (operation === 'import')
            this.step = 3;
        this.render();
    }
    end() {
        this.pending = null;
        this.cancelling = false;
        this.render();
    }
    fail(message) {
        this.error = message;
        this.render();
    }
    clearError() { this.error = ''; this.render(); }
    rememberReview() { this.reviewAvailable = true; this.render(); }
    cancelRequested() {
        this.cancelling = true;
        this.render();
    }
    cancelRequestFailed(message) {
        this.cancelling = false;
        this.fail(message);
    }
    progress(event) {
        if (event.phase === 'assets' || event.phase === 'scene') {
            this.step = 3;
            this.unlocked = Math.max(this.unlocked, 3);
        }
        if (event.phase === 'cancelled' || (event.phase === 'error' && this.pending === 'fetch' && this.cancelling)) {
            this.cancelled = true;
            this.error = '';
        }
        else if (event.phase === 'error') {
            this.error = event.message;
        }
        this.render();
    }
    complete(result) {
        this.result = result;
        if (result.review)
            this.reviewAvailable = true;
        this.error = '';
        this.cancelled = false;
        this.step = 4;
        this.unlocked = 4;
        this.render();
    }
    lockEditing(locked) {
        if (locked && this.operationControls.length === 0) {
            const selectors = '.workflow-panel input, .workflow-panel select, .workflow-panel button, [data-preset], #verify-token, #clear-token';
            this.operationControls = Array.from(this.host.querySelectorAll(selectors))
                .map((control) => ({ control, disabled: control.disabled }));
            this.operationControls.forEach(({ control }) => { control.disabled = true; });
        }
        else if (!locked && this.operationControls.length) {
            this.operationControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
            this.operationControls = [];
        }
    }
    render() {
        var _a, _b;
        const context = this.context();
        const locked = this.locked;
        const hasDocument = Boolean(context.document);
        const batch = context.batch;
        this.host.dataset.workflowStep = String(this.step);
        this.host.dataset.workflowBusy = String(locked);
        this.host.dataset.workflowOperation = (_a = this.pending) !== null && _a !== void 0 ? _a : '';
        this.host.dataset.workflowCancelling = String(this.cancelling);
        this.host.querySelectorAll('[data-workflow-panel]').forEach((panel) => {
            panel.hidden = Number(panel.dataset.workflowPanel) !== this.step;
        });
        this.host.querySelectorAll('[data-workflow-step]').forEach((button) => {
            const step = Number(button.dataset.workflowStep);
            const current = step === this.step;
            const complete = step < this.unlocked && !current;
            button.disabled = locked || step > this.unlocked || (step > 1 && !this.sourceUnchanged());
            button.classList.toggle('is-current', current);
            button.classList.toggle('is-complete', complete);
            if (current)
                button.setAttribute('aria-current', 'step');
            else
                button.removeAttribute('aria-current');
            button.querySelector('.step-number').textContent = complete ? '✓' : String(step);
            button.querySelector('.step-caption').textContent = current
                ? locked && this.pending === 'import' ? '正在执行' : '当前步骤'
                : complete ? locked ? '已完成' : '已完成 · 可返回' : '待完成';
        });
        this.lockEditing(locked);
        this.get('#manage-credentials').disabled = locked;
        this.get('#configure-credentials').disabled = locked;
        this.get('#close-credentials').disabled = locked;
        if (!locked) {
            this.get('#verify-token').disabled = !this.hasToken;
            this.get('#clear-token').disabled = !this.hasToken;
        }
        this.get('#workflow-context').hidden = !hasDocument || this.step === 1;
        this.get('#workflow-file-name').textContent = context.document
            ? batch ? `本批 ${batch.count} 个界面 / 独立 Prefab / 修改自动保留`
                : `${context.document.fileName} / ${this.prefabTarget() ? 'Frame' : '文件'} / ${this.nodes().length} 个节点`
            : '先读取设计，再逐步配置';
        this.get('#change-source').textContent = batch ? '界面列表' : '更换设计';
        this.get('#change-source').disabled = locked;
        this.get('#reopen-import-review').hidden = !this.reviewAvailable || this.step === 4;
        this.get('#reopen-import-review').disabled = locked;
        this.get('#workflow-error').hidden = !this.error;
        this.get('#workflow-error-message').textContent = this.error;
        this.get('#source-status').textContent = this.pending === 'fetch' ? '正在读取设计，请稍候…'
            : batch ? `已添加 ${batch.total} 个界面，已选 ${batch.count} 个。继续粘贴链接可追加，同一 Frame 只保留一份。`
                : this.sourceUnchanged() ? '当前设计已读取，可以直接继续。修改链接后重新读取，成功后替换当前设计。'
                    : this.hasToken ? '凭据已保存。读取成功后自动进入节点配置，沿用项目的目录与字体设置。'
                        : '首次使用请先配置 Figma 凭据，保存后再读取设计。';
        this.host.querySelector('.setup-card').hidden = this.hasToken;
        this.get('#refresh-document').hidden = !hasDocument;
        this.get('#refresh-document').disabled = locked;
        const fetch = this.get('#fetch-document');
        fetch.hidden = this.step !== 1;
        fetch.disabled = locked;
        fetch.textContent = this.pending === 'fetch' ? '正在读取…' : !this.hasToken ? '配置连接 →'
            : batch ? '调整所选界面 →' : this.sourceUnchanged() ? '返回节点配置 →' : '读取设计，下一步 →';
        if (batch && !batch.count)
            fetch.disabled = true;
        const next = this.get('#workflow-next');
        next.hidden = this.step !== 2;
        next.disabled = locked || this.selectedCount() === 0;
        const back = this.get('#workflow-back');
        back.hidden = this.step === 1 || locked;
        back.disabled = locked;
        back.textContent = this.step === 4 ? '返回节点配置' : '上一步';
        const importing = this.get('#import-button');
        importing.hidden = this.step !== 3;
        importing.disabled = locked || !hasDocument || !context.runtimeCompatible || this.selectedCount() === 0 || Boolean(batch === null || batch === void 0 ? void 0 : batch.conflicts);
        const cancel = this.get('#cancel-import');
        const cancellable = locked && this.pending !== null;
        cancel.hidden = !cancellable;
        cancel.classList.toggle('is-hidden', !cancellable);
        cancel.disabled = this.cancelling;
        cancel.textContent = this.cancelling ? batch && this.pending === 'import' ? '将在当前项完成后停止' : '正在取消…'
            : this.pending === 'fetch' ? '取消读取' : batch ? '停止后续任务' : '取消导入';
        const review = this.get('#open-import-review');
        review.hidden = this.step !== 4 || Boolean(batch);
        review.disabled = locked;
        review.textContent = '查看导入检查 →';
        this.get('#progress-region').hidden = this.step !== 3 || (this.pending !== 'import' && !this.error && !this.cancelled && !context.busy);
        const prefab = Boolean(batch) || this.prefabTarget();
        this.get('#confirmation-target').textContent = batch ? `导入 ${batch.count} 个独立 Prefab` : prefab ? '创建或更新独立预制体' : '导入当前场景 Canvas';
        const folder = this.get('#prefab-folder').value.trim();
        this.get('#confirmation-path').textContent = prefab ? `assets/${folder}/ · 每个 Frame 分别保存 .prefab` : '当前场景的 Canvas 根节点下';
        for (const id of ['#update-existing', '#auto-save']) {
            const input = this.get(id);
            input.disabled = locked || prefab;
            (_b = input.closest('label')) === null || _b === void 0 ? void 0 : _b.classList.toggle('is-inapplicable', prefab);
            input.title = prefab ? '仅场景导入生效；Frame 链接自动同步并保存预制体' : '';
        }
        const confirmation = this.host.querySelector('#confirmation-summary');
        if (confirmation)
            confirmation.textContent = `${batch ? `${batch.count} 个界面 · ` : ''}${this.selectedCount()} 个节点 · ${this.get('#scale').value}× · 项目目录与字体设置已保留`;
        const sync = this.context().syncPreview;
        if (!batch && prefab && (sync === null || sync === void 0 ? void 0 : sync.exists)) {
            this.get('#confirmation-target').textContent = '更新已有预制体';
            this.get('#confirmation-path').textContent = sync.targetUrl;
            const changes = sync.added + sync.changed + sync.removed;
            const assetNote = sync.assetStaleCount
                ? ` · ${sync.assetStaleCount} 张图需更新`
                : ' · 图片均未变化';
            if (confirmation) {
                confirmation.textContent = changes === 0
                    ? `与上次导入一致 · ${sync.total} 个节点${assetNote}`
                    : `将更新 ${changes} 处（新增 ${sync.added} · 修改 ${sync.changed} · 删除 ${sync.removed}）${assetNote}`;
            }
        }
        this.renderSyncChanges(batch ? undefined : sync);
        const advanced = this.host.querySelector('#advanced-summary');
        if (advanced) {
            const folders = [0, 1, 2].filter((index) => this.get(`#local-resource-folder-${index}`).value.trim()).length;
            const fonts = Array.from(this.host.querySelectorAll('[data-font-family]')).filter((select) => select.value).length;
            advanced.textContent = `本地目录 ${folders} 项 · 字体映射 ${fonts} 项 · 可按需展开`;
        }
        this.get('#action-note').textContent = !context.runtimeCompatible ? '主进程与面板版本不一致，请保存项目并完整重启 Cocos Creator。'
            : this.step === 1 ? '成功读取后进入第 2 步，已有项目设置会继续保留。'
                : this.step === 2 ? batch ? '点击上方标签切换界面，当前界面的修改会自动保留。' : '可以沿用当前策略；下一步核对输出位置。'
                    : this.step === 3 ? this.cancelling ? '等待后台任务结束后，可以再次调整设置。'
                        : (batch === null || batch === void 0 ? void 0 : batch.conflicts) ? '存在重复的 Prefab 名称，请在导入清单中改名。'
                            : prefab ? '预制体自动写入所选目录并打开；同名资源按现有规则复用。' : '导入到当前场景 Canvas 根节点下。'
                        : '结果检查不会重新执行导入。';
        const footnote = this.host.querySelector('#workflow-footnote');
        if (footnote) {
            footnote.textContent = this.cancelled ? '操作已取消，配置已保留。' : '';
            footnote.hidden = !this.cancelled;
        }
        if (this.step === 1)
            this.get('#selection-summary').textContent = batch ? `已选 ${batch.count} / ${batch.total} 个界面` : this.sourceUnchanged() ? '当前设计已读取' : '粘贴链接，开始读取设计';
        else if (this.step === 4)
            this.get('#selection-summary').textContent = '导入完成，可按需检查结果';
        else
            this.get('#selection-summary').textContent = batch ? `${batch.count} 个界面 · ${this.selectedCount()} / ${batch.nodes} 个节点将参与导入`
                : `${this.selectedCount()} / ${this.nodes().length} 个节点将参与导入`;
        if (this.result)
            this.renderResult(this.result);
        if ((batch === null || batch === void 0 ? void 0 : batch.result) && this.step === 4) {
            const result = batch.result;
            this.get('#result-title').textContent = result.stopped ? '本批导入已停止' : result.failed ? '本批导入结束，部分失败' : '本批导入完成';
            this.get('#result-summary').textContent = `成功 ${result.success} 项 · 失败 ${result.failed} 项 · 未完成 ${result.pending} 项。每个界面的检查报告可单独打开。`;
            this.get('#result-target').textContent = `assets/${folder}/`;
            this.get('#selection-summary').textContent = `成功 ${result.success} · 失败 ${result.failed} · 未完成 ${result.pending}`;
        }
    }
    /**
     * 逐条列出本次将要改动的内容；只展示摘要，不会假装能定位整层子树内部的具体子层。
     */
    renderSyncChanges(sync) {
        const box = this.host.querySelector('#sync-changes');
        const list = this.host.querySelector('#sync-change-list');
        if (!box || !list) {
            return;
        }
        const items = (sync === null || sync === void 0 ? void 0 : sync.exists) ? sync.items : [];
        box.hidden = items.length === 0;
        if (!items.length) {
            list.replaceChildren();
            this.skippedSyncNodeIds.clear();
            return;
        }
        // 只保留仍然出现在清单里的取消项，避免旧选择影响新一次预检。
        const available = new Set(items.map((item) => item.nodeId));
        for (const nodeId of [...this.skippedSyncNodeIds]) {
            if (!available.has(nodeId))
                this.skippedSyncNodeIds.delete(nodeId);
        }
        const count = this.host.querySelector('#sync-changes-count');
        if (count) {
            count.textContent = `共 ${sync.added + sync.changed + sync.removed} 处 · `
                + `${sync.assetStaleCount} 张图需更新`;
        }
        const visible = items.slice(0, 40);
        const rows = visible.map((item) => {
            const row = document.createElement('li');
            const skipped = this.skippedSyncNodeIds.has(item.nodeId);
            row.className = `sync-change-row is-${item.status}${skipped ? ' is-skipped' : ''}`;
            const select = document.createElement('input');
            select.type = 'checkbox';
            select.className = 'sync-change-select';
            select.checked = !skipped;
            select.setAttribute('aria-label', `应用 ${item.name} 的改动`);
            select.addEventListener('change', () => {
                if (select.checked)
                    this.skippedSyncNodeIds.delete(item.nodeId);
                else
                    this.skippedSyncNodeIds.add(item.nodeId);
                row.classList.toggle('is-skipped', !select.checked);
                this.renderSyncSelection();
            });
            const name = document.createElement('span');
            name.className = 'sync-change-name';
            name.textContent = item.status === 'removed' ? `− ${item.name}` : item.name;
            name.title = item.nodeId;
            const detail = document.createElement('span');
            detail.className = 'sync-change-fields';
            detail.textContent = item.fields.join(' · ');
            row.append(select, name, detail);
            if (item.assetStale) {
                const badge = document.createElement('span');
                badge.className = 'sync-change-asset';
                badge.textContent = '图片需更新';
                row.append(badge);
            }
            return row;
        });
        if (items.length > visible.length) {
            const more = document.createElement('li');
            more.className = 'sync-change-row is-more';
            more.textContent = `另有 ${items.length - visible.length} 处未展开`;
            rows.push(more);
        }
        list.replaceChildren(...rows);
        this.renderSyncSelection();
    }
    /** 本次要跳过的节点（改动清单里取消勾选的项）。 */
    get skippedSyncNodes() {
        return [...this.skippedSyncNodeIds];
    }
    renderSyncSelection() {
        const summary = this.host.querySelector('#sync-selection-summary');
        const toggle = this.host.querySelector('#sync-toggle-all');
        const sync = this.context().syncPreview;
        const total = (sync === null || sync === void 0 ? void 0 : sync.exists) ? sync.items.length : 0;
        const skipped = this.skippedSyncNodeIds.size;
        if (summary) {
            summary.textContent = skipped === 0
                ? '全部勾选'
                : `已勾选 ${Math.max(0, total - skipped)} / ${total} 处`;
        }
        if (toggle) {
            toggle.textContent = skipped === 0 ? '全不选' : '全选';
        }
    }
    renderResult(result) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const review = result.review;
        const created = (_a = result.created) !== null && _a !== void 0 ? _a : review === null || review === void 0 ? void 0 : review.changes.filter((node) => node.status === 'added').length;
        const updated = (_b = result.updated) !== null && _b !== void 0 ? _b : review === null || review === void 0 ? void 0 : review.changes.filter((node) => node.status === 'changed').length;
        const warnings = (_e = (_d = (_c = result.warnings) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : review === null || review === void 0 ? void 0 : review.warnings.length) !== null && _e !== void 0 ? _e : 0;
        this.get('#result-title').textContent = '导入完成，检查一下结果';
        this.get('#result-summary').textContent = `${(_h = (_f = review === null || review === void 0 ? void 0 : review.fileName) !== null && _f !== void 0 ? _f : (_g = this.context().document) === null || _g === void 0 ? void 0 : _g.fileName) !== null && _h !== void 0 ? _h : '设计'} 已完成导入${warnings ? `，有 ${warnings} 条导入/收尾提示。` : '。'}`;
        this.get('#result-target').textContent = (_k = (_j = result.prefabUrl) !== null && _j !== void 0 ? _j : review === null || review === void 0 ? void 0 : review.targetUrl) !== null && _k !== void 0 ? _k : '当前场景 Canvas 根节点';
        this.get('#result-created').textContent = created === undefined ? '—' : String(created);
        this.get('#result-updated').textContent = updated === undefined ? '—' : String(updated);
        this.get('#result-warnings').textContent = String(warnings);
    }
}
exports.PanelWorkflow = PanelWorkflow;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2Zsb3cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvd29ya2Zsb3cudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEseUNBQW1EO0FBaUNuRCwrRkFBK0Y7QUFDL0YsTUFBYSxhQUFhO0lBZXRCLFlBQ3FCLElBQWlCLEVBQ2pCLE9BQThCLEVBQzlCLFVBQXdEOztRQUZ4RCxTQUFJLEdBQUosSUFBSSxDQUFhO1FBQ2pCLFlBQU8sR0FBUCxPQUFPLENBQXVCO1FBQzlCLGVBQVUsR0FBVixVQUFVLENBQThDO1FBakI3RSxTQUFJLEdBQWlCLENBQUMsQ0FBQztRQUN2QixZQUFPLEdBQXFCLElBQUksQ0FBQztRQUNqQyxjQUFTLEdBQUcsS0FBSyxDQUFDO1FBQ1YsYUFBUSxHQUFHLENBQUMsQ0FBQztRQUNiLGFBQVEsR0FBRyxLQUFLLENBQUM7UUFDakIsZUFBVSxHQUFHLEtBQUssQ0FBQztRQUNuQixVQUFLLEdBQUcsRUFBRSxDQUFDO1FBQ1gsV0FBTSxHQUEwQixJQUFJLENBQUM7UUFDckMsb0JBQWUsR0FBRyxLQUFLLENBQUM7UUFDeEIsdUJBQWtCLEdBQUcsS0FBSyxDQUFDO1FBQ25DLGlDQUFpQztRQUNoQix1QkFBa0IsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO1FBQ2hELHNCQUFpQixHQUFvRyxFQUFFLENBQUM7UUFPNUgsSUFBSSxDQUFDLGdCQUFnQixDQUFvQixzQkFBc0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFO1lBQ2hGLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQWlCLENBQUMsQ0FBQyxDQUFDO1FBQy9HLENBQUMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0Is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b20gJy4uLy4uL2ZpZ21hL3VybCc7XHJcbmltcG9ydCB0eXBlIHsgSW1wb3J0UmV2aWV3IH0gZnJvbSAnLi4vLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHsgU3luY1ByZXZpZXdSZXN1bHQgfSBmcm9tICcuLi8uLi9pbXBvcnRlci9zeW5jLXByZXZpZXcnO1xyXG5pbXBvcnQgdHlwZSB7IEltcG9ydEFjdGlvbiwgSW1wb3J0U2V0dGluZ3MsIFByb2dyZXNzRXZlbnQsIFRyZWVOb2RlRHRvIH0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuZXhwb3J0IHR5cGUgV29ya2Zsb3dTdGVwID0gMSB8IDIgfCAzIHwgNDtcclxudHlwZSBPcGVyYXRpb24gPSAnZmV0Y2gnIHwgJ2ltcG9ydCc7XHJcbmludGVyZmFjZSBXb3JrZmxvd0NvbnRleHQge1xyXG4gICAgZG9jdW1lbnQ6IHsgZmlsZU5hbWU6IHN0cmluZzsgc291cmNlVXJsOiBzdHJpbmc7IHRyZWU6IFRyZWVOb2RlRHRvW10gfSB8IG51bGw7XHJcbiAgICBhY3Rpb25zOiBNYXA8c3RyaW5nLCBJbXBvcnRBY3Rpb24+O1xyXG4gICAgYnVzeTogYm9vbGVhbjtcclxuICAgIHJ1bnRpbWVDb21wYXRpYmxlOiBib29sZWFuO1xyXG4gICAgc2V0dGluZ3M6IEltcG9ydFNldHRpbmdzO1xyXG4gICAgYmF0Y2g/OiBCYXRjaFdvcmtmbG93Q29udGV4dDtcclxuICAgIC8qKiDnu4Tku7blkIzmraXpooTmo4Dnu5PmnpzvvJvlj6rlnKjljZXoioLngrnnu4Tku7bpk77mjqXkuIvlrZjlnKjjgIIgKi9cclxuICAgIHN5bmNQcmV2aWV3PzogU3luY1ByZXZpZXdSZXN1bHQ7XHJcbn1cclxuZXhwb3J0IGludGVyZmFjZSBCYXRjaFdvcmtmbG93Q29udGV4dCB7XHJcbiAgICBjb3VudDogbnVtYmVyO1xyXG4gICAgdG90YWw6IG51bWJlcjtcclxuICAgIG5vZGVzOiBudW1iZXI7XHJcbiAgICBzZWxlY3RlZE5vZGVzOiBudW1iZXI7XHJcbiAgICBjb25mbGljdHM6IGJvb2xlYW47XHJcbiAgICByZXN1bHQ/OiB7IHN1Y2Nlc3M6IG51bWJlcjsgZmFpbGVkOiBudW1iZXI7IHBlbmRpbmc6IG51bWJlcjsgc3RvcHBlZDogYm9vbGVhbiB9O1xyXG59XHJcbmV4cG9ydCBpbnRlcmZhY2UgV29ya2Zsb3dSZXN1bHQge1xyXG4gICAgY3JlYXRlZD86IG51bWJlcjtcclxuICAgIHVwZGF0ZWQ/OiBudW1iZXI7XHJcbiAgICBwcmVmYWJVcmw/OiBzdHJpbmc7XHJcbiAgICB3YXJuaW5ncz86IHN0cmluZ1tdO1xyXG4gICAgcmV2aWV3PzogSW1wb3J0UmV2aWV3O1xyXG59XHJcblxyXG4vKiogUHJlc2VudGF0aW9uIHN0YXRlIG9ubHkuIEltcG9ydCByZXF1ZXN0cyBhbmQgcHJvamVjdCBzZXR0aW5ncyByZW1haW4gb3duZWQgYnkgdGhlIHBhbmVsLiAqL1xyXG5leHBvcnQgY2xhc3MgUGFuZWxXb3JrZmxvdyB7XHJcbiAgICBzdGVwOiBXb3JrZmxvd1N0ZXAgPSAxO1xyXG4gICAgcGVuZGluZzogT3BlcmF0aW9uIHwgbnVsbCA9IG51bGw7XHJcbiAgICBjYW5jZWxsZWQgPSBmYWxzZTtcclxuICAgIHByaXZhdGUgdW5sb2NrZWQgPSAxO1xyXG4gICAgcHJpdmF0ZSBoYXNUb2tlbiA9IGZhbHNlO1xyXG4gICAgcHJpdmF0ZSBjYW5jZWxsaW5nID0gZmFsc2U7XHJcbiAgICBwcml2YXRlIGVycm9yID0gJyc7XHJcbiAgICBwcml2YXRlIHJlc3VsdDogV29ya2Zsb3dSZXN1bHQgfCBudWxsID0gbnVsbDtcclxuICAgIHByaXZhdGUgcmV2aWV3QXZhaWxhYmxlID0gZmFsc2U7XHJcbiAgICBwcml2YXRlIGF1dG9SZWZyZXNoQXBwbGllZCA9IGZhbHNlO1xuICAgIC8qKiDmlLnliqjmuIXljZXph4zlj5bmtojli77pgInnmoToioLngrnvvJvlr7zlhaXml7bov57lkIzlhbblrZDlsYLkuIDotbfot7Pov4fjgIIgKi9cbiAgICBwcml2YXRlIHJlYWRvbmx5IHNraXBwZWRTeW5jTm9kZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgcHJpdmF0ZSBvcGVyYXRpb25Db250cm9sczogQXJyYXk8eyBjb250cm9sOiBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFNlbGVjdEVsZW1lbnQgfCBIVE1MQnV0dG9uRWxlbWVudDsgZGlzYWJsZWQ6IGJvb2xlYW4gfT4gPSBbXTtcclxuXHJcbiAgICBjb25zdHJ1Y3RvcihcclxuICAgICAgICBwcml2YXRlIHJlYWRvbmx5IGhvc3Q6IEhUTUxFbGVtZW50LFxyXG4gICAgICAgIHByaXZhdGUgcmVhZG9ubHkgY29udGV4dDogKCkgPT4gV29ya2Zsb3dDb250ZXh0LFxyXG4gICAgICAgIHByaXZhdGUgcmVhZG9ubHkgb3BlblJldmlldzogKHRhYjogJ2Fzc2V0cycgfCAnbm9kZXMnIHwgJ3NvdXJjZScpID0+IHZvaWQsXHJcbiAgICApIHtcclxuICAgICAgICBob3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdbZGF0YS13b3JrZmxvdy1zdGVwXScpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLm5hdmlnYXRlKE51bWJlcihidXR0b24uZGF0YXNldC53b3JrZmxvd1N0ZXApIGFzIFdvcmtmbG93U3RlcCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjd29ya2Zsb3ctYmFjaycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5uYXZpZ2F0ZSh0aGlzLnN0ZXAgPT09IDQgPyAyIDogKHRoaXMuc3RlcCAtIDEpIGFzIFdvcmtmbG93U3RlcCkpO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjY2hhbmdlLXNvdXJjZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5uYXZpZ2F0ZSgxKSk7XHJcbiAgICAgICAgdGhpcy5nZXQoJyNyZW9wZW4taW1wb3J0LXJldmlldycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4geyBpZiAoIXRoaXMubG9ja2VkKSB0aGlzLm9wZW5SZXZpZXcoJ2Fzc2V0cycpOyB9KTtcclxuICAgICAgICB0aGlzLmdldCgnI3dvcmtmbG93LW5leHQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcclxuICAgICAgICAgICAgaWYgKHRoaXMubG9ja2VkIHx8ICF0aGlzLmNvbnRleHQoKS5kb2N1bWVudCB8fCB0aGlzLnNlbGVjdGVkQ291bnQoKSA9PT0gMCkgcmV0dXJuO1xyXG4gICAgICAgICAgICB0aGlzLnVubG9ja2VkID0gTWF0aC5tYXgoMywgdGhpcy51bmxvY2tlZCk7XHJcbiAgICAgICAgICAgIHRoaXMubmF2aWdhdGUoMyk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3IoJyNzeW5jLXRvZ2dsZS1hbGwnKT8uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBzeW5jID0gdGhpcy5jb250ZXh0KCkuc3luY1ByZXZpZXc7XG4gICAgICAgICAgICBjb25zdCBpdGVtcyA9IHN5bmM/LmV4aXN0cyA/IHN5bmMuaXRlbXMgOiBbXTtcbiAgICAgICAgICAgIGlmICghaXRlbXMubGVuZ3RoKSByZXR1cm47XG4gICAgICAgICAgICBpZiAodGhpcy5za2lwcGVkU3luY05vZGVJZHMuc2l6ZSA9PT0gMCkge1xuICAgICAgICAgICAgICAgIGl0ZW1zLmZvckVhY2goKGl0ZW0pID0+IHRoaXMuc2tpcHBlZFN5bmNOb2RlSWRzLmFkZChpdGVtLm5vZGVJZCkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLnNraXBwZWRTeW5jTm9kZUlkcy5jbGVhcigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuZ2V0KCcjbWFuYWdlLWNyZWRlbnRpYWxzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLm9wZW5DcmVkZW50aWFscygpKTtcclxuICAgICAgICB0aGlzLmdldCgnI2NvbmZpZ3VyZS1jcmVkZW50aWFscycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5vcGVuQ3JlZGVudGlhbHMoKSk7XHJcbiAgICAgICAgdGhpcy5nZXQoJyNjbG9zZS1jcmVkZW50aWFscycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5jbG9zZUNyZWRlbnRpYWxzKCkpO1xyXG4gICAgICAgIHRoaXMuZ2V0PEhUTUxEaWFsb2dFbGVtZW50PignI2NyZWRlbnRpYWwtZGlhbG9nJykuYWRkRXZlbnRMaXN0ZW5lcignY2FuY2VsJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgICAgICAgIGlmICh0aGlzLmxvY2tlZCkgZXZlbnQucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICB0aGlzLmdldCgnI2Rpc21pc3Mtd29ya2Zsb3ctZXJyb3InKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgdGhpcy5lcnJvciA9ICcnOyB0aGlzLnJlbmRlcigpOyB9KTtcclxuICAgICAgICB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PignI3NvdXJjZS11cmwnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsICgpID0+IHRoaXMucmVuZGVyKCkpO1xyXG4gICAgICAgIGhvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJldmlldy10YWJdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XHJcbiAgICAgICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICghdGhpcy5sb2NrZWQpIHRoaXMub3BlblJldmlldyhidXR0b24uZGF0YXNldC5yZXZpZXdUYWIgYXMgJ2Fzc2V0cycgfCAnbm9kZXMnIHwgJ3NvdXJjZScpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBob3N0LmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsICgpID0+IHRoaXMucmVuZGVyKCkpO1xyXG4gICAgICAgIHRoaXMucmVuZGVyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBnZXQ8VCBleHRlbmRzIEhUTUxFbGVtZW50ID0gSFRNTEVsZW1lbnQ+KHNlbGVjdG9yOiBzdHJpbmcpOiBUIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpITtcclxuICAgIH1cclxuXHJcbiAgICBnZXQgbG9ja2VkKCk6IGJvb2xlYW4geyByZXR1cm4gdGhpcy5jb250ZXh0KCkuYnVzeSB8fCB0aGlzLnBlbmRpbmcgIT09IG51bGw7IH1cclxuICAgIGdldCBjcmVkZW50aWFsc1JlYWR5KCk6IGJvb2xlYW4geyByZXR1cm4gdGhpcy5oYXNUb2tlbjsgfVxyXG5cclxuICAgIHByaXZhdGUgbm9kZXMoKTogVHJlZU5vZGVEdG9bXSB7XHJcbiAgICAgICAgY29uc3QgZmxhdHRlbiA9IChpdGVtczogVHJlZU5vZGVEdG9bXSk6IFRyZWVOb2RlRHRvW10gPT4gaXRlbXMuZmxhdE1hcCgobm9kZSkgPT4gW25vZGUsIC4uLmZsYXR0ZW4obm9kZS5jaGlsZHJlbildKTtcclxuICAgICAgICByZXR1cm4gZmxhdHRlbih0aGlzLmNvbnRleHQoKS5kb2N1bWVudD8udHJlZSA/PyBbXSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBzZWxlY3RlZENvdW50KCk6IG51bWJlciB7XHJcbiAgICAgICAgaWYgKHRoaXMuY29udGV4dCgpLmJhdGNoKSByZXR1cm4gdGhpcy5jb250ZXh0KCkuYmF0Y2ghLnNlbGVjdGVkTm9kZXM7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMubm9kZXMoKS5maWx0ZXIoKG5vZGUpID0+IHRoaXMuY29udGV4dCgpLmFjdGlvbnMuZ2V0KG5vZGUuaWQpICE9PSAnaWdub3JlJykubGVuZ3RoO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgcHJlZmFiVGFyZ2V0KCk6IGJvb2xlYW4ge1xyXG4gICAgICAgIGNvbnN0IGRvY3VtZW50ID0gdGhpcy5jb250ZXh0KCkuZG9jdW1lbnQ7XHJcbiAgICAgICAgaWYgKCFkb2N1bWVudCB8fCBkb2N1bWVudC50cmVlLmxlbmd0aCAhPT0gMSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIHRyeSB7IHJldHVybiBCb29sZWFuKHBhcnNlRmlnbWFTb3VyY2UoZG9jdW1lbnQuc291cmNlVXJsKS5ub2RlSWQpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XHJcbiAgICB9XHJcblxyXG4gICAgc291cmNlVW5jaGFuZ2VkKCk6IGJvb2xlYW4ge1xyXG4gICAgICAgIGlmICh0aGlzLmNvbnRleHQoKS5iYXRjaCkgcmV0dXJuIHRoaXMuY29udGV4dCgpLmJhdGNoIS5jb3VudCA+IDA7XHJcbiAgICAgICAgcmV0dXJuIEJvb2xlYW4odGhpcy5jb250ZXh0KCkuZG9jdW1lbnQpXHJcbiAgICAgICAgICAgICYmIHRoaXMuZ2V0PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKSA9PT0gdGhpcy5jb250ZXh0KCkuZG9jdW1lbnQhLnNvdXJjZVVybC50cmltKCk7XHJcbiAgICB9XHJcblxyXG4gICAgc2V0Q29ubmVjdGlvbihoYXNUb2tlbjogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuaGFzVG9rZW4gPSBoYXNUb2tlbjtcclxuICAgICAgICB0aGlzLnJlbmRlcigpO1xyXG4gICAgfVxyXG5cclxuICAgIG9wZW5DcmVkZW50aWFscygpOiB2b2lkIHtcclxuICAgICAgICBpZiAodGhpcy5sb2NrZWQpIHJldHVybjtcclxuICAgICAgICBjb25zdCBkaWFsb2cgPSB0aGlzLmdldDxIVE1MRGlhbG9nRWxlbWVudD4oJyNjcmVkZW50aWFsLWRpYWxvZycpO1xyXG4gICAgICAgIGlmICghZGlhbG9nLm9wZW4pIGRpYWxvZy5zaG93TW9kYWwoKTtcclxuICAgICAgICB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PignI3Rva2VuLWlucHV0JykuZm9jdXMoKTtcclxuICAgIH1cclxuXHJcbiAgICBjbG9zZUNyZWRlbnRpYWxzKCk6IHZvaWQge1xyXG4gICAgICAgIGlmICh0aGlzLmxvY2tlZCkgcmV0dXJuO1xyXG4gICAgICAgIHRoaXMuZ2V0PEhUTUxEaWFsb2dFbGVtZW50PignI2NyZWRlbnRpYWwtZGlhbG9nJykuY2xvc2UoKTtcclxuICAgIH1cclxuXHJcbiAgICBuYXZpZ2F0ZShzdGVwOiBXb3JrZmxvd1N0ZXApOiB2b2lkIHtcclxuICAgICAgICBpZiAodGhpcy5sb2NrZWQgfHwgc3RlcCA8IDEgfHwgc3RlcCA+IHRoaXMudW5sb2NrZWQgfHwgKHN0ZXAgPiAxICYmICF0aGlzLnNvdXJjZVVuY2hhbmdlZCgpKSkgcmV0dXJuO1xyXG4gICAgICAgIHRoaXMuc3RlcCA9IHN0ZXA7XHJcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcclxuICAgICAgICB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYFtkYXRhLXdvcmtmbG93LXBhbmVsPVwiJHtzdGVwfVwiXSBoMmApPy5mb2N1cygpO1xyXG4gICAgfVxyXG5cclxuICAgIGRvY3VtZW50UmVhZHkoKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy51bmxvY2tlZCA9IDI7XHJcbiAgICAgICAgdGhpcy5yZXN1bHQgPSBudWxsO1xyXG4gICAgICAgIHRoaXMuZXJyb3IgPSAnJztcclxuICAgICAgICB0aGlzLnN0ZXAgPSAyO1xyXG4gICAgICAgIHRoaXMuYXV0b1JlZnJlc2hBcHBsaWVkID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcclxuICAgIH1cclxuXHJcbiAgICBiYXRjaFJlYWR5KCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMudW5sb2NrZWQgPSAyO1xyXG4gICAgICAgIHRoaXMucmVzdWx0ID0gbnVsbDtcclxuICAgICAgICB0aGlzLmVycm9yID0gJyc7XHJcbiAgICAgICAgdGhpcy5zdGVwID0gMTtcclxuICAgICAgICB0aGlzLnJlbmRlcigpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICog57uE5Lu25ZCM5q2l6aKE5qOA57uT5p6c5Yiw6L6+5ZCO5Yi35paw56ysIDMg5q2l5paH5qGI44CCXHJcbiAgICAgKiDlj6rmnInmo4DmtYvliLDlm77niYfov4fmnJ/ml7bmiY3oh6rliqjli77pgIlcIuabtOaWsOi1hOa6kFwi77yM55So5oi35omL5Yqo5Y+W5raI5ZCO5LiN5Lya6KKr5YaN5qyh6KaG55uW44CCXHJcbiAgICAgKi9cclxuICAgIHN5bmNQcmV2aWV3VXBkYXRlZCgpOiB2b2lkIHtcclxuICAgICAgICBjb25zdCBzeW5jID0gdGhpcy5jb250ZXh0KCkuc3luY1ByZXZpZXc7XHJcbiAgICAgICAgaWYgKHN5bmM/LmV4aXN0cyAmJiBzeW5jLmFzc2V0U3RhbGVDb3VudCA+IDAgJiYgIXRoaXMuYXV0b1JlZnJlc2hBcHBsaWVkKSB7XHJcbiAgICAgICAgICAgIHRoaXMuYXV0b1JlZnJlc2hBcHBsaWVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgdGhpcy5nZXQ8SFRNTElucHV0RWxlbWVudD4oJyNyZWZyZXNoLWFzc2V0cycpLmNoZWNrZWQgPSB0cnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aGlzLnJlbmRlcigpO1xyXG4gICAgfVxyXG5cclxuICAgIGJlZ2luKG9wZXJhdGlvbjogT3BlcmF0aW9uKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gb3BlcmF0aW9uO1xyXG4gICAgICAgIHRoaXMuY2FuY2VsbGVkID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5jYW5jZWxsaW5nID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5lcnJvciA9ICcnO1xyXG4gICAgICAgIGlmIChvcGVyYXRpb24gPT09ICdpbXBvcnQnKSB0aGlzLnN0ZXAgPSAzO1xyXG4gICAgICAgIHRoaXMucmVuZGVyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgZW5kKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMucGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgdGhpcy5jYW5jZWxsaW5nID0gZmFsc2U7XHJcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcclxuICAgIH1cclxuXHJcbiAgICBmYWlsKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuZXJyb3IgPSBtZXNzYWdlO1xyXG4gICAgICAgIHRoaXMucmVuZGVyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgY2xlYXJFcnJvcigpOiB2b2lkIHsgdGhpcy5lcnJvciA9ICcnOyB0aGlzLnJlbmRlcigpOyB9XHJcblxyXG4gICAgcmVtZW1iZXJSZXZpZXcoKTogdm9pZCB7IHRoaXMucmV2aWV3QXZhaWxhYmxlID0gdHJ1ZTsgdGhpcy5yZW5kZXIoKTsgfVxyXG5cclxuICAgIGNhbmNlbFJlcXVlc3RlZCgpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLmNhbmNlbGxpbmcgPSB0cnVlO1xyXG4gICAgICAgIHRoaXMucmVuZGVyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgY2FuY2VsUmVxdWVzdEZhaWxlZChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLmNhbmNlbGxpbmcgPSBmYWxzZTtcclxuICAgICAgICB0aGlzLmZhaWwobWVzc2FnZSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJvZ3Jlc3MoZXZlbnQ6IFByb2dyZXNzRXZlbnQpOiB2b2lkIHtcclxuICAgICAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc3RlcCA9IDM7XHJcbiAgICAgICAgICAgIHRoaXMudW5sb2NrZWQgPSBNYXRoLm1heCh0aGlzLnVubG9ja2VkLCAzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGV2ZW50LnBoYXNlID09PSAnY2FuY2VsbGVkJyB8fCAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicgJiYgdGhpcy5wZW5kaW5nID09PSAnZmV0Y2gnICYmIHRoaXMuY2FuY2VsbGluZykpIHtcclxuICAgICAgICAgICAgdGhpcy5jYW5jZWxsZWQgPSB0cnVlO1xyXG4gICAgICAgICAgICB0aGlzLmVycm9yID0gJyc7XHJcbiAgICAgICAgfSBlbHNlIGlmIChldmVudC5waGFzZSA9PT0gJ2Vycm9yJykge1xyXG4gICAgICAgICAgICB0aGlzLmVycm9yID0gZXZlbnQubWVzc2FnZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcclxuICAgIH1cclxuXHJcbiAgICBjb21wbGV0ZShyZXN1bHQ6IFdvcmtmbG93UmVzdWx0KTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy5yZXN1bHQgPSByZXN1bHQ7XHJcbiAgICAgICAgaWYgKHJlc3VsdC5yZXZpZXcpIHRoaXMucmV2aWV3QXZhaWxhYmxlID0gdHJ1ZTtcclxuICAgICAgICB0aGlzLmVycm9yID0gJyc7XHJcbiAgICAgICAgdGhpcy5jYW5jZWxsZWQgPSBmYWxzZTtcclxuICAgICAgICB0aGlzLnN0ZXAgPSA0O1xyXG4gICAgICAgIHRoaXMudW5sb2NrZWQgPSA0O1xyXG4gICAgICAgIHRoaXMucmVuZGVyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBsb2NrRWRpdGluZyhsb2NrZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgICAgICBpZiAobG9ja2VkICYmIHRoaXMub3BlcmF0aW9uQ29udHJvbHMubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNlbGVjdG9ycyA9ICcud29ya2Zsb3ctcGFuZWwgaW5wdXQsIC53b3JrZmxvdy1wYW5lbCBzZWxlY3QsIC53b3JrZmxvdy1wYW5lbCBidXR0b24sIFtkYXRhLXByZXNldF0sICN2ZXJpZnktdG9rZW4sICNjbGVhci10b2tlbic7XHJcbiAgICAgICAgICAgIHRoaXMub3BlcmF0aW9uQ29udHJvbHMgPSBBcnJheS5mcm9tKHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MU2VsZWN0RWxlbWVudCB8IEhUTUxCdXR0b25FbGVtZW50PihzZWxlY3RvcnMpKVxyXG4gICAgICAgICAgICAgICAgLm1hcCgoY29udHJvbCkgPT4gKHsgY29udHJvbCwgZGlzYWJsZWQ6IGNvbnRyb2wuZGlzYWJsZWQgfSkpO1xyXG4gICAgICAgICAgICB0aGlzLm9wZXJhdGlvbkNvbnRyb2xzLmZvckVhY2goKHsgY29udHJvbCB9KSA9PiB7IGNvbnRyb2wuZGlzYWJsZWQgPSB0cnVlOyB9KTtcclxuICAgICAgICB9IGVsc2UgaWYgKCFsb2NrZWQgJiYgdGhpcy5vcGVyYXRpb25Db250cm9scy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgdGhpcy5vcGVyYXRpb25Db250cm9scy5mb3JFYWNoKCh7IGNvbnRyb2wsIGRpc2FibGVkIH0pID0+IHsgY29udHJvbC5kaXNhYmxlZCA9IGRpc2FibGVkOyB9KTtcclxuICAgICAgICAgICAgdGhpcy5vcGVyYXRpb25Db250cm9scyA9IFtdO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZW5kZXIoKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCgpO1xyXG4gICAgICAgIGNvbnN0IGxvY2tlZCA9IHRoaXMubG9ja2VkO1xyXG4gICAgICAgIGNvbnN0IGhhc0RvY3VtZW50ID0gQm9vbGVhbihjb250ZXh0LmRvY3VtZW50KTtcclxuICAgICAgICBjb25zdCBiYXRjaCA9IGNvbnRleHQuYmF0Y2g7XHJcbiAgICAgICAgdGhpcy5ob3N0LmRhdGFzZXQud29ya2Zsb3dTdGVwID0gU3RyaW5nKHRoaXMuc3RlcCk7XHJcbiAgICAgICAgdGhpcy5ob3N0LmRhdGFzZXQud29ya2Zsb3dCdXN5ID0gU3RyaW5nKGxvY2tlZCk7XHJcbiAgICAgICAgdGhpcy5ob3N0LmRhdGFzZXQud29ya2Zsb3dPcGVyYXRpb24gPSB0aGlzLnBlbmRpbmcgPz8gJyc7XHJcbiAgICAgICAgdGhpcy5ob3N0LmRhdGFzZXQud29ya2Zsb3dDYW5jZWxsaW5nID0gU3RyaW5nKHRoaXMuY2FuY2VsbGluZyk7XHJcbiAgICAgICAgdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS13b3JrZmxvdy1wYW5lbF0nKS5mb3JFYWNoKChwYW5lbCkgPT4ge1xyXG4gICAgICAgICAgICBwYW5lbC5oaWRkZW4gPSBOdW1iZXIocGFuZWwuZGF0YXNldC53b3JrZmxvd1BhbmVsKSAhPT0gdGhpcy5zdGVwO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtd29ya2Zsb3ctc3RlcF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcclxuICAgICAgICAgICAgY29uc3Qgc3RlcCA9IE51bWJlcihidXR0b24uZGF0YXNldC53b3JrZmxvd1N0ZXApO1xyXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50ID0gc3RlcCA9PT0gdGhpcy5zdGVwO1xyXG4gICAgICAgICAgICBjb25zdCBjb21wbGV0ZSA9IHN0ZXAgPCB0aGlzLnVubG9ja2VkICYmICFjdXJyZW50O1xyXG4gICAgICAgICAgICBidXR0b24uZGlzYWJsZWQgPSBsb2NrZWQgfHwgc3RlcCA+IHRoaXMudW5sb2NrZWQgfHwgKHN0ZXAgPiAxICYmICF0aGlzLnNvdXJjZVVuY2hhbmdlZCgpKTtcclxuICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWN1cnJlbnQnLCBjdXJyZW50KTtcclxuICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWNvbXBsZXRlJywgY29tcGxldGUpO1xyXG4gICAgICAgICAgICBpZiAoY3VycmVudCkgYnV0dG9uLnNldEF0dHJpYnV0ZSgnYXJpYS1jdXJyZW50JywgJ3N0ZXAnKTsgZWxzZSBidXR0b24ucmVtb3ZlQXR0cmlidXRlKCdhcmlhLWN1cnJlbnQnKTtcclxuICAgICAgICAgICAgYnV0dG9uLnF1ZXJ5U2VsZWN0b3IoJy5zdGVwLW51bWJlcicpIS50ZXh0Q29udGVudCA9IGNvbXBsZXRlID8gJ+KckycgOiBTdHJpbmcoc3RlcCk7XHJcbiAgICAgICAgICAgIGJ1dHRvbi5xdWVyeVNlbGVjdG9yKCcuc3RlcC1jYXB0aW9uJykhLnRleHRDb250ZW50ID0gY3VycmVudFxyXG4gICAgICAgICAgICAgICAgPyBsb2NrZWQgJiYgdGhpcy5wZW5kaW5nID09PSAnaW1wb3J0JyA/ICfmraPlnKjmiafooYwnIDogJ+W9k+WJjeatpemqpCdcclxuICAgICAgICAgICAgICAgIDogY29tcGxldGUgPyBsb2NrZWQgPyAn5bey5a6M5oiQJyA6ICflt7LlrozmiJAgwrcg5Y+v6L+U5ZueJyA6ICflvoXlrozmiJAnO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHRoaXMubG9ja0VkaXRpbmcobG9ja2VkKTtcclxuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNtYW5hZ2UtY3JlZGVudGlhbHMnKS5kaXNhYmxlZCA9IGxvY2tlZDtcclxuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjb25maWd1cmUtY3JlZGVudGlhbHMnKS5kaXNhYmxlZCA9IGxvY2tlZDtcclxuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjbG9zZS1jcmVkZW50aWFscycpLmRpc2FibGVkID0gbG9ja2VkO1xyXG4gICAgICAgIGlmICghbG9ja2VkKSB7XHJcbiAgICAgICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpLmRpc2FibGVkID0gIXRoaXMuaGFzVG9rZW47XHJcbiAgICAgICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI2NsZWFyLXRva2VuJykuZGlzYWJsZWQgPSAhdGhpcy5oYXNUb2tlbjtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1jb250ZXh0JykuaGlkZGVuID0gIWhhc0RvY3VtZW50IHx8IHRoaXMuc3RlcCA9PT0gMTtcclxuICAgICAgICB0aGlzLmdldCgnI3dvcmtmbG93LWZpbGUtbmFtZScpLnRleHRDb250ZW50ID0gY29udGV4dC5kb2N1bWVudFxyXG4gICAgICAgICAgICA/IGJhdGNoID8gYOacrOaJuSAke2JhdGNoLmNvdW50fSDkuKrnlYzpnaIgLyDni6znq4sgUHJlZmFiIC8g5L+u5pS56Ieq5Yqo5L+d55WZYFxyXG4gICAgICAgICAgICAgICAgOiBgJHtjb250ZXh0LmRvY3VtZW50LmZpbGVOYW1lfSAvICR7dGhpcy5wcmVmYWJUYXJnZXQoKSA/ICdGcmFtZScgOiAn5paH5Lu2J30gLyAke3RoaXMubm9kZXMoKS5sZW5ndGh9IOS4quiKgueCuWBcclxuICAgICAgICAgICAgOiAn5YWI6K+75Y+W6K6+6K6h77yM5YaN6YCQ5q2l6YWN572uJztcclxuICAgICAgICB0aGlzLmdldCgnI2NoYW5nZS1zb3VyY2UnKS50ZXh0Q29udGVudCA9IGJhdGNoID8gJ+eVjOmdouWIl+ihqCcgOiAn5pu05o2i6K6+6K6hJztcclxuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjaGFuZ2Utc291cmNlJykuZGlzYWJsZWQgPSBsb2NrZWQ7XHJcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcmVvcGVuLWltcG9ydC1yZXZpZXcnKS5oaWRkZW4gPSAhdGhpcy5yZXZpZXdBdmFpbGFibGUgfHwgdGhpcy5zdGVwID09PSA0O1xyXG4gICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI3Jlb3Blbi1pbXBvcnQtcmV2aWV3JykuZGlzYWJsZWQgPSBsb2NrZWQ7XHJcbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1lcnJvcicpLmhpZGRlbiA9ICF0aGlzLmVycm9yO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjd29ya2Zsb3ctZXJyb3ItbWVzc2FnZScpLnRleHRDb250ZW50ID0gdGhpcy5lcnJvcjtcclxuICAgICAgICB0aGlzLmdldCgnI3NvdXJjZS1zdGF0dXMnKS50ZXh0Q29udGVudCA9IHRoaXMucGVuZGluZyA9PT0gJ2ZldGNoJyA/ICfmraPlnKjor7vlj5borr7orqHvvIzor7fnqI3lgJnigKYnXHJcbiAgICAgICAgICAgIDogYmF0Y2ggPyBg5bey5re75YqgICR7YmF0Y2gudG90YWx9IOS4queVjOmdou+8jOW3sumAiSAke2JhdGNoLmNvdW50fSDkuKrjgILnu6fnu63nspjotLTpk77mjqXlj6/ov73liqDvvIzlkIzkuIAgRnJhbWUg5Y+q5L+d55WZ5LiA5Lu944CCYFxyXG4gICAgICAgICAgICA6IHRoaXMuc291cmNlVW5jaGFuZ2VkKCkgPyAn5b2T5YmN6K6+6K6h5bey6K+75Y+W77yM5Y+v5Lul55u05o6l57un57ut44CC5L+u5pS56ZO+5o6l5ZCO6YeN5paw6K+75Y+W77yM5oiQ5Yqf5ZCO5pu/5o2i5b2T5YmN6K6+6K6h44CCJ1xyXG4gICAgICAgICAgICAgICAgOiB0aGlzLmhhc1Rva2VuID8gJ+WHreaNruW3suS/neWtmOOAguivu+WPluaIkOWKn+WQjuiHquWKqOi/m+WFpeiKgueCuemFjee9ru+8jOayv+eUqOmhueebrueahOebruW9leS4juWtl+S9k+iuvue9ruOAgidcclxuICAgICAgICAgICAgICAgICAgICA6ICfpppbmrKHkvb/nlKjor7flhYjphY3nva4gRmlnbWEg5Yet5o2u77yM5L+d5a2Y5ZCO5YaN6K+75Y+W6K6+6K6h44CCJztcclxuICAgICAgICB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zZXR1cC1jYXJkJykhLmhpZGRlbiA9IHRoaXMuaGFzVG9rZW47XHJcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcmVmcmVzaC1kb2N1bWVudCcpLmhpZGRlbiA9ICFoYXNEb2N1bWVudDtcclxuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNyZWZyZXNoLWRvY3VtZW50JykuZGlzYWJsZWQgPSBsb2NrZWQ7XHJcbiAgICAgICAgY29uc3QgZmV0Y2ggPSB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNmZXRjaC1kb2N1bWVudCcpO1xyXG4gICAgICAgIGZldGNoLmhpZGRlbiA9IHRoaXMuc3RlcCAhPT0gMTtcclxuICAgICAgICBmZXRjaC5kaXNhYmxlZCA9IGxvY2tlZDtcclxuICAgICAgICBmZXRjaC50ZXh0Q29udGVudCA9IHRoaXMucGVuZGluZyA9PT0gJ2ZldGNoJyA/ICfmraPlnKjor7vlj5bigKYnIDogIXRoaXMuaGFzVG9rZW4gPyAn6YWN572u6L+e5o6lIOKGkidcclxuICAgICAgICAgICAgOiBiYXRjaCA/ICfosIPmlbTmiYDpgInnlYzpnaIg4oaSJyA6IHRoaXMuc291cmNlVW5jaGFuZ2VkKCkgPyAn6L+U5Zue6IqC54K56YWN572uIOKGkicgOiAn6K+75Y+W6K6+6K6h77yM5LiL5LiA5q2lIOKGkic7XHJcbiAgICAgICAgaWYgKGJhdGNoICYmICFiYXRjaC5jb3VudCkgZmV0Y2guZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICAgIGNvbnN0IG5leHQgPSB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyN3b3JrZmxvdy1uZXh0Jyk7XHJcbiAgICAgICAgbmV4dC5oaWRkZW4gPSB0aGlzLnN0ZXAgIT09IDI7XHJcbiAgICAgICAgbmV4dC5kaXNhYmxlZCA9IGxvY2tlZCB8fCB0aGlzLnNlbGVjdGVkQ291bnQoKSA9PT0gMDtcclxuICAgICAgICBjb25zdCBiYWNrID0gdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjd29ya2Zsb3ctYmFjaycpO1xyXG4gICAgICAgIGJhY2suaGlkZGVuID0gdGhpcy5zdGVwID09PSAxIHx8IGxvY2tlZDtcclxuICAgICAgICBiYWNrLmRpc2FibGVkID0gbG9ja2VkO1xyXG4gICAgICAgIGJhY2sudGV4dENvbnRlbnQgPSB0aGlzLnN0ZXAgPT09IDQgPyAn6L+U5Zue6IqC54K56YWN572uJyA6ICfkuIrkuIDmraUnO1xyXG4gICAgICAgIGNvbnN0IGltcG9ydGluZyA9IHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI2ltcG9ydC1idXR0b24nKTtcclxuICAgICAgICBpbXBvcnRpbmcuaGlkZGVuID0gdGhpcy5zdGVwICE9PSAzO1xyXG4gICAgICAgIGltcG9ydGluZy5kaXNhYmxlZCA9IGxvY2tlZCB8fCAhaGFzRG9jdW1lbnQgfHwgIWNvbnRleHQucnVudGltZUNvbXBhdGlibGUgfHwgdGhpcy5zZWxlY3RlZENvdW50KCkgPT09IDAgfHwgQm9vbGVhbihiYXRjaD8uY29uZmxpY3RzKTtcclxuICAgICAgICBjb25zdCBjYW5jZWwgPSB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjYW5jZWwtaW1wb3J0Jyk7XHJcbiAgICAgICAgY29uc3QgY2FuY2VsbGFibGUgPSBsb2NrZWQgJiYgdGhpcy5wZW5kaW5nICE9PSBudWxsO1xyXG4gICAgICAgIGNhbmNlbC5oaWRkZW4gPSAhY2FuY2VsbGFibGU7XHJcbiAgICAgICAgY2FuY2VsLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWhpZGRlbicsICFjYW5jZWxsYWJsZSk7XHJcbiAgICAgICAgY2FuY2VsLmRpc2FibGVkID0gdGhpcy5jYW5jZWxsaW5nO1xyXG4gICAgICAgIGNhbmNlbC50ZXh0Q29udGVudCA9IHRoaXMuY2FuY2VsbGluZyA/IGJhdGNoICYmIHRoaXMucGVuZGluZyA9PT0gJ2ltcG9ydCcgPyAn5bCG5Zyo5b2T5YmN6aG55a6M5oiQ5ZCO5YGc5q2iJyA6ICfmraPlnKjlj5bmtojigKYnXHJcbiAgICAgICAgICAgIDogdGhpcy5wZW5kaW5nID09PSAnZmV0Y2gnID8gJ+WPlua2iOivu+WPlicgOiBiYXRjaCA/ICflgZzmraLlkI7nu63ku7vliqEnIDogJ+WPlua2iOWvvOWFpSc7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjb3Blbi1pbXBvcnQtcmV2aWV3Jyk7XHJcbiAgICAgICAgcmV2aWV3LmhpZGRlbiA9IHRoaXMuc3RlcCAhPT0gNCB8fCBCb29sZWFuKGJhdGNoKTtcclxuICAgICAgICByZXZpZXcuZGlzYWJsZWQgPSBsb2NrZWQ7XHJcbiAgICAgICAgcmV2aWV3LnRleHRDb250ZW50ID0gJ+afpeeci+WvvOWFpeajgOafpSDihpInO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjcHJvZ3Jlc3MtcmVnaW9uJykuaGlkZGVuID0gdGhpcy5zdGVwICE9PSAzIHx8ICh0aGlzLnBlbmRpbmcgIT09ICdpbXBvcnQnICYmICF0aGlzLmVycm9yICYmICF0aGlzLmNhbmNlbGxlZCAmJiAhY29udGV4dC5idXN5KTtcclxuICAgICAgICBjb25zdCBwcmVmYWIgPSBCb29sZWFuKGJhdGNoKSB8fCB0aGlzLnByZWZhYlRhcmdldCgpO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjY29uZmlybWF0aW9uLXRhcmdldCcpLnRleHRDb250ZW50ID0gYmF0Y2ggPyBg5a+85YWlICR7YmF0Y2guY291bnR9IOS4queLrOeriyBQcmVmYWJgIDogcHJlZmFiID8gJ+WIm+W7uuaIluabtOaWsOeLrOeri+mihOWItuS9kycgOiAn5a+85YWl5b2T5YmN5Zy65pmvIENhbnZhcyc7XHJcbiAgICAgICAgY29uc3QgZm9sZGVyID0gdGhpcy5nZXQ8SFRNTElucHV0RWxlbWVudD4oJyNwcmVmYWItZm9sZGVyJykudmFsdWUudHJpbSgpO1xyXG4gICAgICAgIHRoaXMuZ2V0KCcjY29uZmlybWF0aW9uLXBhdGgnKS50ZXh0Q29udGVudCA9IHByZWZhYiA/IGBhc3NldHMvJHtmb2xkZXJ9LyDCtyDmr4/kuKogRnJhbWUg5YiG5Yir5L+d5a2YIC5wcmVmYWJgIDogJ+W9k+WJjeWcuuaZr+eahCBDYW52YXMg5qC56IqC54K55LiLJztcclxuICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIFsnI3VwZGF0ZS1leGlzdGluZycsICcjYXV0by1zYXZlJ10pIHtcclxuICAgICAgICAgICAgY29uc3QgaW5wdXQgPSB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PihpZCk7XHJcbiAgICAgICAgICAgIGlucHV0LmRpc2FibGVkID0gbG9ja2VkIHx8IHByZWZhYjtcclxuICAgICAgICAgICAgaW5wdXQuY2xvc2VzdCgnbGFiZWwnKT8uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaW5hcHBsaWNhYmxlJywgcHJlZmFiKTtcclxuICAgICAgICAgICAgaW5wdXQudGl0bGUgPSBwcmVmYWIgPyAn5LuF5Zy65pmv5a+85YWl55Sf5pWI77ybRnJhbWUg6ZO+5o6l6Ieq5Yqo5ZCM5q2l5bm25L+d5a2Y6aKE5Yi25L2TJyA6ICcnO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjb25maXJtYXRpb24gPSB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcignI2NvbmZpcm1hdGlvbi1zdW1tYXJ5Jyk7XHJcbiAgICAgICAgaWYgKGNvbmZpcm1hdGlvbikgY29uZmlybWF0aW9uLnRleHRDb250ZW50ID0gYCR7YmF0Y2ggPyBgJHtiYXRjaC5jb3VudH0g5Liq55WM6Z2iIMK3IGAgOiAnJ30ke3RoaXMuc2VsZWN0ZWRDb3VudCgpfSDkuKroioLngrkgwrcgJHt0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PignI3NjYWxlJykudmFsdWV9w5cgwrcg6aG555uu55uu5b2V5LiO5a2X5L2T6K6+572u5bey5L+d55WZYDtcclxuICAgICAgICBjb25zdCBzeW5jID0gdGhpcy5jb250ZXh0KCkuc3luY1ByZXZpZXc7XHJcbiAgICAgICAgaWYgKCFiYXRjaCAmJiBwcmVmYWIgJiYgc3luYz8uZXhpc3RzKSB7XHJcbiAgICAgICAgICAgIHRoaXMuZ2V0KCcjY29uZmlybWF0aW9uLXRhcmdldCcpLnRleHRDb250ZW50ID0gJ+abtOaWsOW3suaciemihOWItuS9kyc7XHJcbiAgICAgICAgICAgIHRoaXMuZ2V0KCcjY29uZmlybWF0aW9uLXBhdGgnKS50ZXh0Q29udGVudCA9IHN5bmMudGFyZ2V0VXJsO1xyXG4gICAgICAgICAgICBjb25zdCBjaGFuZ2VzID0gc3luYy5hZGRlZCArIHN5bmMuY2hhbmdlZCArIHN5bmMucmVtb3ZlZDtcclxuICAgICAgICAgICAgY29uc3QgYXNzZXROb3RlID0gc3luYy5hc3NldFN0YWxlQ291bnRcclxuICAgICAgICAgICAgICAgID8gYCDCtyAke3N5bmMuYXNzZXRTdGFsZUNvdW50fSDlvKDlm77pnIDmm7TmlrBgXHJcbiAgICAgICAgICAgICAgICA6ICcgwrcg5Zu+54mH5Z2H5pyq5Y+Y5YyWJztcclxuICAgICAgICAgICAgaWYgKGNvbmZpcm1hdGlvbikge1xyXG4gICAgICAgICAgICAgICAgY29uZmlybWF0aW9uLnRleHRDb250ZW50ID0gY2hhbmdlcyA9PT0gMFxyXG4gICAgICAgICAgICAgICAgICAgID8gYOS4juS4iuasoeWvvOWFpeS4gOiHtCDCtyAke3N5bmMudG90YWx9IOS4quiKgueCuSR7YXNzZXROb3RlfWBcclxuICAgICAgICAgICAgICAgICAgICA6IGDlsIbmm7TmlrAgJHtjaGFuZ2VzfSDlpITvvIjmlrDlop4gJHtzeW5jLmFkZGVkfSDCtyDkv67mlLkgJHtzeW5jLmNoYW5nZWR9IMK3IOWIoOmZpCAke3N5bmMucmVtb3ZlZH3vvIkke2Fzc2V0Tm90ZX1gO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoaXMucmVuZGVyU3luY0NoYW5nZXMoYmF0Y2ggPyB1bmRlZmluZWQgOiBzeW5jKTtcclxuICAgICAgICBjb25zdCBhZHZhbmNlZCA9IHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yKCcjYWR2YW5jZWQtc3VtbWFyeScpO1xyXG4gICAgICAgIGlmIChhZHZhbmNlZCkge1xyXG4gICAgICAgICAgICBjb25zdCBmb2xkZXJzID0gWzAsIDEsIDJdLmZpbHRlcigoaW5kZXgpID0+IHRoaXMuZ2V0PEhUTUxJbnB1dEVsZW1lbnQ+KGAjbG9jYWwtcmVzb3VyY2UtZm9sZGVyLSR7aW5kZXh9YCkudmFsdWUudHJpbSgpKS5sZW5ndGg7XHJcbiAgICAgICAgICAgIGNvbnN0IGZvbnRzID0gQXJyYXkuZnJvbSh0aGlzLmhvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oJ1tkYXRhLWZvbnQtZmFtaWx5XScpKS5maWx0ZXIoKHNlbGVjdCkgPT4gc2VsZWN0LnZhbHVlKS5sZW5ndGg7XHJcbiAgICAgICAgICAgIGFkdmFuY2VkLnRleHRDb250ZW50ID0gYOacrOWcsOebruW9lSAke2ZvbGRlcnN9IOmhuSDCtyDlrZfkvZPmmKDlsIQgJHtmb250c30g6aG5IMK3IOWPr+aMiemcgOWxleW8gGA7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoaXMuZ2V0KCcjYWN0aW9uLW5vdGUnKS50ZXh0Q29udGVudCA9ICFjb250ZXh0LnJ1bnRpbWVDb21wYXRpYmxlID8gJ+S4u+i/m+eoi+S4jumdouadv+eJiOacrOS4jeS4gOiHtO+8jOivt+S/neWtmOmhueebruW5tuWujOaVtOmHjeWQryBDb2NvcyBDcmVhdG9y44CCJ1xyXG4gICAgICAgICAgICA6IHRoaXMuc3RlcCA9PT0gMSA/ICfmiJDlip/or7vlj5blkI7ov5vlhaXnrKwgMiDmraXvvIzlt7LmnInpobnnm67orr7nva7kvJrnu6fnu63kv53nlZnjgIInXHJcbiAgICAgICAgICAgICAgICA6IHRoaXMuc3RlcCA9PT0gMiA/IGJhdGNoID8gJ+eCueWHu+S4iuaWueagh+etvuWIh+aNoueVjOmdou+8jOW9k+WJjeeVjOmdoueahOS/ruaUueS8muiHquWKqOS/neeVmeOAgicgOiAn5Y+v5Lul5rK/55So5b2T5YmN562W55Wl77yb5LiL5LiA5q2l5qC45a+56L6T5Ye65L2N572u44CCJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogdGhpcy5zdGVwID09PSAzID8gdGhpcy5jYW5jZWxsaW5nID8gJ+etieW+heWQjuWPsOS7u+WKoee7k+adn+WQju+8jOWPr+S7peWGjeasoeiwg+aVtOiuvue9ruOAgidcclxuICAgICAgICAgICAgICAgICAgICAgICAgOiBiYXRjaD8uY29uZmxpY3RzID8gJ+WtmOWcqOmHjeWkjeeahCBQcmVmYWIg5ZCN56ew77yM6K+35Zyo5a+85YWl5riF5Y2V5Lit5pS55ZCN44CCJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHByZWZhYiA/ICfpooTliLbkvZPoh6rliqjlhpnlhaXmiYDpgInnm67lvZXlubbmiZPlvIDvvJvlkIzlkI3otYTmupDmjInnjrDmnInop4TliJnlpI3nlKjjgIInIDogJ+WvvOWFpeWIsOW9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K55LiL44CCJ1xyXG4gICAgICAgICAgICAgICAgICAgICAgICA6ICfnu5Pmnpzmo4Dmn6XkuI3kvJrph43mlrDmiafooYzlr7zlhaXjgIInO1xyXG4gICAgICAgIGNvbnN0IGZvb3Rub3RlID0gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3IoJyN3b3JrZmxvdy1mb290bm90ZScpO1xyXG4gICAgICAgIGlmIChmb290bm90ZSkge1xyXG4gICAgICAgICAgICBmb290bm90ZS50ZXh0Q29udGVudCA9IHRoaXMuY2FuY2VsbGVkID8gJ+aTjeS9nOW3suWPlua2iO+8jOmFjee9ruW3suS/neeVmeOAgicgOiAnJztcclxuICAgICAgICAgICAgKGZvb3Rub3RlIGFzIEhUTUxFbGVtZW50KS5oaWRkZW4gPSAhdGhpcy5jYW5jZWxsZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0aGlzLnN0ZXAgPT09IDEpIHRoaXMuZ2V0KCcjc2VsZWN0aW9uLXN1bW1hcnknKS50ZXh0Q29udGVudCA9IGJhdGNoID8gYOW3sumAiSAke2JhdGNoLmNvdW50fSAvICR7YmF0Y2gudG90YWx9IOS4queVjOmdomAgOiB0aGlzLnNvdXJjZVVuY2hhbmdlZCgpID8gJ+W9k+WJjeiuvuiuoeW3suivu+WPlicgOiAn57KY6LS06ZO+5o6l77yM5byA5aeL6K+75Y+W6K6+6K6hJztcclxuICAgICAgICBlbHNlIGlmICh0aGlzLnN0ZXAgPT09IDQpIHRoaXMuZ2V0KCcjc2VsZWN0aW9uLXN1bW1hcnknKS50ZXh0Q29udGVudCA9ICflr7zlhaXlrozmiJDvvIzlj6/mjInpnIDmo4Dmn6Xnu5PmnpwnO1xyXG4gICAgICAgIGVsc2UgdGhpcy5nZXQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gYmF0Y2ggPyBgJHtiYXRjaC5jb3VudH0g5Liq55WM6Z2iIMK3ICR7dGhpcy5zZWxlY3RlZENvdW50KCl9IC8gJHtiYXRjaC5ub2Rlc30g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYFxyXG4gICAgICAgICAgICA6IGAke3RoaXMuc2VsZWN0ZWRDb3VudCgpfSAvICR7dGhpcy5ub2RlcygpLmxlbmd0aH0g5Liq6IqC54K55bCG5Y+C5LiO5a+85YWlYDtcclxuICAgICAgICBpZiAodGhpcy5yZXN1bHQpIHRoaXMucmVuZGVyUmVzdWx0KHRoaXMucmVzdWx0KTtcclxuICAgICAgICBpZiAoYmF0Y2g/LnJlc3VsdCAmJiB0aGlzLnN0ZXAgPT09IDQpIHtcclxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYmF0Y2gucmVzdWx0O1xyXG4gICAgICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC10aXRsZScpLnRleHRDb250ZW50ID0gcmVzdWx0LnN0b3BwZWQgPyAn5pys5om55a+85YWl5bey5YGc5q2iJyA6IHJlc3VsdC5mYWlsZWQgPyAn5pys5om55a+85YWl57uT5p2f77yM6YOo5YiG5aSx6LSlJyA6ICfmnKzmibnlr7zlhaXlrozmiJAnO1xyXG4gICAgICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBg5oiQ5YqfICR7cmVzdWx0LnN1Y2Nlc3N9IOmhuSDCtyDlpLHotKUgJHtyZXN1bHQuZmFpbGVkfSDpobkgwrcg5pyq5a6M5oiQICR7cmVzdWx0LnBlbmRpbmd9IOmhueOAguavj+S4queVjOmdoueahOajgOafpeaKpeWRiuWPr+WNleeLrOaJk+W8gOOAgmA7XHJcbiAgICAgICAgICAgIHRoaXMuZ2V0KCcjcmVzdWx0LXRhcmdldCcpLnRleHRDb250ZW50ID0gYGFzc2V0cy8ke2ZvbGRlcn0vYDtcclxuICAgICAgICAgICAgdGhpcy5nZXQoJyNzZWxlY3Rpb24tc3VtbWFyeScpLnRleHRDb250ZW50ID0gYOaIkOWKnyAke3Jlc3VsdC5zdWNjZXNzfSDCtyDlpLHotKUgJHtyZXN1bHQuZmFpbGVkfSDCtyDmnKrlrozmiJAgJHtyZXN1bHQucGVuZGluZ31gO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIOmAkOadoeWIl+WHuuacrOasoeWwhuimgeaUueWKqOeahOWGheWuue+8m+WPquWxleekuuaRmOimge+8jOS4jeS8muWBh+ijheiDveWumuS9jeaVtOWxguWtkOagkeWGhemDqOeahOWFt+S9k+WtkOWxguOAglxyXG4gICAgICovXHJcbiAgICBwcml2YXRlIHJlbmRlclN5bmNDaGFuZ2VzKHN5bmM6IFN5bmNQcmV2aWV3UmVzdWx0IHwgdW5kZWZpbmVkKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3QgYm94ID0gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcjc3luYy1jaGFuZ2VzJyk7XHJcbiAgICAgICAgY29uc3QgbGlzdCA9IHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignI3N5bmMtY2hhbmdlLWxpc3QnKTtcclxuICAgICAgICBpZiAoIWJveCB8fCAhbGlzdCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGl0ZW1zID0gc3luYz8uZXhpc3RzID8gc3luYy5pdGVtcyA6IFtdO1xyXG4gICAgICAgIGJveC5oaWRkZW4gPSBpdGVtcy5sZW5ndGggPT09IDA7XHJcbiAgICAgICAgaWYgKCFpdGVtcy5sZW5ndGgpIHtcclxuICAgICAgICAgICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcclxuICAgICAgICAgICAgdGhpcy5za2lwcGVkU3luY05vZGVJZHMuY2xlYXIoKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyDlj6rkv53nlZnku43nhLblh7rnjrDlnKjmuIXljZXph4znmoTlj5bmtojpobnvvIzpgb/lhY3ml6fpgInmi6nlvbHlk43mlrDkuIDmrKHpooTmo4DjgIJcclxuICAgICAgICBjb25zdCBhdmFpbGFibGUgPSBuZXcgU2V0KGl0ZW1zLm1hcCgoaXRlbSkgPT4gaXRlbS5ub2RlSWQpKTtcclxuICAgICAgICBmb3IgKGNvbnN0IG5vZGVJZCBvZiBbLi4udGhpcy5za2lwcGVkU3luY05vZGVJZHNdKSB7XHJcbiAgICAgICAgICAgIGlmICghYXZhaWxhYmxlLmhhcyhub2RlSWQpKSB0aGlzLnNraXBwZWRTeW5jTm9kZUlkcy5kZWxldGUobm9kZUlkKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY291bnQgPSB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcignI3N5bmMtY2hhbmdlcy1jb3VudCcpO1xyXG4gICAgICAgIGlmIChjb3VudCkge1xyXG4gICAgICAgICAgICBjb3VudC50ZXh0Q29udGVudCA9IGDlhbEgJHtzeW5jIS5hZGRlZCArIHN5bmMhLmNoYW5nZWQgKyBzeW5jIS5yZW1vdmVkfSDlpIQgwrcgYFxyXG4gICAgICAgICAgICAgICAgKyBgJHtzeW5jIS5hc3NldFN0YWxlQ291bnR9IOW8oOWbvumcgOabtOaWsGA7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHZpc2libGUgPSBpdGVtcy5zbGljZSgwLCA0MCk7XHJcbiAgICAgICAgY29uc3Qgcm93cyA9IHZpc2libGUubWFwKChpdGVtKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2xpJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IHNraXBwZWQgPSB0aGlzLnNraXBwZWRTeW5jTm9kZUlkcy5oYXMoaXRlbS5ub2RlSWQpO1xyXG4gICAgICAgICAgICByb3cuY2xhc3NOYW1lID0gYHN5bmMtY2hhbmdlLXJvdyBpcy0ke2l0ZW0uc3RhdHVzfSR7c2tpcHBlZCA/ICcgaXMtc2tpcHBlZCcgOiAnJ31gO1xyXG4gICAgICAgICAgICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbnB1dCcpO1xyXG4gICAgICAgICAgICBzZWxlY3QudHlwZSA9ICdjaGVja2JveCc7XHJcbiAgICAgICAgICAgIHNlbGVjdC5jbGFzc05hbWUgPSAnc3luYy1jaGFuZ2Utc2VsZWN0JztcclxuICAgICAgICAgICAgc2VsZWN0LmNoZWNrZWQgPSAhc2tpcHBlZDtcclxuICAgICAgICAgICAgc2VsZWN0LnNldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcsIGDlupTnlKggJHtpdGVtLm5hbWV9IOeahOaUueWKqGApO1xyXG4gICAgICAgICAgICBzZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgaWYgKHNlbGVjdC5jaGVja2VkKSB0aGlzLnNraXBwZWRTeW5jTm9kZUlkcy5kZWxldGUoaXRlbS5ub2RlSWQpO1xyXG4gICAgICAgICAgICAgICAgZWxzZSB0aGlzLnNraXBwZWRTeW5jTm9kZUlkcy5hZGQoaXRlbS5ub2RlSWQpO1xyXG4gICAgICAgICAgICAgICAgcm93LmNsYXNzTGlzdC50b2dnbGUoJ2lzLXNraXBwZWQnLCAhc2VsZWN0LmNoZWNrZWQpO1xyXG4gICAgICAgICAgICAgICAgdGhpcy5yZW5kZXJTeW5jU2VsZWN0aW9uKCk7XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgICAgICBuYW1lLmNsYXNzTmFtZSA9ICdzeW5jLWNoYW5nZS1uYW1lJztcclxuICAgICAgICAgICAgbmFtZS50ZXh0Q29udGVudCA9IGl0ZW0uc3RhdHVzID09PSAncmVtb3ZlZCcgPyBg4oiSICR7aXRlbS5uYW1lfWAgOiBpdGVtLm5hbWU7XHJcbiAgICAgICAgICAgIG5hbWUudGl0bGUgPSBpdGVtLm5vZGVJZDtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgICAgICBkZXRhaWwuY2xhc3NOYW1lID0gJ3N5bmMtY2hhbmdlLWZpZWxkcyc7XHJcbiAgICAgICAgICAgIGRldGFpbC50ZXh0Q29udGVudCA9IGl0ZW0uZmllbGRzLmpvaW4oJyDCtyAnKTtcclxuICAgICAgICAgICAgcm93LmFwcGVuZChzZWxlY3QsIG5hbWUsIGRldGFpbCk7XHJcbiAgICAgICAgICAgIGlmIChpdGVtLmFzc2V0U3RhbGUpIHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xyXG4gICAgICAgICAgICAgICAgYmFkZ2UuY2xhc3NOYW1lID0gJ3N5bmMtY2hhbmdlLWFzc2V0JztcclxuICAgICAgICAgICAgICAgIGJhZGdlLnRleHRDb250ZW50ID0gJ+WbvueJh+mcgOabtOaWsCc7XHJcbiAgICAgICAgICAgICAgICByb3cuYXBwZW5kKGJhZGdlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4gcm93O1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiB2aXNpYmxlLmxlbmd0aCkge1xyXG4gICAgICAgICAgICBjb25zdCBtb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcclxuICAgICAgICAgICAgbW9yZS5jbGFzc05hbWUgPSAnc3luYy1jaGFuZ2Utcm93IGlzLW1vcmUnO1xyXG4gICAgICAgICAgICBtb3JlLnRleHRDb250ZW50ID0gYOWPpuaciSAke2l0ZW1zLmxlbmd0aCAtIHZpc2libGUubGVuZ3RofSDlpITmnKrlsZXlvIBgO1xyXG4gICAgICAgICAgICByb3dzLnB1c2gobW9yZSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKC4uLnJvd3MpO1xyXG4gICAgICAgIHRoaXMucmVuZGVyU3luY1NlbGVjdGlvbigpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKiDmnKzmrKHopoHot7Pov4fnmoToioLngrnvvIjmlLnliqjmuIXljZXph4zlj5bmtojli77pgInnmoTpobnvvInjgIIgKi9cclxuICAgIGdldCBza2lwcGVkU3luY05vZGVzKCk6IHN0cmluZ1tdIHtcclxuICAgICAgICByZXR1cm4gWy4uLnRoaXMuc2tpcHBlZFN5bmNOb2RlSWRzXTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHJlbmRlclN5bmNTZWxlY3Rpb24oKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3Qgc3VtbWFyeSA9IHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yKCcjc3luYy1zZWxlY3Rpb24tc3VtbWFyeScpO1xyXG4gICAgICAgIGNvbnN0IHRvZ2dsZSA9IHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignI3N5bmMtdG9nZ2xlLWFsbCcpO1xyXG4gICAgICAgIGNvbnN0IHN5bmMgPSB0aGlzLmNvbnRleHQoKS5zeW5jUHJldmlldztcclxuICAgICAgICBjb25zdCB0b3RhbCA9IHN5bmM/LmV4aXN0cyA/IHN5bmMuaXRlbXMubGVuZ3RoIDogMDtcclxuICAgICAgICBjb25zdCBza2lwcGVkID0gdGhpcy5za2lwcGVkU3luY05vZGVJZHMuc2l6ZTtcclxuICAgICAgICBpZiAoc3VtbWFyeSkge1xyXG4gICAgICAgICAgICBzdW1tYXJ5LnRleHRDb250ZW50ID0gc2tpcHBlZCA9PT0gMFxyXG4gICAgICAgICAgICAgICAgPyAn5YWo6YOo5Yu+6YCJJ1xyXG4gICAgICAgICAgICAgICAgOiBg5bey5Yu+6YCJICR7TWF0aC5tYXgoMCwgdG90YWwgLSBza2lwcGVkKX0gLyAke3RvdGFsfSDlpIRgO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAodG9nZ2xlKSB7XHJcbiAgICAgICAgICAgIHRvZ2dsZS50ZXh0Q29udGVudCA9IHNraXBwZWQgPT09IDAgPyAn5YWo5LiN6YCJJyA6ICflhajpgIknO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHJlbmRlclJlc3VsdChyZXN1bHQ6IFdvcmtmbG93UmVzdWx0KTogdm9pZCB7XHJcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcmVzdWx0LnJldmlldztcclxuICAgICAgICBjb25zdCBjcmVhdGVkID0gcmVzdWx0LmNyZWF0ZWQgPz8gcmV2aWV3Py5jaGFuZ2VzLmZpbHRlcigobm9kZSkgPT4gbm9kZS5zdGF0dXMgPT09ICdhZGRlZCcpLmxlbmd0aDtcclxuICAgICAgICBjb25zdCB1cGRhdGVkID0gcmVzdWx0LnVwZGF0ZWQgPz8gcmV2aWV3Py5jaGFuZ2VzLmZpbHRlcigobm9kZSkgPT4gbm9kZS5zdGF0dXMgPT09ICdjaGFuZ2VkJykubGVuZ3RoO1xyXG4gICAgICAgIGNvbnN0IHdhcm5pbmdzID0gcmVzdWx0Lndhcm5pbmdzPy5sZW5ndGggPz8gcmV2aWV3Py53YXJuaW5ncy5sZW5ndGggPz8gMDtcclxuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC10aXRsZScpLnRleHRDb250ZW50ID0gJ+WvvOWFpeWujOaIkO+8jOajgOafpeS4gOS4i+e7k+aenCc7XHJcbiAgICAgICAgdGhpcy5nZXQoJyNyZXN1bHQtc3VtbWFyeScpLnRleHRDb250ZW50ID0gYCR7cmV2aWV3Py5maWxlTmFtZSA/PyB0aGlzLmNvbnRleHQoKS5kb2N1bWVudD8uZmlsZU5hbWUgPz8gJ+iuvuiuoSd9IOW3suWujOaIkOWvvOWFpSR7d2FybmluZ3MgPyBg77yM5pyJICR7d2FybmluZ3N9IOadoeWvvOWFpS/mlLblsL7mj5DnpLrjgIJgIDogJ+OAgid9YDtcclxuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC10YXJnZXQnKS50ZXh0Q29udGVudCA9IHJlc3VsdC5wcmVmYWJVcmwgPz8gcmV2aWV3Py50YXJnZXRVcmwgPz8gJ+W9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K5JztcclxuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC1jcmVhdGVkJykudGV4dENvbnRlbnQgPSBjcmVhdGVkID09PSB1bmRlZmluZWQgPyAn4oCUJyA6IFN0cmluZyhjcmVhdGVkKTtcclxuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC11cGRhdGVkJykudGV4dENvbnRlbnQgPSB1cGRhdGVkID09PSB1bmRlZmluZWQgPyAn4oCUJyA6IFN0cmluZyh1cGRhdGVkKTtcclxuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC13YXJuaW5ncycpLnRleHRDb250ZW50ID0gU3RyaW5nKHdhcm5pbmdzKTtcclxuICAgIH1cclxufVxyXG4iXX0=