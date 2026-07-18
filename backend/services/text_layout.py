"""文字框的固定字級排版計畫；語意鏡像 Konva Text。"""

from dataclasses import dataclass
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from services.draw_helpers import _line_width_with_spacing, wrap_text

_DESIGN_TOKENS = json.loads(
    (Path(__file__).parent / "design_tokens.json").read_text(encoding="utf-8")
)
TEXT_LAYOUT_MEASUREMENT_SCALE = _DESIGN_TOKENS["text_layout"]["measurement_scale"]


@dataclass(frozen=True)
class TextLayoutPlan:
    full_lines: list[str]
    visible_lines: list[str]
    line_widths: list[float]
    line_x_positions: list[float]
    line_baselines: list[float]
    line_height_px: float
    max_visible_lines: int


def layout_text_label(
    text: str,
    *,
    font: ImageFont.FreeTypeFont,
    box_width: float,
    box_height: float,
    font_size: float,
    line_height: float,
    letter_spacing: float,
    text_align: str,
    clip_overflow: bool,
    draw: ImageDraw.ImageDraw | None = None,
) -> TextLayoutPlan:
    """固定字級排版；超高時與 Konva 一樣保留最前面可容納的行。"""
    measure_draw = draw or ImageDraw.Draw(Image.new("L", (1, 1), 0))
    line_height_px = font_size * line_height
    full_lines = wrap_text(
        text,
        font,
        box_width,
        measure_draw,
        letter_spacing,
    )
    max_visible_lines = max(1, math.floor(box_height / line_height_px + 1e-9))
    visible_lines = (
        full_lines[:max_visible_lines]
        if clip_overflow
        else full_lines
    )
    line_widths = [
        _line_width_with_spacing(measure_draw, line, font, letter_spacing)
        for line in visible_lines
    ]
    line_x_positions = []
    for line_width in line_widths:
        if text_align == "right":
            line_x_positions.append(box_width - line_width)
        elif text_align == "center":
            line_x_positions.append((box_width - line_width) / 2)
        else:
            line_x_positions.append(0.0)

    ascent, descent = font.getmetrics()
    block_top = (box_height - len(visible_lines) * line_height_px) / 2
    first_baseline = block_top + (line_height_px + ascent - descent) / 2
    line_baselines = [
        first_baseline + line_index * line_height_px
        for line_index in range(len(visible_lines))
    ]
    return TextLayoutPlan(
        full_lines=full_lines,
        visible_lines=visible_lines,
        line_widths=line_widths,
        line_x_positions=line_x_positions,
        line_baselines=line_baselines,
        line_height_px=line_height_px,
        max_visible_lines=max_visible_lines,
    )
