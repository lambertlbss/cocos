# Figma Importer for Cocos Creator

面向 Cocos Creator 3.8.7 的 Figma UI 导入扩展。它可以把 Figma 文件或单个节点转换为可编辑的 Cocos UI 节点树，也可以按节点选择 PNG 整层、九宫格或增量更新。

完整架构、数据流、安全约束、故障记录和后续变更规则见 [插件技术知识库](./FIGMA_IMPORTER_KNOWLEDGE_BASE.md)。

## 安装

1. 将本目录放到 Cocos 项目的 `extensions/figma-importer-cocos`。
2. 在本目录执行：

   ```bash
   npm install
   npm run build
   ```

3. 回到 Cocos Creator，选择“扩展 → 扩展管理器”并刷新扩展。
4. 从“面板 → Figma Importer”打开面板。

## 使用

1. 在 Figma 创建 Personal Access Token。
2. 在“安全连接”中保存并验证 Token。
3. 粘贴 Figma 文件链接或带 `node-id` 的节点链接。
4. 读取设计，检查节点策略和预览。
5. 确认导入设置；导入不会读取当前场景选中节点。
6. 点击“导入到场景”。

带 `node-id` 的 Figma Frame 链接会按独立预制体导入：最外层 Frame 作为 Prefab 根节点，并使用该 Frame 名称作为 `.prefab` 文件名；根节点挂载对应尺寸的 `UITransform`，并自动放置在 Canvas 参考边界中心。当前项目参考画布为 640×1136；预制体会保存到“自动创建的预制体目录”（可在面板中选择 `assets` 下的任意子目录）。这类导入不会并入当前选中的场景或预制体：插件只在当前场景中短暂创建序列化用临时根节点，生成 `.prefab` 后立即销毁并自动打开、选中新预制体；旧版本遗留的导入根节点也会按导入映射清理，避免切换预制体时出现无法选中的顶层残影。

普通文件导入始终从当前场景的 Canvas 根节点开始，不会读取或修改当前选中的场景节点、预制体节点；Frame 链接则直接创建独立预制体。若要把导入结果作为子节点使用，请在预制体打开后从资源管理器拖入目标场景。

资源输出目录用于存放最终导入 Cocos 的 PNG / SVG，可在面板中选择项目 `assets` 下的子目录，不再追加文件级子目录。资源直接使用 Figma 节点名，只替换文件系统不允许的字符；同名节点复用首次导入的资源，不再生成哈希或倍率后缀。

“本地同名资源目录”是可选的素材来源，不是输出目录，最多可填写 3 个目录。插件按第 1、2、3 项顺序递归查找与 Figma 节点同名的 PNG / SVG，某个目录命中后立即停止；文件位于当前项目 `assets` 内时直接绑定原 SpriteFrame，外部文件或需要独立九宫格元数据时复制到资源输出目录；全部未命中时才从 Figma 下载。每个目录都可以单独清空。下载缓存由插件在项目临时目录中自动维护，不需要手动配置。

## 节点策略

- 生成：转换为 `UITransform`、`Graphics`、`Label`、`Layout`、`Button`、`ScrollView`、`Mask` 等可编辑组件。
- PNG 整层：由 Figma 把当前节点及其子树渲染为一张 PNG，再导入 `SpriteFrame`；该节点的设计子层不会重复生成。
- 矢量节点：面板显示为“PNG Sprite”，通过 Figma PNG 渲染后导入 `Sprite`，不会用 `cc.Graphics` 近似任意矢量路径；它只渲染当前矢量节点，不会压平父节点子树。
- 更新：只更新已映射节点的几何与可见性。
- 九宫格：把识别到的三宫/九宫节点导入为 `Sprite.Type.SLICED`，切片边界写入 SpriteFrame 元数据。
- 忽略：不创建当前节点及其整棵子树。

文字节点始终按 Cocos `Label` 导入，不会因为渐变、阴影或复杂填充而导出 PNG 切图。字体描边直接写入 `Label.enableOutline`、`Label.outlineColor` 和 `Label.outlineWidth`，不再添加额外的 `LabelOutline` 组件。所有文字使用 `Label.Overflow.NONE`：无显式换行符的单行文字按 Figma 参考框水平、竖直居中；包含显式换行符的多行文字按参考框左上对齐。插件先加载映射字体，再让 Cocos 完成最终字体度量和位置补偿。Cocos 3.8.7 在 `NONE` 下会强制关闭自动换行，因此 Figma 自动折行但没有手动换行符的文本会在面板显示警告。启用本地同名资源目录时，如果一个容器节点自身命中同名 PNG 资源，会把该资源作为整层 Sprite 使用，并跳过其内部子节点导入。

节点类型使用 Cocos 组件语义：`Node`、`Sprite`、`Label`、`Button`、`ScrollView`、`Layout`。滚动节点使用 `ScrollView → view（Mask）→ content（Layout）` 标准结构。

所有导入节点以及 ScrollView 自动生成的 `view/content` 都在建树时直接使用 Cocos 默认中心锚点 `(0.5, 0.5)`。插件会依据父节点实际锚点、尺寸和原始 Figma 左上坐标计算中心位置，不经过导入后的二次调整；当滚动内容大于视口时，会先确定 content 最终尺寸并补偿位置，使它的左上边界始终与 view 对齐。

“PNG 整层”是唯一的子树压平动作，旧版“合并子树”配置会自动兼容为“PNG 整层”。智能模式默认保留容器层级，但会识别设计素材边界：非最外层容器自身为严格的多段 `snake_case`（如 `img_hongbao_bg_mini`），且至少一个直接可见子层不是同类结构化命名（如 `Group 91`、`Frame 92`、`Ellipse 5`）时，在该容器处自动改为 PNG 整层。只检查直接子层，最外层节点、隐藏噪声和 Figma 明确设置的 ScrollView 不参与此规则，避免祖先级联压平或破坏滚动功能。分层高保真仍保留容器，只渲染叶子节点。

Figma 中手动配置了非空 Export 设置的可见非文字节点，会被视为设计者明确指定的资源边界：智能模式默认选择“PNG 整层”并抑制其设计子树。该显式规则同样作用于最外层节点和 Figma 明确设置的 ScrollView；隐藏节点在智能模式下仍默认“忽略”，文字节点仍保持可编辑 `Label`，空 Export 数组不触发。Export 中的 JPG/PNG/SVG/PDF 格式、后缀及 SCALE/WIDTH/HEIGHT 约束仅用于表明“人工设置过 Export”，插件实际统一请求 PNG，并使用插件“导入倍率”（默认 `1`），不会套用 Figma Export 自带倍率。

可安全表达的 Figma Auto Layout 会映射为 Cocos `Layout`；混合绝对定位、尺寸不一致的 Wrap/Grid 会保留为 `Node` 和绝对几何，避免 Cocos Layout 重排后破坏画面。裁剪只映射为 `Mask`；智能模式只有在 Figma 明确设置滚动溢出方向时才映射为 `ScrollView`，`list_`、`scroll_` 等业务命名不会擅自改变节点层级。需要预留运行时滚动但设计稿没有设置溢出时，可在节点策略中手动选择 `ScrollView`。Figma Constraints 暂不自动映射为 `Widget`，导入后由用户在 Cocos 中手动配置。

## Token 安全

- Token 只在扩展主进程中使用，面板不会读取或回显已保存 Token。
- 支持系统加密时，扩展使用 Electron `safeStorage` 加密，仅将密文写入 Cocos 本地配置。
- Windows 使用 DPAPI；macOS 使用系统钥匙串；Linux 检测到 `basic_text` 后端时拒绝持久化。
- 系统加密不可用时，Token 仅保留在当前编辑器会话。
- Token、明文或解密结果不会写入项目目录、资源、日志或节点数据。
- 内部图片缓存只保存 PNG / SVG 字节，文件夹和文件名都使用哈希键，不包含 Token、Figma fileKey 或 nodeId 明文。

## 字体映射

读取 Figma 后，面板会列出检测到的 `fontFamily`，并递归扫描项目 `assets` 下的 `.ttf`、`.otf`、`.fnt`、`.woff` 字体资源。文件名与 Figma 字体名规范化后完全或部分匹配时会自动选中；未匹配项可直接在每一行下拉框中手动选择项目字体，不需要填写 `db://` 路径或操作系统绝对路径。未映射字体使用 Cocos 默认字体，不会阻塞导入。

## 开发与验证

```bash
npm run build
npm test
```

测试覆盖 Figma URL、全页面解析、缺失边界保护、Cocos 节点类型分析、安全 Auto Layout 降级、真实尺寸三/九宫边界、本地同名资源、内部缓存、Token 安全和渐变 SVG。
