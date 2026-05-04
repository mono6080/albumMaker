# 資料庫遷移冪等性驗證
# init_db + run_migrations 必須可重複執行不報錯，且預設 admin 帳號只建立一次
#
# DB 路徑來自 conftest 設定的 tmp 檔案，不會碰到 backend/album_maker.db

from sqlalchemy import text


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

        migrated_assignment = conn.execute(text("""
            SELECT ts.supervisor_id
            FROM teacher_supervisors ts
            JOIN users teacher ON teacher.id = ts.teacher_id
            WHERE teacher.username = 'migration_teacher'
        """)).fetchone()
        assert migrated_assignment is not None
        assert migrated_assignment[0] == supervisor_id
