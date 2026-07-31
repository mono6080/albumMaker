"""分校、班級目前名單與每期相本快照 use cases。"""

import hashlib
import json
from collections import Counter
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from crud.organization_crud import (
    get_campus_or_404,
    get_class_roster_member_or_404,
    get_classroom_or_404,
)
from crud.project_crud import get_project_or_404
from crud.template_crud import get_template_or_404
from crud.user_crud import get_user_or_404
from database import (
    CURRENT_SEMESTER_STATUSES,
    Semester,
    Classroom,
    SemesterPeriod,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacher,
    ClassroomMember,
    OrganizationSupervisorAssignment,
    Project,
    Student,
    ProjectStudent,
    Template,
    TemplatePeriod,
    TermReclassificationPlan,
    User,
    utc_now,
)
from services.organization_scope_service import build_organization_read_scope
from services.organization_lock import organization_acl_lock
from services.project_assignment_service import (
    serialize_assignment_history,
    validate_project_owner,
)
from services.project_access_service import assert_classroom_project_creatable
from services.project_lifecycle_service import build_project_record
from services.organization_transaction import (
    organization_mutation,
    organization_write_transaction,
)
from services.roster_identity_service import normalize_child_name
from services.student_album_name_policy import (
    assign_automatic_album_names,
    suggest_automatic_album_name,
)
from services.student_input_policy import (
    assert_project_student_capacity,
    normalize_student_album_name,
    normalize_student_name,
    validate_student_batch_size,
)
from services.template_sync_locks import lock_project_content_writes, lock_template_write
from template_periods import VALID_TEMPLATE_DEPARTMENTS


ORGANIZATION_NAME_MAX_LENGTH = 100
SUPERVISOR_SCOPE_ORDER = {None: 0, "infant": 1, "academy": 2}
LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE = "legacy_project_classroom_migrations"
LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE = "legacy_student_identity_resolutions"


def _normalize_organization_name(raw_name: str, label: str) -> str:
    if not isinstance(raw_name, str):
        raise HTTPException(status_code=422, detail=f"{label}名稱不可為空")
    name = raw_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail=f"{label}名稱不可空白")
    if len(name) > ORGANIZATION_NAME_MAX_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"{label}名稱不可超過 {ORGANIZATION_NAME_MAX_LENGTH} 個字",
        )
    return name


def _validate_department(department: str) -> str:
    if department not in VALID_TEMPLATE_DEPARTMENTS:
        raise HTTPException(status_code=422, detail="無效的部門")
    return department


def _serialize_member(member: ClassroomMember) -> dict:
    return {
        "id": member.id,
        "classroom_id": member.classroom_id,
        "roster_child_id": member.roster_child_id,
        "name": member.roster_child.name,
        "album_name": member.roster_child.album_name,
        "effective_album_name": member.roster_child.effective_album_name,
        "status": "ended" if member.ended_at is not None else "active",
        "started_at": member.started_at,
        "ended_at": member.ended_at,
        "end_reason": member.end_reason,
    }


def _serialize_project(project: Project) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "classroom_id": project.classroom_id,
        "class_period_work_slot_id": project.class_period_work_slot_id,
        "campus_id": project.campus_id_snapshot,
        "campus_name": project.campus_name_snapshot,
        "classroom_name": project.classroom_name_snapshot,
        "department": project.department,
        "template_id": project.template_id,
        "template_name": project.template.name if project.template else None,
        "template_period_id": project.template_period_id,
        "template_period_name": (
            project.template_period.name if project.template_period else None
        ),
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "created_by_id": project.created_by_id,
        "created_by_name": project.created_by_name,
        "created_at": project.created_at,
        "completed_at": project.completed_at,
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "album_name": student.resolved_album_name,
                "effective_album_name": student.effective_album_name,
                "order_index": student.order_index,
                "roster_child_id": student.roster_child_id,
            }
            for student in project.students
        ],
        "assignment_history": [
            serialize_assignment_history(history)
            for history in project.assignment_history
        ],
    }


def _serialize_work_slot(work_slot: ClassPeriodWorkSlot) -> dict:
    classroom = work_slot.classroom
    semester_period = work_slot.semester_period
    return {
        "id": work_slot.id,
        "semester_id": classroom.semester_id,
        "semester_label": classroom.semester.label,
        "semester_status": classroom.semester.status,
        "classroom_id": classroom.id,
        "campus_id": classroom.campus_id,
        "campus_name": classroom.campus.name,
        "classroom_name": classroom.name,
        "department": classroom.department,
        "semester_period_id": semester_period.id,
        "template_period_id": semester_period.template_period_id,
        "period_name": semester_period.period_name_snapshot,
        "period_position": semester_period.position,
        "template_ids": [
            template.id for template in semester_period.template_period.templates
        ],
        "started_at": work_slot.started_at,
        "can_create_project": work_slot.started_at is None,
        "project_ids": [
            project.id for project in work_slot.projects if project.deleted_at is None
        ],
    }


def _serialize_teacher_assignment(assignment: ClassroomTeacher) -> dict:
    return {
        "id": assignment.id,
        "classroom_id": assignment.classroom_id,
        "teacher_id": assignment.teacher_id,
        "teacher_name": assignment.teacher_name_snapshot,
        "duty": assignment.duty,
        "started_at": assignment.started_at,
        "ended_at": assignment.ended_at,
        "end_reason": assignment.end_reason,
        "started_by_id": assignment.started_by_id,
        "started_by_name": assignment.started_by_name_snapshot,
        "ended_by_id": assignment.ended_by_id,
        "ended_by_name": assignment.ended_by_name_snapshot,
    }


def _serialize_supervisor_assignment(
    assignment: OrganizationSupervisorAssignment,
) -> dict:
    return {
        "id": assignment.id,
        "campus_id": assignment.campus_id,
        "department": assignment.department,
        "supervisor_id": assignment.supervisor_id,
        "supervisor_name": assignment.supervisor_name_snapshot,
        "started_at": assignment.started_at,
        "started_by_id": assignment.started_by_id,
        "started_by_name": assignment.started_by_name_snapshot,
        "ended_at": assignment.ended_at,
        "end_reason": assignment.end_reason,
        "ended_by_id": assignment.ended_by_id,
        "ended_by_name": assignment.ended_by_name_snapshot,
    }


def _serialize_supervisor_scopes(campus: Campus) -> dict:
    current_assignments = sorted(
        (
            assignment
            for assignment in campus.supervisor_assignments
            if assignment.ended_at is None
        ),
        key=lambda assignment: (
            SUPERVISOR_SCOPE_ORDER[assignment.department],
            assignment.supervisor_name_snapshot,
            assignment.id,
        ),
    )
    historical_assignments = sorted(
        (
            assignment
            for assignment in campus.supervisor_assignments
            if assignment.ended_at is not None
        ),
        key=lambda assignment: (assignment.ended_at, assignment.id),
        reverse=True,
    )
    return {
        "current": [
            _serialize_supervisor_assignment(assignment)
            for assignment in current_assignments
        ],
        "history": [
            _serialize_supervisor_assignment(assignment)
            for assignment in historical_assignments
        ],
    }


def _serialize_classroom(classroom: Classroom) -> dict:
    return {
        "id": classroom.id,
        "campus_id": classroom.campus_id,
        "department": classroom.department,
        "name": classroom.name,
        "semester_id": classroom.semester_id,
        "is_current": classroom.is_current,
        "current_teachers": [
            _serialize_teacher_assignment(assignment)
            for assignment in classroom.teacher_assignments
            if assignment.ended_at is None
        ],
        "teacher_history": [
            _serialize_teacher_assignment(assignment)
            for assignment in classroom.teacher_assignments
            if assignment.ended_at is not None
        ],
        "members": [_serialize_member(member) for member in classroom.roster_members],
        "projects": [
            _serialize_project(project)
            for project in sorted(
                classroom.projects,
                key=lambda item: item.created_at,
                reverse=True,
            )
            if project.deleted_at is None
        ],
    }


def _serialize_campus(campus: Campus, current_semester_id: int | None) -> dict:
    """園所設定只呈現目前學期的班。

    班級不跨學期，同一個分校會累積歷屆的班；編班草稿更會先把下學期的班長出來。
    不過濾的話，同一個班名會同時以「本學期」和「已結束」出現兩次。
    """
    return {
        "id": campus.id,
        "name": campus.name,
        "is_active": campus.is_active,
        "created_at": campus.created_at,
        "updated_at": campus.updated_at,
        "supervisor_scopes": _serialize_supervisor_scopes(campus),
        "classrooms": [
            _serialize_classroom(classroom)
            for classroom in campus.classrooms
            if classroom.semester_id == current_semester_id
        ],
    }


def _organization_migration_status(db: Session) -> dict:
    unassigned_project_count = db.query(Project.id).filter(
        Project.classroom_id.is_(None),
        Project.deleted_at.is_(None),
    ).count()
    pending_identity_student_count = (
        db.query(ProjectStudent.id)
        .join(Project, Project.id == ProjectStudent.project_id)
        .filter(
            Project.classroom_id.is_(None),
            Project.deleted_at.is_(None),
        )
        .count()
    )
    archived_teacher_supervisor_link_count = db.execute(text(
        "SELECT COUNT(*) FROM legacy_teacher_supervisor_links"
    )).scalar_one()
    archived_identity_resolution_count = db.execute(text(
        f"SELECT COUNT(*) FROM {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE}"
    )).scalar_one()
    assigned_identity_anomaly_count = db.execute(text("""
        SELECT COUNT(DISTINCT anomaly.student_id)
        FROM (
            SELECT student.id AS student_id
            FROM project_students AS student
            JOIN projects AS project ON project.id = student.project_id
            LEFT JOIN students AS child
                ON child.id = student.roster_child_id
            WHERE project.classroom_id IS NOT NULL
              AND project.deleted_at IS NULL
              AND (student.roster_child_id IS NULL OR child.id IS NULL)

            UNION ALL

            SELECT student.id AS student_id
            FROM project_students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE project.classroom_id IS NOT NULL
              AND project.deleted_at IS NULL
              AND student.roster_child_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM project_students AS sibling
                  WHERE sibling.project_id = student.project_id
                    AND sibling.id != student.id
                    AND sibling.roster_child_id = student.roster_child_id
              )
        ) AS anomaly
    """)).scalar_one()
    return {
        "unassigned_project_count": unassigned_project_count,
        "pending_identity_student_count": pending_identity_student_count,
        "archived_teacher_supervisor_link_count": (
            archived_teacher_supervisor_link_count
        ),
        "archived_identity_resolution_count": archived_identity_resolution_count,
        "assigned_identity_anomaly_count": assigned_identity_anomaly_count,
        "is_complete": (
            unassigned_project_count == 0
            and assigned_identity_anomaly_count == 0
        ),
    }


def get_organization_overview(db: Session) -> dict:
    campuses = (
        db.query(Campus)
        .options(
            selectinload(Campus.classrooms)
            .selectinload(Classroom.roster_members)
            .selectinload(ClassroomMember.roster_child),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.students)
            .selectinload(ProjectStudent.roster_child),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.assignment_history),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.owner),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.template),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.template_period),
            selectinload(Campus.classrooms).selectinload(
                Classroom.teacher_assignments
            ),
            selectinload(Campus.supervisor_assignments),
        )
        .order_by(Campus.created_at, Campus.id)
        .all()
    )
    templates = (
        db.query(Template)
        .join(TemplatePeriod, Template.period_id == TemplatePeriod.id)
        .filter(TemplatePeriod.status == "active")
        .order_by(TemplatePeriod.department, TemplatePeriod.name, Template.name)
        .all()
    )
    unassigned_projects = (
        db.query(Project)
        .options(
            selectinload(Project.students),
            selectinload(Project.assignment_history),
            selectinload(Project.owner),
            selectinload(Project.template),
            selectinload(Project.template_period),
        )
        .filter(Project.classroom_id.is_(None), Project.deleted_at.is_(None))
        .order_by(Project.created_at.desc(), Project.id.desc())
        .all()
    )
    teacher_options = (
        db.query(User)
        .filter(User.role.in_(("teacher", "supervisor")))
        .order_by(User.display_name, User.id)
        .all()
    )
    supervisor_options = (
        db.query(User)
        .filter(User.role.in_(("teacher", "supervisor")))
        .order_by(User.display_name, User.id)
        .all()
    )
    draft_term_plan = db.query(TermReclassificationPlan.id).filter(
        TermReclassificationPlan.scope_key == "organization",
        TermReclassificationPlan.status == "draft",
    ).first()
    current_term = (
        db.query(Semester)
        .filter(Semester.status.in_(("imported", "active")))
        .order_by(Semester.id.desc())
        .first()
    )
    current_semester_id = current_term.id if current_term is not None else None
    current_work_slots = (
        db.query(ClassPeriodWorkSlot)
        .join(
            Classroom,
            Classroom.id == ClassPeriodWorkSlot.classroom_id,
        )
        .options(
            selectinload(ClassPeriodWorkSlot.projects),
            selectinload(ClassPeriodWorkSlot.classroom).selectinload(
                Classroom.semester
            ),
            selectinload(ClassPeriodWorkSlot.semester_period),
        )
        .filter(Classroom.semester_id == current_term.id)
        .order_by(
            Classroom.id,
            ClassPeriodWorkSlot.id,
        )
        .all()
        if current_term is not None
        else []
    )
    return {
        "campuses": [
            _serialize_campus(campus, current_semester_id)
            for campus in campuses
        ],
        "unassigned_projects": [
            _serialize_project(project) for project in unassigned_projects
        ],
        "teacher_options": [
            {
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
                "role": user.role,
            }
            for user in teacher_options
        ],
        "supervisor_options": [
            {
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
                "role": user.role,
            }
            for user in supervisor_options
        ],
        "migration_status": _organization_migration_status(db),
        "draft_term_plan_id": draft_term_plan[0] if draft_term_plan else None,
        "current_semester": (
            {
                "id": current_term.id,
                "label": current_term.label,
                "status": current_term.status,
            }
            if current_term is not None
            else None
        ),
        "work_slots": [
            _serialize_work_slot(work_slot) for work_slot in current_work_slots
        ],
        "templates": [
            {
                "id": template.id,
                "name": template.name,
                "revision": template.revision,
                "period_id": template.period_id,
                "period_name": template.period.name,
                "department": template.period.department,
                "period_status": template.period.status,
            }
            for template in templates
        ],
    }


def _validate_teacher_targets(db: Session, teachers: list[dict]) -> dict[int, User]:
    teacher_ids = [teacher["teacher_id"] for teacher in teachers]
    if len(teacher_ids) != len(set(teacher_ids)):
        raise HTTPException(status_code=422, detail="同班老師不可重複")
    lead_count = sum(teacher["duty"] == "lead" for teacher in teachers)
    if teachers and lead_count != 1:
        raise HTTPException(status_code=422, detail="非空編制必須恰有一位主教")
    users = db.query(User).filter(User.id.in_(teacher_ids)).all() if teacher_ids else []
    user_by_id = {user.id: user for user in users}
    if set(teacher_ids) != set(user_by_id):
        raise HTTPException(status_code=422, detail="指定的老師帳號不存在")
    invalid_users = [
        user.id for user in users if user.role not in {"teacher", "supervisor"}
    ]
    if invalid_users:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_teacher_role",
                "teacher_ids": invalid_users,
            },
        )
    return user_by_id


def replace_classroom_teachers(
    db: Session,
    current_admin: User,
    classroom_id: int,
    teachers: list[dict],
) -> dict:
    with organization_write_transaction(db):
        classroom = get_classroom_or_404(classroom_id, db)
        if teachers and (not classroom.is_current or not classroom.campus.is_active):
            raise HTTPException(status_code=409, detail="只能設定使用中的分校與班級")
        user_by_id = _validate_teacher_targets(db, teachers)
        current_assignments = db.query(ClassroomTeacher).filter(
            ClassroomTeacher.classroom_id == classroom_id,
            ClassroomTeacher.ended_at.is_(None),
        ).all()
        current_by_teacher_id = {
            assignment.teacher_id: assignment for assignment in current_assignments
        }
        requested_by_teacher_id = {
            teacher["teacher_id"]: teacher for teacher in teachers
        }
        changed_at = utc_now()
        for teacher_id, assignment in current_by_teacher_id.items():
            requested = requested_by_teacher_id.get(teacher_id)
            if requested is None or requested["duty"] != assignment.duty:
                assignment.ended_at = changed_at
                assignment.end_reason = "assignment_replaced"
                assignment.ended_by_id = current_admin.id
                assignment.ended_by_name_snapshot = current_admin.display_name
        db.flush()
        for teacher_id, requested in requested_by_teacher_id.items():
            current = current_by_teacher_id.get(teacher_id)
            if current is not None and current.duty == requested["duty"]:
                continue
            teacher = user_by_id[teacher_id]
            db.add(ClassroomTeacher(
                classroom_id=classroom_id,
                teacher_id=teacher.id,
                teacher_name_snapshot=teacher.display_name,
                duty=requested["duty"],
                started_at=changed_at,
                started_by_id=current_admin.id,
                started_by_name_snapshot=current_admin.display_name,
            ))
        db.flush()
        db.commit()
    classroom = get_classroom_or_404(classroom_id, db)
    return {
        "classroom_id": classroom_id,
        "current_teachers": [
            _serialize_teacher_assignment(assignment)
            for assignment in classroom.teacher_assignments
            if assignment.ended_at is None
        ],
        "teacher_history": [
            _serialize_teacher_assignment(assignment)
            for assignment in classroom.teacher_assignments
            if assignment.ended_at is not None
        ],
    }


def _requested_supervisor_scope_keys(
    campus_supervisor_ids: list[int],
    department_supervisors: list[dict],
) -> set[tuple[str | None, int]]:
    department_rows = [row["department"] for row in department_supervisors]
    if len(department_rows) != len(set(department_rows)):
        raise HTTPException(status_code=422, detail="部門主管設定不可重複")
    if set(department_rows) != set(VALID_TEMPLATE_DEPARTMENTS):
        raise HTTPException(
            status_code=422,
            detail="必須完整送出嬰幼部與學院部主管設定",
        )
    requested_ids_by_department = {
        None: campus_supervisor_ids,
        **{
            row["department"]: row["supervisor_ids"]
            for row in department_supervisors
        },
    }
    for supervisor_ids in requested_ids_by_department.values():
        if len(supervisor_ids) != len(set(supervisor_ids)):
            raise HTTPException(status_code=422, detail="同一主管 scope 不可重複")
    return {
        (department, supervisor_id)
        for department, supervisor_ids in requested_ids_by_department.items()
        for supervisor_id in supervisor_ids
    }


def _validate_supervisor_targets(
    db: Session,
    requested_scope_keys: set[tuple[str | None, int]],
) -> dict[int, User]:
    supervisor_ids = {supervisor_id for _, supervisor_id in requested_scope_keys}
    supervisors = (
        db.query(User).filter(User.id.in_(supervisor_ids)).all()
        if supervisor_ids
        else []
    )
    supervisor_by_id = {supervisor.id: supervisor for supervisor in supervisors}
    missing_ids = supervisor_ids - set(supervisor_by_id)
    if missing_ids:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "supervisor_not_found",
                "supervisor_ids": sorted(missing_ids),
            },
        )
    invalid_ids = sorted(
        supervisor.id
        for supervisor in supervisors
        if supervisor.role not in {"teacher", "supervisor"}
    )
    if invalid_ids:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_supervisor_role",
                "supervisor_ids": invalid_ids,
            },
        )
    return supervisor_by_id


def replace_campus_supervisors(
    db: Session,
    current_admin: User,
    campus_id: int,
    campus_supervisor_ids: list[int],
    department_supervisors: list[dict],
) -> dict:
    requested_scope_keys = _requested_supervisor_scope_keys(
        campus_supervisor_ids,
        department_supervisors,
    )
    with organization_write_transaction(db):
        campus = get_campus_or_404(campus_id, db)
        if not campus.is_active and requested_scope_keys:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "inactive_campus_supervisors_must_be_empty",
                    "message": "停用分校只能清空主管設定",
                },
            )
        supervisor_by_id = _validate_supervisor_targets(db, requested_scope_keys)
        current_assignments = db.query(OrganizationSupervisorAssignment).filter(
            OrganizationSupervisorAssignment.campus_id == campus_id,
            OrganizationSupervisorAssignment.ended_at.is_(None),
        ).all()
        current_by_scope_key = {
            (assignment.department, assignment.supervisor_id): assignment
            for assignment in current_assignments
        }
        changed_at = utc_now()
        for scope_key, assignment in current_by_scope_key.items():
            if scope_key in requested_scope_keys:
                continue
            assignment.ended_at = changed_at
            assignment.end_reason = "assignment_replaced"
            assignment.ended_by_id = current_admin.id
            assignment.ended_by_name_snapshot = current_admin.display_name
        db.flush()
        for department, supervisor_id in sorted(
            requested_scope_keys,
            key=lambda scope_key: (
                SUPERVISOR_SCOPE_ORDER[scope_key[0]],
                scope_key[1],
            ),
        ):
            if (department, supervisor_id) in current_by_scope_key:
                continue
            supervisor = supervisor_by_id[supervisor_id]
            db.add(OrganizationSupervisorAssignment(
                campus_id=campus_id,
                department=department,
                supervisor_id=supervisor.id,
                supervisor_name_snapshot=supervisor.display_name,
                started_at=changed_at,
                started_by_id=current_admin.id,
                started_by_name_snapshot=current_admin.display_name,
            ))
        db.commit()
    campus = get_campus_or_404(campus_id, db)
    return {
        "campus_id": campus.id,
        "supervisor_scopes": _serialize_supervisor_scopes(campus),
    }


def _serialize_scoped_classroom(classroom: Classroom) -> dict:
    current_term_classrooms = [classroom] if classroom.is_current else []
    return {
        "id": classroom.id,
        "campus_id": classroom.campus_id,
        "campus_name": classroom.campus.name,
        "department": classroom.department,
        "name": classroom.name,
        "current_teachers": [
            _serialize_teacher_assignment(assignment)
            for assignment in classroom.teacher_assignments
            if assignment.ended_at is None
        ],
        "members": [
            _serialize_member(member)
            for member in classroom.roster_members
            if member.ended_at is None
        ],
        "work_slots": [
            _serialize_work_slot(work_slot)
            for classroom in current_term_classrooms
            for work_slot in classroom.work_slots
        ],
    }


def get_my_classrooms(db: Session, current_user: User) -> dict:
    if current_user.role not in {"admin", "teacher", "supervisor"}:
        raise HTTPException(status_code=403, detail="此角色無班級檢視權限")
    organization_scope = build_organization_read_scope(db, current_user)
    permissions = {
        "can_view_supervisor_reports": (
            organization_scope.is_admin
            or organization_scope.has_supervisor_assignment
        ),
    }
    if not organization_scope.classroom_ids:
        return {"classrooms": [], "permissions": permissions}
    query = (
        db.query(Classroom)
        .join(Campus, Campus.id == Classroom.campus_id)
        .options(
            selectinload(Classroom.teacher_assignments),
            selectinload(Classroom.roster_members).selectinload(
                ClassroomMember.roster_child
            ),
            selectinload(Classroom.campus),
            selectinload(Classroom.semester),
            selectinload(Classroom.work_slots).selectinload(
                ClassPeriodWorkSlot.projects
            ),
            selectinload(Classroom.work_slots)
            .selectinload(ClassPeriodWorkSlot.semester_period)
            .selectinload(SemesterPeriod.template_period)
            .selectinload(TemplatePeriod.templates),
        )
        .filter(
            Classroom.id.in_(organization_scope.classroom_ids),
            Classroom.semester_id.in_(
                select(Semester.id).where(
                    Semester.status.in_(CURRENT_SEMESTER_STATUSES)
                )
            ),
            Campus.is_active.is_(True),
        )
    )
    classrooms = query.distinct().order_by(Campus.name, Classroom.name).all()
    return {
        "classrooms": [
            _serialize_scoped_classroom(classroom) for classroom in classrooms
        ],
        "permissions": permissions,
    }


@organization_mutation
def create_campus(db: Session, name: str, is_active: bool) -> dict:
    campus_name = _normalize_organization_name(name, "分校")
    if db.query(Campus.id).filter(Campus.name == campus_name).first():
        raise HTTPException(status_code=409, detail="分校名稱已存在")
    campus = Campus(name=campus_name, is_active=is_active)
    db.add(campus)
    db.commit()
    db.refresh(campus)
    return _serialize_campus(campus, _current_semester_id(db))


@organization_mutation
def update_campus(db: Session, campus_id: int, changes: dict) -> dict:
    campus = get_campus_or_404(campus_id, db)
    if changes.get("is_active") is False:
        has_active_members = (
            db.query(ClassroomMember.id)
            .join(Classroom, Classroom.id == ClassroomMember.classroom_id)
            .filter(
                Classroom.campus_id == campus_id,
                ClassroomMember.ended_at.is_(None),
            )
            .first()
        )
        has_active_teachers = (
            db.query(ClassroomTeacher.id)
            .join(
                Classroom,
                Classroom.id == ClassroomTeacher.classroom_id,
            )
            .filter(
                Classroom.campus_id == campus_id,
                ClassroomTeacher.ended_at.is_(None),
            )
            .first()
        )
        if has_active_members or has_active_teachers:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "campus_has_active_classrooms_or_assignments",
                    "message": "請先停用旗下班級，並清空目前學生名單與老師編制再停用分校",
                },
            )
    if "name" in changes:
        campus_name = _normalize_organization_name(changes["name"], "分校")
        conflict = db.query(Campus.id).filter(
            Campus.name == campus_name,
            Campus.id != campus_id,
        ).first()
        if conflict:
            raise HTTPException(status_code=409, detail="分校名稱已存在")
        campus.name = campus_name
    if "is_active" in changes:
        if changes["is_active"] is None:
            raise HTTPException(status_code=422, detail="is_active 不可為空")
        campus.is_active = changes["is_active"]
    campus.updated_at = utc_now()
    db.commit()
    db.refresh(campus)
    return _serialize_campus(campus, _current_semester_id(db))


def _assert_classroom_name_available(
    db: Session,
    *,
    campus_id: int,
    department: str,
    name: str,
    excluded_classroom_id: int | None = None,
) -> None:
    """同名檢查只在同一個學期內；班名跨學期本來就會重複。"""
    current_term = _current_semester(db)
    if current_term is None:
        return
    query = db.query(Classroom.id).filter(
        Classroom.semester_id == current_term.id,
        Classroom.campus_id == campus_id,
        Classroom.department == department,
        Classroom.name == name,
    )
    if excluded_classroom_id is not None:
        query = query.filter(Classroom.id != excluded_classroom_id)
    if query.first():
        raise HTTPException(status_code=409, detail="同分校與部門已有同名班級")


def _current_semester_id(db: Session) -> int | None:
    current_semester = _current_semester(db)
    return current_semester.id if current_semester is not None else None


def _current_semester(db: Session) -> Semester | None:
    return (
        db.query(Semester)
        .filter(Semester.status.in_(CURRENT_SEMESTER_STATUSES))
        .order_by(Semester.id.desc())
        .first()
    )


def _ensure_current_term_classroom_grid(
    db: Session,
    classroom: Classroom,
) -> Classroom | None:
    """替班級補上與其部門相符的期別工作格。

    班級本身就屬於某個學期，所以不再需要另外產生學期快照——只剩工作格要補。
    """
    if not classroom.is_current or not classroom.campus.is_active:
        return None
    current_term = classroom.semester
    period_query = db.query(SemesterPeriod).filter(
        SemesterPeriod.semester_id == current_term.id,
        SemesterPeriod.department == classroom.department,
    )
    if current_term.status == "imported":
        period_query = period_query.join(
            TemplatePeriod,
            TemplatePeriod.id == SemesterPeriod.template_period_id,
        ).filter(TemplatePeriod.status == "active")
    for semester_period in period_query.order_by(SemesterPeriod.position).all():
        if db.query(ClassPeriodWorkSlot.id).filter(
            ClassPeriodWorkSlot.classroom_id == classroom.id,
            ClassPeriodWorkSlot.semester_period_id == semester_period.id,
        ).first() is None:
            db.add(ClassPeriodWorkSlot(
                classroom_id=classroom.id,
                semester_period_id=semester_period.id,
            ))
    return classroom


@organization_mutation
def create_classroom(
    db: Session,
    *,
    campus_id: int,
    department: str,
    name: str,
    is_active: bool,
) -> dict:
    campus = get_campus_or_404(campus_id, db)
    classroom_name = _normalize_organization_name(name, "班級")
    classroom_department = _validate_department(department)
    if not is_active:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "classroom_has_no_active_flag",
                "message": "班級沒有停用狀態；不屬於目前學期即為結束",
            },
        )
    if not campus.is_active:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "active_classroom_requires_active_campus",
                "message": "使用中的班級只能隸屬使用中的分校",
            },
        )
    current_term = _current_semester(db)
    if current_term is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "no_current_semester",
                "message": "尚未建立目前正式學期，無法新增班級",
            },
        )
    _assert_classroom_name_available(
        db,
        campus_id=campus_id,
        department=classroom_department,
        name=classroom_name,
    )
    classroom = Classroom(
        semester_id=current_term.id,
        campus_id=campus_id,
        department=classroom_department,
        name=classroom_name,
    )
    db.add(classroom)
    db.flush()
    _ensure_current_term_classroom_grid(db, classroom)
    db.commit()
    db.refresh(classroom)
    return _serialize_classroom(classroom)


@organization_mutation
def update_classroom(db: Session, classroom_id: int, changes: dict) -> dict:
    classroom = get_classroom_or_404(classroom_id, db)
    # 班級是學期範圍的實體，校別與部門就是它的身分——中途搬校或換部門等於換成
    # 另一個班，必須結束原班、在目標校建新班並轉移成員，不能就地改寫。
    if "is_active" in changes:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "classroom_has_no_active_flag",
                "message": "班級沒有停用狀態；不屬於目前學期即為結束",
            },
        )
    for field, current_value in (
        ("campus_id", classroom.campus_id),
        ("department", classroom.department),
    ):
        if field in changes and changes[field] != current_value:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "classroom_scope_is_immutable",
                    "message": "班級的分校與部門不可變更；請結束原班並在目標分校建立新班",
                },
            )
    campus_id = classroom.campus_id
    department = classroom.department
    name = _normalize_organization_name(
        changes.get("name", classroom.name),
        "班級",
    )
    campus = get_campus_or_404(campus_id, db)
    if not campus.is_active:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "active_classroom_requires_active_campus",
                "message": "使用中的班級只能隸屬使用中的分校",
            },
        )
    _assert_classroom_name_available(
        db,
        campus_id=campus_id,
        department=department,
        name=name,
        excluded_classroom_id=classroom_id,
    )
    classroom.name = name
    db.flush()
    _ensure_current_term_classroom_grid(db, classroom)
    db.commit()
    db.refresh(classroom)
    return _serialize_classroom(classroom)


@organization_mutation
def batch_add_classroom_members(
    db: Session,
    classroom_id: int,
    members: list[dict],
) -> dict:
    classroom = get_classroom_or_404(classroom_id, db)
    if not classroom.is_current or not classroom.campus.is_active:
        raise HTTPException(status_code=409, detail="只能編輯使用中的分校與班級")
    validate_student_batch_size(len(members))
    normalized_names = [normalize_student_name(item["name"]) for item in members]
    normalized_album_names = [
        normalize_student_album_name(item.get("album_name")) for item in members
    ]
    created_members: list[ClassroomMember] = []
    skipped_names: list[str] = []
    names_seen: set[str] = set()
    active_members = db.query(ClassroomMember).options(
        selectinload(ClassroomMember.roster_child)
    ).filter(
        ClassroomMember.classroom_id == classroom_id,
        ClassroomMember.ended_at.is_(None),
    ).all()
    active_count = len(active_members)
    existing_effective_album_names = [
        str(member.roster_child.effective_album_name)
        for member in active_members
    ]
    created_children: list[Student] = []

    for member_name, album_name in zip(
        normalized_names,
        normalized_album_names,
        strict=True,
    ):
        normalized_identity = normalize_child_name(member_name)
        if not normalized_identity:
            continue
        if normalized_identity in names_seen:
            skipped_names.append(member_name)
            continue
        names_seen.add(normalized_identity)
        active_membership = db.query(ClassroomMember).join(
            Student,
            Student.id == ClassroomMember.roster_child_id,
        ).filter(
            ClassroomMember.classroom_id == classroom_id,
            ClassroomMember.ended_at.is_(None),
            Student.name == normalized_identity,
        ).first()
        if active_membership:
            skipped_names.append(member_name)
            continue
        roster_child = Student(
            name=normalized_identity,
            album_name=album_name,
        )
        db.add(roster_child)
        db.flush()
        member = ClassroomMember(
            classroom_id=classroom_id,
            roster_child_id=roster_child.id,
        )
        db.add(member)
        created_members.append(member)
        created_children.append(roster_child)

    assert_project_student_capacity(active_count, len(created_members))
    children_without_album_name = [
        child for child in created_children if child.album_name is None
    ]
    automatic_album_names = assign_automatic_album_names(
        [str(child.name) for child in children_without_album_name],
        [
            *existing_effective_album_names,
            *(
                str(child.album_name)
                for child in created_children
                if child.album_name is not None
            ),
        ],
    )
    for child, album_name in zip(
        children_without_album_name,
        automatic_album_names,
        strict=True,
    ):
        child.album_name = album_name
    db.flush()
    db.commit()
    for member in created_members:
        db.refresh(member)
    return {
        "created": [_serialize_member(member) for member in created_members],
        "skipped": skipped_names,
    }


def _assert_child_has_no_active_membership(
    db: Session,
    roster_child_id: int,
    *,
    excluded_member_id: int | None = None,
) -> None:
    query = db.query(ClassroomMember).filter(
        ClassroomMember.roster_child_id == roster_child_id,
        ClassroomMember.ended_at.is_(None),
    )
    if excluded_member_id is not None:
        query = query.filter(ClassroomMember.id != excluded_member_id)
    active_membership = query.first()
    if active_membership:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "child_already_active_in_another_classroom",
                "classroom_id": active_membership.classroom_id,
            },
        )


def _assert_active_name_available(
    db: Session,
    *,
    classroom_id: int,
    roster_child_id: int,
    child_name: str,
) -> None:
    conflict = db.query(ClassroomMember.id).join(
        Student,
        Student.id == ClassroomMember.roster_child_id,
    ).filter(
        ClassroomMember.classroom_id == classroom_id,
        ClassroomMember.ended_at.is_(None),
        ClassroomMember.roster_child_id != roster_child_id,
        Student.name == child_name,
    ).first()
    if conflict:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_active_child_name",
                "message": "同班目前名單不可有兩位同名學生",
            },
        )


def _assert_classroom_capacity(db: Session, classroom_id: int) -> None:
    active_count = db.query(ClassroomMember.id).filter(
        ClassroomMember.classroom_id == classroom_id,
        ClassroomMember.ended_at.is_(None),
    ).count()
    assert_project_student_capacity(active_count, 1)


def _set_roster_child_album_name(
    db: Session,
    roster_child: Student,
    raw_album_name: str | None,
) -> bool:
    """更新名冊唯一稱呼來源，並讓所有已歸班相本的舊輸出失效。"""
    album_name = normalize_student_album_name(raw_album_name)
    if roster_child.album_name == album_name:
        return False

    affected_students = (
        db.query(ProjectStudent)
        .join(Project, Project.id == ProjectStudent.project_id)
        .filter(
            ProjectStudent.roster_child_id == roster_child.id,
            Project.classroom_id.isnot(None),
        )
        .all()
    )
    now = utc_now()
    roster_child.album_name = album_name
    affected_project_ids: set[int] = set()
    for student in affected_students:
        student.output_filename = None
        student.updated_at = now
        affected_project_ids.add(int(student.project_id))
    if affected_project_ids:
        db.query(Project).filter(Project.id.in_(affected_project_ids)).update(
            {Project.updated_at: now},
            synchronize_session=False,
        )
    return True


def _assigned_project_ids_for_roster_child(
    db: Session,
    roster_child_id: int,
) -> list[int]:
    """列出稱呼變更會影響的已歸班相本，供 transaction 前依序加鎖。"""
    return sorted({
        int(project_id)
        for (project_id,) in (
            db.query(ProjectStudent.project_id)
            .join(Project, Project.id == ProjectStudent.project_id)
            .filter(
                ProjectStudent.roster_child_id == roster_child_id,
                Project.classroom_id.isnot(None),
            )
            .all()
        )
    })


def _automatic_roster_album_names(db: Session) -> dict[int, str | None]:
    """依目前班級與所有已歸班相本，推導不會碰撞的中央稱呼。"""
    roster_children = db.query(Student).order_by(Student.id).all()
    candidate_by_child_id = {
        int(roster_child.id): suggest_automatic_album_name(str(roster_child.name))
        for roster_child in roster_children
        if not roster_child.album_name
    }
    active_candidate_by_child_id = {
        child_id: candidate
        for child_id, candidate in candidate_by_child_id.items()
        if candidate is not None
    }
    album_name_by_child_id = {
        int(roster_child.id): (
            str(roster_child.album_name) if roster_child.album_name else None
        )
        for roster_child in roster_children
    }
    collision_scopes: dict[
        tuple[str, int],
        list[tuple[int, str]],
    ] = {}

    for classroom_id, child_id, child_name in (
        db.query(
            ClassroomMember.classroom_id,
            Student.id,
            Student.name,
        )
        .join(
            Student,
            Student.id == ClassroomMember.roster_child_id,
        )
        .filter(ClassroomMember.ended_at.is_(None))
        .order_by(ClassroomMember.classroom_id, ClassroomMember.id)
        .all()
    ):
        collision_scopes.setdefault(("classroom", int(classroom_id)), []).append(
            (int(child_id), str(child_name))
        )

    for project_id, child_id, student_name in (
        db.query(ProjectStudent.project_id, ProjectStudent.roster_child_id, ProjectStudent.name)
        .join(Project, Project.id == ProjectStudent.project_id)
        .filter(
            Project.classroom_id.isnot(None),
            ProjectStudent.roster_child_id.isnot(None),
        )
        .order_by(ProjectStudent.project_id, ProjectStudent.order_index, ProjectStudent.id)
        .all()
    ):
        collision_scopes.setdefault(("project", int(project_id)), []).append(
            (int(child_id), str(student_name))
        )

    while True:
        rejected_child_ids: set[int] = set()
        for scope_members in collision_scopes.values():
            effective_names = [
                album_name_by_child_id.get(child_id)
                or active_candidate_by_child_id.get(child_id)
                or fallback_name
                for child_id, fallback_name in scope_members
            ]
            effective_name_counts = Counter(effective_names)
            rejected_child_ids.update(
                child_id
                for (child_id, _fallback_name), effective_name in zip(
                    scope_members,
                    effective_names,
                    strict=True,
                )
                if child_id in active_candidate_by_child_id
                and effective_name_counts[effective_name] > 1
            )
        if not rejected_child_ids:
            break
        for child_id in rejected_child_ids:
            active_candidate_by_child_id.pop(child_id, None)

    return {
        child_id: active_candidate_by_child_id.get(child_id)
        for child_id in candidate_by_child_id
    }


def _auto_fill_roster_children(
    db: Session,
    roster_child_ids: list[int],
) -> dict[str, int]:
    roster_children = (
        db.query(Student)
        .filter(Student.id.in_(sorted(set(roster_child_ids))))
        .order_by(Student.id)
        .all()
        if roster_child_ids
        else []
    )
    eligible_children = [
        roster_child
        for roster_child in roster_children
        if not roster_child.album_name
    ]
    automatic_album_names = _automatic_roster_album_names(db)
    updated_count = 0
    unresolved_count = 0
    for roster_child in eligible_children:
        album_name = automatic_album_names.get(int(roster_child.id))
        if album_name is None:
            unresolved_count += 1
            continue
        if _set_roster_child_album_name(db, roster_child, album_name):
            updated_count += 1
    return {"updated": updated_count, "unresolved": unresolved_count}


def auto_fill_roster_child_album_name(
    db: Session,
    roster_child_id: int,
) -> dict[str, int]:
    """只替空白的園所孩子身分填入可安全推導的中央稱呼。"""
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        roster_child = db.get(Student, roster_child_id)
        if roster_child is None:
            raise HTTPException(status_code=404, detail="Roster child not found")
        project_ids = _assigned_project_ids_for_roster_child(db, roster_child_id)
        with lock_project_content_writes(project_ids):
            with organization_write_transaction(db):
                if db.get(Student, roster_child_id) is None:
                    raise HTTPException(status_code=404, detail="Roster child not found")
                result = _auto_fill_roster_children(db, [roster_child_id])
                db.commit()
                return result


def auto_fill_classroom_member_album_names(
    db: Session,
    classroom_id: int,
) -> dict[str, int]:
    """整批填入班級目前名單中尚未設定且不碰撞的中央稱呼。"""
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        get_classroom_or_404(classroom_id, db)
        child_ids = [
            int(child_id)
            for (child_id,) in db.query(ClassroomMember.roster_child_id).filter(
                ClassroomMember.classroom_id == classroom_id,
                ClassroomMember.ended_at.is_(None),
            ).all()
        ]
        project_ids = sorted({
            project_id
            for child_id in child_ids
            for project_id in _assigned_project_ids_for_roster_child(db, child_id)
        })
        with lock_project_content_writes(project_ids):
            with organization_write_transaction(db):
                get_classroom_or_404(classroom_id, db)
                result = _auto_fill_roster_children(db, child_ids)
                db.commit()
                return result


def update_roster_child_album_name(
    db: Session,
    roster_child_id: int,
    album_name: str | None,
) -> dict:
    """讓無目前 membership 的既有已歸班學生也能由園所設定修改稱呼。"""
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        roster_child = db.get(Student, roster_child_id)
        if roster_child is None:
            raise HTTPException(status_code=404, detail="Roster child not found")
        project_ids = _assigned_project_ids_for_roster_child(db, roster_child_id)
        with lock_project_content_writes(project_ids):
            with organization_write_transaction(db):
                roster_child = db.get(Student, roster_child_id)
                if roster_child is None:
                    raise HTTPException(status_code=404, detail="Roster child not found")
                _set_roster_child_album_name(db, roster_child, album_name)
                db.commit()
                db.refresh(roster_child)
                return {
                    "ok": True,
                    "roster_child_id": roster_child.id,
                    "name": roster_child.name,
                    "album_name": roster_child.album_name,
                    "effective_album_name": roster_child.effective_album_name,
                }


def _update_classroom_member_in_transaction(
    db: Session,
    classroom_id: int,
    member_id: int,
    changes: dict,
) -> dict:
    member = get_class_roster_member_or_404(member_id, classroom_id, db)
    if "name" in changes:
        if changes["name"] is None:
            raise HTTPException(status_code=422, detail="學生姓名不可空白")
        child_name = normalize_student_name(changes["name"])
        normalized_identity = normalize_child_name(child_name)
        if not normalized_identity:
            raise HTTPException(status_code=422, detail="學生姓名不可空白")
        active_membership = db.query(ClassroomMember).filter(
            ClassroomMember.roster_child_id == member.roster_child_id,
            ClassroomMember.ended_at.is_(None),
        ).first()
        if active_membership:
            _assert_active_name_available(
                db,
                classroom_id=active_membership.classroom_id,
                roster_child_id=member.roster_child_id,
                child_name=normalized_identity,
            )
        member.roster_child.name = normalized_identity

    if "album_name" in changes:
        _set_roster_child_album_name(
            db,
            member.roster_child,
            changes["album_name"],
        )

    target_classroom_id = changes.get("target_classroom_id")
    status = changes.get("status")
    if changes.get("end_reason") is not None and status != "ended":
        raise HTTPException(status_code=422, detail="end_reason 只能搭配 ended 狀態")
    if target_classroom_id is not None and status is not None:
        raise HTTPException(status_code=422, detail="轉班與狀態更新不可同時送出")

    transferred_member = None
    now = utc_now()
    if target_classroom_id is not None:
        if member.ended_at is not None:
            raise HTTPException(status_code=409, detail="已結束的名單區間不可轉班")
        if target_classroom_id == classroom_id:
            raise HTTPException(status_code=422, detail="目標班級不可與原班級相同")
        target_classroom = get_classroom_or_404(target_classroom_id, db)
        if not target_classroom.is_current or not target_classroom.campus.is_active:
            raise HTTPException(status_code=409, detail="只能轉入使用中的分校與班級")
        _assert_child_has_no_active_membership(
            db,
            member.roster_child_id,
            excluded_member_id=member.id,
        )
        _assert_classroom_capacity(db, target_classroom_id)
        _assert_active_name_available(
            db,
            classroom_id=target_classroom_id,
            roster_child_id=member.roster_child_id,
            child_name=member.roster_child.name,
        )
        member.ended_at = now
        member.end_reason = "transfer"
        db.flush()
        transferred_member = ClassroomMember(
            classroom_id=target_classroom_id,
            roster_child_id=member.roster_child_id,
            started_at=now,
        )
        db.add(transferred_member)
    elif status == "ended" and member.ended_at is None:
        member.ended_at = now
        member.end_reason = changes.get("end_reason") or "departed"
    elif status == "active" and member.ended_at is not None:
        if not member.classroom.is_current or not member.classroom.campus.is_active:
            raise HTTPException(status_code=409, detail="只能恢復到使用中的分校與班級")
        _assert_child_has_no_active_membership(db, member.roster_child_id)
        _assert_classroom_capacity(db, classroom_id)
        _assert_active_name_available(
            db,
            classroom_id=classroom_id,
            roster_child_id=member.roster_child_id,
            child_name=member.roster_child.name,
        )
        transferred_member = ClassroomMember(
            classroom_id=classroom_id,
            roster_child_id=member.roster_child_id,
            started_at=now,
        )
        db.add(transferred_member)

    db.flush()
    db.commit()
    if transferred_member is not None:
        db.refresh(transferred_member)
    current_member = (
        transferred_member
        if status == "active" and member.ended_at is not None
        else member
    )
    return {
        "member": _serialize_member(current_member),
        "transferred_member": (
            _serialize_member(transferred_member)
            if target_classroom_id is not None and transferred_member is not None
            else None
        ),
    }


def update_classroom_member(
    db: Session,
    classroom_id: int,
    member_id: int,
    changes: dict,
) -> dict:
    """依 organization→project→DB 鎖序更新名單與中央相本稱呼。"""
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        member = get_class_roster_member_or_404(member_id, classroom_id, db)
        project_ids = (
            _assigned_project_ids_for_roster_child(db, int(member.roster_child_id))
            if "album_name" in changes
            else []
        )
        with lock_project_content_writes(project_ids):
            with organization_write_transaction(db):
                return _update_classroom_member_in_transaction(
                    db,
                    classroom_id,
                    member_id,
                    changes,
                )


def create_classroom_project(
    db: Session,
    current_user: User,
    classroom_id: int,
    *,
    name: str,
    template_id: int,
    work_slot_id: int,
    owner_id: int | None,
) -> dict:
    project_name = _normalize_organization_name(name, "相本")
    with organization_acl_lock, lock_template_write(template_id):
        with organization_write_transaction(db):
            classroom = get_classroom_or_404(classroom_id, db)
            creator = get_user_or_404(current_user.id, db)
            template = get_template_or_404(template_id, db)
            assert_classroom_project_creatable(db, creator, classroom_id)
            work_slot = (
                db.query(ClassPeriodWorkSlot)
                .options(
                    selectinload(ClassPeriodWorkSlot.classroom).selectinload(
                        Classroom.semester
                    ),
                    selectinload(ClassPeriodWorkSlot.semester_period).selectinload(
                        SemesterPeriod.template_period
                    ),
                )
                .filter(ClassPeriodWorkSlot.id == work_slot_id)
                .first()
            )
            if work_slot is None:
                raise HTTPException(status_code=404, detail="找不到班級期別工作格")
            classroom = work_slot.classroom
            semester_period = work_slot.semester_period
            if classroom.id != classroom_id:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "work_slot_classroom_mismatch",
                        "message": "工作格不屬於指定班級",
                    },
                )
            if classroom.semester.status not in {"imported", "active"}:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "work_slot_term_not_current",
                        "message": "只能在目前正式學期建立相本",
                    },
                )
            if semester_period.template_period_id != template.period_id:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "work_slot_period_mismatch",
                        "message": "工作格期別與模板期別不一致",
                    },
                )
            if semester_period.department != classroom.department:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "work_slot_department_mismatch",
                        "message": "工作格與模板部門必須一致",
                    },
                )
            if work_slot.started_at is not None:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "work_slot_already_started",
                        "message": "此班級期別已建立相本",
                    },
                )
            if not classroom.is_current or not classroom.campus.is_active:
                raise HTTPException(
                    status_code=409,
                    detail="只能為使用中的分校與班級建立相本",
                )
            active_assignments = (
                db.query(ClassroomTeacher)
                .options(selectinload(ClassroomTeacher.teacher))
                .filter(
                    ClassroomTeacher.classroom_id == classroom_id,
                    ClassroomTeacher.ended_at.is_(None),
                )
                .order_by(ClassroomTeacher.id)
                .all()
            )
            lead_assignments = [
                assignment
                for assignment in active_assignments
                if assignment.duty == "lead"
            ]
            if len(lead_assignments) != 1:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "classroom_lead_required",
                        "message": "班級必須先設定一位主教",
                    },
                )
            invalid_assignments = [
                assignment.id
                for assignment in active_assignments
                if assignment.teacher is None
                or assignment.teacher.role not in {"teacher", "supervisor"}
            ]
            if invalid_assignments:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "invalid_teacher_role",
                        "assignment_ids": invalid_assignments,
                    },
                )
            lead = lead_assignments[0]
            selected_owner_id = owner_id if owner_id is not None else lead.teacher_id
            assignment_by_teacher_id = {
                assignment.teacher_id: assignment for assignment in active_assignments
            }
            if selected_owner_id not in assignment_by_teacher_id:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "owner_not_active_classroom_teacher",
                        "message": "相本負責人必須是該班目前老師",
                    },
                )
            owner = assignment_by_teacher_id[selected_owner_id].teacher
            validate_project_owner(owner)
            if (
                template.period is None
                or template.period.status != "active"
                or template.period.department != classroom.department
            ):
                raise HTTPException(
                    status_code=400,
                    detail="只能使用同部門且使用中的期別模板建立相本",
                )
            active_members = (
                db.query(ClassroomMember)
                .options(selectinload(ClassroomMember.roster_child))
                .filter(
                    ClassroomMember.classroom_id == classroom_id,
                    ClassroomMember.ended_at.is_(None),
                )
                .order_by(ClassroomMember.started_at, ClassroomMember.id)
                .all()
            )
            if not active_members:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "classroom_roster_empty",
                        "message": "班級目前沒有學生，無法建立相本",
                    },
                )
            assert_project_student_capacity(0, len(active_members))
            student_names = [member.roster_child.name for member in active_members]
            duplicate_names = [
                child_name
                for child_name, count in Counter(student_names).items()
                if count > 1
            ]
            if duplicate_names:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "duplicate_active_child_name",
                        "names": duplicate_names,
                    },
                )
            project = build_project_record(
                db,
                template,
                creator,
                owner,
                name=project_name,
                department=classroom.department,
                template_period_id=template.period.id,
                classroom_id=classroom_id,
                class_period_work_slot_id=work_slot.id,
                campus_id_snapshot=classroom.campus_id,
                campus_name_snapshot=classroom.campus.name,
                classroom_name_snapshot=classroom.name,
            )
            work_slot.started_at = utc_now()
            db.flush()
            for order_index, member in enumerate(active_members):
                db.add(ProjectStudent(
                    project_id=project.id,
                    name=member.roster_child.name,
                    album_name=None,
                    order_index=order_index,
                    pages_data_json="[]",
                    roster_child_id=member.roster_child_id,
                ))
            db.flush()
            db.commit()
            db.refresh(project)
            return _serialize_project(project)
