# 模板素材路由
# 背景圖與貼圖素材的上傳/讀取，
# 路由層僅負責 HTTP 接收與回應，storage key 計算委派給 services/file_service

import io
import hashlib
import json
import logging
import re
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import get_template_page_or_404
from database import User, get_db
from services.file_service import (
    content_versioned_filename,
    get_background_key,
    get_sticker_key,
    read_and_validate_image,
)
from services.layout_groups import canonical_id
from services.material_text_box import (
    analyze_material_text_box,
    decode_rgba_image,
    rgba_asset_revision,
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


_ASSET_REVISION_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


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
    try:
        with Image.open(io.BytesIO(file_bytes)) as uploaded_image:
            rgba = decode_rgba_image(uploaded_image)
            image_width, image_height = rgba.size
            asset_revision = rgba_asset_revision(rgba)
    except UnidentifiedImageError:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")

    # 貼圖採內容版本 key：同名新檔不再覆寫已被既有模板 layout 引用的像素。
    # 真正套用新版本要等編輯器按「儲存」把新 path 寫進 snapshot。
    versioned_filename = content_versioned_filename(
        file.filename,
        asset_revision,
        "sticker",
    )
    key = get_sticker_key(template_id, versioned_filename)
    get_storage().put(key, file_bytes)
    return {
        "path": key,
        "filename": PurePosixPath(key).name,
        "width": image_width,
        "height": image_height,
        "asset_revision": asset_revision,
    }


def _is_canonical_template_sticker_key(template_id: int, path: str) -> bool:
    if "\\" in path or path.startswith("/"):
        return False
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return False
    prefix = get_sticker_key(template_id, "")
    if not path.startswith(prefix):
        return False
    relative_name = path[len(prefix):]
    if "/" in relative_name:
        return False
    return get_sticker_key(template_id, PurePosixPath(relative_name).name) == path


def _matches_saved_sticker(page_layout: dict, sticker_id, path: str) -> bool:
    try:
        requested_id = canonical_id(sticker_id)
    except ValueError:
        return False
    matches = []
    for sticker in page_layout.get("stickers") or []:
        if not isinstance(sticker, dict):
            continue
        try:
            if canonical_id(sticker.get("id")) == requested_id:
                matches.append(sticker)
        except ValueError:
            continue
    if len(matches) > 1:
        raise HTTPException(
            status_code=422,
            detail={"code": "ambiguous_sticker_id", "message": "貼圖 ID 不唯一"},
        )
    return len(matches) == 1 and matches[0].get("path") == path


@router.post("/{template_id}/pages/{page_id}/material-text-box-suggestion")
def suggest_material_text_box(
    template_id: int,
    page_id: int,
    payload: MaterialTextBoxSuggestionRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """Analyze one protected sticker without mutating DB or storage."""
    template_page = get_template_page_or_404(page_id, template_id, db)
    page_layout = json.loads(template_page.layout_json)
    path = payload.path
    try:
        canonical_id(payload.sticker_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_sticker_reference", "message": "貼圖 ID 格式不正確"},
        ) from exc
    if not (
        _is_canonical_template_sticker_key(template_id, path)
        or _matches_saved_sticker(page_layout, payload.sticker_id, path)
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_sticker_reference", "message": "貼圖不屬於此模板"},
        )
    if payload.source_revision is not None and not _ASSET_REVISION_PATTERN.fullmatch(
        payload.source_revision
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_asset_revision", "message": "素材版本格式不正確"},
        )

    try:
        with get_storage().open_image(path) as sticker_image:
            rgba = decode_rgba_image(sticker_image)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="找不到貼圖") from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "material_image_unreadable", "message": "貼圖無法解析"},
        ) from exc

    actual_revision = rgba_asset_revision(rgba)
    if payload.source_revision is not None and payload.source_revision != actual_revision:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "asset_revision_stale",
                "message": "素材內容已變更，請重新分析",
                "source_revision": actual_revision,
            },
        )

    return {
        **analyze_material_text_box(rgba),
        "source_revision": actual_revision,
        "request_token": payload.request_token,
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
