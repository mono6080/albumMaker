# 已知落差與開放問題（Known Issues / Drift）

> Owns：所有「已知但尚未處理」的程式碼落差（drift）、未定案設計問題與營運缺口。
> 規則：修掉一條就同 commit 刪掉該條（見 [doc-policy.md](doc-policy.md)）。
> 最後盤點：2026-07-17。

---

## 營運缺口（依風險排序，2026-07-13 記錄）

1. **異地備份排程仍需部署端設定**：repo 已有 `scripts/backup_data.py`，支援
   SQLite 線上快照、本機媒體封裝、SHA-256 驗證與還原，Docker 也有獨立
   backups volume；但正式主機仍需以 cron 執行並同步到異機／物件儲存。
2. **錯誤通知管道仍需部署端設定**：未捕捉 exception 已用結構化 ERROR log
   記錄 method/path，但尚未配置 Sentry 或 log 掃描通知收件人。
3. **外部 uptime 告警仍需部署端設定**：`/api/health` 已檢查 SQLite，Docker
   HEALTHCHECK 也已接上；仍需外部監控服務定期探測正式網域並設定通知。

## 開放設計問題

- **舊資料群組 migration 尚未實作**：通用巢狀群組 v2 契約詳見
  [Illustrator 式通用巢狀群組 v2 規格](../specs/illustrator-style-nested-groups-v2.md)；v1 保持可讀，但
  現有未群組 layout 不會依位置建立群組，自動群組 migration 明確延後到功能驗收後另案設計。
  `backfill_material_text_links.py` 只會回填可確定的素材文字 metadata link，不會猜或改 group topology

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
4. **兩頁制新流程的 e2e 未全覆蓋**：「每人不同張」精靈（含關閉未上傳退回
   放照片 Modal）、共用照片裁切、PhotoManager 本頁/整本切換與跨頁上傳、
   全班完成鎖定→退回——e2e 已覆蓋「多人同一張」全班直傳與勾選部分學生
   （project-flow.spec.js）與依檔名整批匯入（batch-wizard.spec.js）
