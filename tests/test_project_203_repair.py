import hashlib
import json
import shutil
import sqlite3
from datetime import datetime

import pytest

from scripts import migrate_production_organization_202607 as organization_migration
from scripts.repair_project_203 import (
    RepairReconciliationError,
    apply_reviewed_manifest,
    main,
)


ADMIN_ID = 901
TEACHER_ID = 927
PERIOD_ID = 904
TEMPLATE_ID = 925
CAMPUS_ID = 901
CLASSROOM_ID = 925
TERM_ID = 901
TERM_CLASSROOM_ID = 925
WORK_SLOT_ID = 956
PROJECT_NAME = "測試相本"
TEMPLATE_NAME = "測試版型"
CAMPUS_NAME = "測試分校"
CLASSROOM_NAME = "測試甲班"
PERIOD_NAME = "TEST-PERIOD"
TERM_LABEL = "測試學期"
TEACHER_NAME = "測試老師"
CREATED_AT = "2031-02-03 04:05:06"
ROSTER_STARTED_AT = "2031-02-03 07:08:09"
REFERENCE_SLOT_STARTED_AT = "2031-02-03 10:11:12"
STUDENTS = [
    (1067, 1736, "測一甲"),
    (1068, 1734, "測二乙"),
    (1069, 1738, "測三丙"),
    (1070, 1733, "測四丁"),
    (1071, 1735, "測五戊"),
    (1072, 1737, "測六己"),
    (1073, 1732, "測七庚"),
    (1074, 1731, "測八辛"),
]


def _create_database(database_path, *, reference):
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(
            """CREATE TABLE users (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   username TEXT NOT NULL UNIQUE,
                   display_name TEXT NOT NULL,
                   role TEXT NOT NULL
               );
               CREATE TABLE template_periods (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   department TEXT NOT NULL,
                   status TEXT NOT NULL
               );
               CREATE TABLE templates (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   period_id INTEGER NOT NULL REFERENCES template_periods(id),
                   revision INTEGER NOT NULL
               );
               CREATE TABLE campuses (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   is_active BOOLEAN NOT NULL
               );
               CREATE TABLE classrooms (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   campus_id INTEGER NOT NULL REFERENCES campuses(id),
                   department TEXT NOT NULL,
                   name TEXT NOT NULL,
                   is_active BOOLEAN NOT NULL
               );
               CREATE TABLE academic_terms (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   label TEXT NOT NULL,
                   status TEXT NOT NULL
               );
               CREATE TABLE academic_term_periods (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
                   template_period_id INTEGER NOT NULL REFERENCES template_periods(id),
                   period_name_snapshot TEXT NOT NULL,
                   department TEXT NOT NULL
               );
               CREATE TABLE academic_term_classrooms (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
                   classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
                   campus_id_snapshot INTEGER NOT NULL,
                   campus_name_snapshot TEXT NOT NULL,
                   classroom_name_snapshot TEXT NOT NULL,
                   department TEXT NOT NULL
               );
               CREATE TABLE class_period_work_slots (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   term_classroom_id INTEGER NOT NULL
                       REFERENCES academic_term_classrooms(id),
                   term_period_id INTEGER NOT NULL REFERENCES academic_term_periods(id),
                   started_at DATETIME
               );
               CREATE TABLE roster_children (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL
               );
               CREATE TABLE class_roster_members (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
                   roster_child_id INTEGER NOT NULL REFERENCES roster_children(id),
                   started_at DATETIME NOT NULL,
                   ended_at DATETIME
               );
               CREATE TABLE classroom_teacher_assignments (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
                   teacher_id INTEGER REFERENCES users(id),
                   teacher_name_snapshot TEXT NOT NULL,
                   duty TEXT NOT NULL,
                   started_at DATETIME NOT NULL,
                   ended_at DATETIME
               );
               CREATE TABLE academic_term_classroom_students (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id),
                   term_classroom_id INTEGER NOT NULL
                       REFERENCES academic_term_classrooms(id),
                   source_membership_id INTEGER REFERENCES class_roster_members(id),
                   roster_child_id_snapshot INTEGER NOT NULL,
                   student_name_snapshot TEXT NOT NULL
               );
               CREATE TABLE projects (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   template_id INTEGER NOT NULL REFERENCES templates(id),
                   owner_id INTEGER REFERENCES users(id),
                   created_at DATETIME,
                   updated_at DATETIME,
                   deleted_at DATETIME,
                   archive_expires_at DATETIME,
                   label_texts_json TEXT NOT NULL DEFAULT '{}',
                   department TEXT,
                   template_period_id INTEGER REFERENCES template_periods(id),
                   completed_at DATETIME,
                   template_revision INTEGER NOT NULL DEFAULT 1,
                   classroom_id INTEGER REFERENCES classrooms(id),
                   created_by_id INTEGER REFERENCES users(id),
                   created_by_name TEXT,
                   campus_name_snapshot TEXT,
                   classroom_name_snapshot TEXT,
                   campus_id_snapshot INTEGER,
                   class_period_work_slot_id INTEGER
                       REFERENCES class_period_work_slots(id)
               );
               CREATE TABLE students (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   name TEXT NOT NULL,
                   order_index INTEGER,
                   pages_data_json TEXT NOT NULL,
                   output_filename TEXT,
                   created_at DATETIME,
                   updated_at DATETIME,
                   roster_child_id INTEGER REFERENCES roster_children(id),
                   album_name TEXT
               );
               CREATE TABLE legacy_project_classroom_migrations (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   project_id_snapshot INTEGER NOT NULL,
                   student_count INTEGER NOT NULL,
                   seeded_member_count INTEGER NOT NULL
               );
               CREATE TABLE legacy_student_identity_resolutions (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   migration_id INTEGER NOT NULL,
                   project_id_snapshot INTEGER NOT NULL,
                   student_id_snapshot INTEGER NOT NULL
               );"""
        )
        connection.executemany(
            "INSERT INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)",
            [
                (ADMIN_ID, "test-admin", "測試管理員", "admin"),
                (TEACHER_ID, "test-teacher", TEACHER_NAME, "teacher"),
            ],
        )
        connection.execute(
            """INSERT INTO template_periods (id, name, department, status)
               VALUES (?, ?, 'infant', 'active')""",
            (PERIOD_ID, PERIOD_NAME),
        )
        connection.execute(
            """INSERT INTO templates (id, name, period_id, revision)
               VALUES (?, ?, ?, 3)""",
            (TEMPLATE_ID, TEMPLATE_NAME, PERIOD_ID),
        )
        connection.execute(
            "INSERT INTO campuses (id, name, is_active) VALUES (?, ?, 1)",
            (CAMPUS_ID, CAMPUS_NAME),
        )
        connection.execute(
            """INSERT INTO classrooms (id, campus_id, department, name, is_active)
               VALUES (?, ?, 'infant', ?, 1)""",
            (CLASSROOM_ID, CAMPUS_ID, CLASSROOM_NAME),
        )
        connection.execute(
            "INSERT INTO academic_terms (id, label, status) VALUES (?, ?, 'imported')",
            (TERM_ID, TERM_LABEL),
        )
        connection.execute(
            """INSERT INTO academic_term_periods (
                   id, academic_term_id, template_period_id,
                   period_name_snapshot, department
               ) VALUES (?, ?, ?, ?, 'infant')""",
            (PERIOD_ID, TERM_ID, PERIOD_ID, PERIOD_NAME),
        )
        connection.execute(
            """INSERT INTO academic_term_classrooms (
                   id, academic_term_id, classroom_id, campus_id_snapshot,
                   campus_name_snapshot, classroom_name_snapshot, department
               ) VALUES (?, ?, ?, ?, ?, ?, 'infant')""",
            (
                TERM_CLASSROOM_ID,
                TERM_ID,
                CLASSROOM_ID,
                CAMPUS_ID,
                CAMPUS_NAME,
                CLASSROOM_NAME,
            ),
        )
        connection.execute(
            """INSERT INTO class_period_work_slots (
                   id, term_classroom_id, term_period_id, started_at
               ) VALUES (?, ?, ?, ?)""",
            (
                WORK_SLOT_ID,
                TERM_CLASSROOM_ID,
                PERIOD_ID,
                REFERENCE_SLOT_STARTED_AT if reference else None,
            ),
        )
        connection.execute(
            """INSERT INTO classroom_teacher_assignments (
                   id, classroom_id, teacher_id, teacher_name_snapshot,
                   duty, started_at, ended_at
               ) VALUES (912, ?, ?, ?, 'lead', ?, NULL)""",
            (CLASSROOM_ID, TEACHER_ID, TEACHER_NAME, ROSTER_STARTED_AT),
        )
        connection.executemany(
            "INSERT INTO roster_children (id, name) VALUES (?, ?)",
            [(child_id, name) for _member_id, child_id, name in STUDENTS],
        )
        connection.executemany(
            """INSERT INTO class_roster_members (
                   id, classroom_id, roster_child_id, started_at, ended_at
               ) VALUES (?, ?, ?, ?, NULL)""",
            [
                (member_id, CLASSROOM_ID, child_id, ROSTER_STARTED_AT)
                for member_id, child_id, _name in STUDENTS
            ],
        )
        connection.executemany(
            """INSERT INTO academic_term_classroom_students (
                   id, academic_term_id, term_classroom_id,
                   source_membership_id, roster_child_id_snapshot,
                   student_name_snapshot
               ) VALUES (?, ?, ?, ?, ?, ?)""",
            [
                (
                    3265 + index,
                    TERM_ID,
                    TERM_CLASSROOM_ID,
                    member_id,
                    child_id,
                    name,
                )
                for index, (member_id, child_id, name) in enumerate(reversed(STUDENTS))
            ],
        )
        connection.execute(
            """INSERT INTO projects (
                   id, name, template_id, owner_id, created_at, updated_at,
                   deleted_at, archive_expires_at, label_texts_json, department,
                   template_period_id, completed_at, template_revision,
                   classroom_id, created_by_id, created_by_name,
                   campus_name_snapshot, classroom_name_snapshot,
                   campus_id_snapshot, class_period_work_slot_id
               ) VALUES (
                   203, ?, ?, ?, ?, ?, NULL, NULL, '{}', 'infant',
                   ?, NULL, 1, ?, NULL, NULL, ?, ?, ?, ?
               )""",
            (
                PROJECT_NAME,
                TEMPLATE_ID,
                TEACHER_ID,
                CREATED_AT,
                CREATED_AT,
                PERIOD_ID,
                CLASSROOM_ID if reference else None,
                CAMPUS_NAME if reference else None,
                CLASSROOM_NAME if reference else None,
                CAMPUS_ID if reference else None,
                WORK_SLOT_ID if reference else None,
            ),
        )
        if reference:
            connection.execute(
                """INSERT INTO legacy_project_classroom_migrations (
                       id, project_id_snapshot, student_count, seeded_member_count
                   ) VALUES (1901, 203, 0, 0)"""
            )


def _prepare_database_pair(tmp_path, monkeypatch, prefix):
    database_path = tmp_path / f"{prefix}-target.db"
    reference_database_path = tmp_path / f"{prefix}-reference.db"
    _create_database(database_path, reference=False)
    _create_database(reference_database_path, reference=True)
    monkeypatch.setattr(
        organization_migration,
        "RELEASE_REFERENCE_DATABASE_SHA256",
        organization_migration._file_sha256(reference_database_path),
    )
    return database_path, reference_database_path


def _dry_run(database_path, reference_database_path, report_base_path, run_id):
    assert main(
        [
            "--db",
            str(database_path),
            "--reference-db",
            str(reference_database_path),
            "--report",
            str(report_base_path),
            "--run-id",
            run_id,
            "--actor-user-id",
            str(ADMIN_ID),
        ]
    ) == 0
    report_path = report_base_path.with_name(
        f"{report_base_path.stem}-{run_id}{report_base_path.suffix}"
    )
    manifest_path = report_base_path.with_name(
        f"{report_base_path.stem}-{run_id}.manifest.json"
    )
    return report_path, manifest_path


def _project_state(database_path):
    with sqlite3.connect(database_path) as connection:
        source = connection.execute(
            """SELECT deleted_at, archive_expires_at, classroom_id,
                      class_period_work_slot_id
               FROM projects WHERE id = 203"""
        ).fetchone()
        replacements = connection.execute(
            """SELECT id FROM projects
               WHERE class_period_work_slot_id = ? AND deleted_at IS NULL
               ORDER BY id""",
            (WORK_SLOT_ID,),
        ).fetchall()
        student_count = connection.execute(
            """SELECT COUNT(*) FROM students
               WHERE project_id IN (
                   SELECT id FROM projects WHERE class_period_work_slot_id = ?
               )""",
            (WORK_SLOT_ID,),
        ).fetchone()[0]
        started_at = connection.execute(
            "SELECT started_at FROM class_period_work_slots WHERE id = ?",
            (WORK_SLOT_ID,),
        ).fetchone()[0]
    return source, replacements, student_count, started_at


def test_preview_is_read_only_and_portable_apply_is_idempotent(
    tmp_path,
    monkeypatch,
):
    preview_database, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "portable",
    )
    production_database = tmp_path / "production.db"
    report_base_path = tmp_path / "project-203.csv"
    report_path, manifest_path = _dry_run(
        preview_database,
        reference_database,
        report_base_path,
        "portable",
    )
    assert _project_state(preview_database) == (
        (None, None, None, None),
        [],
        0,
        None,
    )

    # manifest 可從 working DB 帶到不同絕對路徑的正式 DB。
    shutil.copy2(preview_database, production_database)
    manifest = apply_reviewed_manifest(
        database_path=production_database,
        manifest_path=manifest_path,
        maintenance_acknowledged=True,
    )
    replacement_id = manifest["apply_plan"]["replacement_project_id"]
    source, replacements, student_count, started_at = _project_state(
        production_database
    )
    assert source[0] == manifest["apply_plan"]["applied_at"]
    assert source[1] == manifest["apply_plan"]["archive_expires_at"]
    assert source[2:] == (None, None)
    assert replacements == [(replacement_id,)]
    assert student_count == 8
    assert started_at == manifest["apply_plan"]["applied_at"]
    assert (
        datetime.fromisoformat(source[1]) - datetime.fromisoformat(source[0])
    ).days == 30

    with sqlite3.connect(production_database) as connection:
        replacement = connection.execute(
            """SELECT name, template_id, template_revision, owner_id,
                      classroom_id, class_period_work_slot_id,
                      created_by_id, created_by_name,
                      campus_name_snapshot, classroom_name_snapshot
               FROM projects WHERE id = ?""",
            (replacement_id,),
        ).fetchone()
        students = connection.execute(
            """SELECT name, album_name, order_index, roster_child_id,
                      pages_data_json, output_filename
               FROM students WHERE project_id = ? ORDER BY order_index""",
            (replacement_id,),
        ).fetchall()
        ledger_count = connection.execute(
            "SELECT COUNT(*) FROM legacy_project_classroom_migrations"
        ).fetchone()[0]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert replacement == (
        PROJECT_NAME,
        TEMPLATE_ID,
        3,
        TEACHER_ID,
        CLASSROOM_ID,
        WORK_SLOT_ID,
        ADMIN_ID,
        "測試管理員",
        CAMPUS_NAME,
        CLASSROOM_NAME,
    )
    assert students == [
        (name, name[1:], order_index, child_id, "[]", None)
        for order_index, (_member_id, child_id, name) in enumerate(STUDENTS)
    ]
    assert ledger_count == 0
    assert report_path.is_file()
    reviewed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert reviewed_manifest["contains_personal_data"] is True
    assert reviewed_manifest["reference_database_sha256"] == (
        organization_migration.RELEASE_REFERENCE_DATABASE_SHA256
    )
    assert reviewed_manifest["review_plan"]["source_project"]["name"] == PROJECT_NAME
    assert reviewed_manifest["review_plan"]["target_work_slot_id"] == WORK_SLOT_ID

    repeated = apply_reviewed_manifest(
        database_path=production_database,
        manifest_path=manifest_path,
        maintenance_acknowledged=True,
    )
    assert repeated["overall_status"] == "complete"
    assert _project_state(production_database)[1:] == (
        [(replacement_id,)],
        8,
        started_at,
    )


def test_source_drift_blocks_all_writes(tmp_path, monkeypatch):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "drift",
    )
    report_base_path = tmp_path / "project-203.csv"
    _report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "drift",
    )
    with sqlite3.connect(database_path) as connection:
        connection.execute("UPDATE roster_children SET name = '已改名' WHERE id = 1736")

    with pytest.raises(RepairReconciliationError, match="reviewed source fingerprint"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
        )
    assert _project_state(database_path) == (
        (None, None, None, None),
        [],
        0,
        None,
    )


def test_failure_before_commit_rolls_back_and_same_manifest_resumes(
    tmp_path,
    monkeypatch,
):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "rollback",
    )
    report_base_path = tmp_path / "project-203.csv"
    _report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "rollback",
    )

    def fail_before_commit(state):
        if state == "before_database_commit":
            raise RuntimeError("simulated failure")

    with pytest.raises(RuntimeError, match="simulated failure"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
            state_hook=fail_before_commit,
        )
    assert _project_state(database_path) == (
        (None, None, None, None),
        [],
        0,
        None,
    )
    applying_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert applying_manifest["overall_status"] == "applying"

    completed = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        maintenance_acknowledged=True,
    )
    assert completed["overall_status"] == "complete"
    assert _project_state(database_path)[2] == 8


def test_crash_after_commit_reconciles_without_duplicates(tmp_path, monkeypatch):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "crash-gap",
    )
    report_base_path = tmp_path / "project-203.csv"
    _report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "crash-gap",
    )

    def fail_after_commit(state):
        if state == "after_database_commit":
            raise RuntimeError("simulated crash")

    with pytest.raises(RuntimeError, match="simulated crash"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
            state_hook=fail_after_commit,
        )
    assert _project_state(database_path)[2] == 8
    assert json.loads(manifest_path.read_text(encoding="utf-8"))[
        "overall_status"
    ] == "applying"

    completed = apply_reviewed_manifest(
        database_path=database_path,
        manifest_path=manifest_path,
        maintenance_acknowledged=True,
    )
    assert completed["overall_status"] == "complete"
    assert _project_state(database_path)[2] == 8


def test_started_slot_and_tampered_report_are_rejected(
    tmp_path,
    monkeypatch,
    capsys,
):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "started",
    )
    report_base_path = tmp_path / "project-203.csv"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE class_period_work_slots SET started_at = ? WHERE id = ?",
            ("2031-02-04", WORK_SLOT_ID),
        )
    assert main(
        [
            "--db",
            str(database_path),
            "--reference-db",
            str(reference_database),
            "--report",
            str(report_base_path),
            "--run-id",
            "started",
            "--actor-user-id",
            str(ADMIN_ID),
        ]
    ) == 2
    assert "不重設或覆蓋 started_at" in capsys.readouterr().err

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "UPDATE class_period_work_slots SET started_at = NULL WHERE id = ?",
            (WORK_SLOT_ID,),
        )
    report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "tampered",
    )
    report_path.write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="報告不存在或 SHA-256"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
        )

    report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "tampered-rebound",
    )
    report_text = report_path.read_text(encoding="utf-8-sig")
    report_path.write_text(
        report_text.replace(STUDENTS[0][2], "篡改姓名", 1),
        encoding="utf-8-sig",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["report_sha256"] = hashlib.sha256(report_path.read_bytes()).hexdigest()
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="報告內容與 review plan 不一致"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
        )


def test_dry_run_rejects_wrong_or_non_single_file_reference(
    tmp_path,
    monkeypatch,
    capsys,
):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "wrong-reference",
    )
    wrong_reference_database = tmp_path / "semantic-copy.db"
    shutil.copy2(reference_database, wrong_reference_database)
    with sqlite3.connect(wrong_reference_database) as connection:
        connection.execute("CREATE TABLE unreviewed_marker (id INTEGER PRIMARY KEY)")
    report_base_path = tmp_path / "wrong-reference.csv"
    assert main(
        [
            "--db",
            str(database_path),
            "--reference-db",
            str(wrong_reference_database),
            "--report",
            str(report_base_path),
            "--run-id",
            "wrong-reference",
            "--actor-user-id",
            str(ADMIN_ID),
        ]
    ) == 2
    assert "不是本次 release artifact" in capsys.readouterr().err
    assert not list(tmp_path.glob("wrong-reference-*.manifest.json"))

    sidecar_path = reference_database.with_name(reference_database.name + "-wal")
    sidecar_path.write_bytes(b"unreviewed sidecar")
    assert main(
        [
            "--db",
            str(database_path),
            "--reference-db",
            str(reference_database),
            "--report",
            str(report_base_path),
            "--run-id",
            "sidecar",
            "--actor-user-id",
            str(ADMIN_ID),
        ]
    ) == 2
    assert "不可帶 SQLite sidecar" in capsys.readouterr().err


def test_apply_rejects_tampered_reference_binding(tmp_path, monkeypatch):
    database_path, reference_database = _prepare_database_pair(
        tmp_path,
        monkeypatch,
        "tampered-binding",
    )
    report_base_path = tmp_path / "project-203.csv"
    _report_path, manifest_path = _dry_run(
        database_path,
        reference_database,
        report_base_path,
        "tampered-binding",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["reference_database_sha256"] = "0" * 64
    manifest["review_plan"]["reference_database_sha256"] = "0" * 64
    manifest["review_plan_sha256"] = organization_migration.layout_sha256(
        manifest["review_plan"]
    )
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="reference DB SHA-256"):
        apply_reviewed_manifest(
            database_path=database_path,
            manifest_path=manifest_path,
            maintenance_acknowledged=True,
        )
    assert _project_state(database_path) == (
        (None, None, None, None),
        [],
        0,
        None,
    )
