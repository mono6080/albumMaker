from services.project_service import merge_project_label_texts_into_pages


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
