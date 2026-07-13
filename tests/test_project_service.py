from services.project_service import (
    _render_pipeline_fingerprint,
    merge_project_label_texts_into_pages,
    student_pdf_key_for_mode,
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


def test_screen_pdf_key_preserves_path_and_extension():
    assert student_pdf_key_for_mode("projects/proj1/output/demo.PDF", "screen") == (
        "projects/proj1/output/demo_screen.PDF"
    )
    assert student_pdf_key_for_mode("projects/proj1/output/demo.PDF", "print") == (
        "projects/proj1/output/demo.PDF"
    )
