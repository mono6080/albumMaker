# 資料庫遷移冪等性驗證
# init_db + run_migrations 必須可重複執行不報錯，且預設 admin 帳號只建立一次
#
# DB 路徑來自 conftest 設定的 tmp 檔案，不會碰到 backend/album_maker.db

import json
import sqlite3
import sys
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError


def test_migrations_idempotent():
    """init_db + run_migrations 連續執行兩次必須成功，且 admin user 不重複。"""
    from database import SessionLocal, User, engine, init_db
    from migrations import run_migrations

    init_db()
    run_migrations()

    with engine.begin() as conn:
        template_id = conn.execute(
            text("INSERT INTO templates (name) VALUES ('Migration layout') RETURNING id")
        ).scalar_one()
        template_period_id = conn.execute(
            text("SELECT id FROM template_periods ORDER BY id LIMIT 1")
        ).scalar_one()
        conn.execute(
            text("""
                UPDATE templates
                SET revision = 7, period_id = :template_period_id
                WHERE id = :template_id
            """),
            {
                "template_id": template_id,
                "template_period_id": template_period_id,
            },
        )
        project_id = conn.execute(
            text("""
                INSERT INTO projects (
                    name, template_id, template_revision, department,
                    template_period_id, completed_at, label_texts_json
                )
                VALUES (
                    'Migration project', :template_id, 7, 'sensory',
                    :template_period_id, '2026-07-16 10:00:00',
                    '{"0":{"1":"保留文字"}}'
                )
                RETURNING id
            """),
            {
                "template_id": template_id,
                "template_period_id": template_period_id,
            },
        ).scalar_one()
        conn.execute(
            text("""
                INSERT INTO template_pages (template_id, page_number, layout_json)
                VALUES (:template_id, 0, :empty_layout), (:template_id, 1, :nonempty_layout)
            """),
            {
                "template_id": template_id,
                "empty_layout": json.dumps({"photo_slots": [], "text_bubbles": []}),
                "nonempty_layout": json.dumps({"text_bubbles": [{"id": "keep-for-review"}]}),
            },
        )

    # 第二次執行：所有 migration 都應冪等
    init_db()
    run_migrations()

    # 驗證預設 admin user 存在且僅有一筆
    db = SessionLocal()
    try:
        admin_users = db.query(User).filter(User.username == "admin").all()
        assert len(admin_users) == 1
        assert admin_users[0].role == "admin"
    finally:
        db.close()

    # 驗證 users 表確實在我們指定的 tmp DB 裡，而非 backend/album_maker.db
    assert "test.db" in str(engine.url) or ":memory:" in str(engine.url)
    with engine.connect() as conn:
        tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        assert "users" in tables
        assert "projects" in tables
        assert "legacy_teacher_supervisor_links" in tables
        assert "teacher_supervisors" not in tables
        assert "template_project_sync_backups" in tables
        user_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        assert "ui_font_scale" in user_columns
        assert "auth_version" in user_columns
        assert "supervisor_id" not in user_columns
        assert list(conn.execute(text(
            "PRAGMA foreign_key_list(legacy_teacher_supervisor_links)"
        ))) == []
        assert conn.execute(text(
            "SELECT COUNT(*) FROM legacy_teacher_supervisor_links"
        )).scalar_one() == 0
        template_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(templates)"))}
        assert "revision" in template_columns
        project_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(projects)"))}
        assert "deleted_at" in project_columns
        assert "archive_expires_at" in project_columns
        assert "template_revision" in project_columns
        assert "bubble_texts_json" not in project_columns
        preserved_project = conn.execute(text("""
            SELECT template_revision, department, template_period_id,
                   completed_at, label_texts_json
            FROM projects
            WHERE id = :project_id
        """), {"project_id": project_id}).one()
        assert preserved_project == (
            7,
            "sensory",
            template_period_id,
            "2026-07-16 10:00:00",
            '{"0":{"1":"保留文字"}}',
        )
        backup_columns = {
            row[1]
            for row in conn.execute(text(
                "PRAGMA table_info(template_project_sync_backups)"
            ))
        }
        assert "project_completed_at" in backup_columns
        backup_indexes = {
            row[1]
            for row in conn.execute(text("PRAGMA index_list(template_project_sync_backups)"))
        }
        assert {
            "idx_template_sync_backups_sync_id",
            "idx_template_sync_backups_template_id",
            "idx_template_sync_backups_project_id",
        } <= backup_indexes

        migrated_layouts = [
            json.loads(row[0])
            for row in conn.execute(text(
                "SELECT layout_json FROM template_pages WHERE template_id = :template_id ORDER BY page_number"
            ), {"template_id": template_id})
        ]
        assert "text_bubbles" not in migrated_layouts[0]
        assert migrated_layouts[1]["text_bubbles"] == [{"id": "keep-for-review"}]
        backup_count = conn.execute(text("""
            SELECT COUNT(*) FROM template_page_layout_migration_backups
            WHERE migration_name = 'remove_empty_text_bubbles_v1'
        """)).scalar_one()
        assert backup_count == 1

def test_template_revision_migration_upgrades_nonempty_legacy_database(tmp_path, monkeypatch):
    """舊資料與遷移後新資料都必須取得整數型別的 revision 預設值。"""
    import migrations

    legacy_database_path = tmp_path / "legacy-template-revision.db"
    with sqlite3.connect(legacy_database_path) as connection:
        connection.executescript("""
            CREATE TABLE templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR NOT NULL,
                created_at DATETIME
            );
            CREATE TABLE template_pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL REFERENCES templates(id),
                page_number INTEGER NOT NULL,
                background_filename VARCHAR,
                layout_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR NOT NULL,
                template_id INTEGER NOT NULL REFERENCES templates(id),
                created_at DATETIME
            );
            CREATE TABLE students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id),
                name VARCHAR NOT NULL,
                order_index INTEGER DEFAULT 0,
                pages_data_json TEXT NOT NULL DEFAULT '[]',
                output_filename VARCHAR
            );
            INSERT INTO templates (name) VALUES ('Legacy template');
            INSERT INTO template_pages (template_id, page_number) VALUES (1, 0);
            INSERT INTO projects (name, template_id) VALUES ('Legacy project', 1);
            INSERT INTO students (project_id, name) VALUES (1, 'Legacy student');
        """)
        template_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(templates)")
        }
        project_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(projects)")
        }
        assert "revision" not in template_columns
        assert "template_revision" not in project_columns

    legacy_engine = create_engine(f"sqlite:///{legacy_database_path.as_posix()}")
    monkeypatch.setattr(migrations, "engine", legacy_engine)
    try:
        migrations.run_migrations()
        migrations.run_migrations()
    finally:
        legacy_engine.dispose()

    with sqlite3.connect(legacy_database_path) as connection:
        existing_template_revision = connection.execute(
            "SELECT revision, typeof(revision) FROM templates WHERE name = 'Legacy template'"
        ).fetchone()
        existing_project_revision = connection.execute(
            "SELECT template_revision, typeof(template_revision) "
            "FROM projects WHERE name = 'Legacy project'"
        ).fetchone()
        assert existing_template_revision == (1, "integer")
        assert existing_project_revision == (1, "integer")

        new_template_id = connection.execute(
            "INSERT INTO templates (name) VALUES ('Post-migration template')"
        ).lastrowid
        connection.execute(
            "INSERT INTO projects (name, template_id) VALUES ('Post-migration project', ?)",
            (new_template_id,),
        )
        new_template_revision = connection.execute(
            "SELECT revision, typeof(revision) FROM templates WHERE id = ?",
            (new_template_id,),
        ).fetchone()
        new_project_revision = connection.execute(
            "SELECT template_revision, typeof(template_revision) "
            "FROM projects WHERE name = 'Post-migration project'"
        ).fetchone()
        assert new_template_revision == (1, "integer")
        assert new_project_revision == (1, "integer")

        backup_table = connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name = 'template_project_sync_backups'"
        ).fetchone()
        assert backup_table == ("template_project_sync_backups",)
        backup_columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(template_project_sync_backups)"
            )
        }
        assert "project_completed_at" in backup_columns
        backup_indexes = {
            row[1]
            for row in connection.execute(
                "PRAGMA index_list(template_project_sync_backups)"
            )
        }
        assert {
            "idx_template_sync_backups_sync_id",
            "idx_template_sync_backups_template_id",
            "idx_template_sync_backups_project_id",
        } <= backup_indexes


def test_interrupted_bubble_drop_preserves_modern_project_schema_and_relations():
    """舊欄位殘留時，重跑 migration 不得把後來新增的 project 欄位／索引／FK 丟掉。"""
    from database import engine, init_db
    import migrations

    init_db()
    migrations.run_migrations()
    with engine.begin() as connection:
        connection.execute(text(
            "ALTER TABLE projects "
            "ADD COLUMN bubble_texts_json TEXT NOT NULL DEFAULT '{}'"
        ))
        template_id = connection.execute(text(
            "INSERT INTO templates (name, revision) "
            "VALUES ('Interrupted template', 8) RETURNING id"
        )).scalar_one()
        period_id = connection.execute(text(
            "SELECT id FROM template_periods ORDER BY id LIMIT 1"
        )).scalar_one()
        owner_id = connection.execute(text(
            "SELECT id FROM users WHERE username = 'admin'"
        )).scalar_one()
        project_id = connection.execute(
            text("""
                INSERT INTO projects (
                    name, template_id, department, template_period_id,
                    template_revision, owner_id, deleted_at, archive_expires_at,
                    completed_at, label_texts_json, bubble_texts_json
                )
                VALUES (
                    'Interrupted project', :template_id, 'academy', :period_id,
                    8, :owner_id, '2026-07-01 00:00:00', '2026-07-31 00:00:00',
                    '2026-07-02 00:00:00', '{"0":{"1":"modern"}}',
                    '{"0":{"1":"legacy"}}'
                )
                RETURNING id
            """),
            {
                "template_id": template_id,
                "period_id": period_id,
                "owner_id": owner_id,
            },
        ).scalar_one()
        connection.execute(
            text("""
                INSERT INTO project_students (project_id, name, pages_data_json)
                VALUES (:project_id, 'Interrupted student', '[]')
            """),
            {"project_id": project_id},
        )
        connection.execute(text(
            "CREATE INDEX idx_projects_interrupted_name ON projects(name)"
        ))

    class _LegacyDropConnection:
        """只攔原生 DROP COLUMN，強制走舊 SQLite 動態重建 fallback。"""

        def __init__(self, connection):
            self.connection = connection
            self.intercepted = False

        def execute(self, statement, *args, **kwargs):
            if (
                not self.intercepted
                and str(statement).strip().upper()
                == "ALTER TABLE PROJECTS DROP COLUMN BUBBLE_TEXTS_JSON"
            ):
                self.intercepted = True
                raise OperationalError(
                    str(statement),
                    {},
                    RuntimeError("simulated legacy SQLite"),
                )
            return self.connection.execute(statement, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    with engine.connect() as connection:
        legacy_connection = _LegacyDropConnection(connection)
        migrations._drop_bubble_texts_json_column(legacy_connection)
        assert legacy_connection.intercepted
        # 掛在 projects 的凍結 trigger 與那個查 projects 的 students trigger，
        # 都必須撐過重建空窗；舊歸班流程的三個 trigger 已隨學期範圍班級退場。
        rebuilt_triggers = {
            row[0]
            for row in connection.execute(text("""
                SELECT name
                FROM sqlite_master
                WHERE type = 'trigger'
                  AND name IN (
                      'trg_project_students_freeze_class_backed_identity',
                      'trg_projects_freeze_classroom_snapshots',
                      'trg_projects_freeze_work_slot'
                  )
            """))
        }
        assert rebuilt_triggers == {
            "trg_project_students_freeze_class_backed_identity",
            "trg_projects_freeze_classroom_snapshots",
            "trg_projects_freeze_work_slot",
        }

    # fallback 完成後再跑完整序列，確認 interrupted state 已收斂且可冪等。
    migrations.run_migrations()

    with engine.connect() as connection:
        columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))
        }
        assert "bubble_texts_json" not in columns
        assert {
            "department",
            "template_period_id",
            "template_revision",
            "owner_id",
            "created_at",
            "updated_at",
            "deleted_at",
            "archive_expires_at",
            "completed_at",
            "label_texts_json",
        } <= columns
        preserved = connection.execute(
            text("""
                SELECT department, template_period_id, template_revision, owner_id,
                       deleted_at, archive_expires_at, completed_at, label_texts_json
                FROM projects
                WHERE id = :project_id
            """),
            {"project_id": project_id},
        ).one()
        assert preserved == (
            "academy",
            period_id,
            8,
            owner_id,
            "2026-07-01 00:00:00",
            "2026-07-31 00:00:00",
            "2026-07-02 00:00:00",
            '{"0":{"1":"modern"}}',
        )
        indexes = {
            row[1] for row in connection.execute(text("PRAGMA index_list(projects)"))
        }
        assert {
            "idx_projects_interrupted_name",
            "idx_projects_owner_id",
            "idx_projects_department",
            "idx_projects_template_period_id",
        } <= indexes
        foreign_key_targets = {
            row[2] for row in connection.execute(text("PRAGMA foreign_key_list(projects)"))
        }
        assert {"templates", "template_periods", "users"} <= foreign_key_targets
        assert connection.execute(text(
            "SELECT COUNT(*) FROM project_students WHERE project_id = :project_id"
        ), {"project_id": project_id}).scalar_one() == 1
        assert list(connection.execute(text("PRAGMA foreign_key_check"))) == []


def _seed_legacy_rename_source(database_path):
    """建出改名前的最小 schema：students 是相本學生，roster_children 是名冊。"""
    with sqlite3.connect(database_path) as connection:
        connection.executescript("""
            CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR);
            CREATE TABLE students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id),
                name VARCHAR NOT NULL
            );
            CREATE TABLE roster_children (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR NOT NULL
            );
            INSERT INTO projects (name) VALUES ('舊相本');
            INSERT INTO students (project_id, name) VALUES (1, '相本裡的一份');
            INSERT INTO roster_children (name) VALUES ('名冊上的孩子');
        """)


def test_table_rename_uses_column_marker_not_emptiness(tmp_path):
    """`students` 這個名字在新舊結構都存在，只能用欄位分辨是哪一個。

    全新資料庫的每張表都是空的；若用「空表＝create_all 搶先建的」判斷，就會把
    名冊表當成待改名的相本學生表改名走，資料全部對不上。
    """
    import migrations
    from sqlalchemy import create_engine

    database_path = tmp_path / "rename-marker.db"
    _seed_legacy_rename_source(database_path)
    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        with engine.connect() as connection:
            migrations._rename_tables_to_model_names(connection)
            migrations._rename_tables_to_model_names(connection)
            assert connection.execute(text(
                "SELECT name FROM project_students"
            )).scalar_one() == "相本裡的一份"
            assert connection.execute(text(
                "SELECT name FROM students"
            )).scalar_one() == "名冊上的孩子"
    finally:
        engine.dispose()


def test_table_rename_reclaims_empty_table_left_by_early_create_all(tmp_path):
    """create_all 搶在改名之前跑過，會用新名字留下空表。

    留著它，改名就會判定「目標已存在」而跳過——資料留在舊表、程式讀空表，
    而且不會報錯。這是真的發生過的啟動失敗。
    """
    import migrations
    from sqlalchemy import create_engine

    database_path = tmp_path / "rename-early-create-all.db"
    _seed_legacy_rename_source(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE project_students ("
            "id INTEGER PRIMARY KEY, project_id INTEGER, name VARCHAR)"
        )
    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        with engine.connect() as connection:
            migrations._rename_tables_to_model_names(connection)
            assert connection.execute(text(
                "SELECT name FROM project_students"
            )).scalar_one() == "相本裡的一份"
            assert connection.execute(text(
                "SELECT name FROM students"
            )).scalar_one() == "名冊上的孩子"
    finally:
        engine.dispose()


def test_table_rename_refuses_when_both_tables_hold_data(tmp_path):
    """來源仍是舊表、目標卻已經有資料：不猜，直接中止。"""
    import migrations
    import pytest
    from sqlalchemy import create_engine

    database_path = tmp_path / "rename-conflict.db"
    _seed_legacy_rename_source(database_path)
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE project_students ("
            "id INTEGER PRIMARY KEY, project_id INTEGER, name VARCHAR)"
        )
        connection.execute(
            "INSERT INTO project_students (project_id, name) VALUES (1, '來路不明')"
        )
    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        with engine.connect() as connection:
            with pytest.raises(RuntimeError, match="無法判斷哪一份是真的"):
                migrations._rename_tables_to_model_names(connection)
    finally:
        engine.dispose()


# 改名前的名字**寫死在測試裡**，不從 migrations 的設定反推。用同一份設定同時
# 產生起點與驗證，漏掉一條就會對稱地漏兩次——測試照樣綠，這正是要防的事。
PRE_RENAME_COLUMNS = (
    ("classrooms", "semester_id", "academic_term_id"),
    ("semester_periods", "semester_id", "academic_term_id"),
    ("class_period_work_slots", "semester_period_id", "term_period_id"),
    ("term_reclassification_plans", "target_semester_id", "target_academic_term_id"),
)

# 反向順序：students（名冊）要先讓開，project_students 才回得去 students。
PRE_RENAME_TABLES = (
    ("students", "roster_children"),
    ("project_students", "students"),
    ("semester_periods", "academic_term_periods"),
    ("semesters", "academic_terms"),
    ("classroom_teachers", "classroom_teacher_assignments"),
    ("classroom_members", "class_roster_members"),
)


def _reverse_rename_to_pre_rename_state(database_path):
    """把 init_db() 建出的新結構倒回改名前的表名與欄位名。

    欄位定義來自現行 ORM，比手寫整份舊 DDL 可靠；但名字是測試自己寫死的，所以
    migration 少改一個欄位或少改一張表都會讓兩條路徑分歧。回傳實際倒回的表名。
    """
    reverted_tables: list[str] = []
    connection = sqlite3.connect(str(database_path))
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        for table, current_column, legacy_column in PRE_RENAME_COLUMNS:
            columns = {
                row[1] for row in connection.execute(f"PRAGMA table_info({table})")
            }
            if current_column in columns and legacy_column not in columns:
                connection.execute(
                    f"ALTER TABLE {table} "
                    f"RENAME COLUMN {current_column} TO {legacy_column}"
                )
        for current_name, legacy_name in PRE_RENAME_TABLES:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            if current_name in tables and legacy_name not in tables:
                connection.execute(
                    f"ALTER TABLE {current_name} RENAME TO {legacy_name}"
                )
                reverted_tables.append(legacy_name)
        connection.commit()
    finally:
        connection.close()
    return reverted_tables


def _run_startup_sequence(database_path, monkeypatch):
    """跑一次 main.py lifespan 的順序：改名 → init_db → migrations。

    用 monkeypatch 換掉模組層 engine，而不是 reload 模組——reload 會把其他測試
    正在用的 SessionLocal 換成另一個物件。
    """
    import database
    import migrations
    from sqlalchemy import create_engine

    engine = create_engine(f"sqlite:///{Path(database_path).as_posix()}")
    try:
        monkeypatch.setattr(database, "engine", engine)
        monkeypatch.setattr(migrations, "engine", engine)
        migrations.rename_tables_to_model_names()
        database.init_db()
        migrations.run_migrations()
    finally:
        engine.dispose()
        monkeypatch.undo()


def test_upgraded_and_fresh_databases_converge_to_the_same_schema(tmp_path, monkeypatch):
    """從改名前的結構升級上來，表與欄位必須與全新建的一模一樣。

    守的是一類不會報錯的失敗：欄位改名只改了值沒改欄位名、改名規則加了新的一條
    卻沒有人跑過升級路徑。兩條路徑都會「成功」，只是長出不同的資料庫。
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    from compare_database_schema import diff_schemas, snapshot_schema

    fresh_path = tmp_path / "fresh.db"
    _run_startup_sequence(fresh_path, monkeypatch)
    fresh = snapshot_schema(fresh_path)

    upgraded_path = tmp_path / "upgraded.db"
    _run_startup_sequence(upgraded_path, monkeypatch)
    reverted_tables = _reverse_rename_to_pre_rename_state(upgraded_path)
    # 沒有真的倒回舊結構，後面比的就是兩個相同的新資料庫——測試會空跑
    assert set(reverted_tables) == {legacy for _, legacy in PRE_RENAME_TABLES}
    _run_startup_sequence(upgraded_path, monkeypatch)
    upgraded = snapshot_schema(upgraded_path)

    differences = [
        difference
        for difference in diff_schemas(upgraded, fresh)
        if difference.startswith("tables:")
    ]
    assert differences == [], (
        "升級後與全新資料庫的表結構不一致：\n"
        + "\n".join(differences)
    )


def test_rename_recovers_from_tables_renamed_but_columns_not(tmp_path, monkeypatch):
    """「表已改名、欄位還沒」的中斷狀態必須能靠重啟收斂。

    早期版本在沒有待改名的表時就直接 return，欄位改名整段跳過——部署卡在兩階段
    之間時，semester_id 這類欄位會永久留著舊名。
    """
    import migrations

    database_path = tmp_path / "interrupted-rename.db"
    _run_startup_sequence(database_path, monkeypatch)
    _reverse_rename_to_pre_rename_state(database_path)

    # 只把表名改回新名，欄位維持舊名——正是中斷後的樣子
    connection = sqlite3.connect(str(database_path))
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        for legacy_name, current_name in (
            ("class_roster_members", "classroom_members"),
            ("classroom_teacher_assignments", "classroom_teachers"),
            ("academic_terms", "semesters"),
            ("academic_term_periods", "semester_periods"),
            ("students", "project_students"),
            ("roster_children", "students"),
        ):
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            if legacy_name in tables and current_name not in tables:
                connection.execute(
                    f"ALTER TABLE {legacy_name} RENAME TO {current_name}"
                )
        connection.commit()
        stranded = {
            row[1] for row in connection.execute("PRAGMA table_info(classrooms)")
        }
        assert "academic_term_id" in stranded, "起點必須是欄位還沒改的中斷狀態"
    finally:
        connection.close()

    with sqlite3.connect(str(database_path)) as probe:
        pass
    from sqlalchemy import create_engine

    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        monkeypatch.setattr(migrations, "engine", engine)
        migrations.rename_tables_to_model_names()
    finally:
        engine.dispose()
        monkeypatch.undo()

    connection = sqlite3.connect(str(database_path))
    try:
        recovered = {
            row[1] for row in connection.execute("PRAGMA table_info(classrooms)")
        }
        assert "semester_id" in recovered
        assert "academic_term_id" not in recovered
        work_slot_columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(class_period_work_slots)")
        }
        assert "semester_period_id" in work_slot_columns
        assert "term_period_id" not in work_slot_columns
    finally:
        connection.close()
