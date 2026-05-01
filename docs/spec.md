# album_maker — Architecture Spec

> Architect-shaped truth doc. Pair with `CLAUDE.md` (coder-facing how-to)
> + `README.md` (entry summary). Audits cite this when emitting DRIFT.

## 1. Overview

幼兒園相本製作系統 — 全端 Web App，幫助幼兒園老師為每位學生產生個人化相本
PDF。老師建立模板（多頁版型 + 照片格 + 氣泡 + 貼圖）、批次匯入學生、上傳照片、
按角色權限產出 PDF / ZIP。

- 使用者：admin / art_team（美學組）/ supervisor（帶班主管）/ teacher（帶班老師）
  / none，5 種角色。
- 部署形態：單機容器 — Docker Compose multi-stage build（Node 編前端 → Python
  serve 後端與前端 dist），對外不暴露 port，透過 Unix socket 接 nginx
  （`Dockerfile`、`README.md:127`）。
- 規模假設：單園所、低並發、SQLite 單檔 (`backend/album_maker.db`)；無多租戶設計。

## 2. Stack & Versions

### 後端（`backend/requirements.txt`）

| 套件 | 版本 | 為何釘住 |
|------|------|---------|
| fastapi | 0.135.3 | API framework |
| uvicorn[standard] | 0.38.0 | ASGI server，port 8765 |
| sqlalchemy | 2.0.49 | ORM；`database.py:1` 用 declarative_base + 2.0 風格 |
| pillow | 12.2.0 | PIL 渲染（`draw_helpers.py`、`element_renderers.py`） |
| img2pdf | 0.6.3 | `render_service.py:158` 圖片→PDF（避開 PIL 自帶 PDF 的色域問題） |
| python-jose[cryptography] | 3.5.0 | JWT HS256（`auth.py:28`） |
| bcrypt | 5.0.0 | **直接呼叫**，不透過 passlib（passlib 與 bcrypt 4.x+ 不相容） |
| python-multipart | 0.0.20 | FastAPI Form / UploadFile |
| slowapi | 0.1.9 | 登入端點 IP-based rate limit（`routers/auth.py:25`） |
| passlib | 1.7.4 | **存在但僅留 transitive ref**，禁止再用其 bcrypt context |

### 前端（`frontend/package.json`）

| 套件 | 版本 | 用途與鎖點 |
|------|------|------------|
| react / react-dom | ^19.2.4 | React 19 |
| vite | ^8.0.4 | dev server / build |
| @tailwindcss/vite | ^4.2.2 | Tailwind v4 vite 插件（不是 v3 PostCSS plugin） |
| react-router-dom | ^7.14.0 | SPA 路由 |
| axios | ^1.15.0 | HTTP；共用 `apiClient` 走 HttpOnly Cookie |
| konva / react-konva | ^10.2.5 / ^19.2.3 | TemplateEditor 拖曳畫布（與 PIL 視覺對齊） |
| vite-plugin-pwa | ^1.2.0 | autoUpdate Service Worker；與 vite 8 有 peer dep 衝突，
    Docker build 用 `npm ci --legacy-peer-deps`（`Dockerfile:7`） |
| react-hot-toast | ^2.6.0 | toast |
| lucide-react | ^1.8.0 | icons |
| fabric / react-window | 已安裝但目前僅選用 | （見 §9） |

### 資料庫

- **SQLite 單檔**，`DATABASE_URL` 預設 `sqlite:///./album_maker.db`
  （`database.py:7`）。
- `check_same_thread=False`、PRAGMA `foreign_keys=ON` 在 connect event 設
  （`database.py:11`）。
- 不設 `text_factory`；SQLAlchemy 以 UTF-8 存取。

### 部署

- Multi-stage Dockerfile（`Dockerfile:1`）：Node 20 編 → Python 3.12 serve。
- Linux 容器內安裝 fonts-noto-cjk / fonts-wqy-zenhei / fonts-wqy-microhei
  以替代 Windows 開發機的 `C:/Windows/Fonts/`（`draw_helpers.py:11`）。
- nginx 經 Unix socket 連 uvicorn（`README.md:127`、`deploy/album_maker.conf`）。

## 3. Architecture Layers

### 後端三層（薄路由 → CRUD → service）

```
HTTP request
   ↓
backend/routers/*.py     — 接 HTTP、解析 form/JSON、組 response
   ├─ auth.py            login / logout / me
   ├─ users.py           admin-only 使用者 CRUD
   ├─ templates.py       模板 + 模板頁面 + 背景 + 貼圖
   └─ projects/*.py      crud / photos / texts / comments / render
        ↓ get_*_or_404、Pydantic 驗證
   backend/crud/*.py     — 純 DB 查詢（找不到自動 raise 404）
        ↓
   backend/services/     — 業務邏輯（合併、渲染、打包、key 計算）
        ├─ render_service.py    公開 API render_page / render_album / save_album_pdf
        ├─ draw_helpers.py      PIL 工具：字型、圖片合成、形狀、文字
        ├─ element_renderers.py 各元素 PIL 渲染（photo / sticker / bubble / label）
        ├─ project_service.py   PDF 輸出、ZIP、合併 label_texts
        ├─ file_service.py      Storage key 計算
        └─ storage.py           StorageAdapter 抽象（LocalStorageAdapter / 未來 S3）
        ↓
   檔案系統 (uploads/) / DB (album_maker.db)
```

邊界：路由函式 ≤ 10 行（CLAUDE.md 慣例）；超過要進 service。`render.py:128`
的 `render_all_students` 是 28 行，是合理例外（含 logger / 錯誤聚合）。

### 前端五層

```
pages/*.jsx     — 組合 + state + API 呼叫；每頁一個檔案
components/     — 純顯示或受控；canvas/ 是 Konva 子集
hooks/          — useAutoSave / usePermissions / useInlineEdit；無 JSX
api/            — 只做 HTTP；共用 apiClient + interceptor
constants/      — 靜態資料（shapes / fonts），無邏輯
utils/          — photoUtils / bubbleGeometry / apiError
context/        — AuthContext（全域 currentUser）
```

App 入口：`main.jsx → App.jsx`（`App.jsx:96`）— BrowserRouter + AuthProvider
+ Toaster + PwaUpdateBanner + Nav + Routes，路由皆以 `<PrivateRoute>` 包裹並
傳 `allowedRoles`。

## 4. Data Model

### ORM 模型（`database.py`）

```
User (id, username UNIQUE, display_name, hashed_password, role, supervisor_id FK→User, created_at)
  └─ supervisor / subordinates self-join
  └─ owned_projects  → Project.owner_id
  └─ comments        → ProjectComment.author_id

Template (id, name, created_at)
  └─ pages   → TemplatePage[] (cascade delete-orphan, order_by page_number)

TemplatePage (id, template_id FK, page_number, background_filename TEXT, layout_json TEXT)
  └─ UNIQUE(template_id, page_number)  — 由 migrations.py:148 補建

Project (id, name, template_id FK, owner_id FK→User nullable, created_at, updated_at, label_texts_json TEXT)
  └─ students  → Student[] (cascade delete-orphan, order_by order_index)
  └─ comments  → ProjectComment[] (cascade delete-orphan)

Student (id, project_id FK, name, order_index, pages_data_json TEXT, output_filename, created_at, updated_at)

ProjectComment (id, project_id FK, author_id FK, content TEXT, created_at)
```

### 對印文字（label_texts）3 層覆蓋

低 → 高（高覆蓋低）：

```
模板預設           layout_json["text_labels"][i]["text"]
   ↓
專案層級覆蓋        projects.label_texts_json   = {page_index: {label_id: text}}
   ↓
學生個別覆蓋        students.pages_data_json[i]["label_texts"] = {label_id: text}
```

合併單一進入點：`services/project_service.py:50`
`merge_project_label_texts_into_pages()`。學生值優先，專案值補足未覆寫處；若
學生尚無對應頁，會以 project_label_texts 補上空 photos 頁面。`render_page()`
讀模板預設作為最底層 fallback（`element_renderers.py:160`）。

### Storage key 格式（相對 `uploads/`，永遠是字串）

| 用途 | Key 形式 | 算式來源 |
|------|----------|---------|
| 學生照片 | `projects/proj{pid}/photos/student{sid}/p{page_index}_slot{slot_id}_{filename}` | `file_service.py:13` |
| 模板背景 | `templates/tmpl{tid}/backgrounds/page{page_id}_{filename}` | `file_service.py:29` |
| 貼圖 | `templates/tmpl{tid}/stickers/{filename}` | `file_service.py:38` |
| PDF 列印 | `projects/proj{pid}/output/{stem}.pdf` | `project_service.py:141` |
| PDF 螢幕 | `projects/proj{pid}/output/{stem}_screen.pdf` | `project_service.py:142` |
| 學生單頁 jpg | `projects/proj{pid}/output/{stem}/{stem}_page{n}.jpg` | `project_service.py:150` |

`{stem}` = `make_safe_filename(project.name) + "-" + make_safe_filename(student.name)`
（`project_service.py:28`），Windows / Linux 非法字元 `\\/:*?"<>|` 替換為 `_`。

## 5. Load-Bearing Decisions

每條：**決策 / why / 違反代價**。改任何一條都會炸別處。

### 5.1 PIL ⇄ Konva 視覺參數補償

- **shadowBlur × 1.74**（`pages/TemplateEditor.jsx:478`）：HTML Canvas2D
  shadowBlur 的 sigma = blur / 2；PIL GaussianBlur(radius) 實測 sigma ≈ radius
  × 0.87；換算需 Canvas blur = pil_blur × 1.74 才視覺一致。
  **違反**：模板預覽與輸出 PDF 的陰影濃淡 / 範圍不一致 → 老師 WYSIWYG 失效。
- **konva_v_offset = int(line_height_float / 2 - descent + la_offset)**
  （`element_renderers.py:201`）：補償 Konva `textBaseline='middle'` 相對 PIL
  視覺頂端的落差（msjh 28pt / lineHeight=1.4 約 18px）。
  **違反**：對印文字在模板編輯器看起來置中、PDF 輸出卻偏上 / 偏下。
- **逐字 anchor='la'**（`draw_helpers.py:241`）：每字繪製時用 ascender line
  anchor，並先用全字串 `textbbox(anchor='la')[1]` 校正 la_y。
  **違反**：用 `anchor='lt'` 會讓 `，`、`。` 等標點以自身 glyph 頂端對齊，
  視覺上往上飄。
- **`add_drop_shadow` 不帶 mask**（`draw_helpers.py:122`）：`combined.paste(shadow, (0,0))`
  不帶 alpha mask；帶 mask 的話 PIL 對 alpha 做平方（`alpha² / 255`），陰影濃度
  變約 ¼。
- **`render_sticker` 不經 `to_srgb`**（`element_renderers.py:147`）：直接
  `storage.open_image(...).convert("RGBA")`；`to_srgb` 會 `.convert("RGB")` 把
  透明通道填白，貼圖必須保留 alpha。

### 5.2 Storage adapter 抽象 + traversal 防護

- 所有檔案 IO 透過 `get_storage()`（`services/storage.py:148`），路由層、service
  層都不直接 `Path(...)`。
- `LocalStorageAdapter._path()` 用 `.resolve()` 後比對 base_dir
  （`storage.py:56`）：傳入含 `../` 的 key 拋 `ValueError`。
- **違反**：未來換 S3 / R2 backend 時要改的只是 storage 一層；若各處直接 `Path`
  就要全文搜尋改寫。

### 5.3 圖片端點不帶 auth

`<img>` tag 是瀏覽器原生請求，不送 `Authorization: Bearer`。以下 6 個 GET
端點不掛 `get_current_user`：

- `GET /api/templates/{id}/pages/{page_id}/preview`（`templates.py:266`）
- `GET /api/templates/{id}/pages/{page_id}/background`（`templates.py:213`）
- `GET /api/templates/{id}/stickers/{filename}`（`templates.py:250`）
- `GET /api/projects/{id}/students/{sid}/pages/{p}/photos/{slot}`（`photos.py:69`）
- `GET /api/projects/{id}/preview/{page}`（`render.py:40`）
- `GET /api/projects/{id}/students/{sid}/preview/{page}`（`render.py:69`）

**違反**：加上 `Depends(get_current_user)` 後外網（ngrok / 正式網域）圖片全部
401，老師看到全黑頁。資料操作端點則仍必須掛。

### 5.4 frontend/dist build step 必須

後端 serve 的是 `frontend/dist/`（`main.py:25`、`main.py:78`）。修改
`frontend/src/**` 後不執行 `npm run build`，使用者看不到變更。
**違反**：dev 改完直接 reload 瀏覽器、看到舊版本以為沒改到 → 修復推給「使用者
快取」。

### 5.5 PWA Service Worker 路由先於 SPA catch-all

`backend/main.py:90` `serve_spa` 必須先嘗試實體檔案（`sw.js`、
`workbox-*.js`、`manifest.webmanifest`、`offline.html`），找不到才 fallback
`index.html`。直接全部回 `index.html` 會讓瀏覽器把 HTML 當 JS 執行 →
SW 註冊失敗。`vite.config.js:30` 的 `navigateFallback: '/index.html'` 是
workbox 端的對偶（commit 027e190 把它從 `offline.html` 改回來）。

### 5.6 Pydantic v2 strict types — `dict[str, str]` vs `dict[str, Any]`

- 專案層級 label_texts 形狀為 `{page_index: {label_id: text}}`，巢狀 dict。
  `routers/projects/texts.py:40` `update_project_label_texts` 必須宣告
  `payload: dict[str, Any]`；用 `dict[str, str]` 會 422（v2 lax mode 也拒絕
  value 為 dict）。
- 學生 / page 層級 label_texts 是平坦 `{label_id: text}`，使用
  `LabelTextsPayload = dict[str, str]`（`_helpers.py:14`）。
- 批次更新 `BatchTextsPayload.students: dict[str, dict[str, dict[str, str]]]`
  （`schemas.py:154`）— 三層皆 dict，str leaf。

### 5.7 bcrypt 直呼

`auth.py:9` `import bcrypt as _bcrypt`，`hash_password / verify_password` 直呼
`bcrypt.hashpw / checkpw`。`requirements.txt` 裡 passlib 仍存在但禁止透過
`CryptContext("bcrypt")` 使用（passlib 與 bcrypt ≥ 4.x 不相容會炸啟動）。

### 5.8 SQLite migration 必須冪等且避開 ADD COLUMN 限制

`migrations.py:9` `run_migrations()` 每次啟動執行；每個子函式先 `PRAGMA
table_info` / `sqlite_master` 檢查存在再操作。

- **ADD COLUMN 不支援非常數預設值**（`migrations.py:174`）：先加無預設的
  DATETIME 欄位、再 `UPDATE ... SET col = CURRENT_TIMESTAMP WHERE col IS
  NULL` 回填。
- **DROP COLUMN 不支援**：`_drop_bubble_texts_json_column` 用「建新表 → 複製
  → 刪舊 → 改名」六步驟，期間關掉外鍵約束（`migrations.py:201`）。

### 5.9 圖片端點兩層 ImageOps.exif_transpose

`LocalStorageAdapter.open_image` 開啟後立即 `ImageOps.exif_transpose(img)`
（`storage.py:69`）。不轉的話 iPhone 直拍照片會渲染偏轉（commit fd8c181）。

### 5.10 Photo mapping 兩步驟協議（rename → null-clear）

`PUT /api/projects/{pid}/students/{sid}/photos/mapping`（`photos.py:104`）
強制兩步驟：先把所有非 null 項目重命名以對齊新前綴（並收集 incoming_paths
集合），再統一處理 null 項，只刪除未被移走的檔案。**違反**：跨頁 A↔B 互換
時先刪後找不到，照片消失。

## 6. Invariants

跨 module 應始終成立的性質。Audit 該驗它們有沒有破。

- **檔案 IO 一律過 StorageAdapter**：grep `from pathlib import Path` 在
  `routers/` 應為零；service 層只有 `render_service.py:71` 持有 `UPLOADS_DIR`
  + `file_service.py:66`、`project_service.py:24` 計算 key string，不做實際 IO。
- **DB 查詢過 `get_*_or_404`**：路由不直接 `db.query(Model).filter(...)
  .first_or_404` 抓單筆；批次列表查詢例外（`crud.py:30` list_projects）。
- **路由 ≤ 10 行**：CLAUDE.md 慣例。`render_all_students` 是合理例外。
- **IME-aware 文字輸入用 `CompositionTextarea`**：grep 一般 `<textarea>` 在
  `pages/` 應只剩非中文輸入框（如批次新增學生姓名 textarea — 該處仍在使用）。
- **共用 `apiClient`**（`api/authApi.js:7`）：所有 axios 請求都從這 export 出
  發；不在他處 `axios.create({ baseURL: '/api' })` 第二次。
- **共用 `useAutoSave`** 提供 debounce / abort / flush 統一語意；非 UI 元件不
  自寫 setTimeout 防抖。
- **Storage key 是相對字串**：絕對路徑不出現在 DB（`output_filename`、
  `background_filename`）。
- **JWT 經 HttpOnly Cookie 為主、Authorization Bearer 為輔**
  （`auth.py:81`）：Cookie 優先，Bearer 給 API 工具用。

## 7. External Boundaries

### 檔案系統

- `UPLOADS_DIR = backend/uploads/`（`render_service.py:72`）— 所有 storage key
  以此為 base。Docker volume 掛在這裡。
- `FRONTEND_DIST_DIR = ../frontend/dist/`（`main.py:25`）— SPA + PWA static
  assets。
- 字型路徑（`draw_helpers.py:11`）：Windows `C:/Windows/Fonts/`、Linux
  `/usr/share/fonts/...`，硬碼 fallback 列表；Docker image 已 apt install
  noto-cjk + wqy。

### 網路

- `:8765` — uvicorn（FastAPI + SPA + 圖片 GET）。Docker 模式下不對外暴露，
  經 Unix socket。
- `:5173` — Vite dev server，proxy `/api` → `:8769`（**注意 §9，與後端
  port 不一致**）。
- CORS allow_origins 由 `ALLOWED_ORIGINS` env 控制，預設 `localhost:5173 +
  127.0.0.1:5173`（`main.py:46`）。
- Login `:10/minute` per IP（`routers/auth.py:25`）。
- 安全 headers `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` /
  `X-XSS-Protection` / `Referrer-Policy` 全域加（`main.py:32`）。
- Cookie：HttpOnly、SameSite=Lax；`PRODUCTION=1` 時 Secure=True
  （`routers/auth.py:54`）。

### 第三方

- bcrypt 5.0：直呼 `hashpw / checkpw / gensalt`，禁 passlib wrapper。
- img2pdf 0.6：`save_album_pdf()` 唯一進入點（`render_service.py:158`）。
- Pillow 12：`ImageCms` ICC profile → sRGB 轉換（`draw_helpers.py:43`）；
  `ImageOps.exif_transpose` 修 iPhone 旋轉。
- python-jose 3.5：HS256 簽 JWT，7 天有效期（`auth.py:29`）。
- slowapi 0.1.9：登入端點 `@limiter.limit("10/minute")`。

### 系統字型（renderer 依賴）

`draw_helpers.py:CJK_FONTS` 列表 + `FONT_MAP` 命名查找。`get_font(size,
family=None)` 找不到任何路徑時 `ImageFont.load_default()`（會 fallback 到
極醜的點陣字）— 容器內必須裝 noto-cjk，否則中文渲染崩。

## 8. Non-Goals

明確不在這 project 範圍內：

- **多租戶 / SaaS**：使用者是一個園所內部的 admin / 老師，user 表沒有
  tenant 欄位、沒有 org / school 隔離。
- **分散式 / 集群**：SQLite 單檔 + 單 uvicorn 程序；多 worker 會撞到 SQLite
  寫入鎖。
- **即時協作**：無 WebSocket、無 OT / CRDT；老師之間的編輯互不可見。
- **切換 RDBMS**：DATABASE_URL 雖支援其他 SQLAlchemy URL，但 `migrations.py`
  全部 SQL 是 SQLite-flavored（`PRAGMA`、`sqlite_master`、ADD COLUMN
  workaround）。
- **切換前端 canvas 引擎**：TemplateEditor 與 PIL 對齊靠 Konva 的具體
  shadow/text 行為（§5.1）；換 fabric / Pixi 等於重做整層視覺對齊。
- **切換 backend framework**：FastAPI Depends 注入鏈（`get_current_user` /
  `require_role`）滲透到每個路由。
- **完整測試覆蓋**：見 §10，pytest / vitest 都尚未引入。

## 9. Known Unknowns / Open Questions

未來 audit / coder 接到任務時可能要釐清的點。

### 9.1 已存在的 DRIFT（先記、不修）

- **vite dev proxy port 不對齊**（`vite.config.js:55`）：proxy 指
  `http://localhost:8769`，但 backend dev 跑 `:8765`（CLAUDE.md / README.md
  / `main.py`）。dev 模式的 `/api` 透過代理會打到不存在的 8769。如果有人
  寫「用 vite dev 開發前端」這條路徑、需先確認此處更新。
- **runtimeCaching `^/uploads/`**（`vite.config.js:39`）：但實際照片 serving
  路徑是 `/api/projects/.../photos/...`，不在 `/uploads/` 下。此 cache rule
  目前是死 code（除非未來打算改 SPA 直接打 `/uploads/`）。
- **fabric ^7.2.0 在 dependencies 但 import 不到**（`package.json:14`）：
  TemplateEditor 已改用 react-konva，fabric 似乎是歷史遺留依賴。可移除以
  縮 bundle，但屬於非必要清理。
- **`LocalStorageAdapter._path()` 用 str.startswith 判 traversal**
  （`storage.py:59`）：理論上 `base = /uploads`、`resolved = /uploads_evil/...`
  也會通過比對。實務上 `_base = UPLOADS_DIR` 是固定目錄、不會與其他目錄共
  prefix，但若未來路徑命名變更需注意。

### 9.2 實際開放的設計問題

- **多用戶並行渲染下 PIL 的 thread safety**：FastAPI sync def + uvicorn
  workers > 1 時，`render_album` 是純 PIL（不共享 mutable state，看似安全）
  但 SQLite 寫入會搶鎖。目前單 worker、低並發下沒事。
- **frontend/dist 何處編？** Docker build 在 Stage 1 編；本機 dev 要求 coder
  手動 `npm run build`（CLAUDE.md 強制）。CI 流程目前不存在 — 如果未來上
  CI，要決定 dist 該不該 commit（目前 `.gitignore` 應該排除，但 deploy 流程
  依賴 Stage 1）。
- **未來 S3 backend 的中文 key**：`p{page_index}_slot{slot_id}_{filename}`
  的 `{filename}` 直接保留使用者上傳的原檔名（可能是中文）。本機 NTFS / ext4
  能容；S3 key 是 UTF-8 byte sequence 也行；但 LB / CloudFront 中間層的
  signing 行為要驗。
- **PWA SW 與 SPA catch-all 的優先序**最近修了多次（commit 524aa77、027e190、
  4d3f59d、9bf06d6、9684d43）：目前 `main.py:96-103` 先嘗試實體檔案、再 fallback
  index.html，看似穩定，但若再加新 SPA 路由與 SW asset 同名（如 `/manifest`
  → `manifest.webmanifest`）會有 race。
- **sticker 渲染缺 EXIF transpose**：`render_sticker`（`element_renderers.py:147`）
  直接 `open_image().convert("RGBA")`，但 `LocalStorageAdapter.open_image`
  本身會跑 `ImageOps.exif_transpose`（`storage.py:70`）— OK，但若未來換成
  S3 adapter 沒實作 transpose，貼圖就會偏。invariant 應寫在 adapter 介面。
- **`output_filename` 是「列印版 key」還是 stem**：實際存的是 print key
  （`project_service.py:152`），下載 screen 時用 `[:-4] + "_screen.pdf"` 字串
  操作（`render.py:184`、`project_service.py:174`）— 對 `.pdf` 副檔名的硬假設。
  若日後新增 webp / 其他輸出格式會被卡到。

### 9.3 角色權限矩陣的隱藏假設

- `assert_project_writable`（`_helpers.py:64`）只允許 admin / owning teacher；
  art_team 與 supervisor 全部不能寫。但 `update_page_layout` 在 templates 是
  admin / art_team 可寫。專案內容老師獨佔、模板美學組獨佔的二元劃分是有意設
  計，但若未來引入「主管可代老師編輯」，這層 assert 要展開。
- `delete_user` 把被刪 user 的 projects 過繼給執行刪除的 admin
  （`users.py:152`），不是 reject。若日後加 audit log 表此操作要對應記錄。

## 10. Test / Lint Gap

**現況**：

- 無 pytest 測試檔（`backend/` 沒有 `tests/` 目錄、無 `*_test.py`）。
- 無 vitest / RTL 測試。
- 無 pre-commit hook、無 CI workflow。
- 唯一自動化檢查是 `npm run lint`（eslint，`package.json:9`）。
- `migrations.py` 自身的冪等性靠手動驗（每個函式先檢查欄位 / 表存在）。

**Reviewer 短期內怎麼辦**：

- 後端改動：手測 — `uvicorn --reload` 起後端，`curl` 打改動的 endpoint
  並比對 status / body；中文輸入用 Unicode escape 或 Playwright UI。
- 前端改動：`cd frontend && npm run build` 必跑（CLAUDE.md 強制）；改後 `npm
  run lint` 確認 eslint 過；UI 行為用 Playwright（架構 spec 不要求 reviewer 必跑，
  但 audit 時若涉及 IME / SW 必跑）。
- DB schema 改動：先在開發機跑 migration，啟動成功 + 影響表 `PRAGMA
  table_info` 確認欄位/索引存在。
- 效能：渲染 endpoint 已有 `time.monotonic()` 計時 log（`render.py:121`、
  `render.py:152`），手動觀察。

**未來 architect cascade 該補的 gate**（從高 leverage 到低）：

1. **pytest smoke**：開一個 `backend/tests/test_smoke.py` — 啟動 app、
   `TestClient` 打 `/api/health`、login → me、create template → preview。
   光這一份就能擋 90% 啟動時的 import / migration 崩潰。
2. **render parity test**：固定一份 layout fixture + 預期輸出 hash，PIL ⇄ Konva
   參數動到時自動失敗。
3. **API contract test**：對 `routers/` 每個端點驗 status + 必要欄位。
4. **frontend-build CI**：`npm ci --legacy-peer-deps && npm run build && npm
   run lint` 在 PR 上跑，擋 dist 沒 build 就 merge。
5. **migrations idempotency test**：跑兩次 `run_migrations()` 都不應拋例外。
