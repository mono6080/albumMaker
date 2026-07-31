# 資料庫遷移冪等性驗證
# init_db + run_migrations 必須可重複執行不報錯，且預設 admin 帳號只建立一次
#
# DB 路徑來自 conftest 設定的 tmp 檔案，不會碰到 backend/album_maker.db

import json
import sqlite3

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
