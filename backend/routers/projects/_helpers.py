# 路由層共用工具
# 供 projects 套件內各子模組引用，避免重複定義

import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user  # noqa: F401 — re-export
from crud.user_crud import get_subordinate_user_ids
from database import Project, User

# label_texts 格式支援舊版 {label_id_str: text_str}，
# 以及新版 {label_id_str: {"text": text_str, "text_align": "left|center|right"}}
LabelTextsPayload = dict[str, Any]


def _parse_json_field(raw: str, field_name: str = "欄位") -> Any:
    """安全解析 JSON 欄位，格式損壞時回傳 422 而非 500。"""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=422, detail=f"資料庫中的 {field_name} JSON 格式損壞，請聯絡管理員")


def assert_project_readable(
    project: Project,
    current_user: User,
    db: Session,
    subordinate_ids: set[int] | None = None,
):
    """
    確認目前使用者有權限讀取此專案，否則拋出 403。

    - admin：可讀全部
    - art_team：可讀全部（唯讀）
    - supervisor：只能讀自己的專案與自己管轄老師的專案
    - teacher：只能讀自己的專案

    subordinate_ids 可由外部傳入（已查好時），避免同一 request 重複查詢。
    """
    if current_user.role == "admin":
        return
    if current_user.role == "art_team":
        return
    if current_user.role == "supervisor":
        if project.owner_id == current_user.id:
            return
        if subordinate_ids is None:
            subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        if project.owner_id in subordinate_ids:
            return
    if current_user.role == "teacher" and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的存取權限")


def assert_comment_deletable(comment, current_user: User):
    """確認目前使用者有權限刪除此留言，否則拋出 403。admin 可刪任何人的留言。"""
    if current_user.role == "admin":
        return
    if comment.author_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="只能刪除自己的留言")


def assert_project_writable(project: Project, current_user: User):
    """
    確認目前使用者有權限修改此專案，否則拋出 403。

    - admin：可修改全部
    - teacher / supervisor：只能修改自己的專案
    - 其他角色：禁止
    """
    if current_user.role == "admin":
        return
    if current_user.role in ("teacher", "supervisor") and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的編輯權限")


def assert_project_content_writable(project: Project, current_user: User):
    """確認可修改專案「內容」（名單、照片、文字、頁面跳過）。

    在 assert_project_writable 之上多擋一層：專案標記完成後內容鎖定，
    非 admin 一律 403（渲染與下載不算內容修改，仍走 assert_project_writable）。
    """
    assert_project_writable(project, current_user)
    if project.completed_at is not None and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="專案已標記完成，內容已鎖定；需主管或管理員退回才能修改")


def assert_project_completion_revertible(project: Project, current_user: User, db: Session):
    """確認可退回「已完成」標記：admin 或管轄該老師的 supervisor（含主管自己的專案）。"""
    if current_user.role == "admin":
        return
    if current_user.role == "supervisor":
        if project.owner_id == current_user.id:
            return
        if project.owner_id in get_subordinate_user_ids(current_user.id, db):
            return
    raise HTTPException(status_code=403, detail="只有主管或管理員能退回已完成的專案")
