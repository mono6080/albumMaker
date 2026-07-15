"""模板貼圖寫入、讀取與素材文字框分析 use cases。"""

import io
import json
import re
from pathlib import PurePosixPath

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from crud.template_crud import get_template_page_or_404
from services.file_service import content_versioned_filename, get_sticker_key
from services.layout_groups import canonical_id
from services.material_text_box import (
    analyze_material_text_box,
    decode_rgba_image,
    rgba_asset_revision,
)
from services.storage_factory import get_storage


_ASSET_REVISION_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


def store_sticker(template_id: int, filename: str | None, file_bytes: bytes) -> dict:
    """以 immutable content-version key 儲存貼圖。"""
    try:
        with Image.open(io.BytesIO(file_bytes)) as uploaded_image:
            rgba = decode_rgba_image(uploaded_image)
            image_width, image_height = rgba.size
            asset_revision = rgba_asset_revision(rgba)
    except UnidentifiedImageError:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")

    versioned_filename = content_versioned_filename(
        filename,
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


def suggest_material_text_box(
    db: Session,
    template_id: int,
    page_id: int,
    *,
    sticker_id,
    path: str,
    source_revision: str | None,
    request_token: str,
) -> dict:
    """嚴格唯讀地分析一個受保護貼圖。"""
    template_page = get_template_page_or_404(page_id, template_id, db)
    page_layout = json.loads(template_page.layout_json)
    try:
        canonical_id(sticker_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_sticker_reference", "message": "貼圖 ID 格式不正確"},
        ) from exc
    if not (
        _is_canonical_template_sticker_key(template_id, path)
        or _matches_saved_sticker(page_layout, sticker_id, path)
    ):
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_sticker_reference", "message": "貼圖不屬於此模板"},
        )
    if source_revision is not None and not _ASSET_REVISION_PATTERN.fullmatch(source_revision):
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
    if source_revision is not None and source_revision != actual_revision:
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
        "request_token": request_token,
    }


def serve_sticker(template_id: int, filename: str):
    """授權完成後回傳貼圖 response。"""
    storage = get_storage()
    key = get_sticker_key(template_id, filename)
    if not storage.exists(key):
        raise HTTPException(status_code=404, detail="找不到貼圖")
    return storage.serve(key)
