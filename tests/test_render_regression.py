# Backend render regression smoke
# Uses a fixed JSON layout fixture and broad pixel checks instead of a full-image
# hash, so the test catches blank/missing regions without becoming font brittle.

import json
from pathlib import Path

from PIL import ImageChops

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
