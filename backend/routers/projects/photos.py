# 照片路由
# 處理照片上傳、縮圖、讀取與欄位對應關係更新

import json
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi import HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db
from services.file_service import (
    PHOTO_THUMBNAIL_SIZE,
    build_photo_thumbnail_jpeg,
    get_photo_thumbnail_key,
    read_and_process_photo_upload,
)
from services.request_limiter import require_photo_upload_slot
from services.storage import get_storage
from services.student_pages import (
    apply_photo_mapping,
    apply_photo_to_page,
    mutate_student_pages,
    page_has_photo,
    parse_pages_data,
    photo_record_key,
)

from ._helpers import _parse_json_field, assert_project_content_writable
from .schemas import (
    BatchPhotoUploadResult,
    PhotoMappingPayload,
    PhotoMappingResult,
    PhotoUploadResult,
    SharedPhotoUploadResult,
)

router = APIRouter()

PHOTO_THUMBNAIL_HEADERS = {"Cache-Control": "private, max-age=86400"}


def _get_photo_key_or_404(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session,
) -> str:
    get_project_or_404(project_id, db)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = parse_pages_data(student.pages_data_json)
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="找不到頁面")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_record:
        raise HTTPException(status_code=404, detail="找不到照片")

    photo_key = photo_record_key(photo_record)
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
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上傳學生照片至指定頁面的指定欄位，並更新頁面資料記錄。"""
    processed_upload = await read_and_process_photo_upload(file)

    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    storage = get_storage()
    now = datetime.utcnow()

    def _mutate(pages_data) -> str:
        key = apply_photo_to_page(
            pages_data, student, project_id, page_index, slot_id, processed_upload, storage, now,
        )
        project.updated_at = now
        return key

    # storage 寫入（R2 時是同步網路呼叫）下放 threadpool，不凍結 event loop
    key = await run_in_threadpool(mutate_student_pages, db, student, _mutate)

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
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """上傳專案共用照片，並套用到所有學生的同一頁同一照片格。"""
    processed_upload = await read_and_process_photo_upload(file)

    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    _assert_project_photo_slot_exists(project, page_index, slot_id)

    storage = get_storage()
    now = datetime.utcnow()

    def _fanout_to_all_students() -> int:
        # 第 1 位實際上傳 bytes，其餘用 storage.copy（R2 為 server-side copy），
        # 30 人班從 30 次上傳變 1 次上傳＋29 次輕量複製
        count = 0
        first_key: str | None = None
        project.updated_at = now
        for student in project.students:
            # 逐學生進寫鎖並 commit：與其他上傳併發時不互相蓋寫 pages_data
            key = mutate_student_pages(
                db, student,
                lambda pages_data, student=student: apply_photo_to_page(
                    pages_data, student, project_id, page_index, slot_id,
                    processed_upload, storage, now, source_key=first_key,
                ),
            )
            if first_key is None:
                first_key = key
            count += 1
        return count

    # 整段 fanout（可能數十次 storage 操作）下放 threadpool，不凍結 event loop
    updated = await run_in_threadpool(_fanout_to_all_students)

    return {
        "ok": True,
        "updated": updated,
        "filename": processed_upload.filename,
        "page_index": page_index,
        "slot_id": slot_id,
        "compressed": processed_upload.compressed,
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
    _limit: None = Depends(require_photo_upload_slot),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次上傳照片並依 mapping 分配給對應學生的同一照片格。

    - mapping：JSON 字串，格式 {"<student_id>": "<filename>"}
    - overwrite_existing=false 時跳過已有照片的學生（記入 skipped）
    - 單筆失敗不中斷整批；逐筆進學生寫鎖 commit（容忍多 chunk 併發）
    """
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    _assert_project_photo_slot_exists(project, page_index, slot_id)

    try:
        mapping_data: dict[str, str] = json.loads(mapping)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="mapping 必須是合法 JSON")
    if not isinstance(mapping_data, dict):
        raise HTTPException(status_code=400, detail="mapping 必須是 student_id→filename 字典")

    files_by_name = {f.filename: f for f in files}
    students_by_id = {str(s.id): s for s in project.students}

    storage = get_storage()
    now = datetime.utcnow()
    succeeded: list[dict] = []
    failed: list[dict] = []
    skipped: list[dict] = []

    for student_id_str, filename in mapping_data.items():
        if student_id_str not in students_by_id:
            failed.append({
                "student_id": int(student_id_str) if student_id_str.isdigit() else -1,
                "filename": filename or "",
                "reason": "student_not_in_project",
            })
            continue

        student = students_by_id[student_id_str]
        upload_file = files_by_name.get(filename)
        if upload_file is None:
            failed.append({
                "student_id": student.id, "filename": filename or "",
                "reason": "file_not_uploaded",
            })
            continue

        try:
            processed_upload = await read_and_process_photo_upload(upload_file)
        except HTTPException as exc:
            failed.append({
                "student_id": student.id, "filename": filename,
                "reason": f"upload_rejected:{exc.detail}",
            })
            continue
        except Exception:
            failed.append({
                "student_id": student.id, "filename": filename,
                "reason": "image_decode_failed",
            })
            continue

        # 寫入（含 skip 判斷）進學生寫鎖並逐筆 commit：
        # 精靈的兩個 chunk 併發打同一學生時不會互相蓋寫格位
        def _mutate(pages_data, student=student, processed_upload=processed_upload) -> str | None:
            if not overwrite_existing and page_has_photo(pages_data, page_index, slot_id):
                return None
            key = apply_photo_to_page(
                pages_data, student, project_id, page_index, slot_id, processed_upload, storage, now,
            )
            project.updated_at = now
            return key

        try:
            # storage 寫入下放 threadpool，不凍結 event loop（R2 時是同步網路呼叫）
            key = await run_in_threadpool(mutate_student_pages, db, student, _mutate)
        except Exception:
            failed.append({
                "student_id": student.id, "filename": filename,
                "reason": "storage_write_failed",
            })
            continue

        if key is None:
            skipped.append({
                "student_id": student.id, "filename": filename,
                "reason": "already_has_photo",
            })
            continue

        succeeded.append({"student_id": student.id, "filename": filename, "path": key})

    return {
        "ok": True,
        "page_index": page_index,
        "slot_id": slot_id,
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped,
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
    thumbnail_key = get_photo_thumbnail_key(photo_key, size)
    # HTTP header 只能用 latin-1，含中文檔名時需 URL-encode
    headers = {**PHOTO_THUMBNAIL_HEADERS, "X-Photo-Thumbnail-Key": quote(thumbnail_key, safe="/")}

    try:
        # 直接 get、缺檔再生成：省掉 R2 模式下每次多一趟 head_object 的 RTT
        return Response(
            content=storage.get_bytes(thumbnail_key),
            media_type="image/jpeg",
            headers={**headers, "X-Photo-Thumbnail": "HIT"},
        )
    except FileNotFoundError:
        pass
    except Exception:
        pass

    thumbnail_bytes = build_photo_thumbnail_jpeg(storage, photo_key, size)
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
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    storage = get_storage()

    # mapping 也是 pages_data 的 read-modify-write：與上傳共用學生寫鎖
    def _mutate(pages_data) -> None:
        apply_photo_mapping(pages_data, payload.pages, storage)
        now = datetime.utcnow()
        student.updated_at = now
        project.updated_at = now

    mutate_student_pages(db, student, _mutate)
    return {"ok": True, "renames": {}}
