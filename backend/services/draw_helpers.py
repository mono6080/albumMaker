# PIL 繪圖工具函式：字型載入、圖片合成、形狀繪製

import io
import math
import os
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import Image, ImageCms, ImageDraw, ImageFilter, ImageFont, ImageOps
from services.render_image_loader import (
    BACKGROUND_SOURCE_PIXEL_LIMIT,
    MAX_BOUNDED_DECODE_PIXELS,
    OversizedRenderImageError,
    open_bounded_storage_image,
    open_storage_image_source,
    validate_image_pixel_limit,
)

# 前後端共用的 OFL 可變字型。開發環境直接讀 public，Docker 則讀已 build 的 dist。
_REPO_ROOT = Path(__file__).resolve().parents[2]
_BUNDLED_FONT_DIRS = (
    _REPO_ROOT / "frontend" / "public" / "fonts",
    Path("/frontend/dist/fonts"),
)
BUNDLED_SANS_FONT_PATHS = tuple(
    str(font_dir / "NotoSansTC-VF.ttf")
    for font_dir in _BUNDLED_FONT_DIRS
)
BUNDLED_SERIF_FONT_PATHS = tuple(
    str(font_dir / "NotoSerifTC-VF.ttf")
    for font_dir in _BUNDLED_FONT_DIRS
)
BUNDLED_FONT_MANIFEST_PATHS = tuple(
    str(font_dir / "manifest.json")
    for font_dir in _BUNDLED_FONT_DIRS
)
_BUNDLED_VARIABLE_FONT_NAMES = {
    "NotoSansTC-VF.ttf",
    "NotoSerifTC-VF.ttf",
}
_BOLD_FONT_FAMILIES = {"msjhbd"}

# CJK 字型候選清單：bundled font 優先，系統字型只作遺失時的 fallback
CJK_FONTS = [
    *BUNDLED_SANS_FONT_PATHS,
    *BUNDLED_SERIF_FONT_PATHS,
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
    "msjh": (
        *BUNDLED_SANS_FONT_PATHS,
        "C:/Windows/Fonts/msjh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ),
    "msjhbd": (
        *BUNDLED_SANS_FONT_PATHS,
        "C:/Windows/Fonts/msjhbd.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    ),
    "mingliu": (
        *BUNDLED_SERIF_FONT_PATHS,
        "C:/Windows/Fonts/mingliu.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    ),
    "kaiu": (
        *BUNDLED_SERIF_FONT_PATHS,
        "C:/Windows/Fonts/kaiu.ttf",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    ),
    "simsun": (
        *BUNDLED_SERIF_FONT_PATHS,
        "C:/Windows/Fonts/simsun.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    ),
    "msyh": (
        *BUNDLED_SANS_FONT_PATHS,
        "C:/Windows/Fonts/msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ),
    "noto": (
        *BUNDLED_SANS_FONT_PATHS,
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ),
    "wqy": ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",),
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


def load_key(
    key: str,
    target_size: tuple[int, int] | None = None,
) -> Optional[Image.Image]:
    """從 storage 讀取圖片並轉為 sRGB，key 不存在時回傳 None。"""
    from services.storage import get_storage
    storage = get_storage()
    try:
        image = (
            open_bounded_storage_image(
                storage,
                key,
                target_size=target_size,
                fit="exact",
                source_pixel_limit=BACKGROUND_SOURCE_PIXEL_LIMIT,
            )
            if target_size is not None
            else storage.open_image(key)
        )
        return to_srgb(image)
    except (FileNotFoundError, OversizedRenderImageError):
        return None


def _cover_crop_plan(
    image_width: int,
    image_height: int,
    box_width: int,
    box_height: int,
    user_scale: float,
    offset_x: float,
    offset_y: float,
) -> dict:
    """把舊「先放大整張再裁」公式換算成原圖 source box。"""
    image_ratio = image_width / image_height
    box_ratio = box_width / box_height
    if image_ratio > box_ratio:
        base_height = box_height
        base_width = int(box_height * image_ratio)
    else:
        base_width = box_width
        base_height = int(box_width / image_ratio)
    resized_width = max(1, int(base_width * user_scale))
    resized_height = max(1, int(base_height * user_scale))

    overflow_x = resized_width - box_width
    overflow_y = resized_height - box_height
    if overflow_x >= 0:
        resized_source_x = int(overflow_x * (0.5 + offset_x * 0.5))
        resized_source_x = max(0, min(resized_source_x, overflow_x))
        destination_x = 0
        copy_width = box_width
    else:
        resized_source_x = 0
        destination_x = int(-overflow_x / 2)
        copy_width = resized_width
    if overflow_y >= 0:
        resized_source_y = int(overflow_y * (0.5 + offset_y * 0.5))
        resized_source_y = max(0, min(resized_source_y, overflow_y))
        destination_y = 0
        copy_height = box_height
    else:
        resized_source_y = 0
        destination_y = int(-overflow_y / 2)
        copy_height = resized_height

    scale_x = image_width / resized_width
    scale_y = image_height / resized_height
    return {
        "source_box": (
            resized_source_x * scale_x,
            resized_source_y * scale_y,
            (resized_source_x + copy_width) * scale_x,
            (resized_source_y + copy_height) * scale_y,
        ),
        "copy_size": (copy_width, copy_height),
        "destination": (destination_x, destination_y),
    }


def _render_cover_crop(
    image: Image.Image,
    plan: dict,
    box_width: int,
    box_height: int,
) -> Image.Image:
    sampled = image.resize(
        plan["copy_size"],
        Image.Resampling.LANCZOS,
        box=plan["source_box"],
    ).convert("RGBA")
    frame = Image.new("RGBA", (box_width, box_height), (0, 0, 0, 0))
    frame.paste(sampled, plan["destination"], sampled)
    return frame


def cover_crop_for_box(
    image: Image.Image,
    box_width: int,
    box_height: int,
    user_scale: float,
    offset_x: float,
    offset_y: float,
) -> Image.Image:
    """只配置輸出框大小的 cover/zoom/crop，保留既有 offset 語意。"""
    plan = _cover_crop_plan(
        image.width,
        image.height,
        box_width,
        box_height,
        user_scale,
        offset_x,
        offset_y,
    )
    return _render_cover_crop(image, plan, box_width, box_height)


def _photo_decoder_target(
    image: Image.Image,
    box_width: int,
    box_height: int,
    user_scale: float,
) -> tuple[int, int]:
    """依 cover×zoom 的 2×取樣需求與全圖 pixel cap 選 JPEG draft 尺寸。"""
    orientation = image.getexif().get(274, 1)
    swaps_axes = orientation in {5, 6, 7, 8}
    oriented_width, oriented_height = (
        (image.height, image.width)
        if swaps_axes
        else image.size
    )
    image_ratio = oriented_width / oriented_height
    box_ratio = box_width / box_height
    if image_ratio > box_ratio:
        base_height = box_height
        base_width = int(box_height * image_ratio)
    else:
        base_width = box_width
        base_height = int(box_width / image_ratio)
    needed_oriented_width = min(
        oriented_width,
        max(1, int(base_width * user_scale * 2)),
    )
    needed_oriented_height = min(
        oriented_height,
        max(1, int(base_height * user_scale * 2)),
    )
    desired_decoder = (
        (needed_oriented_height, needed_oriented_width)
        if swaps_axes
        else (needed_oriented_width, needed_oriented_height)
    )

    safe_factor = next(
        (
            factor
            for factor in (1, 2, 4, 8)
            if (
                math.ceil(image.width / factor)
                * math.ceil(image.height / factor)
                <= MAX_BOUNDED_DECODE_PIXELS
            )
        ),
        None,
    )
    if safe_factor is None:
        raise OversizedRenderImageError("JPEG draft 後仍會超過安全像素上限")
    safe_decoder_width = max(1, image.width // safe_factor)
    safe_decoder_height = max(1, image.height // safe_factor)
    if safe_factor > 1:
        # Pillow draft 在臨界等尺寸可能保留上一級，少一像素可穩定選到安全倍率。
        safe_decoder_width = max(1, safe_decoder_width - 1)
        safe_decoder_height = max(1, safe_decoder_height - 1)
    return (
        min(desired_decoder[0], safe_decoder_width),
        min(desired_decoder[1], safe_decoder_height),
    )


def load_key_for_box(
    key: str,
    box_w: int,
    box_h: int,
    user_scale: float = 1.0,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> Optional[Image.Image]:
    """只解碼、轉色與縮放最後可見的原圖區域，避免 zoom 放大中間 buffer。"""
    from services.storage import get_storage
    storage = get_storage()
    try:
        with open_storage_image_source(storage, key) as raw:
            if raw.width <= 0 or raw.height <= 0 or box_w <= 0 or box_h <= 0:
                raise OversizedRenderImageError("照片尺寸無效")
            if (raw.format or "").upper() in {"JPEG", "MPO"}:
                raw.draft(
                    None,
                    _photo_decoder_target(
                        raw,
                        box_w,
                        box_h,
                        user_scale,
                    ),
                )
            validate_image_pixel_limit(raw, MAX_BOUNDED_DECODE_PIXELS)
            oriented = ImageOps.exif_transpose(raw)
            try:
                plan = _cover_crop_plan(
                    oriented.width,
                    oriented.height,
                    box_w,
                    box_h,
                    user_scale,
                    offset_x,
                    offset_y,
                )
                source_left, source_top, source_right, source_bottom = plan["source_box"]
                outer_box = (
                    max(0, math.floor(source_left)),
                    max(0, math.floor(source_top)),
                    min(oriented.width, math.ceil(source_right)),
                    min(oriented.height, math.ceil(source_bottom)),
                )
                visible = oriented.crop(outer_box)
                relative_box = (
                    source_left - outer_box[0],
                    source_top - outer_box[1],
                    source_right - outer_box[0],
                    source_bottom - outer_box[1],
                )
                copy_width, copy_height = plan["copy_size"]
                factor = min(
                    int((relative_box[2] - relative_box[0]) // (copy_width * 2)),
                    int((relative_box[3] - relative_box[1]) // (copy_height * 2)),
                )
                if factor >= 2:
                    try:
                        reduced = visible.reduce(factor)
                        visible.close()
                        visible = reduced
                        relative_box = tuple(value / factor for value in relative_box)
                    except Exception:
                        pass  # 少數模式不支援 reduce，仍只處理可見 crop

                converted = to_srgb(visible)
                visible.close()
                try:
                    bounded_plan = {
                        **plan,
                        "source_box": relative_box,
                    }
                    return _render_cover_crop(converted, bounded_plan, box_w, box_h)
                finally:
                    converted.close()
            finally:
                oriented.close()
    except (FileNotFoundError, OversizedRenderImageError):
        return None


@lru_cache(maxsize=128)
def get_font(size: int | float, family: str | None = None) -> ImageFont.FreeTypeFont:
    """Return a FreeType font at `size` pts. If `family` is specified, use FONT_MAP lookup."""
    candidates = []
    if family and family in FONT_MAP:
        candidates.extend(FONT_MAP[family])
    candidates.extend(CJK_FONTS)
    for path in candidates:
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size)
                if Path(path).name in _BUNDLED_VARIABLE_FONT_NAMES:
                    variation = "Bold" if family in _BOLD_FONT_FAMILIES else "Regular"
                    font.set_variation_by_name(variation)
                return font
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


def _text_units(text: str) -> list[str]:
    """依 Konva Text 的字素切分規則合併組合符號、emoji modifier 與 ZWJ。"""
    units: list[str] = []
    for character in text:
        codepoint = ord(character)
        is_combining = unicodedata.category(character).startswith("M")
        is_emoji_modifier = 0x1F3FB <= codepoint <= 0x1F3FF
        is_regional_indicator = 0x1F1E6 <= codepoint <= 0x1F1FF
        if units and (is_combining or is_emoji_modifier):
            units[-1] += character
        elif character == "\u200d" and units:
            units[-1] += character
        elif (
            units
            and is_regional_indicator
            and len(units[-1]) == 1
            and 0x1F1E6 <= ord(units[-1]) <= 0x1F1FF
        ):
            units[-1] += character
        else:
            units.append(character)
    return units


def _utf16_length(text: str) -> int:
    """回傳 JavaScript String.length，供 Konva letterSpacing 計寬契約使用。"""
    return len(text.encode("utf-16-le")) // 2


def _text_advance_with_spacing(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    letter_spacing: float,
) -> float:
    if not text:
        return 0.0
    return float(draw.textlength(text, font=font)) + _utf16_length(text) * letter_spacing


def wrap_text(
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: float,
    draw: ImageDraw.ImageDraw,
    letter_spacing: float = 0,
) -> list[str]:
    """依 Konva ``wrap='char'`` 規則逐字換行，不縮字、不加省略號。"""
    lines: list[str] = []
    for paragraph in text.split("\n"):
        remaining = paragraph
        if _text_advance_with_spacing(draw, remaining, font, letter_spacing) <= max_width:
            lines.append(remaining)
            continue

        while remaining:
            units = _text_units(remaining)
            low = 0
            high = len(units)
            match = ""
            while low < high:
                middle = (low + high) // 2
                candidate = "".join(units[: middle + 1])
                candidate_width = _text_advance_with_spacing(
                    draw,
                    candidate,
                    font,
                    letter_spacing,
                )
                if candidate_width <= max_width:
                    low = middle + 1
                    match = candidate
                else:
                    high = middle

            if not match:
                break

            lines.append(match.rstrip())
            remaining = "".join(units[low:]).lstrip()
            if (
                remaining
                and _text_advance_with_spacing(draw, remaining, font, letter_spacing)
                <= max_width
            ):
                lines.append(remaining)
                break
    return lines


def _line_width_with_spacing(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    letter_spacing: float,
) -> float:
    """回傳與 Konva 對齊／換行相同的 advance width。"""
    if not text:
        return 0.0
    return _text_advance_with_spacing(draw, text, font, letter_spacing)


def draw_line_with_spacing(
    draw: ImageDraw.ImageDraw,
    x: float,
    baseline_y: float,
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: str,
    letter_spacing: float,
) -> None:
    """從 alphabetic baseline 逐字素繪製，使用 advance width 加入字間距。"""
    if not text:
        return
    for text_unit in _text_units(text):
        draw.text((x, baseline_y), text_unit, font=font, fill=fill, anchor="ls")
        x += float(draw.textlength(text_unit, font=font)) + letter_spacing
