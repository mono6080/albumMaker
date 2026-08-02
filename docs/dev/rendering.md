# 渲染管線與 PIL ⇄ Konva 視覺對齊

> Owns：渲染流程、TemplateEditor 編輯器架構、所有 PIL⇄Konva 補償參數、字型。
> 本檔的補償條目是本專案最容易踩雷的部分 — 改動任何一條前先讀「違反代價」。

---

## 渲染管線

```
render_service.py    公開 API：render_page / render_album / render_preview_page /
                     scale_layout* / save_album_pdf / save_album_images
   ↓
element_renderers.py 各元素渲染：render_photo_slot / render_sticker /
                     render_text_label
   ↓
draw_helpers.py      PIL 低階：get_font / to_srgb / paste_rotated /
                     apply_rounded_corners / add_drop_shadow /
                     wrap_text / draw_line_with_spacing
```

- 輸出畫質分 **print**（列印）與 **screen**（螢幕）兩種模式；
  下載權限見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)
- PDF 由 img2pdf 產生（`save_album_pdf()` 唯一進入點），避開 PIL 內建 PDF 的色域問題；
  print 頁面內嵌 **JPEG quality 95**（照片內容用 PNG 體積大 5-8 倍且壓縮極慢）
- 模板單頁／跨頁預覽回傳無損 PNG；**專案／學生互動預覽回傳 JPEG**
  （quality 80，照片內容 PNG 體積大 3-5 倍），內容定址快取使用 `.jpg`。
  正式 print／screen PDF 與單頁 JPEG 輸出不受影響。**手機圖片分享**逐頁抓
  正式輸出的單頁 JPG 端點（`…/images/{page_number}?mode=`）——內容與交件
  一致並跟隨畫質切換，不走預覽管線；該端點只讀目標頁、不整批載入
- 互動預覽先在 794×1123 canonical 像素完整渲染，再以 LANCZOS 縮成顯示尺寸；
  縮圖不另跑一套字級、行距或裁切公式
- 專案／學生預覽回傳內容定址 ETag 與 `private, no-cache, must-revalidate`；
  前端 URL 另帶 build version，部署新版渲染程式後不沿用舊頁面記住的預覽 URL
- 專案／學生預覽路由是 async：`If-None-Match` 相符直接回 304（key 純由 payload
  hash 決定，不先讀 storage bytes）；cache miss 排到渲染槽時若 client 已斷線
  （快速切頁被放棄的 `<img>`），跳過渲染回 204 把槽讓給還在等的請求
- 前端切頁／切學生的預覽與縮圖請求經 `useSettledValue`（leading+trailing
  debounce，300ms）：單次切換立即載入，快速連切只對停下來的那頁發請求；
  照片存檔後只作廢實際變動頁的預覽 timestamp（diff server shadow），
  不再全書失效
- `PagePreview` 走 `previewImageCache.js`：以 `fetch` 把預覽抓成 blob 存記憶體
  LRU 快取，`<img>` 只吃 blob URL。預覽 URL 內容定址（帶 t/revision/
  render_build）故 bytes 不可變，抓到即可永久快取——切回看過的頁是記憶體命中、
  即時，不碰網路。切走不 abort 進行中的 fetch（暖快取），fetch 由 12s timeout
  保護、只會 resolve/reject/逾時。這取代舊的 `<img src>` 直連：正式站 Cloudflare
  + nginx h2 下，切頁 abort 的 stream 會讓同 URL 的 `<img>` 請求在連線層 stall
  十幾秒，且 `<img>` 對被中斷載入有 dedup 怪癖
- 渲染 endpoint 有 `time.monotonic()` 計時 log，效能問題先看 log

## 相冊輸出與 dirty-skip

`student_render_service.py` 的 `render_and_save_student_album()`：

- 只渲染**一次**列印尺寸（2480×3508），螢幕圖由 `derive_screen_images()`
  LANCZOS 降採樣到 794×1123 — 不再跑第二輪渲染
- **dirty-skip**：輸出前以 `_album_render_hash()`（版面 + 合併後頁面資料 +
  完整姓名 + effective 相本稱呼 + `_RENDER_PIPELINE_VERSION`）比對上次的指紋檔（key 見
  [storage.md](storage.md#storage-key-格式)）；只有指紋一致、print/screen 兩份 PDF
  與所有 print/screen 單頁圖都存在時才跳過並回傳 `skipped=True`。任一承諾輸出遺失
  就重建整套 canonical outputs；全班重渲只重做真的改過或輸出不完整的學生
- 文字維持模板字級，不做 auto-fit 或縮字。前後端都先在 canonical 794×1123 座標排版，
  使用相同的 character-wrap、advance width、字距、浮點行距與前 N 行可見規則；glyph／陰影
  超出 local frame 的部分先裁切再旋轉。溢框稽核另走未裁切量測路徑，操作方式見
  [testing.md 的資料修復腳本 runbook](testing.md#資料修復腳本-runbook)
- 姓名變數由後端 `text_variables.py` 解析，前端 `textVariables.js` 鏡像同一契約：
  `{name}` 使用 `ProjectStudent.effective_album_name`，`{full_name}` 使用完整姓名；raw 文字、兩個
  replacement 與 final 結果都套用 200 字上限。已歸班 ProjectStudent 的 effective 值動態解析
  `Student.album_name`，未歸班才讀 legacy `ProjectStudent.album_name`；名冊 raw 值與 authority
  切換狀態都納入 publish CAS，避免修改途中發布舊輸出。
  TemplateCanvas 的一般文字與 footer 先分別顯示
  `（相本稱呼）`、`（完整姓名）`，與後端模板預覽一致；契約由
  `tests/test_render_name_variables.py`、`frontend/tests/unit/text.test.mjs` 與
  `tests/fixtures/template_text_variable_parity.json` 釘住。相本稱呼屬像素輸入，必須同時納入
  preview payload、render hash 與 publish CAS。
- 圖層 `layer_name` / `locked` 與素材文字 link 是編輯器 metadata，不納入相冊與預覽的渲染指紋；
  沒有群組時，僅為 link 存在的 `group_contract` 也不納入；`visible` 會改變像素，因此必須納入
- `_RENDER_PIPELINE_VERSION` 由 `_RENDER_PIPELINE_FILES` 的實際內容自動雜湊；
  新增渲染來源檔時必加入清單，否則舊輸出可能因指紋未變而跳過重渲。
  **反向也成立**：清單內檔案的任何修改（含註釋、非像素邏輯）都會讓全站輸出
  過期、部署後觸發整批重渲 — 非渲染邏輯不要放進這些檔案（例：下載新鮮度
  檢查住在 `completion_render_service.py`，即使它重組的是 dirty-skip 判斷）
- 背景圖採內容版本 key，layout 的 `background_version=sha256:...` 也會納入指紋；同名新內容
  不覆寫舊資產
- 背景、貼圖與素材文字框分析一律先依實際輸出框做 bounded decode，再執行
  EXIF transpose、ICC / RGB / RGBA 轉換。背景新上傳最多接受一張 print 頁面的像素數
  （2480×3508），貼圖最多接受合法最大 leaf 的兩張 print 頁面像素數；舊 storage 的
  超額 JPEG 只有在 decoder `draft` 後落入相同安全預算才繼續，超額 PNG / WebP 在
  配置像素前直接略過渲染或由分析端回 422。模板預覽最多同時 4 個，模板素材上傳／分析
  與照片處理共用最多 2 個重工作槽。照片列表縮圖在 cache miss 時也先 bounded decode；
  同一縮圖 key 使用 single-flight，且不同尺寸的縮圖生成共用照片重工作槽
- 渲染捕捉 `Project.template_revision` 與內容快照，完成後在 per-student render lock 內做
  revision/content CAS 才發布 canonical PDF/JPG 與 `output_filename`。模板若在慢渲染途中更新，
  舊渲染不得晚到覆寫新輸出或重新發布已失效 PDF；CAS 也包含 Project／ProjectStudent `created_at`，
  防止 SQLite 重用刪除後的 id 形成 ABA；全班／學期補渲染也不跨學生重用舊 layout。
  專案／學生改名與刪除使用相同 project→student locks，完成後失效並清除舊 canonical 輸出
- 渲染併發：單本渲染與全班/補渲染 job 都**逐位**取 `album_render_limiter`
  槽（`acquire_blocking`），不整批佔住

## 渲染時機：完成觸發背景渲染與下載前補渲

`services/completion_render_service.py`（單 uvicorn 程序、fire-and-forget）三層防線：

- **完成即背景渲染**（即時）：標記單生完成、手動全班完成、改名清輸出
  （`project_lifecycle_service` 三個觸發點）後，以 daemon 執行緒＋獨立
  `SessionLocal` 逐位渲染（`actor_id=None` 系統渲染，不套編輯 ACL）。
  完成即內容鎖定，此時渲染即定稿；失敗只記 log，由後兩層兜底
- **啟動收斂掃描**（自癒）：server 啟動後 `reconcile_completed_renders()` 背景掃
  全部未封存專案的有效完成學生，逐位指紋補渲 — 收斂事件觸發漏掉的過期輸出
  （`_RENDER_PIPELINE_VERSION` 更新、重啟中斷、歷史資料），部署後的 warm-up
  由此涵蓋。已 fresh 只花指紋比對；`RENDER_RECONCILE_ON_STARTUP=0` 可停用
  （測試 conftest 預設關）
- **下載一律最新**（保證）：單生 PDF／圖片 ZIP／單頁 JPG 下載端點在閘門後呼叫
  `ensure_student_render_fresh()`；全班 PDF／圖片 ZIP 在串流前
  `ensure_project_renders_fresh()`。先走**只讀快路**
  （指紋一致＋輸出齊全，不取渲染槽）— 背景渲染進行中時新鮮內容的下載
  不排渲染佇列；過期才取槽就地補渲。全班版的新鮮度檢查以 thread pool
  **並行**（每執行緒獨立 session；慢的 R2 storage 往返並行、DB 快照由
  project content lock 自然序列化），常態全 fresh 時 ZIP 幾乎立即開始。
  不分角色（含唯讀）拿到的都是當下內容，不再有「尚未產生」404
- 前端班級總覽因此**不再於下載前逐位渲染**（`useProjectReviewDownloads`），
  下載按鈕直接觸發；測試中背景渲染由 `tests/conftest.py` autouse fixture 停用，
  觸發契約見 `tests/test_completion_auto_render.py`

## TemplateEditor（前端編輯器）

- react-konva Canvas 2D 畫布，A4 直式；版面 geometry 有 real space（794×1123）與
  page space（530×750），手機／平板另有只供檢視的 viewport space。real / page 換算與
  z-index 工具在 `utils/renderLayoutModel.js`（其 `buildRenderLayoutModel`
  等 model 函式僅供 render-parity 腳本消費，編輯器實際的 Konva 節點渲染在
  `components/canvas/pageElementNodes.jsx`）
- Responsive camera 的 pure math 在 `utils/canvasCamera.js`，ResizeObserver 與 fit/manual lifecycle
  在 `hooks/useCanvasCamera.js`。`components/canvas/TemplateCanvas.jsx` 是唯一 Stage owner：Stage 使用
  viewport pixels，`#page-camera` Group 才套 pan/zoom 並裁切 530×750 page boundary，Transformer 留在
  camera 外維持 screen-space handles；父層只能透過 ref 呼叫 fit、zoom 與讀取 viewport/page 座標。
  `CanvasArtwork.jsx` memo 化繪圖樹且不接收 camera state，`CanvasNode.jsx` 負責單一物件的即時預覽與
  commit，因此純 pan／pinch frame 不得重 render TemplateEditor／Artwork。Camera、sheet、responsive
  panel 與多選模式都是 editor view state，不得進入 layout、dirty、undo 或 save payload；手勢尾端的
  synthetic tap 也不得清除既有選取。此契約由 `template-editor-mobile.spec.js` 的 render probe 釘住。
- 分頁草稿與 undo/redo 的狀態機在 `utils/layoutHistoryModel.js`（純模組、不含 React），
  `hooks/useLayoutHistory.js` 只是把結果接到畫面狀態的薄層。四張表：每頁的草稿版面、
  伺服器基準版本、undo/redo 堆疊、以及連續同類操作的合併群組。三條容易寫錯而且**不會報錯**
  的規則寫在那裡並由 `tests/unit/layout-history.test.mjs` 釘住：非同步上傳的結果要寫回
  **發起上傳的那一頁**而不是使用者切過去的那一頁；上傳結果要疊在最新草稿上而不是覆蓋回基準
  版本；儲存請求還在飛時又編輯過的草稿必須保留並搬到正式 page id（比的是**物件 identity**，
  不是內容）。
- TemplateEditor 只協調 route 與 responsive composition；selection、clipboard、shortcuts、素材分析、
  文件／完整快照 CAS、離頁保護分別由 `useEditorSelection.js`、`useLayoutClipboard.js`、
  `useEditorShortcuts.js`、`useMaterialTextSuggestion.js`、`useTemplateEditorDocument.js`、
  `useTemplateEditorNavigationGuard.js` 持有。Header／空狀態／模板使用提示在 `components/editor/`；
  save-in-flight 期間新增的 draft 必須由文件 hook 繼續送下一輪 snapshot，不可被前一輪 response 清掉。
- TemplateEditor 的 UI 模式固定為 phone `<768px`、tablet `768–1023px`、desktop `>=1024px`；phone
  使用 canvas-first top bar、bottom dock/sheets，tablet 使用左欄與手動 side drawer，desktop 使用三欄
  static inspector。Phone/tablet 選取物件不會自動開 inspector；完整互動與驗收契約見
  [mobile-template-editor-v1.md](../specs/mobile-template-editor-v1.md)。
- 三種元素對應 `layout_json` 的三個陣列（格式見
  [layout-data-model.md 的 layout_json](layout-data-model.md#layout_json-格式)）：
  photo → `photo_slots`、text → `text_labels`、sticker → `stickers`（`StickerNode`）
- **Illustrator 式通用巢狀群組**：`groups[]` 可引用 photo/text/sticker/group，但不是第四種
  可繪製物件。Renderer 以每個 group subtree 當 stacking block，依 scope `children[]` 遞迴展平；
  grouped leaf 不再從 root 重複畫。前端 contract/graph、query、geometry、command 分別在
  `utils/layoutGroupContractGraph.js`、`layoutGroupQueries.js`、`layoutGroupGeometry.js`、
  `layoutGroupCommands.js`，`layoutGroups.js` 只保相容 exports；TemplateEditor 對同一 immutable
  page layout 以 `editorLayoutModel.js` 單次建圖。後端驗證與正式 traversal 分別在
  `services/layout_group_validation.py`、`services/layout_group_traversal.py`，`layout_groups.py`
  只保相容 exports；若讀到繞過 validator 的 malformed persisted groups，整頁退回 legacy flat traversal，確保每個
  元素仍只畫一次。前端 export/model 契約由 `frontend/tests/unit/groups-contract.test.mjs` 釘住。
  圖層可見性契約見
  [layout-data-model.md 的 layout_json](layout-data-model.md#layout_json-格式)。
- 任一 scope 的 direct group 可移動、旋轉、四角等比縮放；雙擊或 Enter 每次進一層 isolation 後，
  direct children 才能分別編輯。Group bounds 由 descendant world geometry 即時計算，不存入 layout；
  group scale 改 leaf frame，但 text typography 在即時預覽與 commit 後皆保持原值。素材文字 link
  不參與 traversal；圖片分析只建立或重設普通文字框，絕不為了文字 fit 拉伸圖片、縮字或改內容。
- **照片格固定比例（UI 層限制）**：新增工具只提供 3:4 直式與 4:3 橫式兩種；
  縮放時 Transformer 對照片格 `keepRatio` 且只留四角把手，屬性面板寬高輸入
  等比連動。底層 `photo_slots` 資料結構不變（仍存任意 width/height，
  舊模板的非標準比例照常渲染，縮放時鎖各自現有比例）
- 草稿與歷史：`draftLayouts`（以穩定 `editorKey` 索引的 per-page dirty layout ref）+
  `layoutHistories`（per-page undo/redo，上限 100），抽在 `hooks/useLayoutHistory.js`。新頁在按儲存前
  只有 client key，不會先寫入資料庫。
- 儲存流程：新增、刪除與版型修改都先留在前端；使用者明確按「儲存」後，才以
  `PUT /api/templates/{id}/pages` 送出完整頁面快照，由後端在單一 transaction 內完成新增、刪除、
  重排與版型更新。儲存失敗會保留本地草稿；有未儲存變更時，跨頁預覽會提示先儲存且不會隱式寫 DB。
- 模板已有 Project 時，編輯器顯示影響數；純版面微調直接同步，頁面／可填欄位結構變更
  先顯示照片、文字、skip、已完成專案影響摘要並再次確認。Project 端以 `template_revision`
  bust 模板 JSON 與瀏覽器預覽 URL 快取。

## PIL ⇄ Konva 補償條目

每條格式：**參數 / 原因 / 違反代價**。

### 陰影補償：shadowBlur × 1.74

- 前端（TemplateEditor）Konva shadowBlur 需乘 1.74：Canvas2D 的 sigma = blur / 2，
  PIL `GaussianBlur(radius)` 實測 sigma ≈ radius × 0.87
- 違反：編輯器預覽與 PDF 輸出陰影濃淡不一致，WYSIWYG 失效

### add_drop_shadow 的 paste 不帶 mask

- `draw_helpers.py` 的 `add_drop_shadow()`：`combined.paste(shadow, (0,0))`
  **不帶** alpha mask；帶自身 RGBA 當 mask 時 PIL 會對 alpha 做平方
  （`alpha² / 255`），陰影變約 ¼ 濃度
- 違反：輸出陰影幾乎看不見

### 文字換行與字距：advance width + Konva character-wrap

- `draw_helpers.py` 的 `wrap_text()` 鏡像 Konva `wrap='char'`：填滿實際框寬後逐字
  斷行，空白／連字號不是特殊斷點；仍 trim 行尾／行首空白，計寬用 glyph advance，
  不用 ink bbox
- Konva 的 line width 會加 `字元數 × letterSpacing`（包含行尾 spacing）；
  後端 `_line_width_with_spacing()` 與置中／靠右起點使用同一公式
- 違反：英文／中英混排會在不同字元斷行，置中與靠右位置也會漂移

### 文字垂直對齊：固定 alphabetic baseline

- `text_layout.py` 保留浮點 `font_size × line_height`，以固定 baseline 序列排列每一行；
  `draw_line_with_spacing()` 使用 `anchor='ls'`，標點、英文 descender 與中文字共用 baseline
- 固定高度只保留最前面可容納的 N 行再垂直置中，與 Konva 相同；後端 preview／print
  由未縮放的 `_text_layout_source` 決定相同行內容，再映射到輸出尺寸
- 違反：若逐行按 glyph 視覺頂端排，`。，`、`gjpqy` 等行會相差 8px 以上；
  若把全文置中後才裁切，前端顯示開頭、PDF 卻可能只剩中間段落

### 前端文字量測：canonical real space

- `textRenderModel.js` 讓 Konva Text 在 794×1123 real space 使用原始框尺寸、字級與字距，
  並以 64× 座標消除 Canvas／FreeType 小字 hinting 的換行邊界差，再縮回 real space；
  外層才以 `CANVAS_SCALE` 顯示。後端 `text_layout.py` 使用同一倍率
- `TemplateCanvas.jsx` 將 Konva scene backing density 固定為 `794 / 530`，不跟隨裝置
  DPR；100% 顯示時原生 scene canvas 為 794×1123，CSS 尺寸為 530×750。hit canvas
  維持 1× 邏輯座標，不改變選取與拖曳行為
- 已連結素材的文字框以 `measureTextLabelCjkCapacity()` 和相同 canonical Konva 排版，
  單次量測全形「字」的 advance，再以每行字數 × 可見行數 O(1) 推算容量，並在屬性
  面板顯示約可容納字數；結果只供設計提示、不寫入
  layout，也不縮字。中英混排與手動換行仍以實際預覽為準
- 不得加未存入 schema 的左右 inset、最小 display 字級或內容截斷；local clip group
  同時裁 glyph 與文字陰影
- 違反：字型 hinting、隱性 padding 或 60 字上限會改變可容納字數

### 貼圖透明通道：render_sticker 不經 to_srgb

- `render_sticker()` 直接 `storage.open_image(...).convert("RGBA")`；
  `to_srgb()` 內含 `img.convert("RGB")` 會把透明通道填白
- 違反：貼圖透明背景變白色方塊

### 照片亮度/對比：LUT 公式與 CSS filter 一致

- 照片資料的 `brightness` / `contrast`（預設 1.0，UI 範圍 0.5–1.5）在
  `render_photo_slot()` 的 `_apply_photo_adjustments()` 以 LUT 套用，
  逐步比照瀏覽器 CSS `filter: brightness() contrast()` 的實際行為：
  1. `value * brightness`
  2. **clamp 回 [0,255]**（CSS 的 `brightness()` 與 `contrast()` 是兩個獨立
     filter 函式，瀏覽器會把前一個函式的輸出 clamp 到值域後才送進下一個）
  3. 以 **127.5 為樞軸**做對比（CSS `contrast()` 的 intercept 是 `[0,1]`
     值域的 `0.5`，換算 8-bit 是 127.5，**不是** 128）
  4. 最終再 clamp 回 [0,255]

  只調整 RGB，保留 alpha。前端預覽（PhotoEditModal / PhotoSlotCard）
  直接用瀏覽器原生 CSS filter，天生跟這個公式一致；`utils/photoUtils.js`
  的 `buildPhotoFilterCss()` 是唯一組字串的地方，兩邊都要引用它
- **違反（已修過的坑）**：
  - 用 PIL `ImageEnhance.Contrast`（以影像灰階平均為樞軸）會讓編輯器預覽與
    PDF 輸出的對比效果不一致
  - 漏掉步驟 2 的中間 clamp：brightness > 1 疊加 contrast < 1 時，
    連續運算比瀏覽器的「先 clamp 再算」结果更亮，PDF 會比預覽亮
  - 樞軸誤用 128：與 CSS 實際的 127.5 有 ±0.25 個灰階的系統性偏差

### 照片 zoom 裁切：只配置最後可見區域

- `draw_helpers.py` 的 `load_key_for_box()` 先把既有「整張 cover resize 後再依
  scale／offset 裁切」公式反算成原圖 source box，只裁出可見區、視需要 `reduce()`，
  再做 ICC→sRGB 與 LANCZOS 到照片框；中間 resize 不得隨 zoom 放大超過輸出框。
- 前端、API 與舊 DB renderer 共用的 zoom 上限是 3×；JPEG 依 cover×zoom 的 2×
  取樣需求先走 orientation-aware draft，且完整 decode 必須落在安全 pixel cap 後才做
  EXIF transpose。超額非 JPEG 在 pixel load 前拒絕。
- `scale` / `offset_x` / `offset_y` 的像素語意由小圖 reference regression 與舊公式逐像素
  比對釘住；舊 DB 的非有限或超界 transform 在 renderer 先依 API 合法範圍收斂。
- 違反：滿頁照片在 print 模式搭配 `scale=10` 會先嘗試建立約
  24800×35080 RGBA 中間圖，單張即可耗盡 worker 記憶體。

### EXIF 方向：open_image 統一 transpose

- `LocalStorageAdapter.open_image()` 開檔後立即 `ImageOps.exif_transpose(img)`
- 違反：iPhone 直拍照片渲染時偏轉 90°。**任何新 storage adapter 都必須保留
  這個行為**（介面層 invariant）

## 字型

- `draw_helpers.py` 的 `get_font(size, family)` 優先讀
  `frontend/public/fonts/`（Docker 為 `/frontend/dist/fonts/`）內的 OFL Noto TC
  可變字型；sans keys 共用 Noto Sans TC，serif keys 共用 Noto Serif TC，
  `msjhbd` 固定選 Bold named instance，其餘固定選 Regular
- 前端以 `@font-face` 宣告同一批字型，瀏覽器優先下載較小的 WOFF2，同源 TTF
  留作 fallback；React 應用先正常掛載，只有模板編輯器 route 在 Konva 掛載前等待
  Regular、Bold 與 Serif。載入失敗時顯示明確錯誤並保持畫布未掛載，不可用 generic
  fallback 進入編輯器。45 秒 timeout 只處理瀏覽器字型 API 永久 pending；
  `loadingerror`、Promise rejection 與空 face 結果會立即失敗。timeout 可在同一頁延續
  尚在下載的 FontFace；已進入 terminal error 的 CSS FontFace 必須 reload 新 document
- FastAPI 靜態檔服務必須明確註冊 `.woff2`、`.woff`、`.ttf` MIME；Windows
  `mimetypes` registry 不保證內建這些類型，而全域 `nosniff` 不允許以
  `text/plain` 僥倖載入
- 系統 CJK 字型只作 bundled asset 遺失時的 fallback（見
  [deployment.md](deployment.md)）
- 全部路徑都找不到時 fallback `ImageFont.load_default()`（點陣字，中文渲染崩）—
  容器必裝 CJK 字型
- 前端字型選項與粗體判斷集中在 `constants/fonts.js`
  （`FONT_OPTIONS` / `getFontCss()` / `isFontBold()`），需與後端 `FONT_MAP` 對應
- `tests/test_font_parity.py` 驗證前後端 family 映射、Regular / Bold instance、
  OFL 授權、資產 SHA-256 manifest 與 Docker 路徑；manifest 也納入 render pipeline
  fingerprint，換字型會使既有輸出失效並重繪

## 渲染一致性測試

`tests/test_render_regression.py`（後端像素區域檢查）與
`npm run test:render-parity` 涵蓋 stage model、Konva rasterize，以及真 Chromium／production
Pillow 使用同源 bundled variable font（瀏覽器 WOFF2、Pillow TTF）的 8 組文字排版與
5 組 raster 比較；前者釘住完整換行、
可見行、x、baseline 與行距，後者釘住 regular／bold／serif、overflow、旋轉陰影的 alpha bbox、
row bands、雙向 mask overlap 與框外裁切。改渲染邏輯必跑，指令見 [testing.md](testing.md)。
