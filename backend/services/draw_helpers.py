# PIL 繪圖工具函式：字型載入、圖片合成、形狀繪製

import io
import math
import os
from typing import Optional

from PIL import Image, ImageCms, ImageDraw, ImageFilter, ImageFont

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


def to_srgb(img: Image.Image) -> Image.Image:
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


def load_key(key: str) -> Optional[Image.Image]:
    """從 storage 讀取圖片並轉為 sRGB，key 不存在時回傳 None。"""
    from services.storage import get_storage
    storage = get_storage()
    if not storage.exists(key):
        return None
    return to_srgb(storage.open_image(key))


def get_font(size: int, family: str = None) -> ImageFont.FreeTypeFont:
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


def paste_rotated(canvas: Image.Image, src: Image.Image, cx: float, cy: float, angle: float):
    """Paste src centered at (cx, cy) rotated by angle degrees."""
    rotated = src.rotate(-angle, expand=True, resample=Image.BICUBIC)
    px = int(cx - rotated.width / 2)
    py = int(cy - rotated.height / 2)
    if rotated.mode == "RGBA":
        canvas.paste(rotated, (px, py), rotated)
    else:
        canvas.paste(rotated, (px, py))


def apply_rounded_corners(img: Image.Image, radius: int) -> Image.Image:
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


def add_drop_shadow(img: Image.Image, offset=(4, 6), blur=10,
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
    # 直接覆蓋（不帶 mask），避免 PIL 對 alpha 做平方（alpha_out = alpha² / 255）
    combined.paste(shadow, (0, 0))
    combined.paste(img, (pad, pad), img)
    return combined


def draw_speech_bubble(draw: ImageDraw.ImageDraw, bubble: dict):
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


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int, draw: ImageDraw.ImageDraw, letter_spacing: int = 0) -> list[str]:
    """Wrap text to fit within max_width pixels, accounting for optional letter spacing."""
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            test = current + char
            bbox = draw.textbbox((0, 0), test, font=font)
            text_w = bbox[2] - bbox[0] + max(0, len(test) - 1) * letter_spacing
            if text_w > max_width and current:
                lines.append(current)
                current = char
            else:
                current = test
        if current:
            lines.append(current)
    return lines


def _line_width_with_spacing(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, letter_spacing: int) -> int:
    """回傳含字間距的行寬。"""
    if not text:
        return 0
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0] + max(0, len(text) - 1) * letter_spacing


def draw_line_with_spacing(draw: ImageDraw.ImageDraw, x: int, y: int, text: str,
                           font: ImageFont.FreeTypeFont, fill: str, letter_spacing: int) -> None:
    """從 (x, y) 開始逐字繪製，加入字間距。
    y 為 'lt' anchor 位置（文字框頂端）。
    內部改用 'la' anchor 確保標點與一般字元對齊同一 ascender line。
    """
    if not text:
        return
    # 將 lt y 換算成 la y：la_bbox[1] 是 la anchor 到 glyph 視覺頂端的距離
    la_bbox = draw.textbbox((0, 0), text, font=font, anchor="la")
    la_y = y - la_bbox[1]
    for char in text:
        draw.text((x, la_y), char, font=font, fill=fill, anchor="la")
        char_bbox = draw.textbbox((0, 0), char, font=font, anchor="la")
        x += char_bbox[2] - char_bbox[0] + letter_spacing
