# auth 模組基礎驗證
# 涵蓋密碼雜湊雙向驗證、JWT 編解碼來回，以及無效 token 應拋 401

import pytest
from fastapi import HTTPException

from auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


def test_password_roundtrip():
    """正確密碼可通過驗證；錯誤密碼必須回傳 False。"""
    hashed = hash_password("hunter2")
    assert verify_password("hunter2", hashed) is True
    assert verify_password("wrong-password", hashed) is False


def test_jwt_roundtrip():
    """create_access_token 產生的 token 經 decode 後應還原原始欄位。"""
    token = create_access_token(1, "alice", "admin", auth_version=3)
    payload = decode_access_token(token)
    assert payload["sub"] == "1"
    assert payload["username"] == "alice"
    assert payload["role"] == "admin"
    assert payload["ver"] == 3


def test_jwt_invalid_token_raises_401():
    """無效 token 應拋出 HTTPException 401。"""
    with pytest.raises(HTTPException) as exc_info:
        decode_access_token("not-a-real-token")
    assert exc_info.value.status_code == 401
