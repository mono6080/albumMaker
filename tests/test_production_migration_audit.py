import hashlib
import json
import sqlite3
from contextlib import closing, contextmanager

import pytest

import scripts.audit_production_migration_202607 as audit_module
import scripts.migrate_production_organization_202607 as migration_module
from scripts.audit_production_migration_202607 import (
    audit_production_migration as _audit_production_migration,
    main as audit_main,
)
from scripts.data_script_utils import layout_sha256
from scripts.migrate_production_organization_202607 import (
    MANIFEST_SCHEMA_VERSION as ORGANIZATION_MANIFEST_SCHEMA_VERSION,
    OPERATION as ORGANIZATION_OPERATION,
    PLAN_SCHEMA_VERSION as ORGANIZATION_PLAN_SCHEMA_VERSION,
    REPLACEMENT_TABLES as ORGANIZATION_REPLACEMENT_TABLES,
    _planned_applied_component_values as _planned_organization_components,
    _state_component_hashes as _organization_component_hashes,
)
from scripts.repair_project_203 import (
    APPLY_PLAN_SCHEMA_VERSION as PROJECT_203_APPLY_PLAN_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION as PROJECT_203_MANIFEST_SCHEMA_VERSION,
    OPERATION as PROJECT_203_OPERATION,
    PLAN_SCHEMA_VERSION as PROJECT_203_PLAN_SCHEMA_VERSION,
    _write_report as _write_project_203_report,
)


SYNTHETIC_ROLE_FIX_NAMES = {
    2: "合成主管甲",
    3: "合成主管乙",
    4: "合成主管丙",
}
SYNTHETIC_HISTORICAL_STUDENT_NAME = "合成歷史生"
SYNTHETIC_REFERENCE_DATABASE_SHA256 = "a" * 64
SYNTHETIC_PROJECT_NAME = "合成空殼相本"
SYNTHETIC_CAMPUS_NAME = "合成校區甲"
SYNTHETIC_CLASSROOM_NAME = "合成班級甲"
SYNTHETIC_PERIOD_NAME = "合成期別甲"
SYNTHETIC_TEMPLATE_ID = 250
SYNTHETIC_TEMPLATE_PERIOD_ID = 40
SYNTHETIC_OWNER_ID = 5
SYNTHETIC_WORK_SLOT_ID = 5600
SYNTHETIC_CAMPUS_ID = 3
SYNTHETIC_CLASSROOM_ID = 3
SYNTHETIC_UNUSED_WORK_SLOT_ID = 7001
SYNTHETIC_LEGACY_WORK_SLOT_ID = 7002
SYNTHETIC_REPLACEMENT_STUDENT_NAMES = (
    "測童甲",
    "測童乙",
    "測童丙",
    "測童丁",
    "測童戊",
    "測童己",
    "測童庚",
    "測童辛",
)


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_production_migration(
    target_path,
    source_path,
    organization_manifest_path,
    project_203_manifest_path,
):
    return _audit_production_migration(
        target_path,
        source_path,
        _sha256(source_path),
        organization_manifest_path,
        project_203_manifest_path,
    )


def _create_source_schema(connection):
    connection.executescript(
        """CREATE TABLE users (
               id INTEGER PRIMARY KEY,
               username TEXT NOT NULL,
               display_name TEXT NOT NULL,
               hashed_password TEXT NOT NULL,
               role TEXT NOT NULL,
               auth_version INTEGER NOT NULL
           );
           CREATE TABLE projects (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               template_id INTEGER NOT NULL,
               owner_id INTEGER,
               created_at TEXT,
               updated_at TEXT,
               deleted_at TEXT,
               archive_expires_at TEXT,
               label_texts_json TEXT NOT NULL,
               department TEXT,
               template_period_id INTEGER,
               completed_at TEXT,
               template_revision INTEGER NOT NULL
           );
           CREATE TABLE students (
               id INTEGER PRIMARY KEY,
               project_id INTEGER NOT NULL,
               name TEXT NOT NULL,
               order_index INTEGER NOT NULL,
               pages_data_json TEXT NOT NULL,
               output_filename TEXT,
               created_at TEXT,
               updated_at TEXT,
               roster_child_id INTEGER
           );
           CREATE TABLE templates (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               revision INTEGER NOT NULL,
               period_id INTEGER NOT NULL
           );
           CREATE TABLE template_periods (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               department TEXT NOT NULL,
               status TEXT NOT NULL
           );"""
    )


def _create_target_schema(connection):
    connection.executescript(
        """CREATE TABLE users (
               id INTEGER PRIMARY KEY,
               username TEXT NOT NULL,
               display_name TEXT NOT NULL,
               hashed_password TEXT NOT NULL,
               role TEXT NOT NULL,
               auth_version INTEGER NOT NULL
           );
           CREATE TABLE projects (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               template_id INTEGER NOT NULL,
               owner_id INTEGER,
               created_at TEXT,
               updated_at TEXT,
               deleted_at TEXT,
               archive_expires_at TEXT,
               label_texts_json TEXT NOT NULL,
               department TEXT,
               template_period_id INTEGER,
               completed_at TEXT,
               template_revision INTEGER NOT NULL,
               created_by_id INTEGER,
               created_by_name TEXT,
               classroom_id INTEGER,
               class_period_work_slot_id INTEGER,
               campus_id_snapshot INTEGER,
               campus_name_snapshot TEXT,
               classroom_name_snapshot TEXT
           );
           CREATE TABLE students (
               id INTEGER PRIMARY KEY,
               project_id INTEGER NOT NULL,
               name TEXT NOT NULL,
               order_index INTEGER NOT NULL,
               pages_data_json TEXT NOT NULL,
               output_filename TEXT,
               created_at TEXT,
               updated_at TEXT,
               roster_child_id INTEGER,
               album_name TEXT
           );
           CREATE TABLE templates (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               revision INTEGER NOT NULL,
               period_id INTEGER NOT NULL
           );
           CREATE TABLE template_periods (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               department TEXT NOT NULL,
               status TEXT NOT NULL
           );
           CREATE TABLE campuses (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL,
               is_active INTEGER NOT NULL
           );
           CREATE TABLE classrooms (
               id INTEGER PRIMARY KEY,
               campus_id INTEGER NOT NULL,
               name TEXT NOT NULL,
               department TEXT NOT NULL,
               is_active INTEGER NOT NULL
           );
           CREATE TABLE roster_children (
               id INTEGER PRIMARY KEY,
               name TEXT NOT NULL
           );
           CREATE TABLE class_roster_members (
               id INTEGER PRIMARY KEY,
               classroom_id INTEGER NOT NULL,
               roster_child_id INTEGER NOT NULL,
               started_at TEXT,
               ended_at TEXT,
               end_reason TEXT
           );
           CREATE TABLE classroom_teacher_assignments (
               id INTEGER PRIMARY KEY,
               classroom_id INTEGER NOT NULL,
               teacher_id INTEGER,
               duty TEXT NOT NULL,
               ended_at TEXT
           );
           CREATE TABLE organization_supervisor_assignments (
               id INTEGER PRIMARY KEY,
               campus_id INTEGER NOT NULL,
               department TEXT,
               supervisor_id INTEGER,
               ended_at TEXT
           );
           CREATE TABLE academic_terms (
               id INTEGER PRIMARY KEY,
               label TEXT NOT NULL,
               status TEXT NOT NULL,
               migration_key TEXT
           );
           CREATE TABLE term_reclassification_plans (
               id INTEGER PRIMARY KEY,
               status TEXT NOT NULL,
               target_academic_term_id INTEGER NOT NULL
           );
           CREATE TABLE class_period_work_slots (
               id INTEGER PRIMARY KEY,
               term_classroom_id INTEGER NOT NULL,
               term_period_id INTEGER NOT NULL,
               started_at TEXT
           );
           CREATE TABLE legacy_project_classroom_migrations (
               id INTEGER PRIMARY KEY,
               project_id_snapshot INTEGER NOT NULL
           );
           CREATE TABLE legacy_student_identity_resolutions (
               id INTEGER PRIMARY KEY,
               migration_id INTEGER NOT NULL,
               project_id_snapshot INTEGER NOT NULL,
               student_id_snapshot INTEGER NOT NULL,
               resolved_roster_child_id_snapshot INTEGER NOT NULL
           );
           CREATE TABLE legacy_teacher_supervisor_links (
               teacher_id INTEGER NOT NULL,
               supervisor_id INTEGER NOT NULL,
               teacher_name_snapshot TEXT NOT NULL,
               supervisor_name_snapshot TEXT NOT NULL
           );
           CREATE TABLE academic_term_periods (
               id INTEGER PRIMARY KEY,
               academic_term_id INTEGER NOT NULL,
               template_period_id INTEGER NOT NULL,
               period_name_snapshot TEXT NOT NULL,
               department TEXT NOT NULL
           );
           CREATE TABLE academic_term_classrooms (
               id INTEGER PRIMARY KEY,
               academic_term_id INTEGER NOT NULL,
               classroom_id INTEGER NOT NULL,
               campus_id_snapshot INTEGER NOT NULL,
               campus_name_snapshot TEXT NOT NULL,
               classroom_name_snapshot TEXT NOT NULL,
               department TEXT NOT NULL
           );
           CREATE TABLE academic_term_classroom_teachers (id INTEGER PRIMARY KEY);
           CREATE TABLE academic_term_classroom_students (
               id INTEGER PRIMARY KEY,
               academic_term_id INTEGER NOT NULL,
               term_classroom_id INTEGER NOT NULL,
               source_membership_id INTEGER,
               roster_child_id_snapshot INTEGER NOT NULL,
               student_name_snapshot TEXT NOT NULL
           );
           CREATE TABLE term_student_placements (id INTEGER PRIMARY KEY);
           CREATE TABLE term_classroom_plans (id INTEGER PRIMARY KEY);
           CREATE TABLE term_classroom_teacher_targets (id INTEGER PRIMARY KEY);
           """
    )


def _project_ids():
    return [*range(1, 132), 198, 199, 203]


def _archived_project_ids():
    return {*range(1, 59), 115, 199}


@pytest.fixture(autouse=True)
def _pin_synthetic_replay_identity(monkeypatch):
    replay_project_ids = sorted(
        set(_project_ids()) - _archived_project_ids() - {203}
    )
    replay_project_id_set = set(replay_project_ids)
    student_project_pairs = []
    student_id = 1
    student_counts = _student_counts_by_project()
    for project_id in _project_ids():
        for _order_index in range(student_counts[project_id]):
            if project_id in replay_project_id_set:
                student_project_pairs.append([student_id, project_id])
            student_id += 1
    summary = migration_module._reviewed_replay_identity_summary(
        replay_project_ids,
        student_project_pairs,
    )
    monkeypatch.setattr(
        migration_module,
        "EXPECTED_REPLAY_PROJECT_IDS_SHA256",
        summary["project_ids_sha256"],
    )
    monkeypatch.setattr(
        migration_module,
        "EXPECTED_REPLAY_STUDENT_PROJECT_PAIRS_SHA256",
        summary["student_project_pairs_sha256"],
    )
    monkeypatch.setattr(
        migration_module,
        "RELEASE_REFERENCE_DATABASE_SHA256",
        SYNTHETIC_REFERENCE_DATABASE_SHA256,
    )


def _insert_users(source, target):
    source_rows = []
    target_rows = []
    for user_id in range(1, 71):
        display_name = SYNTHETIC_ROLE_FIX_NAMES.get(user_id, f"使用者{user_id}")
        if user_id == 1:
            display_name = "系統管理員"
        if user_id == 1:
            target_role = "admin"
        elif 2 <= user_id <= 56:
            target_role = "teacher"
        elif 57 <= user_id <= 66:
            target_role = "supervisor"
        else:
            target_role = "art_team"
        source_role = (
            "supervisor"
            if user_id in SYNTHETIC_ROLE_FIX_NAMES
            else target_role
        )
        source_rows.append((
            user_id,
            f"user{user_id}",
            display_name,
            f"hash-{user_id}",
            source_role,
            0,
        ))
        target_rows.append((
            user_id,
            f"user{user_id}",
            display_name,
            f"hash-{user_id}",
            target_role,
            1 if user_id in SYNTHETIC_ROLE_FIX_NAMES else 0,
        ))
    source.executemany(
        "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
        source_rows,
    )
    target.executemany(
        "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)",
        target_rows,
    )


def _source_project_row(project_id, archived_ids):
    deleted_at = None
    archive_expires_at = None
    if project_id in archived_ids:
        deleted_at = "2026-07-18 01:00:00"
        archive_expires_at = "2026-08-17 01:00:00"
    name = (
        "2026-07 三階 最新線上內容"
        if project_id == 198
        else f"專案{project_id}"
    )
    if project_id == 203:
        name = SYNTHETIC_PROJECT_NAME
    return (
        project_id,
        name,
        SYNTHETIC_TEMPLATE_ID if project_id == 203 else 1,
        SYNTHETIC_OWNER_ID if project_id == 203 else 27,
        "2026-07-01 00:00:00",
        "2026-07-18 11:49:01" if project_id == 198 else "2026-07-01 00:00:00",
        deleted_at,
        archive_expires_at,
        json.dumps({"project": project_id}),
        "infant",
        SYNTHETIC_TEMPLATE_PERIOD_ID if project_id == 203 else 1,
        None,
        1,
    )


def _insert_projects(source, target):
    archived_ids = _archived_project_ids()
    source_rows = [
        _source_project_row(project_id, archived_ids)
        for project_id in _project_ids()
    ]
    source.executemany(
        """INSERT INTO projects VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )""",
        source_rows,
    )
    target_rows = []
    for source_row in source_rows:
        project_id = source_row[0]
        target_row = list(source_row)
        if project_id == 203:
            target_row[5] = "2026-07-18T13:00:00+00:00"
            target_row[6] = "2026-07-18T13:00:00+00:00"
            target_row[7] = "2026-08-17T13:00:00+00:00"
        is_active = project_id not in archived_ids and project_id != 203
        target_rows.append((
            *target_row,
            None,
            None,
            1 if is_active else None,
            SYNTHETIC_LEGACY_WORK_SLOT_ID if is_active else None,
            1 if is_active else None,
            "校區1" if is_active else None,
            "測試班" if is_active else None,
        ))
    target_rows.append((
        204,
        SYNTHETIC_PROJECT_NAME,
        SYNTHETIC_TEMPLATE_ID,
        SYNTHETIC_OWNER_ID,
        "2026-07-18T13:00:00+00:00",
        "2026-07-18T13:00:00+00:00",
        None,
        None,
        json.dumps({"project": 203}),
        "infant",
        SYNTHETIC_TEMPLATE_PERIOD_ID,
        None,
        3,
        1,
        "系統管理員",
        SYNTHETIC_CLASSROOM_ID,
        SYNTHETIC_WORK_SLOT_ID,
        SYNTHETIC_CAMPUS_ID,
        SYNTHETIC_CAMPUS_NAME,
        SYNTHETIC_CLASSROOM_NAME,
    ))
    target.executemany(
        """INSERT INTO projects VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )""",
        target_rows,
    )


def _student_counts_by_project():
    archived_ids = _archived_project_ids()
    active_ids = sorted(
        set(_project_ids()) - archived_ids - {203}
    )
    counts = {project_id: 8 for project_id in active_ids}
    for project_id in active_ids[:26]:
        counts[project_id] += 1
    archived_others = sorted(archived_ids - {115, 199})
    counts.update({project_id: 3 for project_id in archived_others})
    for project_id in archived_others[:2]:
        counts[project_id] += 1
    counts[115] = 4
    counts[199] = 1
    counts[203] = 0
    assert sum(counts.values()) == 791
    return counts


def _insert_students(source, target):
    student_id = 1
    replay_project_ids = sorted(
        set(_project_ids()) - _archived_project_ids() - {203}
    )
    replay_project_id_set = set(replay_project_ids)
    resolution_rows = []
    source_rows = []
    target_rows = []
    students_by_project = {}
    for project_id in _project_ids():
        project_student_ids = []
        for order_index in range(_student_counts_by_project()[project_id]):
            pages = (
                json.dumps([{"latest": f"p198-student-{student_id}"}])
                if project_id == 198
                else "[]"
            )
            source_roster_child_id = 100_000 + student_id
            target_roster_child_id = (
                200_000 + student_id
                if project_id in replay_project_id_set
                else source_roster_child_id
            )
            content = (
                student_id,
                project_id,
                f"學生{student_id}",
                order_index,
                pages,
                None,
                "2026-07-01 00:00:00",
                "2026-07-18 11:46:19" if project_id == 198 else "2026-07-01 00:00:00",
            )
            source_rows.append((*content, source_roster_child_id))
            target_rows.append((*content, target_roster_child_id, None))
            if project_id in replay_project_id_set:
                resolution_rows.append((
                    project_id,
                    student_id,
                    target_roster_child_id,
                ))
            project_student_ids.append(student_id)
            student_id += 1
        students_by_project[project_id] = project_student_ids
    source.executemany(
        "INSERT INTO students VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        source_rows,
    )
    target.executemany(
        "INSERT INTO students VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        target_rows,
    )
    return replay_project_ids, resolution_rows, students_by_project


def _insert_organization(target, resolution_rows):
    target.executemany(
        "INSERT INTO templates VALUES (?, ?, ?, ?)",
        [
            (1, "合成模板甲", 1, 1),
            (SYNTHETIC_TEMPLATE_ID, "合成模板目標", 3, SYNTHETIC_TEMPLATE_PERIOD_ID),
        ],
    )
    target.executemany(
        "INSERT INTO template_periods VALUES (?, ?, ?, 'active')",
        [
            (1, "一期", "infant"),
            (SYNTHETIC_TEMPLATE_PERIOD_ID, SYNTHETIC_PERIOD_NAME, "infant"),
        ],
    )
    target.executemany(
        """INSERT INTO legacy_teacher_supervisor_links
           VALUES (?, ?, ?, ?)""",
        [
            (
                link_id,
                1_000 + link_id,
                f"舊師{link_id}",
                f"舊主管{link_id}",
            )
            for link_id in range(1, 162)
        ],
    )
    _insert_organization_rows(target, resolution_rows)


def _table_columns(connection, table_name):
    return [
        str(row[1])
        for row in connection.execute(f'PRAGMA table_info("{table_name}")')
    ]


def _table_rows(connection, table_name, columns):
    column_sql = ", ".join(f'"{column}"' for column in columns)
    order_sql = " ORDER BY id" if "id" in columns else ""
    return [
        dict(row)
        for row in connection.execute(
            f'SELECT {column_sql} FROM "{table_name}"{order_sql}'
        )
    ]


def _create_organization_manifest(target_path, manifest_path):
    with closing(sqlite3.connect(target_path)) as connection:
        connection.row_factory = sqlite3.Row
        replay_project_ids = sorted(
            set(_project_ids()) - _archived_project_ids() - {203}
        )
        replacement_tables = {}
        for table_name in ORGANIZATION_REPLACEMENT_TABLES:
            columns = _table_columns(connection, table_name)
            rows = _table_rows(connection, table_name, columns)
            if table_name == "class_period_work_slots":
                for row in rows:
                    if int(row["id"]) == SYNTHETIC_WORK_SLOT_ID:
                        row["started_at"] = None
            replacement_tables[table_name] = {
                "columns": columns,
                "rows": rows,
            }
        placeholders = ",".join("?" for _id in replay_project_ids)
        project_updates = [
            dict(row)
            for row in connection.execute(
                f"""SELECT id, classroom_id, class_period_work_slot_id,
                           campus_id_snapshot, campus_name_snapshot,
                           classroom_name_snapshot
                    FROM projects WHERE id IN ({placeholders}) ORDER BY id""",
                replay_project_ids,
            )
        ]
        student_updates = [
            dict(row)
            for row in connection.execute(
                f"""SELECT id, project_id, roster_child_id
                    FROM students WHERE project_id IN ({placeholders})
                    ORDER BY id""",
                replay_project_ids,
            )
        ]
        ledger_rows = {}
        for table_name in (
            "legacy_project_classroom_migrations",
            "legacy_student_identity_resolutions",
        ):
            columns = _table_columns(connection, table_name)
            ledger_rows[table_name] = {
                "columns": columns,
                "rows": _table_rows(connection, table_name, columns),
            }
        user_updates = [
            {
                "id": int(row["id"]),
                "display_name": str(row["display_name"]),
                "source_role": "supervisor",
                "source_auth_version": int(row["auth_version"]) - 1,
                "role": str(row["role"]),
                "auth_version": int(row["auth_version"]),
            }
            for row in connection.execute(
                """SELECT id, display_name, role, auth_version FROM users
                   WHERE id IN (2, 3, 4) ORDER BY id"""
            )
        ]
        existing_roster_children = _table_rows(
            connection,
            "roster_children",
            ["id", "name"],
        )
        legacy_teacher_columns = [
            "teacher_id",
            "supervisor_id",
            "teacher_name_snapshot",
            "supervisor_name_snapshot",
        ]
        legacy_teacher_rows = _table_rows(
            connection,
            "legacy_teacher_supervisor_links",
            legacy_teacher_columns,
        )
        plan = {
            "schema_version": ORGANIZATION_PLAN_SCHEMA_VERSION,
            "operation": ORGANIZATION_OPERATION,
            "reference_database_sha256": SYNTHETIC_REFERENCE_DATABASE_SHA256,
            "replay_project_ids": replay_project_ids,
            "reviewed_replay_identity": (
                migration_module._reviewed_replay_identity_summary(
                    replay_project_ids,
                    [
                        [int(row["id"]), int(row["project_id"])]
                        for row in student_updates
                    ],
                )
            ),
            "excluded_project_ids": [203],
            "excluded_project_work_slot_id": SYNTHETIC_WORK_SLOT_ID,
            "required_archived_project_ids": [115, 199],
            "source_guard": {
                "existing_roster_children": existing_roster_children,
            },
            "user_updates": user_updates,
            "replacement_tables": replacement_tables,
            "roster_children_to_insert": {
                "columns": _table_columns(connection, "roster_children"),
                "rows": [],
            },
            "roster_children_to_delete": {
                "columns": _table_columns(connection, "roster_children"),
                "rows": [],
            },
            "preserved_legacy_teacher_supervisor_links": {
                "columns": legacy_teacher_columns,
                "rows": legacy_teacher_rows,
            },
            "project_updates": project_updates,
            "student_updates": student_updates,
            "ledger_rows": ledger_rows,
            "analysis": {
                "replay_project_count": len(project_updates),
                "replay_student_count": len(student_updates),
                "added_roster_child_count": 0,
                "deleted_roster_child_count": 0,
                "legacy_teacher_link_count": len(legacy_teacher_rows),
                "user_role_update_count": len(user_updates),
            },
        }
        applied_components = _planned_organization_components(plan)
        applied_hashes = _organization_component_hashes(applied_components)
        plan["applied_state_component_sha256"] = applied_hashes
        plan["source_state_component_sha256"] = {
            component_name: layout_sha256({"source": component_name})
            for component_name in applied_hashes
        }
    plan_sha256 = layout_sha256(plan)
    manifest = {
        "schema_version": ORGANIZATION_MANIFEST_SCHEMA_VERSION,
        "operation": ORGANIZATION_OPERATION,
        "run_id": "audit-fixture",
        "mode": "reviewed-apply",
        "overall_status": "complete",
        "database_status": "applied",
        "database_reconciliation": "applied",
        "review_plan": plan,
        "review_plan_sha256": plan_sha256,
        "applied_project_count": len(project_updates),
        "applied_student_count": len(student_updates),
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _create_project_203_manifest(manifest_path):
    report_path = manifest_path.with_name("project-203-repair-audit-fixture.csv")
    applied_at = "2026-07-18T13:00:00+00:00"
    source_fingerprint = layout_sha256({"source": "project-203-audit-fixture"})
    guard_fingerprint = layout_sha256({"guard": "project-203-audit-fixture"})
    full_names = SYNTHETIC_REPLACEMENT_STUDENT_NAMES
    plan = {
        "schema_version": PROJECT_203_PLAN_SCHEMA_VERSION,
        "operation": PROJECT_203_OPERATION,
        "reference_database_sha256": SYNTHETIC_REFERENCE_DATABASE_SHA256,
        "reference_guard_sha256": "b" * 64,
        "target_project_id": 203,
        "target_work_slot_id": SYNTHETIC_WORK_SLOT_ID,
        "archive_days": 30,
        "source_fingerprint": source_fingerprint,
        "guard_fingerprint": guard_fingerprint,
        "actor": {
            "id": 1,
            "username": "user1",
            "display_name": "系統管理員",
            "role": "admin",
        },
        "source_project": {
            "id": 203,
            "name": SYNTHETIC_PROJECT_NAME,
            "template_id": SYNTHETIC_TEMPLATE_ID,
            "owner_id": SYNTHETIC_OWNER_ID,
            "created_at": "2026-07-01 00:00:00",
            "updated_at": "2026-07-01 00:00:00",
            "deleted_at": None,
            "archive_expires_at": None,
            "label_texts_json": json.dumps({"project": 203}),
            "department": "infant",
            "template_period_id": SYNTHETIC_TEMPLATE_PERIOD_ID,
            "completed_at": None,
            "template_revision": 1,
            "classroom_id": SYNTHETIC_CLASSROOM_ID,
            "class_period_work_slot_id": SYNTHETIC_WORK_SLOT_ID,
            "created_by_id": None,
            "created_by_name": None,
            "campus_id_snapshot": SYNTHETIC_CAMPUS_ID,
            "campus_name_snapshot": SYNTHETIC_CAMPUS_NAME,
            "classroom_name_snapshot": SYNTHETIC_CLASSROOM_NAME,
        },
        "target_context": {
            "id": SYNTHETIC_WORK_SLOT_ID,
            "term_classroom_id": SYNTHETIC_CLASSROOM_ID,
            "term_period_id": 2,
            "academic_term_id": 1,
            "classroom_id": SYNTHETIC_CLASSROOM_ID,
            "campus_id_snapshot": SYNTHETIC_CAMPUS_ID,
            "campus_name_snapshot": SYNTHETIC_CAMPUS_NAME,
            "classroom_name_snapshot": SYNTHETIC_CLASSROOM_NAME,
            "classroom_department": "infant",
            "term_label": "114下學期",
            "term_status": "imported",
            "template_period_id": SYNTHETIC_TEMPLATE_PERIOD_ID,
            "period_name_snapshot": SYNTHETIC_PERIOD_NAME,
            "period_department": "infant",
        },
        "template": {
            "id": SYNTHETIC_TEMPLATE_ID,
            "name": "合成模板目標",
            "period_id": SYNTHETIC_TEMPLATE_PERIOD_ID,
            "revision": 3,
            "period_name": SYNTHETIC_PERIOD_NAME,
            "department": "infant",
            "status": "active",
        },
        "replacement_project": {
            "name": SYNTHETIC_PROJECT_NAME,
            "template_id": SYNTHETIC_TEMPLATE_ID,
            "template_revision": 3,
            "owner_id": SYNTHETIC_OWNER_ID,
            "label_texts_json": json.dumps({"project": 203}),
            "department": "infant",
            "template_period_id": SYNTHETIC_TEMPLATE_PERIOD_ID,
            "classroom_id": SYNTHETIC_CLASSROOM_ID,
            "class_period_work_slot_id": SYNTHETIC_WORK_SLOT_ID,
            "created_by_id": 1,
            "created_by_name": "系統管理員",
            "campus_id_snapshot": SYNTHETIC_CAMPUS_ID,
            "campus_name_snapshot": SYNTHETIC_CAMPUS_NAME,
            "classroom_name_snapshot": SYNTHETIC_CLASSROOM_NAME,
        },
        "students": [
            {
                "order_index": order_index,
                "membership_id": order_index + 1,
                "term_student_id": order_index + 1,
                "roster_child_id": 300_001 + order_index,
                "name": full_name,
                "album_name": full_name[1:],
            }
            for order_index, full_name in enumerate(full_names)
        ],
    }
    apply_plan = {
        "schema_version": PROJECT_203_APPLY_PLAN_SCHEMA_VERSION,
        "applied_at": applied_at,
        "archive_expires_at": "2026-08-17T13:00:00+00:00",
        "replacement_project_id": 204,
        "student_ids": list(range(792, 800)),
    }
    plan_sha256 = layout_sha256(plan)
    _write_project_203_report(
        report_path,
        "audit-fixture",
        plan_sha256,
        plan,
    )
    manifest = {
        "schema_version": PROJECT_203_MANIFEST_SCHEMA_VERSION,
        "operation": PROJECT_203_OPERATION,
        "run_id": "audit-fixture",
        "mode": "reviewed-apply",
        "overall_status": "complete",
        "database_status": "applied",
        "reference_database_sha256": SYNTHETIC_REFERENCE_DATABASE_SHA256,
        "report_filename": report_path.name,
        "report_sha256": _sha256(report_path),
        "review_plan": plan,
        "review_plan_sha256": plan_sha256,
        "source_fingerprint": source_fingerprint,
        "guard_fingerprint": guard_fingerprint,
        "apply_plan": apply_plan,
        "apply_plan_sha256": layout_sha256(apply_plan),
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report_path


def _insert_organization_rows(target, resolution_rows):
    target.executemany(
        "INSERT INTO campuses VALUES (?, ?, 1)",
        [
            (
                campus_id,
                (
                    SYNTHETIC_CAMPUS_NAME
                    if campus_id == SYNTHETIC_CAMPUS_ID
                    else f"校區{campus_id}"
                ),
            )
            for campus_id in range(1, 4)
        ],
    )
    target.executemany(
        "INSERT INTO classrooms VALUES (?, ?, ?, 'infant', 1)",
        [
            (
                classroom_id,
                (classroom_id - 1) % 3 + 1,
                (
                    SYNTHETIC_CLASSROOM_NAME
                    if classroom_id == SYNTHETIC_CLASSROOM_ID
                    else f"班級{classroom_id}"
                ),
            )
            for classroom_id in range(1, 39)
        ],
    )
    member_rows = []
    child_names = {}
    replacement_full_names = SYNTHETIC_REPLACEMENT_STUDENT_NAMES
    other_classroom_ids = [
        classroom_id
        for classroom_id in range(1, 39)
        if classroom_id != SYNTHETIC_CLASSROOM_ID
    ]
    for member_id in range(1, 467):
        roster_child_id = 300_000 + member_id
        if member_id <= 8:
            classroom_id = SYNTHETIC_CLASSROOM_ID
            child_name = replacement_full_names[member_id - 1]
        elif member_id == 466:
            classroom_id = 1
            child_name = SYNTHETIC_HISTORICAL_STUDENT_NAME
        else:
            classroom_id = other_classroom_ids[
                (member_id - 9) % len(other_classroom_ids)
            ]
            child_name = f"名冊學生{member_id}"
        child_names[roster_child_id] = child_name
        member_rows.append((
            member_id,
            classroom_id,
            roster_child_id,
            "2026-01-01",
            "2026-07-18" if member_id == 466 else None,
            "historical" if member_id == 466 else None,
        ))
    target.executemany(
        "INSERT INTO class_roster_members VALUES (?, ?, ?, ?, ?, ?)",
        member_rows,
    )
    target.executemany(
        "INSERT INTO classroom_teacher_assignments VALUES (?, ?, ?, ?, NULL)",
        [
            (
                assignment_id,
                (assignment_id - 1) % 38 + 1,
                assignment_id + 1,
                "lead" if assignment_id <= 38 else "co_teacher",
            )
            for assignment_id in range(1, 53)
        ],
    )
    target.executemany(
        "INSERT INTO organization_supervisor_assignments VALUES (?, ?, NULL, ?, NULL)",
        [
            (assignment_id, (assignment_id - 1) % 3 + 1, 56 + assignment_id)
            for assignment_id in range(1, 11)
        ],
    )
    target.executemany(
        "INSERT INTO academic_terms VALUES (?, ?, ?, ?)",
        [
            (1, "114下學期", "imported", "organization-reporting-v1"),
            (2, "115上", "draft", None),
        ],
    )
    target.executemany(
        "INSERT INTO academic_term_periods VALUES (?, ?, ?, ?, 'infant')",
        [
            (1, 1, 1, "一期"),
            (
                2,
                1,
                SYNTHETIC_TEMPLATE_PERIOD_ID,
                SYNTHETIC_PERIOD_NAME,
            ),
        ],
    )
    target.executemany(
        """INSERT INTO academic_term_classrooms
           VALUES (?, 1, ?, ?, ?, ?, 'infant')""",
        [
            (
                classroom_id,
                classroom_id,
                (classroom_id - 1) % 3 + 1,
                (
                    SYNTHETIC_CAMPUS_NAME
                    if (classroom_id - 1) % 3 + 1 == SYNTHETIC_CAMPUS_ID
                    else f"校區{(classroom_id - 1) % 3 + 1}"
                ),
                (
                    SYNTHETIC_CLASSROOM_NAME
                    if classroom_id == SYNTHETIC_CLASSROOM_ID
                    else f"班級{classroom_id}"
                ),
            )
            for classroom_id in range(1, 39)
        ],
    )
    target.executemany(
        """INSERT INTO academic_term_classroom_students
           VALUES (?, 1, ?, ?, ?, ?)""",
        [
            (
                order_index,
                SYNTHETIC_CLASSROOM_ID,
                order_index,
                300_000 + order_index,
                child_names[300_000 + order_index],
            )
            for order_index in range(1, 9)
        ],
    )
    target.execute(
        "INSERT INTO term_reclassification_plans VALUES (1, 'draft', 2)"
    )
    target.executemany(
        "INSERT INTO class_period_work_slots VALUES (?, ?, ?, ?)",
        [
            (SYNTHETIC_UNUSED_WORK_SLOT_ID, 1, 1, None),
            (
                SYNTHETIC_LEGACY_WORK_SLOT_ID,
                1,
                1,
                "2026-07-01 00:00:00",
            ),
            (
                SYNTHETIC_WORK_SLOT_ID,
                SYNTHETIC_CLASSROOM_ID,
                2,
                "2026-07-18T13:00:00+00:00",
            ),
        ],
    )
    replay_project_ids = sorted({row[0] for row in resolution_rows})
    header_id_by_project = {
        project_id: header_id
        for header_id, project_id in enumerate(replay_project_ids, start=1)
    }
    target.executemany(
        "INSERT INTO legacy_project_classroom_migrations VALUES (?, ?)",
        [
            (header_id, project_id)
            for project_id, header_id in header_id_by_project.items()
        ],
    )
    target.executemany(
        """INSERT INTO legacy_student_identity_resolutions
           VALUES (?, ?, ?, ?, ?)""",
        [
            (
                resolution_id,
                header_id_by_project[project_id],
                project_id,
                student_id,
                roster_child_id,
            )
            for resolution_id, (
                project_id,
                student_id,
                roster_child_id,
            ) in enumerate(resolution_rows, start=1)
        ],
    )

    referenced_child_rows = {
        int(row[0]): f"學生身分{row[0]}"
        for row in target.execute(
            "SELECT DISTINCT roster_child_id FROM students WHERE roster_child_id IS NOT NULL"
        )
    }
    referenced_child_rows.update(child_names)
    target.executemany(
        "INSERT INTO roster_children VALUES (?, ?)",
        sorted(referenced_child_rows.items()),
    )
    target.executemany(
        """INSERT INTO students
           VALUES (?, 204, ?, ?, '[]', NULL, ?, ?, ?, ?)""",
        [
            (
                791 + order_index,
                child_names[300_000 + order_index],
                order_index - 1,
                "2026-07-18T13:00:00+00:00",
                "2026-07-18T13:00:00+00:00",
                300_000 + order_index,
                child_names[300_000 + order_index][1:],
            )
            for order_index in range(1, 9)
        ],
    )


def _create_databases(tmp_path):
    source_path = tmp_path / "source.db"
    target_path = tmp_path / "target.db"
    organization_manifest_path = tmp_path / "organization.manifest.json"
    project_203_manifest_path = tmp_path / "project-203.manifest.json"
    with (
        closing(sqlite3.connect(source_path)) as source,
        closing(sqlite3.connect(target_path)) as target,
    ):
        _create_source_schema(source)
        _create_target_schema(target)
        _insert_users(source, target)
        _insert_projects(source, target)
        _replay_projects, resolution_rows, _students = _insert_students(
            source,
            target,
        )
        source.executemany(
            "INSERT INTO templates VALUES (?, ?, ?, ?)",
            [
                (1, "合成模板甲", 1, 1),
                (
                    SYNTHETIC_TEMPLATE_ID,
                    "合成模板目標",
                    3,
                    SYNTHETIC_TEMPLATE_PERIOD_ID,
                ),
            ],
        )
        source.executemany(
            "INSERT INTO template_periods VALUES (?, ?, ?, 'active')",
            [
                (1, "一期", "infant"),
                (
                    SYNTHETIC_TEMPLATE_PERIOD_ID,
                    SYNTHETIC_PERIOD_NAME,
                    "infant",
                ),
            ],
        )
        _insert_organization(target, resolution_rows)
        source.commit()
        target.commit()
    _create_organization_manifest(target_path, organization_manifest_path)
    _create_project_203_manifest(project_203_manifest_path)
    return (
        source_path,
        target_path,
        organization_manifest_path,
        project_203_manifest_path,
    )


def _failed_check_names(result):
    return {
        check["name"]
        for check in result["checks"]
        if not check["ok"]
    }


def test_production_migration_audit_passes_and_never_writes_databases(
    tmp_path,
    capsys,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    source_before = _sha256(source_path)
    target_before = _sha256(target_path)
    manifest_before = _sha256(manifest_path)
    project_manifest_before = _sha256(project_manifest_path)
    project_report_path = project_manifest_path.with_name(
        "project-203-repair-audit-fixture.csv"
    )
    project_report_before = _sha256(project_report_path)

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is True
    assert result["summary"]["total"] == 37
    assert result["summary"]["failed"] == 0
    assert _sha256(source_path) == source_before
    assert _sha256(target_path) == target_before
    assert _sha256(manifest_path) == manifest_before
    assert _sha256(project_manifest_path) == project_manifest_before
    assert _sha256(project_report_path) == project_report_before

    output_path = tmp_path / "audit.json"
    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        _sha256(source_path),
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
        "--output",
        str(output_path),
    ]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["output_written"] is True
    assert all(set(check) == {"name", "ok"} for check in payload["checks"])
    saved_payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert saved_payload["ok"] is True
    assert saved_payload["contains_personal_data"] is True
    assert saved_payload["summary"] == payload["summary"]
    assert not output_path.with_suffix(".json.tmp").exists()
    assert _sha256(source_path) == source_before
    assert _sha256(target_path) == target_before
    assert _sha256(manifest_path) == manifest_before
    assert _sha256(project_manifest_path) == project_manifest_before
    assert _sha256(project_report_path) == project_report_before


def test_production_migration_audit_rejects_project_198_content_drift(
    tmp_path,
    capsys,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            """UPDATE students SET pages_data_json='[]'
               WHERE id=(SELECT MIN(id) FROM students WHERE project_id=198)"""
        )

    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        _sha256(source_path),
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
    ]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False
    assert "existing_student_non_organization_content" in _failed_check_names(result)
    assert "project_198_latest_content_preserved" in _failed_check_names(result)


def test_production_migration_audit_rejects_orphan_and_archived_link_change(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "INSERT INTO roster_children VALUES (999999, '孤兒')"
        )
        connection.execute(
            "INSERT INTO roster_children VALUES (999998, '未引用孤兒')"
        )
        connection.execute(
            """UPDATE students SET roster_child_id=999999
               WHERE id=(SELECT MIN(id) FROM students WHERE project_id=115)"""
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    failed_names = _failed_check_names(result)
    assert result["ok"] is False
    assert "orphan_roster_children" in failed_names
    assert "archived_project_student_links_preserved" in failed_names
    assert "student_roster_links_follow_resolution_ledger_only" in failed_names


def test_production_migration_audit_rejects_password_change(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE users SET hashed_password='unexpected' WHERE id=10"
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "user_roles_and_auth_versions" in _failed_check_names(result)
    user_check = next(
        check
        for check in result["checks"]
        if check["name"] == "user_roles_and_auth_versions"
    )
    assert user_check["actual"]["mismatches"] == [{
        "id": 10,
        "error": "identity_or_password_changed",
        "fields": ["hashed_password"],
    }]


def test_production_migration_audit_rejects_reviewed_role_fix_drift(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    synthetic_user_id = min(SYNTHETIC_ROLE_FIX_NAMES)
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE users SET role='supervisor', auth_version=0 WHERE id=?",
            (synthetic_user_id,),
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "user_roles_and_auth_versions" in _failed_check_names(result)


def test_production_migration_audit_rejects_historical_child_name_drift(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            """UPDATE roster_children SET name='合成漂移姓名'
               WHERE id=(
                   SELECT roster_child_id FROM class_roster_members
                   WHERE ended_at IS NOT NULL
               )"""
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert (
        "historical_roster_member_matches_reviewed_plan"
        in _failed_check_names(result)
    )


def test_production_migration_audit_rejects_mapping_outside_reviewed_plan(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE projects SET classroom_id=2 WHERE id=59"
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert (
        "organization_manifest_applied_components"
        in _failed_check_names(result)
    )


def test_production_migration_audit_rejects_wrong_reference_provenance(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["review_plan"]["reference_database_sha256"] = "0" * 64
    manifest["review_plan_sha256"] = layout_sha256(manifest["review_plan"])
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "organization_manifest_contract" in _failed_check_names(result)


def test_production_migration_audit_rejects_review_plan_sha_tamper(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["review_plan"]["excluded_project_ids"] = []
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "organization_manifest_contract" in _failed_check_names(result)


def test_production_migration_audit_rejects_project_203_report_tamper(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_report_path = project_manifest_path.with_name(
        "project-203-repair-audit-fixture.csv"
    )
    project_report_path.write_text("tampered", encoding="utf-8")
    report_before = _sha256(project_report_path)
    project_manifest_before = _sha256(project_manifest_path)

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_manifest_contract" in _failed_check_names(result)
    assert _sha256(project_report_path) == report_before
    assert _sha256(project_manifest_path) == project_manifest_before


def test_production_migration_audit_rejects_incomplete_project_203_manifest(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["overall_status"] = "applying"
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_manifest_contract" in _failed_check_names(result)


def test_production_migration_audit_rejects_project_203_plan_database_drift(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["review_plan"]["replacement_project"]["owner_id"] = 1
    project_manifest["review_plan"]["source_project"]["owner_id"] = 1
    project_manifest["review_plan_sha256"] = layout_sha256(
        project_manifest["review_plan"]
    )
    project_report_path = project_manifest_path.with_name(
        project_manifest["report_filename"]
    )
    _write_project_203_report(
        project_report_path,
        project_manifest["run_id"],
        project_manifest["review_plan_sha256"],
        project_manifest["review_plan"],
    )
    project_manifest["report_sha256"] = _sha256(project_report_path)
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_replacement_metadata" in _failed_check_names(result)


def test_production_migration_audit_rejects_project_203_apply_database_drift(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["apply_plan"]["replacement_project_id"] = 205
    project_manifest["apply_plan_sha256"] = layout_sha256(
        project_manifest["apply_plan"]
    )
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_replacement_metadata" in _failed_check_names(result)


def test_production_migration_audit_rejects_missing_immutable_source_table(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(source_path) as connection:
        connection.execute(
            "CREATE TABLE immutable_records (id INTEGER PRIMARY KEY, payload TEXT)"
        )
        connection.execute("INSERT INTO immutable_records VALUES (1, '保留')")

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "source_immutable_tables_preserved" in _failed_check_names(result)
    preservation_check = next(
        check
        for check in result["checks"]
        if check["name"] == "source_immutable_tables_preserved"
    )
    assert preservation_check["actual"]["missing_target_tables"] == [
        "immutable_records"
    ]


def test_production_migration_audit_rejects_immutable_source_row_drift(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    for database_path, payload in (
        (source_path, "保留"),
        (target_path, "遭修改"),
    ):
        with sqlite3.connect(database_path) as connection:
            connection.execute(
                "CREATE TABLE immutable_records (id INTEGER PRIMARY KEY, payload TEXT)"
            )
            connection.execute(
                "INSERT INTO immutable_records VALUES (1, ?)",
                (payload,),
            )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    preservation_check = next(
        check
        for check in result["checks"]
        if check["name"] == "source_immutable_tables_preserved"
    )
    assert preservation_check["actual"]["mismatched_tables"] == [
        "immutable_records"
    ]


def test_production_migration_audit_rejects_source_template_drift(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE templates SET revision=99 WHERE id=?",
            (SYNTHETIC_TEMPLATE_ID,),
        )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    preservation_check = next(
        check
        for check in result["checks"]
        if check["name"] == "source_immutable_tables_preserved"
    )
    assert preservation_check["actual"]["mismatched_tables"] == ["templates"]


def test_production_migration_audit_rejects_joint_snapshot_manifest_drift(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            "UPDATE projects SET campus_name_snapshot='錯誤校區' WHERE id=204"
        )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["review_plan"]["replacement_project"][
        "campus_name_snapshot"
    ] = "錯誤校區"
    project_manifest["review_plan"]["source_project"][
        "campus_name_snapshot"
    ] = "錯誤校區"
    project_manifest["review_plan"]["target_context"][
        "campus_name_snapshot"
    ] = "錯誤校區"
    project_manifest["review_plan_sha256"] = layout_sha256(
        project_manifest["review_plan"]
    )
    project_report_path = project_manifest_path.with_name(
        project_manifest["report_filename"]
    )
    _write_project_203_report(
        project_report_path,
        project_manifest["run_id"],
        project_manifest["review_plan_sha256"],
        project_manifest["review_plan"],
    )
    project_manifest["report_sha256"] = _sha256(project_report_path)
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_replacement_metadata" in _failed_check_names(result)


def test_production_migration_audit_rejects_joint_template_manifest_drift(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute("UPDATE projects SET template_id=1 WHERE id=204")
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["review_plan"]["replacement_project"]["template_id"] = 1
    project_manifest["review_plan"]["source_project"]["template_id"] = 1
    project_manifest["review_plan"]["template"]["id"] = 1
    project_manifest["review_plan_sha256"] = layout_sha256(
        project_manifest["review_plan"]
    )
    project_report_path = project_manifest_path.with_name(
        project_manifest["report_filename"]
    )
    _write_project_203_report(
        project_report_path,
        project_manifest["run_id"],
        project_manifest["review_plan_sha256"],
        project_manifest["review_plan"],
    )
    project_manifest["report_sha256"] = _sha256(project_report_path)
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_replacement_metadata" in _failed_check_names(result)


def test_production_migration_audit_rejects_membership_evidence_drift(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_manifest["review_plan"]["students"][0]["membership_id"] = 999
    project_manifest["review_plan"]["students"][0]["term_student_id"] = 998
    project_manifest["review_plan_sha256"] = layout_sha256(
        project_manifest["review_plan"]
    )
    project_report_path = project_manifest_path.with_name(
        project_manifest["report_filename"]
    )
    _write_project_203_report(
        project_report_path,
        project_manifest["run_id"],
        project_manifest["review_plan_sha256"],
        project_manifest["review_plan"],
    )
    project_manifest["report_sha256"] = _sha256(project_report_path)
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_replacement_metadata" in _failed_check_names(result)


def test_production_migration_audit_rejects_duplicate_term_student_evidence(
    tmp_path,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    with sqlite3.connect(target_path) as connection:
        connection.execute(
            """INSERT INTO academic_term_classroom_students
               VALUES (0, 1, ?, 1, 300001, ?)""",
            (
                SYNTHETIC_CLASSROOM_ID,
                SYNTHETIC_REPLACEMENT_STUDENT_NAMES[0],
            ),
        )
    _create_organization_manifest(target_path, manifest_path)

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    metadata_check = next(
        check
        for check in result["checks"]
        if check["name"] == "project_203_replacement_metadata"
    )
    membership_contract = metadata_check["actual"]["project_203_manifest"][
        "membership_contract"
    ]
    assert membership_contract["ok"] is False
    assert membership_contract["term_students"] == 9


def test_production_migration_audit_rejects_semantic_csv_drift(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    project_manifest = json.loads(
        project_manifest_path.read_text(encoding="utf-8")
    )
    project_report_path = project_manifest_path.with_name(
        project_manifest["report_filename"]
    )
    report_text = project_report_path.read_text(encoding="utf-8-sig")
    project_report_path.write_text(
        report_text.replace(",1,1,300001,", ",999,1,300001,", 1),
        encoding="utf-8-sig",
    )
    project_manifest["report_sha256"] = _sha256(project_report_path)
    project_manifest_path.write_text(
        json.dumps(project_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    result = audit_production_migration(
        target_path,
        source_path,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert "project_203_manifest_contract" in _failed_check_names(result)


def test_production_migration_audit_rejects_wrong_source_sha256(tmp_path):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )

    result = _audit_production_migration(
        target_path,
        source_path,
        "0" * 64,
        manifest_path,
        project_manifest_path,
    )

    assert result["ok"] is False
    assert _failed_check_names(result) == {"source_database_sha256"}


@pytest.mark.parametrize("sidecar_suffix", ["-wal", "-shm"])
def test_production_migration_audit_rejects_source_sidecar_before_hash(
    tmp_path,
    monkeypatch,
    capsys,
    sidecar_suffix,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    source_sha256 = _sha256(source_path)
    source_sidecar = source_path.with_name(source_path.name + sidecar_suffix)
    source_sidecar.write_bytes(b"")
    hash_calls = []
    original_file_sha256 = audit_module._file_sha256

    def recording_file_sha256(path):
        hash_calls.append(path)
        return original_file_sha256(path)

    monkeypatch.setattr(
        audit_module,
        "_file_sha256",
        recording_file_sha256,
    )

    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        source_sha256,
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
    ]) == 1
    result = json.loads(capsys.readouterr().out)
    assert _failed_check_names(result) == {"audit_execution"}
    assert set(result["checks"][0]) == {"name", "ok"}
    assert hash_calls == []


def test_production_migration_audit_rejects_source_sidecar_created_while_open(
    tmp_path,
    monkeypatch,
    capsys,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    source_sha256 = _sha256(source_path)
    source_sidecar = source_path.with_name(source_path.name + "-wal")
    original_read_only_connection = audit_module._read_only_connection

    @contextmanager
    def connection_creating_sidecar(database_path, *, immutable=False):
        try:
            with original_read_only_connection(
                database_path,
                immutable=immutable,
            ) as connection:
                yield connection
        finally:
            if immutable:
                source_sidecar.write_bytes(b"")

    monkeypatch.setattr(
        audit_module,
        "_read_only_connection",
        connection_creating_sidecar,
    )

    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        source_sha256,
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
    ]) == 1
    result = json.loads(capsys.readouterr().out)
    assert _failed_check_names(result) == {"audit_execution"}
    assert set(result["checks"][0]) == {"name", "ok"}


def test_production_migration_audit_requires_source_sha256(tmp_path, capsys):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )

    with pytest.raises(SystemExit) as error:
        audit_main([
            "--db",
            str(target_path),
            "--source-db",
            str(source_path),
            "--organization-manifest",
            str(manifest_path),
            "--project-203-manifest",
            str(project_manifest_path),
        ])

    assert error.value.code == 2
    assert "--source-sha256" in capsys.readouterr().err


def test_production_migration_audit_rejects_source_change_after_open(
    tmp_path,
    monkeypatch,
    capsys,
):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    source_sha256 = _sha256(source_path)
    observed_hashes = iter([source_sha256, "0" * 64])
    monkeypatch.setattr(
        audit_module,
        "_file_sha256",
        lambda _path: next(observed_hashes),
    )

    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        source_sha256,
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
    ]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False
    assert _failed_check_names(result) == {"audit_execution"}
    assert set(result["checks"][0]) == {"name", "ok"}


def test_production_migration_audit_output_parent_must_exist(tmp_path, capsys):
    source_path, target_path, manifest_path, project_manifest_path = (
        _create_databases(tmp_path)
    )
    output_path = tmp_path / "missing" / "audit.json"

    assert audit_main([
        "--db",
        str(target_path),
        "--source-db",
        str(source_path),
        "--source-sha256",
        _sha256(source_path),
        "--organization-manifest",
        str(manifest_path),
        "--project-203-manifest",
        str(project_manifest_path),
        "--output",
        str(output_path),
    ]) == 2
    assert "--output 父目錄不存在" in capsys.readouterr().err
    assert not output_path.parent.exists()


def test_production_migration_audit_missing_input_returns_usage_error(
    tmp_path,
    capsys,
):
    missing_path = tmp_path / "missing.db"

    assert audit_main([
        "--db",
        str(missing_path),
        "--source-db",
        str(missing_path),
        "--source-sha256",
        "0" * 64,
        "--organization-manifest",
        str(missing_path),
        "--project-203-manifest",
        str(missing_path),
    ]) == 2
    assert "找不到必要檔案" in capsys.readouterr().err
