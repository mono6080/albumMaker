"""模板貼圖寫入、讀取與素材文字框分析 use cases。"""

import hashlib
import io
import json
import logging
import re
from pathlib import PurePosixPath

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from crud.template_crud import get_template_page_or_404
from services.file_service import (
    content_versioned_filename,
    get_background_key,
    get_sticker_key,
)
from services.layout_group_validation import canonical_id
from services.material_text_box import (
    MATERIAL_TEXT_ANALYSIS_MAX_SIDE,
    analyze_material_text_box,
    decode_rgba_image,
    rgba_asset_revision,
)
from services.render_image_loader import (
    STICKER_SOURCE_PIXEL_LIMIT,
    OversizedRenderImageError,
    open_bounded_storage_image,
)
from services.storage_factory import get_storage
from services.template_project_sync_service import commit_direct_template_render_change
from services.template_sync_locks import lock_template_write


_ASSET_REVISION_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_VERSIONED_STICKER_REVISION_PATTERN = re.compile(
    r"_([0-9a-f]{16})(?:\.[^./]+)?$"
)
logger = logging.getLogger(__name__)


def upload_background(
    db: Session,
    template_id: int,
    page_id: int,
    filename: str | None,
    file_bytes: bytes,
    expected_revision: int,
) -> dict:
    """在 T→P→S 鎖內更新背景與 revision，失敗時清除未綁定的新 key。"""
    storage = get_storage()
    content_revision = hashlib.sha256(file_bytes).hexdigest()
    versioned_filename = content_versioned_filename(
        filename,
        content_revision,
        "background",
    )
    key = get_background_key(template_id, page_id, versioned_filename)
    old_key = None

    with lock_template_write(template_id):
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
                    logger.warning(
                        "背景 DB rollback 後清理新檔失敗 key=%s: %s",
                        key,
                        storage_error,
                    )
            raise

    return {
        "filename": key,
        "revision": template.revision,
        "sync": sync_result,
    }


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


def _saved_sticker_for_reference(
    page_layout: dict,
    sticker_id,
    path: str,
) -> dict | None:
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
    if len(matches) == 1 and matches[0].get("path") == path:
        return matches[0]
    return None


def _trusted_sticker_revision(
    path: str,
    source_revision: str | None,
    saved_sticker: dict | None,
) -> str | None:
    if source_revision is None:
        return None
    saved_revision = (
        saved_sticker.get("asset_revision")
        if isinstance(saved_sticker, dict)
        else None
    )
    if saved_revision == source_revision:
        return source_revision
    revision_match = _VERSIONED_STICKER_REVISION_PATTERN.search(path)
    if (
        revision_match is not None
        and source_revision.removeprefix("sha256:").startswith(
            revision_match.group(1)
        )
    ):
        return source_revision
    return None


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
    saved_sticker = _saved_sticker_for_reference(
        page_layout,
        sticker_id,
        path,
    )
    if not (
        _is_canonical_template_sticker_key(template_id, path)
        or saved_sticker is not None
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
        with open_bounded_storage_image(
            get_storage(),
            path,
            target_size=(
                MATERIAL_TEXT_ANALYSIS_MAX_SIDE,
                MATERIAL_TEXT_ANALYSIS_MAX_SIDE,
            ),
            fit="contain",
            source_pixel_limit=STICKER_SOURCE_PIXEL_LIMIT,
        ) as sticker_image:
            rgba = decode_rgba_image(sticker_image)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="找不到貼圖") from exc
    except OversizedRenderImageError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "material_image_too_large", "message": "貼圖像素尺寸過大"},
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "material_image_unreadable", "message": "貼圖無法解析"},
        ) from exc

    actual_revision = (
        _trusted_sticker_revision(path, source_revision, saved_sticker)
        or rgba_asset_revision(rgba)
    )
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


def serve_background(db: Session, template_id: int, page_id: int):
    """回傳已綁定且存在的模板背景。"""
    template_page = get_template_page_or_404(page_id, template_id, db)
    if not template_page.background_filename:
        raise HTTPException(status_code=404, detail="此頁尚未設定背景圖")
    storage = get_storage()
    if not storage.exists(template_page.background_filename):
        raise HTTPException(status_code=404, detail="找不到檔案")
    return storage.serve(template_page.background_filename)
