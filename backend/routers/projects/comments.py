# 審閱留言路由
# 處理專案留言的列表、新增與刪除

from fastapi import APIRouter, Depends, Form
from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user, require_role
from crud.project_crud import get_project_or_404
from database import ProjectComment, User, get_db

from ._helpers import assert_comment_deletable, assert_project_readable
from .schemas import CommentOut

router = APIRouter()


@router.get("/{project_id}/comments", response_model=list[CommentOut])
def list_comments(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """取得專案的所有審閱留言（依時間升序）。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    comments = (
        db.query(ProjectComment)
        .options(joinedload(ProjectComment.author))
        .filter(ProjectComment.project_id == project_id)
        .order_by(ProjectComment.created_at)
        .all()
    )
    return [
        {
            "id": comment.id,
            "author_id": comment.author_id,
            "author_name": comment.author.display_name,
            "content": comment.content,
            "created_at": comment.created_at,
        }
        for comment in comments
    ]


@router.post("/{project_id}/comments", status_code=201)
def add_comment(
    project_id: int,
    content: str = Form(..., max_length=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "art_team", "supervisor")),
):
    """新增審閱意見（限 admin、美學組、主管）。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)

    if not content.strip():
        raise HTTPException(status_code=400, detail="留言內容不可為空")

    new_comment = ProjectComment(
        project_id=project_id,
        author_id=current_user.id,
        content=content.strip(),
    )
    db.add(new_comment)
    db.commit()
    db.refresh(new_comment)

    return {
        "id": new_comment.id,
        "author_id": new_comment.author_id,
        "author_name": current_user.display_name,
        "content": new_comment.content,
        "created_at": new_comment.created_at,
    }


@router.delete("/{project_id}/comments/{comment_id}")
def delete_comment(
    project_id: int,
    comment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除留言（只能刪自己的留言，admin 可刪任何人的）。"""
    comment = db.query(ProjectComment).filter(
        ProjectComment.id == comment_id,
        ProjectComment.project_id == project_id,
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="留言不存在")
    assert_comment_deletable(comment, current_user)
    db.delete(comment)
    db.commit()
    return {"ok": True}
