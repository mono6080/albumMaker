# 學期範圍班級 v1 Spec

## Verdict

Decision：班級的身分是「學期 × 分校 × 部門 × 班名」，不是跨學期的長期實體。兩層合而
為一：`classrooms` 表留下並補上 `semester_id` 成為班級本體，`academic_term_classrooms`
（及其兩張快照表）移除。

> 實作時改為保留 `classrooms` 而非保留 `academic_term_classrooms`：兩者本來就 1:1，
> 留住 `classrooms.id` 讓所有 `classroom_id` 外鍵原地不動，只有工作格需要換 id。
> 名稱也剛好對上「班級本體」的新語意。

理由是「班級跨學期延續」這個假設被實際編班資料推翻：115 上的 33 個來源班裡有 13 個被
拆散，用學生流向推不出去向，用老師留任推也有 8 個平手、4 個沒有留任。留著長期班級會
讓班名跨學期重複使用（九階A 每年換一批孩子），權限、報表與「我的班級」都得額外補一層
「相本學期 vs 編制區間有沒有重疊」才會正確——那層補丁只是在遮蓋 model 本身的錯誤。

Decision：名冊成員與老師編制改掛學期班級，區間欄位（`started_at`／`ended_at`）保留，
因為學期中途仍有入園、離園與轉班。`academic_term_classroom_students` 與
`academic_term_classroom_teachers` 兩張快照表隨之移除——班本身就只活一個學期，不需要
再快照一次自己。

Decision：老師的相本**讀取**權 =「曾被指派到的學期班級」，**製作**權 =「目前學期的指
派」。這讓 [organization-roster-management-v1](organization-roster-management-v1.md) 的
讀寫分離變成模型的自然結果，不需要任何學期區間比對。

## Problem

`classrooms` 是長期實體，`academic_term_classrooms` 只是它在某學期的快照。實務上兩者
的資料是 1:1（38 對 38，名稱、部門、分校完全一致），長期那一層沒有承載任何跨學期資
訊，卻造成三個具體問題：

- **班名重複使用**：`ux_classrooms_scope_name(campus_id, department, name)` 讓每學期只
  能沿用同名班級，於是「安平九階A」會逐年累積不同屆孩子的相本。
- **權限語意錯誤**：老師編制掛在長期班級上，接手該班的老師會取得上一屆相本的權限。
- **編班被迫做延續判斷**：新學期必須決定「哪個舊班變成哪個新班」，而這個對應關係在
  混齡銜接班上不存在。

## Scope

- 兩層班級合而為一：`classrooms` 補上 `semester_id` 成為班級本體，
  `academic_term_classrooms` 與其兩張快照表移除。引用班級的 `classroom_id` 外鍵
  因此不必改，只有工作格要換 id。
- 老師 scope、`my-classrooms`、相本 object policy 與學期彙整匯出的查詢改寫。
- 編班計畫由「舊班 → 新班的搬遷」改為「在新學期建立班級並放人」。
- 一次性資料 migration 與其前提驗證。

## Non-Goals

- 不動相本內容、`Student` 快照、輸出檔案或 Storage key。
- 不動 `RosterChild`、`Campus`、`User` 的身分模型；跨學期識別一律靠 `RosterChild.id`。
- 不在本階段加入行政系統學號（見 [Open Questions](#open-questions)）。
- 不改期別（`template_periods`／`academic_term_periods`）與工作格的語意。

## Domain Model

### AcademicTermClassroom（班級本體）

```
AcademicTerm（學期）
 ├─ AcademicTermPeriod（期別）
 └─ AcademicTermClassroom（班級本體：campus_id + department + name）
      ├─ ClassRosterMember           RosterChild × 區間
      ├─ ClassroomTeacherAssignment  User × duty × 區間
      └─ ClassPeriodWorkSlot         × AcademicTermPeriod
           └─ Project
```

跨學期存在的只有 `Campus`、`RosterChild`、`User` 三個實體；班級不跨學期。

`classrooms` 的欄位變動：

| 現在 | 之後 |
|------|------|
| （無）| `academic_term_id` FK `academic_terms.id` |
| `campus_id`／`department`／`name` | 不變 |
| `is_active` | 移除：班級沒有自己的啟用旗標，由所屬學期的狀態決定 |
| `created_at`／`updated_at` | 移除：時間資訊由學期承擔 |

唯一鍵由 `(campus_id, department, name)` 改為
`(academic_term_id, campus_id, department, name)`，同名班級因此可以逐年重建。分校改名
不再需要快照——同一個實體分校換名字時，歷史學期顯示新名是正確的；相本層另有自己的
`campus_name_snapshot` 凍結顯示。名冊姓名同理：更正錯字之後，已結束學期的彙整匯出也
跟著顯示新名，凍結的是相本本身（`Student.name` 與已渲染的輸出）。

`class_period_work_slots.term_classroom_id` 改名為 `classroom_id` 並改指 `classrooms.id`。

### ClassRosterMember／ClassroomTeacherAssignment

表名與 `classroom_id` 欄位都不改——`classrooms` 就是學期班級，原本的外鍵直接成立。
區間語意不變：`ended_at IS NULL` 代表目前在籍／在職，學期結束時由編班套用一次結束。

學期一旦 `closed`，該學期班級的名冊與編制就是歷史：`class_roster_members` 與
`classroom_teacher_assignments` 各有三個 trigger 擋下 INSERT／UPDATE／DELETE。這接手了
兩張學期快照表原本提供的不可變保證。

`ux_class_roster_active_child`（roster_child_id WHERE ended_at IS NULL）維持全園唯一——
一個孩子同一時間只能在一個班，跨學期由不同學期的班級 承接。

### Project

`projects.classroom_id` 保留——`classrooms` 本身就是學期班級，這個欄位不再有跨學期
歧義。報表與匯出仍以 `class_period_work_slot_id → classroom` 為準；現有 88 本相本已
全部掛有工作格，且與 `classroom_id` 推出的班 100% 一致。

`campus_id_snapshot`／`campus_name_snapshot`／`classroom_name_snapshot`／`department`
四個相本層快照欄位保留不動，主管 scope 仍以 `campus_id_snapshot` 判斷歷史相本。

## 權限契約

- **讀**：`Project → work_slot → classroom`，該學期班級 上使用者有任何一筆
  `ClassroomTeacherAssignment`（不論 `ended_at`）即可讀。
- **製作**（`can_edit`）：同一個學期班級 上有 `ended_at IS NULL` 的指派。
- **主管**：不變，仍走 `Project.campus_id_snapshot` × 部門的 scope key。
- `my-classrooms` 與建立相本的閘門：只看目前正式學期（`status IN ('imported','active')`）
  且 `ended_at IS NULL` 的指派。

因此 [organization-roster-management-v1](organization-roster-management-v1.md) 的
`teacher_past_classroom_ids` 可以退場：曾任教的學期班級 天然只包含老師在場那個
學期，不會誤放上一屆的相本。

## Migration

### 前提驗證（apply 前必須全為 0／相等，否則中止）

| 檢查 | 目前值 |
|------|--------|
| `classrooms` 沒有對應 term_classroom | 0 |
| term_classroom 的名稱／部門／分校快照與 classroom 現值不同 | 0 |
| 相本 `classroom_id` 與 work_slot 推出的班不一致 | 0 |
| 未封存相本沒有 work_slot | 0 |
| `classrooms` : `academic_term_classrooms` | 38 : 38 |

### 資料搬遷（單一 transaction）

1. `classrooms` 補上 `academic_term_id`，值由 `academic_term_classrooms` 的一對一對應
   而來；`classrooms.id` 原封保留，所有 `classroom_id` 外鍵因此不必改。
2. `class_period_work_slots` 整張重建：`term_classroom_id` → `classroom_id`，值由
   `academic_term_classrooms.id` 換成 `classrooms.id`，FK 目標一併換掉。
   - 換值必須用**一次 join**完成。兩張表的 id 值域重疊，逐筆 UPDATE 會把前一輪改好的
     列再改一次——不會報錯，只會靜默錯掛。
   - 欄位改名與 FK 換目標都不是 `RENAME COLUMN` 做得到的，所以是重建而非改名。
3. drop 兩張學期快照表與 `academic_term_classrooms`，連同引用它們的 trigger 與索引。
4. `classrooms` drop `is_active`／`created_at`／`updated_at`。
5. 既有編班草稿一律轉為 `cancelled`：source fingerprint 以舊結構算出，必然對不上。

搬遷後另有兩個獨立步驟（新舊資料庫共用，全新資料庫也要跑）：

- **索引**：組織相關索引集中成單一份無守衛清單。原本它們建在只跑得到舊結構的
  migration 裡，全新資料庫會因此少掉 `ux_class_roster_active_child` 等唯一鍵。
- **trigger**：`trg_projects_freeze_classroom_snapshots` 與 `trg_projects_freeze_work_slot`
  以 `class_period_work_slot_id` 重建，加上已結束學期的名冊／編制凍結。

`projects.classroom_id` 保留：`classrooms` 就是學期班級，這個欄位不再有跨學期歧義。

> 驗證方式：把正式資料副本跑過完整 migration，再與 `init_db()` 建出的全新資料庫逐項
> 比對表欄位、索引與 trigger。兩條路徑必須收斂到同一個結構。

### Trigger 調整

引用 `projects.classroom_id` 的六個 trigger 必須改寫或移除：

- `trg_projects_reject_empty_identity_migration`、
  `trg_projects_require_identity_migration_ledger`、
  `trg_projects_freeze_assigned_classroom`：舊相本歸班流程已完成（未封存相本全數歸班），
  三個 trigger 與歸班 API 一併退場；legacy ledger 表維持 append-only 只供稽核。
- `trg_projects_freeze_classroom_snapshots`、`trg_projects_freeze_work_slot`：改以
  `class_period_work_slot_id IS NOT NULL` 作為 class-backed 判斷。
- `trg_students_freeze_class_backed_identity`：已只依賴 `class_period_work_slot_id`，
  不需改動。

另有 57 本**已封存**的未歸班舊相本（`classroom_id`、`class_period_work_slot_id` 皆為
NULL，`archive_expires_at` 落在 2026-08-01～08-17，屆期由既有 purge 迴圈清除）。改用
`class_period_work_slot_id IS NOT NULL` 判斷後，它們仍然是 admin-only，行為不變；
migration 不特別處理，也不得因為它們而中止。

## Naming

Decision：與行政系統（未來 MDM）同概念的實體，命名要能一眼對上。本次一併改名：

| 現在 | 改成 | 對到行政系統 | 狀態 |
|------|------|--------------|------|
| `AcademicTermClassroom` | `Classroom`（舊 `classrooms` 留下並補上學期）| `school.Clas` | 已完成 |
| `ClassRosterMember` | `ClassroomMember` | `student.ClasLog` | 已完成 |
| `ClassroomTeacherAssignment` | `ClassroomTeacher` | `personnel.PostLog` | 已完成 |
| `AcademicTerm` | `Semester` | `school.Semester` | 已完成 |
| `AcademicTermPeriod` | `SemesterPeriod` | —（相冊獨有）| 已完成 |
| `Student` | `ProjectStudent`（本來就是「相本裡的一份」，不是學生）| —（相冊獨有）| 已完成 |
| `RosterChild` | `Student` | `student.Student` | 已完成 |

欄位名跟著表名走：`academic_term_id` → `semester_id`、`term_period_id` →
`semester_period_id`、`target_academic_term_id` → `target_semester_id`。索引名不會隨
`ALTER TABLE RENAME` 改變，所以舊名要另外 drop，否則升級後的資料庫會多出一組同義索引。

`User` 不改為 `Staff`：行政系統的 `Staff` 是員工（457 人，含非相冊使用者），相冊的
`User` 是登入帳號（69 個），本來就不是同一個集合。

表名跟著類別名改（`students` → `project_students`、`roster_children` → `students` 等）。

API 路徑只改語意真的變了的那一組：`/organization/roster-children/` → `/organization/students/`。
`/projects/{id}/students/` 保持——它已被 `projects/` 限定，本來就是「這本相本的學生」，
改成 `project-students` 只是把前綴講第二次。

`roster_child_id` 欄位名也保持：`student_id` 在 Storage key、輸出檔名與 API 路徑參數
已經穩定地指 `ProjectStudent.id`，讓它一詞兩義才是真的製造歧義。

### 表名改動的 migration 策略

`migrations.py` 裡的歷史 migration 直接寫死舊表名（僅 `students` 就有 82 處）。全新資料
庫由 `init_db()` 以新名建表，歷史 migration 會找不到舊表而失敗。

策略是**改名 migration 排在最前面**，其餘歷史 migration 一律改寫成新表名：

- 舊資料庫：先改名，後續歷史 migration 對著新表名跑，行為不變。
- 全新資料庫：改名是 no-op（舊表名不存在），歷史 migration 對著 `init_db()` 建好的新表
  跑，與今天完全相同。

改名順序必須是先 `students` → `project_students`，再 `roster_children` → `students`；
SQLite 的 `ALTER TABLE RENAME` 會連帶改寫其他表的 FK 與 trigger 內的參照，依序執行才會
落在正確的目標上。

逐一加「表存在才執行」守衛的做法明確不採用：18 個函式各有建表／改表的差異，守衛條件
不一致，比全面改寫表名更容易出錯。

## Implementation Slices

**結構改動不可分割**。原本規劃的九個 slice 在實作時證明是錯的：ORM 一動，scope、
權限、園所設定、編班、報表、匯出全部同時失效，中間沒有可以停下來的綠燈狀態。以下五
項屬於同一次改動，一起做、一起驗：

1. **schema／migration**：前提驗證、資料搬遷、trigger 與索引重建、drop 舊表；migration
   冪等，重跑為 0 筆。
2. **scope／權限**：`OrganizationReadScope` 改為持有 classroom id 集合；讀寫分離改走
   學期班級；`teacher_past_classroom_ids` 退場。
3. **園所設定／my-classrooms／編班**：班級在目前正式學期底下建立；編班計畫由「舊班搬到
   新班」改為「在目標學期建好班再放人」。
4. **報表／匯出**：老師進度與學期彙整匯出改走學期班級。
5. **前端**：班級的啟用語意改為 `is_current`、編班頁改用計畫自帶的目標班清單、舊相本
   歸班流程移除。

改名是**唯一**可以獨立切開的部分，因為它不改語意、只改識別字，且各組之間互不相依：

6. **改名 A**：`Classroom`／`ClassroomMember`／`ClassroomTeacher`（含表名與 API）。
7. **改名 B**：`Semester`／`SemesterPeriod`。
8. **改名 C**：`ProjectStudent`／`Student`，含 17 條 `/students/` API 路徑與前端。

改名有一個外部前提，見
[risks 的執行順序](term-scoped-classroom-v1-risks.md#執行順序的硬前提)。

## Risks And Test Plan

風險登錄、緩解決定、測試計畫與上線前檢查在
[term-scoped-classroom-v1-risks.md](term-scoped-classroom-v1-risks.md)。

其中一項是本重構的**執行順序前提**：`fix/roster-name-correction` 的兩支名冊腳本寫死
舊表名，必須先推上正式站跑完，再開始改名。

## Acceptance Smoke

- 老師調班後：舊學期相本可讀不可改、新學期相本可讀可改、`my-classrooms` 只列目前班。
- 同名班級跨兩個學期：各自只看得到自己那學期的相本。
- 學期中途接手的老師：讀得到該班本學期較早建立的相本。
- 主管 scope、art_team、admin 的能力矩陣與 migration 前完全一致。
- 88 本既有相本的班名／分校顯示、輸出檔案與下載結果不變。
- 完整 pytest 與前端 build 通過。

## Open Questions

- `roster_children.student_serial`（行政系統學號）要在本次一併加入，還是等結構穩定後
  獨立一刀？兩者互不相依，但同步腳本需要 serial 才能自動化。
- 編班計畫的 `source_fingerprint` 在班級改為每學期新建後要重新定義比對範圍。
- 班級改為學期範圍後，跨學期查詢「同一個班名的歷史」需不需要提供入口，或一律以
  孩子（`Student`，原 `RosterChild`）為軸。
