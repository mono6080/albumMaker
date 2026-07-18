"""後端寫入契約：文字 shape、頁面邊界、版面數值與 deprecated retry。"""

import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image
from pydantic import ValidationError
from sqlalchemy.orm import Session

from database import SessionLocal, TemplatePage
from routers.projects.schemas import PhotoSlotValue
from services import render_service
from services.element_renderers import render_text_label
from services.label_texts import (
    MAX_LABEL_ENTRIES_PER_PAGE,
    MAX_LABEL_TEXT_LENGTH,
    MAX_LABEL_TEXT_TOTAL_PER_PAGE,
    validate_page_label_texts,
)
from services.layout_geometry_validation import (
    MAX_RENDERABLE_LEAF_COUNT,
    MAX_TEMPLATE_RENDER_PAGES,
    LayoutGeometryValidationError,
)
from services.render_service import render_album, render_page
from services.template_page_snapshot_service import normalize_template_page_layout
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    revisioned_project_url,
    smoke_layout,
    started_client,
    unique_name,
)


def _create_student(client, project_id: int) -> int:
    return client.get(f"/api/projects/{project_id}").json()["students"][0]["id"]


def _sticker(sticker_id: int | str = 2) -> dict:
    return {
        "id": sticker_id,
        "path": "templates/tmpl1/stickers/missing.png",
        "x": 24,
        "y": 24,
        "width": 80,
        "height": 60,
        "rotation": 0,
    }


def _nested_layout() -> dict:
    layout = smoke_layout()
    layout["group_contract"] = "nested-world-v2"
    layout["stickers"] = [_sticker("material")]
    layout["groups"] = [
        {
            "id": "caption",
            "z_index": 0,
            "selection_rotation": 0,
            "children": [
                {"type": "sticker", "id": "material"},
                {"type": "text", "id": 1},
            ],
        },
        {
            "id": "root",
            "z_index": 1,
            "selection_rotation": 0,
            "children": [
                {"type": "photo", "id": 1},
                {"type": "group", "id": "caption"},
            ],
        },
    ]
    return layout


def test_label_text_writes_reject_malformed_shapes_without_persisting_them():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            student_names=["契約學生"],
        )
        student_id = _create_student(client, project_id)

        malformed_project = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/label_texts",
            ),
            json={"0": "broken-page-shape"},
        )
        assert_status(malformed_project, 422)

        malformed_student = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/0/texts",
            ),
            json={"1": ["not", "a", "label", "entry"]},
        )
        assert_status(malformed_student, 422)

        malformed_batch = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/batch/texts",
            ),
            json={
                "students": {
                    str(student_id): {
                        "0": {"1": {"text": 123}},
                    },
                },
            },
        )
        assert_status(malformed_batch, 422)

        detail = client.get(f"/api/projects/{project_id}").json()
        assert detail["label_texts"] == {}
        assert detail["students"][0]["pages_data"] == []


def test_all_label_override_apis_reject_text_over_shared_length_limit():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            student_names=["契約學生"],
        )
        student_id = _create_student(client, project_id)
        oversized_text = "字" * (MAX_LABEL_TEXT_LENGTH + 1)

        project_response = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/label_texts",
            ),
            json={"0": {"1": oversized_text}},
        )
        assert_status(project_response, 422)

        student_response = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/0/texts",
            ),
            json={"1": {"text": oversized_text}},
        )
        assert_status(student_response, 422)

        batch_response = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/batch/texts",
            ),
            json={
                "students": {
                    str(student_id): {
                        "0": {"1": oversized_text},
                    },
                },
            },
        )
        assert_status(batch_response, 422)

        detail = client.get(f"/api/projects/{project_id}").json()
        assert detail["label_texts"] == {}
        assert detail["students"][0]["pages_data"] == []


def test_label_override_count_and_total_length_have_bounded_contracts():
    with pytest.raises(HTTPException) as count_error:
        validate_page_label_texts({
            str(index): ""
            for index in range(MAX_LABEL_ENTRIES_PER_PAGE + 1)
        })
    assert count_error.value.detail["code"] == "invalid_label_texts"

    entry_count = MAX_LABEL_TEXT_TOTAL_PER_PAGE // MAX_LABEL_TEXT_LENGTH + 1
    with pytest.raises(HTTPException) as total_error:
        validate_page_label_texts({
            str(index): "字" * MAX_LABEL_TEXT_LENGTH
            for index in range(entry_count)
        })
    assert "total text length" in total_error.value.detail["errors"][0]["message"]


def test_template_default_text_rejects_over_limit():
    layout = smoke_layout()
    layout["text_labels"][0]["text"] = "字" * (MAX_LABEL_TEXT_LENGTH + 1)

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.detail["code"] == "invalid_layout_geometry"
    assert any(
        error["path"] == "text_labels[0].text"
        for error in captured.value.detail["errors"]
    )


@pytest.mark.parametrize(
    ("raw_text", "student_name"),
    [
        pytest.param("字" * 10_000, "學生", id="oversized-default-text"),
        pytest.param("{name}", "名" * 10_000, id="oversized-student-name"),
    ],
)
def test_renderer_bounds_old_text_and_name_before_layout_work(
    monkeypatch,
    raw_text,
    student_name,
):
    measured_texts = []

    def capture_layout(text, **_kwargs):
        measured_texts.append(text)
        return SimpleNamespace(
            visible_lines=[],
            line_x_positions=[],
            line_baselines=[],
        )

    monkeypatch.setattr(
        "services.element_renderers.layout_text_label",
        capture_layout,
    )
    canvas = Image.new("RGB", (200, 100), "white")
    render_text_label(
        canvas,
        {
            "id": 1,
            "x": 0,
            "y": 0,
            "width": 180,
            "height": 80,
            "text": raw_text,
            "font_size": 20,
        },
        {},
        student_name,
    )

    assert len(measured_texts) == 1
    assert len(measured_texts[0]) <= MAX_LABEL_TEXT_LENGTH


def test_photo_mapping_schema_caps_zoom_at_frontend_maximum():
    assert PhotoSlotValue(path="projects/test/photo.jpg", scale=3).scale == 3
    with pytest.raises(ValidationError):
        PhotoSlotValue(path="projects/test/photo.jpg", scale=3.01)


def test_student_page_mutations_reject_negative_and_out_of_range_indices_without_growth():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        project_id = create_project(
            client,
            template_id,
            student_names=["契約學生"],
        )
        student_id = _create_student(client, project_id)

        negative_text = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/-1/texts",
            ),
            json={"1": "不得改最後一頁"},
        )
        assert_status(negative_text, 422)

        out_of_range_skip = client.patch(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/99/skip",
            ),
            json={"skip": True},
        )
        assert_status(out_of_range_skip, 422)

        out_of_range_batch = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/batch/texts",
            ),
            json={
                "students": {
                    str(student_id): {
                        "99": {"1": "不得補到第 100 頁"},
                    },
                },
            },
        )
        assert_status(out_of_range_batch, 422)

        negative_mapping = client.put(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/photos/mapping",
            ),
            json={"pages": {"-1": {"1": None}}},
        )
        assert_status(negative_mapping, 422)

        out_of_range_upload = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/students/{student_id}/pages/99/photos/1",
            ),
            files={"file": ("unused.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(out_of_range_upload, 404)

        detail = client.get(f"/api/projects/{project_id}").json()
        assert detail["students"][0]["pages_data"] == []


@pytest.mark.parametrize(
    ("field_name", "invalid_value", "expected_code"),
    [
        ("width", 0, "invalid_layout_geometry"),
        ("height", 1_000_000, "invalid_layout_geometry"),
        ("font_size", float("inf"), "invalid_layout_typography"),
        pytest.param(
            "font_size",
            10 ** 10000,
            "invalid_layout_typography",
            id="font_size-huge-int",
        ),
        ("line_height", 0, "invalid_layout_typography"),
        ("letter_spacing", 1_000_000, "invalid_layout_typography"),
    ],
)
def test_template_layout_rejects_unsafe_typography_values(
    field_name,
    invalid_value,
    expected_code,
):
    layout = smoke_layout()
    layout["text_labels"][0][field_name] = invalid_value

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.status_code == 422
    assert captured.value.detail["code"] == expected_code
    assert any(
        error["path"] == f"text_labels[0].{field_name}"
        for error in captured.value.detail["errors"]
    )


@pytest.mark.parametrize(
    ("collection_name", "field_name", "invalid_value", "expected_path"),
    [
        ("photo_slots", "x", float("nan"), "photo_slots[0].x"),
        ("photo_slots", "border_width", 1_000_000_000, "photo_slots[0].border_width"),
        ("photo_slots", "shadow_blur", float("inf"), "photo_slots[0].shadow_blur"),
        ("text_labels", "rotation", float("-inf"), "text_labels[0].rotation"),
        ("stickers", "width", 1_000_000_000, "stickers[0].width"),
        ("stickers", "height", float("nan"), "stickers[0].height"),
    ],
)
def test_template_layout_rejects_unsafe_leaf_geometry(
    collection_name,
    field_name,
    invalid_value,
    expected_path,
):
    layout = smoke_layout()
    layout["stickers"] = [_sticker()]
    layout[collection_name][0][field_name] = invalid_value

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.status_code == 422
    assert captured.value.detail["code"] == "invalid_layout_geometry"
    assert any(
        error["path"] == expected_path
        for error in captured.value.detail["errors"]
    )


@pytest.mark.parametrize(
    ("field_name", "canvas_value"),
    [
        ("canvas_width", 793),
        ("canvas_width", 795),
        ("canvas_width", 794.0),
        ("canvas_width", float("inf")),
        ("canvas_height", 1122),
        ("canvas_height", 1124),
        ("canvas_height", 1123.0),
    ],
)
def test_template_layout_rejects_unsafe_canvas_dimensions(
    field_name,
    canvas_value,
):
    layout = smoke_layout()
    layout[field_name] = canvas_value

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.detail["code"] == "invalid_layout_geometry"
    assert captured.value.detail["errors"][0]["path"] == field_name


def test_layout_geometry_allows_deliberate_off_canvas_clipping():
    layout = smoke_layout()
    layout["photo_slots"][0]["x"] = -layout["canvas_width"] * 2
    layout["text_labels"][0]["y"] = layout["canvas_height"] * 3
    layout["stickers"] = [{
        **_sticker(),
        "x": layout["canvas_width"] * 3,
        "y": -layout["canvas_height"] * 2,
    }]

    assert normalize_template_page_layout(layout) == layout


@pytest.mark.parametrize("group_contract", ["flat-world-v1", "nested-world-v2"])
def test_grouped_leaf_geometry_is_validated_for_v1_and_nested_v2(group_contract):
    if group_contract == "nested-world-v2":
        layout = _nested_layout()
    else:
        layout = smoke_layout()
        layout["group_contract"] = group_contract
        layout["stickers"] = [_sticker("material")]
        layout["groups"] = [{
            "id": "caption",
            "z_index": 0,
            "selection_rotation": 0,
            "children": [
                {"type": "sticker", "id": "material"},
                {"type": "text", "id": 1},
            ],
        }]
    layout["stickers"][0]["width"] = float("inf")

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.detail["code"] == "invalid_layout_geometry"
    assert any(
        error["path"] == "stickers[0].width"
        for error in captured.value.detail["errors"]
    )


def test_snapshot_rejects_internal_text_layout_source_and_renderer_checks_old_data():
    layout = smoke_layout()
    layout["text_labels"][0]["_text_layout_source"] = {
        "width": 360,
        "height": 96,
        "font_size": 1_000_000_000,
        "line_height": 1.4,
        "letter_spacing": 0,
    }

    with pytest.raises(HTTPException) as captured:
        normalize_template_page_layout(layout)

    assert captured.value.detail["code"] == "invalid_layout_geometry"
    assert any(
        error["path"] == "text_labels[0]._text_layout_source"
        for error in captured.value.detail["errors"]
    )

    with pytest.raises(LayoutGeometryValidationError) as render_error:
        render_page(layout, "學生", {})
    assert any(
        error["path"] == "text_labels[0]._text_layout_source.font_size"
        for error in render_error.value.errors
    )


def test_snapshot_rejects_many_individually_safe_elements_and_cumulative_buffers():
    too_many = smoke_layout()
    too_many["photo_slots"] = []
    too_many["text_labels"] = []
    too_many["stickers"] = [
        {**_sticker(index), "width": 1, "height": 1}
        for index in range(MAX_RENDERABLE_LEAF_COUNT + 1)
    ]
    with pytest.raises(HTTPException) as count_error:
        normalize_template_page_layout(too_many)
    assert any(
        error["path"] == "elements"
        and "element count" in error["message"]
        for error in count_error.value.detail["errors"]
    )

    cumulative = smoke_layout()
    cumulative["photo_slots"] = []
    cumulative["text_labels"] = []
    cumulative["stickers"] = [
        {
            **_sticker(index),
            "x": 0,
            "y": 0,
            "width": cumulative["canvas_width"],
            "height": cumulative["canvas_height"],
        }
        for index in range(9)
    ]
    with pytest.raises(HTTPException) as area_error:
        normalize_template_page_layout(cumulative)
    assert any(
        error["path"] == "elements"
        and "render buffers" in error["message"]
        for error in area_error.value.detail["errors"]
    )


def test_invalid_snapshot_has_zero_commit_and_zero_render_allocation(monkeypatch):
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        before_template = client.get(f"/api/templates/{template_id}").json()
        commit_calls = []
        allocation_calls = []

        def unexpected_commit(_session):
            commit_calls.append(True)
            raise AssertionError("invalid snapshot must not commit")

        def unexpected_image_allocation(*_args, **_kwargs):
            allocation_calls.append(True)
            raise AssertionError("invalid snapshot must not allocate render images")

        monkeypatch.setattr(Session, "commit", unexpected_commit)
        monkeypatch.setattr(render_service.Image, "new", unexpected_image_allocation)

        invalid_layouts = []
        giant_border = deepcopy(before_template["pages"][0]["layout"])
        giant_border["photo_slots"][0]["border_width"] = 1_000_000_000
        invalid_layouts.append(giant_border)

        non_finite_photo = deepcopy(before_template["pages"][0]["layout"])
        non_finite_photo["photo_slots"][0]["x"] = float("nan")
        invalid_layouts.append(non_finite_photo)

        nested_sticker = _nested_layout()
        nested_sticker["stickers"][0]["height"] = float("inf")
        invalid_layouts.append(nested_sticker)

        for invalid_layout in invalid_layouts:
            payload = {
                "expected_page_ids": [page_id],
                "expected_revision": before_template["revision"],
                "pages": [{"id": page_id, "layout": invalid_layout}],
            }
            response = client.put(
                f"/api/templates/{template_id}/pages",
                content=json.dumps(payload, allow_nan=True),
                headers={"content-type": "application/json"},
            )
            assert_status(response, 422)
            assert response.json()["detail"]["code"] == "invalid_layout_geometry"

        after_template = client.get(f"/api/templates/{template_id}").json()
        assert after_template == before_template
        assert commit_calls == []
        assert allocation_calls == []


def test_renderer_rejects_unsafe_geometry_and_page_count_before_allocation(monkeypatch):
    def unexpected_image_allocation(*_args, **_kwargs):
        raise AssertionError("geometry guard must run before Image.new")

    monkeypatch.setattr(render_service.Image, "new", unexpected_image_allocation)

    unsafe_layout = smoke_layout()
    unsafe_layout["photo_slots"][0]["border_width"] = 1_000_000_000
    with pytest.raises(LayoutGeometryValidationError):
        render_page(unsafe_layout, "學生", {})

    too_many_pages = [
        deepcopy(smoke_layout())
        for _ in range(MAX_TEMPLATE_RENDER_PAGES + 1)
    ]
    with pytest.raises(LayoutGeometryValidationError):
        render_album(too_many_pages, "學生", [])


def test_snapshot_and_renderer_reject_more_than_safe_page_count_before_writes(
    monkeypatch,
):
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        template = client.get(f"/api/templates/{template_id}").json()
        commit_calls = []

        def unexpected_commit(_session):
            commit_calls.append(True)
            raise AssertionError("oversized snapshot must not commit")

        monkeypatch.setattr(Session, "commit", unexpected_commit)
        pages = [{"id": page_id, "layout": smoke_layout()}]
        pages.extend(
            {
                "client_id": f"page-{index}",
                "layout": smoke_layout(),
            }
            for index in range(MAX_TEMPLATE_RENDER_PAGES)
        )
        response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [page_id],
                "expected_revision": template["revision"],
                "pages": pages,
            },
        )

        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "invalid_template_page_snapshot"
        assert commit_calls == []


def test_copy_template_preflights_unsafe_source_layout_without_persisting_target():
    with started_client() as client:
        login(client)
        source_template_id, source_page_id = create_template_with_page(client)
        db = SessionLocal()
        try:
            source_page = db.get(TemplatePage, source_page_id)
            unsafe_layout = json.loads(source_page.layout_json)
            unsafe_layout["photo_slots"][0]["border_width"] = 1_000_000_000
            source_page.layout_json = json.dumps(unsafe_layout)
            db.commit()
        finally:
            db.close()

        target_name = unique_name("unsafe-copy")
        response = client.post(
            "/api/templates/",
            data={
                "name": target_name,
                "source_template_id": str(source_template_id),
            },
        )

        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "invalid_layout_geometry"
        template_names = {
            template["name"]
            for template in client.get("/api/templates/").json()
        }
        assert target_name not in template_names


def test_copy_template_rejects_oversized_source_before_storage_or_target_commit(
    monkeypatch,
):
    with started_client() as client:
        login(client)
        source_template_id, _ = create_template_with_page(client)
        db = SessionLocal()
        try:
            for page_number in range(1, MAX_TEMPLATE_RENDER_PAGES + 1):
                db.add(TemplatePage(
                    template_id=source_template_id,
                    page_number=page_number,
                    layout_json=json.dumps(smoke_layout()),
                ))
            db.commit()
        finally:
            db.close()

        storage_calls = []

        def unexpected_storage():
            storage_calls.append(True)
            raise AssertionError("oversized copy must fail before storage access")

        monkeypatch.setattr(
            "services.template_service.get_storage",
            unexpected_storage,
        )
        target_name = unique_name("oversized-copy")
        response = client.post(
            "/api/templates/",
            data={
                "name": target_name,
                "source_template_id": str(source_template_id),
            },
        )

        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "invalid_template_page_snapshot"
        assert storage_calls == []
        template_names = {
            template["name"]
            for template in client.get("/api/templates/").json()
        }
        assert target_name not in template_names


def test_legacy_add_page_endpoint_can_retry_existing_project_confirmation():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        create_project(client, template_id)

        confirmation = client.post(f"/api/templates/{template_id}/pages")
        assert_status(confirmation, 409)
        detail = confirmation.json()["detail"]
        assert detail["code"] == "template_structure_confirmation_required"

        applied = client.post(
            f"/api/templates/{template_id}/pages",
            params={
                "confirm_project_sync": "true",
                "project_sync_change_hash": detail["change_hash"],
            },
        )
        assert_status(applied, 200)
        assert applied.json()["page_number"] == 1


def test_legacy_layout_endpoint_can_retry_structural_confirmation():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        create_project(client, template_id)
        layout = deepcopy(smoke_layout())
        layout["photo_slots"] = []

        confirmation = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            json=layout,
        )
        assert_status(confirmation, 409)
        detail = confirmation.json()["detail"]

        applied = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            params={
                "confirm_project_sync": "true",
                "project_sync_change_hash": detail["change_hash"],
            },
            json=layout,
        )
        assert_status(applied, 200)


@pytest.mark.parametrize(
    "invalid_identity",
    [True, 1.5],
)
def test_template_snapshot_rejects_non_integer_page_identities(invalid_identity):
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        template = client.get(f"/api/templates/{template_id}").json()

        response = client.put(
            f"/api/templates/{template_id}/pages",
            json={
                "expected_page_ids": [page_id],
                "expected_revision": template["revision"],
                "pages": [{
                    "id": invalid_identity,
                    "layout": smoke_layout(),
                }],
            },
        )

        assert_status(response, 422)
