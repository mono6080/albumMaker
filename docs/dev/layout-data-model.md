# 版面資料模型

> Owns：`label_texts` 三層覆蓋、live template revision 與 `layout_json` 格式。
> ORM 與 schema migration 規則見 [data-model.md](data-model.md)；渲染行為見
> [rendering.md](rendering.md)。

---

## 對應文字（label_texts）三層覆蓋

低 → 高（高覆蓋低）：

```
模板預設        layout_json["text_labels"][i]["text"]
   ↓
專案層級覆蓋     projects.label_texts_json = {page_index: {label_id: text}}
   ↓
學生個別覆蓋     students.pages_data_json[i]["label_texts"] = {label_id: text}
```

- 合併唯一進入點：`label_texts.py` 的 `merge_project_label_texts_into_pages()`。
  學生值優先，專案值補足未覆寫處；學生尚無對應頁時以專案值補上空 photos 頁面
- 資料結構工具（欄位↔entry 轉換、對齊正規化、樣式覆寫合併）集中在
  `services/label_texts.py`
- **Pydantic 型別陷阱**：專案層級 payload 是巢狀 dict
  （`{page_index: {label_id: text}}`），端點必須宣告 `dict[str, Any]` —
  Pydantic v2 的 `dict[str, str]` 在 lax mode 也會拒絕 value 為 dict 的資料（422）。
  實際 shape 由 service 驗證：單頁值只允許字串，或
  `{"text": string|null, "text_align": "left|center|right"}`；專案／學生／批次任一層
  malformed 都回 422，不得把任意 JSON 存進渲染資料
- 所有學生頁面寫入共用 `mutate_student_pages()` 的模板頁數邊界檢查；
  `page_index` 必須是 `0 <= index < len(template.pages)`，不可用 `-1` 改到最後一頁，
  也不可因超界索引膨脹 `pages_data_json`

## Live template revision 與頁面結構同步

- Project 直接引用 live `Template`；版面微調在模板明確按「儲存」後套用到所有關聯專案。
  `Template.revision` 每次模板像素／結構儲存遞增，`Project.template_revision` 只在同一筆
  同步 transaction 完成後前進。
- `TemplatePage.id` 是頁面穩定 identity，`page_number`／`page_index` 只是目前顯示順序。
  結構同步依 page id 重排 `Project.label_texts_json` 與 `Student.pages_data_json`；同步後學生
  page entry 會帶 `template_page_id`，照片的 storage path 不因重排而改名。
- 結構變更會先回傳影響摘要與內容綁定的 confirmation hash；確認後才在單一 transaction
  更新模板、既有專案、學生資料、revision、同步前備份與輸出失效。已被舊版流程留下的
  超界頁資料會進同步備份，不會阻擋模板或靜默套到別頁。
- 文字框／照片格從 layout 實體刪除時，確認同步會清掉專案／學生的 active binding；
  同步備份仍保留原始 JSON。`visible=false` 只影響渲染與統計，不得清 binding。
- 專案完成／封存、相本稱呼與內容寫入都使用同一組依 ID 排序的 project locks；同步在鎖內
  第二次讀取 confirmation 內容，避免狀態或名單插入確認與 commit 之間。
- 任何會新增可見照片格的同步會把已完成專案退回可編輯；有關聯專案的模板不可刪到零頁。
- `TemplateProjectSyncBackup` 保存 DB binding、舊頁面快照與同步前的專案完成時間，供稽核／人工救援；資產 retention
  規則見 [storage.md 的 Storage key 格式](storage.md#storage-key-格式)。

## layout_json 格式

每個 `TemplatePage.layout_json` 儲存：

```jsonc
{
  "canvas_width": 794,          // A4 直式 @96dpi
  "canvas_height": 1123,
  "group_contract": "nested-world-v2",
  "photo_slots": [              // 照片格；尺寸模式為 content-box-v1（見下）
    { "id": 1, "x": 50, "y": 120, "width": 400, "height": 300, "rotation": -3,
      "layer_name": "主照片", "visible": true, "locked": false }
  ],
  "text_labels": [              // 對應文字：可被專案/學生層覆蓋
    { "id": 1, "x": 80, "y": 820, "width": 640, "height": 80,
      "text": "{name}今天完成了平衡挑戰！",
      "font_size": 28, "font_color": "#333333",
      "text_align": "center", "line_height": 1.4 }
  ],
  "stickers": [
    { "id": 1, "path": "templates/tmpl1/stickers/star.png",
      "filename": "star.png", "asset_revision": "sha256:...",
      "x": 10, "y": 10, "width": 60, "height": 60 }
  ],
  "groups": [                 // flat registry；以 group ref 表達任意深度巢狀
    { "id": "caption", "z_index": 0, "selection_rotation": 0,
      "layer_name": "標題組", "visible": true, "locked": false,
      "children": [{ "type": "sticker", "id": 1 }, { "type": "text", "id": 1 }] },
    { "id": "page-block", "z_index": 4, "selection_rotation": 0,
      "children": [
        { "type": "photo", "id": 1 },
        { "type": "group", "id": "caption" }
      ] }
  ],
  "material_text_links": [   // 與 group topology 無關的一次性重設捷徑
    { "kind": "material-text-v1", "material_id": 1, "text_id": 1 }
  ],
  "footer": { "text": "{name} · 2026年1月" }
}
```

- `{name}` 渲染時替換為相本稱呼（未設定時沿用完整姓名），`{full_name}` 固定替換為
  完整姓名；變數處理見 `frontend/src/utils/textVariables.js` 與後端渲染層
- **圖層 metadata**：`photo_slots[]` / `text_labels[]` / `stickers[]` / `groups[]` 都可選存
  `layer_name` / `visible` / `locked`。沒存 `visible` 等同可見，只有布林值 `false`
  才隱藏；沒存 `locked` 等同未鎖定。群組隱藏會使整個 descendant subtree 不渲染，
  也不列入專案照片格／文字格與進度統計；既有學生照片和文字覆寫仍保留，
  重新顯示後可繼續使用。舊 layout 不需 migration。
- 儲存模板時，`canvas_width` / `canvas_height` 缺省時採 794×1123，存在時也必須
  分別等於這組 canonical 整數，避免正式輸出縮放放大字級或效果配置；三種 leaf 的
  `x` / `y` / `width` / `height` / `rotation` 都必須是有限安全數值；元素可保留數個
  canvas 範圍的畫布外位置供裁切設計，但尺寸、面積與照片框 border／shadow 展開後的
  實際 buffer、單頁可見元素總數與累積 buffer 預算都受 canvas 相對上限約束。
  內部 `_text_layout_source` 不得由 snapshot 持久化。違反時回
  `422 invalid_layout_geometry`；
  renderer 也會在第一個 Pillow allocation 前重驗，擋住舊資料或繞過 snapshot 的寫入。
- 文字框 `font_size` / `line_height` / `letter_spacing` 若存在，也必須是有限數且落在
  後端渲染安全範圍；模板預設文字與專案／學生覆寫每筆最多 200 字，單頁覆寫另有限制
  entry 數與總字數。違反時回 `422 invalid_layout_typography` 或
  `422 invalid_label_texts`；renderer 對舊資料與姓名代換後的最終文字也先限制工作長度。
- 完整頁面 snapshot 與正式相本渲染最多接受 16 頁；正式渲染會同時保留各頁影像，
  超量必須在第一張圖配置或 DB 寫入前拒絕。
- 氣泡框元素已移除；`text_bubbles` 不屬於現行 layout schema。資料遷移只會自動清除空陣列，
  非空舊資料會保留供人工檢查，儲存 API 會明確拒絕。
- **photo_slots 尺寸模式**：現行為 `content-box-v1`（照片內容區與外框 insets 分離），
  由 `_migrate_photo_slots_to_content_box` 遷移既有資料並寫入備份表；
  幾何計算集中在 `services/photo_frame_geometry.py` 與前端
  `utils/photoFrameGeometry.js`，兩邊必須同步修改
- **通用巢狀群組**：四種 leaves 仍留在原 arrays，以 world `x/y/width/height/rotation` 作為唯一幾何
  權威；`groups[]` 只保存 direct membership、scope order 與 selection axis，group child 可再引用 group。
  Group bounds 每次由所有 descendant leaves 推導，禁止持久化 `x/y/width/height/scale/matrix`。群組
  縮放會改 leaf 外框，但文字的字級、字距、行高與內容不跟著縮放。
- `material-text-v1` 只表示素材與普通文字框的關聯；沒有安全區或持續同步 constraint。
  圖片分析只在使用者明確執行時建立／重設文字框幾何，不建立特殊群組，也不修改圖片幾何。
- `flat-world-v1` 保持可讀；編輯器的 structural／素材文字操作可升級 v2，但批次資料腳本不會
  為了 link 強制改 topology：同一個 v1 group 內的 link 留在 `group.links`，跨 group 候選只列報告；
  reset 同時讀 v1 group links 與 v2 top-level links。
- 本功能沒有 startup migration。既有資料的安全素材文字配對、文字框重設與溢框稽核必須由管理者
  明確執行資料腳本；指令、備份與 partial 契約見
  [testing.md 的資料修復腳本 runbook](testing.md#資料修復腳本-runbook)。
