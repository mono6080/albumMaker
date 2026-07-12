# 使用者管理業務邏輯（users router 的下層）
# Excel 批次匯入、使用者建立/更新規則、主管關係維護

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from auth import hash_password
from crud.user_crud import SUPERVISABLE_ROLES, get_user_or_404
from database import User, teacher_supervisors

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


def import_users_from_workbook(db: Session, workbook) -> tuple[list, list, list]:
    """解析 Excel workbook 逐列建立使用者，回傳 (created, skipped, errors)。

    created 為 (row_number, User) 清單，序列化由呼叫端（router）負責。
    """
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

    created: list[tuple[int, User]] = []
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
            supervisor_ids = _resolve_supervisor_tokens(supervisor_tokens, db) if role in SUPERVISABLE_ROLES else []

            new_user = create_user_record(
                db,
                username=username,
                display_name=_cell_to_text(_row_value(row, column_map["display_name"])),
                password=_cell_to_text(_row_value(row, column_map["password"])),
                role=role,
                supervisor_ids=supervisor_ids,
            )
            db.flush()
            seen_usernames.add(username)
            created.append((row_number, new_user))
        except HTTPException as error:
            errors.append({"row": row_number, "username": username, "error": error.detail})
        except ValueError as error:
            errors.append({"row": row_number, "username": username, "error": str(error)})

    db.commit()
    return created, skipped, errors


def create_user_record(
    db: Session,
    *,
    username: str,
    display_name: str,
    password: str,
    role: str,
    supervisor_ids: list[int],
) -> User:
    """驗證欄位與主管關係後建立 User（不 commit，由呼叫端決定）。"""
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

    supervisors = _validate_supervisors(supervisor_ids, db) if role in SUPERVISABLE_ROLES else []

    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="帳號已存在")

    new_user = User(
        username=username,
        display_name=display_name,
        hashed_password=hash_password(password),
        role=role,
        supervisor_id=supervisor_ids[0] if role in SUPERVISABLE_ROLES and supervisor_ids else None,
    )
    if role in SUPERVISABLE_ROLES:
        new_user.supervisors = supervisors
    db.add(new_user)
    return new_user


def update_user_record(
    db: Session,
    target_user: User,
    *,
    username: str | None,
    display_name: str | None,
    role: str | None,
    supervisor_id: int | None,
    supervisor_ids: list[int] | None,
    new_password: str | None,
    clear_supervisor: bool,
) -> None:
    """套用使用者更新：角色轉換、主管關係重算、密碼重設（不 commit）。"""
    if username is not None:
        new_username = username.strip()
        if not new_username:
            raise HTTPException(status_code=400, detail="帳號不能為空")
        conflict = db.query(User).filter(User.username == new_username, User.id != target_user.id).first()
        if conflict:
            raise HTTPException(status_code=400, detail="帳號已存在")
        target_user.username = new_username

    if display_name is not None:
        target_user.display_name = display_name.strip()

    old_role = target_user.role

    if role is not None:
        next_role = _normalize_role(role)
        if next_role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail=f"無效角色：{role}")
        target_user.role = next_role

    normalized_supervisor_ids = None
    if supervisor_ids is not None or supervisor_id is not None:
        normalized_supervisor_ids = normalize_supervisor_ids(supervisor_ids, supervisor_id)

    if normalized_supervisor_ids is not None:
        if target_user.role not in SUPERVISABLE_ROLES and normalized_supervisor_ids:
            raise HTTPException(status_code=400, detail="只有帶班老師或主管可以指定主管")
        supervisors = _validate_supervisors(normalized_supervisor_ids, db, target_user_id=target_user.id)
        target_user.supervisors = supervisors
        target_user.supervisor_id = normalized_supervisor_ids[0] if normalized_supervisor_ids else None

    if clear_supervisor:
        target_user.supervisors = []
        target_user.supervisor_id = None

    if target_user.role not in SUPERVISABLE_ROLES:
        target_user.supervisors = []
        target_user.supervisor_id = None

    if old_role == "supervisor" and target_user.role != "supervisor":
        remove_supervisor_assignments(target_user.id, db)

    if new_password is not None:
        stripped_password = new_password.strip()
        if not stripped_password:
            raise HTTPException(status_code=400, detail="新密碼不能為空")
        target_user.hashed_password = hash_password(stripped_password)


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


def normalize_supervisor_ids(supervisor_ids: list[int] | None, supervisor_id: int | None) -> list[int]:
    """合併去重 supervisor_ids 與 legacy supervisor_id，保留原始順序。"""
    normalized = []
    for raw_id in supervisor_ids or []:
        if raw_id not in normalized:
            normalized.append(raw_id)
    if supervisor_id is not None and supervisor_id not in normalized:
        normalized.append(supervisor_id)
    return normalized


def _validate_supervisors(supervisor_ids: list[int], db: Session, target_user_id: int | None = None) -> list[User]:
    supervisors = []
    for supervisor_id in supervisor_ids:
        if target_user_id is not None and supervisor_id == target_user_id:
            raise HTTPException(status_code=400, detail="不能指定自己為主管")
        supervisor = get_user_or_404(supervisor_id, db)
        if supervisor.role != "supervisor":
            raise HTTPException(status_code=400, detail="指定的主管必須是 supervisor 角色")
        supervisors.append(supervisor)
    return supervisors


def remove_supervisor_assignments(supervisor_id: int, db: Session) -> None:
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
