import { PNG } from 'pngjs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const COLOR_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

function dimensions(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
        throw new Error('IMAGE 填充尺寸超过安全处理范围（单边 8192，合计 1600 万像素）。');
    }
}

function inspect(contents: Buffer): { width: number; height: number; metadata: Buffer[] } {
    if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE)
        || contents.readUInt32BE(8) !== 13 || contents.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('IMAGE 源图片不是有效的 PNG。');
    }
    const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
    dimensions(width, height);
    if (contents[24] > 8) throw new Error('暂不支持重采样高位深 IMAGE 填充。');
    const metadata: Buffer[] = [];
    for (let offset = 8; offset + 12 <= contents.length;) {
        const end = offset + 12 + contents.readUInt32BE(offset);
        if (end > contents.length) break;
        const type = contents.toString('ascii', offset + 4, offset + 8);
        if (['acTL', 'fcTL', 'fdAT', 'sBIT'].includes(type)) {
            throw new Error('暂不支持重采样动画或特殊位深 IMAGE 填充。');
        }
        if (COLOR_CHUNKS.has(type)) metadata.push(contents.subarray(offset, end));
        if (type === 'IEND') {
            if (end !== contents.length) throw new Error('IMAGE PNG 包含无法解释的额外数据。');
            return { width, height, metadata };
        }
        offset = end;
    }
    throw new Error('IMAGE PNG 数据不完整。');
}

/** Creator supplies Electron for non-PNG raster decoding; never change Node scale. */
function decodeToPng(contents: Buffer): Buffer {
    try {
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromBuffer(contents);
        if (image.isEmpty()) throw new Error('无法识别图片格式');
        const { width, height } = image.getSize();
        dimensions(width, height);
        return image.toPNG();
    } catch (error) {
        throw new Error(`无法解码 IMAGE 源图片：${(error as Error).message}`);
    }
}

interface Sample { index: number; weight: number; }

/** Transparent coverage outside FIT bounds; clamp, never wrap, at image edges. */
function samples(source: number, target: number, ratio: number, offset: number): Sample[][] {
    return Array.from({ length: target }, (_, out) => {
        if (ratio <= 1) {
            // Area filtering preserves coverage and small detail on reduction.
            const start = (out - offset) / ratio, end = (out + 1 - offset) / ratio;
            const result: Sample[] = [];
            const first = Math.max(0, Math.floor(start));
            const last = Math.min(source, Math.ceil(end));
            for (let index = first; index < last; index++) {
                const weight = (Math.min(end, index + 1) - Math.max(start, index)) / (end - start);
                if (weight > 0) result.push({ index, weight });
            }
            return result;
        }
        const coverage = Math.max(0, Math.min(out + 1, offset + source * ratio) - Math.max(out, offset));
        if (!coverage) return [];
        const center = (out + 0.5 - offset) / ratio - 0.5;
        const first = Math.floor(center), fraction = center - first;
        const clamp = (index: number) => Math.max(0, Math.min(source - 1, index));
        return [{ index: clamp(first), weight: (1 - fraction) * coverage },
            { index: clamp(first + 1), weight: fraction * coverage }];
    });
}

/** Standard center-aligned Figma IMAGE FILL/FIT with no imageTransform/rotation.
 * width/height are node logical units; scale is applied exactly once to the PNG
 * canvas. Visibility and node/ancestor opacity do not affect these source pixels.
 * Returns a complete PNG or throws; original downloaded bytes remain unchanged.
 */
export function rasterizeImageFill(contents: Buffer, mode: 'FILL' | 'FIT',
    width: number, height: number, scale: number): Buffer {
    if (mode !== 'FILL' && mode !== 'FIT') throw new Error('IMAGE 填充仅支持标准中心 FILL/FIT。');
    if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0)) {
        throw new Error('IMAGE 填充宽高和倍率必须为有限正数。');
    }
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    dimensions(targetWidth, targetHeight);
    if (!contents.length || contents.length > MAX_BYTES) throw new Error('IMAGE 源图片为空或超过 64 MB。');
    const png = contents.subarray(0, 8).equals(SIGNATURE) ? contents : decodeToPng(contents);
    const header = inspect(png);
    const input = PNG.sync.read(png, { checkCRC: true });
    if (targetWidth === header.width && targetHeight === header.height) return png;
    const ratio = mode === 'FILL'
        ? Math.max(targetWidth / header.width, targetHeight / header.height)
        : Math.min(targetWidth / header.width, targetHeight / header.height);
    const offsetX = (targetWidth - header.width * ratio) / 2;
    const offsetY = (targetHeight - header.height * ratio) / 2;
    const xs = samples(header.width, targetWidth, ratio, offsetX);
    const ys = samples(header.height, targetHeight, ratio, offsetY);
    const output = new PNG({ width: targetWidth, height: targetHeight });
    for (let y = 0; y < targetHeight; y++) {
        if (!ys[y].length) continue;
        for (let x = 0; x < targetWidth; x++) {
            let alpha = 0, red = 0, green = 0, blue = 0;
            for (const sy of ys[y]) for (const sx of xs[x]) {
                const source = (sy.index * header.width + sx.index) * 4;
                const a = input.data[source + 3] * sy.weight * sx.weight;
                alpha += a;
                red += input.data[source] * a;
                green += input.data[source + 1] * a;
                blue += input.data[source + 2] * a;
            }
            const target = (y * targetWidth + x) * 4;
            output.data[target + 3] = Math.round(alpha);
            // Ignore hidden RGB and do not darken semi-transparent fringes.
            if (output.data[target + 3] > 0) {
                output.data[target] = Math.round(red / alpha);
                output.data[target + 1] = Math.round(green / alpha);
                output.data[target + 2] = Math.round(blue / alpha);
            }
        }
    }
    const encoded = PNG.sync.write(output);
    return header.metadata.length
        ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded;
}
