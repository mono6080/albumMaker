# 認證路由模組
# 提供登入、登出與取得當前使用者資訊的端點

import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from auth import create_access_token, get_current_user, verify_password
from crud.user_crud import get_user_by_username, serialize_user_identity
from database import User, get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])
limiter = Limiter(key_func=get_remote_address)

# 正式環境（PRODUCTION=1）啟用 Secure 旗標，確保 Cookie 只走 HTTPS
_IS_PRODUCTION = bool(os.environ.get("PRODUCTION"))
_COOKIE_MAX_AGE = 7 * 24 * 3600  # 7 天，與 JWT 有效期一致


@router.post("/login")
@limiter.limit("10/minute")
def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """登入：驗證帳密後以 HttpOnly Cookie 回傳 JWT，同時回傳使用者基本資訊。"""
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
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        samesite="lax",
        secure=_IS_PRODUCTION,
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )
    return {
        **serialize_user_identity(target_user),
        "user_id": target_user.id,
    }


@router.post("/logout")
def logout(response: Response):
    """登出：清除認證 Cookie。"""
    response.delete_cookie(key="access_token", path="/", samesite="lax")
    return {"ok": True}


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    """回傳當前登入使用者的基本資訊。"""
    return serialize_user_identity(current_user)
