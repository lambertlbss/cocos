import {
    SYNC_MARKER_SCRIPT_SOURCE,
    SYNC_MARKER_SCRIPT_URL,
    isSyncMarkerScript,
} from './sync-marker';

/**
 * 标记组件脚本落在项目 `assets` 里的固定位置。
 * 主进程负责创建/校验，Scene 只按类名挂载；脚本缺失时导入降级为"无标记"而不是失败。
 */
export type SyncMarkerScriptPlan =
    | { action: 'create'; content: string }
    | { action: 'rewrite'; content: string; reason: string }
    | { action: 'keep' }
    | { action: 'reject'; reason: string };

export function planSyncMarkerScript(existing: string | null | undefined): SyncMarkerScriptPlan {
    const content = SYNC_MARKER_SCRIPT_SOURCE;
    if (existing === null || existing === undefined) {
        return { action: 'create', content };
    }
    // 行尾差异（Windows 检出）不算版本变化，否则会反复改写项目文件。
    const normalized = (value: string) => value.replace(/\r\n/g, '\n').trim();
    if (normalized(existing) === normalized(content)) {
        return { action: 'keep' };
    }
    if (isSyncMarkerScript(existing)) {
        // 脚本是本插件生成的，但内容与当前版本不一致（旧版本或被手工改过）。
        // 重建比保留更安全：字段缺失会让指纹检测失效。
        return {
            action: 'rewrite',
            content,
            reason: '同步标记组件脚本与当前插件版本不一致，已按模板重建。',
        };
    }
    return {
        action: 'reject',
        reason: `组件同步标记脚本位置已被其他脚本占用：${SYNC_MARKER_SCRIPT_URL}。`
            + '请先移动或重命名该文件，再重新导入。',
    };
}
