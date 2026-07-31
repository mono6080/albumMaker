"""模板期別建立與更新 use cases。"""

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from crud.template_crud import ensure_period_name_unique, get_period_or_404
from database import (
    AcademicTerm,
    AcademicTermPeriod,
    ClassPeriodWorkSlot,
    TemplatePeriod,
)
from services.organization_transaction import organization_write_transaction


def _select_period_target_term(
    db: Session,
    academic_term_id: int | None,
) -> AcademicTerm | None:
    if academic_term_id is not None:
        target_term = db.get(AcademicTerm, academic_term_id)
        if target_term is None:
            raise HTTPException(status_code=404, detail="找不到正式學期")
        if target_term.status not in {"draft", "imported", "active"}:
            raise HTTPException(status_code=409, detail="此學期已不可加入期別")
        return target_term

    draft_terms = (
        db.query(AcademicTerm)
        .filter(AcademicTerm.status == "draft")
        .order_by(AcademicTerm.id)
        .all()
    )
    if len(draft_terms) > 1:
        raise HTTPException(status_code=409, detail="存在多個草稿學期，請指定學期")
    if draft_terms:
        return draft_terms[0]
    return (
        db.query(AcademicTerm)
        .filter(AcademicTerm.status.in_(("imported", "active")))
        .order_by(AcademicTerm.id.desc())
        .first()
    )


def _ensure_current_term_period_slots(
    db: Session,
    term_period: AcademicTermPeriod,
) -> None:
    if (
        term_period.academic_term.status not in {"imported", "active"}
        or term_period.template_period.status != "active"
    ):
        return
    for classroom in term_period.academic_term.classrooms:
        if classroom.department != term_period.department:
            continue
        existing_slot = db.query(ClassPeriodWorkSlot.id).filter(
            ClassPeriodWorkSlot.classroom_id == classroom.id,
            ClassPeriodWorkSlot.term_period_id == term_period.id,
        ).first()
        if existing_slot is None:
            db.add(ClassPeriodWorkSlot(
                classroom_id=classroom.id,
                term_period_id=term_period.id,
            ))


def _attach_period_to_academic_term(
    db: Session,
    period: TemplatePeriod,
    academic_term_id: int | None,
) -> None:
    existing_term_period = db.query(AcademicTermPeriod).filter(
        AcademicTermPeriod.template_period_id == period.id
    ).first()
    if existing_term_period is not None:
        if (
            academic_term_id is not None
            and existing_term_period.academic_term_id != academic_term_id
        ):
            raise HTTPException(status_code=409, detail="期別已屬於其他正式學期")
        _ensure_current_term_period_slots(db, existing_term_period)
        return

    target_term = _select_period_target_term(db, academic_term_id)
    if target_term is None:
        return
    next_position = (
        db.query(func.coalesce(func.max(AcademicTermPeriod.position), -1) + 1)
        .filter(AcademicTermPeriod.academic_term_id == target_term.id)
        .scalar()
    )
    term_period = AcademicTermPeriod(
        academic_term_id=target_term.id,
        template_period_id=period.id,
        period_name_snapshot=period.name,
        department=period.department,
        position=next_position,
    )
    db.add(term_period)
    db.flush()
    _ensure_current_term_period_slots(db, term_period)


def create_template_period(
    db: Session,
    *,
    name: str,
    department: str,
    status: str,
    academic_term_id: int | None = None,
) -> TemplatePeriod:
    with organization_write_transaction(db):
        ensure_period_name_unique(department, name, db)
        period = TemplatePeriod(department=department, name=name, status=status)
        db.add(period)
        db.flush()
        _attach_period_to_academic_term(db, period, academic_term_id)
        db.commit()
        db.refresh(period)
        return period


def update_template_period(
    db: Session,
    period_id: int,
    *,
    name: str | None,
    status: str | None,
    academic_term_id: int | None = None,
) -> TemplatePeriod:
    with organization_write_transaction(db):
        period = get_period_or_404(period_id, db)
        if name is not None:
            period.name = name
        if status is not None:
            period.status = status
        _attach_period_to_academic_term(db, period, academic_term_id)
        db.commit()
        db.refresh(period)
        return period
