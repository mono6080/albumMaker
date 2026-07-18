import json
import shutil
import sqlite3

import pytest
from sqlalchemy import create_engine

import migrations
from database import Base
from scripts import migrate_production_organization_202607 as migration_script
from scripts.migrate_production_organization_202607 import (
    ApplyPreflightError,
    ApplyReconciliationError,
    apply_reviewed_manifest,
    create_review_manifest,
)


TEST_REFERENCE_COUNTS = {
    "class_roster_members": {"total": 2, "current": 1},
    "classroom_teacher_assignments": {"total": 1, "current": 1},
    "organization_supervisor_assignments": {"total": 1, "current": 1},
}
TEST_ROLE_USERS = {
    7101: "測試老師甲",
    7102: "測試老師乙",
    7103: "測試老師丙",
}
FIXED_USER_VERSIONS = {7101: 3, 7102: 6, 7103: 9}
TEST_REPLAY_PROJECT_IDS = [10, 196]
TEST_REPLAY_STUDENT_PROJECT_PAIRS = [[100, 10], [1960, 196]]
PROJECT_ORGANIZATION_COLUMNS = {
    "classroom_id",
    "class_period_work_slot_id",
    "campus_id_snapshot",
    "campus_name_snapshot",
    "classroom_name_snapshot",
}


@pytest.fixture
def current_schema_database(tmp_path):
    database_path = tmp_path / "schema.db"
    migration_engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    Base.metadata.create_all(migration_engine)
    original_engine = migrations.engine
    migrations.engine = migration_engine
    try:
        migrations.run_migrations()
    finally:
        migrations.engine = original_engine
        migration_engine.dispose()
    return database_path


def _insert_rows(connection, table_name, rows):
    if not rows:
        return
    columns = list(rows[0])
    placeholders = ", ".join("?" for _column in columns)
    column_sql = ", ".join(f'"{column}"' for column in columns)
    connection.executemany(
        f'INSERT INTO "{table_name}" ({column_sql}) VALUES ({placeholders})',
        [tuple(row[column] for column in columns) for row in rows],
    )


def _seed_users_and_templates(connection, *, reference):
    connection.execute(
        """UPDATE users
           SET hashed_password=?, auth_version=?, created_at=?
           WHERE id=1""",
        (
            "reference-admin-hash" if reference else "target-admin-hash",
            77 if reference else 2,
            "2026-07-01 00:00:00",
        ),
    )
    user_rows = []
    for user_id, display_name in TEST_ROLE_USERS.items():
        user_rows.append({
            "id": user_id,
            "username": f"user-{user_id}",
            "display_name": display_name,
            "hashed_password": (
                f"reference-hash-{user_id}"
                if reference
                else f"target-hash-{user_id}"
            ),
            "role": "teacher" if reference else "supervisor",
            "auth_version": 100 + user_id if reference else FIXED_USER_VERSIONS[user_id],
            "ui_font_scale": 1.0,
            "created_at": "2026-07-01 00:00:00",
        })
    _insert_rows(connection, "users", user_rows)
    connection.execute(
        """UPDATE template_periods
           SET department='infant', name='202607', status='active',
               created_at='2026-07-01 00:00:00'
           WHERE id=1"""
    )
    _insert_rows(connection, "templates", [{
        "id": 1,
        "name": "正式範本",
        "period_id": 1,
        "revision": 7,
        "created_at": "2026-07-01 00:00:00",
    }])


def _seed_reference_organization(connection):
    # startup 會建立 imported term/period；reference fixture 改用固定值重建。
    connection.execute("DELETE FROM academic_term_periods")
    connection.execute("DELETE FROM academic_terms")
    _insert_rows(connection, "campuses", [{
        "id": 1,
        "name": "總校",
        "is_active": 1,
        "created_at": "2026-07-02 00:00:00",
        "updated_at": "2026-07-02 00:00:00",
    }])
    _insert_rows(connection, "classrooms", [
        {
            "id": classroom_id,
            "campus_id": 1,
            "department": "infant",
            "name": classroom_name,
            "is_active": 1,
            "created_at": "2026-07-02 00:00:00",
            "updated_at": "2026-07-02 00:00:00",
        }
        for classroom_id, classroom_name in (
            (1, "太陽班"),
            (2, "月亮班"),
            (3, "星星班"),
            (4, "彩虹班"),
        )
    ])
    _insert_rows(connection, "class_roster_members", [
        {
            "id": 1,
            "classroom_id": 1,
            "roster_child_id": 2,
            "started_at": "2026-07-02 00:00:00",
            "ended_at": None,
            "end_reason": None,
        },
        {
            "id": 2,
            "classroom_id": 1,
            "roster_child_id": 5,
            "started_at": "2025-09-01 00:00:00",
            "ended_at": "2026-06-30 00:00:00",
            "end_reason": "graduated",
        },
    ])
    _insert_rows(connection, "classroom_teacher_assignments", [{
        "id": 1,
        "classroom_id": 1,
        "teacher_id": 7101,
        "teacher_name_snapshot": "測試老師甲",
        "duty": "lead",
        "started_at": "2026-07-02 00:00:00",
        "ended_at": None,
        "end_reason": None,
        "started_by_id": 1,
        "started_by_name_snapshot": "系統管理員",
        "ended_by_id": None,
        "ended_by_name_snapshot": None,
    }])
    _insert_rows(connection, "organization_supervisor_assignments", [{
        "id": 1,
        "campus_id": 1,
        "department": "infant",
        "supervisor_id": 7102,
        "supervisor_name_snapshot": "測試老師乙",
        "started_at": "2026-07-02 00:00:00",
        "ended_at": None,
        "end_reason": None,
        "started_by_id": 1,
        "started_by_name_snapshot": "系統管理員",
        "ended_by_id": None,
        "ended_by_name_snapshot": None,
    }])
    _insert_rows(connection, "academic_terms", [
        {
            "id": 1,
            "label": "114下學期",
            "status": "imported",
            "migration_key": "organization-reporting-v1",
            "starts_on": None,
            "ends_on": None,
            "created_at": "2026-07-02 00:00:00",
            "activated_at": None,
            "closed_at": None,
            "cancelled_at": None,
            "created_by_id": 1,
            "created_by_name_snapshot": "系統管理員",
            "activated_by_id": None,
            "activated_by_name_snapshot": None,
            "closed_by_id": None,
            "closed_by_name_snapshot": None,
            "cancelled_by_id": None,
            "cancelled_by_name_snapshot": None,
        },
        {
            "id": 2,
            "label": "115上學期",
            "status": "draft",
            "migration_key": None,
            "starts_on": None,
            "ends_on": None,
            "created_at": "2026-07-03 00:00:00",
            "activated_at": None,
            "closed_at": None,
            "cancelled_at": None,
            "created_by_id": 1,
            "created_by_name_snapshot": "系統管理員",
            "activated_by_id": None,
            "activated_by_name_snapshot": None,
            "closed_by_id": None,
            "closed_by_name_snapshot": None,
            "cancelled_by_id": None,
            "cancelled_by_name_snapshot": None,
        },
    ])
    _insert_rows(connection, "academic_term_periods", [{
        "id": 1,
        "academic_term_id": 1,
        "template_period_id": 1,
        "period_name_snapshot": "202607",
        "department": "infant",
        "position": 0,
    }])
    _insert_rows(connection, "academic_term_classrooms", [
        {
            "id": classroom_id,
            "academic_term_id": 1,
            "classroom_id": classroom_id,
            "campus_id_snapshot": 1,
            "campus_name_snapshot": "總校",
            "classroom_name_snapshot": classroom_name,
            "department": "infant",
        }
        for classroom_id, classroom_name in (
            (1, "太陽班"),
            (2, "月亮班"),
            (3, "星星班"),
            (4, "彩虹班"),
        )
    ])
    _insert_rows(connection, "academic_term_classroom_teachers", [{
        "id": 1,
        "term_classroom_id": 1,
        "source_assignment_id": 1,
        "teacher_id": 7101,
        "teacher_name_snapshot": "測試老師甲",
        "duty": "lead",
    }])
    _insert_rows(connection, "academic_term_classroom_students", [{
        "id": 1,
        "academic_term_id": 1,
        "term_classroom_id": 1,
        "source_membership_id": 1,
        "roster_child_id_snapshot": 2,
        "student_name_snapshot": "甲生",
    }])
    _insert_rows(connection, "class_period_work_slots", [
        {
            "id": slot_id,
            "term_classroom_id": classroom_id,
            "term_period_id": 1,
            "started_at": "2026-07-04 00:00:00",
        }
        for slot_id, classroom_id in ((10, 1), (25, 2), (38, 3), (956, 4))
    ])
    _insert_rows(connection, "term_reclassification_plans", [{
        "id": 1,
        "target_academic_term_id": 2,
        "scope_key": "organization",
        "label": "115上重新編班",
        "status": "draft",
        "revision": 1,
        "source_fingerprint": "reviewed-draft",
        "created_at": "2026-07-04 00:00:00",
        "updated_at": "2026-07-04 00:00:00",
        "applied_at": None,
        "cancelled_at": None,
        "created_by_id": 1,
        "created_by_name_snapshot": "系統管理員",
        "updated_by_id": None,
        "updated_by_name_snapshot": None,
        "applied_by_id": None,
        "applied_by_name_snapshot": None,
        "cancelled_by_id": None,
        "cancelled_by_name_snapshot": None,
    }])
    _insert_rows(connection, "term_student_placements", [{
        "id": 1,
        "plan_id": 1,
        "source_membership_id": 1,
        "roster_child_id_snapshot": 2,
        "student_name_snapshot": "甲生",
        "source_campus_id_snapshot": 1,
        "source_campus_name_snapshot": "總校",
        "source_classroom_id_snapshot": 1,
        "source_classroom_name_snapshot": "太陽班",
        "outcome": "classroom",
        "target_classroom_id": 2,
    }])
    _insert_rows(connection, "term_classroom_plans", [{
        "id": 1,
        "plan_id": 1,
        "classroom_id": 2,
    }])
    _insert_rows(connection, "term_classroom_teacher_targets", [{
        "id": 1,
        "classroom_plan_id": 1,
        "teacher_id": 7102,
        "teacher_name_snapshot": "測試老師乙",
        "duty": "lead",
    }])


def _project_rows(*, reference):
    assignments = {
        10: (1, 10, "太陽班"),
        115: (2, 25, "月亮班"),
        196: (3, 38, "星星班"),
        199: (3, 38, "星星班"),
        203: (4, 956, "彩虹班"),
    }
    rows = []
    for project_id in (10, 115, 196, 199, 203):
        classroom_id, slot_id, classroom_name = assignments[project_id]
        archived = project_id in {115, 199} and not reference
        rows.append({
            "id": project_id,
            "name": f"正式專案 {project_id}",
            "template_id": 1,
            "owner_id": 7101,
            "created_at": "2026-07-05 00:00:00",
            "updated_at": "2026-07-06 00:00:00",
            "deleted_at": "2026-07-18 00:00:00" if archived else None,
            "archive_expires_at": "2026-08-18 00:00:00" if archived else None,
            "label_texts_json": '{"sentinel":"target-content"}',
            "department": "infant",
            "template_period_id": 1,
            "completed_at": "2026-07-10 00:00:00" if project_id == 10 else None,
            "template_revision": 7,
            "classroom_id": classroom_id if reference else None,
            "created_by_id": 1,
            "created_by_name": "系統管理員",
            "campus_name_snapshot": "總校" if reference else None,
            "classroom_name_snapshot": classroom_name if reference else None,
            "campus_id_snapshot": 1 if reference else None,
            "class_period_work_slot_id": slot_id if reference else None,
        })
    return rows


def _student_rows(*, reference):
    return [
        {
            "id": 100,
            "project_id": 10,
            "name": "甲生",
            "order_index": 0,
            "pages_data_json": (
                '{"source":"reference"}'
                if reference
                else '{"source":"target","pages":[1]}'
            ),
            "output_filename": "target-100.pdf" if not reference else "wrong.pdf",
            "created_at": "2026-07-05 00:00:00",
            "updated_at": "2026-07-12 00:00:00",
            "roster_child_id": 2 if reference else 1,
            "album_name": "小甲" if not reference else "不可複製",
        },
        {
            "id": 1960,
            "project_id": 196,
            "name": "乙生",
            "order_index": 0,
            "pages_data_json": '{"source":"target-b"}',
            "output_filename": "target-1960.pdf",
            "created_at": "2026-07-05 00:00:00",
            "updated_at": "2026-07-13 00:00:00",
            "roster_child_id": 3 if reference else None,
            "album_name": None,
        },
        {
            "id": 1150,
            "project_id": 115,
            "name": "封存生",
            "order_index": 0,
            "pages_data_json": '{"source":"archived-target"}',
            "output_filename": "target-1150.pdf",
            "created_at": "2026-07-05 00:00:00",
            "updated_at": "2026-07-14 00:00:00",
            "roster_child_id": 4,
            "album_name": "封存稱呼",
        },
    ]


def _seed_reference_ledgers(connection):
    _insert_rows(connection, "legacy_project_classroom_migrations", [
        {
            "id": 1,
            "project_id_snapshot": 10,
            "project_name_snapshot": "正式專案 10",
            "project_department_snapshot": "infant",
            "target_campus_id_snapshot": 1,
            "target_campus_name_snapshot": "總校",
            "target_classroom_id_snapshot": 1,
            "target_classroom_name_snapshot": "太陽班",
            "target_department_snapshot": "infant",
            "source_fingerprint": "project-10",
            "student_count": 1,
            "seeded_member_count": 1,
            "applied_by_id_snapshot": 1,
            "applied_by_name_snapshot": "系統管理員",
            "applied_at": "2026-07-06 00:00:00",
        },
        {
            "id": 2,
            "project_id_snapshot": 196,
            "project_name_snapshot": "正式專案 196",
            "project_department_snapshot": "infant",
            "target_campus_id_snapshot": 1,
            "target_campus_name_snapshot": "總校",
            "target_classroom_id_snapshot": 3,
            "target_classroom_name_snapshot": "星星班",
            "target_department_snapshot": "infant",
            "source_fingerprint": "project-196",
            "student_count": 1,
            "seeded_member_count": 0,
            "applied_by_id_snapshot": 1,
            "applied_by_name_snapshot": "系統管理員",
            "applied_at": "2026-07-06 00:00:00",
        },
    ])
    _insert_rows(connection, "legacy_student_identity_resolutions", [
        {
            "id": 1,
            "migration_id": 1,
            "project_id_snapshot": 10,
            "student_id_snapshot": 100,
            "student_name_snapshot": "甲生",
            "student_order_index_snapshot": 0,
            "student_created_at_snapshot": "2026-07-05 00:00:00",
            "original_roster_child_id_snapshot": 1,
            "original_roster_child_name_snapshot": "舊暫定",
            "resolution_action": "existing",
            "resolved_roster_child_id_snapshot": 2,
            "resolved_roster_child_name_snapshot": "甲生",
            "seeded_current_roster": 1,
            "class_roster_member_id_snapshot": 1,
            "source_fingerprint": "student-100",
            "applied_by_id_snapshot": 1,
            "applied_by_name_snapshot": "系統管理員",
            "resolved_at": "2026-07-06 00:00:00",
        },
        {
            "id": 2,
            "migration_id": 2,
            "project_id_snapshot": 196,
            "student_id_snapshot": 1960,
            "student_name_snapshot": "乙生",
            "student_order_index_snapshot": 0,
            "student_created_at_snapshot": "2026-07-05 00:00:00",
            "original_roster_child_id_snapshot": None,
            "original_roster_child_name_snapshot": None,
            "resolution_action": "create_new",
            "resolved_roster_child_id_snapshot": 3,
            "resolved_roster_child_name_snapshot": "乙生",
            "seeded_current_roster": 0,
            "class_roster_member_id_snapshot": None,
            "source_fingerprint": "student-1960",
            "applied_by_id_snapshot": 1,
            "applied_by_name_snapshot": "系統管理員",
            "resolved_at": "2026-07-06 00:00:00",
        },
    ])


def _seed_database(database_path, *, reference):
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        _seed_users_and_templates(connection, reference=reference)
        roster_rows = [
            {"id": 1, "name": "舊暫定", "created_at": "2026-07-01 00:00:00"},
            {"id": 4, "name": "封存生", "created_at": "2026-07-01 00:00:00"},
            {"id": 99, "name": "孤兒", "created_at": "2026-07-01 00:00:00"},
        ]
        if reference:
            roster_rows.extend([
                {"id": 2, "name": "甲生", "created_at": "2026-07-02 00:00:00"},
                {"id": 3, "name": "乙生", "created_at": "2026-07-02 00:00:00"},
                {"id": 5, "name": "歷史生", "created_at": "2025-09-01 00:00:00"},
            ])
        _insert_rows(connection, "roster_children", roster_rows)
        if reference:
            _seed_reference_organization(connection)
        _insert_rows(connection, "projects", _project_rows(reference=reference))
        _insert_rows(connection, "students", _student_rows(reference=reference))
        if reference:
            _seed_reference_ledgers(connection)
        _insert_rows(connection, "legacy_teacher_supervisor_links", [{
            "id": 1,
            "teacher_id": 7101,
            "supervisor_id": 1,
            "teacher_name_snapshot": "測試老師甲",
            "supervisor_name_snapshot": "系統管理員",
            "archived_at": (
                "2026-07-17 00:00:00"
                if reference
                else "2026-07-18 00:00:00"
            ),
        }])
        assert list(connection.execute("PRAGMA foreign_key_check")) == []


def _prepare_database_pair(tmp_path, current_schema_database, monkeypatch):
    target_path = tmp_path / "target.db"
    reference_path = tmp_path / "reference.db"
    shutil.copy2(current_schema_database, target_path)
    shutil.copy2(current_schema_database, reference_path)
    _seed_database(target_path, reference=False)
    _seed_database(reference_path, reference=True)
    monkeypatch.setattr(
        migration_script,
        "RELEASE_REFERENCE_DATABASE_SHA256",
        migration_script._file_sha256(reference_path),
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_REFERENCE_COUNTS",
        TEST_REFERENCE_COUNTS,
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_LEGACY_TEACHER_LINK_COUNT",
        1,
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_REPLAY_PROJECT_COUNT",
        len(TEST_REPLAY_PROJECT_IDS),
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_REPLAY_STUDENT_COUNT",
        len(TEST_REPLAY_STUDENT_PROJECT_PAIRS),
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_REPLAY_PROJECT_IDS_SHA256",
        migration_script._canonical_identity_sha256(
            TEST_REPLAY_PROJECT_IDS
        ),
    )
    monkeypatch.setattr(
        migration_script,
        "EXPECTED_REPLAY_STUDENT_PROJECT_PAIRS_SHA256",
        migration_script._canonical_identity_sha256(
            TEST_REPLAY_STUDENT_PROJECT_PAIRS
        ),
    )
    return target_path, reference_path


def _create_manifest(tmp_path, target_path, reference_path):
    manifest_path = create_review_manifest(
        target_database_path=target_path,
        reference_database_path=reference_path,
        manifest_base_path=tmp_path / "organization.manifest.json",
        run_id="reviewed-plan",
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return manifest_path, manifest["review_plan_sha256"], manifest["review_plan"]


def _table_snapshot(database_path, table_name, *, ignored_columns=()):
    with sqlite3.connect(database_path) as connection:
        columns = [
            row[1]
            for row in connection.execute(f"PRAGMA table_info({table_name})")
            if row[1] not in ignored_columns
        ]
        column_sql = ", ".join(f'"{column}"' for column in columns)
        return list(connection.execute(
            f'SELECT {column_sql} FROM "{table_name}" ORDER BY id'
        ))


def _assert_target_baseline_unchanged(database_path):
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM campuses").fetchone()[0] == 0
        assert connection.execute(
            "SELECT COUNT(*) FROM legacy_project_classroom_migrations"
        ).fetchone()[0] == 0
        assert connection.execute(
            "SELECT role, auth_version FROM users WHERE id=7101"
        ).fetchone() == ("supervisor", FIXED_USER_VERSIONS[7101])


def test_reviewed_manifest_portably_replays_and_preserves_content(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    assert plan["replay_project_ids"] == [10, 196]
    assert plan["analysis"]["added_roster_child_count"] == 3
    assert plan["analysis"]["deleted_roster_child_count"] == 2
    assert plan["analysis"]["final_roster_child_count"] == 4
    assert plan["analysis"]["user_role_update_count"] == 3
    assert plan["user_updates"] == [
        {
            "id": 7101,
            "display_name": "測試老師甲",
            "source_role": "supervisor",
            "source_auth_version": 3,
            "role": "teacher",
            "auth_version": 4,
        },
        {
            "id": 7102,
            "display_name": "測試老師乙",
            "source_role": "supervisor",
            "source_auth_version": 6,
            "role": "teacher",
            "auth_version": 7,
        },
        {
            "id": 7103,
            "display_name": "測試老師丙",
            "source_role": "supervisor",
            "source_auth_version": 9,
            "role": "teacher",
            "auth_version": 10,
        },
    ]
    assert (
        plan["reference_database_sha256"]
        == migration_script.RELEASE_REFERENCE_DATABASE_SHA256
    )

    portable_target_path = tmp_path / "production-location.db"
    shutil.copy2(target_path, portable_target_path)
    with sqlite3.connect(portable_target_path) as connection:
        connection.execute(
            "UPDATE legacy_teacher_supervisor_links "
            "SET archived_at='2099-01-01 00:00:00'"
        )
    project_before = _table_snapshot(
        portable_target_path,
        "projects",
        ignored_columns=PROJECT_ORGANIZATION_COLUMNS,
    )
    student_before = _table_snapshot(
        portable_target_path,
        "students",
        ignored_columns={"roster_child_id"},
    )
    user_before = _table_snapshot(
        portable_target_path,
        "users",
        ignored_columns={"role", "auth_version"},
    )
    teacher_archive_before = _table_snapshot(
        portable_target_path,
        "legacy_teacher_supervisor_links",
    )

    applied = apply_reviewed_manifest(
        target_database_path=portable_target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    assert applied["overall_status"] == "complete"
    assert _table_snapshot(
        portable_target_path,
        "projects",
        ignored_columns=PROJECT_ORGANIZATION_COLUMNS,
    ) == project_before
    assert _table_snapshot(
        portable_target_path,
        "students",
        ignored_columns={"roster_child_id"},
    ) == student_before
    assert _table_snapshot(
        portable_target_path,
        "users",
        ignored_columns={"role", "auth_version"},
    ) == user_before
    assert _table_snapshot(
        portable_target_path,
        "legacy_teacher_supervisor_links",
    ) == teacher_archive_before

    with sqlite3.connect(portable_target_path) as connection:
        assert list(connection.execute(
            "SELECT id, classroom_id, class_period_work_slot_id "
            "FROM projects WHERE id IN (10, 196) ORDER BY id"
        )) == [(10, 1, 10), (196, 3, 38)]
        assert list(connection.execute(
            "SELECT id, classroom_id, class_period_work_slot_id "
            "FROM projects WHERE id IN (115, 199, 203) ORDER BY id"
        )) == [(115, None, None), (199, None, None), (203, None, None)]
        assert list(connection.execute(
            "SELECT id, roster_child_id, album_name, output_filename "
            "FROM students ORDER BY id"
        )) == [
            (100, 2, "小甲", "target-100.pdf"),
            (1150, 4, "封存稱呼", "target-1150.pdf"),
            (1960, 3, None, "target-1960.pdf"),
        ]
        assert list(connection.execute(
            "SELECT id, role, auth_version, hashed_password "
            "FROM users WHERE id IN (7101, 7102, 7103) ORDER BY id"
        )) == [
            (7101, "teacher", 4, "target-hash-7101"),
            (7102, "teacher", 7, "target-hash-7102"),
            (7103, "teacher", 10, "target-hash-7103"),
        ]
        assert list(connection.execute(
            "SELECT id FROM roster_children ORDER BY id"
        )) == [(2,), (3,), (4,), (5,)]
        assert connection.execute(
            """SELECT COUNT(*) FROM roster_children AS child
               WHERE NOT EXISTS (
                   SELECT 1 FROM students
                   WHERE students.roster_child_id=child.id
               ) AND NOT EXISTS (
                   SELECT 1 FROM class_roster_members
                   WHERE class_roster_members.roster_child_id=child.id
               )"""
        ).fetchone()[0] == 0
        assert list(connection.execute(
            "SELECT id, started_at FROM class_period_work_slots ORDER BY id"
        )) == [
            (10, "2026-07-04 00:00:00"),
            (25, None),
            (38, "2026-07-04 00:00:00"),
            (956, None),
        ]
        assert list(connection.execute(
            "SELECT project_id_snapshot FROM legacy_project_classroom_migrations "
            "ORDER BY project_id_snapshot"
        )) == [(10,), (196,)]
        assert list(connection.execute(
            "SELECT student_id_snapshot FROM legacy_student_identity_resolutions "
            "ORDER BY student_id_snapshot"
        )) == [(100,), (1960,)]
        assert connection.execute(
            "SELECT COUNT(*) FROM term_reclassification_plans WHERE status='draft'"
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM academic_term_classroom_students"
        ).fetchone()[0] == 1
        assert list(connection.execute("PRAGMA foreign_key_check")) == []

    reapplied = apply_reviewed_manifest(
        target_database_path=portable_target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    assert reapplied["database_reconciliation"] == "applied"
    with sqlite3.connect(portable_target_path) as connection:
        assert connection.execute(
            "SELECT auth_version FROM users WHERE id=7101"
        ).fetchone()[0] == 4
        assert connection.execute(
            "SELECT COUNT(*) FROM legacy_project_classroom_migrations"
        ).fetchone()[0] == 2


def test_role_correction_count_is_derived_and_hardlocked(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE users SET role='teacher' WHERE id=7103"
        )

    with pytest.raises(ValueError, match="User role 修正計畫筆數不符"):
        _create_manifest(tmp_path, target_path, reference_path)


def test_role_correction_rejects_unreviewed_transition(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE users SET role='admin' WHERE id=7103"
        )

    with pytest.raises(ValueError, match="非預期 source role 差異"):
        _create_manifest(tmp_path, target_path, reference_path)


def test_commit_crash_reconciles_without_double_increment_or_reinsert(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )

    def simulate_crash(state):
        if state == "after_database_commit":
            raise RuntimeError("simulated commit crash")

    with pytest.raises(RuntimeError, match="simulated commit crash"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=True,
            state_hook=simulate_crash,
        )
    applying_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert applying_manifest["overall_status"] == "applying"

    recovered = apply_reviewed_manifest(
        target_database_path=target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    assert recovered["overall_status"] == "complete"
    assert recovered["database_reconciliation"] == "applied"
    with sqlite3.connect(target_path) as connection:
        assert list(connection.execute(
            "SELECT id, auth_version FROM users "
            "WHERE id IN (7101, 7102, 7103) ORDER BY id"
        )) == [(7101, 4), (7102, 7), (7103, 10)]
        assert connection.execute(
            "SELECT COUNT(*) FROM roster_children"
        ).fetchone()[0] == 4
        assert connection.execute(
            "SELECT COUNT(*) FROM legacy_student_identity_resolutions"
        ).fetchone()[0] == 2


def test_project_203_started_slot_delta_reconciles_same_organization_manifest(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    apply_reviewed_manifest(
        target_database_path=target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    downstream_started_at = "2026-07-18 14:34:29.872253"
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE class_period_work_slots SET started_at=? WHERE id=956",
            (downstream_started_at,),
        )

    reconciled = apply_reviewed_manifest(
        target_database_path=target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )

    assert reconciled["overall_status"] == "complete"
    assert reconciled["database_reconciliation"] == "applied"
    with sqlite3.connect(target_path) as connection:
        assert connection.execute(
            "SELECT started_at FROM class_period_work_slots WHERE id=956"
        ).fetchone()[0] == downstream_started_at
        assert connection.execute(
            "SELECT auth_version FROM users WHERE id=7101"
        ).fetchone()[0] == 4


def test_project_203_delta_does_not_mask_other_work_slot_drift(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    apply_reviewed_manifest(
        target_database_path=target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE class_period_work_slots SET started_at=? WHERE id=956",
            ("2026-07-18 14:34:29.872253",),
        )
        connection.execute(
            "UPDATE class_period_work_slots SET started_at=? WHERE id=25",
            ("2099-01-01 00:00:00",),
        )

    with pytest.raises(ApplyReconciliationError, match="diverged"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=True,
        )

    with sqlite3.connect(target_path) as connection:
        assert connection.execute(
            "SELECT started_at FROM class_period_work_slots WHERE id=25"
        ).fetchone()[0] == "2099-01-01 00:00:00"


def test_acknowledgements_and_source_drift_block_all_writes(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    with pytest.raises(ValueError, match="maintenance window"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=False,
        )
    with pytest.raises(ValueError, match="reviewed plan"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement="wrong-sha256",
            maintenance_acknowledged=True,
        )
    _assert_target_baseline_unchanged(target_path)

    with sqlite3.connect(target_path) as connection:
        connection.execute("UPDATE students SET name='已漂移' WHERE id=100")
    with pytest.raises(ApplyPreflightError, match="source fingerprint"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=True,
        )
    _assert_target_baseline_unchanged(target_path)
    failed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert failed_manifest["overall_status"] == "preflight_failed"


def test_same_count_student_project_swap_blocks_dry_run(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE students SET project_id=196 WHERE id=100"
        )
        connection.execute(
            "UPDATE students SET project_id=10 WHERE id=1960"
        )

    with pytest.raises(ValueError, match="reviewed replay identity"):
        create_review_manifest(
            target_database_path=target_path,
            reference_database_path=reference_path,
            manifest_base_path=tmp_path / "swapped.manifest.json",
            run_id="same-count-swap",
        )
    assert not list(tmp_path.glob("swapped.manifest-*.json"))


def test_manifest_identity_swap_and_applied_state_project_move_are_rejected(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    tampered_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for student_update in tampered_manifest["review_plan"]["student_updates"]:
        student_update["project_id"] = (
            196 if student_update["id"] == 100 else 10
        )
    tampered_sha256 = migration_script.layout_sha256(
        tampered_manifest["review_plan"]
    )
    tampered_manifest["review_plan_sha256"] = tampered_sha256
    manifest_path.write_text(
        json.dumps(tampered_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="reviewed replay identity"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=tampered_sha256,
            maintenance_acknowledged=True,
        )
    _assert_target_baseline_unchanged(target_path)

    manifest_path.unlink()
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    apply_reviewed_manifest(
        target_database_path=target_path,
        manifest_path=manifest_path,
        acknowledgement=plan_sha256,
        maintenance_acknowledged=True,
    )
    with sqlite3.connect(target_path) as connection:
        trigger_sql = connection.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type='trigger' "
            "AND name='trg_students_freeze_class_backed_identity'"
        ).fetchone()[0]
        connection.execute(
            "DROP TRIGGER trg_students_freeze_class_backed_identity"
        )
        connection.execute(
            "UPDATE students SET project_id=196 WHERE id=100"
        )
        connection.execute(trigger_sql)

    with pytest.raises(ApplyReconciliationError, match="diverged"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=True,
        )
    with sqlite3.connect(target_path) as connection:
        assert connection.execute(
            "SELECT project_id FROM students WHERE id=100"
        ).fetchone()[0] == 196


def test_unknown_roster_child_foreign_key_blocks_orphan_cleanup(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            """CREATE TABLE unexpected_roster_links (
                   id INTEGER PRIMARY KEY,
                   roster_child_id INTEGER NOT NULL REFERENCES roster_children(id)
               )"""
        )
        connection.execute(
            "INSERT INTO unexpected_roster_links (id, roster_child_id) VALUES (1, 99)"
        )

    with pytest.raises(ApplyPreflightError, match="FK 使用者已漂移"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=plan_sha256,
            maintenance_acknowledged=True,
        )
    _assert_target_baseline_unchanged(target_path)
    with sqlite3.connect(target_path) as connection:
        assert connection.execute(
            "SELECT roster_child_id FROM unexpected_roster_links"
        ).fetchone()[0] == 99


def test_dry_run_rejects_semantically_valid_wrong_reference_copy_before_plan(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    wrong_reference_path = tmp_path / "wrong-reference-copy.db"
    shutil.copy2(reference_path, wrong_reference_path)
    with sqlite3.connect(wrong_reference_path) as connection:
        # 密碼不參與重播語意；舊版只做 semantic validation 時會接受這份錯誤副本。
        connection.execute(
            "UPDATE users SET hashed_password='wrong-copy-hash' WHERE id=1"
        )
    assert (
        migration_script._file_sha256(wrong_reference_path)
        != migration_script.RELEASE_REFERENCE_DATABASE_SHA256
    )

    def fail_if_plan_is_read(*_args, **_kwargs):
        raise AssertionError("reference hash guard 必須早於 plan 建立")

    monkeypatch.setattr(migration_script, "_build_plan", fail_if_plan_is_read)
    with pytest.raises(ValueError, match="不是本次 release artifact"):
        create_review_manifest(
            target_database_path=target_path,
            reference_database_path=wrong_reference_path,
            manifest_base_path=tmp_path / "wrong-reference.manifest.json",
            run_id="wrong-reference",
        )


def test_reference_connection_is_sqlite_read_only_and_immutable(
    current_schema_database,
    monkeypatch,
):
    original_connect = sqlite3.connect
    observed_connections = []

    def recording_connect(database, *args, **kwargs):
        observed_connections.append((str(database), kwargs.copy()))
        return original_connect(database, *args, **kwargs)

    monkeypatch.setattr(migration_script.sqlite3, "connect", recording_connect)
    with migration_script._connect(
        current_schema_database,
        read_only=True,
    ) as connection:
        assert connection.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("PRAGMA user_version=1")
    assert observed_connections == [
        (
            f"{current_schema_database.resolve().as_uri()}?mode=ro&immutable=1",
            {"uri": True},
        )
    ]


@pytest.mark.parametrize("sidecar_suffix", ["-wal", "-shm"])
def test_dry_run_rejects_reference_sidecars_before_plan(
    tmp_path,
    current_schema_database,
    monkeypatch,
    sidecar_suffix,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    reference_path.with_name(reference_path.name + sidecar_suffix).write_bytes(
        b"unreviewed sidecar"
    )

    def fail_if_plan_is_read(*_args, **_kwargs):
        raise AssertionError("reference sidecar guard 必須早於 plan 建立")

    monkeypatch.setattr(migration_script, "_build_plan", fail_if_plan_is_read)
    with pytest.raises(ValueError, match="不可帶 SQLite sidecar"):
        create_review_manifest(
            target_database_path=target_path,
            reference_database_path=reference_path,
            manifest_base_path=tmp_path / "sidecar.manifest.json",
            run_id=f"sidecar{sidecar_suffix}",
        )
    assert not list(tmp_path.glob("sidecar.manifest-*.json"))


def test_dry_run_rejects_reference_bit_drift_before_manifest_write(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    original_build_plan = migration_script._build_plan

    def build_then_drift(*args, **kwargs):
        plan = original_build_plan(*args, **kwargs)
        with sqlite3.connect(reference_path) as connection:
            connection.execute("PRAGMA user_version=314159")
        return plan

    monkeypatch.setattr(migration_script, "_build_plan", build_then_drift)
    manifest_base_path = tmp_path / "bit-drift.manifest.json"
    with pytest.raises(ValueError, match="不是本次 release artifact"):
        create_review_manifest(
            target_database_path=target_path,
            reference_database_path=reference_path,
            manifest_base_path=manifest_base_path,
            run_id="bit-drift",
        )
    assert not list(tmp_path.glob("bit-drift.manifest-*.json"))


def test_apply_cannot_acknowledge_a_different_reference_artifact(
    tmp_path,
    current_schema_database,
    monkeypatch,
):
    target_path, reference_path = _prepare_database_pair(
        tmp_path,
        current_schema_database,
        monkeypatch,
    )
    manifest_path, _plan_sha256, _plan = _create_manifest(
        tmp_path,
        target_path,
        reference_path,
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["review_plan"]["reference_database_sha256"] = "0" * 64
    wrong_plan_sha256 = migration_script.layout_sha256(manifest["review_plan"])
    manifest["review_plan_sha256"] = wrong_plan_sha256
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="reference DB SHA-256"):
        apply_reviewed_manifest(
            target_database_path=target_path,
            manifest_path=manifest_path,
            acknowledgement=wrong_plan_sha256,
            maintenance_acknowledged=True,
        )
    _assert_target_baseline_unchanged(target_path)
