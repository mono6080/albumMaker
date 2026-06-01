# 檔案上傳服務模組
# 封裝所有與上傳檔案 key 計算及實際寫入相關的邏輯，
# 所有 I/O 操作委派給 StorageAdapter，確保路徑格式一致

import io
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

_BROWSER_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_HEIF_IMAGE_TYPES = {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}
_HEIF_EXTENSIONS = {".heic", ".heif", ".hif"}
_ALLOWED_IMAGE_TYPES = _BROWSER_IMAGE_TYPES
_ALLOWED_PHOTO_IMAGE_TYPES = _BROWSER_IMAGE_TYPES | _HEIF_IMAGE_TYPES
_BYTES_PER_MB = 1024 * 1024
PHOTO_UPLOAD_COMPRESS_OVER_MB = 10
PHOTO_UPLOAD_COMPRESS_TARGET_MB = 5
PHOTO_UPLOAD_HARD_LIMIT_MB = 50
_heif_opener_registered = False


@dataclass(frozen=True)
class ProcessedImageUpload:
    data: bytes
    filename: str
    compressed: bool = False


def _register_heif_opener() -> None:
    global _heif_opener_registered
    if _heif_opener_registered:
        return
    try:
        from pillow_heif import register_heif_opener
    except ImportError as exc:
        raise HTTPException(
            status_code=415,
            detail="伺服器尚未啟用 HEIC/HEIF 支援，請先轉成 JPEG 再上傳",
        ) from exc
    register_heif_opener()
    _heif_opener_registered = True


def _is_heif_upload(file: UploadFile) -> bool:
    suffix = Path(file.filename or "").suffix.lower()
    return file.content_type in _HEIF_IMAGE_TYPES or suffix in _HEIF_EXTENSIONS


def _is_supported_photo_upload(file: UploadFile) -> bool:
    return file.content_type in _ALLOWED_PHOTO_IMAGE_TYPES or _is_heif_upload(file)


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


async def read_and_validate_image(file: UploadFile, max_mb: int = 10) -> bytes:
    """讀取並驗證上傳圖片的類型與大小，回傳 bytes；不符則拋 HTTPException。"""
    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"檔案過大，上限 {max_mb} MB")
    return file_bytes


def _jpeg_upload_filename(original_filename: str | None) -> str:
    original_name = Path(original_filename or "photo").name
    original_path = Path(original_name)
    if original_path.suffix.lower() in {".jpg", ".jpeg"}:
        return original_name
    stem = original_path.stem or "photo"
    return f"{stem}.jpg"


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def _save_jpeg(image: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue()


def _compress_image_to_jpeg(file_bytes: bytes, target_mb: int, is_heif: bool = False) -> bytes:
    target_bytes = target_mb * _BYTES_PER_MB
    try:
        if is_heif:
            _register_heif_opener()
        with Image.open(io.BytesIO(file_bytes)) as raw_image:
            image = _flatten_to_rgb(ImageOps.exif_transpose(raw_image))
            image.load()
    except (OSError, UnidentifiedImageError) as exc:
        raise HTTPException(status_code=415, detail="無法讀取圖片，請確認檔案格式") from exc

    current = image
    try:
        for _ in range(10):
            best = None
            low, high = 40, 92
            while low <= high:
                quality = (low + high) // 2
                candidate = _save_jpeg(current, quality)
                if len(candidate) <= target_bytes:
                    best = candidate
                    low = quality + 1
                else:
                    high = quality - 1

            if best is not None:
                return best

            next_width = max(1, int(current.width * 0.85))
            next_height = max(1, int(current.height * 0.85))
            if next_width == current.width and next_height == current.height:
                break
            resized = current.resize((next_width, next_height), Image.Resampling.LANCZOS)
            if current is not image:
                current.close()
            current = resized
    finally:
        image.close()
        if current is not image:
            current.close()

    raise HTTPException(status_code=413, detail=f"圖片壓縮後仍超過 {target_mb} MB，請先降低解析度")


async def read_and_process_photo_upload(
    file: UploadFile,
    *,
    compress_over_mb: int = PHOTO_UPLOAD_COMPRESS_OVER_MB,
    target_mb: int = PHOTO_UPLOAD_COMPRESS_TARGET_MB,
    hard_limit_mb: int = PHOTO_UPLOAD_HARD_LIMIT_MB,
) -> ProcessedImageUpload:
    """Read a student photo upload, compressing oversized images instead of rejecting them."""
    is_heif = _is_heif_upload(file)
    if not _is_supported_photo_upload(file):
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP、HEIC/HEIF 格式")

    file_bytes = await file.read()
    if len(file_bytes) > hard_limit_mb * _BYTES_PER_MB:
        raise HTTPException(status_code=413, detail=f"檔案過大，上限 {hard_limit_mb} MB")

    if not is_heif and len(file_bytes) <= compress_over_mb * _BYTES_PER_MB:
        return ProcessedImageUpload(
            data=file_bytes,
            filename=file.filename or "photo",
            compressed=False,
        )

    compressed_bytes = await run_in_threadpool(_compress_image_to_jpeg, file_bytes, target_mb, is_heif)
    return ProcessedImageUpload(
        data=compressed_bytes,
        filename=_jpeg_upload_filename(file.filename),
        compressed=True,
    )


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
