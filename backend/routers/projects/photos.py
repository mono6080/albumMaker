# 照片路由
# 處理照片上傳、縮圖、讀取與欄位對應關係更新

import io
import json
from datetime import datetime
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db
from services.file_service import get_photo_key, read_and_process_photo_upload
from services.storage import get_storage

from ._helpers import _parse_json_field, assert_project_writable
from .schemas import PhotoMappingPayload, PhotoMappingResult, PhotoUploadResult, SharedPhotoUploadResult

router = APIRouter()

PHOTO_THUMBNAIL_SIZE = 360
PHOTO_THUMBNAIL_QUALITY = 78
PHOTO_THUMBNAIL_HEADERS = {"Cache-Control": "private, max-age=86400"}


def _thumbnail_key(photo_key: str, size: int = PHOTO_THUMBNAIL_SIZE) -> str:
    photo_path = PurePosixPath(photo_key)
    return f"{photo_path.parent.as_posix()}/thumbnails/{size}/{photo_path.name}.jpg"


def _delete_photo_thumbnails(storage, photo_key: str) -> None:
    photo_path = PurePosixPath(photo_key)
    storage.delete_prefix(f"{photo_path.parent.as_posix()}/thumbnails")


def _jpeg_thumbnail_bytes(storage, photo_key: str, size: int) -> bytes:
    image = storage.open_image(photo_key)
    try:
        image.load()
        thumbnail = image.copy()
    finally:
        image.close()

    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    thumbnail.thumbnail((size, size), resample=resample)
    if thumbnail.mode in {"RGBA", "LA"} or "transparency" in thumbnail.info:
        rgba = thumbnail.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        thumbnail = background
    else:
        thumbnail = thumbnail.convert("RGB")

    buffer = io.BytesIO()
    thumbnail.save(buffer, format="JPEG", quality=PHOTO_THUMBNAIL_QUALITY, optimize=True)
    return buffer.getvalue()


def _get_photo_key_or_404(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session,
) -> str:
    get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="找不到頁面")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_record:
        raise HTTPException(status_code=404, detail="找不到照片")

    photo_key = (
        photo_record
        if isinstance(photo_record, str)
        else photo_record.get("path", "")
    )
    if not photo_key:
        raise HTTPException(status_code=404, detail="找不到照片")

    storage = get_storage()
    if not storage.exists(photo_key):
        raise HTTPException(status_code=404, detail="找不到照片")

    return photo_key


def _assert_project_photo_slot_exists(project, page_index: int, slot_id: int) -> None:
    if page_index < 0 or page_index >= len(project.template.pages):
        raise HTTPException(status_code=404, detail="找不到頁面")

    template_page = project.template.pages[page_index]
    layout = _parse_json_field(template_page.layout_json, "layout_json")
    photo_slots = layout.get("photo_slots") or []
    if not any(str(slot.get("id")) == str(slot_id) for slot in photo_slots):
        raise HTTPException(status_code=404, detail="找不到照片格")


@router.post("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}", response_model=PhotoUploadResult)
async def upload_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上傳學生照片至指定頁面的指定欄位，並更新頁面資料記錄。"""
    processed_upload = await read_and_process_photo_upload(file)

    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })

    storage = get_storage()
    # 若該 slot 已有舊照片，先刪除避免殘留（delete 已處理不存在的情況）
    old_record = pages_data[page_index]["photos"].get(str(slot_id))
    if old_record:
        old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
        if old_key:
            _delete_photo_thumbnails(storage, old_key)
            storage.delete(old_key)

    key = get_photo_key(project_id, student_id, page_index, slot_id, processed_upload.filename)
    storage.put(key, processed_upload.data)  # 直接使用已讀取的 bytes，避免二次讀取

    pages_data[page_index]["photos"][str(slot_id)] = {
        "path": key,
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
    }
    now = datetime.utcnow()
    student.pages_data_json = json.dumps(pages_data)
    student.updated_at = now
    project.updated_at = now
    db.commit()

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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上傳專案共用照片，並套用到所有學生的同一頁同一照片格。"""
    processed_upload = await read_and_process_photo_upload(file)

    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    _assert_project_photo_slot_exists(project, page_index, slot_id)

    storage = get_storage()
    now = datetime.utcnow()
    updated = 0
    slot_id_str = str(slot_id)

    for student in project.students:
        pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
        while len(pages_data) <= page_index:
            pages_data.append({
                "page_index": len(pages_data),
                "photos": {},
                "label_texts": {},
            })

        old_record = pages_data[page_index].get("photos", {}).get(slot_id_str)
        if old_record:
            old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
            if old_key:
                _delete_photo_thumbnails(storage, old_key)
                storage.delete(old_key)

        key = get_photo_key(project_id, student.id, page_index, slot_id, processed_upload.filename)
        storage.put(key, processed_upload.data)
        pages_data[page_index].setdefault("photos", {})[slot_id_str] = {
            "path": key,
            "scale": 1.0,
            "offset_x": 0.0,
            "offset_y": 0.0,
        }
        student.pages_data_json = json.dumps(pages_data)
        student.updated_at = now
        updated += 1

    project.updated_at = now
    db.commit()

    return {
        "ok": True,
        "updated": updated,
        "filename": processed_upload.filename,
        "page_index": page_index,
        "slot_id": slot_id,
        "compressed": processed_upload.compressed,
    }


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
def get_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session = Depends(get_db),
):
    """回傳學生指定欄位的照片檔案。"""
    photo_key = _get_photo_key_or_404(project_id, student_id, page_index, slot_id, db)
    storage = get_storage()
    return storage.serve(photo_key)


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}/thumbnail")
def get_photo_thumbnail(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    size: int = Query(PHOTO_THUMBNAIL_SIZE, ge=80, le=1200),
    db: Session = Depends(get_db),
):
    """回傳學生照片縮圖，供照片管理列表使用。"""
    photo_key = _get_photo_key_or_404(project_id, student_id, page_index, slot_id, db)
    storage = get_storage()
    thumbnail_key = _thumbnail_key(photo_key, size)
    # HTTP header 只能用 latin-1，含中文檔名時需 URL-encode
    headers = {**PHOTO_THUMBNAIL_HEADERS, "X-Photo-Thumbnail-Key": quote(thumbnail_key, safe="/")}

    try:
        if storage.exists(thumbnail_key):
            return Response(
                content=storage.get_bytes(thumbnail_key),
                media_type="image/jpeg",
                headers={**headers, "X-Photo-Thumbnail": "HIT"},
            )
    except Exception:
        pass

    thumbnail_bytes = _jpeg_thumbnail_bytes(storage, photo_key, size)
    try:
        storage.put(thumbnail_key, thumbnail_bytes)
    except Exception:
        pass

    return Response(
        content=thumbnail_bytes,
        media_type="image/jpeg",
        headers={**headers, "X-Photo-Thumbnail": "MISS"},
    )


@router.put("/{project_id}/students/{student_id}/photos/mapping", response_model=PhotoMappingResult)
def update_photo_mapping(
    project_id: int,
    student_id: int,
    payload: PhotoMappingPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    更新照片欄位對應關係，支援跨頁移動、位移縮放與清除。

    兩步驟協議（前後端共同約定）：
    1. 寫入（第一步）：所有非 null 項目先寫入目標格位資料，但不重命名檔案。
       storage key 只代表檔案位置，不需要跟目前格位同步；避免 R2 互動操作變成 copy/delete。
    2. 清除（第二步）：所有 null 項目統一刪除，但只刪除未被移走的檔案。
       跨頁互換時先收集 incoming_paths，確保「A 移到 B、B 移到 A」不誤刪。

    Payload 格式：
      pages: { "頁面索引": { "slot_id": { path, scale, offset_x, offset_y } | null } }
    - 非 null：寫入（自動重命名至新格位前綴）
    - null：清除此格位並刪除對應檔案
    """
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")

    all_pages = payload.pages

    # 跨頁統一收集所有「即將被寫入」的路徑，防止跨頁互換時先刪後找不到
    storage = get_storage()
    incoming_paths: set[str] = set()
    for slot_updates in all_pages.values():
        for photo_path in slot_updates.values():
            if photo_path is not None:
                path_str = photo_path if isinstance(photo_path, str) else photo_path.get("path", "")
                if path_str:
                    incoming_paths.add(path_str)

    # 第一步：所有頁面的非 null 項目先寫入。不要為了格位異動重命名檔案；
    # R2 copy/delete 對拖曳交換太慢，且 render 只需要 DB mapping 中的 path。
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        while len(pages_data) <= page_index:
            pages_data.append({
                "page_index": len(pages_data),
                "photos": {},
                "label_texts": {},
            })
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is None:
                continue
            pages_data[page_index]["photos"][slot_id_str] = photo_path

    # 第二步：所有頁面的 null 項目統一清除，只刪除未被移走的檔案
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is not None:
                continue
            old_record = pages_data[page_index]["photos"].get(slot_id_str)
            if old_record:
                old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
                if old_key and old_key not in incoming_paths:
                    _delete_photo_thumbnails(storage, old_key)
                    storage.delete(old_key)
            pages_data[page_index]["photos"].pop(slot_id_str, None)

    now = datetime.utcnow()
    student.pages_data_json = json.dumps(pages_data)
    student.updated_at = now
    project.updated_at = now
    db.commit()
    return {"ok": True, "renames": {}}
