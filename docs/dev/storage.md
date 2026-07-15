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
regression test，見 [known-issues.md](known-issues.md)。

## Storage key 格式

所有檔案以**相對於 uploads/ 的 key 字串**存取，DB 不存絕對路徑：

| 用途 | Key 形式 |
|------|----------|
| 學生照片 | `projects/proj{pid}/photos/student{sid}/p{page_index}_slot{slot_id}_{stem}_{content-hash}.{ext}` |
| 模板背景 | `templates/tmpl{tid}/backgrounds/page{page_id}_{stem}_{content-hash}.{ext}` |
| 貼圖 | `templates/tmpl{tid}/stickers/{stem}_{content-hash}.{ext}` |
| PDF（列印） | `projects/proj{pid}/output/{stem}.pdf` |
| PDF（螢幕） | `projects/proj{pid}/output/{stem}_screen.pdf` |
| 學生單頁圖 | `projects/proj{pid}/output/{stem}/images/{print\|screen}/{stem}[_screen]_page{n}.jpg`（讀取時 fallback 舊版 `{stem}/{stem}_page{n}.jpg`） |
| 渲染指紋 | `projects/proj{pid}/output/{stem}/.render_state`（dirty-skip 用，見 [rendering.md](rendering.md#相冊輸出與-dirty-skip)） |

- key 計算集中在 `services/file_service.py`（`get_photo_key` /
  `get_background_key` / `get_sticker_key`）
- 新上傳圖片的檔名尾端固定保留內容 hash；原始檔名過長時先截 stem 再拼 hash，避免不同 bytes
  撞到同一 key。舊版無 hash key 保持可讀。
- `{stem}` = `make_safe_filename(專案名) + "-" + make_safe_filename(學生名)`
  （`output_keys.py`），非法字元 `\/:*?"<>|` 替換為 `_`
- DB 內的照片 path 是 immutable opaque key；頁面重排／換格只改 binding，不搬檔。換照片時
  使用新內容 key，舊檔只有在不再被任何 active binding 引用時才刪，避免跨頁共享／重排後誤刪。
- 背景與貼圖也是內容版本 key。新背景 DB commit 前保留舊 key，commit 後舊版交由延遲 GC；
  同名貼圖上傳只建立新版本，直到模板 snapshot 儲存切換 path 才影響既有專案。
- 專案／學生改名或刪除會先在 project→student locks 內提交 DB binding 與輸出失效，再清除舊
  canonical output／學生照片 namespace；cleanup 失敗會記錄 error 而不把已成功的 DB mutation 回報成
  失敗。學生照片 namespace 清理完成前不釋放 project lock，避免 SQLite 重用 student id 時誤刪新檔。
- `students.output_filename` 存的是**列印版 PDF key**；下載 screen 版時以字串
  操作換副檔名 — 對 `.pdf` 的硬假設，見 [known-issues.md](known-issues.md)

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

### R2 integration test

一般測試不連 R2。要對真實 staging bucket 做 put/get/delete smoke test：

```powershell
$env:RUN_R2_INTEGRATION='1'
python -m pytest tests/test_storage.py -q
```

測試在 `__integration_tests/storage_smoke/` 建臨時物件，結束後刪除。
