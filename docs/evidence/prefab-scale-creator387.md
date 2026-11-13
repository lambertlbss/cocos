# Prefab Scale：Creator 3.8.7 隔离保存与重开证据

验证日期：2026-11-13，完成时间约 11:00（Asia/Shanghai）。独立工程、Creator home 和 Electron user-data 全部位于仓库忽略目录 `node_modules/.scale-probe/`，探针使用单独隐藏进程；未打开用户业务工程、向生产 IPC 发消息或操作用户现有窗口。探针自然退出，收尾查询带专属目录的 Creator 进程为 0。

## 已验证的原生契约

1. AssetDB 导入独立的 ScaleHost 与 ScaleTemplate。源模板根 UITransform 为 `100×50`，Scale 为 `(1.5, 0.75, 1)`。
2. 在 scene 进程执行 `cc.assetManager.loadAny({ uuid }, callback)`，从返回 Prefab 的 `data.getComponent(UITransform)` 和 `data.scale` 读取源值，并立即复制 Scale x/y/z 数值。读到的源根不是场景实例。
3. 新建定位节点并挂到 Host，其外层 PrefabInfo 由 Creator 自动登记。调用 `cce.SceneFacadeManager.createNode`，显式传 `type:'cc.Prefab'`、`autoAdaptToCreate:false`、`unlinkPrefab:false`、`snapshot:false` 和 `nameIncrease:false` 创建原生关联实例。
4. 对实例调用 `setPosition(0,0,0)` 与 `setScale(3,1.5,1)`；同一只读源快照重复计算并应用一次，Scale 仍为 `(3,1.5,1)`，没有累乘。实例根 UITransform 始终为 `100×50`。
5. 保存 Host，打开源模板，再重新打开 Host。源 UUID、源 fileId 和 instance.fileId 保持，重开实例 Scale 仍为 `(3,1.5,1)`，根宽高仍为 `100×50`。
6. 再次 loadAny 读取源数据，模板根宽高仍为 `100×50`、Scale 仍为 `(1.5,0.75,1)`。源 Prefab 和 Meta 前后 SHA-256 相同。

Creator 自动生成并保存原生 `PrefabInstance.propertyOverrides`，其中包含以下字段；探针没有手工拼接 override：

```json
{
  "__type__": "CCPropertyOverrideInfo",
  "propertyPath": ["_lscale"],
  "value": { "__type__": "cc.Vec3", "x": 3, "y": 1.5, "z": 1 }
}
```

## 源文件字节核对

初始导入和迁移完成后、实例变更前记录 preimage；保存、切换和重开后记录 postimage。两次值如下，均逐字节一致：

| 文件 | preimage 与 postimage SHA-256 |
|---|---|
| ScaleTemplate.prefab | `528d0b8cf8a0c9a4d5d0a5405986d1e30635d86085a02a427aab3bd4e6f1bec7` |
| ScaleTemplate.prefab.meta | `061cacf76d48beabe135cc35e80ec715e39236b37e3e945cc02bdc1bfa72dae9` |

前一轮 `node_modules/.prefab-probe/` 中的 carrier 通过结果、Host 序列化及 API 源码证据已先备份，本轮结束后核对三项 SHA-256 均未变化。

## 与 1.0.67 母组件倍率和 Button 的边界

最终完整自动回归为 683/683，Cocos/MCP 类型、构建和分发检查通过；1.0.67 已同步指定扩展目录，66 个运行文件通过 SHA-256 核对。

当前普通引用规则是 Figma 实例未旋转 size / 真正母组件 size 的各轴倍率，乘引擎 Prefab authored Scale XY，再乘全局 importScale；两轴可以不同，Z 和源镜像保留。母组件定义自身按 `1×1`。本轮探针运行期间使用的旧尺寸 fit 函数只用于生成固定测试 Scale Vec3；该旧算法已被替换，不能把本页结果解释为当前 Figma REST 母组件解析和倍率算法的真机端到端验收。

本页证明 `instance.setScale` 能保存为原生 `_lscale` 覆盖、重开保持、loadAny 源数据与实例隔离及源文件字节保持。它没有验证本地/远程 component key 到 `file_key/node_id` 的读取、缺失/权限/零尺寸降级、全局倍率组合、完整 Figma 导入流程、Button ZoomScale 1.15 动画或业务脚本的最终视觉。

Popup 前缀仍按 Figma 宽高优先，不额外叠加母组件 ratio；生成或设置的 Button 为 SCALE、ZoomScale 1.15、duration 0.1，引用 Prefab 内部 Button 不扫描修改。这些产品规则与本页原生持久化证据分开记录。

## 本机复核材料

原始输出位于忽略目录，不作为可安装扩展内容：

- `node_modules/.scale-probe/summary.json`：范围、输入、Scale、源哈希、旧证据核对及进程结果。
- `node_modules/.scale-probe/scale-pass-result.json`：loadAny、两次应用、序列化 override、源模板和重开实例快照。
- `node_modules/.scale-probe/scale-pass-host.prefab` 与 `scale-pass-template.prefab`：实际保存结果。
- `node_modules/.scale-probe/scale-pass-stdout.log`：独立 Creator 日志。

最小模板只包含原生根节点和 UITransform，不包含用户业务脚本、事件或复杂适配组件。更早的位置/根宽高证据见 [Prefab 参数引用验证](./prefab-reference-creator387.md)。
