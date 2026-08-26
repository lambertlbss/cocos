export type ImportAction = 'ignore' | 'generate' | 'render' | 'transform';

/** 仅用于兼容旧面板热加载期间可能发来的动作值。 */
export type LegacyImportAction = ImportAction | 'svg' | 'merge';

export type NodeKind =
    | 'auto'
    | 'node'
    | 'sprite'
    | 'label'
    | 'richText'
    | 'button'
    | 'scrollView'
    | 'layout';

export type NodeSemanticRole =
    | 'root'
    | 'panel'
    | 'list'
    | 'layout'
    | 'button'
    | 'image'
    | 'text'
    | 'view'
    | 'content'
    | 'unknown';

export type ImportPlanReason =
    | 'hidden'
    | 'root-structure'
    | 'manual-export'
    | 'slice-resource'
    | 'semantic-container'
    | 'editable-text'
    | 'single-image-fold'
    | 'single-text-fold'
    | 'background-promotion'
    | 'visual-fallback'
    | 'default-generate'
    | 'user-override';

export type VisualFoldKind = 'single-image' | 'single-text' | 'background';

export interface ImportDecision {
    action: ImportAction;
    kind: NodeKind;
    nineSlice: boolean;
    /** 用户是否主动修改过该节点的默认策略。 */
    explicit?: boolean;
    /** 最终写入 Cocos 的节点名；不改变 Figma 原始语义名与资源匹配。 */
    name?: string;
}

export interface VisualFoldPlan {
    kind: VisualFoldKind;
    /** 提供 Sprite/Label 数据的 Figma 节点。 */
    sourceNodeId: string;
    /** 不再单独创建、但仍需追踪到父 Cocos 节点的源节点 ID。 */
    absorbedNodeIds: string[];
}

export interface NodeImportPlan {
    nodeId: string;
    role: NodeSemanticRole;
    reason: ImportPlanReason;
    /** 折叠后父节点实际应使用的 Cocos 类型。 */
    kind?: NodeKind;
    fold?: VisualFoldPlan;
}

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
    /** Figma 未旋转前的本地尺寸（geometry=paths）。 */
    size?: { width: number; height: number };
    relativeTransform?: number[][];
    /** 已转换为度数，方向与 Figma 属性面板一致。 */
    rotation: number;
    opacity: number;
    blendMode?: string;
    clipsContent: boolean;
    cornerRadius?: number;
    rectangleCornerRadii?: number[];
    arcData?: {
        startingAngle: number;
        endingAngle: number;
        innerRadius: number;
    };
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
    /** 智能策略的正常判定原因；与 warning（风险提示）分开。 */
    reason?: ImportPlanReason;
    /** 面板预告的视觉折叠类型。最终导入仍会按用户覆盖重新规划。 */
    fold?: VisualFoldKind;
    /** 默认计划中会被当前节点吸收的源节点 ID。 */
    absorbedNodeIds?: string[];
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
    /** true 表示用户主动修改过默认值，导入规划器不得悄悄覆盖。 */
    explicit?: boolean;
    /** 可选的 Cocos 节点名覆盖。 */
    name?: string;
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
    /** 未旋转前的节点尺寸；frame 仍保存页面坐标中的轴对齐包围盒。 */
    intrinsicSize?: { width: number; height: number };
    /** 导入根不使用相对页面变换，固定放在目标画布中心。 */
    isRoot?: boolean;
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
    /** 这些源节点被折叠到当前节点，均映射至当前 Cocos UUID。 */
    aliasFigmaIds?: string[];
    /** 当前节点是层级收口边界，更新时需清理旧的已映射后代。 */
    flattenBoundary?: boolean;
    planReason?: ImportPlanReason;
    children: SceneNodeSpec[];
}

/**
 * Prefab 编辑模式下的增量同步上下文。Figma 原始 ID 只在进程间临时传递，
 * 持久化时会由主进程转换成不可逆哈希。
 */
export interface PrefabSceneSyncContext {
    prefabUuid: string;
    rootFileId: string;
    existingNodeFileIds: Record<string, string>;
    managedNodeFileIds: string[];
    managedComponentFileIds: string[];
    managedHelperFileIds: string[];
}

export interface PrefabSceneSyncCapture {
    nodeFileIds: Record<string, string>;
    managedNodeFileIds: string[];
    managedComponentFileIds: string[];
    managedHelperFileIds: string[];
}

export interface PrefabEditingState {
    ready: boolean;
    mode: string;
    currentUuid: string;
    rootUuid?: string;
    rootFileId?: string;
    reason?: string;
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
