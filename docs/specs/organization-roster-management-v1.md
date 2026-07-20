# 園所名單、老師編制與相本權限 v1 Spec

## Verdict

本階段把「分校 → 部門 → 班級 → 老師／目前學生名單 → 各期相本」升級為既有相本
工作流與主管權限的主幹；園所設定不是另一套管理頁，而是所有日常 scope 的來源。

Decision：一班可同時有一位主教與多位協同老師；相本仍以一位 owner 作進度歸戶，
但班級相本的老師讀寫權直接來自目前 `ClassroomTeacherAssignment`。調班後新老師取得該班
各期相本工作權、舊老師失去班級授權；要保留權限就必須仍在班級編制，不能靠 editor 旁路。

Decision：同一分校可設定多位全校主管，也可在該校的 `infant`／`academy` 各設定多位
部門主管。全校主管涵蓋旗下所有班級，部門主管只涵蓋同校同部門；班級相本讀取／退回、
`my-classrooms` 與老師進度皆由此 scope 推導，不再由逐位老師綁主管決定。

Decision：新學期大量重新編班使用 admin-only 的編班計畫。草稿只保存目標狀態，
不改目前名單；管理員確認差異後手動一次套用學生與老師編制。v1 不做定時啟用，
也不在套用時自動建立新一期相本。

Decision：舊相本的 Student 身分不按姓名自動遷移。未歸班 Project 的既有
`roster_child_id` 只算 provisional evidence；管理員必須先預覽，再為每位 Student 明確選擇
建立新身分或連到 established identity，成功歸班才凍結為跨期身分。這是唯一 resolution
入口，不另建通用 link、merge 或 split API。

本階段不建立完整招生、候補、停學或學籍案件系統。

## Problem

若保留 `teacher_supervisors` 為主管權限主體，再旁接班級老師編制，就會出現兩棵互不
相干的樹：園所設定看得到班級，但主管進度與相本權限仍靠使用者管理；老師頁面也只能
在舊專案清單上方多放一塊「我的班級」。這不是整合。唯一主線必須是：主管 scope、班級
老師、學生與班級相本都在園所樹上；owner 只作進度歸戶，舊 editor 只留歷史稽核。

## Scope

- 班級目前／歷史老師編制，區分 `lead` 與 `co_teacher`。
- 同一老師可跨班、跨分校；分校歸屬由班級推導，不另複製一份 campus teacher 表。
- 管理員在同一園所設定頁維護校／部門主管、班級老師與學生；設定本身即授權。
- 管理員可在學生目前或歷史名單設定中央相本稱呼；若舊相本歸班時未建立 membership，
  也可從「各期相本」的學生旁修改。它跟隨孩子跨班／跨期沿用，並立即套用同一孩子所有
  既有與未來的已歸班相本。空白稱呼可在園所設定單筆或整班自動推導；不得覆蓋人工值，
  候選若在任何目前班級或既有已歸班相本碰撞就保持空白供人工確認。
- 老師的相本工作以目前班級分組，各期 Project 直接列在班級下。
- 老師進度按主管的校／部門 scope 開放，包含 scope 內尚未建立相本的目前班級老師。
- 從班級建立相本時，只能選目前當班老師為 owner；權限直接來自班級目前老師集合。
- 相本的成員與 `Student.name` 是建立當下班級名單快照；相本稱呼只讀園所設定，老師不可
  在相本內另建、複製、刪除學生、改完整姓名或維護另一份稱呼。
- 舊相本由管理員逐本歸入班級；完成前不向老師、主管或設計組開放。
- 舊相本歸班前先預覽固定學生快照與 established identities，並完整確認每位學生的身分決策。
- 班級老師、主管 scope 與全域角色共用同一個後端 object policy。
- 帳號降權、停用與刪除不得留下無效編制或失去稽核文字的歷史資料。
- 園所管理顯示目前／歷史編制、相本遷移進度與每本相本的權限來源。
- 新學期可先建立全園編班草稿，預覽留班、轉班、離園及老師編制差異，再原子套用。
- 編班套用後才以新的目前學生與老師編制建立未來 Project 快照；既有 Project 不變。

## Non-Goals

- 不做排班、工時、代課時段、薪資或教職員人事主檔。
- 不保留 owner、editor 或逐人主管關係作為班級權限旁路。
- 不從舊 `Project.owner_id`、專案名稱或班級相本反推歷史老師編制。
- 不以完整姓名、正規化姓名或舊 provisional link 自動決定跨期孩子身分。
- 不將協作編輯者重複計入老師進度報表；報表仍以 owner 歸戶。
- 不把學生目前名單升級成完整 Enrollment／招生案件系統。
- 不讓相本工作台成為另一個名單維護入口；完整姓名與在班狀態只在園所設定異動。
- 正式學期、班級期別工作格與報表遷移不由本檔重述，改由
  [正式學期與彙整報表 v1](academic-term-reporting-v1.md) 擴充；跨年度排程仍不在本階段。
- 不在編班套用時自動建立 Project，也不重寫既有 Project、Student 或 owner。

## Domain Model

### ClassroomTeacherAssignment

老師編制使用區間資料而非可覆寫的 many-to-many row：

- `classroom_id`
- `teacher_id`（帳號刪除後可為 NULL）
- `teacher_name_snapshot`
- `duty`: `lead | co_teacher`
- `started_at`, `ended_at`, `end_reason`
- `started_by_id`, `started_by_name_snapshot`
- `ended_by_id`, `ended_by_name_snapshot`

Decision：同一 `(classroom_id, teacher_id)` 同時最多一筆 active；同班 active `lead`
最多一位。非空編制必須恰有一位 lead。結束編制只寫 `ended_at`，不覆寫或刪除歷史。

### OrganizationSupervisorAssignment

主管權限也是區間資料：`campus_id`、`department nullable`（NULL=全校；否則為該校部門）、
`supervisor_id nullable`、`supervisor_name_snapshot`、started／ended 時間、原因與操作者快照。
同一 supervisor 在同一 active scope 最多一筆；未改變的完整替換不得重建區間。

班級型 Project 的 supervisor scope 只由此表與 `Project.classroom_id` 判定。`teacher_supervisors`
不回填、不猜測 scope、不參與任何授權，也不再要求新 teacher 必須逐人指定主管。

### ProjectEditorAssignment

既有相本協作者只保留歷史稽核，不再是班級相本授權來源：

- `project_id`
- `user_id`（帳號刪除後可為 NULL）
- `user_name_snapshot`
- `started_at`, `ended_at`, `end_reason`
- `started_by_id`, `started_by_name_snapshot`
- `ended_by_id`, `ended_by_name_snapshot`

migration 後不再為班級相本建立新 editor row；舊 row 不刪除。除 startup migration
一次結束 active rows 外，普通 Project／organization response、owner 轉交與帳號生命週期
都不查詢、序列化或修改這張歷史表。

### Project owner

`Project.owner_id` 繼續表示唯一的目前主要負責人及報表歸屬；
`ProjectAssignmentHistory` 繼續記錄每次轉交。owner 不授予讀寫權；admin 只能把班級相本
轉交給該班目前老師，舊 owner 是否仍有權限完全由其目前班級編制決定。

`Project` 另保存 `campus_name_snapshot`、`classroom_name_snapshot`。班級改名、停用或
新學期重新編班後，舊相本仍以建立當下名稱顯示。已有明確 `classroom_id` 的資料由 schema
migration 一次補齊快照；未歸班資料在管理員執行歸班時寫入，讀取期不做 fallback。

### Project Student snapshot

`Student.name`、`roster_child_id` 與成員集合是期別快照，不是目前班級名單。從目前名單
建立的新 Project 一開始就是凍結快照；舊 Project 在 `classroom_id=NULL` 期間只允許 admin
透過歸班 migration 寫入 `roster_child_id`，歸班成功後同樣永久凍結。已歸班相本的
`Student.album_name` 不再是資料來源；API、預覽與渲染都動態讀取 `RosterChild.album_name`，
未設定時回退該本 `Student.name` 快照。園所修改中央稱呼會失效所有相關既有輸出，但不改
成員、完整姓名或 child link。`Student.album_name` 只保留給未歸班 legacy Project。

### RosterChild identity

園所設定是目前名冊的唯一 authority。管理員新增一位新入園學生時，同步建立新的
`RosterChild` 與第一段 `ClassRosterMember`；即使姓名相同也不共用 id。改名只更新這個
目前名冊身分；可選 `RosterChild.album_name` 是所有已歸班相本唯一稱呼來源。轉班、回班與
新學期重新編班都沿用原 `RosterChild.id`，因此稱呼自然沿用，只改 membership 區間。
新入園若未明確提供稱呼，加入名單時才保守自動推導一次。由目前名單建立 Project 時，
Student 沿用 child id、固定當下完整姓名且不複製稱呼。Project runtime 不得改
`Student.roster_child_id`、`Student.name` 或 class-backed `Student.album_name`。

fresh legacy schema 加入 `students.roster_child_id` 時一律保持 `NULL`，不得按姓名建立或共用
`RosterChild`。曾跑過舊姓名推定 migration 的資料不在 startup 自動拆分；只要 Project 尚未
歸班，那個 link 就只是待人工判讀的 provisional evidence，不是 authority。學期匯出與所有
老師／主管報表完全排除未歸班 Project，因此 provisional link 不得參與分組。

established identity 只包括已有任一 `ClassRosterMember`，或已被 class-backed Project
Student 使用的 `RosterChild`。舊相本歸班的 `existing` 決策只能指向 established identity；
`create_new` 永遠建立全新 `RosterChild`，不得沿用或 promote provisional id。成功歸班後
Student identity 由 service 與 DB trigger 共同凍結；沒有普通 runtime link、merge 或 split API。

### TermReclassificationPlan

新學期重新編班以「整園目標狀態」處理，不以逐位學生立即轉班拼出結果：

- `TermReclassificationPlan`：`id`、固定 `scope_key=organization`、顯示用 `label`、
  `status: draft | applied | cancelled`、`revision`、`source_fingerprint`、`created_at`、
  `updated_at`、`applied_at` 及各事件操作者快照。
- `TermStudentPlacement`：`source_membership_id` FK、`roster_child_id_snapshot`、來源班級／
  分校與學生姓名快照、`outcome: classroom | departed`、`target_classroom_id nullable`。
  child id 只存建立草稿當下的身分快照而不設 FK；apply 以 source membership 重查 active
  狀態與目前 child id。每位來源 membership 恰有一筆。
- `TermClassroomPlan`：每個 active 班級恰有一筆，代表該班完整目標老師集合；即使目標為
  空集合也必須有 row，不能以「未送出」表示不變。
- `TermClassroomTeacherTarget`：隸屬 `TermClassroomPlan`，含 `teacher_id`、姓名快照與
  `duty: lead | co_teacher`，不是增刪 patch。

同一時間全園最多一份 draft，以 `scope_key WHERE status='draft'` partial unique index 保證；
status 另有 CHECK；applied／cancelled 後內容不可
再改。`source_fingerprint` 由建立草稿時的 active campus `(id,name)`、classroom
`(id,campus_id,department,name)`，active membership id、`RosterChild` id／正規化姓名／
班級／started_at，以及 active 老師
assignment id／teacher／duty／started_at 組成 canonical JSON（固定 key 與排序、UTF-8），
再取 SHA-256；validate 與 apply 都重新計算。來源已變時回 409，不得部分套用，管理員須
重新整理或重建草稿。

班級結構不在 plan 內修改；管理員須先建立並啟用新學期會使用的目標班級。plan 不負責
建立、改名或停用分校／班級，舊班級待成功套用且無 active 名單／編制後再由既有流程停用。

apply 在單一 transaction、單一 `applied_at` 內完成：留在同班者保留原 active row；
轉班者以 `term_reassignment` 結束舊 row 並建立新 row；離園者只結束舊 row。老師未變者
保留原 row，新增、移除或 duty 變更才建立／結束區間。套用前必須保證目標分校與班級
皆 active、每位來源學生恰有一個目標、學生不重複、同班正規化姓名不重複、班級人數
未超過相本學生上限、目標老師仍為 `role=teacher|supervisor` 的操作帳號，以及每個非空老師
集合恰有一位 lead。
任一錯誤 rollback 全部異動。

寫入順序固定為：先結束所有移動／離園學生與移除／改 duty 的老師區間，`flush`；再建立
全部新區間，`flush`；最後標記 plan applied 並一次 commit，避免撞 active membership／
lead partial unique index。學生離園 reason 為 `term_departed`，其餘本次異動 reason 為
`term_reassignment`。apply 不得呼叫任何修改既有 Project／Student／ACL 的 service。

所有名單新增／改名／轉班／回班、老師編制、班級啟停、相關角色變更及 plan 的
create／update／validate／apply／cancel 共用 `organization_acl_lock`；取得後先 rollback、
`expire_all`、開始 SQLite
immediate write transaction，再 reload、重算 fingerprint 與驗證，最後一次 commit。鎖順序
固定為 organization → template → sorted project locks；未來若改為多 worker，須換成
資料庫或分散式等價鎖，不能只依賴 process lock。

v1 新入園學生仍走園所設定的「加入目前名單」流程，在加入時建立新的 `RosterChild`；
編班草稿只移動既有身分，不建立學生身分；
`label` 只作顯示，不與部門限定的 `TemplatePeriod` 混用。

## API And Permission Contracts

### 組織 API

- `GET /api/organization/overview`：admin 完整總覽；班級回傳老師目前與歷史區間，
  campus 回傳主管 scope，目前與歷史區間；top-level 的 teacher／supervisor options 都包含
  `role=teacher|supervisor` 操作帳號及其 role，另回 migration status。
- `PUT /api/organization/campuses/{id}/supervisors`：admin 以完整集合原子替換全校與兩部門
  的 active supervisor scopes；未改變 row 保留，移除者只結束區間。
- `PUT /api/organization/classrooms/{id}/teachers`：admin 原子替換 active 編制；未改變的
  assignment 不重寫，移除者結束區間，新增者建立區間。
- `POST /api/organization/classrooms/{id}/members/batch`：admin 新增入園學生；每一筆建立新的
  `RosterChild` 與 active membership，不按姓名重用既有身分；可選中央 `album_name`，
  省略時套用保守推導。
- `PATCH /api/organization/classrooms/{id}/members/{member_id}`：admin 改名、設定或清除中央
  `album_name`、離園、轉班或回班；轉班／回班沿用原 `RosterChild.id`，只新增
  不可覆寫的 membership 區間。
- `PATCH /api/organization/roster-children/{id}/album-name`：admin 修改沒有可用 membership
  入口、但仍被已歸班相本引用的 child；相同 authority，不建立第二份稱呼。
- `GET /api/organization/my-classrooms`：teacher 只回自己 active 編制；supervisor 回其全校／
  部門 scope 的 active 班級；admin 回全部。不得以 owner 或逐人主管關係擴張班級 scope。
- `POST /api/organization/classrooms/{id}/projects`：admin 或該班 active lead 可建立班級相本；
  owner 必須是 active 班級老師，省略時採 active lead；不建立 editor assignment。
- `GET /api/organization/projects/{id}/classroom-migration-preview?classroom_id=…`：admin 讀取固定 Project Student、
  目標班狀態、established identity options 與 `source_fingerprint`；不寫資料、不按姓名選擇
  或預填 decision。同名候選必須讓管理員看見其分校／部門／班級、名單 active／ended 狀態，
  以及可取得的歷史 class-backed 相本名稱與期別；evidence 欄位的 SSOT 見
  [API 文件](../dev/api.md#園所管理-apiorganization)。
- `PUT /api/organization/projects/{id}/classroom`：admin 顯式把未歸班相本遷入 active 班級；
  request 必須含與 Project Student 集合完全相等的 `student_identity_decisions`，每筆只能是
  `action=create_new` 或指定 established `roster_child_id` 的 `action=existing`，另帶 preview
  `source_fingerprint` 與 `confirmed_all=true`。`seed_current_roster=true` 只在目標目前名單
  為空時把解析後的**全體**學生建成目前名單，不接受 subset。

班級／分校停用時不可新增編制或相本。`role=teacher|supervisor` 的 active 操作帳號都可加入
老師編制或主管 scope，同一帳號可同時存在於兩者且不改 `User.role`。
Project Student 不提供新增、複製、刪除或完整姓名修改端點；
三個 Project 相本稱呼 mutation 端點只供未歸班 legacy 相容，已歸班固定回 409
`roster_album_name_authority`。
`/api/roster` 也不提供 Student link、RosterChild merge 或 split 端點。

### 新學期編班 API（admin）

- `POST /api/organization/term-reclassification-plans`：以目前 active 學生與老師編制建立
  唯一 draft，寫入 label 與 source fingerprint；每位學生先預設留在原班、每班老師先
  複製目前集合，讓管理員只調整新學期差異。
- `GET /api/organization/term-reclassification-plans/{id}`：回傳完整草稿、來源快照、
  目標狀態、差異摘要與驗證錯誤。
- `PUT /api/organization/term-reclassification-plans/{id}`：body 帶 `expected_revision` 並送出完整
  `student_placements[{source_member_id,outcome,target_classroom_id}]` 與
  `classroom_teacher_targets[{classroom_id,teachers[{teacher_id,duty}]}]`，原子替換目標狀態；
  `outcome=classroom` 時 target 必填，`departed` 時必為 NULL。僅 draft 可改，成功後
  revision + 1；revision 不符回 409，缺少或重複任何來源 member／active 班級均為 422。
- `POST /api/organization/term-reclassification-plans/{id}/validate`：不寫目前名單，回傳
  stay／move／departed 與老師 add／remove／duty-change 預覽。
- `POST /api/organization/term-reclassification-plans/{id}/apply`：body 帶 `expected_revision`，
  重新驗證 fingerprint 後原子套用；成功才將狀態改為 applied。成功回應遺失後重送同一
  applied plan 只回傳既存結果、不再寫入；cancelled plan 回 409。
- `POST /api/organization/term-reclassification-plans/{id}/cancel`：取消 draft，不動目前狀態。

老師與主管不得讀取或猜 id 取得 draft；套用後才透過 `my-classrooms` 看到新狀態。
錯誤回應至少固定 `draft_exists`、`term_plan_revision_conflict`、`stale_reclassification_plan`、
`invalid_target_state` code，讓前端能區分重新載入與修正草稿。

PUT 只拒絕缺項、重複與 discriminator 等結構錯誤；停用目標、容量、同名、老師角色與
lead 等 business error 可保存，validate 回 `is_valid=false` 與穩定欄位／row error code。
apply 遇 stale 回 409，其他 business error 回 422，兩者都必須零寫入。

### 新學期設定流程

「園所設定 → 新學期編班」先提示建立／啟用目標班級，再由目前狀態建立草稿。管理員按
目標班級分組調整學生（留班／轉班／離園）與主教／協同老師；預覽頁顯示各班前後人數、
學生移動及老師差異，錯誤可直接定位。最後確認只套用目前名單與編制，成功後才提供
「建立新一期相本」下一步，不自動建立，也不修改舊相本。

### 專案 object policy

後端 `project_access_service` 是唯一授權 SSOT：

| 能力 | 規則 |
|---|---|
| 讀取 | admin；班級相本另開放 art_team、該班 active teacher assignment、該校／部門 active supervisor assignment |
| 編輯 | admin、班級相本的 active teacher assignment，不依 base role |
| 退回完成 | admin；班級相本的該校／部門 active supervisor assignment，不依 base role |
| 新增審閱留言 | admin、art_team；班級相本的 active supervisor assignment，不依 base role |
| 轉交 owner | admin，且目標須為該班 active teacher assignment |

Project list、archive、detail、學生、照片、留言、預覽、渲染及下載的 direct-id 檢查必須
使用相同 policy。Project summary、detail 與 `StudentEditorProject` 都回傳後端計算的
`permissions.can_read/can_edit/can_reopen/can_comment`；前端只用它控制介面，403 仍由後端裁決。

`classroom_id=NULL` 的相本只允許 admin 讀取及執行遷移；其他角色一律 403。通用
`POST /api/projects` 與 `PUT /api/projects/{id}/editors` 不存在；所有新相本都必須從
active 班級端點建立，協作權只來自 active 班級老師編制。semester export、老師進度與
主管報表也一律排除未歸班 Project，即使其 Student 尚帶有非 NULL provisional link。

`/api/roster/teacher-progress` 與其他主管報表只由 active supervisor assignment 開放，並使用
相同校／部門 scope：列出範圍內
目前班級老師與 class-backed projects，協作者不重複計入進度，專案仍以 owner 歸戶。
未歸班 Project 不出現在老師或主管進度；不得以 owner 或 `teacher_supervisors` 擴張 scope。

### 老師調班與相本歷史

- 新增老師：立即取得該班所有已歸班相本的讀寫權。
- 移除老師：立即失去該班授權；既有 Project、Student 與 owner 歸戶不改。
- 換主教：班級讀寫集合不變，只改未來相本的預設 owner。
- 要改既有相本的進度負責人，由 admin 顯式轉交 owner 並留下 history。

### 帳號生命週期

- teacher 不需逐人指定 supervisor；主管權限由園所 scope 設定。`teacher`／`supervisor` 是同一
  操作帳號族群，可在兩者間切換而不解除編制，實際能力仍由 active assignment 決定。
- 改成 admin、art_team 等非操作角色前，有 active 班級編制或校／部門 scope 都須先解除；
  owner 是進度歸戶而非授權，需轉交時由管理員在園所設定處理。
- `role=none`／刪除在同一 transaction 結束 scope 與老師編制，並保留姓名／操作者快照。
- 角色變更遞增 `auth_version`；`role=none` 的既有 Cookie 下一請求即失效。
- `role=none` 是緊急停權：同一 transaction 結束 active 班級編制與主管 scope，
  將 owned Projects audited transfer 給執行 admin 並遞增 `auth_version`；不得因仍有編制
  或相本而阻擋停權。
- 刪除帳號在同一 transaction 結束 active 班級編制與主管 scope，將 owned Projects
  透過既有 audited transfer 交給執行 admin，再刪除 User；所有姓名快照保留。

## Migration

- schema migration 建立老師／主管區間與索引，並一次結束全部 active editor rows，原因固定
  `classroom_scope_migration`；舊 rows 保留稽核，但執行期永不讀取。
- 舊 `users.supervisor_id` 與 `teacher_supervisors` 先帶姓名快照封存到 legacy archive，
  再從正式 User ORM／schema 移除；不從這些關係、owner、專案名稱或學生名單猜班級與
  主管 scope。封存資料只供遷移稽核，執行期不授權。
- fresh legacy Student 的 `roster_child_id` 保持 `NULL`；already-migrated 姓名推定 link 保留為
  provisional evidence，startup 不自動拆分、合併或視為已解析。
- startup 若發現任何 class-backed Project 含 NULL link、失效 link，或同一 Project 多位
  Student 共用 child id，就把整本 Project（含已封存者）的 `classroom_id` 清為 NULL，重新
  隔離於 admin-only 歸班佇列。不得猜測或改寫 Student identity，也不得清除 Project 校／班
  名稱快照、`deleted_at` 或 `archive_expires_at`。隔離前的 Project／校／班／封存狀態與各類
  異常數量寫入無 operational FK、每 Project 唯一且禁止 update／delete 的 raw audit row；
  重跑不得重複寫入。semester export 因只讀 class-backed Project，自動排除這些資料。
- 管理員先開歸班 preview，再為 Project 的**每位** Student 送出完整 explicit decision。
  decision 集合缺少、重複或多出 student id 都拒絕；`existing` 必須是 established identity，
  `create_new` 永遠建立新 id。姓名只供人員核對；同名 proposal 不得自動選擇、確認或提交
  action，後端也沒有姓名 fallback。非目標班同名候選必須顯示建立其 established 身分的
  名單或 class-backed 相本來源，讓同名不同人可憑校班與期別區分。
- apply 共用 `organization_acl_lock` 與 `BEGIN IMMEDIATE`：重讀 Project／班級／Student，驗證
  department、`confirmed_all`、重算 `source_fingerprint`、完整 decisions、identity 唯一性、
  seed 衝突與容量；接著寫入 raw audit ledger、
  更新未歸班 Student link、必要時建立全體 membership，最後才寫 Project `classroom_id` 與
  校／班快照並一次 commit。任一步失敗時 ledger、RosterChild、Student、membership、Project
  全部 rollback，ACL 不得提早開放。
- append-only audit ledger 的 schema 與 FK 邊界見
  [data-model.md](../dev/data-model.md#orm-模型backenddatabasepy)。DB trigger 阻止沒有完整
  header／resolution ledger 的 legacy Project 歸班，也阻止已歸班 Project 的 Student
  `project_id`／`name`／`roster_child_id` 再被修改。
- `seed_current_roster=true` 僅能在目標 active roster 為空時，把已解析的完整 Project Student
  集合一次建立為目前名單；`false` 完全不動名單。部分 seed 明確不屬於本契約。
- `migration_status` 的欄位與完成判定由 [API 文件](../dev/api.md#園所管理-apiorganization) 擁有；
  遷移完成前未歸班相本維持 admin-only，且不存在 runtime fallback。
- migration 不建立編班草稿，也不猜學期或重新編班結果；重跑不得重建區間或改寫歷史。

## Implementation Slices

1. schema／園所：老師與主管區間、identity resolution ledger／trigger、scope query 與冪等 migration。
2. 舊相本遷移：preview、完整 decisions、全量 seed、原子 apply 與 migration status。
3. ACL／生命週期：class-only object policy、unassigned admin-only、停權／刪帳 transaction。
4. 編班：完整目標、fingerprint、差異預覽與原子 apply；不改 supervisor scopes 或舊 Project。
5. 既有 UI：園所設定同頁配置主管／老師／學生；相本工作按班級列各期；老師進度按 scope。
6. 驗收：文件 SSOT、backend gates、frontend build/lint/unit、Playwright 與完整 pytest。

## Acceptance Smoke

1. admin 在園所設定指派全校主管、部門主管、兩位班級 teacher 與學生名單，整班自動填入
   安全可判斷的相本稱呼，碰撞者保持空白供人工設定；轉班後同一名冊身分仍保留該稱呼。
2. 以班級目前名單建立兩期相本；owner 是 lead，Student 不保存另一份稱呼，所有 active
   class teachers 可編且無 editor row。之後在園所設定修改或清除稱呼，兩期既有相本與後續
   新相本都立即解析為同一中央值，舊輸出失效；相本工作台只讀稱呼，沒有學生或稱呼維護入口。
3. lead 與 co_teacher 可編；同校全校主管及同校同部門主管可讀／退回但不能編；其他校／
   部門主管 403；art_team 只讀；admin 全部可管。
4. 把班級 lead 從 A 改成 B；B 立即可編全部班級相本，A 失去班級權限，owner 歸戶不自動改。
5. admin 顯式把既有相本 owner 從 A 轉交 B；history 保留 A→B，但 ACL 集合不因此改變。
6. 直接猜另一班、另一專案、學生、照片、預覽或下載 id 均回 403，列表與 detail 集合一致。
7. 老師／主管降權、停用或刪除按生命週期契約處理；舊 Cookie 失效，歷史姓名仍顯示。
8. fresh legacy Student link 保持 NULL；舊姓名推定 link 只作 provisional evidence。未歸班相本
   對非 admin 為 403 且不進匯出；preview 不預填決策，apply 缺任一 Student decision 就零寫入。
9. admin 對一個空班完整選擇 create-new／established-existing 並全量 seed；ledger、Student links、
   memberships、Project 組織快照同時 commit。之後第二期舊相本明確連到相同 ids，學期匯出
   才合併成同一孩子；歸班後任何 identity 改寫被拒。
10. admin 建立新學期草稿，完成留班、轉班、離園及老師增減／換主教；validate 前後目前
   名單與編制都不變。
11. 草稿建立後若目前名單被其他操作修改，apply 回 409 且零寫入；重建有效草稿後，
    所有學生與老師區間使用同一 `applied_at`、依結束→flush→新增順序一次成功切換。
12. 重新編班不改舊 Project、Student、owner 與班級名稱快照；新老師立即取得目標班全部
    相本權限，舊老師立即失去，之後新 Project 才取得新名單與新 owner。
13. production build 後實際從園所管理完成老師設定、重新編班與相本建立；dev server
    最終回應 200。
14. teacher 的相本工作以目前班級分組；主管的老師進度只含其校／部門 scope，並包含尚未
    建立相本的當班老師，列表與 direct-id 權限一致。

## Open Questions

本階段沒有阻擋實作的產品問題。未來若要讓老師自行修改班級目前名單，另開明確的
roster mutation phase；本階段老師／主管的 `my-classrooms` 先維持只讀。
