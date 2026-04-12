# 資料庫遷移模組
# 負責在不刪除現有資料的前提下，對資料庫 schema 進行漸進式升級
# 每次新增欄位時，在此模組追加對應的 ALTER TABLE 語句

from sqlalchemy import text
from database import engine


def run_migrations():
    """執行所有待遷移的 schema 變更，已存在的欄位會自動跳過。"""
    with engine.connect() as connection:
        _add_bubble_texts_json_column(connection)


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
