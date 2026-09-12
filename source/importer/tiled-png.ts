import { PNG } from 'pngjs';
import type { SpriteAssetSpec } from '../types';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const COLOR_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

export interface TiledRaster {
    contents: Buffer;
    sourceWidth: number;
    sourceHeight: number;
    width: number;
    height: number;
    rounded: boolean;
}

/** Separate output identity from the unchanged, original-image download cache. */
export function tiledRasterKey(sourceKey: string, requestedScale: number): string {
    positiveScale(requestedScale);
    return JSON.stringify({ sourceKey, sizing: 'figma-visible-pixels-v1', requestedScale });
}

export function pixelSizedTileAsset(asset: SpriteAssetSpec): SpriteAssetSpec {
    return { ...asset, tiled: true, sliced: false, tileScale: 1 };
}

function positiveScale(value: number): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error('平铺资源倍率必须为正数。');
}

function dimensions(width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
        throw new Error('平铺资源尺寸超过安全处理范围（单边 8192，合计 1600 万像素）。');
    }
}

function inspect(contents: Buffer): { width: number; height: number; metadata: Buffer[] } {
    if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE)
        || contents.readUInt32BE(8) !== 13 || contents.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('平铺图片不是有效的 PNG。');
    }
    const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
    dimensions(width, height);
    if (contents[24] > 8) throw new Error('暂不支持重采样高位深平铺图片。');
    const metadata: Buffer[] = [];
    for (let offset = 8; offset + 12 <= contents.length;) {
        const end = offset + 12 + contents.readUInt32BE(offset);
        if (end > contents.length) break;
        const type = contents.toString('ascii', offset + 4, offset + 8);
        if (['acTL', 'fcTL', 'fdAT', 'sBIT'].includes(type)) throw new Error('暂不支持重采样动画或特殊位深平铺图片。');
        if (COLOR_CHUNKS.has(type)) metadata.push(contents.subarray(offset, end));
        if (type === 'IEND') return { width, height, metadata };
        offset = end;
    }
    throw new Error('平铺 PNG 数据不完整。');
}

/** Creator supplies Electron for JPEG/WebP/BMP/static GIF decoding. */
function decodeToPng(contents: Buffer): Buffer {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(contents);
    if (image.isEmpty()) throw new Error('无法解码平铺源图片。');
    const { width, height } = image.getSize();
    dimensions(width, height);
    return image.toPNG();
}

type Sample = { index: number; weight: number };
function samples(source: number, target: number): Sample[][] {
    const ratio = source / target;
    return Array.from({ length: target }, (_, out) => {
        if (ratio >= 1) {
            // Area averaging avoids aliasing when reducing the repeated texture.
            const start = out * ratio, end = (out + 1) * ratio;
            const result: Sample[] = [];
            for (let i = Math.floor(start); i < Math.ceil(end); i++) {
                const weight = (Math.min(end, i + 1) - Math.max(start, i)) / ratio;
                if (weight > 0) result.push({ index: Math.min(source - 1, i), weight });
            }
            return result;
        }
        // Upsampling uses periodic edges, not clamping: this image is a tile.
        const center = (out + 0.5) * ratio - 0.5;
        const left = Math.floor(center), fraction = center - left;
        return [{ index: (left + source) % source, weight: 1 - fraction },
            { index: (left + 1) % source, weight: fraction }];
    });
}

/** Bake display size into PNG pixels, never into the Scene node's Scale.
 * Source-node exports may already include a render scale; undo that factor once.
 * Fractional dimensions round to nearest whole pixel (minimum one).
 */
export function rasterizeTile(contents: Buffer, requestedScale: number, sourceRenderScale = 1,
    decode: (data: Buffer) => Buffer = decodeToPng): TiledRaster {
    positiveScale(requestedScale);
    positiveScale(sourceRenderScale);
    if (!contents.length || contents.length > MAX_BYTES) throw new Error('平铺源图片为空或超过 64 MB。');
    const png = contents.subarray(0, 8).equals(SIGNATURE) ? contents : decode(contents);
    const header = inspect(png);
    const desiredWidth = header.width * requestedScale / sourceRenderScale;
    const desiredHeight = header.height * requestedScale / sourceRenderScale;
    const width = Math.max(1, Math.round(desiredWidth)), height = Math.max(1, Math.round(desiredHeight));
    dimensions(width, height);
    const info = { sourceWidth: header.width, sourceHeight: header.height, width, height,
        rounded: Math.abs(width - desiredWidth) > 1e-6 || Math.abs(height - desiredHeight) > 1e-6 };
    const input = PNG.sync.read(png, { checkCRC: true });
    if (width === header.width && height === header.height) return { ...info, contents: png };
    const output = new PNG({ width, height });
    const xs = samples(header.width, width), ys = samples(header.height, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let alpha = 0, red = 0, green = 0, blue = 0;
        for (const sy of ys[y]) for (const sx of xs[x]) {
            const pos = (sy.index * header.width + sx.index) * 4;
            const a = input.data[pos + 3] * sy.weight * sx.weight;
            alpha += a;
            red += input.data[pos] * a; green += input.data[pos + 1] * a; blue += input.data[pos + 2] * a;
        }
        const pos = (y * width + x) * 4;
        // Premultiplied-alpha sampling prevents transparent RGB from adding fringes.
        output.data[pos + 3] = Math.round(alpha);
        if (alpha > 0) {
            output.data[pos] = Math.round(red / alpha);
            output.data[pos + 1] = Math.round(green / alpha);
            output.data[pos + 2] = Math.round(blue / alpha);
        }
    }
    const encoded = PNG.sync.write(output);
    return { ...info, contents: header.metadata.length
        ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded };
}
