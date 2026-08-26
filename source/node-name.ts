/**
 * Cocos 节点名与资源路径会共享部分编辑器基础设施，因此统一过滤控制字符
 * 和路径分隔符。返回 undefined 表示没有可用名称。
 */
export function sanitizeNodeName(value: unknown): string | undefined {
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
