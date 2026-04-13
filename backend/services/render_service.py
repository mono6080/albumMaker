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
import json
import math
import os
from typing import Optional
import textwrap
from pathlib import Path
from typing import Optional

from PIL import Image, ImageCms, ImageDraw, ImageFilter, ImageFont

BACKEND_DIR = Path(__file__).parent.parent
UPLOADS_DIR = BACKEND_DIR / "uploads"

# CJK 字型候選清單：Windows 優先，找不到自動 fallback 至 Linux 路徑
CJK_FONTS = [
    # Windows
    "C:/Windows/Fonts/msjh.ttc",
    "C:/Windows/Fonts/msjhbd.ttc",
    "C:/Windows/Fonts/mingliu.ttc",
    "C:/Windows/Fonts/kaiu.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    # Linux（Noto CJK / WenQuanYi）
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
]

# Named font map: key matches layout JSON "font_family" field
FONT_MAP = {
    # Windows
    "msjh":    "C:/Windows/Fonts/msjh.ttc",
    "msjhbd":  "C:/Windows/Fonts/msjhbd.ttc",
    "mingliu": "C:/Windows/Fonts/mingliu.ttc",
    "kaiu":    "C:/Windows/Fonts/kaiu.ttf",
    "simsun":  "C:/Windows/Fonts/simsun.ttc",
    "msyh":    "C:/Windows/Fonts/msyh.ttc",
    # Linux
    "noto":    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "wqy":     "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
}

_SRGB_PROFILE = ImageCms.createProfile("sRGB")


def _to_srgb(img: Image.Image) -> Image.Image:
    """將已開啟的 PIL Image 套用 ICC profile 並轉為 sRGB。"""
    icc = img.info.get("icc_profile")
    if icc:
        try:
            src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            transform = ImageCms.buildTransformFromOpenProfiles(
                src_profile, _SRGB_PROFILE, img.mode, "RGB",
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            )
            return ImageCms.applyTransform(img, transform)
        except Exception:
            return img.convert("RGB")
    return img.convert("RGB")


def _load_key(key: str) -> Optional[Image.Image]:
    """從 storage 讀取圖片並轉為 sRGB，key 不存在時回傳 None。"""
    from services.storage import get_storage
    storage = get_storage()
    if not storage.exists(key):
        return None
    return _to_srgb(storage.open_image(key))


def _get_font(size: int, family: str = None) -> ImageFont.FreeTypeFont:
    """Return a FreeType font at `size` pts. If `family` is specified, use FONT_MAP lookup."""
    candidates = []
    if family and family in FONT_MAP:
        candidates.append(FONT_MAP[family])
    candidates.extend(CJK_FONTS)
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _paste_rotated(canvas: Image.Image, src: Image.Image, cx: float, cy: float, angle: float):
    """Paste src centered at (cx, cy) rotated by angle degrees."""
    rotated = src.rotate(-angle, expand=True, resample=Image.BICUBIC)
    px = int(cx - rotated.width / 2)
    py = int(cy - rotated.height / 2)
    if rotated.mode == "RGBA":
        canvas.paste(rotated, (px, py), rotated)
    else:
        canvas.paste(rotated, (px, py))


def _apply_rounded_corners(img: Image.Image, radius: int) -> Image.Image:
    """Clip an RGBA image to rounded corners using a luminance mask."""
    if radius <= 0:
        return img
    img = img.convert("RGBA")
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, img.width - 1, img.height - 1], radius=radius, fill=255
    )
    result = img.copy()
    result.putalpha(mask)
    return result


def _add_drop_shadow(img: Image.Image, offset=(4, 6), blur=10,
                     shadow_color=(0, 0, 0, 70)) -> Image.Image:
    """Return a new RGBA image = drop-shadow + original composited together."""
    pad = blur * 2 + max(abs(offset[0]), abs(offset[1]))
    total_w = img.width + pad * 2
    total_h = img.height + pad * 2

    shadow = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    mask = Image.new("RGBA", (img.width, img.height), shadow_color)
    shadow.paste(mask, (pad + offset[0], pad + offset[1]))
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))

    combined = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    combined.paste(shadow, (0, 0), shadow)
    combined.paste(img, (pad, pad), img)
    return combined


def _draw_speech_bubble(draw: ImageDraw.ImageDraw, bubble: dict):
    """Draw a speech bubble shape onto draw context."""
    x, y, w, h = bubble["x"], bubble["y"], bubble["width"], bubble["height"]
    fill = bubble.get("fill", "#FDED6E")
    bc = bubble.get("border_color", None)
    bw = bubble.get("border_width", 0)
    shape = bubble.get("shape", "ellipse")
    tail_side = bubble.get("tail_side", "right")

    outline = bc if bc and bw > 0 else None
    lw = bw if bw > 0 else 1

    default_r = min(w, h) // 5
    r = int(bubble.get("border_radius", default_r))

    if shape == "ellipse":
        draw.ellipse([x, y, x + w, y + h], fill=fill, outline=outline, width=lw)

    elif shape == "rect":
        draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=lw)

    elif shape in ("speech_right", "speech_left"):
        draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=lw)
        tail_h = h // 4
        tail_w = w // 5
        if tail_side == "right":
            tip_x = x + w + tail_w
            tip_y = y + h * 3 // 4
            pts = [(x + w - 2, tip_y - tail_h // 2), (x + w - 2, tip_y + tail_h // 2), (tip_x, tip_y)]
        else:
            tip_x = x - tail_w
            tip_y = y + h * 3 // 4
            pts = [(x + 2, tip_y - tail_h // 2), (x + 2, tip_y + tail_h // 2), (tip_x, tip_y)]
        draw.polygon(pts, fill=fill, outline=outline)

    elif shape in ("speech_bottom", "speech_top"):
        draw.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill, outline=outline, width=lw)
        tail_h = h // 4
        tail_w = w // 5
        cx = x + w // 2
        if shape == "speech_bottom":
            pts = [(cx - tail_w // 2, y + h - 2), (cx + tail_w // 2, y + h - 2), (cx, y + h + tail_h)]
        else:
            pts = [(cx - tail_w // 2, y + 2), (cx + tail_w // 2, y + 2), (cx, y - tail_h)]
        draw.polygon(pts, fill=fill, outline=None)

    elif shape == "cloud":
        # Rounded body + bumps along the top
        body_top = y + h * 2 // 5
        draw.rounded_rectangle([x, body_top, x + w, y + h], radius=min(r, h // 4), fill=fill, outline=None)
        num_bumps = max(3, w // 60)
        bump_r = (w // (num_bumps * 2))
        for i in range(num_bumps):
            bx = int(x + bump_r + i * (w - bump_r * 2) / max(num_bumps - 1, 1))
            by = body_top
            draw.ellipse([bx - bump_r, by - bump_r, bx + bump_r, by + bump_r], fill=fill)
        if outline:
            draw.rounded_rectangle([x, body_top, x + w, y + h], radius=min(r, h // 4),
                                   outline=outline, width=lw, fill=None)

    elif shape == "star":
        cx, cy = x + w // 2, y + h // 2
        outer = min(w, h) // 2
        inner = outer * 2 // 5
        pts = []
        for i in range(10):
            angle = math.pi / 2 + i * math.pi / 5
            ri = outer if i % 2 == 0 else inner
            pts.append((cx + ri * math.cos(angle), cy - ri * math.sin(angle)))
        draw.polygon(pts, fill=fill, outline=outline)

    elif shape == "heart":
        # Two upper circles + lower triangle
        hw = w // 2
        hh = int(h * 0.55)
        draw.ellipse([x, y, x + hw + 4, y + hh * 2], fill=fill)
        draw.ellipse([x + hw - 4, y, x + w, y + hh * 2], fill=fill)
        draw.polygon([(x, y + hh), (x + w, y + hh), (x + w // 2, y + h)], fill=fill)

    elif shape == "diamond":
        cx, cy = x + w // 2, y + h // 2
        draw.polygon([(cx, y), (x + w, cy), (cx, y + h), (x, cy)], fill=fill, outline=outline)


def _wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    """Wrap text to fit within max_width pixels."""
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            test = current + char
            bbox = draw.textbbox((0, 0), test, font=font)
            if bbox[2] - bbox[0] > max_width and current:
                lines.append(current)
                current = char
            else:
                current = test
        if current:
            lines.append(current)
    return lines


# ── 各元素類型的獨立渲染 helper ──────────────────────────────────────────────────

def _render_photo_slot(canvas: Image.Image, slot: dict, photos: dict, page_index: int, slot_index: int = 0) -> None:
    """渲染單一照片格（有照片則合成，否則繪製佔位框）。"""
    slot_id = str(slot["id"])
    photo_val = photos.get(slot_id)
    sx, sy, sw, sh = slot["x"], slot["y"], slot["width"], slot["height"]
    border = slot.get("border", True)
    border_w = slot.get("border_width", 8)
    slot_radius = slot.get("border_radius", 0)
    rotation = slot.get("rotation", 0)
    _sh_raw = slot.get("shadow_enabled")
    sh_enabled = border if _sh_raw is None else _sh_raw
    sh_ox = slot.get("shadow_offset_x", 5)
    sh_oy = slot.get("shadow_offset_y", 8)
    sh_blur = slot.get("shadow_blur", 14)
    sh_opacity = slot.get("shadow_opacity", 120)

    if not photo_val:
        # 繪製空白佔位框
        draw = ImageDraw.Draw(canvas, "RGBA")
        if border:
            frame = Image.new("RGBA", (sw, sh), (255, 255, 255, 255))
            fd = ImageDraw.Draw(frame)
            ix1, iy1 = border_w, border_w
            ix2, iy2 = sw - border_w, sh - border_w * 2
            inner_r = max(0, slot_radius - border_w)
            if inner_r > 0:
                fd.rounded_rectangle([ix1, iy1, ix2, iy2], radius=inner_r, fill="#EEEEEE")
            else:
                fd.rectangle([ix1, iy1, ix2, iy2], fill="#EEEEEE")
            fd.rectangle([0, 0, sw - 1, sh - 1], outline="#C8CDD8", width=1)
            mid_x, mid_y = (ix1 + ix2) // 2, (iy1 + iy2) // 2
            fd.text((mid_x, mid_y), f"P{page_index+1}·{slot_index+1}", fill="#AAAAAA",
                    font=_get_font(14), anchor="mm")
            frame = _apply_rounded_corners(frame, slot_radius)
            if sh_enabled:
                frame = _add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                         shadow_color=(0, 0, 0, sh_opacity))
            _paste_rotated(canvas, frame, sx + sw / 2, sy + sh / 2, rotation)
        else:
            if sh_enabled:
                frame = Image.new("RGBA", (sw, sh), (0xEE, 0xEE, 0xEE, 255))
                fd2 = ImageDraw.Draw(frame)
                fd2.rectangle([0, 0, sw - 1, sh - 1], outline="#CCCCCC", width=2)
                mid_x2, mid_y2 = sw // 2, sh // 2
                fd2.text((mid_x2, mid_y2), f"P{page_index+1}·{slot_index+1}", fill="#AAAAAA",
                         font=_get_font(16), anchor="mm")
                frame = _apply_rounded_corners(frame, slot_radius)
                frame = _add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                        shadow_color=(0, 0, 0, sh_opacity))
                _paste_rotated(canvas, frame, sx + sw / 2, sy + sh / 2, rotation)
            else:
                draw.rectangle([sx, sy, sx + sw, sy + sh], fill="#EEEEEE", outline="#CCCCCC", width=2)
                draw.text((sx + sw // 2, sy + sh // 2), f"P{page_index+1}·{slot_index+1}", fill="#AAAAAA",
                          font=_get_font(16), anchor="mm")
        return

    # 解析照片資料（支援路徑字串與含位移縮放的 dict）
    if isinstance(photo_val, dict):
        photo_path = photo_val.get("path", "")
        user_scale = float(photo_val.get("scale", 1.0))
        offset_x   = float(photo_val.get("offset_x", 0.0))
        offset_y   = float(photo_val.get("offset_y", 0.0))
    else:
        photo_path = photo_val
        user_scale, offset_x, offset_y = 1.0, 0.0, 0.0

    if not photo_path:
        return

    try:
        img = _load_key(photo_path)
        if img is None:
            return
        img = img.convert("RGBA")
    except Exception:
        return

    def _cover_crop(img, box_w, box_h, u_scale, ox, oy):
        ir = img.width / img.height
        br = box_w / box_h
        if ir > br:
            base_h = box_h
            base_w = int(box_h * ir)
        else:
            base_w = box_w
            base_h = int(box_w / ir)
        nw = max(box_w, int(base_w * u_scale))
        nh = max(box_h, int(base_h * u_scale))
        img = img.resize((nw, nh), Image.LANCZOS)
        avail_x = nw - box_w
        avail_y = nh - box_h
        cx = int(avail_x * (0.5 + ox * 0.5))
        cy = int(avail_y * (0.5 + oy * 0.5))
        cx = max(0, min(cx, avail_x))
        cy = max(0, min(cy, avail_y))
        return img.crop((cx, cy, cx + box_w, cy + box_h))

    if border:
        inner_w = sw - border_w * 2
        inner_h = sh - border_w * 2 - border_w * 2
        photo = _cover_crop(img, inner_w, inner_h, user_scale, offset_x, offset_y)
        inner_r = max(0, slot_radius - border_w)
        if inner_r > 0:
            photo = _apply_rounded_corners(photo, inner_r)
        frame = Image.new("RGBA", (sw, sh), (255, 255, 255, 255))
        frame.paste(photo, (border_w, border_w), photo)
        frame = _apply_rounded_corners(frame, slot_radius)
        if sh_enabled:
            img = _add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                   shadow_color=(0, 0, 0, sh_opacity))
        else:
            img = frame
    else:
        img = _cover_crop(img, sw, sh, user_scale, offset_x, offset_y)
        img = _apply_rounded_corners(img.convert("RGBA"), slot_radius)
        if sh_enabled:
            img = _add_drop_shadow(img, offset=(sh_ox, sh_oy), blur=sh_blur,
                                   shadow_color=(0, 0, 0, sh_opacity))

    _paste_rotated(canvas, img, sx + sw / 2, sy + sh / 2, rotation)


def _render_sticker(canvas: Image.Image, sticker: dict) -> None:
    """渲染貼圖素材。"""
    stkr_path_str = sticker.get("path", "")
    if not stkr_path_str:
        return
    try:
        stkr_img = _load_key(stkr_path_str)
        if stkr_img is None:
            return
        stkr_img = stkr_img.convert("RGBA")
        sw, sh = int(sticker["width"]), int(sticker["height"])
        stkr_img = stkr_img.resize((sw, sh), Image.LANCZOS)
        cx = sticker["x"] + sw / 2
        cy = sticker["y"] + sh / 2
        _paste_rotated(canvas, stkr_img, cx, cy, sticker.get("rotation", 0))
    except Exception:
        return


def _render_text_label(canvas: Image.Image, label: dict, student_name: str) -> None:
    """渲染純文字區塊（無背景）。"""
    label_text = label.get("text", "").replace("{name}", student_name)
    if not label_text:
        return
    font_size = label.get("font_size", 24)
    font_color = label.get("font_color", "#333333")
    font = _get_font(font_size, label.get("font_family"))
    line_height_px = int(font_size * label.get("line_height", 1.4))
    lw, lh = int(label["width"]), int(label["height"])
    rotation = label.get("rotation", 0)
    text_align = label.get("text_align", "center")
    draw = ImageDraw.Draw(canvas, "RGBA")
    lines = _wrap_text(label_text, font, lw, draw)
    total_h = len(lines) * line_height_px

    if rotation:
        diag = int(math.sqrt(lw**2 + lh**2)) + 4
        pad = (diag - min(lw, lh)) // 2 + 2
        tmp = Image.new("RGBA", (lw + pad * 2, lh + pad * 2), (0, 0, 0, 0))
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        tmp_y = pad + (lh - total_h) // 2
        for i, line in enumerate(lines):
            ty = tmp_y + i * line_height_px
            if text_align == "left":
                tmp_draw.text((pad, ty), line, fill=font_color, font=font, anchor="lt")
            elif text_align == "right":
                tmp_draw.text((pad + lw, ty), line, fill=font_color, font=font, anchor="rt")
            else:
                tmp_draw.text((pad + lw // 2, ty), line, fill=font_color, font=font, anchor="mt")
        _paste_rotated(canvas, tmp, label["x"] + lw / 2, label["y"] + lh / 2, rotation)
        return

    start_y = label["y"] + (lh - total_h) // 2
    for i, line in enumerate(lines):
        ty = start_y + i * line_height_px
        if text_align == "left":
            draw.text((label["x"], ty), line, fill=font_color, font=font, anchor="lt")
        elif text_align == "right":
            draw.text((label["x"] + lw, ty), line, fill=font_color, font=font, anchor="rt")
        else:
            draw.text((label["x"] + lw // 2, ty), line, fill=font_color, font=font, anchor="mt")


def _render_text_bubble(canvas: Image.Image, bubble: dict, bubble_texts: dict, student_name: str) -> None:
    """渲染氣泡框（含背景與文字）。"""
    bubble_id = str(bubble["id"])
    raw_text = bubble_texts.get(bubble_id, bubble.get("text", ""))
    text = raw_text.replace("{name}", student_name)
    rotation = bubble.get("rotation", 0)
    font_size = bubble.get("font_size", 20)
    font_color = bubble.get("font_color", "#333333")
    font = _get_font(font_size, bubble.get("font_family"))
    line_height = int(font_size * bubble.get("line_height", 1.4))
    bw_px, bh_px = int(bubble["width"]), int(bubble["height"])
    draw = ImageDraw.Draw(canvas, "RGBA")

    if rotation:
        diag = int(math.sqrt(bw_px**2 + bh_px**2)) + 4
        pad_img = (diag - min(bw_px, bh_px)) // 2 + 2
        tmp_w, tmp_h = bw_px + pad_img * 2, bh_px + pad_img * 2
        tmp = Image.new("RGBA", (tmp_w, tmp_h), (0, 0, 0, 0))
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        shifted = {**bubble, "x": pad_img, "y": pad_img}
        _draw_speech_bubble(tmp_draw, shifted)
        txt_pad = 14
        lines = _wrap_text(text, font, bw_px - txt_pad * 2, tmp_draw)
        total_h = len(lines) * line_height
        ty = pad_img + (bh_px - total_h) // 2
        for i, line in enumerate(lines):
            tmp_draw.text((pad_img + bw_px // 2, ty + i * line_height), line,
                          fill=font_color, font=font, anchor="mt")
        _paste_rotated(canvas, tmp, bubble["x"] + bw_px / 2, bubble["y"] + bh_px / 2, rotation)
        return

    _draw_speech_bubble(draw, bubble)
    pad = 14
    max_text_w = bubble["width"] - pad * 2
    lines = _wrap_text(text, font, max_text_w, draw)
    total_text_h = len(lines) * line_height
    text_start_y = bubble["y"] + (bubble["height"] - total_text_h) // 2
    for i, line in enumerate(lines):
        draw.text((bubble["x"] + bubble["width"] // 2, text_start_y + i * line_height),
                  line, fill=font_color, font=font, anchor="mt")


# 各元素類型未設定 z_index 時的預設基底（維持向後相容的渲染順序）
_TYPE_Z_BASE = {"photo": 0, "bubble": 100, "text": 200, "sticker": 300}


def render_page(layout: dict, student_name: str, page_data: dict, output_size: tuple = (794, 1123), page_index: int = 0) -> Image.Image:
    """Render one album page and return a PIL Image."""
    w, h = layout.get("canvas_width", output_size[0]), layout.get("canvas_height", output_size[1])
    canvas = Image.new("RGB", (w, h), "white")

    # 1. Background
    bg_filename = layout.get("background_filename")
    if bg_filename:
        bg = _load_key(bg_filename)
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
            _render_photo_slot(canvas, elem_data, photos, page_index, slot_index=elem_index)
        elif elem_type == "bubble":
            _render_text_bubble(canvas, elem_data, bubble_texts, student_name)
        elif elem_type == "text":
            _render_text_label(canvas, elem_data, student_name)
        elif elem_type == "sticker":
            _render_sticker(canvas, elem_data)
        draw = ImageDraw.Draw(canvas, "RGBA")  # 每個元素繪製後重建 draw

    # 3. Footer
    footer = layout.get("footer")
    if footer and footer.get("text"):
        ft = footer["text"].replace("{name}", student_name)
        ff = _get_font(footer.get("font_size", 22))
        draw.text((footer.get("x", w // 2), footer.get("y", h - 50)),
                  ft, fill=footer.get("font_color", "#3B6B8C"), font=ff, anchor="lm")

    # 5. Logo
    logo = layout.get("logo")
    if logo and logo.get("filename"):
        try:
            lg = _load_key(f"logos/{logo['filename']}")
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
