import type {
    DocumentSession,
    FigmaColor,
    FigmaEffect,
    FigmaNode,
    FigmaPaint,
    FigmaTextStyle,
    Rect,
} from '../types';
import { analyzeTree } from './analyzer';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
    return value && typeof value === 'object' ? value as UnknownRecord : {};
}

function numberValue(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function parseRect(value: unknown): Rect | undefined {
    const input = record(value);
    const width = numberValue(input.width, Number.NaN);
    const height = numberValue(input.height, Number.NaN);
    const x = numberValue(input.x, Number.NaN);
    const y = numberValue(input.y, Number.NaN);
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
        return undefined;
    }
    return { x, y, width, height };
}

function parseColor(value: unknown): FigmaColor | undefined {
    const input = record(value);
    if (!['r', 'g', 'b'].every((key) => typeof input[key] === 'number')) {
        return undefined;
    }
    return {
        r: Math.max(0, Math.min(1, numberValue(input.r))),
        g: Math.max(0, Math.min(1, numberValue(input.g))),
        b: Math.max(0, Math.min(1, numberValue(input.b))),
        a: Math.max(0, Math.min(1, numberValue(input.a, 1))),
    };
}

function parsePaint(value: unknown): FigmaPaint {
    const input = record(value);
    return {
        type: stringValue(input.type, 'SOLID'),
        visible: booleanValue(input.visible, true),
        opacity: Math.max(0, Math.min(1, numberValue(input.opacity, 1))),
        color: parseColor(input.color),
        imageRef: stringValue(input.imageRef) || undefined,
        scaleMode: stringValue(input.scaleMode) || undefined,
        gradientHandlePositions: arrayValue(input.gradientHandlePositions).map((item) => {
            const point = record(item);
            return { x: numberValue(point.x), y: numberValue(point.y) };
        }),
        gradientStops: arrayValue(input.gradientStops).map((item) => {
            const stop = record(item);
            return {
                position: Math.max(0, Math.min(1, numberValue(stop.position))),
                color: parseColor(stop.color) ?? { r: 0, g: 0, b: 0, a: 1 },
            };
        }).sort((left, right) => left.position - right.position),
    };
}

function parseEffect(value: unknown): FigmaEffect {
    const input = record(value);
    const offset = record(input.offset);
    return {
        type: stringValue(input.type),
        visible: booleanValue(input.visible, true),
        radius: numberValue(input.radius),
        spread: numberValue(input.spread),
        offset: { x: numberValue(offset.x), y: numberValue(offset.y) },
        color: parseColor(input.color),
    };
}

function parseTextStyle(value: unknown): FigmaTextStyle {
    const input = record(value);
    return {
        fontFamily: stringValue(input.fontFamily) || undefined,
        fontPostScriptName: stringValue(input.fontPostScriptName) || undefined,
        fontWeight: numberValue(input.fontWeight, 400),
        fontSize: numberValue(input.fontSize, 16),
        textAlignHorizontal: stringValue(input.textAlignHorizontal, 'LEFT'),
        textAlignVertical: stringValue(input.textAlignVertical, 'TOP'),
        letterSpacing: numberValue(input.letterSpacing),
        lineHeightPx: numberValue(input.lineHeightPx, numberValue(input.fontSize, 16) * 1.2),
        textAutoResize: stringValue(input.textAutoResize, 'NONE'),
        textTruncation: stringValue(input.textTruncation, 'DISABLED'),
        maxLines: numberValue(input.maxLines),
    };
}

export function parseNode(value: unknown): FigmaNode | null {
    const input = record(value);
    const id = stringValue(input.id);
    if (!id) {
        return null;
    }

    const constraints = record(input.constraints);
    const relativeTransform = arrayValue(input.relativeTransform)
        .map((row) => arrayValue(row).map((part) => numberValue(part)));
    const cornerRadii = arrayValue(input.rectangleCornerRadii).map((part) => numberValue(part));

    return {
        id,
        name: stringValue(input.name, 'Figma Node'),
        type: stringValue(input.type, 'FRAME'),
        visible: booleanValue(input.visible, true),
        children: arrayValue(input.children)
            .map(parseNode)
            .filter((child): child is FigmaNode => child !== null),
        absoluteBoundingBox: parseRect(input.absoluteBoundingBox),
        absoluteRenderBounds: parseRect(input.absoluteRenderBounds),
        relativeTransform: relativeTransform.length === 2 ? relativeTransform : undefined,
        rotation: numberValue(input.rotation),
        opacity: Math.max(0, Math.min(1, numberValue(input.opacity, 1))),
        blendMode: stringValue(input.blendMode) || undefined,
        clipsContent: booleanValue(input.clipsContent, false),
        cornerRadius: typeof input.cornerRadius === 'number' ? numberValue(input.cornerRadius) : undefined,
        rectangleCornerRadii: cornerRadii.length === 4 ? cornerRadii : undefined,
        fills: arrayValue(input.fills).map(parsePaint),
        strokes: arrayValue(input.strokes).map(parsePaint),
        strokeWeight: Math.max(0, numberValue(input.strokeWeight)),
        strokeAlign: stringValue(input.strokeAlign) || undefined,
        effects: arrayValue(input.effects).map(parseEffect),
        characters: typeof input.characters === 'string' ? input.characters : undefined,
        style: input.style ? parseTextStyle(input.style) : undefined,
        layoutMode: stringValue(input.layoutMode) || undefined,
        layoutWrap: stringValue(input.layoutWrap) || undefined,
        layoutPositioning: stringValue(input.layoutPositioning) || undefined,
        primaryAxisAlignItems: stringValue(input.primaryAxisAlignItems) || undefined,
        counterAxisAlignItems: stringValue(input.counterAxisAlignItems) || undefined,
        primaryAxisSizingMode: stringValue(input.primaryAxisSizingMode) || undefined,
        counterAxisSizingMode: stringValue(input.counterAxisSizingMode) || undefined,
        itemSpacing: numberValue(input.itemSpacing),
        counterAxisSpacing: numberValue(input.counterAxisSpacing),
        paddingLeft: numberValue(input.paddingLeft),
        paddingRight: numberValue(input.paddingRight),
        paddingTop: numberValue(input.paddingTop),
        paddingBottom: numberValue(input.paddingBottom),
        overflowDirection: stringValue(input.overflowDirection) || undefined,
        constraints: Object.keys(constraints).length ? {
            horizontal: stringValue(constraints.horizontal) || undefined,
            vertical: stringValue(constraints.vertical) || undefined,
        } : undefined,
    };
}

function collect(roots: FigmaNode[]): { nodeById: Map<string, FigmaNode>; fonts: string[] } {
    const nodeById = new Map<string, FigmaNode>();
    const fonts = new Set<string>();
    const visit = (node: FigmaNode) => {
        nodeById.set(node.id, node);
        if (node.style?.fontFamily) {
            fonts.add(node.style.fontFamily);
        }
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return { nodeById, fonts: [...fonts].sort((a, b) => a.localeCompare(b)) };
}

export function parseDocument(
    payload: Record<string, unknown>,
    sourceUrl: string,
    fileKey: string,
    requestedNodeId?: string,
): DocumentSession {
    let roots: FigmaNode[] = [];
    let fileName = stringValue(payload.name, 'Figma Document');

    const nodes = record(payload.nodes);
    if (requestedNodeId && Object.keys(nodes).length) {
        const entry = record(nodes[requestedNodeId] ?? Object.values(nodes)[0]);
        const documentNode = parseNode(entry.document);
        if (documentNode) {
            roots = [documentNode];
        }
        fileName = stringValue(entry.name, fileName);
    } else {
        const document = record(payload.document);
        roots = arrayValue(document.children)
            .map(parseNode)
            .filter((node): node is FigmaNode => node !== null);
    }

    if (!roots.length) {
        throw new Error('Figma 文件中没有可导入的节点。');
    }
    const collected = collect(roots);
    return {
        fileKey,
        fileName,
        sourceUrl,
        roots,
        nodeById: collected.nodeById,
        tree: analyzeTree(roots),
        fonts: collected.fonts,
    };
}
