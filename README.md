# Figma Importer for Cocos Creator

面向 Cocos Creator 3.8.7 的 Figma UI 导入扩展。它可以把 Figma 文件或单个节点转换为可编辑的 Cocos UI 节点树，也可以按节点选择 PNG、SVG、合并渲染、九宫格或增量更新。

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
5. 选择场景中的目标节点；未选择时会自动导入到 Canvas。
6. 点击“导入到场景”。

带 `node-id` 的 Figma Frame 链接会按独立预制体导入：最外层 Frame 作为 Prefab 根节点，并使用该 Frame 名称作为 `.prefab` 文件名；根节点挂载对应尺寸的 `UITransform`，并自动放置在 Canvas 参考边界中心。当前项目参考画布为 640×1136；预制体会保存到“自动创建的预制体目录”（可在面板中选择 `assets` 下的任意子目录），导入完成后可在 Cocos 资源管理器中直接复用。

“导入到当前选中节点”只针对当前已经打开的场景或预制体编辑模式中的 Node。若要修改某个预制体，需要先双击该预制体进入预制体编辑模式，再选择预制体根节点或目标子节点；仅在资源管理器中选中 `.prefab` 文件不会直接修改它。

资源输出目录用于存放最终导入 Cocos 的 PNG / SVG，可在面板中选择项目 `assets` 下的子目录，不再追加文件级子目录。资源直接使用 Figma 节点名，只替换文件系统不允许的字符；同名节点复用首次导入的资源，不再生成哈希或倍率后缀。

“本地同名资源目录”是可选的素材来源，不是输出目录，最多可填写 3 个目录。插件按第 1、2、3 项顺序递归查找与 Figma 节点同名的 PNG / SVG，某个目录命中后立即停止；文件位于当前项目 `assets` 内时直接绑定原 SpriteFrame，外部文件或需要独立九宫格元数据时复制到资源输出目录；全部未命中时才从 Figma 下载。每个目录都可以单独清空。下载缓存由插件在项目临时目录中自动维护，不需要手动配置。

## 节点策略

- 生成：转换为 `UITransform`、`Graphics`、`Label`、`Layout`、`Button`、`ScrollView`、`Mask`、`Widget` 等可编辑组件。
- PNG：由 Figma 渲染后导入 `SpriteFrame`，适合图片填充、阴影和复杂效果。
- 矢量节点：通过 Figma PNG 渲染后导入 `Sprite`，不会用 `cc.Graphics` 近似任意矢量路径。
- 合并：把当前节点及其子树合并为一张 PNG。
- 更新：只更新已映射节点的几何与可见性。
- 九宫格：把识别到的三宫/九宫节点导入为 `Sprite.Type.SLICED`，切片边界写入 SpriteFrame 元数据。
- 忽略：不创建当前节点；其未被抑制的子节点仍可独立导入。

文字节点始终按 Cocos `Label` 导入，不会因为渐变、阴影或复杂填充而导出 PNG 切图。启用本地同名资源目录时，如果一个容器节点自身命中同名 PNG 资源，会把该资源作为整层 Sprite 使用，并跳过其内部子节点导入。

节点类型使用 Cocos 组件语义：`Node`、`Sprite`、`Label`、`Button`、`ScrollView`、`Layout`。滚动节点使用 `ScrollView → view（Mask）→ content（Layout）` 标准结构。

“智能”和“分层高保真”都会保留容器层级；后者只把叶子节点渲染为 PNG / SVG。只有手动把带子节点的容器设为“PNG 整层”或“合并子树”时，子节点才不会单独生成。

可安全表达的 Figma Auto Layout 会映射为 Cocos `Layout`；混合绝对定位、尺寸不一致的 Wrap/Grid 会保留为 `Node` 和绝对几何，避免 Cocos Layout 重排后破坏画面。裁剪映射为 `Mask`，明确的溢出或 `list_` / `scroll_` 命名映射为 `ScrollView`，Constraints 映射为 `Widget`。

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
