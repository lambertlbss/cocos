"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diagnosticStart = diagnosticStart;
exports.diagnosticTask = diagnosticTask;
// Temporary console diagnostics: no retries or import policy changes.
let sequence = 0;
function safeText(value) {
    return value
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[远程地址已隐藏]')
        .replace(/(?:figd_|figu_)[A-Za-z0-9_-]+/g, '[凭据已隐藏]')
        .replace(/((?:authorization|x-figma-token)\s*[:=]\s*)[^\r\n]+/gi, '$1[已隐藏]');
}
function diagnosticStart(label, details = undefined) {
    const id = ++sequence;
    const started = Date.now();
    const event = (state, detail) => {
        // A logger must never prevent the original operation from completing.
        try {
            const suffix = detail === undefined ? '' : ` ${safeText(JSON.stringify(detail))}`;
            const status = detail === null || detail === void 0 ? void 0 : detail.status;
            const level = /^失败/.test(state)
                ? 'error'
                : /超时|重试|中断|提前关闭|尝试失败|请求错误/.test(state)
                    || (typeof status === 'number' && status >= 400)
                    ? 'warn'
                    : 'log';
            console[level](`[Figma Importer 诊断] #${id} ${new Date().toISOString()} ${safeText(label)} ${state} +${Date.now() - started}ms${suffix}`);
        }
        catch { /* Preserve the original operation if the console is unavailable. */ }
    };
    event('开始', details);
    return {
        event,
        done: (detail) => event('完成', detail),
        fail: (error) => {
            var _a;
            const value = error;
            event('失败', { name: value === null || value === void 0 ? void 0 : value.name, code: value === null || value === void 0 ? void 0 : value.code, message: (_a = value === null || value === void 0 ? void 0 : value.message) !== null && _a !== void 0 ? _a : String(error) });
        },
    };
}
async function diagnosticTask(label, details, task) {
    const trace = diagnosticStart(label, details);
    try {
        const result = await task();
        trace.done();
        return result;
    }
    catch (error) {
        trace.fail(error);
        throw error;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGlhZ25vc3RpY3MuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvZGlhZ25vc3RpY3MudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFVQSwwQ0EwQkM7QUFFRCx3Q0FVQztBQWhERCxzRUFBc0U7QUFDdEUsSUFBSSxRQUFRLEdBQUcsQ0FBQyxDQUFDO0FBRWpCLFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDM0IsT0FBTyxLQUFLO1NBQ1AsT0FBTyxDQUFDLHlCQUF5QixFQUFFLFdBQVcsQ0FBQztTQUMvQyxPQUFPLENBQUMsZ0NBQWdDLEVBQUUsU0FBUyxDQUFDO1NBQ3BELE9BQU8sQ0FBQyx1REFBdUQsRUFBRSxTQUFTLENBQUMsQ0FBQztBQUNyRixDQUFDO0FBRUQsU0FBZ0IsZUFBZSxDQUFDLEtBQWEsRUFBRSxVQUFtQixTQUFTO0lBQ3ZFLE1BQU0sRUFBRSxHQUFHLEVBQUUsUUFBUSxDQUFDO0lBQ3RCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztJQUMzQixNQUFNLEtBQUssR0FBRyxDQUFDLEtBQWEsRUFBRSxNQUFnQixFQUFFLEVBQUU7UUFDOUMsc0VBQXNFO1FBQ3RFLElBQUksQ0FBQztZQUNELE1BQU0sTUFBTSxHQUFHLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxRQUFRLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDbEYsTUFBTSxNQUFNLEdBQUksTUFBcUMsYUFBckMsTUFBTSx1QkFBTixNQUFNLENBQWlDLE1BQU0sQ0FBQztZQUM5RCxNQUFNLEtBQUssR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQztnQkFDM0IsQ0FBQyxDQUFDLE9BQU87Z0JBQ1QsQ0FBQyxDQUFDLHlCQUF5QixDQUFDLElBQUksQ0FBQyxLQUFLLENBQUM7dUJBQ2hDLENBQUMsT0FBTyxNQUFNLEtBQUssUUFBUSxJQUFJLE1BQU0sSUFBSSxHQUFHLENBQUM7b0JBQ2hELENBQUMsQ0FBQyxNQUFNO29CQUNSLENBQUMsQ0FBQyxLQUFLLENBQUM7WUFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLHdCQUF3QixFQUFFLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxLQUFLLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxPQUFPLEtBQUssTUFBTSxFQUFFLENBQUMsQ0FBQztRQUM3SSxDQUFDO1FBQUMsTUFBTSxDQUFDLENBQUMsb0VBQW9FLENBQUMsQ0FBQztJQUNwRixDQUFDLENBQUM7SUFDRixLQUFLLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ3JCLE9BQU87UUFDSCxLQUFLO1FBQ0wsSUFBSSxFQUFFLENBQUMsTUFBZ0IsRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7UUFDL0MsSUFBSSxFQUFFLENBQUMsS0FBYyxFQUFFLEVBQUU7O1lBQ3JCLE1BQU0sS0FBSyxHQUFHLEtBQWtFLENBQUM7WUFDakYsS0FBSyxDQUFDLElBQUksRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFBLEtBQUssYUFBTCxLQUFLLHVCQUFMLEtBQUssQ0FBRSxPQUFPLG1DQUFJLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDcEcsQ0FBQztLQUNKLENBQUM7QUFDTixDQUFDO0FBRU0sS0FBSyxVQUFVLGNBQWMsQ0FBSSxLQUFhLEVBQUUsT0FBZ0IsRUFBRSxJQUFzQjtJQUMzRixNQUFNLEtBQUssR0FBRyxlQUFlLENBQUMsS0FBSyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQzlDLElBQUksQ0FBQztRQUNELE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxFQUFFLENBQUM7UUFDNUIsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ2IsT0FBTyxNQUFNLENBQUM7SUFDbEIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDYixLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2xCLE1BQU0sS0FBSyxDQUFDO0lBQ2hCLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gVGVtcG9yYXJ5IGNvbnNvbGUgZGlhZ25vc3RpY3M6IG5vIHJldHJpZXMgb3IgaW1wb3J0IHBvbGljeSBjaGFuZ2VzLlxyXG5sZXQgc2VxdWVuY2UgPSAwO1xyXG5cclxuZnVuY3Rpb24gc2FmZVRleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gdmFsdWVcclxuICAgICAgICAucmVwbGFjZSgvaHR0cHM/OlxcL1xcL1teXFxzXCInPD5dKy9naSwgJ1vov5znqIvlnLDlnYDlt7LpmpDol49dJylcclxuICAgICAgICAucmVwbGFjZSgvKD86ZmlnZF98ZmlndV8pW0EtWmEtejAtOV8tXSsvZywgJ1vlh63mja7lt7LpmpDol49dJylcclxuICAgICAgICAucmVwbGFjZSgvKCg/OmF1dGhvcml6YXRpb258eC1maWdtYS10b2tlbilcXHMqWzo9XVxccyopW15cXHJcXG5dKy9naSwgJyQxW+W3sumakOiXj10nKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGRpYWdub3N0aWNTdGFydChsYWJlbDogc3RyaW5nLCBkZXRhaWxzOiB1bmtub3duID0gdW5kZWZpbmVkKSB7XHJcbiAgICBjb25zdCBpZCA9ICsrc2VxdWVuY2U7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGNvbnN0IGV2ZW50ID0gKHN0YXRlOiBzdHJpbmcsIGRldGFpbD86IHVua25vd24pID0+IHtcclxuICAgICAgICAvLyBBIGxvZ2dlciBtdXN0IG5ldmVyIHByZXZlbnQgdGhlIG9yaWdpbmFsIG9wZXJhdGlvbiBmcm9tIGNvbXBsZXRpbmcuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc3VmZml4ID0gZGV0YWlsID09PSB1bmRlZmluZWQgPyAnJyA6IGAgJHtzYWZlVGV4dChKU09OLnN0cmluZ2lmeShkZXRhaWwpKX1gO1xyXG4gICAgICAgICAgICBjb25zdCBzdGF0dXMgPSAoZGV0YWlsIGFzIHsgc3RhdHVzPzogbnVtYmVyIH0gfCBudWxsKT8uc3RhdHVzO1xyXG4gICAgICAgICAgICBjb25zdCBsZXZlbCA9IC9e5aSx6LSlLy50ZXN0KHN0YXRlKVxyXG4gICAgICAgICAgICAgICAgPyAnZXJyb3InXHJcbiAgICAgICAgICAgICAgICA6IC/otoXml7Z86YeN6K+VfOS4reaWrXzmj5DliY3lhbPpl6185bCd6K+V5aSx6LSlfOivt+axgumUmeivry8udGVzdChzdGF0ZSlcclxuICAgICAgICAgICAgICAgICAgICB8fCAodHlwZW9mIHN0YXR1cyA9PT0gJ251bWJlcicgJiYgc3RhdHVzID49IDQwMClcclxuICAgICAgICAgICAgICAgICAgICA/ICd3YXJuJ1xyXG4gICAgICAgICAgICAgICAgICAgIDogJ2xvZyc7XHJcbiAgICAgICAgICAgIGNvbnNvbGVbbGV2ZWxdKGBbRmlnbWEgSW1wb3J0ZXIg6K+K5patXSAjJHtpZH0gJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9ICR7c2FmZVRleHQobGFiZWwpfSAke3N0YXRlfSArJHtEYXRlLm5vdygpIC0gc3RhcnRlZH1tcyR7c3VmZml4fWApO1xyXG4gICAgICAgIH0gY2F0Y2ggeyAvKiBQcmVzZXJ2ZSB0aGUgb3JpZ2luYWwgb3BlcmF0aW9uIGlmIHRoZSBjb25zb2xlIGlzIHVuYXZhaWxhYmxlLiAqLyB9XHJcbiAgICB9O1xyXG4gICAgZXZlbnQoJ+W8gOWniycsIGRldGFpbHMpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBldmVudCxcclxuICAgICAgICBkb25lOiAoZGV0YWlsPzogdW5rbm93bikgPT4gZXZlbnQoJ+WujOaIkCcsIGRldGFpbCksXHJcbiAgICAgICAgZmFpbDogKGVycm9yOiB1bmtub3duKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gZXJyb3IgYXMgeyBuYW1lPzogc3RyaW5nOyBjb2RlPzogc3RyaW5nOyBtZXNzYWdlPzogc3RyaW5nIH0gfCBudWxsO1xyXG4gICAgICAgICAgICBldmVudCgn5aSx6LSlJywgeyBuYW1lOiB2YWx1ZT8ubmFtZSwgY29kZTogdmFsdWU/LmNvZGUsIG1lc3NhZ2U6IHZhbHVlPy5tZXNzYWdlID8/IFN0cmluZyhlcnJvcikgfSk7XHJcbiAgICAgICAgfSxcclxuICAgIH07XHJcbn1cclxuXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaWFnbm9zdGljVGFzazxUPihsYWJlbDogc3RyaW5nLCBkZXRhaWxzOiB1bmtub3duLCB0YXNrOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XHJcbiAgICBjb25zdCB0cmFjZSA9IGRpYWdub3N0aWNTdGFydChsYWJlbCwgZGV0YWlscyk7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRhc2soKTtcclxuICAgICAgICB0cmFjZS5kb25lKCk7XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgdHJhY2UuZmFpbChlcnJvcik7XHJcbiAgICAgICAgdGhyb3cgZXJyb3I7XHJcbiAgICB9XHJcbn1cclxuIl19