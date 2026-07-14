# 資料庫遷移模組
# 負責在不刪除現有資料的前提下，對資料庫 schema 進行漸進式升級
# 每次新增欄位或資料表時，在此模組追加對應的遷移函式（冪等設計）

import json

from sqlalchemy import text
from database import engine
from template_periods import (
    DEFAULT_TEMPLATE_PERIOD_DEPARTMENT,
    DEFAULT_TEMPLATE_PERIOD_NAME,
    TEMPLATE_DEPARTMENTS,
)

PHOTO_SLOT_DIMENSION_MODE_KEY = "photo_slot_dimension_mode"
PHOTO_SLOT_CONTENT_BOX_MODE = "content-box-v1"
PHOTO_SLOT_MIGRATION_NAME = "photo_slot_content_box_v1"
REMOVE_EMPTY_TEXT_BUBBLES_MIGRATION_NAME = "remove_empty_text_bubbles_v1"


def run_migrations():
    """執行所有待遷移的 schema 變更，已存在的欄位或資料表會自動跳過。"""
    with engine.connect() as connection:
        _add_bubble_texts_json_column(connection)
        _add_users_table(connection)
        _add_user_preferences_columns(connection)
        _add_user_auth_version_column(connection)
        _add_teacher_supervisors_table(connection)
        _add_owner_id_to_projects(connection)
        _add_project_comments_table(connection)
        _migrate_single_supervisors_to_many(connection)
        _assign_historical_projects_to_admin(connection)
        _rename_bubble_texts_to_label_texts(connection)
        _add_foreign_key_indexes(connection)
        _add_template_page_unique_constraint(connection)
        _add_timestamp_columns(connection)
        _add_project_archive_columns(connection)
        _drop_bubble_texts_json_column(connection)
        _add_template_periods_and_scope_columns(connection)
        _add_template_page_layout_migration_backups_table(connection)
        _migrate_photo_slots_to_content_box(connection)
        _remove_empty_text_bubbles_from_template_pages(connection)
        _add_roster_children_and_backfill(connection)
        _add_project_completed_at_column(connection)
        _add_template_revision_tracking(connection)


def _add_template_revision_tracking(connection):
    """加入模板同步版本與結構變更備份表；可安全重跑。"""
    template_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(templates)"))
    }
    if "revision" not in template_columns:
        connection.execute(text(
            "ALTER TABLE templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"
        ))

    project_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "template_revision" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN template_revision INTEGER NOT NULL DEFAULT 1"
        ))

    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "template_project_sync_backups" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE template_project_sync_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sync_id VARCHAR NOT NULL,
                template_id INTEGER NOT NULL,
                project_id INTEGER,
                old_revision INTEGER NOT NULL,
                old_pages_json TEXT NOT NULL,
                new_page_ids_json TEXT NOT NULL,
                project_completed_at DATETIME,
                project_label_texts_json TEXT,
                students_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
    backup_columns = {
        row[1]
        for row in connection.execute(text(
            "PRAGMA table_info(template_project_sync_backups)"
        ))
    }
    if "project_completed_at" not in backup_columns:
        connection.execute(text(
            "ALTER TABLE template_project_sync_backups "
            "ADD COLUMN project_completed_at DATETIME"
        ))
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_template_sync_backups_sync_id "
        "ON template_project_sync_backups(sync_id)"
    ))
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_template_sync_backups_template_id "
        "ON template_project_sync_backups(template_id)"
    ))
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_template_sync_backups_project_id "
        "ON template_project_sync_backups(project_id)"
    ))
    connection.commit()


def _add_project_completed_at_column(connection):
    """新增專案「全班完成」時間戳：非 NULL 代表內容鎖定（見 _helpers.assert_project_content_writable）。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "completed_at" not in existing_columns:
        connection.execute(text("ALTER TABLE projects ADD COLUMN completed_at DATETIME"))
        connection.commit()


def _add_user_auth_version_column(connection):
    """新增 JWT 失效版本；既有使用者從 0 開始。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "auth_version" not in existing_columns:
        connection.execute(text("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0"))
        connection.commit()


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
                auth_version INTEGER NOT NULL DEFAULT 0,
                ui_font_scale REAL NOT NULL DEFAULT 1.0,
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
            text("""
                INSERT INTO users (username, display_name, hashed_password, role, ui_font_scale)
                VALUES ('admin', '系統管理員', :hashed, 'admin', 1.0)
            """),
            {"hashed": hashed}
        )
        connection.commit()
        print("=" * 60)
        print(f"[migrations] 初始 admin 帳號已建立")
        print(f"  帳號：admin")
        print(f"  密碼：{initial_password}")
        print(f"  請立即登入後至使用者管理修改密碼！")
        print("=" * 60)


def _add_user_preferences_columns(connection):
    """為使用者表補上個人 UI 偏好欄位。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "ui_font_scale" not in existing_columns:
        connection.execute(
            text("ALTER TABLE users ADD COLUMN ui_font_scale REAL NOT NULL DEFAULT 1.0")
        )
        connection.commit()


def _add_teacher_supervisors_table(connection):
    """建立老師與主管的多對多關聯表。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "teacher_supervisors" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE teacher_supervisors (
                teacher_id INTEGER NOT NULL REFERENCES users(id),
                supervisor_id INTEGER NOT NULL REFERENCES users(id),
                PRIMARY KEY (teacher_id, supervisor_id)
            )
        """))
        connection.commit()


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


def _add_foreign_key_indexes(connection):
    """為外鍵欄位補建 INDEX，加速依所有者/專案/作者篩選的查詢。"""
    existing_indexes = {
        row[1]
        for row in connection.execute(text("SELECT type, name FROM sqlite_master WHERE type='index'"))
    }
    indexes_to_create = [
        ("idx_projects_owner_id",         "CREATE INDEX idx_projects_owner_id ON projects(owner_id)"),
        ("idx_students_project_id",        "CREATE INDEX idx_students_project_id ON students(project_id)"),
        ("idx_project_comments_project_id","CREATE INDEX idx_project_comments_project_id ON project_comments(project_id)"),
        ("idx_project_comments_author_id", "CREATE INDEX idx_project_comments_author_id ON project_comments(author_id)"),
        ("idx_template_pages_template_id", "CREATE INDEX idx_template_pages_template_id ON template_pages(template_id)"),
        ("idx_teacher_supervisors_supervisor_id", "CREATE INDEX idx_teacher_supervisors_supervisor_id ON teacher_supervisors(supervisor_id)"),
    ]
    for index_name, create_sql in indexes_to_create:
        if index_name not in existing_indexes:
            connection.execute(text(create_sql))
    connection.commit()


def _add_template_page_unique_constraint(connection):
    """為 template_pages(template_id, page_number) 補建複合 UNIQUE INDEX，防止同模板重複頁碼。"""
    existing_indexes = {
        row[1]
        for row in connection.execute(text("SELECT type, name FROM sqlite_master WHERE type='index'"))
    }
    if "idx_template_pages_unique_page" not in existing_indexes:
        connection.execute(text(
            "CREATE UNIQUE INDEX idx_template_pages_unique_page ON template_pages(template_id, page_number)"
        ))
        connection.commit()


def _add_timestamp_columns(connection):
    """為 projects、students 補 updated_at；為 students 補 created_at。"""
    tables_columns = {
        "projects":  ["updated_at"],
        "students":  ["created_at", "updated_at"],
    }
    for table, columns in tables_columns.items():
        existing = {
            row[1]
            for row in connection.execute(text(f"PRAGMA table_info({table})"))
        }
        for col in columns:
            if col not in existing:
                # SQLite 不允許 ADD COLUMN 使用非常數預設值（如 CURRENT_TIMESTAMP）
                # 改為先加 NULL 欄位，再回填現有資料列
                connection.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN {col} DATETIME"
                ))
                connection.execute(text(
                    f"UPDATE {table} SET {col} = CURRENT_TIMESTAMP WHERE {col} IS NULL"
                ))
    connection.commit()


def _add_project_archive_columns(connection):
    """為 projects 補上 30 天封存/復原用欄位。"""
    existing = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    for col in ("deleted_at", "archive_expires_at"):
        if col not in existing:
            connection.execute(text(
                f"ALTER TABLE projects ADD COLUMN {col} DATETIME"
            ))
    connection.commit()


def _drop_bubble_texts_json_column(connection):
    """
    移除 projects.bubble_texts_json 舊欄位（已由 label_texts_json 取代）。

    SQLite 不支援 ALTER TABLE DROP COLUMN（舊版），改用重建資料表方式：
    建立不含舊欄位的新表 → 複製資料 → 刪除舊表 → 重新命名。
    冪等：若欄位已不存在則跳過。
    """
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "bubble_texts_json" not in existing_columns:
        return

    # 關閉外鍵約束，避免 DROP TABLE projects 被子資料表（students / project_comments）阻擋
    connection.execute(text("PRAGMA foreign_keys = OFF"))
    connection.execute(text("DROP TABLE IF EXISTS projects_new"))
    connection.execute(text("""
        CREATE TABLE projects_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        VARCHAR NOT NULL,
            template_id INTEGER NOT NULL REFERENCES templates(id),
            owner_id    INTEGER REFERENCES users(id),
            created_at  DATETIME,
            updated_at  DATETIME,
            deleted_at  DATETIME,
            archive_expires_at DATETIME,
            label_texts_json TEXT NOT NULL DEFAULT '{}'
        )
    """))
    connection.execute(text("""
        INSERT INTO projects_new (
            id, name, template_id, owner_id, created_at, updated_at,
            deleted_at, archive_expires_at, label_texts_json
        )
        SELECT
            id, name, template_id, owner_id, created_at, updated_at,
            deleted_at, archive_expires_at, label_texts_json
        FROM projects
    """))
    connection.execute(text("DROP TABLE projects"))
    connection.execute(text("ALTER TABLE projects_new RENAME TO projects"))
    # 重建資料表後補回 index（DROP TABLE 時一併刪除）
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id)"
    ))
    connection.execute(text("PRAGMA foreign_keys = ON"))
    connection.commit()


def _add_template_periods_and_scope_columns(connection):
    """新增模板期別資料表，並將歷史模板/專案歸到 202605 預設期別。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "template_periods" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE template_periods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                department VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                status VARCHAR NOT NULL DEFAULT 'draft',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.commit()

    for department in TEMPLATE_DEPARTMENTS:
        existing_period = connection.execute(
            text("""
                SELECT id FROM template_periods
                WHERE department = :department AND name = :name
                LIMIT 1
            """),
            {"department": department["code"], "name": DEFAULT_TEMPLATE_PERIOD_NAME},
        ).fetchone()
        if not existing_period:
            connection.execute(
                text("""
                    INSERT INTO template_periods (department, name, status)
                    VALUES (:department, :name, 'active')
                """),
                {"department": department["code"], "name": DEFAULT_TEMPLATE_PERIOD_NAME},
            )
    connection.commit()

    default_period_id = connection.execute(
        text("""
            SELECT id FROM template_periods
            WHERE department = :department AND name = :name
            ORDER BY id
            LIMIT 1
        """),
        {
            "department": DEFAULT_TEMPLATE_PERIOD_DEPARTMENT,
            "name": DEFAULT_TEMPLATE_PERIOD_NAME,
        },
    ).scalar()

    template_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(templates)"))
    }
    if "period_id" not in template_columns:
        connection.execute(text(
            "ALTER TABLE templates ADD COLUMN period_id INTEGER REFERENCES template_periods(id)"
        ))
        connection.commit()
    if default_period_id is not None:
        connection.execute(
            text("UPDATE templates SET period_id = :period_id WHERE period_id IS NULL"),
            {"period_id": default_period_id},
        )
        connection.commit()

    project_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "department" not in project_columns:
        connection.execute(text("ALTER TABLE projects ADD COLUMN department VARCHAR"))
    if "template_period_id" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN template_period_id INTEGER REFERENCES template_periods(id)"
        ))
    connection.commit()

    connection.execute(text("""
        UPDATE projects
        SET template_period_id = (
            SELECT templates.period_id
            FROM templates
            WHERE templates.id = projects.template_id
        )
        WHERE template_period_id IS NULL
    """))
    connection.execute(text("""
        UPDATE projects
        SET department = (
            SELECT template_periods.department
            FROM template_periods
            WHERE template_periods.id = projects.template_period_id
        )
        WHERE (department IS NULL OR department = '')
          AND template_period_id IS NOT NULL
    """))
    if default_period_id is not None:
        connection.execute(
            text("UPDATE projects SET template_period_id = :period_id WHERE template_period_id IS NULL"),
            {"period_id": default_period_id},
        )
    connection.execute(
        text("""
            UPDATE projects
            SET department = :department
            WHERE department IS NULL OR department = ''
        """),
        {"department": DEFAULT_TEMPLATE_PERIOD_DEPARTMENT},
    )

    indexes = [
        (
            "idx_template_periods_department_status",
            "CREATE INDEX idx_template_periods_department_status ON template_periods(department, status)",
        ),
        ("idx_templates_period_id", "CREATE INDEX idx_templates_period_id ON templates(period_id)"),
        ("idx_projects_department", "CREATE INDEX idx_projects_department ON projects(department)"),
        (
            "idx_projects_template_period_id",
            "CREATE INDEX idx_projects_template_period_id ON projects(template_period_id)",
        ),
    ]
    existing_indexes = {
        row[1]
        for row in connection.execute(text("SELECT type, name FROM sqlite_master WHERE type='index'"))
    }
    for index_name, create_sql in indexes:
        if index_name not in existing_indexes:
            connection.execute(text(create_sql))
    connection.commit()


def _add_template_page_layout_migration_backups_table(connection):
    """保存 layout_json data migration 前的頁面資料，方便必要時回復。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "template_page_layout_migration_backups" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE template_page_layout_migration_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                migration_name VARCHAR NOT NULL,
                template_page_id INTEGER NOT NULL,
                layout_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(migration_name, template_page_id)
            )
        """))
        connection.commit()


def _migrate_photo_slots_to_content_box(connection):
    """
    將模板照片格 x/y/width/height 從「外框框」語意遷移成「實際照片內容框」語意。

    冪等保護：
    - layout_json.photo_slot_dimension_mode == content-box-v1 時跳過。
    - 更新前會保存舊 layout_json 到 backup table。
    - 若某頁照片格資料異常，跳過該頁並保留舊格式；新版程式仍可讀舊格式。
    """
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "template_pages" not in existing_tables:
        return

    rows = list(connection.execute(text(
        "SELECT id, layout_json FROM template_pages ORDER BY id"
    )))
    updated_pages = 0
    updated_slots = 0
    skipped_invalid_pages = 0

    for page_id, layout_json in rows:
        try:
            layout = json.loads(layout_json or "{}")
        except (TypeError, json.JSONDecodeError) as exc:
            print(f"[migrations] skip template_page {page_id}: invalid layout_json ({exc})")
            skipped_invalid_pages += 1
            continue

        if layout.get(PHOTO_SLOT_DIMENSION_MODE_KEY) == PHOTO_SLOT_CONTENT_BOX_MODE:
            continue

        next_layout = json.loads(json.dumps(layout))
        slots = next_layout.get("photo_slots") or []
        page_valid = True
        page_updated_slots = 0

        for slot in slots:
            has_border = slot.get("border", True) is not False
            try:
                border_width = max(0.0, float(slot.get("border_width", 8))) if has_border else 0.0
                x = float(slot.get("x", 0))
                y = float(slot.get("y", 0))
                width = float(slot.get("width", 0))
                height = float(slot.get("height", 0))
            except (TypeError, ValueError) as exc:
                print(f"[migrations] skip template_page {page_id}: non-numeric photo slot {slot.get('id')} ({exc})")
                page_valid = False
                break

            next_width = width - border_width * 2
            next_height = height - border_width * 4
            if next_width <= 0 or next_height <= 0:
                print(
                    f"[migrations] skip template_page {page_id}: photo slot {slot.get('id')} "
                    f"would become non-positive ({next_width}x{next_height})"
                )
                page_valid = False
                break

            slot["x"] = int(round(x + border_width))
            slot["y"] = int(round(y + border_width))
            slot["width"] = int(round(next_width))
            slot["height"] = int(round(next_height))
            page_updated_slots += 1

        if not page_valid:
            skipped_invalid_pages += 1
            continue

        next_layout[PHOTO_SLOT_DIMENSION_MODE_KEY] = PHOTO_SLOT_CONTENT_BOX_MODE
        connection.execute(
            text("""
                INSERT OR IGNORE INTO template_page_layout_migration_backups
                    (migration_name, template_page_id, layout_json)
                VALUES (:migration_name, :template_page_id, :layout_json)
            """),
            {
                "migration_name": PHOTO_SLOT_MIGRATION_NAME,
                "template_page_id": page_id,
                "layout_json": layout_json or "{}",
            },
        )
        connection.execute(
            text("UPDATE template_pages SET layout_json = :layout_json WHERE id = :page_id"),
            {"layout_json": json.dumps(next_layout, ensure_ascii=False), "page_id": page_id},
        )
        updated_pages += 1
        updated_slots += page_updated_slots

    if updated_pages or skipped_invalid_pages:
        print(
            f"[migrations] photo slot content-box migration: "
            f"updated_pages={updated_pages}, updated_slots={updated_slots}, "
            f"skipped_invalid_pages={skipped_invalid_pages}"
        )
    connection.commit()


def _remove_empty_text_bubbles_from_template_pages(connection):
    """移除已下架氣泡框留下的空 layout key；非空資料保留並要求人工處理。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "template_pages" not in existing_tables:
        return

    rows = list(connection.execute(text(
        "SELECT id, layout_json FROM template_pages ORDER BY id"
    )))
    updated_pages = 0
    skipped_nonempty_pages = 0

    for page_id, layout_json in rows:
        try:
            layout = json.loads(layout_json or "{}")
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(layout, dict) or "text_bubbles" not in layout:
            continue
        if layout.get("text_bubbles") != []:
            skipped_nonempty_pages += 1
            continue

        next_layout = dict(layout)
        next_layout.pop("text_bubbles", None)
        connection.execute(
            text("""
                INSERT OR IGNORE INTO template_page_layout_migration_backups
                    (migration_name, template_page_id, layout_json)
                VALUES (:migration_name, :template_page_id, :layout_json)
            """),
            {
                "migration_name": REMOVE_EMPTY_TEXT_BUBBLES_MIGRATION_NAME,
                "template_page_id": page_id,
                "layout_json": layout_json or "{}",
            },
        )
        connection.execute(
            text("UPDATE template_pages SET layout_json = :layout_json WHERE id = :page_id"),
            {"layout_json": json.dumps(next_layout, ensure_ascii=False), "page_id": page_id},
        )
        updated_pages += 1

    if updated_pages or skipped_nonempty_pages:
        print(
            "[migrations] remove empty text_bubbles: "
            f"updated_pages={updated_pages}, skipped_nonempty_pages={skipped_nonempty_pages}"
        )
    connection.commit()


def _migrate_single_supervisors_to_many(connection):
    """將 users.supervisor_id 既有資料同步到 teacher_supervisors 關聯表。"""
    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "teacher_supervisors" not in existing_tables:
        return

    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "supervisor_id" not in existing_columns:
        return

    connection.execute(text("""
        INSERT OR IGNORE INTO teacher_supervisors (teacher_id, supervisor_id)
        SELECT teacher.id, teacher.supervisor_id
        FROM users AS teacher
        JOIN users AS supervisor ON supervisor.id = teacher.supervisor_id
        WHERE teacher.role = 'teacher'
          AND supervisor.role = 'supervisor'
          AND teacher.supervisor_id IS NOT NULL
    """))
    connection.commit()


def _add_roster_children_and_backfill(connection):
    """建立孩子名冊表、為 students 加名冊連結欄位，並依正規化姓名回填既有學生。

    回填規則與 roster_service 相同：姓名去除空白後同名視為同一個孩子。
    冪等：students.roster_child_id 已存在則整段跳過（避免覆蓋 admin 事後的手動拆分）。
    """
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(students)"))
    }
    if "roster_child_id" in existing_columns:
        return

    existing_tables = {
        row[0]
        for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
    }
    if "roster_children" not in existing_tables:
        connection.execute(text("""
            CREATE TABLE roster_children (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_roster_children_name ON roster_children (name)"
        ))
    connection.execute(text(
        "ALTER TABLE students ADD COLUMN roster_child_id INTEGER REFERENCES roster_children(id)"
    ))
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_students_roster_child_id ON students (roster_child_id)"
    ))

    # 回填：同正規化姓名的學生連到同一個名冊項
    from services.roster_service import normalize_child_name

    all_students = connection.execute(text("SELECT id, name FROM students")).fetchall()
    child_id_by_name: dict[str, int] = {}
    for student_id, student_name in all_students:
        normalized_name = normalize_child_name(student_name)
        if not normalized_name:
            continue
        if normalized_name not in child_id_by_name:
            connection.execute(
                text("INSERT INTO roster_children (name) VALUES (:name)"),
                {"name": normalized_name},
            )
            new_child_id = connection.execute(text("SELECT last_insert_rowid()")).scalar()
            child_id_by_name[normalized_name] = new_child_id
        connection.execute(
            text("UPDATE students SET roster_child_id = :child_id WHERE id = :student_id"),
            {"child_id": child_id_by_name[normalized_name], "student_id": student_id},
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
