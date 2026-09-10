// Temporary console diagnostics: no retries or import policy changes.
let sequence = 0;

function safeText(value: string): string {
    return value
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[远程地址已隐藏]')
        .replace(/(?:figd_|figu_)[A-Za-z0-9_-]+/g, '[凭据已隐藏]')
        .replace(/((?:authorization|x-figma-token)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]');
}

export function diagnosticStart(label: string, details: unknown = undefined) {
    const id = ++sequence;
    const started = Date.now();
    const event = (state: string, detail?: unknown) => {
        // A logger must never prevent the original operation from completing.
        try {
            const suffix = detail === undefined ? '' : ` ${safeText(JSON.stringify(detail))}`;
            const status = (detail as { status?: number } | null)?.status;
            const level = /^失败/.test(state)
                ? 'error'
                : /超时|重试|中断|提前关闭|尝试失败|请求错误/.test(state)
                    || (typeof status === 'number' && status >= 400)
                    ? 'warn'
                    : 'log';
            console[level](`[Figma Importer 诊断] #${id} ${new Date().toISOString()} ${safeText(label)} ${state} +${Date.now() - started}ms${suffix}`);
        } catch { /* Preserve the original operation if the console is unavailable. */ }
    };
    event('开始', details);
    return {
        event,
        done: (detail?: unknown) => event('完成', detail),
        fail: (error: unknown) => {
            const value = error as { name?: string; code?: string; message?: string } | null;
            event('失败', { name: value?.name, code: value?.code, message: value?.message ?? String(error) });
        },
    };
}

export async function diagnosticTask<T>(label: string, details: unknown, task: () => Promise<T>): Promise<T> {
    const trace = diagnosticStart(label, details);
    try {
        const result = await task();
        trace.done();
        return result;
    } catch (error) {
        trace.fail(error);
        throw error;
    }
}
