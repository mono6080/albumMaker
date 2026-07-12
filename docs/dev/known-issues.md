# 已知落差與開放問題（Known Issues / Drift）

> Owns：所有「已知但尚未處理」的程式碼落差（drift）與未定案設計問題。
> 規則：修掉一條就同 commit 刪掉該條（見 [doc-policy.md](doc-policy.md)）。
> 最後盤點：2026-07-12（兩頁制重構後多代理深審，59 項發現已修 confirmed 全數）。

---

## 已知 DRIFT（先記、不修）

- **`vite.config.js` runtimeCaching `^/uploads/` 是死規則**：實際照片 serving
  路徑是 `/api/projects/.../photos/...`，不在 `/uploads/` 下
- **`LocalStorageAdapter._path()` 的 shared-prefix 理論邊界**：`base=/uploads`
  與 `resolved=/uploads_evil` 的 startswith 比對問題。實務上 base 是固定目錄
  不會撞 prefix，且已有 regression test 鎖住行為；若未來改路徑命名需注意

## 開放設計問題

- **多 worker 下的並發**：`render_album` 是純 PIL（無共享 mutable state），
  但 uvicorn workers > 1 時 SQLite 寫入會搶鎖。目前單 worker、低並發沒事
- **S3 / R2 的中文 key**：照片 key 的 `{filename}` 保留使用者原檔名（可能中文）。
  R2 key 是 UTF-8 byte sequence 可容，但 CDN / signing 中間層行為未驗證
- **新 storage adapter 的 EXIF transpose**：`open_image()` 必須做
  exif_transpose 是介面 invariant（已記入
  [storage.md](storage.md#storageadapter-抽象)）；新增 adapter 時要有對應契約測試
- **`output_filename` 對 `.pdf` 的硬假設**：存列印版 key，screen 版靠
  `[:-4] + "_screen.pdf"` 字串操作；日後若新增其他輸出格式會被卡住
- **PWA SW 與 SPA catch-all 的同名 race**：目前「先實體檔案、後 index.html」
  已穩定（見 [architecture.md](architecture.md#spa-catch-all-與-pwa-service-worker-優先序)），
  但若新增與 SW asset 同名的 SPA 路由會出現 race
- **權限矩陣的隱藏假設**：若未來引入「主管可代老師編輯專案」，
  `assert_project_writable` 要展開（現況見
  [api.md 的角色權限矩陣](api.md#角色權限矩陣)）
- **刪除 user 的專案過繼無 audit log**：`delete_user` 把專案過繼給執行的
  admin，未留紀錄；日後加 audit log 表時要涵蓋
- **補渲染 job 狀態存記憶體**：`services/export_jobs.py` 的 job registry
  是程序內 dict，後端重啟即消失（補渲染冪等、重新發起即可）；
  若未來走多 worker 需改外部儲存
- **dirty-skip 對「渲染程式碼變更」不敏感**：內容指紋只涵蓋資料
  （版面/文字/照片），改渲染邏輯要手動 bump `_RENDER_PIPELINE_VERSION`
  （規則見 [rendering.md](rendering.md#相冊輸出與-dirty-skip)），忘了 bump
  舊相冊不會套用視覺修正
- **同名前綴學生的輸出誤刪**：`render_and_save_student_album` 以
  `delete_prefix(output/{stem})` 清舊輸出，學生「小明」會掃到「小明二」的
  `{stem}二.pdf`（stem 為前綴時）。歷史行為、實務上班內同前綴名罕見

## 測試缺口（未來高 leverage gate）

1. **Playwright browser parity 升級**：現有 render-parity 用 Konva canvas
   backend rasterize；更嚴格可做真實 TemplateEditor full-page screenshot diff
2. **API negative contracts 持續擴充**：malformed payload 與更多
   endpoint-specific 403/404 邊界
3. **前端元件測試（vitest / RTL）**：目前完全沒有
4. **兩頁制新流程的 e2e 未全覆蓋**：「每人不同張」精靈（含關閉未上傳退回
   放照片 Modal）、共用照片裁切、依檔名整批匯入、PhotoManager 本頁/整本
   切換與跨頁上傳、全班完成鎖定→退回——e2e 只測到「全班同一張」直傳主線
