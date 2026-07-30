import { createHash } from 'crypto';
import packageJSON from '../package.json';
import { FigmaClient, CancelledError } from './figma/client';
import { inferAction, inferKind } from './figma/analyzer';
import { parseDocument } from './figma/parser';
import { parseFigmaSource } from './figma/url';
import { AssetWriter, resolveAssetUuid } from './importer/assets';
import { gradientSvg } from './importer/svg';
import { TokenVault } from './security/token-vault';
import {
    DEFAULT_SETTINGS,
    type DocumentSession,
    type FigmaNode,
    type ImportAction,
    type ImportOverride,
    type ImportRequest,
    type ImportSettings,
    type NodeKind,
    type ProgressEvent,
    type Rect,
    type SceneNodeSpec,
    type SpriteAssetSpec,
} from './types';

const vault = new TokenVault(packageJSON.name);
let activeDocument: DocumentSession | null = null;
let activeController: AbortController | null = null;
let settingsCache: ImportSettings | null = null;

interface Decision {
    action: ImportAction;
    kind: NodeKind;
    nineSlice: boolean;
}

interface SceneImportPayload {
    fileKey: string;
    rootName: string;
    rootFrame: Rect;
    scale: number;
    targetUuid?: string;
    updateExisting: boolean;
    existingMap: Record<string, string>;
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
}

function emitProgress(progress: ProgressEvent): void {
    Editor.Message.send(packageJSON.name, 'progress', progress);
}

function safeSettings(value: unknown): ImportSettings {
    const input = value && typeof value === 'object' ? value as Partial<ImportSettings> : {};
    const scale = typeof input.scale === 'number' && Number.isFinite(input.scale)
        ? Math.max(0.25, Math.min(4, input.scale))
        : DEFAULT_SETTINGS.scale;
    const fontMap = input.fontMap && typeof input.fontMap === 'object'
        ? Object.fromEntries(Object.entries(input.fontMap)
            .filter(([key, item]) => key.trim() && typeof item === 'string')
            .map(([key, item]) => [key.trim(), item.trim()]))
        : {};
    return {
        sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '',
        assetFolder: typeof input.assetFolder === 'string' && input.assetFolder.trim()
            ? input.assetFolder.trim()
            : DEFAULT_SETTINGS.assetFolder,
        scale,
        updateExisting: input.updateExisting !== false,
        refreshAssets: input.refreshAssets === true,
        autoSave: input.autoSave === true,
        useSelection: input.useSelection !== false,
        fontMap,
    };
}

async function getSettings(): Promise<ImportSettings> {
    if (settingsCache) {
        return settingsCache;
    }
    const saved = await Editor.Profile.getProject(packageJSON.name, 'settings', 'project');
    settingsCache = safeSettings(saved);
    return settingsCache;
}

async function saveSettings(value: unknown): Promise<ImportSettings> {
    settingsCache = safeSettings(value);
    await Editor.Profile.setProject(packageJSON.name, 'settings', settingsCache, 'project');
    return settingsCache;
}

async function client(): Promise<FigmaClient> {
    return new FigmaClient(await vault.get(), activeController?.signal);
}

function beginOperation(): void {
    activeController?.abort();
    activeController = new AbortController();
}

function finishOperation(): void {
    activeController = null;
}

function unionFrame(nodes: FigmaNode[]): Rect {
    const frames = nodes.map(nodeFrame).filter((value): value is Rect => Boolean(value));
    if (!frames.length) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }
    const x = Math.min(...frames.map((frame) => frame.x));
    const y = Math.min(...frames.map((frame) => frame.y));
    const right = Math.max(...frames.map((frame) => frame.x + frame.width));
    const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
    return { x, y, width: right - x, height: bottom - y };
}

function nodeFrame(node: FigmaNode): Rect {
    if (node.absoluteBoundingBox) {
        return node.absoluteBoundingBox;
    }
    if (node.children.length) {
        return unionFrame(node.children);
    }
    return { x: 0, y: 0, width: 0, height: 0 };
}

function cornerRadii(node: FigmaNode): [number, number, number, number] {
    if (node.rectangleCornerRadii?.length === 4) {
        return node.rectangleCornerRadii as [number, number, number, number];
    }
    const radius = node.cornerRadius ?? 0;
    return [radius, radius, radius, radius];
}

function defaultDecision(node: FigmaNode): Decision {
    return {
        action: inferAction(node),
        kind: inferKind(node),
        nineSlice: false,
    };
}

function decisionMap(overrides: ImportOverride[]): Map<string, Decision> {
    return new Map(overrides.map((item) => [item.id, {
        action: item.action,
        kind: item.kind,
        nineSlice: item.nineSlice,
    }]));
}

function collectAssetRequests(
    roots: FigmaNode[],
    decisions: Map<string, Decision>,
): { png: FigmaNode[]; svg: FigmaNode[]; gradients: FigmaNode[] } {
    const png: FigmaNode[] = [];
    const svg: FigmaNode[] = [];
    const gradients: FigmaNode[] = [];
    const visit = (node: FigmaNode) => {
        const decision = decisions.get(node.id) ?? defaultDecision(node);
        if (decision.action === 'ignore') {
            node.children.forEach(visit);
            return;
        }
        if (decision.nineSlice || decision.action === 'render' || decision.action === 'merge') {
            png.push(node);
            return;
        }
        if (decision.action === 'svg') {
            svg.push(node);
            return;
        }
        if (decision.action === 'generate') {
            const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
            if (fill) {
                gradients.push(node);
            }
        }
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return { png, svg, gradients };
}

function patchBorders(node: FigmaNode, scale: number): {
    left: number;
    right: number;
    top: number;
    bottom: number;
} | undefined {
    const parent = node.absoluteBoundingBox;
    const children = node.children.filter((child) => child.absoluteBoundingBox);
    if (!parent || (children.length !== 3 && children.length !== 9)) {
        return undefined;
    }
    const xs = children.map((child) => child.absoluteBoundingBox!).sort((left, right) => left.x - right.x);
    const ys = children.map((child) => child.absoluteBoundingBox!).sort((top, bottom) => top.y - bottom.y);
    const horizontal = children.length === 9 || Math.abs(xs[0].y - xs[1].y) < 2;
    const vertical = children.length === 9 || !horizontal;
    return {
        left: horizontal ? Math.max(1, (xs[0].x + xs[0].width - parent.x) * scale) : 0,
        right: horizontal
            ? Math.max(1, (parent.x + parent.width - xs[xs.length - 1].x) * scale)
            : 0,
        top: vertical ? Math.max(1, (ys[0].y + ys[0].height - parent.y) * scale) : 0,
        bottom: vertical
            ? Math.max(1, (parent.y + parent.height - ys[ys.length - 1].y) * scale)
            : 0,
    };
}

async function buildAssets(
    session: DocumentSession,
    decisions: Map<string, Decision>,
    importSettings: ImportSettings,
): Promise<Map<string, SpriteAssetSpec>> {
    const fileFolder = `file-${createHash('sha1').update(session.fileKey).digest('hex').slice(0, 10)}`;
    const writer = new AssetWriter(`${importSettings.assetFolder}/${fileFolder}`);
    await writer.initialize();
    const requests = collectAssetRequests(session.roots, decisions);
    const api = await client();
    const assets = new Map<string, SpriteAssetSpec>();
    const total = requests.png.length + requests.svg.length + requests.gradients.length;
    let completed = 0;

    const processRemote = async (nodes: FigmaNode[], format: 'png' | 'svg') => {
        if (!nodes.length) {
            return;
        }
        const urls = await api.getImageUrls(session.fileKey, nodes.map((node) => node.id), format, importSettings.scale);
        for (const node of nodes) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            const url = writer.buildUrl(node.name, node.id, format, importSettings.scale);
            const decision = decisions.get(node.id) ?? defaultDecision(node);
            const borders = decision.nineSlice && format === 'png'
                ? patchBorders(node, importSettings.scale)
                : undefined;
            let asset = !importSettings.refreshAssets ? await writer.existing(url) : null;
            if (!asset || borders) {
                const remoteUrl = urls[node.id];
                if (!remoteUrl) {
                    throw new Error(`Figma 未能渲染节点：${node.name}`);
                }
                asset = await writer.write(url, await api.download(remoteUrl), borders);
            }
            assets.set(node.id, asset);
            completed += 1;
            emitProgress({
                phase: 'assets',
                value: total ? completed / total : 1,
                message: `导入资源 ${completed}/${total} · ${node.name}`,
            });
        }
    };

    await processRemote(requests.png, 'png');
    await processRemote(requests.svg, 'svg');

    for (const node of requests.gradients) {
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const svg = frame && fill ? gradientSvg(frame.width, frame.height, fill, cornerRadii(node)) : null;
        if (svg) {
            const url = writer.buildUrl(`${node.name}_gradient`, `${node.id}:gradient`, 'svg', 1);
            const asset = !importSettings.refreshAssets
                ? await writer.existing(url) ?? await writer.write(url, svg)
                : await writer.write(url, svg);
            assets.set(node.id, asset);
        }
        completed += 1;
        emitProgress({
            phase: 'assets',
            value: total ? completed / total : 1,
            message: `生成渐变 ${completed}/${total} · ${node.name}`,
        });
    }
    return assets;
}

async function resolveFonts(settings: ImportSettings): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [family, url] of Object.entries(settings.fontMap)) {
        const uuid = await resolveAssetUuid(url);
        if (uuid) {
            result.set(family, uuid);
        }
    }
    return result;
}

function makeSpec(
    node: FigmaNode,
    parentFrame: Rect | undefined,
    decisions: Map<string, Decision>,
    assets: Map<string, SpriteAssetSpec>,
    fonts: Map<string, string>,
): SceneNodeSpec | null {
    const decision = decisions.get(node.id) ?? defaultDecision(node);
    if (decision.action === 'ignore') {
        return null;
    }
    const frame = nodeFrame(node);
    const resolvedKind = decision.kind === 'auto' ? inferKind(node) : decision.kind;
    const terminal = decision.nineSlice
        || decision.action === 'render'
        || decision.action === 'svg'
        || decision.action === 'merge'
        || decision.action === 'transform';
    return {
        figmaId: node.id,
        name: node.name,
        figmaType: node.type,
        action: decision.action,
        kind: decision.nineSlice ? 'sprite' : resolvedKind,
        frame,
        parentFrame,
        rotation: node.rotation,
        opacity: node.opacity,
        visible: node.visible,
        clipsContent: node.clipsContent,
        cornerRadii: cornerRadii(node),
        fills: node.fills,
        strokes: node.strokes,
        strokeWeight: node.strokeWeight,
        characters: node.characters,
        textStyle: node.style,
        layout: {
            mode: resolvedKind === 'grid' ? 'GRID' : node.layoutMode,
            wrap: node.layoutWrap,
            primaryAlign: node.primaryAxisAlignItems,
            counterAlign: node.counterAxisAlignItems,
            primarySizing: node.primaryAxisSizingMode,
            counterSizing: node.counterAxisSizingMode,
            itemSpacing: node.itemSpacing,
            counterSpacing: node.counterAxisSpacing,
            paddingLeft: node.paddingLeft,
            paddingRight: node.paddingRight,
            paddingTop: node.paddingTop,
            paddingBottom: node.paddingBottom,
        },
        overflowDirection: node.overflowDirection,
        constraints: node.constraints,
        relativeTransform: node.relativeTransform,
        sprite: assets.get(node.id),
        fontUuid: node.style?.fontFamily ? fonts.get(node.style.fontFamily) : undefined,
        children: terminal
            ? []
            : node.children
                .map((child) => makeSpec(child, frame, decisions, assets, fonts))
                .filter((child): child is SceneNodeSpec => child !== null),
    };
}

async function getNodeMaps(): Promise<Record<string, Record<string, string>>> {
    const saved = await Editor.Profile.getProject(packageJSON.name, 'nodeMaps', 'project');
    return saved && typeof saved === 'object' ? saved as Record<string, Record<string, string>> : {};
}

async function performImport(request: ImportRequest): Promise<SceneImportResult> {
    if (!activeDocument) {
        throw new Error('请先读取 Figma 文件。');
    }
    const importSettings = safeSettings(request.settings);
    await saveSettings(importSettings);
    beginOperation();
    try {
        emitProgress({ phase: 'assets', value: 0, message: '分析并准备资源…' });
        const decisions = decisionMap(request.overrides);
        const assets = await buildAssets(activeDocument, decisions, importSettings);
        const fonts = await resolveFonts(importSettings);
        const sourceRootFrames = activeDocument.roots.map(nodeFrame);
        const multipleRoots = activeDocument.roots.length > 1;
        const arrangedWidth = multipleRoots
            ? sourceRootFrames.reduce((total, frame) => total + frame.width, 0)
                + Math.max(0, sourceRootFrames.length - 1) * 160
            : sourceRootFrames[0]?.width ?? 0;
        const rootFrame = multipleRoots
            ? {
                x: 0,
                y: 0,
                width: arrangedWidth,
                height: Math.max(0, ...sourceRootFrames.map((frame) => frame.height)),
            }
            : sourceRootFrames[0] ?? { x: 0, y: 0, width: 0, height: 0 };
        let rootCursor = 0;
        const roots = activeDocument.roots
            .map((node, index) => {
                const spec = makeSpec(node, rootFrame, decisions, assets, fonts);
                if (spec && multipleRoots) {
                    spec.frame = {
                        x: rootCursor,
                        y: 0,
                        width: sourceRootFrames[index].width,
                        height: sourceRootFrames[index].height,
                    };
                    rootCursor += sourceRootFrames[index].width + 160;
                }
                return spec;
            })
            .filter((node): node is SceneNodeSpec => node !== null);
        if (!roots.length) {
            throw new Error('没有选中任何可导入节点。');
        }

        const nodeMaps = await getNodeMaps();
        const selected = importSettings.useSelection ? Editor.Selection.getLastSelected('node') : undefined;
        const payload: SceneImportPayload = {
            fileKey: activeDocument.fileKey,
            rootName: activeDocument.fileName,
            rootFrame,
            scale: importSettings.scale,
            targetUuid: selected || undefined,
            updateExisting: importSettings.updateExisting,
            existingMap: nodeMaps[activeDocument.fileKey] ?? {},
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: 'importDocument',
            args: [payload],
        }) as SceneImportResult;
        await Editor.Message.request('scene', 'snapshot');
        nodeMaps[activeDocument.fileKey] = result.nodeMap;
        await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
        Editor.Selection.select('node', result.rootUuid);
        if (importSettings.autoSave) {
            await Editor.Message.request('scene', 'save-scene');
        }
        emitProgress({
            phase: 'done',
            value: 1,
            message: `完成：新建 ${result.created}，更新 ${result.updated}`,
        });
        return result;
    } catch (error) {
        if (error instanceof CancelledError || activeController?.signal.aborted) {
            emitProgress({ phase: 'cancelled', value: 0, message: '已取消。' });
            throw new Error('操作已取消。');
        }
        emitProgress({
            phase: 'error',
            value: 0,
            message: error instanceof Error ? error.message : '导入失败。',
        });
        throw error;
    } finally {
        finishOperation();
    }
}

export const methods: Record<string, (...args: any[]) => any> = {
    openPanel() {
        Editor.Panel.open(packageJSON.name);
    },

    async getState() {
        await vault.initialize();
        return {
            vault: vault.status(),
            settings: await getSettings(),
            document: activeDocument ? {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl: activeDocument.sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
            } : null,
        };
    },

    async setToken(value: string) {
        return vault.set(value);
    },

    async clearToken() {
        return vault.clear();
    },

    async verifyToken() {
        beginOperation();
        try {
            const identity = await (await client()).verify();
            return {
                ok: true,
                handle: identity.handle || 'Figma User',
            };
        } finally {
            finishOperation();
        }
    },

    async saveSettings(value: unknown) {
        return saveSettings(value);
    },

    async fetchDocument(sourceUrl: string) {
        beginOperation();
        try {
            emitProgress({ phase: 'fetch', value: 0.15, message: '正在读取 Figma 文件…' });
            const parsed = parseFigmaSource(sourceUrl);
            const api = await client();
            const payload = parsed.nodeId
                ? await api.getNode(parsed.fileKey, parsed.nodeId)
                : await api.getFile(parsed.fileKey);
            activeDocument = parseDocument(payload, sourceUrl, parsed.fileKey, parsed.nodeId);
            const current = await getSettings();
            await saveSettings({ ...current, sourceUrl });
            emitProgress({ phase: 'idle', value: 1, message: `已读取 ${activeDocument.fileName}` });
            return {
                fileKey: activeDocument.fileKey,
                fileName: activeDocument.fileName,
                sourceUrl,
                tree: activeDocument.tree,
                fonts: activeDocument.fonts,
            };
        } catch (error) {
            emitProgress({
                phase: 'error',
                value: 0,
                message: error instanceof Error ? error.message : '读取失败。',
            });
            throw error;
        } finally {
            finishOperation();
        }
    },

    async getPreview(nodeId: string) {
        if (!activeDocument?.nodeById.has(nodeId)) {
            throw new Error('预览节点不存在。');
        }
        beginOperation();
        try {
            const urls = await (await client()).getImageUrls(activeDocument.fileKey, [nodeId], 'png', 1);
            if (!urls[nodeId]) {
                throw new Error('无法生成节点预览。');
            }
            return { url: urls[nodeId] };
        } finally {
            finishOperation();
        }
    },

    async importSelection(request: ImportRequest) {
        return performImport(request);
    },

    cancelImport() {
        activeController?.abort();
    },
};

export async function load(): Promise<void> {
    await vault.initialize();
}

export function unload(): void {
    activeController?.abort();
    activeController = null;
    activeDocument = null;
}
