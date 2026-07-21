from PIL import Image

from scripts.audit_text_overflow import measure_text_overflow
from services import element_renderers, preview_cache, render_service
from services.student_render_service import (
    _RENDER_PIPELINE_FILES,
    _album_render_hash,
)
from services.text_variables import resolve_student_text_variables


def _text_label(text: str) -> dict:
    return {
        "id": 1,
        "x": 0,
        "y": 0,
        "width": 420,
        "height": 100,
        "text": text,
        "font_size": 24,
        "font_family": "msjh",
        "font_color": "#333333",
        "text_align": "center",
        "line_height": 1.4,
    }


def test_name_variables_use_album_name_and_legacy_null_fallback():
    source = "{name}／{full_name}"

    assert resolve_student_text_variables(source, "王大明", "小王") == "小王／王大明"
    assert resolve_student_text_variables(source, "王大明", None) == "王大明／王大明"


def test_text_label_and_footer_share_name_variable_resolver(monkeypatch):
    calls: list[tuple[str, str, str | None]] = []

    def capture(raw_text, full_name, album_name=None):
        calls.append((raw_text, full_name, album_name))
        return ""

    monkeypatch.setattr(
        element_renderers,
        "resolve_student_text_variables",
        capture,
    )
    monkeypatch.setattr(
        render_service,
        "resolve_student_text_variables",
        capture,
    )
    render_service.render_page(
        {
            "canvas_width": 794,
            "canvas_height": 1123,
            "photo_slots": [],
            "text_labels": [_text_label("標題 {name} {full_name}")],
            "stickers": [],
            "footer": {
                "text": "頁尾 {name} {full_name}",
                "x": 0,
                "y": 1050,
            },
        },
        "王大明",
        {},
        album_name="小王",
    )

    assert calls == [
        ("標題 {name} {full_name}", "王大明", "小王"),
        ("頁尾 {name} {full_name}", "王大明", "小王"),
    ]


def test_preview_renderer_forwards_album_name(monkeypatch):
    captured = {}

    def fake_render_preview(layout, full_name, page_data, **kwargs):
        captured.update({
            "layout": layout,
            "full_name": full_name,
            "page_data": page_data,
            **kwargs,
        })
        return Image.new("RGB", (4, 4), "white")

    monkeypatch.setattr(preview_cache, "render_preview_page", fake_render_preview)
    image_bytes = preview_cache.render_preview_jpeg_bytes(
        {"canvas_width": 4, "canvas_height": 4},
        "王大明",
        {},
        0,
        0.7,
        album_name="小王",
    )

    assert image_bytes.startswith(b"\xff\xd8")
    assert captured["full_name"] == "王大明"
    assert captured["album_name"] == "小王"


def test_album_name_changes_preview_and_formal_render_hashes():
    layout = {"photo_slots": [], "text_labels": [], "stickers": []}
    pages = [{"page_index": 0, "photos": {}, "label_texts": {}}]
    legacy_hash = _album_render_hash([layout], "王大明", pages)

    assert _album_render_hash([layout], "王大明", pages, "王大明") == legacy_hash
    assert _album_render_hash([layout], "王大明", pages, "小王") != legacy_hash

    base_preview_payload = {
        "kind": "student",
        "full_name": "王大明",
        "album_name": "王大明",
        "layout": layout,
        "page_data": pages[0],
    }
    renamed_preview_payload = {**base_preview_payload, "album_name": "小王"}
    assert preview_cache._preview_payload_hash(renamed_preview_payload) != (
        preview_cache._preview_payload_hash(base_preview_payload)
    )


def test_overflow_audit_resolves_both_name_variables():
    result = measure_text_overflow(
        _text_label("{name}／{full_name}"),
        None,
        "王大明",
        "小王",
    )

    assert result is not None
    assert result["resolved_text"] == "小王／王大明"


def test_name_variable_resolver_participates_in_pipeline_fingerprint():
    assert "text_variables.py" in {path.name for path in _RENDER_PIPELINE_FILES}
