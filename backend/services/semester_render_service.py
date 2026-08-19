"""正式學期缺漏相本的掃描與逐本補渲染。"""

import logging

from sqlalchemy.orm import Session

from database import Project, ProjectStudent
from services.request_limiter import album_render_limiter
from services.semester_export_service import (
    load_export_projects,
    load_output_keys_by_project,
    student_pdf_key,
)
from services.student_identity_anomaly import (
    classify_project_student_identity_anomalies,
)
from services.storage_factory import get_storage
from services.student_render_service import render_and_save_student_album


logger = logging.getLogger(__name__)


def render_missing_semester_albums(
    db: Session,
    semester_id: int,
    period_ids: list[int],
    roster_child_ids: list[int] | None = None,
    progress_callback=None,
) -> dict:
    """補產生唯一孩子期別的缺檔；duplicate 與身分異常一律跳過。"""
    selected_child_ids = (
        set(roster_child_ids) if roster_child_ids is not None else None
    )
    projects = load_export_projects(db, semester_id, period_ids)
    output_keys_by_project = load_output_keys_by_project(get_storage(), projects)

    candidates_by_child_period: dict[
        tuple[int, int],
        list[tuple[Project, ProjectStudent]],
    ] = {}
    for project in projects:
        identity_anomalies = classify_project_student_identity_anomalies(project)
        semester_period_id = project.class_period_work_slot.semester_period_id
        for student in project.students:
            if student.id in identity_anomalies:
                continue
            if (
                selected_child_ids is not None
                and student.roster_child_id not in selected_child_ids
            ):
                continue
            candidates_by_child_period.setdefault(
                (student.roster_child_id, semester_period_id),
                [],
            ).append((project, student))

    render_errors = []
    missing_pairs = []
    for candidates in candidates_by_child_period.values():
        if len(candidates) > 1:
            project_ids = sorted({project.id for project, _ in candidates})
            render_errors.append({
                "student": candidates[0][1].name,
                "project": "、".join(str(project_id) for project_id in project_ids),
                "error": "同一期有重複相本，未產生",
                "code": "duplicate",
            })
            continue
        project, student = candidates[0]
        print_pdf_key = student_pdf_key(student, "print")
        if (
            print_pdf_key
            and print_pdf_key in output_keys_by_project.get(project.id, set())
        ):
            continue
        missing_pairs.append((project, student))

    total_count = len(missing_pairs)
    if progress_callback:
        progress_callback(0, total_count)
    rendered_count = 0
    for done_count, (project, student) in enumerate(missing_pairs, start=1):
        try:
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
