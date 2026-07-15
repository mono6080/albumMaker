# 路由層共用工具
# 供 projects 套件內各子模組引用，避免重複定義

import json
from typing import Any

from fastapi import HTTPException
from auth import get_current_user  # noqa: F401 — re-export
from database import User
from services.project_access_service import (
    assert_project_completion_revertible as assert_project_completion_revertible,
    assert_project_content_writable as assert_project_content_writable,
    assert_project_readable as assert_project_readable,
    assert_project_writable as assert_project_writable,
)

# label_texts 格式支援舊版 {label_id_str: text_str}，
# 以及新版 {label_id_str: {"text": text_str, "text_align": "left|center|right"}}
LabelTextsPayload = dict[str, Any]


def _parse_json_field(raw: str, field_name: str = "欄位") -> Any:
    """安全解析 JSON 欄位，格式損壞時回傳 422 而非 500。"""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=422, detail=f"資料庫中的 {field_name} JSON 格式損壞，請聯絡管理員")


def assert_comment_deletable(comment, current_user: User):
    """確認目前使用者有權限刪除此留言，否則拋出 403。admin 可刪任何人的留言。"""
    if current_user.role == "admin":
        return
    if comment.author_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="只能刪除自己的留言")
