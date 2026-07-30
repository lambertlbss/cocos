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

导入资源默认位于 `assets/figma-importer/file-<hash>`。再次导入同一文件时，扩展会使用项目级 UUID 映射更新原节点；节点名称不会附加 Figma ID。

## 节点策略

- 生成：转换为 `UITransform`、`Graphics`、`Label`、`Layout`、`Button`、`ScrollView`、`Mask`、`Widget` 等可编辑组件。
- PNG：由 Figma 渲染后导入 `SpriteFrame`，适合图片填充、阴影和复杂效果。
- SVG：保留矢量清晰度。
- 合并：把当前节点及其子树合并为一张 PNG。
- 更新：只更新已映射节点的几何与可见性。
- 九宫格：把识别到的三宫/九宫节点导入为 `Sprite.Type.SLICED`，切片边界写入 SpriteFrame 元数据。
- 忽略：不创建当前节点；其未被抑制的子节点仍可独立导入。

Figma Auto Layout 会映射为 Cocos `Layout`，裁剪和溢出映射为 `Mask` / `ScrollView`，Constraints 映射为 `Widget`。多个 Figma 页面会在同一导入根节点下横向排列，避免页面重叠。

## Token 安全

- Token 只在扩展主进程中使用，面板不会读取或回显已保存 Token。
- 支持系统加密时，扩展使用 Electron `safeStorage` 加密，仅将密文写入 Cocos 本地配置。
- Windows 使用 DPAPI；macOS 使用系统钥匙串；Linux 检测到 `basic_text` 后端时拒绝持久化。
- 系统加密不可用时，Token 仅保留在当前编辑器会话。
- Token、明文或解密结果不会写入项目目录、资源、日志或节点数据。

旧 Godot 版本曾在 `resources/settings.tres` 中保存明文 Token。该文件已从项目移除；若该 Token 曾提交或共享，请立即在 Figma 中撤销并创建新 Token。

## 字体映射

“导入设置”支持 JSON 字体映射，值必须是 Cocos Asset Database URL：

```json
{
  "Inter": "db://assets/fonts/Inter.ttf",
  "Noto Sans SC": "db://assets/fonts/NotoSansSC.ttf"
}
```

未映射字体使用 Cocos 默认字体，不会阻塞导入。

## 开发与验证

```bash
npm run build
npm test
```

测试覆盖 Figma URL、全页面解析、缺失边界保护、动作分析、九宫格候选检测和渐变 SVG 生成。
