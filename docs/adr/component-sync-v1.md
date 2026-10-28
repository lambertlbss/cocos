# 组件级双边同步 v1（Component Sync）

- 状态：`IMPLEMENTING`（P1 标记/指纹核心已落地并有 16 项回归；主进程与面板接入进行中）
- 日期：2026-10-27
- 分支：`v4-component-two-way-sync`（基于 `origin/v3-engine-components-adaptation`，插件版本 `1.0.64`）
- 目标版本：待定（建议 `1.1.0`）

## 1. 目标

以 Figma 顶层 `COMPONENT` 链接为来源，导入一个 Prefab；后续重新导入时**原地更新**，不新增文件：

1. Figma 节点与 Prefab 节点严格一一对应（同步模式）。
2. 每个对应节点挂一个标记脚本组件，记录来源节点标识；标记既是同步依据，也是接管同名旧 Prefab 的安全凭证。
3. 重导入检测到同名 Prefab 时，面板显示"改动"视图（增/删/改清单），不新建文件。
4. "更新资源"开关：重新生成 PNG，按文件名覆盖输出目录中的同名资源，SpriteFrame UUID 保持不变。

不包含：Figma 侧写入（REST 只读）、组件变体（`COMPONENT_SET`）批量生成、Round-trip 的 Shared Plugin Data 回写路径（已有实现仍保持隐藏）。

## 2. 现状：v1.0.64 已经具备的部分

| 能力 | 现有实现 | 与本需求的差距 |
|---|---|---|
| 组件/Frame 链接 → 独立 Prefab | `main.ts:2381`（有 `nodeId` 且单根即走 Prefab-first）、`prepareLinkedFramePrefab`、`importLinkedFramePrefab` | 已可用；`COMPONENT` 不是显式支持的来源类型，缺少校验与文案 |
| 重导入原地更新、不新建文件 | 来源指纹 `figmaFrameSourceHash(fileKey,nodeId)` + `prefabBindingsV1` + Prefab Meta `userData.figmaImporter`（schema 1）+ `PrefabInfo.fileId` | 已可用；但"同名不同源"是 fail-closed 直接拒绝 |
| 几何/显隐/文字/组件类型同步 | `scene.ts` 按 fileId 复用节点，重建 UITransform/Sprite/Label | 已可用 |
| 资源重新生成 | `ImportSettings.refreshAssets`（"强制刷新资源"）：跳过输出目录同名复用与下载缓存，`write()` 用 `save-asset` 覆盖同名文件，UUID 不变 | 与需求中的"更新资源"是同一行为，无需新增开关 |
| 导入前后对比 | `ImportReview`（预览/审核数据模型）+ `diffReviewNodes` | 是**导入后**的检查；缺**导入前**的"将要改动什么" |

真正的新增工作：**严格 1:1 结构**、**标记组件**、**同名接管**、**导入前改动视图**、**资源覆盖的可控语义**。

## 3. 术语：折叠与整层（当前为什么会破坏 1:1）

### 3.1 视觉折叠（fold）

规划器 `import-planner.ts` 会在父层安全时把子层"吸收"到父节点，两个 Figma 节点只生成一个 Cocos 节点：

- `single-image`：`img_xxx` 容器下只有一个与父节点**严格同框**（位置/尺寸完全一致、无旋转/缩放/镜像）的图片子层时，Sprite 直接挂到 `img_xxx` 上，子节点不再创建。
- `single-text`：`txt_xxx` 容器下只有一个同框 TEXT 子层时，Label 挂到 `txt_xxx` 上。
- `background`：Button 类容器中，位于首位、与父节点同框、opacity 为 1 的唯一背景图提升为父节点 Sprite，文字/图标兄弟层保留。

被吸收的 Figma id 记录在 `aliasFigmaIds`，增量更新仍然正确，但节点数量少于 Figma。

### 3.2 PNG 整层（render）

`render` 动作把该节点**整棵子树**交给 Figma 导出一张 PNG，只生成一个 Sprite 节点，子层完全不创建。触发条件：

- 用户手动选择"PNG 整层"；
- 矢量节点（VECTOR / BOOLEAN_OPERATION / ELLIPSE / STAR / LINE 等）固定为自身的 PNG；
- Figma 中人工设置过 Export → 默认整层；
- 自动规则：非根、非语义容器的严格多段 `snake_case`（如 `img_hongbao_bg_mini`），且其全部有效可见直接子层都是非结构化命名、子树内没有 TEXT/结构化命名/滚动/Layout/三九宫 → 自动整层。

### 3.3 对同步的影响

- 折叠后一个 Cocos 节点对应多个 Figma 节点：位置/尺寸只能取折叠边界，被吸收层的单独改动无法表达。
- 整层后整棵子树消失：设计师只挪动了其中一个图标时，插件无法通过几何更新表达，只能**重新导出这张 PNG**——这正是"更新资源"要解决的问题。
- 因此"所有节点一一对应"与"自动折叠/自动整层"本质上互斥。v1 的选择见 §4.1：**保留折叠与整层，改用指纹检测 + 更新资源来覆盖它们的限制**。

## 4. 方案

### 4.1 同步模式不改变结构策略（2026-10-27 决定）

用户确认：**保留现有折叠与自动 PNG 整层**，不做严格 1:1。理由与代价：

- 折叠节点的标记只对应父节点，父节点的位置、尺寸、旋转、显隐、Sprite/Label 与组件类型照常同步；
- 被吸收子层不单独存在，其独立几何无法同步；
- 整层节点（矢量、手动 Export、`snake_case` 自动整层）内部改动只能通过"更新资源"重新出图；
- 折叠/展开在重导入时会产生节点增删，现有增量同步已支持且不留残影。

因此同步模式**只增加**：节点标记、改动检测、同名接管、"更新资源"自动勾选，不改变任何既有结构决策。

### 4.2 标记组件（P1 已实现）

- 脚本资产：`assets/figma-importer-runtime/FigmaSyncNode.ts`（`@ccclass('FigmaSyncNode')`，无业务逻辑、只依赖 `cc`）。
- 字段（`source/importer/sync-marker.ts`）：

| 字段 | 内容 |
|---|---|
| `figmaMarkerSchema` | 协议版本，当前 `1` |
| `figmaFileHash` | Figma file key 的 `sha256:`，**不存明文** |
| `figmaNodeId` | 明文 Figma 节点 id（冒号形式），用于可见标识 |
| `figmaAliasNodeIds` | 被折叠吸收的子层 id，逗号分隔、已排序 |
| `figmaAliasHash` | 别名集合指纹 |
| `figmaVisualHash` | 本节点自身视觉指纹（几何/显隐/填充/描边/特效/圆角/文字） |
| `figmaSubtreeHash` | 整棵子树指纹（含全部后代，用于判断整层 PNG 是否过期） |

- 指纹 = `roundtrip/canonical-json` 的规范 JSON + SHA-256：与属性顺序无关，几何按 `0.0001 px` 量化，避免浮点噪声误报。
- **删掉组件即退出同步**：该节点不再被移动/缩放/删除。
- 脚本资产缺失时导入前自动重建；Prefab 中已挂组件但脚本丢失则明确报错，不静默丢标记。
- 规则修订：知识库 §2.2"不把 file key、node id 写入项目资源"登记为显式例外——file key 仍只存哈希，node id 与 Project Profile 中 `nodeMaps` 的既有明文一致，Token 永不落盘。

### 4.2.1 改动检测：`aliasNodeIds` 能做什么（P1 已实现）

只有 id 列表只能回答"结构变没变"；要回答"设计改了没有"，必须同时保存每个节点上次导入时的**指纹**：

| 检测手段 | 能发现 | 发现不了 |
|---|---|---|
| `aliasNodeIds` + `figmaAliasHash` | 折叠子树里**新增/删除**图层 | 子层只是挪动或改色 |
| `figmaVisualHash` | 本节点的几何/显隐/颜色/描边/特效/文字变化 | 后代变化 |
| `figmaSubtreeHash` | 子树内**任意**后代变化（整层 PNG 是否过期） | Figma 端字体文件替换、同一 `imageRef` 背后的图片内容变化 |

用途：

1. **自动勾选"更新资源"**：整层/折叠节点只要 `subtreeHash` 变了，其 PNG 就不是最新版本；面板据此自动勾选并提示"检测到 N 个节点图片已变化"。
2. **改动清单**：即使整层子树在 Cocos 里只剩一个 Sprite，也能列出"`icon` 右移 4px、`shine` 高度变化"。
3. **只重导真正变了的图**：省时间，也避免无意义写入和 Git 噪声。
4. **跳过没变的节点**：没有变化的节点完全不碰。

边界：指纹只覆盖插件读取的 Figma 属性；字体文件替换或同一 `imageRef` 内容变化检测不到，这类情况需要"强制重导全部资源"（复用现有 `refreshAssets` 语义）。

### 4.3 同名接管

现状：目标路径存在 Prefab，但 Meta 无来源记录或来源不同 → 直接拒绝。

新规则（仅在同步模式下）：

1. 目标 `.prefab` 存在 → 读取其节点，检查标记组件；
2. 全部受管节点都带标记且 `schema` 可识别 → 视为**本插件生成**，允许接管：把来源指纹改写为新 `sourceHash`（组件 ID 变化/组件重建等场景），保留 Prefab UUID、节点 fileId 和手工节点；
3. 存在不受管节点（无标记且不在 Meta 所有权集合内）→ 保留，不删除，不移动；
4. 完全没有标记且 Meta 无记录 → 仍拒绝，提示先移动/重命名（不改现有 fail-closed 原则）。

### 4.4 导入前"改动"视图

- 新消息 `preview-prefab-sync`：给定当前文档 + 设置，计算目标 Prefab URL，读磁盘 `.prefab`（`prefabDiskPath`）解析节点与标记，按标记 `nodeId` 与本次 `SceneNodeSpec` 对齐，输出：
  - `targetUrl`、`exists`、`created/updated/removed` 计数；
  - `changes[]`：节点名、变化字段（位置/尺寸/旋转/显隐/文字/组件类型/资源）、before/after 值；
  - `assets[]`：将重新生成并覆盖的文件清单（勾"更新资源"时）。
- 面板：第 3 步"确认导入"在此模式下改为"确认更新"——显示目标 `db://` 路径、变更摘要与清单、"更新资源"开关、按钮文案"更新预制体"。
- 拒绝创建的路径（同名被非插件资源占用）在预览阶段就报错，不进入写流程。

### 4.5 更新资源

- 复用 `refreshAssets` 的既有实现（跳过输出目录同名复用 + 跳过缓存读 → `write()` 覆盖同名文件、UUID 不变），不新增重复开关；同步模式下该开关固定显示在确认区并改名"更新资源（覆盖同名图片）"。
- 覆盖范围硬限制：只覆盖**资源输出目录**内的文件；本地同名素材目录（最多 3 个）永不改写。
- 覆盖前后在导入检查报告里列出被覆盖的文件；同名但字节相同也照常覆盖（实现简单、行为可预期）。

### 4.6 代码落点

| 位置 | 变更 |
|---|---|
| `source/importer/sync-marker.ts`（新） | **已完成**：标记协议、视觉/子树/别名指纹、组件字段读写、所有权校验、标记脚本模板 |
| `source/types.ts` | **已完成**：`SyncMarkerSpec` + `SceneNodeSpec.syncMarker` |
| `source/main.ts` | 组件来源校验、标记注入 `SceneNodeSpec`、`preview-prefab-sync`、同名接管、按指纹判定资源过期 |
| `source/scene.ts` | 建树时挂/校验 `FigmaSyncNode` 组件；标记节点参与所有权判定 |
| `source/importer/prefab-sync.ts` | Meta 记录扩展（指纹/标记校验信息），保持 schema 1 向后兼容 |
| `source/panels/default/*` | 第 3 步同步确认区、改动清单、"更新资源"自动勾选、组件同步徽标 |
| `static/template/default/index.html` | 同步确认区 DOM 与开关 |

## 5. 待定

1. 组件模式下 `INSTANCE` 根是否等同 `COMPONENT`（建议等同，`COMPONENT_SET` 拒绝）。
2. 版本号：`1.1.0` 还是 `1.0.65`。
3. 标记脚本目录是否需要可配置（先固定 `assets/figma-importer-runtime/`）。

## 6. 分期

- ✅ P1（已完成）：标记协议 + 指纹 + 生成脚本 + 16 项回归。
- P2：主进程接入（标记注入、脚本资产生成与自愈、改动检测、同名接管）。
- P3：面板改动视图 + "更新资源"自动勾选。
- P4：知识库/README/`dist`/版本号。
