# 期別建立相本鎖 v1

## Verdict

「還能不能開新相本」從學期狀態的副作用，改成每個學期期別各自的開關：
`semester_periods` 帶一個 admin 可切換的建立鎖，**取代**「只能在目前正式學期建立相本」
這條硬閘。學期在日曆上結束後，只要該期別沒被鎖，原任主教與 admin 仍可補開相本；
反之學期還開著時，admin 可以提前關掉某一期的收件窗口，不必等學期轉換。

`template_periods.status` 同時退出建立相本的判斷，只留設計端語意。營運上的「本期截止
收件」與設計上的「這套期別退役」從此是兩個開關。

## Problem

- 沒有任何欄位叫「建立鎖」：擋下新相本的其實是 `classrooms → semesters.status`，
  唯一的切換方式是套用編班（`apply_term_reclassification_plan` 把舊學期改 `closed`）。
  期末想提前關掉第一期，只能連整個學期一起關。
- 反過來也一樣：學期一 `closed`，三個期別同時封死。實務上學期在日曆上結束時相本常
  還沒做完（2026-08 首次切換時有 40 本仍在製作），漏開的那本再也補不回來。
- 唯一接近期別粒度的開關是把 `template_periods.status` 設成 `archived`，但那個欄位
  同時是設計端狀態：它會讓該期別的模板從老師可選清單（`list_templates` 的
  `available=true`）與新模板的預設期別（`_resolve_template_period`）一起消失，
  還會讓 `_ensure_current_term_classroom_grid` 在 `imported` 學期跳過補格——
  鎖定期間新增的班永久缺那一格，解鎖也不會回頭補。

## Scope

- `semester_periods` 的建立鎖欄位、冪等 migration 與 admin 切換端點。
- `create_classroom_project` 的閘門改寫：期別鎖取代學期閘，名冊與編制改用
  carryover 判準。
- 已結束學期的補建入口：`overview`、`my-classrooms`、工作格序列化與兩個前端頁面。
- 建立相本權限擴及原任主教（僅因學期輪替而結束編制者）。

不在本階段：既有相本的編輯、完成、退回、下載、搬學生行為一律不變；老師進度與學期
匯出契約不變。

## Domain Model

`semester_periods` 新增三欄（沿用本專案的時間戳＋actor snapshot 慣例，
如 `Semester.closed_by_*`）：

- `album_creation_locked_at`（DateTime, nullable）——非 NULL 代表這一期已停止開新相本。
- `album_creation_locked_by_id`（FK users, nullable, ON DELETE SET NULL）
- `album_creation_locked_by_name_snapshot`（String, nullable）

migration 依慣例在 `run_migrations()` 末端追加、可重跑。既有期別的預設值分兩種：

- 進行中學期（`imported|active`）的期別為 NULL（開放）——與升級前一致。
- **已結束學期（`closed`）的期別預設鎖上**，`album_creation_locked_at` 取該學期的
  `closed_at`，actor 欄位留 NULL（不是某個人按下的）。升級前「已結束學期不能開新相本」
  是硬性事實；若讓它們一律開放，上線那一刻全園老師會突然多出歷屆班級與補建入口。
  要補做哪一期由 admin 明確解鎖。

回填**只在欄位剛建立的那一次**執行。之後 admin 解鎖了某一期，重跑 migration 不得把它
鎖回去——這是本 migration 冪等性的實質內容，不只是「不重複加欄位」。
鎖的粒度是**學期 × 期別**：鎖住後該學期全部分校、全部班級的這一期都不能開新相本。
單班例外放行不在 v1。

### Carryover 判準（唯一真相來源）

學期輪替會把舊班的**全部**名冊與老師編制一次結束
（`apply_term_reclassification_plan`），所以「目前有效」在已結束學期一律是空集合。
補建必須改認**結束原因**，而不是「曾經在班」：

```
老師編制 carryover = ended_at IS NULL OR end_reason == 'term_reassignment'
名冊     carryover = ended_at IS NULL OR end_reason IN ('term_reassignment', 'term_departed')
```

`assignment_replaced`（被管理員換掉）、`transfer`（期中轉班）、`departed`（期中離園）
都**不算**——前者是刻意撤換，後兩者的孩子在該學期的歸屬已經不是這個班。

老師那條判準已存在於 `_load_teacher_carryover_classroom_ids`
（`organization_scope_service`）與 `transfer_project_owner`
（`project_assignment_service`）。本階段抽成 `organization_scope_service` 的單一
predicate，三處共用，由 `tests/test_organization_term.py` 釘住；不得再各寫一份。

名冊那條是新增的，語意是「該學期結束時仍在這個班的孩子」。期中離園的孩子不會被自動
收錄——期別沒有日期界線，無從判斷他在哪一期還在籍（見 Non-Goals）。

對仍在進行中的學期，兩條 carryover 判準與原本的 `ended_at IS NULL` 等價：`term_*`
只在套用編班的那一刻寫入，而那時該學期已同時 `closed`。因此不需要依學期狀態分支。

## Write Contracts

### 切換鎖

`PATCH /organization/semesters/{semester_id}/periods/{semester_period_id}`，
body `{"album_creation_locked": bool}`：

- **只有 admin**。
- 期別必須屬於 URL 指定的學期，否則 404。
- `cancelled` 學期的期別不可切換（409 `semester_not_lockable`）；`closed` 學期**可以**
  ——期末回頭補開一本正是這個功能的用途。
- 上鎖寫入 `album_creation_locked_at` 與 actor snapshot；解鎖三欄一併清空。
- 重複上鎖／重複解鎖冪等回傳現況，不更新既有時間戳。
- 走 `organization_write_transaction`（它本身已取得 `organization_acl_lock`）。

鎖只擋「開新相本」，含同一格加開第二本。既有相本的編輯、完成、退回、下載、搬學生、
改名一律不受影響。

### 建立相本

`create_classroom_project` 的閘門改為：

- **移除**「班級所屬學期必須是 `imported|active`」與 `classroom.is_current`；
  `campus.is_active` 保留。學期仍必須是 `imported|active|closed`——草稿與已取消的
  學期不是「還沒鎖」，是名冊還在編排中，根本不能作業（409 `work_slot_term_not_open`）。
- **新增**：工作格的 `semester_period.album_creation_locked_at` 必須為 NULL，
  否則 409 `work_slot_period_locked`，訊息「這一期已停止建立相本」。
- **移除** `template.period.status == "active"` 這條。模板仍必須屬於工作格的那個期別
  （既有 `work_slot_period_mismatch`）且部門一致，期別是否退役由建立鎖決定，
  不再看設計端狀態。
- 名冊與老師編制、主教唯一性、owner 資格全部改用上方 carryover 判準。空班仍回 409
  `classroom_roster_empty`。
- 其餘不變：同格多本允許、同一個孩子不得被同格兩本收錄、`slot.started_at` 僅第一次寫入。

`template_periods.status` 的剩餘職責只有設計端：`list_templates?available=true` 的過濾
與 `_resolve_template_period` 的預設期別。

### 建立權限

`assert_classroom_project_creatable`：admin，或該班 carryover 主教（`duty == 'lead'`
且符合老師 carryover 判準）。被換掉的舊主教（`assignment_replaced`）仍然擋得住。

## Read And Permission Contracts

- 工作格序列化（`_serialize_work_slot`）的 `can_create_project` 改成
  「該期未鎖 **且** 分校啟用」，不再看學期狀態；另回 `album_creation_locked_at`，
  讓前端能把「已截止」與「這格不該出現」分開呈現。
- `get_organization_overview`：除了目前學期的工作格，另外回傳**已結束學期中該期別未鎖**
  的工作格與其班級，否則 admin 沒有補建入口。`_serialize_campus` 仍只列目前學期的班
  （避免歷屆同名班重複），補建用的班級資訊由工作格自帶的校名／班名／學期標籤提供。
- `get_my_classrooms`：老師的可補建班級取自既有的
  `OrganizationReadScope.teacher_carryover_classroom_ids`，同樣只放該期別未鎖的工作格。
  **admin 不走這條**——她的補建入口在園所設定的 `work_slots`，若讓「我的班級」也帶上
  全園歷屆未鎖的班，每過一個學期就會多堆一屆。
- 讀取權、編輯權、主管 scope 一律不變——本階段不放寬任何既有相本的存取。

## Frontend Contract

- `ProjectList`：`getCreatableWorkSlots` 不再檢查 `semester_status`，改看
  `can_create_project`；工作格選項與相本清單的分組標籤必須帶學期名，讓「114 下第三期」
  與「115 上第三期」不會看起來是同一格。
- 已鎖的期別**顯示而不是消失**：帶 `album_creation_locked_at` 的工作格以停用狀態列出並
  標「本期已停止建立」，避免老師以為選項壞掉。
- `OrganizationManagement`：admin 在學期期別上有鎖／解鎖切換，顯示鎖定者與時間；
  已結束學期的補建入口與目前學期的班分開呈現，必須帶學期標籤。
- 改動 `frontend/src/**` 後必 build（CLAUDE.md 硬規則）。

## Acceptance Smoke

- admin 鎖住 active 學期的某一期後，該期全部班級開新相本回 409
  `work_slot_period_locked`；同學期其他期別不受影響；既有相本照常編輯與下載。
- 解鎖後同一格可以再開相本；重複鎖／重複解鎖冪等，`album_creation_locked_at` 不被
  後續上鎖覆寫。
- 套用編班使學期 `closed` 後，未鎖期別的工作格仍可由該班原任主教開新相本；相本正確
  掛回舊學期的工作格，老師進度與學期匯出把它算進舊學期。
- 同一情境下，`assignment_replaced` 的舊主教回 403，非該班老師回 403。
- 已結束學期的補建：名冊取到該學期結束時仍在班的孩子（含 `term_departed`），
  期中 `transfer` 出去與期中 `departed` 的孩子不在其中。
- 期別鎖住時，該期別的模板仍可在模板管理頁編輯；`template_periods.status = archived`
  不再擋建立相本，只影響模板可選清單與預設期別。
- 分校停用時該格仍不可建立，且前端不把它顯示成「已截止」。
- `closed` 學期補建不觸發任何 `classroom_members` / `classroom_teachers` 寫入
  （凍結 trigger 不得被觸發）；`slot.started_at` 若已有值不被改寫。
- migration 重跑無錯；進行中學期的期別開放，已結束學期的期別預設鎖上（上線行為與
  升級前一致）。admin 解鎖某一期之後重跑 migration，那一期**仍然是解鎖的**。

## Non-Goals

- 單班或單分校的例外放行（鎖的粒度就是學期 × 期別）。
- 期中離園孩子的自動補收錄：期別沒有日期界線，無法判斷他在哪一期還在籍，需要時由
  admin 以指定名單的方式處理。
- 放寬既有相本的編輯權、主管 scope 或下載閘門。
- 老師進度與學期匯出的契約變更（見
  [academic-term-reporting-v1](academic-term-reporting-v1.md#teacher-progress-contract)）。
- 自動在學期轉換時上鎖或解鎖任何期別——新學期的期別一律預設開放，舊學期的鎖狀態不搬。

## Open Questions

無。v1 以本契約直接實作。
