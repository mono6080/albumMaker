# 系統架構

> Owns：技術棧、分層設計、目錄結構、模組職責、非目標。
> 資料形狀見 [data-model.md](data-model.md)；渲染細節見 [rendering.md](rendering.md)。

---

## 技術棧

- **後端**：FastAPI + SQLAlchemy 2.0 + Pillow，Python 3.12，port 8765
- **前端**：React 19 + Vite 8 + Tailwind CSS 4 + react-konva（Canvas 編輯器）+ PWA（vite-plugin-pwa）
- **資料庫**：SQLite 單檔 `backend/album_maker.db`（單園所、低並發，無多租戶）
- **儲存**：StorageAdapter 抽象層（本機磁碟 / Cloudflare R2），見 [storage.md](storage.md)
- 版本以 `backend/requirements.txt` 與 `frontend/package.json` 為準，文件不複寫版本號

## 後端三層（薄路由 → CRUD → Service）

```
HTTP request
   ↓
routers/   — 只做 HTTP 解析與回應格式；路由函式超過 10 行就考慮下移 service
   ↓
crud/      — 純 DB 查詢；單筆查詢一律走 get_*_or_404()（找不到自動回 404）
   ↓
services/  — 業務邏輯（合併、渲染、打包、key 計算）
   ↓
StorageAdapter（檔案）/ SQLAlchemy session（DB）
```

## 後端目錄職責

```
backend/
  main.py              FastAPI app、路由掛載、SecurityHeadersMiddleware、CORS、
                       slowapi limiter、SPA/PWA 靜態檔 serving（見下方「SPA catch-all」）
  database.py          ORM 模型（見 data-model.md）
  migrations.py        啟動時自動執行的冪等 schema 遷移（規則見 data-model.md）
  auth.py              JWT 產生/驗證、bcrypt 密碼、get_current_user / require_role
  template_periods.py  模板期別的部門常數與狀態邏輯
  crud/                template_crud / project_crud / user_crud（get_or_404 輔助）
  schemas/             Pydantic schema（跨路由共用者）
  routers/
    auth.py            /api/auth/*（login / logout / me）
    users.py           /api/users/*（admin only，含 .xlsx 批次匯入）
    templates.py       /api/templates/*（模板、期別、頁面、背景、貼圖、預覽）
    projects/          /api/projects/*，拆分子模組：
      __init__.py        路由組合
      _helpers.py        assert_project_readable / writable、共用 payload 型別
      schemas.py         回應 schema
      crud.py            專案 CRUD、封存/還原、學生管理、頁面跳過
      photos.py          照片上傳（單張/共用/批次分配）、讀取、mapping
      texts.py           對應文字讀取 / 更新 / 批次更新
      comments.py        審閱留言
      render.py          渲染、PDF / 圖片 / ZIP 輸出
  services/
    render_service.py    渲染公開 API：render_page / render_album / save_album_pdf /
                         save_album_images；持有 UPLOADS_DIR（storage.py 從這裡 import，不能移走）
    element_renderers.py 各元素 PIL 渲染：photo_slot / sticker / text_label / text_bubble
    draw_helpers.py      PIL 低階工具：字型、合成、形狀、文字換行、陰影
    project_service.py   PDF 輸出、ZIP 打包、label_texts 合併、安全檔名
    file_service.py      Storage key 計算、上傳驗證與壓縮（支援 HEIF、超大圖自動壓縮）
    label_texts.py       label_texts 資料結構工具（欄位↔entry 轉換、對齊正規化、合併）
    photo_frame_geometry.py  照片框幾何（content-box insets、frame rect）
    storage.py           StorageAdapter 抽象（見 storage.md）
    request_limiter.py   BusyLimiter：照片上傳並發槽位限制
```

## 前端分層

```
pages/       路由級頁面：組合子元件、管理 state、呼叫 API；每頁一檔
components/  純顯示或輕量互動；canvas/ 子目錄是 Konva 專用元件
hooks/       可重用 state 邏輯（useAutoSave / usePermissions / useInlineEdit），不含 JSX
api/         只做 HTTP，不含業務判斷（authApi / templateApi / projectApi / urls）
context/     AuthContext（全域 currentUser）
constants/   靜態資料（shapes / fonts），不含邏輯
utils/       純函式工具（photoUtils / bubbleGeometry / renderLayoutModel / …）
```

- `api.js` 與 `api/index.js` 是向後相容 barrel，舊頁面仍從此引入；新程式碼直接 import `api/*.js`
- 共用 axios clients：一般請求走 `apiClient`、渲染請求走長 timeout 的 `renderClient`
  （皆定義於 `authApi.js`，`withCredentials` 帶 HttpOnly Cookie、共用 401 interceptor）；
  不得另建 `axios.create()`

## 前端頁面清單

| 頁面 | 路徑 | 用途 |
|------|------|------|
| Login | `/login` | 登入 |
| ProjectList | `/`、`/projects` | 專案清單、建立、封存/還原 |
| ProjectBatch | `/projects/:id/batch` | 學生名單管理 + 全班對應文字 |
| StudentEdit | `/projects/:projectId/students/:studentId/edit` | 單一學生照片 + 個別文字 + 產出 |
| ProjectReview | `/projects/:id/review` | 輸出審閱 + 下載 + 留言 |
| TemplateList | `/templates` | 模板/期別清單 |
| TemplateEditor | `/templates/:id/edit` | Konva 版型編輯器（見 rendering.md） |
| UserManagement | `/admin/users` | 使用者管理（admin） |
| Settings | `/settings` | 個人 UI 偏好（字體縮放） |
| Offline | — | PWA 離線頁 |

各路由的角色守衛（`PrivateRoute` + `allowedRoles`）見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)。

## SPA catch-all 與 PWA Service Worker 優先序

`main.py` 的 `serve_spa` 必須**先嘗試實體檔案**（`sw.js`、`workbox-*.js`、
`manifest.webmanifest`、`offline.html`），找不到才 fallback `index.html`。
全部回 `index.html` 會讓瀏覽器把 HTML 當 JS 執行 → Service Worker 註冊失敗。
`vite.config.js` 的 `navigateFallback: '/index.html'` 是 workbox 端的對偶設定。

## 非目標（明確不做）

- **多租戶 / SaaS**：無 tenant / 園所隔離欄位
- **分散式 / 多 worker**：SQLite 寫入鎖限制，單 uvicorn 程序
- **即時協作**：無 WebSocket / CRDT
- **切換 RDBMS**：`migrations.py` 全部是 SQLite 方言（PRAGMA、ADD COLUMN workaround）
- **切換前端 canvas 引擎**：PIL⇄Konva 視覺對齊依賴 Konva 具體行為（見 rendering.md），換引擎等於重做
- **前端元件測試（vitest / RTL）**：現有測試防線見 [testing.md](testing.md)
