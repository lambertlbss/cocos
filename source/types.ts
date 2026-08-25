export type ImportAction = 'ignore' | 'generate' | 'render' | 'transform';

/** 仅用于兼容旧面板热加载期间可能发来的动作值。 */
export type LegacyImportAction = ImportAction | 'svg' | 'merge';

export type NodeKind =
    | 'auto'
    | 'node'
    | 'sprite'
    | 'label'
    | 'button'
    | 'scrollView'
    | 'layout';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface FigmaColor {
    r: number;
    g: number;
    b: number;
    a?: number;
}

export interface FigmaPaint {
    type: string;
    visible?: boolean;
    opacity?: number;
    blendMode?: string;
    color?: FigmaColor;
    imageRef?: string;
    scaleMode?: string;
    rotation?: number;
    /** Figma PATTERN paint 的平铺源节点。 */
    sourceNodeId?: string;
    tileType?: string;
    scalingFactor?: number;
    spacing?: { x: number; y: number };
    horizontalAlignment?: string;
    verticalAlignment?: string;
    gradientHandlePositions?: Array<{ x: number; y: number }>;
    gradientStops?: Array<{ position: number; color: FigmaColor }>;
}

export interface FigmaEffect {
    type: string;
    visible?: boolean;
    radius?: number;
    spread?: number;
    offset?: { x: number; y: number };
    color?: FigmaColor;
}

export interface FigmaTextStyle {
    fontFamily?: string;
    fontPostScriptName?: string;
    fontWeight?: number;
    fontSize?: number;
    textAlignHorizontal?: string;
    textAlignVertical?: string;
    letterSpacing?: number;
    lineHeightPx?: number;
    textAutoResize?: string;
    textTruncation?: string;
    maxLines?: number;
}

export interface FigmaNode {
    id: string;
    name: string;
    type: string;
    visible: boolean;
    children: FigmaNode[];
    absoluteBoundingBox?: Rect;
    absoluteRenderBounds?: Rect;
    relativeTransform?: number[][];
    rotation: number;
    opacity: number;
    blendMode?: string;
    clipsContent: boolean;
    cornerRadius?: number;
    rectangleCornerRadii?: number[];
    fills: FigmaPaint[];
    strokes: FigmaPaint[];
    strokeWeight: number;
    strokeAlign?: string;
    effects: FigmaEffect[];
    /** 当前节点是否在 Figma Export 面板中配置过至少一个导出项。 */
    hasExportSettings: boolean;
    characters?: string;
    style?: FigmaTextStyle;
    layoutMode?: string;
    layoutWrap?: string;
    layoutPositioning?: string;
    primaryAxisAlignItems?: string;
    counterAxisAlignItems?: string;
    primaryAxisSizingMode?: string;
    counterAxisSizingMode?: string;
    itemSpacing: number;
    counterAxisSpacing: number;
    paddingLeft: number;
    paddingRight: number;
    paddingTop: number;
    paddingBottom: number;
    overflowDirection?: string;
    constraints?: {
        horizontal?: string;
        vertical?: string;
    };
}

export interface TreeNodeDto {
    id: string;
    name: string;
    type: string;
    visible: boolean;
    width: number;
    height: number;
    action: ImportAction;
    kind: NodeKind;
    /** 智能模式是否应把该容器及其后代收口为当前节点的一张 PNG。 */
    renderSubtree?: boolean;
    patchCandidate: boolean;
    warning?: string;
    children: TreeNodeDto[];
}

export interface ParsedSource {
    fileKey: string;
    nodeId?: string;
}

export interface DocumentSession {
    fileKey: string;
    fileName: string;
    sourceUrl: string;
    sourceNodeId?: string;
    roots: FigmaNode[];
    nodeById: Map<string, FigmaNode>;
    tree: TreeNodeDto[];
    fonts: string[];
}

export interface ImportOverride {
    id: string;
    action: ImportAction;
    kind: NodeKind;
    nineSlice: boolean;
}

export interface ImportSettings {
    sourceUrl: string;
    assetFolder: string;
    prefabFolder: string;
    /** 最多三个本地同名资源目录，按数组顺序优先匹配。 */
    localResourceFolders: string[];
    /** 兼容旧版本设置，始终等于 localResourceFolders[0] 或空字符串。 */
    localResourceFolder: string;
    scale: number;
    updateExisting: boolean;
    refreshAssets: boolean;
    autoSave: boolean;
    fontMap: Record<string, string>;
}

export interface ImportRequest {
    overrides: ImportOverride[];
    settings: ImportSettings;
}

export interface SpriteAssetSpec {
    uuid: string;
    url: string;
    sliced: boolean;
    tiled?: boolean;
    /** Native tile size multiplier after the SpriteFrame's untrimmed pixel size. */
    tileScale?: number;
}

export interface SceneNodeSpec {
    figmaId: string;
    name: string;
    figmaType: string;
    action: ImportAction;
    kind: NodeKind;
    frame: Rect;
    parentFrame?: Rect;
    rotation: number;
    opacity: number;
    visible: boolean;
    clipsContent: boolean;
    cornerRadii: [number, number, number, number];
    fills: FigmaPaint[];
    strokes: FigmaPaint[];
    strokeWeight: number;
    characters?: string;
    textStyle?: FigmaTextStyle;
    layout?: {
        mode?: string;
        sourceMode?: string;
        wrap?: string;
        primaryAlign?: string;
        counterAlign?: string;
        primarySizing?: string;
        counterSizing?: string;
        itemSpacing: number;
        counterSpacing: number;
        paddingLeft: number;
        paddingRight: number;
        paddingTop: number;
        paddingBottom: number;
    };
    overflowDirection?: string;
    constraints?: {
        horizontal?: string;
        vertical?: string;
    };
    relativeTransform?: number[][];
    sprite?: SpriteAssetSpec;
    fontUuid?: string;
    children: SceneNodeSpec[];
}

export interface ProgressEvent {
    phase: 'idle' | 'fetch' | 'assets' | 'scene' | 'done' | 'error' | 'cancelled';
    value: number;
    message: string;
}

export const DEFAULT_SETTINGS: ImportSettings = {
    sourceUrl: '',
    assetFolder: 'figma-importer',
    prefabFolder: 'figma-importer/prefabs',
    localResourceFolders: [],
    localResourceFolder: '',
    scale: 1,
    updateExisting: true,
    refreshAssets: false,
    autoSave: false,
    fontMap: {},
};
