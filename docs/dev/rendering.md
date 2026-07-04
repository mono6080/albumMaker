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
- PDF 由 img2pdf 產生（`save_album_pdf()` 唯一進入點），避開 PIL 內建 PDF 的色域問題
- 渲染 endpoint 有 `time.monotonic()` 計時 log，效能問題先看 log

## TemplateEditor（前端編輯器）

- react-konva Canvas 2D 畫布，A4 直式；display / real 兩套座標
  （`toDisplayCoord` / `toRealCoord`，模型集中在 `utils/renderLayoutModel.js`）
- 四種元素對應 `layout_json` 的四個陣列（格式見
  [data-model.md 的 layout_json](data-model.md#layout_json-格式)）：
  photo → `photo_slots`、text → `text_labels`、bubble → `text_bubbles`（自訂
  `BubbleKonvaShape`）、sticker → `stickers`（`StickerNode`）
- **照片格固定比例（UI 層限制）**：新增工具只提供 3:4 直式與 4:3 橫式兩種；
  縮放時 Transformer 對照片格 `keepRatio` 且只留四角把手，屬性面板寬高輸入
  等比連動。底層 `photo_slots` 資料結構不變（仍存任意 width/height，
  舊模板的非標準比例照常渲染，縮放時鎖各自現有比例）
- 草稿與歷史：`draftLayouts`（per-page dirty layout ref）+ `layoutHistories`
  （per-page undo/redo，上限 100）
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
