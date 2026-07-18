# 審閱留言路由
# 處理專案留言的列表、新增與刪除

from fastapi import APIRouter, Depends, Form
from sqlalchemy.orm import Session

from auth import get_current_user
from database import User, get_db
from services.project_comment_service import (
    add_comment as add_comment_use_case,
    delete_comment as delete_comment_use_case,
    list_comments as list_comments_use_case,
)

from .schemas import CommentOut

router = APIRouter()


@router.get("/{project_id}/comments", response_model=list[CommentOut])
def list_comments(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案的所有審閱留言（依時間升序）。"""
    return list_comments_use_case(db, current_user, project_id)


@router.post("/{project_id}/comments", response_model=CommentOut, status_code=201)
def add_comment(
    project_id: int,
    content: str = Form(..., max_length=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """新增審閱意見（限 admin、美學組或該專案主管 scope）。"""
    return add_comment_use_case(db, current_user, project_id, content)


@router.delete("/{project_id}/comments/{comment_id}")
def delete_comment(
    project_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除留言（只能刪自己的留言，admin 可刪任何人的）。"""
    return delete_comment_use_case(db, current_user, project_id, comment_id)
