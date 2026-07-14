# 資料庫遷移冪等性驗證
# init_db + run_migrations 必須可重複執行不報錯，且預設 admin 帳號只建立一次
#
# DB 路徑來自 conftest 設定的 tmp 檔案，不會碰到 backend/album_maker.db

import json
import sqlite3

from sqlalchemy import create_engine, text


def test_migrations_idempotent():
    """init_db + run_migrations 連續執行兩次必須成功，且 admin user 不重複。"""
    from database import SessionLocal, User, engine, init_db
    from migrations import run_migrations

    init_db()
    run_migrations()

    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO users (username, display_name, hashed_password, role)
            VALUES ('migration_supervisor', 'Migration Supervisor', 'hashed', 'supervisor')
        """))
        supervisor_id = conn.execute(
            text("SELECT id FROM users WHERE username = 'migration_supervisor'")
        ).scalar_one()
        conn.execute(
            text("""
                INSERT INTO users (username, display_name, hashed_password, role, supervisor_id)
                VALUES ('migration_teacher', 'Migration Teacher', 'hashed', 'teacher', :supervisor_id)
            """),
            {"supervisor_id": supervisor_id},
        )
        template_id = conn.execute(
            text("INSERT INTO templates (name) VALUES ('Migration layout') RETURNING id")
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
        assert "teacher_supervisors" in tables
        assert "template_project_sync_backups" in tables
        user_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        assert "ui_font_scale" in user_columns
        assert "auth_version" in user_columns
        template_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(templates)"))}
        assert "revision" in template_columns
        project_columns = {row[1] for row in conn.execute(text("PRAGMA table_info(projects)"))}
        assert "deleted_at" in project_columns
        assert "archive_expires_at" in project_columns
        assert "template_revision" in project_columns
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

        migrated_assignment = conn.execute(text("""
            SELECT ts.supervisor_id
            FROM teacher_supervisors ts
            JOIN users teacher ON teacher.id = ts.teacher_id
            WHERE teacher.username = 'migration_teacher'
        """)).fetchone()
        assert migrated_assignment is not None
        assert migrated_assignment[0] == supervisor_id


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
