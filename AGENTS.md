# AGENTS.md — 幼兒園相本製作系統

Codex 在此專案的工作指引。本檔只放 **agent 行為規則** 與 **文件地圖**，
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
| [docs/dev/data-model.md](docs/dev/data-model.md) | ORM、孩子名冊、園所／學期資料、migrations 規則 | 動 DB / schema / 組織資料 |
| [docs/dev/layout-data-model.md](docs/dev/layout-data-model.md) | label_texts 三層覆蓋、live template revision、layout_json | 動版面資料、模板頁結構同步、文字覆蓋 |
| [docs/dev/api.md](docs/dev/api.md) | 認證、角色權限矩陣、端點清單、API 注意事項 | 加改端點、動權限 |
| [docs/dev/rendering.md](docs/dev/rendering.md) | 渲染管線、TemplateEditor、PIL⇄Konva 補償、字型 | 動渲染 / 編輯器 / 預覽 |
| [docs/dev/storage.md](docs/dev/storage.md) | StorageAdapter、key 格式、R2 設定與維運 | 動檔案 I/O / 上傳 |
| [docs/dev/testing.md](docs/dev/testing.md) | 測試指令、測試防線、修改後驗證流程 | 每次改完程式 |
| [docs/dev/deployment.md](docs/dev/deployment.md) | 啟動腳本、Docker/nginx、環境變數表 | 部署、環境設定 |
| [docs/dev/production-cutover-202607.md](docs/dev/production-cutover-202607.md) | 2026-07 正式切換做了什麼、結果如何、腳本為何退場（已完成紀錄，不是 runbook） | 想知道那次切換動了什麼、還原得了嗎 |
| [docs/dev/known-issues.md](docs/dev/known-issues.md) | 已知 drift、開放問題、測試缺口 | 遇到「這是 bug 嗎」先查這裡 |
| [docs/dev/doc-policy.md](docs/dev/doc-policy.md) | 文件怎麼寫、SSOT 規則、拆分規則 | 改任何文件之前 |
| [docs/specs/illustrator-style-groups-v1.md](docs/specs/illustrator-style-groups-v1.md) | Illustrator 式群組、隔離編輯與素材文字框輔助功能的實作契約 | 實作或審查群組、雙擊隔離、圖片分析文字框 |
| [docs/specs/illustrator-style-nested-groups-v2.md](docs/specs/illustrator-style-nested-groups-v2.md) | 現行巢狀群組 graph、scope、transform、素材文字 relation 與相容契約 | 實作或審查 layout groups、群組 traversal、isolation 與 renderer parity |
| [docs/specs/mobile-template-editor-v1.md](docs/specs/mobile-template-editor-v1.md) | 手機版模板編輯器的 responsive workspace、觸控手勢與驗收契約 | 實作或審查手機畫布、底部面板、多選與行動版操作 |
| [docs/specs/structural-refactor-v1.md](docs/specs/structural-refactor-v1.md) | 行為保持型結構重構的範圍、並行 ownership、相容契約與驗收標準 | 拆編輯器、前後端服務、測試或工具鏈之前 |
| [docs/specs/structural-refactor-v1-backend-contracts.md](docs/specs/structural-refactor-v1-backend-contracts.md) | 結構重構期間的後端 transaction、lock、Storage path、fingerprint 與同步型別契約 | 下移後端 route、拆 service、Storage 或 template sync 之前 |
| [docs/specs/organization-roster-management-v1.md](docs/specs/organization-roster-management-v1.md) | 分校、班級老師編制、目前名單、跨期相本快照與穩定專案權限的實作契約 | 實作或審查園所管理、老師指派、專案轉交與組織權限 |
| [docs/specs/term-scoped-classroom-v1.md](docs/specs/term-scoped-classroom-v1.md) | 班級改為「學期 × 分校 × 部門 × 班名」、`academic_term_classrooms` 退場與資料搬遷的實作契約 | 動班級身分、名冊／老師編制歸屬、編班或相本權限來源 |
| [docs/specs/term-scoped-classroom-v1-risks.md](docs/specs/term-scoped-classroom-v1-risks.md) | 該重構的風險登錄、緩解決定、測試計畫與上線前檢查 | 動手做該重構之前、排上線順序之前 |
| [docs/specs/websystem-roster-sync-v1.md](docs/specs/websystem-roster-sync-v1.md) | 行政系統為組織資料上游、對應鍵、快照取得、同步分類與安全閘的實作契約 | 實作或審查名冊／編制的自動同步、期中異動 |
| [docs/specs/academic-term-reporting-v1.md](docs/specs/academic-term-reporting-v1.md) | 正式學期、班級期別工作格、老師進度與學期彙整匯出的實作契約 | 實作或審查學期遷移、進度報表、彙整匯出與歷史主管 scope |
| [docs/specs/student-album-completion-v1.md](docs/specs/student-album-completion-v1.md) | 學生層個別完成、分層內容鎖、全班文字硬鎖與下載閘門的實作契約 | 實作或審查個別完成、完成鎖定、單生/全班下載解鎖 |
| [docs/specs/period-album-creation-lock-v1.md](docs/specs/period-album-creation-lock-v1.md) | 期別建立相本鎖、carryover 名冊／編制判準、已結束學期的補建入口 | 動「還能不能開新相本」、期別鎖、跨學期補建 |
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
