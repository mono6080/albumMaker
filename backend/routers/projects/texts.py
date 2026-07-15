# 對應文字路由
# 處理專案層級與學生個人的對應文字讀取、更新與批次更新

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404
from database import User, get_db
from services.project_text_service import (
    batch_update_texts as batch_update_texts_use_case,
    update_project_label_texts as update_project_label_texts_use_case,
    update_student_label_texts as update_student_label_texts_use_case,
)

from ._helpers import (
    LabelTextsPayload,
    _parse_json_field,
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
    expected_template_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新專案層級的對應文字設定。格式：{page_index: {label_id: text}}"""
    return update_project_label_texts_use_case(
        db,
        current_user,
        project_id,
        payload,
        expected_template_revision,
    )


@router.put("/{project_id}/students/{student_id}/pages/{page_index}/texts")
def update_student_label_texts(
    project_id: int,
    student_id: int,
    page_index: int,
    texts: LabelTextsPayload,
    expected_template_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新學生指定頁面的個人對應文字。"""
    return update_student_label_texts_use_case(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        texts,
        expected_template_revision,
    )


@router.put("/{project_id}/batch/texts")
def batch_update_texts(
    project_id: int,
    payload: BatchTextsPayload,
    expected_template_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次更新多位學生的對應文字。"""
    return batch_update_texts_use_case(
        db,
        current_user,
        project_id,
        payload.students,
        expected_template_revision,
    )
