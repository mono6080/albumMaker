# 正式學期、班級期別工作格與彙整報表 v1

## Verdict

本階段把模板期別、園所班級與相本工作流遷移到同一個正式學期模型。
老師進度的統計單位固定為「班級 × 期別工作格」；學期匯出固定依校別、
班級與穩定學生身分彙整。老師編制、主管範圍仍由園所設定授權，Project
owner 只表示負責人，不能再兼任班級或權限來源。

## Problem

- `TemplatePeriod` 目前只是模板分類，無法表示一個可查詢的學期。
- 老師進度以老師 owner 分組，協同老師會被誤算未開始，跨期學生也被重複加總。
- 沒有持久化的班級期別工作格，無法區分未建立與資料根本不適用。
- 學期匯出拿 Project 名稱當班級，且在前端推測缺期，轉班與離園會誤判。
- 主管 scope 只展開目前啟用班級，停用舊班後會失去其校別／部門歷史相本。
- 補渲染文件宣告單工，實際上可同時啟動多個背景 job。

## Scope

本階段包含：

- 正式學期、學期期別、學期班級、學生／老師快照與班級期別工作格。
- 新學期編班套用與正式學期在同一 transaction 切換。
- 既有有效 Project 的一次性遷移與目前有效工作格建立。
- 老師進度 API、Excel、學期預覽、ZIP、補渲染與兩個前端頁面。
- 主管對歷史 Project 的校別／部門快照 scope。

使用者已決定：`deleted_at IS NOT NULL` 且等待 `archive_expires_at` 清除的資料
不納入此遷移，繼續由既有 purge 清除。

## Domain Model

### Semester

`semesters` 是整園學期主檔：

- `id`, `label`, `status`（`imported|draft|active|closed|cancelled`）
- `migration_key`（nullable；既有資料匯入用唯一標記）
- `starts_on`, `ends_on`（nullable）
- 建立、啟用、結束的時間與 actor snapshot

同一時間最多一筆 `active`；`draft` 由新學期編班草稿持有。

### SemesterPeriod

`semester_periods` 把既有 `TemplatePeriod` 納入一個學期：

- `semester_id`, `template_period_id`
- `period_name_snapshot`, `department`, `position`
- 同一 TemplatePeriod 只能屬於一個 Semester；同學期 position 唯一。

Project 仍保留 `template_period_id`，但報表的學期與順序只讀本表。

### Classroom（學期班級）

班級本體就是學期範圍實體，沒有另一層快照。結構與不可變保證的 SSOT 在
[term-scoped-classroom-v1](term-scoped-classroom-v1.md)；本規格只依賴三件事：

- 班級屬於且只屬於一個 `Semester`，同學期內 `(campus_id, department, name)` 唯一。
- 該學期的名冊（`ClassroomMember`）與老師編制（`ClassroomTeacher`）直接掛在
  班上；報表列出班上全部指派，`ended_at` 分辨現任與曾任。
- 學期 `closed` 後名冊與編制由 trigger 凍結，API 也拒絕對已結束學期的班加人。分校名與
  孩子姓名不凍結——更正後歷史報表跟著顯示新值；`ProjectStudent` 仍保存每本相本建立當時的姓名
  與 Project 班級快照。

### ClassPeriodWorkSlot

`class_period_work_slots` 是進度唯一統計單位：

- `classroom_id`, `semester_period_id`, `started_at`
- 同一學期班級與學期期別唯一。

`projects.class_period_work_slot_id` 指向工作格。舊資料可有多個 Project
指向同一格；新建立流程只允許空工作格建立一次。`started_at` 一旦寫入不因
Project 封存或 purge 清空，避免同一格被靜默重做。

Project 新增不可變 `campus_id_snapshot`。班級歸入或建立時，必須與
`campus_name_snapshot`、`classroom_name_snapshot`、`department` 同次寫入；
這些欄位只在 `classroom_id: NULL → value` 的正式遷移中設定。

## Migration Contract

> 以下十二條是「長期班級 + 學期快照」結構上線時的一次性遷移契約，屬歷史紀錄。班級改為
> 學期範圍實體後（見 [term-scoped-classroom-v1](term-scoped-classroom-v1.md)），這些步驟由
> `_is_term_scoped_classroom_schema()` 守衛整段跳過：全新資料庫由 `init_db()` 直接建出新
> 結構，硬跑會把已移除的快照表重建回來。舊資料庫升級時仍會先跑完這段、再併入學期範圍。

migration 必須冪等，並在 `run_migrations()` 末端追加：

1. 建立上述 schema、索引與 snapshot freeze triggers。
2. 建立唯一 `migration_key=organization-reporting-v1` 的 imported term。
3. 只處理 `deleted_at IS NULL AND classroom_id IS NOT NULL` 的 Project。
4. imported term 納入這些 Project 實際期別，以及所有 status=active 的期別。
5. 納入實際 Project 班級，以及目前啟用校別下同部門的啟用班級。
6. 每個實際 `(classroom_id, template_period_id)` 建一格並連回全部 Project。
7. 對 active 期別 × 同部門 active 班級建立目前預期格；因此可顯示真正
   的「未建立」，archived 期別不憑目前班級補空格。
8. 目前學生名單寫入 imported term 學生快照；不在目前名單但已有
   有效 ProjectStudent 者，以最新相本班級／姓名補齊，不得同學期跨班重複。
9. 現有有效老師編制寫入 imported term 的班級老師快照；找不到的歷史老師
   不可由 owner 猜測。
10. 對 Project 校別 id 快照依遷移 ledger、唯一校名、目前 Classroom 依序回填；
   無法唯一決定時 migration 失敗，不可猜。
11. Project 連回 slot 後，其校 id／校名／班名／部門快照必須與該工作格的班級
    完全一致；不一致 migration fail-fast，不建立分裂報表 scope。
12. 封存待清除與未歸班 Project 保持 slot NULL，不建立 term rows。

舊同班同期多 Project 不合併、不刪除、不搬內容，只在同一工作格的
`projects[]` 顯示；同一孩子同一期出現在多 Project 才是匯出 duplicate。

## Write Contracts

### 新學期編班

建立編班草稿會同時建立 draft Semester；label 是正式學期名稱，不再只是
事件備註。草稿可指定 ordered TemplatePeriods。套用順序固定為：

1. 驗證 revision、source fingerprint、學期期別與目標狀態。
2. 結束舊學期班級的全部名冊與老師區間——舊班隨學期一起結束，沒有「留在原班就不動」
   的分支。
3. 在目標學期的班（建立草稿時就已長出來）建立新的名冊與老師區間。
4. 依同部門的目標學期班級 × term periods 建立完整工作格。
5. 關閉舊 active term、啟用目標 term、標記 plan applied。
6. 一次 commit；任一步失敗全部 rollback。

新期別加入 active term 時，必須在同一 transaction 為同部門的該學期班級補工作格。
取消 draft plan 同時取消其尚未啟用的 term 與其班級。

### 建立相本

`POST /organization/classrooms/{id}/projects` 必須帶 `work_slot_id`，並在既有
organization/template lock 與 transaction 中驗證：

- slot 屬於 URL 班級、active term，且期別等於 template.period。
- template、班級、slot 的 department 一致。
- slot 尚未 started，且目前班級至少一位學生。
- owner 是該班目前有效老師；無 owner 時用主教。

建立 Project、凍結學生名冊、寫 Project snapshots 與 slot.started_at 必須同次
commit。空班、同格重複與錯配一律回 409/422，不建立部分資料。

## Read And Permission Contracts

- 目前老師可編輯目前任教班級；owner 不授權。
- 目前主管可讀其有效校別／部門下的歷史 Project，即使舊 Classroom 已停用。
- 歷史主管或已結束指派者不保留權限。
- 歷史主管 scope 以 Project/term-classroom 的 `campus_id_snapshot + department`
  判斷；目前班級管理清單仍只顯示 active 結構。
- admin 可讀全部；報表與單筆 Project review 必須使用同一 predicate。

## Teacher Progress Contract

`GET /roster/teacher-progress?semester_id=` 回 `term`、ordered `periods`、
`summary` 與 `classrooms[]`。每班有老師快照及 `slots[]`；slot 有
`not_created|archived|single|multiple_projects` 與 `projects[]`。`archived`
表示工作格曾開始、但目前只剩封存／已清除 Project；它不可被當成未建立而重做。

每個 Project 分開回傳三個正交狀態（老師進度不考慮列印 PDF 是否已產生；
PDF 狀態只屬於學期匯出）：

- `content_status`: `empty|incomplete|ready`，含照片與文字各自的 filled/total；
  只有兩者都填滿才是 `ready`，並保留空白文字數供既有匯出使用。
- `workflow_status`: `working|submitted_locked`，只由 `completed_at` 決定。
- `attention_codes`: 空相本、已交件但缺照片／缺文字。

協同老師只列在班級老師，不產生自己的未開始卡；owner 只列 Project metadata。
摘要計工作格與 Project，不把跨期 ProjectStudent snapshots 加總稱為學生人數。

Excel 與同一 builder 共用資料，固定三張表：摘要、班級期別、學生明細。

文字進度的分母是「Project 學生 × 該學生未跳過頁面的可見可填文字框」。每一格先套用
學生個別文字，沒有個別文字才套用全班文字；最後文字去除空白後非空才算已填。模板預設
範例字、固定文字與隱藏文字都不算老師已填。因而 12 格文字中，全班填 11 格、所有學生
各自填好最後 1 格時，文字進度是全班的 `12 × 學生數 / 12 × 學生數`，視為完成；少一位
學生未補最後一格，就仍是未完成。

## Semester Export Contract

預覽按 term 及 period subset 查詢，entry 必含校別、班級、部門 snapshot。
分組與 ZIP 路徑使用 `校別/班級/孩子/期別_孩子.pdf`，不得使用 Project name
代表班級。同一孩子在這次匯出有兩期以上 PDF 時，孩子資料夾內另附
`全期合併_孩子.pdf`：以 pypdf 依期別順序把 A4 頁兩頁併成一張 A3 橫式
（頁序跨期連續，奇數頁時最後一張右半留白）；僅一期時不附。

每個孩子每期 cell 由後端回：

- `not_enrolled`：在該 term 先前期別尚未有正式身分。
- `departed`：最後出現後已 `departed|term_departed` 且無目前 membership。
- `no_album`：學期學生快照存在，但該期沒有 ProjectStudent snapshot；包含整期
  從未建立 Project 的孩子。
- `not_rendered|ready`：恰一筆且 PDF 未產生／已產生。
- `duplicate`：同一 stable child 同一期有多筆，且尚未有人裁決；不補渲染、不下載並列 IDs。
- `resolved`：同一期有多筆但已裁決；照選中的那一本渲染與納入 ZIP。

### 同期重複相本：由匯出者裁決（決策 2026-08-02）

期中轉班會讓孩子在原班與新班各有一本該期相本，兩本都要留——原班那本通常已在製作中，
新班那本則是他接下來的歸屬，硬刪任一本都會傷到其他孩子。

**做法是「像 merge conflict 一樣擋下來讓人選邊」**，不是靜默略過：

- **裁決單位是一格**（孩子 × 期別），不做逐頁合併。同一期的頁面來自不同班級的模板，
  混著出會讓版面與頁碼不一致——這裡要的是 `--ours` / `--theirs`，不是逐 hunk 合併。
- **未裁決會擋下匯出**：回報「N 格待裁決」，而不是產出一份少了人的 ZIP 再把它寫在
  說明欄裡。少東西的匯出沒有人會發現。
- **裁決要能比較兩邊**：班級、負責老師、完成狀態、是否已產生 PDF、頁數、最後更新時間。
- **裁決要留下來**：記錄選了哪一本、誰決定的、什麼時候、為什麼，之後每次匯出沿用。
- **選項變動時裁決自動失效**：又多出一本、或選中的相本被封存時，那一格回到 `duplicate`
  重新等人裁決。沉默沿用一個過期的決定比沒有決定更危險。

尚未實作；現況與限制見
[known-issues.md](../dev/known-issues.md#開放設計問題)。

前端不得再以 first appearance 推測缺期。ZIP manifest 必列缺檔、重複、身分
異常與老師刪頁。補渲染是全程序 singleton；第二個 running request 回 503
`semester_render_job_running`，完成或失敗後才可再啟動。

## Frontend Contract

兩頁共用學期 → 部門 → 校別 → 班級篩選；request 與 render job 必綁定
filter signature、AbortController 與 sequence，舊回應不得覆蓋目前畫面。

- 老師進度：桌機班級×期別矩陣、手機班級 accordion；每格分開呈現建立、
  照片／文字、交件鎖定與負責人，不顯示 PDF 狀態。
- 學期匯出：依校別／班級 accordion 顯示孩子×期別；明確顯示未入園、離園、
  無相本、重複、未產生與已產生。
- 下載時若選取孩子含未產生 PDF，先自動啟動補渲染（同一 singleton job，
  範圍限這些孩子），job 結束非 failed 即自動開始下載；部分失敗照樣下載，
  缺漏由 ZIP 匯出說明列出。
- 換 term/scope/period 必須重設 selection；主管不可補渲染或下載。

## Acceptance Smoke

- infant 查詢不含 academy 班級或老師；協同老師不會多一筆未開始。
- 同班同期兩個舊 Project 只算一格；新流程無法再建立第二個。
- 空格、空相本、照片完成未交件與交件後缺照片分別顯示。
- 12 格文字由全班填 11 格、每位學生個別補最後 1 格時文字完成；少一人未補時仍未完成。
- 班級停用後，目前校／部門主管仍可開歷史 Project；舊主管回 403。
- Project name 與班名不同、兩校同名班時仍正確分組。
- 離園孩子後期是 departed；新入園前期是 not_enrolled；真正缺相本是 no_album。
- 同孩子同期跨 Project 重複時 preview=duplicate，render/download 都跳過。
- 兩個並行補渲染只有一個成功啟動，完成後可再次啟動。
- migration 重跑無重複；有效 Project 全有 slot；封存待清除 Project 全為 NULL。
- 同孩子在 active 學期轉班後只留目標班；離園保留最後班；closed 後不可改寫。
- closed 學期中整期沒有 Project 的孩子仍顯示 `no_album`。
- 新學期 apply 任一步故障時，membership、老師、term 與 grid 全部 rollback。

## Non-Goals

- 自動合併或刪除 legacy 多 Project 的照片／文字內容。
- 恢復封存待清除、未歸班資料。
- 讓 Project owner 或 term teacher snapshot 取代園所 ACL。
- 跨園所、多法人或任意自訂 workflow engine。

## Open Questions

無。v1 以本契約直接實作；未來若需要學期中更細的學生在籍日 cutoff，另開
版本，不在本階段以姓名或 Project 建立時間推測。
