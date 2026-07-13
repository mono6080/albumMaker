# 模板素材路由
# 背景圖與貼圖素材的上傳/讀取，
# 路由層僅負責 HTTP 接收與回應，storage key 計算委派給 services/file_service

import io
import json
import time

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import get_template_page_or_404
from database import User, get_db
from services.file_service import get_background_key, get_sticker_key, read_and_validate_image
from services.storage import get_storage

router = APIRouter()


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
    file_bytes = await read_and_validate_image(file, max_mb=20)

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
    # 同檔名重傳 key 不變：蓋版本戳讓相冊渲染的 dirty-skip 能察覺背景已換
    page_layout["background_version"] = int(time.time())
    template_page.layout_json = json.dumps(page_layout)
    db.commit()

    return {"filename": key}


@router.get("/{template_id}/pages/{page_id}/background")
def get_background(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳模板頁面的背景圖檔案。"""
    template_page = get_template_page_or_404(page_id, template_id, db)

    if not template_page.background_filename:
        raise HTTPException(status_code=404, detail="此頁尚未設定背景圖")

    storage = get_storage()
    if not storage.exists(template_page.background_filename):
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
    file_bytes = await read_and_validate_image(file, max_mb=10)
    try:
        with Image.open(io.BytesIO(file_bytes)) as uploaded_image:
            image_width, image_height = ImageOps.exif_transpose(uploaded_image).size
    except UnidentifiedImageError:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")

    key = get_sticker_key(template_id, file.filename)
    get_storage().put(key, file_bytes)
    return {
        "path": key,
        "filename": file.filename,
        "width": image_width,
        "height": image_height,
    }


@router.get("/{template_id}/stickers/{filename}")
def get_sticker(
    template_id: int,
    filename: str,
    _: User = Depends(get_current_user),
):
    """回傳指定貼圖素材檔案。"""
    storage = get_storage()
    key = get_sticker_key(template_id, filename)
    if not storage.exists(key):
        raise HTTPException(status_code=404, detail="找不到貼圖")
    return storage.serve(key)
