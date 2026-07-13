# 對應文字路由
# 處理專案層級與學生個人的對應文字讀取、更新與批次更新

import json
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db, utc_now

from services.student_pages import ensure_page_entry, mutate_student_pages

from ._helpers import (
    LabelTextsPayload,
    _parse_json_field,
    assert_project_content_writable,
    assert_project_readable,
)
from .schemas import BatchTextsPayload

router = APIRouter()


@router.get("/{project_id}/label_texts")
def get_project_label_texts(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案層級的對應文字設定。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    return _parse_json_field(project.label_texts_json or "{}", "label_texts_json")


@router.put("/{project_id}/label_texts")
def update_project_label_texts(
    project_id: int,
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新專案層級的對應文字設定。格式：{page_index: {label_id: text}}"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    project.label_texts_json = json.dumps(payload)
    project.updated_at = utc_now()
    db.commit()
    return {"ok": True}


@router.put("/{project_id}/students/{student_id}/pages/{page_index}/texts")
def update_student_label_texts(
    project_id: int,
    student_id: int,
    page_index: int,
    texts: LabelTextsPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新學生指定頁面的個人對應文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    # 進學生寫鎖：文字自動儲存與照片上傳併發打同一學生時不互相蓋寫 pages_data
    def _mutate(pages_data) -> None:
        ensure_page_entry(pages_data, page_index)["label_texts"] = texts
        now = utc_now()
        student.updated_at = now
        project.updated_at = now

    mutate_student_pages(db, student, _mutate)
    return {"ok": True}


@router.put("/{project_id}/batch/texts")
def batch_update_texts(
    project_id: int,
    payload: BatchTextsPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次更新多位學生的對應文字。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    students_payload = payload.students
    now = utc_now()

    # 逐學生進寫鎖並 commit（交易粒度從整批一次變逐學生一次，
    # 換取與照片上傳併發時不互相蓋寫 pages_data）
    for student in project.students:
        student_id_str = str(student.id)
        if student_id_str not in students_payload:
            continue

        def _mutate(pages_data, student=student, payload_pages=students_payload[student_id_str]) -> None:
            for page_index_str, label_texts in payload_pages.items():
                ensure_page_entry(pages_data, int(page_index_str))["label_texts"] = label_texts
            student.updated_at = now
            project.updated_at = now

        mutate_student_pages(db, student, _mutate)

    # 沒有任何學生命中 payload 時仍維持舊行為：更新專案時間戳
    project.updated_at = now
    db.commit()
    return {"ok": True}
