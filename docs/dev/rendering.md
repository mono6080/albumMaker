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
                     render_text_label / render_text_bubble
   ↓
draw_helpers.py      PIL 低階：get_font / to_srgb / paste_rotated /
                     apply_rounded_corners / add_drop_shadow /
                     draw_speech_bubble / wrap_text / draw_line_with_spacing
```

- 輸出畫質分 **print**（列印）與 **screen**（螢幕）兩種模式；
  下載權限見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)
- PDF 由 img2pdf 產生（`save_album_pdf()` 唯一進入點），避開 PIL 內建 PDF 的色域問題；
  print 頁面內嵌 **JPEG quality 95**（照片內容用 PNG 體積大 5-8 倍且壓縮極慢）
- 渲染 endpoint 有 `time.monotonic()` 計時 log，效能問題先看 log

## 相冊輸出與 dirty-skip

`project_service.py` 的 `render_and_save_student_album()`：

- 只渲染**一次**列印尺寸（2480×3508），螢幕圖由 `derive_screen_images()`
  LANCZOS 降採樣到 794×1123 — 不再跑第二輪渲染
- **dirty-skip**：輸出前以 `_album_render_hash()`（版面 + 合併後頁面資料 +
  學生姓名 + `_RENDER_PIPELINE_VERSION`）比對上次的指紋檔（key 見
  [storage.md](storage.md#storage-key-格式)）；一致且 PDF 還在就直接跳過，
  回傳 `skipped=True`。全班重渲只重做真的改過的學生
- **改渲染邏輯必把 `_RENDER_PIPELINE_VERSION` +1**，否則舊輸出因指紋一致
  不會被重渲（視覺修正不會生效）
- 背景圖同檔名重傳靠 layout 的 `background_version`（`upload_background`
  蓋時間戳）讓指紋失效
- 渲染併發：單本渲染與全班/補渲染 job 都**逐位**取 `album_render_limiter`
  槽（`acquire_blocking`），不整批佔住

## TemplateEditor（前端編輯器）

- react-konva Canvas 2D 畫布，A4 直式；display / real 兩套座標換算與
  z-index 工具在 `utils/renderLayoutModel.js`（其 `buildRenderLayoutModel`
  等 model 函式僅供 render-parity 腳本消費，編輯器實際的 Konva 節點渲染在
  `components/canvas/pageElementNodes.jsx`）
- 四種元素對應 `layout_json` 的四個陣列（格式見
  [data-model.md 的 layout_json](data-model.md#layout_json-格式)）：
  photo → `photo_slots`、text → `text_labels`、bubble → `text_bubbles`（自訂
  `BubbleKonvaShape`）、sticker → `stickers`（`StickerNode`）
- **Illustrator 式通用巢狀群組**：`groups[]` 可引用 photo/bubble/text/sticker/group，但不是第五種
  可繪製物件。Renderer 以每個 group subtree 當 stacking block，依 scope `children[]` 遞迴展平；
  grouped leaf 不再從 root 重複畫。前端 traversal 在 `utils/layoutGroups.js`，後端 traversal 在
  `services/layout_groups.py`；若讀到繞過 validator 的 malformed persisted groups，整頁退回 legacy
  flat traversal，確保每個元素仍只畫一次。
- 任一 scope 的 direct group 可移動、旋轉、四角等比縮放；雙擊或 Enter 每次進一層 isolation 後，
  direct children 才能分別編輯。Group bounds 由 descendant world geometry 即時計算，不存入 layout；
  group scale 改 leaf frame，但 text/bubble typography 在即時預覽與 commit 後皆保持原值。素材文字 link
  不參與 traversal；圖片分析只建立或重設普通文字框，絕不為了文字 fit 拉伸圖片、縮字或改內容。
- **照片格固定比例（UI 層限制）**：新增工具只提供 3:4 直式與 4:3 橫式兩種；
  縮放時 Transformer 對照片格 `keepRatio` 且只留四角把手，屬性面板寬高輸入
  等比連動。底層 `photo_slots` 資料結構不變（仍存任意 width/height，
  舊模板的非標準比例照常渲染，縮放時鎖各自現有比例）
- 草稿與歷史：`draftLayouts`（per-page dirty layout ref）+ `layoutHistories`
  （per-page undo/redo，上限 100），抽在 `hooks/useLayoutHistory.js`
- 儲存流程：只挑 dirty page 逐頁呼叫 `updatePageLayout`；開跨頁預覽前強制先儲存
- `BubbleSVG` 是 ProjectReview 用的純 SVG 顯示元件，幾何計算與後端 PIL 一致

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

### 中文標點對齊：逐字 anchor='la'

- `draw_helpers.py` 的 `draw_line_with_spacing()` 以 `anchor='la'`
  （ascender line）逐字繪製，先用全字串 `textbbox(anchor='la')[1]` 換算 `la_y`
  統一 baseline
- 違反：用 `anchor='lt'` 會讓 `，`、`。` 以自身 glyph 頂端對齊，標點往上飄

### 文字垂直對齊：konva_v_offset

- `element_renderers.py` 的 `render_text_label()`：`start_y` 加
  `konva_v_offset = int(line_height_float / 2 - descent + la_offset)`，
  補償 Konva `textBaseline='middle'` 相對 PIL 視覺頂端的落差
  （msjh 28pt / lineHeight=1.4 約 18px）
- 違反：文字在編輯器看起來置中、PDF 輸出偏上或偏下

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

### EXIF 方向：open_image 統一 transpose

- `LocalStorageAdapter.open_image()` 開檔後立即 `ImageOps.exif_transpose(img)`
- 違反：iPhone 直拍照片渲染時偏轉 90°。**任何新 storage adapter 都必須保留
  這個行為**（介面層 invariant）

## 字型

- `draw_helpers.py` 的 `get_font(size, family)` 走 `FONT_MAP` / `CJK_FONTS`
  fallback 列表；Windows 讀 `C:/Windows/Fonts/`，Linux 容器由 Dockerfile 安裝
  noto-cjk / wqy（見 [deployment.md](deployment.md)）
- 全部路徑都找不到時 fallback `ImageFont.load_default()`（點陣字，中文渲染崩）—
  容器必裝 CJK 字型
- 前端字型選項與粗體判斷集中在 `constants/fonts.js`
  （`FONT_OPTIONS` / `getFontCss()` / `isFontBold()`），需與後端 `FONT_MAP` 對應

## 渲染一致性測試

`tests/test_render_regression.py`（後端像素區域檢查）與
`npm run test:render-parity`（前端 stage model + Konva rasterize）共用同一份
`tests/fixtures/render_smoke_layout.json` 固定版型；改渲染邏輯必跑，
指令見 [testing.md](testing.md)。
