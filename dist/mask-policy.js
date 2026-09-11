"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldGenerateMask = shouldGenerateMask;
exports.setMaskShapeSafely = setMaskShapeSafely;
/** A helper viewport is distinct from the imported source node (including roots). */
function shouldGenerateMask(spec, target = 'node') {
    var _a;
    const skip = (reason) => ({ shouldMask: false, reason, maskType: null });
    if (target === 'scroll-view') {
        return spec.action === 'generate' && spec.kind === 'scrollView'
            ? { shouldMask: true, reason: 'scroll-view-viewport', maskType: 'rectangle' }
            : skip('not-generated-scroll-view');
    }
    if (target === 'tiled-helper') {
        return (spec.action === 'generate' || spec.action === 'render')
            && Boolean((_a = spec.sprite) === null || _a === void 0 ? void 0 : _a.tiled) && spec.figmaType === 'ELLIPSE'
            ? { shouldMask: true, reason: 'tiled-ellipse-shape', maskType: 'ellipse' }
            : skip('no-tiled-ellipse');
    }
    if (spec.isRoot)
        return skip('import-root');
    if (spec.action !== 'generate')
        return skip('not-generated-container');
    if (spec.sprite)
        return skip('rasterized-node');
    if (spec.kind === 'scrollView')
        return skip('delegated-to-scroll-view');
    if (spec.kind === 'label' || spec.kind === 'richText'
        || ['TEXT', 'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'REGULAR_POLYGON'].includes(spec.figmaType)) {
        return skip('not-container');
    }
    if (!spec.clipsContent)
        return skip('clip-content-disabled');
    if (!spec.children.length)
        return skip('no-children');
    return {
        shouldMask: true,
        reason: 'explicit-clip-content',
        maskType: spec.figmaType === 'ELLIPSE' ? 'ellipse' : 'rectangle',
    };
}
/** Cocos 3.8.x invokes Mask.onLoad only after activation in the scene hierarchy. */
function setMaskShapeSafely(mask, type) {
    if (mask.type === type && mask.inverted === false)
        return;
    if (mask.subComp === null) {
        // 3.8.7 serialized fields: public setters can dereference a null subComp.
        // Store configuration for the normal onLoad; never activate hidden nodes
        // or manually invoke lifecycle methods just to initialize a renderer.
        if (!Object.prototype.hasOwnProperty.call(mask, '_type')
            || !Object.prototype.hasOwnProperty.call(mask, '_inverted')) {
            throw new Error('Mask 尚未初始化且引擎字段不兼容，已停止配置；请检查 Cocos Creator 版本。');
        }
        mask._type = type;
        mask._inverted = false;
        return;
    }
    if (mask.type !== type)
        mask.type = type;
    if (mask.inverted !== false)
        mask.inverted = false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFzay1wb2xpY3kuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2UvbWFzay1wb2xpY3kudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFVQSxnREE0QkM7QUFHRCxnREFnQkM7QUFoREQscUZBQXFGO0FBQ3JGLFNBQWdCLGtCQUFrQixDQUFDLElBQW1CLEVBQUUsU0FBcUIsTUFBTTs7SUFDL0UsTUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFjLEVBQWdCLEVBQUUsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFDL0YsSUFBSSxNQUFNLEtBQUssYUFBYSxFQUFFLENBQUM7UUFDM0IsT0FBTyxJQUFJLENBQUMsTUFBTSxLQUFLLFVBQVUsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFlBQVk7WUFDM0QsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsc0JBQXNCLEVBQUUsUUFBUSxFQUFFLFdBQVcsRUFBRTtZQUM3RSxDQUFDLENBQUMsSUFBSSxDQUFDLDJCQUEyQixDQUFDLENBQUM7SUFDNUMsQ0FBQztJQUNELElBQUksTUFBTSxLQUFLLGNBQWMsRUFBRSxDQUFDO1FBQzVCLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxLQUFLLFVBQVUsSUFBSSxJQUFJLENBQUMsTUFBTSxLQUFLLFFBQVEsQ0FBQztlQUN4RCxPQUFPLENBQUMsTUFBQSxJQUFJLENBQUMsTUFBTSwwQ0FBRSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsU0FBUyxLQUFLLFNBQVM7WUFDOUQsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUscUJBQXFCLEVBQUUsUUFBUSxFQUFFLFNBQVMsRUFBRTtZQUMxRSxDQUFDLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLENBQUM7SUFDbkMsQ0FBQztJQUNELElBQUksSUFBSSxDQUFDLE1BQU07UUFBRSxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUM1QyxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssVUFBVTtRQUFFLE9BQU8sSUFBSSxDQUFDLHlCQUF5QixDQUFDLENBQUM7SUFDdkUsSUFBSSxJQUFJLENBQUMsTUFBTTtRQUFFLE9BQU8sSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDaEQsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLFlBQVk7UUFBRSxPQUFPLElBQUksQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQ3hFLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLElBQUksSUFBSSxDQUFDLElBQUksS0FBSyxVQUFVO1dBQzlDLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLGlCQUFpQixDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1FBQ3pHLE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFDRCxJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVk7UUFBRSxPQUFPLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxDQUFDO0lBQzdELElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU07UUFBRSxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUN0RCxPQUFPO1FBQ0gsVUFBVSxFQUFFLElBQUk7UUFDaEIsTUFBTSxFQUFFLHVCQUF1QjtRQUMvQixRQUFRLEVBQUUsSUFBSSxDQUFDLFNBQVMsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsV0FBVztLQUNuRSxDQUFDO0FBQ04sQ0FBQztBQUVELG9GQUFvRjtBQUNwRixTQUFnQixrQkFBa0IsQ0FBQyxJQUFTLEVBQUUsSUFBWTtJQUN0RCxJQUFJLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksQ0FBQyxRQUFRLEtBQUssS0FBSztRQUFFLE9BQU87SUFDMUQsSUFBSSxJQUFJLENBQUMsT0FBTyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQ3hCLDBFQUEwRTtRQUMxRSx5RUFBeUU7UUFDekUsc0VBQXNFO1FBQ3RFLElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztlQUNqRCxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsV0FBVyxDQUFDLEVBQUUsQ0FBQztZQUM5RCxNQUFNLElBQUksS0FBSyxDQUFDLGdEQUFnRCxDQUFDLENBQUM7UUFDdEUsQ0FBQztRQUNELElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFDO1FBQ2xCLElBQUksQ0FBQyxTQUFTLEdBQUcsS0FBSyxDQUFDO1FBQ3ZCLE9BQU87SUFDWCxDQUFDO0lBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLElBQUk7UUFBRSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztJQUN6QyxJQUFJLElBQUksQ0FBQyxRQUFRLEtBQUssS0FBSztRQUFFLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDO0FBQ3ZELENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFNjZW5lTm9kZVNwZWMgfSBmcm9tICcuL3R5cGVzJztcclxuXHJcbmV4cG9ydCB0eXBlIE1hc2tUYXJnZXQgPSAnbm9kZScgfCAnc2Nyb2xsLXZpZXcnIHwgJ3RpbGVkLWhlbHBlcic7XHJcbmV4cG9ydCBpbnRlcmZhY2UgTWFza0RlY2lzaW9uIHtcclxuICAgIHNob3VsZE1hc2s6IGJvb2xlYW47XHJcbiAgICByZWFzb246IHN0cmluZztcclxuICAgIG1hc2tUeXBlOiAncmVjdGFuZ2xlJyB8ICdlbGxpcHNlJyB8IG51bGw7XHJcbn1cclxuXHJcbi8qKiBBIGhlbHBlciB2aWV3cG9ydCBpcyBkaXN0aW5jdCBmcm9tIHRoZSBpbXBvcnRlZCBzb3VyY2Ugbm9kZSAoaW5jbHVkaW5nIHJvb3RzKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEdlbmVyYXRlTWFzayhzcGVjOiBTY2VuZU5vZGVTcGVjLCB0YXJnZXQ6IE1hc2tUYXJnZXQgPSAnbm9kZScpOiBNYXNrRGVjaXNpb24ge1xyXG4gICAgY29uc3Qgc2tpcCA9IChyZWFzb246IHN0cmluZyk6IE1hc2tEZWNpc2lvbiA9PiAoeyBzaG91bGRNYXNrOiBmYWxzZSwgcmVhc29uLCBtYXNrVHlwZTogbnVsbCB9KTtcclxuICAgIGlmICh0YXJnZXQgPT09ICdzY3JvbGwtdmlldycpIHtcclxuICAgICAgICByZXR1cm4gc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgJiYgc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldydcclxuICAgICAgICAgICAgPyB7IHNob3VsZE1hc2s6IHRydWUsIHJlYXNvbjogJ3Njcm9sbC12aWV3LXZpZXdwb3J0JywgbWFza1R5cGU6ICdyZWN0YW5nbGUnIH1cclxuICAgICAgICAgICAgOiBza2lwKCdub3QtZ2VuZXJhdGVkLXNjcm9sbC12aWV3Jyk7XHJcbiAgICB9XHJcbiAgICBpZiAodGFyZ2V0ID09PSAndGlsZWQtaGVscGVyJykge1xyXG4gICAgICAgIHJldHVybiAoc3BlYy5hY3Rpb24gPT09ICdnZW5lcmF0ZScgfHwgc3BlYy5hY3Rpb24gPT09ICdyZW5kZXInKVxyXG4gICAgICAgICAgICAmJiBCb29sZWFuKHNwZWMuc3ByaXRlPy50aWxlZCkgJiYgc3BlYy5maWdtYVR5cGUgPT09ICdFTExJUFNFJ1xyXG4gICAgICAgICAgICA/IHsgc2hvdWxkTWFzazogdHJ1ZSwgcmVhc29uOiAndGlsZWQtZWxsaXBzZS1zaGFwZScsIG1hc2tUeXBlOiAnZWxsaXBzZScgfVxyXG4gICAgICAgICAgICA6IHNraXAoJ25vLXRpbGVkLWVsbGlwc2UnKTtcclxuICAgIH1cclxuICAgIGlmIChzcGVjLmlzUm9vdCkgcmV0dXJuIHNraXAoJ2ltcG9ydC1yb290Jyk7XHJcbiAgICBpZiAoc3BlYy5hY3Rpb24gIT09ICdnZW5lcmF0ZScpIHJldHVybiBza2lwKCdub3QtZ2VuZXJhdGVkLWNvbnRhaW5lcicpO1xyXG4gICAgaWYgKHNwZWMuc3ByaXRlKSByZXR1cm4gc2tpcCgncmFzdGVyaXplZC1ub2RlJyk7XHJcbiAgICBpZiAoc3BlYy5raW5kID09PSAnc2Nyb2xsVmlldycpIHJldHVybiBza2lwKCdkZWxlZ2F0ZWQtdG8tc2Nyb2xsLXZpZXcnKTtcclxuICAgIGlmIChzcGVjLmtpbmQgPT09ICdsYWJlbCcgfHwgc3BlYy5raW5kID09PSAncmljaFRleHQnXHJcbiAgICAgICAgfHwgWydURVhUJywgJ1ZFQ1RPUicsICdCT09MRUFOX09QRVJBVElPTicsICdTVEFSJywgJ0xJTkUnLCAnUkVHVUxBUl9QT0xZR09OJ10uaW5jbHVkZXMoc3BlYy5maWdtYVR5cGUpKSB7XHJcbiAgICAgICAgcmV0dXJuIHNraXAoJ25vdC1jb250YWluZXInKTtcclxuICAgIH1cclxuICAgIGlmICghc3BlYy5jbGlwc0NvbnRlbnQpIHJldHVybiBza2lwKCdjbGlwLWNvbnRlbnQtZGlzYWJsZWQnKTtcclxuICAgIGlmICghc3BlYy5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiBza2lwKCduby1jaGlsZHJlbicpO1xyXG4gICAgcmV0dXJuIHtcclxuICAgICAgICBzaG91bGRNYXNrOiB0cnVlLFxyXG4gICAgICAgIHJlYXNvbjogJ2V4cGxpY2l0LWNsaXAtY29udGVudCcsXHJcbiAgICAgICAgbWFza1R5cGU6IHNwZWMuZmlnbWFUeXBlID09PSAnRUxMSVBTRScgPyAnZWxsaXBzZScgOiAncmVjdGFuZ2xlJyxcclxuICAgIH07XHJcbn1cclxuXHJcbi8qKiBDb2NvcyAzLjgueCBpbnZva2VzIE1hc2sub25Mb2FkIG9ubHkgYWZ0ZXIgYWN0aXZhdGlvbiBpbiB0aGUgc2NlbmUgaGllcmFyY2h5LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2V0TWFza1NoYXBlU2FmZWx5KG1hc2s6IGFueSwgdHlwZTogbnVtYmVyKTogdm9pZCB7XHJcbiAgICBpZiAobWFzay50eXBlID09PSB0eXBlICYmIG1hc2suaW52ZXJ0ZWQgPT09IGZhbHNlKSByZXR1cm47XHJcbiAgICBpZiAobWFzay5zdWJDb21wID09PSBudWxsKSB7XHJcbiAgICAgICAgLy8gMy44Ljcgc2VyaWFsaXplZCBmaWVsZHM6IHB1YmxpYyBzZXR0ZXJzIGNhbiBkZXJlZmVyZW5jZSBhIG51bGwgc3ViQ29tcC5cclxuICAgICAgICAvLyBTdG9yZSBjb25maWd1cmF0aW9uIGZvciB0aGUgbm9ybWFsIG9uTG9hZDsgbmV2ZXIgYWN0aXZhdGUgaGlkZGVuIG5vZGVzXHJcbiAgICAgICAgLy8gb3IgbWFudWFsbHkgaW52b2tlIGxpZmVjeWNsZSBtZXRob2RzIGp1c3QgdG8gaW5pdGlhbGl6ZSBhIHJlbmRlcmVyLlxyXG4gICAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG1hc2ssICdfdHlwZScpXHJcbiAgICAgICAgICAgIHx8ICFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwobWFzaywgJ19pbnZlcnRlZCcpKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTWFzayDlsJrmnKrliJ3lp4vljJbkuJTlvJXmk47lrZfmrrXkuI3lhbzlrrnvvIzlt7LlgZzmraLphY3nva7vvJvor7fmo4Dmn6UgQ29jb3MgQ3JlYXRvciDniYjmnKzjgIInKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgbWFzay5fdHlwZSA9IHR5cGU7XHJcbiAgICAgICAgbWFzay5faW52ZXJ0ZWQgPSBmYWxzZTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAobWFzay50eXBlICE9PSB0eXBlKSBtYXNrLnR5cGUgPSB0eXBlO1xyXG4gICAgaWYgKG1hc2suaW52ZXJ0ZWQgIT09IGZhbHNlKSBtYXNrLmludmVydGVkID0gZmFsc2U7XHJcbn1cclxuIl19