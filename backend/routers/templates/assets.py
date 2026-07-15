# 模板素材路由
# 背景圖與貼圖素材的上傳/讀取，
# 路由層僅負責 HTTP 接收與回應，storage key 計算委派給 services/file_service

import hashlib
import json
import logging

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import get_template_page_or_404
from database import User, get_db
from services.file_service import (
    content_versioned_filename,
    get_background_key,
    read_and_validate_image,
)
from services.template_asset_service import (
    serve_sticker,
    store_sticker,
    suggest_material_text_box as suggest_material_text_box_use_case,
)
from services.storage import get_storage
from services.template_project_sync_service import commit_direct_template_render_change
from services.template_sync_locks import lock_template_write

router = APIRouter()
logger = logging.getLogger(__name__)


class MaterialTextBoxSuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sticker_id: StrictStr | StrictInt
    path: str = Field(min_length=1, max_length=1024)
    source_revision: str | None = None
    request_token: str = Field(max_length=128)


# ── 背景圖 ────────────────────────────────────────────────────────────────────

@router.post("/{template_id}/pages/{page_id}/background")
async def upload_background(
    template_id: int,
    page_id: int,
    file: UploadFile = File(...),
    expected_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """上傳模板頁面的背景圖，並將檔名記錄至資料庫與佈局 JSON。"""
    file_bytes = await read_and_validate_image(file, max_mb=20)

    storage = get_storage()
    content_revision = hashlib.sha256(file_bytes).hexdigest()
    versioned_filename = content_versioned_filename(
        file.filename,
        content_revision,
        "background",
    )
    key = get_background_key(template_id, page_id, versioned_filename)
    old_key = None

    with lock_template_write(template_id):
        # 內容定址的新 key 先寫 storage；DB commit 成功前不碰舊 key，避免 transaction
        # rollback 後資料列仍指向已被刪除／覆寫的背景。
        db.rollback()
        db.expire_all()
        template_page = get_template_page_or_404(page_id, template_id, db)
        template = template_page.template
        if template.revision != expected_revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "template_revision_changed",
                    "message": "模板已被其他操作更新，請重新整理後再試",
                    "current_revision": template.revision,
                },
            )
        old_key = template_page.background_filename
        storage.put(key, file_bytes)
        try:
            def apply_background_change() -> None:
                current_page = get_template_page_or_404(page_id, template_id, db)
                current_page.background_filename = key
                page_layout = json.loads(current_page.layout_json)
                page_layout["background_filename"] = key
                page_layout["background_version"] = f"sha256:{content_revision}"
                current_page.layout_json = json.dumps(page_layout)

            sync_result = commit_direct_template_render_change(
                template,
                db,
                expected_revision=expected_revision,
                apply_template_change=apply_background_change,
            )
        except Exception:
            db.rollback()
            if key != old_key:
                try:
                    storage.delete(key)
                except Exception as storage_error:
                    logger.warning("背景 DB rollback 後清理新檔失敗 key=%s: %s", key, storage_error)
            raise

    # 舊背景採延遲 GC：可能仍被 in-flight render 或結構備份引用，不能在
    # request commit 後立刻刪除。

    return {
        "filename": key,
        "revision": template.revision,
        "sync": sync_result,
    }


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
    return store_sticker(template_id, file.filename, file_bytes)


@router.post("/{template_id}/pages/{page_id}/material-text-box-suggestion")
def suggest_material_text_box(
    template_id: int,
    page_id: int,
    payload: MaterialTextBoxSuggestionRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """Analyze one protected sticker without mutating DB or storage."""
    return suggest_material_text_box_use_case(
        db,
        template_id,
        page_id,
        sticker_id=payload.sticker_id,
        path=payload.path,
        source_revision=payload.source_revision,
        request_token=payload.request_token,
    )


@router.get("/{template_id}/stickers/{filename}")
def get_sticker(
    template_id: int,
    filename: str,
    _: User = Depends(get_current_user),
):
    """回傳指定貼圖素材檔案。"""
    return serve_sticker(template_id, filename)
