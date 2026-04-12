# 檔案上傳服務模組
# 封裝所有與上傳檔案儲存路徑計算及實際寫入相關的邏輯，
# 確保各類型檔案（照片、背景、貼圖）的儲存路徑一致且集中管理

import shutil
from pathlib import Path

from fastapi import UploadFile
from services.render_service import UPLOADS_DIR


def get_photo_destination_path(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    original_filename: str
) -> Path:
    """
    計算學生照片的儲存路徑，並確保目錄存在。

    儲存格式：uploads/photos/proj{project_id}/student{student_id}/p{page_index}_slot{slot_id}_{filename}
    """
    student_photo_dir = UPLOADS_DIR / "photos" / f"proj{project_id}" / f"student{student_id}"
    student_photo_dir.mkdir(parents=True, exist_ok=True)
    filename = f"p{page_index}_slot{slot_id}_{original_filename}"
    return student_photo_dir / filename


def get_background_destination_path(template_id: int, page_id: int, original_filename: str) -> Path:
    """
    計算模板背景圖的儲存路徑，並確保目錄存在。

    儲存格式：uploads/backgrounds/tmpl{template_id}_page{page_id}_{filename}
    """
    backgrounds_dir = UPLOADS_DIR / "backgrounds"
    backgrounds_dir.mkdir(parents=True, exist_ok=True)
    filename = f"tmpl{template_id}_page{page_id}_{original_filename}"
    return backgrounds_dir / filename


def get_sticker_destination_path(template_id: int, original_filename: str) -> Path:
    """
    計算貼圖素材的儲存路徑，並確保目錄存在。

    儲存格式：uploads/stickers/tmpl{template_id}/{filename}
    """
    sticker_dir = UPLOADS_DIR / "stickers" / f"tmpl{template_id}"
    sticker_dir.mkdir(parents=True, exist_ok=True)
    return sticker_dir / original_filename


async def save_uploaded_file(uploaded_file: UploadFile, destination: Path) -> None:
    """將上傳的檔案寫入指定路徑。"""
    with open(destination, "wb") as output_file:
        shutil.copyfileobj(uploaded_file.file, output_file)
