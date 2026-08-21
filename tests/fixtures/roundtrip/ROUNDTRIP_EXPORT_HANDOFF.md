# Round-trip Export Handoff

- Protocol: `cocosfigmabridge`, schema v1
- Exporter branch: `codex/cocos-figma-roundtrip`
- Producer version: derived from `package.json` as `0.9.0+roundtrip`
- Frozen files: `tests/fixtures/roundtrip/protocol-manifest.json`
- Implementation: `src/shared/roundtrip-protocol.ts`, `canonical-json.ts`,
  `geometry-roundtrip.ts`, `roundtrip-safety.ts`
- Consumer target: `C:\Users\lanbosheng\Desktop\figma_importer`

P0 writable fields are `position.xy`, `contentSize.wh`, and explicit
`spriteFrame.uuid`. Nested Prefab internals, weak identities, structure, Layout/Widget-owned
geometry, rotation, negative/non-unit scale, and unsupported sprite modes are read-only.

Local verification commands:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The S0 external evidence listed in `docs/adr/roundtrip-export-s0.md` is still required before
this handoff can be called G0 frozen or copied into the consumer repository.
