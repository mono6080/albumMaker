# 各元素類型的獨立 PIL 渲染 helper

import math

from PIL import Image, ImageColor, ImageDraw, ImageFilter

from services.draw_helpers import (
    get_font, load_key_for_box, paste_rotated,
    apply_rounded_corners, add_drop_shadow,
    draw_line_with_spacing,
)
from services.label_texts import (
    get_label_entry_align,
    get_label_entry_text,
)
from services.photo_frame_geometry import get_photo_frame_insets
from services.photo_transform_policy import PHOTO_SCALE_MAX
from services.render_image_loader import (
    STICKER_SOURCE_PIXEL_LIMIT,
    open_bounded_storage_image,
)
from services.text_layout import TEXT_LAYOUT_MEASUREMENT_SCALE, layout_text_label
from services.text_variables import resolve_student_text_variables


def _clamp_int(value, default: int, min_value: int, max_value: int) -> int:
    try:
        number = int(round(float(value)))
    except (OverflowError, TypeError, ValueError):
        number = default
    return max(min_value, min(number, max_value))


def _clamp_float(
    value,
    default: float,
    min_value: float,
    max_value: float,
) -> float:
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        number = default
    if not math.isfinite(number):
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


def render_photo_slot(canvas: Image.Image, slot: dict, photos: dict, page_index: int, slot_index: int = 0) -> None:
    """渲染單一照片格（有照片則合成，否則繪製佔位框）。"""
    slot_id = str(slot["id"])
    photo_val = photos.get(slot_id)
    sx, sy, sw, sh = slot["x"], slot["y"], slot["width"], slot["height"]
    # 邊框與內容框一律由 photo_frame_geometry 推導（拍立得底邊比例的唯一真相來源，
    # 前端 photoFrameGeometry.js 為跨語言鏡像）
    insets = get_photo_frame_insets(slot)
    border = insets["has_border"]
    border_w = int(round(insets["border_width"]))
    content_w = max(1, sw - int(round(insets["left"] + insets["right"])))
    content_h = max(1, sh - int(round(insets["top"] + insets["bottom"])))
    slot_radius = _clamp_int(slot.get("border_radius", 0), 0, 0, max(sw, sh))
    rotation = slot.get("rotation", 0)
    _sh_raw = slot.get("shadow_enabled")
    sh_enabled = border if _sh_raw is None else _sh_raw
    sh_ox = _clamp_int(slot.get("shadow_offset_x", 5), 5, -200, 200)
    sh_oy = _clamp_int(slot.get("shadow_offset_y", 8), 8, -200, 200)
    sh_blur = _clamp_int(slot.get("shadow_blur", 14), 14, 0, 200)
    sh_opacity = _clamp_int(slot.get("shadow_opacity", 120), 120, 0, 255)

    if not photo_val:
        # 繪製空白佔位框
        draw = ImageDraw.Draw(canvas, "RGBA")
        if border:
            frame = Image.new("RGBA", (sw, sh), (255, 255, 255, 255))
            fd = ImageDraw.Draw(frame)
            inner_w, inner_h = content_w, content_h
            ix1, iy1 = border_w, border_w
            ix2, iy2 = ix1 + inner_w - 1, iy1 + inner_h - 1
            inner_r = max(0, slot_radius - border_w)
            if inner_r > 0:
                fd.rounded_rectangle([ix1, iy1, ix2, iy2], radius=inner_r, fill="#EEEEEE")
            else:
                fd.rectangle([ix1, iy1, ix2, iy2], fill="#EEEEEE")
            fd.rectangle([0, 0, sw - 1, sh - 1], outline="#C8CDD8", width=1)
            mid_x, mid_y = ix1 + inner_w // 2, iy1 + inner_h // 2
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

    # 解析照片資料（支援路徑字串與含位移縮放/亮度對比的 dict）
    if isinstance(photo_val, dict):
        photo_path = photo_val.get("path", "")
        user_scale = _clamp_float(
            photo_val.get("scale", 1.0),
            1.0,
            0.1,
            PHOTO_SCALE_MAX,
        )
        offset_x = _clamp_float(photo_val.get("offset_x", 0.0), 0.0, -10.0, 10.0)
        offset_y = _clamp_float(photo_val.get("offset_y", 0.0), 0.0, -10.0, 10.0)
        user_brightness = _clamp_float(
            photo_val.get("brightness", 1.0),
            1.0,
            0.1,
            3.0,
        )
        user_contrast = _clamp_float(
            photo_val.get("contrast", 1.0),
            1.0,
            0.1,
            3.0,
        )
    else:
        photo_path = photo_val
        user_scale, offset_x, offset_y = 1.0, 0.0, 0.0
        user_brightness, user_contrast = 1.0, 1.0

    if not photo_path:
        return

    # content_w/content_h（照片實際要填的內容框）已於函式開頭由 insets 推得，
    # 讓載入器能「先粗縮、再轉色」
    try:
        img = load_key_for_box(
            photo_path,
            content_w,
            content_h,
            user_scale,
            offset_x,
            offset_y,
        )
        if img is None:
            return
        img = img.convert("RGBA")
    except Exception:
        return

    def _apply_photo_adjustments(photo_img, brightness, contrast):
        """亮度/對比調整。公式與前端 CSS filter 完全一致：
        brightness 為線性乘法、contrast 以 127.5 為樞軸（CSS contrast() 的
        intercept 是 [0,1] 值域的 0.5，換算 8-bit 為 127.5，不是 128）。
        依 CSS filter 串接順序先亮度後對比，且瀏覽器會在兩個 filter 函式之間
        把中間結果 clamp 回 [0,255] 才送進下一個函式，這裡必須比照，否則
        brightness > 1 與 contrast < 1 疊加時 PDF 會比預覽亮。只調整 RGB，保留 alpha。"""
        if brightness == 1.0 and contrast == 1.0:
            return photo_img
        lut = []
        for value in range(256):
            adjusted = max(0.0, min(255.0, value * brightness))
            adjusted = (adjusted - 127.5) * contrast + 127.5
            lut.append(max(0, min(255, int(round(adjusted)))))
        red, green, blue, alpha = photo_img.split()
        return Image.merge("RGBA", (red.point(lut), green.point(lut), blue.point(lut), alpha))

    if border:
        photo = img
        photo = _apply_photo_adjustments(photo, user_brightness, user_contrast)
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
        img = _apply_photo_adjustments(img, user_brightness, user_contrast)
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
        sw = max(1, int(round(float(sticker["width"]))))
        sh = max(1, int(round(float(sticker["height"]))))
        stkr_img = open_bounded_storage_image(
            storage,
            stkr_path_str,
            target_size=(sw, sh),
            fit="exact",
            source_pixel_limit=STICKER_SOURCE_PIXEL_LIMIT,
        ).convert("RGBA")
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


def render_text_label(
    canvas: Image.Image,
    label: dict,
    label_texts: dict,
    student_name: str,
    *,
    album_name: str | None = None,
    clip_overflow: bool = True,
) -> None:
    """渲染文字方塊（無背景）；固定文字會忽略專案 / 學生覆寫。"""
    label_id = str(label.get("id", ""))
    label_entry = label_texts.get(label_id) if _text_label_is_fillable(label) else None
    raw_text = get_label_entry_text(label_entry)
    if raw_text is None:
        raw_text = label.get("text", "")
    label_text = resolve_student_text_variables(
        raw_text,
        student_name,
        album_name,
    )
    if not label_text:
        return
    font_size = float(label.get("font_size", 24))
    font_color = label.get("font_color", "#333333")
    font = get_font(font_size, label.get("font_family"))
    letter_spacing = float(label.get("letter_spacing", 0))
    frame_width = float(label["width"])
    frame_height = float(label["height"])
    layer_width = max(1, int(round(frame_width)))
    layer_height = max(1, int(round(frame_height)))
    rotation = label.get("rotation", 0)
    text_align = get_label_entry_align(label_entry, label.get("text_align", "center"))
    shadow = _text_shadow_settings(label)

    source = label.get("_text_layout_source")
    if not isinstance(source, dict):
        source = label
    source_width = float(source.get("width", frame_width))
    source_height = float(source.get("height", frame_height))
    source_font_size = float(source.get("font_size", font_size))
    measurement_scale = TEXT_LAYOUT_MEASUREMENT_SCALE
    source_font = get_font(
        source_font_size * measurement_scale,
        source.get("font_family"),
    )
    source_layout = layout_text_label(
        label_text,
        font=source_font,
        box_width=source_width * measurement_scale,
        box_height=source_height * measurement_scale,
        font_size=source_font_size * measurement_scale,
        line_height=float(source.get("line_height", label.get("line_height", 1.4))),
        letter_spacing=(
            float(source.get("letter_spacing", label.get("letter_spacing", 0)))
            * measurement_scale
        ),
        text_align=text_align,
        clip_overflow=clip_overflow,
    )
    horizontal_scale = frame_width / source_width
    vertical_scale = frame_height / source_height
    line_x_positions = [
        line_x / measurement_scale * horizontal_scale
        for line_x in source_layout.line_x_positions
    ]
    line_baselines = [
        baseline / measurement_scale * vertical_scale
        for baseline in source_layout.line_baselines
    ]

    def _draw_line(
        target_draw: ImageDraw.ImageDraw,
        start_x: float,
        baseline_y: float,
        line: str,
        fill,
    ) -> None:
        if letter_spacing == 0:
            target_draw.text(
                (start_x, baseline_y),
                line,
                fill=fill,
                font=font,
                anchor="ls",
            )
            return
        draw_line_with_spacing(
            target_draw,
            start_x,
            baseline_y,
            line,
            font,
            fill,
            letter_spacing,
        )

    def _draw_lines(
        target_draw: ImageDraw.ImageDraw,
        origin_x: float,
        origin_y: float,
        fill,
    ) -> None:
        for line, line_x, baseline in zip(
            source_layout.visible_lines,
            line_x_positions,
            line_baselines,
            strict=True,
        ):
            _draw_line(
                target_draw,
                origin_x + line_x,
                origin_y + baseline,
                line,
                fill,
            )

    def _draw_shadow(target: Image.Image, origin_x: float, origin_y: float) -> None:
        if not shadow:
            return
        shadow_layer = Image.new("RGBA", target.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer, "RGBA")
        _draw_lines(
            shadow_draw,
            origin_x + shadow["offset_x"],
            origin_y + shadow["offset_y"],
            shadow["color"],
        )
        if shadow["blur"] > 0:
            shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(shadow["blur"]))
        _composite_rgba_layer(target, shadow_layer)

    if clip_overflow:
        effect_padding = (
            shadow["blur"] * 2
            + max(abs(shadow["offset_x"]), abs(shadow["offset_y"]))
            if shadow
            else 0
        )
        working_layer = Image.new(
            "RGBA",
            (
                layer_width + effect_padding * 2,
                layer_height + effect_padding * 2,
            ),
            (0, 0, 0, 0),
        )
        _draw_shadow(working_layer, effect_padding, effect_padding)
        working_draw = ImageDraw.Draw(working_layer, "RGBA")
        _draw_lines(working_draw, effect_padding, effect_padding, font_color)
        label_layer = working_layer.crop(
            (
                effect_padding,
                effect_padding,
                effect_padding + layer_width,
                effect_padding + layer_height,
            )
        )
        if rotation:
            paste_rotated(
                canvas,
                label_layer,
                label["x"] + frame_width / 2,
                label["y"] + frame_height / 2,
                rotation,
            )
        else:
            canvas.paste(
                label_layer,
                (int(round(label["x"])), int(round(label["y"]))),
                label_layer,
            )
        return

    # 溢框稽核需要取得未裁切 glyph bbox；正式預覽／輸出不走這條路徑。
    if rotation:
        diag = int(math.sqrt(layer_width**2 + layer_height**2)) + 4
        pad = (diag - min(layer_width, layer_height)) // 2 + 2
        tmp = Image.new(
            "RGBA",
            (layer_width + pad * 2, layer_height + pad * 2),
            (0, 0, 0, 0),
        )
        _draw_shadow(tmp, pad, pad)
        tmp_draw = ImageDraw.Draw(tmp, "RGBA")
        _draw_lines(tmp_draw, pad, pad, font_color)
        paste_rotated(
            canvas,
            tmp,
            label["x"] + frame_width / 2,
            label["y"] + frame_height / 2,
            rotation,
        )
        return

    _draw_shadow(canvas, label["x"], label["y"])
    draw = ImageDraw.Draw(canvas, "RGBA")
    _draw_lines(draw, label["x"], label["y"], font_color)
