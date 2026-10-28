import { analyzeTree } from './figma/analyzer';
import { parseFigmaSource } from './figma/url';
import { sanitizeAssetName } from './importer/assets';
import type { DocumentSession, FigmaNode } from './types';

/** Collect screen roots in Figma order, without entering frames or components. */
/**
 * 批量导入时被当作独立 Prefab 的节点类型。
 * Frame 是屏幕边界；Component 自 1.1.3 起同样是单节点来源，可独立生成/更新 Prefab。
 * Instance 与 ComponentSet 仍不作为边界：前者是引用，后者是多变体容器。
 */
const BATCH_SOURCE_TYPES = new Set(['FRAME', 'COMPONENT']);

export function collectSectionFrames(section: FigmaNode): FigmaNode[] {
    const frames: FigmaNode[] = [];
    const visited = new Set<string>();
    const visit = (node: FigmaNode, ancestorHidden: boolean): void => {
        if (visited.has(node.id)) return;
        visited.add(node.id);
        const hidden = ancestorHidden || node.visible === false;
        if (BATCH_SOURCE_TYPES.has(node.type)) {
            // A frame session no longer contains its Section/Group ancestors.
            // Carry their visibility onto a cloned root without mutating the
            // original document, changing source identity or copying children.
            frames.push(hidden && node.visible !== false ? { ...node, visible: false } : node);
            return;
        }
        if (node.type === 'SECTION' || node.type === 'GROUP') node.children.forEach((child) => visit(child, hidden));
    };
    // A frame passed directly also follows the same screen boundary rule.
    visit(section, false);
    return frames;
}

/** A section and a direct frame link must resolve to the same frame source. */
export function frameSourceUrl(sourceUrl: string, rootId: string): string {
    const parsed = parseFigmaSource(sourceUrl);
    let url: URL;
    try {
        url = new URL(sourceUrl.trim());
    } catch {
        url = new URL(`https://www.figma.com/design/${encodeURIComponent(parsed.fileKey)}`);
    }
    url.searchParams.set('node-id', rootId.replace(/:/g, '-'));
    return url.toString();
}

/** Build an independent screen session; the original parsed document stays intact. */
export function frameDocument(document: DocumentSession, frame: FigmaNode): DocumentSession {
    const nodeById = new Map<string, FigmaNode>();
    const fonts = new Set<string>();
    const visit = (node: FigmaNode): void => {
        nodeById.set(node.id, node);
        if (node.style?.fontFamily) fonts.add(node.style.fontFamily);
        node.children.forEach(visit);
    };
    visit(frame);
    return {
        fileKey: document.fileKey,
        fileName: document.fileName,
        sourceUrl: frameSourceUrl(document.sourceUrl, frame.id),
        sourceNodeId: frame.id,
        roots: [frame],
        nodeById,
        tree: analyzeTree([frame]),
        fonts: [...fonts].sort((left, right) => left.localeCompare(right)),
    };
}

const FORBIDDEN_ASSET_CHARACTERS = /[<>:"/\\|?*#%\u0000-\u001f]/g;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Validate the output path before any screen in the batch writes a prefab. */
export function assertBatchTargets(targets: Array<{ id: string; name: string }>): void {
    if (!targets.length) throw new Error('请至少选择一个待导入界面。');
    const ids = new Map<string, number>();
    const names = new Map<string, number>();
    const label = (index: number): string => `第 ${index + 1} 项“${targets[index].name || '未命名'}”`;
    targets.forEach((target, index) => {
        if (typeof target.id !== 'string' || !target.id.trim()) {
            throw new Error(`${label(index)}缺少界面标识，请重新添加该界面。`);
        }
        const previousId = ids.get(target.id);
        if (previousId !== undefined) {
            throw new Error(`${label(previousId)}与${label(index)}重复，请移除其中一项。`);
        }
        ids.set(target.id, index);

        const input = typeof target.name === 'string' ? target.name.normalize('NFKC') : '';
        const meaningful = input.replace(FORBIDDEN_ASSET_CHARACTERS, '').replace(/[.\s]/g, '');
        if (!meaningful) throw new Error(`${label(index)}的 Prefab 名称无效，请填写有效名称。`);
        const withoutEdgeDots = input.replace(FORBIDDEN_ASSET_CHARACTERS, '_')
            .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
        if (WINDOWS_DEVICE_NAME.test(withoutEdgeDots)) {
            throw new Error(`${label(index)}使用了系统保留名称，请修改 Prefab 名称。`);
        }
        // Windows discards trailing dots/spaces; sanitization can expose another
        // trailing dot when it truncates a long name to its 72-character limit.
        const outputName = sanitizeAssetName(target.name).replace(/[. ]+$/g, '')
            .toLocaleLowerCase('en-US');
        const previousName = names.get(outputName);
        if (previousName !== undefined) {
            throw new Error(`${label(previousName)}与${label(index)}的 Prefab 输出名称冲突，请修改名称。`);
        }
        names.set(outputName, index);
    });
}
