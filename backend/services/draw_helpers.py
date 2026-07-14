# PIL 繪圖工具函式：字型載入、圖片合成、形狀繪製

import io
import os
from functools import lru_cache
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
# 跨語言鏡像：前端選單 frontend/src/constants/fonts.js 的每個 value 都必須在此有對應，
# 一致性由 tests/test_font_parity.py 釘住
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


@lru_cache(maxsize=32)
def _srgb_transform(icc_bytes: bytes, mode: str):
    """以 profile bytes＋mode 快取 ICC→sRGB transform。

    buildTransform 每次要解析 profile（實測 ~200ms），同一台相機的照片
    profile 完全相同，快取後整班照片只需付一次建置成本。
    """
    src_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_bytes))
    return ImageCms.buildTransformFromOpenProfiles(
        src_profile, _SRGB_PROFILE, mode, "RGB",
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
    )


def to_srgb(img: Image.Image) -> Image.Image:
    """將已開啟的 PIL Image 套用 ICC profile 並轉為 sRGB。"""
    icc = img.info.get("icc_profile")
    if icc:
        try:
            transform = _srgb_transform(bytes(icc), img.mode)
            return ImageCms.applyTransform(img, transform)
        except Exception:
            return img.convert("RGB")
    return img.convert("RGB")


def load_key(key: str) -> Optional[Image.Image]:
    """從 storage 讀取圖片並轉為 sRGB，key 不存在時回傳 None。"""
    from services.storage import get_storage
    storage = get_storage()
    try:
        return to_srgb(storage.open_image(key))
    except FileNotFoundError:
        return None


def load_key_for_box(key: str, box_w: int, box_h: int, user_scale: float = 1.0) -> Optional[Image.Image]:
    """讀取照片並「先粗縮、再轉色」，供照片格渲染使用。

    原圖常是 12-24MP（5-10MB），但照片格 cover 後只需要幾百 px：
    先用整數倍 reduce()（極快）把影像縮到目標的 ≥2 倍（保留 LANCZOS 的
    細縮空間、視覺上與全解析度縮放無差異），ICC 轉換因此在小圖上進行。
    單張成本從 ~600ms 降到 <100ms。
    """
    from services.storage import get_storage
    try:
        raw = get_storage().open_image(key)
    except FileNotFoundError:
        return None

    if raw.width > 0 and raw.height > 0 and box_w > 0 and box_h > 0:
        # cover-fit 需要的基準尺寸（與 _cover_crop 同公式）
        image_ratio = raw.width / raw.height
        box_ratio = box_w / box_h
        if image_ratio > box_ratio:
            base_w, base_h = box_h * image_ratio, box_h
        else:
            base_w, base_h = box_w, box_w / image_ratio
        need_w = max(1, int(base_w * max(user_scale, 0.01)))
        need_h = max(1, int(base_h * max(user_scale, 0.01)))
        factor = min(raw.width // (need_w * 2), raw.height // (need_h * 2))
        if factor >= 2:
            try:
                raw = raw.reduce(factor)
            except Exception:
                pass  # 少數模式（如調色盤圖）不支援 reduce，直接走原圖

    return to_srgb(raw)


@lru_cache(maxsize=128)
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
