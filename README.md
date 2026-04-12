# 幼兒園相本製作系統

幫助幼兒園老師為每位學生製作個人化相本 PDF 的全端 Web 應用程式。
老師可在線上設計模板（版型、照片格、氣泡文字框），批次匯入學生名單，
逐一上傳照片後一鍵產生 PDF，並可下載全班壓縮包。

---

## 功能概覽

| 模組 | 功能 |
|------|------|
| **模板編輯器** | 建立多頁版型；拖曳擺放照片格、氣泡框、貼圖；上傳背景圖 |
| **批次管理** | 貼上學生名單批次新增；全班統一編輯氣泡文字預設值 |
| **個別編輯** | 單一學生照片上傳、位移縮放裁切、個人化氣泡文字覆蓋 |
| **輸出審閱** | 頁面預覽、單一 PDF 下載、全班 ZIP 打包下載 |

---

## 技術架構

```
album_maker/
├── backend/               # FastAPI + SQLAlchemy + Pillow
│   ├── main.py            # 應用程式進入點、路由掛載
│   ├── database.py        # SQLAlchemy ORM 模型（Template / Project / Student）
│   ├── migrations.py      # Schema 遷移（啟動時自動執行）
│   ├── crud/              # get_or_404 查詢輔助
│   ├── routers/           # 薄路由層（templates.py / projects.py）
│   ├── schemas/           # Pydantic response schemas
│   ├── services/
│   │   ├── render_service.py   # PIL 頁面合成引擎
│   │   ├── project_service.py  # PDF 輸出、ZIP 打包、氣泡文字合併
│   │   └── file_service.py     # 上傳檔案路徑管理
│   └── uploads/           # 背景圖、貼圖、學生照片（執行期產生）
│
└── frontend/              # React + Vite + Tailwind CSS
    └── src/
        ├── api/           # templateApi.js / projectApi.js / urls.js
        ├── components/    # PhotoManager / AlbumPageNav / BubbleSVG …
        ├── constants/     # shapes.js / fonts.js
        ├── hooks/         # useAutoSave.js（防抖自動儲存）
        └── pages/         # TemplateEditor / ProjectBatch / StudentEdit / ProjectReview
```

### 後端

- **FastAPI 0.135** — HTTP API（`/api/templates/`、`/api/projects/`）
- **SQLAlchemy 2.0** — SQLite ORM（`album_maker.db`）
- **Pillow 12** — 頁面 PNG 合成與 PDF 輸出
- 後端同時提供前端靜態檔案（SPA catch-all）

### 前端

- **React 19 + Vite 8** — SPA
- **Tailwind CSS 4** — 樣式
- **Axios** — API 請求（統一 `/api` base URL）
- 拖曳畫布以 DOM 事件實作（不依賴 canvas 函式庫）

---

## 快速開始

### 需求

- Python 3.10+
- Node.js 18+

### 安裝

```bash
# 後端
cd backend
pip install fastapi uvicorn sqlalchemy pillow python-multipart

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

### 正式部署

```bash
# 1. 編譯前端
cd frontend && npm run build

# 2. 啟動後端（同時提供前端靜態檔案）
cd backend && uvicorn main:app --host 0.0.0.0 --port 8765
```

Windows 可直接雙擊：

| 腳本 | 用途 |
|------|------|
| `start.bat` | 啟動後端並自動開啟瀏覽器 |
| `build_frontend.bat` | 編譯前端 |

---

## API 摘要

### 模板

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/templates/` | 列出所有模板 |
| POST | `/api/templates/` | 建立模板 |
| PATCH | `/api/templates/{id}` | 改名 |
| DELETE | `/api/templates/{id}` | 刪除 |
| GET | `/api/templates/{id}` | 取得模板詳細（含所有頁面） |
| POST | `/api/templates/{id}/pages` | 新增頁面 |
| PUT | `/api/templates/{id}/pages/{page_id}` | 更新頁面版型 JSON |
| DELETE | `/api/templates/{id}/pages/{page_id}` | 刪除頁面 |
| POST | `/api/templates/{id}/pages/{page_id}/background` | 上傳背景圖 |
| POST | `/api/templates/{id}/stickers` | 上傳貼圖素材 |
| GET | `/api/templates/{id}/pages/{page_id}/preview` | 頁面預覽圖 |

### 專案 / 學生

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/projects/` | 列出所有專案 |
| POST | `/api/projects/` | 建立專案 |
| PATCH | `/api/projects/{id}` | 改名 |
| DELETE | `/api/projects/{id}` | 刪除 |
| GET | `/api/projects/{id}` | 取得專案詳細（含所有學生） |
| PUT | `/api/projects/{id}/bubble_texts` | 更新全班氣泡文字預設值 |
| POST | `/api/projects/{id}/students/batch` | 批次新增學生 |
| PATCH | `/api/projects/{id}/students/{sid}` | 學生改名 |
| DELETE | `/api/projects/{id}/students/{sid}` | 刪除學生 |
| POST | `/api/projects/{id}/students/{sid}/photos` | 上傳照片 |
| PUT | `/api/projects/{id}/students/{sid}/photos/{slot}` | 更新照片位移縮放 |
| PUT | `/api/projects/{id}/batch/texts` | 批次更新學生氣泡文字 |
| POST | `/api/projects/{id}/students/{sid}/render` | 產生單一學生 PDF |
| POST | `/api/projects/{id}/render/all` | 產生全班 PDF |
| GET | `/api/projects/{id}/students/{sid}/pdf` | 下載單一 PDF |
| GET | `/api/projects/{id}/download/all` | 下載全班 ZIP |
| GET | `/api/projects/{id}/students/{sid}/preview/{page}` | 學生頁面預覽圖 |
| GET | `/api/projects/{id}/preview/{page}` | 專案頁面預覽圖（以預設值合成） |

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

SQLite 單一檔案 `backend/album_maker.db`，包含四張資料表：

- `templates` — 模板基本資料
- `template_pages` — 模板頁面版型 JSON
- `projects` — 專案（綁定模板）
- `students` — 學生（每人儲存照片映射與個別氣泡文字的 JSON）
