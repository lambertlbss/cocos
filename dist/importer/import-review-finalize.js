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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW1wb3J0LXJldmlldy1maW5hbGl6ZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NvdXJjZS9pbXBvcnRlci9pbXBvcnQtcmV2aWV3LWZpbmFsaXplLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBS0Esb0RBNkJDO0FBOUJELHNGQUFzRjtBQUMvRSxLQUFLLFVBQVUsb0JBQW9CLENBQ3RDLE9BQTRCLEVBQUUsUUFBOEIsRUFBRSxRQUF5QixFQUN2RixNQUErQixFQUFFLEtBQThCLEVBQUUsU0FBNkIsRUFDOUYsUUFBa0IsRUFBRSxPQUFtQyxFQUN2RCxPQUE0QixHQUFHLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQzs7SUFFcEYsTUFBTSxLQUFLLEdBQWdCLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxDQUFDO0lBQ3hGLElBQUksY0FBa0MsQ0FBQztJQUN2QyxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSztRQUFFLGNBQWMsR0FBRyxjQUFjLENBQUM7U0FDbEQsQ0FBQztRQUNGLEtBQUssSUFBSSxPQUFPLEdBQUcsQ0FBQyxFQUFFLE9BQU8sR0FBRyxDQUFDLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQztZQUMzQyxJQUFJLENBQUM7Z0JBQUMsS0FBSyxHQUFHLE1BQU0sT0FBTyxFQUFFLENBQUM7Z0JBQUMsY0FBYyxHQUFHLFNBQVMsQ0FBQztnQkFBQyxNQUFNO1lBQUMsQ0FBQztZQUNuRSxPQUFPLEtBQUssRUFBRSxDQUFDO2dCQUNYLGNBQWMsR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ3hFLElBQUksT0FBTyxHQUFHLENBQUM7b0JBQUUsTUFBTSxJQUFJLEVBQUUsQ0FBQztZQUNsQyxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7SUFDRCxJQUFJLENBQUMsY0FBYyxLQUFJLE1BQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLGVBQWUsMENBQUUsS0FBSyxDQUFBLEVBQUUsQ0FBQztRQUNuRCxNQUFNLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxHQUFHLEtBQUssQ0FBQyxlQUFlLENBQUM7UUFDakQsUUFBUSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssNENBQTRDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsS0FBSyxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUMxSSxDQUFDO0lBQ0QsSUFBSSxDQUFDLGNBQWMsRUFBRSxDQUFDO1FBQ2xCLElBQUksQ0FBQztZQUFDLE9BQU8sTUFBTSxPQUFPLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTyxFQUFFLEtBQU0sRUFBRSxTQUFTLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFBQyxDQUFDO1FBQ2hHLE9BQU8sS0FBSyxFQUFFLENBQUM7WUFBQyxjQUFjLEdBQUcsWUFBWSxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUFDLENBQUM7SUFDNUcsQ0FBQztJQUNELFFBQVEsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFDeEQsT0FBTyxPQUFPLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxRQUFRLEVBQUUsTUFBTSxhQUFOLE1BQU0sY0FBTixNQUFNLEdBQUksS0FBSyxFQUFFLEtBQUssYUFBTCxLQUFLLGNBQUwsS0FBSyxHQUFJLEtBQUssRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUM1RixHQUFHLGNBQWMsaURBQWlELENBQUMsQ0FBQztBQUM1RSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBJbXBvcnRSZXZpZXcsIFJldmlld1NjZW5lIH0gZnJvbSAnLi4vaW1wb3J0LXJldmlldy1tb2RlbCc7XG5pbXBvcnQgdHlwZSB7IERvY3VtZW50U2Vzc2lvbiB9IGZyb20gJy4uL3R5cGVzJztcbmltcG9ydCB7IEltcG9ydFJldmlld1JlY29yZGVyLCBJbXBvcnRSZXZpZXdTZXJ2aWNlIH0gZnJvbSAnLi9pbXBvcnQtcmV2aWV3JztcblxuLyoqIEEgY29tcGxldGVkIGltcG9ydCBtdXN0IHJldGFpbiBhIHZpZXdhYmxlIHJlcG9ydCBldmVuIGlmIGxpdmUgdmFsaWRhdGlvbiBmYWlscy4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmaW5hbGl6ZUltcG9ydFJldmlldyhcbiAgICBzZXJ2aWNlOiBJbXBvcnRSZXZpZXdTZXJ2aWNlLCByZWNvcmRlcjogSW1wb3J0UmV2aWV3UmVjb3JkZXIsIGRvY3VtZW50OiBEb2N1bWVudFNlc3Npb24sXG4gICAgYmVmb3JlOiBSZXZpZXdTY2VuZSB8IHVuZGVmaW5lZCwgYWZ0ZXI6IFJldmlld1NjZW5lIHwgdW5kZWZpbmVkLCB0YXJnZXRVcmw6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICB3YXJuaW5nczogc3RyaW5nW10sIHJlZnJlc2g6ICgpID0+IFByb21pc2U8UmV2aWV3U2NlbmU+LFxuICAgIHdhaXQ6ICgpID0+IFByb21pc2U8dm9pZD4gPSAoKSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCAxNTApKSxcbik6IFByb21pc2U8SW1wb3J0UmV2aWV3PiB7XG4gICAgY29uc3QgZW1wdHk6IFJldmlld1NjZW5lID0geyByb290VXVpZDogJycsIHRhcmdldFV1aWQ6ICcnLCBtb2RlOiAndW5rbm93bicsIG5vZGVzOiBbXSB9O1xuICAgIGxldCByZWFkT25seVJlYXNvbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGlmICghYmVmb3JlIHx8ICFhZnRlcikgcmVhZE9ubHlSZWFzb24gPSAn5a+85YWl5YmN5ZCO6IqC54K55b+r54Wn5LiN5a6M5pW044CCJztcbiAgICBlbHNlIHtcbiAgICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPCAzOyBhdHRlbXB0KyspIHtcbiAgICAgICAgICAgIHRyeSB7IGFmdGVyID0gYXdhaXQgcmVmcmVzaCgpOyByZWFkT25seVJlYXNvbiA9IHVuZGVmaW5lZDsgYnJlYWs7IH1cbiAgICAgICAgICAgIGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIHJlYWRPbmx5UmVhc29uID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgICAgICAgICAgIGlmIChhdHRlbXB0IDwgMikgYXdhaXQgd2FpdCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGlmICghcmVhZE9ubHlSZWFzb24gJiYgYWZ0ZXI/LnNhdmVBZGp1c3RtZW50cz8uY291bnQpIHtcbiAgICAgICAgY29uc3QgeyBjb3VudCwgZGV0YWlscyB9ID0gYWZ0ZXIuc2F2ZUFkanVzdG1lbnRzO1xuICAgICAgICB3YXJuaW5ncy5wdXNoKGDkv53lrZjmlLblsL7lt7LlkIzmraUgJHtjb3VudH0g6aG55L2N572uL+WwuuWvuOetieWHoOS9leWPmOWMlu+8jOiKgueCuee7k+aehOOAgee7hOS7tuWPiui1hOa6kOW8leeUqOagoemqjOmAmui/h++8m+aKpeWRiumHh+eUqOS/neWtmOWQjueahOaVsOWAvOOAgiR7ZGV0YWlscy5qb2luKCfvvJsnKX0ke2NvdW50ID4gZGV0YWlscy5sZW5ndGggPyAn77yb5YW25L2Z55WlJyA6ICcnfWApO1xuICAgIH1cbiAgICBpZiAoIXJlYWRPbmx5UmVhc29uKSB7XG4gICAgICAgIHRyeSB7IHJldHVybiBhd2FpdCBzZXJ2aWNlLmNvbXBsZXRlKHJlY29yZGVyLCBkb2N1bWVudCwgYmVmb3JlISwgYWZ0ZXIhLCB0YXJnZXRVcmwsIHdhcm5pbmdzKTsgfVxuICAgICAgICBjYXRjaCAoZXJyb3IpIHsgcmVhZE9ubHlSZWFzb24gPSBg5a6M5pW05oql5ZGK55Sf5oiQ5aSx6LSl77yaJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YDsgfVxuICAgIH1cbiAgICB3YXJuaW5ncy5wdXNoKGDlr7zlhaXlt7LlrozmiJDvvJvnu5Pmnpzku4Xkvpvmn6XnnIvvvIzlt7LnpoHnlKjotYTmupDmuIXnkIbjgIIke3JlYWRPbmx5UmVhc29ufWApO1xuICAgIHJldHVybiBzZXJ2aWNlLmNvbXBsZXRlKHJlY29yZGVyLCBkb2N1bWVudCwgYmVmb3JlID8/IGVtcHR5LCBhZnRlciA/PyBlbXB0eSwgdGFyZ2V0VXJsLCB3YXJuaW5ncyxcbiAgICAgICAgYCR7cmVhZE9ubHlSZWFzb259IOS4i+aWueiKgueCueS/oeaBr+S4uuWvvOWFpeaXtuiusOW9leeahOW/q+eFp++8jOS4jeS/neivgeS4juW9k+WJjee8lui+keebruagh+S4gOiHtOOAguivt+WcqOebruagh+eos+WumuWQjumHjeaWsOWvvOWFpeS7peWQr+eUqOS/ruaUueOAgmApO1xufVxuIl19