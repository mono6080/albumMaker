# 照片路由
# 處理照片上傳、縮圖、讀取與欄位對應關係更新

import io
import json
import threading
from datetime import datetime
from pathlib import PurePosixPath
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Student, User, get_db
from services.file_service import (
    ProcessedImageUpload,
    get_photo_key,
    read_and_process_photo_upload,
)
from services.request_limiter import require_photo_upload_slot
from services.storage import get_storage

from ._helpers import _parse_json_field, assert_project_content_writable
from .schemas import (
    BatchPhotoUploadResult,
    PhotoMappingPayload,
    PhotoMappingResult,
    PhotoUploadResult,
    SharedPhotoUploadResult,
)

router = APIRouter()

PHOTO_THUMBNAIL_SIZE = 360
PHOTO_THUMBNAIL_QUALITY = 78
PHOTO_THUMBNAIL_HEADERS = {"Cache-Control": "private, max-age=86400"}

# pages_data_json 是 read-modify-write：上傳併發（限流 ≥2、精靈雙路 chunk）下
# 同一學生的兩個請求會互相蓋寫格位——寫入必須逐學生串行，
# 且進鎖後先 refresh 拿最新資料、commit 完才放鎖
_student_write_locks: dict[int, threading.Lock] = {}
_student_write_locks_guard = threading.Lock()


def _student_write_lock(student_id: int) -> threading.Lock:
    with _student_write_locks_guard:
        return _student_write_locks.setdefault(student_id, threading.Lock())


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


def _apply_photo_to_student(
    student: Student,
    project_id: int,
    page_index: int,
    slot_id: int,
    processed_upload: ProcessedImageUpload,
    storage,
    now: datetime,
    source_key: str | None = None,
) -> str:
    """寫入單一學生指定照片格：刪舊縮圖→put 新檔→更新 pages_data_json。回傳新 key。

    供 upload_photo / upload_shared_project_photo / batch_upload_photos 共用。
    source_key：共用照片全班展開時，第 2 位起用 storage.copy（R2 為零傳輸的
    server-side copy）取代重複上傳同一份 bytes。呼叫端負責呼叫 db.commit()。
    """
    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })

    slot_id_str = str(slot_id)
    old_record = pages_data[page_index].get("photos", {}).get(slot_id_str)
    if old_record:
        old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
        if old_key:
            _delete_photo_thumbnails(storage, old_key)
            storage.delete(old_key)

    key = get_photo_key(project_id, student.id, page_index, slot_id, processed_upload.filename)
    if source_key and source_key != key:
        storage.copy(source_key, key)
    else:
        storage.put(key, processed_upload.data)
    pages_data[page_index].setdefault("photos", {})[slot_id_str] = {
        "path": key,
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
        # 上傳版本（毫秒）：同名重傳時 key 不變、bytes 會變，預覽快取靠這個欄位換 hash
        "v": int(now.timestamp() * 1000),
    }
    student.pages_data_json = json.dumps(pages_data)
    student.updated_at = now
    return key


def _student_has_photo(student: Student, page_index: int, slot_id: int) -> bool:
    """判斷學生在指定頁面/照片格是否已有照片紀錄。"""
    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    if page_index >= len(pages_data):
        return False
    record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not record:
        return False
    key = record if isinstance(record, str) else record.get("path", "")
    return bool(key)


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

    # storage 寫入（R2 時是同步網路呼叫）下放 threadpool，不凍結 event loop
    def _upload_and_commit() -> str:
        with _student_write_lock(student.id):
            db.refresh(student)  # 進鎖後拿最新 pages_data，避免蓋掉併發請求剛寫的格位
            key = _apply_photo_to_student(
                student, project_id, page_index, slot_id, processed_upload, storage, now,
            )
            project.updated_at = now
            db.commit()
            return key

    key = await run_in_threadpool(_upload_and_commit)

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
            with _student_write_lock(student.id):
                db.refresh(student)
                key = _apply_photo_to_student(
                    student, project_id, page_index, slot_id, processed_upload, storage, now,
                    source_key=first_key,
                )
                db.commit()
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
        def _apply_and_commit(student=student, processed_upload=processed_upload) -> str | None:
            with _student_write_lock(student.id):
                db.refresh(student)
                if not overwrite_existing and _student_has_photo(student, page_index, slot_id):
                    return None
                key = _apply_photo_to_student(
                    student, project_id, page_index, slot_id, processed_upload, storage, now,
                )
                project.updated_at = now
                db.commit()
                return key

        try:
            # storage 寫入下放 threadpool，不凍結 event loop（R2 時是同步網路呼叫）
            key = await run_in_threadpool(_apply_and_commit)
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
    thumbnail_key = _thumbnail_key(photo_key, size)
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
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    # mapping 也是 pages_data 的 read-modify-write：與上傳共用學生寫鎖
    with _student_write_lock(student.id):
        db.refresh(student)
        return _apply_photo_mapping(project, student, payload, db)


def _apply_photo_mapping(project, student: Student, payload: PhotoMappingPayload, db: Session) -> dict:
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

    # 前端送來的照片物件不帶 v（上傳版本），先依 path 收集現有的 v，
    # 寫入時補回去——否則移動/調整照片會遺失版本欄位，
    # 之後同名重傳的預覽快取就換不了 hash
    photo_version_by_path: dict[str, int] = {}
    for page in pages_data:
        for record in (page.get("photos") or {}).values():
            if isinstance(record, dict) and record.get("path") and "v" in record:
                photo_version_by_path[record["path"]] = record["v"]

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
            if isinstance(photo_path, dict) and photo_path.get("path") in photo_version_by_path and "v" not in photo_path:
                photo_path = {**photo_path, "v": photo_version_by_path[photo_path["path"]]}
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
