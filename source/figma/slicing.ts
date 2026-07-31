import type { FigmaNode, Rect } from '../types';

export interface SliceBorders {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export interface SliceAnalysis {
    mode: 'horizontal' | 'vertical' | 'nine';
    borders: SliceBorders;
}

const TOLERANCE = 2;

function near(left: number, right: number): boolean {
    return Math.abs(left - right) <= TOLERANCE;
}

function cluster(values: number[]): number[] {
    const result: number[] = [];
    for (const value of [...values].sort((left, right) => left - right)) {
        const current = result[result.length - 1];
        if (current === undefined || !near(current, value)) {
            result.push(value);
        }
    }
    return result;
}

function inside(parent: Rect, child: Rect): boolean {
    return child.width > 0
        && child.height > 0
        && child.x >= parent.x - TOLERANCE
        && child.y >= parent.y - TOLERANCE
        && child.x + child.width <= parent.x + parent.width + TOLERANCE
        && child.y + child.height <= parent.y + parent.height + TOLERANCE;
}

function coversOuterBounds(parent: Rect, frames: Rect[]): boolean {
    const left = Math.min(...frames.map((frame) => frame.x));
    const top = Math.min(...frames.map((frame) => frame.y));
    const right = Math.max(...frames.map((frame) => frame.x + frame.width));
    const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
    return near(left, parent.x)
        && near(top, parent.y)
        && near(right, parent.x + parent.width)
        && near(bottom, parent.y + parent.height);
}

function scaled(value: number, scale: number): number {
    return Math.max(0, value * scale);
}

function analyzeThree(parent: Rect, frames: Rect[], scale: number): SliceAnalysis | null {
    const xs = cluster(frames.map((frame) => frame.x));
    const ys = cluster(frames.map((frame) => frame.y));
    if (xs.length === 3 && ys.length === 1) {
        const sorted = [...frames].sort((left, right) => left.x - right.x);
        if (!sorted.every((frame) => near(frame.y, parent.y)
            && near(frame.height, parent.height))
            || !near(sorted[0].x + sorted[0].width, sorted[1].x)
            || !near(sorted[1].x + sorted[1].width, sorted[2].x)) {
            return null;
        }
        return {
            mode: 'horizontal',
            borders: {
                left: scaled(sorted[0].width, scale),
                right: scaled(sorted[2].width, scale),
                top: 0,
                bottom: 0,
            },
        };
    }
    if (xs.length === 1 && ys.length === 3) {
        const sorted = [...frames].sort((left, right) => left.y - right.y);
        if (!sorted.every((frame) => near(frame.x, parent.x)
            && near(frame.width, parent.width))
            || !near(sorted[0].y + sorted[0].height, sorted[1].y)
            || !near(sorted[1].y + sorted[1].height, sorted[2].y)) {
            return null;
        }
        return {
            mode: 'vertical',
            borders: {
                left: 0,
                right: 0,
                top: scaled(sorted[0].height, scale),
                bottom: scaled(sorted[2].height, scale),
            },
        };
    }
    return null;
}

function analyzeNine(parent: Rect, frames: Rect[], scale: number): SliceAnalysis | null {
    const xs = cluster(frames.map((frame) => frame.x));
    const ys = cluster(frames.map((frame) => frame.y));
    if (xs.length !== 3 || ys.length !== 3) {
        return null;
    }
    for (const y of ys) {
        for (const x of xs) {
            if (!frames.some((frame) => near(frame.x, x) && near(frame.y, y))) {
                return null;
            }
        }
    }
    const leftColumn = frames.filter((frame) => near(frame.x, xs[0]));
    const rightColumn = frames.filter((frame) => near(frame.x, xs[2]));
    const topRow = frames.filter((frame) => near(frame.y, ys[0]));
    const bottomRow = frames.filter((frame) => near(frame.y, ys[2]));
    if (leftColumn.length !== 3 || rightColumn.length !== 3
        || topRow.length !== 3 || bottomRow.length !== 3) {
        return null;
    }
    const left = Math.max(...leftColumn.map((frame) => frame.x + frame.width)) - parent.x;
    const right = parent.x + parent.width - Math.min(...rightColumn.map((frame) => frame.x));
    const top = Math.max(...topRow.map((frame) => frame.y + frame.height)) - parent.y;
    const bottom = parent.y + parent.height - Math.min(...bottomRow.map((frame) => frame.y));
    if (left <= 0 || right <= 0 || top <= 0 || bottom <= 0
        || left + right >= parent.width || top + bottom >= parent.height) {
        return null;
    }
    return {
        mode: 'nine',
        borders: {
            left: scaled(left, scale),
            right: scaled(right, scale),
            top: scaled(top, scale),
            bottom: scaled(bottom, scale),
        },
    };
}

export function analyzeSliceGrid(node: FigmaNode, scale = 1): SliceAnalysis | null {
    const parent = node.absoluteBoundingBox;
    const frames = node.children
        .filter((child) => child.visible !== false)
        .map((child) => child.absoluteBoundingBox)
        .filter((frame): frame is Rect => Boolean(frame));
    if (!parent || !Number.isFinite(scale) || scale <= 0
        || (frames.length !== 3 && frames.length !== 9)
        || !frames.every((frame) => inside(parent, frame))
        || !coversOuterBounds(parent, frames)) {
        return null;
    }
    return frames.length === 9
        ? analyzeNine(parent, frames, scale)
        : analyzeThree(parent, frames, scale);
}
