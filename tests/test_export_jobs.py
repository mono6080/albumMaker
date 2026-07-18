"""學期補渲染背景工作的程序級 singleton 契約。"""

import threading
import time

import pytest
from fastapi import HTTPException

from services import export_jobs


def test_render_job_is_singleton_until_running_job_finishes(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def render_missing(
        db,
        academic_term_id,
        period_ids,
        roster_child_ids,
        progress_callback,
    ):
        progress_callback(0, 1)
        started.set()
        assert release.wait(timeout=5)
        progress_callback(1, 1)
        return {"rendered": 1, "errors": []}

    monkeypatch.setattr(export_jobs, "render_missing_semester_albums", render_missing)
    with export_jobs._render_jobs_lock:
        export_jobs._render_jobs.clear()

    first_state = export_jobs.start_render_missing_job(10, [1], None)
    assert started.wait(timeout=5)

    with pytest.raises(HTTPException) as conflict:
        export_jobs.start_render_missing_job(20, [2], None)
    assert conflict.value.status_code == 503
    assert conflict.value.detail == {
        "code": "semester_render_job_running",
        "job_id": first_state["job_id"],
    }

    release.set()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        final_state = export_jobs.get_render_job_state(first_state["job_id"])
        if final_state["status"] != "running":
            break
        time.sleep(0.01)
    assert final_state == {
        "job_id": first_state["job_id"],
        "academic_term_id": 10,
        "period_ids": [1],
        "roster_child_ids": None,
        "status": "done",
        "total": 1,
        "done": 1,
        "rendered": 1,
        "errors": [],
    }

    release.clear()
    started.clear()
    second_state = export_jobs.start_render_missing_job(20, [2], None)
    assert started.wait(timeout=5)
    assert second_state["status"] == "running"
    release.set()
