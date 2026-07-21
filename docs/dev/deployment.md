# 部署與環境變數

> Owns：啟動腳本、Docker / nginx 部署、環境變數表。
> R2 維運操作（資料遷移、integration test）見 [storage.md](storage.md#r2-設定與維運)。

---

## 本機啟動腳本（repo 根目錄）

| 腳本 | 用途 |
|------|------|
| `start.bat` | 啟動後端（本機 uploads），Windows 雙擊即可 |
| `start_r2_local.bat` | 啟動後端並連 R2 staging（只從 `.env` 載入 storage / R2 變數） |
| `build_frontend.bat` | 前端 production build |
| `kill.bat` | 終止 port 8765 後端 |

手動啟動指令見 [README.md 的快速開始](../../README.md#快速開始)。

## Docker 部署

- **Multi-stage Dockerfile**：Stage 1 Node 20 編前端 → Stage 2 Python 3.12
  serve 後端與 `frontend/dist`
- candidate image 同時內建備份、startup schema、一次性 migration/audit 與補渲染
  腳本；本次正式資料流程與 maintenance 順序見
  [2026-07 正式切換 runbook](production-cutover-202607.md)
- Stage 1 用 `npm ci --legacy-peer-deps`（vite-plugin-pwa 與 vite 8 有
  peer dep 衝突）
- 前端 build 會把共用 Noto TC 字型複製到 `/frontend/dist/fonts/`，後端也從同一路徑
  讀取；瀏覽器優先取 WOFF2，`/fonts` 以 ETag 重驗證、未變更回 304，
  fonts-noto-cjk / fonts-wqy-* 只保留作資產遺失時的 fallback
  （字型契約見 [rendering.md 字型](rendering.md#字型)）
- 容器**不對外暴露 port**，透過 Unix socket 接 nginx
  （設定範本 `deploy/album_maker.conf`）
- nginx 設定目錄出現 `maintenance/album_maker.flag` 時，HTTPS 站點立即回 503；移除
  檔案即恢復流量，不需 reload。切換中的管理操作只可從 app 容器走 Unix socket。
- uploads 與 DB 掛 named volumes

```bash
cp .env.example .env      # 填入 SECRET_KEY（產生方式見下表）
APP_BUILD_ID=$(git rev-parse --short HEAD) docker compose up -d --build
```

正式部署：上傳專案至 VPS → 建 `.env` →
`APP_BUILD_ID=$(git rev-parse --short HEAD) docker compose up -d --build` →
把 `deploy/album_maker.conf` 加入現有 nginx compose 並重啟 nginx。

**務必帶 `APP_BUILD_ID`**（Dockerfile 的 frontend-builder ARG 會消費它）：
`COPY frontend/ .` 的內容雜湊快取在部分 Docker 版本不可靠，曾發生 backend
更新、但前端 build layer 被重用而持續服務舊 bundle（症狀：前端改動 deploy
後畫面沒變）。帶 git SHA 讓 commit 一變就強制重編前端。懷疑仍服務舊前端時，
以 `sudo docker compose exec -T app grep -l "<minify 後仍存在的字串>"
/frontend/dist/assets/*.js` 驗證（注意區域識別字會被 minify 改名，需挑
字串常值或內建 API 名如 `new Image` 當標記），或直接 `--no-cache` 重建。

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `SECRET_KEY` | 無（**必設**） | JWT 簽名密鑰；`python -c "import secrets; print(secrets.token_hex(32))"` 產生。`PRODUCTION=1` 未設則拒絕啟動；開發模式用內建預設值並警告 |
| `PRODUCTION` | 本機未設定；Compose 預設 `1` | 設 `1`：Cookie 加 Secure flag（需 HTTPS）+ 強制 SECRET_KEY |
| `DATABASE_URL` | `sqlite:///./album_maker.db` | 資料庫連線字串（僅支援 SQLite，見 architecture.md 非目標） |
| `ALLOWED_ORIGINS` | `http://localhost:5173,...` | CORS 允許來源，逗號分隔 |
| `STORAGE_BACKEND` | `local` | `local` / `r2` |
| `R2_ACCOUNT_ID` | 未設定 | Cloudflare account ID；r2 模式且未設 `R2_ENDPOINT_URL` 時必填 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 未設定 | R2 API 金鑰；r2 模式必填 |
| `R2_BUCKET` | 未設定 | bucket 名稱；r2 模式必填 |
| `R2_ENDPOINT_URL` | 未設定 | 自訂 endpoint；未設時用 `https://<account>.r2.cloudflarestorage.com` |
| `R2_SERVE_MODE` | `proxy` | `proxy` 後端代理回傳；`redirect` 會公開永久 URL，正式環境會拒絕啟動 |
| `R2_PUBLIC_BASE_URL` | 未設定 | 僅非正式環境的 redirect 模式使用 |
| `R2_KEY_PREFIX` | 未設定 | key 前綴；e2e / staging 隔離用（如 `__e2e/<run-id>`） |
| `R2_READ_CACHE_MAX_BYTES` | `157286400` | 記憶體讀取快取上限；`0` 停用 |
| `R2_LOCAL_CACHE_DIR` | 未設定 | 本機寫入快取目錄（僅本機測試建議） |
| `R2_LOCAL_CACHE_MAX_BYTES` | `1073741824` | 本機寫入快取容量；超過刪最舊；`0` 停用 |
| `R2_LOCAL_MIRROR_DIR` | 未設定 | 本機唯讀鏡像目錄（僅本機測試建議） |
| `PREVIEW_RENDER_CONCURRENCY` | `4` | 頁面預覽渲染併發槽（`request_limiter.py`） |
| `ALBUM_RENDER_CONCURRENCY` | `1` | 相冊 PDF 渲染併發槽 |
| `ZIP_BUILD_CONCURRENCY` | `1` | ZIP 打包併發槽 |
| `PHOTO_UPLOAD_CONCURRENCY` | `2` | 照片上傳處理併發槽 |
| `HEAVY_REQUEST_QUEUE_TIMEOUT_SECONDS` | `10.0` | 重任務排隊逾時秒數，超時回 503（背景 job 走 `acquire_blocking` 不受此限） |
| `ARCHIVE_PURGE_INTERVAL_SECONDS` | `300` | 服務存活期間掃描並清除已超過復原期限之封存相本的間隔秒數；啟動時也會立即掃描一次 |
| `RENDER_RECONCILE_ON_STARTUP` | `1` | 啟動後背景收斂掃描：有效完成但輸出過期的學生逐位指紋補渲（[rendering.md](rendering.md#渲染時機完成觸發背景渲染與下載前補渲)）；`0` 停用 |

`.env` 已被 `.gitignore` 排除；金鑰不得 commit。

## 備份、驗證與還原

正式環境至少每日建立一次備份；大量匯入／刪除前再手動建立一次。SQLite 使用線上
backup API 取得一致快照，本機 storage 會一併封裝，產物以 SHA-256 manifest 驗證：

```bash
docker compose exec app python /app/scripts/backup_data.py create \
  --database-url sqlite:////app/db/album_maker.db \
  --uploads-dir /app/uploads --output-dir /app/backups --keep-days 30
docker compose exec app python /app/scripts/backup_data.py verify \
  /app/backups/album-maker-backup-YYYYMMDDTHHMMSSZ
```

app 已停止時不能使用 `exec`；切換或還原期間改用同一 Compose project 的
`docker compose run --rm --no-deps -T app ...`。一次性正式切換的完整命令只放在
[2026-07 runbook](production-cutover-202607.md)，避免另建空 named volume。

`backups` 是獨立 named volume；仍應用主機排程把它同步到異機／物件儲存。R2 模式只
備份 SQLite，manifest 會明確標示未包含 R2 物件；媒體備份契約見
[storage.md 的 R2 備份與大量改寫](storage.md#r2-備份與大量改寫)。

還原前先停止 app，並先執行 `verify`。還原是取代性操作，沒有
`--confirm-replace` 會拒絕執行：

```bash
docker compose stop app
docker compose run --rm app python /app/scripts/backup_data.py restore \
  /app/backups/album-maker-backup-YYYYMMDDTHHMMSSZ \
  --database-destination /app/db/album_maker.db \
  --uploads-destination /app/uploads --confirm-replace
docker compose start app
```

## 健康檢查與告警

`GET /api/health` 會實際執行 SQLite `SELECT 1`；Docker image 亦每 30 秒透過
UDS（compose）或 localhost TCP（Dockerfile 預設）探測此端點。正式環境仍應由
外部 uptime 服務探測 `https://<網域>/api/health`，並對非 200 與 Docker
`unhealthy` 設定通知。未捕捉例外會以 `unhandled_request method=... path=...`
寫入 ERROR log，可交由 log agent／Sentry 收集。

## 網路邊界

- `:8765` — uvicorn（API + SPA + 圖片 GET）；Docker 模式下不對外，走 Unix socket
- `:5173` — Vite dev server，`/api` proxy → `:8765`
- 遠端主機資訊不入 repo（見私人筆記 / 部署密件）
