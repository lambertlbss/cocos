import type { FigmaColor, FigmaPaint } from '../types';
import { deflateSync } from 'zlib';

function byte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function color(value: FigmaColor): string {
    return `rgb(${byte(value.r)},${byte(value.g)},${byte(value.b)})`;
}

function alpha(value: FigmaColor, opacity = 1): string {
    return Math.max(0, Math.min(1, (value.a ?? 1) * opacity)).toFixed(4);
}

function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
    })[character]!);
}

export function gradientSvg(
    width: number,
    height: number,
    paint: FigmaPaint,
    radii: [number, number, number, number],
): string | null {
    const stops = paint.gradientStops ?? [];
    if (!paint.type.startsWith('GRADIENT_') || stops.length < 2 || width <= 0 || height <= 0) {
        return null;
    }
    const handles = paint.gradientHandlePositions ?? [];
    const stopMarkup = stops.map((stop) =>
        `<stop offset="${(stop.position * 100).toFixed(3)}%" stop-color="${escapeXml(color(stop.color))}" stop-opacity="${alpha(stop.color, paint.opacity ?? 1)}"/>`,
    ).join('');

    let definition: string;
    if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
        const center = handles[0] ?? { x: 0.5, y: 0.5 };
        const edge = handles[1] ?? { x: 1, y: 0.5 };
        const radius = Math.max(0.001, Math.hypot(edge.x - center.x, edge.y - center.y));
        definition = `<radialGradient id="g" cx="${center.x}" cy="${center.y}" r="${radius}">${stopMarkup}</radialGradient>`;
    } else {
        const start = handles[0] ?? { x: 0, y: 0.5 };
        const end = handles[1] ?? { x: 1, y: 0.5 };
        definition = `<linearGradient id="g" x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}">${stopMarkup}</linearGradient>`;
    }

    const radius = Math.max(0, Math.min(...radii));
    return [
        '<svg xmlns="http://www.w3.org/2000/svg"',
        ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<defs>${definition}</defs>`,
        `<rect width="${width}" height="${height}" rx="${radius}" fill="url(#g)"/>`,
        '</svg>',
    ].join('');
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const value of data) {
        crc ^= value;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.allocUnsafe(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
    return chunk;
}

function encodePng(width: number, height: number, pixels: Buffer): Buffer {
    const stride = width * 4;
    const scanlines = Buffer.allocUnsafe((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (stride + 1);
        scanlines[row] = 0;
        pixels.copy(scanlines, row + 1, y * stride, (y + 1) * stride);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function rasterSize(width: number, height: number, requestedScale: number): {
    width: number;
    height: number;
    scale: number;
} {
    const initialScale = Math.max(0.25, Math.min(4, requestedScale));
    const initialWidth = Math.max(1, Math.round(width * initialScale));
    const initialHeight = Math.max(1, Math.round(height * initialScale));
    const pixelLimit = 16_777_216;
    const reduction = Math.min(
        1,
        8192 / initialWidth,
        8192 / initialHeight,
        Math.sqrt(pixelLimit / (initialWidth * initialHeight)),
    );
    const pixelWidth = Math.max(1, Math.round(initialWidth * reduction));
    const pixelHeight = Math.max(1, Math.round(initialHeight * reduction));
    return {
        width: pixelWidth,
        height: pixelHeight,
        scale: Math.min(pixelWidth / width, pixelHeight / height),
    };
}

function gradientPosition(
    paint: FigmaPaint,
    x: number,
    y: number,
): number {
    const handles = paint.gradientHandlePositions ?? [];
    const center = handles[0] ?? { x: 0, y: 0.5 };
    const axisX = handles[1] ?? { x: 1, y: 0.5 };
    if (paint.type === 'GRADIENT_ANGULAR') {
        const start = Math.atan2(axisX.y - center.y, axisX.x - center.x);
        const angle = Math.atan2(y - center.y, x - center.x);
        return ((angle - start) / (Math.PI * 2) + 1) % 1;
    }
    if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
        const axisY = handles[2] ?? {
            x: center.x - (axisX.y - center.y),
            y: center.y + (axisX.x - center.x),
        };
        const xx = axisX.x - center.x;
        const xy = axisX.y - center.y;
        const yx = axisY.x - center.x;
        const yy = axisY.y - center.y;
        const determinant = xx * yy - xy * yx;
        if (Math.abs(determinant) < 0.000001) {
            const radius = Math.max(0.000001, Math.hypot(xx, xy));
            return Math.hypot(x - center.x, y - center.y) / radius;
        }
        const dx = x - center.x;
        const dy = y - center.y;
        const alongX = (dx * yy - dy * yx) / determinant;
        const alongY = (dy * xx - dx * xy) / determinant;
        return paint.type === 'GRADIENT_DIAMOND'
            ? Math.abs(alongX) + Math.abs(alongY)
            : Math.hypot(alongX, alongY);
    }
    const dx = axisX.x - center.x;
    const dy = axisX.y - center.y;
    const lengthSquared = dx * dx + dy * dy;
    return lengthSquared > 0.000001
        ? ((x - center.x) * dx + (y - center.y) * dy) / lengthSquared
        : 0;
}

type GradientStop = NonNullable<FigmaPaint['gradientStops']>[number];

function gradientColor(
    stops: GradientStop[],
    opacity: number,
    position: number,
): [number, number, number, number] {
    const value = Math.max(0, Math.min(1, position));
    if (value <= stops[0].position) {
        const color = stops[0].color;
        return [color.r, color.g, color.b, (color.a ?? 1) * opacity];
    }
    if (value >= stops[stops.length - 1].position) {
        const color = stops[stops.length - 1].color;
        return [color.r, color.g, color.b, (color.a ?? 1) * opacity];
    }
    let left = stops[0];
    let right = stops[stops.length - 1];
    for (let index = 1; index < stops.length; index += 1) {
        if (value <= stops[index].position) {
            left = stops[index - 1];
            right = stops[index];
            break;
        }
    }
    const distance = right.position - left.position;
    const amount = distance > 0 ? (value - left.position) / distance : 0;
    const mix = (start: number, end: number) => start + (end - start) * amount;
    return [
        mix(left.color.r, right.color.r),
        mix(left.color.g, right.color.g),
        mix(left.color.b, right.color.b),
        mix(left.color.a ?? 1, right.color.a ?? 1) * opacity,
    ];
}

function insideRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radii: [number, number, number, number],
): boolean {
    const [topLeft, topRight, bottomRight, bottomLeft] = radii;
    const withinCorner = (centerX: number, centerY: number, radius: number) =>
        radius <= 0 || ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2);
    if (x < topLeft && y < topLeft) {
        return withinCorner(topLeft, topLeft, topLeft);
    }
    if (x > width - topRight && y < topRight) {
        return withinCorner(width - topRight, topRight, topRight);
    }
    if (x > width - bottomRight && y > height - bottomRight) {
        return withinCorner(width - bottomRight, height - bottomRight, bottomRight);
    }
    if (x < bottomLeft && y > height - bottomLeft) {
        return withinCorner(bottomLeft, height - bottomLeft, bottomLeft);
    }
    return true;
}

export function gradientPng(
    width: number,
    height: number,
    paint: FigmaPaint,
    radii: [number, number, number, number],
    requestedScale: number,
): Buffer | null {
    const stops = [...(paint.gradientStops ?? [])]
        .sort((left, right) => left.position - right.position);
    if (!paint.type.startsWith('GRADIENT_') || stops.length < 2 || width <= 0 || height <= 0) {
        return null;
    }
    const size = rasterSize(width, height, requestedScale);
    const pixels = Buffer.alloc(size.width * size.height * 4);
    const pixelRadii = radii.map((radius) =>
        Math.max(0, Math.min(radius * size.scale, size.width / 2, size.height / 2)),
    ) as [number, number, number, number];
    for (let y = 0; y < size.height; y += 1) {
        for (let x = 0; x < size.width; x += 1) {
            const offset = (y * size.width + x) * 4;
            if (!insideRoundedRect(x + 0.5, y + 0.5, size.width, size.height, pixelRadii)) {
                pixels.fill(0, offset, offset + 4);
                continue;
            }
            const sampled = gradientColor(
                stops,
                paint.opacity ?? 1,
                gradientPosition(paint, (x + 0.5) / size.width, (y + 0.5) / size.height),
            );
            pixels[offset] = byte(sampled[0]);
            pixels[offset + 1] = byte(sampled[1]);
            pixels[offset + 2] = byte(sampled[2]);
            pixels[offset + 3] = byte(sampled[3]);
        }
    }
    return encodePng(size.width, size.height, pixels);
}
