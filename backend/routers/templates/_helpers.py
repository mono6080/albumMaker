# 模板路由共用 helper
# 序列化（期別/模板摘要）、部門與期別狀態驗證、渲染用 layout 組裝，
# 供 periods / crud / render 各子模組共用

import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.template_crud import get_period_or_404
from database import Template, TemplatePage, TemplatePeriod
from services.layout_group_traversal import iter_layout_render_elements
from template_periods import (
    DEFAULT_TEMPLATE_PERIOD_DEPARTMENT,
    DEFAULT_TEMPLATE_PERIOD_NAME,
    VALID_PERIOD_STATUSES,
    VALID_TEMPLATE_DEPARTMENTS,
    department_label,
    period_status_label,
)


def _count_template_photo_slots(template: Template) -> int:
    total = 0
    for page in template.pages:
        layout = json.loads(page.layout_json)
        total += sum(
            element_type == "photo"
            for element_type, _, _ in iter_layout_render_elements(layout)
        )
    return total


def _serialize_period(period: TemplatePeriod) -> dict:
    return {
        "id": period.id,
        "department": period.department,
        "department_label": department_label(period.department),
        "name": period.name,
        "status": period.status,
        "status_label": period_status_label(period.status),
        "created_at": period.created_at,
        "template_count": len(period.templates),
    }


def _serialize_template_summary(template: Template) -> dict:
    period = template.period
    return {
        "id": template.id,
        "name": template.name,
        "revision": template.revision,
        "created_at": template.created_at,
        "page_count": len(template.pages),
        "photo_count": _count_template_photo_slots(template),
        "period_id": period.id if period else None,
        "period_name": period.name if period else None,
        "period_status": period.status if period else None,
        "period_status_label": period_status_label(period.status) if period else None,
        "department": period.department if period else None,
        "department_label": department_label(period.department) if period else None,
    }


def _template_page_layout_with_background(template_page: TemplatePage) -> dict:
    """回傳渲染用 layout；背景圖以資料庫欄位為準，避免版面儲存覆蓋掉底圖。"""
    page_layout = json.loads(template_page.layout_json)
    if template_page.background_filename:
        page_layout["background_filename"] = template_page.background_filename
    return page_layout


def _validate_department(department: str) -> str:
    normalized = department.strip()
    if normalized not in VALID_TEMPLATE_DEPARTMENTS:
        raise HTTPException(status_code=400, detail="不支援的部門")
    return normalized


def _validate_period_status(status: str) -> str:
    normalized = status.strip()
    if normalized not in VALID_PERIOD_STATUSES:
        raise HTTPException(status_code=400, detail="不支援的期別狀態")
    return normalized


def _resolve_template_period(period_id: int | None, db: Session) -> TemplatePeriod:
    if period_id is not None:
        return get_period_or_404(period_id, db)

    default_period = (
        db.query(TemplatePeriod)
        .filter(
            TemplatePeriod.department == DEFAULT_TEMPLATE_PERIOD_DEPARTMENT,
            TemplatePeriod.name == DEFAULT_TEMPLATE_PERIOD_NAME,
        )
        .order_by(TemplatePeriod.id.asc())
        .first()
    )
    if default_period:
        return default_period

    active_period = (
        db.query(TemplatePeriod)
        .filter(TemplatePeriod.status == "active")
        .order_by(TemplatePeriod.id.asc())
        .first()
    )
    if active_period:
        return active_period
    raise HTTPException(status_code=400, detail="尚未建立可用期別")
