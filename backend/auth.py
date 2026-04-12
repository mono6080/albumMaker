# 認證核心模組
# 提供 JWT 產生/驗證、密碼雜湊，以及 FastAPI 依賴注入函式

import os
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import bcrypt as _bcrypt
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database import User, get_db

# ── 設定 ──────────────────────────────────────────────────────────────────────

# 正式部署時請透過環境變數 SECRET_KEY 設定強密鑰
SECRET_KEY = os.environ.get("SECRET_KEY", "album-maker-dev-secret-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

bearer_scheme = HTTPBearer(auto_error=False)

# ── 密碼工具 ──────────────────────────────────────────────────────────────────

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """驗證明文密碼是否符合雜湊值。"""
    return _bcrypt.checkpw(plain_password.encode(), hashed_password.encode())


def hash_password(plain_password: str) -> str:
    """將明文密碼轉換為 bcrypt 雜湊。"""
    return _bcrypt.hashpw(plain_password.encode(), _bcrypt.gensalt()).decode()


# ── JWT 工具 ──────────────────────────────────────────────────────────────────

def create_access_token(user_id: int, username: str, role: str) -> str:
    """產生包含使用者資訊的 JWT，有效期 ACCESS_TOKEN_EXPIRE_DAYS 天。"""
    expire_at = datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "exp": expire_at,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    """解碼並驗證 JWT，回傳 payload dict；無效時拋出 401。"""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token 無效或已過期",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ── FastAPI 依賴注入 ───────────────────────────────────────────────────────────

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """從 Authorization: Bearer <token> 取得並驗證當前使用者。"""
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="請先登入",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(credentials.credentials)
    user_id = int(payload.get("sub", 0))
    current_user = db.query(User).filter(User.id == user_id).first()
    if not current_user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="使用者不存在")
    return current_user


def require_role(*allowed_roles: str):
    """
    角色檢查依賴注入工廠。
    用法：Depends(require_role("admin", "art_team"))
    """
    def role_checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"此操作需要以下角色之一：{', '.join(allowed_roles)}",
            )
        return current_user
    return role_checker
