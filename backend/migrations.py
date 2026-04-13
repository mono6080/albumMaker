# 資料庫遷移模組
# 負責在不刪除現有資料的前提下，對資料庫 schema 進行漸進式升級
# 每次新增欄位或資料表時，在此模組追加對應的遷移函式（冪等設計）

from sqlalchemy import text
from database import engine


def run_migrations():
    """執行所有待遷移的 schema 變更，已存在的欄位或資料表會自動跳過。"""
    with engine.connect() as connection:
        _add_bubble_texts_json_column(connection)
        _add_users_table(connection)
        _add_owner_id_to_projects(connection)
        _add_project_comments_table(connection)
        _assign_historical_projects_to_admin(connection)
        _rename_bubble_texts_to_label_texts(connection)


def _add_bubble_texts_json_column(connection):
    """新增專案層級的氣泡文字欄位（初始 schema 未包含此欄位）。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "bubble_texts_json" not in existing_columns:
        connection.execute(
            text("ALTER TABLE projects ADD COLUMN bubble_texts_json TEXT NOT NULL DEFAULT '{}'")
        )
        connection.commit()


def _add_users_table(connection):
    """建立使用者資料表，並插入預設 admin 帳號（若尚不存在）。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "users" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                hashed_password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'none',
                supervisor_id INTEGER REFERENCES users(id),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.commit()

    # 插入預設 admin 帳號（隨機密碼），若已存在則跳過
    existing_admin = connection.execute(
        text("SELECT id FROM users WHERE username = 'admin'")
    ).fetchone()
    if not existing_admin:
        import secrets
        import bcrypt as _bcrypt
        initial_password = secrets.token_urlsafe(12)
        hashed = _bcrypt.hashpw(initial_password.encode(), _bcrypt.gensalt()).decode()
        connection.execute(
            text("INSERT INTO users (username, display_name, hashed_password, role) VALUES ('admin', '系統管理員', :hashed, 'admin')"),
            {"hashed": hashed}
        )
        connection.commit()
        print("=" * 60)
        print(f"[migrations] 初始 admin 帳號已建立")
        print(f"  帳號：admin")
        print(f"  密碼：{initial_password}")
        print(f"  請立即登入後至使用者管理修改密碼！")
        print("=" * 60)


def _add_owner_id_to_projects(connection):
    """為 projects 資料表新增 owner_id 欄位（nullable，相容歷史資料）。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "owner_id" not in existing_columns:
        connection.execute(
            text("ALTER TABLE projects ADD COLUMN owner_id INTEGER REFERENCES users(id)")
        )
        connection.commit()


def _add_project_comments_table(connection):
    """建立專案審閱意見資料表。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "project_comments" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE project_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id),
                author_id INTEGER NOT NULL REFERENCES users(id),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.commit()


def _rename_bubble_texts_to_label_texts(connection):
    """將 projects.bubble_texts_json 欄位資料複製至 label_texts_json（欄位重命名）。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "label_texts_json" not in existing_columns:
        connection.execute(
            text("ALTER TABLE projects ADD COLUMN label_texts_json TEXT NOT NULL DEFAULT '{}'")
        )
        # 將舊欄位資料複製到新欄位
        if "bubble_texts_json" in existing_columns:
            connection.execute(
                text("UPDATE projects SET label_texts_json = bubble_texts_json WHERE bubble_texts_json != '{}'")
            )
        connection.commit()


def _assign_historical_projects_to_admin(connection):
    """將所有 owner_id 為 NULL 的歷史專案歸屬給 admin。"""
    admin_user = connection.execute(
        text("SELECT id FROM users WHERE username = 'admin'")
    ).fetchone()
    if not admin_user:
        return
    admin_id = admin_user[0]
    connection.execute(
        text("UPDATE projects SET owner_id = :admin_id WHERE owner_id IS NULL"),
        {"admin_id": admin_id}
    )
    connection.commit()
