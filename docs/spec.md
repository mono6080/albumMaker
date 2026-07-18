# （已拆分）album_maker — Architecture Spec

本檔已依 SSOT 原則拆分至 `docs/dev/`，各主題的唯一真相來源如下
（完整地圖見 [CLAUDE.md](../CLAUDE.md#文件地圖)）：

| 原章節 | 現在的家 |
|--------|----------|
| §1 Overview / §2 Stack | [dev/architecture.md](dev/architecture.md)、[README.md](../README.md) |
| §3 Architecture Layers | [dev/architecture.md](dev/architecture.md) |
| §4 Data Model / Storage key | [dev/data-model.md](dev/data-model.md)、[dev/layout-data-model.md](dev/layout-data-model.md)、[dev/storage.md](dev/storage.md) |
| §5 Load-Bearing Decisions | 渲染類 → [dev/rendering.md](dev/rendering.md)；API/auth 類 → [dev/api.md](dev/api.md)；storage 類 → [dev/storage.md](dev/storage.md)；migration 類 → [dev/data-model.md](dev/data-model.md)；SPA/PWA → [dev/architecture.md](dev/architecture.md) |
| §6 Invariants | [dev/conventions.md](dev/conventions.md#跨模組-invariants) |
| §7 External Boundaries | [dev/deployment.md](dev/deployment.md)、[dev/rendering.md](dev/rendering.md#字型) |
| §8 Non-Goals | [dev/architecture.md](dev/architecture.md#非目標明確不做) |
| §9 Known Unknowns / DRIFT | [dev/known-issues.md](dev/known-issues.md) |
| §10 Test / Lint Gap | [dev/testing.md](dev/testing.md)、[dev/known-issues.md](dev/known-issues.md#測試缺口未來高-leverage-gate) |

此 stub 保護既有引用；確認無外部連結後可移除。
