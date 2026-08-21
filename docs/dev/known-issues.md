# 已知落差與開放問題（Known Issues / Drift）

> Owns：所有「已知但尚未處理」的程式碼落差（drift）、未定案設計問題與營運缺口。
> 規則：修掉一條就同 commit 刪掉該條（見 [doc-policy.md](doc-policy.md)）。
> 最後盤點：2026-08-18（全專案結構盤點；行為保持的清理已執行，四條活缺陷見下）。

---

## 營運缺口（依風險排序，2026-07-13 記錄）

1. **異地備份排程仍需部署端設定**：repo 已有 `scripts/backup_data.py`，支援
   SQLite 線上快照、本機媒體封裝、SHA-256 驗證與還原，Docker 也有獨立
   backups volume；但正式主機仍需以 cron 執行並同步到異機／物件儲存。
2. **錯誤通知管道仍需部署端設定**：未捕捉 exception 已用結構化 ERROR log
   記錄 method/path，但尚未配置 Sentry 或 log 掃描通知收件人。
3. **外部 uptime 告警仍需部署端設定**：`/api/health` 已檢查 SQLite，Docker
   HEALTHCHECK 也已接上；仍需外部監控服務定期探測正式網域並設定通知。

## 編班的操作缺口（2026-08-01 照行政系統實地演練 115 上時發現）

演練方式：把正式副本升級後，照 adminProject 的 115 上目標狀態（37 班、378 續讀、
87 離園、24 新生、48 筆編制）用真實瀏覽器操作一次。以下是**尚未處理**的部分；
空班誤落離園與新生無法編入已修掉，行為由
`frontend/tests/e2e/term-placement-board.spec.js` 釘住。

1. **要退場的班必須先逐班清掉老師**：學生搬走後，班上仍掛著老師就移不掉
   （`classroom_removal_blockers` 把編制算成佔用）。115 上有 7 個班要退場，就得開
   7 次老師面板、把主教設成「不設定老師」並取消所有協同，才輪得到移除。
2. **沒有帳號的老師無法編制**：老師面板只列現有使用者帳號。115 上有 1 位
   （湖美校／四階A 嬰幼助教）沒有帳號，必須離開編班頁去建帳號再回來重新整理。
3. **改名不會改部門，而且沒有警告**：班級的部門不可變更
   （`classroom_scope_is_immutable`）。把嬰幼部的「銜接A」改名成「八階A」會得到一個
   掛著學院部班名、實際仍是嬰幼部的班，工作格整學期都抓錯期別。**改名只能在同部門
   內用**——跨部門一定要新建班級再把學生搬過去。
4. **預設值與這所幼兒園的實務相反**：草稿預設「全部留在原班」，但這裡每學期整體升
   一階，378 位續讀生裡只有 11 位真的留原班。
5. **表單欄位的無障礙名稱被說明文字污染**：`FormField` 把 `hint` 一起包進
   `<label>`，欄位名稱變成「標籤＋整段說明」，而且會互相污染（「結束日」的名稱裡
   含「開始日」）。登入頁的 `<label>` 更是完全沒跟 input 綁定。應改用
   `aria-describedby` 掛說明。

## webkit 在 CI runner 上會 crash（2026-08-02）

`organization-management.spec.js` 的「class staffing and new-term reclassification…」
跑到最後一段（切換成老師身分再 `page.goto("/projects")`）時，在 GitHub runner 的 webkit
上固定 `page.goto: Page crashed`。逐一排除過：

- 不是斷言不成立——chromium 同一條全過
- 不是隨機——三次重試都停在同一個導覽點
- 不是 trace 錄製——改成 `on-first-retry` 之後仍舊
- **不是資料累積**——改成每個 worker 獨立後端與資料庫之後，本機 webkit 123 條全過，
  CI 上這一條仍舊崩潰

目前在 CI 的 webkit 上跳過（chromium 完整覆蓋其契約）。**還沒排除的是「這是不是真的
Safari 問題」**——如果是應用本身在切換使用者時吃掉太多記憶體，真實的 Safari 使用者也
可能踩到。要查就從那次 crash 的 trace 開始。

## 開放設計問題

- **舊資料群組 migration 尚未實作**：通用巢狀群組 v2 契約詳見
  [Illustrator 式通用巢狀群組 v2 規格](../specs/illustrator-style-nested-groups-v2.md)；v1 保持可讀，但
  現有未群組 layout 不會依位置建立群組，自動群組 migration 明確延後到功能驗收後另案設計。
  `backfill_material_text_links.py` 只會回填可確定的素材文字 metadata link，不會猜或改 group topology

- **未鎖的舊學期期別會一直留在老師畫面**：建立相本鎖與學期轉換脫鉤之後
  （[period-album-creation-lock-v1](../specs/period-album-creation-lock-v1.md)），套用編班**不會**
  自動鎖上被關閉學期的期別。admin 一直不鎖的話，那些班會持續出現在老師的「已結束學期
  （可補建）」區與 admin 的工作格清單裡，逐年累積。目前靠分區呈現與班名帶學期避免混淆；
  是否要在期末流程提示 admin 逐期收尾，留待實際使用後再決定，不預先自動化——自動鎖就
  等於把鎖又綁回學期轉換。
- **多 worker 下的並發**：`render_album` 是純 PIL（無共享 mutable state），
  但 uvicorn workers > 1 時 SQLite 寫入會搶鎖。目前單 worker、低並發沒事
- **Storage cleanup 沒有 durable retry**：專案／學生改名或刪除在 DB commit 後清理舊輸出與
  照片；失敗目前只記錄 ERROR，沒有 outbox／GC 重試，因此可能留下不再有 DB binding 的孤兒檔案。
  若營運要求實體檔最終刪除保證，需補持久化 cleanup job（現行語意見 [storage.md](storage.md#storage-key-格式)）。
- **S3 / R2 的中文 key**：照片 key 的 `{filename}` 保留使用者原檔名（可能中文）。
  R2 key 是 UTF-8 byte sequence 可容，但 CDN / signing 中間層行為未驗證
- **新 storage adapter 的 EXIF transpose**：`open_image()` 必須做
  exif_transpose 是介面 invariant（已記入
  [storage.md](storage.md#storageadapter-抽象)）；新增 adapter 時要有對應契約測試
- **PWA SW 與 SPA catch-all 的同名 race**：目前「先實體檔案、後 index.html」
  已穩定（見 [architecture.md](architecture.md#spa-catch-all-與-pwa-service-worker-優先序)），
  但若新增與 SW asset 同名的 SPA 路由會出現 race
- **12 個錯誤代碼沒有 message，使用者只會看到通用句**：後端 `detail={"code": ...}` 共 89 站，
  其中 13 站（12 個不同 code）不帶 `message` 欄位。前端唯一的解讀器
  `utils/apiError.js` 只為 5 個完成鎖代碼寫了專屬句子，其餘一律退回
  「操作失敗，請稍後再試」。2026-08-19 以 AST 掃 `backend/` 逐站確認：

  *使用者可以處理、值得寫文案的*：`child_already_active_in_another_classroom`
  （organization_service.py:1680）、`invalid_teacher_role`（:608、:2231）、
  `supervisor_not_found`（:722）、`invalid_supervisor_role`（:735）、
  `period_not_in_semester`（semester_export_service.py:80）、
  `semester_render_job_running`（export_jobs.py:92）、
  `template_page_structure_changed`（template_page_snapshot_service.py:131）。

  *編輯器送出畸形 layout 才會發生、使用者無從處理*：`invalid_label_texts`、
  `invalid_layout_group`、`invalid_layout_typography`、`invalid_layout_geometry`、
  `removed_layout_element`——這組共用一句「版面資料格式有誤」即可，不必逐個寫。

  形狀本身已經不是問題（`apiError.js` 現在接住字串／完成鎖代碼／`message`／422 陣列／429
  五種，由 `frontend/tests/unit/api-error.test.mjs` 釘住）；缺的是這 12 個代碼的中文文案，
  那是產品決定，不該由實作者代擬。

- **學期匯出的預覽與下載仍只看 key 存不存在**：補渲染那一步已改成指紋判斷
  （見 [rendering.md](rendering.md#渲染時機完成觸發背景渲染與下載前補渲)），但
  `semester_export_service._serialize_entry` 的 `has_pdf` 與 `_cell_status` 仍是
  「storage 有這個 key 就是 ready」，`open_semester_export_zip_stream` 也直接串流舊檔。
  所以 admin 若跳過「補渲染」直接下載，仍可能拿到過期的 PDF，而 UI 顯示綠色 ready。
  難處是成本：完整指紋檢查每位約 4 次 storage 往返，2026-08 實測一個學期有 827 個
  學生格（≈3300 次往返），放進互動式的預覽載入會讓 admin 一開頁就等。
  要修得先設計一個便宜的過期訊號（例如把 `_RENDER_PIPELINE_VERSION` 與 template
  revision 這類全域／每本的訊號抽出來單獨比對，不必逐位讀 storage）。

- **行政系統同步寫入的學號沒有正規化**：`student_input_policy.normalize_student_serial`
  是學號的唯一真相來源（去空白、轉大寫），API 端建名冊時走它；
  `scripts/sync_websystem_roster.py` 的 `apply_changes` 沒有，上游給什麼就寫什麼。
  今天沒有實害（2026-08-18 實測正式名冊 466 筆學號全部已符合正規化、零碰撞），
  但上游哪天送出小寫或帶空白的學號，同一個孩子就會多出一個 `roster_child_id`，
  而唯一索引不會擋。現況由 `tests/test_websystem_roster_apply.py::
  test_serial_is_written_exactly_as_upstream_sent_it` 釘住。
  修的時候要先處理既有資料：只把查詢鍵改成正規化，會讓舊的未正規化列比不到而製造重複。
- **同步寫到已結束學期的守衛未測**：`sync_websystem_roster.main()` 在 commit 前檢查有沒有
  寫進非目前學期的班級，但那道檢查在 `main()` 裡、不在 `apply_changes`，現有測試都走不到
  （見 [websystem-roster-sync-v1 的測試現況](../specs/websystem-roster-sync-v1.md#risks-and-test-plan)）。
- **名冊稱呼修改不受完成鎖限制**:園所名冊的相本稱呼(`Student.album_name`)
  修改會影響已標記完成(全班或個別)相本的稱呼顯示,但名冊寫入不經過專案
  內容鎖;[相本個別完成 v1](../specs/student-album-completion-v1.md#non-goals)
  明確不在該階段處理。下載端點的指紋補渲
  ([rendering.md](rendering.md#渲染時機完成觸發背景渲染與下載前補渲))已讓
  下載產物自動跟上新稱呼;殘餘問題只剩「完成後名冊仍可改」的流程語意
- **期中轉班造成的同期重複相本：做法已定，尚未實作**。孩子在原班已建立該期相本之後
  才轉班，新班又建同一期相本時，他在兩本裡都有 `ProjectStudent` 快照，彙整匯出把那一格
  判為 `duplicate`：不渲染、不納入 ZIP，只在說明欄列出「Project X, Y 同一期有重複相本，
  未納入」——**少了東西的匯出沒有人會發現**。
  2026-08-02 決定：兩本都留，由匯出者像處理 merge conflict 一樣選邊，未裁決就擋下匯出。
  契約見
  [academic-term-reporting-v1.md 的同期重複相本](../specs/academic-term-reporting-v1.md#同期重複相本由匯出者裁決決策-2026-08-02)。
  在那之前的替代做法：轉班前先確認原班那一期的相本是否已經建立。
  114 下有 4 人期中換班、115 上目前已有 3 人，不是罕見情境。
- **權限矩陣的隱藏假設**：若未來引入「主管可代老師編輯專案」，
  `assert_project_writable` 要展開（現況見
  [api.md 的角色權限矩陣](api.md#角色權限矩陣)）
- **補渲染 job 狀態存記憶體**：`services/export_jobs.py` 的 job registry
  是程序內 dict，後端重啟即消失（補渲染冪等、重新發起即可）；
  若未來走多 worker 需改外部儲存

## 測試缺口（未來高 leverage gate）

1. **TemplateEditor 全頁視覺回歸**：文字已有真 Chromium／Pillow local-frame
   layout + raster parity；尚未對實際 TemplateEditor 整頁做跨瀏覽器 screenshot diff
2. **API negative contracts 持續擴充**：malformed payload 與更多
   endpoint-specific 403/404 邊界
3. **前端元件測試（vitest / RTL）**：目前完全沒有
4. **未定義的 JSX 元件不會被 lint 擋下**：`no-undef` 是開著的（error），但核心 ESLint
   不把 `<Foo />` 當成對 `Foo` 的變數引用——那是 `eslint-plugin-react` 的
   `jsx-uses-vars` 的工作，而本專案刻意沒裝它（見 `eslint.config.js` 的註解）。
   2026-08-18 實測：把一個元件搬進 `components/ui.jsx` 後忘了在使用端補 import，
   `npm run lint` 仍回報全綠。這類錯誤要到該元件實際 render 時才在瀏覽器炸開。
   權衡是「多一個相依」對「補上唯一擋得住這類錯誤的 gate」，尚未決定。
5. **兩頁制新流程的 e2e 未全覆蓋**：「每人不同張」精靈（含關閉未上傳退回
   放照片 Modal）、共用照片裁切、PhotoManager 本頁/整本切換與跨頁上傳、
   全班完成鎖定→退回——e2e 已覆蓋「多人同一張」全班直傳與勾選部分學生
   （project-flow.spec.js）與依檔名整批匯入（batch-wizard.spec.js）
