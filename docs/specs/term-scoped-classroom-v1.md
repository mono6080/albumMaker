# 學期範圍班級 v1 Spec

## Verdict

Decision：班級的身分是「學期 × 分校 × 部門 × 班名」，不是跨學期的長期實體。移除
`classrooms` 表，把 `academic_term_classrooms` 從快照層扶正為班級本體。

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

- `classrooms` 的移除，以及 `class_roster_members`、`classroom_teacher_assignments`、
  `projects`、`term_classroom_plans`、`term_student_placements` 的 FK 重新指向。
- `academic_term_classrooms` 由快照欄位改為本體欄位（`campus_id` FK、`name`、
  `department`）。
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

欄位由快照改為本體：

| 現在 | 之後 |
|------|------|
| `classroom_id` FK | 移除 |
| `campus_id_snapshot` | `campus_id`（FK `campuses.id`）|
| `campus_name_snapshot` | 移除，改由 `Campus` live 讀取 |
| `classroom_name_snapshot` | `name` |
| `department` | 不變 |

唯一鍵由 `(academic_term_id, classroom_id)` 改為
`(academic_term_id, campus_id, department, name)`。分校改名不再需要快照——同一個實體分校
換名字時，歷史學期顯示新名是正確的；相本層另有自己的 `campus_name_snapshot` 凍結顯示。

### ClassRosterMember／ClassroomTeacherAssignment

表名不改（避免無謂的改名風險），只把 `classroom_id` 改成 `term_classroom_id`。區間語意
不變：`ended_at IS NULL` 代表目前在籍／在職，學期結束時由編班套用一次結束。

`ux_class_roster_active_child`（roster_child_id WHERE ended_at IS NULL）維持全園唯一——
一個孩子同一時間只能在一個班，跨學期由不同的 term_classroom 承接。

### Project

`projects.classroom_id` 移除。班級一律由 `class_period_work_slot_id → term_classroom` 推
導；現有 88 本相本已全部掛有工作格，且與 `classroom_id` 推出的班 100% 一致。

`campus_id_snapshot`／`campus_name_snapshot`／`classroom_name_snapshot`／`department`
四個相本層快照欄位保留不動，主管 scope 仍以 `campus_id_snapshot` 判斷歷史相本。

## 權限契約

- **讀**：`Project → work_slot → term_classroom`，該 term_classroom 上使用者有任何一筆
  `ClassroomTeacherAssignment`（不論 `ended_at`）即可讀。
- **製作**（`can_edit`）：同一 term_classroom 上有 `ended_at IS NULL` 的指派。
- **主管**：不變，仍走 `Project.campus_id_snapshot` × 部門的 scope key。
- `my-classrooms` 與建立相本的閘門：只看目前正式學期（`status IN ('imported','active')`）
  且 `ended_at IS NULL` 的指派。

因此 [organization-roster-management-v1](organization-roster-management-v1.md) 的
`teacher_past_classroom_ids` 可以退場：曾任教的 term_classroom 天然只包含老師在場那個
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

1. `academic_term_classrooms` 補上 `campus_id`／`name`（由快照欄位改名而來，值不變）。
2. `class_roster_members.term_classroom_id` ← 由 `classroom_id` 對應到目前正式學期的
   term_classroom（466 筆）。
3. `classroom_teacher_assignments.term_classroom_id` ← 同上（52 筆）。
4. `term_classroom_plans.term_classroom_id`、`term_student_placements` 的來源／目標欄位
   同步改指 term_classroom。
5. 驗證 `academic_term_classroom_students`（466）與 `_teachers`（52）與 live 表逐筆等
   價，通過後 drop 兩張表與其 trigger。
6. drop `projects.classroom_id`、`classrooms` 與相關 trigger／索引。

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

## Implementation Slices

1. **schema／migration**：前提驗證、欄位搬遷、trigger 改寫、drop 舊表；migration 冪等，
   重跑為 0 筆。
2. **scope／權限**：`OrganizationReadScope` 改為持有 term_classroom id 集合；讀寫分離
   改走 term_classroom；移除 `teacher_past_classroom_ids`。
3. **園所設定／my-classrooms**：班級 CRUD 改為在目前正式學期底下操作。
4. **編班**：計畫由「搬遷」改為「建立新學期班級並放人」；新生可直接放進計畫（不再受
   `source_membership_id NOT NULL` 限制）。
5. **報表／匯出**：老師進度、學期彙整匯出改走 term_classroom。
6. **前端**：班級相關頁面的 id 語意改動與文案。

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
- `classrooms` 移除後，跨學期查詢「同一個班名的歷史」需不需要提供入口，或一律以孩子
  （`RosterChild`）為軸。
