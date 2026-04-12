# 認證路由模組
# 提供登入與取得當前使用者資訊的端點

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from auth import create_access_token, get_current_user, verify_password
from crud.user_crud import get_user_by_username
from database import User, get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login")
def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """登入並回傳 JWT access token。"""
    target_user = get_user_by_username(form_data.username, db)
    if not target_user or not verify_password(form_data.password, target_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="帳號或密碼錯誤",
        )
    if target_user.role == "none":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="此帳號尚未獲得任何權限，請聯絡管理員",
        )
    access_token = create_access_token(
        user_id=target_user.id,
        username=target_user.username,
        role=target_user.role,
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "role": target_user.role,
        "display_name": target_user.display_name,
        "user_id": target_user.id,
    }


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    """回傳當前登入使用者的基本資訊。"""
    return {
        "id": current_user.id,
        "username": current_user.username,
        "display_name": current_user.display_name,
        "role": current_user.role,
        "supervisor_id": current_user.supervisor_id,
    }
