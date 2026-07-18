"""模板版面中會進入 Pillow 配置的幾何安全驗證。"""

from __future__ import annotations

import math
from typing import Any

from services.label_texts import MAX_LABEL_TEXT_LENGTH
from services.layout_group_traversal import iter_layout_render_elements
from services.photo_frame_geometry import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    get_photo_frame_rect,
    get_photo_slot_dimension_mode,
)


MAX_LEAF_DIMENSION_MULTIPLIER = 2.0
MAX_LEAF_AREA_MULTIPLIER = 2.0
MAX_PHOTO_BUFFER_AREA_MULTIPLIER = 2.5
MAX_PAGE_RENDER_BUFFER_AREA_MULTIPLIER = 8.0
MAX_RENDERABLE_LEAF_COUNT = 128
MAX_TEMPLATE_RENDER_PAGES = 16
MAX_POSITION_BEFORE_CANVAS_MULTIPLIER = 2.0
MAX_POSITION_AFTER_CANVAS_MULTIPLIER = 3.0
MAX_ROTATION_DEGREES = 3600.0
MAX_PHOTO_SHADOW_OFFSET = 30.0
MAX_PHOTO_SHADOW_BLUR = 40.0
MAX_SHADOW_OPACITY = 255.0
MAX_TEXT_FONT_SIZE = 96.0
MAX_TEXT_LINE_HEIGHT = 10.0
MAX_TEXT_LETTER_SPACING = 100.0

_MISSING = object()


class LayoutGeometryValidationError(ValueError):
    """版面若可能造成不受控的 Pillow 配置，就在配置前中止。"""

    def __init__(self, errors: list[dict[str, str]]):
        super().__init__("invalid layout geometry")
        self.errors = errors


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _format_number(value: float) -> str:
    return f"{value:g}"


def _validate_number(
    item: dict,
    field_name: str,
    path: str,
    errors: list[dict[str, str]],
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    default: object = _MISSING,
    required: bool = False,
) -> float | None:
    if field_name not in item:
        if required:
            errors.append({
                "path": f"{path}.{field_name}",
                "message": "field is required",
            })
            return None
        return None if default is _MISSING else float(default)

    value = item[field_name]
    if not _is_finite_number(value):
        errors.append({
            "path": f"{path}.{field_name}",
            "message": "must be a finite number",
        })
        return None

    number = float(value)
    if minimum is not None and number < minimum:
        errors.append({
            "path": f"{path}.{field_name}",
            "message": f"must be at least {_format_number(minimum)}",
        })
        return None
    if maximum is not None and number > maximum:
        errors.append({
            "path": f"{path}.{field_name}",
            "message": f"must be at most {_format_number(maximum)}",
        })
        return None
    return number


def _validate_canvas_dimension(
    layout: dict,
    field_name: str,
    canonical_value: int,
    errors: list[dict[str, str]],
) -> float | None:
    if field_name not in layout:
        return float(canonical_value)
    value = layout[field_name]
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value != canonical_value
    ):
        errors.append({
            "path": field_name,
            "message": f"must equal canonical canvas dimension {canonical_value}",
        })
        return None
    return float(value)


def _validate_area(
    width: float,
    height: float,
    *,
    path: str,
    canvas_area: float,
    multiplier: float,
    errors: list[dict[str, str]],
    label: str,
) -> None:
    if width * height <= canvas_area * multiplier:
        return
    errors.append({
        "path": path,
        "message": f"{label} must not exceed {_format_number(multiplier)} canvas areas",
    })


def _validate_leaf_frame(
    item: dict,
    *,
    path: str,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    minimum_size: float,
    errors: list[dict[str, str]],
) -> tuple[float | None, float | None]:
    _validate_number(
        item,
        "x",
        path,
        errors,
        minimum=-canvas_width * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
        maximum=canvas_width * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
        required=True,
    )
    _validate_number(
        item,
        "y",
        path,
        errors,
        minimum=-canvas_height * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
        maximum=canvas_height * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
        required=True,
    )
    width = _validate_number(
        item,
        "width",
        path,
        errors,
        minimum=minimum_size,
        maximum=canvas_width * MAX_LEAF_DIMENSION_MULTIPLIER,
        required=True,
    )
    height = _validate_number(
        item,
        "height",
        path,
        errors,
        minimum=minimum_size,
        maximum=canvas_height * MAX_LEAF_DIMENSION_MULTIPLIER,
        required=True,
    )
    _validate_number(
        item,
        "rotation",
        path,
        errors,
        minimum=-MAX_ROTATION_DEGREES,
        maximum=MAX_ROTATION_DEGREES,
        default=0,
    )
    if width is not None and height is not None:
        _validate_area(
            width,
            height,
            path=path,
            canvas_area=canvas_area,
            multiplier=MAX_LEAF_AREA_MULTIPLIER,
            errors=errors,
            label="element area",
        )
    return width, height


def _clamped_integer(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(round(float(value)))
    except (OverflowError, TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


def _text_render_buffer_area(label: dict, width: float, height: float) -> float:
    if not label.get("text_shadow_enabled"):
        return width * height
    opacity = _clamped_integer(
        label.get("text_shadow_opacity", 120),
        120,
        0,
        255,
    )
    if opacity <= 0:
        return width * height
    offset_x = _clamped_integer(
        label.get("text_shadow_offset_x", 3),
        3,
        -200,
        200,
    )
    offset_y = _clamped_integer(
        label.get("text_shadow_offset_y", 3),
        3,
        -200,
        200,
    )
    blur = _clamped_integer(
        label.get("text_shadow_blur", 4),
        4,
        0,
        200,
    )
    padding = blur * 2 + max(abs(offset_x), abs(offset_y))
    return (width + padding * 2) * (height + padding * 2)


def _validate_text_layout_source(
    label: dict,
    *,
    path: str,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    frame_width: float | None,
    frame_height: float | None,
    allow_internal_text_layout_source: bool,
    errors: list[dict[str, str]],
) -> None:
    if "_text_layout_source" not in label:
        return
    source_path = f"{path}._text_layout_source"
    if not allow_internal_text_layout_source:
        errors.append({
            "path": source_path,
            "message": "internal render metadata must not be persisted",
        })
        return
    source = label["_text_layout_source"]
    if not isinstance(source, dict):
        errors.append({
            "path": source_path,
            "message": "must be an object",
        })
        return

    source_width = _validate_number(
        source,
        "width",
        source_path,
        errors,
        minimum=0.1,
        maximum=canvas_width * MAX_LEAF_DIMENSION_MULTIPLIER,
        default=frame_width if frame_width is not None else 1,
    )
    source_height = _validate_number(
        source,
        "height",
        source_path,
        errors,
        minimum=0.1,
        maximum=canvas_height * MAX_LEAF_DIMENSION_MULTIPLIER,
        default=frame_height if frame_height is not None else 1,
    )
    if source_width is not None and source_height is not None:
        _validate_area(
            source_width,
            source_height,
            path=source_path,
            canvas_area=canvas_area,
            multiplier=MAX_LEAF_AREA_MULTIPLIER,
            errors=errors,
            label="text layout source area",
        )
    maximum_font_size = min(
        MAX_TEXT_FONT_SIZE,
        min(canvas_width, canvas_height) / 4,
    )
    _validate_number(
        source,
        "font_size",
        source_path,
        errors,
        minimum=1,
        maximum=maximum_font_size,
        default=24,
    )
    _validate_number(
        source,
        "line_height",
        source_path,
        errors,
        minimum=0.1,
        maximum=MAX_TEXT_LINE_HEIGHT,
        default=1.4,
    )
    _validate_number(
        source,
        "letter_spacing",
        source_path,
        errors,
        minimum=-MAX_TEXT_LETTER_SPACING,
        maximum=MAX_TEXT_LETTER_SPACING,
        default=0,
    )


def _validate_text_label(
    label: dict,
    *,
    path: str,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    allow_internal_text_layout_source: bool,
    errors: list[dict[str, str]],
) -> float | None:
    if "text" in label and not isinstance(label["text"], str):
        errors.append({
            "path": f"{path}.text",
            "message": "must be a string",
        })
    elif len(label.get("text", "")) > MAX_LABEL_TEXT_LENGTH:
        errors.append({
            "path": f"{path}.text",
            "message": (
                f"must not exceed {MAX_LABEL_TEXT_LENGTH} characters"
            ),
        })
    width, height = _validate_leaf_frame(
        label,
        path=path,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        canvas_area=canvas_area,
        minimum_size=0.1,
        errors=errors,
    )
    maximum_font_size = min(
        MAX_TEXT_FONT_SIZE,
        min(canvas_width, canvas_height) / 4,
    )
    _validate_number(
        label,
        "font_size",
        path,
        errors,
        minimum=1,
        maximum=maximum_font_size,
        default=24,
    )
    _validate_number(
        label,
        "line_height",
        path,
        errors,
        minimum=0.1,
        maximum=MAX_TEXT_LINE_HEIGHT,
        default=1.4,
    )
    _validate_number(
        label,
        "letter_spacing",
        path,
        errors,
        minimum=-MAX_TEXT_LETTER_SPACING,
        maximum=MAX_TEXT_LETTER_SPACING,
        default=0,
    )
    _validate_text_layout_source(
        label,
        path=path,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        canvas_area=canvas_area,
        frame_width=width,
        frame_height=height,
        allow_internal_text_layout_source=allow_internal_text_layout_source,
        errors=errors,
    )
    if width is None or height is None:
        return None
    return _text_render_buffer_area(label, width, height)


def _validate_photo_slot(
    layout: dict,
    slot: dict,
    *,
    path: str,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    errors: list[dict[str, str]],
) -> float | None:
    width, height = _validate_leaf_frame(
        slot,
        path=path,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        canvas_area=canvas_area,
        minimum_size=1.0,
        errors=errors,
    )
    border_width = _validate_number(
        slot,
        "border_width",
        path,
        errors,
        minimum=0,
        maximum=min(canvas_width, canvas_height) / 4,
        default=8,
    )
    border_radius = _validate_number(
        slot,
        "border_radius",
        path,
        errors,
        minimum=0,
        maximum=min(width, height) / 2 if width is not None and height is not None else None,
        default=0,
    )
    shadow_offset_x = _validate_number(
        slot,
        "shadow_offset_x",
        path,
        errors,
        minimum=-MAX_PHOTO_SHADOW_OFFSET,
        maximum=MAX_PHOTO_SHADOW_OFFSET,
        default=5,
    )
    shadow_offset_y = _validate_number(
        slot,
        "shadow_offset_y",
        path,
        errors,
        minimum=-MAX_PHOTO_SHADOW_OFFSET,
        maximum=MAX_PHOTO_SHADOW_OFFSET,
        default=8,
    )
    shadow_blur = _validate_number(
        slot,
        "shadow_blur",
        path,
        errors,
        minimum=0,
        maximum=MAX_PHOTO_SHADOW_BLUR,
        default=14,
    )
    _validate_number(
        slot,
        "shadow_opacity",
        path,
        errors,
        minimum=0,
        maximum=MAX_SHADOW_OPACITY,
        default=120,
    )
    if (
        width is None
        or height is None
        or border_width is None
        or border_radius is None
    ):
        return None

    safe_slot = dict(slot)
    safe_slot.update({
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
        "border_width": border_width,
        "border_radius": border_radius,
    })
    frame = get_photo_frame_rect(
        safe_slot,
        get_photo_slot_dimension_mode(layout),
    )
    frame_width = float(frame["width"])
    frame_height = float(frame["height"])
    if (
        frame_width > canvas_width * MAX_LEAF_DIMENSION_MULTIPLIER
        or frame_height > canvas_height * MAX_LEAF_DIMENSION_MULTIPLIER
    ):
        errors.append({
            "path": path,
            "message": "photo frame dimensions must not exceed 2 canvas spans",
        })
        return None

    shadow_enabled = slot.get("shadow_enabled")
    has_border = slot.get("border", True) is not False
    if shadow_enabled is None:
        shadow_enabled = has_border
    if shadow_enabled:
        if (
            shadow_offset_x is None
            or shadow_offset_y is None
            or shadow_blur is None
        ):
            return None
        padding = shadow_blur * 2 + max(
            abs(shadow_offset_x),
            abs(shadow_offset_y),
        )
        frame_width += padding * 2
        frame_height += padding * 2

    _validate_area(
        frame_width,
        frame_height,
        path=path,
        canvas_area=canvas_area,
        multiplier=MAX_PHOTO_BUFFER_AREA_MULTIPLIER,
        errors=errors,
        label="photo render buffer",
    )
    return frame_width * frame_height


def _validate_leaf_collection(
    layout: dict,
    collection_name: str,
    *,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    strict_schema: bool,
    allow_internal_text_layout_source: bool,
    estimated_areas: dict[int, float],
    errors: list[dict[str, str]],
) -> None:
    collection = layout.get(collection_name, [])
    if not isinstance(collection, list):
        if strict_schema:
            errors.append({
                "path": collection_name,
                "message": "collection must be an array",
            })
        return
    for index, item in enumerate(collection):
        path = f"{collection_name}[{index}]"
        if not isinstance(item, dict):
            if strict_schema:
                errors.append({
                    "path": path,
                    "message": "element must be an object",
                })
            continue
        if collection_name == "photo_slots":
            estimated_area = _validate_photo_slot(
                layout,
                item,
                path=path,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                canvas_area=canvas_area,
                errors=errors,
            )
        elif collection_name == "text_labels":
            estimated_area = _validate_text_label(
                item,
                path=path,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                canvas_area=canvas_area,
                allow_internal_text_layout_source=allow_internal_text_layout_source,
                errors=errors,
            )
        else:
            width, height = _validate_leaf_frame(
                item,
                path=path,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
                canvas_area=canvas_area,
                minimum_size=1.0,
                errors=errors,
            )
            estimated_area = (
                width * height
                if width is not None and height is not None
                else None
            )
        if estimated_area is not None:
            estimated_areas[id(item)] = estimated_area


def _validate_legacy_render_nodes(
    layout: dict,
    *,
    canvas_width: float,
    canvas_height: float,
    canvas_area: float,
    errors: list[dict[str, str]],
) -> float:
    estimated_area = 0.0
    footer = layout.get("footer")
    if footer is not None and not isinstance(footer, dict):
        errors.append({"path": "footer", "message": "footer must be an object or null"})
    elif footer and footer.get("text"):
        if not isinstance(footer["text"], str):
            errors.append({
                "path": "footer.text",
                "message": "must be a string",
            })
        elif len(footer["text"]) > MAX_LABEL_TEXT_LENGTH:
            errors.append({
                "path": "footer.text",
                "message": (
                    f"must not exceed {MAX_LABEL_TEXT_LENGTH} characters"
                ),
            })
        _validate_number(
            footer,
            "x",
            "footer",
            errors,
            minimum=-canvas_width * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
            maximum=canvas_width * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
            default=canvas_width / 2,
        )
        _validate_number(
            footer,
            "y",
            "footer",
            errors,
            minimum=-canvas_height * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
            maximum=canvas_height * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
            default=canvas_height - 50,
        )
        _validate_number(
            footer,
            "font_size",
            "footer",
            errors,
            minimum=1,
            maximum=min(
                MAX_TEXT_FONT_SIZE,
                min(canvas_width, canvas_height) / 4,
            ),
            default=22,
        )

    logo = layout.get("logo")
    if logo is not None and not isinstance(logo, dict):
        errors.append({"path": "logo", "message": "logo must be an object or null"})
    elif logo and logo.get("filename"):
        _validate_number(
            logo,
            "x",
            "logo",
            errors,
            minimum=-canvas_width * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
            maximum=canvas_width * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
            default=canvas_width - 90,
        )
        _validate_number(
            logo,
            "y",
            "logo",
            errors,
            minimum=-canvas_height * MAX_POSITION_BEFORE_CANVAS_MULTIPLIER,
            maximum=canvas_height * MAX_POSITION_AFTER_CANVAS_MULTIPLIER,
            default=20,
        )
        width = _validate_number(
            logo,
            "width",
            "logo",
            errors,
            minimum=1,
            maximum=canvas_width * MAX_LEAF_DIMENSION_MULTIPLIER,
            default=80,
        )
        height = _validate_number(
            logo,
            "height",
            "logo",
            errors,
            minimum=1,
            maximum=canvas_height * MAX_LEAF_DIMENSION_MULTIPLIER,
            default=50,
        )
        if width is not None and height is not None:
            _validate_area(
                width,
                height,
                path="logo",
                canvas_area=canvas_area,
                multiplier=MAX_LEAF_AREA_MULTIPLIER,
                errors=errors,
                label="logo area",
            )
            estimated_area = width * height
    return estimated_area


def _validate_page_render_budget(
    layout: dict,
    estimated_areas: dict[int, float],
    *,
    canvas_area: float,
    legacy_area: float,
    errors: list[dict[str, str]],
) -> None:
    render_elements = list(iter_layout_render_elements(layout))
    if len(render_elements) > MAX_RENDERABLE_LEAF_COUNT:
        errors.append({
            "path": "elements",
            "message": (
                f"renderable element count must not exceed "
                f"{MAX_RENDERABLE_LEAF_COUNT}"
            ),
        })
    total_area = legacy_area + sum(
        estimated_areas.get(id(element), 0)
        for _, element, _ in render_elements
    )
    if total_area > canvas_area * MAX_PAGE_RENDER_BUFFER_AREA_MULTIPLIER:
        errors.append({
            "path": "elements",
            "message": (
                "estimated render buffers must not exceed "
                f"{_format_number(MAX_PAGE_RENDER_BUFFER_AREA_MULTIPLIER)} "
                "canvas areas"
            ),
        })


def validate_layout_geometry(
    layout: Any,
    *,
    strict_schema: bool = True,
    allow_internal_text_layout_source: bool = False,
) -> list[dict[str, str]]:
    """驗證所有持久化且可渲染的幾何，不要求物件必須留在畫布內。"""
    if not isinstance(layout, dict):
        return [{"path": "$", "message": "layout must be an object"}]

    errors: list[dict[str, str]] = []
    canvas_width = _validate_canvas_dimension(
        layout,
        "canvas_width",
        CANVAS_WIDTH,
        errors,
    )
    canvas_height = _validate_canvas_dimension(
        layout,
        "canvas_height",
        CANVAS_HEIGHT,
        errors,
    )
    if canvas_width is None or canvas_height is None:
        return errors

    canvas_area = canvas_width * canvas_height

    estimated_areas: dict[int, float] = {}
    for collection_name in ("photo_slots", "text_labels", "stickers"):
        _validate_leaf_collection(
            layout,
            collection_name,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
            canvas_area=canvas_area,
            strict_schema=strict_schema,
            allow_internal_text_layout_source=allow_internal_text_layout_source,
            estimated_areas=estimated_areas,
            errors=errors,
        )
    legacy_area = _validate_legacy_render_nodes(
        layout,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        canvas_area=canvas_area,
        errors=errors,
    )
    _validate_page_render_budget(
        layout,
        estimated_areas,
        canvas_area=canvas_area,
        legacy_area=legacy_area,
        errors=errors,
    )
    return errors


def require_valid_layout_geometry(layout: Any) -> None:
    """供 renderer 防守舊資料／繞過正式 snapshot 的寫入。"""
    errors = validate_layout_geometry(
        layout,
        strict_schema=False,
        allow_internal_text_layout_source=True,
    )
    if errors:
        raise LayoutGeometryValidationError(errors)


def validate_template_page_count(page_count: int) -> list[dict[str, str]]:
    """回傳會讓正式渲染同時保留過多頁面影像的錯誤。"""
    if page_count <= MAX_TEMPLATE_RENDER_PAGES:
        return []
    return [{
        "path": "pages",
        "message": (
            f"renderable page count must not exceed {MAX_TEMPLATE_RENDER_PAGES}"
        ),
    }]


def require_safe_template_page_count(page_count: int) -> None:
    """正式渲染在第一張配置前套用共用頁數限制。"""
    errors = validate_template_page_count(page_count)
    if errors:
        raise LayoutGeometryValidationError(errors)
