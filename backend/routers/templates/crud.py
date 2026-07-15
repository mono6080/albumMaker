# 模板與模板頁面 CRUD 路由
# 處理模板的建立（含複製）/查詢/改名/刪除，與頁面的新增、佈局更新、刪除，
# 路由層僅負責 HTTP 接收與回應，複製流程委派給 services/template_service

import json
from uuid import uuid4

from fastapi import APIRouter, Depends, Form, HTTPException, Query
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload, selectinload

from auth import get_current_user, require_role
from crud.template_crud import get_template_or_404, get_template_page_or_404
from database import Project, Student, Template, TemplatePeriod, User, get_db
from services.photo_frame_geometry import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    PHOTO_SLOT_CONTENT_BOX_MODE,
    PHOTO_SLOT_DIMENSION_MODE_KEY,
)
from services.template_lifecycle_service import (
    create_template as create_template_use_case,
    delete_template as delete_template_use_case,
    rename_template as rename_template_use_case,
)
from services.template_page_snapshot_service import (
    normalize_template_page_layout,
    replace_template_pages_snapshot,
)
from template_periods import department_label, period_status_label

from ._helpers import (
    _count_template_photo_slots,
    _resolve_template_period,
    _serialize_template_summary,
    _validate_department,
)
from .schemas import TemplatePageSnapshotRequest

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
    query = db.query(Template).options(joinedload(Template.period), selectinload(Template.pages))
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

    new_template = create_template_use_case(
        db,
        name=template_name,
        period=period,
        source_template=source_template,
    )
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
    rename_template_use_case(
        db,
        template_id,
        name=name,
        period_id=period_id,
    )
    return {"ok": True}


@router.get("/{template_id}")
def get_template(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳模板詳細資訊，包含所有頁面的佈局資料。"""
    template = get_template_or_404(template_id, db)
    usage = (
        db.query(
            func.count(func.distinct(Project.id)).label("project_count"),
            func.count(Student.id).label("student_count"),
            func.count(func.distinct(case(
                (Project.completed_at.isnot(None), Project.id),
            ))).label("completed_project_count"),
            func.count(func.distinct(case(
                (Project.deleted_at.isnot(None), Project.id),
            ))).label("archived_project_count"),
        )
        .select_from(Project)
        .outerjoin(Student, Student.project_id == Project.id)
        .filter(Project.template_id == template_id)
        .one()
    )
    return {
        "id": template.id,
        "name": template.name,
        "revision": template.revision,
        "created_at": template.created_at,
        "photo_count": _count_template_photo_slots(template),
        "period_id": template.period_id,
        "period_name": template.period.name if template.period else None,
        "period_status": template.period.status if template.period else None,
        "period_status_label": period_status_label(template.period.status) if template.period else None,
        "department": template.period.department if template.period else None,
        "department_label": department_label(template.period.department) if template.period else None,
        "project_count": usage.project_count,
        "student_count": usage.student_count,
        "completed_project_count": usage.completed_project_count,
        "archived_project_count": usage.archived_project_count,
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
    delete_template_use_case(db, template_id)
    return {"ok": True}


# ── 模板頁面 CRUD ─────────────────────────────────────────────────────────────

@router.put("/{template_id}/pages")
def replace_pages_snapshot(
    template_id: int,
    payload: TemplatePageSnapshotRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """以完整快照原子儲存模板頁面的新增、刪除、排序與版面。"""
    template = get_template_or_404(template_id, db)
    return replace_template_pages_snapshot(
        template,
        payload.expected_page_ids,
        [page.model_dump() for page in payload.pages],
        db,
        expected_revision=payload.expected_revision,
        confirm_project_sync=payload.confirm_project_sync,
        project_sync_change_hash=payload.project_sync_change_hash,
    )

@router.post("/{template_id}/pages", deprecated=True)
def add_page(
    template_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """在模板末尾新增一頁，並初始化空白佈局。"""
    template = get_template_or_404(template_id, db)

    # 初始化空白頁佈局
    blank_layout = {
        "canvas_width": CANVAS_WIDTH,
        "canvas_height": CANVAS_HEIGHT,
        PHOTO_SLOT_DIMENSION_MODE_KEY: PHOTO_SLOT_CONTENT_BOX_MODE,
        "photo_slots": [],
        "text_labels": [],
        "stickers": [],
        "footer": None,
        "logo": None,
    }

    client_id = f"legacy-add-{uuid4().hex}"
    result = replace_template_pages_snapshot(
        template,
        [page.id for page in template.pages],
        [
            *[
                {"id": page.id, "client_id": None, "layout": json.loads(page.layout_json)}
                for page in template.pages
            ],
            {"id": None, "client_id": client_id, "layout": blank_layout},
        ],
        db,
        expected_revision=template.revision,
    )
    new_page = next(page for page in result["pages"] if page["client_id"] == client_id)
    return {"id": new_page["id"], "page_number": new_page["page_number"]}


@router.put("/{template_id}/pages/{page_id}/layout", deprecated=True)
def update_page_layout(
    template_id: int,
    page_id: int,
    layout: dict,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """更新模板頁面的佈局 JSON。"""
    template = get_template_or_404(template_id, db)
    get_template_page_or_404(page_id, template_id, db)
    normalized_layout = normalize_template_page_layout(layout)
    replace_template_pages_snapshot(
        template,
        [page.id for page in template.pages],
        [
            {
                "id": page.id,
                "client_id": None,
                "layout": normalized_layout if page.id == page_id else json.loads(page.layout_json),
            }
            for page in template.pages
        ],
        db,
        expected_revision=template.revision,
    )
    return {"ok": True}


@router.delete("/{template_id}/pages/{page_id}", deprecated=True)
def delete_page(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """刪除指定模板頁面，並清除對應的背景圖檔案。"""
    template = get_template_or_404(template_id, db)
    get_template_page_or_404(page_id, template_id, db)
    replace_template_pages_snapshot(
        template,
        [page.id for page in template.pages],
        [
            {"id": page.id, "client_id": None, "layout": json.loads(page.layout_json)}
            for page in template.pages
            if page.id != page_id
        ],
        db,
        expected_revision=template.revision,
    )
    return {"ok": True}
