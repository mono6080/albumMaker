import asyncio
import io
import struct
import zlib

import pytest
from fastapi import UploadFile
from PIL import Image, ImageChops, ImageOps
from starlette.datastructures import Headers

import services.draw_helpers as draw_helpers
import services.element_renderers as element_renderers
import services.render_image_loader as render_image_loader
import services.storage as storage_service
from services.file_service import (
    PHOTO_MAX_LONG_EDGE,
    read_and_process_photo_upload,
)
from services.render_image_loader import (
    PRINT_OUTPUT_HEIGHT,
    PRINT_OUTPUT_WIDTH,
    STICKER_SOURCE_PIXEL_LIMIT,
    OversizedRenderImageError,
    open_bounded_storage_image,
)
from services.render_service import PRINT_OUTPUT_SIZE, render_page
from tests.helpers import (
    assert_status,
    create_template_with_page,
    login,
    started_client,
)


class _BytesOnlyStorage:
    def __init__(self, image_bytes: bytes):
        self.image_bytes = image_bytes
        self.calls = []

    def get_bytes(self, key: str) -> bytes:
        self.calls.append(key)
        return self.image_bytes


def _image_bytes(
    image_format: str,
    size: tuple[int, int],
    mode: str,
) -> bytes:
    image = Image.new(mode, size, (40, 120, 220, 180) if mode == "RGBA" else (40, 120, 220))
    image_buffer = io.BytesIO()
    image.save(image_buffer, format=image_format)
    return image_buffer.getvalue()


def _png_header(width: int, height: int) -> bytes:
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return (
            struct.pack(">I", len(data))
            + chunk_type
            + data
            + struct.pack(">I", checksum)
        )

    header = struct.pack(
        ">IIBBBBB",
        width,
        height,
        8,
        6,
        0,
        0,
        0,
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IEND", b"")
    )


def test_background_render_converts_only_after_exact_output_resize(monkeypatch):
    storage = _BytesOnlyStorage(_image_bytes("JPEG", (1600, 1200), "RGB"))
    converted_sizes = []
    original_to_srgb = draw_helpers.to_srgb

    def tracked_to_srgb(image):
        converted_sizes.append(image.size)
        return original_to_srgb(image)

    monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
    monkeypatch.setattr(draw_helpers, "to_srgb", tracked_to_srgb)

    background = render_page(
        {
            "canvas_width": 794,
            "canvas_height": 1123,
            "background_filename": "templates/tmpl1/backgrounds/page1.jpg",
            "photo_slots": [],
            "text_labels": [],
            "stickers": [],
        },
        "學生",
        {},
    )

    assert background is not None
    assert background.size == (794, 1123)
    assert converted_sizes == [(794, 1123)]
    assert storage.calls == ["templates/tmpl1/backgrounds/page1.jpg"]


def test_sticker_converts_only_after_exact_frame_resize(monkeypatch):
    storage = _BytesOnlyStorage(_image_bytes("PNG", (800, 600), "RGBA"))
    converted_sizes = []
    original_convert = Image.Image.convert

    def tracked_convert(image, mode=None, *args, **kwargs):
        if mode == "RGBA":
            converted_sizes.append(image.size)
        return original_convert(image, mode, *args, **kwargs)

    monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
    monkeypatch.setattr(Image.Image, "convert", tracked_convert)
    canvas = Image.new("RGB", (120, 100), "white")

    element_renderers.render_sticker(
        canvas,
        {
            "path": "templates/tmpl1/stickers/material.png",
            "x": 20,
            "y": 15,
            "width": 40,
            "height": 30,
        },
    )

    expected_white = Image.new("RGB", canvas.size, "white")
    assert ImageChops.difference(canvas, expected_white).getbbox() is not None
    assert converted_sizes
    assert all(size == (40, 30) for size in converted_sizes)
    assert storage.calls == ["templates/tmpl1/stickers/material.png"]


def test_oversized_png_header_is_rejected_before_pixel_allocation(monkeypatch):
    storage = _BytesOnlyStorage(_png_header(10_000, 6_000))

    def unexpected_operation(*_args, **_kwargs):
        raise AssertionError("oversized non-JPEG must fail before pixel allocation")

    monkeypatch.setattr(Image.Image, "load", unexpected_operation)
    monkeypatch.setattr(Image.Image, "resize", unexpected_operation)
    monkeypatch.setattr(Image.Image, "copy", unexpected_operation)
    monkeypatch.setattr(Image.Image, "convert", unexpected_operation)
    monkeypatch.setattr(Image.Image, "draft", unexpected_operation)
    monkeypatch.setattr(Image.Image, "getexif", unexpected_operation)
    monkeypatch.setattr(ImageOps, "exif_transpose", unexpected_operation)

    with pytest.raises(OversizedRenderImageError):
        open_bounded_storage_image(
            storage,
            "templates/tmpl1/stickers/oversized.png",
            target_size=(512, 512),
            fit="contain",
            source_pixel_limit=STICKER_SOURCE_PIXEL_LIMIT,
        )


def test_photo_loader_skips_oversized_png_before_pixel_allocation(monkeypatch):
    storage = _BytesOnlyStorage(_png_header(10_000, 6_000))

    def unexpected_operation(*_args, **_kwargs):
        raise AssertionError("oversized photo must fail before pixel allocation")

    monkeypatch.setattr(storage_service, "get_storage", lambda: storage)
    monkeypatch.setattr(Image.Image, "load", unexpected_operation)
    monkeypatch.setattr(Image.Image, "resize", unexpected_operation)
    monkeypatch.setattr(Image.Image, "copy", unexpected_operation)
    monkeypatch.setattr(Image.Image, "convert", unexpected_operation)
    monkeypatch.setattr(Image.Image, "draft", unexpected_operation)
    monkeypatch.setattr(Image.Image, "getexif", unexpected_operation)
    monkeypatch.setattr(ImageOps, "exif_transpose", unexpected_operation)

    assert (
        draw_helpers.load_key_for_box(
            "projects/proj1/photos/student1/oversized.png",
            120,
            90,
            1.0,
            0.0,
            0.0,
        )
        is None
    )


def test_template_asset_uploads_reject_oversized_png_from_header(monkeypatch):
    def unexpected_load(*_args, **_kwargs):
        raise AssertionError("upload dimension guard must run before image.load")

    monkeypatch.setattr(Image.Image, "load", unexpected_load)

    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        template = client.get(f"/api/templates/{template_id}").json()
        urls = (
            f"/api/templates/{template_id}/stickers",
            (
                f"/api/templates/{template_id}/pages/{page_id}/background"
                f"?expected_revision={template['revision']}"
            ),
        )
        for url in urls:
            response = client.post(
                url,
                files={
                    "file": (
                        "oversized.png",
                        _png_header(10_000, 6_000),
                        "image/png",
                    )
                },
            )
            assert_status(response, 413)


def test_small_byte_large_dimension_photo_is_still_normalized():
    image_bytes = _image_bytes(
        "JPEG",
        (PHOTO_MAX_LONG_EDGE + 401, 32),
        "RGB",
    )
    assert len(image_bytes) < 10 * 1024 * 1024
    upload = UploadFile(
        file=io.BytesIO(image_bytes),
        filename="wide.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )

    processed = asyncio.run(read_and_process_photo_upload(upload))

    assert processed.compressed is True
    with Image.open(io.BytesIO(processed.data)) as image:
        assert max(image.size) <= PHOTO_MAX_LONG_EDGE


def test_render_pipeline_tracks_bounded_asset_loader():
    from services.student_render_service import _RENDER_PIPELINE_FILES

    assert render_image_loader.__file__ in {
        str(source_path)
        for source_path in _RENDER_PIPELINE_FILES
    }
    assert (PRINT_OUTPUT_WIDTH, PRINT_OUTPUT_HEIGHT) == PRINT_OUTPUT_SIZE
