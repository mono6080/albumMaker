# 模板素材路由
# 背景圖與貼圖素材的上傳/讀取，
# 路由層僅負責 HTTP 接收與回應，storage key 計算委派給 services/file_service

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from auth import get_current_user, require_role
from database import User, get_db
from services.file_service import (
    read_and_validate_image,
)
from services.render_image_loader import (
    BACKGROUND_SOURCE_PIXEL_LIMIT,
    STICKER_SOURCE_PIXEL_LIMIT,
)
from services.request_limiter import require_photo_upload_slot
from services.template_asset_service import (
    serve_background,
    serve_sticker,
    store_sticker,
    suggest_material_text_box as suggest_material_text_box_use_case,
    upload_background as upload_background_use_case,
)

router = APIRouter()


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
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    _: User = Depends(require_role("admin", "art_team")),
):
    """上傳模板頁面的背景圖，並將檔名記錄至資料庫與佈局 JSON。"""
    file_bytes = await read_and_validate_image(
        file,
        max_mb=20,
        max_pixels=BACKGROUND_SOURCE_PIXEL_LIMIT,
    )

    return upload_background_use_case(
        db,
        template_id,
        page_id,
        file.filename,
        file_bytes,
        expected_revision,
    )


@router.get("/{template_id}/pages/{page_id}/background")
def get_background(
    template_id: int,
    page_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """回傳模板頁面的背景圖檔案。"""
    return serve_background(db, template_id, page_id)


# ── 貼圖素材 ──────────────────────────────────────────────────────────────────

@router.post("/{template_id}/stickers")
async def upload_sticker(
    template_id: int,
    file: UploadFile = File(...),
    _limit: None = Depends(require_photo_upload_slot),
    _: User = Depends(require_role("admin", "art_team")),
):
    """上傳貼圖素材至模板專屬目錄。"""
    file_bytes = await read_and_validate_image(
        file,
        max_mb=10,
        max_pixels=STICKER_SOURCE_PIXEL_LIMIT,
    )
    return await run_in_threadpool(
        store_sticker,
        template_id,
        file.filename,
        file_bytes,
    )


@router.post("/{template_id}/pages/{page_id}/material-text-box-suggestion")
def suggest_material_text_box(
    template_id: int,
    page_id: int,
    payload: MaterialTextBoxSuggestionRequest,
    _limit: None = Depends(require_photo_upload_slot),
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
