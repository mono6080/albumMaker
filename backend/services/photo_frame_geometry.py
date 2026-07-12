# 照片框幾何（拍立得 insets、frame rect）
# 跨語言鏡像：frontend/src/utils/photoFrameGeometry.js（PIL 與 Konva 各需一份實作，
# 數值走共用 design tokens）；兩邊一致性由 tests/test_contract_pins.py 釘住。

import json
from pathlib import Path

# 設計 tokens 正本；前端鏡像 constants/designTokens.js，兩檔由釘測試強制一致
_DESIGN_TOKENS = json.loads(
    (Path(__file__).parent / "design_tokens.json").read_text(encoding="utf-8")
)

CANVAS_WIDTH = _DESIGN_TOKENS["canvas"]["width"]
CANVAS_HEIGHT = _DESIGN_TOKENS["canvas"]["height"]

PHOTO_SLOT_DIMENSION_MODE_KEY = "photo_slot_dimension_mode"
PHOTO_SLOT_CONTENT_BOX_MODE = "content-box-v1"
PHOTO_SLOT_FRAME_BOX_MODE = "frame-box-v1"
DEFAULT_PHOTO_BORDER_WIDTH = _DESIGN_TOKENS["photo_frame"]["default_border_width"]
_BOTTOM_INSET_MULTIPLIER = _DESIGN_TOKENS["photo_frame"]["bottom_inset_multiplier"]


def get_photo_slot_dimension_mode(layout_or_slot: dict | None) -> str:
    value = (layout_or_slot or {}).get(PHOTO_SLOT_DIMENSION_MODE_KEY)
    return PHOTO_SLOT_CONTENT_BOX_MODE if value == PHOTO_SLOT_CONTENT_BOX_MODE else PHOTO_SLOT_FRAME_BOX_MODE


def get_photo_frame_insets(slot: dict) -> dict:
    has_border = slot.get("border", True) is not False
    border_width = max(0, float(slot.get("border_width", DEFAULT_PHOTO_BORDER_WIDTH))) if has_border else 0
    return {
        "left": border_width,
        "top": border_width,
        "right": border_width,
        "bottom": border_width * _BOTTOM_INSET_MULTIPLIER,
        "border_width": border_width,
        "has_border": has_border,
    }


def get_photo_frame_rect(slot: dict, dimension_mode: str | None = None) -> dict:
    mode = dimension_mode or get_photo_slot_dimension_mode(slot)
    x = float(slot.get("x", 0))
    y = float(slot.get("y", 0))
    width = max(1, float(slot.get("width", 1)))
    height = max(1, float(slot.get("height", 1)))
    if mode != PHOTO_SLOT_CONTENT_BOX_MODE:
        return {"x": x, "y": y, "width": width, "height": height}

    insets = get_photo_frame_insets(slot)
    return {
        "x": x - insets["left"],
        "y": y - insets["top"],
        "width": width + insets["left"] + insets["right"],
        "height": height + insets["top"] + insets["bottom"],
    }


def build_photo_frame_slot(slot: dict, dimension_mode: str | None = None) -> dict:
    frame_rect = get_photo_frame_rect(slot, dimension_mode)
    framed_slot = dict(slot)
    framed_slot.update({
        "x": int(round(frame_rect["x"])),
        "y": int(round(frame_rect["y"])),
        "width": int(round(frame_rect["width"])),
        "height": int(round(frame_rect["height"])),
    })
    return framed_slot
