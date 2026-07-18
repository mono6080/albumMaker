"""專案與學生對應文字 mutation use cases。"""

import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, utc_now
from services.label_texts import validate_page_label_texts
from services.project_access_service import assert_project_content_writable
from services.project_template_revision import lock_project_template_revision
from services.student_pages import (
    coerce_page_index_for_write,
    ensure_page_entry,
    mutate_student_pages,
)


def _normalize_project_label_payload(
    payload: dict[str, Any],
    *,
    template_page_count: int,
) -> dict[str, dict[str, Any]]:
    normalized: dict[str, dict[str, Any]] = {}
    for raw_page_index, page_label_texts in payload.items():
        page_index = coerce_page_index_for_write(
            raw_page_index,
            field="label_texts page index",
        )
        if page_index >= template_page_count:
            raise HTTPException(
                status_code=422,
                detail=f"label_texts page index {page_index} 超出模板頁面範圍",
            )
        normalized_key = str(page_index)
        if normalized_key in normalized:
            raise HTTPException(
                status_code=422,
                detail=f"label_texts page index {raw_page_index} 重複",
            )
        normalized[normalized_key] = validate_page_label_texts(
            page_label_texts,
            path=f"label_texts.{raw_page_index}",
        )
    return normalized


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
        normalized_payload = _normalize_project_label_payload(
            payload,
            template_page_count=len(project.template.pages),
        )
        project.label_texts_json = json.dumps(normalized_payload)
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
        validate_page_label_texts(texts)

        def _mutate(pages_data) -> None:
            ensure_page_entry(pages_data, page_index)["label_texts"] = texts
            now = utc_now()
            student.updated_at = now
            project.updated_at = now

        mutate_student_pages(
            db,
            student,
            _mutate,
            page_indices=[page_index],
            template_page_count=len(project.template.pages),
        )
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
        template_page_count = len(project.template.pages)
        normalized_students_payload: dict[str, dict[int, dict[str, Any]]] = {}
        for student_id_text, payload_pages in students_payload.items():
            if not isinstance(student_id_text, str) or not student_id_text.isdigit():
                raise HTTPException(status_code=422, detail="students key 必須是學生 ID")
            normalized_pages: dict[int, dict[str, Any]] = {}
            for raw_page_index, page_label_texts in payload_pages.items():
                page_index = coerce_page_index_for_write(
                    raw_page_index,
                    field="batch texts page index",
                )
                if page_index >= template_page_count:
                    raise HTTPException(
                        status_code=422,
                        detail=f"batch texts page index {page_index} 超出模板頁面範圍",
                    )
                if page_index in normalized_pages:
                    raise HTTPException(
                        status_code=422,
                        detail=f"batch texts page index {raw_page_index} 重複",
                    )
                normalized_pages[page_index] = validate_page_label_texts(
                    page_label_texts,
                    path=f"students.{student_id_text}.{raw_page_index}",
                )
            normalized_students_payload[student_id_text] = normalized_pages

        now = utc_now()
        for student in project.students:
            student_id_str = str(student.id)
            if student_id_str not in normalized_students_payload:
                continue

            def _mutate(
                pages_data,
                student=student,
                payload_pages=normalized_students_payload[student_id_str],
            ) -> None:
                for page_index, label_texts in payload_pages.items():
                    ensure_page_entry(pages_data, page_index)["label_texts"] = label_texts
                student.updated_at = now
                project.updated_at = now

            mutate_student_pages(
                db,
                student,
                _mutate,
                page_indices=normalized_students_payload[student_id_str],
                template_page_count=template_page_count,
            )

        project.updated_at = now
        db.commit()
    return {"ok": True}
