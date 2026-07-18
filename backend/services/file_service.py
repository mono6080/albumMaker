# 檔案上傳服務模組
# 封裝所有與上傳檔案 key 計算及實際寫入相關的邏輯，
# 所有 I/O 操作委派給 StorageAdapter，確保路徑格式一致

import io
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from services.render_image_loader import (
    MAX_BOUNDED_DECODE_PIXELS,
    open_bounded_storage_image,
)

_BROWSER_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_HEIF_IMAGE_TYPES = {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}
_HEIF_EXTENSIONS = {".heic", ".heif", ".hif"}
_ALLOWED_IMAGE_TYPES = _BROWSER_IMAGE_TYPES
_ALLOWED_PHOTO_IMAGE_TYPES = _BROWSER_IMAGE_TYPES | _HEIF_IMAGE_TYPES
_BYTES_PER_MB = 1024 * 1024
PHOTO_UPLOAD_COMPRESS_OVER_MB = 10
PHOTO_UPLOAD_COMPRESS_TARGET_MB = 5
PHOTO_UPLOAD_HARD_LIMIT_MB = 50
MAX_IMAGE_PIXELS = 60_000_000
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


def _normalized_upload_filename(original_filename: str | None, fallback: str) -> str:
    normalized = (original_filename or fallback).replace("\\", "/")
    filename = PurePosixPath(normalized).name.strip()
    filename = "".join(character for character in filename if ord(character) >= 32)
    if filename in {"", ".", ".."}:
        filename = fallback
    return filename


def sanitize_upload_filename(original_filename: str | None, fallback: str = "upload") -> str:
    """只保留檔名本身，避免客戶端檔名改寫其他 storage namespace。"""
    filename = _normalized_upload_filename(original_filename, fallback)
    return filename[:180]


def content_versioned_filename(
    original_filename: str | None,
    content_revision: str,
    fallback: str,
) -> str:
    """產生保證保留內容 hash 與副檔名的安全檔名（上限 180 字元）。

    不能先拼 hash 再整串截斷：超長原檔名會把 hash 截掉，讓不同內容重新撞 key。
    """
    safe_filename = _normalized_upload_filename(original_filename, fallback)
    path = PurePosixPath(safe_filename)
    revision = content_revision.removeprefix("sha256:")[:16]
    suffix = path.suffix[:20]
    reserved_length = len(revision) + len(suffix) + 1
    stem_budget = max(1, 180 - reserved_length)
    stem = (path.stem or fallback)[:stem_budget]
    return f"{stem}_{revision}{suffix}"


def _assert_image_dimensions(
    image: Image.Image,
    *,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> None:
    width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=415, detail="圖片尺寸無效")
    if width * height > max_pixels:
        raise HTTPException(status_code=413, detail="圖片像素尺寸過大，請先降低解析度")


def _validate_image_bytes(
    file_bytes: bytes,
    *,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> tuple[int, int]:
    try:
        with Image.open(io.BytesIO(file_bytes)) as image:
            _assert_image_dimensions(image, max_pixels=max_pixels)
            image_size = image.size
            image.verify()
            return image_size
    except HTTPException:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=415, detail="無法讀取圖片，請確認檔案格式") from exc


def get_photo_key(
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    original_filename: str,
    content_revision: str | None = None,
) -> str:
    """
    計算學生照片的 storage key。

    格式：projects/proj{project_id}/photos/student{student_id}/p{page_index}_slot{slot_id}_{filename}
    """
    safe_filename = (
        content_versioned_filename(original_filename, content_revision, "photo")
        if content_revision
        else sanitize_upload_filename(original_filename, "photo")
    )
    filename = f"p{page_index}_slot{slot_id}_{safe_filename}"
    return f"projects/proj{project_id}/photos/student{student_id}/{filename}"


PHOTO_THUMBNAIL_SIZE = 360
PHOTO_THUMBNAIL_QUALITY = 78


def build_photo_thumbnail_jpeg(storage, photo_key: str, size: int = PHOTO_THUMBNAIL_SIZE) -> bytes:
    """在完整解碼前先縮到目標框，再生成照片管理列表 JPEG。"""
    image = open_bounded_storage_image(
        storage,
        photo_key,
        target_size=(size, size),
        fit="contain",
        source_pixel_limit=MAX_BOUNDED_DECODE_PIXELS,
    )
    thumbnail = None
    try:
        thumbnail = _flatten_to_rgb(image)
        buffer = io.BytesIO()
        thumbnail.save(
            buffer,
            format="JPEG",
            quality=PHOTO_THUMBNAIL_QUALITY,
            optimize=True,
        )
        return buffer.getvalue()
    finally:
        if thumbnail is not None and thumbnail is not image:
            thumbnail.close()
        image.close()


def get_photo_thumbnail_key(photo_key: str, size: int = PHOTO_THUMBNAIL_SIZE) -> str:
    """照片縮圖的 storage key：{照片目錄}/thumbnails/{size}/{檔名}.jpg"""
    photo_path = PurePosixPath(photo_key)
    return f"{photo_path.parent.as_posix()}/thumbnails/{size}/{photo_path.name}.jpg"


def delete_photo_thumbnails(storage, photo_key: str) -> None:
    """刪除照片的所有縮圖（換照片/刪照片時避免殘留舊縮圖）。"""
    photo_path = PurePosixPath(photo_key)
    storage.delete_prefix(f"{photo_path.parent.as_posix()}/thumbnails")


def get_background_key(template_id: int, page_id: int, original_filename: str) -> str:
    """
    計算模板背景圖的 storage key。

    格式：templates/tmpl{template_id}/backgrounds/page{page_id}_{filename}
    """
    safe_filename = sanitize_upload_filename(original_filename, "background")
    return f"templates/tmpl{template_id}/backgrounds/page{page_id}_{safe_filename}"


def get_sticker_key(template_id: int, original_filename: str) -> str:
    """
    計算貼圖素材的 storage key。

    格式：templates/tmpl{template_id}/stickers/{filename}
    """
    if original_filename == "":
        return f"templates/tmpl{template_id}/stickers/"
    safe_filename = sanitize_upload_filename(original_filename, "sticker")
    return f"templates/tmpl{template_id}/stickers/{safe_filename}"


async def read_and_validate_image(
    file: UploadFile,
    max_mb: int = 10,
    *,
    max_pixels: int = MAX_IMAGE_PIXELS,
) -> bytes:
    """讀取並驗證上傳圖片的類型與大小，回傳 bytes；不符則拋 HTTPException。"""
    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="僅支援 JPEG、PNG、WebP 格式")
    file_bytes = await file.read()
    if len(file_bytes) > max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"檔案過大，上限 {max_mb} MB")
    await run_in_threadpool(
        _validate_image_bytes,
        file_bytes,
        max_pixels=max_pixels,
    )
    return file_bytes


def _jpeg_upload_filename(original_filename: str | None) -> str:
    original_name = sanitize_upload_filename(original_filename, "photo")
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
    return image if image.mode == "RGB" else image.convert("RGB")


# 列印輸出（A4@300dpi）長邊為 3508px，再高的解析度輸出用不到；
# 先縮到這個上限能讓每次 JPEG 編碼快 4-5 倍
PHOTO_MAX_LONG_EDGE = 3600


def _save_jpeg(image: Image.Image, quality: int) -> bytes:
    # 不用 optimize=True：多一整趟編碼只省幾 % 大小，
    # HEIC 轉檔的「處理中」秒數對老師比較有感
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, progressive=True)
    return buffer.getvalue()


def _compress_image_to_jpeg(file_bytes: bytes, target_mb: int, is_heif: bool = False) -> bytes:
    """壓縮策略：長邊先壓到列印上限，再走至多 3 級品質階梯；
    仍超標才逐步縮小。取代原本的二分搜品質（最多 6 次全解析度編碼 × 10 輪）。
    單張 iPhone HEIC 的轉檔時間從 5-10 秒降到 1-2 秒。"""
    target_bytes = target_mb * _BYTES_PER_MB
    try:
        if is_heif:
            _register_heif_opener()
        with Image.open(io.BytesIO(file_bytes)) as raw_image:
            _assert_image_dimensions(raw_image)
            raw_image.draft(
                None,
                (PHOTO_MAX_LONG_EDGE, PHOTO_MAX_LONG_EDGE),
            )
            if max(raw_image.size) > PHOTO_MAX_LONG_EDGE:
                raw_image.thumbnail(
                    (PHOTO_MAX_LONG_EDGE, PHOTO_MAX_LONG_EDGE),
                    Image.Resampling.LANCZOS,
                    reducing_gap=3.0,
                )
            image = _flatten_to_rgb(ImageOps.exif_transpose(raw_image))
            image.load()
    except HTTPException:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=415, detail="無法讀取圖片，請確認檔案格式") from exc

    if max(image.size) > PHOTO_MAX_LONG_EDGE:
        ratio = PHOTO_MAX_LONG_EDGE / max(image.size)
        image = image.resize(
            (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
            Image.Resampling.LANCZOS,
        )

    for quality in (88, 80, 70):
        candidate = _save_jpeg(image, quality)
        if len(candidate) <= target_bytes:
            return candidate

    # 極端情況（超長全景等）：逐步縮小再試
    current = image
    for _ in range(4):
        current = current.resize(
            (max(1, int(current.width * 0.75)), max(1, int(current.height * 0.75))),
            Image.Resampling.LANCZOS,
        )
        candidate = _save_jpeg(current, 80)
        if len(candidate) <= target_bytes:
            return candidate

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
        image_width, image_height = await run_in_threadpool(
            _validate_image_bytes,
            file_bytes,
        )
        if max(image_width, image_height) <= PHOTO_MAX_LONG_EDGE:
            return ProcessedImageUpload(
                data=file_bytes,
                filename=sanitize_upload_filename(file.filename, "photo"),
                compressed=False,
            )

    compressed_bytes = await run_in_threadpool(_compress_image_to_jpeg, file_bytes, target_mb, is_heif)
    return ProcessedImageUpload(
        data=compressed_bytes,
        filename=_jpeg_upload_filename(file.filename),
        compressed=True,
    )
