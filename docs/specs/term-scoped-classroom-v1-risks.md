# 學期範圍班級 v1 — 風險登錄與測試計畫

> Owns：本次重構的風險登錄、緩解決定、測試計畫與上線前檢查。
> 重構本身的範圍與契約見 [term-scoped-classroom-v1.md](term-scoped-classroom-v1.md)。

---

## 執行順序的硬前提

**名冊姓名更正必須先推上正式站跑完，再開始改名。**

`fix/roster-name-correction` 分支的 `correct_roster_names.py` 與
`fill_missing_album_names.py` 直接寫死 `roster_children`、`students` 表名。改名之後
這兩支腳本會壞，而它們要處理的 31 筆姓名、124 筆快照、28 筆稱呼是正式站等著要的
資料。順序顛倒就得先改腳本、再改回來，多一輪沒有必要的風險。

合併與部署的順序必須是：

1. `fix/roster-name-correction` 推上正式站並跑完兩支腳本。✅ **2026-08-01 完成**
2. 才合併 `refactor/term-scoped-classroom`。← 現在卡在這裡

顛倒的話，那兩支腳本會對著 `students`（現在是名冊表）與已不存在的 `roster_children`
下 SQL——不會靜默失敗，但正式站等著的姓名更正會卡住。

### 第 1 步的執行紀錄（2026-08-01）

`master` fast-forward 至 `5dc5c9c` → push → 正式站 `git pull` 並重建 image
（帶 `APP_BUILD_ID`）→ 備份 `album-maker-backup-20260731T190111Z` 建立並 verify
通過 → 依序執行兩支腳本。產物（原值備份與三校名單）在 image 的
`/app/backups/roster_correction_20260801/`，已取回
`D:\Downloads\相冊名冊對照\正式站_20260801\`。

| 步驟 | 結果 |
|------|------|
| `correct_roster_names.py --apply` 第一遍 | 名冊姓名 31 位、相本快照 123 筆、退回完成 11 本 |
| 同一支第二遍 | 相本稱呼 28 位 |
| 同一支第三遍 | 全 0，冪等確認 |
| `fill_missing_album_names.py --apply` | 補上 11 位（在籍 10 ＋ 已離園但仍被相本引用 1），留空 0 |
| 重跑確認 | 待補 0 位 |

**`correct_roster_names.py` 必須跑兩遍**——稱呼的判斷條件是「稱呼不再是姓名的一部分」，
姓名還沒改之前這個條件不成立，所以第一遍一定回報稱呼 0 位，要等姓名寫進去，第二遍
才看得到那 28 筆。2026-07-30 的本機演練也是分兩次執行，當時沒寫進文件。

與本機演練（2026-07-30 的副本）的差異：相本快照 123 vs 124、退回完成 11 vs 9。原因是
副本停在 7/30 15:35，之後老師在正式站又完成了幾本相本。姓名 31 筆與稱呼 28 筆兩邊
完全一致。

**那兩支腳本現在的處境**與 `migrate_production_organization_202607.py` 相同：只能當
稽核紀錄，不可再對現行資料庫執行。

上線影響：11 本已完成的相本被退回「製作中」，老師需重新確認後再標完成——這是刻意的，
姓名或稱呼改了就代表印出來的字會變。

### 115 上編班的做法比較（2026-08-01 實測）

問題：整批換班時，把舊班**改名**成新班名（學生原地不動）會不會比一班一班**搬**快？

在同一份正式副本上各跑一次完整編班再比對結果：

| | 搬移法 | 改名法 |
|---|---|---|
| 新增班級 | 6 | 11 |
| 改名 | 0 | 12 |
| 移除班級 | 7 | 12 |
| 移除前要先清老師 | 7 | 12 |
| 換班拖曳組數 | 49 | 37 |
| **動作合計** | **69** | **84** |

**結論：改名法不會比較快**，反而多 15 個動作。原因是這所幼兒園每個階別名稱**每年都被
下一屆重用**——把「八階A」改名成「九階A」之後，還是得重建一個「八階A」給銜接班的孩子
進來，一次改名只省下一組拖曳，卻多出「移除擋名字的班」＋「重建原名的班」＋「清老師」。

而且改名有**嚴格的相依順序**：`八階A→九階A` 要等九階A 讓出名字、`九階A→十階A` 要等
十階A 讓出，而十階A 要先把畢業生標成離園、清掉老師、移除，整條鏈才動得了。實測 16 個
可一對一改名的班只成功 12 個；剩下 4 個是安平校 `一二階A→三階A→四階A→五階A→六階A`
這條鏈，鏈頭的六階A 要拆成七階A／B（不是一對一），必須先被拖空移除，整條鏈才解得開。

**兩種做法產出的資料完全相同**：班級（含部門）37、在籍名單 378、老師編制 47、工作格
37、既有相本 90 本，逐筆比對一字不差。唯一差別是班級的**顯示順序**——改名法的班沿用
原班的 `sort_order`，排出來的先後不同，集合相同。

跨部門的改名是禁區，理由見
[known-issues.md](../dev/known-issues.md#編班的操作缺口2026-08-01-照行政系統實地演練-115-上時發現)。

---

## 風險登錄

風險依「會不會靜默失敗」排序——會報錯的比較安全，不報錯的才危險。

### R1 渲染指紋失效，468 位學生的輸出全部重渲染

`_render_pipeline_fingerprint` 雜湊 13 個渲染來源檔的**檔名與內容**。改名會動到
`render_service.py` 與 `student_render_service.py`，指紋必然改變，所有
`.render_state` 對不上，啟動收斂掃描會把 468 份既有輸出判定為過期並重渲染，覆寫
R2 上的檔案。

輸出位元不會變（純改名不改繪圖邏輯），但系統無從得知。

**緩解**：改動前後各跑一次
`scripts/verify_render_output_unchanged.py`，用實際位元證明輸出相同；確認後**刻意
排程**收斂，而不是讓它在部署當下突襲正式站。不採用「把指紋 pin 回舊值」——那會讓
同一批 commit 裡真正的渲染改動也一併被略過。

**保證**：`test_render_pipeline_fingerprint_covers_exactly_the_declared_sources`
釘住涵蓋範圍（多一個或少一個檔案都會讓失效判斷從此不準）。

**實測（2026-07-31）**：
- 結構改動與改名 A／B 的指紋**沒變**（`1eac035bd357a81d8e57`）——它們沒動到那 13 個
  來源檔。
- 改名 C 的指紋變了：`1eac035bd357a81d8e57` → `15447fe7671bc91ee6cf`（`Student` →
  `ProjectStudent` 動到 `render_service.py` 與 `student_render_service.py`）。
- 5 個 case 的輸出**位元完全相同**。也就是 468 份既有輸出會被判定過期，但重渲染不會
  改變任何人看到的相本——所以要刻意排在離峰時段跑，而不是讓它在部署當下突襲。

### R4 `ALTER TABLE RENAME` 的參照改寫靜默失效

SQLite 只有 3.25 以上才會改寫 trigger 與 view 內的表名參照；其他表的
`REFERENCES` 子句則要 `foreign_keys=ON` 才會跟著改。任一條不成立時**不會報錯**，
只會留下指向舊表名的 FK 與 trigger。

本機 SQLite 3.45.3、`database.py` 每條連線都設 `foreign_keys=ON`、
`legacy_alter_table` 預設 0——三項都成立，但這是環境事實，不是程式保證。

**保證**：`test_sqlite_can_rewrite_references_on_table_rename` 斷言版本與 pragma；
`test_table_rename_rewrites_foreign_keys_and_triggers` 實際做一次改名驗證行為，不
只相信版本號。migration 開頭同樣斷言，容器環境不符就中止而不是照做。

### R6 權限矩陣靜默改變

`OrganizationReadScope` 改為持有學期班級 id 之後，四個權限旗標
（`can_read` / `can_edit` / `can_reopen` / `can_comment`）任一算錯都不會有錯誤訊息，
只會有人看不到自己的相本，或看到不該看的。

**保證**：`test_project_acl_lifecycle.py`（9 個 test）與
`test_organization_supervisors.py`（4 個）走 API 斷言完整權限 dict，重構後必須**一字
不改**通過。任何一個要改才過，就代表行為變了，必須先解釋清楚。

### R8 Storage key 被順手改掉

key 由 `project_id` / `student_id` 整數推導，與表名無關。但改名時把
`students/student{id}` 這段字面值一起換掉，16,126 張照片與 468 份輸出會全部定位
不到——而且是 404 而不是例外，看起來像「檔案不見了」。

**保證**：`test_storage_keys_are_derived_from_ids_not_model_names` 釘住五種 key 的
完整字串。

### R2 `projects.classroom_id` 被 trigger 擋住而無法 DROP

`classroom_id` 被 4 個 trigger 參照，SQLite 拒絕 `ALTER TABLE DROP COLUMN`。這個會
**報錯**，但錯在 `run_migrations()` 裡，而它在 lifespan 中執行——正式站會啟動失敗。

**緩解**：migration 先 drop trigger 再 drop 欄位。
**保證**：`test_dropping_a_column_referenced_by_trigger_is_rejected` 釘住 SQLite 的
實際行為，讓步驟順序有依據而不是「保險起見」；legacy 升級測試走完整順序。

### R3 表名改動打斷歷史 migration

`migrations.py` 有 82 處寫死 `students`。策略見
[主規格的 migration 策略](term-scoped-classroom-v1.md#表名改動的-migration-策略)。

**保證**：`test_migrations.py` 的 3 個 test 覆蓋冪等、legacy 非空資料庫升級、以及
中斷後的欄位重建；改名後全新資料庫與 legacy 資料庫兩條路徑都必須通過。

### R9 8 支正式腳本寫死表名

`audit_production_migration_202607.py`(38)、
`migrate_production_organization_202607.py`(46)、`repair_project_203.py`(16)、
`check_backend_route_boundaries.py`(8)、`suggest_student_album_names.py`(4)、
`audit_text_overflow.py`(2)、`snapshot_production_r2_outputs_202607.py`(2)、
`rerender_production_projects_202607.py`(1)，共 117 處。加上待推正式站的兩支名冊
腳本。

一次性遷移腳本（`*_202607.py`）是**歷史紀錄**，對應的是當時的 schema；它們不該被
改寫成新表名，而該明確標記為只適用於改名前的資料庫。仍在用的
（`check_backend_route_boundaries.py`、`suggest_student_album_names.py`、
`audit_text_overflow.py`）必須同 commit 改。

已處理：`migrate_production_organization_202607.py` 已在檔頭標記退場（只供稽核，不可
對現行資料庫執行），其測試一併移除——它建的是舊結構，留著只會擋住新結構的 migration。

### R5 編班草稿的 source_fingerprint 失效

`compute_organization_source_fingerprint` 把 `classroom_id` 寫進雜湊來源。改成學期
班級 id 之後，既有草稿的 fingerprint 對不上，套用時會報「來源已變更」。目前有 1 筆
draft（id=2「123」）、1 筆 cancelled。

**緩解**：migration 一併取消既有 draft，並在上線說明裡寫明要重建。

### R7 API 路徑改名讓已開著的分頁 404

PWA 的 Service Worker 對 `/api/` 是 `NetworkOnly`（`vite.config.js` 已確認），不會
快取舊回應。但部署當下**已開著的分頁**跑的是舊 JS，會呼叫 `/students/`。

**緩解**：重新整理即可。不保留舊路徑別名——那會留下永久的技術債，而這個 App 的
使用者是園所內部老師，可以直接通知。

### R11 已結束學期的殘留 active 編制修不回來

closed 學期的名冊與編制有 trigger 擋下 INSERT／UPDATE／DELETE。這保護了歷史資料，
但也代表**萬一有一筆 `ended_at IS NULL` 殘留在已結束的學期**，一般 API 修不掉它——
而 `_assert_active_rows_belong_to_active_structure` 會用它擋住之後每一次建草稿，
錯誤訊息還指向一個使用者根本沒動過的班。

這不是假設：套用編班原本只結束「有學生的班」的老師，空班的老師就是這樣留下來的
（2026-07-31 由 e2e 抓到，已修，並由
`test_apply_ends_teachers_of_classrooms_without_students` 釘住）。

**若真的發生**：只能直接對資料庫補上 `ended_at`，或暫時把該學期改回 active 再從
API 結束編制。兩者都要人工介入並留紀錄。

### R10 migration 失敗導致正式站啟動不起來

`run_migrations()` 在 lifespan 中執行，拋例外就起不來。

**緩解**：上線前依 [deployment.md](../dev/deployment.md) 先建立備份，並先在正式資料
的快照上完整跑一次 migration 與 pytest。

---

## 查證後排除的風險

### Django `auth_permission` / `content_type` 的類比：不存在

Django 把權限列綁在 `content_type(app_label, model)` 上，所以搬 model 會讓權限指向
不存在的身分。這個 stack 沒有對應物：授權完全由 runtime 從
`users.role`（字串）與 `classroom_teacher_assignments` /
`organization_supervisor_assignments`（整數 FK）算出來，沒有任何一張表把 model 名或
表名當資料存。程式碼中的 `content_type` 只出現在檔案上傳的 MIME 檢查。

**保證**：`test_authorization_tables_do_not_store_model_identity` 掃四張授權表的欄
位名，出現 `content_type` / `model_name` / `app_label` / `table_name` 之類就紅燈——
確保之後也不會有人把這種欄位加進來。

### 沒有 migration 狀態表

不像 Django 的 `django_migrations`，這裡的 migration 靠 `PRAGMA` 檢查現況決定要不要
做，沒有記錄「已套用到第幾版」的列可以失準。代價是順序完全靠 `run_migrations()` 裡
的呼叫順序，好處是沒有狀態可以對不上。

### 把名稱當資料存的兩個欄位：不受影響

`template_page_layout_migration_backups.migration_name`（值是
`photo_slot_content_box_v1` 這類遷移代號）與
`term_reclassification_plans.scope_key`（值固定 `organization`）都不是 model 身分，
改名不影響。

---

## 測試計畫

### 已就位：行為釘樁

`tests/test_term_scoped_classroom_contract.py`（6 個 test）——重構前後都必須原封不動
通過，涵蓋 R1、R2、R4、R8、R9 的靜默失敗面。

### 已就位：必須一字不改通過的既有測試

| 檔案 | test 數 | 守住什麼 |
|------|--------:|----------|
| `test_project_acl_lifecycle.py` | 9 | 完整權限矩陣、帳號生命週期、調班後的讀寫分離 |
| `test_organization.py` | 13 | 園所設定、班級、名單、老師編制 |
| `test_organization_supervisors.py` | 4 | 主管 scope |
| `test_organization_term.py` | 6 | 編班計畫的建立、驗證、套用、取消 |
| `test_semester_reporting.py` | 13 | 學期快照、老師進度、彙整匯出 |
| `test_organization_schema_migrations.py` | 15 | 組織 schema migration |
| `test_migrations.py` | 3 | 冪等、legacy 升級、中斷復原 |
| `test_backend_route_boundaries.py` | 15 | 路由註冊表 |
| `test_render_regression.py` | 19 | 渲染輸出 |
| `test_roster.py` | 19 | 名冊 |

route boundary 與 roster 兩份會因為 API 路徑改名而需要更新——那是預期內的契約改動，
更新時必須是「路徑字串換掉」，不得順手改斷言。

### 實際改動的既有測試與理由

上表的「一字不改」標準守住了權限矩陣（`test_project_acl_lifecycle.py`、
`test_organization_supervisors.py` 的斷言未動）。以下測試改了，每一項都是**語意本身**
改變而非實作走樣，記在這裡供上線前覆核：

| 測試 | 舊斷言 | 新語意 |
|------|--------|--------|
| `test_supervisor_reporting_uses_union_of_organization_scopes_only` | 老師快照凍結，中途換老師後報表仍只列原老師 | 班只活一個學期，掛在班上的指派都屬於這個學期；報表列出全部並以 `ended_at` 分辨現任 |
| `test_closed_term_export_follows_roster_name_correction`（原名 `..._uses_term_student_name_snapshot_...`）| 已結束學期顯示當時姓名 | 名冊姓名是唯一真相，更正後歷史學期也顯示新名；凍結的是 `Student.name` 與已渲染輸出 |
| `test_closed_term_does_not_seed_children_from_current_roster` | 加人成功但快照不受影響 | 已結束學期的班直接拒絕加人（409） |
| `test_active_term_roster_tracks_final_placement_and_closed_term_freezes` | 快照表 trigger 擋改寫 | 名冊 live 表的 trigger 接手同一個保證 |
| `test_current_supervisor_reads_historical_snapshot_after_campus_rename`（原名 `..._after_classroom_move`）| 班級搬分校後主管仍讀得到 | 班級的分校不可變更；快照與現況的分歧改由分校改名產生 |
| `test_term_plan_*`（4 個）| 計畫的班級 id 是目前學期的班 | 計畫的班一律是目標學期新建的班；`stay`／人數／老師 diff 靠 scope 對應 |
| `test_term_plan_rejects_active_rows_under_inactive_organization_structure` | 班級 `is_active = False` | 班級沒有停用旗標，等價異常是班級落在已結束學期卻還有在籍學生 |
| `test_interrupted_bubble_drop_preserves_modern_project_schema_and_relations` | 重建後 ledger trigger 要回來 | 該 trigger 隨歸班流程退場，改驗兩個相本凍結 trigger |

### 各 slice 要新增的測試

| Slice | 新增測試 | 狀態 |
|-------|----------|------|
| 1 schema／migration | 前提驗證五項各自失敗時中止；搬遷後逐筆等價；trigger 順序；冪等重跑 0 筆 | 冪等與 legacy 升級由 `test_migrations.py` 覆蓋；**前提驗證各自失敗時中止尚未有測試** |
| 2–4 改名 | 全新資料庫與 legacy 資料庫兩條路徑；改名後 FK 與 trigger 指向新表名 | 兩條路徑以 schema 比對驗過（表／索引／trigger 完全一致），且 `test_migrations.py` 會擋下差異 |
| 5 scope／權限 | 同名班級跨兩學期各自只讀得到自己那學期；學期中途接手的老師讀得到本學期較早的相本 | ✅ `test_same_class_name_across_semesters_keeps_each_cohort_separate`、`test_teacher_assigned_mid_semester_reads_albums_created_before_arrival` |
| 7 編班 | 新生可直接放進計畫；套用後名單與編制落在新學期班級 | 後半由 `test_term_plan_applies_students_and_teachers_without_rewriting_old_project` 覆蓋；**「新生可直接放進計畫」尚未有測試** |

### 尚未關閉的測試缺口

- 編班計畫還不支援把新生（沒有來源 membership）直接放進去。班級結構本身已可在
  草稿裡增減（`POST /classrooms` 帶 `semester_id`、`DELETE /classrooms/{id}`）。

已補上（2026-08-01）：

- 破壞性搬遷的三項前提各自有中止測試（快照漂移、相本班級不一致、缺工作格），
  另有一個原子性測試釘住「中途失敗不留下半套結構」。
- 「升級後 vs 全新資料庫 schema 一致」已是 pytest 防線，比對涵蓋欄位型別、nullable、
  預設值、外鍵 ON DELETE、索引唯一性與 partial 條件，以及 trigger 定義；`scripts/compare_database_schema.py`
  供上線當天對正式資料副本使用。
- Playwright e2e 已執行（chromium 全綠）。webkit 在本機偶發逾時，每輪失敗的測試不同
  且單獨重跑均通過，含與本重構無關的 template-editor。

### 渲染輸出位元比對

```bash
python scripts/verify_render_output_unchanged.py --out before.json   # 動手前
python scripts/verify_render_output_unchanged.py --out after.json    # 改完後
python scripts/verify_render_output_unchanged.py --compare before.json after.json
```

比對 5 個 case 的 `render_page` 輸出位元（不是 PDF——PDF 容器含時間戳，本來就不會
相同）。任何一個 case 不同就代表這不是純改名，必須查清楚才能往下走。

---

## 上線前檢查清單

1. 名冊姓名更正已在正式站執行完畢，`fix/roster-name-correction` 已合併
   （見執行順序的硬前提）✅ 2026-08-01
2. 正式站備份已建立並 verify 通過
3. 在正式資料快照上跑過完整 migration，且重跑第二次為 0 筆 ✅ 2026-07-31
4. 完整 pytest 通過 ✅ 2026-08-01（579 passed / 2 skipped），且在升級後的正式資料
   副本上跑過 `scripts/smoke_upgraded_production_copy.py` ✅ 2026-08-01
   （admin 與真實在職老師各掃 16 條無參數 GET ＋ 25 條明細路徑，無 5xx；38 個班
   不重複、都掛在學期上、465 位在籍）
4b. 在正式資料副本上跑過 `scripts/dry_run_term_reclassification.py --db <副本> --apply`
   （實際套用一次
   編班：關閉舊學期、結束全部名冊與編制、建立新學期的班與工作格）
   ✅ 2026-08-04 重跑（資料為當天重抓的正式快照）：38 班 / 465 位在籍 / 52 筆編制
   全數轉移，103 本相本的快照與學生名單完全未變，**未完成**的舊相本老師仍可製作
   （2026-08-03 起的新契約，見 term-scoped-classroom-v1.md 的製作權決定）

   `projects` 列數由 7/31 的 146 降到 8/4 的 103 不是資料遺失，減少的全是封存到期由
   `purge_expired_archived_projects` 真刪的軟刪列（已軟刪 57 → 13）。**實際存在的相本
   一直是 90 本**（7/31 為 89，8/1 新增 1 本後未再變動）。核對本數時要扣掉軟刪列，
   否則會把正常的封存清理讀成資料遺失。
4c. 在正式資料副本上跑過**真實的 115 上編班**（不是 `dry_run_term_reclassification.py`
   的合成計畫——那份把 38 班原封不動搬過去，驗的是機制，不是實際的班級重組）
   ✅ 2026-08-04，基準日取編班當天：

   | | |
   |---|---|
   | 班級 | 沿用 32、新建 5、移除 6 → **37** |
   | 學生 | 續讀 379（換班 366）、離園 86、新生 44 → **在籍 423** |
   | 編制 | **49 筆**，全部有帳號（先補建 2 個） |
   | 逐筆對回行政系統 | 班級集合、每班部門、每位學生的班、編制 **全部一致** |
   | 舊相本 | 90 本的欄位與學生名單 **一位元未變** |
   | 工作格 | 37 班全部都有 |
   | 舊學期 | 在籍 0、在職編制 0 |
   | 外鍵／integrity | 無違規／ok |
   | 編班後的漂移 | **0 筆**（新生連學號一起編入，不需要事後回填） |

5. `verify_render_output_unchanged.py` 比對通過 ✅ 2026-07-31（指紋變、位元相同，見 R1）
6. 容器內 SQLite 版本 ≥ 3.25（migration 會自行斷言，但先確認避免部署中途失敗）
7. 收斂重渲染已排程在離峰時段，且已知會跑約 468 份
8. 已通知老師：部署後請重新整理頁面；既有編班草稿需重建
9. **編班基準日已決定**。上游的入班日是逐日到期的，基準日直接決定編進去幾個人：
   以 115 上開學日（2026-08-01）為準是 402 位、37 班、48 筆編制；以 2026-08-04 為準
   已是 **423 位、49 筆編制**（開學後三天有 21 位孩子的入班日到期）。晚編一天就多
   一批人，沒選定基準日就無法核對編出來的結果對不對
10. **編制名單裡的老師都有帳號**。以 8/1 為基準缺 1 位（DN0037017 陳紀原，湖美校／
   四階A）；以 8/4 為基準再多 1 位（DN0037024 李依諠，湖美校／七階A）。沒有帳號的
   老師編制編不進去
11. **正式站已存在一個 `status='cancelled'` 的「115上」學期**（id=2，2026-08-01 ~
   2027-01-31），是先前試建留下的。建立本次期別前先確認要沿用還是另建，避免出現兩個
   同名學期
12. **編班時新生要連學號一起輸入**（格式「姓名 學號」，可從行政系統的表格整欄複製）。
   學號是名冊同步唯一的孩子對應鍵，沒有的話這批孩子永遠對不到上游；看板會把沒有學號
   的卡片標成「新·無學號」。契約見
   [websystem-roster-sync-v1 的手動編入的孩子一定要帶學號](websystem-roster-sync-v1.md#手動編入的孩子一定要帶學號2026-08-04-演練發現並修掉)。

   編班套用後跑一次 `scripts/report_websystem_drift.py` 確認漂移為 0。若有漏掉學號的，
   用 `scripts/backfill_new_student_serials.py --db <db> --upstream <快照> --as-of <基準日> --apply`
   補回去再驗一次

第 3 項的驗證方式是把正式資料副本升級後，與 `init_db()` 建出的全新資料庫逐項比對表
欄位、索引與 trigger；2026-07-31 的結果是三者完全一致。

第 4 項原本寫的是「在正式資料快照上跑過完整 pytest」，但那件事做不出意義：pytest 的
斷言是對著 `conftest.py` 建出的隔離資料庫寫的，把 `DATABASE_URL` 指向正式資料只會得到
一堆與程式碼無關的失敗。真正沒被其他項目覆蓋的是「升級後的正式資料，app 讀不讀得動」
——schema 對了不代表序列化、權限判斷與報表撐得住正式資料的形狀，所以改由
`smoke_upgraded_production_copy.py` 驗這一段。
