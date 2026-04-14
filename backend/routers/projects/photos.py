# 照片路由
# 處理照片上傳、讀取與欄位對應關係更新

import json

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi import HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import User, get_db
from services.file_service import get_photo_key, rename_photo_to_slot
from services.storage import get_storage

from ._helpers import _parse_json_field, assert_project_writable
from .schemas import PhotoMappingPayload, PhotoMappingResult, PhotoUploadResult

router = APIRouter()


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
    _ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
    _MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > _MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="檔案過大，上限 10 MB")

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
        storage.delete(old_key)

    key = get_photo_key(project_id, student_id, page_index, slot_id, file.filename)
    storage.put(key, file_bytes)  # 直接使用已讀取的 bytes，避免二次讀取

    pages_data[page_index]["photos"][str(slot_id)] = {
        "path": key,
        "scale": 1.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
    }
    student.pages_data_json = json.dumps(pages_data)
    db.commit()

    return {"filename": key.split("/")[-1], "path": key}


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
def get_photo(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    db: Session = Depends(get_db),
):
    """回傳學生指定欄位的照片檔案。"""
    project = get_project_or_404(project_id, db)
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

    return storage.serve(photo_key)


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
    1. 重命名（第一步）：所有非 null 項目先重命名檔案，使路徑前綴與新格位對齊。
       後端回傳 renames 供前端同步 serverPath，避免下次儲存送出舊路徑。
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

    renames = {}  # 記錄所有重命名結果，供前端同步 serverPath
    all_pages = payload.pages

    # 跨頁統一收集所有「即將被寫入」的路徑，防止跨頁互換時先刪後找不到
    incoming_paths: set[str] = set()
    for slot_updates in all_pages.values():
        for photo_path in slot_updates.values():
            if photo_path is not None:
                path_str = photo_path if isinstance(photo_path, str) else photo_path.get("path", "")
                if path_str:
                    incoming_paths.add(path_str)

    # 第一步：所有頁面的非 null 項目先重命名並寫入
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
            if isinstance(photo_path, dict) and photo_path.get("path"):
                new_path_str = rename_photo_to_slot(
                    photo_path["path"], page_index, int(slot_id_str)
                )
                # 同步更新 incoming_paths，讓後續 null 清除知道新路徑
                if new_path_str != photo_path["path"]:
                    incoming_paths.discard(photo_path["path"])
                    incoming_paths.add(new_path_str)
                    renames.setdefault(page_index_str, {})[slot_id_str] = new_path_str
                photo_path = {**photo_path, "path": new_path_str}
            pages_data[page_index]["photos"][slot_id_str] = photo_path

    # 第二步：所有頁面的 null 項目統一清除，只刪除未被移走的檔案
    storage = get_storage()
    for page_index_str, slot_updates in all_pages.items():
        page_index = int(page_index_str)
        for slot_id_str, photo_path in slot_updates.items():
            if photo_path is not None:
                continue
            old_record = pages_data[page_index]["photos"].get(slot_id_str)
            if old_record:
                old_key = old_record if isinstance(old_record, str) else old_record.get("path", "")
                if old_key and old_key not in incoming_paths:
                    storage.delete(old_key)
            pages_data[page_index]["photos"].pop(slot_id_str, None)

    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True, "renames": renames}
