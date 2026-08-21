# Round-trip Writer S0：Raw Prefab Copy-on-write

- 状态：`IMPLEMENTED_CANDIDATE`；Creator 启动/导入证据已归档，完整 Creator/Figma 联合证据仍待完成
- 日期：2026-08-21
- 分支：`codex/figma-cocos-roundtrip`

## 决策

P0 选择 Raw Prefab Copy-on-write，不复用现有完整导入或 `scene.ts` rebuild 路径。

Writer 先按稳定 `cc.PrefabInfo.fileId` 与组件 locator 在内存克隆中定位，只允许修改：

- `cc.Node._lpos.x/y`
- `cc.UITransform._contentSize.width/height`
- `cc.Sprite._spriteFrame.__uuid__`

写入采用同目录临时文件、文件 fsync、原子 rename、AssetDB reimport 和写后重新解析审计。目标 Prefab 与 `.meta` 在项目根 `.cocos-figma-sync/backups/` 保存 exact-byte 备份；任一步失败均恢复两份原字节并再次 reimport。Writer 运行时硬锁 Cocos Creator `3.8.7`。

## 选择理由

- Raw backend 可以在写前、写后和 rollback 后调用同一个序列化 projection，机器化证明脚本、未知组件、节点结构以及白名单外字段没有变化。
- 不需要打开 Prefab 场景或经过组件重建，因此不会触发现有完整导入逻辑、节点生命周期或选中状态。
- preimage hash、component fingerprint、preserve projection、ledger generation 和 Figma version 可在同一排他事务内复核。

Strict Scene Patch 暂不选用。它需要证明 Prefab dirty-state、保存时机、序列化稳定性和编辑器当前打开 Prefab 的交互，不适合作为 P0 唯一后端。

## 已通过的本地证据

- 冻结 manifest 逐文件 SHA-256、canonical JSON/hash、Geometry v1 与 1,000 组正逆向量。
- Figma full-file `plugin_data=shared`、managed root/manifest/fingerprint/chunk fail-closed 读取。
- Cocos stable node/component locator、UUID/meta/realpath containment 和白名单外 preserve projection。
- 逐 leaf Diff3、未应用轴保留 Cocos 当前值、幂等与冲突/只读阻断。
- 原子写、immutable backup、exact rollback、排他锁、dead-owner 启动恢复。
- 故障注入：reimport 失败后 Prefab exact bytes 恢复，ledger generation 不前进。
- 崩溃边界：ledger 已提交但 receipt/journal 尚未收尾时，启动恢复依据 txnId、generation 和 postimage 补全 committed 状态，不回滚已提交 Prefab。
- 目标 Prefab 编辑器状态在 preview 和 Writer 获锁后各检查一次；无法证明未加载时 fail closed。
- 隔离 Creator 3.8.7 工程中扩展 handler 启用成功，fixture 经迁移后由 AssetDB 导入；UUID API 唯一定位 `db://assets/roundtrip-fixture.prefab`，position/contentSize raw patch 经真实 reimport 和 post-audit 后 committed，ledger generation 1 → 2；见 `../evidence/creator387-isolated-probe.md`。
- 全量 `npm test`：104/104；原单向导入回归保持通过。
- 导出端与写回端的 manifest、schema、canonical/hash、geometry 和 Creator 3.8.7
  实物夹具逐文件 SHA-256 对比为 10/10 一致。
- 导出端构建后的 Round-trip UI 已通过 headless Edge/Playwright 可见烟测；原生
  Figma 文件重开验证仍受桌面自动化桥接错误阻断，未在业务文件上继续注入输入。

## 尚未关闭的外部门禁

以下证据未完成前不得把状态称为 G2 或“双向同步完成”：

1. Creator 3.8.7 中 Prefab 打开/实例化及复杂脚本/事件引用验证（UUID API 查询和 position/contentSize raw write/reimport 已通过）。
2. 三组真实 Prefab：简单 Sprite、脚本/事件/未知组件、Layout/Widget/嵌套/九宫格只读降级。
3. Figma Desktop 重开后 Shared Plugin Data 保留，以及 REST `plugin_data=shared` 脱敏响应。
4. 方案列出的 18 项真机用例与 40 项自动化场景证据归档。

当前实现可以继续接受代码级测试和隔离工程测试；外部证据缺失时只能报告“实现候选已完成”，不能报告最终验收完成。
