# 模板素材路由
# 背景圖與貼圖素材的上傳/讀取，
# 路由層僅負責 HTTP 接收與回應，storage key 計算委派給 services/file_service

import io
import json
import re
import time
from pathlib import PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy.orm import Session

from auth import get_current_user, require_role
from crud.template_crud import get_template_page_or_404
from database import User, get_db
from services.file_service import get_background_key, get_sticker_key, read_and_validate_image
from services.layout_groups import canonical_id
from services.material_text_box import (
    analyze_material_text_box,
    decode_rgba_image,
    rgba_asset_revision,
)
from services.storage import get_storage

router = APIRouter()


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
            rgba = decode_rgba_image(uploaded_image)
            image_width, image_height = rgba.size
            asset_revision = rgba_asset_revision(rgba)
    except UnidentifiedImageError:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")

    key = get_sticker_key(template_id, file.filename)
    get_storage().put(key, file_bytes)
    return {
        "path": key,
        "filename": file.filename,
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
