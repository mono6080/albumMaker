# CLAUDE.md — 幼兒園相本製作系統

Claude Code 在此專案的工作指引。

---

## 專案概覽

幫助幼兒園老師製作個人化相本 PDF 的全端 Web App。

- **後端**：`backend/` — FastAPI + SQLAlchemy + Pillow，port 8765
- **前端**：`frontend/` — React 19 + Vite + Tailwind CSS
- **資料庫**：SQLite，`backend/album_maker.db`

---

## 啟動與建置

```bash
# 開發模式（需兩個終端機）
cd backend && uvicorn main:app --host 0.0.0.0 --port 8765 --reload
cd frontend && npm run dev   # port 5173，/api 自動代理至 8765

# 前端正式建置（必須在修改前端後執行）
cd frontend && npm run build
```

修改前端檔案後必須立即執行 `npm run build`，後端才能提供最新版本。

---

## 目錄結構速查

```
backend/
  main.py              # FastAPI app、路由掛載、SPA catch-all
  database.py          # ORM 模型（Template / Project / Student / User / ProjectComment）
  migrations.py        # 啟動時自動執行的 schema 遷移（冪等）
  auth.py              # JWT 產生/驗證、密碼雜湊、get_current_user / require_role
  crud/
    template_crud.py   # get_template_or_404, get_template_page_or_404
    project_crud.py    # get_project_or_404, get_student_or_404
    user_crud.py       # get_user_or_404, get_user_by_username, get_subordinate_user_ids
  routers/
    auth.py            # /api/auth/login, /api/auth/me
    users.py           # /api/users/* （admin only）
    templates.py       # /api/templates/* 薄路由
    projects.py        # /api/projects/* 薄路由
  services/
    render_service.py    # 公開 API：render_page / render_album / save_album_pdf / save_album_images；持有 UPLOADS_DIR
    draw_helpers.py      # PIL 底層工具：字型載入、圖片合成、形狀繪製、文字換行
    element_renderers.py # 各元素類型渲染：render_photo_slot / render_sticker / render_text_label / render_text_bubble
    project_service.py   # PDF 輸出、ZIP 打包、氣泡文字合併邏輯
    file_service.py      # Storage key 計算與上傳工具
    storage.py           # StorageAdapter 抽象層（LocalStorageAdapter / 未來可換 S3）

frontend/src/
  api/
    authApi.js         # 登入、fetchMe、使用者管理；定義共用 apiClient（含 Bearer interceptor）
    templateApi.js     # 模板相關 API 函式
    projectApi.js      # 專案 / 學生 / 照片 / 渲染 API 函式
    urls.js            # URL 建構函式（preview / download / sticker）
  api.js               # 向後相容 barrel（舊頁面仍從此引入）
  context/
    AuthContext.jsx    # 登入狀態全域管理（currentUser / login / logout）
  components/
    PrivateRoute.jsx          # 路由守衛（未登入 → /login，角色不符 → 無權限提示）
    PropertyPanel.jsx         # 元素屬性面板（照片格 / 氣泡框 / 文字標籤 / 貼圖）
    PhotoManager.jsx          # 照片格管理主元件（上傳 / 位移縮放 / 拖曳排序）
    SlotFramePreview.jsx      # 空格位相框預覽縮圖（純顯示）
    PhotoSlotCard.jsx         # 照片縮圖卡片（PIL 精確位移計算，純顯示）
    AlbumPageNav.jsx          # 頁面導覽列
    PanelSwitcher.jsx         # 行動版分頁切換
    canvas/
      BubbleSVG.jsx           # 純 SVG 氣泡框（ProjectReview 預覽用）
      BubbleKonvaShape.jsx    # Konva Canvas 2D 氣泡框繪製（TemplateEditor 用）
      StickerNode.jsx         # Konva 貼圖節點（非同步載入圖片）
  constants/
    shapes.js          # BUBBLE_SHAPES, BUBBLE_PRESET_COLORS
    fonts.js           # FONT_OPTIONS, getFontCss(), isFontBold()
  hooks/
    useAutoSave.js     # 通用防抖自動儲存 hook（scheduleSave / flushSave）
    usePermissions.js  # 依角色回傳權限旗標（canCreateProject / canEditProject …）
  utils/
    photoUtils.js      # normalizePhotoData / buildItems / photoDims / clampPan
  pages/
    Login.jsx          # 登入頁（表單 + 角色導向）
    UserManagement.jsx # 使用者管理（admin only）
    TemplateEditor.jsx # 模板版型編輯器（react-konva Canvas 2D 拖曳畫布）
    ProjectBatch.jsx   # 批次學生管理 + 全班氣泡文字
    StudentEdit.jsx    # 單一學生照片 + 個別氣泡文字 + 產出並下載 PDF
    ProjectReview.jsx  # 輸出審閱 + PDF 下載 + 留言
    TemplateList.jsx   # 模板清單
    ProjectList.jsx    # 專案清單（依角色過濾操作按鈕）
```

---

## 命名習慣

### Python（後端）

| 類型 | 規則 | 範例 |
|------|------|------|
| 變數 / 函式 | `snake_case`，語意完整，禁用單字母 | `project_output_dir`，`get_template_or_404` |
| 類別 | `PascalCase` | `Template`，`RenderService` |
| 常數 | `UPPER_SNAKE_CASE` | `UPLOADS_DIR`，`FRONTEND_DIST_DIR` |
| 路由函式 | 動詞 + 名詞 | `create_template`，`rename_student`，`render_all_students` |
| 服務函式 | 動詞 + 名詞，描述行為 | `build_combined_stem`，`merge_project_bubble_texts_into_pages` |
| 注釋語言 | **中文** | `# 依頁碼升序排列` |

禁止：`p`、`t`、`s`、`r` 等單字母縮寫當一般變數。

### JavaScript / JSX（前端）

| 類型 | 規則 | 範例 |
|------|------|------|
| 變數 / 函式 | `camelCase`，語意完整 | `previewTimestamp`，`activePageLayout` |
| 布林 state | `is` 或 `has` 開頭 | `isRendering`，`isAddingStudents` |
| 事件處理函式 | `handle` 開頭 | `handleRenderPdf`，`handlePhotoSaved` |
| API 函式 | 動詞 + 名詞 | `fetchAllTemplates`，`batchUpdateStudentTexts` |
| 元件 | `PascalCase` | `BubbleSVG`，`PhotoManager` |
| 常數（模組級） | `UPPER_SNAKE_CASE` | `BUBBLE_SHAPES`，`CANVAS_DISPLAY_WIDTH` |
| CSS class | Tailwind utility，不另建命名 | — |
| 注釋語言 | **中文** | `// 防抖自動儲存，500ms 後觸發` |

禁止：`ts`、`idx`、`w`、`h`、`cb` 等縮寫當 state 或 prop 名稱。

---

## 開發原則

### 只做被要求的事

- 不主動新增功能、重構周邊程式碼、加 docstring、加 type annotation
- 不為「未來可能的需求」設計抽象層或 feature flag
- bug fix 就只修 bug，不順手清理周圍

### 不加多餘的防禦性程式碼

- 不為「不可能發生」的情況加 try/catch 或 fallback
- 信任框架保證（SQLAlchemy session、FastAPI validation）
- 只在真正的系統邊界（使用者輸入、外部 API）做驗證

### 薄路由原則（後端）

```
Router  →  只做 HTTP 解析與回應格式
  ↓
CRUD    →  只做資料庫查詢（get_or_404 / insert / update / delete）
  ↓
Service →  業務邏輯（合併、渲染、打包、路徑計算）
```

路由函式超過 10 行就要考慮是否該移進 service。

### 元件職責分離（前端）

- **頁面元件**（`pages/`）：組合子元件、管理 state、呼叫 API
- **UI 元件**（`components/`）：純顯示或輕量互動，props 進來、事件出去
- **Hook**（`hooks/`）：可重用的 state 邏輯，不含 JSX
- **API 模組**（`api/`）：只做 HTTP，不含業務判斷
- **常數**（`constants/`）：靜態資料，不含邏輯

### 架構慣例

### 後端

- **薄路由層**：routers 只負責 HTTP 接收/回應，業務邏輯委派給 `services/`，DB 查詢委派給 `crud/`
- **get_or_404**：所有 DB 查詢透過 `get_*_or_404()` 輔助函式，找不到自動回傳 HTTP 404
- **Form 參數**：rename 端點使用 `Form(...)`（不是 JSON Body）
- **Query 驗證**：使用 `pattern=` 而非棄用的 `regex=`
- **認證**：資料操作端點加 `Depends(get_current_user)` 或 `Depends(require_role(...))`；圖片 / 預覽 serving 端點**不加 auth**（`<img>` 標籤不帶 Bearer header）
- **StorageAdapter**：所有檔案 I/O 透過 `get_storage()` 取得 adapter，不直接操作 `Path`；本機用 `LocalStorageAdapter`，切換雲端只需實作新 class 並設 `STORAGE_BACKEND` 環境變數

### 前端

- **API 分層**：`templateApi.js` / `projectApi.js` / `urls.js` 分別管理，`api.js` 為向後相容層
- **共用 apiClient**：所有 axios 請求從 `authApi.js` 的 `apiClient` 出發，interceptor 自動帶 Bearer token；401 自動跳登入頁
- **自動儲存**：氣泡文字編輯使用 `useAutoSave` hook，防抖 500ms；渲染前呼叫 `flushSave()` 確保最新
- **BubbleSVG**：純顯示元件，幾何計算與後端 PIL 渲染保持一致（用於 ProjectReview）
- **TemplateEditor Konva**：編輯器以 `react-konva` 取代 CSS div 渲染；`shadowBlur × 1.74` 補償 Canvas2D（sigma = shadowBlur/2）與 PIL GaussianBlur（sigma ≈ radius）的差異
- **常數集中**：形狀清單、顏色預設、字型選項分別定義在 `constants/`

---

## 資料流

### 氣泡文字優先序（低→高覆蓋）

```
模板預設（layout_json.text_bubbles[].text）
  → 專案覆蓋（projects.bubble_texts_json）
      → 學生個別覆蓋（students.pages_data_json[].bubble_texts）
```

渲染時 `merge_project_bubble_texts_into_pages()` 依此順序合併。

### Storage key 格式

所有檔案以相對於 `uploads/` 的 key 字串存取，不使用絕對路徑：

```
# 照片
projects/proj{project_id}/photos/student{student_id}/p{page_index}_slot{slot_id}_{filename}

# 背景圖
templates/tmpl{template_id}/backgrounds/page{page_id}_{filename}

# 貼圖
templates/tmpl{template_id}/stickers/{filename}

# PDF 輸出
projects/proj{project_id}/output/{stem}.pdf
projects/proj{project_id}/output/{stem}_screen.pdf
```

照片移動到不同格位時，`rename_photo_to_slot()` 透過 adapter 重命名，使檔名前綴與新格位保持一致。

---

## 開發習慣（必須遵守）

### 修改後一定要自己測試

改完程式後**不能**直接回報「應該可以了」，必須自己先跑過一遍確認：

- 後端邏輯：用 `curl` 或 Python 腳本實際呼叫 API，比對回應
- 前端邏輯：用 Playwright 或開瀏覽器實際操作目標功能
- 確認輸出符合預期後才回報結果

### 修改前端後立即 build

只要動到 `frontend/src/` 下的任何檔案（`.jsx`、`.js`、`.css`），
修改完成後**立刻**執行，不等使用者說：

```bash
cd D:/projects/album_maker/frontend && npm run build
```

後端 serve 的是 `frontend/dist/`，不 build 使用者看不到新版。

---

## 常見注意事項

- **前端修改後必須 build**：後端直接 serve `frontend/dist/`，dev server 的改動不影響 port 8765
- **中文檔名 PDF**：使用 RFC 5987 `Content-Disposition: attachment; filename*=UTF-8''...` 格式
- **Windows curl 中文輸入**：終端機為 cp950，直接輸入中文會產生亂碼。請使用 Unicode escape（`\u4e0a`）或透過瀏覽器 UI 操作
- **SQLite text_factory**：`database.py` 不設定 `text_factory`，SQLAlchemy 以 UTF-8 存取；若用 raw sqlite3 讀取需自行處理 encoding
- **圖片端點不加 auth**：`<img src>` 是瀏覽器原生請求，不帶 Authorization header。preview / sticker / background / photo 六個 GET 端點不設 `get_current_user`，否則外網（ngrok 等）圖片全黑
- **bcrypt 套件**：使用 `bcrypt` 直接呼叫（`bcrypt.hashpw` / `bcrypt.checkpw`），不透過 passlib（passlib 與 bcrypt 4.x+ 不相容）
- **使用者管理 API body 格式**：`POST /api/users/` 與 `PATCH /api/users/{id}` 接收 JSON body（Pydantic model），前端用 `apiClient.post(url, params)`（axios 預設 JSON），不用 URLSearchParams
- **PIL 陰影 `add_drop_shadow`**（`draw_helpers.py`）：`combined.paste(shadow, (0,0))` 不帶 mask；若帶 mask（自身 RGBA），PIL 會對 alpha 做平方（`alpha² / 255`），陰影會變成約 ¼ 濃度
- **PIL 貼圖透明通道**：`render_sticker`（`element_renderers.py`）直接呼叫 `storage.open_image()` 後 `.convert("RGBA")`，不經 `load_key`；`to_srgb` 會執行 `img.convert("RGB")` 將透明通道填白
- **PIL 字型**：`draw_helpers.py` 的 `get_font()` 使用系統 TrueType 字型；Windows 上路徑為 `C:/Windows/Fonts/`
- **render_service 分層**：`render_service.py` 只持有公開 API 與 `UPLOADS_DIR`（storage.py 從這裡 import 它，不能移走）；PIL 工具在 `draw_helpers.py`，元素渲染在 `element_renderers.py`
