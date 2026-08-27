"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeNodeName = sanitizeNodeName;
/**
 * Cocos 节点名与资源路径会共享部分编辑器基础设施，因此统一过滤控制字符
 * 和路径分隔符。返回 undefined 表示没有可用名称。
 */
function sanitizeNodeName(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const cleaned = value
        .replace(/[\u0000-\u001f/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96);
    return cleaned || undefined;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibm9kZS1uYW1lLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc291cmNlL25vZGUtbmFtZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUlBLDRDQVVDO0FBZEQ7OztHQUdHO0FBQ0gsU0FBZ0IsZ0JBQWdCLENBQUMsS0FBYztJQUMzQyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzVCLE9BQU8sU0FBUyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxLQUFLO1NBQ2hCLE9BQU8sQ0FBQyxxQkFBcUIsRUFBRSxHQUFHLENBQUM7U0FDbkMsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUM7U0FDcEIsSUFBSSxFQUFFO1NBQ04sS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNsQixPQUFPLE9BQU8sSUFBSSxTQUFTLENBQUM7QUFDaEMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxyXG4gKiBDb2NvcyDoioLngrnlkI3kuI7otYTmupDot6/lvoTkvJrlhbHkuqvpg6jliIbnvJbovpHlmajln7rnoYDorr7mlr3vvIzlm6DmraTnu5/kuIDov4fmu6TmjqfliLblrZfnrKZcclxuICog5ZKM6Lev5b6E5YiG6ZqU56ym44CC6L+U5ZueIHVuZGVmaW5lZCDooajnpLrmsqHmnInlj6/nlKjlkI3np7DjgIJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzYW5pdGl6ZU5vZGVOYW1lKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcclxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XHJcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcclxuICAgIH1cclxuICAgIGNvbnN0IGNsZWFuZWQgPSB2YWx1ZVxyXG4gICAgICAgIC5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFmL1xcXFxdL2csICcgJylcclxuICAgICAgICAucmVwbGFjZSgvXFxzKy9nLCAnICcpXHJcbiAgICAgICAgLnRyaW0oKVxyXG4gICAgICAgIC5zbGljZSgwLCA5Nik7XHJcbiAgICByZXR1cm4gY2xlYW5lZCB8fCB1bmRlZmluZWQ7XHJcbn1cclxuIl19