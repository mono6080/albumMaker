# 使用者 CRUD 輔助函式

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from database import User


def get_user_or_404(user_id: int, db: Session) -> User:
    """依 ID 取得使用者，不存在則回傳 HTTP 404。"""
    target_user = db.query(User).filter(User.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="使用者不存在")
    return target_user


def get_user_by_username(username: str, db: Session) -> User | None:
    """依帳號名稱查詢使用者，不存在回傳 None（供登入使用）。"""
    return db.query(User).filter(User.username == username).first()


def serialize_user_identity(user: User) -> dict:
    """使用者基本資訊序列化（登入/me 與個人設定回應共用）。"""
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "ui_font_scale": float(user.ui_font_scale or 1.0),
    }
