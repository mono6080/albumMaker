# 照片 HTTP adapters

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy.orm import Session

from auth import get_current_user
from database import User, get_db
from services.file_service import PHOTO_THUMBNAIL_SIZE
from services.project_photo_service import (
    batch_upload_project_photos,
    serve_student_photo,
    serve_student_photo_thumbnail,
    update_student_photo_mapping,
    upload_shared_project_photo as upload_shared_project_photo_use_case,
    upload_student_photo,
)
from services.request_limiter import require_photo_upload_slot

from .schemas import (
    BatchPhotoUploadResult,
    PhotoMappingPayload,
    PhotoMappingResult,
    PhotoUploadResult,
    SharedPhotoUploadResult,
)


router = APIRouter()


@router.post(
    "/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}",
    response_model=PhotoUploadResult,
)
async def upload_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    file: UploadFile = File(...),
    expected_template_revision: int = Query(..., ge=1),
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    key = await upload_student_photo(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        slot_id,
        expected_template_revision,
        file,
    )
    return {"filename": key.split("/")[-1], "path": key}


@router.post(
    "/{project_id}/photos/shared/pages/{page_index}/slots/{slot_id}",
    response_model=SharedPhotoUploadResult,
)
async def upload_shared_project_photo(
    project_id: int,
    page_index: int,
    slot_id: int,
    file: UploadFile = File(...),
    student_ids: str | None = Form(None),
    expected_template_revision: int = Query(..., ge=1),
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    outcome = await upload_shared_project_photo_use_case(
        db,
        current_user,
        project_id,
        page_index,
        slot_id,
        expected_template_revision,
        file,
        student_ids=student_ids,
    )
    return {
        "ok": True,
        "updated": outcome.updated,
        "filename": outcome.filename,
        "page_index": page_index,
        "slot_id": slot_id,
        "compressed": outcome.compressed,
    }


@router.post(
    "/{project_id}/photos/batch/pages/{page_index}/slots/{slot_id}",
    response_model=BatchPhotoUploadResult,
)
async def batch_upload_photos(
    project_id: int,
    page_index: int,
    slot_id: int,
    files: list[UploadFile] = File(...),
    mapping: str = Form(...),
    overwrite_existing: bool = Form(True),
    expected_template_revision: int = Query(..., ge=1),
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    outcome = await batch_upload_project_photos(
        db,
        current_user,
        project_id,
        page_index,
        slot_id,
        expected_template_revision,
        files,
        mapping,
        overwrite_existing,
    )
    return {
        "ok": True,
        "page_index": page_index,
        "slot_id": slot_id,
        "succeeded": outcome.succeeded,
        "failed": outcome.failed,
        "skipped": outcome.skipped,
    }


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
def get_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return serve_student_photo(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        slot_id,
    )


@router.get(
    "/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}/thumbnail"
)
def get_photo_thumbnail(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    size: int = Query(PHOTO_THUMBNAIL_SIZE, ge=80, le=1200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return serve_student_photo_thumbnail(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        slot_id,
        size,
    )


@router.put(
    "/{project_id}/students/{student_id}/photos/mapping",
    response_model=PhotoMappingResult,
)
def update_photo_mapping(
    project_id: int,
    student_id: int,
    payload: PhotoMappingPayload,
    expected_template_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    update_student_photo_mapping(
        db,
        current_user,
        project_id,
        student_id,
        payload.pages,
        expected_template_revision,
    )
    return {"ok": True, "renames": {}}
