"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.finalizeImportReview = finalizeImportReview;
/** A completed import must retain a viewable report even if live validation fails. */
async function finalizeImportReview(service, recorder, document, before, after, targetUrl, warnings, refresh, wait = () => new Promise((resolve) => setTimeout(resolve, 150))) {
    var _a;
    const empty = { rootUuid: '', targetUuid: '', mode: 'unknown', nodes: [] };
    let readOnlyReason;
    if (!before || !after)
        readOnlyReason = '导入前后节点快照不完整。';
    else {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                after = await refresh();
                readOnlyReason = undefined;
                break;
            }
            catch (error) {
                readOnlyReason = error instanceof Error ? error.message : String(error);
                if (attempt < 2)
                    await wait();
            }
        }
    }
    if (!readOnlyReason && ((_a = after === null || after === void 0 ? void 0 : after.saveAdjustments) === null || _a === void 0 ? void 0 : _a.count)) {
        const { count, details } = after.saveAdjustments;
        warnings.push(`保存收尾已同步 ${count} 项位置/尺寸等几何变化，节点结构、组件及资源引用校验通过；报告采用保存后的数值。${details.join('；')}${count > details.length ? '；其余略' : ''}`);
    }
    if (!readOnlyReason) {
        try {
            return await service.complete(recorder, document, before, after, targetUrl, warnings);
        }
        catch (error) {
            readOnlyReason = `完整报告生成失败：${error instanceof Error ? error.message : String(error)}`;
        }
    }
    warnings.push(`导入已完成；结果仅供查看，已禁用资源清理。${readOnlyReason}`);
    return service.complete(recorder, document, before !== null && before !== void 0 ? before : empty, after !== null && after !== void 0 ? after : empty, targetUrl, warnings, `${readOnlyReason} 下方节点信息为导入时记录的快照，不保证与当前编辑目标一致。请在目标稳定后重新导入以启用修改。`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXJldmlldy1maW5hbGl6ZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9pbXBvcnRlci9pbXBvcnQtcmV2aWV3LWZpbmFsaXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBS0Esb0RBNkJDO0FBOUJELHNGQUFzRjtBQUMvRSxLQUFLLFVBQVUsb0JBQW9CLENBQ3RDLE9BQTRCLEVBQUUsUUFBOEIsRUFBRSxRQUF5QixFQUN2RixNQUErQixFQUFFLEtBQThCLEVBQUUsU0FBNkIsRUFDOUYsUUFBa0IsRUFBRSxPQUFtQyxFQUN2RCxPQUE0QixHQUFHLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQzs7SUFFcEYsTUFBTSxLQUFLLEdBQWdCLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxDQUFDO0lBQ3hGLElBQUksY0FBa0MsQ0FBQztJQUN2QyxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSztRQUFFLGNBQWMsR0FBRyxjQUFjLENBQUM7U0FDbEQsQ0FBQztRQUNGLEtBQUssSUFBSSxPQUFPLEdBQUcsQ0FBQyxFQUFFLE9BQU8sR0FBRyxDQUFDLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQztZQUMzQyxJQUFJLENBQUM7Z0JBQUMsS0FBSyxHQUFHLE1BQU0sT0FBTyxFQUFFLENBQUM7Z0JBQUMsY0FBYyxHQUFHLFNBQVMsQ0FBQztnQkFBQyxNQUFNO1lBQUMsQ0FBQztZQUNuRSxPQUFPLEtBQUssRUFBRSxDQUFDO2dCQUNYLGNBQWMsR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ3hFLElBQUksT0FBTyxHQUFHLENBQUM7b0JBQUUsTUFBTSxJQUFJLEVBQUUsQ0FBQztZQUNsQyxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLENBQUMsY0FBYyxLQUFJLE1BQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLGVBQWUsMENBQUUsS0FBSyxDQUFBLEVBQUUsQ0FBQztRQUNuRCxNQUFNLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxHQUFHLEtBQUssQ0FBQyxlQUFlLENBQUM7UUFDakQsUUFBUSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssNENBQTRDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUMxSSxDQUFDO0lBQ0QsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQ2xCLElBQUksQ0FBQztZQUFDLE9BQU8sTUFBTSxPQUFPLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTyxFQUFFLEtBQU0sRUFBRSxTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFBQyxDQUFDO1FBQ2hHLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFBQyxjQUFjLEdBQUcsWUFBWSxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUFDLENBQUM7SUFDNUcsQ0FBQztJQUNELFFBQVEsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFDeEQsT0FBTyxPQUFPLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTSxhQUFOLE1BQU0sY0FBTixNQUFNLEdBQUksS0FBSyxFQUFFLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEtBQUssRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUM1RixHQUFHLGNBQWMsaURBQWlELENBQUMsQ0FBQztBQUM1RSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcsIFJldmlld1NjZW5lIH0gZnJvbSAnLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XHJcbmltcG9ydCB0eXBlIHsgRG9jdW1lbnRTZXNzaW9uIH0gZnJvbSAnLi4vdHlwZXMnO1xyXG5pbXBvcnQgeyBJbXBvcnRSZXZpZXdSZWNvcmRlciwgSW1wb3J0UmV2aWV3U2VydmljZSB9IGZyb20gJy4vaW1wb3J0LXJldmlldyc7XHJcblxyXG4vKiogQSBjb21wbGV0ZWQgaW1wb3J0IG11c3QgcmV0YWluIGEgdmlld2FibGUgcmVwb3J0IGV2ZW4gaWYgbGl2ZSB2YWxpZGF0aW9uIGZhaWxzLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmluYWxpemVJbXBvcnRSZXZpZXcoXHJcbiAgICBzZXJ2aWNlOiBJbXBvcnRSZXZpZXdTZXJ2aWNlLCByZWNvcmRlcjogSW1wb3J0UmV2aWV3UmVjb3JkZXIsIGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24sXHJcbiAgICBiZWZvcmU6IFJldmlld1NjZW5lIHwgdW5kZWZpbmVkLCBhZnRlcjogUmV2aWV3U2NlbmUgfCB1bmRlZmluZWQsIHRhcmdldFVybDogc3RyaW5nIHwgdW5kZWZpbmVkLFxyXG4gICAgd2FybmluZ3M6IHN0cmluZ1tdLCByZWZyZXNoOiAoKSA9PiBQcm9taXNlPFJldmlld1NjZW5lPixcclxuICAgIHdhaXQ6ICgpID0+IFByb21pc2U8dm9pZD4gPSAoKSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxNTApKSxcclxuKTogUHJvbWlzZTxJbXBvcnRSZXZpZXc+IHtcclxuICAgIGNvbnN0IGVtcHR5OiBSZXZpZXdTY2VuZSA9IHsgcm9vdFV1aWQ6ICcnLCB0YXJnZXRVdWlkOiAnJywgbW9kZTogJ3Vua25vd24nLCBub2RlczogW10gfTtcclxuICAgIGxldCByZWFkT25seVJlYXNvbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgaWYgKCFiZWZvcmUgfHwgIWFmdGVyKSByZWFkT25seVJlYXNvbiA9ICflr7zlhaXliY3lkI7oioLngrnlv6vnhafkuI3lrozmlbTjgIInO1xyXG4gICAgZWxzZSB7XHJcbiAgICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0KyspIHtcclxuICAgICAgICAgICAgdHJ5IHsgYWZ0ZXIgPSBhd2FpdCByZWZyZXNoKCk7IHJlYWRPbmx5UmVhc29uID0gdW5kZWZpbmVkOyBicmVhazsgfVxyXG4gICAgICAgICAgICBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgIHJlYWRPbmx5UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGF0dGVtcHQgPCAyKSBhd2FpdCB3YWl0KCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlYWRPbmx5UmVhc29uICYmIGFmdGVyPy5zYXZlQWRqdXN0bWVudHM/LmNvdW50KSB7XHJcbiAgICAgICAgY29uc3QgeyBjb3VudCwgZGV0YWlscyB9ID0gYWZ0ZXIuc2F2ZUFkanVzdG1lbnRzO1xyXG4gICAgICAgIHdhcm5pbmdzLnB1c2goYOS/neWtmOaUtuWwvuW3suWQjOatpSAke2NvdW50fSDpobnkvY3nva4v5bC65a+4562J5Yeg5L2V5Y+Y5YyW77yM6IqC54K557uT5p6E44CB57uE5Lu25Y+K6LWE5rqQ5byV55So5qCh6aqM6YCa6L+H77yb5oql5ZGK6YeH55So5L+d5a2Y5ZCO55qE5pWw5YC844CCJHtkZXRhaWxzLmpvaW4oJ++8mycpfSR7Y291bnQgPiBkZXRhaWxzLmxlbmd0aCA/ICfvvJvlhbbkvZnnlaUnIDogJyd9YCk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlYWRPbmx5UmVhc29uKSB7XHJcbiAgICAgICAgdHJ5IHsgcmV0dXJuIGF3YWl0IHNlcnZpY2UuY29tcGxldGUocmVjb3JkZXIsIGRvY3VtZW50LCBiZWZvcmUhLCBhZnRlciEsIHRhcmdldFVybCwgd2FybmluZ3MpOyB9XHJcbiAgICAgICAgY2F0Y2ggKGVycm9yKSB7IHJlYWRPbmx5UmVhc29uID0gYOWujOaVtOaKpeWRiueUn+aIkOWksei0pe+8miR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWA7IH1cclxuICAgIH1cclxuICAgIHdhcm5pbmdzLnB1c2goYOWvvOWFpeW3suWujOaIkO+8m+e7k+aenOS7heS+m+afpeeci++8jOW3suemgeeUqOi1hOa6kOa4heeQhuOAgiR7cmVhZE9ubHlSZWFzb259YCk7XHJcbiAgICByZXR1cm4gc2VydmljZS5jb21wbGV0ZShyZWNvcmRlciwgZG9jdW1lbnQsIGJlZm9yZSA/PyBlbXB0eSwgYWZ0ZXIgPz8gZW1wdHksIHRhcmdldFVybCwgd2FybmluZ3MsXHJcbiAgICAgICAgYCR7cmVhZE9ubHlSZWFzb259IOS4i+aWueiKgueCueS/oeaBr+S4uuWvvOWFpeaXtuiusOW9leeahOW/q+eFp++8jOS4jeS/neivgeS4juW9k+WJjee8lui+keebruagh+S4gOiHtOOAguivt+WcqOebruagh+eos+WumuWQjumHjeaWsOWvvOWFpeS7peWQr+eUqOS/ruaUueOAgmApO1xyXG59XHJcbiJdfQ==