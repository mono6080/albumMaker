# 使用者 CRUD 輔助函式

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from database import User, teacher_supervisors

SUPERVISABLE_ROLES = {"teacher", "supervisor"}


def get_user_or_404(user_id: int, db: Session) -> User:
    """依 ID 取得使用者，不存在則回傳 HTTP 404。"""
    target_user = db.query(User).filter(User.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="使用者不存在")
    return target_user


def get_user_by_username(username: str, db: Session) -> User | None:
    """依帳號名稱查詢使用者，不存在回傳 None（供登入使用）。"""
    return db.query(User).filter(User.username == username).first()


def get_subordinate_user_ids(supervisor_id: int, db: Session) -> list[int]:
    """取得指定主管的所有受管理使用者 ID 清單。"""
    assigned_user_ids = {
        row[0]
        for row in db.query(teacher_supervisors.c.teacher_id)
        .join(User, User.id == teacher_supervisors.c.teacher_id)
        .filter(teacher_supervisors.c.supervisor_id == supervisor_id)
        .filter(User.role.in_(SUPERVISABLE_ROLES))
        .all()
    }
    legacy_user_ids = {
        row[0]
        for row in db.query(User.id)
        .filter(User.supervisor_id == supervisor_id)
        .filter(User.role.in_(SUPERVISABLE_ROLES))
        .all()
    }
    return sorted(assigned_user_ids | legacy_user_ids)
