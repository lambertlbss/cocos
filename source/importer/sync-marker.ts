import type { FigmaEffect, FigmaNode, FigmaPaint, FigmaTextStyle, Rect, SyncMarkerSpec } from '../types';
import { analyzeSliceGrid } from '../figma/slicing';
import { canonicalStringify, quantizeDecimal, sha256 } from '../roundtrip/canonical-json';

/**
 * 组件级双边同步（Component Sync）的标记协议。
 *
 * 标记组件 `FigmaSyncNode` 挂在每个由同步模式生成的 Cocos 节点上，
 * 既提供可见身份（Figma 节点 id），也保存上次导入时的视觉/子树指纹，
 * 使重新导入能在不打开 Prefab 的情况下判断"设计改了什么"。
 *
 * 安全边界：file key 只以 SHA-256 形式保存；node id 按需求明文保存，
 * 与 Project Profile 中 nodeMaps / nodeOverrides 的既有明文一致。
 */
export const SYNC_MARKER_SCHEMA = 1 as const;
export const SYNC_MARKER_CLASS = 'FigmaSyncNode';
export const SYNC_MARKER_FOLDER = 'figma-importer-runtime';
export const SYNC_MARKER_FILE = 'FigmaSyncNode.ts';
export const SYNC_MARKER_SCRIPT_URL = `db://assets/${SYNC_MARKER_FOLDER}/${SYNC_MARKER_FILE}`;
export const SYNC_MARKER_CATEGORY = 'Figma Importer';

/** 标记组件在 Prefab 中保存的字段。 */
export interface SyncMarkerComponentValues {
    figmaMarkerSchema: number;
    figmaFileHash: string;
    figmaNodeId: string;
    figmaAliasNodeIds: string;
    figmaAliasHash: string;
    figmaVisualHash: string;
    figmaPixelHash: string;
    figmaSubtreeHash: string;
}

export type { SyncMarkerSpec } from '../types';

export interface SyncMarkerInput {
    fileKey: string;
    node: FigmaNode;
    /** 被折叠吸收的子层 id（不含 node 自身）。 */
    aliasNodeIds?: string[];
    schema?: number;
}

export interface SyncMarkerComparison {
    /** 本节点的几何、显隐、外观、文字或组件类型发生变化。 */
    visualChanged: boolean;
    /** 像素内容变化（不含页面坐标，含整棵子树）；旧标记缺字段时按子树变化推断。 */
    pixelChanged: boolean;
    /** Figma 子树内任意后代发生变化（含新增/删除/同名替换）。 */
    subtreeChanged: boolean;
    /** 折叠子层集合发生变化（子层新增、删除或被替换）。 */
    structureChanged: boolean;
    /** 需要重新生成图片资源才能反映设计变化。 */
    assetStale: boolean;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function normalizeSyncNodeId(value: string): string {
    return value.trim().replace(/-/g, ':');
}

function finiteOrNull(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? quantizeDecimal(value, 4) : null;
}

function framePayload(frame: Rect | undefined): number[] | null {
    if (!frame) {
        return null;
    }
    return [
        finiteOrNull(frame.x) ?? 0,
        finiteOrNull(frame.y) ?? 0,
        finiteOrNull(frame.width) ?? 0,
        finiteOrNull(frame.height) ?? 0,
    ];
}

function paintPayload(paint: FigmaPaint): Record<string, unknown> {
    return {
        type: paint.type,
        visible: paint.visible !== false,
        opacity: finiteOrNull(paint.opacity ?? 1),
        blendMode: paint.blendMode ?? null,
        color: paint.color
            ? {
                r: finiteOrNull(paint.color.r),
                g: finiteOrNull(paint.color.g),
                b: finiteOrNull(paint.color.b),
                a: finiteOrNull(paint.color.a ?? 1),
            }
            : null,
        imageRef: paint.imageRef ?? null,
        scaleMode: paint.scaleMode ?? null,
        rotation: finiteOrNull(paint.rotation),
        sourceNodeId: paint.sourceNodeId ?? null,
        tileType: paint.tileType ?? null,
        scalingFactor: finiteOrNull(paint.scalingFactor),
        spacing: paint.spacing
            ? [finiteOrNull(paint.spacing.x), finiteOrNull(paint.spacing.y)]
            : null,
        horizontalAlignment: paint.horizontalAlignment ?? null,
        verticalAlignment: paint.verticalAlignment ?? null,
        gradientHandlePositions: Array.isArray(paint.gradientHandlePositions)
            ? paint.gradientHandlePositions.map((handle) => [finiteOrNull(handle.x), finiteOrNull(handle.y)])
            : null,
        gradientStops: Array.isArray(paint.gradientStops)
            ? paint.gradientStops.map((stop) => [finiteOrNull(stop.position), stop.color
                ? {
                    r: finiteOrNull(stop.color.r),
                    g: finiteOrNull(stop.color.g),
                    b: finiteOrNull(stop.color.b),
                    a: finiteOrNull(stop.color.a ?? 1),
                }
                : null])
            : null,
        // 图片裁切矩阵与滤镜同样改变像素，但不会改变 imageRef；漏掉它们会让
        // 整层节点在重导入后继续显示旧图。
        imageTransform: Array.isArray(paint.imageTransform)
            ? paint.imageTransform.map((row) => (Array.isArray(row)
                ? row.map((value) => finiteOrNull(value))
                : null))
            : null,
        filters: paint.filters
            ? Object.fromEntries(Object.entries(paint.filters)
                .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
                .map(([key, value]) => [key, finiteOrNull(value)]))
            : null,
    };
}

function effectPayload(effect: FigmaEffect): Record<string, unknown> {
    return {
        type: effect.type,
        visible: effect.visible !== false,
        radius: finiteOrNull(effect.radius),
        spread: finiteOrNull(effect.spread),
        offsetX: finiteOrNull(effect.offset?.x),
        offsetY: finiteOrNull(effect.offset?.y),
        color: effect.color
            ? {
                r: finiteOrNull(effect.color.r),
                g: finiteOrNull(effect.color.g),
                b: finiteOrNull(effect.color.b),
                a: finiteOrNull(effect.color.a ?? 1),
            }
            : null,
    };
}

function textPayload(style: FigmaTextStyle | undefined): Record<string, unknown> | null {
    if (!style) {
        return null;
    }
    return {
        fontFamily: style.fontFamily ?? null,
        fontPostScriptName: style.fontPostScriptName ?? null,
        fontWeight: finiteOrNull(style.fontWeight),
        fontSize: finiteOrNull(style.fontSize),
        textAlignHorizontal: style.textAlignHorizontal ?? null,
        textAlignVertical: style.textAlignVertical ?? null,
        letterSpacing: finiteOrNull(style.letterSpacing),
        lineHeightPx: finiteOrNull(style.lineHeightPx),
        textAutoResize: style.textAutoResize ?? null,
        textTruncation: style.textTruncation ?? null,
        maxLines: finiteOrNull(style.maxLines),
    };
}

/**
 * 本节点自身的视觉贡献：几何、显隐、填充/描边/特效、圆角、文字与样式。
 * 不包含子节点，因此折叠父节点的指纹不会因子层移动而变化。
 */
export function syncVisualPayload(node: FigmaNode): Record<string, unknown> {
    return {
        id: normalizeSyncNodeId(node.id),
        type: node.type,
        frame: framePayload(node.absoluteBoundingBox),
        renderBounds: framePayload(node.absoluteRenderBounds),
        size: node.size
            ? [finiteOrNull(node.size.width), finiteOrNull(node.size.height)]
            : null,
        rotation: finiteOrNull(node.rotation),
        visible: node.visible !== false,
        opacity: finiteOrNull(node.opacity ?? 1),
        blendMode: node.blendMode ?? null,
        clipsContent: node.clipsContent === true,
        cornerRadius: finiteOrNull(node.cornerRadius),
        rectangleCornerRadii: Array.isArray(node.rectangleCornerRadii)
            ? node.rectangleCornerRadii.map((radius) => finiteOrNull(radius))
            : null,
        // 圆弧的起止角与内半径只改像素，不改外框；不纳入指纹会漏掉整层节点的新形状。
        arcData: node.arcData
            ? {
                startingAngle: finiteOrNull(node.arcData.startingAngle),
                endingAngle: finiteOrNull(node.arcData.endingAngle),
                innerRadius: finiteOrNull(node.arcData.innerRadius),
            }
            : null,
        fills: (node.fills ?? []).map(paintPayload),
        strokes: (node.strokes ?? []).map(paintPayload),
        strokeWeight: finiteOrNull(node.strokeWeight),
        strokeAlign: node.strokeAlign ?? null,
        effects: (node.effects ?? []).map(effectPayload),
        characters: typeof node.characters === 'string' ? node.characters : null,
        textStyle: textPayload(node.style),
    };
}

/** 子树结构：本节点指纹 + 逐层子节点指纹，用于判断渲染型节点是否需要重新出图。 */
export function syncSubtreePayload(node: FigmaNode): Record<string, unknown> {
    return {
        visual: syncVisualPayload(node),
        children: (node.children ?? []).map((child) => syncSubtreePayload(child)),
    };
}

export function syncVisualHash(node: FigmaNode): string {
    return sha256(canonicalStringify(syncVisualPayload(node)));
}

/**
 * 只保留影响像素的属性：坐标改为相对本节点原点的偏移，并递归包含整棵子树。
 * - 整个节点在页面里移动：所有相对坐标不变 → 像素指纹不变；
 * - 子层在节点内部移动：相对坐标改变 → 像素指纹改变；
 * - 尺寸、旋转、外观、文字与任何后代变化都计入。
 */
export function syncPixelPayload(
    node: FigmaNode,
    origin?: { x: number; y: number },
    root = true,
    stripGeometry = false,
    stripScale?: { width: number; height: number },
): Record<string, unknown> {
    const visual = syncVisualPayload(node);
    const box = node.absoluteBoundingBox;
    const base = origin ?? { x: box?.x ?? 0, y: box?.y ?? 0 };
    const relative = (frame: number[] | null): number[] | null => (frame
        ? [
            quantizeDecimal(frame[0] - base.x, 4),
            quantizeDecimal(frame[1] - base.y, 4),
            frame[2],
            frame[3],
        ]
        : null);
    // 纯图片节点，或"只包着一张同框图片"的包装层：位图可以被 Sprite 直接拉伸，
    // 尺寸变化不改变像素内容，因此整条链的几何都不参与像素指纹。
    // 其他情况（有圆角/描边/特效、或图片不满框）仍按原规则计算。
    const strip = stripGeometry || (root && isStretchableImage(node));
    const scale = stripScale ?? (strip && box && box.width > 0 && box.height > 0
        ? { width: box.width, height: box.height }
        : undefined);
    // Figma 的 Scale 工具在缩放图片节点时会改写填充里的裁切矩阵。按节点尺寸归一化后，
    // 等比/按轴缩放不再算变化；真正的裁切调整仍然会改变指纹。
    const visualFills = scale
        ? {
            ...visual,
            fills: (visual.fills as Array<Record<string, unknown>>).map((fill) =>
                normalizePaintScale(fill, scale)),
            strokes: (visual.strokes as Array<Record<string, unknown>>).map((fill) =>
                normalizePaintScale(fill, scale)),
        }
        : visual;
    return {
        ...visualFills,
        size: strip ? null : visualFills.size,
        rotation: strip ? null : visualFills.rotation,
        frame: strip ? null : relative(visualFills.frame as number[] | null),
        renderBounds: strip ? null : relative(visualFills.renderBounds as number[] | null),
        children: (node.children ?? []).map((child) => syncPixelPayload(child, base, false, strip, scale)),
    };
}

/** 把图片裁切矩阵按节点尺寸归一化，使等比缩放不改变结果。 */
function normalizePaintScale(
    fill: Record<string, unknown>,
    scale: { width: number; height: number },
): Record<string, unknown> {
    const transform = fill.imageTransform;
    if (!Array.isArray(transform) || transform.length !== 2) {
        return fill;
    }
    const scaled = transform.map((row, rowIndex) => (Array.isArray(row)
        ? row.map((value) => (typeof value === 'number' && Number.isFinite(value)
            ? quantizeDecimal(value / (rowIndex === 0 ? scale.width : scale.height), 4)
            : value))
        : row));
    return { ...fill, imageTransform: scaled };
}

function framesEqual(left: Rect | undefined, right: Rect | undefined): boolean {
    if (!left || !right) {
        return false;
    }
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
    return near(left.x, right.x) && near(left.y, right.y)
        && near(left.width, right.width) && near(left.height, right.height);
}

function hasOwnVisual(node: FigmaNode): boolean {
    if ((node.fills ?? []).some((fill) => fill.visible !== false)) {
        return true;
    }
    if ((node.strokes ?? []).some((stroke) => stroke.visible !== false)) {
        return true;
    }
    if ((node.effects ?? []).some((effect) => effect.visible !== false)) {
        return true;
    }
    if ((node.cornerRadius ?? 0) > 0) {
        return true;
    }
    return (node.rectangleCornerRadii ?? []).some((radius) => radius > 0);
}

/**
 * 可被 Sprite 直接拉伸的图片结构：
 * - 自身就是纯图片节点；或
 * - 自身没有任何填充/描边/特效/圆角，只包着一层或多层空容器，
 *   最内层是纯图片节点，且与最外层完全同框（这正是单图片折叠的形态）。
 */
export function isStretchableImage(node: FigmaNode): boolean {
    // 三/九宫节点：拉伸由 Cocos 的 SLICED Sprite 完成，尺寸变化不需要重新出图。
    // 只认几何识别通过的结构，命名像切片但几何不成立的节点仍按普通图片处理。
    if (analyzeSliceGrid(node)) {
        return true;
    }
    if (isPlainImageNode(node)) {
        return true;
    }
    const rootBox = node.absoluteBoundingBox;
    if (!rootBox || hasOwnVisual(node)) {
        return false;
    }
    let current: FigmaNode = node;
    for (let depth = 0; depth < 8; depth += 1) {
        const children = current.children ?? [];
        if (!children.length) {
            return false;
        }
        if (children.length > 1) {
            return false;
        }
        const child = children[0];
        if (isPlainImageNode(child)) {
            return framesEqual(rootBox, child.absoluteBoundingBox);
        }
        if (hasOwnVisual(child) || child.arcData || child.clipsContent) {
            return false;
        }
        current = child;
    }
    return false;
}

/**
 * 纯图片节点：单个可见 IMAGE 填充、无描边/特效/圆角/裁剪/圆弧、无子层。
 * 这类节点的位图可以被 Sprite 直接拉伸，改变尺寸或旋转不需要重新出图。
 */
export function isPlainImageNode(node: FigmaNode): boolean {
    if (node.children?.length) {
        return false;
    }
    if (node.clipsContent || node.arcData) {
        return false;
    }
    if ((node.cornerRadius ?? 0) > 0 || (node.rectangleCornerRadii ?? []).some((radius) => radius > 0)) {
        return false;
    }
    if ((node.strokes ?? []).some((stroke) => stroke.visible !== false)) {
        return false;
    }
    if ((node.effects ?? []).some((effect) => effect.visible !== false)) {
        return false;
    }
    const visibleFills = (node.fills ?? []).filter((fill) => fill.visible !== false);
    return visibleFills.length === 1
        && visibleFills[0].type === 'IMAGE'
        && Boolean(visibleFills[0].imageRef);
}

export function syncPixelHash(node: FigmaNode): string {
    return sha256(canonicalStringify(syncPixelPayload(node)));
}

export function syncSubtreeHash(node: FigmaNode): string {
    return sha256(canonicalStringify(syncSubtreePayload(node)));
}

export function syncAliasHash(aliasNodeIds: readonly string[]): string {
    const ids = [...new Set(aliasNodeIds.map(normalizeSyncNodeId).filter(Boolean))].sort();
    return sha256(canonicalStringify(ids));
}

export function syncFileHash(fileKey: string): string {
    const normalized = fileKey.trim();
    if (!normalized) {
        throw new Error('组件同步缺少 Figma file key。');
    }
    return sha256(`figma-importer:sync-file:v1\0${normalized}`);
}

export function createSyncMarker(input: SyncMarkerInput): SyncMarkerSpec {
    const nodeId = normalizeSyncNodeId(input.node.id);
    if (!nodeId) {
        throw new Error('组件同步节点缺少 Figma 节点 id。');
    }
    const aliasNodeIds = [...new Set((input.aliasNodeIds ?? [])
        .map(normalizeSyncNodeId)
        .filter((id) => Boolean(id) && id !== nodeId))].sort();
    return {
        schema: input.schema ?? SYNC_MARKER_SCHEMA,
        figmaFileHash: syncFileHash(input.fileKey),
        figmaNodeId: nodeId,
        aliasNodeIds,
        aliasHash: syncAliasHash(aliasNodeIds),
        visualHash: syncVisualHash(input.node),
        pixelHash: syncPixelHash(input.node),
        subtreeHash: syncSubtreeHash(input.node),
    };
}

export function compareSyncMarker(
    previous: SyncMarkerSpec,
    next: SyncMarkerSpec,
): SyncMarkerComparison {
    const visualChanged = previous.visualHash !== next.visualHash;
    const subtreeChanged = previous.subtreeHash !== next.subtreeHash;
    const structureChanged = previous.aliasHash !== next.aliasHash
        || previous.aliasNodeIds.join(',') !== next.aliasNodeIds.join(',');
    const sourceChanged = previous.figmaFileHash !== next.figmaFileHash
        || previous.figmaNodeId !== next.figmaNodeId;
    // 像素是否变化：两边都有像素指纹时用它（不含页面坐标）；
    // 旧标记没有该字段时退回子树指纹，宁可多判一次过期，也不能漏掉真实改动。
    const pixelComparable = typeof previous.pixelHash === 'string'
        && typeof next.pixelHash === 'string';
    const pixelChanged = pixelComparable
        ? previous.pixelHash !== next.pixelHash
        : subtreeChanged;
    return {
        visualChanged,
        pixelChanged,
        subtreeChanged,
        structureChanged,
        // 只改位置不再要求重新出图；来源、像素或折叠结构变化才需要。
        assetStale: pixelChanged || structureChanged || sourceChanged,
    };
}

/** 判断一个不透明视觉节点（矢量/整层 PNG/折叠包装）是否需要重新生成图片。 */
export function syncNeedsAssetRefresh(options: {
    comparison: SyncMarkerComparison;
    /** 当前节点是否以 PNG 形式落地（整层 render、矢量、折叠 Sprite/Label）。 */
    rasterized: boolean;
}): boolean {
    if (!options.rasterized) {
        return false;
    }
    return options.comparison.assetStale;
}

export function markerToComponentValues(marker: SyncMarkerSpec): SyncMarkerComponentValues {
    return {
        figmaMarkerSchema: marker.schema,
        figmaFileHash: marker.figmaFileHash,
        figmaNodeId: marker.figmaNodeId,
        figmaAliasNodeIds: marker.aliasNodeIds.join(','),
        figmaAliasHash: marker.aliasHash,
        figmaVisualHash: marker.visualHash,
        figmaPixelHash: marker.pixelHash ?? '',
        figmaSubtreeHash: marker.subtreeHash,
    };
}

/**
 * 判断一个组件实例是否是本插件生成的同步标记。
 * 用于所有权判定：标记永远属于插件，不能算作"手工组件"阻止节点删除。
 * 按字段识别，不依赖脚本 UUID —— 脚本重新导入或 UUID 变化时仍然成立。
 */
export function isSyncMarkerComponentValue(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record.figmaMarkerSchema === SYNC_MARKER_SCHEMA
        && typeof record.figmaNodeId === 'string'
        && record.figmaNodeId.length > 0
        && typeof record.figmaVisualHash === 'string';
}

/** 从 Cocos 组件读回标记；字段缺失或损坏时返回 null，由调用方 fail-closed。 */export function markerFromComponentValues(
    values: Partial<SyncMarkerComponentValues> | null | undefined,
): SyncMarkerSpec | null {
    if (!values || typeof values !== 'object') {
        return null;
    }
    const schema = values.figmaMarkerSchema;
    if (schema !== SYNC_MARKER_SCHEMA) {
        return null;
    }
    const fileHash = values.figmaFileHash;
    const nodeId = typeof values.figmaNodeId === 'string' ? normalizeSyncNodeId(values.figmaNodeId) : '';
    const visualHash = values.figmaVisualHash;
    const subtreeHash = values.figmaSubtreeHash;
    if (typeof fileHash !== 'string' || !SHA256_PATTERN.test(fileHash)) {
        return null;
    }
    if (!nodeId || typeof visualHash !== 'string' || !SHA256_PATTERN.test(visualHash)) {
        return null;
    }
    if (typeof subtreeHash !== 'string' || !SHA256_PATTERN.test(subtreeHash)) {
        return null;
    }
    const aliasNodeIds = typeof values.figmaAliasNodeIds === 'string'
        ? values.figmaAliasNodeIds.split(',')
            .map((id) => normalizeSyncNodeId(id))
            .filter(Boolean)
            .sort()
        : [];
    const aliasHash = typeof values.figmaAliasHash === 'string' && SHA256_PATTERN.test(values.figmaAliasHash)
        ? values.figmaAliasHash
        : syncAliasHash(aliasNodeIds);
    return {
        schema,
        figmaFileHash: fileHash,
        figmaNodeId: nodeId,
        aliasNodeIds,
        aliasHash,
        visualHash,
        pixelHash: typeof values.figmaPixelHash === 'string' && SHA256_PATTERN.test(values.figmaPixelHash)
            ? values.figmaPixelHash
            : undefined,
        subtreeHash,
    };
}

/**
 * 一个 Figma 节点只能被一个 Cocos 节点声明（自己或作为别名）。
 * 折叠父子同时声明同源节点会让"改哪个节点"变得不可判定。
 */
export function assertUniqueSyncOwnership(markers: readonly SyncMarkerSpec[]): void {
    const owners = new Map<string, string>();
    for (const marker of markers) {
        for (const nodeId of [marker.figmaNodeId, ...marker.aliasNodeIds]) {
            const owner = owners.get(nodeId);
            if (owner && owner !== marker.figmaNodeId) {
                throw new Error(
                    `Figma 节点 ${nodeId} 同时被 ${owner} 和 ${marker.figmaNodeId} 声明，已拒绝生成同步标记。`,
                );
            }
            owners.set(nodeId, marker.figmaNodeId);
        }
    }
}

/** 需要在项目 assets 中生成的最小标记组件源码（无业务逻辑，只保存来源与指纹）。 */
export const SYNC_MARKER_SCRIPT_SOURCE = `import { _decorator, Component } from 'cc';

const { ccclass, property } = _decorator;

/**
 * Figma Importer 生成的同步标记。字段由插件维护，手工修改会导致下次同步被拒绝。
 * 删除本组件即表示该节点退出 Figma 同步：插件不会再移动、缩放或删除它。
 */
@ccclass('${SYNC_MARKER_CLASS}')
export class ${SYNC_MARKER_CLASS} extends Component {
    @property({ tooltip: '标记协议版本' })
    public figmaMarkerSchema: number = ${SYNC_MARKER_SCHEMA};

    @property({ tooltip: 'Figma 文件 key 的 SHA-256' })
    public figmaFileHash: string = '';

    @property({ tooltip: 'Figma 节点 id' })
    public figmaNodeId: string = '';

    @property({ tooltip: '被折叠到本节点的 Figma 子层 id，逗号分隔' })
    public figmaAliasNodeIds: string = '';

    @property({ tooltip: '折叠子层集合指纹' })
    public figmaAliasHash: string = '';

    @property({ tooltip: '本次导入时的节点视觉指纹' })
    public figmaVisualHash: string = '';

    @property({ tooltip: '本次导入时的像素指纹（不含页面坐标）' })
    public figmaPixelHash: string = '';

    @property({ tooltip: '本次导入时的子树指纹' })
    public figmaSubtreeHash: string = '';
}
`;

/** 验证生成到项目里的脚本没有被截断或被改成别的类。 */
export function isSyncMarkerScript(source: string): boolean {
    return typeof source === 'string'
        && source.includes(`@ccclass('${SYNC_MARKER_CLASS}')`)
        && source.includes(`class ${SYNC_MARKER_CLASS} extends Component`)
        && source.includes('figmaSubtreeHash');
}
