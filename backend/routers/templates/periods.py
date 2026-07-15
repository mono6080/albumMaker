# 模板期別路由
# 部門清單與期別的查詢/建立/更新，
# 路由層僅負責 HTTP 接收與回應，單筆查詢與重名檢查委派給 crud 層

from fastapi import APIRouter, Depends, Form, HTTPException, Query
from sqlalchemy.orm import Session, selectinload

from auth import get_current_user, require_role
from database import TemplatePeriod, User, get_db
from services.template_period_service import (
    create_template_period as create_template_period_use_case,
    update_template_period as update_template_period_use_case,
)
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
    query = db.query(TemplatePeriod).options(selectinload(TemplatePeriod.templates))
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
    period = create_template_period_use_case(
        db,
        name=period_name,
        department=period_department,
        status=period_status,
    )
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
    period_name = None
    if name is not None:
        period_name = name.strip()
        if not period_name:
            raise HTTPException(status_code=400, detail="期別名稱不可空白")
    period_status = _validate_period_status(status) if status is not None else None
    period = update_template_period_use_case(
        db,
        period_id,
        name=period_name,
        status=period_status,
    )
    return _serialize_period(period)
