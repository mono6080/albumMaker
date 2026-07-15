# 使用者管理路由模組
# 所有端點僅限 admin 角色存取；業務邏輯下移 services/user_service.py

from io import BytesIO

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from openpyxl import load_workbook
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session, joinedload, selectinload

from auth import get_current_user, require_role
from crud.user_crud import serialize_user_identity
from database import User, get_db
from services.user_service import (
    create_user as create_user_use_case,
    delete_user as delete_user_use_case,
    import_users_from_workbook,
    update_current_user_settings,
    update_user as update_user_use_case,
)

router = APIRouter(prefix="/api/users", tags=["users"])


class CreateUserBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    display_name: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=8, max_length=100)
    role: str
    supervisor_id: int | None = None
    supervisor_ids: list[int] | None = None


class UpdateUserBody(BaseModel):
    username: str | None = Field(None, min_length=1, max_length=50)
    display_name: str | None = Field(None, min_length=1, max_length=50)
    role: str | None = None
    supervisor_id: int | None = None
    supervisor_ids: list[int] | None = None
    new_password: str | None = Field(None, min_length=8, max_length=100)
    clear_supervisor: bool = False


class UpdateMySettingsBody(BaseModel):
    ui_font_scale: float = Field(..., ge=0.9, le=1.25)


@router.get("/")
def list_users(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """列出所有使用者（含主管顯示名稱）。"""
    all_users = (
        db.query(User)
        .options(joinedload(User.supervisor), selectinload(User.supervisors))
        .order_by(User.created_at)
        .all()
    )
    return [_serialize_user(user) for user in all_users]


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_user(
    body: CreateUserBody,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """建立新使用者。帶班老師必須指定至少一位主管。"""
    new_user = create_user_use_case(
        db,
        username=body.username,
        display_name=body.display_name,
        password=body.password,
        role=body.role,
        supervisor_id=body.supervisor_id,
        supervisor_ids=body.supervisor_ids,
    )
    return _serialize_user(new_user)


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def import_users_from_excel(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin")),
):
    """從 .xlsx 檔批次建立使用者，逐列回報建立、略過與錯誤。"""
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=415, detail="僅支援 .xlsx Excel 檔")

    file_bytes = await file.read()
    if len(file_bytes) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="檔案過大，上限 5 MB")

    try:
        workbook = load_workbook(BytesIO(file_bytes), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Excel 檔案無法讀取")

    created, skipped, errors = import_users_from_workbook(db, workbook)
    return {
        "created_count": len(created),
        "skipped_count": len(skipped),
        "error_count": len(errors),
        "created": [{"row": row_number, "user": _serialize_user(user)} for row_number, user in created],
        "skipped": skipped,
        "errors": errors,
    }


@router.patch("/me/settings")
def update_my_settings(
    body: UpdateMySettingsBody,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新目前登入使用者自己的 UI 偏好。"""
    updated_user = update_current_user_settings(db, current_user, body.ui_font_scale)
    return serialize_user_identity(updated_user)


@router.patch("/{user_id}")
def update_user(
    user_id: int,
    body: UpdateUserBody,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    """修改使用者資料（顯示名稱、角色、主管、密碼重設）。"""
    target_user = update_user_use_case(
        db,
        user_id,
        username=body.username,
        display_name=body.display_name,
        role=body.role,
        supervisor_id=body.supervisor_id,
        supervisor_ids=body.supervisor_ids,
        new_password=body.new_password,
        clear_supervisor=body.clear_supervisor,
    )
    return _serialize_user(target_user)


@router.delete("/{user_id}")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_admin: User = Depends(require_role("admin")),
):
    """刪除使用者（不能刪除自己）。"""
    delete_user_use_case(db, current_admin, user_id)
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
        "ui_font_scale": float(user.ui_font_scale or 1.0),
        "created_at": user.created_at,
    }
