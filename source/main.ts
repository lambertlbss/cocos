import { basename, extname, isAbsolute, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import packageJSON from '../package.json';
import { FigmaClient, CancelledError } from './figma/client';
import { inferAction, inferCocosLayoutMode, inferKind, isVectorNode } from './figma/analyzer';
import { parseDocument } from './figma/parser';
import { analyzeSliceGrid, type SliceAnalysis } from './figma/slicing';
import { parseFigmaSource } from './figma/url';
import {
    isTerminalAction,
    kindForImportAction,
    normalizeImportAction,
} from './import-actions';
import { AssetWriter, resolveAssetUuid, sanitizeAssetName } from './importer/assets';
import { LocalAssetCache, type CacheEntryKey } from './importer/cache';
import type { FontAssetOption } from './importer/fonts';
import { LocalResourceLibrary } from './importer/local-resources';
import { compactSlicePng } from './importer/sliced-png';
import { gradientPng } from './importer/svg';
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
    type TreeNodeDto,
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
    packageName: string;
    fileKey: string;
    rootName: string;
    rootFrame: Rect;
    scale: number;
    updateExisting: boolean;
    existingMap: Record<string, string>;
    prefabUrl?: string;
    centerInCanvas?: boolean;
    roots: SceneNodeSpec[];
}

interface SceneImportResult {
    rootUuid: string;
    nodeMap: Record<string, string>;
    created: number;
    updated: number;
    temporaryRoot?: boolean;
    prefabUrl?: string;
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.fnt', '.woff', '.woff2']);

async function listFontAssets(): Promise<FontAssetOption[]> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const fonts: FontAssetOption[] = [];
    async function visit(folder: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp') {
                continue;
            }
            const filePath = join(folder, entry.name);
            if (entry.isDirectory()) {
                await visit(filePath);
                continue;
            }
            if (!FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
                continue;
            }
            const path = relative(assetsRoot, filePath).replace(/\\/g, '/');
            fonts.push({
                name: basename(entry.name, extname(entry.name)),
                url: `db://assets/${path}`,
                relativePath: path,
            });
        }
    }
    await visit(assetsRoot);
    return fonts.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function emitProgress(progress: ProgressEvent): void {
    Editor.Message.send(packageJSON.name, 'progress', progress);
}

function defaultCacheFolder(): string {
    return join(Editor.Project.tmpDir, packageJSON.name, 'asset-cache');
}

function safeSettings(value: unknown): ImportSettings {
    const input = value && typeof value === 'object'
        ? value as Partial<ImportSettings>
        : {};
    const scale = typeof input.scale === 'number' && Number.isFinite(input.scale)
        ? Math.max(0.25, Math.min(4, input.scale))
        : DEFAULT_SETTINGS.scale;
    const fontMap = input.fontMap && typeof input.fontMap === 'object'
        ? Object.fromEntries(Object.entries(input.fontMap)
            .filter(([key, item]) => key.trim() && typeof item === 'string')
            .map(([key, item]) => [key.trim(), item.trim()]))
        : {};
    const rawLocalFolders = Array.isArray(input.localResourceFolders)
        ? input.localResourceFolders
        : typeof input.localResourceFolder === 'string'
            ? [input.localResourceFolder]
            : [];
    const localResourceFolders = rawLocalFolders
        .filter((folder): folder is string => typeof folder === 'string')
        .map((folder) => folder.trim())
        .filter(Boolean)
        .filter((folder, index, folders) => folders.indexOf(folder) === index)
        .slice(0, 3);
    return {
        sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : '',
        assetFolder: typeof input.assetFolder === 'string' && input.assetFolder.trim()
            ? input.assetFolder.trim()
            : DEFAULT_SETTINGS.assetFolder,
        prefabFolder: typeof input.prefabFolder === 'string' && input.prefabFolder.trim()
            ? input.prefabFolder.trim()
            : DEFAULT_SETTINGS.prefabFolder,
        localResourceFolders,
        localResourceFolder: localResourceFolders[0] ?? '',
        scale,
        updateExisting: input.updateExisting !== false,
        refreshAssets: input.refreshAssets === true,
        autoSave: input.autoSave === true,
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

function relativeAssetFolder(selectedPath: string): string {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const selected = resolve(selectedPath);
    const folder = relative(assetsRoot, selected);
    if (!folder || folder === '.' || folder.startsWith('..') || isAbsolute(folder)) {
        throw new Error('资源输出目录必须是项目 assets 下的子文件夹。');
    }
    return folder.replace(/\\/g, '/');
}

function assetDatabaseUrl(filePath: string): string | null {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const selected = resolve(filePath);
    const path = relative(assetsRoot, selected);
    const outside = path === '..'
        || path.startsWith('../')
        || path.startsWith('..\\')
        || isAbsolute(path);
    if (!path || path === '.' || outside) {
        return null;
    }
    return `db://assets/${path.replace(/\\/g, '/')}`;
}

async function pickAssetFolder(current: unknown): Promise<{
    folder: string;
    absolutePath: string;
} | null> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? resolve(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = existsSync(preferredPath) ? preferredPath : assetsRoot;
    const result = await Editor.Dialog.select({
        title: '选择 Figma 导入资源目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    return {
        folder: relativeAssetFolder(selected),
        absolutePath: resolve(selected),
    };
}

async function pickPrefabFolder(current: unknown): Promise<{
    folder: string;
    absolutePath: string;
} | null> {
    const assetsRoot = resolve(Editor.Project.path, 'assets');
    const currentFolder = typeof current === 'string'
        ? current.trim().replace(/\\/g, '/').replace(/^assets\/+/, '')
        : '';
    const preferredPath = currentFolder && !currentFolder.startsWith('..')
        ? resolve(assetsRoot, currentFolder)
        : assetsRoot;
    const initialPath = existsSync(preferredPath) ? preferredPath : assetsRoot;
    const result = await Editor.Dialog.select({
        title: '选择预制体输出目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    return {
        folder: relativeAssetFolder(selected),
        absolutePath: resolve(selected),
    };
}

async function pickLocalResourceFolder(current: unknown, _index = 0): Promise<{
    folder: string;
} | null> {
    const currentFolder = typeof current === 'string' ? current.trim() : '';
    const initialPath = currentFolder && isAbsolute(currentFolder)
        ? currentFolder
        : resolve(Editor.Project.path, 'assets');
    const result = await Editor.Dialog.select({
        title: '选择本地同名资源目录',
        path: initialPath,
        type: 'directory',
        button: '选择目录',
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
        return null;
    }
    const library = new LocalResourceLibrary(selected);
    return { folder: library.root };
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

function decisionForNode(node: FigmaNode, decisions: Map<string, Decision>): Decision {
    const decision = decisions.get(node.id) ?? defaultDecision(node);
    if (node.type === 'TEXT' && decision.action !== 'ignore') {
        return { ...decision, action: 'generate', nineSlice: false };
    }
    if (isVectorNode(node) && decision.action !== 'ignore') {
        return { ...decision, action: 'render', nineSlice: false };
    }
    return decision;
}

function decisionMap(overrides: ImportOverride[], tree: TreeNodeDto[]): Map<string, Decision> {
    const decisions = new Map<string, Decision>();
    const addDefaults = (nodes: TreeNodeDto[]) => {
        for (const node of nodes) {
            decisions.set(node.id, {
                action: normalizeImportAction(node.action),
                kind: node.kind,
                nineSlice: node.autoNineSlice === true,
            });
            addDefaults(node.children);
        }
    };
    addDefaults(tree);
    for (const item of overrides ?? []) {
        decisions.set(item.id, {
            action: normalizeImportAction(item.action),
            kind: item.kind,
            nineSlice: item.nineSlice,
        });
    }
    return decisions;
}

function collectAssetRequests(
    roots: FigmaNode[],
    decisions: Map<string, Decision>,
): { png: FigmaNode[]; gradients: FigmaNode[] } {
    const png: FigmaNode[] = [];
    const gradients: FigmaNode[] = [];
    const visit = (node: FigmaNode) => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') {
            return;
        }
        if (node.type === 'TEXT') {
            node.children.forEach(visit);
            return;
        }
        if (decision.nineSlice || decision.action === 'render') {
            png.push(node);
            return;
        }
        if (decision.action === 'generate') {
            const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
            if (fill) {
                if (node.children.length) {
                    gradients.push(node);
                } else {
                    png.push(node);
                }
            }
        }
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return { png, gradients };
}

async function buildAssets(
    session: DocumentSession,
    decisions: Map<string, Decision>,
    importSettings: ImportSettings,
): Promise<Map<string, SpriteAssetSpec>> {
    const writer = new AssetWriter(importSettings.assetFolder);
    await writer.initialize();
    const cache = new LocalAssetCache(defaultCacheFolder());
    await cache.initialize();
    const localResources = importSettings.localResourceFolders
        .map((folder) => new LocalResourceLibrary(folder));
    await Promise.all(localResources.map((library) => library.initialize()));
    const promoteLocalParents = async (node: FigmaNode): Promise<void> => {
        const decision = decisionForNode(node, decisions);
        if (decision.action === 'ignore') {
            return;
        }
        if (node.children.length && node.type !== 'TEXT') {
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, 'png');
                if (localMatch) {
                    break;
                }
            }
            if (localMatch) {
                decisions.set(node.id, { ...decision, action: 'render', nineSlice: false });
                return;
            }
        }
        await Promise.all(node.children.map(promoteLocalParents));
    };
    await Promise.all(session.roots.map(promoteLocalParents));
    const requests = collectAssetRequests(session.roots, decisions);
    const assets = new Map<string, SpriteAssetSpec>();
    const total = requests.png.length + requests.gradients.length;
    let completed = 0;
    let apiPromise: Promise<FigmaClient> | null = null;

    const getApi = () => {
        apiPromise ??= client();
        return apiPromise;
    };

    const completeAsset = (
        node: FigmaNode,
        asset: SpriteAssetSpec,
        source: 'existing' | 'local' | 'cache' | 'figma' | 'generated' = 'figma',
    ) => {
        assets.set(node.id, asset);
        completed += 1;
        const verb = source === 'local'
            ? '复用本地资源'
            : source === 'existing'
                ? '复用已有资源'
                : source === 'generated'
                    ? '生成渐变'
                : '导入资源';
        emitProgress({
            phase: 'assets',
            value: total ? completed / total : 1,
            message: `${verb} ${completed}/${total} · ${node.name}`,
        });
    };

    const processRemote = async (nodes: FigmaNode[]) => {
        if (!nodes.length) {
            return;
        }
        const format = 'png' as const;
        const groups = new Map<string, { url: string; nodes: FigmaNode[] }>();
        for (const node of nodes) {
            const url = writer.buildUrl(
                node.name,
                `${session.fileKey}:${node.id}`,
                format,
                importSettings.scale,
            );
            const key = url.normalize('NFKC').toLocaleLowerCase('en-US');
            const group = groups.get(key) ?? { url, nodes: [] };
            group.nodes.push(node);
            groups.set(key, group);
        }
        const pending: Array<{
            node: FigmaNode;
            nodes: FigmaNode[];
            url: string;
            analysis?: SliceAnalysis;
            fallbackBorders?: { left: number; right: number; top: number; bottom: number };
            key: CacheEntryKey;
            contents: Buffer | null;
            source: 'local' | 'cache' | 'figma';
        }> = [];
        const completeGroup = (
            groupedNodes: FigmaNode[],
            asset: SpriteAssetSpec,
            source: 'existing' | 'local' | 'cache' | 'figma',
        ) => {
            for (const groupedNode of groupedNodes) {
                completeAsset(groupedNode, asset, source);
            }
        };
        for (const { url, nodes: groupedNodes } of groups.values()) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            const node = groupedNodes[0];
            const decision = decisions.get(node.id) ?? defaultDecision(node);
            const analysis = decision.nineSlice && format === 'png'
                ? analyzeSliceGrid(node) ?? undefined
                : undefined;
            const fallbackBorders = analysis
                ? analyzeSliceGrid(node, importSettings.scale)?.borders
                : undefined;
            let localMatch = null;
            for (const library of localResources) {
                localMatch = await library.find(node.name, format);
                if (localMatch) {
                    break;
                }
            }
            const localUrl = localMatch && !analysis
                ? assetDatabaseUrl(localMatch.path)
                : null;
            const localAsset = localUrl ? await writer.existing(localUrl) : null;
            if (localAsset) {
                completeGroup(groupedNodes, localAsset, 'local');
                continue;
            }
            const existing = !importSettings.refreshAssets ? await writer.existing(url) : null;
            if (!localMatch && existing && !analysis) {
                completeGroup(groupedNodes, existing, 'existing');
                continue;
            }
            const key: CacheEntryKey = {
                fileKey: session.fileKey,
                nodeId: node.id,
                format,
                scale: importSettings.scale,
            };
            const cached = localMatch || importSettings.refreshAssets
                ? null
                : await cache.read(key);
            pending.push({
                node,
                nodes: groupedNodes,
                url,
                analysis,
                fallbackBorders,
                key,
                contents: localMatch?.contents ?? cached,
                source: localMatch ? 'local' : cached ? 'cache' : 'figma',
            });
        }
        const remoteNodes = pending.filter((item) => !item.contents).map((item) => item.node);
        const urls = remoteNodes.length
            ? await (await getApi()).getImageUrls(
                session.fileKey,
                remoteNodes.map((node) => node.id),
                format,
                importSettings.scale,
            )
            : {};
        for (const item of pending) {
            if (activeController?.signal.aborted) {
                throw new CancelledError();
            }
            let contents = item.contents;
            if (!contents) {
                const remoteUrl = urls[item.node.id];
                if (!remoteUrl) {
                    throw new Error(`Figma 未能渲染节点：${item.node.name}`);
                }
                contents = await (await getApi()).download(remoteUrl);
                await cache.write(item.key, contents);
            }
            const compact = item.analysis
                ? compactSlicePng(contents, item.node, item.analysis, importSettings.scale)
                : null;
            if (item.analysis && !compact) {
                console.warn(`[${packageJSON.name}] 三/九宫最小化失败，保留完整 PNG：${item.node.name}`);
            }
            completeGroup(
                item.nodes,
                await writer.write(item.url, compact?.contents ?? contents, compact?.borders ?? item.fallbackBorders),
                item.source,
            );
        }
    };

    await processRemote(requests.png);

    const gradientAssets = new Map<string, SpriteAssetSpec>();
    for (const node of requests.gradients) {
        const frame = node.absoluteBoundingBox;
        const fill = node.fills.find((item) => item.visible !== false && item.type.startsWith('GRADIENT_'));
        const png = frame && fill
            ? gradientPng(
                frame.width,
                frame.height,
                fill,
                cornerRadii(node),
                importSettings.scale,
            )
            : null;
        if (png) {
            const url = writer.buildUrl(
                node.name,
                `${session.fileKey}:${node.id}:gradient`,
                'png',
                importSettings.scale,
            );
            const gradientKey = url.normalize('NFKC').toLocaleLowerCase('en-US');
            const firstAsset = gradientAssets.get(gradientKey);
            const existing = firstAsset || importSettings.refreshAssets
                ? null
                : await writer.existing(url);
            const asset = firstAsset ?? existing ?? await writer.write(url, png);
            gradientAssets.set(gradientKey, asset);
            completeAsset(node, asset, firstAsset || existing ? 'existing' : 'generated');
            continue;
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

function inferredLayoutMode(node: FigmaNode): string | undefined {
    const nativeMode = inferCocosLayoutMode(node);
    if (nativeMode) {
        return nativeMode;
    }
    if (node.layoutMode && node.layoutMode !== 'NONE') {
        return undefined;
    }
    const frames = node.children
        .map((child) => child.absoluteBoundingBox)
        .filter((frame): frame is Rect => Boolean(frame));
    if (!frames.length) {
        return 'VERTICAL';
    }
    const centersX = frames.map((frame) => frame.x + frame.width / 2);
    const centersY = frames.map((frame) => frame.y + frame.height / 2);
    const spreadX = Math.max(...centersX) - Math.min(...centersX);
    const spreadY = Math.max(...centersY) - Math.min(...centersY);
    if (spreadY <= 2) {
        return 'HORIZONTAL';
    }
    if (spreadX <= 2) {
        return 'VERTICAL';
    }
    return 'GRID';
}

function makeSpec(
    node: FigmaNode,
    parentFrame: Rect | undefined,
    decisions: Map<string, Decision>,
    assets: Map<string, SpriteAssetSpec>,
    fonts: Map<string, string>,
): SceneNodeSpec | null {
    const decision = decisionForNode(node, decisions);
    if (decision.action === 'ignore') {
        return null;
    }
    const frame = nodeFrame(node);
    const resolvedKind = decision.kind === 'auto' ? inferKind(node) : decision.kind;
    const bitmapTerminal = decision.nineSlice || decision.action === 'render';
    const terminal = bitmapTerminal || isTerminalAction(decision.action);
    const effectiveKind = kindForImportAction(resolvedKind, decision.action, decision.nineSlice);
    return {
        figmaId: node.id,
        name: node.name,
        figmaType: node.type,
        action: decision.action,
        kind: effectiveKind,
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
            mode: effectiveKind === 'layout' || effectiveKind === 'scrollView'
                ? inferredLayoutMode(node)
                : undefined,
            sourceMode: node.layoutMode,
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
        const decisions = decisionMap(request.overrides, activeDocument.tree);
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

        const linkedFrame = Boolean(activeDocument.sourceNodeId && roots.length === 1);
        let prefabUrl: string | undefined;
        if (linkedFrame) {
            const prefabWriter = new AssetWriter(importSettings.prefabFolder);
            await prefabWriter.initialize();
            const frameName = activeDocument.roots[0]?.name?.trim() || activeDocument.fileName;
            prefabUrl = `db://assets/${prefabWriter.folder}/${sanitizeAssetName(frameName)}.prefab`;
        }

        const nodeMaps = await getNodeMaps();
        const legacyRootUuid = linkedFrame
            ? nodeMaps[activeDocument.fileKey]?.__root__
            : undefined;
        const payload: SceneImportPayload = {
            packageName: packageJSON.name,
            fileKey: activeDocument.fileKey,
            rootName: activeDocument.fileName,
            rootFrame,
            scale: importSettings.scale,
            // A linked Figma frame is a prefab export, not an insertion into the
            // currently selected scene/prefab. Build an isolated temporary root
            // and remove it as soon as the prefab asset has been serialized.
            updateExisting: linkedFrame ? false : importSettings.updateExisting,
            existingMap: linkedFrame ? {} : (nodeMaps[activeDocument.fileKey] ?? {}),
            prefabUrl,
            centerInCanvas: linkedFrame,
            roots,
        };
        emitProgress({ phase: 'scene', value: 0.1, message: '正在构建 Cocos 节点树…' });
        if (linkedFrame) {
            // Establish an undo boundary before creating the temporary export
            // root, so aborting the export cannot discard the user's prior
            // edits in the currently opened scene/prefab.
            await Editor.Message.request('scene', 'snapshot');
        }
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: 'importDocument',
            args: [payload],
        }) as SceneImportResult;
        let prefabUuid: string | undefined;
        if (prefabUrl) {
            try {
                prefabUuid = String(await Editor.Message.request(
                    'scene',
                    'create-prefab',
                    result.rootUuid,
                    prefabUrl,
                ) || '');
                if (!prefabUuid) {
                    throw new Error(`预制体创建失败：${prefabUrl}`);
                }
                result.prefabUrl = prefabUrl;
                if (result.temporaryRoot) {
                    await Editor.Message.request('scene', 'execute-scene-script', {
                        name: packageJSON.name,
                        method: 'removeImportedNode',
                        args: [{ rootUuid: result.rootUuid }],
                    });
                }
                // Remove the root left behind by versions before 1.0.11. It is
                // tracked by the importer map and is the source of the fixed
                // top-level ghost that survived prefab switches.
                if (legacyRootUuid && legacyRootUuid !== result.rootUuid) {
                    await Editor.Message.request('scene', 'execute-scene-script', {
                        name: packageJSON.name,
                        method: 'removeImportedNode',
                        args: [{ rootUuid: legacyRootUuid }],
                    }).catch(() => undefined);
                }
                // create-prefab may select the source node internally. Clear
                // that stale node selection before opening the asset; otherwise
                // Cocos can keep drawing the old node as a top-level overlay.
                Editor.Selection.clear('node');
            } catch (error) {
                if (result.temporaryRoot) {
                    await Editor.Message.request('scene', 'execute-scene-script', {
                        name: packageJSON.name,
                        method: 'removeImportedNode',
                        args: [{ rootUuid: result.rootUuid }],
                    }).catch(() => undefined);
                }
                if (linkedFrame) {
                    Editor.Selection.clear('node');
                    await Editor.Message.request('scene', 'snapshot-abort').catch(() => undefined);
                }
                throw error;
            }
        }
        if (result.prefabUrl) {
            // The prefab export uses a temporary scene node only for
            // serialization. Abort that editor undo step so the currently
            // opened scene/prefab is not marked dirty by the export.
            await Editor.Message.request('scene', 'snapshot-abort');
        } else {
            await Editor.Message.request('scene', 'snapshot');
        }
        if (result.prefabUrl) {
            // The linked frame root is temporary and has already been removed
            // from the scene, so never persist its destroyed UUID for updates.
            delete nodeMaps[activeDocument.fileKey];
        } else {
            nodeMaps[activeDocument.fileKey] = result.nodeMap;
        }
        await Editor.Profile.setProject(packageJSON.name, 'nodeMaps', nodeMaps, 'project');
        if (!result.prefabUrl) {
            Editor.Selection.select('node', result.rootUuid);
        }
        if (importSettings.autoSave && !result.prefabUrl) {
            await Editor.Message.request('scene', 'save-scene');
        }
        if (result.prefabUrl && prefabUuid) {
            // Cocos 3.8.7 opens prefab assets through asset-db. Selecting the
            // asset first keeps the Assets panel and Inspector in sync.
            Editor.Selection.select('asset', prefabUuid);
            await Editor.Message.request('asset-db', 'open-asset', result.prefabUrl);
        }
        emitProgress({
            phase: 'done',
            value: 1,
            message: result.prefabUrl
                ? `完成：新建 ${result.created}，已创建并打开预制体 ${result.prefabUrl}`
                : `完成：新建 ${result.created}，更新 ${result.updated}`,
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
            version: packageJSON.version,
            vault: vault.status(),
            settings: await getSettings(),
            fontAssets: await listFontAssets(),
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

    async pickAssetFolder(current: unknown) {
        return pickAssetFolder(current);
    },

    async pickPrefabFolder(current: unknown) {
        return pickPrefabFolder(current);
    },

    async pickLocalResourceFolder(current: unknown) {
        return pickLocalResourceFolder(current);
    },

    async pickCacheFolder(current: unknown) {
        return pickLocalResourceFolder(current);
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
                fontAssets: await listFontAssets(),
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
