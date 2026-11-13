# Prefab 参数引用：Creator 3.8.7 隔离验证

历史原生位置/尺寸验证日期：2026-11-12（1.0.65）。验证在仓库 `node_modules/.prefab-probe/` 下的独立工程和独立 Creator home/user-data 中执行，未向用户正在使用的项目发送消息，也未改写其资源。探针进程已退出。1.0.66 的前缀条件更正没有重跑该尺寸探针；2026-11-13 另有独立原生 Scale 保存探针，见 [Scale 持久化证据](./prefab-scale-creator387.md)。两组探针都不代表当前 Figma 母组件 REST 链路已经完成真机端到端验证。

## 1.0.67 Button ZoomScale 1.15 与 Figma 母组件倍率（2026-11-13）

普通带 prefab TEXT 参数的 INSTANCE，使用 Figma 实例与真正 main component 的未旋转 size 分别计算 X/Y 倍率，允许非等比。最终 Scale XY 为源引擎 Prefab authored Scale XY × 对应 Figma 倍率 × 全局 importScale；Z 和源镜像符号保留，实例根 UITransform 宽高不改写。主组件定义自身按 `1×1`。Popup 前缀优先按 Figma 宽高×importScale 写实例根宽高，不额外叠加母组件 ratio。

母组件从当前文件读取，远程定义通过 component key → getComponent 元数据 → `meta.file_key/node_id` 定位。母组件缺失、无权限、零尺寸等情况保持当前 Scale 并提示，不猜引擎比例或回退绝对尺寸 fit。ratio 是每节点 SceneNodeSpec 数据，不能写入共享 PrefabAssetSpec；源 UI/Scale 只读并复制数值，缓存仅限单次导入，每次从源重算不累乘，提示回传 main/review/batch。

生成或设置的 Button 使用 SCALE、`zoomScale=1.15` 和原有 `duration=0.1`，不扫描修改引用 Prefab 内部 Button。下文历史证据覆盖位置与根 UITransform 宽高；独立 Scale 探针覆盖 `_lscale` 保存/重开与源数据保持。Scale 探针中的旧 fit 函数只用于生成测试 Vec3，不验证当前母组件解析、各轴倍率、全局倍率组合或 Button 动画；这些范围不能被标记为真机端到端已验收。

## 1.0.66 参数前缀条件更正（2026-11-13）

本版更正后的 Popup 条件继续适用：本次导入中带有效 `prefab` TEXT 参数、通过资源预检且实际引用的节点，其参数值经过空白清理、NFKC 和大小写归一后，以 `popup` 开头时按 Figma 未旋转宽高 × 导入倍率调整实例根宽高。`Popup`、`PopupCell`、`PopupWhatever` 均在范围内；当时其他普通引用保持原尺寸，现已由 1.0.67 增加 Figma 母组件各轴倍率。判断不采用 Figma 节点显示名或脚本继承，无参数节点和源 Prefab 资源不改写。

1.0.66 的完整自动回归为 651/651，Cocos/MCP 构建及分发检查通过，包含前缀引用首次创建、重复导入更新和面板说明；用户指定扩展目录的 64 个运行文件已同步并通过哈希校验。

本次条件的自动回归与下文原生证据分开：下文证明实例根位置/尺寸覆盖能保存、重开并保持源关联，不证明前缀识别条件。前缀、规范化和不命中范围由本次代码回归核对。

## 实际 Figma 属性

读取用户指定的组件库节点 `2003:14411`（CommonItemIcon），确认它是 INSTANCE，属性为：

```json
{ "prefab#2003:2": { "type": "TEXT", "value": "CommonItemIcon" } }
```

其主组件 `412:9804` 的同名定义为 TEXT，默认值同样为 CommonItemIcon。当前项目中存在同名 Prefab；这里只读核对名称和内容，没有导入到用户项目。

## 原生创建入口

实测必须显式传入 `type: 'cc.Prefab'`：

```js
await cce.SceneFacadeManager.createNode({
  parent: host.uuid,
  assetUuid: templateUuid,
  type: 'cc.Prefab',
  autoAdaptToCreate: false,
  unlinkPrefab: false,
  snapshot: false,
  nameIncrease: false,
});
```

不传 type 时，节点会被转换为宿主的普通节点，源资源关联丢失。运行时 API 源码明确在 type 不为 cc.Prefab 或 unlinkPrefab 为 true 时移除 PrefabInfo。实现继续核对 source UUID、root 和 instance.fileId，不对失败结果伪造链接。

实现另显式关闭 Creator 的 autoAdaptToCreate；类型声明说明其用于按 2D/3D 选择创建组件。2026-11-12 的尺寸探针使用其默认值，2026-11-13 的独立 Scale 探针显式传 false 后通过原生创建和保存重开。没有单独证明该选项会缩放 Prefab，也不将其作为保持原尺寸的因果依据。

## 保存、重开和尺寸

1. 独立工程导入 ProbeHost 和 ProbeTemplate。
2. 在 Host 内原生创建 Template 实例，记录实例 ID 和源 fileId。
3. 将实例根位置设为 (0, 0, 0)，宽高设为 200×120，模拟 Popup 参数引用的根宽高调整。
4. 保存 Host，打开 Template，再重新打开 Host。
5. 核对源 UUID、源 fileId、instance.fileId 均保持，根位置仍为 0/0，宽高仍为 200×120。
6. Template 自身位置仍为 10/20，宽高仍为 100×50；源模板文件未被修改。

Creator 自动把位置和根 UITransform 宽高记入 PrefabInstance.propertyOverrides，不需要手工拼接覆盖数据。实际保存的稀疏节点结构已进入回归夹具：

- `tests/fixtures/prefab-reference/creator-3.8.7/host.prefab`
- `tests/fixtures/prefab-reference/creator-3.8.7/template.prefab`

补充探针验证了新建定位节点作为 parent 的场景：节点挂到 Host 后由 Creator 自动登记外层 PrefabInfo；在其下创建实例、保存与重开后，定位节点、内部实例关联和尺寸均保持。没有声称验证强行清空 PrefabInfo 的人为状态。

1.0.65 的自动测试验证该实际序列化结构能通过来源/附件审计，链接被改写后会被拒绝；参数解析、资源剪枝、双实例、重复导入、切换/删除及未知实例保护由独立回归覆盖。当前 Popup 参数值前缀条件适用上节的 1.0.66 更正。

此探针验证原生创建、尺寸覆盖、保存与重开的契约；未将用户业务项目的脚本和最终视觉效果标记为已验收。

历史 1.0.65 最终完整 `npm test` 649/649 通过，含 Cocos/MCP 类型、构建和分发门禁。此数字不代表后续版本的验证结果；真实序列化夹具对比之外，不对运行时自动重算布局的所有业务组件作泛化保证。
