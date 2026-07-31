"""模板期別建立與更新 use cases。"""

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from crud.template_crud import ensure_period_name_unique, get_period_or_404
from database import (
    Semester,
    SemesterPeriod,
    ClassPeriodWorkSlot,
    TemplatePeriod,
)
from services.organization_transaction import organization_write_transaction


def _select_period_target_term(
    db: Session,
    semester_id: int | None,
) -> Semester | None:
    if semester_id is not None:
        target_term = db.get(Semester, semester_id)
        if target_term is None:
            raise HTTPException(status_code=404, detail="找不到正式學期")
        if target_term.status not in {"draft", "imported", "active"}:
            raise HTTPException(status_code=409, detail="此學期已不可加入期別")
        return target_term

    draft_terms = (
        db.query(Semester)
        .filter(Semester.status == "draft")
        .order_by(Semester.id)
        .all()
    )
    if len(draft_terms) > 1:
        raise HTTPException(status_code=409, detail="存在多個草稿學期，請指定學期")
    if draft_terms:
        return draft_terms[0]
    return (
        db.query(Semester)
        .filter(Semester.status.in_(("imported", "active")))
        .order_by(Semester.id.desc())
        .first()
    )


def _ensure_current_semester_period_slots(
    db: Session,
    semester_period: SemesterPeriod,
) -> None:
    if (
        semester_period.semester.status not in {"imported", "active"}
        or semester_period.template_period.status != "active"
    ):
        return
    for classroom in semester_period.semester.classrooms:
        if classroom.department != semester_period.department:
            continue
        existing_slot = db.query(ClassPeriodWorkSlot.id).filter(
            ClassPeriodWorkSlot.classroom_id == classroom.id,
            ClassPeriodWorkSlot.semester_period_id == semester_period.id,
        ).first()
        if existing_slot is None:
            db.add(ClassPeriodWorkSlot(
                classroom_id=classroom.id,
                semester_period_id=semester_period.id,
            ))


def _attach_period_to_semester(
    db: Session,
    period: TemplatePeriod,
    semester_id: int | None,
) -> None:
    existing_semester_period = db.query(SemesterPeriod).filter(
        SemesterPeriod.template_period_id == period.id
    ).first()
    if existing_semester_period is not None:
        if (
            semester_id is not None
            and existing_semester_period.semester_id != semester_id
        ):
            raise HTTPException(status_code=409, detail="期別已屬於其他正式學期")
        _ensure_current_semester_period_slots(db, existing_semester_period)
        return

    target_term = _select_period_target_term(db, semester_id)
    if target_term is None:
        return
    next_position = (
        db.query(func.coalesce(func.max(SemesterPeriod.position), -1) + 1)
        .filter(SemesterPeriod.semester_id == target_term.id)
        .scalar()
    )
    semester_period = SemesterPeriod(
        semester_id=target_term.id,
        template_period_id=period.id,
        period_name_snapshot=period.name,
        department=period.department,
        position=next_position,
    )
    db.add(semester_period)
    db.flush()
    _ensure_current_semester_period_slots(db, semester_period)


def create_template_period(
    db: Session,
    *,
    name: str,
    department: str,
    status: str,
    semester_id: int | None = None,
) -> TemplatePeriod:
    with organization_write_transaction(db):
        ensure_period_name_unique(department, name, db)
        period = TemplatePeriod(department=department, name=name, status=status)
        db.add(period)
        db.flush()
        _attach_period_to_semester(db, period, semester_id)
        db.commit()
        db.refresh(period)
        return period


def update_template_period(
    db: Session,
    period_id: int,
    *,
    name: str | None,
    status: str | None,
    semester_id: int | None = None,
) -> TemplatePeriod:
    with organization_write_transaction(db):
        period = get_period_or_404(period_id, db)
        if name is not None:
            period.name = name
        if status is not None:
            period.status = status
        _attach_period_to_semester(db, period, semester_id)
        db.commit()
        db.refresh(period)
        return period
