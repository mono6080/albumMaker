"""
Render service: composites a single album page as a PIL Image.
Layout JSON schema (per page):
{
  "canvas_width": 794,   # A4 at 96dpi
  "canvas_height": 1123,
  "photo_slots": [
    {
      "id": 1,
      "x": 50, "y": 120, "width": 400, "height": 300,
      "rotation": -3,           # degrees, CCW positive
      "border": true,           # white polaroid border
      "border_width": 8
    }
  ],
  "footer": {
    "text": "情緒愉快微微笑，你是我的小寶貝",
    "x": 60, "y": 1070, "font_size": 22,
    "font_color": "#3B6B8C"
  },
  "logo": {
    "filename": "logo.png",
    "x": 680, "y": 20, "width": 80, "height": 50
  }
}

ProjectStudent page data schema (pages_data_json is a list, one item per page):
[
  {
    "page_index": 0,
    "photos": {
      "1": "projects/proj1/photos/student2/p0_slot1_xxx.jpg",
      "2": {
        "path": "projects/proj1/photos/student2/p0_slot2_yyy.jpg",
        "scale": 1.2,
        "offset_x": -0.1,
        "offset_y": 0.05
      }
    },
    "label_texts": {
      "1": "筠喬笑得好開心呀！",
      "2": "充滿活力的橘色"
    },
    "skip": false
  }
]
"""

import io
from copy import deepcopy
from typing import Any

from PIL import Image, ImageDraw

from app_paths import UPLOADS_DIR as UPLOADS_DIR
from services.draw_helpers import get_font, load_key
from services.element_renderers import (
    render_photo_slot,
    render_sticker,
    render_text_label,
)
from services.layout_geometry_validation import (
    require_safe_template_page_count,
    require_valid_layout_geometry,
)
from services.layout_group_traversal import iter_layout_render_elements
from services.photo_frame_geometry import (
    CANVAS_HEIGHT,
    CANVAS_WIDTH,
    build_photo_frame_slot,
    get_photo_slot_dimension_mode,
)
from services.text_variables import resolve_student_text_variables

_X_NUMERIC_KEYS = {
    "x",
    "width",
    "shadow_offset_x",
    "text_shadow_offset_x",
}
_Y_NUMERIC_KEYS = {
    "y",
    "height",
    "shadow_offset_y",
    "text_shadow_offset_y",
}
_UNIFORM_NUMERIC_KEYS = {
    "font_size",
    "border_width",
    "border_radius",
    "shadow_blur",
    "text_shadow_blur",
    "letter_spacing",
}
PREVIEW_RENDER_SCALE = 0.7
PRINT_OUTPUT_SIZE = (2480, 3508)
PRINT_OUTPUT_DPI = (300, 300)
PRINT_IMAGE_QUALITY = 95
SCREEN_IMAGE_QUALITY = 72
SCREEN_OUTPUT_DPI = (96, 96)


def _scale_number(value, scale: float):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(round(value * scale))
    if isinstance(value, float):
        return value * scale
    return value


def _scale_layout_item(
    item: Any,
    scale_x: float,
    scale_y: float,
    *,
    preserve_text_layout_source: bool = False,
) -> Any:
    if not isinstance(item, dict):
        return deepcopy(item)
    uniform_scale = (scale_x + scale_y) / 2
    scaled = {}
    for key, value in item.items():
        if key in _X_NUMERIC_KEYS:
            scaled[key] = _scale_number(value, scale_x)
        elif key in _Y_NUMERIC_KEYS:
            scaled[key] = _scale_number(value, scale_y)
        elif key in _UNIFORM_NUMERIC_KEYS:
            scaled[key] = _scale_number(value, uniform_scale)
        else:
            scaled[key] = value
    if preserve_text_layout_source:
        source = item.get("_text_layout_source") or item
        scaled["_text_layout_source"] = {
            "width": source.get("width", 1),
            "height": source.get("height", 1),
            "font_size": source.get("font_size", 24),
            "font_family": source.get("font_family"),
            "line_height": source.get("line_height", 1.4),
            "letter_spacing": source.get("letter_spacing", 0),
        }
    return scaled


def scale_layout(layout: dict, scale_x: float, scale_y: float | None = None, target_size: tuple[int, int] | None = None) -> dict:
    """Return a scaled copy of a layout while preserving non-geometric settings."""
    scale_y = scale_x if scale_y is None else scale_y
    if target_size is None and scale_x >= 0.999 and scale_y >= 0.999:
        scaled_layout = deepcopy(layout)
        scaled_layout.pop("text_bubbles", None)
        return scaled_layout

    scaled_layout = deepcopy(layout)
    scaled_layout.pop("text_bubbles", None)
    scaled_layout["canvas_width"] = (
        int(target_size[0]) if target_size else max(1, int(round(layout.get("canvas_width", CANVAS_WIDTH) * scale_x)))
    )
    scaled_layout["canvas_height"] = (
        int(target_size[1]) if target_size else max(1, int(round(layout.get("canvas_height", CANVAS_HEIGHT) * scale_y)))
    )

    for collection_key in ("photo_slots", "text_labels", "stickers"):
        collection = layout.get(collection_key, [])
        scaled_layout[collection_key] = (
            [
                _scale_layout_item(
                    item,
                    scale_x,
                    scale_y,
                    preserve_text_layout_source=collection_key == "text_labels",
                )
                for item in collection
            ]
            if isinstance(collection, list)
            else deepcopy(collection)
        )

    if layout.get("footer"):
        scaled_layout["footer"] = _scale_layout_item(layout["footer"], scale_x, scale_y)
    if layout.get("logo"):
        scaled_layout["logo"] = _scale_layout_item(layout["logo"], scale_x, scale_y)

    return scaled_layout


def scale_layout_for_preview(layout: dict, scale: float = PREVIEW_RENDER_SCALE) -> dict:
    """Return a scaled copy of a layout for fast browser previews."""
    return scale_layout(layout, scale)


def scale_layout_to_size(layout: dict, output_size: tuple[int, int]) -> dict:
    """Scale a layout to a target pixel size for native high-DPI rendering."""
    source_width = layout.get("canvas_width", CANVAS_WIDTH)
    source_height = layout.get("canvas_height", CANVAS_HEIGHT)
    scale_x = output_size[0] / source_width
    scale_y = output_size[1] / source_height
    return scale_layout(layout, scale_x, scale_y, target_size=output_size)


def render_preview_page(
    layout: dict,
    student_name: str,
    page_data: dict,
    page_index: int = 0,
    scale: float = PREVIEW_RENDER_SCALE,
    *,
    album_name: str | None = None,
) -> Image.Image:
    """先以 canonical 尺寸渲染，再降採樣成互動預覽。"""
    canonical_image = render_page(
        layout,
        student_name,
        page_data,
        page_index=page_index,
        album_name=album_name,
    )
    if scale >= 0.999:
        return canonical_image
    preview_size = (
        max(1, int(round(canonical_image.width * scale))),
        max(1, int(round(canonical_image.height * scale))),
    )
    return canonical_image.resize(preview_size, Image.Resampling.LANCZOS)


def _render_page_without_geometry_validation(
    layout: dict,
    student_name: str,
    page_data: dict,
    output_size: tuple = (CANVAS_WIDTH, CANVAS_HEIGHT),
    page_index: int = 0,
    *,
    album_name: str | None = None,
) -> Image.Image:
    """渲染已通過來源版面安全驗證的單頁。"""
    w, h = layout.get("canvas_width", output_size[0]), layout.get("canvas_height", output_size[1])
    canvas = Image.new("RGB", (w, h), "white")

    # 1. Background
    bg_filename = layout.get("background_filename")
    if bg_filename:
        bg = load_key(bg_filename, (w, h))
        if bg:
            bg = bg.convert("RGBA").resize((w, h), Image.LANCZOS)
            canvas.paste(bg, (0, 0), bg)

    draw = ImageDraw.Draw(canvas, "RGBA")

    # 2. 依 z_index 排序所有元素並逐一渲染
    photos = page_data.get("photos", {})
    label_texts = page_data.get("label_texts", {})
    photo_slot_dimension_mode = get_photo_slot_dimension_mode(layout)
    raw_photo_slots = layout.get("photo_slots", [])
    photo_slots = (
        [
            build_photo_frame_slot(slot, photo_slot_dimension_mode)
            if isinstance(slot, dict)
            else slot
            for slot in raw_photo_slots
        ]
        if isinstance(raw_photo_slots, list)
        else raw_photo_slots
    )
    traversal_layout = {**layout, "photo_slots": photo_slots}
    render_elements = list(iter_layout_render_elements(traversal_layout))
    visible_photo_slot_objects = {
        id(elem_data)
        for elem_type, elem_data, _ in render_elements
        if elem_type == "photo"
    }
    visible_photo_indices: dict[int, int] = {}
    if isinstance(photo_slots, list):
        for slot in photo_slots:
            if id(slot) in visible_photo_slot_objects:
                visible_photo_indices[id(slot)] = len(visible_photo_indices)

    for elem_type, elem_data, elem_index in render_elements:
        if elem_type == "photo":
            render_photo_slot(
                canvas,
                elem_data,
                photos,
                page_index,
                slot_index=visible_photo_indices[id(elem_data)],
            )
        elif elem_type == "text":
            render_text_label(
                canvas,
                elem_data,
                label_texts,
                student_name,
                album_name=album_name,
            )
        elif elem_type == "sticker":
            render_sticker(canvas, elem_data)
        draw = ImageDraw.Draw(canvas, "RGBA")  # 每個元素繪製後重建 draw

    # 3. Footer
    footer = layout.get("footer")
    if footer and footer.get("text"):
        raw_footer_text = footer["text"]
        ft = resolve_student_text_variables(
            raw_footer_text,
            student_name,
            album_name,
        )
        ff = get_font(footer.get("font_size", 22))
        draw.text((footer.get("x", w // 2), footer.get("y", h - 50)),
                  ft, fill=footer.get("font_color", "#3B6B8C"), font=ff, anchor="lm")

    # 4. Logo
    logo = layout.get("logo")
    if logo and logo.get("filename"):
        try:
            lg = load_key(f"logos/{logo['filename']}")
            if lg is not None:
                lg = lg.convert("RGBA")
                logo_width = max(1, int(round(float(logo.get("width", 80)))))
                logo_height = max(1, int(round(float(logo.get("height", 50)))))
                logo_x = int(round(float(logo.get("x", w - 90))))
                logo_y = int(round(float(logo.get("y", 20))))
                lg = lg.resize((logo_width, logo_height), Image.LANCZOS)
                canvas.paste(lg, (logo_x, logo_y), lg)
        except Exception:
            pass

    return canvas


def render_page(
    layout: dict,
    student_name: str,
    page_data: dict,
    output_size: tuple = (CANVAS_WIDTH, CANVAS_HEIGHT),
    page_index: int = 0,
    *,
    album_name: str | None = None,
) -> Image.Image:
    """驗證來源版面後渲染單頁，確保 Pillow 配置前已擋下危險幾何。"""
    require_valid_layout_geometry(layout)
    return _render_page_without_geometry_validation(
        layout,
        student_name,
        page_data,
        output_size=output_size,
        page_index=page_index,
        album_name=album_name,
    )


def render_album(
    template_pages: list[dict],
    student_name: str,
    pages_data: list[dict],
    output_size: tuple[int, int] | None = None,
    *,
    album_name: str | None = None,
) -> list[Image.Image]:
    """Render all pages of an album. Returns list of PIL Images."""
    require_safe_template_page_count(len(template_pages))
    images = []
    data_map = {p["page_index"]: p for p in pages_data}
    for i, page_layout in enumerate(template_pages):
        page_data = data_map.get(i, {})
        # 跳過已標記刪除的頁面
        if page_data.get("skip"):
            continue
        require_valid_layout_geometry(page_layout)
        output_layout = scale_layout_to_size(page_layout, output_size) if output_size else page_layout
        img = _render_page_without_geometry_validation(
            output_layout,
            student_name,
            page_data,
            output_size=output_size or (CANVAS_WIDTH, CANVAS_HEIGHT),
            page_index=i,
            album_name=album_name,
        )
        images.append(img)
    return images


SCREEN_OUTPUT_SIZE = (CANVAS_WIDTH, CANVAS_HEIGHT)


def derive_screen_images(print_images: list[Image.Image]) -> list[Image.Image]:
    """由列印圖降採樣產生螢幕圖，取代整輪第二次渲染（渲染時間近乎砍半）。"""
    return [
        img.convert("RGB").resize(SCREEN_OUTPUT_SIZE, Image.LANCZOS)
        for img in print_images
    ]


def _print_ready_image(img: Image.Image) -> Image.Image:
    rgb_image = img.convert("RGB")
    if rgb_image.size == PRINT_OUTPUT_SIZE:
        return rgb_image
    return rgb_image.resize(PRINT_OUTPUT_SIZE, Image.LANCZOS)


def save_album_pdf(images: list[Image.Image], mode: str = "print") -> bytes:
    """將相冊頁面轉成 PDF bytes 並回傳。

    mode='print'  — A4@300dpi（2480×3508），JPEG quality=95（照片內容 PNG 反而肥 5-8 倍且壓縮極慢）
    mode='screen' — 維持原始尺寸，JPEG quality=72，以 96dpi 儲存（A4 大小，省資源）
    """
    import img2pdf
    pages_bytes = []
    for img in images:
        buf = io.BytesIO()
        if mode == "screen":
            # 低畫質：原始 794×1123，JPEG 壓縮，96 DPI → PDF 頁面為 A4 大小
            img.convert("RGB").save(buf, format="JPEG", quality=SCREEN_IMAGE_QUALITY, dpi=SCREEN_OUTPUT_DPI)
        else:
            # 列印畫質：使用原生 A4@300dpi 圖像，舊呼叫者傳小圖時才 fallback resize
            a4_img = _print_ready_image(img)
            a4_img.save(buf, format="JPEG", quality=PRINT_IMAGE_QUALITY, dpi=PRINT_OUTPUT_DPI)
        pages_bytes.append(buf.getvalue())
    return img2pdf.convert(pages_bytes)


def save_album_images(images: list[Image.Image], student_name: str, mode: str = "print") -> dict[str, bytes]:
    """將每頁轉為 JPEG bytes，回傳 {檔名: bytes} 字典。

    mode='print'  — A4@300dpi（2480×3508），JPEG quality=95
    mode='screen' — 維持原始尺寸（794×1123），JPEG quality=72
    """
    result = {}
    for i, img in enumerate(images):
        buf = io.BytesIO()
        if mode == "screen":
            output_image = img.convert("RGB")
            output_image.save(buf, format="JPEG", quality=SCREEN_IMAGE_QUALITY, dpi=SCREEN_OUTPUT_DPI)
            suffix = "_screen"
        else:
            output_image = _print_ready_image(img)
            output_image.save(buf, format="JPEG", quality=PRINT_IMAGE_QUALITY, dpi=PRINT_OUTPUT_DPI)
            suffix = ""
        result[f"{student_name}{suffix}_page{i + 1}.jpg"] = buf.getvalue()
    return result
