# 對應文字路由
# 處理專案層級與學生個人的對應文字讀取、更新與批次更新

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db

from ._helpers import (
    LabelTextsPayload,
    _parse_json_field,
    assert_project_readable,
    assert_project_writable,
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
    assert_project_writable(project, current_user)
    project.label_texts_json = json.dumps(payload)
    project.updated_at = datetime.utcnow()
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
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })

    pages_data[page_index]["label_texts"] = texts
    now = datetime.utcnow()
    student.pages_data_json = json.dumps(pages_data)
    student.updated_at = now
    project.updated_at = now
    db.commit()
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
    assert_project_writable(project, current_user)
    students_payload = payload.students
    now = datetime.utcnow()

    for student in project.students:
        student_id_str = str(student.id)
        if student_id_str not in students_payload:
            continue

        pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
        for page_index_str, label_texts in students_payload[student_id_str].items():
            page_index = int(page_index_str)
            while len(pages_data) <= page_index:
                pages_data.append({
                    "page_index": len(pages_data),
                    "photos": {},
                    "label_texts": {},
                })
            pages_data[page_index]["label_texts"] = label_texts

        student.pages_data_json = json.dumps(pages_data)
        student.updated_at = now

    project.updated_at = now
    db.commit()
    return {"ok": True}
