import { PNG } from 'pngjs';

export const JPEG_QUALITY = 95;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 16_000_000;

export function isPng(contents: Buffer): boolean {
    return contents.subarray(0, 8).equals(PNG_SIGNATURE);
}

function encodeJpeg(contents: Buffer): Buffer {
    // Creator supplies Electron; keep this lazy so CLI/module loading needs no GUI.
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(contents);
    if (image.isEmpty()) throw new Error('无法解码 PNG');
    return image.toJPEG(JPEG_QUALITY);
}

/** Never infer opacity merely from PNG color type: palette/tRNS also has alpha. */
export function prepareNewRaster(
    contents: Buffer, encode: (png: Buffer) => Buffer = encodeJpeg,
): { contents: Buffer; extension: 'png' | 'jpg' } {
    if (contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff) {
        return { contents, extension: 'jpg' };
    }
    if (!isPng(contents)) return { contents, extension: 'png' };
    try {
        if (contents.length < 33 || contents.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 头无效');
        const pixels = contents.readUInt32BE(16) * contents.readUInt32BE(20);
        if (!pixels || pixels > MAX_PIXELS) throw new Error('图片超过安全解码像素上限');
        // Decode 16-bit input without stripping low alpha bits before comparing.
        const image = PNG.sync.read(contents, { checkCRC: true, skipRescale: true });
        // pngjs typings omit palette (3) although its decoder supports it.
        const opaque = Number(image.colorType) === 3 ? 255 : Math.pow(2, image.depth) - 1;
        for (let i = 3; i < image.data.length; i += 4) {
            if (image.data[i] !== opaque) return { contents, extension: 'png' };
        }
        const jpeg = encode(contents);
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error('JPG 编码结果无效');
        return { contents: jpeg, extension: 'jpg' };
    } catch (error) {
        console.warn(`[Figma Importer] 无法安全转换 JPG，保留 PNG：${(error as Error).message}`);
        return { contents, extension: 'png' };
    }
}
