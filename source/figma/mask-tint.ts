import { PNG } from 'pngjs';
import type { FigmaColor, FigmaNode, Rect } from '../types';

export interface MaskTintCandidate {
    mask: FigmaNode;
    tint: FigmaColor;
}

export interface MaskTintAnalysis {
    candidate?: MaskTintCandidate;
    reason: string;
}

const EPSILON = 0.0001;
const normalBlend = (node: FigmaNode) => !node.blendMode
    || ['NORMAL', 'PASS_THROUGH'].includes(node.blendMode);
const noEffects = (node: FigmaNode) => !node.effects.some((effect) => effect.visible !== false)
    && !(node.strokeWeight > 0 && node.strokes.some((paint) => paint.visible !== false));
const paints = (node: FigmaNode) => node.fills.filter((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
const neutralTransform = (node: FigmaNode) => Math.abs(node.rotation) <= EPSILON
    && (!node.relativeTransform || (node.relativeTransform.length === 2
        && Math.abs(node.relativeTransform[0]?.[0] - 1) <= EPSILON
        && Math.abs(node.relativeTransform[0]?.[1]) <= EPSILON
        && Math.abs(node.relativeTransform[1]?.[0]) <= EPSILON
        && Math.abs(node.relativeTransform[1]?.[1] - 1) <= EPSILON));
const sameFrame = (a?: Rect, b?: Rect) => Boolean(a && b && ['x', 'y', 'width', 'height']
    .every((key) => Math.abs(a[key as keyof Rect] - b[key as keyof Rect]) <= EPSILON));

/** Restrict the optimization to an actual ALPHA mask followed by one solid cover. */
export function analyzeMaskTint(node: FigmaNode): MaskTintAnalysis | undefined {
    if (!node.children.some((child) => child.isMask)) return undefined;
    const fail = (reason: string): MaskTintAnalysis => ({ reason });
    if (!normalBlend(node) || !noEffects(node) || paints(node).length || !neutralTransform(node)
        || (node.layoutMode && node.layoutMode !== 'NONE') || node.overflowDirection
        || node.clipsContent) return fail('蒙版容器带有额外绘制、变换、裁切或运行时布局');
    if (node.children.length !== 2) return fail('仅支持一个真实 Alpha 蒙版与一个纯色覆盖层');
    const [mask, cover] = node.children;
    if (!mask.isMask || mask.maskType !== 'ALPHA' || cover.isMask) return fail('蒙版类型未明确为 ALPHA，或蒙版顺序/数量不受支持');
    if (!mask.visible || !cover.visible || mask.opacity !== 1) return fail('蒙版/覆盖层隐藏或蒙版透明度不为 100%');
    if (!normalBlend(mask) || !normalBlend(cover) || !noEffects(mask) || !noEffects(cover)
        || !neutralTransform(mask) || !neutralTransform(cover)
        || !sameFrame(node.absoluteBoundingBox, mask.absoluteBoundingBox)
        || !sameFrame(node.absoluteBoundingBox, cover.absoluteBoundingBox)) return fail('蒙版与覆盖层的几何、混合或效果不能等价映射');
    if (cover.type !== 'RECTANGLE' || cover.children.length
        || [cover.cornerRadius ?? 0, ...(cover.rectangleCornerRadii ?? [])].some((radius) => radius > 0)) {
        return fail('纯色覆盖层不是完整无圆角矩形');
    }
    const fills = paints(cover);
    const fill = fills[0];
    if (fills.length !== 1 || fill.type !== 'SOLID' || !fill.color
        || (fill.blendMode && fill.blendMode !== 'NORMAL')) return fail('覆盖层不是单一普通混合的纯色填充');
    // Nested masks/effects/partial node opacity cannot be established from a
    // same-name local bitmap. They must use Figma's complete composition.
    const safeMask = (part: FigmaNode, root = false): boolean => normalBlend(part)
        && noEffects(part) && neutralTransform(part) && part.visible && part.opacity === 1
        && (root || !part.isMask) && !part.clipsContent
        && paints(part).every((paint) => (!paint.blendMode || paint.blendMode === 'NORMAL')
            && (paint.opacity ?? 1) === 1
            && ((paint.type === 'IMAGE' && paint.imageTransform === undefined
                && (!paint.filters || Object.values(paint.filters).every((value) => value === 0))
                && ['FILL', 'FIT'].includes(paint.scaleMode?.toUpperCase() ?? 'FILL')
                && Math.abs(paint.rotation ?? 0) <= EPSILON) || (paint.type === 'SOLID' && paint.color
                && paint.color.r === 1 && paint.color.g === 1 && paint.color.b === 1 && (paint.color.a ?? 1) === 1)))
        && part.children.every((child) => safeMask(child));
    if (!safeMask(mask, true)) return fail('蒙版内部含有未能证明等价的颜色、透明度、效果或嵌套蒙版');
    return { candidate: { mask, tint: { ...fill.color,
        a: (fill.color.a ?? 1) * (fill.opacity ?? 1) * cover.opacity } },
    reason: '真实 Alpha 蒙版与单色覆盖层可使用经验证的白色底图和实例 Sprite Color' };
}

/** White RGB at every contributing pixel is required for exact multiply tint. */
export function verifyWhiteAlphaPng(contents: Buffer): { valid: boolean; reason: string } {
    try {
        if (contents.length < 33 || !contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            return { valid: false, reason: '底图不是可验证的 PNG，保守使用完整合成' };
        }
        const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
        if (!width || !height || width * height > 16_000_000) throw new Error('底图尺寸超过安全解码范围');
        const image = PNG.sync.read(contents, { checkCRC: true, skipRescale: true });
        const maximum = Number(image.colorType) === 3 ? 255 : 2 ** image.depth - 1;
        let contributing = false;
        for (let i = 0; i < image.data.length; i += 4) {
            if (image.data[i + 3] === 0) continue;
            contributing = true;
            if (image.data[i] !== maximum || image.data[i + 1] !== maximum || image.data[i + 2] !== maximum) {
                return { valid: false, reason: '底图含非白 RGB，Sprite 乘色会偏暗，保守使用完整合成' };
            }
        }
        return { valid: contributing, reason: contributing ? '已逐像素确认白色 RGB 与透明轮廓' : '底图完全透明，无法证明有效轮廓' };
    } catch (error) { return { valid: false, reason: `底图无法安全解码：${(error as Error).message}` }; }
}
