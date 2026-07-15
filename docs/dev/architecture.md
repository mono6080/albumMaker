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
  app_paths.py         後端路徑 owner：BACKEND_DIR / UPLOADS_DIR
  migrations.py        啟動時自動執行的冪等 schema 遷移（規則見 data-model.md）
  auth.py              JWT 產生/驗證、bcrypt 密碼、get_current_user / require_role
  template_periods.py  模板期別的部門常數與狀態邏輯
  crud/                template_crud / project_crud / user_crud / roster_crud（get_or_404 輔助）
  schemas/             Pydantic schema（跨路由共用者）
  routers/
    auth.py            /api/auth/*（login / logout / me）
    users.py           /api/users/*（admin only，含 .xlsx 批次匯入）
    roster.py          /api/roster/*（admin only：名冊配對、學期彙整匯出、老師進度）
    templates/         /api/templates/*，拆分子模組：
      __init__.py        路由組合（periods 先掛載，避免被 /{template_id} 吃掉）
      _helpers.py        序列化與驗證 helper
      periods.py         部門清單、期別 CRUD
      crud.py            模板 CRUD、頁面 CRUD
      assets.py          背景圖、貼圖上傳/讀取
      render.py          單頁與跨頁預覽
    projects/          /api/projects/*，拆分子模組：
      __init__.py        路由組合
      _helpers.py        舊 import 相容 re-export、共用 payload 型別
      schemas.py         回應 schema
      crud.py            專案 CRUD、封存/還原、學生管理、頁面跳過
      photos.py          照片上傳（單張/共用/批次分配）、讀取、mapping
      texts.py           對應文字讀取 / 更新 / 批次更新
      comments.py        審閱留言
      render.py          渲染、PDF / 圖片 / ZIP 輸出
  services/
    render_service.py    頁面渲染 API：render_page / render_album / save_album_pdf /
                         save_album_images；UPLOADS_DIR 只留相容 alias
    element_renderers.py 各元素 PIL 渲染：photo_slot / sticker / text_label
    draw_helpers.py      PIL 低階工具：字型、合成、形狀、文字換行、陰影
    project_service.py   舊 import 相容 facade；新程式直接 import 下列責任 owner
    project_access_service.py  專案 read/write/content/completion 權限判斷
    project_lifecycle_service.py  專案建立、改名、封存、還原、完成與退回 use case
    project_student_service.py  學生新增／複製／改名／刪除與頁面 skip use case
    project_photo_service.py  單張／共用／批次照片、讀取、縮圖與 mapping use case
    project_text_service.py  專案／學生／批次文字 use case
    project_comment_service.py  審閱留言 use case
    output_keys.py       輸出 key、安全檔名與 Content-Disposition
    project_archive_service.py  到期封存專案的 Storage cleanup 與 DB purge
    student_render_service.py   單一學生渲染、dirty-skip、發布 CAS 與 render fingerprint
    project_export_service.py   專案 PDF／圖片 ZIP 串流
    student_pages.py     pages_data_json 的併發安全寫入入口（學生寫鎖、空頁 schema、
                         照片寫入與 mapping 協議）
    preview_cache.py     預覽圖內容定址快取（cache-aside、limiter 內二次查）
    file_service.py      Storage key 計算、上傳驗證與壓縮、照片縮圖（支援 HEIF）
    label_texts.py       label_texts 資料結構工具與專案／學生／模板文字合併
    roster_service.py    舊 import 相容 facade；新程式直接 import 下列責任 owner
    roster_identity_service.py  名冊姓名正規化、自動連結、歧義與 link／merge
    semester_render_service.py  學期缺漏相本逐本補渲染與 partial-success 進度
    semester_export_service.py  學期預覽、分組、ZIP planning／manifest／stream
    teacher_overview_service.py  老師進度總覽與 Excel 匯出
    template_service.py  模板複製（頁面、背景、貼圖資產）
    template_lifecycle_service.py  模板改名與刪除 use case
    template_period_service.py  部門與期別 CRUD use case
    template_asset_service.py  背景／貼圖資產與素材文字框分析
    template_project_sync_service.py  typed template sync plan、影響摘要、備份與 apply
    layout_group_validation.py / layout_group_traversal.py  後端群組驗證與正式渲染 traversal
    layout_groups.py     舊 import 相容 facade
    user_service.py      使用者建立／更新／刪除與 Excel 批次匯入 use case
    export_jobs.py       學期匯出補渲染背景 job（執行緒＋記憶體 registry，進度輪詢）
    photo_frame_geometry.py  照片框幾何（content-box insets、frame rect）
    zip_stream.py        串流 ZIP 骨架（佔 limiter → 逐 entry drain → 釋放）
    storage.py           Storage 公開相容 facade（見 storage.md）
    storage_base.py / storage_local.py / storage_r2.py  adapter 抽象與實作
    storage_cache.py / storage_factory.py  R2 cache 與 call-time env/path factory
    request_limiter.py   BusyLimiter：渲染/打包/上傳並發槽位限制
```

## 前端分層

```
pages/       路由級頁面：組合子元件、管理 state、呼叫 API；每頁一檔
components/  純顯示或輕量互動；canvas/ 子目錄是 Konva 專用元件
hooks/       可重用 state 邏輯（useAutoSave / usePermissions / useInlineEdit），不含 JSX
api/         只做 HTTP，不含業務判斷（authApi / templateApi / projectApi / urls）
context/     AuthContext（全域 currentUser）
constants/   靜態資料（fonts / design tokens），不含邏輯
utils/       純函式工具（photoUtils / editorLayoutModel / layoutGroup* / …）
```

- TemplateEditor 的 Konva 節點拆在 `components/canvas/CanvasNode.jsx`、
  `CanvasArtwork.jsx`、`TemplateCanvas.jsx`；相機與畫布責任見
  [rendering.md 的 TemplateEditor](rendering.md#templateeditor前端編輯器)
- 照片儲存生命週期由 `hooks/usePhotoAutoSave.js` 對接 React，純狀態與 single-flight
  協調器分別在 `utils/photoSaveModel.js`、`utils/photoSaveCoordinator.js`；契約由
  `frontend/tests/unit/photo-save.test.mjs` 釘住
- ClassEdit／StudentEdit 共用 `components/AlbumEditorLayout.jsx` 的 responsive shell；
  ProjectReview 的進度、學生、預覽、留言與下載分散在 `components/review/` 與對應 hooks，
  不把兩種 scope 的資料模型合併
- Login／ProjectList 同步載入；ClassEdit／StudentEdit／ProjectReview 由 `routeLoaders.js`
  lazy load，專案卡片 hover／focus 顯式 prefetch。首包上限由
  `scripts/check_frontend_bundle_budget.mjs` 在 CI 驗證

- API consumer 直接 import `api/authApi.js`、`projectApi.js`、`templateApi.js` 或 `urls.js`；
  不另設跨 domain barrel
- 共用 axios clients：一般請求走 `apiClient`、渲染請求走長 timeout 的 `renderClient`
  （皆定義於 `authApi.js`，`withCredentials` 帶 HttpOnly Cookie、共用 401 interceptor）；
  不得另建 `axios.create()`

## 前端頁面清單

| 頁面 | 路徑 | 用途 |
|------|------|------|
| Login | `/login` | 登入 |
| ProjectList | `/`、`/projects` | 專案清單、建立、封存/還原 |
| ClassEdit | `/projects/:id/edit` | 相本編輯器（全班 scope）：全班共用照片（選格→選分配方式→上傳；依檔名整批匯入為獨立入口）+ 全班對應文字；舊 `/projects/:id/batch` 轉址至此 |
| StudentEdit | `/projects/:projectId/students/:studentId/edit` | 相本編輯器（學生 scope）：單一學生照片 + 個別文字；與 ClassEdit 以 ScopeSwitcher 的全班/個別按鈕互切；下載集中在班級總覽 |
| ProjectReview | `/projects/:id/review` | 「班級總覽」工作台：學生名單 Modal、照片進度與階段引導（製作→全班完成→交件）、單人與全班下載、審閱留言 |
| TemplateList | `/templates` | 模板/期別清單 |
| TemplateEditor | `/templates/:id/edit` | Konva 版型編輯器（見 rendering.md） |
| UserManagement | `/admin/users` | 使用者管理（admin） |
| SemesterExport | `/admin/semester-export` | 學期彙整匯出：名冊分組預覽 + 配對複核 + ZIP 下載（admin；supervisor 唯讀） |
| TeacherOverview | `/admin/teacher-overview` | 老師進度：各老師（含尚未建專案者）的期別專案、照片格填滿進度、空白文字提醒與全班完成狀態（admin 全部；supervisor 管轄老師；PDF 產出狀態歸學期匯出頁） |
| Settings | `/settings` | 個人 UI 偏好（字體縮放） |

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
