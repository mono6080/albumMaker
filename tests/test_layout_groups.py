import json
from copy import deepcopy
from pathlib import Path

from PIL import ImageChops

from database import SessionLocal, TemplatePage
from services.layout_groups import (
    MAX_JAVASCRIPT_SAFE_INTEGER,
    build_layout_render_tree,
    canonical_id,
    iter_layout_render_elements,
    validate_layout_groups,
)
from services.preview_cache import PREVIEW_CACHE_VERSION
from services.student_render_service import _RENDER_PIPELINE_FILES
from services.render_service import (
    render_album,
    render_page,
    render_preview_page,
    scale_layout_for_preview,
)
from services.storage import get_storage
from services.template_service import _copy_layout_sticker_assets
from tests.helpers import (
    assert_status,
    create_template_with_page,
    login,
    png_bytes,
    replace_template_page_layout,
    started_client,
    template_page_snapshot_payload,
    use_tmp_uploads,
)


def _layout_with_group() -> dict:
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "photo_slots": [],
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


def test_render_traversal_skips_hidden_leaf_and_group_subtree():
    layout = _layout_with_group()
    layout["groups"][0]["visible"] = False

    assert [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ] == [("sticker", 303)]

    layout["stickers"][1]["visible"] = False
    assert list(iter_layout_render_elements(layout)) == []


def test_malformed_group_fallback_still_skips_hidden_leaves():
    layout = _layout_with_group()
    layout["groups"][0]["visible"] = False
    layout["groups"][0]["children"][1]["id"] = "missing"
    layout["stickers"][0]["visible"] = False

    assert [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ] == [("text", "202"), ("sticker", 303)]


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
            f"/api/templates/{template_id}/pages",
            json=template_page_snapshot_payload(client, template_id, page_id, invalid),
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


def test_layout_save_strips_empty_legacy_bubbles_and_rejects_nonempty_values():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        layout = {
            "canvas_width": 794,
            "canvas_height": 1123,
            "photo_slots": [],
            "text_labels": [],
            "stickers": [],
            "text_bubbles": [],
        }

        response = replace_template_page_layout(client, template_id, page_id, layout)
        assert_status(response, 200)
        db = SessionLocal()
        try:
            stored = json.loads(db.get(TemplatePage, page_id).layout_json)
        finally:
            db.close()
        assert "text_bubbles" not in stored

        layout["text_bubbles"] = [{"id": "legacy-bubble"}]
        response = client.put(
            f"/api/templates/{template_id}/pages",
            json=template_page_snapshot_payload(client, template_id, page_id, layout),
        )
        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "removed_layout_element"


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


def test_nested_v2_and_flat_layout_render_identical_overlapping_pixels(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)
    storage = get_storage()
    path = "templates/tmpl1/stickers/art.png"
    storage.put(path, png_bytes((80, 60), (245, 204, 72, 255)))

    flat = _layout_with_group()
    flat.pop("group_contract")
    flat.pop("groups")
    flat["stickers"][1].update({"x": 30, "y": 20, "width": 80, "height": 60})

    nested = deepcopy(flat)
    nested["group_contract"] = "nested-world-v2"
    nested["groups"] = [
        {
            "id": "inner",
            "z_index": 0,
            "selection_rotation": 0,
            "children": [
                {"type": "sticker", "id": 101},
                {"type": "text", "id": "202"},
            ],
        },
        {
            "id": "outer",
            "z_index": 10,
            "selection_rotation": 0,
            "children": [
                {"type": "group", "id": "inner"},
                {"type": "sticker", "id": 303},
            ],
        },
    ]
    nested["material_text_links"] = [
        {"kind": "material-text-v1", "material_id": 101, "text_id": "202"}
    ]

    assert validate_layout_groups(nested) == []
    flat_image = render_page(flat, "Ada", {}, page_index=0)
    nested_image = render_page(nested, "Ada", {}, page_index=0)
    assert ImageChops.difference(flat_image, nested_image).getbbox() is None


def test_render_reaches_flat_fallback_before_preprocessing_malformed_photo_collection(
    monkeypatch, tmp_path
):
    use_tmp_uploads(monkeypatch, tmp_path)
    path = "templates/tmpl1/stickers/art.png"
    get_storage().put(path, png_bytes((80, 60), (245, 204, 72, 255)))
    layout = _layout_with_group()
    layout["group_contract"] = "nested-world-v2"
    layout["groups"][0].pop("links")
    layout["photo_slots"] = {"not": "an array"}

    image = render_page(layout, "Ada", {}, page_index=0)

    assert image.size == (794, 1123)


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
    source_names = {path.name for path in _RENDER_PIPELINE_FILES}
    assert "layout_group_validation.py" in source_names
    assert "layout_group_traversal.py" in source_names
    assert PREVIEW_CACHE_VERSION == "project-preview-v11-jpeg"


def test_unknown_contract_is_invalid_even_without_nonempty_groups():
    for groups_value in (None, []):
        layout = {"group_contract": "future-world-v99"}
        if groups_value is not None:
            layout["groups"] = groups_value

        errors = validate_layout_groups(layout)

        assert errors == [
            {
                "path": "group_contract",
                "group_id": None,
                "child_type": None,
                "child_id": None,
                "message": (
                    "group_contract must be 'flat-world-v1' or 'nested-world-v2'"
                ),
            }
        ]


def test_numeric_ids_are_limited_to_javascript_safe_integer_boundaries():
    limit = MAX_JAVASCRIPT_SAFE_INTEGER
    assert canonical_id(limit) == str(limit)
    assert canonical_id(-limit) == str(-limit)
    # JSON numbers lose the lexical difference between 1 and 1.0 in JS.
    assert canonical_id(1.0) == "1"
    assert canonical_id(-0.0) == "0"
    assert canonical_id(float(limit)) == str(limit)
    # The restriction is numeric-only; opaque string IDs remain valid.
    assert canonical_id(str(limit + 1)) == str(limit + 1)

    for invalid_id in (limit + 1, -limit - 1, 1.5, float("inf"), float("nan")):
        try:
            canonical_id(invalid_id)
        except ValueError as exc:
            if isinstance(invalid_id, int):
                assert str(exc) == "ID integer must be within JavaScript safe integer range"
        else:
            raise AssertionError(f"unsafe numeric ID was accepted: {invalid_id}")

    layout = _layout_with_group()
    layout["groups"][0]["id"] = limit + 1
    errors = validate_layout_groups(layout)
    assert any(
        error["path"] == "groups[0].id"
        and error["message"] == "ID integer must be within JavaScript safe integer range"
        for error in errors
    )

    float_layout = _layout_with_group()
    float_layout["stickers"][0]["id"] = 101.0
    float_layout["groups"][0]["children"][0]["id"] = 101
    assert validate_layout_groups(float_layout) == []


def test_layout_save_rejects_unknown_contract_without_groups():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)
        layout = _layout_with_group()
        layout.pop("groups")
        layout["group_contract"] = "future-world-v99"

        response = client.put(
            f"/api/templates/{template_id}/pages",
            json=template_page_snapshot_payload(client, template_id, page_id, layout),
        )

        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "invalid_layout_group"
        assert response.json()["detail"]["errors"][0]["path"] == "group_contract"


def test_v1_rejects_null_links_and_huge_non_finite_metadata_without_crashing():
    null_links = _layout_with_group()
    null_links["groups"][0]["links"] = None
    null_errors = validate_layout_groups(null_links)
    assert any(
        error["path"] == "groups[0].links"
        and error["message"] == "links must be an array"
        for error in null_errors
    )

    huge_number = _layout_with_group()
    huge_number["groups"][0]["z_index"] = 10 ** 10000
    huge_errors = validate_layout_groups(huge_number)
    assert any(
        error["path"] == "groups[0].z_index"
        and error["message"] == "z_index must be a finite number"
        for error in huge_errors
    )


def test_shared_nested_fixture_has_exact_backend_traversal_order():
    fixture_path = Path(__file__).parent / "fixtures" / "nested_group_layout.json"
    layout = json.loads(fixture_path.read_text(encoding="utf-8"))

    assert validate_layout_groups(layout) == []
    assert [
        (element_type, element["id"], original_index)
        for element_type, element, original_index in iter_layout_render_elements(layout)
    ] == [
        ("photo", "photo-root", 1),
        ("photo", "photo-inner", 0),
        ("text", "text-inner", 0),
        ("sticker", "sticker-outer", 0),
        ("text", "text-root", 1),
    ]


def _nested_v2_layout() -> dict:
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "group_contract": "nested-world-v2",
        "photo_slots": [
            {"id": "photo-root", "x": 0, "y": 0, "width": 40, "height": 30, "z_index": 0},
            {"id": "photo-child", "x": 50, "y": 0, "width": 40, "height": 30, "z_index": 1},
        ],
        "text_labels": [
            {"id": "text-outer", "x": 0, "y": 40, "width": 40, "height": 30, "z_index": 2},
            {"id": "text-1", "x": 50, "y": 40, "width": 40, "height": 30, "z_index": 3},
        ],
        "stickers": [
            {"id": "sticker-1", "x": 100, "y": 40, "width": 40, "height": 30, "z_index": 4},
        ],
        # Parent deliberately precedes its child in registry order, proving
        # registry order is not a topological-order requirement.
        "groups": [
            {
                "id": "outer",
                "z_index": 10,
                "selection_rotation": 0,
                "children": [
                    {"type": "text", "id": "text-outer"},
                    {"type": "group", "id": "inner"},
                    {"type": "photo", "id": "photo-child"},
                ],
            },
            {
                "id": "inner",
                "z_index": 999,
                "selection_rotation": 0,
                "children": [
                    {"type": "sticker", "id": "sticker-1"},
                    {"type": "text", "id": "text-1"},
                ],
            },
        ],
        "material_text_links": [
            {
                "kind": "material-text-v1",
                "material_id": "sticker-1",
                "text_id": "text-1",
            }
        ],
        "footer": None,
        "logo": None,
    }


def test_v2_nested_tree_supports_all_leaf_types_and_preserves_photo_index():
    layout = _nested_v2_layout()

    assert validate_layout_groups(layout) == []
    tree = build_layout_render_tree(layout)
    traversal = [
        (element_type, element["id"], original_index)
        for element_type, element, original_index in iter_layout_render_elements(layout)
    ]

    assert [node["kind"] for node in tree] == ["element", "group"]
    assert [node["kind"] for node in tree[1]["children"]] == ["element", "group", "element"]
    assert [node["type"] for node in tree[1]["children"][1]["children"]] == ["sticker", "text"]
    assert traversal == [
        ("photo", "photo-root", 0),
        ("text", "text-outer", 0),
        ("sticker", "sticker-1", 0),
        ("text", "text-1", 1),
        ("photo", "photo-child", 1),
    ]


def test_v2_hidden_ancestor_skips_its_whole_nested_subtree():
    layout = _nested_v2_layout()
    layout["photo_slots"][0]["visible"] = False
    layout["groups"][1]["visible"] = False

    assert [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ] == [("text", "text-outer"), ("photo", "photo-child")]


def test_v2_validator_reports_cycle_self_missing_and_multi_parent_paths():
    cycle_layout = _nested_v2_layout()
    cycle_layout["groups"][1]["children"][1] = {"type": "group", "id": "outer"}
    cycle_errors = validate_layout_groups(cycle_layout)
    assert any(
        error["path"] == "groups[1].children[1]"
        and error["message"] == "group graph contains a cycle"
        for error in cycle_errors
    )

    self_layout = _nested_v2_layout()
    self_layout["groups"][1]["children"][1] = {"type": "group", "id": "inner"}
    self_errors = validate_layout_groups(self_layout)
    assert any(error["message"] == "group cannot reference itself" for error in self_errors)

    broken_layout = _nested_v2_layout()
    broken_layout["groups"][0]["links"] = []
    broken_layout["groups"].append(
        {
            "id": "other",
            "z_index": 20,
            "selection_rotation": 0,
            "children": [
                {"type": "photo", "id": "photo-child"},
                {"type": "text", "id": "missing"},
            ],
        }
    )
    broken_errors = validate_layout_groups(broken_layout)
    messages = {error["message"] for error in broken_errors}
    assert "v2 links must be stored in material_text_links" in messages
    assert "child already belongs to another group" in messages
    assert "child ref does not exist" in messages
    assert all(
        set(error) == {"path", "group_id", "child_type", "child_id", "message"}
        for error in broken_errors
    )


def test_v2_top_level_links_validate_without_requiring_groups():
    link_only = _nested_v2_layout()
    link_only.pop("groups")
    assert validate_layout_groups(link_only) == []

    wrong_contract = deepcopy(link_only)
    wrong_contract["group_contract"] = "flat-world-v1"
    wrong_contract_errors = validate_layout_groups(wrong_contract)
    assert any(
        error["path"] == "group_contract"
        and "top-level material_text_links require" in error["message"]
        for error in wrong_contract_errors
    )

    malformed = _nested_v2_layout()
    malformed["material_text_links"].append(
        {"kind": "wrong", "material_id": "sticker-1", "text_id": "missing"}
    )
    malformed_errors = validate_layout_groups(malformed)
    assert any(error["path"] == "material_text_links[1].kind" for error in malformed_errors)
    assert any(
        error["path"] == "material_text_links[1].material_id"
        and error["message"] == "link endpoint is already linked"
        for error in malformed_errors
    )
    assert any(
        error["path"] == "material_text_links[1].text_id"
        and error["message"] == "link endpoint does not exist"
        for error in malformed_errors
    )


def test_v2_malformed_links_do_not_flatten_valid_topology(caplog):
    layout = _nested_v2_layout()
    layout["material_text_links"][0]["text_id"] = "missing"

    traversal = [
        (element_type, element["id"])
        for element_type, element, _ in iter_layout_render_elements(layout)
    ]

    assert traversal == [
        ("photo", "photo-root"),
        ("text", "text-outer"),
        ("sticker", "sticker-1"),
        ("text", "text-1"),
        ("photo", "photo-child"),
    ]
    assert "malformed persisted material_text_links" in caplog.text

    caplog.clear()
    link_only = deepcopy(layout)
    link_only.pop("groups")
    list(iter_layout_render_elements(link_only))
    assert "malformed persisted material_text_links" in caplog.text

    malformed_topology = deepcopy(layout)
    malformed_topology["groups"][0]["children"][2]["id"] = "missing-photo"
    flattened = deepcopy(malformed_topology)
    flattened.pop("groups")
    flattened.pop("group_contract")
    flattened.pop("material_text_links")
    assert [
        (element_type, element["id"], index)
        for element_type, element, index in iter_layout_render_elements(malformed_topology)
    ] == [
        (element_type, element["id"], index)
        for element_type, element, index in iter_layout_render_elements(flattened)
    ]


def test_v2_deep_graph_validation_and_traversal_are_iterative():
    depth = 1500
    layout = {
        "group_contract": "nested-world-v2",
        "photo_slots": [],
        "stickers": [],
        "text_labels": [
            {"id": f"text-{index}", "z_index": index}
            for index in range(depth + 1)
        ],
        "groups": [],
    }
    for index in range(depth):
        second_child = (
            {"type": "group", "id": f"group-{index + 1}"}
            if index + 1 < depth
            else {"type": "text", "id": f"text-{depth}"}
        )
        layout["groups"].append(
            {
                "id": f"group-{index}",
                "z_index": index,
                "selection_rotation": 0,
                "children": [
                    {"type": "text", "id": f"text-{index}"},
                    second_child,
                ],
            }
        )

    assert validate_layout_groups(layout) == []
    traversal = list(iter_layout_render_elements(layout))
    assert len(traversal) == depth + 1
    assert traversal[0][1]["id"] == "text-0"
    assert traversal[-1][1]["id"] == f"text-{depth}"
    assert traversal[-1][2] == depth


def test_unhashable_child_types_are_invalid_and_persisted_layouts_flatten():
    for layout_factory in (_layout_with_group, _nested_v2_layout):
        for invalid_child_type in ([], {}):
            layout = layout_factory()
            layout["groups"][0]["children"][0]["type"] = invalid_child_type

            errors = validate_layout_groups(layout)
            assert any(
                error["path"] == "groups[0].children[0].type"
                and error["child_type"] == invalid_child_type
                for error in errors
            )

            flat_layout = deepcopy(layout)
            flat_layout.pop("group_contract", None)
            flat_layout.pop("groups", None)
            flat_layout.pop("material_text_links", None)
            assert list(iter_layout_render_elements(layout)) == list(
                iter_layout_render_elements(flat_layout)
            )


def test_layout_save_returns_422_for_unhashable_child_types():
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)

        for layout_factory in (_layout_with_group, _nested_v2_layout):
            for invalid_child_type in ([], {}):
                layout = layout_factory()
                layout["groups"][0]["children"][0]["type"] = invalid_child_type

                response = client.put(
                    f"/api/templates/{template_id}/pages",
                    json=template_page_snapshot_payload(client, template_id, page_id, layout),
                )

                assert_status(response, 422)
                detail = response.json()["detail"]
                assert detail["code"] == "invalid_layout_group"
                assert any(
                    error["path"] == "groups[0].children[0].type"
                    and error["child_type"] == invalid_child_type
                    for error in detail["errors"]
                )


def test_preview_and_formal_scaling_tolerate_malformed_collections_and_items():
    malformed_collection = _nested_v2_layout()
    malformed_collection["photo_slots"] = {"not": "an array"}
    scaled_collection = scale_layout_for_preview(malformed_collection, 0.5)
    assert scaled_collection["photo_slots"] == {"not": "an array"}

    malformed_item = _nested_v2_layout()
    malformed_item["text_labels"].insert(0, ["not", "an object"])
    scaled_item = scale_layout_for_preview(malformed_item, 0.5)
    assert scaled_item["text_labels"][0] == ["not", "an object"]

    for layout, scaled_layout in (
        (malformed_collection, scaled_collection),
        (malformed_item, scaled_item),
    ):
        list(iter_layout_render_elements(scaled_layout))

        preview = render_preview_page(layout, "Ada", {}, scale=0.5)
        assert preview.size == (397, 562)

        formal = render_album(
            [layout],
            student_name="Ada",
            pages_data=[{"page_index": 0}],
            output_size=(480, 360),
        )[0]
        assert formal.size == (480, 360)


def test_layout_save_returns_json_safe_422_for_nonfinite_raw_child_ids():
    raw_cases = (
        ("NaN", "NaN"),
        ("Infinity", "Infinity"),
        ("-Infinity", "-Infinity"),
        ('{"nested": NaN}', {"nested": "NaN"}),
    )
    with started_client() as client:
        login(client)
        template_id, page_id = create_template_with_page(client)

        for raw_value, expected_diagnostic in raw_cases:
            layout = _nested_v2_layout()
            layout["groups"][0]["children"][0]["id"] = "__RAW_ID__"
            snapshot_payload = template_page_snapshot_payload(
                client,
                template_id,
                page_id,
                layout,
            )
            raw_body = json.dumps(snapshot_payload).replace('"__RAW_ID__"', raw_value, 1)

            response = client.put(
                f"/api/templates/{template_id}/pages",
                content=raw_body,
                headers={"content-type": "application/json"},
            )

            assert_status(response, 422)
            detail = response.json()["detail"]
            assert detail["code"] == "invalid_layout_group"
            error = next(
                error
                for error in detail["errors"]
                if error["path"] == "groups[0].children[0].id"
            )
            assert error["child_id"] == expected_diagnostic
