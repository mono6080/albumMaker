# 測試與驗證

> Owns：測試指令、測試防線現況、agent 修改後的驗證流程。
> CI 在 `.github/workflows/tests.yml`，push / PR 時跑同一組 gate。

---

## 指令總覽

```bash
# 後端（repo 根目錄）
python -m pytest -q
python -m ruff check backend tests
python -m mypy backend tests
python scripts/check_banned_patterns.py   # 唯一入口繞道禁令（CI 也會跑）
python scripts/check_backend_route_boundaries.py  # 路由／service 邊界（CI；96 routes、零債務）

# 前端
cd frontend
npm run lint
npm run test:unit            # 自製 node runner 單元測試
npm run test:render-parity   # 前後端渲染一致性（見 rendering.md）
npm run test:e2e             # 乾淨 Playwright run（自起 e2e 後端與 Vite）
npm run build                # production bundle（改前端後必跑）
npm run test:bundle-budget   # build 後驗首包嚴格低於重構基準
```

## 測試防線現況

- **後端 pytest**（`tests/`）：
  - `test_auth.py`、`test_migrations.py`（驗證 init_db + run_migrations 可重複執行）、
    `test_storage.py`（含 traversal shared-prefix regression）、
    `test_project_service.py`、`test_roster.py`（園所目前名單的穩定孩子身分、未歸班 provisional
    identity 不進學期匯出、匯出只讀契約與 ZIP、
    專案全班完成鎖定/退回與空專案不可完成）
  - `test_api_smoke.py`：TestClient 覆蓋 health、login/logout cookie roundtrip、
    模板／專案 CRUD、學生快照／相本稱呼、對應文字、留言角色、照片上傳/mapping、預覽、渲染、
    PDF / ZIP 下載；每個 TestClient context 會 reset slowapi limiter state
  - `test_api_edges.py`：401/404/413/415/422、storage missing、render failure、
    照片互換、corrupt JSON、角色矩陣負向案例
  - `test_render_regression.py`：固定版型 `tests/fixtures/render_smoke_layout.json`
    的寬鬆像素區域檢查
  - `test_render_image_loader.py`：背景、貼圖、素材文字框分析在 RGB / RGBA / ICC
    轉換前已縮到實際輸出需求；超額非 JPEG 只讀 header 就拒絕，且小 bytes／大像素
    的學生 JPEG 仍會強制正規化到 3600px 長邊
  - `test_photo_thumbnail_bounds.py`：照片縮圖 cache miss 在色彩轉換前 bounded decode；
    超額非 JPEG 不配置像素、同 key 只生成一次，不同尺寸共用照片重工作槽
  - `test_contract_pins.py` / `test_font_parity.py`：前後端契約釘——
    design tokens 兩端一致、insets 演算法釘值、字型清單對應
    （防跨語言鏡像靜默漂移，規則見 [conventions.md](conventions.md#跨模組-invariants)）
  - `conftest.py` 把測試 DB 指到 repo 內 `.tmp/pytest`
    （可用 `ALBUM_MAKER_TEST_TMPDIR` 覆寫），不污染 `backend/album_maker.db`
  - `test_layout_groups.py`：v1/v2 group schema、safe canonical refs、任意深度 traversal、cycle 與
    malformed topology/link fallback
  - `test_material_text_box.py`：素材分析授權、namespace/revision、零寫入與 normalized box 契約
  - `test_material_text_link_backfill.py` / `test_linked_material_text_box_reset.py`：
    effective traversal、v1/v2 link 相容、CSV formula safety、review gate、唯一備份與多模板 partial manifest
  - `test_data_script_manifest_inspection.py`：manifest fsync/atomic replace 與 crash-gap
    revision/layout-hash reconciliation
  - `test_production_r2_snapshot_script.py`：正式 R2 scope 推導、私有 bytes/blob SHA-256、
    全 bucket 範圍外 drift gate、空 prefix 與 partial restore 的可重入契約
  - `test_photo_upload_identity.py`：單張／批次照片在鎖外解碼期間遇外部 migration 替換
    學生快照或 SQLite ID 重用時，鎖內身份 CAS 回 409，且替代學生與同批其他學生皆零寫入
  - `test_backend_failure_contracts.py` / `test_user_transaction_contracts.py`：storage／DB 失敗與
    使用者批次匯入、刪除的 transaction 邊界
  - `test_student_input_limits.py`：班級目前名單的姓名、中央相本稱呼、單批與總量上限，
    以及已歸班 Project Student 不接受相本內稱呼 mutation
    （數值見 [api.md 的園所端點](api.md#園所管理-apiorganization)）
  - `test_student_album_name.py`：`RosterChild.album_name` 單一來源、名冊建立與園所設定單筆／
    整班保守自動推導、跨目前班級與既有相本的 fixed-point 碰撞、舊 Student 值忽略與輸出失效契約
  - `test_student_album_name_candidates.py`：未歸班 legacy 相本稱呼候選的保守規則、碰撞／完成專案
    review flag、報告 hash、全量 preflight、crash reconciliation 與同 manifest apply 鎖
  - `test_organization.py` / `test_organization_schema_migrations.py`：分校／班級學生與老師
    區間、校／部門主管、fresh legacy Student link 保持 NULL、姓名推定 link 不在 startup
    自動拆合、class-backed identity anomaly（含封存相本）整本隔離與 append-only audit、
    identity resolution ledger／freeze trigger、名冊稱呼的既有／未來 Project 共用 authority、
    舊 editor 結束、schema constraint 與 migration 冪等
  - `test_organization_project_migration.py`：歸班 preview 零寫入且不按姓名預選、decision 集合
    必須完整、`source_fingerprint` stale 與 `confirmed_all` gate、`existing` 只收 established
    identity、同名候選的校／部門／班級、membership active／ended 與歷史相本期別 evidence、
    `create_new` 不 preserve provisional、seed all-or-none，以及兩層 ledger／Student link／
    membership／Project snapshot 的單一 transaction rollback
  - `test_organization_term.py`：編班完整目標、revision/fingerprint、validate 零寫入、
    stale/invalid rollback、同時間原子套用，以及既有 Project/Student/ACL invariant
  - `test_project_acl_lifecycle.py`：目前班級老師與校／部門主管 object policy、owner 不授權、
    未歸班 admin-only、generic create route 不存在、歷史 editor 不進 response／生命週期、
    角色停權與刪帳 audited cleanup
  - `test_backend_route_boundaries.py` + `scripts/check_backend_route_boundaries.py`：完整掃描
    `backend/routers/**/*.py` 的 route inventory，禁止新路由把 commit、storage mutation 或重業務邏輯
    留在 HTTP adapter；包含跨檔 router-local helper／alias／re-export 的 adversarial case，
    `EXPECTED_DEBT` 為空，新增任何債務都直接失敗
  - `test_template_sync_typed_contracts.py`：duplicate last-wins、orphans、raw JSON、完整 impact/hash、
    結構備份 payload 與 render fingerprint owner／穩定性
  - `test_roster_module_boundaries.py`：identity／semester render／semester export 單向 DAG、facade exports；
    `test_roster.py` 另釘補渲染 partial-success 與 ZIP／manifest 行為
- **前端**：lint / unit / render-parity / Playwright E2E；render-parity 的文字防線會以
  同源 production bundled font（Chromium WOFF2／Pillow TTF）比較排版與
  local-frame raster；
  無 vitest / RTL 元件測試。
  `tests/unit/editor-fonts.test.mjs` 以可控 timer／FontFaceSet 釘住永久 pending timeout、
  快速失敗、失敗 attempt cache 與明確 retry generation；TemplateEditor E2E 另驗
  非編輯器 route 不載字型、terminal FontFace error 以 reload 恢復。
  `tests/e2e/illustrator-groups.spec.js` 在 Chromium/WebKit 覆蓋通用／巢狀群組、逐層 isolation、marquee、
  Ctrl/Cmd+G、固定 typography、isolation 內 undo，以及分析建立／重設普通文字框、不改 topology、
  invalid-link 修復與跨頁 stale response guard。
  `tests/e2e/organization-management.spec.js` 覆蓋校／部門主管、老師編制、班級相本，以及
  舊相本 preview 後逐位 explicit identity decision、空班全量 seed、跨期沿用 established id、
  新學期學生／老師差異與 teacher 班級導向工作流中不存在通用建立入口；歸班 UI 預設未決定，
  不得自動套用同名候選。`organization-migration-wizard.spec.js` 另驗證同名既有候選顯示
  校／部門／班級、名單狀態與歷史相本期別，並以這些來源區分同名不同人。
  `tests/unit/photo-save.test.mjs` 覆蓋照片 single-flight、stale response、revision pause/resume 與卸載重掛；
  `tests/e2e/student-photos.spec.js` 驗證延遲上傳期間繼續移動仍收斂到最後狀態，
  `tests/e2e/template-editor-mobile.spec.js` 驗證 pinch 不重 render 畫布父層且不污染 dirty/undo/save。
  `tests/e2e/preview-switching.spec.js` 以注入慢渲染模擬正式環境，驗證快速切頁
  再切回原頁時預覽不會卡住不渲染（守 PagePreview 元素重用與 pending watchdog）。
  `scripts/check_frontend_bundle_budget.mjs` 從實際 `index.html` import graph 找本次 active chunks，
  防止 lazy routes 退回首包；外部 lane build 目錄即使殘留舊 hash chunk 也不會誤判。
- **pre-commit**：`.pre-commit-config.yaml`（ruff check/format + mypy）；
  是否已在本機 install 不由 repo 保證
- `pyproject.toml` 關閉 pytest cache provider（本 repo 的 Windows ACL 對
  `.pytest_cache` 不穩）

## Playwright 反覆開發模式

反覆跑單一 e2e 測試時，先常駐 e2e 專用後端與 Vite，再用 reuse 模式：

```bash
cd frontend
npm run dev:e2e                          # 常駐：隔離 .tmp/e2e DB + 固定 e2e admin 密碼
npm run test:e2e:reuse -- -g multi-select
```

`test:e2e:reuse` 會略過 Playwright 的 `webServer` 啟動；**只在 `dev:e2e`
已常駐時使用**。

## 資料修復腳本 runbook

資料腳本都從 repo 根目錄執行，預設只讀資料庫並把 CSV 寫到被 git 忽略的
`output/`：

```bash
python scripts/backfill_material_text_links.py
python scripts/reset_linked_material_text_boxes.py
python scripts/audit_text_overflow.py --scope active --mode print
python scripts/suggest_student_album_names.py --scope active
```

### 2026-07 正式園所與 Project 203 一次性遷移

完整命令、人工 gate、rollback 與證據留存見
[2026-07 正式切換 runbook](production-cutover-202607.md)。舊標題保留為連結，
避免值班人員誤用本檔過時的片段命令。

相本稱呼腳本只對**未歸班 legacy Project** 中 `Student.album_name IS NULL` 的學生產生候選；
已歸班相本改由園所設定的 `RosterChild.album_name` 管理，報告產生會排除，apply 前若相本
已被歸班也會整批阻擋。新學生規則見
[data-model.md 的相本稱呼](data-model.md#相本稱呼與姓名變數)。
純漢字二至三字姓名可列候選；單字、四字以上與混合姓名保持未設定並列人工
處理。同專案候選碰撞、已知複姓候選與已完成專案會寫入 review flag。套用只能使用原始
報告 hash 與 manifest 保存的固定計畫；若有 flag 還必須帶同一份 plan hash：

```bash
python scripts/suggest_student_album_names.py \
  --apply-reviewed-manifest output/student-album-name-candidates-<run_id>.manifest.json \
  --acknowledge-rendering-stopped \
  --acknowledge-review-flags <review_plan_sha256>
```

執行 apply 前必須先進入 maintenance window：停止後端與所有渲染 worker，確認不再有新
render 後才可帶 `--acknowledge-rendering-stopped`，並維持停止狀態直到命令結束。套用會在
單一 SQLite write transaction 內重驗學生 identity、完整姓名、專案封存／完成狀態與相本
稱呼仍為空；任一漂移整批零寫入。完整 cleanup plan 會在 DB commit 前先原子寫入同一份
manifest，成功時清除 `output_filename` 並 best-effort 移除舊 canonical 輸出，讓下次下載
必須先以新稱呼重渲染。

若程序中斷，保持 maintenance window，直接用**同一份 manifest**與相同 acknowledgement
重跑。腳本會把 DB 判成整批 `not_applied`（重做唯一一次 transaction）、整批 `applied`
（跳過 DB mutation，只續做 cleanup），或 `mixed`／`diverged`（阻擋並要求人工核對）。
`complete_with_cleanup_errors` 也用同一命令重試；只會重跑可重入的輸出 cleanup，不會再次
更新學生。manifest 的 report／review plan／cleanup plan SHA-256 都必須吻合。同一份
manifest 的 apply 會以跨程序鎖序列化到 cleanup 與最終狀態完成；第二個誤啟的命令會等待
前一個命令釋放鎖，再重讀最新 manifest，不會並行清除輸出或覆寫較新的 crash 狀態。

- `--report`、`--detail-report`、`--summary-report` 都是檔名基底；實際產物會自動加
  `-<run_id>`，同一次 overflow 的明細／彙總使用相同 run id。已存在的 run 直接拒絕，
  不覆寫 CSV，也不會因 Excel 鎖住舊報告而讓新 run 失敗。
- backfill 要寫入時以新的 run 加 `--apply`。reset 禁止直接 `--apply` 或重新分析後
  force 套用；先執行 dry-run，人工核對帶相同 plan hash 的 CSV 與 manifest，再套用：

  ```bash
  python scripts/reset_linked_material_text_boxes.py \
    --apply-reviewed-manifest output/material-text-box-reset-report-<run_id>.manifest.json
  ```

  manifest 若列出 `review_flag`，還必須加
  `--acknowledge-review-flags <review_plan_sha256>`，明確接受同一份已審計畫。
  apply 只讀 manifest 保存的文字框幾何 patch，不重新呼叫圖片分析；plan hash、資料庫路徑、
  原報告內容 SHA-256、所有 template revision/page IDs 與**每一頁**原始 layout hash 任一不符，
  都在任何資料庫或備份寫入前阻擋。manifest 只保存重建幾何所需 patch 與原始／計畫 hash，
  不重複保存完整模板文字。
- 每次執行都有唯一 `run_id`，CSV 也包含此欄。apply 會先全量 preflight 所有目標
  template revision/page IDs/layout hashes，再以 `<operation>:<run_id>` 把所有待改頁面寫進
  `template_page_layout_migration_backups`；重跑會建立另一份快照，不會以
  `INSERT OR IGNORE` 吃掉新備份。
- 整批 apply **不是單一 transaction**：正式 snapshot/sync service 以每個 template
  各自 commit。腳本會在每次 commit 前後更新同名且帶 run id 的
  `*.manifest.json`；若中途失敗，manifest 會明列 `applied`、`failed`、
  `not_applied`，先前成功模板不會假裝 rollback。manifest 每次先 fsync 暫存檔再
  atomic replace；但程序若剛好死在 DB commit 後、`applied` 寫入前，該模板會停在
  **`applying`（indeterminate）**，不可直接視為未套用。
- 遇到 `applying` 或要恢復 partial run，先唯讀核對：

  ```bash
  python scripts/inspect_data_script_manifest.py --manifest output/material-text-link-report-<run_id>.manifest.json
  ```

  inspector 會以 manifest 的 `expected_revision`／`expected_applied_revision`、
  原始／計畫 layout SHA-256 和目前 DB 判成 `not_applied`、`applied` 或
  `diverged`，並確認 `backup_name` 的頁面數與原始內容 hash 完整。恢復時以該唯一
  `backup_name` 找原始 layout，經正式 template snapshot/sync 流程回存；不可直接
  `UPDATE template_pages`，否則會繞過 revision 與 project sync。既有 apply run id
  不可重用，避免覆寫 crash 證據；新 run 會另建一份備份。
- backfill 使用正式 effective render traversal 判定 ancestor visibility 與最終
  stacking order。`flat-world-v1` 只在同一 group 內寫 `group.links`；跨 group
  候選以 `unsupported_v1_scope` 列報告，不強制升級 topology。reset 可讀 v1
  group links 與 v2 top-level links。
- CSV 已防試算表公式注入，但仍可能包含模板、專案、學生姓名；overflow 明細加
  `--include-text` 時還會包含實際文字。`output/` 與 `teacher-overview*.xlsx`
  不得 commit、不得上傳到公開 issue/CI artifact；使用完依園所個資規範清除。

## Agent 修改後的驗證流程（必守）

改完程式**不能**直接回報「應該可以了」，必須自己先驗證：

- **後端邏輯**：跑 `python -m pytest -q`；涉及 API 行為再起
  `uvicorn --reload`，用 curl 或 Python 腳本實際打端點比對回應
  （Windows curl 中文限制見 [conventions.md](conventions.md#windows-開發環境注意)）
- **前端邏輯**：`npm run build` 後用 Playwright 或瀏覽器實際操作目標功能
- **渲染改動**：必跑 `test_render_regression.py` 與 `npm run test:render-parity`
- **DB schema 改動**：本機跑一次啟動（migration 自動執行），
  以 `PRAGMA table_info` 確認欄位 / 索引存在
- 確認輸出符合預期後才回報結果
