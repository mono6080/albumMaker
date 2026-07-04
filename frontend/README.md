# album_maker frontend

React 19 + Vite + Tailwind CSS SPA。分層原則、測試流程、慣例的真相來源在
上層文件（地圖見 [CLAUDE.md](../CLAUDE.md#文件地圖)）：

- 前端分層與目錄職責 → [docs/dev/architecture.md](../docs/dev/architecture.md#前端分層)
- 測試指令與 Playwright reuse 模式 → [docs/dev/testing.md](../docs/dev/testing.md)
- 命名與 invariants → [docs/dev/conventions.md](../docs/dev/conventions.md)

> SSOT: [testing.md#指令總覽](../docs/dev/testing.md#指令總覽) — 以下為捷徑複本，衝突時以 SSOT 為準。

```bash
npm run dev      # Vite dev server（5173，/api proxy → 8765）
npm run build    # production bundle；後端 serve frontend/dist
npm run lint
npm run test:e2e
```
