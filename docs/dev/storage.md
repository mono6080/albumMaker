# Storage 層（StorageAdapter / 本機 / Cloudflare R2）

> Owns：StorageAdapter 抽象、storage key 格式、path traversal 防護、R2 設定與維運。
> R2 相關環境變數的完整表格見 [deployment.md 的環境變數](deployment.md#環境變數)。

---

## StorageAdapter 抽象

- 所有檔案 I/O 透過 `get_storage()` 取得 adapter；舊／外部 import 由 `services/storage.py`
  facade 相容，新內部 owner 可直接 import `storage_factory.py`，
  **不直接操作 `Path`**（跨模組 invariant，見
  [conventions.md](conventions.md#跨模組-invariants)）
- 介面：put / open_image / serve / delete / delete_prefix / move / exists / list_keys / get_bytes
- `delete_prefix` / `list_keys` 的 prefix 以 **path segment 邊界**比對：只匹配 exact key
  或 `prefix/…` descendants，不把 `prefix.pdf`、`prefix_screen` 等 lexical sibling
  視為同一 namespace；Local 與 R2 語意一致
- **批次存在性檢查用 `list_keys(prefix)`**：R2 上逐檔 `exists()` 是一次 head_object
  網路往返，數百檔會慢到 timeout（學期匯出預覽曾因此 29 秒）；改為每目錄列舉一次
  再做集合比對
- `storage_base.py` 定義介面；`storage_local.py` 與 `storage_r2.py` 分別實作本機磁碟及
  Cloudflare R2（S3 相容，boto3）；`storage_cache.py` 擁有 R2 memory/local cache。
- `storage_factory.py` 的 `get_storage()` 在每次呼叫時讀 `STORAGE_BACKEND`、`R2_*`、
  `PRODUCTION` 與 `app_paths.UPLOADS_DIR`；完整 path/env cache key 相同才重用 adapter。
  `storage.py` 只保留公開 import facade。此契約由 `tests/test_storage.py` 釘住。
- **介面 invariant**：`open_image()` 必須做 `ImageOps.exif_transpose`，
  原因見 [rendering.md 的 EXIF 條目](rendering.md#exif-方向open_image-統一-transpose)

## Path traversal 防護

`LocalStorageAdapter._path()` 對 key `.resolve()` 後確認在 `base_dir` 內，
含 `../` 的 key 拋 `ValueError`。已知理論邊界（shared-prefix escape）已有
regression test，見 [known-issues.md](known-issues.md)。Windows containment 比較會把
一般路徑與 `\\?\`／`\\?\UNC\` 的 extended-length 等價表示正規化，但實際 I/O
仍使用 `.resolve()` 回傳的路徑，不能為了長路徑相容而略過 canonical containment。

## Storage key 格式

所有檔案以**相對於 uploads/ 的 key 字串**存取，DB 不存絕對路徑：

| 用途 | Key 形式 |
|------|----------|
| 學生照片 | `projects/proj{pid}/photos/student{sid}/p{page_index}_slot{slot_id}_{stem}_{content-hash}.{ext}` |
| 模板背景 | `templates/tmpl{tid}/backgrounds/page{page_id}_{stem}_{content-hash}.{ext}` |
| 貼圖 | `templates/tmpl{tid}/stickers/{stem}_{content-hash}.{ext}` |
| PDF（列印） | `projects/proj{pid}/output/students/student{sid}/pdf/print.pdf` |
| PDF（螢幕） | `projects/proj{pid}/output/students/student{sid}/pdf/screen.pdf` |
| 學生單頁圖 | `projects/proj{pid}/output/students/student{sid}/images/{print\|screen}/page{n}.jpg`（讀取時相容舊版姓名 key） |
| 專案／學生互動預覽快取 | `projects/proj{pid}/previews/{project\|students/student{sid}}/page{page_index}/scale{scale}/{content-hash}.png` |
| 渲染指紋 | `projects/proj{pid}/output/students/student{sid}/.render_state`（dirty-skip 用，見 [rendering.md](rendering.md#相冊輸出與-dirty-skip)） |

- key 計算集中在 `services/file_service.py`（`get_photo_key` /
  `get_background_key` / `get_sticker_key`）
- 新上傳圖片的檔名尾端固定保留內容 hash；原始檔名過長時先截 stem 再拼 hash，避免不同 bytes
  撞到同一 key。舊版無 hash key 保持可讀。
- canonical 相本輸出以 `student{sid}` 隔離；姓名不參與 storage key，因此同名學生、
  `小明`／`小明_screen` 或安全化後同名都不會互覆。下載檔名仍以
  `build_combined_stem()` 組合專案名與學生名，非法字元 `\/:*?"<>|` 替換為 `_`；
  全班 ZIP 若下載 stem 重複才附 `-student{sid}`
- DB 內的照片 path 是 immutable opaque key；頁面重排／換格只改 binding，不搬檔。換照片時
  使用新內容 key，舊檔只有在不再被任何 active binding 引用時才刪，避免跨頁共享／重排後誤刪。
- 背景與貼圖也是內容版本 key。新背景 DB commit 前保留舊 key，commit 後舊版交由延遲 GC；
  同名貼圖上傳只建立新版本，直到模板 snapshot 儲存切換 path 才影響既有專案。
- 專案／學生改名或刪除會先在 project→student locks 內提交 DB binding 與輸出失效，再清除舊
  canonical output／學生照片 namespace；cleanup 失敗會記錄 error 而不把已成功的 DB mutation 回報成
  失敗。舊版 flat 姓名 key 仍可讀／下載；單生首次遷移、改名或刪除時會精確刪 key，
  並保留仍被 sibling `output_filename` 引用的碰撞檔。學生照片 namespace 清理完成前不釋放
  project lock，避免 SQLite 重用 student id 時誤刪新檔。
- `students.output_filename` 存的是**列印版 PDF key**；`student_pdf_key_for_mode()`
  對新版改走 sibling `pdf/screen.pdf`，並保留舊版 `{stem}_screen.pdf` 推導相容

## R2 設定與維運

### 本機開發連 R2 staging

一般本機開發用 `start.bat`（本機 uploads）。要讓 `localhost:8765` 直接用 R2
staging：在 `.env` 填入 R2 設定後改用 `start_r2_local.bat`（只載入 storage / R2
相關變數，避免把 Docker 用的 `DATABASE_URL` 帶進 Windows 本機）。

`R2_LOCAL_CACHE_DIR` 與 `R2_LOCAL_MIRROR_DIR` 僅建議本機測試用：寫入仍先寫 R2，
讀取可走本機快取加速互動預覽。正式部署要加速，優先用 CDN / custom domain。

### 將本機 uploads 複製到 R2

```powershell
python scripts\migrate_uploads_to_r2.py            # 複製（非搬移，本機保留作 rollback）
python scripts\migrate_uploads_to_r2.py --dry-run  # 只列出將上傳的 key
```

- R2 key 與本機 storage key 一致（去掉 `backend/uploads/` 前綴）
- 以 `head_object` 比對物件大小，相同即跳過 → 可重複執行；
  第二次執行顯示 `uploaded=0, failed=0` 代表已同步

### 把本機匯入好的模板搬到正式站

`import_office_template.py` 需要 Windows + Word COM，而且素材是直接寫本機檔案系統、
不走 StorageAdapter——正式站在容器裡、儲存是 R2，那支跑不動。所以模板一律「本機匯入好
再搬過去」，兩支腳本各負責一半：

```bash
# 1. 資料庫那一半：templates + template_pages 的列（預設 dry-run）
python scripts/transfer_template.py --source-db backend/album_maker.db \
    --target-db <正式站 db> --template-id 26 --template-id 27 \
    --source-uploads backend/uploads --staging-dir .tmp/template_transfer --apply

# 2. 素材那一半：staging 目錄已用「新的」template id 命名，直接餵給上傳
python scripts/migrate_uploads_to_r2.py --uploads-dir .tmp/template_transfer
```

`transfer_template.py` 處理三件錯了不會報錯的事：期別用（部門，名稱）對而不是 id
（兩邊 id 不保證一樣）、template id 重新配（照抄會撞主鍵或蓋掉別的模板）、`layout_json`
裡三處素材路徑跟著改（`template_pages.background_filename` 欄位、`layout_json` 的背景、
每個 `stickers[].path`）。漏掉路徑那一步的症狀是「模板在、圖是空的」。

**目標期別要先建好**，否則會被擋下並列出缺哪一個。同期別已有同名模板也會擋，重跑不會
建出第二份。規則由 `tests/test_transfer_template.py` 釘住。

### R2 備份與大量改寫

`backup_data.py` 在 R2 模式只備份 SQLite；memory/local cache 與同 bucket 的一般前綴都
不是獨立備份。大量刪除或覆寫前，必須停掉所有 writer，把受影響範圍的原始 bytes 串流到
repo 外的私人持久目錄，逐物件保存 SHA-256／metadata 並重驗；另保存全 bucket inventory
摘要，完成後只允許已審範圍變動。這個契約由
`tests/test_production_r2_snapshot_script.py` 釘住；2026-07 的完整命令見
[正式 R2 快照 runbook](production-r2-snapshot-202607.md)。

Cloudflare R2 的 active bucket lock 會禁止刪除／覆寫，不是版本快照；不得為了 rollback
鎖住正式工作前綴，否則相本重算與失敗重試都會被阻擋。若使用 lock，只能套在不再寫入的
獨立備份位置。`R2StorageAdapter.delete_prefix()` 也必須把 `DeleteObjects` 回應中的任何
逐物件 error 視為整批失敗，不得在遠端仍有殘留時回報成功。

### R2 integration test

一般測試不連 R2。要對真實 staging bucket 做 put/get/delete smoke test：

```powershell
$env:RUN_R2_INTEGRATION='1'
python -m pytest tests/test_storage.py -q
```

測試在 `__integration_tests/storage_smoke/` 建臨時物件，結束後刪除。
