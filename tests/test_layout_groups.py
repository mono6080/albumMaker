import json
from copy import deepcopy

from PIL import ImageChops

from database import SessionLocal, TemplatePage
from services.layout_groups import (
    build_layout_render_tree,
    iter_layout_render_elements,
    validate_layout_groups,
)
from services.preview_cache import PREVIEW_CACHE_VERSION
from services.project_service import _RENDER_PIPELINE_FILES
from services.render_service import render_page
from services.storage import get_storage
from services.template_service import _copy_layout_sticker_assets
from tests.helpers import (
    assert_status,
    create_template_with_page,
    login,
    png_bytes,
    started_client,
    use_tmp_uploads,
)


def _layout_with_group() -> dict:
    return {
        "canvas_width": 160,
        "canvas_height": 120,
        "photo_slots": [],
        "text_bubbles": [],
        "group_contract": "flat-world-v1",
        "groups": [
            {
                "id": 900,
                "z_index": 10,
                "selection_rotation": 0,
                "children": [
                    {"type": "sticker", "id": 101},
                    {"type": "text", "id": "202"},
                ],
                "links": [
                    {
                        "kind": "material-text-v1",
                        "material_id": 101,
                        "text_id": "202",
                    }
                ],
            }
        ],
        "stickers": [
            {
                "id": 101,
                "path": "templates/tmpl1/stickers/art.png",
                "x": 10,
                "y": 10,
                "width": 100,
                "height": 70,
                "rotation": 0,
                "z_index": 10,
            },
            {
                "id": 303,
                "path": "templates/tmpl1/stickers/art.png",
                "x": 120,
                "y": 10,
                "width": 30,
                "height": 30,
                "rotation": 0,
                "z_index": 12,
            },
        ],
        "text_labels": [
            {
                "id": "202",
                "x": 20,
                "y": 25,
                "width": 80,
                "height": 40,
                "rotation": 0,
                "text": "Group",
                "text_role": "static",
                "font_size": 18,
                "font_color": "#111111",
                "z_index": 11,
            }
        ],
        "footer": None,
        "logo": None,
    }


def test_render_tree_groups_children_once_and_preserves_internal_order():
    layout = _layout_with_group()

    tree = build_layout_render_tree(layout)
    traversal = [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ]

    assert [node["kind"] for node in tree] == ["group", "element"]
    assert [child["type"] for child in tree[0]["children"]] == ["sticker", "text"]
    assert traversal == [("sticker", 101), ("text", "202"), ("sticker", 303)]


def test_equal_z_tie_break_uses_legacy_type_before_group_array_order():
    layout = _layout_with_group()
    layout["stickers"][1]["z_index"] = 10

    tree = build_layout_render_tree(layout)

    assert [node["kind"] for node in tree] == ["element", "group"]
    assert tree[0]["type"] == "sticker"


def test_malformed_persisted_groups_fall_back_to_complete_legacy_traversal(caplog):
    layout = _layout_with_group()
    layout["groups"][0]["children"][1]["id"] = "missing"

    traversal = [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ]

    assert traversal == [("sticker", 101), ("text", "202"), ("sticker", 303)]
    assert "legacy flat traversal" in caplog.text


def test_validator_reports_normalized_id_collision_membership_and_invalid_link():
    layout = _layout_with_group()
    layout["text_labels"].append({"id": 202})
    layout["groups"].append(
        {
            "id": "900",
            "z_index": 20,
            "selection_rotation": 0,
            "children": [
                {"type": "sticker", "id": 101},
                {"type": "group", "id": 900},
            ],
            "links": [
                {"kind": "wrong", "material_id": 101, "text_id": "missing"}
            ],
        }
    )

    errors = validate_layout_groups(layout)
    messages = {error["message"] for error in errors}

    assert "element ID collides after string normalization" in messages
    assert "group ID collides after string normalization" in messages
    assert "child already belongs to another group" in messages
    assert "child type must be 'text' or 'sticker'" in messages
    assert "link kind must be 'material-text-v1'" in messages
    assert all(set(error) == {"path", "group_id", "child_type", "child_id", "message"} for error in errors)


def test_layout_save_rejects_invalid_groups_without_mutating_stored_layout():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        invalid = _layout_with_group()
        invalid["groups"][0]["children"][1]["id"] = "missing"

        response = client.put(
            f"/api/templates/{template_id}/pages/{page_id}/layout",
            json=invalid,
        )

        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "invalid_layout_group"
        assert response.json()["detail"]["errors"][0]["path"]
        db = SessionLocal()
        try:
            stored = json.loads(db.get(TemplatePage, page_id).layout_json)
        finally:
            db.close()
        assert "groups" not in stored


def test_grouped_and_flat_layout_render_identical_pixels(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    storage = get_storage()
    path = "templates/tmpl1/stickers/art.png"
    storage.put(path, png_bytes((80, 60), (245, 204, 72, 255)))
    flat = _layout_with_group()
    flat.pop("group_contract")
    flat.pop("groups")
    grouped = _layout_with_group()

    flat_image = render_page(flat, "Ada", {}, page_index=0)
    grouped_image = render_page(grouped, "Ada", {}, page_index=0)

    assert ImageChops.difference(flat_image, grouped_image).getbbox() is None


class _CopyRecordingStorage:
    def __init__(self):
        self.calls = []

    def get_bytes(self, source):
        self.calls.append(("get", source))
        return b"image"

    def put(self, target, data):
        assert data == b"image"
        source = self.calls[-1][1]
        self.calls.append((source, target))


def test_template_copy_preserves_group_refs_and_asset_revision_while_rewriting_path():
    layout = _layout_with_group()
    layout["stickers"][0]["asset_revision"] = "sha256:" + "a" * 64
    original_groups = deepcopy(layout["groups"])
    storage = _CopyRecordingStorage()

    copied = _copy_layout_sticker_assets(layout, 1, 2, storage)

    assert copied["groups"] == original_groups
    assert copied["stickers"][0]["asset_revision"] == "sha256:" + "a" * 64
    assert copied["stickers"][0]["path"] == "templates/tmpl2/stickers/art.png"
    assert layout["stickers"][0]["path"] == "templates/tmpl1/stickers/art.png"


def test_group_traversal_participates_in_render_and_preview_cache_versions():
    assert "layout_groups.py" in {path.name for path in _RENDER_PIPELINE_FILES}
    assert PREVIEW_CACHE_VERSION == "project-preview-v4-groups"
