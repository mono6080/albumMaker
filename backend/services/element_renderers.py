# 各元素類型的獨立 PIL 渲染 helper

import math

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

from services.draw_helpers import (
    get_font, load_key, paste_rotated,
    apply_rounded_corners, add_drop_shadow,
    draw_speech_bubble, wrap_text,
    _line_width_with_spacing, draw_line_with_spacing,
)
from services.label_texts import get_label_entry_align, get_label_entry_text


def _clamp_int(value, default: int, min_value: int, max_value: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        number = default
    return max(min_value, min(number, max_value))


def _text_shadow_settings(element: dict) -> dict | None:
    if not element.get("text_shadow_enabled"):
        return None

    opacity = _clamp_int(element.get("text_shadow_opacity", 120), 120, 0, 255)
    if opacity <= 0:
        return None

    try:
        rgb = ImageColor.getrgb(str(element.get("text_shadow_color") or "#000000"))
        red, green, blue = rgb[:3]
    except (TypeError, ValueError):
        red, green, blue = 0, 0, 0

    return {
        "color": (red, green, blue, opacity),
        "offset_x": _clamp_int(element.get("text_shadow_offset_x", 3), 3, -200, 200),
        "offset_y": _clamp_int(element.get("text_shadow_offset_y", 3), 3, -200, 200),
        "blur": _clamp_int(element.get("text_shadow_blur", 4), 4, 0, 200),
    }


def _composite_rgba_layer(target: Image.Image, layer: Image.Image) -> None:
    if layer.getbbox() is None:
        return
    if target.mode == "RGBA":
        target.alpha_composite(layer)
        return
    target.paste(layer, (0, 0), layer)


def _visual_line_vertical_offset(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    font: ImageFont.FreeTypeFont,
    line_height_px: int,
) -> int:
    """補償 PIL anchor top 與 Konva verticalAlign='middle' 的視覺置中差異。"""
    ref_text = next((line for line in lines if line), "A")
    bbox = draw.textbbox((0, 0), ref_text, font=font, anchor="lt")
    visual_height = bbox[3] - bbox[1]
    return int(round((line_height_px - visual_height) / 2))


def render_photo_slot(canvas: Image.Image, slot: dict, photos: dict, page_index: int, slot_index: int = 0) -> None:
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
                    font=get_font(14), anchor="mm")
            frame = apply_rounded_corners(frame, slot_radius)
            if sh_enabled:
                frame = add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                        shadow_color=(0, 0, 0, sh_opacity))
            paste_rotated(canvas, frame, sx + sw / 2, sy + sh / 2, rotation)
        else:
            if sh_enabled:
                frame = Image.new("RGBA", (sw, sh), (0xEE, 0xEE, 0xEE, 255))
                fd2 = ImageDraw.Draw(frame)
                fd2.rectangle([0, 0, sw - 1, sh - 1], outline="#CCCCCC", width=2)
                mid_x2, mid_y2 = sw // 2, sh // 2
                fd2.text((mid_x2, mid_y2), f"P{page_index+1}·{slot_index+1}", fill="#AAAAAA",
                         font=get_font(16), anchor="mm")
                frame = apply_rounded_corners(frame, slot_radius)
                frame = add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                       shadow_color=(0, 0, 0, sh_opacity))
                paste_rotated(canvas, frame, sx + sw / 2, sy + sh / 2, rotation)
            else:
                draw.rectangle([sx, sy, sx + sw, sy + sh], fill="#EEEEEE", outline="#CCCCCC", width=2)
                draw.text((sx + sw // 2, sy + sh // 2), f"P{page_index+1}·{slot_index+1}", fill="#AAAAAA",
                          font=get_font(16), anchor="mm")
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
        img = load_key(photo_path)
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
            photo = apply_rounded_corners(photo, inner_r)
        frame = Image.new("RGBA", (sw, sh), (255, 255, 255, 255))
        frame.paste(photo, (border_w, border_w), photo)
        frame = apply_rounded_corners(frame, slot_radius)
        if sh_enabled:
            img = add_drop_shadow(frame, offset=(sh_ox, sh_oy), blur=sh_blur,
                                  shadow_color=(0, 0, 0, sh_opacity))
        else:
            img = frame
    else:
        img = _cover_crop(img, sw, sh, user_scale, offset_x, offset_y)
        img = apply_rounded_corners(img.convert("RGBA"), slot_radius)
        if sh_enabled:
            img = add_drop_shadow(img, offset=(sh_ox, sh_oy), blur=sh_blur,
                                  shadow_color=(0, 0, 0, sh_opacity))

    paste_rotated(canvas, img, sx + sw / 2, sy + sh / 2, rotation)


def render_sticker(canvas: Image.Image, sticker: dict) -> None:
    """渲染貼圖素材。直接從 storage 開啟以保留透明通道，不經 to_srgb 轉換。"""
    stkr_path_str = sticker.get("path", "")
    if not stkr_path_str:
        return
    try:
        from services.storage import get_storage
        storage = get_storage()
        stkr_img = storage.open_image(stkr_path_str).convert("RGBA")
        sw, sh = int(sticker["width"]), int(sticker["height"])
        stkr_img = stkr_img.resize((sw, sh), Image.LANCZOS)
        cx = sticker["x"] + sw / 2
        cy = sticker["y"] + sh / 2
        paste_rotated(canvas, stkr_img, cx, cy, sticker.get("rotation", 0))
    except Exception:
        return


def _text_label_is_fillable(label: dict) -> bool:
    role = label.get("text_role", label.get("textRole"))
    if role == "static" or label.get("editable") is False:
        return False
    return True


def render_text_label(canvas: Image.Image, label: dict, label_texts: dict, student_name: str) -> None:
    """渲染文字方塊（無背景）；固定文字會忽略專案 / 學生覆寫。"""
    label_id = str(label.get("id", ""))
    label_entry = label_texts.get(label_id) if _text_label_is_fillable(label) else None
    raw_text = get_label_entry_text(label_entry)
    if raw_text is None:
        raw_text = label.get("text", "")
    label_text = raw_text.replace("{name}", student_name)
    if not label_text:
        return
    font_size = label.get("font_size", 24)
    font_color = label.get("font_color", "#333333")
    font = get_font(font_size, label.get("font_family"))
    line_height_px = int(font_size * label.get("line_height", 1.4))
    letter_spacing = int(label.get("letter_spacing", 0))
    lw, lh = int(label["width"]), int(label["height"])
    rotation = label.get("rotation", 0)
    text_align = get_label_entry_align(label_entry, label.get("text_align", "center"))
    shadow = _text_shadow_settings(label)
    draw = ImageDraw.Draw(canvas, "RGBA")
    lines = wrap_text(label_text, font, lw, draw, letter_spacing)
    total_h = len(lines) * line_height_px

    def _draw_line(target_draw: ImageDraw.ImageDraw, tx: int, ty: int, line: str, fill) -> None:
        """依對齊方式計算起始 x 並逐字繪製（含字間距）。"""
        if letter_spacing == 0:
            if text_align == "left":
                target_draw.text((tx, ty), line, fill=fill, font=font, anchor="lt")
            elif text_align == "right":
                target_draw.text((tx + lw, ty), line, fill=fill, font=font, anchor="rt")
            else:
                target_draw.text((tx + lw // 2, ty), line, fill=fill, font=font, anchor="mt")
        else:
            line_w = _line_width_with_spacing(target_draw, line, font, letter_spacing)
            if text_align == "left":
                start_x = tx
            elif text_align == "right":
                start_x = tx + lw - line_w
            else:
                start_x = tx + (lw - line_w) // 2
            draw_line_with_spacing(target_draw, start_x, ty, line, font, fill, letter_spacing)

    def _draw_lines(target_draw: ImageDraw.ImageDraw, tx: int, ty: int, fill) -> None:
        for line_index, line in enumerate(lines):
            _draw_line(target_draw, tx, ty + line_index * line_height_px, line, fill)

    def _draw_shadow(target: Image.Image, tx: int, ty: int) -> None:
        if not shadow:
            return
        shadow_layer = Image.new("RGBA", target.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer, "RGBA")
        _draw_lines(
            shadow_draw,
            tx + shadow["offset_x"],
            ty + shadow["offset_y"],
            shadow["color"],
        )
        if shadow["blur"] > 0:
            shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(shadow["blur"]))
        _composite_rgba_layer(target, shadow_layer)

    visual_v_offset = _visual_line_vertical_offset(draw, lines, font, line_height_px)

    if rotation:
        diag = int(math.sqrt(lw**2 + lh**2)) + 4
        pad = (diag - min(lw, lh)) // 2 + 2
        tmp = Image.new("RGBA", (lw + pad * 2, lh + pad * 2), (0, 0, 0, 0))
        tmp_y = pad + (lh - total_h) // 2 + visual_v_offset
        _draw_shadow(tmp, pad, tmp_y)
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        _draw_lines(tmp_draw, pad, tmp_y, font_color)
        paste_rotated(canvas, tmp, label["x"] + lw / 2, label["y"] + lh / 2, rotation)
        return

    start_y = label["y"] + (lh - total_h) // 2 + visual_v_offset
    _draw_shadow(canvas, label["x"], start_y)
    draw = ImageDraw.Draw(canvas, "RGBA")
    _draw_lines(draw, label["x"], start_y, font_color)


def render_text_bubble(canvas: Image.Image, bubble: dict, student_name: str) -> None:
    """渲染氣泡框（含背景與文字），使用模板內定義的文字。"""
    raw_text = bubble.get("text", "")
    text = raw_text.replace("{name}", student_name)
    rotation = bubble.get("rotation", 0)
    font_size = bubble.get("font_size", 20)
    font_color = bubble.get("font_color", "#333333")
    font = get_font(font_size, bubble.get("font_family"))
    line_height = int(font_size * bubble.get("line_height", 1.4))
    bw_px, bh_px = int(bubble["width"]), int(bubble["height"])
    shadow = _text_shadow_settings(bubble)
    draw = ImageDraw.Draw(canvas, "RGBA")

    def _draw_bubble_text(target_draw: ImageDraw.ImageDraw, center_x: int, ty: int,
                          lines: list[str], fill) -> None:
        for line_index, line in enumerate(lines):
            target_draw.text(
                (center_x, ty + line_index * line_height),
                line,
                fill=fill,
                font=font,
                anchor="mt",
            )

    def _draw_bubble_text_shadow(target: Image.Image, center_x: int, ty: int, lines: list[str]) -> None:
        if not shadow:
            return
        shadow_layer = Image.new("RGBA", target.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer, "RGBA")
        _draw_bubble_text(
            shadow_draw,
            center_x + shadow["offset_x"],
            ty + shadow["offset_y"],
            lines,
            shadow["color"],
        )
        if shadow["blur"] > 0:
            shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(shadow["blur"]))
        _composite_rgba_layer(target, shadow_layer)

    if rotation:
        diag = int(math.sqrt(bw_px**2 + bh_px**2)) + 4
        pad_img = (diag - min(bw_px, bh_px)) // 2 + 2
        tmp_w, tmp_h = bw_px + pad_img * 2, bh_px + pad_img * 2
        tmp = Image.new("RGBA", (tmp_w, tmp_h), (0, 0, 0, 0))
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        shifted = {**bubble, "x": pad_img, "y": pad_img}
        draw_speech_bubble(tmp_draw, shifted)
        txt_pad = 14
        lines = wrap_text(text, font, bw_px - txt_pad * 2, tmp_draw)
        total_h = len(lines) * line_height
        ty = pad_img + (bh_px - total_h) // 2
        _draw_bubble_text_shadow(tmp, pad_img + bw_px // 2, ty, lines)
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        _draw_bubble_text(tmp_draw, pad_img + bw_px // 2, ty, lines, font_color)
        paste_rotated(canvas, tmp, bubble["x"] + bw_px / 2, bubble["y"] + bh_px / 2, rotation)
        return

    draw_speech_bubble(draw, bubble)
    pad = 14
    max_text_w = bubble["width"] - pad * 2
    lines = wrap_text(text, font, max_text_w, draw)
    total_text_h = len(lines) * line_height
    text_start_y = bubble["y"] + (bubble["height"] - total_text_h) // 2
    _draw_bubble_text_shadow(canvas, bubble["x"] + bubble["width"] // 2, text_start_y, lines)
    draw = ImageDraw.Draw(canvas, "RGBA")
    _draw_bubble_text(draw, bubble["x"] + bubble["width"] // 2, text_start_y, lines, font_color)
