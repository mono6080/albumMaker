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
  "text_bubbles": [
    {
      "id": 1,
      "x": 500, "y": 150, "width": 200, "height": 120,
      "shape": "ellipse",       # ellipse | rect | speech_right | speech_left
      "fill": "#FDED6E",
      "border_color": "#888888",
      "border_width": 2,
      "text": "{name}正在進行飛機飛平衡！",
      "font_size": 20,
      "font_color": "#3B6B8C",
      "line_height": 1.4,
      "tail_side": "right"      # for speech bubbles
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

Student page data schema (pages_data_json is a list, one item per page):
[
  {
    "page_index": 0,
    "photos": {
      "1": "uploads/photos/xxx.jpg",
      "2": "uploads/photos/yyy.jpg"
    },
    "bubble_texts": {
      "1": "筠喬笑得好開心呀！",
      "2": "充滿活力的橘色"
    }
  }
]
"""

import io
from pathlib import Path

from PIL import Image, ImageDraw

from services.draw_helpers import get_font, load_key
from services.element_renderers import (
    render_photo_slot,
    render_sticker,
    render_text_bubble,
    render_text_label,
)

BACKEND_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BACKEND_DIR / "uploads"

# 各元素類型未設定 z_index 時的預設基底（維持向後相容的渲染順序）
_TYPE_Z_BASE = {"photo": 0, "bubble": 100, "text": 200, "sticker": 300}


def render_page(layout: dict, student_name: str, page_data: dict, output_size: tuple = (794, 1123), page_index: int = 0) -> Image.Image:
    """Render one album page and return a PIL Image."""
    w, h = layout.get("canvas_width", output_size[0]), layout.get("canvas_height", output_size[1])
    canvas = Image.new("RGB", (w, h), "white")

    # 1. Background
    bg_filename = layout.get("background_filename")
    if bg_filename:
        bg = load_key(bg_filename)
        if bg:
            bg = bg.convert("RGBA").resize((w, h), Image.LANCZOS)
            canvas.paste(bg, (0, 0), bg)

    draw = ImageDraw.Draw(canvas, "RGBA")

    # 2. 依 z_index 排序所有元素並逐一渲染
    photos = page_data.get("photos", {})
    bubble_texts = page_data.get("bubble_texts", {})
    elements_ordered = sorted([
        *[("photo",   slot,    slot.get("z_index",    _TYPE_Z_BASE["photo"]   + i), i) for i, slot    in enumerate(layout.get("photo_slots",  []))],
        *[("bubble",  bubble,  bubble.get("z_index",  _TYPE_Z_BASE["bubble"]  + i), 0) for i, bubble  in enumerate(layout.get("text_bubbles", []))],
        *[("text",    label,   label.get("z_index",   _TYPE_Z_BASE["text"]    + i), 0) for i, label   in enumerate(layout.get("text_labels",  []))],
        *[("sticker", sticker, sticker.get("z_index", _TYPE_Z_BASE["sticker"] + i), 0) for i, sticker in enumerate(layout.get("stickers",     []))],
    ], key=lambda t: t[2])

    for elem_type, elem_data, _, elem_index in elements_ordered:
        if elem_type == "photo":
            render_photo_slot(canvas, elem_data, photos, page_index, slot_index=elem_index)
        elif elem_type == "bubble":
            render_text_bubble(canvas, elem_data, bubble_texts, student_name)
        elif elem_type == "text":
            render_text_label(canvas, elem_data, student_name)
        elif elem_type == "sticker":
            render_sticker(canvas, elem_data)
        draw = ImageDraw.Draw(canvas, "RGBA")  # 每個元素繪製後重建 draw

    # 3. Footer
    footer = layout.get("footer")
    if footer and footer.get("text"):
        ft = footer["text"].replace("{name}", student_name)
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
                lg = lg.resize((logo.get("width", 80), logo.get("height", 50)), Image.LANCZOS)
                canvas.paste(lg, (logo.get("x", w - 90), logo.get("y", 20)), lg)
        except Exception:
            pass

    return canvas


def render_album(template_pages: list[dict], student_name: str,
                 pages_data: list[dict]) -> list[Image.Image]:
    """Render all pages of an album. Returns list of PIL Images."""
    images = []
    data_map = {p["page_index"]: p for p in pages_data}
    for i, page_layout in enumerate(template_pages):
        page_data = data_map.get(i, {})
        # 跳過已標記刪除的頁面
        if page_data.get("skip"):
            continue
        img = render_page(page_layout, student_name, page_data, page_index=i)
        images.append(img)
    return images


def save_album_pdf(images: list[Image.Image], mode: str = "print") -> bytes:
    """將相冊頁面轉成 PDF bytes 並回傳。

    mode='print'  — 放大至 A4@150dpi（1240×1754），lossless PNG
    mode='screen' — 維持原始尺寸，JPEG quality=72，以 96dpi 儲存（A4 大小，省資源）
    """
    import img2pdf
    pages_bytes = []
    for img in images:
        buf = io.BytesIO()
        if mode == "screen":
            # 低畫質：原始 794×1123，JPEG 壓縮，96 DPI → PDF 頁面為 A4 大小
            img.convert("RGB").save(buf, format="JPEG", quality=72, dpi=(96, 96))
        else:
            # 列印畫質：放大至 A4@150dpi（1240×1754），PNG lossless
            a4_img = img.convert("RGB").resize((1240, 1754), Image.LANCZOS)
            a4_img.save(buf, format="PNG", dpi=(150, 150))
        pages_bytes.append(buf.getvalue())
    return img2pdf.convert(pages_bytes)


def save_album_images(images: list[Image.Image], student_name: str) -> dict[str, bytes]:
    """將每頁轉為 JPEG bytes，回傳 {檔名: bytes} 字典。"""
    result = {}
    for i, img in enumerate(images):
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=92, dpi=(150, 150))
        result[f"{student_name}_page{i + 1}.jpg"] = buf.getvalue()
    return result
