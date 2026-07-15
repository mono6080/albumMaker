"""專案與學生對應文字 mutation use cases。"""

import json
from typing import Any

from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, utc_now
from services.project_access_service import assert_project_content_writable
from services.project_template_revision import lock_project_template_revision
from services.student_pages import ensure_page_entry, mutate_student_pages


def update_project_label_texts(
    db: Session,
    current_user: User,
    project_id: int,
    payload: dict[str, Any],
    expected_template_revision: int,
) -> dict:
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        project.label_texts_json = json.dumps(payload)
        project.updated_at = utc_now()
        db.commit()
    return {"ok": True}


def update_student_label_texts(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    texts: dict[str, Any],
    expected_template_revision: int,
) -> dict:
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)

        def _mutate(pages_data) -> None:
            ensure_page_entry(pages_data, page_index)["label_texts"] = texts
            now = utc_now()
            student.updated_at = now
            project.updated_at = now

        mutate_student_pages(db, student, _mutate)
    return {"ok": True}


def batch_update_texts(
    db: Session,
    current_user: User,
    project_id: int,
    students_payload: dict[str, dict[str, dict[str, Any]]],
    expected_template_revision: int,
) -> dict:
    """保留逐學生 commit、最後 project commit 的 partial-success 契約。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        now = utc_now()
        for student in project.students:
            student_id_str = str(student.id)
            if student_id_str not in students_payload:
                continue

            def _mutate(
                pages_data,
                student=student,
                payload_pages=students_payload[student_id_str],
            ) -> None:
                for page_index_str, label_texts in payload_pages.items():
                    ensure_page_entry(pages_data, int(page_index_str))["label_texts"] = label_texts
                student.updated_at = now
                project.updated_at = now

            mutate_student_pages(db, student, _mutate)

        project.updated_at = now
        db.commit()
    return {"ok": True}
