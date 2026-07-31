"""專案讀寫、完成狀態與班級建立權限規則的唯一 owner。"""

from fastapi import HTTPException
from sqlalchemy import false
from sqlalchemy.orm import Session, object_session

from database import ClassroomTeacher, Project, ProjectComment, Student, User
from services.organization_scope_service import (
    OrganizationReadScope,
    apply_project_read_scope as apply_organization_project_read_scope,
    build_organization_read_scope,
    project_in_read_scope,
    project_in_supervisor_scope,
    project_in_readable_teacher_scope,
    project_in_teacher_scope,
)


def _project_session(project: Project, db: Session | None) -> Session:
    project_db = db or object_session(project)
    if project_db is None:
        raise RuntimeError("專案權限判斷需要資料庫 session")
    return project_db


def build_project_access_scope(
    db: Session,
    current_user: User,
) -> OrganizationReadScope | None:
    """只替需要園所 scope 的角色展開班級集合。"""
    if current_user.role not in {"teacher", "supervisor"}:
        return None
    return build_organization_read_scope(db, current_user)


def _actor_scope(
    project: Project,
    current_user: User,
    db: Session | None,
    organization_scope: OrganizationReadScope | None,
) -> OrganizationReadScope | None:
    if current_user.role not in {"teacher", "supervisor"}:
        return None
    if organization_scope is None:
        organization_scope = build_organization_read_scope(
            _project_session(project, db),
            current_user,
        )
    return organization_scope


def get_project_permissions(
    project: Project,
    current_user: User,
    db: Session | None = None,
    organization_scope: OrganizationReadScope | None = None,
) -> dict[str, bool]:
    """回傳共用能力；任教與主管指派各自提供對應能力。"""
    if current_user.role == "none":
        return {
            "can_read": False,
            "can_edit": False,
            "can_reopen": False,
            "can_comment": False,
        }

    is_admin = current_user.role == "admin"
    is_classroom_project = project.classroom_id is not None
    is_art_team = current_user.role == "art_team"
    actor_scope = _actor_scope(
        project,
        current_user,
        db,
        organization_scope,
    )
    in_actor_scope = bool(
        actor_scope and project_in_read_scope(project, actor_scope)
    )
    in_teacher_scope = bool(
        actor_scope and project_in_teacher_scope(project, actor_scope)
    )
    in_supervisor_scope = bool(
        actor_scope and project_in_supervisor_scope(project, actor_scope)
    )

    return {
        "can_read": bool(
            is_admin
            or (is_classroom_project and (is_art_team or in_actor_scope))
        ),
        "can_edit": bool(
            is_admin
            or (
                is_classroom_project
                and in_teacher_scope
            )
        ),
        "can_reopen": bool(
            is_admin
            or (
                is_classroom_project
                and in_supervisor_scope
            )
        ),
        "can_comment": bool(
            is_admin
            or (
                is_classroom_project
                and (is_art_team or in_supervisor_scope)
            )
        ),
    }


def apply_project_read_scope(
    query,
    current_user: User,
    db: Session,
    organization_scope: OrganizationReadScope | None = None,
):
    """套用 object policy，未歸班 Project 只允許 admin。"""
    if current_user.role == "admin":
        return query
    if current_user.role == "art_team":
        return query.filter(Project.classroom_id.isnot(None))
    if current_user.role not in {"teacher", "supervisor"}:
        return query.filter(false())
    scope = organization_scope or build_organization_read_scope(db, current_user)
    return apply_organization_project_read_scope(query, scope)


def assert_project_readable(
    project: Project,
    current_user: User,
    db: Session,
    organization_scope: OrganizationReadScope | None = None,
) -> None:
    """確認目前使用者有權限讀取此專案。"""
    permissions = get_project_permissions(
        project,
        current_user,
        db,
        organization_scope,
    )
    if permissions["can_read"]:
        return
    raise HTTPException(status_code=403, detail="無此專案的存取權限")


def student_effectively_completed(project: Project, student: Student) -> bool:
    """有效完成 predicate（唯一判斷式）：學生自身或全班完成任一成立即視為完成。"""
    return student.completed_at is not None or project.completed_at is not None


def assert_student_content_writable(
    project: Project,
    student: Student,
    current_user: User,
) -> None:
    """逐學生寫入鎖：目標學生已（有效）完成即擋；admin 比照全班內容鎖可越過。"""
    if current_user.role == "admin":
        return
    if not student_effectively_completed(project, student):
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "student_completed_locked",
            "message": "此學生相本已標記完成，需主管退回才能修改",
        },
    )


def assert_student_downloadable(project: Project, student: Student) -> None:
    """單生下載閘門：該生有效完成即放行。"""
    if student_effectively_completed(project, student):
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "student_not_completed",
            "message": "請先標記此學生完成，再下載 PDF 或圖片",
        },
    )


def assert_class_downloadable(project: Project) -> None:
    """全班 ZIP 閘門：只看 project.completed_at，部分完成一律擋下。"""
    if project.completed_at is not None:
        return
    completed_count = sum(
        student.completed_at is not None for student in project.students
    )
    total_count = len(project.students)
    raise HTTPException(
        status_code=409,
        detail={
            "code": "class_zip_requires_full_completion",
            "message": (
                f"已完成 {completed_count}/{total_count} 位，"
                "需全班完成才能下載全班 ZIP"
            ),
            "completed": completed_count,
            "total": total_count,
        },
    )


def assert_class_label_texts_writable(project: Project, current_user: User) -> None:
    """全班文字硬鎖：任一學生已（有效）完成即整份擋下；admin 比照內容鎖可越過。"""
    if current_user.role == "admin":
        return
    completed_student_names = [
        student.name
        for student in project.students
        if student_effectively_completed(project, student)
    ]
    if not completed_student_names:
        return
    raise HTTPException(
        status_code=409,
        detail={
            "code": "class_texts_locked_by_completed_students",
            "message": "已有學生標記完成，全班文字已鎖定；需主管先退回這些學生才能修改",
            "completed_student_names": completed_student_names,
        },
    )


def assert_project_writable(
    project: Project,
    current_user: User,
    db: Session | None = None,
) -> None:
    """確認目前使用者有權限修改此專案。"""
    permissions = get_project_permissions(project, current_user, db)
    if permissions["can_edit"]:
        return
    raise HTTPException(status_code=403, detail="無此專案的編輯權限")


def assert_project_content_writable(
    project: Project,
    current_user: User,
    db: Session | None = None,
) -> None:
    """確認可修改專案內容，並套用完成後的內容鎖定。"""
    if project.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Project not found")
    assert_project_writable(project, current_user, db)
    if project.completed_at is not None and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="專案已標記完成，內容已鎖定；需主管或管理員退回才能修改")


def assert_project_completion_revertible(
    project: Project,
    current_user: User,
    db: Session,
) -> None:
    """確認可退回「已完成」標記。"""
    permissions = get_project_permissions(project, current_user, db)
    if permissions["can_reopen"]:
        return
    raise HTTPException(status_code=403, detail="只有主管或管理員能退回已完成的專案")


def assert_project_commentable(
    project: Project,
    current_user: User,
    db: Session,
) -> None:
    """確認可新增審閱留言。"""
    permissions = get_project_permissions(project, current_user, db)
    if permissions["can_comment"]:
        return
    raise HTTPException(status_code=403, detail="無此專案的審閱留言權限")


def assert_classroom_project_creatable(
    db: Session,
    current_user: User,
    classroom_id: int,
) -> None:
    """班級相本只允許 admin 或目前主教建立。"""
    if current_user.role == "admin":
        return
    is_active_lead = db.query(ClassroomTeacher.id).filter(
        ClassroomTeacher.classroom_id == classroom_id,
        ClassroomTeacher.teacher_id == current_user.id,
        ClassroomTeacher.duty == "lead",
        ClassroomTeacher.ended_at.is_(None),
    ).first()
    if current_user.role in {"teacher", "supervisor"} and is_active_lead:
        return
    raise HTTPException(status_code=403, detail="只有目前主教或管理員能建立此班級相本")


def assert_comment_deletable(comment: ProjectComment, current_user: User) -> None:
    """admin 可刪任何留言；其他角色只能刪自己的留言。"""
    if current_user.role == "admin" or comment.author_id == current_user.id:
        return
    raise HTTPException(status_code=403, detail="只能刪除自己的留言")
