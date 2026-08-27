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
    const horizontal = [...frames].sort((left, right) => left.x - right.x);
    if (horizontal.every((frame) => near(frame.y, parent.y)
        && near(frame.height, parent.height))
        && near(horizontal[0].x, parent.x)
        && near(horizontal[0].x + horizontal[0].width, horizontal[1].x)
        && near(horizontal[1].x + horizontal[1].width, horizontal[2].x)
        && near(horizontal[2].x + horizontal[2].width, parent.x + parent.width)) {
        if (horizontal[0].width + horizontal[2].width >= parent.width) {
            return null;
        }
        return {
            mode: 'horizontal',
            borders: {
                left: scaled(horizontal[0].width, scale),
                right: scaled(horizontal[2].width, scale),
                top: 0,
                bottom: 0,
            },
        };
    }
    const vertical = [...frames].sort((left, right) => left.y - right.y);
    if (vertical.every((frame) => near(frame.x, parent.x)
        && near(frame.width, parent.width))
        && near(vertical[0].y, parent.y)
        && near(vertical[0].y + vertical[0].height, vertical[1].y)
        && near(vertical[1].y + vertical[1].height, vertical[2].y)
        && near(vertical[2].y + vertical[2].height, parent.y + parent.height)) {
        if (vertical[0].height + vertical[2].height >= parent.height) {
            return null;
        }
        return {
            mode: 'vertical',
            borders: {
                left: 0,
                right: 0,
                top: scaled(vertical[0].height, scale),
                bottom: scaled(vertical[2].height, scale),
            },
        };
    }
    return null;
}

function assignCoordinateBands(
    frames: Rect[],
    coordinate: (frame: Rect) => number,
): number[] | null {
    const entries = frames
        .map((frame, index) => ({ index, value: coordinate(frame) }))
        .sort((left, right) => left.value - right.value);
    const assignments = new Array<number>(frames.length);
    let previousCenter: number | undefined;
    for (let band = 0; band < 3; band += 1) {
        const group = entries.slice(band * 3, band * 3 + 3);
        if (group.length !== 3
            || !group.every((entry) => near(entry.value, group[0].value))) {
            return null;
        }
        const center = group.reduce((sum, entry) => sum + entry.value, 0) / group.length;
        // Adjacent slice bands are allowed to be only 1 px apart. TOLERANCE
        // applies inside a band, not between bands.
        if (previousCenter !== undefined && center <= previousCenter) {
            return null;
        }
        for (const entry of group) {
            assignments[entry.index] = band;
        }
        previousCenter = center;
    }
    return assignments;
}

function analyzeNine(parent: Rect, frames: Rect[], scale: number): SliceAnalysis | null {
    const xBands = assignCoordinateBands(frames, (frame) => frame.x);
    const yBands = assignCoordinateBands(frames, (frame) => frame.y);
    if (!xBands || !yBands) {
        return null;
    }

    const grid: Array<Array<Rect | undefined>> = Array.from(
        { length: 3 },
        () => Array<Rect | undefined>(3),
    );
    for (let index = 0; index < frames.length; index += 1) {
        const row = yBands[index];
        const column = xBands[index];
        if (grid[row][column]) {
            return null;
        }
        grid[row][column] = frames[index];
    }
    if (grid.some((row) => row.some((frame) => !frame))) {
        return null;
    }

    const rows = grid as Rect[][];
    const columns = [0, 1, 2].map((column) => rows.map((row) => row[column]));
    const rowsAreContinuous = rows.every((row) =>
        row.every((frame) => near(frame.y, row[0].y) && near(frame.height, row[0].height))
        && near(row[0].x, parent.x)
        && near(row[0].x + row[0].width, row[1].x)
        && near(row[1].x + row[1].width, row[2].x)
        && near(row[2].x + row[2].width, parent.x + parent.width));
    const columnsAreContinuous = columns.every((column) =>
        column.every((frame) => near(frame.x, column[0].x) && near(frame.width, column[0].width))
        && near(column[0].y, parent.y)
        && near(column[0].y + column[0].height, column[1].y)
        && near(column[1].y + column[1].height, column[2].y)
        && near(column[2].y + column[2].height, parent.y + parent.height));
    if (!rowsAreContinuous || !columnsAreContinuous) {
        return null;
    }

    const leftColumn = columns[0];
    const rightColumn = columns[2];
    const topRow = rows[0];
    const bottomRow = rows[2];
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
