"""專案建立者與目前負責人的轉交稽核 use cases。"""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404
from crud.user_crud import get_user_or_404
from database import (
    ClassroomTeacher,
    Project,
    ProjectAssignmentHistory,
    User,
    utc_now,
)
from services.organization_lock import organization_acl_lock
from services.organization_scope_service import teacher_carryover_condition
from services.template_sync_locks import lock_project_content_writes


PROJECT_OWNER_ROLES = {"admin", "teacher", "supervisor"}


def validate_project_owner(user: User) -> None:
    if user.role not in PROJECT_OWNER_ROLES:
        raise HTTPException(status_code=422, detail="此使用者不能成為相本負責人")


def serialize_assignment_history(history: ProjectAssignmentHistory) -> dict:
    return {
        "id": history.id,
        "project_id": history.project_id,
        "from_owner_id": history.from_owner_id,
        "from_owner_name": history.from_owner_name,
        "to_owner_id": history.to_owner_id,
        "to_owner_name": history.to_owner_name,
        "changed_by_id": history.changed_by_id,
        "changed_by_name": history.changed_by_name,
        "reason": history.reason,
        "changed_at": history.changed_at,
    }


def record_project_owner_transfer(
    db: Session,
    project: Project,
    target_owner: User,
    changed_by: User,
    reason: str | None,
) -> ProjectAssignmentHistory:
    """寫入一筆真實轉交；呼叫端持有 P 鎖並負責 transaction。"""
    validate_project_owner(target_owner)
    if project.owner_id == target_owner.id:
        raise HTTPException(status_code=400, detail="目前負責人已是此使用者")
    normalized_reason = reason.strip() if reason and reason.strip() else None
    history = ProjectAssignmentHistory(
        project_id=project.id,
        from_owner_id=project.owner_id,
        from_owner_name=project.owner.display_name if project.owner else None,
        to_owner_id=target_owner.id,
        to_owner_name=target_owner.display_name,
        changed_by_id=changed_by.id,
        changed_by_name=changed_by.display_name,
        reason=normalized_reason,
        changed_at=utc_now(),
    )
    db.add(history)
    project.owner_id = target_owner.id
    project.updated_at = history.changed_at
    db.flush()
    return history


def assign_project_owner(
    db: Session,
    current_admin: User,
    project_id: int,
    owner_id: int,
    reason: str | None,
) -> dict:
    with organization_acl_lock:
        get_project_or_404(project_id, db)
        get_user_or_404(owner_id, db)
        with lock_project_content_writes([project_id]):
            db.rollback()
            db.expire_all()
            project = get_project_or_404(project_id, db)
            target_owner = get_user_or_404(owner_id, db)
            changed_by = get_user_or_404(current_admin.id, db)
            if project.classroom_id is None:
                raise HTTPException(
                    status_code=409,
                    detail="請先把相本歸入班級，再轉交進度負責人",
                )
            # 學期切換後，該班的編制全部有 ended_at。若只認「目前編制」，那些跨過學期
            # 界線還沒完成的相本就再也轉交不出去——而那正是最需要換人接手的時候
            # （原老師離職、請假）。與製作權同一條規則（teacher_carryover_condition），
            # 但相本已完成時收回：交件完成後就只剩目前編制能接手。
            staffing_condition = (
                teacher_carryover_condition()
                if project.completed_at is None
                else ClassroomTeacher.ended_at.is_(None)
            )
            eligible_teacher = db.query(ClassroomTeacher.id).filter(
                ClassroomTeacher.classroom_id == project.classroom_id,
                ClassroomTeacher.teacher_id == target_owner.id,
                staffing_condition,
            ).first()
            if target_owner.role not in {"teacher", "supervisor"} or eligible_teacher is None:
                raise HTTPException(
                    status_code=422,
                    detail="進度負責人必須是該班目前老師，或該班上一學期、相本尚未完成時的老師",
                )
            history = record_project_owner_transfer(
                db,
                project,
                target_owner,
                changed_by,
                reason,
            )
            result = {
                "project_id": project.id,
                "owner_id": target_owner.id,
                "owner_name": target_owner.display_name,
                "created_by_id": project.created_by_id,
                "created_by_name": project.created_by_name,
                "history_entry": serialize_assignment_history(history),
            }
            db.commit()
            return result


def list_project_assignment_history(
    db: Session,
    project_id: int,
) -> list[dict]:
    get_project_or_404(project_id, db, include_archived=True)
    history = (
        db.query(ProjectAssignmentHistory)
        .filter(ProjectAssignmentHistory.project_id == project_id)
        .order_by(
            ProjectAssignmentHistory.changed_at,
            ProjectAssignmentHistory.id,
        )
        .all()
    )
    return [serialize_assignment_history(entry) for entry in history]
