"""專案讀寫與完成狀態權限規則的唯一 owner。"""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.user_crud import get_subordinate_user_ids
from database import Project, User


def assert_project_readable(
    project: Project,
    current_user: User,
    db: Session,
    subordinate_ids: set[int] | None = None,
) -> None:
    """確認目前使用者有權限讀取此專案。"""
    if current_user.role in {"admin", "art_team"}:
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


def assert_project_writable(project: Project, current_user: User) -> None:
    """確認目前使用者有權限修改此專案。"""
    if current_user.role == "admin":
        return
    if current_user.role in ("teacher", "supervisor") and project.owner_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="無此專案的編輯權限")


def assert_project_content_writable(project: Project, current_user: User) -> None:
    """確認可修改專案內容，並套用完成後的內容鎖定。"""
    assert_project_writable(project, current_user)
    if project.completed_at is not None and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="專案已標記完成，內容已鎖定；需主管或管理員退回才能修改")


def assert_project_completion_revertible(
    project: Project,
    current_user: User,
    db: Session,
) -> None:
    """確認可退回「已完成」標記。"""
    if current_user.role == "admin":
        return
    if current_user.role == "supervisor":
        if project.owner_id == current_user.id:
            return
        if project.owner_id in get_subordinate_user_ids(current_user.id, db):
            return
    raise HTTPException(status_code=403, detail="只有主管或管理員能退回已完成的專案")
