"""園所校／部門主管 scope 的共用查詢規則。"""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Query, Session, joinedload
from sqlalchemy.sql.elements import ColumnElement

from database import (
    AcademicTerm,
    AcademicTermClassroom,
    Campus,
    Classroom,
    ClassroomTeacherAssignment,
    OrganizationSupervisorAssignment,
    Project,
    User,
)


REPORTING_TERM_STATUSES = ("imported", "active", "closed")


@dataclass(frozen=True)
class SupervisorScopeKey:
    """目前有效主管指派的不可變校別／部門鍵。"""

    campus_id: int
    department: str | None


@dataclass(frozen=True)
class OrganizationReadScope:
    """已展開的園所讀取範圍。"""

    viewer_role: str
    classroom_ids: tuple[int, ...]
    teacher_classroom_ids: tuple[int, ...] = ()
    supervisor_classroom_ids: tuple[int, ...] = ()
    has_supervisor_assignment: bool = False
    supervisor_scope_keys: tuple[SupervisorScopeKey, ...] = ()

    @property
    def is_admin(self) -> bool:
        return self.viewer_role == "admin"


def _active_classroom_query(db: Session) -> Query:
    return (
        db.query(Classroom.id)
        .join(Campus, Campus.id == Classroom.campus_id)
        .filter(Classroom.is_active.is_(True), Campus.is_active.is_(True))
    )


def _load_supervisor_scope_keys(
    db: Session,
    supervisor_id: int,
) -> tuple[SupervisorScopeKey, ...]:
    rows = (
        db.query(
            OrganizationSupervisorAssignment.campus_id,
            OrganizationSupervisorAssignment.department,
        )
        .filter(
            OrganizationSupervisorAssignment.supervisor_id == supervisor_id,
            OrganizationSupervisorAssignment.ended_at.is_(None),
        )
        .all()
    )
    scope_keys = {
        SupervisorScopeKey(campus_id, department)
        for campus_id, department in rows
    }
    return tuple(sorted(
        scope_keys,
        key=lambda scope_key: (
            scope_key.campus_id,
            scope_key.department or "",
        ),
    ))


def _load_supervisor_classroom_ids(
    db: Session,
    scope_keys: tuple[SupervisorScopeKey, ...],
) -> tuple[int, ...]:
    """只展開目前有效班級；歷史 Project 另以 snapshot key 判斷。"""
    full_campus_ids = {
        scope_key.campus_id
        for scope_key in scope_keys
        if scope_key.department is None
    }
    department_campuses: dict[str, set[int]] = {}
    for scope_key in scope_keys:
        if (
            scope_key.department is not None
            and scope_key.campus_id not in full_campus_ids
        ):
            department_campuses.setdefault(scope_key.department, set()).add(
                scope_key.campus_id
            )

    conditions: list[ColumnElement[bool]] = []
    if full_campus_ids:
        conditions.append(Classroom.campus_id.in_(full_campus_ids))
    conditions.extend(
        and_(
            Classroom.campus_id.in_(campus_ids),
            Classroom.department == department,
        )
        for department, campus_ids in department_campuses.items()
    )
    if not conditions:
        return ()
    rows = _active_classroom_query(db).filter(or_(*conditions)).all()
    return tuple(sorted(row[0] for row in rows))


def _load_teacher_classroom_ids(db: Session, teacher_id: int) -> tuple[int, ...]:
    rows = (
        _active_classroom_query(db)
        .join(
            ClassroomTeacherAssignment,
            ClassroomTeacherAssignment.classroom_id == Classroom.id,
        )
        .filter(
            ClassroomTeacherAssignment.teacher_id == teacher_id,
            ClassroomTeacherAssignment.ended_at.is_(None),
        )
        .distinct()
        .all()
    )
    return tuple(sorted(row[0] for row in rows))


def has_active_organization_supervisor_assignment(
    db: Session,
    user_id: int,
) -> bool:
    """回傳帳號是否具有至少一筆有效主管指派。"""
    return db.query(OrganizationSupervisorAssignment.id).filter(
        OrganizationSupervisorAssignment.supervisor_id == user_id,
        OrganizationSupervisorAssignment.ended_at.is_(None),
    ).first() is not None


def build_organization_read_scope(
    db: Session,
    current_user: User,
) -> OrganizationReadScope:
    """把目前有效的任教與主管設定展開成班級集合。"""
    if current_user.role == "admin":
        classroom_ids = tuple(
            sorted(row[0] for row in _active_classroom_query(db).all())
        )
        return OrganizationReadScope(
            "admin",
            classroom_ids,
            has_supervisor_assignment=True,
        )
    if current_user.role in {"teacher", "supervisor"}:
        teacher_classroom_ids = _load_teacher_classroom_ids(db, current_user.id)
        supervisor_scope_keys = _load_supervisor_scope_keys(db, current_user.id)
        supervisor_classroom_ids = _load_supervisor_classroom_ids(
            db, supervisor_scope_keys
        )
        has_supervisor_assignment = bool(supervisor_scope_keys)
        classroom_ids = tuple(sorted(
            set(teacher_classroom_ids) | set(supervisor_classroom_ids)
        ))
        return OrganizationReadScope(
            current_user.role,
            classroom_ids,
            teacher_classroom_ids,
            supervisor_classroom_ids,
            has_supervisor_assignment,
            supervisor_scope_keys,
        )
    return OrganizationReadScope(current_user.role, ())


def build_organization_supervisor_scope(
    db: Session,
    current_user: User,
) -> OrganizationReadScope:
    """只展開主管指派範圍；供主管報表端點授權。"""
    if current_user.role == "admin":
        return build_organization_read_scope(db, current_user)
    if current_user.role not in {"teacher", "supervisor"}:
        raise HTTPException(status_code=403, detail="無園所主管檢視權限")
    supervisor_scope_keys = _load_supervisor_scope_keys(db, current_user.id)
    if not supervisor_scope_keys:
        raise HTTPException(status_code=403, detail="無園所主管檢視權限")
    supervisor_classroom_ids = _load_supervisor_classroom_ids(
        db,
        supervisor_scope_keys,
    )
    return OrganizationReadScope(
        current_user.role,
        supervisor_classroom_ids,
        supervisor_classroom_ids=supervisor_classroom_ids,
        has_supervisor_assignment=True,
        supervisor_scope_keys=supervisor_scope_keys,
    )


def _snapshot_scope_condition(
    campus_id_column,
    department_column,
    scope: OrganizationReadScope,
) -> ColumnElement[bool]:
    conditions = [
        (
            campus_id_column == scope_key.campus_id
            if scope_key.department is None
            else and_(
                campus_id_column == scope_key.campus_id,
                department_column == scope_key.department,
            )
        )
        for scope_key in scope.supervisor_scope_keys
    ]
    return or_(*conditions) if conditions else false()


def apply_project_read_scope(query: Query, scope: OrganizationReadScope) -> Query:
    """套用 Project object policy：老師看目前班級，主管看歷史快照 scope。"""
    if scope.is_admin:
        return query
    teacher_condition = (
        Project.classroom_id.in_(scope.teacher_classroom_ids)
        if scope.teacher_classroom_ids
        else false()
    )
    supervisor_condition = and_(
        Project.classroom_id.isnot(None),
        _snapshot_scope_condition(
            Project.campus_id_snapshot,
            Project.department,
            scope,
        ),
    )
    return query.filter(or_(teacher_condition, supervisor_condition))


def apply_term_classroom_report_scope(
    query: Query,
    scope: OrganizationReadScope,
) -> Query:
    """主管報表依學期班級快照篩選；停用／搬移班級不改寫歷史。"""
    if scope.is_admin:
        return query
    return query.filter(_snapshot_scope_condition(
        AcademicTermClassroom.campus_id_snapshot,
        AcademicTermClassroom.department,
        scope,
    ))


def load_reporting_term_or_404(
    db: Session,
    academic_term_id: int,
    scope: OrganizationReadScope | None = None,
) -> AcademicTerm:
    """載入正式報表學期，並避免主管以 direct ID 枚舉 scope 外 metadata。"""
    term = db.query(AcademicTerm).filter(
        AcademicTerm.id == academic_term_id,
        AcademicTerm.status.in_(REPORTING_TERM_STATUSES),
    ).first()
    if term is None:
        raise HTTPException(status_code=404, detail="找不到學期")
    if scope is not None and not scope.is_admin:
        scoped_term_classroom = apply_term_classroom_report_scope(
            db.query(AcademicTermClassroom.id).filter(
                AcademicTermClassroom.academic_term_id == academic_term_id,
            ),
            scope,
        ).first()
        if scoped_term_classroom is None:
            raise HTTPException(status_code=404, detail="找不到學期")
    return term


def load_current_scope_teacher_assignments(
    db: Session,
    scope: OrganizationReadScope,
) -> list[ClassroomTeacherAssignment]:
    """載入 scope 內有效班級的目前老師編制，供進度與班級視圖共用。"""
    if not scope.classroom_ids:
        return []
    return (
        db.query(ClassroomTeacherAssignment)
        .options(
            joinedload(ClassroomTeacherAssignment.teacher),
            joinedload(ClassroomTeacherAssignment.classroom).joinedload(
                Classroom.campus
            ),
        )
        .filter(
            ClassroomTeacherAssignment.classroom_id.in_(scope.classroom_ids),
            ClassroomTeacherAssignment.teacher_id.isnot(None),
            ClassroomTeacherAssignment.ended_at.is_(None),
        )
        .order_by(
            ClassroomTeacherAssignment.classroom_id,
            ClassroomTeacherAssignment.duty,
            ClassroomTeacherAssignment.id,
        )
        .all()
    )


def project_in_read_scope(project: Project, scope: OrganizationReadScope) -> bool:
    """單筆 object policy 使用的同一套 scope 判斷。"""
    if scope.is_admin:
        return True
    return project_in_teacher_scope(project, scope) or project_in_supervisor_scope(
        project,
        scope,
    )


def project_in_teacher_scope(project: Project, scope: OrganizationReadScope) -> bool:
    """判斷專案是否屬於使用者目前任教班級。"""
    return (
        project.classroom_id is not None
        and project.classroom_id in scope.teacher_classroom_ids
    )


def project_in_supervisor_scope(project: Project, scope: OrganizationReadScope) -> bool:
    """目前主管依 Project 建立當下的校別／部門快照讀歷史相本。"""
    if project.classroom_id is None or project.campus_id_snapshot is None:
        return False
    return any(
        scope_key.campus_id == project.campus_id_snapshot
        and (
            scope_key.department is None
            or scope_key.department == project.department
        )
        for scope_key in scope.supervisor_scope_keys
    )
