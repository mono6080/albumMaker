# Backend render regression smoke
# Uses a fixed JSON layout fixture and broad pixel checks instead of a full-image
# hash, so the test catches blank/missing regions without becoming font brittle.

import json
from copy import deepcopy
from pathlib import Path

from PIL import Image, ImageChops

from services.render_service import render_page


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "render_smoke_layout.json"
WHITE = (255, 255, 255)


def load_layout() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def count_non_white_pixels(image, box: tuple[int, int, int, int] | None = None) -> int:
    sample = image.crop(box) if box else image
    rgb_sample = sample.convert("RGB")
    colors = rgb_sample.getcolors(maxcolors=rgb_sample.width * rgb_sample.height)
    assert colors is not None
    return sum(count for count, color in colors if color != WHITE)


def assert_pixel_close(image, xy: tuple[int, int], expected: tuple[int, int, int], tolerance: int = 3) -> None:
    actual = image.convert("RGB").getpixel(xy)
    assert all(abs(channel - expected_channel) <= tolerance for channel, expected_channel in zip(actual, expected)), actual


def test_render_page_smoke_fixture_draws_expected_regions():
    layout = load_layout()

    image = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "Custom label for Ada"}},
        page_index=0,
    )

    assert image.size == (794, 1123)
    assert count_non_white_pixels(image) > 1500

    # Empty photo slots should render as a gray placeholder frame.
    assert_pixel_close(image, (55, 67), (238, 238, 238))

    # Bubble body should render with its configured fill.
    assert_pixel_close(image, (308, 70), (253, 230, 138))

    # Text label and footer regions should contain rendered glyph pixels.
    assert count_non_white_pixels(image, (58, 250, 358, 332)) > 20
    assert count_non_white_pixels(image, (36, 1058, 250, 1102)) > 20


def test_render_page_label_text_override_changes_text_region():
    layout = load_layout()
    label_box = (58, 250, 358, 332)

    short_text = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "Short label"}},
        page_index=0,
    ).crop(label_box)
    long_text = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "Much longer custom label for the regression fixture"}},
        page_index=0,
    ).crop(label_box)

    assert ImageChops.difference(short_text, long_text).getbbox() is not None


def test_render_page_label_text_is_visually_centered_in_box():
    layout = load_layout()
    layout["text_labels"] = [
        {
            "id": 99,
            "x": 96,
            "y": 340,
            "width": 180,
            "height": 110,
            "text": "（姓名）的文字裡面要打孩子學習狀況的描述",
            "font_size": 20,
            "font_color": "#111827",
            "font_family": "msjh",
            "line_height": 1.4,
            "text_align": "center",
        }
    ]
    layout["text_bubbles"] = []
    layout["photo_slots"] = []
    layout["footer"] = None

    image = render_page(layout, student_name="姓名", page_data={}, page_index=0)
    crop = image.crop((96, 340, 276, 450)).convert("RGB")
    diff = ImageChops.difference(crop, Image.new("RGB", crop.size, WHITE))
    bbox = diff.getbbox()

    assert bbox is not None
    text_center_y = (bbox[1] + bbox[3]) / 2
    box_center_y = crop.height / 2
    assert abs(text_center_y - box_center_y) <= 6


def test_render_page_empty_label_text_outputs_blank_text():
    layout = load_layout()
    label_box = (58, 250, 358, 332)

    inherited_text = render_page(
        layout,
        student_name="Ada",
        page_data={},
        page_index=0,
    ).crop(label_box)
    empty_override_text = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": ""}},
        page_index=0,
    ).crop(label_box)

    assert ImageChops.difference(inherited_text, empty_override_text).getbbox() is not None


def test_render_page_text_shadow_changes_label_and_bubble_regions():
    layout = load_layout()
    shadow_layout = deepcopy(layout)
    shadow_fields = {
        "text_shadow_enabled": True,
        "text_shadow_color": "#FF0000",
        "text_shadow_opacity": 220,
        "text_shadow_offset_x": 7,
        "text_shadow_offset_y": 6,
        "text_shadow_blur": 0,
    }
    shadow_layout["text_labels"][0].update(shadow_fields)
    shadow_layout["text_bubbles"][0].update(shadow_fields)

    page_data = {"label_texts": {"1": "Shadow label"}}
    plain = render_page(layout, student_name="Ada", page_data=page_data, page_index=0)
    shadowed = render_page(shadow_layout, student_name="Ada", page_data=page_data, page_index=0)

    assert ImageChops.difference(
        plain.crop((58, 250, 380, 350)),
        shadowed.crop((58, 250, 380, 350)),
    ).getbbox() is not None
    assert ImageChops.difference(
        plain.crop((246, 58, 390, 150)),
        shadowed.crop((246, 58, 390, 150)),
    ).getbbox() is not None
