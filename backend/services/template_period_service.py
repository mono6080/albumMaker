"""模板期別建立與更新 use cases。"""

from sqlalchemy.orm import Session

from crud.template_crud import ensure_period_name_unique, get_period_or_404
from database import TemplatePeriod


def create_template_period(
    db: Session,
    *,
    name: str,
    department: str,
    status: str,
) -> TemplatePeriod:
    ensure_period_name_unique(department, name, db)
    period = TemplatePeriod(department=department, name=name, status=status)
    db.add(period)
    db.commit()
    db.refresh(period)
    return period


def update_template_period(
    db: Session,
    period_id: int,
    *,
    name: str | None,
    status: str | None,
) -> TemplatePeriod:
    period = get_period_or_404(period_id, db)
    if name is not None:
        period.name = name
    if status is not None:
        period.status = status
    db.commit()
    db.refresh(period)
    return period
