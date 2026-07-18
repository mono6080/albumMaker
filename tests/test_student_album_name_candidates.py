import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from scripts.suggest_student_album_names import (
    _apply_or_reconcile_database,
    apply_reviewed_manifest,
    build_review_rows,
    main,
    suggest_album_name,
)


def _create_database(database_path):
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """CREATE TABLE projects (
                   id INTEGER PRIMARY KEY,
                   name TEXT NOT NULL,
                   deleted_at DATETIME,
                   completed_at DATETIME,
                   updated_at DATETIME
               );
               CREATE TABLE students (
                   id INTEGER PRIMARY KEY,
                   project_id INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   album_name TEXT,
                   order_index INTEGER NOT NULL DEFAULT 0,
                   created_at DATETIME,
                   updated_at DATETIME,
                   output_filename TEXT
               );
               INSERT INTO projects VALUES
                   (1, '使用中班級', NULL, NULL, '2026-01-01'),
                   (2, '已完成班級', NULL, '2026-02-01', '2026-01-01'),
                   (3, '封存班級', '2026-03-01', NULL, '2026-01-01');
               INSERT INTO students VALUES
                   (1, 1, '王小明', NULL, 0, '2026-01-01', '2026-01-01', 'outputs/old1.pdf'),
                   (2, 1, '李小明', NULL, 1, '2026-01-02', '2026-01-02', NULL),
                   (3, 1, '歐陽小明', NULL, 2, '2026-01-03', '2026-01-03', NULL),
                   (4, 1, 'Ava Chen', NULL, 3, '2026-01-04', '2026-01-04', NULL),
                   (5, 1, '陳小華', '花花', 4, '2026-01-05', '2026-01-05', NULL),
                   (6, 2, '林小美', NULL, 0, '2026-02-01', '2026-02-01', 'outputs/old6.pdf'),
                   (7, 3, '周小安', NULL, 0, '2026-03-01', '2026-03-01', NULL);"""
        )


def _dry_run(database_path, report_base_path, run_id="album-name-review"):
    assert main([
        "--db",
        str(database_path),
        "--report",
        str(report_base_path),
        "--run-id",
        run_id,
    ]) == 0
    report_path = report_base_path.with_name(
        f"{report_base_path.stem}-{run_id}{report_base_path.suffix}"
    )
    manifest_path = report_base_path.with_name(
        f"{report_base_path.stem}-{run_id}.manifest.json"
    )
    return report_path, manifest_path


def test_candidate_rules_are_conservative():
    assert suggest_album_name("王小明").candidate_album_name == "小明"
    assert suggest_album_name("王明").candidate_album_name == "明"

    compound = suggest_album_name("歐陽明")
    assert compound.candidate_album_name == "明"
    assert compound.review_flags == ("compound_surname",)

    assert suggest_album_name("歐陽小明").candidate_album_name is None
    assert suggest_album_name("Ava Chen").review_flags == ("latin_or_mixed",)
    assert suggest_album_name("明").review_flags == ("single_character",)


def test_review_plan_marks_collisions_and_does_not_touch_existing_values(tmp_path):
    database_path = tmp_path / "album.db"
    _create_database(database_path)

    rows, plans, analysis = build_review_rows(database_path)

    assert len(rows) == 6
    assert [plan["student_id"] for plan in plans] == [1, 2, 6]
    assert analysis["planned_count"] == 3
    assert analysis["plan_review_flag_counts"] == {
        "completed_project": 1,
        "display_collision": 2,
    }
    assert analysis["predicted_output_invalidations"] == 2
    assert next(row for row in rows if row["student_id"] == 3)["status"] == "manual_review"
    assert next(row for row in rows if row["student_id"] == 5)["effective_after"] == "花花"

    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM students WHERE album_name IS NOT NULL"
        ).fetchone()[0] == 1


def test_reviewed_apply_requires_hash_and_is_all_or_nothing(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    report_path, manifest_path = _dry_run(database_path, report_base_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    review_hash = manifest["review_plan_sha256"]

    with pytest.raises(ValueError, match="需人工確認"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=None,
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
        )

    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT album_name FROM students WHERE id = 1"
        ).fetchone()[0] is None

    cleanup_calls = []
    applied_manifest = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        acknowledgement=review_hash,
        maintenance_acknowledged=True,
        cleanup_outputs=lambda database, items: cleanup_calls.append((database, items)) or [],
    )

    assert applied_manifest["overall_status"] == "complete"
    assert applied_manifest["applied_count"] == 3
    assert applied_manifest["rendering_stopped_acknowledged"] is True
    assert cleanup_calls and len(cleanup_calls[0][1]) == 3
    assert report_path.is_file()
    with sqlite3.connect(database_path) as connection:
        values = dict(connection.execute(
            "SELECT id, album_name FROM students ORDER BY id"
        ))
        outputs = dict(connection.execute(
            "SELECT id, output_filename FROM students ORDER BY id"
        ))
    assert values == {
        1: "小明",
        2: "小明",
        3: None,
        4: None,
        5: "花花",
        6: "小美",
        7: None,
    }
    assert outputs[1] is None
    assert outputs[6] is None


def test_reviewed_apply_rejects_drift_before_any_write(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="drift-review",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE students SET name = '王已改名' WHERE id = 1")

    with pytest.raises(RuntimeError, match="已漂移"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
        )

    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM students WHERE album_name IS NOT NULL"
        ).fetchone()[0] == 1
    failed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert failed_manifest["overall_status"] == "preflight_failed"


def test_reviewed_apply_rejects_modified_report(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="tampered-report",
    )
    report_path.write_text("replaced", encoding="utf-8")

    with pytest.raises(ValueError, match="報告 SHA-256"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=None,
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
        )


def test_reviewed_apply_requires_rendering_stopped_acknowledgement(
    tmp_path,
    capsys,
):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="maintenance-ack",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert main([
        "--db",
        str(database_path),
        "--apply-reviewed-manifest",
        str(manifest_path),
        "--acknowledge-review-flags",
        manifest["review_plan_sha256"],
    ]) == 2
    assert "--acknowledge-rendering-stopped" in capsys.readouterr().err

    unchanged_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert unchanged_manifest["overall_status"] == "review_ready"
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM students WHERE album_name IS NOT NULL"
        ).fetchone()[0] == 1


def test_crash_before_commit_resumes_same_manifest_from_not_applied(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE students SET output_filename = 'outputs/keep.pdf' WHERE id = 5"
        )
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="crash-before-commit",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def crash_before_commit(state):
        if state == "before_database_commit":
            raise RuntimeError("simulated crash before commit")

    with pytest.raises(RuntimeError, match="simulated crash before commit"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
            state_hook=crash_before_commit,
        )

    crashed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert crashed_manifest["overall_status"] == "applying"
    assert crashed_manifest["database_status"] == "not_applied"
    assert crashed_manifest["cleanup_plan"]["students"]
    assert crashed_manifest["cleanup_plan_sha256"]
    assert crashed_manifest["cleanup_plan"]["students"][0] == {
        "project_id": 1,
        "student_id": 1,
        "previous_output_filename": "outputs/old1.pdf",
        "protected_output_filenames": ["outputs/keep.pdf"],
    }
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT album_name FROM students WHERE id = 1"
        ).fetchone()[0] is None
        assert connection.execute(
            "SELECT output_filename FROM students WHERE id = 1"
        ).fetchone()[0] == "outputs/old1.pdf"

    cleanup_calls = []
    resumed_manifest = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        acknowledgement=manifest["review_plan_sha256"],
        maintenance_acknowledged=True,
        cleanup_outputs=lambda _database, items: cleanup_calls.append(items) or [],
    )
    assert resumed_manifest["overall_status"] == "complete"
    assert resumed_manifest["database_reconciliation"] == "applied"
    assert len(cleanup_calls) == 1


def test_crash_after_commit_reconciles_without_duplicate_database_updates(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """CREATE TABLE student_update_audit (student_id INTEGER);
               CREATE TRIGGER audit_student_update AFTER UPDATE ON students
               BEGIN
                   INSERT INTO student_update_audit VALUES (NEW.id);
               END;"""
        )
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="crash-after-commit",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def crash_after_commit(state):
        if state == "after_database_commit":
            raise RuntimeError("simulated crash after commit")

    with pytest.raises(RuntimeError, match="simulated crash after commit"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
            state_hook=crash_after_commit,
        )

    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM student_update_audit"
        ).fetchone()[0] == 3
        assert connection.execute(
            "SELECT album_name FROM students WHERE id = 1"
        ).fetchone()[0] == "小明"

    cleanup_calls = []
    resumed_manifest = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        acknowledgement=manifest["review_plan_sha256"],
        maintenance_acknowledged=True,
        cleanup_outputs=lambda _database, items: cleanup_calls.append(items) or [],
    )
    assert resumed_manifest["overall_status"] == "complete"
    assert len(cleanup_calls) == 1
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM student_update_audit"
        ).fetchone()[0] == 3


def test_database_lock_rereads_latest_manifest_instead_of_stale_caller_dict(
    tmp_path,
):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="stale-caller-manifest",
    )
    stale_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    review_plan = stale_manifest["review_plan"]
    review_hash = stale_manifest["review_plan_sha256"]

    def crash_before_commit(state):
        if state == "before_database_commit":
            raise RuntimeError("simulated crash before commit")

    current_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    with pytest.raises(RuntimeError, match="simulated crash before commit"):
        _apply_or_reconcile_database(
            database_path=database_path,
            student_plans=list(review_plan["students"]),
            expected_review_plan_hash=review_hash,
            manifest=current_manifest,
            manifest_path=manifest_path,
            state_hook=crash_before_commit,
        )

    persisted_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert persisted_manifest["cleanup_plan"]
    assert "cleanup_plan" not in stale_manifest

    cleanup_items, database_mutated = _apply_or_reconcile_database(
        database_path=database_path,
        student_plans=list(review_plan["students"]),
        expected_review_plan_hash=review_hash,
        manifest=stale_manifest,
        manifest_path=manifest_path,
        state_hook=lambda _state: None,
    )

    assert database_mutated is True
    assert cleanup_items == persisted_manifest["cleanup_plan"]["students"]
    assert stale_manifest["cleanup_plan"] == persisted_manifest["cleanup_plan"]
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT album_name FROM students WHERE id = 1"
        ).fetchone()[0] == "小明"


def test_same_manifest_apply_is_serialized_through_output_cleanup(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="concurrent-apply-lock",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    review_hash = manifest["review_plan_sha256"]
    first_cleanup_entered = Event()
    release_first_cleanup = Event()
    second_invocation_started = Event()
    second_cleanup_entered = Event()

    def blocking_cleanup(_database, _items):
        first_cleanup_entered.set()
        if not release_first_cleanup.wait(timeout=5):
            raise AssertionError("等待測試釋放 cleanup 逾時")
        return []

    def second_apply():
        second_invocation_started.set()
        return apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=review_hash,
            maintenance_acknowledged=True,
            cleanup_outputs=(
                lambda _database, _items: second_cleanup_entered.set() or []
            ),
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            apply_reviewed_manifest,
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=review_hash,
            maintenance_acknowledged=True,
            cleanup_outputs=blocking_cleanup,
        )
        assert first_cleanup_entered.wait(timeout=5)
        second_future = executor.submit(second_apply)
        assert second_invocation_started.wait(timeout=5)
        try:
            assert not second_cleanup_entered.wait(timeout=0.2)
            assert not second_future.done()
        finally:
            release_first_cleanup.set()

        assert first_future.result(timeout=5)["overall_status"] == "complete"
        assert second_future.result(timeout=5)["overall_status"] == "complete"

    assert second_cleanup_entered.is_set() is False
    final_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert final_manifest["overall_status"] == "complete"
    assert final_manifest["cleanup_plan_sha256"]


def test_cleanup_errors_can_retry_without_database_mutation(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """CREATE TABLE student_update_audit (student_id INTEGER);
               CREATE TRIGGER audit_student_update AFTER UPDATE ON students
               BEGIN
                   INSERT INTO student_update_audit VALUES (NEW.id);
               END;"""
        )
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="cleanup-retry",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    first_manifest = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        acknowledgement=manifest["review_plan_sha256"],
        maintenance_acknowledged=True,
        cleanup_outputs=lambda _database, _items: ["storage unavailable"],
    )
    assert first_manifest["overall_status"] == "complete_with_cleanup_errors"
    assert first_manifest["cleanup_attempt_count"] == 1

    second_manifest = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        acknowledgement=manifest["review_plan_sha256"],
        maintenance_acknowledged=True,
        cleanup_outputs=lambda _database, _items: [],
    )
    assert second_manifest["overall_status"] == "complete"
    assert second_manifest["cleanup_attempt_count"] == 2
    assert second_manifest["cleanup_errors"] == []
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM student_update_audit"
        ).fetchone()[0] == 3


def test_resume_rejects_mixed_apply_state_without_further_writes(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="mixed-state",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def crash_before_commit(state):
        if state == "before_database_commit":
            raise RuntimeError("simulated crash before commit")

    with pytest.raises(RuntimeError):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
            state_hook=crash_before_commit,
        )
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE students SET album_name = '小明', output_filename = NULL WHERE id = 1"
        )

    with pytest.raises(RuntimeError, match="部分學生已套用"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
        )
    failed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert failed_manifest["overall_status"] == "reconciliation_failed"
    assert failed_manifest["database_reconciliation"] == "mixed"
    with sqlite3.connect(database_path) as connection:
        values = dict(connection.execute(
            "SELECT id, album_name FROM students WHERE id IN (1, 2, 6)"
        ))
    assert values == {1: "小明", 2: None, 6: None}


def test_resume_rejects_modified_cleanup_plan(tmp_path):
    database_path = tmp_path / "album.db"
    report_base_path = tmp_path / "album-names.csv"
    _create_database(database_path)
    _report_path, manifest_path = _dry_run(
        database_path,
        report_base_path,
        run_id="cleanup-plan-tamper",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def crash_before_commit(state):
        if state == "before_database_commit":
            raise RuntimeError("simulated crash before commit")

    with pytest.raises(RuntimeError):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
            state_hook=crash_before_commit,
        )
    crashed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    crashed_manifest["cleanup_plan"]["students"][0][
        "previous_output_filename"
    ] = "outputs/tampered.pdf"
    manifest_path.write_text(
        json.dumps(crashed_manifest, ensure_ascii=False),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="cleanup plan SHA-256"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=manifest["review_plan_sha256"],
            maintenance_acknowledged=True,
            cleanup_outputs=lambda _database, _items: [],
        )
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT album_name FROM students WHERE id = 1"
        ).fetchone()[0] is None
