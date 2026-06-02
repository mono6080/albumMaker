PHOTO_SLOT_DIMENSION_MODE_KEY = "photo_slot_dimension_mode"
PHOTO_SLOT_CONTENT_BOX_MODE = "content-box-v1"
PHOTO_SLOT_FRAME_BOX_MODE = "frame-box-v1"
DEFAULT_PHOTO_BORDER_WIDTH = 8


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
        "bottom": border_width * 3,
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
