import { parseFigmaSource } from '../../figma/url';
import type { ImportReview } from '../../import-review-model';
import type { ImportAction, ImportSettings, ProgressEvent, TreeNodeDto } from '../../types';

export type WorkflowStep = 1 | 2 | 3 | 4;
type Operation = 'fetch' | 'import';
interface WorkflowContext {
    document: { fileName: string; sourceUrl: string; tree: TreeNodeDto[] } | null;
    actions: Map<string, ImportAction>;
    busy: boolean;
    runtimeCompatible: boolean;
    settings: ImportSettings;
    batch?: BatchWorkflowContext;
}
export interface BatchWorkflowContext {
    count: number;
    total: number;
    nodes: number;
    selectedNodes: number;
    conflicts: boolean;
    result?: { success: number; failed: number; pending: number; stopped: boolean };
}
export interface WorkflowResult {
    created?: number;
    updated?: number;
    prefabUrl?: string;
    warnings?: string[];
    review?: ImportReview;
}

/** Presentation state only. Import requests and project settings remain owned by the panel. */
export class PanelWorkflow {
    step: WorkflowStep = 1;
    pending: Operation | null = null;
    cancelled = false;
    private unlocked = 1;
    private hasToken = false;
    private cancelling = false;
    private error = '';
    private result: WorkflowResult | null = null;
    private reviewAvailable = false;
    private operationControls: Array<{ control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement; disabled: boolean }> = [];

    constructor(
        private readonly host: HTMLElement,
        private readonly context: () => WorkflowContext,
        private readonly openReview: (tab: 'assets' | 'nodes' | 'source') => void,
    ) {
        host.querySelectorAll<HTMLButtonElement>('[data-workflow-step]').forEach((button) => {
            button.addEventListener('click', () => this.navigate(Number(button.dataset.workflowStep) as WorkflowStep));
        });
        this.get('#workflow-back').addEventListener('click', () => this.navigate(this.step === 4 ? 2 : (this.step - 1) as WorkflowStep));
        this.get('#change-source').addEventListener('click', () => this.navigate(1));
        this.get('#reopen-import-review').addEventListener('click', () => { if (!this.locked) this.openReview('assets'); });
        this.get('#workflow-next').addEventListener('click', () => {
            if (this.locked || !this.context().document || this.selectedCount() === 0) return;
            this.unlocked = Math.max(3, this.unlocked);
            this.navigate(3);
        });
        this.get('#manage-credentials').addEventListener('click', () => this.openCredentials());
        this.get('#configure-credentials').addEventListener('click', () => this.openCredentials());
        this.get('#close-credentials').addEventListener('click', () => this.closeCredentials());
        this.get<HTMLDialogElement>('#credential-dialog').addEventListener('cancel', (event) => {
            if (this.locked) event.preventDefault();
        });
        this.get('#dismiss-workflow-error').addEventListener('click', () => { this.error = ''; this.render(); });
        this.get<HTMLInputElement>('#source-url').addEventListener('input', () => this.render());
        host.querySelectorAll<HTMLButtonElement>('[data-review-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                if (!this.locked) this.openReview(button.dataset.reviewTab as 'assets' | 'nodes' | 'source');
            });
        });
        host.addEventListener('change', () => this.render());
        this.render();
    }

    private get<T extends HTMLElement = HTMLElement>(selector: string): T {
        return this.host.querySelector<T>(selector)!;
    }

    get locked(): boolean { return this.context().busy || this.pending !== null; }
    get credentialsReady(): boolean { return this.hasToken; }

    private nodes(): TreeNodeDto[] {
        const flatten = (items: TreeNodeDto[]): TreeNodeDto[] => items.flatMap((node) => [node, ...flatten(node.children)]);
        return flatten(this.context().document?.tree ?? []);
    }

    private selectedCount(): number {
        if (this.context().batch) return this.context().batch!.selectedNodes;
        return this.nodes().filter((node) => this.context().actions.get(node.id) !== 'ignore').length;
    }

    private prefabTarget(): boolean {
        const document = this.context().document;
        if (!document || document.tree.length !== 1) return false;
        try { return Boolean(parseFigmaSource(document.sourceUrl).nodeId); } catch { return false; }
    }

    sourceUnchanged(): boolean {
        if (this.context().batch) return this.context().batch!.count > 0;
        return Boolean(this.context().document)
            && this.get<HTMLInputElement>('#source-url').value.trim() === this.context().document!.sourceUrl.trim();
    }

    setConnection(hasToken: boolean): void {
        this.hasToken = hasToken;
        this.render();
    }

    openCredentials(): void {
        if (this.locked) return;
        const dialog = this.get<HTMLDialogElement>('#credential-dialog');
        if (!dialog.open) dialog.showModal();
        this.get<HTMLInputElement>('#token-input').focus();
    }

    closeCredentials(): void {
        if (this.locked) return;
        this.get<HTMLDialogElement>('#credential-dialog').close();
    }

    navigate(step: WorkflowStep): void {
        if (this.locked || step < 1 || step > this.unlocked || (step > 1 && !this.sourceUnchanged())) return;
        this.step = step;
        this.render();
        this.host.querySelector<HTMLElement>(`[data-workflow-panel="${step}"] h2`)?.focus();
    }

    documentReady(): void {
        this.unlocked = 2;
        this.result = null;
        this.error = '';
        this.step = 2;
        this.render();
    }

    batchReady(): void {
        this.unlocked = 2;
        this.result = null;
        this.error = '';
        this.step = 1;
        this.render();
    }

    begin(operation: Operation): void {
        this.pending = operation;
        this.cancelled = false;
        this.cancelling = false;
        this.error = '';
        if (operation === 'import') this.step = 3;
        this.render();
    }

    end(): void {
        this.pending = null;
        this.cancelling = false;
        this.render();
    }

    fail(message: string): void {
        this.error = message;
        this.render();
    }

    clearError(): void { this.error = ''; this.render(); }

    rememberReview(): void { this.reviewAvailable = true; this.render(); }

    cancelRequested(): void {
        this.cancelling = true;
        this.render();
    }

    cancelRequestFailed(message: string): void {
        this.cancelling = false;
        this.fail(message);
    }

    progress(event: ProgressEvent): void {
        if (event.phase === 'assets' || event.phase === 'scene') {
            this.step = 3;
            this.unlocked = Math.max(this.unlocked, 3);
        }
        if (event.phase === 'cancelled' || (event.phase === 'error' && this.pending === 'fetch' && this.cancelling)) {
            this.cancelled = true;
            this.error = '';
        } else if (event.phase === 'error') {
            this.error = event.message;
        }
        this.render();
    }

    complete(result: WorkflowResult): void {
        this.result = result;
        if (result.review) this.reviewAvailable = true;
        this.error = '';
        this.cancelled = false;
        this.step = 4;
        this.unlocked = 4;
        this.render();
    }

    private lockEditing(locked: boolean): void {
        if (locked && this.operationControls.length === 0) {
            const selectors = '.workflow-panel input, .workflow-panel select, .workflow-panel button, [data-preset], #verify-token, #clear-token';
            this.operationControls = Array.from(this.host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(selectors))
                .map((control) => ({ control, disabled: control.disabled }));
            this.operationControls.forEach(({ control }) => { control.disabled = true; });
        } else if (!locked && this.operationControls.length) {
            this.operationControls.forEach(({ control, disabled }) => { control.disabled = disabled; });
            this.operationControls = [];
        }
    }

    render(): void {
        const context = this.context();
        const locked = this.locked;
        const hasDocument = Boolean(context.document);
        const batch = context.batch;
        this.host.dataset.workflowStep = String(this.step);
        this.host.dataset.workflowBusy = String(locked);
        this.host.dataset.workflowOperation = this.pending ?? '';
        this.host.dataset.workflowCancelling = String(this.cancelling);
        this.host.querySelectorAll<HTMLElement>('[data-workflow-panel]').forEach((panel) => {
            panel.hidden = Number(panel.dataset.workflowPanel) !== this.step;
        });
        this.host.querySelectorAll<HTMLButtonElement>('[data-workflow-step]').forEach((button) => {
            const step = Number(button.dataset.workflowStep);
            const current = step === this.step;
            const complete = step < this.unlocked && !current;
            button.disabled = locked || step > this.unlocked || (step > 1 && !this.sourceUnchanged());
            button.classList.toggle('is-current', current);
            button.classList.toggle('is-complete', complete);
            if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
            button.querySelector('.step-number')!.textContent = complete ? '✓' : String(step);
            button.querySelector('.step-caption')!.textContent = current
                ? locked && this.pending === 'import' ? '正在执行' : '当前步骤'
                : complete ? locked ? '已完成' : '已完成 · 可返回' : '待完成';
        });
        this.lockEditing(locked);
        this.get<HTMLButtonElement>('#manage-credentials').disabled = locked;
        this.get<HTMLButtonElement>('#configure-credentials').disabled = locked;
        this.get<HTMLButtonElement>('#close-credentials').disabled = locked;
        if (!locked) {
            this.get<HTMLButtonElement>('#verify-token').disabled = !this.hasToken;
            this.get<HTMLButtonElement>('#clear-token').disabled = !this.hasToken;
        }
        this.get('#workflow-context').hidden = !hasDocument || this.step === 1;
        this.get('#workflow-file-name').textContent = context.document
            ? batch ? `本批 ${batch.count} 个界面 / 独立 Prefab / 修改自动保留`
                : `${context.document.fileName} / ${this.prefabTarget() ? 'Frame' : '文件'} / ${this.nodes().length} 个节点`
            : '先读取设计，再逐步配置';
        this.get('#change-source').textContent = batch ? '界面列表' : '更换设计';
        this.get<HTMLButtonElement>('#change-source').disabled = locked;
        this.get<HTMLButtonElement>('#reopen-import-review').hidden = !this.reviewAvailable || this.step === 4;
        this.get<HTMLButtonElement>('#reopen-import-review').disabled = locked;
        this.get('#workflow-error').hidden = !this.error;
        this.get('#workflow-error-message').textContent = this.error;
        this.get('#source-status').textContent = this.pending === 'fetch' ? '正在读取设计，请稍候…'
            : batch ? `已添加 ${batch.total} 个界面，已选 ${batch.count} 个。继续粘贴链接可追加，同一 Frame 只保留一份。`
            : this.sourceUnchanged() ? '当前设计已读取，可以直接继续。修改链接后重新读取，成功后替换当前设计。'
                : this.hasToken ? '凭据已保存。读取成功后自动进入节点配置，沿用项目的目录与字体设置。'
                    : '首次使用请先配置 Figma 凭据，保存后再读取设计。';
        this.host.querySelector<HTMLElement>('.setup-card')!.hidden = this.hasToken;
        this.get<HTMLButtonElement>('#refresh-document').hidden = !hasDocument;
        this.get<HTMLButtonElement>('#refresh-document').disabled = locked;
        const fetch = this.get<HTMLButtonElement>('#fetch-document');
        fetch.hidden = this.step !== 1;
        fetch.disabled = locked;
        fetch.textContent = this.pending === 'fetch' ? '正在读取…' : !this.hasToken ? '配置连接 →'
            : batch ? '调整所选界面 →' : this.sourceUnchanged() ? '返回节点配置 →' : '读取设计，下一步 →';
        if (batch && !batch.count) fetch.disabled = true;
        const next = this.get<HTMLButtonElement>('#workflow-next');
        next.hidden = this.step !== 2;
        next.disabled = locked || this.selectedCount() === 0;
        const back = this.get<HTMLButtonElement>('#workflow-back');
        back.hidden = this.step === 1 || locked;
        back.disabled = locked;
        back.textContent = this.step === 4 ? '返回节点配置' : '上一步';
        const importing = this.get<HTMLButtonElement>('#import-button');
        importing.hidden = this.step !== 3;
        importing.disabled = locked || !hasDocument || !context.runtimeCompatible || this.selectedCount() === 0 || Boolean(batch?.conflicts);
        const cancel = this.get<HTMLButtonElement>('#cancel-import');
        const cancellable = locked && this.pending !== null;
        cancel.hidden = !cancellable;
        cancel.classList.toggle('is-hidden', !cancellable);
        cancel.disabled = this.cancelling;
        cancel.textContent = this.cancelling ? batch && this.pending === 'import' ? '将在当前项完成后停止' : '正在取消…'
            : this.pending === 'fetch' ? '取消读取' : batch ? '停止后续任务' : '取消导入';
        const review = this.get<HTMLButtonElement>('#open-import-review');
        review.hidden = this.step !== 4 || Boolean(batch);
        review.disabled = locked;
        review.textContent = '查看导入检查 →';
        this.get('#progress-region').hidden = this.step !== 3 || (this.pending !== 'import' && !this.error && !this.cancelled && !context.busy);
        const prefab = Boolean(batch) || this.prefabTarget();
        this.get('#confirmation-target').textContent = batch ? `导入 ${batch.count} 个独立 Prefab` : prefab ? '创建或更新独立预制体' : '导入当前场景 Canvas';
        const folder = this.get<HTMLInputElement>('#prefab-folder').value.trim();
        this.get('#confirmation-path').textContent = prefab ? `assets/${folder}/ · 每个 Frame 分别保存 .prefab` : '当前场景的 Canvas 根节点下';
        for (const id of ['#update-existing', '#auto-save']) {
            const input = this.get<HTMLInputElement>(id);
            input.disabled = locked || prefab;
            input.closest('label')?.classList.toggle('is-inapplicable', prefab);
            input.title = prefab ? '仅场景导入生效；Frame 链接自动同步并保存预制体' : '';
        }
        const confirmation = this.host.querySelector('#confirmation-summary');
        if (confirmation) confirmation.textContent = `${batch ? `${batch.count} 个界面 · ` : ''}${this.selectedCount()} 个节点 · ${this.get<HTMLInputElement>('#scale').value}× · 项目目录与字体设置已保留`;
        const advanced = this.host.querySelector('#advanced-summary');
        if (advanced) {
            const folders = [0, 1, 2].filter((index) => this.get<HTMLInputElement>(`#local-resource-folder-${index}`).value.trim()).length;
            const fonts = Array.from(this.host.querySelectorAll<HTMLSelectElement>('[data-font-family]')).filter((select) => select.value).length;
            advanced.textContent = `本地目录 ${folders} 项 · 字体映射 ${fonts} 项 · 可按需展开`;
        }
        this.get('#action-note').textContent = !context.runtimeCompatible ? '主进程与面板版本不一致，请保存项目并完整重启 Cocos Creator。'
            : this.step === 1 ? '成功读取后进入第 2 步，已有项目设置会继续保留。'
                : this.step === 2 ? batch ? '点击上方标签切换界面，当前界面的修改会自动保留。' : '可以沿用当前策略；下一步核对输出位置。'
                    : this.step === 3 ? this.cancelling ? '等待后台任务结束后，可以再次调整设置。'
                        : batch?.conflicts ? '存在重复的 Prefab 名称，请在导入清单中改名。'
                        : prefab ? '预制体自动写入所选目录并打开；同名资源按现有规则复用。' : '导入到当前场景 Canvas 根节点下。'
                        : '结果检查不会重新执行导入。';
        const footnote = this.host.querySelector('#workflow-footnote');
        if (footnote) {
            footnote.textContent = this.cancelled ? '操作已取消，配置已保留。' : '';
            (footnote as HTMLElement).hidden = !this.cancelled;
        }
        if (this.step === 1) this.get('#selection-summary').textContent = batch ? `已选 ${batch.count} / ${batch.total} 个界面` : this.sourceUnchanged() ? '当前设计已读取' : '粘贴链接，开始读取设计';
        else if (this.step === 4) this.get('#selection-summary').textContent = '导入完成，可按需检查结果';
        else this.get('#selection-summary').textContent = batch ? `${batch.count} 个界面 · ${this.selectedCount()} / ${batch.nodes} 个节点将参与导入`
            : `${this.selectedCount()} / ${this.nodes().length} 个节点将参与导入`;
        if (this.result) this.renderResult(this.result);
        if (batch?.result && this.step === 4) {
            const result = batch.result;
            this.get('#result-title').textContent = result.stopped ? '本批导入已停止' : result.failed ? '本批导入结束，部分失败' : '本批导入完成';
            this.get('#result-summary').textContent = `成功 ${result.success} 项 · 失败 ${result.failed} 项 · 未完成 ${result.pending} 项。每个界面的检查报告可单独打开。`;
            this.get('#result-target').textContent = `assets/${folder}/`;
            this.get('#selection-summary').textContent = `成功 ${result.success} · 失败 ${result.failed} · 未完成 ${result.pending}`;
        }
    }

    private renderResult(result: WorkflowResult): void {
        const review = result.review;
        const created = result.created ?? review?.changes.filter((node) => node.status === 'added').length;
        const updated = result.updated ?? review?.changes.filter((node) => node.status === 'changed').length;
        const warnings = result.warnings?.length ?? review?.warnings.length ?? 0;
        this.get('#result-title').textContent = '导入完成，检查一下结果';
        this.get('#result-summary').textContent = `${review?.fileName ?? this.context().document?.fileName ?? '设计'} 已完成导入${warnings ? `，有 ${warnings} 条导入/收尾提示。` : '。'}`;
        this.get('#result-target').textContent = result.prefabUrl ?? review?.targetUrl ?? '当前场景 Canvas 根节点';
        this.get('#result-created').textContent = created === undefined ? '—' : String(created);
        this.get('#result-updated').textContent = updated === undefined ? '—' : String(updated);
        this.get('#result-warnings').textContent = String(warnings);
    }
}
