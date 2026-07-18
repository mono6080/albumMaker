from io import BytesIO
from copy import deepcopy
from types import SimpleNamespace
from zipfile import ZipFile

from services import (
    label_texts,
    output_keys,
    project_archive_service,
    project_export_service,
    project_service,
    student_render_service,
)
from services.label_texts import merge_project_label_texts_into_pages
from services.output_keys import (
    build_content_disposition_header,
    build_safe_zip_entry_path,
    get_student_image_key,
    get_student_output_prefix,
    get_student_pdf_key,
    get_student_render_state_key,
    make_safe_filename,
    student_pdf_key_for_mode,
)
from services.preview_cache import _preview_payload_hash
from services.storage import LocalStorageAdapter
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


def test_content_disposition_sanitizes_control_and_quoted_string_characters():
    header = build_content_disposition_header(
        'evil"\r\nX-Injected: yes\\report.zip'
    )

    assert "\r" not in header
    assert "\n" not in header
    assert header == (
        'attachment; filename="evil___X-Injected_ yes_report.zip"; '
        "filename*=UTF-8''evil___X-Injected_%20yes_report.zip"
    )


def test_render_pipeline_fingerprint_tracks_split_render_owners():
    source_names = {path.name for path in _RENDER_PIPELINE_FILES}
    assert {
        "student_render_service.py",
        "render_service.py",
        "label_texts.py",
        "layout_group_validation.py",
        "layout_group_traversal.py",
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


def test_zip_entry_path_cleans_traversal_absolute_and_control_segments():
    assert make_safe_filename("王小明") == "王小明"
    assert make_safe_filename("2026.上學期") == "2026.上學期"
    assert make_safe_filename(".") == "unnamed"
    assert make_safe_filename(" .. ") == "unnamed"
    assert make_safe_filename("/root") == "_root"
    assert make_safe_filename("\\\\server\\share") == "__server_share"
    assert make_safe_filename("C:\\temp\\report") == "C__temp_report"
    assert make_safe_filename("危險\x00名稱") == "危險_名稱"
    assert build_safe_zip_entry_path("..", "C:\\temp\\report.pdf") == (
        "unnamed/C__temp_report.pdf"
    )


def test_canonical_student_output_keys_use_id_namespace_and_mode_paths():
    assert get_student_output_prefix(1, 23) == (
        "projects/proj1/output/students/student23"
    )
    assert get_student_pdf_key(1, 23) == (
        "projects/proj1/output/students/student23/pdf/print.pdf"
    )
    assert student_pdf_key_for_mode(get_student_pdf_key(1, 23), "screen") == (
        "projects/proj1/output/students/student23/pdf/screen.pdf"
    )
    assert get_student_image_key(1, 23, "screen", 4) == (
        "projects/proj1/output/students/student23/images/screen/page4.jpg"
    )
    assert get_student_render_state_key(1, 23) == (
        "projects/proj1/output/students/student23/.render_state"
    )


def test_screen_pdf_key_supports_canonical_mode_path():
    print_key = "projects/proj1/output/students/student23/pdf/print.pdf"

    assert student_pdf_key_for_mode(print_key, "screen") == (
        "projects/proj1/output/students/student23/pdf/screen.pdf"
    )
    assert student_pdf_key_for_mode(print_key, "print") == print_key


def test_legacy_flat_pdf_and_images_remain_downloadable(monkeypatch, tmp_path):
    storage = LocalStorageAdapter(tmp_path / "uploads")
    print_key = "projects/proj1/output/班級-小明.pdf"
    screen_key = "projects/proj1/output/班級-小明_screen.pdf"
    image_key = (
        "projects/proj1/output/班級-小明/images/screen/"
        "班級-小明_screen_page1.jpg"
    )
    storage.put(print_key, b"legacy-print")
    storage.put(screen_key, b"legacy-screen")
    storage.put(image_key, b"legacy-image")
    monkeypatch.setattr(project_export_service, "get_storage", lambda: storage)
    project = SimpleNamespace(
        name="班級",
        template=SimpleNamespace(pages=[object()]),
    )
    student = SimpleNamespace(
        name="小明",
        output_filename=print_key,
    )

    pdf_bytes, download_filename = project_export_service.get_student_pdf_download(
        project,
        student,
        "screen",
    )
    image_entries = project_export_service.get_student_image_entries(
        project,
        student,
        "screen",
    )

    assert pdf_bytes == b"legacy-screen"
    assert download_filename == "班級-小明_screen.pdf"
    assert image_entries == [("班級-小明_screen_page1.jpg", b"legacy-image")]


def test_bulk_download_paths_disambiguate_same_safe_student_names(monkeypatch, tmp_path):
    storage = LocalStorageAdapter(tmp_path / "uploads")
    first_print_key = get_student_pdf_key(1, 10)
    second_print_key = get_student_pdf_key(1, 11)
    storage.put(first_print_key, b"first-pdf")
    storage.put(second_print_key, b"second-pdf")
    storage.put(get_student_image_key(1, 10, "print", 1), b"first-image")
    storage.put(get_student_image_key(1, 11, "print", 1), b"second-image")
    monkeypatch.setattr(project_export_service, "get_storage", lambda: storage)
    project = SimpleNamespace(
        name="班級",
        template=SimpleNamespace(pages=[object()]),
        students=[
            SimpleNamespace(id=10, name="同名", output_filename=first_print_key),
            SimpleNamespace(id=11, name="同名", output_filename=second_print_key),
        ],
    )

    pdf_zip_bytes = b"".join(
        project_export_service.open_all_student_pdfs_zip_stream(project, "print")
    )
    image_zip_bytes = b"".join(
        project_export_service.open_all_student_images_zip_stream(project, "print")
    )

    with ZipFile(BytesIO(pdf_zip_bytes)) as pdf_zip:
        assert sorted(pdf_zip.namelist()) == [
            "班級-同名-student10.pdf",
            "班級-同名-student11.pdf",
        ]
        assert {pdf_zip.read(name) for name in pdf_zip.namelist()} == {
            b"first-pdf",
            b"second-pdf",
        }
    with ZipFile(BytesIO(image_zip_bytes)) as image_zip:
        assert sorted(image_zip.namelist()) == [
            "班級-同名-student10/班級-同名-student10_page1.jpg",
            "班級-同名-student11/班級-同名-student11_page1.jpg",
        ]
