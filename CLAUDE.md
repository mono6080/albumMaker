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
  database.py          # ORM 模型（Template / Project / Student）
  migrations.py        # 啟動時自動執行的 schema 遷移
  crud/
    template_crud.py   # get_template_or_404, get_template_page_or_404
    project_crud.py    # get_project_or_404, get_student_or_404
  routers/
    templates.py       # /api/templates/* 薄路由
    projects.py        # /api/projects/* 薄路由
  services/
    render_service.py  # PIL 頁面合成引擎（canvas 794×1123）
    project_service.py # PDF 輸出、ZIP 打包、氣泡文字合併邏輯
    file_service.py    # 上傳檔案路徑管理

frontend/src/
  api/
    templateApi.js     # 模板相關 API 函式
    projectApi.js      # 專案 / 學生 / 照片 / 渲染 API 函式
    urls.js            # URL 建構函式（preview / download / sticker）
  api.js               # 向後相容 barrel（舊頁面仍從此引入）
  components/
    canvas/BubbleSVG.jsx   # 純 SVG 氣泡框顯示元件
    PhotoManager.jsx        # 照片格管理（上傳 / 位移縮放）
    AlbumPageNav.jsx        # 頁面導覽列
    PanelSwitcher.jsx       # 行動版分頁切換
  constants/
    shapes.js          # BUBBLE_SHAPES, BUBBLE_PRESET_COLORS
    fonts.js           # FONT_OPTIONS, getFontCss(), isFontBold()
  hooks/
    useAutoSave.js     # 通用防抖自動儲存 hook（scheduleSave / flushSave）
  pages/
    TemplateEditor.jsx # 模板版型編輯器（拖曳畫布）
    ProjectBatch.jsx   # 批次學生管理 + 全班氣泡文字
    StudentEdit.jsx    # 單一學生照片 + 個別氣泡文字
    ProjectReview.jsx  # 輸出審閱 + PDF 下載
    TemplateList.jsx   # 模板清單
    ProjectList.jsx    # 專案清單
```

---

## 架構慣例

### 後端

- **薄路由層**：routers 只負責 HTTP 接收/回應，業務邏輯委派給 `services/`，DB 查詢委派給 `crud/`
- **get_or_404**：所有 DB 查詢透過 `get_*_or_404()` 輔助函式，找不到自動回傳 HTTP 404
- **命名規則**：語意化變數名，禁用單字母縮寫；中文注釋
- **Form 參數**：rename 端點使用 `Form(...)`（不是 JSON Body）
- **Query 驗證**：使用 `pattern=` 而非棄用的 `regex=`

### 前端

- **API 分層**：`templateApi.js` / `projectApi.js` / `urls.js` 分別管理，`api.js` 為向後相容層
- **自動儲存**：氣泡文字編輯使用 `useAutoSave` hook，防抖 500ms；渲染前呼叫 `flushSave()` 確保最新
- **BubbleSVG**：純顯示元件，幾何計算與後端 PIL 渲染保持一致
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

### 照片儲存路徑

```
uploads/projects/{project_id}/students/{student_id}/p{page_index}_s{slot_id}.jpg
```

### PDF 輸出路徑

```
uploads/projects/{project_id}/output/{student_name}_{student_id}.pdf
```

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
- **PIL 字型**：render_service 使用系統 TrueType 字型；Windows 上路徑為 `C:/Windows/Fonts/`
