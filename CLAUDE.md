# CLAUDE.md — 幼兒園相本製作系統

Claude Code 在此專案的工作指引。本檔只放 **agent 行為規則** 與 **文件地圖**，
不放領域知識 — 依任務主題讀對應的 `docs/dev/*.md`（每檔 < 300 行）。

專案一句話：幫幼兒園老師製作個人化相本 PDF 的全端 Web App
（FastAPI + SQLAlchemy + Pillow / React 19 + Vite + Konva / SQLite）。

---

## 文件地圖

每個事實只住在一個檔案（owner）；引用用連結、不复述。維護規則的 SSOT 是
[doc-policy.md](docs/dev/doc-policy.md)。

| 檔案 | owns（該主題的唯一真相來源） | 什麼任務要先讀 |
|------|------|------|
| [README.md](README.md) | 產品簡介、功能概覽、安裝與啟動 | 初次接觸、跑起環境 |
| [docs/dev/architecture.md](docs/dev/architecture.md) | 技術棧、分層、目錄職責、頁面清單、SPA/PWA serving、非目標 | 找檔案、加模組、動路由結構 |
| [docs/dev/conventions.md](docs/dev/conventions.md) | 命名規則、開發原則、跨模組 invariants | 寫任何程式碼之前 |
| [docs/dev/data-model.md](docs/dev/data-model.md) | ORM、label_texts 三層覆蓋、layout_json、migrations 規則 | 動 DB / schema / 版型資料 |
| [docs/dev/api.md](docs/dev/api.md) | 認證、角色權限矩陣、端點清單、API 注意事項 | 加改端點、動權限 |
| [docs/dev/rendering.md](docs/dev/rendering.md) | 渲染管線、TemplateEditor、PIL⇄Konva 補償、字型 | 動渲染 / 編輯器 / 預覽 |
| [docs/dev/storage.md](docs/dev/storage.md) | StorageAdapter、key 格式、R2 設定與維運 | 動檔案 I/O / 上傳 |
| [docs/dev/testing.md](docs/dev/testing.md) | 測試指令、測試防線、修改後驗證流程 | 每次改完程式 |
| [docs/dev/deployment.md](docs/dev/deployment.md) | 啟動腳本、Docker/nginx、環境變數表 | 部署、環境設定 |
| [docs/dev/known-issues.md](docs/dev/known-issues.md) | 已知 drift、開放問題、測試缺口 | 遇到「這是 bug 嗎」先查這裡 |
| [docs/dev/doc-policy.md](docs/dev/doc-policy.md) | 文件怎麼寫、SSOT 規則、拆分規則 | 改任何文件之前 |
| [docs/specs/illustrator-style-groups-v1.md](docs/specs/illustrator-style-groups-v1.md) | Illustrator 式群組、隔離編輯與素材文字框輔助功能的實作契約 | 實作或審查群組、雙擊隔離、圖片分析文字框 |
| docs/teacher-album-guide.md 等 | 終端使用者教學（老師 / 設計組），由 `scripts/generate_*.mjs` 產出 HTML/PDF | 改使用者教學 |

## Agent 硬規則（必守）

1. **改完必自測**：不能改完就回報「應該可以了」。驗證流程的 SSOT 在
   [testing.md](docs/dev/testing.md#agent-修改後的驗證流程必守)。
2. **改前端必 build**：動到 `frontend/src/**` 後**立刻**執行
   `cd frontend && npm run build`，不等使用者說 — 後端 serve 的是
   `frontend/dist/`，不 build 使用者看不到新版。
3. **只做被要求的事**、**不加多餘防禦**：原則細節見
   [conventions.md](docs/dev/conventions.md#開發原則)。
4. **命名與注釋**：中文注釋；命名規則見
   [conventions.md](docs/dev/conventions.md#命名規則)。
5. **改文件先讀 doc-policy**：新知識落點查上方地圖；重複內容是 bug。
6. **文件與程式碼同 commit**：改動使文件失真時，同 commit 更新 owner 檔案。

## 常用指令

> SSOT: [README.md#快速開始](README.md#快速開始) 與
> [testing.md](docs/dev/testing.md#指令總覽) — 此處為捷徑複本，衝突時以 SSOT 為準。

```bash
# 後端（port 8765，直接 serve 已 build 的 frontend/dist）
cd backend && uvicorn main:app --host 0.0.0.0 --port 8765 --reload

# 前端 HMR（port 5173，/api 代理至 8765）
cd frontend && npm run dev

# 前端正式建置（改前端後必跑）
cd frontend && npm run build

# 測試
python -m pytest -q
```
