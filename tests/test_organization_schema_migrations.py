from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import configure_mappers


def _create_legacy_organization_schema(database_path: Path):
    migration_engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    with migration_engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))
        connection.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, display_name VARCHAR)"
        ))
        connection.execute(text(
            "CREATE TABLE teacher_supervisors ("
            "teacher_id INTEGER NOT NULL, supervisor_id INTEGER NOT NULL, "
            "PRIMARY KEY (teacher_id, supervisor_id))"
        ))
        connection.execute(text(
            "CREATE TABLE roster_children (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)"
        ))
        connection.execute(text(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)"
        ))
        connection.execute(text(
            "CREATE TABLE campuses (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)"
        ))
        connection.execute(text(
            "CREATE TABLE classrooms ("
            "id INTEGER PRIMARY KEY, campus_id INTEGER NOT NULL REFERENCES campuses(id), "
            "name VARCHAR NOT NULL)"
        ))
        connection.execute(text(
            "CREATE TABLE class_roster_members ("
            "id INTEGER PRIMARY KEY, classroom_id INTEGER NOT NULL REFERENCES classrooms(id), "
            "roster_child_id INTEGER NOT NULL REFERENCES roster_children(id))"
        ))
        connection.execute(text(
            "INSERT INTO users (id, display_name) VALUES "
            "(1, '主教'), (2, '協同'), (3, '管理員')"
        ))
        connection.execute(text(
            "INSERT INTO teacher_supervisors (teacher_id, supervisor_id) VALUES (2, 1)"
        ))
        connection.execute(text(
            "INSERT INTO campuses (id, name) VALUES (1, '總校')"
        ))
        connection.execute(text(
            "INSERT INTO classrooms (id, campus_id, name) VALUES "
            "(1, 1, '太陽班'), (2, 1, '月亮班')"
        ))
        connection.execute(text(
            "INSERT INTO roster_children (id, name) VALUES (1, '甲生'), (2, '乙生')"
        ))
        connection.execute(text(
            "INSERT INTO class_roster_members (id, classroom_id, roster_child_id) VALUES "
            "(1, 1, 1), (2, 1, 2)"
        ))
        connection.execute(text(
            "INSERT INTO projects (id, name) VALUES (1, '舊相本')"
        ))
    # 改名排在所有 migration 之前，所以 legacy schema 建完就套用；
    # 後續步驟看到的表名與 run_migrations 一致。
    with migration_engine.connect() as connection:
        import migrations

        migrations._rename_classroom_membership_tables(connection)
    return migration_engine


def _execute_integrity_error(migration_engine, statement: str):
    with pytest.raises(IntegrityError):
        with migration_engine.begin() as connection:
            connection.execute(text(statement))


def test_roster_child_album_name_migration_is_idempotent_and_preserves_rows(
    tmp_path,
):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'roster-child-album-name.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("""
                CREATE TABLE roster_children (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text(
                "INSERT INTO roster_children (id, name) VALUES (1, '王小明')"
            ))
            connection.commit()

            migrations._add_roster_child_album_name_column(connection)
            migrations._add_roster_child_album_name_column(connection)

            columns = {
                row[1]
                for row in connection.execute(text(
                    "PRAGMA table_info(roster_children)"
                ))
            }
            assert "album_name" in columns
            assert connection.execute(text(
                "SELECT name, album_name FROM roster_children WHERE id = 1"
            )).one() == ("王小明", None)
    finally:
        migration_engine.dispose()


def _create_album_name_authority_schema(connection):
    connection.execute(text("""
        CREATE TABLE roster_children (
            id INTEGER PRIMARY KEY,
            name VARCHAR NOT NULL,
            album_name VARCHAR
        )
    """))
    connection.execute(text("""
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY,
            classroom_id INTEGER,
            updated_at DATETIME
        )
    """))
    connection.execute(text("""
        CREATE TABLE students (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL,
            roster_child_id INTEGER,
            name VARCHAR NOT NULL,
            album_name VARCHAR,
            output_filename VARCHAR,
            updated_at DATETIME
        )
    """))


def test_assigned_album_name_authority_migration_backfills_and_ignores_provisional(
    tmp_path,
):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'assigned-album-authority.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            _create_album_name_authority_schema(connection)
            connection.execute(text("""
                INSERT INTO roster_children (id, name, album_name)
                VALUES
                    (1, '王小明', NULL),
                    (2, '未歸班孩子', NULL),
                    (3, '中央孩子', '中央稱呼'),
                    (4, '林小華', NULL),
                    (5, '空白舊值', NULL)
            """))
            connection.execute(text("""
                INSERT INTO projects (id, classroom_id, updated_at)
                VALUES
                    (1, 10, '2000-01-01'),
                    (2, 10, '2000-01-01'),
                    (3, NULL, '2000-01-01'),
                    (4, 10, '2000-01-01'),
                    (5, 10, '2000-01-01'),
                    (6, 10, '2000-01-01')
            """))
            connection.execute(text("""
                INSERT INTO students (
                    id, project_id, roster_child_id, name, album_name,
                    output_filename, updated_at
                ) VALUES
                    (1, 1, 1, '王小明', '小明', 'same.pdf', '2000-01-01'),
                    (2, 2, 1, '王小明', NULL, 'changed.pdf', '2000-01-01'),
                    (3, 3, 2, '未歸班快照', '舊相本稱呼', 'legacy.pdf', '2000-01-01'),
                    (4, 4, 3, '中央孩子', '舊稱呼', 'prepopulated.pdf', '2000-01-01'),
                    (5, 5, 4, '林小華', '  小華  ', 'padded.pdf', '2000-01-01'),
                    (6, 6, 5, '空白舊值', '', 'empty.pdf', '2000-01-01')
            """))
            connection.commit()

            migrations._migrate_assigned_album_names_to_roster_authority(connection)
            migrations._migrate_assigned_album_names_to_roster_authority(connection)

            assert list(connection.execute(text("""
                SELECT id, album_name FROM roster_children ORDER BY id
            """))) == [
                (1, "小明"),
                (2, None),
                (3, "中央稱呼"),
                (4, "小華"),
                (5, None),
            ]
            assert list(connection.execute(text("""
                SELECT id, album_name, output_filename
                FROM students ORDER BY id
            """))) == [
                (1, None, "same.pdf"),
                (2, None, None),
                (3, "舊相本稱呼", "legacy.pdf"),
                (4, None, None),
                (5, None, None),
                (6, None, None),
            ]
            assert connection.execute(text("""
                SELECT COUNT(*)
                FROM schema_migration_markers
                WHERE migration_key = '202607_roster_child_album_name_authority_v1'
            """)).scalar_one() == 1
    finally:
        migration_engine.dispose()


def test_assigned_album_name_authority_migration_refuses_conflicting_values(
    tmp_path,
):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'assigned-album-conflict.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            _create_album_name_authority_schema(connection)
            connection.execute(text("""
                INSERT INTO roster_children (id, name, album_name)
                VALUES (1, '王小明', NULL)
            """))
            connection.execute(text("""
                INSERT INTO projects (id, classroom_id, updated_at)
                VALUES (1, 10, '2000-01-01'), (2, 10, '2000-01-01')
            """))
            connection.execute(text("""
                INSERT INTO students (
                    id, project_id, roster_child_id, name, album_name,
                    output_filename, updated_at
                ) VALUES
                    (1, 1, 1, '王小明', '小明', 'one.pdf', '2000-01-01'),
                    (2, 2, 1, '王小明', '明明', 'two.pdf', '2000-01-01')
            """))
            connection.commit()

            with pytest.raises(RuntimeError, match="roster_child_ids=1"):
                migrations._migrate_assigned_album_names_to_roster_authority(
                    connection
                )
            assert connection.execute(text("""
                SELECT album_name FROM roster_children WHERE id = 1
            """)).scalar_one() is None
            assert list(connection.execute(text("""
                SELECT album_name, output_filename FROM students ORDER BY id
            """))) == [("小明", "one.pdf"), ("明明", "two.pdf")]
    finally:
        migration_engine.dispose()


def test_fresh_legacy_students_remain_unlinked_even_when_names_match(tmp_path):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'fresh_legacy_students.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("""
                CREATE TABLE students (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                INSERT INTO students (id, project_id, name)
                VALUES (1, 10, '王 小明'), (2, 11, '王小明')
            """))
            connection.commit()

            migrations._add_roster_children_and_backfill(connection)
            migrations._add_roster_children_and_backfill(connection)

            assert list(connection.execute(text("""
                SELECT id, roster_child_id FROM students ORDER BY id
            """))) == [(1, None), (2, None)]
            assert connection.execute(text(
                "SELECT COUNT(*) FROM roster_children"
            )).scalar_one() == 0
    finally:
        migration_engine.dispose()


def test_existing_name_grouped_links_are_preserved_as_provisional_evidence(
    tmp_path,
):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'existing_grouped_students.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("""
                CREATE TABLE roster_children (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                CREATE TABLE students (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL,
                    name VARCHAR NOT NULL,
                    roster_child_id INTEGER REFERENCES roster_children(id)
                )
            """))
            connection.execute(text(
                "INSERT INTO roster_children (id, name) VALUES (7, '王小明')"
            ))
            connection.execute(text("""
                INSERT INTO students (id, project_id, name, roster_child_id)
                VALUES (1, 10, '王 小明', 7), (2, 11, '王小明', 7)
            """))
            connection.commit()

            migrations._add_roster_children_and_backfill(connection)
            migrations._add_roster_children_and_backfill(connection)

            assert list(connection.execute(text("""
                SELECT id, roster_child_id FROM students ORDER BY id
            """))) == [(1, 7), (2, 7)]
            assert connection.execute(text(
                "SELECT COUNT(*) FROM roster_children"
            )).scalar_one() == 1
    finally:
        migration_engine.dispose()


def test_identity_migration_ledger_has_no_operational_foreign_keys(tmp_path):
    import migrations
    from database import Base

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'identity_migration_ledger.db').as_posix()}"
    )
    try:
        Base.metadata.create_all(migration_engine)
        with migration_engine.connect() as connection:
            migrations._add_legacy_project_identity_migration_schema(connection)
            migrations._add_legacy_project_identity_migration_schema(connection)

            header_fks = list(connection.execute(text(
                "PRAGMA foreign_key_list(legacy_project_classroom_migrations)"
            )))
            resolution_fks = list(connection.execute(text(
                "PRAGMA foreign_key_list(legacy_student_identity_resolutions)"
            )))
            assert header_fks == []
            assert len(resolution_fks) == 1
            assert resolution_fks[0][2] == "legacy_project_classroom_migrations"
            assert resolution_fks[0][3:5] == ("migration_id", "id")

            trigger_names = {
                row[0] for row in connection.execute(text("""
                    SELECT name FROM sqlite_master WHERE type = 'trigger'
                """))
            }
            assert {
                "trg_students_freeze_class_backed_identity",
                "trg_projects_reject_empty_identity_migration",
                "trg_projects_require_identity_migration_ledger",
                "trg_legacy_project_migrations_no_update",
                "trg_legacy_project_migrations_no_delete",
                "trg_legacy_student_resolutions_no_update",
                "trg_legacy_student_resolutions_no_delete",
            } <= trigger_names
    finally:
        migration_engine.dispose()


def test_class_backed_identity_anomalies_are_quarantined_without_guessing(
    tmp_path,
):
    import migrations

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'identity_quarantine.db').as_posix()}"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("""
                CREATE TABLE campuses (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                CREATE TABLE classrooms (
                    id INTEGER PRIMARY KEY,
                    campus_id INTEGER NOT NULL REFERENCES campuses(id),
                    department VARCHAR NOT NULL,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                CREATE TABLE roster_children (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            """))
            connection.execute(text("""
                CREATE TABLE projects (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    department VARCHAR,
                    deleted_at DATETIME,
                    archive_expires_at DATETIME,
                    classroom_id INTEGER REFERENCES classrooms(id),
                    campus_name_snapshot VARCHAR,
                    classroom_name_snapshot VARCHAR
                )
            """))
            connection.execute(text("""
                CREATE TABLE students (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id),
                    name VARCHAR NOT NULL,
                    roster_child_id INTEGER REFERENCES roster_children(id)
                )
            """))
            connection.execute(text(
                "INSERT INTO campuses (id, name) VALUES (1, '總校')"
            ))
            connection.execute(text("""
                INSERT INTO classrooms (id, campus_id, department, name)
                VALUES (10, 1, 'infant', '太陽班')
            """))
            connection.execute(text("""
                INSERT INTO roster_children (id, name)
                VALUES (1, '甲生'), (2, '乙生'), (3, '丙生'), (4, '丁生')
            """))
            connection.execute(text("""
                INSERT INTO projects (
                    id, name, department, deleted_at, archive_expires_at,
                    classroom_id, campus_name_snapshot, classroom_name_snapshot
                ) VALUES
                    (1, '乾淨相本', 'infant', NULL, NULL, 10, '舊總校', '舊太陽班'),
                    (2, '空連結相本', 'infant', NULL, NULL, 10, '舊總校', '舊太陽班'),
                    (3, '壞連結相本', 'infant', NULL, NULL, 10, '舊總校', '舊太陽班'),
                    (4, '重複連結相本', 'infant', NULL, NULL, 10, '舊總校', '舊太陽班'),
                    (5, '封存異常相本', 'infant', '2026-01-02 03:04:05',
                     '2026-02-01 03:04:05', 10, '舊總校', '舊太陽班')
            """))
            connection.execute(text("""
                INSERT INTO students (id, project_id, name, roster_child_id)
                VALUES
                    (1, 1, '甲生', 1),
                    (2, 1, '乙生', 2),
                    (3, 2, '甲生', NULL),
                    (4, 2, '丙生', 3),
                    (5, 3, '未知生', 999),
                    (6, 4, '丁生甲', 4),
                    (7, 4, '丁生乙', 4),
                    (8, 5, '封存生', NULL)
            """))
            connection.commit()

            # 已存在 freeze/transition trigger 的中間版本也必須能安全 class→NULL。
            migrations._add_legacy_project_identity_migration_schema(connection)
            migrations._quarantine_class_backed_identity_anomalies(connection)
            migrations._quarantine_class_backed_identity_anomalies(connection)

            assert list(connection.execute(text("""
                SELECT id, classroom_id, deleted_at, archive_expires_at,
                       campus_name_snapshot, classroom_name_snapshot
                FROM projects
                ORDER BY id
            """))) == [
                (1, 10, None, None, "舊總校", "舊太陽班"),
                (2, None, None, None, "舊總校", "舊太陽班"),
                (3, None, None, None, "舊總校", "舊太陽班"),
                (4, None, None, None, "舊總校", "舊太陽班"),
                (
                    5,
                    None,
                    "2026-01-02 03:04:05",
                    "2026-02-01 03:04:05",
                    "舊總校",
                    "舊太陽班",
                ),
            ]
            assert list(connection.execute(text("""
                SELECT id, roster_child_id FROM students ORDER BY id
            """))) == [
                (1, 1),
                (2, 2),
                (3, None),
                (4, 3),
                (5, 999),
                (6, 4),
                (7, 4),
                (8, None),
            ]
            assert list(connection.execute(text("""
                SELECT project_id_snapshot, original_classroom_id_snapshot,
                       original_campus_id_snapshot,
                       original_campus_name_snapshot,
                       original_classroom_name_snapshot,
                       project_campus_name_snapshot,
                       project_classroom_name_snapshot,
                       student_count, anomalous_student_count,
                       null_roster_child_count, invalid_roster_child_count,
                       duplicate_roster_child_student_count,
                       project_deleted_at_snapshot
                FROM legacy_project_identity_quarantines
                ORDER BY project_id_snapshot
            """))) == [
                (2, 10, 1, "總校", "太陽班", "舊總校", "舊太陽班", 2, 1, 1, 0, 0, None),
                (3, 10, 1, "總校", "太陽班", "舊總校", "舊太陽班", 1, 1, 0, 1, 0, None),
                (4, 10, 1, "總校", "太陽班", "舊總校", "舊太陽班", 2, 2, 0, 0, 2, None),
                (
                    5,
                    10,
                    1,
                    "總校",
                    "太陽班",
                    "舊總校",
                    "舊太陽班",
                    1,
                    1,
                    1,
                    0,
                    0,
                    "2026-01-02 03:04:05",
                ),
            ]

            assert list(connection.execute(text(
                "PRAGMA foreign_key_list(legacy_project_identity_quarantines)"
            ))) == []
            trigger_names = {
                row[0] for row in connection.execute(text("""
                    SELECT name FROM sqlite_master WHERE type = 'trigger'
                """))
            }
            assert {
                "trg_legacy_identity_quarantines_no_update",
                "trg_legacy_identity_quarantines_no_delete",
            } <= trigger_names

        _execute_integrity_error(
            migration_engine,
            "UPDATE legacy_project_identity_quarantines "
            "SET project_name_snapshot = '竄改' WHERE project_id_snapshot = 2",
        )
        _execute_integrity_error(
            migration_engine,
            "DELETE FROM legacy_project_identity_quarantines "
            "WHERE project_id_snapshot = 2",
        )
    finally:
        migration_engine.dispose()


def test_legacy_teacher_supervisor_links_are_archived_before_schema_drop(
    tmp_path,
    monkeypatch,
):
    import migrations
    from database import Base

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'legacy_teacher_supervisors.db').as_posix()}"
    )
    Base.metadata.create_all(migration_engine)
    with migration_engine.begin() as connection:
        user_columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(users)"))
        }
        if "supervisor_id" not in user_columns:
            connection.execute(text(
                "ALTER TABLE users ADD COLUMN supervisor_id INTEGER REFERENCES users(id)"
            ))
        connection.execute(text("""
            CREATE TABLE IF NOT EXISTS teacher_supervisors (
                teacher_id INTEGER NOT NULL REFERENCES users(id),
                supervisor_id INTEGER NOT NULL REFERENCES users(id),
                PRIMARY KEY (teacher_id, supervisor_id)
            )
        """))
        connection.execute(text("""
            INSERT INTO users (
                id, username, display_name, hashed_password, role, supervisor_id
            ) VALUES
                (10, 'legacy_supervisor_a', '舊主管甲', 'hashed', 'supervisor', NULL),
                (11, 'legacy_supervisor_b', '舊主管乙', 'hashed', 'supervisor', NULL),
                (20, 'legacy_teacher_a', '舊老師甲', 'hashed', 'teacher', 10),
                (21, 'legacy_teacher_b', '舊老師乙', 'hashed', 'teacher', 11)
        """))
        connection.execute(text("""
            INSERT INTO teacher_supervisors (teacher_id, supervisor_id)
            VALUES (20, 11), (21, 10)
        """))

    monkeypatch.setattr(migrations, "engine", migration_engine)
    try:
        migrations.run_migrations()
        migrations.run_migrations()

        with migration_engine.connect() as connection:
            tables = {
                row[0]
                for row in connection.execute(text(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ))
            }
            assert "legacy_teacher_supervisor_links" in tables
            assert "teacher_supervisors" not in tables

            user_columns = {
                row[1]
                for row in connection.execute(text("PRAGMA table_info(users)"))
            }
            assert "supervisor_id" not in user_columns
            assert list(connection.execute(text(
                "PRAGMA foreign_key_list(legacy_teacher_supervisor_links)"
            ))) == []

            archived_links = list(connection.execute(text("""
                SELECT teacher_id, supervisor_id,
                       teacher_name_snapshot, supervisor_name_snapshot,
                       archived_at
                FROM legacy_teacher_supervisor_links
                ORDER BY teacher_id, supervisor_id
            """)))
            assert [row[:4] for row in archived_links] == [
                (20, 10, "舊老師甲", "舊主管甲"),
                (20, 11, "舊老師甲", "舊主管乙"),
                (21, 10, "舊老師乙", "舊主管甲"),
                (21, 11, "舊老師乙", "舊主管乙"),
            ]
            assert all(row[4] is not None for row in archived_links)
            assert list(connection.execute(text("""
                SELECT id, display_name FROM users
                WHERE id IN (10, 11, 20, 21)
                ORDER BY id
            """))) == [
                (10, "舊主管甲"),
                (11, "舊主管乙"),
                (20, "舊老師甲"),
                (21, "舊老師乙"),
            ]
            assert list(connection.execute(text("PRAGMA foreign_key_check"))) == []
    finally:
        migration_engine.dispose()


def test_organization_migration_backfills_project_name_snapshots_once(tmp_path):
    import migrations

    migration_engine = _create_legacy_organization_schema(
        tmp_path / "organization_snapshot_backfill.db"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text(
                "ALTER TABLE projects ADD COLUMN classroom_id INTEGER "
                "REFERENCES classrooms(id)"
            ))
            connection.execute(text(
                "UPDATE projects SET classroom_id = 1 WHERE id = 1"
            ))
            connection.commit()

            migrations._add_organization_access_and_reclassification_schema(connection)
            assert connection.execute(text(
                "SELECT campus_name_snapshot, classroom_name_snapshot "
                "FROM projects WHERE id = 1"
            )).one() == ("總校", "太陽班")

            connection.execute(text("UPDATE campuses SET name = '新總校' WHERE id = 1"))
            connection.execute(text("UPDATE classrooms SET name = '星星班' WHERE id = 1"))
            connection.commit()
            migrations._add_organization_access_and_reclassification_schema(connection)
            assert connection.execute(text(
                "SELECT campus_name_snapshot, classroom_name_snapshot "
                "FROM projects WHERE id = 1"
            )).one() == ("總校", "太陽班")
    finally:
        migration_engine.dispose()


def test_organization_access_and_reclassification_migration_is_idempotent(tmp_path):
    import migrations

    migration_engine = _create_legacy_organization_schema(
        tmp_path / "organization_access.db"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            migrations._add_organization_access_and_reclassification_schema(connection)
            migrations._add_organization_access_and_reclassification_schema(connection)
            migrations._allow_multiple_term_target_leads(connection)
            migrations._allow_multiple_term_target_leads(connection)
            migrations._add_organization_supervisor_assignments(connection)
            migrations._add_organization_supervisor_assignments(connection)

            project_columns = {
                row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))
            }
            assert {
                "campus_name_snapshot",
                "classroom_name_snapshot",
            } <= project_columns
            assert connection.execute(text(
                "SELECT campus_name_snapshot, classroom_name_snapshot "
                "FROM projects WHERE id = 1"
            )).one() == (None, None)

            expected_tables = {
                "classroom_teachers",
                "project_editor_assignments",
                "term_reclassification_plans",
                "term_student_placements",
                "term_classroom_plans",
                "term_classroom_teacher_targets",
                "organization_supervisor_assignments",
            }
            actual_tables = {
                row[0]
                for row in connection.execute(text(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ))
            }
            assert expected_tables <= actual_tables

            expected_indexes = {
                "ux_classroom_teacher_active",
                "ux_classroom_teacher_active_lead",
                "ux_project_editor_active",
                "ux_term_reclassification_draft_scope",
                "ux_organization_supervisor_active_campus",
                "ux_organization_supervisor_active_department",
            }
            actual_indexes = {
                row[0]
                for row in connection.execute(text(
                    "SELECT name FROM sqlite_master WHERE type = 'index'"
                ))
            }
            assert expected_indexes <= actual_indexes
            assert "ux_term_classroom_teacher_target_lead" not in actual_indexes
            assert connection.execute(text(
                "SELECT COUNT(*) FROM organization_supervisor_assignments"
            )).scalar_one() == 0

        with migration_engine.begin() as connection:
            connection.execute(text("""
                INSERT INTO classroom_teachers (
                    id, classroom_id, teacher_id, teacher_name_snapshot, duty,
                    started_by_id, started_by_name_snapshot
                ) VALUES (1, 1, 1, '主教', 'lead', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO classroom_teachers (
                    id, classroom_id, teacher_id, teacher_name_snapshot, duty,
                    started_by_id, started_by_name_snapshot
                ) VALUES (2, 1, 2, '協同', 'co_teacher', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO classroom_teachers (
                    id, classroom_id, teacher_id, teacher_name_snapshot, duty,
                    started_at, ended_at, started_by_id, started_by_name_snapshot
                ) VALUES (
                    3, 1, 2, '協同', 'co_teacher',
                    '2026-01-01', '2026-06-30', 3, '管理員'
                )
            """))
            connection.execute(text("""
                INSERT INTO project_editor_assignments (
                    id, project_id, user_id, user_name_snapshot,
                    started_by_id, started_by_name_snapshot
                ) VALUES (1, 1, 2, '協同', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO project_editor_assignments (
                    id, project_id, user_id, user_name_snapshot, started_at, ended_at,
                    started_by_id, started_by_name_snapshot
                ) VALUES (
                    2, 1, 2, '協同', '2026-01-01', '2026-06-30', 3, '管理員'
                )
            """))
            connection.execute(text("""
                INSERT INTO term_reclassification_plans (
                    id, label, source_fingerprint, created_by_id,
                    created_by_name_snapshot
                ) VALUES (1, '115 上學期', 'fingerprint-1', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO organization_supervisor_assignments (
                    id, campus_id, department, supervisor_id,
                    supervisor_name_snapshot, started_by_id,
                    started_by_name_snapshot
                ) VALUES (1, 1, NULL, 1, '主教', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO organization_supervisor_assignments (
                    id, campus_id, department, supervisor_id,
                    supervisor_name_snapshot, started_by_id,
                    started_by_name_snapshot
                ) VALUES (2, 1, 'infant', 1, '主教', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO organization_supervisor_assignments (
                    id, campus_id, department, supervisor_id,
                    supervisor_name_snapshot, started_by_id,
                    started_by_name_snapshot
                ) VALUES (3, 1, 'academy', 1, '主教', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO organization_supervisor_assignments (
                    id, campus_id, department, supervisor_id,
                    supervisor_name_snapshot, started_at, ended_at,
                    started_by_id, started_by_name_snapshot
                ) VALUES (
                    4, 1, 'infant', 1, '主教',
                    '2025-01-01', '2025-06-30', 3, '管理員'
                )
            """))

        _execute_integrity_error(migration_engine, """
            INSERT INTO classroom_teachers (
                classroom_id, teacher_id, teacher_name_snapshot, duty,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, 3, '管理員', 'lead', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO classroom_teachers (
                classroom_id, teacher_id, teacher_name_snapshot, duty,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, 2, '協同', 'co_teacher', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO classroom_teachers (
                classroom_id, teacher_id, teacher_name_snapshot, duty,
                started_by_id, started_by_name_snapshot
            ) VALUES (2, 1, '主教', 'invalid', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO project_editor_assignments (
                project_id, user_id, user_name_snapshot,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, 2, '協同', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO term_reclassification_plans (
                label, source_fingerprint, created_by_id, created_by_name_snapshot
            ) VALUES ('另一份草稿', 'fingerprint-2', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO organization_supervisor_assignments (
                campus_id, department, supervisor_id, supervisor_name_snapshot,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, NULL, 1, '主教', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO organization_supervisor_assignments (
                campus_id, department, supervisor_id, supervisor_name_snapshot,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, 'infant', 1, '主教', 3, '管理員')
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO organization_supervisor_assignments (
                campus_id, department, supervisor_id, supervisor_name_snapshot,
                started_by_id, started_by_name_snapshot
            ) VALUES (1, 'invalid', 2, '協同', 3, '管理員')
        """)

        with migration_engine.begin() as connection:
            connection.execute(text(
                "UPDATE term_reclassification_plans SET status = 'applied' WHERE id = 1"
            ))
            connection.execute(text("""
                INSERT INTO term_reclassification_plans (
                    id, label, source_fingerprint, created_by_id,
                    created_by_name_snapshot
                ) VALUES (2, '115 下學期', 'fingerprint-2', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO term_student_placements (
                    id, plan_id, source_membership_id, roster_child_id_snapshot,
                    student_name_snapshot, source_campus_id_snapshot,
                    source_campus_name_snapshot, source_classroom_id_snapshot,
                    source_classroom_name_snapshot, outcome, target_classroom_id
                ) VALUES (
                    1, 2, 1, 1, '甲生', 1, '總校', 1, '太陽班', 'classroom', 1
                )
            """))
            connection.execute(text("""
                INSERT INTO term_student_placements (
                    id, plan_id, source_membership_id, roster_child_id_snapshot,
                    student_name_snapshot, source_campus_id_snapshot,
                    source_campus_name_snapshot, source_classroom_id_snapshot,
                    source_classroom_name_snapshot, outcome, target_classroom_id
                ) VALUES (
                    2, 2, 2, 2, '乙生', 1, '總校', 1, '太陽班', 'departed', NULL
                )
            """))
            connection.execute(text(
                "INSERT INTO term_classroom_plans (id, plan_id, classroom_id) "
                "VALUES (1, 2, 1)"
            ))
            connection.execute(text("""
                INSERT INTO term_classroom_teacher_targets (
                    id, classroom_plan_id, teacher_id, teacher_name_snapshot, duty
                ) VALUES (1, 1, 1, '主教', 'lead')
            """))
            connection.execute(text("""
                INSERT INTO term_classroom_teacher_targets (
                    id, classroom_plan_id, teacher_id, teacher_name_snapshot, duty
                ) VALUES (2, 1, 2, '協同', 'co_teacher')
            """))

        _execute_integrity_error(migration_engine, """
            INSERT INTO term_student_placements (
                plan_id, source_membership_id, roster_child_id_snapshot,
                student_name_snapshot, source_campus_id_snapshot,
                source_campus_name_snapshot, source_classroom_id_snapshot,
                source_classroom_name_snapshot, outcome, target_classroom_id
            ) VALUES (2, 1, 1, '甲生', 1, '總校', 1, '太陽班', 'classroom', 2)
        """)
        _execute_integrity_error(migration_engine, """
            INSERT INTO term_student_placements (
                plan_id, source_membership_id, roster_child_id_snapshot,
                student_name_snapshot, source_campus_id_snapshot,
                source_campus_name_snapshot, source_classroom_id_snapshot,
                source_classroom_name_snapshot, outcome, target_classroom_id
            ) VALUES (2, 2, 2, '乙生', 1, '總校', 1, '太陽班', 'departed', 2)
        """)
        with migration_engine.begin() as connection:
            connection.execute(text("""
            INSERT INTO term_classroom_teacher_targets (
                classroom_plan_id, teacher_id, teacher_name_snapshot, duty
            ) VALUES (1, 3, '管理員', 'lead')
            """))
        _execute_integrity_error(migration_engine, """
            INSERT INTO term_classroom_teacher_targets (
                classroom_plan_id, teacher_id, teacher_name_snapshot, duty
            ) VALUES (1, 2, '協同', 'lead')
        """)

        with migration_engine.begin() as connection:
            connection.execute(text(
                "DELETE FROM term_reclassification_plans WHERE id = 2"
            ))
            assert connection.execute(text(
                "SELECT COUNT(*) FROM term_student_placements WHERE plan_id = 2"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM term_classroom_plans WHERE plan_id = 2"
            )).scalar_one() == 0
            assert connection.execute(text(
                "SELECT COUNT(*) FROM term_classroom_teacher_targets"
            )).scalar_one() == 0
    finally:
        migration_engine.dispose()


def _seed_academic_term_student_snapshot_fixture(
    migration_engine,
    *,
    project_campus_name: str = "總校",
) -> None:
    from sqlalchemy.orm import Session

    from database import (
        Base,
        Campus,
        Classroom,
        ClassroomMember,
        Project,
        RosterChild,
        Student,
        Template,
        TemplatePeriod,
    )

    Base.metadata.create_all(migration_engine)
    with Session(migration_engine) as db:
        campus = Campus(name="總校")
        project_classroom = Classroom(
            academic_term_id=current_academic_term_id(db),
            campus=campus,
            department="infant",
            name="太陽班",
        )
        current_classroom = Classroom(
            academic_term_id=current_academic_term_id(db),
            campus=campus,
            department="infant",
            name="月亮班",
        )
        current_child = RosterChild(name="目前姓名")
        project_only_child = RosterChild(name="已離班名冊姓名")
        period = TemplatePeriod(
            department="infant",
            name="第一期",
            status="active",
        )
        template = Template(name="範本", period=period)
        db.add_all([
            project_classroom,
            current_classroom,
            current_child,
            project_only_child,
            template,
        ])
        db.flush()
        membership = ClassroomMember(
            classroom_id=current_classroom.id,
            roster_child_id=current_child.id,
        )
        project = Project(
            name="有效舊相本",
            template_id=template.id,
            department="infant",
            template_period_id=period.id,
            classroom_id=project_classroom.id,
            campus_id_snapshot=campus.id,
            campus_name_snapshot=project_campus_name,
            classroom_name_snapshot=project_classroom.name,
        )
        db.add_all([membership, project])
        db.flush()
        db.add_all([
            Student(
                project_id=project.id,
                name="舊班姓名",
                roster_child_id=current_child.id,
            ),
            Student(
                project_id=project.id,
                name="已離班相本姓名",
                roster_child_id=project_only_child.id,
            ),
        ])
        db.commit()


def test_academic_term_current_index_is_cross_status_and_migration_safe(tmp_path):
    import migrations
    from database import Base

    migration_engine = create_engine(
        f"sqlite:///{(tmp_path / 'academic_term_current_index.db').as_posix()}"
    )
    try:
        Base.metadata.create_all(migration_engine)
        with migration_engine.begin() as connection:
            # 模擬曾上線的錯誤 index：只能防同 status 重複，無法防 imported + active。
            connection.execute(text(
                "DROP INDEX IF EXISTS ux_academic_terms_current"
            ))
            connection.execute(text(
                "CREATE UNIQUE INDEX ux_academic_terms_current "
                "ON academic_terms(status) "
                "WHERE status IN ('imported', 'active')"
            ))
            connection.execute(
                text("""
                    INSERT INTO academic_terms (
                        label, status, migration_key, created_at,
                        created_by_name_snapshot
                    ) VALUES (
                        '既有資料（遷移）', 'imported', :migration_key,
                        CURRENT_TIMESTAMP, '系統遷移'
                    )
                """),
                {
                    "migration_key": (
                        migrations.ACADEMIC_TERM_REPORTING_MIGRATION_KEY
                    ),
                },
            )

        with migration_engine.connect() as connection:
            migrations._add_legacy_project_identity_migration_schema(connection)
            migrations._add_academic_term_reporting_schema(connection)
            migrations._add_academic_term_reporting_schema(connection)
            index_sql = connection.execute(text("""
                SELECT sql
                FROM sqlite_master
                WHERE type = 'index' AND name = 'ux_academic_terms_current'
            """)).scalar_one()
            assert "ON academic_terms((1))" in index_sql

        _execute_integrity_error(migration_engine, """
            INSERT INTO academic_terms (
                label, status, created_at, created_by_name_snapshot
            ) VALUES (
                '不應並存的正式學期', 'active', CURRENT_TIMESTAMP, '管理員'
            )
        """)

        with migration_engine.begin() as connection:
            connection.execute(text("""
                INSERT INTO academic_terms (
                    label, status, created_at, created_by_name_snapshot
                ) VALUES
                    ('下一學期草稿甲', 'draft', CURRENT_TIMESTAMP, '管理員'),
                    ('下一學期草稿乙', 'draft', CURRENT_TIMESTAMP, '管理員')
            """))
    finally:
        migration_engine.dispose()


def test_active_project_editors_are_retired_as_historical_rows(tmp_path):
    import migrations

    migration_engine = _create_legacy_organization_schema(
        tmp_path / "retire_project_editors.db"
    )
    try:
        with migration_engine.connect() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            migrations._add_organization_access_and_reclassification_schema(connection)
            connection.execute(text("""
                INSERT INTO project_editor_assignments (
                    id, project_id, user_id, user_name_snapshot,
                    started_by_id, started_by_name_snapshot
                ) VALUES (1, 1, 2, '協同', 3, '管理員')
            """))
            connection.execute(text("""
                INSERT INTO project_editor_assignments (
                    id, project_id, user_id, user_name_snapshot,
                    started_at, ended_at, end_reason,
                    started_by_id, started_by_name_snapshot,
                    ended_by_name_snapshot
                ) VALUES (
                    2, 1, 1, '主教', '2025-01-01', '2025-06-30',
                    'manual', 3, '管理員', '舊管理員'
                )
            """))
            connection.commit()

            migrations._retire_active_project_editor_assignments(connection)
            migrations._retire_active_project_editor_assignments(connection)

            retired = connection.execute(text("""
                SELECT ended_at, end_reason, ended_by_id, ended_by_name_snapshot
                FROM project_editor_assignments WHERE id = 1
            """)).one()
            assert retired[0] is not None
            assert retired[1:] == (
                "classroom_scope_migration",
                None,
                "系統遷移",
            )
            historical = connection.execute(text("""
                SELECT ended_at, end_reason, ended_by_name_snapshot
                FROM project_editor_assignments WHERE id = 2
            """)).one()
            assert historical == ("2025-06-30", "manual", "舊管理員")
    finally:
        migration_engine.dispose()
