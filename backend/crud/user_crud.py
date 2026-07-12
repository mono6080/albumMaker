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


def get_visible_owner_ids(current_user: User, db: Session) -> list[int] | None:
    """目前使用者可見的專案 owner 集合；None 代表不過濾（admin/art_team）。"""
    if current_user.role in ("admin", "art_team"):
        return None
    if current_user.role == "supervisor":
        return get_subordinate_user_ids(current_user.id, db) + [current_user.id]
    if current_user.role == "teacher":
        return [current_user.id]
    return []


def serialize_user_identity(user: User) -> dict:
    """使用者基本資訊序列化（登入/me 與個人設定回應共用）。"""
    supervisor_ids = [supervisor.id for supervisor in user.supervisors]
    if not supervisor_ids and user.supervisor_id:
        supervisor_ids = [user.supervisor_id]
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "supervisor_id": user.supervisor_id,
        "supervisor_ids": supervisor_ids,
        "ui_font_scale": float(user.ui_font_scale or 1.0),
    }
