# 學期匯出的補渲染背景工作
# 單 uvicorn 程序：job 以執行緒執行、狀態存記憶體；重啟即消失，
# 補渲染本身冪等（已渲染的會跳過），重新發起即可。

import logging
import threading
import time
import uuid

from fastapi import HTTPException

from database import SessionLocal
from services.semester_render_service import render_missing_semester_albums

logger = logging.getLogger(__name__)

# job_id → 狀態 dict；完成的 job 保留一小時供前端補查
_render_jobs: dict[str, dict] = {}
_render_jobs_lock = threading.Lock()
_FINISHED_JOB_RETENTION_SECONDS = 3600


def _prune_finished_render_jobs_locked(now: float) -> None:
    """清除已過保留期的工作；呼叫端必須持有 registry lock。"""
    expired_job_ids = [
        job_id
        for job_id, job in _render_jobs.items()
        if job["status"] != "running"
        and now - job.get("finished_at_monotonic", now)
        > _FINISHED_JOB_RETENTION_SECONDS
    ]
    for job_id in expired_job_ids:
        del _render_jobs[job_id]


def _prune_finished_render_jobs() -> None:
    now = time.monotonic()
    with _render_jobs_lock:
        _prune_finished_render_jobs_locked(now)


def _render_job_public_state(job: dict) -> dict:
    """回傳可回給前端的欄位（過濾內部計時欄位）。"""
    return {
        "job_id": job["job_id"],
        "academic_term_id": job["academic_term_id"],
        "period_ids": list(job["period_ids"]),
        "roster_child_ids": (
            list(job["roster_child_ids"])
            if job["roster_child_ids"] is not None
            else None
        ),
        "status": job["status"],
        "total": job["total"],
        "done": job["done"],
        "rendered": job["rendered"],
        "errors": list(job["errors"]),
    }


def start_render_missing_job(
    academic_term_id: int,
    period_ids: list[int],
    roster_child_ids: list[int] | None,
) -> dict:
    """啟動補渲染背景 job：渲染槽由 render_missing_semester_albums 逐位取用，
    job 本身不整段佔槽（老師的單本渲染可與 job 交錯）。

    回傳初始 job 狀態（total 要等第一遍掃描完成才有值，先為 None）。
    """
    job = {
        "job_id": uuid.uuid4().hex,
        "academic_term_id": academic_term_id,
        "period_ids": tuple(period_ids),
        "roster_child_ids": (
            tuple(roster_child_ids) if roster_child_ids is not None else None
        ),
        "status": "running",   # running | done | failed
        "total": None,
        "done": 0,
        "rendered": 0,
        "errors": [],
    }
    with _render_jobs_lock:
        _prune_finished_render_jobs_locked(time.monotonic())
        running_job = next(
            (existing_job for existing_job in _render_jobs.values()
             if existing_job["status"] == "running"),
            None,
        )
        if running_job is not None:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "semester_render_job_running",
                    "job_id": running_job["job_id"],
                },
            )
        _render_jobs[job["job_id"]] = job

    def update_progress(done_count: int, total_count: int) -> None:
        with _render_jobs_lock:
            job["done"] = done_count
            job["total"] = total_count

    def run_render_job() -> None:
        db = SessionLocal()
        status = "failed"
        result = None
        try:
            result = render_missing_semester_albums(
                db,
                academic_term_id,
                period_ids,
                roster_child_ids,
                progress_callback=update_progress,
            )
            status = "done"
        except Exception as job_error:
            # 錯誤細節只進 log，不外洩給 API 呼叫者
            logger.error("補渲染 job 失敗 job_id=%s: %s", job["job_id"], job_error)
        finally:
            with _render_jobs_lock:
                if result is not None:
                    job["rendered"] = result["rendered"]
                    job["errors"] = list(result["errors"])
                job["status"] = status
                job["finished_at_monotonic"] = time.monotonic()
            db.close()

    threading.Thread(target=run_render_job, name=f"render-job-{job['job_id'][:8]}", daemon=True).start()
    return _render_job_public_state(job)


def get_render_job_state(job_id: str) -> dict | None:
    """查詢補渲染 job 進度；不存在（或已過保留期）回 None。"""
    _prune_finished_render_jobs()
    with _render_jobs_lock:
        job = _render_jobs.get(job_id)
        return _render_job_public_state(job) if job else None
