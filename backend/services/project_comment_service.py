"""專案審閱留言 mutation use cases。"""

from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload

from crud.project_crud import get_project_or_404
from database import ProjectComment, User
from services.organization_lock import organization_acl_lock
from services.project_access_service import (
    assert_comment_deletable,
    assert_project_commentable,
    assert_project_readable,
)
from services.template_sync_locks import lock_project_content_writes


def list_comments(
    db: Session,
    current_user: User,
    project_id: int,
) -> list[dict]:
    """依專案 object policy 讀取留言。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    comments = db.query(ProjectComment).options(
        joinedload(ProjectComment.author)
    ).filter(
        ProjectComment.project_id == project_id
    ).order_by(ProjectComment.created_at).all()
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


def add_comment(
    db: Session,
    current_user: User,
    project_id: int,
    content: str,
) -> dict:
    """驗證審閱權限與內容後，以單次 transaction 新增留言。"""
    project = get_project_or_404(project_id, db)
    assert_project_commentable(project, current_user, db)
    if not content.strip():
        raise HTTPException(status_code=400, detail="留言內容不可為空")

    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_commentable(project, current_user, db)
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


def delete_comment(
    db: Session,
    current_user: User,
    project_id: int,
    comment_id: int,
) -> dict:
    """先驗專案讀取權，再查留言，避免 direct-id 洩漏。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_readable(project, current_user, db)
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
