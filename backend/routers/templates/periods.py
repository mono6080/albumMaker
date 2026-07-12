# 模板期別路由
# 部門清單與期別的查詢/建立/更新，
# 路由層僅負責 HTTP 接收與回應，單筆查詢與重名檢查委派給 crud 層

from fastapi import APIRouter, Depends, Form, HTTPException, Query
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import ensure_period_name_unique, get_period_or_404
from database import TemplatePeriod, User, get_db
from template_periods import TEMPLATE_DEPARTMENTS

from ._helpers import _serialize_period, _validate_department, _validate_period_status

router = APIRouter()


@router.get("/departments")
def list_template_departments(
    _: User = Depends(get_current_user),
):
    """回傳固定部門清單，供期別與專案建立流程使用。"""
    return list(TEMPLATE_DEPARTMENTS)


@router.get("/periods")
def list_template_periods(
    department: str | None = Query(None),
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳模板期別清單。"""
    query = db.query(TemplatePeriod)
    if department:
        query = query.filter(TemplatePeriod.department == _validate_department(department))
    if status:
        query = query.filter(TemplatePeriod.status == _validate_period_status(status))
    periods = (
        query
        .order_by(TemplatePeriod.department.asc(), TemplatePeriod.created_at.desc(), TemplatePeriod.id.desc())
        .all()
    )
    return [_serialize_period(period) for period in periods]


@router.post("/periods")
def create_template_period(
    name: str = Form(...),
    department: str = Form(...),
    status: str = Form("draft"),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """建立新模板期別。"""
    period_name = name.strip()
    if not period_name:
        raise HTTPException(status_code=400, detail="期別名稱不可空白")
    period_department = _validate_department(department)
    period_status = _validate_period_status(status)
    ensure_period_name_unique(period_department, period_name, db)

    period = TemplatePeriod(
        department=period_department,
        name=period_name,
        status=period_status,
    )
    db.add(period)
    db.commit()
    db.refresh(period)
    return _serialize_period(period)


@router.patch("/periods/{period_id}")
def update_template_period(
    period_id: int,
    name: str | None = Form(None),
    status: str | None = Form(None),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """更新期別名稱或狀態；狀態屬於期別，不屬於單一模板。"""
    period = get_period_or_404(period_id, db)
    if name is not None:
        period_name = name.strip()
        if not period_name:
            raise HTTPException(status_code=400, detail="期別名稱不可空白")
        period.name = period_name
    if status is not None:
        period.status = _validate_period_status(status)
    db.commit()
    db.refresh(period)
    return _serialize_period(period)
