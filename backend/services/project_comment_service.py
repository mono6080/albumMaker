"""專案審閱留言 mutation use cases。"""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404
from database import ProjectComment, User
from services.project_access_service import assert_comment_deletable, assert_project_readable


def add_comment(
    db: Session,
    current_user: User,
    project_id: int,
    content: str,
) -> dict:
    """驗證可讀權限與內容後，以單次 transaction 新增留言。"""
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


def delete_comment(
    db: Session,
    current_user: User,
    project_id: int,
    comment_id: int,
) -> dict:
    """刪除同專案留言，維持原有 404 與作者權限。"""
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
