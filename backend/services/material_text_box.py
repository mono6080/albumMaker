"""Read-only material image analysis for creating ordinary text boxes."""

from __future__ import annotations

import hashlib
import math
from collections import deque
from typing import Any

import numpy as np
from PIL import Image, ImageFilter, ImageOps


DETECTOR_VERSION = "alpha-inner-rect-v1"
MATERIAL_TEXT_ANALYSIS_MAX_SIDE = 512
_MIN_IMAGE_SIDE = 8


def _round_geometry(value: float) -> float:
    """與前端 layoutGroupGeometry.js 的 roundGeometry() 使用相同 0.001 精度。"""
    return math.floor((float(value) + float.fromhex("0x1.0000000000000p-52")) * 1000 + 0.5) / 1000


def _normalize_angle(value: float) -> float:
    return _round_geometry(((float(value) + 180) % 360 + 360) % 360 - 180)


def _rotate_point(
    point: tuple[float, float],
    center: tuple[float, float],
    degrees: float,
) -> tuple[float, float]:
    radians = float(degrees) * math.pi / 180
    cosine = math.cos(radians)
    sine = math.sin(radians)
    delta_x = point[0] - center[0]
    delta_y = point[1] - center[1]
    return (
        center[0] + delta_x * cosine - delta_y * sine,
        center[1] + delta_x * sine + delta_y * cosine,
    )


def project_normalized_box_to_sticker(sticker: dict, normalized_box: dict) -> dict[str, float]:
    """把分析框投影到貼圖目前的 world geometry。

    跨語言鏡像：frontend/src/utils/layoutGroupGeometry.js 的
    projectNormalizedBoxToSticker()；兩端案例由各自單元測試釘住。
    """
    values = [
        normalized_box.get("x"),
        normalized_box.get("y"),
        normalized_box.get("width"),
        normalized_box.get("height"),
    ]
    if not all(
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        for value in values
    ):
        raise ValueError("圖片分析框必須是有限數值")
    normalized_x = float(normalized_box["x"])
    normalized_y = float(normalized_box["y"])
    normalized_width = float(normalized_box["width"])
    normalized_height = float(normalized_box["height"])
    if (
        normalized_x < 0
        or normalized_y < 0
        or normalized_width <= 0
        or normalized_height <= 0
        or normalized_x + normalized_width > 1.000001
        or normalized_y + normalized_height > 1.000001
    ):
        raise ValueError("圖片分析框超出素材範圍")

    sticker_x = float(sticker.get("x", 0) or 0)
    sticker_y = float(sticker.get("y", 0) or 0)
    sticker_width = float(sticker.get("width", 0) or 0)
    sticker_height = float(sticker.get("height", 0) or 0)
    if sticker_width <= 0 or sticker_height <= 0:
        raise ValueError("圖片素材尺寸無效")
    rotation = float(sticker.get("rotation", 0) or 0)
    sticker_center = (
        sticker_x + sticker_width / 2,
        sticker_y + sticker_height / 2,
    )
    local_center = (
        sticker_center[0] + (normalized_x + normalized_width / 2 - 0.5) * sticker_width,
        sticker_center[1] + (normalized_y + normalized_height / 2 - 0.5) * sticker_height,
    )
    world_center = _rotate_point(local_center, sticker_center, rotation)
    width = normalized_width * sticker_width
    height = normalized_height * sticker_height
    return {
        "x": _round_geometry(world_center[0] - width / 2),
        "y": _round_geometry(world_center[1] - height / 2),
        "width": _round_geometry(width),
        "height": _round_geometry(height),
        "rotation": _normalize_angle(rotation),
    }


def decode_rgba_image(image: Image.Image) -> Image.Image:
    """Return a detached, orientation-corrected RGBA image."""
    oriented = ImageOps.exif_transpose(image)
    oriented.load()
    return oriented.convert("RGBA")


def rgba_asset_revision(image: Image.Image) -> str:
    """Content revision derived solely from decoded, oriented RGBA pixels."""
    rgba = image if image.mode == "RGBA" else decode_rgba_image(image)
    return f"sha256:{hashlib.sha256(rgba.tobytes()).hexdigest()}"


def _clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def _odd_kernel(value: float, *, minimum: int, maximum: int) -> int:
    size = max(minimum, min(maximum, int(round(value))))
    if size % 2 == 0:
        size += 1 if size < maximum else -1
    return size


def _close_mask(mask: np.ndarray) -> np.ndarray:
    kernel = _odd_kernel(min(mask.shape) * 0.03, minimum=3, maximum=15)
    image = Image.fromarray(mask.astype(np.uint8) * 255)
    closed = image.filter(ImageFilter.MaxFilter(kernel)).filter(ImageFilter.MinFilter(kernel))
    return np.asarray(closed) > 127


def _largest_component(mask: np.ndarray) -> tuple[np.ndarray, int, int, int]:
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    largest: list[tuple[int, int]] = []
    component_count = 0
    second_largest_area = 0
    for start_y, start_x in np.argwhere(mask):
        y, x = int(start_y), int(start_x)
        if visited[y, x]:
            continue
        component_count += 1
        visited[y, x] = True
        queue: deque[tuple[int, int]] = deque([(y, x)])
        pixels: list[tuple[int, int]] = []
        while queue:
            cy, cx = queue.popleft()
            pixels.append((cy, cx))
            for ny in range(max(0, cy - 1), min(height, cy + 2)):
                for nx in range(max(0, cx - 1), min(width, cx + 2)):
                    if mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        queue.append((ny, nx))
        if len(pixels) > len(largest):
            second_largest_area = len(largest)
            largest = pixels
        elif len(pixels) > second_largest_area:
            second_largest_area = len(pixels)

    component = np.zeros_like(mask, dtype=bool)
    if largest:
        ys, xs = zip(*largest)
        component[np.asarray(ys), np.asarray(xs)] = True
    return component, component_count, len(largest), second_largest_area


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    background = ~mask
    exterior = np.zeros_like(mask, dtype=bool)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        for y in (0, height - 1):
            if background[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    for y in range(height):
        for x in (0, width - 1):
            if background[y, x] and not exterior[y, x]:
                exterior[y, x] = True
                queue.append((y, x))
    while queue:
        cy, cx = queue.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if (
                0 <= ny < height
                and 0 <= nx < width
                and background[ny, nx]
                and not exterior[ny, nx]
            ):
                exterior[ny, nx] = True
                queue.append((ny, nx))
    return mask | (background & ~exterior)


def _mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _erode_for_margin(mask: np.ndarray) -> tuple[np.ndarray, bool]:
    bbox = _mask_bbox(mask)
    if bbox is None:
        return mask, False
    x0, y0, x1, y1 = bbox
    radius = max(1, min(12, int(round(min(x1 - x0, y1 - y0) * 0.025))))
    eroded = np.asarray(
        Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(radius * 2 + 1))
    ) > 127
    return (eroded, True) if eroded.any() else (mask, False)


def _largest_inner_rect(mask: np.ndarray) -> tuple[int, int, int, int]:
    rows, columns = mask.shape
    heights = [0] * columns
    best = (0, 0, 0, 0, 0)
    for row in range(rows):
        for column in range(columns):
            heights[column] = heights[column] + 1 if mask[row, column] else 0
        stack: list[int] = []
        column = 0
        while column <= columns:
            height = heights[column] if column < columns else 0
            if not stack or height >= heights[stack[-1]]:
                stack.append(column)
                column += 1
                continue
            top = stack.pop()
            rect_width = column if not stack else column - stack[-1] - 1
            area = heights[top] * rect_width
            candidate = (
                area,
                stack[-1] + 1 if stack else 0,
                row - heights[top] + 1,
                rect_width,
                heights[top],
            )
            if candidate[0] > best[0]:
                best = candidate
    return best[1], best[2], best[3], best[4]


def _confidence(
    *,
    alpha: np.ndarray,
    threshold: int,
    threshold_mask: np.ndarray,
    component: np.ndarray,
    filled: np.ndarray,
    rect: tuple[int, int, int, int],
    component_count: int,
    component_area: int,
    second_largest_area: int,
    used_erosion: bool,
) -> float:
    bbox = _mask_bbox(filled)
    if bbox is None or component_area == 0:
        return 0.0
    x0, y0, x1, y1 = bbox
    bbox_area = max(1, (x1 - x0) * (y1 - y0))
    rect_area = rect[2] * rect[3]
    filled_area = max(1, int(filled.sum()))
    total_mask_area = max(1, int(threshold_mask.sum()))
    dominance = component_area / total_mask_area
    rect_coverage = rect_area / filled_area
    usable_fraction = rect_area / bbox_area
    solid_fraction = component_area / filled_area
    inside_alpha = alpha[component]
    outside_alpha = alpha[~filled]
    inside_level = float(np.median(inside_alpha)) if inside_alpha.size else 0.0
    outside_level = float(np.percentile(outside_alpha, 90)) if outside_alpha.size else 0.0
    alpha_separation = _clamp(
        (inside_level - outside_level) / max(inside_level, float(threshold), 1.0)
    )
    value = (
        0.24 * _clamp((dominance - 0.35) / 0.65)
        + 0.22 * _clamp(rect_coverage / 0.55)
        + 0.20 * _clamp((usable_fraction - 0.12) / 0.40)
        + 0.18 * alpha_separation
        + 0.16 * _clamp((solid_fraction - 0.08) / 0.72)
    )
    if bool(np.all(alpha >= threshold)):
        value = min(value, 0.64)
    if solid_fraction < 0.35:
        value = min(value, 0.78)
    if not used_erosion:
        value = min(value, 0.72)
    if dominance < 0.55 or (
        component_count > 1 and second_largest_area >= component_area * 0.5
    ):
        value = min(value, 0.64)
    if dominance < 0.40 or usable_fraction < 0.12 or rect[2] < 4 or rect[3] < 4:
        value = min(value, 0.49)
    return _clamp(value)


def _normalized_box(rect: tuple[int, int, int, int], width: int, height: int) -> dict[str, float]:
    x, y, rect_width, rect_height = rect
    left = _clamp(x / width)
    top = _clamp(y / height)
    right = _clamp((x + rect_width) / width, left, 1.0)
    bottom = _clamp((y + rect_height) / height, top, 1.0)
    return {
        "x": round(left, 6),
        "y": round(top, 6),
        "width": round(right - left, 6),
        "height": round(bottom - top, 6),
    }


def _unavailable(reason: str, confidence: float = 0.0) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "reason": reason,
        "confidence": round(_clamp(confidence), 4),
        "detector_version": DETECTOR_VERSION,
    }


def analyze_material_text_box(image: Image.Image) -> dict[str, Any]:
    """Suggest one normalized rectangle without modifying image or storage."""
    rgba = image if image.mode == "RGBA" else decode_rgba_image(image)
    if min(rgba.size) < _MIN_IMAGE_SIDE:
        return _unavailable("image_too_small")

    scale = min(1.0, MATERIAL_TEXT_ANALYSIS_MAX_SIDE / max(rgba.size))
    if scale < 1.0:
        rgba = rgba.resize(
            (max(1, round(rgba.width * scale)), max(1, round(rgba.height * scale))),
            Image.Resampling.LANCZOS,
        )
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    positive_alpha = alpha[alpha > 4]
    if positive_alpha.size == 0:
        return _unavailable("no_shape")
    peak = float(np.percentile(positive_alpha, 90))
    threshold = int(round(_clamp(peak * 0.70, 12.0, 224.0)))
    threshold_mask = alpha >= threshold
    if not threshold_mask.any():
        return _unavailable("no_shape")
    component, component_count, component_area, second_largest_area = _largest_component(
        _close_mask(threshold_mask)
    )
    if component_area < max(16, int(alpha.size * 0.0025)):
        return _unavailable("no_shape")
    filled = _fill_holes(component)
    text_mask, used_erosion = _erode_for_margin(filled)
    rect = _largest_inner_rect(text_mask)
    if rect[2] <= 0 or rect[3] <= 0:
        return _unavailable("no_shape")
    confidence = _confidence(
        alpha=alpha,
        threshold=threshold,
        threshold_mask=threshold_mask,
        component=component,
        filled=filled,
        rect=rect,
        component_count=component_count,
        component_area=component_area,
        second_largest_area=second_largest_area,
        used_erosion=used_erosion,
    )
    if confidence < 0.50:
        return _unavailable("low_confidence", confidence)
    return {
        "status": "suggested",
        "normalized_box": _normalized_box(rect, rgba.width, rgba.height),
        "confidence": round(confidence, 4),
        "detector_version": DETECTOR_VERSION,
    }
