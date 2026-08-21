# 2026-07 正式切換紀錄（已完成）

> Owns：2026-07 那次正式園所切換「做了什麼、結果如何」的事實紀錄。
> **這不是 runbook**——操作步驟與腳本已於 2026-08-18 退場，不可重跑。
> 一般部署與備份見 [deployment.md](deployment.md)。

---

## 做了什麼

2026-07 在 maintenance window 內，把正式站從「班級掛在專案上」的舊結構切換到
學期範圍班級（契約見
[學期範圍班級 v1](../specs/term-scoped-classroom-v1.md)）。該次 window 內完成：

1. 停寫、建立切換前 DB 備份與 pre-cutover image tag。
2. 以已審核的 reference DB replay 園所組織結構（分校、部門、班級、名冊、老師編制）。
3. 修復 Project 203 的資料異常。
4. 啟動前稽核 37 項全數通過才解除 maintenance。
5. Project 50／174 逐位補渲染 PDF。
6. 候選啟動前與補渲染後各做一次 R2 bytes snapshot 與全 bucket drift audit，
   確認只有 reviewed scope 變動。

正式流量恢復後未再回退。

## 為什麼腳本退場了

那次切換的五支腳本
（`migrate_production_organization_202607.py`、`repair_project_203.py`、
`audit_production_migration_202607.py`、`snapshot_production_r2_outputs_202607.py`、
`rerender_production_projects_202607.py`）與其四支測試已於 2026-08-18 刪除，
內容保留在 git 歷史。

原因不是「用不到了」而是「**已經不能用**」：切換本身把 `academic_terms`、
`academic_term_periods` 改名，DROP 掉 `academic_term_classrooms`，並把 `students`
變成園所名冊表（per-project 改為 `project_students`）。那些腳本查的是改名前的表與
欄位，對現行 schema 一律拋 `sqlite3.OperationalError`。

最尖銳的是 rollback 路徑：`snapshot_production_r2_outputs_202607.py` 的 restore
preflight 自己註明「rollback 可處於 post-migration DB」，卻查
`SELECT id, project_id FROM students`——現行 schema 沒有那個欄位。舊 runbook 又要求
對活的正式庫執行它。也就是說 **rollback 能力在切換完成的那一刻就已經失效**，
留著只是一個長得像安全網的陷阱。四支測試各自手刻舊 schema 自我封閉，
所以 CI 一直全綠，測不出腳本已死。

同一份 Dockerfile 早已因為相同理由（讀已改名的 `roster_children`）把
`correct_roster_names.py` 與 `fill_missing_album_names.py` 移出 image；
2026-08-18 只是把同一判準補套到這五支上。

## 現在還原得了嗎

**還原不到 2026-07 之前。** 正式站已在新 schema 上累積數週寫入，
即使腳本能跑，還原也等於刪掉那些資料。日常的備份與還原（同一 schema 內）
仍由 `scripts/backup_data.py` 提供，見 [deployment.md](deployment.md)。
