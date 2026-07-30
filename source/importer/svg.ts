import type { FigmaColor, FigmaPaint } from '../types';

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
