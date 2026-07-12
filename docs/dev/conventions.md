# 程式碼慣例與開發原則

> Owns：命名規則、開發原則、跨模組 invariants。
> 分層設計見 [architecture.md](architecture.md)；文件寫法見 [doc-policy.md](doc-policy.md)。

---

## 命名規則

### Python（後端）

| 類型 | 規則 | 範例 |
|------|------|------|
| 變數 / 函式 | `snake_case`，語意完整，禁用單字母 | `project_output_dir`、`get_template_or_404` |
| 類別 | `PascalCase` | `Template`、`LocalStorageAdapter` |
| 常數 | `UPPER_SNAKE_CASE` | `UPLOADS_DIR`、`FRONTEND_DIST_DIR` |
| 路由函式 | 動詞 + 名詞 | `create_template`、`rename_student` |
| 服務函式 | 動詞 + 名詞，描述行為 | `build_combined_stem`、`merge_project_label_texts_into_pages` |
| 注釋語言 | **中文** | `# 依頁碼升序排列` |

禁止：`p`、`t`、`s`、`r` 等單字母縮寫當一般變數。

### JavaScript / JSX（前端）

| 類型 | 規則 | 範例 |
|------|------|------|
| 變數 / 函式 | `camelCase`，語意完整 | `previewTimestamp`、`activePageLayout` |
| 布林 state | `is` / `has` 開頭 | `isRendering`、`isAddingStudents` |
| 事件處理函式 | `handle` 開頭 | `handleRenderPdf`、`handlePhotoSaved` |
| API 函式 | 動詞 + 名詞 | `fetchAllTemplates`、`batchUpdateStudentTexts` |
| 元件 | `PascalCase` | `BubbleSVG`、`PhotoManager` |
| 常數（模組級） | `UPPER_SNAKE_CASE` | `BUBBLE_SHAPES`、`CANVAS_DISPLAY_WIDTH` |
| CSS | Tailwind utility，不另建命名 | — |
| 注釋語言 | **中文** | `// 防抖自動儲存，500ms 後觸發` |

禁止：`ts`、`idx`、`w`、`h`、`cb` 等縮寫當 state 或 prop 名稱。

## 開發原則

### 只做被要求的事

- 不主動新增功能、重構周邊程式碼、加 docstring、加 type annotation
- 不為「未來可能的需求」設計抽象層或 feature flag
- bug fix 就只修 bug，不順手清理周圍

### 不加多餘的防禦性程式碼

- 不為「不可能發生」的情況加 try/catch 或 fallback
- 信任框架保證（SQLAlchemy session、FastAPI validation）
- 只在真正的系統邊界（使用者輸入、外部 API）做驗證

### 錯誤訊息不外洩

渲染等長流程捕捉 exception 時只回傳通用訊息（如「渲染失敗」），詳細錯誤記 logger，
不暴露給 API 呼叫者（見 `render.py` 的 `render_all_students`）。

## 跨模組 Invariants

改動程式碼時不得破壞以下性質；audit 時逐條驗證：

- **檔案 I/O 一律過 StorageAdapter**：`routers/` 內不得出現 `from pathlib import Path`
  做實際 I/O；細節見 [storage.md](storage.md)
- **DB 單筆查詢過 `get_*_or_404`**：路由不直接 `db.query(...).first()` 抓單筆；
  批次列表查詢例外
- **路由函式 ≤ 10 行**：超過就下移 service；`render_all_students` 是既有合理例外
- **IME 輸入一律用 `CompositionTextarea`**：中文輸入框不得用裸 `<textarea>`，
  其 `onChange` 接收 value 字串（非 event），`onScheduleSave` 由元件在
  compositionEnd 或非組字 onChange 時呼叫，避免 IME 組字被 re-render 打斷
- **共用 axios clients**：不在 `authApi.js` 之外另建 axios instance
  （見 [architecture.md 前端分層](architecture.md#前端分層)）
- **防抖自動儲存統一走 `useAutoSave`**：提供 debounce / abort / flush 語意；
  不自寫 setTimeout 防抖。渲染或送出前必呼叫 `flushSave()` 確保最新
- **Storage key 是相對字串**：DB 欄位（`output_filename`、`background_filename`）
  不存絕對路徑
- **認證 Cookie 優先、Bearer 為輔**：前端 axios 只設 `withCredentials`，
  不注入 Bearer header；Bearer 保留給 API 工具（見 [api.md](api.md)）
- **跨語言共用數值走 design tokens**：畫布尺寸、照片框 insets 係數等
  前後端都要用的純值，正本在 `backend/services/design_tokens.json`、
  前端鏡像 `constants/designTokens.js`——不得在程式碼寫字面值；
  兩檔一致與消費點由 `tests/test_contract_pins.py` 釘住
- **唯一入口不得繞道**：pages_data 寫入（`mutate_student_pages`）、
  補頁（`ensure_page_entry`）、screen PDF key（`student_pdf_key_for_mode`）、
  下載 anchor（`browserFiles`）等唯一入口，由
  `scripts/check_banned_patterns.py`（CI 必跑）擋住重新出現的複本；
  新增合法入口時把檔案加進該腳本的 allowed 清單
- **跨語言鏡像檔要互相指向**：無法共用程式碼的鏡像（如
  `photo_frame_geometry.py` ↔ `photoFrameGeometry.js`、`FONT_MAP` ↔
  `fonts.js`）檔頭必須注明對應檔與釘住它的測試

## Windows 開發環境注意

- **curl 中文輸入**：終端機為 cp950，直接輸入中文會亂碼；用 Unicode escape
  （`上`）或透過瀏覽器 UI / Playwright 操作
- **PIL 字型路徑**：Windows 為 `C:/Windows/Fonts/`；Linux 容器由 Dockerfile
  安裝 noto-cjk（見 [deployment.md](deployment.md)）
