# 模板與模板頁面 CRUD 路由
# 處理模板的建立（含複製）/查詢/改名/刪除，與頁面的新增、佈局更新、刪除，
# 路由層僅負責 HTTP 接收與回應，複製流程委派給 services/template_service

import json

from fastapi import APIRouter, Depends, Form, HTTPException, Query
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import get_period_or_404, get_template_or_404, get_template_page_or_404
from database import Template, TemplatePage, TemplatePeriod, User, get_db
from services.photo_frame_geometry import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    PHOTO_SLOT_CONTENT_BOX_MODE,
    PHOTO_SLOT_DIMENSION_MODE_KEY,
)
from services.storage import get_storage
from services.template_service import copy_template_pages
from template_periods import department_label, period_status_label

from ._helpers import (
    _count_template_photo_slots,
    _resolve_template_period,
    _serialize_template_summary,
    _validate_department,
)

router = APIRouter()


# ── 模板 CRUD ─────────────────────────────────────────────────────────────────

@router.get("/")
def list_templates(
    department: str | None = Query(None),
    period_id: int | None = Query(None),
    available: bool = Query(False),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳所有模板的摘要清單（依建立時間降序）。"""
    query = db.query(Template)
    if department or available:
        query = query.join(TemplatePeriod, Template.period_id == TemplatePeriod.id)
    if department:
        query = query.filter(TemplatePeriod.department == _validate_department(department))
    if period_id is not None:
        query = query.filter(Template.period_id == period_id)
    if available:
        query = query.filter(TemplatePeriod.status == "active")
    all_templates = query.order_by(Template.created_at.desc()).all()
    return [_serialize_template_summary(template) for template in all_templates]


@router.post("/")
def create_template(
    name: str = Form(...),
    period_id: int | None = Form(None),
    source_template_id: int | None = Form(None),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """建立新模板，可選擇空白建立或複製既有模板。"""
    template_name = name.strip()
    if not template_name:
        raise HTTPException(status_code=400, detail="模板名稱不可空白")
    period = _resolve_template_period(period_id, db)
    source_template = None
    if source_template_id is not None:
        source_template = get_template_or_404(source_template_id, db)

    new_template = Template(name=template_name, period_id=period.id)
    db.add(new_template)
    db.flush()
    if source_template:
        copy_template_pages(source_template, new_template, db)
    db.commit()
    db.refresh(new_template)
    return _serialize_template_summary(new_template)


@router.patch("/{template_id}")
def rename_template(
    template_id: int,
    name: str | None = Form(None),
    period_id: int | None = Form(None),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """修改模板名稱或移動到其他期別。"""
    template = get_template_or_404(template_id, db)
    if name is not None:
        template_name = name.strip()
        if not template_name:
            raise HTTPException(status_code=400, detail="模板名稱不可空白")
        template.name = template_name
    if period_id is not None:
        period = get_period_or_404(period_id, db)
        template.period_id = period.id
    db.commit()
    return {"ok": True}


@router.get("/{template_id}")
def get_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳模板詳細資訊，包含所有頁面的佈局資料。"""
    template = get_template_or_404(template_id, db)
    return {
        "id": template.id,
        "name": template.name,
        "created_at": template.created_at,
        "photo_count": _count_template_photo_slots(template),
        "period_id": template.period_id,
        "period_name": template.period.name if template.period else None,
        "period_status": template.period.status if template.period else None,
        "period_status_label": period_status_label(template.period.status) if template.period else None,
        "department": template.period.department if template.period else None,
        "department_label": department_label(template.period.department) if template.period else None,
        "pages": [
            {
                "id": page.id,
                "page_number": page.page_number,
                "background_filename": page.background_filename,
                "layout": json.loads(page.layout_json),
            }
            for page in template.pages
        ],
    }


@router.delete("/{template_id}")
def delete_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """刪除指定模板及其所有頁面與關聯檔案（背景圖、貼圖）。"""
    template = get_template_or_404(template_id, db)
    # 先刪除 storage 檔案（背景圖、貼圖），再 commit，確保兩者一致
    get_storage().delete_prefix(f"templates/tmpl{template_id}")
    db.delete(template)
    db.commit()
    return {"ok": True}


# ── 模板頁面 CRUD ─────────────────────────────────────────────────────────────

@router.post("/{template_id}/pages")
def add_page(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """在模板末尾新增一頁，並初始化空白佈局。"""
    template = get_template_or_404(template_id, db)

    # 計算下一頁的頁碼（接在現有最大頁碼後）
    next_page_number = max(
        (page.page_number for page in template.pages),
        default=-1
    ) + 1

    # 初始化空白頁佈局
    blank_layout = {
        "canvas_width": CANVAS_WIDTH,
        "canvas_height": CANVAS_HEIGHT,
        PHOTO_SLOT_DIMENSION_MODE_KEY: PHOTO_SLOT_CONTENT_BOX_MODE,
        "photo_slots": [],
        "text_bubbles": [],
        "text_labels": [],
        "stickers": [],
        "footer": None,
        "logo": None,
    }

    new_page = TemplatePage(
        template_id=template_id,
        page_number=next_page_number,
        layout_json=json.dumps(blank_layout),
    )
    db.add(new_page)
    db.commit()
    db.refresh(new_page)
    return {"id": new_page.id, "page_number": new_page.page_number}


@router.put("/{template_id}/pages/{page_id}/layout")
def update_page_layout(
    template_id: int,
    page_id: int,
    layout: dict,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """更新模板頁面的佈局 JSON。"""
    template_page = get_template_page_or_404(page_id, template_id, db)
    template_page.layout_json = json.dumps(layout)
    db.commit()
    return {"ok": True}


@router.delete("/{template_id}/pages/{page_id}")
def delete_page(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """刪除指定模板頁面，並清除對應的背景圖檔案。"""
    template_page = get_template_page_or_404(page_id, template_id, db)
    if template_page.background_filename:
        get_storage().delete(template_page.background_filename)
    db.delete(template_page)
    db.commit()
    return {"ok": True}
