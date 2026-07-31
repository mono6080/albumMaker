"""新學期整園編班草稿、驗證與原子套用 use cases。"""

import hashlib
import json
from collections import Counter, defaultdict
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from crud.organization_crud import get_term_reclassification_plan_or_404
from database import (
    CURRENT_SEMESTER_STATUSES,
    Semester,
    SemesterPeriod,
    Campus,
    ClassPeriodWorkSlot,
    Classroom,
    ClassroomTeacher,
    ClassroomMember,
    TermClassroomPlan,
    TermClassroomTeacherTarget,
    TermReclassificationPlan,
    TermStudentPlacement,
    TemplatePeriod,
    User,
    utc_now,
)
from services.organization_transaction import organization_write_transaction
from services.roster_identity_service import normalize_child_name
from services.student_input_policy import PROJECT_STUDENT_MAX_COUNT


TERM_PLAN_LABEL_MAX_LENGTH = 100


def _coded_error(status_code: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, **details},
    )


def _normalize_label(raw_label: str) -> str:
    label = raw_label.strip()
    if not label:
        raise _coded_error(422, "invalid_target_state", "新學期名稱不可空白")
    if len(label) > TERM_PLAN_LABEL_MAX_LENGTH:
        raise _coded_error(
            422,
            "invalid_target_state",
            f"新學期名稱不可超過 {TERM_PLAN_LABEL_MAX_LENGTH} 個字",
        )
    return label


def _normalize_term_dates(
    starts_on: date | None,
    ends_on: date | None,
) -> tuple[date | None, date | None]:
    if starts_on is not None and ends_on is not None and starts_on > ends_on:
        raise _coded_error(
            422,
            "invalid_semester_dates",
            "學期開始日不可晚於結束日",
        )
    return starts_on, ends_on


def _load_ordered_semester_periods(
    db: Session,
    period_ids: list[int],
) -> list[TemplatePeriod]:
    if len(period_ids) != len(set(period_ids)):
        raise _coded_error(
            422,
            "duplicate_semester_period",
            "同一學期期別不可重複",
        )
    if not period_ids:
        return []
    periods = db.query(TemplatePeriod).filter(TemplatePeriod.id.in_(period_ids)).all()
    period_by_id = {period.id: period for period in periods}
    if set(period_by_id) != set(period_ids):
        raise _coded_error(
            422,
            "semester_period_not_found",
            "指定的學期期別不存在",
        )
    assigned_period_ids = {
        row[0]
        for row in db.query(SemesterPeriod.template_period_id)
        .filter(SemesterPeriod.template_period_id.in_(period_ids))
        .all()
    }
    if assigned_period_ids:
        raise _coded_error(
            409,
            "semester_period_already_assigned",
            "指定期別已屬於其他正式學期",
            period_ids=sorted(assigned_period_ids),
        )
    invalid_period_ids = [
        period.id for period in periods if period.status not in {"draft", "active"}
    ]
    if invalid_period_ids:
        raise _coded_error(
            422,
            "invalid_semester_period_status",
            "學期只能納入草稿或使用中的期別",
            period_ids=sorted(invalid_period_ids),
        )
    return [period_by_id[period_id] for period_id in period_ids]


def _serialize_semester(term: Semester) -> dict:
    return {
        "id": term.id,
        "label": term.label,
        "status": term.status,
        "is_current": term.status in {"imported", "active"},
        "migration_key": term.migration_key,
        "starts_on": term.starts_on,
        "ends_on": term.ends_on,
        "created_at": term.created_at,
        "activated_at": term.activated_at,
        "closed_at": term.closed_at,
        "cancelled_at": term.cancelled_at,
        "periods": [
            {
                "id": semester_period.id,
                "template_period_id": semester_period.template_period_id,
                "name": semester_period.period_name_snapshot,
                "department": semester_period.department,
                "position": semester_period.position,
            }
            for semester_period in term.periods
        ],
    }


def list_semesters(db: Session) -> list[dict]:
    terms = (
        db.query(Semester)
        .options(joinedload(Semester.periods))
        .order_by(Semester.created_at.desc(), Semester.id.desc())
        .all()
    )
    return [_serialize_semester(term) for term in terms]


def _validate_target_semester(
    plan: TermReclassificationPlan,
) -> Semester:
    target_term = plan.target_semester
    if target_term is None:
        raise _coded_error(
            409,
            "semester_missing",
            "編班草稿尚未連結正式學期",
        )
    if target_term.status != "draft":
        raise _coded_error(
            409,
            "semester_not_draft",
            "目標學期已不是草稿",
        )
    if not target_term.periods:
        raise _coded_error(
            422,
            "semester_period_required",
            "正式學期至少需要一個期別",
        )
    invalid_period_ids = [
        semester_period.template_period_id
        for semester_period in target_term.periods
        if semester_period.template_period is None
        or semester_period.template_period.status != "active"
    ]
    if invalid_period_ids:
        raise _coded_error(
            422,
            "semester_period_not_active",
            "套用新學期前，所有期別都必須設為使用中",
            period_ids=sorted(invalid_period_ids),
        )
    return target_term


def _semester_validation_errors(
    plan: TermReclassificationPlan,
) -> list[dict]:
    target_term = plan.target_semester
    if target_term is None:
        return [{
            "code": "semester_missing",
            "message": "編班草稿尚未連結正式學期",
        }]
    errors: list[dict] = []
    if target_term.status != "draft":
        errors.append({
            "code": "semester_not_draft",
            "message": "目標學期已不是草稿",
        })
    if (
        target_term.starts_on is not None
        and target_term.ends_on is not None
        and target_term.starts_on > target_term.ends_on
    ):
        errors.append({
            "code": "invalid_semester_dates",
            "message": "學期開始日不可晚於結束日",
        })
    if not target_term.periods:
        errors.append({
            "code": "semester_period_required",
            "message": "正式學期至少需要一個期別",
        })
        return errors
    invalid_period_ids = [
        semester_period.template_period_id
        for semester_period in target_term.periods
        if semester_period.template_period is None
        or semester_period.template_period.status != "active"
    ]
    if invalid_period_ids:
        errors.append({
            "code": "semester_period_not_active",
            "message": "套用新學期前，所有期別都必須設為使用中",
            "period_ids": sorted(invalid_period_ids),
        })
    return errors


def _canonical_datetime(value: datetime | None) -> str | None:
    return value.isoformat(timespec="microseconds") if value is not None else None


def compute_organization_source_fingerprint(db: Session) -> str:
    campuses = (
        db.query(Campus)
        .filter(Campus.is_active.is_(True))
        .order_by(Campus.id)
        .all()
    )
    classrooms = (
        db.query(Classroom)
        .join(Campus, Campus.id == Classroom.campus_id)
        .filter(Classroom.semester_id.in_(select(Semester.id).where(Semester.status.in_(CURRENT_SEMESTER_STATUSES))), Campus.is_active.is_(True))
        .order_by(Classroom.id)
        .all()
    )
    # 名冊與編制同樣限定在目前學期。少了這個條件目前也不會出錯——已結束學期的班
    # 拒絕加人——但那是靠別處的檢查撐著，fingerprint 的定義應該自己說得清楚。
    current_semester_classrooms = select(Classroom.id).where(
        Classroom.semester_id.in_(
            select(Semester.id).where(Semester.status.in_(CURRENT_SEMESTER_STATUSES))
        )
    )
    memberships = (
        db.query(ClassroomMember)
        .options(joinedload(ClassroomMember.roster_child))
        .filter(
            ClassroomMember.ended_at.is_(None),
            ClassroomMember.classroom_id.in_(current_semester_classrooms),
        )
        .order_by(ClassroomMember.id)
        .all()
    )
    teacher_assignments = (
        db.query(ClassroomTeacher)
        .filter(
            ClassroomTeacher.ended_at.is_(None),
            ClassroomTeacher.classroom_id.in_(current_semester_classrooms),
        )
        .order_by(ClassroomTeacher.id)
        .all()
    )
    source_state = {
        "campuses": [[campus.id, campus.name] for campus in campuses],
        "classrooms": [
            [classroom.id, classroom.campus_id, classroom.department, classroom.name]
            for classroom in classrooms
        ],
        "memberships": [
            [
                membership.id,
                membership.roster_child_id,
                normalize_child_name(membership.roster_child.name),
                membership.classroom_id,
                _canonical_datetime(membership.started_at),
            ]
            for membership in memberships
        ],
        "teacher_assignments": [
            [
                assignment.id,
                assignment.classroom_id,
                assignment.teacher_id,
                assignment.duty,
                _canonical_datetime(assignment.started_at),
            ]
            for assignment in teacher_assignments
        ],
    }
    canonical_json = json.dumps(
        source_state,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def _assert_draft(plan: TermReclassificationPlan) -> None:
    if plan.status != "draft":
        raise _coded_error(409, "term_plan_not_draft", "只有草稿可修改")


def _assert_revision(plan: TermReclassificationPlan, expected_revision: int) -> None:
    if plan.revision != expected_revision:
        raise _coded_error(
            409,
            "term_plan_revision_conflict",
            "編班草稿已被其他操作更新，請重新載入",
            current_revision=plan.revision,
        )


def _assert_source_unchanged(plan: TermReclassificationPlan, db: Session) -> None:
    if compute_organization_source_fingerprint(db) != plan.source_fingerprint:
        raise _coded_error(
            409,
            "stale_reclassification_plan",
            "目前名單或老師編制已變更，請重建編班草稿",
        )


def _assert_active_rows_belong_to_active_structure(db: Session) -> None:
    inactive_member_classroom_ids = {
        row[0]
        for row in (
            db.query(ClassroomMember.classroom_id)
            .join(Classroom, Classroom.id == ClassroomMember.classroom_id)
            .join(Campus, Campus.id == Classroom.campus_id)
            .filter(
                ClassroomMember.ended_at.is_(None),
                or_(
                    Classroom.semester_id.notin_(select(Semester.id).where(Semester.status.in_(CURRENT_SEMESTER_STATUSES))),
                    Campus.is_active.is_(False),
                ),
            )
            .distinct()
            .all()
        )
    }
    inactive_teacher_classroom_ids = {
        row[0]
        for row in (
            db.query(ClassroomTeacher.classroom_id)
            .join(
                Classroom,
                Classroom.id == ClassroomTeacher.classroom_id,
            )
            .join(Campus, Campus.id == Classroom.campus_id)
            .filter(
                ClassroomTeacher.ended_at.is_(None),
                or_(
                    Classroom.semester_id.notin_(select(Semester.id).where(Semester.status.in_(CURRENT_SEMESTER_STATUSES))),
                    Campus.is_active.is_(False),
                ),
            )
            .distinct()
            .all()
        )
    }
    invalid_classroom_ids = sorted(
        inactive_member_classroom_ids | inactive_teacher_classroom_ids
    )
    if invalid_classroom_ids:
        raise _coded_error(
            409,
            "inactive_organization_has_active_roster_or_teachers",
            "停用的分校或班級仍有目前學生／老師，請先修復園所資料",
            classroom_ids=invalid_classroom_ids,
        )


def _serialize_student_placement(placement: TermStudentPlacement) -> dict:
    return {
        "source_member_id": placement.source_membership_id,
        "roster_child_id": placement.roster_child_id_snapshot,
        "student_name": placement.student_name_snapshot,
        "source_campus_id": placement.source_campus_id_snapshot,
        "source_campus_name": placement.source_campus_name_snapshot,
        "source_classroom_id": placement.source_classroom_id_snapshot,
        "source_classroom_name": placement.source_classroom_name_snapshot,
        "outcome": placement.outcome,
        "target_classroom_id": placement.target_classroom_id,
    }


def _serialize_teacher_target(target: TermClassroomTeacherTarget) -> dict:
    return {
        "teacher_id": target.teacher_id,
        "teacher_name": target.teacher_name_snapshot,
        "duty": target.duty,
    }


def _source_classroom_id_by_target(
    plan: TermReclassificationPlan,
    db: Session,
) -> dict[int, int]:
    """目標學期的班對應回目前學期的哪一個班。

    目標班在建立草稿時照來源班的分校／部門／班名複製出來，班級 id 不再跨學期
    延續，所以「同一個班的新學期版本」只能靠這組 scope 認得；scope 在學期內唯一，
    對應是精確的。找不到對應的是草稿裡新增的班。

    比對的來源是**建立草稿當下的那個學期**，不是「目前學期」——套用之後目前學期
    就是目標學期本身，用目前學期會讓每個班對應到自己，已套用計畫的 diff 因此變樣。
    """
    target_classroom_ids = {
        classroom_plan.classroom_id for classroom_plan in plan.classroom_plans
    }
    target_classroom_ids.update(
        placement.target_classroom_id
        for placement in plan.student_placements
        if placement.target_classroom_id is not None
    )
    if not target_classroom_ids:
        return {}
    source_classroom_ids = {
        placement.source_classroom_id_snapshot
        for placement in plan.student_placements
    }
    source_term_id = (
        db.query(Classroom.semester_id)
        .filter(Classroom.id.in_(source_classroom_ids))
        .limit(1)
        .scalar()
        if source_classroom_ids
        else None
    )
    if source_term_id is None:
        # 名冊全空的計畫沒有來源班可推，退回目前學期（此時目標學期還是草稿）
        source_term_id = (
            db.query(Semester.id)
            .filter(
                Semester.status.in_(CURRENT_SEMESTER_STATUSES),
                Semester.id != plan.target_semester_id,
            )
            .limit(1)
            .scalar()
        )
    if source_term_id is None:
        return {}
    source_id_by_scope = {
        (classroom.campus_id, classroom.department, classroom.name): classroom.id
        for classroom in (
            db.query(Classroom)
            .filter(Classroom.semester_id == source_term_id)
            .all()
        )
    }
    source_by_target = {}
    for classroom in db.query(Classroom).filter(
        Classroom.id.in_(target_classroom_ids)
    ):
        source_id = source_id_by_scope.get(
            (classroom.campus_id, classroom.department, classroom.name)
        )
        if source_id is not None:
            source_by_target[classroom.id] = source_id
    return source_by_target


def _student_diff(plan: TermReclassificationPlan, db: Session) -> dict:
    source_by_target = _source_classroom_id_by_target(plan, db)
    result = {"stay": [], "move": [], "departed": []}
    for placement in plan.student_placements:
        row = {
            "source_member_id": placement.source_membership_id,
            "student_name": placement.student_name_snapshot,
            "from_classroom_id": placement.source_classroom_id_snapshot,
            "to_classroom_id": placement.target_classroom_id,
        }
        target_source_id = source_by_target.get(placement.target_classroom_id)
        if placement.outcome == "departed":
            result["departed"].append(row)
        elif target_source_id == placement.source_classroom_id_snapshot:
            result["stay"].append(row)
        else:
            result["move"].append(row)
    before_counts = Counter(
        placement.source_classroom_id_snapshot
        for placement in plan.student_placements
    )
    after_counts = Counter(
        placement.target_classroom_id
        for placement in plan.student_placements
        if placement.outcome == "classroom"
    )
    result["classroom_counts"] = []
    for classroom_plan in plan.classroom_plans:
        before = before_counts[source_by_target.get(classroom_plan.classroom_id)]
        after = after_counts[classroom_plan.classroom_id]
        result["classroom_counts"].append({
            "classroom_id": classroom_plan.classroom_id,
            "before": before,
            "after": after,
            "change": after - before,
        })
    return result


def _teacher_source_state(plan: TermReclassificationPlan, db: Session) -> dict[int, dict]:
    """目標班的「目前編制」——查的是它在目前學期對應的那個班。"""
    classroom_ids = [classroom_plan.classroom_id for classroom_plan in plan.classroom_plans]
    if not classroom_ids:
        return {}
    source_by_target = _source_classroom_id_by_target(plan, db)
    source_ids = sorted(set(source_by_target.values()))
    assignments = (
        db.query(ClassroomTeacher)
        .filter(
            ClassroomTeacher.classroom_id.in_(source_ids),
            ClassroomTeacher.started_at <= plan.created_at,
            or_(
                ClassroomTeacher.ended_at.is_(None),
                ClassroomTeacher.ended_at > plan.created_at,
            ),
        )
        .order_by(ClassroomTeacher.id)
        .all()
        if source_ids
        else []
    )
    assignments_by_source: dict[int, dict] = defaultdict(dict)
    for assignment in assignments:
        assignments_by_source[assignment.classroom_id][assignment.teacher_id] = (
            assignment
        )
    return {
        classroom_id: assignments_by_source.get(
            source_by_target.get(classroom_id), {}
        )
        for classroom_id in classroom_ids
    }


def _teacher_diff(plan: TermReclassificationPlan, db: Session) -> dict:
    source_state = _teacher_source_state(plan, db)
    result = {"add": [], "remove": [], "duty_change": []}
    for classroom_plan in plan.classroom_plans:
        current = source_state.get(classroom_plan.classroom_id, {})
        target = {
            teacher_target.teacher_id: teacher_target
            for teacher_target in classroom_plan.teacher_targets
        }
        for teacher_id, target_row in target.items():
            current_row = current.get(teacher_id)
            if current_row is None:
                result["add"].append({
                    "classroom_id": classroom_plan.classroom_id,
                    **_serialize_teacher_target(target_row),
                })
            elif current_row.duty != target_row.duty:
                result["duty_change"].append({
                    "classroom_id": classroom_plan.classroom_id,
                    "teacher_id": teacher_id,
                    "teacher_name": target_row.teacher_name_snapshot,
                    "from_duty": current_row.duty,
                    "to_duty": target_row.duty,
                })
        for teacher_id, current_row in current.items():
            if teacher_id not in target:
                result["remove"].append({
                    "classroom_id": classroom_plan.classroom_id,
                    "teacher_id": teacher_id,
                    "teacher_name": current_row.teacher_name_snapshot,
                    "duty": current_row.duty,
                })
    return result


def _validate_target_state(plan: TermReclassificationPlan, db: Session) -> list[dict]:
    errors: list[dict] = []
    target_classroom_ids = {
        placement.target_classroom_id
        for placement in plan.student_placements
        if placement.target_classroom_id is not None
    }
    target_classroom_ids.update(
        classroom_plan.classroom_id for classroom_plan in plan.classroom_plans
    )
    classrooms = (
        db.query(Classroom)
        .options(joinedload(Classroom.campus))
        .filter(Classroom.id.in_(target_classroom_ids))
        .all()
        if target_classroom_ids
        else []
    )
    classroom_by_id = {classroom.id: classroom for classroom in classrooms}

    def _is_usable_target(classroom: Classroom) -> bool:
        """目標班必須屬於這份計畫的目標學期，且分校仍在使用中。

        不能用 `is_current` 判斷——目標學期還是 draft，套用時才轉 active。
        """
        return (
            classroom.semester_id == plan.target_semester_id
            and classroom.campus.is_active
        )

    target_students: dict[int, list[TermStudentPlacement]] = defaultdict(list)
    for placement in plan.student_placements:
        if placement.outcome == "departed":
            continue
        classroom = classroom_by_id.get(placement.target_classroom_id)
        if classroom is None:
            errors.append({
                "code": "target_classroom_not_found",
                "source_member_id": placement.source_membership_id,
                "target_classroom_id": placement.target_classroom_id,
            })
            continue
        if not _is_usable_target(classroom):
            errors.append({
                "code": "inactive_target_classroom",
                "source_member_id": placement.source_membership_id,
                "target_classroom_id": placement.target_classroom_id,
            })
        target_students[classroom.id].append(placement)

    for classroom_id, placements in target_students.items():
        if len(placements) > PROJECT_STUDENT_MAX_COUNT:
            errors.append({
                "code": "classroom_student_limit_exceeded",
                "classroom_id": classroom_id,
                "student_count": len(placements),
                "max_students": PROJECT_STUDENT_MAX_COUNT,
            })
        names_to_members: dict[str, list[int]] = defaultdict(list)
        for placement in placements:
            names_to_members[normalize_child_name(placement.student_name_snapshot)].append(
                placement.source_membership_id
            )
        for student_name, source_member_ids in names_to_members.items():
            if len(source_member_ids) > 1:
                errors.append({
                    "code": "duplicate_target_student_name",
                    "classroom_id": classroom_id,
                    "student_name": student_name,
                    "source_member_ids": source_member_ids,
                })

    teacher_ids = {
        target.teacher_id
        for classroom_plan in plan.classroom_plans
        for target in classroom_plan.teacher_targets
        if target.teacher_id is not None
    }
    users = db.query(User).filter(User.id.in_(teacher_ids)).all() if teacher_ids else []
    user_by_id = {user.id: user for user in users}
    for classroom_plan in plan.classroom_plans:
        classroom = classroom_by_id.get(classroom_plan.classroom_id)
        if classroom is None:
            errors.append({
                "code": "target_classroom_not_found",
                "classroom_id": classroom_plan.classroom_id,
            })
        elif not _is_usable_target(classroom):
            errors.append({
                "code": "inactive_teacher_classroom",
                "classroom_id": classroom_plan.classroom_id,
            })
        lead_count = sum(
            target.duty == "lead" for target in classroom_plan.teacher_targets
        )
        if classroom_plan.teacher_targets and lead_count != 1:
            errors.append({
                "code": "invalid_lead_count",
                "classroom_id": classroom_plan.classroom_id,
                "lead_count": lead_count,
            })
        for target in classroom_plan.teacher_targets:
            teacher = user_by_id.get(target.teacher_id)
            if teacher is None:
                errors.append({
                    "code": "teacher_not_found",
                    "classroom_id": classroom_plan.classroom_id,
                    "teacher_id": target.teacher_id,
                })
            elif teacher.role not in {"teacher", "supervisor"}:
                errors.append({
                    "code": "invalid_teacher_role",
                    "classroom_id": classroom_plan.classroom_id,
                    "teacher_id": target.teacher_id,
                    "role": teacher.role,
                })
    return errors


def _serialize_plan(plan: TermReclassificationPlan, db: Session) -> dict:
    validation_errors = (
        [
            *_semester_validation_errors(plan),
            *_validate_target_state(plan, db),
        ]
        if plan.status == "draft"
        else []
    )
    if (
        plan.status == "draft"
        and compute_organization_source_fingerprint(db) != plan.source_fingerprint
    ):
        validation_errors.insert(0, {
            "code": "stale_reclassification_plan",
            "message": "目前名單或老師編制已變更，請重建編班草稿",
        })
    student_diff = _student_diff(plan, db)
    stay_member_ids = {row["source_member_id"] for row in student_diff["stay"]}
    # 來源班在目標學期的對應班：這是穩定事實，與使用者目前選了什麼無關。
    # 前端要靠它判斷「改回原班」，不能只看目前是不是 stay。
    target_by_source = {
        source_id: target_id
        for target_id, source_id in _source_classroom_id_by_target(plan, db).items()
    }
    return {
        "id": plan.id,
        "label": plan.label,
        "target_semester_id": plan.target_semester_id,
        "target_semester": (
            _serialize_semester(plan.target_semester)
            if plan.target_semester is not None
            else None
        ),
        "status": plan.status,
        "revision": plan.revision,
        "source_fingerprint": plan.source_fingerprint,
        "created_at": plan.created_at,
        "updated_at": plan.updated_at,
        "applied_at": plan.applied_at,
        "cancelled_at": plan.cancelled_at,
        "created_by_id": plan.created_by_id,
        "created_by_name": plan.created_by_name_snapshot,
        "updated_by_id": plan.updated_by_id,
        "updated_by_name": plan.updated_by_name_snapshot,
        "applied_by_id": plan.applied_by_id,
        "applied_by_name": plan.applied_by_name_snapshot,
        "cancelled_by_id": plan.cancelled_by_id,
        "cancelled_by_name": plan.cancelled_by_name_snapshot,
        "student_placements": [
            {
                **_serialize_student_placement(placement),
                # 來源班與目標班分屬不同學期，id 比不出「有沒有換班」
                "keeps_source_classroom": (
                    placement.source_membership_id in stay_member_ids
                ),
                "stay_classroom_id": target_by_source.get(
                    placement.source_classroom_id_snapshot
                ),
            }
            for placement in plan.student_placements
        ],
        # 計畫裡的班一律是目標學期新建的班，不在「目前園所」那份清單裡，
        # 所以連班名一起附上，前端不必回頭猜 id 屬於哪個學期
        "target_classrooms": [
            {
                "classroom_id": classroom.id,
                "campus_id": classroom.campus_id,
                "campus_name": classroom.campus.name,
                "name": classroom.name,
                "department": classroom.department,
            }
            for classroom in sorted(
                (
                    plan.target_semester.classrooms
                    if plan.target_semester is not None
                    else []
                ),
                key=lambda row: (row.campus_id, row.department, row.name, row.id),
            )
        ],
        "classroom_teacher_targets": [
            {
                "classroom_id": classroom_plan.classroom_id,
                "teachers": [
                    _serialize_teacher_target(target)
                    for target in classroom_plan.teacher_targets
                ],
            }
            for classroom_plan in plan.classroom_plans
        ],
        "diff": {
            "students": student_diff,
            "teachers": _teacher_diff(plan, db),
        },
        "validation": {
            "is_valid": not validation_errors,
            "errors": validation_errors,
        },
    }


def create_term_reclassification_plan(
    db: Session,
    current_admin: User,
    label: str,
    period_ids: list[int] | None = None,
    starts_on: date | None = None,
    ends_on: date | None = None,
) -> dict:
    plan_label = _normalize_label(label)
    term_starts_on, term_ends_on = _normalize_term_dates(starts_on, ends_on)
    requested_period_ids = period_ids or []
    with organization_write_transaction(db):
        existing_draft = db.query(TermReclassificationPlan.id).filter(
            TermReclassificationPlan.scope_key == "organization",
            TermReclassificationPlan.status == "draft",
        ).first()
        if existing_draft:
            raise _coded_error(
                409,
                "draft_exists",
                "目前已有一份新學期編班草稿",
                plan_id=existing_draft[0],
            )
        _assert_active_rows_belong_to_active_structure(db)
        ordered_periods = _load_ordered_semester_periods(db, requested_period_ids)
        target_term = Semester(
            label=plan_label,
            status="draft",
            starts_on=term_starts_on,
            ends_on=term_ends_on,
            created_by_id=current_admin.id,
            created_by_name_snapshot=current_admin.display_name,
        )
        for position, period in enumerate(ordered_periods):
            target_term.periods.append(SemesterPeriod(
                template_period_id=period.id,
                period_name_snapshot=period.name,
                department=period.department,
                position=position,
            ))
        db.add(target_term)
        db.flush()
        plan = TermReclassificationPlan(
            scope_key="organization",
            label=plan_label,
            target_semester_id=target_term.id,
            status="draft",
            revision=1,
            source_fingerprint=compute_organization_source_fingerprint(db),
            created_by_id=current_admin.id,
            created_by_name_snapshot=current_admin.display_name,
        )
        db.add(plan)
        db.flush()

        classrooms = (
            db.query(Classroom)
            .join(Campus, Campus.id == Classroom.campus_id)
            .join(Semester, Semester.id == Classroom.semester_id)
            .filter(
                Semester.status.in_(CURRENT_SEMESTER_STATUSES),
                Campus.is_active.is_(True),
            )
            .order_by(Classroom.id)
            .all()
        )
        classroom_ids = [classroom.id for classroom in classrooms]
        # 目標學期的班在建立草稿時就長出來（預設沿用目前的分校／部門／班名），
        # 之後可在草稿裡增刪改；計畫的目標一律指向這些新班。
        target_classroom_by_source_id = {}
        for classroom in classrooms:
            target_classroom = Classroom(
                semester_id=target_term.id,
                campus_id=classroom.campus_id,
                department=classroom.department,
                name=classroom.name,
            )
            db.add(target_classroom)
            target_classroom_by_source_id[classroom.id] = target_classroom
        db.flush()

        memberships = (
            db.query(ClassroomMember)
            .options(
                joinedload(ClassroomMember.roster_child),
                joinedload(ClassroomMember.classroom).joinedload(Classroom.campus),
            )
            .filter(
                ClassroomMember.ended_at.is_(None),
                ClassroomMember.classroom_id.in_(classroom_ids),
            )
            .order_by(ClassroomMember.id)
            .all()
        )
        for membership in memberships:
            target_classroom = target_classroom_by_source_id[membership.classroom_id]
            plan.student_placements.append(TermStudentPlacement(
                source_membership_id=membership.id,
                roster_child_id_snapshot=membership.roster_child_id,
                student_name_snapshot=membership.roster_child.name,
                source_campus_id_snapshot=membership.classroom.campus_id,
                source_campus_name_snapshot=membership.classroom.campus.name,
                source_classroom_id_snapshot=membership.classroom_id,
                source_classroom_name_snapshot=membership.classroom.name,
                outcome="classroom",
                target_classroom_id=target_classroom.id,
            ))
        assignments = (
            db.query(ClassroomTeacher)
            .filter(
                ClassroomTeacher.classroom_id.in_(classroom_ids),
                ClassroomTeacher.ended_at.is_(None),
            )
            .order_by(ClassroomTeacher.id)
            .all()
            if classroom_ids
            else []
        )
        assignments_by_classroom: dict[int, list[ClassroomTeacher]] = (
            defaultdict(list)
        )
        for assignment in assignments:
            assignments_by_classroom[assignment.classroom_id].append(assignment)
        for classroom in classrooms:
            classroom_plan = TermClassroomPlan(
                classroom_id=target_classroom_by_source_id[classroom.id].id,
            )
            for assignment in assignments_by_classroom[classroom.id]:
                classroom_plan.teacher_targets.append(TermClassroomTeacherTarget(
                    teacher_id=assignment.teacher_id,
                    teacher_name_snapshot=assignment.teacher_name_snapshot,
                    duty=assignment.duty,
                ))
            plan.classroom_plans.append(classroom_plan)
        db.commit()
        plan_id = plan.id
    return _serialize_plan(get_term_reclassification_plan_or_404(plan_id, db), db)


def get_term_reclassification_plan(db: Session, plan_id: int) -> dict:
    plan = get_term_reclassification_plan_or_404(plan_id, db)
    return _serialize_plan(plan, db)


def _validate_update_structure(
    plan: TermReclassificationPlan,
    changes: dict,
    db: Session,
) -> None:
    placements = changes["student_placements"]
    source_member_ids = [item["source_member_id"] for item in placements]
    expected_member_ids = {
        placement.source_membership_id for placement in plan.student_placements
    }
    if len(source_member_ids) != len(set(source_member_ids)):
        raise _coded_error(422, "invalid_target_state", "學生編班目標不可重複")
    if set(source_member_ids) != expected_member_ids:
        raise _coded_error(
            422,
            "invalid_target_state",
            "必須送出草稿內每一位學生的完整目標",
        )
    for item in placements:
        if item["outcome"] == "classroom" and item["target_classroom_id"] is None:
            raise _coded_error(422, "invalid_target_state", "留班或轉班必須指定班級")
        if item["outcome"] == "departed" and item["target_classroom_id"] is not None:
            raise _coded_error(422, "invalid_target_state", "離園不可指定目標班級")
    target_classroom_ids = {
        item["target_classroom_id"]
        for item in placements
        if item["target_classroom_id"] is not None
    }
    existing_classroom_ids = {
        row[0]
        for row in db.query(Classroom.id)
        .filter(Classroom.id.in_(target_classroom_ids))
        .all()
    }
    if existing_classroom_ids != target_classroom_ids:
        raise _coded_error(422, "invalid_target_state", "指定的目標班級不存在")

    classroom_targets = changes["classroom_teacher_targets"]
    classroom_ids = [item["classroom_id"] for item in classroom_targets]
    expected_classroom_ids = {
        classroom_plan.classroom_id for classroom_plan in plan.classroom_plans
    }
    if len(classroom_ids) != len(set(classroom_ids)):
        raise _coded_error(422, "invalid_target_state", "班級老師目標不可重複")
    if set(classroom_ids) != expected_classroom_ids:
        raise _coded_error(
            422,
            "invalid_target_state",
            "必須送出草稿內每個班級的完整老師集合",
        )
    for classroom_target in classroom_targets:
        teacher_ids = [teacher["teacher_id"] for teacher in classroom_target["teachers"]]
        if len(teacher_ids) != len(set(teacher_ids)):
            raise _coded_error(422, "invalid_target_state", "同班老師不可重複")


def update_term_reclassification_plan(
    db: Session,
    current_admin: User,
    plan_id: int,
    changes: dict,
) -> dict:
    with organization_write_transaction(db):
        plan = get_term_reclassification_plan_or_404(plan_id, db)
        _assert_draft(plan)
        _assert_revision(plan, changes["expected_revision"])
        _validate_update_structure(plan, changes, db)

        placement_by_member_id = {
            placement.source_membership_id: placement
            for placement in plan.student_placements
        }
        for item in changes["student_placements"]:
            placement = placement_by_member_id[item["source_member_id"]]
            placement.outcome = item["outcome"]
            placement.target_classroom_id = item["target_classroom_id"]

        incoming_teacher_ids = {
            teacher["teacher_id"]
            for classroom_target in changes["classroom_teacher_targets"]
            for teacher in classroom_target["teachers"]
        }
        users = (
            db.query(User).filter(User.id.in_(incoming_teacher_ids)).all()
            if incoming_teacher_ids
            else []
        )
        user_by_id = {user.id: user for user in users}
        missing_teacher_ids = incoming_teacher_ids - set(user_by_id)
        if missing_teacher_ids:
            raise _coded_error(
                422,
                "invalid_target_state",
                "指定的老師帳號不存在",
                teacher_ids=sorted(missing_teacher_ids),
            )

        classroom_plan_by_id = {
            classroom_plan.classroom_id: classroom_plan
            for classroom_plan in plan.classroom_plans
        }
        for classroom_target in changes["classroom_teacher_targets"]:
            classroom_plan = classroom_plan_by_id[classroom_target["classroom_id"]]
            for old_target in list(classroom_plan.teacher_targets):
                db.delete(old_target)
        db.flush()
        for classroom_target in changes["classroom_teacher_targets"]:
            classroom_plan = classroom_plan_by_id[classroom_target["classroom_id"]]
            for teacher in classroom_target["teachers"]:
                user = user_by_id[teacher["teacher_id"]]
                db.add(TermClassroomTeacherTarget(
                    classroom_plan_id=classroom_plan.id,
                    teacher_id=user.id,
                    teacher_name_snapshot=user.display_name,
                    duty=teacher["duty"],
                ))
        plan.revision += 1
        plan.updated_at = utc_now()
        plan.updated_by_id = current_admin.id
        plan.updated_by_name_snapshot = current_admin.display_name
        db.commit()
    return _serialize_plan(get_term_reclassification_plan_or_404(plan_id, db), db)


def validate_term_reclassification_plan(db: Session, plan_id: int) -> dict:
    with organization_write_transaction(db):
        plan = get_term_reclassification_plan_or_404(plan_id, db)
        _assert_draft(plan)
        _assert_source_unchanged(plan, db)
        response = _serialize_plan(plan, db)
        db.rollback()
        return response


def _raise_invalid_target_state(errors: list[dict]) -> None:
    raise _coded_error(
        422,
        "invalid_target_state",
        "編班目標仍有錯誤，無法套用",
        errors=errors,
    )


def _create_target_term_work_slots(
    db: Session,
    plan: TermReclassificationPlan,
    target_term: Semester,
) -> None:
    """替目標學期的每個班補上與其部門相符的期別工作格。"""
    if any(classroom.work_slots for classroom in target_term.classrooms):
        raise _coded_error(
            409,
            "semester_grid_already_created",
            "目標學期工作格已建立",
        )
    for classroom_plan in plan.classroom_plans:
        classroom = db.get(Classroom, classroom_plan.classroom_id)
        for semester_period in target_term.periods:
            if semester_period.department != classroom.department:
                continue
            db.add(ClassPeriodWorkSlot(
                classroom_id=classroom.id,
                semester_period_id=semester_period.id,
            ))
    db.flush()


def apply_term_reclassification_plan(
    db: Session,
    current_admin: User,
    plan_id: int,
    expected_revision: int,
) -> dict:
    with organization_write_transaction(db):
        plan = get_term_reclassification_plan_or_404(plan_id, db)
        if plan.status == "applied":
            db.rollback()
            return _serialize_plan(plan, db)
        if plan.status == "cancelled":
            raise _coded_error(409, "term_plan_cancelled", "已取消的編班草稿不可套用")
        _assert_revision(plan, expected_revision)
        _assert_source_unchanged(plan, db)
        target_term = _validate_target_semester(plan)
        validation_errors = _validate_target_state(plan, db)
        if validation_errors:
            _raise_invalid_target_state(validation_errors)

        applied_at = utc_now()
        placements = list(plan.student_placements)
        source_member_ids = [placement.source_membership_id for placement in placements]
        source_members = (
            db.query(ClassroomMember)
            .filter(
                ClassroomMember.id.in_(source_member_ids),
                ClassroomMember.ended_at.is_(None),
            )
            .all()
        )
        source_member_by_id = {member.id: member for member in source_members}
        if len(source_member_by_id) != len(source_member_ids):
            raise _coded_error(
                409,
                "stale_reclassification_plan",
                "目前名單已變更，請重建編班草稿",
            )

        # 老師編制要結束的是「即將關閉的學期的所有班」，不能只取有學生的班：
        # 空班的老師會留在已結束的學期裡，下一次編班就會被
        # inactive_organization_has_active_roster_or_teachers 擋住。
        closing_classroom_ids = [
            classroom_id
            for (classroom_id,) in db.query(Classroom.id)
            .join(Semester, Semester.id == Classroom.semester_id)
            .filter(
                Semester.status.in_(CURRENT_SEMESTER_STATUSES),
                Semester.id != target_term.id,
            )
            .all()
        ]
        current_assignments = (
            db.query(ClassroomTeacher)
            .filter(
                ClassroomTeacher.classroom_id.in_(closing_classroom_ids),
                ClassroomTeacher.ended_at.is_(None),
            )
            .all()
            if closing_classroom_ids
            else []
        )

        # 舊學期的班隨學期一起結束，所以全部成員與編制一律結束，
        # 不再有「留在原班就不動」的分支——原班在新學期是另一筆班級。
        for placement in placements:
            member = source_member_by_id[placement.source_membership_id]
            member.ended_at = applied_at
            member.end_reason = (
                "term_departed"
                if placement.outcome == "departed"
                else "term_reassignment"
            )
        for assignment in current_assignments:
            assignment.ended_at = applied_at
            assignment.end_reason = "term_reassignment"
            assignment.ended_by_id = current_admin.id
            assignment.ended_by_name_snapshot = current_admin.display_name
        db.flush()

        for placement in placements:
            if placement.outcome != "classroom":
                continue
            member = source_member_by_id[placement.source_membership_id]
            db.add(ClassroomMember(
                classroom_id=placement.target_classroom_id,
                roster_child_id=member.roster_child_id,
                started_at=applied_at,
            ))
        for classroom_plan in plan.classroom_plans:
            for target in classroom_plan.teacher_targets:
                db.add(ClassroomTeacher(
                    classroom_id=classroom_plan.classroom_id,
                    teacher_id=target.teacher_id,
                    teacher_name_snapshot=target.teacher_name_snapshot,
                    duty=target.duty,
                    started_at=applied_at,
                    started_by_id=current_admin.id,
                    started_by_name_snapshot=current_admin.display_name,
                ))
        db.flush()

        _create_target_term_work_slots(db, plan, target_term)
        current_terms = db.query(Semester).filter(
            Semester.id != target_term.id,
            Semester.status.in_(("imported", "active")),
        ).all()
        for current_term in current_terms:
            current_term.status = "closed"
            current_term.closed_at = applied_at
            current_term.closed_by_id = current_admin.id
            current_term.closed_by_name_snapshot = current_admin.display_name
        db.flush()

        target_term.status = "active"
        target_term.activated_at = applied_at
        target_term.activated_by_id = current_admin.id
        target_term.activated_by_name_snapshot = current_admin.display_name

        plan.status = "applied"
        plan.applied_at = applied_at
        plan.applied_by_id = current_admin.id
        plan.applied_by_name_snapshot = current_admin.display_name
        plan.updated_at = applied_at
        db.commit()
    return _serialize_plan(get_term_reclassification_plan_or_404(plan_id, db), db)


def cancel_term_reclassification_plan(
    db: Session,
    current_admin: User,
    plan_id: int,
) -> dict:
    with organization_write_transaction(db):
        plan = get_term_reclassification_plan_or_404(plan_id, db)
        if plan.status == "cancelled":
            db.rollback()
            return _serialize_plan(plan, db)
        if plan.status == "applied":
            raise _coded_error(409, "term_plan_applied", "已套用的編班計畫不可取消")
        cancelled_at = utc_now()
        target_term = plan.target_semester
        if target_term is not None and target_term.status == "draft":
            target_term.status = "cancelled"
            target_term.cancelled_at = cancelled_at
            target_term.cancelled_by_id = current_admin.id
            target_term.cancelled_by_name_snapshot = current_admin.display_name
        plan.status = "cancelled"
        plan.cancelled_at = cancelled_at
        plan.cancelled_by_id = current_admin.id
        plan.cancelled_by_name_snapshot = current_admin.display_name
        plan.updated_at = cancelled_at
        db.commit()
    return _serialize_plan(get_term_reclassification_plan_or_404(plan_id, db), db)
