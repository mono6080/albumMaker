# Backend render regression smoke
# Uses a fixed JSON layout fixture and broad pixel checks instead of a full-image
# hash, so the test catches blank/missing regions without becoming font brittle.

import json
from copy import deepcopy
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops, ImageFont, ImageOps

import services.draw_helpers as draw_helpers
import services.element_renderers as element_renderers
import services.render_service as render_service
from services.draw_helpers import cover_crop_for_box, paste_rotated
from services.element_renderers import render_text_label
from services.render_service import (
    PRINT_OUTPUT_SIZE,
    render_album,
    render_page,
    render_preview_page,
    scale_layout_for_preview,
    scale_layout_to_size,
)


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


def _legacy_cover_crop(
    image: Image.Image,
    box_width: int,
    box_height: int,
    user_scale: float,
    offset_x: float,
    offset_y: float,
) -> Image.Image:
    image_ratio = image.width / image.height
    box_ratio = box_width / box_height
    if image_ratio > box_ratio:
        base_height = box_height
        base_width = int(box_height * image_ratio)
    else:
        base_width = box_width
        base_height = int(box_width / image_ratio)
    resized_width = max(1, int(base_width * user_scale))
    resized_height = max(1, int(base_height * user_scale))
    resized = image.resize(
        (resized_width, resized_height),
        Image.Resampling.LANCZOS,
    )

    overflow_x = resized_width - box_width
    overflow_y = resized_height - box_height
    if overflow_x >= 0:
        source_x = max(
            0,
            min(int(overflow_x * (0.5 + offset_x * 0.5)), overflow_x),
        )
        destination_x = 0
        copy_width = box_width
    else:
        source_x = 0
        destination_x = int(-overflow_x / 2)
        copy_width = resized_width
    if overflow_y >= 0:
        source_y = max(
            0,
            min(int(overflow_y * (0.5 + offset_y * 0.5)), overflow_y),
        )
        destination_y = 0
        copy_height = box_height
    else:
        source_y = 0
        destination_y = int(-overflow_y / 2)
        copy_height = resized_height

    crop = resized.crop((
        source_x,
        source_y,
        source_x + copy_width,
        source_y + copy_height,
    )).convert("RGBA")
    frame = Image.new("RGBA", (box_width, box_height), (0, 0, 0, 0))
    frame.paste(crop, (destination_x, destination_y), crop)
    return frame


def assert_pixel_close(image, xy: tuple[int, int], expected: tuple[int, int, int], tolerance: int = 3) -> None:
    actual = image.convert("RGB").getpixel(xy)
    assert all(abs(channel - expected_channel) <= tolerance for channel, expected_channel in zip(actual, expected)), actual


def migrate_photo_slots_to_content_box(layout: dict) -> dict:
    migrated = deepcopy(layout)
    migrated["photo_slot_dimension_mode"] = "content-box-v1"
    for slot in migrated.get("photo_slots", []):
        border_w = slot.get("border_width", 8) if slot.get("border", True) is not False else 0
        slot["x"] += border_w
        slot["y"] += border_w
        slot["width"] -= border_w * 2
        slot["height"] -= border_w * 4
    return migrated


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

    # Text label and footer regions should contain rendered glyph pixels.
    assert count_non_white_pixels(image, (58, 250, 358, 332)) > 20
    assert count_non_white_pixels(image, (36, 1058, 250, 1102)) > 20


def test_render_page_supports_migrated_photo_slot_content_box_geometry():
    layout = load_layout()
    migrated_layout = migrate_photo_slots_to_content_box(layout)

    legacy_image = render_page(layout, student_name="Ada", page_data={}, page_index=0)
    migrated_image = render_page(migrated_layout, student_name="Ada", page_data={}, page_index=0)

    assert ImageChops.difference(legacy_image, migrated_image).getbbox() is None


def test_bounded_cover_crop_preserves_legacy_scale_and_offset_pixels():
    source = Image.new("RGB", (127, 83))
    source.putdata([
        (
            (x * 7 + y * 3) % 256,
            (x * 2 + y * 11) % 256,
            (x * 13 + y * 5) % 256,
        )
        for y in range(source.height)
        for x in range(source.width)
    ])
    cases = (
        (64, 48, 0.5, 0.0, 0.0),
        (64, 48, 1.0, 0.0, 0.0),
        (64, 48, 2.5, -0.6, 0.4),
        (64, 48, 10.0, 1.0, -1.0),
        (48, 64, 1.7, 0.2, -0.3),
    )

    for case in cases:
        legacy = _legacy_cover_crop(source, *case)
        bounded = cover_crop_for_box(source, *case)
        assert ImageChops.difference(legacy, bounded).getbbox() is None


def test_bounded_cover_crop_never_resizes_larger_than_output_box(monkeypatch):
    source = Image.new("RGB", (1200, 900), "white")
    resize_sizes = []
    original_resize = Image.Image.resize

    def tracked_resize(image, size, *args, **kwargs):
        resize_sizes.append(size)
        return original_resize(image, size, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "resize", tracked_resize)
    for scale in (0.5, 1.0, 3.0, 10.0):
        result = cover_crop_for_box(source, 60, 48, scale, 0.25, -0.4)
        assert result.size == (60, 48)

    assert len(resize_sizes) == 4
    assert all(
        width <= 60 and height <= 48
        for width, height in resize_sizes
    )


def test_photo_loader_converts_only_bounded_visible_crop(monkeypatch):
    import services.storage as storage_service

    source = Image.new("RGB", (1200, 900), "white")
    source_bytes = BytesIO()
    source.save(source_bytes, format="JPEG")
    converted_sizes = []

    class FakeStorage:
        def get_bytes(self, _key):
            return source_bytes.getvalue()

    def tracked_to_srgb(image):
        converted_sizes.append(image.size)
        return image.convert("RGB")

    monkeypatch.setattr(storage_service, "get_storage", lambda: FakeStorage())
    monkeypatch.setattr(draw_helpers, "to_srgb", tracked_to_srgb)

    for scale in (1.0, 10.0):
        fitted = draw_helpers.load_key_for_box(
            "projects/test/photo.jpg",
            60,
            60,
            scale,
            0.2,
            -0.3,
        )
        assert fitted is not None
        assert fitted.size == (60, 60)

    assert converted_sizes
    assert all(width <= 240 and height <= 240 for width, height in converted_sizes)


def test_photo_loader_applies_exif_before_cover_crop(monkeypatch):
    import services.storage as storage_service

    source = Image.new("RGB", (120, 80))
    source.putdata([
        ((x * 9) % 256, (y * 11) % 256, ((x + y) * 5) % 256)
        for y in range(source.height)
        for x in range(source.width)
    ])
    exif = Image.Exif()
    exif[274] = 6
    source_bytes = BytesIO()
    source.save(source_bytes, format="PNG", exif=exif)

    class FakeStorage:
        def get_bytes(self, _key):
            return source_bytes.getvalue()

    monkeypatch.setattr(storage_service, "get_storage", lambda: FakeStorage())
    with Image.open(BytesIO(source_bytes.getvalue())) as encoded:
        oriented = ImageOps.exif_transpose(encoded)
        expected = cover_crop_for_box(oriented, 60, 60, 1.5, 0.2, -0.4)
    actual = draw_helpers.load_key_for_box(
        "projects/test/oriented.png",
        60,
        60,
        1.5,
        0.2,
        -0.4,
    )

    assert actual is not None
    assert ImageChops.difference(actual, expected).getbbox() is None


def test_photo_renderer_bounds_legacy_nonfinite_transform_values(monkeypatch):
    captured = []

    def fake_load(
        _path,
        box_width,
        box_height,
        user_scale,
        offset_x,
        offset_y,
    ):
        captured.append((user_scale, offset_x, offset_y))
        return Image.new("RGB", (box_width, box_height), "white")

    monkeypatch.setattr(element_renderers, "load_key_for_box", fake_load)
    element_renderers.render_photo_slot(
        Image.new("RGB", (120, 90), "white"),
        {
            "id": 1,
            "x": 0,
            "y": 0,
            "width": 80,
            "height": 60,
            "border": False,
            "shadow_enabled": False,
        },
        {
            "1": {
                "path": "projects/test/photo.jpg",
                "scale": 999,
                "offset_x": 999,
                "offset_y": float("nan"),
                "brightness": float("-inf"),
                "contrast": 999,
            }
        },
        0,
    )

    assert captured == [(3.0, 10.0, 0.0)]


def test_render_page_skips_hidden_layout_elements():
    layout = load_layout()
    layout["photo_slots"][0]["visible"] = False
    layout["text_labels"][0]["visible"] = False

    image = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "This override must stay hidden"}},
        page_index=0,
    )

    assert count_non_white_pixels(image, (40, 52, 190, 172)) == 0
    assert count_non_white_pixels(image, (58, 250, 358, 332)) == 0
    assert count_non_white_pixels(image, (36, 1058, 250, 1102)) > 20


def test_render_page_placeholder_indices_skip_hidden_slots_and_keep_collection_order(
    monkeypatch,
):
    layout = {
        "canvas_width": 794,
        "canvas_height": 1123,
        "group_contract": "nested-world-v2",
        "photo_slots": [
            {"id": "hidden", "visible": False, "x": 0, "y": 0, "width": 40, "height": 30},
            {"id": "ancestor-hidden", "x": 0, "y": 40, "width": 40, "height": 30},
            {"id": "second", "z_index": 20, "x": 50, "y": 0, "width": 40, "height": 30},
            {"id": "first", "z_index": 10, "x": 100, "y": 0, "width": 40, "height": 30},
        ],
        "text_labels": [],
        "stickers": [{"id": "hidden-sticker", "x": 50, "y": 40, "width": 20, "height": 20}],
        "groups": [
            {
                "id": "hidden-group",
                "z_index": 0,
                "selection_rotation": 0,
                "visible": False,
                "children": [
                    {"type": "photo", "id": "ancestor-hidden"},
                    {"type": "sticker", "id": "hidden-sticker"},
                ],
            }
        ],
    }
    rendered_slots = []

    def capture_photo_slot(_canvas, slot, _photos, _page_index, slot_index=0):
        rendered_slots.append((slot["id"], slot_index))

    monkeypatch.setattr(render_service, "render_photo_slot", capture_photo_slot)

    render_page(layout, student_name="Ada", page_data={}, page_index=0)

    assert rendered_slots == [("first", 1), ("second", 0)]


def test_render_album_print_output_renders_on_native_canvas():
    layout = load_layout()

    image = render_album(
        [layout],
        student_name="Ada",
        pages_data=[{"page_index": 0, "label_texts": {"1": "Native print label"}}],
        output_size=PRINT_OUTPUT_SIZE,
    )[0]

    assert image.size == PRINT_OUTPUT_SIZE
    scale_x = PRINT_OUTPUT_SIZE[0] / layout["canvas_width"]
    scale_y = PRINT_OUTPUT_SIZE[1] / layout["canvas_height"]

    assert_pixel_close(image, (round(55 * scale_x), round(67 * scale_y)), (238, 238, 238))
    assert count_non_white_pixels(
        image,
        (
            round(58 * scale_x),
            round(250 * scale_y),
            round(358 * scale_x),
            round(332 * scale_y),
        ),
    ) > 200


def test_scaled_text_labels_keep_canonical_typography_source():
    layout = {
        "canvas_width": 794,
        "canvas_height": 1123,
        "photo_slots": [],
        "text_labels": [
            {
                "id": 1,
                "x": 91.25,
                "y": 210.5,
                "width": 183.75,
                "height": 91.5,
                "text": "浮點字級與框尺寸 parity",
                "font_size": 21.3397833832271,
                "font_family": "msjhbd",
                "line_height": 1.3,
                "letter_spacing": 1.25,
            }
        ],
        "stickers": [],
    }
    expected_source = {
        "width": 183.75,
        "height": 91.5,
        "font_size": 21.3397833832271,
        "font_family": "msjhbd",
        "line_height": 1.3,
        "letter_spacing": 1.25,
    }

    preview_label = scale_layout_for_preview(layout)["text_labels"][0]
    print_label = scale_layout_to_size(layout, PRINT_OUTPUT_SIZE)["text_labels"][0]

    assert preview_label["_text_layout_source"] == expected_source
    assert print_label["_text_layout_source"] == expected_source


def test_preview_renders_canonical_page_before_downsampling():
    layout = load_layout()
    page_data = {"label_texts": {"1": "Canonical preview"}}
    canonical = render_page(layout, "Ada", page_data, page_index=0)
    expected = canonical.resize((556, 786), Image.Resampling.LANCZOS)

    preview = render_preview_page(
        layout,
        "Ada",
        page_data,
        page_index=0,
        scale=0.7,
    )

    assert preview.size == (556, 786)
    assert ImageChops.difference(preview, expected).getbbox() is None


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


def test_render_page_static_text_label_ignores_label_text_override():
    layout = load_layout()
    static_layout = deepcopy(layout)
    static_layout["text_labels"][0]["text_role"] = "static"
    label_box = (58, 250, 358, 332)

    template_text = render_page(
        static_layout,
        student_name="Ada",
        page_data={},
        page_index=0,
    ).crop(label_box)
    ignored_override = render_page(
        static_layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "Student override should not render"}},
        page_index=0,
    ).crop(label_box)
    fillable_override = render_page(
        layout,
        student_name="Ada",
        page_data={"label_texts": {"1": "Student override should render"}},
        page_index=0,
    ).crop(label_box)

    assert ImageChops.difference(template_text, ignored_override).getbbox() is None
    assert ImageChops.difference(template_text, fillable_override).getbbox() is not None


def test_render_page_text_shadow_changes_label_region():
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

    page_data = {"label_texts": {"1": "Shadow label"}}
    plain = render_page(layout, student_name="Ada", page_data=page_data, page_index=0)
    shadowed = render_page(shadow_layout, student_name="Ada", page_data=page_data, page_index=0)

    assert ImageChops.difference(
        plain.crop((58, 250, 380, 350)),
        shadowed.crop((58, 250, 380, 350)),
    ).getbbox() is not None


def test_render_text_label_clips_overflow_and_keeps_first_visible_lines(monkeypatch):
    monkeypatch.setattr(
        element_renderers,
        "get_font",
        lambda size, family=None: ImageFont.load_default(size=size),
    )

    label = {
        "id": 1,
        "x": 60,
        "y": 60,
        "width": 280,
        "height": 64,
        "text": "WWWWWWWW\nI\nII\nIII",
        "font_size": 32,
        "font_color": "#111111",
        "line_height": 1,
        "text_align": "left",
    }
    clipped = Image.new("RGB", (400, 220), WHITE)
    unclipped = clipped.copy()

    render_text_label(clipped, label, {}, "")
    render_text_label(unclipped, label, {}, "", clip_overflow=False)

    frame_box = (
        label["x"],
        label["y"],
        label["x"] + label["width"],
        label["y"] + label["height"],
    )
    clipped_bbox = ImageChops.difference(
        clipped.crop(frame_box),
        Image.new("RGB", (label["width"], label["height"]), WHITE),
    ).getbbox()
    unclipped_bbox = ImageChops.difference(
        unclipped.crop(frame_box),
        Image.new("RGB", (label["width"], label["height"]), WHITE),
    ).getbbox()
    assert clipped_bbox is not None
    assert unclipped_bbox is not None
    assert clipped_bbox[2] - clipped_bbox[0] > (unclipped_bbox[2] - unclipped_bbox[0]) * 3

    frame_mask = Image.new("L", clipped.size, 0)
    frame_mask.paste(255, frame_box)
    clipped_ink = ImageChops.difference(
        clipped,
        Image.new("RGB", clipped.size, WHITE),
    ).convert("L")
    unclipped_ink = ImageChops.difference(
        unclipped,
        Image.new("RGB", unclipped.size, WHITE),
    ).convert("L")
    assert ImageChops.subtract(clipped_ink, frame_mask).getbbox() is None
    assert ImageChops.subtract(unclipped_ink, frame_mask).getbbox() is not None


def test_render_text_label_clips_shadow_before_rotating_local_frame(monkeypatch):
    monkeypatch.setattr(
        element_renderers,
        "get_font",
        lambda size, family=None: ImageFont.load_default(size=size),
    )
    label = {
        "id": 1,
        "x": 75,
        "y": 55,
        "width": 90,
        "height": 38,
        "rotation": 28,
        "text": "ABCDEFGHIJKLMN",
        "font_size": 32,
        "font_color": "#111111",
        "font_family": "msjh",
        "line_height": 1,
        "text_align": "left",
        "text_shadow_enabled": True,
        "text_shadow_color": "#FF0000",
        "text_shadow_opacity": 255,
        "text_shadow_offset_x": 12,
        "text_shadow_offset_y": 10,
        "text_shadow_blur": 4,
    }
    actual = Image.new("RGB", (250, 200), WHITE)
    unclipped = actual.copy()

    render_text_label(actual, label, {}, "")
    render_text_label(unclipped, label, {}, "", clip_overflow=False)

    assert count_non_white_pixels(actual) > 0

    frame_mask = Image.new("L", actual.size, 0)
    frame = Image.new("L", (label["width"], label["height"]), 255)
    paste_rotated(
        frame_mask,
        frame,
        label["x"] + label["width"] / 2,
        label["y"] + label["height"] / 2,
        label["rotation"],
    )
    allowed_mask = frame_mask.point(lambda value: 255 if value else 0)

    def outside_ink(image: Image.Image) -> Image.Image:
        difference = ImageChops.difference(
            image.convert("RGB"),
            Image.new("RGB", image.size, WHITE),
        ).convert("L")
        ink_mask = difference.point(lambda value: 255 if value else 0)
        return ImageChops.subtract(ink_mask, allowed_mask)

    assert outside_ink(actual).getbbox() is None
    assert outside_ink(unclipped).getbbox() is not None
