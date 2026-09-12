import type { ImportReview, ReviewScene } from '../import-review-model';
import type { DocumentSession } from '../types';
import { ImportReviewRecorder, ImportReviewService } from './import-review';

/** A completed import must retain a viewable report even if live validation fails. */
export async function finalizeImportReview(
    service: ImportReviewService, recorder: ImportReviewRecorder, document: DocumentSession,
    before: ReviewScene | undefined, after: ReviewScene | undefined, targetUrl: string | undefined,
    warnings: string[], refresh: () => Promise<ReviewScene>,
    wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 150)),
): Promise<ImportReview> {
    const empty: ReviewScene = { rootUuid: '', targetUuid: '', mode: 'unknown', nodes: [] };
    let readOnlyReason: string | undefined;
    if (!before || !after) readOnlyReason = '导入前后节点快照不完整。';
    else {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { after = await refresh(); readOnlyReason = undefined; break; }
            catch (error) {
                readOnlyReason = error instanceof Error ? error.message : String(error);
                if (attempt < 2) await wait();
            }
        }
    }
    if (!readOnlyReason && after?.saveAdjustments?.count) {
        const { count, details } = after.saveAdjustments;
        warnings.push(`保存收尾已同步 ${count} 项位置/尺寸等几何变化，节点结构、组件及资源引用校验通过；报告采用保存后的数值。${details.join('；')}${count > details.length ? '；其余略' : ''}`);
    }
    if (!readOnlyReason) {
        try { return await service.complete(recorder, document, before!, after!, targetUrl, warnings); }
        catch (error) { readOnlyReason = `完整报告生成失败：${error instanceof Error ? error.message : String(error)}`; }
    }
    warnings.push(`导入已完成；结果仅供查看，已禁用资源清理。${readOnlyReason}`);
    return service.complete(recorder, document, before ?? empty, after ?? empty, targetUrl, warnings,
        `${readOnlyReason} 下方节点信息为导入时记录的快照，不保证与当前编辑目标一致。请在目标稳定后重新导入以启用修改。`);
}
