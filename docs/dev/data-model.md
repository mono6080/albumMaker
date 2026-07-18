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

AcademicTerm (id, label, status, starts_on, ends_on, actor/time snapshots)
  ├─ periods → AcademicTermPeriod(template_period_id UNIQUE, name/department/position snapshots)
  └─ classrooms → AcademicTermClassroom(classroom_id, campus/classroom/department snapshots)
       ├─ teachers → AcademicTermClassroomTeacher(teacher/姓名/duty snapshots)
       ├─ students → AcademicTermClassroomStudent(academic_term_id,
       │              source_membership_id nullable, roster_child_id/姓名 snapshots)
       └─ work_slots → ClassPeriodWorkSlot(term_period_id, started_at)

Template (id, name, period_id FK→TemplatePeriod, revision, created_at)
  └─ pages → TemplatePage[]（cascade delete-orphan，order_by page_number）

TemplatePage (id, template_id FK, page_number, background_filename, layout_json TEXT)
  └─ UNIQUE(template_id, page_number)

Campus (id, name UNIQUE, is_active, created_at, updated_at)
  ├─ classrooms → Classroom[]
  └─ supervisor_assignments → OrganizationSupervisorAssignment[]

OrganizationSupervisorAssignment (campus_id, department nullable, supervisor_id nullable, supervisor_name_snapshot, started_at/ended_at, end_reason, actor snapshots)

Classroom (id, campus_id FK→Campus, department, name, is_active,
           created_at, updated_at)
  ├─ roster_members → ClassRosterMember[]
  ├─ teacher_assignments → ClassroomTeacherAssignment[]
  └─ projects → Project.classroom_id

ClassRosterMember (id, classroom_id FK→Classroom,
                   roster_child_id FK→RosterChild,
                   started_at, ended_at, end_reason)
  └─ ended_at IS NULL 的同一 RosterChild 全園只能有一筆

ClassroomTeacherAssignment (classroom_id, teacher_id nullable, teacher_name_snapshot, duty, started_at/ended_at, end_reason, actor snapshots)

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
  ├─ students → Student[]（cascade delete-orphan，order_by order_index）
  ├─ assignment_history → ProjectAssignmentHistory[]
  ├─ editor_assignments → ProjectEditorAssignment[]〔歷史稽核，runtime 不授權〕
  └─ comments → ProjectComment[]（cascade delete-orphan）

Student (id, project_id FK, name, album_name nullable, order_index, pages_data_json TEXT,
         output_filename, roster_child_id FK→RosterChild nullable,
         created_at, updated_at)
  └─ pages_data_json 內含 photos / label_texts / skip（skip=true 渲染略過該頁）

RosterChild (id, name〔正規化後、不設 UNIQUE〕, created_at)   — 園所層級孩子名冊
  ├─ students → Student.roster_child_id
  └─ class_roster_members → ClassRosterMember.roster_child_id

ProjectAssignmentHistory (id, project_id FK→Project,
         from_owner_id/to_owner_id/changed_by_id FK→User nullable,
         from_owner_name/to_owner_name/changed_by_name 快照,
         reason, changed_at)

ProjectEditorAssignment (project_id, user_id nullable, user_name_snapshot, started_at/ended_at, end_reason, actor snapshots)

TermReclassificationPlan (label, status, revision, source_fingerprint,
                          target_academic_term_id, actor/time snapshots)
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
  快照、preview `source_fingerprint`、Student／seed 數量、操作者與套用時間；operational id
  都是無 FK 的 snapshot。
- `legacy_student_identity_resolutions`：每位 Student 一筆，透過 `migration_id` 以
  `ON DELETE RESTRICT` FK 連到上述 header，保存 Project／Student／原 provisional child
  快照、`create_new | existing` action、resolved child、是否 seed、membership、fingerprint、
  操作者與時間；其餘 operational id 不設 FK。

兩張表的 update／delete 都由 trigger 阻擋；只供稽核與 Project NULL→class-backed transition
trigger 驗證，不參與日常 ACL、名冊或匯出查詢。

`legacy_project_identity_quarantines` 也是不進正式 ORM、完全不設 FK 的 append-only raw SQL
稽核表。同一 Project 最多一筆，保存隔離前的 Project／校／班／封存狀態與 Student 總數、
NULL link、失效 link、同 Project 重複 child link 及不重複異常 Student 數。startup migration
會掃描所有 class-backed Project（包含已封存者）；只要有上述異常，就保留 Student link、
Project 校班名稱快照及封存欄位，只把 `classroom_id` 清為 NULL，回到 admin-only 明確歸班
佇列。這避免封存相本日後還原時帶著未解析身分重新取得班級 ACL；重跑不新增第二筆稽核。

- SQLite 連線啟用 `PRAGMA foreign_keys=ON`；`check_same_thread=False`
- 不設 `text_factory`，SQLAlchemy 以 UTF-8 存取；若用 raw sqlite3 讀取需自行處理 encoding
- 角色定義與權限見 [api.md 的角色權限矩陣](api.md#角色權限矩陣)
- `User.role=teacher|supervisor` 只表示可參與園所編制的操作帳號族群；實際任教與主管能力
  分別由兩種 active assignment 推導，同一 User 可同時擁有兩者而不改 role。

## 孩子名冊（RosterChild）：園所設定是唯一 authority

`RosterChild.id` 是跨班級、跨期辨識同一個孩子的穩定身分，供目前名單、相本快照與學期
彙整共同引用。正常 runtime 不以姓名猜身分，也不提供 Student↔RosterChild link、孩子
split 或 merge 入口；此 invariant 由 `tests/test_organization.py` 與 `tests/test_roster.py` 釘住。

- 在園所設定把新入園學生加入班級目前名單時，每位學生建立新的 `RosterChild` 與第一段
  `ClassRosterMember`；`name` 不設 UNIQUE，因此同名孩子仍是不同 id。
- 改完整姓名會更新目前名冊的 `RosterChild.name`；轉班、回班與新學期重新編班沿用原
  `RosterChild.id`，只結束／建立 `ClassRosterMember` 區間，不另建孩子身分。
- 從目前名單建立相本時，`Student.roster_child_id` 沿用該穩定 id，`Student.name` 則保存
  建立當下姓名快照；兩者在 Project runtime 都不可修改。
- fresh legacy schema 首次加入 `students.roster_child_id` 時保持 `NULL`；不得依姓名建立或
  共用 identity。已跑過舊姓名推定 migration 的非 NULL link，在 Project 未歸班期間仍只是
  provisional evidence，不能當 established identity、候選預設值或報表分組依據。
- established identity 必須已有任一 `ClassRosterMember`，或已被 class-backed Project
  Student 使用。未歸班 Student 只能在 admin 歸班 transaction 以完整 explicit decision
  連到 established id，或建立全新 id；`create_new` 不得沿用／promote provisional id。
- Project 一旦 class-backed，trigger 會凍結 Student `project_id`、`name`、
  `roster_child_id`。正常 API 沒有通用 Student link、RosterChild merge 或 split 入口；
  完整 transition 契約見[園所名單與相本權限規格的 Migration](../specs/organization-roster-management-v1.md#migration)。

## 班級名單、組織權限、每期快照與相本遷移

- `ClassRosterMember` 表示班級名單的一段在班區間。`ended_at = NULL` 才屬於目前名單；
  離園寫入 `departed`，轉班在原班結束 `transfer` 區間並於目標班建立新區間。
  回班也以同一 `RosterChild.id` 建立新 row，不覆寫舊區間。
- 同一 `RosterChild` 全園同時只能有一筆 active membership；同分校、部門與班級名稱
  不可重複。班級的 `department` 沿用模板部門代碼 `infant` / `academy`。
- 新入園由班級目前名單新增流程建立全新的 `RosterChild`；從班級建立新一期 Project 時，
  只複製當下 active members 成為 `Student` 快照並沿用
  `roster_child_id`；相本稱呼在這次建立時推導。之後新增、離園、轉班或名冊改名都不
  自動增刪或改寫既有 Project/Student。
- `Student` 集合與 `Student.name` 在 Project runtime 不可新增、複製、刪除或改名；完整姓名
  只由建立當下的班級目前名單快照決定。跨期重新編班只改目前名單區間，下一期建立新相本
  時才形成新的學生快照。
- `AcademicTermClassroomStudent` 是學期最終名單；冗餘 `academic_term_id`
  由 trigger 保證與 term classroom 同期，unique index 保證同孩子每學期只落一班。
  `imported|active` 中新增／回班會加入、改名會更新、轉班會移班，離園保留最後班；
  `closed` 後 insert/update/delete 皆由 trigger 阻擋。這些變動不改寫既有 Project/Student。
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
- 學期班級、學生與老師 row 只供報表快照；Project ACL 永遠由目前有效老師／主管區間推導。
- migration 只為已有 `classroom_id` 的 Project 一次補齊名稱快照，不從 owner、名稱或舊主管
  關係猜班級／scope；NULL 者保持 admin-only，管理員逐本選班寫快照後才啟用班級權限。active
  editor rows 以 `classroom_scope_migration` 結束，歷史 row 不刪除且 runtime 永不讀取。
- legacy Project 的 NULL→class-backed transition 必須先有與全部 Student 相符的 resolution
  ledger rows；trigger 阻止繞過。歸班 apply 將 ledger、resolved links、可選的全量目前名單與
  Project 組織快照放在同一 transaction，`seed_current_roster` 不支援 subset。沒有任何
  Student 快照的空 legacy Project 不可歸班；管理員須封存後從班級目前名單重新建立相本。

## 相本稱呼與姓名變數

- `Student.name` 是建立相本時固定的完整姓名快照，用於名冊身份、照片檔名配對、管理搜尋與下載檔名。
- `Student.album_name` 是可選的相本稱呼；`NULL` 時
  `Student.effective_album_name` 回退完整姓名。空白輸入或 JSON `null` 正規化為 `NULL`；
  這是 Project runtime 唯一可修改的學生 identity 顯示欄位，不改完整姓名或名冊連結。
- 從班級目前名單建立 Project 快照時，`student_album_name_policy.py` 只替一般二至三字純漢字姓名移除首字；
  已知複姓、單字、四字以上或混合字元不自動設定。候選若撞到同專案既有學生或同批
  其他學生的 effective 相本稱呼，碰撞候選會一起撤回並重算，直到不再碰撞；撤回者保持
  `NULL`；規則由 `tests/test_student_album_name.py` 釘住。
- 既有學生可手動觸發同一套批次推導：目標包含所有空白 `album_name` 的學生，
  已有非空白稱呼則作為 protected effective 名稱，不參與更新也絕不覆寫。
  所有目標一起經過 fixed-point 碰撞重算；實際補上稱呼者在單一 transaction
  失效舊輸出，無法安全推導者維持原狀。
- 單筆推導只把指定且空白 `album_name` 的學生當目標；同專案其他所有學生都作為
  protected effective 名稱，其中空白或舊資料純空白稱呼以完整姓名回退。這可避免
  單筆候選撞到另一位尚未設定稱呼學生的完整姓名；已設定的指定學生維持原值。
- 模板／專案／學生文字中的 `{name}` 代入 effective 相本稱呼，`{full_name}` 一律代入
  完整姓名。兩個 token 都在三層文字合併後、排版前解析；渲染與快取契約見
  [rendering.md](rendering.md#相冊輸出與-dirty-skip)。
- 現有姓名不在 startup migration 自動拆姓。既有資料的候選產生與人工審核套用流程見
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
- legacy Student identity migration 不以姓名 backfill：fresh legacy rows 保持 NULL；已存在的
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
