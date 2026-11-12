# Prefab 参数引用：Creator 3.8.7 隔离验证

日期：2026-11-12。验证在仓库 `node_modules/.prefab-probe/` 下的独立工程和独立 Creator home/user-data 中执行，未向用户正在使用的项目发送消息，也未改写其资源。探针进程已退出。

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

实现另显式关闭 Creator 的 autoAdaptToCreate；类型声明说明其用于按 2D/3D 选择创建组件，该选项有本地声明和运行时传递证据。保存重开探针使用其默认值，false 参数由调用回归覆盖；没有证明该选项会缩放 Prefab，也不将它作为保持原尺寸的证据。

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

自动测试验证该实际序列化结构能通过来源/附件审计，链接被改写后会被拒绝。参数精确匹配、资源剪枝、双实例、重复导入、切换/删除、未知实例保护、Popup 与 PopupCell 的区别由独立回归覆盖。

此探针验证原生创建、尺寸覆盖、保存与重开的契约；未将用户业务项目的脚本和最终视觉效果标记为已验收。

本轮最终完整 `npm test` 649/649 通过，含 Cocos/MCP 类型、构建和分发门禁。真实序列化夹具对比之外，不对运行时自动重算布局的所有业务组件作泛化保证。
