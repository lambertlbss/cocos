"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PanelWorkflow = void 0;
const url_1 = require("../../figma/url");
/** Presentation state only. Import requests and project settings remain owned by the panel. */
class PanelWorkflow {
    constructor(host, context, openReview) {
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
            ? `${context.document.fileName} / ${this.prefabTarget() ? 'Frame' : '文件'} / ${this.nodes().length} 个节点`
            : '先读取设计，再逐步配置';
        this.get('#change-source').disabled = locked;
        this.get('#reopen-import-review').hidden = !this.reviewAvailable || this.step === 4;
        this.get('#reopen-import-review').disabled = locked;
        this.get('#workflow-error').hidden = !this.error;
        this.get('#workflow-error-message').textContent = this.error;
        this.get('#source-status').textContent = this.pending === 'fetch' ? '正在读取设计，请稍候…'
            : this.sourceUnchanged() ? '当前设计已读取，可以直接继续。修改链接后重新读取，成功后替换当前设计。'
                : this.hasToken ? '凭据已保存。读取成功后自动进入节点配置，沿用项目的目录与字体设置。'
                    : '首次使用请先配置 Figma 凭据，保存后再读取设计。';
        this.host.querySelector('.setup-card').hidden = this.hasToken;
        this.get('#refresh-document').hidden = !hasDocument;
        this.get('#refresh-document').disabled = locked;
        const fetch = this.get('#fetch-document');
        fetch.hidden = this.step !== 1;
        fetch.disabled = locked;
        fetch.textContent = this.pending === 'fetch' ? '正在读取…' : !this.hasToken ? '配置连接 →' : this.sourceUnchanged() ? '返回节点配置 →' : '读取设计，下一步 →';
        const next = this.get('#workflow-next');
        next.hidden = this.step !== 2;
        next.disabled = locked || this.selectedCount() === 0;
        const back = this.get('#workflow-back');
        back.hidden = this.step === 1 || locked;
        back.disabled = locked;
        back.textContent = this.step === 4 ? '返回节点配置' : '上一步';
        const importing = this.get('#import-button');
        importing.hidden = this.step !== 3;
        importing.disabled = locked || !hasDocument || !context.runtimeCompatible || this.selectedCount() === 0;
        const cancel = this.get('#cancel-import');
        const cancellable = locked && this.pending !== null;
        cancel.hidden = !cancellable;
        cancel.classList.toggle('is-hidden', !cancellable);
        cancel.disabled = this.cancelling;
        cancel.textContent = this.cancelling ? '正在取消…' : this.pending === 'fetch' ? '取消读取' : '取消导入';
        const review = this.get('#open-import-review');
        review.hidden = this.step !== 4;
        review.disabled = locked;
        review.textContent = '查看导入检查 →';
        this.get('#progress-region').hidden = this.step !== 3 || (this.pending !== 'import' && !this.error && !this.cancelled && !context.busy);
        const prefab = this.prefabTarget();
        this.get('#confirmation-target').textContent = prefab ? '创建或更新独立预制体' : '导入当前场景 Canvas';
        const folder = this.get('#prefab-folder').value.trim();
        this.get('#confirmation-path').textContent = prefab ? `assets/${folder}/ · 按 Frame 节点名保存 .prefab` : '当前场景的 Canvas 根节点下';
        for (const id of ['#update-existing', '#auto-save']) {
            const input = this.get(id);
            input.disabled = locked || prefab;
            (_b = input.closest('label')) === null || _b === void 0 ? void 0 : _b.classList.toggle('is-inapplicable', prefab);
            input.title = prefab ? '仅场景导入生效；Frame 链接自动同步并保存预制体' : '';
        }
        const confirmation = this.host.querySelector('#confirmation-summary');
        if (confirmation)
            confirmation.textContent = `${this.selectedCount()} 个节点 · ${this.get('#scale').value}× · 项目目录与字体设置已保留`;
        const advanced = this.host.querySelector('#advanced-summary');
        if (advanced) {
            const folders = [0, 1, 2].filter((index) => this.get(`#local-resource-folder-${index}`).value.trim()).length;
            const fonts = Array.from(this.host.querySelectorAll('[data-font-family]')).filter((select) => select.value).length;
            advanced.textContent = `本地目录 ${folders} 项 · 字体映射 ${fonts} 项 · 可按需展开`;
        }
        this.get('#action-note').textContent = !context.runtimeCompatible ? '主进程与面板版本不一致，请保存项目并完整重启 Cocos Creator。'
            : this.step === 1 ? '成功读取后进入第 2 步，已有项目设置会继续保留。'
                : this.step === 2 ? '可以沿用当前策略；下一步核对输出位置。'
                    : this.step === 3 ? this.cancelling ? '等待后台任务结束后，可以再次调整设置。'
                        : prefab ? '预制体自动写入所选目录并打开；同名资源按现有规则复用。' : '导入到当前场景 Canvas 根节点下。'
                        : '结果检查不会重新执行导入。';
        const footnote = this.host.querySelector('#workflow-footnote');
        if (footnote) {
            footnote.textContent = this.cancelled ? '操作已取消，配置已保留。' : '';
            footnote.hidden = !this.cancelled;
        }
        if (this.step === 1)
            this.get('#selection-summary').textContent = this.sourceUnchanged() ? '当前设计已读取' : '粘贴链接，开始读取设计';
        else if (this.step === 4)
            this.get('#selection-summary').textContent = '导入完成，可按需检查结果';
        else
            this.get('#selection-summary').textContent = `${this.selectedCount()} / ${this.nodes().length} 个节点将参与导入`;
        if (this.result)
            this.renderResult(this.result);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid29ya2Zsb3cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvd29ya2Zsb3cudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEseUNBQW1EO0FBcUJuRCwrRkFBK0Y7QUFDL0YsTUFBYSxhQUFhO0lBWXRCLFlBQ3FCLElBQWlCLEVBQ2pCLE9BQThCLEVBQzlCLFVBQXdEO1FBRnhELFNBQUksR0FBSixJQUFJLENBQWE7UUFDakIsWUFBTyxHQUFQLE9BQU8sQ0FBdUI7UUFDOUIsZUFBVSxHQUFWLFVBQVUsQ0FBOEM7UUFkN0UsU0FBSSxHQUFpQixDQUFDLENBQUM7UUFDdkIsWUFBTyxHQUFxQixJQUFJLENBQUM7UUFDakMsY0FBUyxHQUFHLEtBQUssQ0FBQztRQUNWLGFBQVEsR0FBRyxDQUFDLENBQUM7UUFDYixhQUFRLEdBQUcsS0FBSyxDQUFDO1FBQ2pCLGVBQVUsR0FBRyxLQUFLLENBQUM7UUFDbkIsVUFBSyxHQUFHLEVBQUUsQ0FBQztRQUNYLFdBQU0sR0FBMEIsSUFBSSxDQUFDO1FBQ3JDLG9CQUFlLEdBQUcsS0FBSyxDQUFDO1FBQ3hCLHNCQUFpQixHQUFvRyxFQUFFLENBQUM7UUFPNUgsSUFBSSxDQUFDLGdCQUFnQixDQUFvQixzQkFBc0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFO1lBQ2hGLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQWlCLENBQUMsQ0FBQyxDQUFDO1FBQy9HLENBQUMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJ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QUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDeEYsSUFBSSxDQUFDLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLFdBQVcsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDaEUsQ0FBQztDQUNKO0FBdFNELHNDQXNTQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IHBhcnNlRmlnbWFTb3VyY2UgfSBmcm9tICcuLi8uLi9maWdtYS91cmwnO1xuaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcgfSBmcm9tICcuLi8uLi9pbXBvcnQtcmV2aWV3LW1vZGVsJztcbmltcG9ydCB0eXBlIHsgSW1wb3J0QWN0aW9uLCBJbXBvcnRTZXR0aW5ncywgUHJvZ3Jlc3NFdmVudCwgVHJlZU5vZGVEdG8gfSBmcm9tICcuLi8uLi90eXBlcyc7XG5cbmV4cG9ydCB0eXBlIFdvcmtmbG93U3RlcCA9IDEgfCAyIHwgMyB8IDQ7XG50eXBlIE9wZXJhdGlvbiA9ICdmZXRjaCcgfCAnaW1wb3J0JztcbmludGVyZmFjZSBXb3JrZmxvd0NvbnRleHQge1xuICAgIGRvY3VtZW50OiB7IGZpbGVOYW1lOiBzdHJpbmc7IHNvdXJjZVVybDogc3RyaW5nOyB0cmVlOiBUcmVlTm9kZUR0b1tdIH0gfCBudWxsO1xuICAgIGFjdGlvbnM6IE1hcDxzdHJpbmcsIEltcG9ydEFjdGlvbj47XG4gICAgYnVzeTogYm9vbGVhbjtcbiAgICBydW50aW1lQ29tcGF0aWJsZTogYm9vbGVhbjtcbiAgICBzZXR0aW5nczogSW1wb3J0U2V0dGluZ3M7XG59XG5leHBvcnQgaW50ZXJmYWNlIFdvcmtmbG93UmVzdWx0IHtcbiAgICBjcmVhdGVkPzogbnVtYmVyO1xuICAgIHVwZGF0ZWQ/OiBudW1iZXI7XG4gICAgcHJlZmFiVXJsPzogc3RyaW5nO1xuICAgIHdhcm5pbmdzPzogc3RyaW5nW107XG4gICAgcmV2aWV3PzogSW1wb3J0UmV2aWV3O1xufVxuXG4vKiogUHJlc2VudGF0aW9uIHN0YXRlIG9ubHkuIEltcG9ydCByZXF1ZXN0cyBhbmQgcHJvamVjdCBzZXR0aW5ncyByZW1haW4gb3duZWQgYnkgdGhlIHBhbmVsLiAqL1xuZXhwb3J0IGNsYXNzIFBhbmVsV29ya2Zsb3cge1xuICAgIHN0ZXA6IFdvcmtmbG93U3RlcCA9IDE7XG4gICAgcGVuZGluZzogT3BlcmF0aW9uIHwgbnVsbCA9IG51bGw7XG4gICAgY2FuY2VsbGVkID0gZmFsc2U7XG4gICAgcHJpdmF0ZSB1bmxvY2tlZCA9IDE7XG4gICAgcHJpdmF0ZSBoYXNUb2tlbiA9IGZhbHNlO1xuICAgIHByaXZhdGUgY2FuY2VsbGluZyA9IGZhbHNlO1xuICAgIHByaXZhdGUgZXJyb3IgPSAnJztcbiAgICBwcml2YXRlIHJlc3VsdDogV29ya2Zsb3dSZXN1bHQgfCBudWxsID0gbnVsbDtcbiAgICBwcml2YXRlIHJldmlld0F2YWlsYWJsZSA9IGZhbHNlO1xuICAgIHByaXZhdGUgb3BlcmF0aW9uQ29udHJvbHM6IEFycmF5PHsgY29udHJvbDogSFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50IHwgSFRNTEJ1dHRvbkVsZW1lbnQ7IGRpc2FibGVkOiBib29sZWFuIH0+ID0gW107XG5cbiAgICBjb25zdHJ1Y3RvcihcbiAgICAgICAgcHJpdmF0ZSByZWFkb25seSBob3N0OiBIVE1MRWxlbWVudCxcbiAgICAgICAgcHJpdmF0ZSByZWFkb25seSBjb250ZXh0OiAoKSA9PiBXb3JrZmxvd0NvbnRleHQsXG4gICAgICAgIHByaXZhdGUgcmVhZG9ubHkgb3BlblJldmlldzogKHRhYjogJ2Fzc2V0cycgfCAnbm9kZXMnIHwgJ3NvdXJjZScpID0+IHZvaWQsXG4gICAgKSB7XG4gICAgICAgIGhvc3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXdvcmtmbG93LXN0ZXBdJykuZm9yRWFjaCgoYnV0dG9uKSA9PiB7XG4gICAgICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLm5hdmlnYXRlKE51bWJlcihidXR0b24uZGF0YXNldC53b3JrZmxvd1N0ZXApIGFzIFdvcmtmbG93U3RlcCkpO1xuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1iYWNrJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLm5hdmlnYXRlKHRoaXMuc3RlcCA9PT0gNCA/IDIgOiAodGhpcy5zdGVwIC0gMSkgYXMgV29ya2Zsb3dTdGVwKSk7XG4gICAgICAgIHRoaXMuZ2V0KCcjY2hhbmdlLXNvdXJjZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy5uYXZpZ2F0ZSgxKSk7XG4gICAgICAgIHRoaXMuZ2V0KCcjcmVvcGVuLWltcG9ydC1yZXZpZXcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgaWYgKCF0aGlzLmxvY2tlZCkgdGhpcy5vcGVuUmV2aWV3KCdhc3NldHMnKTsgfSk7XG4gICAgICAgIHRoaXMuZ2V0KCcjd29ya2Zsb3ctbmV4dCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4ge1xuICAgICAgICAgICAgaWYgKHRoaXMubG9ja2VkIHx8ICF0aGlzLmNvbnRleHQoKS5kb2N1bWVudCB8fCB0aGlzLnNlbGVjdGVkQ291bnQoKSA9PT0gMCkgcmV0dXJuO1xuICAgICAgICAgICAgdGhpcy51bmxvY2tlZCA9IE1hdGgubWF4KDMsIHRoaXMudW5sb2NrZWQpO1xuICAgICAgICAgICAgdGhpcy5uYXZpZ2F0ZSgzKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuZ2V0KCcjbWFuYWdlLWNyZWRlbnRpYWxzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLm9wZW5DcmVkZW50aWFscygpKTtcbiAgICAgICAgdGhpcy5nZXQoJyNjb25maWd1cmUtY3JlZGVudGlhbHMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMub3BlbkNyZWRlbnRpYWxzKCkpO1xuICAgICAgICB0aGlzLmdldCgnI2Nsb3NlLWNyZWRlbnRpYWxzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB0aGlzLmNsb3NlQ3JlZGVudGlhbHMoKSk7XG4gICAgICAgIHRoaXMuZ2V0PEhUTUxEaWFsb2dFbGVtZW50PignI2NyZWRlbnRpYWwtZGlhbG9nJykuYWRkRXZlbnRMaXN0ZW5lcignY2FuY2VsJywgKGV2ZW50KSA9PiB7XG4gICAgICAgICAgICBpZiAodGhpcy5sb2NrZWQpIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmdldCgnI2Rpc21pc3Mtd29ya2Zsb3ctZXJyb3InKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsgdGhpcy5lcnJvciA9ICcnOyB0aGlzLnJlbmRlcigpOyB9KTtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTElucHV0RWxlbWVudD4oJyNzb3VyY2UtdXJsJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLCAoKSA9PiB0aGlzLnJlbmRlcigpKTtcbiAgICAgICAgaG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtcmV2aWV3LXRhYl0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcbiAgICAgICAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIXRoaXMubG9ja2VkKSB0aGlzLm9wZW5SZXZpZXcoYnV0dG9uLmRhdGFzZXQucmV2aWV3VGFiIGFzICdhc3NldHMnIHwgJ25vZGVzJyB8ICdzb3VyY2UnKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgaG9zdC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCAoKSA9PiB0aGlzLnJlbmRlcigpKTtcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG5cbiAgICBwcml2YXRlIGdldDxUIGV4dGVuZHMgSFRNTEVsZW1lbnQgPSBIVE1MRWxlbWVudD4oc2VsZWN0b3I6IHN0cmluZyk6IFQge1xuICAgICAgICByZXR1cm4gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3I8VD4oc2VsZWN0b3IpITtcbiAgICB9XG5cbiAgICBnZXQgbG9ja2VkKCk6IGJvb2xlYW4geyByZXR1cm4gdGhpcy5jb250ZXh0KCkuYnVzeSB8fCB0aGlzLnBlbmRpbmcgIT09IG51bGw7IH1cbiAgICBnZXQgY3JlZGVudGlhbHNSZWFkeSgpOiBib29sZWFuIHsgcmV0dXJuIHRoaXMuaGFzVG9rZW47IH1cblxuICAgIHByaXZhdGUgbm9kZXMoKTogVHJlZU5vZGVEdG9bXSB7XG4gICAgICAgIGNvbnN0IGZsYXR0ZW4gPSAoaXRlbXM6IFRyZWVOb2RlRHRvW10pOiBUcmVlTm9kZUR0b1tdID0+IGl0ZW1zLmZsYXRNYXAoKG5vZGUpID0+IFtub2RlLCAuLi5mbGF0dGVuKG5vZGUuY2hpbGRyZW4pXSk7XG4gICAgICAgIHJldHVybiBmbGF0dGVuKHRoaXMuY29udGV4dCgpLmRvY3VtZW50Py50cmVlID8/IFtdKTtcbiAgICB9XG5cbiAgICBwcml2YXRlIHNlbGVjdGVkQ291bnQoKTogbnVtYmVyIHtcbiAgICAgICAgcmV0dXJuIHRoaXMubm9kZXMoKS5maWx0ZXIoKG5vZGUpID0+IHRoaXMuY29udGV4dCgpLmFjdGlvbnMuZ2V0KG5vZGUuaWQpICE9PSAnaWdub3JlJykubGVuZ3RoO1xuICAgIH1cblxuICAgIHByaXZhdGUgcHJlZmFiVGFyZ2V0KCk6IGJvb2xlYW4ge1xuICAgICAgICBjb25zdCBkb2N1bWVudCA9IHRoaXMuY29udGV4dCgpLmRvY3VtZW50O1xuICAgICAgICBpZiAoIWRvY3VtZW50IHx8IGRvY3VtZW50LnRyZWUubGVuZ3RoICE9PSAxKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIHRyeSB7IHJldHVybiBCb29sZWFuKHBhcnNlRmlnbWFTb3VyY2UoZG9jdW1lbnQuc291cmNlVXJsKS5ub2RlSWQpOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG4gICAgfVxuXG4gICAgc291cmNlVW5jaGFuZ2VkKCk6IGJvb2xlYW4ge1xuICAgICAgICByZXR1cm4gQm9vbGVhbih0aGlzLmNvbnRleHQoKS5kb2N1bWVudClcbiAgICAgICAgICAgICYmIHRoaXMuZ2V0PEhUTUxJbnB1dEVsZW1lbnQ+KCcjc291cmNlLXVybCcpLnZhbHVlLnRyaW0oKSA9PT0gdGhpcy5jb250ZXh0KCkuZG9jdW1lbnQhLnNvdXJjZVVybC50cmltKCk7XG4gICAgfVxuXG4gICAgc2V0Q29ubmVjdGlvbihoYXNUb2tlbjogYm9vbGVhbik6IHZvaWQge1xuICAgICAgICB0aGlzLmhhc1Rva2VuID0gaGFzVG9rZW47XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgb3BlbkNyZWRlbnRpYWxzKCk6IHZvaWQge1xuICAgICAgICBpZiAodGhpcy5sb2NrZWQpIHJldHVybjtcbiAgICAgICAgY29uc3QgZGlhbG9nID0gdGhpcy5nZXQ8SFRNTERpYWxvZ0VsZW1lbnQ+KCcjY3JlZGVudGlhbC1kaWFsb2cnKTtcbiAgICAgICAgaWYgKCFkaWFsb2cub3BlbikgZGlhbG9nLnNob3dNb2RhbCgpO1xuICAgICAgICB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PignI3Rva2VuLWlucHV0JykuZm9jdXMoKTtcbiAgICB9XG5cbiAgICBjbG9zZUNyZWRlbnRpYWxzKCk6IHZvaWQge1xuICAgICAgICBpZiAodGhpcy5sb2NrZWQpIHJldHVybjtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTERpYWxvZ0VsZW1lbnQ+KCcjY3JlZGVudGlhbC1kaWFsb2cnKS5jbG9zZSgpO1xuICAgIH1cblxuICAgIG5hdmlnYXRlKHN0ZXA6IFdvcmtmbG93U3RlcCk6IHZvaWQge1xuICAgICAgICBpZiAodGhpcy5sb2NrZWQgfHwgc3RlcCA8IDEgfHwgc3RlcCA+IHRoaXMudW5sb2NrZWQgfHwgKHN0ZXAgPiAxICYmICF0aGlzLnNvdXJjZVVuY2hhbmdlZCgpKSkgcmV0dXJuO1xuICAgICAgICB0aGlzLnN0ZXAgPSBzdGVwO1xuICAgICAgICB0aGlzLnJlbmRlcigpO1xuICAgICAgICB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYFtkYXRhLXdvcmtmbG93LXBhbmVsPVwiJHtzdGVwfVwiXSBoMmApPy5mb2N1cygpO1xuICAgIH1cblxuICAgIGRvY3VtZW50UmVhZHkoKTogdm9pZCB7XG4gICAgICAgIHRoaXMudW5sb2NrZWQgPSAyO1xuICAgICAgICB0aGlzLnJlc3VsdCA9IG51bGw7XG4gICAgICAgIHRoaXMuZXJyb3IgPSAnJztcbiAgICAgICAgdGhpcy5zdGVwID0gMjtcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG5cbiAgICBiZWdpbihvcGVyYXRpb246IE9wZXJhdGlvbik6IHZvaWQge1xuICAgICAgICB0aGlzLnBlbmRpbmcgPSBvcGVyYXRpb247XG4gICAgICAgIHRoaXMuY2FuY2VsbGVkID0gZmFsc2U7XG4gICAgICAgIHRoaXMuY2FuY2VsbGluZyA9IGZhbHNlO1xuICAgICAgICB0aGlzLmVycm9yID0gJyc7XG4gICAgICAgIGlmIChvcGVyYXRpb24gPT09ICdpbXBvcnQnKSB0aGlzLnN0ZXAgPSAzO1xuICAgICAgICB0aGlzLnJlbmRlcigpO1xuICAgIH1cblxuICAgIGVuZCgpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5wZW5kaW5nID0gbnVsbDtcbiAgICAgICAgdGhpcy5jYW5jZWxsaW5nID0gZmFsc2U7XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgZmFpbChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5lcnJvciA9IG1lc3NhZ2U7XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgY2xlYXJFcnJvcigpOiB2b2lkIHsgdGhpcy5lcnJvciA9ICcnOyB0aGlzLnJlbmRlcigpOyB9XG5cbiAgICByZW1lbWJlclJldmlldygpOiB2b2lkIHsgdGhpcy5yZXZpZXdBdmFpbGFibGUgPSB0cnVlOyB0aGlzLnJlbmRlcigpOyB9XG5cbiAgICBjYW5jZWxSZXF1ZXN0ZWQoKTogdm9pZCB7XG4gICAgICAgIHRoaXMuY2FuY2VsbGluZyA9IHRydWU7XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgY2FuY2VsUmVxdWVzdEZhaWxlZChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICAgICAgdGhpcy5jYW5jZWxsaW5nID0gZmFsc2U7XG4gICAgICAgIHRoaXMuZmFpbChtZXNzYWdlKTtcbiAgICB9XG5cbiAgICBwcm9ncmVzcyhldmVudDogUHJvZ3Jlc3NFdmVudCk6IHZvaWQge1xuICAgICAgICBpZiAoZXZlbnQucGhhc2UgPT09ICdhc3NldHMnIHx8IGV2ZW50LnBoYXNlID09PSAnc2NlbmUnKSB7XG4gICAgICAgICAgICB0aGlzLnN0ZXAgPSAzO1xuICAgICAgICAgICAgdGhpcy51bmxvY2tlZCA9IE1hdGgubWF4KHRoaXMudW5sb2NrZWQsIDMpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChldmVudC5waGFzZSA9PT0gJ2NhbmNlbGxlZCcgfHwgKGV2ZW50LnBoYXNlID09PSAnZXJyb3InICYmIHRoaXMucGVuZGluZyA9PT0gJ2ZldGNoJyAmJiB0aGlzLmNhbmNlbGxpbmcpKSB7XG4gICAgICAgICAgICB0aGlzLmNhbmNlbGxlZCA9IHRydWU7XG4gICAgICAgICAgICB0aGlzLmVycm9yID0gJyc7XG4gICAgICAgIH0gZWxzZSBpZiAoZXZlbnQucGhhc2UgPT09ICdlcnJvcicpIHtcbiAgICAgICAgICAgIHRoaXMuZXJyb3IgPSBldmVudC5tZXNzYWdlO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMucmVuZGVyKCk7XG4gICAgfVxuXG4gICAgY29tcGxldGUocmVzdWx0OiBXb3JrZmxvd1Jlc3VsdCk6IHZvaWQge1xuICAgICAgICB0aGlzLnJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgaWYgKHJlc3VsdC5yZXZpZXcpIHRoaXMucmV2aWV3QXZhaWxhYmxlID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5lcnJvciA9ICcnO1xuICAgICAgICB0aGlzLmNhbmNlbGxlZCA9IGZhbHNlO1xuICAgICAgICB0aGlzLnN0ZXAgPSA0O1xuICAgICAgICB0aGlzLnVubG9ja2VkID0gNDtcbiAgICAgICAgdGhpcy5yZW5kZXIoKTtcbiAgICB9XG5cbiAgICBwcml2YXRlIGxvY2tFZGl0aW5nKGxvY2tlZDogYm9vbGVhbik6IHZvaWQge1xuICAgICAgICBpZiAobG9ja2VkICYmIHRoaXMub3BlcmF0aW9uQ29udHJvbHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBjb25zdCBzZWxlY3RvcnMgPSAnLndvcmtmbG93LXBhbmVsIGlucHV0LCAud29ya2Zsb3ctcGFuZWwgc2VsZWN0LCAud29ya2Zsb3ctcGFuZWwgYnV0dG9uLCBbZGF0YS1wcmVzZXRdLCAjdmVyaWZ5LXRva2VuLCAjY2xlYXItdG9rZW4nO1xuICAgICAgICAgICAgdGhpcy5vcGVyYXRpb25Db250cm9scyA9IEFycmF5LmZyb20odGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudCB8IEhUTUxTZWxlY3RFbGVtZW50IHwgSFRNTEJ1dHRvbkVsZW1lbnQ+KHNlbGVjdG9ycykpXG4gICAgICAgICAgICAgICAgLm1hcCgoY29udHJvbCkgPT4gKHsgY29udHJvbCwgZGlzYWJsZWQ6IGNvbnRyb2wuZGlzYWJsZWQgfSkpO1xuICAgICAgICAgICAgdGhpcy5vcGVyYXRpb25Db250cm9scy5mb3JFYWNoKCh7IGNvbnRyb2wgfSkgPT4geyBjb250cm9sLmRpc2FibGVkID0gdHJ1ZTsgfSk7XG4gICAgICAgIH0gZWxzZSBpZiAoIWxvY2tlZCAmJiB0aGlzLm9wZXJhdGlvbkNvbnRyb2xzLmxlbmd0aCkge1xuICAgICAgICAgICAgdGhpcy5vcGVyYXRpb25Db250cm9scy5mb3JFYWNoKCh7IGNvbnRyb2wsIGRpc2FibGVkIH0pID0+IHsgY29udHJvbC5kaXNhYmxlZCA9IGRpc2FibGVkOyB9KTtcbiAgICAgICAgICAgIHRoaXMub3BlcmF0aW9uQ29udHJvbHMgPSBbXTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJlbmRlcigpOiB2b2lkIHtcbiAgICAgICAgY29uc3QgY29udGV4dCA9IHRoaXMuY29udGV4dCgpO1xuICAgICAgICBjb25zdCBsb2NrZWQgPSB0aGlzLmxvY2tlZDtcbiAgICAgICAgY29uc3QgaGFzRG9jdW1lbnQgPSBCb29sZWFuKGNvbnRleHQuZG9jdW1lbnQpO1xuICAgICAgICB0aGlzLmhvc3QuZGF0YXNldC53b3JrZmxvd1N0ZXAgPSBTdHJpbmcodGhpcy5zdGVwKTtcbiAgICAgICAgdGhpcy5ob3N0LmRhdGFzZXQud29ya2Zsb3dCdXN5ID0gU3RyaW5nKGxvY2tlZCk7XG4gICAgICAgIHRoaXMuaG9zdC5kYXRhc2V0LndvcmtmbG93T3BlcmF0aW9uID0gdGhpcy5wZW5kaW5nID8/ICcnO1xuICAgICAgICB0aGlzLmhvc3QuZGF0YXNldC53b3JrZmxvd0NhbmNlbGxpbmcgPSBTdHJpbmcodGhpcy5jYW5jZWxsaW5nKTtcbiAgICAgICAgdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS13b3JrZmxvdy1wYW5lbF0nKS5mb3JFYWNoKChwYW5lbCkgPT4ge1xuICAgICAgICAgICAgcGFuZWwuaGlkZGVuID0gTnVtYmVyKHBhbmVsLmRhdGFzZXQud29ya2Zsb3dQYW5lbCkgIT09IHRoaXMuc3RlcDtcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtd29ya2Zsb3ctc3RlcF0nKS5mb3JFYWNoKChidXR0b24pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHN0ZXAgPSBOdW1iZXIoYnV0dG9uLmRhdGFzZXQud29ya2Zsb3dTdGVwKTtcbiAgICAgICAgICAgIGNvbnN0IGN1cnJlbnQgPSBzdGVwID09PSB0aGlzLnN0ZXA7XG4gICAgICAgICAgICBjb25zdCBjb21wbGV0ZSA9IHN0ZXAgPCB0aGlzLnVubG9ja2VkICYmICFjdXJyZW50O1xuICAgICAgICAgICAgYnV0dG9uLmRpc2FibGVkID0gbG9ja2VkIHx8IHN0ZXAgPiB0aGlzLnVubG9ja2VkIHx8IChzdGVwID4gMSAmJiAhdGhpcy5zb3VyY2VVbmNoYW5nZWQoKSk7XG4gICAgICAgICAgICBidXR0b24uY2xhc3NMaXN0LnRvZ2dsZSgnaXMtY3VycmVudCcsIGN1cnJlbnQpO1xuICAgICAgICAgICAgYnV0dG9uLmNsYXNzTGlzdC50b2dnbGUoJ2lzLWNvbXBsZXRlJywgY29tcGxldGUpO1xuICAgICAgICAgICAgaWYgKGN1cnJlbnQpIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoJ2FyaWEtY3VycmVudCcsICdzdGVwJyk7IGVsc2UgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZSgnYXJpYS1jdXJyZW50Jyk7XG4gICAgICAgICAgICBidXR0b24ucXVlcnlTZWxlY3RvcignLnN0ZXAtbnVtYmVyJykhLnRleHRDb250ZW50ID0gY29tcGxldGUgPyAn4pyTJyA6IFN0cmluZyhzdGVwKTtcbiAgICAgICAgICAgIGJ1dHRvbi5xdWVyeVNlbGVjdG9yKCcuc3RlcC1jYXB0aW9uJykhLnRleHRDb250ZW50ID0gY3VycmVudFxuICAgICAgICAgICAgICAgID8gbG9ja2VkICYmIHRoaXMucGVuZGluZyA9PT0gJ2ltcG9ydCcgPyAn5q2j5Zyo5omn6KGMJyA6ICflvZPliY3mraXpqqQnXG4gICAgICAgICAgICAgICAgOiBjb21wbGV0ZSA/IGxvY2tlZCA/ICflt7LlrozmiJAnIDogJ+W3suWujOaIkCDCtyDlj6/ov5Tlm54nIDogJ+W+heWujOaIkCc7XG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmxvY2tFZGl0aW5nKGxvY2tlZCk7XG4gICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI21hbmFnZS1jcmVkZW50aWFscycpLmRpc2FibGVkID0gbG9ja2VkO1xuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjb25maWd1cmUtY3JlZGVudGlhbHMnKS5kaXNhYmxlZCA9IGxvY2tlZDtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjY2xvc2UtY3JlZGVudGlhbHMnKS5kaXNhYmxlZCA9IGxvY2tlZDtcbiAgICAgICAgaWYgKCFsb2NrZWQpIHtcbiAgICAgICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI3ZlcmlmeS10b2tlbicpLmRpc2FibGVkID0gIXRoaXMuaGFzVG9rZW47XG4gICAgICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjbGVhci10b2tlbicpLmRpc2FibGVkID0gIXRoaXMuaGFzVG9rZW47XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1jb250ZXh0JykuaGlkZGVuID0gIWhhc0RvY3VtZW50IHx8IHRoaXMuc3RlcCA9PT0gMTtcbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1maWxlLW5hbWUnKS50ZXh0Q29udGVudCA9IGNvbnRleHQuZG9jdW1lbnRcbiAgICAgICAgICAgID8gYCR7Y29udGV4dC5kb2N1bWVudC5maWxlTmFtZX0gLyAke3RoaXMucHJlZmFiVGFyZ2V0KCkgPyAnRnJhbWUnIDogJ+aWh+S7tid9IC8gJHt0aGlzLm5vZGVzKCkubGVuZ3RofSDkuKroioLngrlgXG4gICAgICAgICAgICA6ICflhYjor7vlj5borr7orqHvvIzlho3pgJDmraXphY3nva4nO1xuICAgICAgICB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNjaGFuZ2Utc291cmNlJykuZGlzYWJsZWQgPSBsb2NrZWQ7XG4gICAgICAgIHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI3Jlb3Blbi1pbXBvcnQtcmV2aWV3JykuaGlkZGVuID0gIXRoaXMucmV2aWV3QXZhaWxhYmxlIHx8IHRoaXMuc3RlcCA9PT0gNDtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcmVvcGVuLWltcG9ydC1yZXZpZXcnKS5kaXNhYmxlZCA9IGxvY2tlZDtcbiAgICAgICAgdGhpcy5nZXQoJyN3b3JrZmxvdy1lcnJvcicpLmhpZGRlbiA9ICF0aGlzLmVycm9yO1xuICAgICAgICB0aGlzLmdldCgnI3dvcmtmbG93LWVycm9yLW1lc3NhZ2UnKS50ZXh0Q29udGVudCA9IHRoaXMuZXJyb3I7XG4gICAgICAgIHRoaXMuZ2V0KCcjc291cmNlLXN0YXR1cycpLnRleHRDb250ZW50ID0gdGhpcy5wZW5kaW5nID09PSAnZmV0Y2gnID8gJ+ato+WcqOivu+WPluiuvuiuoe+8jOivt+eojeWAmeKApidcbiAgICAgICAgICAgIDogdGhpcy5zb3VyY2VVbmNoYW5nZWQoKSA/ICflvZPliY3orr7orqHlt7Lor7vlj5bvvIzlj6/ku6Xnm7TmjqXnu6fnu63jgILkv67mlLnpk77mjqXlkI7ph43mlrDor7vlj5bvvIzmiJDlip/lkI7mm7/mjaLlvZPliY3orr7orqHjgIInXG4gICAgICAgICAgICAgICAgOiB0aGlzLmhhc1Rva2VuID8gJ+WHreaNruW3suS/neWtmOOAguivu+WPluaIkOWKn+WQjuiHquWKqOi/m+WFpeiKgueCuemFjee9ru+8jOayv+eUqOmhueebrueahOebruW9leS4juWtl+S9k+iuvue9ruOAgidcbiAgICAgICAgICAgICAgICAgICAgOiAn6aaW5qyh5L2/55So6K+35YWI6YWN572uIEZpZ21hIOWHreaNru+8jOS/neWtmOWQjuWGjeivu+WPluiuvuiuoeOAgic7XG4gICAgICAgIHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNldHVwLWNhcmQnKSEuaGlkZGVuID0gdGhpcy5oYXNUb2tlbjtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcmVmcmVzaC1kb2N1bWVudCcpLmhpZGRlbiA9ICFoYXNEb2N1bWVudDtcbiAgICAgICAgdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjcmVmcmVzaC1kb2N1bWVudCcpLmRpc2FibGVkID0gbG9ja2VkO1xuICAgICAgICBjb25zdCBmZXRjaCA9IHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI2ZldGNoLWRvY3VtZW50Jyk7XG4gICAgICAgIGZldGNoLmhpZGRlbiA9IHRoaXMuc3RlcCAhPT0gMTtcbiAgICAgICAgZmV0Y2guZGlzYWJsZWQgPSBsb2NrZWQ7XG4gICAgICAgIGZldGNoLnRleHRDb250ZW50ID0gdGhpcy5wZW5kaW5nID09PSAnZmV0Y2gnID8gJ+ato+WcqOivu+WPluKApicgOiAhdGhpcy5oYXNUb2tlbiA/ICfphY3nva7ov57mjqUg4oaSJyA6IHRoaXMuc291cmNlVW5jaGFuZ2VkKCkgPyAn6L+U5Zue6IqC54K56YWN572uIOKGkicgOiAn6K+75Y+W6K6+6K6h77yM5LiL5LiA5q2lIOKGkic7XG4gICAgICAgIGNvbnN0IG5leHQgPSB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyN3b3JrZmxvdy1uZXh0Jyk7XG4gICAgICAgIG5leHQuaGlkZGVuID0gdGhpcy5zdGVwICE9PSAyO1xuICAgICAgICBuZXh0LmRpc2FibGVkID0gbG9ja2VkIHx8IHRoaXMuc2VsZWN0ZWRDb3VudCgpID09PSAwO1xuICAgICAgICBjb25zdCBiYWNrID0gdGhpcy5nZXQ8SFRNTEJ1dHRvbkVsZW1lbnQ+KCcjd29ya2Zsb3ctYmFjaycpO1xuICAgICAgICBiYWNrLmhpZGRlbiA9IHRoaXMuc3RlcCA9PT0gMSB8fCBsb2NrZWQ7XG4gICAgICAgIGJhY2suZGlzYWJsZWQgPSBsb2NrZWQ7XG4gICAgICAgIGJhY2sudGV4dENvbnRlbnQgPSB0aGlzLnN0ZXAgPT09IDQgPyAn6L+U5Zue6IqC54K56YWN572uJyA6ICfkuIrkuIDmraUnO1xuICAgICAgICBjb25zdCBpbXBvcnRpbmcgPSB0aGlzLmdldDxIVE1MQnV0dG9uRWxlbWVudD4oJyNpbXBvcnQtYnV0dG9uJyk7XG4gICAgICAgIGltcG9ydGluZy5oaWRkZW4gPSB0aGlzLnN0ZXAgIT09IDM7XG4gICAgICAgIGltcG9ydGluZy5kaXNhYmxlZCA9IGxvY2tlZCB8fCAhaGFzRG9jdW1lbnQgfHwgIWNvbnRleHQucnVudGltZUNvbXBhdGlibGUgfHwgdGhpcy5zZWxlY3RlZENvdW50KCkgPT09IDA7XG4gICAgICAgIGNvbnN0IGNhbmNlbCA9IHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI2NhbmNlbC1pbXBvcnQnKTtcbiAgICAgICAgY29uc3QgY2FuY2VsbGFibGUgPSBsb2NrZWQgJiYgdGhpcy5wZW5kaW5nICE9PSBudWxsO1xuICAgICAgICBjYW5jZWwuaGlkZGVuID0gIWNhbmNlbGxhYmxlO1xuICAgICAgICBjYW5jZWwuY2xhc3NMaXN0LnRvZ2dsZSgnaXMtaGlkZGVuJywgIWNhbmNlbGxhYmxlKTtcbiAgICAgICAgY2FuY2VsLmRpc2FibGVkID0gdGhpcy5jYW5jZWxsaW5nO1xuICAgICAgICBjYW5jZWwudGV4dENvbnRlbnQgPSB0aGlzLmNhbmNlbGxpbmcgPyAn5q2j5Zyo5Y+W5raI4oCmJyA6IHRoaXMucGVuZGluZyA9PT0gJ2ZldGNoJyA/ICflj5bmtojor7vlj5YnIDogJ+WPlua2iOWvvOWFpSc7XG4gICAgICAgIGNvbnN0IHJldmlldyA9IHRoaXMuZ2V0PEhUTUxCdXR0b25FbGVtZW50PignI29wZW4taW1wb3J0LXJldmlldycpO1xuICAgICAgICByZXZpZXcuaGlkZGVuID0gdGhpcy5zdGVwICE9PSA0O1xuICAgICAgICByZXZpZXcuZGlzYWJsZWQgPSBsb2NrZWQ7XG4gICAgICAgIHJldmlldy50ZXh0Q29udGVudCA9ICfmn6XnnIvlr7zlhaXmo4Dmn6Ug4oaSJztcbiAgICAgICAgdGhpcy5nZXQoJyNwcm9ncmVzcy1yZWdpb24nKS5oaWRkZW4gPSB0aGlzLnN0ZXAgIT09IDMgfHwgKHRoaXMucGVuZGluZyAhPT0gJ2ltcG9ydCcgJiYgIXRoaXMuZXJyb3IgJiYgIXRoaXMuY2FuY2VsbGVkICYmICFjb250ZXh0LmJ1c3kpO1xuICAgICAgICBjb25zdCBwcmVmYWIgPSB0aGlzLnByZWZhYlRhcmdldCgpO1xuICAgICAgICB0aGlzLmdldCgnI2NvbmZpcm1hdGlvbi10YXJnZXQnKS50ZXh0Q29udGVudCA9IHByZWZhYiA/ICfliJvlu7rmiJbmm7TmlrDni6znq4vpooTliLbkvZMnIDogJ+WvvOWFpeW9k+WJjeWcuuaZryBDYW52YXMnO1xuICAgICAgICBjb25zdCBmb2xkZXIgPSB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PignI3ByZWZhYi1mb2xkZXInKS52YWx1ZS50cmltKCk7XG4gICAgICAgIHRoaXMuZ2V0KCcjY29uZmlybWF0aW9uLXBhdGgnKS50ZXh0Q29udGVudCA9IHByZWZhYiA/IGBhc3NldHMvJHtmb2xkZXJ9LyDCtyDmjIkgRnJhbWUg6IqC54K55ZCN5L+d5a2YIC5wcmVmYWJgIDogJ+W9k+WJjeWcuuaZr+eahCBDYW52YXMg5qC56IqC54K55LiLJztcbiAgICAgICAgZm9yIChjb25zdCBpZCBvZiBbJyN1cGRhdGUtZXhpc3RpbmcnLCAnI2F1dG8tc2F2ZSddKSB7XG4gICAgICAgICAgICBjb25zdCBpbnB1dCA9IHRoaXMuZ2V0PEhUTUxJbnB1dEVsZW1lbnQ+KGlkKTtcbiAgICAgICAgICAgIGlucHV0LmRpc2FibGVkID0gbG9ja2VkIHx8IHByZWZhYjtcbiAgICAgICAgICAgIGlucHV0LmNsb3Nlc3QoJ2xhYmVsJyk/LmNsYXNzTGlzdC50b2dnbGUoJ2lzLWluYXBwbGljYWJsZScsIHByZWZhYik7XG4gICAgICAgICAgICBpbnB1dC50aXRsZSA9IHByZWZhYiA/ICfku4XlnLrmma/lr7zlhaXnlJ/mlYjvvJtGcmFtZSDpk77mjqXoh6rliqjlkIzmraXlubbkv53lrZjpooTliLbkvZMnIDogJyc7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY29uZmlybWF0aW9uID0gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3IoJyNjb25maXJtYXRpb24tc3VtbWFyeScpO1xuICAgICAgICBpZiAoY29uZmlybWF0aW9uKSBjb25maXJtYXRpb24udGV4dENvbnRlbnQgPSBgJHt0aGlzLnNlbGVjdGVkQ291bnQoKX0g5Liq6IqC54K5IMK3ICR7dGhpcy5nZXQ8SFRNTElucHV0RWxlbWVudD4oJyNzY2FsZScpLnZhbHVlfcOXIMK3IOmhueebruebruW9leS4juWtl+S9k+iuvue9ruW3suS/neeVmWA7XG4gICAgICAgIGNvbnN0IGFkdmFuY2VkID0gdGhpcy5ob3N0LnF1ZXJ5U2VsZWN0b3IoJyNhZHZhbmNlZC1zdW1tYXJ5Jyk7XG4gICAgICAgIGlmIChhZHZhbmNlZCkge1xuICAgICAgICAgICAgY29uc3QgZm9sZGVycyA9IFswLCAxLCAyXS5maWx0ZXIoKGluZGV4KSA9PiB0aGlzLmdldDxIVE1MSW5wdXRFbGVtZW50PihgI2xvY2FsLXJlc291cmNlLWZvbGRlci0ke2luZGV4fWApLnZhbHVlLnRyaW0oKSkubGVuZ3RoO1xuICAgICAgICAgICAgY29uc3QgZm9udHMgPSBBcnJheS5mcm9tKHRoaXMuaG9zdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PignW2RhdGEtZm9udC1mYW1pbHldJykpLmZpbHRlcigoc2VsZWN0KSA9PiBzZWxlY3QudmFsdWUpLmxlbmd0aDtcbiAgICAgICAgICAgIGFkdmFuY2VkLnRleHRDb250ZW50ID0gYOacrOWcsOebruW9lSAke2ZvbGRlcnN9IOmhuSDCtyDlrZfkvZPmmKDlsIQgJHtmb250c30g6aG5IMK3IOWPr+aMiemcgOWxleW8gGA7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5nZXQoJyNhY3Rpb24tbm90ZScpLnRleHRDb250ZW50ID0gIWNvbnRleHQucnVudGltZUNvbXBhdGlibGUgPyAn5Li76L+b56iL5LiO6Z2i5p2/54mI5pys5LiN5LiA6Ie077yM6K+35L+d5a2Y6aG555uu5bm25a6M5pW06YeN5ZCvIENvY29zIENyZWF0b3LjgIInXG4gICAgICAgICAgICA6IHRoaXMuc3RlcCA9PT0gMSA/ICfmiJDlip/or7vlj5blkI7ov5vlhaXnrKwgMiDmraXvvIzlt7LmnInpobnnm67orr7nva7kvJrnu6fnu63kv53nlZnjgIInXG4gICAgICAgICAgICAgICAgOiB0aGlzLnN0ZXAgPT09IDIgPyAn5Y+v5Lul5rK/55So5b2T5YmN562W55Wl77yb5LiL5LiA5q2l5qC45a+56L6T5Ye65L2N572u44CCJ1xuICAgICAgICAgICAgICAgICAgICA6IHRoaXMuc3RlcCA9PT0gMyA/IHRoaXMuY2FuY2VsbGluZyA/ICfnrYnlvoXlkI7lj7Dku7vliqHnu5PmnZ/lkI7vvIzlj6/ku6Xlho3mrKHosIPmlbTorr7nva7jgIInXG4gICAgICAgICAgICAgICAgICAgICAgICA6IHByZWZhYiA/ICfpooTliLbkvZPoh6rliqjlhpnlhaXmiYDpgInnm67lvZXlubbmiZPlvIDvvJvlkIzlkI3otYTmupDmjInnjrDmnInop4TliJnlpI3nlKjjgIInIDogJ+WvvOWFpeWIsOW9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K55LiL44CCJ1xuICAgICAgICAgICAgICAgICAgICAgICAgOiAn57uT5p6c5qOA5p+l5LiN5Lya6YeN5paw5omn6KGM5a+85YWl44CCJztcbiAgICAgICAgY29uc3QgZm9vdG5vdGUgPSB0aGlzLmhvc3QucXVlcnlTZWxlY3RvcignI3dvcmtmbG93LWZvb3Rub3RlJyk7XG4gICAgICAgIGlmIChmb290bm90ZSkge1xuICAgICAgICAgICAgZm9vdG5vdGUudGV4dENvbnRlbnQgPSB0aGlzLmNhbmNlbGxlZCA/ICfmk43kvZzlt7Llj5bmtojvvIzphY3nva7lt7Lkv53nlZnjgIInIDogJyc7XG4gICAgICAgICAgICAoZm9vdG5vdGUgYXMgSFRNTEVsZW1lbnQpLmhpZGRlbiA9ICF0aGlzLmNhbmNlbGxlZDtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGhpcy5zdGVwID09PSAxKSB0aGlzLmdldCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSB0aGlzLnNvdXJjZVVuY2hhbmdlZCgpID8gJ+W9k+WJjeiuvuiuoeW3suivu+WPlicgOiAn57KY6LS06ZO+5o6l77yM5byA5aeL6K+75Y+W6K6+6K6hJztcbiAgICAgICAgZWxzZSBpZiAodGhpcy5zdGVwID09PSA0KSB0aGlzLmdldCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSAn5a+85YWl5a6M5oiQ77yM5Y+v5oyJ6ZyA5qOA5p+l57uT5p6cJztcbiAgICAgICAgZWxzZSB0aGlzLmdldCgnI3NlbGVjdGlvbi1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBgJHt0aGlzLnNlbGVjdGVkQ291bnQoKX0gLyAke3RoaXMubm9kZXMoKS5sZW5ndGh9IOS4quiKgueCueWwhuWPguS4juWvvOWFpWA7XG4gICAgICAgIGlmICh0aGlzLnJlc3VsdCkgdGhpcy5yZW5kZXJSZXN1bHQodGhpcy5yZXN1bHQpO1xuICAgIH1cblxuICAgIHByaXZhdGUgcmVuZGVyUmVzdWx0KHJlc3VsdDogV29ya2Zsb3dSZXN1bHQpOiB2b2lkIHtcbiAgICAgICAgY29uc3QgcmV2aWV3ID0gcmVzdWx0LnJldmlldztcbiAgICAgICAgY29uc3QgY3JlYXRlZCA9IHJlc3VsdC5jcmVhdGVkID8/IHJldmlldz8uY2hhbmdlcy5maWx0ZXIoKG5vZGUpID0+IG5vZGUuc3RhdHVzID09PSAnYWRkZWQnKS5sZW5ndGg7XG4gICAgICAgIGNvbnN0IHVwZGF0ZWQgPSByZXN1bHQudXBkYXRlZCA/PyByZXZpZXc/LmNoYW5nZXMuZmlsdGVyKChub2RlKSA9PiBub2RlLnN0YXR1cyA9PT0gJ2NoYW5nZWQnKS5sZW5ndGg7XG4gICAgICAgIGNvbnN0IHdhcm5pbmdzID0gcmVzdWx0Lndhcm5pbmdzPy5sZW5ndGggPz8gcmV2aWV3Py53YXJuaW5ncy5sZW5ndGggPz8gMDtcbiAgICAgICAgdGhpcy5nZXQoJyNyZXN1bHQtdGl0bGUnKS50ZXh0Q29udGVudCA9ICflr7zlhaXlrozmiJDvvIzmo4Dmn6XkuIDkuIvnu5PmnpwnO1xuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC1zdW1tYXJ5JykudGV4dENvbnRlbnQgPSBgJHtyZXZpZXc/LmZpbGVOYW1lID8/IHRoaXMuY29udGV4dCgpLmRvY3VtZW50Py5maWxlTmFtZSA/PyAn6K6+6K6hJ30g5bey5a6M5oiQ5a+85YWlJHt3YXJuaW5ncyA/IGDvvIzmnIkgJHt3YXJuaW5nc30g5p2h5a+85YWlL+aUtuWwvuaPkOekuuOAgmAgOiAn44CCJ31gO1xuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC10YXJnZXQnKS50ZXh0Q29udGVudCA9IHJlc3VsdC5wcmVmYWJVcmwgPz8gcmV2aWV3Py50YXJnZXRVcmwgPz8gJ+W9k+WJjeWcuuaZryBDYW52YXMg5qC56IqC54K5JztcbiAgICAgICAgdGhpcy5nZXQoJyNyZXN1bHQtY3JlYXRlZCcpLnRleHRDb250ZW50ID0gY3JlYXRlZCA9PT0gdW5kZWZpbmVkID8gJ+KAlCcgOiBTdHJpbmcoY3JlYXRlZCk7XG4gICAgICAgIHRoaXMuZ2V0KCcjcmVzdWx0LXVwZGF0ZWQnKS50ZXh0Q29udGVudCA9IHVwZGF0ZWQgPT09IHVuZGVmaW5lZCA/ICfigJQnIDogU3RyaW5nKHVwZGF0ZWQpO1xuICAgICAgICB0aGlzLmdldCgnI3Jlc3VsdC13YXJuaW5ncycpLnRleHRDb250ZW50ID0gU3RyaW5nKHdhcm5pbmdzKTtcbiAgICB9XG59XG4iXX0=