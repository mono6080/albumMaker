from copy import deepcopy

from services import (
    label_texts,
    output_keys,
    project_archive_service,
    project_export_service,
    project_service,
    student_render_service,
)
from services.label_texts import merge_project_label_texts_into_pages
from services.output_keys import student_pdf_key_for_mode
from services.preview_cache import _preview_payload_hash
from services.student_render_service import (
    _RENDER_PIPELINE_FILES,
    _album_render_hash,
    _render_pipeline_fingerprint,
)


def test_empty_student_label_text_overrides_project_label_text():
    student_pages = [
        {
            "page_index": 0,
            "photos": {},
            "label_texts": {"1": "", "2": "Student detail"},
        }
    ]
    project_label_texts = {"0": {"1": "Project default", "2": "Project detail"}}

    merged = merge_project_label_texts_into_pages(student_pages, project_label_texts)

    assert merged[0]["label_texts"] == {
        "1": "",
        "2": "Student detail",
    }


def test_project_service_facade_keeps_legacy_exports():
    expected_owners = {
        "_RENDER_PIPELINE_FILES": student_render_service,
        "_album_render_hash": student_render_service,
        "_clear_student_render_outputs": student_render_service,
        "_render_pipeline_fingerprint": student_render_service,
        "build_combined_stem": output_keys,
        "build_content_disposition_header": output_keys,
        "build_zip_of_student_images": project_export_service,
        "clear_student_render_outputs": student_render_service,
        "get_project_output_prefix": output_keys,
        "get_student_image_entries": project_export_service,
        "get_template_page_layouts": student_render_service,
        "make_safe_filename": output_keys,
        "merge_project_label_texts_into_pages": label_texts,
        "open_all_student_images_zip_stream": project_export_service,
        "open_all_student_pdfs_zip_stream": project_export_service,
        "purge_expired_archived_projects": project_archive_service,
        "render_and_save_student_album": student_render_service,
        "student_pdf_key_for_mode": output_keys,
    }
    assert set(project_service.__all__) == set(expected_owners)
    for symbol, owner in expected_owners.items():
        assert getattr(project_service, symbol) is getattr(owner, symbol)


def test_render_pipeline_fingerprint_tracks_split_render_owners():
    source_names = {path.name for path in _RENDER_PIPELINE_FILES}
    assert {
        "student_render_service.py",
        "render_service.py",
        "label_texts.py",
        "layout_groups.py",
        "element_renderers.py",
        "draw_helpers.py",
        "photo_frame_geometry.py",
        "design_tokens.json",
    } <= source_names


def test_empty_project_label_text_creates_blank_override_page():
    merged = merge_project_label_texts_into_pages([], {"0": {"1": ""}})

    assert merged == [{"page_index": 0, "photos": {}, "label_texts": {"1": ""}}]


def test_legacy_student_template_default_does_not_block_project_blank_override():
    student_pages = [
        {
            "page_index": 0,
            "photos": {},
            "label_texts": {"1": "Template default", "2": "Student custom"},
        }
    ]
    project_label_texts = {"0": {"1": "", "2": "Project default"}}
    page_layouts = [
        {
            "text_labels": [
                {"id": 1, "text": "Template default"},
                {"id": 2, "text": "Template detail"},
            ]
        }
    ]

    merged = merge_project_label_texts_into_pages(student_pages, project_label_texts, page_layouts)

    assert merged[0]["label_texts"] == {
        "1": "",
        "2": "Student custom",
    }


def test_project_label_alignment_merges_with_student_text_override():
    student_pages = [
        {
            "page_index": 0,
            "photos": {},
            "label_texts": {"1": "Student custom"},
        }
    ]
    project_label_texts = {"0": {"1": {"text": "Project default", "text_align": "right"}}}

    merged = merge_project_label_texts_into_pages(student_pages, project_label_texts)

    assert merged[0]["label_texts"] == {
        "1": {"text": "Student custom", "text_align": "right"},
    }


def test_render_pipeline_fingerprint_changes_with_source(tmp_path):
    source = tmp_path / "renderer.py"
    source.write_text("version = 1", encoding="utf-8")
    first = _render_pipeline_fingerprint((source,))
    source.write_text("version = 2", encoding="utf-8")
    assert _render_pipeline_fingerprint((source,)) != first


def test_render_fingerprints_ignore_editor_metadata_but_include_visibility():
    layout = {
        "photo_slots": [{"id": 1, "x": 0, "y": 0, "width": 20, "height": 20}],
        "text_labels": [{"id": 2, "x": 0, "y": 0, "width": 20, "height": 20}],
        "stickers": [],
        "group_contract": "nested-world-v2",
        "groups": [{
            "id": "group-1",
            "z_index": 0,
            "selection_rotation": 0,
            "children": [
                {"type": "photo", "id": 1},
                {"type": "text", "id": 2},
            ],
        }],
    }
    page_data = [{"page_index": 0, "photos": {}, "label_texts": {}}]
    base_album_hash = _album_render_hash([layout], "Ada", page_data)
    base_preview_hash = _preview_payload_hash({"layout": layout, "page_data": page_data[0]})

    editor_only_layout = deepcopy(layout)
    editor_only_layout["photo_slots"][0].update({
        "layer_name": "封面照片",
        "locked": True,
    })
    editor_only_layout["groups"][0].update({
        "layer_name": "封面群組",
        "locked": True,
    })
    assert _album_render_hash([editor_only_layout], "Ada", page_data) == base_album_hash
    assert _preview_payload_hash({
        "layout": editor_only_layout,
        "page_data": page_data[0],
    }) == base_preview_hash

    hidden_layout = deepcopy(editor_only_layout)
    hidden_layout["groups"][0]["visible"] = False
    assert _album_render_hash([hidden_layout], "Ada", page_data) != base_album_hash
    assert _preview_payload_hash({
        "layout": hidden_layout,
        "page_data": page_data[0],
    }) != base_preview_hash


def test_screen_pdf_key_preserves_path_and_extension():
    assert student_pdf_key_for_mode("projects/proj1/output/demo.PDF", "screen") == (
        "projects/proj1/output/demo_screen.PDF"
    )
    assert student_pdf_key_for_mode("projects/proj1/output/demo.PDF", "print") == (
        "projects/proj1/output/demo.PDF"
    )
