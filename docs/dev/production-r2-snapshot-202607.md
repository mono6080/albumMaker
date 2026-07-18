# 2026-07 正式 R2 快照 runbook

> Owns：本次正式切換的 R2 bytes snapshot、全 bucket drift audit 與 rollback restore。
> 園所／Project 203／補渲染主流程見
> [正式切換 runbook](production-cutover-202607.md)。

## 安全契約

- 只在 maintenance 已回 503、app 與所有 worker 都停止後建立 plan 與 snapshot。
- 快照固定涵蓋 Project 50／174 的完整 output，並自動納入未來 24 小時內會到期的封存
  Project 完整 namespace；已有到期未清項目、DB/R2 漂移或 SQLite sidecar 都直接阻擋。
- 原始 bytes 只落在 repo 外 `0700` 私人目錄，以 content-addressed SHA-256 blobs 保存；
  manifest 可能含舊姓名 key，不可進 repo、CI artifact 或公開儲存。
- 正式 bucket 不開 lock。補渲染後以全 bucket 摘要確認只有 reviewed mutable scope 變動；
  任一 scope 外漂移都保持 maintenance。

## 候選啟動前建立快照

沿用主 runbook 的 `CUTOVER_ID`、`MIGRATION_DIR`，且 candidate image 已建好：

```bash
R2_DIR="/migration/r2-snapshot-${CUTOVER_ID}"
R2_PLAN="${R2_DIR}/reviewed-plan.json"
R2_SNAPSHOT="${R2_DIR}/snapshot-manifest.json"

docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py plan \
    --database /app/db/album_maker.db \
    --snapshot-dir "${R2_DIR}" --cutover-id "${CUTOVER_ID}"
```

人工核對 stdout 的兩本學生數、24 小時到期 project、每個 recovery prefix 筆數／bytes、
scope 與 full/outside inventory digest；不得只複製程式剛印出的 SHA 就直接套用。

```bash
read -r -p "貼上已人工核對的 R2 plan SHA-256: " R2_PLAN_SHA256
[[ "${R2_PLAN_SHA256}" =~ ^[[:xdigit:]]{64}$ ]]
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py snapshot \
    --database /app/db/album_maker.db \
    --reviewed-manifest "${R2_PLAN}" \
    --reviewed-manifest-sha256 "${R2_PLAN_SHA256}" \
    --acknowledge-project-ids 50,174
read -r -p "貼上剛完成的 R2 snapshot manifest SHA-256: " R2_SNAPSHOT_SHA256
[[ "${R2_SNAPSHOT_SHA256}" =~ ^[[:xdigit:]]{64}$ ]]
printf '%s\n' "${R2_SNAPSHOT_SHA256}" > "${MIGRATION_DIR}/r2-snapshot-sha256.txt"

docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py verify-before-start \
    --database /app/db/album_maker.db \
    --snapshot-manifest "${R2_SNAPSHOT}" \
    --snapshot-manifest-sha256 "${R2_SNAPSHOT_SHA256}"
```

snapshot 必須回報 complete、object/byte 數與 content contract SHA；freshness gate 也必須
`passed`。執行後立刻回主 runbook 啟動 candidate，並保留上述三個 shell 變數。

## 補渲染後 audit

補渲染 apply manifest 已完整成功後、解除 maintenance 前執行：

```bash
R2_SNAPSHOT_SHA256="$(cat "${MIGRATION_DIR}/r2-snapshot-sha256.txt")"
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py audit-after \
    --snapshot-manifest "${R2_SNAPSHOT}" \
    --snapshot-manifest-sha256 "${R2_SNAPSHOT_SHA256}"
```

只有 exit 0 且 post-change audit `passed` 才可恢復流量；報告會留在同一私人目錄。

## Rollback restore

只可在公開流量尚未恢復、app／worker 全停時執行。先 dry-run 核對 changed recovery scopes，
再精確清除有差異的 scope、上傳原 bytes 並逐物件下載驗 SHA-256：

```bash
docker compose stop --timeout 120 app
test -z "$(docker compose ps --status running -q app)"
R2_SNAPSHOT_SHA256="$(cat "${MIGRATION_DIR}/r2-snapshot-sha256.txt")"
docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py restore \
    --database /app/db/album_maker.db \
    --snapshot-manifest "${R2_SNAPSHOT}" \
    --snapshot-manifest-sha256 "${R2_SNAPSHOT_SHA256}"

docker compose run --rm --no-deps -T \
  -v "${MIGRATION_DIR}:/migration:rw" \
  app python /app/scripts/snapshot_production_r2_outputs_202607.py restore \
    --database /app/db/album_maker.db \
    --snapshot-manifest "${R2_SNAPSHOT}" \
    --snapshot-manifest-sha256 "${R2_SNAPSHOT_SHA256}" \
    --apply --acknowledge-restore "50,174:${CUTOVER_ID}"
```

R2 restore complete 後，才依主 runbook 還原 SQLite 與舊 image。restore 中斷時保持
maintenance，以同一 snapshot SHA 與 acknowledgement 重跑；不可手動刪 key。
