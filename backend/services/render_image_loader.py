"""渲染素材的 bounded Pillow 載入器。"""

from __future__ import annotations

import io
import math
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Literal

from PIL import Image, ImageOps


PRINT_OUTPUT_WIDTH = 2480
PRINT_OUTPUT_HEIGHT = 3508
BACKGROUND_SOURCE_PIXEL_LIMIT = PRINT_OUTPUT_WIDTH * PRINT_OUTPUT_HEIGHT
STICKER_SOURCE_PIXEL_LIMIT = BACKGROUND_SOURCE_PIXEL_LIMIT * 2
MAX_BOUNDED_DECODE_PIXELS = STICKER_SOURCE_PIXEL_LIMIT

_ORIENTATION_TAG = 274
_SWAPPED_ORIENTATIONS = {5, 6, 7, 8}
_DRAFT_CAPABLE_FORMATS = {"JPEG", "MPO"}


class OversizedRenderImageError(ValueError):
    """素材無法在配置完整像素前安全縮到渲染需求。"""


@contextmanager
def open_storage_image_source(storage, key: str) -> Iterator[Image.Image]:
    """以 raw bytes lazy 開圖，讓 caller 能在 load／EXIF copy 前先縮小。"""
    image_bytes = storage.get_bytes(key)
    with Image.open(io.BytesIO(image_bytes)) as image:
        yield image


def _validated_target_size(target_size: tuple[int, int]) -> tuple[int, int]:
    target_width, target_height = target_size
    if (
        isinstance(target_width, bool)
        or isinstance(target_height, bool)
        or not isinstance(target_width, int)
        or not isinstance(target_height, int)
        or target_width <= 0
        or target_height <= 0
    ):
        raise ValueError("target_size 必須是正整數尺寸")
    return target_width, target_height


def _contained_size(
    source_width: int,
    source_height: int,
    maximum_width: int,
    maximum_height: int,
) -> tuple[int, int]:
    scale = min(
        1.0,
        maximum_width / source_width,
        maximum_height / source_height,
    )
    return (
        max(1, int(round(source_width * scale))),
        max(1, int(round(source_height * scale))),
    )


def _bounded_oriented_target(
    image: Image.Image,
    target_size: tuple[int, int],
    fit: Literal["exact", "contain"],
) -> tuple[tuple[int, int], tuple[int, int]]:
    target_width, target_height = _validated_target_size(target_size)
    orientation = image.getexif().get(_ORIENTATION_TAG, 1)
    swaps_axes = orientation in _SWAPPED_ORIENTATIONS
    oriented_source_size = (
        (image.height, image.width)
        if swaps_axes
        else image.size
    )
    if fit == "exact":
        oriented_target = (target_width, target_height)
    elif fit == "contain":
        oriented_target = _contained_size(
            oriented_source_size[0],
            oriented_source_size[1],
            target_width,
            target_height,
        )
    else:
        raise ValueError(f"不支援的 image fit：{fit}")
    decoder_target = (
        (oriented_target[1], oriented_target[0])
        if swaps_axes
        else oriented_target
    )
    return oriented_target, decoder_target


def _prepare_bounded_image(
    image: Image.Image,
    *,
    target_size: tuple[int, int],
    fit: Literal["exact", "contain"],
    source_pixel_limit: int,
) -> Image.Image:
    """在完整 load／EXIF copy／色彩轉換前，把來源縮到實際輸出需求。"""
    source_pixels = image.width * image.height
    image_format = (image.format or "").upper()
    if source_pixels > source_pixel_limit and image_format not in _DRAFT_CAPABLE_FORMATS:
        raise OversizedRenderImageError(
            f"{image_format or 'unknown'} 素材像素超過安全上限"
        )

    oriented_target, decoder_target = _bounded_oriented_target(
        image,
        target_size,
        fit,
    )
    if image_format in _DRAFT_CAPABLE_FORMATS:
        image.draft(None, decoder_target)
        if image.width * image.height > MAX_BOUNDED_DECODE_PIXELS:
            raise OversizedRenderImageError("JPEG draft 後仍超過安全像素上限")

    resized = image.resize(
        decoder_target,
        Image.Resampling.LANCZOS,
        reducing_gap=3.0,
    )
    oriented = ImageOps.exif_transpose(resized)
    if oriented.size != oriented_target:
        corrected = oriented.resize(
            oriented_target,
            Image.Resampling.LANCZOS,
        )
        oriented.close()
        oriented = corrected
    return oriented


def open_bounded_storage_image(
    storage,
    key: str,
    *,
    target_size: tuple[int, int],
    fit: Literal["exact", "contain"],
    source_pixel_limit: int,
) -> Image.Image:
    """透過 StorageAdapter bytes 開啟並回傳已縮小、已校正方向的 detached image。"""
    image_bytes = storage.get_bytes(key)
    with Image.open(io.BytesIO(image_bytes)) as image:
        return _prepare_bounded_image(
            image,
            target_size=target_size,
            fit=fit,
            source_pixel_limit=source_pixel_limit,
        )


def validate_image_pixel_limit(image: Image.Image, pixel_limit: int) -> None:
    """只讀 header 尺寸，超額時在解碼像素前拒絕。"""
    if pixel_limit <= 0 or not math.isfinite(float(pixel_limit)):
        raise ValueError("pixel_limit 必須是正整數")
    if image.width * image.height > pixel_limit:
        raise OversizedRenderImageError("圖片像素尺寸過大")
