import type { ParsedSource } from '../types';

const FILE_SEGMENTS = new Set(['file', 'design', 'proto', 'board']);

export function normalizeNodeId(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const decoded = decodeURIComponent(value).trim();
    if (!decoded) {
        return undefined;
    }
    return decoded.replace(/-/g, ':');
}

export function parseFigmaSource(input: string): ParsedSource {
    const value = input.trim();
    if (!value) {
        throw new Error('请输入 Figma 文件或节点链接。');
    }

    if (/^[a-zA-Z0-9_-]{10,}$/.test(value) && !value.includes('/')) {
        return { fileKey: value };
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Figma 链接格式无效。');
    }
    if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
        throw new Error('仅支持 figma.com 链接。');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const segmentIndex = parts.findIndex((part) => FILE_SEGMENTS.has(part.toLowerCase()));
    if (segmentIndex < 0 || !parts[segmentIndex + 1]) {
        throw new Error('链接中缺少 Figma file key。');
    }

    return {
        fileKey: parts[segmentIndex + 1],
        nodeId: normalizeNodeId(url.searchParams.get('node-id') ?? undefined),
    };
}
