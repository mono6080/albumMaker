# 模板路由模組
# 處理模板與模板頁面的 CRUD、背景圖上傳、貼圖上傳與頁面預覽，
# 路由層僅負責 HTTP 接收與回應，業務邏輯委派給 crud / service 層

import io
import json

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from database import Template, TemplatePage, User, get_db
from crud.template_crud import get_template_or_404, get_template_page_or_404
from services.file_service import get_background_key, get_sticker_key
from services.render_service import render_page
from services.storage import get_storage

router = APIRouter(prefix="/api/templates", tags=["templates"])


# ── 模板 CRUD ─────────────────────────────────────────────────────────────────

@router.get("/")
def list_templates(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳所有模板的摘要清單（依建立時間降序）。"""
    all_templates = db.query(Template).order_by(Template.created_at.desc()).all()
    return [
        {
            "id": template.id,
            "name": template.name,
            "created_at": template.created_at,
            "page_count": len(template.pages),
        }
        for template in all_templates
    ]


@router.post("/")
def create_template(
    name: str = Form(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """建立新模板。"""
    new_template = Template(name=name)
    db.add(new_template)
    db.commit()
    db.refresh(new_template)
    return {"id": new_template.id, "name": new_template.name}


@router.patch("/{template_id}")
def rename_template(
    template_id: int,
    name: str = Form(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """修改模板名稱（行內編輯）。"""
    template = get_template_or_404(template_id, db)
    template.name = name.strip()
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
        "canvas_width": 794,
        "canvas_height": 1123,
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


# ── 背景圖 ────────────────────────────────────────────────────────────────────

@router.post("/{template_id}/pages/{page_id}/background")
async def upload_background(
    template_id: int,
    page_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """上傳模板頁面的背景圖，並將檔名記錄至資料庫與佈局 JSON。"""
    _ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
    _MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        from fastapi import HTTPException
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > _MAX_FILE_SIZE:
        from fastapi import HTTPException
        raise HTTPException(status_code=413, detail="檔案過大，上限 20 MB")

    template_page = get_template_page_or_404(page_id, template_id, db)
    storage = get_storage()

    # 若已有舊背景檔（且與新上傳檔名不同），先刪除以避免殘留
    old_key = template_page.background_filename
    key = get_background_key(template_id, page_id, file.filename)
    if old_key and old_key != key:
        storage.delete(old_key)

    storage.put(key, file_bytes)
    template_page.background_filename = key
    page_layout = json.loads(template_page.layout_json)
    page_layout["background_filename"] = key
    template_page.layout_json = json.dumps(page_layout)
    db.commit()

    return {"filename": key}


@router.get("/{template_id}/pages/{page_id}/background")
def get_background(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
):
    """回傳模板頁面的背景圖檔案。"""
    template_page = get_template_page_or_404(page_id, template_id, db)

    if not template_page.background_filename:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="此頁尚未設定背景圖")

    storage = get_storage()
    if not storage.exists(template_page.background_filename):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="找不到檔案")

    return storage.serve(template_page.background_filename)


# ── 貼圖素材 ──────────────────────────────────────────────────────────────────

@router.post("/{template_id}/stickers")
async def upload_sticker(
    template_id: int,
    file: UploadFile = File(...),
    _: User = Depends(require_role("admin", "art_team")),
):
    """上傳貼圖素材至模板專屬目錄。"""
    _ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
    _MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        from fastapi import HTTPException
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > _MAX_FILE_SIZE:
        from fastapi import HTTPException
        raise HTTPException(status_code=413, detail="檔案過大，上限 10 MB")

    key = get_sticker_key(template_id, file.filename)
    get_storage().put(key, file_bytes)
    return {"path": key, "filename": file.filename}


@router.get("/{template_id}/stickers/{filename}")
def get_sticker(
    template_id: int,
    filename: str,
):
    """回傳指定貼圖素材檔案。"""
    storage = get_storage()
    key = get_sticker_key(template_id, filename)
    if not storage.exists(key):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="找不到貼圖")
    return storage.serve(key)


# ── 頁面預覽 ──────────────────────────────────────────────────────────────────

@router.get("/{template_id}/pages/{page_id}/preview")
def preview_template_page(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
):
    """渲染模板頁面預覽圖（以「姓名」佔位符代替學生姓名），回傳 JPEG。"""
    template_page = get_template_page_or_404(page_id, template_id, db)

    page_layout = json.loads(template_page.layout_json)
    preview_image = render_page(
        page_layout,
        "（姓名）",
        {},
        page_index=template_page.page_number,
    )

    # 將圖片編碼為 JPEG 串流回傳
    image_buffer = io.BytesIO()
    preview_image.save(image_buffer, format="JPEG", quality=80)
    image_buffer.seek(0)
    return StreamingResponse(image_buffer, media_type="image/jpeg")
