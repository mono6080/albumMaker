# 資料模型

> Owns：ORM 模型、label_texts 三層覆蓋、layout_json 格式、migrations 規則。
> Storage key 格式見 [storage.md](storage.md)；端點與權限見 [api.md](api.md)。

---

## ORM 模型（`backend/database.py`）

```
User (id, username UNIQUE, display_name, hashed_password, role,
      ui_font_scale, supervisor_id FK→User〔舊版單一主管，僅相容保留〕, created_at)
  ├─ supervisors / managed_teachers  ← teacher_supervisors 多對多（現行機制）
  ├─ owned_projects → Project.owner_id
  └─ comments       → ProjectComment.author_id

teacher_supervisors (teacher_id, supervisor_id)   — 一位老師可有多位主管

TemplatePeriod (id, department, name, status, created_at)   — 期別；狀態掛在期別上
  └─ templates → Template.period_id

Template (id, name, period_id FK→TemplatePeriod, revision, created_at)
  └─ pages → TemplatePage[]（cascade delete-orphan，order_by page_number）

TemplatePage (id, template_id FK, page_number, background_filename, layout_json TEXT)
  └─ UNIQUE(template_id, page_number)

Project (id, name, template_id FK, department, template_period_id FK,
         template_revision,                   ← 已同步的 live template 版本
         owner_id FK→User, created_at, updated_at,
         deleted_at, archive_expires_at,      ← 軟刪除：封存 30 天後到期
         completed_at,                        ← 全班完成：非 NULL 內容鎖定（主管/admin 可退回）
         label_texts_json TEXT)
  ├─ students → Student[]（cascade delete-orphan，order_by order_index）
  └─ comments → ProjectComment[]（cascade delete-orphan）

Student (id, project_id FK, name, order_index, pages_data_json TEXT,
         output_filename, roster_child_id FK→RosterChild〔NULL=同名歧義待確認〕,
         created_at, updated_at)
  └─ pages_data_json 內含 photos / label_texts / skip（skip=true 渲染略過該頁）

RosterChild (id, name〔正規化後、不設 UNIQUE〕, created_at)   — 園所層級孩子名冊
  └─ students → Student.roster_child_id

ProjectComment (id, project_id FK, author_id FK, content, created_at)

TemplateProjectSyncBackup (id, sync_id, template_id, project_id nullable,
         old_revision, old_pages_json, new_page_ids_json,
         project_completed_at, project_label_texts_json, students_json, created_at)
```

- SQLite 連線啟用 `PRAGMA foreign_keys=ON`；`check_same_thread=False`
- 不設 `text_factory`，SQLAlchemy 以 UTF-8 存取；若用 raw sqlite3 讀取需自行處理 encoding
- 角色定義與權限見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)

## 孩子名冊（RosterChild）：自動長出、不需維護

跨專案識別「同一個孩子」，供學期彙整匯出分組。設計原則：老師流程零改動，
名冊由學生建立/改名時自動長出，admin 只處理例外。

- **正規化**：`roster_service.normalize_child_name()` 移除所有空白（含全形）後比對
- **自動連結**（`roster_service.resolve_roster_child_id()`，掛在學生批次新增與改名）：
  同名唯一命中 → 連既有名冊項；查無 → 自動建立；同名多筆（admin 拆分過）→
  `roster_child_id = NULL` 待確認，由學期匯出頁的複核流程處理
- **name 不設 UNIQUE**：同名不同人時 admin 用 link `create_new` 拆成兩筆
  （學期匯出頁的待確認區與各期明細的「拆分」按鈕）；誤拆或改名造成的重複用 merge 併回
- **孤兒自動清理**：改名、換連結、刪學生後若名冊項沒有任何學生，
  由 `delete_roster_child_if_orphaned()` 順手刪除，避免污染歧義判斷與合併選單
- migration `_add_roster_children_and_backfill` 依同一正規化規則回填既有學生；
  冪等檢查鎖在 `students.roster_child_id` 欄位是否存在（避免覆蓋 admin 手動拆分）

## 對應文字（label_texts）三層覆蓋

低 → 高（高覆蓋低）：

```
模板預設        layout_json["text_labels"][i]["text"]
   ↓
專案層級覆蓋     projects.label_texts_json = {page_index: {label_id: text}}
   ↓
學生個別覆蓋     students.pages_data_json[i]["label_texts"] = {label_id: text}
```

- 合併唯一進入點：`project_service.py` 的 `merge_project_label_texts_into_pages()`。
  學生值優先，專案值補足未覆寫處；學生尚無對應頁時以專案值補上空 photos 頁面
- 資料結構工具（欄位↔entry 轉換、對齊正規化、樣式覆寫合併）集中在
  `services/label_texts.py`
- **Pydantic 型別陷阱**：專案層級 payload 是巢狀 dict
  （`{page_index: {label_id: text}}`），端點必須宣告 `dict[str, Any]` —
  Pydantic v2 的 `dict[str, str]` 在 lax mode 也會拒絕 value 為 dict 的資料（422）。
  學生／單頁層級是平坦 `{label_id: text}`，用 `dict[str, str]` 即可

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
- 專案完成／封存、學生增刪與內容寫入都使用同一組依 ID 排序的 project locks；同步在鎖內
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

- `{name}` 渲染時替換為學生姓名（變數處理見 `frontend/src/utils/textVariables.js`
  與後端渲染層）
- **圖層 metadata**：`photo_slots[]` / `text_labels[]` / `stickers[]` / `groups[]` 都可選存
  `layer_name` / `visible` / `locked`。沒存 `visible` 等同可見，只有布林值 `false`
  才隱藏；沒存 `locked` 等同未鎖定。群組隱藏會使整個 descendant subtree 不渲染，
  也不列入專案照片格／文字格與進度統計；既有學生照片和文字覆寫仍保留，
  重新顯示後可繼續使用。舊 layout 不需 migration。
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
- `flat-world-v1` 保持可讀；第一次 structural／素材文字操作才以同一筆 history commit 升級 v2。
  本功能沒有 startup migration；沒有 `groups` 的舊 layout 繼續走既有 flat traversal，舊資料配對延後
  到群組功能驗收後另案處理。

## Migrations 規則（`backend/migrations.py`）

- `run_migrations()` 在後端**每次啟動**時執行；每個子函式必須**冪等**
  （先以 `PRAGMA table_info` / `sqlite_master` 檢查存在再操作）
- 新遷移加在 `run_migrations()` 執行序列**尾端**，不改既有遷移
- **SQLite ADD COLUMN 不支援非常數預設值**（如 `CURRENT_TIMESTAMP`）：
  先加無預設欄位，再 `UPDATE ... SET col = CURRENT_TIMESTAMP WHERE col IS NULL` 回填
- **SQLite 舊版不支援 DROP COLUMN**：用「建新表 → 複製 → 刪舊 → 改名」流程，
  期間暫時關閉外鍵約束（範例見 `_drop_bubble_texts_json_column`；這是舊專案文字欄位的歷史遷移，
  與已移除的 layout 氣泡框無關）
- 大型資料遷移（如 content-box）先寫備份表
  （`template_page_layout_migration_backups`）再改寫
- 首次啟動自動建立 admin 帳號，隨機初始密碼印在啟動日誌
