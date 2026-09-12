import { PNG } from 'pngjs';
import type { FigmaNode, SpriteAssetSpec } from '../types';
import type { SliceAnalysis, SliceBorders } from '../figma/slicing';
import type { AssetWriter } from './assets';

export interface SliceOptimization {
    status: 'compacted' | 'unchanged' | 'skipped' | 'restored';
    reason: string;
    sourceWidth?: number;
    sourceHeight?: number;
    width?: number;
    height?: number;
    sourceBytes: number;
    bytes: number;
}

export interface CompactSliceResult {
    contents: Buffer;
    borders: SliceBorders;
    optimization: SliceOptimization;
}

interface Segment { start: number; size: number; }
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const COLOR_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

/** Validate size before decoding and preserve the original color interpretation. */
function inspectPng(contents: Buffer): { width: number; height: number; metadata: Buffer[] } {
    if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE)
        || contents.readUInt32BE(8) !== 13 || contents.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('PNG 格式无效或文件过大，保留完整图片');
    }
    const width = contents.readUInt32BE(16);
    const height = contents.readUInt32BE(20);
    if (!width || !height || width * height > MAX_PIXELS) throw new Error('图片超过安全处理像素上限，保留完整图片');
    if (contents[24] > 8) throw new Error('高位深 PNG 不进行降精度处理');
    const metadata: Buffer[] = [];
    let ended = false;
    for (let offset = 8; offset < contents.length;) {
        if (offset + 12 > contents.length) throw new Error('PNG 数据不完整');
        const end = offset + 12 + contents.readUInt32BE(offset);
        if (end > contents.length) throw new Error('PNG 数据不完整');
        const kind = contents.toString('ascii', offset + 4, offset + 8);
        if (['acTL', 'fcTL', 'fdAT', 'sBIT'].includes(kind)) throw new Error('特殊 PNG 元数据暂不支持最小化');
        if (COLOR_CHUNKS.has(kind)) metadata.push(contents.subarray(offset, end));
        offset = end;
        if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended) throw new Error('PNG 数据不完整');
    return { width, height, metadata };
}

function axisAligned(node: FigmaNode): boolean {
    const rotation = node.rotation ?? 0;
    if (!Number.isFinite(rotation) || Math.abs(rotation) > 0.01) return false;
    const matrix = node.relativeTransform;
    return !matrix || (matrix.length >= 2 && matrix[0].length >= 2 && matrix[1].length >= 2
        && [matrix[0][0], matrix[0][1], matrix[1][0], matrix[1][1]].every(Number.isFinite)
        && matrix[0][0] > 0 && matrix[1][1] > 0
        && Math.abs(matrix[0][1]) <= 0.000001 && Math.abs(matrix[1][0]) <= 0.000001);
}

/** All RGBA samples must match along the stretch axis, including both edge bands.
 * No tolerance: preserve subtle gradients, alpha fringes, text and texture detail.
 */
function repeatedBand(image: PNG, start: number, end: number, horizontal: boolean): boolean {
    const stride = image.width * 4;
    if (!horizontal) {
        const first = image.data.subarray(start * stride, (start + 1) * stride);
        for (let y = start + 1; y < end; y++) {
            if (!first.equals(image.data.subarray(y * stride, (y + 1) * stride))) return false;
        }
    } else {
        for (let y = 0; y < image.height; y++) {
            const first = image.data.readUInt32LE(y * stride + start * 4);
            for (let x = start + 1; x < end; x++) {
                if (image.data.readUInt32LE(y * stride + x * 4) !== first) return false;
            }
        }
    }
    return true;
}

function segments(length: number, before: number, after: number, keep: number, shrink: boolean): Segment[] {
    if (!shrink) return [{ start: 0, size: length }];
    return [
        { start: 0, size: before },
        { start: before + Math.floor((length - before - after - keep) / 2), size: keep },
        { start: length - after, size: after },
    ];
}

/** Adapted from main/a42fcc7. Shrink only provably repeatable middle bands.
 * Analysis uses Figma logical units; metadata and PNG use export pixels.
 * The node geometry, input Buffer, source asset and download cache never change.
 */
export function compactSlicePng(contents: Buffer, node: FigmaNode, analysis: SliceAnalysis, scale: number): CompactSliceResult {
    const borders = Object.fromEntries(Object.entries(analysis.borders)
        .map(([key, value]) => [key, Math.max(0, Math.round(value * scale))])) as unknown as SliceBorders;
    const optimization: SliceOptimization = {
        status: 'skipped', reason: '', sourceBytes: contents.length, bytes: contents.length,
    };
    const unchanged = (reason: string, status: 'skipped' | 'unchanged' = 'skipped'): CompactSliceResult => ({
        contents, borders, optimization: { ...optimization, status, reason },
    });
    try {
        if (!Number.isFinite(scale) || scale <= 0 || !axisAligned(node)) {
            return unchanged('旋转、翻转或无效倍率的切片保留完整图片');
        }
        const frame = node.absoluteBoundingBox;
        const header = inspectPng(contents);
        Object.assign(optimization, { sourceWidth: header.width, sourceHeight: header.height,
            width: header.width, height: header.height });
        // Sliced exports use the geometric canvas in V2. Do not guess a new
        // coordinate space for a different-sized local/already-compacted image.
        if (!frame || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
            || frame.width <= 0 || frame.height <= 0
            || Math.abs(header.width - frame.width * scale) > 1
            || Math.abs(header.height - frame.height * scale) > 1) {
            return unchanged('图片尺寸与切片画布不匹配，保留完整图片');
        }
        const horizontal = analysis.mode !== 'vertical';
        const vertical = analysis.mode !== 'horizontal';
        if (!['horizontal', 'vertical', 'nine'].includes(analysis.mode)
            || Object.values(analysis.borders).some((value) => !Number.isFinite(value) || value < 0)
            || (horizontal && (borders.left <= 0 || borders.right <= 0 || borders.left + borders.right >= header.width))
            || (vertical && (borders.top <= 0 || borders.bottom <= 0 || borders.top + borders.bottom >= header.height))) {
            return unchanged('切片像素边界无效，保留完整图片');
        }
        const keep = Math.max(1, Math.round(2 * scale));
        const canShrinkX = horizontal && header.width - borders.left - borders.right > keep;
        const canShrinkY = vertical && header.height - borders.top - borders.bottom > keep;
        if (!canShrinkX && !canShrinkY) return unchanged('中心区域已足够小', 'unchanged');
        const image = PNG.sync.read(contents, { checkCRC: true });
        const shrinkX = canShrinkX && repeatedBand(image, borders.left, image.width - borders.right, true);
        const shrinkY = canShrinkY && repeatedBand(image, borders.top, image.height - borders.bottom, false);
        if (!shrinkX && !shrinkY) return unchanged('中心或边带含非重复像素，为保留图案/渐变不缩小', 'unchanged');
        const columns = segments(image.width, borders.left, borders.right, keep, shrinkX);
        const rows = segments(image.height, borders.top, borders.bottom, keep, shrinkY);
        const output = new PNG({ width: columns.reduce((sum, item) => sum + item.size, 0),
            height: rows.reduce((sum, item) => sum + item.size, 0) });
        let targetY = 0;
        for (const row of rows) {
            let targetX = 0;
            for (const column of columns) {
                for (let y = 0; y < row.size; y++) {
                    const offset = ((row.start + y) * image.width + column.start) * 4;
                    image.data.copy(output.data, ((targetY + y) * output.width + targetX) * 4,
                        offset, offset + column.size * 4);
                }
                targetX += column.size;
            }
            targetY += row.size;
        }
        const encoded = PNG.sync.write(output);
        const result = header.metadata.length
            ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded;
        return { contents: result, borders, optimization: {
            ...optimization, status: 'compacted',
            reason: shrinkX && shrinkY ? '横纵中心带最小化' : shrinkX ? '仅横向中心带最小化' : '仅纵向中心带最小化',
            width: output.width, height: output.height, bytes: result.length,
        } };
    } catch (error) {
        return unchanged(error instanceof Error ? error.message : 'PNG 最小化失败，保留完整图片');
    }
}

/** A compact texture must never fall back to SIMPLE: restore the full source
 * first if Creator cannot persist/verify SLICED metadata. Basic asset IO errors
 * still propagate; a missing file is not a successful import.
 */
export async function writeSlicedPng(
    writer: Pick<AssetWriter, 'write'>, url: string, contents: Buffer,
    node: FigmaNode, analysis: SliceAnalysis, scale: number,
): Promise<{ asset: SpriteAssetSpec; optimization: SliceOptimization }> {
    const compact = compactSlicePng(contents, node, analysis, scale);
    let asset: SpriteAssetSpec;
    try {
        asset = await writer.write(url, compact.contents, compact.borders);
    } catch (error) {
        // AssetDB may have saved the bytes before a later readiness/IO failure.
        // Best-effort restore, but never turn the original failure into success.
        if (compact.optimization.status === 'compacted') {
            try { await writer.write(url, contents, compact.borders); }
            catch (restoreError) {
                throw new Error(`九宫小图写入失败，完整 PNG 恢复也失败：${String(error)}；${String(restoreError)}`);
            }
        }
        throw error;
    }
    if (compact.optimization.status === 'compacted' && (!asset.sliced || asset.sliceFallback)) {
        asset = await writer.write(url, contents, compact.borders);
        return { asset, optimization: { ...compact.optimization, status: 'restored',
            reason: '小图九宫边距未能确认，已恢复完整 PNG',
            width: compact.optimization.sourceWidth, height: compact.optimization.sourceHeight,
            bytes: contents.length } };
    }
    return { asset, optimization: compact.optimization };
}
