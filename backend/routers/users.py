# 使用者管理路由模組
# 所有端點僅限 admin 角色存取

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
from sqlalchemy.orm import Session

from auth import hash_password, require_role
from crud.user_crud import get_user_or_404
from database import Project, User, get_db, teacher_supervisors

router = APIRouter(prefix="/api/users", tags=["users"])

VALID_ROLES = {"admin", "art_team", "supervisor", "teacher", "none"}


class CreateUserBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    display_name: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=100)
    role: str
    supervisor_id: int | None = None
    supervisor_ids: list[int] | None = None


class UpdateUserBody(BaseModel):
    username: str | None = Field(None, min_length=1, max_length=50)
    display_name: str | None = Field(None, min_length=1, max_length=50)
    role: str | None = None
    supervisor_id: int | None = None
    supervisor_ids: list[int] | None = None
    new_password: str | None = Field(None, min_length=1, max_length=100)
    clear_supervisor: bool = False


@router.get("/")
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """列出所有使用者（含主管顯示名稱）。"""
    all_users = db.query(User).order_by(User.created_at).all()
    return [_serialize_user(user) for user in all_users]


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_user(
    body: CreateUserBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """建立新使用者。帶班老師必須指定至少一位主管。"""
    username = body.username
    display_name = body.display_name
    password = body.password.strip()
    role = body.role
    supervisor_ids = _normalize_supervisor_ids(body.supervisor_ids, body.supervisor_id)

    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"無效角色，可用值：{', '.join(VALID_ROLES)}")
    if not password:
        raise HTTPException(status_code=400, detail="密碼不能為空")

    # 帶班老師必須有主管
    if role == "teacher" and not supervisor_ids:
        raise HTTPException(status_code=400, detail="帶班老師必須指定主管")

    # 驗證主管 ID 存在且角色正確
    supervisors = _validate_supervisors(supervisor_ids, db) if role == "teacher" else []

    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="帳號已存在")

    new_user = User(
        username=username,
        display_name=display_name,
        hashed_password=hash_password(password),
        role=role,
        supervisor_id=supervisor_ids[0] if role == "teacher" and supervisor_ids else None,
    )
    if role == "teacher":
        new_user.supervisors = supervisors
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return _serialize_user(new_user)


@router.patch("/{user_id}")
def update_user(
    user_id: int,
    body: UpdateUserBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    """修改使用者資料（顯示名稱、角色、主管、密碼重設）。"""
    target_user = get_user_or_404(user_id, db)

    if body.username is not None:
        new_username = body.username.strip()
        if not new_username:
            raise HTTPException(status_code=400, detail="帳號不能為空")
        conflict = db.query(User).filter(User.username == new_username, User.id != user_id).first()
        if conflict:
            raise HTTPException(status_code=400, detail="帳號已存在")
        target_user.username = new_username

    if body.display_name is not None:
        target_user.display_name = body.display_name.strip()

    old_role = target_user.role

    if body.role is not None:
        if body.role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"無效角色：{body.role}")
        target_user.role = body.role

    normalized_supervisor_ids = None
    if body.supervisor_ids is not None or body.supervisor_id is not None:
        normalized_supervisor_ids = _normalize_supervisor_ids(body.supervisor_ids, body.supervisor_id)

    if normalized_supervisor_ids is not None:
        supervisors = _validate_supervisors(normalized_supervisor_ids, db)
        target_user.supervisors = supervisors
        target_user.supervisor_id = normalized_supervisor_ids[0] if normalized_supervisor_ids else None

    if body.clear_supervisor:
        target_user.supervisors = []
        target_user.supervisor_id = None

    if target_user.role != "teacher":
        target_user.supervisors = []
        target_user.supervisor_id = None

    if old_role == "supervisor" and target_user.role != "supervisor":
        _remove_supervisor_assignments(target_user.id, db)

    if body.new_password is not None:
        new_password = body.new_password.strip()
        if not new_password:
            raise HTTPException(status_code=400, detail="新密碼不能為空")
        target_user.hashed_password = hash_password(new_password)

    db.commit()
    db.refresh(target_user)
    return _serialize_user(target_user)


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    """刪除使用者（不能刪除自己）。"""
    if user_id == current_admin.id:
        raise HTTPException(status_code=400, detail="不能刪除自己的帳號")
    target_user = get_user_or_404(user_id, db)
    # 將被刪除使用者的專案移交給執行刪除的 admin，並記錄審計日誌
    transferred = db.query(Project).filter(Project.owner_id == user_id).count()
    if transferred:
        logger.warning(
            "使用者刪除：%s（id=%s）的 %s 個專案移交給 admin %s（id=%s）",
            target_user.username, user_id, transferred,
            current_admin.username, current_admin.id,
        )
    db.query(Project).filter(Project.owner_id == user_id).update({"owner_id": current_admin.id})
    db.execute(
        teacher_supervisors.delete().where(teacher_supervisors.c.teacher_id == user_id)
    )
    _remove_supervisor_assignments(user_id, db)
    db.delete(target_user)
    db.commit()
    return {"ok": True}


def _serialize_user(user: User) -> dict:
    """將 User ORM 物件轉換為 API 回應格式。"""
    supervisors_by_id = {supervisor.id: supervisor for supervisor in user.supervisors}
    if user.supervisor:
        supervisors_by_id[user.supervisor.id] = user.supervisor
    supervisors = []
    if user.supervisor_id in supervisors_by_id:
        supervisors.append(supervisors_by_id.pop(user.supervisor_id))
    supervisors.extend(
        supervisor
        for _, supervisor in sorted(supervisors_by_id.items(), key=lambda item: item[0])
    )
    supervisor_ids = [supervisor.id for supervisor in supervisors]
    supervisor_names = [supervisor.display_name for supervisor in supervisors]
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "supervisor_id": supervisor_ids[0] if supervisor_ids else None,
        "supervisor_ids": supervisor_ids,
        "supervisor_name": "、".join(supervisor_names) if supervisor_names else None,
        "supervisor_names": supervisor_names,
        "created_at": user.created_at,
    }


def _normalize_supervisor_ids(supervisor_ids: list[int] | None, supervisor_id: int | None) -> list[int]:
    normalized = []
    for raw_id in supervisor_ids or []:
        if raw_id not in normalized:
            normalized.append(raw_id)
    if supervisor_id is not None and supervisor_id not in normalized:
        normalized.append(supervisor_id)
    return normalized


def _validate_supervisors(supervisor_ids: list[int], db: Session) -> list[User]:
    supervisors = []
    for supervisor_id in supervisor_ids:
        supervisor = get_user_or_404(supervisor_id, db)
        if supervisor.role != "supervisor":
            raise HTTPException(status_code=400, detail="指定的主管必須是 supervisor 角色")
        supervisors.append(supervisor)
    return supervisors


def _remove_supervisor_assignments(supervisor_id: int, db: Session) -> None:
    """移除某主管對老師的管理關係，並把 legacy supervisor_id 改指向剩餘主管。"""
    affected_teachers = db.query(User).filter(User.supervisor_id == supervisor_id).all()
    db.execute(
        teacher_supervisors.delete().where(
            teacher_supervisors.c.supervisor_id == supervisor_id
        )
    )
    for teacher in affected_teachers:
        next_supervisor = (
            db.query(teacher_supervisors.c.supervisor_id)
            .filter(teacher_supervisors.c.teacher_id == teacher.id)
            .order_by(teacher_supervisors.c.supervisor_id)
            .first()
        )
        teacher.supervisor_id = next_supervisor[0] if next_supervisor else None
