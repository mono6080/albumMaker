# 資料模型

> Owns：ORM 模型、孩子名冊、園所／學期資料與 migrations 規則。
> 版面資料格式見 [layout-data-model.md](layout-data-model.md)；Storage key 格式見
> [storage.md](storage.md)；端點與權限見 [api.md](api.md)。

---

## ORM 模型（`backend/database.py`）

```
User (id, username UNIQUE, display_name, hashed_password, role,
      ui_font_scale, auth_version, created_at)
  ├─ owned_projects → Project.owner_id
  ├─ created_projects → Project.created_by_id
  └─ comments       → ProjectComment.author_id

TemplatePeriod (id, department, name, status, created_at)   — 期別；狀態掛在期別上
  └─ templates → Template.period_id

Semester (id, label, status, starts_on, ends_on, actor/time snapshots)
  ├─ periods → SemesterPeriod(template_period_id UNIQUE, name/department/position snapshots)
  └─ classrooms → Classroom[]     — 班級本體，不跨學期；見下方

Template (id, name, period_id FK→TemplatePeriod, revision, created_at)
  └─ pages → TemplatePage[]（cascade delete-orphan，order_by page_number）

TemplatePage (id, template_id FK, page_number, background_filename, layout_json TEXT)
  └─ UNIQUE(template_id, page_number)

Campus (id, name UNIQUE, is_active, created_at, updated_at)
  ├─ classrooms → Classroom[]
  └─ supervisor_assignments → OrganizationSupervisorAssignment[]

OrganizationSupervisorAssignment (campus_id, department nullable, supervisor_id nullable, supervisor_name_snapshot, started_at/ended_at, end_reason, actor snapshots)

Classroom (id, semester_id FK→Semester, campus_id FK→Campus, department, name,
           sort_order nullable〔顯示順序〕)
  ├─ UNIQUE(semester_id, campus_id, department, name)  ← 班級身分＝學期×分校×部門×班名
  ├─ is_current（property）：所屬學期是 imported/active；班級沒有自己的啟用旗標
  ├─ roster_members → ClassroomMember[]
  ├─ teacher_assignments → ClassroomTeacher[]
  ├─ work_slots → ClassPeriodWorkSlot(classroom_id, semester_period_id, started_at)
  └─ projects → Project.classroom_id

ClassroomMember (id, classroom_id FK→Classroom,
                   roster_child_id FK→Student,
                   started_at, ended_at, end_reason)
  └─ ended_at IS NULL 的同一 Student 全園只能有一筆

ClassroomTeacher (classroom_id, teacher_id nullable, teacher_name_snapshot, duty, started_at/ended_at, end_reason, actor snapshots)

Project (id, name, template_id FK, department, template_period_id FK,
         template_revision,                   ← 已同步的 live template 版本
         classroom_id FK→Classroom nullable,  ← NULL=待管理員遷移，僅 admin 可讀
         class_period_work_slot_id FK→ClassPeriodWorkSlot nullable,
         campus_id_snapshot, campus_name_snapshot, classroom_name_snapshot,
         owner_id FK→User,                    ← 進度負責人，不授予相本權限
         created_by_id FK→User nullable, created_by_name nullable,
         created_at, updated_at,
         deleted_at, archive_expires_at,      ← 軟刪除：封存 30 天後到期
         completed_at,                        ← 全班完成：非 NULL 內容鎖定（主管/admin 可退回）
         label_texts_json TEXT)
  ├─ students → ProjectStudent[]（cascade delete-orphan，order_by order_index）
  ├─ assignment_history → ProjectAssignmentHistory[]
  ├─ editor_assignments → ProjectEditorAssignment[]〔歷史稽核，runtime 不授權〕
  └─ comments → ProjectComment[]（cascade delete-orphan）

ProjectStudent (id, project_id FK, name, album_name nullable, order_index, pages_data_json TEXT,
         output_filename, roster_child_id FK→Student nullable,
         created_at, updated_at)
  └─ pages_data_json 內含 photos / label_texts / skip（skip=true 渲染略過該頁）

Student (id, name〔正規化後、不設 UNIQUE〕, album_name nullable,
         student_serial nullable〔行政系統學號〕, created_at)
  — 園所層級孩子名冊與已歸班相本的唯一稱呼來源
  ├─ students → ProjectStudent.roster_child_id
  └─ classroom_members → ClassroomMember.roster_child_id

ProjectAssignmentHistory (id, project_id FK→Project,
         from_owner_id/to_owner_id/changed_by_id FK→User nullable,
         from_owner_name/to_owner_name/changed_by_name 快照,
         reason, changed_at)

ProjectEditorAssignment (project_id, user_id nullable, user_name_snapshot, started_at/ended_at, end_reason, actor snapshots)

TermReclassificationPlan (label, status, revision, source_fingerprint,
                          target_semester_id, actor/time snapshots)
  ├─ student_placements → TermStudentPlacement[]（來源快照 + classroom/departed 目標） └─ classroom_plans → TermClassroomPlan[] → TermClassroomTeacherTarget[]

ProjectComment (id, project_id FK, author_id FK, content, created_at)

TemplateProjectSyncBackup (id, sync_id, template_id, project_id nullable,
         old_revision, old_pages_json, new_page_ids_json,
         project_completed_at, project_label_texts_json, students_json, created_at)
```

`legacy_teacher_supervisor_links` 是 terminal migration 建立的 raw SQL 稽核封存，不屬於
`Base.metadata` 或正式 ORM。欄位為 `teacher_id`、`supervisor_id`、雙方顯示名稱快照與
`archived_at`，同一 id pair 唯一且完全不設 FK；刪除／改名 User 都不改寫封存。

舊相本 identity migration 使用兩張不進正式 ORM 的 append-only raw SQL ledger：

- `legacy_project_classroom_migrations`：每個舊 Project 一筆，保存 Project／目標校班／部門
  快照、preview `source_fingerprint`、ProjectStudent／seed 數量、操作者與套用時間；operational id
  都是無 FK 的 snapshot。
- `legacy_student_identity_resolutions`：每位 ProjectStudent 一筆，透過 `migration_id` 以
  `ON DELETE RESTRICT` FK 連到上述 header，保存 Project／ProjectStudent／原 provisional child
  快照、`create_new | existing` action、resolved child、是否 seed、membership、fingerprint、
  操作者與時間；其餘 operational id 不設 FK。

兩張表的 update／delete 都由 trigger 阻擋；只供稽核與 Project NULL→class-backed transition
trigger 驗證，不參與日常 ACL、名冊或匯出查詢。

`legacy_project_identity_quarantines` 也是不進正式 ORM、完全不設 FK 的 append-only raw SQL
稽核表。同一 Project 最多一筆，保存隔離前的 Project／校／班／封存狀態與 ProjectStudent 總數、
NULL link、失效 link、同 Project 重複 child link 及不重複異常 ProjectStudent 數。startup migration
會掃描所有 class-backed Project（包含已封存者）；只要有上述異常，就保留 ProjectStudent link、
Project 校班名稱快照及封存欄位，只把 `classroom_id` 清為 NULL，回到 admin-only 明確歸班
佇列。這避免封存相本日後還原時帶著未解析身分重新取得班級 ACL；重跑不新增第二筆稽核。

- SQLite 連線啟用 `PRAGMA foreign_keys=ON`；`check_same_thread=False`
- 不設 `text_factory`，SQLAlchemy 以 UTF-8 存取；若用 raw sqlite3 讀取需自行處理 encoding
- 角色定義與權限見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)
- `User.role=teacher|supervisor` 只表示可參與園所編制的操作帳號族群；實際任教與主管能力
  分別由兩種 active assignment 推導，同一 User 可同時擁有兩者而不改 role。

## 孩子名冊（Student）：園所設定是唯一 authority

`Student.id` 是跨班級、跨期辨識同一個孩子的穩定身分，供目前名單、相本快照與學期
彙整共同引用。正常 runtime 不以姓名猜身分，也不提供 ProjectStudent↔Student link、孩子
split 或 merge 入口；此 invariant 由 `tests/test_organization.py` 與 `tests/test_roster.py` 釘住。

- 在園所設定把新入園學生加入班級目前名單時，每位學生建立新的 `Student` 與第一段
  `ClassroomMember`；`name` 不設 UNIQUE，因此同名孩子仍是不同 id。
- 改完整姓名或相本稱呼會更新 `Student.name`／`Student.album_name`；轉班、
  回班與新學期重新編班沿用原 `Student.id`，只結束／建立 `ClassroomMember` 區間，
  不另建孩子身分。
- 從目前名單建立相本時，`ProjectStudent.roster_child_id` 沿用該穩定 id，`ProjectStudent.name` 保存
  建立當下姓名快照；`ProjectStudent.album_name` 固定為 `NULL`，相本稱呼動態讀取
  `Student.album_name`。園所修改稱呼會套用同一孩子所有既有與未來的已歸班相本。
- fresh legacy schema 首次加入 `project_students.roster_child_id` 時保持 `NULL`；不得依姓名建立或
  共用 identity。已跑過舊姓名推定 migration 的非 NULL link，在 Project 未歸班期間仍只是
  provisional evidence，不能當 established identity、候選預設值或報表分組依據。
- established identity 必須已有任一 `ClassroomMember`，或已被 class-backed Project
  ProjectStudent 使用。未歸班 ProjectStudent 只能在 admin 歸班 transaction 以完整 explicit decision
  連到 established id，或建立全新 id；`create_new` 不得沿用／promote provisional id。
- Project 一旦 class-backed，trigger 會凍結 ProjectStudent `project_id`、`name`、
  `roster_child_id`。正常 API 沒有通用 ProjectStudent link、Student merge 或 split 入口；
  完整 transition 契約見[園所名單與相本權限規格的 Migration](../specs/organization-roster-management-v1.md#migration)。

## 班級名單、組織權限、每期快照與相本遷移

- `ClassroomMember` 表示班級名單的一段在班區間。`ended_at = NULL` 才屬於目前名單；
  離園寫入 `departed`，轉班在原班結束 `transfer` 區間並於目標班建立新區間。
  回班也以同一 `Student.id` 建立新 row，不覆寫舊區間。
- 同一 `Student` 全園同時只能有一筆 active membership；同一學期內的分校、部門與
  班級名稱不可重複（跨學期可以重複，同名班每年是不同的班）。班級的 `department` 沿用
  模板部門代碼 `infant` / `academy`，且與分校一樣是班級身分的一部分，建立後不可變更。
- 新入園由班級目前名單新增流程建立全新的 `Student`；從班級建立新一期 Project 時，
  只複製當下 active members 成為 `ProjectStudent` 快照並沿用
  `roster_child_id`。未明確提供稱呼的新入園名單會在建立 `Student` 時保守推導一次；
  之後修改稱呼不改寫 Project/ProjectStudent 快照，但所有已歸班相本會動態取得新值。
- `ProjectStudent` 集合與 `ProjectStudent.name` 在 Project runtime 不可新增、複製、刪除或改名；完整姓名
  只由建立當下的班級目前名單快照決定。跨期重新編班只改目前名單區間，下一期建立新相本
  時才形成新的學生快照。
- 學期名單沒有另一層快照：班級只活一個學期，`ClassroomMember` 就是那個學期的紀錄。
  學期 `closed` 之後，名冊與老師編制的 insert/update/delete 皆由 trigger 阻擋，API 也
  拒絕對已結束學期的班加人。這些限制不改寫既有 Project/ProjectStudent。
- 老師編制也是不可覆寫的區間：非空集合恰有一位 `lead`，可有多位 `co_teacher`；候選帳號
  可為 `role=teacher|supervisor`。所有目前老師不論 base role 都直接取得該班全部相本讀寫權；
  新增／移除編制會立即改變權限但不改 Project。
  建立相本時 owner 必須是目前老師；不再建立 `ProjectEditorAssignment`。
- `OrganizationSupervisorAssignment.department=NULL` 代表全校主管，否則只涵蓋同校該部門；
  候選帳號可為 `role=teacher|supervisor`，相本讀取／退回、目前班級與老師進度全部由此區間
  推導，不要求改成 supervisor role。
- `legacy_teacher_supervisor_links` 只供稽核。它的筆數可由園所遷移狀態查看，但任何 row
  都不會建立校／部門 scope、班級編制或相本 ACL。
- `Project.created_by_id` / `created_by_name` 記錄實際建立者且不隨 owner 轉交改變；
  `owner_id` 只作進度歸戶。每次轉交另寫 `ProjectAssignmentHistory`，三種姓名快照讓帳號
  日後改名或刪除後仍可稽核。
- 新學期編班草稿完整保存每位目前學生與每班老師的目標狀態；套用前以
  `source_fingerprint` 與 revision 防止覆蓋並行異動，成功時在同一 transaction 結束舊區間、
  建立新區間、學期班級／學生／老師快照及完整工作格。正式學期與報表 invariants 見
  [正式學期、工作格與報表規格](../specs/academic-term-reporting-v1.md)，園所名單 transition 見
  [園所名單與相本權限規格](../specs/organization-roster-management-v1.md)。
- `ClassPeriodWorkSlot` 是「正式學期 × 班級 × 期別」的唯一開工單位；新 Project 必須由目前
  `imported|active` 學期尚未開始的工作格建立，並在同一 transaction 寫入學生名冊快照、
  Project 組織快照與 `started_at`。封存不清空 `started_at`，因此同一格不能重建第二本。
- Project ACL 由學期班級的老師指派推導：該班有任何一筆指派即可讀，`ended_at IS NULL`
  才可編輯。因為班不跨學期，接手同名班的老師不會取得上一屆的相本。
- migration 只為已有 `classroom_id` 的 Project 一次補齊名稱快照，不從 owner、名稱或舊主管
  關係猜班級／scope；NULL 者保持 admin-only，管理員逐本選班寫快照後才啟用班級權限。active
  editor rows 以 `classroom_scope_migration` 結束，歷史 row 不刪除且 runtime 永不讀取。
- legacy Project 的 NULL→class-backed transition 必須先有與全部 ProjectStudent 相符的 resolution
  ledger rows；trigger 阻止繞過。歸班 apply 將 ledger、resolved links、可選的全量目前名單與
  Project 組織快照放在同一 transaction，`seed_current_roster` 不支援 subset。沒有任何
  ProjectStudent 快照的空 legacy Project 不可歸班；管理員須封存後從班級目前名單重新建立相本。

## 班級的顯示順序

- `Classroom.sort_order` 是園所自己決定的排列順序，**推導不出來**：班名是「一二階／三階／
  十階」這種中文數字，字面排序會排成 `一二階 七階 三階 九階 五階…`，與階段順序無關。
- 可為 `NULL`（既有資料），排序時退回 `id`：`ORDER BY sort_order IS NULL, sort_order, id`。
- 重排走 `PUT /organization/semesters/{id}/classroom-order`，**必須送出該學期完整的班級集合**
  ——只送一部分的話，沒送到的班要排哪裡沒有答案。已結束或已取消的學期不可重排。
- 順序在**同一分校內**才有意義：班級的分校不可變更，編班看板也只允許同校內調整。

## 名冊與行政系統的對帳鍵

- `Student.student_serial` 是行政系統學號，**與行政系統對帳的唯一鍵**。姓名不能當鍵：
  2026-08 就更正過 31 筆打錯的姓名與 28 筆跟著錯的稱呼，而學號在行政系統內唯一且不變。
- 可為 `NULL`——已離園、或從未在行政系統登記過的孩子沒有學號。唯一性因此是
  partial index `ux_students_student_serial ... WHERE student_serial IS NOT NULL`：
  NULL 可以有很多個，同一個學號只能屬於一個孩子。契約由
  `tests/test_organization_schema_migrations.py::test_student_serial_is_unique_only_where_present` 釘住。
- **手動編入名冊時就要帶學號**：`POST /classrooms/{id}/members/batch` 收 `student_serial`，
  兩個入口（編班看板的「＋新生」、園所管理的批次新增）都是一行一位的「姓名 學號」。
  事後才補的話，這批孩子在名冊同步裡對不到上游，還會被誤判成新生而重複建檔——
  2026-08-04 的正式資料演練實測 44 位、漂移 88 筆。理由與實測見
  [websystem-roster-sync-v1](../specs/websystem-roster-sync-v1.md#手動編入的孩子一定要帶學號2026-08-04-演練發現並修掉)。
- 學號一律以 `normalize_student_serial` 去空白轉大寫後存放：大小寫或多一個空格都會讓
  同一個孩子對不上。正式資料裡 1995 筆學號全是大寫無空白的 `AA#######`。
- 回填由 `scripts/backfill_student_serials.py --mapping <對照表> --db <資料庫>` 執行；學號值不同時
  **不覆寫**，列出來讓人決定——學號變了代表行政系統換了身分，不是腳本該自己決定的事。
  編班後若還有沒學號的孩子，用 `scripts/backfill_new_student_serials.py` 對回上游補。
- 身分證字號**不進本系統**。它與學號在行政系統內嚴格一對一，對帳能力完全相同，但把
  可辨識個人的政府識別號放進會被複製與備份的相本資料庫，是沒有換到任何東西的風險。
  需要更強的核對時，在一次性腳本裡直接讀行政系統的身分證交叉驗證即可。

## 相本稱呼與姓名變數

- `Student.album_name` 是已歸班相本的唯一稱呼來源；空白或 `null` 代表未指定，並由每本
  `ProjectStudent.name` 完整姓名快照回退。它跟隨同一 `Student.id` 跨轉班、回班與新學期沿用。
  管理員在園所設定修改後，同一孩子所有既有與未來已歸班 Project 立即解析為新值；實際變更
  會把相關 `output_filename` 清空並更新時間，避免下載舊輸出。契約由
  `tests/test_student_album_name.py` 與 `tests/test_render_revision_guard.py` 釘住。
- `ProjectStudent.name` 是建立相本時固定的完整姓名快照，用於名冊身份、照片檔名配對、管理搜尋、
  下載檔名與未設定稱呼時的回退值。
- `ProjectStudent.album_name` 只供 `Project.classroom_id IS NULL` 的舊相本相容；即使未歸班 ProjectStudent
  帶有 provisional `roster_child_id`，仍不得讀取名冊稱呼。Project 成功歸班後改讀
  `Student.album_name`，相本內三個舊稱呼 mutation 端點回 409
  `roster_album_name_authority`，避免第二份 authority。
- 新入園名單未明確提供稱呼時，`student_album_name_policy.py` 在建立 `Student` 時只替
  一般二至三字純漢字姓名移除首字；已知複姓、單字、四字以上、混合字元或與同班 effective
  名稱碰撞者保持 `NULL`。園所設定另提供目前名單整批與單一孩子自動填入，只處理空白中央值、
  不覆蓋人工值，並把所有目前班級與已歸班 Project 當成碰撞 scope 反覆撤回衝突候選；安全規則
  由 `tests/test_student_album_name.py` 釘住。舊相本歸班建立新孩子身分時也套用同一保守規則。
- schema migration 只從已歸班且正式連結的 ProjectStudent 升格一致的非空舊稱呼，完全排除未歸班
  provisional link；同一孩子有多個不同舊值時拒絕啟動並要求人工處理。升格後清除已歸班
  `ProjectStudent.album_name`，讓該欄只剩 legacy 語意。切換會以 `schema_migration_markers` 留下永久
  marker，只執行一次；所有實際渲染字串有變的舊輸出都先失效，後續重啟不會再次清除新輸出。
- 模板／專案／學生文字中的 `{name}` 代入 effective 相本稱呼，`{full_name}` 一律代入
  完整姓名。兩個 token 都在三層文字合併後、排版前解析；渲染與快取契約見
  [rendering.md](rendering.md#相冊輸出與-dirty-skip)。
- 現有姓名不在 startup migration 自動拆姓。已歸班孩子由管理員在園所設定明確執行中央
  自動填入；未歸班 legacy Project 的候選產生與人工審核套用流程見
  [testing.md 的資料修復腳本 runbook](testing.md#資料修復腳本-runbook)。

## 對應文字（label_texts）三層覆蓋

完整契約已移至[版面資料模型的 label_texts 三層覆蓋](layout-data-model.md#對應文字label_texts三層覆蓋)。

## Live template revision 與頁面結構同步

完整契約已移至[版面資料模型的 live template revision](layout-data-model.md#live-template-revision-與頁面結構同步)。

## layout_json 格式

完整契約已移至[版面資料模型的 layout_json 格式](layout-data-model.md#layout_json-格式)。

## Migrations 規則（`backend/migrations.py`）

- `run_migrations()` 在後端**每次啟動**時執行；每個子函式必須**冪等**
  （先以 `PRAGMA table_info` / `sqlite_master` 檢查存在再操作）
- 新遷移加在 `run_migrations()` 執行序列**尾端**，不改既有遷移
- 歷史欄位的 add→rename→drop 鏈必須以「替代欄位已存在」作為終態標記；終態成立後
  不得在後續啟動重新建立舊欄位，避免 drop-table 流程用舊 schema 重建資料表
- 舊逐人主管 terminal migration 以 `legacy_teacher_supervisor_links` 作終態標記：先合併
  `users.supervisor_id` 與 `teacher_supervisors`、帶雙方顯示名稱快照封存並驗證，再移除舊表與
  欄位；早期建立／回填函式看到標記後必須跳過，重跑不得復活舊 schema
- legacy ProjectStudent identity migration 不以姓名 backfill：fresh legacy rows 保持 NULL；已存在的
  姓名推定 link 不在 startup 拆分或沿用，而是在管理員歸班時把 original／resolved 值寫進
  `legacy_project_classroom_migrations`／`legacy_student_identity_resolutions`。未歸班資料在此
  之前持續隔離於 admin-only scope
- **SQLite ADD COLUMN 不支援非常數預設值**（如 `CURRENT_TIMESTAMP`）：
  先加無預設欄位，再 `UPDATE ... SET col = CURRENT_TIMESTAMP WHERE col IS NULL` 回填
- **SQLite 舊版不支援 DROP COLUMN**：fallback 用原始 `CREATE TABLE` 動態重建，
  並重建既有 index／trigger、驗證 foreign keys；禁止硬編碼舊欄位清單
  （範例見 `_drop_bubble_texts_json_column`；這是舊專案文字欄位的歷史遷移，
  與已移除的 layout 氣泡框無關）
- 大型資料遷移（如 content-box）先寫備份表
  （`template_page_layout_migration_backups`）再改寫
- 首次啟動自動建立 admin 帳號，隨機初始密碼印在啟動日誌
