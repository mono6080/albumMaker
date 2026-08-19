"""園所校／部門主管 scope 的共用查詢規則。"""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Query, Session, joinedload
from sqlalchemy.sql.elements import ColumnElement

from database import (
    CURRENT_SEMESTER_STATUSES,
    Semester,
    Campus,
    Classroom,
    ClassroomMember,
    ClassroomTeacher,
    OrganizationSupervisorAssignment,
    Project,
    SemesterPeriod,
    User,
)


REPORTING_SEMESTER_STATUSES = ("imported", "active", "closed")


# carryover 判準的唯一真相來源：SQL 與 Python 兩種形式都由這兩組常數展開，
# 不得各寫一份字面值。見 docs/specs/period-album-creation-lock-v1.md
TEACHER_CARRYOVER_END_REASONS = ("term_reassignment",)
ROSTER_CARRYOVER_END_REASONS = ("term_reassignment", "term_departed")


def teacher_carryover_condition() -> ColumnElement[bool]:
    """目前在編制，或編制只因為學期輪替而結束。

    學期輪替會把舊班的全部編制一次結束，所以已結束學期的「目前編制」永遠是空的。
    認的是結束原因而不是「曾經任教」：`term_reassignment` 是學期輪替帶來的，
    `assignment_replaced` 是有人刻意把她換掉，後者不算。

    製作權（`get_project_permissions`）、進度負責人轉交（`transfer_project_owner`）
    與已結束學期的補建相本共用這一條，不得各寫一份。
    """
    return or_(
        ClassroomTeacher.ended_at.is_(None),
        ClassroomTeacher.end_reason.in_(TEACHER_CARRYOVER_END_REASONS),
    )


def roster_carryover_condition() -> ColumnElement[bool]:
    """該學期結束時仍在這個班的孩子。

    與老師同一個道理：學期輪替會結束全部名冊區間，所以要認結束原因。
    `term_reassignment`（升到下學期別班）與 `term_departed`（學期末離園）都是整期在籍；
    期中 `transfer` 出去與期中 `departed` 的孩子在該學期的歸屬已經不是這個班，不算。
    """
    return or_(
        ClassroomMember.ended_at.is_(None),
        ClassroomMember.end_reason.in_(ROSTER_CARRYOVER_END_REASONS),
    )


def teacher_assignment_is_carryover(assignment: ClassroomTeacher) -> bool:
    """`teacher_carryover_condition` 的 Python 形式，供已載入的關聯過濾。"""
    return (
        assignment.ended_at is None
        or assignment.end_reason in TEACHER_CARRYOVER_END_REASONS
    )


def roster_member_is_carryover(member: ClassroomMember) -> bool:
    """`roster_carryover_condition` 的 Python 形式，供已載入的關聯過濾。"""
    return (
        member.ended_at is None
        or member.end_reason in ROSTER_CARRYOVER_END_REASONS
    )


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
    # 目前正式學期仍在編制的班級：製作權的唯一來源
    teacher_classroom_ids: tuple[int, ...] = ()
    # 曾經或現在被指派的所有學期班級：讀取權。不進 classroom_ids，
    # 「我的班級」與建立相本仍只看目前學期
    teacher_readable_classroom_ids: tuple[int, ...] = ()
    # 目前編制，加上「只因為學期輪替而結束」的編制：讓老師做完自己開始、
    # 但跨過學期界線還沒完成的相本。被管理員移出班級（assignment_replaced）不算。
    teacher_carryover_classroom_ids: tuple[int, ...] = ()
    supervisor_classroom_ids: tuple[int, ...] = ()
    has_supervisor_assignment: bool = False
    supervisor_scope_keys: tuple[SupervisorScopeKey, ...] = ()

    @property
    def is_admin(self) -> bool:
        return self.viewer_role == "admin"


def _current_term_classroom_query(db: Session) -> Query:
    """目前正式學期、且分校仍啟用的班級。

    班級是學期範圍的實體，「目前」由學期狀態決定，沒有班級自己的啟用旗標。
    """
    return (
        db.query(Classroom.id)
        .join(Campus, Campus.id == Classroom.campus_id)
        .join(
            Semester,
            Semester.id == Classroom.semester_id,
        )
        .filter(
            Semester.status.in_(CURRENT_SEMESTER_STATUSES),
            Campus.is_active.is_(True),
        )
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
    rows = _current_term_classroom_query(db).filter(or_(*conditions)).all()
    return tuple(sorted(row[0] for row in rows))


def _load_teacher_classroom_ids(db: Session, teacher_id: int) -> tuple[int, ...]:
    """目前正式學期仍在編制的班級：製作權的唯一來源。"""
    rows = (
        _current_term_classroom_query(db)
        .join(
            ClassroomTeacher,
            ClassroomTeacher.classroom_id
            == Classroom.id,
        )
        .filter(
            ClassroomTeacher.teacher_id == teacher_id,
            ClassroomTeacher.ended_at.is_(None),
        )
        .distinct()
        .all()
    )
    return tuple(sorted(row[0] for row in rows))


def _load_teacher_readable_classroom_ids(
    db: Session,
    teacher_id: int,
) -> tuple[int, ...]:
    """曾經或現在被指派的所有學期班級：老師調班後仍讀得到自己做過的相本。

    不篩學期狀態也不篩 `ended_at`——班級是學期範圍的實體，「我帶過的那一班」
    天然只包含老師在場的那個學期，不會誤放上一屆。能不能改仍由目前編制決定。
    """
    rows = (
        db.query(ClassroomTeacher.classroom_id)
        .filter(ClassroomTeacher.teacher_id == teacher_id)
        .distinct()
        .all()
    )
    return tuple(sorted(row[0] for row in rows))


def _load_teacher_carryover_classroom_ids(
    db: Session,
    teacher_id: int,
) -> tuple[int, ...]:
    """目前在編制、或編制只因為學期輪替而結束的班級。

    學期在日曆上結束時相本通常還沒做完——2026-08 首次切換學期時，114 下有 40 本仍在
    製作、當天還有人在編。製作權若只看目前學期的編制，那些相本會在套用編班的瞬間
    對老師變成唯讀。

    但「被移出班級」必須仍然擋得住，所以認的是結束原因而不是「曾經任教」，
    判準見 `teacher_carryover_condition`。
    """
    rows = (
        db.query(ClassroomTeacher.classroom_id)
        .filter(
            ClassroomTeacher.teacher_id == teacher_id,
            teacher_carryover_condition(),
        )
        .distinct()
        .all()
    )
    return tuple(sorted(row[0] for row in rows))


def project_in_teacher_carryover_scope(
    project: Project,
    scope: OrganizationReadScope,
) -> bool:
    """相本所屬班級是否在「目前編制或僅因學期輪替而結束」的範圍內。"""
    return (
        project.classroom_id is not None
        and project.classroom_id in scope.teacher_carryover_classroom_ids
    )


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
            sorted(row[0] for row in _current_term_classroom_query(db).all())
        )
        return OrganizationReadScope(
            viewer_role="admin",
            classroom_ids=classroom_ids,
            has_supervisor_assignment=True,
        )
    if current_user.role in {"teacher", "supervisor"}:
        teacher_classroom_ids = _load_teacher_classroom_ids(db, current_user.id)
        teacher_readable_classroom_ids = _load_teacher_readable_classroom_ids(
            db, current_user.id
        )
        teacher_carryover_classroom_ids = _load_teacher_carryover_classroom_ids(
            db, current_user.id
        )
        supervisor_scope_keys = _load_supervisor_scope_keys(db, current_user.id)
        supervisor_classroom_ids = _load_supervisor_classroom_ids(
            db, supervisor_scope_keys
        )
        has_supervisor_assignment = bool(supervisor_scope_keys)
        classroom_ids = tuple(sorted(
            set(teacher_classroom_ids) | set(supervisor_classroom_ids)
        ))
        # 一律具名：這個 dataclass 的欄位中間插過新項目，位置參數會靜靜地錯位
        return OrganizationReadScope(
            viewer_role=current_user.role,
            classroom_ids=classroom_ids,
            teacher_classroom_ids=teacher_classroom_ids,
            teacher_readable_classroom_ids=teacher_readable_classroom_ids,
            teacher_carryover_classroom_ids=teacher_carryover_classroom_ids,
            supervisor_classroom_ids=supervisor_classroom_ids,
            has_supervisor_assignment=has_supervisor_assignment,
            supervisor_scope_keys=supervisor_scope_keys,
        )
    return OrganizationReadScope(viewer_role=current_user.role, classroom_ids=())


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
        viewer_role=current_user.role,
        classroom_ids=supervisor_classroom_ids,
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
        Project.classroom_id.in_(scope.teacher_readable_classroom_ids)
        if scope.teacher_readable_classroom_ids
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
        Classroom.campus_id,
        Classroom.department,
        scope,
    ))


def serialize_reporting_term(term: Semester) -> dict:
    """學期彙整與老師進度共用的學期 payload；兩份報表的欄位必須一致。"""
    return {
        "id": term.id,
        "label": term.label,
        "status": term.status,
        "is_current": term.status in CURRENT_SEMESTER_STATUSES,
        "starts_on": term.starts_on.isoformat() if term.starts_on else None,
        "ends_on": term.ends_on.isoformat() if term.ends_on else None,
    }


def serialize_reporting_period(semester_period: SemesterPeriod) -> dict:
    """報表用期別 payload。

    這裡的 `id` 是 `template_period_id`（報表以模板期別為欄位主體），
    與園所設定的期別 payload 用 `SemesterPeriod.id` 當 `id` 不同，不可互相取代。
    """
    return {
        "id": semester_period.template_period_id,
        "semester_period_id": semester_period.id,
        "template_period_id": semester_period.template_period_id,
        "name": semester_period.period_name_snapshot,
        "department": semester_period.department,
        "position": semester_period.position,
    }


def load_reporting_semester_or_404(
    db: Session,
    semester_id: int,
    scope: OrganizationReadScope | None = None,
) -> Semester:
    """載入正式報表學期，並避免主管以 direct ID 枚舉 scope 外 metadata。"""
    term = db.query(Semester).filter(
        Semester.id == semester_id,
        Semester.status.in_(REPORTING_SEMESTER_STATUSES),
    ).first()
    if term is None:
        raise HTTPException(status_code=404, detail="找不到學期")
    if scope is not None and not scope.is_admin:
        scoped_term_classroom = apply_term_classroom_report_scope(
            db.query(Classroom.id).filter(
                Classroom.semester_id == semester_id,
            ),
            scope,
        ).first()
        if scoped_term_classroom is None:
            raise HTTPException(status_code=404, detail="找不到學期")
    return term


def load_current_scope_teacher_assignments(
    db: Session,
    scope: OrganizationReadScope,
) -> list[ClassroomTeacher]:
    """載入 scope 內有效班級的目前老師編制，供進度與班級視圖共用。"""
    if not scope.classroom_ids:
        return []
    return (
        db.query(ClassroomTeacher)
        .options(
            joinedload(ClassroomTeacher.teacher),
            joinedload(ClassroomTeacher.classroom).joinedload(
                Classroom.campus
            ),
        )
        .filter(
            ClassroomTeacher.classroom_id.in_(scope.classroom_ids),
            ClassroomTeacher.teacher_id.isnot(None),
            ClassroomTeacher.ended_at.is_(None),
        )
        .order_by(
            ClassroomTeacher.classroom_id,
            ClassroomTeacher.duty,
            ClassroomTeacher.id,
        )
        .all()
    )


def project_in_read_scope(project: Project, scope: OrganizationReadScope) -> bool:
    """單筆 object policy 使用的同一套 scope 判斷。"""
    if scope.is_admin:
        return True
    return (
        project_in_readable_teacher_scope(project, scope)
        or project_in_supervisor_scope(project, scope)
    )


def project_in_teacher_scope(project: Project, scope: OrganizationReadScope) -> bool:
    """判斷專案是否屬於使用者目前任教班級（製作權的唯一來源）。"""
    return (
        project.classroom_id is not None
        and project.classroom_id in scope.teacher_classroom_ids
    )


def project_in_readable_teacher_scope(
    project: Project,
    scope: OrganizationReadScope,
) -> bool:
    """判斷專案是否屬於使用者曾經或現在任教的班級：讀得到，製作權另判。"""
    return (
        project.classroom_id is not None
        and project.classroom_id in scope.teacher_readable_classroom_ids
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
