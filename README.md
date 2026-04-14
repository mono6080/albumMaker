# 幼兒園相本製作系統

幫助幼兒園老師為每位學生製作個人化相本 PDF 的全端 Web 應用程式。
老師可在線上設計模板（版型、照片格、氣泡文字框），批次匯入學生名單，
逐一上傳照片後一鍵產生 PDF，並可下載全班壓縮包。

---

## 功能概覽

| 模組 | 功能 |
|------|------|
| **使用者系統** | JWT 登入、5 種角色（管理員/美學組/帶班主管/帶班老師/無權限）、角色型存取控制 |
| **模板編輯器** | 建立多頁版型；拖曳擺放照片格、氣泡框、貼圖；上傳背景圖 |
| **批次管理** | 貼上學生名單批次新增；全班統一編輯氣泡文字預設值 |
| **個別編輯** | 單一學生照片上傳、位移縮放裁切、個人化氣泡文字覆蓋 |
| **輸出審閱** | 頁面預覽、留言回饋、單一 PDF 下載（完整畫質僅限管理員）、全班 ZIP 打包 |

---

## 技術架構

```
album_maker/
├── backend/               # FastAPI + SQLAlchemy + Pillow
│   ├── main.py            # 應用程式進入點、路由掛載
│   ├── database.py        # ORM 模型（Template / Project / Student / User / ProjectComment）
│   ├── migrations.py      # Schema 遷移（啟動時自動執行，冪等設計）
│   ├── auth.py            # JWT 認證、bcrypt 密碼、get_current_user / require_role
│   ├── crud/              # get_or_404 查詢輔助（含 user_crud.py）
│   ├── routers/           # 薄路由層（auth / users / templates / projects/）
│   │   └── projects/      # 照片、文字、留言、渲染各子路由
│   ├── services/
│   │   ├── render_service.py    # 公開 API：render_page / render_album / save_album_pdf
│   │   ├── draw_helpers.py      # PIL 底層：字型、圖片合成、形狀繪製、文字換行
│   │   ├── element_renderers.py # 各元素渲染：照片格 / 氣泡框 / 文字標籤 / 貼圖
│   │   ├── project_service.py   # PDF 輸出、ZIP 打包、氣泡文字合併
│   │   ├── file_service.py      # Storage key 計算與上傳工具
│   │   └── storage.py           # StorageAdapter 抽象層（本機 / 未來可換 S3）
│   └── uploads/           # 背景圖、貼圖、學生照片（執行期產生）
│
├── frontend/              # React + Vite + Tailwind CSS
│   └── src/
│       ├── api/           # authApi.js（共用 apiClient）/ templateApi.js / projectApi.js / urls.js
│       ├── context/       # AuthContext.jsx（登入狀態全域管理）
│       ├── components/    # PropertyPanel / PhotoManager / PhotoSlotCard / SlotFramePreview
│       │   └── canvas/    # BubbleKonvaShape / StickerNode / BubbleSVG
│       ├── constants/     # shapes.js / fonts.js
│       ├── hooks/         # useAutoSave.js / usePermissions.js
│       ├── utils/         # photoUtils.js
│       └── pages/         # Login / UserManagement / TemplateEditor / ProjectBatch / StudentEdit / ProjectReview
│
├── deploy/                # 部署設定參考
│   └── album_maker.conf   # nginx 設定範本（Unix socket 模式）
├── Dockerfile             # Multi-stage build（Node 編前端 → Python 跑後端）
├── docker-compose.yml     # 容器編排（Unix socket + named volumes）
└── .env.example           # 環境變數範本
```

### 後端

- **FastAPI 0.135** — HTTP API（`/api/auth/`、`/api/users/`、`/api/templates/`、`/api/projects/`）
- **SQLAlchemy 2.0** — SQLite ORM（`album_maker.db`）
- **Pillow 12** — 頁面 PNG 合成與 PDF 輸出
- **StorageAdapter** — 抽象檔案 I/O 層；本機使用 `LocalStorageAdapter`（含 path traversal 防護），切換雲端只需實作新 adapter 並設定 `STORAGE_BACKEND` 環境變數
- **python-jose** — JWT 簽發與驗證（HttpOnly Cookie，有效期 7 天）
- **bcrypt** — 密碼雜湊（直接使用，不透過 passlib）
- **slowapi** — 登入端點速率限制（10 次/分鐘，依 IP）
- 後端同時提供前端靜態檔案（SPA catch-all）
- 所有回應加入安全 Headers（`X-Frame-Options`、`X-Content-Type-Options` 等）

### 前端

- **React 19 + Vite 8** — SPA
- **Tailwind CSS 4** — 樣式
- **Axios** — API 請求；共用 `apiClient` 自動附帶 Bearer token，401 自動跳登入頁
- **react-konva** — 模板編輯器拖曳畫布（Canvas 2D，視覺與後端 PIL 渲染一致）

---

## 快速開始

### 需求

- Python 3.10+
- Node.js 18+

### 安裝

```bash
# 後端
cd backend
pip install -r requirements.txt

# 前端
cd frontend
npm install
```

### 開發模式

```bash
# 後端（port 8765）
cd backend
uvicorn main:app --host 0.0.0.0 --port 8765 --reload

# 前端（port 5173，代理 /api → 8765）
cd frontend
npm run dev
```

Windows 可直接雙擊 `start.bat` 啟動後端。

---

## Docker 部署

### 本機測試

```bash
cp .env.example .env        # 填入 SECRET_KEY
docker compose up -d --build
```

### 正式部署（接現有 nginx）

容器透過 Unix socket 與 nginx 通訊，不對外暴露 port。

1. **上傳專案**至 VPS 目錄（例如 `~/albumMakerCompose/`）

2. **建立 `.env`** 並填入正式 SECRET_KEY：
   ```bash
   cp .env.example .env
   python3 -c "import secrets; print(secrets.token_hex(32))"
   ```

3. **啟動容器**（建立 socket volume）：
   ```bash
   docker compose up -d --build
   ```

4. **將 nginx 設定加入現有 nginx compose**（參考 `deploy/album_maker.conf`），並重啟 nginx。

---

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `SECRET_KEY` | 隨機佔位符（**必須修改**） | JWT 簽名密鑰，正式環境用 `python -c "import secrets; print(secrets.token_hex(32))"` 產生 |
| `PRODUCTION` | 未設定 | 設為 `1` 時啟用 Cookie Secure flag（需 HTTPS）並拒絕啟動無 SECRET_KEY |
| `DATABASE_URL` | `sqlite:///./album_maker.db` | 資料庫連線字串 |
| `STORAGE_BACKEND` | `local` | 儲存後端（目前僅支援 `local`） |
| `ALLOWED_ORIGINS` | `http://localhost:5173,...` | CORS 允許來源，逗號分隔；正式部署填入實際網域 |

---

## API 摘要

> 標註 🔓 的端點不需要登入（圖片 serving）；其餘皆需 `Authorization: Bearer <token>`。

### 認證 / 使用者

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/auth/login` | 登入，回傳 JWT（form: username / password） |
| GET | `/api/auth/me` | 取得當前使用者資訊 |
| GET | `/api/users/` | 列出所有使用者（admin） |
| POST | `/api/users/` | 建立使用者（admin） |
| PATCH | `/api/users/{id}` | 更新角色/主管/密碼（admin） |
| DELETE | `/api/users/{id}` | 刪除使用者（admin） |

### 模板

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/templates/` | 列出所有模板 |
| POST | `/api/templates/` | 建立模板（admin / art_team） |
| PATCH | `/api/templates/{id}` | 改名（admin / art_team） |
| DELETE | `/api/templates/{id}` | 刪除（admin / art_team） |
| GET | `/api/templates/{id}` | 取得模板詳細（含所有頁面） |
| POST | `/api/templates/{id}/pages` | 新增頁面（admin / art_team） |
| PUT | `/api/templates/{id}/pages/{page_id}/layout` | 更新頁面版型 JSON（admin / art_team） |
| DELETE | `/api/templates/{id}/pages/{page_id}` | 刪除頁面（admin / art_team） |
| POST | `/api/templates/{id}/pages/{page_id}/background` | 上傳背景圖（admin / art_team） |
| GET 🔓 | `/api/templates/{id}/pages/{page_id}/background` | 背景圖檔案 |
| POST | `/api/templates/{id}/stickers` | 上傳貼圖素材（admin / art_team） |
| GET 🔓 | `/api/templates/{id}/stickers/{filename}` | 貼圖檔案 |
| GET 🔓 | `/api/templates/{id}/pages/{page_id}/preview` | 頁面預覽圖 |

### 專案 / 學生

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/projects/` | 列出可存取的專案（依角色過濾） |
| POST | `/api/projects/` | 建立專案（admin / teacher） |
| PATCH | `/api/projects/{id}` | 改名（admin / 專案擁有者） |
| DELETE | `/api/projects/{id}` | 刪除（admin / 專案擁有者） |
| GET | `/api/projects/{id}` | 取得專案詳細（含所有學生） |
| GET | `/api/projects/{id}/label_texts` | 取得全班對印文字預設值 |
| PUT | `/api/projects/{id}/label_texts` | 更新全班對印文字預設值 |
| GET | `/api/projects/{id}/comments` | 取得審閱留言 |
| POST | `/api/projects/{id}/comments` | 新增留言（admin / art_team / supervisor） |
| DELETE | `/api/projects/{id}/comments/{cid}` | 刪除留言（admin） |
| POST | `/api/projects/{id}/students/batch` | 批次新增學生 |
| PATCH | `/api/projects/{id}/students/{sid}` | 學生改名 |
| DELETE | `/api/projects/{id}/students/{sid}` | 刪除學生 |
| POST | `/api/projects/{id}/students/{sid}/pages/{page}/photos/{slot}` | 上傳照片 |
| GET 🔓 | `/api/projects/{id}/students/{sid}/pages/{page}/photos/{slot}` | 照片檔案 |
| PUT | `/api/projects/{id}/students/{sid}/photos/mapping` | 更新照片位移縮放 |
| PUT | `/api/projects/{id}/students/{sid}/pages/{page}/texts` | 更新個別學生氣泡文字 |
| PUT | `/api/projects/{id}/batch/texts` | 批次更新學生氣泡文字 |
| POST | `/api/projects/{id}/students/{sid}/render` | 產生單一學生 PDF |
| POST | `/api/projects/{id}/render/all` | 產生全班 PDF |
| GET | `/api/projects/{id}/students/{sid}/pdf?mode=print\|screen` | 下載單一 PDF（非 admin 強制 screen） |
| GET | `/api/projects/{id}/download/all?mode=print\|screen` | 下載全班 ZIP |
| GET 🔓 | `/api/projects/{id}/students/{sid}/preview/{page}` | 學生頁面預覽圖 |
| GET 🔓 | `/api/projects/{id}/preview/{page}` | 專案頁面預覽圖（以預設值合成） |

---

## 版型 JSON 格式

每個模板頁面的 `layout_json` 欄位儲存以下結構：

```json
{
  "canvas_width": 794,
  "canvas_height": 1123,
  "photo_slots": [
    { "id": 1, "x": 50, "y": 120, "width": 400, "height": 300, "rotation": -3 }
  ],
  "text_bubbles": [
    {
      "id": 1, "x": 500, "y": 150, "width": 200, "height": 120,
      "shape": "ellipse",
      "fill": "#FDED6E", "border_color": "#888", "border_width": 2,
      "text": "{name}正在進行飛機飛平衡！",
      "font_size": 20, "font_color": "#3B6B8C"
    }
  ],
  "stickers": [
    { "id": 1, "filename": "star.png", "x": 10, "y": 10, "width": 60, "height": 60 }
  ],
  "footer": { "enabled": true, "text": "{name} · 2026年1月" }
}
```

`{name}` 在渲染時自動替換為學生姓名。

---

## 資料庫

SQLite 單一檔案 `backend/album_maker.db`，包含六張資料表：

| 資料表 | 說明 |
|--------|------|
| `users` | 使用者帳號（角色、主管 FK、bcrypt 密碼） |
| `templates` | 模板基本資料 |
| `template_pages` | 模板頁面版型 JSON |
| `projects` | 專案（綁定模板、owner_id FK 至 users） |
| `students` | 學生（每人儲存照片映射與個別氣泡文字的 JSON） |
| `project_comments` | 審閱留言（project_id / author_id / 內容 / 時間） |

Schema 遷移由 `migrations.py` 在後端啟動時自動冪等執行。  
首次啟動時自動建立 **admin** 帳號，初始密碼為隨機產生並印在終端機啟動日誌中，請立即登入後修改。

---

## 角色權限

| 角色 | 模板 | 看專案 | 建立/編輯專案 | 留言 | 完整畫質 PDF | 使用者管理 |
|------|------|--------|---------------|------|-------------|-----------|
| admin | 完整 | 全部 | 全部 | ✓ | ✓ | ✓ |
| art_team | 完整 | 全部（唯讀） | — | ✓ | — | — |
| supervisor | 唯讀 | 管轄老師 | — | ✓ | — | — |
| teacher | 唯讀 | 自己的 | 自己的 | 唯讀 | — | — |
| none | — | — | — | — | — | — |
