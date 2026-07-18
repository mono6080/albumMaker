# 2026-07 正式切換 runbook

> Owns：本次正式園所 replay、Project 203 修復、稽核、補渲染與 rollback。
> 這是一次性操作文件；一般部署與備份見 [deployment.md](deployment.md)。

## 不可跨越的 gate

- 全程從正式服務原本使用的同一個 Compose checkout 執行；換目錄或 project name
  會掛到另一組空 named volumes。
- nginx maintenance flag 必須先建立並確認公開路徑回 503，持續到 audit、health、
  Project 50/174 補渲染完成；app 啟動不等於恢復公開流量。
- `/migration` 必須 bind 到權限 `0700` 的本機持久目錄，並支援 `flock`、`fsync`
  與 atomic rename；不可用語意不明的 CIFS/NFS。目錄含姓名，不可放 repo、CI artifact
  或公開儲存。
- 只接受 SHA-256
  `b753b3aec0b0f03e151d9a5ce88f6eb54770b5f58e278cdd4ebd5e06c42eaf15`
  的 reviewed reference DB。正式 DB 一律取 maintenance window 內的新備份，不得上傳
  舊本機 DB 覆蓋。
- 任一命令非零、audit 非 37/37，或人工核對不符，都保持 maintenance 並停止；
  不可手寫 SQL 補半套資料。
- R2 不用 versioning、replication 或 active bucket lock；候選啟動前與補渲染後必須完成
  [R2 快照 runbook](production-r2-snapshot-202607.md) 的 bytes snapshot 與 drift audit。

## 1. 候選映像與私人目錄

先 `cd` 到正式 Compose checkout，再設定本次 shell：

```bash
set -Eeuo pipefail
umask 077
DOCKER_BIN="$(command -v docker)"
docker() { sudo "${DOCKER_BIN}" "$@"; }
test -f docker-compose.yml
test -z "$(git status --porcelain)"
CUTOVER_ID="$(date -u +%Y%m%dT%H%M%SZ)"
PRIVATE_DIR="/var/lib/album-maker-private/production-cutover-202607"
MIGRATION_DIR="${PRIVATE_DIR}/${CUTOVER_ID}"
REFERENCE_DB="${PRIVATE_DIR}/reviewed-organization-reference.db"
PUBLIC_ORIGIN="https://album.derni.com.tw"
NGINX_COMPOSE_DIR="${NGINX_COMPOSE_DIR:?export absolute nginx Compose checkout}"
MAINTENANCE_FLAG="${NGINX_COMPOSE_DIR}/nginx/maintenance/album_maker.flag"
NGINX_SITE="${NGINX_COMPOSE_DIR}/nginx/sites-available/album_maker.conf"
nginx_compose() { sudo docker compose -f "${NGINX_COMPOSE_DIR}/docker-compose.yml" --project-directory "${NGINX_COMPOSE_DIR}" "$@"; }
REFERENCE_SHA256="b753b3aec0b0f03e151d9a5ce88f6eb54770b5f58e278cdd4ebd5e06c42eaf15"
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" \
  "${PRIVATE_DIR}" "${MIGRATION_DIR}"
test -f "${REFERENCE_DB}" && chmod 0400 "${REFERENCE_DB}"
test ! -e "${REFERENCE_DB}-wal" && test ! -e "${REFERENCE_DB}-shm"
printf '%s  %s\n' "${REFERENCE_SHA256}" "${REFERENCE_DB}" | sha256sum --check --strict
```

記住舊 image 後 pull/build；build 期間舊 app 仍在線。外部 nginx 不在 app Compose；
先部署、驗證、reload，公開 health/TLS preflight 失敗不得建立 maintenance flag。

```bash
OLD_CONTAINER_ID="$(docker compose ps --status running -q app)" && test -n "${OLD_CONTAINER_ID}"
docker compose exec -T app test -f /app/db/album_maker.db
OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "${OLD_CONTAINER_ID}")"
PRE_CUTOVER_IMAGE="album-maker-precutover:${CUTOVER_ID}"
docker image tag "${OLD_IMAGE_ID}" "${PRE_CUTOVER_IMAGE}"
git pull --ff-only
test -f "${NGINX_COMPOSE_DIR}/docker-compose.yml"
sudo cp -- "${NGINX_SITE}" "${MIGRATION_DIR}/album_maker.conf.before"
sudo install -d -m 0755 "$(dirname "${MAINTENANCE_FLAG}")"
sudo install -m 0644 deploy/album_maker.conf "${NGINX_SITE}"
nginx_compose exec -T nginx nginx -t || { sudo install -m 0644 "${MIGRATION_DIR}/album_maker.conf.before" "${NGINX_SITE}"; exit 1; }
nginx_compose exec -T nginx nginx -s reload
docker compose config --quiet
APP_IMAGE_REF="$(docker compose config --images | sed -n '1p')"
test -n "${APP_IMAGE_REF}"
docker compose build --pull app
printf '%s\n' "$(git rev-parse HEAD)" > "${MIGRATION_DIR}/release-commit.txt"
printf '%s\n' "${APP_IMAGE_REF}" > "${MIGRATION_DIR}/app-image-ref.txt"
printf '%s\n' "${PRE_CUTOVER_IMAGE}" > "${MIGRATION_DIR}/pre-cutover-image.txt"
docker image inspect "${APP_IMAGE_REF}" \
  --format '{{.Id}}' > "${MIGRATION_DIR}/candidate-image-id.txt"
docker compose run --rm --no-deps -T app sh -ec '
  for path in \
    /app/migrations.py \
    /app/scripts/backup_data.py \
    /app/scripts/run_startup_migrations.py \
    /app/scripts/migrate_production_organization_202607.py \
    /app/scripts/repair_project_203.py \
    /app/scripts/audit_production_migration_202607.py \
    /app/scripts/snapshot_production_r2_outputs_202607.py \
    /app/scripts/rerender_production_projects_202607.py
  do test -f "$path"; done
'
curl --fail --silent --show-error --max-time 30 "${PUBLIC_ORIGIN}/api/health" >/dev/null
```

## 2. 停寫與切換前備份

建立 flag 並確認公開路徑 503，再停止 app 及 repo 外的 worker、cron、手動 render：

```bash
sudo install -m 0644 /dev/null "${MAINTENANCE_FLAG}"
nginx_compose exec -T nginx test -f /etc/nginx/maintenance/album_maker.flag
test "$(curl --silent --show-error --noproxy '*' --resolve album.derni.com.tw:443:127.0.0.1 --max-time 30 "${PUBLIC_ORIGIN}/api/health")" = '{"detail":"maintenance"}'
test "$(curl --silent --show-error -o /dev/null -w '%{http_code}' --max-time 30 "${PUBLIC_ORIGIN}/api/health")" = 503
docker compose stop --timeout 120 app
test -z "$(docker compose ps --status running -q app)"
BACKUP_PATH="$(
  docker compose run --rm --no-deps -T app \
    python /app/scripts/backup_data.py create \
      --database-url sqlite:////app/db/album_maker.db \
      --uploads-dir /app/uploads \
      --output-dir /app/backups
)"
case "${BACKUP_PATH}" in
  /app/backups/album-maker-backup-*) ;;
  *) printf '無法辨識備份路徑：%s\n' "${BACKUP_PATH}" >&2; exit 1 ;;
esac
printf '%s\n' "${BACKUP_PATH}" > "${MIGRATION_DIR}/cutover-backup-path.txt"
docker compose run --rm --no-deps -T app \
  python /app/scripts/backup_data.py verify "${BACKUP_PATH}"
docker compose run --rm --no-deps -T app python -c \
  'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["files"]["database"]["sha256"])' \
  "${BACKUP_PATH}/manifest.json"
read -r -p "貼上剛才已 verify 備份 manifest 的 DB SHA-256: " SOURCE_DB_SHA256
[[ "${SOURCE_DB_SHA256}" =~ ^[[:xdigit:]]{64}$ ]]
printf '%s\n' "${SOURCE_DB_SHA256}" > "${MIGRATION_DIR}/source-db-sha256.txt"
```

本次備份不帶 `--keep-days`，避免 rollback 時順便清舊備份。它不包含 R2；source SHA
只能取自剛通過 verify 的 manifest，不可對仍可能被替換的 source DB 現算後直接信任。

## 3. Startup schema 與園所 replay

runner 不 import `main:app`，只跑 `init_db()` 與兩次 `run_migrations()`：

```bash
docker compose run --rm --no-deps -T \
  -e DATABASE_URL=sqlite:////app/db/album_maker.db \
  app \
  python /app/scripts/run_startup_migrations.py
ORG_RUN_ID="organization-${CUTOVER_ID}"
ORG_MANIFEST="/migration/production-organization.manifest-${ORG_RUN_ID}.json"
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  -v "${REFERENCE_DB}:/reviewed-reference.db:ro" \
  app python /app/scripts/migrate_production_organization_202607.py \
    --target-db /app/db/album_maker.db \
    --reference-db /reviewed-reference.db \
    --manifest-output /migration/production-organization.manifest.json \
    --run-id "${ORG_RUN_ID}"
```

人工閱讀私有 manifest；不可自動抽 SHA 後直接回填。至少核對：

- `reference_database_sha256`、replay identity 與 ledger coverage 等於已審私有 reference。
- RosterChild 新增／刪除／final 計數合理、孤兒為 0；園所、班級、名單與主管 scope 完整。
- `user_updates` 只有 reference 導出的 supervisor→teacher，且各自 `auth_version + 1`。
- 修復目標在 excluded；指定廢棄專案維持 archived/unassigned。

```bash
read -r -p "貼上已人工核對的 organization plan SHA-256: " ORG_PLAN_SHA
test "${#ORG_PLAN_SHA}" -eq 64
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/migrate_production_organization_202607.py \
    --target-db /app/db/album_maker.db \
    --apply-reviewed-manifest "${ORG_MANIFEST}" \
    --acknowledge-plan-sha256 "${ORG_PLAN_SHA}" \
    --acknowledge-maintenance-window
```

## 4. Project 203 修復

```bash
P203_RUN_ID="project203-${CUTOVER_ID}"
P203_MANIFEST="/migration/project-203-repair-${P203_RUN_ID}.manifest.json"
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  -v "${REFERENCE_DB}:/reviewed-reference.db:ro" \
  app python /app/scripts/repair_project_203.py \
    --db /app/db/album_maker.db \
    --reference-db /reviewed-reference.db \
    --report /migration/project-203-repair.csv \
    --run-id "${P203_RUN_ID}" \
    --actor-user-id 1
```

人工核對 CSV 與 manifest，且不可用 Excel 儲存回原檔：actor 仍是 admin；來源是零學生
空殼；工作格、校班、owner、template、學生順序與相本稱呼完全等於私有 reference。
apply 應封存來源三十天並建立正常 replacement，不硬編碼 replacement ID 或偽造 ledger。

```bash
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/repair_project_203.py \
    --db /app/db/album_maker.db \
    --apply-reviewed-manifest "${P203_MANIFEST}" \
    --acknowledge-maintenance-window
```

## 5. 啟動前 audit

不用 `tee`；`--output` 原子保存 JSON 並保留正確 exit code：

```bash
AUDIT_OUTPUT="/migration/production-migration-audit-${CUTOVER_ID}.json"
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/audit_production_migration_202607.py \
    --db /app/db/album_maker.db \
    --source-db "${BACKUP_PATH}/database.sqlite3" \
    --source-sha256 "${SOURCE_DB_SHA256}" \
    --organization-manifest "${ORG_MANIFEST}" \
    --project-203-manifest "${P203_MANIFEST}" \
    --output "${AUDIT_OUTPUT}" >/dev/null
```

只有 exit 0、`ok: true`、37/37 才可繼續。audit 會核對最新 P198 內容、115/199
封存狀態、完整園所 plan、角色、孤兒、ledger 與 P203 replacement。

接著完整執行 [候選啟動前 R2 快照](production-r2-snapshot-202607.md#候選啟動前建立快照)；
快照未完成或 SHA 未人工核對，不可啟動 candidate。

## 6. 候選 app、補渲染與解除 maintenance

先啟動 candidate，但仍不恢復公開流量：

```bash
docker compose up -d --no-deps --force-recreate --no-build \
  --wait --wait-timeout 120 app
docker compose ps app
docker compose exec -T app python /app/healthcheck.py
```

密碼只從隱藏輸入進 host 環境並以 `-e` 傳變數名稱；腳本依私有 reference 從 app Unix socket 補渲染，全程不可移除 flag。

```bash
set +x
read -r -s -p "Production admin password: " ALBUM_MAKER_ADMIN_PASSWORD
printf '\n'
export ALBUM_MAKER_ADMIN_PASSWORD
trap 'unset ALBUM_MAKER_ADMIN_PASSWORD' EXIT
docker compose run --rm --no-deps -T \
  -e ALBUM_MAKER_ADMIN_PASSWORD \
  -v "${MIGRATION_DIR}:/migration:rw" \
  -v "${REFERENCE_DB}:/reviewed-reference.db:ro" \
  app python /app/scripts/rerender_production_projects_202607.py \
    --unix-socket /album_maker_socket/app.sock --reference-db /reviewed-reference.db --username admin \
    --password-env ALBUM_MAKER_ADMIN_PASSWORD \
    --manifest /migration/production-rerender.json \
    --run-id "rerender-dry-${CUTOVER_ID}" --timeout-seconds 3600
docker compose run --rm --no-deps -T \
  -e ALBUM_MAKER_ADMIN_PASSWORD \
  -v "${MIGRATION_DIR}:/migration:rw" \
  -v "${REFERENCE_DB}:/reviewed-reference.db:ro" \
  app python /app/scripts/rerender_production_projects_202607.py \
    --unix-socket /album_maker_socket/app.sock --reference-db /reviewed-reference.db --username admin \
    --password-env ALBUM_MAKER_ADMIN_PASSWORD \
    --manifest /migration/production-rerender.json \
    --run-id "rerender-apply-${CUTOVER_ID}" --timeout-seconds 3600 \
    --apply --acknowledge-project-ids 50,174
unset ALBUM_MAKER_ADMIN_PASSWORD
trap - EXIT
sudo chmod -R go-rwx "${MIGRATION_DIR}"
```

確認 apply manifest `complete` 且兩本 responses/final 數量都等於 reference，再執行
[補渲染後 R2 audit](production-r2-snapshot-202607.md#補渲染後-audit)；通過後才移除 flag：

```bash
docker compose exec -T app python /app/healthcheck.py && sudo unlink "${MAINTENANCE_FLAG}"
curl --fail --silent --show-error --max-time 30 "${PUBLIC_ORIGIN}/api/health" || { sudo install -m 0644 /dev/null "${MAINTENANCE_FLAG}"; exit 1; }
```

## Rollback 與中斷

- organization/P203 中斷時，保持 maintenance，以同一 manifest 與相同 acknowledgement
  重跑；腳本只接受完整未套用、完整已套用或精確可 reconcile 狀態。
- rerender partial failure 不改 DB migration；保留失敗 manifest，以新 run ID 重跑。
  已成功的單生輸出會由 storage/hash 規則安全跳過或重建。
- 只有尚未恢復正式寫入時，才可整體還原切換前 DB：

若 R2 snapshot 已建立，先依 [R2 rollback restore](production-r2-snapshot-202607.md#rollback-restore)
還原物件；snapshot 前的 DB-only rollback 不碰 R2。接著還原 DB/image：

```bash
BACKUP_PATH="$(cat "${MIGRATION_DIR}/cutover-backup-path.txt")"
case "${BACKUP_PATH}" in /app/backups/album-maker-backup-*) ;; *) exit 1 ;; esac
docker compose run --rm --no-deps -T app \
  python /app/scripts/backup_data.py verify "${BACKUP_PATH}"
docker compose run --rm --no-deps -T app \
  python /app/scripts/backup_data.py restore "${BACKUP_PATH}" \
    --database-destination /app/db/album_maker.db --confirm-replace
APP_IMAGE_REF="$(cat "${MIGRATION_DIR}/app-image-ref.txt")"
PRE_CUTOVER_IMAGE="$(cat "${MIGRATION_DIR}/pre-cutover-image.txt")"
docker image tag "${PRE_CUTOVER_IMAGE}" "${APP_IMAGE_REF}"
docker compose up -d --no-deps --force-recreate --no-build \
  --wait --wait-timeout 120 app
docker compose exec -T app python /app/healthcheck.py && sudo unlink "${MAINTENANCE_FLAG}"
curl --fail --silent --show-error --max-time 30 "${PUBLIC_ORIGIN}/api/health" || { sudo install -m 0644 /dev/null "${MAINTENANCE_FLAG}"; exit 1; }
```
正式流量恢復後若已有新寫入，禁止直接還原切換前 DB/R2，否則會刪掉新資料；必須
重新進 maintenance 並先做影響分析。
