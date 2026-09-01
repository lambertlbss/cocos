# Figma Importer MCP

这是 Figma Importer 的本地单向自动化入口。AI 客户端通过 stdio 启动 MCP Server；MCP Server 再通过仅本机可见的 Named Pipe（Windows）或 Unix Socket 连接当前 Cocos Creator 项目中的扩展主进程。

```text
AI 客户端
  └─ stdio → mcp-dist/server.js
                 └─ 本地鉴权 IPC → Cocos Creator / Figma Importer
                                          └─ Figma REST + Cocos Scene/AssetDB
```

没有监听 TCP 端口，也不需要让 Figma Importer 面板保持打开。

MCP 不调用浏览器，也不使用浏览器自动化。读取设计和预览时，由 Cocos 插件使用已经保存的 Token 直接请求固定的 Figma REST API；因此仍需要能够访问 `api.figma.com` 的 HTTPS 网络，但不需要浏览器权限。全部 MCP 工具都声明为 `openWorldHint=false`，导入工具只保留“会修改本地 Cocos 项目”的明确确认。

## 使用条件

1. 使用 Node.js 18 或更高版本运行 MCP Server。
2. Cocos Creator 已打开目标项目，并已启用 Figma Importer 扩展。
3. 首次使用时打开一次 Figma Importer 面板，保存并验证 Figma Personal Access Token；之后可以关闭面板。
4. 仓库中存在随版本构建的 `dist` 与 `mcp-dist/server.js`。

已连接的官方 Figma MCP 与本 MCP 可以同时使用，但两者不会共享 Token、会话或工具状态。官方 Figma MCP 可帮助 AI 理解设计和找到 Frame；实际导入仍要把 Figma 文件/Frame 链接传给本 MCP 的 `figma_importer_fetch_document`。

## 连接 Codex

在 Codex MCP 配置中增加以下条目。`server.js` 使用扩展目录的绝对路径；`--project` 使用 Cocos 项目根目录，而不是 `assets` 或扩展目录。

```toml
[mcp_servers.figma_importer_cocos]
command = "node"
args = [
  "C:\\绝对路径\\figma-importer-cocos\\mcp-dist\\server.js",
  "--project",
  "D:\\CocosProjects\\YourGame"
]
```

若当前机器只打开一个启用了本扩展的 Cocos 项目，可以省略 `--project`；MCP 首次发现后会固定到该项目，不会因它关闭而静默切换到另一个项目。同时打开多个项目时必须提供 `--project`，避免目标不明确。

其他使用 JSON MCP 配置的客户端可使用等价配置：

```json
{
  "mcpServers": {
    "figma_importer_cocos": {
      "command": "node",
      "args": [
        "C:\\绝对路径\\figma-importer-cocos\\mcp-dist\\server.js",
        "--project",
        "D:\\CocosProjects\\YourGame"
      ]
    }
  }
}
```

修改 MCP 配置后重启或重新加载 AI 客户端。Cocos 项目重载扩展时，本地会话会自动更新；旧文档会话和分页 cursor 会失效，AI 需要重新读取 Figma 链接。

## MCP 工具列表与用途

所有工具成功时都会同时返回可供 AI 阅读的 JSON 文本和 `structuredContent` 结构化数据。当前固定开放以下 9 个工具：

| 工具 | 用途 | 关键输入 | 主要返回 | 读写属性 |
|---|---|---|---|---|
| `figma_importer_get_status` | 检查 MCP 是否连到正确的 Cocos 项目，以及插件版本、Creator 版本、Token 配置状态、当前设置、文档和忙碌状态 | 无 | `projectPath`、安全 Token 状态、`settings`、`busy`、当前文档摘要 | 本地只读 |
| `figma_importer_fetch_document` | 让 Cocos 插件读取一个 Figma 文件或 Frame，并创建后续工具必须使用的文档会话 | `sourceUrl`：有效的 `figma.com` 链接 | `documentSessionId`、文件名、节点数、字体、根节点摘要 | 访问 Figma；仅更新最近链接，不创建 Cocos 资源 |
| `figma_importer_list_nodes` | 分页查询节点，并查看 Figma 原名、最终 Cocos 名、有效 action/kind、九宫状态、折叠、抑制和警告 | `documentSessionId`；可选 `rootNodeId`、`search`、过滤项、`depth`、`limit`、`cursor` | `nodes`、`totalCount`、`hasMore`、`nextCursor` | 本地只读 |
| `figma_importer_get_preview` | 获取一个节点的临时 Figma PNG 预览 URL，供 AI 或用户核对视觉结果 | `documentSessionId`、`nodeId` | `url` | 只读访问 Figma |
| `figma_importer_update_settings` | 更新本次导入使用的输出目录、倍率、更新策略、刷新、自动保存和字体映射；不会立即导入 | `documentSessionId`、`settings` 部分字段 | 合并后的安全公开设置 | 写 Cocos 项目 Profile，可重复调用 |
| `figma_importer_update_nodes` | 批量修改节点导入策略，也可同时修改名称 | `documentSessionId`、`updates[]`；每项包含 `nodeId` 及 action/kind/nineSlice/name 中至少一项 | 最终持久化的 `updated` 节点覆盖 | 写 Cocos 项目 Profile，可重复调用 |
| `figma_importer_rename_nodes` | 只批量修改导入后的 Cocos 节点名，保留 action、kind、nineSlice 和 explicit；`name:null` 可恢复原名 | `documentSessionId`、`renames[]`、可选 `allowRootRename` | Figma/Cocos 名称、是否重置及风险提示 | 写 Cocos 项目 Profile，可重复调用 |
| `figma_importer_import` | 按当前设置和节点覆盖创建或更新 Cocos 图片、SpriteFrame、Prefab/Scene 节点 | `documentSessionId`、唯一 `operationId`、`confirm:true`；可选一次性 `settings` | 有限导入摘要：创建/更新数、Prefab URL、警告等 | 修改项目，破坏性工具，必须明确确认 |
| `figma_importer_cancel_import` | 请求取消由本 MCP 发起且身份完全匹配的活动导入 | `documentSessionId`、`operationId` | 是否接受取消、信号是否发送、未取消原因 | 只影响匹配操作；不会取消面板或其他客户端 |

### 关键参数说明

- `documentSessionId`：只能使用 `figma_importer_fetch_document` 本次返回的值。重新读取、插件重载或切换项目后，旧值及其分页 cursor 会失效。
- `operationId`：8–128 字符，只允许字母、数字、点、下划线、冒号和连字符。同一次导入的超时复查必须复用原 ID；文档、设置或节点策略变化后发起新导入必须使用新 ID。
- `action`：`ignore` 忽略节点及受影响子树；`generate` 生成可编辑 Cocos 结构；`render` 作为 PNG 整层；`transform` 保留变换边界但不生成普通视觉组件。
- `kind`：可选 `auto`、`node`、`sprite`、`label`、`richText`、`button`、`scrollView`、`layout`。
- `settings`：仅允许 `assetFolder`、`prefabFolder`、`scale`、`updateExisting`、`refreshAssets`、`autoSave` 和 `fontMap`；输出目录必须是项目 `assets` 下的相对子目录。
- 分页查询：`limit` 为 1–200，默认 50；`hasMore=true` 时把 `nextCursor` 原样传给下一次相同查询，不能同时改变过滤条件。

### 常用调用示例

读取一个 Frame：

```json
{
  "sourceUrl": "https://www.figma.com/design/FILE_KEY/Name?node-id=410-5000"
}
```

批量修改 Cocos 节点名：

```json
{
  "documentSessionId": "FETCH_DOCUMENT_RETURNED_SESSION",
  "renames": [
    { "nodeId": "410:5001", "name": "btn_close" },
    { "nodeId": "410:5002", "name": "txt_title" }
  ],
  "allowRootRename": false
}
```

确认并执行导入：

```json
{
  "documentSessionId": "FETCH_DOCUMENT_RETURNED_SESSION",
  "operationId": "popup-import-20260831-01",
  "confirm": true
}
```

推荐调用顺序：

1. `figma_importer_get_status`
2. `figma_importer_fetch_document`
3. `figma_importer_list_nodes`（必要时多页查询）
4. `figma_importer_get_preview`（可选）
5. `figma_importer_rename_nodes` / `figma_importer_update_nodes` / `figma_importer_update_settings`（可选）
6. 再次查询并向用户说明目标 Prefab/场景和警告
7. 生成一个至少 8 字符的唯一 `operationId`，调用 `figma_importer_import` 并显式传入 `confirm=true`

导入调用会保持本地 Bridge 连接直到得到确定结果或收到匹配的取消请求，不使用会造成“项目已写入但客户端只看到超时”的内部截止时间。如果 AI 客户端自身超时，先检查 Cocos；需要重试同一次导入时必须复用原 `operationId`。只有文档、有效设置和最终节点策略均与原请求一致时，插件才返回已完成结果而不重复执行；这些内容已变化时会返回 `OPERATION_ID_CONFLICT`，全新导入必须使用新的 ID。

## 节点改名规则

- 改名只影响最终 Cocos 节点名，不会修改 Figma 节点名或 Figma node id。
- 批量改名会保留节点已有的 action、kind、nineSlice 和 explicit 状态，不会把“只改名”误变成策略覆盖。
- 传 `name: null` 可恢复 Figma 原名。
- 控制字符、路径分隔符和多余空白会被清洗；清洗后为空的名字会被拒绝；名称最长 96 字符。
- 默认禁止改导入根节点名。若明确传 `allowRootRename=true`，链接 Frame 的 Prefab 文件名也可能随之改变。
- 被改名的视觉包装节点会保留为独立 Cocos 节点，可能不再参与自动折叠；工具响应会返回提示。

## 安全边界

- Figma Token 只保存在并使用于 Cocos 扩展主进程，MCP 状态只返回是否已配置和安全后端，不返回 Token。
- MCP 不启动、附加或控制任何浏览器；Figma 文件、图片和预览均通过固定 Figma REST API 直接读取。
- MCP 不开放设置/清除 Token、目录选择器、本地素材扫描目录、任意 `Editor.Message`、Scene Script 名称或 Round-trip 方法。
- IPC 请求有随机会话密钥、方法白名单和 1 MiB 单帧限制；密钥只写入操作系统临时会话文件。
- 导入必须带 `confirm=true` 和客户端唯一 `operationId`，避免 AI 在只读分析中意外修改项目，并对超时重试去重。
- 文档操作必须携带本次读取返回的 `documentSessionId`；另一次读取、扩展重载或 Cocos 项目切换都会使旧会话失效。
- 取消必须同时匹配当前 `documentSessionId` 与 `operationId`；响应表示取消请求是否被接受，不承诺 Cocos 已进入的 Scene/AssetDB 不可中断步骤一定回滚。

## 排查

- `找不到正在运行的 Cocos Bridge`：确认 Cocos 项目已打开、扩展已启用；面板无需打开。
- `发现多个 Cocos Bridge`：在 MCP 参数中添加正确的 `--project` 绝对路径。
- `Token 未配置`：打开一次插件面板，在“安全连接”中保存并验证 Token。
- `STALE_DOCUMENT_SESSION`：重新调用 `figma_importer_fetch_document`，不要复用旧 session 或 cursor。
- `ROOT_RENAME_REQUIRES_CONFIRMATION`：确认是否接受 Prefab 文件名变化，再使用 `allowRootRename=true`。
- `OPERATION_IN_PROGRESS`：同一个 operationId 仍在执行，等待原调用；不要换新 ID 重复导入。
- `OPERATION_ID_CONFLICT`：该 operationId 已绑定另一组文档、设置或节点策略；复查后为全新导入生成新 ID。
- AI 客户端显示导入超时：先检查 Cocos 当前结果，再用原 operationId 查询式重试；不要直接创建新 ID。

开发者可运行：

```bash
npm install
npm run build
npm run verify:distribution
npm test
```

构建会生成 Cocos 的 `dist` 和不依赖仓库 `node_modules` 的 `mcp-dist/server.js` 单文件分发产物。
