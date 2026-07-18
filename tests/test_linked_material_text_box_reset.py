import csv
import hashlib
import json
import sqlite3
from types import SimpleNamespace

import pytest

import scripts.reset_linked_material_text_boxes as reset_script
from scripts.reset_linked_material_text_boxes import (
    TemplateResetPlan,
    blocking_status_counts,
    build_reset_plans,
    geometry_changed,
    review_flag_counts,
    update_linked_text_geometry,
    write_report,
)


def test_reset_updates_only_five_geometry_fields():
    layout = {
        "text_labels": [{
            "id": 20,
            "x": 10,
            "y": 20,
            "width": 100,
            "height": 50,
            "rotation": 0,
            "text": "保留內容",
            "font_size": 24,
            "font_color": "#123456",
            "line_height": 1.4,
            "z_index": 2,
        }],
        "stickers": [{"id": 10, "path": "bubble.png", "z_index": 1}],
        "material_text_links": [{
            "kind": "material-text-v1",
            "material_id": 10,
            "text_id": 20,
        }],
    }
    geometry = {
        "x": 30,
        "y": 40,
        "width": 120,
        "height": 60,
        "rotation": 15,
    }

    updated = update_linked_text_geometry(layout, 20, geometry)

    assert {
        field_name: updated["text_labels"][0][field_name]
        for field_name in geometry
    } == geometry
    for field_name in ("text", "font_size", "font_color", "line_height", "z_index"):
        assert updated["text_labels"][0][field_name] == layout["text_labels"][0][field_name]
    assert updated["stickers"] == layout["stickers"]
    assert updated["material_text_links"] == layout["material_text_links"]
    assert layout["text_labels"][0]["x"] == 10


def test_geometry_change_uses_millipixel_commit_precision():
    before = {"x": 1, "y": 2, "width": 3, "height": 4, "rotation": 0}

    assert geometry_changed(before, {**before, "x": 1.0004}) is False
    assert geometry_changed(before, {**before, "x": 1.001}) is True


class _TemplateModel:
    id = object()


class _TemplateQuery:
    def __init__(self, templates):
        self.templates = templates

    def order_by(self, _column):
        return self

    def all(self):
        return self.templates


class _DatabaseSession:
    def __init__(self, templates):
        self.templates = templates

    def query(self, _model):
        return _TemplateQuery(self.templates)


def _linked_template(layout):
    page = SimpleNamespace(
        id=101,
        page_number=0,
        layout_json=json.dumps(layout),
    )
    return SimpleNamespace(
        id=7,
        name="測試模板",
        revision=3,
        pages=[page],
    )


def _linked_layout():
    return {
        "text_labels": [{
            "id": 20,
            "x": 10,
            "y": 20,
            "width": 100,
            "height": 50,
            "rotation": 0,
            "text": "保留內容",
            "font_size": 24,
        }],
        "stickers": [{
            "id": 10,
            "path": "templates/tmpl7/stickers/bubble.png",
            "x": 0,
            "y": 0,
            "width": 200,
            "height": 100,
            "rotation": 15,
        }],
        "material_text_links": [{
            "kind": "material-text-v1",
            "material_id": 10,
            "text_id": 20,
        }],
    }


def test_build_reset_plans_is_idempotent_and_preserves_non_geometry_fields():
    geometry = {
        "x": 30,
        "y": 40,
        "width": 120,
        "height": 60,
        "rotation": 15,
    }
    template = _linked_template(_linked_layout())
    suggestion_calls = []

    def suggest(*_args, **kwargs):
        suggestion_calls.append(kwargs)
        return {
            "status": "suggested",
            "normalized_box": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
            "confidence": 0.9,
        }

    plans, rows = build_reset_plans(
        _DatabaseSession([template]),
        _TemplateModel,
        lambda _layout: [],
        lambda _sticker, _box: geometry,
        suggest,
    )

    assert len(plans) == 1
    assert rows[0]["status"] == "changed"
    assert suggestion_calls[0]["sticker_id"] == 10
    updated_layout = plans[0].page_items[0]["layout"]
    assert updated_layout["text_labels"][0]["text"] == "保留內容"
    assert updated_layout["text_labels"][0]["font_size"] == 24
    assert updated_layout["stickers"] == _linked_layout()["stickers"]
    assert updated_layout["material_text_links"] == _linked_layout()["material_text_links"]

    template.pages[0].layout_json = json.dumps(updated_layout)
    second_plans, second_rows = build_reset_plans(
        _DatabaseSession([template]),
        _TemplateModel,
        lambda _layout: [],
        lambda _sticker, _box: geometry,
        suggest,
    )

    assert second_plans == []
    assert second_rows[0]["status"] == "unchanged"


def test_unavailable_analysis_blocks_apply_contract():
    template = _linked_template(_linked_layout())

    plans, rows = build_reset_plans(
        _DatabaseSession([template]),
        _TemplateModel,
        lambda _layout: [],
        lambda _sticker, _box: {},
        lambda *_args, **_kwargs: {
            "status": "unavailable",
            "reason": "no_shape",
            "confidence": 0,
        },
    )

    assert plans == []
    assert blocking_status_counts(rows) == {"unavailable": 1}


def test_flat_v1_group_link_is_reset_without_contract_upgrade():
    geometry = {
        "x": 30,
        "y": 40,
        "width": 120,
        "height": 60,
        "rotation": 15,
    }
    layout = _linked_layout()
    link = layout.pop("material_text_links")[0]
    layout["group_contract"] = "flat-world-v1"
    layout["groups"] = [{
        "id": "pair",
        "z_index": 1,
        "selection_rotation": 0,
        "children": [
            {"type": "sticker", "id": 10},
            {"type": "text", "id": 20},
        ],
        "links": [link],
    }]
    template = _linked_template(layout)

    plans, rows = build_reset_plans(
        _DatabaseSession([template]),
        _TemplateModel,
        lambda _layout: [],
        lambda _sticker, _box: geometry,
        lambda *_args, **_kwargs: {
            "status": "suggested",
            "normalized_box": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
            "confidence": 0.9,
        },
    )

    assert rows[0]["status"] == "changed"
    updated = plans[0].page_items[0]["layout"]
    assert updated["group_contract"] == "flat-world-v1"
    assert updated["groups"][0]["links"] == [link]
    assert "material_text_links" not in updated


def test_review_flags_are_counted_and_csv_is_formula_safe(tmp_path):
    rows = [{
        "template_id": 1,
        "template_name": "=危險",
        "template_page_id": 2,
        "page_number": 1,
        "text_id": "+1",
        "material_id": "@2",
        "status": "changed",
        "reason": "-原因",
        "review_flag": "low_confidence,large_center_shift",
    }]

    assert review_flag_counts(rows) == {
        "low_confidence": 1,
        "large_center_shift": 1,
    }

    report_path = tmp_path / "reset.csv"
    write_report(report_path, rows, "run-safe")
    with report_path.open(encoding="utf-8-sig", newline="") as report_file:
        row = next(csv.DictReader(report_file))
    assert row["template_name"] == "'=危險"
    assert row["text_id"] == "'+1"
    assert row["material_id"] == "'@2"
    assert row["reason"] == "'-原因"
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


def _make_apply_plan(template_id: int, page_id: int) -> TemplateResetPlan:
    original_layout = {
        "text_labels": [{
            "id": 20,
            "x": 10,
            "y": 20,
            "width": 100,
            "height": 50,
            "rotation": 0,
            "text": "保留內容",
        }],
        "stickers": [],
    }
    planned_layout = {
        **original_layout,
        "text_labels": [{
            **original_layout["text_labels"][0],
            "x": 30,
            "y": 40,
            "width": 120,
            "height": 60,
            "rotation": 15,
        }],
    }
    return TemplateResetPlan(
        template_id=template_id,
        template_name=f"模板{template_id}",
        expected_revision=1,
        expected_page_ids=[page_id],
        page_items=[{
            "id": page_id,
            "client_id": None,
            "layout": planned_layout,
        }],
        changed_pages=[(page_id, json.dumps(original_layout))],
    )


def _make_backup_database(database_path):
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


def _configure_reviewed_main(
    monkeypatch,
    templates,
    plans,
    report_rows,
    snapshot,
):
    monkeypatch.setattr(
        reset_script,
        "configure_backend",
        lambda _path: (
            object(),
            lambda: _ApplySession(templates),
            object(),
            _ApplyTemplateModel,
            lambda _layout: [],
            lambda *_args: {},
            lambda *_args, **_kwargs: {},
            snapshot,
        ),
    )
    monkeypatch.setattr(
        reset_script,
        "build_reset_plans",
        lambda *_args, **_kwargs: (plans, report_rows),
    )
    monkeypatch.setattr(
        reset_script,
        "expected_output_invalidations",
        lambda *_args, **_kwargs: 0,
    )


def _template_for_plan(plan):
    return SimpleNamespace(
        id=plan.template_id,
        name=plan.template_name,
        revision=plan.expected_revision,
        pages=[SimpleNamespace(
            id=page_id,
            layout_json=next(
                raw_layout
                for changed_page_id, raw_layout in plan.changed_pages
                if changed_page_id == page_id
            ),
        ) for page_id in plan.expected_page_ids],
    )


def _changed_report_row(*, review_flag=""):
    return {
        "template_id": 1,
        "template_name": "模板1",
        "template_page_id": 101,
        "page_number": 1,
        "text_id": 20,
        "material_id": 10,
        "status": "changed",
        "review_flag": review_flag,
    }


def test_review_flags_require_acknowledging_exact_plan_hash(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    plan = _make_apply_plan(1, 101)
    template = _template_for_plan(plan)
    snapshot_calls = []

    def snapshot(
        template_value,
        _page_ids,
        page_items,
        _session,
        **_kwargs,
    ):
        snapshot_calls.append(page_items)
        template_value.pages[0].layout_json = json.dumps(
            page_items[0]["layout"]
        )
        template_value.revision += 1
        return {
            "revision": template_value.revision,
            "sync": {"invalidated_output_count": 0},
        }

    _configure_reviewed_main(
        monkeypatch,
        {1: template},
        [plan],
        [_changed_report_row(review_flag="low_confidence")],
        snapshot,
    )
    report_path = tmp_path / "reset.csv"

    assert reset_script.main([
        "--db",
        str(database_path),
        "--apply",
        "--force-review-flags",
    ]) == 2
    assert snapshot_calls == []

    dry_run_result = reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "reviewed-run",
    ])

    assert dry_run_result == 0
    assert snapshot_calls == []
    manifest_path = tmp_path / "reset-reviewed-run.manifest.json"
    manifest = json.loads(
        manifest_path.read_text(encoding="utf-8")
    )
    assert manifest["overall_status"] == "review_ready"

    unacknowledged_result = reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
    ])

    assert unacknowledged_result == 2
    assert snapshot_calls == []

    acknowledged_result = reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
        "--acknowledge-review-flags",
        manifest["review_plan_sha256"],
    ])

    assert acknowledged_result == 0
    assert len(snapshot_calls) == 1


def test_reviewed_apply_blocks_layout_drift_between_runs(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    plan = _make_apply_plan(1, 101)
    template = _template_for_plan(plan)
    snapshot_calls = []
    _configure_reviewed_main(
        monkeypatch,
        {1: template},
        [plan],
        [_changed_report_row()],
        lambda *_args, **_kwargs: snapshot_calls.append(True),
    )
    report_path = tmp_path / "reset.csv"

    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "drift-run",
    ]) == 0
    manifest_path = tmp_path / "reset-drift-run.manifest.json"

    drifted_layout = json.loads(template.pages[0].layout_json)
    drifted_layout["text_labels"][0]["text"] = "審核後資料已改"
    template.pages[0].layout_json = json.dumps(drifted_layout)

    assert reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
    ]) == 2
    assert snapshot_calls == []
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM template_page_layout_migration_backups"
        ).fetchone()[0] == 0


def test_reviewed_apply_rejects_plan_hash_tampering(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    plan = _make_apply_plan(1, 101)
    template = _template_for_plan(plan)
    snapshot_calls = []
    _configure_reviewed_main(
        monkeypatch,
        {1: template},
        [plan],
        [_changed_report_row()],
        lambda *_args, **_kwargs: snapshot_calls.append(True),
    )
    report_path = tmp_path / "reset.csv"

    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "tamper-run",
    ]) == 0
    manifest_path = tmp_path / "reset-tamper-run.manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["review_plan"]["templates"][0]["changed_pages"][0][
        "text_geometry_updates"
    ][0]["geometry"]["x"] = 999
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False),
        encoding="utf-8",
    )

    assert reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
    ]) == 2
    assert snapshot_calls == []


@pytest.mark.parametrize("report_change", ["modified", "replaced"])
def test_reviewed_apply_rejects_changed_report_before_backend_setup(
    tmp_path,
    monkeypatch,
    report_change,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    plan = _make_apply_plan(1, 101)
    template = _template_for_plan(plan)
    _configure_reviewed_main(
        monkeypatch,
        {1: template},
        [plan],
        [_changed_report_row()],
        lambda *_args, **_kwargs: {},
    )
    report_path = tmp_path / "reset.csv"

    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        f"report-{report_change}",
    ]) == 0
    generated_report_path = (
        tmp_path / f"reset-report-{report_change}.csv"
    )
    manifest_path = (
        tmp_path / f"reset-report-{report_change}.manifest.json"
    )
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["report_sha256"] == hashlib.sha256(
        generated_report_path.read_bytes()
    ).hexdigest()

    if report_change == "modified":
        with generated_report_path.open("ab") as report_file:
            report_file.write(b"\r\nreviewed")
    else:
        generated_report_path.write_bytes(b"replacement report")

    monkeypatch.setattr(
        reset_script,
        "configure_backend",
        lambda _path: (_ for _ in ()).throw(
            AssertionError("報告 hash 驗證前不可初始化後端")
        ),
    )

    assert reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
    ]) == 2
    assert manifest_path.read_bytes() == manifest_bytes
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM template_page_layout_migration_backups"
        ).fetchone()[0] == 0


def test_reviewed_apply_uses_exact_reviewed_geometry_without_reanalysis(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    plan = _make_apply_plan(1, 101)
    template = _template_for_plan(plan)
    applied_page_items = []

    def snapshot(
        template_value,
        _page_ids,
        page_items,
        _session,
        **_kwargs,
    ):
        applied_page_items.extend(page_items)
        template_value.pages[0].layout_json = json.dumps(
            page_items[0]["layout"]
        )
        template_value.revision += 1
        return {
            "revision": template_value.revision,
            "sync": {"invalidated_output_count": 0},
        }

    _configure_reviewed_main(
        monkeypatch,
        {1: template},
        [plan],
        [_changed_report_row()],
        snapshot,
    )
    report_path = tmp_path / "reset.csv"
    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "exact-run",
    ]) == 0
    manifest_path = tmp_path / "reset-exact-run.manifest.json"
    monkeypatch.setattr(
        reset_script,
        "build_reset_plans",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("reviewed apply 不可重新分析")
        ),
    )

    assert reset_script.main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
    ]) == 0
    assert applied_page_items == plan.page_items
    applied_manifest = json.loads(
        manifest_path.read_text(encoding="utf-8")
    )
    assert applied_manifest["overall_status"] == "complete"
    assert applied_manifest["report_sha256"] == hashlib.sha256(
        (tmp_path / "reset-exact-run.csv").read_bytes()
    ).hexdigest()


def test_reset_reports_are_run_scoped_and_never_overwritten(
    tmp_path,
    monkeypatch,
):
    database_path = tmp_path / "album.db"
    _make_backup_database(database_path)
    _configure_reviewed_main(
        monkeypatch,
        {},
        [],
        [],
        lambda *_args, **_kwargs: {},
    )
    report_path = tmp_path / "reset.csv"

    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "report-one",
    ]) == 0
    first_report = tmp_path / "reset-report-one.csv"
    first_content = first_report.read_bytes()
    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "report-two",
    ]) == 0

    assert first_report.is_file()
    assert (tmp_path / "reset-report-two.csv").is_file()
    assert not report_path.exists()
    assert reset_script.main([
        "--db",
        str(database_path),
        "--report",
        str(report_path),
        "--run-id",
        "report-one",
    ]) == 2
    assert first_report.read_bytes() == first_content
