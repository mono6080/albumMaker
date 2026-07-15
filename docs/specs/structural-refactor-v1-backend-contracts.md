# 行為保持型結構重構 v1：後端契約附錄

> Owner：本附錄只擁有 structural-refactor-v1 的後端 transaction、lock、Storage path、module DAG、
> render fingerprint 與 template sync typed-state 契約。產品 API／資料契約仍由 `docs/dev/*.md` 擁有。

## Verdict

Decision：後端只能在 characterization tests 釘住現行順序後搬動 ownership；不能把「route 變短」當成
完成。相容 facade只保 import/call，不保 private monkeypatch seam；測試必須 patch真正 owner。

鎖縮寫：`T=template`、`P=sorted projects`、`S=sorted students`、`R=student render`。全為 process-local；
唯一全域順序是 `T → P → S`，`R`包住單一學生完整 render，但慢 render期間不持有P/S。

## Path and Storage Factory Contract

- `backend/app_paths.py` 在 import時依 `ALBUM_MAKER_UPLOADS_DIR`解析 `BACKEND_DIR/UPLOADS_DIR`，維持現況。
- `get_storage()` 以 module attribute或 getter讀 `app_paths.UPLOADS_DIR`；
  `monkeypatch(app_paths.UPLOADS_DIR)` 必須在下一次 factory call生效。
- `STORAGE_BACKEND`、`R2_*`、`PRODUCTION`維持 call-time解析。path/env cache key改變即建立新 adapter。
- `render_service.UPLOADS_DIR`只保 import compatibility，不是測試 patch seam；所有 tests改 patch owner。
- Storage facade不承諾 private symbol monkeypatch。新實作需要 storage時直接 import owner或顯式注入；
  tests不得假設 patch re-export會穿透。

## Module DAG and Lock Ownership

```text
app_paths ← storage factory/adapters
output_keys ← student_render_service ← project_service facade
             project_export_service ↗
label_texts ← project text/render services
roster_identity_service ← roster facade
semester_render_service → student_render_service
semester_export_service → output_keys/storage/zip
```

- 內部 module不得反向 import facade。`roster_service`、teacher overview與routers改 import真正 owner。
- `template_sync_locks`繼續擁有T/P registries；`student_pages`擁有S registry；
  `student_render_service`擁有R registry。新 use-case不得複製 registry或改排序規則。
- thumbnail／project-student preview／template preview GET雖會寫衍生 cache，但DB唯讀；cache寫失敗不得
  改主要回應。`suggest_material_text_box`仍是POST但DB/Storage嚴格唯讀。

## Render Fingerprint Contract

- 基線 `_render_pipeline_fingerprint()` 是 `8a8fab3a5aed60264619`。
- 拆 `layout_groups.py`／project render source會造成一次性 fingerprint改變，視為預期 cache invalidation。
- `_RENDER_PIPELINE_FILES` 必須列出所有實際影響 pixels/traversal/fingerprint normalization 的新 owner；
  facade本身不足。相同 source tree值穩定，任一 owner內容改變都必須改值。
- cache invalidation不得改 storage key格式、DB schema、HTTP header或重新渲染所得 pixels。

## Template Sync Typed State

新增但不更改 response shape：

- `TemplatePageDelta`：`page_id`及 added/removed photo/text canonical ID sets。
- `StudentSyncState`：`student` ORM、`raw_pages_json`、entries by page id、old indices、orphan entries。
- `ProjectSyncState`：`project` ORM、`raw_labels_json`、labels by page id、orphan labels、student states。
- `TemplateSyncImpact`：現行全部 count與`change_summary`，提供明確 `to_response_dict()`。
- `TemplateSyncPlan`：上述 states、old-page snapshot、change flags/hash/impact；外層已是dataclass不算完成。

鎖前 plan只供第一次 confirmation與 project/student IDs。`rollback()/expire_all()`後不得重用其中ORM；
拿到T/P/S後必須重新prepare，apply只用第二份 plan同 session的ORM。raw JSON、duplicate last-wins、orphans、
backup payload與change hash輸入逐值不變。等待鎖後資料改變必須回最新 confirmation，不可沿用舊 plan。

## Mutation Inventory

| Symbols | Target owner | Lock／commit／side effect contract | Required characterization |
|---|---|---|---|
| `create_project` | project lifecycle | T；rollback/expire/reload；單次commit，無Storage | create/roles |
| `rename_project` | project lifecycle | P內重查；commit後仍持P best-effort清舊 outputs；失敗仍200 | publish wait＋cleanup fail |
| `delete/complete/reopen_project` | project lifecycle | P內重查；各單次commit，complete鎖內判空 | archive/complete/reopen |
| `restore_project`／archive purge | project archive | P內重查；到期放鎖後purge；只刪Storage成功者再commit | 補多專案partial purge |
| `batch_add/copy_students` | student service | target P／sorted source+target P；全批單次commit | copy roster＋lock wait |
| `update_student` | student service | P→S；commit後持鎖清舊 output，失敗仍200 | rename/publish guards |
| `delete_student` | student service | P→S；commit→output cleanup→photo cleanup，P持到最後 | cleanup fail/ID reuse |
| project/student text、skip | content services | project為T→P；student為T→P→S；單次commit | revision/concurrency |
| `batch_update_texts` | content service | T→P，每位S且逐位commit，最後project commit；允許partial | 補第N位失敗pin |
| `upload_photo` | photo service | decode鎖外；T→P→S；Storage mutation後pages commit | 補DB commit失敗現況 |
| `update_photo_mapping` | photo service | T→P→S；commit前清無引用 bytes；交換先寫後清 | swap/foreign/revision |
| shared/batch photo | photo service | decode鎖外；T→P，每位S且逐位commit；batch單筆失敗續跑 | 補batch成功/skip/fail |
| comments | comment service | 無content lock；每次單次commit | comments/author transfer |
| single/all render | render services | R；capture P→S，publish P→S CAS；all逐位partial | 補all一位失敗續跑 |
| template create/copy | template lifecycle | 現況無T；copy assets後單次commit | 補copy Storage中途失敗 |
| template rename/delete | template lifecycle | 現況無T；delete commit後best-effort namespace cleanup | 補rename/delete cleanup |
| page snapshot＋legacy adapters | existing snapshot service | T→sorted P→sorted S；鎖前/內prepare；整體單次commit | 既有snapshot/sync suite |
| background upload | template asset service | decode鎖外；T→P→S；新key先put，DB失敗刪新key | stale zero-write＋commit fail |
| sticker upload | template asset service | 無鎖/DB；immutable content-version key put | immutable asset tests |
| period mutations | period service | 無鎖；單次commit/refresh | 補update period |
| user mutations/import/delete | user services | 無鎖；import有效列最後單次commit；delete整批單次commit | 補mixed import |
| roster link/merge | roster identity | 維持現況無P/S；單次commit | ambiguity/merge/orphan |
| missing-album job | semester render | thread自建Session；每位走R/P/S並允許partial | render missing/access |

Route 搬動前先補表中「補」項。新 deterministic gate只掃本表 audited routers：route內禁止
`db.commit/rollback/flush`、`get_storage()`及直接取得T/P/S/R；明列 preview/cache GET與現有
`render_all_students` HTTP orchestration例外。Service內的 transaction/lock仍由測試判定，不以grep代替。

Deprecated page fixture migration屬 Wave 3 backend tests：正式 helper改 snapshot API；legacy endpoints只留
一組 compatibility tests。同步失敗驗收用詞是 backup creation、transaction rollback與manual-rescue
payload；本 phase不宣稱不存在的自動 recovery。

## Acceptance

- Storage新增 factory/env/cache-key、memory→local→mirror hit order、put/move/delete/delete_prefix
  invalidation及Local/R2 EXIF transpose tests；真R2有credentials才是額外gate，skip不算staging驗收。
- 每列 mutation在搬動前後跑對應 characterization；新增route gate通過。
- facade consumer全案搜尋清零後才可刪 facade；private test seam搬到owner不視為產品破壞。
- template sync confirmation/hash/backup/rollback/manual-rescue payload、partial-success與鎖等待結果逐值不變。
