import { z } from 'zod';

export const ImportActionSchema = z.enum(['ignore', 'generate', 'render', 'transform']);
export const NodeKindSchema = z.enum([
    'auto',
    'node',
    'sprite',
    'label',
    'richText',
    'button',
    'scrollView',
    'layout',
]);

const DocumentSessionIdSchema = z.string()
    .trim()
    .min(1)
    .max(256)
    .describe('由 figma_importer_fetch_document 返回的文档会话 ID。');

const NodeIdSchema = z.string()
    .trim()
    .min(1)
    .max(256)
    .describe('Figma nodeId，例如 410:5000。');

const OperationIdSchema = z.string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .describe('本次导入的客户端唯一 ID；超时重试必须复用同一个值。');

const FontMapSchema = z.record(z.string().trim().min(1), z.string().trim().max(2048))
    .refine((value) => Object.keys(value).length <= 500, 'fontMap 最多包含 500 项。');

export const SettingsPatchSchema = z.object({
    assetFolder: z.string().trim().min(1).max(256).optional()
        .describe('图片资源在 assets 下的相对子目录。'),
    prefabFolder: z.string().trim().min(1).max(256).optional()
        .describe('Prefab 在 assets 下的相对子目录。'),
    scale: z.number().finite().min(0.25).max(4).optional()
        .describe('Figma 图片导入倍率，范围 0.25–4。'),
    updateExisting: z.boolean().optional(),
    refreshAssets: z.boolean().optional(),
    autoSave: z.boolean().optional(),
    fontMap: FontMapSchema.optional()
        .describe('Figma 字体名到 db://assets/... 字体资源的映射。'),
}).strict().refine(
    (value) => Object.keys(value).length > 0,
    'settings 至少需要包含一个修改字段。',
);

export const GetStatusInputSchema = z.object({}).strict();

export const FetchDocumentInputSchema = z.object({
    sourceUrl: z.string().trim().url().max(2048)
        .describe('带 node-id 的 Figma 文件或 Frame 链接。'),
}).strict();

export const ListNodesInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    rootNodeId: NodeIdSchema.optional()
        .describe('可选的查询子树根节点。'),
    search: z.string().trim().max(256).optional()
        .describe('按 Figma 名、Cocos 名或节点路径搜索。'),
    types: z.array(z.string().trim().min(1).max(64)).max(100).optional()
        .describe('可选 Figma 节点类型过滤。'),
    actions: z.array(ImportActionSchema).max(4).optional(),
    kinds: z.array(NodeKindSchema).max(8).optional(),
    warningOnly: z.boolean().default(false),
    depth: z.number().int().min(0).max(32).default(8),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(512).nullable().optional(),
}).strict();

export const GetPreviewInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    nodeId: NodeIdSchema,
}).strict();

export const UpdateSettingsInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    settings: SettingsPatchSchema,
}).strict();

const RenameItemSchema = z.object({
    nodeId: NodeIdSchema,
    name: z.string().trim().min(1).max(256).nullable()
        .describe('新的 Cocos 节点名；传 null 清除名称覆盖。'),
}).strict();

export const RenameNodesInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    renames: z.array(RenameItemSchema).min(1).max(500),
    allowRootRename: z.boolean().default(false)
        .describe('根节点改名会改变链接 Frame 的 Prefab 文件名，必须显式允许。'),
}).strict();

const UpdateNodeItemSchema = z.object({
    nodeId: NodeIdSchema,
    action: ImportActionSchema.optional(),
    kind: NodeKindSchema.optional(),
    nineSlice: z.boolean().optional(),
    name: z.string().trim().min(1).max(256).nullable().optional(),
}).strict().refine(
    (value) => value.action !== undefined
        || value.kind !== undefined
        || value.nineSlice !== undefined
        || value.name !== undefined,
    '每个 updates 项至少需要包含 action、kind、nineSlice 或 name。',
);

export const UpdateNodesInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    updates: z.array(UpdateNodeItemSchema).min(1).max(500),
    allowRootRename: z.boolean().default(false),
}).strict();

export const ImportDocumentInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    operationId: OperationIdSchema,
    confirm: z.literal(true)
        .describe('导入会创建或修改 Cocos 项目资源，必须显式传 true。'),
    settings: SettingsPatchSchema.optional(),
}).strict();

export const CancelImportInputSchema = z.object({
    documentSessionId: DocumentSessionIdSchema,
    operationId: OperationIdSchema,
}).strict();

export const PublicSettingsSchema = z.object({
    sourceUrl: z.string(),
    assetFolder: z.string(),
    prefabFolder: z.string(),
    scale: z.number(),
    updateExisting: z.boolean(),
    refreshAssets: z.boolean(),
    autoSave: z.boolean(),
    fontMap: z.record(z.string(), z.string()),
});

const TokenStatusSchema = z.object({
    configured: z.boolean(),
    persistent: z.boolean(),
    backend: z.string(),
    warning: z.string().optional(),
});

const DocumentStatusSchema = z.object({
    fileName: z.string(),
    sourceUrl: z.string(),
    nodeCount: z.number().int().nonnegative(),
    documentSessionId: z.string().optional(),
});

export const GetStatusOutputSchema = z.object({
    connected: z.boolean(),
    pluginVersion: z.string(),
    creatorVersion: z.string(),
    projectPath: z.string(),
    token: TokenStatusSchema,
    settings: PublicSettingsSchema,
    busy: z.boolean(),
    document: DocumentStatusSchema.nullable(),
});

const RootSummarySchema = z.object({
    nodeId: z.string(),
    name: z.string(),
    type: z.string(),
    width: z.number(),
    height: z.number(),
    childCount: z.number().int().nonnegative(),
});

export const FetchDocumentOutputSchema = z.object({
    documentSessionId: z.string(),
    fileName: z.string(),
    sourceUrl: z.string(),
    nodeCount: z.number().int().nonnegative(),
    fonts: z.array(z.string()),
    roots: z.array(RootSummarySchema),
});

const ListedNodeSchema = z.object({
    nodeId: z.string(),
    parentNodeId: z.string().optional(),
    depth: z.number().int().nonnegative(),
    path: z.string(),
    figmaName: z.string(),
    cocosName: z.string(),
    renamed: z.boolean(),
    type: z.string(),
    visible: z.boolean(),
    width: z.number(),
    height: z.number(),
    childCount: z.number().int().nonnegative(),
    preferredAction: ImportActionSchema,
    action: ImportActionSchema,
    kind: NodeKindSchema,
    nineSlice: z.boolean(),
    explicit: z.boolean(),
    suppressed: z.boolean(),
    patchCandidate: z.boolean(),
    sliceMode: z.enum(['horizontal', 'vertical', 'nine']).optional(),
    reason: z.string().optional(),
    fold: z.string().optional(),
    warning: z.string().optional(),
});

export const ListNodesOutputSchema = z.object({
    totalCount: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    nodes: z.array(ListedNodeSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
});

export const GetPreviewOutputSchema = z.object({
    url: z.string().url(),
});

export const UpdateSettingsOutputSchema = PublicSettingsSchema;

const ImportOverrideOutputSchema = z.object({
    id: z.string(),
    action: ImportActionSchema,
    kind: NodeKindSchema,
    nineSlice: z.boolean(),
    explicit: z.boolean().optional(),
    name: z.string().optional(),
});

export const UpdateNodesOutputSchema = z.object({
    updated: z.array(ImportOverrideOutputSchema),
});

const RenamedNodeOutputSchema = z.object({
    nodeId: z.string(),
    figmaName: z.string(),
    cocosName: z.string(),
    reset: z.boolean(),
    warning: z.string(),
});

export const RenameNodesOutputSchema = z.object({
    updated: z.array(RenamedNodeOutputSchema),
});

export const ImportDocumentOutputSchema = z.object({
    operationId: z.string(),
    result: z.object({
        completed: z.boolean(),
        created: z.number().optional(),
        updated: z.number().optional(),
        prefabUrl: z.string().optional(),
        temporaryRoot: z.boolean().optional(),
        warnings: z.array(z.string()).optional(),
    }),
    cancellationWarning: z.string().optional(),
});

export const CancelImportOutputSchema = z.object({
    cancellationRequested: z.boolean(),
    operationId: z.string(),
    interruptSignalSent: z.boolean().optional(),
    guaranteed: z.boolean().optional(),
    reason: z.string().optional(),
});
