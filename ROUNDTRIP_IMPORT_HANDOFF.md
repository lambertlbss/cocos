# Round-trip Import Handoff

## 当前状态

- 协议：v1，`cocosfigmabridge` Shared Plugin Data；exporter manifest 与 fixtures byte-for-byte 兼容。
- 实现：T01–T10 代码候选已接线，分支 `codex/figma-cocos-roundtrip`。
- 自动化：104/104；原 68 项单向导入回归全部通过。
- Creator：3.8.7 隔离启动、扩展启用、AssetDB UUID 查询、scene target-safe 门禁、position/contentSize raw write/reimport/post-audit/commit 已通过。
- Gate：G0 已具备代码证据；G1/G2 仍需真实 Figma 文档与完整 Creator 联合用例，不声明“双向同步完成”。

## P0 能力矩阵

| 能力 | 状态 | 安全约束 |
|---|---|---|
| 完整 Figma file + shared plugin data | 已实现 | 当前版本、完整文件、严格 root/chunk/schema/fingerprint |
| Pair/Adopt | 已实现 | source/meta exact hash、B/C 与 F structure 证据、短期 token |
| B/F/C Diff3 | 已实现 | 5 个 scalar leaf，冲突/不支持导致整单零写入 |
| position x/y | 已实现 | stable direct node + PrefabInfo fileId |
| contentSize width/height | 已实现 | 唯一且稳定 UITransform locator |
| SpriteFrame UUID | 已实现 | explicit rebind、paint proof、SIMPLE + CUSTOM、AssetDB type 校验 |
| 原子事务与回滚 | 已实现并完成简单 Creator 实测 | backup、journal、fsync/replace、reimport、post-audit、ledger commit |
| 崩溃恢复 | 已实现 | commit 前恢复 preimage；ledger 已提交则补全 receipt |
| 编辑器目标状态 | 已实现（保守） | 目标 Prefab 被 scene 查询为已加载或状态不可验证时阻断 |
| 新增/删除/reparent/嵌套写 | 不支持 | P0 fail closed |

## 运行与恢复

项目状态位于 `<project>/.cocos-figma-sync/`，不进入 `assets`。启动时扫描 prepared journals：活动 owner 保持阻断；dead owner 在锁所有权、ledger generation 与 pre/post hashes 可证明时恢复或补全提交。任何证据损坏都 fail closed，不猜测修复。

建议团队自行决定是否版本化 `ledger.json` 与 `baselines/`；插件不会修改 `.gitignore`。`backups/`、`locks/`、`journals/`、`receipts/` 通常作为本地运行状态。

## 尚需外部完成

1. 使用真实 exporter 生成的 Figma 文件验证 Desktop 重开后 Shared Plugin Data 与 REST `plugin_data=shared`。
2. 在 Creator 3.8.7 对简单 Sprite、脚本/事件/未知组件、多层/嵌套/Layout/Widget/九宫格三类 fixture 跑方案第 14 节 18 项用例。
3. 补齐 SpriteFrame sub-asset、Prefab 打开/实例化、复杂脚本/事件引用及 pre/post semantic diff；UUID API 与 position/contentSize raw write/reimport 已有证据。
4. 补齐 crash kill/restart 多阶段子进程证据后再判定 G2。

Creator 隔离探针见 `docs/evidence/creator387-isolated-probe.md`；Writer 决策见 `docs/adr/roundtrip-writer-s0.md`。
