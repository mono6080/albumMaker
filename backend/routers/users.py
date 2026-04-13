# 使用者管理路由模組
# 所有端點僅限 admin 角色存取

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import hash_password, require_role
from crud.user_crud import get_user_or_404
from database import Project, User, get_db

router = APIRouter(prefix="/api/users", tags=["users"])

VALID_ROLES = {"admin", "art_team", "supervisor", "teacher", "none"}


class CreateUserBody(BaseModel):
    username: str
    display_name: str
    password: str
    role: str
    supervisor_id: int | None = None


class UpdateUserBody(BaseModel):
    username: str | None = None
    display_name: str | None = None
    role: str | None = None
    supervisor_id: int | None = None
    new_password: str | None = None
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
    """建立新使用者。帶班老師必須指定 supervisor_id。"""
    username = body.username
    display_name = body.display_name
    password = body.password
    role = body.role
    supervisor_id = body.supervisor_id

    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"無效角色，可用值：{', '.join(VALID_ROLES)}")

    # 帶班老師必須有主管
    if role == "teacher" and supervisor_id is None:
        raise HTTPException(status_code=400, detail="帶班老師必須指定主管")

    # 驗證主管 ID 存在且角色正確
    if supervisor_id is not None:
        supervisor = get_user_or_404(supervisor_id, db)
        if supervisor.role != "supervisor":
            raise HTTPException(status_code=400, detail="指定的主管必須是 supervisor 角色")

    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="帳號已存在")

    new_user = User(
        username=username,
        display_name=display_name,
        hashed_password=hash_password(password),
        role=role,
        supervisor_id=supervisor_id,
    )
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

    if body.role is not None:
        if body.role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"無效角色：{body.role}")
        target_user.role = body.role

    if body.supervisor_id is not None:
        supervisor = get_user_or_404(body.supervisor_id, db)
        if supervisor.role != "supervisor":
            raise HTTPException(status_code=400, detail="指定的主管必須是 supervisor 角色")
        target_user.supervisor_id = body.supervisor_id

    if body.clear_supervisor:
        target_user.supervisor_id = None

    if body.new_password is not None:
        target_user.hashed_password = hash_password(body.new_password)

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
    # 將被刪除使用者的專案移交給執行刪除的 admin
    db.query(Project).filter(Project.owner_id == user_id).update({"owner_id": current_admin.id})
    db.delete(target_user)
    db.commit()
    return {"ok": True}


def _serialize_user(user: User) -> dict:
    """將 User ORM 物件轉換為 API 回應格式。"""
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "supervisor_id": user.supervisor_id,
        "supervisor_name": user.supervisor.display_name if user.supervisor else None,
        "created_at": user.created_at,
    }
