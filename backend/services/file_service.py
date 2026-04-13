# 檔案上傳服務模組
# 封裝所有與上傳檔案 key 計算及實際寫入相關的邏輯，
# 所有 I/O 操作委派給 StorageAdapter，確保路徑格式一致

import re
from pathlib import Path

from fastapi import UploadFile


def get_photo_key(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    original_filename: str
) -> str:
    """
    計算學生照片的 storage key。

    格式：projects/proj{project_id}/photos/student{student_id}/p{page_index}_slot{slot_id}_{filename}
    """
    filename = f"p{page_index}_slot{slot_id}_{original_filename}"
    return f"projects/proj{project_id}/photos/student{student_id}/{filename}"


def get_background_key(template_id: int, page_id: int, original_filename: str) -> str:
    """
    計算模板背景圖的 storage key。

    格式：templates/tmpl{template_id}/backgrounds/page{page_id}_{filename}
    """
    return f"templates/tmpl{template_id}/backgrounds/page{page_id}_{original_filename}"


def get_sticker_key(template_id: int, original_filename: str) -> str:
    """
    計算貼圖素材的 storage key。

    格式：templates/tmpl{template_id}/stickers/{filename}
    """
    return f"templates/tmpl{template_id}/stickers/{original_filename}"


async def save_uploaded_file(key: str, uploaded_file: UploadFile) -> None:
    """將上傳的檔案寫入 storage。"""
    from services.storage import get_storage
    data = await uploaded_file.read()
    get_storage().put(key, data)


def rename_photo_to_slot(old_key: str, new_page_index: int, new_slot_id: int) -> str:
    """將照片 key 重命名以反映新的頁面與格位，回傳新 key。"""
    old_path = Path(old_key)
    match = re.match(r'^p\d+_slot\d+_(.+)$', old_path.name)
    if not match:
        return old_key
    original_name = match.group(1)
    new_filename = f"p{new_page_index}_slot{new_slot_id}_{original_name}"
    new_key = old_path.parent.as_posix() + "/" + new_filename
    if new_key == old_key:
        return old_key
    from services.storage import get_storage
    storage = get_storage()
    # 若目標已被佔用（同名互換情況），跳過以避免覆蓋
    if storage.exists(new_key):
        return old_key
    storage.move(old_key, new_key)
    return new_key
