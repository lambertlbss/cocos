export type ImportAction = 'ignore' | 'generate' | 'render' | 'svg' | 'merge' | 'transform';

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
    color?: FigmaColor;
    imageRef?: string;
    scaleMode?: string;
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
    localResourceFolder: string;
    scale: number;
    updateExisting: boolean;
    refreshAssets: boolean;
    autoSave: boolean;
    useSelection: boolean;
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
    localResourceFolder: '',
    scale: 1,
    updateExisting: true,
    refreshAssets: false,
    autoSave: false,
    useSelection: true,
    fontMap: {},
};
