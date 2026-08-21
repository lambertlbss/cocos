# Creator 3.8.7 隔离探针证据

- 日期：2026-08-21
- Creator：3.8.7
- 插件：`figma-importer-cocos@1.0.27`，分支 `codex/figma-cocos-roundtrip`
- 工程：由 `tests/fixtures/creator387-project/` 复制到一次性系统临时目录；未打开或修改业务工程 Prefab
- Fixture UUID：`2d63d5c0-9a46-42ae-bda6-b17f784889cc`

## 可复核结果

AssetDB worker 日志：

```text
2026-8-21 12:21:03-debug: run package(figma-importer-cocos) handler(enable) success!
2026-8-21 12:21:24-debug: Migrate: <TEMP>/assets/roundtrip-fixture.prefab(1.1.43)
2026-8-21 12:21:24-debug: Migrate: <TEMP>/assets/roundtrip-fixture.prefab(1.1.46)
2026-8-21 12:21:24-debug: Import: <TEMP>/assets/roundtrip-fixture.prefab
2026-8-21 12:21:24-debug: Run asset db hook engine-extends:afterStartDB success!
```

导入后 UUID 证据：

- `library/.assets-data.json` 包含 UUID key。
- `library/.assets-info.json` 包含同一 UUID。
- 针对 `figma-importer-cocos` 的 error/fail 日志检索结果为 0。

源文件 SHA-256：

- Prefab：`5188f5aa4e7cc663c46cd92f48ce1434a8f4eef57eae4de3cdc1526ebeece393`
- Meta：`dd2e00e4a599a2d3ca7ff70afc5ed56acc10efc4063511d8ea324c69263b0fde`

`tests/roundtrip-protocol.test.js` 会持续验证仓库内 fixture 的 UUID、PrefabInfo fileId、CompPrefabInfo fileId 与上述 hashes，避免证据文件被无意改写。

## 结论与边界

初次探针证明 Creator 3.8.7 能加载当前扩展，并能迁移、导入所提交的真实 Prefab/meta fixture。

## Raw Writer + AssetDB 实测

第二个全新隔离副本加载 `tests/fixtures/creator387-probe-extension/`，由 Creator 主进程实际执行以下链路：

1. `asset-db/query-asset-info` 以 UUID 查询到唯一目标：`db://assets/roundtrip-fixture.prefab`、`importer=prefab`、`type=cc.Prefab`、`imported=true`、`invalid=false`。
2. scene 扩展在服务 ready 后触发主进程探针；`query-is-ready` 与 `query-nodes-by-asset-uuid` 得到 `{safe:true}`，Writer 获锁后复查仍通过。
3. 建立 generation 1 genesis ledger。
4. 以 stable node/component fileId 生成并应用 `set-position-xy` 与 `set-content-size`。
5. 调用 Creator AssetDB `reimport-asset`，从磁盘重新解析并执行 preserve/postimage audit。
6. journal/receipt 均为 committed，ledger generation 为 2，`lastTxnId=creator387-probe-apply`。

结果摘要：

```text
position: (10, 20) -> (35, 20)
contentSize: (100, 50) -> (125, 50)
preimage:  sha256:5188f5aa4e7cc663c46cd92f48ce1434a8f4eef57eae4de3cdc1526ebeece393
postimage: sha256:f986c153bd4eb23eb4fce6986c9021e2ff04c68785c391dc00f38728a94d294a
meta/current/backup: sha256:dd2e00e4a599a2d3ca7ff70afc5ed56acc10efc4063511d8ea324c69263b0fde
receipt: committed
ledger: generation 2
```

Exact backup Prefab hash 等于 preimage；当前 Prefab hash 等于 postimage；meta 当前值与 backup 完全一致。AssetDB 日志记录初次 Import 和事务 reimport 两次导入，并记录 `roundtrip-s0-probe` enable success。

本证据仍未覆盖 SpriteFrame sub-asset 写入、Prefab 打开/实例化、自定义脚本/事件/未知组件的复杂 fixture 或 Figma REST 联合链路，因此不能单独关闭 G2。

## Exact-byte restore reconfirmation

另一次稳定隔离工程探针执行单个 `set-content-size`，Creator 主进程加载
`roundtrip-live-reimport-probe@1.0.0` 并转交真实
`Editor.Message.request('asset-db', 'reimport-asset', assetUrl)`。Creator library
实际观察到 width `100 → 123 → 100`；事务 committed 后，测试恢复 preimage 并再次
reimport，最终 Prefab hash 回到
`sha256:812c36076ee992e65f8ccbe98e44a6a6cfd0c429708d0f2e4ebb8e880ddde079`。

```json
{"status":"PASS","creatorVersion":"3.8.7","transaction":"committed","operation":"set-content-size","creatorObservedWidth":123,"restoredWidth":100,"restoredPrefabHash":"sha256:812c36076ee992e65f8ccbe98e44a6a6cfd0c429708d0f2e4ebb8e880ddde079"}
```
