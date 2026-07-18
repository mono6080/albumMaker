import json
import os
import sqlite3
from types import SimpleNamespace

from scripts.data_script_utils import build_run_manifest, write_manifest
from scripts.inspect_data_script_manifest import inspect_manifest, main as inspect_main


def _plan():
    return SimpleNamespace(
        template_id=7,
        template_name="測試模板",
        expected_revision=1,
        expected_page_ids=[101],
        page_items=[{
            "id": 101,
            "client_id": None,
            "layout": {"text_labels": [{"id": 1, "x": 20}]},
        }],
        changed_pages=[(
            101,
            json.dumps({"text_labels": [{"id": 1, "x": 10}]}),
        )],
    )


def _create_database(database_path, *, unique_backup=True):
    unique_clause = (
        ", UNIQUE(migration_name, template_page_id)"
        if unique_backup
        else ""
    )
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            f"""CREATE TABLE templates (
                   id INTEGER PRIMARY KEY,
                   revision INTEGER NOT NULL
               );
               CREATE TABLE template_pages (
                   id INTEGER PRIMARY KEY,
                   template_id INTEGER NOT NULL,
                   page_number INTEGER NOT NULL,
                   layout_json TEXT NOT NULL
               );
               CREATE TABLE template_page_layout_migration_backups (
                   id INTEGER PRIMARY KEY,
                   migration_name TEXT NOT NULL,
                   template_page_id INTEGER NOT NULL,
                   layout_json TEXT NOT NULL
                   {unique_clause}
               );"""
        )


def test_inspector_reconciles_applying_crash_gap_from_revision_and_hash(tmp_path):
    database_path = tmp_path / "album.db"
    manifest_path = tmp_path / "run.manifest.json"
    _create_database(database_path)
    plan = _plan()
    manifest = build_run_manifest(
        operation="test_operation",
        run_id="crash-run",
        database_path=database_path,
        report_path=tmp_path / "report.csv",
        backup_name="test_operation:crash-run",
        plans=[plan],
        apply_requested=True,
    )
    manifest["overall_status"] = "applying"
    manifest["templates"][0]["status"] = "applying"
    write_manifest(manifest_path, manifest)

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "INSERT INTO templates (id, revision) VALUES (7, 2)"
        )
        connection.execute(
            """INSERT INTO template_pages
               (id, template_id, page_number, layout_json)
               VALUES (101, 7, 0, ?)""",
            (json.dumps(plan.page_items[0]["layout"]),),
        )
        connection.execute(
            """INSERT INTO template_page_layout_migration_backups
               (migration_name, template_page_id, layout_json)
               VALUES (?, 101, ?)""",
            ("test_operation:crash-run", plan.changed_pages[0][1]),
        )

    applied = inspect_manifest(database_path, manifest_path)

    assert applied["backup_complete"] is True
    assert applied["templates"][0]["observed_state"] == "applied"

    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE templates SET revision = 1 WHERE id = 7")
        connection.execute(
            "UPDATE template_pages SET layout_json = ? WHERE id = 101",
            (plan.changed_pages[0][1],),
        )

    not_applied = inspect_manifest(database_path, manifest_path)

    assert not_applied["templates"][0]["observed_state"] == "not_applied"

    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE templates SET revision = 3 WHERE id = 7")
        connection.execute(
            "UPDATE template_pages SET layout_json = ? WHERE id = 101",
            (json.dumps(plan.page_items[0]["layout"]),),
        )

    diverged = inspect_manifest(database_path, manifest_path)

    assert diverged["templates"][0]["observed_state"] == "diverged"


def test_manifest_write_fsyncs_before_and_after_atomic_replace(tmp_path, monkeypatch):
    manifest_path = tmp_path / "run.manifest.json"
    fsync_calls = []
    replace_calls = []
    real_fsync = os.fsync
    real_replace = os.replace

    def tracked_fsync(file_descriptor):
        fsync_calls.append(file_descriptor)
        return real_fsync(file_descriptor)

    def tracked_replace(source, destination):
        replace_calls.append((source, destination))
        return real_replace(source, destination)

    monkeypatch.setattr(os, "fsync", tracked_fsync)
    monkeypatch.setattr(os, "replace", tracked_replace)

    write_manifest(manifest_path, {"run_id": "durable"})

    assert len(fsync_calls) == (2 if os.name == "nt" else 3)
    assert replace_calls == [(
        manifest_path.with_suffix(".json.tmp"),
        manifest_path,
    )]
    assert json.loads(manifest_path.read_text(encoding="utf-8")) == {
        "run_id": "durable"
    }


def _write_applied_database_state(
    database_path,
    manifest_path,
    *,
    backup_layouts,
    unique_backup=True,
):
    _create_database(database_path, unique_backup=unique_backup)
    plan = _plan()
    manifest = build_run_manifest(
        operation="test_operation",
        run_id="backup-audit",
        database_path=database_path,
        report_path=manifest_path.with_suffix(".csv"),
        backup_name="test_operation:backup-audit",
        plans=[plan],
        apply_requested=True,
    )
    manifest["overall_status"] = "applying"
    manifest["templates"][0]["status"] = "applying"
    write_manifest(manifest_path, manifest)
    with sqlite3.connect(database_path) as connection:
        connection.execute("INSERT INTO templates (id, revision) VALUES (7, 2)")
        connection.execute(
            """INSERT INTO template_pages
               (id, template_id, page_number, layout_json)
               VALUES (101, 7, 0, ?)""",
            (json.dumps(plan.page_items[0]["layout"]),),
        )
        for backup_layout in backup_layouts:
            connection.execute(
                """INSERT INTO template_page_layout_migration_backups
                   (migration_name, template_page_id, layout_json)
                   VALUES ('test_operation:backup-audit', 101, ?)""",
                (json.dumps(backup_layout),),
            )
    return plan


def test_inspector_rejects_backup_with_wrong_original_hash(tmp_path):
    database_path = tmp_path / "wrong.db"
    manifest_path = tmp_path / "wrong.manifest.json"
    _write_applied_database_state(
        database_path,
        manifest_path,
        backup_layouts=[{"text_labels": [{"id": 1, "x": 999}]}],
    )

    result = inspect_manifest(database_path, manifest_path)

    assert result["backup_count"] == 1
    assert result["backup_page_ids_match"] is True
    assert result["backup_hashes_match"] is False
    assert result["backup_complete"] is False
    assert inspect_main([
        "--db",
        str(database_path),
        "--manifest",
        str(manifest_path),
    ]) == 1


def test_inspector_rejects_duplicate_backup_page_rows(tmp_path):
    database_path = tmp_path / "duplicate.db"
    manifest_path = tmp_path / "duplicate.manifest.json"
    original_layout = {"text_labels": [{"id": 1, "x": 10}]}
    _write_applied_database_state(
        database_path,
        manifest_path,
        backup_layouts=[original_layout, original_layout],
        unique_backup=False,
    )

    result = inspect_manifest(database_path, manifest_path)

    assert result["backup_count"] == 2
    assert result["expected_backup_count"] == 1
    assert result["backup_page_ids_match"] is False
    assert result["backup_complete"] is False
    assert inspect_main([
        "--db",
        str(database_path),
        "--manifest",
        str(manifest_path),
    ]) == 1
