from copy import deepcopy
import csv
import json
import sqlite3
from types import SimpleNamespace

import scripts.backfill_material_text_links as backfill_script
from scripts.backfill_material_text_links import (
    LinkPair,
    TemplateBackfillPlan,
    add_material_text_links,
    find_safe_material_text_pairs,
    write_report,
)
from services.layout_group_traversal import layout_for_render_fingerprint


def _layout():
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "photo_slots": [],
        "stickers": [{
            "id": 10,
            "path": "templates/tmpl1/stickers/bubble.png",
            "filename": "bubble.png",
            "x": 100,
            "y": 200,
            "width": 300,
            "height": 180,
            "rotation": 0,
            "z_index": 1,
        }],
        "text_labels": [{
            "id": 20,
            "x": 140,
            "y": 240,
            "width": 220,
            "height": 100,
            "rotation": 0,
            "z_index": 2,
            "text": "{name}的文字",
        }],
    }


def test_safe_pair_is_linked_without_changing_render_fingerprint():
    layout = _layout()

    pairs, report_rows = find_safe_material_text_pairs(layout)
    linked = add_material_text_links(layout, pairs)

    assert pairs == [LinkPair(material_id=10, text_id=20)]
    assert [row["status"] for row in report_rows] == ["planned"]
    assert linked["group_contract"] == "nested-world-v2"
    assert linked["material_text_links"] == [{
        "kind": "material-text-v1",
        "material_id": 10,
        "text_id": 20,
    }]
    assert layout_for_render_fingerprint(linked) == layout_for_render_fingerprint(layout)
    assert linked["text_labels"] == layout["text_labels"]
    assert linked["stickers"] == layout["stickers"]


def test_static_and_noncontained_text_are_not_linked():
    layout = _layout()
    layout["text_labels"][0]["text_role"] = "static"
    layout["text_labels"].append({
        "id": 21,
        "x": 500,
        "y": 500,
        "width": 120,
        "height": 60,
        "z_index": 2,
        "text": "框外文字",
    })

    pairs, report_rows = find_safe_material_text_pairs(layout)

    assert pairs == []
    assert {row["status"] for row in report_rows} == {"skipped_static", "unmatched"}


def test_same_sticker_matching_two_texts_is_ambiguous():
    layout = _layout()
    second_text = deepcopy(layout["text_labels"][0])
    second_text["id"] = 21
    second_text["y"] = 250
    layout["text_labels"].append(second_text)

    pairs, report_rows = find_safe_material_text_pairs(layout)

    assert pairs == []
    assert [row["status"] for row in report_rows] == ["ambiguous", "ambiguous"]


def test_hidden_or_default_order_text_is_not_auto_linked():
    hidden_layout = _layout()
    hidden_layout["text_labels"][0]["visible"] = False
    hidden_pairs, hidden_rows = find_safe_material_text_pairs(hidden_layout)

    default_order_layout = _layout()
    default_order_layout["text_labels"][0].pop("z_index")
    default_order_layout["stickers"][0].pop("z_index")
    default_pairs, default_rows = find_safe_material_text_pairs(default_order_layout)

    assert hidden_pairs == []
    assert [row["status"] for row in hidden_rows] == ["skipped_hidden"]
    assert default_pairs == []
    assert [row["status"] for row in default_rows] == ["unmatched"]


def test_v1_group_links_stay_in_same_group_when_new_link_is_added():
    layout = _layout()
    layout["group_contract"] = "flat-world-v1"
    layout["groups"] = [{
        "id": "pair",
        "z_index": 1,
        "selection_rotation": 0,
        "children": [
            {"type": "sticker", "id": 10},
            {"type": "text", "id": 20},
            {"type": "sticker", "id": 11},
            {"type": "text", "id": 21},
        ],
        "links": [{
            "kind": "material-text-v1",
            "material_id": 10,
            "text_id": 20,
        }],
    }]
    layout["stickers"].append({
        "id": 11,
        "path": "templates/tmpl1/stickers/bubble2.png",
        "filename": "bubble2.png",
        "x": 450,
        "y": 200,
        "width": 250,
        "height": 160,
        "z_index": 3,
    })
    layout["text_labels"].append({
        "id": 21,
        "x": 480,
        "y": 230,
        "width": 190,
        "height": 100,
        "z_index": 4,
        "text": "第二段",
    })

    updated = add_material_text_links(
        layout,
        [LinkPair(material_id=11, text_id=21)],
    )

    assert updated["group_contract"] == "flat-world-v1"
    assert "material_text_links" not in updated
    assert updated["groups"][0]["links"] == [
        {
            "kind": "material-text-v1",
            "material_id": 10,
            "text_id": 20,
        },
        {
            "kind": "material-text-v1",
            "material_id": 11,
            "text_id": 21,
        },
    ]
    assert layout_for_render_fingerprint(updated) == layout_for_render_fingerprint(layout)


def test_nested_ancestor_visibility_and_group_order_drive_pairing():
    hidden_layout = _layout()
    hidden_layout["group_contract"] = "nested-world-v2"
    hidden_layout["groups"] = [{
        "id": "hidden-parent",
        "z_index": 0,
        "selection_rotation": 0,
        "visible": False,
        "children": [
            {"type": "sticker", "id": 10},
            {"type": "text", "id": 20},
        ],
    }]

    hidden_pairs, hidden_rows = find_safe_material_text_pairs(hidden_layout)

    assert hidden_pairs == []
    assert [row["status"] for row in hidden_rows] == ["skipped_hidden"]

    reversed_layout = _layout()
    reversed_layout["group_contract"] = "nested-world-v2"
    reversed_layout["groups"] = [{
        "id": "reversed",
        "z_index": 0,
        "selection_rotation": 0,
        "children": [
            {"type": "text", "id": 20},
            {"type": "sticker", "id": 10},
        ],
    }]

    reversed_pairs, reversed_rows = find_safe_material_text_pairs(reversed_layout)

    assert reversed_pairs == []
    assert [row["status"] for row in reversed_rows] == ["unmatched"]


def test_v1_cross_group_pair_is_reported_but_not_upgraded():
    layout = _layout()
    layout["group_contract"] = "flat-world-v1"
    layout["groups"] = [{
        "id": "existing-pair",
        "z_index": 1,
        "selection_rotation": 0,
        "children": [
            {"type": "sticker", "id": 10},
            {"type": "text", "id": 20},
        ],
        "links": [{
            "kind": "material-text-v1",
            "material_id": 10,
            "text_id": 20,
        }],
    }]
    layout["stickers"].append({
        "id": 11,
        "path": "templates/tmpl1/stickers/bubble2.png",
        "x": 450,
        "y": 200,
        "width": 250,
        "height": 160,
        "z_index": 3,
    })
    layout["text_labels"].append({
        "id": 21,
        "x": 480,
        "y": 230,
        "width": 190,
        "height": 100,
        "z_index": 4,
        "text": "第二段",
    })

    pairs, rows = find_safe_material_text_pairs(layout)

    assert pairs == []
    assert [row["status"] for row in rows] == [
        "existing",
        "unsupported_v1_scope",
    ]


def test_backfill_csv_is_formula_safe(tmp_path):
    report_path = tmp_path / "report.csv"

    write_report(
        report_path,
        [{
            "template_id": 1,
            "template_name": "=HYPERLINK(\"https://invalid\")",
            "page_number": 1,
            "template_page_id": 2,
            "status": "planned",
            "text_id": "+1",
            "material_id": "@x",
            "reason": "-危險",
        }],
        "run-safe",
    )

    with report_path.open(encoding="utf-8-sig", newline="") as report_file:
        row = next(csv.DictReader(report_file))
    assert row["template_name"].startswith("'=")
    assert row["text_id"] == "'+1"
    assert row["material_id"] == "'@x"
    assert row["reason"] == "'-危險"
    assert row["run_id"] == "run-safe"


class _ApplyTemplateModel:
    pass


class _ApplySession:
    def __init__(self, templates):
        self.templates = templates

    def get(self, _model, template_id):
        return self.templates.get(template_id)

    def rollback(self):
        return None

    def expire_all(self):
        return None

    def refresh(self, _template):
        return None

    def expire(self, _template, _fields):
        return None

    def close(self):
        return None


def _make_apply_plan(template_id: int, page_id: int) -> TemplateBackfillPlan:
    return TemplateBackfillPlan(
        template_id=template_id,
        template_name=f"模板{template_id}",
        expected_revision=1,
        expected_page_ids=[page_id],
        page_items=[{"id": page_id, "client_id": None, "layout": {}}],
        changed_pages=[(page_id, json.dumps({"page": page_id}))],
    )


def test_backfill_main_reports_partial_and_rerun_keeps_distinct_backups(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """CREATE TABLE template_page_layout_migration_backups (
                   id INTEGER PRIMARY KEY,
                   migration_name TEXT NOT NULL,
                   template_page_id INTEGER NOT NULL,
                   layout_json TEXT NOT NULL,
                   UNIQUE(migration_name, template_page_id)
               )"""
        )
    plans = [_make_apply_plan(1, 101), _make_apply_plan(2, 201)]
    templates = {
        plan.template_id: SimpleNamespace(
            id=plan.template_id,
            revision=plan.expected_revision,
            pages=[
                SimpleNamespace(id=page_id)
                for page_id in plan.expected_page_ids
            ],
        )
        for plan in plans
    }
    current_snapshot = {"callback": None}

    def configure_backend(_database_path):
        return (
            lambda: _ApplySession(templates),
            _ApplyTemplateModel,
            lambda layout: layout,
            lambda _layout: [],
            lambda *args, **kwargs: current_snapshot["callback"](*args, **kwargs),
        )

    monkeypatch.setattr(backfill_script, "configure_backend", configure_backend)
    monkeypatch.setattr(
        backfill_script,
        "build_backfill_plans",
        lambda *_args, **_kwargs: (plans, []),
    )

    def fail_second(template, *_args, **_kwargs):
        if template.id == 2:
            raise RuntimeError("第二個模板故障")
        return {"sync": {"invalidated_output_count": 0}}

    current_snapshot["callback"] = fail_second
    report_path = tmp_path / "backfill.csv"
    first_result = backfill_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "first-run",
        "--apply",
    ])

    assert first_result == 2
    assert (tmp_path / "backfill-first-run.csv").is_file()
    assert not report_path.exists()
    first_manifest = json.loads(
        (tmp_path / "backfill-first-run.manifest.json").read_text(encoding="utf-8")
    )
    assert first_manifest["overall_status"] == "partial"
    assert [item["status"] for item in first_manifest["templates"]] == [
        "applied",
        "failed",
    ]

    current_snapshot["callback"] = (
        lambda *_args, **_kwargs: {"sync": {"invalidated_output_count": 0}}
    )
    reused_result = backfill_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "first-run",
        "--apply",
    ])

    assert reused_result == 2
    assert json.loads(
        (tmp_path / "backfill-first-run.manifest.json").read_text(encoding="utf-8")
    )["overall_status"] == "partial"

    reused_backup_result = backfill_script.main([
        "--db",
        str(database_path),
        "--report",
        str(tmp_path / "alternate.csv"),
        "--run-id",
        "first-run",
        "--apply",
    ])

    assert reused_backup_result == 2
    assert not (tmp_path / "alternate-first-run.manifest.json").exists()

    second_result = backfill_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "second-run",
        "--apply",
    ])

    assert second_result == 0
    with sqlite3.connect(database_path) as connection:
        backup_rows = connection.execute(
            """SELECT migration_name, template_page_id
               FROM template_page_layout_migration_backups
               ORDER BY migration_name, template_page_id"""
        ).fetchall()
    assert backup_rows == [
        ("material_text_links_backfill_2026_07:first-run", 101),
        ("material_text_links_backfill_2026_07:first-run", 201),
        ("material_text_links_backfill_2026_07:second-run", 101),
        ("material_text_links_backfill_2026_07:second-run", 201),
    ]
