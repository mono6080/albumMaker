# 使用者管理路由模組
# 所有端點僅限 admin 角色存取

import logging
import re
from io import BytesIO

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from openpyxl import load_workbook
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
from sqlalchemy.orm import Session

from auth import hash_password, require_role
from crud.user_crud import get_user_or_404
from database import Project, User, get_db, teacher_supervisors

router = APIRouter(prefix="/api/users", tags=["users"])

VALID_ROLES = {"admin", "art_team", "supervisor", "teacher", "none"}
ROLE_ALIASES = {
    "admin": "admin",
    "管理員": "admin",
    "管理员": "admin",
    "art_team": "art_team",
    "art team": "art_team",
    "設計": "art_team",
    "設計師": "art_team",
    "美學組": "art_team",
    "supervisor": "supervisor",
    "主管": "supervisor",
    "teacher": "teacher",
    "帶班老師": "teacher",
    "老師": "teacher",
    "老师": "teacher",
    "none": "none",
    "無權限": "none",
    "无权限": "none",
}
IMPORT_HEADER_ALIASES = {
    "username": {"username", "account", "帳號", "账号"},
    "display_name": {"display_name", "display name", "name", "顯示名稱", "显示名称", "姓名", "名稱", "名称"},
    "password": {"password", "密碼", "密码", "初始密碼", "初始密码"},
    "role": {"role", "角色"},
    "supervisor": {
        "supervisor",
        "supervisor_username",
        "supervisor_usernames",
        "supervisors",
        "主管",
        "主管帳號",
        "主管账号",
    },
}


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
    supervisor_ids = _normalize_supervisor_ids(body.supervisor_ids, body.supervisor_id)
    new_user = _create_user_record(
        db,
        username=body.username,
        display_name=body.display_name,
        password=body.password,
        role=body.role,
        supervisor_ids=supervisor_ids,
    )
    db.commit()
    db.refresh(new_user)
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

    sheet = workbook.active
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        raise HTTPException(status_code=400, detail="Excel 內容為空")

    column_map = _build_import_column_map(rows[0])
    missing_columns = [
        field
        for field in ("username", "display_name", "password", "role")
        if field not in column_map
    ]
    if missing_columns:
        raise HTTPException(status_code=400, detail=f"缺少欄位：{', '.join(missing_columns)}")

    created = []
    skipped = []
    errors = []
    seen_usernames = set()

    for row_number, row in enumerate(rows[1:], start=2):
        if not any(_cell_to_text(value) for value in row):
            continue

        username = _cell_to_text(_row_value(row, column_map["username"]))
        try:
            if not username:
                raise ValueError("帳號不能為空")
            if username in seen_usernames:
                skipped.append({"row": row_number, "username": username, "reason": "Excel 內帳號重複"})
                continue
            if db.query(User).filter(User.username == username).first():
                skipped.append({"row": row_number, "username": username, "reason": "帳號已存在"})
                seen_usernames.add(username)
                continue

            role = _normalize_role(_cell_to_text(_row_value(row, column_map["role"])))
            supervisor_tokens = _split_supervisor_tokens(
                _cell_to_text(_row_value(row, column_map.get("supervisor")))
            )
            supervisor_ids = _resolve_supervisor_tokens(supervisor_tokens, db) if role == "teacher" else []

            new_user = _create_user_record(
                db,
                username=username,
                display_name=_cell_to_text(_row_value(row, column_map["display_name"])),
                password=_cell_to_text(_row_value(row, column_map["password"])),
                role=role,
                supervisor_ids=supervisor_ids,
            )
            db.flush()
            seen_usernames.add(username)
            created.append({"row": row_number, "user": _serialize_user(new_user)})
        except HTTPException as error:
            errors.append({"row": row_number, "username": username, "error": error.detail})
        except ValueError as error:
            errors.append({"row": row_number, "username": username, "error": str(error)})

    db.commit()
    return {
        "created_count": len(created),
        "skipped_count": len(skipped),
        "error_count": len(errors),
        "created": created,
        "skipped": skipped,
        "errors": errors,
    }


def _create_user_record(
    db: Session,
    *,
    username: str,
    display_name: str,
    password: str,
    role: str,
    supervisor_ids: list[int],
) -> User:
    username = username.strip()
    display_name = display_name.strip()
    password = password.strip()
    role = _normalize_role(role)

    if role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"無效角色，可用值：{', '.join(VALID_ROLES)}")
    if not username:
        raise HTTPException(status_code=400, detail="帳號不能為空")
    if not display_name:
        raise HTTPException(status_code=400, detail="顯示名稱不能為空")
    if not password:
        raise HTTPException(status_code=400, detail="密碼不能為空")

    if role == "teacher" and not supervisor_ids:
        raise HTTPException(status_code=400, detail="帶班老師必須指定主管")

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
    return new_user


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
        next_role = _normalize_role(body.role)
        if next_role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"無效角色：{body.role}")
        target_user.role = next_role

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


def _build_import_column_map(header_row: tuple) -> dict[str, int]:
    column_map = {}
    normalized_aliases = {
        field: {_normalize_header(alias) for alias in aliases}
        for field, aliases in IMPORT_HEADER_ALIASES.items()
    }
    for index, header in enumerate(header_row):
        normalized_header = _normalize_header(header)
        if not normalized_header:
            continue
        for field, aliases in normalized_aliases.items():
            if normalized_header in aliases and field not in column_map:
                column_map[field] = index
                break
    return column_map


def _normalize_header(value) -> str:
    return _cell_to_text(value).lower().replace(" ", "_").replace("-", "_")


def _cell_to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _row_value(row: tuple, column_index: int | None):
    if column_index is None or column_index >= len(row):
        return None
    return row[column_index]


def _normalize_role(role: str) -> str:
    key = _cell_to_text(role).lower()
    return ROLE_ALIASES.get(key, key)


def _split_supervisor_tokens(value: str) -> list[str]:
    return [
        token.strip()
        for token in re.split(r"[,，、;；\n]+", value or "")
        if token.strip()
    ]


def _resolve_supervisor_tokens(tokens: list[str], db: Session) -> list[int]:
    if not tokens:
        return []

    supervisor_ids = []
    for token in tokens:
        supervisor = db.query(User).filter(User.username == token).first()
        if supervisor is None:
            matches = db.query(User).filter(User.display_name == token).all()
            if len(matches) > 1:
                raise HTTPException(status_code=400, detail=f"主管名稱不唯一：{token}，請改填帳號")
            supervisor = matches[0] if matches else None
        if supervisor is None:
            raise HTTPException(status_code=400, detail=f"找不到主管：{token}")
        if supervisor.role != "supervisor":
            raise HTTPException(status_code=400, detail=f"{token} 不是主管角色")
        if supervisor.id not in supervisor_ids:
            supervisor_ids.append(supervisor.id)
    return supervisor_ids


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
