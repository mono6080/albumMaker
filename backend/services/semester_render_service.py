"""學期缺漏相本的掃描與逐本補渲染。"""

import logging

from sqlalchemy.orm import Session

from database import Project, Student
from services.request_limiter import album_render_limiter
from services.semester_export_service import (
    load_export_projects,
    load_output_keys_by_project,
    student_pdf_key,
)
from services.storage_factory import get_storage
from services.student_render_service import render_and_save_student_album


logger = logging.getLogger(__name__)


def render_missing_semester_albums(
    db: Session,
    period_ids: list[int],
    roster_child_ids: list[int] | None = None,
    progress_callback=None,
) -> dict:
    """找出缺列印 PDF 的學生並逐本渲染；單本失敗不阻斷後續。"""
    storage = get_storage()
    selected_ids = set(roster_child_ids) if roster_child_ids is not None else None
    render_projects = load_export_projects(db, period_ids)
    output_keys_by_project = load_output_keys_by_project(storage, render_projects)

    missing_pairs: list[tuple[Project, Student]] = []
    for project in render_projects:
        existing_output_keys = output_keys_by_project[project.id]
        for student in project.students:
            if selected_ids is not None and student.roster_child_id not in selected_ids:
                continue
            pdf_key = student_pdf_key(student, "print")
            if pdf_key and pdf_key in existing_output_keys:
                continue
            missing_pairs.append((project, student))

    total_count = len(missing_pairs)
    if progress_callback:
        progress_callback(0, total_count)
    rendered_count = 0
    render_errors = []
    for done_count, (project, student) in enumerate(missing_pairs, start=1):
        try:
            # 每位各自取得渲染槽，避免背景 job 長時間阻塞老師的單本渲染。
            with album_render_limiter.acquire_blocking():
                render_and_save_student_album(project, student, project.id, db)
            rendered_count += 1
        except Exception as render_error:
            db.rollback()
            render_errors.append({
                "student": student.name,
                "project": project.name,
                "error": "產生失敗",
            })
            logger.error(
                "補渲染失敗 project_id=%s student=%s: %s",
                project.id,
                student.name,
                render_error,
            )
        if progress_callback:
            progress_callback(done_count, total_count)
    return {"rendered": rendered_count, "errors": render_errors}
