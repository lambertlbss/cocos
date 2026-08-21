import { PNG } from 'pngjs';
import type { FigmaNode, Rect } from '../types';
import type { SliceAnalysis, SliceBorders } from '../figma/slicing';

export interface CompactSliceResult {
    contents: Buffer;
    borders: SliceBorders;
}

interface SourceRect {
    origin: Rect;
    scaleX: number;
    scaleY: number;
}

interface Segment {
    start: number;
    size: number;
}

const EPSILON = 0.01;

function isAxisAligned(node: FigmaNode): boolean {
    if (Math.abs(node.rotation) > EPSILON) {
        return false;
    }
    const transform = node.relativeTransform;
    if (!transform || transform.length < 2 || transform[0].length < 2 || transform[1].length < 2) {
        return true;
    }
    return Math.abs(transform[0][1]) <= EPSILON && Math.abs(transform[1][0]) <= EPSILON;
}

function sourceRect(node: FigmaNode, image: PNG, requestedScale: number): SourceRect | null {
    const bounds = node.absoluteBoundingBox;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        return null;
    }
    const candidates = [bounds, node.absoluteRenderBounds]
        .filter((value): value is Rect => Boolean(value && value.width > 0 && value.height > 0));
    let best: SourceRect | null = null;
    let bestScore = Infinity;
    for (const origin of candidates) {
        const scaleX = image.width / origin.width;
        const scaleY = image.height / origin.height;
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
            continue;
        }
        // Figma may export absoluteRenderBounds when effects overflow. Prefer the
        // coordinate space whose pixel density matches the requested export scale.
        const score = Math.abs(scaleX - requestedScale) + Math.abs(scaleY - requestedScale)
            + Math.abs(scaleX - scaleY) * 0.25;
        if (score < bestScore) {
            best = { origin, scaleX, scaleY };
            bestScore = score;
        }
    }
    return best;
}

function pixelAt(value: number, origin: number, scale: number, limit: number): number | null {
    const pixel = Math.round((value - origin) * scale);
    return pixel > 0 && pixel < limit ? pixel : null;
}

function centerSegment(start: number, end: number, logicalScale: number): Segment | null {
    const span = end - start;
    // Keep two Figma logical pixels in the stretchable middle. At 2x export this
    // deliberately becomes four physical pixels, preserving source resolution.
    const keep = Math.max(1, Math.min(span, Math.round(2 * logicalScale)));
    if (span <= 0 || keep <= 0) {
        return null;
    }
    return { start: start + Math.floor((span - keep) / 2), size: keep };
}

function copy(source: PNG, target: PNG, sourceX: number, sourceY: number, targetX: number, targetY: number, width: number, height: number): void {
    for (let y = 0; y < height; y += 1) {
        const sourceOffset = ((sourceY + y) * source.width + sourceX) * 4;
        const targetOffset = ((targetY + y) * target.width + targetX) * 4;
        source.data.copy(target.data, targetOffset, sourceOffset, sourceOffset + width * 4);
    }
}

function compose(source: PNG, columns: Segment[], rows: Segment[]): PNG {
    const target = new PNG({
        width: columns.reduce((total, segment) => total + segment.size, 0),
        height: rows.reduce((total, segment) => total + segment.size, 0),
    });
    let targetY = 0;
    for (const row of rows) {
        let targetX = 0;
        for (const column of columns) {
            copy(source, target, column.start, row.start, targetX, targetY, column.size, row.size);
            targetX += column.size;
        }
        targetY += row.size;
    }
    return target;
}

/**
 * Rebuilds a complete Figma export into the smallest safe 3/9-slice texture.
 * The surrounding fixed pixels remain byte-for-byte unchanged; only the
 * stretchable middle is reduced to a two-logical-pixel strip/area.
 */
export function compactSlicePng(
    contents: Buffer,
    node: FigmaNode,
    analysis: SliceAnalysis,
    requestedScale: number,
): CompactSliceResult | null {
    if (!isAxisAligned(node) || !Number.isFinite(requestedScale) || requestedScale <= 0) {
        return null;
    }
    let source: PNG;
    try {
        source = PNG.sync.read(contents);
    } catch {
        return null;
    }
    const frame = node.absoluteBoundingBox;
    const pixels = frame && sourceRect(node, source, requestedScale);
    if (!frame || !pixels) {
        return null;
    }
    const leftEnd = analysis.mode === 'vertical'
        ? 0
        : pixelAt(frame.x + analysis.borders.left, pixels.origin.x, pixels.scaleX, source.width);
    const rightStart = analysis.mode === 'vertical'
        ? source.width
        : pixelAt(frame.x + frame.width - analysis.borders.right, pixels.origin.x, pixels.scaleX, source.width);
    const topEnd = analysis.mode === 'horizontal'
        ? 0
        : pixelAt(frame.y + analysis.borders.top, pixels.origin.y, pixels.scaleY, source.height);
    const bottomStart = analysis.mode === 'horizontal'
        ? source.height
        : pixelAt(frame.y + frame.height - analysis.borders.bottom, pixels.origin.y, pixels.scaleY, source.height);
    if (leftEnd === null || rightStart === null || topEnd === null || bottomStart === null) {
        return null;
    }
    const middleX = analysis.mode === 'vertical'
        ? null
        : centerSegment(leftEnd, rightStart, pixels.scaleX);
    const middleY = analysis.mode === 'horizontal'
        ? null
        : centerSegment(topEnd, bottomStart, pixels.scaleY);
    if ((analysis.mode !== 'vertical' && !middleX) || (analysis.mode !== 'horizontal' && !middleY)) {
        return null;
    }
    const columns = middleX
        ? [{ start: 0, size: leftEnd }, middleX, { start: rightStart, size: source.width - rightStart }]
        : [{ start: 0, size: source.width }];
    const rows = middleY
        ? [{ start: 0, size: topEnd }, middleY, { start: bottomStart, size: source.height - bottomStart }]
        : [{ start: 0, size: source.height }];
    if ([...columns, ...rows].some((segment) => segment.size <= 0)) {
        return null;
    }
    const output = compose(source, columns, rows);
    return {
        contents: PNG.sync.write(output),
        borders: {
            left: middleX ? columns[0].size : 0,
            right: middleX ? columns[2].size : 0,
            top: middleY ? rows[0].size : 0,
            bottom: middleY ? rows[2].size : 0,
        },
    };
}
