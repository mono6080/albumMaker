# 使用者管理業務邏輯（users router 的下層）
# Excel 批次匯入、使用者建立／更新與帳號生命週期規則

import logging

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from auth import hash_password
from crud.user_crud import get_user_or_404
from database import (
    ClassroomTeacherAssignment,
    OrganizationSupervisorAssignment,
    Project,
    ProjectComment,
    User,
    utc_now,
)
from services.organization_lock import organization_acl_lock
from services.project_assignment_service import (
    PROJECT_OWNER_ROLES,
    record_project_owner_transfer,
)
from services.template_sync_locks import lock_project_content_writes


logger = logging.getLogger(__name__)

VALID_ROLES = {"admin", "art_team", "supervisor", "teacher", "none"}
MIN_PASSWORD_LENGTH = 8
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
}


def create_user(
    db: Session,
    *,
    username: str,
    display_name: str,
    password: str,
    role: str,
) -> User:
    """建立使用者並以單一 transaction 提交。"""
    new_user = create_user_record(
        db,
        username=username,
        display_name=display_name,
        password=password,
        role=role,
    )
    db.commit()
    db.refresh(new_user)
    return new_user


def update_current_user_settings(db: Session, current_user: User, ui_font_scale: float) -> User:
    """更新目前使用者的 UI 偏好。"""
    current_user.ui_font_scale = round(float(ui_font_scale), 2)
    db.commit()
    db.refresh(current_user)
    return current_user


def update_user(
    db: Session,
    current_admin: User,
    user_id: int,
    *,
    username: str | None,
    display_name: str | None,
    role: str | None,
    new_password: str | None,
) -> User:
    """在組織鎖內更新帳號；角色變更另取得全部專案鎖。"""
    admin_id = current_admin.id
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        target_user = get_user_or_404(user_id, db)
        next_role = _normalize_role(role) if role is not None else target_user.role
        role_is_changing = next_role != target_user.role
        requires_project_locks = role_is_changing or (
            role is not None and next_role == "none"
        )
        project_ids = [
            row[0] for row in db.query(Project.id).all()
        ] if requires_project_locks else []
        with lock_project_content_writes(project_ids):
            _begin_immediate_write(db)
            try:
                target_user = get_user_or_404(user_id, db)
                current_admin = get_user_or_404(admin_id, db)
                update_user_record(
                    db,
                    target_user,
                    current_admin=current_admin,
                    username=username,
                    display_name=display_name,
                    role=role,
                    new_password=new_password,
                )
                db.commit()
            except Exception:
                db.rollback()
                raise
            db.refresh(target_user)
            return target_user


def delete_user(db: Session, current_admin: User, user_id: int) -> None:
    """刪除使用者，並在同一 transaction 移交專案與留言。"""
    if user_id == current_admin.id:
        raise HTTPException(status_code=400, detail="不能刪除自己的帳號")
    current_admin_id = current_admin.id
    with organization_acl_lock:
        all_project_ids = [row[0] for row in db.query(Project.id).all()]
        with lock_project_content_writes(all_project_ids):
            _begin_immediate_write(db)
            try:
                target_user = get_user_or_404(user_id, db)
                current_admin = get_user_or_404(current_admin_id, db)
                changed_at = utc_now()
                _end_organization_supervisor_assignments(
                    db, target_user.id, current_admin, "user_deleted", changed_at
                )
                _end_classroom_teacher_assignments(
                    db, target_user.id, current_admin, "user_deleted", changed_at
                )
                _transfer_owned_projects(
                    db,
                    target_user,
                    current_admin,
                    "刪除使用者時自動轉交",
                )
                _transfer_user_comments(db, target_user, current_admin)
                db.delete(target_user)
                db.commit()
            except Exception:
                db.rollback()
                raise


def _begin_immediate_write(db: Session) -> None:
    """在外層鎖都取得後，以最新 session 狀態開始 SQLite immediate write。"""
    db.rollback()
    db.expire_all()
    db.execute(text("BEGIN IMMEDIATE"))


def _end_organization_supervisor_assignments(
    db: Session,
    user_id: int,
    changed_by: User,
    reason: str,
    ended_at,
) -> None:
    assignments = db.query(OrganizationSupervisorAssignment).filter(
        OrganizationSupervisorAssignment.supervisor_id == user_id,
        OrganizationSupervisorAssignment.ended_at.is_(None),
    ).all()
    for assignment in assignments:
        assignment.ended_at = ended_at
        assignment.end_reason = reason
        assignment.ended_by_id = changed_by.id
        assignment.ended_by_name_snapshot = changed_by.display_name


def _end_classroom_teacher_assignments(
    db: Session,
    user_id: int,
    changed_by: User,
    reason: str,
    ended_at,
) -> None:
    assignments = db.query(ClassroomTeacherAssignment).filter(
        ClassroomTeacherAssignment.teacher_id == user_id,
        ClassroomTeacherAssignment.ended_at.is_(None),
    ).all()
    for assignment in assignments:
        assignment.ended_at = ended_at
        assignment.end_reason = reason
        assignment.ended_by_id = changed_by.id
        assignment.ended_by_name_snapshot = changed_by.display_name


def _transfer_owned_projects(
    db: Session,
    target_user: User,
    current_admin: User,
    reason: str,
) -> None:
    owned_projects = db.query(Project).filter(Project.owner_id == target_user.id).all()
    if owned_projects:
        logger.warning(
            "帳號生命週期：%s（id=%s）的 %s 個專案移交給 admin %s（id=%s）",
            target_user.username,
            target_user.id,
            len(owned_projects),
            current_admin.username,
            current_admin.id,
        )
    for project in owned_projects:
        record_project_owner_transfer(
            db,
            project,
            current_admin,
            current_admin,
            reason,
        )


def _transfer_user_comments(
    db: Session,
    target_user: User,
    current_admin: User,
) -> None:
    transferred_comments = db.query(ProjectComment).filter(
        ProjectComment.author_id == target_user.id
    ).count()
    if transferred_comments:
        logger.warning(
            "使用者刪除：%s（id=%s）的 %s 則留言作者移交給 admin %s（id=%s）",
            target_user.username,
            target_user.id,
            transferred_comments,
            current_admin.username,
            current_admin.id,
        )
        db.query(ProjectComment).filter(
            ProjectComment.author_id == target_user.id
        ).update({"author_id": current_admin.id})


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

            new_user = create_user_record(
                db,
                username=username,
                display_name=_cell_to_text(_row_value(row, column_map["display_name"])),
                password=_cell_to_text(_row_value(row, column_map["password"])),
                role=role,
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
) -> User:
    """驗證欄位後建立 User（不 commit，由呼叫端決定）。"""
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
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"密碼至少需要 {MIN_PASSWORD_LENGTH} 個字元")

    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="帳號已存在")

    new_user = User(
        username=username,
        display_name=display_name,
        hashed_password=hash_password(password),
        role=role,
    )
    db.add(new_user)
    return new_user


def update_user_record(
    db: Session,
    target_user: User,
    *,
    current_admin: User,
    username: str | None,
    display_name: str | None,
    role: str | None,
    new_password: str | None,
) -> None:
    """套用使用者更新：角色轉換與密碼重設（不 commit）。"""
    old_role = target_user.role
    next_role = _normalize_role(role) if role is not None else old_role
    if next_role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"無效角色：{role}")
    role_is_changing = next_role != old_role
    is_emergency_disable = role is not None and next_role == "none"

    if is_emergency_disable and target_user.id == current_admin.id:
        raise HTTPException(status_code=400, detail="不能停用自己的管理員帳號")

    if role_is_changing and next_role not in {"teacher", "supervisor", "none"}:
        active_scope = db.query(OrganizationSupervisorAssignment.id).filter(
            OrganizationSupervisorAssignment.supervisor_id == target_user.id,
            OrganizationSupervisorAssignment.ended_at.is_(None),
        ).first()
        if active_scope is not None:
            raise HTTPException(status_code=409, detail="請先解除目前園所主管範圍")

    if role_is_changing and next_role not in {"teacher", "supervisor", "none"}:
        active_classroom_count = db.query(ClassroomTeacherAssignment).filter(
            ClassroomTeacherAssignment.teacher_id == target_user.id,
            ClassroomTeacherAssignment.ended_at.is_(None),
        ).count()
        if active_classroom_count:
            raise HTTPException(
                status_code=409,
                detail="請先解除目前班級編制",
            )

    if role_is_changing and next_role not in PROJECT_OWNER_ROLES | {"none"}:
        owned_project = db.query(Project.id).filter(
            Project.owner_id == target_user.id
        ).first()
        if owned_project:
            raise HTTPException(status_code=409, detail="請先轉交此帳號負責的相本")

    if username is not None:
        new_username = username.strip()
        if not new_username:
            raise HTTPException(status_code=400, detail="帳號不能為空")
        conflict = db.query(User).filter(User.username == new_username, User.id != target_user.id).first()
        if conflict:
            raise HTTPException(status_code=400, detail="帳號已存在")
        target_user.username = new_username

    if display_name is not None:
        normalized_display_name = display_name.strip()
        if not normalized_display_name:
            raise HTTPException(status_code=400, detail="顯示名稱不能為空")
        target_user.display_name = normalized_display_name

    if is_emergency_disable:
        changed_at = utc_now()
        _end_organization_supervisor_assignments(
            db, target_user.id, current_admin, "role_none", changed_at
        )
        _end_classroom_teacher_assignments(
            db, target_user.id, current_admin, "role_none", changed_at
        )
        _transfer_owned_projects(
            db,
            target_user,
            current_admin,
            "帳號停權時自動轉交",
        )

    target_user.role = next_role

    password_is_changing = new_password is not None
    if new_password is not None:
        stripped_password = new_password.strip()
        if len(stripped_password) < MIN_PASSWORD_LENGTH:
            raise HTTPException(status_code=400, detail=f"新密碼至少需要 {MIN_PASSWORD_LENGTH} 個字元")
        target_user.hashed_password = hash_password(stripped_password)

    if role_is_changing or password_is_changing:
        target_user.auth_version = int(target_user.auth_version or 0) + 1


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
