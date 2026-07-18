# 幼兒園相本製作系統

幫助幼兒園老師為每位學生製作個人化相本 PDF 的全端 Web 應用程式。
設計組在線上設計模板（版型、照片格、文字、貼圖），老師在**班級總覽**
（工作台）核對本期學生快照與相本稱呼、追蹤照片進度，在**相本編輯器**以「全班／個別」
兩種範圍放照片與填文字，完成後標記全班完成並下載 PDF／圖片壓縮包；
主管與美學組可在班級總覽留審閱意見。

- **後端**：FastAPI + SQLAlchemy + Pillow（port 8765，同時 serve 前端靜態檔）
- **前端**：React 19 + Vite + Tailwind CSS + react-konva（PWA）
- **資料庫**：SQLite；**儲存**：本機磁碟或 Cloudflare R2

---

## 功能概覽

| 模組 | 功能 |
|------|------|
| **使用者系統** | JWT 登入、5 種角色（管理員/美學組/主管/帶班老師/無權限）、.xlsx 批次匯入；組織權限統一在園所設定配置 |
| **園所設定與新學期編班** | 分校／部門主管、班級主教／協同老師與目前學生直接決定權限；舊相本逐本歸班遷移，新學期先預覽學生與老師差異再原子套用 |
| **老師進度與學期彙整** | 以正式學期的班級 × 期別工作格追蹤建立、照片、交件與列印 PDF；依校別、班級與穩定學生身分預覽及匯出 ZIP |
| **模板系統** | 期別分組管理；多頁版型編輯器（Konva 畫布）：照片格、文字標籤、貼圖、背景圖、跨頁預覽 |
| **班級總覽（工作台）** | 本期學生固定快照與相本稱呼核對、照片進度與階段引導（製作→全班完成→交件）、審閱意見、單人與全班 PDF / 圖片 ZIP 下載 |
| **相本編輯器** | 全班／個別兩種編輯範圍一鍵切換：全班共用照片（選格→每人不同張/全班同一張/依檔名整批匯入）與共用文字；個別學生照片上傳、位移縮放裁切、文字覆寫、頁面跳過 |
| **完成與交件** | 全班完成鎖定（主管/管理員可退回）、完整畫質下載僅限管理員、專案封存 30 天並於到期後自動永久清除 |

所見即所得是核心賣點：編輯器 Konva 畫布與後端 PIL 輸出經過逐項視覺對齊
（詳見 [docs/dev/rendering.md](docs/dev/rendering.md)）。

---

## 快速開始

需求：Python 3.12+、Node.js 18+

```bash
# 安裝
cd backend  && pip install -r requirements.txt
cd frontend && npm install

# 後端（port 8765；直接提供 API 與已 build 的 frontend/dist）
cd backend && uvicorn main:app --host 0.0.0.0 --port 8765 --reload

# 前端 HMR 開發（port 5173，/api 代理至 8765）
cd frontend && npm run dev

# 前端正式建置（後端 serve 的是 frontend/dist，改前端後必跑）
cd frontend && npm run build
```

Windows 可直接雙擊 `start.bat` 啟動後端；其他啟動腳本見
[docs/dev/deployment.md](docs/dev/deployment.md#本機啟動腳本repo-根目錄)。

首次啟動自動建立 **admin** 帳號，初始密碼印在終端機啟動日誌，請立即登入修改。

測試指令與驗證流程見 [docs/dev/testing.md](docs/dev/testing.md)。

---

## 開發文件

開發知識採 SSOT 設計：每個主題只有一個真相來源檔案。
完整文件地圖與各檔案的負責範圍見 [CLAUDE.md](CLAUDE.md#文件地圖)，
文件維護規則見 [docs/dev/doc-policy.md](docs/dev/doc-policy.md)。

| 主題 | 文件 |
|------|------|
| 架構與目錄 | [docs/dev/architecture.md](docs/dev/architecture.md) |
| 核心資料模型 | [docs/dev/data-model.md](docs/dev/data-model.md) |
| 版面資料模型與版型格式 | [docs/dev/layout-data-model.md](docs/dev/layout-data-model.md) |
| API 與角色權限 | [docs/dev/api.md](docs/dev/api.md) |
| 渲染與編輯器 | [docs/dev/rendering.md](docs/dev/rendering.md) |
| 儲存層與 R2 | [docs/dev/storage.md](docs/dev/storage.md) |
| 部署與環境變數 | [docs/dev/deployment.md](docs/dev/deployment.md) |

## 使用教學（終端使用者）

- [設計組模板製作使用教學](docs/template-design-guide.md)（[PDF](docs/設計組模板製作使用教學.pdf)）
- [老師製作相冊使用教學](docs/teacher-album-guide.md)（[PDF](docs/老師製作相冊使用教學.pdf)）

---

## 部署

Docker Compose（multi-stage build，Unix socket 接 nginx）：

```bash
cp .env.example .env        # 填入 SECRET_KEY
docker compose up -d --build
```

完整步驟、nginx 設定與環境變數表見
[docs/dev/deployment.md](docs/dev/deployment.md)。
