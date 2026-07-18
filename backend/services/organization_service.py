"""分校、班級目前名單與每期相本快照 use cases。"""

import hashlib
import json
from collections import Counter
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import text
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
    AcademicTerm,
    AcademicTermClassroom,
    AcademicTermClassroomStudent,
    AcademicTermClassroomTeacher,
    AcademicTermPeriod,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacherAssignment,
    ClassRosterMember,
    OrganizationSupervisorAssignment,
    Project,
    RosterChild,
    Student,
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
from services.student_album_name_policy import assign_automatic_album_names
from services.student_input_policy import (
    assert_project_student_capacity,
    normalize_student_name,
    validate_student_batch_size,
)
from services.template_sync_locks import lock_template_write
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


def _serialize_member(member: ClassRosterMember) -> dict:
    return {
        "id": member.id,
        "classroom_id": member.classroom_id,
        "roster_child_id": member.roster_child_id,
        "name": member.roster_child.name,
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
                "album_name": student.album_name,
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
    term_classroom = work_slot.term_classroom
    term_period = work_slot.term_period
    return {
        "id": work_slot.id,
        "academic_term_id": term_classroom.academic_term_id,
        "academic_term_label": term_classroom.academic_term.label,
        "academic_term_status": term_classroom.academic_term.status,
        "classroom_id": term_classroom.classroom_id,
        "campus_id": term_classroom.campus_id_snapshot,
        "campus_name": term_classroom.campus_name_snapshot,
        "classroom_name": term_classroom.classroom_name_snapshot,
        "department": term_classroom.department,
        "term_period_id": term_period.id,
        "template_period_id": term_period.template_period_id,
        "period_name": term_period.period_name_snapshot,
        "period_position": term_period.position,
        "template_ids": [
            template.id for template in term_period.template_period.templates
        ],
        "started_at": work_slot.started_at,
        "can_create_project": work_slot.started_at is None,
        "project_ids": [
            project.id for project in work_slot.projects if project.deleted_at is None
        ],
    }


def _serialize_teacher_assignment(assignment: ClassroomTeacherAssignment) -> dict:
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
        "is_active": classroom.is_active,
        "created_at": classroom.created_at,
        "updated_at": classroom.updated_at,
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


def _serialize_campus(campus: Campus) -> dict:
    return {
        "id": campus.id,
        "name": campus.name,
        "is_active": campus.is_active,
        "created_at": campus.created_at,
        "updated_at": campus.updated_at,
        "supervisor_scopes": _serialize_supervisor_scopes(campus),
        "classrooms": [_serialize_classroom(classroom) for classroom in campus.classrooms],
    }


def _organization_migration_status(db: Session) -> dict:
    unassigned_project_count = db.query(Project.id).filter(
        Project.classroom_id.is_(None),
        Project.deleted_at.is_(None),
    ).count()
    pending_identity_student_count = (
        db.query(Student.id)
        .join(Project, Project.id == Student.project_id)
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
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            LEFT JOIN roster_children AS child
                ON child.id = student.roster_child_id
            WHERE project.classroom_id IS NOT NULL
              AND project.deleted_at IS NULL
              AND (student.roster_child_id IS NULL OR child.id IS NULL)

            UNION ALL

            SELECT student.id AS student_id
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE project.classroom_id IS NOT NULL
              AND project.deleted_at IS NULL
              AND student.roster_child_id IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM students AS sibling
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
            .selectinload(ClassRosterMember.roster_child),
            selectinload(Campus.classrooms)
            .selectinload(Classroom.projects)
            .selectinload(Project.students),
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
        db.query(AcademicTerm)
        .filter(AcademicTerm.status.in_(("imported", "active")))
        .order_by(AcademicTerm.id.desc())
        .first()
    )
    current_work_slots = (
        db.query(ClassPeriodWorkSlot)
        .join(
            AcademicTermClassroom,
            AcademicTermClassroom.id == ClassPeriodWorkSlot.term_classroom_id,
        )
        .options(
            selectinload(ClassPeriodWorkSlot.projects),
            selectinload(ClassPeriodWorkSlot.term_classroom).selectinload(
                AcademicTermClassroom.academic_term
            ),
            selectinload(ClassPeriodWorkSlot.term_period),
        )
        .filter(AcademicTermClassroom.academic_term_id == current_term.id)
        .order_by(
            AcademicTermClassroom.classroom_id,
            ClassPeriodWorkSlot.id,
        )
        .all()
        if current_term is not None
        else []
    )
    return {
        "campuses": [_serialize_campus(campus) for campus in campuses],
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
        "current_academic_term": (
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
        if teachers and (not classroom.is_active or not classroom.campus.is_active):
            raise HTTPException(status_code=409, detail="只能設定使用中的分校與班級")
        user_by_id = _validate_teacher_targets(db, teachers)
        current_assignments = db.query(ClassroomTeacherAssignment).filter(
            ClassroomTeacherAssignment.classroom_id == classroom_id,
            ClassroomTeacherAssignment.ended_at.is_(None),
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
            db.add(ClassroomTeacherAssignment(
                classroom_id=classroom_id,
                teacher_id=teacher.id,
                teacher_name_snapshot=teacher.display_name,
                duty=requested["duty"],
                started_at=changed_at,
                started_by_id=current_admin.id,
                started_by_name_snapshot=current_admin.display_name,
            ))
        db.flush()
        _refresh_current_term_teacher_snapshot(db, classroom_id)
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
    current_term_classrooms = [
        term_classroom
        for term_classroom in classroom.academic_term_classrooms
        if term_classroom.academic_term.status in {"imported", "active"}
    ]
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
            for term_classroom in current_term_classrooms
            for work_slot in term_classroom.work_slots
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
                ClassRosterMember.roster_child
            ),
            selectinload(Classroom.campus),
            selectinload(Classroom.academic_term_classrooms).selectinload(
                AcademicTermClassroom.academic_term
            ),
            selectinload(Classroom.academic_term_classrooms)
            .selectinload(AcademicTermClassroom.work_slots)
            .selectinload(ClassPeriodWorkSlot.projects),
            selectinload(Classroom.academic_term_classrooms)
            .selectinload(AcademicTermClassroom.work_slots)
            .selectinload(ClassPeriodWorkSlot.term_period)
            .selectinload(AcademicTermPeriod.template_period)
            .selectinload(TemplatePeriod.templates),
        )
        .filter(
            Classroom.id.in_(organization_scope.classroom_ids),
            Classroom.is_active.is_(True),
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
    return _serialize_campus(campus)


@organization_mutation
def update_campus(db: Session, campus_id: int, changes: dict) -> dict:
    campus = get_campus_or_404(campus_id, db)
    if changes.get("is_active") is False:
        has_active_classrooms = db.query(Classroom.id).filter(
            Classroom.campus_id == campus_id,
            Classroom.is_active.is_(True),
        ).first()
        has_active_members = (
            db.query(ClassRosterMember.id)
            .join(Classroom, Classroom.id == ClassRosterMember.classroom_id)
            .filter(
                Classroom.campus_id == campus_id,
                ClassRosterMember.ended_at.is_(None),
            )
            .first()
        )
        has_active_teachers = (
            db.query(ClassroomTeacherAssignment.id)
            .join(
                Classroom,
                Classroom.id == ClassroomTeacherAssignment.classroom_id,
            )
            .filter(
                Classroom.campus_id == campus_id,
                ClassroomTeacherAssignment.ended_at.is_(None),
            )
            .first()
        )
        if has_active_classrooms or has_active_members or has_active_teachers:
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
    return _serialize_campus(campus)


def _assert_classroom_name_available(
    db: Session,
    *,
    campus_id: int,
    department: str,
    name: str,
    excluded_classroom_id: int | None = None,
) -> None:
    query = db.query(Classroom.id).filter(
        Classroom.campus_id == campus_id,
        Classroom.department == department,
        Classroom.name == name,
    )
    if excluded_classroom_id is not None:
        query = query.filter(Classroom.id != excluded_classroom_id)
    if query.first():
        raise HTTPException(status_code=409, detail="同分校與部門已有同名班級")


def _ensure_current_term_classroom_grid(
    db: Session,
    classroom: Classroom,
) -> AcademicTermClassroom | None:
    if not classroom.is_active or not classroom.campus.is_active:
        return None
    current_term = (
        db.query(AcademicTerm)
        .filter(AcademicTerm.status.in_(("imported", "active")))
        .order_by(AcademicTerm.id.desc())
        .first()
    )
    if current_term is None:
        return None
    term_classroom = db.query(AcademicTermClassroom).filter(
        AcademicTermClassroom.academic_term_id == current_term.id,
        AcademicTermClassroom.classroom_id == classroom.id,
    ).first()
    if term_classroom is None:
        term_classroom = AcademicTermClassroom(
            academic_term_id=current_term.id,
            classroom_id=classroom.id,
            campus_id_snapshot=classroom.campus_id,
            campus_name_snapshot=classroom.campus.name,
            classroom_name_snapshot=classroom.name,
            department=classroom.department,
        )
        db.add(term_classroom)
        db.flush()
    # term classroom 是該學期的校班／部門 authority；班級日後改名或移校
    # 不得把同一正式學期的既有快照悄悄改成另一套 scope。
    period_query = db.query(AcademicTermPeriod).filter(
        AcademicTermPeriod.academic_term_id == current_term.id,
        AcademicTermPeriod.department == term_classroom.department,
    )
    if current_term.status == "imported":
        period_query = period_query.join(
            TemplatePeriod,
            TemplatePeriod.id == AcademicTermPeriod.template_period_id,
        ).filter(TemplatePeriod.status == "active")
    for term_period in period_query.order_by(AcademicTermPeriod.position).all():
        if db.query(ClassPeriodWorkSlot.id).filter(
            ClassPeriodWorkSlot.term_classroom_id == term_classroom.id,
            ClassPeriodWorkSlot.term_period_id == term_period.id,
        ).first() is None:
            db.add(ClassPeriodWorkSlot(
                term_classroom_id=term_classroom.id,
                term_period_id=term_period.id,
            ))
    return term_classroom


def _refresh_current_term_teacher_snapshot(
    db: Session,
    classroom_id: int,
) -> None:
    term_classroom = (
        db.query(AcademicTermClassroom)
        .join(AcademicTerm, AcademicTerm.id == AcademicTermClassroom.academic_term_id)
        .filter(
            AcademicTerm.status.in_(("imported", "active")),
            AcademicTermClassroom.classroom_id == classroom_id,
        )
        .first()
    )
    if term_classroom is None:
        return
    existing_snapshot_count = db.query(AcademicTermClassroomTeacher.id).filter(
        AcademicTermClassroomTeacher.term_classroom_id == term_classroom.id
    ).count()
    if term_classroom.academic_term.status == "active":
        # 正式學期中途新增的班級在建立時還沒有老師；只允許第一次編制補齊
        # 顯示快照，已有快照後不再因日常換班老師改寫歷史。
        if existing_snapshot_count:
            return
        has_started_slot = db.query(ClassPeriodWorkSlot.id).filter(
            ClassPeriodWorkSlot.term_classroom_id == term_classroom.id,
            ClassPeriodWorkSlot.started_at.isnot(None),
        ).first()
        if has_started_slot:
            return
    else:
        db.query(AcademicTermClassroomTeacher).filter(
            AcademicTermClassroomTeacher.term_classroom_id == term_classroom.id
        ).delete(synchronize_session=False)
    assignments = db.query(ClassroomTeacherAssignment).filter(
        ClassroomTeacherAssignment.classroom_id == classroom_id,
        ClassroomTeacherAssignment.ended_at.is_(None),
        ClassroomTeacherAssignment.teacher_id.isnot(None),
    ).all()
    for assignment in assignments:
        db.add(AcademicTermClassroomTeacher(
            term_classroom_id=term_classroom.id,
            source_assignment_id=assignment.id,
            teacher_id=assignment.teacher_id,
            teacher_name_snapshot=assignment.teacher_name_snapshot,
            duty=assignment.duty,
        ))


def _sync_current_term_student_snapshots(
    db: Session,
    roster_child_ids: set[int],
) -> None:
    """同步目前學期最終名單；已關閉學期不回寫。"""
    if not roster_child_ids:
        return
    current_term = (
        db.query(AcademicTerm)
        .filter(AcademicTerm.status.in_(("imported", "active")))
        .order_by(AcademicTerm.id.desc())
        .first()
    )
    if current_term is None:
        return
    active_memberships = (
        db.query(ClassRosterMember)
        .options(
            selectinload(ClassRosterMember.roster_child),
            selectinload(ClassRosterMember.classroom).selectinload(
                Classroom.campus
            ),
        )
        .filter(
            ClassRosterMember.roster_child_id.in_(roster_child_ids),
            ClassRosterMember.ended_at.is_(None),
        )
        .order_by(ClassRosterMember.id.desc())
        .all()
    )
    for membership in active_memberships:
        _ensure_current_term_classroom_grid(db, membership.classroom)
    db.flush()
    term_classrooms = (
        db.query(AcademicTermClassroom)
        .filter(AcademicTermClassroom.academic_term_id == current_term.id)
        .order_by(AcademicTermClassroom.id)
        .all()
    )
    if not term_classrooms:
        return
    term_classroom_by_classroom_id = {
        term_classroom.classroom_id: term_classroom
        for term_classroom in term_classrooms
    }
    existing_snapshots = (
        db.query(AcademicTermClassroomStudent)
        .filter(
            AcademicTermClassroomStudent.academic_term_id == current_term.id,
            AcademicTermClassroomStudent.roster_child_id_snapshot.in_(
                roster_child_ids
            ),
        )
        .all()
    )
    existing_by_child_id = {
        snapshot.roster_child_id_snapshot: snapshot
        for snapshot in existing_snapshots
    }
    child_by_id = {
        child.id: child
        for child in db.query(RosterChild)
        .filter(RosterChild.id.in_(roster_child_ids))
        .all()
    }
    membership_by_child_id = {
        membership.roster_child_id: membership
        for membership in active_memberships
    }
    for child_id, snapshot in existing_by_child_id.items():
        snapshot.student_name_snapshot = child_by_id[child_id].name
        membership = membership_by_child_id.get(child_id)
        if membership is None:
            continue
        snapshot.term_classroom_id = term_classroom_by_classroom_id[
            membership.classroom_id
        ].id
        snapshot.source_membership_id = membership.id

    for child_id, membership in membership_by_child_id.items():
        if child_id in existing_by_child_id:
            continue
        term_classroom = term_classroom_by_classroom_id[membership.classroom_id]
        db.add(AcademicTermClassroomStudent(
            academic_term_id=current_term.id,
            term_classroom_id=term_classroom.id,
            source_membership_id=membership.id,
            roster_child_id_snapshot=child_id,
            student_name_snapshot=membership.roster_child.name,
        ))

    missing_child_ids = roster_child_ids - set(existing_by_child_id) - set(
        membership_by_child_id
    )
    if current_term.status != "imported" or not missing_child_ids:
        return
    project_students = (
        db.query(Student, Project.classroom_id)
        .join(Project, Project.id == Student.project_id)
        .filter(
            Project.deleted_at.is_(None),
            Project.classroom_id.in_(term_classroom_by_classroom_id),
            Student.roster_child_id.in_(missing_child_ids),
        )
        .order_by(Project.created_at.desc(), Project.id.desc(), Student.id.desc())
        .all()
    )
    fallback_child_ids: set[int] = set()
    for student, classroom_id in project_students:
        child_id = student.roster_child_id
        if child_id in fallback_child_ids:
            continue
        fallback_child_ids.add(child_id)
        term_classroom = term_classroom_by_classroom_id[classroom_id]
        db.add(AcademicTermClassroomStudent(
            academic_term_id=current_term.id,
            term_classroom_id=term_classroom.id,
            source_membership_id=None,
            roster_child_id_snapshot=child_id,
            student_name_snapshot=student.name,
        ))


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
    if is_active and not campus.is_active:
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
        department=classroom_department,
        name=classroom_name,
    )
    classroom = Classroom(
        campus_id=campus_id,
        department=classroom_department,
        name=classroom_name,
        is_active=is_active,
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
    if "is_active" in changes and changes["is_active"] is None:
        raise HTTPException(status_code=422, detail="is_active 不可為空")
    target_is_active = changes.get("is_active", classroom.is_active)
    if target_is_active is False and classroom.is_active:
        has_active_members = db.query(ClassRosterMember.id).filter(
            ClassRosterMember.classroom_id == classroom_id,
            ClassRosterMember.ended_at.is_(None),
        ).first()
        has_active_teachers = db.query(ClassroomTeacherAssignment.id).filter(
            ClassroomTeacherAssignment.classroom_id == classroom_id,
            ClassroomTeacherAssignment.ended_at.is_(None),
        ).first()
        if has_active_members or has_active_teachers:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "classroom_has_active_roster_or_teachers",
                    "message": "請先清空目前學生名單與老師編制再停用班級",
                },
            )
    campus_id = changes.get("campus_id", classroom.campus_id)
    department = _validate_department(
        changes.get("department", classroom.department)
    )
    name = _normalize_organization_name(
        changes.get("name", classroom.name),
        "班級",
    )
    campus = get_campus_or_404(campus_id, db)
    if target_is_active and not campus.is_active:
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
    classroom.campus_id = campus_id
    classroom.department = department
    classroom.name = name
    if "is_active" in changes:
        classroom.is_active = changes["is_active"]
    classroom.updated_at = utc_now()
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
    if not classroom.is_active or not classroom.campus.is_active:
        raise HTTPException(status_code=409, detail="只能編輯使用中的分校與班級")
    validate_student_batch_size(len(members))
    normalized_names = [normalize_student_name(item["name"]) for item in members]
    created_members: list[ClassRosterMember] = []
    skipped_names: list[str] = []
    names_seen: set[str] = set()
    active_count = db.query(ClassRosterMember.id).filter(
        ClassRosterMember.classroom_id == classroom_id,
        ClassRosterMember.ended_at.is_(None),
    ).count()

    for member_name in normalized_names:
        normalized_identity = normalize_child_name(member_name)
        if not normalized_identity:
            continue
        if normalized_identity in names_seen:
            skipped_names.append(member_name)
            continue
        names_seen.add(normalized_identity)
        active_membership = db.query(ClassRosterMember).join(
            RosterChild,
            RosterChild.id == ClassRosterMember.roster_child_id,
        ).filter(
            ClassRosterMember.classroom_id == classroom_id,
            ClassRosterMember.ended_at.is_(None),
            RosterChild.name == normalized_identity,
        ).first()
        if active_membership:
            skipped_names.append(member_name)
            continue
        roster_child = RosterChild(name=normalized_identity)
        db.add(roster_child)
        db.flush()
        member = ClassRosterMember(
            classroom_id=classroom_id,
            roster_child_id=roster_child.id,
        )
        db.add(member)
        created_members.append(member)

    assert_project_student_capacity(active_count, len(created_members))
    db.flush()
    _sync_current_term_student_snapshots(
        db,
        {int(member.roster_child_id) for member in created_members},
    )
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
    query = db.query(ClassRosterMember).filter(
        ClassRosterMember.roster_child_id == roster_child_id,
        ClassRosterMember.ended_at.is_(None),
    )
    if excluded_member_id is not None:
        query = query.filter(ClassRosterMember.id != excluded_member_id)
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
    conflict = db.query(ClassRosterMember.id).join(
        RosterChild,
        RosterChild.id == ClassRosterMember.roster_child_id,
    ).filter(
        ClassRosterMember.classroom_id == classroom_id,
        ClassRosterMember.ended_at.is_(None),
        ClassRosterMember.roster_child_id != roster_child_id,
        RosterChild.name == child_name,
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
    active_count = db.query(ClassRosterMember.id).filter(
        ClassRosterMember.classroom_id == classroom_id,
        ClassRosterMember.ended_at.is_(None),
    ).count()
    assert_project_student_capacity(active_count, 1)


@organization_mutation
def update_classroom_member(
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
        active_membership = db.query(ClassRosterMember).filter(
            ClassRosterMember.roster_child_id == member.roster_child_id,
            ClassRosterMember.ended_at.is_(None),
        ).first()
        if active_membership:
            _assert_active_name_available(
                db,
                classroom_id=active_membership.classroom_id,
                roster_child_id=member.roster_child_id,
                child_name=normalized_identity,
            )
        member.roster_child.name = normalized_identity

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
        if not target_classroom.is_active or not target_classroom.campus.is_active:
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
        transferred_member = ClassRosterMember(
            classroom_id=target_classroom_id,
            roster_child_id=member.roster_child_id,
            started_at=now,
        )
        db.add(transferred_member)
    elif status == "ended" and member.ended_at is None:
        member.ended_at = now
        member.end_reason = changes.get("end_reason") or "departed"
    elif status == "active" and member.ended_at is not None:
        if not member.classroom.is_active or not member.classroom.campus.is_active:
            raise HTTPException(status_code=409, detail="只能恢復到使用中的分校與班級")
        _assert_child_has_no_active_membership(db, member.roster_child_id)
        _assert_classroom_capacity(db, classroom_id)
        _assert_active_name_available(
            db,
            classroom_id=classroom_id,
            roster_child_id=member.roster_child_id,
            child_name=member.roster_child.name,
        )
        transferred_member = ClassRosterMember(
            classroom_id=classroom_id,
            roster_child_id=member.roster_child_id,
            started_at=now,
        )
        db.add(transferred_member)

    db.flush()
    _sync_current_term_student_snapshots(db, {int(member.roster_child_id)})
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


def _migration_error(
    status_code: int,
    code: str,
    message: str,
    **details,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, **details},
    )


def _canonical_datetime(value: datetime | None) -> str | None:
    return value.isoformat(timespec="microseconds") if value is not None else None


def _assert_project_migration_target(
    project: Project,
    classroom: Classroom,
) -> None:
    if project.deleted_at is not None:
        raise _migration_error(
            409,
            "archived_project_migration_forbidden",
            "封存中的相本不可執行歸班遷移，請先還原相本",
        )
    if project.classroom_id is not None:
        raise _migration_error(
            409,
            "project_already_assigned",
            "相本已歸入班級，學生身分快照不可再遷移",
        )
    if not classroom.is_active or not classroom.campus.is_active:
        raise _migration_error(
            409,
            "inactive_project_migration_target",
            "只能歸入使用中的分校與班級",
        )
    if project.department is not None and project.department != classroom.department:
        raise _migration_error(
            422,
            "project_classroom_department_mismatch",
            "相本與目標班級部門不一致",
            project_department=project.department,
            classroom_department=classroom.department,
        )


def _build_established_identity_candidates(
    db: Session,
    target_classroom_id: int,
    students: list[Student],
) -> tuple[list[dict], dict[int, list[int]]]:
    membership_rows = (
        db.query(
            ClassRosterMember.roster_child_id,
            ClassRosterMember.id,
            ClassRosterMember.classroom_id,
            ClassRosterMember.started_at,
            ClassRosterMember.ended_at,
            ClassRosterMember.end_reason,
            Classroom.name,
            Classroom.department,
            Campus.id,
            Campus.name,
        )
        .join(Classroom, Classroom.id == ClassRosterMember.classroom_id)
        .join(Campus, Campus.id == Classroom.campus_id)
        .order_by(ClassRosterMember.id)
        .all()
    )
    project_rows = (
        db.query(
            Student.roster_child_id,
            Project.id,
            Project.name,
            Student.id,
            Project.classroom_id,
            Project.deleted_at,
            Classroom.name,
            Classroom.department,
            Campus.id,
            Campus.name,
            Project.template_period_id,
            TemplatePeriod.name,
        )
        .join(Project, Project.id == Student.project_id)
        .join(Classroom, Classroom.id == Project.classroom_id)
        .join(Campus, Campus.id == Classroom.campus_id)
        .outerjoin(
            TemplatePeriod,
            TemplatePeriod.id == Project.template_period_id,
        )
        .filter(
            Project.classroom_id.isnot(None),
            Student.roster_child_id.isnot(None),
        )
        .order_by(Project.id, Student.id)
        .all()
    )
    established_ids = {
        row[0] for row in membership_rows
    } | {
        row[0] for row in project_rows
    }
    if not established_ids:
        return [], {int(student.id): [] for student in students}

    children = (
        db.query(RosterChild)
        .filter(RosterChild.id.in_(established_ids))
        .order_by(RosterChild.name, RosterChild.id)
        .all()
    )
    target_memberships: dict[int, list[dict]] = {}
    other_memberships: dict[int, list[dict]] = {}
    for (
        child_id,
        member_id,
        classroom_id,
        started_at,
        ended_at,
        end_reason,
        classroom_name,
        department,
        campus_id,
        campus_name,
    ) in membership_rows:
        is_target_classroom = classroom_id == target_classroom_id
        evidence = {
            "kind": (
                "target_membership"
                if is_target_classroom
                else "same_name_membership"
            ),
            "membership_id": member_id,
            "campus_id": campus_id,
            "campus_name": campus_name,
            "classroom_id": classroom_id,
            "classroom_name": classroom_name,
            "department": department,
            "status": "ended" if ended_at is not None else "active",
            "started_at": _canonical_datetime(started_at),
            "ended_at": _canonical_datetime(ended_at),
            "end_reason": end_reason,
        }
        evidence_by_child = (
            target_memberships if is_target_classroom else other_memberships
        )
        evidence_by_child.setdefault(child_id, []).append(evidence)
    target_projects: dict[int, list[dict]] = {}
    other_projects: dict[int, list[dict]] = {}
    for (
        child_id,
        project_id,
        project_name,
        student_id,
        classroom_id,
        deleted_at,
        classroom_name,
        department,
        campus_id,
        campus_name,
        period_id,
        period_name,
    ) in project_rows:
        is_target_classroom = classroom_id == target_classroom_id
        evidence = {
            "kind": (
                "target_project"
                if is_target_classroom
                else "same_name_project"
            ),
            "project_id": project_id,
            "project_name": project_name,
            "student_id": student_id,
            "campus_id": campus_id,
            "campus_name": campus_name,
            "classroom_id": classroom_id,
            "classroom_name": classroom_name,
            "department": department,
            "period_id": period_id,
            "period_name": period_name,
            "status": "archived" if deleted_at is not None else "active",
        }
        evidence_by_child = target_projects if is_target_classroom else other_projects
        evidence_by_child.setdefault(child_id, []).append(evidence)

    source_ids_by_name: dict[str, list[int]] = {}
    for student in students:
        source_ids_by_name.setdefault(
            normalize_child_name(student.name),
            [],
        ).append(student.id)
    loaded_child_ids = {child.id for child in children}
    target_child_ids = (
        set(target_memberships) | set(target_projects)
    ) & loaded_child_ids
    candidates: list[dict] = []
    candidate_ids_by_normalized_name: dict[str, list[int]] = {}
    for child in children:
        normalized_name = normalize_child_name(child.name)
        matching_student_ids = source_ids_by_name.get(normalized_name, [])
        if child.id not in target_child_ids and not matching_student_ids:
            continue
        evidence = [
            *target_memberships.get(child.id, []),
            *target_projects.get(child.id, []),
            *other_memberships.get(child.id, []),
            *other_projects.get(child.id, []),
        ]
        if matching_student_ids:
            evidence.append({
                "kind": "same_name_established",
                "student_ids": sorted(matching_student_ids),
            })
            candidate_ids_by_normalized_name.setdefault(
                normalized_name,
                [],
            ).append(child.id)
        candidates.append({
            "roster_child_id": child.id,
            "name": child.name,
            "evidence": evidence,
        })

    candidates.sort(key=lambda row: (row["name"], row["roster_child_id"]))
    allowed_by_student = {
        student.id: sorted(
            target_child_ids
            | set(candidate_ids_by_normalized_name.get(
                normalize_child_name(student.name),
                [],
            ))
        )
        for student in students
    }
    return candidates, allowed_by_student


def _build_project_classroom_migration_preview(
    db: Session,
    project_id: int,
    classroom_id: int,
) -> dict:
    project = get_project_or_404(project_id, db, include_archived=True)
    classroom = get_classroom_or_404(classroom_id, db)
    _assert_project_migration_target(project, classroom)
    students = sorted(
        project.students,
        key=lambda student: (student.order_index, student.id),
    )
    if not students:
        raise _migration_error(
            422,
            "empty_legacy_project_migration_forbidden",
            "空相本沒有可核對的學生快照，請封存後從班級目前名單重新建立",
        )
    original_child_ids = {
        student.roster_child_id
        for student in students
        if student.roster_child_id is not None
    }
    original_children = {
        child.id: child
        for child in (
            db.query(RosterChild)
            .filter(RosterChild.id.in_(original_child_ids))
            .all()
            if original_child_ids
            else []
        )
    }
    candidates, allowed_by_student = _build_established_identity_candidates(
        db,
        classroom_id,
        students,
    )
    active_roster_count = db.query(ClassRosterMember.id).filter(
        ClassRosterMember.classroom_id == classroom_id,
        ClassRosterMember.ended_at.is_(None),
    ).count()
    student_rows = []
    for student in students:
        original_child = original_children.get(student.roster_child_id)
        student_rows.append({
            "student_id": student.id,
            "name": student.name,
            "order_index": student.order_index,
            "original_roster_child": (
                {
                    "id": student.roster_child_id,
                    "name": original_child.name if original_child else None,
                }
                if student.roster_child_id is not None
                else None
            ),
            "allowed_existing_roster_child_ids": allowed_by_student[student.id],
        })
    target_row = {
        "id": classroom.id,
        "campus_id": classroom.campus_id,
        "campus_name": classroom.campus.name,
        "name": classroom.name,
        "department": classroom.department,
        "active_roster_count": active_roster_count,
        "seed_allowed": active_roster_count == 0,
    }
    fingerprint_input = {
        "project": {
            "id": project.id,
            "name": project.name,
            "department": project.department,
            "classroom_id": project.classroom_id,
            "updated_at": _canonical_datetime(project.updated_at),
        },
        "target_classroom": target_row,
        "students": student_rows,
        "established_candidates": candidates,
    }
    source_fingerprint = hashlib.sha256(json.dumps(
        fingerprint_input,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    return {
        "source_fingerprint": source_fingerprint,
        "target_classroom": target_row,
        "students": student_rows,
        "established_candidates": candidates,
    }


def get_project_classroom_migration_preview(
    db: Session,
    project_id: int,
    classroom_id: int,
) -> dict:
    return _build_project_classroom_migration_preview(
        db,
        project_id,
        classroom_id,
    )


def _ensure_legacy_project_work_slot(
    db: Session,
    project: Project,
    classroom: Classroom,
) -> ClassPeriodWorkSlot:
    """為人工歸班的有效舊相本建立或沿用正式學期工作格。"""
    if project.template_period is None:
        raise _migration_error(
            422,
            "project_period_required",
            "相本缺少期別，無法建立工作格",
        )
    term_period = db.query(AcademicTermPeriod).filter(
        AcademicTermPeriod.template_period_id == project.template_period_id
    ).first()
    if term_period is None:
        current_term = (
            db.query(AcademicTerm)
            .filter(AcademicTerm.status.in_(("imported", "active")))
            .order_by(AcademicTerm.id.desc())
            .first()
        )
        if current_term is None:
            raise _migration_error(
                409,
                "current_academic_term_required",
                "目前沒有可接收舊相本的正式學期",
            )
        last_period = (
            db.query(AcademicTermPeriod)
            .filter(AcademicTermPeriod.academic_term_id == current_term.id)
            .order_by(AcademicTermPeriod.position.desc())
            .first()
        )
        term_period = AcademicTermPeriod(
            academic_term_id=current_term.id,
            template_period_id=project.template_period.id,
            period_name_snapshot=project.template_period.name,
            department=project.template_period.department,
            position=(last_period.position + 1 if last_period is not None else 0),
        )
        db.add(term_period)
        db.flush()

    term_classroom = db.query(AcademicTermClassroom).filter(
        AcademicTermClassroom.academic_term_id == term_period.academic_term_id,
        AcademicTermClassroom.classroom_id == classroom.id,
    ).first()
    if term_classroom is None:
        term_classroom = AcademicTermClassroom(
            academic_term_id=term_period.academic_term_id,
            classroom_id=classroom.id,
            campus_id_snapshot=classroom.campus_id,
            campus_name_snapshot=classroom.campus.name,
            classroom_name_snapshot=classroom.name,
            department=classroom.department,
        )
        db.add(term_classroom)
        db.flush()
        active_assignments = db.query(ClassroomTeacherAssignment).filter(
            ClassroomTeacherAssignment.classroom_id == classroom.id,
            ClassroomTeacherAssignment.ended_at.is_(None),
            ClassroomTeacherAssignment.teacher_id.isnot(None),
        ).all()
        for assignment in active_assignments:
            db.add(AcademicTermClassroomTeacher(
                term_classroom_id=term_classroom.id,
                source_assignment_id=assignment.id,
                teacher_id=assignment.teacher_id,
                teacher_name_snapshot=assignment.teacher_name_snapshot,
                duty=assignment.duty,
            ))

    work_slot = db.query(ClassPeriodWorkSlot).filter(
        ClassPeriodWorkSlot.term_classroom_id == term_classroom.id,
        ClassPeriodWorkSlot.term_period_id == term_period.id,
    ).first()
    if work_slot is None:
        work_slot = ClassPeriodWorkSlot(
            term_classroom_id=term_classroom.id,
            term_period_id=term_period.id,
        )
        db.add(work_slot)
        db.flush()
    if work_slot.started_at is None:
        work_slot.started_at = project.created_at or utc_now()
    return work_slot


def _validate_identity_decisions(
    students: list[Student],
    decisions: list[dict],
) -> dict[int, dict]:
    student_ids = {student.id for student in students}
    decision_ids = [decision["student_id"] for decision in decisions]
    duplicate_ids = sorted(
        student_id
        for student_id, count in Counter(decision_ids).items()
        if count > 1
    )
    if duplicate_ids:
        raise _migration_error(
            422,
            "duplicate_identity_decision",
            "同一位相本學生只能有一筆身分決策",
            student_ids=duplicate_ids,
        )
    unknown_ids = sorted(set(decision_ids) - student_ids)
    if unknown_ids:
        raise _migration_error(
            422,
            "unknown_identity_decision",
            "身分決策包含不屬於此相本的學生",
            student_ids=unknown_ids,
        )
    missing_ids = sorted(student_ids - set(decision_ids))
    if missing_ids:
        raise _migration_error(
            422,
            "identity_decisions_incomplete",
            "必須逐一核對相本內所有學生",
            student_ids=missing_ids,
        )
    return {decision["student_id"]: decision for decision in decisions}


def _preflight_resolved_roster_seed(
    db: Session,
    classroom_id: int,
    resolved_children: list[RosterChild],
) -> None:
    if db.query(ClassRosterMember.id).filter(
        ClassRosterMember.classroom_id == classroom_id,
        ClassRosterMember.ended_at.is_(None),
    ).first():
        raise _migration_error(
            409,
            "target_classroom_roster_not_empty",
            "只有目前名單為空的班級可由舊相本建立名單",
        )
    assert_project_student_capacity(0, len(resolved_children))
    normalized_names = [
        normalize_child_name(child.name) for child in resolved_children
    ]
    duplicate_names = sorted(
        name for name, count in Counter(normalized_names).items() if count > 1
    )
    if duplicate_names:
        raise _migration_error(
            409,
            "duplicate_seed_roster_name",
            "目前名單不可包含同名學生",
            names=duplicate_names,
        )
    child_ids = [child.id for child in resolved_children]
    active_memberships = (
        db.query(ClassRosterMember)
        .filter(
            ClassRosterMember.roster_child_id.in_(child_ids),
            ClassRosterMember.ended_at.is_(None),
        )
        .all()
        if child_ids
        else []
    )
    if active_memberships:
        raise _migration_error(
            409,
            "project_child_already_active",
            "學生目前已在其他班級名單中",
            roster_child_ids=sorted({
                membership.roster_child_id for membership in active_memberships
            }),
            classroom_ids=sorted({
                membership.classroom_id for membership in active_memberships
            }),
        )


def assign_project_to_classroom(
    db: Session,
    current_admin: User,
    project_id: int,
    *,
    classroom_id: int,
    source_fingerprint: str,
    seed_current_roster: bool,
    student_identity_decisions: list[dict],
) -> dict:
    with organization_write_transaction(db):
        admin = get_user_or_404(current_admin.id, db)
        preview = _build_project_classroom_migration_preview(
            db,
            project_id,
            classroom_id,
        )
        if preview["source_fingerprint"] != source_fingerprint:
            raise _migration_error(
                409,
                "stale_project_classroom_migration_preview",
                "相本學生、目標班級或可用身分已變更，請重新預覽",
            )
        project = get_project_or_404(project_id, db)
        classroom = get_classroom_or_404(classroom_id, db)
        students = sorted(
            project.students,
            key=lambda student: (student.order_index, student.id),
        )
        decisions_by_student_id = _validate_identity_decisions(
            students,
            student_identity_decisions,
        )
        allowed_by_student_id = {
            row["student_id"]: set(row["allowed_existing_roster_child_ids"])
            for row in preview["students"]
        }
        candidate_by_id = {
            row["roster_child_id"]: row
            for row in preview["established_candidates"]
        }
        original_identity_rows = {
            student.id: {
                "roster_child_id": student.roster_child_id,
                "roster_child_name": (
                    student.roster_child.name
                    if student.roster_child is not None
                    else None
                ),
            }
            for student in students
        }

        existing_child_by_student_id: dict[int, RosterChild] = {}
        create_name_by_student_id: dict[int, str] = {}
        for student in students:
            decision = decisions_by_student_id[student.id]
            if decision["action"] == "existing":
                child_id = decision["roster_child_id"]
                if child_id not in allowed_by_student_id[student.id]:
                    raise _migration_error(
                        422,
                        "provisional_identity_not_allowed",
                        "只能選擇預覽列出的已確立學生身分",
                        student_id=student.id,
                        roster_child_id=child_id,
                    )
                child = db.get(RosterChild, child_id)
                if child is None or child_id not in candidate_by_id:
                    raise _migration_error(
                        409,
                        "stale_project_classroom_migration_preview",
                        "可用學生身分已變更，請重新預覽",
                    )
                existing_child_by_student_id[student.id] = child
            else:
                snapshot_name = normalize_student_name(student.name)
                normalized_name = normalize_child_name(snapshot_name)
                if not normalized_name:
                    raise _migration_error(
                        422,
                        "invalid_student_snapshot_name",
                        "舊相本學生姓名無法建立名冊身分",
                        student_id=student.id,
                    )
                create_name_by_student_id[student.id] = normalized_name

        existing_ids = [
            child.id for child in existing_child_by_student_id.values()
        ]
        duplicate_existing_ids = sorted(
            child_id
            for child_id, count in Counter(existing_ids).items()
            if count > 1
        )
        if duplicate_existing_ids:
            raise _migration_error(
                422,
                "duplicate_resolved_roster_child",
                "同一相本內兩位學生不可解析成同一個名冊身分",
                roster_child_ids=duplicate_existing_ids,
            )

        # seed 的所有衝突先用既有 child 與待建立姓名完整驗證；新 child 尚未寫入。
        if seed_current_roster:
            if preview["target_classroom"]["active_roster_count"]:
                raise _migration_error(
                    409,
                    "target_classroom_roster_not_empty",
                    "只有目前名單為空的班級可由舊相本建立名單",
                )
            assert_project_student_capacity(0, len(students))
            seed_names = [
                (
                    existing_child_by_student_id[student.id].name
                    if student.id in existing_child_by_student_id
                    else create_name_by_student_id[student.id]
                )
                for student in students
            ]
            duplicate_names = sorted(
                name for name, count in Counter(
                    normalize_child_name(name) for name in seed_names
                ).items() if count > 1
            )
            if duplicate_names:
                raise _migration_error(
                    409,
                    "duplicate_seed_roster_name",
                    "目前名單不可包含同名學生",
                    names=duplicate_names,
                )
            existing_seed_children = list(
                existing_child_by_student_id.values()
            )
            _preflight_resolved_roster_seed(
                db,
                classroom_id,
                existing_seed_children,
            )

        resolved_child_by_student_id = dict(existing_child_by_student_id)
        for student in students:
            if student.id not in create_name_by_student_id:
                continue
            child = RosterChild(name=create_name_by_student_id[student.id])
            db.add(child)
            db.flush()
            resolved_child_by_student_id[student.id] = child

        resolved_ids = [
            resolved_child_by_student_id[student.id].id for student in students
        ]
        if len(resolved_ids) != len(set(resolved_ids)):
            raise _migration_error(
                422,
                "duplicate_resolved_roster_child",
                "同一相本內兩位學生不可解析成同一個名冊身分",
            )
        for student in students:
            student.roster_child_id = resolved_child_by_student_id[student.id].id
        db.flush()

        applied_at = utc_now()
        seeded_members: list[ClassRosterMember] = []
        seeded_member_by_student_id: dict[int, ClassRosterMember] = {}
        if seed_current_roster:
            seeded_members = [
                ClassRosterMember(
                    classroom_id=classroom.id,
                    roster_child_id=resolved_child_by_student_id[student.id].id,
                    started_at=applied_at,
                )
                for student in students
            ]
            db.add_all(seeded_members)
            db.flush()
            seeded_member_by_student_id = {
                student.id: member
                for student, member in zip(students, seeded_members, strict=True)
            }

        migration_id = db.execute(text(f"""
            INSERT INTO {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE} (
                project_id_snapshot, project_name_snapshot,
                project_department_snapshot,
                target_campus_id_snapshot, target_campus_name_snapshot,
                target_classroom_id_snapshot, target_classroom_name_snapshot,
                target_department_snapshot, source_fingerprint,
                student_count, seeded_member_count,
                applied_by_id_snapshot, applied_by_name_snapshot, applied_at
            ) VALUES (
                :project_id, :project_name, :project_department,
                :campus_id, :campus_name, :classroom_id, :classroom_name,
                :target_department, :source_fingerprint,
                :student_count, :seeded_member_count,
                :admin_id, :admin_name, :applied_at
            )
            RETURNING id
        """), {
            "project_id": project.id,
            "project_name": project.name,
            "project_department": project.department,
            "campus_id": classroom.campus_id,
            "campus_name": classroom.campus.name,
            "classroom_id": classroom.id,
            "classroom_name": classroom.name,
            "target_department": classroom.department,
            "source_fingerprint": source_fingerprint,
            "student_count": len(students),
            "seeded_member_count": len(seeded_members),
            "admin_id": admin.id,
            "admin_name": admin.display_name,
            "applied_at": applied_at,
        }).scalar_one()
        if students:
            db.execute(text(f"""
                INSERT INTO {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE} (
                    migration_id, project_id_snapshot,
                    student_id_snapshot, student_name_snapshot,
                    student_order_index_snapshot, student_created_at_snapshot,
                    original_roster_child_id_snapshot,
                    original_roster_child_name_snapshot,
                    resolution_action,
                    resolved_roster_child_id_snapshot,
                    resolved_roster_child_name_snapshot,
                    seeded_current_roster,
                    class_roster_member_id_snapshot,
                    source_fingerprint,
                    applied_by_id_snapshot, applied_by_name_snapshot, resolved_at
                ) VALUES (
                    :migration_id, :project_id,
                    :student_id, :student_name,
                    :student_order_index, :student_created_at,
                    :original_child_id, :original_child_name,
                    :resolution_action,
                    :resolved_child_id, :resolved_child_name,
                    :seeded_current_roster,
                    :membership_id,
                    :source_fingerprint,
                    :admin_id, :admin_name, :resolved_at
                )
            """), [
                {
                    "migration_id": migration_id,
                    "project_id": project.id,
                    "student_id": student.id,
                    "student_name": student.name,
                    "student_order_index": student.order_index,
                    "student_created_at": student.created_at,
                    "original_child_id": original_identity_rows[student.id][
                        "roster_child_id"
                    ],
                    "original_child_name": original_identity_rows[student.id][
                        "roster_child_name"
                    ],
                    "resolution_action": decisions_by_student_id[student.id][
                        "action"
                    ],
                    "resolved_child_id": resolved_child_by_student_id[student.id].id,
                    "resolved_child_name": resolved_child_by_student_id[student.id].name,
                    "seeded_current_roster": seed_current_roster,
                    "membership_id": (
                        seeded_member_by_student_id[student.id].id
                        if seed_current_roster
                        else None
                    ),
                    "source_fingerprint": source_fingerprint,
                    "admin_id": admin.id,
                    "admin_name": admin.display_name,
                    "resolved_at": applied_at,
                }
                for student in students
            ])

        work_slot = _ensure_legacy_project_work_slot(db, project, classroom)
        # Transition trigger 會驗證上方完整 ledger 與目前 Student resolved id。
        project.classroom_id = classroom.id
        project.department = classroom.department
        project.campus_id_snapshot = classroom.campus_id
        project.campus_name_snapshot = classroom.campus.name
        project.classroom_name_snapshot = classroom.name
        project.class_period_work_slot_id = work_slot.id
        db.flush()
        _sync_current_term_student_snapshots(db, set(resolved_ids))
        db.commit()
        db.refresh(project)
        for member in seeded_members:
            db.refresh(member)
    return {
        "project": _serialize_project(project),
        "seeded_members": [_serialize_member(member) for member in seeded_members],
        "identity_resolutions": [
            {
                "student_id": student.id,
                "action": decisions_by_student_id[student.id]["action"],
                "original_roster_child_id": original_identity_rows[student.id][
                    "roster_child_id"
                ],
                "resolved_roster_child_id": resolved_child_by_student_id[student.id].id,
                "seeded_current_roster": seed_current_roster,
            }
            for student in students
        ],
        "migration_status": _organization_migration_status(db),
    }


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
                    selectinload(ClassPeriodWorkSlot.term_classroom).selectinload(
                        AcademicTermClassroom.academic_term
                    ),
                    selectinload(ClassPeriodWorkSlot.term_period).selectinload(
                        AcademicTermPeriod.template_period
                    ),
                )
                .filter(ClassPeriodWorkSlot.id == work_slot_id)
                .first()
            )
            if work_slot is None:
                raise HTTPException(status_code=404, detail="找不到班級期別工作格")
            term_classroom = work_slot.term_classroom
            term_period = work_slot.term_period
            if term_classroom.classroom_id != classroom_id:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "work_slot_classroom_mismatch",
                        "message": "工作格不屬於指定班級",
                    },
                )
            if term_classroom.academic_term.status not in {"imported", "active"}:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "work_slot_term_not_current",
                        "message": "只能在目前正式學期建立相本",
                    },
                )
            if term_period.template_period_id != template.period_id:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "work_slot_period_mismatch",
                        "message": "工作格期別與模板期別不一致",
                    },
                )
            if term_period.department != term_classroom.department:
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
            if not classroom.is_active or not classroom.campus.is_active:
                raise HTTPException(
                    status_code=409,
                    detail="只能為使用中的分校與班級建立相本",
                )
            active_assignments = (
                db.query(ClassroomTeacherAssignment)
                .options(selectinload(ClassroomTeacherAssignment.teacher))
                .filter(
                    ClassroomTeacherAssignment.classroom_id == classroom_id,
                    ClassroomTeacherAssignment.ended_at.is_(None),
                )
                .order_by(ClassroomTeacherAssignment.id)
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
                or template.period.department != term_classroom.department
            ):
                raise HTTPException(
                    status_code=400,
                    detail="只能使用同部門且使用中的期別模板建立相本",
                )
            active_members = (
                db.query(ClassRosterMember)
                .options(selectinload(ClassRosterMember.roster_child))
                .filter(
                    ClassRosterMember.classroom_id == classroom_id,
                    ClassRosterMember.ended_at.is_(None),
                )
                .order_by(ClassRosterMember.started_at, ClassRosterMember.id)
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
            album_names = assign_automatic_album_names(student_names, [])
            project = build_project_record(
                db,
                template,
                creator,
                owner,
                name=project_name,
                department=term_classroom.department,
                template_period_id=template.period.id,
                classroom_id=classroom_id,
                class_period_work_slot_id=work_slot.id,
                campus_id_snapshot=term_classroom.campus_id_snapshot,
                campus_name_snapshot=term_classroom.campus_name_snapshot,
                classroom_name_snapshot=term_classroom.classroom_name_snapshot,
            )
            work_slot.started_at = utc_now()
            db.flush()
            for order_index, (member, album_name) in enumerate(
                zip(active_members, album_names, strict=True)
            ):
                db.add(Student(
                    project_id=project.id,
                    name=member.roster_child.name,
                    album_name=album_name,
                    order_index=order_index,
                    pages_data_json="[]",
                    roster_child_id=member.roster_child_id,
                ))
            db.flush()
            _sync_current_term_student_snapshots(
                db,
                {int(member.roster_child_id) for member in active_members},
            )
            db.commit()
            db.refresh(project)
            return _serialize_project(project)
